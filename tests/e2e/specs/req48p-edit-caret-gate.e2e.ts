import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertIpcInterceptionWorks,
	clickExplorerRow,
	emitMenu,
	explorerHasRow,
	installGateRecorder,
	readGateRecord,
	report,
	restoreGateRecorder,
	shot,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Requirement #48 追補p human gate (Issue #773), driven on the webdriver build
 * (docs/requirements/req-48.md「追補p」, 契約1〜4, AC-48-追p (a)〜(f)):
 *
 *   Entering the editor put the caret at the start of the document / block
 *   instead of where the user double-clicked, and the source editor (a new
 *   `<pre>` that is `focus()`ed) also scrolled back to the top. The fix puts
 *   the caret at the double-clicked character (from `caretRangeFromPoint`),
 *   collapsed, without the double-click's word selection; Command + E keeps
 *   the selection's place (text: same character offsets, a range stays a
 *   range; markdown: the start of the block's source) or, with no selection,
 *   keeps the screen where it is (text: `scrollTop` unchanged, caret at the
 *   first visible line; markdown: the first visible block's source start,
 *   scrolled so that line is near the top). The scroll never jumps to the top.
 *
 * Gate items (req-48.md「人間ゲート(追補p)」) and how each is driven here:
 *  - p-1  a long .txt scrolled half-way, a real double-click in the middle of a
 *         line → the screen does not move, the caret blinks there, typing goes
 *         in there. The double-click is a WebDriver pointer action (two
 *         down/up pairs) when the Intermediary Node supports Perform Actions,
 *         otherwise a synthetic `dblclick` with the same client coordinates
 *         (route recorded); the expected offset is what WebKit's own
 *         `caretRangeFromPoint` says for that point before the click; typing is
 *         `document.execCommand('insertText')` (WebKit's own editing).
 *  - p-2  the same on a markdown paragraph (block edit): the block becomes
 *         contenteditable with a collapsed caret at the clicked character,
 *         `scrollTop` unchanged.
 *  - p-3  the same on a code block: after the Shiki `<span>`s are replaced by
 *         plain text, the caret is at the same character count.
 *  - p-4  text, a selection in the view, then Command + E (`menu_edit` event,
 *         menus are not clicked — gate-helpers rule) → the same range in the
 *         editor, `scrollTop` unchanged.
 *  - p-5  text, no selection, scrolled → Command + E → the screen does not
 *         move, the caret is at the start of the first visible line (the line
 *         whose top sits exactly at the sticky toolbar's bottom).
 *  - p-6  markdown, a selection in a paragraph → Command + E → source editor
 *         with the caret at that paragraph's `data-source-start`, visible.
 *  - p-7  markdown, no selection, scrolled so a known paragraph is the first
 *         visible block → Command + E → caret at its source start, that line in
 *         the upper half of the visible area.
 *
 * Everything read from the page is kept in the report
 * (`$VELLIS_GATE_SHOTS/req48p-report.jsonl`, `[gate]` lines in the CI log).
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const gateDir = path.join(startRoot, 'req48p-gate');
const txtFile = path.join(gateDir, 'long.txt');
const mdFile = path.join(gateDir, 'long.md');
const REPORT = 'req48p-report.jsonl';
const VIEWER = 'article.viewer';
const TOOLBAR = `${VIEWER} header.viewer-toolbar`;
const BODY = `${VIEWER} .markdown-body`;
const VIEW_PRE = `${BODY} pre.vellis-plaintext:not([contenteditable="true"])`;
const EDITOR = `${BODY} pre.vellis-plaintext[contenteditable="true"]`;
const SCROLL_HALFWAY = 1000;

/** 200 lines of 30 characters: `line 007 the quick brown fox jumps`. */
const TXT_LINE_COUNT = 200;
const txtLine = (i: number) => `line ${String(i).padStart(3, '0')} the quick brown fox jumps`;
const TXT_CONTENT = Array.from({ length: TXT_LINE_COUNT }, (_, i) => txtLine(i)).join('\n') + '\n';

const TARGET_PARAGRAPH_TEXT = 'Target paragraph with bold word.';
const CODE_BODY = ['function add(a, b) {', '  return a + b;', '}', 'const total = add(1, 2);'].join('\n');
const MD_CONTENT = [
	'# Long document',
	'',
	...Array.from({ length: 24 }, (_, i) => [`Paragraph ${String(i + 1).padStart(2, '0')} lorem ipsum dolor sit amet, consectetur adipiscing elit.`, '']).flat(),
	'```javascript',
	CODE_BODY,
	'```',
	'',
	...Array.from({ length: 10 }, (_, i) => [`Paragraph ${String(i + 25).padStart(2, '0')} sed do eiusmod tempor incididunt ut labore.`, '']).flat(),
	'Target paragraph with **bold** word.',
	'',
	...Array.from({ length: 30 }, (_, i) => [`Paragraph ${String(i + 35).padStart(2, '0')} ut enim ad minim veniam, quis nostrud exercitation.`, '']).flat(),
].join('\n');

const uri = (p: string) => `file://${p}`;

/** Length of one line of long.txt; line i starts at `i * (TXT_LINE_LEN + 1)`. */
const TXT_LINE_LEN = txtLine(0).length;
const txtLineStart = (i: number) => i * (TXT_LINE_LEN + 1);

/** The fixture open in the viewer (what `leaveEdit` reverts the editor to). */
let currentFile = txtFile;

interface SelectionShape {
	/** A selection exists and both ends are inside the element. */
	inside: boolean;
	collapsed: boolean;
	start: number;
	end: number;
	/** Viewport rect of the selection start's line (null without a selection). */
	rect: { top: number; bottom: number; left: number } | null;
}

interface Snapshot {
	editing: boolean;
	text: string | null;
	scrollTop: number;
	/** Bottom of the sticky toolbar = top of the visible area (viewport px). */
	visibleTop: number;
	innerHeight: number;
	selection: SelectionShape;
	activeIsEditor: boolean;
}

/** The source editor as the page sees it (text, selection as character offsets, scroll). */
async function editorSnapshot(): Promise<Snapshot> {
	return browser.execute(
		(editorSel, viewerSel, toolbarSel) => {
			const editor = document.querySelector<HTMLElement>(editorSel);
			const viewer = document.querySelector<HTMLElement>(viewerSel);
			const toolbar = document.querySelector<HTMLElement>(toolbarSel);
			const sel = window.getSelection();
			const shape: SelectionShape = { inside: false, collapsed: false, start: -1, end: -1, rect: null };
			if (editor && sel && sel.rangeCount > 0) {
				const range = sel.getRangeAt(0);
				const inside = editor.contains(range.startContainer) && editor.contains(range.endContainer);
				const offsetOf = (node: Node, offset: number) => {
					const probe = document.createRange();
					probe.selectNodeContents(editor);
					probe.setEnd(node, offset);
					return probe.toString().length;
				};
				const r = range.cloneRange();
				r.collapse(true);
				const rects = r.getClientRects();
				const first = rects.length > 0 ? rects[0]! : null;
				shape.inside = inside;
				shape.collapsed = range.collapsed;
				shape.start = inside ? offsetOf(range.startContainer, range.startOffset) : -1;
				shape.end = inside ? offsetOf(range.endContainer, range.endOffset) : -1;
				shape.rect = first ? { top: first.top, bottom: first.bottom, left: first.left } : null;
			}
			return {
				editing: editor !== null,
				text: editor?.textContent ?? null,
				scrollTop: viewer?.scrollTop ?? -1,
				visibleTop: toolbar?.getBoundingClientRect().bottom ?? 0,
				innerHeight: window.innerHeight,
				selection: shape,
				activeIsEditor: editor !== null && document.activeElement === editor,
			};
		},
		EDITOR,
		VIEWER,
		TOOLBAR,
	);
}

/** Selection read against an arbitrary element (block edits). */
async function selectionIn(selector: string): Promise<SelectionShape & { editable: boolean; text: string | null; hasSpan: boolean }> {
	return browser.execute((sel0) => {
		const el = document.querySelector<HTMLElement>(sel0);
		const sel = window.getSelection();
		const out = { inside: false, collapsed: false, start: -1, end: -1, rect: null as SelectionShape['rect'], editable: false, text: null as string | null, hasSpan: false };
		if (!el) return out;
		out.editable = el.getAttribute('contenteditable') === 'true';
		out.text = el.textContent;
		out.hasSpan = el.querySelector('span') !== null;
		if (!sel || sel.rangeCount === 0) return out;
		const range = sel.getRangeAt(0);
		const inside = el.contains(range.startContainer) && el.contains(range.endContainer);
		const offsetOf = (node: Node, offset: number) => {
			const probe = document.createRange();
			probe.selectNodeContents(el);
			probe.setEnd(node, offset);
			return probe.toString().length;
		};
		const r = range.cloneRange();
		r.collapse(true);
		const rects = r.getClientRects();
		const first = rects.length > 0 ? rects[0]! : null;
		out.inside = inside;
		out.collapsed = range.collapsed;
		out.start = inside ? offsetOf(range.startContainer, range.startOffset) : -1;
		out.end = inside ? offsetOf(range.endContainer, range.endOffset) : -1;
		out.rect = first ? { top: first.top, bottom: first.bottom, left: first.left } : null;
		return out;
	}, selector);
}

async function viewerScrollTop(): Promise<number> {
	return browser.execute((sel) => document.querySelector<HTMLElement>(sel)?.scrollTop ?? -1, VIEWER);
}

/** Set the viewer's `scrollTop` and return what it became (clamped by WebKit). */
async function setViewerScrollTop(top: number): Promise<number> {
	const got = await browser.execute(
		(sel, t) => {
			const v = document.querySelector<HTMLElement>(sel);
			if (!v) return -1;
			v.scrollTop = t;
			return v.scrollTop;
		},
		VIEWER,
		top,
	);
	await browser.pause(100);
	return got;
}

async function visibleTop(): Promise<number> {
	return browser.execute((sel) => document.querySelector<HTMLElement>(sel)?.getBoundingClientRect().bottom ?? 0, TOOLBAR);
}

interface Point {
	x: number;
	y: number;
	/** Character offset `caretRangeFromPoint` reports for the point inside `selector` (-1 when outside). */
	offset: number;
	/** The element `caretRangeFromPoint` landed in (tag#id.class), for the report. */
	landed: string | null;
}

/** What WebKit's `caretRangeFromPoint` says for (x, y), as a character offset inside `selector`. */
async function offsetAtPoint(selector: string, x: number, y: number): Promise<Point> {
	return browser.execute(
		(sel0, px, py) => {
			const el = document.querySelector<HTMLElement>(sel0);
			const range = document.caretRangeFromPoint(px, py);
			if (!el || !range) return { x: px, y: py, offset: -1, landed: null };
			const node = range.startContainer;
			const landedEl = node.nodeType === 1 ? (node as Element) : node.parentElement;
			const landed = landedEl ? `${landedEl.tagName.toLowerCase()}${landedEl.id ? '#' + landedEl.id : ''}${landedEl.className && typeof landedEl.className === 'string' ? '.' + landedEl.className.split(' ').join('.') : ''}` : null;
			if (!el.contains(node)) return { x: px, y: py, offset: -1, landed };
			const probe = document.createRange();
			probe.selectNodeContents(el);
			probe.setEnd(node, range.startOffset);
			return { x: px, y: py, offset: probe.toString().length, landed };
		},
		selector,
		x,
		y,
	);
}

/** Viewport rect of an element. */
async function rectOf(selector: string): Promise<{ top: number; bottom: number; left: number; right: number; width: number; height: number } | null> {
	return browser.execute((sel) => {
		const el = document.querySelector<HTMLElement>(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
	}, selector);
}

/** Line height of the plain-text `<pre>` measured from the first two lines' rects. */
async function measureLineHeight(preSelector: string): Promise<number> {
	return browser.execute((sel) => {
		const pre = document.querySelector<HTMLElement>(sel);
		if (!pre) return -1;
		const text = pre.textContent ?? '';
		const second = text.indexOf('\n') + 1;
		const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
		const first = walker.nextNode() as Text | null;
		if (!first || second <= 0 || second >= first.data.length) return -1;
		const top = (off: number) => {
			const r = document.createRange();
			r.setStart(first, off);
			r.collapse(true);
			const rects = r.getClientRects();
			return rects.length > 0 ? rects[0]!.top : NaN;
		};
		return top(second) - top(0);
	}, preSelector);
}

/** Viewport top of the line that holds character `offset` of `selector` (Range rect). */
async function lineTopAt(selector: string, offset: number): Promise<number> {
	return browser.execute(
		(sel, off) => {
			const el = document.querySelector<HTMLElement>(sel);
			if (!el) return NaN;
			const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			let seen = 0;
			while (walker.nextNode()) {
				const t = walker.currentNode as Text;
				if (off <= seen + t.data.length) {
					const r = document.createRange();
					r.setStart(t, off - seen);
					r.collapse(true);
					const rects = r.getClientRects();
					return rects.length > 0 ? rects[0]!.top : NaN;
				}
				seen += t.data.length;
			}
			return NaN;
		},
		selector,
		offset,
	);
}

type MidPoint = Point & { charBefore: string; charAfter: string };

/**
 * The first of `candidates` (viewport points) that lands on a character of
 * `selector` which is neither the first character nor next to a line break —
 * the middle of a line, as the gate says.
 */
async function pickPointIn(selector: string, candidates: Array<{ x: number; y: number }>): Promise<MidPoint> {
	const text = await browser.execute((sel) => document.querySelector<HTMLElement>(sel)?.textContent ?? '', selector);
	const tried: Point[] = [];
	for (const c of candidates) {
		const p = await offsetAtPoint(selector, c.x, c.y);
		tried.push(p);
		const charBefore = p.offset > 0 ? text[p.offset - 1]! : '';
		const charAfter = p.offset >= 0 ? (text[p.offset] ?? '') : '';
		if (p.offset > 0 && charBefore !== '\n' && charAfter !== '\n' && charAfter !== '') return { ...p, charBefore, charAfter };
	}
	throw new Error(`could not find a mid-line point in ${selector}: ${JSON.stringify(tried)}`);
}

/**
 * Pick a point in the middle of a visible line of the view `<pre>`: a few lines
 * below the toolbar, some characters in. Nudges right until the character under
 * the point is not a line break (so it really is the middle of a line).
 */
async function pickMidLinePoint(preSelector: string, linesDown: number, lineHeight: number): Promise<MidPoint> {
	const pre = await rectOf(preSelector);
	const vt = await visibleTop();
	if (!pre) throw new Error('view pre not found');
	const y = vt + linesDown * lineHeight + lineHeight / 2;
	return pickPointIn(
		preSelector,
		Array.from({ length: 6 }, (_, i) => ({ x: pre.left + 70 + i * 20, y })),
	);
}

interface DoubleClickOutcome {
	route: 'actions' | 'synthetic';
	/** `dblclick` events seen on the document (capture) during the gesture. */
	dblclicks: number;
	actionsError: string | null;
}

/**
 * A real double-click at viewport (x, y): a WebDriver pointer action (two
 * down/up pairs) and, when the Intermediary Node does not perform actions or no
 * `dblclick` reached the page, a synthetic `dblclick` MouseEvent with the same
 * client coordinates dispatched on the element at that point.
 */
async function realDoubleClick(x: number, y: number): Promise<DoubleClickOutcome> {
	await browser.execute(() => {
		const w = window as unknown as { __req48pDbl?: number; __req48pDblListener?: EventListener };
		w.__req48pDbl = 0;
		if (!w.__req48pDblListener) {
			w.__req48pDblListener = () => {
				w.__req48pDbl = (w.__req48pDbl ?? 0) + 1;
			};
			document.addEventListener('dblclick', w.__req48pDblListener, true);
		}
	});
	let actionsError: string | null = null;
	try {
		await browser
			.action('pointer', { parameters: { pointerType: 'mouse' } })
			.move({ x: Math.round(x), y: Math.round(y), origin: 'viewport' })
			.down()
			.up()
			.pause(60)
			.down()
			.up()
			.perform();
	} catch (e) {
		actionsError = String(e);
	}
	await browser.pause(200);
	let dblclicks = await browser.execute(() => (window as unknown as { __req48pDbl?: number }).__req48pDbl ?? 0);
	if (dblclicks > 0) return { route: 'actions', dblclicks, actionsError };
	await browser.execute(
		(px, py) => {
			const el = document.elementFromPoint(px, py) ?? document.body;
			el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, clientX: px, clientY: py, detail: 2, button: 0 }));
		},
		x,
		y,
	);
	await browser.pause(200);
	dblclicks = await browser.execute(() => (window as unknown as { __req48pDbl?: number }).__req48pDbl ?? 0);
	return { route: 'synthetic', dblclicks, actionsError };
}

