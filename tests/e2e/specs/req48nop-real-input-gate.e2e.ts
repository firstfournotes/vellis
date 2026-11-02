import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
	assertIpcInterceptionWorks,
	clearCapturedIpc,
	clickExplorerRow,
	emitMenu,
	installGateRecorder,
	readCapturedIpc,
	readGateRecord,
	report,
	restoreGateRecorder,
	setIpcCapture,
	shot,
	SHOTS_DIR,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

/**
 * Requirement #48 追補n・追補o・追補p human gates (Issues #765, #766, #773), driven
 * with REAL input on a real screen — the parts the CI specs
 * (`req48n-source-newline-gate`, `req48p-edit-caret-gate`) replace with
 * synthetic events or `execCommand`, because WebDriver's actions never reached
 * WebKit as a real mouse (req48p: `route: synthetic`) and the native menu is
 * out of its reach:
 *
 *  - n-1  the Return that confirms a Japanese IME conversion inserts no line
 *         break (Kotoeri Romaji: `a` `i` → Return → 「あい」 and nothing else;
 *         Return again → one `\n`)
 *  - n-2  a real Command + Z (through the Edit menu) takes back a Return and a
 *         multi-line paste
 *  - n-3  a real Command + V pastes CRLF / CR / LF lines as `\n` lines; a real
 *         Command + S writes them to disk
 *  - o-1  the unsaved-changes confirmation is ONE sheet (AXSheet on the
 *         window) with Save / Don't Save / Cancel and the contract's text;
 *         Esc closes it and nothing happens (edit, file and document stay)
 *  - o-2  Return = Save: the file is written, then the other file opens
 *  - o-3  Command + D = Don't Save: the edit is dropped, the other file opens
 *         (no second sheet in any of the three)
 *  - p-1  a long .txt scrolled ~1000 px, a real double-click in the middle of a
 *         line → editor with a collapsed caret at that character, `scrollTop`
 *         unchanged, a real `X` typed goes in there
 *  - p-2  the same on a markdown paragraph (block edit)
 *  - p-3  the same on a code block (Shiki spans replaced, same character count)
 *  - p-4  the html edit surface (Shadow DOM): a real double-click on a
 *         paragraph — OBSERVED ONLY (Issue #774 expects the block's start);
 *         where the caret landed is recorded, nothing about it is asserted
 *
 * Runs only under `scripts/gate-device/run-gate-spec.sh req48nop`
 * (VELLIS_GATE_DEVICE=1), on a copy of the webdriver build in a throwaway home.
 * WebDriver makes and reads the page state; the real input goes through
 * `scripts/gate-device/realinput.swift` as a child process, which
 *  - sends only to the pid of the build under test (REALINPUT_EXPECT_EXE /
 *    AXTOOL_EXPECT_EXE = the binary's path, checked against the pid's exe)
 *  - refuses unless that pid is frontmost with a focused (key) window
 *  - posts keys and clicks with `CGEvent.postToPid` (route "pid"); the HID
 *    event tap (route "hid") is tried for clicks only when the "pid" route
 *    did not reach the page, and realinput then insists the topmost window at
 *    the point is the test app's
 *  - saves and restores the user's input source and clipboard (also in
 *    `after`, also when a gate failed half-way)
 *
 * Screen coordinates: the element's viewport rect (WebDriver) + the window's
 * frame (`axtool cgwins`) + the offset of the WKWebView inside the window,
 * which is first guessed (window height − innerHeight) and then MEASURED with
 * one real click: the `mousedown` the page records tells the client point the
 * click landed on, the difference is the offset, and `elementFromPoint` at the
 * recorded point must be the event's target.
 *
 * Everything read is kept in `$VELLIS_GATE_SHOTS/req48nop-report.jsonl`
 * (`[gate]` lines in the log).
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const realinput = process.env.VELLIS_GATE_REALINPUT ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';
const REPORT = 'req48nop-report.jsonl';

const newlineTxt = path.join(root, 'newline.txt');
const otherMd = path.join(root, 'other.md');
const longTxt = path.join(root, 'long.txt');
const longMd = path.join(root, 'long.md');
const pageHtml = path.join(root, 'page.html');

/** What run-gate-spec.sh wrote (checked in `before`). 'first' = 0..5, 'first line' = 0..10. */
const ORIGINAL = 'first line\nsecond line\n';
const MID_FIRST = 5;
const END_FIRST_LINE = 10;
const OTHER_HEADING = 'Other';
const UNSAVED_TITLE = 'Unsaved Changes';
const UNSAVED_SAVE_MESSAGE = 'Do you want to save your changes before continuing?';
const SAVE = 'Save';
const DONT_SAVE = "Don't Save";
const CANCEL = 'Cancel';

const KOTOERI_ROMAJI = 'com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese';
const ABC = 'com.apple.keylayout.ABC';

/** macOS virtual keycodes (US ANSI). */
const KEY = { return: 36, escape: 53, z: 6, v: 9, s: 1, d: 2 } as const;

const VIEWER = 'article.viewer';
const TOOLBAR = `${VIEWER} header.viewer-toolbar`;
const BODY = `${VIEWER} .markdown-body`;
const VIEW_PRE = `${BODY} pre.vellis-plaintext:not([contenteditable="true"])`;
const EDITOR = `${BODY} pre.vellis-plaintext[contenteditable="true"]`;
const HTML_SURFACE = '[data-testid="html-edit-surface"]';
const SCROLL_HALFWAY = 1000;
const MESSAGE_IPC = 'plugin:dialog|message';

const uri = (p: string) => `file://${p}`;

// --- the tools (pid-pinned child processes) -------------------------------------

function tool(exe: string, args: string[]): Record<string, unknown>[] {
	let out: string;
	try {
		out = execFileSync(exe, args, {
			encoding: 'utf8',
			timeout: 30_000,
			env: { ...process.env, AXTOOL_EXPECT_EXE: bin, REALINPUT_EXPECT_EXE: bin },
		});
	} catch (e) {
		const err = e as { stderr?: string; message?: string };
		throw new Error(`${path.basename(exe)} ${args.join(' ')} failed: ${err.stderr?.trim() || err.message}`);
	}
	return out
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const ax = (args: string[]) => tool(axtool, args);
const ri = (args: string[]) => tool(realinput, args);

/** The one process running the build under test. */
function appPid(): number {
	const pids = ax(['pids-of-exe', bin]).map((r) => r.pid as number);
	if (pids.length !== 1) throw new Error(`expected one app process of ${bin}, found ${JSON.stringify(pids)}`);
	return pids[0]!;
}

interface FrontInfo {
	ok: boolean;
	frontmost: boolean;
	frontmost_pid: number;
	focused_window: { title: string; document: string; main: boolean; sheets: number; frame: { x: number; y: number; w: number; h: number } } | null;
}

function front(pid: number): FrontInfo {
	return ri(['front', String(pid)])[0] as unknown as FrontInfo;
}

/** Bring the test app to the front (by pid) and insist it is, with a key window. */
async function ensureFront(pid: number): Promise<FrontInfo> {
	let f = front(pid);
	if (!f.ok) {
		ax(['raise', String(pid), '0']);
		const deadline = Date.now() + 5_000;
		while (!f.ok && Date.now() < deadline) {
			await browser.pause(200);
			f = front(pid);
		}
	}
	if (!f.ok) throw new Error(`the test app (pid ${pid}) is not frontmost with a focused window: ${JSON.stringify(f)}`);
	return f;
}

/**
 * Do not interleave with the user's own typing or mousing: wait until the HID
 * idle time is at least `min` seconds. Caveat (seen 2026-10-29): the events this
 * spec posts itself — the "hid" route for sure, and in practice the keys too —
 * reset HIDIdleTime, so while the spec runs this cannot tell the user's input
 * from its own. It only spaces the gestures out; the real check is the
 * runner's, before the run starts (HID idle ≥ 120 s, the user away).
 */
async function waitForIdle(min = 0.8, timeout = 30_000): Promise<number> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const idle = ri(['idle'])[0]!.idle_seconds as number;
		if (idle >= min) return idle;
		if (Date.now() >= deadline) throw new Error(`the user kept using the machine (HID idle ${idle}s); not sending input`);
		await browser.pause(300);
	}
}

interface SheetRow {
	window_index: number;
	window_title: string;
	role: string;
	buttons: Array<{ title: string; enabled: boolean }>;
	texts: string[];
	default_button: string;
	cancel_button: string;
}

function sheets(pid: number): SheetRow[] {
	return ri(['sheets', String(pid)]) as unknown as SheetRow[];
}

