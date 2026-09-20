/**
 * 要件#54 追補b・追補c の受け入れテスト(docs/requirements/req-54.md「追補b」「追補c」)
 * — Viewer の配線(component プロジェクト)
 *
 * 人間ゲートの NG 2件(backlog 178 / 179)の機械判定できる範囲を固定する。既存の
 * `Viewer.find.wiring.test.ts` は書き換えず、本追補用に新設(家風はそこに倣う)。
 * 純関数側の契約(rewriteSurfaceCss / FIND_SURFACE_BASE_CSS)は
 * `src/lib/find-surface-style.acceptance.test.ts`(unit)。
 *
 * ## 実装側に求める seam(implementer はこれに従う。契約=本テストが決める)
 *
 * - **追補b(複製面のスタイル)**: `Viewer.svelte` の複製面組み立てで、文書の
 *   `<style>` を `src/lib/find-surface-style.ts` の `rewriteSurfaceCss` に通してから
 *   Shadow へ入れ、その**前**に `FIND_SURFACE_BASE_CSS` の `<style>` を置く
 *   (基底=UA 既定の再現 → 文書スタイルの順。文書側が基底を上書きできる)。
 *   AC-54-14 が SHA-256 で固定する `src/html/edit.ts`・`src/lib/html-viewer.ts`・
 *   `HtmlViewer.svelte` は**無改変**のまま(調整は Viewer 側か新純関数で行う)
 * - **追補c(1) 検索バーの sticky**: `data-testid="find-bar"` のルート要素に
 *   class **`find-bar--sticky`** を付ける(JSDOM の getComputedStyle は Svelte の
 *   `<style>` を計算しないため、契約を判定できる seam としてクラスを要求する)。
 *   加えて `FindBar.svelte` か `Viewer.svelte` の `<style>` テキストに
 *   `.find-bar…{ position: sticky; top: … }` の規則があることを固定する
 *   (AC-54-14 が repo ファイルを読んで固定しているのと同じ流儀)
 * - **追補c(2) スクロール経路**: `src/lib/find-in-document.ts` に純関数
 *   `scrollRangeIntoContainer(container: HTMLElement, range: Range): void` を置く。
 *   契約=**一致の文字範囲(Range)の矩形を基準に、スクロール容器の scrollTop を
 *   直接動かして中央へ運ぶ**:
 *   ```
 *   delta = (rangeRect.top + rangeRect.height / 2)
 *         - (containerRect.top + container.clientHeight / 2)
 *   container.scrollTop = Math.max(0, container.scrollTop + delta)
 *   ```
 *   `scrollIntoView` / `scrollTo` は使わない(JSDOM に無い・要素単位の中央寄せは
 *   `<pre contenteditable>` 全体が飛ぶ=backlog 179 の原因)。`Viewer.svelte` の
 *   現在一致への移動は**閲覧・ソース編集の両方**でこの経路に一本化し、
 *   要素(容器・`<pre>`・`<mark>`)への `scrollIntoView` は呼ばない
 *
 * ## 判定するもの
 * - AC-54b-6: html 文書の ⌘F 後、Shadow 内の `<style>` に書き換え済みセレクタが
 *   入り、素の `body{` が残らない(検索も引き続き効く)
 * - AC-54b-7: 基底 CSS(all:initial を含む style)が文書スタイルより前に入る
 * - AC-54c-1: FindBar のルートが sticky の seam を持ち、ツールバー直下・本文の前・
 *   スクロール容器(article.viewer)の中に居る+CSS 規則の値固定
 * - AC-54c-2: `scrollRangeIntoContainer` の中央寄せ計算(下へ・上へ=0 で止まる)と
 *   scrollIntoView 不使用
 * - AC-54c-3: 閲覧モードで語を入れると Range 経路で容器が動き、scrollIntoView は
 *   呼ばれない
 * - AC-54c-4: ソース編集(⌘E)中に語を入れても `<pre contenteditable>` /
 *   `article.viewer` を含むどの要素にも scrollIntoView が呼ばれず、同じ Range 経路で
 *   容器が動く
 *
 * ## 判定しないもの
 * - 見た目の一致そのもの(フォント・本文幅・余白・行間)→ 人間ゲート(④の再確認)
 * - rewriteSurfaceCss の書き換え規則の中身 → unit 側
 *
 * ## JSDOM 上の注意
 * - `getBoundingClientRect` はレイアウトを持たないので、容器(instance)と
 *   `Range.prototype` をスタブして「一致の矩形を容器の中央へ」の算術だけを判定する
 * - `scrollTop` は JSDOM の実装差を避けるため instance に accessor を定義して読む
 * - `Element.prototype.scrollIntoView` は spy(呼ばれないことが契約)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { scrollRangeIntoContainer } from '$lib/find-in-document';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({
	mountMermaid: vi.fn(async () => undefined),
}));

// menu_find の到着を写すための $lib/events モック(Viewer.find.wiring.test.ts と同型)。
vi.mock('$lib/events', () => {
	const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
	return {
		listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const cur = handlers.get(event) ?? [];
				const at = cur.indexOf(handler);
				if (at >= 0) cur.splice(at, 1);
			};
		},
		__eventHandlers: handlers,
	};
});

import * as eventsModule from '$lib/events';

const menuHandlers = (
	eventsModule as unknown as {
		__eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>>;
	}
).__eventHandlers;

const MENU_FIND = 'menu_find';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/zebra.md';
/** 'zebra'(大小無視)が見出し1・段落2の計3箇所。 */
const MD = '# Zebra\n\nzebra crossing zebra.\n';

