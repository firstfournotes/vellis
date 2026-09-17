<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { invoke } from '$lib/ipc';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import { isExternal } from '$lib/uri';
	import { sha256 } from '$lib/annotation';
	import { mountMermaid } from '$lib/mermaid-mounter';
	import { planSelectionCopy } from '$lib/copy-selection';
	import { bufferFromPre } from '$lib/document-edit';
	import { detectFileType } from '$lib/file-type';
	import { saveDocument } from '$lib/save-document';
	import { confirmDiscardEdits } from '$lib/edit-guard';
	import { DEFAULT_ZOOM } from '$lib/zoom';
	import {
		buildEditSurface,
		commitBlock,
		resolveLeafBlock,
		snapshotBlock,
		STRUCTURE_CHANGED_MESSAGE,
		type BlockShape,
		type EditSurfaceIndex,
	} from '../html/edit';
	import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
	import type { NodeMeta, SourceIndex, SourcePosition } from '../markdown/types';
	import { buildAnchor, type BuiltAnchor } from '../markdown/selection';
	import {
		assembleCodeFence,
		replaceRange,
		resolveEditTarget,
		serializeBlock,
		splitCodeFence,
	} from '../markdown/edit';

	let {
		document,
		html,
		index,
		onRequestAddMark,
		onToggleMarks,
		marksOpen,
		zoom = DEFAULT_ZOOM,
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
	} = $props();

	let copyLabel = $state('Copy Markdown');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let bodyEl: HTMLDivElement | undefined = $state();

	// --- その場編集(要件#48) ------------------------------------------
	// 編集に入れるか・dirty か・届いた外部変更をどう扱うかは `WindowState` と
	// `$lib/document-edit` の持ち場。ここは DOM の配線だけを持つ。

	/** 編集中か。モードを持つのはウインドウ状態なので、ここは映すだけ。 */
	let editing = $derived(windowState.editMode === 'edit');

	/**
	 * 要件#49 契約①⑦: ブロック編集で編集モードへ入ったか。
	 *
	 * ブロック編集は要件#48 の `editMode='edit'` / dirty / 保存経路をそのまま流用する
	 * (契約⑦)ので、確定後もモードは `edit` のまま = ⌘S の `saveCurrentEdits` と
	 * `decideFileChanged` の門が開く。ただし**画面はレンダリング結果のまま**でなければ
	 * ならないので、ソース編集の `<pre>` を出すかどうかはこの印で分ける。
	 */
	let blockEditMode = $state(false);

	/**
	 * 要件#53 契約①: html 種別か。⌘E の行き先がソース編集ではなく**レンダリング済み
	 * 編集面**になるのはこの種別だけで、text / markdown は従来どおり(要件#48 契約③)。
	 */
	let htmlDocument = $derived(detectFileType(document.uri) === 'html');

	/**
	 * 要件#53 契約①: 編集面のツールバー「Source」でソース編集モードへ抜けたか。
	 * 確定済みの編集はバッファに残るので、ここで畳むのは**画面だけ**(`endEdit()` は
	 * 呼ばない=要件#49 追補a(3) と同じ考え方)。
	 */
	let htmlSourceRequested = $state(false);

	/** 要件#53: レンダリング済み編集面を出しているか。 */
	let htmlEditing = $derived(editing && htmlDocument && !htmlSourceRequested);

	/** ソース編集モード(要件#48)= 編集中で、ブロック編集でも編集面でもない。 */
	let sourceEditing = $derived(editing && !blockEditMode && !htmlEditing);

	/** 編集中の `<pre contenteditable>`。 */
	let editorEl: HTMLPreElement | undefined = $state();

	/**
	 * 編集中に `<pre>` へ流し込む原文。text 種別はレンダリング結果がそのまま原文
	 * だが、markdown / html は違う — 編集するのは**ソース**なので `document.content`
	 * を出す(契約②のソース編集モード)。バッファがあればそちらが正(保存前の
	 * 編集内容を持っているのはバッファの側)。
	 */
	let editSource = $derived(windowState.editBuffer ?? document.content);

	/**
	 * `<pre>` の中身は Svelte のテキスト補間ではなく、ここで直接入れる。
	 *
	 * `{@html}` も `{expr}` も、依存が動くたびにテキストノードを作り直す =
	 * 編集中のキャレットと IME の変換中候補が飛ぶ。そこで「原文と DOM が食い違う
	 * ときだけ書く」形にしてある: 利用者の入力で動いたときは `oninput` が
	 * バッファを DOM と同じ値へ揃えるのでここは何もせず、外部変更に追従した
	 * (契約⑥ の `apply`)ときだけ書き戻しが走る。
	 */
	$effect(() => {
		const el = editorEl;
		const source = editSource;
		if (!el || el.textContent === source) return;
		el.textContent = source;
	});

	/** 編集へ入った直後だけキャレットを本文へ置く(書き戻しのたびに奪わない)。 */
	let focusedEditor: HTMLElement | null = null;
	$effect(() => {
		const el = editorEl;
		if (!el) {
			focusedEditor = null;
			return;
		}
		if (focusedEditor === el) return;
		focusedEditor = el;
		el.focus();
	});

	// --- ブロック編集(要件#49) ----------------------------------------
	// 「レンダリング DOM ↔ 原文範囲」の往復は `../markdown/edit` の純関数が持つ。
	// ここはどの要素を contenteditable にするかと、確定/破棄の契機だけ。

	/**
	 * 編集中のブロック(契約①)。null = ブロック編集をしていない。
	 * `html` は編集前の中身で、Esc の破棄で書き戻す。
	 *
	 * 要件#52 契約①②: code fence の中身編集も同じ掴みに乗せる ―― 確定/破棄の
	 * 契機・位置補正・dirty・保存は #49 の経路をそのまま使う(要件#52 契約⑦)。
	 * 見分けるのは `fence` の有無だけで、あるときは「開始/終了フェンス行を残して
	 * 中身だけ差し替える」確定に分かれる。
	 */
	let blockEdit: {
		el: HTMLElement;
		meta: NodeMeta;
		html: string;
		/**
		 * 要件#52: 差し替えで**そのまま書き戻す**原文の開始/終了フェンス行と、
		 * 開始フェンスの**インデント幅**(追補a(6))。掴んだときの幅を持ち回るのは、
		 * 素テキスト化で除いた分と確定で付け直す分を必ず一致させるため。
		 */
		fence?: { open: string; close: string; indent: number };
	} | null = $state(null);

	/**
	 * 要件#52 契約⑤: IME の変換中か。
	 *
	 * 変換中の確定/破棄は契機として発火させない ―― 変換候補を選ぶための Esc や、
	 * 候補ウインドウへの mousedown で編集が畳まれると、入力途中の文字が原文へ
	 * 焼き付く。`$state` にしないのは、これが画面に出るものではなく、値が動くたびに
	 * 契機の張り直し($effect)を起こしたくないため。
	 */
	let composing = false;

	/**
	 * 追補a(2): このブロック編集で**閲覧から**編集モードへ入り、まだ何も確定して
	 * いないか。Esc の破棄が閲覧へ戻ってよいのはこの場合だけで、確定済みの編集が
	 * あるときに `endEdit()` を呼ぶとバッファも dirty も巻き戻ってしまう。
	 */
	let blockEditFromView = false;

	/**
	 * 追補a(1): 確定済みブロックの差し替え記録。key=`NodeMeta.id`、値は**初回
	 * レンダー時の原文**での範囲と、そのブロックがこれまでに増減させた長さ。
	 *
	 * `index` の `NodeMeta.position` は初回レンダー基準のままで、確定しても
	 * `html` / `index` props は作り直されない。一方で差し替えの基準は常に最新の
	 * `editBuffer` なので、確定のたびにこの記録から現在の位置へ写す。
	 */
	const committedEdits = new Map<string, { start: number; end: number; delta: number }>();

	/**
	 * レンダーが変わったら(別文書・外部変更の適用)位置の基準も取り直す。
	 *
	 * 追補a(6): 掴んでいるブロックも手放す ―― 再レンダーで DOM は作り直され、
	 * `blockEdit.el` は切り離された旧ノードになる。そのまま確定させると、旧
	 * レンダー基準の位置で**新しい原文**を差し替えて壊す。復元は要らない(その
	 * DOM はもう画面に無い)ので、掴みだけを捨てる。
	 */
	let positionBase: SourceIndex | null = null;
	$effect(() => {
		if (positionBase === index) return;
		positionBase = index;
		committedEdits.clear();
		releaseBlockEdit();
	});

	/**
	 * 追補a(5): 閲覧へ戻ったら位置の記録も捨てる。
	 *
	 * 「編集を終える」(破棄)・⌘E トグル・衝突バナーの「読み直す」で `editBuffer` は
	 * `document.content` へ戻るが、`index` は変わらないので上の `$effect` は鳴らない
	 * ―― 記録を残すと次の編集で古い差分が乗って原文を壊す。あわせて
	 * `blockEditMode` も落とす: 落とさないと `sourceEditing` が偽のままで、次の ⌘E
	 * でソース編集の `<pre>` が出ない(要件#48 契約③のトグルの退行)。
	 */
	$effect(() => {
		if (editing) return;
		committedEdits.clear();
		blockEditMode = false;
		blockEditFromView = false;
		releaseBlockEdit();
		// 要件#53: 編集面まわりも同じ区切りで畳む(次の ⌘E は素の編集面から始まる)。
		htmlSourceRequested = false;
		htmlStructureNotice = null;
		releaseHtmlBlock();
	});

	/** 編集中のブロックを、原文にも DOM にも触らずに手放す。 */
	function releaseBlockEdit() {
		const current = blockEdit;
		if (!current) return;
		blockEdit = null;
		current.el.removeAttribute('contenteditable');
	}

	/**
	 * 初回レンダー基準の `position` を、確定済みの差し替えを踏まえた**現在の
	 * `editBuffer` 上の位置**へ写す(追補a(1))。
	 *
	 * 記録は互いに重ならないので、「その範囲より前で終わった差し替え」の増減を
	 * 足すだけでよい。終端には**そのブロック自身の**過去の差し替えも入る
	 * (`end <= endOffset` が自分自身を含む)ので、同じブロックの再編集も当たる。
	 */
	function currentPositionOf(meta: NodeMeta): SourcePosition {
		const { startOffset, endOffset } = meta.position;
		let startDelta = 0;
		let endDelta = 0;
		for (const edit of committedEdits.values()) {
			if (edit.end <= startOffset) startDelta += edit.delta;
			if (edit.end <= endOffset) endDelta += edit.delta;
		}
		return {
			...meta.position,
			startOffset: startOffset + startDelta,
			endOffset: endOffset + endDelta,
		};
	}

	/** 確定した差し替えの増減を記録へ積む(同じブロックの再編集は足し込む)。 */
	function recordEdit(meta: NodeMeta, delta: number) {
		const prev = committedEdits.get(meta.id);
		committedEdits.set(meta.id, {
			start: meta.position.startOffset,
			end: meta.position.endOffset,
			delta: (prev?.delta ?? 0) + delta,
		});
	}

	/**
	 * 編集開始は明示操作だけ(要件#48 契約③)。ダブルクリックがその1つで、
	 * 単クリックやキー入力では入らない — 閲覧中の誤タッチで dirty にならないため。
	 *
	 * 要件#49 契約①③: どこをダブルクリックしたかで行き先が分かれる。編集可能な
	 * ブロックならそのブロックだけを contenteditable にし、編集不可領域(生 HTML・
	 * code fence・mermaid・alert タイトル・id を持たない要素)なら要件#48 の
	 * ソース編集モードへ誘導する。編集に入れない文書(画像・SSH root 等)では
	 * `beginEdit` が false を返して何も起きない。
	 */
	function handleDoubleClick(e: MouseEvent) {
		// 要件#53: 編集面のダブルクリックは Shadow の中で閉じている(契約③)。
		// composed なイベントはここまで上がってくるが、`target` はホストへ
		// retarget 済みで Markdown の索引にも載っていないので、経路を通さない。
		if (htmlEditing) return;
		if (sourceEditing || blockEdit) return;
		const target = e.target;
		if (!(target instanceof Element)) return;

		const resolved = resolveEditTarget(target, index);
		if (resolved.kind === 'source') {
			// 追補a(3): 誘導はモードの切り替えだけ。既に編集中なら `beginEdit()` を
			// 呼ばない — バッファを `document.content` で初期化し直すと、確定済みの
			// ブロック編集と dirty が消える。
			blockEditMode = false;
			if (!editing) windowState.beginEdit();
			return;
		}
		if (resolved.kind === 'code') {
			beginCodeEdit(resolved.el, resolved.meta);
			return;
		}
		beginBlockEdit(resolved.el, resolved.meta);
	}

	/** そのブロックだけを contenteditable にする(コンテナ全体は不可=契約①)。 */
	function beginBlockEdit(el: HTMLElement, meta: NodeMeta) {
		blockEditMode = true;
		if (!editing) {
			if (!windowState.beginEdit()) {
				blockEditMode = false;
				return;
			}
			blockEditFromView = true;
		}
		blockEdit = { el, meta, html: el.innerHTML };
		el.setAttribute('contenteditable', 'true');
		el.focus();
	}

	/**
	 * 要件#52 契約①: code fence の `<pre>` の中身を素テキストにして編集に入る。
	 *
	 * 素テキストは **DOM の `textContent` ではなく原文から**採る ―― Shiki が末尾
	 * 改行や空白をどう扱うかに依存させないため。原文は「いま差し替える対象」= 現在の
	 * 編集バッファを位置補正した範囲で、`index.sliceOf`(初回レンダー基準)ではない
	 * ―― 同じ fence を2回目に開いたとき、1回目に確定した中身が出る側が正しい。
	 *
	 * フェンス3分割できないときは何もしない(ダブルクリックは空振り)。`resolveEditTarget`
	 * が既に同じ判定をしているので普段は起きないが、原文が編集で壊れていれば起こりうる
	 * ―― そこで編集に入ると開始/終了フェンス行を取り違えて原文を壊す。
	 */
	function beginCodeEdit(el: HTMLElement, meta: NodeMeta) {
		// 基準は編集中なら編集バッファ・閲覧中なら保存済み content(= `beginEdit()`
		// がバッファへ複製するもの)。どちらでも同じ値になるので入る前に採ってよい。
		const base = windowState.editBuffer ?? document.content;
		const position = currentPositionOf(meta);
		// 追補a(6): 開始フェンスのインデント幅。position はフェンス記号から始まるので
		// スライスからは採れず、列(1 起点)から採る。
		const indent = position.startColumn - 1;
		const parts = splitCodeFence(base.slice(position.startOffset, position.endOffset), indent);
		if (!parts) return;

		blockEditMode = true;
		if (!editing) {
			if (!windowState.beginEdit()) {
				blockEditMode = false;
				return;
			}
			blockEditFromView = true;
		}

		blockEdit = {
			el,
			meta,
			html: el.innerHTML,
			fence: { open: parts.open, close: parts.close, indent },
		};
		// Shiki の `<span>` 構造を捨てて素テキストに置き換える(契約①)。フェンス行は
		// 編集不可なので中身だけ ―― 直したい場合はソース編集モードへ(契約③)。
		el.textContent = parts.body;
		el.setAttribute('contenteditable', 'true');
		el.focus();
	}

	/**
	 * 要件#52 契約⑤: キャレット位置へプレーンテキストを差し込む。
	 *
	 * Enter の改行・Tab のタブ文字・貼り付けを**自前で**入れるのは、契約⑤が
	 * 「Tab はタブ文字を挿入」と動作そのものを決めているため ―― 既定動作任せでは
	 * ブラウザごとに Tab でフォーカスが飛び、貼り付けでは HTML の `<span>` が
	 * 素テキストへ混ざる。
	 *
	 * 選択が編集要素の外にある(取れない)ときは末尾へ足す ―― 入力を落とすよりは
	 * 末尾に付く方が失うものが少ない。
	 */
	function insertPlainText(el: HTMLElement, text: string) {
		const doc = el.ownerDocument;
		const sel = doc.defaultView?.getSelection();
		const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
		if (!sel || !range || !el.contains(range.commonAncestorContainer)) {
			el.textContent = (el.textContent ?? '') + text;
			return;
		}
		range.deleteContents();
		const node = doc.createTextNode(text);
		range.insertNode(node);
		// 差し込んだ直後へキャレットを送る(連続入力が積み上がる)。
		range.setStartAfter(node);
		range.setEndAfter(node);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	/**
	 * 確定(契約②)。ブロックを逆シリアライズして `NodeMeta.position` の範囲だけを
	 * 差し替え、要件#48 の編集バッファへ渡す — dirty も保存も向こうの経路(契約⑦)。
	 *
	 * 要件#52 契約②: code fence の中身編集なら逆シリアライズは要らない ―― 中身は
	 * 装飾もリンクも持たない素テキストなので、掴んだときの開始/終了フェンス行を
	 * そのまま挟んで組み立てるだけでよい。差し替え範囲・位置補正・増減の記録は
	 * ブロック編集と同じ(契約⑦)。
	 */
	function commitBlockEdit() {
		const current = blockEdit;
		if (!current) return;
		blockEdit = null;
		blockEditFromView = false;
		current.el.removeAttribute('contenteditable');

		// 追補a(1): 基準は常に最新の原文。position もそこへ写してから差し替える。
		// 追補a(11)「位置の基準」: ただし**行き先を読むスライス**だけは初回レンダー
		// 基準の原文(`index.sliceOf` = 門 `resolveEditTarget` が見るのと同じもの)を
		// 渡す。子の `data-source-*` は初回レンダー基準の絶対 offset なので、同じ
		// ブロックを2回続けて編集すると確定後の原文から切った窓はずれる(AC-49-25)。
		const base = windowState.editBuffer ?? document.content;
		const position = currentPositionOf(current.meta);
		const fence = current.fence;
		const replacement = fence
			? assembleCodeFence(fence.open, current.el.textContent ?? '', fence.close, fence.indent)
			: serializeBlock(
					current.el,
					{ ...current.meta, position },
					base,
					document.uri,
					index?.sliceOf(current.meta.id),
				);
		if (fence) {
			// 要件#52 契約⑥: 確定しても再レンダーはしない(Shiki の色は戻らない)。
			// 表示だけは末尾改行の規約を通した中身へ揃えて、画面と原文を一致させる。
			// 追補a(6): 表示へ戻すのは**素テキスト**なので、付け直したインデントは
			// また除く(除かないと次の編集で二重に下がる)。
			current.el.textContent = splitCodeFence(replacement, fence.indent)?.body ?? '';
		}
		windowState.updateBuffer(replaceRange(base, position, replacement));
		recordEdit(current.meta, replacement.length - (position.endOffset - position.startOffset));
	}

	/**
	 * 破棄(契約②)。編集前の中身へ戻し、バッファには何も書かない。
	 *
	 * 追補a(2): 破棄するのは**そのブロックの編集だけ**。閲覧から入ってまだ何も
	 * 確定していないときだけ閲覧へ戻り、確定済みの編集があるなら編集モードのまま
	 * 残す(`endEdit()` はバッファと dirty ごと巻き戻すので呼ばない)。
	 */
	function discardBlockEdit() {
		const current = blockEdit;
		if (!current) return;
		blockEdit = null;
		current.el.removeAttribute('contenteditable');
		current.el.innerHTML = current.html;
		if (!blockEditFromView) return;
		blockEditFromView = false;
		blockEditMode = false;
		windowState.endEdit();
	}

	/**
	 * ブロック編集中の確定/破棄の契機を張る(契約②)。
	 *
	 * 確定はブロック**外**の mousedown。click ではなく mousedown を見るのは、
	 * 押した先が別のブロックでもリンクでも、その操作が始まる前に差し戻しを
	 * 済ませておくため。blur / focusout は contenteditable の生死に引きずられる
	 * ので使わない。
	 *
	 * 要件#52 契約⑤: IME の変換中はどちらの契機も発火させない。あわせて、code fence
	 * の中身編集のときだけ編集要素そのものにも Enter / Tab / 貼り付けを張る
	 * (コードなので Enter は確定ではなく改行=契約②)。
	 */
	$effect(() => {
		const current = blockEdit;
		const el = current?.el;
		if (!current || !el) return;
		const doc = el.ownerDocument;
		const codeEdit = current.fence !== undefined;

		const onPointerDown = (e: MouseEvent) => {
			if (composing) return;
			const target = e.target;
			if (target instanceof Node && el.contains(target)) return;
			commitBlockEdit();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Escape' || e.isComposing || composing) return;
			e.preventDefault();
			discardBlockEdit();
		};
		const onCompositionStart = () => {
			composing = true;
		};
		const onCompositionEnd = () => {
			composing = false;
		};

		/**
		 * 要件#52 契約②⑤: Enter は改行・Tab はタブ文字。どちらも既定動作を止めて
		 * 自前で入れる ―― Tab の既定はフォーカス移動で、契約⑤の「フォーカスを
		 * 移さない」と食い違う。Shift+Tab は文字を入れないが、既定も止める
		 * (逆向きのフォーカス移動で編集中の fence からキャレットが外れないよう)。
		 */
		const onEditorKeyDown = (e: KeyboardEvent) => {
			if (e.isComposing || composing) return;
			if (e.key === 'Enter') {
				e.preventDefault();
				insertPlainText(el, '\n');
				return;
			}
			if (e.key === 'Tab') {
				e.preventDefault();
				if (e.shiftKey) return;
				insertPlainText(el, '\t');
			}
		};
		/** 要件#52 契約⑤: 貼り付けはプレーンテキストだけ(HTML の span を混ぜない)。 */
		const onPaste = (e: ClipboardEvent) => {
			e.preventDefault();
			const text = e.clipboardData?.getData('text/plain') ?? '';
			if (text.length > 0) insertPlainText(el, text);
		};

		doc.addEventListener('mousedown', onPointerDown, true);
		doc.addEventListener('keydown', onKeyDown, true);
		el.addEventListener('compositionstart', onCompositionStart);
		el.addEventListener('compositionend', onCompositionEnd);
		if (codeEdit) {
			el.addEventListener('keydown', onEditorKeyDown);
			el.addEventListener('paste', onPaste);
		}
		return () => {
			doc.removeEventListener('mousedown', onPointerDown, true);
			doc.removeEventListener('keydown', onKeyDown, true);
			el.removeEventListener('compositionstart', onCompositionStart);
			el.removeEventListener('compositionend', onCompositionEnd);
			el.removeEventListener('keydown', onEditorKeyDown);
			el.removeEventListener('paste', onPaste);
			composing = false;
		};
	});

	// --- レンダリング済み編集面(要件#53) ------------------------------
	// 「編集面の HTML と索引 ↔ 原文範囲」の往復は `../html/edit` の純関数が持つ。
	// ここは編集面を Shadow DOM に出すことと、どの要素を contenteditable にするか、
	// 確定/破棄の契機だけ。閲覧の iframe(HtmlViewer)には触れない(契約①)。

	/** 編集面のホスト。`attachShadow({mode:'open'})` で文書の CSS を閉じ込める(契約②)。 */
	let htmlSurfaceHost: HTMLDivElement | undefined = $state();

	/** Shadow 内の編集面ルート。葉ブロックの解決はこの中で閉じる(契約③)。 */
	let htmlSurfaceRoot: HTMLElement | null = null;

	/**
	 * hid → 原文範囲の索引(契約②)。確定のたびに位置補正済みのものへ差し替える
	 * ―― 確定で編集面は再構築しないので(契約④)、索引だけが原文の今を知っている。
	 * `$state` にしないのは、これが画面に出るものではないため。
	 */
	let htmlSurfaceIndex: EditSurfaceIndex | null = null;

	/**
	 * いまの編集面が組み立てられた原文。null = 編集面を出していない。
	 *
	 * 索引はこの原文の上の offset なので、編集バッファがこれと食い違ったら
	 * 索引はもう使えない ―― 確定の書き戻しが別の場所へ当たって原文を壊す。
	 * 自分の確定では両方を同じ値へ進めるので食い違わず、食い違うのは**外から**
	 * 差し替わったとき(要件#48 契約⑥の `apply` / 衝突バナーの「読み直す」)だけ。
	 */
	let htmlSurfaceSource: string | null = null;

	/**
	 * 編集中のブロック(契約③)。`before` は編集開始時の形(確定時に比べる)、
	 * `html` は編集前の中身で、Esc の破棄と契約④の拒否で書き戻す。
	 */
	let htmlBlock: { el: HTMLElement; before: BlockShape; html: string } | null = $state(null);

	/** 要件#48/#49/#52 と同じ: IME の変換中は確定・破棄の契機を発火させない(契約⑥)。 */
	let htmlComposing = false;

	/** 契約④の拒否通知。null = 出さない。 */
	let htmlStructureNotice = $state<string | null>(null);

	/**
	 * 編集面の中だけに効かせる素の見た目。文書の CSS は Shadow に閉じているので、
	 * 編集中のブロックを示す枠とリンクの見た目はここで足す(アプリの UI へは漏れない)。
	 */
	const HTML_SURFACE_CSS = [
		':host{display:block}',
		'[contenteditable="true"]{outline:2px solid #93c5fd;outline-offset:2px;border-radius:2px}',
		'[data-vellis-href],[data-vellis-xlink-href]{color:#0000ee;color:-webkit-link;',
		'text-decoration:underline}',
	].join('');

	/**
	 * 編集面を組み立てて Shadow DOM へ出す(契約②)。
	 *
	 * 呼ぶのはホスト要素が生まれたときだけ ―― 確定のたびに作り直すと、掴んでいる
	 * ブロックも画面の位置も飛ぶ(契約④「確定で編集面を再構築しない」)。そのため
	 * 呼び出し側は `untrack` で包み、原文(編集バッファ)の変化では鳴らさない。
	 */
	function mountHtmlSurface(host: HTMLDivElement) {
		const owner = host.ownerDocument;
		const source = windowState.editBuffer ?? document.content;
		const surface = buildEditSurface(source, document.uri);
		htmlSurfaceIndex = surface.index;
		htmlSurfaceSource = source;

		const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
		shadow.replaceChildren();

		const own = owner.createElement('style');
		own.textContent = HTML_SURFACE_CSS;
		shadow.append(own);
		// 文書の head 側のスタイル(style 要素の中身)を編集面へ移して効かせる
		// (契約②)。ここに生のタグを書かないのは、svelte-check の抽出器が
		// コンポーネントの style ブロックの開始と取り違えるため。
		for (const css of surface.styles) {
			const style = owner.createElement('style');
			style.textContent = css;
			shadow.append(style);
		}

		const root = owner.createElement('div');
		root.className = 'vellis-html-edit-root';
		// sanitize 済みの HTML(script / on* / iframe は落ちている=契約②)。
		root.innerHTML = surface.html;
		shadow.append(root);
		htmlSurfaceRoot = root;
	}

	$effect(() => {
		const host = htmlSurfaceHost;
		if (!host) {
			htmlSurfaceRoot = null;
			htmlSurfaceIndex = null;
			return;
		}
		untrack(() => mountHtmlSurface(host));
		return () => {
			// 「Source」への切り替え・閲覧へ戻るで編集面ごと消えるとき。編集中の
			// ブロックは破棄(確定済みの編集はバッファに残る=契約①)。
			releaseHtmlBlock();
			htmlSurfaceRoot = null;
			htmlSurfaceIndex = null;
			htmlSurfaceSource = null;
		};
	});

	/**
	 * 編集バッファが**外から**差し替わったら編集面を作り直す(契約⑧)。
	 *
	 * 要件#48 契約⑥の `apply`(編集中・未変更のまま届いた外部変更)と衝突バナーの
	 * 「読み直す」は、画面に断りなくバッファを別の原文へ替える。索引は古い原文の
	 * offset のままなので、そこで確定すると見当違いの範囲を書き潰す ―― 新しい原文で
	 * 組み直して、索引と画面をそろえる。自分の確定では両方が同じ値へ進むので鳴らない
	 * (契約④「確定で編集面を再構築しない」)。
	 */
	$effect(() => {
		const buffer = windowState.editBuffer;
		const host = htmlSurfaceHost;
		if (!host || htmlSurfaceSource === null || buffer === null || buffer === htmlSurfaceSource) {
			return;
		}
		untrack(() => {
			releaseHtmlBlock();
			htmlStructureNotice = null;
			mountHtmlSurface(host);
		});
	});

	/**
	 * 編集面のキャレット位置へプレーンテキストを差し込む(契約⑥)。
	 *
	 * ソース編集の `insertPlainText` と分けてあるのは **Shadow DOM の選択** のため:
	 * `document.getSelection()` は Shadow の中を指す Range を返さない(ブラウザに
	 * よってはホストへ retarget され、JSDOM では `addRange` 自体が効かない)。
	 * Chrome 系の `ShadowRoot.getSelection()` を先に試し、どちらも取れなければ
	 * 末尾へ足す ―― ここで `textContent` に代入すると要素ごと潰れて、確定が契約④の
	 * 「構造が変わった」で拒否されてしまう。テキストノードを1つ足すだけにすれば、
	 * 確定時の `normalize()` が隣のテキストと束ねて元の形へ戻る。
	 */
	function insertSurfaceText(el: HTMLElement, text: string) {
		const owner = el.ownerDocument;
		const root = el.getRootNode() as Partial<{ getSelection: () => Selection | null }>;
		const sel = root.getSelection?.() ?? owner.defaultView?.getSelection() ?? null;
		const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
		if (!sel || !range || !el.contains(range.commonAncestorContainer)) {
			el.append(owner.createTextNode(text));
			return;
		}
		range.deleteContents();
		const node = owner.createTextNode(text);
		range.insertNode(node);
		range.setStartAfter(node);
		range.setEndAfter(node);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	/** 編集中のブロックを、原文にも DOM にも触らずに手放す。 */
	function releaseHtmlBlock() {
		const current = htmlBlock;
		if (!current) return;
		htmlBlock = null;
		current.el.removeAttribute('contenteditable');
	}

	/** そのブロックだけを contenteditable にする(契約③)。 */
	function beginHtmlBlockEdit(el: HTMLElement) {
		if (htmlBlock?.el === el) return;
		// 別のブロックへ移るときは先のブロックを確定してから(契約③)。普段は
		// ダブルクリックに先立つ mousedown が済ませているが、経路を1つに閉じる。
		if (htmlBlock) commitHtmlBlock();
		htmlStructureNotice = null;
		htmlBlock = { el, before: snapshotBlock(el), html: el.innerHTML };
		el.setAttribute('contenteditable', 'true');
		el.focus();
	}

	/**
	 * 確定(契約④)。値が変わったテキストノードだけを原文の当該範囲へ書き戻し、
	 * 要件#48 の編集バッファへ渡す ―― dirty も保存も向こうの経路(契約⑧)。
	 *
	 * 形が変わっていたら拒否して編集前の DOM へ戻し、通知を出す。原文は触らないので
	 * dirty にもならない。
	 */
	function commitHtmlBlock() {
		const current = htmlBlock;
		if (!current) return;
		htmlBlock = null;
		current.el.removeAttribute('contenteditable');

		const index = htmlSurfaceIndex;
		if (!index) return;
		const base = windowState.editBuffer ?? document.content;
		const result = commitBlock({ source: base, index, block: current.el, before: current.before });
		if (!result.ok) {
			current.el.innerHTML = current.html;
			htmlStructureNotice = STRUCTURE_CHANGED_MESSAGE;
			return;
		}
		// 確定後の索引は位置補正済み(契約④)。同じブロックの2回目・別ブロックの
		// 後の編集でも正しい範囲が差し替わる。
		htmlSurfaceIndex = result.index;
		htmlSurfaceSource = result.source;
		htmlStructureNotice = null;
		if (result.source !== base) windowState.updateBuffer(result.source);
	}

	/** 破棄(契約④⑥)。編集前の DOM へ戻し、バッファには何も書かない。 */
	function discardHtmlBlock() {
		const current = htmlBlock;
		if (!current) return;
		htmlBlock = null;
		current.el.removeAttribute('contenteditable');
		current.el.innerHTML = current.html;
		htmlStructureNotice = null;
	}

	/**
	 * 契約③の「そのブロックの中か」。Shadow DOM を跨ぐと `event.target` はホストへ
	 * retarget されるので、`contains` では中の要素を外だと誤る ―― 実際に通った道
	 * (`composedPath`)で見る。
	 */
	function eventPathContains(e: Event, el: Element): boolean {
		const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
		if (path.length > 0) return path.includes(el);
		const target = e.target;
		return target instanceof Node && el.contains(target);
	}

	/**
	 * 編集面の契機(契約③④⑥)。
	 *
	 * ダブルクリックは **Shadow のルート** に張る ―― そこに張ればイベントの
	 * `target` は Shadow の中の本当の要素のままで届く。確定の契機(ブロック外の
	 * mousedown)とキーは文書レベルに張り、`composedPath` で中か外かを見る。
	 */
	$effect(() => {
		if (!htmlEditing) return;
		const host = htmlSurfaceHost;
		const shadow = host?.shadowRoot;
		if (!host || !shadow) return;
		const owner = host.ownerDocument;

		const onDoubleClick = (e: Event) => {
			const root = htmlSurfaceRoot;
			const target = e.target;
			if (!root || !(target instanceof Element)) return;
			const block = resolveLeafBlock(target, root);
			// 編集不可(hid が無い・コンテナ)ならダブルクリックは空振り(契約⑤)。
			if (!block) return;
			beginHtmlBlockEdit(block);
		};

		const onPointerDown = (e: MouseEvent) => {
			if (htmlComposing) return;
			const current = htmlBlock;
			if (!current || eventPathContains(e, current.el)) return;
			commitHtmlBlock();
		};

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.isComposing || htmlComposing) return;
			const current = htmlBlock;
			if (!current) {
				// ブロックを掴んでいないときの Esc は要件#48 の出口(閲覧へ戻る関門)。
				if (e.key !== 'Escape') return;
				e.preventDefault();
				void confirmDiscardEdits();
				return;
			}
			const el = current.el;
			const isPre = el.tagName.toLowerCase() === 'pre';
			if (e.key === 'Escape') {
				e.preventDefault();
				discardHtmlBlock();
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				// `<pre>` では改行が意味を持つので `\n` を入れる。それ以外のテキスト
				// ノードで改行は空白でしかなく、`<br>` を入れると構造の変化になって
				// 確定が拒否される ―― だから Shift+Enter は何もしない(契約⑥)。
				if (isPre) insertSurfaceText(el, '\n');
				else if (!e.shiftKey) commitHtmlBlock();
				return;
			}
			if (e.key === 'Tab') {
				// フォーカスは移さない(契約⑥)。`<pre>` だけタブ文字を入れる。
				e.preventDefault();
				if (isPre && !e.shiftKey) insertSurfaceText(el, '\t');
			}
		};

		shadow.addEventListener('dblclick', onDoubleClick);
		owner.addEventListener('mousedown', onPointerDown, true);
		owner.addEventListener('keydown', onKeyDown, true);
		return () => {
			shadow.removeEventListener('dblclick', onDoubleClick);
			owner.removeEventListener('mousedown', onPointerDown, true);
			owner.removeEventListener('keydown', onKeyDown, true);
		};
	});

	/**
	 * 編集中のブロックそのものに張る契機(契約⑥)。IME の変換中の印と、
	 * 貼り付けのプレーンテキスト化 ―― HTML を貼って要素が混ざると契約④で拒否に
	 * なるので、入口で止める。
	 */
	$effect(() => {
		const current = htmlBlock;
		if (!current) return;
		const el = current.el;

		const onCompositionStart = () => {
			htmlComposing = true;
		};
		const onCompositionEnd = () => {
			htmlComposing = false;
		};
		const onPaste = (e: ClipboardEvent) => {
			e.preventDefault();
			const text = e.clipboardData?.getData('text/plain') ?? '';
			if (text.length > 0) insertSurfaceText(el, text);
		};

		el.addEventListener('compositionstart', onCompositionStart);
		el.addEventListener('compositionend', onCompositionEnd);
		el.addEventListener('paste', onPaste);
		return () => {
			el.removeEventListener('compositionstart', onCompositionStart);
			el.removeEventListener('compositionend', onCompositionEnd);
			el.removeEventListener('paste', onPaste);
			htmlComposing = false;
		};
	});

	/**
	 * ツールバーの「Source」(契約①)。ソース編集モードへ切り替えるだけで、
	 * `endEdit()` は呼ばない ―― 確定済みの編集(バッファと dirty)を失わせない。
	 */
	function handleEditSource() {
		releaseHtmlBlock();
		htmlStructureNotice = null;
		htmlSourceRequested = true;
	}

	function handleEditInput(e: Event) {
		windowState.updateBuffer(bufferFromPre(e.currentTarget as HTMLElement));
	}

	/**
	 * Esc で閲覧へ戻る(契約③)。編集中の文字入力は素通しする。
	 *
	 * 追補c: 閲覧へ戻る=編集バッファを捨てる操作なので、⌘E トグルと同じ関門を
	 * 通す。`confirmDiscardEdits` は非 dirty なら何も聞かずに畳み、dirty なら
	 * 保存 / 破棄 / キャンセルを聞いて、保存なら成功後・破棄なら即・キャンセル
	 * なら何もせず編集中のまま — こちらで戻り値を見て分岐するものは無い。
	 */
	function handleEditKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		void confirmDiscardEdits();
	}

	/** ツールバーの「編集を終える」(契約③)。出口は Esc と同じ関門を通る。 */
	function handleEditDone() {
		void confirmDiscardEdits();
	}

	/** 衝突表示の「上書き保存」(契約⑥)。編集中の内容で外部版を上書きする。 */
	async function overwriteExternal() {
		try {
			await saveDocument(document.uri, windowState.editBuffer ?? document.content);
		} catch (err) {
			alert(`Could not save: ${err}`);
		}
	}

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
		await navigator.clipboard.writeText(document.content);
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

	async function handleClick(e: MouseEvent) {
		// 編集中はリンク航行を止める(要件#48 契約②)。ソース編集の `<pre>` に
		// リンクは無いが、preventDefault が残っているとキャレットの置き直しを
		// 邪魔しうるので、経路そのものを通さない。
		if (editing) return;
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

		// Internal links (data-vellis-link): .md files navigate within Viewer.
		if (target.hasAttribute('data-vellis-link')) {
			e.preventDefault();
			if (/\.(md|markdown|mdx)$/i.test(href)) {
				if (e.shiftKey) {
					await invoke('new_window', { path: href, root: windowState.root });
				} else {
					const doc = await invoke<DocumentPayload>('open_document', { uri: href });
					windowState.setDocument(doc);
				}
			}
			// Non-md files (PDF, etc.) are noop in Phase 1.
		}
	}
