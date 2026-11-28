import { browser } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
	clickExplorerRow,
	emitMenu,
	installGateRecorder,
	report,
	restoreGateRecorder,
	SHOTS_DIR,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

/**
 * Requirement #91 (the audio spectrum at the playback position, up to 16 kHz) — AC-91-10, the device gate against the
 * live webview of a webdriver build on a real screen (docs/requirements/req-91.md contracts 1-12).
 *
 * Webdriver only where possible, no operator. The native menu is read by AX (`axtool menudetail <pid> View`, which
 * reports `enabled` and `mark` = the check) and pressed by `axtool menupress <pid> View "Show Audio Spectrum"`; when the
 * press fails the gate emits the item's event (`menu_show_spectrum`) and notes it.
 *
 * Fixtures (run-gate-spec.sh `req91` → req91-fixtures.sh, ffmpeg lavfi): clip.mp4 / clip.mov / clip.webm (video with a
 * stereo soundtrack) and take.wav / take.mp3 / take.m4a (stereo audio), all 4 s with L = 1 kHz and R = 5 kHz sines at
 * -12 dBFS (a -12 dBFS peak fills about 87 % of the band, well under the 95 % grid-line cut-off below even after a codec
 * raises it a little — reviewer P3-2), plus script.md (a Markdown file: the item must be grey while it is in front).
 *
 * What the gate judges (one JSON line per judgement in `$VELLIS_GATE_SHOTS/req91-report.jsonl`):
 *  - (1) for each of the six files: the band `[data-testid="audio-spectrum"]` is on screen between the video (the toolbar
 *        for audio) and the waveform band; its note goes away (the analysis finishes); after a seek to 2 s while paused the
 *        canvas holds drawn pixels in both lane halves with the L / R labels; the tallest column of the top half sits at
 *        1 kHz and of the bottom half at 5 kHz on the log axis (±10 % of the width; columns ≥ 95 % tall are grid lines and
 *        skipped) — contract 1 / 3 / 4 / 5 / 7 (AC-91-10 with AC-91-1 / 3 / 5 on the device)
 *  - (2) playback is not stopped: Play runs for a second with the band shown, then Pause (contract 8 / 10)
 *  - (3) View ▸ Show Audio Spectrum: a check item without a key, checked and enabled while clip.mp4 is in front; grey while
 *        script.md is in front (contract 11)
 *  - (4) pressing the item hides the band on the open video (and on an audio file opened afterwards); localStorage
 *        `vellis.spectrum-shown` = "0"; the check goes away (AX mark); pressing again brings it back; `restart` (the same
 *        home) opens clip.mp4 and finds the band absent with the item unchecked, then turns it back on (contract 11)
 *  - the last `it` fails when any judgement failed, so the wdio exit status is the verdict
 *
 * Build and run:
 *   pnpm tauri build --debug --no-bundle -f webdriver
 *   cp src-tauri/target/debug/vellis <out>/vellis-gate91
 *   xcrun swiftc -O scripts/gate-device/axtool.swift -o <out>/axtool
 *   export VELLIS_GATE_BIN=<out>/vellis-gate91 VELLIS_GATE_AXTOOL=<out>/axtool VELLIS_GATE_OUT=<out>
 *   VELLIS_GATE_HOME=<tmp> scripts/gate-device/run-gate-spec.sh req91 main
 *   VELLIS_GATE_HOME=<tmp> scripts/gate-device/run-gate-spec.sh req91 restart
 * Runs only under that script (VELLIS_GATE_DEVICE=1); self-skipping otherwise.
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const VARIANT = process.env.VELLIS_GATE_VARIANT ?? 'main';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const REPORT = 'req91-report.jsonl';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';

const fileOf = (rel: string) => path.join(root, rel);
const uriOf = (rel: string) => `file://${fileOf(rel).split(path.sep).join('/')}`;

const VIDEO_FILES = ['clip.mp4', 'clip.mov', 'clip.webm'];
const AUDIO_FILES = ['take.wav', 'take.mp3', 'take.m4a'];
const MARKDOWN = 'script.md';
const ITEM = 'Show Audio Spectrum';
const STORAGE_KEY = 'vellis.spectrum-shown';

const SPECTRUM = '[data-testid="audio-spectrum"]';
const SPECTRUM_DIVIDER = '.spectrum-divider';
const SPECTRUM_CANVAS = `${SPECTRUM} canvas.spectrum-canvas`;
const SPECTRUM_NOTE = `${SPECTRUM} .spectrum-note`;
const SPECTRUM_LABEL = `${SPECTRUM} .spectrum-lane-label`;
const WAVEFORM_DIVIDER = '.waveform-divider';
const L_HZ = 1000;
const R_HZ = 5000;
const MIN_HZ = 20;
const MAX_HZ = 16000;

// --- judgement ---------------------------------------------------------------------------------

const fails: string[] = [];
function judge(gate: string, item: string, pass: boolean, extra: Record<string, unknown> = {}): boolean {
	report(REPORT, { gate, item, pass, variant: VARIANT, ...extra });
	if (!pass) fails.push(`${gate}: ${item}`);
	return pass;
}
function fact(gate: string, item: string, extra: Record<string, unknown> = {}): void {
	report(REPORT, { gate, item, variant: VARIANT, ...extra });
}
function skipped(gate: string, item: string, why: string): void {
	report(REPORT, { gate, item, variant: VARIANT, note: `skipped: ${why}` });
}

// --- AX (the native menu) ------------------------------------------------------------------------

function appPid(): number | null {
	if (!axtool || !bin) return null;
	try {
		const env = { ...process.env, AXTOOL_EXPECT_EXE: bin };
		const first = execFileSync(axtool, ['pids-of-exe', bin], { encoding: 'utf8', env, timeout: 30_000 }).trim().split('\n')[0];
		return first ? (JSON.parse(first) as { pid: number }).pid : null;
	} catch {
		return null;
	}
}
interface MenuItemFacts {
	title: string;
	enabled: boolean;
	separator?: boolean;
	submenu?: boolean;
	mark?: string;
	cmd_char?: string;
}
function viewMenuDetail(pid: number): MenuItemFacts[] | null {
	try {
		const env = { ...process.env, AXTOOL_EXPECT_EXE: bin };
		const out = execFileSync(axtool, ['menudetail', String(pid), 'View'], { encoding: 'utf8', env, timeout: 30_000 });
		return out
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as MenuItemFacts);
	} catch {
		return null;
	}
}
function spectrumItem(pid: number | null): MenuItemFacts | null {
	if (pid === null) return null;
	return viewMenuDetail(pid)?.find((i) => i.title === ITEM) ?? null;
}
function pressSpectrumItem(pid: number): { pressed: boolean; detail: string } {
	try {
		const env = { ...process.env, AXTOOL_EXPECT_EXE: bin };
		const out = execFileSync(axtool, ['menupress', String(pid), 'View', ITEM], { encoding: 'utf8', env, timeout: 30_000 }).trim();
		const parsed = JSON.parse(out.split('\n').filter(Boolean).at(-1) ?? '{}') as { pressed?: boolean };
		return { pressed: parsed.pressed === true, detail: out };
	} catch (e) {
		const err = e as { stderr?: string; message?: string };
		return { pressed: false, detail: err.stderr?.trim() || err.message || String(e) };
	}
}
/** Toggle the item: through the menu bar by AX when it works, else by the event the item emits. */
async function toggleSpectrum(pid: number | null): Promise<string> {
	if (pid !== null) {
		const r = pressSpectrumItem(pid);
		if (r.pressed) {
			await browser.pause(600);
			return `ax:${r.detail}`;
		}
		fact('4', 'AX press of View ▸ Show Audio Spectrum did not work; falling back to the event', { detail: r.detail });
	}
	await emitMenu('menu_show_spectrum');
	await browser.pause(600);
	return 'event';
}

