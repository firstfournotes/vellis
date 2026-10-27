import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertIpcInterceptionWorks,
	clearCapturedIpc,
	clickExplorerRow,
	emitMenu,
	explorerHasRow,
	explorerNames,
	explorerRowUriByName,
	installGateRecorder,
	invokeFromPage,
	readCapturedIpc,
	readGateRecord,
	report,
	restoreGateRecorder,
	setIpcBlock,
	setIpcCapture,
	shot,
	waitForAppMounted,
	waitForExplorerRow,
	type CapturedIpc,
} from '../gate-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

/**
 * The "is it the same on an ssh root?" human gates, driven on the webdriver
 * build against the disposable sshd of `scripts/e2e-sshd.sh`
 * (`scripts/e2e.sh --ssh`). The first window's root is the sshd's remote
 * folder as `ssh://vellis-e2e/<dir>/root`; the folder itself is on this
 * machine, so the spec writes its fixture straight into it
 * (`VELLIS_E2E_SSH_ROOT`) and every read the app makes goes through sftp.
 *
 * Gates covered (one `it` each, see docs/requirements/req-NN.md「人間ゲート」):
 *  - #17 ⑥  the window title is the root folder's name, no user@host
 *  - #18 ⑦  tree operations on an ssh root (expand / collapse / open / re-list;
 *            no live refresh inside subfolders is the documented limit)
 *  - #16 ⑤  images (PNG, SVG with a <script>) over ssh
 *  - #22 ④  overwrite / delete of the shown image is followed (2 s poll)
 *  - #30 ⑦  Japanese (and space) file names over ssh
 *  - #28 ⑤ / #39 g7 / #40 g10  video over ssh = placeholder only, no button,
 *            no controls, no Sources button
 *  - #29 ⑦  PDF over ssh = placeholder only
 *  - #48 ⑥  Edit does nothing on an ssh document (read-only)
 *  - #19 ⑦  context menu: Finder / default app / Open With greyed, Copy Path
 *            puts the ssh URI (the clipboard is stubbed, never written)
 *  - #66 g3  Aa / ab / .* in Find in Folder on the ssh root
 *  - #65 g3  files.exclude / search.exclude take effect on the ssh root
 *  - #34 ④  Duplicate Window from an ssh root
 *  - #38 g4  Print of an ssh HTML: the print document (captured, then the
 *            print window really opens; nothing is sent to a printer)
 *
 * Outside ssh mode (`VELLIS_E2E_SSH_MODE` unset) every test is skipped, so the
 * ordinary full run is not affected.
 */

const SSH_MODE = process.env.VELLIS_E2E_SSH_MODE === '1';
/** Local path of the folder the sshd serves as the root. */
const remoteRoot = process.env.VELLIS_E2E_SSH_ROOT ?? '';
const alias = process.env.VELLIS_E2E_SSH_ALIAS ?? 'vellis-e2e';
const configHome = process.env.XDG_CONFIG_HOME ?? '';
const settingsFile = path.join(configHome, 'vellis', 'settings.json');
const REPORT = 'ssh-report.jsonl';
const gateDir = path.join(remoteRoot, 'ssh-gate');
const SEARCH = 'search_in_folder';
const PAGE = 'search_in_folder_page';
const PRINT_CSP_META =
	'<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'">';

/** The root URI as the backend registered it (adopted from `__test_list_windows` at setup). */
let rootUri = process.env.VELLIS_E2E_SSH_URI ?? '';
const uri = (p: string) => `${rootUri}/${path.relative(remoteRoot, p).split(path.sep).join('/')}`;
const rel = (p: string) => path.relative(remoteRoot, p).split(path.sep).join('/');

const JA_DIR = '日本語フォルダ';
const JA_MD = '2025年度帳票送付のご案内.md';
const JA_SPACE_MD = 'スペース 入り.md';
const JA_PNG = '画像データ.png';

// --- fixture ---------------------------------------------------------------

const searchSamples: Record<string, string> = {
	'case.txt': 'foo\nFoo\nx FOO Foo\n',
	'word.txt': 'concat\ncat\nCat\n(cat)\ncat-x\na cat.\ncat_\ncats\ncafés\ncafé au lait\nv2\nv 2\n',
	'dates.txt': 'released 2026-10-08\nno date here\n2025-01-02 and 2025-03-04\nv1.2.3\n',
	'combo.txt': 'Foo. bar\nfoo. bar\nFood bar\nxFoo. bar\nFOOx\n',
	'regex-jump.txt': 'food fooo\nx foo\nfooo\n',
	'fold.txt': 'foo1\nFOO2\n',
};

const DEFAULT_SETTINGS: Record<string, Record<string, boolean>> = {
	'files.exclude': { '**/.*': true, '**/.git': true, '**/.DS_Store': true, '**/.vellis': true },
	'search.exclude': {
		'**/node_modules': true,
		'**/target': true,
		'**/dist': true,
		'**/build': true,
		'**/.git': true,
		'**/.svelte-kit': true,
	},
};

/** A PNG of the given size, made from the repo logo with `sips`, written atomically. */
function writePng(file: string, w: number, h: number): void {
	const tmp = `${file}.tmp-${process.pid}.png`;
	execFileSync('sips', ['-z', String(h), String(w), path.join(repoRoot, 'fixtures', 'images', 'logo.png'), '--out', tmp], {
		stdio: 'ignore',
	});
	fs.renameSync(tmp, file);
}

function buildFixture(): void {
	fs.rmSync(gateDir, { recursive: true, force: true });
	fs.mkdirSync(path.join(gateDir, 'search'), { recursive: true });
	fs.mkdirSync(path.join(gateDir, 'excl', '.hidden'), { recursive: true });
	fs.mkdirSync(path.join(gateDir, 'excl', 'node_modules', 'pkg'), { recursive: true });
	fs.mkdirSync(path.join(gateDir, JA_DIR), { recursive: true });
	fs.mkdirSync(path.join(remoteRoot, 'docs', 'drafts'), { recursive: true });

	fs.writeFileSync(
		path.join(gateDir, 'page.html'),
		'<!doctype html><html><head><meta charset="utf-8"><title>ssh page</title>' +
			"<script>document.title='SCRIPT RAN';</script></head>" +
			'<body><h1 id="h">Printed over ssh</h1><p class="p">Paragraph from the remote host.</p>' +
			'<img src="pic.png" alt="pic" width="48"></body></html>\n',
	);
	fs.copyFileSync(path.join(repoRoot, 'fixtures', 'images', 'logo.png'), path.join(gateDir, 'pic.png'));
	writePng(path.join(gateDir, 'photo.png'), 24, 16);
	fs.writeFileSync(
		path.join(gateDir, 'vector.svg'),
		'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30">' +
			"<script>alert('svg script')</script><rect width=\"40\" height=\"30\" fill=\"#3366cc\"/></svg>\n",
	);
	// The bytes of video / PDF files are never read over ssh (the placeholder is
	// decided by the scheme), so a stub is enough.
	for (const name of ['clip.mp4', 'clip.mkv', 'clip.avi']) fs.writeFileSync(path.join(gateDir, name), Buffer.alloc(64));
	fs.writeFileSync(path.join(gateDir, 'paper.pdf'), '%PDF-1.4\n% stub\n');
	fs.writeFileSync(path.join(gateDir, 'plain.txt'), 'plain text over ssh\nsecond line\n');

	fs.writeFileSync(path.join(gateDir, JA_DIR, JA_MD), '# 帳票のご案内\n\n日本語の本文。\n');
	fs.writeFileSync(path.join(gateDir, JA_DIR, JA_SPACE_MD), '# スペース入り\n');
	writePng(path.join(gateDir, JA_DIR, JA_PNG), 20, 20);

	for (const [name, text] of Object.entries(searchSamples)) fs.writeFileSync(path.join(gateDir, 'search', name), text);

	fs.writeFileSync(path.join(gateDir, 'excl', 'keep.md'), 'exclgate keep\n');
	fs.writeFileSync(path.join(gateDir, 'excl', 'b.log'), 'exclgate log\n');
	fs.writeFileSync(path.join(gateDir, 'excl', '.hidden', 'h.md'), 'exclgate hidden\n');
	fs.writeFileSync(path.join(gateDir, 'excl', 'node_modules', 'pkg', 'x.md'), 'exclgate node_modules\n');
	fs.writeFileSync(path.join(remoteRoot, 'docs', 'drafts', 'draft.md'), 'exclgate draft\n');
}

