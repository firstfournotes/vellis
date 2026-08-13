import { browser, expect } from '@wdio/globals';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression for issue #13's "explicit dup-launch coverage" subtask:
 * the second and third `vellis <path>` invocations must NOT spawn new
 * application processes — they must detect the running instance via
 * the per-user lock file (`$XDG_RUNTIME_DIR/vellis.lock`), send a
 * `Request::OpenPath` over the Unix socket, and exit cleanly. The
 * receiving (first) instance creates a new window in-process.
 *
 * The contract we're guarding:
 *   - subsequent IPC clients exit promptly (no zombie processes)
 *   - the first instance keeps handling requests after the first one
 *     (no "single shot" leak in the IPC handler)
 *   - each client spawn produces exactly one new in-process window
 *
 * Why this asserts via the backend `__test_list_windows` instead of
 * `browser.getWindowHandles()`: see issue #22 — runtime-created
 * Webviews aren't reliably visible to the active WebDriver session.
 * The single-instance contract lives entirely in the backend (Unix
 * socket -> WindowManager registration), so reading WindowManager
 * directly tests the right layer without the WebDriver brittleness.
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const targetRoot = path.join(fixtureBase, 'target-root');

// Per-test fixture directories so we don't fight with #18 / #20 specs.
const dupRootA = path.join(fixtureBase, 'dup-launch-a');
const dupRootB = path.join(fixtureBase, 'dup-launch-b');

const binary =
	process.env.VELLIS_E2E_BINARY ??
	path.resolve(__dirname, '..', '..', '..', 'src-tauri', 'target', 'debug', 'vellis');

interface WindowSnapshot {
	label: string;
	root: string | null;
	initialPath: string | null;
	showMarks: boolean;
}

async function waitForAppMounted(): Promise<void> {
	await browser.waitUntil(
		async () =>
			browser.execute(
				() =>
					location.href !== 'about:blank' &&
					document.body.childElementCount > 0,
			),
		{
			timeout: 30_000,
			timeoutMsg: 'webview never navigated past about:blank',
		},
	);
}

async function listBackendWindows(): Promise<WindowSnapshot[]> {
	// `executeAsync` callback pattern — see explorer-resolves-dir-root
	// spec for the reasoning (tauri-webdriver `execute/sync` does not
	// unwrap Promises).
	return browser.executeAsync<WindowSnapshot[], []>((done) => {
		// @ts-expect-error — `__TAURI_INTERNALS__` is a runtime global.
		window.__TAURI_INTERNALS__.invoke('__test_list_windows')
			.then((result: WindowSnapshot[]) => done(result))
			.catch(() => done([]));
	});
}

async function ipcSpawn(target: string): Promise<{ code: number; durationMs: number }> {
	const t0 = Date.now();
	const child = spawn(binary, [target], {
		stdio: 'ignore',
		env: { ...process.env, RUST_LOG: 'warn' },
	});
	return new Promise((resolve, reject) => {
		child.once('exit', (code) => {
			resolve({ code: code ?? -1, durationMs: Date.now() - t0 });
		});
		child.once('error', reject);
		// Hard cap: a healthy IPC client returns within ~1s. Anything
		// past 10s means the second process is hanging, which is the
		// regression this spec exists to catch.
		setTimeout(() => {
			if (!child.killed) {
				child.kill('SIGKILL');
				reject(new Error('IPC client did not exit within 10s — single-instance contract broken'));
			}
		}, 10_000);
	});
}

describe('Single-instance IPC contract (#13)', () => {
	before(() => {
		fs.mkdirSync(dupRootA, { recursive: true });
		fs.mkdirSync(dupRootB, { recursive: true });
		fs.writeFileSync(path.join(dupRootA, 'a.md'), '# A\n');
		fs.writeFileSync(path.join(dupRootB, 'b.md'), '# B\n');
	});

	after(() => {
		fs.rmSync(dupRootA, { recursive: true, force: true });
		fs.rmSync(dupRootB, { recursive: true, force: true });
		// Reset start-root / target-root for any specs that follow,
		// since wdio test order isn't guaranteed and earlier specs
		// (#18) already restore start-root via their own after().
		fs.rmSync(startRoot, { recursive: true, force: true });
		fs.mkdirSync(startRoot, { recursive: true });
		fs.writeFileSync(path.join(startRoot, 'start-doc.md'), '# Start\n');
		fs.rmSync(targetRoot, { recursive: true, force: true });
		fs.mkdirSync(path.join(targetRoot, 'nested'), { recursive: true });
		fs.writeFileSync(path.join(targetRoot, 'child-doc.md'), '# Target child\n');
	});

	it('routes successive IPC client invocations to the running instance', async () => {
		await waitForAppMounted();

		// Earlier specs (#18 / #20) may have left extra windows around;
		// wdio runs every spec in a single browser session and we don't
		// own those windows' lifecycle. Lock in whatever the count is
		// now and assert relative deltas.
		const before = await listBackendWindows();
		const baseCount = before.length;
		expect(baseCount).toBeGreaterThanOrEqual(1);

		// First IPC client: opens dupRootA in a new window.
		const first = await ipcSpawn(dupRootA);
		expect(first.code).toBe(0);
		// 5s is generous: locally the round-trip is sub-100ms; the cap
		// is here so a 30s hang shows up as a clear failure rather
		// than a vague timeout.
		expect(first.durationMs).toBeLessThan(5_000);

		await browser.waitUntil(
			async () => (await listBackendWindows()).length === baseCount + 1,
			{ timeout: 15_000, timeoutMsg: 'first IPC OpenPath did not register a window' },
		);

		const afterFirst = await listBackendWindows();
		expect(afterFirst.some((w) => w.root === `file://${dupRootA}`)).toBe(true);

		// Second IPC client: opens dupRootB in yet another window —
		// proves the IPC handler keeps running after handling one
		// request, not just on first launch.
		const second = await ipcSpawn(dupRootB);
		expect(second.code).toBe(0);
		expect(second.durationMs).toBeLessThan(5_000);

		await browser.waitUntil(
			async () => (await listBackendWindows()).length === baseCount + 2,
			{ timeout: 15_000, timeoutMsg: 'second IPC OpenPath did not register a window' },
		);

		const afterSecond = await listBackendWindows();
		expect(afterSecond.some((w) => w.root === `file://${dupRootB}`)).toBe(true);
	});
});
