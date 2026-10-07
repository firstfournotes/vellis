import { browser } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Shared helpers for the human-gate specs (`req69-code-highlight-gate.e2e.ts`,
 * `req70-symlink-gate.e2e.ts`). Not a spec itself: the wdio glob only picks up
 * `*.e2e.ts`.
 *
 * Rules these helpers follow (tasks/lessons.md, 2026-09-26 / 2026-10-01 /
 * 2026-10-04):
 *  - native menus are not clicked; the same menu *event* (`menu_save`,
 *    `menu_go_to`, …) is emitted to this window through `plugin:event|emit`
 *  - `alert` / `confirm` / `prompt` are stubbed in the (already open) first
 *    window before anything is driven, so no dialog reaches the screen
 *  - IPC is observed at the fetch layer (`ipc://localhost/<cmd>`); commands that
 *    would open something outside this window can be blocked there
 */

export const SHOTS_DIR = process.env.VELLIS_GATE_SHOTS ?? path.join(os.tmpdir(), 'vellis-gate-shots');

export async function waitForAppMounted(): Promise<void> {
	await browser.waitUntil(
		async () =>
			browser.execute(() => location.href !== 'about:blank' && document.body.childElementCount > 0),
		{ timeout: 30_000, timeoutMsg: 'webview never navigated past about:blank' },
	);
}

interface GateRecord {
	ipc: string[];
	dialogs: string[];
	block: string[];
}

/**
 * Stub the dialogs and wrap `fetch` so every IPC command is recorded (and the
 * ones listed in `block` answer an error without reaching Rust). Idempotent.
 */
export async function installGateRecorder(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as {
			__gate?: GateRecord & { originals: Record<string, unknown> };
		};
		if (w.__gate) return;
		const rec = {
			ipc: [] as string[],
			dialogs: [] as string[],
			block: [] as string[],
			originals: {
				alert: window.alert,
				confirm: window.confirm,
				prompt: window.prompt,
				fetch: window.fetch,
			} as Record<string, unknown>,
		};
		w.__gate = rec;
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
		const originalFetch = window.fetch;
		window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
			const url =
				typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
			const prefix = 'ipc://localhost/';
			if (url.startsWith(prefix)) {
				const cmd = decodeURIComponent(url.slice(prefix.length).split('?')[0] ?? '');
				rec.ipc.push(cmd);
				if (rec.block.includes(cmd)) {
					return Promise.resolve(
						new Response('blocked by gate check', {
							status: 400,
							headers: { 'Content-Type': 'text/plain', 'Tauri-Response': 'error' },
						}),
					);
				}
			}
			return originalFetch.call(this, input, init);
		} as typeof window.fetch;
	});
}

export async function restoreGateRecorder(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __gate?: { originals: Record<string, unknown> } };
		const o = w.__gate?.originals;
		if (!o) return;
		window.alert = o.alert as typeof window.alert;
		window.confirm = o.confirm as typeof window.confirm;
		window.prompt = o.prompt as typeof window.prompt;
		window.fetch = o.fetch as typeof window.fetch;
	});
}

export async function readGateRecord(): Promise<GateRecord> {
	return browser.execute(() => {
		const r = (window as unknown as { __gate?: GateRecord }).__gate;
		if (!r) throw new Error('gate recorder is not installed');
		return { ipc: [...r.ipc], dialogs: [...r.dialogs], block: [...r.block] };
	});
}

export async function setIpcBlock(cmds: string[]): Promise<void> {
	await browser.execute((list) => {
		const r = (window as unknown as { __gate?: GateRecord }).__gate;
		if (!r) throw new Error('gate recorder is not installed');
		r.block = list;
	}, cmds);
}

export async function clearIpcLog(): Promise<void> {
	await browser.execute(() => {
		const r = (window as unknown as { __gate?: GateRecord }).__gate;
		if (r) r.ipc = [];
	});
}

/**
 * Prove the fetch-layer interception is live before relying on it: block a
 * harmless command, call it, and expect the stub's error back.
 */
export async function assertIpcInterceptionWorks(): Promise<void> {
	await setIpcBlock(['get_build_info']);
	const res = await browser.executeAsync<string, []>((done) => {
		const internals = (window as unknown as {
			__TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
		}).__TAURI_INTERNALS__;
		internals.invoke('get_build_info').then(
			() => done('reached-rust'),
			(e) => done(`rejected:${String(e)}`),
		);
	});
	await setIpcBlock([]);
	if (!res.includes('blocked by gate check')) {
		throw new Error(`IPC interception is not effective (${res}); refusing to drive further`);
	}
}

/** Emit a menu event to this window, the same event the native menu item emits. */
export async function emitMenu(event: string): Promise<void> {
	const res = await browser.executeAsync<string, [string]>((ev, done) => {
		const internals = (window as unknown as {
			__TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
		}).__TAURI_INTERNALS__;
		internals.invoke('plugin:event|emit', { event: ev, payload: null }).then(
			() => done('ok'),
			(e) => done(String(e)),
		);
	}, event);
	if (res !== 'ok') throw new Error(`emit ${event} failed: ${res}`);
}

export async function explorerNames(): Promise<string[]> {
	return browser.execute(() =>
		Array.from(document.querySelectorAll('.explorer-item .name')).map((el) => el.textContent ?? ''),
	);
}

export async function explorerHasRow(uri: string): Promise<boolean> {
	return browser.execute(
		(u) => Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).some((r) => r.title === u),
		uri,
	);
}

/**
 * Wait until the Explorer lists `uri`; with `nudgeDir`, touch-and-remove a file
 * there on each miss so the backend re-lists it (same startup-race cure as
 * release-smoke.e2e.ts).
 */
