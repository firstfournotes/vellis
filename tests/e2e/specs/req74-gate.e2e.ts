import { browser } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
	clickExplorerRow,
	emitMenu,
	installGateRecorder,
	invokeFromPage,
	readCapturedIpc,
	readGateRecord,
	report,
	restoreGateRecorder,
	setIpcCapture,
	SHOTS_DIR,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

/**
 * Requirement #74, stage 1 (code files and plain text open straight into a CodeMirror 6
 * face; the shared skeleton) — the machine-checkable part of the human gates 6・8・9・10・11・
 * 14・15 of docs/requirements/req-74.md (「人間ゲート」節, the parts that concern the
 * CodeMirror face), driven against the live webview of a dev-features webdriver build
 * (`scripts/gate-device/req74-gate.sh` → this spec). 要件74 2-5 の撤去の後: the face is a normal feature —
 * no `VELLIS_FLAGS=editor_file`; dev-features only for `ai_marks`.
 *
 * Each judgement is one JSON line in `$VELLIS_GATE_SHOTS/req74-report.jsonl` (`pass` true /
 * false; a line without `pass` is a fact or a screenshot left to the eye; `human: true`
 * marks what stays with a person — colours against the print, the feel of typing in
 * Japanese, whether one types by mistake, how heavy a 5 MB log feels).
 *
 *  - gate 11  every code / plain file opens into the face (`[data-testid="code-editor"]` with a
 *             `.cm-editor`), no `pre.vellis-plaintext` on screen, `data-vellis-lang` and the
 *             line-number gutter only for code (settings.json = json = gutter; 由谷 2026-11-16),
 *             the toolbar has no Done Editing; real typing changes the document and raises the
 *             Unsaved badge; a real Return keeps the indent, a real Tab inserts the file's unit,
 *             `(` alone; a real Command + S on crlf.txt keeps every `\r\n` and changes only the
 *             touched line (the file's bytes), the snapshot is taken, no `.vellis-tmp` is left
 *  - gate 9   real Command + Z / Shift + Command + Z and Edit ▸ Undo / Redo by AX (the native
 *             `undo:` → `beforeinput` historyUndo) reach the CodeMirror history
 *  - gate 14  View ▸ Appearance ▸ Dark / Light by AX: `data-code-theme` follows, the document /
 *             the Unsaved badge / undo survive; the plain-text column is as wide as a Markdown
 *             paragraph and Toggle Full Width widens it; the code column is not capped
 *  - gate 15  a real Command + R on a dirty face → one Unsaved Changes dialog; Cancel keeps the
 *             edit; Don't Save reloads (the badge goes, the file's text is back)
 *  - gate 6   writes from outside (an atomic rename, as editors save): a clean face follows
 *             silently; a dirty face with a non-overlapping change merges (notice, Command + Z
 *             keeps the external part); an overlapping change raises the conflict banner and the
 *             document stays; **a real Command + S then runs `save_document` for real**: refused
 *             with "The file was changed on disk", the file's bytes unchanged, no new snapshot, no
 *             `.vellis-tmp` (AC-74-16 end to end); Keep My Edits → the next save writes; Use the
 *             File on Disk → the disk's text, not dirty; the file removed under a dirty face →
 *             the removed banner, Save writes it back; a stale `expectedHash` straight through the
 *             page's invoke is refused the same way
 *  - gate 8   Find on the face counts every match of the whole document (not only the drawn
 *             lines), Next moves the current match; Zoom In to 150 % scales the face's font-size
 *             (no CSS zoom on it or its ancestors) and a real click still lands the caret on the
 *             clicked character; `beforeprint` builds the print rendering from the face's text
 *             (the printed PDF itself = 【人】); a real Command + C carries the selection with
 *             `\r\n`, a real Command + V pastes LF lines as `\r\n` (the user's clipboard saved and
 *             put back)
 *  - gate 10  a 5 MB log and a 50,000-line TypeScript file: time to the face, the latency of a
 *             real keystroke, Command + ↓ to the end, the find count — recorded, with loose bounds
 *             (the feel = 【人】)
 *
 * The operator (`req74-gate.sh`) takes the steps the page cannot: real keys / clicks, the
 * native menus, dialogs, the clipboard, screenshots. This spec writes
 * `<SHOTS_DIR>/req74-op/req-<n>.json` and waits for `ack-<n>.json`. Without the driver
 * (VELLIS_GATE_REQ74_OPERATOR unset) those steps are reported as skipped.
 *
 * Stages 2〜4 (第2段 the ProseMirror face of Markdown・第3段 input rules / tables / replace / the native
 * right-click menu / the gap cursor・第4段 the diff views / the formatting toolbar / the selection bar / the
 * per-item list rewrite / the link editor): the machine part of the human gates 1〜10・12・13 and of the
 * stage-4 checks (docs/review/req74-stage34-prep.md (G)), on the fixtures ai-report.md ほか
 * (req74-fixtures.sh). How to read the rows and what a person tries by hand: docs/req74-stage24-device.md.
 * A native menu (the editor's own menu of Tauri's menu API, WebKit's, a <select>'s list) holds the app's
 * main thread in its tracking loop, so it is opened, read and pressed in one operator step (`popup`).
 *
 * VELLIS_GATE_REQ74_STAGE picks the stages (`1` | `2-4` | `2,3` …; unset / `all` = every stage); the its
 * of the other stages are skipped (pending).
 *
 * Runs only under `scripts/gate-device/req74-gate.sh` (VELLIS_GATE_DEVICE=1).
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const VARIANT = process.env.VELLIS_GATE_VARIANT ?? 'dev';
const OPERATOR = process.env.VELLIS_GATE_REQ74_OPERATOR === '1';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const realinput = process.env.VELLIS_GATE_REALINPUT ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';
const REPORT = 'req74-report.jsonl';
const OP_DIR = path.join(SHOTS_DIR, 'req74-op');

/**
 * Which stages run (VELLIS_GATE_REQ74_STAGE: `1` | `2-4` | a comma list of 1〜4, ranges and `diag`; unset / `all` = 1〜4).
 * `diag` (2026-11-20) = the diagnosis D1〜D6; never part of `all`.
 */
function stagesOf(v: string | undefined): Set<number> {
	if (!v || v === 'all') return new Set([1, 2, 3, 4]);
	const out = new Set<number>();
	for (const part of v.split(',')) {
		if (part.trim() === 'diag' || part.trim() === 'diag-b5') continue;
		const m = /^([1-4])(?:-([1-4]))?$/.exec(part.trim());
		if (!m) throw new Error(`VELLIS_GATE_REQ74_STAGE=${v}: expected all | 1 | 2-4 | a comma list of 1〜4, ranges, diag and diag-b5`);
		for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n++) out.add(n);
	}
	return out;
}
const STAGES = stagesOf(process.env.VELLIS_GATE_REQ74_STAGE);
/** The diagnosis D1〜D6 (stage `diag`: only when named). */
const DIAG = (process.env.VELLIS_GATE_REQ74_STAGE ?? '').split(',').some((p) => p.trim() === 'diag');
/** An it of stage `stage`: run when that stage is selected, else pending. */
function itStage(stage: number, title: string, fn: () => Promise<void>): void {
	if (STAGES.has(stage)) it(title, fn);
	else it.skip(title, fn);
}
/** An it of the diagnosis (stage `diag`), else pending. */
function itDiag(title: string, fn: () => Promise<void>): void {
	if (DIAG) it(title, fn);
	else it.skip(title, fn);
}
/** The short B.5 heading diagnosis (stage `diag-b5`: 由谷の決定 2026-11-20 21:40 (2); only when named). */
const DIAG_B5 = (process.env.VELLIS_GATE_REQ74_STAGE ?? '').split(',').some((p) => p.trim() === 'diag-b5');
function itDiagB5(title: string, fn: () => Promise<void>): void {
	if (DIAG_B5) it(title, fn);
	else it.skip(title, fn);
}

const fileOf = (rel: string) => path.join(root, rel);
const uriOf = (rel: string) => `file://${fileOf(rel).split(path.sep).join('/')}`;

/** macOS virtual keycodes (US ANSI). */
const KEY = { s: 1, c: 8, v: 9, z: 6, r: 15, return: 36, tab: 48, escape: 53, down: 125, right: 124, left: 123, home: 115, end: 119 } as const;

// The face's DOM (src/components/CodeEditor.svelte / Viewer.svelte).
const FACE = 'article.viewer [data-testid="code-editor"]';
const CM = `${FACE} .cm-editor`;
const CONTENT = `${FACE} .cm-content`;
const LINE = `${FACE} .cm-line`;
const GUTTER = `${FACE} .cm-gutters`;
const SURFACE = `${FACE} .code-editor-surface`;
const BADGE = 'article.viewer [data-testid="unsaved-badge"]';
const PLAIN_PRE = 'article.viewer .markdown-body > pre.vellis-plaintext';
const EDIT_DONE = '[data-testid="edit-done"]';
const CONFLICT = '[data-testid="external-conflict-banner"]';
const CONFLICT_KEEP = '[data-testid="external-conflict-keep"]';
const CONFLICT_DISK = '[data-testid="external-conflict-disk"]';
const MERGED = '[data-testid="external-merged-notice"]';
const REMOVED = '[data-testid="external-removed-banner"]';
const REMOVED_SAVE = '[data-testid="external-removed-save"]';
const CHANGE_BANNER = '[data-testid="external-change-banner"]';
const FIND_INPUT = '[data-testid="find-input"]';
const FIND_COUNT = '[data-testid="find-count"]';
const PRINT = '[data-testid="code-editor-print"]';
const EXPLORER_HEADER = '.explorer-header';
const SAVE_CONFLICT_PREFIX = 'The file was changed on disk';

/** Which fixtures carry a language (gutter + data-vellis-lang) and which are plain text. */
const FILES: Array<{ rel: string; lang: string | null }> = [
	{ rel: 'app.ts', lang: 'typescript' },
	{ rel: 'main.rs', lang: 'rust' },
	{ rel: 'tool.py', lang: 'python' },
	{ rel: 'config.yaml', lang: 'yaml' },
	{ rel: 'run.sh', lang: 'shellscript' },
	{ rel: 'query.graphql', lang: 'graphql' },
	{ rel: 'settings.json', lang: 'json' },
	{ rel: 'notes.txt', lang: null },
	{ rel: 'crlf.txt', lang: null },
	{ rel: 'mixed.txt', lang: null },
	{ rel: 'bom.txt', lang: null },
	{ rel: 'japanese.txt', lang: null },
];

// --- the tools (pid-pinned child processes, as req84) ------------------------------------

function tool(exe: string, args: string[]): Record<string, unknown>[] {
	let out: string;
	try {
		out = execFileSync(exe, args, { encoding: 'utf8', timeout: 30_000, env: { ...process.env, AXTOOL_EXPECT_EXE: bin, REALINPUT_EXPECT_EXE: bin } });
	} catch (e) {
		const err = e as { stderr?: string; message?: string };
		throw new Error(`${path.basename(exe)} ${args.join(' ')} failed: ${err.stderr?.trim() || err.message}`);
	}
	return out.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
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
	frontmost_pid?: number;
	focused_window: { title: string } | null;
}
async function ensureFront(pid: number): Promise<FrontInfo> {
	let f = ri(['front', String(pid)])[0] as unknown as FrontInfo;
	if (!f.ok) {
		ax(['raise', String(pid), '0']);
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			await browser.pause(200);
			f = ri(['front', String(pid)])[0] as unknown as FrontInfo;
			if (f.ok) break;
		}
	}
	if (!f.ok) throw new Error(`the app is not frontmost with a focused window: ${JSON.stringify(f)}`);
	return f;
}

// --- the operator (scripts/gate-device/req74-gate.sh) -----------------------------------

let opSeq = 0;
async function operator(step: string, args: Record<string, unknown> = {}, timeoutMs = 90_000): Promise<Record<string, unknown> | null> {
	if (!OPERATOR) return null;
	fs.mkdirSync(OP_DIR, { recursive: true });
	const seq = ++opSeq;
	const req = path.join(OP_DIR, `req-${seq}.json`);
	const ack = path.join(OP_DIR, `ack-${seq}.json`);
	const tmp = `${req}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ seq, step, args, at: Date.now() }));
	fs.renameSync(tmp, req);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(ack)) {
			const text = fs.readFileSync(ack, 'utf8');
			if (text.trim() !== '') {
				const answer = JSON.parse(text) as Record<string, unknown>;
				report(REPORT, { gate: 'operator', side: VARIANT, step, args, answer });
				return answer;
			}
		}
		await browser.pause(300);
	}
	throw new Error(`operator step ${step} (#${seq}) was not answered within ${timeoutMs} ms`);
}

// --- page hooks: mouse + keys (the IPC goes through the gate recorder's capture) ------------

interface MouseRec {
	type: string;
	clientX: number;
	clientY: number;
	target: string;
	/** Stages 2〜4: the modifiers and the click count the page saw (a Shift that stayed held = run 1 of 第2〜4段). */
	shift?: boolean;
	alt?: boolean;
	detail?: number;
	at?: number;
}
interface KeyRec {
	/** Stages 2〜4: the legacy keyCode (229 = the IME took the key) and isComposing. */
	keyCode?: number;
	isComposing?: boolean;
	key: string;
	meta: boolean;
	shift: boolean;
	at: number;
}
interface Hooks {
	mouse: MouseRec[];
	keys: KeyRec[];
	/** Stages 2〜4: the `beforeinput` input types the page saw (formatBold = WebKit took Command + B itself). */
	inputs?: Array<{ type: string; at: number; target: string; data?: string | null; sel?: string | null }>;
}
async function installHooks(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __gate74?: Hooks };
		if (w.__gate74) return;
		const g: Hooks = { mouse: [], keys: [], inputs: [] };
		w.__gate74 = g;
		const describe = (t: EventTarget | null) => {
			const el = t as Element | null;
			if (!el || !el.tagName) return '';
			const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(' ').join('.')}` : '';
			return `${el.tagName.toLowerCase()}${cls}`;
		};
		for (const type of ['mousedown', 'mouseup', 'dblclick']) {
			window.addEventListener(type, (e) => {
				const m = e as MouseEvent;
				g.mouse.push({ type: m.type, clientX: m.clientX, clientY: m.clientY, target: describe(m.target), shift: m.shiftKey, alt: m.altKey, detail: m.detail, at: Date.now() });
			}, true);
		}
		window.addEventListener('keydown', (e) => g.keys.push({ key: e.key, meta: e.metaKey, shift: e.shiftKey, at: Date.now(), keyCode: e.keyCode, isComposing: e.isComposing }), true);
		// Where the DOM selection is when the event fires (the IME places its text there): the nearest block element.
		const selAt = () => {
			const n = document.getSelection()?.anchorNode ?? null;
			const el = n instanceof Element ? n : (n?.parentElement ?? null);
			const b = el?.closest('td, th, p, li, h1, h2, h3, pre, div.ProseMirror');
			return b ? `${b.tagName.toLowerCase()}:${(b.textContent ?? '').slice(0, 16)}@${document.getSelection()?.anchorOffset ?? '?'}` : null;
		};
		window.addEventListener('beforeinput', (e) => g.inputs!.push({ type: (e as InputEvent).inputType, at: Date.now(), target: describe(e.target), data: (e as InputEvent).data, sel: selAt() }), true);
		for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) window.addEventListener(type, (e) => g.inputs!.push({ type, at: Date.now(), target: describe(e.target), data: (e as CompositionEvent).data, sel: selAt() }), true);
	});
}
async function hooks(): Promise<Hooks> {
	return browser.execute(() => {
		const g = (window as unknown as { __gate74?: Hooks }).__gate74;
		if (!g) throw new Error('hooks are not installed');
		return JSON.parse(JSON.stringify(g)) as Hooks;
	});
}
async function mouseMark(): Promise<number> {
	return (await hooks()).mouse.length;
}
async function mouseAfter(mark: number): Promise<MouseRec[]> {
	return (await hooks()).mouse.slice(mark);
}
async function keysMark(): Promise<number> {
	return (await hooks()).keys.length;
}
async function keysAfter(mark: number): Promise<KeyRec[]> {
	return (await hooks()).keys.slice(mark);
}
/** Stages 2〜4: everything the page saw since `mark` (from `pageMark`): keys, mouse, beforeinput. */
async function pageMark(): Promise<{ keys: number; mouse: number; inputs: number }> {
	const h = await hooks();
	return { keys: h.keys.length, mouse: h.mouse.length, inputs: h.inputs?.length ?? 0 };
}
async function pageSince(m: { keys: number; mouse: number; inputs: number }) {
	const h = await hooks();
	return { keys: h.keys.slice(m.keys), mouse: h.mouse.slice(m.mouse), inputs: (h.inputs ?? []).slice(m.inputs) };
}

// --- page helpers -----------------------------------------------------------------------

async function exists(selector: string): Promise<boolean> {
	return browser.execute((s) => document.querySelector(s) !== null, selector);
}
async function waitFor(selector: string, what: string, timeout = 20_000): Promise<void> {
	await browser.waitUntil(async () => exists(selector), { timeout, timeoutMsg: `${what}: ${selector} never appeared` });
}
async function waitGone(selector: string, what: string, timeout = 10_000): Promise<void> {
	await browser.waitUntil(async () => !(await exists(selector)), { timeout, timeoutMsg: `${what}: ${selector} is still there` });
}
async function textOf(selector: string): Promise<string> {
	return browser.execute((s) => document.querySelector(s)?.textContent ?? '', selector);
}
async function attrOf(selector: string, name: string): Promise<string | null> {
	return browser.execute((s, n) => document.querySelector(s)?.getAttribute(n) ?? null, selector, name);
}
/** The drawn lines of the face (CodeMirror draws the viewport only: every line of a small file). */
async function faceLines(): Promise<string[]> {
	return browser.execute((s) => Array.from(document.querySelectorAll<HTMLElement>(s)).map((l) => l.textContent ?? ''), LINE);
}
async function faceText(): Promise<string> {
	return (await faceLines()).join('\n');
}
/**
 * The whole document of the face from its EditorView (CodeMirror draws only the viewport, so the drawn
 * lines are not the document for anything longer than a screen). `.cm-content` carries the view's tile
 * (`EditorView.findFromDOM`); falls back to the drawn lines when that internal is not there.
 */
async function docText(): Promise<string> {
	const t = await browser.execute((s) => {
		const c = document.querySelector(`${s} .cm-content`) as unknown as { cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } } } | null;
		return c?.cmTile?.root?.view?.state.doc.toString() ?? null;
	}, FACE);
	return t ?? faceText();
}
async function viewFacts(): Promise<{ head: number; anchor: number; length: number; lastLine: string } | null> {
	return browser.execute((s) => {
		const c = document.querySelector(`${s} .cm-content`) as unknown as { cmTile?: { root?: { view?: { state: { doc: { length: number; lines: number; line(n: number): { text: string } }; selection: { main: { head: number; anchor: number } } } } } } } | null;
		const st = c?.cmTile?.root?.view?.state;
		return st ? { head: st.selection.main.head, anchor: st.selection.main.anchor, length: st.doc.length, lastLine: st.doc.line(st.doc.lines).text } : null;
	}, FACE);
}
async function waitFaceLine(index: number, needle: string, timeout = 10_000): Promise<void> {
	await browser.waitUntil(async () => ((await faceLines())[index] ?? '').includes(needle), {
		timeout,
		timeoutMsg: `line ${index + 1} of the face never showed "${needle}" (now: ${JSON.stringify(((await faceLines())[index] ?? '').slice(0, 80))})`,
	});
}
interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}
async function rectOf(selector: string): Promise<Rect | null> {
	return browser.execute((s) => {
		const el = document.querySelector(s);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	}, selector);
}
/**
 * The viewport point of character `col` (0 based, the caret BEFORE that character) of the
 * drawn line `lineIndex` (0 based): a Range on the line's text, clamped to the line's length.
 */
async function charPoint(lineIndex: number, col: number): Promise<{ x: number; y: number; text: string; inside: boolean } | null> {
	return browser.execute(
		(sel, li, c) => {
			const line = document.querySelectorAll<HTMLElement>(sel)[li];
			if (!line) return null;
			const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
			let remaining = c;
			let node: Text | null = null;
			let offset = 0;
			while (walker.nextNode()) {
				const t = walker.currentNode as Text;
				if (remaining <= t.data.length) {
					node = t;
					offset = remaining;
					break;
				}
				remaining -= t.data.length;
			}
			const range = document.createRange();
			if (node) {
				range.setStart(node, offset);
				range.setEnd(node, offset);
			} else {
				range.selectNodeContents(line);
				range.collapse(false);
			}
			const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
			const lr = line.getBoundingClientRect();
			const x = Math.round(r.x || lr.x + lr.width);
			const y = Math.round((r.height ? r.y + r.height / 2 : lr.y + lr.height / 2));
			const inside = x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight;
			return { x, y, text: line.textContent ?? '', inside };
		},
		LINE,
		lineIndex,
		col,
	);
}
/** The caret's viewport x (the `.cm-cursor` CodeMirror draws). */
async function caretX(): Promise<number | null> {
	return browser.execute((s) => {
		const c = document.querySelector<HTMLElement>(`${s} .cm-cursor`);
		if (c) return c.getBoundingClientRect().x;
		const sel = document.getSelection();
		if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
		const range = sel.getRangeAt(0);
		const face = document.querySelector(s);
		if (!face || !face.contains(range.startContainer)) return null;
		const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
		return rect && (rect.width > 0 || rect.height > 0) ? rect.x : null;
	}, FACE);
}
async function closeOverlays(): Promise<string[]> {
	return browser.execute(() => {
		const click = (s: string) => {
			const el = document.querySelector(s) as HTMLElement | null;
			if (el) el.click();
			return el !== null;
		};
		const out: string[] = [];
		if (click('[data-testid="find-in-folder-close"]')) out.push('find-in-folder');
		if (click('[data-testid="find-close"]')) out.push('find-bar');
		if (click('[data-testid="go-to-close"]')) out.push('go-to-bar');
		if (click('.update-banner .update-close')) out.push('update-banner');
		if (document.querySelector('.context-menu')) {
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			out.push('context-menu');
		}
		return out;
	});
}
/** Open a document of the root by its Explorer row and wait for the face (or `waitSel`). */
async function openDoc(rel: string, waitSel: string = CM, marker?: string): Promise<number> {
	await closeOverlays();
	const t0 = Date.now();
	await clickExplorerRow(uriOf(rel));
	await waitFor(waitSel, `open ${rel}`, 60_000);
	if (marker) {
		await browser.waitUntil(async () => (await faceText()).includes(marker), { timeout: 20_000, timeoutMsg: `the face never showed "${marker}"` });
	}
	const ms = Date.now() - t0;
	await browser.pause(400);
	return ms;
}

// --- files outside the app -------------------------------------------------------------------

function sha256(file: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
/** As an editor saves: write a sibling and rename it over the file (a new inode). */
function writeAtomic(abs: string, content: string | Buffer): void {
	const tmp = `${abs}.req74-tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, abs);
}
function readBytes(rel: string): string {
	return fs.readFileSync(fileOf(rel), 'utf8');
}
const snapshotsDir = () => path.join(root, '.vellis', 'snapshots');
function snapshotCount(): number {
	return fs.existsSync(snapshotsDir()) ? fs.readdirSync(snapshotsDir()).length : 0;
}
function tmpLeftovers(): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of fs.readdirSync(d)) {
			const abs = path.join(d, name);
			if (name.endsWith('.vellis-tmp')) out.push(path.relative(root, abs));
			if (fs.statSync(abs).isDirectory() && name !== '.vellis') walk(abs);
		}
	};
	walk(root);
	return out;
}
/** Case-insensitive, non-overlapping, left to right (要件54 契約3 = findMatches). */
function countMatches(text: string, query: string): number {
	if (!query) return 0;
	const hay = text.toLowerCase();
	const q = query.toLowerCase();
	let n = 0;
	for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) n++;
	return n;
}
/** The `save_document` round trips captured since `mark` (args + ok + body). */
async function savesSince(mark: number) {
	return (await readCapturedIpc()).slice(mark).filter((c) => c.cmd === 'save_document');
}
async function captureMark(): Promise<number> {
	return (await readCapturedIpc()).length;
}

// --- real input: the screen (calibration as req84) ------------------------------------------

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
	return { x: Math.round(screen.frame.x + screen.dx + clientX), y: Math.round(screen.frame.y + screen.dy + clientY) };
}
function refreshFrame(pid: number): void {
	if (!screen) return;
	const wins = ax(['cgwins', String(pid)]).filter((w) => w.onscreen === true);
	const w = wins.sort((a, b) => (b.w as number) * (b.h as number) - (a.w as number) * (a.h as number))[0];
	if (w) screen.frame = { x: w.x as number, y: w.y as number, w: w.w as number, h: w.h as number, number: w.number as number };
}
let realInputBlocked: string | null = null;
let calibrationBlocked: string | null = null;
async function calibrate(pid: number): Promise<void> {
	const wins = ax(['cgwins', String(pid)]).filter((w) => w.onscreen === true);
	if (wins.length === 0) throw new Error('the test app has no on-screen window');
	const w = wins.sort((a, b) => (b.w as number) * (b.h as number) - (a.w as number) * (a.h as number))[0]!;
	const inner = await browser.execute(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }));
	const guess = { dx: Math.round(((w.w as number) - inner.innerWidth) / 2), dy: (w.h as number) - inner.innerHeight };
	screen = { pid, frame: { x: w.x as number, y: w.y as number, w: w.w as number, h: w.h as number, number: w.number as number }, dx: guess.dx, dy: guess.dy, route: 'pid' };
	const block = (item: string, extra: Record<string, unknown>) => {
		calibrationBlocked = item;
		realInputBlocked = item;
		report(REPORT, { gate: 'environment', side: VARIANT, item, reason: item, ...extra });
	};
	if (!OPERATOR) {
		block('no operator: the calibration click cannot be sent, so no real input in this run', {});
		return;
	}
	try {
		await ensureFront(pid);
	} catch (e) {
		block(`the app could not be brought to the front for the calibration click (${String(e)})`, {});
		return;
	}
	const header = await rectOf(EXPLORER_HEADER);
	const toolbar = await rectOf('article.viewer .viewer-toolbar');
	const candidates: Array<{ name: string; x: number; y: number }> = [];
	if (header) {
		const cy = Math.round(header.y + header.height / 2);
		candidates.push({ name: 'explorer header centre', x: Math.round(header.x + header.width / 2), y: cy });
		candidates.push({ name: 'explorer header left', x: Math.round(header.x + 24), y: cy });
	}
	if (toolbar) candidates.push({ name: 'viewer toolbar right end', x: Math.round(toolbar.x + toolbar.width - 40), y: Math.round(toolbar.y + toolbar.height / 2) });
	const tried: Array<Record<string, unknown>> = [];
	let chosen: { name: string; x: number; y: number; s: { x: number; y: number } } | null = null;
	for (const c of candidates) {
		const s = toScreen(c.x, c.y);
		const at = await operator('windowat', { x: s.x, y: s.y });
		tried.push({ candidate: c, screen: s, windowat: at });
		if (at?.app_window === true) {
			chosen = { ...c, s };
			break;
		}
	}
	if (!chosen) {
		block('no calibration point lies under the app’s own window (something covers the Explorer header and the toolbar); no real input in this run', { tried });
		return;
	}
	let md: MouseRec | undefined;
	const attempts: Array<{ route: string; answer: Record<string, unknown> | null }> = [];
	for (const route of ['hid', 'pid'] as const) {
		const before = await mouseMark();
		const answer = await operator('click', { x: chosen.s.x, y: chosen.s.y, route }, 240_000);
		await browser.pause(400);
		attempts.push({ route, answer });
		if (answer?.idle_short === true) {
			block(`the user was at the keyboard (idle ${String(answer.idle_s)} s) when the calibration click was due; no real input in this run`, { answer });
			return;
		}
		md = (await mouseAfter(before)).find((m) => m.type === 'mousedown');
		if (md) {
			screen.route = route;
			break;
		}
	}
	if (!md) {
		block(`the calibration click at ${chosen.name} was not seen by the page on either route; no real input in this run`, { chosen, attempts });
		return;
	}
	const measured = { dx: chosen.s.x - screen.frame.x - md.clientX, dy: chosen.s.y - screen.frame.y - md.clientY };
	const drift = { dx: measured.dx - guess.dx, dy: measured.dy - guess.dy };
	screen.dx = measured.dx;
	screen.dy = measured.dy;
	report(REPORT, { gate: 'calibration', side: VARIANT, pid, window: w, inner, guess, measured, drift, mousedown: md, chosen, tried, attempts });
	if (Math.abs(drift.dx) > 4 || Math.abs(drift.dy) > 4) block(`the calibration click drifted by ${JSON.stringify(drift)}; no real input in this run`, { drift });
}
function requireRealInput(): void {
	if (realInputBlocked) throw new Error(`environment: ${realInputBlocked}`);
}
function environment(gate: number | string, item: string, extra: Record<string, unknown> = {}): never {
	const frontApp = (extra.answer as { front_app?: unknown } | undefined)?.front_app ?? null;
	const reason = `${item}${frontApp ? ` (front app: ${JSON.stringify(frontApp)})` : ''}`;
	realInputBlocked = reason;
	report(REPORT, { gate: 'environment', side: VARIANT, item, reason, ...extra });
	throw new Error(`environment: ${reason}`);
}
/** A real key through the operator (sent only in front, only when the user is idle). */
async function realKey(keycode: number, mods: string[] = [], settleMs = 600, route?: 'pid' | 'hid'): Promise<Record<string, unknown> | null> {
	requireRealInput();
	const a = await operator('key', route ? { keycode, mods, route } : { keycode, mods }, 240_000);
	if (a && a.idle_short === true) environment('key', `the user was at the keyboard (idle ${String(a.idle_s)} s) when keycode ${keycode} [${mods.join('+')}] was due; the key was not sent`, { answer: a });
	if (a && a.sent !== true) environment('key', `the driver could not bring the window to the front for keycode ${keycode} [${mods.join('+')}]; the key was not sent`, { answer: a });
	await browser.pause(settleMs);
	return a;
}
/** Real ASCII typing through the operator (`realinput text`, the pid route). */
async function realText(text: string): Promise<Record<string, unknown> | null> {
	requireRealInput();
	const a = await operator('text', { text }, 240_000);
	if (a && a.idle_short === true) environment('text', `the user was at the keyboard (idle ${String(a.idle_s)} s) when "${text}" was due; not typed`, { answer: a });
	if (a && a.sent !== true) environment('text', `the driver could not bring the window to the front for "${text}"; not typed`, { answer: a });
	await browser.pause(700);
	return a;
}
/**
 * A real single click at a viewport point (the calibrated route first). Stages 2〜4: `mods` (shift / opt /
 * cmd: a Shift + click extends the selection, an Option + click does not follow a link) and `kind`
 * ('dblclick' selects a word).
 */
async function realClick(clientX: number, clientY: number, mods: string[] = [], kind: 'click' | 'dblclick' = 'click'): Promise<{ sent: boolean; recorded: boolean; answers: Array<Record<string, unknown> | null> }> {
	requireRealInput();
	refreshFrame(screen!.pid);
	const s = toScreen(clientX, clientY);
	const answers: Array<Record<string, unknown> | null> = [];
	const routes = screen!.route === 'hid' ? ['hid', 'pid'] : ['pid', 'hid'];
	// A double-click must not join an earlier click into a triple one (ProseMirror counts clicks within 500 ms).
	if (kind === 'dblclick') await browser.pause(800);
	for (const route of routes) {
		const before = await mouseMark();
		const a = await operator(kind, mods.length > 0 ? { x: s.x, y: s.y, route, mods } : { x: s.x, y: s.y, route }, 240_000);
		answers.push(a);
		if (a && a.idle_short === true) environment('click', `the user was at the keyboard (idle ${String(a.idle_s)} s) when the click at (${s.x}, ${s.y}) was due; not sent`, { answer: a });
		if (a && a.front === false) environment('click', `the driver could not bring the window to the front for the click at (${s.x}, ${s.y}); not sent`, { answer: a });
		await browser.pause(400);
		const rec = (await mouseAfter(before)).find((m) => m.type === 'mousedown');
		if (a?.sent === true && rec) return { sent: true, recorded: true, answers };
	}
	return { sent: answers.some((a) => a?.sent === true), recorded: false, answers };
}
/** Put the caret before character `col` of the drawn line `lineIndex` with a real click. */
async function clickAt(lineIndex: number, col: number): Promise<{ point: { x: number; y: number } | null; click: Awaited<ReturnType<typeof realClick>> | null }> {
	const p = await charPoint(lineIndex, col);
	if (!p || !p.inside) return { point: p ? { x: p.x, y: p.y } : null, click: null };
	const click = await realClick(p.x, p.y);
	await browser.pause(200);
	return { point: { x: p.x, y: p.y }, click };
}

// --- judgement --------------------------------------------------------------------------------

let fails: string[] = [];
function judge(gate: number | string, item: string, pass: boolean, extra: Record<string, unknown> = {}): boolean {
	report(REPORT, { gate, side: VARIANT, item, pass, ...extra });
	if (!pass) fails.push(`${gate}: ${item}`);
	return pass;
}
function fact(gate: number | string, item: string, extra: Record<string, unknown> = {}): void {
	report(REPORT, { gate, side: VARIANT, item, ...extra });
}
function human(gate: number | string, item: string, extra: Record<string, unknown> = {}): void {
	report(REPORT, { gate, side: VARIANT, item, human: true, ...extra });
}
function skipped(gate: number | string, item: string, why: string): void {
	report(REPORT, { gate, side: VARIANT, item, note: `skipped: ${why}` });
}
async function shotNamed(name: string): Promise<string | null> {
	const s = await operator('shot', { name, margin: 0 });
	return (s?.file as string | undefined) ?? null;
}

// --- the gates --------------------------------------------------------------------------------

/** Gate 11a: every code / plain fixture opens into the face; gutter and lang only for code. */
async function gateFaces(): Promise<void> {
	for (const f of FILES) {
		const ms = await openDoc(f.rel);
		const lang = await attrOf(FACE, 'data-vellis-lang');
		const gutter = await exists(GUTTER);
		const plainPre = await exists(PLAIN_PRE);
		const editablePre = await exists('article.viewer pre[contenteditable="true"]');
		const done = await exists(EDIT_DONE);
		const editable = await attrOf(CONTENT, 'contenteditable');
		const expectGutter = f.lang !== null;
		judge(11, `${f.rel}: opens into the CodeMirror face (editable), no pre.vellis-plaintext / contenteditable <pre> / Done Editing on screen; data-vellis-lang = ${JSON.stringify(f.lang)}; line numbers ${expectGutter ? 'present' : 'absent'}`,
			lang === f.lang && gutter === expectGutter && !plainPre && !editablePre && !done && editable === 'true',
			{ lang, gutter, plain_pre: plainPre, editable_pre: editablePre, done, contenteditable: editable, open_ms: ms });
		if (['app.ts', 'main.rs', 'settings.json', 'notes.txt', 'japanese.txt'].includes(f.rel)) {
			const s = await shotNamed(`req74-face-${f.rel.replace(/\W/g, '_')}`);
			human(11, `${f.rel} on screen: typeface, size, leading, padding and wrapping against the v0.6.0 display (契約5); the colours against the print (Shiki) = 【人】`, { file: s });
		}
	}
	// query.graphql: no grammar — the face still takes a keystroke (judged by DOM text, no real key).
	await openDoc('query.graphql');
	fact(11, 'query.graphql: a language without a CodeMirror grammar opens into the same face (no colour); typing on it is covered by the typing gate on app.ts', { lang: await attrOf(FACE, 'data-vellis-lang') });
}

/** Gate 11b + 9: real typing, Return keeps the indent, Tab / Shift + Tab, `(` alone, undo / redo by keys and by Edit ▸ Undo / Redo. */
async function gateTyping(): Promise<void> {
	if (!OPERATOR) {
		skipped(11, 'real typing / Return / Tab / undo on app.ts', 'no operator (a judgement without the keys sent would be a false green)');
		return;
	}
	await openDoc('app.ts');
	const original = readBytes('app.ts');
	const lines0 = await faceLines();
	judge(11, 'app.ts: the face draws the file as it is on disk (every line, before any key)', lines0.join('\n') === original, { lines: lines0 });
	judge(11, 'app.ts: not dirty, no Unsaved badge before any key', !(await exists(BADGE)), {});
	// Caret at the end of line 2 (`  if (a > b) {`), real `xyz`.
	const l2 = lines0[1]!;
	const c1 = await clickAt(1, l2.length);
	if (!c1.click?.recorded) environment(11, 'the click at the end of line 2 of app.ts was not seen by the page', { click: c1 });
	const k0 = await keysMark();
	await realText('xyz');
	await waitFaceLine(1, 'xyz');
	const typed = await faceLines();
	judge(11, 'app.ts: real keys `xyz` land at the caret (end of line 2) and nowhere else', typed[1] === `${l2}xyz` && typed.filter((_, i) => i !== 1).join('\n') === lines0.filter((_, i) => i !== 1).join('\n'), { line2: typed[1], keys_seen: (await keysAfter(k0)).length });
	await waitFor(BADGE, 'the Unsaved badge after typing', 5_000).catch(() => undefined);
	judge(11, 'the Unsaved badge appears once the document differs from the disk ((aj))', (await exists(BADGE)) && (await textOf(BADGE)).trim() === 'Unsaved', { badge: await textOf(BADGE) });
	// Real Return: a new line with the same two-space indent as line 2 (not deeper — no syntax indent).
	await realKey(KEY.return);
	await browser.pause(300);
	const afterReturn = await faceLines();
	judge(11, 'a real Return after `  if (a > b) {xyz` opens a line that carries the previous line’s indent (two spaces) and nothing more (契約5: no syntax indentation)', afterReturn[2] === '  ' && afterReturn.length === lines0.length + 1 && afterReturn[3] === lines0[2], { line3: JSON.stringify(afterReturn[2]), line4: afterReturn[3] });
	// Real Tab on that empty line: the file's unit (two spaces) is added; Shift + Tab takes it back.
	await realKey(KEY.tab);
	await browser.pause(300);
	const afterTab = (await faceLines())[2];
	judge(11, 'a real Tab inserts the detected indent unit (two spaces in app.ts)', afterTab === '    ', { line3: JSON.stringify(afterTab) });
	await realKey(KEY.tab, ['shift']);
	await browser.pause(300);
	const afterShiftTab = (await faceLines())[2];
	judge(11, 'a real Shift + Tab takes one unit back', afterShiftTab === '  ', { line3: JSON.stringify(afterShiftTab) });
	// `(` alone (no auto-close).
	await realText('(');
	await browser.pause(300);
	const afterParen = (await faceLines())[2];
	judge(11, 'a real `(` inserts `(` alone (no closing bracket is added)', afterParen === '  (', { line3: JSON.stringify(afterParen) });
	// Gate 9: real Command + Z steps back; Shift + Command + Z forward.
	const beforeUndo = await faceText();
	await realKey(KEY.z, ['cmd']);
	await browser.pause(300);
	const afterUndo1 = await faceText();
	judge(9, 'a real Command + Z undoes the last edit (the face’s text changes back one step)', afterUndo1 !== beforeUndo && afterUndo1.length < beforeUndo.length, { before: beforeUndo.split('\n')[2], after: afterUndo1.split('\n')[2] });
	await realKey(KEY.z, ['cmd', 'shift']);
	await browser.pause(300);
	judge(9, 'a real Shift + Command + Z redoes it', (await faceText()) === beforeUndo, { after: (await faceText()).split('\n')[2] });
	// Edit ▸ Undo / Redo by AX (the native `undo:` selector → beforeinput historyUndo).
	const undo = await operator('press-menu', { menu: 'Edit', item: 'Undo' });
	await browser.pause(500);
	const afterMenuUndo = await faceText();
	judge(9, 'Edit ▸ Undo (AX, the native selector) reaches the CodeMirror history', afterMenuUndo === afterUndo1, { press: undo, after: afterMenuUndo.split('\n')[2] });
	const redo = await operator('press-menu', { menu: 'Edit', item: 'Redo' });
	await browser.pause(500);
	judge(9, 'Edit ▸ Redo (AX) reaches the CodeMirror history', (await faceText()) === beforeUndo, { press: redo });
	// Undo everything: the document is the file again and the badge goes (dirty = string comparison).
	for (let i = 0; i < 12 && (await faceText()) !== original.replace(/\n$/, ''); i++) {
		await realKey(KEY.z, ['cmd'], 250);
	}
	judge(11, 'undo all the way: the face shows the file’s text again and the Unsaved badge is gone (dirty is a string comparison)', (await faceText()) === original && !(await exists(BADGE)), { badge: await exists(BADGE), face_equals_file: (await faceText()) === original });
	judge(11, 'app.ts on disk is untouched (no save happened)', readBytes('app.ts') === original, {});
}

