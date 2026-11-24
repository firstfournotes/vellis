/**
 * 要件#74 第2段 2-4(NodeView=描画のまま直しにくいものの見せ方)— AC-74-34・35・36・AC-74-10 の書き直し案(契約7・17・項目 20・22〜25)。
 *
 * **仮の前提(2026-11-17・由谷の確認待ち)**: 2-1〜2-3 の判断 1〜5・7〜10 に加えて、判断 6=脚注の定義は原文の位置に定義のブロック
 * として見せる(番号は参照の順・戻りリンク ↩。印刷と読み取り専用の描画は今のまま末尾)・判断 11=先頭が HTML の注釈で次に `---` が
 * 来る文書は front matter にしない(今の描画と同じ)。回答が推奨と違えば「判断 6 に依存」「判断 11 に依存」の describe を書き直す。
 *
 * ## 対応する受け入れ基準
 * - AC-74-34 mermaid(契約7・項目 22): カーソルが外=図のノード(`.vellis-mermaid[data-mermaid-source]`・mountMermaid が呼ばれる)・
 *            中=埋め込みの CodeMirror。中身を変えると書き出しのその fence だけが変わり、描き直しは間をおいて 1 回。変換中は描き直されない
 * - AC-74-35 生 HTML と front matter(契約7・項目 24): ブロックとインライン(対応する閉じタグまで)が編集できない塊で、今の描画と同じ
 *            sanitize を通した HTML(`<script>`・`on*`・`javascript:` が出ない)。触らなければ書き出しは byte 等価。front matter は札。
 *            リンク参照定義は面に出ない
 * - AC-74-36 航行(契約17・項目 20・判断 5): 脚注参照のクリックで定義へ・戻りリンクで参照へ・`#id`(生 HTML の id)でその要素へ。
 *            クリックで文書は変わらない(dirty にならない)。Option + クリックでカーソル
 * - AC-74-10 の書き直し案: ProseMirror の根と code fence の埋め込みの CodeMirror(`.cm-content`)以外に contenteditable="true" が無い
 * - 項目 23 code fence の CodeMirror 埋め込み: 色付きのまま打てる(中の変更は PM の取引・CodeMirror の履歴は持たない・undo は文書で 1 つ)・
 *            言語の札 `code-lang-chip` で lang を変える(そのブロックだけ 3 段目)
 * - 項目 25 画像: DOM の src は rewrite-uri と同じ規則で vellis-asset:(原文には焼き付けない)
 * - 契約17   見た目が今の描画と同じ=DOM の構造(タグ・class・sanitize の結果)を今の `render` と比べて固定する。実際の見え方は人間ゲート 5・7
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 第2段の作り(案)20・22〜25。無いものは test-writer が固定)
 *
 * ```ts
 * // --- MarkdownEditor の EditorView に nodeViews を渡す(src/editor/node-views/*.ts か MarkdownEditor.svelte の中)
 * // code_block(lang !== 'mermaid'): <pre data-lang=…>(schema の toDOM と同じ外形・.markdown-body の直下)の中に
 * //   <input|select data-testid="code-lang-chip" value={lang ?? ''}>(change で lang を変える)と .cm-editor(.cm-content[contenteditable=true])。
 * //   CodeMirror の変更は PM の取引に写す(CodeMirror の history は入れない=@codemirror/commands の undoDepth が 0 のまま)
 * // code_block(lang === 'mermaid'): 選択が外=<div class="vellis-mermaid" data-mermaid-source={text} contenteditable="false">(今の placeholder と同じ形)
 * //   を作って mountMermaid(そのノードの DOM か、それを含む要素)。選択が中=上と同じ埋め込みの CodeMirror(図は出さない)。
 * //   中身が変わって選択が外に出たら 500 ms おいて mountMermaid を 1 回。変換中(composing)は描き直さない
 * // html_block: <div class="vellis-raw-html" contenteditable="false"> の中身= render(raw) の sanitize 済み HTML(data-vellis-* を除いて同じ)
 * // html_inline: <span class="vellis-raw-html-inline" contenteditable="false"> の中身= render(raw) の外の <p> を剥がしたもの
 * // front_matter: <div class="front-matter-chip" data-testid="front-matter-chip" contenteditable="false">Front matter · N lines</div>
 * // definition: 面に出ない(hidden か DOM 無し)。URL の文字が面の textContent に現れない
 * // image: <img src={toAssetUri(resolveRelative(uri, attrs.src))}(相対のとき。外部はそのまま) alt title>。attrs.src と書き出しは原文のまま
 * // footnote_reference: <sup class="footnote-ref" data-label><a href="#fn-<label>">N</a></sup>(N=参照の順の番号。判断 6)
 * // footnote_definition: <section class="footnote-definition" data-label data-footnote-number="N"> … <a class="footnote-backref" href="#fnref-<label>" contenteditable="false">↩</a></section>
 * // 航行(handleClick): sup のクリック → その label の footnote_definition の DOM を scrollElementIntoViewer と同じ運び方(article.viewer の scrollTop)
 * //   か el.scrollIntoView で運ぶ。戻りリンク → その sup。`#<id>` → id か user-content-<id> を持つ要素(生 HTML の id)。文書・選択・dirty は変えない
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-17)
 * - 今の描画との一致は `render(raw)` を同じテストで呼んで比べる(値を写さない)。属性は `data-vellis-*` / `data-source-*` を除いて比べる
 * - jsdom は scrollIntoView を持たず scrollTop も測れないので、`Element.prototype.scrollIntoView` のスタブと `article.viewer` の scrollTop の
 *   setter のスパイのどちらかが行き先(かスクロール容器)に対して呼ばれたことで「運んだ」と見る
 * - 描き直しの 500 ms は本物の時計で見る(100 ms では呼ばれず、700 ms で 1 回、その後 600 ms 待っても増えない)
 *
 * ## 修正前に赤になる理由
 * - nodeViews が無い(code_block が <pre><code> のまま・mermaid が placeholder にならず mountMermaid が呼ばれない・html_block が空の塊・
 *   front-matter-chip の testid が無い・脚注の番号が label のまま・img の src が原文のまま・脚注のクリックで運ばない)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { TextSelection } from 'prosemirror-state';
import { undoDepth } from 'prosemirror-history';
import type { EditorView as PMView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorView as CMView } from '@codemirror/view';
import { undoDepth as cmUndoDepth } from '@codemirror/commands';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { resolveRelative, toAssetUri } from '$lib/uri';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import { blockPos, fixture, textSpots } from '../editor/markdown.testkit';

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
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = { label: 'main', emit: vi.fn(async () => undefined), onFocusChanged: vi.fn(async () => () => {}), listen: vi.fn(async () => () => {}) };
	return { ...actual, getCurrentWindow: () => fake };
});
import { mountMermaid } from '$lib/mermaid-mounter';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '$lib/ipc';

const mountMermaidMock = vi.mocked(mountMermaid);
const openUrlMock = vi.mocked(openUrl);
const invokeMock = vi.mocked(invoke);

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

// ---------------------------------------------------------------------------
// フィクスチャと helper
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/plan.md';
const NV = fixture('nodeviews.md');

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
type ViewerProps = { fileEditor?: boolean; zoom?: number; codeTheme?: string };
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null, extra: ViewerProps) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false, ...extra };
}
async function settle(rounds = 8) {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
	await tick();
}
async function settleLong() {
	await settle();
	await new Promise((r) => setTimeout(r, 0));
	await settle();
}
async function wait(ms: number) {
	await new Promise((r) => setTimeout(r, ms));
	await settle();
}
async function mountMd(content: string, extra: ViewerProps = {}, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index, { fileEditor: true, ...extra }) });
	await settleLong();
	return result;
}

const BODY = 'article.viewer .markdown-body';
const FACE = `${BODY} [data-testid="markdown-editor"]`;
const PM = `${FACE} .ProseMirror`;

function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
function qa(container: ParentNode, selector: string): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(selector)];
}
function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h) throw new Error('windowState.fileEditor が登録されていない');
	if (h.kind !== 'markdown') throw new Error(`handle.kind が markdown でない: ${String(h.kind)}`);
	return h;
}
function pm(): PMView {
	return handle().view;
}
function text(): string {
	return handle().text();
}
function selectPm(from: number, to = from) {
	const v = pm();
	v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)));
}
function keyPm(k: string, init: KeyboardEventInit = {}) {
	pm().dom.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
}
/** 最上位ブロックのうち `pred` に合う最初のものの index と node。 */
function findBlock(pred: (n: PMNode) => boolean): { index: number; node: PMNode; pos: number } {
	const d = pm().state.doc;
	for (let i = 0; i < d.childCount; i++) {
		const n = d.child(i);
		if (pred(n)) return { index: i, node: n, pos: blockPos(d, i) };
	}
	throw new Error('block not found');
}
function codeBlock(lang: string) {
	return findBlock((n) => n.type.name === 'code_block' && n.attrs.lang === lang);
}
/** `pre[data-lang]` の中(か mermaid の塊の中)の埋め込み CodeMirror。 */
function embeddedCm(container: ParentNode, blockDom: HTMLElement): CMView {
	const el = blockDom.querySelector<HTMLElement>('.cm-editor') ?? (blockDom.matches('.cm-editor') ? blockDom : null);
	if (!el) throw new Error('埋め込みの CodeMirror が無い');
	const v = CMView.findFromDOM(el);
	if (!v) throw new Error('EditorView.findFromDOM が null');
	void container;
	return v;
}
function blockDom(pos: number): HTMLElement {
	const dom = pm().nodeDOM(pos) as HTMLElement | null;
	if (!dom) throw new Error(`nodeDOM(${pos}) が無い`);
	return dom;
}
/** 今の描画(render)の sanitize 済み HTML を比較用に正規化する。 */
function normalizeHtml(html: string): string {
	const host = document.createElement('div');
	host.innerHTML = html;
	for (const el of host.querySelectorAll('*')) {
		for (const attr of [...el.attributes]) {
			if (attr.name.startsWith('data-vellis-') || attr.name.startsWith('data-source-')) el.removeAttribute(attr.name);
		}
	}
	return host.innerHTML.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
}
async function renderedHtmlOf(src: string): Promise<string> {
	const r = await renderMarkdown(src, MD_URI);
	return r.html;
}
/** 外の `<p …>`(source-map の data-vellis-* / data-source-* つきでもよい)を剥がす。<p> が複数なら剥がさない。 */
function stripOuterP(html: string): string {
	const host = document.createElement('div');
	host.innerHTML = html.trim();
	const kids = [...host.children];
	if (kids.length === 1 && kids[0]!.tagName.toLowerCase() === 'p' && host.childNodes.length === 1) return kids[0]!.innerHTML;
	const m = /^\s*<p(?:\s[^>]*)?>([\s\S]*)<\/p>\s*$/.exec(html);
	return m ? m[1]! : html;
}

