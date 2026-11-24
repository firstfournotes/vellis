/**
 * 編集面の文字の上の右クリックのメニュー(要件#74 契約8・契約17・由谷の決定 2026-11-17 朝・stage34-prep の 3-15)。
 *
 * ここは並びを決める純関数だけを持つ。ネイティブのメニューへの写しは `$lib/native-menu` の `popupMenu`、
 * 面の contextmenu の受け手と項目を押したときの実行は `./editor-context-menu-handler` が持つ。
 *
 * 第2段 2-6 の範囲は、どの面でも Cut / Copy / Paste(定義済みの項目=ネイティブ)・区切り線・Reload File(要件#80)・
 * Pin to Bookmarks / Unpin from Bookmarks(要件#83)。第3段 3-4 で Markdown の面に Format ▸ と(表の中なら)Table ▸ が入る。
 * ID とラベルは本文の右クリックのメニュー(`$lib/context-menu`)と同じ。
 */
import { RELOAD_FILE_LABEL } from '$lib/reload-file';
import type { FormatItemId } from './commands';
import type { ActiveFormat } from './active-format';

/** メニューの 1 項目。`predefined` は OS の定義済みの項目(クリップボードは JS を通らない)。 */
export type EditorMenuEntry =
	| { kind: 'predefined'; item: 'Cut' | 'Copy' | 'Paste' }
	| { kind: 'separator' }
	| { kind: 'item'; id: string; label: string; accelerator?: string; checked?: boolean }
	| { kind: 'submenu'; id: string; label: string; items: EditorMenuEntry[] };

/** 右クリックされた面。`raw` は Markdown の View ▸ Raw Source。 */
export type EditorSurface = 'markdown' | 'code' | 'raw';

export interface EditorContextMenuInput {
	surface: EditorSurface;
	/** 表のセルの上か(第3段の Table ▸ のため。2-6 では並びを変えない)。 */
	inTable?: boolean;
	/** 開いている文書が Bookmark 済みか。 */
	pinned: boolean;
	/** 第3段 3-4: 今の装飾(Format ▸ のチェック。`activeFormat(state)`)。省けば全部チェックなし。 */
	active?: ActiveFormat;
}

/** メニューバーの Format と同じアクセラレータの綴り(表示だけ。menu.rs の FORMAT_*_ACCELERATOR と同じ値)。 */
export const FORMAT_ACCELERATORS: Readonly<Partial<Record<FormatItemId, string>>> = {
	'format-bold': 'CmdOrCtrl+B',
	'format-italic': 'CmdOrCtrl+I',
	'format-strikethrough': 'CmdOrCtrl+Shift+X',
	'format-inline-code': 'CmdOrCtrl+Shift+C',
	'format-link': 'CmdOrCtrl+K',
	'format-body-text': 'CmdOrCtrl+Alt+0',
	'format-heading-1': 'CmdOrCtrl+Alt+1',
	'format-heading-2': 'CmdOrCtrl+Alt+2',
	'format-heading-3': 'CmdOrCtrl+Alt+3',
	'format-heading-4': 'CmdOrCtrl+Alt+4',
	'format-heading-5': 'CmdOrCtrl+Alt+5',
	'format-heading-6': 'CmdOrCtrl+Alt+6',
	'format-bulleted-list': 'CmdOrCtrl+Shift+8',
	'format-numbered-list': 'CmdOrCtrl+Shift+7',
	'format-task-list': 'CmdOrCtrl+Shift+L',
	'format-quote': 'CmdOrCtrl+Shift+Period',
	'format-code-block': 'CmdOrCtrl+Alt+C',
	'format-indent': 'CmdOrCtrl+]',
	'format-outdent': 'CmdOrCtrl+[',
};

/** Format の項目(チェックを持つものは checkable=真)。 */
function formatItem(id: FormatItemId, label: string, active: ActiveFormat | undefined, checkable: boolean): EditorMenuEntry {
	const accelerator = FORMAT_ACCELERATORS[id];
	return {
		kind: 'item',
		id,
		label,
		...(accelerator ? { accelerator } : {}),
		...(checkable ? { checked: active?.has(id) ?? false } : {}),
	};
}

