/**
 * 要件#74 第2〜4段の実機ゲート(2026-11-18・bf6a804 の運転手)で見つかった製品の不具合の受け入れ(面の分)。
 * 契約の出どころ: docs/requirements/req-74.md(契約4=矢印キーで fence の端から出る・契約7 / AC-74-34=mermaid はカーソルを入れると中身・
 * 契約9 / 契約11=入力規則の直後の Command + Z と Backspace は記号の文字に戻す・契約20 / AC-74-58=gap cursor・契約23=raw の行き来・
 * 第4段 4-2 / 事後確認 13=段落の種類の選択)。記録は scratchpad の req74-gate24/(run1.log・run3〜run16)。
 *
 * ## 件と、修正前に赤になる理由
 * - (5) mermaid の図の中にカーソルが入れない: 下の段落の先頭で ↑ しても、図をクリックしても図のまま(`node-views/index.ts` の
 *   mermaidActivePlugin は選択が中に入って初めて CodeMirror に切り替える。図のときは cm が null で selectNode が何もしない・
 *   ↑ は ProseMirror が文字のブロックへの移動をブラウザに任せ、contenteditable=false の図を飛ばす)
 * - (6) raw から戻った後に Command + Z が効かない: toggleRaw で面の DOM を付け直した後に view.focus() が無く、フォーカスが body に残る
 *   (鍵が編集面に届かない)
 * - (7) code fence の入力規則(```ts + 空白)の直後: フォーカスが埋め込みの CodeMirror に入り、その Mod-z(`node-views/index.ts` の
 *   cmState の keymap)が undoMarkdownInputRule を通らず普通の undo になる・Backspace は CodeMirror の中の削除(空なので何もしない)
 * - (8) 文書の先頭の表の前の gap cursor で打った字が 1 つ目のセルに入る("Xa")。実機の原因(f677f65 の後の回し直しで分かった)は、
 *   gap cursor が表の前でなく 1 行目の <tr> の中(最初のセルの前)に立つこと=表のセルが `inline*` なので GapCursor.valid が
 *   table_row の中を有効な gap と見る(末尾の「実機ゲート 12-8」の件)。下の (8) の件は gap を最初から位置 0(文書の深さ)に置くので
 *   その原因は通らず、gap が文書の深さにあるときの打鍵の守り(beforeinput の受け手)を固定する
 * - (9) 文書の末尾の code fence の最後の行で ↓ を押しても出られない(maybeEscape の Selection.near が、後ろに文字の位置が無いので
 *   fence の中に戻る)
 *
 * ## 推奨の解釈(契約で決まっていない所。報告に列挙)
 * - (5) ↑ で入ったときのカーソルは中身のどこでもよい(見るのは選択が fence の中・CodeMirror が出ている・フォーカスが CodeMirror)。
 *   クリックは図の要素への mousedown + click(作りは問わない)
 * - (6) 戻った後の Command + Z は、フォーカスのある要素(document.activeElement)に keydown を送って確かめる(実機と同じく、
 *   フォーカスが body なら鍵は面に届かない)。jsdom では Mod は Ctrl(既存のテストと同じ)
 * - (7) 戻る文字は他の規則と同じく打った記号そのもの(`- ` の規則の直後の Backspace が `- abc` に戻るのと同じ=```` ```ts ````+空白)
 * - (8) ブラウザの打鍵を「keydown → beforeinput(insertText)→ どちらも止められなければ DOM の 1 つ目のセルの先頭に字が入り、
 *   ProseMirror の DOM の観測が読む」と模して確かめる(keydown / beforeinput / handleTextInput のどこで塞いでも通る)。キャレットを
 *   セルへ寄せるのは仮定の模し(実機の原因は gap が <tr> の中に立つこと=末尾の「実機ゲート 12-8」の件で判定する)
 * - (9) ↓ の行き先は fence の後ろの gap cursor か、fence の外の位置(fence の中に戻らない)。打つと fence の後ろに段落
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { AllSelection, NodeSelection, TextSelection } from 'prosemirror-state';
import { GapCursor } from 'prosemirror-gapcursor';
import type { EditorView as PMView } from 'prosemirror-view';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { EditorView as CMView } from '@codemirror/view';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import { blockPos, textSpots } from '../editor/markdown.testkit';
import { MARKDOWN_KEYMAP } from '../editor/markdown-keymap';
import { runFormatCommand } from '../editor/commands';
import * as eventsModule from '$lib/events';
import { redo, undo, undoDepth } from 'prosemirror-history';
import { parseMarkdownDocument } from '../editor/from-mdast';

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

const MD_URI = 'file:///Users/a/notes/gate.md';

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false, fileEditor: true };
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
async function mountMd(content: string) {
	const d = doc(MD_URI, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, MD_URI);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index) });
	await settleLong();
	return result;
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
function keyOn(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
	const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(ev);
	return ev;
}
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
function blockDom(pos: number): HTMLElement {
	const dom = pm().nodeDOM(pos) as HTMLElement | null;
	if (!dom) throw new Error(`nodeDOM(${pos}) が無い`);
	return dom;
}
function cmIn(dom: HTMLElement): CMView | null {
	const el = dom.querySelector<HTMLElement>('.cm-editor') ?? (dom.matches('.cm-editor') ? dom : null);
	return el ? CMView.findFromDOM(el) : null;
}
/** 選択の先頭が、最上位ブロック `index` の中か。 */
function selectionInside(index: number): boolean {
	const d = pm().state.doc;
	const from = blockPos(d, index);
	const to = from + d.child(index).nodeSize;
	const { from: a, to: b } = pm().state.selection;
	return a > from && b < to;
}
/** 入力規則と同じ打鍵(handleTextInput が偽なら insertText)。 */
function typeChars(s: string) {
	const v = pm();
	for (const ch of Array.from(s)) {
		const { from, to } = v.state.selection;
		const deflt = () => v.state.tr.insertText(ch, from, to);
		const handled = v.someProp('handleTextInput', (f) => f(v, from, to, ch, deflt));
		if (!handled) v.dispatch(deflt());
	}
}

beforeEach(() => {
	windowState.clearDocument();
});
afterEach(() => {
	cleanup();
	windowState.clearDocument();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (5) mermaid: カーソルを入れると中身(AC-74-34・契約7)
// ---------------------------------------------------------------------------

describe('実機ゲート (5) AC-74-34: mermaid の図の中へ ↑ / クリックで入れる(中身=埋め込みの CodeMirror)', () => {
	const SOURCE = 'graph TD\n  A --> B';
	const DOC = `intro\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n\nbelow paragraph\n`;

	it('前提: 開いた直後は図(CodeMirror なし)', async () => {
		await mountMd(DOC);
		const mm = codeBlock('mermaid');
		expect(blockDom(mm.pos).querySelector('.vellis-mermaid')).not.toBeNull();
		expect(cmIn(blockDom(mm.pos))).toBeNull();
	});

	it('下の段落の先頭で ↑ → 選択が mermaid の fence の中に入り、CodeMirror(中身)が出てフォーカスを持つ。文書は変わらない', async () => {
		await mountMd(DOC);
		const below = textSpots(pm().state.doc, 2)[0]!;
		selectPm(below.pos);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		const mm = codeBlock('mermaid');
		expect(selectionInside(mm.index), `選択 ${pm().state.selection.from} が fence の中`).toBe(true);
		const cm = cmIn(blockDom(mm.pos));
		expect(cm, '中身(CodeMirror)が出る').not.toBeNull();
		expect(cm!.state.doc.toString()).toBe(SOURCE);
		expect(cm!.dom.contains(document.activeElement), 'フォーカスは CodeMirror').toBe(true);
		expect(text()).toBe(DOC);
	});

	it('図をクリック → 選択が fence の中に入り、CodeMirror(中身)が出てフォーカスを持つ。文書は変わらない', async () => {
		await mountMd(DOC);
		const mm = codeBlock('mermaid');
		const fig = blockDom(mm.pos).querySelector<HTMLElement>('.vellis-mermaid')!;
		expect(fig).not.toBeNull();
		await fireEvent.mouseDown(fig, { button: 0 });
		await fireEvent.mouseUp(fig, { button: 0 });
		await fireEvent.click(fig, { button: 0 });
		await settleLong();
		const now = codeBlock('mermaid');
		expect(selectionInside(now.index), `選択 ${pm().state.selection.from} が fence の中`).toBe(true);
		const cm = cmIn(blockDom(now.pos));
		expect(cm, '中身(CodeMirror)が出る').not.toBeNull();
		expect(cm!.dom.contains(document.activeElement), 'フォーカスは CodeMirror').toBe(true);
		expect(text()).toBe(DOC);
	});
});

// ---------------------------------------------------------------------------
// (6) raw から戻った後のフォーカスと Command + Z(契約23)
// ---------------------------------------------------------------------------

describe('実機ゲート (6) 契約23: raw から戻ったら編集面にフォーカスがあり、Command + Z で raw での編集が戻る', () => {
	const SRC = 'alpha\n\nbeta\n';

	async function editInRawAndReturn(container: HTMLElement) {
		handle().toggleRaw();
		await settleLong();
		const root = container.querySelector<HTMLElement>('[data-testid="raw-source-editor"]');
		expect(root, 'raw の面').not.toBeNull();
		const cm = CMView.findFromDOM(root!);
		expect(cm, 'raw の CodeMirror').toBeTruthy();
		cm!.focus();
		cm!.dispatch({ changes: { from: SRC.indexOf('beta') + 4, insert: ' RAW' } });
		await settle();
		expect(handle().text()).toBe('alpha\n\nbeta RAW\n');
		handle().toggleRaw();
		await settleLong();
		expect(handle().raw).toBe(false);
	}

	it('戻った直後: フォーカスは ProseMirror の面(document.activeElement が view.dom)', async () => {
		const { container } = await mountMd(SRC);
		pm().focus();
		await editInRawAndReturn(container);
		expect(document.activeElement, `フォーカス: ${document.activeElement?.tagName}`).toBe(pm().dom);
	});

	it('戻った後に Command + Z(フォーカスのある要素へ)→ raw での編集が戻る', async () => {
		const { container } = await mountMd(SRC);
		pm().focus();
		await editInRawAndReturn(container);
		expect(text()).toBe('alpha\n\nbeta RAW\n');
		keyOn(document.activeElement ?? document.body, 'z', { ctrlKey: true });
		await settleLong();
		expect(text(), 'undo で raw での編集が戻る').toBe(SRC);
	});
});

// ---------------------------------------------------------------------------
// (7) code fence の入力規則の直後の Command + Z / Backspace(契約9・契約11)
// ---------------------------------------------------------------------------

describe('実機ゲート (7) 契約9・11: ```ts + 空白の直後、埋め込みの CodeMirror の中で Command + Z / Backspace → 打った記号の文字に戻る', () => {
	const SRC = 'intro\n\nabc\n';

	async function fenceByRule(): Promise<CMView> {
		const v = pm();
		const p = textSpots(v.state.doc, 1)[0]!;
		// 空の段落を作ってそこで打つ(段落の中身が記号だけのときに規則が効く)
		v.dispatch(v.state.tr.insert(p.pos - 1 + p.text.length + 2, v.state.schema.nodes.paragraph!.create()));
		selectPm(p.pos + p.text.length + 2);
		v.focus();
		typeChars('```ts ');
		await settleLong();
		const ts = codeBlock('ts');
		expect(ts.node.textContent, '前提: 規則で code fence(lang ts)').toBe('');
		const cm = cmIn(blockDom(ts.pos));
		expect(cm, '前提: 埋め込みの CodeMirror').not.toBeNull();
		cm!.focus();
		return cm!;
	}

	it('前提: 規則の前の書き出し', async () => {
		await mountMd(SRC);
		await fenceByRule();
		expect(text()).toBe('intro\n\nabc\n\n```ts\n```\n');
	});

	it('CodeMirror の中で Command + Z → ```` ```ts ```` の文字の段落に戻る(code fence でない)', async () => {
		await mountMd(SRC);
		const cm = await fenceByRule();
		keyOn(cm.contentDOM, 'z', { ctrlKey: true });
		await settleLong();
		const last = pm().state.doc.lastChild!;
		expect(last.type.name, '記号の文字の段落').toBe('paragraph');
		expect(last.textContent).toBe('```ts ');
	});

	it('CodeMirror の中で Backspace → ```` ```ts ```` の文字の段落に戻る(code fence でない)', async () => {
		await mountMd(SRC);
		const cm = await fenceByRule();
		keyOn(cm.contentDOM, 'Backspace');
		await settleLong();
		const last = pm().state.doc.lastChild!;
		expect(last.type.name, '記号の文字の段落').toBe('paragraph');
		expect(last.textContent).toBe('```ts ');
	});
});

// ---------------------------------------------------------------------------
// (8) 文書の先頭の表の前の gap cursor で打つ(契約20・AC-74-58)
// ---------------------------------------------------------------------------

/**
 * WebKit の 1 字の打鍵を模す(DOM の API と ProseMirror の DOM の観測だけを使う): keydown → beforeinput(insertText)→ どちらも
 * 止められなければ、WebKit はキャレットを字を置ける所(`textNode` の `offset`)へ寄せて selectionchange を出し、そこへ字を入れる
 * (gap の DOM の位置=表の前には字を置けない、と仮定した模し。実機の "Xa" の原因は、↑ で gap cursor が 1 行目の <tr> の中に
 * 立ったこと=末尾の「実機ゲート 12-8」の件。ここは gap が文書の深さにあるときの打鍵の守りを見る)。ProseMirror の DOM の観測が
 * それを読む。keydown / beforeinput / 選択の読み / handleTextInput のどこで塞いでも通る。
 */
async function webkitTypes(ch: string, textNode: Text, offset: number) {
	const v = pm();
	const down = keyOn(v.dom, ch);
	if (down.defaultPrevented) return;
	const before = new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true });
	v.dom.dispatchEvent(before);
	if (before.defaultPrevented) return;
	document.getSelection()?.collapse(textNode, offset);
	document.dispatchEvent(new Event('selectionchange'));
	await settle();
	textNode.insertData(offset, ch);
	document.getSelection()?.collapse(textNode, offset + ch.length);
	(v as unknown as { domObserver: { flush(): void } }).domObserver.flush();
	await settle();
}

