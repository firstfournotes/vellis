import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertIpcInterceptionWorks,
	clickExplorerRow,
	emitMenu,
	explorerNames,
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
 * Requirement #10 追補a human gate (Issue #382, PR #749), driven on the webdriver
 * build (docs/requirements/req-10.md「追補a の人間ゲート」):
 *
 *  1. A file is open; only that file is deleted; the page is reloaded. The root
 *     and the tree are kept, the document is closed, and the alert
 *     `Could not open the file: …` is shown exactly once.
 *  2. The whole root folder is deleted; the page is reloaded. No alert; the
 *     window goes back to the startup argument (the first window was started
 *     as `vellis <start-root>`, so the root is start-root again, no history
 *     picker).
 *
 * How the alert is observed. In this app `window.alert` is not WebKit's: the
 * dialog plugin's init script (tauri-plugin-dialog `init-iife.js`, run at
 * document start) replaces it with `invoke('plugin:dialog|message', {message})`,
 * a native sheet the WebDriver alert endpoints never see (tasks/lessons.md
 * 2026-10-04; CI run 40350186306 confirmed `GET /alert/text` stays "no such
 * alert" throughout). A `location.reload()` also discards every stub the spec
 * put on the old page. So right after the reload is triggered the spec races a
 * tight `execute` loop against the new document and installs an early recorder
 * there (alert/confirm stubs + an IPC log with captures, like
 * `installGateRecorder`) as soon as the new page exists. The restore runs in
 * `onMount` after `init_window`, and the alert comes last, after every
 * `listen`; so when the early recorder's IPC log contains `init_window` it was
 * in place before the restore and before the alert, and the attempt is
 * conclusive: it then shows whether `open_document` was attempted for the
 * deleted file and failed, and whether `alert` was called, and with what text.
 * When the race is lost (no `init_window` in the log) the attempt is
 * inconclusive. Gate 2 repeats it (bounded; nothing is shown there). Gate 1
 * does not: a lost race there means the app's real `alert` went to
 * `plugin:dialog|message`, i.e. a native sheet is left on the window until this
 * spec's app exits (each spec file gets its own app instance), and a retry
 * would stack another one — so gate 1 fails at once as "harness inconclusive",
 * which the `10a-1-attempt` record shows apart from a product failure.
 *
 * Why the snapshot is pinned before the reload in gate 1: the document watcher
 * reports the deletion within a fraction of a second, which closes the
 * document and rewrites the reload snapshot (`vellis.reload-state`) with
 * `docUri: null` — a human cannot reload faster than that. The spec reads the
 * snapshot the app itself wrote while the document was open, freezes that key
 * on the old page (any other write to it is recorded, not applied) and writes
 * the value once more on `pagehide`, so the new page's restore reads exactly
 * the snapshot that names the deleted file. Everything after that is the
 * product's own path.
 *
 * The temp roots are entered through File > Open Folder… (`menu_open_folder`)
 * with the folder dialog answered from the spec at the IPC layer, the same
 * `set_root` → `applyRoot` path a user takes.
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const REPORT = 'req10a-report.jsonl';
const RELOAD_STATE_KEY = 'vellis.reload-state';
const OVERWRITE_LOG_KEY = 'req10a.snapshot-overwrites';
const ALERT_PREFIX = 'Could not open the file: ';
const MAX_ATTEMPTS = 3;

const uri = (p: string) => `file://${p}`;

let tmpBase = '';
let rootA = '';
let rootB = '';

interface ReloadSnapshot {
	rootUri: string;
	docUri: string | null;
	expandedDirs: string[];
}

interface EarlyCapture {
	seq: number;
	cmd: string;
	args: unknown;
	ok: boolean | null;
	/** Response body, kept only for failed calls and `open_document` (success bodies are large). */
	body: unknown;
}

interface EarlyRecord {
	ipc: string[];
	dialogs: string[];
	captured: EarlyCapture[];
	/** `performance.now()` of the install, in the new page. */
	installedAt: number;
	/** Explorer rows present when the recorder was installed (0 = before the first listing was applied). */
	rowsAtInstall: number;
}

/** The reload snapshot the app keeps in sessionStorage (requirement #10), raw and parsed. */
async function readSnapshot(): Promise<{ raw: string | null; parsed: ReloadSnapshot | null }> {
	return browser.execute((key) => {
		let raw: string | null = null;
		try {
			raw = sessionStorage.getItem(key);
		} catch {
			raw = null;
		}
		let parsed: ReloadSnapshot | null = null;
		if (raw !== null) {
			try {
				parsed = JSON.parse(raw) as ReloadSnapshot;
			} catch {
				parsed = null;
			}
		}
		return { raw, parsed };
	}, RELOAD_STATE_KEY);
}

/** What the window shows: the snapshot's root/doc, the rows, document open or not, picker open or not. */
async function windowView(): Promise<{
	snapshotRoot: string | null;
	snapshotDoc: string | null;
	rows: string[];
	rowUris: string[];
	emptyState: boolean;
	rootPicker: boolean;
	h1: string | null;
}> {
	const snap = await readSnapshot();
	const dom = await browser.execute(() => ({
		rowUris: Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).map((r) => r.title),
		emptyState: document.querySelector('.empty-state') !== null,
		rootPicker: document.querySelector('.root-picker') !== null,
		h1: document.querySelector('article.viewer .markdown-body h1')?.textContent ?? null,
	}));
	return {
		snapshotRoot: snap.parsed?.rootUri ?? null,
		snapshotDoc: snap.parsed?.docUri ?? null,
		rows: await explorerNames(),
		rowUris: dom.rowUris,
		emptyState: dom.emptyState,
		rootPicker: dom.rootPicker,
		h1: dom.h1,
	};
}