const TXT_URI = 'file:///Users/a/notes/memo.txt';
const TXT = 'alpha beta gamma\n';

/** 追補b の主題=`<head>` の `<style>` に body{…} を持つ html 文書。 */
const HTML_URI = 'file:///Users/a/site/styled.html';
const HTML_SRC = [
	'<!doctype html>',
	'<html>',
	'<head>',
	'<title>Styled</title>',
	'<style>body{max-width:40em;margin:2em auto;font-family:serif}</style>',
	'</head>',
	'<body>',
	'<p id="a">Hello styled world</p>',
	'</body>',
	'</html>',
	'',
].join('\n');

let renderedMd: { html: string; index: SourceIndex };

beforeAll(async () => {
	const a = await renderMarkdown(MD, MD_URI);
	renderedMd = { html: a.html, index: a.index };
});

function baseProps(doc: DocumentPayload, html: string, index: SourceIndex | null = null) {
	return {
		document: doc,
		html,
		index,
		onRequestAddMark: vi.fn(),
		onToggleMarks: vi.fn(),
		marksOpen: false,
	};
}

function mountMd() {
	const doc: DocumentPayload = { uri: MD_URI, content: MD, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, renderedMd.html, renderedMd.index) });
}

function mountText() {
	const doc: DocumentPayload = { uri: TXT_URI, content: TXT, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, {
		props: baseProps(doc, '<pre class="vellis-plaintext">\n' + TXT + '</pre>'),
	});
}

function mountHtml() {
	const doc: DocumentPayload = { uri: HTML_URI, content: HTML_SRC, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, '') });
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

async function emitMenuFind() {
	await settle();
	const list = [...(menuHandlers.get(MENU_FIND) ?? [])];
	expect(
		list.length,
		"Viewer が $lib/events の listen で 'menu_find' を購読していること",
	).toBeGreaterThan(0);
	for (const handler of list) handler({ payload: undefined });
	await settle();
}

function findBar(container: HTMLElement): HTMLElement | null {
	return container.querySelector('[data-testid="find-bar"]');
}

function findInput(container: HTMLElement): HTMLInputElement {
	const el = container.querySelector('[data-testid="find-input"]');
	expect(el, '検索バーの入力欄(data-testid="find-input")があること').toBeTruthy();
	return el as HTMLInputElement;
}

