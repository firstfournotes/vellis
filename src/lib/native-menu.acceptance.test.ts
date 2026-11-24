/**
 * 要件#74 第2段 2-6 — ネイティブのポップアップ(`src/lib/native-menu.ts`)= Tauri の JS の menu API(`@tauri-apps/api/menu`)への写し
 * (契約8・由谷の決定 2026-11-17 朝・stage34-prep の 3-15)。依存・Tauri command・capability は増やさない(`core:menu:default` は `core:default` の中)。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * ```ts
 * // --- src/lib/native-menu.ts(新規)
 * import { Menu, MenuItem, PredefinedMenuItem, Submenu, CheckMenuItem } from '@tauri-apps/api/menu';
 * /** entries を Tauri の menu に写して popup する。項目を押すと onAction(id)。 *\/
 * export async function popupMenu(entries: EditorMenuEntry[], onAction: (id: string) => void, at?: { x: number; y: number }): Promise<void>;
 * //   predefined → PredefinedMenuItem.new({ item })・separator → PredefinedMenuItem.new({ item: 'Separator' })
 * //   item → MenuItem.new({ id, text: label, accelerator?, action: () => onAction(id) })(checked があれば CheckMenuItem.new({ …, checked }))
 * //   submenu → Submenu.new({ id, text: label, items })・Menu.new({ items }) → menu.popup(at があれば LogicalPosition(x, y))
 * //   Cut / Copy / Paste は JS を通らない(navigator.clipboard を呼ばない)。popup の例外は console.error に残して投げない
 * ```
 *
 * ## 修正前に赤になる理由
 * - `src/lib/native-menu.ts` が無いので import で落ちる
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Made = { kind: string; opts: Record<string, unknown> };
const made: Made[] = [];
const popupMock = vi.fn(async (_at?: unknown) => undefined);

vi.mock('@tauri-apps/api/menu', () => {
	const make = (kind: string) => ({
		new: vi.fn(async (opts: Record<string, unknown> = {}) => {
			const item = { kind, opts, id: opts.id };
			made.push({ kind, opts });
			return item;
		}),
	});
	return {
		Menu: { new: vi.fn(async (opts: Record<string, unknown> = {}) => ({ kind: 'Menu', opts, popup: popupMock })) },
		MenuItem: make('MenuItem'),
		PredefinedMenuItem: make('PredefinedMenuItem'),
		Submenu: make('Submenu'),
		CheckMenuItem: make('CheckMenuItem'),
		IconMenuItem: make('IconMenuItem'),
	};
});
vi.mock('@tauri-apps/api/dpi', () => ({
	LogicalPosition: class {
		constructor(
			public x: number,
			public y: number,
		) {}
	},
	PhysicalPosition: class {
		constructor(
			public x: number,
			public y: number,
		) {}
	},
}));

import { Menu } from '@tauri-apps/api/menu';
import { popupMenu } from './native-menu';
import type { EditorMenuEntry } from '../editor/editor-context-menu';

const ENTRIES: EditorMenuEntry[] = [
	{ kind: 'predefined', item: 'Cut' },
	{ kind: 'predefined', item: 'Copy' },
	{ kind: 'predefined', item: 'Paste' },
	{ kind: 'separator' },
	{ kind: 'item', id: 'reload-file', label: 'Reload File' },
	{ kind: 'item', id: 'pin-to-bookmarks', label: 'Pin to Bookmarks' },
];

beforeEach(() => {
	made.length = 0;
	popupMock.mockClear();
	vi.mocked(Menu.new).mockClear();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe('AC-74-27(2-6 の分): popupMenu は entries を Tauri の menu API に写して popup する', () => {
	test('定義済み 3 つ・区切り線・項目 2 つが順に作られ、Menu.new({ items }) → popup が 1 回', async () => {
		const onAction = vi.fn();
		await popupMenu(ENTRIES, onAction, { x: 10, y: 20 });
		expect(made.map((m) => `${m.kind}:${m.opts.item ?? m.opts.id}`)).toEqual([
			'PredefinedMenuItem:Cut',
			'PredefinedMenuItem:Copy',
			'PredefinedMenuItem:Paste',
			'PredefinedMenuItem:Separator',
			'MenuItem:reload-file',
			'MenuItem:pin-to-bookmarks',
		]);
		expect(vi.mocked(Menu.new)).toHaveBeenCalledTimes(1);
		const menuOpts = vi.mocked(Menu.new).mock.calls[0]![0] as { items: unknown[] };
		expect(menuOpts.items).toHaveLength(6);
		expect(popupMock).toHaveBeenCalledTimes(1);
		const at = popupMock.mock.calls[0]![0] as { x?: number; y?: number } | undefined;
		if (at !== undefined) {
			expect(at.x).toBe(10);
			expect(at.y).toBe(20);
		}
	});

	test('項目のラベルは text・id は id。action を呼ぶと onAction(id)(Cut / Copy / Paste は action を持たない=ネイティブ)', async () => {
		const onAction = vi.fn();
		await popupMenu(ENTRIES, onAction);
		const reload = made.find((m) => m.opts.id === 'reload-file')!;
		expect(reload.kind).toBe('MenuItem');
		expect(reload.opts.text).toBe('Reload File');
		expect(typeof reload.opts.action).toBe('function');
		(reload.opts.action as () => void)();
		expect(onAction).toHaveBeenCalledWith('reload-file');
		const pin = made.find((m) => m.opts.id === 'pin-to-bookmarks')!;
		(pin.opts.action as () => void)();
		expect(onAction).toHaveBeenLastCalledWith('pin-to-bookmarks');
		expect(onAction).toHaveBeenCalledTimes(2);
		for (const m of made.filter((x) => x.kind === 'PredefinedMenuItem')) expect(m.opts.action).toBeUndefined();
	});

	test('位置を渡さなければ popup() は位置なし(カーソルの位置)で呼ばれる', async () => {
		await popupMenu(ENTRIES, vi.fn());
		expect(popupMock).toHaveBeenCalledTimes(1);
		expect(popupMock.mock.calls[0]![0]).toBeUndefined();
	});

	test('accelerator は表示だけ(MenuItem.new の accelerator に写す)・checked のある項目は CheckMenuItem', async () => {
		await popupMenu(
			[
				{ kind: 'item', id: 'format-bold', label: 'Bold', accelerator: 'CmdOrCtrl+B', checked: true },
				{ kind: 'item', id: 'raw-source', label: 'Raw Source', checked: false },
			],
			vi.fn(),
		);
		// 事後確認 (16): Format の項目のネイティブの id はメニューバーと別(`format-` で始めない)なので文言で探す
		const bold = made.find((m) => m.opts.text === 'Bold')!;
		expect(bold.kind).toBe('CheckMenuItem');
		expect(bold.opts.accelerator).toBe('CmdOrCtrl+B');
		expect(bold.opts.checked).toBe(true);
		const raw = made.find((m) => m.opts.id === 'raw-source')!;
		expect(raw.kind).toBe('CheckMenuItem');
		expect(raw.opts.checked).toBe(false);
	});

	test('submenu は Submenu.new({ id, text, items })(第3段の Format ▸ の準備=中身の順も保つ)', async () => {
		await popupMenu(
			[
				{
					kind: 'submenu',
					id: 'ctx-format-menu',
					label: 'Format',
					items: [
						{ kind: 'item', id: 'format-bold', label: 'Bold' },
						{ kind: 'separator' },
						{ kind: 'item', id: 'format-clear', label: 'Clear Formatting' },
					],
				},
			],
			vi.fn(),
		);
		const sub = made.find((m) => m.kind === 'Submenu')!;
		expect(sub.opts.id).toBe('ctx-format-menu');
		expect(sub.opts.text).toBe('Format');
		expect((sub.opts.items as unknown[]).length).toBe(3);
		// 中身は Submenu より先に作られている
		expect(made.findIndex((m) => m.opts.text === 'Bold')).toBeLessThan(made.indexOf(sub));
	});

	test('navigator.clipboard を呼ばない(Cut / Copy / Paste はネイティブ)', async () => {
		const clip = { readText: vi.fn(), writeText: vi.fn() };
		Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true });
		await popupMenu(ENTRIES, vi.fn());
		expect(clip.readText).not.toHaveBeenCalled();
		expect(clip.writeText).not.toHaveBeenCalled();
	});

	test('popup が失敗しても投げない(console.error に 1 回)', async () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		popupMock.mockRejectedValueOnce(new Error('no window'));
		await expect(popupMenu(ENTRIES, vi.fn())).resolves.toBeUndefined();
		expect(err).toHaveBeenCalledTimes(1);
	});
});

describe('AC-74-27(3-4 の分): 3 段の入れ子(Format ▸ Paragraph ▸ Alert ▸)も順に写す', () => {
	test('submenu の中の submenu の中の CheckMenuItem まで作られ、順と親子が保たれる', async () => {
		const onAction = vi.fn();
		await popupMenu(
			[
				{ kind: 'predefined', item: 'Cut' },
				{
					kind: 'submenu',
					id: 'ctx-format-menu',
					label: 'Format',
					items: [
						{ kind: 'item', id: 'format-bold', label: 'Bold', accelerator: 'CmdOrCtrl+B', checked: true },
						{ kind: 'separator' },
						{
							kind: 'submenu',
							id: 'ctx-paragraph-menu',
							label: 'Paragraph',
							items: [
								{ kind: 'item', id: 'format-heading-2', label: 'Heading 2', accelerator: 'CmdOrCtrl+Alt+2', checked: false },
								{ kind: 'submenu', id: 'ctx-alert-menu', label: 'Alert', items: [{ kind: 'item', id: 'format-alert-note', label: 'Note', checked: true }] },
							],
						},
					],
				},
				{ kind: 'submenu', id: 'ctx-table-menu', label: 'Table', items: [{ kind: 'item', id: 'format-table-delete', label: 'Delete Table' }] },
			],
			onAction,
		);
		// 事後確認 (16): Format の項目のネイティブの id はメニューバーと別(`format-` で始めない)なので、項目は文言で見る
		const byText = (text: string) => made.find((m) => m.opts.text === text)!;
		expect(made.map((m) => `${m.kind}:${m.opts.item ?? (m.kind === 'Submenu' ? m.opts.id : m.opts.text)}`)).toEqual([
			'PredefinedMenuItem:Cut',
			'CheckMenuItem:Bold',
			'PredefinedMenuItem:Separator',
			'CheckMenuItem:Heading 2',
			'CheckMenuItem:Note',
			'Submenu:ctx-alert-menu',
			'Submenu:ctx-paragraph-menu',
			'Submenu:ctx-format-menu',
			'MenuItem:Delete Table',
			'Submenu:ctx-table-menu',
		]);
		const alert = made.find((m) => m.opts.id === 'ctx-alert-menu')!;
		expect((alert.opts.items as Array<{ id: string }>).map((i) => i.id)).toEqual([byText('Note').opts.id]);
		const paragraph = made.find((m) => m.opts.id === 'ctx-paragraph-menu')!;
		expect((paragraph.opts.items as Array<{ id: string }>).map((i) => i.id)).toEqual([byText('Heading 2').opts.id, 'ctx-alert-menu']);
		(byText('Note').opts.action as () => void)();
		expect(onAction).toHaveBeenCalledWith('format-alert-note');
		expect(popupMock).toHaveBeenCalledTimes(1);
	});
});

// 要件74 実機ゲート (2)・事後確認 (16)(2026-11-18): 右クリックの Format の項目は、ネイティブの id をメニューバーと別にする
// (Rust の on_menu_event は `format-` 始まりを menu_format として前面の窓へ送るので、同じ id だと JS の action と 2 回走る)。
// entry の id(onAction に渡す)は今のまま。修正前は entry の id をそのまま写すので赤。
describe('実機ゲート (2) 事後確認 (16): Format の項目のネイティブの id は `format-` で始まらず、onAction には entry の id', () => {
	test('Bold・Heading 2・Note・Delete Table: ネイティブの id は `format-` で始まらず、互いに重ならない。action は onAction(entry の id)', async () => {
		const onAction = vi.fn();
		await popupMenu(
			[
				{
					kind: 'submenu',
					id: 'ctx-format-menu',
					label: 'Format',
					items: [
						{ kind: 'item', id: 'format-bold', label: 'Bold', accelerator: 'CmdOrCtrl+B', checked: false },
						{
							kind: 'submenu',
							id: 'ctx-paragraph-menu',
							label: 'Paragraph',
							items: [
								{ kind: 'item', id: 'format-heading-2', label: 'Heading 2', checked: false },
								{ kind: 'submenu', id: 'ctx-alert-menu', label: 'Alert', items: [{ kind: 'item', id: 'format-alert-note', label: 'Note', checked: false }] },
							],
						},
					],
				},
				{ kind: 'submenu', id: 'ctx-table-menu', label: 'Table', items: [{ kind: 'item', id: 'format-table-delete', label: 'Delete Table' }] },
				{ kind: 'item', id: 'pin-to-bookmarks', label: 'Pin to Bookmarks' },
			],
			onAction,
		);
		const cases: Array<[string, string]> = [
			['Bold', 'format-bold'],
			['Heading 2', 'format-heading-2'],
			['Note', 'format-alert-note'],
			['Delete Table', 'format-table-delete'],
		];
		const ids: string[] = [];
		for (const [label, entryId] of cases) {
			const item = made.find((m) => m.opts.text === label)!;
			expect(item, label).toBeTruthy();
			const id = item.opts.id as string | undefined;
			if (id !== undefined) {
				expect(id.startsWith('format-'), `${label} のネイティブの id ${id} がメニューバーの Format と同じ接頭辞`).toBe(false);
				ids.push(id);
			}
			(item.opts.action as () => void)();
			expect(onAction, label).toHaveBeenLastCalledWith(entryId);
		}
		expect(new Set(ids).size, 'ネイティブの id は互いに重ならない').toBe(ids.length);
		// Format でない項目は今のまま(id は entry の id)
		expect(made.find((m) => m.opts.text === 'Pin to Bookmarks')!.opts.id).toBe('pin-to-bookmarks');
	});
});
