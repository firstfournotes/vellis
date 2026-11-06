import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
	assertIpcInterceptionWorks,
	clickExplorerRow,
	emitMenu,
	explorerHasRow,
	explorerNames,
	explorerRowUriByName,
	installEventRecorder,
	installGateRecorder,
	readEventRecord,
	removeEventRecorder,
	pixelAt,
	pixelDistance,
	report,
	restoreGateRecorder,
	shot,
	shotBitmap,
	SHOTS_DIR,
	waitForAppMounted,
	waitForExplorerRow,
	type Bitmap,
} from '../gate-helpers';

/**
 * Requirement #80 (Reload File / Reload Folder) — the machine-checkable part of
 * the human gates 1〜10 of docs/requirements/req-80.md (「人間ゲート」節), driven
 * against the live webview of a webdriver build on a real screen
 * (`scripts/gate-device/req80-gate.sh` → `run-gate-spec.sh req80 local|ssh`).
 *
 * Two phases, two apps: `local` opens a root of fixtures (req80-fixtures.sh),
 * `ssh` opens the disposable sshd's root (scripts/e2e-sshd.sh, started by the
 * driver). Each judgement is one JSON line in `$VELLIS_GATE_SHOTS/req80-report.jsonl`
 * (`pass` true / false; a line without `pass` is a fact left to the eye).
 *
 * What is judged (local):
 *  - gate 1  View ▸ Reload File sits between the separators after Show All Tabs
 *            and before Appearance, shows Command + R (AX); pressed by AX and by a
 *            real Command + R it re-reads a file rewritten outside (the watcher's
 *            delivery is dropped at the page = "the watcher missed it") and
 *            re-lists the root and the expanded folders (added files turn up);
 *            the same with the Find in Folder panel open; a window without a
 *            document (the shown file was removed) does nothing: no IPC, no dialog
 *  - gate 2  real right-clicks: the margin → the app's menu (Reload File and, since #83, Pin to Bookmarks), a
 *            word without a selection → the app's menu (whether the word gets
 *            selected is recorded), on / outside a selection → WebKit's own menu
 *            (Copy …), the find bar's input → WebKit's (Paste), inside the HTML
 *            and the PDF iframes → no app menu (WebKit's, recorded), with the
 *            Find in Folder panel open → WebKit's; a real right-drag on the 3D
 *            stage pans the view (pixels move) and opens no menu
 *  - gate 3  the Explorer rows: Reload File enabled on the shown file's row, greyed
 *            on another file's, absent on a folder's and on the blank
 *  - gate 4  an unsaved edit → ONE dialog (Save / Don't Save / Cancel; found as a
 *            sheet of the app or in UserNotificationCenter) → Esc: nothing read,
 *            edit kept; Return: saved first, then read; Command + D: the edit is
 *            dropped and the disk's content read
 *  - gate 5  media rewritten outside (auto-follow dropped at the page): after
 *            Reload File the PNG has the new size, the PDF the new colour
 *            (pixels), the WAV the new duration and a redrawn waveform, the MP4
 *            the new duration / colour / waveform and starts paused at 0, a
 *            rewritten `.map.json` alone reaches the Sources panel, the STL the
 *            new triangle count
 *  - gate 7  the shown file deleted outside (file_removed dropped) → Reload File
 *            → one `Could not reload the file: …` (a real alert, found and closed
 *            by the driver), the view stays, the tree is still re-listed
 *  - gate 8  Reload Folder on a folder row: that folder and its expanded
 *            descendants are re-listed (not the root, not a sibling), adds /
 *            removes / renames show, the expansion stays; on a collapsed row it
 *            expands and reads once; on the blank (above Duplicate Window, one
 *            separator) the root and every expanded folder
 *  - gate 9  an expanded folder made unreadable (chmod 000, put back by the
 *            driver) → Reload Folder → one `Could not reload the folder: …`, the
 *            old rows stay; Reload File's tree failure is silent
 *  - gate 10 the fact for 事後確認 7 / reviewer P2-1 (a folder row selected, then
 *            Reload File of a text → the selection moves to the file's row) with
 *            screenshots — no pass / fail, the judgement is 由谷's
 * ssh:
 *  - gate 3 / 8 / 9 again on the ssh root (the sshd stopped for 9 = the last step)
 *  - gate 6  a change made within 2 s of opening is missed by the poll (backlog
 *            325, recorded) and shows after Reload File; a file added to an
 *            expanded folder (no watch over ssh) shows in the tree after Reload File
 *  - gate 10 timing (事後確認 7): Reload File and the blank's Reload Folder with
 *            13 expanded folders — the span from the first IPC to the last answer
 *
 * The operator (`req80-gate.sh`) takes the steps the page cannot: reading and
 * pressing the native menu, real keys, real right-clicks (and reading / closing
 * WebKit's menu while the page's JS is blocked by its tracking loop), real
 * drags, finding and answering dialogs, chmod, stopping the sshd, screenshots.
 * This spec writes `<SHOTS_DIR>/req80-op-<phase>/req-<n>.json` and waits for
 * `ack-<n>.json`. Without the driver (`VELLIS_GATE_REQ80_OPERATOR` unset) those
 * steps are reported as skipped.
 *
 * Runs only under `scripts/gate-device/run-gate-spec.sh req80 local|ssh`
 * (VELLIS_GATE_DEVICE=1), with VELLIS_GATE_REALINPUT built and trusted.
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const VARIANT = process.env.VELLIS_GATE_VARIANT ?? 'local';
const OPERATOR = process.env.VELLIS_GATE_REQ80_OPERATOR === '1';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const alt = process.env.VELLIS_GATE_REQ80_ALT ?? '';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const realinput = process.env.VELLIS_GATE_REALINPUT ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';
const REPORT = 'req80-report.jsonl';
const OP_DIR = path.join(SHOTS_DIR, `req80-op-${VARIANT}`);

/** The root as the window knows it (`file://…` locally; adopted from a row's title over ssh). */
let rootUri = VARIANT === 'ssh' ? (process.env.VELLIS_E2E_SSH_URI ?? '') : `file://${root}`;
const uri = (rel: string) => (rel === '' ? rootUri : `${rootUri}/${rel.split(path.sep).join('/')}`);
const file = (rel: string) => path.join(root, rel);
const altFile = (rel: string) => path.join(alt, rel);

/** macOS virtual keycodes (US ANSI). */
const KEY = { r: 15, d: 2, return: 36, escape: 53 } as const;

const BODY = 'article.viewer .markdown-body';
const VIEWER = 'article.viewer';
const MENU = '.context-menu';
const MENU_ITEM = '.context-menu .context-menu-item';
const MENU_SEP = '.context-menu .context-menu-separator';
const MARK_A = 'GATE80-NOTES-A';
const MARK_B = 'GATE80-NOTES-B';
const RELOAD_FILE = 'Reload File';
const RELOAD_FOLDER = 'Reload Folder';
const FILE_FAILED = 'Could not reload the file: ';
const FOLDER_FAILED = 'Could not reload the folder: ';
const UNSAVED_TITLE = 'Unsaved Changes';
const PLAIN_ORIGINAL = 'first line\nsecond line\n';
const PLAIN_EDITED = 'first line edited\nsecond line\n';
const PLAIN_AGAIN = 'first line again\nsecond line\n';

// --- the tools (pid-pinned child processes, as req56) --------------------------------

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

// --- the operator (scripts/gate-device/req80-gate.sh) --------------------------------

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

// --- page hooks: IPC timing, Tauri events (recorded, droppable), alert, mouse --------

interface IpcRec {
	seq: number;
	cmd: string;
	uri: string | null;
	t0: number;
	t1: number | null;
	ok: boolean | null;
}
interface EventRec {
	event: string;
	uri: string | null;
	at: number;
	dropped: boolean;
}
interface MouseRec {
	type: string;
	clientX: number;
	clientY: number;
	button: number;
	target: string;
}
interface Hooks {
	ipc: IpcRec[];
	events: EventRec[];
	drop: string[];
	alerts: string[];
	alertMode: 'stub' | 'real';
	mouse: MouseRec[];
}

/**
 * Installed once, on top of the gate recorder: every IPC with its start / end
 * time and `uri` argument; every Tauri event delivered to the page (the Rust
 * side calls `window['_<id>']` — the listeners registered through
 * `transformCallback` — so each of those is wrapped), with the ones named in
 * `drop` swallowed = "the watcher did not deliver" (gates 1・5・7・8 need an
 * outside change the app has not followed yet); `alert` counted and, in mode
 * `real`, passed to the original (a native dialog the driver answers).
 */
async function installHooks(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as {
			__gate80?: Hooks & { rewrap: () => void; originals: { fetch: typeof window.fetch; alert: typeof window.alert } };
			__gate?: { originals?: Record<string, unknown> };
		};
		if (w.__gate80) return;
		const realAlert = (w.__gate?.originals?.alert as typeof window.alert | undefined) ?? window.alert;
		const g = {
			ipc: [] as IpcRec[],
			events: [] as EventRec[],
			drop: [] as string[],
			alerts: [] as string[],
			alertMode: 'stub' as 'stub' | 'real',
			mouse: [] as MouseRec[],
			originals: { fetch: window.fetch, alert: window.alert },
			rewrap: (() => undefined) as () => void,
		};
		w.__gate80 = g;
		const inner = window.fetch;
		window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
			const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
			const prefix = 'ipc://localhost/';
			if (!url.startsWith(prefix)) return inner.call(this, input, init);
			const cmd = decodeURIComponent(url.slice(prefix.length).split('?')[0] ?? '');
			let u: string | null = null;
			try {
				const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { uri?: unknown }) : null;
				u = body && typeof body.uri === 'string' ? body.uri : null;
			} catch {
				u = null;
			}
			const rec: IpcRec = { seq: g.ipc.length, cmd, uri: u, t0: performance.now(), t1: null, ok: null };
			g.ipc.push(rec);
			return inner.call(this, input, init).then(
				(res) => {
					rec.t1 = performance.now();
					rec.ok = res.headers.get('Tauri-Response') !== 'error';
					return res;
				},
				(err: unknown) => {
					rec.t1 = performance.now();
					rec.ok = false;
					throw err;
				},
			);
		} as typeof window.fetch;
		window.alert = (m?: unknown) => {
			g.alerts.push(String(m));
			if (g.alertMode === 'real') realAlert.call(window, String(m));
		};
		// Tauri 2.10 (scripts/core.js): transformCallback registers the handler in
		// the Map `__TAURI_INTERNALS__.callbacks`, and Rust delivers an event (and
		// every IPC answer) through `__TAURI_INTERNALS__.runCallback(id, data)`,
		// which looks the Map up — so each value of the Map is wrapped in place
		// (reviewer P2-1; there is no `window["_<id>"]`). IPC answers carry no
		// `event` string and pass through untouched. Run again on every setDrop,
		// so listeners registered later are wrapped too.
		const wrap = () => {
			const internals = (window as unknown as { __TAURI_INTERNALS__?: { callbacks?: Map<number, (d: unknown) => unknown> } }).__TAURI_INTERNALS__;
			const cbs = internals?.callbacks;
			if (!(cbs instanceof Map)) throw new Error('__TAURI_INTERNALS__.callbacks is not a Map (Tauri core.js changed?)');
			for (const [id, fn] of Array.from(cbs.entries())) {
				const f = fn as ((d: unknown) => unknown) & { __gate80?: boolean };
				if (typeof f !== 'function' || f.__gate80) continue;
				const wrapped = function (this: unknown, e: unknown) {
					const ev = e && typeof e === 'object' ? (e as { event?: unknown; payload?: unknown }) : null;
					if (ev && typeof ev.event === 'string') {
						const p = ev.payload && typeof ev.payload === 'object' ? (ev.payload as { uri?: unknown }) : null;
						const dropped = g.drop.includes(ev.event);
						g.events.push({ event: ev.event, uri: p && typeof p.uri === 'string' ? p.uri : null, at: Date.now(), dropped });
						if (dropped) return undefined;
					}
					return f.call(this, e);
				} as ((d: unknown) => unknown) & { __gate80?: boolean };
				wrapped.__gate80 = true;
				cbs.set(id, wrapped);
			}
		};
		g.rewrap = wrap;
		wrap();
		window.addEventListener(
			'mousedown',
			(e) => {
				const t = e.target as Element | null;
				g.mouse.push({
					type: e.type,
					clientX: e.clientX,
					clientY: e.clientY,
					button: e.button,
					target: t ? `${t.tagName.toLowerCase()}${t.className && typeof t.className === 'string' ? `.${t.className.split(' ').join('.')}` : ''}` : '',
				});
			},
			true,
		);
	});
}

async function hooks(): Promise<Hooks> {
	return browser.execute(() => {
		const g = (window as unknown as { __gate80?: Hooks }).__gate80;
		if (!g) throw new Error('hooks are not installed');
		return JSON.parse(JSON.stringify({ ipc: g.ipc, events: g.events, drop: g.drop, alerts: g.alerts, alertMode: g.alertMode, mouse: g.mouse })) as Hooks;
	});
}

async function setDrop(events: string[]): Promise<void> {
	await browser.execute((list) => {
		const g = (window as unknown as { __gate80?: Hooks & { rewrap: () => void } }).__gate80;
		if (!g) throw new Error('hooks are not installed');
		g.rewrap();
		g.drop = list;
	}, events);
}

async function setAlertMode(mode: 'stub' | 'real'): Promise<void> {
	await browser.execute((m) => {
		const g = (window as unknown as { __gate80?: Hooks }).__gate80;
		if (!g) throw new Error('hooks are not installed');
		g.alertMode = m;
	}, mode);
}

/**
 * Prove the drop works before any gate relies on it (reviewer P2-1; the same
 * shape as gate-helpers' assertEventRecorderWorks): listen to a probe event
 * through the page, put it in `drop`, emit it — it must not reach the
 * recorder; take it out of `drop`, emit again — it must. Otherwise refuse
 * (gates 1b・1c・5・7・8 would be judging the watcher, not Reload File).
 */
