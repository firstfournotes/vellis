import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
	assertEventRecorderWorks,
	assertIpcInterceptionWorks,
	clearEventRecord,
	clickExplorerRow,
	emitMenu,
	explorerHasRow,
	explorerNames,
	installEventRecorder,
	installGateRecorder,
	invokeFromPage,
	readEventRecord,
	removeEventRecorder,
	report,
	restoreGateRecorder,
	shot,
	zoomedShot,
	SHOTS_DIR,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

/**
 * Requirement #83 (Dashboard and Bookmarks) — the machine-checkable part of the
 * human gates 1〜13 of docs/requirements/req-83.md (「人間ゲート」節), driven
 * against the live webview of a webdriver build on a real screen
 * (`scripts/gate-device/req83-gate.sh` → `run-gate-spec.sh req83 launch|restart|ssh`).
 *
 * Three phases, three apps, launched WITHOUT an argument (VELLIS_E2E_NO_ROOT=1)
 * so the first window is the launch Dashboard (契約1): `launch` runs the gates
 * on a seeded home (req83-fixtures.sh: 8 recent folders, 6 bookmarks), `restart`
 * is a second app on the same home that checks what survived (gate 6・7),
 * `ssh` runs with the disposable sshd's home, the ssh URI in history and
 * bookmarks (gate 9). Each judgement is one JSON line in
 * `$VELLIS_GATE_SHOTS/req83-report.jsonl` (`pass` true / false; a line without
 * `pass` is a fact or a screenshot left to the eye).
 *
 * Machine (【機械】) and the machine part of 【機械+人】:
 *  - gate 1  (【人】, pictures only) the launch Dashboard light / dark × 1280×800 /
 *            narrow — screenshots, plus the facts the layout exposes (content
 *            width ≤ 1120, tile columns, the lower pair stacked when narrow); a
 *            hovered tile with its grip; later gates add the missing look (7),
 *            the truncation note (8), the SSH badge (9), the focus ring (10)
 *  - gate 2  Go ▸ … by AX: Go to Path…, Recent Files, a separator, Dashboard with
 *            Shift + Command + H; on the launch Dashboard a real Shift + Command + H,
 *            a real Escape and the AX press change nothing; with a root open the
 *            real key swaps the view for the Dashboard, again / Escape / the AX
 *            press bring the same root and document back without re-reading
 *  - gate 3  what a press opens (契約5 の表, read from the IPC: `set_root` /
 *            `open_document` and their `uri`s): a file bookmark with no root →
 *            its parent; outside the root → its parent; under the root → no
 *            `set_root`; a Recent Folders row → that root, no document; a
 *            Recently Modified row → the scanned folder + the file; the same
 *            root → no `set_root`; an unsaved edit → ONE Unsaved Changes dialog
 *            (found as a sheet / dialog / UNC by the driver): Esc = nothing,
 *            Return = saved then opened, Command + D = dropped then opened
 *  - gate 4  real right-clicks (HID) on an Explorer file row, a folder row and
 *            the document's margin → the app's menu (no WebKit menu) with Pin to
 *            Bookmarks after Copy Path (before Duplicate Window) / after Reload
 *            File; Pin → `add_bookmark(uri, kind)` → the tile is on the
 *            Dashboard; the same row then says Unpin from Bookmarks → `remove_bookmark`
 *  - gate 5  Add Bookmark… → Add Folder… / Add File… → the NSOpenPanel (the
 *            driver types a path into "Go to the folder" and presses Open) →
 *            `add_bookmark` with that path at the tail; Cancel → nothing
 *  - gate 6  a real hover + drag of a tile's grip, Move Up / Move Down (and
 *            their disabled ends), real Option + → / ← → `move_bookmark(uri, to)`
 *            and the new order; bookmarks.json follows; the restart phase sees it
 *  - gate 7  a deleted bookmark folder / file and a deleted recent folder show
 *            as `.missing`, a press leaves a `Could not open the …` note, nothing
 *            is removed from history.json / bookmarks.json; Remove from Recent
 *            Folders → `remove_history_entry`, the row is gone (and stays gone)
 *  - gate 8  a file written by another process (this spec) is the first row
 *            (`Just now`, folder › subfolder); an unopenable type and the
 *            excluded names (`.hidden`, node_modules, target) are not listed;
 *            `in N folders` = the readable targets; a huge tree → the scan is cut
 *            at 2 s (`truncated`, the note), the progress events are ≤ 8 and
 *            sorted; the timing and how far it got are recorded (確かめること 7)
 *  - gate 9  (ssh) the ssh row and tile carry the SSH badge, the scan never
 *            touches ssh (no ssh file in the result, no connection to the sshd
 *            until the row is pressed), the press connects and lists the root
 *  - gate 10 real Tab / arrows / Return: the first tile on open, → / ← / ↓ / ↑
 *            on the grid, Tab to Recent Folders → Show All → Recently Modified →
 *            Rescan, ↑ / ↓ on the rows, Return opens; the focus ring is shot
 *  - gate 11 during the Dashboard: Find in Folder / Recent Files / Go to Path /
 *            Print / Zoom / Edit / Find / Reload File / New Tab (menu events and
 *            real keys) do nothing — no IPC, no panel, no dialog, no window; Save
 *            (event and real Command + S) writes the edit behind; Duplicate Window
 *            opens a Dashboard window (read by AX, closed by the driver)
 *  - gate 14 (追補a) a Recent Folders row's ×: hidden until a real hover (light /
 *            dark shots of the hovered row), a real click (after the hover) removes
 *            the row — remove_history_entry once, no open, no dialog, gone from
 *            history.json and still gone after the restart — and leaves the focus
 *            on the tile; a real Delete key removes the focused row and the focus
 *            moves to the row in its place; Command + Delete does nothing. Runs
 *            last (it takes rows out of the history for good)
 *  - gate 12 a second window (File ▸ New Window by AX; webdriver cannot enter
 *            it = issue #22): a Pin here shows as a tile there (AX texts), a real
 *            Option + → there reorders here, a real right-click on its tile +
 *            Unpin (AX press) removes it here and the Explorer row says Pin again
 *
 * The operator (`req83-gate.sh`) takes the steps the page cannot: the native
 * menu, real keys / clicks / hover / drags, WebKit's menu, dialogs, the open
 * panel, the second window's AX, window frames, the sshd. This spec writes
 * `<SHOTS_DIR>/req83-op-<phase>/req-<n>.json` and waits for `ack-<n>.json`.
 * Without the driver (`VELLIS_GATE_REQ83_OPERATOR` unset) those steps are
 * reported as skipped.
 *
 * Runs only under `scripts/gate-device/run-gate-spec.sh req83 launch|restart|ssh`
 * (VELLIS_GATE_DEVICE=1), with VELLIS_GATE_REALINPUT built and trusted.
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const VARIANT = process.env.VELLIS_GATE_VARIANT ?? 'launch';
const OPERATOR = process.env.VELLIS_GATE_REQ83_OPERATOR === '1';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const configDir = process.env.VELLIS_GATE_REQ83_CONFIG ?? '';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const realinput = process.env.VELLIS_GATE_REALINPUT ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';
const sshUri = process.env.VELLIS_E2E_SSH_URI ?? '';
const REPORT = 'req83-report.jsonl';
const OP_DIR = path.join(SHOTS_DIR, `req83-op-${VARIANT}`);
/** What the launch phase leaves for the restart phase (expected order, removed entries). */
const STATE_FILE = path.join(SHOTS_DIR, 'req83-state.json');

const uri = (rel: string) => `file://${root}${rel === '' ? '' : `/${rel.split(path.sep).join('/')}`}`;
const file = (rel: string) => path.join(root, rel);

/** macOS virtual keycodes (US ANSI). */
const KEY = { s: 1, d: 2, f: 3, h: 4, g: 5, e: 14, r: 15, t: 17, p: 35, return: 36, tab: 48, space: 49, escape: 53, left: 123, right: 124, down: 125, up: 126 } as const;

// The Dashboard's DOM (src/components/Dashboard.svelte) and the words of 契約2・6・10・12・14 ($lib/dashboard, $lib/context-menu).
const DASH = '.root-picker.dashboard';
const TILE = `${DASH} .bookmark-tile`;
const ADD_TILE = `${DASH} .add-bookmark`;
const RECENT_ROW = `${DASH} .recent-folder`;
const MODIFIED_ROW = `${DASH} .modified-row`;
const RESCAN = `${DASH} .rescan`;
const SHOW_ALL_BUTTON = `${DASH} .dashboard-recent-folders .section-action`;
const NOTE = `${DASH} [role="alert"]`;
const SCAN_NOTE = `${DASH} .scan-note`;
const MENU = '.context-menu';
const MENU_ITEM = '.context-menu .context-menu-item';
const MENU_SEP = '.context-menu .context-menu-separator';
const VIEWER = 'article.viewer';
const BODY = 'article.viewer .markdown-body';
const EXPLORER = '.explorer';
const PIN = 'Pin to Bookmarks';
const UNPIN = 'Unpin from Bookmarks';
const COPY_PATH = 'Copy Path';
const DUPLICATE = 'Duplicate Window';
const RELOAD_FILE = 'Reload File';
const UNSAVED_TITLE = 'Unsaved Changes';
const FOLDER_FAILED = 'Could not open the folder: ';
const FILE_FAILED = 'Could not open the file: ';
const SCAN_TRUNCATED_MESSAGE = 'Partial results: the scan stopped after 2 seconds';
const PLAIN_ORIGINAL = 'first line\nsecond line\n';
const PLAIN_EDITED = 'first line edited\nsecond line\n';
const PLAIN_AGAIN = 'first line again\nsecond line\n';
/** The bookmarks as req83-fixtures.sh seeds them (the user's order). */
const SEEDED_TILES = ['beta', 'alpha/a1.md', 'alpha/inner/i1.md', 'outside/out.md', 'delta', 'gamma/gone.md'];

// --- the tools (pid-pinned child processes, as req80) --------------------------------

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

// --- the operator (scripts/gate-device/req83-gate.sh) --------------------------------

let opSeq = 0;

async function operator(
	step: string,
	args: Record<string, unknown> = {},
	timeoutMs = 90_000,
): Promise<Record<string, unknown> | null> {
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
				report(REPORT, { gate: 'operator', step, args, answer });
				return answer;
			}
		}
		await browser.pause(300);
	}
	throw new Error(`operator step ${step} (#${seq}) was not answered within ${timeoutMs} ms`);
}

/** A real key through the operator; `index` = the AX window to make key first (gate 12). */
async function realKey(keycode: number, mods: string[] = [], extra: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
	requireRealInput();
	const a = await operator('key', { keycode, mods, ...extra });
	if (a && a.focused_matches === false) environment('key', `the window asked for (${JSON.stringify(extra.win)}) was not the focused window when keycode ${keycode} [${mods.join('+')}] was due; the key was not sent`, { answer: a });
	if (a && a.sent !== true) environment('key', `the driver could not bring the window to the front for keycode ${keycode} [${mods.join('+')}]; the key was not sent`, { answer: a });
	await browser.pause(500);
	return a;
}

// --- page hooks: IPC with timing + args + bodies, mouse, keys ---------------------------

interface IpcRec {
	seq: number;
	cmd: string;
	uri: string | null;
	args: unknown;
	t0: number;
	t1: number | null;
	ok: boolean | null;
	/** Parsed response body, kept for the commands in `keep`. */
	body: unknown;
}
interface MouseRec {
	type: string;
	clientX: number;
	clientY: number;
	button: number;
	target: string;
}
interface KeyRec {
	key: string;
	code: string;
	meta: boolean;
	alt: boolean;
	shift: boolean;
	ctrl: boolean;
	target: string;
	at: number;
}
interface Hooks {
	ipc: IpcRec[];
	mouse: MouseRec[];
	keys: KeyRec[];
	keep: string[];
}

const KEEP_BODIES = ['set_root', 'scan_recently_modified', 'add_bookmark', 'remove_bookmark', 'move_bookmark', 'remove_history_entry', 'list_missing_paths', 'new_window'];

/**
 * Installed once, on top of the gate recorder: every IPC with its start / end
 * time, its `uri` argument, its parsed args and (for `keep`) its body; every
 * mousedown (the calibration click) and every keydown (a real key arrived) at
 * the capture phase.
 */
