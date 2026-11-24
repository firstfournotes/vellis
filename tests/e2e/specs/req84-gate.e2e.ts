import { browser } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
	revertFace,
	replaceFaceText,
	faceText,
	faceDirty,
	FACE_CONTENT,
	assertEventRecorderWorks,
	assertIpcInterceptionWorks,
	clickExplorerRow,
	emitMenu,
	explorerNames,
	installEventRecorder,
	installGateRecorder,
	readEventRecord,
	readGateRecord,
	removeEventRecorder,
	report,
	restoreGateRecorder,
	SHOTS_DIR,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

/**
 * Requirement #84 (the current editing and AI integration hidden in the release
 * build, shown in the dev-features build) — the machine-checkable part of the
 * human gates 1〜8 of docs/requirements/req-84.md (「人間ゲート」節), driven
 * against the live webview of TWO webdriver builds on a real screen
 * (`scripts/gate-device/req84-gate.sh` → this spec with VELLIS_GATE_VARIANT =
 * `release` (built with `-f webdriver`, the hidden side = 配布版相当) and `dev`
 * (`-f webdriver,dev-features`, the shown side = 開発版)).
 *
 * Each judgement is one JSON line in `$VELLIS_GATE_SHOTS/req84-report.jsonl`
 * (`pass` true / false, `side` release / dev; a line without `pass` is a fact or
 * a screenshot left to the eye; `human: true` marks what stays with a person).
 *
 * 要件74 第2段 2-5(2026-11-17・撤去)の後: the current editing (Edit ▸ Edit, the `<pre contenteditable>`
 * editor, Done Editing) is gone and the new editing face (CodeMirror for text, ProseMirror for
 * Markdown) is the view on BOTH builds (契約21・(ae)). Only `ai_marks` still tells the builds apart.
 * The editing gates below (1 / 2 / 8) therefore judge the same on both sides; the AI gates keep
 * their release / dev split. Not run on a device since the rewrite (the first run confirms the
 * face helpers of gate-helpers.ts).
 *
 * release (配布版相当):
 *  - gate 1  File / Edit by AX (menudetail): Save is in File (Command + S), no Edit ▸ Edit, the
 *            order of the rest as 契約4, no two separators side by side; a real Command + E on
 *            plain.txt changes nothing (no menu item takes it: the face stays as it was, no
 *            save_document, no dialog; the beep is 【人】); a real Command + S on a dirty face saves
 *            (the file changes; restored afterwards)
 *  - gate 2  plain text / a Markdown paragraph / a code fence / the HTML iframe:
 *            a real double-click (HID, else pid) enters no other editor (the editable surfaces
 *            are the same before and after = the face itself; no Done / Source button); the
 *            toolbar is exactly [Copy Markdown]; the double-click only selects a word
 *  - gate 3  after every open (txt, md, html, png) clean/ holds no `.vellis/` and no
 *            `.<name>.vellis-tmp`; `rebind_marks_for_file` is never called; the
 *            driver checks the folder again after the app quit
 *  - gate 4  `vellis -r <marked>` (the CLI's IPC hand-off) switches the root to a
 *            folder with a `.vellis/` left by an earlier version: not listed in the
 *            tree, no dialog, no notice, the files' sha256 + mtime unchanged (the
 *            driver compares again after the quit); the commands behind
 *            (`list_marks` / `generate_inbox` / `list_snapshots`) refuse with
 *            "… is not available in this version of Vellis" and create nothing
 *  - gate 5  while the app runs: `--marks` / `--changed` / `--fix claude` / `--inbox x`
 *            → exit 2, the one stderr line, no window, no IPC log line, no
 *            show_marks event, no process left (the driver ran the same with no
 *            app, plus --help / -h, before the launch); the dev build's CLI against
 *            this app → "server error [NOT_AVAILABLE]" (事後確認 6)
 *  - gate 6  (driver) `--print-build-info`: flags.ai_marks false (editor_inline is gone = 要件74 AC-74-46)
 *  - gate 7  Settings… (AX, the app menu) and View ▸ Appearance ▸ Export Default
 *            Theme… (AX, submenu.swift): a Vellis window opens on both builds
 *            (要件74 AC-74-43・(ah); closed by the driver), settings.json / my-theme.json
 *            exist. Then settings.json is written OUTSIDE Vellis (atomic rename, as an
 *            editor saves): a theme written to themes/gate84.json takes effect
 *            (`theme_changed`, `--color-bg-base`) but the watcher announces nothing (no
 *            `settings_changed`, no dialog, even for broken JSON = 契約8 (g) with the
 *            editor always present; hideme/ stays until the next listing)
 *
 * dev (開発版, gate 8 = the `ai_marks` side and the recorded differences):
 *  - gate 1/8 the same menus and keys as release (Save; no Edit ▸ Edit); the toolbar
 *            has Add Instruction + Marks
 *  - gate 2/8 a real double-click enters no other editor (same as release); the toolbar
 *            has Add Instruction + Marks
 *  - gate 3  clean/.vellis/ appears on the first document (the difference)
 *  - gate 8  an unsaved edit (the face) + another document → ONE Unsaved Changes dialog
 *            (Command + D drops it); Marks opens the list (`list_marks`), Generate
 *            Inbox writes clean/.vellis/agent-inbox.md, `list_snapshots` answers
 *  - gate 5/8 `--marks` / `--changed` reach the running app (show_marks, the list)
 *  - gate 4  the marked/ root: what the rebind does to the files is recorded
 *  - gate 7  the same as release (a Vellis window; the external save announces nothing)
 *
 * The operator (`req84-gate.sh`) takes the steps the page cannot: the native
 * menus, real keys / double-clicks, the CLI in the app's environment, dialogs,
 * windows, screenshots. This spec writes `<SHOTS_DIR>/req84-op-<side>/req-<n>.json`
 * and waits for `ack-<n>.json`. Without the driver (VELLIS_GATE_REQ84_OPERATOR
 * unset) those steps are reported as skipped.
 *
 * Runs only under `scripts/gate-device/req84-gate.sh` (VELLIS_GATE_DEVICE=1).
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const VARIANT = process.env.VELLIS_GATE_VARIANT ?? 'release';
const OPERATOR = process.env.VELLIS_GATE_REQ84_OPERATOR === '1';
const cleanRoot = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const fixturesRoot = process.env.VELLIS_GATE_REQ84_ROOT ?? '';
const configDir = process.env.VELLIS_GATE_REQ84_CONFIG ?? '';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const realinput = process.env.VELLIS_GATE_REALINPUT ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';
const devBin = process.env.VELLIS_GATE_BIN_DEV ?? '';
const REPORT = 'req84-report.jsonl';
const OP_DIR = path.join(SHOTS_DIR, `req84-op-${VARIANT}`);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');

const markedRoot = path.join(fixturesRoot, 'marked');
const uriOf = (abs: string) => `file://${abs.split(path.sep).join('/')}`;
const cleanFile = (rel: string) => path.join(cleanRoot, rel);
const cleanUri = (rel: string) => uriOf(cleanFile(rel));

/** macOS virtual keycodes (US ANSI). */
const KEY = { s: 1, e: 14, return: 36, escape: 53 } as const;

// The viewer's DOM (src/components/Viewer.svelte・HtmlViewer.svelte・Explorer.svelte・MarkList.svelte).
const VIEWER = 'article.viewer';
const BODY = 'article.viewer .markdown-body';
const PLAIN = `${BODY} pre.vellis-plaintext`;
const PARAGRAPH = `${BODY} p`;
const FENCE = `${BODY} pre:not(.vellis-plaintext)`;
const HTML_IFRAME = 'iframe.html-viewer';
const TOOLBAR_BUTTON = 'article.viewer .viewer-toolbar .toolbar-button';
const EDIT_DONE = '[data-testid="edit-done"]';
const EDIT_SOURCE = '[data-testid="edit-source"]';
const MARK_LIST = 'aside.mark-list';
const EXPLORER_HEADER = '.explorer-header';
const THEME_STYLE = '#vellis-theme';
const PLAIN_ORIGINAL = 'first line\nsecond line\n';
const PLAIN_EDITED = 'first line edited\nsecond line\n';
const UNAVAILABLE = 'is not available in this version of Vellis';
const ABOUT = 'A file viewer for Markdown, HTML, images, 3D models, video, audio and PDF';

/** The menus as 契約4 lays them out ('—' = a separator). */
// 要件74 2-5: Save is always in File, Edit ▸ Edit is gone — the same on both builds (契約21).
const FILE_ALL = ['New Window', 'New Tab', 'Duplicate Window', '—', 'Open…', 'Open Folder…', '—', 'Save', '—', 'Print…'];
const EDIT_ALL = ['Undo', 'Redo', '—', 'Cut', 'Copy', 'Paste', 'Select All', '—', 'Find…', 'Find in Folder…'];

const DEFAULT_SETTINGS = {
	'appearance.theme': 'default',
	'files.exclude': { '**/.*': true, '**/.git': true, '**/.DS_Store': true, '**/.vellis': true },
};
const GATE84_SETTINGS = {
	'appearance.theme': 'gate84',
	'files.exclude': { '**/.*': true, '**/.git': true, '**/.DS_Store': true, '**/.vellis': true, '**/hideme': true },
};
const GATE84_LIGHT_BG = '#102030';
const GATE84_DARK_BG = '#203040';

// --- the tools (pid-pinned child processes, as req83) --------------------------------

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