/** Put a selection (character offsets of `textContent`) inside `selector`. */
async function placeSelection(selector: string, start: number, end: number = start): Promise<boolean> {
	return browser.execute(
		(sel0, s, e) => {
			const el = document.querySelector<HTMLElement>(sel0);
			if (!el) return false;
			const locate = (offset: number): [Text, number] | null => {
				const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
				let seen = 0;
				let last: Text | null = null;
				while (walker.nextNode()) {
					const t = walker.currentNode as Text;
					last = t;
					if (offset <= seen + t.data.length) return [t, offset - seen];
					seen += t.data.length;
				}
				return last ? [last, last.data.length] : null;
			};
			const a = locate(s);
			const b = locate(e);
			if (!a || !b) return false;
			const range = document.createRange();
			range.setStart(a[0], a[1]);
			range.setEnd(b[0], b[1]);
			const sel = window.getSelection();
			if (!sel) return false;
			sel.removeAllRanges();
			sel.addRange(range);
			return true;
		},
		selector,
		start,
		end,
	);
}

async function clearSelection(): Promise<void> {
	await browser.execute(() => window.getSelection()?.removeAllRanges());
}

/** Type with WebKit's own editing (`insertText` fires `input` like a key press would). */
async function typeText(text: string): Promise<boolean> {
	const ok = await browser.execute((t) => document.execCommand('insertText', false, t), text);
	await browser.pause(150);
	return ok;
}

