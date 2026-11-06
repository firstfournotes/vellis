/**
 * ファイルツリーのコンテキストメニュー(要件#19)。
 *
 * ここは純ロジックだけを持つ — 項目の出し分け・URI からパスへの変換・
 * 項目を押したときの実行計画・メニュー座標のクランプ。実際の表示と
 * opener / clipboard の呼び出しは ContextMenu.svelte と ExplorerItem.svelte 側。
 */
import { parentUri } from './uri';
import { RELOAD_FILE_LABEL, RELOAD_FOLDER_LABEL } from './reload-file';
import { ADD_FILE_LABEL, ADD_FOLDER_LABEL, REMOVE_FROM_RECENT_FOLDERS_LABEL } from './dashboard';


/**
 * ツリーのアイテム。`stores/window-state.svelte` の Entry と同形だが、
 * このモジュールを単体でテストできるよう自分で型を持つ(tree-refresh と同じ家風)。
 */
export type ContextMenuEntry = { uri: string; name: string; kind: 'file' | 'dir' | 'symlink' };

export type ContextMenuItemId =
	| 'reveal'
	| 'open'
	| 'open-with'
	/** 右クリックしたファイルを今の窓の新しいタブで開く(要件#62 契約3)。 */
	| 'open-in-new-tab'
	/** 右クリックした項目のフォルダを root にした新しい窓(要件#59)。 */
	| 'open-in-new-window'
	/** 今の窓で開いている文書を読み直す(要件#80 契約 9)。ファイルの行と本文のメニュー。 */
	| 'reload-file'
	/** フォルダの一覧を読み直す(要件#80 契約 14)。フォルダの行とツリーの空白のメニュー。 */
	| 'reload-folder'
	| 'copy-path'
	/** 右クリックした項目を Dashboard の Bookmark に足す(要件#83 契約 7)。済みなら下の Unpin に替わる。 */
	| 'pin-to-bookmarks'
	/** 右クリックした項目を Bookmark から外す(要件#83 契約 7)。 */
	| 'unpin-from-bookmarks'
	/** ウィンドウの複製(要件#34)。アイテムではなく窓に効く唯一の項目。 */
	| 'duplicate-window'
	// --- Dashboard のメニュー(要件#83 契約 14)。実行は Dashboard 側(`onDashboardItem`)。
	| 'dashboard-open'
	| 'dashboard-open-in-new-window'
	| 'move-up'
	| 'move-down'
	| 'remove-from-recent-folders'
	| 'add-folder-bookmark'
	| 'add-file-bookmark';

export type ContextMenuItem = {
	id: ContextMenuItemId;
	label: string;
	enabled: boolean;
	/**
	 * この項目の前に区切り線を引く(要件#83 契約 14 の Dashboard のメニュー)。省略= false。
	 * 既存のメニューの線(Duplicate Window の前)は描画側の規則のままで、この印は使わない。
	 */
	separatorBefore?: boolean;
};

/**
 * Dashboard のメニューを開いた対象(要件#83 契約 14)。タイルは並べ替えのために位置を持つ。
 * `add-bookmark` は Add Bookmark… を押したときのメニュー(契約 7 (ac))。
 */
export type DashboardMenuTarget =
	| { kind: 'bookmark'; uri: string; bookmarkKind: 'folder' | 'file'; index: number }
	| { kind: 'recent-folder'; uri: string }
	| { kind: 'add-bookmark' };

/**
 * 新しいウィンドウを開く計画(要件#59 契約②③)。`root` は新窓の起点フォルダ
 * (フォルダ項目はそれ自身・ファイル/symlink は親フォルダ)、`path` は新窓で
 * 開く文書(フォルダ項目では null)。どちらも URI のまま(正規化しない)。
 */
export type NewWindowAction = { command: 'new-window'; root: string; path: string | null };

/**
 * 新しいタブで開く計画(要件#62 契約3)。`path` は開くファイルの URI のまま
 * (正規化しない)。root と展開は今の窓のものを実行側が足す(`$lib/new-tab`)。
 */
