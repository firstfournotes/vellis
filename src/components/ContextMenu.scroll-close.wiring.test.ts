/**
 * 要件#19 追補b の受け入れテスト(docs/requirements/req-19.md「追補b(2026-10-25・Issue #417)」)
 * — ツリーの右クリックメニューは、ページのどこかがスクロールしたら閉じる
 * (component プロジェクト・`ContextMenu.svelte` を JSDOM にマウントする=ContextMenu.newwindow.wiring.test.ts
 * と同じ家風)
 *
 * 発見: メニューは `position: fixed` で開いた位置に残り、閉じる契機は外側の pointerdown と Escape だけ。
 * Explorer をスクロールしても閉じず、項目の行から離れて浮いて見える。
 *
 * ## 配線に求める契約(追補b 1〜3。implementer はこれに従う)
 * - `ContextMenu.svelte` は、メニューが開いている間に `window` の `scroll` を **capture** で受け(要素の
 *   `scroll` はバブルしないので、中の要素のスクロールも capture でだけ拾える)、メニューを閉じる
 *   (`contextMenu.close()`)。`scroll` の発生源がメニュー自身の中(`el.contains(target)`)なら閉じない
 * - 閉じるだけで項目は実行しない。メニューが閉じているときの `scroll` では何もしない(例外も出ない)
 * - 不変: 外側の pointerdown と Escape で閉じる契機・項目の実行・メニューの位置と中身
 *
 * ## 判定(AC-19-追b)
 * - (a) メニューを開いた状態で、ページの中のスクロールできる要素(メニューの外・ツリー相当)に `scroll`
 *   (bubbles: false)を送るとメニューが閉じる(`contextMenu.open` が偽・`role="menu"` の DOM が消える)。
 *   `document` の `scroll`(ページ全体のスクロール)でも閉じる。空白部のメニュー(`openTreePaneAt`)も同じ。
 *   閉じるだけで項目は実行しない(prop も opener も clipboard も invoke も呼ばれない)。閉じた後に開き直せる
 * - (b) メニュー自身(`role="menu"`)やその中の項目で `scroll` が起きても閉じない
 * - (c) メニューが閉じているときの `scroll` では何も起きない(例外なし・`open` は偽のまま・何も呼ばれない)
 * - (d) 既存の要件19・21・34 のテストは無改変で緑(このファイルは足すだけ)
 * - 不変の守り: 外側の pointerdown と Escape で閉じる・メニューの中の pointerdown では閉じない
 *
 * ## 判断の記録(test-writer 2026-10-25)
 * - 要素の `scroll` は `bubbles: false` で送る(ブラウザと同じ)。JSDOM のイベント経路は Window を含むので、
 *   `window` に capture で付けた listener にだけ届く=契約 1 の「capture で受ける」を素直に判定できる。
 *   `document` の `scroll` はブラウザと同じく `bubbles: true` で送る
 * - 受け方(`<svelte:window onscrollcapture>` か `addEventListener('scroll', …, true)` か)は implementer 裁量
 *
 * ## スタブの設計(ContextMenu.newwindow.wiring.test.ts と同じ)
 * - $lib/ipc / $lib/edit-guard / tauri plugin-opener / plugin-dialog はモジュールモック・clipboard はスタブ
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
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
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import ContextMenu from './ContextMenu.svelte';
import { contextMenu } from '../stores/context-menu.svelte';
import type { ContextMenuEntry, NewWindowAction } from '$lib/context-menu';

const invokeMock = vi.mocked(invoke);
const revealMock = vi.mocked(revealItemInDir);
const openPathMock = vi.mocked(openPath);

const localFile: ContextMenuEntry = {
	uri: 'file:///Users/x/notes/plan.md',
	name: 'plan.md',
	kind: 'file',
};

let clipboardWrite: ReturnType<typeof vi.fn>;
/** ツリー相当のスクロールできる要素(メニューの外)。 */
let treePane: HTMLDivElement;