describe('実機ゲート (8) AC-74-58: 文書の先頭の表の前の gap cursor で字を打つと、表の前に段落ができる', () => {
	const SRC = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';

	function firstCellText(): Text {
		const cell = pm().dom.querySelector('table th, table td')!;
		const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
		const t = walker.nextNode() as Text | null;
		if (!t) throw new Error('1 つ目のセルの文字が無い');
		return t;
	}

	it('gap cursor(位置 0)で X を打つ → 先頭に段落 X ができ、表は変わらない(1 つ目のセルに入らない)', async () => {
		await mountMd(SRC);
		const v = pm();
		expect(v.state.doc.firstChild!.type.name).toBe('table');
		v.focus();
		// 実機はセルをクリックしてから ↑(フォーカスの直後ではない=ProseMirror の「フォーカス直後の選択の戻し」の保護の外)
		await new Promise((r) => setTimeout(r, 250));
		v.dispatch(v.state.tr.setSelection(new GapCursor(v.state.doc.resolve(0))));
		expect(v.state.selection instanceof GapCursor, '前提: gap cursor').toBe(true);
		// gap の DOM のキャレットは表の前(面の根の 0)
		document.getSelection()?.collapse(v.dom, 0);
		document.dispatchEvent(new Event('selectionchange'));
		await settleLong();
		expect(pm().state.selection instanceof GapCursor, '前提: 表の前の DOM のキャレットは gap cursor のまま').toBe(true);
		await webkitTypes('X', firstCellText(), 0);
		await settleLong();
		expect(text()).toBe(`X\n\n${SRC}`);
		expect(pm().state.doc.firstChild!.type.name).toBe('paragraph');
		expect(pm().state.doc.child(1).type.name).toBe('table');
	});

	it('対照: 生 HTML の塊の間の gap cursor で打つと段落ができる(今も緑)', async () => {
		const html = '<div>\na\n</div>\n\n<div>\nb\n</div>\n';
		await mountMd(html);
		const v = pm();
		const at = blockPos(v.state.doc, 1);
		v.dispatch(v.state.tr.setSelection(new GapCursor(v.state.doc.resolve(at))));
		typeChars('Y');
		await settleLong();
		expect(text()).toBe('<div>\na\n</div>\n\nY\n\n<div>\nb\n</div>\n');
	});
});

// ---------------------------------------------------------------------------
// (9) 文書の末尾の code fence から ↓ で出る(契約4・契約20)
// ---------------------------------------------------------------------------

describe('実機ゲート (9) 契約4・20: 文書の末尾の code fence の最後の行で ↓ → fence の外へ出て、打つと fence の後ろに段落', () => {
	const SRC = 'intro\n\n```ts\nconst end = 1;\n```\n';

	it('最後の行の行末で ↓ → 選択が fence の外(gap cursor など)。打つと fence の後ろに段落 Z(fence は変わらない)', async () => {
		await mountMd(SRC);
		const ts = codeBlock('ts');
		expect(ts.index, '前提: 末尾のブロック').toBe(pm().state.doc.childCount - 1);
		const cm = cmIn(blockDom(ts.pos))!;
		cm.focus();
		cm.dispatch({ selection: { anchor: cm.state.doc.length } });
		keyOn(cm.contentDOM, 'ArrowDown');
		await settleLong();
		const sel = pm().state.selection;
		const fenceFrom = blockPos(pm().state.doc, ts.index);
		const fenceTo = fenceFrom + pm().state.doc.child(ts.index).nodeSize;
		expect(sel.from >= fenceTo || sel.to <= fenceFrom, `選択 ${sel.from}..${sel.to} が fence(${fenceFrom}..${fenceTo})の外`).toBe(true);
		typeChars('Z');
		await settleLong();
		expect(text()).toBe(`${SRC}\nZ\n`);
		expect(codeBlock('ts').node.textContent).toBe('const end = 1;');
	});

	it('対照: fence の後ろに段落があれば ↓ でその先頭へ(今も緑)', async () => {
		const src = 'intro\n\n```ts\nconst end = 1;\n```\n\ntail\n';
		await mountMd(src);
		const ts = codeBlock('ts');
		const cm = cmIn(blockDom(ts.pos))!;
		cm.focus();
		cm.dispatch({ selection: { anchor: cm.state.doc.length } });
		keyOn(cm.contentDOM, 'ArrowDown');
		await settleLong();
		expect(pm().state.selection.from).toBe(blockPos(pm().state.doc, ts.index + 1) + 1);
	});
});

// ---------------------------------------------------------------------------
// (4) 段落の種類の select(第4段 4-2・事後確認 13)
// 「select の mousedown で既定の動作を止めない」側は、既存の FormatToolbar.wiring.test.ts の
// 「select で Heading 2 を選ぶと見出し 2」の件が `down.defaultPrevented === true` を固定しているので、ここでは書かない
// (要件側で既存の件を改めるかの判断=報告)。ここは事後確認 13 の意図=選ぶ前の編集面の選択が保たれる、を本物のクリックの流れで見る。
// ---------------------------------------------------------------------------

describe('実機ゲート (4) 事後確認 13: 段落の種類の select を本物のクリックの流れで選んでも、選ぶ前の編集面の選択に当たる', () => {
	const MD = '# Plan\n\nIntro paragraph with **bold** word.\n\n## Second\n';

	it('mousedown が止められなければ select にフォーカスが移る(ブラウザの既定)→ Heading 2 を選ぶ → 選ぶ前のカーソルの段落が見出し 2・選択の位置はそのまま', async () => {
		const { container } = await mountMd(MD);
		if (!container.querySelector('[data-testid="format-toolbar"]')) {
			await fireEvent.click(container.querySelector<HTMLElement>('[data-testid="format-toolbar-toggle"]')!);
			await settleLong();
		}
		const select = container.querySelector<HTMLSelectElement>('[data-testid="format-block-type"]')!;
		expect(select, '段落の種類の select').not.toBeNull();
		const v = pm();
		const intro = textSpots(v.state.doc, 1)[0]!;
		selectPm(intro.pos + 2);
		v.focus();
		const before = v.state.selection.from;
		const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
		select.dispatchEvent(down);
		if (!down.defaultPrevented) select.focus();
		await fireEvent.change(select, { target: { value: 'format-heading-2' } });
		await settleLong();
		expect(text()).toBe(MD.replace('Intro paragraph', '## Intro paragraph'));
		expect(pm().state.selection.from, '選択の位置はそのまま').toBe(before);
	});
});

// ---------------------------------------------------------------------------
// (1) Command + B / Command + I(契約8 の例外・事後確認 (14)=2026-11-18)
// WKWebView はこの 2 つの鍵をメニューのアクセラレータに届けずに持っていく(実機: keydown(meta+b)は来るが、beforeinput もメニューの
// Bold も走らない)。編集面の keydown で受けて既定の動作を止め、メニューと同じ命令(runFormatCommand に format-bold / format-italic)へ
// 流す。MARKDOWN_KEYMAP には入れない。修正前は面が keydown を受けないので、既定の動作は止まらず文書も変わらない(赤)。
// 推奨の解釈: Command は metaKey(macOS の鍵。jsdom の Mod=Ctrl とは別に、実機の打鍵どおり metaKey で出す)。ほかの Format の鍵は対象外。
// ---------------------------------------------------------------------------

describe('実機ゲート (1) 契約8 の例外: 編集面で Command + B / Command + I → 既定の動作を止め、選択に太字 / 斜体(取引ちょうど 1 つ)', () => {
	const MD = 'Intro paragraph here.\n\nafter\n';

	for (const [key, mark, wrapped] of [
		['b', 'strong', '**Intro**'],
		['i', 'em', '_Intro_'],
	] as const) {
		it(`Command + ${key.toUpperCase()}: keydown の既定の動作が止まり、選んだ語(Intro)に ${mark} が付く・undo の段は 1 つ増える`, async () => {
			await mountMd(MD);
			const v = pm();
			const intro = textSpots(v.state.doc, 0)[0]!;
			selectPm(intro.pos, intro.pos + 'Intro'.length);
			v.focus();
			const depth = undoDepth(v.state);
			const ev = keyOn(v.dom, key, { metaKey: true });
			await settleLong();
			expect(ev.defaultPrevented, '既定の動作(WKWebView が持っていく)を止める').toBe(true);
			const first = pm().state.doc.child(0).child(0);
			expect(first.text).toBe('Intro');
			expect(first.marks.map((m) => m.type.name), '1 回だけ当たる(2 回だと打ち消し合う)').toEqual([mark]);
			expect(undoDepth(pm().state) - depth, '取引ちょうど 1 つ').toBe(1);
			const out = text();
			expect(out.startsWith(wrapped) || out.startsWith(mark === 'em' ? '*Intro*' : '__Intro__'), out).toBe(true);
		});
	}

	it('MARKDOWN_KEYMAP には Command + B / I が無いまま(経路は面の keydown → runFormatCommand)', () => {
		for (const k of ['Mod-b', 'Mod-i', 'Meta-b', 'Meta-i', 'Cmd-b', 'Cmd-i', 'Mod-B', 'Mod-I']) {
			expect(Object.prototype.hasOwnProperty.call(MARKDOWN_KEYMAP, k), k).toBe(false);
		}
	});

	it('対照: 修飾なしの b は打鍵のまま(面が既定の動作を止めない)', async () => {
		await mountMd(MD);
		const v = pm();
		selectPm(textSpots(v.state.doc, 0)[0]!.pos);
		v.focus();
		const ev = keyOn(v.dom, 'b');
		await settleLong();
		expect(ev.defaultPrevented).toBe(false);
		expect(text()).toBe(MD);
	});
});

// ---------------------------------------------------------------------------
// 照合の P3 の締め(reviewer-o の観察・f677f65 の後): 門の対・フォーカス・↓ の対・図の上の右クリック / Control + クリック・gap の変換中
// ---------------------------------------------------------------------------

describe('締め (1) の門: Command + B / I の外の組み合わせと変換中は、面の keydown で止めず書式も付かない', () => {
	const MD = 'Intro paragraph here.\n\nafter\n';

	for (const [label, key, init] of [
		['Command + Shift + B', 'b', { metaKey: true, shiftKey: true }],
		['Command + Option + I', 'i', { metaKey: true, altKey: true }],
		['Control + B(Command なし)', 'b', { ctrlKey: true }],
		['変換中(isComposing)の Command + B', 'b', { metaKey: true, isComposing: true }],
	] as const) {
		it(`${label}: defaultPrevented は false・選んだ語に mark が付かない・文書は変わらない`, async () => {
			await mountMd(MD);
			const v = pm();
			const intro = textSpots(v.state.doc, 0)[0]!;
			selectPm(intro.pos, intro.pos + 'Intro'.length);
			v.focus();
			const ev = keyOn(v.dom, key, init);
			await settleLong();
			expect(ev.defaultPrevented, `${label} は面が止めない`).toBe(false);
			expect(pm().state.doc.child(0).child(0).marks, '書式は付かない').toHaveLength(0);
			expect(text()).toBe(MD);
		});
	}
});

describe('締め (7) の続き: fence の入力規則を CodeMirror の中で取り消した後、フォーカスは面にあり、続けて打った字は段落に入る', () => {
	const SRC = 'intro\n\nabc\n';

	async function fenceByRule(): Promise<CMView> {
		const v = pm();
		const p = textSpots(v.state.doc, 1)[0]!;
		v.dispatch(v.state.tr.insert(p.pos - 1 + p.text.length + 2, v.state.schema.nodes.paragraph!.create()));
		selectPm(p.pos + p.text.length + 2);
		v.focus();
		typeChars('```ts ');
		await settleLong();
		const ts = codeBlock('ts');
		const cm = cmIn(blockDom(ts.pos));
		expect(cm, '前提: 埋め込みの CodeMirror').not.toBeNull();
		cm!.focus();
		return cm!;
	}

	for (const [label, key, init] of [
		['Command + Z', 'z', { ctrlKey: true }],
		['Backspace', 'Backspace', {}],
	] as const) {
		it(`${label} で戻した後: document.activeElement は ProseMirror の面・続けて x を打つと段落が \`\`\`ts x\``, async () => {
			await mountMd(SRC);
			const cm = await fenceByRule();
			keyOn(cm.contentDOM, key, init);
			await settleLong();
			expect(document.activeElement, `フォーカス: ${document.activeElement?.className}`).toBe(pm().dom);
			typeChars('x');
			await settleLong();
			const last = pm().state.doc.lastChild!;
			expect(last.type.name).toBe('paragraph');
			expect(last.textContent).toBe('```ts x');
		});
	}
});

