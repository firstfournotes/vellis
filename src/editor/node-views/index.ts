/**
 * Markdown の編集面の NodeView と MarkView(要件#74 契約7・17・第2段の作り(案)の項目 20・22〜25)。
 *
 * 描画のまま直しにくいものを、今の描画(`render`)と同じ見た目で面に出す。どれも原文(`attrs`)は変えず、DOM だけを作る。
 *
 * - code fence: CodeMirror の埋め込み(色付きのまま打てる。中の変更は ProseMirror の取引に写し、undo は文書で 1 つ)+言語の札
 * - mermaid の fence: 選択が外なら図(今の placeholder と同じ形で `mountMermaid`)、中なら上と同じ埋め込み。中身を変えて外に
 *   出たら 500 ms おいて描き直す(変換中は確定まで待つ)
 * - 生 HTML のブロックとインライン: 今の描画と同じ sanitize 済みの HTML の、打てない塊
 * - front matter: 札(「Front matter · N lines」)
 * - 画像: DOM の src は rewrite-uri と同じ規則で `vellis-asset:`(原文には焼き付けない)
 * - 脚注: 参照は参照の順の番号・定義は原文の位置に番号と戻りリンク ↩(判断 6)
 * - リンク: 参照リンクの行き先は描画のときに定義から引く
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from 'prosemirror-transform';
import { Decoration, DecorationSet, type EditorView, type MarkView, type NodeView, type NodeViewConstructor, type MarkViewConstructor } from 'prosemirror-view';
import { redo, undo } from 'prosemirror-history';
import { Compartment, EditorState as CMState, type Extension } from '@codemirror/state';
import { EditorView as CMView, keymap } from '@codemirror/view';
import { LanguageDescription, bracketMatching } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { cursorCharLeft, cursorCharRight, cursorLineDown, cursorLineUp } from '@codemirror/commands';

import { isExternal, resolveRelative, toAssetUri } from '$lib/uri';
import { mountMermaid } from '$lib/mermaid-mounter';
import { render } from '../../markdown/renderer';
import { createHighlightLoader } from '../cm-face';
import { CODE_KEYMAP } from '../code-keymap';
import { undoMarkdownInputRule } from '../input-rules';
import { GapCursor } from 'prosemirror-gapcursor';
import { gapValid } from '../gap-cursor';

export interface NodeViewContext {
	/** 文書の URI(画像の相対パスの基準)。 */
	uri: string;
	/** 埋め込みの CodeMirror の配色(Shiki の同梱テーマの名前)。 */
	codeTheme: () => string;
	/** 開いている code fence の NodeView(テーマの切り替えを配る先)。 */
	codeBlocks?: Set<{ setTheme(name: string): void }>;
	/** 生 HTML の描画の控え(原文の塊 → sanitize 済みの HTML)。面と一緒に消える。 */
	rawHtmlCache?: Map<string, Promise<string>>;
}

/** 面の codeTheme が変わったら、開いている埋め込みの CodeMirror の配色を替える(文書・選択・履歴は保つ=契約5)。 */
export function applyCodeTheme(ctx: NodeViewContext, name: string): void {
	for (const block of ctx.codeBlocks ?? []) block.setTheme(name);
}

/** mermaid の描き直しを待つ時間(項目 22)。 */
export const MERMAID_REDRAW_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// 今の描画(sanitize 済み)の HTML
// ---------------------------------------------------------------------------

/** 生 HTML を今の描画と同じ道(render=sanitize 済み)で HTML にする。同じ塊は面ごとに 1 回だけ描く。 */
function renderRaw(raw: string, ctx: NodeViewContext): Promise<string> {
	const cache = (ctx.rawHtmlCache ??= new Map());
	const key = `${ctx.uri}\n${raw}`;
	let html = cache.get(key);
	if (!html) {
		html = render(raw + '\n', ctx.uri).then((r) => r.html);
		html.catch(() => cache.delete(key));
		cache.set(key, html);
	}
	return html;
}

/** 文書(不変)ごとに 1 回だけ求める表。NodeView は 1 つ作るたびに引くので、走査は文書の版ごとに 1 回にする。 */
function memoByDoc<T extends object>(compute: (doc: PMNode) => T): (doc: PMNode) => T {
	const cache = new WeakMap<PMNode, T>();
	return (doc) => {
		let value = cache.get(doc);
		if (!value) cache.set(doc, (value = compute(doc)));
		return value;
	};
}

