/**
 * 書式のツールバー(要件#74 第4段 4-2・要件56 のモックの画面2 の 5・6・由谷の決定 4-5・4-6)の定数と純関数。
 *
 * 既定は隠す。ビューアのツールバーの「A」と View ▸ Show Formatting Toolbar で出し入れし、状態はアプリ全体で 1 つ(localStorage)。
 * 中身はモックどおり=段落の種類の選択(Body Text / Heading 1〜6)と、文字の装飾 5 | リスト 3 と引用 | 表 / Code Block / 画像 / 脚注 |
 * Clear Formatting。押すとメニューバーの Format と同じ経路(`runFormatCommand`)。
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { FormatItemId } from './commands';
import { FORMAT_ACCELERATORS } from './editor-context-menu';

/** Rust → 前面の窓(View ▸ Show Formatting Toolbar)。menu.rs の `MENU_SHOW_FORMAT_TOOLBAR_EVENT` と同じ綴り。 */
export const MENU_SHOW_FORMAT_TOOLBAR_EVENT = 'menu_show_format_toolbar';
/** 窓 → Rust { label, shown }(View のチェック印)。menu.rs の `FORMAT_TOOLBAR_STATE_EVENT` と同じ綴り。 */
export const FORMAT_TOOLBAR_STATE_EVENT = 'format_toolbar_state';
/** localStorage のキー('true' / 'false')。既定=隠す。 */
export const FORMAT_TOOLBAR_STORAGE_KEY = 'vellis.formatToolbar';

/** 段落の種類の選択(select)の値(モックの順)。 */
export const FORMAT_TOOLBAR_BLOCK_TYPES: readonly FormatItemId[] = [
	'format-body-text',
	'format-heading-1',
	'format-heading-2',
	'format-heading-3',
	'format-heading-4',
	'format-heading-5',
	'format-heading-6',
];

/** ボタンの並び(モックの順)。'|' は組の区切り。 */
export const FORMAT_TOOLBAR_ITEMS: readonly (FormatItemId | '|')[] = [
	'format-bold',
	'format-italic',
	'format-strikethrough',
	'format-inline-code',
	'format-link',
	'|',
	'format-bulleted-list',
	'format-numbered-list',
	'format-task-list',
	'format-quote',
	'|',
	'format-insert-table',
	'format-code-block',
	'format-insert-image',
	'format-insert-footnote',
	'|',
	'format-clear',
];

/** 項目の英語の名前(メニューバーの Format と同じ)。 */
const NAMES: Partial<Record<FormatItemId, string>> = {
	'format-bold': 'Bold',
	'format-italic': 'Italic',
	'format-strikethrough': 'Strikethrough',
	'format-inline-code': 'Inline Code',
	'format-link': 'Link…',
	'format-body-text': 'Body Text',
	'format-heading-1': 'Heading 1',
	'format-heading-2': 'Heading 2',
	'format-heading-3': 'Heading 3',
	'format-heading-4': 'Heading 4',
	'format-heading-5': 'Heading 5',
	'format-heading-6': 'Heading 6',
	'format-bulleted-list': 'Bulleted List',
	'format-numbered-list': 'Numbered List',
	'format-task-list': 'Task List',
	'format-quote': 'Quote',
	'format-code-block': 'Code Block',
	'format-insert-table': 'Table',
	'format-insert-image': 'Image…',
	'format-insert-footnote': 'Footnote',
	'format-clear': 'Clear Formatting',
};

/** 項目の英語の名前。 */
export function formatToolbarName(id: FormatItemId): string {
	return NAMES[id] ?? id;
}

/** アクセラレータの綴り → キー名(CmdOrCtrl → Command・Alt → Option・Period → .)。 */
function keyNames(accelerator: string): string {
	return accelerator
		.split('+')
		.map((part) => (part === 'CmdOrCtrl' ? 'Command' : part === 'Alt' ? 'Option' : part === 'Period' ? '.' : part))
		.join(' + ');
}

