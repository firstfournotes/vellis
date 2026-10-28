import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertIpcInterceptionWorks,
	clickExplorerRow,
	emitMenu,
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
 * The four "machine-drivable" human gates of PR #736 (left pane fixes), driven
 * on the webdriver build:
 *
 *  9a  (req-09 追補a, Issue #381) drag the Explorer to 400px, shrink the window
 *      so the pane is clamped to 50% of it, widen the window again: the pane
 *      comes back to 400 and the stored width (`vellis.explorer-width`) was
 *      never overwritten by the clamp.
 *  19b (req-19 追補b, Issue #417) the tree's right-click menu closes when the
 *      tree scrolls.
 *  60e (req-60 追補e, Issue #572) Go to while the Find in Folder panel is open:
 *      a file / a folder inside the root closes the panel and the row is
 *      selected and inside the tree's viewport; a path that does not exist
 *      leaves the panel open.
 *  64g (req-64 追補g, Issue #589) dragging the Recent Files divider past its
 *      maximum and over the tree keeps `cursor: ns-resize` everywhere in the
 *      tree, including over the ↑ button when it is disabled (reviewer P3-2).
 *
 * What a machine cannot judge here:
 *  - the OS cursor itself. WebDriver and the DOM expose only the *computed*
 *    `cursor` of the element under the pointer (`getComputedStyle(
 *    document.elementFromPoint(x, y)).cursor`); that is what the window
 *    system asks WebKit for, so it is the value that decides what the user
 *    sees, but the arrow on the screen is not captured.
 *  - a real trackpad scroll / a real pointer drag. The plugin only
 *    synthesises JS events, so the tree is scrolled by `scrollTop` and the
 *    dividers are dragged with synthetic `PointerEvent`s dispatched to the
 *    handle (the product's handlers call `setPointerCapture`, which is wrapped
 *    so a synthetic pointer id cannot abort the drag with NotFoundError).
 *
 * The display may be off while CI runs (req-69 追補a, #745): WKWebView then
 * runs no rendering updates, and `scroll` / `resize` events (and
 * `requestAnimationFrame`) are delivered from those updates. Every wait on
 * such an event is capped at 2 s; when the event did not arrive at all, the
 * same event is dispatched synthetically and `synthetic: true` is recorded,
 * so the product's reaction is still checked while the stall is visible in
 * the report. Layout reads work with the display off.
 *
 * Fixture: `start-root/bundle736-gate/` with 60 Markdown files (tall tree),
 * one empty folder (Go to selects the folder row itself when it has no
 * openable file, requirement #60 behaviour table 3). Removed in `after()`.
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const gateDir = path.join(startRoot, 'bundle736-gate');
const emptyDir = path.join(gateDir, 'zz-empty-dir');
const REPORT = 'bundle736-report.jsonl';
const FILE_COUNT = 60;
const fileName = (i: number) => `f-${String(i).padStart(3, '0')}.md`;
const uri = (p: string) => `file://${p}`;

const EXPLORER_WIDTH_KEY = 'vellis.explorer-width'; // src/lib/pane-resize.ts
const RECENT_HEIGHT_KEY = 'vellis.recent-files-height'; // src/lib/recent-files-section.ts
const RECENT_EXPANDED_KEY = 'vellis.recent-files-expanded';
const MIN_TREE_HEIGHT = 100; // src/lib/recent-files-section.ts MIN_TREE_HEIGHT
const GO_TO_NOT_FOUND = 'File or folder not found'; // src/lib/go-to-path.ts

function buildFixture(): void {
	fs.rmSync(gateDir, { recursive: true, force: true });
	fs.mkdirSync(emptyDir, { recursive: true });
	for (let i = 0; i < FILE_COUNT; i++) {
		fs.writeFileSync(path.join(gateDir, fileName(i)), `# bundle736 ${i}\n\nrow ${i}\n`);
	}
}

// --- in-page instrumentation ------------------------------------------------

interface Probe {
	events: { scroll: number; resize: number };
	captureThrew: string[];
	originals: {
		set: typeof Element.prototype.setPointerCapture;
		release: typeof Element.prototype.releasePointerCapture;
	};
	onScroll: (e: Event) => void;
	onResize: () => void;
}

/**
 * Count `scroll` (capture, so the tree's own scroll is seen) and `resize`
 * events, and keep `setPointerCapture` / `releasePointerCapture` from throwing
 * on a synthetic pointer id (recorded, not hidden). Idempotent.
 */
async function installProbe(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __b736?: Probe };
		if (w.__b736) return;
		const proto = Element.prototype;
		const probe: Probe = {
			events: { scroll: 0, resize: 0 },
			captureThrew: [],
			originals: { set: proto.setPointerCapture, release: proto.releasePointerCapture },
			onScroll: () => {
				probe.events.scroll += 1;
			},
			onResize: () => {
				probe.events.resize += 1;
			},
		};
		w.__b736 = probe;
		window.addEventListener('scroll', probe.onScroll, true);
		window.addEventListener('resize', probe.onResize);
		proto.setPointerCapture = function (this: Element, id: number) {
			try {
				probe.originals.set.call(this, id);
			} catch (e) {
				probe.captureThrew.push(`set:${String(e)}`);
			}
		};
		proto.releasePointerCapture = function (this: Element, id: number) {
			try {
				probe.originals.release.call(this, id);
			} catch (e) {
				probe.captureThrew.push(`release:${String(e)}`);
			}
		};
	});
}

async function removeProbe(): Promise<string[]> {
	return browser.execute(() => {
		const w = window as unknown as { __b736?: Probe };
		const p = w.__b736;
		if (!p) return [];
		window.removeEventListener('scroll', p.onScroll, true);
		window.removeEventListener('resize', p.onResize);
		Element.prototype.setPointerCapture = p.originals.set;
		Element.prototype.releasePointerCapture = p.originals.release;
		delete w.__b736;
		return [...p.captureThrew];
	});
}

async function resetEvents(): Promise<void> {
	await browser.execute(() => {
		const p = (window as unknown as { __b736?: Probe }).__b736;
		if (p) p.events = { scroll: 0, resize: 0 };
	});
}

async function eventCount(kind: 'scroll' | 'resize'): Promise<number> {
	return browser.execute((k) => (window as unknown as { __b736?: Probe }).__b736?.events[k] ?? -1, kind);
}

/**
 * Does WKWebView run rendering updates right now? `requestAnimationFrame` is
 * waited for at most 2 s (req-69 追補a). Only recorded; nothing is decided
 * on it except the Recent Files height check (its upper bound comes from a
 * `bind:clientHeight`, i.e. a ResizeObserver, which is delivered by the same
 * rendering updates).
 */
async function framesStalled(): Promise<boolean> {
	return browser.executeAsync<boolean, []>((done) => {
		const stall = setTimeout(() => done(true), 2_000);
		requestAnimationFrame(() => {
			clearTimeout(stall);
			done(false);
		});
	});
}

interface EffectOutcome {
	ok: boolean;
	/** The real event never arrived within 2 s and the same event was dispatched from the spec. */
	synthetic: boolean;
	/** Real events of that kind seen before giving up / before synthesising. */
	eventsSeen: number;
	ms: number;
}

/**
 * Wait up to 2 s for `check`; if it does not hold and *no* real `kind` event
 * was observed in that time (display off), dispatch it synthetically and wait
 * up to 2 s more. If the event was observed but `check` still fails, that is
 * the product not reacting: returned as `ok: false, synthetic: false`.
 */
async function waitForEffect(
	kind: 'scroll' | 'resize',
	check: () => Promise<boolean>,
	synthesize: () => Promise<void>,
): Promise<EffectOutcome> {
	const t0 = Date.now();
	while (Date.now() - t0 < 2_000) {
		if (await check()) return { ok: true, synthetic: false, eventsSeen: await eventCount(kind), ms: Date.now() - t0 };
		await browser.pause(100);
	}
	const seen = await eventCount(kind);
	if (seen > 0) return { ok: false, synthetic: false, eventsSeen: seen, ms: Date.now() - t0 };
	await synthesize();
	const t1 = Date.now();
	while (Date.now() - t1 < 2_000) {
		if (await check()) return { ok: true, synthetic: true, eventsSeen: seen, ms: Date.now() - t0 };
		await browser.pause(100);
	}
	return { ok: false, synthetic: true, eventsSeen: seen, ms: Date.now() - t0 };
}

// --- pointer / DOM helpers --------------------------------------------------

type PointerKind = 'pointerdown' | 'pointermove' | 'pointerup';

/** Dispatch a mouse `PointerEvent` (pointer id 1 = WebKit's always-active mouse pointer) to `selector`. */
async function pointer(selector: string, kind: PointerKind, clientX: number, clientY: number): Promise<void> {
	const ok = await browser.execute(
		(sel, k, x, y) => {
			const el = document.querySelector<HTMLElement>(sel);
			if (!el) return false;
			el.dispatchEvent(
				new PointerEvent(k, {
					bubbles: true,
					cancelable: true,
					composed: true,
					pointerId: 1,
					pointerType: 'mouse',
					isPrimary: true,
					button: 0,
					buttons: k === 'pointerup' ? 0 : 1,
					clientX: x,
					clientY: y,
				}),
			);
			return true;
		},
		selector,
		kind,
		clientX,
		clientY,
	);
	if (!ok) throw new Error(`${selector} is not in the DOM (${kind})`);
}

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

async function rectOf(selector: string): Promise<Rect | null> {
	return browser.execute((sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	}, selector);
}

async function explorerWidth(): Promise<number | null> {
	return (await rectOf('aside.explorer'))?.width ?? null;
}

async function storageGet(key: string): Promise<string | null> {
	return browser.execute((k) => {
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	}, key);
}

async function storageRestore(saved: Record<string, string | null>): Promise<void> {
	await browser.execute((s) => {
		for (const [k, v] of Object.entries(s)) {
			try {
				if (v === null) localStorage.removeItem(k);
				else localStorage.setItem(k, v);
			} catch {
				// storage unavailable: nothing was written either
			}
		}
	}, saved);
}

async function rowClasses(u: string): Promise<string[] | null> {
	return browser.execute(
		(target) =>
			Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find((r) => r.title === target)
				?.classList.value.split(/\s+/) ?? null,
		u,
	);
}

interface RowVisibility {
	present: boolean;
	visible: boolean;
	top?: number;
	bottom?: number;
	listTop?: number;
	listBottom?: number;
}

/** Is the row inside the visible part of `nav.explorer-list` (same test as req70-symlink-gate)? */
async function rowVisible(u: string): Promise<RowVisibility> {
	return browser.execute((target) => {
		const list = document.querySelector('nav.explorer-list');
		const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find((r) => r.title === target);
		if (!list || !row) return { present: false, visible: false };
		const l = list.getBoundingClientRect();
		const r = row.getBoundingClientRect();
		return {
			present: true,
			visible: r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5,
			top: r.top,
			bottom: r.bottom,
			listTop: l.top,
			listBottom: l.bottom,
		};
	}, u);
}

async function exists(selector: string): Promise<boolean> {
	return browser.execute((sel) => !!document.querySelector(sel), selector);
}

/** The Explorer (not the Find in Folder panel) is in the left pane. */
async function ensureExplorerVisible(): Promise<void> {
	if (await exists('.find-in-folder-pane')) {
		await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="find-in-folder-close"]')?.click());
	}
	await browser.waitUntil(async () => exists('aside.explorer'), {
		timeout: 5_000,
		timeoutMsg: 'the Explorer did not come back into the left pane',
	});
}

/** Expand `bundle736-gate` so its 60 rows are in the tree. */
async function ensureGateDirExpanded(): Promise<void> {
	const gateUri = uri(gateDir);
	await waitForExplorerRow(gateUri, { timeout: 15_000 });
	const hasChildren = await browser.execute(
		(u) => Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).some((r) => r.title.startsWith(`${u}/`)),
		gateUri,
	);
	if (!hasChildren) await clickExplorerRow(gateUri);
	await waitForExplorerRow(uri(path.join(gateDir, fileName(FILE_COUNT - 1))), { timeout: 15_000 });
}

async function closeGoToIfOpen(): Promise<void> {
	await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="go-to-close"]')?.click());
}

