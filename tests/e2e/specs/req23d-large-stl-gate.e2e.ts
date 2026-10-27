import { browser, expect } from '@wdio/globals';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
	assertIpcInterceptionWorks,
	clickExplorerRow,
	installGateRecorder,
	pixelAt,
	pixelDistance,
	report,
	shot,
	shotBitmap,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

/**
 * Requirement #23 追補d human gate, driven on a real screen
 * (docs/requirements/req-23.md「追補d」): an STL over 256 MB is refused at
 * once, and neither the app nor its WebContent process takes the file into
 * memory. A small STL still shows.
 *
 * Device-only: run through `scripts/gate-device/run-gate-spec.sh req23d`
 * (VELLIS_GATE_DEVICE=1). It needs the sparse files that script makes, the
 * pid-pinned helper `axtool` (resident size of the app and its WebKit helper
 * processes) and an unlocked screen, so on CI (and in `scripts/e2e.sh`) every
 * test is skipped.
 *
 * Evidence goes to $VELLIS_GATE_SHOTS/req23d-report.jsonl and screenshots.
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';
const REPORT = 'req23d-report.jsonl';
const LIMIT = 256 * 1024 * 1024;

const uri = (name: string) => `file://${path.join(root, name)}`;

function ax(args: string[]): Record<string, unknown>[] {
	const out = execFileSync(axtool, args, { encoding: 'utf8', env: { ...process.env, AXTOOL_EXPECT_EXE: bin } });
	return out
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The app's pid and its WebKit helper processes (by responsible pid). */
function processes(): { pid: number; name: string }[] {
	const app = ax(['pids-of-exe', bin]).map((r) => r.pid as number);
	if (app.length !== 1) throw new Error(`expected one app process, found ${JSON.stringify(app)}`);
	const helpers = ax(['webcontent', String(app[0])]).map((r) => ({ pid: r.pid as number, name: r.name as string }));
	return [{ pid: app[0], name: 'vellis' }, ...helpers];
}

interface Sample {
	/** Seconds since the epoch (axtool's clock). */
	t: number;
	[pid: string]: number | { rss: number; footprint: number };
}

/** A rise the gate calls a jump: well under the 300 MB a full read would add. */
const JUMP_MIB = 64;

/** Sample resident size / footprint of `pids` every `intervalMs` for `seconds`. */
function startSampler(pids: number[], intervalMs: number, seconds: number): Promise<Sample[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(axtool, ['rss', String(intervalMs), String(seconds), ...pids.map(String)]);
		let buf = '';
		child.stdout.on('data', (d) => (buf += d));
		child.on('error', reject);
		child.on('close', () =>
			resolve(
				buf
					.split('\n')
					.filter(Boolean)
					.map((l) => JSON.parse(l) as Sample),
			),
		);
	});
}

/**
 * Largest rise over the pre-click level, per process (MiB). `clickAt` is ms
 * since the epoch (`Date.now()` in the page); the samples carry seconds. The
 * raw samples go to `<SHOTS>/req23d-samples-<label>.jsonl`.
 */
function memoryDelta(samples: Sample[], procs: { pid: number; name: string }[], clickAt: number, label: string) {
	const dir = process.env.VELLIS_GATE_SHOTS ?? '';
	if (dir) {
		fs.writeFileSync(
			path.join(dir, `req23d-samples-${label}.jsonl`),
			samples.map((s) => JSON.stringify({ ...s, sinceClickMs: Math.round(s.t * 1000 - clickAt) })).join('\n') + '\n',
		);
	}
	return procs.map(({ pid, name }) => {
		const key = String(pid);
		const pick = (s: Sample) => s[key] as { rss: number; footprint: number } | undefined;
		const before = samples
			.filter((s) => s.t * 1000 < clickAt)
			.map(pick)
			.filter(Boolean) as { rss: number; footprint: number }[];
		const after = samples
			.filter((s) => s.t * 1000 >= clickAt)
			.map(pick)
			.filter(Boolean) as { rss: number; footprint: number }[];
		const mib = (n: number) => Math.round((n / (1024 * 1024)) * 10) / 10;
		const base = (k: 'rss' | 'footprint') => Math.max(...before.map((m) => m[k]));
		const peak = (k: 'rss' | 'footprint') => Math.max(...after.map((m) => m[k]));
		return {
			pid,
			name,
			samples: { before: before.length, after: after.length },
			rss: { base_mib: mib(base('rss')), peak_mib: mib(peak('rss')), delta_mib: mib(peak('rss') - base('rss')) },
			footprint: {
				base_mib: mib(base('footprint')),
				peak_mib: mib(peak('footprint')),
				delta_mib: mib(peak('footprint') - base('footprint')),
			},
		};
	});
}