async function waitForSheets(pid: number, count: number, timeout: number): Promise<SheetRow[]> {
	const deadline = Date.now() + timeout;
	let rows = sheets(pid);
	while (rows.length !== count && Date.now() < deadline) {
		await browser.pause(200);
		rows = sheets(pid);
	}
	if (rows.length !== count) throw new Error(`expected ${count} sheet(s), have ${rows.length}: ${JSON.stringify(rows)}`);
	return rows;
}

// --- page recorders --------------------------------------------------------------

interface KeyRec {
	key: string;
	keyCode: number;
	isComposing: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	/** Read at the window (bubble) — after the editor's handler ran. */
	defaultPrevented: boolean | null;
	targetEditable: boolean;
}

interface MouseRec {
	type: string;
	clientX: number;
	clientY: number;
	detail: number;
	button: number;
	target: string;
	/** `document.elementFromPoint(clientX, clientY)` is the event's target. */
	sameAsElementFromPoint: boolean;
}

interface PageRecord {
	keys: KeyRec[];
	compositions: Array<{ type: string; data: string }>;
	inputs: Array<{ inputType: string; data: string | null }>;
	mouse: MouseRec[];
}

async function installPageRecorder(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __ri?: PageRecord & { installed: true } };
		if (w.__ri) return;
		const rec: PageRecord & { installed: true } = { installed: true, keys: [], compositions: [], inputs: [], mouse: [] };
		w.__ri = rec;
		const describe = (t: EventTarget | null): string => {
			const el = t instanceof Element ? t : t instanceof Node ? t.parentElement : null;
			if (!el) return String(t);
			const cls = typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').filter(Boolean).join('.') : '';
			return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}`;
		};
		document.addEventListener(
			'keydown',
			(e) => {
				const t = e.target as HTMLElement | null;
				rec.keys.push({
					key: e.key,
					keyCode: e.keyCode,
					isComposing: e.isComposing,
					metaKey: e.metaKey,
					shiftKey: e.shiftKey,
					defaultPrevented: null,
					targetEditable: !!t && t.isContentEditable,
				});
			},
			true,
		);
		window.addEventListener('keydown', (e) => {
			const last = rec.keys[rec.keys.length - 1];
			if (last && last.key === e.key) last.defaultPrevented = e.defaultPrevented;
		});
		for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
			document.addEventListener(type, (e) => rec.compositions.push({ type, data: (e as CompositionEvent).data }), true);
		}
		document.addEventListener('input', (e) => rec.inputs.push({ inputType: (e as InputEvent).inputType, data: (e as InputEvent).data }), true);
		for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
			document.addEventListener(
				type,
				(e) => {
					const m = e as MouseEvent;
					const at = document.elementFromPoint(m.clientX, m.clientY);
					rec.mouse.push({
						type,
						clientX: m.clientX,
						clientY: m.clientY,
						detail: m.detail,
						button: m.button,
						target: describe(m.target),
						sameAsElementFromPoint: at === m.target,
					});
				},
				true,
			);
		}
	});
}

async function readPageRecord(): Promise<PageRecord> {
	return browser.execute(() => {
		const r = (window as unknown as { __ri?: PageRecord }).__ri;
		const empty: PageRecord = { keys: [], compositions: [], inputs: [], mouse: [] };
		return r ? (JSON.parse(JSON.stringify({ keys: r.keys, compositions: r.compositions, inputs: r.inputs, mouse: r.mouse })) as PageRecord) : empty;
	});
}

async function clearPageRecord(): Promise<void> {
	await browser.execute(() => {
		const r = (window as unknown as { __ri?: PageRecord }).__ri;
		if (!r) return;
		r.keys = [];
		r.compositions = [];
		r.inputs = [];
		r.mouse = [];
	});
}

async function clearLogs(): Promise<void> {
	await browser.execute(() => {
		const r = (window as unknown as { __gate?: { ipc: string[]; dialogs: string[] } }).__gate;
		if (r) {
			r.ipc = [];
			r.dialogs = [];
		}
	});
	await clearCapturedIpc();
	await clearPageRecord();
}

async function messageIpcCount(): Promise<number> {
	return (await readGateRecord()).ipc.filter((c) => c === MESSAGE_IPC).length;
}

// --- page state --------------------------------------------------------------------

interface SelectionShape {
	inside: boolean;
	collapsed: boolean;
	start: number;
	end: number;
	rect: { top: number; bottom: number; left: number } | null;
}

interface EditorSnapshot {
	editing: boolean;
	text: string | null;
	children: number;
	hasDivOrBr: boolean;
	/** Collapsed caret as a character offset of `textContent` (-1 otherwise). */
	caret: number;
	lf: number;
	selection: SelectionShape;
	scrollTop: number;
	visibleTop: number;
	innerHeight: number;
	activeIsEditor: boolean;
}

/** The source editor (or, when closed, the view `<pre>`) as the page sees it. */
async function editorSnapshot(): Promise<EditorSnapshot> {
	return browser.execute(
		(editorSel, bodySel, viewerSel, toolbarSel) => {
			const editor = document.querySelector<HTMLElement>(editorSel);
			const pre = editor ?? document.querySelector<HTMLElement>(`${bodySel} pre.vellis-plaintext`);
			const viewer = document.querySelector<HTMLElement>(viewerSel);
			const toolbar = document.querySelector<HTMLElement>(toolbarSel);
			const sel = window.getSelection();
			const shape: SelectionShape = { inside: false, collapsed: false, start: -1, end: -1, rect: null };
			let caret = -1;
			if (pre && sel && sel.rangeCount > 0) {
				const range = sel.getRangeAt(0);
				const inside = pre.contains(range.startContainer) && pre.contains(range.endContainer);
				const offsetOf = (node: Node, offset: number) => {
					const probe = document.createRange();
					probe.selectNodeContents(pre);
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
				if (inside && range.collapsed) caret = shape.start;
			}
			const text = pre?.textContent ?? null;
			return {
				editing: editor !== null,
				text,
				children: pre?.childElementCount ?? -1,
				hasDivOrBr: pre?.querySelector('div, br') !== null,
				caret,
				lf: text === null ? -1 : (text.match(/\n/g) ?? []).length,
				selection: shape,
				scrollTop: viewer?.scrollTop ?? -1,
				visibleTop: toolbar?.getBoundingClientRect().bottom ?? 0,
				innerHeight: window.innerHeight,
				activeIsEditor: editor !== null && document.activeElement === editor,
			};
		},
		EDITOR,
		BODY,
		VIEWER,
		TOOLBAR,
	);
}

/** Put the caret (or a selection) at character offsets of `selector`'s `textContent`. */
async function placeSelection(selector: string, start: number, end: number = start, focus = true): Promise<boolean> {
	return browser.execute(
		(sel0, s, e, f) => {
			const el = document.querySelector<HTMLElement>(sel0);
			if (!el) return false;
			if (f) el.focus();
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
		focus,
	);
}

async function placeCaret(start: number, end: number = start): Promise<void> {
	if (!(await placeSelection(EDITOR, start, end))) throw new Error(`could not place the caret at ${start}..${end} (is the editor open?)`);
}

async function clearSelection(): Promise<void> {
	await browser.execute(() => window.getSelection()?.removeAllRanges());
}

async function rectOf(selector: string): Promise<{ top: number; bottom: number; left: number; right: number; width: number; height: number } | null> {
	return browser.execute((sel) => {
		const el = document.querySelector<HTMLElement>(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
	}, selector);
}

async function viewerScrollTop(): Promise<number> {
	return browser.execute((sel) => document.querySelector<HTMLElement>(sel)?.scrollTop ?? -1, VIEWER);
}

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
	await browser.pause(150);
	return got;
}

async function visibleTop(): Promise<number> {
	return browser.execute((sel) => document.querySelector<HTMLElement>(sel)?.getBoundingClientRect().bottom ?? 0, TOOLBAR);
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

interface Point {
	x: number;
	y: number;
	/** Character offset `caretRangeFromPoint` reports inside `selector` (-1 when outside). */
	offset: number;
	landed: string | null;
}

/** What WebKit's `caretRangeFromPoint` says for the viewport point (x, y), inside `selector`. */
async function offsetAtPoint(selector: string, x: number, y: number): Promise<Point> {
	return browser.execute(
		(sel0, px, py) => {
			const el = document.querySelector<HTMLElement>(sel0);
			const range = document.caretRangeFromPoint(px, py);
			if (!el || !range) return { x: px, y: py, offset: -1, landed: null };
			const node = range.startContainer;
			const landedEl = node.nodeType === 1 ? (node as Element) : node.parentElement;
			const landed = landedEl ? `${landedEl.tagName.toLowerCase()}${landedEl.className && typeof landedEl.className === 'string' ? '.' + landedEl.className.split(' ').join('.') : ''}` : null;
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

type MidPoint = Point & { charBefore: string; charAfter: string };

/** The first candidate that lands on a character which is neither first nor next to a line break. */
async function pickPointIn(selector: string, candidates: Array<{ x: number; y: number }>): Promise<MidPoint> {
	const text = await browser.execute((sel) => document.querySelector<HTMLElement>(sel)?.textContent ?? '', selector);
	const tried: Point[] = [];
	for (const c of candidates) {
		const p = await offsetAtPoint(selector, c.x, c.y);
		tried.push(p);
		const charBefore = p.offset > 0 ? text[p.offset - 1]! : '';
		const charAfter = p.offset >= 0 ? (text[p.offset] ?? '') : '';
		if (p.offset > 0 && charBefore !== '\n' && charAfter !== '\n' && charAfter !== '' && charAfter !== ' ' && charBefore !== ' ') {
			return { ...p, charBefore, charAfter };
		}
	}
	throw new Error(`could not find a mid-line point in ${selector}: ${JSON.stringify(tried)}`);
}

/** A point in the middle of a visible line of the view `<pre>`, `linesDown` lines under the toolbar. */
async function pickMidLinePoint(preSelector: string, linesDown: number, lineHeight: number): Promise<MidPoint> {
	const pre = await rectOf(preSelector);
	const vt = await visibleTop();
	if (!pre) throw new Error('view pre not found');
	const y = vt + linesDown * lineHeight + lineHeight / 2;
	return pickPointIn(
		preSelector,
		Array.from({ length: 8 }, (_, i) => ({ x: pre.left + 70 + i * 17, y })),
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

// --- real input ------------------------------------------------------------------------

interface Screen {
	pid: number;
	frame: { x: number; y: number; w: number; h: number; number: number };
	/** Offset of the WKWebView's origin inside the window (measured). */
	dx: number;
	dy: number;
	route: 'pid' | 'hid';
}

let screen: Screen | null = null;

function toScreen(clientX: number, clientY: number): { x: number; y: number } {
	if (!screen) throw new Error('screen not calibrated');
	return { x: screen.frame.x + screen.dx + clientX, y: screen.frame.y + screen.dy + clientY };
}

/** Before any input: the app is in front with its key window, the user is idle. */
async function readyToSend(): Promise<FrontInfo> {
	if (!screen) throw new Error('screen not calibrated');
	const f = await ensureFront(screen.pid);
	await waitForIdle();
	return f;
}

type KeyRoute = 'pid' | 'hid';

/**
 * Keys go through `postToPid` ("pid") unless a gate asks for the HID event tap
 * ("hid"): postToPid keys carry their character and bypass the frontmost app's
 * input method, so the IME gate (n-1) must use "hid" — raw keycodes, which
 * realinput allows only while the test app is frontmost with a focused window.
 */
async function sendKey(keycode: number, mods: string[] = [], route: KeyRoute = 'pid'): Promise<Record<string, unknown>> {
	await readyToSend();
	const out = ri(['key', String(screen!.pid), String(keycode), ...mods, route])[0]!;
	await browser.pause(250);
	return out;
}

async function sendText(text: string, route: KeyRoute = 'pid'): Promise<Record<string, unknown>> {
	await readyToSend();
	const out = ri(['text', String(screen!.pid), text, route])[0]!;
	await browser.pause(250 + 40 * text.length);
	return out;
}

interface ClickOutcome {
	route: 'pid' | 'hid';
	attempts: Array<{ route: string; facts: Record<string, unknown>; mousedowns: number; dblclicks: number }>;
	mouse: MouseRec[];
}

/**
 * A real click (or double-click) at a viewport point. The "pid" route first;
 * when the page saw no mousedown (or no dblclick), the "hid" route — which
 * realinput allows only while the topmost window at that point is the test
 * app's. The route that worked is remembered for the next gesture.
 */
async function realClick(clientX: number, clientY: number, double: boolean, routes?: Array<'pid' | 'hid'>): Promise<ClickOutcome> {
	const s = toScreen(clientX, clientY);
	const cmd = double ? 'dblclick' : 'click';
	const attempts: ClickOutcome['attempts'] = [];
	for (const route of routes ?? (screen!.route === 'hid' ? ['hid'] : ['pid', 'hid'])) {
		await readyToSend();
		await clearPageRecord();
		const facts = ri([cmd, String(screen!.pid), String(Math.round(s.x)), String(Math.round(s.y)), route])[0]!;
		await browser.pause(350);
		const rec = await readPageRecord();
		const mousedowns = rec.mouse.filter((m) => m.type === 'mousedown').length;
		const dblclicks = rec.mouse.filter((m) => m.type === 'dblclick').length;
		attempts.push({ route, facts, mousedowns, dblclicks });
		if (mousedowns > 0 && (!double || dblclicks > 0)) {
			screen!.route = route;
			return { route, attempts, mouse: rec.mouse };
		}
		// A half-delivered gesture may have left a selection; drop it before the next route.
		await clearSelection();
	}
	throw new Error(`no route delivered the ${cmd} at client (${clientX}, ${clientY}) = screen (${s.x}, ${s.y}): ${JSON.stringify(attempts)}`);
}

/**
 * Find the window and measure the WKWebView's offset in it with one real click
 * on the view `<pre>` of newline.txt (a single click there only places a caret
 * in the view). The guess is window height − innerHeight (the title bar).
 */
async function calibrate(): Promise<void> {
	const pid = appPid();
	await ensureFront(pid);
	const wins = ax(['cgwins', String(pid)]).filter((w) => w.onscreen === true);
	if (wins.length === 0) throw new Error('the test app has no on-screen window');
	const w = wins.sort((a, b) => (b.w as number) * (b.h as number) - (a.w as number) * (a.h as number))[0]!;
	const inner = await browser.execute(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio }));
	const guess = { dx: Math.round(((w.w as number) - inner.innerWidth) / 2), dy: (w.h as number) - inner.innerHeight };
	screen = { pid, frame: { x: w.x as number, y: w.y as number, w: w.w as number, h: w.h as number, number: w.number as number }, dx: guess.dx, dy: guess.dy, route: 'pid' };

	await openNewlineTxt();
	const pre = await rectOf(VIEW_PRE);
	if (!pre) throw new Error('view pre not found for the calibration click');
	const client = { x: Math.round(pre.left + 30), y: Math.round(pre.top + 10) };
	const click = await realClick(client.x, client.y, false);
	const md = click.mouse.find((m) => m.type === 'mousedown');
	if (!md) throw new Error('calibration click: no mousedown recorded');
	const s = toScreen(client.x, client.y);
	const measured = { dx: Math.round(s.x) - screen.frame.x - md.clientX, dy: Math.round(s.y) - screen.frame.y - md.clientY };
	const drift = { dx: measured.dx - guess.dx, dy: measured.dy - guess.dy };
	screen.dx = measured.dx;
	screen.dy = measured.dy;
	await clearSelection();
	report(REPORT, { gate: '48nop-calibration', pid, window: w, inner, guess, measured, drift, route: click.route, mousedown: md, attempts: click.attempts });
	expect(md.target).toContain('pre.vellis-plaintext');
	expect(md.sameAsElementFromPoint).toBe(true);
	// A drift beyond a few px would mean the click did not land where the arithmetic says.
	expect(Math.abs(drift.dx)).toBeLessThanOrEqual(4);
	expect(Math.abs(drift.dy)).toBeLessThanOrEqual(4);
}

// --- input source / clipboard of the user -------------------------------------------

let savedInputSource: string | null = null;
let savedPasteboard: string | null = null;

function currentInputSource(): string {
	return ri(['inputsource', 'get'])[0]!.id as string;
}

function setInputSource(id: string): Record<string, unknown> {
	const out = ri(['inputsource', 'set', id])[0]!;
	const now = (out.now as { id: string }).id;
	if (now !== id) throw new Error(`input source did not switch to ${id}: ${JSON.stringify(out)}`);
	return out;
}

/**
 * Put the user's input source and clipboard back. The saved clipboard file
 * holds the clipboard's contents (and the input source id), so it is deleted
 * once both are restored; when this `after` never runs (wdio killed), the
 * trap of run-gate-spec.sh restores from the same file and deletes it.
 */
function restoreUserState(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	let ok = true;
	if (savedInputSource) {
		try {
			out.inputSource = setInputSource(savedInputSource);
		} catch (e) {
			ok = false;
			out.inputSourceError = String(e);
		}
	}
	if (savedPasteboard) {
		try {
			const r = ri(['pasteboard', 'restore', savedPasteboard])[0]!;
			out.pasteboard = r;
			if (r.ok !== true) ok = false;
		} catch (e) {
			ok = false;
			out.pasteboardError = String(e);
		}
		if (ok) {
			fs.rmSync(savedPasteboard, { force: true });
			out.savedFileRemoved = true;
		}
	}
	return out;
}

// --- documents -----------------------------------------------------------------------------

async function waitForView(expectedText: string, timeoutMsg: string): Promise<void> {
	await browser.waitUntil(
		async () => {
			const v = await editorSnapshot();
			return !v.editing && v.text === expectedText;
		},
		{ timeout: 15_000, timeoutMsg },
	);
}

async function openNewlineTxt(expectedText: string = fs.readFileSync(newlineTxt, 'utf8')): Promise<void> {
	await clickExplorerRow(uri(newlineTxt));
	await waitForView(expectedText, `newline.txt did not open in the plain-text view (now: ${JSON.stringify(await editorSnapshot())})`);
}

async function otherMdShown(): Promise<boolean> {
	return browser.execute(
		(body, heading) => document.querySelector(`${body} pre.vellis-plaintext`) === null && Array.from(document.querySelectorAll(`${body} h1`)).some((h) => h.textContent === heading),
		BODY,
		OTHER_HEADING,
	);
}

async function waitForOtherMd(): Promise<void> {
	await browser.waitUntil(otherMdShown, { timeout: 15_000, timeoutMsg: 'other.md did not open' });
}

/** Open newline.txt and enter the editor with the Edit menu event (Command + E — WebDriver sets the state). */
async function openNewlineTxtAndEnterEditor(): Promise<void> {
	await openNewlineTxt();
	await emitMenu('menu_edit');
	await browser.waitUntil(async () => (await editorSnapshot()).editing, { timeout: 5_000, timeoutMsg: 'menu_edit did not enter the editor' });
	const v = await editorSnapshot();
	// 追補r (Issue #767): the editor holds "source + one `\n`" (the sentinel); the buffer is the text without it.
	expect(v.text).toBe(ORIGINAL + '\n');
	expect(v.children).toBe(0);
}

/** Wait for the file on disk to be `expected`. */
async function waitForDisk(file: string, expected: string): Promise<void> {
	await browser.waitUntil(async () => fs.readFileSync(file, 'utf8') === expected, {
		timeout: 10_000,
		timeoutMsg: `${path.basename(file)} on disk is ${JSON.stringify(fs.readFileSync(file, 'utf8'))}, not ${JSON.stringify(expected)}`,
	});
}

function diskBytes(file: string): { text: string; lf: number; cr: number } {
	const bytes = fs.readFileSync(file);
	let lf = 0;
	let cr = 0;
	for (const b of bytes) {
		if (b === 0x0a) lf++;
		if (b === 0x0d) cr++;
	}
	return { text: bytes.toString('utf8'), lf, cr };
}

/**
 * Leave whatever edit is open without a dialog: discard a grabbed block
 * (markdown or html surface) with an Escape keydown, put the source editor's
 * text back to the file on disk (not dirty then) and press Done Editing.
 */
async function leaveEdit(file: string): Promise<void> {
	const onDisk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
	await browser.execute(
		(editorSel, surfaceSel, text) => {
			const esc = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true });
			const block = document.querySelector<HTMLElement>('.markdown-body [contenteditable="true"]:not(pre.vellis-plaintext)');
			if (block) block.dispatchEvent(esc());
			const shadowBlock = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');
			if (shadowBlock) shadowBlock.dispatchEvent(esc());
			const pre = document.querySelector<HTMLElement>(editorSel);
			if (pre && pre.textContent !== text) {
				pre.textContent = text;
				pre.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
			}
		},
		EDITOR,
		HTML_SURFACE,
		// 追補r: write the sentinel too, so the buffer (text minus one `\n`) equals the disk.
		onDisk + '\n',
	);
	await browser.pause(150);
	await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="edit-done"]')?.click());
	await browser.waitUntil(
		async () =>
			browser.execute(
				(surfaceSel) =>
					document.querySelector('[contenteditable="true"]') === null &&
					document.querySelector('[data-testid="edit-done"]') === null &&
					document.querySelector(surfaceSel) === null,
				HTML_SURFACE,
			),
		{ timeout: 5_000, timeoutMsg: 'could not leave the editor' },
	);
}

/** Done Editing with nothing dirty: no `plugin:dialog|message` may be sent. */
async function leaveEditorExpectingNoAsk(): Promise<{ left: boolean; asks: number }> {
	await clearLogs();
	await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="edit-done"]')?.click());
	let left = false;
	try {
		await browser.waitUntil(async () => !(await editorSnapshot()).editing, { timeout: 5_000 });
		left = true;
	} catch {
		left = false;
	}
	return { left, asks: await messageIpcCount() };
}

async function safeShot(name: string): Promise<string | null> {
	try {
		return await shot(name);
	} catch (e) {
		report(REPORT, { gate: 'shot-failed', name, error: String(e) });
		return null;
	}
}

/** Edit newline.txt (really typed) so the document is dirty: 'first line edited\nsecond line\n'. */
const EDITED = 'first line edited\nsecond line\n';
async function makeDirtyByTyping(): Promise<EditorSnapshot> {
	await openNewlineTxtAndEnterEditor();
	await placeCaret(END_FIRST_LINE);
	await sendText(' edited');
	await browser.waitUntil(async () => (await editorSnapshot()).text === EDITED + '\n' /* 追補r: + sentinel */, {
		timeout: 5_000,
		timeoutMsg: `typing did not produce the edit (now: ${JSON.stringify((await editorSnapshot()).text)})`,
	});
	return editorSnapshot();
}

/** Click other.md in the Explorer (WebDriver) and wait for the one sheet; read it. */
async function triggerUnsavedSheet(): Promise<{ sheet: SheetRow; all: SheetRow[]; front: FrontInfo; asks: number }> {
	await clearLogs();
	await clickExplorerRow(uri(otherMd));
	const all = await waitForSheets(screen!.pid, 1, 10_000);
	await browser.pause(300);
	const f = front(screen!.pid);
	return { sheet: all[0]!, all, front: f, asks: await messageIpcCount() };
}

function sheetShape(s: SheetRow) {
	return {
		role: s.role,
		buttons: s.buttons.map((b) => b.title),
		buttonsEnabled: s.buttons.every((b) => b.enabled),
		hasMessage: s.texts.includes(UNSAVED_SAVE_MESSAGE),
		hasTitle: s.texts.includes(UNSAVED_TITLE),
		texts: s.texts,
		defaultButton: s.default_button,
		cancelButton: s.cancel_button,
	};
}

/** After a sheet was answered: no second sheet within 1.5 s, and only the one `message` IPC. */
async function expectNoSecondSheet(): Promise<{ sheetsAfter: number; asksAfter: number }> {
	await browser.pause(1_500);
	return { sheetsAfter: sheets(screen!.pid).length, asksAfter: await messageIpcCount() };
}

// --- long fixtures (read from disk: run-gate-spec.sh wrote them) -------------------------

const txtContent = () => fs.readFileSync(longTxt, 'utf8');
const mdContent = () => fs.readFileSync(longMd, 'utf8');
const TARGET_PARAGRAPH_PREFIX = 'Target paragraph';

function codeBody(): string {
	const m = /```javascript\n([\s\S]*?)\n```/.exec(mdContent());
	if (!m) throw new Error('long.md has no ```javascript fence');
	return m[1]!;
}