/** 運んだことの観測: scrollIntoView のスタブと article.viewer の scrollTop の setter。 */
const scrolled: Array<{ kind: 'scrollIntoView' | 'scrollTop'; target: Element }> = [];
function installScrollSpies() {
	scrolled.length = 0;
	Object.defineProperty(Element.prototype, 'scrollIntoView', {
		configurable: true,
		writable: true,
		value: function (this: Element) {
			scrolled.push({ kind: 'scrollIntoView', target: this });
		},
	});
	const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
	Object.defineProperty(Element.prototype, 'scrollTop', {
		configurable: true,
		get() {
			return desc?.get ? (desc.get.call(this) as number) : 0;
		},
		set(this: Element, v: number) {
			scrolled.push({ kind: 'scrollTop', target: this });
			desc?.set?.call(this, v);
		},
	});
	return () => {
		if (desc) Object.defineProperty(Element.prototype, 'scrollTop', desc);
	};
}
let restoreScroll: (() => void) | null = null;

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	invokeMock.mockReset();
	invokeMock.mockImplementation(async () => null);
	mountMermaidMock.mockClear();
	openUrlMock.mockClear();
	restoreScroll = installScrollSpies();
});
afterEach(() => {
	cleanup();
	restoreScroll?.();
	restoreScroll = null;
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC-74-10 の書き直し案・項目 23: code fence の CodeMirror 埋め込み
// ---------------------------------------------------------------------------

describe('項目 23・AC-74-10(書き直し案): code fence は CodeMirror の埋め込みで、contenteditable は PM の根と .cm-content だけ', () => {
	it('ts の fence: pre[data-lang=ts] が .markdown-body の直下にあり、その中に .cm-editor と code-lang-chip。contenteditable の数= 1 + fence の数', async () => {
		const { container } = await mountMd(NV);
		const ts = codeBlock('ts');
		const dom = blockDom(ts.pos);
		expect(dom.tagName.toLowerCase()).toBe('pre');
		expect(dom.getAttribute('data-lang')).toBe('ts');
		expect(dom.parentElement?.classList.contains('markdown-body')).toBe(true);
		expect(dom.querySelector('.cm-editor'), '埋め込みの CodeMirror').not.toBeNull();
		expect(dom.querySelector('.cm-content[contenteditable="true"]')).not.toBeNull();
		const chip = dom.querySelector<HTMLInputElement | HTMLSelectElement>('[data-testid="code-lang-chip"]');
		expect(chip, '言語の札').not.toBeNull();
		expect(chip!.value).toBe('ts');
		// mermaid は図(選択が外)なので CodeMirror は ts の 1 つ。PM の根 + 1
		const editables = qa(container, `${BODY} [contenteditable="true"]`);
		expect(editables).toHaveLength(2);
		expect(editables.every((el) => el.classList.contains('ProseMirror') || el.classList.contains('cm-content'))).toBe(true);
		expect(embeddedCm(container, dom).state.doc.toString()).toBe('const x: number = 1;');
	});

	it('埋め込みの CodeMirror で打つと PM の文書(書き出しのその fence だけ)が変わり、CodeMirror の履歴は持たず、PM の Ctrl+Z 1 回で戻る', async () => {
		const { container } = await mountMd(NV);
		const ts = codeBlock('ts');
		const cm = embeddedCm(container, blockDom(ts.pos));
		const depth = undoDepth(pm().state);
		cm.dispatch({ changes: { from: 'const x: number = '.length, insert: '4' } });
		await settleLong();
		const expected = NV.replace('const x: number = 1;', 'const x: number = 41;');
		expect(text()).toBe(expected);
		expect(codeBlock('ts').node.textContent).toBe('const x: number = 41;');
		expect(handle().dirty).toBe(true);
		expect(cmUndoDepth(cm.state), 'CodeMirror の履歴は無い(undo は文書で 1 つ)').toBe(0);
		expect(undoDepth(pm().state)).toBe(depth + 1);
		keyPm('z', { ctrlKey: true });
		await settleLong();
		expect(text()).toBe(NV);
		expect(handle().dirty).toBe(false);
		expect(embeddedCm(container, blockDom(codeBlock('ts').pos)).state.doc.toString(), 'undo が埋め込みにも反映').toBe('const x: number = 1;');
	});

	it('言語の札で lang を変えると、そのブロックだけが 3 段目で書き直され(```js)、他は byte 等価', async () => {
		const { container } = await mountMd(NV);
		const ts = codeBlock('ts');
		const chip = blockDom(ts.pos).querySelector<HTMLInputElement>('[data-testid="code-lang-chip"]')!;
		chip.value = 'js';
		await fireEvent.input(chip, { target: { value: 'js' } });
		await fireEvent.change(chip, { target: { value: 'js' } });
		await fireEvent.keyDown(chip, { key: 'Enter' });
		await settleLong();
		expect(codeBlock('js').node.attrs.lang).toBe('js');
		expect(text()).toBe(NV.replace('```ts\n', '```js\n'));
		expect(blockDom(codeBlock('js').pos).getAttribute('data-lang')).toBe('js');
		void container;
	});
});

// ---------------------------------------------------------------------------
// AC-74-34: mermaid
// ---------------------------------------------------------------------------

describe('AC-74-34・項目 22: mermaid はカーソルが外なら図(今の placeholder と同じ形)、中なら埋め込みの CodeMirror', () => {
	const SOURCE = 'graph TD\n  A --> B';

	it('開いた直後: .vellis-mermaid[data-mermaid-source] が .markdown-body の直下・contenteditable=false・mountMermaid が呼ばれる・CodeMirror は無い', async () => {
		const { container } = await mountMd(NV);
		const mm = codeBlock('mermaid');
		const dom = blockDom(mm.pos);
		const fig = dom.matches('.vellis-mermaid') ? dom : dom.querySelector<HTMLElement>('.vellis-mermaid');
		expect(fig, '図のノード').not.toBeNull();
		expect(fig!.getAttribute('data-mermaid-source')).toBe(SOURCE);
		expect(fig!.closest('[contenteditable="false"]'), '図は打てない').not.toBeNull();
		expect(dom.parentElement?.classList.contains('markdown-body')).toBe(true);
		expect(dom.querySelector('.cm-editor')).toBeNull();
		// 今の描画の placeholder と同じ class と属性
		const today = await renderedHtmlOf('```mermaid\n' + SOURCE + '\n```\n');
		expect(today).toContain('class="vellis-mermaid"');
		expect(today).toContain('data-mermaid-source=');
		expect(mountMermaidMock).toHaveBeenCalled();
		const root = mountMermaidMock.mock.calls.at(-1)![0] as ParentNode;
		expect(root.querySelectorAll('.vellis-mermaid').length, 'mountMermaid の root から図が見える').toBeGreaterThan(0);
		expect(text()).toBe(NV);
		void container;
	});

	it('選択を中に入れると CodeMirror に切り替わり(図は消える)、外に出すと図に戻る', async () => {
		const { container } = await mountMd(NV);
		const mm = codeBlock('mermaid');
		selectPm(mm.pos + 1 + 'graph'.length);
		await settleLong();
		let dom = blockDom(codeBlock('mermaid').pos);
		expect(dom.querySelector('.cm-editor') ?? (dom.matches('.cm-editor') ? dom : null), '中=CodeMirror').not.toBeNull();
		expect(qa(container, `${BODY} .vellis-mermaid`)).toHaveLength(0);
		expect(embeddedCm(container, dom).state.doc.toString()).toBe(SOURCE);
		// 外へ
		const tail = textSpots(pm().state.doc, pm().state.doc.childCount - 1)[0]!;
		selectPm(tail.pos);
		await settleLong();
		dom = blockDom(codeBlock('mermaid').pos);
		expect(qa(container, `${BODY} .vellis-mermaid`)).toHaveLength(1);
		expect(dom.querySelector('.cm-editor')).toBeNull();
		expect(text(), '出入りだけでは文書は変わらない').toBe(NV);
		expect(handle().dirty).toBe(false);
	});

	it('中身を変えて外に出ると、その fence だけが変わり、描き直しは 500 ms おいて 1 回(100 ms では未・700 ms で 1 回・その後増えない)', async () => {
		const { container } = await mountMd(NV);
		const mm = codeBlock('mermaid');
		selectPm(mm.pos + 1 + SOURCE.length);
		await settleLong();
		const cm = embeddedCm(container, blockDom(codeBlock('mermaid').pos));
		cm.dispatch({ changes: { from: SOURCE.length, insert: '\n  B --> C' } });
		await settleLong();
		const edited = NV.replace(SOURCE, SOURCE + '\n  B --> C');
		expect(text()).toBe(edited);
		const tail = textSpots(pm().state.doc, pm().state.doc.childCount - 1)[0]!;
		mountMermaidMock.mockClear();
		selectPm(tail.pos);
		await wait(100);
		expect(mountMermaidMock, '100 ms では描き直さない').not.toHaveBeenCalled();
		const fig = q(container, `${BODY} .vellis-mermaid`)!;
		expect(fig.getAttribute('data-mermaid-source')).toBe(SOURCE + '\n  B --> C');
		await wait(600);
		expect(mountMermaidMock, '間をおいて 1 回').toHaveBeenCalledTimes(1);
		await wait(600);
		expect(mountMermaidMock).toHaveBeenCalledTimes(1);
		expect(text()).toBe(edited);
	});

	it('変換中は描き直されない(compositionend の後に 1 回)', async () => {
		const { container } = await mountMd(NV);
		const mm = codeBlock('mermaid');
		selectPm(mm.pos + 1 + SOURCE.length);
		await settleLong();
		const cm = embeddedCm(container, blockDom(codeBlock('mermaid').pos));
		cm.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		cm.dispatch({ changes: { from: SOURCE.length, insert: '\n  C --> D' } });
		await settleLong();
		const tail = textSpots(pm().state.doc, pm().state.doc.childCount - 1)[0]!;
		mountMermaidMock.mockClear();
		selectPm(tail.pos);
		await wait(700);
		expect(mountMermaidMock, '変換中は描き直さない').not.toHaveBeenCalled();
		pm().dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		cm.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		await wait(700);
		expect(mountMermaidMock).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// AC-74-35: 生 HTML・front matter・参照定義
// ---------------------------------------------------------------------------

describe('AC-74-35・契約7・項目 24: 生 HTML のブロックとインラインは今の描画と同じ sanitize 済み HTML の、編集できない塊', () => {
	it('html_block: .vellis-raw-html[contenteditable=false] の中身が render(raw) と同じ(script・on*・javascript: は無い)。書き出しは byte 等価', async () => {
		const { container } = await mountMd(NV);
		const hb = findBlock((n) => n.type.name === 'html_block');
		const dom = blockDom(hb.pos);
		const block = dom.matches('.vellis-raw-html') ? dom : dom.querySelector<HTMLElement>('.vellis-raw-html')!;
		expect(block).not.toBeNull();
		expect(block.getAttribute('contenteditable')).toBe('false');
		const today = await renderedHtmlOf(String(hb.node.attrs.raw) + '\n');
		expect(normalizeHtml(block.innerHTML)).toBe(normalizeHtml(today));
		expect(block.querySelector('script')).toBeNull();
		expect(block.innerHTML).not.toMatch(/on(click|error)=/);
		expect(block.innerHTML).not.toContain('javascript:');
		expect(block.querySelector('p')?.textContent).toBe('生 HTML のブロック');
		expect(block.querySelector('.note'), 'class は sanitize を通って残る').not.toBeNull();
		expect(text()).toBe(NV);
		void container;
	});

	it('html_inline: 対応する閉じタグまでが 1 つの塊(.vellis-raw-html-inline[contenteditable=false])で、中身は render(raw) の <p> を剥がしたもの。<br> は単独の塊', async () => {
		const { container } = await mountMd(NV);
		const para = findBlock((n) => n.type.name === 'paragraph' && n.textContent.includes('段落の中の'));
		const inlines: PMNode[] = [];
		para.node.forEach((c) => {
			if (c.type.name === 'html_inline') inlines.push(c);
		});
		expect(inlines.map((n) => n.attrs.raw)).toEqual(['<kbd>Cmd</kbd>', '<span class="x" onclick="evil()">span の塊</span>', '<br>']);
		const spans = qa(blockDom(para.pos), '.vellis-raw-html-inline');
		expect(spans).toHaveLength(3);
		for (const [i, span] of spans.entries()) {
			expect(span.getAttribute('contenteditable')).toBe('false');
			const today = stripOuterP(await renderedHtmlOf(String(inlines[i]!.attrs.raw) + '\n'));
			expect(today, `inline ${i}: 外の <p> が剥がれている`).not.toMatch(/^\s*<p[\s>]/);
			expect(normalizeHtml(span.innerHTML), `inline ${i}`).toBe(normalizeHtml(today));
		}
		expect(spans[0]!.querySelector('kbd')?.textContent).toBe('Cmd');
		expect(spans[1]!.querySelector('span.x')?.textContent).toBe('span の塊');
		expect(spans[1]!.innerHTML).not.toContain('onclick');
		expect(spans[2]!.querySelector('br')).not.toBeNull();
		// 塊の中には打てない(その位置の親が textblock でない=atom)
		expect(inlines.every((n) => n.isAtom)).toBe(true);
		expect(text()).toBe(NV);
		void container;
	});

	it('front_matter: 札 data-testid="front-matter-chip"(contenteditable=false・"Front matter · N lines")。書き出しは byte 等価', async () => {
		const { container } = await mountMd(NV);
		const fm = findBlock((n) => n.type.name === 'front_matter');
		expect(fm.index).toBe(0);
		const chip = q(container, `${BODY} [data-testid="front-matter-chip"]`);
		expect(chip, '札').not.toBeNull();
		expect(chip!.getAttribute('contenteditable')).toBe('false');
		const lines = String(fm.node.attrs.raw).replace(/\r?\n$/, '').split(/\r\n|\r|\n/).length;
		expect(chip!.textContent?.trim()).toBe(`Front matter · ${lines} lines`);
		expect(chip!.textContent).not.toContain('title:');
		expect(text()).toBe(NV);
	});

	it('definition: 面に出ない(hidden か DOM 無し。URL の文字が面の textContent に現れない)。書き出しは byte 等価', async () => {
		const { container } = await mountMd(NV);
		const def = findBlock((n) => n.type.name === 'definition');
		expect(def.node.attrs.url).toBe('https://e.example/r');
		const dom = pm().nodeDOM(def.pos) as HTMLElement | null;
		if (dom) {
			expect(dom.hidden || dom.getAttribute('hidden') !== null || dom.offsetParent === null).toBe(true);
			expect(dom.textContent ?? '').not.toContain('e.example');
		}
		const bodyText = q(container, PM)!.textContent ?? '';
		expect(bodyText).not.toContain('https://e.example/r');
		expect(bodyText).not.toContain("'T'");
		expect(text()).toBe(NV);
	});

	it('判断 11 に依存: 先頭が HTML の注釈で次に --- が来る文書は front matter にせず、生 HTML の塊+区切り線+setext の見出し(札は出ない)', async () => {
		const src = '<!-- template: minutes -->\n---\ntitle: x\n---\n\n# Body\n';
		const { container } = await mountMd(src);
		expect(q(container, `${BODY} [data-testid="front-matter-chip"]`)).toBeNull();
		const names: string[] = [];
		pm().state.doc.forEach((n) => names.push(n.type.name));
		expect(names[0]).toBe('html_block');
		expect(names).toContain('horizontal_rule');
		expect(names).not.toContain('front_matter');
		expect(q(container, `${BODY} .vellis-raw-html`)).not.toBeNull();
		expect(text()).toBe(src);
	});
});

// ---------------------------------------------------------------------------
// 項目 25: 画像
// ---------------------------------------------------------------------------

describe('項目 25・契約17: 画像の DOM の src は rewrite-uri と同じ規則で vellis-asset:(原文には焼き付けない)', () => {
	it('相対パスは toAssetUri(resolveRelative(uri, src))・外部はそのまま・attrs.src と書き出しは原文', async () => {
		const { container } = await mountMd(NV);
		const imgs = qa(container, `${PM} img`);
		const fig = imgs.find((i) => i.getAttribute('alt') === 'fig')!;
		const ext = imgs.find((i) => i.getAttribute('alt') === 'ext')!;
		expect(fig.getAttribute('src')).toBe(toAssetUri(resolveRelative(MD_URI, './images/fig.png')));
		expect(fig.getAttribute('src')!.startsWith('vellis-asset:')).toBe(true);
		expect(ext.getAttribute('src')).toBe('https://img.example/e.png');
		let srcAttr: string | null = null;
		pm().state.doc.descendants((n) => {
			if (n.type.name === 'image' && n.attrs.alt === 'fig') srcAttr = n.attrs.src as string;
			return true;
		});
		expect(srcAttr, 'attrs.src は原文').toBe('./images/fig.png');
		expect(text()).toBe(NV);
		// 今の描画の img の src と同じ値
		const today = await renderedHtmlOf('![fig](./images/fig.png)\n');
		expect(today).toContain(`src="${fig.getAttribute('src')}"`);
	});
});

// ---------------------------------------------------------------------------
// 判断 6・AC-74-36: 脚注と航行
// ---------------------------------------------------------------------------

describe('判断 6 に依存・項目 20: 脚注の参照は参照の順の番号、定義は原文の位置に番号と戻りリンク ↩', () => {
	it('参照 sup.footnote-ref の文字が 1・2(label は m・a)で href が #fn-<label>', async () => {
		const { container } = await mountMd(NV);
		const sups = qa(container, `${PM} sup.footnote-ref`);
		expect(sups).toHaveLength(2);
		expect(sups.map((s) => s.textContent?.trim())).toEqual(['1', '2']);
		expect(sups.map((s) => s.querySelector('a')?.getAttribute('href'))).toEqual(['#fn-m', '#fn-a']);
		expect(sups.every((s) => s.isContentEditable === false || s.closest('[contenteditable="false"]') !== null || s.querySelector('a') !== null)).toBe(true);
	});

	it('定義 section.footnote-definition が原文の位置(mermaid の前)にあり、data-footnote-number と .footnote-backref(↩・contenteditable=false)を持つ', async () => {
		const { container } = await mountMd(NV);
		const defs = qa(container, `${BODY} section.footnote-definition`);
		expect(defs).toHaveLength(2);
		expect(defs.map((d) => d.getAttribute('data-label'))).toEqual(['m', 'a']);
		expect(defs.map((d) => d.getAttribute('data-footnote-number'))).toEqual(['1', '2']);
		for (const d of defs) {
			const back = d.querySelector<HTMLElement>('.footnote-backref');
			expect(back, '戻りリンク').not.toBeNull();
			expect(back!.textContent?.trim()).toBe('↩');
			expect(back!.getAttribute('href')).toBe(`#fnref-${d.getAttribute('data-label')}`);
			expect(back!.getAttribute('contenteditable')).toBe('false');
			expect(d.parentElement?.classList.contains('markdown-body'), '最上位ブロックとして原文の位置に').toBe(true);
		}
		// 原文の位置=mermaid の fence の前・参照の段落の後
		const names: string[] = [];
		pm().state.doc.forEach((n) => names.push(n.type.name + (n.type.name === 'code_block' ? `:${n.attrs.lang}` : '')));
		const first = names.indexOf('footnote_definition');
		expect(first).toBeGreaterThan(names.findIndex((n) => n === 'definition'));
		expect(first).toBeLessThan(names.indexOf('code_block:mermaid'));
		expect(defs[0]!.textContent).toContain('M の脚注。');
		expect(text()).toBe(NV);
	});

	it('参照の順が原文の定義の順と違っても番号は参照の順', async () => {
		const src = 'first[^b] then[^a]\n\n[^a]: A.\n\n[^b]: B.\n';
		const { container } = await mountMd(src);
		expect(qa(container, `${PM} sup.footnote-ref`).map((s) => s.textContent?.trim())).toEqual(['1', '2']);
		const defs = qa(container, `${BODY} section.footnote-definition`);
		expect(defs.map((d) => [d.getAttribute('data-label'), d.getAttribute('data-footnote-number')])).toEqual([
			['a', '2'],
			['b', '1'],
		]);
	});
});

describe('AC-74-36・契約17・(aa): クリックで航行し、文書・選択・dirty は変わらない', () => {
	function scrolledTo(pred: (el: Element) => boolean): boolean {
		return scrolled.some((s) => (s.kind === 'scrollIntoView' ? pred(s.target) : s.target.matches('article.viewer')));
	}

	it('脚注参照のクリック → 定義へ運ぶ(dirty でない・選択は動かない・文書不変)', async () => {
		const { container } = await mountMd(NV);
		const before = pm().state.selection;
		const sup = qa(container, `${PM} sup.footnote-ref`)[0]!;
		scrolled.length = 0;
		await fireEvent.click(sup.querySelector('a') ?? sup);
		await settleLong();
		const def = q(container, `${BODY} section.footnote-definition[data-label="m"]`)!;
		expect(scrolledTo((el) => el === def || def.contains(el) || el.contains(def)), '定義へ運ぶ').toBe(true);
		expect(handle().dirty).toBe(false);
		expect(text()).toBe(NV);
		expect(pm().state.selection.eq(before)).toBe(true);
		expect(openUrlMock).not.toHaveBeenCalled();
	});

	it('戻りリンク ↩ のクリック → 参照へ運ぶ', async () => {
		const { container } = await mountMd(NV);
		const back = q(container, `${BODY} section.footnote-definition[data-label="a"] .footnote-backref`)!;
		scrolled.length = 0;
		await fireEvent.click(back);
		await settleLong();
		const sup = qa(container, `${PM} sup.footnote-ref`).find((s) => s.querySelector('a')?.getAttribute('href') === '#fn-a')!;
		expect(scrolledTo((el) => el === sup || sup.contains(el) || el.contains(sup))).toBe(true);
		expect(handle().dirty).toBe(false);
		expect(text()).toBe(NV);
	});

	it('判断 5: `#target`(生 HTML の id)のリンクのクリック → その要素へ運ぶ。openUrl / open_document は呼ばない', async () => {
		const { container } = await mountMd(NV);
		const a = qa(container, `${PM} a`).find((x) => x.getAttribute('href') === '#target')!;
		expect(a).toBeTruthy();
		const dest = q(container, `${BODY} #target`) ?? q(container, `${BODY} #user-content-target`);
		expect(dest, '生 HTML の id を持つ要素').not.toBeNull();
		scrolled.length = 0;
		await fireEvent.click(a);
		await settleLong();
		expect(scrolledTo((el) => el === dest || dest!.contains(el) || el.contains(dest!))).toBe(true);
		expect(openUrlMock).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalledWith('open_document', expect.anything());
		expect(handle().dirty).toBe(false);
	});

	it('Option + クリックは航行せず(運ばず)カーソルを置く', async () => {
		const { container } = await mountMd(NV);
		const sup = qa(container, `${PM} sup.footnote-ref`)[0]!;
		scrolled.length = 0;
		await fireEvent.click(sup.querySelector('a') ?? sup, { altKey: true });
		await settleLong();
		expect(scrolled.filter((s) => s.kind === 'scrollIntoView')).toHaveLength(0);
		expect(handle().dirty).toBe(false);
		expect(text()).toBe(NV);
	});

	it('参照リンク [r][ref] は定義の URL(外部)へ openUrl', async () => {
		const { container } = await mountMd(NV);
		const a = qa(container, `${PM} a`).find((x) => x.textContent === 'r')!;
		expect(a.getAttribute('href')).toBe('https://e.example/r');
		await fireEvent.click(a);
		await settleLong();
		expect(openUrlMock).toHaveBeenCalledWith('https://e.example/r');
		expect(text()).toBe(NV);
	});
});

// ---------------------------------------------------------------------------
// 契約7・契約17: どれも触らなければ byte 等価(往復)
// ---------------------------------------------------------------------------

describe('契約7: NodeView を持つ文書を開いて、選択を動かしても書き出しは byte 等価', () => {
	it('全ブロックにカーソルを置いて回っても text() === 原文・dirty でない', async () => {
		await mountMd(NV);
		const d = pm().state.doc;
		for (let i = 0; i < d.childCount; i++) {
			const n = d.child(i);
			if (!n.isTextblock && n.type.name !== 'code_block') continue;
			selectPm(blockPos(pm().state.doc, i) + 1);
			await settle();
		}
		await settleLong();
		expect(text()).toBe(NV);
		expect(handle().dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// reviewer の照合(2026-11-17・CHANGES REQUESTED)の追加 — fence から出る・テーマの追従・Ctrl+Z・脚注の付け直し・stopEvent・参照画像
// ---------------------------------------------------------------------------

/** 埋め込みの CodeMirror の contentDOM に本物の keydown を送る。 */
function keyCm(cm: CMView, key: string, init: KeyboardEventInit = {}) {
	const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	cm.contentDOM.dispatchEvent(ev);
	return ev;
}
function tokenClasses(cm: CMView): string[] {
	return [...cm.contentDOM.querySelectorAll<HTMLElement>('.cm-line span[class]')].map((el) => el.className).sort();
}

describe('契約4・項目 23: 埋め込みの CodeMirror から矢印キーで出る(公式の CodeMirror の NodeView の型= maybeEscape / exitCode)', () => {
	const DOC = 'para one\n\n```ts\nline1\nline2\n```\n\npara two\n';

	it('最終行の行末で ArrowDown → 次のブロックの先頭。ArrowRight も同じ', async () => {
		for (const key of ['ArrowDown', 'ArrowRight']) {
			cleanup();
			const { container } = await mountMd(DOC);
			const ts = codeBlock('ts');
			const cm = embeddedCm(container, blockDom(ts.pos));
			cm.focus();
			cm.dispatch({ selection: { anchor: cm.state.doc.length } });
			keyCm(cm, key);
			await settleLong();
			const next = blockPos(pm().state.doc, ts.index + 1);
			expect(pm().state.selection.from, `${key}: 次のブロック(para two)の先頭`).toBe(next + 1);
			expect(pm().state.doc.resolve(pm().state.selection.from).parent.textContent).toBe('para two');
			expect(text()).toBe(DOC);
		}
	});

	it('先頭行の行頭で ArrowUp → 前のブロックの末尾。ArrowLeft も同じ', async () => {
		for (const key of ['ArrowUp', 'ArrowLeft']) {
			cleanup();
			const { container } = await mountMd(DOC);
			const ts = codeBlock('ts');
			const cm = embeddedCm(container, blockDom(ts.pos));
			cm.focus();
			cm.dispatch({ selection: { anchor: 0 } });
			keyCm(cm, key);
			await settleLong();
			const prev = blockPos(pm().state.doc, ts.index - 1);
			expect(pm().state.selection.from, `${key}: 前のブロック(para one)の末尾`).toBe(prev + 1 + 'para one'.length);
			expect(text()).toBe(DOC);
		}
	});

	it('途中の行では矢印キーは CodeMirror の中で動き、PM の選択は fence の中のまま', async () => {
		const { container } = await mountMd(DOC);
		const ts = codeBlock('ts');
		const cm = embeddedCm(container, blockDom(ts.pos));
		cm.focus();
		cm.dispatch({ selection: { anchor: 2 } }); // li|ne1
		keyCm(cm, 'ArrowDown');
		await settleLong();
		expect(cm.state.selection.main.head).toBe('line1\n'.length + 2);
		const sel = pm().state.selection.from;
		expect(sel).toBeGreaterThanOrEqual(ts.pos);
		expect(sel).toBeLessThanOrEqual(ts.pos + ts.node.nodeSize);
	});

	it('文書の最後のブロックが fence のとき Ctrl+Enter → fence の後ろに空の段落ができてカーソルがそこへ(取引 1 つ・undo 1 段)', async () => {
		const LAST = 'intro\n\n```ts\nx\n```\n';
		const { container } = await mountMd(LAST);
		const ts = codeBlock('ts');
		expect(ts.index).toBe(pm().state.doc.childCount - 1);
		const count = pm().state.doc.childCount;
		const depth = undoDepth(pm().state);
		const cm = embeddedCm(container, blockDom(ts.pos));
		cm.focus();
		cm.dispatch({ selection: { anchor: cm.state.doc.length } });
		keyCm(cm, 'Enter', { ctrlKey: true });
		await settleLong();
		const d = pm().state.doc;
		expect(d.childCount).toBe(count + 1);
		const last = d.child(d.childCount - 1);
		expect(last.type.name).toBe('paragraph');
		expect(last.content.size).toBe(0);
		expect(pm().state.selection.from).toBe(blockPos(d, d.childCount - 1) + 1);
		expect(undoDepth(pm().state)).toBe(depth + 1);
		expect(codeBlock('ts').node.textContent, 'fence の中身は変わらない').toBe('x');
		keyPm('z', { ctrlKey: true });
		await settleLong();
		expect(pm().state.doc.childCount).toBe(count);
		expect(text()).toBe(LAST);
	});
});

describe('契約5・AC-74-30 (3) と同じ見方: 面の codeTheme を切り替えると、埋め込みの CodeMirror の配色が文書・選択・PM の履歴を保ったまま替わる', () => {
	it('github-light → github-dark', async () => {
		const d = doc(MD_URI, NV);
		windowState.setDocument(d);
		const r = await renderMarkdown(NV, MD_URI);
		const props = baseProps(d, r.html, r.index, { fileEditor: true, codeTheme: 'github-light' });
		const { container, rerender } = render(Viewer, { props });
		await settleLong();
		await wait(50);
		const ts = codeBlock('ts');
		const pre = blockDom(ts.pos);
		expect(pre.getAttribute('data-code-theme')).toBe('github-light');
		const cm = embeddedCm(container, pre);
		cm.dispatch({ changes: { from: cm.state.doc.length, insert: '\nconst y = 2;' } });
		await settleLong();
		const spot = textSpots(pm().state.doc, pm().state.doc.childCount - 1)[0]!;
		selectPm(spot.pos + 2);
		const depth = undoDepth(pm().state);
		const before = { text: text(), classes: tokenClasses(cm) };
		expect(before.classes.length, 'ts のトークンに色の class が付いている').toBeGreaterThan(0);
		await rerender({ ...props, codeTheme: 'github-dark' });
		await settleLong();
		await wait(100);
		const pre2 = blockDom(codeBlock('ts').pos);
		expect(pre2.getAttribute('data-code-theme')).toBe('github-dark');
		const cm2 = embeddedCm(container, pre2);
		expect(cm2, '埋め込みの EditorView を作り直さない').toBe(cm);
		expect(cm2.state.doc.toString()).toBe('const x: number = 1;\nconst y = 2;');
		expect(text()).toBe(before.text);
		expect(pm().state.selection.from).toBe(spot.pos + 2);
		expect(undoDepth(pm().state)).toBe(depth);
		expect(handle().dirty).toBe(true);
		expect(tokenClasses(cm2), 'トークンの配色の class が替わる').not.toEqual(before.classes);
	});
});

describe('P3(reviewer): Ctrl+Z・脚注の付け直し・stopEvent・参照画像', () => {
	it('N3: 埋め込みにフォーカスがあるときの Ctrl+Z(本物の keydown を CM の DOM に)が PM の undo を呼ぶ', async () => {
		const { container } = await mountMd(NV);
		const ts = codeBlock('ts');
		const cm = embeddedCm(container, blockDom(ts.pos));
		cm.focus();
		cm.dispatch({ changes: { from: cm.state.doc.length, insert: ' // z' } });
		await settleLong();
		expect(text()).toContain('const x: number = 1; // z');
		keyCm(cm, 'z', { ctrlKey: true });
		await settleLong();
		expect(text(), 'PM の undo で戻る').toBe(NV);
		expect(embeddedCm(container, blockDom(codeBlock('ts').pos)).state.doc.toString()).toBe('const x: number = 1;');
		keyCm(embeddedCm(container, blockDom(codeBlock('ts').pos)), 'z', { ctrlKey: true, shiftKey: true });
		await settleLong();
		expect(text(), 'Shift+Ctrl+Z で redo').toContain('const x: number = 1; // z');
	});

	it('N19: 参照を消す・足すと脚注の番号が付け直される(参照と定義の両方)', async () => {
		const { container } = await mountMd(NV);
		// [^m] の参照を消す → a が 1 に
		let mRef: { pos: number; size: number } | null = null;
		pm().state.doc.descendants((n, pos) => {
			if (n.type.name === 'footnote_reference' && n.attrs.label === 'm') mRef = { pos, size: n.nodeSize };
			return !mRef;
		});
		expect(mRef).not.toBeNull();
		pm().dispatch(pm().state.tr.delete(mRef!.pos, mRef!.pos + mRef!.size));
		await settleLong();
		expect(qa(container, `${PM} sup.footnote-ref`).map((s) => s.textContent?.trim())).toEqual(['1']);
		expect(q(container, `${BODY} section.footnote-definition[data-label="a"]`)!.getAttribute('data-footnote-number')).toBe('1');
		expect(q(container, `${BODY} section.footnote-definition[data-label="m"]`)!.getAttribute('data-footnote-number')).not.toBe('1');
		// 末尾の段落に [^m] を足す → a=1・m=2
		const tail = textSpots(pm().state.doc, pm().state.doc.childCount - 1)[0]!;
		const ref = pm().state.schema.nodes.footnote_reference!.create({ label: 'm' });
		pm().dispatch(pm().state.tr.insert(tail.pos + tail.text.length, ref));
		await settleLong();
		expect(qa(container, `${PM} sup.footnote-ref`).map((s) => s.textContent?.trim())).toEqual(['1', '2']);
		expect(q(container, `${BODY} section.footnote-definition[data-label="a"]`)!.getAttribute('data-footnote-number')).toBe('1');
		expect(q(container, `${BODY} section.footnote-definition[data-label="m"]`)!.getAttribute('data-footnote-number')).toBe('2');
		expect(text()).toContain('最後の段落。[^m]');
	});

	it('N21: 埋め込みの中の keydown は PM に二重に流れない(Enter は fence の中の改行・Backspace は fence を壊さない・ブロックの数は不変)', async () => {
		const { container } = await mountMd(NV);
		const ts = codeBlock('ts');
		const count = pm().state.doc.childCount;
		const cm = embeddedCm(container, blockDom(ts.pos));
		cm.focus();
		cm.dispatch({ selection: { anchor: cm.state.doc.length } });
		keyCm(cm, 'Enter');
		await settleLong();
		expect(pm().state.doc.childCount, 'Enter で段落が割れない').toBe(count);
		expect(codeBlock('ts').node.textContent).toBe('const x: number = 1;\n');
		expect(text()).toBe(NV.replace('const x: number = 1;\n', 'const x: number = 1;\n\n'));
		cm.dispatch({ selection: { anchor: 0 } });
		keyCm(cm, 'Backspace');
		await settleLong();
		expect(pm().state.doc.childCount, 'fence の先頭の Backspace で前と結合しない').toBe(count);
		expect(codeBlock('ts').node.type.name).toBe('code_block');
		// PM の keymap の鍵(Tab)も CM が受け、PM 側で二重に扱われない=文書は fence の中の字下げだけ
		keyCm(cm, 'Tab');
		await settleLong();
		expect(pm().state.doc.childCount).toBe(count);
		expect(codeBlock('ts').node.textContent.startsWith('\t') || codeBlock('ts').node.textContent.startsWith('  ')).toBe(true);
	});

	it('N22: 参照画像 ![a][ref] の src は定義から引かれ(vellis-asset:)、書き出しは原文のまま', async () => {
		const src = 'see ![a][ref] here\n\n[ref]: ./images/r.png\n';
		const { container } = await mountMd(src);
		const img = q(container, `${PM} img`)!;
		expect(img).not.toBeNull();
		expect(img.getAttribute('alt')).toBe('a');
		expect(img.getAttribute('src')).toBe(toAssetUri(resolveRelative(MD_URI, './images/r.png')));
		let attrs: Record<string, unknown> | null = null;
		pm().state.doc.descendants((n) => {
			if (n.type.name === 'image') attrs = n.attrs;
			return true;
		});
		expect(attrs!.ref).toBe('ref');
		expect(text()).toBe(src);
		const today = await renderedHtmlOf(src);
		expect(today).toContain(`src="${img.getAttribute('src')}"`);
	});
});

describe('P3(2-4 の穴・2-5 で固定): 最終行の途中からの ↓ と、範囲を選んでいるときの矢印(今の振る舞い=公式の型どおり)', () => {
	const DOC = 'para one\n\n```ts\nline1\nline2\n```\n\npara two\n';

	it('最終行の途中(列 2)で ArrowDown → 列によらず次のブロックへ出る(行の単位の maybeEscape)。ArrowRight は行末でないので CM の中', async () => {
		const { container } = await mountMd(DOC);
		const ts = codeBlock('ts');
		const cm = embeddedCm(container, blockDom(ts.pos));
		cm.focus();
		cm.dispatch({ selection: { anchor: 'line1\n'.length + 2 } }); // li|ne2(最終行の途中)
		keyCm(cm, 'ArrowRight');
		await settleLong();
		expect(cm.state.selection.main.head, 'ArrowRight は 1 文字右(文字の単位では末尾でないので出ない)').toBe('line1\n'.length + 3);
		expect(pm().state.doc.resolve(pm().state.selection.from).parent.type.name).toBe('code_block');
		keyCm(cm, 'ArrowDown');
		await settleLong();
		const next = blockPos(pm().state.doc, ts.index + 1);
		expect(pm().state.selection.from, 'ArrowDown は最終行なら列によらず次のブロックの先頭').toBe(next + 1);
		expect(pm().state.doc.resolve(pm().state.selection.from).parent.textContent).toBe('para two');
	});

	it('先頭行の途中(列 3)で ArrowUp → 前のブロックへ。ArrowLeft は行頭でないので CM の中', async () => {
		const { container } = await mountMd(DOC);
		const ts = codeBlock('ts');
		const cm = embeddedCm(container, blockDom(ts.pos));
		cm.focus();
		cm.dispatch({ selection: { anchor: 3 } });
		keyCm(cm, 'ArrowLeft');
		await settleLong();
		expect(cm.state.selection.main.head).toBe(2);
		expect(pm().state.doc.resolve(pm().state.selection.from).parent.type.name).toBe('code_block');
		keyCm(cm, 'ArrowUp');
		await settleLong();
		const prev = blockPos(pm().state.doc, ts.index - 1);
		expect(pm().state.selection.from).toBe(prev + 1 + 'para one'.length);
	});

	it('範囲を選んでいるとき(最終行の末尾まで)の ArrowDown / ArrowRight は出ない(選択が畳まれて CM の中に残る)', async () => {
		for (const key of ['ArrowDown', 'ArrowRight']) {
			cleanup();
			const { container } = await mountMd(DOC);
			const ts = codeBlock('ts');
			const cm = embeddedCm(container, blockDom(ts.pos));
			cm.focus();
			cm.dispatch({ selection: { anchor: 'line1\n'.length, head: cm.state.doc.length } });
			expect(cm.state.selection.main.empty).toBe(false);
			keyCm(cm, key);
			await settleLong();
			expect(pm().state.doc.resolve(pm().state.selection.from).parent.type.name, `${key}: PM の選択は fence の中のまま`).toBe('code_block');
			expect(cm.state.selection.main.empty, `${key}: CM の選択は畳まれる`).toBe(true);
			expect(text()).toBe(DOC);
		}
	});

	it('範囲を選んでいるとき(先頭から)の ArrowUp / ArrowLeft も出ない', async () => {
		for (const key of ['ArrowUp', 'ArrowLeft']) {
			cleanup();
			const { container } = await mountMd(DOC);
			const ts = codeBlock('ts');
			const cm = embeddedCm(container, blockDom(ts.pos));
			cm.focus();
			cm.dispatch({ selection: { anchor: 4, head: 0 } });
			keyCm(cm, key);
			await settleLong();
			expect(pm().state.doc.resolve(pm().state.selection.from).parent.type.name, `${key}`).toBe('code_block');
			expect(cm.state.selection.main.empty).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// 要件74 第3段 3-3 — code fence の埋め込み(CodeMirror)でも Option + 上下と Command + / が効く(AC-74-56 (7)・3-13)。
// fence の 1 行目で上・最後の行で下は fence の外へ出ない(何もしない)。契約は src/editor/code-keymap.acceptance.test.ts の AC-74-56 の節。
// ---------------------------------------------------------------------------

describe('3-3: code fence の埋め込みの Option + 上下と Command + /(AC-74-56)', () => {
	async function waitForLanguage(view: CMView) {
		for (let i = 0; i < 100; i++) {
			if (view.state.languageDataAt<unknown>('commentTokens', 0).length > 0) return;
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error('埋め込みの言語(commentTokens)が読み込まれない');
	}
	function keyCm(view: CMView, k: string, init: KeyboardEventInit = {}) {
		view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
	}

	it('ts の fence: 2 行目で Option + 上 → fence の中で入れ替わる。1 行目で上・最後の行で下は不変(fence の外へ出ない)', async () => {
		const { container } = await mountMd(NV);
		const ts = codeBlock('ts');
		const cm = embeddedCm(container, blockDom(ts.pos));
		cm.dispatch({ changes: { from: cm.state.doc.length, insert: '\nlet y = 2;' } });
		await settleLong();
		expect(cm.state.doc.toString()).toBe('const x: number = 1;\nlet y = 2;');
		cm.dispatch({ selection: { anchor: cm.state.doc.line(2).from + 1 } });
		keyCm(cm, 'ArrowUp', { altKey: true });
		await settleLong();
		expect(cm.state.doc.toString()).toBe('let y = 2;\nconst x: number = 1;');
		expect(text()).toContain('```ts\nlet y = 2;\nconst x: number = 1;\n```');
		keyCm(cm, 'ArrowUp', { altKey: true });
		await settleLong();
		expect(cm.state.doc.toString(), '1 行目で上は何もしない').toBe('let y = 2;\nconst x: number = 1;');
		cm.dispatch({ selection: { anchor: cm.state.doc.length } });
		keyCm(cm, 'ArrowDown', { altKey: true });
		await settleLong();
		expect(cm.state.doc.toString(), '最後の行で下は何もしない').toBe('let y = 2;\nconst x: number = 1;');
		const names: string[] = [];
		pm().state.doc.forEach((n) => names.push(n.type.name));
		expect(names.filter((n) => n === 'code_block')).toHaveLength(2);
	});

	it('ts の fence: Command + / で // が付き、もう 1 回で byte 等価(fence の外は不変)', async () => {
		const { container } = await mountMd(NV);
		const before = text();
		const ts = codeBlock('ts');
		const cm = embeddedCm(container, blockDom(ts.pos));
		await waitForLanguage(cm);
		cm.dispatch({ selection: { anchor: 3 } });
		keyCm(cm, '/', { ctrlKey: true });
		await settleLong();
		expect(cm.state.doc.toString()).toBe('// const x: number = 1;');
		expect(text()).toBe(before.replace('```ts\nconst x: number = 1;\n```', '```ts\n// const x: number = 1;\n```'));
		keyCm(cm, '/', { ctrlKey: true });
		await settleLong();
		expect(text()).toBe(before);
	});
});