function removeFixture(): void {
	fs.rmSync(gateDir, { recursive: true, force: true });
	fs.rmSync(path.join(remoteRoot, 'docs', 'drafts'), { recursive: true, force: true });
	fs.rmSync(path.join(remoteRoot, 'docs', 'added-while-open.md'), { force: true });
	fs.rmSync(path.join(remoteRoot, 'added-at-root.md'), { force: true });
	fs.rmSync(path.join(remoteRoot, '..', 'e2e-pngs'), { recursive: true, force: true });
	fs.rmSync(settingsFile, { force: true });
}

function writeSettings(patch: Record<string, Record<string, boolean>>): void {
	const merged: Record<string, Record<string, boolean>> = {};
	for (const key of Object.keys(DEFAULT_SETTINGS)) merged[key] = { ...DEFAULT_SETTINGS[key], ...(patch[key] ?? {}) };
	fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
	fs.writeFileSync(settingsFile, `${JSON.stringify(merged, null, 2)}\n`);
}

// --- page helpers ----------------------------------------------------------

interface WindowSnapshot {
	label: string;
	root: string | null;
	initialPath: string | null;
	showMarks: boolean;
}

async function listWindows(): Promise<WindowSnapshot[]> {
	const r = await invokeFromPage<WindowSnapshot[]>('__test_list_windows');
	return r.value ?? [];
}

async function windowTitle(label: string): Promise<{ ok: boolean; value: string | null; error: string | null }> {
	return invokeFromPage<string>('plugin:window|title', { label });
}

async function allWindowLabels(): Promise<string[]> {
	const r = await invokeFromPage<string[]>('plugin:window|get_all_windows');
	return r.value ?? [];
}

async function panelOpen(): Promise<boolean> {
	return browser.execute(() => !!document.querySelector('[data-testid="find-in-folder-input"]'));
}

/** The Find in Folder panel takes the Explorer's place in the left pane: close it before reading the tree. */
async function closePanelIfOpen(): Promise<void> {
	if (await panelOpen()) await closePanel();
}

/** Expand `dirUri` unless `probeChild` is already listed (a click toggles). */
async function ensureExpanded(dirUri: string, probeChild: string): Promise<void> {
	await closePanelIfOpen();
	if (await explorerHasRow(probeChild)) return;
	await clickExplorerRow(dirUri);
	await waitForExplorerRow(probeChild, { timeout: 30_000 });
}

async function viewerText(): Promise<string> {
	return browser.execute(() => document.querySelector('article.viewer')?.textContent ?? '');
}

async function waitViewerText(needle: string, timeout = 20_000): Promise<void> {
	await browser.waitUntil(async () => (await viewerText()).includes(needle), {
		timeout,
		timeoutMsg: `viewer never showed "${needle}" (now: ${JSON.stringify((await viewerText()).slice(0, 200))})`,
	});
}

interface ImageState {
	/** An `<img class="image">` is in the image viewer. */
	present: boolean;
	src: string;
	complete: boolean;
	naturalWidth: number;
	naturalHeight: number;
	/** The viewer shows its "Could not display" placeholder. */
	error: boolean;
	/** What the main area shows instead (for the failure message). */
	viewer: string;
}

async function imageState(): Promise<ImageState> {
	return browser.execute(() => {
		const img = document.querySelector<HTMLImageElement>('.image-viewer img.image');
		const main = document.querySelector('.image-viewer') ?? document.querySelector('article.viewer') ?? document.querySelector('main');
		return {
			present: !!img,
			src: img?.getAttribute('src') ?? '',
			complete: img?.complete ?? false,
			naturalWidth: img?.naturalWidth ?? 0,
			naturalHeight: img?.naturalHeight ?? 0,
			error: !!document.querySelector('.image-viewer .image-error'),
			viewer: `${main?.className ?? 'none'}: ${(main?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)}`,
		};
	});
}

async function waitImage(pred: (s: ImageState) => boolean, timeout = 20_000): Promise<ImageState> {
	let last: ImageState | null = null;
	try {
		await browser.waitUntil(
			async () => {
				last = await imageState();
				return last.present && last.complete && last.naturalWidth > 0 && pred(last);
			},
			{ timeout, timeoutMsg: 'image did not reach the expected state' },
		);
	} catch (e) {
		throw new Error(`${String(e)} (now: ${JSON.stringify(last)})`);
	}
	return last!;
}

/**
 * Record the app events named in `events` inside the page (the same
 * `plugin:event|listen` + `transformCallback` the `@tauri-apps/api` uses), so a
 * spec can tell "the backend never sent it" from "the page ignored it".
 */
async function listenEvents(events: string[]): Promise<void> {
	await browser.executeAsync<void, [string[]]>((names, done) => {
		const w = window as unknown as {
			__events?: { event: string; payload: unknown; at: number }[];
			__TAURI_INTERNALS__: {
				invoke: (cmd: string, args?: unknown) => Promise<unknown>;
				transformCallback: (cb: (e: unknown) => void, once?: boolean) => number;
			};
		};
		w.__events = w.__events ?? [];
		Promise.all(
			names.map((name) =>
				w.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
					event: name,
					target: { kind: 'Any' },
					handler: w.__TAURI_INTERNALS__.transformCallback((e: unknown) => {
						const ev = e as { event: string; payload: unknown };
						w.__events!.push({ event: ev.event, payload: ev.payload, at: Date.now() });
					}, false),
				}),
			),
		).then(
			() => done(),
			(e) => {
				w.__events!.push({ event: 'listen-failed', payload: String(e), at: Date.now() });
				done();
			},
		);
	}, events);
}

async function readEvents(): Promise<{ event: string; payload: unknown; at: number }[]> {
	return browser.execute(() =>
		JSON.parse(JSON.stringify((window as unknown as { __events?: unknown[] }).__events ?? [])),
	);
}

async function fetchStatus(url: string): Promise<{ status: number; type: string } | { error: string }> {
	return browser.executeAsync<{ status: number; type: string } | { error: string }, [string]>((u, done) => {
		fetch(u)
			.then((r) => done({ status: r.status, type: r.headers.get('content-type') ?? '' }))
			.catch((e) => done({ error: String(e) }));
	}, url);
}

interface MenuItemState {
	label: string;
	disabled: boolean;
}