describe('締め (5) の対: mermaid の上の段落の末尾で ↓ → fence の中に入る・図の上の右クリック / Control + クリックでは図のまま', () => {
	const SOURCE = 'graph TD\n  A --> B';
	const DOC = `intro\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n\nbelow paragraph\n`;

	it('上の段落(intro)の末尾で ↓ → 選択が mermaid の fence の中に入り、CodeMirror(中身)が出る。文書は変わらない', async () => {
		await mountMd(DOC);
		const intro = textSpots(pm().state.doc, 0)[0]!;
		selectPm(intro.pos + intro.text.length);
		pm().focus();
		keyOn(pm().dom, 'ArrowDown');
		await settleLong();
		const mm = codeBlock('mermaid');
		expect(selectionInside(mm.index), `選択 ${pm().state.selection.from} が fence の中`).toBe(true);
		expect(cmIn(blockDom(mm.pos)), '中身(CodeMirror)が出る').not.toBeNull();
		expect(text()).toBe(DOC);
	});

	for (const [label, init] of [
		['右クリック(button 2)', { button: 2 }],
		['Control + クリック(button 0 + ctrlKey=macOS の右クリック)', { button: 0, ctrlKey: true }],
	] as const) {
		it(`図の上の${label} → 図のまま(CodeMirror に替わらない・選択は fence の中に入らない)`, async () => {
			await mountMd(DOC);
			const below = textSpots(pm().state.doc, 2)[0]!;
			selectPm(below.pos);
			const mm = codeBlock('mermaid');
			const fig = blockDom(mm.pos).querySelector<HTMLElement>('.vellis-mermaid')!;
			expect(fig).not.toBeNull();
			await fireEvent.mouseDown(fig, init);
			await fireEvent.mouseUp(fig, init);
			if (init.button === 0) await fireEvent.click(fig, init);
			await settleLong();
			const now = codeBlock('mermaid');
			expect(selectionInside(now.index), `選択 ${pm().state.selection.from} は fence の外のまま`).toBe(false);
			expect(cmIn(blockDom(now.pos)), '図のまま').toBeNull();
			expect(blockDom(now.pos).querySelector('.vellis-mermaid')).not.toBeNull();
			expect(text()).toBe(DOC);
		});
	}
});

describe('締め (8) の門: gap cursor で変換中(isComposing の beforeinput insertText / view.composing)は、gap の beforeinput が手を出さない', () => {
	const SRC = '<div>\na\n</div>\n\n<div>\nb\n</div>\n';

	function gapBetween() {
		const v = pm();
		v.dispatch(v.state.tr.setSelection(new GapCursor(v.state.doc.resolve(blockPos(v.state.doc, 1)))));
		expect(pm().state.selection instanceof GapCursor, '前提: gap cursor').toBe(true);
	}

	it('前提(対照): 変換中でない beforeinput insertText は gap で止められ、段落ができる', async () => {
		await mountMd(SRC);
		pm().focus();
		gapBetween();
		const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: 'Y', bubbles: true, cancelable: true });
		pm().dom.dispatchEvent(ev);
		await settleLong();
		expect(ev.defaultPrevented).toBe(true);
		expect(text()).toBe('<div>\na\n</div>\n\nY\n\n<div>\nb\n</div>\n');
	});

	it('isComposing の beforeinput insertText → preventDefault しない・文書は変わらない', async () => {
		await mountMd(SRC);
		pm().focus();
		gapBetween();
		const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: 'あ', isComposing: true, bubbles: true, cancelable: true });
		expect(ev.isComposing, '前提: jsdom が isComposing を持つ').toBe(true);
		pm().dom.dispatchEvent(ev);
		await settleLong();
		expect(ev.defaultPrevented).toBe(false);
		expect(text()).toBe(SRC);
	});

	it('view.composing の間(compositionstart の後)の beforeinput insertText → preventDefault しない・その beforeinput で文書は変わらない', async () => {
		await mountMd(SRC);
		pm().focus();
		gapBetween();
		pm().dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		expect(pm().composing, '前提: view.composing').toBe(true);
		const before = text();
		const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: 'あ', bubbles: true, cancelable: true });
		pm().dom.dispatchEvent(ev);
		await settle();
		expect(ev.defaultPrevented).toBe(false);
		expect(text()).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// 実機ゲート 12-8 の回し直し(f677f65 の後・2026-11-18): 先頭の表の前の gap cursor が表の行の中に出る
// 実機の観察: 表で始まる文書の見出しの行のセル "a" の後ろ → ↑ 1 回 → gap cursor の DOM が表の前でなく 1 行目の <tr> の中・最初の
// <th> の前に出る(DOM の選択も tr)。打った X は 1 つ目のセルに入り "Xa"・beforeinput は出ない。
// 原因の見込み: Vellis の表のセルは `inline*`(文字のブロック)なので、prosemirror-gapcursor の GapCursor.valid が table_row の中の
// セルの間(既定の型=セル=文字のブロック)を有効な gap と見る(prosemirror-tables の既定のセルは block+ なので起きない)。
// 期待: GapCursor は表(table / table_row / セル)の内側に作られない。表の 1 行目で ↑ / 最後の行で ↓ → 表の外(文書の深さ)の gap。
// 打つと表の前(後ろ)に段落。修正前は gap が行の中(深さ 2)に立つので赤。
// 前の「(8) gap cursor(位置 0)で X を打つ」の件は、gap を最初から位置 0(文書の深さ)に置き、WebKit がキャレットをセルへ寄せると
// 仮定して模していた。実機の原因はこの件(gap が行の中に出る)で、その仮定とは違った。前の件は「gap が文書の深さにあるときの打鍵の
// 守り(beforeinput)」の固定として残す(書き換えない)。
// ---------------------------------------------------------------------------

