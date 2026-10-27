import { browser } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Shared helpers for the human-gate specs (`req69-code-highlight-gate.e2e.ts`,
 * `req70-symlink-gate.e2e.ts`, `req66-find-in-folder-gate.e2e.ts`,
 * `ssh-root-gates.e2e.ts`). Not a spec itself: the wdio glob only picks up
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
	/** Commands whose request args and response body are kept in `captured`. */
	capture: string[];
	captured: CapturedIpc[];
}

/** One IPC round trip of a command listed in `setIpcCapture`. */
export interface CapturedIpc {
	seq: number;
	cmd: string;
	/** Parsed JSON request body (null when the body was not JSON text). */
	args: unknown;
	/** `Tauri-Response` header was not `error`. */
	ok: boolean;
	/** Parsed JSON response body (the raw text when it is not JSON). */
	body: unknown;
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
			capture: [] as string[],
			captured: [] as CapturedIpc[],
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
				const parse = (text: string): unknown => {
					try {
						return JSON.parse(text);
					} catch {
						return text;
					}
				};
				if (rec.block.includes(cmd)) {
					// A blocked command that is also captured keeps its request args
					// (`ok: false`, body = the stub's text), so a spec can read what
					// would have reached Rust without letting it through.
					if (rec.capture.includes(cmd)) {
						rec.captured.push({
							seq: rec.captured.length,
							cmd,
							args: typeof init?.body === 'string' ? parse(init.body) : null,
							ok: false,
							body: 'blocked by gate check',
						});
					}
					return Promise.resolve(
						new Response('blocked by gate check', {
							status: 400,
							headers: { 'Content-Type': 'text/plain', 'Tauri-Response': 'error' },
						}),
					);
				}
				if (rec.capture.includes(cmd)) {
					const entry: CapturedIpc = {
						seq: rec.captured.length,
						cmd,
						args: typeof init?.body === 'string' ? parse(init.body) : null,
						ok: false,
						body: null,
					};
					rec.captured.push(entry);
					return originalFetch.call(this, input, init).then(async (res) => {
						entry.ok = res.headers.get('Tauri-Response') !== 'error';
						entry.body = parse(await res.clone().text());
						return res;
					});
				}
			}
			return originalFetch.call(this, input, init);
		} as typeof window.fetch;
	});
}

/** Keep request args + response body of these commands (see `readCapturedIpc`). */
export async function setIpcCapture(cmds: string[]): Promise<void> {
	await browser.execute((list) => {
		const r = (window as unknown as { __gate?: GateRecord }).__gate;
		if (!r) throw new Error('gate recorder is not installed');
		r.capture = list;
	}, cmds);
}

export async function readCapturedIpc(): Promise<CapturedIpc[]> {
	return browser.execute(() => {
		const r = (window as unknown as { __gate?: GateRecord }).__gate;
		if (!r) throw new Error('gate recorder is not installed');
		return JSON.parse(JSON.stringify(r.captured)) as CapturedIpc[];
	});
}

