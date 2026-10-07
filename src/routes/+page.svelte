<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import Explorer from '../components/Explorer.svelte';
	import FindInFolder from '../components/FindInFolder.svelte';
	import RecentFiles from '../components/RecentFiles.svelte';
	import GoToBar from '../components/GoToBar.svelte';
	import Viewer from '../components/Viewer.svelte';
	import HtmlViewer from '../components/HtmlViewer.svelte';
	import ImageViewer from '../components/ImageViewer.svelte';
	import VideoViewer from '../components/VideoViewer.svelte';
	import AudioViewer from '../components/AudioViewer.svelte';
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
	import { getCurrentWindow } from '@tauri-apps/api/window';
	// `~` の展開(要件#60 契約②・追補c)。`core:default` に含まれる口なので
	// capability も Rust も無改変で、依存も増えない。
	import { homeDir } from '@tauri-apps/api/path';
	import { windowState, type DocumentPayload, type Entry } from '../stores/window-state.svelte';
	import { marksStore } from '../stores/marks.svelte';
	import { featureFlags } from '$lib/flags.svelte';
	import { detectFileType, renderForDisplay, type FileType } from '$lib/file-type';
	import { openForDisplay, openInitialDocument } from '$lib/open-document';
	import { imageSrcWithVersion } from '$lib/image-watch';
	import {
		DEFAULT_PANE_WIDTH,
		clampPaneWidth,
		loadPaneWidth,
		savePaneWidth
	} from '$lib/pane-resize';
	import {
		initWindowOrPicker,
		loadHistory,
		openFolderFailedMessage,
		openHistoryEntry,
		pickFolderAndSetRoot,
		toPickerEntries,
		versionAfterFailedInit,
		type RootPickerEntry
	} from '$lib/root-picker';
	import { getBuildInfo } from '$lib/buildInfo';
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
	import { openInNewWindow, openInNewWindowFailedMessage } from '$lib/open-in-new-window';
	import { newTabFailedMessage, registerNewTabListener } from '$lib/new-tab';
	import type { NewWindowAction } from '$lib/context-menu';
	import { MENU_EDIT_EVENT } from '$lib/document-edit';
	import { MENU_FIND_EVENT } from '$lib/find-in-document';
	import { MENU_FIND_IN_FOLDER_EVENT, shouldShowFindInFolder } from '$lib/find-in-folder';
	import { MENU_GO_TO_EVENT, revealPath } from '$lib/go-to-path';
	import { MENU_RECENT_FILES_EVENT, ancestorDirs, shouldShowRecentFiles } from '$lib/recent-files';
	import { SETTINGS_CHANGED_EVENT, reloadTree } from '$lib/settings';
	import { confirmDiscardEdits } from '$lib/edit-guard';
	import { handleCloseRequested } from '$lib/close-window';
	import { MENU_SAVE_EVENT, saveDocument } from '$lib/save-document';
	import { DEFAULT_ZOOM, isZoomTarget, loadZoom } from '$lib/zoom';
	import {
		loadExplorerZoom,
		nextPointerRegion,
		regionOf,
		registerRoutedZoomListeners,
		resolveZoomTarget,
		type ZoomRegion
	} from '$lib/zoom-target';
	import { isPrintAvailable, printFailedMessage, registerPrintListener } from '$lib/print-html';
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

	// --- Explorer zoom (要件#63) ------------------------------------------
	// ツリーの倍率は本文とは別に持つ。表示中の倍率は窓(=タブ)ごとにこのページの
	// メモリにあり、保存値(全窓共有)は onMount で1回だけ読む — 他の窓の書き込みは
	// 追いかけない(契約7)。判別・振り分け・保存は `$lib/zoom-target` の持ち場。
	let explorerZoomLevel = $state(DEFAULT_ZOOM);

	// 最後にポインタが入った領域(契約3)。押した時点で読むだけなので $state にしない。
	// 未確定(null)は本文側として扱われる。
	let pointerRegion: ZoomRegion | null = null;

	// Explorer が出ている画面か。履歴選択画面ではツリーが無いので本文側に倒す(契約3)。
	let explorerShown = $derived(!rootPicker.open);

	// ポインタが領域に入るたびに「最後の領域」を更新する。pointerover は要素に入った
	// ときだけ発火するので pointermove より軽い。仕切り・ステータスバー・更新バナーは
	// 目印が無い(null)ので直前を保つ。窓の外へ出ても pointerover は来ないので保たれる。
	// 捕獲段階で聞くのは、途中の要素が伝播を止めても取りこぼさないため。
	onMount(() => {
		const trackPointer = (event: PointerEvent) => {
			const hit = regionOf(event.target instanceof Element ? event.target : null);
			pointerRegion = nextPointerRegion(pointerRegion, hit);
		};
		document.addEventListener('pointerover', trackPointer, true);
		return () => document.removeEventListener('pointerover', trackPointer, true);
	});

	// メニュー起点のズーム。Rust 側はフォーカス中の窓へイベントを投げるだけで、
	// 倍率を持つのも保存するのもこちら側(menu-open・duplicate-window と同じ分担)。
	// 要件#63: 押した時点のポインタの領域で本文とツリーのどちらを動かすかを決める。
	// 本文側の意味論は要件#36 のまま(非対象ビューアでは no-op・頭打ちなら書かない・
	// 保存キー vellis.viewer-zoom)。本文側が非対象でもツリーへは回さない(契約4)。
	// 購読の解除があるので await を挟まない専用の onMount に分けている。
	onMount(() => {
		zoomLevel = loadZoom();
		explorerZoomLevel = loadExplorerZoom();
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void registerRoutedZoomListeners({
			getTarget: () => resolveZoomTarget({ region: pointerRegion, explorerShown }),
			isViewerZoomable: () => zoomTarget,
			getViewerLevel: () => zoomLevel,
			getExplorerLevel: () => explorerZoomLevel,
			onViewerChange: (level) => (zoomLevel = level),
			onExplorerChange: (level) => (explorerZoomLevel = level)
		}).then((off) => {
			if (disposed) off();
			else unlisten = off;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	// --- 文書内検索(要件#54) ----------------------------------------------
	// 検索そのものは Viewer の中で完結する(バー・一致・ハイライト)。ここが持つのは
	// **html の閲覧中だけの回り道**: そのときの画面は `HtmlViewer` の sandbox された
	// iframe で、Viewer はまだマウントされていない ―― ⌘F を受ける相手が居ない。
	// そこで ⌘F をここでも受け、複製面を持つ Viewer へ切り替えてから、その ⌘F を
	// `findRequest` で渡す(要件#54 契約①②)。閲覧の iframe・sandbox・CSP には
	// 触れない(要件#8・#53 契約①の継承)。

	/** html の閲覧中に ⌘F が来て、複製面(Viewer)へ切り替えているか。 */
	let htmlFindOpen = $state(false);

	/** Viewer 側で検索バーが開いているか(閉じる操作は向こうにしかない)。 */
	let viewerFindOpen = $state(false);

	/**
	 * Viewer へ渡す「今の ⌘F」。0 =要求なしで、進んだときだけ検索バーが開く。
	 * 切り替えの結果として Viewer が**生まれる**ので、初回も 0 → 1 の前進で伝わる。
	 */
	let findRequest = $state(0);

	/**
	 * `findRequest` と一緒に Viewer へ渡す語(要件#55 契約⑦)。フォルダ横断検索の
	 * 結果から開いたときだけ入り、それ以外の前進(⌘F の回り道・文書の切り替え)では
	 * 空に戻す=従来どおり語に触らない。
	 */
	let findInitialQuery = $state('');

	/**
	 * `findInitialQuery` と一緒に Viewer へ渡す番目(0 始まり・要件#55 追補b)。
	 * 結果から開いたときだけクリックした一致の番目が入り、それ以外の前進では 0。
	 */
	let findInitialIndex = $state(0);

	function handleMenuFind() {
		if (windowState.editMode !== 'view') return;
		const doc = windowState.currentDocument;
		if (!doc || detectFileType(doc.uri) !== 'html') return;
		htmlFindOpen = true;
		findInitialQuery = '';
		findInitialIndex = 0;
		findRequest += 1;
	}

	/** 検索バーが閉じたら html は閲覧の iframe へ戻す。 */
	function handleFindOpenChange(open: boolean) {
		viewerFindOpen = open;
		if (open) return;
		htmlFindOpen = false;
		findRequest = 0;
	}

	// 要件#54 契約⑤: 別の文書を開いても検索バーは開いたまま。html へ移ったときは
	// 複製面の側で続ける(iframe には探せる文字が無い)ので、回り道を張り直す。
	// バーが閉じているなら回り道も畳んで、閲覧は素の iframe へ戻す。
	$effect(() => {
		const uri = windowState.currentDocument?.uri;
		untrack(() => {
			if (uri && viewerFindOpen && detectFileType(uri) === 'html') {
				htmlFindOpen = true;
				findInitialQuery = '';
				findInitialIndex = 0;
				findRequest += 1;
				return;
			}
			htmlFindOpen = false;
			findRequest = 0;
		});
	});

	// --- フォルダ横断検索(要件#55) ------------------------------------------
	// 走査は Rust の `search_in_folder`、パネル(入力・結果・世代番号)は
	// `FindInFolder.svelte`。ここが持つのは「いつパネルを出すか」(⌘⇧F・root の有無)と、
	// 結果から文書を開いた後に**同じ語で要件#54 の検索を起動する**口だけ。
	// パネルはウインドウ単位・揮発で、左ペインの Explorer と入れ替わる(Explorer は無改変)。

	/** 左ペインに検索パネルを出しているか(false = Explorer)。 */
	let findInFolderOpen = $state(false);

	/** root が無い(履歴選択画面)ときは出さない。root が戻れば出ていた方が戻る。 */
	let showFindInFolder = $derived(
		findInFolderOpen && shouldShowFindInFolder(windowState.root, rootPicker.open)
	);

	/**
	 * 結果から開いた文書で、レンダリングが済むのを待っている #54 の起動(契約⑦)。
	 * Viewer は表示テキスト(`html`)が届くまで検索バーを出せないので、その文書の
	 * レンダリング結果が揃ってから `findRequest` を進める。
	 */
	let pendingFolderFind = $state<{ uri: string; query: string; index: number } | null>(null);

	async function handleMenuFindInFolder() {
		if (!shouldShowFindInFolder(windowState.root, rootPicker.open)) return;
		findInFolderOpen = true;
		await tick();
		document.querySelector<HTMLInputElement>('[data-testid="find-in-folder-input"]')?.focus();
	}

	function handleFolderResultOpened(uri: string, query: string, index: number) {
		pendingFolderFind = { uri, query, index };
	}

	$effect(() => {
		const pending = pendingFolderFind;
		if (!pending) return;
		const current = windowState.currentDocument?.uri;
		const rendered = windowState.renderedUri;
		untrack(() => {
			// 待っている間に別の文書へ移った=この起動はもう要らない。
			if (current !== pending.uri) {
				pendingFolderFind = null;
				return;
			}
			if (rendered !== pending.uri) return;
			pendingFolderFind = null;
			// 1 拍おく: 同じ文書を開き直したときは、上の「別の文書を開いた」effect が
			// 同じ flush で `findRequest` を 0 へ戻す。同じ flush の中で進め直すと
			// Viewer からは前進に見えないので、0 が届いた後で進める。
			void tick().then(() => {
				if (windowState.currentDocument?.uri !== pending.uri) return;
				// html の閲覧中は Viewer が居ないので、⌘F と同じ回り道(複製面)へ切り替える。
				if (windowState.editMode === 'view' && detectFileType(pending.uri) === 'html') {
					htmlFindOpen = true;
				}
				findInitialQuery = pending.query;
				findInitialIndex = pending.index;
				findRequest += 1;
			});
		});
	});

	// --- パスを名指しして跳ぶ(要件#60) ------------------------------------
	// 入力の解釈・root 配下判定・解決・跳躍は `$lib/go-to-path` の持ち場(純関数と、
	// 手段を注入して動く `revealPath`)。ここが持つのは「いつバーを出すか」と
	// 「どの手段を渡すか」だけで、バーそのものは `GoToBar.svelte`
	// (ズーム・印刷・複製と同じ分担)。今の窓の root は**どの場合も変えない**。

	/** Go to バーを出しているか。ウインドウ単位・揮発(閉じれば値も消える=契約①)。 */
	let goToOpen = $state(false);

	/** 直前の Go が「無い」で終わったか(契約⑥)。バーの表示欄がこれを映す。 */
	let goToNotFound = $state(false);

	/** 直前の Go がリンク切れに当たって止まったか(要件#70 追補b)。「無い」より優先して映す。 */
	let goToBrokenLink = $state(false);

	/** 入力欄の実体。⇧⌘G の再送でフォーカスを戻して全選択する(契約①)。 */
	let goToInputEl = $state<HTMLInputElement | undefined>(undefined);

	/** バーで IME 変換中か。変換中の Esc は IME に委ねる(契約⑦)。 */
	let goToComposing = $state(false);

	function focusGoToInput() {
		goToInputEl?.focus();
		goToInputEl?.select();
	}

	/**
	 * File メニュー「Go to Path…」(⇧⌘G)を受ける(契約①)。
	 *
	 * **root が決まっているときだけ出す** —— 履歴選択画面(要件#4)が出ている間は
	 * 跳ぶ先の root が無い。**文書が開いていなくても出す** —— Go to は文書ではなく
	 * ツリーに効く操作で、空の閲覧面のときこそ使い道がある。
	 */
	async function handleMenuGoTo() {
		if (!windowState.root || rootPicker.open) return;
		if (goToOpen) {
			// 既に出ているときは入力欄へフォーカスを戻して現在の値を全選択する。
			focusGoToInput();
			return;
		}
		goToNotFound = false;
		goToBrokenLink = false;
		goToOpen = true;
		await tick();
		focusGoToInput();
	}

	/** Esc / Close(契約⑦)。閉じれば not-found の表示も入力した値も消える。 */
	function closeGoTo() {
		if (!goToOpen) return;
		// フォーカスは閲覧面へ戻す(入力欄はこの直後に消える)。
		goToInputEl?.blur();
		goToOpen = false;
		goToNotFound = false;
		goToBrokenLink = false;
		goToComposing = false;
	}

	/**
	 * 跳んだ先の行まで運ぶ(契約⑤)。展開が DOM に反映されてから呼ぶ。
	 * ツリーの行は `title` に自分の URI を持っている(`ExplorerItem`)ので、
	 * 行そのものはそこから引ける。要件#54 の現在一致と同じ呼び方で運ぶ。
	 */
	function scrollTreeItemIntoView(uri: string) {
		for (const row of document.querySelectorAll<HTMLElement>('.explorer-item')) {
			if (row.title !== uri) continue;
			row.scrollIntoView({ block: 'center', behavior: 'auto' });
			return;
		}
	}

	/**
	 * ⏎ / Go(契約④⑤⑤'⑥)。打たれた1行をそのまま `revealPath` へ渡し、手段だけを
	 * 与える —— 降りるのは既存の `list_dir`、開くのはツリーのクリックと同じ
	 * `openForDisplay`、新しい窓は要件#59 と同じ `openInNewWindow`。
	 *
	 * 跳べたらバーを閉じてその行まで運ぶ。「無い」ときは `notFound` が立つだけで、
	 * root も文書もツリーも動かず、バーは開いたまま(打ち直せる)。
	 */
	async function runGoTo(raw: string) {
		goToNotFound = false;
		goToBrokenLink = false;
		// 跳んだ先(ツリーの行へ運ぶ URI)と、新しい窓が開いたか。
		let revealedUri: string | null = null;
		let openedWindow = false;
		try {
			await revealPath(raw, {
				rootUri: windowState.root,
				listDir: (uri) => invoke<Entry[]>('list_dir', { uri }),
				open: async (uri) => {
					windowState.setDocument(await openForDisplay(uri));
					revealedUri = uri;
				},
				newWindow: async (args) => {
					// 要件#59 と同じ実行列(引数は `{ path, root, expandedDirs: [] }`)。
					const label = await openInNewWindow({
						command: 'new-window',
						path: args.path,
						root: args.root
					});
					openedWindow = true;
					return label;
				},
				setExpandedDirs: (uris) => windowState.setExpandedDirs(uris),
				getExpandedDirs: () => windowState.expandedDirs,
				setChildEntries: (uri, entries) => windowState.setChildEntries(uri, entries),
				selectTreeItem: (uri) => {
					windowState.selectTreeItem(uri);
					revealedUri = uri;
				},
				notFound: () => (goToNotFound = true),
				// リンク切れは open せずバーの表示欄で伝える(要件#70 追補b=生のエラー文の alert を出さない)。
				brokenLink: () => (goToBrokenLink = true),
				// 要件#48 契約④: この窓で別のファイルを開くと編集は消える(root 外の
				// 新しい窓では聞かない=契約⑤'。判断は revealPath の側にある)。
				confirmDiscard: confirmDiscardEdits,
				detectFileType,
				// 要件#59 と同じ失敗通知。窓が開かない失敗には OS 側の手応えが無い。
				onNewWindowFailed: (err) => alert(openInNewWindowFailedMessage(err)),
				// `~` の展開先(契約②・追補c)。`homeDir()` が返すのは絶対パスなので
				// `file://` を前置して URI にする —— 生文字列のまま繋ぐのは
				// `menu-open.ts` の `toUri` と同じ規約で、percent-encode すると root や
				// 履歴との比較が食い違う。ssh の root では `revealPath` がそもそも
				// 呼ばない(追補c (t))。
				homeDir: async () => `file://${await homeDir()}`
			});
		} catch (err) {
			// 開く側が落ちても今の窓は生きたまま。バーは開いたままにして打ち直させる。
			alert(`Could not go to the path: ${err}`);
			return;
		}
		const revealed = revealedUri as string | null;
		if (revealed === null && !openedWindow) return;
		closeGoTo();
		if (revealed === null) return;
		// 展開が DOM に反映されてから運ぶ(行はまだ生えていない)。
		await tick();
		scrollTreeItemIntoView(revealed);
	}

	// --- 最近開いたファイル(要件#64) ----------------------------------------
	// 記録は Rust の `open_in_window`(開く経路はすべてそこを通る)、区画(開閉・高さ・
	// 一覧・クリック)は `RecentFiles.svelte`、開閉と高さの保存は `$lib/recent-files-section`。
	// ここが持つのは「区画をどこに積むか」(Explorer の下・検索パネルの間は隠す)と、
	// Command + Shift + R の受け口と、区画から開いた後にツリーのその行を見せる口だけ。

	/** 区画の実体(Go メニューから「開いて先頭の行へフォーカス」を頼む相手)。 */
	let recentFilesSection = $state<ReturnType<typeof RecentFiles> | undefined>(undefined);

	/** 左ペイン(Explorer と区画を縦に積む器)の高さ。区画の高さの上限の材料。 */
	let explorerPaneHeight = $state(0);

	/** 区画を出すか(root があり・履歴選択画面でなく・検索パネルを出していない)。 */
	let showRecentFiles = $derived(
		shouldShowRecentFiles(windowState.root, rootPicker.open, findInFolderOpen)
	);

	/**
	 * Go メニュー「Recent Files」(Command + Shift + R・契約5)。root が無い・履歴選択画面
	 * なら何もしない。検索パネルを出していたら閉じて Explorer と区画に戻してから
	 * (起案時判断 (l))、区画を開いて先頭の行へフォーカスを移す。
	 */
	async function handleMenuRecentFiles() {
		if (!shouldShowRecentFiles(windowState.root, rootPicker.open, false)) return;
		if (findInFolderOpen) {
			findInFolderOpen = false;
			await tick();
		}
		await recentFilesSection?.reveal();
	}

	/**
	 * 区画からこの窓に開いた後(契約7): 祖先フォルダを展開に足し、描画を待ってツリーの
	 * その行へ運ぶ(要件#60 の Go to が跳んだ後と同じ)。展開直後のツリーには子の行が
	 * まだ無いので、まだ読んでいない祖先の子を先に読んでおく(`revealPath` と同じ)。
	 * 読めない祖先があれば、そこまでで止める(開いた文書はそのまま)。
	 */
	async function handleRecentFileOpened(uri: string) {
		const root = windowState.root;
		const ancestors = ancestorDirs(uri, root);
		for (const dir of ancestors) {
			if (windowState.childEntries[dir]) continue;
			try {
				windowState.setChildEntries(dir, await invoke<Entry[]>('list_dir', { uri: dir }));
			} catch {
				break;
			}
		}
		// 読んでいる間に root が変わった(↑ など)なら、もう運ぶ先が無い。
		if (windowState.root !== root) return;
		const expanded = [...windowState.expandedDirs];
		for (const dir of ancestors) if (!expanded.includes(dir)) expanded.push(dir);
		windowState.setExpandedDirs(expanded);
		await tick();
		scrollTreeItemIntoView(uri);
	}

	/**
	 * 契約⑦: Esc の宛先。Go to バーが開いていれば**バーが先に食う**(バーは編集より
	 * 手前の一時 UI)。編集の破棄より先に決着させるため `document` の capture 段で
	 * 受けて後段へ渡さない —— 要件#54 の検索バーとまったく同じ形で、`Viewer` 側も
	 * `goToOpen` を見て譲るので、登録順に依らず結論が同じになる。
	 *
	 * IME の変換中の Esc は IME に委ねる(閉じない)。
	 */
	$effect(() => {
		if (!goToOpen) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (e.isComposing || goToComposing) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			closeGoTo();
		};
		document.addEventListener('keydown', onKeyDown, true);
		return () => {
			document.removeEventListener('keydown', onKeyDown, true);
		};
	});

	// --- Print (要件#38) ----------------------------------------------------
	// ⌘P の経路(HTML は印刷専用ウィンドウ・PDF はファイルそのもの=追補g・他は
	// 従来のメインフレーム印刷)と印刷文書の組み立ては `$lib/print-html` の持ち場。
	// ここは「いま何を表示しているか」を答えるだけ(zoom・duplicate-window と同じ分担)。
	//
	// 文書を開いていない(履歴選択画面・EmptyState)ときは `text` を返す —
	// ここでの意味は「印刷窓にも PDF の経路にも回さない」の一言に尽きる。
	// `text` は file-type の未知拡張子のフォールバックでもある。
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

	// 文書を開いていない窓(履歴選択画面・空の状態)では File > Print… を無効にし、
	// ⌘P でも印刷ダイアログを開かない(要件#38 追補f・backlog 251)。メニューは
	// アプリ全体で1つなので、この窓は自分の状態を本体へ知らせるだけで、前面の窓に
	// 合わせて項目を切り替えるのは本体(前面の窓が変わったときも本体が当て直す)。
	// 本体の既定は「開いていない」なので初期値も1回知らせる($effect の初回実行)。
	// 失敗は Print… の灰色が古いままになるだけ(購読側の canPrint が止める)なので黙る。
	const printAvailable = $derived(isPrintAvailable(windowState.currentDocument, rootPicker.open));
	$effect(() => {
		const available = printAvailable;
		invoke('set_print_available', { available }).catch(() => {});
	});

	// 購読の解除があるので await を挟まない専用の onMount に分けている。
	onMount(() => {
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void registerPrintListener({
			getFileType: () => printFileType,
			getHtmlSource: currentHtmlSource,
			// PDF はファイルそのものを印刷する(要件#38 追補g)。canPrint が先に
			// 「文書あり」を確かめるので、ここで空になるのは行き違いのときだけ。
			getDocumentUri: () => windowState.currentDocument?.uri ?? '',
			canPrint: () => isPrintAvailable(windowState.currentDocument, rootPicker.open),
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

	// --- 明示保存と編集の関門(要件#48) ----------------------------------
	// ⌘S / File > Save。Rust 側はフォーカス中の窓へ「保存したい」と投げるだけで、
	// 何を保存するか(編集中か・バッファの中身)を知っているのはこの窓
	// (Open… / Print… / ズームと同じ分担)。自動保存は無い(契約⑤)。
	//
	// 保存するのは編集中で、かつ変更があるときだけ。閲覧中の ⌘S は何もしない —
	// 同じ内容を書き戻せば mtime だけが動き、監視・スナップショット・drift 検知が
	// 空振りする。
	async function saveCurrentEdits() {
		const doc = windowState.currentDocument;
		if (!doc || windowState.editMode !== 'edit' || !windowState.dirty) return;
		const buffer = windowState.editBuffer;
		if (buffer === null) return;
		try {
			await saveDocument(doc.uri, buffer);
		} catch (err) {
			alert(`Could not save: ${err}`);
		}
	}

	// Edit メニュー「Edit」(⌘E)= 閲覧⇄編集のトグル(契約③・追補b)。本文の
	// ダブルクリックと並ぶもう1つの明示操作で、html 種別にとっては唯一の入口
	// (閲覧中の html は HtmlViewer の iframe の中にあり、本文のダブルクリックが
	// アプリまで届かない)。編集に入れない文書では beginEdit が false を返して
	// 何も起きない。
	async function toggleEditMode() {
		if (windowState.editMode !== 'edit') {
			windowState.beginEdit();
			return;
		}
		// 閲覧へ戻る=編集バッファを捨てる。保存していない変更があるときだけ聞く
		// (`confirmDiscardEdits` は保存 / 破棄まで済ませてから編集を畳む。
		// キャンセルなら編集中のまま)。
		if (windowState.dirty) {
			await confirmDiscardEdits();
			return;
		}
		windowState.endEdit();
	}

	// 購読の解除があるので await を挟まない専用の onMount に分けている。
	onMount(() => {
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void Promise.all([
			listen(MENU_SAVE_EVENT, () => {
				void saveCurrentEdits();
			}),
			listen(MENU_EDIT_EVENT, () => {
				void toggleEditMode();
			}),
			// 要件#54 契約①: html の閲覧中だけの回り道(上の handleMenuFind)。
			// markdown / text の ⌘F は Viewer が自分で受ける。
			listen(MENU_FIND_EVENT, () => {
				handleMenuFind();
			}),
			// 要件#60 契約①: ⇧⌘G で Go to バーを出す。root が決まっていない窓
			// (履歴選択画面)は何も起こさない — 跳ぶ先が無い。
			listen(MENU_GO_TO_EVENT, () => {
				void handleMenuGoTo();
			}),
			// 要件#55 契約①: ⌘⇧F で左ペインに検索パネル。root が無ければ何もしない。
			listen(MENU_FIND_IN_FOLDER_EVENT, () => {
				void handleMenuFindInFolder();
			}),
			// 要件#64 契約5: Command + Shift + R で Explorer の下の Recent Files の区画を開いて
			// 先頭の行へフォーカス。root が無い・履歴選択画面なら何もしない。
			listen(MENU_RECENT_FILES_EVENT, () => {
				void handleMenuRecentFiles();
			}),
		]).then((offs) => {
			const off = () => offs.forEach((f) => f());
			if (disposed) off();
			else unlisten = off;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	// 要件#48 契約④: dirty のまま閉じようとしたら聞く。判断の実体は
	// `$lib/close-window` の `handleCloseRequested`(ここは購読の管理だけ)。
	onMount(() => {
		let unlisten: (() => void) | null = null;
		let disposed = false;
		const appWindow = getCurrentWindow();
		void appWindow
			.onCloseRequested((event) => handleCloseRequested(event, appWindow))
			.then((off) => {
				if (disposed) off();
				else unlisten = off;
			});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	// 要件#65 契約7: Vellis で設定ファイル(除外リスト)を保存したら、Rust が全窓へ
	// `settings_changed` を送る。除外の判定は Rust の一覧に当たっているので、root と
	// 展開中のフォルダを `list_dir` で読み直して当て直すだけでツリーが変わる
	// (当て方は監視の `directory_changed` と同じ=展開状態は保つ)。警告は Rust が出す。
	// 購読の解除があるので await を挟まない専用の onMount に分けている。
	onMount(() => {
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void listen(SETTINGS_CHANGED_EVENT, () => {
			void reloadTree(windowState.root, windowState.expandedDirs, {
				listDir: (uri) => invoke<Entry[]>('list_dir', { uri }),
				apply: (uri, entries) => windowState.applyDirectoryEvent(uri, entries)
			});
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
			alert(`Could not add the mark: ${err}`);
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

	/**
	 * 履歴選択画面の「Select Folder…」。手順(編集の始末 → ダイアログ → `set_root`)は
	 * `$lib/root-picker` の持ち場。開けなかったフォルダは履歴から開けなかったときと
	 * 同じ画面の中の注記にして、選択画面のまま選び直せるようにする(要件#71 契約3)。
	 */
	async function selectFolderFromPicker() {
		const outcome = await pickFolderAndSetRoot({
			// 要件#48 契約④: root を変えると編集は持ち越せない。選ばせる前に聞く。
			confirmDiscard: confirmDiscardEdits,
			pickFolder: async () => {
				const selected = await open({
					directory: true,
					multiple: false,
					title: SELECT_FOLDER_DIALOG_TITLE
				});
				return typeof selected === 'string' ? selected : null; // 非文字列=取消
			},
			setRoot: (uri) => invoke<RootPayload>('set_root', { uri })
		});
		if (outcome.kind === 'applied') applyRoot(outcome.root);
		else if (outcome.kind === 'failed') rootPicker = { ...rootPicker, error: outcome.message };
	}

	/**
	 * Open a folder chosen from the history list. A stale entry (folder
	 * moved or deleted) keeps the picker open with the reason shown, so
	 * the user can pick another one.
	 */
	async function openFromHistory(uri: string) {
		// 要件#48 契約④: 履歴からの root 切替も編集を捨てる操作。
		if (!(await confirmDiscardEdits())) return;
		try {
			applyRoot(await openHistoryEntry<RootPayload>(uri));
		} catch (err) {
			rootPicker = { ...rootPicker, error: openFolderFailedMessage(err) };
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
			// 要件#48 契約④: Open… / Open Folder… は root も文書も差し替えるので、
			// ダイアログを出す前に編集の始末を聞く。
			canProceed: confirmDiscardEdits,
			onOpened: (opened) => {
				// applyRoot が履歴選択画面(要件#4)も閉じるので、選択中に
				// メニューから開いた場合もそのまま本体へ移る。文書は root 切替の
				// 後に入れる(applyRoot は切替時に現在の文書を落とすため)。
				// スナップショット(要件#10)は windowState を見ている $effect が拾う。
				applyRoot(opened.root);
				// ラスタ画像も文書コマンドを通る(要件#22)ので、ファイルを選んで
				// 開けたときは document が返る。root は切り替わったのに文書が開け
				// なかったときは null で届き、root だけを画面に移す(要件#71 追補b(2)。
				// 続けて onError が呼ばれる)。
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

	/**
	 * ツリーの右クリックからの「Open in New Window」(要件#59)。計画は純関数が
	 * 決めてあるので、ここは実行して失敗を伝えるだけ。新しい窓を作るだけなので、
	 * この窓の状態(root・開いている文書・展開・未保存の編集)は何も動かない
	 * — 確認ダイアログも出さない(契約④)。
	 */
	async function openPlanInNewWindow(plan: NewWindowAction) {
		try {
			await openInNewWindow(plan);
		} catch (err) {
			alert(openInNewWindowFailedMessage(err));
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

	// 要件#62: File ▸ New Tab(Command + T)。複製と同じく、今の窓の root・展開は
	// ここにしかないので集めて `$lib/new-tab` の実行列へ渡す(文書は引き継がない)。
	// 履歴選択画面では currentSnapshot が root を null にするので何もしない。
	onMount(() => {
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void registerNewTabListener({
			getSnapshot: currentSnapshot,
			// 新しいタブが開くだけで、この窓(タブ)には何も反映しない。
			onOpened: () => {},
			onError: (err) => alert(newTabFailedMessage(err))
		}).then((off) => {
			if (disposed) off();
			else unlisten = off;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	// 要件#62 契約8: タブの見出し=開いている文書のファイル名(無ければ root フォルダ名)。
	// 文書を開く・閉じる・消えるたびに Rust へ伝え、NSWindow の tab.title を差し替える
	// (窓タイトルは root 名のまま=要件#17)。$derived で値が変わったときだけ呼ぶ
	// (同じ文書の再読み込みでは呼ばない)。失敗は見出しが古いままになるだけなので黙る。
	const tabTitleRoot = $derived(rootPicker.open ? null : windowState.root || null);
	const tabTitleDoc = $derived(windowState.currentDocument?.uri ?? null);
	$effect(() => {
		const root = tabTitleRoot;
		const docUri = tabTitleDoc;
		invoke('set_tab_title', { root, docUri }).catch(() => {});
	});

	onMount(async () => {
		// Populate the feature-flag store from the shared get_build_info()
		// cache (single IPC). Fire-and-forget — fail-safe defaults hold
		// until it resolves (feature-flags.md §3.5).
		void featureFlags.init();

		// Single round-trip: get root_uri + entries + initial document URI.
		// 要件#71 追補b(1)(backlog 278): root そのものを開けない(消えた・ssh に届かない)と
		// init_window は失敗する。そのまま投げると onMount が止まって真っ白な窓になるので、
		// 失敗は履歴選択画面の注記(`Could not open the folder: <理由>`)にして、下の購読の
		// 登録と起動の完了まで進める。
		const windowInit = await initWindowOrPicker({
			initWindow: () => invoke<InitWindowResponse>('init_window')
		});
		// 要件#71 追補a(1): 最初の文書が開けなかったときの文言(alert は購読の登録のあとに出す)。
		// コールバックの中で代入するので、型を null に絞らせない。
		let startupOpenFailure = null as string | null;

		if (windowInit.kind === 'failed') {
			// 履歴から開けなかったときと同じ注記で履歴選択画面を出す。選べば set_root で
			// 本体へ移る(applyRoot が画面を閉じる)。
			rootPicker = {
				open: true,
				entries: toPickerEntries(await loadHistory()),
				error: windowInit.message
			};
			// 要件#71 追補c(1)(backlog 290): init_window の version が無いので、選び直したあとの
			// 空の状態の画面の版番号は get_build_info から入れる(失敗しても '' =従来どおり)。
			windowState.version = await versionAfterFailedInit(getBuildInfo);
		} else {
			// 起動時の初期値なので root 切替(windowState.applyRoot)ではない —
			// 展開状態はまだ空で、捨てるものが無い。
			const init = windowInit.init;
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
				// 要件#71 契約5: 開けなくても先へ進む(下の購読の登録と起動の完了まで行く=
				// 窓はツリーを見せたまま生きている)。追補a(1): alert は閉じるまで JS を止めるので
				// ここでは文言を控えるだけにし、購読をすべて登録したあと(onMount の末尾)で出す
				// — 先に出すと、その間に届いたフォルダの変更を購読が無くて取りこぼす。
				await openInitialDocument(init.initial_path, {
					open: openForDisplay,
					setDocument: (doc) => windowState.setDocument(doc),
					onOpenFailed: (message) => {
						startupOpenFailure = message;
					}
				});

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
		// 要件#48 契約⑥: 差し替えるかどうかは `applyFileChanged` が決める。
		// 自分の保存が返ってきただけのエコーは捨て(編集中の DOM を再レンダーで
		// 壊さない)、編集中の変更と食い違う外部変更は文書を動かさずに脇へ置く
		// (Viewer が衝突表示を出す)。それ以外は従来どおり差し替わる。
		await listen<FileChangedPayload>('file_changed', (e) => {
			if (e.payload.uri === windowState.currentDocument?.uri) {
				windowState.applyFileChanged(e.payload);
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

		// 要件#71 追補a(1)(backlog 276): 起動時に開けなかったことは、購読をすべて登録して
		// 起動の完了を立てたあとに知らせる(文言は契約5 の `Could not open the file: …`)。
		if (startupOpenFailure !== null) alert(startupOpenFailure);
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
				onPickFolder={selectFolderFromPicker}
			/>
		{:else}
			{#if showFindInFolder}
				<!--
					要件#55 契約①: 検索パネルは Explorer と入れ替わる(Close で戻る)。幅は
					Explorer と同じ `explorerWidth`(要件#9)を薄い枠で当て、仕切りもそのまま効く。
				-->
				<div class="find-in-folder-pane" style="width: {explorerWidth}px">
					<FindInFolder
						rootUri={windowState.root}
						onOpen={handleFolderResultOpened}
						onClose={() => (findInFolderOpen = false)}
					/>
				</div>
			{:else}
				<!--
					要件#64 契約6: 左ペインは上=Explorer(残りの高さ全部)・下=Recent Files の区画の
					縦 2 段。幅は Explorer と同じ `explorerWidth`(要件#9)。Explorer 自身は無改変で、
					縦に積むのはこの器の持ち場。器の高さは区画の高さの上限の材料になる。
				-->
				<div
					class="explorer-pane"
					style="width: {explorerWidth}px"
					bind:clientHeight={explorerPaneHeight}
				>
					<Explorer
						root={windowState.root}
						entries={windowState.entries}
						selectedUri={windowState.selectedUri}
						width={explorerWidth}
						explorerZoom={explorerZoomLevel}
						onDuplicateWindow={duplicateCurrentWindow}
						onOpenInNewWindow={openPlanInNewWindow}
						onFindInFolder={() => void handleMenuFindInFolder()}
					/>
					{#if showRecentFiles}
						<RecentFiles
							bind:this={recentFilesSection}
							rootUri={windowState.root}
							currentUri={windowState.currentDocument?.uri ?? null}
							paneHeight={explorerPaneHeight}
							explorerZoom={explorerZoomLevel}
							onOpened={(uri) => void handleRecentFileOpened(uri)}
						/>
					{/if}
				</div>
			{/if}
			<!--
				Explorer と Viewer の仕切り(要件#9)。ドラッグ専用のハンドルで、
				既定幅へ戻す手段(ダブルクリック等)は設けない。
			-->
			<div
				class="pane-divider"
				class:dragging={resizingPane}
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize Explorer"
				title="Drag to resize the Explorer"
				onpointerdown={startPaneResize}
				onpointermove={movePaneResize}
				onpointerup={endPaneResize}
				onpointercancel={endPaneResize}
			></div>
			<!--
				要件#60 契約①: Go to バーは**閲覧面の上**に敷く1行。Viewer の中ではなく
				ここに置くのは、文書が開いていなくても(EmptyState のときこそ)出るため。
				ビューアとバーを縦に積むので、行の中では今までのビューアと同じ場所を占める。
			-->
			<!-- data-zoom-region=要件#63 契約3の領域の目印(Go to バーの上も本文側とみなす)。 -->
			<div class="viewer-stack" data-zoom-region="viewer">
				{#if goToOpen}
					<GoToBar
						onGo={(input) => void runGoTo(input)}
						onClose={closeGoTo}
						notFound={goToNotFound}
						brokenLink={goToBrokenLink}
						bind:inputEl={goToInputEl}
						onComposingChange={(composing) => (goToComposing = composing)}
					/>
				{/if}
				<div class="viewer-main">
					{#if windowState.currentDocument}
						<!--
							srcdoc がある=HTML ファイル(要件#8)。生の content は {@html} 経路に載せない。
							要件#48 契約②: 編集中(ソース編集モード)だけは HtmlViewer へ回さない —
							編集するのはレンダリング結果ではなく RAW なので、`<pre contenteditable>` を
							持つ Viewer(下の {:else})へ落とす。Esc / 「編集を終える」で戻ればここへ戻る。
						-->
						{#if windowState.renderedUri === windowState.currentDocument.uri && windowState.renderedSrcdoc !== null && windowState.editMode === 'view' && !htmlFindOpen}
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
							<!-- audioSrc がある=音声(要件#50)。videoSrc と同じ形の分岐で、版数も
							     同じ `binary_file_changed` の機構に乗る。プレースホルダになる
							     ssh もこの経路を通る(出し分けは AudioViewer の中) -->
						{:else if windowState.renderedUri === windowState.currentDocument.uri && windowState.renderedAudioSrc !== null}
							<AudioViewer
								uri={windowState.currentDocument.uri}
								src={imageSrcWithVersion(
									windowState.renderedAudioSrc,
									binaryVersion.uri === windowState.currentDocument.uri ? binaryVersion.version : 0
								)}
							/>
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
								{findRequest}
								{findInitialQuery}
								{findInitialIndex}
								onFindOpenChange={handleFindOpenChange}
								{goToOpen}
							/>
						{/if}
					{:else}
						<EmptyState />
					{/if}
				</div>
			</div>
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
	 * Go to バー(要件#60 契約①)とビューアの縦積み。行の中では今までのビューアと
	 * 同じ場所を占め(`flex: 1`)、その中を上下に割る —— 素材パネルの縦積み
	 * (`.video-stack`)と同じ形。バーが出ていないときは中身が1枚だけになる。
	 */
	.viewer-stack {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	/*
	 * ビューア側。行方向のままなので各ビューアの `flex: 1` / `min-width: 0` は
	 * これまでどおり効き、高さはバーを引いた残りに収まる(min-height: 0 = 縮める許可)。
	 */
	.viewer-main {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: flex;
	}

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
	/* 検索パネルの枠(要件#55)。Explorer の `aside.explorer` と同じ置かれ方・見た目。 */
	.find-in-folder-pane {
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-right: 1px solid var(--color-border);
		background-color: var(--color-bg-secondary);
		overflow: hidden;
	}

	/*
	 * 要件#64 契約6: Explorer と Recent Files の区画を縦に積む器。上の段(Explorer)は残りの
	 * 高さを全部使い、区画は下端に自分の高さで座る。grid にしているのは、Explorer の
	 * `aside.explorer`(行方向で置かれる前提の `flex: 0 0 auto`)に手を入れずに縦へ縮める
	 * ため —— 段を `minmax(0, 1fr)` にすると、中身の長いツリーでも段の高さを超えない
	 * (はみ出しは Explorer の中の一覧がスクロールで受ける)。区画が無いときは下の段が 0。
	 * Explorer の右クリックメニューは position: fixed なので段を取らない。
	 */
	.explorer-pane {
		flex: 0 0 auto;
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
		grid-template-columns: minmax(0, 1fr);
		min-height: 0;
		overflow: hidden;
	}

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
