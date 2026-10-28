import { browser, expect } from '@wdio/globals';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertIpcInterceptionWorks,
	clickExplorerRow,
	emitMenu,
	explorerHasRow,
	explorerNames,
	installGateRecorder,
	invokeFromPage,
	readGateRecord,
	report,
	restoreGateRecorder,
	setIpcBlock,
	shot,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Requirement #48 追補m human gate (Issue #750, PR #755), driven on the webdriver
 * build (docs/requirements/req-48.md「追補m の人間ゲート」):
 *
 *   With unsaved edits in the window, `vellis -r <folder>` (the CLI's IPC
 *   `SwitchRoot`, what Claude Code's `/vellis` runs) shows the same single
 *   confirmation as a root switch from the UI, in the window that received
 *   the request. Cancel keeps the root and the edits; Don't Save switches;
 *   Save saves first, then switches. Without edits the root switches at once,
 *   as before.
 *
 * Requirement #48 追補o (Issue #766, 2026-10-28, rewrite approved by the
 * founder): the two `ask()` sheets (Continue / Cancel, then Save / Don't Save)
 * became one `message()` sheet with three buttons (Save / Don't Save / Cancel).
 * Only the confirmation part of this spec changed (one scripted answer, one
 * expected message, `YesNoCancelCustom` buttons); what is expected after the
 * answer (switch / stay / save first / no switch on a failed save) did not.
 *
 * The CLI is the real binary spawned with `['-r', dir]` (the harness's launch
 * wrapper passes explicit args through, as `single-instance-ipc.e2e.ts` relies
 * on). The confirmation is `message()` of @tauri-apps/plugin-dialog, i.e. the
 * IPC command `plugin:dialog|message` answered with the label of the button
 * clicked; the gate recorder can only block IPC, so this spec layers a small
 * reply stub on its fetch wrapper that answers each `plugin:dialog|message`
 * with the scripted label and keeps the messages in order.
 *
 * The request goes to the backend's *front* window (`WindowManager::active_label`,
 * the most recently focused). The harness starts a fresh app per spec file (CI
 * run 40350186306: one "WebDriver plugin initialized" per spec), so normally
 * this window is the only one; should another registered window exist (a
 * runner that reuses the app), `before()` destroys it (`plugin:window|destroy`,
 * permitted by capabilities/default.json) and records which, because the window
 * WebDriver drives never regains focus by itself.
 *
 * The current root is read from the app's own reload snapshot
 * (`sessionStorage['vellis.reload-state'].rootUri`, requirement #10) and
 * cross-checked against the Explorer's rows; the file is read from disk.
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const gateDir = path.join(startRoot, 'req48m-gate');
const editFile = path.join(gateDir, 'edit-me.txt');
const REPORT = 'req48m-report.jsonl';
const RELOAD_STATE_KEY = 'vellis.reload-state';
const BODY = 'article.viewer .markdown-body';

const ORIGINAL = 'The original text.\nSecond line, unchanged on disk unless Save is chosen.\n';
const EDIT = 'An edit the gate check typed and did not save.\n';

// The one confirmation (`src/lib/edit-guard.ts`): "save, drop or stop" —
// Save / Don't Save / Cancel on a single sheet (requirement #48 追補o).
const SAVE_MESSAGE = 'Do you want to save your changes before continuing?';
const SAVE_TITLE = 'Unsaved Changes';
const CANCEL = 'Cancel';
const SAVE = 'Save';
const DONT_SAVE = "Don't Save";
/** What plugin-dialog's `message()` sends for `buttons: { yes, no, cancel }`. */
const SAVE_BUTTONS = { YesNoCancelCustom: [SAVE, DONT_SAVE, CANCEL] };

const binary =
	process.env.VELLIS_E2E_BINARY ??
	path.resolve(__dirname, '..', '..', '..', 'src-tauri', 'target', 'debug', 'vellis');

const uri = (p: string) => `file://${p}`;

/**
 * The CLI canonicalizes the path it is given (`resolve_path_to_uri`), so a
 * `vellis -r` to a folder under `$TMPDIR` (`/var/…`) ends on `/private/var/…`.
 * Every URI the spec expects after a CLI switch is built from the real path.
 */
const realUri = (p: string) => uri(fs.realpathSync(p));
const START_ROOT_URIS = new Set([uri(startRoot), realUri(startRoot)]);
const isStartRoot = (root: string | null) => root !== null && START_ROOT_URIS.has(root);

/** Created in `before()` as a real (symlink-free) path. */
let otherDir = '';

interface WindowSnapshot {
	label: string;
	root: string | null;
	initialPath: string | null;
	showMarks: boolean;
}

interface AskSeen {
	message: string;
	title: string | null;
	buttons: unknown;
	answer: string;
	scripted: boolean;
	/** The reply was held back (`holdFirst`) and had to be released. */
	held: boolean;
	/** The reply has been delivered to the page (always true for an unheld ask). */
	released: boolean;
	/** The held reply was delivered by the safety timer, not by the spec. */
	autoReleased: boolean;
}

/** Ask stub state kept on the page. */
interface AskStubState {
	previousFetch: typeof window.fetch;
	seen: AskSeen[];
	/** Delivers the held first reply; null when nothing is held. */
	release: (() => void) | null;
}

/**
 * Run `vellis -r <dir>` as the CLI does and wait for it to exit (bounded).
 *
 * Guard: the CLI finds the running instance through `$XDG_RUNTIME_DIR/vellis.sock`
 * and falls back to `/tmp/vellis-$UID.sock` — the founder's own Vellis — when
 * the variable is unset (`src-tauri/src/ipc/server.rs`). `scripts/e2e.sh`
 * exports a fresh `mktemp -d …/vellis-e2e-XXXXXX` for wdio and the app alike,
 * so the request must never be sent without it.
 */
async function cliSwitchRoot(dir: string): Promise<{ code: number; durationMs: number }> {
	const runtimeDir = process.env.XDG_RUNTIME_DIR ?? '';
	if (!runtimeDir || !path.basename(runtimeDir).startsWith('vellis-e2e-')) {
		throw new Error(
			`refusing to run vellis -r: XDG_RUNTIME_DIR is ${JSON.stringify(runtimeDir)}, not the harness's vellis-e2e-* dir (the CLI would reach the user's own Vellis socket)`,
		);
	}
	const t0 = Date.now();
	const child = spawn(binary, ['-r', dir], {
		stdio: 'ignore',
		env: { ...process.env, RUST_LOG: 'warn' },
	});
	return new Promise((resolve, reject) => {
		const cap = setTimeout(() => {
			if (!child.killed) {
				child.kill('SIGKILL');
				reject(new Error('vellis -r did not exit within 10s (契約4: the CLI must not wait for the dialog)'));
			}
		}, 10_000);
		child.once('exit', (code) => {
			clearTimeout(cap);
			resolve({ code: code ?? -1, durationMs: Date.now() - t0 });
		});
		child.once('error', (err) => {
			clearTimeout(cap);
			reject(err);
		});
	});
}

/**
 * Start every test with empty recorder logs — both the IPC names and the
 * dialogs (gate-helpers only offers `clearIpcLog`; `dialogs` kept m-3b's
 * "Could not save" notice into m-4 in CI run 40358624199). Each test then
 * judges only what it raised itself, whatever the order.
 */
async function clearGateLogs(): Promise<void> {
	await browser.execute(() => {
		const r = (window as unknown as { __gate?: { ipc: string[]; dialogs: string[] } }).__gate;
		if (!r) throw new Error('gate recorder is not installed');
		r.ipc = [];
		r.dialogs = [];
	});
}

/** Current root as the app's reload snapshot records it (null before the first save). */
async function snapshotRoot(): Promise<string | null> {
	return browser.execute((key) => {
		try {
			const raw = sessionStorage.getItem(key);
			if (raw === null) return null;
			const parsed = JSON.parse(raw) as { rootUri?: unknown };
			return typeof parsed.rootUri === 'string' ? parsed.rootUri : null;
		} catch {
			return null;
		}
	}, RELOAD_STATE_KEY);
}

/** Top-level Explorer row URIs; all of them sit directly under the current root. */
async function rowUris(): Promise<string[]> {
	return browser.execute(() =>
		Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).map((r) => r.title),
	);
}

async function waitForRoot(expected: string | ((root: string | null) => boolean), timeoutMsg: string): Promise<void> {
	const matches = typeof expected === 'string' ? (root: string | null) => root === expected : expected;
	await browser.waitUntil(async () => matches(await snapshotRoot()), {
		timeout: 15_000,
		timeoutMsg: `${timeoutMsg} (snapshot root: ${await snapshotRoot()}, rows: ${JSON.stringify(await explorerNames())})`,
	});
}

interface EditorView {
	editing: boolean;
	text: string | null;
	doneButton: boolean;
	emptyState: boolean;
}

async function editorView(): Promise<EditorView> {
	return browser.execute((body) => {
		const editing = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext[contenteditable="true"]`);
		const pre = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext`);
		return {
			editing: editing !== null,
			text: pre?.textContent ?? null,
			doneButton: document.querySelector('[data-testid="edit-done"]') !== null,
			emptyState: document.querySelector('.empty-state') !== null,
		};
	}, BODY);
}