/** Record every `vellis-asset:` fetch (URL, Range header, status, Content-Range) without changing it. */
async function installAssetSpy(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __assetLog?: unknown[] };
		if (w.__assetLog) return;
		const log: Record<string, unknown>[] = [];
		w.__assetLog = log;
		const previous = window.fetch;
		window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
			const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
			if (!url.startsWith('vellis-asset:')) return previous.call(this, input, init);
			const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			const entry: Record<string, unknown> = { url, range: headers.get('range'), at: Date.now() };
			log.push(entry);
			return previous.call(this, input, init).then(
				(res) => {
					entry.status = res.status;
					entry.contentRange = res.headers.get('content-range');
					entry.contentLength = res.headers.get('content-length');
					entry.ms = Date.now() - (entry.at as number);
					return res;
				},
				(e) => {
					entry.error = String(e);
					throw e;
				},
			);
		} as typeof window.fetch;
	});
}

async function assetLog(name: string): Promise<Record<string, unknown>[]> {
	return browser.execute(
		(n) =>
			((window as unknown as { __assetLog: Record<string, unknown>[] }).__assetLog ?? []).filter((e) =>
				decodeURIComponent(String(e.url)).endsWith(`/${n}`),
			),
		name,
	);
}

/**
 * Click the row of `name` and wait, in the page, until the 3D viewer for that
 * file shows `done` (the refusal text or the triangle count). Returns the
 * wall-clock click time (ms since epoch, for the memory samples) and the time
 * from the click to the text.
 */
async function openAndWait(
	name: string,
	until: 'refused' | 'ready',
): Promise<{ clickAt: number; ms: number; text: string; sawLoading: boolean; error?: string }> {
	await waitForExplorerRow(uri(name), { timeout: 15_000 });
	return browser.executeAsync(
		(u, n, mode, done) => {
			const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find((r) => r.title === u);
			if (!row) {
				done({ clickAt: 0, ms: -1, text: '', sawLoading: false, error: 'row not found' });
				return;
			}
			let sawLoading = false;
			const t0 = performance.now();
			const clickAt = Date.now();
			const check = () => {
				const viewer = document.querySelector('.model-viewer');
				if (viewer?.querySelector('.model-name')?.textContent !== n) return;
				const message = viewer.querySelector('.model-message')?.textContent ?? '';
				const stats = viewer.querySelector('.model-stats')?.textContent ?? '';
				if (message.startsWith('Loading')) sawLoading = true;
				const text = mode === 'refused' ? message : stats;
				const hit = mode === 'refused' ? /too large/.test(message) : /\d+ (triangles|points)/.test(stats);
				if (hit) {
					observer.disconnect();
					clearInterval(timer);
					done({ clickAt, ms: Math.round((performance.now() - t0) * 10) / 10, text, sawLoading });
				}
			};
			const observer = new MutationObserver(check);
			observer.observe(document.body, { subtree: true, childList: true, characterData: true });
			const timer = setInterval(check, 10);
			row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
		},
		uri(name),
		name,
		until,
	);
}

