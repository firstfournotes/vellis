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
 * Requirement #48 追補q (Issue #774) and 追補r (Issue #767) human gates, driven
 * with REAL input on a real screen through `scripts/gate-device/realinput.swift`
 * — the same harness, guards and clean-up as `req48nop-real-input-gate.e2e.ts`
 * (pid-pinned tool, the app frontmost with a key window before every send,
 * keys by `postToPid`, clicks by the HID tap only while the topmost window at
 * the point is the test app's, the user's input source and clipboard saved
 * first and put back in `after` or by run-gate-spec.sh's trap).
 *
 * What the CI specs cannot do and this one does:
 *  - q-1〜q-6  the html edit surface (a Shadow DOM): a REAL double-click
 *              (HID) on a word of a paragraph / inside <strong> / a link / a
 *              heading / a list item / a table cell, then a REAL `X` → the `X`
 *              is inside that word (req48nop's p-4 measurement, now judged;
 *              before the fix the `X` went to the block's start). Esc discards.
 *  - r-1       `abc` (no final newline): Return at the end → Command + S →
 *              `abc\n` (before the fix `abc\n\n`)
 *  - r-2       `abc\n`: Return at the end of `abc` → `x` → Command + S →
 *              `abc\nx\n` (before the fix `abc\nx`)
 *  - r-3       `abc\n`: `x` on the last empty line → REAL Command + Z (the Edit
 *              menu) → the buffer is `abc\n` again: Command + S leaves the
 *              file `abc\n`, Done asks nothing (before the fix the buffer was
 *              `abc\n\n`: dirty, saved one too many)
 *  - r-4       `abc`: Return → Command + Z → Command + Shift + Z (redo) → the
 *              typed line break survives: Command + S → `abc\n`
 *  - r-5       `abc\n`: select everything → REAL Command + C → the clipboard's
 *              text is the source (`abc\n`, no sentinel; before the fix
 *              `abc\n\n`). The clipboard is saved before and restored after.
 *  - r-6       the CRLF file: Return at the end of `third line` → `x` →
 *              Command + S → the final `\r\n` stays (the inserted break is LF)
 *
 * Every key here is a real key (realinput `key` / `text`); Command + E is the
 * `menu_edit` event (WebDriver sets the state; the keys are what is judged).
 *
 * Runs only under `scripts/gate-device/run-gate-spec.sh req48qr`
 * (VELLIS_GATE_DEVICE=1), which copies `fixtures/edit/774-html-edit-caret.html`
 * and `fixtures/edit/767-*` into a throwaway root; the originals are never
 * written. Evidence: `$VELLIS_GATE_SHOTS/req48qr-report.jsonl` (`[gate]` lines).
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const realinput = process.env.VELLIS_GATE_REALINPUT ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';
const REPORT = 'req48qr-report.jsonl';

/** The fixtures and the bytes they must hold (fixtures/edit/README.md). */
const FIXTURES = {
	a: { name: '767-a-ends-with-newline.txt', content: 'abc\n' },
	b: { name: '767-b-no-final-newline.txt', content: 'abc' },
	c: { name: '767-c-three-lines.txt', content: 'first line\nsecond line\nthird line\n' },
	d: { name: '767-d-crlf.txt', content: 'first line\r\nsecond line\r\nthird line\r\n' },
} as const;
type FixtureKey = keyof typeof FIXTURES;
const gateFile = (k: FixtureKey) => path.join(root, FIXTURES[k].name);
const htmlFile = path.join(root, '774-html-edit-caret.html');

/** 追補r 契約1: the editor's `<pre>` holds "source + this" (the buffer is the text without it). */
const SENTINEL = '\n';
const ABC = 'com.apple.keylayout.ABC';

/** macOS virtual keycodes (US ANSI). */
const KEY = { return: 36, a: 0, c: 8, s: 1, z: 6 } as const;

const VIEWER = 'article.viewer';
const BODY = `${VIEWER} .markdown-body`;
const VIEW_PRE = `${BODY} pre.vellis-plaintext:not([contenteditable="true"])`;
const EDITOR = `${BODY} pre.vellis-plaintext[contenteditable="true"]`;
const HTML_SURFACE = '[data-testid="html-edit-surface"]';
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
 * Space the gestures out. The spec's own events reset HIDIdleTime too, so this
 * cannot tell the user's input from its own while running; the real check is
 * the runner's before the run (HID idle ≥ 120 s, the user away).
 */
async function waitForIdle(min = 0.8, timeout = 30_000): Promise<number> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const idle = ri(['idle'])[0]!.idle_seconds as number;
		if (idle >= min) return idle;
		if (Date.now() >= deadline) throw new Error(`the machine kept seeing input (HID idle ${idle}s); not sending`);
		await browser.pause(300);
	}
}