async function assertDropWorks(): Promise<void> {
	const probe = 'gate80-drop-probe';
	await installEventRecorder([probe]);
	await setDrop([probe]);
	await emitMenu(probe);
	await browser.pause(1_500);
	const whileDropped = (await readEventRecord()).filter((e) => e.event === probe).length;
	const seenDropped = (await hooks()).events.filter((e) => e.event === probe && e.dropped).length;
	await setDrop([]);
	await emitMenu(probe);
	await browser.waitUntil(async () => (await readEventRecord()).some((e) => e.event === probe), {
		timeout: 5_000,
		timeoutMsg: 'the probe event did not arrive once the drop was lifted; refusing to drive further',
	});
	await removeEventRecorder();
	report(REPORT, { gate: 'setup', item: 'drop self-check', while_dropped: whileDropped, seen_dropped: seenDropped, after: 1 });
	if (whileDropped !== 0 || seenDropped !== 1) {
		throw new Error(`the event drop is not effective (delivered ${whileDropped} while dropped, wrapper saw ${seenDropped}); refusing to drive further`);
	}
}

async function restoreHooks(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __gate80?: Hooks & { originals: { fetch: typeof window.fetch; alert: typeof window.alert } } };
		const g = w.__gate80;
		if (!g) return;
		g.drop = [];
		g.alertMode = 'stub';
		window.fetch = g.originals.fetch;
		window.alert = g.originals.alert;
	});
}

/** The index the next IPC will get (a mark for `ipcAfter`). */
async function ipcMark(): Promise<number> {
	return (await hooks()).ipc.length;
}

async function ipcAfter(mark: number, cmds?: string[]): Promise<IpcRec[]> {
	const all = (await hooks()).ipc.slice(mark);
	return cmds ? all.filter((e) => cmds.includes(e.cmd)) : all;
}

/** Wait until at least `min` IPCs of `cmds` were made after `mark` and all of them answered. */
async function waitIpcSettled(mark: number, cmds: string[], min = 1, timeout = 30_000): Promise<IpcRec[]> {
	await browser.waitUntil(
		async () => {
			const list = await ipcAfter(mark, cmds);
			return list.length >= min && list.every((e) => e.t1 !== null);
		},
		{ timeout, timeoutMsg: `IPC ${cmds.join('/')} (≥ ${min}) did not settle after mark ${mark}` },
	);
	// One more tick: a listing that is asked right after another answer.
	await browser.pause(300);
	return ipcAfter(mark, cmds);
}

async function eventsMark(): Promise<number> {
	return (await hooks()).events.length;
}
async function eventsAfter(mark: number, names?: string[]): Promise<EventRec[]> {
	const all = (await hooks()).events.slice(mark);
	return names ? all.filter((e) => names.includes(e.event)) : all;
}
async function alertsMark(): Promise<number> {
	return (await hooks()).alerts.length;
}
async function alertsAfter(mark: number): Promise<string[]> {
	return (await hooks()).alerts.slice(mark);
}

/** The span (ms) from the first request to the last answer of the records. */
function spanMs(list: IpcRec[]): number | null {
	if (list.length === 0) return null;
	const t0 = Math.min(...list.map((e) => e.t0));
	const t1 = Math.max(...list.map((e) => e.t1 ?? e.t0));
	return Math.round(t1 - t0);
}

const RELOAD_CMDS = ['open_document', 'open_binary_document', 'list_dir'];

/** After a Reload File was triggered at `mark`: wait for the open and the listings, summarize. */
async function reloadOutcome(mark: number, timeout = 30_000) {
	await browser.waitUntil(async () => (await ipcAfter(mark, ['open_document', 'open_binary_document'])).length > 0, {
		timeout,
		timeoutMsg: 'no open_document / open_binary_document after the reload was triggered',
	});
	const all = await waitIpcSettled(mark, RELOAD_CMDS, 1, timeout);
	const opens = all.filter((e) => e.cmd !== 'list_dir');
	const lists = all.filter((e) => e.cmd === 'list_dir');
	return {
		opens: opens.map((e) => ({ cmd: e.cmd, uri: e.uri, ok: e.ok, ms: e.t1 === null ? null : Math.round(e.t1 - e.t0) })),
		lists: lists.map((e) => ({ uri: e.uri, ok: e.ok, ms: e.t1 === null ? null : Math.round(e.t1 - e.t0) })),
		listUris: lists.map((e) => e.uri ?? ''),
		span_ms: spanMs(all),
	};
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

async function openDoc(rel: string, waitSelector: string): Promise<void> {
	await closePanels();
	await clickExplorerRow(uri(rel));
	await waitFor(waitSelector, `open ${rel}`);
}

/**
 * notes.md holding `marker` (A or B) and shown in the viewer. Every `it` sets
 * its own start this way (run 5: `VELLIS_GATE_GREP='gate 2'` found notes.md
 * still on A, which gate 1 would have flipped to B).
 */
async function ensureNotes(marker: string): Promise<void> {
	const other = marker === MARK_A ? MARK_B : MARK_A;
	await setDrop([]);
	const text = fs.readFileSync(file('notes.md'), 'utf8');
	if (!text.includes(marker)) writeInPlace(file('notes.md'), text.replace(other, marker));
	await openDoc('notes.md', BODY);
	await waitViewerText(marker);
}

/** Close whatever overlay a gate left open (the Find in Folder panel replaces the Explorer). */
async function closePanels(): Promise<string[]> {
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
			document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			out.push('context-menu');
		}
		return out;
	});
}

async function ensureExpanded(dirRel: string, probeChildRel: string): Promise<void> {
	await closePanels();
	if (await explorerHasRow(uri(probeChildRel))) return;
	await clickExplorerRow(uri(dirRel));
	await waitForExplorerRow(uri(probeChildRel), { timeout: 30_000 });
}

// --- the Explorer's context menu (DOM) ------------------------------------------------

interface MenuItemState {
	label: string;
	disabled: boolean;
}

async function menuItems(): Promise<MenuItemState[]> {
	return browser.execute(
		(sel) =>
			Array.from(document.querySelectorAll<HTMLButtonElement>(sel)).map((b) => ({
				label: b.textContent?.trim() ?? '',
				disabled: b.disabled,
			})),
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
	await browser.execute(() => {
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	});
	await browser.waitUntil(async () => !(await menuOpen()), { timeout: 3_000, timeoutMsg: 'Escape did not close the menu' });
}

/** Right-click (a DOM `contextmenu`, as ssh-root-gates) on the Explorer row `rowUri`. */
async function rowMenu(rowUri: string): Promise<MenuItemState[]> {
	await waitForExplorerRow(rowUri, { timeout: 15_000 });
	await browser.execute((u) => {
		const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find((r) => r.title === u)!;
		const r = row.getBoundingClientRect();
		row.dispatchEvent(
			new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.x + 20, clientY: r.y + r.height / 2 }),
		);
	}, rowUri);
	return waitMenu();
}

/** Right-click (DOM) on the blank below the rows of the Explorer. */
async function paneMenu(): Promise<MenuItemState[]> {
	await browser.execute(() => {
		const list = document.querySelector<HTMLElement>('.explorer-list')!;
		const r = list.getBoundingClientRect();
		list.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.x + r.width / 2, clientY: r.y + r.height - 4 }));
	});
	return waitMenu();
}

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

// --- real input: the screen ---------------------------------------------------------

interface Screen {
	pid: number;
	frame: { x: number; y: number; w: number; h: number; number: number };
	dx: number;
	dy: number;
	/** The realinput route the calibration click was delivered on (what the real clicks use). */
	route: 'pid' | 'hid';
}
let screen: Screen | null = null;

function toScreen(clientX: number, clientY: number): { x: number; y: number } {
	if (!screen) throw new Error('screen not calibrated');
	return { x: Math.round(screen.frame.x + screen.dx + clientX), y: Math.round(screen.frame.y + screen.dy + clientY) };
}

/**
 * Find the window and measure the WKWebView's offset in it with one real left
 * click on the Explorer's header (nothing happens there), as req48nop does on
 * the plain-text view. The guess is window height − innerHeight (the title bar).
 */
async function calibrate(pid: number): Promise<void> {
	await ensureFront(pid);
	const wins = ax(['cgwins', String(pid)]).filter((w) => w.onscreen === true);
	if (wins.length === 0) throw new Error('the test app has no on-screen window');
	const w = wins.sort((a, b) => (b.w as number) * (b.h as number) - (a.w as number) * (a.h as number))[0]!;
	const inner = await browser.execute(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }));
	const guess = { dx: Math.round(((w.w as number) - inner.innerWidth) / 2), dy: (w.h as number) - inner.innerHeight };
	screen = { pid, frame: { x: w.x as number, y: w.y as number, w: w.w as number, h: w.h as number, number: w.number as number }, dx: guess.dx, dy: guess.dy, route: 'pid' };
	const header = await rectOf('.explorer-header');
	if (!header) throw new Error('no Explorer header for the calibration click');
	const client = { x: Math.round(header.x + header.width / 2), y: Math.round(header.y + header.height / 2) };
	const s = toScreen(client.x, client.y);
	// The "pid" route first; the HID event tap when the page saw no mousedown
	// (req48nop's realClick: the route that worked is what the gestures use).
	let md: MouseRec | undefined;
	const attempts: Array<{ route: string; facts: Record<string, unknown> }> = [];
	for (const route of ['pid', 'hid'] as const) {
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

/**
 * A real right-click at a viewport point through the operator, which reads
 * and closes WebKit's own menu in the same step (the page's JS is blocked
 * while it is open). Returns the operator's answer plus what the DOM shows
 * afterwards (the app's menu is in the DOM and survives the step).
 */
interface RightClick {
	answer: Record<string, unknown> | null;
	popupFound: boolean;
	popupTitles: string[];
	appMenu: MenuItemState[] | null;
	selectionAfter: string;
	pressedTarget: string | null;
}
/**
 * Set when the driver could not close WebKit's menu (a layer-101 window of
 * the app still on the screen): every real input from then on would land in
 * that menu (the 2026-11-05 run: the 3D drag and gate 3's click did), so the
 * gestures refuse with this reason and the judgements go red as environment.
 */
let realInputBlocked: string | null = null;
function requireRealInput(): void {
	if (realInputBlocked) throw new Error(`environment: ${realInputBlocked}`);
}
/**
 * The environment, not the product, stopped a gate (the front could not be
 * taken — run 2: Google Chrome had it — or a menu was left open): one
 * `environment` row (no pass), the real input of this `it` is stopped, and
 * the `it` ends on an error that starts with `environment:` (the driver's
 * summary counts those apart from the judgements' reds).
 */
function environment(gate: number | string, item: string, extra: Record<string, unknown> = {}): never {
	const frontApp = (extra.answer as { front_app?: unknown } | undefined)?.front_app ?? extra.front_app ?? null;
	const reason = `${item}${frontApp ? ` (front app: ${JSON.stringify(frontApp)})` : ''}`;
	realInputBlocked = reason;
	report(REPORT, { gate: 'environment', item, reason, ...extra });
	throw new Error(`environment: ${reason}`);
}

async function realRightClick(clientX: number, clientY: number, shotName?: string): Promise<RightClick> {
	requireRealInput();
	const s = toScreen(clientX, clientY);
	let out: RightClick | null = null;
	// The HID event tap first: in three runs (2026-11-05) a right-click on the
	// "pid" route (postToPid) never reached the page nor opened WebKit's menu,
	// the HID route always did. "pid" stays as the fallback.
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
		const selectionAfter = await browser.execute(() => window.getSelection()?.toString() ?? '');
		const md = (await hooks()).mouse.slice(before).find((m) => m.type === 'mousedown' && m.button === 2);
		out = { answer: answer ? { ...answer, route } : null, popupFound: popup?.found === true, popupTitles, appMenu, selectionAfter, pressedTarget: md?.target ?? null };
		if (out.popupFound || out.appMenu !== null || md) break;
	}
	return out!;
}

/** The viewport point of the first occurrence of `word` in the Markdown body (the middle of the glyphs). */
async function wordPoint(word: string): Promise<{ x: number; y: number } | null> {
	return browser.execute(
		(sel, w) => {
			const body = document.querySelector(sel);
			if (!body) return null;
			const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
			let n: Node | null;
			while ((n = walker.nextNode())) {
				const t = n as Text;
				const i = t.data.indexOf(w);
				if (i < 0) continue;
				const r = document.createRange();
				r.setStart(t, i);
				r.setEnd(t, i + w.length);
				const b = r.getBoundingClientRect();
				return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
			}
			return null;
		},
		BODY,
		word,
	);
}

async function selectWord(word: string): Promise<string> {
	return browser.execute(
		(sel, w) => {
			const body = document.querySelector(sel);
			if (!body) return '';
			const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
			let n: Node | null;
			while ((n = walker.nextNode())) {
				const t = n as Text;
				const i = t.data.indexOf(w);
				if (i < 0) continue;
				const r = document.createRange();
				r.setStart(t, i);
				r.setEnd(t, i + w.length);
				const s = window.getSelection()!;
				s.removeAllRanges();
				s.addRange(r);
				return s.toString();
			}
			return '';
		},
		BODY,
		word,
	);
}

async function clearSelection(): Promise<void> {
	await browser.execute(() => window.getSelection()?.removeAllRanges());
}

/** A point in the margin of the viewer (not over the body's blocks). */
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

// --- pixels -------------------------------------------------------------------------

async function pixelAtSelector(name: string, selector: string): Promise<{ rgb: [number, number, number]; file: string } | null> {
	const r = await rectOf(selector);
	if (!r) return null;
	const { file: f, bmp, dpr } = await shotBitmap(name);
	const x = Math.min(bmp.width - 1, Math.round((r.x + r.width / 2) * dpr));
	const y = Math.min(bmp.height - 1, Math.round((r.y + r.height / 2) * dpr));
	return { rgb: pixelAt(bmp, x, y), file: f };
}