/** prop は ContextMenu の prop の関数型のモック(`render` の型に合わせる)。 */
type Props = {
	onDuplicateWindow: Mock<() => void>;
	onOpenInNewWindow: Mock<(plan: NewWindowAction) => void>;
	onOpenInNewTab: Mock<(path: string) => void>;
};

function mountMenu(): Props {
	const props: Props = {
		onDuplicateWindow: vi.fn<() => void>(),
		onOpenInNewWindow: vi.fn<(plan: NewWindowAction) => void>(),
		onOpenInNewTab: vi.fn<(path: string) => void>(),
	};
	render(ContextMenu, { props });
	return props;
}

async function mountAndOpen(entry: ContextMenuEntry = localFile): Promise<Props> {
	const props = mountMenu();
	contextMenu.openAt(entry, 10, 10);
	await tick();
	expect(contextMenu.open).toBe(true);
	expect(menu(), 'the menu is in the DOM once opened').not.toBeNull();
	return props;
}

const menu = () => screen.queryByRole('menu');
const menuItem = (name: string) => screen.getByRole('menuitem', { name });

/** `scroll` を送る。要素のスクロールはバブルしない(ブラウザと同じ)。document のスクロールはバブルする。 */
async function scrollOn(target: EventTarget, bubbles = false) {
	target.dispatchEvent(new Event('scroll', { bubbles, cancelable: false }));
	await tick();
}

/** 項目が 1 つも実行されていない(契約 追補b 2)。 */
function expectNothingExecuted(props: Props) {
	expect(props.onDuplicateWindow).not.toHaveBeenCalled();
	expect(props.onOpenInNewWindow).not.toHaveBeenCalled();
	expect(props.onOpenInNewTab).not.toHaveBeenCalled();
	expect(invokeMock).not.toHaveBeenCalled();
	expect(revealMock).not.toHaveBeenCalled();
	expect(openPathMock).not.toHaveBeenCalled();
	expect(clipboardWrite).not.toHaveBeenCalled();
}

beforeEach(() => {
	clipboardWrite = vi.fn(async () => undefined);
	Object.defineProperty(navigator, 'clipboard', {
		value: { writeText: clipboardWrite },
		configurable: true,
	});
	treePane = document.createElement('div');
	treePane.setAttribute('data-testid', 'tree-pane');
	treePane.style.height = '100px';
	treePane.style.overflow = 'auto';
	const tall = document.createElement('div');
	tall.style.height = '1000px';
	treePane.appendChild(tall);
	document.body.appendChild(treePane);
});