/**
 * Answer `plugin:dialog|message` (what plugin-dialog's `message()` — and `ask()` —
 * invokes) from the page: the n-th call gets `answers[n]` as the label that was
 * "clicked"; `message()` resolves to that label and edit-guard reads it. Calls
 * beyond the script are answered with the dialog's own cancel label (never a
 * proceeding one) and marked `scripted: false`. Layered on the gate recorder's
 * fetch wrapper so the call is still in its IPC log.
 *
 * `holdFirst`: the first reply is not delivered until `releaseHeldAsk()` (or a
 * 20 s safety timer, recorded as `autoReleased`) — the dialog stays "open",
 * which is what lets the spec check that the CLI has already exited meanwhile
 * (契約4). `removeAskStub` releases a held reply before it restores `fetch`,
 * so no `ask()` is left pending on the page.
 */
async function installAskStub(answers: string[], opts: { holdFirst?: boolean } = {}): Promise<void> {
	await browser.execute(
		(script, holdFirst) => {
			const w = window as unknown as { __req48mAsk?: AskStubState };
			if (w.__req48mAsk) throw new Error('ask stub is already installed');
			const previousFetch = window.fetch;
			const stub: AskStubState = { previousFetch, seen: [], release: null };
			w.__req48mAsk = stub;
			window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
				const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
				const prefix = 'ipc://localhost/';
				if (url.startsWith(prefix)) {
					const cmd = decodeURIComponent(url.slice(prefix.length).split('?')[0] ?? '');
					if (cmd === 'plugin:dialog|message') {
						let args: { message?: unknown; title?: unknown; buttons?: unknown } = {};
						try {
							args = typeof init?.body === 'string' ? (JSON.parse(init.body) as typeof args) : {};
						} catch {
							args = {};
						}
						const n = stub.seen.length;
						const scripted = n < script.length;
						let answer: string;
						if (scripted) {
							answer = script[n]!;
						} else {
							const buttons = args.buttons as
								| { OkCancelCustom?: [string, string]; YesNoCancelCustom?: [string, string, string] }
								| undefined;
							answer = buttons?.YesNoCancelCustom
								? buttons.YesNoCancelCustom[2]
								: buttons?.OkCancelCustom
									? buttons.OkCancelCustom[1]
									: 'Cancel';
						}
						const held = holdFirst && n === 0;
						const entry: AskSeen = {
							message: String(args.message ?? ''),
							title: typeof args.title === 'string' ? args.title : null,
							buttons: args.buttons ?? null,
							answer,
							scripted,
							held,
							released: !held,
							autoReleased: false,
						};
						stub.seen.push(entry);
						const reply = () =>
							new Response(JSON.stringify(answer), {
								status: 200,
								headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
							});
						if (!held) return Promise.resolve(reply());
						return new Promise<Response>((resolve) => {
							const deliver = (auto: boolean) => {
								if (entry.released) return;
								entry.released = true;
								entry.autoReleased = auto;
								stub.release = null;
								resolve(reply());
							};
							stub.release = () => deliver(false);
							setTimeout(() => deliver(true), 20_000);
						});
					}
				}
				return previousFetch.call(this, input, init);
			} as typeof window.fetch;
		},
		answers,
		opts.holdFirst === true,
	);
}