// --- the page ----------------------------------------------------------------------------------

interface Rect {
	top: number;
	bottom: number;
	left: number;
	width: number;
	height: number;
}
interface BandFacts {
	band: Rect | null;
	divider: Rect | null;
	anchor: Rect | null;
	waveformDivider: Rect | null;
	waveform: Rect | null;
	note: string | null;
	labels: string[];
	bandDisplay: string | null;
	media: { tag: string; paused: boolean; currentTime: number; duration: number } | null;
}
async function bandFacts(kind: 'video' | 'audio'): Promise<BandFacts> {
	return browser.execute(
		(sel, k) => {
			const rect = (el: Element | null) => {
				if (!el) return null;
				const r = el.getBoundingClientRect();
				return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
			};
			const band = document.querySelector<HTMLElement>(sel.band);
			const media = document.querySelector<HTMLMediaElement>(k === 'video' ? 'video.video' : 'audio');
			return {
				band: rect(band),
				divider: rect(document.querySelector(sel.divider)),
				anchor: rect(document.querySelector(k === 'video' ? '.video-stage' : '.audio-toolbar')),
				waveformDivider: rect(document.querySelector(sel.waveformDivider)),
				waveform: rect(document.querySelector(k === 'video' ? '.video-waveform' : '.audio-waveform')),
				note: document.querySelector(sel.note)?.textContent?.trim() ?? null,
				labels: Array.from(document.querySelectorAll(sel.label)).map((el) => el.textContent?.trim() ?? ''),
				bandDisplay: band ? getComputedStyle(band).display : null,
				media: media
					? { tag: media.tagName.toLowerCase(), paused: media.paused, currentTime: media.currentTime, duration: media.duration }
					: null,
			};
		},
		{ band: SPECTRUM, divider: SPECTRUM_DIVIDER, note: SPECTRUM_NOTE, label: SPECTRUM_LABEL, waveformDivider: WAVEFORM_DIVIDER },
		kind,
	);
}
interface CanvasFacts {
	found: boolean;
	cssWidth: number;
	cssHeight: number;
	ratio: number;
	drawnTop: number;
	drawnBottom: number;
	peakTopX: number | null;
	peakBottomX: number | null;
}
/**
 * The spectrum canvas: drawn (alpha > 0) pixel counts in the top and bottom halves (the two lanes), and the CSS x of the
 * tallest column of each half, ignoring columns that are at least 95 % tall (vertical grid lines).
 */
