/**
 * 要件#63 の受け入れテスト(docs/requirements/req-63.md)— Explorer の配線
 * (AC-63-9・契約1。component プロジェクト・`Explorer.svelte` を JSDOM にマウントする)
 *
 * 「ツリー(`nav.explorer-list` の中身)を CSS `zoom` で一体に拡縮する。ペイン幅・見出し行は
 * 動かさない」。判別と保存の純関数は src/lib/zoom-target.acceptance.test.ts(unit 側)。ここは
 * `Explorer.svelte` を倍率 150 / 100 でマウントし、inline の `zoom` がツリーにだけ当たること・
 * 等倍では宣言そのものが無いこと・`aside.explorer` に領域の目印があることを判定する。
 *
 * ## 配線に求める契約(implementer はこれに従う=本テストが前提にする prop 名)
 * - `Explorer.svelte` に prop **`explorerZoom?: number`**(既定 `DEFAULT_ZOOM` = 100)を足す。
 *   契約は「倍率の prop を1つ足す」とだけ言い、名前は指定していないので本テストが `explorerZoom`
 *   に固定する(`Viewer.svelte` の `zoom` prop と取り違えないための名前)
 * - `nav.explorer-list` に inline の `zoom` を当てる。**100 のときは宣言そのものを出さない**
 *   (`Viewer.svelte` の `.markdown-body` の
 *   `style:zoom={zoom === DEFAULT_ZOOM ? null : \`${zoom}%\`}` と同じ流儀)。本テストは
 *   `style.getPropertyValue('zoom')` と `style` 属性の両方で見るので、`style:zoom` 指令でも
 *   `style="..."` 文字列でもよい。値は `150%`(パーセント表記)
 * - `aside.explorer` の inline `width` は従来どおり `width` prop の px のまま(要件#9)。
 *   `aside.explorer` と `.explorer-header` には `zoom` を当てない
 * - `aside.explorer` に `data-zoom-region="explorer"` を付ける(契約3の領域の目印)
 *
 * ## 判定しないもの
 * - CSS `zoom` の見た目・拡縮したツリーの当たり判定・50% / 300% での崩れ → 人間ゲート 3
 * - `+page.svelte` が `explorerZoom` に窓の倍率を渡すこと・ポインタの追跡 → reviewer 照合
 *
 * ## スタブの設計(Explorer.newtab.wiring.test.ts の家風)
 * - $lib/ipc / $lib/edit-guard / plugin-opener / plugin-dialog: Explorer と ContextMenu の import を
 *   成立させるだけ(本テストはクリックしない)
 * - ツリーのデータは props(root / entries)と windowState(root)に直接入れる。展開中ディレクトリ
 *   は空にして、ExplorerItem の展開 effect を起こさない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => 'vellis-2'),
}));
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

import Explorer from './Explorer.svelte';
import { windowState, type Entry } from '../stores/window-state.svelte';
import { contextMenu } from '../stores/context-menu.svelte';

const ROOT = 'file:///Users/x/notes';
const FILE = 'file:///Users/x/notes/plan.md';
const DIR = 'file:///Users/x/notes/sub';
const WIDTH = 260;

const entries: Entry[] = [
	{ uri: FILE, name: 'plan.md', kind: 'file' },
	{ uri: DIR, name: 'sub', kind: 'dir' },
];

/** Explorer を倍率付きでマウントする。`explorerZoom` を省くと既定(100)。 */
function mountExplorer(explorerZoom?: number) {
	const props: Record<string, unknown> = {
		root: ROOT,
		entries,
		selectedUri: undefined,
		width: WIDTH,
		onDuplicateWindow: vi.fn(),
		onOpenInNewWindow: vi.fn(),
	};
	if (explorerZoom !== undefined) props.explorerZoom = explorerZoom;
	const { container } = render(Explorer, { props: props as never });
	const aside = container.querySelector('aside.explorer');
	const nav = container.querySelector('nav.explorer-list');
	const header = container.querySelector('.explorer-header');
	if (!(aside instanceof HTMLElement) || !(nav instanceof HTMLElement) || !(header instanceof HTMLElement)) {
		throw new Error('Explorer must render aside.explorer > .explorer-header + nav.explorer-list');
	}
	return { aside, nav, header };
}

/** inline の `zoom` 宣言があるか(style プロパティと style 属性文字列の両方で見る)。 */
function hasInlineZoom(el: HTMLElement): boolean {
	if (el.style.getPropertyValue('zoom') !== '') return true;
	return /(^|;)\s*zoom\s*:/i.test(el.getAttribute('style') ?? '');
}

beforeEach(() => {
	windowState.applyRoot(ROOT, entries, false);
	windowState.setExpandedDirs([]);
});

afterEach(() => {
	contextMenu.close();
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-63-9 — ツリーに zoom が当たる(契約1)
// ---------------------------------------------------------------------------

describe('AC-63-9: explorerZoom=150 puts zoom: 150% on nav.explorer-list only (contract 1)', () => {
	it('nav.explorer-list has inline zoom 150%', () => {
		const { nav } = mountExplorer(150);
		expect(nav.style.getPropertyValue('zoom')).toBe('150%');
	});

	it('aside.explorer keeps width: <px> and has no zoom; .explorer-header has no zoom', () => {
		const { aside, header } = mountExplorer(150);
		expect(aside.style.width).toBe(`${WIDTH}px`);
		expect(hasInlineZoom(aside)).toBe(false);
		expect(hasInlineZoom(header)).toBe(false);
	});

	it('the tree items are rendered inside the zoomed nav (the zoom scales them as one)', () => {
		const { nav } = mountExplorer(150);
		expect(nav.querySelector(`[title="${FILE}"]`)).not.toBeNull();
		expect(nav.querySelector(`[title="${DIR}"]`)).not.toBeNull();
	});

	it('another level (60) is reflected as-is (the prop drives the value)', () => {
		const { nav } = mountExplorer(60);
		expect(nav.style.getPropertyValue('zoom')).toBe('60%');
	});
});

describe('AC-63-9: explorerZoom=100 (default) emits no zoom declaration (same DOM as before)', () => {
	it('explicit 100: nav.explorer-list has no zoom declaration', () => {
		const { nav, aside, header } = mountExplorer(100);
		expect(hasInlineZoom(nav)).toBe(false);
		expect(hasInlineZoom(aside)).toBe(false);
		expect(hasInlineZoom(header)).toBe(false);
		expect(aside.style.width).toBe(`${WIDTH}px`);
	});

	it('prop omitted: defaults to 100 and no zoom declaration anywhere', () => {
		const { nav, aside, header } = mountExplorer();
		expect(hasInlineZoom(nav)).toBe(false);
		expect(hasInlineZoom(aside)).toBe(false);
		expect(hasInlineZoom(header)).toBe(false);
		expect(aside.style.width).toBe(`${WIDTH}px`);
	});
});

describe('AC-63-9: aside.explorer carries data-zoom-region="explorer" (contract 3)', () => {
	it('at 150 and at 100 the marker is present on aside.explorer', () => {
		for (const level of [150, 100]) {
			const { aside, header } = mountExplorer(level);
			expect(aside.getAttribute('data-zoom-region'), `level=${level}`).toBe('explorer');
			// The header is inside the marked pane, so a pointer on it counts as explorer (contract 3).
			expect(header.closest('[data-zoom-region]')).toBe(aside);
			cleanup();
		}
	});
});