export type NewTabAction = { command: 'new-tab'; path: string };

/**
 * 読み直しの計画(要件#80 契約 9・14)。`uri` は行の URI のまま。null は entry の無い
 * メニューから押したとき — 本文のメニューの Reload File は「今の文書」、ツリーの空白の
 * Reload Folder は「root」。読み直しの実行列は ContextMenu の外(ページ・Explorer)。
 */
export type ReloadAction =
	| { command: 'reload-file'; uri: string | null }
	| { command: 'reload-folder'; uri: string | null };

/**
 * Bookmark に足す・外す計画(要件#83 契約 7)。`uri` は行の URI のまま(正規化は Rust)。
 * フォルダの行= folder・ファイルとシンボリックリンクの行= file。
 */
export type BookmarkAction =
	| { command: 'pin-bookmark'; uri: string; kind: 'folder' | 'file' }
	| { command: 'unpin-bookmark'; uri: string };

export type ContextAction =
	| { command: 'reveal_item_in_dir'; path: string }
	| { command: 'open_path'; path: string }
	| { command: 'copy'; text: string }
	/** アプリ選択ダイアログを開く計画(要件#21)。開く対象の OS パスを持つ。 */
	| { command: 'pick-app'; path: string }
	/**
	 * ウィンドウ複製の起動(要件#34)。右クリックしたアイテムは関係しない
	 * (複製するのは窓の中身)ので、パスも URI も持たない。
	 */
	| { command: 'duplicate-window' }
	| NewWindowAction
	| NewTabAction
	| ReloadAction
	| BookmarkAction;

/** ダイアログで選んだ .app で開く計画(要件#21 第2段)。 */
export type OpenWithAction = { command: 'open_path'; path: string; with: string };

/** ラベルは英語固定(要件#35 ①=macOS 標準用語。i18n 機構は持たない)。 */
const LABELS: Record<ContextMenuItemId, string> = {
	reveal: 'Reveal in Finder',
	open: 'Open with Default App',
	'open-with': 'Open With…',
	'open-in-new-tab': 'Open in New Tab',
	'open-in-new-window': 'Open in New Window',
	'reload-file': RELOAD_FILE_LABEL,
	'reload-folder': RELOAD_FOLDER_LABEL,
	'copy-path': 'Copy Path',
	'pin-to-bookmarks': 'Pin to Bookmarks',
	'unpin-from-bookmarks': 'Unpin from Bookmarks',
	'duplicate-window': 'Duplicate Window',
	'dashboard-open': 'Open',
	'dashboard-open-in-new-window': 'Open in New Window',
	'move-up': 'Move Up',
	'move-down': 'Move Down',
	'remove-from-recent-folders': REMOVE_FROM_RECENT_FOLDERS_LABEL,
	'add-folder-bookmark': ADD_FOLDER_LABEL,
	'add-file-bookmark': ADD_FILE_LABEL
};

/** Dashboard のメニューの項目(実行は Dashboard)。ツリーの行の計画には落とさない。 */
const DASHBOARD_ITEM_IDS: ReadonlySet<ContextMenuItemId> = new Set([
	'dashboard-open',
	'dashboard-open-in-new-window',
	'move-up',
	'move-down',
	'remove-from-recent-folders',
	'add-folder-bookmark',
	'add-file-bookmark'
]);

/** ssh リモートか(判別は URI スキームのみ・パス内容では分岐しない=契約⑤)。 */
function isRemote(uri: string): boolean {
	return /^ssh:/i.test(uri);
}

/**
 * symlink はファイル扱いにする。フロントは指し先の種別を知らないため、
 * 項目を落とすより OS に委ねるほうが安全側(受け入れテストの確定判断)。
 */
function isDirEntry(entry: ContextMenuEntry): boolean {
	return entry.kind === 'dir';
}

