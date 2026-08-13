/**
 * File メニューの Open… / Open Folder…(requirements.md #11)。
 *
 * 「File メニューの Open でファイル/フォルダを現在のウインドウで開き直せる」の
 * フロント側の持ち場を一箇所に集める。Rust 側(`src-tauri/src/menu.rs`)は
 * メニュー項目とアクセラレータを持ち、クリックで下の2イベントを
 * フォーカス中のウインドウへ emit するだけ — ダイアログ・root の導出・
 * コマンド列はすべてここにある。
 *
 * 契約(2026-08-09 由谷決定=2項目案・root=常に親へ切替):
 * - Open…(CmdOrCtrl+O)=ファイル選択 → root を親フォルダへ切替+当該ファイルを開く
 *   (要件#5 と同じ導出。現 root 配下でも常に親へ)
 * - Open Folder…(CmdOrCtrl+Shift+O)=フォルダ選択 → root を当該フォルダへ切替
 * - 履歴記録は `set_root` 経由(要件#3。ファイル時は親を記録=#5 踏襲)。
 *   フロントで別途記録しない
 * - キャンセル=無変化(invoke を一切呼ばない)
 * - ラスタ画像は `open_document` を通さない(要件#16 ⑦)。root の切替は同じで、
 *   文書は読まずに URI だけを返す
 *
 * 2項目に割れているのは plugin-dialog の制約: 1つのダイアログでファイルと
 * フォルダを同時に選ばせることができない。
 */
import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import { readsAsText } from '$lib/image-viewing';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

/** Rust のメニュー項目 → Webview の通知イベント名(ペイロードなし)。 */
export const MENU_OPEN_FILE_EVENT = 'menu_open_file';
export const MENU_OPEN_FOLDER_EVENT = 'menu_open_folder';

/** どちらのダイアログから来たか。file/folder の別はダイアログ種別が正。 */
export type MenuOpenKind = 'file' | 'folder';

/** ダイアログ結果から導いた実行計画。 */
export type MenuOpenPlan = {
	/** `set_root` に渡す URI。file なら親フォルダ・folder なら当該フォルダ。 */
	rootUri: string;
	/** `open_document` に渡す URI。folder のときは null(開く文書がない)。 */
	docUri: string | null;
};

/**
 * Open… / Open Folder… の結果。folder のときは `document: null`。
 *
 * `document` は `open_document` を通した場合の解決値。ラスタ画像(要件#16 ⑦)は
 * テキストとして読めないので通さず、`document: null` + `docUri` だけが返る —
 * 読まずに表示する組み立ては配線側(`+page.svelte`)の持ち場。
 */
export type MenuOpened<Root = unknown, Doc = unknown> = {
	root: Root;
	document: Doc | null;
	/** 選ばれたファイルの URI。folder のときは null。 */
	docUri: string | null;
};

/** メニュー起点の結果を受け取る配線側のハンドラ。 */
export type MenuOpenHandlers<Root = unknown, Doc = unknown> = {
	/** 開けたときだけ呼ばれる。キャンセルでは呼ばない(=無変化)。 */
	onOpened: (opened: MenuOpened<Root, Doc>) => void;
	/** 失敗の通知先。省略可 — 省略しても例外は外へ出さない。 */
	onError?: (err: unknown) => void;
};

/**
 * ダイアログが返す絶対パスを URI にする。
 *
 * `file://` を前置した生文字列で、percent-encode はしない。backend の
 * `format!("file://{}", …)` と +page.svelte の pickFolderAndSetRoot が同じ規約で、
 * ここだけ `encodeURI` すると `My Docs` が `My%20Docs` になって履歴・root の
 * 比較が食い違う(root-picker の labelFor が `new URL()` を避けているのと同じ理由)。
 */
function toUri(path: string): string {
	return `file://${path}`;
}

/**
 * 絶対パスの親ディレクトリ。
 *
 * ルート直下(`/plan.md`)の親は `/` — 空文字にすると `file://` という
 * 開けない URI になるため、区切り自体を残す。
 */
function parentPath(path: string): string {
	const lastSlash = path.lastIndexOf('/');
	if (lastSlash < 0) return path; // 区切りがない=絶対パスでない。触らず返す
	if (lastSlash === 0) return '/';
	return path.slice(0, lastSlash);
}

