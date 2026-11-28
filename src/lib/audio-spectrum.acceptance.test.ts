/**
 * Requirement #91 (docs/requirements/req-91.md) — the audio spectrum at the playback position, up to 16 kHz.
 * Pure part (unit project, jsdom): AC-91-1 (peaks on the log axis, nothing above 16 kHz), AC-91-2 (the fixed
 * -90…0 dBFS axis), AC-91-3 (L / R lanes, mono = one lane), AC-91-4 (the peak-hold line), AC-91-5 (the window
 * around the playback position), AC-91-7 (the same degraded reasons as the waveform), AC-91-9 (the band height
 * is remembered under its own key) and the "no new dependency" rule of contract 3.
 *
 * Wiring (the bands inside VideoViewer / AudioViewer) is `src/components/VideoViewer.spectrum.wiring.test.ts` and
 * `src/components/AudioViewer.spectrum.wiring.test.ts`; the setting (View ▸ Show Audio Spectrum) is
 * `src/lib/spectrum-visibility.acceptance.test.ts`; the native menu is `src-tauri/tests/acceptance_req91.rs`;
 * the device gate is `tests/e2e/specs/req91-gate.e2e.ts`.
 *
 * ## Fixed contract (the implementer follows this; new module `src/lib/audio-spectrum.ts`, no CJK in code lines)
 *
 * ```ts
 * // --- constants (contract 3 / 4 / 6)
 * export const SPECTRUM_SAMPLE_RATE = 32000;        // the rate the audio is decoded at (OfflineAudioContext)
 * export const SPECTRUM_FFT_SIZE = 4096;            // samples per analysis window (about 0.128 s at 32 kHz)
 * export const SPECTRUM_MIN_HZ = 20;                // left end of the log axis
 * export const SPECTRUM_MAX_HZ = 16000;             // right end; nothing above it is drawn
 * export const SPECTRUM_MIN_DB = -90;               // bottom of the fixed dBFS axis
 * export const SPECTRUM_MAX_DB = 0;                 // top
 * export const SPECTRUM_FREQUENCY_TICKS_HZ: readonly number[] = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 16000];
 * export const SPECTRUM_DB_TICKS: readonly number[] = [0, -30, -60, -90];
 * export const SPECTRUM_PEAK_HOLD_MS = 1000;        // a peak is held this long before it falls
 * export function frequencyTickLabel(hz: number): string;   // '20' … '500', '1k', '2k', '5k', '10k', '16k'
 *
 * // --- analysis (contract 3)
 * export function hannWindow(size: number): Float32Array;                       // size values, ~0 at both ends, 1 at the centre
 * export function binFrequency(bin: number, sampleRate?: number, size?: number): number;   // bin * rate / size
 * export function frameAround(samples: Float32Array, centerIndex: number, size?: number): Float32Array;
 * //   exactly `size` samples with samples[centerIndex] at index size / 2; outside [0, samples.length) is 0 (no throw)
 * export function frameAt(samples: Float32Array, positionSeconds: number, sampleRate: number, size?: number): Float32Array;
 * //   = frameAround(samples, Math.round(positionSeconds * sampleRate), size)
 * export function spectrumDb(frame: Float32Array): Float32Array;
 * //   Hann window + FFT (own code, no dependency) of a frame of SPECTRUM_FFT_SIZE samples → size / 2 + 1 values in dBFS.
 * //   Normalised so that a full-scale sine (amplitude 1.0) on a bin centre reads 0 dB at that bin (amplitude A → 20·log10(A)).
 * //   Silence reads SPECTRUM_MIN_DB or lower (-Infinity is allowed).
 *
 * // --- geometry (contract 4)
 * export function frequencyToX(hz: number, width: number): number | null;
 * //   log axis: 20 Hz → 0, 16 kHz → width, x = width · ln(hz / 20) / ln(16000 / 20). null outside [20, 16000] (and for non-finite / ≤ 0)
 * export function dbToY(db: number, height: number): number;
 * //   0 dB → 0 (top), -90 dB → height (bottom), linear in between, clamped; non-finite (NaN, -Infinity) → height
 * export function spectrumCurve(db: Float32Array, width: number, height: number, sampleRate?: number): Array<{ x: number; y: number }>;
 * //   one point per bin whose frequency is within [20, 16000], in ascending frequency (bin k ↔ k · rate / (2 · (db.length - 1)));
 * //   x = frequencyToX(binFrequency), y = dbToY(db[k]). No point for a bin above 16 kHz
 *
 * // --- the source and the lanes (contract 1 / 5 / 10)
 * export type SpectrumSource =
 *   | { state: 'ready'; channels: Float32Array[]; sampleRate: number; durationSeconds: number }
 *   | { state: 'no-audio' | 'too-large' | 'unreadable' | 'unsupported-codec' | 'decode-failed' };
 * export function spectrumLanes(source: SpectrumSource & { state: 'ready' }, positionSeconds: number): Float32Array[];
 * //   2 channels → [L, R] (each spectrumDb(frameAt(channel, position, source.sampleRate))); 1 channel → 1 lane;
 * //   3 or more → 1 lane of the per-sample average (the waveform's rule, waveformLanes); 0 → []
 * export function spectrumBandNote(source: SpectrumSource | null, analyzing: boolean): string | null;
 * //   the SAME text as waveformBandNote(result, analyzing) for the same state (null while ready; the analyzing text while
 * //   null / analyzing without a ready result; the degraded reason otherwise)
 * export async function analyzeSpectrumSource(uri: string, input: {
 *   durationSeconds: number | null; hasAudioTrack: boolean | null;
 *   decode: WaveformDecode;            // bytes → audio at SPECTRUM_SAMPLE_RATE (decodeSpectrumAudio in the app)
 *   extract: WaveformExtract;          // mov / mp4: the SAME Rust extraction as the waveform (extractWaveformAudio)
 *   loadWav?: WaveformExtract;         // wav: bytes `decode` can read (a Rust command; see the judgement record). Missing → 'unreadable'
 * }): Promise<SpectrumSource>;
 * //   routes as waveformPlan: hasAudioTrack === false → no-audio (no IO); .mp4 / .mov → extract (bytes > WAVEFORM_MAX_SOURCE_BYTES →
 * //   too-large); .wav → loadWav (never fetch); else → fetch through loadWaveformSource (its reasons). decode failure → decode-failed,
 * //   except a fetched EBML body whose Tracks hold no audio → no-audio (webmTrackKinds). 0 channels / 0 samples → no-audio. Never throws
 * export async function decodeSpectrumAudio(bytes: ArrayBuffer): Promise<WaveformAudioBuffer>;
 * //   new OfflineAudioContext(channels >= 2, length, SPECTRUM_SAMPLE_RATE).decodeAudioData(bytes) — the only decode seam (contract 8)
 *
 * // --- the peak-hold line (contract 6)
 * export interface PeakHold { readonly size: number }
 * export function createPeakHold(size: number): PeakHold;
 * export function updatePeakHold(hold: PeakHold, db: Float32Array, nowMs: number): Float32Array;
 * //   per bin: a value >= the held one replaces it and restarts its clock; a lower value keeps the held one for SPECTRUM_PEAK_HOLD_MS,
 * //   then the line falls (monotonically) towards the current value and settles on it within a few seconds. The returned values are
 * //   finite and >= SPECTRUM_MIN_DB. Length = db.length
 * export function resetPeakHold(hold: PeakHold): void;   // forget everything (a seek): the next update returns the current values
 *
 * // --- the band height (contract 2; the waveform's rules, its own key)
 * export const SPECTRUM_HEIGHT_STORAGE_KEY = 'vellis.spectrum-height';
 * export const MIN_SPECTRUM_HEIGHT: number;        // >= 40
 * export const DEFAULT_SPECTRUM_HEIGHT: number;    // >= MIN_SPECTRUM_HEIGHT
 * export function clampSpectrumHeight(height: number, windowHeight: number): number;   // [MIN, windowHeight · 0.4], MIN wins
 * export function saveSpectrumHeight(height: number): void;        // non-finite → nothing written
 * export function loadSpectrumHeight(windowHeight: number): number; // unreadable → default; finite → clamped
 * ```
 *
 * ## Judgement record (test-writer 2026-11-27)
 * - 50 Hz and 60 Hz: with a Hann window of 4096 samples at 32 kHz the two tones are 1.28 bins apart and the main lobe is
 *   ±2 bins wide, so two tones sounding AT THE SAME TIME merge into one hump (the requirement's note "50 Hz and 60 Hz can be told apart"
 *   does not hold for a mixture). Mains hum is either 50 Hz or 60 Hz, never both, so the criterion here is: a 50 Hz
 *   tone peaks at bin 6 (46.9 Hz) and a 60 Hz tone at bin 8 (62.5 Hz) — different bins on different sides of 55 Hz.
 * - The dB normalisation (full-scale sine on a bin centre = 0 dB) is fixed because AC-91-2 says "a 0 dBFS sine near the top".
 * - wav gets its own seam `loadWav` (a Rust command returning bytes `decode` can read), never `fetch`: a 2-hour wav is 1.27 GB
 *   and the waveform already keeps wav out of the WebView's fetch path (requirement 50 contract 5).
 *
 * ## Why this is red before the implementation
 * - `src/lib/audio-spectrum.ts` does not exist (the import fails).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
	DEFAULT_SPECTRUM_HEIGHT,
	MIN_SPECTRUM_HEIGHT,
	SPECTRUM_DB_TICKS,
	SPECTRUM_FFT_SIZE,
	SPECTRUM_FREQUENCY_TICKS_HZ,
	SPECTRUM_HEIGHT_STORAGE_KEY,
	SPECTRUM_MAX_DB,
	SPECTRUM_MAX_HZ,
	SPECTRUM_MIN_DB,
	SPECTRUM_MIN_HZ,
	SPECTRUM_PEAK_HOLD_MS,
	SPECTRUM_SAMPLE_RATE,
	analyzeSpectrumSource,
	binFrequency,
	clampSpectrumHeight,
	createPeakHold,
	dbToY,
	decodeSpectrumAudio,
	frameAround,
	frameAt,
	frequencyTickLabel,
	frequencyToX,
	hannWindow,
	loadSpectrumHeight,
	resetPeakHold,
	saveSpectrumHeight,
	spectrumBandNote,
	spectrumCurve,
	spectrumDb,
	spectrumLanes,
	updatePeakHold,
	type SpectrumSource,
} from './audio-spectrum';
import {
	WAVEFORM_HEIGHT_STORAGE_KEY,
} from './waveform-resize';
import {
	WAVEFORM_MAX_FETCH_BYTES,
	WAVEFORM_MAX_SOURCE_BYTES,
	waveformBandNote,
	type WaveformAudioBuffer,
	type WaveformExtraction,
	type WaveformResult,
} from './audio-waveform';

const REPO_ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const N = 4096;
const RATE = 32000;
const BIN_HZ = RATE / N; // 7.8125

/** A sine of `hz` with amplitude `amp`, `length` samples at `rate`. */
function sine(hz: number, amp: number, length = N, rate = RATE): Float32Array {
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
	return out;
}

