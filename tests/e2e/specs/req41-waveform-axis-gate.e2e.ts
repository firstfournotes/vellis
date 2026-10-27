import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	clickExplorerRow,
	installGateRecorder,
	pixelAt,
	pixelDistance,
	report,
	restoreGateRecorder,
	shotBitmap,
	waitForAppMounted,
	waitForExplorerRow,
	zoomedShot,
	type Bitmap,
} from '../gate-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Requirement #41 addendum g, acceptance (d) (docs/requirements/req-41.md
 * 「追補g」): the waveform band's time axis must coincide with the range the
 * native seek bar's thumb centre travels. Driven on the webdriver build; the
 * 2026-10-01 gate-41 measurement written as a spec. Not part of the loop's
 * machine evaluation (CLAUDE.md) — run it alone:
 *
 *   scripts/e2e.sh --spec tests/e2e/specs/req41-waveform-axis-gate.e2e.ts
 *
 * How things are measured (追補g (d) 「測り方」):
 *  - thumb centre: the native thumb is not in the DOM, so a screenshot is read
 *    back (gate-helpers `decodePng`) and, on the rows of the `<input
 *    type="range">` box that are not the track (no run longer than
 *    TRACK_RUN_CSS px), the columns that differ from the controls' background
 *    are the thumb; its centre is the middle of that run, in CSS px
 *  - playhead line: `.waveform-head` rect left + 0.5 (the 1px line's centre)
 *  - marker peak: centroid of the canvas columns (ImageData, device px) that
 *    rise above the silent baseline, within ±PEAK_SEARCH_CSS px of the playhead.
 *    The playhead is put on the marker's own time (2 / 5 / 8 s, `MARKS`) for
 *    every head-vs-peak item, zoomed included (追補h 契約2: not `D / 2` — an
 *    ffmpeg m4a reports D = 9.977 s, so D / 2 sits 11 ms before the 5 s marker)
 *  - window indicator: `.seek-window-indicator` rect
 *  - the position is set while paused (`media.currentTime = t`) and read back
 *    once the seek bar's value has settled; a video's bar shows the presented
 *    frame's time, so the value may sit a frame before `t` (recorded as
 *    `41g-seek-landing`), and the window-end comparison carries the thumb
 *    from that frame to the window's end with the thumb's measured travel rate
 *  - zoomed window, two ways: the thumb-vs-indicator checks use the window
 *    estimated from the band's own axis (two playhead positions → px/s and the
 *    time at the canvas' left edge; `41g-d-zoom-window`). That estimate is good
 *    to about one band pixel (≈ 1.5 ms for 10 s), which is fine for ±1 px checks
 *    but coarser than TOLERANCE_S, so the **zoomed margin-click checks** compare
 *    against the window the zoom rule puts there instead: ×2 twice about the
 *    axis centre from [0, D] is exactly [3D/8, 5D/8] (`zoomWindowByRule`,
 *    requirement #47 contract ④), cross-checked against the window read back
 *    from the indicator's rect (`41g-d-zoom-window-reference`). For a material
 *    that snaps to frames (mp4 / mov) the expected landing is where the seek
 *    bar lands when released at exactly that time (`scrubCommit` with the
 *    range's `step="0.001"` bypassed for the commit, so the 1 ms rounding of
 *    the bar does not enter the reference); for webm / wav / m4a it is the
 *    time itself (契約5: 索引なしは s / s + w). Items
 *    `4x left margin click - window start (s)` / `4x right margin click -
 *    window end (s)`; the report entry says which reference was used
 *    (2026-10-09: the previous band-pixel + 1 ms-step reference made webm's
 *    left margin read +1.06 ms with the product exactly at s)
 *
 * Every number goes to `$VELLIS_GATE_SHOTS/req41-report.jsonl`; a few zoomed
 * crops of the seek row go next to it. The pre-measurement for the loop's
 * step 0 ((i) `SEEK_THUMB_INSET_PX`, (ii) does the audio viewer show the same
 * offset) is the `41g-0-*` entries of that report.
 *
 * Materials (built in `before()` with ffmpeg): 10 s, stereo 48 kHz, silence
 * with an 8 ms 1 kHz click centred on 2, 5 and 8 s. Video = mp4 (H.264 + AAC),
 * mov (H.264 + PCM), webm (VP9 + Opus, no frame index); audio = wav, m4a.
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const gateDir = path.join(startRoot, 'req41-gate');
const REPORT = 'req41-report.jsonl';
const DURATION = 10;
const MARKS = [2, 5, 8];
/** ±px the (d) criteria allow. */
const TOLERANCE_PX = 1;
/** Seconds a margin click may land away from the seek bar's own landing. */
const TOLERANCE_S = 0.001;
/** A row of the range box whose non-background run is longer than this is track, not thumb. */
const TRACK_RUN_CSS = 30;
/** Sum of |Δr|+|Δg|+|Δb| above which a screenshot pixel is "not background". */
const PIXEL_THRESHOLD = 30;
/**
 * Half-width (CSS px) of the canvas window searched for a marker peak around the playhead.
 * Must cover more than the tolerance plus the click's drawn width (追補h 契約3): at ±8 an
 * offset beyond ~5 px cut one side of the peak off and the centroid under-reported it.
 */
const PEAK_SEARCH_CSS = 24;
/**
 * Bar px within which the window read back from the indicator's rect must agree with the
 * zoom rule's window before the latter is used as the margin-click reference. Layout rounds
 * rects to 1/64 px, so a real disagreement (a changed zoom rule, a window that followed the
 * position) is tens of px; 0.25 px only rules out the reference pointing somewhere else.
 */
const ZOOM_WINDOW_AGREE_PX = 0.25;

const uri = (p: string) => `file://${p}`;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

type Kind = 'video' | 'audio';

interface Material {
	name: string;
	kind: Kind;
	/** The app builds a frame index (requirement #37) for it — clicks snap to frames. */
	indexed: boolean;
}

const materials: Material[] = [
	{ name: 'clicks.mp4', kind: 'video', indexed: true },
	{ name: 'clicks.mov', kind: 'video', indexed: true },
	{ name: 'clicks.webm', kind: 'video', indexed: false },
	{ name: 'clicks.wav', kind: 'audio', indexed: false },
	{ name: 'clicks.m4a', kind: 'audio', indexed: false },
];

const SEL: Record<Kind, { media: string; seek: string; track: string; band: string; frameReadout: string | null }> = {
	video: { media: '.video-pane video', seek: '.video-seek', track: '.video-seek-track', band: '.video-waveform', frameReadout: '.video-frame' },
	audio: { media: '.audio-pane audio', seek: '.audio-seek', track: '.audio-seek-track', band: '.audio-waveform', frameReadout: null },
};

// --- fixtures -------------------------------------------------------------

function buildFixtures(): void {
	fs.rmSync(gateDir, { recursive: true, force: true });
	fs.mkdirSync(gateDir, { recursive: true });
	const click = MARKS.map((m) => `lt(abs(t-${m})\\,0.004)`).join('+');
	const audio = `aevalsrc=0.9*sin(2*PI*1000*t)*(${click}):s=48000:c=stereo:d=${DURATION}`;
	const video = `color=c=gray:s=320x180:r=25:d=${DURATION}`;
	const run = (args: string[]) =>
		execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
	const out = (n: string) => path.join(gateDir, n);
	run(['-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i', audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', out('clicks.mp4')]);
	run(['-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i', audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', out('clicks.mov')]);
	run(['-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i', audio, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', out('clicks.webm')]);
	run(['-f', 'lavfi', '-i', audio, '-c:a', 'pcm_s16le', out('clicks.wav')]);
	run(['-f', 'lavfi', '-i', audio, '-c:a', 'aac', '-b:a', '128k', out('clicks.m4a')]);
}

// --- reading the viewer -------------------------------------------------------

interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

interface ViewerState {
	ready: boolean;
	src: string;
	media: { currentTime: number; duration: number; paused: boolean; seeking: boolean; readyState: number } | null;
	seek: { rect: Box; value: number; max: number; disabled: boolean } | null;
	/** The seek bar's track (`.video-seek-track` / `.audio-seek-track`): the window indicator's containing block. */
	track: Box | null;
	band: Box | null;
	canvas: Box | null;
	/** Viewport x (CSS px) of the playhead line's centre, or null when it is not shown. */
	headX: number | null;
	note: string | null;
	indicator: Box | null;
	frameReadout: boolean | null;
	activeRow: string | null;
}

async function readState(kind: Kind): Promise<ViewerState> {
	return browser.execute((s) => {
		const box = (el: Element): Box => {
			const r = el.getBoundingClientRect();
			return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
		};
		const media = document.querySelector<HTMLMediaElement>(s.media);
		const seek = document.querySelector<HTMLInputElement>(s.seek);
		const track = document.querySelector<HTMLElement>(s.track);
		const band = document.querySelector<HTMLElement>(s.band);
		const canvas = band?.querySelector('canvas.waveform-canvas') ?? null;
		const head = band?.querySelector('.waveform-head') ?? null;
		const note = band?.querySelector('.waveform-note') ?? null;
		const ind = document.querySelector('.seek-window-indicator');
		return {
			ready: !!(media && seek && band && canvas),
			src: media?.currentSrc ?? '',
			media: media
				? { currentTime: media.currentTime, duration: media.duration, paused: media.paused, seeking: media.seeking, readyState: media.readyState }
				: null,
			seek: seek ? { rect: box(seek), value: Number(seek.value), max: Number(seek.max), disabled: seek.disabled } : null,
			track: track ? box(track) : null,
			band: band ? box(band) : null,
			canvas: canvas ? box(canvas) : null,
			headX: head ? box(head).left + 0.5 : null,
			note: note?.textContent ?? null,
			indicator: ind ? box(ind) : null,
			frameReadout: s.frameReadout ? !!document.querySelector(s.frameReadout) : null,
			activeRow: document.querySelector<HTMLElement>('.explorer-item.active')?.title ?? null,
		};
	}, SEL[kind]);
}

/** Per-column count of drawn (alpha > 0) device pixels of the waveform canvas. */
async function canvasColumns(kind: Kind): Promise<{ columns: number[]; ratio: number; left: number }> {
	return browser.execute((s) => {
		const canvas = document.querySelector<HTMLCanvasElement>(`${s.band} canvas.waveform-canvas`)!;
		const rect = canvas.getBoundingClientRect();
		const ctx = canvas.getContext('2d')!;
		const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
		const columns = new Array<number>(canvas.width).fill(0);
		for (let y = 0; y < canvas.height; y++) {
			const row = y * canvas.width * 4;
			for (let x = 0; x < canvas.width; x++) if (img.data[row + x * 4 + 3]! > 0) columns[x]!++;
		}
		return { columns, ratio: canvas.width / rect.width, left: rect.left };
	}, SEL[kind]);
}

/**
 * Centroid (viewport CSS px) of the marker peak near `aroundX`: the canvas
 * columns within ±PEAK_SEARCH_CSS whose drawn height exceeds the silent
 * baseline (median column), weighted by the excess.
 */
async function peakX(kind: Kind, aroundX: number): Promise<{ x: number | null; weight: number; baseline: number }> {
	const { columns, ratio, left } = await canvasColumns(kind);
	const sorted = [...columns].sort((a, b) => a - b);
	const baseline = sorted[Math.floor(sorted.length / 2)] ?? 0;
	const from = Math.max(0, Math.floor((aroundX - PEAK_SEARCH_CSS - left) * ratio));
	const to = Math.min(columns.length - 1, Math.ceil((aroundX + PEAK_SEARCH_CSS - left) * ratio));
	let sum = 0;
	let weight = 0;
	for (let i = from; i <= to; i++) {
		const w = Math.max(0, columns[i]! - baseline - 1);
		sum += w * (i + 0.5);
		weight += w;
	}
	return { x: weight > 0 ? left + sum / weight / ratio : null, weight, baseline };
}

async function openMaterial(m: Material): Promise<ViewerState> {
	const target = uri(path.join(gateDir, m.name));
	await clickExplorerRow(target);
	let last: ViewerState | null = null;
	await browser.waitUntil(
		async () => {
			const s = await readState(m.kind);
			last = s;
			return (
				s.ready &&
				s.activeRow === target &&
				s.src.includes(m.name) &&
				s.seek!.max > 0 &&
				!s.seek!.disabled &&
				s.note === null &&
				s.headX !== null &&
				(!m.indexed || s.frameReadout === true)
			);
		},
		{ timeout: 30_000, timeoutMsg: `${m.name} never became ready (${JSON.stringify(last)})` },
	);
	await browser.waitUntil(
		async () => {
			const { columns } = await canvasColumns(m.kind);
			return columns.some((c) => c > 0);
		},
		{ timeout: 15_000, timeoutMsg: `${m.name}: the waveform canvas stayed blank` },
	);
	await browser.pause(300);
	return readState(m.kind);
}

/**
 * Put the paused media at `t` and wait until the seek bar's value has
 * settled. The bar may show something other than `t`: the video viewer shows
 * the *presented* frame's time (VideoViewer's `report()` from rVFC), so a seek to the
 * duration settles on the last frame (9.96 s for 25 fps × 10 s), and a media
 * element may clamp the request. The thumb and the playhead both follow the
 * bar's value, which is what the comparisons use; a landing away from `t` is
 * recorded (`41g-seek-landing`).
 */
async function seekTo(kind: Kind, t: number, material = ''): Promise<ViewerState> {
	await browser.execute(
		(s, time) => {
			const media = document.querySelector<HTMLMediaElement>(s.media)!;
			media.currentTime = time;
		},
		SEL[kind],
		t,
	);
	let last = '';
	let previous = Number.NaN;
	let settledReads = 0;
	try {
		await browser.waitUntil(
			async () => {
				const s = await readState(kind);
				last = JSON.stringify({ media: s.media, value: s.seek?.value, headX: s.headX });
				const media = s.media!;
				const value = s.seek!.value;
				// Settled = not seeking, the bar is within 0.1 s of the request (the presented frame may sit
				// a frame or two before it, e.g. the last webm frame at 9.96 s for a 10.0135 s duration), and
				// three reads in a row agree.
				const nearRequest = Math.abs(value - Math.min(t, media.duration)) <= 0.1;
				settledReads = !media.seeking && nearRequest && value === previous ? settledReads + 1 : 0;
				previous = value;
				return settledReads >= 2;
			},
			{ timeout: 10_000, interval: 100 },
		);
	} catch (e) {
		throw new Error(`seek to ${t} did not settle (${last}): ${String(e)}`);
	}
	await browser.pause(150);
	const state = await readState(kind);
	if (Math.abs(state.seek!.value - t) > 2e-3) {
		report(REPORT, { gate: '41g-seek-landing', material, requested: t, mediaTime: state.media!.currentTime, barValue: state.seek!.value });
	}
	return state;
}

/**
 * Put the range input's value itself at `value` (no event, nothing else moves):
 * for step 0 (i), which is about where the native thumb sits for a value, not
 * where the media can land (a video cannot present a frame at its duration).
 * The caller restores the previous value afterwards.
 */
async function setBarValue(kind: Kind, value: number): Promise<number> {
	await browser.execute(
		(s, v) => {
			document.querySelector<HTMLInputElement>(s.seek)!.value = String(v);
		},
		SEL[kind],
		value,
	);
	await browser.pause(150);
	return (await readState(kind)).seek!.value;
}

/**
 * Release the seek bar at `value` (input + change), the way a scrub ends; returns where the media landed.
 * The range has `step="0.001"`, so the browser rounds `value` to 1 ms before the viewer reads it — that is
 * what a real release does, and the 1× margin checks keep it. With `exactStep` the step is set to `any`
 * for the commit (and put back afterwards) so the viewer's commit handler receives `value` itself: used
 * where the reference time is not on the 1 ms grid (the zoomed window's ends) and the rounding would
 * otherwise be read as a product difference.
 */
async function scrubCommit(kind: Kind, value: number, exactStep = false): Promise<number> {
	await browser.execute(
		(s, v, exact) => {
			const input = document.querySelector<HTMLInputElement>(s.seek)!;
			const step = input.getAttribute('step');
			if (exact) input.step = 'any';
			input.value = String(v);
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('change', { bubbles: true }));
			if (exact) {
				if (step === null) input.removeAttribute('step');
				else input.setAttribute('step', step);
			}
		},
		SEL[kind],
		value,
		exactStep,
	);
	await browser.pause(400);
	return (await readState(kind)).media!.currentTime;
}

/**
 * The window the viewer's zoom rule puts the band at after "Zoom In Waveform" twice
 * from 1× (`zoomWaveformAtAnchor`, requirement #47 contract ④): each press halves the
 * window about the axis' centre (anchor fraction 1/2), so [0, D] → [D/4, 3D/4] →
 * [3D/8, 5D/8]. Written as the rule, not the closed form, so the arithmetic follows
 * the product's (`start = anchorTime − fraction × nextSeconds`). The right margin
 * lands at `start + seconds` (`windowXToTime` clamps x to the width).
 */
function zoomWindowByRule(D: number, presses = 2): { start: number; seconds: number; end: number } {
	let start = 0;
	let seconds = D;
	for (let i = 0; i < presses; i++) {
		const anchorTime = start + 0.5 * seconds;
		seconds = seconds / 2;
		start = anchorTime - 0.5 * seconds;
	}
	return { start, seconds, end: start + seconds };
}

/**
 * The window read back from the indicator's rect. The indicator sits at
 * `inset + s / D × A` from its track's left with width `w / D × A`, A = bar width −
 * 2·inset (契約4; the track has no padding or border, so the rect gives `left` as the
 * product set it), and the canvas sits at `inset` from the band's left (契約6: axis at
 * `inset − 1` inside a 1 px border). So `indicator.left − track.left − inset = s / D × A`,
 * and with w (the zoom rule's window length) A drops out:
 * `s = (indicator.left − track.left − inset) × w / indicator.width`. Layout precision
 * (1/64 px) throughout; it needs neither the inset constant nor the bar's integer
 * `clientWidth`, and does not lean on the band and the bar sharing a left edge.
 */
function windowFromIndicator(
	indicator: Box,
	track: Box,
	inset: number,
	windowSeconds: number,
): { start: number; end: number; inset: number } {
	const secondsPerPx = windowSeconds / indicator.width;
	const origin = track.left + inset;
	return {
		start: (indicator.left - origin) * secondsPerPx,
		end: (indicator.right - origin) * secondsPerPx,
		inset,
	};
}

/** Click the band at viewport (x, y) with a real MouseEvent on whatever is there; returns where the media landed. */
async function clickBandAt(kind: Kind, x: number, y: number): Promise<{ landed: number; target: string }> {
	const target = await browser.execute(
		(cx, cy) => {
			const el = document.elementFromPoint(cx, cy);
			if (!el) return 'nothing';
			el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: cx, clientY: cy }));
			return `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')}`;
		},
		x,
		y,
	);
	await browser.pause(400);
	return { landed: (await readState(kind)).media!.currentTime, target };
}

async function pressZoom(label: 'Zoom In Waveform' | 'Zoom Out Waveform' | 'Reset Waveform Zoom'): Promise<void> {
	await browser.execute((l) => document.querySelector<HTMLButtonElement>(`button[aria-label="${l}"]`)!.click(), label);
	await browser.pause(300);
}

// --- the thumb (pixels) -------------------------------------------------------

interface Thumb {
	/** Viewport CSS px of the thumb's centre. */
	center: number;
	left: number;
	right: number;
	width: number;
	/** Rows of the range box that were read (device px), after dropping the track rows. */
	rowsUsed: number;
	rowsDropped: number;
	/** Device pixels per CSS px of the screenshot (the measurement's resolution is 1/dpr px). */
	dpr: number;
	file: string;
}

function longestRun(flags: boolean[]): { first: number; last: number } | null {
	let best: { first: number; last: number } | null = null;
	let start = -1;
	for (let i = 0; i <= flags.length; i++) {
		if (i < flags.length && flags[i]) {
			if (start < 0) start = i;
		} else if (start >= 0) {
			if (!best || i - start > best.last - best.first + 1) best = { first: start, last: i - 1 };
			start = -1;
		}
	}
	return best;
}

/**
 * The thumb is a white pill with a grey outline on a white background, 2 px
 * taller than the range box, whose middle rows merge into the (grey) track.
 * On every row that is not merged with the track (no run longer than
 * TRACK_RUN_CSS), the thumb spans from the first to the last non-background
 * pixel (its outline); the thumb's extent is the union of those spans.
 */
function findThumb(bmp: Bitmap, dpr: number, seek: Box): Omit<Thumb, 'file' | 'dpr'> {
	const cy = (seek.top + seek.bottom) / 2;
	const bg = pixelAt(bmp, Math.round((seek.left - 6) * dpr), Math.round(cy * dpr));
	const x0 = Math.max(0, Math.floor((seek.left - 4) * dpr));
	const x1 = Math.min(bmp.width, Math.ceil((seek.right + 4) * dpr));
	const y0 = Math.max(0, Math.floor((seek.top - 3) * dpr));
	const y1 = Math.min(bmp.height, Math.ceil((seek.bottom + 3) * dpr));
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	let rowsUsed = 0;
	let rowsDropped = 0;
	for (let y = y0; y < y1; y++) {
		const flags: boolean[] = [];
		for (let x = x0; x < x1; x++) flags.push(pixelDistance(pixelAt(bmp, x, y), bg) > PIXEL_THRESHOLD);
		const run = longestRun(flags);
		if (!run) continue;
		if (run.last - run.first + 1 > TRACK_RUN_CSS * dpr) {
			rowsDropped++;
			continue;
		}
		rowsUsed++;
		first = Math.min(first, x0 + flags.indexOf(true));
		last = Math.max(last, x0 + flags.lastIndexOf(true));
	}
	if (!Number.isFinite(first)) throw new Error('no thumb found in the range box');
	return {
		center: (first + last + 1) / 2 / dpr,
		left: first / dpr,
		right: (last + 1) / dpr,
		width: (last - first + 1) / dpr,
		rowsUsed,
		rowsDropped,
	};
}

/** Screenshot (window indicator hidden for the shot) and locate the thumb. The PNG is deleted unless `keep`. */
async function measureThumb(kind: Kind, name: string, keep = false): Promise<Thumb> {
	await browser.execute(() =>
		document.querySelectorAll<HTMLElement>('.seek-window-indicator').forEach((e) => (e.style.visibility = 'hidden')),
	);
	const state = await readState(kind);
	const { file, bmp, dpr } = await shotBitmap(name);
	await browser.execute(() =>
		document.querySelectorAll<HTMLElement>('.seek-window-indicator').forEach((e) => (e.style.visibility = '')),
	);
	const t = findThumb(bmp, dpr, state.seek!.rect);
	if (!keep) fs.rmSync(file, { force: true });
	return { ...t, dpr, file: keep ? file : '' };
}

// --- checks ------------------------------------------------------------------

interface Check {
	material: string;
	item: string;
	value: number;
	limit: number;
	ok: boolean;
	/** Measured and recorded, but not part of the pass condition (see EXCLUDED_FROM_PASS). */
	excluded: boolean;
}

/**
 * Checks the requirement takes out of the pass condition (still measured and
 * written to the report with `excluded: true`). None at present: the only entry
 * so far (m4a's zoomed "playhead vs marker peak", backlog 326) turned out to be
 * a measuring error of this spec, not a product defect, and was removed by
 * 追補h 契約4.
 */
const EXCLUDED_FROM_PASS: ReadonlyArray<{ material: string; item: string; reason: string }> = [];

const checks: Check[] = [];

function check(material: string, item: string, value: number, limit = TOLERANCE_PX, extra: Record<string, unknown> = {}): void {
	const ok = Math.abs(value) <= limit + 1e-9;
	const exclusion = EXCLUDED_FROM_PASS.find((e) => e.material === material && e.item === item);
	const excluded = exclusion !== undefined;
	checks.push({ material, item, value: r3(value), limit, ok, excluded });
	report(REPORT, {
		gate: '41g-d',
		material,
		item,
		value: r3(value),
		limit,
		ok,
		...(excluded ? { excluded: true, excludedBy: exclusion.reason } : {}),
		...extra,
	});
}

function expectChecks(material: string): void {
	const failed = checks.filter((c) => c.material === material && !c.ok && !c.excluded);
	expect(failed.map((c) => `${c.item}: ${c.value} (limit ±${c.limit})`)).toEqual([]);
}

interface Inset {
	leftDistance: number;
	rightDistance: number;
	thumbWidth: number[];
}

const insets: Record<string, Inset> = {};
const offsets: Record<string, { p5: number; p50: number; p95: number }> = {};

/** 追補g 「周回の進め方」0 (ii): the shape of (thumb − playhead) at 5 / 50 / 95 %. */
function shape(o: { p5: number; p50: number; p95: number }): 'same-offset' | 'no-offset' | 'undetermined' {
	if (o.p5 > 1 && o.p95 < -1 && Math.abs(o.p50) <= 1) return 'same-offset';
	if (Math.abs(o.p5) <= 1 && Math.abs(o.p50) <= 1 && Math.abs(o.p95) <= 1) return 'no-offset';
	return 'undetermined';
}

// --- the spec ------------------------------------------------------------------

describe('Requirement #41 addendum g (d): the waveform axis coincides with the seek thumb’s travel', function () {
	this.timeout(600_000);

	before(async () => {
		await waitForAppMounted();
		await installGateRecorder();
		await browser.setTimeout({ script: 120_000 });
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		buildFixtures();
		await waitForExplorerRow(uri(gateDir), { timeout: 30_000, nudgeDir: startRoot, nudgePrefix: 'req41' });
		await clickExplorerRow(uri(gateDir));
		await waitForExplorerRow(uri(path.join(gateDir, materials[0]!.name)), { timeout: 15_000 });
		report(REPORT, {
			gate: '41g-setup',
			materials: materials.map((m) => [m.name, fs.statSync(path.join(gateDir, m.name)).size]),
			viewport: await browser.execute(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio })),
		});
	});

	after(async () => {
		await restoreGateRecorder();
		fs.rmSync(gateDir, { recursive: true, force: true });
		for (const name of fs.readdirSync(startRoot)) {
			if (name.startsWith('req41-nudge-')) fs.rmSync(path.join(startRoot, name), { force: true });
		}
	});

	for (const m of materials) {
		it(`${m.name}: thumb centre = playhead = marker peak at 1×, thumb = window indicator at 4×, margin clicks land on the ends`, async () => {
			const tag = m.name.replace('.', '-');
			const kind = m.kind;
			const seek = (t: number) => seekTo(kind, t, m.name);
			const opened = await openMaterial(m);
			const seekRect = opened.seek!.rect;
			const D = opened.seek!.max;
			report(REPORT, {
				gate: '41g-open',
				material: m.name,
				barMax: D,
				mediaDuration: opened.media!.duration,
				seekRect,
				band: opened.band,
				canvas: opened.canvas,
				frameReadout: opened.frameReadout,
			});
			// The band and the seek bar share their outer left edge and width (the contract's premise).
			check(m.name, 'premise: band.left - seek.left', opened.band!.left - seekRect.left, 0.5);
			check(m.name, 'premise: band.width - seek.width', opened.band!.width - seekRect.width, 0.5);

			// (i) SEEK_THUMB_INSET_PX: the thumb centre's distance from the box's ends with the value at 0 and at max.
			const widths: number[] = [];
			await seek(0);
			const valueAtZero = await setBarValue(kind, 0);
			let thumb = await measureThumb(kind, `req41-${tag}-value0`, true);
			widths.push(thumb.width);
			const thumbAtZero = thumb.center;
			const leftDistance = thumbAtZero - seekRect.left;
			await zoomedShot(`req41-${tag}-value0-seekrow-x4`, { x: seekRect.left - 8, y: seekRect.top - 4, width: 120, height: seekRect.height + 8 }, 4);
			const valueAtMax = await setBarValue(kind, D);
			thumb = await measureThumb(kind, `req41-${tag}-valueMax`, true);
			widths.push(thumb.width);
			const rightDistance = seekRect.right - thumb.center;
			/** CSS px the thumb's centre moves per second of bar value (its travel is linear in the value). */
			const thumbRate = (thumb.center - thumbAtZero) / (valueAtMax - valueAtZero);
			await zoomedShot(`req41-${tag}-valueMax-seekrow-x4`, { x: seekRect.right - 112, y: seekRect.top - 4, width: 120, height: seekRect.height + 8 }, 4);
			await setBarValue(kind, 0);
			insets[m.name] = { leftDistance, rightDistance, thumbWidth: widths };
			report(REPORT, {
				gate: '41g-0-i',
				material: m.name,
				valueAtZero,
				valueAtMax,
				barMax: D,
				leftDistance: r3(leftDistance),
				rightDistance: r3(rightDistance),
				mean: r3((leftDistance + rightDistance) / 2),
				meanRoundedHalfPx: Math.round(leftDistance + rightDistance) / 2,
				thumbWidth: widths.map(r3),
				thumbRows: [thumb.rowsUsed, thumb.rowsDropped],
				thumbPxPerSecond: r3(thumbRate),
				dpr: thumb.dpr,
			});

			// 等倍: thumb centre vs playhead at 0 / 0.5 / D/2 / D−0.5 / D, plus 5 / 50 / 95 % for step 0 (ii).
			const positions: [string, number][] = [
				['0', 0],
				['0.5s', 0.5],
				['5%', 0.05 * D],
				['50%', 0.5 * D],
				['95%', 0.95 * D],
				['D-0.5s', D - 0.5],
				['D', D],
			];
			const headDiffs: Record<string, number> = {};
			for (const [label, t] of positions) {
				const s = await seek(t);
				const th = await measureThumb(kind, `req41-${tag}-at-${label}`);
				const diff = th.center - s.headX!;
				headDiffs[label] = diff;
				check(m.name, `1x thumb - head @ ${label}`, diff, TOLERANCE_PX, {
					t,
					barValue: s.seek!.value,
					thumb: r3(th.center),
					head: r3(s.headX!),
					thumbWidth: r3(th.width),
				});
			}
			offsets[m.name] = { p5: headDiffs['5%']!, p50: headDiffs['50%']!, p95: headDiffs['95%']! };
			report(REPORT, { gate: '41g-0-ii', material: m.name, kind, ...Object.fromEntries(Object.entries(offsets[m.name]!).map(([k, v]) => [k, r3(v)])), shape: shape(offsets[m.name]!) });

			// 等倍: thumb centre vs marker peak at 2 / 5 / 8 s (and the playhead vs the peak, for the record).
			for (const t of MARKS) {
				const s = await seek(t);
				const th = await measureThumb(kind, `req41-${tag}-mark-${t}s`);
				const peak = await peakX(kind, s.headX!);
				report(REPORT, { gate: '41g-d-peak', material: m.name, t, head: r3(s.headX!), peak: peak.x === null ? null : r3(peak.x), weight: peak.weight, baseline: peak.baseline });
				expect(peak.x).not.toBeNull();
				check(m.name, `1x thumb - peak @ ${t}s`, th.center - peak.x!, TOLERANCE_PX, { thumb: r3(th.center), peak: r3(peak.x!) });
				check(m.name, `1x head - peak @ ${t}s`, s.headX! - peak.x!, TOLERANCE_PX, { head: r3(s.headX!), peak: r3(peak.x!) });
			}

			// 余白のクリック (等倍): the band's left / right edge lands where releasing the seek bar at 0 / D lands.
			const band = opened.band!;
			const by = (band.top + band.bottom) / 2;
			const seekLanding0 = await scrubCommit(kind, 0);
			const leftClick = await clickBandAt(kind, band.left + 2, by);
			const seekLandingMax = await scrubCommit(kind, D);
			const rightClick = await clickBandAt(kind, band.right - 2, by);
			report(REPORT, { gate: '41g-d-margin-1x', material: m.name, seekLanding0, leftClick, seekLandingMax, rightClick });
			check(m.name, '1x left margin click - seek bar released at 0 (s)', leftClick.landed - seekLanding0, TOLERANCE_S, { target: leftClick.target });
			check(m.name, '1x right margin click - seek bar released at D (s)', rightClick.landed - seekLandingMax, TOLERANCE_S, { target: rightClick.target });

			// 拡大 ×4 (window sent to the middle: zoom twice with the position at D/2).
			await seek(D / 2);
			await pressZoom('Zoom In Waveform');
			await pressZoom('Zoom In Waveform');
			let s = await readState(kind);
			expect(s.indicator).not.toBeNull();
			const indicatorAtZoom = s.indicator!;
			// Derive the window from the band's own axis: two playhead positions (at the bar's values, which for a
			// video are presented-frame times) give px/s and the time at the canvas' left edge.
			const a = await seek(0.4 * D);
			const b = await seek(0.6 * D);
			const ta = a.seek!.value;
			const tb = b.seek!.value;
			const pps = (b.headX! - a.headX!) / (tb - ta);
			const windowStart = ta - (a.headX! - a.canvas!.left) / pps;
			const windowSeconds = a.canvas!.width / pps;
			const windowEnd = windowStart + windowSeconds;
			report(REPORT, { gate: '41g-d-zoom-window', material: m.name, windowStart: r3(windowStart), windowSeconds: r3(windowSeconds), pxPerSecond: r3(pps), indicator: s.indicator });
			expect(Math.abs(windowSeconds - D / 4)).toBeLessThan(0.01);

			// Playhead vs the 5 s marker inside the zoomed band: the playhead goes on the marker's own
			// time (追補h 契約2), not D / 2 — the two differ when the element's reported duration is
			// not 10 s (ffmpeg m4a: D = 9.977 s). The window [3D/8, 5D/8] holds 5 s for D in 8–13.3 s.
			const zoomMark = MARKS[1]!;
			expect(zoomMark).toBe(5);
			expect(zoomMark).toBeGreaterThan(windowStart);
			expect(zoomMark).toBeLessThan(windowEnd);
			s = await seek(zoomMark);
			const zoomPeak = await peakX(kind, s.headX!);
			expect(zoomPeak.x).not.toBeNull();
			check(m.name, '4x head - peak @ 5s', s.headX! - zoomPeak.x!, TOLERANCE_PX, { head: r3(s.headX!), peak: r3(zoomPeak.x!) });

			// Thumb centre vs the window indicator's ends with the position at the window's start / end.
			// A video's bar can only show frame times, and a position outside the window makes the window follow
			// it, so the position is put one frame (25 fps + 1 ms) inside each end and the thumb's centre is
			// carried to the end itself with the thumb's travel rate measured in (i): at most 0.08 s = 13 px of
			// extrapolation on a rate known to ~0.1 %. The window must not have moved (indicator unchanged).
			const GUARD_S = 0.041;
			s = await seek(windowStart + GUARD_S);
			let v = s.seek!.value;
			thumb = await measureThumb(kind, `req41-${tag}-4x-window-start`, true);
			let shift = (v - windowStart) * thumbRate;
			expect(Math.abs(s.indicator!.left - indicatorAtZoom.left)).toBeLessThan(0.01);
			check(m.name, '4x thumb @ window start - indicator.left', thumb.center - shift - s.indicator!.left, TOLERANCE_PX, {
				thumb: r3(thumb.center),
				barValue: v,
				carriedBy: r3(-shift),
				indicator: s.indicator,
				windowStart: r3(windowStart),
			});
			await zoomedShot(`req41-${tag}-4x-window-start-seekrow-x4`, { x: thumb.center - 60, y: seekRect.top - 4, width: 120, height: seekRect.height + 8 }, 4);
			s = await seek(windowEnd - GUARD_S);
			v = s.seek!.value;
			thumb = await measureThumb(kind, `req41-${tag}-4x-window-end`, true);
			shift = (v - windowEnd) * thumbRate;
			expect(Math.abs(s.indicator!.left - indicatorAtZoom.left)).toBeLessThan(0.01);
			check(m.name, '4x thumb @ window end - indicator.right', thumb.center - shift - s.indicator!.right, TOLERANCE_PX, {
				thumb: r3(thumb.center),
				barValue: v,
				carriedBy: r3(-shift),
				indicator: s.indicator,
				windowEnd: r3(windowEnd),
			});

			// 余白のクリック (拡大中): the ends are the window's ends (判断4). The reference is the window the zoom
			// rule puts there, [3D/8, 5D/8] — exact — not the band-pixel estimate above (≈ ±1.5 ms, coarser than
			// TOLERANCE_S) rounded to the bar's 1 ms step. The indicator must put the window at the same place
			// (cross-check in bar px) before the rule's window is trusted as the reference.
			s = await seek(D / 2);
			expect(Math.abs(s.indicator!.left - indicatorAtZoom.left)).toBeLessThan(0.01);
			const rule = zoomWindowByRule(s.seek!.max);
			/** The window must be where the rule says (read back from the indicator) right before each margin click. */
			const expectRuleWindow = async (stage: 'before left click' | 'before right click'): Promise<void> => {
				const st = await readState(kind);
				expect(st.indicator).not.toBeNull();
				expect(st.track).not.toBeNull();
				const fromIndicator = windowFromIndicator(st.indicator!, st.track!, st.canvas!.left - st.band!.left, rule.seconds);
				const barPxPerSecond = st.indicator!.width / rule.seconds;
				const agreement = {
					startPx: (fromIndicator.start - rule.start) * barPxPerSecond,
					endPx: (fromIndicator.end - rule.end) * barPxPerSecond,
				};
				report(REPORT, {
					gate: '41g-d-zoom-window-reference',
					material: m.name,
					stage,
					barMax: st.seek!.max,
					rule: { start: rule.start, end: rule.end, seconds: rule.seconds },
					fromIndicator: { start: fromIndicator.start, end: fromIndicator.end, inset: r3(fromIndicator.inset) },
					fromBandEstimate: { start: windowStart, end: windowEnd },
					indicator: st.indicator,
					track: st.track,
					canvasLeft: st.canvas!.left,
					bandLeft: st.band!.left,
					agreementPx: { start: r3(agreement.startPx), end: r3(agreement.endPx) },
				});
				expect(Math.abs(agreement.startPx)).toBeLessThanOrEqual(ZOOM_WINDOW_AGREE_PX);
				expect(Math.abs(agreement.endPx)).toBeLessThanOrEqual(ZOOM_WINDOW_AGREE_PX);
			};

			await expectRuleWindow('before left click');
			const zoomLeft = await clickBandAt(kind, band.left + 2, by);
			// The landing may legitimately pull the window along (要件#47 契約⑥: a video presents a frame, and for
			// webm the frame at s sits before the window's start), so the zoom is rebuilt from 1× for the right
			// margin instead of assuming the window stayed put.
			await pressZoom('Reset Waveform Zoom');
			await seek(D / 2);
			await pressZoom('Zoom In Waveform');
			await pressZoom('Zoom In Waveform');
			await expectRuleWindow('before right click');
			const zoomRight = await clickBandAt(kind, band.right - 2, by);
			await pressZoom('Reset Waveform Zoom');
			// Expected landing: a material with a frame index snaps (契約5: nearestFrame → seekTimeForFrame), and so
			// does the seek bar released at the same time — so the reference is that release, at exactly
			// rule.start / rule.end (step bypassed). Without an index both go straight to s / s + w.
			const seekLandingStart = m.indexed ? await scrubCommit(kind, rule.start, true) : null;
			const seekLandingEnd = m.indexed ? await scrubCommit(kind, rule.end, true) : null;
			const expectedStart = seekLandingStart ?? rule.start;
			const expectedEnd = seekLandingEnd ?? rule.end;
			const reference = m.indexed
				? 'seek bar released at exactly the zoom-rule window end (frame snap; step bypassed)'
				: 'zoom-rule window end itself (no frame index)';
			report(REPORT, {
				gate: '41g-d-margin-4x',
				material: m.name,
				reference,
				windowStart: rule.start,
				windowEnd: rule.end,
				expectedStart,
				expectedEnd,
				zoomLeft,
				seekLandingStart,
				zoomRight,
				seekLandingEnd,
			});
			check(m.name, '4x left margin click - window start (s)', zoomLeft.landed - expectedStart, TOLERANCE_S, {
				target: zoomLeft.target,
				landed: zoomLeft.landed,
				expected: expectedStart,
				reference,
			});
			check(m.name, '4x right margin click - window end (s)', zoomRight.landed - expectedEnd, TOLERANCE_S, {
				target: zoomRight.target,
				landed: zoomRight.landed,
				expected: expectedEnd,
				reference,
			});

			await seek(0);
			expectChecks(m.name);
		});
	}

	it('step 0 record: (i) the inset is consistent across ends and viewers; (ii) the audio viewer’s offset shape', () => {
		const names = Object.keys(insets);
		expect(names.length).toBe(materials.length);
		const means = Object.fromEntries(names.map((n) => [n, (insets[n]!.leftDistance + insets[n]!.rightDistance) / 2]));
		const all = Object.values(means);
		const insetPx = Math.round((all.reduce((x, y) => x + y, 0) / all.length) * 2) / 2;
		const endsDisagree = names.filter((n) => Math.abs(insets[n]!.leftDistance - insets[n]!.rightDistance) > 1);
		const viewersDisagree = Math.max(...all) - Math.min(...all) > 1;
		const shapes = Object.fromEntries(Object.entries(offsets).map(([n, o]) => [n, shape(o)]));
		const videoShapes = materials.filter((m) => m.kind === 'video').map((m) => shapes[m.name]);
		const audioShapes = materials.filter((m) => m.kind === 'audio').map((m) => shapes[m.name]);
		report(REPORT, {
			gate: '41g-0-summary',
			insetPerMaterial: Object.fromEntries(names.map((n) => [n, { left: r3(insets[n]!.leftDistance), right: r3(insets[n]!.rightDistance), mean: r3(means[n]!), thumbWidth: insets[n]!.thumbWidth.map(r3) }])),
			SEEK_THUMB_INSET_PX: insetPx,
			endsDisagree,
			viewersDisagree,
			offsets: Object.fromEntries(Object.entries(offsets).map(([n, o]) => [n, { p5: r3(o.p5), p50: r3(o.p50), p95: r3(o.p95) }])),
			shapes,
			videoShape: videoShapes.every((s) => s === videoShapes[0]) ? videoShapes[0] : 'mixed',
			audioShape: audioShapes.every((s) => s === audioShapes[0]) ? audioShapes[0] : 'mixed',
			failedChecks: checks.filter((c) => !c.ok && !c.excluded).length,
			excludedChecks: checks
				.filter((c) => c.excluded)
				.map((c) => ({ material: c.material, item: c.item, value: c.value, ok: c.ok })),
			totalChecks: checks.length,
		});
		expect(endsDisagree).toEqual([]);
		expect(viewersDisagree).toBe(false);
	});
});
