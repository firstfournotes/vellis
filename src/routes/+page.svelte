<script lang="ts">
	import { onMount } from 'svelte';
	import Explorer from '../components/Explorer.svelte';
	import Viewer from '../components/Viewer.svelte';
	import HtmlViewer from '../components/HtmlViewer.svelte';
	import ImageViewer from '../components/ImageViewer.svelte';
	import VideoViewer from '../components/VideoViewer.svelte';
	import PdfViewer from '../components/PdfViewer.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import StatusBar from '../components/StatusBar.svelte';
	import InstructionDialog from '../components/InstructionDialog.svelte';
	import MarkList from '../components/MarkList.svelte';
	import ProvenancePanel from '../components/ProvenancePanel.svelte';
	import DiffView from '../components/DiffView.svelte';
	import RootPicker from '../components/RootPicker.svelte';
	import UpdateBanner from '../components/UpdateBanner.svelte';
	import { invoke } from '$lib/ipc';
	import { listen } from '$lib/events';
	import { open } from '@tauri-apps/plugin-dialog';
	import { windowState, type DocumentPayload, type Entry } from '../stores/window-state.svelte';
	import { marksStore } from '../stores/marks.svelte';
	import { featureFlags } from '$lib/flags.svelte';
	import { detectFileType, renderForDisplay, type FileType } from '$lib/file-type';
	import { openForDisplay } from '$lib/open-document';
	import { imageSrcWithVersion } from '$lib/image-watch';
	import {
		DEFAULT_PANE_WIDTH,
		clampPaneWidth,
		loadPaneWidth,
		savePaneWidth
	} from '$lib/pane-resize';
	import {
		loadHistory,
		openHistoryEntry,
		toPickerEntries,
		type RootPickerEntry
	} from '$lib/root-picker';
	import {
		clearSnapshot,
		loadSnapshot,
		restoreSnapshot,
		saveSnapshot,
		shouldShowRootPicker
	} from '$lib/reload-state';
	import {
		SELECT_FOLDER_DIALOG_TITLE,
		openFailedMessage,
		registerMenuOpenListeners
	} from '$lib/menu-open';
	import {
		duplicateWindow,
		duplicateWindowFailedMessage,
		registerDuplicateWindowListener,
		type DuplicateSnapshot
	} from '$lib/duplicate-window';
	import { DEFAULT_ZOOM, isZoomTarget, loadZoom, registerZoomListeners } from '$lib/zoom';
	import { printFailedMessage, registerPrintListener } from '$lib/print-html';
	import { videoViewMode } from '$lib/video-viewing';
	import {
		loadProvenanceMap,
		type ProvenanceLoad,
		type ProvenanceSegment
	} from '$lib/video-provenance';
	import type { BuiltAnchor } from '../markdown/selection';
	import type { Mark } from '$lib/annotation';
	import '../styles/theme.css';
	import '../styles/app.css';
	import '../styles/markdown.css';
	import '../styles/print.css';

	let showMarks = $state(false);
	let markFilter = $state<MarkFilterMode>('all');
	// 要件#40: 素材パネル(出所)の開閉と、パネルが要る材料。開閉は reload-state に
	// 載せない=毎回閉じて始まる(契約⑪=Q26。マーク一覧と同じ扱い)。
	let showProvenance = $state(false);
	/** 再生位置(秒)。パネルが開いている間だけ VideoViewer から届く(契約⑪)。 */
	let videoPosition = $state(0);
	/** 動画の実尺(秒)。鮮度警告の突き合わせに使う(契約⑩)。 */
	let videoDurationSec = $state<number | null>(null);
	/** サイドカーの取得結果。null =まだ読んでいる途中。 */
	let provenanceLoad = $state<ProvenanceLoad | null>(null);
	// 区間クリックのシークは VideoViewer が持つ(吸着に使うフレーム索引があちらにある)。
	let videoViewer = $state<{ seekToSegmentStart: (segment: ProvenanceSegment) => void } | null>(
		null
	);
	let dialog = $state<{ open: boolean; anchor: BuiltAnchor | null }>({
		open: false,
		anchor: null,
	});
	let diffViewState = $state<{ open: boolean; mark: Mark | null }>({
		open: false,
		mark: null,
	});
	// History picker screen (要件#4): shown instead of the normal body when
	// the app was launched without a path / root argument.
	let rootPicker = $state<{
		open: boolean;
		entries: RootPickerEntry[];
		error: string | null;
	}>({ open: false, entries: [], error: null });
	// 要件#14: 新版の告知バナー。null = 出ていない。ウインドウごとの state
	// なので、閉じるのはこの窓のバナーだけ(他の窓は出たまま)。保存しない
	// ので、次回起動時のチェックでまた出る。
	let updateBanner = $state<UpdateAvailablePayload | null>(null);
	// 要件#22: 読まない経路で表示しているファイル(ラスタ画像・3D モデル=要件#23・
	// 動画=要件#28)の版数。`binary_file_changed` が届くたびに進み、`<img>` の src /
	// ModelViewer が fetch する URI / `<video src>` に乗ってキャッシュを破る。
	// どの URI の版数かを一緒に持つので、
	// 別のファイルへ移れば(uri が一致しなくなり)版数0=素の URI に戻る。
	let binaryVersion = $state<{ uri: string; version: number }>({ uri: '', version: 0 });
	// 要件#10: 起動処理(スナップショット復元 or 起動時引数)が片付いたか。
	// 片付くまでスナップショットを書かない — 復元前の中間状態で復元元を潰さないため。
	let startupSettled = $state(false);

	// --- Explorer pane width (要件#9) ------------------------------------
	// 幅の妥当性(下限200・ウインドウ幅50%の上限)と保存の判定は
	// `$lib/pane-resize` の純関数が唯一の持ち場。ここは「いつ呼ぶか」だけを持つ。
	// 初期値は既定幅 — onMount で保存値に差し替わる。
	let explorerWidth = $state(DEFAULT_PANE_WIDTH);
	let resizingPane = $state(false);
	// 仕切りの位置は Explorer の左端(= .app-body の左端)からの距離で決まる。
	let appBody = $state<HTMLDivElement | null>(null);

	function startPaneResize(event: PointerEvent) {
		const handle = event.currentTarget as HTMLElement;
		// ポインタを捕捉して、ハンドルの外へ速く振ってもドラッグが続くようにする
		// (move / up がこの要素に届くので、window への購読を持たずに済む)。
		handle.setPointerCapture(event.pointerId);
		resizingPane = true;
		event.preventDefault(); // ドラッグ中のテキスト選択を抑止
	}

	function movePaneResize(event: PointerEvent) {
		if (!resizingPane) return;
		const originX = appBody?.getBoundingClientRect().left ?? 0;
		explorerWidth = clampPaneWidth(event.clientX - originX, window.innerWidth);
	}

	function endPaneResize(event: PointerEvent) {
		if (!resizingPane) return;
		resizingPane = false;
		const handle = event.currentTarget as HTMLElement;
		if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
		// 保存はドラッグ確定時のみ。移動中に毎回書くと localStorage への
		// 書き込みがドラッグ回数ぶん走るうえ、途中経過が保存値になる。
		savePaneWidth(explorerWidth);
	}

	// 保存値の復元と、ウインドウ幅の変化への追従。
	// 起動ごと(= 新規ウインドウごと)にこの onMount が走るので、再起動にも
	// 新規ウインドウにも同じ保存値が効く。
	onMount(() => {
		explorerWidth = loadPaneWidth(window.innerWidth);
		const handleWindowResize = () => {
			// ウインドウが縮んだときは上限50%に収め直す。保存はしない —
			// 保存値はユーザーが選んだ幅であって、ウインドウ都合の縮小ではない。
			explorerWidth = clampPaneWidth(explorerWidth, window.innerWidth);
		};
		window.addEventListener('resize', handleWindowResize);
		return () => window.removeEventListener('resize', handleWindowResize);
	});

	// --- Viewer zoom (要件#36) --------------------------------------------
	// 倍率の刻み・上下限・対象ビューアの別・保存と復元は `$lib/zoom` の持ち場。
	// ここは「いつ読むか」と「どこへ当てるか」だけを持つ(要件#9 の幅と同じ整理)。
	// 初期値は既定=等倍 — onMount で保存値(全窓共有のグローバル1値)に差し替わる。
	let zoomLevel = $state(DEFAULT_ZOOM);

	// いま表示しているのがズーム対象のビューアか(契約①⑧)。文書を開いていない
	// (履歴選択画面・EmptyState)ときも対象外で、⌘+ / ⌘− / ⌘0 は何もしない。
	let zoomTarget = $derived(
		windowState.currentDocument !== null &&
			isZoomTarget(detectFileType(windowState.currentDocument.uri))
	);

	// メニュー起点のズーム。Rust 側はフォーカス中の窓へイベントを投げるだけで、
	// 倍率を持つのも保存するのもこちら側(menu-open・duplicate-window と同じ分担)。
	// 購読の解除があるので await を挟まない専用の onMount に分けている。
	onMount(() => {
		zoomLevel = loadZoom();
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void registerZoomListeners({
			isTarget: () => zoomTarget,
			getLevel: () => zoomLevel,
			onChange: (level) => (zoomLevel = level)
		}).then((off) => {
			if (disposed) off();
			else unlisten = off;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	// --- Print (要件#38) ----------------------------------------------------
	// ⌘P の経路(HTML だけ印刷専用ウィンドウ・他は従来のメインフレーム印刷)と
	// 印刷文書の組み立ては `$lib/print-html` の持ち場。ここは「いま何を表示して
	// いるか」を答えるだけ(zoom・duplicate-window と同じ分担)。
	//
	// 文書を開いていない(履歴選択画面・EmptyState)ときは `text` を返す —
	// HTML 以外はどれも同じ従来経路なので、ここでの意味は「印刷窓には回さない」
	// の一言に尽きる。`text` は file-type の未知拡張子のフォールバックでもある。
	let printFileType: FileType = $derived(
		windowState.currentDocument ? detectFileType(windowState.currentDocument.uri) : 'text'
	);

	// 印刷する HTML は画面と同じ材料(生テキストと文書 URI)から作る — 表示中の
	// srcdoc を流用しないのは、紙が倍率非依存(契約⑤)なのに srcdoc には
	// 表示中のズームが焼き込まれているため。ssh リモートでも同じ材料が渡る(契約⑥)。
	function currentHtmlSource(): { content: string; docUri: string } {
		const doc = windowState.currentDocument;
		return { content: doc?.content ?? '', docUri: doc?.uri ?? '' };
	}

	// 購読の解除があるので await を挟まない専用の onMount に分けている。
	onMount(() => {
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void registerPrintListener({
			getFileType: () => printFileType,
			getHtmlSource: currentHtmlSource,
			onError: (err) => alert(printFailedMessage(err))
		}).then((off) => {
			if (disposed) off();
			else unlisten = off;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	function handleRequestAddMark(anchor: BuiltAnchor) {
		dialog = { open: true, anchor };
	}

	async function submitInstruction(instruction: string) {
		const anchor = dialog.anchor;
		const doc = windowState.currentDocument;
		if (!anchor || !doc || !windowState.root) {
			dialog = { open: false, anchor: null };
			return;
		}
		try {
			await marksStore.add({
				rootUri: windowState.root,
				uri: doc.uri,
				anchor,
				instruction,
			});
		} catch (err) {
			alert(`マーク追加に失敗しました: ${err}`);
		}
		dialog = { open: false, anchor: null };
	}

	function cancelInstruction() {
		dialog = { open: false, anchor: null };
	}

	function focusMark(mark: Mark) {
		// Phase 4.1 では URI 一致時に Viewer 内へスクロールするだけの単純実装。
		// MarkPin (gutter pin) 連携は Phase 4.2 以降で本格化。
		if (windowState.currentDocument?.uri.endsWith(mark.file)) {
			const sel = `[data-source-start-line="${mark.anchor.start_line}"]`;
			const el = document.querySelector(sel) as HTMLElement | null;
			el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	}

	type InitWindowResponse = {
		window_id: string;
		root_uri: string;
		entries: Entry[];
		initial_path: string | null;
		version: string;
		needs_root_selection: boolean;
		show_marks: boolean;
		show_changed: boolean;
		/** 複製元の展開ディレクトリ(要件#34)。複製で生まれた窓以外は空。 */
		expanded_dirs: string[];
	};

	type MarkFilterMode = 'all' | 'drift';

	type RootPayload = {
		root_uri: string;
		entries: Entry[];
		document_retained: boolean;
	};

	type FileChangedPayload = {
		uri: string;
		content: string;
		modified: number | null;
	};

	type FileRemovedPayload = {
		uri: string;
	};

	// 要件#22: ラスタ画像の変更通知。本文は載らない(監視は読まない)ので
	// URI だけが届き、再取得は `<img>` の src を変えて行う。
	type BinaryFileChangedPayload = {
		uri: string;
	};

	type DirectoryChangedPayload = {
		root_uri: string;
		entries: Entry[];
	};

	// 要件#14: version は先頭 v を落とした x.y.z(StatusBar と同じ綴りで
	// 出せるように)、url は Releases ページ。
	type UpdateAvailablePayload = {
		version: string;
		url: string;
	};

	/**
	 * Adopt a `set_root` result as the current root and leave the picker.
	 * Shared by the OS folder dialog and the history list so both land in
	 * the same state.
	 */
	function applyRoot(res: RootPayload) {
		windowState.applyRoot(res.root_uri, res.entries, res.document_retained);
		rootPicker = { ...rootPicker, open: false, error: null };
	}

	async function pickFolderAndSetRoot() {
		const selected = await open({
			directory: true,
			multiple: false,
			title: SELECT_FOLDER_DIALOG_TITLE
		});
		if (typeof selected !== 'string') return; // cancelled

		const uri = `file://${selected}`;
		const res = await invoke<RootPayload>('set_root', { uri });
		applyRoot(res);
	}

	/**
	 * Open a folder chosen from the history list. A stale entry (folder
	 * moved or deleted) keeps the picker open with the reason shown, so
	 * the user can pick another one.
	 */
	async function openFromHistory(uri: string) {
		try {
			applyRoot(await openHistoryEntry<RootPayload>(uri));
		} catch (err) {
			rootPicker = { ...rootPicker, error: `フォルダを開けませんでした: ${err}` };
		}
	}

	// 要件#11: File メニューの Open… / Open Folder…。ダイアログ・root の導出
	// (ファイルなら親フォルダ)・コマンド列は `$lib/menu-open` の持ち場で、
	// ここは結果を画面へ移すだけ。履歴記録は set_root 経由で backend が行う
	// (要件#3)ので、ここでは何も記録しない。
	//
	// 購読の解除があるので、await を挟まない専用の onMount に分けている
	// (async な onMount が返す cleanup は Svelte に呼ばれない)。
	onMount(() => {
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void registerMenuOpenListeners<RootPayload, DocumentPayload>({
			onOpened: (opened) => {
				// applyRoot が履歴選択画面(要件#4)も閉じるので、選択中に
				// メニューから開いた場合もそのまま本体へ移る。文書は root 切替の
				// 後に入れる(applyRoot は切替時に現在の文書を落とすため)。
				// スナップショット(要件#10)は windowState を見ている $effect が拾う。
				applyRoot(opened.root);
				// ラスタ画像も文書コマンドを通る(要件#22)ので、ファイルを選んだ
				// ときは常に document が返る。
				if (opened.document) windowState.setDocument(opened.document);
			},
			onError: (err) => {
				alert(openFailedMessage(err));
			}
		}).then((off) => {
			// 登録が終わる前に破棄されていたら、届いた解除関数をその場で使う。
			if (disposed) off();
			else unlisten = off;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	// 要件#34: ウィンドウの複製。複製する内容(root・開いている文書・ツリー展開)は
	// この窓にしかないので、ここで集めて `$lib/duplicate-window` の実行列へ渡す。
	//
	// 履歴選択画面が出ている間は root を null で渡す(契約④)。背後の root は
	// init_window の cwd フォールバックであってユーザーが選んだものではないので、
	// 複製しても意味を持たない — 引数なしの New Window 相当として、複製先でも
	// 履歴選択画面を出す。スナップショット($effect)が同じ理由で書かないのと同じ判断。
	function currentSnapshot(): DuplicateSnapshot {
		return {
			rootUri: rootPicker.open ? null : windowState.root,
			docUri: windowState.currentDocument?.uri ?? null,
			expandedDirs: windowState.expandedDirs
		};
	}

	function reportDuplicateFailure(err: unknown) {
		alert(duplicateWindowFailedMessage(err));
	}

	/**
	 * ツリーの右クリックからの複製(要件#34③)。メニュー起点(下の購読)と
	 * 同じ実行列を通る。新しい窓を作るだけなので、この窓の状態は何も動かない。
	 */
	async function duplicateCurrentWindow() {
		try {
			await duplicateWindow(currentSnapshot());
		} catch (err) {
			reportDuplicateFailure(err);
		}
	}

	// メニュー起点の複製。Rust 側はフォーカス中の窓へイベントを投げるだけで、
	// 集める・呼ぶはこちら側(menu-open と同じ分担)。購読の解除があるので
	// await を挟まない専用の onMount に分けている。
	onMount(() => {
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void registerDuplicateWindowListener({
			getSnapshot: currentSnapshot,
			// 新しい窓が開くだけで、この窓には何も反映しない。
			onOpened: () => {},
			onError: reportDuplicateFailure
		}).then((off) => {
			if (disposed) off();
			else unlisten = off;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	onMount(async () => {
		// Populate the feature-flag store from the shared get_build_info()
		// cache (single IPC). Fire-and-forget — fail-safe defaults hold
		// until it resolves (feature-flags.md §3.5).
		void featureFlags.init();

		// Single round-trip: get root_uri + entries + initial document URI.
		// 起動時の初期値なので root 切替(windowState.applyRoot)ではない —
		// 展開状態はまだ空で、捨てるものが無い。
		const init = await invoke<InitWindowResponse>('init_window');
		windowState.root = init.root_uri;
		windowState.entries = init.entries;
		windowState.version = init.version;
		if (init.show_marks) showMarks = true;
		if (init.show_changed) {
			showMarks = true;
			markFilter = 'drift';
		}

		// 要件#10: reload 前のスナップショットがあれば、起動時引数より優先して復元する
		// (`$lib/reload-state`)。init_window は version などのために常に呼ぶので、
		// 復元時は root の list が1回重複するだけ(docs/reload-state.md §4)。
		const snapshot = loadSnapshot();
		const restored = snapshot
			? await restoreSnapshot<RootPayload, DocumentPayload>(snapshot)
			: null;

		if (snapshot && restored?.ok) {
			// root と文書は restoreSnapshot が backend に反映済み。ここでは画面へ移すだけ。
			windowState.applyRoot(restored.root.root_uri, restored.root.entries, false);
			if (restored.document) windowState.setDocument(restored.document);
			// 展開は applyRoot の後に渡す(applyRoot は root 切替として展開を捨てるため)。
			// 各ディレクトリの子は ExplorerItem が list_dir で読み直す。
			windowState.setExpandedDirs(snapshot.expandedDirs);
		} else {
			// スナップショットが無い・復元できなかった → 従来どおり起動時引数に従う。
			// 復元に失敗したスナップショットは捨てる。復元先が消えている以上、
			// 持ち回っても次の reload でまた同じ失敗をするだけ。
			if (snapshot) clearSnapshot();

			// If there is an initial document, open it (Main starts watch implicitly).
			// ラスタ画像(要件#16 ⑦)だけは読まずに開く — CLI の `vellis photo.png` と
			// ツリーの Shift+クリック(新しいウインドウ)もこの経路を通る。
			if (init.initial_path) {
				windowState.setDocument(await openForDisplay(init.initial_path));
			}

			// 要件#34: 複製で生まれた窓は、複製元の展開ディレクトリを引き継いで開く。
			// root と初期文書の後に渡すのは reload の復元と同じ順序 — 各ディレクトリの
			// 子は ExplorerItem が list_dir で読み直す。複製以外の経路では空。
			if (init.expanded_dirs.length > 0) windowState.setExpandedDirs(init.expanded_dirs);
		}

		// No CLI path or root was provided — show the history picker (要件#4).
		// Until something is chosen the cwd fallback root from init_window stays
		// behind the screen. 復元できたときは出さない(要件#10)。
		if (shouldShowRootPicker(init.needs_root_selection, snapshot, restored?.ok === true)) {
			rootPicker = {
				open: true,
				entries: toPickerEntries(await loadHistory()),
				error: null
			};
		}

		// ここから先の状態変更をスナップショットに残す。
		startupSettled = true;

		// Root change event -- only fired from external IPC (vellis -r).
		// Explorer's set_root uses command return value instead (no event).
		await listen<RootPayload>('root_changed', (e) => {
			windowState.applyRoot(e.payload.root_uri, e.payload.entries, e.payload.document_retained);
		});

		// File content change event (DocumentCoordinator sends content).
		// Rebind is driven by the `currentDocument` $effect above —
		// setDocument updates it and the effect handles the rest.
		await listen<FileChangedPayload>('file_changed', (e) => {
			if (e.payload.uri === windowState.currentDocument?.uri) {
				windowState.setDocument(e.payload);
			}
		});

		// 要件#22: 表示中のラスタ画像・3D モデル(要件#23)がディスク上で変わった。
		// 中身は届かないので表示版数を進め、asset URI を版数付きに変えて取り直させる
		// (画像は `<img src>`・モデルは ModelViewer の fetch)。版数は URI とセットで
		// 持つ — 別のファイルへ移れば版数0の素の URI に戻る。
		await listen<BinaryFileChangedPayload>('binary_file_changed', (e) => {
			if (e.payload.uri !== windowState.currentDocument?.uri) return;
			binaryVersion =
				binaryVersion.uri === e.payload.uri
					? { uri: e.payload.uri, version: binaryVersion.version + 1 }
					: { uri: e.payload.uri, version: 1 };
		});

		// File removed event(ラスタ画像も同じ経路で表示が閉じる=要件#22 ②)
		await listen<FileRemovedPayload>('file_removed', (e) => {
			if (e.payload.uri === windowState.currentDocument?.uri) {
				windowState.clearDocument();
			}
		});

		// Directory listing change event (for Explorer refresh, issue #18).
		// root 直下と展開中サブディレクトリ(要件#18)の両方がここに届く —
		// どちらの一覧かの判定とツリーへの当て方は `$lib/tree-refresh`。
		// 消えたディレクトリの監視解除は ExplorerItem の後始末が担う
		// (ノードが消える=展開の effect が畳まれる)。
		await listen<DirectoryChangedPayload>('directory_changed', (e) => {
			windowState.applyDirectoryEvent(e.payload.root_uri, e.payload.entries);
		});

		// `vellis --marks` / `vellis --changed` from a second invocation
		// while an instance is already running.  The IPC handler emits
		// this to the active window with `{ filter_drift }` set
		// (`docs/ai-collab.md` §9.1).
		await listen<{ filter_drift: boolean } | undefined>('show_marks', (e) => {
			showMarks = true;
			markFilter = e.payload?.filter_drift ? 'drift' : 'all';
		});

		// 要件#14: 新版の告知。Rust 側のポーラーが全ウインドウへ emit するので、
		// この窓は届いたものをそのまま出すだけ(判定は Rust の update_check)。
		// 検知できなかった場合(オフライン・失敗)は何も届かない=何も出ない。
		await listen<UpdateAvailablePayload>('update_available', (e) => {
			updateBanner = e.payload;
		});
	});

	// Build the viewer body whenever the active document changes.
	// `renderForDisplay` dispatches on file type (要件#2): Markdown goes
	// through the unified pipeline, text files are shown verbatim as plain
	// text (index = null), HTML files come back as an iframe body instead
	// (srcdoc, 要件#8). The Viewer is a passive presenter; the rendered
	// html and SourceIndex live in window state so that copy / annotation
	// features can read them without re-rendering. Stale results are dropped
	// inside `setRenderResult` (rendering-engine.md §3.1).
	$effect(() => {
		const doc = windowState.currentDocument;
		if (!doc) return;
		const uri = doc.uri;
		const content = doc.content;
		// 要件#36 ⑥: HTML のズームは srcdoc に焼き込むしかない(sandbox の
		// 不透明オリジンには外から style を差せない)ので、倍率が変われば作り直す。
		// 他の型はここで倍率を読まない = 拡大縮小しても再レンダーは走らない。
		const zoom = detectFileType(uri) === 'html' ? zoomLevel : undefined;
		renderForDisplay(uri, content, zoom).then((result) => {
			windowState.setRenderResult(uri, result);
		});
	});

	// Re-anchor marks for the active document on every content change
	// (open / switch / file_changed).  Listening on currentDocument
	// covers all three because file_changed updates it via setDocument.
	// Backend short-circuits on hash match so opening an untouched file
	// is a cheap no-op (`docs/ai-collab.md` §7).
	$effect(() => {
		const doc = windowState.currentDocument;
		if (!doc || !windowState.root) return;
		marksStore.rebindForFile({
			rootUri: windowState.root,
			uri: doc.uri,
			content: doc.content,
		});
	});

	// --- 素材パネル(要件#40) ------------------------------------------
	// 動画を表示しているか、しているならどの URI と版数付き src か。src は
	// `binary_file_changed` で進む版数を含むので、動画本体が差し替わるたびに別値になる。
	let videoDisplay = $derived.by(() => {
		const doc = windowState.currentDocument;
		if (!doc || windowState.renderedUri !== doc.uri || windowState.renderedVideoSrc === null) {
			return null;
		}
		const version = binaryVersion.uri === doc.uri ? binaryVersion.version : 0;
		return { uri: doc.uri, src: imageSrcWithVersion(windowState.renderedVideoSrc, version) };
	});

	// 素材パネルの対象はインライン再生する動画だけ(契約①)。mkv/avi・ssh の
	// プレースホルダにはボタンもパネルも出さない。
	let provenanceTarget = $derived(
		videoDisplay && videoViewMode(videoDisplay.uri) === 'inline' ? videoDisplay : null
	);

	// 要件#40 契約④⑧: サイドカー(`<動画>.map.json`)を asset 経由で読む。版数付きの
	// src に反応させることで、動画本体の変更検知(要件#22)に連動してマップも読み直す
	// — map.json 単独の監視は持たない(開き直しで拾う=Q16)。
	// `open_document` 系は使わない(窓の DocumentSession を差し替えると、表示中の動画の
	// 監視が外れる=契約④)。
	$effect(() => {
		const target = provenanceTarget;
		if (!target) {
			provenanceLoad = null;
			return;
		}
		void target.src;

		let cancelled = false;
		provenanceLoad = null;
		void loadProvenanceMap(target.uri).then((result) => {
			if (!cancelled) provenanceLoad = result;
		});
		return () => {
			cancelled = true;
		};
	});

	/** 再生位置の受け口。パネルが開いているときだけ VideoViewer へ渡す(契約⑪)。 */
	function handleVideoPosition(sec: number) {
		videoPosition = sec;
	}

	function handleVideoDuration(sec: number | null) {
		videoDurationSec = sec;
	}

	/** 区間クリック。吸着は VideoViewer 側(フレーム索引を持っているのはあちら)。 */
	function seekToSegment(segment: ProvenanceSegment) {
		videoViewer?.seekToSegmentStart(segment);
	}

	// 要件#10: root・開いている文書・ツリー展開のいずれかが変わるたび、
	// reload をまたぐスナップショットを sessionStorage へ残す。3つとも
	// ウインドウ状態にあるので、個々の操作に手を入れず一箇所で拾える。
	// スクロール位置とマーク一覧の開閉(showMarks / markFilter)は対象外
	// — 読まないので、変わっても保存は走らない。
	//
	// 書かない場合が2つある:
	// - 起動処理が終わるまで(復元前の起動時引数の状態で復元元を上書きしてしまう)
	// - 履歴選択画面が出ている間。背後の root は init_window の cwd フォールバックで
	//   あってユーザーが選んだものではない。保存すると次の reload でそれが復元され、
	//   選択画面が出なくなる
	$effect(() => {
		if (!startupSettled || rootPicker.open) return;
		saveSnapshot({
			rootUri: windowState.root,
			docUri: windowState.currentDocument?.uri ?? null,
			expandedDirs: windowState.expandedDirs,
		});
	});
</script>

<div class="app" class:resizing-pane={resizingPane}>
	{#if updateBanner}
		<!-- 要件#14: 本体の上に1行。履歴選択画面のときも同じ位置に出る。 -->
		<UpdateBanner
			version={updateBanner.version}
			url={updateBanner.url}
			onClose={() => (updateBanner = null)}
		/>
	{/if}
	<div class="app-body" bind:this={appBody}>
		{#if rootPicker.open}
			<RootPicker
				entries={rootPicker.entries}
				error={rootPicker.error}
				onSelect={openFromHistory}
				onPickFolder={pickFolderAndSetRoot}
			/>
		{:else}
			<Explorer
				root={windowState.root}
				entries={windowState.entries}
				selectedUri={windowState.currentDocument?.uri}
				width={explorerWidth}
				onDuplicateWindow={duplicateCurrentWindow}
			/>
			<!--
				Explorer と Viewer の仕切り(要件#9)。ドラッグ専用のハンドルで、
				既定幅へ戻す手段(ダブルクリック等)は設けない。
			-->
			<div
				class="pane-divider"
				class:dragging={resizingPane}
				role="separator"
				aria-orientation="vertical"
				aria-label="Explorer の幅を変更"
				title="ドラッグで Explorer の幅を変更"
				onpointerdown={startPaneResize}
				onpointermove={movePaneResize}
				onpointerup={endPaneResize}
				onpointercancel={endPaneResize}
			></div>
			{#if windowState.currentDocument}
				<!-- srcdoc がある=HTML ファイル(要件#8)。生の content は {@html} 経路に載せない -->
				{#if windowState.renderedUri === windowState.currentDocument.uri && windowState.renderedSrcdoc !== null}
					<HtmlViewer srcdoc={windowState.renderedSrcdoc} />
					<!-- imageSrc がある=画像ファイル(要件#16)。srcdoc と同じ形の分岐 -->
				{:else if windowState.renderedUri === windowState.currentDocument.uri && windowState.renderedImageSrc !== null}
					<ImageViewer
						uri={windowState.currentDocument.uri}
						src={imageSrcWithVersion(
							windowState.renderedImageSrc,
							binaryVersion.uri === windowState.currentDocument.uri ? binaryVersion.version : 0
						)}
						source={windowState.currentDocument.content}
					/>
					<!-- modelSrc がある=3D モデル(要件#23)。imageSrc と同じ形の分岐で、
					     版数も同じ `binary_file_changed` の機構に乗る -->
				{:else if windowState.renderedUri === windowState.currentDocument.uri && windowState.renderedModelSrc !== null}
					<!--
						three.js は重い(数百 KB)ので、3D モデルを開いたときだけ読み込む
						(mermaid を図が出たときだけ `import()` するのと同じ整理)。
					-->
					{#await import('../components/ModelViewer.svelte') then module}
						<module.default
							uri={windowState.currentDocument.uri}
							src={imageSrcWithVersion(
								windowState.renderedModelSrc,
								binaryVersion.uri === windowState.currentDocument.uri ? binaryVersion.version : 0
							)}
						/>
					{/await}
					<!-- videoSrc がある=動画(要件#28)。imageSrc と同じ形の分岐で、版数も
					     同じ `binary_file_changed` の機構に乗る。プレースホルダになる
					     mkv/avi・ssh もこの経路を通る(出し分けは VideoViewer の中) -->
				{:else if videoDisplay}
					<!--
						要件#40 追補1(Q31): 素材パネルは動画ペインの**下**に敷く横帯。右に置くと
						動画の表示幅が削られるので、ビューアとパネルを縦に積む。内側の `.video-main` は
						VideoViewer を今までどおり「行方向 flex の子」のまま置くための一枚 —— 縦積みの
						直下だと min-height:auto が効いて動画が縮まず、帯が下へ押し出される。
					-->
					<div class="video-stack">
						<div class="video-main">
							<!--
								要件#40: 素材パネルのトグルと、パネルが要る材料(再生位置・実尺)の
								受け口を足す。位置は**パネルが開いているときだけ**上げる(契約⑪)。
								区間クリックのシークはインスタンス経由で呼ぶ — 吸着に使うフレーム索引を
								持っているのは VideoViewer の側。
							-->
							<VideoViewer
								bind:this={videoViewer}
								uri={videoDisplay.uri}
								src={videoDisplay.src}
								provenanceOpen={showProvenance}
								onToggleProvenance={provenanceTarget
									? () => (showProvenance = !showProvenance)
									: undefined}
								onPositionChange={showProvenance ? handleVideoPosition : undefined}
								onDurationChange={handleVideoDuration}
							/>
						</div>
						<!--
							素材パネル本体(契約②・追補1)。`provenanceTarget` は `videoDisplay` の絞り込み
							なので、真になり得るのはこの枝の中だけ。マーク一覧とは排他にしない —— 並びは
							左からビューア(下に素材)・マーク一覧。
						-->
						{#if showProvenance && provenanceTarget}
							<ProvenancePanel
								videoUri={provenanceTarget.uri}
								load={provenanceLoad}
								position={videoPosition}
								actualDurationSec={videoDurationSec}
								onSeekSegment={seekToSegment}
								onClose={() => (showProvenance = false)}
							/>
						{/if}
					</div>
					<!-- pdfSrc がある=PDF(要件#29)。videoSrc と同じ形の分岐で、版数も
					     同じ `binary_file_changed` の機構に乗る。プレースホルダになる
					     ssh もこの経路を通る(出し分けは PdfViewer の中) -->
				{:else if windowState.renderedUri === windowState.currentDocument.uri && windowState.renderedPdfSrc !== null}
					<PdfViewer
						uri={windowState.currentDocument.uri}
						src={imageSrcWithVersion(
							windowState.renderedPdfSrc,
							binaryVersion.uri === windowState.currentDocument.uri ? binaryVersion.version : 0
						)}
					/>
				{:else}
					<Viewer
						document={windowState.currentDocument}
						html={windowState.renderedUri === windowState.currentDocument.uri
							? windowState.renderedHtml
							: ''}
						index={windowState.renderedUri === windowState.currentDocument.uri
							? windowState.sourceIndex
							: null}
						onRequestAddMark={handleRequestAddMark}
						onToggleMarks={() => (showMarks = !showMarks)}
						marksOpen={showMarks}
						zoom={zoomTarget ? zoomLevel : DEFAULT_ZOOM}
					/>
				{/if}
			{:else}
				<EmptyState />
			{/if}
			{#if showMarks && windowState.root}
				<MarkList
					rootUri={windowState.root}
					filter={markFilter}
					onFilterChange={(f) => (markFilter = f)}
					onSelect={focusMark}
					onShowDiff={(m) => (diffViewState = { open: true, mark: m })}
					onClose={() => (showMarks = false)}
				/>
			{/if}
		{/if}
	</div>
	<StatusBar />
</div>

<InstructionDialog
	open={dialog.open}
	preview={dialog.anchor?.selectedMarkdown ?? ''}
	onSubmit={submitInstruction}
	onCancel={cancelInstruction}
/>

<DiffView
	open={diffViewState.open}
	rootUri={windowState.root}
	mark={diffViewState.mark}
	onClose={() => (diffViewState = { open: false, mark: null })}
/>

<style>
	/*
	 * 動画ビューアと素材パネルの縦積み(要件#40 追補1)。行の中では今までの
	 * VideoViewer と同じ場所を占め(`flex: 1`)、その中を上下に割る。
	 */
	.video-stack {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	/*
	 * 動画側。行方向のままなので VideoViewer の `flex: 1` / `min-width: 0` は
	 * これまでどおり効き、高さは帯を引いた残りに収まる(min-height: 0 = 縮める許可)。
	 */
	.video-main {
		flex: 1;
		min-height: 0;
		display: flex;
	}

	/*
	 * ペインの仕切り(要件#9)。Explorer 側の border-right が見た目の線で、
	 * この要素は掴みやすさのための当たり判定。掴んでいる間だけ色が付く。
	 */
	.pane-divider {
		flex: 0 0 auto;
		width: 5px;
		margin-left: -2px; /* 境界線をまたいで置き、線の見た目を動かさない */
		cursor: col-resize;
		background-color: transparent;
		touch-action: none; /* ドラッグがスクロールに取られないように */
	}

	.pane-divider:hover,
	.pane-divider.dragging {
		background-color: var(--color-border);
	}

	/* ドラッグ中はポインタがどこにあってもカーソルと選択状態を固定する。 */
	.app.resizing-pane {
		cursor: col-resize;
		user-select: none;
	}
</style>