/**
 * ダイアログ結果 → 実行計画。純関数で、現在の root を入力に取らない。
 *
 * 「現 root 配下でも常に親へ切替」という契約を API の形で担保している —
 * 現 root を渡さない以上、位置関係で分岐する余地がない。
 *
 * ファイルかフォルダかはダイアログ種別(`kind`)が正であり、拡張子の
 * ヒューリスティック(Rust の `uri_looks_like_dir`)は使わない。Open… で
 * 拡張子なしのファイル(`README`)を選んでもファイルとして開く。
 *
 * キャンセル(null)と非文字列(複数選択の string[] 等)は null =「何もしない」。
 */
export function planMenuOpen(
	kind: MenuOpenKind,
	selected: string | string[] | null,
): MenuOpenPlan | null {
	if (typeof selected !== 'string') return null;
	if (kind === 'folder') return { rootUri: toUri(selected), docUri: null };
	return { rootUri: toUri(parentPath(selected)), docUri: toUri(selected) };
}

/** ダイアログのオプション。file / folder の違いはここだけ。 */
const DIALOG_OPTIONS: Record<MenuOpenKind, Record<string, unknown>> = {
	// フィルタは付けない。Vellis は Markdown 以外(テキスト=要件#2・HTML=要件#8)も
	// 表示するので、拡張子で選べる範囲を狭めない。
	file: { directory: false, multiple: false, title: 'ファイルを開く' },
	folder: { directory: true, multiple: false, title: 'フォルダを選択' },
};

/**
 * ダイアログ → `set_root` →(ファイルなら)`open_document`。
 *
 * 失敗は握りつぶさず reject させる(root-picker の openHistoryEntry と同じ家風)。
 * `set_root` が失敗した時点で止め、`open_document` は呼ばない — root を切り替え
 * られていないのに文書だけ開くと、backend と画面の root が食い違う。
 */
async function openFromMenu<Root, Doc>(kind: MenuOpenKind): Promise<MenuOpened<Root, Doc> | null> {
	const selected = await openDialog(DIALOG_OPTIONS[kind]);
	const plan = planMenuOpen(kind, selected);
	if (plan === null) return null; // キャンセル=無変化

	// 履歴記録(要件#3)は set_root の backend 側 record_root が担う。
	const root = await invoke<Root>('set_root', { uri: plan.rootUri });
	// ラスタ画像(要件#16 ⑦)は open_document を呼ばない — 呼べば InvalidUtf8 で
	// 失敗し、root を切り替えた直後にエラーだけが出る。URI は docUri で返す。
	const document =
		plan.docUri === null || !readsAsText(plan.docUri)
			? null
			: await invoke<Doc>('open_document', { uri: plan.docUri });
	return { root, document, docUri: plan.docUri };
}

/** Open…(CmdOrCtrl+O)。ファイルを選ぶと root は親フォルダへ切り替わる。 */
export function openFileFromMenu<Root = unknown, Doc = unknown>(): Promise<MenuOpened<
	Root,
	Doc
> | null> {
	return openFromMenu<Root, Doc>('file');
}

/** Open Folder…(CmdOrCtrl+Shift+O)。root だけを切り替える。 */
export function openFolderFromMenu<Root = unknown, Doc = unknown>(): Promise<MenuOpened<
	Root,
	Doc
> | null> {
	return openFromMenu<Root, Doc>('folder');
}

/**
 * メニューイベントを購読し、ダイアログ〜コマンド列までを引き受ける。
 * 返り値は両購読をまとめて解除する関数。
 *
 * 失敗は `onError` に渡し、イベントハンドラの外へは投げない。メニュー起点の
 * 失敗が unhandled rejection になると、ユーザーには「押しても何も起きない」
 * としか見えないため。`onError` を省いても落ちない。
 *
 * ハンドラは処理の完了で解決する Promise を返す(listen の型は void だが、
 * 返しておくとテストと配線側が完了を待てる)。
 */
export async function registerMenuOpenListeners<Root = unknown, Doc = unknown>(
	handlers: MenuOpenHandlers<Root, Doc>,
): Promise<() => void> {
	const run = async (kind: MenuOpenKind): Promise<void> => {
		try {
			const opened = await openFromMenu<Root, Doc>(kind);
			if (opened !== null) handlers.onOpened(opened);
		} catch (err) {
			handlers.onError?.(err);
		}
	};

	const [unlistenFile, unlistenFolder] = await Promise.all([
		listen<unknown>(MENU_OPEN_FILE_EVENT, () => run('file')),
		listen<unknown>(MENU_OPEN_FOLDER_EVENT, () => run('folder')),
	]);

	return () => {
		unlistenFile();
		unlistenFolder();
	};
}