/**
 * The ink of a band: pixels of `rect` (CSS px) that differ by more than 40
 * from the band's background = the most frequent (quantised) colour of the
 * rect — not its top-left pixel, which the 2026-11-05 run showed to be an
 * axis / label pixel (then every pixel counted and before = after). Per third
 * of the width (left / middle / right), so a tone that goes silent in its
 * second half changes the shape whatever the band's scaling.
 */
function bandInk(bmp: Bitmap, rect: Rect, dpr: number): { thirds: [number, number, number]; total: number; bg: [number, number, number] } {
	const x0 = Math.max(0, Math.round(rect.x * dpr));
	const y0 = Math.max(0, Math.round(rect.y * dpr));
	const x1 = Math.min(bmp.width, Math.round((rect.x + rect.width) * dpr));
	const y1 = Math.min(bmp.height, Math.round((rect.y + rect.height) * dpr));
	const counts = new Map<string, number>();
	for (let y = y0; y < y1; y += 2)
		for (let x = x0; x < x1; x += 2) {
			const p = pixelAt(bmp, x, y);
			const k = `${p[0] >> 3},${p[1] >> 3},${p[2] >> 3}`;
			counts.set(k, (counts.get(k) ?? 0) + 1);
		}
	const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '0,0,0';
	const bg = top.split(',').map((v) => (Number(v) << 3) + 4) as [number, number, number];
	const thirds: [number, number, number] = [0, 0, 0];
	const w = x1 - x0;
	for (let y = y0; y < y1; y += 1)
		for (let x = x0; x < x1; x += 1) {
			if (pixelDistance(pixelAt(bmp, x, y), bg) > 40) thirds[Math.min(2, Math.floor(((x - x0) * 3) / Math.max(w, 1)))] += 1;
		}
	return { thirds, total: thirds[0] + thirds[1] + thirds[2], bg };
}

/** Pixels of `rect` that differ between two screenshots of the same window by more than `threshold`. */
function diffPixels(a: Bitmap, b: Bitmap, rect: Rect, dpr: number, threshold = 60): { differing: number; total: number } {
	const x0 = Math.max(0, Math.round(rect.x * dpr));
	const y0 = Math.max(0, Math.round(rect.y * dpr));
	const x1 = Math.min(a.width, b.width, Math.round((rect.x + rect.width) * dpr));
	const y1 = Math.min(a.height, b.height, Math.round((rect.y + rect.height) * dpr));
	let n = 0;
	let total = 0;
	for (let y = y0; y < y1; y += 1)
		for (let x = x0; x < x1; x += 1) {
			total += 1;
			if (pixelDistance(pixelAt(a, x, y), pixelAt(b, x, y)) > threshold) n += 1;
		}
	return { differing: n, total };
}

interface Band {
	file: string;
	rect: Rect;
	dpr: number;
	bmp: Bitmap;
	ink: { thirds: [number, number, number]; total: number; bg: [number, number, number] };
}
async function bandOf(name: string, selector: string): Promise<Band | null> {
	const r = await rectOf(selector);
	if (!r) return null;
	const { file: f, bmp, dpr } = await shotBitmap(name);
	return { file: f, rect: r, dpr, bmp, ink: bandInk(bmp, r, dpr) };
}
/** The report's view of a band (no bitmap). */
function bandFacts(b: Band | null): Record<string, unknown> | null {
	return b ? { file: b.file, rect: b.rect, ink: b.ink } : null;
}
/**
 * The band was redrawn with another content: before / after differ in more
 * than 5% of the band's pixels (threshold 40), and the shape changed (the
 * share of the left third in the ink moved by more than 0.1).
 */
function bandChanged(before: Band | null, after: Band | null): { pass: boolean; diff: { differing: number; total: number } | null; left_share_before: number | null; left_share_after: number | null } {
	if (!before || !after) return { pass: false, diff: null, left_share_before: null, left_share_after: null };
	const diff = diffPixels(before.bmp, after.bmp, before.rect, before.dpr, 40);
	const share = (b: Band) => (b.ink.total > 0 ? b.ink.thirds[0] / b.ink.total : 0);
	const sb = share(before);
	const sa = share(after);
	return { pass: diff.differing > diff.total * 0.05 && Math.abs(sa - sb) > 0.1, diff, left_share_before: Math.round(sb * 1000) / 1000, left_share_after: Math.round(sa * 1000) / 1000 };
}

function isRed(rgb: [number, number, number]): boolean {
	return rgb[0] > 150 && rgb[1] < 90 && rgb[2] < 90;
}
function isBlue(rgb: [number, number, number]): boolean {
	return rgb[2] > 150 && rgb[0] < 90 && rgb[1] < 120;
}

// --- files outside the app --------------------------------------------------------

/**
 * Replace `file(rel)` by `altFile(rel)` in place (truncate + write, the way an
 * exporter or an editor saves over a file). Not a rename over the path: that
 * could reach the app as a removal of the shown file, which is not what these
 * gates are about (their watcher deliveries are dropped anyway).
 */