/** Screenshot that must not fail a gate when the display is off (req-69 追補a). */
async function safeShot(name: string): Promise<string | null> {
	try {
		return await shot(name);
	} catch (e) {
		report(REPORT, { gate: 'shot-failed', name, error: String(e) });
		return null;
	}
}

/** Expand `req48p-gate/` if its rows are not shown. */
async function ensureGateDirExpanded(): Promise<void> {
	if (await explorerHasRow(uri(txtFile))) return;
	await waitForExplorerRow(uri(gateDir), { timeout: 20_000, nudgeDir: startRoot, nudgePrefix: 'req48p' });
	await clickExplorerRow(uri(gateDir));
	await waitForExplorerRow(uri(txtFile), { timeout: 15_000 });
}

/** Open long.txt in the plain view. */
async function openTxt(): Promise<void> {
	await ensureGateDirExpanded();
	currentFile = txtFile;
	await clickExplorerRow(uri(txtFile));
	await browser.waitUntil(
		async () => browser.execute((sel, t) => document.querySelector<HTMLElement>(sel)?.textContent === t, VIEW_PRE, TXT_CONTENT),
		{ timeout: 15_000, timeoutMsg: 'long.txt did not open in the plain-text view' },
	);
}

/** Open long.md in the rendered view. */
async function openMd(): Promise<void> {
	await ensureGateDirExpanded();
	currentFile = mdFile;
	await clickExplorerRow(uri(mdFile));
	await browser.waitUntil(
		async () =>
			browser.execute(
				(body, text) => Array.from(document.querySelectorAll(`${body} p[data-vellis-node-type="paragraph"]`)).some((p) => p.textContent === text),
				BODY,
				TARGET_PARAGRAPH_TEXT,
			),
		{ timeout: 15_000, timeoutMsg: 'long.md did not render the target paragraph' },
	);
	await browser.pause(300);
}