/** 外側の `<p>`(1 つだけのとき)を剥がす(インラインの生 HTML は段落の中に置くので)。 */
function stripOuterParagraph(html: string, owner: Document): string {
	const host = owner.createElement('div');
	host.innerHTML = html.trim();
	const only = host.childNodes.length === 1 ? host.firstElementChild : null;
	if (only && only.tagName.toLowerCase() === 'p') return only.innerHTML;
	return html;
}

function rawHtmlView(node: PMNode, ctx: NodeViewContext, inline: boolean): NodeView {
	const dom = document.createElement(inline ? 'span' : 'div');
	dom.className = inline ? 'vellis-raw-html-inline' : 'vellis-raw-html';
	dom.setAttribute('contenteditable', 'false');
	let raw = String(node.attrs.raw ?? '');
	let request = 0;
	const fill = () => {
		const mine = ++request;
		void renderRaw(raw, ctx).then((html) => {
			if (mine !== request) return;
			dom.innerHTML = inline ? stripOuterParagraph(html, dom.ownerDocument) : html;
		});
	};
	fill();
	return {
		dom,
		update(next) {
			if (next.type !== node.type) return false;
			const nextRaw = String(next.attrs.raw ?? '');
			if (nextRaw !== raw) {
				raw = nextRaw;
				fill();
			}
			node = next;
			return true;
		},
		ignoreMutation: () => true,
		stopEvent: () => false,
	};
}

// ---------------------------------------------------------------------------
// front matter・画像
// ---------------------------------------------------------------------------

function frontMatterView(node: PMNode): NodeView {
	const dom = document.createElement('div');
	dom.className = 'front-matter-chip';
	dom.setAttribute('data-testid', 'front-matter-chip');
	dom.setAttribute('contenteditable', 'false');
	const label = (n: PMNode) => {
		const lines = String(n.attrs.raw ?? '').replace(/\r?\n$/, '').split(/\r\n|\r|\n/).length;
		return `Front matter · ${lines} lines`;
	};
	dom.textContent = label(node);
	return {
		dom,
		update(next) {
			if (next.type !== node.type) return false;
			dom.textContent = label(next);
			node = next;
			return true;
		},
		ignoreMutation: () => true,
	};
}

/** 画像の DOM の src(rewrite-uri と同じ規則。原文には焼き付けない)。 */
export function displayImageSrc(src: string, uri: string): string {
	if (!src || src.startsWith('vellis-asset:') || isExternal(src) || /^data:/i.test(src)) return src;
	try {
		return toAssetUri(resolveRelative(uri, src));
	} catch {
		return src;
	}
}

/** 参照の定義の表(小文字の identifier → url。同じ identifier は先のもの)。 */
const definitionUrls = memoByDoc((doc) => {
	const urls = new Map<string, string>();
	doc.descendants((n) => {
		if (n.type.name !== 'definition') return true;
		const identifier = String(n.attrs.identifier).toLowerCase();
		if (!urls.has(identifier)) urls.set(identifier, String(n.attrs.url));
		return true;
	});
	return urls;
});

/** 参照の定義(identifier → url)を文書から引く。 */
function definitionUrl(doc: PMNode, identifier: string | null): string | null {
	if (!identifier) return null;
	return definitionUrls(doc).get(identifier.toLowerCase()) ?? null;
}

function imageView(node: PMNode, view: EditorView, ctx: NodeViewContext): NodeView {
	const dom = document.createElement('img');
	const fill = (n: PMNode) => {
		const src = n.attrs.ref ? (definitionUrl(view.state.doc, n.attrs.ref as string) ?? '') : String(n.attrs.src ?? '');
		dom.setAttribute('src', displayImageSrc(src, ctx.uri));
		dom.setAttribute('alt', String(n.attrs.alt ?? ''));
		if (n.attrs.title) dom.setAttribute('title', String(n.attrs.title));
		else dom.removeAttribute('title');
	};
	fill(node);
	return {
		dom,
		update(next) {
			if (next.type !== node.type) return false;
			fill(next);
			node = next;
			return true;
		},
		ignoreMutation: () => true,
	};
}

// ---------------------------------------------------------------------------
// 脚注(判断 6: 参照の順の番号・定義は原文の位置に番号と ↩)
// ---------------------------------------------------------------------------