/** Gate 11c: a real Command + S on crlf.txt — every `\r\n` kept, only the touched line differs; the snapshot; no tmp. */
async function gateCrlfSave(): Promise<void> {
	if (!OPERATOR) {
		skipped(11, 'real Command + S on crlf.txt', 'no operator');
		return;
	}
	await openDoc('crlf.txt');
	const original = readBytes('crlf.txt');
	const lines0 = await faceLines();
	const c = await clickAt(2, lines0[2]!.length); // end of line 3
	if (!c.click?.recorded) environment(11, 'the click at the end of line 3 of crlf.txt was not seen by the page', { click: c });
	await realText(' EDITED');
	await waitFaceLine(2, 'EDITED');
	const snaps0 = snapshotCount();
	const mark = await captureMark();
	await realKey(KEY.s, ['cmd'], 1_500);
	await browser.waitUntil(async () => (await savesSince(mark)).length > 0, { timeout: 15_000, timeoutMsg: 'no save_document after Command + S' }).catch(() => undefined);
	const saves = await savesSince(mark);
	const after = readBytes('crlf.txt');
	const expected = original.replace('crlf line 03 of twenty\r\n', 'crlf line 03 of twenty EDITED\r\n');
	const args = (saves[0]?.args ?? null) as { uri?: string; content?: string; expectedHash?: string } | null;
	judge(11, 'a real Command + S: save_document once, ok, with expectedHash (契約14); the file now holds the edited line 3 and every other byte — all 20 `\\r\\n` — as before (git diff = the touched line only)',
		saves.length === 1 && saves[0]!.ok === true && typeof args?.expectedHash === 'string' && after === expected,
		{ saves: saves.map((s) => ({ ok: s.ok, keys: s.args && typeof s.args === 'object' ? Object.keys(s.args as object) : null, body: s.body })), crlf_count: (after.match(/\r\n/g) ?? []).length, lf_only: /(^|[^\r])\n/.test(after), same_as_expected: after === expected });
	judge(11, 'after the save: the Unsaved badge is gone, one pre-save snapshot was taken under <root>/.vellis/snapshots/ (dev-features), no .vellis-tmp is left', !(await exists(BADGE)) && snapshotCount() === snaps0 + 1 && tmpLeftovers().length === 0, { snapshots_before: snaps0, snapshots_after: snapshotCount(), tmp: tmpLeftovers() });
	// The watcher's echo of the own save: no banner, no notice, the text stays.
	await browser.pause(2_000);
	judge(6, 'the file_changed echo of the own save changes nothing (no banner, no notice, the face keeps the saved text)', !(await exists(CONFLICT)) && !(await exists(MERGED)) && !(await exists(CHANGE_BANNER)) && (await faceLines())[2] === 'crlf line 03 of twenty EDITED', {});
	// Put the original back from outside; the clean face follows (gate 6 silent apply).
	writeAtomic(fileOf('crlf.txt'), original);
	await browser.waitUntil(async () => (await faceLines())[2] === 'crlf line 03 of twenty', { timeout: 10_000 }).catch(() => undefined);
	judge(6, 'crlf.txt restored from outside: the clean face follows silently (no banner, not dirty)', (await faceLines())[2] === 'crlf line 03 of twenty' && !(await exists(BADGE)) && !(await exists(CONFLICT)), { line3: (await faceLines())[2], badge: await exists(BADGE), conflict: await exists(CONFLICT) });
}

/** Gate 14: Appearance by AX; the plain-text measure against Markdown; Toggle Full Width. */
async function gateTheme(): Promise<void> {
	await openDoc('main.rs');
	const theme0 = await attrOf(FACE, 'data-code-theme');
	fact(14, 'main.rs: the code theme the face starts with', { data_code_theme: theme0 });
	let dirtyText: string | null = null;
	if (OPERATOR && !realInputBlocked) {
		const lines0 = await faceLines();
		const c = await clickAt(0, lines0[0]!.length);
		if (c.click?.recorded) {
			await realText(' THEME');
			await waitFaceLine(0, 'THEME');
			dirtyText = await faceText();
		}
	}
	const dark = await operator('submenu-press', { menu: 'View', submenu: 'Appearance', item: 'Dark' });
	if (dark) {
		await browser.waitUntil(async () => (await attrOf(FACE, 'data-code-theme')) === 'github-dark', { timeout: 10_000, timeoutMsg: 'data-code-theme never became github-dark' }).catch(() => undefined);
		const t = await attrOf(FACE, 'data-code-theme');
		judge(14, 'View ▸ Appearance ▸ Dark (AX): the face’s colours follow (data-code-theme = github-dark)', t === 'github-dark', { press: dark, data_code_theme: t });
		if (dirtyText !== null) {
			judge(14, 'the document and the Unsaved badge survive the theme change (the EditorState is not rebuilt)', (await faceText()) === dirtyText && (await exists(BADGE)), { badge: await exists(BADGE) });
			await realKey(KEY.z, ['cmd']);
			await browser.pause(300);
			judge(14, 'undo still works after the theme change (a real Command + Z removes ` THEME`)', !(await faceText()).includes('THEME'), { line1: (await faceLines())[0] });
		}
		const s = await shotNamed('req74-theme-dark-main_rs');
		human(14, 'main.rs in Dark: the colours against the print (Shiki github-dark) and the v0.6.0 display = 【人】', { file: s });
		const light = await operator('submenu-press', { menu: 'View', submenu: 'Appearance', item: 'Light' });
		await browser.waitUntil(async () => (await attrOf(FACE, 'data-code-theme')) === 'github-light', { timeout: 10_000 }).catch(() => undefined);
		judge(14, 'View ▸ Appearance ▸ Light (AX): back to github-light', (await attrOf(FACE, 'data-code-theme')) === 'github-light', { press: light });
		const s2 = await shotNamed('req74-theme-light-main_rs');
		human(14, 'main.rs in Light: the colours against the print (Shiki github-light) = 【人】', { file: s2 });
		await operator('submenu-press', { menu: 'View', submenu: 'Appearance', item: 'System' });
		await browser.pause(500);
	} else {
		skipped(14, 'View ▸ Appearance ▸ Dark / Light by AX', 'no operator');
	}
	// The plain-text column is capped at --doc-measure (72ch) measured in the face's own (monospace) font —
	// the v0.6.0 `.vellis-plaintext` rule, narrower than a Markdown paragraph whose 72ch is in the document
	// font (契約4・第1段の作り 14; オーケストレーター 2026-11-17). Toggle Full Width lifts it; code is not capped.
	await openDoc('notes.md', 'article.viewer .markdown-body > p');
	const mdPara = await rectOf('article.viewer .markdown-body > p');
	await openDoc('notes.txt');
	const plain = await rectOf(SURFACE);
	const measure = await browser.execute((sel) => {
		const surface = document.querySelector<HTMLElement>(sel);
		if (!surface) return null;
		const probe = document.createElement('div');
		probe.style.cssText = 'width: var(--doc-measure); height: 0; padding: 0; border: 0; visibility: hidden;';
		surface.appendChild(probe);
		const w = probe.getBoundingClientRect().width;
		probe.remove();
		return { measure_px: w, font: getComputedStyle(surface).fontFamily, max_width: getComputedStyle(surface).maxWidth };
	}, SURFACE);
	judge(14, 'plain text (notes.txt): the face’s column is --doc-measure (72ch) in the face’s own font (within 4 px)', !!plain && !!measure && Math.abs(measure.measure_px - plain.width) <= 4, { plain_surface: plain, measure, markdown_paragraph: mdPara });
	await emitMenu('menu_toggle_full_width');
	await browser.pause(600);
	const wide = await rectOf(SURFACE);
	judge(14, 'View ▸ Toggle Full Width: the plain-text column widens (max-width: none)', !!wide && !!plain && wide.width > plain.width + 20, { before: plain, after: wide });
	await emitMenu('menu_toggle_full_width');
	await browser.pause(600);
	await openDoc('app.ts');
	const code = await rectOf(SURFACE);
	judge(14, 'code (app.ts): the face’s column is not capped (at least as wide as the full-width plain column)', !!code && !!wide && code.width >= wide.width - 4, { code_surface: code, full_width_plain: wide });
	const s3 = await shotNamed('req74-width-app_ts');
	human(14, 'app.ts vs notes.txt side by side with the Markdown measure (the look of the widths) = 【人】', { file: s3 });
}

/** Gate 15: a real Command + R on a dirty face — one dialog; Cancel keeps; Don't Save reloads. */
async function gateReload(): Promise<void> {
	if (!OPERATOR) {
		skipped(15, 'real Command + R with unsaved edits', 'no operator');
		return;
	}
	await openDoc('notes.txt');
	const original = readBytes('notes.txt');
	const c = await clickAt(0, 0);
	if (!c.click?.recorded) environment(15, 'the click at the start of notes.txt was not seen by the page', { click: c });
	await realText('RELOAD ');
	await waitFaceLine(0, 'RELOAD');
	judge(15, 'typing raises the Unsaved badge (the sign one notices before Command + R)', await exists(BADGE), {});
	const mark = await captureMark();
	await realKey(KEY.r, ['cmd'], 300);
	const d1 = await operator('dialog', { wait_s: 6, expect: 'Unsaved Changes', answer: 'escape' });
	await browser.pause(800);
	judge(15, 'a real Command + R on a dirty face: exactly one "Unsaved Changes" dialog; Cancel (Esc) → nothing changes (the edit and the badge stay, open_document is not called)',
		d1?.dialogs === 1 && (await faceLines())[0]!.startsWith('RELOAD ') && (await exists(BADGE)) && (await readCapturedIpc()).slice(mark).filter((x) => x.cmd === 'open_document').length === 0,
		{ dialog: d1, line1: (await faceLines())[0], opens: (await readCapturedIpc()).slice(mark).filter((x) => x.cmd === 'open_document').length });
	const mark2 = await captureMark();
	await realKey(KEY.r, ['cmd'], 300);
	const d2 = await operator('dialog', { wait_s: 6, expect: 'Unsaved Changes', answer: 'cmd-d' });
	await browser.waitUntil(async () => !(await faceLines())[0]!.startsWith('RELOAD '), { timeout: 15_000, timeoutMsg: 'the face never reloaded' }).catch(() => undefined);
	await browser.pause(500);
	judge(15, 'Command + R again, Don’t Save (Command + D): the file is read again (open_document), the face shows the disk’s text, the badge is gone',
		d2?.dialogs === 1 && (await docText()) === original && !(await exists(BADGE)) && (await readCapturedIpc()).slice(mark2).some((x) => x.cmd === 'open_document'),
		{ dialog: d2, line1: (await faceLines())[0], opens: (await readCapturedIpc()).slice(mark2).filter((x) => x.cmd === 'open_document').length });
	judge(15, 'notes.txt on disk is untouched', readBytes('notes.txt') === original, {});
	// Not dirty: Command + R asks nothing.
	const mark3 = await captureMark();
	await realKey(KEY.r, ['cmd'], 300);
	const d3 = await operator('dialog', { wait_s: 3, expect: 'Unsaved Changes', answer: 'count' });
	await browser.pause(800);
	judge(15, 'Command + R on a clean face: no dialog, the file is simply read again', (d3?.dialogs ?? 0) === 0 && ((d3?.seen as unknown[] | undefined) ?? []).length === 0 && (await readCapturedIpc()).slice(mark3).some((x) => x.cmd === 'open_document'), { dialog: d3 });
}

/** Gate 6: writes from outside, the merge, the conflict, the real save refused by the hash check (AC-74-16), the removed file. */
async function gateExternal(): Promise<void> {
	await openDoc('notes.txt');
	const original = readBytes('notes.txt');
	const lineOf = (n: number) => `line ${String(n).padStart(3, '0')} the quick brown fox jumps`;
	// (1) Clean face: an external change follows silently.
	let disk = original.replace(lineOf(5), 'LINE 005 changed outside');
	writeAtomic(fileOf('notes.txt'), disk);
	await waitFaceLine(5, 'LINE 005 changed outside', 10_000);
	judge(6, 'a clean face: the external write (atomic rename) is taken in silently — the text follows, no banner, no notice, not dirty', (await faceLines())[5] === 'LINE 005 changed outside' && !(await exists(CONFLICT)) && !(await exists(MERGED)) && !(await exists(CHANGE_BANNER)) && !(await exists(BADGE)), {});
	if (!OPERATOR || realInputBlocked) {
		skipped(6, 'the merge / conflict / save refusal (needs real typing)', realInputBlocked ?? 'no operator');
	} else {
		// (2) Dirty face, non-overlapping external change: merged, notice, undo keeps the external part.
		const c = await clickAt(0, 0);
		if (!c.click?.recorded) environment(6, 'the click at the start of notes.txt was not seen by the page', { click: c });
		await realText('MINE ');
		await waitFaceLine(0, 'MINE ');
		disk = disk.replace(lineOf(10), 'LINE 010 changed outside');
		writeAtomic(fileOf('notes.txt'), disk);
		await waitFaceLine(10, 'LINE 010 changed outside', 10_000);
		await browser.pause(300);
		judge(6, 'a dirty face, a non-overlapping external change: merged (line 1 keeps `MINE `, line 11 is the disk’s), dirty, the "changes were merged" notice, no conflict banner',
			(await faceLines())[0]!.startsWith('MINE ') && (await faceLines())[10] === 'LINE 010 changed outside' && (await exists(BADGE)) && (await exists(MERGED)) && !(await exists(CONFLICT)),
			{ notice: await textOf(MERGED), line1: (await faceLines())[0] });
		await realKey(KEY.z, ['cmd']);
		await browser.pause(300);
		judge(6, 'a real Command + Z after the merge undoes my `MINE ` and leaves the external line 11 (the merge is not in the history)', !(await faceLines())[0]!.startsWith('MINE ') && (await faceLines())[10] === 'LINE 010 changed outside', { line1: (await faceLines())[0] });
		// (3) Overlap: I edit line 21; the disk changes line 21 → conflict banner, the document stays.
		const lines = await faceLines();
		const c2 = await clickAt(20, lines[20]!.length);
		if (!c2.click?.recorded) environment(6, 'the click at the end of line 21 of notes.txt was not seen by the page', { click: c2 });
		await realText(' MINE21');
		await waitFaceLine(20, 'MINE21');
		const mineText = await faceText();
		disk = disk.replace(lineOf(20), 'LINE 020 theirs');
		writeAtomic(fileOf('notes.txt'), disk);
		await waitFor(CONFLICT, 'the conflict banner', 10_000).catch(() => undefined);
		judge(6, 'an overlapping external change: the conflict banner (Keep My Edits / Use the File on Disk) and the document untouched', (await exists(CONFLICT)) && (await faceText()) === mineText && (await exists(CONFLICT_KEEP)) && (await exists(CONFLICT_DISK)), { banner: await textOf(CONFLICT) });
		const s = await shotNamed('req74-conflict-banner');
		human(6, 'the conflict banner as it looks = 【人】', { file: s });
		// (4) AC-74-16 end to end: a real Command + S while the base differs from the disk → refused.
		const shaDisk = sha256(fileOf('notes.txt'));
		const snaps0 = snapshotCount();
		const mark = await captureMark();
		await realKey(KEY.s, ['cmd'], 1_500);
		await browser.waitUntil(async () => (await savesSince(mark)).length > 0, { timeout: 15_000, timeoutMsg: 'no save_document after Command + S' }).catch(() => undefined);
		const refused = await savesSince(mark);
		const body = String(refused[0]?.body ?? '');
		judge(6, `AC-74-16: the real Command + S runs save_document with the stale expectedHash and is REFUSED ("${SAVE_CONFLICT_PREFIX}…"): the file’s bytes unchanged (sha256), no new snapshot, no .vellis-tmp, the banner and the edit stay`,
			refused.length === 1 && refused[0]!.ok === false && body.startsWith(SAVE_CONFLICT_PREFIX) && sha256(fileOf('notes.txt')) === shaDisk && snapshotCount() === snaps0 && tmpLeftovers().length === 0 && (await exists(CONFLICT)) && (await faceText()) === mineText,
			{ saves: refused.map((r) => ({ ok: r.ok, body: r.body, keys: r.args && typeof r.args === 'object' ? Object.keys(r.args as object) : null })), snapshots: [snaps0, snapshotCount()], tmp: tmpLeftovers(), sha_same: sha256(fileOf('notes.txt')) === shaDisk });
		// (5) Keep My Edits: the base moves to the disk; the next save writes.
		await browser.execute((sel) => (document.querySelector(sel) as HTMLElement | null)?.click(), CONFLICT_KEEP);
		await waitGone(CONFLICT, 'the conflict banner after Keep My Edits', 5_000).catch(() => undefined);
		const mark2 = await captureMark();
		await realKey(KEY.s, ['cmd'], 1_500);
		await browser.waitUntil(async () => (await savesSince(mark2)).some((x) => x.ok === true), { timeout: 15_000, timeoutMsg: 'no successful save_document after Keep My Edits' }).catch(() => undefined);
		const kept = await savesSince(mark2);
		const afterKeep = readBytes('notes.txt');
		judge(6, 'Keep My Edits, then Command + S: the save goes through (ok), the file now holds my line 21 (` MINE21`) and the disk’s other lines; one more snapshot; not dirty',
			kept.some((x) => x.ok === true) && afterKeep.includes('MINE21') && afterKeep.includes('LINE 010 changed outside') && snapshotCount() === snaps0 + 1 && !(await exists(BADGE)),
			{ saves: kept.map((k) => ({ ok: k.ok, body: k.body })), line21: afterKeep.split('\n')[20], snapshots: snapshotCount() });
		// (6) Use the File on Disk: another overlap, then the disk's text wins.
		const lines2 = await faceLines();
		const c3 = await clickAt(30, lines2[30]!.length);
		if (!c3.click?.recorded) environment(6, 'the click at the end of line 31 was not seen by the page', { click: c3 });
		await realText(' MINE31');
		await waitFaceLine(30, 'MINE31');
		disk = readBytes('notes.txt').replace(lineOf(30), 'LINE 030 theirs');
		writeAtomic(fileOf('notes.txt'), disk);
		await waitFor(CONFLICT, 'the second conflict banner', 10_000).catch(() => undefined);
		await browser.execute((sel) => (document.querySelector(sel) as HTMLElement | null)?.click(), CONFLICT_DISK);
		await waitFaceLine(30, 'LINE 030 theirs', 5_000).catch(() => undefined);
		judge(6, 'Use the File on Disk: the face shows the disk’s text (my ` MINE31` gone), not dirty, no banner', (await faceLines())[30] === 'LINE 030 theirs' && !(await exists(BADGE)) && !(await exists(CONFLICT)), { line31: (await faceLines())[30] });
		// (7) The file removed under a dirty face: the removed banner; Save writes it back.
		const c4 = await clickAt(0, 0);
		if (!c4.click?.recorded) environment(6, 'the click at the start of notes.txt (removed-file step) was not seen by the page', { click: c4 });
		await realText('GONE ');
		await waitFaceLine(0, 'GONE ');
		const mineGone = await docText();
		fs.rmSync(fileOf('notes.txt'));
		await waitFor(REMOVED, 'the removed banner', 10_000).catch(() => undefined);
		judge(6, 'the file deleted outside under a dirty face: the document stays, the removed banner says the edits are unsaved (要件48 追補g)', (await exists(REMOVED)) && (await docText()) === mineGone && (await textOf(REMOVED)).includes('Your edits have not been saved'), { banner: await textOf(REMOVED) });
		const mark3 = await captureMark();
		await browser.execute((sel) => (document.querySelector(sel) as HTMLElement | null)?.click(), REMOVED_SAVE);
		await browser.waitUntil(async () => fs.existsSync(fileOf('notes.txt')), { timeout: 10_000, timeoutMsg: 'notes.txt was not written back' }).catch(() => undefined);
		const back = fs.existsSync(fileOf('notes.txt')) ? readBytes('notes.txt') : '';
		const saveBack = (await savesSince(mark3))[0];
		const argsBack = (saveBack?.args ?? {}) as Record<string, unknown>;
		judge(6, 'the banner’s Save writes the file back to the same path with the face’s text (save_document without expectedHash — nothing on disk to compare), the banner goes',
			!!saveBack && saveBack.ok === true && !('expectedHash' in argsBack) && back === mineGone && !(await exists(REMOVED)),
			{ save: saveBack ? { ok: saveBack.ok, keys: Object.keys(argsBack) } : null, back_starts: back.slice(0, 40) });
	}
	// (8) A stale expectedHash straight through the page's invoke: refused the same way, nothing written.
	const current = readBytes('notes.txt');
	const shaNow = sha256(fileOf('notes.txt'));
	const snapsNow = snapshotCount();
	// WebKit's driver may report the command's rejection as the failure of executeAsync itself
	// (req84 run6); that text IS the answer, kept as data.
	let stale: { ok: boolean; error: string | null };
	try {
		stale = await invokeFromPage<void>('save_document', { uri: uriOf('notes.txt'), content: `${current}STALE WRITE\n`, expectedHash: '1-stale-hash' });
	} catch (e) {
		stale = { ok: false, error: String((e as { message?: string })?.message ?? e) };
	}
	judge(6, `AC-74-16 (the command itself): save_document with a wrong expectedHash is refused with "${SAVE_CONFLICT_PREFIX}…", the file’s bytes unchanged, no snapshot taken, no .vellis-tmp`,
		stale.ok === false && String(stale.error ?? '').includes(SAVE_CONFLICT_PREFIX) && sha256(fileOf('notes.txt')) === shaNow && snapshotCount() === snapsNow && tmpLeftovers().length === 0,
		{ answer: stale, sha_same: sha256(fileOf('notes.txt')) === shaNow, snapshots: [snapsNow, snapshotCount()], tmp: tmpLeftovers() });
	// Restore the fixture for the gates that follow.
	writeAtomic(fileOf('notes.txt'), original);
	await waitFaceLine(5, lineOf(5), 10_000).catch(() => undefined);
	fact(6, 'notes.txt restored from outside at the end of gate 6 (the face follows)', { line1: (await faceLines())[0] });
	human(6, 'Claude Code / Codex / VS Code writing the open file while you read or type: the quiet take-in, the merge notice, the conflict banner, the save refusal — the feel of it = 【人】(the mechanics are judged above)', {});
}