async function openLongTxt(): Promise<void> {
	await clickExplorerRow(uri(longTxt));
	await waitForView(txtContent(), 'long.txt did not open in the plain-text view');
}

async function openLongMd(): Promise<void> {
	await clickExplorerRow(uri(longMd));
	await browser.waitUntil(
		async () =>
			browser.execute(
				(body, prefix) => Array.from(document.querySelectorAll(`${body} p[data-vellis-node-type="paragraph"]`)).some((p) => (p.textContent ?? '').startsWith(prefix)),
				BODY,
				TARGET_PARAGRAPH_PREFIX,
			),
		{ timeout: 15_000, timeoutMsg: 'long.md did not render the target paragraph' },
	);
	await browser.pause(300);
}

async function targetParagraphSelector(): Promise<string> {
	const id = await browser.execute(
		(body, prefix) =>
			Array.from(document.querySelectorAll<HTMLElement>(`${body} p[data-vellis-node-type="paragraph"]`)).find((p) => (p.textContent ?? '').startsWith(prefix))?.getAttribute('data-vellis-node-id') ?? null,
		BODY,
		TARGET_PARAGRAPH_PREFIX,
	);
	if (!id) throw new Error('target paragraph has no data-vellis-node-id');
	return `${BODY} [data-vellis-node-id="${id}"]`;
}