/** 参照の順の番号(label → N)。 */
const footnoteNumbers = memoByDoc((doc) => {
	const numbers = new Map<string, number>();
	doc.descendants((n) => {
		if (n.type.name === 'footnote_reference') {
			const label = String(n.attrs.label);
			if (!numbers.has(label)) numbers.set(label, numbers.size + 1);
		}
		return true;
	});
	return numbers;
});

/** 面の脚注の番号を今の文書に合わせる(取引の後に呼ぶ)。 */
export function refreshFootnoteNumbers(view: EditorView): void {
	const numbers = footnoteNumbers(view.state.doc);
	for (const sup of view.dom.querySelectorAll<HTMLElement>('sup.footnote-ref')) {
		const n = numbers.get(sup.getAttribute('data-label') ?? '');
		const a = sup.querySelector('a');
		const text = n === undefined ? (sup.getAttribute('data-label') ?? '') : String(n);
		if (a && a.textContent !== text) a.textContent = text;
	}
	for (const section of view.dom.querySelectorAll<HTMLElement>('section.footnote-definition')) {
		const n = numbers.get(section.getAttribute('data-label') ?? '');
		const value = n === undefined ? '' : String(n);
		if (section.getAttribute('data-footnote-number') !== value) section.setAttribute('data-footnote-number', value);
	}
}

function footnoteReferenceView(node: PMNode, view: EditorView): NodeView {
	const label = String(node.attrs.label);
	const dom = document.createElement('sup');
	dom.className = 'footnote-ref';
	dom.setAttribute('data-label', label);
	dom.id = `fnref-${label}`;
	dom.setAttribute('contenteditable', 'false');
	const a = document.createElement('a');
	a.setAttribute('href', `#fn-${label}`);
	a.textContent = String(footnoteNumbers(view.state.doc).get(label) ?? label);
	dom.appendChild(a);
	return {
		dom,
		update: (next) => next.type === node.type && String(next.attrs.label) === label,
		ignoreMutation: () => true,
	};
}

function footnoteDefinitionView(node: PMNode, view: EditorView): NodeView {
	const label = String(node.attrs.label);
	const dom = document.createElement('section');
	dom.className = 'footnote-definition';
	dom.setAttribute('data-label', label);
	dom.id = `fn-${label}`;
	const n = footnoteNumbers(view.state.doc).get(label);
	dom.setAttribute('data-footnote-number', n === undefined ? '' : String(n));
	const contentDOM = document.createElement('div');
	contentDOM.className = 'footnote-definition-body';
	const back = document.createElement('a');
	back.className = 'footnote-backref';
	back.setAttribute('href', `#fnref-${label}`);
	back.setAttribute('contenteditable', 'false');
	back.textContent = '↩';
	dom.append(contentDOM, back);
	return {
		dom,
		contentDOM,
		update: (next) => next.type === node.type && String(next.attrs.label) === label,
		// 番号の属性と戻りリンクの書き換えは文書の変更ではない
		ignoreMutation: (m) => m.type === 'attributes' || (m.target !== contentDOM && !contentDOM.contains(m.target)),
	};
}

// ---------------------------------------------------------------------------
// code fence(CodeMirror の埋め込み)と mermaid
// ---------------------------------------------------------------------------

/** mermaid の fence のうち、選択の入っているものに付ける印(NodeView が図 ⇄ CodeMirror を切り替える)。 */
const mermaidActiveKey = new PluginKey('vellis-mermaid-active');

function isMermaid(node: PMNode | null | undefined): node is PMNode {
	return node?.type.name === 'code_block' && node.attrs.lang === 'mermaid';
}

/**
 * ↑ / ↓ で隣の mermaid の fence の中へ(実機ゲート (5)・AC-74-34)。図は contenteditable=false なので、ブラウザに任せると
 * 図を飛ばす。文字のブロックの端の行から、すぐ前(↑)/ 後ろ(↓)が mermaid の fence なら、選択をその中身の端に置く
 * (印が付いて NodeView が中身=CodeMirror に切り替わる)。
 */