/** Selector of the target paragraph (stamped with its node id once rendered). */
async function targetParagraphSelector(): Promise<string> {
	const id = await browser.execute(
		(body, text) =>
			Array.from(document.querySelectorAll<HTMLElement>(`${body} p[data-vellis-node-type="paragraph"]`)).find((p) => p.textContent === text)?.getAttribute('data-vellis-node-id') ?? null,
		BODY,
		TARGET_PARAGRAPH_TEXT,
	);
	if (!id) throw new Error('target paragraph has no data-vellis-node-id');
	return `${BODY} [data-vellis-node-id="${id}"]`;
}

/** Selector of the top-level code fence `<pre>`. */
async function codePreSelector(): Promise<string> {
	const id = await browser.execute(
		(body) => {
			const bodyEl = document.querySelector(body);
			if (!bodyEl) return null;
			return Array.from(bodyEl.children).find((el) => el.matches('pre[data-vellis-node-type="code"]'))?.getAttribute('data-vellis-node-id') ?? null;
		},
		BODY,
	);
	if (!id) throw new Error('top-level code fence not found');
	return `${BODY} pre[data-vellis-node-id="${id}"]`;
}

async function sourceStartOf(selector: string): Promise<number> {
	const v = await browser.execute((sel) => document.querySelector(sel)?.getAttribute('data-source-start') ?? null, selector);
	if (v === null) throw new Error(`${selector} has no data-source-start`);
	return Number(v);
}