async function readAskStub(): Promise<AskSeen[]> {
	return browser.execute(() => {
		const w = window as unknown as { __req48mAsk?: AskStubState };
		return JSON.parse(JSON.stringify(w.__req48mAsk?.seen ?? [])) as AskSeen[];
	});
}

/** Deliver the held first reply; true when something was pending. */
async function releaseHeldAsk(): Promise<boolean> {
	return browser.execute(() => {
		const w = window as unknown as { __req48mAsk?: AskStubState };
		const release = w.__req48mAsk?.release ?? null;
		if (!release) return false;
		release();
		return true;
	});
}

async function removeAskStub(): Promise<AskSeen[]> {
	return browser.execute(() => {
		const w = window as unknown as { __req48mAsk?: AskStubState };
		const stub = w.__req48mAsk;
		if (!stub) return [];
		stub.release?.();
		window.fetch = stub.previousFetch;
		delete w.__req48mAsk;
		return JSON.parse(JSON.stringify(stub.seen)) as AskSeen[];
	});
}

async function waitForAsks(count: number, timeoutMsg: string): Promise<void> {
	await browser.waitUntil(async () => (await readAskStub()).length >= count, {
		timeout: 15_000,
		timeoutMsg: `${timeoutMsg} (asks so far: ${JSON.stringify(await readAskStub())})`,
	});
}