// --- the operator (scripts/gate-device/req84-gate.sh) --------------------------------

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
				report(REPORT, { gate: 'operator', side: VARIANT, step, args, answer });
				return answer;
			}
		}
		await browser.pause(300);
	}
	throw new Error(`operator step ${step} (#${seq}) was not answered within ${timeoutMs} ms`);
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

const KEEP_BODIES = ['save_document', 'list_marks', 'generate_inbox', 'list_snapshots', 'rebind_marks_for_file', 'list_dir', 'set_root'];

async function installHooks(): Promise<void> {
	await browser.execute((keep) => {
		const w = window as unknown as { __gate84?: Hooks & { originals: { fetch: typeof window.fetch } } };
		if (w.__gate84) return;
		const g = { ipc: [] as IpcRec[], mouse: [] as MouseRec[], keys: [] as KeyRec[], keep, originals: { fetch: window.fetch } };
		w.__gate84 = g;
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
			const u = args && typeof args === 'object' && typeof (args as { uri?: unknown }).uri === 'string' ? (args as { uri: string }).uri : null;
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
		for (const type of ['mousedown', 'dblclick']) {
			window.addEventListener(type, (e) => {
				const m = e as MouseEvent;
				g.mouse.push({ type: m.type, clientX: m.clientX, clientY: m.clientY, button: m.button, target: describe(m.target) });
			}, true);
		}
		window.addEventListener('keydown', (e) => g.keys.push({ key: e.key, code: e.code, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey, target: describe(e.target), at: Date.now() }), true);
	}, KEEP_BODIES);
}

async function hooks(): Promise<Hooks> {
	return browser.execute(() => {
		const g = (window as unknown as { __gate84?: Hooks }).__gate84;
		if (!g) throw new Error('hooks are not installed');
		return JSON.parse(JSON.stringify({ ipc: g.ipc, mouse: g.mouse, keys: g.keys, keep: g.keep })) as Hooks;
	});
}

async function restoreHooks(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __gate84?: { originals: { fetch: typeof window.fetch } } };
		if (w.__gate84) window.fetch = w.__gate84.originals.fetch;
	});
}