/** Scroll so that `selector`'s top sits `below` px under the toolbar; returns the scrollTop reached. */
async function scrollElementBelowToolbar(selector: string, below: number): Promise<number> {
	const r = await rectOf(selector);
	const vt = await visibleTop();
	const cur = await viewerScrollTop();
	if (!r) throw new Error(`${selector} not found`);
	return setViewerScrollTop(Math.round(cur + r.top - vt - below));
}

/** The first top-level block of the markdown body whose top is at or below the toolbar's bottom. */
async function firstVisibleBlock(): Promise<{ id: string | null; sourceStart: number; top: number; visibleTop: number }> {
	return browser.execute(
		(body, toolbar) => {
			const vt = document.querySelector<HTMLElement>(toolbar)?.getBoundingClientRect().bottom ?? 0;
			const bodyEl = document.querySelector(body);
			const blocks = bodyEl ? Array.from(bodyEl.children) : [];
			for (const el of blocks) {
				const r = el.getBoundingClientRect();
				if (r.top >= vt - 0.5) {
					return { id: el.getAttribute('data-vellis-node-id'), sourceStart: Number(el.getAttribute('data-source-start') ?? -1), top: r.top, visibleTop: vt };
				}
			}
			return { id: null, sourceStart: -1, top: NaN, visibleTop: vt };
		},
		BODY,
		TOOLBAR,
	);
}

/**
 * Leave whatever edit is open without a dialog: discard a block edit with Esc
 * (not dirty when nothing was committed), or revert the source editor's text to
 * the file on disk and press Done.
 */
