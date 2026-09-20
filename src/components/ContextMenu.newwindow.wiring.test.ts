/**
 * 要件#59 の受け入れテスト(docs/requirements/req-59.md)— ContextMenu の配線
 * (component プロジェクト・ContextMenu.svelte を JSDOM にマウントする最初のテスト)
 *
 * 純関数(項目構成・親フォルダの導出・計画)と実行列は
 * src/lib/open-in-new-window.acceptance.test.ts(unit 側)。ここは
 * `ContextMenu.svelte` をマウントし、**ストアを開く → 「Open in New Window」を押す
 * → 計画が prop へ渡る → メニューが閉じる**の配線を判定する(AC-59-11〜13)。
 *
 * ## 配線に求める契約(implementer はこれに従う)
 * - `ContextMenu.svelte` に prop **`onOpenInNewWindow(plan)`** を追加する
 *   (`onDuplicateWindow` と並ぶ形)。押されたら planContextAction の結果
 *   `{ command: 'new-window', root, path }` をそのまま1回渡す。実行
 *   (invoke('new_window'))と失敗 alert は +page.svelte の合流点
 *   (Duplicate Window とまったく同じ分担=reviewer 照合)
 * - メニューは実行の前に閉じる(既存の `activate` の家風)
 * - 既存項目(Reveal / Copy Path / Duplicate Window)の配線は不変(契約⑧)
 *
 * ## 判定するもの
 * - AC-59-11 押すと計画が渡る(契約①③): フォルダ項目で開くとボタンが DOM に出る・
 *   クリックで onOpenInNewWindow が計画1つで1回・メニューが閉じる・
 *   ファイル項目では計画の path がそのファイルの URI
 * - AC-59-12 既存ウィンドウを動かさない(契約④): クリックで set_root /
 *   open_document / confirmDiscardEdits のいずれも呼ばれない。disabled な項目
 *   (親の取れないファイル)を押しても onOpenInNewWindow は呼ばれない
 * - AC-59-13 既存項目のデグレなし(契約⑧): Copy Path → clipboard・
 *   Reveal in Finder → revealItemInDir・Duplicate Window → onDuplicateWindow が
 *   従来どおり(prop が2つになっても既存の配線が生きている)
 *
 * ## 判定しないもの
 * - +page.svelte / Explorer.svelte の prop 中継と実行列 → reviewer 照合
 * - 項目の並び・enabled の出し分けの全列挙 → unit 側(context-menu.acceptance.test.ts)
 * - 実機で窓が開くこと・新窓の初期状態 → 人間ゲート(acceptance.md 要件#59)
 *
 * ## スタブの設計(close-window.wiring.test.ts の家風・duplicate-window のモックは共有しない)
 * - $lib/ipc: モジュールモック(set_root / open_document が呼ばれないことの観測台)
 * - $lib/edit-guard: confirmDiscardEdits のモック(呼ばれないことの観測=契約④)
 * - @tauri-apps/plugin-opener / plugin-dialog: ContextMenu.svelte の import を成立させる
 * - navigator.clipboard: writeText スタブ(Copy Path の観測)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('$lib/edit-guard', () => ({ confirmDiscardEdits: vi.fn(async () => true) }));
vi.mock('@tauri-apps/plugin-opener', () => ({
	revealItemInDir: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
	openUrl: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
	open: vi.fn(async () => null),
	ask: vi.fn(async () => false),
}));

import { invoke } from '$lib/ipc';
import { confirmDiscardEdits } from '$lib/edit-guard';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import ContextMenu from './ContextMenu.svelte';
import { contextMenu } from '../stores/context-menu.svelte';
import type { ContextMenuEntry } from '$lib/context-menu';

const invokeMock = vi.mocked(invoke);
const confirmMock = vi.mocked(confirmDiscardEdits);
const revealMock = vi.mocked(revealItemInDir);

const localDir: ContextMenuEntry = {
	uri: 'file:///Users/x/notes',
	name: 'notes',
	kind: 'dir',
};
const localFile: ContextMenuEntry = {
	uri: 'file:///Users/x/notes/plan.md',
	name: 'plan.md',
	kind: 'file',
};
/** authority 直下のファイル=親が取れない(契約②の縮退)。 */
const rootFile: ContextMenuEntry = {
	uri: 'file:///notes.md',
	name: 'notes.md',
	kind: 'file',
};

let clipboardWrite: ReturnType<typeof vi.fn>;

/** 非同期の activate(クリック → 計画 → prop 呼び出し)を流しきる。 */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** ContextMenu を両 prop 付きでマウントし、entry のメニューを開く。 */
async function mountAndOpen(entry: ContextMenuEntry) {
	const onDuplicateWindow = vi.fn();
	const onOpenInNewWindow = vi.fn();
	render(ContextMenu, { props: { onDuplicateWindow, onOpenInNewWindow } });
	contextMenu.openAt(entry, 10, 10);
	await tick();
	return { onDuplicateWindow, onOpenInNewWindow };
}

