/**
 * 最近開いたファイル(Recent Files・requirements.md #64)の画面を持たない部分。
 *
 * 記録と保存は Rust(`src-tauri/src/recent_files.rs`)。文書を開くのに成功するたびに
 * `open_in_window` が記録し、「見つからない」で失敗したら除く(契約1・2・8)ので、
 * フロントは記録を呼ばない。ここが持つのは:
 * - メニューのイベント名・command 名・文言(英語=要件#51)
 * - 行の表示ラベル(ファイル名+root からの相対フォルダ)と、ツリーで行を見せるための
 *   祖先フォルダ(どちらも文字列だけで作る純関数)
 * - 区画を出してよいかの判定と、読み込み・消去の invoke
 *
 * 区画(開閉・高さ・クリック)は `src/components/RecentFiles.svelte`、開閉と高さの保存は
 * `$lib/recent-files-section`、Command + Shift + R の受け口は `src/routes/+page.svelte`。
 * このファイルはストレージに触れない。
 */
import { invoke } from '$lib/ipc';

/** Go メニュー「Recent Files」(Command + Shift + R)のイベント名。menu.rs の MENU_RECENT_FILES_EVENT と同綴り。 */
export const MENU_RECENT_FILES_EVENT = 'menu_recent_files';

/** Tauri command 名(契約4・9・11)。invoke の第 1 引数。 */
export const LIST_RECENT_FILES_COMMAND = 'list_recent_files';
export const CLEAR_RECENT_FILES_COMMAND = 'clear_recent_files';

/** 区画の見出し(契約6・英語=要件#51)。 */
export const RECENT_FILES_TITLE = 'Recent Files';

/** 0 件のときの一文(契約6)。 */
export const RECENT_FILES_EMPTY_MESSAGE = 'No recent files';

/** 見出し行の消去ボタン(契約9)。 */
export const RECENT_FILES_CLEAR_LABEL = 'Clear';

/** 開くのに失敗したときの alert の文言(契約8)。 */
export function recentFileOpenFailedMessage(err: unknown): string {
	return `Could not open the file: ${err}`;
}

/** 1 行の表示ラベル。`folder` は root からの相対フォルダ(root 直下は空)。 */
export type RecentFileLabel = { name: string; folder: string };

/**
 * root の末尾の `/` を 1 つ落として `/` を足したもの(Rust の `is_under_root` と同じ規則)。
 * `file:///` は `file:///` のまま。
 */
function rootPrefix(root: string): string {
	return `${root.endsWith('/') ? root.slice(0, -1) : root}/`;
}

/** root から見た相対パスのセグメント(root の外なら null)。 */
function relativeSegments(uri: string, root: string): string[] | null {
	const prefix = rootPrefix(root);
	if (!uri.startsWith(prefix)) return null;
	return uri
		.slice(prefix.length)
		.split('/')
		.filter((s) => s.length > 0);
}

/**
 * 行の表示ラベル(契約6)。ファイル名と root からの相対フォルダ。
 *
 * 文字列だけで作る(`new URL()` は使わない)。backend の URI は %エンコードしない生の
 * 文字列なので、`URL.pathname` を通すと `my docs` が `my%20docs` に化ける
 * (`root-picker.ts` の `labelFor` と同じ理由)。authority は出さない。
 * root の外の URI(普通は来ない)は、パスの最後のセグメントを名前にしてフォルダを空にする。
 */
export function recentFileLabel(uri: string, root: string): RecentFileLabel {
	const segments = relativeSegments(uri, root) ?? lastSegment(uri);
	const name = segments[segments.length - 1] ?? uri;
	return { name, folder: segments.slice(0, -1).join('/') };
}

/** root の外の URI の表示用: パスの最後のセグメントだけ。 */
function lastSegment(uri: string): string[] {
	const schemeEnd = uri.indexOf('://');
	const afterScheme = schemeEnd === -1 ? uri : uri.slice(schemeEnd + 3);
	const pathStart = afterScheme.indexOf('/');
	const path = pathStart === -1 ? '' : afterScheme.slice(pathStart);
	return path.split('/').filter((s) => s.length > 0).slice(-1);
}

/**
 * root を除く祖先フォルダの URI を浅い順に(契約7)。区画から開いたファイルの行を
 * ツリーで見せるために展開へ足す。URI は末尾 `/` 無しで、ツリーのエントリの URI と
 * 同じ綴り(root + `/` + 名前)。root 直下のファイル・root の外の URI は []。
 */
export function ancestorDirs(uri: string, root: string): string[] {
	const segments = relativeSegments(uri, root);
	if (segments === null) return [];
	const dirs: string[] = [];
	let current = rootPrefix(root).slice(0, -1);
	for (const segment of segments.slice(0, -1)) {
		current = `${current}/${segment}`;
		dirs.push(current);
	}
	return dirs;
}

/**
 * 区画を出してよいか(契約5・6): root があり、履歴選択画面(要件#4)でなく、検索パネル
 * (要件#55)を出していないとき。Go メニューの受け口も同じ判定の root と履歴選択画面の
 * 部分をガードに使う(検索パネルは閉じてから出す=起案時判断 (l))。
 */
export function shouldShowRecentFiles(
	rootUri: string | null | undefined,
	rootPickerOpen: boolean,
	findInFolderOpen: boolean
): boolean {
	return !!rootUri && !rootPickerOpen && !findInFolderOpen;
}

/**
 * 今の root 配下で開いたファイル(新しい順・最大 10 件=絞るのは Rust)。
 * 失敗は [] に解決する(reject しない)。壊れた履歴が区画を塞がないように
 * (`root-picker.ts` の `loadHistory` と同じ)。
 */
export async function loadRecentFiles(root: string): Promise<string[]> {
	try {
		return await invoke<string[]>(LIST_RECENT_FILES_COMMAND, { root });
	} catch {
		return [];
	}
}

/** 今の root 配下の記録を消す(契約9)。ほかの root の記録は残る。 */
export async function clearRecentFiles(root: string): Promise<void> {
	await invoke(CLEAR_RECENT_FILES_COMMAND, { root });
}