async function listBackendWindows(): Promise<WindowSnapshot[]> {
	const r = await invokeFromPage<WindowSnapshot[]>('__test_list_windows');
	if (!r.ok) throw new Error(`__test_list_windows failed: ${r.error}`);
	return r.value ?? [];
}

async function ownLabel(): Promise<string> {
	return browser.execute(
		() =>
			(window as unknown as { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: string } } } })
				.__TAURI_INTERNALS__.metadata.currentWindow.label,
	);
}

/**
 * The CLI request is sent to the backend's front window. Windows earlier specs
 * opened through IPC are still registered and were focused last, so close them
 * and wait until this window is the only one registered.
 */
async function makeThisTheOnlyWindow(): Promise<{ own: string; destroyed: string[]; failed: string[] }> {
	const own = await ownLabel();
	const destroyed: string[] = [];
	const failed: string[] = [];
	for (const w of await listBackendWindows()) {
		if (w.label === own) continue;
		const r = await invokeFromPage<void>('plugin:window|destroy', { label: w.label });
		if (r.ok) destroyed.push(w.label);
		else failed.push(`${w.label}: ${r.error}`);
	}
	if (destroyed.length > 0) {
		await browser.waitUntil(
			async () => (await listBackendWindows()).every((w) => w.label === own),
			{ timeout: 10_000, timeoutMsg: 'destroyed windows did not leave the WindowManager' },
		);
	}
	return { own, destroyed, failed };
}

/** Expand `req48m-gate/` if its rows are not shown (a root switch collapses the tree). */
async function ensureGateDirExpanded(): Promise<void> {
	if (await explorerHasRow(uri(editFile))) return;
	await waitForExplorerRow(uri(gateDir), { timeout: 20_000, nudgeDir: startRoot, nudgePrefix: 'req48m' });
	await clickExplorerRow(uri(gateDir));
	await waitForExplorerRow(uri(editFile), { timeout: 15_000 });
}

/** Open edit-me.txt from the tree, enter the editor with the Edit menu event, type EDIT (unsaved). */
async function openFileAndEdit(): Promise<void> {
	await ensureGateDirExpanded();
	await clickExplorerRow(uri(editFile));
	await browser.waitUntil(
		async () => {
			const v = await editorView();
			return !v.editing && v.text === ORIGINAL;
		},
		{ timeout: 15_000, timeoutMsg: 'edit-me.txt did not open in the plain-text view' },
	);
	await emitMenu('menu_edit');
	await browser.waitUntil(async () => (await editorView()).editing, {
		timeout: 5_000,
		timeoutMsg: 'menu_edit did not enter the editor',
	});
	await browser.execute(
		(body, extra) => {
			const pre = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext[contenteditable="true"]`)!;
			pre.textContent = (pre.textContent ?? '') + extra;
			pre.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: extra }));
		},
		BODY,
		EDIT,
	);
	const v = await editorView();
	expect(v.editing).toBe(true);
	expect(v.text).toBe(ORIGINAL + EDIT);
}

/** Open edit-me.txt in the plain view only (no editor, nothing dirty). */
async function openFileForViewing(): Promise<void> {
	await ensureGateDirExpanded();
	await clickExplorerRow(uri(editFile));
	await browser.waitUntil(
		async () => {
			const v = await editorView();
			return !v.editing && v.text === fs.readFileSync(editFile, 'utf8');
		},
		{ timeout: 15_000, timeoutMsg: 'edit-me.txt did not open in the plain-text view' },
	);
}

/**
 * Leave the editor without a dialog: put the text back to what is on disk (the
 * buffer is then not dirty) and press Done Editing, which asks nothing when
 * nothing is dirty.
 */
async function revertEditAndLeaveEditor(): Promise<void> {
	const v = await editorView();
	if (!v.editing) return;
	const onDisk = fs.readFileSync(editFile, 'utf8');
	await browser.execute(
		(body, text) => {
			const pre = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext[contenteditable="true"]`)!;
			pre.textContent = text;
			pre.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
			document.querySelector<HTMLButtonElement>('[data-testid="edit-done"]')?.click();
		},
		BODY,
		onDisk,
	);
	await browser.waitUntil(async () => !(await editorView()).editing, {
		timeout: 5_000,
		timeoutMsg: 'Done Editing did not leave the editor after the text was reverted',
	});
}

