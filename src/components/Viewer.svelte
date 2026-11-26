<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { invoke } from '$lib/ipc';
	import { listen } from '$lib/events';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import { isExternal } from '$lib/uri';
	import { sha256 } from '$lib/annotation';
	import { mountMermaid } from '$lib/mermaid-mounter';
	import { planSelectionCopy } from '$lib/copy-selection';
	import { canEnterEdit } from '$lib/document-edit';
	import { detectFileType } from '$lib/file-type';
	import { openFileFailedMessage } from '$lib/open-document';
	import { openInNewWindowFailedMessage } from '$lib/open-in-new-window';
	import { DEFAULT_ZOOM } from '$lib/zoom';
	import { holdScrollForPrint } from '$lib/print-scroll';
	import { attachAlertVisibility, revealAlertsAround } from '$lib/alert-dom';
	import {
		applyHighlights,
		clearHighlights,
		detectHighlightApi,
		findMatches,
		formatCount,
		MENU_FIND_EVENT,
		rangeAtMatch,
		scrollRangeIntoContainer,
		stepIndex,
		type MatchRange,
	} from '$lib/find-in-document';
	import { FIND_SURFACE_BASE_CSS, rewriteSurfaceCss, surfaceBaseCss } from '$lib/find-surface-style';
	import { MENU_FIND_REPLACE_EVENT } from '../editor/cm-replace';
	import FindBar from './FindBar.svelte';
	import EditorDiffView from './EditorDiffView.svelte';
	import FormatToolbar from './FormatToolbar.svelte';
	import Icon from './Icon.svelte';
	import {
		announceFormatToolbar,
		MENU_SHOW_FORMAT_TOOLBAR_EVENT,
		readFormatToolbarShown,
		watchFocusForFormatToolbar,
		writeFormatToolbarShown,
	} from '../editor/format-toolbar';
	import CodeEditor from './CodeEditor.svelte';
	import MarkdownEditor from './MarkdownEditor.svelte';
	import { markdownTooLarge } from '../editor/markdown-limits';
	import { CONFLICT_MESSAGE, saveFileEditor, type MarkdownEditorHandle } from '../editor/file-editor';
	import { MENU_RAW_SOURCE_EVENT, watchFocusForRawSource } from '../editor/raw-sync';
	import { buildEditSurface } from '../html/edit';
	import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
	import type { SourceIndex } from '../markdown/types';
	import { buildAnchor, type BuiltAnchor } from '../markdown/selection';
	let {
		document,
		html,
		index,
		onRequestAddMark,
		onToggleMarks,
		marksOpen,
		zoom = DEFAULT_ZOOM,
		findRequest = 0,
		findInitialQuery = '',
		findInitialIndex = 0,
		onFindOpenChange,
		goToOpen = false,
		aiTools = true,
		codeTheme = 'github-light',
	}: {
		document: DocumentPayload;
		html: string;
		index: SourceIndex | null;
		onRequestAddMark: (anchor: BuiltAnchor) => void;
		onToggleMarks: () => void;
		marksOpen: boolean;
		/**
		 * 本文の表示倍率(パーセント・要件#36)。非対象の表示(バイナリの
		 * プレースホルダ)には既定=等倍が渡る。
		 */
		zoom?: number;
		/**
		 * 要件#54 契約①: 外から届いた ⌘F の回数。
		 *
		 * 普段の ⌘F はこのコンポーネントが自分で `menu_find` を購読して受ける。
		 * html の**閲覧中**だけは Viewer がまだ画面に居ない(+page.svelte が
		 * `HtmlViewer` の iframe を出している)ので、⌘F を受けた +page が複製面へ
		 * 切り替えてから、この数を1つ進めて「今の ⌘F」を伝える。
		 */
		findRequest?: number;
		/**
		 * 要件#55 契約⑦: `findRequest` が進んだときに検索バーへ入れる語。
		 *
		 * フォルダ横断検索の結果から文書を開いたとき、+page.svelte が同じ語を
		 * ここへ置いてから `findRequest` を進める。空なら従来どおり(語は触らない)。
		 */
		findInitialQuery?: string;
		/**
		 * 要件#55 追補b: `findInitialQuery` つきで `findRequest` が進んだとき、
		 * 現在にする一致の番目(0 始まり・省略時 0=先頭)。一致数を超えたら最後の一致。
		 * フォルダ横断検索の結果でクリックした一致へ跳ぶのに使う。
		 */
		findInitialIndex?: number;
		/** 検索バーの開閉を +page.svelte へ返す(閉じたら html は iframe へ戻る)。 */
		onFindOpenChange?: (open: boolean) => void;
		/**
		 * 要件#60 契約⑦: Go to バーが開いているか(バーは +page.svelte の持ち場)。
		 *
		 * 検索バーと同じ理由で、開いている間の Esc は**バーが先に食う**。あちらは
		 * `document` の capture 段で `stopImmediatePropagation` するので普通は
		 * ここまで届かないが、登録順に依らず結論を同じにするため、下の Esc
		 * ハンドラも `findOpen` と同じようにこれを見て譲る(両側から挟む)。
		 */
		goToOpen?: boolean;
		/**
		 * 要件#84 契約5: ツールバーの Add Instruction と Marks(今の AI 連携)を出すか。
		 * 配布版では +page.svelte が偽を渡す。既定は出る側(契約10)。
		 */
		aiTools?: boolean;
		/** 要件#74 契約5: 面の配色= Shiki の同梱テーマの名前(+page.svelte が今のモードのテーマを渡す)。 */
		codeTheme?: string;
	} = $props();

	/** 要件#74: コードのファイルと plain text を CodeMirror の面で出しているか。 */
	let faceActive = $derived(detectFileType(document.uri) === 'text');

	/** 要件#74 第2段: Markdown か(面か、読み取り専用の描画か)。 */
	let markdownFile = $derived(detectFileType(document.uri) === 'markdown');
	/**
	 * 閾値の判定の記憶(uri と、その uri を開いたときの content が閾値を超えていたか)。反応しない変数にして、
	 * 同じ uri の間は保存(markSaved)や外部変更の取り込みで content が閾値をまたいでも判定を変えない
	 * (変えると下の `{#key}` で編集中の面が作り直される=要件#74 /code-review A)。uri が変われば判定し直す。
	 */
	let tooBigMemo: { uri: string; big: boolean } | null = null;
	/** 閾値を超えた Markdown(今の描画で開き、知らせを出す=契約18・判断 8)。判定は uri ごとに 1 回。 */
	let markdownTooBig = $derived.by(() => {
		const uri = document.uri;
		if (tooBigMemo?.uri !== uri) tooBigMemo = { uri, big: untrack(() => markdownTooLarge(document.content)) };
		return markdownFile && canEnterEdit('markdown', uri) && tooBigMemo.big;
	});
	/** Markdown の編集面(ProseMirror)を出しているか。SSH root と閾値超えは今の描画(契約3・4・18)。 */
	let mdFaceActive = $derived(markdownFile && canEnterEdit('markdown', document.uri) && !markdownTooBig);
	/** 閾値を超えた Markdown を Raw Source で raw だけの面にしているか(項目 21)。文書が変われば下ろす(判断 10)。 */
	let bigRaw = $state(false);
	$effect(() => {
		void document.uri;
		bigRaw = false;
	});
	/** 閾値超えの今の描画の窓は、View ▸ Raw Source で raw に入れる(面が出ている間は面が自分で受ける)。 */
	$effect(() => {
		if (!markdownTooBig || bigRaw) return;
		let off: (() => void) | null = null;
		let disposed = false;
		void listen(MENU_RAW_SOURCE_EVENT, () => {
			bigRaw = true;
		})
			.then((unlisten) => {
				if (disposed) unlisten();
				else off = unlisten;
			})
			.catch(() => {});
		return () => {
			disposed = true;
			off?.();
		};
	});
	/** Markdown の面(rendered か raw)を出しているか。 */
	let mdSurface = $derived(mdFaceActive || (markdownTooBig && bigRaw));
	/** Markdown の面が raw を出しているか(raw の間は `.markdown-body` に zoom を掛けない=項目 16)。 */
	let mdRaw = $derived(mdSurface && (windowState.fileEditor as MarkdownEditorHandle | null)?.raw === true);
	/** どちらかの新しい面(札・帯の出し分け)。 */
	let anyFace = $derived(faceActive || mdSurface);
	/** CodeMirror の面(コード・plain text・raw)の検索=面が文書全体を数える(契約17)。 */
	let cmFind = $derived(faceActive || mdRaw);

	// 要件#74 項目 1 (a)(b): Markdown を読み取り専用の描画(SSH・閾値超え)で出している間の印。
	$effect(() => {
		windowState.editBlocked = markdownFile && !mdFaceActive;
		return () => {
			windowState.editBlocked = false;
		};
	});

	/** Markdown の面が変換中か(検索の張り替えを待つ=契約10)。 */
	let mdComposing = $state(false);
	/** Markdown の面で今の件数を数えた語(変換中は前の語のまま=件数を張り替えない)。 */
	let mdAppliedQuery = $state('');
	let mdRefreshTimer: ReturnType<typeof setTimeout> | undefined;

	/** Markdown の面の文書が変わった: 間をおいて検索を張り直す(項目 15)。 */
	function handleMdDocChange() {
		if (mdRefreshTimer) clearTimeout(mdRefreshTimer);
		mdRefreshTimer = setTimeout(() => {
			mdRefreshTimer = undefined;
			findRefresh += 1;
		}, 100);
	}

	/** 要件#74: 面が数えた一致(語と、CodeMirror の文書の位置の一致)。 */
	let faceFind = $state<{ query: string; ranges: MatchRange[] }>({ query: '', ranges: [] });

	function handleFaceFindResults(result: { query: string; ranges: MatchRange[]; current?: number }) {
		const changed = result.query !== faceFind.query;
		faceFind = { query: result.query, ranges: result.ranges };
		findRanges = result.ranges;
		// 第3段 3-3: 置換の後は面が現在を選ぶ(替えた文字の終わり以降の最初の一致)
		if (result.current !== undefined) findCurrent = result.current;
		else findCurrent = changed ? 0 : Math.min(findCurrent, Math.max(0, result.ranges.length - 1));
	}

	// --- 書式のツールバー(要件#74 第4段 4-2・4-5・4-6) -----------------------

	/** 出すか(アプリ全体で 1 つ=localStorage。既定=隠す)。 */
	let formatToolbarShown = $state(readFormatToolbarShown(typeof localStorage === 'undefined' ? null : localStorage));
	/** ツールバーを出せる面か(Markdown の編集面=rendered・書ける)。 */
	let formatToolbarAvailable = $derived(
		mdFaceActive && !mdRaw && windowState.fileEditor?.kind === 'markdown' && !windowState.fileEditor.readOnly,
	);
	/** いま出している面の handle(出せないときは null)。 */
	let formatToolbarHandle = $derived(
		formatToolbarAvailable && formatToolbarShown ? (windowState.fileEditor as MarkdownEditorHandle) : null,
	);

	function toggleFormatToolbar() {
		if (!formatToolbarAvailable) return;
		formatToolbarShown = !formatToolbarShown;
		writeFormatToolbarShown(formatToolbarShown);
	}

	// View ▸ Show Formatting Toolbar のチェック印=この窓で見えているか(mount・面の切り替え・出し入れで知らせる)
	$effect(() => {
		const visible = formatToolbarAvailable && formatToolbarShown;
		untrack(() => void announceFormatToolbar(visible));
	});

	// 窓が前面に戻るたびに、この窓の値を知らせ直す(チェック印は前面の窓の報告でしか動かない=要件#74 /code-review C)。
	// Markdown の面が無い窓(コード・テキスト・画像など)では誰も Raw Source を知らせないので、Viewer が両方を送る。
	// raw は面(MarkdownEditor の watchFocusForRawSource)と同じ値=`mdRaw`(面が無ければ false)。
	onMount(() => {
		const offs: Array<() => void> = [];
		let disposed = false;
		const keep = (off: () => void) => {
			if (disposed) off();
			else offs.push(off);
		};
		void watchFocusForFormatToolbar(() => formatToolbarAvailable && formatToolbarShown).then(keep);
		void watchFocusForRawSource(() => mdRaw).then(keep);
		return () => {
			disposed = true;
			for (const off of offs.splice(0)) off();
		};
	});

	// View ▸ Show Formatting Toolbar(出せない面では何もしない)
	onMount(() => {
		let off: (() => void) | null = null;
		let disposed = false;
		void listen(MENU_SHOW_FORMAT_TOOLBAR_EVENT, () => toggleFormatToolbar())
			.then((unlisten) => {
				if (disposed) unlisten();
				else off = unlisten;
			})
			.catch(() => {});
		return () => {
			disposed = true;
			off?.();
		};
	});

	// --- 差分表示(要件#74 第4段 4-1・4-1〜4-4) ------------------------------

	/** 開いている差分(衝突=今 ↔ 届いた内容 / 未保存=基準の版 ↔ 今)。読むだけ。 */
	let diffView = $state<{ kind: 'conflict' | 'unsaved'; left: string; right: string } | null>(null);

	/** 重なりの帯の Show Differences: 今の文字列 ↔ 届いた内容(保存の照合の衝突ならディスクを読み直した内容)。 */
	async function showConflictDiff() {
		const face = windowState.fileEditor;
		if (!face) return;
		const theirs = await face.conflictText?.();
		if (theirs === null || theirs === undefined || windowState.fileEditor !== face) return;
		mergeView = null;
		diffView = { kind: 'conflict', left: face.text(), right: theirs };
	}

	/** Unsaved の札: 基準の版 ↔ 今の文字列。 */
	function showUnsavedDiff() {
		const face = windowState.fileEditor;
		if (!face?.baseText) return;
		diffView = { kind: 'unsaved', left: face.baseText(), right: face.text() };
	}

	function closeDiff() {
		diffView = null;
	}

	// 開いている間に文字列(か基準の版)が変わったら作り直す(handle.version)。衝突が解けた・未保存が無くなったら閉じる。
	$effect(() => {
		const face = windowState.fileEditor;
		const dirtyNow = face?.dirty;
		const conflictNow = face?.conflict;
		void face?.version;
		untrack(() => {
			const open = diffView;
			if (!open) return;
			if (!face || (open.kind === 'conflict' && !conflictNow) || (open.kind === 'unsaved' && !dirtyNow)) {
				diffView = null;
				return;
			}
			if (open.kind === 'unsaved' && face.baseText) {
				const left = face.baseText();
				const right = face.text();
				if (left !== open.left || right !== open.right) diffView = { kind: 'unsaved', left, right };
			}
		});
	});

	// 別の文書へ移ったら閉じる
	$effect(() => {
		void document.uri;
		untrack(() => {
			diffView = null;
			mergeView = null;
		});
	});

	// --- 重なりを選んでマージ(要件#89 契約8〜13) -----------------------------

	/**
	 * 開いているマージの画面(基準の版・今の文字列・届いた内容=ディスクの版・作り直しの印)。重なりの帯の Merge… と、
	 * 衝突の差分の画面の Merge… から開く。
	 */
	let mergeView = $state<{ base: string; mine: string; theirs: string; rebuilt: boolean } | null>(null);
	/** 届いた内容の取り直しの番号(後から届いた結果だけを当てる)。 */
	let mergeFetch = 0;

	/** Merge…: 届いた内容(保存の照合の衝突ならディスクを読み直した内容=契約13)で塊を作る。差分の画面は閉じる。 */
	async function openMerge() {
		diffView = null;
		const face = windowState.fileEditor;
		if (!face?.applyMerge || !face.conflict) return;
		const seq = ++mergeFetch;
		const theirs = await face.conflictText?.();
		if (theirs === null || theirs === undefined || seq !== mergeFetch) return;
		if (windowState.fileEditor !== face || !face.conflict) return;
		mergeView = { base: face.baseText?.() ?? '', mine: face.text(), theirs, rebuilt: false };
	}

	function closeMerge() {
		mergeFetch++;
		mergeView = null;
	}

	/** Apply(契約11): マージした文字列を面に入れ、基準の版をマージに使ったディスクの版にする(帯は下りる・Unsaved のまま)。 */
	function applyMerge(merged: string) {
		const open = mergeView;
		const face = windowState.fileEditor;
		closeMerge();
		if (!open || !face) return;
		face.applyMerge?.(merged, open.theirs);
	}

	// 開いている間(契約12): 重なりが解けた・面が替わったら閉じる。今の文字列か基準の版が変わったら塊を作り直し、
	// それ以外で面が進んだ(外部変更がまた届いた)ら届いた内容を取り直し、変わっていれば作り直して知らせる。
	$effect(() => {
		const face = windowState.fileEditor;
		const conflictNow = face?.conflict;
		void face?.version;
		untrack(() => {
			const open = mergeView;
			if (!open) return;
			if (!face || !conflictNow || !face.applyMerge) {
				closeMerge();
				return;
			}
			const mine = face.text();
			const base = face.baseText?.() ?? open.base;
			if (mine !== open.mine || base !== open.base) {
				mergeView = { ...open, mine, base };
				return;
			}
			const seq = ++mergeFetch;
			void face.conflictText?.().then((theirs) => {
				const now = mergeView;
				if (seq !== mergeFetch || !now || windowState.fileEditor !== face) return;
				if (theirs === null || theirs === undefined || theirs === now.theirs) return;
				mergeView = { ...now, theirs, rebuilt: true };
			});
		});
	});

	// --- 置換(要件#74 第3段 3-3・3-11・3-12) ---------------------------------

	/** Find and Replace… で置換の行を出しているか(窓ごと=文書を替えても保つ。バーを閉じたら下ろす)。 */
	let replaceOpen = $state(false);
	/** 置換の語。 */
	let replaceQuery = $state('');
	/** 置換の入力欄(Find and Replace… でフォーカスを置く)。 */
	let replaceInputEl: HTMLInputElement | undefined = $state();
	/** 置換を出せる面か(コード・plain text・raw で、読み取り専用でない=handle が replaceCurrent を持つ)。 */
	let canReplace = $derived(cmFind && typeof windowState.fileEditor?.replaceCurrent === 'function');

	function handleReplace() {
		if (!canReplace) return;
		windowState.fileEditor?.replaceCurrent?.(replaceQuery);
	}

	function handleReplaceAll() {
		if (!canReplace) return;
		windowState.fileEditor?.replaceAll?.(replaceQuery);
	}

	let copyLabel = $state('Copy Markdown');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let bodyEl: HTMLDivElement | undefined = $state();

	/**
	 * 閲覧面そのもの(`overflow-y: auto` のスクロール容器)。現在の一致を運ぶときに
	 * 動かすのはこの要素の `scrollTop` だけ(要件#54 追補c(2))。
	 */
	let viewerEl: HTMLElement | undefined = $state();

	/**
	 * 要件#74 第2段 2-7: 別の文書(uri が変わった)を開いたら、スクロール容器を先頭に戻す。面は `{#key document.uri}` で
	 * 作り直すが `article.viewer` は同じ要素なので、前の文書の scrollTop が持ち越される(v0.6.0 は描画を待つ間に本文が空になって
	 * 0 に畳まれていた)。同じ uri(Reload File・外部変更の取り込み・中身だけの描き直し)では触らない。動かすのはこの要素の
	 * scrollTop だけ。DOM を入れ替える前(`$effect.pre`)に戻すので、新しい面は先頭から作られる。
	 */
	let scrolledUri: string | null = null;
	$effect.pre(() => {
		const uri = document.uri;
		untrack(() => {
			if (scrolledUri !== null && scrolledUri !== uri && viewerEl) viewerEl.scrollTop = 0;
			scrolledUri = uri;
		});
	});

	/** ツールバー(sticky・top:0)。検索バーを積む高さを測るために握る。 */
	let toolbarEl: HTMLElement | undefined = $state();

	/**
	 * ツールバーの高さ。検索バー(sticky)をその直下に積むために CSS へ渡す
	 * (要件#54 追補c(1))。ツールバーが無い・まだ測れないときは 0 = 上端。
	 */
	let toolbarHeight = $state(0);

	/**
	 * Issue #848: 開いている検索バーの実寸(閉じていれば 0)。帯・知らせ(sticky)を検索バーの下に積むために測る。
	 */
	let findBarHeight = $state(0);

	/**
	 * FindBar.svelte の `.find-bar--sticky` の `top: calc(var(--vellis-find-bar-top) + 8px)` の 8px
	 * (札の上の間)。検索バーが貼り付いたときの上端=ツールバーの直下 + この値。
	 */
	const FIND_BAR_STICKY_GAP = 8;

	/** 要件#53: html 種別か(閲覧は HtmlViewer の iframe・検索は複製面)。HTML の編集は要件79 まで無い。 */
	let htmlDocument = $derived(detectFileType(document.uri) === 'html');

	/**
	 * 削除の帯の「保存」(要件#48 追補g・要件#74 契約13)。面の保存の経路(削除の印が立っているので照合しない)。
	 */
	async function saveRemovedFile() {
		if (windowState.fileEditor) await saveFileEditor(windowState.fileEditor);
	}

	// --- 文書内検索(要件#54) ------------------------------------------
	// 一致の計算・件数の文言・送りの循環・ハイライトの付け外しは
	// `$lib/find-in-document` の純関数。ここが持つのは「どの DOM を探すか」と
	// 「いつ探し直すか」、そして Esc の取り合いの決着だけ。

	/** 検索バーを出しているか。ウインドウ単位・揮発(localStorage へ保存しない)。 */
	let findOpen = $state(false);

	/**
	 * Issue #848: 重なりの帯・削除の帯・取り込みの知らせを貼り付ける高さ(`--vellis-banner-top`)。
	 * ツールバーの直下。検索バーが開いている間はその下端(貼り付いた上端 + 実寸)。
	 */
	let bannerTop = $derived(toolbarHeight + (findOpen ? FIND_BAR_STICKY_GAP + findBarHeight : 0));

	/**
	 * Issue #851 (2): 貼り付く帯・知らせ(DOM の順に 重なりの帯 → 取り込みの知らせ → 削除の帯)。
	 * 同時に出たら、後のものを先のものの実寸だけ下げて積む(`--vellis-banner-offset`)。
	 * 重なりの帯と削除の帯は同時に出ない(要件#48 追補h 契約1)。
	 */
	let conflictShown = $derived(
		Boolean(anyFace && windowState.fileEditor?.conflict && !windowState.externalRemoved),
	);
	let noticeShown = $derived(Boolean(anyFace && windowState.fileEditor?.notice));
	let conflictBannerEl: HTMLElement | null | undefined = $state();
	let mergedNoticeEl: HTMLElement | null | undefined = $state();
	let removedBannerEl: HTMLElement | null | undefined = $state();
	let conflictBannerHeight = $state(0);
	let mergedNoticeHeight = $state(0);
	let mergedNoticeOffset = $derived(conflictShown ? conflictBannerHeight : 0);
	let removedBannerOffset = $derived(
		(conflictShown ? conflictBannerHeight : 0) + (noticeShown ? mergedNoticeHeight : 0),
	);

	/**
	 * Issue #851 (4): `targets` の大きさが変わったら `measure` を呼ぶ。ResizeObserver があればそれで
	 * (ペインの幅の変化でツールバーが折り返す、など)、無い環境(テストの JSDOM)でも窓の resize で測り直す。
	 * 戻り値は後始末(listener を外し、observe をやめる)。
	 */
	function watchSize(
		targets: ReadonlyArray<Element | null | undefined>,
		measure: () => void,
		view: Window | null | undefined,
	): () => void {
		view?.addEventListener('resize', measure);
		const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null;
		for (const target of targets) if (target) observer?.observe(target);
		return () => {
			view?.removeEventListener('resize', measure);
			observer?.disconnect();
		};
	}

	/**
	 * Esc を一時 UI のバーへ譲るか(要件#54 契約⑤・要件#60 契約⑦)。バーは編集より
	 * 手前の一時 UI なので、開いている間の Esc は編集の破棄に使わない。検索バーは
	 * この中、Go to バーは +page.svelte の側にある(どちらも同じ扱い)。
	 */
	let escBelongsToBar = $derived(findOpen || goToOpen);

	/** 探している語。バーを閉じても残す(次の ⌘F で全選択されて出る=契約①)。 */
	let findQuery = $state('');

	/** いまの語の一致(表示テキスト上のオフセット・文書順)。 */
	let findRanges = $state<MatchRange[]>([]);

	/** 現在の一致(0始まり)。再検索のたびに先頭へ戻る(契約④)。 */
	let findCurrent = $state(0);

	/**
	 * 要件#55 追補b: 次に一致が出揃ったとき現在にする番目(null=無し)。
	 * `findRequest` の effect が置き、下の「番目合わせ」の effect が一度だけ使って消す。
	 */
	let pendingFindIndex = $state<number | null>(null);

	/**
	 * 契約⑤の「編集の確定」を再検索の契機にするための印。
	 *
	 * 確定・破棄・掴み直しでは表示テキストが変わるのに、それだけでは下の依存が
	 * どれも動かないことがある(ブロック編集の破棄など)。ハイライトを外した側から
	 * 1つ進めて、探し直しを頼む。
	 */
	let findRefresh = $state(0);

	/** 検索バーの入力欄。⌘F の再送でフォーカスと全選択を戻すために握る。 */
	let findInputEl: HTMLInputElement | undefined = $state();

	/** 要件#48/#49/#52/#53 と同じ: IME の変換中の Esc は IME に委ねる(契約⑤)。 */
	let findComposing = false;

	/** html の複製面(読み取り専用)のホスト。 */
	let findSurfaceHost: HTMLDivElement | undefined = $state();

	/** Shadow 内の複製面ルート。html 閲覧中の検索はこの木を探す(契約②)。 */
	let findSurfaceRoot: HTMLElement | null = $state(null);

	/**
	 * 契約⑥: 検索バーを出す文書か。
	 *
	 * html は複製面を自前で組み立てるので常に出せる。markdown / text は**表示
	 * テキストがある**ときだけ ―― PDF・画像・音声・動画・3D モデルの窓には
	 * レンダリング結果(`html` prop)が渡ってこないので、ここで自然に落ちる。
	 * 「⌘F を受けても何も起きない」は、この判定が偽のまま `openFind` が空振り
	 * することで満たす。
	 */
	let findSearchable = $derived.by(() => {
		if (htmlDocument) return true;
		if (faceActive || mdSurface) return true;
		const kind = detectFileType(document.uri);
		if (kind !== 'markdown' && kind !== 'text') return false;
		return html.length > 0;
	});

	/**
	 * 契約②: いま「表示されているテキスト」を持つ木。
	 *
	 * - html = 要件#53 の `buildEditSurface` で作る**読み取り専用**の複製面
	 * - それ以外 = 本文コンテナ(レンダリング済み Markdown / `<pre>` / ソース編集の
	 *   `<pre>` のいずれもここに居る)
	 */
	let findTarget = $derived.by(() => {
		if (!findOpen) return null;
		if (htmlDocument) return findSurfaceRoot;
		return bodyEl ?? null;
	});

	/** 件数表示(契約④)。 */
	let findCount = $derived(
		cmFind
			? formatCount(findCurrent, faceFind.ranges.length, faceFind.query)
			: mdFaceActive
				? formatCount(findCurrent, findRanges.length, mdAppliedQuery)
				: formatCount(findCurrent, findRanges.length, findQuery),
	);

	/**
	 * 追補c(1): 検索バーを貼り付ける高さ=ツールバーの実寸を測る。Issue #848 から、帯・知らせも
	 * ツールバーの直下に貼り付くので、検索バーが閉じていても測る。
	 *
	 * `bind:clientHeight` を使わないのは ResizeObserver を呼ぶため(テストの JSDOM
	 * には無い)。ツールバーの中身が変わる契機(編集の出入り・種別・Unsaved の札・
	 * 書式のツールバーの 2 段目)と窓の幅の変化だけ測り直せば足りる ―― 測れないときは
	 * 0 で上端に貼り付く。
	 */
	$effect(() => {
		const header = toolbarEl;
		if (!header) return;
		// ツールバーのボタンが増減する(=高さが変わりうる)契機。
		void document.uri;
		void anyFace;
		void windowState.fileEditor?.dirty;
		void formatToolbarHandle;
		const measure = () => {
			toolbarHeight = header.offsetHeight;
		};
		measure();
		// Issue #851 (4): 窓の resize に加えて、ツールバー自身の大きさの変化(折り返し)でも測り直す。
		return watchSize([header], measure, header.ownerDocument.defaultView);
	});

	/**
	 * Issue #848: 検索バーの実寸を測る(帯・知らせをその下に積む)。置換の行の出し入れで高さが変わる。
	 */
	$effect(() => {
		if (!findOpen) {
			findBarHeight = 0;
			return;
		}
		const scroller = viewerEl;
		if (!scroller) return;
		void replaceOpen;
		void canReplace;
		const bar = scroller.querySelector<HTMLElement>('.find-bar--sticky');
		const measure = () => {
			findBarHeight = scroller.querySelector<HTMLElement>('.find-bar--sticky')?.offsetHeight ?? 0;
		};
		measure();
		return watchSize([bar], measure, scroller.ownerDocument.defaultView);
	});

	/**
	 * Issue #851 (2): 先に出ている帯・知らせの実寸を測る(後のものをその下に積む)。知らせの文言が変わる・
	 * 折り返すと高さが変わる。
	 */
	$effect(() => {
		const conflictEl = conflictBannerEl;
		const noticeEl = mergedNoticeEl;
		void windowState.fileEditor?.notice;
		const measure = () => {
			conflictBannerHeight = conflictEl?.offsetHeight ?? 0;
			mergedNoticeHeight = noticeEl?.offsetHeight ?? 0;
		};
		measure();
		if (!conflictEl && !noticeEl) return;
		return watchSize([conflictEl, noticeEl], measure, (conflictEl ?? noticeEl)?.ownerDocument.defaultView);
	});

	/**
	 * 複製面の中だけに効かせる見た目。文書の CSS は Shadow に閉じているので、
	 * ハイライトの色はこちら側にも要る(`::highlight()` はツリースコープごと)。
	 * 現在の一致の文字色は閲覧面と同じく `--color-find-current-text` に固定する
	 * (要件#54 追補d・要件#56 判断 (k)。custom property は shadow root にも継承される)。
	 */
	const FIND_SURFACE_CSS = [
		':host{display:block}',
		'[data-vellis-href],[data-vellis-xlink-href]{color:-webkit-link;',
		'text-decoration:underline}',
		'mark[data-vellis-find]{background-color:var(--color-find-match);color:inherit}',
		'mark[data-vellis-find-current]{background-color:var(--color-find-current);color:var(--color-find-current-text)}',
		'mark[data-vellis-find-current] *{color:var(--color-find-current-text) !important}',
		'::highlight(vellis-find){background-color:var(--color-find-match)}',
		'::highlight(vellis-find-current){background-color:var(--color-find-current);color:var(--color-find-current-text)}',
	].join('');

	/**
	 * 閲覧中の html のための複製面を Shadow DOM へ出す(契約②⑦)。
	 *
	 * 中身は要件#53 の `buildEditSurface` そのもの ―― sandbox された iframe の中は
	 * アプリから読めない(要件#8)ので、sanitize 済みの複製を作って探す。**読み取り
	 * 専用**なので `contenteditable` は付けず、ダブルクリックの配線もしない
	 * (⌘F は編集の入口ではない)。原文が差し替わったら組み直す(契約⑤)。
	 */
	$effect(() => {
		const host = findSurfaceHost;
		const source = document.content;
		const uri = document.uri;
		if (!host) {
			findSurfaceRoot = null;
			return;
		}
		untrack(() => {
			const owner = host.ownerDocument;
			const surface = buildEditSurface(source, uri);
			const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
			shadow.replaceChildren();

			const own = owner.createElement('style');
			own.textContent = FIND_SURFACE_CSS;
			shadow.append(own);
			// 追補b: まず iframe の UA 既定を再現する(アプリ側からの継承もここで
			// 断つ)。文書側のスタイルはその後に入れて、基底を上書きできるようにする。
			const base = owner.createElement('style');
			base.textContent = FIND_SURFACE_BASE_CSS;
			shadow.append(base);
			// 文書側のスタイルも移して、閲覧と同じ見え方の上を探せるようにする。
			// Shadow の中に `<body>` は無いので、`body{…}` / `html{…}` / `:root{…}` は
			// 複製面のルートへ写してから入れる(そのままでは何にも当たらない=追補b)。
			for (const css of surface.styles) {
				const style = owner.createElement('style');
				style.textContent = rewriteSurfaceCss(css);
				shadow.append(style);
			}

			const root = owner.createElement('div');
			root.className = 'vellis-html-find-root';
			// 文書の `<html>` / `<body>` の class も足す(追補e。編集面と同じ)。
			root.classList.add(...surface.rootClasses);
			root.innerHTML = surface.html;
			shadow.append(root);
			findSurfaceRoot = root;
		});
		return () => {
			findSurfaceRoot = null;
		};
	});

	/**
	 * 再検索(契約⑤)。
	 *
	 * 契機は入力欄の変化・別の文書を開いた(`html` / `index` / `document` の
	 * 差し替え)・外部変更の取り込み(同じ経路で props が差し替わる)・編集モードの
	 * 出入りと編集の確定(対象の木も表示テキストも入れ替わる)。どれも下の依存の
	 * どれかを動かすので、契機を個別に張らずにこの1つで足りる。
	 *
	 * 再検索のたびに現在の一致は**先頭へ戻す**(契約④)。
	 */
	$effect(() => {
		const container = findTarget;
		const query = findQuery;
		// 表示テキストが変わりうるもの(DOM は追跡されないので明示的に読む)。
		void html;
		void index;
		void document.uri;
		void document.content;
		void findRefresh;
		void mdRaw;
		// 要件#74: CodeMirror の面(コード・raw)は自分で数える(文書全体=見えている範囲の外も)。結果は handleFaceFindResults。
		if (cmFind) return;
		// 要件#74 第2段: Markdown の面は見えている文字(容器の textContent)を数える。変換中は張り替えない(契約10)。
		if (mdFaceActive && mdComposing) return;

		if (!container) {
			findRanges = [];
			findCurrent = 0;
			mdAppliedQuery = '';
			return;
		}
		findRanges = findMatches(container.textContent ?? '', query);
		findCurrent = 0;
		mdAppliedQuery = query;
	});

	/**
	 * 要件#55 追補b: 番目合わせ。上の再検索(現在を先頭へ戻す)より**後**に宣言して
	 * あるので、同じ flush では再検索が先に走り、ここは出揃った一致を見て現在を
	 * 置き直す。語が前と同じで再検索が走らない(2 度目のクリック)ときも、ここは
	 * `pendingFindIndex` の変化で走る。対象の木がまだ無い(html の複製面の組み立て前)
	 * あいだは使わずに待つ。
	 */
	$effect(() => {
		const pending = pendingFindIndex;
		const ranges = findRanges;
		if (pending === null) return;
		if (cmFind ? faceFind.query !== findQuery : !findTarget) return;
		pendingFindIndex = null;
		if (pending <= 0 || ranges.length === 0) return;
		findCurrent = Math.min(pending, ranges.length - 1);
	});

	/**
	 * ハイライトの張り替え(契約④)。
	 *
	 * 一致・現在位置・対象の木のどれかが動いたら、前の分を外してから付け直す。
	 * 後始末を effect の cleanup に持たせてあるので、**バーを閉じたときも文書を
	 * 切り替えたときも、そのとき張っていた木から確実に外れる**。
	 */
	$effect(() => {
		const container = findTarget;
		const ranges = findRanges;
		const current = findCurrent;
		if (!container || cmFind) return;
		// 要件#74 第2段: Markdown の面は CSS Custom Highlight API でだけ塗る(フォールバックの <mark> は ProseMirror の
		// DOM を書き換えてしまう)。変換中は張り直さない。
		if (mdFaceActive && (mdComposing || !detectHighlightApi())) return;
		// キャレットが対象の中の編集面にあるあいだは触らない。フォールバックの
		// `<mark>` を挿すとキャレットが飛ぶ ―― 打つたびにそれが起きると編集に
		// ならない。件数は上の effect が出し続けるので「探せない」わけではなく、
		// 出ないのは色だけ。確定・破棄で編集が畳まれたら、その契機で張り直す。
		if (!mdFaceActive && caretInsideEditable(container)) return;
		const api = detectHighlightApi();
		clearHighlights(container, api);
		if (ranges.length === 0) return;
		applyHighlights(container, ranges, current, api);
		scrollToCurrentMatch(container, ranges, current);
		return () => {
			clearHighlights(container, api);
		};
	});

	/**
	 * 要件#90 契約5: 現在の一致が隠した・畳んだアラートの枠の中なら、その枠だけを開く(面も読み取り専用の描画も)。
	 * 塗る effect(CSS Custom Highlight API の有無で止まる)とは別にして、一致の文字範囲から枠を見つける。
	 */
	$effect(() => {
		const container = findTarget;
		const ranges = findRanges;
		const current = findCurrent;
		if (!container || cmFind || !markdownFile) return;
		if (mdFaceActive && mdComposing) return;
		const match = ranges[current];
		if (!match) return;
		untrack(() => {
			const range = rangeAtMatch(container, match);
			if (!range) return;
			revealAlertsAround(range.startContainer);
			if (range.endContainer !== range.startContainer) revealAlertsAround(range.endContainer);
		});
	});

	/**
	 * 要件#90 契約9: 読み取り専用の描画(SSH・閾値超え)でも、アラートの枠に面と同じ隠す・畳む・開くを効かせる。
	 * 描画(`html`)が差し替わるたびに付け直す(1 つずつ畳んだ・開いたは覚えない=契約7)。
	 */
	$effect(() => {
		const root = bodyEl;
		void html;
		if (!root || !markdownFile || mdSurface) return;
		return untrack(() => attachAlertVisibility(root));
	});

	/** キャレットが対象の中の `contenteditable` にあるか(Shadow DOM も見る)。 */
	function caretInsideEditable(container: Element): boolean {
		const root = container.getRootNode() as Document | ShadowRoot;
		const active = root.activeElement;
		if (!active || !container.contains(active)) return false;
		return active.closest('[contenteditable="true"]') !== null;
	}

	/**
	 * 現在の一致を見える位置へ運ぶ(契約④・追補c(2))。
	 *
	 * 運ぶ基準は**一致の文字範囲そのもの**(`Range` の矩形)で、要素ではない ――
	 * ソース編集中の `<pre contenteditable>` には子要素が無く、要素単位で中央寄せ
	 * すると `<pre>` 全体=文書の真ん中へ飛ぶ(backlog 179)。動かすのは閲覧面の
	 * スクロール容器(`article.viewer`)の `scrollTop` だけで、`scrollIntoView` は
	 * 使わない ―― 閲覧・ソース編集・html の複製面(Shadow DOM 内の Range でも
	 * 矩形は取れる)のどれも同じ経路を通る。
	 */
	function scrollToCurrentMatch(container: Element, ranges: MatchRange[], current: number) {
		const match = ranges[current];
		if (!match) return;
		const scroller = viewerEl;
		if (!scroller) return;
		const range = rangeAtMatch(container, match);
		if (!range) return;
		scrollRangeIntoContainer(scroller, range);
	}

	/**
	 * 契約①: ⌘F。出ていなければ出し、出ていれば入力欄へフォーカスを戻して
	 * 現在の語を全選択する(打ち直しがそのまま次の検索になる)。検索バーを出さない
	 * 種別では何も起きない(契約⑥)。
	 */
	function openFind() {
		if (!findSearchable) return;
		findOpen = true;
		onFindOpenChange?.(true);
		void tick().then(() => {
			findInputEl?.focus();
			findInputEl?.select();
		});
	}

	/**
	 * 第3段 3-12: Edit ▸ Find and Replace…。置換を出せる面なら検索バーに置換の行を出し、置換の入力欄へ(語が空なら検索の
	 * 入力欄へ)。出せない面(Markdown の rendered・読み取り専用・画像など)では Find… と同じ。
	 */
	function openFindReplace() {
		if (!canReplace) {
			openFind();
			return;
		}
		if (!findSearchable) return;
		replaceOpen = true;
		findOpen = true;
		onFindOpenChange?.(true);
		void tick().then(() => {
			if (findQuery.length > 0 && replaceInputEl) {
				replaceInputEl.focus();
				replaceInputEl.select();
			} else {
				findInputEl?.focus();
				findInputEl?.select();
			}
		});
	}

	/** 契約⑤: 閉じる。ハイライトは上の effect の cleanup が外す。語は残す。置換の行も一緒に閉じる。 */
	function closeFind() {
		if (!findOpen) return;
		replaceOpen = false;
		findOpen = false;
		findComposing = false;
		onFindOpenChange?.(false);
	}

	function stepFind(direction: 1 | -1) {
		findCurrent = stepIndex(findCurrent, findRanges.length, direction);
	}

	/**
	 * 契約①: Edit メニュー「Find…」(⌘F)。⌘E が +page.svelte 経由でウインドウの
	 * モードを動かすのと違い、検索バーは Viewer の中で完結する一時 UI なので
	 * ここで直に受ける。
	 *
	 * Tauri の外(テストの JSDOM)では購読そのものが失敗するが、それでマウントが
	 * 壊れてはいけない ―― 既存の wiring テストは `$lib/events` をモックしていない。
	 */
	onMount(() => {
		let off: (() => void) | null = null;
		let offReplace: (() => void) | null = null;
		let disposed = false;
		try {
			void listen(MENU_FIND_REPLACE_EVENT, () => {
				pendingFindIndex = null;
				openFindReplace();
			})
				.then((unlisten) => {
					if (disposed) unlisten();
					else offReplace = unlisten;
				})
				.catch(() => {});
			void listen(MENU_FIND_EVENT, () => {
				// Command + F は番目を持たない(先頭=従来どおり)。
				pendingFindIndex = null;
				openFind();
			})
				.then((unlisten) => {
					if (disposed) unlisten();
					else off = unlisten;
				})
				.catch(() => {});
		} catch {
			// Tauri の外。検索は menu からしか入らないので、何もしないでよい。
		}
		return () => {
			disposed = true;
			off?.();
			offReplace?.();
			// この窓から Viewer が消えるとき(別種別のビューアへ移った等)は、
			// 検索バーも一緒に消える。+page.svelte の側に開いたままの印を残さない。
			if (findOpen) onFindOpenChange?.(false);
		};
	});

	/**
	 * 要件#38 追補h(backlog 244): 印刷の間だけ本文の欄のスクロール位置を 0 にし、
	 * 印刷の後に元へ戻す(WebKit が要素のスクロール位置を紙のレイアウトに持ち込むため)。
	 */
	onMount(() => holdScrollForPrint(window, () => [viewerEl]));

	/**
	 * html の閲覧中に +page.svelte が受け取った ⌘F(上のコメント参照)。
	 *
	 * 0 = 要求なし。**進んだ**ときだけが「今の ⌘F」で、閉じると +page が 0 へ戻す。
	 * マウント直後に 1 で来ることがある(iframe から複製面へ切り替えた結果として
	 * この Viewer が生まれる)ので、初期値は props ではなく 0 から数える。
	 */
	let seenFindRequest = 0;
	$effect(() => {
		const request = findRequest;
		const advanced = request > seenFindRequest;
		seenFindRequest = request;
		if (!advanced) return;
		// 要件#55 契約⑦: 語つきの要求なら、その語にしてから開く。
		const initial = untrack(() => findInitialQuery);
		if (initial) findQuery = initial;
		// 要件#55 追補b: 語つきの要求なら、一致が出揃った後でその番目を現在にする。
		pendingFindIndex = initial ? untrack(() => findInitialIndex) : null;
		openFind();
	});

	/**
	 * 契約⑤: Esc の宛先。
	 *
	 * 検索バーが開いていれば**バーが先に食う**(バーは編集より手前の一時 UI)。
	 * 編集の破棄より先に決着させるため document の capture で受け、後段の
	 * ハンドラ(要件#48/#49/#52/#53 の Esc)には渡さない。逆に、こちらより先に
	 * 登録された編集側のハンドラは `findOpen` を見て譲る ―― どちらの登録順でも
	 * 結論が同じになるように両側から挟む。
	 *
	 * IME の変換中の Esc は IME に委ねる(閉じない)。
	 */
	$effect(() => {
		if (!findOpen) return;
		const owner = bodyEl?.ownerDocument;
		if (!owner) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (e.isComposing || findComposing) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			closeFind();
		};
		owner.addEventListener('keydown', onKeyDown, true);
		return () => {
			owner.removeEventListener('keydown', onKeyDown, true);
		};
	});

	// After every html prop change, look for `.vellis-mermaid` placeholders
	// in the rendered body and have the mounter replace them with SVG.
	// Mermaid is dynamic-imported on first need; documents without mermaid
	// blocks never trigger the import (`docs/mermaid.md` §6.3 / §9.4 #3).
	$effect(() => {
		// Re-run whenever the html prop changes.
		void html;
		tick().then(() => {
			if (bodyEl) void mountMermaid(bodyEl);
		});
	});

	async function copyAllAsMarkdown() {
		// 要件#74: 新しい面ではバッファ(今の文字列)全体。
		await navigator.clipboard.writeText(
			anyFace && windowState.fileEditor ? windowState.fileEditor.text() : document.content,
		);
		copyLabel = 'Copied';
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			copyLabel = 'Copy Markdown';
		}, 1000);
	}

	async function addInstructionFromSelection() {
		if (!index) {
			alert('Still rendering. Please try again in a moment.');
			return;
		}
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) {
			alert('Select a range in the document before pressing Add Instruction.');
			return;
		}
		const fileHash = await sha256(document.content);
		const anchor = buildAnchor(sel, index, document.content, fileHash);
		if (!anchor) {
			alert('Could not resolve the selection. Select within the rendered content.');
			return;
		}
		onRequestAddMark(anchor);
	}

	function handleCopy(e: ClipboardEvent) {
		// 要件#74 契約17: 新しい面のコピーは面が持つ(コード=選んだ文字列そのもの・Markdown=見えている文字)。
		if (anyFace) return;
		// Requirement #32: copy exactly the visible text of the selection.
		// The Markdown-source resolution that used to run here (requirement
		// #13 / copy-original-markdown.md §B-3) is gone from the copy path —
		// it widened partial selections to whole blocks and reintroduced
		// notation markers (backlog #20-#22, #27, #71).  `index` is not
		// consulted at all any more; it stays for mark creation (buildAnchor).
		const sel = window.getSelection();
		if (!sel) return;
		const text = planSelectionCopy(sel);
		if (text === null) return; // browser default (collapsed selection etc.)
		e.preventDefault();
		e.clipboardData?.setData('text/plain', text);
	}

	/**
	 * 要件#73: 本文(`bodyEl`)の中で `id` がフラグメントと一致する要素。
	 * 脚注の id は非 ASCII のラベルを百分率符号化したまま持つので、まず綴りの
	 * まま、次に復号した形で探す。見出しへの id 付与はしない(要件#61 は先取りしない)。
	 */
	function inDocumentTarget(fragment: string): HTMLElement | null {
		if (!bodyEl || fragment === '') return null;
		let decoded = fragment;
		try {
			decoded = decodeURIComponent(fragment);
		} catch {
			// 不正な百分率符号化は綴りのままで探す。
		}
		const withId = [...bodyEl.querySelectorAll<HTMLElement>('[id]')];
		return (
			withId.find((el) => el.getAttribute('id') === fragment) ??
			withId.find((el) => el.getAttribute('id') === decoded) ??
			null
		);
	}

	/**
	 * 要件#73: 要素の上端をスクロール容器(`article.viewer`)の可視域の上側 ――
	 * sticky で上に重なる帯(ツールバー・開いていれば検索バー・出ていれば外部変更の帯と知らせ)の直下 ―― へ運ぶ。
	 * 検索の `scrollRangeIntoContainer` と同じく容器の `scrollTop` だけを動かし、
	 * 祖先は巻き込まない。帯の高さはスクロールのたびに実寸を読む ―― `toolbarHeight`
	 * は決まった契機でしか測り直さないので、運ぶ瞬間の値を使う。
	 */
	function scrollElementIntoViewer(el: HTMLElement) {
		const scroller = viewerEl;
		if (!scroller) return;
		const gap = 8;
		const findBar = scroller.querySelector<HTMLElement>('.find-bar--sticky');
		// Issue #851 (1): 貼り付いた帯・知らせ(出ているもの)も上に重なる。積まれるので高さの和。
		const banners = [conflictBannerEl, mergedNoticeEl, removedBannerEl].reduce(
			(sum, banner) => sum + (banner?.isConnected ? banner.offsetHeight : 0),
			0,
		);
		const covered = (toolbarEl?.offsetHeight ?? 0) + (findBar?.offsetHeight ?? 0) + banners;
		const offset =
			el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - covered - gap;
		scroller.scrollTop = Math.max(0, scroller.scrollTop + offset);
	}

	async function handleClick(e: MouseEvent) {
		// 要件#74 第2段: Markdown の面の航行は面が持つ(未保存の確認を通す=判断 7)。
		if (mdFaceActive) return;
		const target = (e.target as HTMLElement).closest('a');
		if (!target) return;
		const href = target.getAttribute('href');
		if (!href) return;

		// External links (http/https/mailto/tel) are delegated to the OS.
		if (isExternal(href)) {
			e.preventDefault();
			openUrl(href);
			return;
		}

		// 要件#73 契約 1・2・5: 同じ文書の中の `#…`(脚注参照・戻りリンク)は、
		// 行き先の要素をスクロール容器の可視域へ運ぶ。`location.hash` を変えるだけの
		// 既定の動作では `article.viewer` がスクロールしないため、ここで運んで既定の
		// 動作は止める。行き先が本文に無いときは従来どおり何もしない。
		if (href.startsWith('#')) {
			const dest = inDocumentTarget(href.slice(1));
			if (dest) {
				e.preventDefault();
				scrollElementIntoViewer(dest);
			}
			return;
		}

		// Internal links (data-vellis-link): .md files navigate within Viewer.
		if (target.hasAttribute('data-vellis-link')) {
			e.preventDefault();
			if (/\.(md|markdown|mdx)$/i.test(href)) {
				if (e.shiftKey) {
					try {
						await invoke('new_window', { path: href, root: windowState.root });
					} catch (err) {
						// 要件#71 契約4
						alert(openInNewWindowFailedMessage(err));
					}
				} else {
					try {
						const doc = await invoke<DocumentPayload>('open_document', { uri: href });
						windowState.setDocument(doc);
					} catch (err) {
						// 要件#71 契約2: 知らせて、表示中の文書は前のまま。
						alert(openFileFailedMessage(err));
					}
				}
			}
			// Non-md files (PDF, etc.) are noop in Phase 1.
		}
	}