async function openContextMenu(rowUri: string): Promise<MenuItemState[]> {
	await waitForExplorerRow(rowUri, { timeout: 15_000 });
	await browser.execute((u) => {
		const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find((r) => r.title === u)!;
		const r = row.getBoundingClientRect();
		row.dispatchEvent(
			new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.x + 20, clientY: r.y + r.height / 2 }),
		);
	}, rowUri);
	await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('.context-menu')), {
		timeout: 5_000,
		timeoutMsg: 'context menu did not open',
	});
	return browser.execute(() =>
		Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu .context-menu-item')).map((b) => ({
			label: b.textContent?.trim() ?? '',
			disabled: b.disabled,
		})),
	);
}

async function clickMenuItem(label: string): Promise<boolean> {
	return browser.execute((l) => {
		const b = Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu .context-menu-item')).find(
			(x) => x.textContent?.trim() === l,
		);
		if (!b) return false;
		b.click();
		return true;
	}, label);
}

async function contextMenuOpen(): Promise<boolean> {
	return browser.execute(() => !!document.querySelector('.context-menu'));
}

async function closeContextMenu(): Promise<void> {
	await browser.execute(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
	await browser.waitUntil(async () => !(await contextMenuOpen()), { timeout: 3_000, timeoutMsg: 'context menu did not close on Escape' });
}

/** Stub the clipboard so Copy Path never reaches the real pasteboard; the texts are recorded in the page. */
async function stubClipboard(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __clip?: string[] };
		w.__clip = [];
		Object.defineProperty(navigator.clipboard, 'writeText', {
			configurable: true,
			value: (t: string) => {
				w.__clip!.push(t);
				return Promise.resolve();
			},
		});
	});
}

async function readClipboardStub(): Promise<string[]> {
	return browser.execute(() => [...((window as unknown as { __clip?: string[] }).__clip ?? [])]);
}

async function restoreClipboard(): Promise<void> {
	await browser.execute(() => {
		delete (navigator.clipboard as unknown as Record<string, unknown>)['writeText'];
		delete (window as unknown as { __clip?: string[] }).__clip;
	});
}

// --- Find in Folder (the same driving as req66-find-in-folder-gate) --------------

interface Toggles {
	matchCase: boolean;
	wholeWord: boolean;
	useRegex: boolean;
}

const TOGGLE_IDS: Record<keyof Toggles, string> = {
	matchCase: 'find-in-folder-match-case',
	wholeWord: 'find-in-folder-whole-word',
	useRegex: 'find-in-folder-use-regex',
};

async function openPanel(): Promise<void> {
	const open = await browser.execute(() => !!document.querySelector('[data-testid="find-in-folder-input"]'));
	if (open) return;
	await emitMenu('menu_find_in_folder');
	await browser.waitUntil(
		async () => browser.execute(() => !!document.querySelector('[data-testid="find-in-folder-input"]')),
		{ timeout: 10_000, timeoutMsg: 'Find in Folder panel did not open on menu_find_in_folder' },
	);
}

async function closePanel(): Promise<void> {
	await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="find-in-folder-close"]')?.click());
	await browser.waitUntil(async () => browser.execute(() => !document.querySelector('[data-testid="find-in-folder"]')), {
		timeout: 5_000,
		timeoutMsg: 'panel did not close',
	});
}

async function readToggles(): Promise<Toggles> {
	return browser.execute((ids) => {
		const pressed = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-pressed') === 'true';
		return { matchCase: pressed(ids.matchCase), wholeWord: pressed(ids.wholeWord), useRegex: pressed(ids.useRegex) };
	}, TOGGLE_IDS);
}

async function status(): Promise<string> {
	return browser.execute(() => document.querySelector('[data-testid="find-in-folder-status"]')?.textContent?.trim() ?? '');
}

async function searchCalls(): Promise<number> {
	return (await readCapturedIpc()).filter((c) => c.cmd === SEARCH).length;
}

async function waitSettled(before: number, timeout = 60_000): Promise<CapturedIpc> {
	let last: CapturedIpc | undefined;
	await browser.waitUntil(
		async () => {
			const calls = (await readCapturedIpc()).filter((c) => c.cmd === SEARCH);
			if (calls.length <= before) return false;
			last = calls[calls.length - 1]!;
			if (last.body === null) return false;
			const s = await status();
			return s !== '' && !s.startsWith('Searching');
		},
		{ timeout, timeoutMsg: `search did not settle (status "${await status()}")` },
	);
	return last!;
}

async function clickToggle(key: keyof Toggles): Promise<{ ms: number; call: CapturedIpc | null }> {
	const hasQuery = await browser.execute(
		() => (document.querySelector<HTMLInputElement>('[data-testid="find-in-folder-input"]')?.value ?? '') !== '',
	);
	const before = await searchCalls();
	const t0 = Date.now();
	await browser.execute((id) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click(), TOGGLE_IDS[key]);
	if (!hasQuery) {
		await browser.pause(400);
		return { ms: Date.now() - t0, call: null };
	}
	const call = await waitSettled(before);
	return { ms: Date.now() - t0, call };
}

async function setToggles(want: Toggles): Promise<void> {
	for (const key of Object.keys(TOGGLE_IDS) as (keyof Toggles)[]) {
		if ((await readToggles())[key] !== want[key]) await clickToggle(key);
	}
}

interface IpcHit {
	path: string;
	line: number;
	text: string;
	ordinal: number;
	matched?: string;
}

interface SearchOutcome {
	status: string;
	total: number;
	files: number;
	hits: IpcHit[];
	error: unknown;
	args: Record<string, unknown>;
	rows: number;
}

/** Type `query`, wait for the search to settle; hits = the first page (every sample here fits in it). */
async function search(query: string): Promise<SearchOutcome> {
	const before = await searchCalls();
	await browser.execute((q) => {
		const input = document.querySelector<HTMLInputElement>('[data-testid="find-in-folder-input"]')!;
		input.value = q;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}, query);
	const rows = async () => browser.execute(() => document.querySelectorAll('[data-testid="find-in-folder-hit"]').length);
	if (query === '') {
		await browser.pause(400);
		return { status: await status(), total: 0, files: 0, hits: [], error: null, args: {}, rows: await rows() };
	}
	const call = await waitSettled(before);
	const args = call.args as Record<string, unknown>;
	if (!call.ok) return { status: await status(), total: 0, files: 0, hits: [], error: call.body, args, rows: await rows() };
	const body = call.body as { total: number; files: number; hits: IpcHit[] };
	return { status: await status(), total: body.total, files: body.files, hits: [...body.hits], error: null, args, rows: await rows() };
}

const inFile = (hits: IpcHit[], file: string) => hits.filter((h) => h.path === `ssh-gate/search/${file}`);
const lines = (hits: IpcHit[], file: string) => inFile(hits, file).map((h) => h.line);

// --- the spec ------------------------------------------------------------------