describe('実機ゲート 12-8: 表の前 / 後ろの gap cursor は文書の深さに立ち、表の行やセルの間には立たない', () => {
	const LEADING = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';
	const TRAILING = 'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';

	/** 表(最上位ブロック `index`)の内側の位置(表の開きの直後〜閉じの直前)か。 */
	function insideTable(index: number, pos: number): boolean {
		const d = pm().state.doc;
		const from = blockPos(d, index);
		return pos > from && pos < from + d.child(index).nodeSize;
	}
	function cellText(label: string): { pos: number } {
		let found = -1;
		pm().state.doc.descendants((n, p) => {
			if (found >= 0) return false;
			if (n.isText && n.text === label) found = p;
			return found < 0;
		});
		if (found < 0) throw new Error(`セル ${label} が無い`);
		return { pos: found };
	}
	function expectGapOutsideTable(tableIndex: number, at: number) {
		const sel = pm().state.selection;
		expect(sel instanceof GapCursor, `選択 ${sel.constructor.name} ${sel.from} が gap cursor`).toBe(true);
		expect(sel.$head.depth, `gap の深さ(親=${sel.$head.parent.type.name})は文書の深さ`).toBe(0);
		expect(insideTable(tableIndex, sel.head), `gap ${sel.head} が表の内側でない`).toBe(false);
		expect(sel.head).toBe(at);
		const gap = pm().dom.querySelector('.ProseMirror-gapcursor');
		expect(gap, 'gap cursor の DOM').not.toBeNull();
		expect(gap!.parentElement, `gap cursor の DOM の親(${gap!.parentElement?.tagName})は面の根(<tr> の中でない)`).toBe(pm().dom);
	}

	it('先頭の表の見出しの行のセル "a" の後ろで ↑ → gap は表の前(位置 0・文書の深さ・DOM は面の根の直下)', async () => {
		await mountMd(LEADING);
		const a = cellText('a');
		selectPm(a.pos + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		expectGapOutsideTable(0, 0);
	});

	it('先頭の表で ↑ して X を打つ → 表の前に段落 X ができ、表は変わらない("Xa" にならない)', async () => {
		await mountMd(LEADING);
		const a = cellText('a');
		selectPm(a.pos + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		typeChars('X');
		await settleLong();
		expect(text()).toBe(`X\n\n${LEADING}`);
	});

	it('先頭の表の 2 つ目の見出しのセル "b" で ↑ → 同じく表の前(位置 0)', async () => {
		await mountMd(LEADING);
		const b = cellText('b');
		selectPm(b.pos + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		expectGapOutsideTable(0, 0);
	});

	it('先頭の表の 1 つ目のセルの行頭で ← → 表の前(位置 0)', async () => {
		await mountMd(LEADING);
		const a = cellText('a');
		selectPm(a.pos);
		pm().focus();
		keyOn(pm().dom, 'ArrowLeft');
		await settleLong();
		expectGapOutsideTable(0, 0);
	});

	it('末尾の表の最後の行のセル "1" で ↓ → gap は表の後ろ(文書の末尾・文書の深さ)。打つと表の後ろに段落 Z', async () => {
		await mountMd(TRAILING);
		const one = cellText('1');
		selectPm(one.pos + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowDown');
		await settleLong();
		expectGapOutsideTable(1, pm().state.doc.content.size);
		typeChars('Z');
		await settleLong();
		expect(text()).toBe(`${TRAILING}\nZ\n`);
	});

	it('末尾の表の最後のセル "2" の行末で → → 表の後ろ(文書の末尾)', async () => {
		await mountMd(TRAILING);
		const two = cellText('2');
		selectPm(two.pos + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowRight');
		await settleLong();
		expectGapOutsideTable(1, pm().state.doc.content.size);
	});

	it('どの経路でも: 表の内側のどの位置でクリック(handleClick)/ DOM の選択の読み(createSelectionBetween)をしても、表の内側に gap cursor は立たない', async () => {
		await mountMd(LEADING);
		const v = pm();
		const d = v.state.doc;
		const from = blockPos(d, 0);
		const to = from + d.child(0).nodeSize;
		const bad: string[] = [];
		for (let pos = from + 1; pos < to; pos++) {
			const $pos = v.state.doc.resolve(pos);
			// クリック(prosemirror-gapcursor の handleClick など)
			v.someProp('handleClick', (f) => f(v, pos, new MouseEvent('mousedown', { button: 0 })));
			const s1 = pm().state.selection;
			if (s1 instanceof GapCursor && insideTable(0, s1.head)) bad.push(`click ${pos} → gap ${s1.head}(${s1.$head.parent.type.name})`);
			// DOM の選択の読み
			const made = v.someProp('createSelectionBetween', (f) => f(v, $pos, $pos));
			if (made instanceof GapCursor && insideTable(0, made.head)) bad.push(`createSelectionBetween ${pos} → gap ${made.head}(${made.$head.parent.type.name})`);
			selectPm(cellText('a').pos);
		}
		expect(bad, '表の内側の gap').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 実機ゲート 12-8 の門(2147dc0 の照合の P3・reviewer-o): 表の端の行の ↑ / ↓ の受け手(tableEdges)が横取りしない所と、表の隣の形
// 期待(今の実装で緑の固定): 端でない行・修飾つきでは横取りしない(表の中に留まる)。表の隣が表 / 段落 / リストの項目でも行き先が決まる。
// Tab のセルの移動は今までどおり。tableEdges の行の門・修飾の門を外す変異で 1・2 が赤になることを確かめた。
// ---------------------------------------------------------------------------

describe('実機ゲート 12-8 の門: 表の端の行の ↑ / ↓ の受け手は、端でない行と修飾つきでは横取りしない・表の隣の形の行き先・Tab', () => {
	const THREE = 'intro\n\n| h1 | h2 |\n| - | - |\n| r1 | x1 |\n| r2 | x2 |\n| r3 | x3 |\n\nafter\n';

	function posOfText(label: string): number {
		let found = -1;
		pm().state.doc.descendants((n, p) => {
			if (found >= 0) return false;
			if (n.isText && n.text === label) found = p;
			return found < 0;
		});
		if (found < 0) throw new Error(`'${label}' が無い`);
		return found;
	}
	/** 選択の位置を含む最上位ブロックの番号と、そのブロックの種類。 */
	function topBlockOf(pos: number): { index: number; name: string } {
		const $pos = pm().state.doc.resolve(pos);
		const index = $pos.index(0);
		return { index, name: pm().state.doc.child(index).type.name };
	}
	/** 文字の `label` の後ろ(+offset)にカーソルを置き、鍵を押す。 */
	async function pressAt(label: string, offset: number, key: string, init: KeyboardEventInit = {}) {
		selectPm(posOfText(label) + offset);
		pm().focus();
		const ev = keyOn(pm().dom, key, init);
		await settleLong();
		return ev;
	}
	function expectInsideTable(tableIndex: number, label: string) {
		const sel = pm().state.selection;
		expect(sel instanceof GapCursor, `${label}: gap cursor にならない`).toBe(false);
		expect(topBlockOf(sel.from), `${label}: 選択 ${sel.from} は表の中`).toEqual({ index: tableIndex, name: 'table' });
		expect(topBlockOf(sel.to).index).toBe(tableIndex);
	}

	for (const [label, cell, key] of [
		['中の行(r2)で ↑', 'r2', 'ArrowUp'],
		['中の行(r2)で ↓', 'r2', 'ArrowDown'],
		['1 つ目の本文の行(r1)で ↑(見出しの行へ)', 'r1', 'ArrowUp'],
		['見出しの行(h2)で ↓', 'h2', 'ArrowDown'],
		['最後の行(x3)で ↑', 'x3', 'ArrowUp'],
	] as const) {
		it(`(1) 3 行以上の表の${label} → 横取りしない(keydown を止めない)・選択は表の中`, async () => {
			await mountMd(THREE);
			const ev = await pressAt(cell, 1, key);
			expect(ev.defaultPrevented, '端の行の受け手は手を出さない').toBe(false);
			expectInsideTable(1, label);
			expect(text()).toBe(THREE);
		});
	}

	for (const [label, cell, key] of [
		['1 行目(h1)で Shift + ↑', 'h1', 'ArrowUp'],
		['最後の行(r3)で Shift + ↓', 'r3', 'ArrowDown'],
	] as const) {
		it(`(2) ${label} → 横取りしない(gap cursor にならない・表の外へ飛ばない)`, async () => {
			await mountMd(THREE);
			const ev = await pressAt(cell, 1, key, { shiftKey: true });
			expect(ev.defaultPrevented, '修飾つきは手を出さない').toBe(false);
			expectInsideTable(1, label);
			expect(text()).toBe(THREE);
		});
	}

	it('(3) 表と表が並ぶ: 1 つ目の最後の行で ↓ / 2 つ目の 1 行目で ↑ → どちらも間の gap(深さ 0)', async () => {
		const TWO = '| a | b |\n| - | - |\n| 1 | 2 |\n\n| c | d |\n| - | - |\n| 3 | 4 |\n';
		await mountMd(TWO);
		expect(pm().state.doc.childCount, '前提: 表が 2 つ').toBe(2);
		const between = blockPos(pm().state.doc, 1);
		for (const [cell, key] of [
			['2', 'ArrowDown'],
			['c', 'ArrowUp'],
		] as const) {
			await pressAt(cell, 1, key);
			const sel = pm().state.selection;
			expect(sel instanceof GapCursor, `${cell} で ${key}: gap cursor`).toBe(true);
			expect(sel.$head.depth, `${cell} で ${key}: 深さ 0`).toBe(0);
			expect(sel.head, `${cell} で ${key}: 2 つの表の間`).toBe(between);
		}
	});

	it('(3) 表の後ろに段落: 最後の行で ↓ → 段落の先頭 / 段落の後ろに表: 1 行目で ↑ → 段落の末尾', async () => {
		await mountMd(THREE);
		await pressAt('x3', 1, 'ArrowDown');
		const after = posOfText('after');
		expect(pm().state.selection instanceof TextSelection).toBe(true);
		expect(pm().state.selection.from, '段落 after の先頭').toBe(after);
		await pressAt('h2', 1, 'ArrowUp');
		const intro = posOfText('intro');
		expect(pm().state.selection instanceof TextSelection).toBe(true);
		expect(pm().state.selection.from, '段落 intro の末尾').toBe(intro + 'intro'.length);
	});

	it('(3) リストの項目の中の表: 最後の行で ↓ → 次の項目の段落の先頭', async () => {
		const LIST = '- item one\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n- next item\n';
		await mountMd(LIST);
		let hasTable = false;
		pm().state.doc.descendants((n) => {
			if (n.type.name === 'table') hasTable = true;
			return true;
		});
		expect(hasTable, '前提: 項目の中に表').toBe(true);
		await pressAt('2', 1, 'ArrowDown');
		const sel = pm().state.selection;
		expect(sel instanceof TextSelection, `選択 ${sel.constructor.name}`).toBe(true);
		expect(sel.from, '次の項目の段落の先頭').toBe(posOfText('next item'));
		expect(text()).toBe(LIST);
	});

	it('(4) Tab / Shift + Tab でセルの移動は今までどおり(h1 → h2 → r1 / 戻る)', async () => {
		await mountMd(THREE);
		selectPm(posOfText('h1') + 1);
		pm().focus();
		keyOn(pm().dom, 'Tab');
		await settleLong();
		const at = () => pm().state.doc.resolve(pm().state.selection.from).parent.textContent;
		expect(at(), 'Tab で次のセル').toBe('h2');
		keyOn(pm().dom, 'Tab');
		await settleLong();
		expect(at(), 'Tab で次の行の最初のセル').toBe('r1');
		keyOn(pm().dom, 'Tab', { shiftKey: true });
		await settleLong();
		expect(at(), 'Shift + Tab で前のセル').toBe('h2');
		expect(text()).toBe(THREE);
	});
});

// ---------------------------------------------------------------------------
// 実機ゲートの回し直し(2147dc0 の後・2026-11-18)の新しい不具合 2 件
// A. front matter が消える(回帰): 表で始まる本文の前に front matter がある文書で、見出しのセル "a" の後ろ → ↑(表の前の gap)→
//    もう一度 ↑ → W と打つと、文書が [段落 W, 表, After.] になり front matter が無くなる(2 回目の ↑ で front_matter が
//    NodeSelection=`markdown-schema.ts` の selectable: true になり、打った字で置き換わる見込み)。
//    期待(推奨の解釈・契約7・AC-74-6・AC-74-35=front matter は札・中は打てない・直すのは raw・事後確認 (19)):
//    編集面のどの操作(打鍵・Backspace・Delete・貼り付け・切り取り・選択して打つ・全選択して打つ)でも front_matter のノードは
//    消えず置き換わらず、書き出しの front matter は byte 等価。front matter の直後の gap / 札が選ばれた状態で打った字は、
//    front matter の後ろの段落に入る。全選択(Command + A)して打つ: front matter は残り、ほかが打った字の段落になる(推奨)。
// B. 表の前の gap で日本語を打つと変換の字が 1 つ目のセルに入る("にほんa")。表の前に空の段落はできる(prosemirror-gapcursor の
//    beforeinput が insertCompositionText で段落を作る)が、WebKit はそれより前に、DOM の選択の隣のセルで変換を始めている見込み。
//    期待: 表の前の段落に変換の字が入り、セルは "a" のまま。
// ---------------------------------------------------------------------------

/** 打鍵 1 字(keydown → beforeinput insertText → 止められなければ handleTextInput / insertText=ProseMirror が DOM の変更を読むのと同じ)。 */
async function typeLikeBrowser(ch: string) {
	const v = pm();
	const down = keyOn(v.dom, ch);
	if (!down.defaultPrevented) {
		const before = new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true });
		v.dom.dispatchEvent(before);
		if (!before.defaultPrevented) typeChars(ch);
	}
	await settleLong();
}

describe('実機ゲート A(契約7・AC-74-6・AC-74-35・事後確認 (19)): 編集面のどの操作でも front matter は消えず、書き出しは byte 等価', () => {
	const FM = '---\ntitle: x\n---\n';
	const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter.\n';
	const SRC = `${FM}\n${TABLE}`;
	const PARA = `${FM}\nAfter.\n`;

	function names(): string[] {
		const out: string[] = [];
		pm().state.doc.forEach((n) => out.push(n.type.name));
		return out;
	}
	function expectFrontMatterKept(label: string) {
		const first = pm().state.doc.firstChild!;
		expect(first.type.name, `${label}: 先頭は front matter のまま(${names().join(', ')})`).toBe('front_matter');
		expect(text().startsWith(FM), `${label}: front matter は byte 等価: ${JSON.stringify(text().slice(0, 40))}`).toBe(true);
	}
	function cellA(): number {
		let found = -1;
		pm().state.doc.descendants((n, p) => {
			if (found >= 0) return false;
			if (n.isText && n.text === 'a') found = p;
			return found < 0;
		});
		return found;
	}
	function selectFrontMatter() {
		const v = pm();
		v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, 0)));
		v.focus();
	}

	it('実機の手順: 見出しのセル "a" の後ろ → ↑ → ↑ → W → front matter は残り、W は front matter の後ろ(表の前)の段落に入る', async () => {
		await mountMd(SRC);
		selectPm(cellA() + 1);
		pm().focus();
		// 本物の鍵と同じく keyCode 38 を付ける(ProseMirror 自身の縦の移動=selectVertically は keyCode を見る)
		keyOn(pm().dom, 'ArrowUp', { keyCode: 38 });
		await settleLong();
		expect(pm().state.selection instanceof GapCursor, '前提: 1 回目の ↑ で表の前の gap').toBe(true);
		keyOn(pm().dom, 'ArrowUp', { keyCode: 38 });
		await settleLong();
		await typeLikeBrowser('W');
		expectFrontMatterKept('↑ ↑ W');
		expect(names()).toEqual(['front_matter', 'paragraph', 'table', 'paragraph']);
		expect(pm().state.doc.child(1).textContent).toBe('W');
		expect(text().endsWith(`\n\nW\n\n${TABLE}`), JSON.stringify(text())).toBe(true);
	});

	it('front matter の札が選ばれた状態(NodeSelection)で打つ → front matter は残り、字はその後ろの段落に入る', async () => {
		await mountMd(PARA);
		selectFrontMatter();
		await typeLikeBrowser('W');
		expectFrontMatterKept('札で打つ');
		expect(text()).toContain('W');
		expect(text().endsWith('After.\n'), 'After. はそのまま').toBe(true);
	});

	for (const key of ['Backspace', 'Delete']) {
		it(`front matter の札が選ばれた状態で ${key} → front matter は残る(文書は変わらない)`, async () => {
			await mountMd(PARA);
			selectFrontMatter();
			keyOn(pm().dom, key);
			await settleLong();
			expectFrontMatterKept(key);
			expect(text()).toBe(PARA);
		});
	}

	it('front matter の直後の段落の先頭で Backspace を 2 回 → front matter は残る(書き出しは byte 等価)', async () => {
		await mountMd(PARA);
		selectPm(textSpots(pm().state.doc, 1)[0]!.pos);
		pm().focus();
		keyOn(pm().dom, 'Backspace');
		await settleLong();
		keyOn(pm().dom, 'Backspace');
		await settleLong();
		expectFrontMatterKept('Backspace 2 回');
		expect(text()).toBe(PARA);
	});

	it('front matter の直後の gap(表の前)で Backspace → front matter は残る', async () => {
		await mountMd(SRC);
		selectPm(cellA() + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp', { keyCode: 38 });
		await settleLong();
		expect(pm().state.selection instanceof GapCursor, '前提: gap').toBe(true);
		keyOn(pm().dom, 'Backspace', { keyCode: 8 });
		await settleLong();
		expectFrontMatterKept('gap で Backspace');
		expect(text()).toBe(SRC);
	});

	it('front matter の札が選ばれた状態で貼り付け(text/plain)→ front matter は残り、貼った字は後ろの段落に入る', async () => {
		await mountMd(PARA);
		selectFrontMatter();
		const data = new Map([['text/plain', 'P']]);
		await fireEvent.paste(pm().dom, { clipboardData: { getData: (t: string) => data.get(t) ?? '', setData: () => {}, clearData: () => {}, types: ['text/plain'] } });
		await settleLong();
		expectFrontMatterKept('貼り付け');
		expect(text()).toContain('P');
	});

	it('front matter の札が選ばれた状態で切り取り → front matter は残る', async () => {
		await mountMd(PARA);
		selectFrontMatter();
		const data = new Map<string, string>();
		await fireEvent.cut(pm().dom, { clipboardData: { getData: (t: string) => data.get(t) ?? '', setData: (t: string, val: string) => void data.set(t, val), clearData: () => data.clear(), types: [] } });
		await settleLong();
		expectFrontMatterKept('切り取り');
		expect(text()).toBe(PARA);
	});

	it('front matter をまたぐ範囲(文書の先頭〜After. の途中)を選んで打つ → front matter は残り、打った字が入る', async () => {
		await mountMd(PARA);
		const v = pm();
		const after = textSpots(v.state.doc, 1)[0]!;
		v.dispatch(v.state.tr.setSelection(TextSelection.between(v.state.doc.resolve(0), v.state.doc.resolve(after.pos + 3))));
		v.focus();
		await typeLikeBrowser('Q');
		expectFrontMatterKept('またいで打つ');
		expect(text()).toContain('Q');
	});

	it('全選択(Command + A)して打つ → front matter は残り、ほかは打った字の段落になる(推奨の解釈)', async () => {
		await mountMd(SRC);
		const v = pm();
		v.dispatch(v.state.tr.setSelection(new AllSelection(v.state.doc)));
		v.focus();
		await typeLikeBrowser('Q');
		expectFrontMatterKept('全選択して打つ');
		expect(names()).toEqual(['front_matter', 'paragraph']);
		expect(pm().state.doc.child(1).textContent).toBe('Q');
	});
});

describe('実機ゲート B(AC-74-58・契約10): 表の前の gap で日本語を打つと、変換の字は表の前の段落に入り、セルは "a" のまま', () => {
	const SRC = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';

	/**
	 * WebKit の変換の模し(仮定): keydown(keyCode 229・key 'Process')→ compositionstart。WebKit は compositionstart の受け手が
	 * 終わった時点の DOM の選択の所で変換を始める。そこが面の段落(表の外の文字のブロック)の中ならそこへ、そうでなければ
	 * (面の根の直下=gap の位置・表の中)字を置ける最寄りの所=1 つ目のセルの先頭へ寄せる(実機の "にほんa")。その後
	 * beforeinput insertCompositionText(isComposing)が来て(ここで手を出す受け手もある)、変換の字が DOM に入り、
	 * compositionend → ProseMirror の DOM の観測が読む。
	 */
	async function composeAtGap(composed: string) {
		const v = pm();
		v.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
		await settle();
		v.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		// 変換を始める所
		const sel = document.getSelection()!;
		let node: Node | null = sel.anchorNode;
		let offset = sel.anchorOffset;
		const el = node ? (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)) : null;
		const inParagraph = !!el && el !== v.dom && v.dom.contains(el) && !el.closest('table') && !!el.closest('p');
		if (!inParagraph) {
			const cell = v.dom.querySelector('table th, table td')!;
			const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
			node = walker.nextNode();
			offset = 0;
		}
		v.dom.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: composed, isComposing: true, bubbles: true, cancelable: true }));
		await settle();
		// 変換の字を DOM に入れる(段落の中の要素なら文字のノードを作る)
		let textNode: Text;
		if (node && node.nodeType === Node.TEXT_NODE && node.isConnected) {
			textNode = node as Text;
			textNode.insertData(offset, composed);
		} else {
			const host = node && node.isConnected ? (node as Element) : (v.dom.querySelector('p') as Element);
			textNode = document.createTextNode(composed);
			host.insertBefore(textNode, host.childNodes[offset] ?? null);
			offset = 0;
		}
		sel.collapse(textNode, offset + composed.length);
		v.dom.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: composed, isComposing: true, bubbles: true }));
		(v as unknown as { domObserver: { flush(): void } }).domObserver.flush();
		v.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: composed }));
		await new Promise((r) => setTimeout(r, 80));
		(v as unknown as { domObserver: { flush(): void } }).domObserver.flush();
		await settleLong();
	}

	it('見出しのセル "a" の後ろ → ↑(表の前の gap)→ 変換で「にほん」を確定 → 表の前の段落が「にほん」・1 つ目のセルは "a" のまま', async () => {
		await mountMd(SRC);
		let a = -1;
		pm().state.doc.descendants((n, p) => {
			if (a >= 0) return false;
			if (n.isText && n.text === 'a') a = p;
			return a < 0;
		});
		selectPm(a + 1);
		pm().focus();
		await new Promise((r) => setTimeout(r, 250));
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		expect(pm().state.selection instanceof GapCursor, '前提: 表の前の gap').toBe(true);
		expect(pm().state.selection.$head.depth).toBe(0);
		await composeAtGap('にほん');
		const d = pm().state.doc;
		expect(d.firstChild!.type.name, '先頭は段落').toBe('paragraph');
		expect(d.firstChild!.textContent, '変換の字は表の前の段落に').toBe('にほん');
		expect(d.child(1).type.name).toBe('table');
		expect(d.child(1).child(0).child(0).textContent, '1 つ目のセルは a のまま').toBe('a');
		expect(text()).toBe(`にほん\n\n${SRC}`);
	});
});