/** Element-wise sum of equally long arrays. */
function mix(...parts: Float32Array[]): Float32Array {
	const out = new Float32Array(parts[0].length);
	for (const p of parts) for (let i = 0; i < out.length; i++) out[i] += p[i];
	return out;
}

function argmax(values: ArrayLike<number>): number {
	let best = 0;
	for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
	return best;
}

function audioBuf(channels: Float32Array[], sampleRate = RATE): WaveformAudioBuffer {
	return {
		numberOfChannels: channels.length,
		length: channels[0]?.length ?? 0,
		sampleRate,
		getChannelData: (c: number) => channels[c],
	};
}

function readySource(channels: Float32Array[], sampleRate = RATE): SpectrumSource & { state: 'ready' } {
	return {
		state: 'ready',
		channels,
		sampleRate,
		durationSeconds: (channels[0]?.length ?? 0) / sampleRate,
	};
}

/** A fetch Response look-alike (the waveform's loader reads ok / headers / arrayBuffer). */
function fakeResponse(ok: boolean, body: ArrayBuffer, contentLength: number | null = body.byteLength) {
	return {
		ok,
		status: ok ? 200 : 404,
		headers: { get: (name: string) => (name.toLowerCase() === 'content-length' && contentLength !== null ? String(contentLength) : null) },
		arrayBuffer: async () => body,
	};
}