/** Gate 8: find on the face, zoom by font-size and a real click at 150 %, the print rendering, copy / paste with CRLF. */
async function gateViewing(): Promise<void> {
	// Find: every match of the whole document.
	await openDoc('notes.txt');
	const text = readBytes('notes.txt');
	await emitMenu('menu_find');
	await waitFor(FIND_INPUT, 'the find bar', 5_000);
	await browser.execute((sel, v) => {
		const el = document.querySelector<HTMLInputElement>(sel)!;
		el.value = v;
		el.dispatchEvent(new Event('input', { bubbles: true }));
	}, FIND_INPUT, 'fox');
	await browser.waitUntil(async () => (await textOf(FIND_COUNT)).includes(' of '), { timeout: 5_000, timeoutMsg: 'no count' }).catch(() => undefined);
	const count = (await textOf(FIND_COUNT)).trim();
	const expectedN = countMatches(text, 'fox');
	judge(8, `Find "fox" on the face counts every match of the whole document (${expectedN}; the lines beyond the drawn viewport included) — "1 of ${expectedN}"`, count === `1 of ${expectedN}`, { count, expected: expectedN, drawn_lines: (await faceLines()).length });
	const currentLine = async () => browser.execute(() => {
		const cur = document.querySelector('.cm-vellis-find-current');
		if (!cur) return -1;
		const line = cur.closest('.cm-line');
		return line ? Array.from(document.querySelectorAll('.cm-line')).indexOf(line) : -1;
	});
	const before = await currentLine();
	await browser.execute((sel) => document.querySelector<HTMLInputElement>(sel)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), FIND_INPUT);
	await browser.pause(400);
	const afterNext = await currentLine();
	judge(8, 'Next (Enter in the find bar) moves the current match to another line ("2 of N")', (await textOf(FIND_COUNT)).trim() === `2 of ${expectedN}` && afterNext !== before && afterNext >= 0, { before, after: afterNext, count: await textOf(FIND_COUNT) });
	await closeOverlays();
	// Zoom: font-size on the face, no CSS zoom anywhere above it; a real click lands on the character.
	await emitMenu('menu_zoom_reset');
	await browser.pause(300);
	const fontBefore = await browser.execute((s) => getComputedStyle(document.querySelector(s)!).fontSize, SURFACE);
	for (let i = 0; i < 5; i++) {
		await emitMenu('menu_zoom_in');
		await browser.pause(150);
	}
	await browser.pause(400);
	const zoomFacts = await browser.execute((s) => {
		const face = document.querySelector<HTMLElement>(s)!;
		const chain: Array<{ tag: string; zoom: string; transform: string }> = [];
		for (let el: HTMLElement | null = face; el; el = el.parentElement) {
			const cs = getComputedStyle(el);
			chain.push({ tag: `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60), zoom: (cs as unknown as { zoom?: string }).zoom ?? '', transform: cs.transform });
		}
		return { inline: face.style.fontSize, surfaceFont: getComputedStyle(face.querySelector('.code-editor-surface')!).fontSize, chain };
	}, FACE);
	const fb = parseFloat(fontBefore);
	const fa = parseFloat(zoomFacts.surfaceFont);
	judge(8, 'Zoom In × 5 (150 %): the face’s font-size is scaled (×1.5 of the 100 % size) and no CSS zoom / transform sits on the face or its ancestors (契約17)', zoomFacts.inline.includes('150') && Math.abs(fa / fb - 1.5) < 0.05 && zoomFacts.chain.every((c) => (c.zoom === '' || c.zoom === '1' || c.zoom === 'normal') && (c.transform === 'none' || c.transform === '')), { font_before: fontBefore, zoom: zoomFacts });
	if (OPERATOR && !realInputBlocked) {
		// A real click before character 20 of line 3 at 150 %: the caret is drawn at that character.
		const target = await charPoint(2, 20);
		if (target && target.inside) {
			const click = await realClick(target.x, target.y);
			await browser.pause(300);
			const cx = await caretX();
			const after = await charPoint(2, 20);
			judge(8, 'at 150 % a real click lands the caret on the clicked character (the drawn caret within 6 px of the character’s left edge = the coordinates are not skewed by a CSS zoom)', click.recorded && cx !== null && after !== null && Math.abs(cx - after.x) <= 6, { clicked: target, caret_x: cx, char_x: after?.x, click });
		} else {
			fact(8, 'the 150 % click probe: character 20 of line 3 is not inside the viewport; not clicked', { target });
		}
		const s = await shotNamed('req74-zoom-150');
		human(8, 'the face at 150 %: the look of the enlarged text and the caret = 【人】', { file: s });
	}
	await emitMenu('menu_zoom_reset');
	await browser.pause(300);
	// Print: beforeprint builds the print rendering from the face's text; afterprint removes it.
	await browser.execute(() => window.dispatchEvent(new Event('beforeprint')));
	await browser.pause(800);
	const printText = await browser.execute((sel) => document.querySelector(`${sel} pre.vellis-plaintext`)?.textContent ?? null, PRINT);
	const face = await docText();
	judge(8, 'beforeprint: the print rendering (pre.vellis-plaintext, from the face’s text) is built; it holds the same text the face shows', printText !== null && printText.replace(/\n$/, '') === face.replace(/\n$/, ''), { print_head: printText?.slice(0, 60) ?? null });
	await browser.execute(() => window.dispatchEvent(new Event('afterprint')));
	await browser.pause(300);
	judge(8, 'afterprint: the print rendering is gone, the face stays', !(await exists(PRINT)) && (await exists(CM)), {});
	human(8, 'File ▸ Print… to PDF on main.rs / app.log: every page comes out, in the Shiki rendering (light), without the face’s gutter = 【人】 (docs/req74-stage1-device.md B.3)', {});
	// Copy / paste with CRLF (the user's clipboard is saved first and put back by `after`).
	if (OPERATOR && !realInputBlocked) {
		await openDoc('crlf.txt');
		const original = readBytes('crlf.txt');
		const saved = await operator('pasteboard', { op: 'save' });
		pasteboardSaved = !!saved && !saved.error;
		const c = await clickAt(1, 0);
		if (!c.click?.recorded) environment(8, 'the click at the start of line 2 of crlf.txt was not seen by the page', { click: c });
		await browser.execute(() => {
			const w = window as unknown as { __req74Clip?: string[] };
			w.__req74Clip = [];
			for (const t of ['copy', 'cut', 'paste']) document.addEventListener(t, () => w.__req74Clip!.push(t), true);
		});
		await realKey(KEY.down, ['shift'], 600, 'hid'); // select line 2 (through its line break)
		const selFacts = await viewFacts();
		await realKey(KEY.c, ['cmd'], 600, 'hid');
		const got = await operator('pasteboard', { op: 'get-text' });
		judge(8, 'a real Command + C on a selection spanning a line break carries the text with `\\r\\n` (the document’s line ending, 契約17)', got?.text === 'crlf line 02 of twenty\r\n', { clipboard: got, selection: selFacts, events: await browser.execute(() => (window as unknown as { __req74Clip?: string[] }).__req74Clip ?? []) });
		await operator('pasteboard', { op: 'set-text', text: 'P1\nP2' });
		await realKey(KEY.right, [], 600, 'hid'); // caret at the start of line 3
		await realKey(KEY.left, [], 600, 'hid');
		await realKey(KEY.v, ['cmd'], 600, 'hid');
		await browser.pause(500);
		const lines = await faceLines();
		judge(8, 'a real Command + V of `P1\\nP2` inserts two lines (the drawn lines show P1 and P2)', lines.some((l) => l.includes('P1')) && lines.some((l) => l.includes('P2')), { lines: lines.slice(0, 6), events: await browser.execute(() => (window as unknown as { __req74Clip?: string[] }).__req74Clip ?? []) });
		const mark = await captureMark();
		await realKey(KEY.s, ['cmd'], 1_500);
		await browser.waitUntil(async () => (await savesSince(mark)).length > 0, { timeout: 15_000 }).catch(() => undefined);
		const after = readBytes('crlf.txt');
		judge(8, 'saved: the pasted lines are joined with `\\r\\n` (the document’s dominant line ending) and no bare `\\n` entered the file', after.includes('P1\r\nP2') && !/(^|[^\r])\n/.test(after), { around: after.slice(after.indexOf('P1') - 10, after.indexOf('P1') + 30) });
		writeAtomic(fileOf('crlf.txt'), original);
		await waitFaceLine(1, 'crlf line 02', 10_000).catch(() => undefined);
		const restored = await operator('pasteboard', { op: 'restore' });
		if (restored && restored.ok === true) pasteboardSaved = false;
		fact(8, 'the user’s clipboard put back', { restored });
	}
}
let pasteboardSaved = false;

/** Gate 10: large files — recorded with loose bounds; the feel stays with a person. */
async function gateLarge(): Promise<void> {
	for (const rel of ['app.log', 'big.ts']) {
		const ms = await openDoc(rel);
		const drawn = (await faceLines()).length;
		const size = fs.statSync(fileOf(rel)).size;
		judge(10, `${rel} (${(size / 1024 / 1024).toFixed(1)} MB): the face appears within 5 s (${ms} ms); CodeMirror draws only the viewport (${drawn} lines)`, ms < 5_000 && drawn > 0 && drawn < 2_000, { open_ms: ms, drawn_lines: drawn, size });
		if (OPERATOR && !realInputBlocked) {
			const c = await clickAt(2, 0);
			if (c.click?.recorded) {
				const t0 = Date.now();
				await operator('text', { text: 'Q' }, 240_000);
				// The operator answers 0.6 s after `realinput text` returned (its settle sleep), after its own
				// idle / front checks and the file hand-off: the key was sent at most 0.6 s before the answer.
				const tAnswer = Date.now();
				await browser.waitUntil(async () => ((await faceLines())[2] ?? '').startsWith('Q'), { timeout: 5_000 }).catch(() => undefined);
				const latency = Date.now() - t0;
				const sinceSent = Date.now() - tAnswer + 600;
				judge(10, `${rel}: a real keystroke shows within 1.5 s of being sent (at most ${sinceSent} ms after the key was sent; ${latency} ms with the operator’s hand-off)`, sinceSent < 1_500 && ((await faceLines())[2] ?? '').startsWith('Q'), { latency_ms: latency, since_sent_upper_ms: sinceSent, operator_ms: tAnswer - t0 });
				await realKey(KEY.z, ['cmd']);
			} else {
				environment(10, `the click on line 3 of ${rel} was not seen by the page; the keystroke and Command + ↓ steps are skipped`, { click: c });
			}
			if (c.click?.recorded) {
			const t1 = Date.now();
			await realKey(KEY.down, ['cmd']); // to the end of the document
			await browser.waitUntil(async () => { const v = await viewFacts(); return !!v && v.head === v.length; }, { timeout: 5_000 }).catch(() => undefined);
			const scrolled = Date.now() - t1;
			const lastDrawn = (await faceLines()).slice(-1)[0] ?? '';
			const v = await viewFacts();
			judge(10, `${rel}: Command + ↓ reaches the end within 3 s (${scrolled} ms, the operator’s round trip included) and the last line is drawn`, scrolled < 3_000 && !!v && v.head === v.length && lastDrawn === v.lastLine, { ms: scrolled, last_line: lastDrawn.slice(0, 60), view: v });
			}
		}
		await emitMenu('menu_find');
		await waitFor(FIND_INPUT, 'the find bar', 5_000);
		const q = rel === 'app.log' ? 'ERROR' : 'return';
		const t2 = Date.now();
		await browser.execute((sel, v) => {
			const el = document.querySelector<HTMLInputElement>(sel)!;
			el.value = v;
			el.dispatchEvent(new Event('input', { bubbles: true }));
		}, FIND_INPUT, q);
		await browser.waitUntil(async () => (await textOf(FIND_COUNT)).includes(' of '), { timeout: 10_000 }).catch(() => undefined);
		const counted = Date.now() - t2;
		const n = countMatches(readBytes(rel), q);
		judge(10, `${rel}: Find "${q}" counts the whole file (${n}) within 3 s (${counted} ms)`, (await textOf(FIND_COUNT)).trim() === `1 of ${n}` && counted < 3_000, { count: await textOf(FIND_COUNT), expected: n, ms: counted });
		await closeOverlays();
	}
	human(10, 'the feel of a 5 MB log and a 50,000-line file: opening, typing, scrolling, searching = 【人】 (the numbers above are the machine’s)', {});
}

// =============================================================================================
// Stages 2〜4 — the ProseMirror face of a Markdown file (第2段), the input rules / tables / replace /
// the native right-click menu / the gap cursor (第3段), the diff views / the formatting toolbar / the
// selection bar / the per-item list rewrite / the link editor (第4段). The human gates 1〜10・12・13
// of docs/requirements/req-74.md and the stage-4 checks of docs/review/req74-stage34-prep.md (G),
// the part a machine can drive; what stays with a person is in docs/req74-stage24-device.md.
// =============================================================================================

/** More macOS virtual keycodes (US ANSI) for stages 2〜4. */
const KEY2 = { a: 0, f: 3, b: 11, i: 34, k: 40, u: 32, slash: 44, backspace: 51, up: 126, space: 49 } as const;

// The Markdown face's DOM (src/components/MarkdownEditor.svelte / Viewer.svelte / FormatToolbar.svelte /
// SelectionBar.svelte / EditorDiffView.svelte / FindBar.svelte).
const MD_ROOT = 'article.viewer [data-testid="markdown-editor"]';
const PM = `${MD_ROOT} .ProseMirror`;
const RAW = `${MD_ROOT} [data-testid="raw-source-editor"]`;
const FRONT_MATTER = `${PM} [data-testid="front-matter-chip"]`;
const FORMAT_TOOLBAR = 'article.viewer [data-testid="format-toolbar"]';
const FORMAT_TOGGLE = 'article.viewer [data-testid="format-toolbar-toggle"]';
const BLOCK_SELECT = `${FORMAT_TOOLBAR} [data-testid="format-block-type"]`;
const SELECTION_BAR = `${MD_ROOT} [data-testid="selection-bar"]`;
const LINK_EDITOR = `${MD_ROOT} [data-testid="link-editor"]`;
const LINK_TEXT = `${LINK_EDITOR} [data-testid="link-text"]`;
const LINK_URL = `${LINK_EDITOR} [data-testid="link-url"]`;
const LINK_DONE = `${LINK_EDITOR} [data-testid="link-done"]`;
const LINK_REMOVE = `${LINK_EDITOR} [data-testid="link-remove"]`;
const PASTE_CHIP = `${MD_ROOT} [data-testid="paste-as-markdown"]`;
const DIFF = '[data-testid="editor-diff"]';
const DIFF_TITLE = '[data-testid="editor-diff-title"]';
const DIFF_EOL = '[data-testid="editor-diff-eol"]';
const DIFF_CLOSE = '[data-testid="editor-diff-close"]';
const DIFF_KEEP = '[data-testid="editor-diff-keep"]';
const DIFF_DISK = '[data-testid="editor-diff-disk"]';
const CONFLICT_DIFF = '[data-testid="external-conflict-diff"]';
const TOO_LARGE = '[data-testid="markdown-too-large-notice"]';
const REPLACE_INPUT = '[data-testid="replace-input"]';
const REPLACE_ALL = '[data-testid="replace-all"]';

/** The fixtures of stages 2〜4 (req74-fixtures.sh). */
const MD_FILES = ['ai-report.md', 'crlf.md', 'ext.md', 'rules.md', 'table.md', 'gap.md', 'gap-fm.md', 'list.md', 'big.md', 'huge.md', 'notes.md', 'config.jsonc', 'table-wrap.md', 'fm-rules.md'];
/** "fox" in the visible text of ai-report.md (paragraphs 2・heading 1・list item 1・alert 1・table cell 1); none hidden. */
const AI_REPORT_FOX = 6;

// --- reading the Markdown face ------------------------------------------------------------------

interface MdBlock {
	type: string;
	text: string;
	level?: number;
}
interface MdDoc {
	text: string;
	blocks: MdBlock[];
	via: 'pm' | 'dom';
}
/**
 * The face's document: ProseMirror's own (the root's `pmViewDesc.node` = the view's doc, prosemirror-view
 * sets it on every view desc's DOM) — the top-level blocks with their type, text and heading level; the
 * DOM's text when that internal is not there (`via`).
 */
async function mdDoc(): Promise<MdDoc | null> {
	return browser.execute((sel) => {
		interface PMNodeLike {
			type: { name: string };
			textContent: string;
			attrs: Record<string, unknown>;
			content: { size: number };
			forEach(f: (c: PMNodeLike) => void): void;
			textBetween(from: number, to: number, block?: string, leaf?: string): string;
		}
		const el = document.querySelector(sel) as (HTMLElement & { pmViewDesc?: { node?: PMNodeLike } }) | null;
		if (!el) return null;
		const node = el.pmViewDesc?.node;
		if (node && typeof node.textBetween === 'function') {
			const blocks: Array<{ type: string; text: string; level?: number }> = [];
			node.forEach((c) => blocks.push({ type: c.type.name, text: c.textContent, ...(typeof c.attrs.level === 'number' ? { level: c.attrs.level } : {}) }));
			return { text: node.textBetween(0, node.content.size, '\n', ' '), blocks, via: 'pm' as const };
		}
		return { text: el.innerText, blocks: Array.from(el.children).map((c) => ({ type: c.tagName.toLowerCase(), text: c.textContent ?? '' })), via: 'dom' as const };
	}, PM);
}
async function mdText(): Promise<string> {
	return (await mdDoc())?.text ?? '';
}
/** Whether an element `tag` inside the face holds `word` (strong / em / code / del / s / a / h2 …). */
async function marked(tag: string, word: string): Promise<boolean> {
	return browser.execute(
		(sel, t, w) => Array.from(document.querySelectorAll(`${sel} ${t}`)).some((e) => (e.textContent ?? '').includes(w)),
		PM,
		tag,
		word,
	);
}
/** The page's selection: its text, whether it is collapsed and inside the face, the caret's (or the range's first) rect. */
async function mdSel(): Promise<{ text: string; collapsed: boolean; inFace: boolean; rect: Rect | null }> {
	return browser.execute((sel) => {
		const s = document.getSelection();
		const face = document.querySelector(sel);
		if (!s || s.rangeCount === 0) return { text: '', collapsed: true, inFace: false, rect: null };
		const range = s.getRangeAt(0);
		const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
		return {
			text: s.toString(),
			collapsed: s.isCollapsed,
			inFace: !!face && face.contains(range.startContainer),
			rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
		};
	}, PM);
}
/**
 * The viewport point of the `nth` text node (in document order) under `root` that holds `needle`:
 * `at` = a character index inside the needle (the caret before it), 'end' (after it) or 'mid' (the centre
 * of the needle, for a double-click or a right-click). Text under `contenteditable="false"` (front matter,
 * raw HTML, mermaid) is skipped. The node is scrolled into the middle of the view first when it is outside.
 */
async function mdPoint(needle: string, at: number | 'mid' | 'end' = 0, nth = 0, root = PM): Promise<{ x: number; y: number; inside: boolean } | null> {
	return browser.execute(
		(sel, n, a, k) => {
			const face = document.querySelector(sel);
			if (!face) return null;
			const walker = document.createTreeWalker(face, NodeFilter.SHOW_TEXT);
			let seen = 0;
			while (walker.nextNode()) {
				const t = walker.currentNode as Text;
				// The nearest contenteditable decides: front matter / raw HTML / mermaid figures are "false"; the code
				// fence's CodeMirror is "true" inside a "false" NodeView (run 10: the fence's text was skipped).
				const ce = t.parentElement?.closest('[contenteditable]');
				if (ce && ce !== face && face.contains(ce) && ce.getAttribute('contenteditable') === 'false') continue;
				const i = t.data.indexOf(n);
				if (i < 0) continue;
				if (seen++ < k) continue;
				const measure = () => {
					const range = document.createRange();
					if (a === 'mid') {
						range.setStart(t, i);
						range.setEnd(t, i + n.length);
						const r = range.getBoundingClientRect();
						return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
					}
					const off = i + (a === 'end' ? n.length : Number(a));
					range.setStart(t, off);
					range.setEnd(t, off);
					const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
					return { x: Math.round(r.x), y: Math.round(r.y + r.height / 2) };
				};
				let p = measure();
				const inside = (q: { x: number; y: number }) => q.x > 0 && q.y > 0 && q.x < window.innerWidth && q.y < window.innerHeight;
				if (!inside(p)) {
					t.parentElement?.scrollIntoView({ block: 'center' });
					p = measure();
				}
				return { ...p, inside: inside(p) };
			}
			return null;
		},
		root,
		needle,
		at,
		nth,
	);
}
/** Open a Markdown file of the root (clean first) and wait for the face to show `marker`. */
async function openMd(rel: string, marker: string, timeout = 30_000): Promise<number> {
	await ensureClean(`open ${rel}`);
	const t0 = Date.now();
	await clickExplorerRow(uriOf(rel));
	await waitFor(PM, `open ${rel}`, 60_000);
	await browser.waitUntil(async () => (await mdText()).includes(marker), { timeout, timeoutMsg: `the Markdown face never showed "${marker}"` });
	const ms = Date.now() - t0;
	await browser.pause(400);
	return ms;
}
/**
 * Leave nothing dirty: Reload File → Don't Save in the Unsaved Changes dialog. A real Command + R when real
 * input is allowed (two operator steps, no webdriver call while the dialog is up — gate 15's route), else
 * the menu event.
 */
async function ensureClean(why: string): Promise<void> {
	if (!(await exists(BADGE))) return;
	await closeOverlays();
	if (await exists(DIFF)) await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), DIFF_CLOSE);
	if (OPERATOR && !realInputBlocked) await realKey(KEY.r, ['cmd'], 300);
	else await emitMenu('menu_reload_file');
	const d = await operator('dialog', { wait_s: 6, expect: 'Unsaved Changes', answer: 'cmd-d' });
	await browser.waitUntil(async () => !(await exists(BADGE)), { timeout: 10_000 }).catch(() => undefined);
	report(REPORT, { gate: 'reset', side: VARIANT, when: why, discarded: true, dialog: d, dirty_after: await exists(BADGE) });
}
/** A real click (or double-click) on `needle` in the face; `false` when the page did not see it. */
async function clickMd(needle: string, at: number | 'mid' | 'end' = 0, o: { nth?: number; mods?: string[]; kind?: 'click' | 'dblclick'; root?: string } = {}): Promise<boolean> {
	const p = await mdPoint(needle, at, o.nth ?? 0, o.root ?? PM);
	if (!p || !p.inside) return false;
	const c = await realClick(p.x, p.y, o.mods ?? [], o.kind ?? 'click');
	await browser.pause(250);
	return c.recorded;
}
/** Wait until the face's text holds `needle` (or not, with `present = false`). */
async function waitMd(needle: string, present = true, timeout = 8_000): Promise<boolean> {
	return browser
		.waitUntil(async () => (await mdText()).includes(needle) === present, { timeout })
		.then(() => true)
		.catch(() => false);
}
/** The first and last differing line between two texts (common prefix / suffix trimmed); null when equal. */
function changedLines(a: string, b: string): { from: number; toA: number; toB: number; a: string[]; b: string[] } | null {
	if (a === b) return null;
	const la = a.split('\n');
	const lb = b.split('\n');
	let p = 0;
	while (p < la.length && p < lb.length && la[p] === lb[p]) p++;
	let s = 0;
	while (s < la.length - p && s < lb.length - p && la[la.length - 1 - s] === lb[lb.length - 1 - s]) s++;
	return { from: p, toA: la.length - s, toB: lb.length - s, a: la.slice(p, la.length - s), b: lb.slice(p, lb.length - s) };
}
/** Save with a real Command + S and wait for the save_document round trip. */
async function realSave(): Promise<Array<Awaited<ReturnType<typeof savesSince>>[number]>> {
	const mark = await captureMark();
	await realKey(KEY.s, ['cmd'], 1_500);
	await browser.waitUntil(async () => (await savesSince(mark)).length > 0, { timeout: 15_000 }).catch(() => undefined);
	return savesSince(mark);
}
/** Put a fixture back from outside (an atomic rename) and wait for the clean face to follow. */
async function restoreMd(rel: string, original: string, marker: string): Promise<void> {
	writeAtomic(fileOf(rel), original);
	await waitMd(marker, true, 10_000);
	await browser.pause(400);
}
function needsReal(gate: number | string, what: string): boolean {
	if (!OPERATOR || realInputBlocked) {
		skipped(gate, what, realInputBlocked ?? 'no operator');
		return false;
	}
	return true;
}

// --- the native menus (the editor's own menu of Tauri's menu API, WebKit's, a <select>'s list) ----------

interface PopupWindow {
	x: number;
	y: number;
	w: number;
	h: number;
}
interface PopupItem {
	title: string;
	enabled?: boolean;
	mark?: string;
	submenu?: boolean;
}
/**
 * A real right (or left) click that opens a native menu, read and pressed in the same operator step (while
 * the menu is open the app's main thread is in the menu's tracking loop, so webdriver waits). `read` = the
 * titles down to the submenu whose items to list ([] = the top level), `press` = the titles down to the item
 * to press (none = the menu is closed without choosing).
 */
async function realPopup(clientX: number, clientY: number, o: { button?: 'right' | 'left'; mods?: string[]; read?: string[] | null; press?: string[] | null; pressKeys?: string[] | null; shot?: string } = {}) {
	requireRealInput();
	refreshFrame(screen!.pid);
	const s = toScreen(clientX, clientY);
	const a = await operator('popup', { x: s.x, y: s.y, button: o.button ?? 'right', mods: o.mods ?? [], route: 'hid', read: o.read ?? null, press: o.press ?? null, press_keys: o.pressKeys ?? null, shot: o.shot ?? '' }, 240_000);
	if (a && a.idle_short === true) environment('popup', `the user was at the keyboard (idle ${String(a.idle_s)} s) when the click at (${s.x}, ${s.y}) was due; not sent`, { answer: a });
	if (a && a.front === false) environment('popup', `the driver could not bring the window to the front for the click at (${s.x}, ${s.y}); not sent`, { answer: a });
	await browser.pause(600);
	const popup = (a?.popup ?? {}) as { found?: boolean; windows?: PopupWindow[] };
	const read = (a?.read ?? null) as { items?: PopupItem[]; missing?: string | null } | null;
	const press = (a?.press ?? null) as { pressed?: boolean; missing?: string | null } | null;
	return { answer: a, screen: s, found: popup.found === true, window: popup.windows?.[0] ?? null, items: read?.items ?? [], read, press, sent: a?.sent === true };
}
const titles = (items: PopupItem[]) => items.map((i) => i.title).filter((t) => t !== '');
/** The menu opens where the pointer is: its top-left (or, flipped, its bottom-left) within 24 pt of the click. */
function nearPoint(w: PopupWindow | null, s: { x: number; y: number }): boolean {
	if (!w) return false;
	return Math.abs(w.x - s.x) <= 24 && (Math.abs(w.y - s.y) <= 24 || Math.abs(w.y + w.h - s.y) <= 24);
}

// --- stage 2 ------------------------------------------------------------------------------------

/** Gates 2・5・7: the face opens editable, no Markdown symbols, the hard-to-edit blocks, clicks change nothing. */
async function gateMdFace(): Promise<void> {
	const ms = await openMd('ai-report.md', 'Weekly report');
	const facts = await browser.execute(
		(pm, fm) => {
			const face = document.querySelector<HTMLElement>(pm);
			const chip = document.querySelector<HTMLElement>(fm);
			const raw = document.querySelector<HTMLElement>(`${pm} .vellis-raw-html`);
			const rawInline = document.querySelector<HTMLElement>(`${pm} .vellis-raw-html-inline`);
			const text = face?.innerText ?? '';
			return {
				editable: face?.getAttribute('contenteditable') ?? null,
				symbols: { stars: text.includes('**'), link: text.includes(']('), heading_hash: /(^|\n)#{1,6} /.test(text), backtick: text.includes('`'), footnote_label: text.includes('[^1]') },
				chip: chip ? { text: chip.textContent, editable: chip.getAttribute('contenteditable'), first: face?.firstElementChild === chip || face?.firstElementChild?.contains(chip) === true } : null,
				raw: raw ? { editable: raw.getAttribute('contenteditable'), details: raw.querySelector('details') !== null } : null,
				raw_inline: rawInline ? { editable: rawInline.getAttribute('contenteditable'), kbd: rawInline.querySelector('kbd') !== null } : null,
				mermaid: document.querySelector(`${pm} .vellis-mermaid`) !== null,
				mermaid_svg: document.querySelector(`${pm} .vellis-mermaid svg`) !== null,
				table_cols: document.querySelectorAll(`${pm} table tr:first-child > *`).length,
				editable_pre: document.querySelector('article.viewer pre[contenteditable="true"]') !== null,
			};
		},
		PM,
		FRONT_MATTER,
	);
	judge(2, `ai-report.md opens straight into the ProseMirror face (contenteditable), no editable <pre> / Done Editing (${ms} ms)`, facts.editable === 'true' && !facts.editable_pre && !(await exists(EDIT_DONE)), { facts, open_ms: ms });
	judge(2, 'no Markdown symbol is visible on the face: no `**`, no `](`, no `# ` at a line start, no backtick, no `[^1]` (raw not switched on)', !Object.values(facts.symbols).some(Boolean), { symbols: facts.symbols });
	judge(5, 'front matter: the chip "Front matter · N lines" (not its YAML) is the first block and not editable (contenteditable=false)', !!facts.chip && facts.chip.editable === 'false' && /^Front matter · \d+ lines$/.test((facts.chip.text ?? '').trim()) && facts.chip.first, { chip: facts.chip });
	judge(5, 'raw HTML: the block (<details>) and the inline (<kbd>) are drawn as HTML and not editable (contenteditable=false)', !!facts.raw && facts.raw.editable === 'false' && facts.raw.details && !!facts.raw_inline && facts.raw_inline.editable === 'false' && facts.raw_inline.kbd, { raw: facts.raw, raw_inline: facts.raw_inline });
	await browser.waitUntil(async () => exists(`${PM} .vellis-mermaid svg`), { timeout: 10_000 }).catch(() => undefined);
	judge(5, 'mermaid: drawn as the figure (an <svg>) while the cursor is elsewhere', await exists(`${PM} .vellis-mermaid svg`), { mermaid: facts.mermaid });
	human(5, 'front matter chip, raw HTML, mermaid and the alert / table / footnote as they look on the face, against the v0.6.0 rendering = 【人】', { file: await shotNamed('req74-md-face-ai_report') });
	if (!needsReal(7, 'real clicks / a real double-click on the face')) return;
	const before = await mdText();
	const targets: Array<[string, number]> = [['quick brown', 3], ['Summary', 2], ['first item', 4], ['owl', 1], ['Closing paragraph', 5]];
	const clicks: Array<{ target: string; recorded: boolean }> = [];
	for (const [needle, at] of targets) clicks.push({ target: needle, recorded: await clickMd(needle, at) });
	await browser.pause(400);
	judge(7, 'five real clicks (a paragraph, a heading, a list item, a table cell, the last paragraph) change nothing: the same text, no Unsaved badge', clicks.every((c) => c.recorded) && (await mdText()) === before && !(await exists(BADGE)), { clicks, badge: await exists(BADGE) });
	const m0 = await mouseMark();
	const dbl = await clickMd('quick', 'mid', { kind: 'dblclick' });
	const sel = await mdSel();
	const seen = await mouseAfter(m0);
	judge(2, 'a real double-click selects the word ("quick") and opens no editing gate: no editable <pre>, no Done Editing, the text unchanged', dbl && sel.text === 'quick' && sel.inFace && !(await exists('article.viewer pre[contenteditable="true"]')) && !(await exists(EDIT_DONE)) && (await mdText()) === before, { sel, mouse: seen });
	// mermaid: the cursor moves into the fence from the paragraph below (real ↑) → the source; ↓ back → the figure.
	if (await clickMd('Closing paragraph', 0)) {
		// After each ↑: the source shown? the mermaid node selected as a whole (NodeSelection = .ProseMirror-selectednode)?
		const steps: Array<{ source: boolean; figure: boolean; node_selected: boolean }> = [];
		const look = async () => ({
			source: await exists(`${PM} .vellis-mermaid-block .cm-editor`),
			figure: await exists(`${PM} .vellis-mermaid`),
			node_selected: await exists(`${PM} .vellis-mermaid-block.ProseMirror-selectednode`),
		});
		let entered = false;
		for (let i = 0; i < 3 && !entered; i++) {
			await realKey(KEY2.up);
			await browser.pause(400);
			const l = await look();
			steps.push(l);
			entered = l.source && !l.figure;
		}
		// And a real click on the figure itself (the other way a person would try).
		let clickLook: Awaited<ReturnType<typeof look>> | null = null;
		if (!entered) {
			const fig = await rectOf(`${PM} .vellis-mermaid`);
			if (fig) {
				await realClick(Math.round(fig.x + fig.width / 2), Math.round(fig.y + Math.min(fig.height / 2, 40)));
				await browser.pause(500);
				clickLook = await look();
			}
		}
		const source = entered || (clickLook?.source === true && clickLook.figure === false);
		await clickMd('Closing paragraph', 0);
		await browser.pause(900);
		const figureBack = await exists(`${PM} .vellis-mermaid`);
		judge(5, 'mermaid: the cursor gets into the fence (real ↑ from the paragraph below, or a real click on the figure) and the source (CodeMirror) replaces the figure; leaving brings the figure back; the text unchanged', source && figureBack && (await mdText()) === before, { arrow_steps: steps, click_on_figure: clickLook, figure_back: figureBack });
	} else {
		environment(5, 'the click on "Closing paragraph" was not seen by the page; the mermaid step is skipped');
	}
	human(7, 'reading on a face that is editable from the start: did a key land by mistake, is the Unsaved badge noticed, do scrolling (trackpad, Space is a character here) and clicks feel safe = 【人】 (docs/req74-stage24-device.md B.2)', {});
}

/** Gates 2・3・12-10: selecting across blocks and deleting, pasting as text (+ Paste as Markdown), Format and the shortcuts. */
async function gateMdEditing(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	if (!needsReal(2, 'cross-block selection / paste / Format by real input')) return;
	const before = await mdText();
	// Across blocks: Shift + click from "Second |paragraph" to "Third |paragraph", Backspace.
	const a = await clickMd('Second paragraph', 7);
	const b = await clickMd('Third paragraph', 6, { mods: ['shift'] });
	const sel = await mdSel();
	await realKey(KEY2.backspace);
	await browser.pause(400);
	const merged = (await mdDoc())?.blocks.find((x) => x.text.startsWith('Second paragraph closes'));
	judge(2, 'a real click and a Shift + click select across two paragraphs; Backspace joins them ("Second " + "paragraph closes …") and the Unsaved badge shows', a && b && sel.text.includes('\n') && !!merged && (await exists(BADGE)), { sel: sel.text.slice(0, 120), merged: merged?.text.slice(0, 60) });
	await realKey(KEY.z, ['cmd']);
	await browser.pause(400);
	judge(9, 'a real Command + Z brings both paragraphs back (the same text, the badge gone)', (await mdText()) === before && !(await exists(BADGE)), {});
	// Paste: text/plain enters as characters; Paste as Markdown turns it into structure; Command + Z back.
	const saved = await operator('pasteboard', { op: 'save' });
	pasteboardSaved = !!saved && !saved.error;
	await operator('pasteboard', { op: 'set-text', text: ' PASTED **plain**' });
	if (await clickMd('as well.', 'end')) {
		await realKey(KEY.v, ['cmd'], 800, 'hid');
		const literal = (await mdText()).includes('as well. PASTED **plain**') && !(await marked('strong', 'plain'));
		const chip = await exists(PASTE_CHIP);
		judge(8, 'a real Command + V of text/plain `PASTED **plain**` enters as characters (the stars are text, no bold)', literal, { around: (await mdText()).split('\n').find((l) => l.includes('PASTED')) });
		judge(12, '12-10: right after that paste the "Paste as Markdown" chip is offered', chip, {});
		if (chip) {
			const r = await rectOf(PASTE_CHIP);
			const c = r ? await realClick(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)) : null;
			await browser.pause(500);
			judge(12, '12-10: a real click on the chip reads the paste again as Markdown: `plain` becomes bold and the stars are gone', !!c?.recorded && (await marked('strong', 'plain')) && !(await mdText()).includes('**plain**'), {});
			await realKey(KEY.z, ['cmd']);
			await browser.pause(400);
			judge(12, '12-10: Command + Z after Paste as Markdown gives the characters back (`**plain**` as text)', (await mdText()).includes('PASTED **plain**') && !(await marked('strong', 'plain')), {});
		}
	} else {
		environment(8, 'the click at the end of "…as well." was not seen by the page; the paste step is skipped');
	}
	await ensureClean('after the paste steps');
	const restored = await operator('pasteboard', { op: 'restore' });
	if (restored && restored.ok === true) pasteboardSaved = false;
	// Format ▸ Bold (AX) on a double-clicked word, and again to remove it.
	await clickMd('quick', 'mid', { kind: 'dblclick' });
	const bold1 = await operator('press-menu', { menu: 'Format', item: 'Bold' });
	await browser.pause(400);
	const on = await marked('strong', 'quick');
	const keep = (await mdSel()).text;
	await operator('press-menu', { menu: 'Format', item: 'Bold' });
	await browser.pause(400);
	judge(3, 'Format ▸ Bold (AX) on a double-clicked word makes it bold and keeps it selected; Format ▸ Bold again takes it off', on && keep === 'quick' && !(await marked('strong', 'quick')), { press: bold1, kept_selection: keep });
	// The shortcuts: Command + B / Command + I on a selected word.
	await clickMd('brown', 'mid', { kind: 'dblclick' });
	const selBrown = (await mdSel()).text;
	const pm3 = await pageMark();
	await realKey(KEY2.b, ['cmd']);
	const b2 = await marked('strong', 'brown');
	// (14) Command + B is taken by the face and runs the Format command once: a second application (the menu's
	// accelerator as well) would take the bold off again. Still bold 1 s later, the badge on, one Bold in the history.
	await browser.pause(1_000);
	const b2Later = await marked('strong', 'brown');
	const b2Badge = await exists(BADGE);
	const pmOnce = await pageSince(pm3);
	judge(3, '(14) one real Command + B applies bold once: still bold 1 s later and the Unsaved badge on (no second application by the menu)', b2 && b2Later && b2Badge, { bold_at_once: b2, bold_after_1s: b2Later, badge: b2Badge, page: pmOnce });
	// Exactly one command per key press: one Command + Z takes the bold back and the document is clean again.
	await realKey(KEY.z, ['cmd']);
	await browser.pause(500);
	const bUndone = !(await marked('strong', 'brown')) && !(await exists(BADGE));
	judge(3, '(14) one real Command + B = exactly one command: one Command + Z takes the bold off again and the Unsaved badge goes', b2Later && bUndone, { bold_gone: !(await marked('strong', 'brown')), badge: await exists(BADGE) });
	// The same for Command + I.
	await clickMd('brown', 'mid', { kind: 'dblclick' });
	const pmI = await pageMark();
	await realKey(KEY2.i, ['cmd']);
	const i0 = await marked('em', 'brown');
	await browser.pause(1_000);
	const iLater = await marked('em', 'brown');
	const iBadge = await exists(BADGE);
	await realKey(KEY.z, ['cmd']);
	await browser.pause(500);
	const iUndone = !(await marked('em', 'brown')) && !(await exists(BADGE));
	judge(3, '(14) one real Command + I = exactly one command: italic on and still on 1 s later (badge on); one Command + Z takes it off and the badge goes', i0 && iLater && iBadge && iUndone, { italic_at_once: i0, italic_after_1s: iLater, badge: iBadge, undone: iUndone, page: await pageSince(pmI) });
	// On and off by the shortcut itself.
	await clickMd('brown', 'mid', { kind: 'dblclick' });
	await realKey(KEY2.b, ['cmd']);
	const b2b = await marked('strong', 'brown');
	await realKey(KEY2.b, ['cmd']);
	const b3 = await marked('strong', 'brown');
	await realKey(KEY2.i, ['cmd']);
	const i1 = await marked('em', 'brown');
	await realKey(KEY2.i, ['cmd']);
	judge(3, 'real Command + B puts bold on and off the selected word; Command + I does the same with italic', b2b && !b3 && i1 && !(await marked('em', 'brown')), { selected: selBrown, bold_on: b2b, bold_off: !b3, italic_on: i1, page: await pageSince(pm3) });
	// The empty selection: the caret inside a word → the word.
	await clickMd('plain words only', 2);
	const selPlain = await mdSel();
	const pmPlain = await pageMark();
	await realKey(KEY2.b, ['cmd']);
	judge(3, 'an empty selection inside a word ("pl|ain"): Command + B makes the whole word bold', await marked('strong', 'plain'), { strong: await marked('strong', 'plain'), sel: selPlain, page: await pageSince(pmPlain) });
	await realKey(KEY.z, ['cmd']);
	// Two blocks: Format ▸ Italic over a selection across two paragraphs.
	await clickMd('Second paragraph', 0);
	await clickMd('Third paragraph', 5, { mods: ['shift'] });
	await operator('press-menu', { menu: 'Format', item: 'Italic' });
	await browser.pause(400);
	judge(3, 'Format ▸ Italic over a selection across two paragraphs: both get italic', (await marked('em', 'Second')) && (await marked('em', 'Third')), {});
	await realKey(KEY.z, ['cmd']);
	await browser.pause(300);
	judge(3, 'after the undos the document is as it was (the badge gone)', (await mdText()) === before && !(await exists(BADGE)), {});
	await ensureClean('after the format steps');
	const detail = await operator('menu-detail', { menu: 'Format' });
	fact(3, 'the Format menu as AX reads it (titles and key equivalents)', { menu: detail });
	human(3, 'Format menu and shortcuts: on / off / empty selection / several blocks feel right; the shortcut assignments (起案時判断 (g)) = 【人】', {});
}

/** Gate 4: a save keeps the bytes outside the touched blocks (the git diff of the file). */
async function gateMdBytes(): Promise<void> {
	if (!needsReal(4, 'editing and saving with real keys')) return;
	// (1) Characters in one paragraph: only those characters change.
	await openMd('ai-report.md', 'Weekly report');
	const original = readBytes('ai-report.md');
	if (await clickMd('closes the summary', 'end')) {
		await realText(' EDIT');
		await waitMd('summary EDIT');
		const saves = await realSave();
		const after = readBytes('ai-report.md');
		const expected = original.replace('Third paragraph closes the summary with', 'Third paragraph closes the summary EDIT with');
		judge(4, 'typing ` EDIT` inside a paragraph and a real Command + S: the file differs by those characters only (front matter, table, alert, footnote, raw HTML, fences byte for byte)', saves.length === 1 && saves[0]!.ok === true && after === expected, { saves: saves.map((s) => ({ ok: s.ok, body: s.body })), diff: changedLines(original, after) });
		await restoreMd('ai-report.md', original, 'closes the summary with');
	} else environment(4, 'the click after "closes the summary" was not seen by the page');
	// (2) Bold on a word: only that paragraph's line changes.
	if (await clickMd('again', 'mid', { kind: 'dblclick' })) {
		// Format ▸ Bold by AX, not Command + B: the shortcut itself is judged in gate 3 (run 1・2: it did nothing).
		await operator('press-menu', { menu: 'Format', item: 'Bold' });
		await browser.pause(400);
		const saves = await realSave();
		const after = readBytes('ai-report.md');
		const d = changedLines(original, after);
		const line = original.split('\n').findIndex((l) => l.startsWith('Second paragraph of the summary'));
		judge(4, 'Format ▸ Bold on "again" and save: the only changed line is that paragraph’s (git diff = 1 line)', saves.some((s) => s.ok === true) && !!d && d.from === line && d.toA === line + 1 && d.toB === line + 1, { diff: d });
		human(4, 'how the touched paragraph was written back (spelling of the bold, escapes) is acceptable (起案時判断 (d)) = 【人】', { diff: d });
		await restoreMd('ai-report.md', original, 'the fox again,');
	}
	// (3) A table cell: the change stays inside the table; the alignment row keeps its colons.
	if (await clickMd('owl', 'end')) {
		await realText('s');
		await realSave();
		const after = readBytes('ai-report.md');
		const d = changedLines(original, after);
		const lines = original.split('\n');
		const tFrom = lines.findIndex((l) => l.startsWith('| Name'));
		const tTo = lines.findIndex((l, i) => i > tFrom && !l.startsWith('|'));
		const align = after.split('\n').find((l) => /^\|\s*:?-+/.test(l)) ?? '';
		judge(4, 'a letter typed in a table cell and saved: the changed lines lie inside the table, the alignment row still reads left / centre / right', !!d && d.from >= tFrom && d.toA <= tTo && /^\|\s*:-+\s*\|\s*:-+:\s*\|\s*-+:\s*\|\s*$/.test(align), { diff: d, align });
		await restoreMd('ai-report.md', original, 'owl');
	}
	// (4) CRLF: every \r\n kept, only the touched line differs.
	await openMd('crlf.md', 'CRLF notes');
	const crlf = readBytes('crlf.md');
	if (await clickMd('stays as it is.', 'end')) {
		await realText(' EDIT');
		await waitMd('as it is. EDIT');
		await realSave();
		const after = readBytes('crlf.md');
		const expected = crlf.replace('Line three stays as it is.\r\n', 'Line three stays as it is. EDIT\r\n');
		judge(4, 'crlf.md: typing and a real Command + S keep every `\\r\\n` and change only the touched line', after === expected, { crlf_before: (crlf.match(/\r\n/g) ?? []).length, crlf_after: (after.match(/\r\n/g) ?? []).length, diff: changedLines(crlf, after) });
		await restoreMd('crlf.md', crlf, 'stays as it is.');
	}
}

/** Gate 6 on the Markdown face, with the conflict diff (16-1) and the line-ending mark (16-2 via a conflict). */
async function gateMdExternal(): Promise<void> {
	await openMd('ext.md', 'Paragraph 40');
	const original = readBytes('ext.md');
	const para = (n: number) => `Paragraph ${String(n).padStart(2, '0')} the quick brown fox.`;
	let disk = original.replace(para(5), 'Paragraph 05 changed outside.');
	writeAtomic(fileOf('ext.md'), disk);
	const followed = await waitMd('Paragraph 05 changed outside.', true, 10_000);
	judge(6, 'Markdown, a clean face: an external write is taken in silently (the paragraph follows, no banner / notice / badge)', followed && !(await exists(CONFLICT)) && !(await exists(MERGED)) && !(await exists(BADGE)), {});
	if (!needsReal(6, 'the merge / conflict / save refusal on the Markdown face')) {
		await restoreMd('ext.md', original, para(5));
		return;
	}
	await clickMd(para(1), 0);
	await realText('MINE ');
	await waitMd('MINE Paragraph 01');
	disk = disk.replace(para(10), 'Paragraph 10 changed outside.');
	writeAtomic(fileOf('ext.md'), disk);
	await waitMd('Paragraph 10 changed outside.', true, 10_000);
	await browser.pause(300);
	judge(6, 'Markdown, dirty, a non-overlapping external change: merged (my `MINE ` and their paragraph 10 both there), the merge notice, no banner', (await mdText()).includes('MINE Paragraph 01') && (await exists(MERGED)) && !(await exists(CONFLICT)), { notice: await textOf(MERGED) });
	await realKey(KEY.z, ['cmd']);
	await browser.pause(400);
	judge(6, 'a real Command + Z after the merge takes back my edit and leaves the agent’s paragraph 10', !(await mdText()).includes('MINE ') && (await mdText()).includes('Paragraph 10 changed outside.'), {});
	// Overlap → the banner → Show Differences (16-1).
	await clickMd(para(20), 'end');
	await realText(' MINE20');
	await waitMd('fox. MINE20');
	const mine = await mdText();
	disk = disk.replace(para(20), 'Paragraph 20 theirs.');
	writeAtomic(fileOf('ext.md'), disk);
	await waitFor(CONFLICT, 'the conflict banner', 10_000).catch(() => undefined);
	judge(6, 'an overlapping external change: the conflict banner with Show Differences / Keep My Edits / Use the File on Disk; the document untouched', (await exists(CONFLICT)) && (await exists(CONFLICT_DIFF)) && (await mdText()) === mine, {});
	await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), CONFLICT_DIFF);
	await waitFor(DIFF, 'the conflict diff', 5_000).catch(() => undefined);
	const diffText = await textOf(DIFF);
	judge(16, '16-1: Show Differences opens the diff "Conflicting Changes" with my line (` MINE20`) and theirs (`Paragraph 20 theirs.`), and the same two buttons as the banner', (await textOf(DIFF_TITLE)).includes('Conflicting Changes') && diffText.includes('MINE20') && diffText.includes('Paragraph 20 theirs.') && (await exists(DIFF_KEEP)) && (await exists(DIFF_DISK)), { title: await textOf(DIFF_TITLE) });
	human(16, '16-1: the conflict diff — readable? = 【人】', { file: await shotNamed('req74-md-conflict-diff') });
	await realKey(KEY.escape);
	await browser.pause(400);
	judge(16, '16-1: a real Escape closes the diff; the document and the banner stay', !(await exists(DIFF)) && (await mdText()) === mine && (await exists(CONFLICT)), {});
	// AC-74-16 on the Markdown face: the real save is refused.
	const sha = sha256(fileOf('ext.md'));
	const refused = await realSave();
	judge(6, `Markdown: a real Command + S during the conflict is refused ("${SAVE_CONFLICT_PREFIX}…"), the file’s bytes unchanged, no .vellis-tmp`, refused.length === 1 && refused[0]!.ok === false && String(refused[0]!.body ?? '').startsWith(SAVE_CONFLICT_PREFIX) && sha256(fileOf('ext.md')) === sha && tmpLeftovers().length === 0, { saves: refused.map((r) => ({ ok: r.ok, body: r.body })) });
	// Keep My Edits from inside the diff, then the save writes.
	await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), CONFLICT_DIFF);
	await waitFor(DIFF_KEEP, 'the diff’s Keep My Edits', 5_000).catch(() => undefined);
	await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), DIFF_KEEP);
	await browser.pause(500);
	const kept = await realSave();
	const afterKeep = readBytes('ext.md');
	judge(16, '16-1: Keep My Edits in the diff = the banner’s (the banner and the diff go); the next Command + S writes my paragraph 20 with the disk’s paragraph 10', !(await exists(DIFF)) && !(await exists(CONFLICT)) && kept.some((k) => k.ok === true) && afterKeep.includes('MINE20') && afterKeep.includes('Paragraph 10 changed outside.'), { diff_open: await exists(DIFF), banner: await exists(CONFLICT), saves: kept.map((k) => ({ ok: k.ok, body: k.body })), file_has_mine20: afterKeep.includes('MINE20'), file_has_p10: afterKeep.includes('Paragraph 10 changed outside.'), face_has_mine20: (await mdText()).includes('MINE20') });
	// Use the File on Disk from the diff.
	await clickMd(para(30), 'end');
	await realText(' MINE30');
	await waitMd('MINE30');
	writeAtomic(fileOf('ext.md'), readBytes('ext.md').replace(para(30), 'Paragraph 30 theirs.'));
	await waitFor(CONFLICT, 'the second conflict banner', 10_000).catch(() => undefined);
	await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), CONFLICT_DIFF);
	await waitFor(DIFF_DISK, 'the diff’s Use the File on Disk', 5_000).catch(() => undefined);
	await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), DIFF_DISK);
	await waitMd('Paragraph 30 theirs.', true, 5_000);
	judge(16, '16-1: Use the File on Disk in the diff = the banner’s: the disk’s text, not dirty, no banner, no diff', !(await mdText()).includes('MINE30') && !(await exists(BADGE)) && !(await exists(CONFLICT)) && !(await exists(DIFF)), {});
	await restoreMd('ext.md', original, para(30));
	// The line-ending mark: crlf.md dirty, the disk rewritten with LF and a change on my line → the diff shows it.
	await openMd('crlf.md', 'CRLF notes');
	const crlf = readBytes('crlf.md');
	if (await clickMd('of the CRLF document.', 'end')) {
		await realText(' MINE');
		await waitMd('document. MINE');
		writeAtomic(fileOf('crlf.md'), crlf.replace(/\r\n/g, '\n').replace('Line one of the CRLF document.', 'Line one, theirs.'));
		await waitFor(CONFLICT, 'the CRLF conflict banner', 10_000).catch(() => undefined);
		await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), CONFLICT_DIFF);
		await waitFor(DIFF, 'the CRLF conflict diff', 5_000).catch(() => undefined);
		judge(16, '16-2: lines that differ only by the line ending (`\\r\\n` ↔ `\\n`) carry the "Line endings differ" mark in the diff', await exists(DIFF_EOL), { marks: await browser.execute((s) => document.querySelectorAll(s).length, DIFF_EOL) });
		await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), DIFF_DISK);
		await browser.pause(500);
	}
	await restoreMd('crlf.md', crlf, 'Line one of the CRLF document.');
	human(6, 'Claude Code / Codex writing the open Markdown file while you read or type = 【人】 (docs/req74-stage24-device.md B.4)', {});
}