async function installHooks(): Promise<void> {
	await browser.execute((keep) => {
		const w = window as unknown as { __gate83?: Hooks & { originals: { fetch: typeof window.fetch } } };
		if (w.__gate83) return;
		const g = { ipc: [] as IpcRec[], mouse: [] as MouseRec[], keys: [] as KeyRec[], keep, originals: { fetch: window.fetch } };
		w.__gate83 = g;
		const inner = window.fetch;
		const parse = (text: string): unknown => {
			try {
				return JSON.parse(text);
			} catch {
				return text;
			}
		};
		window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
			const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
			const prefix = 'ipc://localhost/';
			if (!url.startsWith(prefix)) return inner.call(this, input, init);
			const cmd = decodeURIComponent(url.slice(prefix.length).split('?')[0] ?? '');
			const args = typeof init?.body === 'string' ? parse(init.body) : null;
			const u = args && typeof args === 'object' && typeof (args as { uri?: unknown }).uri === 'string' ? ((args as { uri: string }).uri) : null;
			const rec: IpcRec = { seq: g.ipc.length, cmd, uri: u, args, t0: performance.now(), t1: null, ok: null, body: null };
			g.ipc.push(rec);
			return inner.call(this, input, init).then(
				async (res) => {
					rec.t1 = performance.now();
					rec.ok = res.headers.get('Tauri-Response') !== 'error';
					if (g.keep.includes(cmd) || !rec.ok) rec.body = parse(await res.clone().text());
					return res;
				},
				(err: unknown) => {
					rec.t1 = performance.now();
					rec.ok = false;
					throw err;
				},
			);
		} as typeof window.fetch;
		const describe = (t: EventTarget | null) => {
			const el = t as Element | null;
			if (!el || !el.tagName) return '';
			const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(' ').join('.')}` : '';
			return `${el.tagName.toLowerCase()}${cls}`;
		};
		window.addEventListener('mousedown', (e) => g.mouse.push({ type: e.type, clientX: e.clientX, clientY: e.clientY, button: e.button, target: describe(e.target) }), true);
		window.addEventListener('keydown', (e) => g.keys.push({ key: e.key, code: e.code, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey, target: describe(e.target), at: Date.now() }), true);
	}, KEEP_BODIES);
}

async function hooks(): Promise<Hooks> {
	return browser.execute(() => {
		const g = (window as unknown as { __gate83?: Hooks }).__gate83;
		if (!g) throw new Error('hooks are not installed');
		return JSON.parse(JSON.stringify({ ipc: g.ipc, mouse: g.mouse, keys: g.keys, keep: g.keep })) as Hooks;
	});
}

async function restoreHooks(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __gate83?: { originals: { fetch: typeof window.fetch } } };
		if (w.__gate83) window.fetch = w.__gate83.originals.fetch;
	});
}

async function ipcMark(): Promise<number> {
	return (await hooks()).ipc.length;
}
async function ipcAfter(mark: number, cmds?: string[]): Promise<IpcRec[]> {
	const all = (await hooks()).ipc.slice(mark);
	return cmds ? all.filter((e) => cmds.includes(e.cmd)) : all;
}
/**
 * Wait until at least `min` IPCs of `cmds` were REQUESTED after `mark` (their
 * answer may still be pending — an open panel answers only when it closes).
 */
async function waitIpcRequested(mark: number, cmds: string[], min = 1, timeout = 10_000): Promise<IpcRec[]> {
	await browser.waitUntil(async () => (await ipcAfter(mark, cmds)).length >= min, {
		timeout,
		timeoutMsg: `IPC ${cmds.join('/')} (≥ ${min}) was not requested after mark ${mark}`,
	});
	return ipcAfter(mark, cmds);
}
/** Wait until at least `min` IPCs of `cmds` were made after `mark` and all of them answered. */
async function waitIpc(mark: number, cmds: string[], min = 1, timeout = 30_000): Promise<IpcRec[]> {
	await browser.waitUntil(
		async () => {
			const list = await ipcAfter(mark, cmds);
			return list.length >= min && list.every((e) => e.t1 !== null);
		},
		{ timeout, timeoutMsg: `IPC ${cmds.join('/')} (≥ ${min}) did not settle after mark ${mark}` },
	);
	await browser.pause(300);
	return ipcAfter(mark, cmds);
}
const OPEN_CMDS = ['set_root', 'open_document', 'open_binary_document'];
/** The open sequence after `mark` as `cmd:uri` strings (契約5's judgement). */
async function openSeq(mark: number): Promise<string[]> {
	return (await ipcAfter(mark, OPEN_CMDS)).map((e) => `${e.cmd}:${e.uri ?? ''}${e.ok === false ? ' (failed)' : ''}`);
}
async function keysMark(): Promise<number> {
	return (await hooks()).keys.length;
}
async function keysAfter(mark: number): Promise<KeyRec[]> {
	return (await hooks()).keys.slice(mark);
}
async function eventsMark(): Promise<number> {
	return (await readEventRecord()).length;
}
async function eventsAfter(mark: number, name?: string) {
	const all = (await readEventRecord()).slice(mark);
	return name ? all.filter((e) => e.event === name) : all;
}
async function waitEvent(mark: number, name: string, timeout = 10_000) {
	await browser.waitUntil(async () => (await eventsAfter(mark, name)).length > 0, { timeout, timeoutMsg: `no ${name} event after mark ${mark}` });
	await browser.pause(300);
	return eventsAfter(mark, name);
}

// --- page helpers ------------------------------------------------------------------

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
async function viewerText(): Promise<string> {
	return textOf(VIEWER);
}
async function waitViewerText(needle: string, timeout = 20_000): Promise<void> {
	await browser.waitUntil(async () => (await viewerText()).includes(needle), {
		timeout,
		timeoutMsg: `viewer never showed "${needle}" (now: ${JSON.stringify((await viewerText()).slice(0, 200))})`,
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
async function rectOfTitled(selector: string, title: string): Promise<Rect | null> {
	return browser.execute(
		(s, t) => {
			const el = Array.from(document.querySelectorAll<HTMLElement>(s)).find((e) => e.title === t);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, width: r.width, height: r.height };
		},
		selector,
		title,
	);
}
async function dashboardOpen(): Promise<boolean> {
	return exists(DASH);
}

interface TileState {
	index: number;
	uri: string;
	name: string;
	pathText: string;
	missing: boolean;
	ssh: boolean;
	focused: boolean;
}
async function tiles(): Promise<TileState[]> {
	return browser.execute(
		(sel) =>
			Array.from(document.querySelectorAll<HTMLElement>(sel)).map((t, i) => ({
				index: i,
				uri: t.title,
				name: t.querySelector('.tile-name')?.textContent ?? '',
				pathText: t.querySelector('.tile-path')?.textContent ?? '',
				missing: t.classList.contains('missing'),
				ssh: t.querySelector('.ssh-badge') !== null,
				focused: document.activeElement === t,
			})),
		TILE,
	);
}
async function tileOrder(): Promise<string[]> {
	return (await tiles()).map((t) => t.uri);
}
interface RowState {
	index: number;
	uri: string;
	name: string;
	pathText: string;
	missing: boolean;
	ssh: boolean;
	when: string;
	segments: string[];
	focused: boolean;
}
async function rows(selector: string): Promise<RowState[]> {
	return browser.execute(
		(sel) =>
			Array.from(document.querySelectorAll<HTMLElement>(sel)).map((r, i) => ({
				index: i,
				uri: r.title,
				name: r.querySelector('.row-name')?.textContent ?? '',
				pathText: r.querySelector('.row-path')?.textContent ?? '',
				missing: r.classList.contains('missing'),
				ssh: r.querySelector('.ssh-badge') !== null,
				when: r.querySelector('.when')?.textContent ?? '',
				segments: Array.from(r.querySelectorAll('.row-path > span:not(.segment-sep)')).map((s) => s.textContent ?? ''),
				focused: document.activeElement === r,
			})),
		selector,
	);
}
const recentRows = () => rows(RECENT_ROW);
const modifiedRows = () => rows(MODIFIED_ROW);
/** The focused element as `tag.class[title]` plus which Dashboard part it is. */
async function activeEl(): Promise<{ desc: string; part: string; title: string; index: number }> {
	return browser.execute(() => {
		const el = document.activeElement as HTMLElement | null;
		if (!el) return { desc: '', part: 'none', title: '', index: -1 };
		const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean) : [];
		const part = cls.includes('bookmark-tile') ? 'tile' : cls.includes('add-bookmark') ? 'add-bookmark' : cls.includes('recent-folder') ? 'recent' : cls.includes('modified-row') ? 'modified' : cls.includes('rescan') ? 'rescan' : cls.includes('section-action') ? 'show-all' : cls.includes('top-button') || cls.includes('pick-folder') ? 'top' : 'other';
		const siblings = part === 'tile' || part === 'add-bookmark' ? '.bookmark-tile, .add-bookmark' : part === 'recent' ? '.recent-folder' : part === 'modified' ? '.modified-row' : '';
		const index = siblings ? Array.from(document.querySelectorAll(siblings)).indexOf(el) : -1;
		return { desc: `${el.tagName.toLowerCase()}${cls.length ? `.${cls.join('.')}` : ''}`, part, title: el.title ?? '', index };
	});
}
async function focusTitled(selector: string, title: string): Promise<boolean> {
	return browser.execute(
		(s, t) => {
			const el = Array.from(document.querySelectorAll<HTMLElement>(s)).find((e) => e.title === t);
			if (!el) return false;
			el.focus();
			return document.activeElement === el;
		},
		selector,
		title,
	);
}
/** Tiles in the first row of the grid (what ↑ / ↓ step by). */
async function columnCount(): Promise<number> {
	return browser.execute((sel) => {
		const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
		if (els.length === 0) return 1;
		const top = els[0]!.offsetTop;
		let n = 0;
		for (const el of els) {
			if (el.offsetTop !== top) break;
			n++;
		}
		return Math.max(1, n);
	}, `${TILE}, ${ADD_TILE}`);
}
async function clickTitled(selector: string, title: string): Promise<boolean> {
	return browser.execute(
		(s, t) => {
			const el = Array.from(document.querySelectorAll<HTMLElement>(s)).find((e) => e.title === t);
			if (!el) return false;
			el.click();
			return true;
		},
		selector,
		title,
	);
}
const clickTile = (u: string) => clickTitled(TILE, u);
const clickRecentRow = (u: string) => clickTitled(RECENT_ROW, u);
const clickModifiedRow = (u: string) => clickTitled(MODIFIED_ROW, u);
async function noteText(): Promise<string> {
	return textOf(NOTE);
}

// --- the context menu (DOM) ------------------------------------------------------------

interface MenuItemState {
	label: string;
	disabled: boolean;
}
async function menuItems(): Promise<MenuItemState[]> {
	return browser.execute(
		(sel) => Array.from(document.querySelectorAll<HTMLButtonElement>(sel)).map((b) => ({ label: b.textContent?.trim() ?? '', disabled: b.disabled })),
		MENU_ITEM,
	);
}
async function menuSeparators(): Promise<number> {
	return browser.execute((sel) => document.querySelectorAll(sel).length, MENU_SEP);
}
async function menuOpen(): Promise<boolean> {
	return exists(MENU);
}
async function waitMenu(): Promise<MenuItemState[]> {
	await browser.waitUntil(async () => menuOpen(), { timeout: 5_000, timeoutMsg: 'the context menu did not open' });
	return menuItems();
}
async function closeMenu(): Promise<void> {
	if (!(await menuOpen())) return;
	await browser.execute(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
	await browser.waitUntil(async () => !(await menuOpen()), { timeout: 3_000, timeoutMsg: 'Escape did not close the menu' });
}
/** A DOM right-click (`contextmenu`) on the element of `selector` whose `title` is `title`. */
async function domMenuOn(selector: string, title: string): Promise<MenuItemState[]> {
	const ok = await browser.execute(
		(s, t) => {
			const el = Array.from(document.querySelectorAll<HTMLElement>(s)).find((e) => e.title === t);
			if (!el) return false;
			const r = el.getBoundingClientRect();
			el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.x + 24, clientY: r.y + r.height / 2 }));
			return true;
		},
		selector,
		title,
	);
	if (!ok) throw new Error(`no ${selector} titled ${title} to right-click`);
	return waitMenu();
}
const rowMenu = (u: string) => domMenuOn('.explorer-item', u);
const tileMenu = (u: string) => domMenuOn(TILE, u);
const recentRowMenu = (u: string) => domMenuOn(RECENT_ROW, u);
async function clickMenuItem(label: string): Promise<boolean> {
	return browser.execute(
		(sel, l) => {
			const b = Array.from(document.querySelectorAll<HTMLButtonElement>(sel)).find((x) => x.textContent?.trim() === l);
			if (!b) return false;
			b.click();
			return true;
		},
		MENU_ITEM,
		label,
	);
}

// --- Dashboard navigation ----------------------------------------------------------------

/** True until the first open from the launch Dashboard (then every Dashboard is returnable). */
let launchDashboard = true;

async function openDashboard(): Promise<void> {
	if (await dashboardOpen()) return;
	await closeOverlays();
	await emitMenu('menu_dashboard');
	await waitFor(DASH, 'the Dashboard', 10_000);
	await browser.pause(400);
}
async function closeDashboard(): Promise<void> {
	if (!(await dashboardOpen())) return;
	await closeMenu();
	await emitMenu('menu_dashboard');
	await waitGone(DASH, 'the Dashboard (Go ▸ Dashboard again)', 10_000);
	await browser.pause(300);
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
/** Make `name` (a seeded folder) the window's root through the Dashboard's Recent Folders row. */
async function ensureRoot(name: string, probeChild: string): Promise<void> {
	if (!(await dashboardOpen()) && (await explorerHasRow(uri(probeChild)))) return;
	await openDashboard();
	if (!(await clickRecentRow(uri(name)))) throw new Error(`no Recent Folders row for ${name}`);
	launchDashboard = false;
	// The same root again closes the Dashboard without set_root (契約5 (w)); another root lists after set_root.
	await waitGone(DASH, `open ${name}`, 30_000);
	await waitForExplorerRow(uri(probeChild), { timeout: 30_000, nudgeDir: file(name), nudgePrefix: 'req83-root' });
	await browser.pause(300);
}
async function openDoc(rel: string, marker: string): Promise<void> {
	await closeOverlays();
	await clickExplorerRow(uri(rel));
	await waitFor(BODY, `open ${rel}`);
	await waitViewerText(marker);
}
async function waitScanDone(mark: number, timeout = 30_000): Promise<IpcRec> {
	const list = await waitIpc(mark, ['scan_recently_modified'], 1, timeout);
	return list[list.length - 1]!;
}
async function rescan(): Promise<IpcRec> {
	const mark = await ipcMark();
	await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), RESCAN);
	return waitScanDone(mark);
}

// --- files outside the app --------------------------------------------------------

function readJson<T>(name: string): T {
	return JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8')) as T;
}
const historyFile = () => readJson<string[]>('history.json');
const bookmarksFile = () => readJson<Array<{ uri: string; kind: string }>>('bookmarks.json');
function writeNow(abs: string, content: string): void {
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	const tmp = `${abs}.req83-tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, abs);
	const now = new Date();
	fs.utimesSync(abs, now, now);
}
function writeAtomic(abs: string, content: string): void {
	const tmp = `${abs}.req83-tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, abs);
}
/** The local folders Recently Modified scans right now (契約11): history locals + bookmark folders, deduped, existing. */
function expectedScanTargets(): string[] {
	const locals = [...historyFile(), ...bookmarksFile().filter((b) => b.kind === 'folder').map((b) => b.uri)]
		.filter((u) => u.startsWith('file://'))
		.map((u) => u.replace(/\/+$/, ''));
	return [...new Set(locals)].filter((u) => fs.existsSync(u.slice('file://'.length)));
}

// --- real input: the screen ---------------------------------------------------------

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

/** The window's frame again (gate 1 moves and resizes it; the offsets of the webview inside stay). */
function refreshFrame(pid: number): void {
	if (!screen) return;
	const wins = ax(['cgwins', String(pid)]).filter((w) => w.onscreen === true);
	const w = wins.sort((a, b) => (b.w as number) * (b.h as number) - (a.w as number) * (a.h as number))[0];
	if (w) screen.frame = { x: w.x as number, y: w.y as number, w: w.w as number, h: w.h as number, number: w.number as number };
}

/**
 * Find the window and measure the WKWebView's offset in it with one real left
 * click on `selector` (somewhere a click does nothing: the Dashboard's wordmark,
 * the Explorer's header), as req80 does.
 */
async function calibrate(pid: number, selector: string): Promise<void> {
	await ensureFront(pid);
	const wins = ax(['cgwins', String(pid)]).filter((w) => w.onscreen === true);
	if (wins.length === 0) throw new Error('the test app has no on-screen window');
	const w = wins.sort((a, b) => (b.w as number) * (b.h as number) - (a.w as number) * (a.h as number))[0]!;
	const inner = await browser.execute(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }));
	const guess = { dx: Math.round(((w.w as number) - inner.innerWidth) / 2), dy: (w.h as number) - inner.innerHeight };
	screen = { pid, frame: { x: w.x as number, y: w.y as number, w: w.w as number, h: w.h as number, number: w.number as number }, dx: guess.dx, dy: guess.dy, route: 'pid' };
	const target = await rectOf(selector);
	if (!target) throw new Error(`no ${selector} for the calibration click`);
	const client = { x: Math.round(target.x + target.width / 2), y: Math.round(target.y + target.height / 2) };
	const s = toScreen(client.x, client.y);
	let md: MouseRec | undefined;
	const attempts: Array<{ route: string; facts: Record<string, unknown> }> = [];
	for (const route of ['hid', 'pid'] as const) {
		const before = (await hooks()).mouse.length;
		const facts = ri(['click', String(pid), String(s.x), String(s.y), route])[0]!;
		await browser.pause(400);
		attempts.push({ route, facts });
		md = (await hooks()).mouse.slice(before).find((m) => m.type === 'mousedown');
		if (md) {
			screen.route = route;
			break;
		}
	}
	if (!md) throw new Error(`calibration click: no mousedown recorded on either route (${JSON.stringify(attempts)})`);
	const measured = { dx: s.x - screen.frame.x - md.clientX, dy: s.y - screen.frame.y - md.clientY };
	const drift = { dx: measured.dx - guess.dx, dy: measured.dy - guess.dy };
	screen.dx = measured.dx;
	screen.dy = measured.dy;
	report(REPORT, { gate: 'calibration', pid, window: w, inner, guess, measured, drift, mousedown: md, attempts });
	if (Math.abs(drift.dx) > 4 || Math.abs(drift.dy) > 4) throw new Error(`the calibration click drifted by ${JSON.stringify(drift)}`);
}

let realInputBlocked: string | null = null;
function requireRealInput(): void {
	if (realInputBlocked) throw new Error(`environment: ${realInputBlocked}`);
}
/**
 * The environment, not the product, stopped a gate (the front could not be
 * taken, a menu was left open): one `environment` row (no pass), the real
 * input of this `it` is stopped, and the `it` ends on an `environment:` error.
 */
function environment(gate: number | string, item: string, extra: Record<string, unknown> = {}): never {
	const frontApp = (extra.answer as { front_app?: unknown } | undefined)?.front_app ?? extra.front_app ?? null;
	const reason = `${item}${frontApp ? ` (front app: ${JSON.stringify(frontApp)})` : ''}`;
	realInputBlocked = reason;
	report(REPORT, { gate: 'environment', item, reason, ...extra });
	throw new Error(`environment: ${reason}`);
}

interface RightClick {
	answer: Record<string, unknown> | null;
	popupFound: boolean;
	popupTitles: string[];
	appMenu: MenuItemState[] | null;
	pressedTarget: string | null;
}
/** A real right-click at a viewport point through the operator (req80's realRightClick). */
async function realRightClick(clientX: number, clientY: number, shotName?: string): Promise<RightClick> {
	requireRealInput();
	refreshFrame(screen!.pid);
	const s = toScreen(clientX, clientY);
	let out: RightClick | null = null;
	for (const route of ['hid', 'pid']) {
		const before = (await hooks()).mouse.length;
		const answer = await operator('rclick', { x: s.x, y: s.y, shot: shotName ?? '', route });
		await browser.pause(400);
		if (answer && answer.front === false) {
			environment('rclick', `the driver could not bring the window to the front for the right-click at (${s.x}, ${s.y}); the click was not sent`, { answer });
		}
		const popup = (answer?.popup ?? null) as { found?: boolean; menus?: Array<{ items: Array<{ title: string }> }>; windows?: unknown[] } | null;
		const after = (answer?.popup_after ?? null) as { found?: boolean; windows?: unknown[] } | null;
		const popupTitles = popup?.menus?.flatMap((m) => m.items.map((i) => i.title)) ?? [];
		if (after?.found === true) {
			environment('rclick', `WebKit's menu (layer-101 window ${JSON.stringify(after.windows ?? [])}) could not be closed by the driver after the right-click at (${s.x}, ${s.y}); no more real input is sent`, { answer });
		}
		const appMenu = (await menuOpen()) ? await menuItems() : null;
		const md = (await hooks()).mouse.slice(before).find((m) => m.type === 'mousedown' && m.button === 2);
		out = { answer: answer ? { ...answer, route } : null, popupFound: popup?.found === true, popupTitles, appMenu, pressedTarget: md?.target ?? null };
		if (out.popupFound || out.appMenu !== null || md) break;
	}
	return out!;
}

/** A point in the margin of the viewer (not over the body's blocks), as req80. */
async function marginPoint(): Promise<{ x: number; y: number; target: string } | null> {
	return browser.execute((bodySel) => {
		const vm = document.querySelector('.viewer-main');
		const body = document.querySelector(bodySel);
		if (!vm || !body) return null;
		const v = vm.getBoundingClientRect();
		const b = body.getBoundingClientRect();
		const candidates = [
			{ x: v.right - 28, y: b.top + 80 },
			{ x: (v.left + b.left) / 2, y: b.top + 80 },
			{ x: b.left + 40, y: v.bottom - 24 },
		];
		for (const c of candidates) {
			const x = Math.round(c.x);
			const y = Math.round(c.y);
			if (x <= v.left || x >= v.right || y <= v.top || y >= v.bottom) continue;
			const el = document.elementFromPoint(x, y);
			if (!el || !vm.contains(el)) continue;
			if (el.closest(`${bodySel} > *`)) continue;
			return { x, y, target: `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}` };
		}
		return null;
	}, BODY);
}