/** 第3段 3-4: Markdown の面の Format ▸(モックの画面2 の 9)。 */
function formatMenu(active: ActiveFormat | undefined): EditorMenuEntry {
	const check = (id: FormatItemId, label: string) => formatItem(id, label, active, true);
	const plain = (id: FormatItemId, label: string) => formatItem(id, label, active, false);
	const headings = [1, 2, 3, 4, 5, 6].map((n) => check(`format-heading-${n}` as FormatItemId, `Heading ${n}`));
	return {
		kind: 'submenu',
		id: 'ctx-format-menu',
		label: 'Format',
		items: [
			check('format-bold', 'Bold'),
			check('format-italic', 'Italic'),
			check('format-strikethrough', 'Strikethrough'),
			check('format-inline-code', 'Inline Code'),
			plain('format-link', 'Link…'),
			{ kind: 'separator' },
			plain('format-clear', 'Clear Formatting'),
			{ kind: 'separator' },
			{
				kind: 'submenu',
				id: 'ctx-paragraph-menu',
				label: 'Paragraph',
				items: [
					check('format-body-text', 'Body Text'),
					...headings,
					{ kind: 'separator' },
					check('format-bulleted-list', 'Bulleted List'),
					check('format-numbered-list', 'Numbered List'),
					check('format-task-list', 'Task List'),
					check('format-quote', 'Quote'),
					check('format-code-block', 'Code Block'),
					{
						kind: 'submenu',
						id: 'ctx-alert-menu',
						label: 'Alert',
						items: [
							check('format-alert-note', 'Note'),
							check('format-alert-tip', 'Tip'),
							check('format-alert-important', 'Important'),
							check('format-alert-warning', 'Warning'),
							check('format-alert-caution', 'Caution'),
						],
					},
				],
			},
			{
				kind: 'submenu',
				id: 'ctx-insert-menu',
				label: 'Insert',
				items: [
					plain('format-insert-table', 'Table'),
					plain('format-insert-rule', 'Horizontal Rule'),
					plain('format-insert-footnote', 'Footnote'),
					plain('format-insert-image', 'Image…'),
				],
			},
		],
	};
}

/** 第3段 3-4: 表の中だけの Table ▸(3-2 と同じ 7 つ・アクセラレータもチェックも無い)。 */
function tableMenu(): EditorMenuEntry {
	const item = (id: FormatItemId, label: string): EditorMenuEntry => ({ kind: 'item', id, label });
	return {
		kind: 'submenu',
		id: 'ctx-table-menu',
		label: 'Table',
		items: [
			item('format-table-row-above', 'Insert Row Above'),
			item('format-table-row-below', 'Insert Row Below'),
			item('format-table-column-left', 'Insert Column Left'),
			item('format-table-column-right', 'Insert Column Right'),
			{ kind: 'separator' },
			item('format-table-delete-row', 'Delete Row'),
			item('format-table-delete-column', 'Delete Column'),
			item('format-table-delete', 'Delete Table'),
		],
	};
}

export const EDITOR_MENU_RELOAD_FILE = 'reload-file';
export const EDITOR_MENU_PIN = 'pin-to-bookmarks';
export const EDITOR_MENU_UNPIN = 'unpin-from-bookmarks';

/**
 * どの面でも Cut / Copy / Paste / ─ / Reload File / Pin to Bookmarks(済みなら Unpin from Bookmarks)。
 * 第3段 3-4: Markdown の面(rendered)だけ、区切り線の後に Format ▸(表の中なら続けて Table ▸)と区切り線が入る。
 */
export function buildEditorContextMenu(input: EditorContextMenuInput): EditorMenuEntry[] {
	const markdownMenus: EditorMenuEntry[] =
		input.surface === 'markdown' ? [formatMenu(input.active), ...(input.inTable ? [tableMenu()] : []), { kind: 'separator' }] : [];
	return [
		{ kind: 'predefined', item: 'Cut' },
		{ kind: 'predefined', item: 'Copy' },
		{ kind: 'predefined', item: 'Paste' },
		{ kind: 'separator' },
		...markdownMenus,
		{ kind: 'item', id: EDITOR_MENU_RELOAD_FILE, label: RELOAD_FILE_LABEL },
		input.pinned
			? { kind: 'item', id: EDITOR_MENU_UNPIN, label: 'Unpin from Bookmarks' }
			: { kind: 'item', id: EDITOR_MENU_PIN, label: 'Pin to Bookmarks' },
	];
}

/**
 * 要件#74 Issue #832: 表の行と列の頭の印のメニュー(T2=row・T3=column)。項目の名前は Format ▸ Table と同じ綴り(英語)。
 * 表ごと消す項目は入れない(Format ▸ Table ▸ Delete Table のまま)。id は `format-table-*`(ネイティブでは `ctx-` が付く)。
 */
export function buildTableHandleMenu(kind: 'row' | 'column'): EditorMenuEntry[] {
	const item = (id: string, label: string): EditorMenuEntry => ({ kind: 'item', id, label });
	if (kind === 'row') {
		return [
			item('format-table-row-above', 'Insert Row Above'),
			item('format-table-row-below', 'Insert Row Below'),
			item('format-table-duplicate-row', 'Duplicate Row'),
			{ kind: 'separator' },
			item('format-table-delete-row', 'Delete Row'),
		];
	}
	return [
		item('format-table-column-left', 'Insert Column Left'),
		item('format-table-column-right', 'Insert Column Right'),
		item('format-table-duplicate-column', 'Duplicate Column'),
		{ kind: 'separator' },
		item('format-table-delete-column', 'Delete Column'),
		{ kind: 'separator' },
		item('format-table-align-left', 'Align Left'),
		item('format-table-align-center', 'Align Center'),
		item('format-table-align-right', 'Align Right'),
	];
}
