/**
 * The audio spectrum at the playback position, up to 16 kHz (requirements.md #91).
 *
 * The DOM-free part of the spectrum band that VideoViewer and AudioViewer place above their waveform: how the audio is
 * taken (the waveform's routes, decoded at 32 kHz), the analysis (a Hann window of 4096 samples around the position and
 * an FFT of our own: contract 3, no dependency), the geometry of the band (a log axis 20 Hz…16 kHz and a fixed
 * -90…0 dBFS axis: contract 4), the peak-hold line (contract 6) and the band height (contract 2). The components only
 * decide when to call these.
 *
 * Nothing here touches the playback path (contract 8): the decode is an `OfflineAudioContext`, never an `AudioContext`
 * and never `createMediaElementSource`.
 */
import {
	laneBoxes,
	loadWaveformSource,
	waveformBandNote,
	waveformPlan,
	webmTrackKinds,
	WAVEFORM_MAX_SOURCE_BYTES,
	type WaveformAudioBuffer,
	type WaveformDecode,
	type WaveformExtract,
	type WaveformExtraction,
	type WaveformResult,
} from './audio-waveform';

// ---------------------------------------------------------------------------
// constants (contract 3 / 4 / 6)
// ---------------------------------------------------------------------------

/** The rate the audio is decoded at; its Nyquist frequency is the right end of the axis. */
export const SPECTRUM_SAMPLE_RATE = 32000;
/** Samples per analysis window (about 0.128 s at 32 kHz; decision 12 "about 0.1 s"). */
export const SPECTRUM_FFT_SIZE = 4096;
/** Left end of the log axis (low enough for mains hum at 50 / 60 Hz and low rumble). */
export const SPECTRUM_MIN_HZ = 20;
/** Right end of the log axis; nothing above it is drawn. */
export const SPECTRUM_MAX_HZ = 16000;
/** Bottom of the fixed dBFS axis. */
export const SPECTRUM_MIN_DB = -90;
/** Top of the fixed dBFS axis. */
export const SPECTRUM_MAX_DB = 0;
export const SPECTRUM_FREQUENCY_TICKS_HZ: readonly number[] = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 16000];
export const SPECTRUM_DB_TICKS: readonly number[] = [0, -30, -60, -90];
/** A peak is held this long before the line starts to fall. */
export const SPECTRUM_PEAK_HOLD_MS = 1000;
/** How fast the peak line falls after the hold (dB per second). */
const SPECTRUM_PEAK_FALL_DB_PER_SECOND = 20;

/** '20' … '500', '1k', '2k', '5k', '10k', '16k'. */
export function frequencyTickLabel(hz: number): string {
	if (hz >= 1000) {
		const k = hz / 1000;
		return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
	}
	return String(hz);
}

// ---------------------------------------------------------------------------
// analysis (contract 3)
// ---------------------------------------------------------------------------

/**
 * The periodic Hann window: 0 at the first sample, 1 at the centre, sum = size / 2. The periodic form puts the zeros
 * of the window's spectrum exactly on the neighbouring bins, so a sine on a bin centre reads its full level.
 */