// ---------------------------------------------------------------------------
// 0596359(front matter の守り・gap の変換)の照合の差し戻し(reviewer-o・01aa889・事後確認 (20))
// P2-1 文書の途中に front matter が入らない(貼り付けた切片に front_matter が入っていても)
// P2-2 raw の経路(raw の読み直し・外部の変更・undo / redo)は守らない=front matter を消す / 直す / 足すのは raw でできる
// P3 札の Backspace / Delete は履歴を増やさない・字なしで終わった変換は作った空の段落を消す・変換の始まりの 2 つの入口と DOM の選択
// ---------------------------------------------------------------------------

const FM_SRC = '---\ntitle: x\n---\n';

function topNames(): string[] {
	const out: string[] = [];
	pm().state.doc.forEach((n) => out.push(n.type.name));
	return out;
}
/** 文書の先頭(index 0)以外に front_matter が無く、書き出しを読み直しても先頭以外に front matter が無い。 */
function expectNoFrontMatterInMiddle(label: string) {
	topNames().forEach((name, i) => {
		if (i > 0) expect(name, `${label}: ブロック ${i} が front_matter(${topNames().join(', ')})`).not.toBe('front_matter');
	});
	const back = parseMarkdownDocument(text()).doc;
	back.forEach((n, _o, i) => {
		if (i > 0) expect(n.type.name, `${label}: 読み直したブロック ${i} が front_matter: ${JSON.stringify(text())}`).not.toBe('front_matter');
	});
}
/** ProseMirror の貼り付けの後半(doPaste)と同じ: handlePaste に渡し、受けなければ replaceSelection(切片を解析した後の形)。 */
async function pasteSliceLikePm(slice: Slice) {
	const v = pm();
	const ev = new Event('paste') as ClipboardEvent;
	if (!v.someProp('handlePaste', (f) => f(v, ev, slice))) {
		v.dispatch(v.state.tr.replaceSelection(slice).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
	}
	await settleLong();
}
function cursorAtEnd() {
	const v = pm();
	const last = textSpots(v.state.doc, v.state.doc.childCount - 1).at(-1)!;
	selectPm(last.pos + last.text.length);
	v.focus();
}

describe('差し戻し P2-1: 文書の途中に front matter が入らない(切片に front_matter が入っていても)', () => {
	const SRC = `${FM_SRC}\nbody text\n\nAfter.\n`;

	it('(a) 全選択して写し(文書全体の切片)、文書の末尾に貼る → 先頭以外に front_matter が無い・先頭の front matter は byte のまま', async () => {
		await mountMd(SRC);
		const v = pm();
		const slice = v.state.doc.slice(0, v.state.doc.content.size);
		expect(slice.content.firstChild!.type.name, '前提: 切片に front_matter').toBe('front_matter');
		cursorAtEnd();
		await pasteSliceLikePm(slice);
		expectNoFrontMatterInMiddle('全選択を末尾に貼る');
		expect(text().startsWith(FM_SRC)).toBe(true);
		expect(text()).toContain('body text');
	});

	it('(a) 同じ操作を本物の写し / 貼り付け(copy → paste の HTML)で → 先頭以外に front_matter が無い', async () => {
		await mountMd(SRC);
		const v = pm();
		v.dispatch(v.state.tr.setSelection(new AllSelection(v.state.doc)));
		v.focus();
		const data = new Map<string, string>();
		const api = { getData: (t: string) => data.get(t) ?? '', setData: (t: string, val: string) => void data.set(t, val), clearData: () => data.clear(), types: [] as string[] };
		await fireEvent.copy(v.dom, { clipboardData: api });
		await settle();
		cursorAtEnd();
		await fireEvent.paste(pm().dom, { clipboardData: { ...api, types: [...data.keys()] } });
		await settleLong();
		expectNoFrontMatterInMiddle('copy → paste');
		expect(text().startsWith(FM_SRC)).toBe(true);
	});

	it('(b) 札(front matter のノード)を写して文書の途中(段落の間)に貼る → 先頭以外に front_matter が無い', async () => {
		await mountMd(SRC);
		const v = pm();
		const slice = v.state.doc.slice(0, v.state.doc.firstChild!.nodeSize);
		expect(slice.content.firstChild!.type.name, '前提: 札の切片').toBe('front_matter');
		const body = textSpots(v.state.doc, 1)[0]!;
		selectPm(body.pos + body.text.length);
		v.focus();
		await pasteSliceLikePm(slice);
		expectNoFrontMatterInMiddle('札を途中に貼る');
		expect(text().startsWith(FM_SRC)).toBe(true);
		expect(text().endsWith('After.\n')).toBe(true);
	});

	it('(c) front matter の無い文書に、front_matter を含む切片を貼る → front_matter はどこにも入らない(先頭にも途中にも)', async () => {
		await mountMd(`${FM_SRC}\nfrom here\n`);
		const slice = new Slice(Fragment.from(pm().state.doc.firstChild!), 0, 0);
		cleanup();
		windowState.clearDocument();
		const PLAIN = 'intro\n\nAfter.\n';
		await mountMd(PLAIN);
		const v = pm();
		const intro = textSpots(v.state.doc, 0)[0]!;
		selectPm(intro.pos + intro.text.length);
		v.focus();
		await pasteSliceLikePm(slice);
		expect(topNames(), 'front_matter は入らない').not.toContain('front_matter');
		expect(parseMarkdownDocument(text()).doc.firstChild!.type.name, `読み直しても front matter は無い: ${JSON.stringify(text())}`).not.toBe('front_matter');
		expectNoFrontMatterInMiddle('無い文書に貼る');
		expect(text().startsWith('intro')).toBe(true);
	});
});

describe('差し戻し P2-2: raw の経路(raw の読み直し・外部の変更・undo / redo)は守らない', () => {
	const SRC = `${FM_SRC}\nbody text\n`;

	async function rawEdit(container: HTMLElement, edit: (cm: CMView) => void) {
		handle().toggleRaw();
		await settleLong();
		const root = container.querySelector<HTMLElement>('[data-testid="raw-source-editor"]')!;
		const cm = CMView.findFromDOM(root)!;
		edit(cm);
		await settle();
		handle().toggleRaw();
		await settleLong();
		expect(handle().raw).toBe(false);
	}

	it('(a) raw で front matter を消して戻る → 消えたまま(書き出しも)', async () => {
		const { container } = await mountMd(SRC);
		await rawEdit(container, (cm) => cm.dispatch({ changes: { from: 0, to: FM_SRC.length + 1, insert: '' } }));
		expect(topNames()[0]).not.toBe('front_matter');
		expect(text()).toBe('body text\n');
	});

	it('(b) (a) の後に Command + Z → front matter が戻る・redo → また消える', async () => {
		const { container } = await mountMd(SRC);
		await rawEdit(container, (cm) => cm.dispatch({ changes: { from: 0, to: FM_SRC.length + 1, insert: '' } }));
		expect(text()).toBe('body text\n');
		const v = pm();
		expect(undo(v.state, v.dispatch), 'undo が当たる').toBe(true);
		await settleLong();
		expect(text(), 'undo で戻る').toBe(SRC);
		expect(topNames()[0]).toBe('front_matter');
		expect(redo(pm().state, pm().dispatch), 'redo が当たる').toBe(true);
		await settleLong();
		expect(text(), 'redo でまた消える').toBe('body text\n');
		expect(topNames()[0]).not.toBe('front_matter');
	});

	it('(c) 外部の変更で front matter が消える(触っていない文書)→ 消えたまま・dirty でない', async () => {
		await mountMd(SRC);
		const incoming = 'body text\n';
		windowState.applyFileChanged(doc(MD_URI, incoming));
		await settleLong();
		expect(text()).toBe(incoming);
		expect(topNames()[0]).not.toBe('front_matter');
		expect(handle().dirty).toBe(false);
	});

	it('(d) raw で front matter を直す(title: y)・front matter の無い文書に raw で足す → そのまま', async () => {
		const { container } = await mountMd(SRC);
		await rawEdit(container, (cm) => cm.dispatch({ changes: { from: FM_SRC.indexOf('x'), to: FM_SRC.indexOf('x') + 1, insert: 'y' } }));
		expect(text()).toBe(SRC.replace('title: x', 'title: y'));
		expect(topNames()[0]).toBe('front_matter');
		cleanup();
		windowState.clearDocument();
		const plain = await mountMd('body text\n');
		await rawEdit(plain.container, (cm) => cm.dispatch({ changes: { from: 0, insert: FM_SRC + '\n' } }));
		expect(text()).toBe(SRC);
		expect(topNames()[0]).toBe('front_matter');
	});
});

describe('差し戻し P3: 札の Backspace / Delete は履歴を増やさない・字なしの変換は空の段落を残さない・変換の始まりの 2 つの入口と DOM の選択', () => {
	const PARA = `${FM_SRC}\nAfter.\n`;
	const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';

	for (const key of ['Backspace', 'Delete']) {
		it(`(a) 札を選んで ${key} → 文書は不変・undo の段が増えない(undoDepth 不変)・dirty でない`, async () => {
			await mountMd(PARA);
			const v = pm();
			v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, 0)));
			v.focus();
			const depth = undoDepth(v.state);
			keyOn(v.dom, key);
			await settleLong();
			expect(text()).toBe(PARA);
			expect(undoDepth(pm().state), 'undo の段は増えない').toBe(depth);
			expect(handle().dirty).toBe(false);
		});
	}

	/** 先頭の表の見出しのセル "a" の後ろ → ↑ で表の前の gap(フォーカスは面)。 */
	async function gapBeforeTable() {
		await mountMd(TABLE);
		let a = -1;
		pm().state.doc.descendants((n, p) => {
			if (a >= 0) return false;
			if (n.isText && n.text === 'a') a = p;
			return a < 0;
		});
		selectPm(a + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		expect(pm().state.selection instanceof GapCursor, '前提: 表の前の gap').toBe(true);
	}
	function domSelectionInFirstParagraph(): boolean {
		const sel = document.getSelection();
		const p = pm().dom.firstElementChild;
		return !!sel?.anchorNode && !!p && p.tagName === 'P' && p.contains(sel.anchorNode);
	}

	it('(b) gap で変換を始めて字なしで終わる(compositionend の data が空)→ 作った空の段落は消え、文書は元どおり・dirty でない', async () => {
		await gapBeforeTable();
		const v = pm();
		v.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
		v.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		v.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		await new Promise((r) => setTimeout(r, 80));
		await settleLong();
		expect(topNames()[0], '空の段落は残らない').toBe('table');
		expect(text()).toBe(TABLE);
		expect(handle().dirty).toBe(false);
	});

	it('(c) 変換の始まりが keydown 229 だけ(compositionstart の前)→ 段落ができ、DOM の選択がその中', async () => {
		await gapBeforeTable();
		pm().dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
		await settle();
		expect(topNames()[0], 'gap に段落').toBe('paragraph');
		expect(domSelectionInFirstParagraph(), 'DOM の選択は段落の中').toBe(true);
	});

	it('(c) 変換の始まりが compositionstart だけ(keydown 229 なし)→ 段落ができ、DOM の選択がその中', async () => {
		await gapBeforeTable();
		pm().dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		expect(topNames()[0], 'gap に段落').toBe('paragraph');
		expect(domSelectionInFirstParagraph(), 'DOM の選択は段落の中').toBe(true);
	});

	it('(d) ProseMirror 自身が DOM の選択を移さないとき(jsdom では面にフォーカスが無いときに起きる)でも、DOM の選択は作った段落の中へ移る', async () => {
		await gapBeforeTable();
		const v = pm();
		// 模し: DOM の選択は gap の位置(面の根の offset 0)に残り、ProseMirror の selectionToDOM は働かない(フォーカスを外す)
		(document.activeElement as HTMLElement | null)?.blur();
		document.getSelection()?.collapse(v.dom, 0);
		expect(v.hasFocus(), '前提: 面にフォーカスが無い').toBe(false);
		v.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
		await settle();
		expect(topNames()[0], 'gap に段落').toBe('paragraph');
		expect(domSelectionInFirstParagraph(), `DOM の選択(${document.getSelection()?.anchorNode?.nodeName})は段落の中`).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// def81de の再照合の差し戻し(reviewer-o・df99873): front matter の守りの Backspace が入力規則の取り消し(契約11)より先に食う
// P2: front matter の直後の 1 つ目のブロックの先頭で `# ` を打って見出しにした直後の Backspace → `# abc` の段落に戻る
//     (修正前は守りの handleKeyDown が「front matter の直後の文字のブロックの先頭の Backspace」として食い、何も起きない=赤)。
//     `> `・`- `・`1. ` の規則も同じ形で固定する(包む規則はカーソルが入れ子になるので今も緑の見込み)。
// P3 の固定: 字なしの変換の後の undo・front matter の直後の空の段落の Backspace・入れ子の front_matter の切片・字のある変換の終わり。
// ---------------------------------------------------------------------------

describe('再照合 P2(契約11): front matter の直後のブロックで入力規則の直後の Backspace → 打った記号の文字に戻る', () => {
	const FM = '---\ntitle: x\n---\n';
	const SRC = `${FM}\nabc\n`;

	for (const [rule, made] of [
		['# ', 'heading'],
		['> ', 'blockquote'],
		['- ', 'bullet_list'],
		['1. ', 'ordered_list'],
	] as const) {
		it(`\`${rule}\` を abc の先頭で打つ → ${made} → Backspace → \`${rule}abc\` の段落に戻る・front matter は残る`, async () => {
			await mountMd(SRC);
			const abc = textSpots(pm().state.doc, 1)[0]!;
			selectPm(abc.pos);
			pm().focus();
			typeChars(rule);
			await settleLong();
			expect(pm().state.doc.child(1).type.name, `前提: 規則で ${made}`).toBe(made);
			keyOn(pm().dom, 'Backspace', { keyCode: 8 });
			await settleLong();
			const block = pm().state.doc.child(1);
			expect(block.type.name, '記号の文字の段落に戻る').toBe('paragraph');
			expect(block.textContent).toBe(`${rule}abc`);
			expect(pm().state.doc.firstChild!.type.name).toBe('front_matter');
			expect(text().startsWith(FM)).toBe(true);
		});
	}
});

describe('再照合 P3 の固定: 字なしの変換の後の undo・front matter の直後の空の段落の Backspace・入れ子の front_matter・字のある変換の終わり', () => {
	const FM = '---\ntitle: x\n---\n';
	const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';

	async function gapBeforeTable() {
		await mountMd(TABLE);
		let a = -1;
		pm().state.doc.descendants((n, p) => {
			if (a >= 0) return false;
			if (n.isText && n.text === 'a') a = p;
			return a < 0;
		});
		selectPm(a + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		expect(pm().state.selection instanceof GapCursor, '前提: 表の前の gap').toBe(true);
	}
	function frontMattersAt(): number[] {
		const at: number[] = [];
		pm().state.doc.descendants((n, p) => {
			if (n.type.name === 'front_matter') at.push(p);
			return true;
		});
		return at;
	}

	it('(a) 字なしの変換の後に Command + Z → 空の段落は出ない(消す取引は履歴に積まない)・文書は元どおり', async () => {
		await gapBeforeTable();
		const v = pm();
		v.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
		v.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		// 変換は人が字を選ぶ間続く: 履歴の段のまとめ(500 ms)を越えてから字なしで終わる(作る取引と消す取引が別の段になる)
		await new Promise((r) => setTimeout(r, 600));
		v.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		await new Promise((r) => setTimeout(r, 80));
		await settleLong();
		expect(text(), '前提: 字なしの変換の後は元どおり').toBe(TABLE);
		// ProseMirror は Safari(jsdom の navigator.vendor も Apple)で compositionend から 500 ms 以内の keydown を 1 回捨てるので、間を空けて押す
		await new Promise((r) => setTimeout(r, 600));
		keyOn(pm().dom, 'z', { ctrlKey: true });
		await settleLong();
		expect(topNames()[0], 'undo で空の段落が出ない').toBe('table');
		expect(text()).toBe(TABLE);
	});

	it('(b) front matter の直後の空の段落の先頭で Backspace → 既定どおり段落が消えて札が選ばれる・front matter は残る', async () => {
		await mountMd(`${FM}\nabc\n`);
		const v = pm();
		const abc = textSpots(v.state.doc, 1)[0]!;
		v.dispatch(v.state.tr.delete(abc.pos, abc.pos + 3));
		expect(pm().state.doc.child(1).content.size, '前提: 空の段落').toBe(0);
		selectPm(abc.pos);
		pm().focus();
		keyOn(pm().dom, 'Backspace', { keyCode: 8 });
		await settleLong();
		expect(topNames(), '空の段落は消える').toEqual(['front_matter']);
		const sel = pm().state.selection;
		expect(sel instanceof NodeSelection && sel.from === 0, `札が選ばれる(${sel.constructor.name} ${sel.from})`).toBe(true);
		expect(text().startsWith(FM)).toBe(true);
	});

	for (const [label, build] of [
		[
			'引用の中(front_matter と段落 q)',
			(s: import('prosemirror-model').Schema, fm: PMNode) => s.nodes.blockquote!.create(null, [fm, s.nodes.paragraph!.create(null, s.text('q'))]),
		],
		[
			'リストの項目の中(段落 li と front_matter)',
			(s: import('prosemirror-model').Schema, fm: PMNode) =>
				s.nodes.bullet_list!.create(null, s.nodes.list_item!.create(null, [s.nodes.paragraph!.create(null, s.text('li')), fm])),
		],
	] as const) {
		it(`(c) ${label}に front_matter が入った切片を貼る → 入れ子の front_matter は外れ、先頭の front matter は byte のまま`, async () => {
			await mountMd(`${FM}\nbody\n`);
			const s = pm().state.schema;
			const fm = pm().state.doc.firstChild!;
			const slice = new Slice(Fragment.from(build(s, fm)), 0, 0);
			const body = textSpots(pm().state.doc, 1)[0]!;
			selectPm(body.pos + body.text.length);
			pm().focus();
			await pasteSliceLikePm(slice);
			expect(frontMattersAt(), 'front_matter は先頭の 1 つだけ').toEqual([0]);
			expect(text().startsWith(FM)).toBe(true);
		});
	}

	it('(c) 引用の中身が front_matter だけの切片を貼る → 引用の中は空の段落に替わる(中身の決まりを崩さない)', async () => {
		await mountMd(`${FM}\nbody\n`);
		const s = pm().state.schema;
		const fm = pm().state.doc.firstChild!;
		const slice = new Slice(Fragment.from(s.nodes.blockquote!.create(null, fm)), 0, 0);
		const body = textSpots(pm().state.doc, 1)[0]!;
		selectPm(body.pos + body.text.length);
		pm().focus();
		await pasteSliceLikePm(slice);
		expect(frontMattersAt(), 'front_matter は先頭の 1 つだけ').toEqual([0]);
		let quote: PMNode | null = null;
		pm().state.doc.forEach((n) => {
			if (n.type.name === 'blockquote') quote = n;
		});
		expect(quote, '引用は残る').not.toBeNull();
		const q = quote as unknown as PMNode;
		expect(q.childCount).toBe(1);
		expect(q.child(0).type.name).toBe('paragraph');
		expect(q.child(0).content.size, '空の段落').toBe(0);
	});

	it('(d) 変換の字が DOM に入った後、ProseMirror が読む前に compositionend(data あり)が来ても、段落は消えず字が入る', async () => {
		await gapBeforeTable();
		const v = pm();
		v.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
		v.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		const p = v.dom.firstElementChild!;
		expect(p.tagName, '前提: gap に段落').toBe('P');
		const t = document.createTextNode('にほん');
		p.insertBefore(t, p.firstChild);
		document.getSelection()?.collapse(t, 3);
		// ProseMirror が DOM を読む前(同じ同期の流れの中)に compositionend
		v.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'にほん' }));
		await new Promise((r) => setTimeout(r, 80));
		(v as unknown as { domObserver: { flush(): void } }).domObserver.flush();
		await settleLong();
		expect(topNames()[0]).toBe('paragraph');
		expect(pm().state.doc.firstChild!.textContent).toBe('にほん');
		expect(text()).toBe(`にほん\n\n${TABLE}`);
	});
});

// ---------------------------------------------------------------------------
// 実機(def81de)の Escape で取り消した変換: 表の前の gap で変換を始め、途中で段落に字が入り(ProseMirror が DOM を読み段落の Node が
// 替わる)、Escape で字が消えて compositionend(data "")。実機のイベントの順=compositionstart → compositionupdate / insertCompositionText
// × 7(最後は data " ")→ deleteCompositionText → compositionend(data "")。事後確認 (20): 作った空の段落は消え、文書は元の byte。
// 修正前は「作った時と同じ Node なら消す」なので、途中で Node が替わったこの経路を拾えず空の段落が残る(赤)。
// 対照(字が残ったまま compositionend なら消さない)は上の「再照合 P3 の固定 (d)」と「実機ゲート B」で固定済み。
// ---------------------------------------------------------------------------

describe('実機の Escape で取り消した変換(事後確認 (20)): 途中で字が入って消えた空の段落も消え、文書は元の byte', () => {
	const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';

	it('gap で keydown 229 → compositionstart → 段落に字(途中で読む)→ 字を消して読む → compositionend(data "")→ 空の段落は消える・元の byte・dirty でない', async () => {
		await mountMd(TABLE);
		let a = -1;
		pm().state.doc.descendants((n, p) => {
			if (a >= 0) return false;
			if (n.isText && n.text === 'a') a = p;
			return a < 0;
		});
		selectPm(a + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		expect(pm().state.selection instanceof GapCursor, '前提: 表の前の gap').toBe(true);
		const v = pm();
		const flush = () => (v as unknown as { domObserver: { flush(): void } }).domObserver.flush();
		v.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
		v.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		const p = v.dom.firstElementChild!;
		expect(p.tagName, '前提: gap に段落').toBe('P');
		const made = pm().state.doc.firstChild!;
		// 変換の途中: 字が入り、ProseMirror が読む(段落の Node が替わる)
		const t = document.createTextNode('n');
		p.insertBefore(t, p.firstChild);
		document.getSelection()?.collapse(t, 1);
		v.dom.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'n', isComposing: true, bubbles: true }));
		flush();
		await settle();
		t.data = 'に';
		document.getSelection()?.collapse(t, 1);
		v.dom.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'に', isComposing: true, bubbles: true }));
		flush();
		await settle();
		expect(pm().state.doc.firstChild!.textContent, '前提: 変換の途中の字が段落に読まれた').toBe('に');
		expect(pm().state.doc.firstChild, '前提: 段落の Node は作った時と替わった').not.toBe(made);
		// Escape で取り消し: 字が消え(deleteCompositionText)、ProseMirror が読む
		t.remove();
		document.getSelection()?.collapse(p, 0);
		v.dom.dispatchEvent(new InputEvent('input', { inputType: 'deleteCompositionText', isComposing: true, bubbles: true }));
		flush();
		await settle();
		expect(pm().state.doc.firstChild!.content.size, '前提: 段落は空').toBe(0);
		v.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		await new Promise((r) => setTimeout(r, 80));
		flush();
		await settleLong();
		expect(topNames()[0], '空の段落は残らない').toBe('table');
		expect(text()).toBe(TABLE);
		expect(handle().dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 9b22601(作った段落の位置を写して覚える)の照合の差し戻し(reviewer-o・8323893)
// P2-a 古い位置で関係の無い段落を消さない: gap で keydown 229 → 段落 P → 変換が続かない → P が消える → 同じ所に利用者が段落 Q を
//      作って字を打って消す(空行)→ Q の中で変換を始めて Escape → Q は消えない(修正前は覚えた位置が Q を指したまま=Q が消える=赤)
// P2-b 判定の固定(今の実装で緑・変異で赤): 位置を写す・字の残った段落は消さない・カーソルを動かした後は何もしない・使えなくなった
//      位置は忘れる
// ---------------------------------------------------------------------------

describe('Escape の変換の差し戻し: 覚えた位置は作った段落だけに使う', () => {
	const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';

	async function gapBeforeTable() {
		await mountMd(TABLE);
		let a = -1;
		pm().state.doc.descendants((n, p) => {
			if (a >= 0) return false;
			if (n.isText && n.text === 'a') a = p;
			return a < 0;
		});
		selectPm(a + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		expect(pm().state.selection instanceof GapCursor, '前提: 表の前の gap').toBe(true);
	}
	async function key229(index = 0) {
		pm().dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
		await settle();
		expect(topNames()[index], '前提: gap に段落').toBe('paragraph');
		expect(pm().state.doc.child(index).content.size).toBe(0);
	}
	async function compositionStart() {
		pm().dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
	}
	/** Escape の取り消し=字なしの compositionend。 */
	async function escapeComposition() {
		pm().dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		await new Promise((r) => setTimeout(r, 80));
		await settleLong();
	}
	function cursorIn(index: number) {
		const v = pm();
		v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, blockPos(v.state.doc, index) + 1)));
	}

	it('P2-a: keydown 229 で作った段落 P が変換なしに消え、同じ所に利用者が作った空の段落 Q で変換を Escape → Q は消えない', async () => {
		await gapBeforeTable();
		await key229();
		// 変換は続かない(compositionstart / end が来ない)まま、P が消える
		const v = pm();
		const del = v.state.tr.delete(0, v.state.doc.firstChild!.nodeSize);
		v.dispatch(del.setSelection(new GapCursor(del.doc.resolve(0))));
		await settle();
		expect(topNames()[0], '前提: P は消えた').toBe('table');
		// 利用者が同じ所に Enter で段落 Q を作り、字を打って消す(空行)
		keyOn(pm().dom, 'Enter', { keyCode: 13 });
		await settleLong();
		expect(topNames()[0], '前提: Enter で段落 Q').toBe('paragraph');
		typeChars('x');
		await settle();
		// 字を消す(ブラウザの既定の Backspace の結果=字 1 つの削除)
		const q = pm();
		q.dispatch(q.state.tr.delete(q.state.selection.from - 1, q.state.selection.from));
		await settleLong();
		expect(pm().state.doc.firstChild!.content.size, '前提: Q は空').toBe(0);
		// Q の中で変換を始めて Escape
		await compositionStart();
		await escapeComposition();
		expect(topNames()[0], '利用者の空行 Q は消えない').toBe('paragraph');
		expect(pm().state.doc.firstChild!.content.size).toBe(0);
		expect(topNames().slice(1, 2)).toEqual(['table']);
	});

	it('P2-b (1) 位置を写す: 作った後・取り消しの前に文書の前のほう(作った段落より前の段落)の字が変わっても、取り消しで消えるのは作った段落だけ', async () => {
		const SRC = 'intro\n\n<div>\nh\n</div>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
		await mountMd(SRC);
		let a = -1;
		pm().state.doc.descendants((n, p) => {
			if (a >= 0) return false;
			if (n.isText && n.text === 'a') a = p;
			return a < 0;
		});
		selectPm(a + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		expect(pm().state.selection instanceof GapCursor, '前提: 生 HTML と表の間の gap').toBe(true);
		await key229(2);
		expect(topNames(), '前提: [intro, 生 HTML, 作った段落, 表]').toEqual(['paragraph', 'html_block', 'paragraph', 'table']);
		await compositionStart();
		const v = pm();
		// 文書の前のほう(intro の先頭)に字が入る。作った段落の位置は 2 字ぶん後ろへずれる
		v.dispatch(v.state.tr.insertText('XY', 1));
		await settle();
		expect(pm().state.doc.resolve(pm().state.selection.from).index(0), '前提: カーソルは作った段落の中').toBe(2);
		await escapeComposition();
		expect(topNames(), '作った段落だけが消える').toEqual(['paragraph', 'html_block', 'table']);
		expect(text()).toBe(SRC.replace('intro', 'XYintro'));
	});

	it('P2-b (1) 位置を写す: 作った段落のちょうど前(同じ境目)に段落が足されても、取り消しで消えるのは作った段落だけ(足した段落は残る)', async () => {
		await gapBeforeTable();
		await key229();
		await compositionStart();
		const v = pm();
		// 文書の前のほうが変わる(作った段落の前に段落 pre を足す。カーソルは作った段落の中のまま写る)
		v.dispatch(v.state.tr.insert(0, v.state.schema.nodes.paragraph!.create(null, v.state.schema.text('pre'))));
		await settle();
		expect(topNames().slice(0, 3), '前提: [pre, 作った段落, 表]').toEqual(['paragraph', 'paragraph', 'table']);
		expect(pm().state.doc.resolve(pm().state.selection.from).index(0), '前提: カーソルは作った段落の中').toBe(1);
		await escapeComposition();
		expect(topNames().slice(0, 2), '作った段落だけが消える').toEqual(['paragraph', 'table']);
		expect(pm().state.doc.firstChild!.textContent).toBe('pre');
		expect(text()).toBe(`pre\n\n${TABLE}`);
	});

	it('P2-b (2) 字の残った段落は消さない: compositionend の data が空でも、作った段落に字があれば残す', async () => {
		await gapBeforeTable();
		await key229();
		await compositionStart();
		const v = pm();
		// 字が残り、カーソルは段落の先頭(作った時と同じ所=カーソルの判定は通る形にして、空の段落の判定だけを見る)
		const at = v.state.selection.from;
		const tr = v.state.tr.insertText('z', at);
		v.dispatch(tr.setSelection(TextSelection.create(tr.doc, at)));
		await settle();
		expect(pm().state.doc.firstChild!.textContent, '前提: 段落に字').toBe('z');
		expect(pm().state.selection.from, '前提: カーソルは段落の先頭').toBe(1);
		await escapeComposition();
		expect(topNames()[0]).toBe('paragraph');
		expect(pm().state.doc.firstChild!.textContent, '字の残った段落は消えない').toBe('z');
	});

	it('P2-b (3) カーソルを他へ動かした後の字なしの compositionend は何もしない(作った空の段落も残る)', async () => {
		await gapBeforeTable();
		await key229();
		await compositionStart();
		cursorIn(pm().state.doc.childCount - 1); // after の段落へ
		await settle();
		await escapeComposition();
		expect(topNames()[0], '作った段落は残る(カーソルが中に無い)').toBe('paragraph');
		expect(pm().state.doc.firstChild!.content.size).toBe(0);
	});

	it('P2-b (4) 使えなくなった位置は忘れる: (3) の後に作った空の段落へ戻り、そこで別の変換を Escape しても消さない', async () => {
		await gapBeforeTable();
		await key229();
		await compositionStart();
		cursorIn(pm().state.doc.childCount - 1);
		await settle();
		await escapeComposition();
		expect(topNames()[0], '前提: 作った段落は残る').toBe('paragraph');
		// 作った(今は利用者の)空の段落へ戻り、別の変換を始めて Escape
		cursorIn(0);
		await settle();
		await compositionStart();
		await escapeComposition();
		expect(topNames()[0], '忘れた位置では消さない').toBe('paragraph');
		expect(pm().state.doc.firstChild!.content.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 実機(9d4c47e のきれいなビルド)の Escape の順: compositionstart → insertCompositionText "n"・"に"・"にh"・"にほ"・"にほn" →
// 1 回目の Escape で insertCompositionText " "(変換の字が空白 1 つ)→ 2 回目の Escape で deleteCompositionText → compositionend(data "")。
// compositionend の受け手が走る時点では、ProseMirror はまだ deleteCompositionText の DOM の変化を読んでおらず、段落は " " のまま
// (=空でないと判断して忘れる見込み)。期待: 後で読んだ結果、作った空の段落は消え、文書は元の byte・dirty でない。
// 前の「実機の Escape で取り消した変換」の件は compositionend の前に読ませていた(この順を拾えない)。
// ---------------------------------------------------------------------------

describe('実機の Escape の順(空白 → 削除 → 読む前の compositionend): 作った空の段落は消え、文書は元の byte', () => {
	const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';

	it('gap で変換 → "n"・"に"・"にh"・"にほ"・"にほn" → " "(読む)→ 字を DOM から消した直後に compositionend(data "")→ 後で読む → 空の段落は消える', async () => {
		await mountMd(TABLE);
		let a = -1;
		pm().state.doc.descendants((n, p) => {
			if (a >= 0) return false;
			if (n.isText && n.text === 'a') a = p;
			return a < 0;
		});
		selectPm(a + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		expect(pm().state.selection instanceof GapCursor, '前提: 表の前の gap').toBe(true);
		const v = pm();
		const flush = () => (v as unknown as { domObserver: { flush(): void } }).domObserver.flush();
		v.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
		v.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		const p = v.dom.firstElementChild!;
		expect(p.tagName, '前提: gap に段落').toBe('P');
		const t = document.createTextNode('');
		p.insertBefore(t, p.firstChild);
		// 変換の途中の字(1 字ずつ DOM に入り、ProseMirror が読む)
		for (const data of ['n', 'に', 'にh', 'にほ', 'にほn', ' ']) {
			v.dom.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data, isComposing: true, bubbles: true, cancelable: true }));
			t.data = data;
			document.getSelection()?.collapse(t, data.length);
			v.dom.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data, isComposing: true, bubbles: true }));
			flush();
			await settle();
		}
		expect(pm().state.doc.firstChild!.textContent, '前提: 1 回目の Escape で変換の字は空白 1 つ(読まれた)').toBe(' ');
		// 2 回目の Escape: deleteCompositionText で DOM から字が消え、ProseMirror が読む前(同じ同期の流れ)に compositionend(data "")
		v.dom.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteCompositionText', isComposing: true, bubbles: true, cancelable: true }));
		t.remove();
		document.getSelection()?.collapse(p, 0);
		v.dom.dispatchEvent(new InputEvent('input', { inputType: 'deleteCompositionText', isComposing: true, bubbles: true }));
		expect(pm().state.doc.firstChild!.textContent, '前提: compositionend の時点で ProseMirror の段落はまだ " "').toBe(' ');
		v.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		// その後で読む
		await new Promise((r) => setTimeout(r, 80));
		flush();
		await settleLong();
		await new Promise((r) => setTimeout(r, 100));
		await settleLong();
		expect(topNames()[0], '空の段落は残らない').toBe('table');
		expect(text()).toBe(TABLE);
		expect(handle().dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 6f634c3(字なしの compositionend の判定を ProseMirror が DOM を読んだ後に待つ)の照合の差し戻し(テストの穴・reviewer-o・2e29c75)
// 待ちの判定の固定(今の実装で緑・変異で赤): (1) 待ちの間の取引で段落に字があれば消さない (2) 待ちが切れたら(500 ms)読んだ後でも消さない
// ---------------------------------------------------------------------------

describe('字なしの compositionend の待ち: 字があれば消さない・待ちが切れたら消さない', () => {
	const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';

	/** 表の前の gap で変換を始め、段落の字を `steps` の順に DOM へ入れて ProseMirror に読ませる。字のノードと段落を返す。 */
	async function composeAtGap(steps: string[]) {
		await mountMd(TABLE);
		let a = -1;
		pm().state.doc.descendants((n, p) => {
			if (a >= 0) return false;
			if (n.isText && n.text === 'a') a = p;
			return a < 0;
		});
		selectPm(a + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		expect(pm().state.selection instanceof GapCursor, '前提: 表の前の gap').toBe(true);
		const v = pm();
		v.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
		v.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		const p = v.dom.firstElementChild!;
		expect(p.tagName, '前提: gap に段落').toBe('P');
		const t = document.createTextNode('');
		p.insertBefore(t, p.firstChild);
		for (const data of steps) {
			t.data = data;
			document.getSelection()?.collapse(t, data.length);
			v.dom.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data, isComposing: true, bubbles: true }));
			flushPm();
			await settle();
		}
		return { t, p };
	}
	function flushPm() {
		(pm() as unknown as { domObserver: { flush(): void } }).domObserver.flush();
	}

	it('(1) 字なしの compositionend の後、段落に「にほ」が残ったまま 500 ms 以内に x を打つ → 段落は消えず「にほx」', async () => {
		await composeAtGap(['n', 'に', 'にh', 'にほ']);
		expect(pm().state.doc.firstChild!.textContent, '前提: 段落に字').toBe('にほ');
		pm().dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		// 待ちの間(500 ms 以内)に打つ
		typeChars('x');
		await settleLong();
		expect(topNames()[0], '段落は消えない').toBe('paragraph');
		expect(pm().state.doc.firstChild!.textContent).toBe('にほx');
		expect(text()).toBe(`にほx\n\n${TABLE}`);
	});

	it('(2) 字なしの compositionend の後、ProseMirror が読む前に 500 ms を過ぎ、その後で読んで段落が空になる → 段落は消えない(待ちが切れたら忘れる)', async () => {
		const { t, p } = await composeAtGap(['n', 'に', 'にほ', ' ']);
		expect(pm().state.doc.firstChild!.textContent, '前提: 段落は " "').toBe(' ');
		const v = pm();
		// 2 回目の Escape: DOM から字が消える(ProseMirror はまだ読まない)→ compositionend(data "")
		t.remove();
		document.getSelection()?.collapse(p, 0);
		v.dom.dispatchEvent(new InputEvent('input', { inputType: 'deleteCompositionText', isComposing: true, bubbles: true }));
		v.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		expect(pm().state.doc.firstChild!.textContent, '前提: compositionend の時点で段落はまだ " "').toBe(' ');
		// 読む前に時計が 600 ms 進む
		const base = Date.now();
		const clock = vi.spyOn(Date, 'now').mockImplementation(() => base + 600);
		try {
			await new Promise((r) => setTimeout(r, 80));
			flushPm();
			await settleLong();
		} finally {
			clock.mockRestore();
		}
		expect(pm().state.doc.firstChild!.content.size, '前提: 読んだ後、段落は空').toBe(0);
		expect(topNames()[0], '待ちが切れた後に空になった段落は消さない').toBe('paragraph');
	});
});

// ---------------------------------------------------------------------------
// 実機の診断(scratchpad の req74-gate24/g3/req74-diag-ime-cancel.json): 字なしの compositionend の後、空の段落は正しく一度消えて
// gap cursor に戻る。その 6 ms 後に、変換を終わらせた 2 回目の Escape の keydown が keyCode 229 のまま届き、gap の keydown(229)の受け手が
// 「変換の始まり」とみなして空の段落を作り直す(修正前は赤)。
// 期待: 変換の始まりでない鍵(Escape・推奨の解釈で Enter / Backspace / 矢印も)の keyCode 229 では段落を作らない。
// 対照: 変換の始まりの字の鍵(key が 'Process' か 1 文字)の keyCode 229 では今までどおり段落ができる。
// ---------------------------------------------------------------------------

describe('変換の後の keyCode 229: Escape など変換の始まりでない鍵では gap に段落を作らない', () => {
	const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';

	async function gapBeforeTable() {
		await mountMd(TABLE);
		let a = -1;
		pm().state.doc.descendants((n, p) => {
			if (a >= 0) return false;
			if (n.isText && n.text === 'a') a = p;
			return a < 0;
		});
		selectPm(a + 1);
		pm().focus();
		keyOn(pm().dom, 'ArrowUp');
		await settleLong();
		expect(pm().state.selection instanceof GapCursor, '前提: 表の前の gap').toBe(true);
	}
	function key229(key: string) {
		pm().dom.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode: 229, bubbles: true, cancelable: true }));
	}

	it('実機の順: 変換 → " " → deleteCompositionText → compositionend(data "")→ 段落が消えて gap → keydown(Escape・229)→ 段落は作られない', async () => {
		await gapBeforeTable();
		const v = pm();
		const flush = () => (v as unknown as { domObserver: { flush(): void } }).domObserver.flush();
		key229('Process');
		v.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		await settle();
		const p = v.dom.firstElementChild!;
		expect(p.tagName, '前提: gap に段落').toBe('P');
		const t = document.createTextNode('');
		p.insertBefore(t, p.firstChild);
		for (const data of ['n', 'に', 'にほ', ' ']) {
			t.data = data;
			document.getSelection()?.collapse(t, data.length);
			v.dom.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data, isComposing: true, bubbles: true }));
			flush();
			await settle();
		}
		t.remove();
		document.getSelection()?.collapse(p, 0);
		v.dom.dispatchEvent(new InputEvent('input', { inputType: 'deleteCompositionText', isComposing: true, bubbles: true }));
		flush();
		await settle();
		v.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
		await new Promise((r) => setTimeout(r, 80));
		flush();
		await settleLong();
		expect(topNames()[0], '前提: 空の段落は消えた').toBe('table');
		expect(pm().state.selection instanceof GapCursor, '前提: gap cursor に戻った').toBe(true);
		// 変換を終わらせた 2 回目の Escape の keydown が keyCode 229 のまま届く(実機は 6 ms 後)
		key229('Escape');
		await settleLong();
		expect(topNames()[0], 'Escape の 229 では段落を作らない').toBe('table');
		expect(text()).toBe(TABLE);
		expect(handle().dirty).toBe(false);
	});

	for (const key of ['Escape', 'Enter', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']) {
		it(`gap で keydown(${key}・keyCode 229)→ 段落は作られない(推奨の解釈=変換の始まりでない鍵)`, async () => {
			await gapBeforeTable();
			key229(key);
			await settleLong();
			expect(topNames()[0], `${key} の 229 では段落を作らない`).toBe('table');
			expect(text()).toBe(TABLE);
		});
	}

	for (const key of ['Process', 'n', 'あ']) {
		it(`対照: gap で keydown(key '${key}'・keyCode 229)→ 今までどおり段落ができる(変換の始まり)`, async () => {
			await gapBeforeTable();
			key229(key);
			await settle();
			expect(topNames()[0], '変換の始まりでは段落ができる').toBe('paragraph');
			expect(pm().state.doc.firstChild!.content.size).toBe(0);
		});
	}
});