afterEach(() => {
	contextMenu.close();
	cleanup();
	treePane.remove();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-19-追b (a) — ページの中のスクロールでメニューが閉じる(契約 追補b 1・2)
// ---------------------------------------------------------------------------

describe('AC-19-追b (a): 開いているメニューは、ページの中のスクロールできる要素の scroll で閉じる(契約 追補b 1・2)', () => {
	it('ツリー相当の要素(メニューの外)の scroll(bubbles: false)で contextMenu.open が偽になり、メニューの DOM が消える・項目は実行しない', async () => {
		const props = await mountAndOpen();

		await scrollOn(treePane);

		expect(contextMenu.open, 'a scroll anywhere outside the menu closes it').toBe(false);
		expect(menu(), 'the menu element is gone').toBeNull();
		expectNothingExecuted(props);
	});

	it('document の scroll(ページ全体のスクロール)でも閉じる', async () => {
		const props = await mountAndOpen();

		await scrollOn(document, true);

		expect(contextMenu.open).toBe(false);
		expect(menu()).toBeNull();
		expectNothingExecuted(props);
	});

	it('ツリーの空白部のメニュー(openTreePaneAt)も scroll で閉じる', async () => {
		const props = mountMenu();
		contextMenu.openTreePaneAt(10, 10);
		await tick();
		expect(menu()).not.toBeNull();

		await scrollOn(treePane);

		expect(contextMenu.open).toBe(false);
		expect(menu()).toBeNull();
		expectNothingExecuted(props);
	});

	it('scroll で閉じた後、もう一度右クリックすれば開き直せる(開き直しに影響しない)', async () => {
		await mountAndOpen();
		await scrollOn(treePane);
		expect(menu()).toBeNull();

		contextMenu.openAt(localFile, 20, 20);
		await tick();

		expect(contextMenu.open).toBe(true);
		expect(menu()).not.toBeNull();
		expect(menuItem('Copy Path')).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// AC-19-追b (b) — メニュー自身の中の scroll では閉じない(契約 追補b 1)
// ---------------------------------------------------------------------------

describe('AC-19-追b (b): メニューの中で scroll が起きても閉じない(契約 追補b 1)', () => {
	it('role="menu" の要素の scroll では開いたまま', async () => {
		await mountAndOpen();

		await scrollOn(menu() as HTMLElement);

		expect(contextMenu.open, 'scrolling the menu itself keeps it open').toBe(true);
		expect(menu()).not.toBeNull();
	});

	it('メニューの中の項目(menuitem)の scroll でも開いたまま', async () => {
		const props = await mountAndOpen();

		await scrollOn(menuItem('Copy Path'));

		expect(contextMenu.open).toBe(true);
		expect(menu()).not.toBeNull();
		expectNothingExecuted(props);
	});
});

// ---------------------------------------------------------------------------
// AC-19-追b (c) — 閉じているときの scroll は何も起こさない(契約 追補b 2)
// ---------------------------------------------------------------------------

describe('AC-19-追b (c): メニューが閉じているときの scroll では何も起きない(契約 追補b 2)', () => {
	it('マウントだけ(開いていない)の状態で要素と document の scroll を送っても例外なし・open は偽のまま・何も呼ばれない', async () => {
		const props = mountMenu();
		expect(contextMenu.open).toBe(false);
		expect(menu()).toBeNull();

		await expect(
			(async () => {
				await scrollOn(treePane);
				await scrollOn(document, true);
				await scrollOn(window, false);
			})()
		).resolves.toBeUndefined();

		expect(contextMenu.open).toBe(false);
		expect(menu()).toBeNull();
		expectNothingExecuted(props);
	});

	it('一度開いて scroll で閉じた後の scroll も何も起こさない', async () => {
		const props = await mountAndOpen();
		await scrollOn(treePane);
		expect(contextMenu.open).toBe(false);

		await scrollOn(treePane);
		await scrollOn(document, true);

		expect(contextMenu.open).toBe(false);
		expect(menu()).toBeNull();
		expectNothingExecuted(props);
	});
});

// ---------------------------------------------------------------------------
// 不変の守り — 外側の pointerdown と Escape で閉じる契機はそのまま(契約 追補b 3)
// ---------------------------------------------------------------------------

describe('AC-19-追b(不変): 外側の pointerdown と Escape で閉じる・メニューの中の pointerdown では閉じない(契約 追補b 3)', () => {
	it('外側の pointerdown で閉じる', async () => {
		await mountAndOpen();

		await fireEvent.pointerDown(treePane);
		await tick();

		expect(contextMenu.open).toBe(false);
		expect(menu()).toBeNull();
	});

	it('Escape で閉じる', async () => {
		await mountAndOpen();

		await fireEvent.keyDown(window, { key: 'Escape' });
		await tick();

		expect(contextMenu.open).toBe(false);
		expect(menu()).toBeNull();
	});

	it('メニューの中の pointerdown では閉じない(項目の実行が受け持つ)', async () => {
		await mountAndOpen();

		await fireEvent.pointerDown(menuItem('Copy Path'));
		await tick();

		expect(contextMenu.open).toBe(true);
		expect(menu()).not.toBeNull();
	});
});