</script>

<!--
	要件#54 追補c(1): 検索バーはツールバーの直下に貼り付く(sticky)。その `top` は
	ツールバーの実寸なので、ここで測って CSS カスタムプロパティに渡す。
	Issue #848: 重なりの帯・削除の帯・取り込みの知らせも貼り付く。その `top`(`--vellis-banner-top`)は
	ツールバーの直下、検索バーが開いている間はその下端。
-->
<article
	class="viewer"
	bind:this={viewerEl}
	style:--vellis-find-bar-top="{toolbarHeight}px"
	style:--vellis-banner-top="{bannerTop}px"
>
	<header class="viewer-toolbar" bind:this={toolbarEl}>
		<button
			type="button"
			class="toolbar-button"
			title="Copy the whole document's Markdown source to the clipboard"
			onclick={copyAllAsMarkdown}
		>
			{copyLabel}
		</button>
		{#if aiTools}
			<!-- 要件#84 契約5: 今の AI 連携の 2 つ(配布版では出さない)。 -->
			<button
				type="button"
				class="toolbar-button"
				title="Add an AI instruction for the selection (ai-collab)"
				onclick={addInstructionFromSelection}
			>
				Add Instruction
			</button>
			<button
				type="button"
				class="toolbar-button"
				class:active={marksOpen}
				title="Show or hide the Marks sidebar"
				onclick={onToggleMarks}
				aria-pressed={marksOpen}
			>
				Marks
			</button>
		{/if}
		{#if anyFace && windowState.fileEditor?.dirty}
			<!-- 要件#74 (aj): 開いた時点から編集できる面の未保存の印。 -->
			<!-- 第4段 4-1: 押すと未保存の変更の差分(基準の版 ↔ 今)。 -->
			<button
				type="button"
				class="unsaved-badge"
				data-testid="unsaved-badge"
				aria-label="Show unsaved changes"
				title="This file has unsaved changes. Click to see them."
				onclick={showUnsavedDiff}>Unsaved</button
			>
		{/if}
		{#if formatToolbarAvailable}
			<!-- 第4段 4-2: 書式のツールバーの出し入れ(モックの「A」)。状態はアプリ全体で 1 つ。 -->
			<button
				type="button"
				class="toolbar-button format-toolbar-toggle"
				class:active={formatToolbarShown}
				data-testid="format-toolbar-toggle"
				aria-label="Show Formatting Toolbar"
				aria-pressed={formatToolbarShown}
				title="Show or hide the formatting toolbar"
				onclick={toggleFormatToolbar}
			>
				<Icon name="format" size={14} />
			</button>
		{/if}
		{#if formatToolbarHandle}
			<!-- 第4段 4-2: 2 段目(ヘッダーと一緒に貼り付く・検索バーの位置は 2 段の高さで測る)。 -->
			<div class="format-toolbar-row">
				<FormatToolbar handle={formatToolbarHandle} />
			</div>
		{/if}
			</header>
	{#if findOpen}
		<!--
			要件#54 契約①: 閲覧面の上部に出す検索バー。ツールバーの直下に貼り付く1行。
			外部変更の帯・取り込みの知らせは、開いている間はこの下に貼り付く(Issue #848)。
		-->
		<FindBar
			query={findQuery}
			count={findCount}
			bind:inputEl={findInputEl}
			onQueryChange={(value) => (findQuery = value)}
			onPrev={() => stepFind(-1)}
			onNext={() => stepFind(1)}
			onClose={closeFind}
			onComposingChange={(value) => (findComposing = value)}
			replaceOpen={replaceOpen && canReplace}
			{replaceQuery}
			bind:replaceInputEl
			onReplaceQueryChange={(value) => (replaceQuery = value)}
			onReplace={handleReplace}
			onReplaceAll={handleReplaceAll}
		/>
	{/if}
	{#if conflictShown}
		<!--
			要件#74 契約13: 編集中に重なる外部変更が届いた(か、保存の直前にディスクが変わっていた)。
			文書は変えずに、どちらを残すかを選ばせる。今の外部変更の帯と同じ場所・同じ class。
			要件#48 追補h 契約1: ファイルが削除された間は削除の帯だけを出す(同時に出さない)。
		-->
		<div
			class="external-change"
			data-testid="external-conflict-banner"
			role="alert"
			bind:this={conflictBannerEl}
		>
			<span class="external-change-text">{CONFLICT_MESSAGE}</span>
			<button
				type="button"
				class="toolbar-button"
				data-testid="external-conflict-keep"
				title="Keep your edits (the next save overwrites the file on disk)"
				onclick={() => windowState.fileEditor?.keepMyEdits()}
			>
				Keep My Edits
			</button>
			<button
				type="button"
				class="toolbar-button"
				data-testid="external-conflict-disk"
				title="Reload the file on disk (your edits are discarded)"
				onclick={() => windowState.fileEditor?.useFileOnDisk()}
			>
				Use the File on Disk
			</button>
			<!-- 第4段 4-1: 衝突の差分(今 ↔ 届いた内容)。読むだけ。 -->
			<button
				type="button"
				class="toolbar-button"
				data-testid="external-conflict-diff"
				title="Show the differences between your edits and the file on disk"
				onclick={() => void showConflictDiff()}
			>
				Show Differences
			</button>
			<!-- 要件#89 契約8: 重なった所を塊ごとに選んでマージする画面へ。 -->
			<button
				type="button"
				class="toolbar-button"
				data-testid="external-conflict-merge"
				title="Choose, change by change, between your edits and the file on disk"
				onclick={() => void openMerge()}
			>
				Merge…
			</button>
		</div>
	{/if}
	{#if noticeShown}
		<!--
			要件#74 契約13: 重ならずに取り込んだ外部変更の知らせ(数秒で消える)。
			Issue #851 (2): 重なりの帯と同時に出たら、その下に積む。
			Issue #851 (5): 紙に載せない。print.css は SHA-256 で固定(AC-56-16)なので、印刷で隠す
			既存の class(`.structure-notice`。要件#38 追補d。今は他に使う要素が無い)を重ねる。
			この class に見た目の規則は無い。
		-->
		<div
			class="merged-notice structure-notice"
			data-testid="external-merged-notice"
			role="status"
			bind:this={mergedNoticeEl}
			style:--vellis-banner-offset="{mergedNoticeOffset}px"
		>
			{windowState.fileEditor?.notice}
		</div>
	{/if}
	{#if diffView && anyFace}
		<!-- 第4段 4-1: 差分表示(ペインの文書の場所に重ねる 1 枚・読むだけ)。 -->
		<EditorDiffView
			title={diffView.kind === 'conflict' ? 'Conflicting Changes' : 'Unsaved Changes'}
			leftName={diffView.kind === 'conflict' ? 'Your Edits' : 'On Disk'}
			rightName={diffView.kind === 'conflict' ? 'On Disk' : 'Your Edits'}
			left={diffView.left}
			right={diffView.right}
			onClose={closeDiff}
			onKeep={diffView.kind === 'conflict'
				? () => {
						windowState.fileEditor?.keepMyEdits();
						closeDiff();
					}
				: undefined}
			onUseDisk={diffView.kind === 'conflict'
				? () => {
						windowState.fileEditor?.useFileOnDisk();
						closeDiff();
					}
				: undefined}
			onMerge={diffView.kind === 'conflict' ? () => void openMerge() : undefined}
		/>
	{/if}
	{#if mergeView && anyFace}
		<!-- 要件#89 契約9〜12: マージの画面(差分の画面と同じ層の 1 枚)。 -->
		<EditorDiffView
			title="Merge Changes"
			leftName="My Edits"
			rightName="On Disk"
			left={mergeView.mine}
			right={mergeView.theirs}
			onClose={closeMerge}
			merge={{
				base: mergeView.base,
				mine: mergeView.mine,
				theirs: mergeView.theirs,
				rebuilt: mergeView.rebuilt,
				onCancel: closeMerge,
				onApply: applyMerge,
			}}
		/>
	{/if}
	{#if markdownTooBig && !bigRaw}
		<!--
			要件#74 契約18・判断 8: 閾値を超えた Markdown は今の描画(読み取り専用)で開く。
			Issue #851 (6): 貼り付かない(専用の class。見た目は取り込みの知らせと同じ)。
			Issue #851 (5): 取り込みの知らせと同じく `.structure-notice` で紙に載せない。
		-->
		<div class="too-large-notice structure-notice" data-testid="markdown-too-large-notice" role="status">
			This file is too large to edit in Vellis. Use View ▸ Raw Source to edit it.
		</div>
	{/if}
	{#if windowState.externalRemoved}
		<!--
			要件#48 追補g: 編集中(dirty)の文書のファイルが外部で削除された。文書と
			編集は保ったまま、同じパスに書き直すか、編集を捨てて閉じるかを選ばせる。
			見た目は外部変更の帯と同じ(同じ場所・同じ class)。
			要件#48 追補h 契約2: 編集を原文に戻した(dirty が偽)あとも印は下ろさず、
			文言と title を dirty に合わせる(守る編集が無いのに「未保存」と言わない)。
		-->
		<div
			class="external-change"
			data-testid="external-removed-banner"
			role="alert"
			bind:this={removedBannerEl}
			style:--vellis-banner-offset="{removedBannerOffset}px"
		>
			<span class="external-change-text">
				{windowState.dirty
					? 'This file was deleted outside the app. Your edits have not been saved.'
					: 'This file was deleted outside the app.'}
			</span>
			<button
				type="button"
				class="toolbar-button"
				data-testid="external-removed-save"
				title={windowState.dirty ? 'Save your edits to the file again' : 'Save the file again'}
				onclick={saveRemovedFile}
			>
				Save
			</button>
			<button
				type="button"
				class="toolbar-button"
				data-testid="external-removed-close"
				title={windowState.dirty ? 'Close the file (your edits are discarded)' : 'Close the file'}
				onclick={() => windowState.clearDocument()}
			>
				Close
			</button>
		</div>
	{/if}
	<!--
		要件#36: ズームは本文コンテナだけに掛ける。`zoom` は `transform: scale` と
		違ってレイアウトごと拡大するので、本文中の画像・表・コードブロック・
		mermaid 図が一体で拡縮しつつ、行はウインドウ幅で折り返し直される
		(要件#20 の「幅はウインドウに追従」がそのまま生きる)。ツールバーは
		外にあるので UI の大きさは変わらない。等倍のときは宣言そのものを出さない
		— ズームを入れる前と同じ DOM に戻す(srcdoc 側の `zoomStyleTag` と同じ)。

		要件#74 契約3: 編集の入口は無い(コード・plain text・Markdown は開いた時点から面が編集面)。
	-->
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="markdown-body"
		style:zoom={zoom === DEFAULT_ZOOM || faceActive || mdRaw ? null : `${zoom}%`}
		bind:this={bodyEl}
		onclick={handleClick}
		oncopy={handleCopy}
	>
		{#if faceActive}
			<!--
				要件#74 契約5: コードのファイルと plain text は開いた時点から CodeMirror の面が表示であり
				編集面(Shiki の `<pre>` は印刷の直前だけ面の中に作る)。文書ごとに作り直す。
			-->
			{#key document.uri}
				<CodeEditor
					uri={document.uri}
					content={document.content}
					readOnly={!canEnterEdit('text', document.uri)}
					{codeTheme}
					{zoom}
					findQuery={findOpen ? findQuery : ''}
					{findCurrent}
					onFindResults={handleFaceFindResults}
				/>
			{/key}
		{:else if mdSurface}
			<!--
				要件#74 第2段: Markdown は開いた時点から ProseMirror の面がレンダリング結果であり編集面。
				`.markdown-body` の中なので今の CSS と CSS zoom を受ける。文書ごとに作り直す。閾値を超えた文書は
				Raw Source で入ったときだけ raw だけの面(項目 21)。
			-->
			{#key `${document.uri}\n${markdownTooBig}`}
				<MarkdownEditor
					uri={document.uri}
					content={document.content}
					rawOnly={markdownTooBig}
					{zoom}
					{codeTheme}
					findQuery={findOpen && mdRaw ? findQuery : ''}
					{findCurrent}
					onFindResults={handleFaceFindResults}
					onExitRaw={() => (bigRaw = false)}
					onComposingChange={(value) => (mdComposing = value)}
					onDocChange={handleMdDocChange}
					scrollIntoViewer={scrollElementIntoViewer}
				/>
			{/key}
		{:else if findOpen && htmlDocument}
			<!--
				要件#54 契約②⑦: html の閲覧は sandbox された iframe の中にあり、アプリ
				から中身を読めない(要件#8)。そこで要件#53 の `buildEditSurface` が作る
				sanitize 済み複製を**読み取り専用**で出して探す ―― `contenteditable` は
				付けず、ダブルクリックの配線もしない(⌘F は編集の入口ではない)。
				iframe・sandbox・CSP・`buildSrcdoc` には一切触れない。
			-->
			<div class="html-find-surface" data-testid="html-find-surface" bind:this={findSurfaceHost}></div>
		{:else}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html html}
		{/if}
	</div>
</article>

<style>
	.viewer {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		min-width: 0;
		background-color: var(--color-bg-surface);
	}

	/*
	 * ペインの見出し行(モックの `.ph`= 34px・下に 1px の線)。要件#56 第2段で各ビューアの
	 * ツールバーと同じ寸法・同じボタンにそろえた。
	 */
	.viewer-toolbar {
		position: sticky;
		top: 0;
		z-index: 10;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		box-sizing: border-box;
		min-height: 34px;
		padding: 4px 8px 4px 12px;
		background-color: var(--color-bg-surface);
		border-bottom: 1px solid var(--color-border);
	}

	/*
	 * 見出し行のボタン(モックの `.btn` を小さくしたもの= 24px・角丸 6px・縁は border-strong)。
	 * ホバーは地の上に `--color-bg-hover` を重ねる(ダークでも「明るくなる」向きにそろう)。
	 */
	.toolbar-button {
		height: 24px;
		box-sizing: border-box;
		padding: 0 10px;
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 500;
		line-height: 1;
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
		background-color: var(--color-bg-raised);
		color: var(--color-text-primary);
		cursor: pointer;
		white-space: nowrap;
		transition:
			background-color var(--duration-fast) var(--ease-out),
			border-color var(--duration-fast) var(--ease-out);
	}

	.toolbar-button:hover {
		background-image: linear-gradient(var(--color-bg-hover), var(--color-bg-hover));
	}

	.toolbar-button.active {
		background-color: var(--color-accent-soft);
		border-color: var(--color-accent);
		color: var(--color-accent-text);
	}

	/*
	 * 要件#48 契約⑥・Issue #848(由谷 2026-11-26): 外部変更の重なりの帯・削除の帯。
	 * ツールバーの直下に貼り付く(sticky)1行 —— 長い文書を下までスクロールして直して
	 * いても画面の外に出ない。`top` は Viewer が測って `--vellis-banner-top` に入れる
	 * (ツールバーの実寸。検索バーが開いている間はその下端)。本文の上端(帯の高さ分)に
	 * 載るのは受け入れる。z-index は検索バー(9)より下・本文より上。地の色は半透明の
	 * 警告色なので、下に本文の地(--color-bg-surface)を敷いて文字を透かさない。
	 * Issue #851 (2): 取り込みの知らせと同時に出たら、その下に積む(`--vellis-banner-offset`
	 * =先に出ている帯・知らせの実寸。Viewer が要素ごとに入れる)。
	 */
	.external-change {
		position: sticky;
		top: calc(var(--vellis-banner-top, 0px) + var(--vellis-banner-offset, 0px));
		z-index: 8;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		background-color: var(--color-bg-surface);
		background-image: linear-gradient(var(--color-warning-soft), var(--color-warning-soft));
		border-bottom: 1px solid var(--color-warning);
		font-size: var(--text-sm);
		color: var(--color-text-primary);
	}

	.external-change-text {
		flex: 1;
		min-width: 0;
	}

	/*
	 * 要件#74 契約13・Issue #848: 重ならない外部変更を取り込んだ知らせ。
	 * 外部変更の帯と同じ場所・同じ高さ・同じ貼り付き方(ツールバーの直下、検索バーが
	 * 開いている間はその下)。Issue #851 (2): 重なりの帯と同時に出たらその下に積む。
	 */
	.merged-notice {
		position: sticky;
		top: calc(var(--vellis-banner-top, 0px) + var(--vellis-banner-offset, 0px));
		z-index: 8;
	}

	/*
	 * 取り込みの知らせと閾値超えの知らせ(要件#74 契約18)の見た目。Issue #851 (6): 閾値超えの
	 * 知らせは専用の class で、貼り付かない(#848 の前のとおり)。
	 */
	.merged-notice,
	.too-large-notice {
		padding: 6px 12px;
		background-color: var(--color-bg-raised);
		border-bottom: 1px solid var(--color-border);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.unsaved-badge {
		margin-left: auto;
		font: inherit;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
		/* 第4段 4-1: 押せる札(見た目は札のまま) */
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
	}

	/*
	 * 要件#54 契約②: html の読み取り専用複製面。中身は Shadow DOM にあるので、
	 * ここに書けるのは外側の箱だけ(ハイライトの色は Shadow 側の style で足す)。
	 */
	.html-find-surface {
		display: block;
	}

	/*
	 * 要件#54 契約④: ハイライト。CSS Custom Highlight API が使える環境では
	 * `::highlight()` が効き、無い環境ではフォールバックの `<mark>` に落ちる ――
	 * どちらでも現在の一致だけ色を変えて、どこに居るのかが分かるようにする。
	 * セレクタは本文の中に生えるものに当てるので :global が要る。
	 */
	.markdown-body :global(mark[data-vellis-find]) {
		background-color: var(--color-find-match);
		color: inherit;
	}

	/*
	 * 要件#54 追補d: 現在の一致は文字色を固定する。橙の背景の上で Shiki の橙の
	 * トークンが読めない(比 1.54)ため。色は要件#56 判断 (k) の 3 トークン(ライトは
	 * 追補d の #fef08a / #fb923c / #1f2328 のまま・ダークは対比 4.5 以上の値)。
	 * mark の中の Shiki の span はインラインの `style="color:…"` を持つので、子孫の
	 * 規則は `!important` で勝たせる。
	 */
	.markdown-body :global(mark[data-vellis-find-current]) {
		background-color: var(--color-find-current);
		color: var(--color-find-current-text);
	}

	.markdown-body :global(mark[data-vellis-find-current] *) {
		color: var(--color-find-current-text) !important;
	}

	:global(::highlight(vellis-find)) {
		background-color: var(--color-find-match);
	}

	:global(::highlight(vellis-find-current)) {
		background-color: var(--color-find-current);
		color: var(--color-find-current-text);
	}

	/* 第4段 4-2: 「A」は右端(Unsaved の札があればその右) */
	.format-toolbar-toggle {
		margin-left: auto;
	}

	.unsaved-badge ~ .format-toolbar-toggle {
		margin-left: 0;
	}

	/* 第4段 4-2: 書式のツールバーはヘッダーの 2 段目(幅いっぱい) */
	.format-toolbar-row {
		flex-basis: 100%;
		margin: 4px -8px -4px -12px;
	}
</style>