function enterMermaidVertically(view: EditorView, dir: -1 | 1): boolean {
	const { selection } = view.state;
	if (!(selection instanceof TextSelection) || !selection.empty) return false;
	const $head = selection.$head;
	if (!$head.parent.isTextblock || $head.depth === 0) return false;
	if (!view.endOfTextblock(dir < 0 ? 'up' : 'down')) return false;
	const $side = view.state.doc.resolve(dir < 0 ? $head.before() : $head.after());
	const node = dir < 0 ? $side.nodeBefore : $side.nodeAfter;
	if (!isMermaid(node)) return false;
	const at = dir < 0 ? $side.pos - 1 : $side.pos + 1;
	view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)).scrollIntoView());
	return true;
}

export const mermaidActivePlugin = new Plugin({
	key: mermaidActiveKey,
	props: {
		handleKeyDown(view, event) {
			if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
			if (event.key === 'ArrowUp') return enterMermaidVertically(view, -1);
			if (event.key === 'ArrowDown') return enterMermaidVertically(view, 1);
			return false;
		},
		decorations(state: EditorState) {
			const { $head } = state.selection;
			for (let d = $head.depth; d > 0; d--) {
				const node = $head.node(d);
				if (isMermaid(node)) {
					const from = $head.before(d);
					return DecorationSet.create(state.doc, [Decoration.node(from, from + node.nodeSize, {}, { mermaidActive: true })]);
				}
			}
			return DecorationSet.empty;
		},
	},
});

function isActive(decorations: readonly Decoration[]): boolean {
	return decorations.some((d) => (d.spec as { mermaidActive?: boolean }).mermaidActive === true);
}

// ---------------------------------------------------------------------------
// タスクの印(#835・契約17・AC-74-21)
// ---------------------------------------------------------------------------

const taskMarksKey = new PluginKey<DecorationSet>('vellis-task-marks');

/** 印を押した項目(印の位置から見て一番内側の list_item)の checked を反転する。取引 1 つ。 */
function toggleTaskAt(view: EditorView, markPos: number): boolean {
	const $pos = view.state.doc.resolve(markPos);
	for (let d = $pos.depth; d > 0; d--) {
		const node = $pos.node(d);
		if (node.type.name !== 'list_item') continue;
		if (node.attrs.checked === null) return false;
		view.dispatch(view.state.tr.setNodeMarkup($pos.before(d), undefined, { ...node.attrs, checked: !node.attrs.checked }));
		return true;
	}
	return false;
}

function taskMarkDOM(checked: boolean): (view: EditorView, getPos: () => number | undefined) => HTMLElement {
	return (view, getPos) => {
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = checked;
		input.className = 'task-list-item-checkbox';
		input.setAttribute('contenteditable', 'false');
		// 読み取り専用では出すが押せない
		if (!view.editable) input.disabled = true;
		input.addEventListener('click', (event) => {
			// ブラウザの既定は click で input.checked を反転する。文書を同じ向きに反転し、印は文書から描き直す
			const pos = getPos();
			if (!view.editable || pos === undefined || !toggleTaskAt(view, pos)) {
				event.preventDefault();
				input.checked = checked;
			}
		});
		return input;
	};
}

function taskMarks(doc: PMNode): DecorationSet {
	const decorations: Decoration[] = [];
	doc.descendants((node, pos) => {
		if (node.isTextblock) return false;
		if (node.type.name === 'list_item' && node.attrs.checked !== null) {
			const checked = node.attrs.checked === true;
			const first = node.firstChild;
			// 本文の最初の文字より前: 先頭のブロックが文字のブロックならその中の頭、そうでなければ項目の頭
			const at = first?.isTextblock ? pos + 2 : pos + 1;
			decorations.push(
				Decoration.widget(at, taskMarkDOM(checked), {
					side: -1,
					ignoreSelection: true,
					key: `task-mark-${checked}`,
					stopEvent: () => true,
				}),
			);
		}
		return true;
	});
	return DecorationSet.create(doc, decorations);
}

/**
 * 取引の全部の step が、1 つの文字のブロックの中の文字だけを触ったか(mark の付け外しか、ブロックをまたがない
 * インラインの置き換え)。真なら、タスクの項目の数・checked・先頭のブロックの種類は変わらない。
 */
function touchesInlineOnly(tr: Transaction): boolean {
	return tr.steps.every((step, i) => {
		if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return true;
		if (!(step instanceof ReplaceStep)) return false;
		const { slice } = step;
		if (slice.openStart !== 0 || slice.openEnd !== 0) return false;
		const $from = tr.docs[i]!.resolve(step.from);
		if (!$from.parent.isTextblock || step.to > $from.end()) return false;
		let inline = true;
		slice.content.forEach((node) => {
			if (!node.isInline) inline = false;
		});
		return inline;
	});
}

