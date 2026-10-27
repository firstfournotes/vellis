/**
 * 要件#54 追補e の受け入れテスト — 複製面・編集面のルートに文書の <html> / <body> の class が付く
 * (docs/requirements/req-54.md「追補e」(2026-10-25)・AC-54-追e (d)・Issue #550・#551)
 * — Viewer の配線(component プロジェクト)
 *
 * 純関数側(`rewriteSurfaceCss` の畳み込み=AC (a)(b)・`buildEditSurface` の `rootClasses`=AC (c))
 * は unit 側で固定する。ここでは `Viewer.svelte` が `rootClasses` の語を**両方の面のルートの
 * class に足す**ことと、その結果として畳んだ規則がルートに当たることを判定する。既存の
 * `Viewer.find.wiring.test.ts` / `Viewer.findfix.wiring.test.ts` / `Viewer.htmledit.wiring.test.ts`
 * は書き換えず、本追補用に新設(家風はそこに倣う)。
 *
 * ## 確定契約(追補e 3・4。implementer はこれに従う)
 * - `buildEditSurface(...).rootClasses: string[]`(文書の `<html>` と `<body>` の class の語・
 *   出てきた順・重複なし)
 * - 複製面(Command + F の検索面・`data-testid="html-find-surface"` の Shadow の中の
 *   `.vellis-html-find-root`)と編集面(`data-testid="html-edit-surface"` の Shadow の中の
 *   `.vellis-html-edit-root`)のルート要素は、その語を自分の class に足す。既存の class
 *   (`vellis-html-find-root` / `vellis-html-edit-root`)は残る
 * - 起案時判断 (c): 編集面にも同じく足す(`rewriteSurfaceCss` を共有しているので、片方だけだと
 *   編集中と検索中で見た目が違う)
 * - 不変: 保存される文書の中身(ルートの class は保存しない)・class の無い文書ではルートの
 *   class は今までどおり 1 語だけ
 *
 * ## 判定するもの
 * - (d)-1/(d)-3: ルート要素の classList に `dark` `x` `y` と既存の class が入る
 * - (d)-2/(d)-4: 文書の `html.dark body{background:#222;…}` が Shadow の `<style>` に入ったあと、
 *   その規則のセレクタでルート要素が `matches()` する(= 畳んだ規則が実際にルートへ当たる。
 *   AC (b) と (d) を端から端まで通した判定。JSDOM の `matches` はセレクタの照合を行う)
 * - (d)-5/(d)-6: class の無い文書ではルートの class は従来の 1 語だけ(余計な語を足さない)
 *
 * ## 判定しないもの
 * - 見た目(背景・文字の色が閲覧のときと同じ)→ 人間ゲート(機械で駆動できる)
 *
 * 実装前に赤い理由: `Viewer.svelte` はルートに `'vellis-html-find-root'` / `HTML_EDIT_ROOT_CLASS`
 * の 1 語だけを付けるので `dark` / `x` / `y` が無い((d)-1/(d)-3)。`rewriteSurfaceCss` は
 * `html.dark body` を `.root.dark .root` にするので、ルートは `matches()` しない((d)-2/(d)-4)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';

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

const HTML_URI = 'file:///Users/a/site/dark.html';

/** 追補e の主題=`<html class>` と、それを使う `html.dark body{…}` を持つ html 文書。 */
const DARK_SRC = [
	'<!doctype html>',
	'<html class="dark x">',
	'<head>',
	'<title>Dark</title>',
	'<style>html.dark body{background:#222;color:#eee}</style>',
	'</head>',
	'<body class="y dark">',
	'<p id="a">Hello dark world</p>',
	'</body>',
	'</html>',
	'',
].join('\n');

/** class を持たない html 文書(ルートの class が増えないことの対照)。 */
const PLAIN_SRC = [
	'<!doctype html>',
	'<html>',
	'<head><title>Plain</title><style>body{margin:0}</style></head>',
	'<body><p id="a">Hello plain world</p></body>',
	'</html>',
	'',
].join('\n');

function baseProps(doc: DocumentPayload, html: string) {
	return {
		document: doc,
		html,
		index: null,
		onRequestAddMark: vi.fn(),
		onToggleMarks: vi.fn(),
		marksOpen: false,
	};
}

