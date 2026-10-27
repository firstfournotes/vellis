/**
 * 要件#63 追補a(2026-10-26・Issue #573)の受け入れテスト AC-63-追a (a)〜(c)
 * (docs/requirements/req-63.md「追補a」。component プロジェクト・`FindInFolder.svelte` を
 * JSDOM にマウントし、`+page.svelte` はソース走査で固定する)
 *
 * 「ポインタが Find in Folder のパネルの上のとき、見えていないツリーの倍率が動く」の直し=
 * 検索パネルの器を契約3 の Explorer の領域にし、パネルの結果の一覧にツリーと同じ倍率
 * (`vellis.explorer-zoom` の 1 つの値)を CSS `zoom` で当てる。見出し行・入力の行・トグル・
 * ペイン幅は動かさない。
 *
 * ## 配線に求める契約(implementer はこれに従う=本テストが前提にする prop 名と形)
 * - `FindInFolder.svelte` に prop **`resultsZoom?: number`**(% 表記の倍率・既定 100)を足す。
 *   契約(追補a)の起案時判断 (c) は「名前は実装裁量・既定は 100」なので本テストが
 *   `resultsZoom` に固定する(`Explorer.svelte` の `explorerZoom` と同じ役=ツリーの倍率を
 *   そのまま受ける prop)
 * - `.find-in-folder-results` に inline の `zoom` を当てる。値は `Explorer.svelte` の
 *   `nav.explorer-list` と**同じ形**(`150%` のパーセント表記=`Explorer.zoom.wiring.test.ts`
 *   と同じ判定)。**100(既定)のときは宣言を出さない**(`style:zoom={zoom === DEFAULT_ZOOM
 *   ? null : \`${zoom}%\`}` の流儀)。本テストは `style.getPropertyValue('zoom')` と `style`
 *   属性文字列の両方で見るので、`style:zoom` 指令でも `style="..."` 文字列でもよい。等倍は
 *   「宣言が無い」を本線にし、`1` / `100%` の明示も等倍として許す
 * - `.find-in-folder-header`(タイトル・Close)と `.find-in-folder-query`(入力の行・トグル・
 *   詳細 2 欄・状態表示)には `zoom` を当てない。`.find-in-folder`(パネルの根)にも当てない
 *   (当てるとペイン幅の中の見出し・入力まで動く)
 * - `FindInFolder.svelte` の中に `data-zoom-region` を書かない(要件55 の
 *   `FindInFolder.wiring.test.ts` の不変はそのまま)。目印は `+page.svelte` の器
 *   `.find-in-folder-pane` に付ける(契約(追補a)1)
 * - `+page.svelte` は `<FindInFolder` に `resultsZoom={explorerZoomLevel}`(`<Explorer` の
 *   `explorerZoom` に渡しているのと同じ状態)を渡す(契約(追補a)2・3=値は 1 つ)
 *
 * ## 判定しないもの
 * - CSS `zoom` の見た目・拡縮した一覧の当たり判定 → 人間ゲート
 * - パネルの上でのポインタの追跡・メニューからの振り分け → 既存の `+page.svelte` の配線と
 *   `zoom-target.acceptance.test.ts`(契約(追補a)4 の不変。純関数は無改変)
 *
 * ## スタブの設計(FindInFolder.wiring.test.ts の家風)
 * - $lib/ipc: `search_in_folder` は手で resolve できる deferred。`search_in_folder_reset` ほかは null
 * - $lib/events: 名前ごとの handler 登録(本テストは発火しない)
 * - $lib/edit-guard / plugin-opener / plugin-dialog: import を成立させるだけ(クリックしない)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
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
vi.mock('$lib/events', () => ({
	listen: vi.fn(async () => () => {}),
}));

import { invoke } from '$lib/ipc';
import FindInFolder from './FindInFolder.svelte';
import { regionOf } from '$lib/zoom-target';
import type { SearchHit } from '$lib/find-in-folder';

const invokeMock = vi.mocked(invoke);

const ROOT = 'file:///Users/x/notes';
const HITS: SearchHit[] = [
	{ path: 'docs/a.md', line: 3, text: 'alpha one', ordinal: 1 },
	{ path: 'docs/a.md', line: 7, text: 'alpha two', ordinal: 2 },
	{ path: 'b.txt', line: 1, text: 'alpha', ordinal: 1 },
];

type Pending = {
	args: { root: string; query: string; generation: number };
	resolve: (hits: SearchHit[]) => void;
};
let pending: Pending[] = [];

function installInvoke() {
	pending = [];
	invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === 'search_in_folder') {
			return await new Promise((res) => {
				const a = args as Pending['args'];
				pending.push({
					args: a,
					resolve: (hits) =>
						res({
							generation: a.generation,
							total: hits.length,
							files: new Set(hits.map((h) => h.path)).size,
							hits,
						}),
				});
			});
		}
		return null;
	});
}

function searchCalls() {
	return invokeMock.mock.calls.filter((c) => c[0] === 'search_in_folder');
}

const input = () => screen.getByTestId('find-in-folder-input') as HTMLInputElement;
const groups = () => screen.queryAllByTestId('find-in-folder-group');

/** inline の `zoom` 宣言があるか(style プロパティと style 属性文字列の両方で見る)。 */
function hasInlineZoom(el: HTMLElement): boolean {
	if (el.style.getPropertyValue('zoom') !== '') return true;
	return /(^|;)\s*zoom\s*:/i.test(el.getAttribute('style') ?? '');
}