/** Gate 7: footnote and link clicks navigate; Option + click does not; View ▸ Raw Source and back; undo of raw edits. */
async function gateMdNavRaw(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	if (!needsReal(7, 'navigation and Raw Source by real input')) return;
	const before = await mdText();
	const scroller = 'article.viewer';
	await browser.execute((s) => { const el = document.querySelector(s); if (el) el.scrollTop = 0; }, scroller);
	const ref = await rectOf(`${PM} .footnote-ref`);
	if (ref) {
		const top0 = await browser.execute((s) => document.querySelector(s)?.scrollTop ?? 0, scroller);
		await realClick(Math.round(ref.x + ref.width / 2), Math.round(ref.y + ref.height / 2));
		await browser.pause(700);
		const def = await rectOf(`${PM} .footnote-definition`);
		const top1 = await browser.execute((s) => document.querySelector(s)?.scrollTop ?? 0, scroller);
		judge(7, 'a real click on the footnote reference scrolls to its definition (now in view); the text unchanged', top1 > top0 && !!def && def.y >= 0 && def.y < (await browser.execute(() => window.innerHeight)) && (await mdText()) === before, { scroll: [top0, top1], def });
	} else fact(7, 'no .footnote-ref on the face; the footnote click is not driven', {});
	await clickMd('link to notes', 'mid', { mods: ['opt'] });
	await browser.pause(1_200);
	judge(7, 'Option + click on the link does not navigate (still ai-report.md, the text unchanged)', (await mdText()) === before, {});
	await clickMd('link to notes', 'mid');
	const moved = await browser.waitUntil(async () => (await mdText()).startsWith('Notes'), { timeout: 8_000 }).then(() => true).catch(() => false);
	judge(7, 'a plain real click on the link `[link to notes](notes.md)` opens notes.md (起案時判断 (aa))', moved, { head: (await mdText()).slice(0, 40) });
	await openMd('ai-report.md', 'Weekly report');
	// Raw Source: the caret maps to the same place; edit there; back; one Command + Z undoes the raw edit.
	await clickMd('Third paragraph', 5);
	const press = await operator('press-menu', { menu: 'View', item: 'Raw Source' });
	await waitFor(RAW, 'the raw face', 5_000).catch(() => undefined);
	const rawFacts = await browser.execute((s) => {
		const c = document.querySelector(`${s} .cm-content`) as unknown as { cmTile?: { root?: { view?: { state: { doc: { lineAt(p: number): { text: string } }; selection: { main: { head: number } } } } } } } | null;
		const st = c?.cmTile?.root?.view?.state;
		return { line: st ? st.doc.lineAt(st.selection.main.head).text : null, pm_hidden: getComputedStyle(document.querySelector('[data-testid="markdown-editor"] .ProseMirror') ?? document.body).display === 'none' };
	}, RAW);
	judge(7, 'View ▸ Raw Source (AX): the raw face appears and its caret sits on the line of the clicked paragraph ("Third paragraph …")', (await exists(RAW)) && (rawFacts.line ?? '').startsWith('Third paragraph'), { press, raw: rawFacts });
	await realText(' RAW');
	await realKey(KEY2.u, ['opt', 'cmd']);
	await browser.pause(700);
	judge(7, 'a real Option + Command + U returns to the rendered face with the raw edit in it (` RAW` shows), the badge on', !(await exists(RAW)) && (await mdText()).includes(' RAW') && (await exists(BADGE)), {});
	const focusBack = await browser.execute((s) => {
		const a = document.activeElement;
		return { tag: a ? `${a.tagName.toLowerCase()}.${typeof a.className === 'string' ? a.className.split(' ').join('.') : ''}` : null, in_face: !!a && !!document.querySelector(s)?.contains(a) };
	}, PM);
	const pmUndo = await pageMark();
	await realKey(KEY.z, ['cmd']);
	await browser.pause(500);
	const afterUndo = await mdText();
	judge(7, 'one real Command + Z undoes the whole raw edit (契約23); the badge goes', afterUndo === before && !(await exists(BADGE)), { raw_left: afterUndo.includes('RAW'), badge: await exists(BADGE), diff: changedLines(before, afterUndo), focus_after_return: focusBack, page: await pageSince(pmUndo) });
	await ensureClean('after Raw Source');
	// Front matter is corrected in raw (契約7・(y)): edit its author line in raw, come back — the chip is still the first
	// block — save: the file differs in that line only.
	const fmOriginal = readBytes('ai-report.md');
	await emitMenu('menu_raw_source');
	await waitFor(RAW, 'the raw face (front matter)', 5_000).catch(() => undefined);
	const fmClick = await clickMd('agent', 'end', { root: RAW });
	await realText('2');
	await realKey(KEY2.u, ['opt', 'cmd']);
	await browser.pause(700);
	const chipNow = await browser.execute((pm, fm) => {
		const face = document.querySelector(pm);
		const chip = document.querySelector(fm);
		return { first: !!chip && face?.firstElementChild === chip, text: chip?.textContent ?? null };
	}, PM, FRONT_MATTER);
	const fmSaves = await realSave();
	const fmAfter = readBytes('ai-report.md');
	judge(7, 'front matter corrected in raw (`author: agent` → `agent2`) and back: the chip is still the first block; the save changes that line only', fmClick && !(await exists(RAW)) && chipNow.first && fmSaves.some((x) => x.ok === true) && fmAfter === fmOriginal.replace('author: agent\n', 'author: agent2\n'), { click: fmClick, chip: chipNow, saves: fmSaves.map((x) => ({ ok: x.ok, body: x.body })), diff: changedLines(fmOriginal, fmAfter) });
	await restoreMd('ai-report.md', fmOriginal, 'Weekly report');
	human(7, 'raw: the caret lands near; correcting front matter / raw HTML in raw is an acceptable effort (起案時判断 (y)(z)(ab)) = 【人】', {});
}

/** Gate 8: find counts the visible text, a click at 150 % lands, the print (to PDF), the copy carries no symbols. */
async function gateMdViewing(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	await emitMenu('menu_find');
	await waitFor(FIND_INPUT, 'the find bar', 5_000);
	await browser.execute((sel, v) => {
		const el = document.querySelector<HTMLInputElement>(sel)!;
		el.value = v;
		el.dispatchEvent(new Event('input', { bubbles: true }));
	}, FIND_INPUT, 'fox');
	await browser.waitUntil(async () => (await textOf(FIND_COUNT)).includes(' of '), { timeout: 5_000 }).catch(() => undefined);
	judge(8, `Find "fox" on the Markdown face counts the visible text (${AI_REPORT_FOX}: paragraphs, a heading, a list item, an alert, a table cell; none from front matter / raw HTML / fences)`, (await textOf(FIND_COUNT)).trim() === `1 of ${AI_REPORT_FOX}`, { count: await textOf(FIND_COUNT) });
	await closeOverlays();
	if (!needsReal(8, 'the 150 % click, the print, the copy')) return;
	await emitMenu('menu_zoom_reset');
	for (let i = 0; i < 5; i++) {
		await emitMenu('menu_zoom_in');
		await browser.pause(150);
	}
	await browser.pause(500);
	const target = await mdPoint('closes the summary', 4);
	if (target?.inside) {
		const c = await realClick(target.x, target.y);
		await browser.pause(300);
		const s = await mdSel();
		const again = await mdPoint('closes the summary', 4);
		judge(8, 'at 150 % a real click on the Markdown face puts the caret on the clicked character (within 6 px)', c.recorded && s.collapsed && !!s.rect && !!again && Math.abs(s.rect.x - again.x) <= 6, { caret: s.rect, char: again });
	}
	human(8, 'the Markdown face at 150 % = 【人】', { file: await shotNamed('req74-md-zoom-150') });
	await emitMenu('menu_zoom_reset');
	await browser.pause(400);
	// Print to PDF (an unsaved edit included): every page, the visible text, no Markdown symbols.
	if (await clickMd('end of the report.', 'end')) {
		await realText(' PRINTMARK');
		await waitMd('PRINTMARK');
		const p = await operator('print-pdf', { name: 'req74-print-ai-report.pdf' }, 240_000);
		const info = (p?.pdfinfo ?? null) as { pages?: number; page?: Array<{ text: string }> } | null;
		if (!info) {
			report(REPORT, { gate: 'environment', side: VARIANT, item: 'the print round did not produce a PDF (see the answer)', reason: String(p?.error ?? 'no pdfinfo'), answer: p });
		} else {
			const all = (info.page ?? []).map((x) => x.text).join('\n');
			judge(8, 'File ▸ Print… → Save as PDF: the PDF holds the unsaved edit (PRINTMARK), the first heading and the footnote at the very end (every page), and no `**` / `](`', (info.pages ?? 0) >= 1 && all.includes('PRINTMARK') && all.includes('Weekly report') && all.includes('footnote definition') && !all.includes('**') && !all.includes(']('), { pages: info.pages, pdf: p?.pdf });
			human(8, 'the printed PDF looks like the reading view (fonts, the table, the alert, mermaid) = 【人】', { file: p?.pdf ?? null });
		}
		await ensureClean('after the print');
	}
	// Copy: a selection over bold and code carries the visible characters only.
	const saved = await operator('pasteboard', { op: 'save' });
	pasteboardSaved = !!saved && !saved.error;
	if ((await clickMd('Status is', 0)) && (await clickMd('ok', 'end', { mods: ['shift'] }))) {
		await realKey(KEY.c, ['cmd'], 600, 'hid');
		const got = await operator('pasteboard', { op: 'get-text' });
		judge(8, 'a real Command + C over "Status is **green** and the build is `ok`" carries the visible text only: "Status is green and the build is ok"', String(got?.text ?? '').trim() === 'Status is green and the build is ok', { clipboard: got });
	} else fact(8, 'the copy selection could not be made (the needles are split by the marks); the copy step is not judged', {});
	const restored = await operator('pasteboard', { op: 'restore' });
	if (restored && restored.ok === true) pasteboardSaved = false;
}

/** Gate 9 on the Markdown face: real Command + Z / Shift + Command + Z and Edit ▸ Undo / Redo (AX). */
async function gateMdUndo(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	if (!needsReal(9, 'undo / redo by real keys and AX')) return;
	const before = await mdText();
	await clickMd('end of the report.', 'end');
	// Upper case: a lower-case word after "report." was capitalised by macOS (run 5: " undo1" → " Undo1"), which adds
	// its own undo step; that is reported apart (gate 9 fact below).
	await realText(' UNDOA');
	await browser.pause(800);
	await realText(' UNDOB');
	await waitMd('UNDOB');
	const typed = await mdText();
	await realKey(KEY.z, ['cmd']);
	const u1 = await mdText();
	await realKey(KEY.z, ['cmd', 'shift']);
	judge(9, 'Markdown: a real Command + Z steps back and Shift + Command + Z forward', u1 !== typed && u1.length < typed.length && (await mdText()) === typed, { after_undo: u1.slice(-40) });
	await operator('press-menu', { menu: 'Edit', item: 'Undo' });
	await browser.pause(500);
	const m1 = await mdText();
	await operator('press-menu', { menu: 'Edit', item: 'Redo' });
	await browser.pause(500);
	const m2 = await mdText();
	judge(9, 'Markdown: Edit ▸ Undo / Redo (AX, the native selectors) reach the ProseMirror history', m1 === u1 && m2 === typed, { menu_undo_equals_key_undo: m1 === u1, menu_redo_equals_typed: m2 === typed, after_menu_undo: m1.slice(-60), after_menu_redo: m2.slice(-60), typed: typed.slice(-60) });
	for (let i = 0; i < 8 && (await mdText()) !== before; i++) await realKey(KEY.z, ['cmd'], 300);
	judge(9, 'undo all the way: the text is the file’s again and the badge goes', (await mdText()) === before && !(await exists(BADGE)), {});
	await ensureClean('after the undo gate');
}

/** Gate 10: a 1.5 MB Markdown (under the 2 MiB edit limit) and a 2.5 MB one (over it). */
async function gateMdLarge(): Promise<void> {
	const ms = await openMd('big.md', 'Section 0', 60_000);
	// 契約18: "開く重さは今と同じ" — no number in the contract; the time is recorded for the comparison with v0.6.0 (B.6).
	fact(10, `big.md (${(fs.statSync(fileOf('big.md')).size / 1024 / 1024).toFixed(1)} MB): time to the ProseMirror face ${ms} ms (compare with v0.6.0 by hand)`, { open_ms: ms });
	if (OPERATOR && !realInputBlocked && (await clickMd('Paragraph 1 with', 0))) {
		const t0 = Date.now();
		await operator('text', { text: 'Q' }, 240_000);
		const tAnswer = Date.now();
		const shown = await waitMd('QParagraph 1 with', true, 5_000);
		const sinceSent = Date.now() - tAnswer + 600;
		judge(10, `big.md: a real keystroke shows within 1.5 s of being sent (at most ${sinceSent} ms)`, shown && sinceSent < 1_500, { since_sent_upper_ms: sinceSent, operator_ms: tAnswer - t0 });
		await realKey(KEY.z, ['cmd']);
	}
	await emitMenu('menu_find');
	await waitFor(FIND_INPUT, 'the find bar', 5_000);
	const t2 = Date.now();
	await browser.execute((sel, v) => {
		const el = document.querySelector<HTMLInputElement>(sel)!;
		el.value = v;
		el.dispatchEvent(new Event('input', { bubbles: true }));
	}, FIND_INPUT, 'fox');
	await browser.waitUntil(async () => (await textOf(FIND_COUNT)).includes(' of '), { timeout: 15_000 }).catch(() => undefined);
	const n = countMatches(readBytes('big.md'), 'fox');
	judge(10, `big.md: Find "fox" counts every one (${n}) within 5 s (${Date.now() - t2} ms)`, (await textOf(FIND_COUNT)).trim() === `1 of ${n}` && Date.now() - t2 < 5_000, { count: await textOf(FIND_COUNT), expected: n });
	await closeOverlays();
	await ensureClean('after big.md');
	await clickExplorerRow(uriOf('huge.md'));
	await waitFor(TOO_LARGE, 'the too-large notice', 60_000).catch(() => undefined);
	judge(10, 'huge.md (2.5 MB > 2 MiB): the notice "too large to edit … View ▸ Raw Source" and the reading view, no editing face (契約18・判断 8)', (await exists(TOO_LARGE)) && !(await exists(PM)), { notice: await textOf(TOO_LARGE) });
	human(10, 'opening / typing / scrolling / finding in a few-MB Markdown feels light enough; the 2 MiB notice is a sensible limit = 【人】', {});
}

// --- stage 3 ------------------------------------------------------------------------------------

/** 12-1: the input rules by real keys; Command + Z / Edit ▸ Undo / Backspace right after give the symbols back. */
async function gateInputRules(): Promise<void> {
	await openMd('rules.md', 'Start here.');
	if (!needsReal(12, 'the input rules by real keys')) return;
	const last = async () => (await mdDoc())?.blocks.slice(-1)[0] ?? null;
	// Every rule starts on a fresh copy (Reload File → Don't Save, a new empty paragraph after "Start here."): a rule
	// whose undo misbehaves cannot spill into the next one (run 1: Backspaces meant for a paragraph ate the heading).
	const fresh = async () => {
		await ensureClean('12-1: a fresh rules.md');
		if (!(await clickMd('Start here.', 'end'))) environment(12, 'the click at the end of "Start here." was not seen by the page');
		await realKey(KEY.return);
	};
	const results: Record<string, unknown> = {};
	const rule = async (typed: string, check: () => Promise<boolean>, undo: 'cmd-z' | 'menu' | 'backspace', literal: string) => {
		await fresh();
		await realText(typed);
		await browser.pause(400);
		const fired = await check();
		const formed = await last();
		if (undo === 'cmd-z') await realKey(KEY.z, ['cmd']);
		else if (undo === 'menu') await operator('press-menu', { menu: 'Edit', item: 'Undo' });
		else await realKey(KEY2.backspace);
		await browser.pause(400);
		const back = await last();
		const ok = fired && back?.type === 'paragraph' && back.text === literal;
		results[typed] = { fired, formed, undo, back };
		judge(12, `12-1: typing \`${typed}\` ${fired ? 'turns into the structure' : 'did NOT turn into the structure'}; ${undo === 'menu' ? 'Edit ▸ Undo (AX)' : undo === 'cmd-z' ? 'a real Command + Z' : 'Backspace'} right after gives the characters back (\`${literal}\`, the last one included)`, ok, { formed, block_after_undo: back });
	};
	await rule('## ', async () => (await last())?.type === 'heading' && (await last())?.level === 2, 'cmd-z', '## ');
	await rule('- ', async () => (await last())?.type === 'bullet_list' || (await exists(`${PM} ul > li`)), 'backspace', '- ');
	await rule('1. ', async () => (await last())?.type === 'ordered_list' || (await exists(`${PM} ol > li`)), 'menu', '1. ');
	await rule('> ', async () => (await last())?.type === 'blockquote' || (await exists(`${PM} blockquote`)), 'cmd-z', '> ');
	await rule('```ts ', async () => (await last())?.type === 'code_block' || (await exists(`${PM} pre[data-lang="ts"]`)), 'cmd-z', '```ts ');
	await rule('```ts ', async () => (await last())?.type === 'code_block' || (await exists(`${PM} pre[data-lang="ts"]`)), 'backspace', '```ts ');
	await rule('**x**', async () => marked('strong', 'x'), 'cmd-z', '**x**');
	await rule('`y`', async () => marked('code', 'y'), 'cmd-z', '`y`');
	fact(12, '12-1: the input rules, step by step', { results });
	// A second Command + Z right after a rule's undo is an ordinary undo (the typing goes).
	await fresh();
	await realText('## ');
	await realKey(KEY.z, ['cmd']);
	await realKey(KEY.z, ['cmd']);
	await browser.pause(400);
	judge(12, '12-1: the second Command + Z after a rule is an ordinary undo (the `## ` typed goes away)', !(await mdText()).includes('## '), { last: await last() });
	await ensureClean('after the input rules');
	// Right after front matter: `# ` at the start of "abc" makes a heading; Backspace right after gives `# abc` back and
	// the front matter stays first (照合の差し戻し・43ff5f2).
	await openMd('fm-rules.md', 'abc');
	const cf = await clickMd('abc', 0);
	await realText('# ');
	await browser.pause(400);
	const formedF = (await mdDoc())?.blocks ?? [];
	await realKey(KEY2.backspace);
	await browser.pause(400);
	const backF = (await mdDoc())?.blocks ?? [];
	judge(12, '12-1: right after front matter, `# ` at the start of "abc" makes a heading 1 "abc"; Backspace right after gives the paragraph `# abc` back; the front matter stays first', cf && formedF[0]?.type === 'front_matter' && formedF[1]?.type === 'heading' && formedF[1]?.text === 'abc' && backF[0]?.type === 'front_matter' && backF[1]?.type === 'paragraph' && backF[1]?.text === '# abc', { click: cf, formed: formedF.slice(0, 3), back: backF.slice(0, 3) });
	await ensureClean('after the front matter rule');
	fact(12, '12-2: the input rules with the Japanese IME on (confirmed `##`・`**`・`` ` ``, full-width `＃＃　`, cancelling a conversion) are driven by "gate 12-2 (B.1-4)" (2026-11-20: moved from 【人】 B.1)', {});
}

/** 12-3・12-4: Format ▸ Table by AX (3-7 alt 2 in the header row), the cell keys, a multi-line paste into a cell; the save. */
async function gateTables(): Promise<void> {
	await openMd('table.md', 'After the table.');
	if (!needsReal(12, 'the table operations by AX and real keys')) return;
	const original = readBytes('table.md');
	const shape = async () => browser.execute((s) => {
		const t = document.querySelector(`${s} table`);
		if (!t) return null;
		const rows = Array.from(t.querySelectorAll('tr'));
		return { rows: rows.length, cols: rows[0]?.children.length ?? 0, header: Array.from(rows[0]?.children ?? []).map((c) => c.textContent ?? ''), second: Array.from(rows[1]?.children ?? []).map((c) => c.textContent ?? ''), brs: t.querySelectorAll('td br, th br').length };
	}, PM);
	const s0 = await shape();
	const press = async (item: string) => {
		const a = await operator('submenu-press', { menu: 'Format', submenu: 'Table', item });
		await browser.pause(500);
		return a;
	};
	const caretCell = () => browser.execute(() => {
		const n = document.getSelection()?.anchorNode ?? null;
		const el = n instanceof Element ? n : (n?.parentElement ?? null);
		return el?.closest('td, th')?.textContent ?? null;
	});
	const clickB1 = await clickMd('b1', 'end');
	const cellB1 = await caretCell();
	await press('Insert Row Below');
	const s1 = await shape();
	await press('Insert Column Right');
	const s2 = await shape();
	await press('Delete Column');
	const s3 = await shape();
	await press('Delete Row');
	const s4 = await shape();
	judge(12, '12-3: Format ▸ Table ▸ Insert Row Below / Insert Column Right / Delete Column / Delete Row (AX) add and remove a row and a column', !!s0 && s1?.rows === s0.rows + 1 && s2?.cols === s0.cols + 1 && s3?.cols === s0.cols && s4?.rows === s0.rows, { click: clickB1, caret_cell: cellB1, shapes: [s0, s1, s2, s3, s4] });
	await clickMd('Center', 'end');
	const cellCenter = await caretCell();
	await press('Insert Row Above');
	const h1 = await shape();
	judge(12, '12-3 (3-7 alt 2): Insert Row Above in the header row adds an empty body row right below the header; the header row stays', !!s0 && h1?.rows === s0.rows + 1 && JSON.stringify(h1?.header) === JSON.stringify(s0.header) && (h1?.second ?? []).every((c) => c.trim() === ''), { caret_cell: cellCenter, shape: h1 });
	await press('Delete Row');
	const h2 = await shape();
	judge(12, '12-3 (3-7 alt 2): Delete Row in the header row removes the first body row (the empty one); the header row stays', !!s0 && h2?.rows === s0.rows && JSON.stringify(h2?.header) === JSON.stringify(s0.header) && JSON.stringify(h2?.second) === JSON.stringify(s0.second), { shape: h2 });
	await realSave();
	const after = readBytes('table.md');
	const d = changedLines(original, after);
	const lines = original.split('\n');
	const tFrom = lines.findIndex((l) => l.startsWith('| Left'));
	const tTo = lines.findIndex((l, i) => i > tFrom && !l.startsWith('|'));
	judge(12, '12-3: saved after the round trip: any changed line lies inside the table and the alignment row keeps left / centre / right', (!d || (d.from >= tFrom && d.toA <= tTo)) && /^\|\s*:-+\s*\|\s*:-+:\s*\|\s*-+:\s*\|\s*$/.test(after.split('\n').find((l) => /^\|\s*:?-/.test(l)) ?? ''), { diff: d });
	human(12, '12-3: how the table was written back (padding, alignment row) and where the caret went after each operation = 【人】', { diff: d });
	await restoreMd('table.md', original, 'a1');
	// 12-4: Shift + Return in a cell does nothing; Return goes to the cell below; a multi-line paste stays on one line.
	const clickA1 = await clickMd('a1', 'end');
	const cellA1 = await caretCell();
	await realKey(KEY.return, ['shift']);
	const k1 = await shape();
	await realKey(KEY.return);
	const below = await browser.execute((s) => document.getSelection()?.anchorNode?.parentElement?.closest('td, th')?.textContent ?? null, PM);
	judge(12, '12-4: a real Shift + Return in a cell adds no line break (no <br>, the rows the same); Return moves to the cell below ("a2")', !!s0 && k1?.rows === s0.rows && k1?.brs === 0 && (below ?? '').includes('a2'), { click: clickA1, caret_cell_before: cellA1, shape: k1, cell_after_return: below });
	const saved = await operator('pasteboard', { op: 'save' });
	pasteboardSaved = !!saved && !saved.error;
	await operator('pasteboard', { op: 'set-text', text: 'L1\nL2' });
	await clickMd('c2', 'end');
	await realKey(KEY.v, ['cmd'], 800, 'hid');
	const k2 = await shape();
	const cell = await browser.execute((s) => Array.from(document.querySelectorAll(`${s} td`)).map((c) => c.textContent ?? '').find((t) => t.includes('L1')) ?? null, PM);
	judge(12, '12-4: a two-line text/plain pasted into a cell stays in that cell on one line (the table keeps its rows)', !!s0 && k2?.rows === s0.rows && (cell ?? '').includes('L1') && (cell ?? '').includes('L2') && k2?.brs === 0, { cell, shape: k2 });
	const restored = await operator('pasteboard', { op: 'restore' });
	if (restored && restored.ok === true) pasteboardSaved = false;
	await ensureClean('after the table gate');
}

/** 12-5: the editor's native right-click menu on the Markdown face, in a table, on the code face, on raw; Option + right-click. */
async function gateContextMenu(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	if (!needsReal(12, 'real right-clicks')) return;
	const before = await mdText();
	const at = await mdPoint('brown', 'mid');
	if (!at?.inside) environment(12, 'the word "brown" is not inside the view');
	const top = await realPopup(at!.x, at!.y, { read: [], shot: 'req74-ctx-markdown' });
	const t = titles(top.items);
	judge(12, '12-5: a real right-click on a word of the Markdown face opens the editor’s native menu: Cut / Copy / Paste, Format, Reload File, Pin to Bookmarks (no Table outside a table)', top.found && ['Cut', 'Copy', 'Paste', 'Format', 'Reload File'].every((x) => t.includes(x)) && t.some((x) => /Pin to Bookmarks|Unpin from Bookmarks/.test(x)) && !t.includes('Table'), { titles: t });
	judge(12, '12-5: the menu opens where the pointer is (at 100 %: its corner within 24 pt of the click)', nearPoint(top.window, top.screen), { window: top.window, click: top.screen });
	// By the keyboard inside the menu (type-select, →, Return): an AXPress on a submenu item closed the menu without
	// running it (run 9・11), which says nothing about the product.
	const bold = await realPopup(at!.x, at!.y, { pressKeys: ['Format', 'Bold'] });
	await browser.pause(400);
	const strongs = await browser.execute((s) => Array.from(document.querySelectorAll(`${s} strong`)).map((e) => e.textContent ?? ''), PM);
	judge(12, '12-5: Format ▸ Bold in that menu makes the right-clicked word bold', bold.press?.pressed === true && (await marked('strong', 'brown')), { press: { pressed: bold.press?.pressed, missing: bold.press?.missing }, sel_after: await mdSel(), strong_texts: strongs, badge: await exists(BADGE) });
	const checked = await realPopup(at!.x, at!.y, { read: ['Format'] });
	const boldItem = checked.items.find((i) => i.title === 'Bold');
	judge(12, '12-5: right-clicking the bold word again: Format ▸ Bold carries the check', !!boldItem && (boldItem.mark ?? '') !== '', { bold: boldItem });
	// (16) The menu's Format ▸ Bold ran once: one Command + Z takes it back and the document is clean again.
	await realKey(KEY.z, ['cmd']);
	await browser.pause(500);
	judge(12, '(16) Format ▸ Bold in the right-click menu = exactly one command: one Command + Z takes the bold off and the Unsaved badge goes', !(await marked('strong', 'brown')) && !(await exists(BADGE)) && (await mdText()) === before, { bold_left: await marked('strong', 'brown'), badge: await exists(BADGE) });
	// Paste from the native menu: the predefined item reaches WebKit (no NotAllowedError of a script read).
	const saved = await operator('pasteboard', { op: 'save' });
	pasteboardSaved = !!saved && !saved.error;
	await operator('pasteboard', { op: 'set-text', text: 'CTXPASTE' });
	const end = await mdPoint('end of the report.', 'end');
	if (end?.inside) {
		await realClick(end.x, end.y);
		const pasted = await realPopup(end.x - 4, end.y, { press: ['Paste'] });
		const ok = await waitMd('CTXPASTE', true, 4_000);
		judge(12, '12-5: Paste in the native menu pastes the clipboard into the face (the predefined item; 0-12)', pasted.press?.pressed === true && ok, { press: pasted.press });
		await realKey(KEY.z, ['cmd']);
	}
	const restored = await operator('pasteboard', { op: 'restore' });
	if (restored && restored.ok === true) pasteboardSaved = false;
	// In a table: Table ▸ with its seven items.
	const owl = await mdPoint('owl', 'mid');
	if (owl?.inside) {
		await realClick(owl.x, owl.y);
		const inTable = await realPopup(owl.x, owl.y, { read: ['Table'] });
		judge(12, '12-5: in a table cell the menu has Table ▸ with the seven items of Format ▸ Table', titles(inTable.items).length === 7 && titles(inTable.items).includes('Insert Row Above') && titles(inTable.items).includes('Delete Table'), { table: titles(inTable.items), missing: inTable.read?.missing ?? null });
	}
	// Option + right-click: WebKit's own menu (none of the editor's items).
	const opt = await realPopup(at!.x, at!.y, { mods: ['opt'], read: [], shot: 'req74-ctx-option' });
	judge(12, '12-5: Option + right-click opens WebKit’s own menu instead (a menu without Reload File / Format)', opt.found && !titles(opt.items).includes('Reload File') && !titles(opt.items).includes('Format'), { titles: titles(opt.items) });
	// Zoomed: the menu still opens at the pointer.
	await emitMenu('menu_zoom_reset');
	for (let i = 0; i < 5; i++) {
		await emitMenu('menu_zoom_in');
		await browser.pause(150);
	}
	await browser.pause(500);
	const z = await mdPoint('brown', 'mid');
	if (z?.inside) {
		const zoomed = await realPopup(z.x, z.y, { read: [] });
		judge(12, '12-5: at 150 % the menu still opens at the pointer (corner within 24 pt)', zoomed.found && nearPoint(zoomed.window, zoomed.screen), { window: zoomed.window, click: zoomed.screen });
	}
	await emitMenu('menu_zoom_reset');
	await browser.pause(400);
	// Pin / Unpin round trip; Reload File on a clean face reads the file again.
	const pin = await realPopup(at!.x, at!.y, { press: ['Pin to Bookmarks'] });
	const after = await realPopup(at!.x, at!.y, { read: [] });
	const unpinShown = titles(after.items).includes('Unpin from Bookmarks');
	if (unpinShown) await realPopup(at!.x, at!.y, { press: ['Unpin from Bookmarks'] });
	judge(12, '12-5: Pin to Bookmarks in the menu pins the document (the next menu offers Unpin from Bookmarks, pressed to put it back)', pin.press?.pressed === true && unpinShown, { pin: pin.press, next: titles(after.items) });
	await ensureClean('before Reload File in the menu (a dirty face would raise a dialog)');
	const mark = await captureMark();
	const reload = await realPopup(at!.x, at!.y, { press: ['Reload File'] });
	await browser.pause(800);
	judge(12, '12-5: Reload File in the menu reads the clean document again (open_document), the text unchanged', reload.press?.pressed === true && (await readCapturedIpc()).slice(mark).some((x) => x.cmd === 'open_document') && (await mdText()) === before, {});
	// The code face and raw: the same menu without Format.
	await openDoc('app.ts');
	const code = await charPoint(1, 4);
	if (code?.inside) {
		const c = await realPopup(code.x, code.y, { read: [] });
		judge(12, '12-5: on the code face: Cut / Copy / Paste, Reload File, Pin — no Format', c.found && ['Cut', 'Copy', 'Paste', 'Reload File'].every((x) => titles(c.items).includes(x)) && !titles(c.items).includes('Format'), { titles: titles(c.items) });
	}
	await openMd('ai-report.md', 'Weekly report');
	await emitMenu('menu_raw_source');
	await waitFor(RAW, 'the raw face', 5_000).catch(() => undefined);
	const rawPoint = await mdPoint('Weekly report', 'mid', 0, RAW);
	if (rawPoint?.inside) {
		const r = await realPopup(rawPoint.x, rawPoint.y, { read: [] });
		judge(12, '12-5: on raw: the same menu without Format', r.found && titles(r.items).includes('Paste') && !titles(r.items).includes('Format'), { titles: titles(r.items) });
	}
	await emitMenu('menu_raw_source');
	await browser.pause(500);
	await ensureClean('after the context menu gate');
	human(12, '12-5: the look of the menu, the checks, where it opens (shots req74-ctx-markdown / req74-ctx-option) = 【人】', {});
}

/** 12-6・12-7: Find and Replace on the code face (CRLF, a 5 MB log); Option + ↑ / ↓ and Command + / in several languages. */
async function gateReplaceAndLines(): Promise<void> {
	if (!needsReal(12, 'Find and Replace / the line keys by real keys')) return;
	const replaceAll = async (find: string, by: string) => {
		await browser.execute((fi, ri, f, r) => {
			const a = document.querySelector<HTMLInputElement>(fi)!;
			a.value = f;
			a.dispatchEvent(new Event('input', { bubbles: true }));
			const b = document.querySelector<HTMLInputElement>(ri)!;
			b.value = r;
			b.dispatchEvent(new Event('input', { bubbles: true }));
		}, FIND_INPUT, REPLACE_INPUT, find, by);
		await browser.pause(400);
		const t0 = Date.now();
		await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), REPLACE_ALL);
		return t0;
	};
	for (const [rel, find, by] of [['notes.txt', 'fox', 'cat'], ['crlf.txt', 'line', 'LINE']] as const) {
		await openDoc(rel);
		const original = readBytes(rel);
		await clickAt(0, 0);
		await realKey(KEY2.f, ['opt', 'cmd']);
		await waitFor(REPLACE_INPUT, 'the replace field', 5_000).catch(() => undefined);
		judge(12, `12-6: a real Option + Command + F on ${rel} opens Find and Replace (the replace field shows)`, await exists(REPLACE_INPUT), {});
		await replaceAll(find, by);
		await browser.pause(600);
		await closeOverlays();
		await realSave();
		const after = readBytes(rel);
		judge(12, `12-6: Replace All "${find}" → "${by}" and save: the file is the original with every match replaced and nothing else (line endings included)`, after === original.split(find).join(by), { crlf: [(original.match(/\r\n/g) ?? []).length, (after.match(/\r\n/g) ?? []).length] });
		writeAtomic(fileOf(rel), original);
		await browser.pause(1_000);
	}
	await openDoc('app.log');
	await clickAt(0, 0);
	await realKey(KEY2.f, ['opt', 'cmd']);
	await waitFor(REPLACE_INPUT, 'the replace field', 5_000).catch(() => undefined);
	const t0 = await replaceAll('ERROR', 'FAULT');
	// Read inside the page (the 5 MB document is not carried over webdriver on every poll).
	const stillThere = () => browser.execute((s) => {
		const c = document.querySelector(`${s} .cm-content`) as unknown as { cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } } } | null;
		const d = c?.cmTile?.root?.view?.state.doc.toString();
		return d === undefined ? null : d.includes('ERROR');
	}, FACE);
	const done = await browser.waitUntil(async () => (await stillThere()) === false, { timeout: 30_000 }).then(() => true).catch(() => false);
	judge(12, `12-6: Replace All on the 5 MB log finishes within 5 s (${Date.now() - t0} ms)`, done && Date.now() - t0 < 5_000, { ms: Date.now() - t0 });
	await closeOverlays();
	await ensureClean('after the log replace');
	// 12-7: the line keys.
	await openDoc('app.ts');
	const lines0 = await faceLines();
	await clickAt(1, 2);
	await realKey(KEY.down, ['opt']);
	const moved = await faceLines();
	await realKey(KEY2.up, ['opt']);
	judge(12, '12-7: a real Option + ↓ moves line 2 below line 3; Option + ↑ moves it back', moved[1] === lines0[2] && moved[2] === lines0[1] && (await faceLines()).join('\n') === lines0.join('\n'), { moved: moved.slice(0, 4) });
	const comments: Record<string, unknown> = {};
	// settings.json opens as JSON (data-vellis-lang = json; stage 1) and JSON has no comment token; `//` is for jsonc (3-14).
	for (const [rel, line, prefix] of [['app.ts', 1, '//'], ['run.sh', 2, '#'], ['tool.py', 0, '#'], ['config.jsonc', 2, '//']] as const) {
		await openDoc(rel);
		const l0 = await faceLines();
		await clickAt(line, 1);
		await realKey(KEY2.slash, ['cmd']);
		const on = (await faceLines())[line] ?? '';
		await realKey(KEY2.slash, ['cmd']);
		const off = (await faceLines())[line] ?? '';
		comments[rel] = { on, off };
		judge(12, `12-7: a real Command + / on ${rel} line ${line + 1} adds \`${prefix}\` and takes it off again`, on.trimStart().startsWith(prefix) && off === l0[line], { on, off, before: l0[line] });
		await ensureClean(`after the comment toggle on ${rel}`);
	}
	await openDoc('settings.json');
	const sj0 = await faceLines();
	await clickAt(1, 1);
	await realKey(KEY2.slash, ['cmd']);
	fact(12, '12-7: Command + / on settings.json (JSON, no comment token): what happened', { before: sj0[1], after: (await faceLines())[1], lang: await attrOf(FACE, 'data-vellis-lang') });
	await ensureClean('after Command + / on settings.json');
	fact(12, '12-7: Option + ↑ / ↓ and Command + / under each input source and keyboard type (JIS / US, the Japanese source on) are driven by "B.5 (gate 3・12-7・link)" (2026-11-20: moved from 【人】 B.5)', { comments });
}