/**
 * 新しい窓の root にするフォルダ(要件#59 契約②)。フォルダ項目はそれ自身・
 * ファイル/symlink は親フォルダ。親が取れない(authority 直下の)ファイルは null。
 */
function newWindowRoot(entry: ContextMenuEntry): string | null {
	return isDirEntry(entry) ? entry.uri : parentUri(entry.uri);
}

/**
 * 右クリックされたアイテムからメニュー項目を組む。
 *
 * - ファイル/symlink = Reveal in Finder・Open with Default App・Open With…・
 *   Open in New Tab・Open in New Window・Reload File・Copy Path
 * - Open in New Tab(要件#62)はファイル/symlink だけ・常に有効(ssh でも=
 *   アプリの中で完結する)。フォルダをタブで開く意味は定まらないので出さない
 * - Reload File(要件#80 契約 9)はファイル/symlink だけ。有効なのは行の URI が
 *   `openDocUri`(今の窓で開いている文書の URI)と**文字列で一致する**ときだけで、
 *   それ以外(省略・null を含む)は出したまま無効。ssh でも有効(アプリの中で完結する)
 * - フォルダ = 既定アプリ系を出さない(Finder 表示と重複するため=契約②・#21①)。
 *   Reload Folder(要件#80 契約 14)はフォルダだけ・常に有効(ssh でも)
 * - ssh リモートは項目を出したまま Finder / 既定アプリ / アプリ選択を disabled(契約⑤)。
 *   Open in New Window は窓を開くだけでアプリ内に閉じるので ssh でも有効(契約#59⑥)
 * - Open in New Window(要件#59)が無効になるのは **親フォルダが取れないファイル**
 *   だけ — 切ると root がスキームだけになり意味を持たないため(契約#59②の縮退)
 * - 末尾のウィンドウ複製(要件#34)だけは種別にもリモートにも左右されない。
 *   アイテムではなく窓に効く操作なので、無効になる状況が無い(契約#34③)。
 *   区切り線を挟むかは描画側の持ち場で、項目の並びには現れない
 * - Pin to Bookmarks(要件#83 契約 7)は Copy Path の直後(Duplicate Window の前)。ファイル・
 *   symlink・フォルダの行とも・常に有効(ssh でも=アプリの中で完結する)。`pinned`(済み)なら
 *   同じ位置が Unpin from Bookmarks。省略= false
 */
export function buildContextMenu(
	entry: ContextMenuEntry,
	openDocUri?: string | null,
	pinned: boolean = false
): ContextMenuItem[] {
	const local = !isRemote(entry.uri);
	const pin: ContextMenuItemId = pinned ? 'unpin-from-bookmarks' : 'pin-to-bookmarks';
	const ids: ContextMenuItemId[] = isDirEntry(entry)
		? ['reveal', 'open-in-new-window', 'reload-folder', 'copy-path', pin, 'duplicate-window']
		: [
				'reveal',
				'open',
				'open-with',
				'open-in-new-tab',
				'open-in-new-window',
				'reload-file',
				'copy-path',
				pin,
				'duplicate-window'
			];
	const enabled = (id: ContextMenuItemId): boolean => {
		if (id === 'copy-path' || id === 'duplicate-window' || id === 'open-in-new-tab') return true;
		if (id === 'pin-to-bookmarks' || id === 'unpin-from-bookmarks') return true;
		if (id === 'reload-folder') return true;
		if (id === 'reload-file') return openDocUri != null && openDocUri === entry.uri;
		if (id === 'open-in-new-window') return newWindowRoot(entry) !== null;
		return local;
	};
	return ids.map((id) => ({ id, label: LABELS[id], enabled: enabled(id) }));
}

/**
 * ツリーの空白部分(アイテムの無いところ)を右クリックしたときのメニュー(要件#34③)。
 *
 * アイテムを指していないので、出せるのはアイテムに依存しない項目だけ —
 * root を読み直す Reload Folder(要件#80 契約 14)と、末尾のウィンドウの複製。
 */