async function leaveEdit(file: string): Promise<void> {
	await browser.execute(() => {
		const block = document.querySelector<HTMLElement>('.markdown-body [contenteditable="true"]:not(pre.vellis-plaintext)');
		if (block) block.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }));
	});
	await browser.pause(150);
	const onDisk = fs.readFileSync(file, 'utf8');
	await browser.execute(
		(editorSel, text) => {
			const pre = document.querySelector<HTMLElement>(editorSel);
			if (pre && pre.textContent !== text) {
				pre.textContent = text;
				pre.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
			}
			document.querySelector<HTMLButtonElement>('[data-testid="edit-done"]')?.click();
		},
		EDITOR,
		onDisk,
	);
	await browser.waitUntil(
		async () => browser.execute(() => document.querySelector('[contenteditable="true"]') === null && document.querySelector('[data-testid="edit-done"]') === null),
		{ timeout: 5_000, timeoutMsg: 'could not leave the editor' },
	);
}

describe('Requirement #48 追補p human gate (the caret goes where the user double-clicked, the scroll stays)', () => {
	before(async () => {
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		fs.rmSync(gateDir, { recursive: true, force: true });
		fs.mkdirSync(gateDir, { recursive: true });
		fs.writeFileSync(txtFile, TXT_CONTENT);
		fs.writeFileSync(mdFile, MD_CONTENT);
		await ensureGateDirExpanded();
		const env = await browser.execute(() => ({
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			caretRangeFromPoint: typeof document.caretRangeFromPoint,
			userAgent: navigator.userAgent,
		}));
		report(REPORT, { gate: '48p-env', ...env });
	});

	afterEach(async () => {
		const problems: Record<string, string> = {};
		try {
			await leaveEdit(currentFile);
		} catch (err) {
			problems.leaveEdit = String(err);
		}
		if (fs.existsSync(gateDir)) {
			if (fs.readFileSync(txtFile, 'utf8') !== TXT_CONTENT) fs.writeFileSync(txtFile, TXT_CONTENT);
			if (fs.readFileSync(mdFile, 'utf8') !== MD_CONTENT) fs.writeFileSync(mdFile, MD_CONTENT);
		}
		if (Object.keys(problems).length > 0) report(REPORT, { gate: '48p-after-each', ...problems, dialogs: (await readGateRecord()).dialogs });
	});

	after(async () => {
		await restoreGateRecorder();
		fs.rmSync(gateDir, { recursive: true, force: true });
		for (const name of fs.readdirSync(startRoot)) {
			if (name.startsWith('req48p-')) fs.rmSync(path.join(startRoot, name), { recursive: true, force: true });
		}
	});

	it('gate p-1: long .txt scrolled half-way, a real double-click in the middle of a line → caret there (collapsed), scrollTop unchanged, typing goes in there', async () => {
		await openTxt();
		const scrollTop = await setViewerScrollTop(SCROLL_HALFWAY);
		const lineHeight = await measureLineHeight(VIEW_PRE);
		const point = await pickMidLinePoint(VIEW_PRE, 5, lineHeight);
		await clearSelection();

		const click = await realDoubleClick(point.x, point.y);
		await browser.waitUntil(async () => (await editorSnapshot()).editing, { timeout: 5_000, timeoutMsg: 'the double-click did not enter the editor' });
		await browser.pause(200);
		const after = await editorSnapshot();
		const typed = await typeText('X');
		const afterType = await editorSnapshot();
		await safeShot('req48p-gate1-txt-dblclick');
		report(REPORT, { gate: '48p-1-txt-dblclick', scrollTop, lineHeight, point, click, after, typed, afterTypeText: afterType.text?.slice(point.offset - 5, point.offset + 6), afterTypeCaret: afterType.selection.start });

		expect(scrollTop).toBeGreaterThan(0);
		expect(point.offset).toBeGreaterThan(0);
		expect(click.dblclicks).toBeGreaterThan(0);
		expect(after.editing).toBe(true);
		expect(after.activeIsEditor).toBe(true);
		expect(after.selection.inside).toBe(true);
		expect(after.selection.collapsed).toBe(true);
		expect(after.selection.start).toBe(point.offset);
		expect(Math.abs(after.scrollTop - scrollTop)).toBeLessThanOrEqual(1);
		expect(after.selection.rect).not.toBeNull();
		expect(after.selection.rect!.top).toBeGreaterThanOrEqual(after.visibleTop - 0.5);
		expect(after.selection.rect!.bottom).toBeLessThanOrEqual(after.innerHeight + 0.5);
		expect(typed).toBe(true);
		expect(afterType.text).toBe(TXT_CONTENT.slice(0, point.offset) + 'X' + TXT_CONTENT.slice(point.offset));
	});

	it('gate p-2: markdown paragraph, a real double-click in the middle → that block editable with a collapsed caret at the clicked character, scrollTop unchanged', async () => {
		await openMd();
		const p = await targetParagraphSelector();
		const scrollTop = await scrollElementBelowToolbar(p, 120);
		const r = await rectOf(p);
		if (!r) throw new Error('target paragraph not found');
		const y = r.top + r.height / 2;
		const point = await pickPointIn(
			p,
			[90, 70, 110, 50].map((dx) => ({ x: r.left + Math.min(dx, r.width * 0.4), y })),
		);
		await clearSelection();

		const click = await realDoubleClick(point.x, point.y);
		await browser.waitUntil(async () => (await selectionIn(p)).editable, { timeout: 5_000, timeoutMsg: 'the double-click did not make the paragraph editable' });
		await browser.pause(200);
		const after = await selectionIn(p);
		const scrollAfter = await viewerScrollTop();
		await safeShot('req48p-gate2-md-paragraph');
		report(REPORT, { gate: '48p-2-md-paragraph', scrollTop, point, click, after, scrollAfter });

		expect(point.offset).toBeGreaterThan(0);
		expect(click.dblclicks).toBeGreaterThan(0);
		expect(after.editable).toBe(true);
		expect(after.inside).toBe(true);
		expect(after.collapsed).toBe(true);
		expect(after.start).toBe(point.offset);
		expect(Math.abs(scrollAfter - scrollTop)).toBeLessThanOrEqual(1);
	});

	it('gate p-3: code block, a real double-click in the middle → plain text with a collapsed caret at the same character count, scrollTop unchanged', async () => {
		await openMd();
		const pre = await codePreSelector();
		const scrollTop = await scrollElementBelowToolbar(pre, 120);
		const r = await rectOf(pre);
		if (!r) throw new Error('code fence not found');
		// Somewhere inside the fence's lines (padding excluded by the mid-line check), a few characters in.
		const point = await pickPointIn(
			pre,
			[0.5, 0.35, 0.65, 0.25, 0.75].map((f) => ({ x: r.left + 60, y: r.top + r.height * f })),
		);
		await clearSelection();

		const click = await realDoubleClick(point.x, point.y);
		await browser.waitUntil(
			async () => browser.execute((sel) => document.querySelector(`${sel}[contenteditable="true"], ${sel} > code[contenteditable="true"]`) !== null, pre),
			{ timeout: 5_000, timeoutMsg: 'the double-click did not make the code block editable' },
		);
		await browser.pause(200);
		const editableSel = (await browser.execute((sel) => (document.querySelector(`${sel}[contenteditable="true"]`) ? sel : `${sel} > code`), pre)) as string;
		const after = await selectionIn(editableSel);
		const scrollAfter = await viewerScrollTop();
		await safeShot('req48p-gate3-md-code');
		report(REPORT, { gate: '48p-3-md-code', scrollTop, point, click, editableSel, after: { ...after, text: after.text }, scrollAfter });

		expect(point.offset).toBeGreaterThan(0);
		expect(click.dblclicks).toBeGreaterThan(0);
		expect(after.editable).toBe(true);
		expect(after.hasSpan).toBe(false);
		expect(after.text).toBe(CODE_BODY);
		expect(after.inside).toBe(true);
		expect(after.collapsed).toBe(true);
		expect(after.start).toBe(point.offset);
		expect(Math.abs(scrollAfter - scrollTop)).toBeLessThanOrEqual(1);
	});

	it('gate p-4: text, a selection in the view, Command + E → the same range in the editor, scrollTop unchanged', async () => {
		await openTxt();
		const scrollTop = await setViewerScrollTop(SCROLL_HALFWAY);
		const lineHeight = await measureLineHeight(VIEW_PRE);
		const point = await pickMidLinePoint(VIEW_PRE, 4, lineHeight);
		const start = point.offset;
		const end = point.offset + 5;
		expect(await placeSelection(VIEW_PRE, start, end)).toBe(true);

		await emitMenu('menu_edit');
		await browser.waitUntil(async () => (await editorSnapshot()).editing, { timeout: 5_000, timeoutMsg: 'menu_edit did not enter the editor' });
		await browser.pause(200);
		const after = await editorSnapshot();
		await safeShot('req48p-gate4-txt-cmd-e-selection');
		report(REPORT, { gate: '48p-4-txt-cmd-e-selection', scrollTop, range: [start, end], after });

		expect(after.selection.inside).toBe(true);
		expect(after.selection.collapsed).toBe(false);
		expect([after.selection.start, after.selection.end]).toEqual([start, end]);
		expect(Math.abs(after.scrollTop - scrollTop)).toBeLessThanOrEqual(1);
		expect(after.activeIsEditor).toBe(true);
	});

	it('gate p-5: text, no selection, scrolled so a line top sits at the toolbar bottom, Command + E → screen does not move, caret at the start of that line', async () => {
		await openTxt();
		const lineHeight = await measureLineHeight(VIEW_PRE);
		const cur = await setViewerScrollTop(SCROLL_HALFWAY);
		const pre = await rectOf(VIEW_PRE);
		const vt = await visibleTop();
		if (!pre) throw new Error('view pre not found');
		// Line k's top exactly at the toolbar's bottom (measured from the line's own
		// Range rect, not the `<pre>` box, so padding does not shift it): no
		// partially visible line above it.
		const k = 60;
		const wanted = Math.round((await lineTopAt(VIEW_PRE, txtLineStart(k))) + cur - vt);
		const scrollTop = await setViewerScrollTop(wanted);
		const alignError = (await lineTopAt(VIEW_PRE, txtLineStart(k))) - vt;
		const probe = await offsetAtPoint(VIEW_PRE, pre.left + 2, vt + 1);
		const expectedLineStart = txtLineStart(k);
		await clearSelection();

		await emitMenu('menu_edit');
		await browser.waitUntil(async () => (await editorSnapshot()).editing, { timeout: 5_000, timeoutMsg: 'menu_edit did not enter the editor' });
		await browser.pause(200);
		const after = await editorSnapshot();
		await safeShot('req48p-gate5-txt-cmd-e-no-selection');
		report(REPORT, { gate: '48p-5-txt-cmd-e-no-selection', lineHeight, k, wanted, scrollTop, alignError, probe, expectedLineStart, probeLineStart: TXT_CONTENT.lastIndexOf('\n', Math.max(0, probe.offset - 1)) + 1, after });

		expect(scrollTop).toBeGreaterThan(0);
		expect(Math.abs(alignError)).toBeLessThanOrEqual(0.5);
		// The point just under the toolbar is on line k (the alignment held).
		expect(TXT_CONTENT.lastIndexOf('\n', Math.max(0, probe.offset - 1)) + 1).toBe(expectedLineStart);
		expect(Math.abs(after.scrollTop - scrollTop)).toBeLessThanOrEqual(1);
		expect(after.selection.inside).toBe(true);
		expect(after.selection.collapsed).toBe(true);
		expect(after.selection.start).toBe(expectedLineStart);
		expect(after.activeIsEditor).toBe(true);
	});

	it('gate p-6: markdown, a selection in a paragraph, Command + E → source editor with the caret at that paragraph\'s source start, visible', async () => {
		await openMd();
		const p = await targetParagraphSelector();
		const expected = await sourceStartOf(p);
		await setViewerScrollTop(0);
		expect(await placeSelection(p, 7, 16)).toBe(true);

		await emitMenu('menu_edit');
		await browser.waitUntil(async () => (await editorSnapshot()).editing, { timeout: 5_000, timeoutMsg: 'menu_edit did not enter the source editor' });
		await browser.pause(200);
		const after = await editorSnapshot();
		await safeShot('req48p-gate6-md-cmd-e-selection');
		report(REPORT, { gate: '48p-6-md-cmd-e-selection', expected, after });

		expect(after.text).toBe(MD_CONTENT);
		expect(after.selection.inside).toBe(true);
		expect(after.selection.collapsed).toBe(true);
		expect(after.selection.start).toBe(expected);
		expect(after.selection.rect).not.toBeNull();
		expect(after.selection.rect!.top).toBeGreaterThanOrEqual(after.visibleTop - 0.5);
		expect(after.selection.rect!.bottom).toBeLessThanOrEqual(after.innerHeight + 0.5);
	});

	it('gate p-7: markdown, no selection, scrolled so a known paragraph is the first visible block, Command + E → caret at its source start, that line in the upper half of the view', async () => {
		await openMd();
		const p = await targetParagraphSelector();
		const expected = await sourceStartOf(p);
		const scrollTop = await scrollElementBelowToolbar(p, 0);
		const first = await firstVisibleBlock();
		await clearSelection();

		await emitMenu('menu_edit');
		await browser.waitUntil(async () => (await editorSnapshot()).editing, { timeout: 5_000, timeoutMsg: 'menu_edit did not enter the source editor' });
		await browser.pause(200);
		const after = await editorSnapshot();
		const upperHalfBottom = after.visibleTop + (after.innerHeight - after.visibleTop) / 2;
		await safeShot('req48p-gate7-md-cmd-e-no-selection');
		report(REPORT, { gate: '48p-7-md-cmd-e-no-selection', scrollTop, first, expected, after, upperHalfBottom });

		expect(first.sourceStart).toBe(expected);
		expect(after.selection.inside).toBe(true);
		expect(after.selection.collapsed).toBe(true);
		expect(after.selection.start).toBe(expected);
		expect(after.selection.rect).not.toBeNull();
		expect(after.selection.rect!.top).toBeGreaterThanOrEqual(after.visibleTop - 0.5);
		expect(after.selection.rect!.top).toBeLessThan(upperHalfBottom);
	});
});