// --- page recorder ---------------------------------------------------------------

interface MouseRec {
	type: string;
	clientX: number;
	clientY: number;
	detail: number;
	target: string;
	sameAsElementFromPoint: boolean;
}

interface PageRecord {
	keys: Array<{ key: string; keyCode: number; metaKey: boolean; shiftKey: boolean; defaultPrevented: boolean | null }>;
	inputs: Array<{ inputType: string; data: string | null }>;
	mouse: MouseRec[];
}

async function installPageRecorder(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __ri?: PageRecord };
		if (w.__ri) return;
		const rec: PageRecord = { keys: [], inputs: [], mouse: [] };
		w.__ri = rec;
		const describe = (t: EventTarget | null): string => {
			const el = t instanceof Element ? t : t instanceof Node ? t.parentElement : null;
			if (!el) return String(t);
			const cls = typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').filter(Boolean).join('.') : '';
			return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}`;
		};
		document.addEventListener(
			'keydown',
			(e) => rec.keys.push({ key: e.key, keyCode: e.keyCode, metaKey: e.metaKey, shiftKey: e.shiftKey, defaultPrevented: null }),
			true,
		);
		window.addEventListener('keydown', (e) => {
			const last = rec.keys[rec.keys.length - 1];
			if (last && last.key === e.key) last.defaultPrevented = e.defaultPrevented;
		});
		document.addEventListener('input', (e) => rec.inputs.push({ inputType: (e as InputEvent).inputType, data: (e as InputEvent).data }), true);
		for (const type of ['mousedown', 'dblclick']) {
			document.addEventListener(
				type,
				(e) => {
					const m = e as MouseEvent;
					rec.mouse.push({
						type,
						clientX: m.clientX,
						clientY: m.clientY,
						detail: m.detail,
						target: describe(m.target),
						sameAsElementFromPoint: document.elementFromPoint(m.clientX, m.clientY) === m.target,
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
		return r ? (JSON.parse(JSON.stringify(r)) as PageRecord) : { keys: [], inputs: [], mouse: [] };
	});
}

async function clearPageRecord(): Promise<void> {
	await browser.execute(() => {
		const r = (window as unknown as { __ri?: PageRecord }).__ri;
		if (!r) return;
		r.keys = [];
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

async function saveCalls(): Promise<Array<{ ok: boolean; content: string | null }>> {
	return (await readCapturedIpc())
		.filter((c) => c.cmd === 'save_document')
		.map((c) => ({ ok: c.ok, content: (c.args as { content?: string } | null)?.content ?? null }));
}

// --- the source editor as the page sees it -------------------------------------------

interface EditorSnapshot {
	editing: boolean;
	text: string | null;
	children: number;
	hasDivOrBr: boolean;
	/** Collapsed caret as a character offset of `textContent` (-1 otherwise). */
	caret: number;
	/** The selection's string (what a copy sees), '' without one. */
	selected: string;
	lf: number;
	activeIsEditor: boolean;
}

async function editorSnapshot(): Promise<EditorSnapshot> {
	return browser.execute(
		(editorSel, bodySel) => {
			const editor = document.querySelector<HTMLElement>(editorSel);
			const pre = editor ?? document.querySelector<HTMLElement>(`${bodySel} pre.vellis-plaintext`);
			const sel = window.getSelection();
			let caret = -1;
			if (pre && sel && sel.rangeCount > 0 && sel.isCollapsed && pre.contains(sel.anchorNode)) {
				const range = sel.getRangeAt(0);
				const probe = document.createRange();
				probe.selectNodeContents(pre);
				probe.setEnd(range.startContainer, range.startOffset);
				caret = probe.toString().length;
			}
			const text = pre?.textContent ?? null;
			return {
				editing: editor !== null,
				text,
				children: pre?.childElementCount ?? -1,
				hasDivOrBr: pre?.querySelector('div, br') !== null,
				caret,
				selected: sel?.toString() ?? '',
				lf: text === null ? -1 : (text.match(/\n/g) ?? []).length,
				activeIsEditor: editor !== null && document.activeElement === editor,
			};
		},
		EDITOR,
		BODY,
	);
}

/** Put the caret (or a selection) at character offsets of the editor's `textContent`, focusing it. */
async function placeCaret(start: number, end: number = start): Promise<void> {
	const ok = await browser.execute(
		(editorSel, s, e) => {
			const el = document.querySelector<HTMLElement>(editorSel);
			if (!el) return false;
			el.focus();
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
		EDITOR,
		start,
		end,
	);
	if (!ok) throw new Error(`could not place the caret at ${start}..${end} (is the editor open?)`);
}

async function clearSelection(): Promise<void> {
	await browser.execute(() => window.getSelection()?.removeAllRanges());
}

async function rectOf(selector: string): Promise<{ top: number; left: number; width: number; height: number } | null> {
	return browser.execute((sel) => {
		const el = document.querySelector<HTMLElement>(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { top: r.top, left: r.left, width: r.width, height: r.height };
	}, selector);
}

// --- real input -------------------------------------------------------------------------

interface Screen {
	pid: number;
	frame: { x: number; y: number; w: number; h: number; number: number };
	dx: number;
	dy: number;
	route: 'pid' | 'hid';
}

let screen: Screen | null = null;

function toScreen(clientX: number, clientY: number): { x: number; y: number } {
	if (!screen) throw new Error('screen not calibrated');
	return { x: screen.frame.x + screen.dx + clientX, y: screen.frame.y + screen.dy + clientY };
}

async function readyToSend(): Promise<FrontInfo> {
	if (!screen) throw new Error('screen not calibrated');
	const f = await ensureFront(screen.pid);
	await waitForIdle();
	return f;
}

/** A real key (postToPid: the app is frontmost with its key window, checked by realinput). */
async function sendKey(keycode: number, mods: string[] = []): Promise<Record<string, unknown>> {
	await readyToSend();
	const out = ri(['key', String(screen!.pid), String(keycode), ...mods, 'pid'])[0]!;
	await browser.pause(250);
	return out;
}

async function sendText(text: string): Promise<Record<string, unknown>> {
	await readyToSend();
	const out = ri(['text', String(screen!.pid), text, 'pid'])[0]!;
	await browser.pause(250 + 40 * text.length);
	return out;
}

interface ClickOutcome {
	route: 'pid' | 'hid';
	attempts: Array<{ route: string; facts: Record<string, unknown>; mousedowns: number; dblclicks: number }>;
	mouse: MouseRec[];
}

/** A real click / double-click at a viewport point: "pid" first, "hid" when the page saw nothing. */
async function realClick(clientX: number, clientY: number, double: boolean): Promise<ClickOutcome> {
	const s = toScreen(clientX, clientY);
	const cmd = double ? 'dblclick' : 'click';
	const attempts: ClickOutcome['attempts'] = [];
	const routes: Array<'pid' | 'hid'> = screen!.route === 'hid' ? ['hid'] : ['pid', 'hid'];
	for (const route of routes) {
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
		await clearSelection();
	}
	throw new Error(`no route delivered the ${cmd} at client (${clientX}, ${clientY}) = screen (${s.x}, ${s.y}): ${JSON.stringify(attempts)}`);
}

/**
 * Find the window and measure the WKWebView's offset in it with one real click
 * on the view `<pre>` of the three-line file (a single click there only places
 * a caret in the view). The guess is window height − innerHeight.
 */
async function calibrate(): Promise<void> {
	const pid = appPid();
	await ensureFront(pid);
	const wins = ax(['cgwins', String(pid)]).filter((w) => w.onscreen === true);
	if (wins.length === 0) throw new Error('the test app has no on-screen window');
	const w = wins.sort((a, b) => (b.w as number) * (b.h as number) - (a.w as number) * (a.h as number))[0]!;
	const inner = await browser.execute(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }));
	const guess = { dx: Math.round(((w.w as number) - inner.innerWidth) / 2), dy: (w.h as number) - inner.innerHeight };
	screen = { pid, frame: { x: w.x as number, y: w.y as number, w: w.w as number, h: w.h as number, number: w.number as number }, dx: guess.dx, dy: guess.dy, route: 'pid' };

	await openText('c');
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
	report(REPORT, { gate: '48qr-calibration', pid, window: w, inner, guess, measured, drift, route: click.route, mousedown: md, attempts: click.attempts });
	expect(md.target).toContain('pre.vellis-plaintext');
	expect(md.sameAsElementFromPoint).toBe(true);
	expect(Math.abs(drift.dx)).toBeLessThanOrEqual(4);
	expect(Math.abs(drift.dy)).toBeLessThanOrEqual(4);
}

// --- the user's input source and clipboard ------------------------------------------------

let savedInputSource: string | null = null;
let savedPasteboard: string | null = null;

function currentInputSource(): string {
	return ri(['inputsource', 'get'])[0]!.id as string;
}

function setInputSource(id: string): Record<string, unknown> {
	const out = ri(['inputsource', 'set', id])[0]!;
	if ((out.now as { id: string }).id !== id) throw new Error(`input source did not switch to ${id}: ${JSON.stringify(out)}`);
	return out;
}

function clipboardText(): string | null {
	const v = ri(['pasteboard', 'get-text'])[0]!.text;
	return typeof v === 'string' ? v : null;
}

/** Put both back; the saved file (clipboard contents + input source id) is deleted only when both succeeded. */
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

// --- documents --------------------------------------------------------------------------------

function resetGateFiles(): void {
	for (const k of Object.keys(FIXTURES) as FixtureKey[]) {
		fs.writeFileSync(gateFile(k), FIXTURES[k].content);
	}
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

/** Open a 767 text file in the plain view (text as on disk). */
async function openText(k: FixtureKey): Promise<void> {
	const expected = fs.readFileSync(gateFile(k), 'utf8');
	await clickExplorerRow(uri(gateFile(k)));
	await browser.waitUntil(
		async () => {
			const v = await editorSnapshot();
			// The view `<pre>` is parsed HTML: CRLF reads as LF there.
			return !v.editing && v.text === expected.replace(/\r\n/g, '\n');
		},
		{ timeout: 15_000, timeoutMsg: `${FIXTURES[k].name} did not open in the plain-text view (now: ${JSON.stringify(await editorSnapshot())})` },
	);
}

/** Command + E (the menu event) into the source editor; the `<pre>` must hold source + sentinel. */
async function enterEditor(k: FixtureKey): Promise<EditorSnapshot> {
	await openText(k);
	await emitMenu('menu_edit');
	await browser.waitUntil(async () => (await editorSnapshot()).editing, { timeout: 5_000, timeoutMsg: 'menu_edit did not enter the editor' });
	await browser.pause(150);
	const v = await editorSnapshot();
	expect(v.text).toBe(FIXTURES[k].content + SENTINEL);
	expect(v.children).toBe(0);
	return v;
}

/** Real Command + S, then wait for the file on disk to be `expected`. */
async function saveAndWaitForDisk(file: string, expected: string): Promise<void> {
	await sendKey(KEY.s, ['cmd']);
	await browser.waitUntil(async () => fs.readFileSync(file, 'utf8') === expected, {
		timeout: 10_000,
		timeoutMsg: `Command + S did not write the expected bytes (on disk now: ${JSON.stringify(fs.readFileSync(file, 'utf8'))})`,
	});
}

/** Leave whatever edit is open without a dialog (html block discarded; source text reverted to disk + sentinel; Done). */
async function leaveEdit(file: string): Promise<void> {
	const onDisk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
	await browser.execute(
		(editorSel, surfaceSel, text) => {
			const esc = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true });
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
		onDisk + SENTINEL,
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

// --- the html edit surface (追補q) ------------------------------------------------------------

interface GateCase {
	gate: string;
	label: string;
	/** Leaf block inside the surface (selector inside the ShadowRoot). */
	block: string;
	/** Inline element the word sits in (null = a bare text node of the block). */
	inner: string | null;
	/** The word to double-click (its first occurrence in the block's text). */
	word: string;
}

/** The gate's items (req-48.md「人間ゲート(追補q)」): a paragraph, bold, a link, a heading, a list item, a table cell. */
const Q_GATES: GateCase[] = [
	{ gate: 'q-1', label: 'paragraph middle (#p01, w20)', block: '#p01', inner: null, word: 'w20' },
	{ gate: 'q-2', label: 'inside <strong> (#p02)', block: '#p02', inner: 'strong', word: 'strong' },
	{ gate: 'q-3', label: 'inside <a> (#p02)', block: '#p02', inner: 'a', word: 'link' },
	{ gate: 'q-4', label: 'heading (#h01)', block: '#h01', inner: null, word: 'heading' },
	{ gate: 'q-5', label: 'list item, inside <strong> (#li02)', block: '#li02', inner: 'strong', word: 'w04' },
	{ gate: 'q-6', label: 'table cell (#td01)', block: '#td01', inner: null, word: 'w03' },
];

interface Aim {
	x: number;
	y: number;
	/** Character index (in the block's `textContent`) aimed at: the word's 2nd character. */
	k: number;
	wordStart: number;
	wordEnd: number;
	text: string;
	blockTag: string;
	blockId: string;
	innerTag: string | null;
	rect: { left: number; top: number; width: number; height: number };
	/** WebKit's own `caretPositionFromPoint(x, y, { shadowRoots })` for the point (offset in the block; -1 = outside / unavailable). */
	probe: { offset: number; available: boolean };
	error: string | null;
}

/** Aim at the 2nd character of `word` inside `block`: scroll it into view, take the character's rect inside the shadow tree. */
async function aimAt(c: GateCase): Promise<Aim> {
	return browser.execute(
		(surfaceSel, blockSel, innerSel, word) => {
			const out: Aim = { x: -1, y: -1, k: -1, wordStart: -1, wordEnd: -1, text: '', blockTag: '', blockId: '', innerTag: null, rect: { left: 0, top: 0, width: 0, height: 0 }, probe: { offset: -1, available: false }, error: null };
			const shadow = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot;
			const block = shadow?.querySelector<HTMLElement>(blockSel) ?? null;
			if (!shadow || !block) {
				out.error = `block ${blockSel} not in the surface`;
				return out;
			}
			const text = block.textContent ?? '';
			out.text = text;
			out.blockTag = block.tagName.toLowerCase();
			out.blockId = block.id;
			const wordStart = text.indexOf(word);
			if (wordStart < 0) {
				out.error = `word '${word}' not in ${blockSel}`;
				return out;
			}
			out.wordStart = wordStart;
			out.wordEnd = wordStart + word.length;
			const k = wordStart + 1;
			out.k = k;
			const locate = (offset: number): [Text, number] | null => {
				const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
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
			const a = locate(k);
			const b = locate(k + 1);
			if (!a || !b) {
				out.error = 'no text node for the aimed character';
				return out;
			}
			const holder = a[0].parentElement;
			out.innerTag = holder && holder !== block ? holder.tagName.toLowerCase() : null;
			if (innerSel && (!holder || holder.tagName.toLowerCase() !== innerSel)) {
				out.error = `aimed character is in <${holder?.tagName.toLowerCase() ?? '?'}>, not <${innerSel}>`;
				return out;
			}
			block.scrollIntoView({ block: 'center' });
			const range = document.createRange();
			range.setStart(a[0], a[1]);
			range.setEnd(b[0], b[1]);
			const rects = range.getClientRects();
			const r = rects.length > 0 ? rects[0]! : range.getBoundingClientRect();
			out.rect = { left: r.left, top: r.top, width: r.width, height: r.height };
			if (r.width <= 0 || r.height <= 0) {
				out.error = 'the aimed character has no rect';
				return out;
			}
			out.x = r.left + r.width * 0.25;
			out.y = r.top + r.height / 2;
			const doc = document as unknown as {
				caretPositionFromPoint?: (x: number, y: number, options?: { shadowRoots?: ShadowRoot[] }) => { offsetNode: Node; offset: number } | null;
			};
			if (typeof doc.caretPositionFromPoint === 'function') {
				out.probe.available = true;
				try {
					const pos = doc.caretPositionFromPoint(out.x, out.y, { shadowRoots: [shadow] });
					if (pos && block.contains(pos.offsetNode)) {
						const probe = document.createRange();
						probe.selectNodeContents(block);
						probe.setEnd(pos.offsetNode, pos.offset);
						out.probe.offset = probe.toString().length;
					}
				} catch {
					// recorded as unavailable
				}
			}
			return out;
		},
		HTML_SURFACE,
		c.block,
		c.inner,
		c.word,
	);
}

async function surfaceUp(): Promise<boolean> {
	return browser.execute((surfaceSel) => {
		const shadow = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot;
		return !!shadow && shadow.querySelector('#p01') !== null;
	}, HTML_SURFACE);
}

async function editableBlock(): Promise<{ tag: string; id: string; text: string } | null> {
	return browser.execute((surfaceSel) => {
		const el = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');
		return el ? { tag: el.tagName.toLowerCase(), id: el.id, text: el.textContent ?? '' } : null;
	}, HTML_SURFACE);
}

/** Index at which `after` differs from `before` when exactly one `X` was inserted (-1 otherwise). */
function insertedIndex(before: string, after: string | null): number {
	if (after === null || after.length !== before.length + 1) return -1;
	let i = 0;
	while (i < before.length && after[i] === before[i]) i++;
	return after[i] === 'X' ? i : -1;
}

/** Esc on the editable block discards the block edit; true when the block's text is back and nothing is editable. */
async function discardBlock(original: string): Promise<boolean | null> {
	const r = await browser.execute(
		(surfaceSel, orig) => {
			const shadow = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot;
			const el = shadow?.querySelector<HTMLElement>('[contenteditable="true"]');
			if (!shadow || !el) return null;
			el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }));
			const back = Array.from(shadow.querySelectorAll<HTMLElement>('[data-vellis-hid], p, h1, h2, li, td, blockquote')).some((b) => b.textContent === orig);
			return back && shadow.querySelector('[contenteditable="true"]') === null;
		},
		HTML_SURFACE,
		original,
	);
	await browser.pause(100);
	return r;
}

async function openHtmlAndEnterSurface(): Promise<void> {
	if (await surfaceUp()) return;
	await clickExplorerRow(uri(htmlFile));
	await browser.waitUntil(
		async () => browser.execute(() => document.querySelector('iframe') !== null || document.querySelector('[data-testid="html-edit-surface"], .html-find-surface') !== null),
		{ timeout: 15_000, timeoutMsg: '774-html-edit-caret.html did not open' },
	);
	await browser.pause(300);
	await emitMenu('menu_edit');
	await browser.waitUntil(surfaceUp, { timeout: 10_000, timeoutMsg: 'the html edit surface did not appear' });
	await browser.pause(300);
}

// --- the gates ----------------------------------------------------------------------------------

describe('Requirement #48 追補q・追補r human gates, driven with real keys and a real mouse (device gate)', function () {
	this.timeout(300_000);
	let currentFile: string = gateFile('a');

	before(async function () {
		if (!DEVICE) {
			this.skip();
			return;
		}
		for (const [name, value] of Object.entries({ VELLIS_GATE_BIN: bin, VELLIS_GATE_AXTOOL: axtool, VELLIS_GATE_REALINPUT: realinput, VELLIS_E2E_INITIAL_ROOT: root })) {
			if (!value) throw new Error(`${name} is not set`);
		}
		// The human gate's data must be what fixtures/edit/README.md says, byte for byte.
		for (const k of Object.keys(FIXTURES) as FixtureKey[]) {
			const f = gateFile(k);
			if (!fs.existsSync(f)) throw new Error(`fixture missing: ${f} (run-gate-spec.sh req48qr copies it)`);
			const bytes = fs.readFileSync(f);
			const same = Buffer.compare(bytes, Buffer.from(FIXTURES[k].content, 'utf8')) === 0;
			report(REPORT, { gate: '48qr-fixture-check', file: FIXTURES[k].name, same, bytes: bytes.toString('utf8') });
			if (!same) throw new Error(`${FIXTURES[k].name} does not hold the documented bytes (got ${JSON.stringify(bytes.toString('utf8'))})`);
		}
		if (!fs.existsSync(htmlFile)) throw new Error(`fixture missing: ${htmlFile}`);

		const trusted = ri(['trusted'])[0]!;
		if (trusted.trusted !== true) throw new Error('realinput is not trusted for Accessibility; input cannot be posted');
		savedInputSource = currentInputSource();
		fs.mkdirSync(SHOTS_DIR, { recursive: true });
		savedPasteboard = path.join(SHOTS_DIR, 'req48qr-pasteboard.json');
		const pb = ri(['pasteboard', 'save', savedPasteboard])[0]!;
		report(REPORT, { gate: '48qr-env', trusted, savedInputSource, pasteboard: { items: pb.items, types: pb.types }, idle: ri(['idle'])[0]!.idle_seconds, mouse: ri(['mouse'])[0] });

		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await setIpcCapture(['save_document']);
		await installPageRecorder();
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		await waitForExplorerRow(uri(gateFile('c')), { timeout: 20_000, nudgeDir: root, nudgePrefix: 'req48qr' });
		await calibrate();
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
		resetGateFiles();
		try {
			if (currentInputSource() !== ABC) setInputSource(ABC);
		} catch (err) {
			problems.inputSource = String(err);
		}
		try {
			await clearLogs();
		} catch (err) {
			problems.clearLogs = String(err);
		}
		if (Object.keys(problems).length > 0) report(REPORT, { gate: '48qr-after-each', ...problems });
	});

	after(async function () {
		if (!DEVICE) return;
		const restored = restoreUserState();
		report(REPORT, { gate: '48qr-restore', restored, inputSourceNow: ri(['inputsource', 'get'])[0]!.id });
		try {
			await restoreGateRecorder();
		} catch {
			// the page may be gone already
		}
	});

	// --- 追補q -----------------------------------------------------------------------------------

	for (const c of Q_GATES) {
		it(`gate ${c.gate}: html edit surface, ${c.label} — a real double-click on the word, then a real X → the X is inside that word`, async () => {
			currentFile = htmlFile;
			await openHtmlAndEnterSurface();
			const aim = await aimAt(c);
			if (aim.error) throw new Error(`${c.gate}: ${aim.error}`);
			await clearSelection();

			const click = await realClick(aim.x, aim.y, true);
			await browser.waitUntil(async () => (await editableBlock()) !== null, { timeout: 5_000, timeoutMsg: `${c.gate}: the real double-click did not make a block editable` });
			await browser.pause(250);
			const block = (await editableBlock())!;
			await sendText('X');
			const after = await editableBlock();
			const index = insertedIndex(aim.text, after?.text ?? null);
			const restored = await discardBlock(aim.text);
			await safeShot(`req48qr-gate-${c.gate}`);
			report(REPORT, {
				gate: `48${c.gate}-html-real-dblclick`,
				label: c.label,
				aim: { ...aim, text: aim.text.slice(0, 80) },
				route: click.route,
				dblclicks: click.mouse.filter((m) => m.type === 'dblclick').length,
				block: { tag: block.tag, id: block.id },
				afterText: after?.text,
				index,
				insideWord: index > aim.wordStart && index < aim.wordEnd,
				restored,
			});

			expect(click.mouse.filter((m) => m.type === 'dblclick').length).toBeGreaterThan(0);
			expect(block.id).toBe(aim.blockId);
			expect(block.text).toBe(aim.text);
			// One `X`, inside the double-clicked word (the double-click's word selection
			// was collapsed — otherwise the X would have replaced the word), and at
			// the aimed character ±1. Before the fix: index 0 (the block's start).
			expect(index).toBeGreaterThan(aim.wordStart);
			expect(index).toBeLessThan(aim.wordEnd);
			expect(Math.abs(index - aim.k)).toBeLessThanOrEqual(1);
			expect(restored).toBe(true);
		});
	}

	// --- 追補r -----------------------------------------------------------------------------------

	it('gate r-1: `abc` → a real Return at the end → a real Command + S → the file is `abc\\n` (before the fix `abc\\n\\n`)', async () => {
		currentFile = gateFile('b');
		await enterEditor('b');
		await clearLogs();
		await placeCaret(FIXTURES.b.content.length);
		await sendKey(KEY.return);
		const afterReturn = await editorSnapshot();
		await saveAndWaitForDisk(currentFile, 'abc\n');
		const disk = diskBytes(currentFile);
		const saves = await saveCalls();
		await safeShot('req48qr-gate-r1');
		report(REPORT, { gate: '48r-1-return-at-end', afterReturn: { text: afterReturn.text, lf: afterReturn.lf, caret: afterReturn.caret, hasDivOrBr: afterReturn.hasDivOrBr }, disk, saves });

		expect(afterReturn.hasDivOrBr).toBe(false);
		expect(disk.text).toBe('abc\n');
		expect(disk.lf).toBe(1);
		expect(saves.length).toBe(1);
		expect(saves[0]!.ok).toBe(true);
		expect(saves[0]!.content).toBe('abc\n');
	});

	it('gate r-2: `abc\\n` → a real Return at the end of `abc` → a real `x` → a real Command + S → the file is `abc\\nx\\n` (before the fix `abc\\nx`)', async () => {
		currentFile = gateFile('a');
		await enterEditor('a');
		await clearLogs();
		await placeCaret(3);
		await sendKey(KEY.return);
		await sendText('x');
		const afterType = await editorSnapshot();
		await saveAndWaitForDisk(currentFile, 'abc\nx\n');
		const disk = diskBytes(currentFile);
		const saves = await saveCalls();
		await safeShot('req48qr-gate-r2');
		report(REPORT, { gate: '48r-2-return-then-x', afterType: { text: afterType.text, lf: afterType.lf, caret: afterType.caret }, disk, saves });

		expect(afterType.text).toBe('abc\nx\n' + SENTINEL);
		expect(disk.text).toBe('abc\nx\n');
		expect(disk.lf).toBe(2);
		expect(saves.length).toBe(1);
		expect(saves[0]!.content).toBe('abc\nx\n');
	});

	it('gate r-3: `abc\\n` → a real `x` on the last empty line → a real Command + Z (Edit menu) → the buffer is `abc\\n`: Command + S leaves the file `abc\\n`, Done asks nothing', async () => {
		currentFile = gateFile('a');
		await enterEditor('a');
		await clearLogs();
		// The last empty line = after the source's final `\n`, before the sentinel.
		await placeCaret(FIXTURES.a.content.length);
		await sendText('x');
		const typed = await editorSnapshot();
		await sendKey(KEY.z, ['cmd']);
		const undone = await editorSnapshot();
		const rec = await readPageRecord();
		// Command + S: the buffer equals the source, so either nothing is written
		// (not dirty) or the same bytes are; the file must read `abc\n` either way.
		await sendKey(KEY.s, ['cmd']);
		await browser.pause(1_000);
		const disk = diskBytes(currentFile);
		const saves = await saveCalls();
		const left = await leaveEditorExpectingNoAsk();
		await safeShot('req48qr-gate-r3');
		report(REPORT, { gate: '48r-3-undo-on-last-line', typed: { text: typed.text, lf: typed.lf }, undone: { text: undone.text, lf: undone.lf, caret: undone.caret, hasDivOrBr: undone.hasDivOrBr }, undoInputs: rec.inputs, disk, saves, left });

		expect(typed.text).toBe('abc\nx' + SENTINEL);
		// The real undo went through WebKit's undo manager (the menu's `undo:`).
		expect(rec.inputs.some((i) => i.inputType === 'historyUndo')).toBe(true);
		// 契約8: the restored placeholder and the re-added sentinel do not pile up.
		expect(undone.text).toBe(FIXTURES.a.content + SENTINEL);
		expect(undone.lf).toBe(2);
		expect(undone.hasDivOrBr).toBe(false);
		expect(disk.text).toBe('abc\n');
		for (const s of saves) expect(s.content).toBe('abc\n');
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
	});

	it('gate r-4: `abc` → a real Return → Command + Z → Command + Shift + Z (redo) → the typed line break survives: Command + S → `abc\\n`', async () => {
		currentFile = gateFile('b');
		await enterEditor('b');
		await clearLogs();
		await placeCaret(FIXTURES.b.content.length);
		await sendKey(KEY.return);
		const afterReturn = await editorSnapshot();
		await sendKey(KEY.z, ['cmd']);
		const undone = await editorSnapshot();
		await sendKey(KEY.z, ['cmd', 'shift']);
		const redone = await editorSnapshot();
		const rec = await readPageRecord();
		await saveAndWaitForDisk(currentFile, 'abc\n');
		const disk = diskBytes(currentFile);
		const saves = await saveCalls();
		await safeShot('req48qr-gate-r4');
		report(REPORT, { gate: '48r-4-undo-redo-return', afterReturn: { text: afterReturn.text }, undone: { text: undone.text, lf: undone.lf }, redone: { text: redone.text, lf: redone.lf, hasDivOrBr: redone.hasDivOrBr }, inputs: rec.inputs, disk, saves });

		expect(rec.inputs.some((i) => i.inputType === 'historyUndo')).toBe(true);
		expect(rec.inputs.some((i) => i.inputType === 'historyRedo')).toBe(true);
		expect(undone.text).toBe(FIXTURES.b.content + SENTINEL);
		// 契約8-1: after the redo the `<pre>` is `abc` + the typed `\n` + the sentinel.
		expect(redone.text).toBe('abc\n' + SENTINEL);
		expect(redone.hasDivOrBr).toBe(false);
		expect(disk.text).toBe('abc\n');
		expect(saves.length).toBe(1);
		expect(saves[0]!.content).toBe('abc\n');
	});

	it('gate r-5: `abc\\n` → select everything → a real Command + C → the clipboard text is the source `abc\\n` (no sentinel; before the fix `abc\\n\\n`)', async () => {
		currentFile = gateFile('a');
		await enterEditor('a');
		await clearLogs();
		// A marker first, so a copy that wrote nothing is told apart from the source.
		ri(['pasteboard', 'set-text', 'MARKER-before-copy']);
		await placeCaret(0);
		await sendKey(KEY.a, ['cmd']);
		let selection = await editorSnapshot();
		let selectedBy = 'cmd-a';
		if (selection.selected !== FIXTURES.a.content + SENTINEL) {
			// Command + A did not select the whole `<pre>` (sentinel included): select it from the page.
			await placeCaret(0, (FIXTURES.a.content + SENTINEL).length);
			selection = await editorSnapshot();
			selectedBy = 'range';
		}
		await sendKey(KEY.c, ['cmd']);
		await browser.pause(300);
		const clipboard = clipboardText();
		const afterCopy = await editorSnapshot();
		await safeShot('req48qr-gate-r5');
		report(REPORT, { gate: '48r-5-real-copy', selectedBy, selected: selection.selected, clipboard, afterCopyText: afterCopy.text });

		// The selection covered the sentinel (WKWebView: `abc\n\n`) and the copy left it out (契約9).
		expect(selection.selected).toBe(FIXTURES.a.content + SENTINEL);
		expect(clipboard).toBe(FIXTURES.a.content);
		expect(afterCopy.text).toBe(FIXTURES.a.content + SENTINEL);
		expect(fs.readFileSync(currentFile, 'utf8')).toBe(FIXTURES.a.content);
	});

	it('gate r-6: the CRLF file → a real Return at the end of `third line` → a real `x` → Command + S → the final `\\r\\n` stays (the inserted break is LF)', async () => {
		currentFile = gateFile('d');
		const source = FIXTURES.d.content;
		await enterEditor('d');
		await clearLogs();
		await placeCaret(source.length - 2);
		await sendKey(KEY.return);
		await sendText('x');
		const afterType = await editorSnapshot();
		const expected = 'first line\r\nsecond line\r\nthird line\nx\r\n';
		await saveAndWaitForDisk(currentFile, expected);
		const disk = diskBytes(currentFile);
		const saves = await saveCalls();
		await safeShot('req48qr-gate-r6');
		report(REPORT, { gate: '48r-6-crlf-return-then-x', afterType: { text: afterType.text, lf: afterType.lf }, disk, saves });

		expect(afterType.text).toBe(expected + SENTINEL);
		expect(disk.text).toBe(expected);
		expect(disk.text.endsWith('\r\n')).toBe(true);
		expect(disk.cr).toBe(3);
		expect(disk.lf).toBe(4);
		expect(saves.length).toBe(1);
		expect(saves[0]!.content).toBe(expected);
	});
});
