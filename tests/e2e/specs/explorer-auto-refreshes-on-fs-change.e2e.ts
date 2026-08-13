import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression for issue #18: when a file or directory is added / removed
 * inside the Explorer's root, the Webview must update without any user
 * input. The frontend already had a `directory_changed` listener — the
 * backend was missing the corresponding emitter.
 *
 * Test flow:
 *   1. `scripts/e2e.sh` launches the binary with cwd = `start-root`,
 *      so `init_window` resolves the Explorer root to `start-root`.
 *   2. The harness pre-creates `start-root/start-doc.md`.
 *   3. The spec asserts that file is visible.
 *   4. The spec creates a NEW file (`fresh-doc.md`) directly on disk.
 *   5. Assert: the Explorer eventually lists `fresh-doc.md` without
 *      any UI interaction.
 *   6. The spec deletes `start-doc.md`.
 *   7. Assert: the Explorer eventually drops it.
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');

async function readExplorerEntries(): Promise<string[]> {
	return browser.$$('.explorer-item .name').map((el) => el.getText());
}

async function waitForEntriesEqual(expected: string[]): Promise<void> {
	await browser.waitUntil(
		async () => {
			const seen = (await readExplorerEntries()).slice().sort();
			const want = [...expected].sort();
			return JSON.stringify(seen) === JSON.stringify(want);
		},
		{
			timeout: 10_000,
			timeoutMsg: `expected explorer entries to equal ${expected.sort().join(', ')}`,
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

describe('Explorer auto-refresh on fs change (#18)', () => {
	// This spec mutates `start-root` (adds + removes files). Restore
	// the canonical fixture state at the end so subsequent specs that
	// expect `start-root` to contain just `start-doc.md` start from
	// a known state.
	after(() => {
		fs.rmSync(startRoot, { recursive: true, force: true });
		fs.mkdirSync(startRoot, { recursive: true });
		fs.writeFileSync(path.join(startRoot, 'start-doc.md'), '# Start\n');
	});

	it('reflects directory mutations without UI interaction', async () => {
		await waitForAppMounted();

		// The harness already created start-doc.md inside start-root.
		await waitForEntriesEqual(['start-doc.md']);

		// Add a file. `notify` should fire Create; the backend re-lists
		// and emits `directory_changed`; the frontend listener updates
		// `windowState.entries`.
		const newFile = path.join(startRoot, 'fresh-doc.md');
		fs.writeFileSync(newFile, '# Fresh\n');
		await waitForEntriesEqual(['start-doc.md', 'fresh-doc.md']);

		// Remove the original file. Should drop from the listing too.
		fs.rmSync(path.join(startRoot, 'start-doc.md'));
		await waitForEntriesEqual(['fresh-doc.md']);
	});
});
