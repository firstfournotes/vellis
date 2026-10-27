import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import {
	assertIpcInterceptionWorks,
	clickExplorerRow,
	explorerHasRow,
	installGateRecorder,
	invokeFromPage,
	readGateRecord,
	report,
	restoreGateRecorder,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

/**
 * 要件#5 追補b (backlog 325) — AC-5-追b (b), driven on the webdriver build against
 * the disposable sshd of `scripts/e2e-sshd.sh` (the same harness as
 * `ssh-root-gates.e2e.ts`):
 *
 *   open a text file on the ssh root; as soon as its text is on screen, change
 *   the file (no pause) — `file_changed` must arrive within 4 s and the new
 *   text must show.
 *
 * Before the fix the ssh poll (`poll_loop`) sleeps 2 s before its first stat
 * and takes that as the baseline, so a change made inside those first ~2 s is
 * never reported: this spec changes the file right after the viewer shows it
 * (well inside 2 s on the local sshd), which is exactly the window the fix
 * closes. `ssh-root-gates.e2e.ts` avoids that window with a 3 s pause before
 * every change; this spec deliberately does not.
 *
 * Not run in the ordinary loop (tauri-webdriver + sshd). Run it with:
 *   scripts/e2e.sh --ssh --spec tests/e2e/specs/ssh-watch-first-stat.e2e.ts
 * Outside ssh mode (`VELLIS_E2E_SSH_MODE` unset) every test is skipped.
 */

const SSH_MODE = process.env.VELLIS_E2E_SSH_MODE === '1';
/** Local path of the folder the sshd serves as the root. */
const remoteRoot = process.env.VELLIS_E2E_SSH_ROOT ?? '';
const REPORT = 'ssh-watch-first-stat-report.jsonl';
/** AC-5-追b (b): `file_changed` within 4 s of the change. */
const DEADLINE_MS = 4_000;
/** The folder `scripts/e2e-sshd.sh` creates in the remote root (listed afresh on expand). */
const FIXTURE_DIR = 'docs';
const FIXTURE_PROBE = 'guide.md';
const FILE_NAME = 'req5b-first-stat.txt';
const FIRST_LINE = 'first stat over ssh';
const APPENDED_LINE = 'appended right after the text showed';

/** The root URI as the backend registered it (adopted from `__test_list_windows` at setup). */
let rootUri = process.env.VELLIS_E2E_SSH_URI ?? '';
const uri = (p: string) => `${rootUri}/${path.relative(remoteRoot, p).split(path.sep).join('/')}`;

const fixtureFile = () => path.join(remoteRoot, FIXTURE_DIR, FILE_NAME);

// --- page helpers (the same shapes as ssh-root-gates.e2e.ts) -------------------

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

async function viewerText(): Promise<string> {
	return browser.execute(() => document.querySelector('article.viewer')?.textContent ?? '');
}

async function waitViewerText(needle: string, timeout: number): Promise<void> {
	await browser.waitUntil(async () => (await viewerText()).includes(needle), {
		timeout,
		interval: 100,
		timeoutMsg: `viewer never showed "${needle}" within ${timeout} ms (now: ${JSON.stringify((await viewerText()).slice(0, 200))})`,
	});
}

/**
 * Record the app events named in `events` inside the page (the same
 * `plugin:event|listen` + `transformCallback` the `@tauri-apps/api` uses), so the
 * report can tell "the backend never sent it" from "the page ignored it".
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

async function panelOpen(): Promise<boolean> {
	return browser.execute(() => !!document.querySelector('[data-testid="find-in-folder-input"]'));
}

/** The Find in Folder panel takes the Explorer's place in the left pane: close it before reading the tree. */
async function closePanelIfOpen(): Promise<void> {
	if (!(await panelOpen())) return;
	await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="find-in-folder-close"]')?.click());
	await browser.waitUntil(async () => !(await panelOpen()), { timeout: 5_000, timeoutMsg: 'panel did not close' });
}

/**
 * Expand `dirUri` so that it is listed afresh over sftp: a collapsed folder is
 * listed on the click; an already expanded one is collapsed first (a file added
 * inside an expanded folder is not watched over ssh, 要件#18 契約⑤).
 */