/**
 * Answer the next `plugin:dialog|open` call (File > Open Folder…) with `folder`
 * instead of showing the native folder dialog. Layered on top of the gate
 * recorder's fetch wrapper so the call is still logged there; removed by
 * `removeFolderDialogStub`.
 */
async function installFolderDialogStub(folder: string): Promise<void> {
	await browser.execute((answer) => {
		const w = window as unknown as {
			__req10aStub?: { previousFetch: typeof window.fetch; seen: unknown[] };
		};
		if (w.__req10aStub) throw new Error('folder dialog stub is already installed');
		const previousFetch = window.fetch;
		const stub = { previousFetch, seen: [] as unknown[] };
		w.__req10aStub = stub;
		window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
			const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
			const prefix = 'ipc://localhost/';
			if (url.startsWith(prefix)) {
				const cmd = decodeURIComponent(url.slice(prefix.length).split('?')[0] ?? '');
				if (cmd === 'plugin:dialog|open') {
					let args: unknown = null;
					try {
						args = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
					} catch {
						args = init?.body ?? null;
					}
					stub.seen.push(args);
					return Promise.resolve(
						new Response(JSON.stringify(answer), {
							status: 200,
							headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
						}),
					);
				}
			}
			return previousFetch.call(this, input, init);
		} as typeof window.fetch;
	}, folder);
}

async function removeFolderDialogStub(): Promise<unknown[]> {
	return browser.execute(() => {
		const w = window as unknown as {
			__req10aStub?: { previousFetch: typeof window.fetch; seen: unknown[] };
		};
		const stub = w.__req10aStub;
		if (!stub) return [];
		window.fetch = stub.previousFetch;
		delete w.__req10aStub;
		return JSON.parse(JSON.stringify(stub.seen)) as unknown[];
	});
}

/** File > Open Folder… with the dialog answered by `folder`; waits until the window is on it. */
async function openFolderFromMenu(folder: string): Promise<void> {
	await installFolderDialogStub(folder);
	try {
		await emitMenu('menu_open_folder');
		await browser.waitUntil(async () => (await readSnapshot()).parsed?.rootUri === uri(folder), {
			timeout: 15_000,
			timeoutMsg: `Open Folder… did not switch the root to ${folder} (snapshot: ${(await readSnapshot()).raw})`,
		});
	} finally {
		await removeFolderDialogStub();
	}
}

