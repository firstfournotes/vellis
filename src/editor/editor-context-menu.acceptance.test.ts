/**
 * 要件#74 第2段 2-6・第3段 3-4 — 編集面の文字の上の右クリックの純関数(契約8・契約17・由谷の決定 2026-11-17 朝 2-6 / 昼 3-15・3-16・
 * docs/review/req74-stage34-prep.md の (A) 6・(B) AC-74-27 (1))。
 *
 * 2-6 の範囲=Cut / Copy / Paste(定義済みの項目)・区切り線・Reload File(要件80)・Pin to Bookmarks / Unpin from Bookmarks(要件83)。
 * 3-4 で Markdown の編集面(rendered)だけに Format ▸(モックの画面2 の 9=Bold・Italic・Strikethrough・Inline Code・Link… / Clear Formatting /
 * Paragraph ▸・Insert ▸・今の装飾にチェック)と、表の中なら Table ▸(3-2 の 7 つ)が加わる。コード・plain text・raw は 2-6 の並びのまま。
 *
 * ## 確定契約(implementer はこれに従う=推奨名は stage34-prep の 6。無いものは test-writer が固定)
 *
 * ```ts
 * // --- src/editor/editor-context-menu.ts
 * export type EditorMenuEntry =
 *   | { kind: 'predefined'; item: 'Cut' | 'Copy' | 'Paste' }
 *   | { kind: 'separator' }
 *   | { kind: 'item'; id: string; label: string; accelerator?: string; checked?: boolean }
 *   | { kind: 'submenu'; id: string; label: string; items: EditorMenuEntry[] };
 * export type EditorSurface = 'markdown' | 'code' | 'raw';
 * export interface EditorContextMenuInput { surface: EditorSurface; inTable?: boolean; pinned: boolean; active?: ActiveFormat }
 * /** メニューバーの Format と同じアクセラレータの綴り(表示だけ。menu.rs の FORMAT_*_ACCELERATOR と同じ値)。 *\/
 * export const FORMAT_ACCELERATORS: Readonly<Partial<Record<FormatItemId, string>>>;
 * export function buildEditorContextMenu(input: EditorContextMenuInput): EditorMenuEntry[];
 * //   markdown: Cut / Copy / Paste / ─ / Format ▸ / (inTable なら Table ▸) / ─ / Reload File / Pin|Unpin
 * //   code・raw: Cut / Copy / Paste / ─ / Reload File / Pin|Unpin(2-6 のまま)
 * //   Format ▸(id 'ctx-format-menu'・label 'Format'): format-bold Bold / format-italic Italic / format-strikethrough Strikethrough /
 * //     format-inline-code Inline Code / format-link Link… / ─ / format-clear Clear Formatting / ─ /
 * //     Paragraph ▸('ctx-paragraph-menu'・'Paragraph'): format-body-text Body Text / format-heading-1〜6 Heading 1〜6 / ─ /
 * //       format-bulleted-list Bulleted List / format-numbered-list Numbered List / format-task-list Task List / format-quote Quote /
 * //       format-code-block Code Block / Alert ▸('ctx-alert-menu'・'Alert'): format-alert-note Note / -tip Tip / -important Important / -warning Warning / -caution Caution
 * //     Insert ▸('ctx-insert-menu'・'Insert'): format-insert-table Table / format-insert-rule Horizontal Rule / format-insert-footnote Footnote / format-insert-image Image…
 * //   Table ▸('ctx-table-menu'・'Table'): format-table-row-above Insert Row Above / -row-below Insert Row Below / -column-left Insert Column Left /
 * //     -column-right Insert Column Right / ─ / format-table-delete-row Delete Row / -delete-column Delete Column / format-table-delete Delete Table
 * //   チェック(checked: boolean)=mark 4 つ・Body Text・Heading 1〜6・リスト 3 つ・Quote・Code Block・Alert 5 つ(active にあれば true)。
 * //   Link… / Clear Formatting / Insert の項目 / Table の項目は checked を持たない。accelerator は FORMAT_ACCELERATORS にあるものだけ
 * ```
 *
 * ## 修正前に赤になる理由
 * - markdown の並びに Format ▸ / Table ▸ が無く、`FORMAT_ACCELERATORS` が無い(2-6 の実装のまま)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { RELOAD_FILE_LABEL } from '$lib/reload-file';
import type { FormatItemId } from './commands';
import { buildEditorContextMenu, FORMAT_ACCELERATORS, type EditorMenuEntry, type EditorSurface } from './editor-context-menu';

const SURFACES: EditorSurface[] = ['markdown', 'code', 'raw'];
const REPO_ROOT = resolve(__dirname, '../..');

function shape(entries: EditorMenuEntry[]): string[] {
	return entries.map((e) => {
		if (e.kind === 'predefined') return `predefined:${e.item}`;
		if (e.kind === 'separator') return '—';
		if (e.kind === 'item') return `item:${e.id}:${e.label}${e.checked ? ' ✓' : ''}`;
		return `submenu:${e.id}:${e.label}`;
	});
}
function submenu(entries: EditorMenuEntry[], id: string) {
	const found = entries.find((e) => e.kind === 'submenu' && e.id === id);
	if (!found || found.kind !== 'submenu') throw new Error(`submenu ${id} が無い`);
	return found;
}
function item(entries: EditorMenuEntry[], id: string) {
	const found = entries.find((e) => e.kind === 'item' && e.id === id);
	if (!found || found.kind !== 'item') throw new Error(`item ${id} が無い`);
	return found;
}
const TAIL = (pinned: boolean) => [`item:reload-file:${RELOAD_FILE_LABEL}`, pinned ? 'item:unpin-from-bookmarks:Unpin from Bookmarks' : 'item:pin-to-bookmarks:Pin to Bookmarks'];
const HEAD = ['predefined:Cut', 'predefined:Copy', 'predefined:Paste', '—'];

describe('AC-74-27 (1): コードの面と raw は 2-6 の並びのまま', () => {
	for (const surface of ['code', 'raw'] as EditorSurface[]) {
		test(`${surface}: Cut / Copy / Paste / ─ / Reload File / Pin(pinned=false)・Unpin(pinned=true)。inTable でも同じ`, () => {
			expect(shape(buildEditorContextMenu({ surface, pinned: false }))).toEqual([...HEAD, ...TAIL(false)]);
			expect(shape(buildEditorContextMenu({ surface, pinned: true }))).toEqual([...HEAD, ...TAIL(true)]);
			expect(shape(buildEditorContextMenu({ surface, inTable: true, pinned: false }))).toEqual([...HEAD, ...TAIL(false)]);
			expect(buildEditorContextMenu({ surface, pinned: false }).some((e) => e.kind === 'submenu')).toBe(false);
		});
	}

	test('Reload File のラベルは本文のメニューと同じ定数(RELOAD_FILE_LABEL = "Reload File")', () => {
		expect(RELOAD_FILE_LABEL).toBe('Reload File');
	});
});

describe('AC-74-27 (1): Markdown の編集面=Cut / Copy / Paste / ─ / Format ▸ / (Table ▸) / ─ / Reload File / Pin', () => {
	test('表の外: Format ▸ だけ(Table ▸ なし)', () => {
		const entries = buildEditorContextMenu({ surface: 'markdown', pinned: false });
		expect(shape(entries)).toEqual([...HEAD, 'submenu:ctx-format-menu:Format', '—', ...TAIL(false)]);
	});

	test('表の中: Format ▸ の直後に Table ▸。pinned なら Unpin', () => {
		const entries = buildEditorContextMenu({ surface: 'markdown', inTable: true, pinned: true });
		expect(shape(entries)).toEqual([...HEAD, 'submenu:ctx-format-menu:Format', 'submenu:ctx-table-menu:Table', '—', ...TAIL(true)]);
	});

	test('Format ▸ の中身(モックの画面2 の 9): Bold / Italic / Strikethrough / Inline Code / Link… / ─ / Clear Formatting / ─ / Paragraph ▸ / Insert ▸', () => {
		const format = submenu(buildEditorContextMenu({ surface: 'markdown', pinned: false }), 'ctx-format-menu');
		expect(shape(format.items)).toEqual([
			'item:format-bold:Bold',
			'item:format-italic:Italic',
			'item:format-strikethrough:Strikethrough',
			'item:format-inline-code:Inline Code',
			'item:format-link:Link…',
			'—',
			'item:format-clear:Clear Formatting',
			'—',
			'submenu:ctx-paragraph-menu:Paragraph',
			'submenu:ctx-insert-menu:Insert',
		]);
	});

	test('Paragraph ▸: Body Text / Heading 1〜6 / ─ / Bulleted List / Numbered List / Task List / Quote / Code Block / Alert ▸(5 種)', () => {
		const format = submenu(buildEditorContextMenu({ surface: 'markdown', pinned: false }), 'ctx-format-menu');
		const paragraph = submenu(format.items, 'ctx-paragraph-menu');
		expect(shape(paragraph.items)).toEqual([
			'item:format-body-text:Body Text',
			'item:format-heading-1:Heading 1',
			'item:format-heading-2:Heading 2',
			'item:format-heading-3:Heading 3',
			'item:format-heading-4:Heading 4',
			'item:format-heading-5:Heading 5',
			'item:format-heading-6:Heading 6',
			'—',
			'item:format-bulleted-list:Bulleted List',
			'item:format-numbered-list:Numbered List',
			'item:format-task-list:Task List',
			'item:format-quote:Quote',
			'item:format-code-block:Code Block',
			'submenu:ctx-alert-menu:Alert',
		]);
		const alert = submenu(paragraph.items, 'ctx-alert-menu');
		expect(shape(alert.items)).toEqual([
			'item:format-alert-note:Note',
			'item:format-alert-tip:Tip',
			'item:format-alert-important:Important',
			'item:format-alert-warning:Warning',
			'item:format-alert-caution:Caution',
		]);
	});

	test('Insert ▸: Table / Horizontal Rule / Footnote / Image…(Indent / Outdent は右クリックに無い)', () => {
		const format = submenu(buildEditorContextMenu({ surface: 'markdown', pinned: false }), 'ctx-format-menu');
		const insert = submenu(format.items, 'ctx-insert-menu');
		expect(shape(insert.items)).toEqual([
			'item:format-insert-table:Table',
			'item:format-insert-rule:Horizontal Rule',
			'item:format-insert-footnote:Footnote',
			'item:format-insert-image:Image…',
		]);
		const ids = new Set<string>();
		const walk = (list: EditorMenuEntry[]) => {
			for (const e of list) {
				if (e.kind === 'item') ids.add(e.id);
				if (e.kind === 'submenu') walk(e.items);
			}
		};
		walk(buildEditorContextMenu({ surface: 'markdown', inTable: true, pinned: false }));
		expect(ids.has('format-indent')).toBe(false);
		expect(ids.has('format-outdent')).toBe(false);
	});

	test('Table ▸(表の中だけ): 3-2 と同じ 7 つ(追加 4 / ─ / 削除 3・アクセラレータなし・チェックなし)', () => {
		const table = submenu(buildEditorContextMenu({ surface: 'markdown', inTable: true, pinned: false }), 'ctx-table-menu');
		expect(shape(table.items)).toEqual([
			'item:format-table-row-above:Insert Row Above',
			'item:format-table-row-below:Insert Row Below',
			'item:format-table-column-left:Insert Column Left',
			'item:format-table-column-right:Insert Column Right',
			'—',
			'item:format-table-delete-row:Delete Row',
			'item:format-table-delete-column:Delete Column',
			'item:format-table-delete:Delete Table',
		]);
		for (const e of table.items) {
			if (e.kind !== 'item') continue;
			expect(e.accelerator, e.id).toBeUndefined();
			expect(e.checked, e.id).toBeUndefined();
		}
		expect(buildEditorContextMenu({ surface: 'markdown', inTable: false, pinned: false }).some((e) => e.kind === 'submenu' && e.id === 'ctx-table-menu')).toBe(false);
	});

	test('チェック: active にある項目だけ checked=true。チェックを持つ項目は mark 4・Body Text・Heading 1〜6・リスト 3・Quote・Code Block・Alert 5。Link… / Clear / Insert は持たない', () => {
		const active = new Set<FormatItemId>(['format-bold', 'format-heading-2', 'format-quote', 'format-alert-tip']);
		const format = submenu(buildEditorContextMenu({ surface: 'markdown', pinned: false, active }), 'ctx-format-menu');
		const paragraph = submenu(format.items, 'ctx-paragraph-menu');
		const alert = submenu(paragraph.items, 'ctx-alert-menu');
		expect(item(format.items, 'format-bold').checked).toBe(true);
		expect(item(format.items, 'format-italic').checked).toBe(false);
		expect(item(format.items, 'format-strikethrough').checked).toBe(false);
		expect(item(format.items, 'format-inline-code').checked).toBe(false);
		expect(item(format.items, 'format-link').checked).toBeUndefined();
		expect(item(format.items, 'format-clear').checked).toBeUndefined();
		expect(item(paragraph.items, 'format-heading-2').checked).toBe(true);
		expect(item(paragraph.items, 'format-heading-1').checked).toBe(false);
		expect(item(paragraph.items, 'format-body-text').checked).toBe(false);
		expect(item(paragraph.items, 'format-quote').checked).toBe(true);
		expect(item(paragraph.items, 'format-bulleted-list').checked).toBe(false);
		expect(item(paragraph.items, 'format-code-block').checked).toBe(false);
		expect(item(alert.items, 'format-alert-tip').checked).toBe(true);
		expect(item(alert.items, 'format-alert-note').checked).toBe(false);
		const insert = submenu(format.items, 'ctx-insert-menu');
		for (const e of insert.items) if (e.kind === 'item') expect(e.checked, e.id).toBeUndefined();
		// active を省くと全部 false
		const none = submenu(buildEditorContextMenu({ surface: 'markdown', pinned: false }), 'ctx-format-menu');
		expect(item(none.items, 'format-bold').checked).toBe(false);
	});

	test('アクセラレータは表示だけで、メニューバー(menu.rs の FORMAT_*_ACCELERATOR)と同じ綴り。Link… にも付く。Clear / Insert / Alert には無い', () => {
		const rs = readFileSync(resolve(REPO_ROOT, 'src-tauri/src/menu.rs'), 'utf8');
		const fromRust = new Map<string, string>();
		for (const m of rs.matchAll(/pub const FORMAT_([A-Z0-9_]+)_ACCELERATOR: &str = "([^"]+)";/g)) {
			fromRust.set(`format-${m[1]!.toLowerCase().replace(/_/g, '-')}`, m[2]!);
		}
		expect(fromRust.size).toBeGreaterThanOrEqual(19);
		for (const [id, acc] of Object.entries(FORMAT_ACCELERATORS)) {
			expect(fromRust.get(id), `${id} のアクセラレータは menu.rs と同じ`).toBe(acc);
		}
		expect(FORMAT_ACCELERATORS['format-bold']).toBe('CmdOrCtrl+B');
		expect(FORMAT_ACCELERATORS['format-heading-2']).toBe('CmdOrCtrl+Alt+2');
		expect(FORMAT_ACCELERATORS['format-link']).toBe('CmdOrCtrl+K');
		expect(FORMAT_ACCELERATORS['format-clear']).toBeUndefined();
		expect(FORMAT_ACCELERATORS['format-insert-table']).toBeUndefined();
		expect(FORMAT_ACCELERATORS['format-alert-note']).toBeUndefined();

		const format = submenu(buildEditorContextMenu({ surface: 'markdown', pinned: false }), 'ctx-format-menu');
		const paragraph = submenu(format.items, 'ctx-paragraph-menu');
		expect(item(format.items, 'format-bold').accelerator).toBe('CmdOrCtrl+B');
		expect(item(format.items, 'format-link').accelerator).toBe('CmdOrCtrl+K');
		expect(item(format.items, 'format-clear').accelerator).toBeUndefined();
		expect(item(paragraph.items, 'format-heading-2').accelerator).toBe('CmdOrCtrl+Alt+2');
		expect(item(paragraph.items, 'format-quote').accelerator).toBe('CmdOrCtrl+Shift+Period');
		const insert = submenu(format.items, 'ctx-insert-menu');
		for (const e of insert.items) if (e.kind === 'item') expect(e.accelerator, e.id).toBeUndefined();
	});

	test('定義済みの項目は Cut / Copy / Paste の 3 つだけで先頭。ID は重複しない。純関数(入力を変えない・毎回新しい配列)', () => {
		for (const surface of SURFACES) {
			for (const inTable of [false, true]) {
				const input = { surface, inTable, pinned: false, active: new Set<FormatItemId>(['format-bold']) };
				const entries = buildEditorContextMenu(input);
				const predefined = entries.filter((e) => e.kind === 'predefined');
				expect(predefined.map((e) => (e as { item: string }).item)).toEqual(['Cut', 'Copy', 'Paste']);
				expect(entries.slice(0, 3)).toEqual(predefined);
				const ids: string[] = [];
				const walk = (list: EditorMenuEntry[]) => {
					for (const e of list) {
						if (e.kind === 'item' || e.kind === 'submenu') ids.push(e.id);
						if (e.kind === 'submenu') walk(e.items);
					}
				};
				walk(entries);
				expect(new Set(ids).size, `${surface} inTable=${inTable}: ID の重複`).toBe(ids.length);
				expect(buildEditorContextMenu(input)).toEqual(entries);
				expect(buildEditorContextMenu(input)).not.toBe(entries);
				expect(input).toEqual({ surface, inTable, pinned: false, active: new Set(['format-bold']) });
			}
		}
	});
});
