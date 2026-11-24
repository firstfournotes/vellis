/**
 * 要件#74 第4段 4-2 — 書式のツールバーの純関数と定数(要件56 のモックの画面2 の 5・6・由谷の決定 2026-11-17 午後 4-5=既定は隠す・
 * ツールバーの「A」と View ▸ Show Formatting Toolbar で出す・状態はアプリ全体で 1 つ/4-6=中身はモックどおり)。
 * 正本: docs/review/req74-stage34-prep.md の (C) 2 と (D) AC-74-62。配線は FormatToolbar.wiring.test.ts。
 *
 * ## 確定契約(implementer はこれに従う=推奨名は stage34-prep の (C) 2)
 *
 * ```ts
 * // --- src/editor/format-toolbar.ts(新規)
 * export const MENU_SHOW_FORMAT_TOOLBAR_EVENT = 'menu_show_format_toolbar';   // Rust → 前面の窓(View ▸ Show Formatting Toolbar)
 * export const FORMAT_TOOLBAR_STATE_EVENT = 'format_toolbar_state';           // 窓 → Rust { label, shown }(raw_source_state と同じ形=チェック印)
 * export const FORMAT_TOOLBAR_STORAGE_KEY = 'vellis.formatToolbar';           // localStorage('true' / 'false')。既定=隠す。読めなければ既定
 * /** 段落の種類の選択(select)の値(モックの順)。 *\/
 * export const FORMAT_TOOLBAR_BLOCK_TYPES: readonly FormatItemId[];          // body-text, heading-1 … heading-6
 * /** ボタンの並び(モックの順)。'|' は組の区切り。 *\/
 * export const FORMAT_TOOLBAR_ITEMS: readonly (FormatItemId | '|')[];
 * //   bold, italic, strikethrough, inline-code, link | bulleted-list, numbered-list, task-list, quote | insert-table, code-block, insert-image, insert-footnote | clear
 * /** title=英語の名前+キー名(キーのある項目だけ)。例 'Bold (Command + B)'・'Clear Formatting'。 *\/
 * export function formatToolbarTitle(id: FormatItemId): string;
 * /** localStorage の値 → 出すか(既定 false。'true' だけ真)。 *\/
 * export function readFormatToolbarShown(storage: Pick<Storage, 'getItem'> | null): boolean;
 * ```
 *
 * ## 修正前に赤になる理由
 * - `src/editor/format-toolbar.ts` が無いので import で落ちる
 */
import { describe, expect, test } from 'vitest';
import {
	FORMAT_TOOLBAR_BLOCK_TYPES,
	FORMAT_TOOLBAR_ITEMS,
	FORMAT_TOOLBAR_STATE_EVENT,
	FORMAT_TOOLBAR_STORAGE_KEY,
	MENU_SHOW_FORMAT_TOOLBAR_EVENT,
	formatToolbarTitle,
	readFormatToolbarShown,
	SELECTION_BAR_ITEMS,
	SELECTION_BAR_SETTLE_MS,
	selectionBarPosition,
} from './format-toolbar';
import { FORMAT_ACCELERATORS } from './editor-context-menu';
import type { FormatItemId } from './commands';

describe('AC-74-62: 定数', () => {
	test('イベント名と localStorage のキー', () => {
		expect(MENU_SHOW_FORMAT_TOOLBAR_EVENT).toBe('menu_show_format_toolbar');
		expect(FORMAT_TOOLBAR_STATE_EVENT).toBe('format_toolbar_state');
		expect(FORMAT_TOOLBAR_STORAGE_KEY).toBe('vellis.formatToolbar');
	});
});

describe('AC-74-62: 中身はモックの順(4-6)', () => {
	test('段落の種類の選択= Body Text / Heading 1〜6', () => {
		expect([...FORMAT_TOOLBAR_BLOCK_TYPES]).toEqual([
			'format-body-text',
			'format-heading-1',
			'format-heading-2',
			'format-heading-3',
			'format-heading-4',
			'format-heading-5',
			'format-heading-6',
		]);
	});

	test('ボタン= 文字の装飾 5 | リスト 3 と引用 | 表 / Code Block / 画像 / 脚注 | Clear Formatting(Indent / Outdent / Alert は無い)', () => {
		expect([...FORMAT_TOOLBAR_ITEMS]).toEqual([
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
		]);
		const ids = (FORMAT_TOOLBAR_ITEMS as readonly string[]).filter((x: string) => x !== '|');
		expect(new Set(ids).size).toBe(ids.length);
		for (const absent of ['format-indent', 'format-outdent', 'format-alert-note', 'format-insert-rule']) expect(ids).not.toContain(absent);
	});
});