async function canvasFacts(): Promise<CanvasFacts> {
	return browser.execute((sel) => {
		const canvas = document.querySelector<HTMLCanvasElement>(sel);
		if (!canvas) return { found: false, cssWidth: 0, cssHeight: 0, ratio: 1, drawnTop: 0, drawnBottom: 0, peakTopX: null, peakBottomX: null };
		const rect = canvas.getBoundingClientRect();
		const ctx = canvas.getContext('2d');
		if (!ctx || canvas.width === 0 || canvas.height === 0) {
			return { found: true, cssWidth: rect.width, cssHeight: rect.height, ratio: 1, drawnTop: 0, drawnBottom: 0, peakTopX: null, peakBottomX: null };
		}
		const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		const half = Math.floor(canvas.height / 2);
		const ratio = canvas.width / rect.width;
		const columns = (y0: number, y1: number) => {
			const out = new Array<number>(canvas.width).fill(0);
			for (let y = y0; y < y1; y++) {
				const row = y * canvas.width * 4;
				for (let x = 0; x < canvas.width; x++) if (img[row + x * 4 + 3]! > 0) out[x]!++;
			}
			return out;
		};
		const peak = (cols: number[], laneHeight: number) => {
			let best = -1;
			let bestCount = 0;
			for (let x = 0; x < cols.length; x++) {
				const c = cols[x]!;
				if (c >= laneHeight * 0.95) continue;
				if (c > bestCount) {
					bestCount = c;
					best = x;
				}
			}
			return best < 0 ? null : best / ratio;
		};
		const top = columns(0, half);
		const bottom = columns(half, canvas.height);
		return {
			found: true,
			cssWidth: rect.width,
			cssHeight: rect.height,
			ratio,
			drawnTop: top.reduce((a, b) => a + b, 0),
			drawnBottom: bottom.reduce((a, b) => a + b, 0),
			peakTopX: peak(top, half),
			peakBottomX: peak(bottom, canvas.height - half),
		};
	}, SPECTRUM_CANVAS);
}
function expectedX(hz: number, width: number): number {
	return (width * Math.log(hz / MIN_HZ)) / Math.log(MAX_HZ / MIN_HZ);
}
async function seekTo(kind: 'video' | 'audio', seconds: number): Promise<boolean> {
	return browser.execute(
		(sel, s) => {
			const input = document.querySelector<HTMLInputElement>(sel);
			if (!input) return false;
			input.value = String(s);
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('change', { bubbles: true }));
			return true;
		},
		kind === 'video' ? 'input.video-seek' : 'input.audio-seek',
		seconds,
	);
}
async function clickButton(text: string): Promise<boolean> {
	return browser.execute((t) => {
		const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent ?? '').trim() === t);
		if (!button) return false;
		button.click();
		return true;
	}, text);
}
async function storedSetting(): Promise<string | null> {
	return browser.execute((k) => localStorage.getItem(k), STORAGE_KEY);
}
async function exists(sel: string): Promise<boolean> {
	return browser.execute((s) => document.querySelector(s) !== null, sel);
}
async function shot(name: string): Promise<string> {
	const file = path.join(SHOTS_DIR, `${name}.png`);
	fs.mkdirSync(SHOTS_DIR, { recursive: true });
	await browser.saveScreenshot(file);
	return file;
}
function kindOf(name: string): 'video' | 'audio' {
	return VIDEO_FILES.includes(name) ? 'video' : 'audio';
}
async function openMedia(name: string): Promise<void> {
	const kind = kindOf(name);
	await clickExplorerRow(uriOf(name));
	await browser.waitUntil(async () => (await bandFacts(kind)).media !== null, { timeout: 20_000, timeoutMsg: `open ${name}: no <${kind}>` });
	await browser.waitUntil(async () => Number.isFinite((await bandFacts(kind)).media?.duration ?? Number.NaN), {
		timeout: 20_000,
		timeoutMsg: `open ${name}: no duration`,
	});
	await browser.pause(400);
}
async function openMarkdown(): Promise<void> {
	await clickExplorerRow(uriOf(MARKDOWN));
	await browser.waitUntil(async () => !(await exists('video.video')) && !(await exists('audio')), { timeout: 20_000, timeoutMsg: 'open script.md' });
	await browser.pause(400);
}