/** title=英語の名前+キー名(キーのある項目だけ)。例 'Bold (Command + B)'・'Clear Formatting'。 */
export function formatToolbarTitle(id: FormatItemId): string {
	const name = formatToolbarName(id);
	const acc = FORMAT_ACCELERATORS[id];
	return acc ? `${name} (${keyNames(acc)})` : name;
}

/** localStorage の値 → 出すか(既定 false。'true' だけ真)。読めなければ既定。 */
export function readFormatToolbarShown(storage: Pick<Storage, 'getItem'> | null): boolean {
	if (!storage) return false;
	try {
		return storage.getItem(FORMAT_TOOLBAR_STORAGE_KEY) === 'true';
	} catch {
		return false;
	}
}

/** 前面の窓の書式のツールバーの状態を Rust に知らせる(View ▸ Show Formatting Toolbar のチェック印)。Tauri の外では何もしない。 */
export async function announceFormatToolbar(shown: boolean): Promise<void> {
	try {
		const win = getCurrentWindow();
		await win.emit(FORMAT_TOOLBAR_STATE_EVENT, { label: win.label, shown });
	} catch {
		// Tauri の外(テストの jsdom など)
	}
}

/**
 * 窓が前面になったら、その窓のツールバーの見え方を知らせ直す(チェック印は前面の窓の値)。購読の解除を返す。
 * `shown()` はその時点の値を返す関数(`watchFocusForRawSource` と同じ形)。
 */
export async function watchFocusForFormatToolbar(shown: () => boolean): Promise<() => void> {
	try {
		const win = getCurrentWindow();
		return await win.onFocusChanged(({ payload: focused }) => {
			if (focused) void announceFormatToolbar(shown());
		});
	} catch {
		return () => {};
	}
}

/** 出すかを localStorage に書く(書けなければ何もしない)。 */
export function writeFormatToolbarShown(shown: boolean): void {
	try {
		localStorage.setItem(FORMAT_TOOLBAR_STORAGE_KEY, shown ? 'true' : 'false');
	} catch {
		// private window など
	}
}

// ---------------------------------------------------------------------------
// 浮遊バー(第4段 4-3・モックの画面2 の 8・由谷の決定 4-7)
// ---------------------------------------------------------------------------

/** 浮遊バーのボタンの並び(段落の種類の選択の後ろ)。'|' は組の区切り。 */
export const SELECTION_BAR_ITEMS: readonly (FormatItemId | '|')[] = [
	'format-bold',
	'format-italic',
	'format-strikethrough',
	'format-inline-code',
	'format-link',
	'|',
	'format-clear',
];

/** キーボードの選択が落ち着くまでの待ち(ms)。マウスを離したときはすぐ出す。 */
export const SELECTION_BAR_SETTLE_MS = 300;

type Box = { left: number; top: number; right: number; bottom: number };

/**
 * 浮遊バーの位置(入力と同じ座標系)。選択のすぐ上(上に入らなければ下)・左は選択の左で、面の内側に収める
 * (面がバーより狭ければ面の左端)。
 */
export function selectionBarPosition(input: {
	anchor: { left: number; top: number; bottom: number };
	bar: { width: number; height: number };
	bounds: Box;
	gap?: number;
}): { left: number; top: number; placement: 'above' | 'below' } {
	const gap = input.gap ?? 8;
	const { anchor, bar, bounds } = input;
	const aboveTop = anchor.top - gap - bar.height;
	const above = aboveTop >= bounds.top;
	const top = above ? aboveTop : anchor.bottom + gap;
	const maxLeft = bounds.right - bar.width;
	const left = maxLeft < bounds.left ? bounds.left : Math.min(Math.max(anchor.left, bounds.left), maxLeft);
	return { left, top, placement: above ? 'above' : 'below' };
}
