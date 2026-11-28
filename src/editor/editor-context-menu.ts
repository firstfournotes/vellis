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
import type { TableHandleItemId } from './table-commands';
import type { ActiveFormat } from './active-format';

/** メニューの 1 項目。`predefined` は OS の定義済みの項目(クリップボードは JS を通らない)。 */
export type EditorMenuEntry =
	| { kind: 'predefined'; item: 'Cut' | 'Copy' | 'Paste' }
	| { kind: 'separator' }
	| {
			kind: 'item';
			id: string;
			label: string;
			accelerator?: string;
			checked?: boolean;
			/**
			 * ネイティブの項目の id(省略=`id` から決める)。メニューバーにも同じ id の項目があると、Rust の on_menu_event が
			 * メニューバーの命令として前面の窓へも送り、JS の action と 2 回走る(Issue #822)。そういう項目は別の id にする
			 */
			nativeId?: string;
	  }
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

/**
 * Format の項目の英語の名前(メニューバーの Format と同じ綴り=menu.rs)。右クリックの Format ▸ / Table ▸・表の印のメニュー・
 * 書式のツールバーと浮遊バーが、この 1 つの表から引く。
 */
/**
 * 名前を持つ Format の項目。インデント(キーだけ)と表の端の +(印だけ)は名前を引かない。
 * 表を `Record` にして、項目を足したときに名前の書き忘れ・綴りの誤りを `pnpm check` で止める。
 */
export type FormatNamedItemId =
	| Exclude<FormatItemId, 'format-indent' | 'format-outdent'>
	| Exclude<TableHandleItemId, 'format-table-append-row' | 'format-table-append-column'>;

export const FORMAT_ITEM_NAMES: Readonly<Record<FormatNamedItemId, string>> = {
	'format-bold': 'Bold',
	'format-italic': 'Italic',
	'format-strikethrough': 'Strikethrough',
	'format-inline-code': 'Inline Code',
	'format-link': 'Link…',
	'format-clear': 'Clear Formatting',
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
	'format-alert-note': 'Note',
	'format-alert-tip': 'Tip',
	'format-alert-important': 'Important',
	'format-alert-warning': 'Warning',
	'format-alert-caution': 'Caution',
	'format-insert-table': 'Table',
	'format-insert-rule': 'Horizontal Rule',
	'format-insert-footnote': 'Footnote',
	'format-insert-image': 'Image…',
	'format-table-row-above': 'Insert Row Above',
	'format-table-row-below': 'Insert Row Below',
	'format-table-column-left': 'Insert Column Left',
	'format-table-column-right': 'Insert Column Right',
	'format-table-delete-row': 'Delete Row',
	'format-table-delete-column': 'Delete Column',
	'format-table-delete': 'Delete Table',
	'format-table-duplicate-row': 'Duplicate Row',
	'format-table-duplicate-column': 'Duplicate Column',
	'format-table-align-left': 'Align Left',
	'format-table-align-center': 'Align Center',
	'format-table-align-right': 'Align Right',
};

/** 名前だけの項目(アクセラレータもチェックも無い)。 */
function namedItem(id: FormatNamedItemId): EditorMenuEntry {
	return { kind: 'item', id, label: FORMAT_ITEM_NAMES[id] };
}

/** Format の項目(チェックを持つものは checkable=真)。 */
function formatItem(id: FormatItemId & FormatNamedItemId, active: ActiveFormat | undefined, checkable: boolean): EditorMenuEntry {
	const accelerator = FORMAT_ACCELERATORS[id];
	return {
		...namedItem(id),
		...(accelerator ? { accelerator } : {}),
		...(checkable ? { checked: active?.has(id) ?? false } : {}),
	};
}

/** 第3段 3-4: Markdown の面の Format ▸(モックの画面2 の 9)。 */
function formatMenu(active: ActiveFormat | undefined): EditorMenuEntry {
	const check = (id: FormatItemId & FormatNamedItemId) => formatItem(id, active, true);
	const plain = (id: FormatItemId & FormatNamedItemId) => formatItem(id, active, false);
	const headings = [1, 2, 3, 4, 5, 6].map((n) => check(`format-heading-${n}` as FormatItemId & FormatNamedItemId));
	return {
		kind: 'submenu',
		id: 'ctx-format-menu',
		label: 'Format',
		items: [
			check('format-bold'),
			check('format-italic'),
			check('format-strikethrough'),
			check('format-inline-code'),
			plain('format-link'),
			{ kind: 'separator' },
			plain('format-clear'),
			{ kind: 'separator' },
			{
				kind: 'submenu',
				id: 'ctx-paragraph-menu',
				label: 'Paragraph',
				items: [
					check('format-body-text'),
					...headings,
					{ kind: 'separator' },
					check('format-bulleted-list'),
					check('format-numbered-list'),
					check('format-task-list'),
					check('format-quote'),
					check('format-code-block'),
					{
						kind: 'submenu',
						id: 'ctx-alert-menu',
						label: 'Alert',
						items: [
							check('format-alert-note'),
							check('format-alert-tip'),
							check('format-alert-important'),
							check('format-alert-warning'),
							check('format-alert-caution'),
						],
					},
				],
			},
			{
				kind: 'submenu',
				id: 'ctx-insert-menu',
				label: 'Insert',
				items: [
					plain('format-insert-table'),
					plain('format-insert-rule'),
					plain('format-insert-footnote'),
					plain('format-insert-image'),
				],
			},
		],
	};
}

/** 第3段 3-4: 表の中だけの Table ▸(3-2 と同じ 7 つ・アクセラレータもチェックも無い)。 */
function tableMenu(): EditorMenuEntry {
	return {
		kind: 'submenu',
		id: 'ctx-table-menu',
		label: 'Table',
		items: [
			namedItem('format-table-row-above'),
			namedItem('format-table-row-below'),
			namedItem('format-table-column-left'),
			namedItem('format-table-column-right'),
			{ kind: 'separator' },
			namedItem('format-table-delete-row'),
			namedItem('format-table-delete-column'),
			namedItem('format-table-delete'),
		],
	};
}

export const EDITOR_MENU_RELOAD_FILE = 'reload-file';
/**
 * 右クリックの Reload File のネイティブの id(Issue #822)。`reload-file` はメニューバーの View ▸ Reload File
 * (menu.rs の `RELOAD_FILE_ITEM_ID`)と同じで、Rust が menu_reload_file も送って読み直しが 2 回走るので別の id にする
 * (Format の項目の `ctx-` と同じ扱い=要件#74 事後確認 (16))。onAction に渡るのは `EDITOR_MENU_RELOAD_FILE` のまま。
 */
export const EDITOR_MENU_RELOAD_FILE_NATIVE_ID = 'ctx-reload-file';
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
		{ kind: 'item', id: EDITOR_MENU_RELOAD_FILE, label: RELOAD_FILE_LABEL, nativeId: EDITOR_MENU_RELOAD_FILE_NATIVE_ID },
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
	if (kind === 'row') {
		return [
			namedItem('format-table-row-above'),
			namedItem('format-table-row-below'),
			namedItem('format-table-duplicate-row'),
			{ kind: 'separator' },
			namedItem('format-table-delete-row'),
		];
	}
	return [
		namedItem('format-table-column-left'),
		namedItem('format-table-column-right'),
		namedItem('format-table-duplicate-column'),
		{ kind: 'separator' },
		namedItem('format-table-delete-column'),
		{ kind: 'separator' },
		namedItem('format-table-align-left'),
		namedItem('format-table-align-center'),
		namedItem('format-table-align-right'),
	];
}