/** 12-8: the gap cursor — before a leading table, between raw HTML blocks, after a trailing fence; never before front matter. */
async function gateGapCursor(): Promise<void> {
	await openMd('gap.md', 'Middle paragraph.');
	if (!needsReal(12, 'the gap cursor by real arrows')) return;
	const blocks = async () => ((await mdDoc())?.blocks ?? []).map((b) => `${b.type}:${b.text.slice(0, 12)}`);
	const gap = () => exists(`${PM} .ProseMirror-gapcursor`);
	/** Real ↑ / ↓ up to three times until the gap cursor shows; how many it took. */
	const arrowToGap = async (key: number): Promise<number> => {
		for (let i = 1; i <= 3; i++) {
			await realKey(key);
			if (await gap()) return i;
		}
		return 0;
	};
	// Each case on a fresh copy (run 1: an undo that left a node selected let the next letter replace a raw HTML block).
	const fresh = async (rel: string, marker: string) => {
		await ensureClean(`12-8: a fresh ${rel}`);
		await openMd(rel, marker);
	};
	const gapWhere = () => browser.execute((s) => {
		const g = document.querySelector(`${s} .ProseMirror-gapcursor`);
		if (!g) return null;
		const name = (e: Element | null) => (e ? `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? `.${e.className.split(' ')[0]}` : ''}` : null);
		const sel = document.getSelection();
		const a = sel?.anchorNode ?? null;
		return { prev: name(g.previousElementSibling), next: name(g.nextElementSibling), parent: name(g.parentElement), dom_anchor: a ? (a instanceof Element ? name(a) : `#text(${(a.textContent ?? '').slice(0, 12)})`) : null };
	}, PM);
	const c1 = await clickMd('a', 'end', { root: `${PM} table` });
	const n1 = await arrowToGap(KEY2.up);
	const where1 = await gapWhere();
	const pmX = await pageMark();
	await realText('X');
	await browser.pause(400);
	const b1 = await blocks();
	judge(12, '12-8: ↑ from the first table cell reaches the gap before a leading table; typing makes a paragraph there', n1 > 0 && b1[0] === 'paragraph:X' && (b1[1] ?? '').startsWith('table'), { click: c1, ups: n1, gap: where1, page: await pageSince(pmX), blocks: b1 });
	await fresh('gap.md', 'Middle paragraph.');
	const c2 = await clickMd('Middle paragraph.', 0);
	const n2 = await arrowToGap(KEY2.up);
	await realText('Y');
	await browser.pause(400);
	const b2 = await blocks();
	const y = b2.indexOf('paragraph:Y');
	judge(12, '12-8: ↑ from the paragraph after two raw HTML blocks reaches the gap between them; typing makes a paragraph between the blocks', n2 > 0 && y > 0 && /html/.test(b2[y - 1] ?? '') && /html/.test(b2[y + 1] ?? ''), { click: c2, ups: n2, blocks: b2 });
	await fresh('gap.md', 'Middle paragraph.');
	const c3 = await clickMd(';', 'end', { root: `${PM} pre` });
	const inFence = await browser.execute((s) => !!document.activeElement?.closest(`${s} pre`), PM);
	// ↓ until the caret has left the fence (CodeMirror first goes to the end of its last line).
	let downs = 0;
	for (; downs < 3; ) {
		await realKey(KEY.down);
		downs++;
		await browser.pause(300);
		const out = await browser.execute((s) => !document.activeElement?.closest(`${s} pre`), PM);
		if (out || (await gap())) break;
	}
	const g3 = await gap();
	await realText('Z');
	await browser.pause(400);
	const b3 = await blocks();
	judge(12, '12-8: ↓ out of the trailing fence and typing makes a paragraph after it', b3[b3.length - 1] === 'paragraph:Z' && (b3[b3.length - 2] ?? '').startsWith('code_block'), { click: c3, focus_in_fence: inFence, downs, gap_after_down: g3, blocks: b3, fence_text: (await mdDoc())?.blocks.find((b) => b.type === 'code_block')?.text ?? null });
	await fresh('gap-fm.md', 'After.');
	const c4 = await clickMd('a', 'end', { root: `${PM} table` });
	const n4 = await arrowToGap(KEY2.up);
	const look4 = async () => ({ blocks: await blocks(), gap: await gap(), selected_node: await browser.execute((s) => document.querySelector(`${s} .ProseMirror-selectednode`)?.className ?? null, PM), gap_place: await gapWhere() });
	const at1 = await look4();
	await realKey(KEY2.up);
	await browser.pause(300);
	const at2 = await look4();
	const pmW = await pageMark();
	await realText('W');
	await browser.pause(400);
	const b4 = await blocks();
	judge(12, '12-8: ↑ from the table under front matter (and ↑ once more) and typing: the paragraph lands after the front matter, never before it', (b4[0] ?? '').startsWith('front_matter') && b4.includes('paragraph:W'), { click: c4, ups: n4, after_first_up: at1, after_second_up: at2, page: await pageSince(pmW), blocks: b4 });
	// reviewer-o P3-5: in a first-row cell that wraps, ↑ on its second (last) line goes to the line above inside the
	// cell — not out of the table (2147dc0: ↑ / ↓ on the edge row of a table leave the table).
	await fresh('table-wrap.md', 'After the wrapped table.');
	const lines = await browser.execute((s) => {
		const th = document.querySelector(`${s} table tr:first-child > *`);
		if (!th) return 0;
		const r = document.createRange();
		r.selectNodeContents(th);
		return new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.y))).size;
	}, PM);
	const cw = await clickMd('LASTWORD', 'end', { root: `${PM} table` });
	const selW0 = await mdSel();
	await realKey(KEY2.up);
	await browser.pause(300);
	const selW1 = await mdSel();
	const gapW = await gap();
	const cellW = await browser.execute(() => {
		const n = document.getSelection()?.anchorNode ?? null;
		const el = n instanceof Element ? n : (n?.parentElement ?? null);
		const c = el?.closest('td, th');
		return c ? `${c.tagName.toLowerCase()}:${(c.textContent ?? '').slice(0, 20)}` : null;
	});
	await realText('Q');
	await browser.pause(400);
	const bw = await blocks();
	const headerText = await browser.execute((s) => document.querySelector(`${s} table tr:first-child > *`)?.textContent ?? '', PM);
	if (lines < 2) {
		fact(12, '12-8 (P3-5): the first header cell of table-wrap.md did not wrap in this window; ↑ inside a wrapped cell is not judged', { lines });
	} else {
		judge(12, '12-8 (P3-5): in a wrapped first-row cell, ↑ on its last line moves up a line inside the same cell (no gap cursor, not out of the table); a letter typed there goes into that cell', cw && !gapW && cellW?.startsWith('th:A header') === true && !!selW0.rect && !!selW1.rect && selW1.rect.y < selW0.rect.y - 4 && (bw[0] ?? '').startsWith('table') && headerText.includes('Q') && headerText.includes('LASTWORD'), { click: cw, wrapped_lines: lines, caret_before: selW0.rect, caret_after: selW1.rect, gap: gapW, cell: cellW, blocks: bw });
	}
	// The same gap with the Japanese IME (reviewer-o): "nihon", Space to convert, Return to confirm → a paragraph before
	// the table holds the Japanese; the first cell keeps "a" alone. The user's input source is put back by the driver.
	await fresh('gap.md', 'Middle paragraph.');
	const cj = await clickMd('a', 'end', { root: `${PM} table` });
	const nj = await arrowToGap(KEY2.up);
	const whereJ = await gapWhere();
	const pmJ = await pageMark();
	// Hiragana confirmed with Return (no Space). With a synthetic Space (r5b・r6d・r7a) the Space itself reached both the page
	// and the IME — its keydown was seen, and the IME turned the trailing "n" into "ん" (compositionupdate "にほん" 3 ms
	// before that keydown) — but what should come after it never did: no compositionupdate with the converted text, and no
	// compositionend for the Return after it (the two Escapes after that did cancel the conversion). Why is not known yet;
	// the diagnosis D1〜D4 (stage `diag`) finds out, and converting with Space is judged once a way that reaches the page is
	// found (docs/requirements/req-74.md 状態 2026-11-20).
	const ime = await operator('ime-type', { romaji: 'nihon', convert: false, confirm: true }, 240_000);
	if (ime && ime.idle_short === true) environment(12, `the user was at the keyboard (idle ${String(ime.idle_s)} s) when the Japanese typing was due; not typed`, { answer: ime });
	if (ime && ime.front === false) environment(12, 'the driver could not bring the window to the front for the Japanese typing; not typed', { answer: ime });
	await browser.pause(800);
	const bj = await blocks();
	const firstCell = await browser.execute((s) => document.querySelector(`${s} table tr:first-child > *`)?.textContent ?? null, PM);
	const cjk = /[\u3040-\u30ff\u3400-\u9fff]/;
	// The composition must be over before anything else is driven (run r5a: a composition left open took every later
	// key and click). No compositionend → real Escape on the HID route to end it.
	const seenJ = await pageSince(pmJ);
	const ended = (seenJ.inputs ?? []).some((x) => x.type === 'compositionend');
	if (!ended) {
		await realKey(KEY.escape, [], 500, 'hid');
		await realKey(KEY.escape, [], 500, 'hid');
	}
	judge(12, '12-8 (IME): at the gap before a leading table, Japanese typed and confirmed ("nihon" → Return = にほん) makes a paragraph before the table, the composition ends there; the first cell keeps "a" alone', nj > 0 && (bj[0] ?? '').startsWith('paragraph:') && cjk.test(bj[0] ?? '') && (bj[1] ?? '').startsWith('table') && firstCell === 'a' && ended, { click: cj, ups: nj, gap: whereJ, ime: { typed: ime?.typed, during: (ime?.during as { id?: string } | undefined)?.id ?? null, restored: (ime?.restored as { now?: { id?: string } } | undefined)?.now?.id ?? null, before: (ime?.before as { id?: string } | undefined)?.id ?? null }, composition_ended: ended, page: seenJ, first_cell: firstCell, blocks: bj });
	// Cancelling a conversion at the gap: "nihon" typed through the IME, then Escape (twice: the first may only close the
	// candidates) — does an empty paragraph stay before the table? Recorded (a fact), not judged.
	await fresh('gap.md', 'Middle paragraph.');
	await clickMd('a', 'end', { root: `${PM} table` });
	const nc = await arrowToGap(KEY2.up);
	const pmC = await pageMark();
	const imeC = await operator('ime-type', { romaji: 'nihon', convert: false, confirm: false }, 240_000);
	await browser.pause(400);
	const blocksComposing = await blocks();
	await realKey(KEY.escape, [], 500, 'hid');
	const afterEsc1 = await blocks();
	await realKey(KEY.escape, [], 500, 'hid');
	const seenC = await pageSince(pmC);
	const bc = await blocks();
	// The face may clean up the empty paragraph a moment after the composition ends (def81de): read again 1.5 s later.
	await browser.pause(1_500);
	const bcLater = await blocks();
	// reviewer-o: after the cancel, one Command + Z — does the empty paragraph go (does the undo reach the face)?
	const dirtyC = await exists(BADGE);
	const firstCellC = await browser.execute((s) => document.querySelector(`${s} table tr:first-child > *`)?.textContent ?? null, PM);
	const pmZ = await pageMark();
	await realKey(KEY.z, ['cmd']);
	await browser.pause(500);
	const bz = await blocks();
	fact(12, `12-8 (IME, cancelled, then Command + Z): ${bz[0]?.startsWith('table') ? 'the empty paragraph goes (the table is first again)' : `the first block stays ${bz[0]}`}`, { blocks_before_undo: bc, blocks_after_undo: bz, dirty_after_undo: await exists(BADGE), page: await pageSince(pmZ) });
	fact(12, `12-8 (IME, cancelled): Escape after "nihon" at the gap before the table — ${bcLater[0] === 'paragraph:' ? 'an empty paragraph stays before the table' : bcLater[0]?.startsWith('table') ? 'no paragraph stays (the table is first again)' : `the first block is ${bcLater[0]}`}`, { ups: nc, typed: imeC?.typed ?? null, composition_ended: (seenC.inputs ?? []).some((x) => x.type === 'compositionend'), blocks_while_composing: blocksComposing, blocks_after_first_escape: afterEsc1, blocks_after: bc, blocks_1500ms_later: bcLater, first_cell: firstCellC, dirty: dirtyC, page: seenC });
	await ensureClean('after gap-fm.md');
	human(12, '12-8: how the gap cursor looks and where it lands with the mouse = 【人】', {});
}

/**
 * 12-8 diagnosis (オーケストレーター 2026-11-18): the IME cancel at the gap before a leading table, with the face's own
 * record. The EditorView is reached through a NodeView that keeps it (the code fence's view desc `.spec.view`);
 * `EditorState.prototype.applyTransaction` is wrapped so every transaction — the dispatched one and the appended ones —
 * is logged with performance.now(), docChanged, its steps, its meta keys, the selection before / after and the first
 * block, then the composition-paragraph plugin's state after it; the DOM events on the same clock. From before the
 * typing to 2 s after the second Escape. Written to <SHOTS_DIR>/req74-diag-ime-cancel.json and kept in a fact row.
 */
async function gateGapImeDiag(): Promise<void> {
	await openMd('gap.md', 'Middle paragraph.');
	if (!needsReal(12, 'the IME cancel diagnosis')) return;
	const installed = await browser.execute((pm) => {
		type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
		let view: Any = null;
		for (const el of Array.from(document.querySelectorAll(`${pm} *`))) {
			const v = (el as Any).pmViewDesc?.spec?.view;
			if (v && v.state && typeof v.dispatch === 'function') {
				view = v;
				break;
			}
		}
		if (!view) return { ok: false, why: 'no NodeView with a view' };
		const w = window as Any;
		const log: Any[] = [];
		w.__req74Diag = log;
		const now = () => Math.round(performance.now() * 10) / 10;
		const first = (doc: Any) => {
			const c = doc.firstChild;
			return c ? { type: c.type.name, text: c.textContent } : null;
		};
		const selOf = (sel: Any) => ({ type: sel.toJSON().type, from: sel.from, to: sel.to });
		const pluginState = (st: Any) => {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(st)) if (k.startsWith('vellis-gap-composition-paragraph')) out[k] = st[k];
			return out;
		};
		const metaOf = (tr: Any) => {
			const m = tr.meta ?? {};
			const o: Record<string, unknown> = {};
			for (const k of Object.keys(m)) {
				try {
					o[k] = JSON.parse(JSON.stringify(m[k] ?? null));
				} catch {
					o[k] = String(m[k]);
				}
			}
			return o;
		};
		const proto = Object.getPrototypeOf(view.state);
		if (!proto.__req74Wrapped) {
			const orig = proto.applyTransaction;
			proto.applyTransaction = function (this: Any, rootTr: Any) {
				const res = orig.call(this, rootTr);
				let prev = selOf(this.selection);
				for (const tr of res.transactions) {
					log.push({
						t: now(),
						kind: tr === rootTr ? 'tr' : 'appended',
						docChanged: tr.docChanged,
						steps: tr.steps.map((st: Any) => {
							const j = st.toJSON();
							return { type: j.stepType, from: j.from, to: j.to, slice: j.slice ? JSON.stringify(j.slice).slice(0, 80) : null };
						}),
						meta: metaOf(tr),
						sel_before: prev,
						sel_after: selOf(tr.selection),
						first: first(tr.doc),
					});
					prev = selOf(tr.selection);
				}
				log.push({ t: now(), kind: 'state', plugin: pluginState(res.state), first: first(res.state.doc), sel: selOf(res.state.selection) });
				return res;
			};
			proto.__req74Wrapped = true;
		}
		for (const type of ['keydown', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
			window.addEventListener(type, (e: Any) => log.push({ t: now(), kind: 'dom', type, key: e.key ?? null, keyCode: e.keyCode ?? null, inputType: e.inputType ?? null, data: e.data ?? null }), true);
		}
		log.push({ t: now(), kind: 'start', plugin: pluginState(view.state), first: first(view.state.doc), sel: selOf(view.state.selection) });
		return { ok: true };
	}, PM);
	if (!installed.ok) {
		fact(12, '12-8 diag: the EditorView could not be reached; no record', { installed });
		return;
	}
	const c = await clickMd('a', 'end', { root: `${PM} table` });
	let ups = 0;
	for (let i = 1; i <= 3; i++) {
		await realKey(KEY2.up);
		if (await exists(`${PM} .ProseMirror-gapcursor`)) {
			ups = i;
			break;
		}
	}
	await browser.execute(() => (window as unknown as { __req74Diag: unknown[] }).__req74Diag.push({ t: Math.round(performance.now() * 10) / 10, kind: 'mark', what: 'before the typing' }));
	const ime = await operator('ime-type', { romaji: 'nihon', convert: false, confirm: false }, 240_000);
	await realKey(KEY.escape, [], 500, 'hid');
	await browser.execute(() => (window as unknown as { __req74Diag: unknown[] }).__req74Diag.push({ t: Math.round(performance.now() * 10) / 10, kind: 'mark', what: 'after the first Escape (+0.5 s)' }));
	await realKey(KEY.escape, [], 0, 'hid');
	await browser.execute(() => (window as unknown as { __req74Diag: unknown[] }).__req74Diag.push({ t: Math.round(performance.now() * 10) / 10, kind: 'mark', what: 'right after the second Escape was sent' }));
	await browser.pause(2_000);
	const log = await browser.execute(() => {
		const w = window as unknown as { __req74Diag: unknown[] };
		w.__req74Diag.push({ t: Math.round(performance.now() * 10) / 10, kind: 'mark', what: '2 s after the second Escape' });
		return JSON.parse(JSON.stringify(w.__req74Diag)) as unknown[];
	});
	const file = path.join(SHOTS_DIR, 'req74-diag-ime-cancel.json');
	fs.writeFileSync(file, JSON.stringify(log, null, 1));
	const blocks2 = async () => ((await mdDoc())?.blocks ?? []).map((b) => `${b.type}:${b.text.slice(0, 12)}`);
	const b05 = await blocks2();
	fact(12, `12-8 diag: the IME cancel at the gap before the table (nihon → Escape → Escape) — 2 s after: ${b05[0]?.startsWith('table') ? 'no paragraph stays (the table is first)' : `the first block is ${b05[0]}`}`, { click: c, ups, ime: { typed: ime?.typed ?? null }, blocks_after: b05.slice(0, 3), dirty: await exists(BADGE), file, log });
	await ensureClean('after the IME diagnosis');
	// The Japanese input source on but no conversion: Enter / ↓ / Backspace at the gap before the table as HID keys (the IME
	// sees them first) — the keydown's keyCode and what the face did (Enter: a paragraph; ↓: into the table; Backspace: the
	// default). Each from a fresh gap.md.
	const keyCases: Array<{ name: string; code: number }> = [{ name: 'Enter', code: 36 }, { name: '↓', code: 125 }, { name: 'Backspace', code: KEY2.backspace }];
	for (const kc of keyCases) {
		await ensureClean(`12-8 diag: before ${kc.name}`);
		await openMd('gap.md', 'Middle paragraph.');
		await clickMd('a', 'end', { root: `${PM} table` });
		let atGap = false;
		for (let i = 0; i < 3 && !atGap; i++) {
			await realKey(KEY2.up);
			atGap = await exists(`${PM} .ProseMirror-gapcursor`);
		}
		const pmK = await pageMark();
		const a = await operator('ime-type', { romaji: '', convert: false, confirm: false, keys: [kc.code] }, 240_000);
		await browser.pause(600);
		const seen = await pageSince(pmK);
		const caretCell = await browser.execute(() => {
			const n = document.getSelection()?.anchorNode ?? null;
			const el = n instanceof Element ? n : (n?.parentElement ?? null);
			return el?.closest('td, th')?.textContent ?? null;
		});
		fact(12, `12-8 (Japanese input source on, no conversion): ${kc.name} at the gap before the table`, {
			at_gap: atGap,
			source_during: (a?.during as { id?: string } | undefined)?.id ?? null,
			keydowns: seen.keys.map((k) => ({ key: k.key, keyCode: k.keyCode ?? null, isComposing: k.isComposing ?? null })),
			inputs: (seen.inputs ?? []).map((x) => ({ type: x.type, data: x.data ?? null })),
			blocks: (await blocks2()).slice(0, 3),
			gap_after: await exists(`${PM} .ProseMirror-gapcursor`),
			caret_cell: caretCell,
			dirty: await exists(BADGE),
		});
	}
	await ensureClean('after the key cases');
}

/** 12-9: dragging a selected word inside the face moves it (the drop cursor); drops from other apps = 【人】. */
async function gateDrag(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	if (!needsReal(12, 'a real drag inside the face')) return;
	// The target is a few lines below, so both points are on screen together (run 1 measured them one scroll apart).
	await mdPoint('only here.', 'end');
	const from = await mdPoint('quick', 'mid');
	if (!from?.inside) {
		fact(12, '12-9: "quick" is not in view; the drag is not driven', { from });
		return;
	}
	await realClick(from.x, from.y, [], 'dblclick');
	const sel = (await mdSel()).text;
	// Past the double-click interval, so the press that starts the drag is not a third click (word-wise extension).
	await browser.pause(1_500);
	const from2 = await mdPoint('quick', 'mid');
	const to = await mdPoint('only here.', 'end');
	if (!from2?.inside || !to?.inside) {
		fact(12, '12-9: the drag points are not both in view; the drag is not driven', { from: from2, to });
		return;
	}
	refreshFrame(screen!.pid);
	const a = toScreen(from2.x, from2.y);
	const b = toScreen(to.x, to.y);
	// Slow: a press held 0.5 s, 30 moves 30 ms apart (run 10: a 0.25 s drag moved nothing).
	const d = await operator('drag', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, route: 'hid', hold_ms: 500, steps: 30, step_ms: 30 }, 240_000);
	await browser.pause(700);
	const text = await mdText();
	const second = text.split('\n').find((l) => l.startsWith('Second paragraph')) ?? '';
	// A synthetic HID drag does not start WebKit's text drag (run 10: 0.25 s・run 11: held 0.5 s, 30 moves — nothing
	// moved, the selection stayed): recorded, and the drag inside the face goes to a person (B.6).
	const moved = sel === 'quick' && !text.includes('The quick brown') && /here\.\s?quick|quick\s?here\./.test(second);
	fact(12, `12-9: a synthetic drag of the selected word "quick" ${moved ? 'moved it' : 'did not move it (the machine cannot start a WebKit text drag; by hand = B.6)'}`, { moved, selected: sel, drag: d, second, first: text.split('\n').find((l) => l.startsWith('The ')) });
	human(12, '12-9: drag a selected word inside the face to another paragraph (the drop cursor, the word moves) = 【人】', {});
	await ensureClean('after the drag');
	human(12, '12-9: one real drop from Safari and one from Finder by hand, once (由谷の決定 2026-11-20 (4)); the types they carry are dropped from the tool\'s own window in "B.6 (12-9)" = 【人】 (docs/req74-stage24-device.md B.6)', {});
}

// --- stage 4 ------------------------------------------------------------------------------------

/** 16-2: the unsaved diff from the Unsaved badge, on the Markdown face and the code face. */
async function gateUnsavedDiff(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	if (!needsReal(16, 'typing for the unsaved diff')) return;
	await clickMd('end of the report.', 'end');
	await realText(' DIFFMARK');
	await waitMd('DIFFMARK');
	await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), BADGE);
	await waitFor(DIFF, 'the unsaved diff', 5_000).catch(() => undefined);
	judge(16, '16-2: pressing the Unsaved badge shows "Unsaved Changes" with the edited line (DIFFMARK) as it will be saved', (await textOf(DIFF_TITLE)).includes('Unsaved Changes') && (await textOf(DIFF)).includes('DIFFMARK') && !(await exists(DIFF_KEEP)), { title: await textOf(DIFF_TITLE) });
	human(16, '16-2: the unsaved diff — readable, the right size, the colours = 【人】', { file: await shotNamed('req74-unsaved-diff') });
	await realKey(KEY.escape);
	await browser.pause(400);
	judge(16, '16-2: Esc closes the diff; the edit stays (still dirty)', !(await exists(DIFF)) && (await mdText()).includes('DIFFMARK') && (await exists(BADGE)), {});
	await ensureClean('after the unsaved diff (Markdown)');
	await openDoc('app.ts');
	const pmCode = await pageMark();
	// Before character 1, not 0: the caret point of column 0 is the gutter's edge (run 15: the click hit .cm-gutters).
	const cc = await clickAt(0, 1);
	if (!cc.click?.recorded) environment(16, 'the click at the start of app.ts was not seen by the page (16-2 on the code face)', { click: cc });
	await realText('// DIFF ');
	await waitFaceLine(0, '// DIFF', 5_000).catch(() => undefined);
	await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), BADGE);
	await waitFor(DIFF, 'the unsaved diff (code)', 5_000).catch(() => undefined);
	judge(16, '16-2: the same diff on the code face (the badge is a button there too)', (await textOf(DIFF_TITLE)).includes('Unsaved Changes') && (await textOf(DIFF)).includes('// DIFF'), { title: await textOf(DIFF_TITLE), diff_head: (await textOf(DIFF)).slice(0, 200), badge: await exists(BADGE), line1: (await faceLines())[0], click: cc.point, page: await pageSince(pmCode), active: await browser.execute(() => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()}.${typeof a.className === 'string' ? a.className : ''}` : null; }) });
	await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), DIFF_CLOSE);
	await ensureClean('after the unsaved diff (code)');
}

/** 16-3: the formatting toolbar — View ▸ Show Formatting Toolbar, the "A", the pressed state, the selection kept, the select. */
async function gateFormatToolbar(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	judge(16, '16-3: the formatting toolbar is hidden by default (4-5)', !(await exists(FORMAT_TOOLBAR)) && (await exists(FORMAT_TOGGLE)), {});
	const shown = await operator('press-menu', { menu: 'View', item: 'Show Formatting Toolbar' });
	await waitFor(FORMAT_TOOLBAR, 'the formatting toolbar', 5_000).catch(() => undefined);
	judge(16, '16-3: View ▸ Show Formatting Toolbar (AX) shows it; the "A" is pressed', (await exists(FORMAT_TOOLBAR)) && (await attrOf(FORMAT_TOGGLE, 'aria-pressed')) === 'true', { press: shown });
	await openDoc('app.ts');
	judge(16, '16-3: on the code face there is neither the toolbar nor the "A"', !(await exists(FORMAT_TOOLBAR)) && !(await exists(FORMAT_TOGGLE)), {});
	await openMd('ai-report.md', 'Weekly report');
	judge(16, '16-3: back on Markdown the toolbar is shown again (one state for the app)', await exists(FORMAT_TOOLBAR), {});
	if (!needsReal(16, 'the toolbar by real clicks')) return;
	const toggle = await rectOf(FORMAT_TOGGLE);
	if (toggle) {
		await realClick(Math.round(toggle.x + toggle.width / 2), Math.round(toggle.y + toggle.height / 2));
		await browser.pause(400);
		const hidden = !(await exists(FORMAT_TOOLBAR));
		const t2 = await rectOf(FORMAT_TOGGLE);
		if (t2) await realClick(Math.round(t2.x + t2.width / 2), Math.round(t2.y + t2.height / 2));
		await browser.pause(400);
		judge(16, '16-3: a real click on the "A" hides the toolbar and another shows it', hidden && (await exists(FORMAT_TOOLBAR)), {});
	}
	await clickMd('green', 2);
	const pressedBold = await attrOf(`${FORMAT_TOOLBAR} [data-format-id="format-bold"]`, 'aria-pressed');
	await clickMd('Summary', 2);
	const blockValue = await browser.execute((s) => document.querySelector<HTMLSelectElement>(s)?.value ?? null, BLOCK_SELECT);
	judge(16, '16-3: the pressed state follows the caret: Bold pressed inside "green"; the paragraph style reads Heading 2 inside "Summary"', pressedBold === 'true' && blockValue === 'format-heading-2', { bold: pressedBold, block: blockValue });
	// The selection survives a real click on a toolbar button.
	await clickMd('quick', 'mid', { kind: 'dblclick' });
	const b = await rectOf(`${FORMAT_TOOLBAR} [data-format-id="format-bold"]`);
	if (b) {
		await realClick(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
		await browser.pause(400);
		const s = await mdSel();
		judge(16, '16-3: a real click on Bold applies it to the selected word and the selection stays ("quick" still selected in the face)', (await marked('strong', 'quick')) && s.text === 'quick' && s.inFace, { sel: s });
		await realKey(KEY.z, ['cmd']);
	}
	// The paragraph-style select: does a real click open its list (mousedown is prevented to keep the face's selection)?
	await clickMd('Third paragraph', 3);
	const sr = await rectOf(BLOCK_SELECT);
	if (sr) {
		const pop = await realPopup(Math.round(sr.x + sr.width / 2), Math.round(sr.y + sr.height / 2), { button: 'left', read: [], press: ['Heading 2'], shot: 'req74-toolbar-select' });
		await browser.pause(500);
		const h2 = await marked('h2', 'Third paragraph');
		judge(16, '16-3: a real click on the paragraph-style select opens its list on WebKit (a native list = a layer-101 window) and choosing Heading 2 turns the paragraph into a heading', pop.found && h2, { found: pop.found, items: titles(pop.items), press: pop.press, h2 });
		if (!pop.found) fact(16, '16-3: the select did not open — the suspected effect of preventDefault on its mousedown (docs/req74-stage24-device.md A)', { answer: pop.answer });
		if (h2) await realKey(KEY.z, ['cmd']);
	}
	await ensureClean('after the toolbar');
	human(16, '16-3: the look of the toolbar — this shot (100 %, Light) and the shots of "16-3 (P)" (150 %, Toggle Full Width, Dark) = 【人】 (looking only; with the IME converting = "gate 1・16-3・16-4 (B.1-2・3)")', { file: await shotNamed('req74-format-toolbar') });
	await operator('press-menu', { menu: 'View', item: 'Show Formatting Toolbar' });
	await browser.pause(400);
	fact(16, '16-3: the toolbar hidden again at the end (the default)', { shown: await exists(FORMAT_TOOLBAR) });
}

/** 16-4: the selection bar — appears above a mouse / keyboard selection, goes on a collapse / Esc, follows at 150 %. */
async function gateSelectionBar(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	if (!needsReal(16, 'the selection bar by real selections')) return;
	const above = async () => {
		const bar = await rectOf(SELECTION_BAR);
		const s = await mdSel();
		return { bar, sel: s.rect, ok: !!bar && !!s.rect && (bar.y + bar.height <= s.rect.y + 2 || bar.y >= s.rect.y + s.rect.height - 2) && Math.abs(bar.x + bar.width / 2 - (s.rect.x + s.rect.width / 2)) < 400 };
	};
	await clickMd('quick', 'mid', { kind: 'dblclick' });
	await browser.pause(500);
	const m = await above();
	judge(16, '16-4: a real double-click (a mouse selection) brings the selection bar right above (or, without room, below) the selection', (await exists(SELECTION_BAR)) && m.ok, m);
	await realKey(KEY.right);
	await browser.pause(400);
	judge(16, '16-4: a real → collapses the selection and the bar goes', !(await exists(SELECTION_BAR)), {});
	for (let i = 0; i < 5; i++) await realKey(KEY.right, ['shift'], 120);
	await browser.pause(700);
	judge(16, '16-4: a keyboard selection (Shift + → × 5) brings the bar after it settles', await exists(SELECTION_BAR), { sel: (await mdSel()).text });
	await realKey(KEY.escape);
	await browser.pause(400);
	judge(16, '16-4: Esc hides the bar', !(await exists(SELECTION_BAR)), {});
	await emitMenu('menu_zoom_reset');
	for (let i = 0; i < 5; i++) {
		await emitMenu('menu_zoom_in');
		await browser.pause(150);
	}
	await browser.pause(500);
	await clickMd('quick', 'mid', { kind: 'dblclick' });
	await browser.pause(500);
	const z = await above();
	judge(16, '16-4: at 150 % the bar is still right at the selection', (await exists(SELECTION_BAR)) && z.ok, z);
	human(16, '16-4: the bar at 150 % = 【人】', { file: await shotNamed('req74-selection-bar-150') });
	await emitMenu('menu_zoom_reset');
	await browser.pause(400);
	await realKey(KEY.right);
	human(16, '16-4: the bar while scrolling, does it get in the way = 【人】 (not during a conversion = "gate 1・16-3・16-4 (B.1-2・3)")', {});
}

/** 16-5: rewriting one list item — bold, an added item, a removed item: the file differs in those lines only. */
async function gateListItems(): Promise<void> {
	await openMd('list.md', 'item 100');
	if (!needsReal(16, 'list edits by real input')) return;
	const original = readBytes('list.md');
	const lines = original.split('\n');
	const idx = (n: number) => lines.findIndex((l) => l.startsWith(`- item ${String(n).padStart(3, '0')}`));
	// The caret before the "t" of "beta" in item 50: a double-click there selects "beta".
	const p = await mdPoint('item 050 alpha beta gamma', 17);
	if (p?.inside) {
		await realClick(p.x, p.y, [], 'dblclick');
		await operator('press-menu', { menu: 'Format', item: 'Bold' });
		await browser.pause(400);
		await realSave();
		const d = changedLines(original, readBytes('list.md'));
		judge(16, '16-5: bold on "beta" of item 50 and save: the only changed line is item 50 (the items with `_x_` / `~x~` / `*x*` / a 4-space continuation untouched)', !!d && d.from === idx(50) && d.toA === idx(50) + 1 && d.toB === idx(50) + 1, { diff: d });
		await restoreMd('list.md', original, 'item 050 alpha beta gamma');
	}
	if (await clickMd('item 050 alpha beta gamma', 'end')) {
		await realKey(KEY.return);
		await realText('new item');
		await realSave();
		const d = changedLines(original, readBytes('list.md'));
		judge(16, '16-5: Return at the end of item 50 and `new item`: the file gains exactly one line `- new item` after item 50', !!d && d.from === idx(50) + 1 && d.toA === idx(50) + 1 && d.b.length === 1 && d.b[0] === '- new item', { diff: d });
		await restoreMd('list.md', original, 'item 050 alpha beta gamma');
	}
	if ((await clickMd('item 050 alpha beta gamma', 'end')) && (await clickMd('item 051 alpha beta gamma', 'end', { mods: ['shift'] }))) {
		await realKey(KEY2.backspace);
		await realSave();
		const d = changedLines(original, readBytes('list.md'));
		judge(16, '16-5: selecting from the end of item 50 to the end of item 51 and Backspace: the file loses exactly the line of item 51', !!d && d.from === idx(51) && d.toA === idx(51) + 1 && d.b.length === 0, { diff: d });
		await restoreMd('list.md', original, 'item 051 alpha beta gamma');
	}
	human(16, '16-5: the same on your own long lists (an AI report, progress.md) with git diff = 【人】', {});
}

/** The link editor (4-5・4-10): Command + K / Format ▸ Link… on a word, Done, Command + K inside the link, Remove Link. */
async function gateLinkEditor(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	if (!needsReal('link', 'the link editor by real keys')) return;
	await clickMd('quick', 'mid', { kind: 'dblclick' });
	await realKey(KEY2.k, ['cmd']);
	await waitFor(LINK_EDITOR, 'the link editor', 5_000).catch(() => undefined);
	const textValue = await browser.execute((s) => document.querySelector<HTMLInputElement>(s)?.value ?? null, LINK_TEXT);
	judge('link', 'a real Command + K on a selected word opens the link editor with Text = the word and an empty Link; Remove Link is disabled', (await exists(LINK_EDITOR)) && textValue === 'quick' && (await attrOf(LINK_REMOVE, 'disabled')) !== null, { text: textValue });
	await browser.execute((s, v) => {
		const el = document.querySelector<HTMLInputElement>(s)!;
		el.value = v;
		el.dispatchEvent(new Event('input', { bubbles: true }));
	}, LINK_URL, 'other.md');
	await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), LINK_DONE);
	await browser.pause(500);
	const linked = await browser.execute((s) => Array.from(document.querySelectorAll<HTMLAnchorElement>(`${s} a`)).some((a) => a.getAttribute('href') === 'other.md' && a.textContent === 'quick'), PM);
	judge('link', 'Done links the word (an <a href="other.md"> around "quick") in one step', linked && !(await exists(LINK_EDITOR)), {});
	// The word stays selected after Done: ← collapses to its start, → → puts the caret inside ("qu|ick").
	await realKey(KEY.left);
	await realKey(KEY.right);
	await realKey(KEY.right);
	await realKey(KEY2.k, ['cmd']);
	await waitFor(LINK_EDITOR, 'the link editor on the link', 5_000).catch(() => undefined);
	const urlValue = await browser.execute((s) => document.querySelector<HTMLInputElement>(s)?.value ?? null, LINK_URL);
	judge('link', 'Command + K with the caret inside the link opens it with Link = other.md and Remove Link enabled', urlValue === 'other.md' && (await attrOf(LINK_REMOVE, 'disabled')) === null, { url: urlValue });
	await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), LINK_REMOVE);
	await browser.pause(500);
	judge('link', 'Remove Link takes the link off (no <a href="other.md">); the word stays', !(await exists(`${PM} a[href="other.md"]`)) && (await mdText()).includes('The quick brown'), {});
	await clickMd('brown', 'mid', { kind: 'dblclick' });
	const menu = await operator('press-menu', { menu: 'Format', item: 'Link…' });
	await waitFor(LINK_EDITOR, 'the link editor from the menu', 5_000).catch(() => undefined);
	const fromMenu = await exists(LINK_EDITOR);
	const before = await mdText();
	await realKey(KEY.escape);
	await browser.pause(400);
	judge('link', 'Format ▸ Link… (AX) opens the same editor; Esc closes it and changes nothing', fromMenu && !(await exists(LINK_EDITOR)) && (await mdText()) === before, { press: menu });
	human('link', 'the link editor: where it opens, Tab between the fields, the look = 【人】', { file: await shotNamed('req74-link-editor') });
	await ensureClean('after the link editor');
}

// =============================================================================================
// 2026-11-20 — rows a person had (docs/req74-stage24-device.md B) that a machine can drive (由谷の決定 (1)): B.1 後半 (a
// conversion left open: Format ▸ Bold by AX, Command + B, the toolbar's Bold by a real click, a write from outside, no
// selection bar), 12-2 with the IME on, B.5 (input source × keyboard type × the shortcuts), B.6 (a drag inside the face,
// drops from the tool's own window, the page's drop), the leftover marks (a frame around the face: the computed styles
// and the shot's edges = 青い枠), the shots for the eye (the toolbar's four states, the gap cursor). Stage `diag` = the
// diagnosis D1〜D6 that decides whether conversion / reconversion / the candidate window can be driven; the its of those
// stay pending until then (由谷の決定 (1)).
// =============================================================================================

/** More macOS virtual keycodes for the rows of 2026-11-20. */
const KEY3 = { f7: 98, f10: 109, kana: 104, eisu: 102 } as const;
/** Option + Command + 0〜6 = Body Text, Heading 1〜6 (src-tauri/src/menu.rs FORMAT_*_ACCELERATOR). */
const DIGIT_KEYS = [29, 18, 19, 20, 21, 23, 22] as const;
const JAPANESE_SOURCE = 'com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese';
const pdfpix = process.env.VELLIS_GATE_PDFPIX ?? '';
/** The candidate window's place (オーケストレーター 2026-11-20): its top within one line + 40 pt under the caret, ±40 pt across. */
const CANDIDATE_BELOW_PT = 40;
const CANDIDATE_ACROSS_PT = 40;

type PageInput = { type: string; at: number; target: string; data?: string | null; sel?: string | null };
const compositionEnds = (inputs: PageInput[] | undefined) => (inputs ?? []).filter((x) => x.type === 'compositionend');
const compositionStarts = (inputs: PageInput[] | undefined) => (inputs ?? []).filter((x) => x.type === 'compositionstart');
const countOf = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0);
const nonAscii = (t: string) => /[^\x00-\x7f]/.test(t);

/** Japanese typed through the IME (the driver's ime-type); an environment row when it could not be sent. */
async function imeType(gate: number | string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
	requireRealInput();
	const a = await operator('ime-type', args, 240_000);
	if (a && a.idle_short === true) environment(gate, `the user was at the keyboard (idle ${String(a.idle_s)} s) when the Japanese typing was due; not typed`, { answer: a });
	if (a && a.front === false) environment(gate, 'the driver could not bring the window to the front for the Japanese typing; not typed', { answer: a });
	return a;
}
/** HID keys while a conversion is open (the driver's ime-keys: the front is read, never repaired). */
async function imeKeys(gate: number | string, items: string[], o: { kbtype?: number; settleMs?: number; windowsBase?: number[] } = {}): Promise<Record<string, unknown> | null> {
	requireRealInput();
	const a = await operator('ime-keys', { items, ...(o.kbtype ? { kbtype: o.kbtype } : {}), ...(o.windowsBase ? { windows_base: o.windowsBase } : {}) }, 240_000);
	if (a && a.idle_short === true) environment(gate, `the user was at the keyboard (idle ${String(a.idle_s)} s) when ${items.join(' ')} was due; not sent`, { answer: a });
	if (a && a.front === false) environment(gate, `the app was not in front for ${items.join(' ')} with a conversion open (the driver does not repair the front then); not sent`, { answer: a });
	await browser.pause(o.settleMs ?? 600);
	return a;
}
/** A real key with the options of 2026-11-20 (the keyboard type, the HID route by default). */
async function realKeyX(gate: number | string, keycode: number, mods: string[], o: { kbtype?: number; route?: 'pid' | 'hid'; settleMs?: number; holdMs?: number; repeat?: number; gapMs?: number } = {}): Promise<Record<string, unknown> | null> {
	requireRealInput();
	const a = await operator('key', { keycode, mods, route: o.route ?? 'hid', ...(o.kbtype ? { kbtype: o.kbtype } : {}), ...(o.holdMs ? { hold_ms: o.holdMs } : {}), ...(o.repeat ? { repeat: o.repeat } : {}), ...(o.gapMs ? { gap_ms: o.gapMs } : {}) }, 240_000);
	if (a && a.idle_short === true) environment(gate, `the user was at the keyboard (idle ${String(a.idle_s)} s) when keycode ${keycode} [${mods.join('+')}] was due; not sent`, { answer: a });
	if (a && a.sent !== true) environment(gate, `the driver could not send keycode ${keycode} [${mods.join('+')}]${o.kbtype ? ` (keyboard type ${o.kbtype})` : ''}`, { answer: a });
	await browser.pause(o.settleMs ?? 600);
	return a;
}
async function inputSource(op: 'get' | 'list' | 'set' | 'restore', id?: string): Promise<Record<string, unknown> | null> {
	return operator('inputsource', id ? { op, id } : { op });
}
/** The numbers of every on-screen window now (a baseline for the IME's new windows). */
async function windowNumbers(): Promise<number[]> {
	const a = await operator('screen-windows');
	return ((a?.numbers ?? []) as number[]).filter((n) => typeof n === 'number');
}
/** The caret's (or the composing text's end) viewport rect, as screen points. */
async function caretOnScreen(): Promise<{ x: number; y: number; w: number; h: number } | null> {
	const s = await mdSel();
	if (!s.rect || !screen) return null;
	refreshFrame(screen.pid);
	const p = toScreen(s.rect.x, s.rect.y);
	return { x: p.x, y: p.y, w: s.rect.width, h: s.rect.height };
}
type ScreenRect = { x: number; y: number; w: number; h: number };
/**
 * Is a window where a candidate window belongs (オーケストレーター 2026-11-20): its top within one line + 40 pt under the
 * composed text (or, flipped, its bottom within that above it), its left edge within the composed text's span ±40 pt.
 * `start` = the caret before the typing (where the composition begins), `end` = the caret after it (where it ends).
 */
function candidateNear(w: ScreenRect, start: ScreenRect, end: ScreenRect): boolean {
	const lineH = Math.max(end.h, start.h, 12);
	const top = Math.min(start.y, end.y);
	const bottom = Math.max(start.y + start.h, end.y + end.h);
	const below = w.y >= bottom - 4 && w.y <= bottom + lineH + CANDIDATE_BELOW_PT;
	const above = w.y + w.h <= top + 4 && w.y + w.h >= top - lineH - CANDIDATE_BELOW_PT;
	const left = Math.min(start.x, end.x);
	const right = Math.max(start.x, end.x);
	return (below || above) && w.x >= left - CANDIDATE_ACROSS_PT && w.x <= right + CANDIDATE_ACROSS_PT;
}
/** The input method's processes (their windows may hold the candidates; the 2026-11-20 diag found them in the app's own process). */
const IME_OWNER = /Input|IMK|Kotoeri|Japanese|TextInput|CursorUIViewService/i;
type WinRow = ScreenRect & { number?: number; owner_pid?: number; owner_name?: string; layer?: number };
/**
 * The windows that may be the candidate window among `rows` (new since a baseline): a window of the app itself above the
 * normal level (the 2026-11-20 diag: vellis-gate74's own layer-20 window, 119 × 140, while typing and after Space) or a
 * window of an input-method process — not the WindowServer's small overlays.
 */
function candidateWindows(rows: unknown): WinRow[] {
	const list = (Array.isArray(rows) ? rows : []) as WinRow[];
	return list.filter((w) => (w.layer ?? 0) > 0 && w.w >= 40 && w.h >= 20 && !/Window ?Server/i.test(w.owner_name ?? '') && (w.owner_pid === screen?.pid || IME_OWNER.test(w.owner_name ?? '')));
}

// --- the leftover marks (青い枠) ------------------------------------------------------------------

interface FrameFinding {
	el: string;
	what: string[];
	outline: string;
	box_shadow: string;
	borders: string;
}
interface FrameFacts {
	face: Rect;
	clip: Rect | null;
	findings: FrameFinding[];
	considered: string[];
	active: string | null;
}
/**
 * The computed styles that draw a frame around an editing face: the face, its contenteditable descendants (a code
 * fence's CodeMirror inside the Markdown face) and the ancestors up to article.viewer that hug it (left / right / top
 * within 24 px) — an outline (style not none, width > 0), a box-shadow, or a border on three sides or more.
 */
async function frameFacts(faceSel: string): Promise<FrameFacts | null> {
	return browser.execute((sel) => {
		const face = document.querySelector<HTMLElement>(sel);
		if (!face) return null;
		const fr = face.getBoundingClientRect();
		const viewer = document.querySelector('article.viewer');
		const desc = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
		const set = new Set<Element>([face]);
		face.querySelectorAll('[contenteditable="true"]').forEach((e) => set.add(e));
		for (let a = face.parentElement; a; a = a.parentElement) {
			const r = a.getBoundingClientRect();
			if (Math.abs(r.left - fr.left) <= 24 && Math.abs(r.right - fr.right) <= 24 && Math.abs(r.top - fr.top) <= 24) set.add(a);
			if (a === viewer) break;
		}
		const findings: Array<{ el: string; what: string[]; outline: string; box_shadow: string; borders: string }> = [];
		for (const el of set) {
			const cs = getComputedStyle(el);
			const what: string[] = [];
			if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) what.push('outline');
			if (cs.boxShadow && cs.boxShadow !== 'none') what.push('box-shadow');
			const sides = ['top', 'right', 'bottom', 'left'].filter((side) => {
				const w = parseFloat(cs.getPropertyValue(`border-${side}-width`));
				const style = cs.getPropertyValue(`border-${side}-style`);
				const color = cs.getPropertyValue(`border-${side}-color`);
				return w > 0 && style !== 'none' && style !== 'hidden' && !/rgba\([^)]*,\s*0\)$/.test(color) && color !== 'transparent';
			});
			if (sides.length >= 3) what.push(`border (${sides.join(' ')})`);
			if (what.length > 0) {
				findings.push({
					el: desc(el),
					what,
					outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} offset ${cs.outlineOffset}`,
					box_shadow: cs.boxShadow,
					borders: ['top', 'right', 'bottom', 'left'].map((side) => `${cs.getPropertyValue(`border-${side}-width`)} ${cs.getPropertyValue(`border-${side}-style`)}`).join(' / '),
				});
			}
		}
		const vr = viewer?.getBoundingClientRect() ?? null;
		const ae = document.activeElement;
		return {
			face: { x: fr.x, y: fr.y, width: fr.width, height: fr.height },
			clip: vr ? { x: vr.x, y: vr.y, width: Math.min(vr.width, window.innerWidth - vr.x), height: Math.min(vr.height, window.innerHeight - vr.y) } : null,
			findings,
			considered: Array.from(set).map(desc),
			active: ae ? desc(ae) : null,
		};
	}, faceSel);
}
/**
 * The pixel half: a shot of the window, and pdfpix `frame` on the face's rect (window points = the calibrated offset +
 * the client point; the clip = the viewer's scroll area). `frame: true` = every visible side of the face is lined.
 */
