/**
 * Requirement #91 (docs/requirements/req-91.md) — AC-91-8: View ▸ Show Audio Spectrum shows / hides the band, the
 * setting is remembered app-wide (every window, the next launch), and the item is grey unless the front window shows a
 * video or audio document. Pure part (unit project, jsdom): the setting store, the event names shared with menu.rs, the
 * report to Rust that drives the check and the enabled state, and the registration in +page.svelte.
 *
 * The native menu itself is `src-tauri/tests/acceptance_req91.rs`; the bands' reaction is in the two
 * `*.spectrum.wiring.test.ts`; the device is `tests/e2e/specs/req91-gate.e2e.ts`.
 *
 * ## Fixed contract (the implementer follows this; new module `src/lib/spectrum-visibility.ts`; the pattern is
 * `src/lib/alert-visibility.ts` of requirement #90 — one app-wide value in localStorage, other windows follow the
 * `storage` event, the window reports to Rust by an event)
 *
 * ```ts
 * export const SPECTRUM_SHOWN_STORAGE_KEY = 'vellis.spectrum-shown';     // localStorage; '1' = shown (the default), '0' = hidden
 * export const MENU_SHOW_SPECTRUM_EVENT = 'menu_show_spectrum';          // Rust → the focused window (no payload): toggle
 * export const SPECTRUM_STATE_EVENT = 'spectrum_state';                  // window → Rust { label, shown, available }
 * export function serializeSpectrumShown(shown: boolean): string;        // '1' / '0'
 * export function parseSpectrumShown(raw: string | null): boolean;       // null / '' / anything else → true; '0' | 'false' → false; '1' | 'true' → true
 * export function currentSpectrumShown(): boolean;                       // the value now (true before anything is loaded)
 * export function loadSpectrumShown(): boolean;                          // read localStorage into the current value (no write back)
 * export function applySpectrumShown(shown: boolean): void;              // current value, localStorage, subscribers, announceSpectrumState()
 * export function toggleSpectrumShown(): void;                           // applySpectrumShown(!current)
 * export function subscribeSpectrumShown(fn: (shown: boolean) => void): () => void;   // called on every change; the return unsubscribes
 * export function currentSpectrumAvailable(): boolean;                   // does THIS window show a video / audio document (false at start)
 * export function setSpectrumAvailable(available: boolean): void;        // the viewers call it on mount (true) and on destroy (false); announces
 * export async function announceSpectrumState(): Promise<void>;          // getCurrentWindow().emit(SPECTRUM_STATE_EVENT, { label, shown, available }); nothing outside Tauri
 * export async function registerSpectrumVisibilityListeners(): Promise<() => void>;
 * //   listen(MENU_SHOW_SPECTRUM_EVENT) → toggleSpectrumShown(); window 'storage' with key SPECTRUM_SHOWN_STORAGE_KEY → the current value
 * //   follows newValue and subscribers are told (another window's choice); getCurrentWindow().onFocusChanged(focused) → announce again
 * //   when focused (Rust greys the item by the FRONT window's `available`); one announce right after registering. The return undoes all
 * ```
 *
 * - `src/routes/+page.svelte` imports `$lib/spectrum-visibility` and calls `loadSpectrumShown(` and
 *   `registerSpectrumVisibilityListeners(` (the window has a receiver even when no media is shown, as for the alerts).
 *
 * ## Judgement record (test-writer 2026-11-27)
 * - The setting lives in localStorage (one app-wide value), like Toggle Full Width / Show Formatting Toolbar / Alerts — not in
 *   settings.json. Other windows follow through the `storage` event; the menu is one for the app, so its check is app-wide.
 * - The grey state needs "does the front window show video / audio": the viewers report availability on mount / destroy and
 *   the window re-reports on focus, so Rust can follow the front window as it does for Raw Source (`raw_check_applies`).
 * - The stored form is '1' / '0' (a single boolean; JSON of one key would say nothing more).
 *
 * ## Why this is red before the implementation
 * - `src/lib/spectrum-visibility.ts` does not exist; menu.rs has no SPECTRUM constants; +page.svelte does not register.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Handler = (e: { payload: unknown }) => void;

const { registry, unlistenCalls, emitted, focusHandlers } = vi.hoisted(() => ({
	registry: new Map<string, Handler[]>(),
	unlistenCalls: [] as string[],
	emitted: [] as Array<{ event: string; payload: unknown }>,
	focusHandlers: [] as Array<(e: { payload: boolean }) => void>,
}));

vi.mock('$lib/events', () => ({
	listen: async (event: string, handler: Handler) => {
		const list = registry.get(event) ?? [];
		list.push(handler);
		registry.set(event, list);
		return () => {
			unlistenCalls.push(event);
			const cur = registry.get(event) ?? [];
			const at = cur.indexOf(handler);
			if (at >= 0) cur.splice(at, 1);
		};
	},
}));

vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = {
		label: 'main',
		emit: async (event: string, payload?: unknown) => {
			emitted.push({ event, payload });
		},
		onFocusChanged: async (handler: (e: { payload: boolean }) => void) => {
			focusHandlers.push(handler);
			return () => {
				const at = focusHandlers.indexOf(handler);
				if (at >= 0) focusHandlers.splice(at, 1);
			};
		},
		listen: async () => () => {},
	};
	return { ...actual, getCurrentWindow: () => fake };
});

import {
	MENU_SHOW_SPECTRUM_EVENT,
	SPECTRUM_SHOWN_STORAGE_KEY,
	SPECTRUM_STATE_EVENT,
	announceSpectrumState,
	applySpectrumShown,
	currentSpectrumAvailable,
	currentSpectrumShown,
	loadSpectrumShown,
	parseSpectrumShown,
	registerSpectrumVisibilityListeners,
	serializeSpectrumShown,
	setSpectrumAvailable,
	subscribeSpectrumShown,
	toggleSpectrumShown,
} from './spectrum-visibility';

const REPO_ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');
const menuRs = () => read('src-tauri/src/menu.rs');

function rustConst(name: string): string | undefined {
	return menuRs().match(new RegExp(`pub const ${name}: &str = "([^"]+)";`))?.[1];
}

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise<void>((r) => setTimeout(r, 0));
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fire(event: string, payload: unknown = null): void {
	const handlers = registry.get(event) ?? [];
	expect(handlers.length, `${event} must be listened to`).toBeGreaterThan(0);
	for (const h of handlers) h({ payload });
}

const stateEvents = () => emitted.filter((e) => e.event === SPECTRUM_STATE_EVENT);

beforeEach(() => {
	registry.clear();
	unlistenCalls.length = 0;
	focusHandlers.length = 0;
	localStorage.clear();
	// Back to the defaults between tests (the module keeps one current value).
	setSpectrumAvailable(false);
	applySpectrumShown(true);
	localStorage.clear();
	emitted.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// constants (contract 11)
// ---------------------------------------------------------------------------

describe('AC-91-8 constants: the storage key and the two event names (the same spelling as menu.rs), no CJK', () => {
	test('the values are fixed', () => {
		expect(SPECTRUM_SHOWN_STORAGE_KEY).toBe('vellis.spectrum-shown');
		expect(MENU_SHOW_SPECTRUM_EVENT).toBe('menu_show_spectrum');
		expect(SPECTRUM_STATE_EVENT).toBe('spectrum_state');
	});

	test('menu.rs declares the same event names', () => {
		expect(rustConst('MENU_SHOW_SPECTRUM_EVENT')).toBe(MENU_SHOW_SPECTRUM_EVENT);
		expect(rustConst('SPECTRUM_STATE_EVENT')).toBe(SPECTRUM_STATE_EVENT);
	});

	test('no CJK in the constants', () => {
		for (const s of [SPECTRUM_SHOWN_STORAGE_KEY, MENU_SHOW_SPECTRUM_EVENT, SPECTRUM_STATE_EVENT]) {
			expect(s).not.toMatch(CJK_PATTERN);
		}
	});
});

// ---------------------------------------------------------------------------
// the stored form
// ---------------------------------------------------------------------------

describe('AC-91-8 the stored form: "1" shown / "0" hidden; anything unreadable means shown (the default)', () => {
	test('serialize', () => {
		expect(serializeSpectrumShown(true)).toBe('1');
		expect(serializeSpectrumShown(false)).toBe('0');
	});

	test('parse', () => {
		expect(parseSpectrumShown(null)).toBe(true);
		expect(parseSpectrumShown('')).toBe(true);
		expect(parseSpectrumShown('garbage')).toBe(true);
		expect(parseSpectrumShown('1')).toBe(true);
		expect(parseSpectrumShown('true')).toBe(true);
		expect(parseSpectrumShown('0')).toBe(false);
		expect(parseSpectrumShown('false')).toBe(false);
		expect(parseSpectrumShown(serializeSpectrumShown(false))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// remember and announce (contract 11)
// ---------------------------------------------------------------------------

describe('AC-91-8 the current value: shown by default; apply writes localStorage, tells subscribers and reports to Rust', () => {
	test('shown by default and not available before a viewer says so', () => {
		expect(currentSpectrumShown()).toBe(true);
		expect(currentSpectrumAvailable()).toBe(false);
	});

	test('applySpectrumShown(false): current value, localStorage "0", subscriber, spectrum_state { label, shown: false, available }', async () => {
		const seen: boolean[] = [];
		const off = subscribeSpectrumShown((shown) => seen.push(shown));
		applySpectrumShown(false);
		await flush();
		expect(currentSpectrumShown()).toBe(false);
		expect(localStorage.getItem(SPECTRUM_SHOWN_STORAGE_KEY)).toBe('0');
		expect(seen).toEqual([false]);
		expect(stateEvents()).toEqual([
			{ event: SPECTRUM_STATE_EVENT, payload: { label: 'main', shown: false, available: false } },
		]);
		off();
		applySpectrumShown(true);
		expect(seen).toEqual([false]);
		expect(localStorage.getItem(SPECTRUM_SHOWN_STORAGE_KEY)).toBe('1');
	});

	test('toggleSpectrumShown flips the value', () => {
		toggleSpectrumShown();
		expect(currentSpectrumShown()).toBe(false);
		toggleSpectrumShown();
		expect(currentSpectrumShown()).toBe(true);
	});

	test('loadSpectrumShown reads localStorage (the previous launch) and does not write it back', () => {
		localStorage.setItem(SPECTRUM_SHOWN_STORAGE_KEY, '0');
		expect(loadSpectrumShown()).toBe(false);
		expect(currentSpectrumShown()).toBe(false);
		localStorage.setItem(SPECTRUM_SHOWN_STORAGE_KEY, 'garbage');
		expect(loadSpectrumShown()).toBe(true);
		expect(localStorage.getItem(SPECTRUM_SHOWN_STORAGE_KEY)).toBe('garbage');
	});

	test('setSpectrumAvailable reports availability with the current shown value; later applies carry it', async () => {
		setSpectrumAvailable(true);
		await flush();
		expect(currentSpectrumAvailable()).toBe(true);
		expect(stateEvents().at(-1)).toEqual({ event: SPECTRUM_STATE_EVENT, payload: { label: 'main', shown: true, available: true } });
		applySpectrumShown(false);
		await flush();
		expect(stateEvents().at(-1)).toEqual({ event: SPECTRUM_STATE_EVENT, payload: { label: 'main', shown: false, available: true } });
		setSpectrumAvailable(false);
		await flush();
		expect(stateEvents().at(-1)).toEqual({ event: SPECTRUM_STATE_EVENT, payload: { label: 'main', shown: false, available: false } });
	});

	test('announceSpectrumState emits once with the current pair', async () => {
		await announceSpectrumState();
		expect(stateEvents()).toEqual([
			{ event: SPECTRUM_STATE_EVENT, payload: { label: 'main', shown: true, available: false } },
		]);
	});
});

// ---------------------------------------------------------------------------
// the receivers (contract 11: the menu, the other windows, the focus)
// ---------------------------------------------------------------------------

describe('AC-91-8 registerSpectrumVisibilityListeners: the menu toggles, other windows are followed, the focus re-reports', () => {
	test('registers the menu event and announces once right away', async () => {
		const off = await registerSpectrumVisibilityListeners();
		await flush();
		expect(registry.get(MENU_SHOW_SPECTRUM_EVENT)?.length ?? 0).toBeGreaterThan(0);
		expect(stateEvents()).toHaveLength(1);
		expect(stateEvents()[0].payload).toEqual({ label: 'main', shown: true, available: false });
		off();
	});

	test('the menu event toggles the value (and stores and announces it)', async () => {
		const off = await registerSpectrumVisibilityListeners();
		await flush();
		emitted.length = 0;
		fire(MENU_SHOW_SPECTRUM_EVENT);
		await flush();
		expect(currentSpectrumShown()).toBe(false);
		expect(localStorage.getItem(SPECTRUM_SHOWN_STORAGE_KEY)).toBe('0');
		expect(stateEvents().at(-1)?.payload).toEqual({ label: 'main', shown: false, available: false });
		fire(MENU_SHOW_SPECTRUM_EVENT);
		await flush();
		expect(currentSpectrumShown()).toBe(true);
		expect(localStorage.getItem(SPECTRUM_SHOWN_STORAGE_KEY)).toBe('1');
		off();
	});

	test("another window's choice arrives as a storage event and is followed (subscribers told); other keys are ignored", async () => {
		const off = await registerSpectrumVisibilityListeners();
		const seen: boolean[] = [];
		const unsub = subscribeSpectrumShown((shown) => seen.push(shown));
		window.dispatchEvent(new StorageEvent('storage', { key: SPECTRUM_SHOWN_STORAGE_KEY, newValue: '0' }));
		expect(currentSpectrumShown()).toBe(false);
		expect(seen).toEqual([false]);
		window.dispatchEvent(new StorageEvent('storage', { key: 'vellis.waveform-height', newValue: '0' }));
		expect(currentSpectrumShown()).toBe(false);
		window.dispatchEvent(new StorageEvent('storage', { key: SPECTRUM_SHOWN_STORAGE_KEY, newValue: '1' }));
		expect(currentSpectrumShown()).toBe(true);
		expect(seen).toEqual([false, true]);
		unsub();
		off();
	});

	test('gaining focus re-announces the state (Rust greys the item by the front window)', async () => {
		const off = await registerSpectrumVisibilityListeners();
		await flush();
		expect(focusHandlers.length).toBeGreaterThan(0);
		emitted.length = 0;
		for (const h of focusHandlers) h({ payload: true });
		await flush();
		expect(stateEvents()).toHaveLength(1);
		expect(stateEvents()[0].payload).toEqual({ label: 'main', shown: true, available: false });
		off();
	});

	test('the returned function undoes everything: the menu listener is removed and storage events no longer apply', async () => {
		const off = await registerSpectrumVisibilityListeners();
		await flush();
		off();
		expect(unlistenCalls).toContain(MENU_SHOW_SPECTRUM_EVENT);
		expect(registry.get(MENU_SHOW_SPECTRUM_EVENT) ?? []).toHaveLength(0);
		window.dispatchEvent(new StorageEvent('storage', { key: SPECTRUM_SHOWN_STORAGE_KEY, newValue: '0' }));
		expect(currentSpectrumShown()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// the page registers the receiver
// ---------------------------------------------------------------------------

describe('AC-91-8 +page.svelte loads the setting and registers the listeners (a receiver even without media on screen)', () => {
	test('+page.svelte imports $lib/spectrum-visibility and calls loadSpectrumShown( and registerSpectrumVisibilityListeners(', () => {
		const page = read('src/routes/+page.svelte');
		expect(page).toMatch(/from\s+['"]\$lib\/spectrum-visibility['"]/);
		expect(page).toContain('loadSpectrumShown(');
		expect(page).toContain('registerSpectrumVisibilityListeners(');
	});
});