export function hannWindow(size: number): Float32Array {
	const out = new Float32Array(size);
	for (let i = 0; i < size; i++) out[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
	return out;
}

/** The centre frequency of FFT bin `bin`. */
export function binFrequency(bin: number, sampleRate = SPECTRUM_SAMPLE_RATE, size = SPECTRUM_FFT_SIZE): number {
	return (bin * sampleRate) / size;
}

/**
 * Exactly `size` samples with `samples[centerIndex]` at index `size / 2`. Indices outside the samples are silence
 * (the head and the tail of the file, a position past the end); never throws.
 */
export function frameAround(samples: Float32Array, centerIndex: number, size = SPECTRUM_FFT_SIZE): Float32Array {
	const out = new Float32Array(size);
	if (!Number.isFinite(centerIndex)) return out;
	const start = Math.round(centerIndex) - Math.floor(size / 2);
	const from = Math.max(0, start);
	const to = Math.min(samples.length, start + size);
	if (to > from) out.set(samples.subarray(from, to), from - start);
	return out;
}

/** The frame centred on `positionSeconds` (rounded to the nearest sample at `sampleRate`). */
export function frameAt(samples: Float32Array, positionSeconds: number, sampleRate: number, size = SPECTRUM_FFT_SIZE): Float32Array {
	return frameAround(samples, Math.round(positionSeconds * sampleRate), size);
}

type FftTables = { window: Float32Array; windowSum: number; cos: Float64Array; sin: Float64Array; reverse: Uint32Array };
const fftTables = new Map<number, FftTables>();

function tablesFor(size: number): FftTables {
	const cached = fftTables.get(size);
	if (cached) return cached;
	const window = hannWindow(size);
	let windowSum = 0;
	for (const v of window) windowSum += v;
	const half = size >> 1;
	const cos = new Float64Array(half);
	const sin = new Float64Array(half);
	for (let i = 0; i < half; i++) {
		cos[i] = Math.cos((2 * Math.PI * i) / size);
		sin[i] = -Math.sin((2 * Math.PI * i) / size);
	}
	const bits = Math.round(Math.log2(size));
	const reverse = new Uint32Array(size);
	for (let i = 0; i < size; i++) {
		let r = 0;
		for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
		reverse[i] = r;
	}
	const tables = { window, windowSum, cos, sin, reverse };
	fftTables.set(size, tables);
	return tables;
}

/**
 * Hann window + an iterative radix-2 FFT (own code) of one frame → `size / 2 + 1` values in dBFS, bin 0 (DC) to the
 * Nyquist bin. A full-scale sine (amplitude 1.0) on a bin centre reads 0 dB at that bin (amplitude A → 20·log10(A)):
 * the magnitude is scaled by 2 / sum(window). Silence reads -Infinity (below SPECTRUM_MIN_DB).
 */
export function spectrumDb(frame: Float32Array): Float32Array {
	let size = 1;
	while (size < frame.length) size <<= 1;
	if (size < 2) size = 2;
	const { window, windowSum, cos, sin, reverse } = tablesFor(size);
	const re = new Float64Array(size);
	const im = new Float64Array(size);
	for (let i = 0; i < frame.length; i++) re[reverse[i]] = frame[i] * window[i];

	for (let len = 2; len <= size; len <<= 1) {
		const halfLen = len >> 1;
		const step = size / len;
		for (let start = 0; start < size; start += len) {
			for (let k = 0; k < halfLen; k++) {
				const wr = cos[k * step];
				const wi = sin[k * step];
				const a = start + k;
				const b = a + halfLen;
				const tr = re[b] * wr - im[b] * wi;
				const ti = re[b] * wi + im[b] * wr;
				re[b] = re[a] - tr;
				im[b] = im[a] - ti;
				re[a] += tr;
				im[a] += ti;
			}
		}
	}

	const bins = (size >> 1) + 1;
	const out = new Float32Array(bins);
	const scale = 2 / windowSum;
	for (let k = 0; k < bins; k++) {
		const magnitude = Math.hypot(re[k], im[k]) * scale;
		out[k] = magnitude > 0 ? 20 * Math.log10(magnitude) : Number.NEGATIVE_INFINITY;
	}
	return out;
}

// ---------------------------------------------------------------------------
// geometry (contract 4)
// ---------------------------------------------------------------------------

const LOG_SPAN = Math.log(SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ);

/** The log axis: 20 Hz → 0, 16 kHz → width. `null` outside [20, 16000] (and for non-finite / non-positive input). */
export function frequencyToX(hz: number, width: number): number | null {
	if (!Number.isFinite(hz) || hz <= 0) return null;
	if (hz < SPECTRUM_MIN_HZ || hz > SPECTRUM_MAX_HZ) return null;
	return (width * Math.log(hz / SPECTRUM_MIN_HZ)) / LOG_SPAN;
}

/** 0 dB → 0 (top), -90 dB → height (bottom), linear in between, clamped; non-finite → the bottom. */
export function dbToY(db: number, height: number): number {
	if (!Number.isFinite(db)) return height;
	if (db >= SPECTRUM_MAX_DB) return 0;
	if (db <= SPECTRUM_MIN_DB) return height;
	return ((SPECTRUM_MAX_DB - db) / (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB)) * height;
}

/**
 * One point per bin whose frequency lies within [20 Hz, 16 kHz], ascending. Bin k is k · rate / (2 · (bins - 1)).
 */
export function spectrumCurve(
	db: Float32Array,
	width: number,
	height: number,
	sampleRate = SPECTRUM_SAMPLE_RATE,
): Array<{ x: number; y: number }> {
	const points: Array<{ x: number; y: number }> = [];
	if (db.length < 2) return points;
	const binHz = sampleRate / (2 * (db.length - 1));
	for (let k = 0; k < db.length; k++) {
		const x = frequencyToX(k * binHz, width);
		if (x === null) continue;
		points.push({ x, y: dbToY(db[k], height) });
	}
	return points;
}

// ---------------------------------------------------------------------------
// the source and the lanes (contract 1 / 5 / 10)
// ---------------------------------------------------------------------------

export type SpectrumSource =
	| { state: 'ready'; channels: Float32Array[]; sampleRate: number; durationSeconds: number }
	| { state: 'no-audio' | 'too-large' | 'unreadable' | 'unsupported-codec' | 'decode-failed' };

/**
 * The lanes at `positionSeconds`: stereo → [L, R]; mono → one lane; three or more channels → one lane of the
 * per-sample average (the waveform's rule); no channel → none.
 */
export function spectrumLanes(source: SpectrumSource & { state: 'ready' }, positionSeconds: number): Float32Array[] {
	const { channels, sampleRate } = source;
	if (channels.length === 0) return [];
	if (channels.length <= 2) return channels.map((channel) => spectrumDb(frameAt(channel, positionSeconds, sampleRate)));
	const mixed = new Float32Array(SPECTRUM_FFT_SIZE);
	for (const channel of channels) {
		const frame = frameAt(channel, positionSeconds, sampleRate);
		for (let i = 0; i < mixed.length; i++) mixed[i] += frame[i];
	}
	for (let i = 0; i < mixed.length; i++) mixed[i] /= channels.length;
	return [spectrumDb(mixed)];
}

/** How many lanes `spectrumLanes` gives for this source (2 for stereo, 1 otherwise, 0 before it is ready). */
export function spectrumLaneCount(source: SpectrumSource | null): number {
	if (source?.state !== 'ready' || source.channels.length === 0) return 0;
	return source.channels.length === 2 ? 2 : 1;
}

/** The band's text for a state: the waveform's text for the same state (contract 10). `note` picks the viewer's wording. */
export function spectrumBandNote(
	source: SpectrumSource | null,
	analyzing: boolean,
	note: (result: WaveformResult | null, analyzing: boolean) => string | null = waveformBandNote,
): string | null {
	if (source === null) return note(null, analyzing);
	if (source.state === 'ready') return note({ state: 'ready', lanes: [] }, analyzing);
	return note({ state: source.state }, analyzing);
}

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
/** The head of an EBML body copied before the decode detaches it (the waveform's addendum j rule). */
const EBML_PROBE_BYTES = 1024 * 1024;

function ebmlHead(bytes: ArrayBuffer): ArrayBuffer | null {
	if (bytes.byteLength < EBML_MAGIC.length) return null;
	const head = new Uint8Array(bytes, 0, EBML_MAGIC.length);
	if (!EBML_MAGIC.every((b, i) => head[i] === b)) return null;
	return bytes.slice(0, Math.min(bytes.byteLength, EBML_PROBE_BYTES));
}

/**
 * The audio for the spectrum: the waveform's routes and reasons (`waveformPlan`), decoded by `decode` (32 kHz).
 * mp4 / mov: the Rust extraction (over WAVEFORM_MAX_SOURCE_BYTES → too-large); wav: `loadWav` (never fetch; missing →
 * unreadable); everything else: fetched through `loadWaveformSource`. Never throws.
 */
export async function analyzeSpectrumSource(
	uri: string,
	input: {
		durationSeconds: number | null;
		hasAudioTrack: boolean | null;
		decode: WaveformDecode;
		extract: WaveformExtract;
		loadWav?: WaveformExtract;
	},
): Promise<SpectrumSource> {
	try {
		const plan = waveformPlan(uri, input.durationSeconds, input.hasAudioTrack);
		if (plan.route === 'skip') return { state: plan.reason };

		let bytes: ArrayBuffer;
		if (plan.route === 'extract' || plan.route === 'wav') {
			const load = plan.route === 'wav' ? input.loadWav : input.extract;
			if (!load) return { state: 'unreadable' };
			let extraction: WaveformExtraction;
			try {
				extraction = await load(uri);
			} catch {
				return { state: 'unreadable' };
			}
			if (extraction.state !== 'ok') return { state: extraction.state };
			// The wav route has no ceiling (decision 14: the spectrum shows whenever the waveform does, and the wav waveform
			// streams without one); the extracted audio of a movie keeps the waveform's.
			if (plan.route === 'extract' && extraction.bytes.byteLength > WAVEFORM_MAX_SOURCE_BYTES) {
				return { state: 'too-large' };
			}
			bytes = extraction.bytes;
		} else {
			const source = await loadWaveformSource(uri);
			if (source.state !== 'ok') return { state: source.state };
			bytes = source.bytes;
		}

		const head = plan.route === 'fetch' ? ebmlHead(bytes) : null;
		let decoded: WaveformAudioBuffer;
		try {
			decoded = await input.decode(bytes);
		} catch {
			if (head) {
				const kinds = webmTrackKinds(head);
				if (kinds !== null && kinds.audio === 0) return { state: 'no-audio' };
			}
			return { state: 'decode-failed' };
		}
		if (!decoded || decoded.numberOfChannels < 1 || decoded.length < 1) return { state: 'no-audio' };

		const channels: Float32Array[] = [];
		for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
		const sampleRate = decoded.sampleRate;
		return {
			state: 'ready',
			channels,
			sampleRate,
			durationSeconds: sampleRate > 0 ? decoded.length / sampleRate : 0,
		};
	} catch {
		return { state: 'unreadable' };
	}
}

function copyExtraction(result: WaveformExtraction): WaveformExtraction {
	if (result.state !== 'ok') return result;
	return { state: 'ok', bytes: result.bytes.slice(0) };
}

/** One analysis's way into a shared extraction: its extract, and `leave` for a run that ends without extracting. */
export type ExtractionShareSeat = { extract: WaveformExtract; leave: () => void };

/**
 * One extraction of a movie's audio for the waveform and the spectrum together (contract 9: "the 32 kHz audio may be
 * taken together with the waveform's"), so the Rust command reads the movie once per `src`.
 *
 * Each analysis of `key` takes a seat (`join`) when it starts. The first seat to extract runs `extract`; every seat
 * gets the same result, the seats before the last one a copy of the bytes (the decode detaches what it is given) and
 * the last one the original. A seat whose run ends before it extracts calls `leave`, so the result is never kept for a
 * seat that will not come (a hidden spectrum, a cancelled run). A seat that joins after the result went to everyone
 * starts a new extraction.
 */
export function createExtractionShare(extract: WaveformExtract): { join(key: string): ExtractionShareSeat } {
	type Entry = { key: string; seats: number; result: Promise<WaveformExtraction> | null };
	let current: Entry | null = null;
	return {
		join(key: string): ExtractionShareSeat {
			if (current === null || current.key !== key) current = { key, seats: 0, result: null };
			const entry: Entry = current;
			entry.seats += 1;
			let done = false;
			const release = () => {
				done = true;
				entry.seats -= 1;
				if (entry.seats <= 0 && current === entry) current = null;
			};
			return {
				extract: async (uri: string) => {
					if (done) return await extract(uri);
					entry.result ??= extract(uri);
					const result = entry.result;
					release();
					const last = entry.seats <= 0;
					const value = await result;
					return last ? value : copyExtraction(value);
				},
				leave: () => {
					if (!done) release();
				},
			};
		},
	};
}

/**
 * Bytes → audio at SPECTRUM_SAMPLE_RATE, through an `OfflineAudioContext` with two channels (L / R). The only decode
 * seam of the spectrum: an offline context never grabs the output device (contract 8).
 */
export async function decodeSpectrumAudio(bytes: ArrayBuffer): Promise<WaveformAudioBuffer> {
	const context = new OfflineAudioContext(2, 1, SPECTRUM_SAMPLE_RATE);
	return await context.decodeAudioData(bytes);
}

// ---------------------------------------------------------------------------
// the peak-hold line (contract 6)
// ---------------------------------------------------------------------------

export interface PeakHold {
	readonly size: number;
}

class PeakHoldState implements PeakHold {
	size: number;
	peaks: Float32Array;
	times: Float64Array;
	empty = true;

	constructor(size: number) {
		this.size = size;
		this.peaks = new Float32Array(size);
		this.times = new Float64Array(size);
	}
}

export function createPeakHold(size: number): PeakHold {
	return new PeakHoldState(Math.max(0, Math.floor(size)));
}

function floorDb(value: number): number {
	return Number.isFinite(value) ? Math.max(SPECTRUM_MIN_DB, value) : SPECTRUM_MIN_DB;
}

/**
 * The peak-hold line for this frame. Per bin: a value at or above the line replaces it and restarts its clock; a lower
 * value leaves the line where it is for SPECTRUM_PEAK_HOLD_MS, then the line falls at a steady rate until it meets the
 * current value. The values are finite and never below SPECTRUM_MIN_DB.
 */
export function updatePeakHold(hold: PeakHold, db: Float32Array, nowMs: number): Float32Array {
	const state = hold as PeakHoldState;
	if (state.peaks.length !== db.length) {
		state.size = db.length;
		state.peaks = new Float32Array(db.length);
		state.times = new Float64Array(db.length);
		state.empty = true;
	}
	const out = new Float32Array(db.length);
	for (let k = 0; k < db.length; k++) {
		const value = floorDb(db[k]);
		if (state.empty) {
			state.peaks[k] = value;
			state.times[k] = nowMs;
			out[k] = value;
			continue;
		}
		const age = nowMs - state.times[k] - SPECTRUM_PEAK_HOLD_MS;
		const line = age > 0 ? state.peaks[k] - (SPECTRUM_PEAK_FALL_DB_PER_SECOND * age) / 1000 : state.peaks[k];
		if (value >= line) {
			state.peaks[k] = value;
			state.times[k] = nowMs;
			out[k] = value;
		} else {
			out[k] = line;
		}
	}
	state.empty = false;
	return out;
}

/** Forget every peak (a seek): the next update returns the current values. */
export function resetPeakHold(hold: PeakHold): void {
	(hold as PeakHoldState).empty = true;
}

// ---------------------------------------------------------------------------
// drawing (contract 4 / 5 / 12)
// ---------------------------------------------------------------------------

/** The height of the frequency labels' row under the canvas (px). The canvas keeps the full width (the axis). */
export const SPECTRUM_TICK_ROW_PX = 14;

/** The frequency labels under the canvas: the left edge in % of the width and the shift that keeps the ends inside. */
export function spectrumFrequencyTickMarks(): Array<{ text: string; left: number; shift: number }> {
	const last = SPECTRUM_FREQUENCY_TICKS_HZ.length - 1;
	return SPECTRUM_FREQUENCY_TICKS_HZ.map((hz, i) => ({
		text: frequencyTickLabel(hz),
		left: (frequencyToX(hz, 1) ?? 0) * 100,
		shift: i === 0 ? 0 : i === last ? -100 : -50,
	}));
}

/** The dB labels of every lane: the top in px of the canvas and the vertical shift that keeps the edges inside. */
export function spectrumDbTickMarks(laneCount: number, canvasHeight: number): Array<{ key: string; text: string; top: number; shift: number }> {
	const marks: Array<{ key: string; text: string; top: number; shift: number }> = [];
	laneBoxes(laneCount, canvasHeight).forEach((box, lane) => {
		for (const db of SPECTRUM_DB_TICKS) {
			marks.push({
				key: `${lane}:${db}`,
				text: String(db),
				top: box.y + dbToY(db, box.h),
				shift: db === SPECTRUM_MAX_DB ? 0 : db === SPECTRUM_MIN_DB ? -100 : -50,
			});
		}
	});
	return marks;
}

/** The L / R labels for stereo (none for one lane), at the top of each lane. */
export function spectrumLaneLabelMarks(laneCount: number, canvasHeight: number): Array<{ text: string; top: number }> {
	if (laneCount !== 2) return [];
	return laneBoxes(2, canvasHeight).map((box, i) => ({ text: i === 0 ? 'L' : 'R', top: box.y }));
}

/**
 * Draw the lanes onto the canvas: a filled curve per lane, the peak-hold line over it, the dB grid (-30 / -60) and the
 * frequency grid (full lane height, so it never reads as a peak), and a line between the lanes. The colours come from
 * the canvas's computed style (theme tokens): `color` is the curve, `--color-warning` the peak line, `--color-border`
 * the grid. No background is painted (the band's own background shows through).
 */
export function drawSpectrum(
	canvas: HTMLCanvasElement,
	lanes: Float32Array[] | null,
	peaks: Float32Array[] | null,
	width: number,
	height: number,
): void {
	const ratio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
	canvas.width = Math.max(1, Math.round(width * ratio));
	canvas.height = Math.max(1, Math.round(height * ratio));
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	ctx.clearRect(0, 0, width, height);
	if (!lanes || lanes.length === 0) return;

	const style = getComputedStyle(canvas);
	const curveColor = style.color;
	const peakColor = style.getPropertyValue('--color-warning').trim() || curveColor;
	const gridColor = style.getPropertyValue('--color-border').trim() || curveColor;
	const dividerColor = style.getPropertyValue('--color-border-strong').trim() || gridColor;

	const boxes = laneBoxes(lanes.length, height);
	for (let i = 0; i < boxes.length; i++) {
		const box = boxes[i];
		ctx.fillStyle = gridColor;
		for (const tick of SPECTRUM_DB_TICKS) {
			if (tick === SPECTRUM_MAX_DB || tick === SPECTRUM_MIN_DB) continue;
			ctx.fillRect(0, Math.round(box.y + dbToY(tick, box.h)), width, 1);
		}
		for (const hz of SPECTRUM_FREQUENCY_TICKS_HZ) {
			const x = frequencyToX(hz, width);
			if (x === null || x <= 0 || x >= width) continue;
			ctx.fillRect(Math.round(x), box.y, 1, box.h);
		}

		const curve = spectrumCurve(lanes[i], width, box.h);
		if (curve.length > 0) {
			const bottom = box.y + box.h;
			ctx.beginPath();
			ctx.moveTo(curve[0].x, bottom);
			for (const p of curve) ctx.lineTo(p.x, box.y + p.y);
			ctx.lineTo(curve[curve.length - 1].x, bottom);
			ctx.closePath();
			ctx.globalAlpha = 0.45;
			ctx.fillStyle = curveColor;
			ctx.fill();
			ctx.globalAlpha = 1;
			ctx.beginPath();
			for (let j = 0; j < curve.length; j++) {
				const p = curve[j];
				if (j === 0) ctx.moveTo(p.x, box.y + p.y);
				else ctx.lineTo(p.x, box.y + p.y);
			}
			ctx.strokeStyle = curveColor;
			ctx.lineWidth = 1;
			ctx.stroke();
		}

		const peak = peaks?.[i];
		if (peak) {
			const line = spectrumCurve(peak, width, box.h);
			ctx.beginPath();
			for (let j = 0; j < line.length; j++) {
				const p = line[j];
				if (j === 0) ctx.moveTo(p.x, box.y + p.y);
				else ctx.lineTo(p.x, box.y + p.y);
			}
			ctx.strokeStyle = peakColor;
			ctx.lineWidth = 1;
			ctx.stroke();
		}

		if (i > 0) {
			ctx.fillStyle = dividerColor;
			ctx.fillRect(0, box.y, width, 1);
		}
	}
}

// ---------------------------------------------------------------------------
// the band height (contract 2; the waveform's rules, its own key)
// ---------------------------------------------------------------------------

export const SPECTRUM_HEIGHT_STORAGE_KEY = 'vellis.spectrum-height';
export const MIN_SPECTRUM_HEIGHT = 48;
export const DEFAULT_SPECTRUM_HEIGHT = 120;
const MAX_SPECTRUM_HEIGHT_RATIO = 0.4;

/** [MIN_SPECTRUM_HEIGHT, 40 % of the window height]; the minimum wins in a tiny window. */
export function clampSpectrumHeight(height: number, windowHeight: number): number {
	const max = windowHeight * MAX_SPECTRUM_HEIGHT_RATIO;
	return Math.max(MIN_SPECTRUM_HEIGHT, Math.min(height, max));
}

/** The height while dragging its divider: the waveform's rule (`dragWaveformHeight`), clamped with the spectrum's range. */
export function dragSpectrumHeight(startHeight: number, d: number, freeSpace: number, windowHeight: number): number {
	const t = freeSpace / 2;
	const delta = d <= t ? 2 * d : freeSpace + (d - t);
	return clampSpectrumHeight(startHeight + delta, windowHeight);
}

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** Saves the height as a number string; non-finite values are not written. */
export function saveSpectrumHeight(height: number): void {
	if (!Number.isFinite(height)) return;
	try {
		storage()?.setItem(SPECTRUM_HEIGHT_STORAGE_KEY, String(height));
	} catch {
		// Not saved; the window still uses it.
	}
}

/** The saved height clamped to the window; unreadable → the default. */
export function loadSpectrumHeight(windowHeight: number): number {
	let raw: string | null = null;
	try {
		raw = storage()?.getItem(SPECTRUM_HEIGHT_STORAGE_KEY) ?? null;
	} catch {
		raw = null;
	}
	const parsed = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
	return clampSpectrumHeight(Number.isFinite(parsed) ? parsed : DEFAULT_SPECTRUM_HEIGHT, windowHeight);
}