// --- the gates ---------------------------------------------------------------------------------

async function gateSpectrumOn(name: string): Promise<void> {
	const kind = kindOf(name);
	const tag = `1:${name}`;
	await openMedia(name);
	const first = await bandFacts(kind);
	judge(tag, 'the spectrum band and its divider are on screen right after opening', first.band !== null && first.divider !== null && first.bandDisplay !== 'none' && (first.band?.height ?? 0) > 0, { first });
	if (first.band && first.anchor && first.waveform && first.divider && first.waveformDivider) {
		const between = first.band.top >= first.anchor.bottom - 2 && first.divider.top >= first.anchor.bottom - 2 && first.band.bottom <= first.waveformDivider.top + 2 && first.waveformDivider.top <= first.waveform.top + 2;
		judge(tag, `the band sits between the ${kind === 'video' ? 'video' : 'toolbar'} and the waveform band (its divider above it, the waveform's divider below)`, between, { band: first.band, divider: first.divider, anchor: first.anchor, waveformDivider: first.waveformDivider, waveform: first.waveform });
	} else {
		judge(tag, 'the band, the divider, the anchor and the waveform band are all on screen', false, { first });
	}
	// The analysis finishes: the note (analyzing / a reason) goes away.
	await browser.waitUntil(async () => (await bandFacts(kind)).note === null, { timeout: 60_000 }).catch(() => undefined);
	const ready = await bandFacts(kind);
	judge(tag, 'the analysis finishes: no note in the band (no degraded reason)', ready.note === null, { note: ready.note });
	judge(tag, 'the stereo fixture shows the L / R lane labels', JSON.stringify(ready.labels) === JSON.stringify(['L', 'R']), { labels: ready.labels });
	// Seek to 2 s while paused: the spectrum of that position is drawn (contract 7).
	const sought = await seekTo(kind, 2.0);
	await browser.waitUntil(async () => Math.abs(((await bandFacts(kind)).media?.currentTime ?? 0) - 2.0) < 0.3, { timeout: 8_000 }).catch(() => undefined);
	await browser.pause(800);
	const after = await bandFacts(kind);
	judge(tag, 'the seek bar moves the paused position to 2 s', sought && after.media !== null && after.media.paused && Math.abs(after.media.currentTime - 2.0) < 0.3, { media: after.media });
	const canvas = await canvasFacts();
	judge(tag, 'the spectrum canvas holds drawn pixels in both lane halves while paused at 2 s', canvas.found && canvas.drawnTop > 0 && canvas.drawnBottom > 0, { canvas });
	if (canvas.found && canvas.cssWidth > 0) {
		const tol = canvas.cssWidth * 0.1;
		const lx = expectedX(L_HZ, canvas.cssWidth);
		const rx = expectedX(R_HZ, canvas.cssWidth);
		judge(tag, 'the tallest column of the top lane is at 1 kHz and of the bottom lane at 5 kHz on the 20 Hz…16 kHz log axis (±10 % of the width)', canvas.peakTopX !== null && canvas.peakBottomX !== null && Math.abs(canvas.peakTopX - lx) <= tol && Math.abs(canvas.peakBottomX - rx) <= tol, {
			peakTopX: canvas.peakTopX,
			expectedTopX: lx,
			peakBottomX: canvas.peakBottomX,
			expectedBottomX: rx,
			width: canvas.cssWidth,
		});
	}
	fact(tag, 'screenshot with the spectrum at 2 s', { file: await shot(`req91-1-${name.replace('.', '-')}`) });
}