async function shotFrame(name: string, facts: FrameFacts | null): Promise<Record<string, unknown>> {
	if (!pdfpix) return { environment: 'VELLIS_GATE_PDFPIX is not set (build scripts/gate-device/pdfpix.swift): the pixel half is not judged' };
	if (!OPERATOR || !screen) return { environment: 'no operator / no calibration: no shot' };
	if (!facts) return { environment: 'no face to measure' };
	refreshFrame(screen.pid);
	const file = await shotNamed(name);
	if (!file) return { environment: 'the shot was not taken' };
	const f = facts.face;
	const c = facts.clip ?? { x: 0, y: 0, width: screen.frame.w, height: screen.frame.h };
	const win = (x: number, y: number) => ({ x: Math.round((screen!.dx + x) * 10) / 10, y: Math.round((screen!.dy + y) * 10) / 10 });
	const a = win(f.x, f.y);
	const ca = win(c.x, c.y);
	try {
		const out = tool(pdfpix, ['frame', file, String(screen.frame.w), String(a.x), String(a.y), String(f.width), String(f.height), `clip=${ca.x},${ca.y},${c.width},${c.height}`])[0] ?? {};
		return { file, ...out };
	} catch (e) {
		return { file, environment: `pdfpix frame failed: ${String(e)}` };
	}
}

/** Gates 2・5・11・7 (2026-11-20 青い枠): no frame around the Markdown face, the code / plain-text face and raw. */
async function gateLeftoverFrames(): Promise<void> {
	const md: Record<string, FrameFacts | null> = {};
	await openMd('ai-report.md', 'Weekly report');
	await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur?.());
	await browser.pause(200);
	md.unfocused = await frameFacts(PM);
	const pix = await shotFrame('req74-frame-ai_report', md.unfocused);
	await browser.execute((s) => document.querySelector<HTMLElement>(s)?.focus(), PM);
	await browser.pause(200);
	md.focused = await frameFacts(PM);
	if (OPERATOR && !realInputBlocked && (await clickMd('Third paragraph', 3))) md.after_a_real_click = await frameFacts(PM);
	await emitMenu('menu_zoom_reset');
	for (let i = 0; i < 5; i++) {
		await emitMenu('menu_zoom_in');
		await browser.pause(150);
	}
	await browser.pause(500);
	md.zoom_150 = await frameFacts(PM);
	await emitMenu('menu_zoom_reset');
	await browser.pause(400);
	let pixDark: Record<string, unknown> | null = null;
	if (OPERATOR) {
		const dark = await operator('submenu-press', { menu: 'View', submenu: 'Appearance', item: 'Dark' });
		await browser.pause(800);
		md.dark = await frameFacts(PM);
		pixDark = await shotFrame('req74-frame-ai_report-dark', md.dark);
		pixDark.press = dark;
		await operator('submenu-press', { menu: 'View', submenu: 'Appearance', item: 'System' });
		await browser.pause(600);
	}
	const mdFound = Object.entries(md).filter(([, f]) => (f?.findings.length ?? 0) > 0).map(([k, f]) => ({ state: k, findings: f!.findings }));
	judge(2, 'leftover marks (青い枠, 2026-11-20): the Markdown face, its ancestors that hug it and its editable parts carry no outline / box-shadow / border box — unfocused, focused, after a real click, at 150 %, in Dark', Object.values(md).every((f) => !!f) && mdFound.length === 0, { found: mdFound, states: md });
	for (const [label, p] of [['Light', pix], ['Dark', pixDark]] as const) {
		if (!p) continue;
		if (p.environment) report(REPORT, { gate: 'environment', side: VARIANT, item: `leftover marks (pixels, ${label}): not judged`, reason: String(p.environment), answer: p });
		else if (p.judgeable !== true) report(REPORT, { gate: 'environment', side: VARIANT, item: `leftover marks (pixels, ${label}): fewer than two sides of the face are in view — not judgeable`, reason: 'visible_sides < 2', answer: p });
		else judge(2, `leftover marks (pixels, ${label}): the shot shows no line just outside the Markdown face (pdfpix frame: every visible side of the face lined = a frame)`, p.frame === false, { frame: p });
	}
	human(2, 'leftover marks: the shots req74-frame-ai_report(-dark) at a glance = 【人】 (looking only)', { file: (pix.file as string | undefined) ?? null });
	// The code face and the plain-text face (CodeMirror; the 11-17 shots req74-face-app_ts / -japanese_txt show the same ring).
	for (const rel of ['app.ts', 'notes.txt']) {
		await openDoc(rel);
		await browser.execute((s) => document.querySelector<HTMLElement>(`${s} .cm-content`)?.focus(), FACE);
		await browser.pause(300);
		const f = await frameFacts(`${FACE} .cm-editor`);
		const content = await frameFacts(`${FACE} .cm-content`);
		const p = await shotFrame(`req74-frame-${rel.replace(/\W/g, '_')}`, content);
		judge(11, `leftover marks: the ${rel === 'app.ts' ? 'code' : 'plain-text'} face (${rel}) — .cm-editor, its hugging ancestors and .cm-content carry no outline / box-shadow / border box (focused)`, !!f && !!content && f.findings.length === 0 && content.findings.length === 0, { editor: f, content });
		if (p.environment) report(REPORT, { gate: 'environment', side: VARIANT, item: `leftover marks (pixels, ${rel}): not judged`, reason: String(p.environment), answer: p });
		else if (p.judgeable !== true) report(REPORT, { gate: 'environment', side: VARIANT, item: `leftover marks (pixels, ${rel}): fewer than two sides of the text area are in view — not judgeable`, reason: 'visible_sides < 2', answer: p });
		else judge(11, `leftover marks (pixels): the shot shows no line just outside the text area of ${rel}`, p.frame === false, { frame: p });
	}
	// Raw (View ▸ Raw Source by AX).
	if (OPERATOR) {
		await openMd('ai-report.md', 'Weekly report');
		await operator('press-menu', { menu: 'View', item: 'Raw Source' });
		await waitFor(RAW, 'the raw face', 8_000).catch(() => undefined);
		await browser.execute((s) => document.querySelector<HTMLElement>(`${s} .cm-content`)?.focus(), RAW);
		await browser.pause(300);
		const r = (await exists(RAW)) ? await frameFacts(`${RAW} .cm-editor`) : null;
		const rc = (await exists(RAW)) ? await frameFacts(`${RAW} .cm-content`) : null;
		if (r && rc) judge(7, 'leftover marks: the raw face — .cm-editor, its hugging ancestors and .cm-content carry no outline / box-shadow / border box (focused)', r.findings.length === 0 && rc.findings.length === 0, { editor: r, content: rc });
		else fact(7, 'leftover marks: the raw face did not open (View ▸ Raw Source by AX); not judged', {});
		await operator('press-menu', { menu: 'View', item: 'Raw Source' });
		await browser.pause(500);
		await ensureClean('after the leftover marks');
	}
}

// --- B.1 後半: a conversion left open ------------------------------------------------------------

/** Gate 1・16-3・16-4 (B.1-2・3): Format / Command + B / the toolbar / a write from outside while a conversion is open; no bar. */
async function gateImeComposing(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	if (!needsReal(1, 'the IME with a conversion left open')) return;
	const original = readBytes('ai-report.md');
	const strongs = () => browser.execute((s) => Array.from(document.querySelectorAll(`${s} strong`)).map((e) => e.textContent ?? ''), PM);
	/**
	 * One round on a fresh face: the caret in "pl|ain words only", "nihon" through the IME left composing (the input source
	 * stays Japanese, no refocus), `act`, then the Return when the conversion is still open. What the page saw is returned.
	 */
	const round = async (name: string, act: () => Promise<unknown>, o: { toolbar?: boolean } = {}) => {
		await ensureClean(`B.1 後半: before ${name}`);
		await openMd('ai-report.md', 'Weekly report');
		if (o.toolbar && !(await exists(FORMAT_TOOLBAR))) {
			await operator('press-menu', { menu: 'View', item: 'Show Formatting Toolbar' });
			await waitFor(FORMAT_TOOLBAR, 'the formatting toolbar', 5_000).catch(() => undefined);
		}
		const textBefore = await mdText();
		const blocksBefore = (await mdDoc())?.blocks.length ?? 0;
		const strongBefore = await strongs();
		if (!(await clickMd('plain words only', 2))) environment(1, `B.1 後半 (${name}): the click inside "plain" was not seen by the page`);
		const pm = await pageMark();
		const ime = await imeType(1, { romaji: 'nihon', convert: false, confirm: false, restore: false });
		await browser.pause(500);
		const typed = await pageSince(pm);
		const started = compositionStarts(typed.inputs).length > 0 && compositionEnds(typed.inputs).length === 0;
		if (!started) environment(1, `B.1 後半 (${name}): the IME did not start a conversion at "pl|ain" (no compositionstart, or it ended at once)`, { ime, page: typed });
		const actAnswer = await act();
		await browser.pause(900);
		const afterAct = await pageSince(pm);
		const endedByAct = compositionEnds(afterAct.inputs).length > 0;
		const textDuring = await mdText();
		const barDuring = await exists(SELECTION_BAR);
		const ret = endedByAct ? null : await imeKeys(1, ['k:36']);
		await browser.pause(900);
		const seen = await pageSince(pm);
		const ends = compositionEnds(seen.inputs);
		const confirmed = String(ends[ends.length - 1]?.data ?? '');
		const doc = await mdDoc();
		const text = doc?.text ?? '';
		return {
			name,
			started,
			act: actAnswer,
			ended_by_act: endedByAct,
			text_during: textDuring.split('\n').find((l) => l.includes('words only here.')) ?? null,
			bar_during: barDuring,
			return: ret ? { sent: ret.sent } : null,
			ends: ends.map((e) => e.data ?? null),
			confirmed,
			confirmed_ok: confirmed !== '' && nonAscii(confirmed),
			confirmed_once: countOf(text, confirmed) === countOf(textBefore, confirmed) + 1,
			word_in_place: (doc?.blocks ?? []).some((b) => b.text.includes(`pl${confirmed}ain words only here.`)),
			blocks: { before: blocksBefore, after: doc?.blocks.length ?? 0 },
			strong_new: (await strongs()).filter((t) => !strongBefore.includes(t)),
			text_during_full: textDuring,
			text,
			keys: seen.keys.map((k) => ({ key: k.key, keyCode: k.keyCode ?? null, isComposing: k.isComposing ?? null })),
			inputs: seen.inputs.map((x) => ({ type: x.type, data: x.data ?? null })),
		};
	};
	const boldOnce = (r: Awaited<ReturnType<typeof round>>) => r.strong_new.length === 1 && r.strong_new[0] === `pl${r.confirmed}ain`;
	const intact = (r: Awaited<ReturnType<typeof round>>, extraBlocks = 0) => r.confirmed_ok && r.confirmed_once && r.word_in_place && r.ends.length === 1 && r.blocks.after === r.blocks.before + extraBlocks;
	const slim = (r: Awaited<ReturnType<typeof round>>) => {
		const { text, text_during_full, ...rest } = r;
		void text;
		void text_during_full;
		return rest;
	};
	// (A) Format ▸ Bold by AX (the front read, not repaired).
	const a = await round('Format ▸ Bold (AX)', () => operator('press-menu', { menu: 'Format', item: 'Bold', no_repair: true }));
	judge(1, 'B.1-2: Format ▸ Bold (AX) while a conversion is open — after the confirm the word "pl<confirmed>ain" is bold exactly once, the confirmed text is in once and in place, one compositionend, no block added (契約10)', intact(a) && boldOnce(a), { round: slim(a) });
	if (a.ended_by_act) fact(1, 'B.1-2: Format ▸ Bold (AX) itself ended the conversion (the Return was not sent)', { round: slim(a) });
	// (B) Command + B through the IME (HID).
	const b = await round('Command + B', () => imeKeys(1, ['k:11+cmd'], { settleMs: 300 }));
	judge(1, 'B.1-2: Command + B while a conversion is open — after the confirm the word is bold exactly once, the confirmed text is in once and in place, one compositionend, no block added', intact(b) && boldOnce(b), { round: slim(b) });
	if (b.ended_by_act) fact(1, 'B.1-2: Command + B itself ended the conversion (the Return was not sent)', { round: slim(b) });
	// (C) the toolbar's Bold by a real click.
	const c = await round(
		'the toolbar Bold (a real click)',
		async () => {
			const r = await rectOf(`${FORMAT_TOOLBAR} [data-format-id="format-bold"]`);
			if (!r) return { error: 'no Bold button on the toolbar' };
			return realClick(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
		},
		{ toolbar: true },
	);
	judge(16, 'B.1-2 / 16-3: a real click on the toolbar\'s Bold while a conversion is open — after the confirm the word is bold exactly once, the confirmed text is in once and in place, one compositionend, no block added', intact(c) && boldOnce(c), { round: slim(c) });
	if (c.ended_by_act) fact(16, 'B.1-2 / 16-3: the click on the toolbar ended the conversion itself (the Return was not sent)', { round: slim(c) });
	if (await exists(FORMAT_TOOLBAR)) {
		await operator('press-menu', { menu: 'View', item: 'Show Formatting Toolbar' });
		await browser.pause(400);
	}
	// (D) a write from outside (an append, as `printf 'x\n\n' >> ai-report.md`).
	const d = await round('a write from outside', async () => {
		fs.appendFileSync(fileOf('ai-report.md'), '\nEXTERNALX appended from outside.\n');
		await browser.pause(1_500);
		return { appended: true };
	});
	judge(1, 'B.1-3: a write from outside while a conversion is open is held — not in the face while composing; after the confirm the appended line is in once and the confirmed text once and in place, one compositionend (契約10・12)', !d.text_during_full.includes('EXTERNALX') && countOf(d.text, 'EXTERNALX') === 1 && d.confirmed_ok && d.confirmed_once && d.word_in_place && d.ends.length === 1, { round: slim(d) });
	await ensureClean('B.1-3: after the write from outside');
	await restoreMd('ai-report.md', original, 'Weekly report');
	// (E) no selection bar while composing: a word selected (the bar shows), then typed over through the IME.
	await ensureClean('B.1 後半: before the bar');
	await openMd('ai-report.md', 'Weekly report');
	await clickMd('quick', 'mid', { kind: 'dblclick' });
	await browser.pause(600);
	const barBefore = await exists(SELECTION_BAR);
	const pmE = await pageMark();
	await imeType(16, { romaji: 'nihon', convert: false, confirm: false, restore: false });
	const samples: boolean[] = [];
	for (const ms of [0, 500, 1_000]) {
		if (ms) await browser.pause(500);
		samples.push(await exists(SELECTION_BAR));
	}
	const composingE = compositionStarts((await pageSince(pmE)).inputs).length > 0 && compositionEnds((await pageSince(pmE)).inputs).length === 0;
	await imeKeys(16, ['k:53', 'w:400', 'k:53']);
	if (!composingE) environment(16, 'B.1-2 / 16-4: the IME did not start a conversion over the selected word; the bar is not judged', { samples });
	// The premise (照合 2026-11-20 P3): the bar was up for the selection before the typing, else "no bar" proves nothing.
	if (!barBefore) report(REPORT, { gate: 'environment', side: VARIANT, item: 'B.1-2 / 16-4: the selection bar did not show for the double-clicked word before the typing — "no bar while composing" is not judged', reason: 'bar_before = false', samples });
	else judge(16, 'B.1-2 / 16-4: the bar shown for a selected word goes and stays away while a conversion is open over it (typed over through the IME; three samples over 1 s)', samples.every((x) => !x), { bar_before: barBefore, samples });
	await ensureClean('after B.1 後半');
	await inputSource('restore');
	if (readBytes('ai-report.md') !== original) await restoreMd('ai-report.md', original, 'Weekly report');
}

// --- 12-2: the input rules with the IME on -------------------------------------------------------

/** 12-2 (B.1-4): nothing while composing; once after confirming half-width `##`・`**x**`・`` `y` ``; nothing full width or cancelled. */
async function gateImeInputRules(): Promise<void> {
	await openMd('rules.md', 'Start here.');
	if (!needsReal(12, 'the input rules with the IME on')) return;
	const last = async () => (await mdDoc())?.blocks.slice(-1)[0] ?? null;
	const fresh = async () => {
		await ensureClean('12-2: a fresh rules.md');
		await openMd('rules.md', 'Start here.');
		if (!(await clickMd('Start here.', 'end'))) environment(12, '12-2: the click at the end of "Start here." was not seen by the page');
		await realKey(KEY.return);
	};
	const fired = async (rule: 'heading' | 'strong' | 'code') => {
		const l = await last();
		if (rule === 'heading') return l?.type === 'heading';
		return marked(rule === 'strong' ? 'strong' : 'code', rule === 'strong' ? 'x' : 'y');
	};
	interface Case {
		name: string;
		romaji: string;
		half: boolean;
		end: 'return' | 'escape';
		space?: 'pid' | 'hid';
		rule: 'heading' | 'strong' | 'code';
	}
	const cases: Case[] = [
		{ name: '`##` made half width (F10), confirmed, then a space', romaji: '##', half: true, end: 'return', space: 'pid', rule: 'heading' },
		{ name: '`##` as the IME gives it (full width by default), confirmed, then a space with the IME on', romaji: '##', half: false, end: 'return', space: 'hid', rule: 'heading' },
		{ name: '`##` (F10) cancelled with Escape', romaji: '##', half: true, end: 'escape', rule: 'heading' },
		{ name: '`**x**` made half width (F10), confirmed', romaji: '**x**', half: true, end: 'return', rule: 'strong' },
		{ name: '`**x**` as the IME gives it, confirmed', romaji: '**x**', half: false, end: 'return', rule: 'strong' },
		{ name: '`` `y` `` made half width (F10), confirmed', romaji: '`y`', half: true, end: 'return', rule: 'code' },
	];
	let positive = 0;
	for (const c of cases) {
		await fresh();
		const pm = await pageMark();
		await imeType(12, { romaji: c.romaji, convert: false, confirm: false, restore: false });
		if (c.half) await imeKeys(12, [`k:${KEY3.f10}`], { settleMs: 400 });
		const duringFired = await fired(c.rule);
		const during = await last();
		if (c.end === 'return') await imeKeys(12, ['k:36']);
		else await imeKeys(12, ['k:53', 'w:400', 'k:53']);
		const ends = compositionEnds((await pageSince(pm)).inputs);
		const confirmed = c.end === 'escape' ? '' : String(ends[ends.length - 1]?.data ?? '');
		let spaceChar: string | null = null;
		const pmS = await pageMark();
		if (c.space === 'pid') {
			await realText(' ');
			spaceChar = ' ';
		} else if (c.space === 'hid') {
			await imeKeys(12, [`k:${KEY2.space}`]);
			const ins = (await pageSince(pmS)).inputs.filter((x) => x.type === 'insertText' || x.type === 'insertFromComposition' || x.type === 'compositionend');
			spaceChar = ins.length > 0 ? String(ins[ins.length - 1]!.data ?? '') : null;
			// A space that opened a conversion of its own (the IME composing a space): confirm it.
			if (compositionStarts((await pageSince(pmS)).inputs).length > compositionEnds((await pageSince(pmS)).inputs).length) await imeKeys(12, ['k:36']);
		}
		await browser.pause(400);
		const after = await last();
		const nowFired = await fired(c.rule);
		const want = c.rule === 'heading' ? '##' : c.rule === 'strong' ? '**x**' : '`y`';
		const expect = c.end === 'return' && confirmed === want && (c.rule !== 'heading' || spaceChar === ' ');
		if (expect) positive++;
		const once = !nowFired || (c.rule === 'heading' ? after?.type === 'heading' && after.level === 2 && after.text === '' : !(await mdText()).includes(want));
		judge(12, `12-2 (IME): ${c.name} — typed ${JSON.stringify(confirmed)}${spaceChar !== null ? ` + ${JSON.stringify(spaceChar)}` : ''}: ${expect ? 'the rule fires once, after the confirm' : 'the rule does not fire'}; nothing while composing`, !duringFired && nowFired === expect && once, { during, during_fired: duringFired, confirmed, space: spaceChar, after, fired: nowFired, expected: expect, ends: ends.map((e) => e.data ?? null) });
	}
	// The closing backtick confirmed on its own (`` `y `` confirmed, then `` ` `` confirmed): nothing after the first, once after the second.
	await fresh();
	const pmB = await pageMark();
	await imeType(12, { romaji: '`y', convert: false, confirm: false, restore: false });
	await imeKeys(12, [`k:${KEY3.f10}`], { settleMs: 400 });
	await imeKeys(12, ['k:36']);
	const mid = await marked('code', 'y');
	await imeType(12, { romaji: '`', convert: false, confirm: false, restore: false });
	await imeKeys(12, [`k:${KEY3.f10}`], { settleMs: 400 });
	await imeKeys(12, ['k:36']);
	const endsB = compositionEnds((await pageSince(pmB)).inputs).map((e) => String(e.data ?? ''));
	const halfB = endsB.length === 2 && endsB[0] === '`y' && endsB[1] === '`';
	if (halfB) positive++;
	judge(12, `12-2 (IME): \`y confirmed, then the closing \` confirmed (${JSON.stringify(endsB)}): ${halfB ? 'code "y" only after the second confirm, once' : 'the IME gave other characters — the rule does not fire'}`, !mid && (await marked('code', 'y')) === halfB, { ends: endsB, after_first: mid, after: await last() });
	fact(12, `12-2 (IME): the rule's firing path was exercised ${positive} time(s)`, { positive });
	// Moved from 【人】 (12-2): a run that never took the firing path judged only "nothing happens" — an environment row then
	// (照合 2026-11-20 P2-3: F10 may not make half-width characters from synthetic keys).
	if (positive === 0) report(REPORT, { gate: 'environment', side: VARIANT, item: '12-2 (IME): the rule\'s firing path was never exercised — the IME gave no half-width `##` / `**x**` / `` `y` `` (F10 from synthetic keys?); "fires once after the confirm" is not judged', reason: 'positive = 0', positive });
	await ensureClean('after 12-2 (IME)');
	await inputSource('restore');
}

// --- B.5: input source × keyboard type × the shortcuts --------------------------------------------

/** B.5 (gate 3・12-7・link): Command + B / I / K, Option + Command + 0〜6, Option + ↑ / ↓, Command + / per source × keyboard type. */
async function gateKeyboards(): Promise<void> {
	if (!needsReal(3, 'the shortcuts under each input source and keyboard type')) return;
	const kb = (await operator('kbtypes')) ?? {};
	const list = await inputSource('list');
	const sources = ((list?.result as { sources?: Array<{ id: string; type: string; selectable?: boolean }> } | undefined)?.sources ?? []).filter((s) => s.selectable !== false);
	const abc = sources.find((s) => s.id === 'com.apple.keylayout.ABC') ?? sources.find((s) => s.type === 'TISTypeKeyboardLayout');
	const jp = sources.find((s) => s.id === JAPANESE_SOURCE);
	const types = [
		{ name: 'ANSI', id: kb.ansi },
		{ name: 'JIS', id: kb.jis },
	].filter((t): t is { name: string; id: number } => typeof t.id === 'number');
	fact('B.5', 'the input sources and keyboard types tried (かな入力・Google 日本語入力・ATOK are not installed = out of scope, オーケストレーター 2026-11-20)', { abc: abc?.id ?? null, japanese: jp?.id ?? null, kbtypes: kb, enabled: sources.map((s) => s.id) });
	// Moved from 【人】 (12-7・B.5): what cannot be tried here is an environment row, never a quiet nothing (照合 2026-11-20 P2-3).
	const missing = [...(abc ? [] : ['the ABC input source']), ...(jp ? [] : ['the Japanese (Hiragana) input source']), ...(types.some((t) => t.name === 'ANSI') ? [] : ['the ANSI keyboard type id']), ...(types.some((t) => t.name === 'JIS') ? [] : ['the JIS keyboard type id'])];
	if (missing.length > 0) report(REPORT, { gate: 'environment', side: VARIANT, item: `B.5: not tried here — ${missing.join(', ')} (the rows of those combinations are missing)`, reason: missing.join(', '), kbtypes: kb, enabled: sources.map((s) => s.id) });
	if ((!abc && !jp) || types.length === 0) {
		report(REPORT, { gate: 'environment', side: VARIANT, item: 'B.5: no input source × keyboard type combination could be tried — no row judged', reason: 'zero combinations', kbtypes: kb, enabled: sources.map((s) => s.id) });
		return;
	}
	const blockOf = async (start: string) => (await mdDoc())?.blocks.find((b) => b.text.startsWith(start)) ?? null;
	let combos = 0;
	for (const src of [abc, jp].filter((x): x is { id: string; type: string } => !!x)) {
		await inputSource('set', src.id);
		for (const t of types) {
			const label = `${src.id === JAPANESE_SOURCE ? 'Japanese (Hiragana)' : src.id} × ${t.name} (keyboard type ${t.id})`;
			const send = (code: number, mods: string[], settleMs = 500) => realKeyX('B.5', code, mods, { kbtype: t.id, route: 'hid', settleMs });
			await ensureClean(`B.5 ${label}: Markdown`);
			await openMd('ai-report.md', 'Weekly report');
			await clickMd('brown', 'mid', { kind: 'dblclick' });
			await send(KEY2.b, ['cmd']);
			const bOn = await marked('strong', 'brown');
			await send(KEY.z, ['cmd']);
			const bOff = !(await marked('strong', 'brown'));
			await clickMd('brown', 'mid', { kind: 'dblclick' });
			await send(KEY2.i, ['cmd']);
			const iOn = await marked('em', 'brown');
			await send(KEY.z, ['cmd']);
			const iOff = !(await marked('em', 'brown'));
			judge(3, `B.5 ${label}: Command + B / Command + I on a selected word put bold / italic on (Command + Z takes each off)`, bOn && bOff && iOn && iOff, { bold: bOn, bold_off: bOff, italic: iOn, italic_off: iOff });
			await clickMd('quick', 'mid', { kind: 'dblclick' });
			await send(KEY2.k, ['cmd'], 800);
			const kOpen = await exists(LINK_EDITOR);
			await send(KEY.escape, []);
			judge('link', `B.5 ${label}: Command + K on a selected word opens the link editor (Esc closes it)`, kOpen && !(await exists(LINK_EDITOR)), { opened: kOpen });
			await clickMd('Third paragraph', 3);
			// The HID route (this matrix's): the page's keydowns are counted. None = the machine's (diag-b5 2026-11-20: Option +
			// Command on the HID route never reaches the page, Option + Command + U included) — an environment row, no judge.
			const headingRun = async (route: 'hid' | 'pid') => {
				await installKeyProbe();
				const km = await keyProbeMark();
				const levels: Array<number | string | null> = [];
				for (let n = 1; n <= 6; n++) {
					await realKeyX('B.5', DIGIT_KEYS[n]!, ['cmd', 'opt'], { kbtype: t.id, route, settleMs: 400 });
					const blk = await blockOf('Third paragraph');
					levels.push(blk?.type === 'heading' ? (blk.level ?? null) : (blk?.type ?? null));
				}
				await realKeyX('B.5', DIGIT_KEYS[0]!, ['cmd', 'opt'], { kbtype: t.id, route, settleMs: 400 });
				const body = (await blockOf('Third paragraph'))?.type ?? null;
				const keydowns = (await keyProbeSince(km)).filter((k) => k.phase === 'capture').map((k) => ({ key: k.key, code: k.code, altKey: k.altKey, metaKey: k.metaKey }));
				return { levels, body, keydowns, ok: levels.join(',') === '1,2,3,4,5,6' && body === 'paragraph' };
			};
			const hid = await headingRun('hid');
			if (hid.keydowns.length === 0) environmentRow('B.5', `B.5 ${label}: Option + Command + 1〜6 / 0 on the HID route never reached the page (no keydown) — not judged (HID の Option + Command が届かない。diag-b5 2026-11-20)`, hid);
			else judge(3, `B.5 ${label}: Option + Command + 1〜6 make Heading 1〜6 and Option + Command + 0 Body Text again (the HID route)`, hid.ok, hid);
			// The product's check: the same keys on the pid route (CGEventPostToPid), from a fresh paragraph.
			await ensureClean(`B.5 ${label}: before the pid route`);
			await openMd('ai-report.md', 'Weekly report');
			await clickMd('Third paragraph', 3);
			const pid = await headingRun('pid');
			judge(3, `B.5 ${label}: Option + Command + 1〜6 make Heading 1〜6 and Option + Command + 0 Body Text again (the pid route = CGEventPostToPid)`, pid.ok, pid);
			await ensureClean(`B.5 ${label}: code`);
			await openDoc('app.ts');
			const l0 = await faceLines();
			await clickAt(1, 2);
			await send(KEY.down, ['opt']);
			const moved = await faceLines();
			await send(KEY2.up, ['opt']);
			const back = await faceLines();
			judge(12, `B.5 ${label}: Option + ↓ moves line 2 of app.ts below line 3 and Option + ↑ moves it back`, moved[1] === l0[2] && moved[2] === l0[1] && back.join('\n') === l0.join('\n'), { moved: moved.slice(0, 4) });
			await clickAt(1, 1);
			await send(KEY2.slash, ['cmd']);
			const on = (await faceLines())[1] ?? '';
			await send(KEY2.slash, ['cmd']);
			const off = (await faceLines())[1] ?? '';
			judge(12, `B.5 ${label}: Command + / adds \`//\` to line 2 of app.ts and takes it off again`, on.trimStart().startsWith('//') && off === l0[1], { on, off, before: l0[1] });
			await ensureClean(`after B.5 ${label}`);
			combos++;
		}
	}
	if (combos === 0) report(REPORT, { gate: 'environment', side: VARIANT, item: 'B.5: no combination was driven to the end — no row judged', reason: 'zero combinations' });
	await inputSource('restore');
	human(3, 'B.5: the shortcut assignments on your own keyboard (起案時判断 (g)) = 【人】', {});
}

// --- B.6: drags and drops --------------------------------------------------------------------------

async function installDragHooks(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __gate74drag?: { log: Array<Record<string, unknown>>; overs: number; pressedMoves: number } };
		if (w.__gate74drag) return;
		const g = { log: [] as Array<Record<string, unknown>>, overs: 0, pressedMoves: 0 };
		w.__gate74drag = g;
		for (const type of ['dragstart', 'dragenter', 'drop', 'dragend']) {
			window.addEventListener(type, (e) => {
				const d = e as DragEvent;
				g.log.push({ type, at: Date.now(), x: d.clientX, y: d.clientY, types: d.dataTransfer ? Array.from(d.dataTransfer.types) : [] });
			}, true);
		}
		window.addEventListener('dragover', () => g.overs++, true);
		window.addEventListener('mousemove', (e) => {
			if ((e as MouseEvent).buttons) g.pressedMoves++;
		}, true);
	});
}
async function dragMark(): Promise<{ n: number; overs: number; moves: number }> {
	return browser.execute(() => {
		const g = (window as unknown as { __gate74drag?: { log: unknown[]; overs: number; pressedMoves: number } }).__gate74drag;
		return { n: g?.log.length ?? 0, overs: g?.overs ?? 0, moves: g?.pressedMoves ?? 0 };
	});
}
async function dragSince(m: { n: number; overs: number; moves: number }): Promise<{ events: Array<{ type: string; types?: string[] }>; dragovers: number; pressed_moves: number }> {
	return browser.execute((mm) => {
		const g = (window as unknown as { __gate74drag?: { log: Array<{ type: string; types?: string[] }>; overs: number; pressedMoves: number } }).__gate74drag;
		if (!g) return { events: [], dragovers: 0, pressed_moves: 0 };
		return { events: g.log.slice(mm.n), dragovers: g.overs - mm.overs, pressed_moves: g.pressedMoves - mm.moves };
	}, m);
}
const DRAG_VARIANTS: Array<{ name: string; o: Record<string, unknown> }> = [
	{ name: 'as before (the combined-session source)', o: {} },
	{ name: 'the HID-state source + deltas + pressure + a hover first', o: { src: 'hid', delta: true, pressure: true, hover_ms: 300 } },
	{ name: 'no source (as cliclick) + deltas', o: { src: 'none', delta: true } },
];
/** One real drag of the double-clicked "quick" to the end of the second summary paragraph; the page's drag events. */
async function dragQuick(o: Record<string, unknown>): Promise<Record<string, unknown>> {
	await mdPoint('only here.', 'end');
	const from = await mdPoint('quick', 'mid');
	if (!from?.inside) return { error: '"quick" is not in view' };
	await realClick(from.x, from.y, [], 'dblclick');
	const sel = (await mdSel()).text;
	await browser.pause(1_500);
	const from2 = await mdPoint('quick', 'mid');
	const to = await mdPoint('only here.', 'end');
	if (!from2?.inside || !to?.inside) return { error: 'the drag points are not both in view', from: from2, to };
	refreshFrame(screen!.pid);
	const a = toScreen(from2.x, from2.y);
	const b = toScreen(to.x, to.y);
	const mark = await dragMark();
	const d = await operator('drag', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, route: 'hid', hold_ms: 500, steps: 30, step_ms: 30, ...o }, 240_000);
	await browser.pause(800);
	const ev = await dragSince(mark);
	const text = await mdText();
	const second = text.split('\n').find((l) => l.startsWith('Second paragraph')) ?? '';
	const moved = sel === 'quick' && !text.includes('The quick brown') && /here\.\s?quick|quick\s?here\./.test(second);
	return { selected: sel, drag: d, page: ev, started: ev.events.some((e) => e.type === 'dragstart'), moved, second };
}