async function codePreSelector(): Promise<string> {
	const id = await browser.execute((body) => {
		const bodyEl = document.querySelector(body);
		if (!bodyEl) return null;
		return Array.from(bodyEl.children).find((el) => el.matches('pre[data-vellis-node-type="code"]'))?.getAttribute('data-vellis-node-id') ?? null;
	}, BODY);
	if (!id) throw new Error('top-level code fence not found');
	return `${BODY} pre[data-vellis-node-id="${id}"]`;
}

/** Scroll so that `selector`'s top sits `below` px under the toolbar; returns the scrollTop reached. */
async function scrollElementBelowToolbar(selector: string, below: number): Promise<number> {
	const r = await rectOf(selector);
	const vt = await visibleTop();
	const cur = await viewerScrollTop();
	if (!r) throw new Error(`${selector} not found`);
	return setViewerScrollTop(Math.round(cur + r.top - vt - below));
}

/** The html edit surface's first `<p>` inside the Shadow DOM: rect and text. */
async function htmlSurfaceParagraph(): Promise<{ rect: { top: number; left: number; width: number; height: number }; text: string; count: number } | null> {
	return browser.execute((surfaceSel) => {
		const shadow = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot;
		if (!shadow) return null;
		const ps = Array.from(shadow.querySelectorAll<HTMLElement>('p'));
		const p = ps.find((el) => (el.textContent ?? '').trim().length > 20) ?? ps[0];
		if (!p) return null;
		const r = p.getBoundingClientRect();
		return { rect: { top: r.top, left: r.left, width: r.width, height: r.height }, text: p.textContent ?? '', count: ps.length };
	}, HTML_SURFACE);
}