async function gatePlayback(name: string): Promise<void> {
	const kind = kindOf(name);
	await openMedia(name);
	await browser.waitUntil(async () => (await bandFacts(kind)).note === null, { timeout: 60_000 }).catch(() => undefined);
	const played = await clickButton('Play');
	await browser.pause(1200);
	const during = await bandFacts(kind);
	judge('2', `playback runs with the spectrum band shown (${name})`, played && during.media !== null && !during.media.paused && during.media.currentTime > 0.5 && during.band !== null && during.note === null, { media: during.media, note: during.note });
	const canvas = await canvasFacts();
	judge('2', 'the spectrum is drawn during playback', canvas.found && canvas.drawnTop > 0 && canvas.drawnBottom > 0, { drawnTop: canvas.drawnTop, drawnBottom: canvas.drawnBottom });
	await clickButton('Pause');
	await browser.pause(300);
	const after = await bandFacts(kind);
	judge('2', 'Pause stops it again (the spectrum did not interfere with the controls)', after.media !== null && after.media.paused, { media: after.media });
}

async function gateMenu(pid: number | null): Promise<void> {
	if (pid === null) {
		skipped('3', 'View ▸ Show Audio Spectrum by AX', 'no app pid (axtool / VELLIS_GATE_BIN)');
		return;
	}
	await openMedia('clip.mp4');
	const onVideo = spectrumItem(pid);
	judge('3', 'View holds "Show Audio Spectrum" (AX menudetail)', onVideo !== null, { view: viewMenuDetail(pid)?.map((i) => i.title) });
	if (onVideo) {
		judge('3', 'with clip.mp4 in front the item is enabled, checked (mark) and has no key equivalent', onVideo.enabled === true && (onVideo.mark ?? '') !== '' && (onVideo.cmd_char ?? '') === '', { item: onVideo });
	}
	await openMarkdown();
	const onMarkdown = spectrumItem(pid);
	judge('3', 'with script.md in front the item is grey (disabled) and still checked', onMarkdown !== null && onMarkdown.enabled === false && (onMarkdown.mark ?? '') !== '', { item: onMarkdown });
	fact('3', 'screenshot with the Markdown file in front', { file: await shot('req91-3-markdown-front') });
}

async function gateToggle(pid: number | null): Promise<void> {
	await openMedia('clip.mp4');
	await browser.waitUntil(async () => (await bandFacts('video')).note === null, { timeout: 60_000 }).catch(() => undefined);
	judge('4', 'before: the band is shown and the setting is on (or unset)', (await exists(SPECTRUM)) && ((await storedSetting()) === null || (await storedSetting()) === '1'), { setting: await storedSetting() });
	const how = await toggleSpectrum(pid);
	await browser.waitUntil(async () => !(await exists(SPECTRUM)), { timeout: 5_000 }).catch(() => undefined);
	judge('4', 'View ▸ Show Audio Spectrum hides the band and its divider; the waveform stays', !(await exists(SPECTRUM)) && !(await exists(SPECTRUM_DIVIDER)) && (await exists('.video-waveform')), { how });
	judge('4', 'localStorage vellis.spectrum-shown is "0"', (await storedSetting()) === '0', { setting: await storedSetting() });
	const item = spectrumItem(pid);
	if (item) judge('4', 'the item lost its check (AX mark)', (item.mark ?? '') === '', { item });
	else skipped('4', 'the check of the item by AX', 'no pid');
	fact('4', 'screenshot with the spectrum hidden', { file: await shot('req91-4-hidden') });
	// The setting is one for the app: an audio file opened now has no band either.
	await openMedia('take.mp3');
	await browser.pause(800);
	judge('4', 'an audio file opened while hidden shows no band either (one app-wide setting)', !(await exists(SPECTRUM)) && (await exists('.audio-waveform')), {});
	const how2 = await toggleSpectrum(pid);
	await browser.waitUntil(async () => await exists(SPECTRUM), { timeout: 5_000 }).catch(() => undefined);
	judge('4', 'pressing again shows the band on the audio file', (await exists(SPECTRUM)) && (await exists(SPECTRUM_DIVIDER)), { how: how2 });
	judge('4', 'localStorage vellis.spectrum-shown is "1" again', (await storedSetting()) === '1', { setting: await storedSetting() });
	const item2 = spectrumItem(pid);
	if (item2) judge('4', 'the item is checked again (AX mark)', (item2.mark ?? '') !== '', { item: item2 });
	// Leave it hidden for the restart run.
	await toggleSpectrum(pid);
	await browser.waitUntil(async () => !(await exists(SPECTRUM)), { timeout: 5_000 }).catch(() => undefined);
	judge('4', 'left hidden for the restart run (setting "0")', (await storedSetting()) === '0' && !(await exists(SPECTRUM)), {});
}