export function buildTreePaneMenu(): ContextMenuItem[] {
	return [
		{ id: 'reload-folder', label: LABELS['reload-folder'], enabled: true },
		{ id: 'duplicate-window', label: LABELS['duplicate-window'], enabled: true }
	];
}

/**
 * 文書の本文(閲覧面)を右クリックしたときのメニュー(要件#80 契約 8)。項目は今の文書を
 * 読み直す Reload File と、今の文書を Bookmark に足す Pin to Bookmarks(要件#83 契約 7。
 * `pinned`=済みなら Unpin from Bookmarks)の 2 つ(出すかどうかの判定は `$lib/reload-file` の
 * `viewerContextMenuMode`)。
 */
export function buildViewerMenu(pinned: boolean = false): ContextMenuItem[] {
	const pin: ContextMenuItemId = pinned ? 'unpin-from-bookmarks' : 'pin-to-bookmarks';
	return [
		{ id: 'reload-file', label: LABELS['reload-file'], enabled: true },
		{ id: pin, label: LABELS[pin], enabled: true }
	];
}

function dashboardItem(id: ContextMenuItemId, enabled = true, separatorBefore = false): ContextMenuItem {
	const item: ContextMenuItem = { id, label: LABELS[id], enabled };
	if (separatorBefore) item.separatorBefore = true;
	return item;
}

/**
 * Dashboard の Bookmark のタイルのメニュー(要件#83 契約 14 (ae))= Open・Open in New Window /
 * Move Up・Move Down / Unpin from Bookmarks。先頭の Move Up・末尾の Move Down は無効。
 */
export function buildBookmarkTileMenu(index: number, count: number): ContextMenuItem[] {
	return [
		dashboardItem('dashboard-open'),
		dashboardItem('dashboard-open-in-new-window'),
		dashboardItem('move-up', index > 0, true),
		dashboardItem('move-down', index < count - 1),
		dashboardItem('unpin-from-bookmarks', true, true)
	];
}

/**
 * Dashboard の Recent Folders の行のメニュー(要件#83 契約 14 (ae))= Open・Open in New Window /
 * Pin to Bookmarks(`pinned` なら Unpin from Bookmarks)/ Remove from Recent Folders。
 */
export function buildRecentFolderMenu(pinned: boolean): ContextMenuItem[] {
	return [
		dashboardItem('dashboard-open'),
		dashboardItem('dashboard-open-in-new-window'),
		dashboardItem(pinned ? 'unpin-from-bookmarks' : 'pin-to-bookmarks', true, true),
		dashboardItem('remove-from-recent-folders', true, true)
	];
}

/** Add Bookmark… を押したときのメニュー(要件#83 契約 7 (ac))= Add Folder… / Add File…。 */
export function buildAddBookmarkMenu(): ContextMenuItem[] {
	return [dashboardItem('add-folder-bookmark'), dashboardItem('add-file-bookmark')];
}

/**
 * file:// URI を OS の絶対パスへ。パーセントエンコードは復号する。
 * backend はエンコードしない生 URI も返すため(menu-open / tree-refresh と同じ前提)、
 * URL で解釈できなかったときはプレフィックスを剥がすだけに留める。
 */