function rewriteFromAlt(rel: string): void {
	fs.copyFileSync(altFile(rel), file(rel));
}
/** Rewrite an existing text file in place (see `rewriteFromAlt`). */
function writeInPlace(abs: string, content: string): void {
	fs.writeFileSync(abs, content);
}
/** A new file: a temp file in the same folder, then a rename (what an editor does for a new file). */
function writeAtomic(abs: string, content: string): void {
	const tmp = `${abs}.gate80-tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, abs);
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

// =======================================================================================
describe('Requirement #80 human gates, the machine part — local root (gates 1〜5, 7〜10)', function () {
	this.timeout(900_000);
	let pid = 0;

	before(async function () {
		if (!DEVICE || VARIANT !== 'local') this.skip();
		for (const [name, value] of Object.entries({ VELLIS_GATE_BIN: bin, VELLIS_GATE_AXTOOL: axtool, VELLIS_GATE_REALINPUT: realinput, VELLIS_E2E_INITIAL_ROOT: root, VELLIS_GATE_REQ80_ALT: alt })) {
			if (!value) throw new Error(`${name} is not set`);
		}
		for (const f of ['notes.md', 'plain.txt', 'page.html', 'gone.md', 'photo.png', 'paper.pdf', 'tone.wav', 'clip.mp4', 'clip.mp4.map.json', 'cube.stl', 'alpha/a1.md', 'alpha/inner/i1.md', 'beta/b1.md', 'gamma/g1.md']) {
			if (!fs.existsSync(file(f))) throw new Error(`fixture ${f} is missing in ${root} (req80-fixtures.sh)`);
		}
		fs.mkdirSync(SHOTS_DIR, { recursive: true });
		fs.rmSync(OP_DIR, { recursive: true, force: true });
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await installHooks();
		await assertDropWorks();
		pid = appPid();
		report(REPORT, { gate: 'setup', variant: VARIANT, operator: OPERATOR, pid, root, alt, rootUri });
		await waitForExplorerRow(uri('notes.md'), { timeout: 30_000, nudgeDir: root, nudgePrefix: 'req80' });
		await calibrate(pid);
	});

	async function resetScreen(when: string): Promise<void> {
		const closed = await closePanels();
		await setDrop([]);
		await setAlertMode('stub');
		await clearSelection();
		if (closed.length > 0) report(REPORT, { gate: 'reset', when, closed });
		await waitForExplorerRow(uri('notes.md'), { timeout: 15_000, nudgeDir: root, nudgePrefix: 'req80-reset' });
	}

	beforeEach(async function () {
		if (!DEVICE || VARIANT !== 'local') return;
		fails = [];
		realInputBlocked = null;
		await resetScreen(`before: ${this.currentTest?.title ?? '?'}`);
	});

	afterEach(async function () {
		if (!DEVICE || VARIANT !== 'local') return;
		if (this.currentTest?.state === 'failed') {
			report(REPORT, { gate: 'failed', test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
		}
		await resetScreen(`after: ${this.currentTest?.title ?? '?'}`).catch(() => undefined);
	});

	after(async function () {
		if (!DEVICE || VARIANT !== 'local') return;
		try {
			const h = await hooks();
			report(REPORT, { gate: 'teardown', alerts: h.alerts, dropped_events: h.events.filter((e) => e.dropped).length });
			if (fs.existsSync(file('plain.txt'))) writeAtomic(file('plain.txt'), PLAIN_ORIGINAL);
			await restoreHooks();
			await restoreGateRecorder();
		} finally {
			await operator('done', {}, 10_000).catch(() => null);
		}
	});

	// ------------------------------------------------------------------ gate 1
	it('gate 1a: View ▸ Reload File sits between the separators after Show All Tabs and before Appearance, shows Command + R, is enabled', async () => {
		const a = await operator('view-menu', { menu: 'View' });
		if (!a) {
			skipped(1, 'View menu by AX', 'needs the operator');
			return;
		}
		const items = (a.items ?? []) as Array<{ title: string; enabled: boolean; cmd_char: string; cmd_modifiers: number; separator: boolean; submenu: boolean }>;
		const titles = items.map((i) => (i.separator ? '—' : i.title));
		// The live View menu carries AppKit's own entries around the app's 13
		// (reviewer P2-2, read from the installed 0.6.0): a disabled Hide / Show
		// Tab Bar + a disabled Show All Tabs + a separator in front (the first
		// title follows the tab bar's state), Enter Full Screen (Globe + F) at
		// the end. The app's 13 are cut out from the Show Tab Bar that carries
		// Shift + Command + T (cmd_char T) and compared; the rest is judged apart.
		fact(1, 'the live View menu as AX reads it (every entry)', { items });
		const expected = ['Show Tab Bar', 'Show All Tabs', '—', RELOAD_FILE, '—', 'Appearance', 'Toggle Full Width', '—', 'Zoom In', 'Zoom Out', 'Actual Size', '—', 'Toggle Developer Tools'];
		const start = items.findIndex((i) => i.title === 'Show Tab Bar' && i.cmd_char.toUpperCase() === 'T' && !i.separator);
		const app = start >= 0 ? titles.slice(start, start + expected.length) : [];
		const head = start >= 0 ? items.slice(0, start) : items;
		const tail = start >= 0 ? items.slice(start + expected.length) : [];
		const reload = items.find((i) => i.title === RELOAD_FILE);
		judge(1, 'View menu order: the app’s 13 entries from Show Tab Bar (Shift + Command + T) — Reload File between the separators after Show All Tabs, before Appearance', start >= 0 && JSON.stringify(app) === JSON.stringify(expected), { app, expected, start });
		// The AppKit entries' enabled state follows the front window (tab-capable
		// or not) — the environment, not the product: titles and separators only.
		const tailItems = tail.filter((i) => !i.separator);
		judge(1, 'around them only AppKit’s own entries: in front Hide / Show Tab Bar + Show All Tabs + a separator, at the end Enter Full Screen (separators allowed)', head.length === 3 && /^(Hide|Show) Tab Bar$/.test(head[0]!.title) && head[1]!.title === 'Show All Tabs' && head[2]!.separator && tailItems.length === 1 && tailItems[0]!.title === 'Enter Full Screen', { head: head.map((i) => ({ title: i.title, enabled: i.enabled, separator: i.separator })), tail: tail.map((i) => (i.separator ? '—' : i.title)) });
		judge(1, 'Reload File shows Command + R (AXMenuItemCmdChar R, modifiers 0 = Command) and is enabled', !!reload && reload.cmd_char.toUpperCase() === 'R' && reload.cmd_modifiers === 0 && reload.enabled, { reload });
		expect(fails).toEqual([]);
	});

	it('gate 1b: View ▸ Reload File (AX press) re-reads a file rewritten outside and re-lists the root and the expanded folders', async () => {
		await ensureNotes(MARK_A);
		await ensureExpanded('alpha', 'alpha/a1.md');
		// The watcher's deliveries are dropped at the page = "the watcher missed it".
		await setDrop(['file_changed', 'file_removed', 'directory_changed']);
		const ev = await eventsMark();
		rewriteFromAlt('notes.md');
		writeAtomic(file('alpha/added-1.md'), '# added 1\n');
		writeAtomic(file('root-added-1.md'), '# root added 1\n');
		await browser.pause(2_500);
		const masked = { view_still_a: (await viewerText()).includes(MARK_A), row_alpha_absent: !(await explorerHasRow(uri('alpha/added-1.md'))), row_root_absent: !(await explorerHasRow(uri('root-added-1.md'))) };
		const dropped = (await eventsAfter(ev)).filter((e) => e.dropped).map((e) => e.event);
		fact(1, 'before the press: the outside change is not shown (watcher deliveries dropped)', { ...masked, dropped });
		// The scroll position (契約 4 「おおむね保つ=見込み」・周回開始時に確かめること 2): a fact, not a judgement.
		const scrollTop = () => browser.execute(() => document.querySelector('.viewer-main')?.scrollTop ?? null);
		await browser.execute(() => {
			const vm = document.querySelector('.viewer-main');
			if (vm) vm.scrollTop = 120;
		});
		await browser.pause(300);
		const scrollBefore = await scrollTop();
		const mark = await ipcMark();
		const pressed = await operator('press-menu', { menu: 'View', item: RELOAD_FILE });
		if (!pressed) {
			skipped(1, 'View ▸ Reload File by AX', 'needs the operator');
			await setDrop([]);
			return;
		}
		const o = await reloadOutcome(mark);
		await waitViewerText(MARK_B);
		await waitForExplorerRow(uri('alpha/added-1.md'), { timeout: 10_000 });
		await waitForExplorerRow(uri('root-added-1.md'), { timeout: 10_000 });
		await browser.pause(500);
		fact(1, 'the scroll position of the viewer before / after the reload (契約 4: kept "on the whole" — recorded, the judgement is 由谷’s)', { scroll_before: scrollBefore, scroll_after: await scrollTop() });
		judge(1, 'AX press: the file is read again once (open_document of notes.md, ok) and the view shows the new content', o.opens.length === 1 && o.opens[0]!.cmd === 'open_document' && o.opens[0]!.uri === uri('notes.md') && o.opens[0]!.ok === true, { ...o, masked, pressed });
		judge(1, 'AX press: the root and the expanded folder are re-listed (list_dir of root + alpha, not the collapsed beta) and the added files are in the tree', o.listUris.includes(rootUri) && o.listUris.includes(uri('alpha')) && !o.listUris.includes(uri('beta')), { listUris: o.listUris });
		await setDrop([]);
		expect(fails).toEqual([]);
	});

	it('gate 1c: a real Command + R re-reads the file — also with the Find in Folder panel open (then the body right-click stays WebKit’s)', async () => {
		await openDoc('notes.md', BODY);
		await setDrop(['file_changed', 'file_removed']);
		writeInPlace(file('notes.md'), fs.readFileSync(file('notes.md'), 'utf8').replace(MARK_B, MARK_A));
		await browser.pause(1_500);
		const mark = await ipcMark();
		const key = await operator('key', { keycode: KEY.r, mods: ['cmd'] });
		if (!key) {
			skipped(1, 'real Command + R', 'needs the operator');
			await setDrop([]);
			return;
		}
		if (key.sent !== true) {
			await setDrop([]);
			environment(1, 'the driver could not bring the window to the front for Command + R; the key was not sent', { answer: key });
		}
		const o = await reloadOutcome(mark);
		await waitViewerText(MARK_A);
		judge(1, 'real Command + R: open_document once, the view shows the rewritten content', o.opens.length === 1 && o.opens[0]!.uri === uri('notes.md') && o.opens[0]!.ok === true, { ...o, key });

		// With the Find in Folder panel open (reviewer's addition to gate 1).
		await emitMenu('menu_find_in_folder');
		await waitFor('[data-testid="find-in-folder"]', 'Find in Folder panel');
		writeInPlace(file('notes.md'), fs.readFileSync(file('notes.md'), 'utf8').replace(MARK_A, MARK_B));
		await browser.pause(1_500);
		const mark2 = await ipcMark();
		const key2 = await operator('key', { keycode: KEY.r, mods: ['cmd'] });
		if (key2?.sent === true) {
			const o2 = await reloadOutcome(mark2);
			await waitViewerText(MARK_B);
			judge(1, 'Find in Folder panel open: real Command + R still re-reads (open_document once, new content shown)', o2.opens.length === 1 && o2.opens[0]!.ok === true, { ...o2, key: key2 });
			// Gate 2 (【(s) 決定】): the body's right-click stays WebKit's while the panel is open.
			const p = await marginPoint();
			if (p) {
				const rc = await realRightClick(p.x, p.y, 'req80-gate2-find-in-folder-open');
				judge(2, 'Find in Folder panel open: the body right-click shows WebKit’s own menu and no app menu', rc.appMenu === null && rc.popupFound, { point: p, popup_found: rc.popupFound, popup_titles: rc.popupTitles, pressed_target: rc.pressedTarget });
			} else {
				judge(2, 'Find in Folder panel open: a margin point was found', false, {});
			}
		} else {
			await closePanels();
			await setDrop([]);
			environment(1, 'the driver could not bring the window to the front for Command + R with the Find in Folder panel open; the key was not sent', { answer: key2 });
		}
		await closePanels();
		await setDrop([]);
		expect(fails).toEqual([]);
	});

	it('gate 1d: a window without a document (the shown file was removed) does nothing on View ▸ Reload File and on a real Command + R', async () => {
		writeAtomic(file('nodoc.md'), '# No doc\n\nGATE80-NODOC\n');
		await waitForExplorerRow(uri('nodoc.md'), { timeout: 15_000, nudgeDir: root, nudgePrefix: 'req80-nodoc' });
		await openDoc('nodoc.md', BODY);
		await waitViewerText('GATE80-NODOC');
		fs.rmSync(file('nodoc.md'));
		await browser.waitUntil(async () => !(await viewerText()).includes('GATE80-NODOC'), { timeout: 15_000, timeoutMsg: 'file_removed did not close the document' });
		await browser.pause(800);
		const mark = await ipcMark();
		const al = await alertsMark();
		const pressed = await operator('press-menu', { menu: 'View', item: RELOAD_FILE });
		const key = await operator('key', { keycode: KEY.r, mods: ['cmd'] });
		await browser.pause(2_000);
		const after = await ipcAfter(mark, RELOAD_CMDS);
		const dialogs = await operator('dialog', { wait_s: 2, expect: '', answer: 'escape' });
		if (!pressed || !key) {
			skipped(1, 'no document: View ▸ Reload File / Command + R', 'needs the operator');
			return;
		}
		judge(1, 'no document: neither the AX press nor the real Command + R reads a file or lists a folder, no alert, no dialog', after.length === 0 && (await alertsAfter(al)).length === 0 && (dialogs?.dialogs ?? 0) === 0, { ipc_after: after, pressed, key, dialogs, has_document: await exists(VIEWER) });
		fact(1, 'no document: the View item stays enabled (the menu does not know what the window shows)', { pressed_enabled: pressed.enabled ?? null });
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 2
	it('gate 2: real right-clicks on the body — margin / word / selection / find bar / HTML / PDF — and a real right-drag on the 3D stage', async () => {
		if (!OPERATOR) {
			skipped(2, 'real right-clicks', 'needs the operator');
			return;
		}
		await ensureNotes(MARK_B);

		// (a) the margin → the app's menu, Reload File only → pressing it reads the file.
		const margin = await marginPoint();
		if (!margin) {
			judge(2, 'a margin point exists', false, {});
		} else {
			const rc = await realRightClick(margin.x, margin.y, 'req80-gate2-margin');
			await shot('req80-gate2-margin-dom');
			// 要件#83 契約 7(2026-11-05 承認 4 の要件側更新): 本文のメニューは Reload File の後に Pin to Bookmarks が増えて 2 つ。
			judge(2, 'margin: the app’s menu with Reload File (enabled) and Pin to Bookmarks, no WebKit menu', rc.appMenu !== null && rc.appMenu.length === 2 && rc.appMenu[0]!.label === RELOAD_FILE && !rc.appMenu[0]!.disabled && rc.appMenu[1]!.label === 'Pin to Bookmarks' && !rc.popupFound, { point: margin, ...rc });
			if (rc.appMenu) {
				const mark = await ipcMark();
				await clickMenuItem(RELOAD_FILE);
				const o = await reloadOutcome(mark);
				judge(2, 'margin: Reload File from the body menu reads the file (open_document once) and the menu closes', o.opens.length === 1 && o.opens[0]!.uri === uri('notes.md') && !(await menuOpen()), { ...o });
			}
		}

		// (b) a word, nothing selected → the app's menu (事後確認 5: the selection at mousedown decides); whether the word gets selected is recorded.
		await clearSelection();
		const wp = await wordPoint('RELOADWORD');
		if (!wp) {
			judge(2, 'the word RELOADWORD is in the body', false, {});
		} else {
			const rc = await realRightClick(wp.x, wp.y, 'req80-gate2-word');
			await shot('req80-gate2-word-dom');
			judge(2, 'word without a selection: the app’s menu (Reload File), no WebKit menu', rc.appMenu !== null && rc.appMenu.some((i) => i.label === RELOAD_FILE) && !rc.popupFound, { point: wp, ...rc });
			fact(2, 'word without a selection: what the selection is after the right-click (reviewer P2-3 — recorded for the eye)', { selection_after: rc.selectionAfter, word_selected: rc.selectionAfter.trim() === 'RELOADWORD', shots: ['req80-gate2-word-dom.png'] });
			await closeMenu().catch(() => undefined);
		}

		// (c) a selection, right-click on it → WebKit's menu (Copy, Look Up …), no app menu.
		const selected = await selectWord('RELOADWORD');
		const wp2 = await wordPoint('RELOADWORD');
		if (selected !== 'RELOADWORD' || !wp2) {
			judge(2, 'the word could be selected', false, { selected });
		} else {
			const rc = await realRightClick(wp2.x, wp2.y, 'req80-gate2-selection');
			judge(2, 'right-click on a selection: WebKit’s own menu (has Copy), no app menu', rc.popupFound && rc.popupTitles.some((t) => /^Copy$/.test(t)) && rc.appMenu === null, { point: wp2, ...rc });
			// (d) the selection kept, right-click outside it (reviewer P2-3).
			const sel2 = await selectWord('RELOADWORD');
			const op = await wordPoint('Paragraph one');
			if (sel2 === 'RELOADWORD' && op) {
				const rc2 = await realRightClick(op.x, op.y, 'req80-gate2-outside-selection');
				judge(2, 'selection kept, right-click outside it: WebKit’s own menu, no app menu (the selection at mousedown decides)', rc2.appMenu === null && rc2.popupFound, { point: op, selection_before: sel2, ...rc2 });
			} else {
				judge(2, 'the selection could be made again for the outside click', false, { sel2, op });
			}
		}
		await clearSelection();

		// (e) the find bar's input → WebKit's (Paste), no app menu.
		await emitMenu('menu_find');
		await waitFor('[data-testid="find-input"]', 'find bar');
		const fi = await rectOf('[data-testid="find-input"]');
		if (fi) {
			const rc = await realRightClick(Math.round(fi.x + fi.width / 2), Math.round(fi.y + fi.height / 2), 'req80-gate2-find-input');
			judge(2, 'find bar input: WebKit’s own menu with Paste, no app menu', rc.popupFound && rc.popupTitles.some((t) => /^Paste/.test(t)) && rc.appMenu === null, { ...rc });
		} else {
			judge(2, 'the find bar input exists', false, {});
		}
		await closePanels();

		// (f) inside the HTML iframe → no app menu (WebKit's, recorded).
		await openDoc('page.html', 'iframe.html-viewer');
		await browser.pause(800);
		const hf = await rectOf('iframe.html-viewer');
		if (hf) {
			const rc = await realRightClick(Math.round(hf.x + hf.width / 2), Math.round(hf.y + hf.height / 2), 'req80-gate2-html');
			judge(2, 'inside the HTML iframe: WebKit’s own menu, no app menu', rc.appMenu === null && rc.popupFound, { ...rc });
		} else {
			judge(2, 'the HTML iframe exists', false, {});
		}

		// (g) inside the PDF iframe → no app menu (the PDF viewer's, recorded).
		await openDoc('paper.pdf', 'iframe.pdf-frame');
		await browser.pause(1_500);
		const pf = await rectOf('iframe.pdf-frame');
		if (pf) {
			const rc = await realRightClick(Math.round(pf.x + pf.width / 2), Math.round(pf.y + pf.height / 2), 'req80-gate2-pdf');
			judge(2, 'inside the PDF iframe: the PDF viewer’s own menu, no app menu', rc.appMenu === null && rc.popupFound, { ...rc });
		} else {
			judge(2, 'the PDF iframe exists', false, {});
		}

		// (h) the 3D stage: a real right-drag pans (pixels move), no menu of either kind.
		await openDoc('cube.stl', '.model-stage canvas');
		await browser.waitUntil(async () => /triangles/.test(await textOf('.model-stats')), { timeout: 20_000, timeoutMsg: 'the STL did not load' });
		await browser.pause(800);
		const stage = await rectOf('.model-stage');
		if (stage) {
			const c = { x: Math.round(stage.x + stage.width / 2), y: Math.round(stage.y + stage.height / 2) };
			const s1 = toScreen(c.x, c.y);
			const s2 = toScreen(c.x + 90, c.y + 60);
			// What the page sees during the drag (run 4: both routes left the picture
			// as it was — the record tells whether the right-button pointer events
			// reached `.model-stage` at all, and whether a contextmenu slipped through).
			interface PtrRec {
				type: string;
				button: number;
				buttons: number;
				clientX: number;
				clientY: number;
				defaultPrevented: boolean;
				onStage: boolean;
				target: string;
			}
			const installPointerRecorder = () =>
				browser.execute(() => {
					const w = window as unknown as { __gate80ptr?: PtrRec[] };
					w.__gate80ptr = [];
					for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'contextmenu']) {
						window.addEventListener(
							type,
							(e) => {
								const m = e as MouseEvent;
								const t = e.target as Element | null;
								// Read in the bubble phase, after the stage's handlers (defaultPrevented).
								w.__gate80ptr!.push({
									type,
									button: m.button,
									buttons: m.buttons,
									clientX: m.clientX,
									clientY: m.clientY,
									defaultPrevented: e.defaultPrevented,
									onStage: !!t?.closest?.('.model-stage'),
									target: t ? `${t.tagName.toLowerCase()}.${(t as HTMLElement).className && typeof (t as HTMLElement).className === 'string' ? (t as HTMLElement).className : ''}` : '',
								});
							},
							false,
						);
					}
				});
			const readPointerRecord = () =>
				browser.execute(() => JSON.parse(JSON.stringify((window as unknown as { __gate80ptr?: PtrRec[] }).__gate80ptr ?? [])) as PtrRec[]);
			const summarize = (rec: PtrRec[]) => {
				const stage = rec.filter((r) => r.onStage);
				const downs = stage.filter((r) => r.type === 'pointerdown');
				return {
					events: rec.length,
					on_stage: stage.length,
					pointerdown_right: downs.filter((r) => r.button === 2).length,
					pointerdown_other: downs.filter((r) => r.button !== 2).length,
					pointermove_with_right_button: stage.filter((r) => r.type === 'pointermove' && (r.buttons & 2) !== 0).length,
					pointermove_without_buttons: stage.filter((r) => r.type === 'pointermove' && r.buttons === 0).length,
					pointerup: stage.filter((r) => r.type === 'pointerup').length,
					contextmenu: rec.filter((r) => r.type === 'contextmenu').map((r) => ({ onStage: r.onStage, defaultPrevented: r.defaultPrevented, target: r.target })),
					first: rec.slice(0, 6),
				};
			};
			await installPointerRecorder();
			// A control: the same drag as DOM PointerEvents (no real input). When this
			// moves the picture, the viewer's pan works and a real drag that does not
			// is the delivery's (the tool's or WebKit's) business.
			const controlBefore = await shotBitmap('req80-gate2-3d-control-before');
			await browser.execute(
				(sel, from, to) => {
					const el = document.querySelector<HTMLElement>(sel)!;
					const ev = (type: string, x: number, y: number, buttons: number) =>
						el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 2, buttons, clientX: x, clientY: y }));
					ev('pointerdown', from.x, from.y, 2);
					for (let i = 1; i <= 12; i += 1) ev('pointermove', from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12, 2);
					ev('pointerup', to.x, to.y, 0);
				},
				'.model-stage',
				c,
				{ x: c.x + 90, y: c.y + 60 },
			);
			await browser.pause(600);
			const controlAfter = await shotBitmap('req80-gate2-3d-control-after');
			const controlDiff = diffPixels(controlBefore.bmp, controlAfter.bmp, stage, controlBefore.dpr);
			const controlRecord = summarize(await readPointerRecord());
			fact(2, '3D control: a synthetic right-button pointer drag (DOM events) on the stage — does the viewer pan at all?', { moved: controlDiff.differing > controlDiff.total * 0.01, diff: controlDiff, record: controlRecord, shots: [controlBefore.file, controlAfter.file] });

			const attempts: Array<{ route: string; diff: { differing: number; total: number }; drag: Record<string, unknown> | null; record: ReturnType<typeof summarize>; shots: string[] }> = [];
			let moved = false;
			requireRealInput();
			// The HID tap first (the route the clicks arrive on), then "pid".
			for (const route of ['hid', 'pid']) {
				await installPointerRecorder();
				const before = await shotBitmap(`req80-gate2-3d-before-${route}`);
				const d = await operator('drag', { x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y, button: 'right', route });
				if (d && d.front === false) environment(2, 'the driver could not bring the window to the front for the right-drag; nothing was sent', { answer: d });
				await browser.pause(600);
				const after = await shotBitmap(`req80-gate2-3d-after-${route}`);
				const diff = diffPixels(before.bmp, after.bmp, stage, before.dpr);
				const record = summarize(await readPointerRecord());
				attempts.push({ route, diff, drag: d, record, shots: [before.file, after.file] });
				if (diff.differing > diff.total * 0.01) {
					moved = true;
					break;
				}
			}
			const popup = ax(['popupmenu', String(pid)])[0] ?? {};
			// Where the fault would be (a fact for the report; the judgement below is the gate's).
			const best = attempts.find((a) => a.record.pointerdown_right > 0) ?? attempts[0]!;
			const menuSeen = attempts.some((a) => ((a.drag?.popup_after_drag ?? []) as Array<{ found?: boolean }>).some((p) => p.found === true));
			const verdict = moved
				? 'the real right-drag pans the view'
				: menuSeen
					? 'WebKit opened its menu on the right mouse-down (the stage’s contextmenu preventDefault did not stop it, or the down did not reach the stage): the menu took the drag'
					: best.record.pointerdown_right > 0 && best.record.pointermove_with_right_button > 0
						? 'PRODUCT SUSPECTED: the right-button pointerdown and pointermoves reached .model-stage and the picture did not move'
						: best.record.pointerdown_right > 0
							? 'the right-button pointerdown reached the stage but no pointermove with the right button followed: the drag events did not arrive (tool / WebKit delivery)'
							: 'no right-button pointerdown reached the page: the real input did not arrive (tool / route)';
			fact(2, '3D right-drag: where the fault lies, from the page’s record of the pointer events', { verdict, control_moved: controlDiff.differing > controlDiff.total * 0.01, attempts: attempts.map((a) => ({ route: a.route, diff: a.diff, record: a.record, popup_after_drag: a.drag?.popup_after_drag ?? null, front_after: a.drag?.front_after ?? null })) });
			judge(2, 'right-drag on the 3D stage: the picture moved (> 1% of the stage’s pixels differ), no app menu, no WebKit menu', moved && !(await menuOpen()) && popup.found !== true, { attempts: attempts.map((a) => ({ route: a.route, diff: a.diff, drag: a.drag, shots: a.shots })), popup, verdict });
		} else {
			judge(2, 'the 3D stage exists', false, {});
		}
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 3
	it('gate 3: Explorer rows — Reload File enabled on the shown file’s row, greyed on another’s, absent on a folder’s and on the blank', async () => {
		await openDoc('notes.md', BODY);
		const shown = await rowMenu(uri('notes.md'));
		await shot('req80-gate3-shown-row');
		// 要件#83 契約 7(2026-11-05 承認 4 の要件側更新): Copy Path の後に Pin to Bookmarks が増えて 9 項目。
		judge(3, 'the shown file’s row: 9 items, Reload File after Open in New Window and enabled', JSON.stringify(shown.map((i) => i.label)) === JSON.stringify(['Reveal in Finder', 'Open with Default App', 'Open With…', 'Open in New Tab', 'Open in New Window', RELOAD_FILE, 'Copy Path', 'Pin to Bookmarks', 'Duplicate Window']) && shown.find((i) => i.label === RELOAD_FILE)?.disabled === false, { items: shown });
		const mark = await ipcMark();
		await clickMenuItem(RELOAD_FILE);
		const o = await reloadOutcome(mark);
		judge(3, 'pressing it reads the file (open_document of notes.md once) and closes the menu', o.opens.length === 1 && o.opens[0]!.uri === uri('notes.md') && !(await menuOpen()), { ...o });

		const other = await rowMenu(uri('plain.txt'));
		await shot('req80-gate3-other-row');
		judge(3, 'another file’s row: Reload File greyed', other.find((i) => i.label === RELOAD_FILE)?.disabled === true, { items: other });
		// "Pressing it does nothing" needs a real click (a DOM click() on a disabled
		// button is a no-op by itself — reviewer P3): realinput's `click` on the
		// item's centre, sent from here the way the calibration click was.
		const greyed = await rectOf(`${MENU_ITEM}:disabled`);
		if (greyed && OPERATOR && screen) {
			requireRealInput();
			const mark2 = await ipcMark();
			const client = { x: Math.round(greyed.x + greyed.width / 2), y: Math.round(greyed.y + greyed.height / 2) };
			const s = toScreen(client.x, client.y);
			// The landing: what the page has under the CSS point the click goes to
			// (WebKit sends no mousedown / click to a disabled <button> — that is
			// why pressing it does nothing — so the page's record cannot prove the
			// landing; run 5). Pointer events, if WebKit sends them, go to a fact.
			const landing = await browser.execute(
				(x, y, sel) => {
					const el = document.elementFromPoint(x, y);
					const item = el?.closest(sel) as HTMLButtonElement | null;
					return { element: el ? `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}` : null, on_item: !!item, item_label: item?.textContent?.trim() ?? null, item_disabled: item?.disabled ?? null };
				},
				client.x,
				client.y,
				MENU_ITEM,
			);
			await browser.execute(() => {
				const w = window as unknown as { __gate80click?: Array<{ type: string; target: string }> };
				w.__gate80click = [];
				for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
					window.addEventListener(type, (e) => {
						const t = e.target as HTMLElement | null;
						w.__gate80click!.push({ type, target: t ? `${t.tagName.toLowerCase()}.${typeof t.className === 'string' ? t.className : ''}` : '' });
					}, true);
				}
			});
			// The front through the driver (raise / activate / refocus / the real
			// title-bar click): the spec's own ensureFront has only AXRaise (run 4:
			// iTerm2 kept the front and this step went red as the environment).
			const mf = await operator('make-front', {});
			if (mf && mf.front !== true) environment(3, 'the driver could not bring the window to the front for the real click on the greyed item', { answer: mf });
			const facts = ri(['click', String(pid), String(s.x), String(s.y), screen.route])[0]!;
			await browser.pause(800);
			const seen = await browser.execute(() => (window as unknown as { __gate80click?: unknown[] }).__gate80click ?? []);
			fact(3, 'the real click on the greyed item: what the page saw (WebKit sends no mouse events to a disabled button)', { landing, events: seen, click: facts, route: screen.route });
			judge(3, 'a real click on the greyed Reload File (the point lands on the greyed item) does nothing (no IPC) and the menu stays', landing.on_item && landing.item_label === RELOAD_FILE && landing.item_disabled === true && (await ipcAfter(mark2, RELOAD_CMDS)).length === 0 && (await menuOpen()), { route: screen.route, landing, click: facts, ipc_after: await ipcAfter(mark2, RELOAD_CMDS) });
		} else {
			fact(3, 'a real click on the greyed item was not made (no operator / no greyed item on the screen)', { greyed });
		}
		if (await menuOpen()) await closeMenu();

		const folder = await rowMenu(uri('alpha'));
		judge(3, 'a folder’s row: no Reload File (Reload Folder instead)', !folder.some((i) => i.label === RELOAD_FILE) && folder.some((i) => i.label === RELOAD_FOLDER), { items: folder });
		await closeMenu();
		const blank = await paneMenu();
		judge(3, 'the blank: no Reload File', !blank.some((i) => i.label === RELOAD_FILE), { items: blank });
		await closeMenu();
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 4
	/** plain.txt's view (`pre.vellis-plaintext`, as req48nop) and its editor (the same `<pre>` made editable). */
	const PLAIN_VIEW = `${BODY} pre.vellis-plaintext`;
	const PLAIN_EDITOR = `${PLAIN_VIEW}[contenteditable="true"]`;
	async function makeDirty(text: string): Promise<boolean> {
		// `openDoc` waits for a selector the previous document satisfies too
		// (article.viewer): wait for the plain-text view itself (the 2026-11-05
		// run sent menu_edit while notes.md was still shown — a Markdown editor
		// has no contenteditable until a block is clicked).
		await closePanels();
		await clickExplorerRow(uri('plain.txt'));
		await browser.waitUntil(async () => (await exists(PLAIN_VIEW)) && (await textOf(PLAIN_VIEW)).includes('first line'), { timeout: 15_000, timeoutMsg: 'plain.txt did not open in the plain-text view' });
		if (!(await exists(PLAIN_EDITOR))) {
			await emitMenu('menu_edit');
			await waitFor(PLAIN_EDITOR, 'the editor', 5_000);
		}
		return browser.execute((sel, t) => {
			const el = document.querySelector<HTMLElement>(sel);
			if (!el) return false;
			el.focus();
			el.textContent = t;
			el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: t }));
			return true;
		}, PLAIN_EDITOR, text);
	}
	async function editorText(): Promise<string | null> {
		return browser.execute((sel) => document.querySelector<HTMLElement>(sel)?.textContent ?? null, PLAIN_EDITOR);
	}
	async function messageIpcCount(mark: number): Promise<number> {
		return (await ipcAfter(mark, ['plugin:dialog|message'])).length;
	}

	it('gate 4: an unsaved edit → one dialog (Save / Don’t Save / Cancel) — Esc keeps the edit and reads nothing, Return saves then reads, Command + D drops the edit and reads the disk', async () => {
		if (!OPERATOR) {
			skipped(4, 'the unsaved dialog', 'needs the operator (real keys)');
			return;
		}
		writeAtomic(file('plain.txt'), PLAIN_ORIGINAL);
		await browser.pause(500);
		// Cancel.
		judge(4, 'the editor took the edit', await makeDirty(PLAIN_EDITED), {});
		let mark = await ipcMark();
		await emitMenu('menu_reload_file');
		let d = await operator('dialog', { wait_s: 10, expect: UNSAVED_TITLE, answer: 'escape' });
		await browser.pause(1_200);
		const buttons = ((d?.buttons ?? []) as string[][])[0] ?? [];
		judge(4, 'ONE dialog with Save / Don’t Save / Cancel (where it was found is recorded)', (d?.dialogs ?? 0) === 1 && ['Save', "Don't Save", 'Cancel'].every((b) => buttons.includes(b)) && (await messageIpcCount(mark)) === 1, { dialog: d, message_ipc: await messageIpcCount(mark) });
		judge(4, 'Cancel (Esc): nothing is read, no folder is listed, the editor keeps the edit, the disk is unchanged', (await ipcAfter(mark, RELOAD_CMDS)).length === 0 && (await editorText())?.startsWith('first line edited') === true && fs.readFileSync(file('plain.txt'), 'utf8') === PLAIN_ORIGINAL, { ipc_after: await ipcAfter(mark, RELOAD_CMDS), editor: await editorText() });
		// Save.
		mark = await ipcMark();
		await emitMenu('menu_reload_file');
		d = await operator('dialog', { wait_s: 10, expect: UNSAVED_TITLE, answer: 'return' });
		const o = await reloadOutcome(mark);
		await waitViewerText('first line edited');
		// What the save wrote (the trailing newline is the editor's business — 要件#48 追補r); the next step must leave it as is.
		const savedDisk = fs.readFileSync(file('plain.txt'), 'utf8');
		judge(4, 'Save (Return): the file is written first (the edit is on the disk), then read (open_document once), the view shows the saved text, the editor is closed', (d?.dialogs ?? 0) === 1 && savedDisk.startsWith('first line edited\nsecond line') && o.opens.length === 1 && o.opens[0]!.ok === true && o.lists.length >= 1 && !(await exists('[contenteditable="true"]')), { dialog: d, ...o, disk: savedDisk });
		// Don't Save.
		judge(4, 'the editor took a second edit', await makeDirty(PLAIN_AGAIN), {});
		mark = await ipcMark();
		await emitMenu('menu_reload_file');
		d = await operator('dialog', { wait_s: 10, expect: UNSAVED_TITLE, answer: 'cmd-d' });
		const o2 = await reloadOutcome(mark);
		await browser.pause(500);
		judge(4, 'Don’t Save (Command + D): the edit is dropped, the disk is unchanged, the file is read (open_document once), the view shows the disk’s text', (d?.dialogs ?? 0) === 1 && fs.readFileSync(file('plain.txt'), 'utf8') === savedDisk && o2.opens.length === 1 && (await viewerText()).includes('first line edited') && !(await viewerText()).includes('first line again') && !(await exists('[contenteditable="true"]')), { dialog: d, ...o2, view: (await viewerText()).slice(0, 80), disk: fs.readFileSync(file('plain.txt'), 'utf8') });
		writeAtomic(file('plain.txt'), PLAIN_ORIGINAL);
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 5
	it('gate 5: media rewritten outside (auto-follow dropped) → Reload File brings the new content: PNG size, PDF colour, WAV duration + waveform, MP4 duration / colour / waveform + map.json, STL triangles', async () => {
		// PNG: 64 × 64 red → 128 × 96 blue.
		await openDoc('photo.png', 'article.image-viewer img.image');
		await browser.waitUntil(async () => browser.execute(() => (document.querySelector<HTMLImageElement>('article.image-viewer img.image')?.naturalWidth ?? 0) > 0), { timeout: 15_000, timeoutMsg: 'the PNG did not load' });
		const imgState = () => browser.execute(() => {
			const i = document.querySelector<HTMLImageElement>('article.image-viewer img.image');
			return i ? { w: i.naturalWidth, h: i.naturalHeight, src: i.src } : null;
		});
		const png0 = await imgState();
		await setDrop(['binary_file_changed', 'file_changed', 'file_removed']);
		rewriteFromAlt('photo.png');
		await browser.pause(2_500);
		const pngMasked = await imgState();
		let mark = await ipcMark();
		await emitMenu('menu_reload_file');
		let o = await reloadOutcome(mark);
		await browser.waitUntil(async () => (await imgState())?.w === 128, { timeout: 15_000, timeoutMsg: 'the PNG did not change after Reload File' });
		const png1 = await imgState();
		judge(5, 'PNG: 64 × 64 before, unchanged while the change is dropped, 128 × 96 with a new versioned src after Reload File (open_binary_document once)', png0?.w === 64 && pngMasked?.w === 64 && png1?.w === 128 && png1.h === 96 && png1.src !== png0.src && o.opens.length === 1 && o.opens[0]!.cmd === 'open_binary_document', { before: png0, masked: pngMasked, after: png1, ...o });

		// PDF: red page → blue page (pixels of the frame's centre).
		await openDoc('paper.pdf', 'iframe.pdf-frame');
		await browser.pause(2_000);
		const pdf0 = await pixelAtSelector('req80-gate5-pdf-before', 'iframe.pdf-frame');
		rewriteFromAlt('paper.pdf');
		await browser.pause(2_500);
		const pdfMasked = await pixelAtSelector('req80-gate5-pdf-masked', 'iframe.pdf-frame');
		mark = await ipcMark();
		await emitMenu('menu_reload_file');
		o = await reloadOutcome(mark);
		let pdf1 = await pixelAtSelector('req80-gate5-pdf-after', 'iframe.pdf-frame');
		await browser.waitUntil(
			async () => {
				pdf1 = await pixelAtSelector('req80-gate5-pdf-after', 'iframe.pdf-frame');
				return !!pdf1 && isBlue(pdf1.rgb);
			},
			{ timeout: 20_000, timeoutMsg: 'the PDF frame did not turn blue after Reload File' },
		).catch(() => undefined);
		judge(5, 'PDF: the page is red before and while dropped, blue after Reload File (open_binary_document once)', !!pdf0 && isRed(pdf0.rgb) && !!pdfMasked && isRed(pdfMasked.rgb) && !!pdf1 && isBlue(pdf1.rgb) && o.opens.length === 1 && o.opens[0]!.cmd === 'open_binary_document', { before: pdf0, masked: pdfMasked, after: pdf1, ...o });

		// WAV: 1 s loud → 3 s quiet (duration, and the waveform redrawn with less ink).
		await openDoc('tone.wav', 'article.audio-viewer audio');
		const audioDuration = () => browser.execute(() => document.querySelector<HTMLAudioElement>('article.audio-viewer audio')?.duration ?? null);
		await browser.waitUntil(async () => ((await audioDuration()) ?? 0) > 0.5, { timeout: 15_000, timeoutMsg: 'the WAV did not load' });
		await browser.waitUntil(async () => !/Analyzing/.test(await textOf('article.audio-viewer')), { timeout: 20_000, timeoutMsg: 'the waveform did not finish analyzing' });
		await browser.pause(800);
		const wav0 = { duration: await audioDuration(), band: await bandOf('req80-gate5-wav-before', 'article.audio-viewer .waveform-canvas') };
		rewriteFromAlt('tone.wav');
		await browser.pause(2_500);
		const wavMasked = { duration: await audioDuration() };
		mark = await ipcMark();
		await emitMenu('menu_reload_file');
		o = await reloadOutcome(mark);
		await browser.waitUntil(async () => ((await audioDuration()) ?? 0) > 2.5, { timeout: 15_000, timeoutMsg: 'the WAV duration did not change after Reload File' });
		await browser.waitUntil(async () => !/Analyzing/.test(await textOf('article.audio-viewer')), { timeout: 20_000, timeoutMsg: 'the waveform was not re-analyzed' });
		await browser.pause(800);
		const wav1 = { duration: await audioDuration(), band: await bandOf('req80-gate5-wav-after', 'article.audio-viewer .waveform-canvas') };
		// The alternate tone is silent in its second half: the band's shape changes whatever its scaling.
		const wavBand = bandChanged(wav0.band, wav1.band);
		judge(5, 'WAV: ~1 s before (and while dropped), ~3 s after Reload File, the waveform redrawn (the band differs in > 5% of its pixels and the left third’s share of the ink moved)', (wav0.duration ?? 0) < 1.5 && (wavMasked.duration ?? 0) < 1.5 && (wav1.duration ?? 0) > 2.5 && wavBand.pass && o.opens.length === 1 && o.opens[0]!.cmd === 'open_binary_document', { before: { duration: wav0.duration, band: bandFacts(wav0.band) }, masked: wavMasked, after: { duration: wav1.duration, band: bandFacts(wav1.band) }, band: wavBand, ...o });

		// MP4: 1 s red loud → 2 s blue quiet; starts paused at 0; the waveform redrawn.
		await openDoc('clip.mp4', 'article.video-viewer video.video');
		const videoState = () => browser.execute(() => {
			const v = document.querySelector<HTMLVideoElement>('article.video-viewer video.video');
			return v ? { duration: v.duration, currentTime: v.currentTime, paused: v.paused, src: v.src } : null;
		});
		await browser.waitUntil(async () => ((await videoState())?.duration ?? 0) > 0.5, { timeout: 15_000, timeoutMsg: 'the MP4 did not load' });
		await browser.waitUntil(async () => !/Analyzing/.test(await textOf('article.video-viewer')), { timeout: 20_000, timeoutMsg: 'the video waveform did not finish analyzing' });
		await browser.pause(1_000);
		const mp40 = { ...(await videoState()), pixel: await pixelAtSelector('req80-gate5-mp4-before', 'article.video-viewer video.video'), band: await bandOf('req80-gate5-mp4-wave-before', 'article.video-viewer .waveform-canvas') };
		rewriteFromAlt('clip.mp4');
		await browser.pause(2_500);
		const mp4Masked = await videoState();
		mark = await ipcMark();
		await emitMenu('menu_reload_file');
		o = await reloadOutcome(mark);
		await browser.waitUntil(async () => ((await videoState())?.duration ?? 0) > 1.5, { timeout: 15_000, timeoutMsg: 'the MP4 duration did not change after Reload File' });
		await browser.waitUntil(async () => !/Analyzing/.test(await textOf('article.video-viewer')), { timeout: 20_000, timeoutMsg: 'the video waveform was not re-analyzed' });
		let mp4Pixel = await pixelAtSelector('req80-gate5-mp4-after', 'article.video-viewer video.video');
		await browser.waitUntil(
			async () => {
				mp4Pixel = await pixelAtSelector('req80-gate5-mp4-after', 'article.video-viewer video.video');
				return !!mp4Pixel && isBlue(mp4Pixel.rgb);
			},
			{ timeout: 15_000, timeoutMsg: 'the video frame did not turn blue after Reload File' },
		).catch(() => undefined);
		const mp41 = { ...(await videoState()), pixel: mp4Pixel, band: await bandOf('req80-gate5-mp4-wave-after', 'article.video-viewer .waveform-canvas') };
		const mp4Band = bandChanged(mp40.band, mp41.band);
		judge(5, 'MP4: ~1 s red before (and while dropped), ~2 s blue after Reload File, paused at 0, the waveform redrawn (the band differs in > 5% of its pixels and the left third’s share moved), open_binary_document once', (mp40.duration ?? 0) < 1.5 && (mp4Masked?.duration ?? 0) < 1.5 && (mp41.duration ?? 0) > 1.5 && !!mp40.pixel && isRed(mp40.pixel.rgb) && !!mp41.pixel && isBlue(mp41.pixel.rgb) && mp41.paused === true && (mp41.currentTime ?? 1) < 0.1 && mp4Band.pass && o.opens.length === 1 && o.opens[0]!.cmd === 'open_binary_document', { before: { ...mp40, band: bandFacts(mp40.band) }, masked: mp4Masked, after: { ...mp41, band: bandFacts(mp41.band) }, band: mp4Band, ...o });

		// The map alone: the Sources panel shows the input's file name; only the sidecar is rewritten.
		await browser.execute(() => {
			const b = Array.from(document.querySelectorAll<HTMLButtonElement>('article.video-viewer .video-toolbar button')).find((x) => x.textContent?.trim() === 'Sources');
			b?.click();
		});
		await waitFor('.provenance-panel', 'the Sources panel');
		const panelName = () => textOf('.provenance-panel .file-name');
		await browser.waitUntil(async () => /raw/.test(await panelName()), { timeout: 15_000, timeoutMsg: `the Sources panel did not show the input (panel: ${JSON.stringify((await textOf('.provenance-panel')).slice(0, 200))})` });
		const map0 = await panelName();
		rewriteFromAlt('clip.mp4.map.json');
		await browser.pause(2_500);
		const mapMasked = await panelName();
		mark = await ipcMark();
		await emitMenu('menu_reload_file');
		o = await reloadOutcome(mark);
		await browser.waitUntil(async () => /raw-v2/.test(await panelName()), { timeout: 15_000, timeoutMsg: 'the Sources panel did not pick up the rewritten map' });
		const map1 = await panelName();
		judge(5, 'map.json alone: the Sources panel shows raw.mov before (the sidecar is not watched: unchanged after the rewrite), raw-v2.mov after Reload File; the panel stays open', /raw\.mov/.test(map0) && /raw\.mov/.test(mapMasked) && /raw-v2\.mov/.test(map1) && (await exists('.provenance-panel')), { before: map0, masked: mapMasked, after: map1, ...o });
		await browser.execute(() => document.querySelector<HTMLButtonElement>('.provenance-panel header button')?.click());

		// STL: 12 triangles → 2.
		await openDoc('cube.stl', '.model-stage canvas');
		const stats = () => textOf('.model-stats');
		await browser.waitUntil(async () => /triangles/.test(await stats()), { timeout: 20_000, timeoutMsg: 'the STL did not load' });
		const stl0 = await stats();
		rewriteFromAlt('cube.stl');
		await browser.pause(2_500);
		const stlMasked = await stats();
		mark = await ipcMark();
		await emitMenu('menu_reload_file');
		o = await reloadOutcome(mark);
		await browser.waitUntil(async () => /^2 triangles/.test(await stats()), { timeout: 20_000, timeoutMsg: 'the STL stats did not change after Reload File' });
		const stl1 = await stats();
		judge(5, 'STL: 12 triangles before (and while dropped), 2 after Reload File (open_binary_document once)', /^12 triangles/.test(stl0) && /^12 triangles/.test(stlMasked) && /^2 triangles/.test(stl1) && o.opens.length === 1 && o.opens[0]!.cmd === 'open_binary_document', { before: stl0, masked: stlMasked, after: stl1, ...o });
		await setDrop([]);
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 7
	it('gate 7: the shown file deleted outside (file_removed dropped) → Reload File → one real "Could not reload the file: …", the view stays, the tree is still listed', async () => {
		if (!OPERATOR) {
			skipped(7, 'the real alert', 'needs the operator');
			return;
		}
		await openDoc('gone.md', BODY);
		await waitViewerText('GATE80-GONE');
		await setDrop(['file_removed', 'file_changed']);
		fs.rmSync(file('gone.md'));
		await browser.pause(2_500);
		const stillShown = (await viewerText()).includes('GATE80-GONE');
		await setAlertMode('real');
		const al = await alertsMark();
		const mark = await ipcMark();
		await emitMenu('menu_reload_file');
		const d = await operator('dialog', { wait_s: 12, expect: FILE_FAILED, answer: 'return' });
		await browser.pause(800);
		await setAlertMode('stub');
		const after = await waitIpcSettled(mark, RELOAD_CMDS, 1, 15_000);
		const alerts = await alertsAfter(al);
		const open = after.find((e) => e.cmd === 'open_document');
		judge(7, 'the file is deleted while shown and the view stays (file_removed dropped)', stillShown, { still_shown: stillShown });
		judge(7, 'Reload File: ONE alert "Could not reload the file: …" (a real dialog found and closed by the driver), open_document failed', (d?.dialogs ?? 0) === 1 && alerts.length === 1 && alerts[0]!.startsWith(FILE_FAILED) && !!open && open.ok === false, { dialog: d, alerts, open });
		judge(7, 'after the failure: the view still shows the document, the tree was listed anyway (list_dir of the root)', (await viewerText()).includes('GATE80-GONE') && after.some((e) => e.cmd === 'list_dir' && e.uri === rootUri), { listed: after.filter((e) => e.cmd === 'list_dir').map((e) => e.uri) });
		await setDrop([]);
		await openDoc('notes.md', BODY);
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 8
	it('gate 8: Reload Folder — a folder row (it and its expanded descendants only; adds / removes / renames; expansion kept), a collapsed row (expands, reads once), the blank (root + every expanded folder, above Duplicate Window with one separator)', async () => {
		await openDoc('notes.md', BODY);
		await ensureExpanded('alpha', 'alpha/a1.md');
		await ensureExpanded('alpha/inner', 'alpha/inner/i1.md');
		if (await explorerHasRow(uri('beta/b1.md'))) await clickExplorerRow(uri('beta'));
		await browser.waitUntil(async () => !(await explorerHasRow(uri('beta/b1.md'))), { timeout: 5_000, timeoutMsg: 'beta did not collapse' });
		await setDrop(['directory_changed']);
		writeAtomic(file('alpha/new-a.md'), '# new a\n');
		fs.rmSync(file('alpha/a2.md'));
		fs.renameSync(file('alpha/inner/i1.md'), file('alpha/inner/i1-renamed.md'));
		writeAtomic(file('root-new.md'), '# root new\n');
		await browser.pause(2_500);
		const masked = { new_a: await explorerHasRow(uri('alpha/new-a.md')), a2: await explorerHasRow(uri('alpha/a2.md')), i1_renamed: await explorerHasRow(uri('alpha/inner/i1-renamed.md')), root_new: await explorerHasRow(uri('root-new.md')) };
		fact(8, 'before Reload Folder: the outside changes are not in the tree (directory_changed dropped)', masked);

		// The folder row.
		const items = await rowMenu(uri('alpha'));
		await shot('req80-gate8-folder-row');
		// 要件#83 契約 7(2026-11-05 承認 4 の要件側更新): Copy Path の後に Pin to Bookmarks が増えて 6 項目(items[2] の Reload Folder はそのまま)。
		judge(8, 'a folder’s row: Reveal in Finder・Open in New Window・Reload Folder・Copy Path・Pin to Bookmarks・Duplicate Window (Reload Folder right after Open in New Window, enabled)', JSON.stringify(items.map((i) => i.label)) === JSON.stringify(['Reveal in Finder', 'Open in New Window', RELOAD_FOLDER, 'Copy Path', 'Pin to Bookmarks', 'Duplicate Window']) && items[2]!.disabled === false, { items });
		let mark = await ipcMark();
		await clickMenuItem(RELOAD_FOLDER);
		let lists = await waitIpcSettled(mark, ['list_dir'], 2, 15_000);
		await waitForExplorerRow(uri('alpha/new-a.md'), { timeout: 10_000 });
		await waitForExplorerRow(uri('alpha/inner/i1-renamed.md'), { timeout: 10_000 });
		const afterRow = { new_a: await explorerHasRow(uri('alpha/new-a.md')), a2: await explorerHasRow(uri('alpha/a2.md')), i1: await explorerHasRow(uri('alpha/inner/i1.md')), i1_renamed: await explorerHasRow(uri('alpha/inner/i1-renamed.md')), root_new: await explorerHasRow(uri('root-new.md')), a1: await explorerHasRow(uri('alpha/a1.md')) };
		const listed = lists.map((e) => e.uri);
		judge(8, 'folder row: list_dir of alpha and alpha/inner only (not the root, not beta), in that order', listed[0] === uri('alpha') && listed.includes(uri('alpha/inner')) && !listed.includes(rootUri) && !listed.includes(uri('beta')) && !(await menuOpen()), { listed });
		judge(8, 'folder row: the added file shows, the removed one is gone, the renamed one shows under the still-expanded inner folder; the root’s add is not shown (not re-listed)', afterRow.new_a && !afterRow.a2 && !afterRow.i1 && afterRow.i1_renamed && !afterRow.root_new && afterRow.a1, afterRow);

		// The collapsed row.
		const betaItems = await rowMenu(uri('beta'));
		mark = await ipcMark();
		await clickMenuItem(RELOAD_FOLDER);
		await waitForExplorerRow(uri('beta/b1.md'), { timeout: 10_000 });
		await browser.pause(1_500);
		lists = await ipcAfter(mark, ['list_dir']);
		judge(8, 'a collapsed folder’s row: Reload Folder expands it and its content shows; list_dir of beta exactly once (no double read)', betaItems.some((i) => i.label === RELOAD_FOLDER) && lists.filter((e) => e.uri === uri('beta')).length === 1, { listed: lists.map((e) => e.uri) });

		// The blank.
		const blank = await paneMenu();
		const seps = await menuSeparators();
		await shot('req80-gate8-blank');
		judge(8, 'the blank: Reload Folder above Duplicate Window with one separator between', JSON.stringify(blank.map((i) => i.label)) === JSON.stringify([RELOAD_FOLDER, 'Duplicate Window']) && seps === 1 && blank[0]!.disabled === false, { items: blank, separators: seps });
		mark = await ipcMark();
		await clickMenuItem(RELOAD_FOLDER);
		lists = await waitIpcSettled(mark, ['list_dir'], 4, 15_000);
		await waitForExplorerRow(uri('root-new.md'), { timeout: 10_000 });
		const blankListed = lists.map((e) => e.uri);
		judge(8, 'the blank: list_dir of the root first, then every expanded folder (alpha, alpha/inner, beta); the root’s added file shows', blankListed[0] === rootUri && [uri('alpha'), uri('alpha/inner'), uri('beta')].every((u) => blankListed.includes(u)) && (await explorerHasRow(uri('root-new.md'))), { listed: blankListed });
		await setDrop([]);
		expect(fails).toEqual([]);
	});

	// ------------------------------------------------------------------ gate 9
	it('gate 9: an expanded folder made unreadable → Reload Folder → ONE "Could not reload the folder: …", the old rows stay; Reload File’s tree failure is silent', async () => {
		if (!OPERATOR) {
			skipped(9, 'chmod and the real alert', 'needs the operator');
			return;
		}
		await openDoc('notes.md', BODY);
		await ensureExpanded('gamma', 'gamma/g1.md');
		const ch = await operator('chmod', { path: file('gamma'), mode: '000' });
		if (ch?.ok !== true) {
			judge(9, 'precondition: the driver changed the folder’s mode', false, { chmod: ch });
			expect(fails).toEqual([]);
			return;
		}
		try {
			// What the chmod itself did to the tree, before Reload Folder is pressed
			// (the 2026-11-05 run: the watch hub re-listed gamma after the chmod and
			// failed; whether a row went away on that path is the watcher's business,
			// 要件#18, not this requirement's — recorded, with the IPC and the events
			// of that interval). The judgement below compares the rows around the press.
			const chmodMark = (await hooks()).ipc.length;
			const chmodEvents = await eventsMark();
			await browser.pause(2_500);
			const rowsBefore = await explorerNames();
			fact(9, 'after the chmod, before Reload Folder: is gamma/g1.md still listed (the watcher’s path, 要件#18 — not judged here)', { g1_listed: await explorerHasRow(uri('gamma/g1.md')), rows: rowsBefore, ipc_since_chmod: (await ipcAfter(chmodMark)).map((e) => ({ cmd: e.cmd, uri: e.uri, ok: e.ok })), events_since_chmod: (await eventsAfter(chmodEvents)).map((e) => ({ event: e.event, uri: e.uri })) });
			await setAlertMode('real');
			let al = await alertsMark();
			let mark = await ipcMark();
			await rowMenu(uri('gamma'));
			await clickMenuItem(RELOAD_FOLDER);
			const d = await operator('dialog', { wait_s: 12, expect: FOLDER_FAILED, answer: 'return' });
			await browser.pause(800);
			const lists = await waitIpcSettled(mark, ['list_dir'], 1, 15_000);
			const alerts = await alertsAfter(al);
			const rowsAfter = await explorerNames();
			judge(9, 'Reload Folder on the unreadable folder: ONE alert "Could not reload the folder: …" (real, found and closed by the driver), list_dir of gamma failed', (d?.dialogs ?? 0) === 1 && alerts.length === 1 && alerts[0]!.startsWith(FOLDER_FAILED) && lists.some((e) => e.uri === uri('gamma') && e.ok === false), { dialog: d, alerts, lists: lists.map((e) => ({ uri: e.uri, ok: e.ok })) });
			judge(9, 'the old rows stay: the tree lists the same rows right before and right after the press (a failed folder is not applied)', JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter), { rows_before: rowsBefore, rows_after: rowsAfter, g1_listed_after: await explorerHasRow(uri('gamma/g1.md')) });

			// Reload File with the folder still unreadable: the tree's failure is silent.
			al = await alertsMark();
			mark = await ipcMark();
			await emitMenu('menu_reload_file');
			const o = await reloadOutcome(mark);
			const d2 = await operator('dialog', { wait_s: 3, expect: '', answer: 'escape' });
			judge(9, 'Reload File while a folder is unreadable: no alert, no dialog; the file is read, list_dir of gamma fails quietly, the other folders are listed', (await alertsAfter(al)).length === 0 && (d2?.dialogs ?? 0) === 0 && o.opens.length === 1 && o.opens[0]!.ok === true && o.lists.some((l) => l.uri === uri('gamma') && l.ok === false) && o.lists.some((l) => l.uri === rootUri && l.ok === true), { ...o, dialogs: d2, alerts: await alertsAfter(al) });
		} finally {
			await setAlertMode('stub');
			await operator('chmod-restore', {});
		}
		expect(fails).toEqual([]);
	});

	// ----------------------------------------------------------------- gate 10
	it('gate 10: the fact for 事後確認 7 / reviewer P2-1 — a folder row selected, Reload File of a text → where the selection is afterwards (screenshots; the judgement is 由谷’s)', async () => {
		await openDoc('notes.md', BODY);
		const activeRow = () => browser.execute(() => document.querySelector<HTMLElement>('.explorer-item.active')?.title ?? null);
		// A folder row gets selected by Go to only when the folder has nothing to
		// open (要件#60 挙動表 2: empty / subfolders only / unopenable only → expand
		// and select; otherwise its first openable file is opened — run 2 landed
		// on alpha/a1.md). So: an empty folder `delta`, by its absolute path.
		fs.mkdirSync(file('delta'), { recursive: true });
		await waitForExplorerRow(uri('delta'), { timeout: 15_000, nudgeDir: root, nudgePrefix: 'req80-delta' });
		const goToDelta = async (what: string) => {
			await emitMenu('menu_go_to');
			await waitFor('[data-testid="go-to-input"]', 'Go to bar', 5_000);
			await browser.execute((p) => {
				const input = document.querySelector<HTMLInputElement>('[data-testid="go-to-input"]')!;
				input.value = p;
				input.dispatchEvent(new Event('input', { bubbles: true }));
				document.querySelector<HTMLButtonElement>('[data-testid="go-to-go"]')!.click();
			}, file('delta'));
			try {
				await browser.waitUntil(async () => (await activeRow()) === uri('delta'), { timeout: 10_000, timeoutMsg: `Go to did not select the delta row (${what})` });
			} catch (e) {
				report(REPORT, { gate: 10, item: `Go to ${file('delta')} (${what})`, error: String(e), active: await activeRow(), message: await textOf('[data-testid="go-to-message"]'), rows: await explorerNames() });
				throw e;
			}
			await closePanels();
		};
		await goToDelta('text');
		const before = await activeRow();
		const shotBefore = await shot('req80-gate10-selection-before');
		const mark = await ipcMark();
		await emitMenu('menu_reload_file');
		await reloadOutcome(mark);
		await browser.pause(500);
		const after = await activeRow();
		const shotAfter = await shot('req80-gate10-selection-after');
		fact(10, 'folder row selected → Reload File of the shown text: the tree selection before / after (事後確認 7・P2-1; the contract 3 path = setDocument moves it to the document’s row)', { selected_before: before, selected_after: after, moved_to_document_row: after === uri('notes.md'), shots: [shotBefore, shotAfter] });
		// The same with a binary (the version bump does not touch the selection).
		await openDoc('photo.png', 'article.image-viewer img.image');
		await goToDelta('binary');
		const mark2 = await ipcMark();
		await emitMenu('menu_reload_file');
		await reloadOutcome(mark2);
		await browser.pause(500);
		fact(10, 'the same with a binary (photo.png): the selection before / after', { selected_before: uri('delta'), selected_after: await activeRow(), shots: [await shot('req80-gate10-selection-binary-after')] });
		fact(10, 'the decisions (a)〜(z): which gate shows them', {
			'(a)(b) name / Command + R': 'gate 1a',
			'(c) all kinds, keeps what auto-follow keeps': 'gate 5 (video: paused at 0; 3D: the view resets = eye on the gate 5 shots)',
			'(d)(t) the unsaved dialog before reading, Cancel reads nothing': 'gate 4',
			'(e) failure tells once, the view stays': 'gate 7',
			'(f)(n) ssh like local, tree too': 'gate 6 / 8 (ssh)',
			'(g)(s) body menu only without a selection / editable / 3D / panel': 'gate 2, gate 1c',
			'(h) Explorer rows': 'gate 3',
			'(i)(k)(l)(m)(p)(v)(w)(y) Reload Folder': 'gate 8',
			'(j)(o)(q) tree with Reload File, silent failure, no document': 'gate 1b / 1d / 9',
			'(r) View order': 'gate 1a',
			'(u) no overlap': 'AC-80-7 / AC-80-16 (vitest)',
			'(x) one notice': 'gate 9',
			'(z) no re-watch': 'AC-80-16 (vitest); not observable here',
		});
		expect(fails).toEqual([]);
	});

	it('alerts seen by the local phase: exactly the two the gates asked for (gate 7, gate 9)', async () => {
		const h = await hooks();
		judge('alerts', 'every alert of the run starts with a reload failure text', h.alerts.every((a) => a.startsWith(FILE_FAILED) || a.startsWith(FOLDER_FAILED)), { alerts: h.alerts });
		expect(fails).toEqual([]);
	});
});

// =======================================================================================
describe('Requirement #80 human gates, the machine part — ssh root (gates 3, 6, 8, 9, 10)', function () {
	this.timeout(900_000);
	const remoteRoot = process.env.VELLIS_E2E_SSH_ROOT ?? '';
	let pid = 0;

	before(async function () {
		if (!DEVICE || VARIANT !== 'ssh') this.skip();
		if (!remoteRoot || !fs.existsSync(remoteRoot)) throw new Error(`VELLIS_E2E_SSH_ROOT is not a folder: ${remoteRoot}`);
		fs.mkdirSync(SHOTS_DIR, { recursive: true });
		fs.rmSync(OP_DIR, { recursive: true, force: true });
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await installHooks();
		await assertDropWorks();
		await browser.setTimeout({ script: 120_000 });
		await browser.waitUntil(async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0), { timeout: 60_000, timeoutMsg: 'explorer never listed the ssh root' });
		const readme = await explorerRowUriByName('README.md');
		if (readme) rootUri = readme.slice(0, -'/README.md'.length);
		pid = appPid();
		report(REPORT, { gate: 'setup', variant: VARIANT, operator: OPERATOR, pid, rootUri, remoteRoot, rows: await explorerNames() });
		expect(rootUri.startsWith('ssh://')).toBe(true);
	});

	async function resetScreen(when: string): Promise<void> {
		const closed = await closePanels();
		await setDrop([]);
		await setAlertMode('stub');
		if (closed.length > 0) report(REPORT, { gate: 'reset', when, closed });
	}
	beforeEach(async function () {
		if (!DEVICE || VARIANT !== 'ssh') return;
		fails = [];
		realInputBlocked = null;
		await resetScreen(`before: ${this.currentTest?.title ?? '?'}`);
	});
	afterEach(async function () {
		if (!DEVICE || VARIANT !== 'ssh') return;
		if (this.currentTest?.state === 'failed') {
			report(REPORT, { gate: 'failed', test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
		}
		await resetScreen(`after: ${this.currentTest?.title ?? '?'}`).catch(() => undefined);
	});
	after(async function () {
		if (!DEVICE || VARIANT !== 'ssh') return;
		try {
			const h = await hooks();
			report(REPORT, { gate: 'teardown', variant: VARIANT, alerts: h.alerts });
			await restoreHooks();
			await restoreGateRecorder();
		} finally {
			await operator('done', {}, 10_000).catch(() => null);
		}
	});

	it('gate 3 (ssh): Reload File enabled on the shown file’s row, greyed on another’s, absent on a folder’s and the blank; Reload Folder on the folder’s row', async () => {
		await ensureExpanded('docs', 'docs/guide.md');
		await openDoc('docs/guide.md', BODY);
		await waitViewerText('Guide');
		const shown = await rowMenu(uri('docs/guide.md'));
		await shot('req80-ssh-gate3-shown-row');
		judge('3-ssh', 'the shown file’s row over ssh: Reload File after Open in New Window, enabled', shown.map((i) => i.label).indexOf(RELOAD_FILE) === shown.map((i) => i.label).indexOf('Open in New Window') + 1 && shown.find((i) => i.label === RELOAD_FILE)?.disabled === false, { items: shown });
		const mark = await ipcMark();
		await clickMenuItem(RELOAD_FILE);
		const o = await reloadOutcome(mark);
		judge('3-ssh', 'pressing it reads the file over ssh (open_document once, ok) and lists the root and docs', o.opens.length === 1 && o.opens[0]!.ok === true && o.listUris.includes(rootUri) && o.listUris.includes(uri('docs')), { ...o });
		const other = await rowMenu(uri('notes.txt'));
		judge('3-ssh', 'another file’s row: Reload File greyed', other.find((i) => i.label === RELOAD_FILE)?.disabled === true, { items: other });
		await closeMenu();
		const folder = await rowMenu(uri('docs'));
		judge('3-ssh', 'a folder’s row: Reload Folder (enabled), no Reload File', folder.some((i) => i.label === RELOAD_FOLDER && !i.disabled) && !folder.some((i) => i.label === RELOAD_FILE), { items: folder });
		await closeMenu();
		const blank = await paneMenu();
		judge('3-ssh', 'the blank: Reload Folder, no Reload File', blank[0]?.label === RELOAD_FOLDER && !blank.some((i) => i.label === RELOAD_FILE), { items: blank });
		await closeMenu();
		expect(fails).toEqual([]);
	});

	it('gate 6: a change within 2 s of opening is missed by the poll (recorded) and shows after Reload File; a file added to an expanded folder shows in the tree after Reload File', async () => {
		await ensureExpanded('docs', 'docs/guide.md');
		await closePanels();
		// (a) the early change.
		writeInPlace(path.join(remoteRoot, 'docs', 'guide.md'), '# Guide\n\n- one\n- two\n');
		await browser.pause(3_000);
		const t0 = Date.now();
		await clickExplorerRow(uri('docs/guide.md'));
		await waitViewerText('Guide');
		writeInPlace(path.join(remoteRoot, 'docs', 'guide.md'), '# Guide\n\nGATE80-SSH-EARLY\n');
		const msAfterOpen = Date.now() - t0;
		await browser.pause(5_000);
		const shownBefore = (await viewerText()).includes('GATE80-SSH-EARLY');
		fact(6, 'a change written right after opening (backlog 325): shown by the poll within 5 s?', { ms_after_click: msAfterOpen, shown_before_reload: shownBefore });
		let mark = await ipcMark();
		await emitMenu('menu_reload_file');
		const o = await reloadOutcome(mark);
		await waitViewerText('GATE80-SSH-EARLY');
		judge(6, 'Reload File shows the early change (open_document over ssh once, ok; the view has the new content)', o.opens.length === 1 && o.opens[0]!.ok === true, { ...o, shown_before_reload: shownBefore, ms_after_click: msAfterOpen });
		// (b) a file added to the expanded folder.
		writeAtomic(path.join(remoteRoot, 'docs', 'added-by-gate.md'), '# added over ssh\n');
		await browser.pause(5_000);
		const rowBefore = await explorerHasRow(uri('docs/added-by-gate.md'));
		mark = await ipcMark();
		await emitMenu('menu_reload_file');
		const o2 = await reloadOutcome(mark);
		await waitForExplorerRow(uri('docs/added-by-gate.md'), { timeout: 15_000 });
		judge(6, 'a file added to the expanded docs folder: not listed by itself (no watch over ssh — recorded), listed after Reload File (list_dir of docs)', o2.listUris.includes(uri('docs')) && (await explorerHasRow(uri('docs/added-by-gate.md'))), { row_before_reload: rowBefore, ...o2 });
		expect(fails).toEqual([]);
	});

	it('gate 8 (ssh): Reload Folder on the folder row and on the blank re-lists over ssh; a collapsed row expands', async () => {
		await ensureExpanded('docs', 'docs/guide.md');
		await ensureExpanded('docs/nested', 'docs/nested/deep.md');
		writeAtomic(path.join(remoteRoot, 'docs', 'new1.md'), '# new1\n');
		writeAtomic(path.join(remoteRoot, 'docs', 'nested', 'new2.md'), '# new2\n');
		writeAtomic(path.join(remoteRoot, 'root-new.md'), '# root new\n');
		await browser.pause(3_000);
		const before = { new1: await explorerHasRow(uri('docs/new1.md')), new2: await explorerHasRow(uri('docs/nested/new2.md')), root_new: await explorerHasRow(uri('root-new.md')) };
		await rowMenu(uri('docs'));
		let mark = await ipcMark();
		await clickMenuItem(RELOAD_FOLDER);
		let lists = await waitIpcSettled(mark, ['list_dir'], 2, 20_000);
		await waitForExplorerRow(uri('docs/new1.md'), { timeout: 15_000 });
		await waitForExplorerRow(uri('docs/nested/new2.md'), { timeout: 15_000 });
		judge('8-ssh', 'folder row over ssh: list_dir of docs and docs/nested only, the added files show, nested stays expanded', lists[0]?.uri === uri('docs') && lists.some((e) => e.uri === uri('docs/nested')) && !lists.some((e) => e.uri === rootUri), { before, listed: lists.map((e) => e.uri) });
		const blank = await paneMenu();
		mark = await ipcMark();
		await clickMenuItem(RELOAD_FOLDER);
		lists = await waitIpcSettled(mark, ['list_dir'], 3, 20_000);
		await waitForExplorerRow(uri('root-new.md'), { timeout: 15_000 });
		judge('8-ssh', 'the blank over ssh: list_dir of the root first, then docs and docs/nested; the root’s added file shows', blank[0]?.label === RELOAD_FOLDER && lists[0]?.uri === rootUri && [uri('docs'), uri('docs/nested')].every((u) => lists.some((e) => e.uri === u)), { listed: lists.map((e) => e.uri) });
		// A collapsed row.
		if (await explorerHasRow(uri('docs/nested/deep.md'))) await clickExplorerRow(uri('docs/nested'));
		await browser.waitUntil(async () => !(await explorerHasRow(uri('docs/nested/deep.md'))), { timeout: 5_000, timeoutMsg: 'nested did not collapse' });
		await rowMenu(uri('docs/nested'));
		mark = await ipcMark();
		await clickMenuItem(RELOAD_FOLDER);
		await waitForExplorerRow(uri('docs/nested/deep.md'), { timeout: 15_000 });
		await browser.pause(1_500);
		lists = await ipcAfter(mark, ['list_dir']);
		judge('8-ssh', 'a collapsed row over ssh: expands and reads once', lists.filter((e) => e.uri === uri('docs/nested')).length === 1, { listed: lists.map((e) => e.uri) });
		expect(fails).toEqual([]);
	});

	it('gate 10 (ssh): timing of Reload File and the blank’s Reload Folder with 13 expanded folders (事後確認 7)', async () => {
		await ensureExpanded('many', 'many/d01');
		for (let i = 1; i <= 12; i += 1) {
			const d = `many/d${String(i).padStart(2, '0')}`;
			await ensureExpanded(d, `${d}/f${String(i).padStart(2, '0')}.md`);
		}
		await ensureExpanded('docs', 'docs/guide.md');
		await openDoc('README.md', BODY);
		await waitViewerText('Vellis over ssh');
		let mark = await ipcMark();
		const t0 = Date.now();
		await emitMenu('menu_reload_file');
		const o = await reloadOutcome(mark, 120_000);
		const wall = Date.now() - t0;
		fact('10-ssh', 'Reload File with 14+ expanded folders over ssh: list_dir count, the span from the first IPC to the last answer, the wall time', { list_dir_count: o.lists.length, span_ms: o.span_ms, wall_ms: wall, open_ms: o.opens[0]?.ms ?? null, slowest_list_ms: Math.max(...o.lists.map((l) => l.ms ?? 0)) });
		await paneMenu();
		mark = await ipcMark();
		const t1 = Date.now();
		await clickMenuItem(RELOAD_FOLDER);
		// Reload File's count includes the rows' own re-reads after an apply (41 for
		// 14 folders in the 2026-11-05 run); the blank's Reload Folder must answer
		// at least one list_dir per distinct folder, then settle.
		const distinct = new Set(o.lists.map((l) => l.uri)).size;
		const lists = await waitIpcSettled(mark, ['list_dir'], distinct, 120_000);
		const wall2 = Date.now() - t1;
		fact('10-ssh', 'the blank’s Reload Folder with the same folders: list_dir count, span, wall time', { list_dir_count: lists.length, span_ms: spanMs(lists), wall_ms: wall2, slowest_list_ms: Math.max(...lists.map((l) => (l.t1 ?? l.t0) - l.t0)) });
		judge('10-ssh', 'both reloads completed (every list_dir answered ok)', o.lists.every((l) => l.ok === true) && lists.every((l) => l.ok === true), {});
		expect(fails).toEqual([]);
	});

	it('gate 9 (ssh, last): the sshd stopped → Reload Folder → ONE "Could not reload the folder: …", the rows stay; Reload File → ONE "Could not reload the file: …", the view stays', async () => {
		if (!OPERATOR) {
			skipped('9-ssh', 'stopping the sshd and the real alert', 'needs the operator');
			return;
		}
		await ensureExpanded('docs', 'docs/guide.md');
		await openDoc('README.md', BODY);
		await waitViewerText('Vellis over ssh');
		const stop = await operator('sshd-stop', {});
		await browser.pause(1_500);
		await setAlertMode('real');
		let al = await alertsMark();
		let mark = await ipcMark();
		await rowMenu(uri('docs'));
		await clickMenuItem(RELOAD_FOLDER);
		const d = await operator('dialog', { wait_s: 30, expect: FOLDER_FAILED, answer: 'return' });
		await browser.pause(800);
		const lists = await waitIpcSettled(mark, ['list_dir'], 1, 60_000);
		judge('9-ssh', 'Reload Folder with the connection gone: ONE alert "Could not reload the folder: …", list_dir failed, the rows stay', (d?.dialogs ?? 0) === 1 && (await alertsAfter(al)).length === 1 && lists.some((e) => e.ok === false) && (await explorerHasRow(uri('docs/guide.md'))), { stop, dialog: d, alerts: await alertsAfter(al), lists: lists.map((e) => ({ uri: e.uri, ok: e.ok })) });
		al = await alertsMark();
		mark = await ipcMark();
		await emitMenu('menu_reload_file');
		const d2 = await operator('dialog', { wait_s: 30, expect: FILE_FAILED, answer: 'return' });
		await browser.pause(800);
		const after = await waitIpcSettled(mark, RELOAD_CMDS, 1, 60_000);
		const d3 = await operator('dialog', { wait_s: 3, expect: '', answer: 'escape' });
		judge('9-ssh', 'Reload File with the connection gone: ONE alert "Could not reload the file: …" and no second dialog for the tree; the view stays', (d2?.dialogs ?? 0) === 1 && (d3?.dialogs ?? 0) === 0 && (await alertsAfter(al)).length === 1 && (await alertsAfter(al))[0]!.startsWith(FILE_FAILED) && (await viewerText()).includes('Vellis over ssh'), { dialog: d2, extra: d3, alerts: await alertsAfter(al), ipc: after.map((e) => ({ cmd: e.cmd, uri: e.uri, ok: e.ok })) });
		await setAlertMode('stub');
		expect(fails).toEqual([]);
	});
});