/** Back on start-root through the same CLI (no edits → immediate), for the next test / spec. */
async function restoreStartRoot(): Promise<void> {
	if (isStartRoot(await snapshotRoot())) return;
	const r = await cliSwitchRoot(startRoot);
	report(REPORT, { gate: '48m-restore-root', cli: r });
	await waitForRoot(isStartRoot, 'vellis -r start-root did not bring the window back');
}

/**
 * Cleanup fallback when the CLI route itself is what failed: File > Open Folder…
 * with the folder dialog (`plugin:dialog|open`) answered from the page, so the
 * specs after this one still start on start-root.
 */
async function restoreStartRootViaOpenFolder(): Promise<void> {
	await browser.execute((answer) => {
		const previousFetch = window.fetch;
		const w = window as unknown as { __req48mOpen?: typeof window.fetch };
		w.__req48mOpen = previousFetch;
		window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
			const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
			const prefix = 'ipc://localhost/';
			if (url.startsWith(prefix) && decodeURIComponent(url.slice(prefix.length).split('?')[0] ?? '') === 'plugin:dialog|open') {
				return Promise.resolve(
					new Response(JSON.stringify(answer), {
						status: 200,
						headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
					}),
				);
			}
			return previousFetch.call(this, input, init);
		} as typeof window.fetch;
	}, startRoot);
	try {
		await emitMenu('menu_open_folder');
		await waitForRoot(isStartRoot, 'Open Folder… fallback did not bring the window back to start-root');
	} finally {
		await browser.execute(() => {
			const w = window as unknown as { __req48mOpen?: typeof window.fetch };
			if (w.__req48mOpen) {
				window.fetch = w.__req48mOpen;
				delete w.__req48mOpen;
			}
		});
	}
}