/** Screenshot that must not fail the gate when the display is off. */
async function safeShot(name: string): Promise<string | null> {
	try {
		return await shot(name);
	} catch (e) {
		report(REPORT, { gate: 'shot-failed', name, error: String(e) });
		return null;
	}
}

// --- the gates ---------------------------------------------------------------

describe('PR #736 left pane human gates (req 9 追補a / 19 追補b / 60 追補e / 64 追補g)', () => {
	let stalledAtStart = false;
	let savedStorage: Record<string, string | null> = {};

	before(async () => {
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await installProbe();
		for (const k of [EXPLORER_WIDTH_KEY, RECENT_HEIGHT_KEY, RECENT_EXPANDED_KEY]) savedStorage[k] = await storageGet(k);
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		await ensureExplorerVisible();
		buildFixture();
		await waitForExplorerRow(uri(gateDir), { timeout: 30_000, nudgeDir: startRoot, nudgePrefix: 'bundle736' });
		await ensureGateDirExpanded();
		stalledAtStart = await framesStalled();
		const env = await browser.execute(() => ({
			dpr: window.devicePixelRatio,
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			visibility: document.visibilityState,
		}));
		report(REPORT, { gate: 'env', framesStalled: stalledAtStart, ...env, savedStorage });
	});

	after(async () => {
		await closeGoToIfOpen();
		await ensureExplorerVisible().catch(() => undefined);
		await storageRestore(savedStorage);
		const threw = await removeProbe();
		const rec = await readGateRecord();
		report(REPORT, { gate: 'teardown', pointerCaptureThrew: threw, dialogs: rec.dialogs });
		await restoreGateRecorder();
		fs.rmSync(gateDir, { recursive: true, force: true });
		for (const name of fs.readdirSync(startRoot)) {
			if (name.startsWith('bundle736-nudge-')) fs.rmSync(path.join(startRoot, name), { force: true });
		}
	});

	it('gate 19b: the tree context menu closes when the tree scrolls (Issue #417)', async () => {
		await ensureExplorerVisible();
		await ensureGateDirExpanded();
		const rowUri = uri(path.join(gateDir, fileName(10)));
		// A tall tree: the list has to be scrollable by more than we scroll it.
		const list = await browser.execute(() => {
			const l = document.querySelector<HTMLElement>('nav.explorer-list')!;
			l.scrollTop = 0;
			return { scrollHeight: l.scrollHeight, clientHeight: l.clientHeight };
		});
		expect(list.scrollHeight - list.clientHeight).toBeGreaterThan(200);
		await browser.execute((u) => {
			Array.from(document.querySelectorAll<HTMLElement>('.explorer-item'))
				.find((r) => r.title === u)
				?.scrollIntoView({ block: 'nearest' });
		}, rowUri);
		// Open the menu with a contextmenu event on the row (as req19a does).
		await browser.execute((u) => {
			const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find((r) => r.title === u)!;
			const r = row.getBoundingClientRect();
			row.dispatchEvent(
				new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.x + 20, clientY: r.y + r.height / 2 }),
			);
		}, rowUri);
		await browser.waitUntil(async () => exists('.context-menu'), { timeout: 5_000, timeoutMsg: 'context menu did not open' });
		const menuBefore = await rectOf('.context-menu');
		await safeShot('bundle736-19b-menu-open');

		// Scroll the tree's own scroll container (a wheel action would only
		// dispatch a WheelEvent and scroll nothing).
		await resetEvents();
		const scrollTopBefore = await browser.execute(() => document.querySelector<HTMLElement>('nav.explorer-list')!.scrollTop);
		await browser.execute(() => {
			document.querySelector<HTMLElement>('nav.explorer-list')!.scrollTop += 120;
		});
		const scrollTopAfter = await browser.execute(() => document.querySelector<HTMLElement>('nav.explorer-list')!.scrollTop);
		const outcome = await waitForEffect(
			'scroll',
			async () => !(await exists('.context-menu')),
			async () => {
				await browser.execute(() => {
					document.querySelector('nav.explorer-list')!.dispatchEvent(new Event('scroll'));
				});
			},
		);
		const menuAfter = await rectOf('.context-menu');
		report(REPORT, {
			gate: '19b',
			list,
			scrollTopBefore,
			scrollTopAfter,
			menuBefore,
			menuAfter,
			closed: menuAfter === null,
			...outcome,
		});
		await safeShot('bundle736-19b-after-scroll');
		expect(scrollTopAfter).toBeGreaterThan(scrollTopBefore);
		expect(outcome.ok).toBe(true);
		expect(menuAfter).toBeNull();
	});

	it('gate 9a: Explorer dragged to 400px, clamped while the window is narrow, back to 400px when widened; the stored width stays 400 (Issue #381)', async () => {
		await ensureExplorerVisible();
		const width0 = (await explorerWidth())!;
		const stored0 = await storageGet(EXPLORER_WIDTH_KEY);
		const divider = (await rectOf('.pane-divider'))!;
		const appBodyLeft = (await rectOf('.app-body'))!.x;
		const grabX = divider.x + divider.width / 2;
		const grabY = divider.y + Math.min(200, divider.height / 2);

		// Drag the divider to 400px from the left edge of .app-body (the
		// product measures the width from there).
		const dragTo = async (target: number) => {
			await pointer('.pane-divider', 'pointerdown', grabX, grabY);
			await pointer('.pane-divider', 'pointermove', appBodyLeft + target, grabY);
			await pointer('.pane-divider', 'pointerup', appBodyLeft + target, grabY);
			await browser.waitUntil(async () => Math.abs(((await explorerWidth()) ?? -1) - target) <= 1, {
				timeout: 3_000,
				timeoutMsg: `Explorer did not follow the drag to ${target}px (is ${await explorerWidth()})`,
			});
		};
		await dragTo(400);
		const afterDrag = { width: (await explorerWidth())!, stored: await storageGet(EXPLORER_WIDTH_KEY) };
		report(REPORT, { gate: '9a-drag', width0, stored0, ...afterDrag, captureThrew: await browser.execute(() => (window as unknown as { __b736?: Probe }).__b736?.captureThrew ?? []) });
		expect(Math.abs(afterDrag.width - 400)).toBeLessThanOrEqual(1);
		expect(afterDrag.stored).toBe('400');
		await safeShot('bundle736-9a-400px');

		// Shrink the window so 50% of it is below 400: a 600 CSS px wide
		// viewport clamps the pane to 300. The plugin's window rect is the
		// *outer* size in physical pixels, so convert through devicePixelRatio
		// and the current chrome (outer − inner).
		const rect0 = await browser.getWindowRect();
		const env = await browser.execute(() => ({ dpr: window.devicePixelRatio, innerWidth: window.innerWidth, innerHeight: window.innerHeight }));
		const chromeW = Math.max(0, rect0.width - Math.round(env.innerWidth * env.dpr));
		const narrowOuter = Math.round(600 * env.dpr) + chromeW;
		const expectClamp = (inner: number) => Math.max(200, Math.min(400, inner * 0.5));
		let narrow = { innerWidth: -1, width: -1, expected: -1, stored: null as string | null };
		let shrink: EffectOutcome = { ok: false, synthetic: false, eventsSeen: -1, ms: 0 };
		let wide = { innerWidth: -1, width: -1, stored: null as string | null };
		let widen: EffectOutcome = { ok: false, synthetic: false, eventsSeen: -1, ms: 0 };
		let bodyFailed = false;
		try {
			await resetEvents();
			const rectNarrow = await browser.setWindowRect(null, null, narrowOuter, rect0.height);
			await browser.waitUntil(async () => (await browser.execute(() => window.innerWidth)) <= 640, {
				timeout: 5_000,
				timeoutMsg: `window did not shrink (innerWidth ${await browser.execute(() => window.innerWidth)}, asked outer ${narrowOuter})`,
			});
			const innerNarrow = await browser.execute(() => window.innerWidth);
			shrink = await waitForEffect(
				'resize',
				async () => Math.abs(((await explorerWidth()) ?? -1) - expectClamp(innerNarrow)) <= 1,
				async () => {
					await browser.execute(() => window.dispatchEvent(new Event('resize')));
				},
			);
			narrow = { innerWidth: innerNarrow, width: (await explorerWidth())!, expected: expectClamp(innerNarrow), stored: await storageGet(EXPLORER_WIDTH_KEY) };
			report(REPORT, { gate: '9a-shrink', rect0, rectNarrow, chromeW, dpr: env.dpr, ...narrow, ...shrink });
			await safeShot('bundle736-9a-narrow');

			// Widen it again.
			await resetEvents();
			const rectBack = await browser.setWindowRect(rect0.x, rect0.y, rect0.width, rect0.height);
			await browser.waitUntil(async () => (await browser.execute(() => window.innerWidth)) >= env.innerWidth - 2, {
				timeout: 5_000,
				timeoutMsg: `window did not widen back (innerWidth ${await browser.execute(() => window.innerWidth)})`,
			});
			const innerWide = await browser.execute(() => window.innerWidth);
			widen = await waitForEffect(
				'resize',
				async () => Math.abs(((await explorerWidth()) ?? -1) - 400) <= 1,
				async () => {
					await browser.execute(() => window.dispatchEvent(new Event('resize')));
				},
			);
			wide = { innerWidth: innerWide, width: (await explorerWidth())!, stored: await storageGet(EXPLORER_WIDTH_KEY) };
			report(REPORT, { gate: '9a-widen', rectBack, ...wide, ...widen });
			await safeShot('bundle736-9a-widened');
		} catch (e) {
			bodyFailed = true;
			throw e;
		} finally {
			// Whatever happened above, the later gates (60e / 64g) must not run in
			// a 600px window with a 400px pane: put the window, the pane and the
			// storage back, each step on its own so one failure does not skip the
			// next. Restore failures are recorded and fail the gate only when the
			// body itself passed (a throw here would otherwise mask its error).
			const failures: string[] = [];
			const step = async (name: string, run: () => Promise<unknown>) => {
				try {
					await run();
				} catch (e) {
					failures.push(`${name}: ${String(e)}`);
				}
			};
			await step('window rect', () => browser.setWindowRect(rect0.x, rect0.y, rect0.width, rect0.height));
			await step('window width back', () =>
				browser.waitUntil(async () => (await browser.execute(() => window.innerWidth)) >= env.innerWidth - 2, { timeout: 5_000 }),
			);
			await step('resize applied', () =>
				waitForEffect(
					'resize',
					async () => Math.abs(((await explorerWidth()) ?? -1) - expectClamp(await browser.execute(() => window.innerWidth))) <= 1,
					async () => {
						await browser.execute(() => window.dispatchEvent(new Event('resize')));
					},
				),
			);
			await step('pane width', () => dragTo(width0));
			await step('storage', () => storageRestore({ [EXPLORER_WIDTH_KEY]: stored0 }));
			report(REPORT, { gate: '9a-restore', innerWidth: await browser.execute(() => window.innerWidth), width: await explorerWidth(), stored: await storageGet(EXPLORER_WIDTH_KEY), failures });
			if (failures.length > 0 && !bodyFailed) throw new Error(`gate 9a could not restore the window/pane: ${failures.join('; ')}`);
		}

		// Narrow: the pane followed the 50% ceiling, the stored width did not.
		expect(narrow.innerWidth).toBeLessThan(800);
		expect(shrink.ok).toBe(true);
		expect(Math.abs(narrow.width - narrow.expected)).toBeLessThanOrEqual(1);
		expect(narrow.width).toBeLessThan(400);
		expect(narrow.stored).toBe('400');
		// Wide again: back to the chosen 400 (the Issue #381 behaviour was to stay clamped).
		expect(widen.ok).toBe(true);
		expect(Math.abs(wide.width - 400)).toBeLessThanOrEqual(1);
		expect(wide.stored).toBe('400');
	});

	// Go to while the Find in Folder panel is open (req-60 追補e). A file and a
	// folder inside the root close the panel and the row is selected and in
	// view; a missing path leaves the panel open and shows the message.
	for (const c of [
		{ gate: '60e-file', target: path.join(gateDir, fileName(55)), exists: true },
		{ gate: '60e-folder', target: emptyDir, exists: true },
		{ gate: '60e-missing', target: path.join(gateDir, 'nowhere', 'missing.md'), exists: false },
	] as const) {
		it(`gate 60e: Go to ${c.exists ? 'an existing path' : 'a missing path'} with the Find in Folder panel open (${path.basename(c.target)}) (Issue #572)`, async () => {
			await closeGoToIfOpen();
			await ensureExplorerVisible();
			// Start with the gate folder collapsed and the tree at the top, so the
			// row has to be expanded into existence and scrolled to.
			await browser.execute((u) => {
				const rows = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item'));
				const row = rows.find((r) => r.title === u);
				if (row && rows.some((r) => r.title.startsWith(`${u}/`))) row.click();
				document.querySelector('nav.explorer-list')?.scrollTo(0, 0);
			}, uri(gateDir));
			await browser.waitUntil(async () => !(await rowVisible(uri(c.target))).present, {
				timeout: 5_000,
				timeoutMsg: 'bundle736-gate did not collapse before the jump',
			});
			// Open the panel (as req66 does) — the Explorer DOM is replaced by it.
			await emitMenu('menu_find_in_folder');
			await browser.waitUntil(async () => (await exists('.find-in-folder-pane')) && !(await exists('aside.explorer')), {
				timeout: 10_000,
				timeoutMsg: 'Find in Folder panel did not replace the Explorer',
			});
			// Go to (as req70 does).
			await emitMenu('menu_go_to');
			await browser.waitUntil(async () => exists('[data-testid="go-to-input"]'), {
				timeout: 5_000,
				timeoutMsg: 'Go to bar did not open on menu_go_to',
			});
			await browser.execute((p) => {
				const input = document.querySelector<HTMLInputElement>('[data-testid="go-to-input"]')!;
				input.value = p;
				input.dispatchEvent(new Event('input', { bubbles: true }));
				document.querySelector<HTMLButtonElement>('[data-testid="go-to-go"]')!.click();
			}, c.target);

			const targetUri = uri(c.target);
			if (c.exists) {
				await browser.waitUntil(
					async () => !(await exists('.find-in-folder-pane')) && ((await rowClasses(targetUri)) ?? []).includes('active'),
					{ timeout: 10_000, timeoutMsg: `panel still open or ${path.basename(c.target)} not selected after Go to` },
				);
			} else {
				await browser.waitUntil(
					async () =>
						(await browser.execute(() => document.querySelector('[data-testid="go-to-message"]')?.textContent?.trim() ?? '')) ===
						GO_TO_NOT_FOUND,
					{ timeout: 10_000, timeoutMsg: 'Go to did not report the missing path' },
				);
			}
			// Let any later state change show itself before measuring.
			await browser.pause(300);
			const state = {
				panelOpen: await exists('.find-in-folder-pane'),
				explorerShown: await exists('aside.explorer'),
				goToBarOpen: await exists('[data-testid="go-to-bar"]'),
				message: await browser.execute(() => document.querySelector('[data-testid="go-to-message"]')?.textContent?.trim() ?? ''),
				rowClasses: await rowClasses(targetUri),
				row: await rowVisible(targetUri),
				activeRow: await browser.execute(() => document.querySelector<HTMLElement>('.explorer-item.active')?.title ?? null),
			};
			report(REPORT, { gate: c.gate, target: c.target, ...state, dialogs: (await readGateRecord()).dialogs });
			await safeShot(`bundle736-${c.gate}`);
			if (c.exists) {
				expect(state.panelOpen).toBe(false);
				expect(state.explorerShown).toBe(true);
				expect(state.goToBarOpen).toBe(false);
				expect(state.rowClasses ?? []).toContain('active');
				expect(state.activeRow).toBe(targetUri);
				expect(state.row.visible).toBe(true);
			} else {
				expect(state.panelOpen).toBe(true);
				expect(state.explorerShown).toBe(false);
				expect(state.goToBarOpen).toBe(true);
				expect(state.message).toBe(GO_TO_NOT_FOUND);
				await closeGoToIfOpen();
				await ensureExplorerVisible();
			}
		});
	}

	it('gate 64g: dragging the Recent Files divider past its maximum keeps cursor: ns-resize over the tree, the ↑ button included (Issue #589)', async () => {
		await closeGoToIfOpen();
		await ensureExplorerVisible();
		await ensureGateDirExpanded();
		// Fill Recent Files with a few rows first.
		for (let i = 0; i < 3; i++) await clickExplorerRow(uri(path.join(gateDir, fileName(i))));
		await browser.waitUntil(
			async () => (await browser.execute(() => document.querySelectorAll('[data-testid="recent-files-row"]').length)) >= 3,
			{ timeout: 15_000, timeoutMsg: 'Recent Files did not list the three opened files' },
		);
		// The section must be expanded for the drag to resize it.
		const expanded = await browser.execute(
			() => document.querySelector('[data-testid="recent-files-header"]')?.getAttribute('aria-expanded') === 'true',
		);
		if (!expanded) {
			await browser.execute(() => document.querySelector<HTMLElement>('[data-testid="recent-files-header"]')!.click());
			await browser.waitUntil(
				async () =>
					browser.execute(() => document.querySelector('[data-testid="recent-files-header"]')?.getAttribute('aria-expanded') === 'true'),
				{ timeout: 3_000, timeoutMsg: 'Recent Files did not expand' },
			);
		}
		const before = await browser.execute(() => {
			const section = document.querySelector('[data-testid="recent-files"]')!.getBoundingClientRect();
			const header = document.querySelector('[data-testid="recent-files-header"]')!.getBoundingClientRect();
			const aside = document.querySelector('aside.explorer')!.getBoundingClientRect();
			return {
				sectionTop: section.top,
				sectionHeight: section.height,
				headerX: header.x + header.width / 2,
				headerY: header.y + header.height / 2,
				asideTop: aside.top,
				asideHeight: aside.height,
				paneHeight: document.querySelector('.explorer-pane')!.clientHeight,
				rows: document.querySelectorAll('[data-testid="recent-files-row"]').length,
			};
		});
		const stalledNow = await framesStalled();

		// Press on the header, move past the 3px threshold, then far above the
		// maximum (the top of the tree): the height clamps at pane − 100 and the
		// pointer is now over the tree.
		const HEADER = '[data-testid="recent-files-header"]';
		const farY = before.asideTop + 10;
		await pointer(HEADER, 'pointerdown', before.headerX, before.headerY);
		await pointer(HEADER, 'pointermove', before.headerX, before.headerY - 10);
		await pointer(HEADER, 'pointermove', before.headerX, farY);
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelector('.app')?.classList.contains('resizing-recent-files') ?? false),
			{ timeout: 3_000, timeoutMsg: '.app never got the resizing-recent-files class while dragging' },
		);

		interface CursorProbe {
			label: string;
			x: number;
			y: number;
			hit: string | null;
			insideTree: boolean;
			cursor: string | null;
			/** `user-select` (WebKit may only fill the `-webkit-` form), req-64 追補g decision (a). */
			userSelect: string | null;
			forcedDisabled?: boolean;
		}
		const during = await browser.execute(
			(pointerX, pointerY) => {
				const app = document.querySelector<HTMLElement>('.app')!;
				const section = document.querySelector('[data-testid="recent-files"]')!;
				const aside = document.querySelector('aside.explorer')!;
				const list = document.querySelector('nav.explorer-list')!.getBoundingClientRect();
				const centre = (el: Element | null) => {
					if (!el) return null;
					const r = el.getBoundingClientRect();
					return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
				};
				const describe = (el: Element | null) => (el ? `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')}` : null);
				const probe = (label: string, pt: { x: number; y: number } | null, forcedDisabled?: boolean): CursorProbe => {
					if (!pt) return { label, x: -1, y: -1, hit: null, insideTree: false, cursor: null, userSelect: null, forcedDisabled };
					const el = document.elementFromPoint(pt.x, pt.y);
					const cs = el ? getComputedStyle(el) : null;
					return {
						label,
						x: pt.x,
						y: pt.y,
						hit: describe(el),
						insideTree: !!el && aside.contains(el),
						cursor: cs ? cs.cursor : null,
						userSelect: cs ? cs.userSelect || (cs as unknown as { webkitUserSelect?: string }).webkitUserSelect || null : null,
						forcedDisabled,
					};
				};
				const firstVisibleRow =
					Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find((r) => {
						const b = r.getBoundingClientRect();
						return b.top >= list.top && b.bottom <= list.bottom;
					}) ?? null;
				const up = document.querySelector<HTMLButtonElement>('aside.explorer .up-button:not(.find-button)');
				const probes: CursorProbe[] = [
					probe('pointer (where the drag is now)', { x: pointerX, y: pointerY }),
					probe('explorer header', centre(document.querySelector('aside.explorer .explorer-header'))),
					probe('explorer title', centre(document.querySelector('aside.explorer .explorer-title'))),
					probe('find button', centre(document.querySelector('aside.explorer .find-button'))),
					probe('up button (as rendered)', centre(up)),
					probe('tree list, top', { x: list.x + list.width / 2, y: list.y + 6 }),
					probe('first visible row', centre(firstVisibleRow)),
					// 12px up: the section's sash overhangs the tree's bottom edge by 4px.
					probe('tree list, bottom', { x: list.x + list.width / 2, y: list.bottom - 12 }),
				];
				// Reviewer P3-2: `.up-button:disabled { cursor: default }` has the same
				// specificity as the drag rule, so force the disabled state and look.
				let upDisabledNatively: boolean | null = null;
				if (up) {
					upDisabledNatively = up.disabled;
					up.disabled = true;
					probes.push(probe('up button, disabled', centre(up), true));
					up.disabled = upDisabledNatively;
				}
				const s = section.getBoundingClientRect();
				return {
					appClasses: Array.from(app.classList),
					sectionDragging: section.classList.contains('dragging'),
					sectionTop: s.top,
					sectionHeight: s.height,
					paneHeight: document.querySelector('.explorer-pane')!.clientHeight,
					asideHeight: aside.getBoundingClientRect().height,
					appCursor: getComputedStyle(app).cursor,
					bodyCursor: getComputedStyle(document.body).cursor,
					upDisabledNatively,
					probes,
				};
			},
			before.headerX,
			farY,
		);
		await safeShot('bundle736-64g-dragging');

		// Release where the pointer is; the class goes and the tree's own cursors return.
		await pointer(HEADER, 'pointerup', before.headerX, farY);
		await browser.waitUntil(
			async () => browser.execute(() => !(document.querySelector('.app')?.classList.contains('resizing-recent-files') ?? true)),
			{ timeout: 3_000, timeoutMsg: '.app kept resizing-recent-files after the release' },
		);
		const after = await browser.execute(() => {
			const list = document.querySelector('nav.explorer-list')!.getBoundingClientRect();
			const row =
				Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find((r) => {
					const b = r.getBoundingClientRect();
					return b.top >= list.top && b.bottom <= list.bottom;
				}) ?? null;
			const s = document.querySelector('[data-testid="recent-files"]')!.getBoundingClientRect();
			return {
				appClasses: Array.from(document.querySelector('.app')!.classList),
				sectionDragging: document.querySelector('[data-testid="recent-files"]')!.classList.contains('dragging'),
				sectionHeight: s.height,
				rowCursor: row ? getComputedStyle(row).cursor : null,
				// Recorded only (the row's own user-select is the browser default, not a contract).
				rowUserSelect: row
					? getComputedStyle(row).userSelect || (getComputedStyle(row) as unknown as { webkitUserSelect?: string }).webkitUserSelect || null
					: null,
				storedHeight: (() => {
					try {
						return localStorage.getItem('vellis.recent-files-height');
					} catch {
						return null;
					}
				})(),
			};
		});
		const expectedMax = during.paneHeight - MIN_TREE_HEIGHT;
		const reachedMax = Math.abs(during.sectionHeight - expectedMax) <= 1;
		report(REPORT, {
			gate: '64g',
			framesStalled: stalledNow,
			before,
			pointerY: farY,
			expectedMax,
			reachedMax,
			...during,
		});
		report(REPORT, { gate: '64g-release', ...after });

		// Put the section back to the height it had and restore the storage.
		const delta = after.sectionHeight - before.sectionHeight;
		if (Math.abs(delta) > 1) {
			const h = (await rectOf('[data-testid="recent-files-header"]'))!;
			const y0 = h.y + h.height / 2;
			await pointer(HEADER, 'pointerdown', before.headerX, y0);
			await pointer(HEADER, 'pointermove', before.headerX, y0 + 10);
			await pointer(HEADER, 'pointermove', before.headerX, y0 + delta);
			await pointer(HEADER, 'pointerup', before.headerX, y0 + delta);
		}
		await storageRestore({ [RECENT_HEIGHT_KEY]: savedStorage[RECENT_HEIGHT_KEY] ?? null, [RECENT_EXPANDED_KEY]: savedStorage[RECENT_EXPANDED_KEY] ?? null });

		// While dragging: the window-wide class is on, the pointer is above the
		// section (over the tree), and everything under the probe points — the
		// header, both buttons, the list, a row, and the ↑ button forced into
		// its disabled state — reports ns-resize.
		expect(during.appClasses).toContain('resizing-recent-files');
		expect(during.sectionDragging).toBe(true);
		expect(farY).toBeLessThan(during.sectionTop);
		expect(during.sectionHeight).toBeGreaterThan(before.sectionHeight);
		expect(during.asideHeight).toBeGreaterThanOrEqual(MIN_TREE_HEIGHT - 1);
		// The upper bound comes from a ResizeObserver-fed `bind:clientHeight`;
		// with the display off that observer may not have run, so the bound is
		// only enforced when frames were running (recorded above either way).
		if (!stalledNow) expect(reachedMax).toBe(true);
		// `.app.resizing-recent-files :global(*)` (+page.svelte) carries both
		// `cursor: ns-resize` and `user-select: none` to every descendant, so every
		// probed element — not only the header — must report both (decision (a)).
		for (const p of during.probes) {
			expect(p.hit).not.toBeNull();
			expect(p.insideTree).toBe(true);
			expect(p.cursor).toBe('ns-resize');
			expect(p.userSelect).toBe('none');
		}
		expect(during.probes.some((p) => p.forcedDisabled)).toBe(true);
		// After release: the class is gone and a tree row is back to its own cursor.
		expect(after.appClasses).not.toContain('resizing-recent-files');
		expect(after.sectionDragging).toBe(false);
		expect(after.rowCursor).toBe('pointer');
	});

	it('no dialog was raised by any of the gates', async () => {
		const rec = await readGateRecord();
		report(REPORT, { gate: 'dialogs', dialogs: rec.dialogs });
		expect(rec.dialogs).toEqual([]);
	});
});