export async function clearCapturedIpc(): Promise<void> {
	await browser.execute(() => {
		const r = (window as unknown as { __gate?: GateRecord }).__gate;
		if (r) r.captured = [];
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

export async function readGateRecord(): Promise<Pick<GateRecord, 'ipc' | 'dialogs' | 'block'>> {
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

/** Outcome of one `__TAURI_INTERNALS__.invoke` made from the page (see `invokeFromPage`). */
export interface PageInvoke<T> {
	ok: boolean;
	value: T | null;
	error: string | null;
}

/**
 * Invoke a Tauri command from the page and bring back either its value or the
 * rejection text. Goes through the same `fetch` the recorder wraps, so blocks
 * and captures apply.
 */
export async function invokeFromPage<T>(cmd: string, args: Record<string, unknown> = {}): Promise<PageInvoke<T>> {
	return browser.executeAsync<PageInvoke<T>, [string, Record<string, unknown>]>((c, a, done) => {
		const internals = (window as unknown as {
			__TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
		}).__TAURI_INTERNALS__;
		internals.invoke(c, a).then(
			(v) => done({ ok: true, value: v as T, error: null }),
			(e) => done({ ok: false, value: null, error: String(e) }),
		);
	}, cmd, args);
}

/** `title` (= URI) of the Explorer row whose visible name is `name`, or null. */
export async function explorerRowUriByName(name: string): Promise<string | null> {
	return browser.execute(
		(n) =>
			Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find(
				(r) => r.querySelector('.name')?.textContent === n,
			)?.title ?? null,
		name,
	);
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

/**
 * A decoded screenshot: 8-bit samples, `channels` per pixel (1 = grey,
 * 2 = grey+alpha, 3 = RGB, 4 = RGBA), rows top-down, no padding.
 */
export interface Bitmap {
	width: number;
	height: number;
	channels: number;
	data: Buffer;
}

/**
 * Decode a PNG without any dependency beyond `node:zlib` (8-bit samples,
 * non-interlaced, no palette — what WebDriver screenshots are). Used where a
 * gate has to read pixels the DOM does not expose (a native `<input
 * type="range">` thumb, for instance).
 */
export function decodePng(file: string): Bitmap {
	const buf = fs.readFileSync(file);
	if (buf.subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') throw new Error(`${file}: not a PNG`);
	let off = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	const idat: Buffer[] = [];
	while (off + 8 <= buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.subarray(off + 4, off + 8).toString('latin1');
		const data = buf.subarray(off + 8, off + 8 + len);
		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8] ?? 0;
			colorType = data[9] ?? 0;
			interlace = data[12] ?? 0;
		} else if (type === 'IDAT') {
			idat.push(data);
		} else if (type === 'IEND') {
			break;
		}
		off += 12 + len;
	}
	const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
	if (!channels || bitDepth !== 8 || interlace !== 0) {
		throw new Error(`${file}: unsupported PNG (colour type ${colorType}, depth ${bitDepth}, interlace ${interlace})`);
	}
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const out = Buffer.alloc(stride * height);
	let p = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[p++];
		const row = y * stride;
		const prev = row - stride;
		for (let i = 0; i < stride; i++) {
			const x = raw[p++] ?? 0;
			const a = i >= channels ? out[row + i - channels]! : 0;
			const b = y > 0 ? out[prev + i]! : 0;
			const c = y > 0 && i >= channels ? out[prev + i - channels]! : 0;
			let v: number;
			switch (filter) {
				case 0:
					v = x;
					break;
				case 1:
					v = x + a;
					break;
				case 2:
					v = x + b;
					break;
				case 3:
					v = x + ((a + b) >> 1);
					break;
				case 4: {
					const pp = a + b - c;
					const pa = Math.abs(pp - a);
					const pb = Math.abs(pp - b);
					const pc = Math.abs(pp - c);
					v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
					break;
				}
				default:
					throw new Error(`${file}: bad PNG filter ${filter} on row ${y}`);
			}
			out[row + i] = v & 255;
		}
	}
	return { width, height, channels, data: out };
}

/** `[r, g, b]` of the device pixel at (x, y); grey PNGs repeat the one sample. */
export function pixelAt(bmp: Bitmap, x: number, y: number): [number, number, number] {
	const i = (y * bmp.width + x) * bmp.channels;
	const d = bmp.data;
	if (bmp.channels >= 3) return [d[i]!, d[i + 1]!, d[i + 2]!];
	return [d[i]!, d[i]!, d[i]!];
}

/** Sum of the absolute channel differences of two pixels. */
export function pixelDistance(a: [number, number, number], b: [number, number, number]): number {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/**
 * Full-window screenshot decoded to pixels, with the device-pixel ratio the
 * screenshot has against the CSS viewport (`bitmap.width / innerWidth`).
 */
export async function shotBitmap(name: string): Promise<{ file: string; bmp: Bitmap; dpr: number }> {
	const file = await shot(name);
	const bmp = decodePng(file);
	const innerWidth = await browser.execute(() => window.innerWidth);
	return { file, bmp, dpr: bmp.width / innerWidth };
}

/** Append a line to `<SHOTS_DIR>/<file>` (JSON per line) and echo it. */
export function report(file: string, entry: Record<string, unknown>): void {
	fs.mkdirSync(SHOTS_DIR, { recursive: true });
	fs.appendFileSync(path.join(SHOTS_DIR, file), `${JSON.stringify(entry)}\n`);
	console.log(`[gate] ${JSON.stringify(entry)}`);
}