async function ipcMark(): Promise<number> {
	return (await hooks()).ipc.length;
}
async function ipcAfter(mark: number, cmds?: string[]): Promise<IpcRec[]> {
	const all = (await hooks()).ipc.slice(mark);
	return cmds ? all.filter((e) => cmds.includes(e.cmd)) : all;
}
async function waitIpc(mark: number, cmds: string[], min = 1, timeout = 20_000): Promise<IpcRec[]> {
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
async function eventsMark(): Promise<number> {
	return (await readEventRecord()).length;
}
async function eventsAfter(mark: number, name?: string) {
	const all = (await readEventRecord()).slice(mark);
	return name ? all.filter((e) => e.event === name) : all;
}
async function waitEvent(mark: number, name: string, timeout = 10_000): Promise<boolean> {
	try {
		await browser.waitUntil(async () => (await eventsAfter(mark, name)).length > 0, { timeout, timeoutMsg: `no ${name} event after mark ${mark}` });
	} catch {
		return false;
	}
	await browser.pause(300);
	return true;
}

// --- page helpers ------------------------------------------------------------------

interface Invoked {
	done: boolean;
	ok: boolean;
	value: unknown;
	error: string | null;
}
let invokeSeq = 0;
/**
 * A Tauri command asked from the page, its rejection kept as data. Not through
 * `executeAsync`: WebKit's driver reports a command's rejection ("Marks is not
 * available in this version of Vellis") as the failure of the whole execute/async
 * (run6 of 2026-11-08), so the invoke is started by one `execute`, its outcome
 * parked on `window`, and read back by another once it settled; an
 * `unhandledrejection` raised meanwhile is swallowed.
 */
async function invokeSafely(cmd: string, args: Record<string, unknown>): Promise<Invoked> {
	const key = `inv${++invokeSeq}`;
	// A WebDriver error raised while the command is asked carries the command's own error
	// text (run7: "Marks is not available …" on every `execute` for a second after the
	// rejection, even a plain read; run9: "invalid args `anchor` … missing field
	// `startLine`"). It IS the answer: kept as data (`ok: false`, `error`), never thrown —
	// the judgement that follows decides what that text means.
	const asAnswer = (e: unknown): Invoked | null => {
		const msg = String((e as { message?: string })?.message ?? e);
		return msg.trim() === '' ? null : { done: true, ok: false, value: null, error: msg };
	};
	try {
		await browser.execute(
			(c, a, k) => {
				const w = window as unknown as {
					__gate84inv?: Record<string, Invoked>;
					__TAURI_INTERNALS__: {
						invoke: (cmd: string, args?: unknown) => Promise<unknown>;
						transformCallback?: (cb: (payload: unknown) => void, once?: boolean) => number;
						postMessage?: (message: unknown) => void;
					};
				};
				w.__gate84inv = w.__gate84inv ?? {};
				w.__gate84inv[k] = { done: false, ok: false, value: null, error: null };
				const swallow = (e: Event) => {
					e.preventDefault();
					e.stopImmediatePropagation();
				};
				window.addEventListener('unhandledrejection', swallow, true);
				window.addEventListener('error', swallow, true);
				const settle = (ok: boolean, v: unknown) => {
					w.__gate84inv![k] = { done: true, ok, value: ok ? v : null, error: ok ? null : String(v) };
					setTimeout(() => {
						window.removeEventListener('unhandledrejection', swallow, true);
						window.removeEventListener('error', swallow, true);
					}, 1_500);
				};
				const internals = w.__TAURI_INTERNALS__;
				if (typeof internals.postMessage === 'function' && typeof internals.transformCallback === 'function') {
					// The way Tauri's own `invoke` posts a command, with callbacks that store
					// instead of resolve / reject: no Promise exists to be rejected at all.
					const callback = internals.transformCallback((v) => settle(true, v), true);
					const error = internals.transformCallback((e) => settle(false, e), true);
					try {
						internals.postMessage({ cmd: c, callback, error, payload: a, options: {} });
					} catch (e) {
						settle(false, e);
					}
				} else {
					let p: Promise<unknown>;
					try {
						p = internals.invoke(c, a);
					} catch (e) {
						p = Promise.reject(e);
					}
					p.then((v) => settle(true, v), (e: unknown) => settle(false, e));
				}
			},
			cmd,
			args,
			key,
		);
	} catch (e) {
		const a = asAnswer(e);
		if (a) return a;
		throw e;
	}
	let surfaced: Invoked | null = null;
	await browser.waitUntil(
		async () => {
			try {
				return await browser.execute((k) => (window as unknown as { __gate84inv?: Record<string, Invoked> }).__gate84inv?.[k]?.done === true, key);
			} catch (e) {
				surfaced = asAnswer(e);
				if (surfaced) return true;
				throw e;
			}
		},
		{ timeout: 15_000, timeoutMsg: `invoke ${cmd} did not settle` },
	);
	try {
		const parked = await browser.execute((k) => JSON.parse(JSON.stringify((window as unknown as { __gate84inv: Record<string, Invoked> }).__gate84inv[k] ?? null)) as Invoked | null, key);
		if (parked && parked.done) return parked;
	} catch (e) {
		const a = asAnswer(e);
		if (a) return a;
		throw e;
	}
	return surfaced ?? { done: true, ok: false, value: null, error: 'the parked result was not readable' };
}

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
async function waitViewerText(needle: string, timeout = 20_000): Promise<void> {
	await browser.waitUntil(async () => (await textOf(VIEWER)).includes(needle), {
		timeout,
		timeoutMsg: `viewer never showed "${needle}" (now: ${JSON.stringify((await textOf(VIEWER)).slice(0, 200))})`,
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
/** Every `[contenteditable="true"]` in the document and in every open shadow root. */
async function editableAnywhere(): Promise<string[]> {
	return browser.execute(() => {
		const out: string[] = [];
		const walk = (root: Document | ShadowRoot) => {
			root.querySelectorAll('[contenteditable="true"]').forEach((el) => out.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`));
			root.querySelectorAll('*').forEach((el) => {
				const sr = (el as HTMLElement).shadowRoot;
				if (sr) walk(sr);
			});
		};
		walk(document);
		return out;
	});
}
async function toolbarButtons(): Promise<string[]> {
	return browser.execute((sel) => Array.from(document.querySelectorAll<HTMLElement>(sel)).map((b) => b.textContent?.trim() ?? ''), TOOLBAR_BUTTON);
}
async function editSurface(): Promise<{ editable: string[]; done: boolean; source: boolean }> {
	return { editable: await editableAnywhere(), done: await exists(EDIT_DONE), source: await exists(EDIT_SOURCE) };
}
async function selectionText(): Promise<string> {
	return browser.execute(() => window.getSelection()?.toString() ?? '');
}
async function clearSelection(): Promise<void> {
	await browser.execute(() => window.getSelection()?.removeAllRanges());
}
async function clickToolbarButton(label: string): Promise<boolean> {
	return browser.execute(
		(sel, l) => {
			const b = Array.from(document.querySelectorAll<HTMLElement>(sel)).find((x) => x.textContent?.trim() === l);
			if (!b) return false;
			b.click();
			return true;
		},
		TOOLBAR_BUTTON,
		label,
	);
}
async function clickTextButton(scope: string, label: string): Promise<boolean> {
	return browser.execute(
		(s, l) => {
			const b = Array.from(document.querySelectorAll<HTMLElement>(`${s} button`)).find((x) => x.textContent?.trim() === l);
			if (!b) return false;
			b.click();
			return true;
		},
		scope,
		label,
	);
}
async function alertTexts(): Promise<string[]> {
	return browser.execute(() => Array.from(document.querySelectorAll('[role="alert"]')).map((el) => el.textContent?.trim() ?? '').filter(Boolean));
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
/** The computed `--color-bg-base` on <html> (what the theme's `light` / `dark` sets). */
async function bgBase(): Promise<string> {
	return browser.execute(() => getComputedStyle(document.documentElement).getPropertyValue('--color-bg-base').trim());
}
async function themeStyleHas(needle: string): Promise<boolean> {
	return browser.execute((sel, n) => (document.querySelector(sel)?.textContent ?? '').includes(n), THEME_STYLE, needle);
}

/** Open a document of the current root by its Explorer row and wait for `waitSel` (and `marker` in the viewer). */
async function openDoc(uri: string, waitSel: string | null, marker?: string): Promise<void> {
	await closeOverlays();
	await clickExplorerRow(uri);
	if (waitSel) await waitFor(waitSel, `open ${uri}`);
	if (marker) await waitViewerText(marker);
	await browser.pause(400);
}
/** Open the image (an `open_binary_document` that settles; the viewer shows an <img>). */
async function openImage(uri: string): Promise<{ ipc: IpcRec[]; img: boolean }> {
	await closeOverlays();
	const mark = await ipcMark();
	await clickExplorerRow(uri);
	const ipc = await waitIpc(mark, ['open_binary_document'], 1, 20_000).catch(() => [] as IpcRec[]);
	let img = false;
	try {
		await browser.waitUntil(async () => browser.execute(() => Array.from(document.images).some((i) => i.src.includes('pic.png') || i.closest('.image-viewer') !== null)), { timeout: 10_000 });
		img = true;
	} catch {
		img = false;
	}
	return { ipc, img };
}

// --- files outside the app --------------------------------------------------------

function sha256(file: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function writeAtomic(abs: string, content: string): void {
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	const tmp = `${abs}.req84-tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, abs);
}
interface FileFacts {
	sha256: string;
	mtime: number;
}
/** sha256 + mtime (seconds) of every file under `dir`, keyed by the relative path. */
function manifest(dir: string): Record<string, FileFacts> {
	const out: Record<string, FileFacts> = {};
	if (!fs.existsSync(dir)) return out;
	const walk = (d: string) => {
		for (const name of fs.readdirSync(d).sort()) {
			const abs = path.join(d, name);
			const st = fs.statSync(abs);
			if (st.isDirectory()) walk(abs);
			else out[path.relative(dir, abs)] = { sha256: sha256(abs), mtime: Math.floor(st.mtimeMs / 1000) };
		}
	};
	walk(dir);
	return out;
}
function sameManifest(a: Record<string, FileFacts>, b: Record<string, FileFacts>): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
/** `.vellis` / `*.vellis-tmp` anywhere under clean/. */
function cleanLeftovers(): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of fs.readdirSync(d)) {
			const abs = path.join(d, name);
			if (name === '.vellis' || name.endsWith('.vellis-tmp')) out.push(path.relative(cleanRoot, abs));
			if (fs.statSync(abs).isDirectory() && name !== '.vellis') walk(abs);
		}
	};
	walk(cleanRoot);
	return out;
}
const settingsPath = () => path.join(configDir, 'settings.json');
const themesDir = () => path.join(configDir, 'themes');
function gate84ThemeJson(): string {
	const theme = JSON.parse(fs.readFileSync(path.join(repoRoot, 'themes', 'default.json'), 'utf8')) as Record<string, unknown>;
	theme.meta = { name: 'Gate 84', author: 'req84-gate.e2e.ts', description: 'A theme written outside Vellis for gate 7' };
	(theme.light as Record<string, string>)['color-bg-base'] = GATE84_LIGHT_BG;
	(theme.dark as Record<string, string>)['color-bg-base'] = GATE84_DARK_BG;
	return `${JSON.stringify(theme, null, 2)}\n`;
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
function refreshFrame(pid: number): void {
	if (!screen) return;
	const wins = ax(['cgwins', String(pid)]).filter((w) => w.onscreen === true);
	const w = wins.sort((a, b) => (b.w as number) * (b.h as number) - (a.w as number) * (a.h as number))[0];
	if (w) screen.frame = { x: w.x as number, y: w.y as number, w: w.w as number, h: w.h as number, number: w.number as number };
}
/**
 * Find the window and measure the WKWebView's offset in it with one real left
 * click on the Explorer header (a click there does nothing), as req80 does.
 */
/**
 * Never throws: when no point can be clicked (another window — run5: Notification
 * Center — over every candidate, the front not taken, no mousedown), the frame and
 * the guessed offsets stay, an `environment` row is written and the real input of
 * this run is stopped (`realInputBlocked`); the DOM gates still run. The click goes
 * through the operator so the driver knows the time of the gate's own input.
 */
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
	// Points where a single click does nothing: along the Explorer header (centre, left,
	// right), then the empty right end of the viewer toolbar. The first whose topmost
	// on-screen window is the app's own is used.
	const header = await rectOf(EXPLORER_HEADER);
	const toolbar = await rectOf('article.viewer .viewer-toolbar');
	const candidates: Array<{ name: string; x: number; y: number }> = [];
	if (header) {
		const cy = Math.round(header.y + header.height / 2);
		candidates.push({ name: 'explorer header centre', x: Math.round(header.x + header.width / 2), y: cy });
		candidates.push({ name: 'explorer header left', x: Math.round(header.x + 24), y: cy });
		candidates.push({ name: 'explorer header right', x: Math.round(header.x + header.width * 0.8), y: cy });
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
		block('no calibration point lies under the app’s own window (something covers the Explorer header and the toolbar — run5: Notification Center); no real input in this run', { tried });
		return;
	}
	let md: MouseRec | undefined;
	const attempts: Array<{ route: string; answer: Record<string, unknown> | null }> = [];
	for (const route of ['hid', 'pid'] as const) {
		const before = (await hooks()).mouse.length;
		const answer = await operator('click', { x: chosen.s.x, y: chosen.s.y, route }, 240_000);
		await browser.pause(400);
		attempts.push({ route, answer });
		if (answer?.idle_short === true) {
			block(`the user was at the keyboard (idle ${String(answer.idle_s)} s) when the calibration click was due; no real input in this run`, { answer });
			return;
		}
		md = (await hooks()).mouse.slice(before).find((m) => m.type === 'mousedown');
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

let realInputBlocked: string | null = null;
/** Set by `calibrate` when no real input can go out in this run at all; `beforeEach` starts every `it` from it. */
let calibrationBlocked: string | null = null;
function requireRealInput(): void {
	if (realInputBlocked) throw new Error(`environment: ${realInputBlocked}`);
}
/**
 * The environment, not the product, stopped a gate (the front could not be
 * taken, the user was at the keyboard, a menu could not be found): one
 * `environment` row (no pass), the real input of this `it` is stopped, and the
 * `it` ends on an `environment:` error.
 */
function environment(gate: number | string, item: string, extra: Record<string, unknown> = {}): never {
	const frontApp = (extra.answer as { front_app?: unknown } | undefined)?.front_app ?? extra.front_app ?? null;
	const reason = `${item}${frontApp ? ` (front app: ${JSON.stringify(frontApp)})` : ''}`;
	realInputBlocked = reason;
	report(REPORT, { gate: 'environment', side: VARIANT, item, reason, ...extra });
	throw new Error(`environment: ${reason}`);
}

/** A real key through the operator (sent only in front, only when the user is idle). */
async function realKey(keycode: number, mods: string[] = []): Promise<Record<string, unknown> | null> {
	requireRealInput();
	const a = await operator('key', { keycode, mods }, 240_000);
	if (a && a.idle_short === true) environment('key', `the user was at the keyboard (idle ${String(a.idle_s)} s) when keycode ${keycode} [${mods.join('+')}] was due; the key was not sent`, { answer: a });
	if (a && a.sent !== true) environment('key', `the driver could not bring the window to the front for keycode ${keycode} [${mods.join('+')}]; the key was not sent`, { answer: a });
	await browser.pause(600);
	return a;
}

interface DoubleClick {
	sent: boolean;
	route: string | null;
	recorded: boolean;
	target: string | null;
	answers: Array<Record<string, unknown> | null>;
}
/**
 * A real double-click at a viewport point through the operator: the HID route
 * first (the only one WebKit takes for a real double-click), then the pid route.
 * `expectRecord` = the page must see a `dblclick` (not for the sandboxed iframe).
 */
async function realDoubleClick(clientX: number, clientY: number, expectRecord: boolean): Promise<DoubleClick> {
	requireRealInput();
	refreshFrame(screen!.pid);
	const s = toScreen(clientX, clientY);
	const answers: Array<Record<string, unknown> | null> = [];
	for (const route of ['hid', 'pid']) {
		const before = await mouseMark();
		const a = await operator('dblclick', { x: s.x, y: s.y, route }, 240_000);
		answers.push(a);
		if (a && a.idle_short === true) environment('dblclick', `the user was at the keyboard (idle ${String(a.idle_s)} s) when the double-click at (${s.x}, ${s.y}) was due; not sent`, { answer: a });
		if (a && a.front === false) environment('dblclick', `the driver could not bring the window to the front for the double-click at (${s.x}, ${s.y}); not sent`, { answer: a });
		await browser.pause(500);
		const rec = (await mouseAfter(before)).find((m) => m.type === 'dblclick');
		if (a?.sent === true && (rec || !expectRecord)) return { sent: true, route, recorded: !!rec, target: rec?.target ?? null, answers };
	}
	return { sent: answers.some((a) => a?.sent === true), route: null, recorded: false, target: null, answers };
}
/**
 * The point to double-click: the centre of `selector`'s first element, only when
 * it is inside the viewport and `elementFromPoint` lands in it (tasks/lessons.md
 * 2026-11-06). Null = the environment, not the product.
 */
/**
 * The point to double-click for a word: the centre of the first line box of `word`'s
 * first occurrence in a text node under `selector`, checked with `caretRangeFromPoint`
 * to fall strictly inside that word (run8: the centre of the <pre> hit a line end and
 * the double-click selected "\n"). `inside` false = the environment, not the product.
 */
async function wordPoint(selector: string, word: string): Promise<{ x: number; y: number; under: string; inside: boolean; word: string; caret: string } | null> {
	return browser.execute(
		(s, wd) => {
			const root = document.querySelector<HTMLElement>(s);
			if (!root) return null;
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let node: Text | null = null;
			let at = -1;
			while (walker.nextNode()) {
				const t = walker.currentNode as Text;
				const i = t.data.indexOf(wd);
				if (i >= 0) {
					node = t;
					at = i;
					break;
				}
			}
			if (!node) return { x: 0, y: 0, under: `no text node under ${s} holds "${wd}"`, inside: false, word: wd, caret: '' };
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + wd.length);
			const box = range.getClientRects()[0] ?? range.getBoundingClientRect();
			const x = Math.round(box.x + box.width / 2);
			const y = Math.round(box.y + box.height / 2);
			if (x <= 0 || y <= 0 || x >= window.innerWidth || y >= window.innerHeight) return { x, y, under: 'outside the viewport', inside: false, word: wd, caret: '' };
			const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
			const caret = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(x, y) : null;
			const under = document.elementFromPoint(x, y);
			const desc = under ? `${under.tagName.toLowerCase()}.${(under as HTMLElement).className}` : 'nothing';
			if (!caret) return { x, y, under: desc, inside: false, word: wd, caret: 'caretRangeFromPoint gave nothing' };
			const inWord = caret.startContainer === node && caret.startOffset > at && caret.startOffset < at + wd.length;
			const caretText = caret.startContainer.nodeType === Node.TEXT_NODE ? `offset ${caret.startOffset} of "${(caret.startContainer as Text).data.slice(0, 60)}"` : caret.startContainer.nodeName;
			return { x, y, under: desc, inside: inWord && !!under && root.contains(under), word: wd, caret: caretText };
		},
		selector,
		word,
	);
}
async function pointIn(selector: string): Promise<{ x: number; y: number; under: string; inside: boolean } | null> {
	return browser.execute((s) => {
		const el = document.querySelector<HTMLElement>(s);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const x = Math.round(r.x + Math.min(r.width / 2, 160));
		const y = Math.round(r.y + Math.min(r.height / 2, 12));
		if (x <= 0 || y <= 0 || x >= window.innerWidth || y >= window.innerHeight) return { x, y, under: 'outside the viewport', inside: false };
		const under = document.elementFromPoint(x, y);
		const desc = under ? `${under.tagName.toLowerCase()}.${(under as HTMLElement).className}` : 'nothing';
		return { x, y, under: desc, inside: !!under && (under === el || el.contains(under)) };
	}, selector);
}

// --- judgement ------------------------------------------------------------------------

let fails: string[] = [];
/**
 * The one page alert the dev-features run is expected to raise: MarkList.svelte's
 * `alert(\`Exported agent-inbox.md:\n${path}\n\n${n} marks (Open → Sent)\`)` after Generate
 * Inbox (the same before requirement 84 = 2ac8e20). Set when gate 8 pressed the button; the
 * dialogs judgement then counts exactly that one as expected and the rest as zero.
 */
let inboxAlertExpected = false;
const isInboxExportAlert = (d: string) => d.startsWith('alert:Exported agent-inbox.md:') && d.trimEnd().endsWith('1 marks (Open → Sent)');
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

/** A menu as the driver reads it → titles with '—' for a separator. */
function shape(items: unknown): string[] {
	return ((items as Array<{ title: string; separator: boolean }>) ?? []).map((i) => (i.separator ? '—' : i.title));
}
/**
 * The items macOS appends to an app's Edit menu (AutoFill, Start Dictation…, Emoji &
 * Symbols, …), never the app's own (run6 of 2026-11-08 read them at the tail of Edit).
 * Only a tail made of these names, and the separator right before it, is taken off;
 * the same is applied to every menu, so a surprise elsewhere shows in `system`.
 */
const SYSTEM_TAIL_ITEMS = new Set(['AutoFill', 'Start Dictation…', 'Start Dictation', 'Emoji & Symbols', 'Writing Tools', 'Substitutions', 'Transformations', 'Speech', 'Spelling and Grammar', 'Show Spelling and Grammar', 'Services']);
function stripSystemTail(all: string[]): { app: string[]; system: string[] } {
	const app = [...all];
	const system: string[] = [];
	while (app.length > 0 && SYSTEM_TAIL_ITEMS.has(app[app.length - 1]!)) system.unshift(app.pop()!);
	if (system.length > 0 && app.length > 0 && app[app.length - 1] === '—') system.unshift(app.pop()!);
	return { app, system };
}
function adjacentSeparators(s: string[]): boolean {
	return s.some((t, i) => t === '—' && s[i + 1] === '—');
}
function cmdCharOf(items: unknown, title: string): string | null {
	const it = ((items as Array<{ title: string; cmd_char?: string }>) ?? []).find((i) => i.title === title);
	return it ? (it.cmd_char ?? null) : null;
}

interface CliAnswer {
	exit: number;
	stdout: string;
	stderr: string;
	procs_left: number;
	app_windows: { before: number; after: number };
	ipc_log_lines: { before: number; after: number };
	timed_out: boolean;
	/** The driver could not run the CLI at all (no cwd / binary / perl, the alarm): the environment, not the product. */
	harness_error: string | null;
}
async function cli(argv: string[], which?: 'release' | 'dev', cwd?: string): Promise<CliAnswer | null> {
	const a = (await operator('cli', { argv, ...(which ? { which } : {}), ...(cwd ? { cwd } : {}) }, 120_000)) as unknown as CliAnswer | null;
	if (a && a.harness_error) environment('cli', `the driver could not run \`vellis ${argv.join(' ')}\` (${a.harness_error}); the product was not judged`, { answer: a });
	return a;
}

// --- the gates, parametrised by the side ------------------------------------------

const RELEASE = VARIANT === 'release';
const G = { menus: RELEASE ? 1 : 8, body: RELEASE ? 2 : 8, cli: RELEASE ? 5 : 8 };

async function gateMenus(): Promise<void> {
	const file = await operator('menu-detail', { menu: 'File' });
	const edit = await operator('menu-detail', { menu: 'Edit' });
	if (!file || !edit) {
		skipped(G.menus, 'File / Edit by AX', 'no operator');
		return;
	}
	const fileAll = stripSystemTail(shape(file.items));
	const editAll = stripSystemTail(shape(edit.items));
	const fileShape = fileAll.app;
	const editShape = editAll.app;
	fact(G.menus, 'items macOS appends to the menus (not the app’s; taken off before the comparison): File / Edit', { file_system_tail: fileAll.system, edit_system_tail: editAll.system, file_as_read: shape(file.items), edit_as_read: shape(edit.items) });
	const expectFile = FILE_ALL;
	const expectEdit = EDIT_ALL;
	judge(G.menus, `File by AX (the app's items) is exactly [${expectFile.join(', ')}] (Save between the second separator and Print… on both builds = 要件74 2-5)`, JSON.stringify(fileShape) === JSON.stringify(expectFile), { items: fileShape, system_tail: fileAll.system, raw: file.items });
	judge(G.menus, `Edit by AX (the app's items, macOS's tail taken off) is exactly [${expectEdit.join(', ')}] (no Edit ▸ Edit on either build = 要件74 (ad); Undo〜Select All and Find… / Find in Folder… stay)`, JSON.stringify(editShape) === JSON.stringify(expectEdit), { items: editShape, system_tail: editAll.system, raw: edit.items });
	judge(G.menus, 'no two separators side by side in File or Edit (the app’s items)', !adjacentSeparators(fileShape) && !adjacentSeparators(editShape), { file: fileShape, edit: editShape });
	judge(G.menus, 'Save shows Command + S (cmd_char S); "Edit" is not an item of Edit', cmdCharOf(file.items, 'Save') === 'S' && !editShape.includes('Edit'), { save: cmdCharOf(file.items, 'Save'), edit: editShape });
	const others: Record<string, string[]> = {};
	const otherTails: Record<string, string[]> = {};
	for (const m of ['View', 'Go', 'Window']) {
		const a = await operator('menu-detail', { menu: m });
		const st = stripSystemTail(shape(a?.items));
		others[m] = st.app;
		otherTails[m] = st.system;
	}
	fact(G.menus, 'the other menus (View / Go / Window) as AX reads them — "Edit" appears in none of them; View holds Raw Source (要件74 2-3); any macOS tail is listed apart', { menus: others, system_tails: otherTails, has_edit: Object.values(others).some((s) => s.includes('Edit')) });
	const s = await operator('shot', { name: `req84-${VARIANT}-window-after-menus`, margin: 0 });
	human(9, `the window with a document open (${VARIANT}): the toolbar and the look are for the eye (the File / Edit menus themselves cannot be captured open by AX; 【人】 the gap the removed items leave)`, { file: s?.file ?? null });
}

/** Gate 1b (release) / gate 8 (dev): real Command + E (no item any more) and Command + S (saves a dirty face) on plain.txt. 要件74 2-5: the same on both builds. */
async function gateRealKeys(): Promise<void> {
	if (!OPERATOR) {
		skipped(G.menus, 'real Command + E / Command + S', 'no operator (a judgement without the key sent would be a false green)');
		return;
	}
	await openDoc(cleanUri('plain.txt'), FACE_CONTENT, 'first line');
	const shaBefore = sha256(cleanFile('plain.txt'));
	const textBefore = await faceText();
	const keys0 = await keysMark();
	const ipc0 = await ipcMark();
	const a = await realKey(KEY.e, ['cmd']);
	await browser.pause(1_000);
	const afterE = await editSurface();
	const keysE = await keysAfter(keys0);
	judge(G.menus, 'a real Command + E: no menu item takes it — the face is as it was (same text, not dirty), no Done / Source button, no other editable surface', (await faceText()) === textBefore && !(await faceDirty()) && !afterE.done && !afterE.source && afterE.editable.length === 1 && afterE.editable[0]!.includes('cm-content'), { surface: afterE, key: a, keydown_seen_by_page: keysE, text_same: (await faceText()) === textBefore });
	const d0 = await operator('dialog', { wait_s: 2, expect: '', answer: 'escape' });
	judge(G.menus, 'a real Command + E: no dialog (sheet / dialog window / UserNotificationCenter) within 2 s', !d0 || d0.dialogs === 0, { dialogs: d0 });
	human(G.menus, 'whether macOS beeps on Command + E (no menu item takes the key any more) = 【人】', {});
	// Command + S on the clean face: nothing to save (契約14: not dirty → no save_document).
	const ipcS0 = await ipcMark();
	const b0 = await realKey(KEY.s, ['cmd']);
	await browser.pause(1_500);
	const saves0 = await ipcAfter(ipcS0, ['save_document']);
	judge(G.menus, 'a real Command + S on the clean face: no save_document, plain.txt byte for byte the same, no dialog', saves0.length === 0 && sha256(cleanFile('plain.txt')) === shaBefore, { key: b0, saves: saves0, all_ipc_since_command_e: (await ipcAfter(ipc0)).map((e) => e.cmd) });
	// Make the face dirty and save with a real Command + S (both builds: the editing is a normal feature).
	judge(G.menus, 'the face takes an edit (replaceFaceText → unsaved badge)', (await replaceFaceText(PLAIN_EDITED)) && (await faceDirty()), { text: await faceText() });
	const ipcS = await ipcMark();
	const b = await realKey(KEY.s, ['cmd']);
	await browser.pause(1_500);
	const saves = await ipcAfter(ipcS, ['save_document']);
	const content = fs.readFileSync(cleanFile('plain.txt'), 'utf8');
	const okSaves = saves.filter((s) => s.ok === true);
	judge(G.menus, 'a real Command + S on the dirty face saves — save_document ok exactly once (with expectedHash), the file holds the edited text, the badge goes', okSaves.length === 1 && content === PLAIN_EDITED && !(await faceDirty()), {
		key: b,
		saves: saves.map((s) => ({ ok: s.ok, args: s.args && typeof s.args === 'object' ? { keys: Object.keys(s.args as object), uri: (s.args as { uri?: unknown }).uri ?? null } : s.args })),
		content: JSON.stringify(content),
		expected: JSON.stringify(PLAIN_EDITED),
	});
	// Put the original back from outside (the face follows a clean external change silently = 契約12).
	writeAtomic(cleanFile('plain.txt'), PLAIN_ORIGINAL);
	await browser.waitUntil(async () => ((await faceText()) ?? '').startsWith('first line\nsecond line'), { timeout: 15_000 }).catch(() => undefined);
	fact(G.menus, 'plain.txt restored from outside after the save (the face follows the disk)', { content: fs.readFileSync(cleanFile('plain.txt'), 'utf8'), face: await faceText() });
}

interface BodyTarget {
	rel: string;
	wait: string;
	marker?: string;
	target: string;
	name: string;
	expectRecord: boolean;
	/** The word the double-click lands in (its first occurrence in the target's text); none = the element's centre (the iframe). */
	word?: string;
	/**
	 * Whether the Viewer's toolbar is on screen for this document in view mode. An HTML
	 * document in view is shown by HtmlViewer (+page.svelte: the `{#if … renderedSrcdoc
	 * !== null && editMode === 'view'}` branch), the Viewer and its toolbar only in the
	 * `{:else}` — the same before requirement 84 (2ac8e20), so no toolbar is expected there.
	 */
	toolbar: boolean;
}
const BODY_TARGETS: BodyTarget[] = [
	// 要件74 2-5: plain text is the CodeMirror face (no pre.vellis-plaintext on screen); the fence inside notes.md is an embedded CodeMirror (2-4).
	{ rel: 'plain.txt', wait: FACE_CONTENT, marker: 'first line', target: `${FACE_CONTENT} .cm-line`, name: 'plain text (the CodeMirror face)', expectRecord: true, word: 'second', toolbar: true },
	{ rel: 'notes.md', wait: PARAGRAPH, marker: 'Paragraph one', target: PARAGRAPH, name: 'a Markdown paragraph', expectRecord: true, word: 'enough', toolbar: true },
	{ rel: 'notes.md', wait: FENCE, marker: 'Paragraph one', target: `${FENCE} .cm-line`, name: 'a code fence (an embedded CodeMirror)', expectRecord: true, word: 'return', toolbar: true },
	{ rel: 'page.html', wait: HTML_IFRAME, target: HTML_IFRAME, name: 'HTML (the sandboxed iframe)', expectRecord: false, toolbar: false },
];

/** Gate 2 (release) / gate 8 (dev): a real double-click on every surface. 要件74 2-5: the face is the editor — a double-click enters nothing else; `menu_edit` is gone. */
async function gateBody(): Promise<void> {
	if (!OPERATOR) {
		skipped(G.body, 'real double-clicks on the surfaces', 'no operator (a judgement without the click sent would be a false green)');
		return;
	}
	for (const t of BODY_TARGETS) {
		await openDoc(cleanUri(t.rel), t.wait, t.marker);
		const buttons = await toolbarButtons();
		if (!t.toolbar) {
			// HtmlViewer shows the document (読むだけ until 要件79); the Viewer's toolbar is not on screen.
			judge(G.body, `${t.name}: no Viewer toolbar in view (HtmlViewer; HTML is read-only until requirement 79) and so no Add Instruction / Marks button anywhere`, !buttons.includes('Add Instruction') && !buttons.includes('Marks') && !(await exists(EDIT_SOURCE)) && !(await exists(EDIT_DONE)), { buttons });
		} else if (RELEASE) judge(2, `${t.name}: the toolbar is exactly [Copy Markdown]`, JSON.stringify(buttons) === JSON.stringify(['Copy Markdown']), { buttons });
		else judge(8, `${t.name}: the toolbar has Copy Markdown, Add Instruction and Marks (dev-features = ai_marks)`, buttons.includes('Copy Markdown') && buttons.includes('Add Instruction') && buttons.includes('Marks'), { buttons });
		const before = await editSurface();
		const dirtyBefore = await faceDirty();
		const p = t.word ? await wordPoint(t.target, t.word) : await pointIn(t.target);
		if (!p || !p.inside) {
			report(REPORT, { gate: 'environment', side: VARIANT, item: `${t.name}: no point to double-click (${JSON.stringify(p)}); the double-click was not judged`, reason: 'target not under the pointer' });
			skipped(G.body, `${t.name}: real double-click`, 'no point inside the viewport under which the target lies');
			continue;
		}
		await clearSelection();
		const dc = await realDoubleClick(p.x, p.y, t.expectRecord);
		await browser.pause(800);
		const surface = await editSurface();
		const sel = await selectionText();
		if (!dc.sent) {
			report(REPORT, { gate: 'environment', side: VARIANT, item: `${t.name}: the double-click could not be sent on either route`, reason: 'dblclick not sent', answers: dc.answers });
		} else {
			judge(G.body, `${t.name}: a real double-click (${dc.route}${dc.recorded ? ', seen by the page' : ', into the iframe'}) enters no other editor — the editable surfaces are what they were (the face), no Done / Source button, nothing dirty`, JSON.stringify(surface.editable) === JSON.stringify(before.editable) && !surface.done && !surface.source && (await faceDirty()) === dirtyBefore, { point: p, dblclick: dc, surface_before: before, surface });
			if (t.expectRecord && dc.recorded) judge(G.body, `${t.name}: the double-click only selects the word "${t.word ?? ''}"`, sel.trim() === (t.word ?? '') && !sel.includes('\n'), { selection: sel, point: p });
		}
		await clearSelection();
		judge(G.body, `${t.name}: no Edit ▸ Edit event exists any more (menu_edit) — no Done / Source button on screen`, !(await exists(EDIT_DONE)) && !(await exists(EDIT_SOURCE)), {});
	}
}
async function leaveEditor(): Promise<void> {
	// 要件74 2-5: nothing to leave; make sure the face is not dirty (the next document would ask otherwise).
	if (await faceDirty()) await revertFace(fs.readFileSync(cleanFile('plain.txt'), 'utf8')).catch(() => undefined);
}

/** Gate 3: clean/ stays clean (release) / gets .vellis on the first document (dev). */
async function gateClean(): Promise<void> {
	const ipc0 = await ipcMark();
	const opened: Record<string, unknown>[] = [];
	for (const [rel, wait, marker] of [
		['plain.txt', PLAIN, 'first line'],
		['notes.md', PARAGRAPH, 'Paragraph one'],
		['page.html', HTML_IFRAME, undefined],
	] as Array<[string, string, string | undefined]>) {
		await openDoc(cleanUri(rel), wait, marker);
		await browser.pause(1_200);
		const left = cleanLeftovers();
		opened.push({ rel, leftovers: left });
		if (RELEASE) judge(3, `after opening ${rel}: no .vellis/ and no .<name>.vellis-tmp under clean/`, left.length === 0, { leftovers: left });
		else if (rel === 'plain.txt') judge(3, 'dev-features: clean/.vellis/ exists after the first document (the rebind creates it = the recorded difference)', left.includes('.vellis'), { leftovers: left });
	}
	const img = await openImage(cleanUri('pic.png'));
	await browser.pause(1_200);
	const left = cleanLeftovers();
	fact(3, 'pic.png opened (open_binary_document settled / an <img> is shown)', { ipc: img.ipc.map((e) => ({ cmd: e.cmd, ok: e.ok })), img: img.img });
	if (RELEASE) judge(3, 'after opening pic.png: no .vellis/ and no .vellis-tmp under clean/', left.length === 0, { leftovers: left });
	const rebinds = await ipcAfter(ipc0, ['rebind_marks_for_file']);
	if (RELEASE) judge(3, 'rebind_marks_for_file is never called while documents open (契約5: the page does not call it)', rebinds.length === 0, { rebinds: rebinds.length, all: (await ipcAfter(ipc0)).map((e) => e.cmd) });
	else judge(3, 'dev-features: rebind_marks_for_file is called on open (today’s behaviour)', rebinds.length > 0, { rebinds: rebinds.map((r) => ({ ok: r.ok, uri: r.uri })) });
	fact(3, 'what clean/ holds now', { entries: fs.readdirSync(cleanRoot), opened });
}

/** Gate 5 (release) / gate 8 (dev): the CLI against the running app. */
async function gateCliDuring(): Promise<void> {
	if (!OPERATOR) {
		skipped(G.cli, 'the CLI while the app runs', 'no operator');
		return;
	}
	if (RELEASE) {
		for (const argv of [['--marks'], ['--changed'], ['--fix', 'claude'], ['--inbox', 'x']]) {
			const ev0 = await eventsMark();
			const r = await cli(argv);
			await browser.pause(800);
			const shown = await eventsAfter(ev0, 'show_marks');
			const name = argv[0]!;
			judge(5, `${argv.join(' ')} while the app runs: exit 2, stderr 'vellis: ${name} ${UNAVAILABLE}', empty stdout, no process left, the app's windows and IPC log unchanged, no show_marks, no Marks list`,
				!!r && r.exit === 2 && r.stderr.trim() === `vellis: ${name} ${UNAVAILABLE}` && r.stdout === '' && r.procs_left === 0 && r.app_windows.before === r.app_windows.after && r.ipc_log_lines.before === r.ipc_log_lines.after && shown.length === 0 && !(await exists(MARK_LIST)),
				{ cli: r, show_marks_events: shown });
		}
		if (devBin) {
			// 事後確認 6: another build's CLI asks this app for the marks → NOT_AVAILABLE, exit 3.
			const ev0 = await eventsMark();
			const r = await cli(['--marks'], 'dev');
			await browser.pause(800);
			const shown = await eventsAfter(ev0, 'show_marks');
			judge(5, 'the dev-features build’s `--marks` against this (release-like) app: "server error [NOT_AVAILABLE]", exit 3, no show_marks, no window (事後確認 6)',
				!!r && r.exit === 3 && r.stderr.includes('NOT_AVAILABLE') && shown.length === 0 && r.app_windows.before === r.app_windows.after && !(await exists(MARK_LIST)),
				{ cli: r, show_marks_events: shown });
		} else skipped(5, 'the dev build’s CLI against the release-like app', 'VELLIS_GATE_BIN_DEV is not set');
	} else {
		await openDoc(cleanUri('notes.md'), PARAGRAPH, 'Paragraph one');
		for (const [argv, drift] of [
			[['--marks'], false],
			[['--changed'], true],
		] as Array<[string[], boolean]>) {
			const ev0 = await eventsMark();
			const r = await cli(argv);
			const got = await waitEvent(ev0, 'show_marks', 10_000);
			const events = await eventsAfter(ev0, 'show_marks');
			const payload = events[0]?.payload as { filter_drift?: boolean } | null | undefined;
			await browser.pause(500);
			judge(8, `dev-features: ${argv.join(' ')} while the app runs → exit 0 (the IPC hand-off), a show_marks event (filter_drift ${drift}), the Marks list opens`,
				!!r && r.exit === 0 && got && payload?.filter_drift === drift && r.ipc_log_lines.after > r.ipc_log_lines.before && (await exists(MARK_LIST)),
				{ cli: r, events });
			if (await exists(MARK_LIST)) await clickToolbarButton('Marks');
			await waitGone(MARK_LIST, 'the Marks list (toggled off)', 5_000).catch(() => undefined);
		}
	}
}

/** Gate 4: the root with an existing .vellis/, reached by `vellis -r <marked>`. */
async function gateMarked(vellisBefore: Record<string, FileFacts>): Promise<void> {
	if (!OPERATOR) {
		skipped(4, 'vellis -r <marked>', 'no operator');
		return;
	}
	const ipc0 = await ipcMark();
	const ev0 = await eventsMark();
	const r = await cli(['-r', markedRoot]);
	fact(4, `vellis -r ${markedRoot} (the IPC hand-off to the running app)`, { cli: r });
	let listed = true;
	try {
		await waitForExplorerRow(uriOf(path.join(markedRoot, 'doc.md')), { timeout: 30_000, nudgeDir: markedRoot, nudgePrefix: 'req84-root' });
	} catch (e) {
		listed = false;
		fact(4, `the root did not switch to marked/ (${String(e)})`, { cli: r, rows: await explorerNames() });
	}
	judge(4, 'the root switches to marked/ through the CLI (doc.md listed)', listed && !!r && r.exit === 0, { exit: r?.exit ?? null });
	if (!listed) return;
	const names = await explorerNames();
	judge(4, 'the tree does not list .vellis (files.exclude default **/.vellis)', !names.includes('.vellis'), { names });
	await openDoc(uriOf(path.join(markedRoot, 'doc.md')), PARAGRAPH, 'Hello world');
	await browser.pause(2_000);
	const now = manifest(path.join(markedRoot, '.vellis'));
	const same = sameManifest(vellisBefore, now);
	const d = await operator('dialog', { wait_s: 2, expect: '', answer: 'escape' });
	const pageDialogs = (await readGateRecord()).dialogs;
	const alerts = await alertTexts();
	const calls = await ipcAfter(ipc0, ['list_marks', 'rebind_marks_for_file', 'generate_inbox', 'list_snapshots']);
	if (RELEASE) {
		judge(4, 'marked/.vellis (marks.jsonl, agent-inbox.md, snapshots/) is byte for byte and mtime for mtime what it was after doc.md opened', same, { before: vellisBefore, after: now });
		judge(4, 'no dialog, no page alert, no notice while the marked root is open', (!d || d.dialogs === 0) && pageDialogs.length === 0 && alerts.length === 0, { dialogs: d, page_dialogs: pageDialogs, alerts });
		judge(4, 'none of list_marks / rebind_marks_for_file / generate_inbox / list_snapshots is called by the page', calls.length === 0, { calls: calls.map((c) => c.cmd), show_marks_events: await eventsAfter(ev0, 'show_marks') });
		// The commands behind, asked directly: refused at the door (契約5 features::require), nothing created.
		const rootUri = uriOf(markedRoot);
		const refused: Record<string, unknown> = {};
		for (const [cmd, args] of [
			['list_marks', { rootUri }],
			['generate_inbox', { rootUri }],
			['list_snapshots', { rootUri }],
		] as Array<[string, Record<string, unknown>]>) {
			const res = await invokeSafely(cmd, args);
			refused[cmd] = res;
		}
		const allRefused = Object.values(refused).every((res) => {
			const r2 = res as Invoked;
			return r2.ok === false && String(r2.error ?? '').includes(UNAVAILABLE);
		});
		judge(4, `list_marks / generate_inbox / list_snapshots asked directly answer an error "… ${UNAVAILABLE}"`, allRefused, { refused });
		judge(4, 'marked/.vellis unchanged after those refused calls (store_for refuses before AnnotationStore::new)', sameManifest(vellisBefore, manifest(path.join(markedRoot, '.vellis'))), {});
	} else {
		fact(4, 'dev-features: marked/.vellis after doc.md opened, compared with before (the rebind may rewrite marks.jsonl)', { same, before: vellisBefore, after: now, calls: calls.map((c) => ({ cmd: c.cmd, ok: c.ok })) });
		fact(4, 'dev-features: dialogs / alerts while the marked root is open', { dialogs: d, page_dialogs: pageDialogs, alerts });
	}
}

/** Gate 8 (dev only): the unsaved confirmation and the AI entrances. */
async function gateDevEditAndAi(): Promise<void> {
	// The unsaved confirmation: an edit, then another document.
	await openDoc(cleanUri('plain.txt'), FACE_CONTENT, 'first line');
	const shaBefore = sha256(cleanFile('plain.txt'));
	// 要件74 2-5: the face is the editor — replace its text so it is dirty (the unsaved badge).
	await replaceFaceText(PLAIN_EDITED);
	await browser.waitUntil(async () => await faceDirty(), { timeout: 5_000, timeoutMsg: 'the replaced text did not make the face dirty' });
	await browser.pause(300);
	await clickExplorerRow(cleanUri('notes.md'));
	const d = await operator('dialog', { wait_s: 10, expect: 'Unsaved', answer: 'cmd-d' });
	await browser.pause(800);
	const shown = (await textOf(VIEWER)).includes('Paragraph one');
	judge(8, 'dev-features: an unsaved edit + another document → ONE Unsaved Changes dialog; Command + D drops the edit (the file unchanged) and opens the other document', !!d && d.dialogs === 1 && sha256(cleanFile('plain.txt')) === shaBefore && shown, { dialogs: d, viewer_shows_notes: shown });
	await leaveEditor();
	// The AI entrances.
	await openDoc(cleanUri('notes.md'), PARAGRAPH, 'Paragraph one');
	const buttons = await toolbarButtons();
	judge(8, 'dev-features: Add Instruction and Marks are on the toolbar', buttons.includes('Add Instruction') && buttons.includes('Marks'), { buttons });
	const ipc0 = await ipcMark();
	await clickToolbarButton('Marks');
	await waitFor(MARK_LIST, 'the Marks list', 8_000).catch(() => undefined);
	const lists = await waitIpc(ipc0, ['list_marks'], 1, 8_000).catch(() => [] as IpcRec[]);
	judge(8, 'dev-features: Marks opens the list and list_marks answers ok', (await exists(MARK_LIST)) && lists.some((l) => l.ok === true), { list_marks: lists.map((l) => ({ ok: l.ok, body: l.body })) });
	// Generate Inbox is disabled while there are no marks (MarkList.svelte `disabled={marksStore.all.length === 0}`,
	// the same before requirement 84 = 2ac8e20): one mark is added first through the command (add_mark, one of
	// the nine behind the AI integration), then the list is closed and opened again so it refreshes
	// (MarkList's `marksStore.refresh(rootUri)` on open). run6 pressed the disabled button and saw no IPC.
	const notes = fs.readFileSync(cleanFile('notes.md'), 'utf8');
	const anchorText = 'Paragraph one has enough words';
	const added = await invokeSafely('add_mark', {
		rootUri: uriOf(cleanRoot),
		uri: cleanUri('notes.md'),
		// camelCase, as `commands::annotation::AnchorInput` (#[serde(rename_all = "camelCase")]) and
		// `src/lib/annotation.ts` AnchorInput spell it (run9: snake_case → `missing field startLine`).
		anchor: {
			startLine: 3,
			endLine: 3,
			startOffset: 0,
			endOffset: anchorText.length,
			selectedText: anchorText,
			selectedMarkdown: anchorText,
			headingPath: ['Notes'],
			contextBefore: '',
			contextAfter: notes.slice(notes.indexOf(anchorText) + anchorText.length, notes.indexOf(anchorText) + anchorText.length + 40),
			fileHash: crypto.createHash('sha256').update(notes).digest('hex'),
		},
		instruction: 'A mark added by req84-gate.e2e.ts so Generate Inbox is enabled (dev-features)',
	});
	judge(8, 'dev-features: add_mark (asked directly) adds a mark on notes.md', added.ok === true, { add_mark: added });
	await clickToolbarButton('Marks');
	await waitGone(MARK_LIST, 'the Marks list (closed to refresh)', 5_000).catch(() => undefined);
	const ipcRe = await ipcMark();
	await clickToolbarButton('Marks');
	await waitFor(MARK_LIST, 'the Marks list (opened again)', 8_000).catch(() => undefined);
	const relists = await waitIpc(ipcRe, ['list_marks'], 1, 8_000).catch(() => [] as IpcRec[]);
	const genDisabled = await browser.execute((s) => {
		const b = Array.from(document.querySelectorAll<HTMLButtonElement>(`${s} button`)).find((x) => x.textContent?.trim() === 'Generate Inbox');
		return b ? b.disabled : null;
	}, MARK_LIST);
	fact(8, 'dev-features: the Marks list after the mark was added (list_marks count, Generate Inbox disabled?)', { marks: relists.map((l) => (Array.isArray(l.body) ? l.body.length : null)), generate_inbox_disabled: genDisabled });
	const ipc1 = await ipcMark();
	const pressed = genDisabled === false ? await clickTextButton(MARK_LIST, 'Generate Inbox') : false;
	const gen = pressed ? await waitIpc(ipc1, ['generate_inbox'], 1, 10_000).catch(() => [] as IpcRec[]) : [];
	await browser.pause(500);
	const inbox = path.join(cleanRoot, '.vellis', 'agent-inbox.md');
	if (pressed) inboxAlertExpected = true;
	const inboxAlerts = (await readGateRecord()).dialogs.filter(isInboxExportAlert);
	fact(8, 'dev-features: the completion alert MarkList shows after Generate Inbox ("Exported agent-inbox.md: … 1 marks (Open → Sent)"; stubbed by the gate recorder, so nothing reached the screen) — today\u2019s entrance as before requirement 84', { alerts: inboxAlerts });
	judge(8, 'dev-features: Generate Inbox (enabled once a mark exists) → generate_inbox ok, clean/.vellis/agent-inbox.md exists, and the "Exported agent-inbox.md … 1 marks (Open → Sent)" alert is raised once', pressed && gen.some((g) => g.ok === true) && fs.existsSync(inbox) && inboxAlerts.length === 1, { pressed, generate_inbox_disabled: genDisabled, generate_inbox: gen.map((g) => ({ ok: g.ok, body: g.body })), inbox_exists: fs.existsSync(inbox), inbox_alerts: inboxAlerts });
	const snaps = await invokeSafely('list_snapshots', { rootUri: uriOf(cleanRoot) });
	judge(8, 'dev-features: list_snapshots answers (an array; the diff view’s source)', snaps.ok === true && Array.isArray(snaps.value), { snapshots: snaps });
	if (await exists(MARK_LIST)) await clickToolbarButton('Marks');
	await waitGone(MARK_LIST, 'the Marks list (toggled off)', 5_000).catch(() => undefined);
	await operator('dialog', { wait_s: 1, expect: '', answer: 'escape' });
}

/** Gate 7: Settings… / Export Default Theme… and a settings.json saved outside Vellis. */
async function gateSettings(): Promise<void> {
	if (!OPERATOR) {
		skipped(7, 'Settings… / Export Default Theme…', 'no operator');
		return;
	}
	const sp = settingsPath();
	const existedBefore = fs.existsSync(sp);
	const win0 = await operator('windows');
	const mainTitle = ((win0?.windows as Array<{ title: string }>) ?? []).find((w) => (w as { main?: boolean }).main)?.title ?? null;
	const ev0 = await eventsMark();
	const s = await operator('open-external', { kind: 'app-item', item: 'Settings…', path: sp }, 120_000);
	const press = (s?.press ?? null) as { pressed?: boolean; menu?: string; tried?: unknown } | null;
	if (!press?.pressed) {
		report(REPORT, { gate: 'environment', side: VARIANT, item: 'Settings… could not be pressed by AX (the app menu was not found under "Vellis", the executable name, or clidialog menupress)', reason: 'app menu not found', answer: s });
		skipped(7, 'Settings… and what follows', 'the item could not be pressed');
		return;
	}
	await browser.pause(1_000);
	const settingsEvents = await eventsAfter(ev0, 'settings_changed');
	const before = s?.vellis_windows_before as number;
	const after = s?.vellis_windows_after as number;
	judge(7, 'Settings… (dev-features): a Vellis window opens with settings.json (要件74 2-5: both builds)', after === before + 1, { windows_before: before, windows_after: after, windows: s?.windows_after });
	await closeExtraWindows(mainTitle);
	// Export Default Theme… (View ▸ Appearance ▸ …, a submenu item).
	const my = path.join(themesDir(), 'my-theme.json');
	const ex = await operator('open-external', { kind: 'submenu', menu: 'View', submenu: 'Appearance', item: 'Export Default Theme…', path: sp }, 120_000);
	let written = false;
	try {
		await browser.waitUntil(() => Promise.resolve(fs.existsSync(my)), { timeout: 8_000 });
		written = true;
	} catch {
		written = false;
	}
	const exPress = (ex?.press ?? null) as { pressed?: boolean } | null;
	judge(7, 'Export Default Theme… (dev-features): my-theme.json written and a Vellis window opens (要件74 2-5: both builds)', !!exPress?.pressed && written && ex?.vellis_windows_after === (ex?.vellis_windows_before as number) + 1, { press: ex?.press, written, windows_before: ex?.vellis_windows_before, windows_after: ex?.vellis_windows_after });
	await closeExtraWindows(mainTitle);
	const mf = await operator('make-front');
	fact(7, 'Vellis brought back to the front after the external app opened (not needed for the DOM checks below; recorded for the real-key gates that ran before)', { answer: mf });

	// --- settings.json saved OUTSIDE Vellis (an editor's atomic save) ------------------
	writeAtomic(path.join(themesDir(), 'gate84.json'), gate84ThemeJson());
	await browser.pause(1_500);
	const bg0 = await bgBase();
	const names0 = await explorerNames();
	const ev1 = await eventsMark();
	const ipc1 = await ipcMark();
	writeAtomic(sp, `${JSON.stringify(GATE84_SETTINGS, null, 2)}\n`);
	const themed = await waitEvent(ev1, 'theme_changed', 10_000);
	await browser.pause(1_500);
	const bg1 = await bgBase();
	const themeApplied = themed && (bg1 === GATE84_LIGHT_BG || bg1 === GATE84_DARK_BG) && (await themeStyleHas(GATE84_LIGHT_BG));
	judge(7, `a settings.json saved outside Vellis (appearance.theme = gate84): theme_changed arrives and --color-bg-base becomes the new theme's`, themeApplied, { theme_changed: themed, bg_before: bg0, bg_after: bg1, expected: [GATE84_LIGHT_BG, GATE84_DARK_BG] });
	await browser.pause(4_000);
	const n = (await eventsAfter(ev1, 'settings_changed')).length;
	const d = await operator('dialog', { wait_s: 2, expect: '', answer: 'escape' });
	judge(7, 'the external save announces nothing (no settings_changed from the watcher, no dialog = 契約8 (g) with the editor always present = 要件74 (ah)); hideme/ stays until the next listing', n === 0 && (!d || d.dialogs === 0), { settings_changed: n, dialogs: d, names: await explorerNames() });
	const ev2 = await eventsMark();
	writeAtomic(sp, '{ "appearance.theme": "gate84",\n');
	const d1 = await operator('dialog', { wait_s: 6, expect: '', answer: 'return' });
	await browser.pause(500);
	judge(7, 'broken JSON saved outside Vellis: no dialog, no settings_changed (要件74 2-5: both builds)', (!d1 || d1.dialogs === 0) && (await eventsAfter(ev2, 'settings_changed')).length === 0, { dialogs: d1 });
	writeAtomic(sp, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
	await browser.pause(2_000);
	await operator('dialog', { wait_s: 1, expect: '', answer: 'escape' });
	human(7, 'contract 8 (g) also fires when View ▸ Appearance picks a theme (the file is rewritten by Vellis itself → one tree reload, no warning) = 事後確認 9; not driven here', {});
}
/** Close every standard window except the main one (by title), through the driver. */
async function closeExtraWindows(mainTitle: string | null): Promise<void> {
	for (let i = 0; i < 4; i++) {
		const w = await operator('windows');
		const wins = ((w?.windows as Array<{ title: string; index: number; x: number; y: number }>) ?? []).filter((x) => x.title !== mainTitle);
		if (wins.length === 0) return;
		const target = wins[0]!;
		const c = await operator('close', { win: { title: target.title, x: target.x, y: target.y } });
		fact(7, `closed the extra window "${target.title}" (dev-features)`, { answer: c });
		await browser.pause(800);
	}
}

// =======================================================================================
describe(`Requirement #84 human gates, the machine part — ${VARIANT === 'release' ? 'the release-like build (gates 1〜7; hidden side)' : 'the dev-features build (gate 8 and the recorded differences; shown side)'}`, function () {
	this.timeout(900_000);
	let pid = 0;
	let vellisBefore: Record<string, FileFacts> = {};

	before(async function () {
		if (!DEVICE) this.skip();
		for (const [name, value] of Object.entries({ VELLIS_GATE_BIN: bin, VELLIS_GATE_AXTOOL: axtool, VELLIS_GATE_REALINPUT: realinput, VELLIS_E2E_INITIAL_ROOT: cleanRoot, VELLIS_GATE_REQ84_ROOT: fixturesRoot, VELLIS_GATE_REQ84_CONFIG: configDir })) {
			if (!value) throw new Error(`${name} is not set`);
		}
		for (const f of ['plain.txt', 'notes.md', 'page.html', 'pic.png', 'hideme/inside.md', 'keep/k.md']) {
			if (!fs.existsSync(cleanFile(f))) throw new Error(`fixture ${f} is missing in ${cleanRoot} (req84-fixtures.sh)`);
		}
		for (const f of ['doc.md', '.vellis/marks.jsonl', '.vellis/agent-inbox.md']) {
			if (!fs.existsSync(path.join(markedRoot, f))) throw new Error(`fixture marked/${f} is missing (req84-fixtures.sh)`);
		}
		if (cleanLeftovers().length !== 0) throw new Error(`clean/ already holds ${JSON.stringify(cleanLeftovers())} before the app opened anything`);
		vellisBefore = manifest(path.join(markedRoot, '.vellis'));
		fs.mkdirSync(SHOTS_DIR, { recursive: true });
		fs.rmSync(OP_DIR, { recursive: true, force: true });
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await installHooks();
		await installEventRecorder(['show_marks', 'settings_changed', 'theme_changed']);
		await assertEventRecorderWorks();
		pid = appPid();
		await waitForExplorerRow(cleanUri('plain.txt'), { timeout: 30_000, nudgeDir: cleanRoot, nudgePrefix: 'req84-root' });
		report(REPORT, { gate: 'setup', side: VARIANT, operator: OPERATOR, pid, bin, cleanRoot, markedRoot, configDir, vellis_before: vellisBefore, idle: (await operator('idle')) ?? null });
		await calibrate(pid);
	});

	async function resetScreen(when: string): Promise<void> {
		const closed = await closeOverlays();
		if (closed.length > 0) report(REPORT, { gate: 'reset', side: VARIANT, when, closed });
	}
	beforeEach(async function () {
		if (!DEVICE) return;
		fails = [];
		realInputBlocked = calibrationBlocked;
		await resetScreen(`before: ${this.currentTest?.title ?? '?'}`);
	});
	afterEach(async function () {
		if (!DEVICE) return;
		if (this.currentTest?.state === 'failed') {
			report(REPORT, { gate: 'failed', side: VARIANT, test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
		}
		await resetScreen(`after: ${this.currentTest?.title ?? '?'}`).catch(() => undefined);
	});
	after(async function () {
		if (!DEVICE) return;
		try {
			if (fs.existsSync(cleanFile('plain.txt'))) writeAtomic(cleanFile('plain.txt'), PLAIN_ORIGINAL);
			report(REPORT, { gate: 'teardown', side: VARIANT, clean_leftovers: cleanLeftovers(), vellis_after: manifest(path.join(markedRoot, '.vellis')), page_dialogs: (await readGateRecord()).dialogs });
			await removeEventRecorder();
			await restoreHooks();
			await restoreGateRecorder();
		} finally {
			await operator('done', {}, 60_000).catch(() => null);
		}
	});

	it(`gate ${G.menus}: File / Edit by AX — Save (Command + S) is there, no Edit ▸ Edit, no doubled separator, the rest in order (要件74 2-5: the same on both builds)`, async () => {
		await gateMenus();
	});

	it(`gate ${G.menus}: real Command + E and Command + S on plain.txt — Command + E does nothing (no item), Command + S saves only a dirty face (restored afterwards)`, async () => {
		await gateRealKeys();
	});

	it(`gate ${G.body}: plain text / a Markdown paragraph / a code fence / the HTML iframe — a real double-click enters no other editor (the face is the view); the toolbar is ${RELEASE ? 'only Copy Markdown' : 'Copy Markdown + Add Instruction + Marks (ai_marks)'}`, async () => {
		await gateBody();
	});

	it(`gate 3: clean/ after md / txt / html / png were opened — ${RELEASE ? 'no .vellis/, no .vellis-tmp, rebind_marks_for_file never called' : '.vellis/ appears on the first document (the recorded difference)'}`, async () => {
		await gateClean();
	});

	if (!RELEASE) {
		it('gate 8: the unsaved confirmation (one dialog, Command + D drops the edit) and the AI entrances (Marks → list_marks, Generate Inbox → agent-inbox.md, list_snapshots)', async () => {
			await gateDevEditAndAi();
		});
	}

	it(`gate ${G.cli}: the CLI while the app runs — ${RELEASE ? '--marks / --changed / --fix claude / --inbox x refused (exit 2, one line, nothing opens, the app untouched); the dev build’s --marks gets NOT_AVAILABLE' : '--marks / --changed reach the app (show_marks, the list opens)'}`, async () => {
		await gateCliDuring();
	});

	it(`gate 4: vellis -r <marked> — a root with a .vellis/ of an earlier version: ${RELEASE ? 'not listed, no dialog or notice, the files untouched; the commands behind refuse' : 'what the rebind does is recorded'}`, async () => {
		await gateMarked(vellisBefore);
	});

	it('gate 7: Settings… and Export Default Theme… open Vellis windows on both builds (要件74 (ah); closed by the driver); an external save changes the theme but announces nothing', async () => {
		await gateSettings();
	});

	it('dialogs and alerts the page stubbed during the run: none from the product (what the driver answered is in the operator log)', async () => {
		const rec = await readGateRecord();
		// dev-features: the one alert gate 8 itself provoked (Generate Inbox's completion note,
		// MarkList.svelte, the same before requirement 84) is expected and counted apart.
		const expected = inboxAlertExpected ? rec.dialogs.filter(isInboxExportAlert) : [];
		const others = rec.dialogs.filter((d) => !expected.includes(d));
		if (inboxAlertExpected) {
			fact('dialogs', 'the expected alert of this run: Generate Inbox\u2019s "Exported agent-inbox.md … 1 marks (Open → Sent)" (dev-features; counted apart, exactly one expected)', { expected });
			judge('dialogs', 'the Generate Inbox alert was raised exactly once (dev-features)', expected.length === 1, { expected });
		}
		judge('dialogs', `no other window.alert / confirm / prompt reached the page (${VARIANT})`, others.length === 0, { dialogs: others, expected_counted_apart: expected.length });
	});
});