describe('Requirement #48 追補m human gate (vellis -r with unsaved edits asks like the UI does)', () => {
	before(async () => {
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		const windows = await makeThisTheOnlyWindow();
		report(REPORT, { gate: '48m-setup-windows', ...windows });
		expect(windows.failed).toEqual([]);

		fs.rmSync(gateDir, { recursive: true, force: true });
		fs.mkdirSync(gateDir, { recursive: true });
		fs.writeFileSync(editFile, ORIGINAL);
		otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vellis-req48m-')));
		fs.writeFileSync(path.join(otherDir, 'other-root.md'), '# Other root\n\nThe folder `vellis -r` points at.\n');
		await ensureGateDirExpanded();
	});

	/**
	 * Every test ends on start-root with no stub, no editor and the fixture file
	 * back to ORIGINAL — also when an assertion failed half-way, so one failure
	 * cannot cascade into the next test (CI run 40350186306: m-2's failure left
	 * the window on the other root and m-3 / m-4 could not even start).
	 */
	afterEach(async () => {
		const problems: Record<string, string> = {};
		try {
			await setIpcBlock([]);
		} catch (err) {
			problems.clearIpcBlock = String(err);
		}
		try {
			await removeAskStub(); // releases a held reply first
		} catch (err) {
			problems.removeAskStub = String(err);
		}
		try {
			await revertEditAndLeaveEditor();
		} catch (err) {
			problems.leaveEditor = String(err);
		}
		try {
			await restoreStartRoot();
		} catch (err) {
			problems.restoreViaCli = String(err);
			try {
				await restoreStartRootViaOpenFolder();
			} catch (err2) {
				problems.restoreViaOpenFolder = String(err2);
			}
		}
		if (fs.existsSync(gateDir) && fs.readFileSync(editFile, 'utf8') !== ORIGINAL) fs.writeFileSync(editFile, ORIGINAL);
		if (Object.keys(problems).length > 0) report(REPORT, { gate: '48m-after-each', ...problems });
	});

	after(async () => {
		await restoreGateRecorder();
		fs.rmSync(gateDir, { recursive: true, force: true });
		if (otherDir) fs.rmSync(otherDir, { recursive: true, force: true });
		for (const name of fs.readdirSync(startRoot)) {
			if (name.startsWith('req48m-')) fs.rmSync(path.join(startRoot, name), { recursive: true, force: true });
		}
	});

	it('gate m-1: Cancel at the single ask → root, edits and the file on disk unchanged; the CLI exited while the ask was still open', async () => {
		await openFileAndEdit();
		await clearGateLogs();
		// The ask is held open until the spec releases it (holdFirst).
		await installAskStub([CANCEL], { holdFirst: true });
		try {
			const cli = await cliSwitchRoot(otherDir);
			await waitForAsks(1, 'the window never asked about the unsaved edits');
			// 契約4: the CLI is answered once the URI and the listing check out, not
			// after the dialog — it has already exited while the ask is still
			// unanswered (held by the stub; nothing has released it yet).
			const whileOpen = await readAskStub();
			const rootWhileOpen = await snapshotRoot();
			report(REPORT, { gate: '48m-1-while-open', cli, asks: whileOpen, root: rootWhileOpen });
			expect(cli.code).toBe(0);
			expect(whileOpen.length).toBe(1);
			expect(whileOpen[0]!.held).toBe(true);
			expect(whileOpen[0]!.released).toBe(false);
			expect(isStartRoot(rootWhileOpen)).toBe(true);

			// Now "click" Cancel.
			expect(await releaseHeldAsk()).toBe(true);
			// Give a wrongly continuing flow time to show (a switch would land here).
			await browser.pause(1_500);
			const asks = await readAskStub();
			const rec = await readGateRecord();
			const view = await editorView();
			const root = await snapshotRoot();
			const onDisk = fs.readFileSync(editFile, 'utf8');
			await shot('req48m-gate1-after-cancel');
			report(REPORT, { gate: '48m-1-cancel', cli, asks, ipc: rec.ipc, dialogs: rec.dialogs, root, editing: view.editing, textKept: view.text === ORIGINAL + EDIT, onDiskUnchanged: onDisk === ORIGINAL });

			expect(asks.map((a) => a.message)).toEqual([SAVE_MESSAGE]);
			expect(asks[0]!.title).toBe(SAVE_TITLE);
			expect(asks[0]!.buttons).toEqual(SAVE_BUTTONS);
			expect(asks[0]!.released).toBe(true);
			expect(asks[0]!.autoReleased).toBe(false);
			expect(isStartRoot(root)).toBe(true);
			expect(view.editing).toBe(true);
			expect(view.text).toBe(ORIGINAL + EDIT);
			expect(onDisk).toBe(ORIGINAL);
			// Nothing was switched or saved behind the dialog (契約1・3).
			expect(rec.ipc).not.toContain('switch_root_confirmed');
			expect(rec.ipc).not.toContain('save_document');
			expect(rec.ipc).not.toContain('set_root');
			expect(rec.dialogs).toEqual([]);

			// 契約3 observed from outside: the backend still watches start-root — a
			// file added there shows up in this tree (it would not if the watch had
			// moved to the other folder).
			const probe = path.join(startRoot, 'req48m-after-cancel-probe.md');
			fs.writeFileSync(probe, '# probe\n');
			try {
				await waitForExplorerRow(uri(probe), { timeout: 15_000 });
			} finally {
				fs.rmSync(probe, { force: true });
			}
			expect((await rowUris()).every((u) => [...START_ROOT_URIS].some((r) => u.startsWith(`${r}/`)))).toBe(true);
		} finally {
			await removeAskStub();
		}
		await revertEditAndLeaveEditor();
		expect(fs.readFileSync(editFile, 'utf8')).toBe(ORIGINAL);
	});

	it("gate m-2: Don't Save → the root switches, the edit is dropped, the file on disk unchanged", async () => {
		await openFileAndEdit();
		await clearGateLogs();
		await installAskStub([DONT_SAVE]);
		try {
			const cli = await cliSwitchRoot(otherDir);
			await waitForAsks(1, 'the ask (Save / Don’t Save / Cancel) never came');
			await waitForRoot(uri(otherDir), 'the root did not switch after Don’t Save');
			await waitForExplorerRow(uri(path.join(otherDir, 'other-root.md')), { timeout: 15_000 });
			const asks = await readAskStub();
			const rec = await readGateRecord();
			const view = await editorView();
			const onDisk = fs.readFileSync(editFile, 'utf8');
			await shot('req48m-gate2-after-dont-save');
			report(REPORT, { gate: '48m-2-dont-save', cli, asks, ipc: rec.ipc, dialogs: rec.dialogs, root: await snapshotRoot(), emptyState: view.emptyState, onDiskUnchanged: onDisk === ORIGINAL });

			expect(cli.code).toBe(0);
			expect(asks.map((a) => a.message)).toEqual([SAVE_MESSAGE]);
			expect(asks[0]!.title).toBe(SAVE_TITLE);
			expect(asks[0]!.buttons).toEqual(SAVE_BUTTONS);
			expect(asks.every((a) => a.scripted)).toBe(true);
			expect(onDisk).toBe(ORIGINAL);
			expect(rec.ipc).not.toContain('save_document');
			expect(rec.ipc).toContain('switch_root_confirmed');
			// The document was under the old root, so it is closed with the edit.
			expect(view.editing).toBe(false);
			expect(view.emptyState).toBe(true);
			expect((await rowUris()).every((u) => u.startsWith(`${uri(otherDir)}/`))).toBe(true);
			expect(rec.dialogs).toEqual([]);
		} finally {
			await removeAskStub();
		}
	});

	it('gate m-3: Save → the file is saved first, then the root switches', async () => {
		await openFileAndEdit();
		await clearGateLogs();
		await installAskStub([SAVE]);
		try {
			const cli = await cliSwitchRoot(otherDir);
			await waitForAsks(1, 'the ask (Save / Don’t Save / Cancel) never came');
			await waitForRoot(uri(otherDir), 'the root did not switch after Save');
			await browser.waitUntil(async () => fs.readFileSync(editFile, 'utf8') === ORIGINAL + EDIT, {
				timeout: 10_000,
				timeoutMsg: `Save did not write the edit (on disk now: ${JSON.stringify(fs.readFileSync(editFile, 'utf8'))})`,
			});
			const asks = await readAskStub();
			const rec = await readGateRecord();
			const view = await editorView();
			const saveAt = rec.ipc.indexOf('save_document');
			const switchAt = rec.ipc.indexOf('switch_root_confirmed');
			await shot('req48m-gate3-after-save');
			report(REPORT, { gate: '48m-3-save', cli, asks, ipc: rec.ipc, dialogs: rec.dialogs, root: await snapshotRoot(), saveAt, switchAt, onDisk: fs.readFileSync(editFile, 'utf8') });

			expect(cli.code).toBe(0);
			expect(asks.map((a) => a.message)).toEqual([SAVE_MESSAGE]);
			expect(asks[0]!.buttons).toEqual(SAVE_BUTTONS);
			expect(asks.every((a) => a.scripted)).toBe(true);
			expect(fs.readFileSync(editFile, 'utf8')).toBe(ORIGINAL + EDIT);
			// Save succeeded before the switch was asked for (契約1: 保存が成功してから切り替える).
			expect(saveAt).toBeGreaterThanOrEqual(0);
			expect(switchAt).toBeGreaterThan(saveAt);
			expect(view.editing).toBe(false);
			expect(view.emptyState).toBe(true);
			expect((await rowUris()).every((u) => u.startsWith(`${uri(otherDir)}/`))).toBe(true);
			expect(rec.dialogs).toEqual([]);
		} finally {
			await removeAskStub();
		}
		// afterEach brings the window back to start-root and the fixture back to ORIGINAL.
	});

	it('gate m-3b: Save with a failing save → one "Could not save" notice, no switch, edits and file kept', async () => {
		await openFileAndEdit();
		await clearGateLogs();
		// The save is refused at the IPC layer (the recorder answers `save_document`
		// with an error before it reaches Rust), so `saveDocument` rejects.
		await setIpcBlock(['save_document']);
		await installAskStub([SAVE]);
		try {
			const cli = await cliSwitchRoot(otherDir);
			await waitForAsks(1, 'the ask (Save / Don’t Save / Cancel) never came');
			// The failure notice is `alert('Could not save: …')` (src/lib/edit-guard.ts),
			// which on this page is the gate recorder's `window.alert` stub — so it
			// lands in `dialogs`, not in the ask stub (`plugin:dialog|message`).
			await browser.waitUntil(async () => (await readGateRecord()).dialogs.length > 0, {
				timeout: 10_000,
				timeoutMsg: `no "Could not save" notice after the failed save (asks: ${JSON.stringify(await readAskStub())})`,
			});
			// Give a wrongly continuing flow time to show (a switch would land here).
			await browser.pause(1_500);
			const asks = await readAskStub();
			const rec = await readGateRecord();
			const view = await editorView();
			const root = await snapshotRoot();
			const onDisk = fs.readFileSync(editFile, 'utf8');
			await shot('req48m-gate3b-save-failed');
			report(REPORT, { gate: '48m-3b-save-failed', cli, asks, ipc: rec.ipc, dialogs: rec.dialogs, root, editing: view.editing, textKept: view.text === ORIGINAL + EDIT, onDiskUnchanged: onDisk === ORIGINAL });

			expect(cli.code).toBe(0);
			expect(asks.map((a) => a.message)).toEqual([SAVE_MESSAGE]);
			expect(asks.every((a) => a.scripted)).toBe(true);
			// Exactly one notice, worded as the product does; it is not one of the asks.
			expect(rec.dialogs.length).toBe(1);
			expect(rec.dialogs[0]!.startsWith('alert:Could not save: ')).toBe(true);
			expect(asks.some((a) => a.message.startsWith('Could not save'))).toBe(false);
			// The save was attempted and refused; the switch was never asked for (契約1).
			expect(rec.ipc).toContain('save_document');
			expect(rec.ipc).not.toContain('switch_root_confirmed');
			expect(rec.ipc).not.toContain('set_root');
			expect(isStartRoot(root)).toBe(true);
			expect(view.editing).toBe(true);
			expect(view.text).toBe(ORIGINAL + EDIT);
			expect(onDisk).toBe(ORIGINAL);
		} finally {
			await setIpcBlock([]);
			await removeAskStub();
		}
	});

	it('gate m-4: without unsaved edits the root switches at once and nothing is asked', async () => {
		await openFileForViewing();
		await clearGateLogs();
		// Scripted to Cancel: if an ask wrongly appears it is answered, recorded,
		// and the root stays — which the assertions below turn into a failure.
		await installAskStub([CANCEL]);
		try {
			const cli = await cliSwitchRoot(otherDir);
			await waitForRoot(uri(otherDir), 'the root did not switch without edits');
			await waitForExplorerRow(uri(path.join(otherDir, 'other-root.md')), { timeout: 15_000 });
			const asks = await readAskStub();
			const rec = await readGateRecord();
			const view = await editorView();
			await shot('req48m-gate4-no-edits');
			report(REPORT, { gate: '48m-4-no-edits', cli, asks, ipc: rec.ipc, dialogs: rec.dialogs, root: await snapshotRoot(), emptyState: view.emptyState });

			expect(cli.code).toBe(0);
			expect(cli.durationMs).toBeLessThan(5_000);
			expect(asks).toEqual([]);
			expect(rec.ipc).toContain('switch_root_confirmed');
			expect(rec.ipc).not.toContain('save_document');
			expect(view.emptyState).toBe(true);
			expect((await rowUris()).every((u) => u.startsWith(`${uri(otherDir)}/`))).toBe(true);
			expect(rec.dialogs).toEqual([]);
			expect(fs.readFileSync(editFile, 'utf8')).toBe(ORIGINAL);
		} finally {
			await removeAskStub();
		}
	});
});