/** Where the caret is inside the html surface's editable block (observation for Issue #774). */
async function htmlSurfaceCaret(): Promise<{ editable: string | null; text: string | null; inside: boolean; collapsed: boolean; start: number; end: number; atBlockStart: boolean }> {
	return browser.execute((surfaceSel) => {
		const shadow = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot;
		const out = { editable: null as string | null, text: null as string | null, inside: false, collapsed: false, start: -1, end: -1, atBlockStart: false };
		const el = shadow?.querySelector<HTMLElement>('[contenteditable="true"]');
		if (!shadow || !el) return out;
		out.editable = el.tagName.toLowerCase();
		out.text = el.textContent;
		// A Shadow DOM's own selection (WebKit: ShadowRoot.getSelection is not standard; fall back to the document's).
		const sel = (shadow as unknown as { getSelection?: () => Selection | null }).getSelection?.() ?? window.getSelection();
		if (!sel || sel.rangeCount === 0) return out;
		const range = sel.getRangeAt(0);
		const inside = el.contains(range.startContainer) && el.contains(range.endContainer);
		const offsetOf = (node: Node, offset: number) => {
			const probe = document.createRange();
			probe.selectNodeContents(el);
			probe.setEnd(node, offset);
			return probe.toString().length;
		};
		out.inside = inside;
		out.collapsed = range.collapsed;
		out.start = inside ? offsetOf(range.startContainer, range.startOffset) : -1;
		out.end = inside ? offsetOf(range.endContainer, range.endOffset) : -1;
		out.atBlockStart = inside && range.collapsed && out.start === 0;
		return out;
	}, HTML_SURFACE);
}

// --- the gates ------------------------------------------------------------------------------