describe('AC-74-62: title は英語の名前+キー名(Command + …)。キーの無い項目は名前だけ', () => {
	test.each([
		['format-bold', 'Bold (Command + B)'],
		['format-italic', 'Italic (Command + I)'],
		['format-strikethrough', 'Strikethrough (Command + Shift + X)'],
		['format-inline-code', 'Inline Code (Command + Shift + C)'],
		['format-link', 'Link… (Command + K)'],
		['format-bulleted-list', 'Bulleted List (Command + Shift + 8)'],
		['format-numbered-list', 'Numbered List (Command + Shift + 7)'],
		['format-task-list', 'Task List (Command + Shift + L)'],
		['format-quote', 'Quote (Command + Shift + .)'],
		['format-code-block', 'Code Block (Command + Option + C)'],
		['format-heading-2', 'Heading 2 (Command + Option + 2)'],
		['format-insert-table', 'Table'],
		['format-insert-image', 'Image…'],
		['format-insert-footnote', 'Footnote'],
		['format-clear', 'Clear Formatting'],
	] as Array<[FormatItemId, string]>)('%s → %s', (id, title) => {
		expect(formatToolbarTitle(id)).toBe(title);
	});

	test('キーの綴りはメニューバーの FORMAT_ACCELERATORS から(CmdOrCtrl → Command・Alt → Option・Shift・Period → .)', () => {
		for (const id of FORMAT_TOOLBAR_ITEMS as readonly (FormatItemId | '|')[]) {
			if (id === '|') continue;
			const acc = FORMAT_ACCELERATORS[id];
			const title = formatToolbarTitle(id);
			if (acc) {
				expect(title, id).toMatch(/\(Command( \+ (Shift|Option))*( \+ .+)\)$/);
				expect(title, id).not.toContain('CmdOrCtrl');
				expect(title, id).not.toContain('Alt');
			} else {
				expect(title, id).not.toContain('(');
			}
		}
	});
});

describe('AC-74-62: 状態の読み方(既定=隠す・アプリ全体で 1 つ=localStorage)', () => {
	const storage = (value: string | null) => ({ getItem: (_k: string) => value });
	test("'true' だけ真。null / 'false' / 変な値 / storage 無しは既定(隠す)", () => {
		expect(readFormatToolbarShown(storage('true'))).toBe(true);
		expect(readFormatToolbarShown(storage('false'))).toBe(false);
		expect(readFormatToolbarShown(storage(null))).toBe(false);
		expect(readFormatToolbarShown(storage('yes'))).toBe(false);
		expect(readFormatToolbarShown(null)).toBe(false);
	});
	test('読めない storage(getItem が投げる)でも既定', () => {
		expect(
			readFormatToolbarShown({
				getItem: () => {
					throw new Error('blocked');
				},
			}),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 要件74 第4段 4-3 — 浮遊バー(モックの画面2 の 8・由谷の決定 4-7)の定数と純関数。配線は SelectionBar.wiring.test.ts
//
// 確定契約(src/editor/format-toolbar.ts に足す):
//   export const SELECTION_BAR_ITEMS: readonly (FormatItemId | '|')[];   // bold, italic, strikethrough, inline-code, link | clear(段落の種類は select で先頭)
//   export const SELECTION_BAR_SETTLE_MS = 300;                            // キーボードの選択が落ち着くまで
//   /** 選択の矩形(view.coordsAtPos の left/top/bottom)とバーの大きさ・置ける範囲(面の矩形)から、選択のすぐ上(上に入らなければ下)の位置。
//    *  左右は範囲の内側に収める(はみ出さない)。 */
//   export function selectionBarPosition(input: { anchor: { left: number; top: number; bottom: number }; bar: { width: number; height: number };
//     bounds: { left: number; top: number; right: number; bottom: number }; gap?: number }): { left: number; top: number; placement: 'above' | 'below' };
// ---------------------------------------------------------------------------

describe('AC-74-63: 浮遊バーの中身と位置(純関数)', () => {
	test('中身= Bold / Italic / Strikethrough / Inline Code / Link… | Clear Formatting(リストや Insert は無い)', () => {
		expect([...SELECTION_BAR_ITEMS]).toEqual(['format-bold', 'format-italic', 'format-strikethrough', 'format-inline-code', 'format-link', '|', 'format-clear']);
		expect(SELECTION_BAR_SETTLE_MS).toBe(300);
	});

	const bounds = { left: 0, top: 0, right: 800, bottom: 600 };
	test('上に入れば選択のすぐ上(top = anchor.top - gap - 高さ)。left は選択の左', () => {
		const p = selectionBarPosition({ anchor: { left: 120, top: 300, bottom: 320 }, bar: { width: 200, height: 32 }, bounds, gap: 8 });
		expect(p.placement).toBe('above');
		expect(p.top).toBe(300 - 8 - 32);
		expect(p.left).toBe(120);
	});
	test('上に入らなければ下(top = anchor.bottom + gap)', () => {
		const p = selectionBarPosition({ anchor: { left: 120, top: 10, bottom: 30 }, bar: { width: 200, height: 32 }, bounds, gap: 8 });
		expect(p.placement).toBe('below');
		expect(p.top).toBe(30 + 8);
	});
	test('左右は面の内側に収める(右端に寄った選択は左へ・左端より左には出ない)', () => {
		const right = selectionBarPosition({ anchor: { left: 750, top: 300, bottom: 320 }, bar: { width: 200, height: 32 }, bounds, gap: 8 });
		expect(right.left).toBe(800 - 200);
		const left = selectionBarPosition({ anchor: { left: -20, top: 300, bottom: 320 }, bar: { width: 200, height: 32 }, bounds, gap: 8 });
		expect(left.left).toBe(0);
	});
	test('面がバーより狭ければ左端に合わせる(負にならない)', () => {
		const p = selectionBarPosition({ anchor: { left: 50, top: 300, bottom: 320 }, bar: { width: 500, height: 32 }, bounds: { left: 0, top: 0, right: 300, bottom: 600 }, gap: 8 });
		expect(p.left).toBe(0);
	});
	test('gap の既定は 8', () => {
		const p = selectionBarPosition({ anchor: { left: 120, top: 300, bottom: 320 }, bar: { width: 200, height: 32 }, bounds });
		expect(p.top).toBe(300 - 8 - 32);
	});
});