function countText(container: HTMLElement): string {
	const el = container.querySelector('[data-testid="find-count"]');
	expect(el, '件数表示(data-testid="find-count")があること').toBeTruthy();
	return ((el as HTMLElement).textContent ?? '').trim();
}

async function typeQuery(container: HTMLElement, value: string) {
	await fireEvent.input(findInput(container), { target: { value } });
	await settle();
}

function surfaceShadow(container: HTMLElement): ShadowRoot {
	const host = container.querySelector('[data-testid="html-find-surface"]');
	expect(host, 'html の複製面(data-testid="html-find-surface")が出ること').toBeTruthy();
	const shadow = (host as HTMLElement).shadowRoot;
	expect(shadow, 'ホストが open な Shadow DOM を持つこと').toBeTruthy();
	return shadow as ShadowRoot;
}

/** CSS テキストの空白を正規化する(unit 側の norm と同じ規則)。 */
function norm(css: string): string {
	return css
		.replace(/\s+/g, ' ')
		.replace(/\s*([{}:;,>])\s*/g, '$1')
		.trim();
}

/** Shadow 内の `<style>` を文書順に、正規化して並べる。 */
function shadowStyles(shadow: ShadowRoot): string[] {
	return [...shadow.querySelectorAll('style')].map((s) => norm(s.textContent ?? ''));
}

const REPO_ROOT = resolve(__dirname, '../..');

function readRepoFile(rel: string): string {
	const path = resolve(REPO_ROOT, rel);
	expect(existsSync(path), rel + ' が存在すること').toBe(true);
	return readFileSync(path, 'utf8');
}

