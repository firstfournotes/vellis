/**
 * 要件#55 追補c / 追補c-2 / 追補c-3(2026-09-25・docs/requirements/req-55.md「追補c」「追補c-2」「追補c-3」)— Explorer の
 * 見出し行の「Find in Folder」ボタン(component プロジェクト・`Explorer.svelte` を JSDOM にマウントする)
 *
 * 「EXPLORER の見出し行の "Go to Parent Folder" ボタンの隣に検索ボタンを置く」。
 * 押したときにパネルが出て入力欄にフォーカスが入る側は +page.svelte の既存関数
 * (`handleMenuFindInFolder`)の持ち場なので、ここでは **prop が 1 回呼ばれること**と、
 * +page.svelte がメニューの受け口と同じ関数を `onFindInFolder` に渡していること(ソース走査)
 * を判定する。既存の Explorer テスト(newtab / zoom)は書き換えず、その家風に倣って新設。
 *
 * ## 配線に求める契約(implementer はこれに従う)
 * - `Explorer.svelte` の `.explorer-header` に `<button>` を 1 つ足す:
 *   `title` / `aria-label` = `Find in Folder`・ラベルは**インライン SVG の虫眼鏡**(追補c-3 で文字 `⌕` から
 *   置き換え。ボタンの中に `<svg aria-hidden="true">` がちょうど 1 つ・テキストは無い=`textContent.trim()` が空)・
 *   DOM 上の位置は「Go to Parent Folder」ボタンの**直前の兄弟**(左隣。並びは [⌕, ↑]=追補c-2 で
 *   [↑, ⌕] から入れ替え・見出し `Explorer` は左端のまま・2 ボタンは右寄せのまま)
 * - 新 prop `onFindInFolder?: () => void`。押すと 1 回呼ぶ。渡されていなければ何もしない(例外なし)。
 *   Explorer は Tauri(`invoke`)も `confirmDiscardEdits` も呼ばない
 * - ボタンは `nav.explorer-list` の外(要件#63 の zoom の影響を受けない)。見出し行の他の要素
 *   (`Explorer` の見出し・↑・`data-zoom-region`・見出し行に zoom を当てない)は不変
 * - `+page.svelte` は `<Explorer … onFindInFolder={…}>` で `MENU_FIND_IN_FOLDER_EVENT` の
 *   listen が呼ぶのと同じ関数を渡す
 * - 追補c-2(AC-55-32): ⌕ のボタンは ↑ と別の**専用 class**(`find-button`。↑ には付けない。
 *   外形を揃えるために `up-button` を併記するのは可)を持つ
 * - 追補c-3(AC-55-32 更新): ⌕ ボタンの `svg` は `width` / `height` 属性がともに **20 以上**・`viewBox` を
 *   持つ・`fill="none"` と `stroke="currentColor"` を持つ(svg 自身か子要素のどちらでも可)・外部ファイル/
 *   画像(`img` / `image` / 外部 `use`)を使わない。`Explorer.svelte` の `<style>` に `.find-button` を
 *   選択子に持つ規則がある(追補c-2 の「font-size が ↑ より大きい」比較は撤廃)
 *
 * ## 判定しないもの
 * - 見た目(ボタンの外形が約 28px 角で ↑ と揃う・`stroke-width` 1.5〜2・↑ の `font-size` 調整・虫眼鏡に
 *   見えるか)・実際にパネルが開き入力欄にフォーカスが入る流れ → 人間ゲート 8
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === 'open_document' || cmd === 'open_binary_document') {
			return { uri: args?.uri, content: '', modified: null };
		}
		return null;
	}),
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

import { invoke } from '$lib/ipc';
import { confirmDiscardEdits } from '$lib/edit-guard';
import Explorer from './Explorer.svelte';
import { windowState, type Entry } from '../stores/window-state.svelte';
import { contextMenu } from '../stores/context-menu.svelte';

const invokeMock = vi.mocked(invoke);
const confirmMock = vi.mocked(confirmDiscardEdits);

/** CJK を含まない=英語の判定(要件#51 の走査と同じ考え方)。 */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

const ROOT = 'file:///Users/x/notes';
const FILE = 'file:///Users/x/notes/plan.md';
const DIR = 'file:///Users/x/notes/sub';
const WIDTH = 260;

const entries: Entry[] = [
	{ uri: FILE, name: 'plan.md', kind: 'file' },
	{ uri: DIR, name: 'sub', kind: 'dir' },
];

const FIND_LABEL = 'Find in Folder';
const UP_LABEL = 'Go to Parent Folder';

type MountOptions = { onFindInFolder?: () => void; explorerZoom?: number };