describe('Requirement #48 追補n・o・p human gates, driven with real keys and a real mouse (device gate)', function () {
	this.timeout(240_000);
	let currentFile = newlineTxt;

	before(async function () {
		if (!DEVICE) {
			this.skip();
			return;
		}
		for (const [name, value] of Object.entries({ VELLIS_GATE_BIN: bin, VELLIS_GATE_AXTOOL: axtool, VELLIS_GATE_REALINPUT: realinput, VELLIS_E2E_INITIAL_ROOT: root })) {
			if (!value) throw new Error(`${name} is not set`);
		}
		for (const f of [newlineTxt, otherMd, longTxt, longMd, pageHtml]) {
			if (!fs.existsSync(f)) throw new Error(`fixture missing: ${f} (run-gate-spec.sh req48nop writes it)`);
		}
		if (fs.readFileSync(newlineTxt, 'utf8') !== ORIGINAL) throw new Error(`newline.txt is not the expected fixture: ${JSON.stringify(fs.readFileSync(newlineTxt, 'utf8'))}`);

		const trusted = ri(['trusted'])[0]!;
		if (trusted.trusted !== true) throw new Error('realinput is not trusted for Accessibility; keys cannot be posted');
		const sources = ri(['inputsource', 'list']).map((s) => s.id as string);
		for (const id of [KOTOERI_ROMAJI, ABC]) {
			if (!sources.includes(id)) throw new Error(`input source ${id} is not enabled on this machine (have: ${sources.join(', ')})`);
		}
		// The user's input source and clipboard, put back in `after`.
		savedInputSource = currentInputSource();
		fs.mkdirSync(SHOTS_DIR, { recursive: true });
		savedPasteboard = path.join(SHOTS_DIR, 'req48nop-pasteboard.json');
		const pb = ri(['pasteboard', 'save', savedPasteboard])[0]!;
		report(REPORT, { gate: '48nop-env', trusted, savedInputSource, pasteboard: { items: pb.items, types: pb.types }, idle: ri(['idle'])[0]!.idle_seconds, mouse: ri(['mouse'])[0] });

		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await setIpcCapture(['save_document']);
		await installPageRecorder();
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		await waitForExplorerRow(uri(newlineTxt), { timeout: 20_000, nudgeDir: root, nudgePrefix: 'req48nop' });
		await calibrate();
		// Real keys are typed on the ABC layout unless a gate says otherwise.
		setInputSource(ABC);
	});

	afterEach(async function () {
		if (!DEVICE) return;
		const problems: Record<string, string> = {};
		try {
			await leaveEdit(currentFile);
		} catch (err) {
			problems.leaveEdit = String(err);
		}
		if (fs.existsSync(newlineTxt) && fs.readFileSync(newlineTxt, 'utf8') !== ORIGINAL) fs.writeFileSync(newlineTxt, ORIGINAL);
		try {
			const now = currentInputSource();
			if (now !== ABC) setInputSource(ABC);
		} catch (err) {
			problems.inputSource = String(err);
		}
		try {
			await clearLogs();
		} catch (err) {
			problems.clearLogs = String(err);
		}
		if (Object.keys(problems).length > 0) report(REPORT, { gate: '48nop-after-each', ...problems });
	});

	after(async function () {
		if (!DEVICE) return;
		const restored = restoreUserState();
		report(REPORT, { gate: '48nop-restore', restored, inputSourceNow: ri(['inputsource', 'get'])[0]!.id });
		try {
			await restoreGateRecorder();
		} catch {
			// the page may be gone already
		}
	});

	// --- 追補n ---------------------------------------------------------------------------------

	it('gate n-1: Kotoeri Romaji — a, i, then the Return that confirms the conversion inserts 「あい」 and NO line break; the next Return inserts one \\n', async () => {
		currentFile = newlineTxt;
		await openNewlineTxtAndEnterEditor();
		await placeCaret(MID_FIRST);
		await clearLogs();

		// Kotoeri is active only between these two switches (the finally puts ABC back
		// even when a step throws; the user's own source comes back in `after`).
		const sw = setInputSource(KOTOERI_ROMAJI);
		const run = async () => {
			// The app's input context follows a changed input source only when the
			// app (re)activates (macism works around the same thing with a temporary
			// window): take the front away for a moment and give it back, then put
			// the caret (and the focus) back into the editor.
			const refocus = ri(['refocus', String(screen!.pid)])[0]!;
			await ensureFront(screen!.pid);
			await browser.pause(300);
			await placeCaret(MID_FIRST);
			await clearPageRecord();
			// Keys for the IME go through the HID tap: raw keycodes, no attached
			// character (2026-10-29: postToPid keys were inserted as "a" "i" untouched).
			await sendText('a', 'hid');
			await browser.pause(400);
			const afterA = await editorSnapshot();
			const recAfterA = await readPageRecord();
			if (!recAfterA.compositions.some((c) => c.type === 'compositionstart')) {
				throw new Error(
					`TOOL PROBLEM, not the product: the real "a" did not reach the IME (no compositionstart; text now ${JSON.stringify(afterA.text)}, keys ${JSON.stringify(recAfterA.keys)}, refocus ${JSON.stringify(refocus)})`,
				);
			}
			await sendText('i', 'hid');
			await browser.pause(400);
			const afterI = await editorSnapshot();
			await sendKey(KEY.return, [], 'hid');
			await browser.pause(500);
			const afterConfirm = await editorSnapshot();
			const recAtConfirm = await readPageRecord();
			await sendKey(KEY.return, [], 'hid');
			await browser.pause(400);
			const afterSecondReturn = await editorSnapshot();
			const rec = await readPageRecord();
			return { refocus, afterA, afterI, afterConfirm, recAtConfirm, afterSecondReturn, rec };
		};
		let steps: Awaited<ReturnType<typeof run>>;
		try {
			steps = await run();
		} finally {
			setInputSource(ABC);
		}
		const { refocus, afterA, afterI, afterConfirm, recAtConfirm, afterSecondReturn, rec } = steps;
		await safeShot('req48nop-gate-n1-ime');

		// 追補r (Issue #767): the editor holds "source + one `\n`" (the sentinel); read the source part.
		const confirmedSource = afterConfirm.text!.slice(0, -1);
		const inserted = confirmedSource.startsWith(ORIGINAL.slice(0, MID_FIRST)) && confirmedSource.endsWith(ORIGINAL.slice(MID_FIRST))
			? confirmedSource.slice(MID_FIRST, confirmedSource.length - (ORIGINAL.length - MID_FIRST))
			: null;
		// The keydown WebKit dispatched for the confirming Return (Safari: keyCode 229,
		// the IME's) is the last one recorded before the second Return was sent.
		const confirmReturn = recAtConfirm.keys[recAtConfirm.keys.length - 1] ?? null;
		const laterReturns = rec.keys.slice(recAtConfirm.keys.length).filter((k) => k.key === 'Enter');
		const secondReturn = laterReturns[laterReturns.length - 1] ?? null;
		const compositionEnds = recAtConfirm.compositions.filter((c) => c.type === 'compositionend');
		report(REPORT, {
			gate: '48n-1-ime-confirm',
			inputSource: sw.now,
			refocus,
			keyRoute: 'hid',
			afterA: { text: afterA.text, compositions: rec.compositions.slice(0, 2) },
			afterI: { text: afterI.text },
			afterConfirm: { text: afterConfirm.text, lf: afterConfirm.lf, hasDivOrBr: afterConfirm.hasDivOrBr, caret: afterConfirm.caret },
			inserted,
			exactHiragana: inserted === 'あい',
			compositions: recAtConfirm.compositions,
			confirmReturn,
			afterSecondReturn: { text: afterSecondReturn.text, lf: afterSecondReturn.lf, hasDivOrBr: afterSecondReturn.hasDivOrBr, caret: afterSecondReturn.caret },
			secondReturn,
			inputs: rec.inputs,
			inputSourceAfter: currentInputSource(),
		});

		// The keys went through the IME: a composition started and ended, and what
		// was confirmed is Japanese text (not "ai"), inserted at the caret.
		expect(recAtConfirm.compositions.some((c) => c.type === 'compositionstart')).toBe(true);
		expect(compositionEnds.length).toBeGreaterThanOrEqual(1);
		expect(inserted).not.toBeNull();
		expect(inserted!.length).toBeGreaterThan(0);
		expect(inserted).not.toContain('\n');
		expect(inserted).toMatch(/^[぀-ゟ゠-ヿ一-鿿]+$/);
		expect(compositionEnds[compositionEnds.length - 1]!.data).toBe(inserted);
		// The confirming Return added no line break (契約1: IME Return is left alone).
		expect(afterConfirm.lf).toBe(2 + 1); // 追補r: ORIGINAL's 2 + the sentinel
		expect(afterConfirm.hasDivOrBr).toBe(false);
		expect(confirmReturn).not.toBeNull();
		expect(confirmReturn!.defaultPrevented).not.toBe(true);
		// Return outside a composition: exactly one `\n`, as a character, at the caret.
		expect(afterSecondReturn.text).toBe(ORIGINAL.slice(0, MID_FIRST) + inserted + '\n' + ORIGINAL.slice(MID_FIRST) + '\n'); // 追補r: + sentinel
		expect(afterSecondReturn.lf).toBe(3 + 1); // 追補r: + the sentinel
		expect(afterSecondReturn.hasDivOrBr).toBe(false);
		expect(afterSecondReturn.caret).toBe(MID_FIRST + inserted!.length + 1);
		expect(secondReturn).not.toBeNull();
		expect(secondReturn!.defaultPrevented).toBe(true);
		expect(secondReturn!.isComposing).toBe(false);
		// The user's layout is back to ABC for the rest (their own is restored in `after`).
		expect(currentInputSource()).toBe(ABC);
	});

	it('gate n-2: a real Command + Z (Edit menu) takes back a real Return, and a real multi-line Command + V', async () => {
		currentFile = newlineTxt;
		await openNewlineTxtAndEnterEditor();
		await clearLogs();

		await placeCaret(MID_FIRST);
		await sendKey(KEY.return);
		const afterReturn = await editorSnapshot();
		await sendKey(KEY.z, ['cmd']);
		const afterUndoReturn = await editorSnapshot();
		const recAfterUndo1 = await readPageRecord();

		await clearPageRecord();
		ri(['pasteboard', 'set-text', 'A\r\nB\rC\nD']);
		await placeCaret(END_FIRST_LINE);
		await sendKey(KEY.v, ['cmd']);
		const afterPaste = await editorSnapshot();
		await sendKey(KEY.z, ['cmd']);
		const afterUndoPaste = await editorSnapshot();
		const recAfterUndo2 = await readPageRecord();
		await safeShot('req48nop-gate-n2-undo');
		report(REPORT, {
			gate: '48n-2-real-undo',
			afterReturn: { text: afterReturn.text, hasDivOrBr: afterReturn.hasDivOrBr, caret: afterReturn.caret },
			afterUndoReturn: { text: afterUndoReturn.text, hasDivOrBr: afterUndoReturn.hasDivOrBr },
			undo1Inputs: recAfterUndo1.inputs,
			afterPaste: { text: afterPaste.text, hasDivOrBr: afterPaste.hasDivOrBr, caret: afterPaste.caret },
			afterUndoPaste: { text: afterUndoPaste.text, hasDivOrBr: afterUndoPaste.hasDivOrBr },
			undo2Inputs: recAfterUndo2.inputs,
			keys: recAfterUndo2.keys,
		});

		// 追補r: the editor text carries the sentinel.
		expect(afterReturn.text).toBe('first\n line\nsecond line\n' + '\n');
		expect(afterReturn.hasDivOrBr).toBe(false);
		expect(afterUndoReturn.text).toBe(ORIGINAL + '\n');
		expect(afterUndoReturn.hasDivOrBr).toBe(false);
		// The undo came through WebKit's undo manager (the menu's `undo:`): an `input` of type historyUndo.
		expect(recAfterUndo1.inputs.some((i) => i.inputType === 'historyUndo')).toBe(true);
		expect(afterPaste.text).toBe('first lineA\nB\nC\nD\nsecond line\n' + '\n'); // 追補r: + sentinel
		expect(afterPaste.hasDivOrBr).toBe(false);
		expect(afterPaste.text).not.toContain('\r');
		expect(afterUndoPaste.text).toBe(ORIGINAL + '\n'); // 追補r: + sentinel
		expect(afterUndoPaste.hasDivOrBr).toBe(false);
		expect(recAfterUndo2.inputs.some((i) => i.inputType === 'historyUndo')).toBe(true);

		// The buffer followed the undo: Done Editing asks nothing.
		const left = await leaveEditorExpectingNoAsk();
		report(REPORT, { gate: '48n-2-left-editor', ...left });
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
		expect(fs.readFileSync(newlineTxt, 'utf8')).toBe(ORIGINAL);
	});

	it('gate n-3: a real Command + V pastes CRLF / CR / LF lines as \\n lines (a selection replaced too) and a real Command + S writes them to disk; the reopened file has them', async () => {
		currentFile = newlineTxt;
		await openNewlineTxtAndEnterEditor();
		await clearLogs();

		ri(['pasteboard', 'set-text', 'A\r\nB\rC\nD']);
		await placeCaret(END_FIRST_LINE);
		await sendKey(KEY.v, ['cmd']);
		const after1 = 'first lineA\nB\nC\nD\nsecond line\n';
		const p1 = await editorSnapshot();
		const secondAt = after1.indexOf('second');
		ri(['pasteboard', 'set-text', 'X\r\nY']);
		await placeCaret(secondAt, secondAt + 'second'.length);
		await sendKey(KEY.v, ['cmd']);
		const after2 = after1.replace('second', 'X\nY');
		const p2 = await editorSnapshot();
		const recPaste = await readPageRecord();

		await sendKey(KEY.s, ['cmd']);
		await waitForDisk(newlineTxt, after2);
		const disk = diskBytes(newlineTxt);
		const saveCalls = (await readCapturedIpc())
			.filter((c) => c.cmd === 'save_document')
			.map((c) => ({ ok: c.ok, content: (c.args as { content?: string } | null)?.content ?? null }));
		await safeShot('req48nop-gate-n3-paste-save');
		report(REPORT, {
			gate: '48n-3-real-paste-save',
			p1: { text: p1.text, hasDivOrBr: p1.hasDivOrBr, caret: p1.caret },
			p2: { text: p2.text, hasDivOrBr: p2.hasDivOrBr, caret: p2.caret },
			pasteInputs: recPaste.inputs,
			disk,
			equalsExpected: disk.text === after2,
			saveCalls,
		});

		// 追補r: the editor text carries the sentinel (`after1` / `after2` are the buffer = the bytes saved).
		expect(p1.text).toBe(after1 + '\n');
		expect(p1.hasDivOrBr).toBe(false);
		expect(p1.caret).toBe(END_FIRST_LINE + 'A\nB\nC\nD'.length);
		expect(p2.text).toBe(after2 + '\n');
		expect(p2.hasDivOrBr).toBe(false);
		expect(disk.text).toBe(after2);
		expect(disk.cr).toBe(0);
		expect(disk.lf).toBe((after2.match(/\n/g) ?? []).length);
		expect(saveCalls.length).toBe(1);
		expect(saveCalls[0]!.ok).toBe(true);
		expect(saveCalls[0]!.content).toBe(after2);

		// Reopen: leave the (clean) editor, open other.md, come back.
		const left = await leaveEditorExpectingNoAsk();
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
		await clickExplorerRow(uri(otherMd));
		await waitForOtherMd();
		await openNewlineTxt(after2);
		const reopened = await editorSnapshot();
		report(REPORT, { gate: '48n-3-reopened', text: reopened.text, editing: reopened.editing });
		expect(reopened.editing).toBe(false);
		expect(reopened.text).toBe(after2);
	});

	// --- 追補o ---------------------------------------------------------------------------------

	it('gate o-1: dirty, open another file → ONE sheet (Save / Don\'t Save / Cancel, the contract\'s text) → a real Esc closes it and nothing happens', async () => {
		currentFile = newlineTxt;
		const dirty = await makeDirtyByTyping();
		const t = await triggerUnsavedSheet();
		const shape = sheetShape(t.sheet);
		await safeShot('req48nop-gate-o1-sheet');

		await sendKey(KEY.escape);
		await browser.waitUntil(async () => sheets(screen!.pid).length === 0, { timeout: 5_000, timeoutMsg: 'Esc did not close the sheet' });
		const after = await editorSnapshot();
		const second = await expectNoSecondSheet();
		const rec = await readGateRecord();
		report(REPORT, {
			gate: '48o-1-esc',
			dirtyText: dirty.text,
			sheet: shape,
			sheetsSeen: t.all.length,
			front: t.front,
			asksAtSheet: t.asks,
			after: { editing: after.editing, text: after.text, activeIsEditor: after.activeIsEditor },
			otherMdShown: await otherMdShown(),
			onDisk: fs.readFileSync(newlineTxt, 'utf8'),
			...second,
			dialogs: rec.dialogs,
		});

		expect(t.all.length).toBe(1);
		expect(shape.role).toBe('AXSheet');
		expect([...shape.buttons].sort()).toEqual([SAVE, DONT_SAVE, CANCEL].sort());
		expect(shape.buttonsEnabled).toBe(true);
		expect(shape.hasMessage).toBe(true);
		expect(shape.hasTitle).toBe(true);
		expect(t.asks).toBe(1);
		// Esc = Cancel (Issue #483): the edit, the document and the file are untouched.
		expect(after.editing).toBe(true);
		expect(after.text).toBe(EDITED + '\n'); // 追補r: + sentinel
		expect(await otherMdShown()).toBe(false);
		expect(fs.readFileSync(newlineTxt, 'utf8')).toBe(ORIGINAL);
		expect(second.sheetsAfter).toBe(0);
		expect(second.asksAfter).toBe(1);
		expect(rec.dialogs).toEqual([]);
	});

	it('gate o-2: dirty, open another file → the one sheet → a real Return = Save: the file is written first, then other.md opens, no second sheet', async () => {
		currentFile = newlineTxt;
		await makeDirtyByTyping();
		const t = await triggerUnsavedSheet();
		const shape = sheetShape(t.sheet);

		await sendKey(KEY.return);
		await browser.waitUntil(async () => sheets(screen!.pid).length === 0, { timeout: 5_000, timeoutMsg: 'Return did not close the sheet' });
		await waitForDisk(newlineTxt, EDITED);
		await waitForOtherMd();
		const after = await editorSnapshot();
		const second = await expectNoSecondSheet();
		const saveCalls = (await readCapturedIpc()).filter((c) => c.cmd === 'save_document').map((c) => ({ ok: c.ok, content: (c.args as { content?: string } | null)?.content ?? null }));
		const rec = await readGateRecord();
		await safeShot('req48nop-gate-o2-after-save');
		report(REPORT, { gate: '48o-2-return-save', sheet: shape, sheetsSeen: t.all.length, asksAtSheet: t.asks, onDisk: fs.readFileSync(newlineTxt, 'utf8'), saveCalls, after: { editing: after.editing, text: after.text }, otherMdShown: await otherMdShown(), ...second, dialogs: rec.dialogs });

		expect(t.all.length).toBe(1);
		expect(shape.hasMessage).toBe(true);
		expect(t.asks).toBe(1);
		expect(fs.readFileSync(newlineTxt, 'utf8')).toBe(EDITED);
		expect(saveCalls.length).toBe(1);
		expect(saveCalls[0]!.ok).toBe(true);
		expect(saveCalls[0]!.content).toBe(EDITED);
		expect(after.editing).toBe(false);
		expect(await otherMdShown()).toBe(true);
		expect(second.sheetsAfter).toBe(0);
		expect(second.asksAfter).toBe(1);
		expect(rec.dialogs).toEqual([]);
		currentFile = otherMd;
	});

	it('gate o-3: dirty, open another file → the one sheet → a real Command + D = Don\'t Save: the edit is dropped, other.md opens, no second sheet', async () => {
		currentFile = newlineTxt;
		await makeDirtyByTyping();
		const t = await triggerUnsavedSheet();
		const shape = sheetShape(t.sheet);

		await sendKey(KEY.d, ['cmd']);
		await browser.waitUntil(async () => sheets(screen!.pid).length === 0, { timeout: 5_000, timeoutMsg: 'Command + D did not close the sheet' });
		await waitForOtherMd();
		const after = await editorSnapshot();
		const second = await expectNoSecondSheet();
		const saveCalls = (await readCapturedIpc()).filter((c) => c.cmd === 'save_document').length;
		const rec = await readGateRecord();
		await safeShot('req48nop-gate-o3-after-dont-save');
		report(REPORT, { gate: '48o-3-cmd-d-discard', sheet: shape, sheetsSeen: t.all.length, asksAtSheet: t.asks, onDisk: fs.readFileSync(newlineTxt, 'utf8'), saveCalls, after: { editing: after.editing }, otherMdShown: await otherMdShown(), ...second, dialogs: rec.dialogs });

		expect(t.all.length).toBe(1);
		expect(shape.hasMessage).toBe(true);
		expect(t.asks).toBe(1);
		expect(fs.readFileSync(newlineTxt, 'utf8')).toBe(ORIGINAL);
		expect(saveCalls).toBe(0);
		expect(after.editing).toBe(false);
		expect(await otherMdShown()).toBe(true);
		expect(second.sheetsAfter).toBe(0);
		expect(second.asksAfter).toBe(1);
		expect(rec.dialogs).toEqual([]);
		currentFile = otherMd;
	});

	// --- 追補p ---------------------------------------------------------------------------------

	it('gate p-1: long .txt scrolled ~1000 px, a real double-click in the middle of a line → editor, collapsed caret at that character, scrollTop unchanged, a real X typed goes in there', async () => {
		currentFile = longTxt;
		await openLongTxt();
		const content = txtContent();
		const scrollTop = await setViewerScrollTop(SCROLL_HALFWAY);
		const lineHeight = await measureLineHeight(VIEW_PRE);
		const point = await pickMidLinePoint(VIEW_PRE, 5, lineHeight);
		await clearSelection();

		const click = await realClick(point.x, point.y, true);
		await browser.waitUntil(async () => (await editorSnapshot()).editing, { timeout: 5_000, timeoutMsg: 'the real double-click did not enter the editor' });
		await browser.pause(250);
		const after = await editorSnapshot();
		await sendText('X');
		const afterType = await editorSnapshot();
		await safeShot('req48nop-gate-p1-txt-dblclick');
		report(REPORT, {
			gate: '48p-1-txt-real-dblclick',
			scrollTop,
			lineHeight,
			point,
			route: click.route,
			attempts: click.attempts,
			mouse: click.mouse,
			after: { ...after, text: undefined },
			afterTypeAround: afterType.text?.slice(point.offset - 5, point.offset + 6),
			afterTypeCaret: afterType.caret,
		});

		expect(scrollTop).toBeGreaterThan(0);
		expect(point.offset).toBeGreaterThan(0);
		expect(click.mouse.filter((m) => m.type === 'dblclick').length).toBeGreaterThan(0);
		expect(after.editing).toBe(true);
		expect(after.activeIsEditor).toBe(true);
		expect(after.selection.inside).toBe(true);
		expect(after.selection.collapsed).toBe(true);
		expect(after.selection.start).toBe(point.offset);
		expect(Math.abs(after.scrollTop - scrollTop)).toBeLessThanOrEqual(1);
		expect(after.selection.rect).not.toBeNull();
		expect(after.selection.rect!.top).toBeGreaterThanOrEqual(after.visibleTop - 0.5);
		expect(after.selection.rect!.bottom).toBeLessThanOrEqual(after.innerHeight + 0.5);
		expect(afterType.text).toBe(content.slice(0, point.offset) + 'X' + content.slice(point.offset) + '\n'); // 追補r: + sentinel
		expect(afterType.caret).toBe(point.offset + 1);
	});

	it('gate p-2: markdown paragraph, a real double-click in the middle → that block editable, collapsed caret at the clicked character, scrollTop unchanged, a real X typed goes in there', async () => {
		currentFile = longMd;
		await openLongMd();
		const p = await targetParagraphSelector();
		const scrollTop = await scrollElementBelowToolbar(p, 120);
		const r = await rectOf(p);
		if (!r) throw new Error('target paragraph not found');
		const y = r.top + r.height / 2;
		const point = await pickPointIn(
			p,
			[90, 70, 110, 50, 130].map((dx) => ({ x: r.left + Math.min(dx, r.width * 0.4), y })),
		);
		const before = (await selectionIn(p)).text ?? '';
		await clearSelection();

		const click = await realClick(point.x, point.y, true);
		await browser.waitUntil(async () => (await selectionIn(p)).editable, { timeout: 5_000, timeoutMsg: 'the real double-click did not make the paragraph editable' });
		await browser.pause(250);
		const after = await selectionIn(p);
		const scrollAfter = await viewerScrollTop();
		await sendText('X');
		const afterType = await selectionIn(p);
		await safeShot('req48nop-gate-p2-md-paragraph');
		report(REPORT, { gate: '48p-2-md-paragraph-real-dblclick', scrollTop, point, route: click.route, attempts: click.attempts, after, scrollAfter, afterTypeText: afterType.text, afterTypeCaret: afterType.start });

		expect(point.offset).toBeGreaterThan(0);
		expect(click.mouse.filter((m) => m.type === 'dblclick').length).toBeGreaterThan(0);
		expect(after.editable).toBe(true);
		expect(after.inside).toBe(true);
		expect(after.collapsed).toBe(true);
		expect(after.start).toBe(point.offset);
		expect(Math.abs(scrollAfter - scrollTop)).toBeLessThanOrEqual(1);
		expect(afterType.text).toBe(before.slice(0, point.offset) + 'X' + before.slice(point.offset));
	});

	it('gate p-3: code block, a real double-click in the middle → plain text, collapsed caret at the same character count, scrollTop unchanged, a real X typed goes in there', async () => {
		currentFile = longMd;
		await openLongMd();
		const pre = await codePreSelector();
		const body = codeBody();
		const scrollTop = await scrollElementBelowToolbar(pre, 120);
		const r = await rectOf(pre);
		if (!r) throw new Error('code fence not found');
		const point = await pickPointIn(
			pre,
			[0.5, 0.35, 0.65, 0.25, 0.75].map((f) => ({ x: r.left + 60, y: r.top + r.height * f })),
		);
		await clearSelection();

		const click = await realClick(point.x, point.y, true);
		await browser.waitUntil(
			async () => browser.execute((sel) => document.querySelector(`${sel}[contenteditable="true"], ${sel} > code[contenteditable="true"]`) !== null, pre),
			{ timeout: 5_000, timeoutMsg: 'the real double-click did not make the code block editable' },
		);
		await browser.pause(250);
		const editableSel = (await browser.execute((sel) => (document.querySelector(`${sel}[contenteditable="true"]`) ? sel : `${sel} > code`), pre)) as string;
		const after = await selectionIn(editableSel);
		const scrollAfter = await viewerScrollTop();
		await sendText('X');
		const afterType = await selectionIn(editableSel);
		await safeShot('req48nop-gate-p3-md-code');
		report(REPORT, { gate: '48p-3-md-code-real-dblclick', scrollTop, point, route: click.route, attempts: click.attempts, editableSel, after, scrollAfter, afterTypeText: afterType.text, afterTypeCaret: afterType.start });

		expect(point.offset).toBeGreaterThan(0);
		expect(click.mouse.filter((m) => m.type === 'dblclick').length).toBeGreaterThan(0);
		expect(after.editable).toBe(true);
		expect(after.hasSpan).toBe(false);
		expect(after.text).toBe(body);
		expect(after.inside).toBe(true);
		expect(after.collapsed).toBe(true);
		expect(after.start).toBe(point.offset);
		expect(Math.abs(scrollAfter - scrollTop)).toBeLessThanOrEqual(1);
		expect(afterType.text).toBe(body.slice(0, point.offset) + 'X' + body.slice(point.offset));
	});

	it('gate p-4 (observation only, Issue #774): html edit surface, a real double-click on a paragraph — where the caret lands is recorded, not judged', async () => {
		currentFile = pageHtml;
		await clickExplorerRow(uri(pageHtml));
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelector('iframe') !== null || document.querySelector('.html-find-surface, [data-testid="html-edit-surface"]') !== null),
			{ timeout: 15_000, timeoutMsg: 'page.html did not open' },
		);
		await browser.pause(300);
		// Command + E (the menu event) brings the html edit surface (Shadow DOM) up.
		await emitMenu('menu_edit');
		await browser.waitUntil(async () => (await htmlSurfaceParagraph()) !== null, { timeout: 10_000, timeoutMsg: 'the html edit surface did not appear' });
		await browser.pause(300);
		const para = (await htmlSurfaceParagraph())!;
		const point = { x: Math.round(para.rect.left + Math.min(80, para.rect.width * 0.4)), y: Math.round(para.rect.top + para.rect.height / 2) };
		await clearSelection();

		let click: ClickOutcome | null = null;
		let error: string | null = null;
		try {
			click = await realClick(point.x, point.y, true);
		} catch (e) {
			error = String(e);
		}
		await browser.pause(400);
		const caret = await htmlSurfaceCaret();
		// `window.getSelection()` does not see into the Shadow DOM (2026-10-29:
		// inside:false), so the caret is measured by typing: a real X, then the
		// index at which the block's text differs from the paragraph's. Esc
		// (dispatched on the block) discards the block edit and puts the text back.
		let typed: { text: string | null; index: number; atBlockStart: boolean | null; restored: boolean | null } = { text: null, index: -1, atBlockStart: null, restored: null };
		if (caret.editable) {
			await sendText('X');
			const blockText = await browser.execute((surfaceSel) => document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]')?.textContent ?? null, HTML_SURFACE);
			let index = -1;
			if (blockText !== null && blockText.length === para.text.length + 1) {
				index = 0;
				while (index < para.text.length && blockText[index] === para.text[index]) index++;
				if (blockText[index] !== 'X') index = -1;
			}
			const restored = await browser.execute(
				(surfaceSel, original) => {
					const shadow = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot;
					const el = shadow?.querySelector<HTMLElement>('[contenteditable="true"]');
					if (!el) return null;
					el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }));
					const ps = Array.from(shadow!.querySelectorAll<HTMLElement>('p'));
					return ps.some((p) => p.textContent === original) && shadow!.querySelector('[contenteditable="true"]') === null;
				},
				HTML_SURFACE,
				para.text,
			);
			typed = { text: blockText, index, atBlockStart: index === -1 ? null : index === 0, restored };
		}
		await safeShot('req48nop-gate-p4-html-observation');
		report(REPORT, {
			gate: '48p-4-html-surface-observation',
			judged: false,
			issue: '#774',
			paragraph: { text: para.text.slice(0, 60), rect: para.rect, count: para.count },
			point,
			route: click?.route ?? null,
			attempts: click?.attempts ?? null,
			error,
			selectionApi: caret,
			caretByTyping: typed,
			expectedByIssue774: 'start of the block (caretByTyping.index 0)',
		});
		// Nothing about the caret is asserted here (観察だけ). Only that the surface was up.
		expect(para.count).toBeGreaterThan(0);
	});
});