/** B.6 (12-9): a drag inside the face (three ways of sending), drops from the tool's own window, the page's drop. */
async function gateDragDrop(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	// (1) The page's drop: a DragEvent with a DataTransfer of text/html + text/plain = what WebKit hands the page for a drop
	// from outside. The product's rule (3-5): outside text / HTML enters as characters.
	const before = await mdText();
	const dropped = await browser.execute((sel) => {
		const face = document.querySelector(sel);
		if (!face) return { error: 'no face' };
		const walker = document.createTreeWalker(face, NodeFilter.SHOW_TEXT);
		let node: Text | null = null;
		while (walker.nextNode()) {
			const t = walker.currentNode as Text;
			if (t.data.includes('only here.')) {
				node = t;
				break;
			}
		}
		if (!node) return { error: 'no "only here."' };
		const i = node.data.indexOf('only here.') + 'only here.'.length;
		const range = document.createRange();
		range.setStart(node, i);
		range.setEnd(node, i);
		const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
		const x = r.x + 1;
		const y = r.y + r.height / 2;
		let dt: DataTransfer;
		try {
			dt = new DataTransfer();
		} catch (e) {
			return { error: `new DataTransfer() failed: ${String(e)}` };
		}
		dt.setData('text/html', '<b>bold</b> and <a href="https://example.com/">link</a>');
		dt.setData('text/plain', 'bold and link');
		const target = document.elementFromPoint(x, y) ?? face;
		const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt };
		let ctor = 'DragEvent';
		const make = (type: string) => {
			try {
				return new DragEvent(type, init);
			} catch {
				ctor = 'MouseEvent + dataTransfer';
				const ev = new MouseEvent(type, init);
				Object.defineProperty(ev, 'dataTransfer', { value: dt });
				return ev;
			}
		};
		target.dispatchEvent(make('dragenter'));
		target.dispatchEvent(make('dragover'));
		const notPrevented = target.dispatchEvent(make('drop'));
		return { x, y, ctor, prevented: !notPrevented, target: target.tagName };
	}, PM);
	await browser.pause(500);
	const after = await mdText();
	const pageOk = countOf(after, 'bold and link') === countOf(before, 'bold and link') + 1 && !(await marked('strong', 'bold and')) && !(await browser.execute((s) => Array.from(document.querySelectorAll(`${s} a`)).some((a) => (a.textContent ?? '') === 'link'), PM));
	judge(12, 'B.6 (the page): a drop of text/html + text/plain from outside (a DragEvent with a DataTransfer) enters "bold and link" once as characters — no <strong>, no <a> from it (3-5)', pageOk, { dispatched: dropped, around: after.split('\n').find((l) => l.includes('bold and link')) ?? null });
	await ensureClean('after the page drop');
	if (!needsReal(12, 'the native drags and drops')) return;
	await installDragHooks();
	// (2) A word dragged inside the face, three ways of sending: judged only where WebKit started the drag.
	const runs: Array<Record<string, unknown>> = [];
	for (const v of DRAG_VARIANTS) {
		await ensureClean(`B.6: before the drag (${v.name})`);
		await openMd('ai-report.md', 'Weekly report');
		await installDragHooks();
		const r = await dragQuick(v.o);
		runs.push({ variant: v.name, ...r });
		if (r.started) judge(12, `B.6 / 12-9 (${v.name}): WebKit started the text drag (dragstart) and the selected "quick" moved to the end of the second summary paragraph (gone from the first)`, r.moved === true, r);
		else fact(12, `B.6 / 12-9 (${v.name}): no dragstart — WebKit did not start a text drag from this synthetic drag (the machine's limit; not judged)`, r);
	}
	if (!runs.some((r) => r.started)) human(12, '12-9: dragging a selected word inside the face — no way of sending started a WebKit text drag (B.6 above) = 【人】', { runs: runs.map((r) => ({ variant: r.variant, pressed_moves: (r.page as { pressed_moves?: number } | undefined)?.pressed_moves ?? null })) });
	// (3) Drops from the tool's own window (probewin dragsource): Safari's types, plain text, a file as Finder gives it.
	const drops: Array<{ name: string; types: string; expect: 'text' | 'unchanged' }> = [
		{ name: 'Safari\'s types (text + HTML + RTF)', types: 'safari', expect: 'text' },
		{ name: 'plain text', types: 'plain', expect: 'text' },
		{ name: 'a file (public.file-url, as Finder)', types: `file:${fileOf('notes.md')}`, expect: 'unchanged' },
	];
	for (const dr of drops) {
		await ensureClean(`B.6: before the drop (${dr.name})`);
		await openMd('ai-report.md', 'Weekly report');
		await installDragHooks();
		const p = await mdPoint('only here.', 'end');
		if (!p?.inside) {
			fact(12, `B.6 drop (${dr.name}): "only here." is not in view; not driven`, {});
			continue;
		}
		refreshFrame(screen!.pid);
		const s = toScreen(p.x + 1, p.y);
		const textBefore = await mdText();
		// The marks of the face before / after (2026-11-20: `marked('strong', 'bold')` also matched the fixture's own
		// "second item with **bold** text", so the judge was always false): no strong / a may be added by the drop, and
		// none may hold the dropped words.
		const marksNow = () =>
			browser.execute((sel) => {
				const strongs = Array.from(document.querySelectorAll(`${sel} strong, ${sel} b`)).map((e) => e.textContent ?? '');
				const links = Array.from(document.querySelectorAll(`${sel} a`)).map((e) => e.textContent ?? '');
				return { strong: strongs.length, a: links.length, a_with_dropped: links.filter((t) => t === 'link').length };
			}, PM);
		const marksBefore = await marksNow();
		const mark = await dragMark();
		const a = await operator('probe', { kind: 'dragsource', x: s.x, y: s.y, opts: { types: dr.types, steps: 30, hold: 300, step: 30 } }, 240_000);
		await browser.pause(900);
		const ev = await dragSince(mark);
		const text = await mdText();
		const probe = (a?.probe ?? {}) as { error?: string; session_ended?: boolean; ended_operation?: number; accepted_by_app?: boolean };
		// Reached = the page saw the drag (dragenter / dragover / drop), or the session ended with an operation over the app's
		// window (wry answers Copy for every drag while Tauri's drag-drop handler is on — then the page may see nothing:
		// wry-0.54.4 src/wkwebview/drag_drop.rs, tauri-runtime-wry-2.10.1 lib.rs returns true). Not reached = an environment
		// row, never a quiet pass (照合 2026-11-20 P2-2).
		const pageReached = ev.events.some((e) => e.type === 'drop' || e.type === 'dragenter') || ev.dragovers > 0;
		const reached = pageReached || probe.accepted_by_app === true;
		if (probe.error) {
			report(REPORT, { gate: 'environment', side: VARIANT, item: `B.6 drop (${dr.name}): the tool's window could not drag (${probe.error})`, reason: String(probe.error), answer: a });
			continue;
		}
		if (!reached) {
			report(REPORT, { gate: 'environment', side: VARIANT, item: `B.6 drop (${dr.name}): the drag from the tool's window reached neither the page (no dragenter / dragover / drop) nor the app (no operation over its window) — not judged`, reason: 'not reached', probe: a, page: ev });
			continue;
		}
		if (dr.expect === 'text') {
			const added = countOf(text, 'bold and link') - countOf(textBefore, 'bold and link');
			const marksAfter = await marksNow();
			const noNewMarks = marksAfter.strong === marksBefore.strong && marksAfter.a === marksBefore.a && marksAfter.a_with_dropped === marksBefore.a_with_dropped && !(await marked('strong', 'bold and'));
			judge(12, `B.6 drop (${dr.name}) from the tool's own window: the drop reached the ${pageReached ? 'page' : 'app (not the page)'} and "bold and link" enters once as characters at the drop point — no <strong>, no <a> from it (the face's strong / a counted before and after)`, added === 1 && noNewMarks, { probe: a, page: ev, page_reached: pageReached, marks: { before: marksBefore, after: marksAfter }, around: text.split('\n').find((l) => l.includes('bold and link')) ?? null });
		} else {
			judge(12, `B.6 drop (${dr.name}) from the tool's own window: the drop reached the ${pageReached ? 'page' : 'app (not the page)'} and the face is unchanged (no path or content typed in — 今のまま)`, text === textBefore, { probe: a, page: ev, page_reached: pageReached, front_window: await operator('front') });
		}
	}
	await ensureClean('after B.6');
	human(12, 'B.6: one real drop from Safari and one from Finder by hand, once (由谷の決定 2026-11-20 (4)) = 【人】', {});
}

// --- B.6 nav: the navigation net (0494ebe・事後確認 (26)) ----------------------------------------------------
// With Tauri's drag-drop handler off (1cb3164), a file dropped on the HTML viewer's frame or the PDF viewer's frame is not
// seen by the page's guard (file-drop-guard.ts) and WebKit would load it in the main frame; the net (src-tauri/src/window/
// navigation.rs) refuses every URL that is not the app's own and writes a `navigation refused` warning. These its drop a
// file there from the tool's own window, and check that the net breaks nothing the views need (about:srcdoc, the PDF's
// vellis-asset: frame) and that the HTML preview's links stay inert (html-viewer.ts renames their href).

// The HTML and PDF views are mounted by +page.svelte in `.viewer-main`, not inside Viewer.svelte's `article.viewer`
// (2026-11-21 run out-nav: "article.viewer iframe.html-viewer never appeared").
const HTML_FRAME = '.viewer-main iframe.html-viewer';
const PDF_FRAME = '.viewer-main iframe.pdf-frame';

/** The `navigation refused` warnings in the app's log (req74-app.log, ANSI colours stripped). */
function refusedNavigations(): string[] {
	const file = path.join(SHOTS_DIR, 'req74-app.log');
	if (!fs.existsSync(file)) return [];
	// eslint-disable-next-line no-control-regex
	const text = fs.readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
	return text.split('\n').filter((l) => /navigation refused/.test(l));
}
/** The main AX window's strings (web content and frames included) and the AX elements holding `needle`. */
function axWindowIndex(): number {
	const wins = ax(['axwins', String(screen?.pid ?? appPid())]);
	const main = wins.find((w) => w.main === true) ?? wins[0];
	return (main?.index as number | undefined) ?? 0;
}
function axTexts(): string[] | null {
	try {
		const r = ax(['texts', String(screen?.pid ?? appPid()), String(axWindowIndex())])[0];
		return (r?.texts as string[] | undefined) ?? null;
	} catch {
		return null;
	}
}
function axFind(needle: string): Array<{ role: string; text: string; x: number; y: number; w: number; h: number }> {
	try {
		return ax(['find', String(screen?.pid ?? appPid()), String(axWindowIndex()), needle]) as unknown as Array<{ role: string; text: string; x: number; y: number; w: number; h: number }>;
	} catch {
		return [];
	}
}
/** What the window shows now: the main frame's URL, the frame's src / srcdoc, the Unsaved badge, the selected Explorer row. */
async function viewState(frameSel: string): Promise<Record<string, unknown>> {
	const url = await browser.getUrl();
	const dom = await browser.execute((sel) => {
		const f = document.querySelector<HTMLIFrameElement>(sel);
		const r = f?.getBoundingClientRect();
		return {
			frame: !!f,
			src: f?.getAttribute('src') ?? null,
			srcdoc_head: f?.srcdoc ? f.srcdoc.slice(0, 120) : null,
			srcdoc_length: f?.srcdoc?.length ?? 0,
			rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
			placeholder: document.querySelector('.viewer-main .pdf-placeholder') !== null,
			badge: document.querySelector('[data-testid="unsaved-badge"]') !== null,
			selected_row: document.querySelector('[aria-selected="true"], .explorer-item.selected, .selected')?.textContent?.trim().slice(0, 60) ?? null,
		};
	}, frameSel);
	return { url, ...dom };
}
const sameView = (a: Record<string, unknown>, b: Record<string, unknown>) => a.url === b.url && a.frame === b.frame && a.src === b.src && a.srcdoc_length === b.srcdoc_length && a.srcdoc_head === b.srcdoc_head && a.badge === b.badge;

/** B.6 nav (drops): a file dropped on the HTML frame and on the PDF frame — the window stays on the app's page. */
async function gateNavDrops(): Promise<void> {
	if (!needsReal(12, 'the file drops on the HTML / PDF frames')) return;
	// The PDF view is a different check (照合 2026-11-20 P3): WebKit does not load a file dropped on a PDF plugin document
	// even without the net, so its row says "the PDF view stays the same" (the view's guard), not "the net refused".
	const NOTES_MARK = 'Paragraph one has enough words';
	for (const v of [
		{ name: 'the HTML view (nav.html)', rel: 'nav.html', frame: HTML_FRAME, claim: 'leaves the window on the app\'s page — the URL, the frame\'s content and the badge as before, and notes.md\'s text is nowhere in the window (neither the window nor the frame moved to it)' },
		{ name: 'the PDF view (nav.pdf)', rel: 'nav.pdf', frame: PDF_FRAME, claim: 'leaves the PDF view as it was (the view\'s guard: WebKit does not load a file dropped on a PDF plugin document, so this does not test the net) — the URL, the frame\'s source and the badge as before, and notes.md\'s text is nowhere in the window' },
	]) {
		await ensureClean(`B.6 nav: before ${v.name}`);
		await openDoc(v.rel, v.frame);
		await browser.pause(1_200);
		const before = await viewState(v.frame);
		const r = before.rect as { x: number; y: number; w: number; h: number } | null;
		if (!r || r.w < 40 || r.h < 40) {
			report(REPORT, { gate: 'environment', side: VARIANT, of: 12, item: `B.6 nav (${v.name}): the frame is not on screen — not driven`, reason: 'no frame', view: before });
			continue;
		}
		refreshFrame(screen!.pid);
		const at = toScreen(Math.round(r.x + r.w / 2), Math.round(r.y + Math.min(r.h / 2, 260)));
		const refusedBefore = refusedNavigations().length;
		const a = await operator('probe', { kind: 'dragsource', x: at.x, y: at.y, opts: { types: `file:${fileOf('notes.md')}`, steps: 30, hold: 300, step: 30 } }, 240_000);
		await browser.pause(1_500);
		const probe = (a?.probe ?? {}) as { error?: string; session_ended?: boolean; accepted_by_app?: boolean; ended_operation?: number };
		const after = await viewState(v.frame);
		const refused = refusedNavigations().slice(refusedBefore);
		if (probe.error || probe.session_ended !== true) {
			report(REPORT, { gate: 'environment', side: VARIANT, of: 12, item: `B.6 nav (${v.name}): the tool's window did not drop (${probe.error ?? 'the session did not end'}) — not judged`, reason: String(probe.error ?? 'no session end'), probe: a, view: { before, after } });
			continue;
		}
		// A frame that moved alone keeps the main URL: notes.md's own text in the window's AX strings tells it (照合 P3).
		const textsAfter = axTexts();
		const notesShown = textsAfter ? textsAfter.some((t) => t.includes(NOTES_MARK)) : null;
		if (notesShown === null) report(REPORT, { gate: 'environment', side: VARIANT, of: 12, item: `B.6 nav (${v.name}): the AX strings of the window could not be read after the drop — whether the frame moved to the file is not judged`, reason: 'no AX texts', view: { before, after } });
		else judge(12, `B.6 nav (${v.name}): a file (public.file-url, as Finder) dropped on the frame ${v.claim}`, sameView(before, after) && !notesShown, { view: { before, after }, notes_text_in_window: notesShown, probe: { accepted_by_app: probe.accepted_by_app ?? null, ended_operation: probe.ended_operation ?? null } });
		fact(12, `B.6 nav (${v.name}): the app's log ${refused.length > 0 ? `has ${refused.length} "navigation refused" line(s) from the drop (the net refused the file)` : 'has no "navigation refused" line from the drop'}`, { refused: refused.map((l) => l.slice(0, 300)) });
	}
	await ensureClean('after B.6 nav (drops)');
}

/** B.6 nav (views): the net keeps the HTML frame's content and the PDF's pages; the preview's links do not move the window. */
async function gateNavViews(): Promise<void> {
	await ensureClean('B.6 nav: before the views');
	await openDoc('nav.html', HTML_FRAME);
	await browser.pause(1_200);
	const html = await viewState(HTML_FRAME);
	const textsHtml = axTexts();
	const shown = textsHtml ? textsHtml.some((t) => t.includes('NAVHTML marker')) : null;
	const srcdocOk = typeof html.srcdoc_length === 'number' && (html.srcdoc_length as number) > 0 && (await browser.execute((sel) => (document.querySelector<HTMLIFrameElement>(sel)?.srcdoc ?? '').includes('NAVHTML marker'), HTML_FRAME));
	if (shown === null) report(REPORT, { gate: 'environment', side: VARIANT, of: 12, item: 'B.6 nav (views): the AX strings of the window could not be read — whether the HTML frame draws its content is not judged', reason: 'no AX texts', view: html });
	else judge(12, 'B.6 nav (views): the HTML view under the net — the frame (about:srcdoc) gets nav.html and draws it (its marker is among the window\'s AX strings)', srcdocOk && shown, { view: html, srcdoc_has_marker: srcdocOk, ax_has_marker: shown });
	// The links of the preview are inert (html-viewer.ts): a real click on the relative link and on the outside one.
	if (OPERATOR && !realInputBlocked) {
		for (const link of [
			{ name: 'the relative link (nav-other.html)', text: 'NAVLINK internal' },
			{ name: 'the outside link (https://vellis-gate-nav.invalid/)', text: 'NAVLINK external' },
		]) {
			const hits = axFind(link.text);
			const el = hits.find((h) => h.role === 'AXLink') ?? hits.find((h) => h.role === 'AXStaticText') ?? hits[0];
			if (!el || el.w <= 0 || el.h <= 0) {
				report(REPORT, { gate: 'environment', side: VARIANT, of: 12, item: `B.6 nav (views): ${link.name} was not found by AX — not clicked`, reason: 'no AX element', hits });
				continue;
			}
			const before = await viewState(HTML_FRAME);
			const refusedBefore = refusedNavigations().length;
			const frontBefore = await operator('front');
			const c = await operator('click', { x: Math.round(el.x + el.w / 2), y: Math.round(el.y + el.h / 2), route: 'hid' }, 240_000);
			await browser.pause(1_500);
			const after = await viewState(HTML_FRAME);
			const texts = axTexts();
			const frontAfter = await operator('front');
			// nav-other.html is an app URL (vellis-asset:) the net lets through: only the inert links keep the frame, so the
			// frame must not show its marker (照合 2026-11-20 P3).
			const otherShown = texts ? texts.some((t) => t.includes('NAVOTHER marker')) : null;
			if (otherShown === null) report(REPORT, { gate: 'environment', side: VARIANT, of: 12, item: `B.6 nav (views): the AX strings could not be read after the click on ${link.name} — not judged`, reason: 'no AX texts', view: { before, after } });
			else judge(12, `B.6 nav (views): a real click on ${link.name} in the HTML preview leaves the window on the app's page and the frame on nav.html (the URL and the frame's content as before, no NAVOTHER marker in the window — the link is inert)`, c?.sent === true && sameView(before, after) && !otherShown, { view: { before, after }, click: { sent: c?.sent ?? null }, ax_has_other: otherShown });
			fact(12, `B.6 nav (views): after the click on ${link.name} — ${texts?.some((t) => t.includes('NAVOTHER marker')) ? 'the frame shows nav-other.html' : 'the frame still shows nav.html (the link is inert)'}; ${refusedNavigations().length - refusedBefore} "navigation refused" line(s); the front app ${(frontBefore?.front_app as { pid?: number } | undefined)?.pid === (frontAfter?.front_app as { pid?: number } | undefined)?.pid ? 'did not change (no browser opened)' : 'changed (another app came to the front)'}`, { front_before: frontBefore?.front_app ?? null, front_after: frontAfter?.front_app ?? null, ax_has_other: texts?.some((t) => t.includes('NAVOTHER marker')) ?? null });
			await operator('make-front');
		}
	} else {
		skipped(12, 'B.6 nav (views): the clicks on the preview\'s links', realInputBlocked ?? 'no operator');
	}
	// The PDF view under the net: the frame (vellis-asset:) with its pages.
	await openDoc('nav.pdf', PDF_FRAME);
	await browser.pause(1_500);
	const pdf = await viewState(PDF_FRAME);
	const r = pdf.rect as { w: number; h: number } | null;
	judge(12, 'B.6 nav (views): the PDF view under the net — the frame is there with its vellis-asset: source, on screen, and no placeholder (the file was read and handed to the frame)', pdf.frame === true && String(pdf.src ?? '').startsWith('vellis-asset:') && !!r && r.w > 100 && r.h > 100 && pdf.placeholder === false, { view: pdf });
	const textsPdf = axTexts();
	const pages = textsPdf ? [1, 2].filter((n) => textsPdf.some((t) => t.includes(`NAVPDF page ${n}`))) : null;
	// When the PDF's text is readable by AX at all, the first page must be among it (照合 2026-11-20 P3); when it is not
	// (the PDF plugin may expose nothing), it stays a fact.
	if (textsPdf && textsPdf.some((t) => t.includes('NAVPDF'))) judge(12, 'B.6 nav (views): the PDF view draws its pages — "NAVPDF page 1" is among the window\'s AX strings', pages?.includes(1) === true, { pages });
	else fact(12, `B.6 nav (views): the PDF's pages among the window's AX strings: ${pages === null ? 'the AX strings could not be read' : 'none (the PDF plugin may not expose its text to AX)'}`, { pages, refused: refusedNavigations().slice(-3).map((l) => l.slice(0, 300)) });
	await ensureClean('after B.6 nav (views)');
}

// --- the shots for the eye (P) --------------------------------------------------------------------

/** 16-3 (P): the formatting toolbar at 150 %, with Toggle Full Width, in Dark (the 100 % Light one is 16-3's own shot). */
async function gateToolbarShots(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	if (!OPERATOR) {
		skipped(16, '16-3 (P): the toolbar shots', 'no operator');
		return;
	}
	if (!(await exists(FORMAT_TOOLBAR))) await operator('press-menu', { menu: 'View', item: 'Show Formatting Toolbar' });
	await waitFor(FORMAT_TOOLBAR, 'the formatting toolbar', 5_000).catch(() => undefined);
	const files: Record<string, string | null> = {};
	await emitMenu('menu_zoom_reset');
	for (let i = 0; i < 5; i++) {
		await emitMenu('menu_zoom_in');
		await browser.pause(150);
	}
	await browser.pause(500);
	files['150 %'] = await shotNamed('req74-format-toolbar-150');
	await emitMenu('menu_zoom_reset');
	await browser.pause(400);
	await emitMenu('menu_toggle_full_width');
	await browser.pause(600);
	files['Toggle Full Width'] = await shotNamed('req74-format-toolbar-fullwidth');
	await emitMenu('menu_toggle_full_width');
	await browser.pause(600);
	await operator('submenu-press', { menu: 'View', submenu: 'Appearance', item: 'Dark' });
	await browser.pause(800);
	files.Dark = await shotNamed('req74-format-toolbar-dark');
	await operator('submenu-press', { menu: 'View', submenu: 'Appearance', item: 'System' });
	await browser.pause(600);
	await operator('press-menu', { menu: 'View', item: 'Show Formatting Toolbar' });
	await browser.pause(400);
	human(16, '16-3 (P): the toolbar at 150 %, with Toggle Full Width and in Dark — look at the shots = 【人】', { files, shown_at_end: await exists(FORMAT_TOOLBAR) });
}

/** 12-8 (P): the gap cursor before a leading table, shot for the eye. */
async function gateGapShot(): Promise<void> {
	await openMd('gap.md', 'Middle paragraph.');
	if (!needsReal(12, 'the gap cursor shot')) return;
	await clickMd('a', 'end', { root: `${PM} table` });
	let n = 0;
	for (let i = 1; i <= 3 && n === 0; i++) {
		await realKey(KEY2.up);
		if (await exists(`${PM} .ProseMirror-gapcursor`)) n = i;
	}
	const r = await rectOf(`${PM} .ProseMirror-gapcursor`);
	const file = await shotNamed('req74-gap-cursor');
	human(12, '12-8 (P): how the gap cursor before a leading table looks — the shot = 【人】', { file, ups: n, gap_cursor_rect: r });
	await ensureClean('after the gap shot');
}

// --- the diagnosis D1〜D6 (stage diag) -------------------------------------------------------------

/**
 * D1: conversion with Space — the gate's Vellis (webdriver attached), Space held 12 / 100 ms; the tool's own NSTextView /
 * WKWebView. 2026-11-20 run: the Space reached the page and converted (compositionupdate "日本"), the Return's keydown came
 * (229) but no compositionend was seen. So each round now records the Return on its own: the compositionend after it (and
 * after a second Return when the first brought none), the document then, and the bytes a real Command + S writes.
 */
async function diagD1(): Promise<void> {
	if (!needsReal('diag', 'D1: the conversion with Space')) return;
	const original = readBytes('ime-diag.md');
	const rounds: Array<Record<string, unknown>> = [];
	for (const hold of [12, 100]) {
		await ensureClean(`D1 (hold ${hold} ms)`);
		await openMd('ime-diag.md', 'IMEHERE');
		await clickMd('IMEHERE', 'end');
		const caret0 = await caretOnScreen();
		const base = await windowNumbers();
		const blocks0 = (await mdDoc())?.blocks.length ?? 0;
		const pm = await pageMark();
		const a = await imeType('diag', { romaji: 'nihon', convert: true, confirm: false, hold_ms: hold, windows: true, restore: false, shot_after_space: `req74-diag-d1-space-${hold}` });
		await browser.pause(300);
		const afterSpace = await pageSince(pm);
		const caret1 = await caretOnScreen();
		const r1 = await imeKeys('diag', ['k:36'], { settleMs: 1_000, windowsBase: base });
		const endsAfterFirst = compositionEnds((await pageSince(pm)).inputs).length;
		const docAfterFirst = await mdDoc();
		let r2: Record<string, unknown> | null = null;
		if (endsAfterFirst === 0) r2 = await imeKeys('diag', ['k:36'], { settleMs: 1_000 });
		const seen = await pageSince(pm);
		const ends = compositionEnds(seen.inputs);
		const confirmed = String(ends[ends.length - 1]?.data ?? '');
		const doc = await mdDoc();
		const para = doc?.blocks.find((b) => b.text.startsWith('IMEHERE'))?.text ?? null;
		let saved: string | null = null;
		if (ends.length > 0) {
			await realSave();
			saved = readBytes('ime-diag.md').split('\n').find((l) => l.startsWith('IMEHERE')) ?? null;
		} else {
			await imeKeys('diag', ['k:53', 'w:400', 'k:53']);
		}
		const cands = candidateWindows(((a?.windows ?? {}) as { after_space?: unknown }).after_space);
		rounds.push({
			hold_ms: hold,
			space: a?.space ?? null,
			converted_after_space: afterSpace.inputs.filter((x) => x.type === 'compositionupdate').map((x) => x.data ?? null).slice(-1)[0] ?? null,
			first_return: { sent: r1?.sent ?? null, compositionend_after_it: endsAfterFirst > 0, new_windows: r1?.windows ?? null, paragraph: docAfterFirst?.blocks.find((b) => b.text.startsWith('IMEHERE'))?.text ?? null },
			second_return: r2 ? { sent: r2.sent ?? null, compositionend_after_it: ends.length > 0 } : null,
			returns_needed: ends.length === 0 ? null : endsAfterFirst > 0 ? 1 : 2,
			confirmed,
			paragraph: para,
			blocks: { before: blocks0, after: doc?.blocks.length ?? 0 },
			saved_line: saved,
			candidate_windows: cands.map((w) => ({ ...w, near_caret: caret0 && caret1 ? candidateNear(w, caret0, caret1) : null })),
			caret: { before_typing: caret0, after_space: caret1 },
			windows: a?.windows ?? null,
			keys: seen.keys.map((k) => ({ key: k.key, keyCode: k.keyCode ?? null, isComposing: k.isComposing ?? null, at: k.at })),
			inputs: seen.inputs.map((x) => ({ type: x.type, data: x.data ?? null, at: x.at })),
		});
		if (readBytes('ime-diag.md') !== original) await restoreMd('ime-diag.md', original, 'IMEHERE');
	}
	fact('diag', 'D1 (webdriver attached): "nihon" + Space (held 12 / 100 ms), then Return on its own — did Space convert, did the (first / second) Return confirm (compositionend), the paragraph and the saved line after it, the candidate windows (the app\'s own layer > 0 windows included) against the caret', { rounds });
	await ensureClean('D1: after the gate\'s rounds');
	const probes: Array<Record<string, unknown>> = [];
	for (const target of ['textview', 'webview']) {
		for (const hold of [12, 100]) {
			const p = await operator('probe', { kind: 'ime', target, script: `c:n,c:i,c:h,c:o,c:n,w:400,win:typed,k:49@${hold},w:1000,win:space,shot:req74-diag-probe-${target}-${hold},k:36,w:1000,win:return,k:36,w:800,win:return2`, opts: { source: JAPANESE_SOURCE, timeout: 60 } }, 240_000);
			probes.push({ target, hold_ms: hold, probe: p?.probe ?? p });
		}
	}
	fact('diag', 'D1 (the control): the same keys in the tool\'s own NSTextView (every NSTextInputClient call the IME made: setMarkedText / insertText / unmarkText) and WKWebView (the page\'s events), with a second Return — does one Return commit there?', { probes });
	await inputSource('restore');
	human('diag', 'D1: the shots req74-diag-d1-space-* / req74-diag-probe-* (does a candidate window show, what is in the line) = 【人】 (the D1 without webdriver is the driver\'s, after this run)', {});
}

/** D2: conversion without the candidate window — Control + K and F7 while composing. */
async function diagD2(): Promise<void> {
	if (!needsReal('diag', 'D2: Control + K / F7')) return;
	const rounds: Array<Record<string, unknown>> = [];
	for (const conv of [
		{ name: 'Control + K (katakana)', item: 'k:40+ctrl' },
		{ name: 'F7 (katakana)', item: `k:${KEY3.f7}` },
	]) {
		await ensureClean(`D2 ${conv.name}`);
		await openMd('ime-diag.md', 'IMEHERE');
		await clickMd('IMEHERE', 'end');
		const pm = await pageMark();
		await imeType('diag', { romaji: 'nihon', convert: false, confirm: false, restore: false });
		const k = await imeKeys('diag', [conv.item], { settleMs: 800 });
		const mid = await pageSince(pm);
		await imeKeys('diag', ['k:36']);
		const seen = await pageSince(pm);
		rounds.push({ conversion: conv.name, key: k?.realinput ?? null, updates_after_key: mid.inputs.slice(-3).map((x) => ({ type: x.type, data: x.data ?? null })), confirmed: compositionEnds(seen.inputs).map((e) => e.data ?? null), paragraph: (await mdDoc())?.blocks.find((b) => b.text.startsWith('IMEHERE'))?.text ?? null });
	}
	fact('diag', 'D2: a conversion that opens no candidate window (Control + K / F7 = katakana) — does the converted text reach the page? (yes = only the candidate window\'s path is blocked)', { rounds });
	await ensureClean('after D2');
	await inputSource('restore');
}

/** D3: the IME's windows (prediction while typing, candidates after Space) against the composed text, at 100 % and 150 %. */
async function diagD3(): Promise<void> {
	if (!needsReal('diag', 'D3: the candidate window\'s place')) return;
	const rounds: Array<Record<string, unknown>> = [];
	for (const zoom of [100, 150]) {
		await ensureClean(`D3 ${zoom} %`);
		await openMd('ime-diag.md', 'IMEHERE');
		await emitMenu('menu_zoom_reset');
		if (zoom === 150) {
			for (let i = 0; i < 5; i++) {
				await emitMenu('menu_zoom_in');
				await browser.pause(150);
			}
		}
		await browser.pause(500);
		await clickMd('IMEHERE', 'end');
		const caret0 = await caretOnScreen();
		const base = await windowNumbers();
		await imeType('diag', { romaji: 'nihongo', convert: false, confirm: false, restore: false });
		const caretTyped = await caretOnScreen();
		const typed = await operator('screen-windows');
		const all = [...(((typed?.windows ?? []) as WinRow[]) ?? []), ...(((typed?.app ?? []) as WinRow[]) ?? [])].filter((w) => !base.includes(w.number ?? -1));
		const sp = await imeKeys('diag', [`k:${KEY2.space}@100`], { settleMs: 1_000, windowsBase: base });
		const caretSpace = await caretOnScreen();
		const newSpace = (sp?.windows ?? []) as WinRow[];
		await imeKeys('diag', ['k:53', 'w:400', 'k:53']);
		const near = (w: WinRow, end: ScreenRect | null) => (caret0 && end ? candidateNear(w, caret0, end) : null);
		rounds.push({
			zoom,
			caret: { before_typing: caret0, after_typing: caretTyped, after_space: caretSpace },
			while_typing: all.map((w) => ({ ...w, candidate: candidateWindows([w]).length > 0, near_caret: near(w, caretTyped) })),
			after_space: newSpace.map((w) => ({ ...w, candidate: candidateWindows([w]).length > 0, near_caret: near(w, caretSpace) })),
		});
	}
	await emitMenu('menu_zoom_reset');
	fact('diag', `D3: the windows new since the start (the app's own included) against the composed text — the tolerance: top within one line + ${CANDIDATE_BELOW_PT} pt under it (or flipped above), left edge within its span ±${CANDIDATE_ACROSS_PT} pt`, { rounds });
	await ensureClean('after D3');
	await inputSource('restore');
}

/** D4: reconversion — a confirmed word selected, the kana key twice (kVK_JIS_Kana = 104). */
async function diagD4(): Promise<void> {
	if (!needsReal('diag', 'D4: reconversion')) return;
	await ensureClean('D4');
	await openMd('ime-diag.md', 'IMEHERE');
	await clickMd('IMEHERE', 'end');
	const pm0 = await pageMark();
	await imeType('diag', { romaji: 'nihon', convert: false, confirm: true, restore: false });
	const confirmed = String(compositionEnds((await pageSince(pm0)).inputs).slice(-1)[0]?.data ?? '');
	const before = (await mdDoc())?.blocks.find((b) => b.text.startsWith('IMEHERE'))?.text ?? null;
	const n = Math.max(confirmed.length, 1);
	await imeKeys('diag', Array.from({ length: n }, () => 'k:123+shift'), { settleMs: 400 });
	const sel = (await mdSel()).text;
	const base = await windowNumbers();
	const pm = await pageMark();
	const k = await imeKeys('diag', [`k:${KEY3.kana}`, 'w:150', `k:${KEY3.kana}`], { settleMs: 1_200, windowsBase: base });
	const mid = await pageSince(pm);
	await imeKeys('diag', ['k:53', 'w:400', 'k:53']);
	const after = (await mdDoc())?.blocks.find((b) => b.text.startsWith('IMEHERE'))?.text ?? null;
	fact('diag', 'D4: reconversion with the kana key twice on a confirmed, selected word — a compositionstart with that word = it reached the page; Escape gives the word back', { confirmed, selected: sel, before, keys: k?.realinput ?? null, new_windows: k?.windows ?? null, page: { keys: mid.keys.map((x) => ({ key: x.key, keyCode: x.keyCode ?? null })), inputs: mid.inputs.map((x) => ({ type: x.type, data: x.data ?? null })) }, after, unchanged_after_escape: after === before });
	await ensureClean('after D4');
	await inputSource('restore');
}

/** D5: drags — three ways of sending, on the face and in the tool's own WKWebView. */
async function diagD5(): Promise<void> {
	if (!needsReal('diag', 'D5: the drags')) return;
	const face: Array<Record<string, unknown>> = [];
	for (const v of DRAG_VARIANTS) {
		await ensureClean(`D5 (${v.name})`);
		await openMd('ai-report.md', 'Weekly report');
		await installDragHooks();
		face.push({ variant: v.name, ...(await dragQuick(v.o)) });
	}
	const own: Array<Record<string, unknown>> = [];
	for (const v of DRAG_VARIANTS) {
		const opts: Record<string, unknown> = { hold: 500, steps: 30, step: 30 };
		if (v.o.src) opts.src = v.o.src;
		if (v.o.delta) opts.delta = 1;
		if (v.o.pressure) opts.pressure = 1;
		if (v.o.hover_ms) opts.hover = v.o.hover_ms;
		const p = await operator('probe', { kind: 'drag', opts }, 240_000);
		own.push({ variant: v.name, probe: p?.probe ?? p });
	}
	fact('diag', 'D5: the drag of a selected word, three ways of sending — on the face (dragstart? moved?) and in the tool\'s own WKWebView (the control)', { face, own });
	await ensureClean('after D5');
}