async function gateRestart(pid: number | null): Promise<void> {
	judge('5', 'restart: localStorage still holds the setting "0" from the first run', (await storedSetting()) === '0', { setting: await storedSetting() });
	await openMedia('clip.mp4');
	await browser.pause(800);
	judge('5', 'restart: clip.mp4 opens without the spectrum band (the setting survived)', !(await exists(SPECTRUM)) && (await exists('.video-waveform')), {});
	const item = spectrumItem(pid);
	if (item) judge('5', 'restart: the item is enabled on the video and unchecked', item.enabled === true && (item.mark ?? '') === '', { item });
	else skipped('5', 'the item by AX', 'no pid');
	const how = await toggleSpectrum(pid);
	await browser.waitUntil(async () => await exists(SPECTRUM), { timeout: 5_000 }).catch(() => undefined);
	await browser.waitUntil(async () => (await bandFacts('video')).note === null, { timeout: 60_000 }).catch(() => undefined);
	judge('5', 'restart: turning it on brings the band back and it analyses', (await exists(SPECTRUM)) && (await bandFacts('video')).note === null && (await storedSetting()) === '1', { how });
	fact('5', 'screenshot after the restart with the band back', { file: await shot('req91-5-restart') });
}

// --- the run -----------------------------------------------------------------------------------

describe('Requirement #91 gate: the audio spectrum band on mp4 / mov / webm / wav / mp3 / m4a and View ▸ Show Audio Spectrum', function () {
	this.timeout(1_200_000);
	let pid: number | null = null;
	before(async function () {
		if (!DEVICE) this.skip();
		await waitForAppMounted();
		await installGateRecorder();
		await waitForExplorerRow(uriOf('clip.mp4'), { timeout: 30_000 });
		pid = appPid();
		fact('setup', 'the app is up with the fixtures', { root, variant: VARIANT, pid, files: fs.readdirSync(root) });
	});
	afterEach(async function () {
		if (!DEVICE) return;
		if (this.currentTest?.state === 'failed') {
			report(REPORT, { gate: 'failed', variant: VARIANT, test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
		}
	});
	after(async function () {
		if (!DEVICE) return;
		report(REPORT, { gate: 'teardown', variant: VARIANT, fails });
		await restoreGateRecorder().catch(() => undefined);
	});

	if (VARIANT === 'restart') {
		it('gate (5): the hidden setting survived the restart; turning it on brings the band back', async () => {
			await gateRestart(pid);
		});
	} else {
		for (const name of [...VIDEO_FILES, ...AUDIO_FILES]) {
			it(`gate (1): ${name} — the band between the player and the waveform, ready, L / R, peaks at 1 kHz and 5 kHz at 2 s`, async () => {
				await gateSpectrumOn(name);
			});
		}
		it('gate (2): playback runs with the band shown (mp4 and mp3)', async () => {
			await gatePlayback('clip.mp4');
			await gatePlayback('take.mp3');
		});
		it('gate (3): View ▸ Show Audio Spectrum — checked and enabled on a video, grey on a Markdown file (AX)', async () => {
			await gateMenu(pid);
		});
		it('gate (4): the item hides and shows the band for every media file; the setting is stored', async () => {
			await gateToggle(pid);
		});
	}
	it('verdict: every judgement passed', () => {
		fact('verdict', fails.length === 0 ? 'all judgements passed' : `${fails.length} judgement(s) failed`, { fails });
		if (fails.length > 0) throw new Error(`req91 gate: ${fails.length} judgement(s) failed:\n${fails.join('\n')}`);
	});
});