</script>

<article class="viewer">
	<header class="viewer-toolbar">
		<button
			type="button"
			class="toolbar-button"
			title="Copy the whole document's Markdown source to the clipboard"
			onclick={copyAllAsMarkdown}
		>
			{copyLabel}
		</button>
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
		{#if htmlEditing}
			<!--
				要件#53 契約①: html の ⌘E はレンダリング済み編集面へ入る。タグ・属性・
				装飾を直したいときの行き先がソース編集モードで、その入口がこのボタン。
			-->
			<button
				type="button"
				class="toolbar-button"
				data-testid="edit-source"
				title="Edit the HTML source instead of the rendered text"
				onclick={handleEditSource}
			>
				Source
			</button>
		{/if}
		{#if editing}
			<!--
				要件#48 契約③: 閲覧へ戻る明示操作。Esc と対になるもう1つの出口で、
				キーボードを知らなくても抜けられるようにツールバーへ出す。
			-->
			<button
				type="button"
				class="toolbar-button"
				data-testid="edit-done"
				title="Finish editing and go back to viewing (Esc)"
				onclick={handleEditDone}
			>
				Done Editing
			</button>
		{/if}
	</header>
	{#if windowState.externalChange !== null}
		<!--
			要件#48 契約⑥: 編集中に届いた外部変更。再レンダーはせず(編集中の内容を
			勝手に捨てない)、どちらを残すかを利用者に選ばせる。
		-->
		<div class="external-change" data-testid="external-change-banner" role="alert">
			<span class="external-change-text">
				This file was changed outside the app. It differs from your edits.
			</span>
			<button
				type="button"
				class="toolbar-button"
				data-testid="external-overwrite"
				title="Overwrite the external change with your edits"
				onclick={overwriteExternal}
			>
				Overwrite
			</button>
			<button
				type="button"
				class="toolbar-button"
				data-testid="external-reload"
				title="Reload the external change (your edits are discarded)"
				onclick={() => windowState.acceptExternalChange()}
			>
				Reload
			</button>
		</div>
	{/if}
	{#if htmlStructureNotice !== null}
		<!--
			要件#53 契約④: 構造が変わった編集は確定せず、編集前の DOM へ戻したことを
			伝える。原文は触っていない(dirty にもならない)ので、行き先だけを示す。
		-->
		<div class="structure-notice" data-testid="htmledit-structure-notice" role="status">
			{htmlStructureNotice}
		</div>
	{/if}
	<!--
		要件#36: ズームは本文コンテナだけに掛ける。`zoom` は `transform: scale` と
		違ってレイアウトごと拡大するので、本文中の画像・表・コードブロック・
		mermaid 図が一体で拡縮しつつ、行はウインドウ幅で折り返し直される
		(要件#20 の「幅はウインドウに追従」がそのまま生きる)。ツールバーは
		外にあるので UI の大きさは変わらない。等倍のときは宣言そのものを出さない
		— ズームを入れる前と同じ DOM に戻す(srcdoc 側の `zoomStyleTag` と同じ)。

		要件#48 契約③: ダブルクリックが編集開始の明示操作。単クリック(リンク航行)
		とコピーは従来どおりで、キー入力では入らない。

		要件#49 契約①: 同じダブルクリックでも、レンダリング済み Markdown では
		押した先のブロック1つだけが編集可になる(このコンテナは contenteditable に
		しない)。編集不可領域を押したときだけソース編集モードへ落ちる(契約③)。
	-->
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="markdown-body"
		style:zoom={zoom === DEFAULT_ZOOM ? null : `${zoom}%`}
		bind:this={bodyEl}
		onclick={handleClick}
		ondblclick={handleDoubleClick}
		oncopy={handleCopy}
	>
		{#if htmlEditing}
			<!--
				要件#53 契約①②: html の編集面。中身は Shadow DOM(`mode: 'open'`)へ
				出すので、文書の CSS は効きつつアプリの UI へは漏れない。閲覧の iframe
				(HtmlViewer)はこの間 +page.svelte の `editMode === 'view'` 分岐から
				外れて消える ―― 編集面は iframe の外にあり、iframe とは通信しない。
			-->
			<div class="html-edit-surface" data-testid="html-edit-surface" bind:this={htmlSurfaceHost}></div>
		{:else if sourceEditing}
			<!--
				要件#48 契約②: 編集中はレンダリング結果を出さない。text 種別は
				`renderPlainText` と同じ `<pre class="vellis-plaintext">` を自前で置き、
				markdown / html は同じ `<pre>` に**ソース**を出す(ソース編集モード)。
				中身を入れるのは上の $effect — 補間で書くと再描画のたびにキャレットが
				飛ぶため、Svelte にはこのノードの中を触らせない。
			-->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<pre
				class="vellis-plaintext"
				contenteditable="true"
				spellcheck="false"
				bind:this={editorEl}
				oninput={handleEditInput}
				onkeydown={handleEditKeydown}></pre>
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
		background-color: #ffffff;
	}

	.viewer-toolbar {
		position: sticky;
		top: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		background-color: #ffffff;
		border-bottom: 1px solid #e5e7eb;
	}

	.toolbar-button {
		font-size: 12px;
		padding: 4px 10px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background-color: #f9fafb;
		color: #374151;
		cursor: pointer;
	}

	.toolbar-button:hover {
		background-color: #f3f4f6;
	}

	.toolbar-button.active {
		background-color: #dbeafe;
		border-color: #93c5fd;
		color: #1e40af;
	}

	/*
	 * 要件#48 契約⑥: 外部変更の衝突表示。ツールバーの直下に敷く1行で、本文の
	 * 上に重ねない — 編集中の文字を隠さないため。sticky はツールバー側だけに
	 * 掛かっているので、この帯は本文と一緒にスクロールして退く。
	 */
	.external-change {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		background-color: #fef3c7;
		border-bottom: 1px solid #fcd34d;
		font-size: 12px;
		color: #78350f;
	}

	.external-change-text {
		flex: 1;
		min-width: 0;
	}

	/*
	 * 要件#53 契約④: 構造変化で確定を拒否したときの通知。外部変更の帯と同じ場所・
	 * 同じ高さに敷いて、本文の上に重ねない(編集中の文字を隠さない)。
	 */
	.structure-notice {
		padding: 6px 12px;
		background-color: #fee2e2;
		border-bottom: 1px solid #fca5a5;
		font-size: 12px;
		color: #7f1d1d;
	}

	/*
	 * 要件#53 契約②: 編集面のホスト。中身は Shadow DOM にあるので、ここに書ける
	 * のは外側の箱だけ(文書の CSS は向こう側で閉じている)。
	 */
	.html-edit-surface {
		display: block;
	}

	/*
	 * 要件#48 契約②: 編集中の `<pre>`。見た目は閲覧中のプレーンテキスト
	 * (styles/markdown.css の .vellis-plaintext)のままにして、編集に入った
	 * 瞬間に本文が動かないようにする。ここで足すのは編集中であることの手掛かり
	 * (キャレットの帯)だけ。
	 */
	.vellis-plaintext[contenteditable='true'] {
		outline: none;
		box-shadow: inset 3px 0 0 #93c5fd;
	}

	/*
	 * 要件#49 契約①: 編集中のブロック。どこが編集単位になっているかを示すだけの
	 * 枠で、レイアウトは動かさない(outline は場所を取らない)。セレクタは本文の
	 * 中に生えた要素に当てるので :global が要る。
	 */
	.markdown-body :global([contenteditable='true']) {
		outline: 2px solid #93c5fd;
		outline-offset: 2px;
		border-radius: 2px;
	}
</style>