/** A minimal EBML / WebM head whose Tracks hold one video TrackEntry and no audio. */
function videoOnlyWebm(): ArrayBuffer {
	const trackEntry = [0xae, 0x83, 0x83, 0x81, 0x01]; // TrackEntry { TrackType = 1 (video) }
	const tracks = [0x16, 0x54, 0xae, 0x6b, 0x80 | trackEntry.length, ...trackEntry];
	const segment = [0x18, 0x53, 0x80, 0x67, 0x80 | tracks.length, ...tracks];
	const header = [0x1a, 0x45, 0xdf, 0xa3, 0x80];
	return Uint8Array.from([...header, ...segment]).buffer;
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// constants (contract 3 / 4 / 6)
// ---------------------------------------------------------------------------

describe('AC-91-1/2/4 constants: 32 kHz, 4096 samples, 20 Hz…16 kHz, -90…0 dB, the ticks, 1 s peak hold', () => {
	test('the analysis constants are fixed', () => {
		expect(SPECTRUM_SAMPLE_RATE).toBe(32000);
		expect(SPECTRUM_FFT_SIZE).toBe(4096);
		expect(SPECTRUM_MIN_HZ).toBe(20);
		expect(SPECTRUM_MAX_HZ).toBe(16000);
		expect(SPECTRUM_MIN_DB).toBe(-90);
		expect(SPECTRUM_MAX_DB).toBe(0);
		expect(SPECTRUM_PEAK_HOLD_MS).toBe(1000);
		expect(binFrequency(1)).toBeCloseTo(7.8125, 10);
		expect(binFrequency(128)).toBe(1000);
	});

	test('the frequency ticks are 20, 50, 100, 200, 500 Hz, 1, 2, 5, 10, 16 kHz with short labels; the dB ticks are 0, -30, -60, -90', () => {
		expect([...SPECTRUM_FREQUENCY_TICKS_HZ]).toEqual([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 16000]);
		expect(SPECTRUM_FREQUENCY_TICKS_HZ.map((hz) => frequencyTickLabel(hz))).toEqual([
			'20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '16k',
		]);
		expect([...SPECTRUM_DB_TICKS]).toEqual([0, -30, -60, -90]);
	});

	test('the Hann window is the right length, ~0 at both ends, 1 at the centre and sums to about N / 2', () => {
		const w = hannWindow(N);
		expect(w).toBeInstanceOf(Float32Array);
		expect(w.length).toBe(N);
		expect(w[0]).toBeLessThan(1e-3);
		expect(w[N - 1]).toBeLessThan(1e-3);
		let max = 0;
		let sum = 0;
		for (const v of w) {
			if (v > max) max = v;
			sum += v;
		}
		expect(max).toBeCloseTo(1, 3);
		expect(sum / (N / 2)).toBeCloseTo(1, 2);
	});
});

// ---------------------------------------------------------------------------
// AC-91-1 — peaks land on their frequency; nothing above 16 kHz (contract 3 / 4)
// ---------------------------------------------------------------------------

describe('AC-91-1 the peak of a known sine lands on its frequency (Hann, 4096 samples, 32 kHz)', () => {
	test('spectrumDb returns N / 2 + 1 bins (up to the Nyquist frequency, 16 kHz)', () => {
		const db = spectrumDb(sine(1000, 1));
		expect(db).toBeInstanceOf(Float32Array);
		expect(db.length).toBe(N / 2 + 1);
		expect(binFrequency(db.length - 1)).toBe(16000);
	});

	test.each([1000, 8000, 15000])('a full-scale %d Hz sine (on a bin centre) peaks at exactly that bin and reads ~0 dB', (hz) => {
		const db = spectrumDb(sine(hz, 1));
		const peak = argmax(db);
		expect(peak).toBe(hz / BIN_HZ);
		expect(binFrequency(peak)).toBe(hz);
		expect(db[peak]).toBeGreaterThanOrEqual(-0.5);
		expect(db[peak]).toBeLessThanOrEqual(0.5);
	});

	test('a -45 dBFS sine at 1 kHz reads about -45 dB at its bin (the scale is dB, not relative)', () => {
		const db = spectrumDb(sine(1000, 10 ** (-45 / 20)));
		expect(argmax(db)).toBe(128);
		expect(db[128]).toBeGreaterThanOrEqual(-45.5);
		expect(db[128]).toBeLessThanOrEqual(-44.5);
	});

	test('50 Hz and 60 Hz (mains hum) peak at different bins on opposite sides of 55 Hz (bin 6 = 46.9 Hz, bin 8 = 62.5 Hz)', () => {
		const at50 = spectrumDb(sine(50, 1));
		const at60 = spectrumDb(sine(60, 1));
		const peak50 = argmax(at50);
		const peak60 = argmax(at60);
		expect(peak50).toBe(Math.round(50 / BIN_HZ));
		expect(peak60).toBe(Math.round(60 / BIN_HZ));
		expect(peak50).not.toBe(peak60);
		expect(binFrequency(peak50)).toBeLessThan(55);
		expect(binFrequency(peak60)).toBeGreaterThan(55);
		// Off-centre tones lose at most the Hann scalloping (about 1.4 dB).
		expect(at50[peak50]).toBeGreaterThanOrEqual(-2);
		expect(at60[peak60]).toBeGreaterThanOrEqual(-2);
		// On the log axis the two peaks sit on either side of the 55 Hz midpoint between the 50 and 60 marks.
		const width = 1000;
		const mid = frequencyToX(55, width) as number;
		expect(frequencyToX(binFrequency(peak50), width) as number).toBeLessThan(mid);
		expect(frequencyToX(binFrequency(peak60), width) as number).toBeGreaterThan(mid);
	});

	test('two tones 1 kHz and 8 kHz sounding together give two peaks at both bins', () => {
		const db = spectrumDb(mix(sine(1000, 0.5), sine(8000, 0.5)));
		expect(db[128]).toBeGreaterThanOrEqual(-7);
		expect(db[1024]).toBeGreaterThanOrEqual(-7);
		// Between them (3 kHz) only leakage: far below both peaks.
		expect(db[384]).toBeLessThan(db[128] - 40);
	});

	test('silence reads at or below -90 dB in every bin', () => {
		const db = spectrumDb(new Float32Array(N));
		for (const v of db) expect(v).toBeLessThanOrEqual(SPECTRUM_MIN_DB);
	});
});

describe('AC-91-1 the window is a Hann window: the side lobes of an off-centre tone are far below its peak (contract 3)', () => {
	test('a tone half a bin off (1003.90625 Hz = bin 128.5): bins 4.5 away are at least 35 dB down, bins 11.5 away at least 50 dB down', () => {
		// A rectangular window would leave bin 133 only about 19 dB under the peak (sinc side lobes); Hann puts it near -48 dB.
		const db = spectrumDb(sine(128.5 * BIN_HZ, 1));
		const peak = Math.max(db[128], db[129]);
		expect(peak).toBeGreaterThanOrEqual(-2);
		expect(Math.abs(db[128] - db[129])).toBeLessThanOrEqual(0.5);
		for (const bin of [124, 133]) expect(db[bin], `bin ${bin}`).toBeLessThanOrEqual(peak - 35);
		for (const bin of [117, 140]) expect(db[bin], `bin ${bin}`).toBeLessThanOrEqual(peak - 50);
		expect(argmax(db) === 128 || argmax(db) === 129).toBe(true);
	});

	test('a full-scale 50 Hz tone leaks at most -45 dB into the 1 kHz bin (the hum does not paint the voice band)', () => {
		const db = spectrumDb(sine(50, 1));
		expect(db[128]).toBeLessThanOrEqual(-45);
	});
});

describe('AC-91-1 the log axis 20 Hz…16 kHz and the curve stop at 16 kHz (contract 4)', () => {
	test('frequencyToX maps 20 Hz to 0, 16 kHz to the width, 1 kHz to ln(50)/ln(800) of the width, monotonically', () => {
		const width = 640;
		expect(frequencyToX(20, width)).toBe(0);
		expect(frequencyToX(16000, width)).toBeCloseTo(width, 9);
		expect(frequencyToX(1000, width)).toBeCloseTo((width * Math.log(1000 / 20)) / Math.log(16000 / 20), 9);
		let previous = -1;
		for (const hz of SPECTRUM_FREQUENCY_TICKS_HZ) {
			const x = frequencyToX(hz, width);
			expect(x, `tick ${hz} Hz is on the axis`).not.toBeNull();
			expect(x as number).toBeGreaterThan(previous);
			previous = x as number;
		}
	});

	test('frequencyToX is null outside [20, 16000] and for non-finite or non-positive input', () => {
		for (const hz of [19.99, 16000.01, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 7.8125, 20000]) {
			expect(frequencyToX(hz, 640), `${hz} Hz`).toBeNull();
		}
	});

	test('spectrumCurve has one point per bin within 20 Hz…16 kHz, ascending, inside the width; the last point is the 16 kHz bin', () => {
		const db = spectrumDb(sine(1000, 1));
		const width = 800;
		const height = 120;
		const curve = spectrumCurve(db, width, height);
		const inRange = [];
		for (let k = 0; k < db.length; k++) {
			const hz = binFrequency(k);
			if (hz >= SPECTRUM_MIN_HZ && hz <= SPECTRUM_MAX_HZ) inRange.push(k);
		}
		expect(curve.length).toBe(inRange.length);
		for (let i = 1; i < curve.length; i++) expect(curve[i].x).toBeGreaterThan(curve[i - 1].x);
		for (const p of curve) {
			expect(p.x).toBeGreaterThanOrEqual(0);
			expect(p.x).toBeLessThanOrEqual(width + 1e-9);
			expect(p.y).toBeGreaterThanOrEqual(0);
			expect(p.y).toBeLessThanOrEqual(height + 1e-9);
		}
		expect(curve[curve.length - 1].x).toBeCloseTo(width, 9);
		expect(curve[0].x).toBeCloseTo(frequencyToX(binFrequency(inRange[0]), width) as number, 9);
		// The tallest point (smallest y) is the 1 kHz bin.
		let top = 0;
		for (let i = 1; i < curve.length; i++) if (curve[i].y < curve[top].y) top = i;
		expect(curve[top].x).toBeCloseTo(frequencyToX(1000, width) as number, 9);
	});
});

// ---------------------------------------------------------------------------
// AC-91-2 — the fixed dBFS axis (contract 4)
// ---------------------------------------------------------------------------

describe('AC-91-2 the vertical axis is fixed at -90…0 dBFS', () => {
	test('dbToY: 0 dB at the top, -90 dB at the bottom, linear between, clamped, non-finite at the bottom', () => {
		const h = 180;
		expect(dbToY(0, h)).toBe(0);
		expect(dbToY(-90, h)).toBe(h);
		expect(dbToY(-45, h)).toBeCloseTo(h / 2, 9);
		expect(dbToY(-30, h)).toBeCloseTo(h / 3, 9);
		expect(dbToY(6, h)).toBe(0);
		expect(dbToY(-120, h)).toBe(h);
		expect(dbToY(Number.NEGATIVE_INFINITY, h)).toBe(h);
		expect(dbToY(Number.NaN, h)).toBe(h);
	});

	test('a 0 dBFS sine reaches the top of the band (within 5 % of the height); silence lies on the bottom edge', () => {
		const height = 200;
		const loud = spectrumCurve(spectrumDb(sine(1000, 1)), 800, height);
		const minY = Math.min(...loud.map((p) => p.y));
		expect(minY).toBeLessThanOrEqual(height * 0.05);
		const quiet = spectrumCurve(spectrumDb(new Float32Array(N)), 800, height);
		for (const p of quiet) expect(p.y).toBe(height);
	});
});

// ---------------------------------------------------------------------------
// AC-91-5 — the window around the playback position (contract 3 / 7)
// ---------------------------------------------------------------------------

describe('AC-91-5 the analysis window is centred on the playback position; the ends are zero-padded', () => {
	const samples = Float32Array.from({ length: 10000 }, (_, i) => i + 1);

	test('frameAround copies size samples with the centre at index size / 2', () => {
		const f = frameAround(samples, 5000);
		expect(f.length).toBe(N);
		expect(f[N / 2]).toBe(samples[5000]);
		expect(f[0]).toBe(samples[5000 - N / 2]);
		expect(f[N - 1]).toBe(samples[5000 - N / 2 + N - 1]);
	});

	test('frameAround at the head: the first half is zero, the centre is the first sample', () => {
		const f = frameAround(samples, 0);
		for (let i = 0; i < N / 2; i++) expect(f[i]).toBe(0);
		expect(f[N / 2]).toBe(samples[0]);
		expect(f[N / 2 + 1]).toBe(samples[1]);
	});

	test('frameAround at the tail: the centre is the last sample, the rest is zero', () => {
		const f = frameAround(samples, samples.length - 1);
		expect(f[N / 2]).toBe(samples[samples.length - 1]);
		for (let i = N / 2 + 1; i < N; i++) expect(f[i]).toBe(0);
	});

	test('frameAround beyond either end does not throw and yields silence', () => {
		expect(() => frameAround(samples, -50000)).not.toThrow();
		expect(() => frameAround(samples, 10 ** 9)).not.toThrow();
		expect(frameAround(samples, 10 ** 9).every((v) => v === 0)).toBe(true);
		expect(frameAround(new Float32Array(0), 0).every((v) => v === 0)).toBe(true);
	});

	test('frameAt rounds the position to a sample index at the given rate', () => {
		expect(frameAt(samples, 0.1, 32000)).toEqual(frameAround(samples, 3200));
		expect(frameAt(samples, 0.1, 8000)).toEqual(frameAround(samples, 800));
	});

	test('moving the position moves the result: 1 kHz for the first two seconds, 5 kHz after', () => {
		const first = sine(1000, 0.8, 2 * RATE);
		const second = sine(5000, 0.8, 2 * RATE);
		const channel = new Float32Array(4 * RATE);
		channel.set(first, 0);
		channel.set(second, 2 * RATE);
		const source = readySource([channel]);
		expect(argmax(spectrumLanes(source, 1.0)[0])).toBe(128);
		expect(argmax(spectrumLanes(source, 3.0)[0])).toBe(640);
		// A position past the end is silence, not an exception.
		const past = spectrumLanes(source, 99)[0];
		for (const v of past) expect(v).toBeLessThanOrEqual(SPECTRUM_MIN_DB);
	});
});

// ---------------------------------------------------------------------------
// AC-91-3 — L / R lanes, mono is one lane (contract 5)
// ---------------------------------------------------------------------------

describe('AC-91-3 stereo gives two lanes (L on top); a tone in L only peaks in the top lane; mono is one lane', () => {
	test('stereo with sound in L only: lane 0 peaks at 1 kHz, lane 1 is silent', () => {
		const lanes = spectrumLanes(readySource([sine(1000, 1, RATE), new Float32Array(RATE)]), 0.5);
		expect(lanes).toHaveLength(2);
		expect(argmax(lanes[0])).toBe(128);
		expect(lanes[0][128]).toBeGreaterThanOrEqual(-0.5);
		for (const v of lanes[1]) expect(v).toBeLessThanOrEqual(SPECTRUM_MIN_DB);
	});

	test('stereo with sound in R only: the peak is in lane 1', () => {
		const lanes = spectrumLanes(readySource([new Float32Array(RATE), sine(8000, 1, RATE)]), 0.5);
		expect(lanes).toHaveLength(2);
		for (const v of lanes[0]) expect(v).toBeLessThanOrEqual(SPECTRUM_MIN_DB);
		expect(argmax(lanes[1])).toBe(1024);
	});

	test('mono is one lane; three or more channels are mixed into one lane', () => {
		expect(spectrumLanes(readySource([sine(1000, 1, RATE)]), 0.5)).toHaveLength(1);
		const three = spectrumLanes(readySource([sine(1000, 1, RATE), new Float32Array(RATE), new Float32Array(RATE)]), 0.5);
		expect(three).toHaveLength(1);
		expect(argmax(three[0])).toBe(128);
		expect(spectrumLanes(readySource([]), 0.5)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC-91-4 — the peak-hold line (contract 6)
// ---------------------------------------------------------------------------

describe('AC-91-4 the peak-hold line keeps a peak about one second, then falls; a reset forgets it', () => {
	const loud = Float32Array.from([-90, -20, -90, -90]);
	const quiet = Float32Array.from([-90, -90, -90, -90]);

	test('the first update returns the current values; a lower input keeps the peak within the hold time', () => {
		const hold = createPeakHold(4);
		expect(hold.size).toBe(4);
		expect(Array.from(updatePeakHold(hold, loud, 0))).toEqual(Array.from(loud));
		expect(updatePeakHold(hold, quiet, 500)[1]).toBe(-20);
		expect(updatePeakHold(hold, quiet, 900)[1]).toBe(-20);
	});

	test('after the hold time the line falls monotonically and settles on the current value', () => {
		const hold = createPeakHold(4);
		updatePeakHold(hold, loud, 0);
		const a = updatePeakHold(hold, quiet, SPECTRUM_PEAK_HOLD_MS + 300)[1];
		const b = updatePeakHold(hold, quiet, SPECTRUM_PEAK_HOLD_MS + 600)[1];
		const c = updatePeakHold(hold, quiet, SPECTRUM_PEAK_HOLD_MS + 900)[1];
		expect(a).toBeLessThan(-20);
		expect(b).toBeLessThanOrEqual(a);
		expect(c).toBeLessThanOrEqual(b);
		expect(c).toBeGreaterThanOrEqual(-90);
		const settled = updatePeakHold(hold, quiet, SPECTRUM_PEAK_HOLD_MS + 8000)[1];
		expect(settled).toBeCloseTo(-90, 2);
	});

	test('a value at or above the held one replaces it at once and restarts the clock', () => {
		const hold = createPeakHold(4);
		updatePeakHold(hold, loud, 0);
		updatePeakHold(hold, quiet, 2000);
		const louder = Float32Array.from([-90, -10, -90, -90]);
		expect(updatePeakHold(hold, louder, 2100)[1]).toBe(-10);
		expect(updatePeakHold(hold, quiet, 2900)[1]).toBe(-10);
	});

	test('resetPeakHold forgets the peaks: the next update is the current values', () => {
		const hold = createPeakHold(4);
		updatePeakHold(hold, loud, 0);
		resetPeakHold(hold);
		expect(Array.from(updatePeakHold(hold, quiet, 100))).toEqual(Array.from(quiet));
	});

	test('the line is finite and never below -90 dB even when the input is -Infinity (digital silence)', () => {
		const hold = createPeakHold(2);
		const line = updatePeakHold(hold, Float32Array.from([Number.NEGATIVE_INFINITY, -120]), 0);
		expect(line.length).toBe(2);
		for (const v of line) {
			expect(Number.isFinite(v)).toBe(true);
			expect(v).toBeGreaterThanOrEqual(SPECTRUM_MIN_DB);
		}
	});
});

// ---------------------------------------------------------------------------
// AC-91-7 — the same degraded reasons as the waveform (contract 10)
// ---------------------------------------------------------------------------

describe('AC-91-7 spectrumBandNote says exactly what waveformBandNote says for the same state', () => {
	const degraded: Array<Exclude<WaveformResult['state'], 'ready'>> = [
		'no-audio', 'too-large', 'unreadable', 'unsupported-codec', 'decode-failed',
	];

	test('analyzing (no result yet) shows the waveform\'s analyzing text', () => {
		const text = spectrumBandNote(null, true);
		expect(text).toBe(waveformBandNote(null, true));
		expect(text).not.toBeNull();
		expect(spectrumBandNote(null, false)).toBe(waveformBandNote(null, false));
	});

	test.each(degraded)('%s shows the waveform\'s reason', (state) => {
		const text = spectrumBandNote({ state }, false);
		expect(text).toBe(waveformBandNote({ state }, false));
		expect(text).not.toBeNull();
	});

	test('ready shows nothing, also while a new analysis runs (the drawn spectrum stays)', () => {
		const ready = readySource([sine(1000, 1, RATE)]);
		expect(spectrumBandNote(ready, false)).toBeNull();
		expect(spectrumBandNote(ready, true)).toBeNull();
	});
});

describe('AC-91-7 analyzeSpectrumSource follows the waveform\'s routes and reasons (contract 1 / 10)', () => {
	const decoded32k = () => audioBuf([sine(1000, 1, RATE), new Float32Array(RATE)], RATE);

	test('no audio track → no-audio without any IO', async () => {
		const decode = vi.fn(async () => decoded32k());
		const extract = vi.fn(async (): Promise<WaveformExtraction> => ({ state: 'ok', bytes: new ArrayBuffer(8) }));
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const result = await analyzeSpectrumSource('file:///a/clip.mp4', { durationSeconds: 3, hasAudioTrack: false, decode, extract });
		expect(result).toEqual({ state: 'no-audio' });
		expect(decode).not.toHaveBeenCalled();
		expect(extract).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test('mp4 / mov: the Rust extraction, then decode of the same bytes → ready with all channels, the rate and the duration', async () => {
		const bytes = new ArrayBuffer(16);
		const decode = vi.fn(async () => decoded32k());
		const extract = vi.fn(async (): Promise<WaveformExtraction> => ({ state: 'ok', bytes }));
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		for (const uri of ['file:///a/clip.mp4', 'file:///a/clip.MOV']) {
			const result = await analyzeSpectrumSource(uri, { durationSeconds: null, hasAudioTrack: null, decode, extract });
			expect(extract).toHaveBeenLastCalledWith(uri);
			expect(decode).toHaveBeenLastCalledWith(bytes);
			expect(result.state).toBe('ready');
			if (result.state === 'ready') {
				expect(result.channels).toHaveLength(2);
				expect(result.sampleRate).toBe(32000);
				expect(result.durationSeconds).toBeCloseTo(1, 9);
				expect(argmax(spectrumDb(frameAt(result.channels[0], 0.5, result.sampleRate)))).toBe(128);
			}
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test.each(['no-audio', 'too-large', 'unsupported-codec', 'unreadable'] as const)('extraction says %s → the same state, no decode', async (state) => {
		const decode = vi.fn(async () => decoded32k());
		const extract = vi.fn(async (): Promise<WaveformExtraction> => ({ state }));
		const result = await analyzeSpectrumSource('file:///a/clip.mov', { durationSeconds: null, hasAudioTrack: null, decode, extract });
		expect(result).toEqual({ state });
		expect(decode).not.toHaveBeenCalled();
	});

	test('extraction throws → unreadable; extracted bytes over WAVEFORM_MAX_SOURCE_BYTES → too-large before any decode', async () => {
		const decode = vi.fn(async () => decoded32k());
		const throwing = vi.fn(async (): Promise<WaveformExtraction> => {
			throw new Error('ipc down');
		});
		expect(await analyzeSpectrumSource('file:///a/clip.mp4', { durationSeconds: null, hasAudioTrack: null, decode, extract: throwing })).toEqual({ state: 'unreadable' });
		const huge = { byteLength: WAVEFORM_MAX_SOURCE_BYTES + 1 } as unknown as ArrayBuffer;
		const big = vi.fn(async (): Promise<WaveformExtraction> => ({ state: 'ok', bytes: huge }));
		expect(await analyzeSpectrumSource('file:///a/clip.mp4', { durationSeconds: null, hasAudioTrack: null, decode, extract: big })).toEqual({ state: 'too-large' });
		expect(decode).not.toHaveBeenCalled();
	});

	test('decode fails on an extracted container → decode-failed; a decoded buffer without channels or samples → no-audio', async () => {
		const extract = vi.fn(async (): Promise<WaveformExtraction> => ({ state: 'ok', bytes: new ArrayBuffer(8) }));
		const failing = vi.fn(async (): Promise<WaveformAudioBuffer> => {
			throw new DOMException('bad', 'EncodingError');
		});
		expect(await analyzeSpectrumSource('file:///a/clip.mp4', { durationSeconds: null, hasAudioTrack: null, decode: failing, extract })).toEqual({ state: 'decode-failed' });
		const empty = vi.fn(async () => audioBuf([], RATE));
		expect(await analyzeSpectrumSource('file:///a/clip.mp4', { durationSeconds: null, hasAudioTrack: null, decode: empty, extract })).toEqual({ state: 'no-audio' });
		const zeroLength = vi.fn(async () => audioBuf([new Float32Array(0)], RATE));
		expect(await analyzeSpectrumSource('file:///a/clip.mp4', { durationSeconds: null, hasAudioTrack: null, decode: zeroLength, extract })).toEqual({ state: 'no-audio' });
	});

	test('webm / mp3 / m4a: fetched through the waveform\'s loader (its too-large and unreadable reasons), then decoded', async () => {
		const extract = vi.fn(async (): Promise<WaveformExtraction> => ({ state: 'ok', bytes: new ArrayBuffer(8) }));
		const decode = vi.fn(async () => decoded32k());
		const body = new ArrayBuffer(24);
		const fetchSpy = vi.fn(async () => fakeResponse(true, body));
		vi.stubGlobal('fetch', fetchSpy);
		const ready = await analyzeSpectrumSource('file:///a/take.mp3', { durationSeconds: null, hasAudioTrack: null, decode, extract });
		expect(ready.state).toBe('ready');
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(extract).not.toHaveBeenCalled();
		expect(decode).toHaveBeenLastCalledWith(body);

		vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(false, new ArrayBuffer(0))));
		expect(await analyzeSpectrumSource('file:///a/take.m4a', { durationSeconds: null, hasAudioTrack: null, decode, extract })).toEqual({ state: 'unreadable' });

		vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(true, new ArrayBuffer(8), WAVEFORM_MAX_FETCH_BYTES + 1)));
		expect(await analyzeSpectrumSource('file:///a/clip.webm', { durationSeconds: null, hasAudioTrack: null, decode, extract })).toEqual({ state: 'too-large' });

		vi.stubGlobal('fetch', vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		}));
		expect(await analyzeSpectrumSource('file:///a/clip.webm', { durationSeconds: null, hasAudioTrack: null, decode, extract })).toEqual({ state: 'unreadable' });
	});

	test('a fetched webm whose Tracks hold no audio → no-audio when decode fails (the waveform\'s addendum j rule); other decode failures → decode-failed', async () => {
		const extract = vi.fn(async (): Promise<WaveformExtraction> => ({ state: 'ok', bytes: new ArrayBuffer(8) }));
		const failing = vi.fn(async (): Promise<WaveformAudioBuffer> => {
			throw new DOMException('bad', 'EncodingError');
		});
		vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(true, videoOnlyWebm())));
		expect(await analyzeSpectrumSource('file:///a/silent.webm', { durationSeconds: null, hasAudioTrack: null, decode: failing, extract })).toEqual({ state: 'no-audio' });
		vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(true, new ArrayBuffer(32))));
		expect(await analyzeSpectrumSource('file:///a/odd.webm', { durationSeconds: null, hasAudioTrack: null, decode: failing, extract })).toEqual({ state: 'decode-failed' });
	});

	test('wav: its own seam loadWav (never fetch, never extract); missing or throwing → unreadable; its reasons pass through', async () => {
		const extract = vi.fn(async (): Promise<WaveformExtraction> => ({ state: 'ok', bytes: new ArrayBuffer(8) }));
		const decode = vi.fn(async () => decoded32k());
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const wavBytes = new ArrayBuffer(44);
		const loadWav = vi.fn(async (): Promise<WaveformExtraction> => ({ state: 'ok', bytes: wavBytes }));
		const ready = await analyzeSpectrumSource('file:///a/take.wav', { durationSeconds: null, hasAudioTrack: null, decode, extract, loadWav });
		expect(ready.state).toBe('ready');
		expect(loadWav).toHaveBeenCalledWith('file:///a/take.wav');
		expect(decode).toHaveBeenLastCalledWith(wavBytes);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(extract).not.toHaveBeenCalled();

		expect(await analyzeSpectrumSource('file:///a/take.wav', { durationSeconds: null, hasAudioTrack: null, decode, extract })).toEqual({ state: 'unreadable' });
		const throwing = vi.fn(async (): Promise<WaveformExtraction> => {
			throw new Error('ipc down');
		});
		expect(await analyzeSpectrumSource('file:///a/take.wav', { durationSeconds: null, hasAudioTrack: null, decode, extract, loadWav: throwing })).toEqual({ state: 'unreadable' });
		const tooLarge = vi.fn(async (): Promise<WaveformExtraction> => ({ state: 'too-large' }));
		expect(await analyzeSpectrumSource('file:///a/take.wav', { durationSeconds: null, hasAudioTrack: null, decode, extract, loadWav: tooLarge })).toEqual({ state: 'too-large' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// contract 3 / 8 — the decode seam is an OfflineAudioContext at 32 kHz with at least two channels
// ---------------------------------------------------------------------------

describe('decodeSpectrumAudio decodes through an OfflineAudioContext at 32 kHz with at least 2 channels (contract 3 / 8)', () => {
	test('constructs OfflineAudioContext(sampleRate 32000, channels >= 2) and hands the bytes to decodeAudioData', async () => {
		const constructed: Array<{ numberOfChannels: number; sampleRate: number }> = [];
		const decodeSpy = vi.fn(async (_bytes: ArrayBuffer) => audioBuf([sine(1000, 1, RATE), new Float32Array(RATE)], RATE));
		class FakeOfflineAudioContext {
			constructor(...args: unknown[]) {
				const opts = typeof args[0] === 'object' && args[0] !== null
					? (args[0] as { numberOfChannels: number; sampleRate: number })
					: { numberOfChannels: args[0] as number, sampleRate: args[2] as number };
				constructed.push({ numberOfChannels: opts.numberOfChannels, sampleRate: opts.sampleRate });
			}
			decodeAudioData = decodeSpy;
		}
		vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
		vi.stubGlobal('AudioContext', class {
			constructor() {
				throw new Error('AudioContext must not be used: it grabs the output device (contract 8)');
			}
		});
		const bytes = new ArrayBuffer(8);
		const buffer = await decodeSpectrumAudio(bytes);
		expect(constructed).toHaveLength(1);
		expect(constructed[0].sampleRate).toBe(SPECTRUM_SAMPLE_RATE);
		expect(constructed[0].numberOfChannels).toBeGreaterThanOrEqual(2);
		expect(decodeSpy).toHaveBeenCalledWith(bytes);
		expect(buffer.numberOfChannels).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// AC-91-9 — the band height is remembered under its own key (contract 2)
// ---------------------------------------------------------------------------

describe('AC-91-9 the spectrum band height uses the waveform\'s rules under its own storage key', () => {
	test('the key is vellis.spectrum-height (not the waveform\'s); the minimum is at least 40; the default is at least the minimum', () => {
		expect(SPECTRUM_HEIGHT_STORAGE_KEY).toBe('vellis.spectrum-height');
		expect(SPECTRUM_HEIGHT_STORAGE_KEY).not.toBe(WAVEFORM_HEIGHT_STORAGE_KEY);
		expect(MIN_SPECTRUM_HEIGHT).toBeGreaterThanOrEqual(40);
		expect(DEFAULT_SPECTRUM_HEIGHT).toBeGreaterThanOrEqual(MIN_SPECTRUM_HEIGHT);
		expect(Number.isFinite(DEFAULT_SPECTRUM_HEIGHT)).toBe(true);
	});

	test('clampSpectrumHeight keeps [MIN, 40 % of the window height]; the minimum wins in a tiny window', () => {
		expect(clampSpectrumHeight(MIN_SPECTRUM_HEIGHT - 5, 800)).toBe(MIN_SPECTRUM_HEIGHT);
		expect(clampSpectrumHeight(9999, 800)).toBe(320);
		expect(clampSpectrumHeight(200, 800)).toBe(200);
		expect(clampSpectrumHeight(200, 50)).toBe(MIN_SPECTRUM_HEIGHT);
	});

	test('saveSpectrumHeight writes only its own key as a number string; non-finite values are not written', () => {
		saveSpectrumHeight(150);
		expect(localStorage.getItem(SPECTRUM_HEIGHT_STORAGE_KEY)).toBe('150');
		expect(localStorage.getItem(WAVEFORM_HEIGHT_STORAGE_KEY)).toBeNull();
		saveSpectrumHeight(Number.NaN);
		saveSpectrumHeight(Number.POSITIVE_INFINITY);
		expect(localStorage.getItem(SPECTRUM_HEIGHT_STORAGE_KEY)).toBe('150');
	});

	test('loadSpectrumHeight: nothing saved or garbage → the default; a saved number → that number, clamped to the window', () => {
		expect(loadSpectrumHeight(800)).toBe(clampSpectrumHeight(DEFAULT_SPECTRUM_HEIGHT, 800));
		localStorage.setItem(SPECTRUM_HEIGHT_STORAGE_KEY, 'abc');
		expect(loadSpectrumHeight(800)).toBe(clampSpectrumHeight(DEFAULT_SPECTRUM_HEIGHT, 800));
		localStorage.setItem(SPECTRUM_HEIGHT_STORAGE_KEY, '150');
		expect(loadSpectrumHeight(800)).toBe(150);
		expect(loadSpectrumHeight(200)).toBe(clampSpectrumHeight(150, 200));
		expect(loadSpectrumHeight(200)).toBeLessThan(150);
		// The waveform's saved height is not read for the spectrum.
		localStorage.removeItem(SPECTRUM_HEIGHT_STORAGE_KEY);
		localStorage.setItem(WAVEFORM_HEIGHT_STORAGE_KEY, '200');
		expect(loadSpectrumHeight(800)).toBe(clampSpectrumHeight(DEFAULT_SPECTRUM_HEIGHT, 800));
	});
});

// ---------------------------------------------------------------------------
// contract 3 — no new dependency (the FFT is own code)
// ---------------------------------------------------------------------------

describe('contract 3 the FFT is own code: package.json gains no dependency', () => {
	test('dependencies stay the 35 of v0.7.3 and none of them is an FFT / DSP package', () => {
		const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		const names = Object.keys(pkg.dependencies);
		expect(names).toHaveLength(35);
		for (const name of [...names, ...Object.keys(pkg.devDependencies)]) {
			expect(name, `${name} looks like a signal-processing dependency`).not.toMatch(/fft|dsp|spectr|audio|wave|signal/i);
		}
	});

	test('audio-spectrum.ts imports nothing from node_modules', () => {
		const src = readFileSync(resolve(REPO_ROOT, 'src/lib/audio-spectrum.ts'), 'utf8');
		const imports = Array.from(src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)).map((m) => m[1]);
		for (const spec of imports) {
			expect(spec, `import of ${spec}`).toMatch(/^(\.|\$lib\/|svelte$|svelte\/)/);
		}
	});
});