async function expandFresh(dirUri: string, probeChild: string): Promise<void> {
	await closePanelIfOpen();
	if (await explorerHasRow(probeChild)) {
		await clickExplorerRow(dirUri);
		await browser.waitUntil(async () => !(await explorerHasRow(probeChild)), {
			timeout: 5_000,
			timeoutMsg: 'folder did not collapse',
		});
	}
	await clickExplorerRow(dirUri);
	await waitForExplorerRow(probeChild, { timeout: 30_000 });
}

// --- the spec ------------------------------------------------------------------

describe('ssh watch: a change right after the text showed is reported (要件#5 追補b, backlog 325)', function () {
	before(async function () {
		if (!SSH_MODE) {
			this.skip();
			return;
		}
		if (!remoteRoot || !fs.existsSync(remoteRoot)) throw new Error(`VELLIS_E2E_SSH_ROOT is not a folder: ${remoteRoot}`);
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
		expect(await explorerHasRow(`${rootUri}/${FIXTURE_DIR}`)).toBe(true);

		// The fixture goes into a subfolder of the remote root: it is listed when
		// the folder is expanded (no need to wait for the root's 2 s poll).
		fs.writeFileSync(fixtureFile(), `${FIRST_LINE}\n`);
		report(REPORT, { gate: '5b-setup', rootUri, remoteRoot, file: fixtureFile(), windows });
	});

	after(async function () {
		if (!SSH_MODE) return;
		try {
			await restoreGateRecorder();
		} finally {
			fs.rmSync(fixtureFile(), { force: true });
		}
	});

	it('AC-5-追b (b): a text file over ssh, changed as soon as its text showed, gets file_changed within 4 s and shows the new text', async () => {
		const file = fixtureFile();
		const fileUri = uri(file);
		await listenEvents(['file_changed', 'file_removed']);
		await expandFresh(`${rootUri}/${FIXTURE_DIR}`, `${rootUri}/${FIXTURE_DIR}/${FIXTURE_PROBE}`);
		await waitForExplorerRow(fileUri, { timeout: 30_000 });

		// Open the document: the watch starts (subscribe first, then the read) and the text shows.
		const tOpen = Date.now();
		await clickExplorerRow(fileUri);
		await waitViewerText(FIRST_LINE, 20_000);
		const msUntilShown = Date.now() - tOpen;

		// No pause here: this is the window the first stat must already cover.
		const eventsBefore = (await readEvents()).length;
		const tChange = Date.now();
		fs.appendFileSync(file, `${APPENDED_LINE}\n`);
		let msUntilUpdated: number | null = null;
		let failure: string | null = null;
		try {
			await waitViewerText(APPENDED_LINE, DEADLINE_MS);
			msUntilUpdated = Date.now() - tChange;
		} catch (e) {
			failure = String(e);
		}
		// Give a late event a moment to land in the record (diagnosis only; the deadline above is the judgement).
		await browser.pause(300);
		const eventsDuring = (await readEvents()).slice(eventsBefore);
		const changed = eventsDuring.filter((e) => e.event === 'file_changed' && String((e.payload as { uri?: string })?.uri ?? '') === fileUri);
		const msUntilEvent = changed.length > 0 ? changed[0]!.at - tChange : null;
		const rec = await readGateRecord();
		report(REPORT, {
			gate: '5b-b-change-right-after-shown',
			file: fileUri,
			msUntilShown,
			msBetweenShownAndChange: tChange - (tOpen + msUntilShown),
			msUntilEvent,
			msUntilUpdated,
			failure,
			eventsDuring: eventsDuring.map((e) => ({ event: e.event, at: e.at - tChange })),
			viewerTail: (await viewerText()).slice(-120),
			dialogs: rec.dialogs,
		});

		expect(failure).toBeNull();
		expect(msUntilUpdated).not.toBeNull();
		expect(msUntilEvent).not.toBeNull();
		expect(msUntilEvent!).toBeLessThanOrEqual(DEADLINE_MS);
		expect(rec.dialogs).toEqual([]);
	});
});
