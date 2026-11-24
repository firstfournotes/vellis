/**
 * 要件#74 第2段 2-7 — 別の文書を開いたらスクロールを先頭に(第2段の退行の直し・新しい判断なし=v0.6.0 の見え方に戻す)。
 *
 * 第1段の実機: 末尾までスクロールした文書の後に別の文書を開くと前の scrollTop が持ち越されて先頭が見えない。v0.6.0 は描画を待つ間に
 * 本文が空になって 0 に畳まれていた副作用があり、新しい面(CodeMirror / ProseMirror は `{#key document.uri}` で作り直すが、
 * スクロール容器 `article.viewer` は同じ要素)ではそれが消えた。
 *
 * ## 受け入れ基準(2-7)
 * (1) `article.viewer` の scrollTop が 500 のとき、別の uri の文書(コード・plain text・Markdown の各面、面の種別をまたいでも)を
 *     `windowState.setDocument` + 描き直し(rerender)で開くと scrollTop が 0
 * (2) 同じ uri の Reload File(+page と同じ `applyReloadedText` → 描き直し)と `file_changed` の取り込み(`applyFileChanged`)では 500 のまま。
 *     同じ uri で中身だけ変わった描き直しでも動かさない
 * (3) 初めて開くとき・Viewer が作り直されるとき(画像などを挟む)は 0
 * 既存の検索のスクロール(Viewer.findfix / findindex / FindInFolder / print-scroll / 要件73 の脚注)は無改変で緑のまま
 * (開いた後に一致へ跳ぶ動きは、0 にした後で跳ぶ)。
 *
 * ## 確定契約(implementer はこれに従う)
 * - `Viewer.svelte`: `document.uri` が変わったときだけ `viewerEl.scrollTop = 0`(`$effect` で uri を追う。同じ uri の content / html の変化では触らない)。
 *   動かすのは `article.viewer` の scrollTop だけ(`scrollIntoView`・`window.scrollTo` は使わない=要件54 追補c(2)と同じ)
 *
 * ## 修正前に赤になる理由
 * - 別の uri を開いても `article.viewer` の scrollTop が 500 のまま
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({ mountMermaid: vi.fn(async () => undefined) }));
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

beforeAll(() => {
	const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
	const emptyRects = () => Object.assign([] as DOMRect[], { item: (_i: number) => null }) as unknown as DOMRectList;
	const rangeProto = Range.prototype as unknown as Record<string, unknown>;
	if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = emptyRects;
	if (typeof rangeProto.getBoundingClientRect !== 'function') rangeProto.getBoundingClientRect = zeroRect;
	if (typeof (document as unknown as Record<string, unknown>).elementFromPoint !== 'function') {
		(document as unknown as Record<string, unknown>).elementFromPoint = () => null;
	}
});

const MD_URI = 'file:///Users/a/notes/long.md';
const MD = ['# Long', '', ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.`), ''].join('\n\n');
const MD_B_URI = 'file:///Users/a/notes/other.md';
const MD_B = '# Other\n\nShort.\n';
const TXT_URI = 'file:///Users/a/notes/memo.txt';
const TXT = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const TS_URI = 'file:///Users/a/src/main.ts';
const TS = 'export const a = 1;\nexport const b = 2;\n';

type Doc = { uri: string; content: string; html: string; index: SourceIndex | null };
const rendered = new Map<string, { html: string; index: SourceIndex }>();

function doc(uri: string, content: string, modified = 1): DocumentPayload {
	return { uri, content, modified };
}
function plainHtml(content: string): string {
	return `<pre class="vellis-plaintext">\n${content.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)}</pre>`;
}
async function propsFor(uri: string, content: string, modified = 1) {
	const d = doc(uri, content, modified);
	let html = plainHtml(content);
	let index: SourceIndex | null = null;
	if (uri.endsWith('.md')) {
		const key = `${uri}\n${content}`;
		if (!rendered.has(key)) {
			const r = await renderMarkdown(content, uri);
			rendered.set(key, { html: r.html, index: r.index });
		}
		html = rendered.get(key)!.html;
		index = rendered.get(key)!.index;
	}
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false };
}
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
	await new Promise((r) => setTimeout(r, 0));
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}
/** scrollTop は accessor(JSDOM の実装差を避ける)。現在値の読み口を返す。 */
function stubScroll(el: HTMLElement, initial: number): { value: () => number } {
	let scrollTop = initial;
	Object.defineProperty(el, 'scrollTop', {
		configurable: true,
		get: () => scrollTop,
		set: (v: number) => {
			scrollTop = v;
		},
	});
	return { value: () => scrollTop };
}
function viewerEl(container: ParentNode): HTMLElement {
	const el = container.querySelector<HTMLElement>('article.viewer');
	if (!el) throw new Error('article.viewer が無い');
	return el;
}
/** 文書を開き、面が出るのを待ってから scrollTop を 500 にする。 */
async function openAndScroll(uri: string, content: string) {
	const props = await propsFor(uri, content);
	windowState.setDocument(props.document);
	const result = render(Viewer, { props });
	await settle();
	const el = viewerEl(result.container);
	const scroll = stubScroll(el, 500);
	expect(scroll.value()).toBe(500);
	return { ...result, el, scroll };
}
/** +page と同じ: store を更新してから Viewer に新しい props を渡す。 */
async function openAnother(rerender: (p: Awaited<ReturnType<typeof propsFor>>) => Promise<void>, uri: string, content: string) {
	const props = await propsFor(uri, content);
	windowState.setDocument(props.document);
	await rerender(props);
	await settle();
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const FACE = {
	code: '[data-testid="code-editor"]',
	markdown: '[data-testid="markdown-editor"]',
};

describe('2-7 (1): 別の uri の文書を開くと article.viewer の scrollTop が 0 になる', () => {
	it('Markdown → 別の Markdown', async () => {
		const { container, rerender, scroll } = await openAndScroll(MD_URI, MD);
		expect(container.querySelector(FACE.markdown), 'Markdown の面').not.toBeNull();
		await openAnother(rerender, MD_B_URI, MD_B);
		expect(scroll.value()).toBe(0);
		expect(container.querySelector(FACE.markdown), '新しい文書の面').not.toBeNull();
	});

	it('plain text → 別の plain text(コードの面)', async () => {
		const { container, rerender, scroll } = await openAndScroll(TXT_URI, TXT);
		expect(container.querySelector(FACE.code), 'コードの面').not.toBeNull();
		await openAnother(rerender, 'file:///Users/a/notes/second.txt', 'second\n');
		expect(scroll.value()).toBe(0);
	});

	it('コード(.ts)→ 別のコード', async () => {
		const { rerender, scroll } = await openAndScroll(TS_URI, TS);
		await openAnother(rerender, 'file:///Users/a/src/other.ts', 'export {};\n');
		expect(scroll.value()).toBe(0);
	});

	it('面の種別をまたいでも 0(Markdown → plain text → コード → Markdown)', async () => {
		const { rerender, scroll, el } = await openAndScroll(MD_URI, MD);
		await openAnother(rerender, TXT_URI, TXT);
		expect(scroll.value()).toBe(0);
		el.scrollTop = 500;
		await openAnother(rerender, TS_URI, TS);
		expect(scroll.value()).toBe(0);
		el.scrollTop = 500;
		await openAnother(rerender, MD_B_URI, MD_B);
		expect(scroll.value()).toBe(0);
	});

	it('開いた後に scrollTop を動かしても、次に別の文書を開くとまた 0(毎回)', async () => {
		const { rerender, scroll, el } = await openAndScroll(MD_URI, MD);
		await openAnother(rerender, MD_B_URI, MD_B);
		expect(scroll.value()).toBe(0);
		el.scrollTop = 320;
		await openAnother(rerender, MD_URI, MD);
		expect(scroll.value()).toBe(0);
	});
});

describe('2-7 (2): 同じ uri の読み直し・外部変更の取り込みでは scrollTop を動かさない', () => {
	it('Reload File(applyReloadedText → 同じ uri の描き直し)で 500 のまま(Markdown)', async () => {
		const { rerender, scroll } = await openAndScroll(MD_URI, MD);
		const reloaded = await propsFor(MD_URI, MD.replace('Paragraph 1.', 'Paragraph one.'), 2);
		windowState.applyReloadedText(reloaded.document);
		await rerender(reloaded);
		await settle();
		expect(scroll.value()).toBe(500);
	});

	it('Reload File で 500 のまま(plain text=コードの面)', async () => {
		const { rerender, scroll } = await openAndScroll(TXT_URI, TXT);
		const reloaded = await propsFor(TXT_URI, 'changed\n' + TXT, 2);
		windowState.applyReloadedText(reloaded.document);
		await rerender(reloaded);
		await settle();
		expect(scroll.value()).toBe(500);
	});

	it('file_changed の取り込み(applyFileChanged → 同じ uri の描き直し)で 500 のまま(Markdown・plain text)', async () => {
		for (const [uri, content, next] of [
			[MD_URI, MD, MD + '\nAppended.\n'],
			[TXT_URI, TXT, TXT + 'appended\n'],
		] as const) {
			cleanup();
			windowState.clearDocument();
			windowState.fileEditor = null;
			const { rerender, scroll } = await openAndScroll(uri, content);
			const changed = await propsFor(uri, next, 3);
			windowState.applyFileChanged(changed.document);
			await settle();
			await rerender(changed);
			await settle();
			expect(scroll.value(), uri).toBe(500);
		}
	});

	it('同じ uri・同じ内容の描き直し(props の参照だけ変わる)でも 500 のまま', async () => {
		const { rerender, scroll } = await openAndScroll(MD_URI, MD);
		await rerender(await propsFor(MD_URI, MD));
		await settle();
		expect(scroll.value()).toBe(500);
	});
});

describe('2-7 (3): 初めて開くとき・Viewer が作り直されるときは 0', () => {
	it('初めて開いた直後の article.viewer の scrollTop は 0(Markdown・plain text・コード)', async () => {
		for (const [uri, content] of [
			[MD_URI, MD],
			[TXT_URI, TXT],
			[TS_URI, TS],
		] as const) {
			cleanup();
			windowState.clearDocument();
			windowState.fileEditor = null;
			const props = await propsFor(uri, content);
			windowState.setDocument(props.document);
			const { container } = render(Viewer, { props });
			await settle();
			expect(viewerEl(container).scrollTop, uri).toBe(0);
		}
	});

	it('画像などを挟んで Viewer が作り直されると(unmount → 新しい Viewer)0', async () => {
		const first = await openAndScroll(MD_URI, MD);
		expect(first.scroll.value()).toBe(500);
		first.unmount();
		// 画像の表示(ImageViewer)を挟んだ後、別の文書で Viewer を新しく作る
		windowState.setDocument(doc('file:///Users/a/pics/photo.png', ''));
		windowState.clearDocument();
		const props = await propsFor(MD_B_URI, MD_B);
		windowState.setDocument(props.document);
		const { container } = render(Viewer, { props });
		await settle();
		const el = viewerEl(container);
		expect(el).not.toBe(first.el);
		expect(el.scrollTop).toBe(0);
	});
});
