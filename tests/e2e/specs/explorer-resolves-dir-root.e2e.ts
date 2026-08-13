import { browser, expect } from '@wdio/globals';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM doesn't expose `__dirname`; reconstruct it from `import.meta.url`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression for issue #20 / MR !34: when an existing Vellis instance
 * receives `vellis <absolute-path-to-dir>` over the IPC `OpenPath`
 * channel, the new window's root must be that directory — not the
 * parent.
 *
 * Before the fix, `handle_open_path` always treated the URI as a file
 * and made `derive_root(uri)` (one segment up) the new root, so the
 * Explorer showed siblings of what the user typed and `.vellis/`
 * was created next to the directory rather than under it.
 *
 * Why this asserts via the backend `__test_list_windows` command instead
 * of WebDriver's `getWindowHandles` + `switchToWindow` flow: issue #22
 * documents that the WebDriver session does not reliably register new
 * windows created at runtime via `WebviewWindowBuilder` — the spec has
 * no way to switch into the new Webview to read its Explorer DOM. The
 * actual bug being guarded (root resolution from an IPC OpenPath) is
 * a backend concern: it shows up as `WindowArgs.root` on the new
 * `WindowState` registered in `WindowManager`. Reading the backend
 * directly bypasses the brittle WebDriver round-trip.
 *
 * Test flow:
 *   1. `scripts/e2e.sh` pre-creates `fixtures/{start,target}-root` and
 *      starts tauri-webdriver with cwd = start-root. The first window
 *      inherits start-root as its root via `init_window`'s
 *      `current_dir()` fallback.
 *   2. The test spawns the same binary with the absolute path of
 *      target-root. The second invocation probes the running socket
 *      and sends `Request::OpenPath`.
 *   3. The running instance creates a second WindowState in
 *      WindowManager, then a Webview for it.
 *   4. Read backend window list, assert: a window exists with root =
 *      file://<targetRoot>; no window has root = file://<fixtureBase>.
 *      Also assert `.vellis/` did not leak into fixtureBase.
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const targetRoot = path.join(fixtureBase, 'target-root');
const binary =
	process.env.VELLIS_E2E_BINARY ??
	path.resolve(__dirname, '..', '..', '..', 'src-tauri', 'target', 'debug', 'vellis');

const expectedStartEntries = ['start-doc.md'];

interface WindowSnapshot {
	label: string;
	root: string | null;
	initialPath: string | null;
	showMarks: boolean;
}

async function readExplorerEntries(): Promise<string[]> {
	return browser.$$('.explorer-item .name').map((el) => el.getText());
}

async function waitForEntriesToInclude(...names: string[]): Promise<void> {
	await browser.waitUntil(
		async () => {
			const seen = await readExplorerEntries();
			return names.every((n) => seen.includes(n));
		},
		{
			timeout: 15_000,
			timeoutMsg: `expected explorer entries to include ${names.join(', ')}`,
		},
	);
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
	// `__TAURI_INTERNALS__.invoke` is the runtime IPC bridge in Tauri 2.
	// Returns whatever `__test_list_windows` (defined in
	// `src-tauri/src/commands/test_helpers.rs`, gated on the `webdriver`
	// feature) emits — read straight off `WindowManager`'s in-memory map.
	//
	// Use the `executeAsync` callback pattern: tauri-webdriver's
	// `execute/sync` endpoint does not unwrap Promises (returns
	// "unsupported type" for async functions), so we explicitly
	// resolve the invoke Promise and call `done` with the value.
	return browser.executeAsync<WindowSnapshot[], []>((done) => {
		// @ts-expect-error — Tauri's `__TAURI_INTERNALS__` is not typed in
		// the WebView's standard lib; only present at runtime.
		window.__TAURI_INTERNALS__.invoke('__test_list_windows')
			.then((result: WindowSnapshot[]) => done(result))
			.catch(() => done([]));
	});
}

describe('IPC OpenPath dir routing (#20)', () => {
	// Fixtures + the launcher cwd (= start-root) are owned by
	// `scripts/e2e.sh`. tauri-webdriver v0.1.1 ignores
	// `tauri:options.args`, so we cannot pass an initial path through
	// capabilities; setting cwd is what makes `init_window`'s
	// `current_dir()` fallback land on a known directory.

	it('records target-root (not its parent) as the new window root', async () => {
		await waitForAppMounted();

		// The first window inherits cwd = start-root from the harness, so
		// its UI Explorer lists start-root's children. Sanity check that
		// the harness is in the expected initial state before exercising
		// the IPC spawn.
		await waitForEntriesToInclude(...expectedStartEntries);

		const initialBackend = await listBackendWindows();
		expect(initialBackend.length).toBe(1);

		// Second invocation: the binary detects the running instance and
		// sends `Request::OpenPath { uri: file://<targetRoot> }` over the
		// IPC socket. The running instance creates a second window.
		const child = spawn(binary, [targetRoot], {
			stdio: 'ignore',
			env: { ...process.env, RUST_LOG: 'warn' },
		});
		await new Promise<void>((resolve, reject) => {
			child.once('exit', (code) => {
				if (code === 0) resolve();
				else reject(new Error(`vellis IPC client exited with code ${code}`));
			});
			child.once('error', reject);
		});

		// Wait for the backend `WindowManager` to reflect the new window.
		// Polling `__test_list_windows` is independent of WebDriver
		// (issue #22 makes `getWindowHandles` unreliable here).
		await browser.waitUntil(
			async () => (await listBackendWindows()).length === 2,
			{
				timeout: 15_000,
				timeoutMsg:
					'expected a second window in WindowManager after IPC OpenPath',
			},
		);

		const finalBackend = await listBackendWindows();
		const targetUri = `file://${targetRoot}`;

		// Positive: a window exists whose root URI equals target-root.
		// This is the IPC OpenPath -> WindowArgs.root contract that issue
		// #20 broke (root was being silently shifted up one level).
		const newWindow = finalBackend.find((w) => w.root === targetUri);
		expect(newWindow).toBeDefined();
		expect(newWindow?.initialPath).toBeFalsy();

		// Negative: no window must have its root set to fixtureBase
		// (one level above target-root). That was exactly the buggy
		// behaviour before MR !34.
		const fixtureBaseUri = `file://${fixtureBase}`;
		expect(finalBackend.some((w) => w.root === fixtureBaseUri)).toBe(false);

		// `.vellis/` must not have leaked into the parent fixtureBase.
		// (`AnnotationStore` writes there on first mark / inbox; even if
		// no mark was made we want to fail loud if the file ever appears.)
		const parentVellis = path.join(fixtureBase, '.vellis');
		expect(fs.existsSync(parentVellis)).toBe(false);
	});

	// Cleanup is owned by `wdio.conf.ts::onComplete`.
});