/** inline の `zoom` が等倍(宣言なし・`1`・`100%`)か。 */
function isUnitZoom(el: HTMLElement): boolean {
	if (!hasInlineZoom(el)) return true;
	const value = el.style.getPropertyValue('zoom').trim();
	return value === '1' || value === '100%';
}

/**
 * FindInFolder をマウントして語を入れ、結果を 1 ページ返して一覧が描かれるまで待つ。
 * `resultsZoom` を省くと既定(100)。
 */
async function mountWithResults(resultsZoom?: number) {
	const props: Record<string, unknown> = {
		rootUri: ROOT,
		onOpen: vi.fn(),
		onClose: vi.fn(),
	};
	if (resultsZoom !== undefined) props.resultsZoom = resultsZoom;
	const { container } = render(FindInFolder, { props: props as never });

	const before = searchCalls().length;
	await fireEvent.input(input(), { target: { value: 'alpha' } });
	await waitFor(() => expect(searchCalls().length).toBe(before + 1), { timeout: 1500 });
	pending[pending.length - 1].resolve(HITS);
	await waitFor(() => expect(groups().length).toBe(2));

	const panel = container.querySelector('.find-in-folder');
	const header = container.querySelector('.find-in-folder-header');
	const query = container.querySelector('.find-in-folder-query');
	const results = container.querySelector('.find-in-folder-results');
	if (
		!(panel instanceof HTMLElement) ||
		!(header instanceof HTMLElement) ||
		!(query instanceof HTMLElement) ||
		!(results instanceof HTMLElement)
	) {
		throw new Error(
			'FindInFolder must render .find-in-folder > .find-in-folder-header + .find-in-folder-query + .find-in-folder-results'
		);
	}
	return { panel, header, query, results };
}