/**
 * 面のタスクの項目(checked が null でない list_item)ごとに、項目の頭に印(`input[type=checkbox]`)を widget で出す。
 * 印は文書の中身ではない(書き出し・textContent・検索に出ない)。押すと checked を反転する(取引 1 つ・undo 1 段)。
 */
export function taskMarksPlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: taskMarksKey,
		state: {
			init: (_config, state) => taskMarks(state.doc),
			// 文字だけの取引(打鍵)では印の位置を写すだけ。項目の構造・checked に触れ得る取引のときだけ作り直す
			apply: (tr, set) => (!tr.docChanged ? set : touchesInlineOnly(tr) ? set.map(tr.mapping, tr.doc) : taskMarks(tr.doc)),
		},
		props: {
			decorations: (state) => taskMarksKey.getState(state),
		},
	});
}

/**
 * 上下の行へ。レイアウトがあれば CodeMirror の見た目の行の移動(折り返しを見る)、測れない(DOM の大きさが 0)ときは
 * 論理の行で列を保って動く。端の行では本物の cursorLineUp / cursorLineDown と同じく文書の端へ寄せる(範囲の選択も畳む)。
 */
function moveLine(view: CMView, dir: -1 | 1): boolean {
	if (view.contentDOM.getBoundingClientRect().height > 0) return dir < 0 ? cursorLineUp(view) : cursorLineDown(view);
	const { state } = view;
	const main = state.selection.main;
	const head = main.head;
	const line = state.doc.lineAt(head);
	const targetNumber = line.number + dir;
	let pos: number;
	if (targetNumber < 1 || targetNumber > state.doc.lines) {
		pos = dir < 0 ? 0 : state.doc.length;
		if (main.empty && head === pos) return false;
	} else {
		const target = state.doc.line(targetNumber);
		pos = Math.min(target.from + (head - line.from), target.to);
	}
	view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: 'select' });
	return true;
}

/** CodeMirror の文書を ProseMirror の中身に合わせる(変わった範囲だけ)。 */
function syncCodeMirror(cm: CMView, text: string): boolean {
	const current = cm.state.doc.toString();
	if (current === text) return false;
	let start = 0;
	while (start < current.length && start < text.length && current.charCodeAt(start) === text.charCodeAt(start)) start++;
	let curEnd = current.length;
	let textEnd = text.length;
	while (curEnd > start && textEnd > start && current.charCodeAt(curEnd - 1) === text.charCodeAt(textEnd - 1)) {
		curEnd--;
		textEnd--;
	}
	cm.dispatch({ changes: { from: start, to: curEnd, insert: text.slice(start, textEnd) } });
	return true;
}

class CodeBlockView implements NodeView {
	dom: HTMLElement;
	private node: PMNode;
	private readonly view: EditorView;
	private readonly getPos: () => number | undefined;
	private readonly ctx: NodeViewContext;
	private readonly mermaid: boolean;
	private cm: CMView | null = null;
	private updating = false;
	private readonly languageCompartment = new Compartment();
	private readonly themeCompartment = new Compartment();
	/** 配色を読んで当てる(失敗したら色なしで打てる)。 */
	private readonly loadTheme = createHighlightLoader(() => this.cm, this.themeCompartment);
	private chip: HTMLInputElement | null = null;
	private pre: HTMLElement | null = null;
	/** mermaid: 描いた図と、その元の文字列。 */
	private figure: HTMLElement | null = null;
	private figureSource: string | null = null;
	private redrawTimer: ReturnType<typeof setTimeout> | undefined;
	private composing = false;
	private pendingRedraw = false;
	private readonly onCompositionEnd = () => {
		if (!this.composing) return;
		this.composing = false;
		if (this.pendingRedraw) {
			this.pendingRedraw = false;
			this.scheduleRedraw();
		}
	};

	constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, decorations: readonly Decoration[], ctx: NodeViewContext) {
		this.node = node;
		this.view = view;
		this.getPos = getPos;
		this.ctx = ctx;
		this.mermaid = node.attrs.lang === 'mermaid';
		ctx.codeBlocks?.add(this);
		view.dom.addEventListener('compositionend', this.onCompositionEnd);
		if (this.mermaid) {
			this.dom = document.createElement('div');
			this.dom.className = 'vellis-mermaid-block';
			this.dom.setAttribute('contenteditable', 'false');
			if (isActive(decorations)) this.showEditor();
			else this.showFigure(true);
		} else {
			this.dom = this.buildPre();
		}
	}

	/** `<pre data-lang>` の中に言語の札と CodeMirror。 */
	private buildPre(): HTMLElement {
		const pre = document.createElement('pre');
		pre.setAttribute('data-lang', String(this.node.attrs.lang ?? ''));
		pre.setAttribute('data-code-theme', this.ctx.codeTheme());
		const chip = document.createElement('input');
		chip.type = 'text';
		chip.className = 'code-lang-chip';
		chip.setAttribute('data-testid', 'code-lang-chip');
		chip.setAttribute('aria-label', 'Code block language');
		chip.setAttribute('spellcheck', 'false');
		chip.value = String(this.node.attrs.lang ?? '');
		chip.addEventListener('change', () => this.applyLang(chip.value));
		chip.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.applyLang(chip.value);
			}
		});
		pre.appendChild(chip);
		const host = document.createElement('div');
		host.className = 'code-block-editor';
		pre.appendChild(host);
		this.cm = new CMView({ parent: host, state: this.cmState(this.node.textContent) });
		void this.loadLanguage();
		void this.loadTheme(this.ctx.codeTheme());
		this.cm.contentDOM.addEventListener('compositionstart', () => {
			this.composing = true;
		});
		this.cm.contentDOM.addEventListener('compositionend', this.onCompositionEnd);
		this.chip = chip;
		this.pre = pre;
		return pre;
	}

	private cmState(text: string) {
		const extensions: Extension = [
			// undo / redo は文書(ProseMirror)の履歴で 1 つ(CodeMirror の履歴は入れない)
			keymap.of([
				// 契約9・11(実機ゲート (7)): ```ts + 空白の直後にフォーカスが CodeMirror に入っても、Command + Z / Backspace は
				// 面と同じく入力規則を取り消して打った記号の文字に戻す
				{ key: 'Mod-z', run: () => this.undoInputRule() || undo(this.view.state, this.view.dispatch), preventDefault: true },
				{ key: 'Backspace', run: () => this.undoInputRule() },
				{ key: 'Mod-Shift-z', run: () => redo(this.view.state, this.view.dispatch), preventDefault: true },
				// fence の端から矢印キーで外へ出る(ProseMirror 公式の CodeMirror の NodeView の型= maybeEscape)
				{ key: 'ArrowUp', run: (v) => this.maybeEscape('line', -1) || moveLine(v, -1) },
				{ key: 'ArrowLeft', run: (v) => this.maybeEscape('char', -1) || cursorCharLeft(v) },
				{ key: 'ArrowDown', run: (v) => this.maybeEscape('line', 1) || moveLine(v, 1) },
				{ key: 'ArrowRight', run: (v) => this.maybeEscape('char', 1) || cursorCharRight(v) },
				// Ctrl + Enter: fence の後ろに段落を足して出る(exitCode)
				{ key: 'Ctrl-Enter', run: () => this.exitCode(), preventDefault: true },
				...CODE_KEYMAP.filter((b) => !['Mod-z', 'Mod-Shift-z', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(b.key ?? '')),
			]),
			bracketMatching(),
			CMView.lineWrapping,
			CMView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
			this.languageCompartment.of([]),
			this.themeCompartment.of([]),
			CMView.updateListener.of((update) => {
				if (this.updating || (!update.docChanged && !update.selectionSet)) return;
				this.forward(update.changes, update.state.selection.main);
			}),
		];
		return CMState.create({ doc: text, extensions });
	}

	/** CodeMirror の変更と選択を ProseMirror の取引に写す(公式の CodeMirror の NodeView の型= forwardUpdate)。 */
	private forward(changes: import('@codemirror/state').ChangeSet, main: { anchor: number; head: number }) {
		const pos = this.getPos();
		if (pos === undefined) return;
		const start = pos + 1;
		const tr = this.view.state.tr;
		changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			const from = tr.mapping.map(start + fromA);
			const to = tr.mapping.map(start + toA);
			const text = inserted.toString();
			if (text) tr.replaceWith(from, to, this.view.state.schema.text(text));
			else tr.delete(from, to);
		});
		const selection = TextSelection.create(tr.doc, start + main.anchor, start + main.head);
		if (!tr.docChanged && this.view.state.selection.eq(selection)) return;
		this.view.dispatch(tr.setSelection(selection));
	}

	private applyLang(value: string) {
		const pos = this.getPos();
		if (pos === undefined) return;
		const lang = value.trim() || null;
		if ((this.node.attrs.lang ?? null) === lang) return;
		this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, lang }));
	}

	private async loadLanguage() {
		const lang = this.node.attrs.lang as string | null;
		if (!lang || !this.cm) return;
		const desc = LanguageDescription.matchLanguageName(languages, lang, true);
		if (!desc) return;
		try {
			const support = await desc.load();
			this.cm?.dispatch({ effects: this.languageCompartment.reconfigure(support) });
		} catch {
			// 色なしで打てる
		}
	}

	/** 面のテーマが変わった(EditorView は作り直さない)。 */
	setTheme(name: string) {
		this.pre?.setAttribute('data-code-theme', name);
		void this.loadTheme(name);
	}

	/** 端にカーソルがあれば、その向きの外の位置へ ProseMirror の選択を移す。 */
	private maybeEscape(unit: 'line' | 'char', dir: -1 | 1): boolean {
		if (!this.cm) return false;
		const { state } = this.cm;
		const main = state.selection.main;
		if (!main.empty) return false;
		const range = unit === 'line' ? state.doc.lineAt(main.head) : main;
		if (dir < 0 ? range.from > 0 : range.to < state.doc.length) return false;
		const pos = this.getPos();
		if (pos === undefined) return false;
		const target = pos + (dir < 0 ? 0 : this.node.nodeSize);
		const $target = this.view.state.doc.resolve(target);
		// その向きに選択を置ける所が無い(文書の端の fence)なら fence の外の gap cursor へ(Selection.near は fence の中に戻る=
		// 実機ゲート (9)・契約4・20)
		const selection =
			Selection.findFrom($target, dir) ?? (gapValid($target) ? new GapCursor($target) : Selection.near($target, dir));
		this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView());
		this.view.focus();
		return true;
	}

	/** 入力規則の直後なら取り消して面へフォーカスを戻す(fence は段落に戻り、この CodeMirror は消える)。 */
	private undoInputRule(): boolean {
		if (!undoMarkdownInputRule(this.view.state, this.view.dispatch)) return false;
		this.view.focus();
		return true;
	}

	/** fence の後ろに空の段落を足してそこへ(取引 1 つ)。 */
	private exitCode(): boolean {
		const pos = this.getPos();
		if (pos === undefined) return false;
		const after = pos + this.node.nodeSize;
		const paragraph = this.view.state.schema.nodes.paragraph!;
		const tr = this.view.state.tr.insert(after, paragraph.create());
		tr.setSelection(TextSelection.create(tr.doc, after + 1));
		this.view.dispatch(tr.scrollIntoView());
		this.view.focus();
		return true;
	}

	/** mermaid: 埋め込みの CodeMirror を出す(図は出さない)。 */
	private showEditor() {
		this.clearRedraw();
		this.dom.replaceChildren();
		this.dom.appendChild(this.buildPre());
		this.dom.setAttribute('contenteditable', 'false');
	}

	/** mermaid: 図を出す。中身が前と同じなら描いた図をそのまま、違えば間をおいて描き直す。 */
	private showFigure(initial: boolean) {
		const source = this.node.textContent;
		this.destroyEditor();
		if (this.figure && this.figureSource === source) {
			this.dom.replaceChildren(this.figure);
			return;
		}
		const fig = document.createElement('div');
		fig.className = 'vellis-mermaid';
		fig.setAttribute('data-mermaid-source', source);
		fig.setAttribute('contenteditable', 'false');
		// 図をクリックすると中身(CodeMirror)へ(実機ゲート (5)・AC-74-34)
		fig.addEventListener('mousedown', (e) => {
			// Control + クリックは macOS の右クリック(メニューを出す)なので図のまま
			if (e.button !== 0 || e.ctrlKey) return;
			e.preventDefault();
			this.enterFromFigure();
		});
		this.figure = fig;
		this.figureSource = source;
		this.dom.replaceChildren(fig);
		if (initial) void mountMermaid(this.dom);
		else this.scheduleRedraw();
	}

	/** mermaid: 選択を中身の先頭に置き(印が付いて CodeMirror に切り替わる)、CodeMirror にフォーカスを渡す。 */
	private enterFromFigure() {
		const pos = this.getPos();
		if (pos === undefined) return;
		this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos + 1)));
		this.cm?.focus();
	}

	private scheduleRedraw() {
		this.clearRedraw();
		this.redrawTimer = setTimeout(() => {
			this.redrawTimer = undefined;
			if (this.composing) {
				this.pendingRedraw = true;
				return;
			}
			if (this.figure && this.dom.contains(this.figure)) void mountMermaid(this.dom);
		}, MERMAID_REDRAW_DELAY_MS);
	}

	private clearRedraw() {
		if (this.redrawTimer) clearTimeout(this.redrawTimer);
		this.redrawTimer = undefined;
	}

	private destroyEditor() {
		this.cm?.destroy();
		this.cm = null;
		this.chip = null;
		this.pre = null;
	}

	update(node: PMNode, decorations: readonly Decoration[]): boolean {
		if (node.type !== this.node.type) return false;
		if ((node.attrs.lang === 'mermaid') !== this.mermaid) return false;
		const langChanged = node.attrs.lang !== this.node.attrs.lang;
		this.node = node;
		if (this.mermaid) {
			const active = isActive(decorations);
			if (active && !this.cm) this.showEditor();
			else if (!active && this.cm) this.showFigure(false);
		}
		if (this.cm) {
			this.updating = true;
			syncCodeMirror(this.cm, node.textContent);
			this.updating = false;
		}
		if (langChanged && this.pre && this.chip) {
			this.pre.setAttribute('data-lang', String(node.attrs.lang ?? ''));
			if (this.chip.value !== String(node.attrs.lang ?? '')) this.chip.value = String(node.attrs.lang ?? '');
			void this.loadLanguage();
		}
		return true;
	}

	setSelection(anchor: number, head: number) {
		if (!this.cm) return;
		this.cm.focus();
		this.updating = true;
		this.cm.dispatch({ selection: { anchor, head } });
		this.updating = false;
	}

	selectNode() {
		this.cm?.focus();
	}

	stopEvent(event: Event): boolean {
		const target = event.target as Node | null;
		if (!target) return false;
		// 図のクリックは図が受ける(enterFromFigure)。ProseMirror の mousedown の選択で上書きさせない
		if (this.figure && this.figure.contains(target) && ['mousedown', 'mouseup', 'click'].includes(event.type)) return true;
		return (this.cm !== null && this.cm.dom.contains(target)) || (this.chip !== null && this.chip.contains(target));
	}

	ignoreMutation(): boolean {
		return true;
	}

	destroy() {
		this.ctx.codeBlocks?.delete(this);
		this.clearRedraw();
		this.destroyEditor();
		this.view.dom.removeEventListener('compositionend', this.onCompositionEnd);
	}
}