// ---------------------------------------------------------------------------
// 事後確認 (18)(由谷の回答 2026-11-18): 編集面では macOS の自動の大文字化と自動修正を切る(実機で "undo1" が "Undo1" になった)。
// 書ける面の contenteditable の要素(Markdown の ProseMirror の面=view.dom・コードのファイル / plain text の CodeMirror の面・
// raw の面・fence の埋め込みの CodeMirror)に autocapitalize="off" と autocorrect="off"。読み取り専用の面は対象外。
// 修正前: CodeMirror の面(コード・raw・fence)は既に付いている。ProseMirror の面に無い(赤)。
// ---------------------------------------------------------------------------

describe('事後確認 (18): 書ける編集面の contenteditable は autocapitalize="off"・autocorrect="off"', () => {
	function expectNoAutoCorrection(el: Element | null, label: string) {
		expect(el, `${label} の contenteditable の要素`).not.toBeNull();
		expect(el!.getAttribute('contenteditable'), `${label} は書ける`).toBe('true');
		expect(el!.getAttribute('autocapitalize'), `${label} の autocapitalize`).toBe('off');
		expect(el!.getAttribute('autocorrect'), `${label} の autocorrect`).toBe('off');
	}
	async function mountPlain(uri: string, content: string) {
		const d = doc(uri, content);
		windowState.setDocument(d);
		const escaped = content.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
		const result = render(Viewer, { props: baseProps(d, `<pre class="vellis-plaintext">\n${escaped}</pre>`, null) });
		await settleLong();
		return result;
	}

	it('Markdown の ProseMirror の面(view.dom)', async () => {
		await mountMd('intro\n\nbody\n');
		expectNoAutoCorrection(pm().dom, 'ProseMirror の面');
	});

	it('Markdown の fence の埋め込みの CodeMirror(.cm-content)', async () => {
		await mountMd('intro\n\n```ts\nconst x = 1;\n```\n');
		const ts = codeBlock('ts');
		const cm = cmIn(blockDom(ts.pos));
		expect(cm, '埋め込みの CodeMirror').not.toBeNull();
		expectNoAutoCorrection(cm!.contentDOM, 'fence の CodeMirror');
	});

	it('Markdown の raw の面(.cm-content)', async () => {
		const { container } = await mountMd('intro\n\nbody\n');
		handle().toggleRaw();
		await settleLong();
		expectNoAutoCorrection(container.querySelector('[data-testid="raw-source-editor"] .cm-content'), 'raw の面');
	});

	it('コードのファイル(.ts)の CodeMirror の面(.cm-content)', async () => {
		const { container } = await mountPlain('file:///Users/a/src/app.ts', 'const x = 1;\n');
		expectNoAutoCorrection(container.querySelector('[data-testid="code-editor"] .cm-content'), 'コードの面');
	});

	it('plain text(.txt)の CodeMirror の面(.cm-content)', async () => {
		const { container } = await mountPlain('file:///Users/a/notes/memo.txt', 'undo1\n');
		expectNoAutoCorrection(container.querySelector('[data-testid="code-editor"] .cm-content'), 'plain text の面');
	});
});