// --- the unsaved edit (plain.txt, as req80's gate 4) ---------------------------------

const PLAIN_VIEW = `${BODY} pre.vellis-plaintext`;
const PLAIN_EDITOR = `${PLAIN_VIEW}[contenteditable="true"]`;
async function makeDirty(text: string): Promise<boolean> {
	await closeOverlays();
	await clickExplorerRow(uri('alpha/plain.txt'));
	await browser.waitUntil(async () => (await exists(PLAIN_VIEW)) && (await textOf(PLAIN_VIEW)).includes('first line'), { timeout: 15_000, timeoutMsg: 'plain.txt did not open in the plain-text view' });
	if (!(await exists(PLAIN_EDITOR))) {
		await emitMenu('menu_edit');
		await waitFor(PLAIN_EDITOR, 'the editor', 5_000);
	}
	return browser.execute(
		(sel, t) => {
			const el = document.querySelector<HTMLElement>(sel);
			if (!el) return false;
			el.focus();
			el.textContent = t;
			el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: t }));
			return true;
		},
		PLAIN_EDITOR,
		text,
	);
}
async function editorText(): Promise<string | null> {
	return browser.execute((sel) => document.querySelector<HTMLElement>(sel)?.textContent ?? null, PLAIN_EDITOR);
}
async function messageIpcCount(mark: number): Promise<number> {
	return (await ipcAfter(mark, ['plugin:dialog|message'])).length;
}

// --- judgement ------------------------------------------------------------------------

let fails: string[] = [];
function judge(gate: number | string, item: string, pass: boolean, extra: Record<string, unknown> = {}): boolean {
	report(REPORT, { gate, item, pass, ...extra });
	if (!pass) fails.push(`${gate}: ${item}`);
	return pass;
}
function fact(gate: number | string, item: string, extra: Record<string, unknown> = {}): void {
	report(REPORT, { gate, item, ...extra });
}
function skipped(gate: number | string, item: string, why: string): void {
	report(REPORT, { gate, item, note: `skipped: ${why}` });
}
/** A standard window as the driver names it (`new-window` / `windows`): the index is a snapshot, the rest identifies it. */
interface AxWin {
	title: string;
	x: number;
	y: number;
	w?: number;
	h?: number;
	index?: number;
	main?: boolean;
}

/** The bookmarks as the app holds them now (not the DOM: the Dashboard may be closed). */
async function bookmarkUris(): Promise<string[]> {
	const r = await invokeFromPage<Array<{ uri: string }>>('list_bookmarks');
	return (r.value ?? []).map((b) => b.uri);
}
/**
 * Remove every bookmark that is not in `keep` (what a gate added and could not
 * take back: gate 5's panel folder, gate 12's a2.md — the 2026-11-05 run carried
 * them into the gates after). Nothing is re-added or reordered.
 */
async function restoreBookmarks(keep: string[]): Promise<{ removed: string[]; now: string[] }> {
	const removed: string[] = [];
	for (const u of await bookmarkUris()) {
		if (keep.includes(u)) continue;
		await invokeFromPage('remove_bookmark', { uri: u });
		removed.push(u);
	}
	if (removed.length > 0) await browser.pause(800);
	return { removed, now: await bookmarkUris() };
}

const ci = (list: string[], needle: string) => list.some((t) => t.toLowerCase().includes(needle.toLowerCase()));
const countCi = (list: string[], needle: string) => list.filter((t) => t.toLowerCase().includes(needle.toLowerCase())).length;
/** Which gates of this run reached their judgements (VELLIS_GATE_GREP may leave some out; dependants then skip). */
const ran: { gate3b: boolean; gate7: boolean; gate14: string[] } = { gate3b: false, gate7: false, gate14: [] };