function fileUriToPath(uri: string): string {
	try {
		const u = new URL(uri);
		return decodeURIComponent(u.pathname);
	} catch {
		return uri.replace(/^file:\/\//i, '');
	}
}

/** クリップボードへ載せる値: ローカル= OS パス・ssh = URI 文字列のまま(契約④)。 */
export function pathForCopy(uri: string): string {
	return isRemote(uri) ? uri : fileUriToPath(uri);
}

/**
 * reveal_item_in_dir / open_path に渡す OS パス。ssh は呼ばれない前提だが、
 * 例外を投げず文字列を返す(グレーアウトが破れたときの安全網)。
 */
export function pathForReveal(uri: string): string {
	return isRemote(uri) ? uri : fileUriToPath(uri);
}

/**
 * 項目を押したときにやることを決める。disabled な組(ssh の reveal / open)は
 * null =何もしない。
 *
 * ウィンドウの複製(要件#34)は entry を読まずに返す — 複製するのは窓の中身で、
 * 右クリックしたアイテムは「どこで押したか」でしかない。ssh でも null にしないのは
 * disabled になる組が存在しないため(null は「グレーアウトの安全網」であって、
 * 有効な項目の受け皿ではない)。リモート判定より手前に置くのはそのため。
 *
 * 新しい窓(要件#59)も同じ理由でリモート判定より手前に置く — 窓を開くのは
 * アプリ内で完結するので ssh でも有効(契約#59⑥)。null になるのは親フォルダの
 * 取れないファイルだけで、これは disabled な項目の安全網にあたる(契約#59②)。
 * URI は変形しない — `new_window` は verbatim に登録する。
 *
 * 新しいタブ(要件#62)も同じ理由でリモート判定より手前。ファイルの URI を
 * そのまま渡す(root と展開は実行側が今の窓から足す)。
 *
 * 読み直し(要件#80)も同じ理由でリモート判定より手前 — アプリの中で完結するので
 * ssh でも有効。行の URI をそのまま渡す(今の文書かの照合は実行列が持つ)。
 *
 * Bookmark の Pin / Unpin(要件#83 契約 7)も同じ理由でリモート判定より手前。フォルダの行は
 * folder・ファイルと symlink の行は file。Dashboard のメニューの項目は行の計画に落とさない(null)。
 */
export function planContextAction(
	id: ContextMenuItemId,
	entry: ContextMenuEntry
): ContextAction | null {
	if (DASHBOARD_ITEM_IDS.has(id)) return null;
	if (id === 'duplicate-window') return { command: 'duplicate-window' };
	if (id === 'pin-to-bookmarks') {
		return { command: 'pin-bookmark', uri: entry.uri, kind: isDirEntry(entry) ? 'folder' : 'file' };
	}
	if (id === 'unpin-from-bookmarks') return { command: 'unpin-bookmark', uri: entry.uri };
	if (id === 'open-in-new-tab') return { command: 'new-tab', path: entry.uri };
	if (id === 'reload-file') return { command: 'reload-file', uri: entry.uri };
	if (id === 'reload-folder') return { command: 'reload-folder', uri: entry.uri };
	if (id === 'open-in-new-window') {
		const root = newWindowRoot(entry);
		if (root === null) return null;
		return { command: 'new-window', root, path: isDirEntry(entry) ? null : entry.uri };
	}
	if (id === 'copy-path') return { command: 'copy', text: pathForCopy(entry.uri) };
	if (isRemote(entry.uri)) return null;
	const path = pathForReveal(entry.uri);
	if (id === 'reveal') return { command: 'reveal_item_in_dir', path };
	if (id === 'open-with') return { command: 'pick-app', path };
	return { command: 'open_path', path };
}

/**
 * アプリ選択ダイアログの結果から実行計画を作る(要件#21②④)。
 * キャンセル(null / undefined)は null =無変化。ssh は選ばれていても実行しない。
 */
export function planOpenWith(
	entry: ContextMenuEntry,
	appPath: string | null | undefined
): OpenWithAction | null {
	if (!appPath) return null;
	if (isRemote(entry.uri)) return null;
	return { command: 'open_path', path: pathForReveal(entry.uri), with: appPath };
}

/**
 * メニュー左上の座標をビューポート内へ引き戻す(契約①のはみ出し防止)。
 * 収まるならそのまま・はみ出す分だけ戻す・負にはしない。
 */
export function clampMenuPosition(
	pos: { x: number; y: number },
	size: { width: number; height: number },
	viewport: { width: number; height: number }
): { x: number; y: number } {
	return {
		x: Math.max(0, Math.min(pos.x, viewport.width - size.width)),
		y: Math.max(0, Math.min(pos.y, viewport.height - size.height))
	};
}