// ---------------------------------------------------------------------------
// リンク(参照リンクの行き先を描画のときに定義から引く)
// ---------------------------------------------------------------------------

function linkView(mark: Mark, view: EditorView): MarkView {
	const dom = document.createElement('a');
	const href =
		mark.attrs.kind === 'reference'
			? (definitionUrl(view.state.doc, mark.attrs.identifier as string | null) ?? '')
			: String(mark.attrs.href ?? '');
	dom.setAttribute('href', href);
	if (mark.attrs.title) dom.setAttribute('title', String(mark.attrs.title));
	return { dom };
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

export function createNodeViews(ctx: NodeViewContext): Record<string, NodeViewConstructor> {
	return {
		code_block: (node, view, getPos, decorations) => new CodeBlockView(node, view, getPos, decorations, ctx),
		html_block: (node) => rawHtmlView(node, ctx, false),
		html_inline: (node) => rawHtmlView(node, ctx, true),
		front_matter: (node) => frontMatterView(node),
		image: (node, view) => imageView(node, view, ctx),
		footnote_reference: (node, view) => footnoteReferenceView(node, view),
		footnote_definition: (node, view) => footnoteDefinitionView(node, view),
	};
}

export function createMarkViews(): Record<string, MarkViewConstructor> {
	return {
		link: (mark, view) => linkView(mark, view),
	};
}