// =======================================================================================
describe('Requirement #83 human gates, the machine part — the launch Dashboard (gates 1〜8, 10〜12, 14)', function () {
	this.timeout(1_200_000);
	let pid = 0;

	before(async function () {
		if (!DEVICE || VARIANT !== 'launch') this.skip();
		for (const [name, value] of Object.entries({ VELLIS_GATE_BIN: bin, VELLIS_GATE_AXTOOL: axtool, VELLIS_GATE_REALINPUT: realinput, VELLIS_E2E_INITIAL_ROOT: root, VELLIS_GATE_REQ83_CONFIG: configDir })) {
			if (!value) throw new Error(`${name} is not set`);
		}
		for (const f of ['cwd', 'alpha/a1.md', 'alpha/a2.md', 'alpha/notes.md', 'alpha/plain.txt', 'alpha/inner/i1.md', 'beta/b1.md', 'beta/docs/d1.md', 'gamma/g1.md', 'gamma/gone.md', 'delta/d1.md', 'e4/e4.md', 'outside/out.md']) {
			if (!fs.existsSync(file(f))) throw new Error(`fixture ${f} is missing in ${root} (req83-fixtures.sh)`);
		}
		for (const f of ['history.json', 'bookmarks.json']) {
			if (!fs.existsSync(path.join(configDir, f))) throw new Error(`${f} is missing in ${configDir} (req83-fixtures.sh)`);
		}
		fs.mkdirSync(SHOTS_DIR, { recursive: true });
		fs.rmSync(OP_DIR, { recursive: true, force: true });
		fs.rmSync(STATE_FILE, { force: true });
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await installHooks();
		await installEventRecorder(['menu_dashboard', 'bookmarks_changed', 'recently_modified_progress']);
		await assertEventRecorderWorks();
		pid = appPid();
		await waitFor(DASH, 'the launch Dashboard', 30_000);
		await browser.waitUntil(async () => (await tiles()).length === SEEDED_TILES.length && (await recentRows()).length === 6, { timeout: 30_000, timeoutMsg: 'the seeded tiles / rows did not render' });
		// The launch facts before anything is touched: the focus (契約13 (o)), the
		// provisional root behind (契約1), what AX reads for the headings (確かめること 8 / reviewer P2-1).
		const focus = await activeEl();
		fact(10, 'the launch Dashboard: the focused element right after the mount (契約13: the first tile)', { focus });
		judge(10, 'the launch Dashboard focuses the first bookmark tile', focus.part === 'tile' && focus.index === 0, { focus });
		const texts = ((await operator('texts', { index: 0 }))?.texts ?? []) as string[];
		const headings = texts.filter((t) => /recent folders|bookmarks|recently modified/i.test(t));
		fact('setup', 'AX texts of the window: how the section headings read (確かめること 8; req12b-extra.sh C looks for "Recent Folders" case-sensitively = reviewer P2-1)', { headings, exact_recent_folders: texts.includes('Recent Folders'), uppercase_recent_folders: texts.includes('RECENT FOLDERS'), texts_count: texts.length });
		if (OPERATOR) judge('setup', 'AX exposes the Recent Folders heading (case-insensitive)', ci(texts, 'recent folders'), { headings });
		report(REPORT, { gate: 'setup', variant: VARIANT, operator: OPERATOR, pid, root, configDir, history: historyFile(), bookmarks: bookmarksFile() });
		await calibrate(pid, `${DASH} .wordmark`);
	});

	async function resetScreen(when: string): Promise<void> {
		const closed = await closeOverlays();
		await closeMenu().catch(() => undefined);
		if (closed.length > 0) report(REPORT, { gate: 'reset', when, closed });
	}
	beforeEach(async function () {
		if (!DEVICE || VARIANT !== 'launch') return;
		fails = [];
		realInputBlocked = null;
		await resetScreen(`before: ${this.currentTest?.title ?? '?'}`);
	});
	afterEach(async function () {
		if (!DEVICE || VARIANT !== 'launch') return;
		if (this.currentTest?.state === 'failed') {
			report(REPORT, { gate: 'failed', test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
		}
		await resetScreen(`after: ${this.currentTest?.title ?? '?'}`).catch(() => undefined);
	});
	after(async function () {
		if (!DEVICE || VARIANT !== 'launch') return;
		try {
			if (fs.existsSync(file('alpha/plain.txt'))) writeAtomic(file('alpha/plain.txt'), PLAIN_ORIGINAL);
			// What the restart phase checks: the order and the removed entries as they are on disk now.
			// `gate7` says whether delta / gone.md were deleted and delta removed from history (the restart phase skips those checks otherwise).
			fs.writeFileSync(STATE_FILE, JSON.stringify({ bookmarks: bookmarksFile(), history: historyFile(), removedHistory: ran.gate7 ? [uri('delta')] : [], gate7: ran.gate7, removedByGate14: ran.gate14, cwd: uri('cwd') }, null, 2));
			report(REPORT, { gate: 'teardown', variant: VARIANT, state_file: STATE_FILE, history: historyFile(), bookmarks: bookmarksFile() });
			await removeEventRecorder();
			await restoreHooks();
			await restoreGateRecorder();
		} finally {
			await operator('done', {}, 10_000).catch(() => null);
		}
	});

	// ------------------------------------------------------------------ gate 1 (pictures)
	it('gate 1: the launch Dashboard — light / dark × 1280×800 / narrow (screenshots for the eye; the layout facts are recorded)', async () => {
		const saved = await browser.execute(() => {
			const out: Record<string, string | null> = {};
			try {
				for (let i = 0; i < localStorage.length; i++) {
					const k = localStorage.key(i)!;
					if (k.startsWith('vellis.')) out[k] = localStorage.getItem(k);
				}
			} catch {
				// no storage
			}
			return out;
		});
		const theme = () => browser.execute(() => document.documentElement.getAttribute('data-theme'));
		const layout = () =>
			browser.execute(
				(dash, tile, add) => {
					const content = document.querySelector<HTMLElement>(`${dash} .dashboard-content`);
					const lower = document.querySelector<HTMLElement>(`${dash} .lower`);
					const els = Array.from(document.querySelectorAll<HTMLElement>(`${tile}, ${add}`));
					const top = els[0]?.offsetTop ?? 0;
					const columns = Math.max(1, els.filter((e) => e.offsetTop === top).length);
					const lowerColumns = lower ? getComputedStyle(lower).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
					// The content's width INSIDE its padding (`.dashboard-content` is border-box, max-width 1152 = 1120 + 2 × 16; the 2026-11-05 run measured the box).
					const cs = content ? getComputedStyle(content) : null;
					const contentWidth = content && cs ? content.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : null;
					return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, contentWidth, boxWidth: content?.getBoundingClientRect().width ?? null, tileWidth: els[0]?.getBoundingClientRect().width ?? null, columns, lowerColumns, scrollHeight: document.querySelector(dash)?.scrollHeight ?? null, clientHeight: document.querySelector(dash)?.clientHeight ?? null };
				},
				DASH,
				TILE,
				ADD_TILE,
			);
		const shots: Record<string, unknown>[] = [];
		const frames: Array<{ name: string; w: number; h: number }> = [
			{ name: '1280', w: 1280, h: 800 },
			{ name: 'narrow', w: 720, h: 800 },
		];
		for (const fr of frames) {
			const got = await operator('frame', { w: fr.w, h: fr.h, x: 80, y: 80 });
			await browser.pause(800);
			refreshFrame(pid);
			for (const mode of ['light', 'dark'] as const) {
				await emitMenu(`menu_appearance_${mode}`);
				await browser.waitUntil(async () => (await theme()) === mode, { timeout: 5_000, timeoutMsg: `data-theme did not become ${mode}` });
				await browser.pause(500);
				const l = await layout();
				const f = await shot(`req83-gate1-${mode}-${fr.name}`);
				shots.push({ frame: fr, asked_frame: got?.frame ?? null, mode, file: f, layout: l });
				fact(1, `screenshot: ${mode}, ${fr.name} (the eye compares it with the mock's screen 1)`, { shot: f, frame: got?.frame ?? null, layout: l });
				if (fr.name === '1280') judge(1, `${mode} 1280×800: the content is at most 1120 px wide and the lower pair sits in two columns (契約2 (u))`, l.contentWidth !== null && l.contentWidth <= 1121 && l.lowerColumns === 2, { layout: l });
				else judge(1, `${mode} narrow: the lower pair is stacked in one column and the tiles are at least 220 px wide (契約2 (u))`, l.lowerColumns === 1 && l.tileWidth !== null && l.tileWidth >= 219, { layout: l });
			}
		}
		// A hovered tile shows its grip (契約8): a real hover on the first tile, zoomed in for the eye.
		await operator('frame', { w: 1280, h: 800, x: 80, y: 80 });
		await browser.pause(800);
		refreshFrame(pid);
		await emitMenu('menu_appearance_light');
		await browser.pause(400);
		const t0 = await rectOf(`${TILE}[data-index="0"]`);
		if (t0 && OPERATOR) {
			const s = toScreen(Math.round(t0.x + t0.width / 2), Math.round(t0.y + t0.height / 2));
			const hover = await operator('hover', { x: s.x, y: s.y, route: screen?.route ?? 'hid' });
			await browser.pause(400);
			const gripShown = await browser.execute((sel) => {
				const g = document.querySelector<HTMLElement>(`${sel}[data-index="0"] .bookmark-grip`);
				return g ? getComputedStyle(g).display !== 'none' : null;
			}, TILE);
			const z = await zoomedShot('req83-gate1-tile-grip', { x: t0.x - 8, y: t0.y - 8, width: t0.width + 16, height: t0.height + 16 }, 2);
			judge(1, 'a hovered tile draws its grip (契約8: hover and focus only)', gripShown === true, { grip_display_not_none: gripShown, hover, shot: z });
			fact(1, 'screenshot: the hovered tile with its grip, ×2 (the eye)', { shot: z });
		}
		await emitMenu('menu_appearance_system');
		await browser.pause(300);
		await browser.execute((s) => {
			try {
				for (const [k, v] of Object.entries(s)) {
					if (v === null) localStorage.removeItem(k);
					else localStorage.setItem(k, v);
				}
			} catch {
				// nothing was written either
			}
		}, saved);
		fact(1, 'all gate 1 screenshots', { shots });
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 2
	it('gate 2a: Go ▸ … by AX — Go to Path…, Recent Files, a separator, Dashboard (enabled, Shift + Command + H); Dashboard in no other menu', async () => {
		const a = await operator('menu-detail', { menu: 'Go' });
		if (!a) {
			skipped(2, 'the Go menu by AX', 'needs the operator');
			return;
		}
		const items = (a.items ?? []) as Array<{ title: string; enabled: boolean; cmd_char: string; cmd_modifiers: number; separator: boolean; submenu: boolean }>;
		const titles = items.map((i) => (i.separator ? '—' : i.title));
		const dashboard = items.find((i) => i.title === 'Dashboard');
		fact(2, 'the live Go menu as AX reads it', { items });
		judge(2, 'Go menu order: Go to Path…, Recent Files, a separator, Dashboard (契約3 (v))', JSON.stringify(titles) === JSON.stringify(['Go to Path…', 'Recent Files', '—', 'Dashboard']), { titles });
		judge(2, 'Dashboard shows Shift + Command + H (AXMenuItemCmdChar H, modifiers 1 = Shift with Command) and is enabled', !!dashboard && dashboard.cmd_char.toUpperCase() === 'H' && dashboard.cmd_modifiers === 1 && dashboard.enabled, { dashboard });
		for (const menu of ['File', 'Edit', 'View', 'Window']) {
			const m = await operator('menu-detail', { menu });
			const t = ((m?.items ?? []) as Array<{ title: string }>).map((i) => i.title);
			judge(2, `${menu} has no Dashboard item (契約3)`, !t.includes('Dashboard'), { titles: t });
		}
		expect(fails).toEqual([]);
	});

	it('gate 2b: the launch Dashboard (nothing to go back to) — a real Shift + Command + H, a real Escape and the AX press change nothing', async () => {
		if (!launchDashboard || !(await dashboardOpen())) {
			skipped(2, 'the launch Dashboard', 'the launch Dashboard is already gone (run this gate first, or without VELLIS_GATE_GREP)');
			return;
		}
		const ev = await eventsMark();
		const mark = await ipcMark();
		const key = await realKey(KEY.h, ['cmd', 'shift']);
		if (!key) {
			skipped(2, 'real Shift + Command + H on the launch Dashboard', 'needs the operator');
			return;
		}
		const arrived = await waitEvent(ev, 'menu_dashboard', 5_000).catch(() => []);
		await browser.pause(800);
		judge(2, 'launch Dashboard + real Shift + Command + H: the menu event reached the window and the Dashboard stays (契約4 (w)), no root is opened', arrived.length === 1 && (await dashboardOpen()) && (await openSeq(mark)).length === 0, { key, events: arrived.length, ipc: await openSeq(mark) });
		await realKey(KEY.escape);
		await browser.pause(500);
		judge(2, 'launch Dashboard + real Escape: the Dashboard stays', (await dashboardOpen()) && (await openSeq(mark)).length === 0, { ipc: await openSeq(mark) });
		const pressed = await operator('press-menu', { menu: 'Go', item: 'Dashboard' });
		await browser.pause(1_000);
		judge(2, 'launch Dashboard + Go ▸ Dashboard by AX: the Dashboard stays (the event is received, nothing changes)', (await dashboardOpen()) && (await eventsAfter(ev, 'menu_dashboard')).length === 2 && (await openSeq(mark)).length === 0, { pressed, events: (await eventsAfter(ev, 'menu_dashboard')).length });
		expect(fails).toEqual([]);
	});

	it('gate 2c: a root open — a real Shift + Command + H swaps the view for the Dashboard; again / a real Escape / the AX press bring the same root and document back without re-reading', async () => {
		await ensureRoot('alpha', 'alpha/notes.md');
		await openDoc('alpha/notes.md', 'GATE83-NOTES');
		// Keep a scroll position and a selection-free, panel-free view behind.
		const rowsBefore = await explorerNames();
		let mark = await ipcMark();
		const k1 = await realKey(KEY.h, ['cmd', 'shift']);
		if (!k1) {
			skipped(2, 'real Shift + Command + H with a root open', 'needs the operator');
			return;
		}
		await waitFor(DASH, 'the Dashboard after Shift + Command + H', 5_000);
		judge(2, 'real Shift + Command + H: the window shows the Dashboard, the Explorer and the viewer are gone (the same window, no new window), no IPC of the open kind', (await dashboardOpen()) && !(await exists(EXPLORER)) && !(await exists(VIEWER)) && (await openSeq(mark)).length === 0, { key: k1, ipc: await openSeq(mark) });
		const focus = await activeEl();
		judge(10, 'the Dashboard opened by the key focuses the first tile (契約13 (o))', focus.part === 'tile' && focus.index === 0, { focus });
		mark = await ipcMark();
		await realKey(KEY.h, ['cmd', 'shift']);
		await waitGone(DASH, 'the Dashboard after the second Shift + Command + H', 5_000);
		await browser.pause(500);
		judge(2, 'Shift + Command + H again: back to the same root and document (notes.md shown, the rows as before) with no set_root / open_document / list_dir', (await viewerText()).includes('GATE83-NOTES') && JSON.stringify(await explorerNames()) === JSON.stringify(rowsBefore) && (await ipcAfter(mark, [...OPEN_CMDS, 'list_dir'])).length === 0, { ipc: (await ipcAfter(mark)).map((e) => e.cmd) });
		// Escape.
		mark = await ipcMark();
		await emitMenu('menu_dashboard');
		await waitFor(DASH, 'the Dashboard (event)', 5_000);
		await realKey(KEY.escape);
		await waitGone(DASH, 'the Dashboard after a real Escape', 5_000);
		await browser.pause(300);
		judge(2, 'real Escape on a returnable Dashboard: back to the same root and document, nothing re-read', (await viewerText()).includes('GATE83-NOTES') && (await ipcAfter(mark, [...OPEN_CMDS, 'list_dir'])).length === 0, { ipc: (await ipcAfter(mark)).map((e) => e.cmd) });
		// The AX press of the menu item, both ways.
		mark = await ipcMark();
		const p1 = await operator('press-menu', { menu: 'Go', item: 'Dashboard' });
		await waitFor(DASH, 'the Dashboard after the AX press', 5_000);
		const p2 = await operator('press-menu', { menu: 'Go', item: 'Dashboard' });
		await waitGone(DASH, 'the Dashboard after the second AX press', 5_000);
		await browser.pause(300);
		judge(2, 'Go ▸ Dashboard by AX: opens, and again closes, back to the same document, nothing re-read', (await viewerText()).includes('GATE83-NOTES') && (await ipcAfter(mark, [...OPEN_CMDS, 'list_dir'])).length === 0, { press_open: p1, press_close: p2 });
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 3
	it('gate 3a: what a press opens (契約5 の表): a file bookmark with no root / outside the root / under it, a Recent Folders row, a Recently Modified row, the same root', async () => {
		const wasLaunch = launchDashboard && (await dashboardOpen());
		await openDashboard();
		// 1. A file bookmark (outside any root): its parent becomes the root, then the file.
		let mark = await ipcMark();
		await clickTile(uri('outside/out.md'));
		launchDashboard = false;
		await waitGone(DASH, 'open out.md', 30_000);
		await waitViewerText('GATE83-OUT');
		await waitIpc(mark, ['open_document'], 1);
		judge(3, `a file bookmark ${wasLaunch ? 'from the launch Dashboard (no root)' : 'outside the root'}: set_root(its parent) then open_document(the file) (契約5 (d))`, JSON.stringify(await openSeq(mark)) === JSON.stringify([`set_root:${uri('outside')}`, `open_document:${uri('outside/out.md')}`]), { seq: await openSeq(mark), from_launch: wasLaunch });
		judge(3, 'the Explorer lists the parent folder as the root', await explorerHasRow(uri('outside/out.md')), { rows: await explorerNames() });
		// 2. A file bookmark outside the current root (outside → alpha/a1.md).
		await openDashboard();
		mark = await ipcMark();
		await clickTile(uri('alpha/a1.md'));
		await waitGone(DASH, 'open a1.md', 30_000);
		await waitViewerText('GATE83-A1');
		await waitIpc(mark, ['open_document'], 1);
		judge(3, 'a file bookmark outside the root: set_root(its parent = alpha) then open_document(a1.md)', JSON.stringify(await openSeq(mark)) === JSON.stringify([`set_root:${uri('alpha')}`, `open_document:${uri('alpha/a1.md')}`]), { seq: await openSeq(mark) });
		// 3. A file bookmark under the current root (alpha/inner/i1.md under alpha): no set_root, the tree expands to it.
		await openDashboard();
		mark = await ipcMark();
		await clickTile(uri('alpha/inner/i1.md'));
		await waitGone(DASH, 'open i1.md', 30_000);
		await waitViewerText('GATE83-I1');
		await waitForExplorerRow(uri('alpha/inner/i1.md'), { timeout: 15_000 });
		judge(3, 'a file bookmark under the root: no set_root, open_document(i1.md), the ancestor folder is expanded and the row is in the tree (契約5 (d)(z))', JSON.stringify(await openSeq(mark)) === JSON.stringify([`open_document:${uri('alpha/inner/i1.md')}`]) && (await explorerHasRow(uri('alpha/inner/i1.md'))), { seq: await openSeq(mark) });
		// 4. A Recent Folders row: that root, no document.
		await openDashboard();
		mark = await ipcMark();
		await clickRecentRow(uri('beta'));
		await waitGone(DASH, 'open beta', 30_000);
		await waitForExplorerRow(uri('beta/b1.md'), { timeout: 30_000 });
		await browser.pause(500);
		judge(3, 'a Recent Folders row: set_root(beta) only, no document (the viewer is closed) (契約5 (c))', JSON.stringify(await openSeq(mark)) === JSON.stringify([`set_root:${uri('beta')}`]) && !(await exists(VIEWER)), { seq: await openSeq(mark), viewer: await exists(VIEWER) });
		// 5. A Recently Modified row: the scanned folder becomes the root, then the file.
		writeNow(file('gamma/fresh-3.md'), '# fresh 3\n\nGATE83-FRESH3\n');
		await openDashboard();
		await rescan();
		await browser.waitUntil(async () => (await modifiedRows())[0]?.uri === uri('gamma/fresh-3.md'), { timeout: 15_000, timeoutMsg: 'fresh-3.md is not the first Recently Modified row' });
		mark = await ipcMark();
		await clickModifiedRow(uri('gamma/fresh-3.md'));
		await waitGone(DASH, 'open fresh-3.md', 30_000);
		await waitViewerText('GATE83-FRESH3');
		await waitIpc(mark, ['open_document'], 1);
		judge(3, 'a Recently Modified row: set_root(the scanned folder = gamma) then open_document(the file) (契約5 (d))', JSON.stringify(await openSeq(mark)) === JSON.stringify([`set_root:${uri('gamma')}`, `open_document:${uri('gamma/fresh-3.md')}`]), { seq: await openSeq(mark) });
		// 6. A file bookmark whose parent is a subfolder (alpha/inner/i1.md from gamma): the parent, not the seeded root.
		await openDashboard();
		mark = await ipcMark();
		await clickTile(uri('alpha/inner/i1.md'));
		await waitGone(DASH, 'open i1.md from gamma', 30_000);
		await waitViewerText('GATE83-I1');
		await waitIpc(mark, ['open_document'], 1);
		judge(3, 'a file bookmark outside the root whose parent is a subfolder: set_root(alpha/inner) — the parent, not a recent folder', JSON.stringify(await openSeq(mark)) === JSON.stringify([`set_root:${uri('alpha/inner')}`, `open_document:${uri('alpha/inner/i1.md')}`]), { seq: await openSeq(mark) });
		// 7. The same root again: no set_root, the Dashboard just closes (契約5 (w)).
		await ensureRoot('alpha', 'alpha/a1.md');
		await openDashboard();
		mark = await ipcMark();
		await clickRecentRow(uri('alpha'));
		await waitGone(DASH, 'the same root', 10_000);
		await browser.pause(500);
		judge(3, 'the folder that already is the root: no set_root, the Dashboard closes, the tree keeps its rows', (await openSeq(mark)).length === 0 && (await explorerHasRow(uri('alpha/a1.md'))), { seq: await openSeq(mark) });
		expect(fails).toEqual([]);
	});

	it('gate 3b: an unsaved edit behind the Dashboard → ONE Unsaved Changes dialog (Save / Don’t Save / Cancel) — Esc opens nothing and keeps the edit, Return saves then opens, Command + D drops the edit and opens', async () => {
		if (!OPERATOR) {
			skipped(3, 'the unsaved dialog', 'needs the operator (real keys)');
			return;
		}
		await ensureRoot('alpha', 'alpha/plain.txt');
		writeAtomic(file('alpha/plain.txt'), PLAIN_ORIGINAL);
		await browser.pause(500);
		judge(3, 'the editor took the edit', await makeDirty(PLAIN_EDITED), {});
		// Cancel.
		await openDashboard();
		let mark = await ipcMark();
		await clickRecentRow(uri('beta'));
		let d = await operator('dialog', { wait_s: 10, expect: UNSAVED_TITLE, answer: 'escape' });
		await browser.pause(1_200);
		const buttons = ((d?.buttons ?? []) as string[][])[0] ?? [];
		judge(3, 'ONE dialog with Save / Don’t Save / Cancel (where it was found is recorded)', (d?.dialogs ?? 0) === 1 && ['Save', "Don't Save", 'Cancel'].every((b) => buttons.includes(b)) && (await messageIpcCount(mark)) === 1, { dialog: d, message_ipc: await messageIpcCount(mark) });
		judge(3, 'Cancel (Esc): no set_root, the Dashboard stays, the disk is unchanged', (await openSeq(mark)).length === 0 && (await dashboardOpen()) && fs.readFileSync(file('alpha/plain.txt'), 'utf8') === PLAIN_ORIGINAL, { seq: await openSeq(mark) });
		await closeDashboard();
		judge(3, 'Cancel (Esc): back behind, the editor still holds the edit', (await editorText())?.startsWith('first line edited') === true, { editor: await editorText() });
		// Save.
		await openDashboard();
		mark = await ipcMark();
		await clickRecentRow(uri('beta'));
		d = await operator('dialog', { wait_s: 10, expect: UNSAVED_TITLE, answer: 'return' });
		await waitGone(DASH, 'open beta after Save', 30_000);
		await waitForExplorerRow(uri('beta/b1.md'), { timeout: 30_000 });
		const saved = fs.readFileSync(file('alpha/plain.txt'), 'utf8');
		judge(3, 'Save (Return): save_document first (the edit is on the disk), then set_root(beta), the Dashboard closed', (d?.dialogs ?? 0) === 1 && saved.startsWith('first line edited\nsecond line') && (await ipcAfter(mark, ['save_document'])).length === 1 && JSON.stringify(await openSeq(mark)) === JSON.stringify([`set_root:${uri('beta')}`]), { dialog: d, disk: saved, seq: await openSeq(mark) });
		// Don't Save.
		await ensureRoot('alpha', 'alpha/plain.txt');
		judge(3, 'the editor took a second edit', await makeDirty(PLAIN_AGAIN), {});
		await openDashboard();
		mark = await ipcMark();
		await clickRecentRow(uri('gamma'));
		d = await operator('dialog', { wait_s: 10, expect: UNSAVED_TITLE, answer: 'cmd-d' });
		await waitGone(DASH, 'open gamma after Don’t Save', 30_000);
		await waitForExplorerRow(uri('gamma/g1.md'), { timeout: 30_000 });
		judge(3, 'Don’t Save (Command + D): no save_document, the disk is as saved before, set_root(gamma), the Dashboard closed', (d?.dialogs ?? 0) === 1 && (await ipcAfter(mark, ['save_document'])).length === 0 && fs.readFileSync(file('alpha/plain.txt'), 'utf8') === saved && JSON.stringify(await openSeq(mark)) === JSON.stringify([`set_root:${uri('gamma')}`]), { dialog: d, seq: await openSeq(mark) });
		writeAtomic(file('alpha/plain.txt'), PLAIN_ORIGINAL);
		ran.gate3b = true;
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 4
	it('gate 4: Pin by real right-clicks — a file row, a folder row and the document’s margin → the app’s menu with Pin to Bookmarks (no WebKit menu); the tile appears; the row then says Unpin and the tile goes', async () => {
		if (!OPERATOR) {
			skipped(4, 'real right-clicks', 'needs the operator');
			return;
		}
		await ensureRoot('alpha', 'alpha/a2.md');
		await openDoc('alpha/notes.md', 'GATE83-NOTES');
		await ensureFront(pid);
		async function pinThrough(what: string, rect: Rect, kind: 'file' | 'folder', target: string, after: string, before: string, shotName: string): Promise<void> {
			const point = { x: Math.round(rect.x + Math.min(40, rect.width / 2)), y: Math.round(rect.y + rect.height / 2) };
			const ev = await eventsMark();
			const mark = await ipcMark();
			const rc = await realRightClick(point.x, point.y, shotName);
			const labels = rc.appMenu?.map((i) => i.label) ?? [];
			const pinAt = labels.indexOf(PIN);
			judge(4, `${what}: a real right-click opens the app’s menu, not WebKit’s, with ${PIN} right after ${after}${before ? ` and before ${before}` : ''} (契約7 (ab))`, rc.appMenu !== null && !rc.popupFound && pinAt > 0 && labels[pinAt - 1] === after && (before === '' || labels[pinAt + 1] === before) && rc.appMenu![pinAt]!.disabled === false, { labels, popup_found: rc.popupFound, popup_titles: rc.popupTitles, pressed_target: rc.pressedTarget, shot: rc.answer?.shot ?? null });
			if (rc.appMenu === null) return;
			await clickMenuItem(PIN);
			const added = await waitIpc(mark, ['add_bookmark'], 1, 10_000);
			await waitEvent(ev, 'bookmarks_changed');
			const a = added[0]!.args as { uri?: string; kind?: string } | null;
			judge(4, `${what}: Pin → add_bookmark(${target}, '${kind}') once, ok, bookmarks_changed delivered`, added.length === 1 && a?.uri === target && a?.kind === kind && added[0]!.ok === true, { args: a, ok: added[0]!.ok });
			await openDashboard();
			const order = await tileOrder();
			judge(4, `${what}: the Dashboard has the new tile at the tail`, order[order.length - 1] === target, { order });
			await closeDashboard();
			// The same row now says Unpin, at the same position; pressing it removes the tile.
			const mark2 = await ipcMark();
			const ev2 = await eventsMark();
			const rc2 = await realRightClick(point.x, point.y);
			const labels2 = rc2.appMenu?.map((i) => i.label) ?? [];
			judge(4, `${what}: the same spot now shows ${UNPIN} at the same position`, labels2.indexOf(UNPIN) === pinAt && !labels2.includes(PIN), { labels: labels2 });
			if (rc2.appMenu === null) return;
			await clickMenuItem(UNPIN);
			const removed = await waitIpc(mark2, ['remove_bookmark'], 1, 10_000);
			await waitEvent(ev2, 'bookmarks_changed');
			await openDashboard();
			judge(4, `${what}: Unpin → remove_bookmark(${target}) once, the tile is gone`, removed.length === 1 && (removed[0]!.args as { uri?: string }).uri === target && !(await tileOrder()).includes(target), { order: await tileOrder() });
			await closeDashboard();
		}
		const fileRow = await rectOfTitled('.explorer-item', uri('alpha/a2.md'));
		if (!fileRow) throw new Error('no row for a2.md');
		await pinThrough('a file row (a2.md)', fileRow, 'file', uri('alpha/a2.md'), COPY_PATH, DUPLICATE, 'req83-gate4-file-row-menu');
		const dirRow = await rectOfTitled('.explorer-item', uri('alpha/inner'));
		if (!dirRow) throw new Error('no row for inner');
		await pinThrough('a folder row (inner)', dirRow, 'folder', uri('alpha/inner'), COPY_PATH, DUPLICATE, 'req83-gate4-folder-row-menu');
		await openDoc('alpha/notes.md', 'GATE83-NOTES');
		const margin = await marginPoint();
		if (!margin) throw new Error('no margin point in the viewer');
		await pinThrough('the document’s margin (notes.md)', { x: margin.x, y: margin.y, width: 0, height: 0 }, 'file', uri('alpha/notes.md'), RELOAD_FILE, '', 'req83-gate4-body-menu');
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 5
	it('gate 5: Add Bookmark… → Add Folder… / Add File… → the NSOpenPanel (a path typed by the driver) → the tile at the tail; Cancel adds nothing', async () => {
		if (!OPERATOR) {
			skipped(5, 'the open panel', 'needs the operator');
			return;
		}
		await ensureRoot('alpha', 'alpha/a1.md');
		await openDashboard();
		async function addThrough(item: string, kind: 'folder' | 'file', target: string | null, answer: 'open' | 'cancel'): Promise<void> {
			await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), ADD_TILE);
			const menu = await waitMenu();
			judge(5, `Add Bookmark… opens the two-item menu (Add Folder… / Add File…) (契約7 (ac))`, JSON.stringify(menu.map((i) => i.label)) === JSON.stringify(['Add Folder…', 'Add File…']), { menu });
			const mark = await ipcMark();
			const ev = await eventsMark();
			await clickMenuItem(item);
			// The request only: the panel's IPC answers when the panel closes (the 2026-11-05 run waited for the answer first).
			const opened = await waitIpcRequested(mark, ['plugin:dialog|open'], 1, 10_000).catch(() => [] as IpcRec[]);
			const options = JSON.stringify(opened[0]?.args ?? null);
			judge(5, `${item}: one OS open dialog asked with directory: ${kind === 'folder'} and the title Add Bookmark`, opened.length === 1 && options.includes(`"directory":${kind === 'folder'}`) && options.includes('Add Bookmark'), { args: opened[0]?.args ?? null });
			const panel = await operator('openpanel', { wait_s: 15, path: target ? target.slice('file://'.length) : '', answer }, 120_000);
			if (answer === 'open' && target && panel?.located !== true) {
				// The driver could not steer the panel to the path (it pressed Cancel, nothing was pinned): the environment, not the product.
				report(REPORT, { gate: 'environment', item: `${item}: the open panel could not be steered to ${target} (Go to the folder); Cancel was pressed`, reason: 'open panel not steerable', panel });
				skipped(5, `${item} + the path in the panel: add_bookmark(${target}, '${kind}')`, 'the panel was not at the asked path (environment row above)');
			} else if (answer === 'open' && target) {
				const added = await waitIpc(mark, ['add_bookmark'], 1, 20_000).catch(() => [] as IpcRec[]);
				const a = added[0]?.args as { uri?: string; kind?: string } | undefined;
				await waitEvent(ev, 'bookmarks_changed').catch(() => []);
				const order = await tileOrder();
				judge(5, `${item} + the path in the panel: add_bookmark(${target}, '${kind}') once, the tile is at the tail`, added.length === 1 && a?.uri === target && a?.kind === kind && order[order.length - 1] === target, { panel, args: a ?? null, order });
			} else {
				await browser.pause(2_000);
				judge(5, `${item} + Cancel: no add_bookmark, the tiles are as before`, (await ipcAfter(mark, ['add_bookmark'])).length === 0 && (await dashboardOpen()), { panel, ipc: (await ipcAfter(mark)).map((e) => e.cmd) });
			}
			judge(5, `${item}: the panel was found and is gone afterwards`, panel?.found === true && panel?.gone === true, { panel });
		}
		const before = await tileOrder();
		try {
			await addThrough('Add Folder…', 'folder', uri('gamma'), 'open');
			await addThrough('Add File…', 'file', uri('beta/b1.md'), 'open');
			await addThrough('Add Folder…', 'folder', null, 'cancel');
		} finally {
			// Whatever the panel added (the asked folder, or the panel's own folder when it
			// could not be steered — the 2026-11-05 run carried `home` into gates 6〜8) goes,
			// so the later gates see the seeded set.
			const restored = await restoreBookmarks(before);
			await browser.waitUntil(async () => JSON.stringify(await tileOrder()) === JSON.stringify(before), { timeout: 10_000, timeoutMsg: `the tiles did not return to the seeded set (${JSON.stringify(restored)})` }).catch((e: unknown) => report(REPORT, { gate: 5, item: 'tidy-up', error: String(e) }));
			fact(5, 'the bookmarks put back to the seeded set', restored);
		}
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 6
	it('gate 6: reorder — a real hover + drag of the grip, Move Up / Move Down (disabled at the ends), real Option + → / ← → move_bookmark and the new order; bookmarks.json follows', async () => {
		await ensureRoot('alpha', 'alpha/a1.md');
		await openDashboard();
		const start = await tileOrder();
		judge(6, 'the seeded order to start from', JSON.stringify(start) === JSON.stringify(SEEDED_TILES.map(uri)), { start });
		const first = start[0]!;
		// (a) a real drag of tile 0's grip onto tile 2.
		if (OPERATOR) {
			const t0 = await rectOf(`${TILE}[data-index="0"]`);
			const t2 = await rectOf(`${TILE}[data-index="2"]`);
			if (!t0 || !t2) throw new Error('tiles 0 / 2 are missing');
			refreshFrame(pid);
			// The grip: absolute, right: 8px, 16 px wide, vertically centred (Dashboard.svelte).
			const grip = toScreen(Math.round(t0.x + t0.width - 8 - 8), Math.round(t0.y + t0.height / 2));
			const dest = toScreen(Math.round(t2.x + t2.width / 2), Math.round(t2.y + t2.height / 2));
			let mark = await ipcMark();
			let ev = await eventsMark();
			// The hover's length is the driver's default (short: the tile's tooltip appears once the pointer rests ~1 s).
			const d = await operator('drag', { x1: grip.x, y1: grip.y, x2: dest.x, y2: dest.y, button: 'left', route: screen?.route ?? 'hid', hover: true });
			if (d && d.front === false) environment(6, 'the driver could not bring the window to the front for the drag', { answer: d });
			const moved = await waitIpc(mark, ['move_bookmark'], 1, 10_000).catch(() => [] as IpcRec[]);
			await waitEvent(ev, 'bookmarks_changed').catch(() => []);
			const a = moved[0]?.args as { uri?: string; to?: number } | undefined;
			const dragSent = (x: Record<string, unknown> | null) => ((x?.drag ?? null) as { sent?: string; error?: string; stderr?: string } | null);
			judge(6, 'a real hover + drag of the first tile’s grip onto the third tile (the drag was sent, not refused): move_bookmark(first, 2) once, the order is [2nd, 3rd, 1st, …], nothing was opened', dragSent(d)?.sent === 'drag' && moved.length === 1 && a?.uri === first && a?.to === 2 && JSON.stringify(await tileOrder()) === JSON.stringify([start[1], start[2], start[0], ...start.slice(3)]) && (await openSeq(mark)).length === 0 && (await dashboardOpen()), { drag: d, drag_refused: dragSent(d)?.error ?? null, drag_stderr: dragSent(d)?.stderr ?? null, args: a ?? null, order: await tileOrder(), opened: await openSeq(mark) });
			// A press on the grip released without moving: nothing (契約8 (af)).
			const t2b = await rectOf(`${TILE}[data-index="2"]`);
			const grip2 = toScreen(Math.round(t2b!.x + t2b!.width - 16), Math.round(t2b!.y + t2b!.height / 2));
			mark = await ipcMark();
			ev = await eventsMark();
			const d2 = await operator('drag', { x1: grip2.x, y1: grip2.y, x2: grip2.x, y2: grip2.y, button: 'left', route: screen?.route ?? 'hid', hover: true });
			await browser.pause(1_500);
			// Only a drag that was really sent proves anything (the 2026-11-05 run passed on a refusal).
			judge(6, 'the grip pressed and released without moving (the press was sent, not refused): no move_bookmark, nothing opened, the Dashboard stays', dragSent(d2)?.sent === 'drag' && (await ipcAfter(mark, ['move_bookmark'])).length === 0 && (await openSeq(mark)).length === 0 && (await dashboardOpen()), { drag: d2, drag_refused: dragSent(d2)?.error ?? null, drag_stderr: dragSent(d2)?.stderr ?? null, ipc: (await ipcAfter(mark)).map((e) => e.cmd) });
		} else {
			skipped(6, 'the real drag', 'needs the operator');
		}
		// (b) Move Up / Move Down through the tile's menu; the ends are disabled.
		// The subject is a tile in the middle: the dragged one (third now), or the second without the operator.
		let order = await tileOrder();
		const subject = order.indexOf(first) > 0 && order.indexOf(first) < order.length - 1 ? first : order[1]!;
		const idx = order.indexOf(subject);
		let menu = await tileMenu(subject);
		judge(6, 'the tile’s menu: Open, Open in New Window / Move Up, Move Down / Unpin from Bookmarks with two separators; Move Up and Move Down enabled in the middle (契約14)', JSON.stringify(menu.map((i) => i.label)) === JSON.stringify(['Open', 'Open in New Window', 'Move Up', 'Move Down', UNPIN]) && (await menuSeparators()) === 2 && menu.every((i) => !i.disabled), { menu, separators: await menuSeparators(), index: idx });
		let mark = await ipcMark();
		let ev = await eventsMark();
		await clickMenuItem('Move Up');
		let moved = await waitIpc(mark, ['move_bookmark'], 1, 10_000);
		await waitEvent(ev, 'bookmarks_changed');
		judge(6, 'Move Up: move_bookmark(uri, index − 1), the tile moved one place earlier', moved.length === 1 && (moved[0]!.args as { to?: number }).to === idx - 1 && (await tileOrder())[idx - 1] === subject, { args: moved[0]!.args, order: await tileOrder() });
		mark = await ipcMark();
		ev = await eventsMark();
		await tileMenu(subject);
		await clickMenuItem('Move Down');
		moved = await waitIpc(mark, ['move_bookmark'], 1, 10_000);
		await waitEvent(ev, 'bookmarks_changed');
		judge(6, 'Move Down: move_bookmark(uri, index + 1), the tile moved one place later', moved.length === 1 && (moved[0]!.args as { to?: number }).to === idx && (await tileOrder())[idx] === subject, { args: moved[0]!.args, order: await tileOrder() });
		order = await tileOrder();
		menu = await tileMenu(order[0]!);
		judge(6, 'the first tile: Move Up disabled, Move Down enabled', menu.find((i) => i.label === 'Move Up')?.disabled === true && menu.find((i) => i.label === 'Move Down')?.disabled === false, { menu });
		await closeMenu();
		menu = await tileMenu(order[order.length - 1]!);
		judge(6, 'the last tile: Move Down disabled, Move Up enabled', menu.find((i) => i.label === 'Move Down')?.disabled === true && menu.find((i) => i.label === 'Move Up')?.disabled === false, { menu });
		await closeMenu();
		// (c) real Option + → / ← on the focused tile; the focus follows the tile.
		if (OPERATOR) {
			order = await tileOrder();
			const target = order[1]!;
			await focusTitled(TILE, target);
			mark = await ipcMark();
			ev = await eventsMark();
			await realKey(KEY.right, ['opt']);
			moved = await waitIpc(mark, ['move_bookmark'], 1, 10_000).catch(() => [] as IpcRec[]);
			await waitEvent(ev, 'bookmarks_changed').catch(() => []);
			await browser.pause(500);
			let focus = await activeEl();
			judge(6, 'real Option + → on the second tile: move_bookmark(uri, 2), the tile is third, the focus followed it (契約8 (af))', moved.length === 1 && (moved[0]!.args as { uri?: string; to?: number }).uri === target && (moved[0]!.args as { to?: number }).to === 2 && (await tileOrder())[2] === target && focus.title === target, { args: moved[0]?.args ?? null, order: await tileOrder(), focus });
			mark = await ipcMark();
			ev = await eventsMark();
			await realKey(KEY.left, ['opt']);
			moved = await waitIpc(mark, ['move_bookmark'], 1, 10_000).catch(() => [] as IpcRec[]);
			await waitEvent(ev, 'bookmarks_changed').catch(() => []);
			await browser.pause(500);
			focus = await activeEl();
			judge(6, 'real Option + ←: move_bookmark(uri, 1), back to second, the focus followed', moved.length === 1 && (moved[0]!.args as { to?: number }).to === 1 && (await tileOrder())[1] === target && focus.title === target, { args: moved[0]?.args ?? null, order: await tileOrder(), focus });
			// At the end: Option + ← on the first tile does nothing.
			await focusTitled(TILE, (await tileOrder())[0]!);
			mark = await ipcMark();
			await realKey(KEY.left, ['opt']);
			await browser.pause(1_000);
			judge(6, 'real Option + ← on the first tile: no move_bookmark (the end stops)', (await ipcAfter(mark, ['move_bookmark'])).length === 0, {});
		} else {
			skipped(6, 'real Option + arrows', 'needs the operator');
		}
		const onDisk = bookmarksFile().map((b) => b.uri);
		judge(6, 'bookmarks.json holds the tiles in the shown order (契約9)', JSON.stringify(onDisk) === JSON.stringify(await tileOrder()), { disk: onDisk, order: await tileOrder() });
		fact(6, 'the order the restart phase must find again', { order: await tileOrder() });
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 7
	it('gate 7: missing — a deleted bookmark folder / file and a deleted recent folder are dimmed, a press leaves a note and removes nothing; Remove from Recent Folders removes the row (restart checks it stays removed)', async () => {
		await ensureRoot('gamma', 'gamma/g1.md');
		fs.rmSync(file('delta'), { recursive: true, force: true });
		fs.rmSync(file('gamma/gone.md'), { force: true });
		const mark0 = await ipcMark();
		await openDashboard();
		await waitIpc(mark0, ['list_missing_paths'], 1, 15_000).catch(() => undefined);
		await browser.waitUntil(async () => (await tiles()).some((t) => t.uri === uri('delta') && t.missing), { timeout: 15_000, timeoutMsg: 'the delta tile never turned missing' });
		// Every recent row (Show All), so the judgements do not depend on delta's place in the first 6 (reviewer P3-3).
		if ((await textOf(SHOW_ALL_BUTTON)) === 'Show All') {
			await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), SHOW_ALL_BUTTON);
			await browser.waitUntil(async () => (await textOf(SHOW_ALL_BUTTON)) === 'Show Less', { timeout: 5_000, timeoutMsg: 'Show All did not expand the rows' });
		}
		const ts = await tiles();
		const rs = await recentRows();
		judge(7, 'the deleted recent folder (delta) is among the rows shown (Show All pressed when there were more than 6)', rs.some((r) => r.uri === uri('delta')), { rows: rs.map((r) => r.uri) });
		judge(7, 'the deleted bookmark folder (delta) and file (gone.md) carry class missing; the others do not (契約6 (h))', ts.find((t) => t.uri === uri('delta'))?.missing === true && ts.find((t) => t.uri === uri('gamma/gone.md'))?.missing === true && ts.filter((t) => t.missing).length === 2, { tiles: ts.map((t) => ({ uri: t.uri, missing: t.missing })) });
		judge(7, 'the deleted recent folder (delta) row carries class missing; the others do not (契約10 (n))', rs.find((r) => r.uri === uri('delta'))?.missing === true && rs.filter((r) => r.missing).length === 1, { rows: rs.map((r) => ({ uri: r.uri, missing: r.missing })) });
		const missShot = await shot('req83-gate1-missing');
		fact(1, 'screenshot: the dimmed (missing) tile and row (the eye)', { shot: missShot });
		// A press on the missing folder: set_root fails → the note, the Dashboard stays, history keeps it.
		let mark = await ipcMark();
		await clickRecentRow(uri('delta'));
		await browser.waitUntil(async () => (await noteText()).startsWith(FOLDER_FAILED), { timeout: 15_000, timeoutMsg: `no "${FOLDER_FAILED}…" note` });
		judge(7, 'pressing the missing recent folder: set_root(delta) fails, the note "Could not open the folder: …" is shown, the Dashboard stays, history.json still has it (契約5 (aa)(h))', JSON.stringify(await openSeq(mark)) === JSON.stringify([`set_root:${uri('delta')} (failed)`]) && (await dashboardOpen()) && historyFile().includes(uri('delta')), { note: await noteText(), seq: await openSeq(mark), history: historyFile() });
		// A press on the missing file bookmark (under the current root gamma: no set_root): the note, bookmarks keep it.
		mark = await ipcMark();
		await clickTile(uri('gamma/gone.md'));
		await browser.waitUntil(async () => (await noteText()).startsWith(FILE_FAILED), { timeout: 15_000, timeoutMsg: `no "${FILE_FAILED}…" note` });
		judge(7, 'pressing the missing file bookmark: open_document fails (no set_root: it is under the root), the note "Could not open the file: …", the Dashboard stays, bookmarks.json still has both', JSON.stringify(await openSeq(mark)) === JSON.stringify([`open_document:${uri('gamma/gone.md')} (failed)`]) && (await dashboardOpen()) && bookmarksFile().some((b) => b.uri === uri('gamma/gone.md')) && bookmarksFile().some((b) => b.uri === uri('delta')), { note: await noteText(), seq: await openSeq(mark), bookmarks: bookmarksFile() });
		// Remove from Recent Folders.
		const menu = await recentRowMenu(uri('delta'));
		judge(7, 'the recent row’s menu: Open, Open in New Window / Unpin from Bookmarks (delta is pinned) / Remove from Recent Folders (契約14)', JSON.stringify(menu.map((i) => i.label)) === JSON.stringify(['Open', 'Open in New Window', UNPIN, 'Remove from Recent Folders']) && (await menuSeparators()) === 2, { menu, separators: await menuSeparators() });
		mark = await ipcMark();
		await clickMenuItem('Remove from Recent Folders');
		const removed = await waitIpc(mark, ['remove_history_entry'], 1, 10_000);
		await browser.waitUntil(async () => !(await recentRows()).some((r) => r.uri === uri('delta')), { timeout: 10_000, timeoutMsg: 'the delta row is still there' });
		judge(7, 'Remove from Recent Folders: remove_history_entry(delta) once, the row is gone, history.json no longer has it, bookmarks.json still does (契約10)', removed.length === 1 && (removed[0]!.args as { uri?: string }).uri === uri('delta') && !historyFile().includes(uri('delta')) && bookmarksFile().some((b) => b.uri === uri('delta')), { history: historyFile(), rows: (await recentRows()).map((r) => r.uri) });
		judge(7, 'the provisional root behind the launch Dashboard (cwd) never reached history.json (契約1)', !historyFile().includes(uri('cwd')), { history: historyFile() });
		ran.gate7 = true;
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 8
	it('gate 8: Recently Modified — a file written outside is first (Just now, folder › subfolder); unopenable and excluded names are not listed; in N folders; a huge tree is cut at 2 s (truncated + the note; timing and reach recorded)', async () => {
		await ensureRoot('alpha', 'alpha/a1.md');
		writeNow(file('beta/docs/fresh-outside.md'), '# fresh outside\n\nGATE83-FRESH-OUTSIDE\n');
		await openDashboard();
		let scan = await rescan();
		let list = await modifiedRows();
		const first = list[0];
		judge(8, 'a file written by another process (beta/docs/fresh-outside.md) is the first row: name, "beta › docs", "Just now" (契約12)', first?.uri === uri('beta/docs/fresh-outside.md') && first.name === 'fresh-outside.md' && JSON.stringify(first.segments) === JSON.stringify(['beta', 'docs']) && first.when === 'Just now', { first: first ?? null, rows: list.map((r) => r.uri), scan_ms: scan.t1 === null ? null : Math.round(scan.t1 - scan.t0) });
		judge(8, 'at most 8 rows, newest first (契約12 (m))', list.length <= 8 && list.length > 0, { count: list.length });
		// Unopenable / excluded files, newer than everything: not listed, not even by the scan's result.
		writeNow(file('alpha/archive.zip'), 'PK');
		writeNow(file('alpha/.hidden.md'), '# hidden\n');
		writeNow(file('alpha/node_modules/n.md'), '# n\n');
		writeNow(file('alpha/target/t.md'), '# t\n');
		scan = await rescan();
		list = await modifiedRows();
		const body = scan.body as { files?: Array<{ uri: string; folder: string; modified: number }>; folders?: number; truncated?: boolean } | null;
		const shown = list.map((r) => r.uri);
		const banned = [uri('alpha/archive.zip'), uri('alpha/.hidden.md'), uri('alpha/node_modules/n.md'), uri('alpha/target/t.md')];
		judge(8, 'an unopenable type (.zip), a dot-name (files.exclude) and node_modules / target (search.exclude) are not listed, though newest (契約11 (j))', banned.every((u) => !shown.includes(u)) && (body?.files ?? []).every((f) => !banned.includes(f.uri)) && shown[0] === uri('beta/docs/fresh-outside.md'), { shown, result_files: (body?.files ?? []).map((f) => f.uri) });
		const targets = expectedScanTargets();
		const sub = await textOf(`${DASH} .dashboard-recently-modified .sub`);
		judge(8, `"in N folders" = the readable local targets (history locals + bookmark folders, deduped, missing ones skipped) = ${targets.length} (契約11・12 (al))`, body?.folders === targets.length && sub === (targets.length === 1 ? 'in 1 folder' : `in ${targets.length} folders`), { folders: body?.folders ?? null, sub, targets });
		judge(8, 'the small tree is not cut (truncated: false, no note)', body?.truncated === false && !(await exists(SCAN_NOTE)), { truncated: body?.truncated ?? null });
		// The huge tree: pinned as a folder bookmark for this scan only.
		if (!fs.existsSync(file('big'))) {
			fact(8, 'no big/ tree in the fixtures (VELLIS_GATE_REQ83_BIG_FOLDERS unset): the 2-second cut is not exercised', {});
		} else {
			const entries = Number(execFileSync('sh', ['-c', `find "${file('big')}" | wc -l`], { encoding: 'utf8' }).trim());
			await invokeFromPage('add_bookmark', { uri: uri('big'), kind: 'folder' });
			await browser.waitUntil(async () => (await tileOrder()).includes(uri('big')), { timeout: 10_000, timeoutMsg: 'the big tile did not appear' });
			await clearEventRecord();
			const ev = await eventsMark();
			scan = await rescan();
			const b = scan.body as { files?: Array<{ uri: string; folder: string; modified: number }>; folders?: number; truncated?: boolean } | null;
			const ms = scan.t1 === null ? null : Math.round(scan.t1 - scan.t0);
			const progress = (await eventsAfter(ev, 'recently_modified_progress')).map((e) => e.payload as { generation: number; files: Array<{ uri: string; modified: number }>; truncated: boolean });
			const sortedAndShort = progress.every((p) => p.files.length <= 8 && p.files.every((f, i) => i === 0 || p.files[i - 1]!.modified >= f.modified));
			// How far the scan got: the highest big/ folder number among every file it reported — the
			// result and every progress event (big's files are the newest of all: req83-fixtures.sh gives
			// them future mtimes, so a cut scan's top 8 are big's; the 2026-11-05 run had none of them).
			const bigIndex = (u: string) => Number(/\/big\/d(\d+)\//.exec(u)?.[1] ?? NaN);
			const seen = [...(b?.files ?? []).map((f) => f.uri), ...progress.flatMap((p) => p.files.map((f) => f.uri))].filter((u) => !Number.isNaN(bigIndex(u)));
			const newest = (b?.files ?? []).find((f) => !Number.isNaN(bigIndex(f.uri)))?.uri ?? '';
			const farthest = seen.length > 0 ? Math.max(...seen.map(bigIndex)) : null;
			const noteShown = await exists(SCAN_NOTE);
			const noteText = noteShown ? await textOf(SCAN_NOTE) : '';
			fact(8, '確かめること 7: the huge tree — entries on disk, the scan’s wall time, how far it got (folder i’s files carry mtime base + i s, so the highest folder number reported is the farthest folder listed; folders are read 8 at a time, so this is approximate)', { entries, scan_ms: ms, truncated: b?.truncated ?? null, folders: b?.folders ?? null, newest, farthest_folder_index: farthest, big_files_reported: seen.length, result_files: (b?.files ?? []).map((f) => f.uri), progress_events: progress.length });
			judge(8, 'the cut scan reported at least one file of the huge tree (its files are the newest), so the reach is measurable', seen.length > 0, { big_files_reported: seen.length, result_files: (b?.files ?? []).map((f) => f.uri) });
			if (b?.truncated === true) {
				judge(8, 'the huge tree: the scan is cut (truncated: true) within 2 s + the IPC’s slack (≤ 2 800 ms), the note is shown (契約12 (l)(al))', ms !== null && ms <= 2_800 && noteShown && noteText === SCAN_TRUNCATED_MESSAGE, { scan_ms: ms, note: noteText });
				judge(8, 'the progress events each carry ≤ 8 files, newest first, and at least one arrived (契約12 (aj))', progress.length >= 1 && sortedAndShort, { progress_events: progress.length });
				const truncShot = await shot('req83-gate1-truncated');
				fact(1, 'screenshot: the truncation note under Recently Modified (the eye: how it stands out)', { shot: truncShot });
			} else {
				report(REPORT, { gate: 'environment', item: `the big tree (${entries} entries) was scanned in full in ${ms} ms: too small for the 2-second cut — rerun with a larger VELLIS_GATE_REQ83_BIG_FOLDERS / VELLIS_GATE_REQ83_BIG_FILES`, reason: 'fixture too small', entries, scan_ms: ms });
			}
			await invokeFromPage('remove_bookmark', { uri: uri('big') });
			await browser.waitUntil(async () => !(await tileOrder()).includes(uri('big')), { timeout: 10_000, timeoutMsg: 'the big tile did not go' });
			scan = await rescan();
			judge(8, 'with the huge tree unpinned the scan is whole again (truncated: false)', (scan.body as { truncated?: boolean } | null)?.truncated === false, {});
		}
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 10
	it('gate 10: keyboard only (real keys) — the first tile on open, → / ← / ↓ / ↑ on the grid, Tab to Recent Folders → Show All → Recently Modified → Rescan, ↑ / ↓ on the rows, Return opens; the focus ring is shot', async () => {
		if (!OPERATOR) {
			skipped(10, 'real keys', 'needs the operator');
			return;
		}
		await ensureRoot('alpha', 'alpha/a1.md');
		await openDashboard();
		let focus = await activeEl();
		judge(10, 'on open the first tile has the focus (契約13 (o))', focus.part === 'tile' && focus.index === 0, { focus });
		const cols = await columnCount();
		const count = (await tiles()).length + 1; // Add Bookmark… counts as a tile
		await realKey(KEY.right);
		focus = await activeEl();
		judge(10, 'real →: the second tile', focus.part === 'tile' && focus.index === 1, { focus });
		const ring = await rectOf(`${TILE}[data-index="1"]`);
		if (ring) {
			const z = await zoomedShot('req83-gate10-focus-ring-tile', { x: ring.x - 6, y: ring.y - 6, width: ring.width + 12, height: ring.height + 12 }, 2);
			fact(10, 'screenshot: the focus ring on a tile, ×2 (the eye)', { shot: z });
		}
		await realKey(KEY.left);
		focus = await activeEl();
		judge(10, 'real ←: back to the first tile', focus.part === 'tile' && focus.index === 0, { focus });
		await realKey(KEY.left);
		focus = await activeEl();
		judge(10, 'real ← at the start: stays (no wrap)', focus.part === 'tile' && focus.index === 0, { focus });
		await realKey(KEY.down);
		focus = await activeEl();
		const expectDown = cols < count ? cols : 0;
		judge(10, `real ↓: the same column of the next row (index ${expectDown} with ${cols} columns and ${count} tiles incl. Add Bookmark…)`, (focus.part === 'tile' || focus.part === 'add-bookmark') && focus.index === expectDown, { focus, columns: cols, count });
		await realKey(KEY.up);
		focus = await activeEl();
		judge(10, 'real ↑: back to the first tile', focus.part === 'tile' && focus.index === 0, { focus });
		await realKey(KEY.tab);
		focus = await activeEl();
		judge(10, 'real Tab from the tiles: the Recent Folders rows (one stop per section; the first row) (契約13 (am))', focus.part === 'recent' && focus.index === 0, { focus });
		const rowRing = await rectOf(`${RECENT_ROW}`);
		if (rowRing) {
			const z = await zoomedShot('req83-gate10-focus-ring-row', { x: rowRing.x - 6, y: rowRing.y - 6, width: rowRing.width + 12, height: rowRing.height + 12 }, 2);
			fact(10, 'screenshot: the focus ring on a row, ×2 (the eye)', { shot: z });
		}
		await realKey(KEY.down);
		focus = await activeEl();
		judge(10, 'real ↓ on the rows: the second row', focus.part === 'recent' && focus.index === 1, { focus });
		await realKey(KEY.up);
		await realKey(KEY.up);
		focus = await activeEl();
		judge(10, 'real ↑ ↑: the first row, no wrap', focus.part === 'recent' && focus.index === 0, { focus });
		const hasShowAll = await exists(SHOW_ALL_BUTTON);
		await realKey(KEY.tab);
		focus = await activeEl();
		if (hasShowAll) judge(10, 'real Tab from the rows: Show All', focus.part === 'show-all', { focus });
		else fact(10, 'no Show All (6 or fewer recent folders): the Tab went on', { focus });
		if (hasShowAll) await realKey(KEY.tab);
		focus = await activeEl();
		const hasModified = (await modifiedRows()).length > 0;
		judge(10, `real Tab: ${hasModified ? 'the Recently Modified rows' : 'Rescan (no Recently Modified rows)'}`, hasModified ? focus.part === 'modified' && focus.index === 0 : focus.part === 'rescan', { focus });
		if (hasModified) {
			await realKey(KEY.tab);
			focus = await activeEl();
			judge(10, 'real Tab: the Rescan button', focus.part === 'rescan', { focus });
		}
		// Back from Rescan: over the Recently Modified rows (if any) and Show All (if any) to the Recent Folders rows.
		const backs = 1 + (hasModified ? 1 : 0) + (hasShowAll ? 1 : 0);
		for (let i = 0; i < backs; i++) await realKey(KEY.tab, ['shift']);
		focus = await activeEl();
		judge(10, 'real Shift + Tab back: the Recent Folders rows again, at the row last focused (the first)', focus.part === 'recent' && focus.index === 0, { focus });
		// Return on a row opens it.
		await focusTitled(RECENT_ROW, uri('beta'));
		let mark = await ipcMark();
		await realKey(KEY.return);
		await waitGone(DASH, 'Return on the beta row', 30_000);
		await waitForExplorerRow(uri('beta/b1.md'), { timeout: 30_000 });
		judge(10, 'real Return on a Recent Folders row: set_root(beta) (契約13)', JSON.stringify(await openSeq(mark)) === JSON.stringify([`set_root:${uri('beta')}`]), { seq: await openSeq(mark) });
		// Space on a tile opens it too.
		await openDashboard();
		await focusTitled(TILE, uri('alpha/a1.md'));
		mark = await ipcMark();
		await realKey(KEY.space);
		await waitGone(DASH, 'Space on the a1 tile', 30_000);
		await waitViewerText('GATE83-A1');
		judge(10, 'real Space on a file tile: opened like Return (set_root(alpha) + open_document)', JSON.stringify(await openSeq(mark)) === JSON.stringify([`set_root:${uri('alpha')}`, `open_document:${uri('alpha/a1.md')}`]), { seq: await openSeq(mark) });
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 11
	it('gate 11: during the Dashboard — Find in Folder / Recent Files / Go to Path / Print / Zoom / Edit / Find / Reload File / New Tab (events and real keys) do nothing; Save writes the edit behind; Duplicate Window opens a Dashboard window', async () => {
		await ensureRoot('alpha', 'alpha/plain.txt');
		writeAtomic(file('alpha/plain.txt'), PLAIN_ORIGINAL);
		await browser.pause(400);
		judge(11, 'the editor took the edit (plain.txt behind the Dashboard)', await makeDirty(PLAIN_EDITED), {});
		await openDashboard();
		const zoomBefore = await browser.execute(() => {
			try {
				return { viewer: localStorage.getItem('vellis.viewer-zoom'), explorer: localStorage.getItem('vellis.explorer-zoom') };
			} catch {
				return null;
			}
		});
		const windowsBefore = await operator('windows');
		const noops = ['menu_find_in_folder', 'menu_recent_files', 'menu_go_to', 'menu_print', 'menu_zoom_in', 'menu_zoom_out', 'menu_zoom_reset', 'menu_edit', 'menu_find', 'menu_reload_file', 'menu_new_tab'];
		const benign = ['list_missing_paths', 'scan_recently_modified', 'list_history', 'list_bookmarks', 'plugin:event|emit', 'plugin:event|listen', 'plugin:event|unlisten'];
		let mark = await ipcMark();
		for (const ev of noops) {
			await emitMenu(ev);
			await browser.pause(400);
		}
		await browser.pause(1_000);
		const stillNothing = async () => ({
			dashboard: await dashboardOpen(),
			find_in_folder: await exists('[data-testid="find-in-folder"]'),
			recent_files: await exists('[data-testid="recent-files"]'),
			go_to: await exists('[data-testid="go-to-bar"]'),
			find_bar: await exists('[data-testid="find-bar"]'),
			editor: await exists('[contenteditable="true"]'),
			ipc: (await ipcAfter(mark)).map((e) => e.cmd).filter((c) => !benign.includes(c)),
		});
		let s = await stillNothing();
		const zoomAfter = await browser.execute(() => {
			try {
				return { viewer: localStorage.getItem('vellis.viewer-zoom'), explorer: localStorage.getItem('vellis.explorer-zoom') };
			} catch {
				return null;
			}
		});
		// Key by key (JSON.stringify saw the keys in another order = the 2026-11-05 run's red).
		const zoomSame = zoomBefore !== null && zoomAfter !== null && zoomBefore.viewer === zoomAfter.viewer && zoomBefore.explorer === zoomAfter.explorer;
		judge(11, 'the 11 menu events: the Dashboard stays, no panel / bar / editor, no IPC beyond the Dashboard’s own, the zoom storage unchanged (契約15 (q)(y))', s.dashboard && !s.find_in_folder && !s.recent_files && !s.go_to && !s.find_bar && !s.editor && s.ipc.length === 0 && zoomSame, { ...s, zoomBefore, zoomAfter });
		if (OPERATOR) {
			mark = await ipcMark();
			const km = await keysMark();
			const keys: Array<[number, string[], string]> = [
				[KEY.e, ['cmd'], 'Command + E (Edit)'],
				[KEY.f, ['cmd'], 'Command + F (Find)'],
				[KEY.f, ['cmd', 'shift'], 'Shift + Command + F (Find in Folder…)'],
				[KEY.g, ['cmd', 'shift'], 'Shift + Command + G (Go to Path…)'],
				[KEY.r, ['cmd', 'shift'], 'Shift + Command + R (Recent Files)'],
				[KEY.r, ['cmd'], 'Command + R (Reload File)'],
				[KEY.t, ['cmd'], 'Command + T (New Tab)'],
				[KEY.p, ['cmd'], 'Command + P (Print…)'],
			];
			for (const [code, mods] of keys) await realKey(code, mods);
			await browser.pause(1_000);
			const dialogs = await operator('dialog', { wait_s: 2, expect: '', answer: 'escape' });
			s = await stillNothing();
			const windowsAfter = await operator('windows');
			judge(11, `the real keys ${keys.map((k) => k[2]).join(', ')}: the Dashboard stays, no panel / bar / editor / dialog / new window, no IPC beyond the Dashboard’s own`, s.dashboard && !s.find_in_folder && !s.recent_files && !s.go_to && !s.find_bar && !s.editor && s.ipc.length === 0 && (dialogs?.dialogs ?? 0) === 0 && windowsAfter?.count === windowsBefore?.count, { ...s, dialogs, windows_before: windowsBefore?.count ?? null, windows_after: windowsAfter?.count ?? null, keydowns_seen_by_page: (await keysAfter(km)).map((k) => `${k.meta ? 'cmd+' : ''}${k.shift ? 'shift+' : ''}${k.key}`) });
			// A window a key opened by mistake (a product red) must not stay on the screen: close what is new.
			if ((windowsAfter?.count as number) > (windowsBefore?.count as number)) {
				const old = (windowsBefore?.windows ?? []) as Array<{ x: number; y: number; title: string }>;
				for (const w of ((windowsAfter?.windows ?? []) as Array<{ index: number; x: number; y: number; title: string }>).filter((w) => !old.some((o) => o.x === w.x && o.y === w.y && o.title === w.title)).reverse()) {
					await operator('close', { win: w });
				}
				await operator('make-front');
			}
		} else {
			skipped(11, 'the real keys', 'needs the operator');
		}
		// Save (the event): the edit behind is written, the Dashboard stays.
		mark = await ipcMark();
		await emitMenu('menu_save');
		const saved = await waitIpc(mark, ['save_document'], 1, 10_000).catch(() => [] as IpcRec[]);
		await browser.pause(500);
		judge(11, 'Save (the menu event) during the Dashboard: save_document once, the edit is on the disk, the Dashboard stays (契約15 (y))', saved.length === 1 && saved[0]!.ok === true && fs.readFileSync(file('alpha/plain.txt'), 'utf8').startsWith('first line edited\nsecond line') && (await dashboardOpen()), { save: saved.map((e) => ({ uri: e.uri, ok: e.ok })), disk: fs.readFileSync(file('alpha/plain.txt'), 'utf8') });
		if (OPERATOR) {
			await closeDashboard();
			judge(11, 'the editor took a second edit', await makeDirty(PLAIN_AGAIN), {});
			await openDashboard();
			mark = await ipcMark();
			await realKey(KEY.s, ['cmd']);
			const saved2 = await waitIpc(mark, ['save_document'], 1, 10_000).catch(() => [] as IpcRec[]);
			await browser.pause(500);
			judge(11, 'a real Command + S during the Dashboard: save_document once, the disk has the second edit, the Dashboard stays', saved2.length === 1 && fs.readFileSync(file('alpha/plain.txt'), 'utf8').startsWith('first line again') && (await dashboardOpen()), { disk: fs.readFileSync(file('alpha/plain.txt'), 'utf8') });
		}
		// Duplicate Window: a new window, a Dashboard (root null), read by AX.
		if (OPERATOR) {
			const before = await operator('windows');
			mark = await ipcMark();
			await emitMenu('menu_duplicate_window');
			const nw = await waitIpc(mark, ['new_window'], 1, 15_000).catch(() => [] as IpcRec[]);
			let after: Record<string, unknown> | null = null;
			const deadline = Date.now() + 20_000;
			while (Date.now() < deadline) {
				after = await operator('windows');
				if ((after?.count as number) > (before?.count as number)) break;
				await browser.pause(500);
			}
			const wins = (after?.windows ?? []) as Array<{ index: number; x: number; y: number; title: string }>;
			const old = (before?.windows ?? []) as Array<{ index: number; x: number; y: number; title: string }>;
			const fresh = wins.find((w) => !old.some((o) => o.x === w.x && o.y === w.y && o.title === w.title)) ?? wins[wins.length - 1];
			await browser.pause(2_000);
			const texts = fresh ? (((await operator('texts', { win: fresh }))?.texts ?? []) as string[]) : [];
			judge(11, 'Duplicate Window during the Dashboard: new_window with root null, a new window whose AX texts carry the Dashboard’s headings (契約15 (q))', nw.length === 1 && JSON.stringify(nw[0]!.args).includes('"root":null') && !!fresh && (after?.count as number) === (before?.count as number) + 1 && ci(texts, 'recent folders') && ci(texts, 'bookmarks'), { new_window_args: nw[0]?.args ?? null, windows_before: before?.count ?? null, windows_after: after?.count ?? null, fresh, texts_sample: texts.slice(0, 12) });
			if (fresh) await operator('close', { win: fresh });
			await operator('make-front');
		}
		await closeDashboard();
		writeAtomic(file('alpha/plain.txt'), PLAIN_ORIGINAL);
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 12
	it('gate 12: two windows — a Pin here is a tile there (AX texts), a real Option + → there reorders here, a real right-click on its tile + Unpin (AX) removes it here and the Explorer row says Pin again', async () => {
		if (!OPERATOR) {
			skipped(12, 'the second window', 'needs the operator');
			return;
		}
		await ensureRoot('alpha', 'alpha/a2.md');
		await closeDashboard();
		const keep = await bookmarkUris();
		const nw = await operator('new-window', {}, 60_000);
		// The windows are named by {title, x, y} (AX indexes follow the z-order and shift
		// between calls; a hovered tile's tooltip is an untitled AX window — the 2026-11-05
		// run picked it as W1 and closed the webdriver's window). The driver resolves the
		// index right before every step, and says which window it acted on.
		const w2 = (nw?.win ?? null) as AxWin | null;
		const w1 = (nw?.w1 ?? null) as AxWin | null;
		const w2Texts = (nw?.texts ?? []) as string[];
		judge(12, 'File ▸ New Window (AX): a second STANDARD, titled window appeared, whose AX texts carry the Dashboard’s headings (an argument-less window = the Dashboard); the window that was main before is W1', !!w2 && !!w1 && w2.title !== '' && w1.title === 'alpha' && ci(w2Texts, 'bookmarks') && ci(w2Texts, 'recent folders'), { answer: nw });
		if (!w2 || !w1) return;
		fact(12, 'the two windows as AX lists them (standard windows only)', { w1, w2, before: nw?.before, after: nw?.after });
		try {
			// (a) Pin here (W1's Explorer) → a tile there (W2's AX texts).
			await operator('make-front', { win: w1 });
			await ensureFront(pid);
			let menu = await rowMenu(uri('alpha/a2.md'));
			judge(12, 'W1: the a2.md row offers Pin to Bookmarks', menu.some((i) => i.label === PIN), { menu });
			// W2's Recently Modified may list a2.md too (reviewer P2-1): what the Pin adds is judged as a
			// difference — the tile's name AND its second line (the parent's path, `parentPathOf`) both
			// occur once more than before the Pin.
			const tb = await operator('texts', { win: w2 });
			const t2Before = (tb?.texts ?? []) as string[];
			let ev = await eventsMark();
			await clickMenuItem(PIN);
			await waitEvent(ev, 'bookmarks_changed');
			await browser.pause(1_000);
			const ta = await operator('texts', { win: w2 });
			let t2 = (ta?.texts ?? []) as string[];
			const a2Path = file('alpha');
			const counts = { name_before: countCi(t2Before, 'a2.md'), name_after: countCi(t2, 'a2.md'), path_before: countCi(t2Before, a2Path), path_after: countCi(t2, a2Path) };
			judge(12, 'W2 (AX texts): after the Pin in W1 the texts carry one more "a2.md" and one more of the tile’s path line (the new tile; the Recently Modified row does not count) (契約9 (ap))', tb?.error === undefined && ta?.error === undefined && counts.name_after > counts.name_before && counts.path_after > counts.path_before, { ...counts, index_before: tb?.index ?? null, index_after: ta?.index ?? null, texts_with_a2_after: t2.filter((t) => t.includes('a2')) });
			// (b) a real Option + → in W2 (its focus is on its first tile) → W1's Dashboard order changes.
			// The key goes only when realinput's focused window IS W2 (`focused_matches`).
			await openDashboard();
			const before = await tileOrder();
			ev = await eventsMark();
			const k1 = await realKey(KEY.right, ['opt'], { win: w2 });
			await waitEvent(ev, 'bookmarks_changed').catch(() => []);
			await browser.pause(800);
			const after = await tileOrder();
			judge(12, 'a real Option + → in W2 (W2 was the focused window when the key went): W1’s tiles show the first tile moved to second (契約8・9)', k1?.focused_matches === true && k1?.sent === true && JSON.stringify(after) === JSON.stringify([before[1], before[0], ...before.slice(2)]), { before, after, focused_window: k1?.focused_window ?? null, focused_matches: k1?.focused_matches ?? null });
			ev = await eventsMark();
			const k2 = await realKey(KEY.left, ['opt'], { win: w2 });
			await waitEvent(ev, 'bookmarks_changed').catch(() => []);
			await browser.pause(800);
			judge(12, 'a real Option + ← in W2: W1’s order is back', k2?.focused_matches === true && k2?.sent === true && JSON.stringify(await tileOrder()) === JSON.stringify(before), { order: await tileOrder(), focused_matches: k2?.focused_matches ?? null });
			// (c) a real right-click on W2's a2.md tile → its menu (AX) → Unpin by AX → W1 loses the tile; the row says Pin again.
			// The tile, not the Recently Modified row of the same name: prefer the button whose AX text
			// holds the tile's path line (the parent's path); a row's text holds the folder's name only.
			const found = await operator('find', { win: w2, text: 'a2.md' });
			const els = ((found?.elements ?? []) as Array<{ role: string; text: string; x: number; y: number; w: number; h: number }>).filter((e) => e.w > 0 && e.h > 0);
			const tile = els.find((e) => e.role === 'AXButton' && e.text.includes(a2Path)) ?? els.find((e) => e.role === 'AXButton') ?? els.find((e) => e.text.includes(a2Path)) ?? els[0];
			judge(12, 'W2 (AX find): the a2.md tile has a frame inside W2', !!tile && found?.error === undefined && tile.x >= w2.x && tile.y >= w2.y, { elements: els, index: found?.index ?? null, w2 });
			if (tile) {
				ev = await eventsMark();
				const mark = await ipcMark();
				const rc = await operator('rclick', { x: Math.round(tile.x + tile.w / 2), y: Math.round(tile.y + tile.h / 2), route: 'hid', win: w2, shot: 'req83-gate12-w2-tile-menu' });
				const popupAfter = (rc?.popup_after ?? null) as { found?: boolean } | null;
				if (popupAfter?.found === true) environment(12, 'WebKit’s menu could not be closed after the right-click in W2', { answer: rc });
				await browser.pause(600);
				const tm = await operator('texts', { win: w2 });
				t2 = (tm?.texts ?? []) as string[];
				judge(12, 'W2: the right-click landed on W2 (the topmost window at the point) and its tile menu is open (AX texts carry Open, Open in New Window, Move Up, Move Down, Unpin from Bookmarks), no WebKit menu', rc?.target_ok === true && ['Open', 'Open in New Window', 'Move Up', 'Move Down', UNPIN].every((l) => ci(t2, l)) && (rc?.popup as { found?: boolean } | null)?.found !== true, { rclick: rc, menu_texts: t2.filter((t) => ['Open', 'Open in New Window', 'Move Up', 'Move Down', UNPIN].some((l) => t.toLowerCase().includes(l.toLowerCase()))) });
				const pressed = await operator('press', { win: w2, text: UNPIN });
				await waitEvent(ev, 'bookmarks_changed').catch(() => []);
				await browser.pause(800);
				judge(12, 'Unpin pressed in W2 (AX): W1’s Dashboard no longer has the a2.md tile, and W1 made no IPC of its own', pressed?.pressed === true && !(await tileOrder()).includes(uri('alpha/a2.md')) && (await ipcAfter(mark, ['remove_bookmark', 'add_bookmark', 'move_bookmark'])).length === 0, { pressed, order: await tileOrder() });
			}
			await closeDashboard();
			await operator('make-front', { win: w1 });
			menu = await rowMenu(uri('alpha/a2.md'));
			judge(12, 'W1: the a2.md row offers Pin to Bookmarks again (the Unpin came from W2)', menu.some((i) => i.label === PIN) && !menu.some((i) => i.label === UNPIN), { menu });
			await closeMenu();
		} finally {
			// Only W2 is closed (the driver checks the title at the index before pressing its close button).
			const closed = await operator('close', { win: w2 });
			const closedWin = (closed?.closed ?? null) as AxWin | null;
			const left = (closed?.windows ?? []) as AxWin[];
			judge(12, 'the window closed was W2 and only W1 is left', closedWin?.title === w2.title && left.length === 1 && left[0]!.title === w1.title, { closed });
			await operator('make-front', { win: w1 });
			// Whatever this gate left pinned (a2.md when the Unpin in W2 did not happen) goes.
			const restored = await restoreBookmarks(keep);
			fact(12, 'the second window closed; the bookmarks put back to the set before this gate', { closed: closedWin, restored });
		}
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 14 (追補a)
	// Runs after the other gates (it takes rows out of the history for good; gate 7's
	// Remove from Recent Folders and gate 10's Tab order are judged before it).
	it('gate 14 (追補a): a Recent Folders row’s × — shown by a real hover (light / dark shots), a real click removes the row (remove_history_entry once, no open, no dialog, gone from history.json) and leaves the focus on the tile; a real Delete key removes the focused row and the focus moves to the row in its place; Command + Delete does not', async () => {
		if (!OPERATOR) {
			skipped(14, 'the row’s × and the Delete key', 'needs the operator (real mouse and keys)');
			return;
		}
		await ensureRoot('alpha', 'alpha/a1.md');
		await openDashboard();
		/** The × of the row titled `u`: its computed visibility and its rect (the wrap `.recent-row` holds the row button and the × as siblings). */
		const removeOf = (u: string) =>
			browser.execute(
				(sel, t) => {
					const row = Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.title === t);
					const x = row?.parentElement?.querySelector<HTMLElement>('.recent-remove') ?? null;
					if (!row || !x) return null;
					const r = x.getBoundingClientRect();
					const rr = row.parentElement!.getBoundingClientRect();
					return { visibility: getComputedStyle(x).visibility, label: x.getAttribute('aria-label'), tabindex: x.getAttribute('tabindex'), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, rowRect: { x: rr.x, y: rr.y, width: rr.width, height: rr.height } };
				},
				RECENT_ROW,
				u,
			);
		const visibilities = () =>
			browser.execute((sel) => Array.from(document.querySelectorAll<HTMLElement>(sel)).map((x) => getComputedStyle(x).visibility), `${DASH} .recent-remove`);
		const row1 = uri('e1');
		const row2 = uri('e2');
		const row3 = uri('e3');
		// Every row shown must be there to be removed; Show All so e1〜e3 are on the screen whatever the order.
		if ((await textOf(SHOW_ALL_BUTTON)) === 'Show All') {
			await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), SHOW_ALL_BUTTON);
			await browser.waitUntil(async () => (await textOf(SHOW_ALL_BUTTON)) === 'Show Less', { timeout: 5_000, timeoutMsg: 'Show All did not expand the rows' });
		}
		const before = await removeOf(row1);
		judge(14, 'every row has a × (aria-label Remove from Recent Folders, tabindex −1) that is hidden while nothing is hovered or focused inside the row (契約10 追補a)', !!before && before.visibility === 'hidden' && before.label === 'Remove from Recent Folders' && before.tabindex === '-1' && (await visibilities()).every((v) => v === 'hidden'), { before, all: await visibilities() });
		if (!before) throw new Error(`no × for ${row1}`);
		// 1. A real hover on the row shows its ×; off the row it hides again. Light / dark shots of the hovered row.
		refreshFrame(pid);
		const centre = toScreen(Math.round(before.rowRect.x + before.rowRect.width / 2), Math.round(before.rowRect.y + before.rowRect.height / 2));
		const hover = await operator('hover', { x: centre.x, y: centre.y, route: screen?.route ?? 'hid' });
		await browser.pause(400);
		const during = await removeOf(row1);
		judge(14, 'a real hover on the row: its × turns visible, the other rows’ stay hidden', hover?.front === true && during?.visibility === 'visible' && (await visibilities()).filter((v) => v === 'visible').length === 1, { hover, during, all: await visibilities() });
		const shots: Record<string, string | null> = {};
		for (const mode of ['light', 'dark'] as const) {
			await emitMenu(`menu_appearance_${mode}`);
			await browser.waitUntil(async () => (await browser.execute(() => document.documentElement.getAttribute('data-theme'))) === mode, { timeout: 5_000, timeoutMsg: `data-theme did not become ${mode}` });
			await browser.pause(400);
			const stillHovered = (await removeOf(row1))?.visibility === 'visible';
			const rr = (await removeOf(row1))?.rowRect ?? before.rowRect;
			shots[mode] = await zoomedShot(`req83-gate14-hover-${mode}`, { x: rr.x - 8, y: rr.y - 8, width: rr.width + 16, height: rr.height + 16 }, 2);
			fact(14, `screenshot: the hovered row with its × (${mode}, ×2) — the eye judges the size, the place and the way it appears (人間ゲート 追補a 2)`, { shot: shots[mode], still_hovered: stillHovered });
		}
		await emitMenu('menu_appearance_system');
		await browser.pause(300);
		// Off the row: a point inside the viewport, in no `.recent-row` and under nothing a hover
		// changes. (run4, 2026-11-06: the footer Tip was pushed below the viewport by Show All, so
		// realinput refused the move and the pointer stayed on the row — a false that was the
		// tool's, not the product's.) Candidates, in order: the left margin beside the row (the
		// `.dashboard-content` padding / the `.dashboard` itself), then the left part of the
		// Recent Folders heading (Show All / Show Less sits at its right). Each is checked with
		// elementFromPoint before the move; none fit = an environment row, not a judgement.
		const rowNow = (await removeOf(row1))?.rowRect ?? before.rowRect;
		const awayCandidates: Array<{ name: string; x: number; y: number }> = [{ name: 'the left margin beside the row', x: Math.round(rowNow.x / 2), y: Math.round(rowNow.y + rowNow.height / 2) }];
		const heading = await rectOf(`${DASH} .dashboard-recent-folders .section-header`);
		if (heading) awayCandidates.push({ name: 'the left part of the Recent Folders heading', x: Math.round(heading.x + Math.min(40, heading.width / 4)), y: Math.round(heading.y + heading.height / 2) });
		/** What is under the client point: inside the viewport, the element, whether a `.recent-row` or anything a hover changes (buttons, tiles, rows) encloses it. */
		const underPoint = (cx: number, cy: number) =>
			browser.execute(
				(px, py) => {
					const inView = px >= 0 && py >= 0 && px < window.innerWidth && py < window.innerHeight;
					const el = inView ? document.elementFromPoint(px, py) : null;
					const describe = (e: Element | null) => (e ? `${e.tagName.toLowerCase()}${(e.getAttribute('class') ?? '').trim() ? `.${(e.getAttribute('class') ?? '').trim().split(/\s+/).join('.')}` : ''}` : null);
					const hoverSensitive = el?.closest('.recent-row, .modified-row, .bookmark-tile, .add-bookmark, button, a, [role="button"]') ?? null;
					return { in_view: inView, inner: { width: window.innerWidth, height: window.innerHeight }, element: describe(el), in_recent_row: !!el?.closest('.recent-row'), hover_sensitive: describe(hoverSensitive), ok: !!el && !hoverSensitive };
				},
				cx,
				cy,
			);
		let away: { name: string; x: number; y: number; under: Awaited<ReturnType<typeof underPoint>> } | null = null;
		const awayTried: Array<{ name: string; x: number; y: number; under: Awaited<ReturnType<typeof underPoint>> }> = [];
		for (const c of awayCandidates) {
			const under = await underPoint(c.x, c.y);
			awayTried.push({ ...c, under });
			if (under.ok) {
				away = { ...c, under };
				break;
			}
		}
		if (!away) environment(14, 'no point for the pointer to leave the row to: every candidate is outside the viewport or under something a hover changes; the product’s × was not judged', { candidates: awayTried });
		const awayScreen = toScreen(away.x, away.y);
		const leave = await operator('hover', { x: awayScreen.x, y: awayScreen.y, route: screen?.route ?? 'hid' });
		const leaveMove = (leave?.move ?? null) as { sent?: string; error?: string; stderr?: string } | null;
		if (leave?.front !== true || leaveMove?.sent !== 'move') environment(14, `the driver could not move the pointer off the row to ${away.name} (client ${away.x}, ${away.y} / screen ${awayScreen.x}, ${awayScreen.y}); the product’s × was not judged`, { answer: leave, away, move_refused: leaveMove?.error ?? null, move_stderr: leaveMove?.stderr ?? null });
		await browser.pause(400);
		judge(14, 'the pointer off the row: its × is hidden again', (await removeOf(row1))?.visibility === 'hidden', { after: await removeOf(row1), away, leave });
		// 2 + 3. A real click on the × (hover first) with the focus on a tile: the row goes, the focus stays on the tile.
		await focusTitled(TILE, (await tileOrder())[0]!);
		const focusBefore = await activeEl();
		const x1 = (await removeOf(row1))!.rect;
		const target = toScreen(Math.round(x1.x + x1.width / 2), Math.round(x1.y + x1.height / 2));
		let mark = await ipcMark();
		const click = await operator('click', { x: target.x, y: target.y, route: screen?.route ?? 'hid', hover: true });
		const removed = await waitIpc(mark, ['remove_history_entry'], 1, 10_000).catch(() => [] as IpcRec[]);
		await browser.waitUntil(async () => !(await recentRows()).some((r) => r.uri === row1), { timeout: 10_000, timeoutMsg: 'the e1 row is still there after the × click' }).catch(() => undefined);
		const dialogs = await operator('dialog', { wait_s: 1, expect: '', answer: 'escape' });
		const focusAfter = await activeEl();
		judge(14, 'a real click on the ×: remove_history_entry(e1) once and ok, the row is gone, no set_root / open_document, no dialog (契約10 追補a (b))', (click?.click as { sent?: string } | null)?.sent === 'click' && removed.length === 1 && (removed[0]!.args as { uri?: string }).uri === row1 && removed[0]!.ok === true && !(await recentRows()).some((r) => r.uri === row1) && (await openSeq(mark)).length === 0 && (await messageIpcCount(mark)) === 0 && (dialogs?.dialogs ?? 0) === 0, { click, removed: removed.map((e) => ({ args: e.args, ok: e.ok })), rows: (await recentRows()).map((r) => r.uri), opened: await openSeq(mark), dialogs });
		judge(14, 'history.json no longer holds e1', !historyFile().includes(row1), { history: historyFile() });
		fact(14, 'the focus before / after a real click on the × while a tile had it (implementer 事後確認 4: WKWebView is not expected to move the focus to the button)', { before: focusBefore, after: focusAfter });
		judge(14, 'the focus stays on the tile after the × click (the × has tabindex −1; the click does not move it)', focusBefore.part === 'tile' && focusAfter.part === 'tile' && focusAfter.title === focusBefore.title, { before: focusBefore, after: focusAfter });
		// 4. A real Delete key on the focused row removes it; the focus moves to the row that took its place.
		const rowsBeforeKey = (await recentRows()).map((r) => r.uri);
		const idx2 = rowsBeforeKey.indexOf(row2);
		judge(14, 'the e2 row is on the screen for the Delete key', idx2 >= 0 && (await focusTitled(RECENT_ROW, row2)), { rows: rowsBeforeKey, index: idx2 });
		mark = await ipcMark();
		const del = await realKey(51); // Delete (Backspace)
		const removed2 = await waitIpc(mark, ['remove_history_entry'], 1, 10_000).catch(() => [] as IpcRec[]);
		await browser.waitUntil(async () => !(await recentRows()).some((r) => r.uri === row2), { timeout: 10_000, timeoutMsg: 'the e2 row is still there after Delete' }).catch(() => undefined);
		const rowsAfterKey = (await recentRows()).map((r) => r.uri);
		const focusKey = await activeEl();
		const expectedNext = rowsAfterKey.length === 0 ? null : rowsAfterKey[Math.min(idx2, rowsAfterKey.length - 1)];
		judge(14, 'a real Delete key on the focused row: remove_history_entry(e2) once, the row is gone, the focus is on the row that took its place (契約13 追補a (c)(d))', del?.sent === true && removed2.length === 1 && (removed2[0]!.args as { uri?: string }).uri === row2 && !rowsAfterKey.includes(row2) && (await openSeq(mark)).length === 0 && focusKey.part === 'recent' && focusKey.title === expectedNext, { key: del, removed: removed2.map((e) => e.args), rows_before: rowsBeforeKey, rows_after: rowsAfterKey, focus: focusKey, expected_next: expectedNext });
		judge(14, 'history.json no longer holds e2', !historyFile().includes(row2), { history: historyFile() });
		// Command + Delete on a focused row: nothing.
		judge(14, 'the e3 row is on the screen for Command + Delete', await focusTitled(RECENT_ROW, row3), { rows: rowsAfterKey });
		mark = await ipcMark();
		const cmdDel = await realKey(51, ['cmd']);
		await browser.pause(1_200);
		judge(14, 'a real Command + Delete on the focused row: no remove_history_entry, the row stays (契約13 追補a: a modifier makes the key do nothing)', cmdDel?.sent === true && (await ipcAfter(mark, ['remove_history_entry'])).length === 0 && (await recentRows()).some((r) => r.uri === row3) && historyFile().includes(row3), { key: cmdDel, rows: (await recentRows()).map((r) => r.uri) });
		ran.gate14 = [row1, row2];
		expect(fails).toEqual([]);
	});

	it('dialogs and alerts seen by the launch phase: only the three Unsaved Changes of gate 3b', async () => {
		const h = await hooks();
		const messages = h.ipc.filter((e) => e.cmd === 'plugin:dialog|message').length;
		if (!ran.gate3b) {
			skipped('summary', 'the dialog count', `gate 3b did not run in this invocation (VELLIS_GATE_GREP); plugin:dialog|message was asked ${messages} times`);
			return;
		}
		judge('summary', 'plugin:dialog|message was asked exactly 3 times (gate 3b), no stray alert reached the stub', messages === 3, { messages });
		expect(fails).toEqual([]);
	});
});

// =======================================================================================
describe('Requirement #83 human gates, the machine part — the same home again (what survived gates 6 and 7)', function () {
	this.timeout(300_000);

	before(async function () {
		if (!DEVICE || VARIANT !== 'restart') this.skip();
		if (!fs.existsSync(STATE_FILE)) throw new Error(`${STATE_FILE} is missing: the launch phase did not run`);
		fs.rmSync(OP_DIR, { recursive: true, force: true });
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await installHooks();
		await waitFor(DASH, 'the launch Dashboard (restart)', 30_000);
		await browser.waitUntil(async () => (await tiles()).length > 0, { timeout: 30_000, timeoutMsg: 'no tiles after the restart' });
		await browser.pause(1_000);
	});
	beforeEach(() => {
		fails = [];
	});
	afterEach(async function () {
		if (this.currentTest?.state === 'failed') report(REPORT, { gate: 'failed', test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
	});
	after(async function () {
		if (!DEVICE || VARIANT !== 'restart') return;
		try {
			await restoreHooks();
			await restoreGateRecorder();
		} finally {
			await operator('done', {}, 10_000).catch(() => null);
		}
	});

	it('gate 6 (restart): the bookmark order of the launch phase is what the new app shows, equal to bookmarks.json', async () => {
		const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { bookmarks: Array<{ uri: string }>; history: string[]; removedHistory: string[]; cwd: string };
		const expected = state.bookmarks.map((b) => b.uri);
		const order = await tileOrder();
		judge(6, 'after a restart the tiles are in the order the launch phase left (drag / Move / Option + arrows), equal to bookmarks.json (契約9)', JSON.stringify(order) === JSON.stringify(expected) && JSON.stringify(bookmarksFile().map((b) => b.uri)) === JSON.stringify(expected), { order, expected, disk: bookmarksFile().map((b) => b.uri) });
		const focus = await activeEl();
		judge(10, 'the launch Dashboard focuses the first bookmark tile (restart)', focus.part === 'tile' && focus.index === 0, { focus });
		expect(fails).toEqual([]);
	});

	it('gate 7 (restart): the removed recent folder stays removed; the missing bookmarks are still there (dimmed); the cwd never reached history', async () => {
		const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { removedHistory: string[]; gate7?: boolean; cwd: string };
		const rs = await recentRows();
		const ts = await tiles();
		if (state.gate7) {
			judge(7, 'Remove from Recent Folders survived the restart: delta is in neither history.json nor the rows', state.removedHistory.every((u) => !historyFile().includes(u) && !rs.some((r) => r.uri === u)), { removed: state.removedHistory, history: historyFile(), rows: rs.map((r) => r.uri) });
			judge(7, 'the missing bookmarks (delta, gone.md) are still pinned and dimmed after the restart', ts.some((t) => t.uri === uri('delta') && t.missing) && ts.some((t) => t.uri === uri('gamma/gone.md') && t.missing), { tiles: ts.map((t) => ({ uri: t.uri, missing: t.missing })) });
		} else {
			skipped(7, 'what survived the restart (removed row, dimmed bookmarks)', 'gate 7 did not run in the launch phase (VELLIS_GATE_GREP)');
		}
		judge(7, 'the provisional root (cwd) is not in history.json after two argument-less launches (契約1)', !historyFile().includes(state.cwd), { history: historyFile() });
		expect(fails).toEqual([]);
	});

	it('gate 14 (restart, 追補a): the rows removed by the × and by the Delete key stay removed after the restart', async () => {
		const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { removedByGate14?: string[] };
		const removed = state.removedByGate14 ?? [];
		if (removed.length === 0) {
			skipped(14, 'what survived the restart (the rows the × and the Delete key removed)', 'gate 14 did not run in the launch phase (VELLIS_GATE_GREP)');
			return;
		}
		const rs = await recentRows();
		judge(14, 'the rows the × and the Delete key removed are in neither history.json nor the rows after the restart (人間ゲート 追補a 1)', removed.every((u) => !historyFile().includes(u) && !rs.some((r) => r.uri === u)), { removed, history: historyFile(), rows: rs.map((r) => r.uri) });
		expect(fails).toEqual([]);
	});
});

// =======================================================================================
describe('Requirement #83 human gates, the machine part — the disposable sshd (gate 9)', function () {
	this.timeout(600_000);

	before(async function () {
		if (!DEVICE || VARIANT !== 'ssh') this.skip();
		if (!sshUri) throw new Error('VELLIS_E2E_SSH_URI is not set');
		fs.rmSync(OP_DIR, { recursive: true, force: true });
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await installHooks();
		await browser.setTimeout({ script: 120_000 });
		await waitFor(DASH, 'the launch Dashboard (ssh)', 30_000);
		await browser.waitUntil(async () => (await tiles()).length > 0 && (await recentRows()).length > 0, { timeout: 30_000, timeoutMsg: 'no tiles / rows (ssh)' });
		report(REPORT, { gate: 'setup', variant: VARIANT, operator: OPERATOR, sshUri, history: historyFile(), bookmarks: bookmarksFile() });
	});
	beforeEach(() => {
		fails = [];
	});
	afterEach(async function () {
		if (this.currentTest?.state === 'failed') report(REPORT, { gate: 'failed', test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
	});
	after(async function () {
		if (!DEVICE || VARIANT !== 'ssh') return;
		try {
			await restoreHooks();
			await restoreGateRecorder();
		} finally {
			await operator('done', {}, 10_000).catch(() => null);
		}
	});

	it('gate 9: the ssh root in history and bookmarks — the SSH badge on the row and the tile, the scan never touches ssh (no ssh file, no connection), the press connects and lists the root', async () => {
		const rs = await recentRows();
		const ts = await tiles();
		const row = rs.find((r) => r.uri === sshUri);
		const tile = ts.find((t) => t.uri === sshUri);
		judge(9, 'the ssh recent folder row is first, carries the SSH badge and is not dimmed (契約10・6)', !!row && row.index === 0 && row.ssh && !row.missing && rs.filter((r) => r.ssh).length === 1, { row: row ?? null });
		judge(9, 'the ssh folder bookmark tile carries the SSH badge and is not dimmed (ssh is never checked for existence)', !!tile && tile.ssh && !tile.missing && ts.filter((t) => t.ssh).length === 1, { tile: tile ?? null });
		const sshShot = await shot('req83-gate1-ssh');
		fact(1, 'screenshot: the SSH badge on a row and a tile (the eye)', { shot: sshShot });
		// The scan: wait for the mount's scan, then one more.
		// The mount's scan started before the hooks (not recorded): wait for the DOM to leave `Scanning…`
		// (the heading's `in N folders` or an empty-state message), then one recorded rescan.
		await browser.waitUntil(
			async () => /^in \d+ folders?$/.test(await textOf(`${DASH} .dashboard-recently-modified .sub`)) || ((await exists(`${DASH} .dashboard-recently-modified .empty`)) && (await textOf(`${DASH} .dashboard-recently-modified .empty`)) !== 'Scanning…'),
			{ timeout: 30_000, timeoutMsg: 'the mount’s scan did not finish (Recently Modified still says Scanning…)' },
		);
		const scan = await rescan();
		const body = scan.body as { files?: Array<{ uri: string; folder: string }>; folders?: number } | null;
		const targets = expectedScanTargets();
		const connectionsBefore = await operator('ssh-connections');
		judge(9, 'the scan lists no ssh file and counts only the local targets (契約11 (k)); no TCP connection to the sshd before the press', (body?.files ?? []).every((f) => !f.uri.startsWith('ssh://') && !f.folder.startsWith('ssh://')) && body?.folders === targets.length && (!connectionsBefore || connectionsBefore.established === 0), { files: (body?.files ?? []).map((f) => f.uri), folders: body?.folders ?? null, targets, connections: connectionsBefore });
		// The press: set_root(ssh) connects and lists README.md.
		const mark = await ipcMark();
		await clickRecentRow(sshUri);
		await waitGone(DASH, 'open the ssh root', 90_000);
		await browser.waitUntil(async () => (await explorerNames()).includes('README.md'), { timeout: 90_000, timeoutMsg: 'the ssh root was not listed' });
		const seq = await openSeq(mark);
		const connectionsAfter = await operator('ssh-connections');
		judge(9, 'pressing the ssh row: set_root(the ssh URI) succeeds, the Explorer lists the remote root (README.md, docs), the app is connected to the sshd (契約5)', JSON.stringify(seq) === JSON.stringify([`set_root:${sshUri}`]) && (await explorerNames()).includes('README.md') && (!connectionsAfter || (connectionsAfter.established as number) >= 1), { seq, rows: await explorerNames(), connections: connectionsAfter });
		expect(fails).toEqual([]);
	});
});