describe('ssh root gates (#16 ⑤ #17 ⑥ #18 ⑦ #19 ⑦ #22 ④ #28 ⑤ #29 ⑦ #30 ⑦ #34 ④ #38 g4 #39 g7 #40 g10 #48 ⑥ #65 g3 #66 g3)', function () {
	before(async function () {
		if (!SSH_MODE) {
			this.skip();
			return;
		}
		if (!remoteRoot || !fs.existsSync(remoteRoot)) throw new Error(`VELLIS_E2E_SSH_ROOT is not a folder: ${remoteRoot}`);
		if (!configHome) throw new Error('XDG_CONFIG_HOME is not set (scripts/e2e.sh --ssh exports it)');
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await browser.setTimeout({ script: 120_000 });
		await browser.waitUntil(async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0), {
			timeout: 60_000,
			timeoutMsg: 'explorer never listed the ssh root',
		});
		const windows = await listWindows();
		const main = windows.find((w) => w.label === 'main') ?? windows[0];
		if (main?.root) rootUri = main.root;
		expect(rootUri.startsWith('ssh://')).toBe(true);
		expect(await explorerHasRow(`${rootUri}/README.md`)).toBe(true);

		// The fixture goes into the remote folder after the window listed it.
		// The root folder itself is polled over ssh every 2 s (stat of the
		// directory) and the first poll only takes the baseline, so a change
		// made before it is never reported: wait past that first round. The
		// new folder should then turn up on its own; if not, the page is
		// reloaded and that is recorded (#18 ⑦ observation).
		await browser.pause(3_000);
		buildFixture();
		let rootAutoRefresh = true;
		const t0 = Date.now();
		try {
			await waitForExplorerRow(uri(gateDir), { timeout: 15_000 });
		} catch {
			rootAutoRefresh = false;
			await browser.execute(() => location.reload());
			await browser.pause(1_000);
			await waitForAppMounted();
			await installGateRecorder();
			await waitForExplorerRow(uri(gateDir), { timeout: 60_000 });
		}
		report(REPORT, {
			gate: 'ssh-setup',
			rootUri,
			remoteRoot,
			windows,
			rootRows: await explorerNames(),
			rootAutoRefreshOverSsh: rootAutoRefresh,
			msUntilGateDirListed: Date.now() - t0,
			settingsFile,
		});
	});

	after(async function () {
		if (!SSH_MODE) return;
		try {
			await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="find-close"]')?.click());
			await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="find-in-folder-close"]')?.click());
			await setIpcCapture([]);
			await setIpcBlock([]);
			await restoreGateRecorder();
		} finally {
			removeFixture();
		}
	});

	it('#17 ⑥: the window title is the root folder name — no user@host from the ssh authority', async () => {
		const t = await windowTitle('main');
		report(REPORT, { gate: '17-6-title', rootUri, ...t });
		expect(t.ok).toBe(true);
		expect(t.value).toBe(path.basename(remoteRoot));
		expect(t.value).not.toContain('@');
		expect(t.value).not.toContain(alias);
	});

	it('#18 ⑦: tree operations on the ssh root — expand, open, collapse, re-list (live refresh only at the root = the documented limit)', async () => {
		const docs = `${rootUri}/docs`;
		await ensureExpanded(docs, `${docs}/guide.md`);
		expect(await explorerHasRow(`${docs}/nested`)).toBe(true);
		await ensureExpanded(`${docs}/nested`, `${docs}/nested/deep.md`);
		await clickExplorerRow(`${docs}/nested/deep.md`);
		await waitViewerText('Deep');
		await clickExplorerRow(`${docs}/guide.md`);
		await waitViewerText('Guide');

		// A file added inside an expanded subfolder: no watch over ssh (要件#18 契約⑤) — observed, not required.
		const added = path.join(remoteRoot, 'docs', 'added-while-open.md');
		fs.writeFileSync(added, '# added while open\n');
		await browser.pause(6_000);
		const subfolderAutoRefresh = await explorerHasRow(`${docs}/added-while-open.md`);

		// Collapse: the children go; expand again: re-listed over ssh, so the added file is there now.
		await clickExplorerRow(docs);
		await browser.waitUntil(async () => !(await explorerHasRow(`${docs}/guide.md`)), { timeout: 5_000, timeoutMsg: 'docs did not collapse' });
		await clickExplorerRow(docs);
		await waitForExplorerRow(`${docs}/added-while-open.md`, { timeout: 30_000 });
		expect(await explorerHasRow(`${docs}/guide.md`)).toBe(true);
		// The expansion of nested is remembered across the collapse of its parent.
		const nestedStillExpanded = await explorerHasRow(`${docs}/nested/deep.md`);
		fs.rmSync(added, { force: true });

		// A file added at the root: the root is polled (2 s) — observed.
		const rootAdded = path.join(remoteRoot, 'added-at-root.md');
		fs.writeFileSync(rootAdded, '# at root\n');
		let rootAddSeen = true;
		try {
			await waitForExplorerRow(uri(rootAdded), { timeout: 12_000 });
		} catch {
			rootAddSeen = false;
		}
		fs.rmSync(rootAdded, { force: true });
		let rootRemoveSeen = true;
		if (rootAddSeen) {
			try {
				await browser.waitUntil(async () => !(await explorerHasRow(uri(rootAdded))), { timeout: 12_000 });
			} catch {
				rootRemoveSeen = false;
			}
		} else {
			rootRemoveSeen = false;
		}
		await shot('ssh-18-tree');
		report(REPORT, {
			gate: '18-7-tree',
			rows: await explorerNames(),
			subfolderAutoRefresh,
			nestedStillExpanded,
			rootAddSeen,
			rootRemoveSeen,
			ipcTail: (await readGateRecord()).ipc.slice(-12),
			dialogs: (await readGateRecord()).dialogs,
		});
		expect((await readGateRecord()).dialogs).toEqual([]);
	});

	it('#16 ⑤ / #22 ④: a PNG over ssh is drawn through vellis-asset://ssh/…; overwrite and delete are followed; an SVG with a <script> draws without running it', async () => {
		await ensureExpanded(uri(gateDir), uri(path.join(gateDir, 'photo.png')));
		const photo = path.join(gateDir, 'photo.png');
		await clickExplorerRow(uri(photo));
		const first = await waitImage((s) => s.naturalWidth === 24);
		expect(first.src.startsWith('vellis-asset://ssh/')).toBe(true);
		expect(first.src.includes(alias)).toBe(true);
		expect([first.naturalWidth, first.naturalHeight]).toEqual([24, 16]);
		const fetched = await fetchStatus(first.src);
		await shot('ssh-16-photo');

		// #22 ④: overwrite twice (different sizes) — each should arrive as
		// `binary_file_changed` (2 s poll) and show up as a new version query on
		// the src — then delete, which should close the viewer via `file_removed`.
		// Failures here are recorded (with the events the page received) and
		// asserted after the SVG part, so one gate's miss does not hide the other.
		await listenEvents(['binary_file_changed', 'file_removed', 'file_changed']);
		// The poll's first round only takes its baseline: let it pass before changing anything.
		await browser.pause(3_000);
		const change: Record<string, unknown> = {};
		let changeFailure: string | null = null;
		// Three ways of changing the file, each recorded on its own (which of
		// them the poll reports is the diagnosis when a gate misses).
		const pngs = path.join(remoteRoot, '..', 'e2e-pngs');
		fs.mkdirSync(pngs, { recursive: true });
		writePng(path.join(pngs, '40x30.png'), 40, 30);
		writePng(path.join(pngs, '32x32.png'), 32, 32);
		const styles: { style: string; apply: () => void; wantWidth: number }[] = [
			{ style: 'in-place write (same inode, new size + mtime)', apply: () => fs.copyFileSync(path.join(pngs, '40x30.png'), photo), wantWidth: 40 },
			{
				style: 'rename-replace (new inode)',
				apply: () => {
					fs.copyFileSync(path.join(pngs, '32x32.png'), `${photo}.tmp`);
					fs.renameSync(`${photo}.tmp`, photo);
				},
				wantWidth: 32,
			},
			{ style: 'append 16 bytes (same pixels, new size + mtime)', apply: () => fs.appendFileSync(photo, Buffer.alloc(16)), wantWidth: 32 },
		];
		const results: Record<string, unknown>[] = [];
		for (const s of styles) {
			const before = await imageState();
			const eventsBefore = (await readEvents()).length;
			const t = Date.now();
			s.apply();
			let ms: number | null = null;
			try {
				await waitImage((st) => st.src !== before.src && st.naturalWidth === s.wantWidth, 20_000);
				ms = Date.now() - t;
			} catch {
				ms = null;
			}
			const after = await imageState();
			results.push({
				style: s.style,
				localSize: fs.statSync(photo).size,
				ms,
				srcBefore: before.src,
				srcAfter: after.src,
				widthAfter: after.naturalWidth,
				eventsDuring: (await readEvents()).slice(eventsBefore),
			});
			if (ms === null) changeFailure = `${changeFailure ?? ''}${s.style}: no update within 20 s; `;
		}
		change.styles = results;
		change.stateAfterOverwrites = await imageState();
		let deleteFailure: string | null = null;
		const t3 = Date.now();
		fs.rmSync(photo, { force: true });
		try {
			await browser.waitUntil(async () => !(await browser.execute(() => !!document.querySelector('.image-viewer'))), {
				timeout: 30_000,
				timeoutMsg: 'image viewer did not close after the remote file was deleted',
			});
			change.msUntilClosedAfterDelete = Date.now() - t3;
		} catch (e) {
			deleteFailure = String(e);
			change.stateAfterDelete = await imageState();
		}
		change.events = await readEvents();
		await shot('ssh-22-after-overwrite-and-delete');
		// Contrast: a text document over ssh, appended to in place (the same poll, `file_changed` carries the text).
		const plain = path.join(gateDir, 'plain.txt');
		await clickExplorerRow(uri(plain));
		await waitViewerText('plain text over ssh');
		await browser.pause(3_000);
		const textEventsBefore = (await readEvents()).length;
		const t4 = Date.now();
		fs.appendFileSync(plain, 'third line appended\n');
		let textMs: number | null = null;
		try {
			await waitViewerText('third line appended', 20_000);
			textMs = Date.now() - t4;
		} catch {
			textMs = null;
		}
		change.textAppend = { ms: textMs, eventsDuring: (await readEvents()).slice(textEventsBefore).map((e) => e.event) };

		// SVG carrying a <script>: drawn as an image, nothing runs, no dialog.
		const vector = path.join(gateDir, 'vector.svg');
		await clickExplorerRow(uri(vector));
		const svg = await waitImage((s) => s.naturalWidth === 40);
		const titleAfter = await windowTitle('main');
		const sourceButton = await browser.execute(() => {
			const b = Array.from(document.querySelectorAll<HTMLButtonElement>('.image-toolbar button')).find((x) =>
				/source/i.test(x.textContent ?? ''),
			);
			if (!b) return null;
			b.click();
			return b.textContent?.trim() ?? '';
		});
		let sourceShown: string | null = null;
		if (sourceButton !== null) {
			await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('.image-source pre')), { timeout: 5_000 });
			sourceShown = await browser.execute(() => document.querySelector('.image-source pre')?.textContent ?? '');
		}
		await shot('ssh-16-svg');
		const rec = await readGateRecord();
		report(REPORT, {
			gate: '16-5-22-4-images',
			first,
			fetched,
			...change,
			changeFailure,
			deleteFailure,
			svg,
			titleAfterSvg: titleAfter.value,
			sourceButton,
			sourceShownPrefix: sourceShown?.slice(0, 60) ?? null,
			dialogs: rec.dialogs,
		});
		expect('status' in fetched && fetched.status).toBe(200);
		expect(svg.src.startsWith('vellis-asset://ssh/')).toBe(true);
		expect(titleAfter.value).toBe(path.basename(remoteRoot));
		expect(rec.dialogs).toEqual([]);
		if (sourceShown !== null) expect(sourceShown.includes('<svg')).toBe(true);
		expect(changeFailure).toBeNull();
		expect(deleteFailure).toBeNull();
	});

	it('#30 ⑦: Japanese (and space) file names over ssh list and open', async () => {
		const jaDir = path.join(gateDir, JA_DIR);
		await ensureExpanded(uri(gateDir), uri(jaDir));
		await ensureExpanded(uri(jaDir), uri(path.join(jaDir, JA_MD)));
		const rowUris = {
			md: await explorerRowUriByName(JA_MD),
			space: await explorerRowUriByName(JA_SPACE_MD),
			png: await explorerRowUriByName(JA_PNG),
		};
		await clickExplorerRow(uri(path.join(jaDir, JA_MD)));
		await waitViewerText('帳票のご案内');
		await clickExplorerRow(uri(path.join(jaDir, JA_SPACE_MD)));
		await waitViewerText('スペース入り');
		await clickExplorerRow(uri(path.join(jaDir, JA_PNG)));
		const img = await waitImage((s) => s.naturalWidth === 20);
		const fetched = await fetchStatus(img.src);
		await shot('ssh-30-japanese-png');
		report(REPORT, { gate: '30-7-japanese', rowUris, imgSrc: img.src, fetched, dialogs: (await readGateRecord()).dialogs });
		expect(rowUris.md).toBe(uri(path.join(jaDir, JA_MD)));
		expect(rowUris.space).toBe(uri(path.join(jaDir, JA_SPACE_MD)));
		expect('status' in fetched && fetched.status).toBe(200);
	});

	it('#28 ⑤ / #39 g7 / #40 g10: video over ssh is a placeholder — no <video>, no button, no controls, no Sources button (mp4 / mkv / avi)', async () => {
		await ensureExpanded(uri(gateDir), uri(path.join(gateDir, 'clip.mp4')));
		const results: Record<string, unknown> = {};
		for (const name of ['clip.mp4', 'clip.mkv', 'clip.avi']) {
			await clickExplorerRow(uri(path.join(gateDir, name)));
			await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('.video-placeholder .video-message')), {
				timeout: 15_000,
				timeoutMsg: `${name}: no video placeholder appeared`,
			});
			await browser.pause(500);
			const state = await browser.execute(() => ({
				message: document.querySelector('.video-placeholder .video-message')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
				video: !!document.querySelector('video'),
				placeholderButtons: Array.from(document.querySelectorAll('.video-placeholder button')).map((b) => b.textContent?.trim()),
				controls: !!document.querySelector('.video-controls'),
				sourcesButton: !!document.querySelector('button[title="Show or hide the Sources (provenance) panel"]'),
				provenancePanel: !!document.querySelector('.provenance-panel'),
			}));
			results[name] = state;
			if (name === 'clip.mp4') await shot('ssh-28-video-placeholder');
			expect(state.message).toBe(`Remote (ssh) videos cannot be played in the app (${name}).`);
			expect(state.video).toBe(false);
			expect(state.placeholderButtons).toEqual([]);
			expect(state.controls).toBe(false);
			expect(state.sourcesButton).toBe(false);
			expect(state.provenancePanel).toBe(false);
		}
		report(REPORT, { gate: '28-5-39-7-40-10-video', ...results, dialogs: (await readGateRecord()).dialogs });
	});

	it('#29 ⑦: PDF over ssh is a placeholder — no iframe, no button', async () => {
		await ensureExpanded(uri(gateDir), uri(path.join(gateDir, 'paper.pdf')));
		await clickExplorerRow(uri(path.join(gateDir, 'paper.pdf')));
		await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('.pdf-placeholder .pdf-message')), {
			timeout: 15_000,
			timeoutMsg: 'no PDF placeholder appeared',
		});
		await browser.pause(500);
		const state = await browser.execute(() => ({
			message: document.querySelector('.pdf-placeholder .pdf-message')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
			iframe: !!document.querySelector('iframe.pdf-frame'),
			buttons: Array.from(document.querySelectorAll('.pdf-placeholder button')).map((b) => b.textContent?.trim()),
		}));
		await shot('ssh-29-pdf-placeholder');
		report(REPORT, { gate: '29-7-pdf', ...state, dialogs: (await readGateRecord()).dialogs });
		expect(state.message).toBe('Remote (ssh) PDFs cannot be displayed in the app (paper.pdf).');
		expect(state.iframe).toBe(false);
		expect(state.buttons).toEqual([]);
	});

	it('#48 ⑥: Edit (menu and double-click) does nothing on an ssh document — stays read-only, no dialog', async () => {
		await ensureExpanded(uri(gateDir), uri(path.join(gateDir, 'plain.txt')));
		await clickExplorerRow(uri(path.join(gateDir, 'plain.txt')));
		await waitViewerText('plain text over ssh');
		const editState = async () =>
			browser.execute(() => ({
				editDone: !!document.querySelector('[data-testid="edit-done"]'),
				editSource: !!document.querySelector('[data-testid="edit-source"]'),
				contentEditable: Array.from(document.querySelectorAll('[contenteditable]')).map((e) => e.getAttribute('contenteditable')),
				textStart: (document.querySelector('article.viewer .markdown-body')?.textContent ?? '').slice(0, 40),
			}));
		await emitMenu('menu_edit');
		await browser.pause(800);
		const afterMenu = await editState();
		await browser.execute(() => {
			const target = document.querySelector('article.viewer .markdown-body pre') ?? document.querySelector('article.viewer .markdown-body');
			target?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
		});
		await browser.pause(800);
		const afterDblclick = await editState();
		// A save request on a read-only document must not reach `save_document` either.
		await setIpcCapture(['save_document']);
		await emitMenu('menu_save');
		await browser.pause(800);
		const saves = (await readCapturedIpc()).filter((c) => c.cmd === 'save_document');
		await setIpcCapture([]);
		await shot('ssh-48-edit-attempt');
		const rec = await readGateRecord();
		report(REPORT, { gate: '48-6-edit', afterMenu, afterDblclick, saveCalls: saves.length, dialogs: rec.dialogs });
		for (const s of [afterMenu, afterDblclick]) {
			expect(s.editDone).toBe(false);
			expect(s.editSource).toBe(false);
			expect(s.contentEditable.filter((v) => v === 'true' || v === '')).toEqual([]);
		}
		expect(saves.length).toBe(0);
		expect(rec.dialogs).toEqual([]);
	});

	it('#19 ⑦: context menu on ssh items — Reveal / Open with Default App / Open With… greyed, Copy Path gives the ssh URI (clipboard stubbed)', async () => {
		const file = uri(path.join(gateDir, 'plain.txt'));
		const folder = `${rootUri}/docs`;
		await ensureExpanded(uri(gateDir), file);
		// Safety net: should a greyed item still fire, the opener never runs.
		await setIpcBlock(['reveal_item_in_dir', 'open_path', 'plugin:opener|reveal_item_in_dir', 'plugin:opener|open_path']);
		await setIpcCapture(['reveal_item_in_dir', 'open_path', 'plugin:opener|reveal_item_in_dir', 'plugin:opener|open_path']);
		await clearCapturedIpc();
		await stubClipboard();
		try {
			const fileItems = await openContextMenu(file);
			await shot('ssh-19-context-menu-file');
			// Clicking a disabled button does nothing (and nothing reaches the opener).
			await clickMenuItem('Reveal in Finder');
			await clickMenuItem('Open with Default App');
			await browser.pause(300);
			const stillOpen = await contextMenuOpen();
			expect(await clickMenuItem('Copy Path')).toBe(true);
			await browser.waitUntil(async () => !(await contextMenuOpen()), { timeout: 3_000 });
			const copiedFile = await readClipboardStub();

			const folderItems = await openContextMenu(folder);
			await shot('ssh-19-context-menu-folder');
			expect(await clickMenuItem('Copy Path')).toBe(true);
			await browser.waitUntil(async () => !(await contextMenuOpen()), { timeout: 3_000 });
			const copiedAll = await readClipboardStub();

			// Escape closes the menu too.
			await openContextMenu(file);
			await closeContextMenu();

			const openerCalls = (await readCapturedIpc()).map((c) => c.cmd);
			const rec = await readGateRecord();
			report(REPORT, { gate: '19-7-context-menu', fileItems, folderItems, stillOpenAfterDisabledClicks: stillOpen, copied: copiedAll, openerCalls, dialogs: rec.dialogs });

			expect(fileItems).toEqual([
				{ label: 'Reveal in Finder', disabled: true },
				{ label: 'Open with Default App', disabled: true },
				{ label: 'Open With…', disabled: true },
				{ label: 'Open in New Tab', disabled: false },
				{ label: 'Open in New Window', disabled: false },
				{ label: 'Copy Path', disabled: false },
				{ label: 'Duplicate Window', disabled: false },
			]);
			expect(folderItems).toEqual([
				{ label: 'Reveal in Finder', disabled: true },
				{ label: 'Open in New Window', disabled: false },
				{ label: 'Copy Path', disabled: false },
				{ label: 'Duplicate Window', disabled: false },
			]);
			expect(stillOpen).toBe(true);
			expect(copiedFile).toEqual([file]);
			expect(copiedAll).toEqual([file, folder]);
			expect(openerCalls).toEqual([]);
			expect(rec.dialogs).toEqual([]);
		} finally {
			await restoreClipboard();
			await setIpcBlock([]);
			await setIpcCapture([]);
		}
	});

	it('#66 g3: Aa / ab / .* in Find in Folder behave the same on the ssh root (incl. re-search on press, close + reopen)', async () => {
		await setIpcCapture([SEARCH, PAGE]);
		await clearCapturedIpc();
		await openPanel();
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
		const records: Record<string, unknown> = {};

		let r = await search('Foo');
		records.root = r.args.root;
		expect(r.args.root).toBe(rootUri);
		records.caseOff = lines(r.hits, 'case.txt');
		await clickToggle('matchCase');
		r = await search('Foo');
		records.caseOn = inFile(r.hits, 'case.txt').map((h) => [h.line, h.ordinal]);
		expect(records.caseOff).toEqual([1, 2, 3]);
		expect(records.caseOn).toEqual([[2, 2], [3, 4]]);
		await clickToggle('matchCase');

		r = await search('cat');
		records.wordOff = lines(r.hits, 'word.txt');
		await clickToggle('wholeWord');
		r = await search('cat');
		records.wordOn = lines(r.hits, 'word.txt');
		expect(records.wordOff).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(records.wordOn).toEqual([2, 3, 4, 5, 6]);
		await clickToggle('wholeWord');

		r = await search('\\d{4}-\\d{2}');
		records.regexOffDates = lines(r.hits, 'dates.txt');
		expect(records.regexOffDates).toEqual([]);
		await clickToggle('useRegex');
		r = await search('\\d{4}-\\d{2}');
		records.regexOnDates = inFile(r.hits, 'dates.txt').map((h) => [h.line, h.matched, h.ordinal]);
		expect(records.regexOnDates).toEqual([[1, '2026-10', 1], [3, '2025-01', 1]]);
		await clickToggle('wholeWord');
		r = await search('fo+');
		records.regexWholeWord = inFile(r.hits, 'regex-jump.txt').map((h) => [h.line, h.matched, h.ordinal]);
		expect(records.regexWholeWord).toEqual([[1, 'fooo', 1], [2, 'foo', 3], [3, 'fooo', 2]]);
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });

		// The 8 combinations on `Foo.` (AC-66-6 table).
		const table: Record<string, number[]> = {};
		for (const useRegex of [false, true]) {
			for (const wholeWord of [false, true]) {
				for (const matchCase of [false, true]) {
					await setToggles({ matchCase, wholeWord, useRegex });
					r = await search('Foo.');
					table[`${matchCase ? 'on' : 'off'}-${wholeWord ? 'on' : 'off'}-${useRegex ? 'on' : 'off'}`] = lines(r.hits, 'combo.txt');
					expect(r.args).toMatchObject({ matchCase, wholeWord, useRegex, root: rootUri });
				}
			}
		}
		records.combinations = table;
		expect(table).toEqual({
			'off-off-off': [1, 2, 4],
			'on-off-off': [1, 4],
			'off-on-off': [1, 2],
			'on-on-off': [1],
			'off-off-on': [1, 2, 3, 4, 5],
			'on-off-on': [1, 3, 4],
			'off-on-on': [1, 2, 3, 5],
			'on-on-on': [1, 3],
		});

		// Pressing a toggle re-searches at once, without typing.
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
		const base = await search('cat');
		const t = await clickToggle('wholeWord');
		expect(t.call).not.toBeNull();
		expect(t.call!.args).toMatchObject({ query: 'cat', wholeWord: true, root: rootUri });
		const afterStatus = await status();
		records.rescope = { before: base.status, after: afterStatus, ms: t.ms };
		expect(afterStatus).not.toBe(base.status);
		await shot('ssh-66-panel');

		// Close + reopen keeps the toggles; the next search carries them.
		await setToggles({ matchCase: true, wholeWord: false, useRegex: true });
		await closePanel();
		await openPanel();
		const kept = await readToggles();
		expect(kept).toEqual({ matchCase: true, wholeWord: false, useRegex: true });
		r = await search('fo+');
		expect(r.args).toMatchObject({ matchCase: true, wholeWord: false, useRegex: true, root: rootUri });
		records.kept = kept;
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
		report(REPORT, { gate: '66-3-ssh', ...records, dialogs: (await readGateRecord()).dialogs });
		await closePanel();
		await setIpcCapture([]);
	});

	it('#65 g3: files.exclude and search.exclude take effect on the ssh root (tree and search)', async () => {
		const excl = path.join(gateDir, 'excl');
		const docs = `${rootUri}/docs`;
		await ensureExpanded(uri(gateDir), uri(excl));
		await ensureExpanded(uri(excl), uri(path.join(excl, 'keep.md')));
		await ensureExpanded(docs, `${docs}/guide.md`);
		const childNames = async (dirUri: string) =>
			browser.execute(
				(d) =>
					Array.from(document.querySelectorAll<HTMLElement>('.explorer-item'))
						.filter((r) => r.title.startsWith(`${d}/`) && !r.title.slice(d.length + 1).includes('/'))
						.map((r) => r.querySelector('.name')?.textContent ?? '')
						.sort(),
				dirUri,
			);
		await setIpcCapture([SEARCH, PAGE]);
		await clearCapturedIpc();
		const exclProbe = uri(path.join(excl, 'keep.md'));
		const docsProbe = `${docs}/guide.md`;
		// The panel and the tree share the left pane: the tree is read with the
		// panel closed (expanded folders re-list on remount), the search with it open.
		const tree = async (dirUri: string, probe: string) => {
			await closePanelIfOpen();
			await waitForExplorerRow(probe, { timeout: 20_000 });
			await browser.pause(300);
			return childNames(dirUri);
		};
		const waitTree = async (dirUri: string, probe: string, want: (names: string[]) => boolean) => {
			await closePanelIfOpen();
			await browser.waitUntil(async () => (await explorerHasRow(probe)) && want(await childNames(dirUri)), {
				timeout: 20_000,
				timeoutMsg: `tree under ${dirUri} did not change (now ${JSON.stringify(await childNames(dirUri))})`,
			});
			await browser.pause(300);
			return childNames(dirUri);
		};
		let togglesReset = false;
		const paths = async () => {
			await openPanel();
			if (!togglesReset) {
				await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
				togglesReset = true;
			}
			const r = await search('exclgate');
			const found = r.hits.map((h) => h.path).sort();
			expect(r.args.root).toBe(rootUri);
			await search('');
			return found;
		};
		const applySettings = async (patch: Record<string, Record<string, boolean>> | null) => {
			if (patch) writeSettings(patch);
			else fs.rmSync(settingsFile, { force: true });
			// The same event Rust sends after Vellis saved settings.json (契約7); the
			// settings themselves are read from disk by every list / search.
			await emitMenu('settings_changed');
		};

		const records: Record<string, unknown> = {};
		try {
			const step0 = { tree: await tree(uri(excl), exclProbe), docs: await tree(docs, docsProbe), search: await paths() };
			records.defaults = step0;
			expect(step0.tree).toEqual(['b.log', 'keep.md', 'node_modules']);
			expect(step0.docs).toContain('drafts');
			expect(step0.search).toEqual(['docs/drafts/draft.md', 'ssh-gate/excl/b.log', 'ssh-gate/excl/keep.md']);

			await applySettings({ 'search.exclude': { '**/*.log': true } });
			await browser.pause(1_500);
			const step1 = { tree: await tree(uri(excl), exclProbe), search: await paths() };
			records.searchExcludeLog = step1;
			expect(step1.search).toEqual(['docs/drafts/draft.md', 'ssh-gate/excl/keep.md']);
			expect(step1.tree).toEqual(['b.log', 'keep.md', 'node_modules']);

			await applySettings({ 'files.exclude': { '**/.*': false } });
			const step2 = { tree: await waitTree(uri(excl), exclProbe, (n) => n.includes('.hidden')), search: await paths() };
			records.dotFilesShown = step2;
			expect(step2.tree).toEqual(['.hidden', 'b.log', 'keep.md', 'node_modules']);
			expect(step2.search).toEqual(['docs/drafts/draft.md', 'ssh-gate/excl/.hidden/h.md', 'ssh-gate/excl/b.log', 'ssh-gate/excl/keep.md']);

			await applySettings({ 'files.exclude': { 'docs/drafts/**': true } });
			const step3 = { docs: await waitTree(docs, docsProbe, (n) => !n.includes('drafts')), tree: await tree(uri(excl), exclProbe), search: await paths() };
			records.draftsHidden = step3;
			expect(step3.docs).not.toContain('drafts');
			expect(step3.search).toEqual(['ssh-gate/excl/b.log', 'ssh-gate/excl/keep.md']);

			await applySettings(null);
			const step4 = { docs: await waitTree(docs, docsProbe, (n) => n.includes('drafts')), tree: await tree(uri(excl), exclProbe), search: await paths() };
			records.backToDefaults = step4;
			expect(step4.tree).toEqual(['b.log', 'keep.md', 'node_modules']);
			expect(step4.search).toEqual(step0.search);
			await closePanelIfOpen();
			await shot('ssh-65-tree-search');
			report(REPORT, { gate: '65-3-ssh', ...records, dialogs: (await readGateRecord()).dialogs });
		} finally {
			await closePanelIfOpen();
			await setIpcCapture([]);
		}
	});

	it('#34 ④: Duplicate Window from an ssh root opens a second window on the same root and document', async () => {
		const plain = uri(path.join(gateDir, 'plain.txt'));
		await ensureExpanded(uri(gateDir), plain);
		await clickExplorerRow(plain);
		await waitViewerText('plain text over ssh');
		const before = await listWindows();
		await setIpcCapture(['new_window']);
		await clearCapturedIpc();
		await emitMenu('menu_duplicate_window');
		let call: CapturedIpc | undefined;
		await browser.waitUntil(
			async () => {
				call = (await readCapturedIpc()).find((c) => c.cmd === 'new_window');
				return !!call && call.body !== null;
			},
			{ timeout: 30_000, timeoutMsg: 'new_window was not invoked / answered' },
		);
		await browser.waitUntil(async () => (await listWindows()).length === before.length + 1, {
			timeout: 30_000,
			timeoutMsg: 'the duplicated window did not register',
		});
		const after = await listWindows();
		const fresh = after.find((w) => !before.some((b) => b.label === w.label))!;
		const title = await windowTitle(fresh.label);
		await browser.pause(1_500);
		await shot('ssh-34-duplicate');
		const rec = await readGateRecord();
		report(REPORT, { gate: '34-4-duplicate', args: call?.args, ok: call?.ok, body: call?.body, fresh, title, dialogs: rec.dialogs });
		expect(call?.ok).toBe(true);
		expect(call?.args).toMatchObject({ root: rootUri, path: plain });
		expect(fresh.root).toBe(rootUri);
		expect(fresh.initialPath).toBe(plain);
		expect(title.value).toBe(path.basename(remoteRoot));
		expect(rec.dialogs).toEqual([]);
		await setIpcCapture([]);
	});

	it('#38 g4 (last: opens the native print sheet): an ssh HTML prints through the print window — the document is the on-screen snapshot with the CSP meta', async () => {
		const page = uri(path.join(gateDir, 'page.html'));
		await ensureExpanded(uri(gateDir), page);
		await clickExplorerRow(page);
		await browser.waitUntil(
			async () => browser.execute(() => (document.querySelector('iframe.html-viewer')?.getAttribute('srcdoc') ?? '').includes('Printed over ssh')),
			{ timeout: 20_000, timeoutMsg: 'the HTML viewer did not show the ssh page' },
		);
		const srcdoc: string = await browser.execute(() => document.querySelector('iframe.html-viewer')?.getAttribute('srcdoc') ?? '');

		// 1. The document that would go to the print window, without opening it.
		await setIpcBlock(['print_html']);
		await setIpcCapture(['print_html']);
		await clearCapturedIpc();
		await emitMenu('menu_print');
		await browser.waitUntil(async () => (await readCapturedIpc()).some((c) => c.cmd === 'print_html'), {
			timeout: 10_000,
			timeoutMsg: 'print_html was not invoked on menu_print',
		});
		const blocked = (await readCapturedIpc()).find((c) => c.cmd === 'print_html')!;
		const doc = (blocked.args as { document: string }).document;
		const docChecks = {
			length: doc.length,
			hasHeading: doc.includes('<h1 id="h">Printed over ssh</h1>'),
			hasParagraph: doc.includes('Paragraph from the remote host.'),
			hasCsp: doc.includes(PRINT_CSP_META),
			cspCount: doc.split(PRINT_CSP_META).length - 1,
			baseHref: /<base href="([^"]+)">/.exec(doc)?.[1] ?? null,
			sameAsScreenPlusCsp: doc.replace(PRINT_CSP_META, '') === srcdoc,
			scriptKept: doc.includes('SCRIPT RAN'),
			zoomMentions: (doc.match(/zoom/gi) ?? []).length,
			srcdocZoomMentions: (srcdoc.match(/zoom/gi) ?? []).length,
		};
		expect(docChecks.hasHeading).toBe(true);
		expect(docChecks.hasParagraph).toBe(true);
		expect(docChecks.cspCount).toBe(1);
		expect(docChecks.baseHref?.startsWith('vellis-asset://ssh/')).toBe(true);
		expect(docChecks.sameAsScreenPlusCsp).toBe(true);
		expect(docChecks.zoomMentions).toBe(docChecks.srcdocZoomMentions);
		// The stub's error reaches the user as the print-failed message (要件#35 ③), nothing else.
		const dialogsAfterBlocked = (await readGateRecord()).dialogs;
		expect(dialogsAfterBlocked).toEqual(['alert:Could not print: blocked by gate check']);

		// 2. For real: the print window opens, loads the document and shows the
		// print sheet (nothing is printed unless a person presses Print; the
		// harness closes the app, and the sheet with it, at the end).
		// The command answers only when `Webview::print()` has run; whether that
		// waits for the sheet is not known, so the window list is what is watched
		// (`plugin:window|get_all_windows` from this window), and the IPC state is
		// recorded as it stands.
		await setIpcBlock([]);
		await clearCapturedIpc();
		const labelsBefore = await allWindowLabels();
		const t0 = Date.now();
		await emitMenu('menu_print');
		let printWindows: string[] = [];
		let labelsAfter: string[] = [];
		await browser.waitUntil(
			async () => {
				labelsAfter = await allWindowLabels();
				printWindows = labelsAfter.filter((l) => l.startsWith('print-') && !labelsBefore.includes(l));
				return printWindows.length > 0;
			},
			{ timeout: 30_000, timeoutMsg: `no print-… window appeared (windows: ${JSON.stringify(labelsAfter)})` },
		);
		const msUntilWindow = Date.now() - t0;
		// Give the load + 0.5 s settle + print() time, then look at the IPC state.
		await browser.pause(6_000);
		const real = (await readCapturedIpc()).find((x) => x.cmd === 'print_html');
		const ipcState = !real ? 'not-sent' : real.body === null ? 'pending' : real.ok ? 'ok' : `error:${String(real.body)}`;
		const printTitle = printWindows[0] ? await windowTitle(printWindows[0]) : null;
		const mainStillAnswers = await invokeFromPage<string>('get_build_info');
		await shot('ssh-38-print-window-open');
		const rec = await readGateRecord();
		report(REPORT, {
			gate: '38-4-print-ssh-html',
			docChecks,
			msUntilWindow,
			ipcState,
			labelsBefore,
			labelsAfter,
			printWindows,
			printTitle,
			mainStillAnswers: mainStillAnswers.ok,
			dialogs: rec.dialogs,
		});
		expect(printWindows.length).toBe(1);
		expect(ipcState === 'ok' || ipcState === 'pending').toBe(true);
		expect(mainStillAnswers.ok).toBe(true);
		expect(rec.dialogs).toEqual(dialogsAfterBlocked);
		await setIpcCapture([]);
	});
});