/** getBoundingClientRect 用の矩形(top と height だけが契約に効く)。 */
function rect(top: number, height: number): DOMRect {
	return {
		top,
		height,
		bottom: top + height,
		left: 0,
		right: 0,
		width: 0,
		x: 0,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

/**
 * 要素をスクロール容器に見立てる: 矩形 top=0 height=400・clientHeight=400・
 * scrollTop は accessor(JSDOM の実装差を避ける)。現在値の読み書き口を返す。
 */
function stubScrollContainer(el: HTMLElement, initial = 0): { value: () => number } {
	let scrollTop = initial;
	el.getBoundingClientRect = () => rect(0, 400);
	Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
	Object.defineProperty(el, 'scrollTop', {
		configurable: true,
		get: () => scrollTop,
		set: (v: number) => {
			scrollTop = v;
		},
	});
	return { value: () => scrollTop };
}

let scrollSpy: ReturnType<typeof vi.fn>;
const originalRangeRect = Range.prototype.getBoundingClientRect;

beforeEach(() => {
	windowState.endEdit();
	windowState.clearDocument();
	menuHandlers.clear();
	// 契約=scrollIntoView は**呼ばれない**(追補c)。spy して全テストで数える。
	scrollSpy = vi.fn();
	Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
	// Range の矩形はレイアウトが無いのでスタブ: 一致の矩形=top 700 / height 20。
	Range.prototype.getBoundingClientRect = () => rect(700, 20);
});

afterEach(() => {
	Range.prototype.getBoundingClientRect = originalRangeRect;
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-54b-6 / AC-54b-7 — 複製面のスタイル(追補b)
// ---------------------------------------------------------------------------

describe('AC-54b-6 — 文書の body{…} が複製面のルートに当たる形で入る(追補b)', () => {
	it('⌘F 後の Shadow 内 <style> に書き換え済みセレクタが入り、素の body{ は残らない(検索も効く)', async () => {
		const { container } = mountHtml();
		await emitMenuFind();

		const styles = shadowStyles(surfaceShadow(container));
		expect(styles.length).toBeGreaterThan(0);

		// 書き換え後: body → .vellis-html-find-root(宣言は無傷)。
		expect(
			styles.some((t) =>
				t.includes('.vellis-html-find-root{max-width:40em;margin:2em auto;font-family:serif}'),
			),
			'文書の body{…} が .vellis-html-find-root{…} に書き換わって入ること',
		).toBe(true);

		// 素の body セレクタが1つも残らない(残ると何にも当たらない=backlog 178)。
		for (const t of styles) {
			expect(t, '素の body{ セレクタが残らないこと: ' + t.slice(0, 80)).not.toMatch(
				/(^|[^-\w.#])body\{/,
			);
		}

		// スタイルを直しても検索は引き続き効く(追補は挙動を変えない)。
		await typeQuery(container, 'styled');
		expect(countText(container)).toBe('1 of 1');
	});
});

describe('AC-54b-7 — 基底 CSS(UA 既定の再現)が文書スタイルより前に入る(追補b)', () => {
	it('all:initial を持つ基底 style が、書き換え済み文書 style より前にある', async () => {
		const { container } = mountHtml();
		await emitMenuFind();

		const styles = shadowStyles(surfaceShadow(container));
		const baseIdx = styles.findIndex((t) => t.includes('all:initial'));
		const docIdx = styles.findIndex((t) => t.includes('max-width:40em'));

		expect(baseIdx, '基底 CSS(all:initial=FIND_SURFACE_BASE_CSS)の style があること').toBeGreaterThanOrEqual(0);
		expect(docIdx, '文書スタイル(max-width:40em)の style があること').toBeGreaterThanOrEqual(0);
		expect(baseIdx, '基底 CSS は文書スタイルより前(文書側が上書きできる)').toBeLessThan(docIdx);
	});
});

// ---------------------------------------------------------------------------
// AC-54c-1 — 検索バーは sticky でツールバー直下に積む(追補c(1))
// ---------------------------------------------------------------------------

describe('AC-54c-1 — 検索バーは sticky でツールバー直下(追補c)', () => {
	it('find-bar のルートに sticky の seam(class find-bar--sticky)が付き、ツールバー直下・本文の前・スクロール容器の中に居る', async () => {
		const { container } = mountMd();
		await emitMenuFind();

		const bar = findBar(container);
		expect(bar).toBeTruthy();
		expect(
			(bar as HTMLElement).classList.contains('find-bar--sticky'),
			'find-bar のルート要素に class "find-bar--sticky" が付くこと(sticky 契約の seam)',
		).toBe(true);

		// ツールバーの後・本文の前(重ねずに積む=DOM 順)。
		const toolbar = container.querySelector('.viewer-toolbar') as HTMLElement;
		const body = container.querySelector('.markdown-body') as HTMLElement;
		expect(toolbar).toBeTruthy();
		expect(body).toBeTruthy();
		expect(
			toolbar.compareDocumentPosition(bar as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
			'検索バーはツールバーより後にあること',
		).toBeTruthy();
		expect(
			(bar as HTMLElement).compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
			'検索バーは本文より前にあること',
		).toBeTruthy();

		// sticky が効く前提=スクロール容器(article.viewer)の中に居る。
		const viewer = container.querySelector('article.viewer') as HTMLElement;
		expect(viewer).toBeTruthy();
		expect(viewer.contains(bar as HTMLElement)).toBe(true);
	});

	it('FindBar.svelte / Viewer.svelte の <style> に .find-bar…{position: sticky; top: …} の規則がある(AC-54-14 と同じ repo 読みの流儀)', () => {
		const combined =
			readRepoFile('src/components/FindBar.svelte') + readRepoFile('src/components/Viewer.svelte');
		const rules = combined.match(/\.find-bar[^{}]*\{[^{}]*\}/g) ?? [];
		const sticky = rules.find((r) => /position:\s*sticky\b/.test(r));
		expect(
			sticky,
			'.find-bar(または .find-bar--sticky)への position: sticky の規則があること',
		).toBeTruthy();
		// `margin-top:` 等に誤マッチしないよう、直前が語構成文字や '-' でない top: を探す。
		expect(sticky as string, '同じ規則に top: の宣言があること(ツールバー直下に積む)').toMatch(
			/(^|[^-\w])top:\s*[^;}]+/,
		);
	});
});

// ---------------------------------------------------------------------------
// AC-54c-2 — scrollRangeIntoContainer の純関数契約(追補c(2))
// ---------------------------------------------------------------------------

describe('AC-54c-2 — scrollRangeIntoContainer: 一致の矩形を容器の中央へ(追補c)', () => {
	function containerWithRange(): { el: HTMLDivElement; range: Range } {
		const el = document.createElement('div');
		el.textContent = 'alpha beta gamma';
		const range = document.createRange();
		range.selectNodeContents(el.firstChild as Text);
		return { el, range };
	}

	it('下方の一致: scrollTop += (一致の中央 − 容器の中央)', () => {
		const { el, range } = containerWithRange();
		const scroll = stubScrollContainer(el, 100);
		// 一致の矩形 top=700 h=20(中央 710)・容器 top=0 clientHeight=400(中央 200)。
		range.getBoundingClientRect = () => rect(700, 20);

		scrollRangeIntoContainer(el, range);

		expect(scroll.value(), '100 + (710 - 200) = 610').toBe(610);
		expect(scrollSpy, 'scrollIntoView は使わないこと').not.toHaveBeenCalled();
	});

	it('上方の一致で負になるときは 0 で止まる', () => {
		const { el, range } = containerWithRange();
		const scroll = stubScrollContainer(el, 100);
		// 一致の中央 60・容器の中央 200 → delta -140 → 100 - 140 = -40 → 0。
		range.getBoundingClientRect = () => rect(50, 20);

		scrollRangeIntoContainer(el, range);

		expect(scroll.value()).toBe(0);
		expect(scrollSpy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-54c-3 / AC-54c-4 — 閲覧・ソース編集の両方で Range 経路(追補c(2))
// ---------------------------------------------------------------------------

describe('AC-54c-3 — 閲覧モード: 現在一致へは Range 経路で運ぶ(追補c)', () => {
	it('語を入れると容器(article.viewer)の scrollTop が一致の矩形基準で動き、scrollIntoView は呼ばれない', async () => {
		const { container } = mountMd();
		const viewer = container.querySelector('article.viewer') as HTMLElement;
		expect(viewer).toBeTruthy();
		const scroll = stubScrollContainer(viewer, 0);

		await emitMenuFind();
		await typeQuery(container, 'zebra');
		expect(countText(container)).toBe('1 of 3');

		expect(
			scrollSpy,
			'閲覧モードでも scrollIntoView は呼ばない(Range 経路に一本化)',
		).not.toHaveBeenCalled();
		// Range 矩形=top 700 h 20(beforeEach のスタブ)→ 0 + (710 - 200) = 510。
		expect(scroll.value(), '一致の矩形を容器の中央へ(scrollTop = 510)').toBe(510);
	});
});

describe('AC-54c-4 — ソース編集中: <pre> 全体を中央寄せしない(追補c)', () => {
	it('⌘E のソース編集中に語を入れても scrollIntoView は一切呼ばれず、同じ Range 経路で容器が動く', async () => {
		const { container } = mountText();
		const viewer = container.querySelector('article.viewer') as HTMLElement;
		expect(viewer).toBeTruthy();
		const scroll = stubScrollContainer(viewer, 0);

		// ⌘E(menu_edit 相当)=ソース編集モードへ(既存 wiring の家風どおり直接叩く)。
		windowState.beginEdit();
		await settle();
		const pre = container.querySelector('pre.vellis-plaintext[contenteditable="true"]');
		expect(pre, 'ソース編集の <pre contenteditable> が出ていること').toBeTruthy();

		await emitMenuFind();
		await typeQuery(container, 'beta');
		expect(countText(container)).toBe('1 of 1');

		// backlog 179 の再発防止: <pre>(子要素なし)にも article にも scrollIntoView
		// が飛ばない(要素の中央寄せで 930px 飛ぶ経路を残さない)。
		expect(scrollSpy).not.toHaveBeenCalled();
		// 閲覧モードと同じ Range 経路: 0 + (710 - 200) = 510。
		expect(scroll.value(), 'ソース編集中も一致の矩形基準で容器が動くこと').toBe(510);
	});
});