/**
 * Make sure the page carries the gate recorder (a reload drops it), the
 * interception is live, and its logs are empty, so a test judges only the
 * dialogs / IPC raised in that test whatever ran before it.
 */
async function ensureGateRecorder(): Promise<void> {
	await installGateRecorder();
	await assertIpcInterceptionWorks();
	await browser.execute(() => {
		const r = (window as unknown as { __gate?: { ipc: string[]; dialogs: string[] } }).__gate;
		if (r) {
			r.ipc = [];
			r.dialogs = [];
		}
	});
}

/**
 * Trigger `location.reload()` without waiting on the page (the old page is
 * about to go away). The old page is marked (`__req10aOld`) so the early
 * recorder race can tell it from the new one. With `pinSnapshot`, the
 * reload-state key is written now, frozen against other writes until unload
 * (attempts are counted into `OVERWRITE_LOG_KEY`, which survives the reload)
 * and written once more on `pagehide`.
 */
async function triggerReload(pinSnapshot: string | null): Promise<void> {
	await browser.execute(
		(key, raw, logKey) => {
			(window as unknown as { __req10aOld?: boolean }).__req10aOld = true;
			if (raw !== null) {
				const originalSetItem = Storage.prototype.setItem;
				const write = (k: string, v: string) => {
					try {
						originalSetItem.call(sessionStorage, k, v);
					} catch {
						// If storage cannot be written the restore has nothing to work on;
						// the assertions below will say so.
					}
				};
				const pin = () => write(key, raw);
				write(logKey, '0');
				Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
					if (this === sessionStorage && k === key && v !== raw) {
						// The app tried to rewrite the snapshot (a `file_removed` closed
						// the document): count it, keep the pin.
						write(logKey, String(Number(sessionStorage.getItem(logKey) ?? '0') + 1));
						return;
					}
					originalSetItem.call(this, k, v);
				};
				pin();
				window.addEventListener('pagehide', pin);
			}
			setTimeout(() => location.reload(), 0);
		},
		RELOAD_STATE_KEY,
		pinSnapshot,
		OVERWRITE_LOG_KEY,
	);
}

/** How many times the old page tried to rewrite the pinned snapshot before unloading (read on the new page). */
async function snapshotOverwriteAttempts(): Promise<number | null> {
	return browser.execute((logKey) => {
		try {
			const v = sessionStorage.getItem(logKey);
			return v === null ? null : Number(v);
		} catch {
			return null;
		}
	}, OVERWRITE_LOG_KEY);
}

/**
 * One poll of the early-recorder race: on the old page do nothing ('old'); on
 * the new page install the recorder once ('installed', later 'present'). The
 * recorder stubs alert/confirm/prompt (recording them — nothing reaches the
 * screen), logs every IPC command name, and keeps args/outcome of the commands
 * the restore uses.
 */
async function pollEarlyRecorder(captureCmds: string[]): Promise<'old' | 'installed' | 'present'> {
	return browser.execute((capture) => {
		const w = window as unknown as { __req10aOld?: boolean; __req10aEarly?: EarlyRecord };
		if (w.__req10aOld) return 'old';
		if (w.__req10aEarly) return 'present';
		const rec: EarlyRecord = {
			ipc: [],
			dialogs: [],
			captured: [],
			installedAt: performance.now(),
			rowsAtInstall: document.querySelectorAll('.explorer-item').length,
		};
		w.__req10aEarly = rec;
		window.alert = (m?: unknown) => {
			rec.dialogs.push(`alert:${String(m)}`);
		};
		window.confirm = (m?: string) => {
			rec.dialogs.push(`confirm:${String(m)}`);
			return false;
		};
		window.prompt = (m?: string) => {
			rec.dialogs.push(`prompt:${String(m)}`);
			return null;
		};
		const previousFetch = window.fetch;
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
			if (!url.startsWith(prefix)) return previousFetch.call(this, input, init);
			const cmd = decodeURIComponent(url.slice(prefix.length).split('?')[0] ?? '');
			rec.ipc.push(cmd);
			if (!capture.includes(cmd)) return previousFetch.call(this, input, init);
			const entry: EarlyCapture = {
				seq: rec.captured.length,
				cmd,
				args: typeof init?.body === 'string' ? parse(init.body) : null,
				ok: null,
				body: null,
			};
			rec.captured.push(entry);
			return previousFetch.call(this, input, init).then(async (res) => {
				entry.ok = res.headers.get('Tauri-Response') !== 'error';
				if (!entry.ok || cmd === 'open_document' || cmd === 'plugin:dialog|message') {
					entry.body = parse(await res.clone().text());
				}
				return res;
			});
		} as typeof window.fetch;
		return 'installed';
	}, captureCmds);
}