/** Explorer をマウントする(zoom wiring の家風)。`onFindInFolder` は渡したときだけ props に載せる。 */
function mountExplorer(options: MountOptions = {}) {
	const props: Record<string, unknown> = {
		root: ROOT,
		entries,
		selectedUri: undefined,
		width: WIDTH,
		onDuplicateWindow: vi.fn(),
		onOpenInNewWindow: vi.fn(),
	};
	if (options.onFindInFolder) props.onFindInFolder = options.onFindInFolder;
	if (options.explorerZoom !== undefined) props.explorerZoom = options.explorerZoom;
	const { container } = render(Explorer, { props: props as never });
	const aside = container.querySelector('aside.explorer');
	const nav = container.querySelector('nav.explorer-list');
	const header = container.querySelector('.explorer-header');
	if (!(aside instanceof HTMLElement) || !(nav instanceof HTMLElement) || !(header instanceof HTMLElement)) {
		throw new Error('Explorer must render aside.explorer > .explorer-header + nav.explorer-list');
	}
	return { container, aside, nav, header };
}

function findButton(header: HTMLElement): HTMLButtonElement {
	const el = header.querySelector(`button[aria-label="${FIND_LABEL}"]`);
	expect(el, `button[aria-label="${FIND_LABEL}"] inside .explorer-header`).toBeTruthy();
	return el as HTMLButtonElement;
}

function upButton(header: HTMLElement): HTMLButtonElement {
	const el = header.querySelector(`button[aria-label="${UP_LABEL}"]`);
	expect(el, `button[aria-label="${UP_LABEL}"] inside .explorer-header`).toBeTruthy();
	return el as HTMLButtonElement;
}

/** inline の `zoom` 宣言があるか(zoom wiring と同じ見方)。 */
function hasInlineZoom(el: HTMLElement): boolean {
	if (el.style.getPropertyValue('zoom') !== '') return true;
	return /(^|;)\s*zoom\s*:/i.test(el.getAttribute('style') ?? '');
}

const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

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
// AC-55-23 — 見出し行の Find in Folder ボタン(位置・文言・prop・不変)
// ---------------------------------------------------------------------------

describe('要件#55 追補c・AC-55-23: Explorer の見出し行に Find in Folder ボタン — ↑ の直前(追補c-2)・prop を 1 回呼ぶ・無ければ何もしない', () => {
	it('.explorer-header に aria-label / title = Find in Folder の <button> があり、↑ ボタンの直前の兄弟である(並びは [⌕, ↑]=追補c-2)', () => {
		const { header } = mountExplorer();
		const find = findButton(header);
		const up = upButton(header);

		expect(find.tagName).toBe('BUTTON');
		expect(find.getAttribute('title')).toBe(FIND_LABEL);
		expect(find.getAttribute('aria-label')).toBe(FIND_LABEL);
		expect(up.previousElementSibling, 'find button is the previous sibling of the up button').toBe(find);
		expect(find.nextElementSibling).toBe(up);
	});

	it('ラベルはインライン SVG: ボタンの中に svg[aria-hidden="true"] がちょうど 1 つ・テキストは無い(追補c-3)・aria-label は CJK を含まない(英語=要件#51)', () => {
		const { header } = mountExplorer();
		const find = findButton(header);

		const svgs = find.querySelectorAll('svg');
		expect(svgs, 'exactly one <svg> inside the find button').toHaveLength(1);
		expect(find.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
		expect((find.textContent ?? '').trim(), 'no text label next to the svg').toBe('');
		expect(FIND_LABEL).not.toMatch(CJK);
	});

	it('クリックすると onFindInFolder が 1 回呼ばれる(Tauri も confirmDiscardEdits も呼ばない)', async () => {
		const onFindInFolder = vi.fn();
		const { header } = mountExplorer({ onFindInFolder });

		await fireEvent.click(findButton(header));
		await flushAsync();

		expect(onFindInFolder).toHaveBeenCalledTimes(1);
		expect(invokeMock).not.toHaveBeenCalled();
		expect(confirmMock).not.toHaveBeenCalled();
		expect(windowState.root).toBe(ROOT);
	});

	it('onFindInFolder を渡さずにクリックしても例外にならず、何も起きない', async () => {
		const { header } = mountExplorer();
		// jsdom reports listener exceptions through console.error instead of rethrowing.
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			await expect(fireEvent.click(findButton(header))).resolves.toBeDefined();
			await flushAsync();
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}

		expect(invokeMock).not.toHaveBeenCalled();
		expect(confirmMock).not.toHaveBeenCalled();
	});

	it('ボタンは nav.explorer-list の外(要件#63 の zoom の外)にあり、explorerZoom=150 でも見出し行に zoom は付かない', () => {
		const { aside, nav, header } = mountExplorer({ explorerZoom: 150 });
		const find = findButton(header);

		expect(aside.contains(find)).toBe(true);
		expect(header.contains(find)).toBe(true);
		expect(nav.contains(find)).toBe(false);
		expect(nav.style.getPropertyValue('zoom')).toBe('150%');
		expect(hasInlineZoom(header)).toBe(false);
		expect(hasInlineZoom(find)).toBe(false);
		expect(aside.getAttribute('data-zoom-region')).toBe('explorer');
	});

	it('見出し行の他の要素は不変: 見出し Explorer・↑ ボタン・ボタンは Find in Folder と ↑ の 2 つだけ(この順=追補c-2)', () => {
		const { header, aside } = mountExplorer();

		const title = header.querySelector('.explorer-title');
		expect(title?.textContent?.trim()).toBe('Explorer');
		expect([...header.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
			FIND_LABEL,
			UP_LABEL,
		]);
		expect(upButton(header).disabled, 'up button still disabled state driven by parent uri').toBe(false);
		expect(aside.getAttribute('style')).toContain(`width: ${WIDTH}px`);
	});
});

