<script lang="ts">
	import { onMount } from 'svelte';
	import Explorer from '../components/Explorer.svelte';
	import Viewer from '../components/Viewer.svelte';
	import HtmlViewer from '../components/HtmlViewer.svelte';
	import ImageViewer from '../components/ImageViewer.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import StatusBar from '../components/StatusBar.svelte';
	import InstructionDialog from '../components/InstructionDialog.svelte';
	import MarkList from '../components/MarkList.svelte';
	import DiffView from '../components/DiffView.svelte';
	import RootPicker from '../components/RootPicker.svelte';
	import UpdateBanner from '../components/UpdateBanner.svelte';
	import { invoke } from '$lib/ipc';
	import { listen } from '$lib/events';
	import { open } from '@tauri-apps/plugin-dialog';
	import { windowState, type DocumentPayload, type Entry } from '../stores/window-state.svelte';
	import { marksStore } from '../stores/marks.svelte';
	import { featureFlags } from '$lib/flags.svelte';
	import { renderForDisplay } from '$lib/file-type';
	import { openForDisplay, unreadDocument } from '$lib/open-document';
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
	import { registerMenuOpenListeners } from '$lib/menu-open';
	import type { BuiltAnchor } from '../markdown/selection';
	import type { Mark } from '$lib/annotation';
	import '../styles/theme.css';
	import '../styles/app.css';
	import '../styles/markdown.css';
	import '../styles/print.css';

	let showMarks = $state(false);
	let markFilter = $state<MarkFilterMode>('all');
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
			title: 'フォルダを選択'
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
				if (opened.document) windowState.setDocument(opened.document);
				// document なし + docUri あり=ラスタ画像(要件#16 ⑦)。
				// 読まずに URI だけで画像ビューアへ渡す。
				else if (opened.docUri) windowState.setDocument(unreadDocument(opened.docUri));
			},
			onError: (err) => {
				alert(`開けませんでした: ${err}`);
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

		// File removed event
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
		renderForDisplay(uri, content).then((result) => {
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
						src={windowState.renderedImageSrc}
						source={windowState.currentDocument.content}
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