export async function waitForExplorerRow(
	uri: string,
	opts: { timeout: number; nudgeDir?: string; nudgePrefix?: string },
): Promise<void> {
	const deadline = Date.now() + opts.timeout;
	let attempt = 0;
	for (;;) {
		if (await explorerHasRow(uri)) return;
		if (Date.now() >= deadline) {
			throw new Error(`explorer never listed ${uri} (rows: ${JSON.stringify(await explorerNames())})`);
		}
		if (opts.nudgeDir) {
			const nudge = path.join(opts.nudgeDir, `${opts.nudgePrefix ?? 'gate'}-nudge-${attempt++}.tmp`);
			fs.writeFileSync(nudge, '');
			fs.rmSync(nudge, { force: true });
		}
		await browser.pause(1_000);
	}
}

/** Click the Explorer row whose `title` is `uri` with a real `MouseEvent`. */
export async function clickExplorerRow(
	uri: string,
	mods: { metaKey?: boolean; shiftKey?: boolean } = {},
): Promise<void> {
	await waitForExplorerRow(uri, { timeout: 15_000 });
	const ok = await browser.execute(
		(u, m) => {
			const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find(
				(r) => r.title === u,
			);
			if (!row) return false;
			row.dispatchEvent(
				new MouseEvent('click', {
					bubbles: true,
					cancelable: true,
					button: 0,
					detail: 1,
					metaKey: !!m.metaKey,
					shiftKey: !!m.shiftKey,
				}),
			);
			return true;
		},
		uri,
		mods,
	);
	if (!ok) throw new Error(`row ${uri} vanished before the click`);
}

/** Point the zoom router (requirement #63) at a region, as moving the mouse there would. */
export async function pointAtRegion(selector: string): Promise<void> {
	await browser.execute((sel) => {
		const el = document.querySelector(sel);
		if (!el) throw new Error(`no element for ${sel}`);
		el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true }));
	}, selector);
}

const ZOOM_KEYS = ['vellis.viewer-zoom', 'vellis.explorer-zoom'];

/** Saved zoom values, so a spec leaves the WebKit storage as it found it. */
export async function snapshotZoomStorage(): Promise<Record<string, string | null>> {
	return browser.execute((keys) => {
		const out: Record<string, string | null> = {};
		for (const k of keys) {
			try {
				out[k] = localStorage.getItem(k);
			} catch {
				out[k] = null;
			}
		}
		return out;
	}, ZOOM_KEYS);
}

export async function restoreZoomStorage(saved: Record<string, string | null>): Promise<void> {
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

/** Full-window screenshot into SHOTS_DIR. Returns the file path. */
export async function shot(name: string): Promise<string> {
	fs.mkdirSync(SHOTS_DIR, { recursive: true });
	const file = path.join(SHOTS_DIR, `${name}.png`);
	await browser.saveScreenshot(file);
	return file;
}

interface CssRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Crop `rect` (CSS px of the viewport) out of a full screenshot and enlarge it
 * `scale` times with `sips` (macOS). Skipped (returns null) where `sips` is not
 * available. The screenshot's device-pixel ratio is derived from its width.
 */
export async function zoomedShot(name: string, rect: CssRect, scale: number): Promise<string | null> {
	const full = await shot(`${name}--full`);
	const innerWidth = await browser.execute(() => window.innerWidth);
	try {
		const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', full], { encoding: 'utf8' });
		const pw = Number(/pixelWidth: (\d+)/.exec(info)?.[1]);
		const ph = Number(/pixelHeight: (\d+)/.exec(info)?.[1]);
		const dpr = pw / innerWidth;
		// sips treats a 0 offset as "centre the crop", so never pass 0.
		const x = Math.max(1, Math.round(rect.x * dpr));
		const y = Math.max(1, Math.round(rect.y * dpr));
		const w = Math.min(pw - x, Math.round(rect.width * dpr));
		const h = Math.min(ph - y, Math.round(rect.height * dpr));
		const out = path.join(SHOTS_DIR, `${name}.png`);
		execFileSync('sips', ['-c', String(h), String(w), '--cropOffset', String(y), String(x), full, '--out', out], {
			stdio: 'ignore',
		});
		execFileSync('sips', ['-z', String(h * scale), String(w * scale), out], { stdio: 'ignore' });
		fs.rmSync(full, { force: true });
		return out;
	} catch {
		return null;
	}
}

/** `rgb()` / `rgba()` / `#rrggbb` → [r, g, b, a]. */
export function parseColor(css: string): [number, number, number, number] {
	const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
	if (hex) {
		const n = parseInt(hex[1] ?? '0', 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
	}
	const m = /rgba?\(([^)]+)\)/.exec(css);
	if (!m) throw new Error(`unparsable colour: ${css}`);
	const parts = (m[1] ?? '').split(/[,\s/]+/).filter(Boolean).map(Number);
	return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
}

function channel(c: number): number {
	const s = c / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance. */
export function luminance(css: string): number {
	const [r, g, b] = parseColor(css);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, rounded to 2 decimals. */
export function contrastRatio(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	const [hi, lo] = la > lb ? [la, lb] : [lb, la];
	return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Append a line to `<SHOTS_DIR>/<file>` (JSON per line) and echo it. */
export function report(file: string, entry: Record<string, unknown>): void {
	fs.mkdirSync(SHOTS_DIR, { recursive: true });
	fs.appendFileSync(path.join(SHOTS_DIR, file), `${JSON.stringify(entry)}\n`);
	console.log(`[gate] ${JSON.stringify(entry)}`);
}
