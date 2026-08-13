import { browser, expect } from '@wdio/globals';

/**
 * Regression for issue #16: the default window size must be wide
 * enough that the Markdown viewer (Explorer ~250px sidebar + body
 * targeting GitHub's ~960px) doesn't wrap on a fresh first launch.
 *
 * The configured default lives in `src-tauri/tauri.conf.json` and is
 * mirrored in `src-tauri/src/ipc/handler.rs` for IPC-spawned windows.
 * Both paths should land at 1280×800.
 *
 * The test asserts the WebView's `innerWidth` / `innerHeight` rather
 * than the outer window size: WKWebView's inner size matches the
 * `inner_size(...)` Tauri sets on the WebviewWindowBuilder, while
 * the outer dimensions vary by OS chrome and aren't worth pinning.
 */

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

describe('Default window size (#16)', () => {
	it('opens noticeably larger than the legacy 800×600 default', async () => {
		await waitForAppMounted();

		const m = await browser.execute(() => ({
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			availWidth: screen.availWidth,
			availHeight: screen.availHeight,
		}));

		// The configured default is 1280×800. macOS clamps the window
		// to the available screen rect, so we can't assert the literal
		// configured value — on a 1280×800 display the WebView's
		// inner height ends up around 768 once the title bar is
		// subtracted. Assert against the smaller of the configured
		// value and what the screen can actually provide. If a future
		// regression drops the config back to 800×600 (the legacy
		// default) this still fails on any normal-sized display.
		const expectedW = Math.min(1280, m.availWidth);
		const expectedH = Math.min(800, m.availHeight) - 32; // 32px slack for window chrome

		expect(m.innerWidth).toBeGreaterThanOrEqual(expectedW);
		expect(m.innerHeight).toBeGreaterThanOrEqual(expectedH);

		// Belt-and-suspenders: the new default must be strictly
		// bigger than the legacy 800×600 in at least one axis. This
		// catches a literal `800 / 600` revert even on a tiny screen.
		expect(m.innerWidth > 800 || m.innerHeight > 600).toBe(true);
	});
});