describe('要件#23 追補d: an STL over 256 MB is refused at once without a memory jump (device gate)', function () {
	before(async function () {
		if (!DEVICE) {
			this.skip();
			return;
		}
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await installAssetSpy();
		await browser.setTimeout({ script: 90_000 });
	});

	it('control: a small STL shows (triangle count, canvas, pixels)', async function () {
		this.timeout(90_000);
		const r = await openAndWait('cube.stl', 'ready');
		const stage = await browser.execute(() => {
			const s = document.querySelector('.model-stage')!.getBoundingClientRect();
			const c = document.querySelector('.model-stage canvas') as HTMLCanvasElement | null;
			return { x: s.x, y: s.y, width: s.width, height: s.height, canvas: c ? { w: c.width, h: c.height } : null };
		});
		// Let the first frame land, then count the pixels of the stage that are
		// not the stage background (the corner).
		await browser.pause(500);
		const { file, bmp, dpr } = await shotBitmap('req23d-control-cube');
		const corner = pixelAt(bmp, Math.round((stage.x + 4) * dpr), Math.round((stage.y + 4) * dpr));
		let differing = 0;
		let total = 0;
		for (let y = stage.y + 8; y < stage.y + stage.height - 8; y += 8) {
			for (let x = stage.x + 8; x < stage.x + stage.width - 8; x += 8) {
				total++;
				if (pixelDistance(pixelAt(bmp, Math.round(x * dpr), Math.round(y * dpr)), corner) > 30) differing++;
			}
		}
		report(REPORT, {
			step: 'control cube.stl',
			ms_to_stats: r.ms,
			stats: r.text,
			canvas: stage.canvas,
			stage_pixels_sampled: total,
			stage_pixels_not_background: differing,
			screenshot: file,
			assets: await assetLog('cube.stl'),
		});
		expect(r.error).toBeUndefined();
		expect(r.text).toMatch(/12 triangles/);
		expect(stage.canvas).not.toBeNull();
		expect(differing).toBeGreaterThan(0);
	});

	for (const name of ['big-300m.stl', 'big-boundary.stl']) {
		it(`${name}: refused at once, no body request, no memory jump`, async function () {
			this.timeout(90_000);
			const procs = processes();
			const sampler = startSampler(
				procs.map((p) => p.pid),
				50,
				12,
			);
			await browser.pause(3_000);
			const r = await openAndWait(name, 'refused');
			const samples = await sampler;
			const deltas = memoryDelta(samples, procs, r.clickAt, name.replace('.stl', ''));
			const assets = await assetLog(name);
			const file = await shot(`req23d-refused-${name.replace('.stl', '')}`);
			report(REPORT, {
				step: `refuse ${name}`,
				ms_to_message: r.ms,
				message: r.text,
				saw_loading: r.sawLoading,
				assets,
				memory: deltas,
				screenshot: file,
			});
			expect(r.error).toBeUndefined();
			expect(r.text).toMatch(/^The file is too large \(\d+MB; limit 256MB\)$/);
			expect(assets.length).toBe(1);
			expect(assets[0].range).toBe('bytes=0-0');
			expect(assets[0].status).toBe(206);
			expect(String(assets[0].contentRange)).toMatch(/^bytes 0-0\/\d+$/);
			expect(Number(String(assets[0].contentRange).split('/')[1])).toBeGreaterThan(LIMIT);
			// Judged: the app and its WebContent process (the gate's wording). The
			// GPU process is recorded only: its footprint swings between about 24
			// and 156 MiB on every repaint, with or without a file being opened
			// (2026-10-21), while its resident size stays flat.
			for (const d of deltas.filter((p) => p.name === 'vellis' || p.name === 'com.apple.WebKit.WebContent')) {
				expect(d.samples.after).toBeGreaterThan(0);
				expect(d.rss.delta_mib).toBeLessThan(JUMP_MIB);
				expect(d.footprint.delta_mib).toBeLessThan(JUMP_MIB);
			}
		});
	}

	it('sensitivity: a 100 MB file under the limit is read in full, and the samples show it', async function () {
		this.timeout(90_000);
		const procs = processes();
		const sampler = startSampler(
			procs.map((p) => p.pid),
			50,
			15,
		);
		await browser.pause(3_000);
		await waitForExplorerRow(uri('sense-100m.stl'), { timeout: 15_000 });
		const clickAt = Date.now();
		await clickExplorerRow(uri('sense-100m.stl'));
		const samples = await sampler;
		const deltas = memoryDelta(samples, procs, clickAt, 'sense-100m');
		const outcome = await browser.execute(() => ({
			name: document.querySelector('.model-viewer .model-name')?.textContent ?? '',
			message: document.querySelector('.model-viewer .model-message')?.textContent ?? '',
			stats: document.querySelector('.model-viewer .model-stats')?.textContent ?? '',
		}));
		report(REPORT, {
			step: 'sensitivity sense-100m.stl (body fetched)',
			outcome,
			assets: await assetLog('sense-100m.stl'),
			memory: deltas,
		});
		const assets = await assetLog('sense-100m.stl');
		expect(assets.some((a) => a.range === null)).toBe(true);
		// The sampler would have caught a full read: the app rises past the bar.
		expect(deltas[0].rss.delta_mib).toBeGreaterThan(JUMP_MIB);
	});
});