interface RaceResult {
	outcome: 'installed' | 'timeout';
	polls: number;
	errors: number;
	ms: number;
}

/** Poll as fast as the driver allows until the new page carries the early recorder. */
async function raceEarlyRecorder(timeoutMs: number): Promise<RaceResult> {
	const t0 = Date.now();
	let polls = 0;
	let errors = 0;
	while (Date.now() - t0 < timeoutMs) {
		polls++;
		try {
			const r = await pollEarlyRecorder(['init_window', 'set_root', 'open_document', 'open_binary_document', 'plugin:dialog|message']);
			if (r === 'installed' || r === 'present') {
				return { outcome: 'installed', polls, errors, ms: Date.now() - t0 };
			}
		} catch {
			// The old document is unloading / the new one is not scriptable yet.
			errors++;
		}
	}
	return { outcome: 'timeout', polls, errors, ms: Date.now() - t0 };
}

async function readEarlyRecord(): Promise<EarlyRecord | null> {
	return browser.execute(() => {
		const w = window as unknown as { __req10aEarly?: EarlyRecord };
		return w.__req10aEarly ? (JSON.parse(JSON.stringify(w.__req10aEarly)) as EarlyRecord) : null;
	});
}

async function waitForRows(predicate: (names: string[]) => boolean, timeoutMsg: string): Promise<void> {
	await browser.waitUntil(async () => predicate(await explorerNames()), {
		timeout: 20_000,
		timeoutMsg: `${timeoutMsg} (rows: ${JSON.stringify(await explorerNames())})`,
	});
}

/**
 * The alert is the last thing `onMount` does, after every `listen` and the
 * `plugin:event|emit` of the update-banner handshake. Wait for that emit (or
 * for a dialog) in the early record, then a short grace period; bounded in
 * case the recorder was late and never sees them.
 */
async function waitForStartupToFinish(): Promise<void> {
	await browser.waitUntil(
		async () => {
			const r = await readEarlyRecord();
			return r !== null && (r.dialogs.length > 0 || r.ipc.includes('plugin:event|emit'));
		},
		{ timeout: 8_000, timeoutMsg: 'startup did not reach its end within 8 s' },
	).catch(() => undefined);
	await browser.pause(800);
}

interface AttemptEvidence {
	attempt: number;
	race: RaceResult;
	conclusive: boolean;
	rowsAtInstall: number | null;
	ipc: string[];
	captured: EarlyCapture[];
	dialogs: string[];
	/** Writes to the reload-state key the old page tried after the pin (gate 1 only; null = not pinned / unreadable). */
	snapshotOverwriteAttempts: number | null;
	/** The app's snapshot right before the reload (the pinned value in gate 1). */
	snapshotBefore: ReloadSnapshot | null;
}

/** Shape the evidence of one reload for the report: the recorder's log minus noise. */
function summarize(attempt: number, race: RaceResult, early: EarlyRecord | null, snapshotBefore: ReloadSnapshot | null, overwrites: number | null): AttemptEvidence {
	return {
		attempt,
		race,
		conclusive: early?.ipc.includes('init_window') ?? false,
		rowsAtInstall: early?.rowsAtInstall ?? null,
		ipc: early?.ipc ?? [],
		captured: early?.captured ?? [],
		dialogs: early?.dialogs ?? [],
		snapshotOverwriteAttempts: overwrites,
		snapshotBefore,
	};
}