/** D6: Command + B with the keyboard type ANSI / JIS under ABC and Japanese. */
async function diagD6(): Promise<void> {
	if (!needsReal('diag', 'D6: the keyboard types')) return;
	const kb = (await operator('kbtypes')) ?? {};
	const list = await inputSource('list');
	const sources = ((list?.result as { sources?: Array<{ id: string; type: string }> } | undefined)?.sources ?? []).map((s) => s.id);
	const rounds: Array<Record<string, unknown>> = [];
	for (const src of ['com.apple.keylayout.ABC', JAPANESE_SOURCE].filter((s) => sources.includes(s))) {
		await inputSource('set', src);
		for (const t of [
			{ name: 'ANSI', id: kb.ansi as number | undefined },
			{ name: 'JIS', id: kb.jis as number | undefined },
		]) {
			if (typeof t.id !== 'number') continue;
			await ensureClean(`D6 ${src} ${t.name}`);
			await openMd('ai-report.md', 'Weekly report');
			await clickMd('brown', 'mid', { kind: 'dblclick' });
			const pm = await pageMark();
			const a = await operator('key', { keycode: KEY2.b, mods: ['cmd'], route: 'hid', kbtype: t.id }, 240_000);
			await browser.pause(600);
			rounds.push({ source: src, kbtype: t, sent: a?.sent ?? null, bold: await marked('strong', 'brown'), keys: (await pageSince(pm)).keys.map((k) => ({ key: k.key, keyCode: k.keyCode ?? null, meta: k.meta })) });
		}
	}
	fact('diag', 'D6: Command + B with the event\'s keyboard type ANSI / JIS under ABC and Japanese — bold each time = B.5 can rely on kbtype', { kbtypes: kb, rounds });
	await ensureClean('after D6');
	await inputSource('restore');
}

// --- the short B.5 heading diagnosis (stage diag-b5; 由谷の決定 2026-11-20 21:40 (2)) ----------------------------
// The 2026-11-20 run: Option + Command + 1〜6 / 0 sent on the HID route (kbtype ANSI / JIS × ABC / Japanese) made no heading
// and changed nothing, while Command + K on the same route and Option + Command + U / F on the pid route (earlier runs)
// worked. This tells the cases apart: the menu item itself (AX), the pid route, the HID route — with every keydown the
// page saw (key, code, keyCode, altKey, metaKey; whether it was prevented) — and, apart, the kana key's reconversion at
// the JIS keyboard type. Facts only: no judge.

/** Every keydown the page sees, fully: at the capture start and at the bubble end (prevented? stopped before window?). */
async function installKeyProbe(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __gate74b5?: Array<Record<string, unknown>> };
		if (w.__gate74b5) return;
		const log: Array<Record<string, unknown>> = [];
		w.__gate74b5 = log;
		window.addEventListener('keydown', (e) => {
			const k = e as KeyboardEvent;
			const t = k.target as Element | null;
			log.push({ phase: 'capture', at: Date.now(), key: k.key, code: k.code, keyCode: k.keyCode, altKey: k.altKey, metaKey: k.metaKey, ctrlKey: k.ctrlKey, shiftKey: k.shiftKey, isComposing: k.isComposing, target: t ? `${t.tagName.toLowerCase()}${typeof t.className === 'string' && t.className ? `.${t.className.split(' ')[0]}` : ''}` : null });
		}, true);
		window.addEventListener('keydown', (e) => log.push({ phase: 'bubble', at: Date.now(), key: (e as KeyboardEvent).key, defaultPrevented: e.defaultPrevented }), false);
	});
}
async function keyProbeMark(): Promise<number> {
	return browser.execute(() => (window as unknown as { __gate74b5?: unknown[] }).__gate74b5?.length ?? 0);
}
async function keyProbeSince(mark: number): Promise<Array<Record<string, unknown>>> {
	return browser.execute((m) => ((window as unknown as { __gate74b5?: Array<Record<string, unknown>> }).__gate74b5 ?? []).slice(m), mark);
}

/** diag-b5 (1)〜(4): Format ▸ Heading 2 / Body Text by AX; Option + Command + 2 / 0 / 1 on the pid route and on the HID route. */
async function diagB5Headings(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	if (!needsReal('diag-b5', 'the heading shortcuts')) return;
	await installKeyProbe();
	const kb = (await operator('kbtypes')) ?? {};
	const ansi = typeof kb.ansi === 'number' ? kb.ansi : 46;
	const block = async () => {
		const b = (await mdDoc())?.blocks.find((x) => x.text.startsWith('Third paragraph')) ?? null;
		return b ? (b.type === 'heading' ? `heading ${b.level ?? '?'}` : b.type) : null;
	};
	const place = async (why: string) => {
		await ensureClean(`diag-b5: ${why}`);
		await openMd('ai-report.md', 'Weekly report');
		await installKeyProbe();
		const c = await clickMd('Third paragraph', 3);
		return { click_seen: c, block: await block() };
	};
	const rows: Array<Record<string, unknown>> = [];
	// (1) the menu item itself: Format ▸ Heading 2, then Format ▸ Body Text (AX).
	const p1 = await place('the menu by AX');
	const pm1 = await pageMark();
	const ax2 = await operator('press-menu', { menu: 'Format', item: 'Heading 2' });
	await browser.pause(600);
	const afterAx2 = await block();
	const ax0 = await operator('press-menu', { menu: 'Format', item: 'Body Text' });
	await browser.pause(600);
	rows.push({ via: 'AX: Format ▸ Heading 2, then Format ▸ Body Text', start: p1, after_heading_2: afterAx2, after_body_text: await block(), press: [ax2, ax0], inputs: (await pageSince(pm1)).inputs.map((x) => ({ type: x.type, data: x.data ?? null })) });
	// (2)〜(4) Option + Command + 2, 0, 1 — the pid route (CGEventPostToPid), then the HID route at the ANSI keyboard type.
	for (const route of ['pid', 'hid'] as const) {
		const start = await place(`the ${route} route`);
		for (const n of [2, 0, 1]) {
			const km = await keyProbeMark();
			const pm = await pageMark();
			const a = await operator('key', { keycode: DIGIT_KEYS[n], mods: ['cmd', 'opt'], route, ...(route === 'hid' ? { kbtype: ansi } : {}) }, 240_000);
			await browser.pause(700);
			rows.push({
				via: `Option + Command + ${n} (${route === 'pid' ? 'pid route = CGEventPostToPid' : `HID route, kbtype ${ansi}`})`,
				start: n === 2 ? start : undefined,
				expected: n === 0 ? 'paragraph' : `heading ${n}`,
				block_after: await block(),
				sent: a?.sent ?? null,
				realinput: (a?.realinput as Record<string, unknown> | undefined) ? { route: (a?.realinput as Record<string, unknown>).route, options: (a?.realinput as Record<string, unknown>).options } : null,
				keydowns: await keyProbeSince(km),
				inputs: (await pageSince(pm)).inputs.map((x) => ({ type: x.type, data: x.data ?? null })),
			});
		}
	}
	// A control on the HID route: Option + Command + U (View ▸ Raw Source — a menu item of a letter) and back by AX.
	const pc = await place('the HID control');
	const kc = await keyProbeMark();
	const u = await operator('key', { keycode: KEY2.u, mods: ['cmd', 'opt'], route: 'hid', kbtype: ansi }, 240_000);
	await browser.pause(900);
	const rawShown = await exists(RAW);
	rows.push({ via: `control: Option + Command + U (Raw Source) on the HID route, kbtype ${ansi}`, start: pc, raw_shown: rawShown, sent: u?.sent ?? null, keydowns: await keyProbeSince(kc) });
	if (rawShown) {
		await operator('press-menu', { menu: 'View', item: 'Raw Source' });
		await browser.pause(600);
	}
	const textNow = await mdText();
	fact('diag-b5', 'B.5 headings: the menu item by AX, Option + Command + 2 / 0 / 1 on the pid route and the HID route (ANSI), and a HID control (Option + Command + U) — the block after each and every keydown the page saw (no judge: 由谷の決定 2026-11-20 21:40 (2))', { kbtypes: { ansi: kb.ansi ?? null, jis: kb.jis ?? null, current: kb.current ?? null }, rows, text_has_option_chars: /[¡™£¢∞§¶º]/.test(textNow) });
	await ensureClean('after diag-b5 headings');
}

/** diag-b5 (5): the kana key (104) twice at the JIS keyboard type on a confirmed, selected katakana word (Control + K). */
async function diagB5Reconvert(): Promise<void> {
	await openMd('ime-diag.md', 'IMEHERE');
	if (!needsReal('diag-b5', 'the kana key reconversion')) return;
	await installKeyProbe();
	const original = readBytes('ime-diag.md');
	const kb = (await operator('kbtypes')) ?? {};
	const jis = typeof kb.jis === 'number' ? kb.jis : 48;
	await clickMd('IMEHERE', 'end');
	const pm0 = await pageMark();
	await imeType('diag-b5', { romaji: 'nihon', convert: false, confirm: false, restore: false });
	await imeKeys('diag-b5', ['k:40+ctrl'], { settleMs: 600 });
	await imeKeys('diag-b5', ['k:36'], { settleMs: 800 });
	const word = String(compositionEnds((await pageSince(pm0)).inputs).slice(-1)[0]?.data ?? '');
	const out: Record<string, unknown> = { kbtype_jis: jis, word };
	if (!word) {
		out.note = 'no word was confirmed (Control + K + Return); the reconversion is not tried';
	} else {
		await imeKeys('diag-b5', Array.from({ length: word.length }, () => 'k:123+shift'), { settleMs: 400 });
		out.selected = (await mdSel()).text;
		const before = await mdText();
		const base = await windowNumbers();
		const km = await keyProbeMark();
		const pm = await pageMark();
		const k = await imeKeys('diag-b5', [`k:${KEY3.kana}`, 'w:150', `k:${KEY3.kana}`], { kbtype: jis, settleMs: 1_200, windowsBase: base });
		const mid = await pageSince(pm);
		const starts = compositionStarts(mid.inputs);
		out.keys_sent = k?.realinput ?? null;
		out.keydowns = await keyProbeSince(km);
		out.compositionstart = starts.map((x) => x.data ?? null);
		out.updates = mid.inputs.filter((x) => x.type === 'compositionupdate').map((x) => x.data ?? null);
		out.new_windows = k?.windows ?? null;
		out.candidate_windows = candidateWindows(k?.windows);
		await imeKeys('diag-b5', ['k:53', 'w:400', 'k:53']);
		out.unchanged_after_escape = (await mdText()) === before;
	}
	fact('diag-b5', 'B.5 / D4 again: the kana key twice at the JIS keyboard type on a confirmed, selected katakana word (Control + K) — compositionstart, its data, the new windows (no judge)', out);
	await ensureClean('after diag-b5 reconversion');
	if (readBytes('ime-diag.md') !== original) await restoreMd('ime-diag.md', original, 'IMEHERE');
	await inputSource('restore');
}

// --- gate 1 after the diagnosis (由谷の決定 2026-11-20 (1): added since D1 found the conversion reaches the page) ---------
// The range (オーケストレーター 2026-11-20): one place converted with Space and confirmed, the reconversion, the candidate
// window's place. The 9 places × confirm / cancel stay with Issue #824.

const hasKanji = (t: string) => /[\u3400-\u9fff]/.test(t);
/**
 * An environment row that does NOT end the it nor block the later real input (照合 2026-11-20 P3: environment() throws and
 * sets realInputBlocked, so one missing conversion stopped every later it of the run).
 */
function environmentRow(gate: number | string, item: string, extra: Record<string, unknown> = {}): void {
	report(REPORT, { gate: 'environment', side: VARIANT, of: gate, item, reason: item, ...extra });
}

/**
 * After the typing, wait for the IME's prediction window (a window of the app itself above the normal level: the
 * 2026-11-20 diag saw vellis-gate74's layer-20 window) — up to 2.5 s, and 1.5 s at least when it does not come.
 * 2026-11-20: Space sent 659 ms after the last key came before that window and did not convert; 718〜751 ms with the
 * window up converted (the gate 1 rows of gate-out-1120 out-gate1 / out-full-5aa3443 vs the diag D1 rounds).
 */
async function waitForPrediction(base: number[]): Promise<{ waited_ms: number; window: WinRow | null }> {
	const t0 = Date.now();
	let found: WinRow | null = null;
	while (Date.now() - t0 < 2_500) {
		const a = await operator('screen-windows');
		const rows = [...((a?.windows ?? []) as WinRow[]), ...((a?.app ?? []) as WinRow[])].filter((w) => !base.includes(w.number ?? -1));
		found = candidateWindows(rows)[0] ?? null;
		if (found) break;
		await browser.pause(300);
	}
	const elapsed = Date.now() - t0;
	if (!found && elapsed < 1_500) await browser.pause(1_500 - elapsed);
	return { waited_ms: Date.now() - t0, window: found };
}
/** "nihon" through the IME, the prediction window waited for, then Space (held 100 ms). */
async function typeThenSpace(gate: number | string): Promise<{ waited_ms: number; window: WinRow | null }> {
	const base = await windowNumbers();
	await imeType(gate, { romaji: 'nihon', convert: false, confirm: false, restore: false });
	const wait = await waitForPrediction(base);
	await imeKeys(gate, [`k:${KEY2.space}@100`], { settleMs: 600 });
	return wait;
}

/** Gate 1 (B.1): "nihon" + Space converts at the end of a paragraph and Return confirms it — once, in place; the save. */
async function gateImeConvert(): Promise<void> {
	await openMd('ai-report.md', 'Weekly report');
	if (!needsReal(1, 'the conversion with Space')) return;
	const original = readBytes('ai-report.md');
	const before = await mdText();
	const blocks0 = (await mdDoc())?.blocks.length ?? 0;
	if (!(await clickMd('plain words only here.', 'end'))) environment(1, 'gate 1 (conversion): the click at the end of "…only here." was not seen by the page');
	const pm = await pageMark();
	const wait = await typeThenSpace(1);
	const afterSpace = await pageSince(pm);
	const ups = afterSpace.inputs.filter((x) => x.type === 'compositionupdate').map((x) => String(x.data ?? ''));
	const converted = ups.length > 0 && hasKanji(ups[ups.length - 1]!);
	if (!converted) {
		await imeKeys(1, ['k:53', 'w:400', 'k:53']);
		environmentRow(1, 'gate 1 (B.1 conversion): no converted text reached the page after Space (the 2026-11-20 diag D1 saw "日本" arrive) — not judged', { updates: ups, page: afterSpace, wait });
		await ensureClean('gate 1 (conversion): not converted');
		if (readBytes('ai-report.md') !== original) await restoreMd('ai-report.md', original, 'Weekly report');
		await inputSource('restore');
		return;
	}
	// ONE Return is what 由谷 confirmed by hand (照合 2026-11-20 P2): a second Return is sent only to see what it does, and a
	// conversion that needed it is not judged — whether the first missed by the machine or by the product is told by D1's
	// control (the tool's own NSTextView / WKWebView).
	await imeKeys(1, ['k:36'], { settleMs: 1_000 });
	const endsAfterFirst = compositionEnds((await pageSince(pm)).inputs).length;
	const docAfterFirst = await mdDoc();
	if (endsAfterFirst === 0) await imeKeys(1, ['k:36'], { settleMs: 1_000 });
	const returns = endsAfterFirst > 0 ? 1 : 2;
	const seen = await pageSince(pm);
	const ends = compositionEnds(seen.inputs);
	const confirmed = String(ends[ends.length - 1]?.data ?? '');
	const doc = await mdDoc();
	const text = doc?.text ?? '';
	const checks = {
		one_compositionend: ends.length === 1,
		converted_word: hasKanji(confirmed),
		once: countOf(text, confirmed) === countOf(before, confirmed) + 1,
		in_place: (doc?.blocks ?? []).some((b) => b.text.includes(`only here.${confirmed}`)),
		no_block_added: (doc?.blocks.length ?? 0) === blocks0,
	};
	const ok = Object.values(checks).every(Boolean);
	const detail = { converted: ups[ups.length - 1], confirmed, returns, checks, wait, ends: ends.map((e) => e.data ?? null), blocks: { before: blocks0, after: doc?.blocks.length ?? 0 }, line: (doc?.blocks ?? []).find((b) => b.text.includes('only here.'))?.text ?? null, line_after_first_return: (docAfterFirst?.blocks ?? []).find((b) => b.text.includes('only here.'))?.text ?? null, keys: seen.keys.map((k) => ({ key: k.key, keyCode: k.keyCode ?? null, isComposing: k.isComposing ?? null })) };
	if (returns === 1) {
		judge(1, `gate 1 (B.1): at the end of "…only here." "nihon" + Space converts (${JSON.stringify(ups[ups.length - 1])}) and one Return confirms it — one compositionend with the converted word, the word once and in place, no block added`, ok, detail);
	} else {
		environmentRow(1, 'gate 1 (B.1 conversion): the first Return did not confirm the conversion (no compositionend after it) — not judged; whether the machine or the product missed is told by the diag D1\'s control (the tool\'s own NSTextView / WKWebView)', detail);
		fact(1, `gate 1 (B.1 conversion): after a second Return — ${ends.length === 0 ? 'still not confirmed' : `confirmed ${JSON.stringify(confirmed)}`}; the checks: ${JSON.stringify(checks)}`, detail);
	}
	if (ends.length === 0) await imeKeys(1, ['k:53', 'w:400', 'k:53']);
	if (ok) {
		await realSave();
		const d = changedLines(original, readBytes('ai-report.md'));
		const savedOk = !!d && d.a.length === 1 && d.b.length === 1 && d.b[0] === d.a[0]!.replace('only here.', `only here.${confirmed}`);
		if (returns === 1) judge(1, 'gate 1 (B.1): a real Command + S writes the converted word right after "only here." on that line and changes nothing else', savedOk, { diff: d });
		else fact(1, `gate 1 (B.1 conversion, two Returns): the save ${savedOk ? 'writes the word on that line only' : 'differs elsewhere too'}`, { diff: d });
		await restoreMd('ai-report.md', original, 'Weekly report');
	}
	await ensureClean('after gate 1 convert');
	if (readBytes('ai-report.md') !== original) await restoreMd('ai-report.md', original, 'Weekly report');
	await inputSource('restore');
}

/** Gate 1 (B.1): the kana key twice on a confirmed, selected word reconverts it; Escape gives it back. Not reached = environment. */
async function gateImeReconvert(): Promise<void> {
	await openMd('ime-diag.md', 'IMEHERE');
	if (!needsReal(1, 'the reconversion')) return;
	const original = readBytes('ime-diag.md');
	await clickMd('IMEHERE', 'end');
	const pm0 = await pageMark();
	const wait = await typeThenSpace(1);
	await imeKeys(1, ['k:36'], { settleMs: 1_000 });
	if (compositionEnds((await pageSince(pm0)).inputs).length === 0) await imeKeys(1, ['k:36'], { settleMs: 1_000 });
	const word = String(compositionEnds((await pageSince(pm0)).inputs).slice(-1)[0]?.data ?? '');
	const cleanUp = async (why: string) => {
		await ensureClean(why);
		if (readBytes('ime-diag.md') !== original) await restoreMd('ime-diag.md', original, 'IMEHERE');
		await inputSource('restore');
	};
	if (!hasKanji(word)) {
		await imeKeys(1, ['k:53', 'w:400', 'k:53']);
		environmentRow(1, 'gate 1 (B.1 reconversion): no converted word was confirmed to reconvert (see "gate 1 (B.1 conversion)") — not judged', { word, wait });
		await cleanUp('gate 1 (reconversion): no word');
		return;
	}
	const before = await mdText();
	await imeKeys(1, Array.from({ length: word.length }, () => 'k:123+shift'), { settleMs: 400 });
	const sel = (await mdSel()).text;
	if (sel !== word) {
		environmentRow(1, `gate 1 (B.1 reconversion): Shift + ← × ${word.length} did not select the confirmed word (${JSON.stringify(sel)}) — not judged`, { word, sel });
		await cleanUp('gate 1 (reconversion): the selection');
		return;
	}
	const base = await windowNumbers();
	const pm = await pageMark();
	const k = await imeKeys(1, [`k:${KEY3.kana}`, 'w:150', `k:${KEY3.kana}`], { settleMs: 1_200, windowsBase: base });
	const mid = await pageSince(pm);
	const starts = compositionStarts(mid.inputs);
	const firstUpdate = String(mid.inputs.find((x) => x.type === 'compositionupdate')?.data ?? '');
	if (starts.length === 0) {
		environmentRow(1, 'gate 1 (B.1 reconversion): the kana key twice did not start a reconversion on the page (no compositionstart) — not judged (the diag D4 tells why)', { keys: k?.realinput ?? null, page: { keys: mid.keys.map((x) => ({ key: x.key, keyCode: x.keyCode ?? null })), inputs: mid.inputs.map((x) => ({ type: x.type, data: x.data ?? null })) } });
	} else {
		await imeKeys(1, ['k:53', 'w:400', 'k:53']);
		const after = await mdText();
		judge(1, 'gate 1 (B.1): the kana key twice on a confirmed, selected word reconverts that word (the composition starts from it); Escape gives it back — the document as before', (String(starts[0]!.data ?? '') === word || firstUpdate === word) && after === before, { word, compositionstart: starts[0]!.data ?? null, first_update: firstUpdate, candidates: candidateWindows(k?.windows), same_after_escape: after === before });
	}
	await cleanUp('after the reconversion');
}

/** Gate 1 (B.1): the candidate window under the composed text (one line + 40 pt, ±40 pt across) at 100 % / 150 %. None = environment. */
async function gateImeCandidateWindow(): Promise<void> {
	await openMd('ime-diag.md', 'IMEHERE');
	if (!needsReal(1, 'the candidate window')) return;
	for (const zoom of [100, 150]) {
		await ensureClean(`gate 1 candidates ${zoom} %`);
		await openMd('ime-diag.md', 'IMEHERE');
		await emitMenu('menu_zoom_reset');
		if (zoom === 150) {
			for (let i = 0; i < 5; i++) {
				await emitMenu('menu_zoom_in');
				await browser.pause(150);
			}
		}
		await browser.pause(500);
		await clickMd('IMEHERE', 'end');
		const caret0 = await caretOnScreen();
		const base = await windowNumbers();
		await imeType(1, { romaji: 'nihon', convert: false, confirm: false, restore: false });
		const sp = await imeKeys(1, [`k:${KEY2.space}@100`], { settleMs: 1_000, windowsBase: base });
		const caret1 = await caretOnScreen();
		const cands = candidateWindows(sp?.windows);
		await imeKeys(1, ['k:53', 'w:400', 'k:53']);
		if (cands.length === 0 || !caret0 || !caret1) {
			report(REPORT, { gate: 'environment', side: VARIANT, item: `gate 1 (B.1 candidate window, ${zoom} %): no candidate window showed after Space (neither the app's own window above the normal level nor an input method's) or no caret — not judged (the diag D3 tells why)`, reason: 'no candidate window', windows: sp?.windows ?? null, caret: { start: caret0, end: caret1 } });
			continue;
		}
		judge(1, `gate 1 (B.1): at ${zoom} % the candidate window's top is within one line + ${CANDIDATE_BELOW_PT} pt under the composed text (or flipped above) and its left edge within the text's span ±${CANDIDATE_ACROSS_PT} pt`, cands.some((w) => candidateNear(w, caret0, caret1)), { caret: { start: caret0, end: caret1 }, candidates: cands });
	}
	await emitMenu('menu_zoom_reset');
	await ensureClean('after the candidate window');
	await inputSource('restore');
}

/** What stays with a person for stages 2〜4 (counted in the report; the steps are in docs/req74-stage24-device.md B). */
function humanOnly(): void {
	human(1, 'gate 1: the Japanese IME per block (paragraph / heading / list / task / quote / table cell / empty block / the edge of a mark / line start and end) × confirm / cancel = 【人】 (B.1 前半: 由谷 tried it by hand 2026-11-20, all OK; the machine version = Issue #824). One conversion with Space, the reconversion and the candidate window = "gate 1 (B.1 conversion / reconversion / candidate window)"; Format and a write from outside during a conversion = "gate 1・16-3・16-4 (B.1-2・3)"', {});
	human(2, 'gate 2: the WYSIWYG feel — the caret anywhere, selecting / deleting / pasting across blocks = 【人】 (the mechanics are judged above)', {});
	human(13, 'gate 13: the decisions (a)(f)〜(u)(w)(x)(y)〜(ad)・(ae)〜(as) on the device = 【人】 (B.7)', {});
	human(16, '16-6: multi-cursor — not built (4-11); nothing to try', {});
}

describe('Requirement #74 stages 1〜4 human gates, the machine part — the dev-features build after the removal round (the CodeMirror / ProseMirror faces are the view; no editing flag)', function () {
	this.timeout(900_000);
	let pid = 0;

	before(async function () {
		if (!DEVICE) this.skip();
		for (const [name, value] of Object.entries({ VELLIS_GATE_BIN: bin, VELLIS_GATE_AXTOOL: axtool, VELLIS_GATE_REALINPUT: realinput, VELLIS_E2E_INITIAL_ROOT: root })) {
			if (!value) throw new Error(`${name} is not set`);
		}
		const needed = [...(STAGES.has(1) ? [...FILES.map((x) => x.rel), 'app.log', 'big.ts', 'notes.md'] : []), ...([2, 3, 4].some((n) => STAGES.has(n)) || DIAG || DIAG_B5 ? [...MD_FILES, 'app.ts', 'notes.txt', 'crlf.txt', 'app.log', 'run.sh', 'tool.py', 'settings.json'] : []), ...(DIAG || DIAG_B5 || STAGES.has(2) ? ['ime-diag.md'] : []), ...(STAGES.has(3) ? ['nav.html', 'nav-other.html', 'nav.pdf'] : [])];
		for (const f of needed) {
			if (!fs.existsSync(fileOf(f))) throw new Error(`fixture ${f} is missing in ${root} (req74-fixtures.sh)`);
		}
		if (tmpLeftovers().length !== 0) throw new Error(`the root already holds ${JSON.stringify(tmpLeftovers())}`);
		fs.mkdirSync(SHOTS_DIR, { recursive: true });
		fs.rmSync(OP_DIR, { recursive: true, force: true });
		await waitForAppMounted();
		await installGateRecorder();
		await setIpcCapture(['save_document', 'open_document']);
		await installHooks();
		pid = appPid();
		await waitForExplorerRow(uriOf('app.ts'), { timeout: 30_000, nudgeDir: root, nudgePrefix: 'req74-root' });
		report(REPORT, { gate: 'setup', side: VARIANT, operator: OPERATOR, pid, bin, root, stages: [...STAGES], snapshots_before: snapshotCount(), idle: (await operator('idle')) ?? null });
		await calibrate(pid);
	});

	beforeEach(async function () {
		if (!DEVICE) return;
		fails = [];
		realInputBlocked = calibrationBlocked;
		const closed = await closeOverlays();
		if (closed.length > 0) report(REPORT, { gate: 'reset', side: VARIANT, when: `before: ${this.currentTest?.title ?? '?'}`, closed });
	});
	afterEach(async function () {
		if (!DEVICE) return;
		if (this.currentTest?.state === 'failed') {
			report(REPORT, { gate: 'failed', side: VARIANT, test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
		}
		await closeOverlays().catch(() => undefined);
	});
	after(async function () {
		if (!DEVICE) return;
		try {
			if (pasteboardSaved) await operator('pasteboard', { op: 'restore' }).catch(() => null);
			report(REPORT, { gate: 'teardown', side: VARIANT, tmp_leftovers: tmpLeftovers(), snapshots_after: snapshotCount(), page_dialogs: (await readGateRecord()).dialogs });
			await restoreGateRecorder();
		} finally {
			await operator('done', {}, 60_000).catch(() => null);
		}
	});

	itStage(1, 'gate 11: every code / plain fixture opens straight into the CodeMirror face; line numbers and data-vellis-lang only for code (settings.json = json)', async () => {
		await gateFaces();
	});

	itStage(1, 'gate 11 / 9: real typing on app.ts — the caret, the Unsaved badge, Return keeps the indent, Tab / Shift + Tab, `(` alone; undo / redo by real keys and by Edit ▸ Undo / Redo (AX)', async () => {
		await gateTyping();
	});

	itStage(1, 'gate 11: a real Command + S on crlf.txt keeps every \\r\\n and changes only the touched line; the snapshot is taken; the own echo changes nothing', async () => {
		await gateCrlfSave();
	});

	itStage(1, 'gate 14: View ▸ Appearance ▸ Dark / Light (AX) recolours the face and keeps the document; the plain-text column equals the Markdown measure, Toggle Full Width widens it, code is not capped', async () => {
		await gateTheme();
	});

	itStage(1, 'gate 15: a real Command + R on a dirty face asks once; Cancel keeps the edit; Don’t Save reloads; a clean face asks nothing', async () => {
		await gateReload();
	});

	itStage(1, 'gate 6: writes from outside — silent take-in, the merge (Command + Z keeps the external part), the conflict banner, the real save refused by the hash check (AC-74-16), Keep My Edits / Use the File on Disk, the removed file written back', async () => {
		await gateExternal();
	});

	itStage(1, 'gate 8: Find counts the whole document, Zoom scales the font-size (a real click still lands), beforeprint builds the print rendering from the face, copy / paste carry \\r\\n', async () => {
		await gateViewing();
	});

	itStage(1, 'gate 10: a 5 MB log and a 50,000-line file — time to the face, a real keystroke, Command + ↓, the find count (recorded; the feel = 【人】)', async () => {
		await gateLarge();
	});

	// --- stage 2 (the ProseMirror face of Markdown) ---
	itStage(2, 'gate 2 / 5 / 7: ai-report.md opens into the ProseMirror face — no Markdown symbols, front matter / raw HTML / mermaid not typed into, real clicks and a double-click change nothing, mermaid shows its source under the cursor', async () => {
		await gateMdFace();
	});

	itStage(2, 'gate 2 / 3 / 9: a selection across blocks and Backspace, a paste as text (+ 12-10 Paste as Markdown), Format ▸ Bold / Italic (AX) and Command + B / I on a word, an empty selection, two blocks', async () => {
		await gateMdEditing();
	});

	itStage(2, 'gate 4: a save keeps every byte outside the touched block (a paragraph, a bold word, a table cell, a CRLF file)', async () => {
		await gateMdBytes();
	});

	itStage(2, 'gate 6 / 16-1: writes from outside on the Markdown face — silent take-in, the merge, the conflict banner and its diff (Keep / Use the File on Disk), the refused save, the line-ending mark', async () => {
		await gateMdExternal();
	});

	itStage(2, 'gate 7: a footnote click scrolls, a link click opens (Option + click does not), View ▸ Raw Source and Option + Command + U with the caret kept, one Command + Z undoes the raw edit', async () => {
		await gateMdNavRaw();
	});

	itStage(2, 'gate 8: Find counts the visible text, a real click at 150 % lands, File ▸ Print… to PDF holds the unsaved edit and no symbols, Command + C carries the visible text', async () => {
		await gateMdViewing();
	});

	itStage(2, 'gate 9: undo / redo on the Markdown face by real keys and Edit ▸ Undo / Redo (AX)', async () => {
		await gateMdUndo();
	});

	itStage(2, 'gate 10: a 1.5 MB Markdown (time to the face, a keystroke, Find) and a 2.5 MB one (the too-large notice)', async () => {
		await gateMdLarge();
	});

	// --- stage 3 ---
	itStage(3, 'gate 12-1: the input rules by real keys; Command + Z / Edit ▸ Undo / Backspace right after give the symbols back; the second undo is ordinary', async () => {
		await gateInputRules();
	});

	itStage(3, 'gate 12-3 / 12-4: Format ▸ Table (AX; the header row = 3-7 alt 2), the cell keys, a two-line paste into a cell, the save stays inside the table', async () => {
		await gateTables();
	});

	itStage(3, 'gate 12-5: the editor’s native right-click menu — the items, Format ▸ Bold on the word, the check, Paste, Table ▸, Option + right-click, the position at 100 % / 150 %, Pin / Unpin, Reload File, the code face and raw', async () => {
		await gateContextMenu();
	});

	itStage(3, 'gate 12-6 / 12-7: Find and Replace (Option + Command + F) on the code face with CRLF and a 5 MB log; Option + ↑ / ↓ and Command + / in four languages', async () => {
		await gateReplaceAndLines();
	});

	itStage(3, 'gate 12-8: the gap cursor before a leading table, between raw HTML blocks, after a trailing fence, never before front matter', async () => {
		await gateGapCursor();
	});

	itStage(3, 'gate 12-8 diag: the IME cancel at the gap before a leading table, with every transaction and DOM event recorded', async () => {
		await gateGapImeDiag();
	});

	itStage(3, 'gate 12-9: a real drag of a selected word inside the face moves it', async () => {
		await gateDrag();
	});

	// --- stage 4 ---
	itStage(4, 'gate 16-2: the unsaved diff from the Unsaved badge on the Markdown face and the code face; Esc closes it', async () => {
		await gateUnsavedDiff();
	});

	itStage(4, 'gate 16-3: the formatting toolbar — View ▸ Show Formatting Toolbar, the "A", only on Markdown, the pressed state, the selection kept on a real click, the paragraph-style select opens on WebKit', async () => {
		await gateFormatToolbar();
	});

	itStage(4, 'gate 16-4: the selection bar above a mouse / keyboard selection, gone on a collapse / Esc, at 150 %', async () => {
		await gateSelectionBar();
	});

	itStage(4, 'gate 16-5: one list item rewritten — bold, an added item, a removed item change those lines only', async () => {
		await gateListItems();
	});

	itStage(4, 'the link editor (4-5): Command + K on a word, Done, Command + K inside the link, Remove Link, Format ▸ Link… and Esc', async () => {
		await gateLinkEditor();
	});

	// --- 2026-11-20: rows a person had that a machine drives (由谷の決定 (1); docs/req74-stage24-device.md A「2026-11-20」) ---
	itStage(2, 'gate 2 / 5・11・7 (leftover marks, 青い枠): no frame around the editing faces — no outline / box-shadow / border box on the Markdown face, its hugging ancestors and editable parts (unfocused, focused, a real click, 150 %, Dark), none in the shot\'s edges; the code / plain-text face and raw the same', async () => {
		await gateLeftoverFrames();
	});

	itStage(3, 'gate 12-2 (B.1-4): the input rules with the Japanese IME on — nothing while composing; once after confirming half-width ##・**x**・`y` (and the closing ` on its own); nothing for full width or a cancel', async () => {
		await gateImeInputRules();
	});

	itStage(3, 'B.5 (gate 3・12-7・link): Command + B / I / K, Option + Command + 0〜6, Option + ↑ / ↓, Command + / under each enabled input source (ABC, Japanese) × keyboard type (ANSI, JIS)', async () => {
		await gateKeyboards();
	});

	itStage(3, 'B.6 (12-9): the page\'s drop of text / HTML enters as characters; a word dragged inside the face (three ways of sending, judged where WebKit starts the drag); Safari\'s types / plain text / a file dropped from the tool\'s own window', async () => {
		await gateDragDrop();
	});

	itStage(3, 'B.6 nav (drops): a file dropped from the tool\'s own window on the HTML frame and on the PDF frame leaves the window on the app\'s page (URL, the frame\'s content, the badge); the net\'s "navigation refused" lines as a fact', async () => {
		await gateNavDrops();
	});

	itStage(3, 'B.6 nav (views): under the net the HTML frame gets and draws its document, the PDF frame is there with its pages; a real click on the preview\'s relative / outside link leaves the window on the app\'s page', async () => {
		await gateNavViews();
	});

	itStage(3, '12-8 (P): the gap cursor before a leading table, shot for the eye', async () => {
		await gateGapShot();
	});

	itStage(4, 'gate 1・16-3・16-4 (B.1-2・3): a conversion left open — Format ▸ Bold (AX), Command + B, the toolbar\'s Bold by a real click: bold once after the confirm, the conversion intact; a write from outside held until the confirm; no selection bar while composing', async () => {
		await gateImeComposing();
	});

	itStage(4, '16-3 (P): the formatting toolbar at 150 %, with Toggle Full Width, in Dark (shots for the eye)', async () => {
		await gateToolbarShots();
	});

	// --- the diagnosis D1〜D6 (stage diag; VELLIS_GATE_REQ74_STAGE=diag) ---
	itDiag('diag D1: conversion with Space — the gate\'s Vellis (webdriver attached), Space held 12 / 100 ms; the same keys in the tool\'s own NSTextView and WKWebView (the control)', async () => {
		await diagD1();
	});

	itDiag('diag D2: conversion without the candidate window — Control + K and F7 while composing', async () => {
		await diagD2();
	});

	itDiag('diag D3: the IME\'s windows (prediction while typing, candidates after Space) against the caret at 100 % / 150 %', async () => {
		await diagD3();
	});

	itDiag('diag D4: reconversion — a confirmed word selected, the kana key twice', async () => {
		await diagD4();
	});

	itDiag('diag D5: drags — three ways of sending, on the face and in the tool\'s own WKWebView', async () => {
		await diagD5();
	});

	itDiag('diag D6: Command + B with the keyboard type ANSI / JIS under ABC and Japanese', async () => {
		await diagD6();
	});

	// --- the short B.5 heading diagnosis (stage diag-b5; VELLIS_GATE_REQ74_STAGE=diag-b5) ---
	itDiagB5('diag-b5: Format ▸ Heading 2 / Body Text by AX; Option + Command + 2 / 0 / 1 on the pid route and the HID route (ANSI) with every keydown the page saw; a HID control (Option + Command + U)', async () => {
		await diagB5Headings();
	});

	itDiagB5('diag-b5: the kana key twice at the JIS keyboard type on a confirmed, selected katakana word — compositionstart and the new windows', async () => {
		await diagB5Reconvert();
	});

	// --- gate 1 after the diagnosis (D1 2026-11-20: the conversion with Space reaches the page; 由谷の決定 (1)) ---
	itStage(2, 'gate 1 (B.1 conversion): "nihon" + Space converts at the end of a paragraph, Return confirms it once and in place (no block added), the save writes it on that line only', async () => {
		await gateImeConvert();
	});

	itStage(2, 'gate 1 (B.1 reconversion): the kana key twice on a confirmed, selected word reconverts it; Escape gives it back (not reached = an environment row)', async () => {
		await gateImeReconvert();
	});

	itStage(2, 'gate 1 (B.1 candidate window): within one line + 40 pt under the composed text, ±40 pt across its span, at 100 % / 150 % (the app\'s own window above the normal level included; none = an environment row)', async () => {
		await gateImeCandidateWindow();
	});

	it('stages 2〜4: what stays with a person (gates 1・2・13・16-6) is listed in the report', async () => {
		if ([2, 3, 4].some((n) => STAGES.has(n))) humanOnly();
	});

	it('dialogs the page stubbed during the run: none from the product (what the driver answered is in the operator log)', async () => {
		const rec = await readGateRecord();
		judge('dialogs', 'no window.alert / confirm / prompt reached the page', rec.dialogs.length === 0, { dialogs: rec.dialogs });
	});
});