beforeEach(() => {
	installInvoke();
	Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-63-追a (b) — 倍率を渡すと結果の一覧にだけ zoom が当たる(契約(追補a)2)
// ---------------------------------------------------------------------------

describe('AC-63-追a (b): resultsZoom=150 puts zoom: 150% on .find-in-folder-results only', () => {
	it('.find-in-folder-results has inline zoom 150% (same form as nav.explorer-list)', async () => {
		const { results } = await mountWithResults(150);
		expect(results.style.getPropertyValue('zoom')).toBe('150%');
	});

	it('the result rows are rendered inside the zoomed list (the zoom scales them as one)', async () => {
		const { results } = await mountWithResults(150);
		expect(results.querySelectorAll('[data-testid="find-in-folder-hit"]').length).toBe(3);
		expect(results.querySelectorAll('[data-testid="find-in-folder-group"]').length).toBe(2);
	});

	it('.find-in-folder-header, .find-in-folder-query and the panel root have no zoom', async () => {
		const { panel, header, query } = await mountWithResults(150);
		expect(hasInlineZoom(header)).toBe(false);
		expect(hasInlineZoom(query)).toBe(false);
		expect(hasInlineZoom(panel)).toBe(false);
		// The input row and the match toggles live inside .find-in-folder-query, so none of them
		// carries a zoom of its own either.
		for (const el of query.querySelectorAll<HTMLElement>('*')) {
			expect(hasInlineZoom(el), `descendant of .find-in-folder-query: ${el.className}`).toBe(false);
		}
	});

	it('another level (60) is reflected as-is (the prop drives the value)', async () => {
		const { results, header, query } = await mountWithResults(60);
		expect(results.style.getPropertyValue('zoom')).toBe('60%');
		expect(hasInlineZoom(header)).toBe(false);
		expect(hasInlineZoom(query)).toBe(false);
	});
});

describe('AC-63-追a (b): default is unit zoom (prop omitted or 100)', () => {
	it('prop omitted: .find-in-folder-results is at unit zoom; header/query untouched', async () => {
		const { results, header, query, panel } = await mountWithResults();
		expect(isUnitZoom(results)).toBe(true);
		expect(hasInlineZoom(header)).toBe(false);
		expect(hasInlineZoom(query)).toBe(false);
		expect(hasInlineZoom(panel)).toBe(false);
	});

	it('explicit 100: .find-in-folder-results is at unit zoom; header/query untouched', async () => {
		const { results, header, query, panel } = await mountWithResults(100);
		expect(isUnitZoom(results)).toBe(true);
		expect(hasInlineZoom(header)).toBe(false);
		expect(hasInlineZoom(query)).toBe(false);
		expect(hasInlineZoom(panel)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-63-追a (a)(c) — +page.svelte の器と倍率の配線(ソース走査)・regionOf の判別
// ---------------------------------------------------------------------------

const PAGE_PATH = resolve(__dirname, '../routes/+page.svelte');
const FIND_IN_FOLDER_PATH = resolve(__dirname, 'FindInFolder.svelte');

/**
 * `<tag ...>` の開始タグを、属性に `needle` を含むものから 1 つ取り出す(無ければ null)。
 * 属性の `{...}` の中の `>`(`() => ...` など)でタグを切らないよう、波括弧の深さを数える。
 */
function openingTagWith(source: string, tag: string, needle: string): string | null {
	let from = 0;
	for (;;) {
		const start = source.indexOf(`<${tag}`, from);
		if (start < 0) return null;
		const after = source[start + tag.length + 1] ?? '';
		from = start + 1;
		if (!/[\s/>]/.test(after)) continue;
		let depth = 0;
		let end = -1;
		for (let i = start; i < source.length; i++) {
			const ch = source[i];
			if (ch === '{') depth++;
			else if (ch === '}') depth = Math.max(0, depth - 1);
			else if (ch === '>' && depth === 0) {
				end = i;
				break;
			}
		}
		if (end < 0) return null;
		const text = source.slice(start, end + 1);
		if (text.includes(needle)) return text;
	}
}

describe('AC-63-追a (a): +page.svelte marks .find-in-folder-pane as the explorer region (contract 1)', () => {
	const page = readFileSync(PAGE_PATH, 'utf-8');

	it('the .find-in-folder-pane element carries data-zoom-region="explorer"', () => {
		const tag = openingTagWith(page, 'div', 'find-in-folder-pane');
		expect(tag, 'a <div class="find-in-folder-pane"> must exist in +page.svelte').not.toBeNull();
		expect(tag).toMatch(/data-zoom-region=["']explorer["']/);
	});

	it('FindInFolder.svelte itself still has no data-zoom-region (the marker belongs to the pane)', () => {
		const src = readFileSync(FIND_IN_FOLDER_PATH, 'utf-8');
		expect(src).not.toMatch(/data-zoom-region/);
	});

	it('regionOf: an element inside the marked pane resolves to "explorer" (the pure function is unchanged)', async () => {
		// The pane is the page's responsibility; here it is reproduced around the real panel DOM.
		const { panel, results, header } = await mountWithResults(150);
		const pane = document.createElement('div');
		pane.className = 'find-in-folder-pane';
		pane.setAttribute('data-zoom-region', 'explorer');
		panel.parentElement?.insertBefore(pane, panel);
		pane.appendChild(panel);

		const hit = results.querySelector('[data-testid="find-in-folder-hit"]');
		expect(hit).not.toBeNull();
		expect(regionOf(hit)).toBe('explorer');
		expect(regionOf(header)).toBe('explorer');
		expect(regionOf(input())).toBe('explorer');
		expect(hit?.closest('[data-zoom-region]')).toBe(pane);
	});
});

describe('AC-63-追a (c): +page.svelte passes the tree zoom state to FindInFolder (contract 2・3)', () => {
	const page = readFileSync(PAGE_PATH, 'utf-8');

	it('<FindInFolder ...> receives resultsZoom={explorerZoomLevel}', () => {
		const tag = openingTagWith(page, 'FindInFolder', 'rootUri');
		expect(tag, 'a <FindInFolder ...> element must exist in +page.svelte').not.toBeNull();
		expect(tag).toMatch(/\bresultsZoom=\{explorerZoomLevel\}/);
	});

	it('<Explorer ...> still receives the same state as explorerZoom={explorerZoomLevel} (one value)', () => {
		const tag = openingTagWith(page, 'Explorer', 'explorerZoom');
		expect(tag, 'a <Explorer ... explorerZoom=...> element must exist in +page.svelte').not.toBeNull();
		expect(tag).toMatch(/\bexplorerZoom=\{explorerZoomLevel\}/);
	});
});