/** html 文書を windowState と Viewer の両方に載せてマウントする(html 種別は html:'')。 */
function mountHtml(content: string) {
	const doc: DocumentPayload = { uri: HTML_URI, content, modified: 1 };
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

function shadowOf(container: HTMLElement, testid: string): ShadowRoot {
	const host = container.querySelector(`[data-testid="${testid}"]`);
	expect(host, `面のホスト(data-testid="${testid}")が出ること`).toBeTruthy();
	const shadow = (host as HTMLElement).shadowRoot;
	expect(shadow, 'ホストが open な Shadow DOM を持つこと').toBeTruthy();
	return shadow as ShadowRoot;
}

/** Command + F で複製面を出し、そのルート要素を返す。 */
async function findRoot(container: HTMLElement): Promise<HTMLElement> {
	await emitMenuFind();
	const shadow = shadowOf(container, 'html-find-surface');
	const root = shadow.querySelector('.vellis-html-find-root');
	expect(root, '複製面のルート(.vellis-html-find-root)があること').toBeTruthy();
	return root as HTMLElement;
}

/** ⌘E(beginEdit)で編集面を出し、そのルート要素を返す。 */
async function editRoot(container: HTMLElement): Promise<HTMLElement> {
	expect(windowState.beginEdit(), 'html 文書で beginEdit が true を返すこと').toBe(true);
	await settle();
	const shadow = shadowOf(container, 'html-edit-surface');
	const root = shadow.querySelector('.vellis-html-edit-root');
	expect(root, '編集面のルート(.vellis-html-edit-root)があること').toBeTruthy();
	return root as HTMLElement;
}

/** CSS テキストの空白を正規化する(unit 側の norm と同じ規則)。 */
function norm(css: string): string {
	return css
		.replace(/\s+/g, ' ')
		.replace(/\s*([{}:;,>])\s*/g, '$1')
		.trim();
}

/**
 * Shadow 内の `<style>` から、宣言 `background:#222` を持つ規則のセレクタを取り出す。
 * 文書の `html.dark body{background:#222;…}` を書き換えたものが 1 つだけ入っている前提。
 */
function darkRuleSelector(root: HTMLElement): string {
	const shadow = root.getRootNode() as ShadowRoot;
	const texts = [...shadow.querySelectorAll('style')].map((s) => norm(s.textContent ?? ''));
	const hit = texts.find((t) => t.includes('{background:#222'));
	expect(hit, '文書の html.dark body{background:#222;…} が Shadow の <style> に入ること').toBeTruthy();
	const m = /([^{}]+)\{background:#222/.exec(hit as string);
	expect(m, '規則のセレクタが読めること: ' + hit).toBeTruthy();
	return (m as RegExpExecArray)[1].trim();
}

beforeEach(() => {
	windowState.endEdit();
	windowState.clearDocument();
	menuHandlers.clear();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-54-追e (d) — 複製面(検索面)のルート
// ---------------------------------------------------------------------------

describe('AC-54-追e (d) — 複製面のルートに文書の <html> / <body> の class の語が入る', () => {
	it('(d)-1 .vellis-html-find-root の classList に dark / x / y が入り、既存の class も残る', async () => {
		const { container } = mountHtml(DARK_SRC);
		const root = await findRoot(container);

		expect(root.classList.contains('vellis-html-find-root'), '既存の class が残ること').toBe(true);
		for (const word of ['dark', 'x', 'y']) {
			expect(root.classList.contains(word), `rootClasses の語 "${word}" が入ること: ` + root.className).toBe(true);
		}
	});

	it('(d)-2 畳まれた html.dark body{…} の規則が複製面のルートに当たる(matches)', async () => {
		const { container } = mountHtml(DARK_SRC);
		const root = await findRoot(container);

		const selector = darkRuleSelector(root);
		expect(
			root.matches(selector),
			`ルート(class="${root.className}")が書き換え後のセレクタ "${selector}" に当たること`,
		).toBe(true);
	});

	it('(d)-5 class の無い文書では複製面のルートの class は従来の 1 語だけ', async () => {
		const { container } = mountHtml(PLAIN_SRC);
		const root = await findRoot(container);
		expect(root.className.trim()).toBe('vellis-html-find-root');
	});
});

// ---------------------------------------------------------------------------
// AC-54-追e (d) — 編集面のルート(起案時判断 (c))
// ---------------------------------------------------------------------------

describe('AC-54-追e (d) — 編集面のルートにも同じ語が入る(起案時判断 (c))', () => {
	it('(d)-3 .vellis-html-edit-root の classList に dark / x / y が入り、既存の class も残る', async () => {
		const { container } = mountHtml(DARK_SRC);
		const root = await editRoot(container);

		expect(root.classList.contains('vellis-html-edit-root'), '既存の class が残ること').toBe(true);
		for (const word of ['dark', 'x', 'y']) {
			expect(root.classList.contains(word), `rootClasses の語 "${word}" が入ること: ` + root.className).toBe(true);
		}
	});

	it('(d)-4 畳まれた html.dark body{…} の規則が編集面のルートに当たる(matches)', async () => {
		const { container } = mountHtml(DARK_SRC);
		const root = await editRoot(container);

		const selector = darkRuleSelector(root);
		expect(
			root.matches(selector),
			`ルート(class="${root.className}")が書き換え後のセレクタ "${selector}" に当たること`,
		).toBe(true);
	});

	it('(d)-6 class の無い文書では編集面のルートの class は従来の 1 語だけ', async () => {
		const { container } = mountHtml(PLAIN_SRC);
		const root = await editRoot(container);
		expect(root.className.trim()).toBe('vellis-html-edit-root');
	});
});