describe('Requirement #10 追補a human gate (reload after the open file / the root vanished)', () => {
	before(async () => {
		await waitForAppMounted();
		await ensureGateRecorder();
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'vellis-req10a-'));
		rootA = path.join(tmpBase, 'root-a');
		rootB = path.join(tmpBase, 'root-b');
		fs.mkdirSync(rootA, { recursive: true });
		fs.mkdirSync(rootB, { recursive: true });
		fs.writeFileSync(path.join(rootA, 'keeper.md'), '# Keeper\n\nStays in the root.\n');
	});

	after(async () => {
		try {
			await waitForAppMounted();
			// Back on the harness root for the specs that follow (gate 2 ends there by
			// contract; this is the fallback when an assertion failed earlier).
			const snap = await readSnapshot();
			if (snap.parsed?.rootUri !== uri(startRoot)) {
				await ensureGateRecorder();
				await openFolderFromMenu(startRoot);
			}
			await restoreGateRecorder();
		} catch (err) {
			report(REPORT, { gate: '10a-cleanup', error: String(err) });
		}
		fs.rmSync(tmpBase, { recursive: true, force: true });
	});

	it('gate 1: delete only the open file and reload → root and tree kept, document closed, one alert "Could not open the file: …"', async function () {
		this.timeout(120_000);
		const doomed = path.join(rootA, 'doomed.md');

		await ensureGateRecorder();
		await openFolderFromMenu(rootA);
		fs.writeFileSync(doomed, '# Doomed\n\nThis file is deleted before the reload.\n');
		await waitForExplorerRow(uri(doomed), { timeout: 15_000, nudgeDir: rootA, nudgePrefix: 'req10a' });
		await clickExplorerRow(uri(doomed));
		await browser.waitUntil(async () => (await windowView()).h1 === 'Doomed', {
			timeout: 15_000,
			timeoutMsg: 'doomed.md did not open',
		});
		// The snapshot the app wrote for this state: root-a with doomed.md open.
		let before = await readSnapshot();
		await browser.waitUntil(
			async () => {
				before = await readSnapshot();
				return before.parsed?.rootUri === uri(rootA) && before.parsed?.docUri === uri(doomed);
			},
			{ timeout: 10_000, timeoutMsg: `snapshot never recorded the open document (now: ${before.raw})` },
		);
		expect((await readGateRecord()).dialogs).toEqual([]);
		await shot('req10a-gate1-before-reload');

		// Delete the file and reload at once; the app's own snapshot is pinned so
		// the watcher's `file_removed` cannot rewrite it first (header comment).
		// One attempt only: a lost race leaves a native sheet (header comment).
		fs.rmSync(doomed, { force: true });
		await triggerReload(before.raw);
		const race = await raceEarlyRecorder(15_000);
		await waitForAppMounted();
		await waitForRows((names) => names.includes('keeper.md'), 'tree of root-a did not come back after the reload');
		await waitForStartupToFinish();
		const early = await readEarlyRecord();
		const evidence = summarize(1, race, early, before.parsed, await snapshotOverwriteAttempts());
		report(REPORT, { gate: '10a-1-attempt', ...evidence });

		const view = await windowView();
		await shot('req10a-gate1-after-reload');
		report(REPORT, { gate: '10a-1-after', attempts: 1, conclusive: evidence.conclusive, ...view });

		// Harness: the early recorder must have been in before the restore, or the
		// attempt proves nothing about the product (reported as such above; the
		// app's real alert then went to a native sheet — see the header).
		expect(evidence.conclusive).toBe(true);
		const openCalls = evidence.captured.filter((c) => c.cmd === 'open_document' || c.cmd === 'open_binary_document');
		const alerts = evidence.dialogs.filter((d) => d.startsWith('alert:'));
		// The restore tried to reopen the deleted file and the command failed.
		expect(openCalls.map((c) => (c.args as { uri?: string } | null)?.uri)).toEqual([uri(doomed)]);
		expect(openCalls[0]!.ok).toBe(false);
		// 追補a 1: exactly one alert, worded like the startup failure (`openFileFailedMessage`).
		expect(alerts.length).toBe(1);
		expect(alerts[0]!.startsWith(`alert:${ALERT_PREFIX}`)).toBe(true);
		expect(alerts[0]!.length).toBeGreaterThan(`alert:${ALERT_PREFIX}`.length);
		expect(evidence.dialogs.filter((d) => !d.startsWith('alert:'))).toEqual([]);
		// The one notice went through the stubbed `window.alert`; nothing reached
		// the dialog plugin (no native sheet, and no second channel for a notice).
		expect(evidence.ipc.filter((c) => c === 'plugin:dialog|message')).toEqual([]);
		// 契約3: root and tree kept, the document closed.
		expect(view.snapshotRoot).toBe(uri(rootA));
		expect(view.rows).toContain('keeper.md');
		expect(view.rows).not.toContain('doomed.md');
		expect(view.rowUris.every((u) => u.startsWith(`${uri(rootA)}/`))).toBe(true);
		expect(view.emptyState).toBe(true);
		expect(view.h1).toBeNull();
		expect(view.snapshotDoc).toBeNull();
		expect(view.rootPicker).toBe(false);
	});

	it('gate 2: delete the whole root and reload → no alert, the window is back on the startup argument', async function () {
		this.timeout(120_000);
		const attempts: AttemptEvidence[] = [];
		let evidence: AttemptEvidence | null = null;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			await ensureGateRecorder();
			fs.mkdirSync(rootB, { recursive: true });
			fs.writeFileSync(path.join(rootB, 'b-only.md'), '# B\n\nThe whole root is deleted before the reload.\n');
			if ((await readSnapshot()).parsed?.rootUri !== uri(rootB)) await openFolderFromMenu(rootB);
			await waitForRows((names) => names.includes('b-only.md'), 'tree of root-b did not show');
			const before = await readSnapshot();
			expect(before.parsed?.rootUri).toBe(uri(rootB));
			if (attempt === 1) await shot('req10a-gate2-before-reload');

			fs.rmSync(rootB, { recursive: true, force: true });
			await triggerReload(null);
			const race = await raceEarlyRecorder(15_000);
			await waitForAppMounted();
			await waitForRows((names) => names.includes('start-doc.md'), 'the window did not fall back to start-root');
			await waitForStartupToFinish();
			const early = await readEarlyRecord();
			evidence = summarize(attempt, race, early, before.parsed, null);
			attempts.push(evidence);
			report(REPORT, { gate: '10a-2-attempt', ...evidence });
			if (evidence.conclusive) break;
		}

		await browser.waitUntil(async () => (await readSnapshot()).parsed?.rootUri === uri(startRoot), {
			timeout: 10_000,
			timeoutMsg: `snapshot did not settle on start-root (now: ${(await readSnapshot()).raw})`,
		});
		const view = await windowView();
		await shot('req10a-gate2-after-reload');
		report(REPORT, { gate: '10a-2-after', attempts: attempts.length, conclusive: evidence?.conclusive ?? false, ...view });

		expect(evidence).not.toBeNull();
		expect(evidence!.conclusive).toBe(true);
		// The restore tried the vanished root and `set_root` failed; no document was tried.
		const setRoot = evidence!.captured.filter((c) => c.cmd === 'set_root');
		expect(setRoot.map((c) => (c.args as { uri?: string } | null)?.uri)).toEqual([uri(rootB)]);
		expect(setRoot[0]!.ok).toBe(false);
		expect(evidence!.captured.some((c) => c.cmd === 'open_document' || c.cmd === 'open_binary_document')).toBe(false);
		// 追補a 2: nothing is shown — neither through `window.alert` nor the dialog plugin.
		expect(evidence!.dialogs).toEqual([]);
		expect(evidence!.ipc.filter((c) => c === 'plugin:dialog|message')).toEqual([]);
		// Startup argument behaviour: start-root, no history picker, no document.
		expect(view.snapshotRoot).toBe(uri(startRoot));
		expect(view.rows).toContain('start-doc.md');
		expect(view.rows).not.toContain('b-only.md');
		expect(view.rowUris.every((u) => u.startsWith(`${uri(startRoot)}/`))).toBe(true);
		expect(view.rootPicker).toBe(false);
		expect(view.emptyState).toBe(true);
		expect(view.snapshotDoc).toBeNull();
	});
});