// ---------------------------------------------------------------------------
// AC-55-24(ソース走査)— +page.svelte が Explorer にメニューと同じ受け口を渡す
// ---------------------------------------------------------------------------

describe('要件#55 追補c・AC-55-24(ソース走査): +page.svelte が <Explorer onFindInFolder> にメニューの受け口と同じ関数を渡す', () => {
	const page = () => readFileSync(resolve(__dirname, '../routes/+page.svelte'), 'utf-8');

	it('<Explorer … onFindInFolder={…}> が渡され、その関数は MENU_FIND_IN_FOLDER_EVENT の listen が呼ぶものと同じ', () => {
		const src = page();
		const listenMatch =
			/listen\(\s*MENU_FIND_IN_FOLDER_EVENT\s*,\s*\(\)\s*=>\s*\{?\s*(?:void\s+)?(\w+)\(/.exec(src);
		expect(listenMatch, 'listen(MENU_FIND_IN_FOLDER_EVENT, () => <fn>()) exists').toBeTruthy();
		const menuHandler = (listenMatch as RegExpExecArray)[1];

		const explorerTag = /<Explorer\b([\s\S]*?)\/>/.exec(src);
		expect(explorerTag, '<Explorer … /> tag exists').toBeTruthy();
		const attrs = (explorerTag as RegExpExecArray)[1];
		expect(attrs).toMatch(/onFindInFolder=\{/);
		expect(attrs).toMatch(new RegExp(`onFindInFolder=\\{[^}]*\\b${menuHandler}\\b`));
	});

	it('Explorer.svelte は Tauri の検索コマンドもイベント名も知らない(prop を呼ぶだけ)', () => {
		const src = readFileSync(resolve(__dirname, 'Explorer.svelte'), 'utf-8');
		expect(src).toMatch(/onFindInFolder/);
		expect(src).not.toMatch(/search_in_folder/);
		expect(src).not.toMatch(/MENU_FIND_IN_FOLDER_EVENT/);
		expect(src).not.toMatch(/menu_find_in_folder/);
	});
});

// ---------------------------------------------------------------------------
// AC-55-32(追補c-2 → 追補c-3 で更新)— ⌕ は専用 class を持ち、その svg は 20px 角以上の線画・
// `.find-button` の規則が <style> にある
// ---------------------------------------------------------------------------

/** `Explorer.svelte` の `<style>` の中身(無ければ空)。 */
function explorerStyle(): string {
	const src = readFileSync(resolve(__dirname, 'Explorer.svelte'), 'utf-8');
	const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(src);
	return m ? m[1] : '';
}

/**
 * CSS を `selector { body }` の並びとして素朴に読み、選択子リスト(`,` 区切り)のどれかが
 * ちょうど `.cls` である規則の body を返す(`.a.b` や `.a:hover` のような複合は含めない=
 * そのクラス自身の宣言だけを見る)。
 */
function ruleBodiesFor(css: string, cls: string): string[] {
	const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const bodies: string[] = [];
	const rule = /([^{}]+)\{([^{}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = rule.exec(noComments)) !== null) {
		const selectors = m[1].split(',').map((x) => x.trim());
		if (selectors.includes(`.${cls}`)) bodies.push(m[2]);
	}
	return bodies;
}

const UP_CLASS = 'up-button';
/** 追補c-3 の契約で名前が固定された ⌕ ボタンの専用 class(`<style>` に `.find-button` の規則があること)。 */
const FIND_CLASS = 'find-button';
/** 追補c-3: SVG の表示サイズは 20px 角(`width="20" height="20"`)。属性値として 20 以上を求める。 */
const MIN_SVG_SIZE = 20;

/** 属性値を数値で読む(`20` / `20px` を許す。無い・数にならないときは NaN)。 */
function attrPx(el: Element, name: string): number {
	const raw = el.getAttribute(name);
	if (raw === null) return Number.NaN;
	const m = /^\s*([\d.]+)(?:px)?\s*$/.exec(raw);
	return m ? Number(m[1]) : Number.NaN;
}

/** `el` 自身かその子孫のどれかが `attr="value"` を持つか(`fill` / `stroke` は svg 自身でも path でもよい)。 */
function selfOrDescendantHas(el: Element, attr: string, value: string): boolean {
	if (el.getAttribute(attr) === value) return true;
	return el.querySelector(`[${attr}="${value}"]`) !== null;
}

describe('要件#55 追補c-2/c-3・AC-55-32: ⌕ ボタンは ↑ と別の専用 class を持ち、svg は 20px 角以上の線画・.find-button の規則がある', () => {
	/** ⌕ のボタンにあって ↑ のボタンには無い class(=専用 class)。 */
	function dedicatedClasses(): { find: HTMLButtonElement; up: HTMLButtonElement; classes: string[] } {
		const { header } = mountExplorer();
		const find = findButton(header);
		const up = upButton(header);
		const classes = [...find.classList].filter((c) => !up.classList.contains(c));
		return { find, up, classes };
	}

	it('⌕ ボタンは ↑ ボタンに無い専用 class を 1 つ以上持つ(推奨 find-button)', () => {
		const { classes } = dedicatedClasses();
		expect(classes, 'find button needs a class that the up button does not have').not.toHaveLength(0);
	});

	it('⌕ ボタンの svg は width / height 属性がともに 20 以上・viewBox がある(追補c-3)', () => {
		const { find } = dedicatedClasses();
		const svg = find.querySelector('svg');
		expect(svg, '<svg> inside the find button').toBeTruthy();
		const icon = svg as SVGElement;

		expect(attrPx(icon, 'width'), 'svg width attribute (number, >= 20)').toBeGreaterThanOrEqual(MIN_SVG_SIZE);
		expect(attrPx(icon, 'height'), 'svg height attribute (number, >= 20)').toBeGreaterThanOrEqual(MIN_SVG_SIZE);
		expect((icon.getAttribute('viewBox') ?? '').trim(), 'svg viewBox attribute').not.toBe('');
	});

	it('⌕ ボタンの svg は線画: fill="none" と stroke="currentColor" を svg 自身か子要素に持ち、画像や外部参照を使わない(追補c-3)', () => {
		const { find } = dedicatedClasses();
		const svg = find.querySelector('svg');
		expect(svg, '<svg> inside the find button').toBeTruthy();
		const icon = svg as SVGElement;

		expect(selfOrDescendantHas(icon, 'fill', 'none'), 'fill="none" on svg or a child').toBe(true);
		expect(selfOrDescendantHas(icon, 'stroke', 'currentColor'), 'stroke="currentColor" on svg or a child').toBe(true);
		expect(icon.querySelector('*'), 'svg has at least one drawing child (circle + handle)').not.toBeNull();
		expect(find.querySelector('img, image'), 'no raster/external image inside the button').toBeNull();
		for (const use of icon.querySelectorAll('use')) {
			const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
			expect(href, '<use> must not reference an external file').toMatch(/^#/);
		}
	});

	it('⌕ ボタンは class find-button を持ち、Explorer.svelte の <style> に .find-button の規則がある(追補c-3・font-size の比較は撤廃)', () => {
		const { find, up } = dedicatedClasses();
		expect(find.classList.contains(FIND_CLASS)).toBe(true);
		expect(up.classList.contains(FIND_CLASS)).toBe(false);

		const bodies = ruleBodiesFor(explorerStyle(), FIND_CLASS);
		expect(bodies, `a rule with selector .${FIND_CLASS} in <style>`).not.toHaveLength(0);
		expect(bodies.some((b) => b.trim() !== ''), `.${FIND_CLASS} rule must declare something`).toBe(true);
	});

	it('↑ ボタンは専用 class を持たない(↑ のグリフの大きさは変えない)', () => {
		const { up, classes } = dedicatedClasses();
		for (const cls of classes) expect(up.classList.contains(cls)).toBe(false);
		expect(up.classList.contains(UP_CLASS)).toBe(true);
	});
});