const menuItem = (name: string) => screen.getByRole('menuitem', { name });

beforeEach(() => {
	clipboardWrite = vi.fn(async () => undefined);
	Object.defineProperty(navigator, 'clipboard', {
		value: { writeText: clipboardWrite },
		configurable: true,
	});
});

afterEach(() => {
	contextMenu.close();
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-59-11 — 押すと計画が渡る(契約①③)
// ---------------------------------------------------------------------------

describe('AC-59-11: 「Open in New Window」を押すと計画が prop へ渡る(契約①③)', () => {
	it('フォルダ項目で開くとボタンが DOM に出て、クリックで計画1つ・1回・メニューが閉じる', async () => {
		const { onOpenInNewWindow } = await mountAndOpen(localDir);

		const button = menuItem('Open in New Window');
		expect(button).toBeTruthy();
		expect((button as HTMLButtonElement).disabled).toBe(false);

		await fireEvent.click(button);
		await flushAsync();

		expect(onOpenInNewWindow).toHaveBeenCalledTimes(1);
		expect(onOpenInNewWindow.mock.calls[0]?.[0]).toEqual({
			command: 'new-window',
			root: 'file:///Users/x/notes',
			path: null,
		});
		expect(contextMenu.open).toBe(false);
	});

	it('ファイル項目では計画の path がそのファイルの URI・root は親フォルダ', async () => {
		const { onOpenInNewWindow } = await mountAndOpen(localFile);

		await fireEvent.click(menuItem('Open in New Window'));
		await flushAsync();

		expect(onOpenInNewWindow).toHaveBeenCalledTimes(1);
		expect(onOpenInNewWindow.mock.calls[0]?.[0]).toEqual({
			command: 'new-window',
			root: 'file:///Users/x/notes',
			path: 'file:///Users/x/notes/plan.md',
		});
	});
});

// ---------------------------------------------------------------------------
// AC-59-12 — 既存ウィンドウを動かさない(契約④)
// ---------------------------------------------------------------------------

describe('AC-59-12: クリックしても既存ウィンドウに触らない(契約④)', () => {
	it('set_root / open_document / confirmDiscardEdits のいずれも呼ばれない', async () => {
		await mountAndOpen(localFile);

		await fireEvent.click(menuItem('Open in New Window'));
		await flushAsync();

		// ContextMenu からの実行は prop 渡しのみ。invoke 自体が1件も走らないこと
		// (set_root / open_document を含む)を観測台で固定する。
		expect(invokeMock).not.toHaveBeenCalled();
		expect(confirmMock).not.toHaveBeenCalled();
	});

	it('disabled な項目(親の取れないファイル)は押しても onOpenInNewWindow が呼ばれない', async () => {
		const { onOpenInNewWindow } = await mountAndOpen(rootFile);

		const button = menuItem('Open in New Window');
		expect((button as HTMLButtonElement).disabled).toBe(true);

		await fireEvent.click(button);
		await flushAsync();

		expect(onOpenInNewWindow).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-59-13 — 既存項目のデグレなし(契約⑧)
// ---------------------------------------------------------------------------

describe('AC-59-13: 既存項目の配線が生きている(契約⑧・prop が2つになっても)', () => {
	it('Copy Path → clipboard へ OS パス(従来どおり)', async () => {
		await mountAndOpen(localFile);

		await fireEvent.click(menuItem('Copy Path'));
		await flushAsync();

		expect(clipboardWrite).toHaveBeenCalledTimes(1);
		expect(clipboardWrite.mock.calls[0]?.[0]).toBe('/Users/x/notes/plan.md');
	});

	it('Reveal in Finder → revealItemInDir(従来どおり)', async () => {
		await mountAndOpen(localFile);

		await fireEvent.click(menuItem('Reveal in Finder'));
		await flushAsync();

		expect(revealMock).toHaveBeenCalledTimes(1);
		expect(revealMock.mock.calls[0]?.[0]).toBe('/Users/x/notes/plan.md');
	});

	it('Duplicate Window → onDuplicateWindow が1回(既存 prop の配線が生きている)', async () => {
		const { onDuplicateWindow, onOpenInNewWindow } = await mountAndOpen(localDir);

		await fireEvent.click(menuItem('Duplicate Window'));
		await flushAsync();

		expect(onDuplicateWindow).toHaveBeenCalledTimes(1);
		expect(onOpenInNewWindow).not.toHaveBeenCalled();
	});
});