// ---------------------------------------------------------------------------
// 事後確認 (22)(2026-11-18・reviewer-o の照合で分かった入力欄の漏れ): 検索の欄(find-input)・置換の欄(replace-input)・リンクの欄の
// Text(link-text)と Link(link-url・type="url"=推奨で含める)も、自動の大文字化と自動修正を切る(autocapitalize="off"・autocorrect="off")。
// ---------------------------------------------------------------------------

describe('事後確認 (22): 検索・置換・リンクの欄は autocapitalize="off"・autocorrect="off"', () => {
	const menuHandlers = (eventsModule as unknown as { __eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>> }).__eventHandlers;

	async function emit(event: string) {
		await settle();
		const list = [...(menuHandlers.get(event) ?? [])];
		expect(list.length, `Viewer が '${event}' を購読していること`).toBeGreaterThan(0);
		for (const h of list) h({ payload: undefined });
		await settleLong();
	}
	function expectNoAutoCorrection(el: Element | null, label: string) {
		expect(el, `${label} の入力欄`).not.toBeNull();
		expect(el!.getAttribute('autocapitalize'), `${label} の autocapitalize`).toBe('off');
		expect(el!.getAttribute('autocorrect'), `${label} の autocorrect`).toBe('off');
	}

	async function mountPlainAndOpenReplace() {
		const content = 'undo1 undo2\n';
		const d = doc('file:///Users/a/notes/memo.txt', content);
		windowState.setDocument(d);
		const { container } = render(Viewer, { props: baseProps(d, `<pre class="vellis-plaintext">\n${content}</pre>`, null) });
		await settleLong();
		await emit('menu_find_replace');
		return container;
	}
	async function openLinkFields() {
		const { container } = await mountMd('intro\n\nundo1 here\n');
		const spot = textSpots(pm().state.doc, 1)[0]!;
		selectPm(spot.pos, spot.pos + 5);
		runFormatCommand('format-link', handle());
		await settleLong();
		return container;
	}

	it('検索の欄(find-input)— plain text の面で Edit ▸ Find and Replace', async () => {
		const container = await mountPlainAndOpenReplace();
		expectNoAutoCorrection(container.querySelector('[data-testid="find-input"]'), '検索の欄');
	});

	it('置換の欄(replace-input)— plain text の面で Edit ▸ Find and Replace', async () => {
		const container = await mountPlainAndOpenReplace();
		expectNoAutoCorrection(container.querySelector('[data-testid="replace-input"]'), '置換の欄');
	});

	it('Markdown の面の検索の欄(find-input)— Edit ▸ Find', async () => {
		const { container } = await mountMd('undo1 here\n');
		await emit('menu_find');
		expectNoAutoCorrection(container.querySelector('[data-testid="find-input"]'), '検索の欄');
	});

	it('リンクの欄の Text(link-text)— Format ▸ Link…', async () => {
		const container = await openLinkFields();
		expectNoAutoCorrection(container.querySelector('[data-testid="link-text"]'), 'リンクの Text の欄');
	});

	it('リンクの欄の Link(link-url・type="url")— Format ▸ Link…(推奨の解釈で対象に含める)', async () => {
		const container = await openLinkFields();
		const url = container.querySelector('[data-testid="link-url"]');
		expect(url?.getAttribute('type'), '前提: type="url"').toBe('url');
		expectNoAutoCorrection(url, 'リンクの Link の欄');
	});
});
