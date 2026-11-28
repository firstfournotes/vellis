/**
 * Requirement #91 (docs/requirements/req-91.md) — the spectrum band inside AudioViewer (component project, jsdom).
 * The audio twin of VideoViewer.spectrum.wiring.test.ts (that file holds the full contract): AC-91-2 (placement above the
 * waveform), AC-91-3 (L / R), AC-91-4 (reset on seek), AC-91-5 (the lanes follow ←/→ and seeks while paused), AC-91-6 (no
 * touch of the <audio>), AC-91-7 (the waveform's reason), AC-91-8 (shown / hidden), AC-91-9 (the height and its key).
 *
 * ## Fixed contract (AudioViewer specifics)
 *
 * ```text
 * Document order: .audio-toolbar → .spectrum-divider → [data-testid="audio-spectrum"] → .waveform-divider → .audio-waveform
 * (inside .audio-pane; the spectrum sits above the waveform, which is the audio viewer's "player part" — decision 4 "above the waveform").
 * The source for mp3 / m4a / webm is fetched like the waveform (loadWaveformSource) and decoded at 32 kHz; wav goes through
 * `loadWav` (a Rust command — not tested here, the device gate covers wav).
 * The band's note in AudioViewer uses the AUDIO wording: audioWaveformNote(source, analyzing) of $lib/audio-viewing
 * (the audio viewer's waveform has said "this audio" since requirement 50; contract 10 = the same reason as the waveform),
 * not spectrumBandNote / waveformBandNote (the video wording).
 * ```
 *
 * ## Stubs (the house style of AudioViewer.window-lanes.wiring.test.ts)
 * fetch → a successful 64-byte body (the mp3 route), OfflineAudioContext fake (records channels / sampleRate, decodes to a
 * 1 s stereo tone in L), AudioContext fake (must stay unused), play / pause spies, ResizeObserver, clientWidth, getContext,
 * pointer capture polyfill. requestAnimationFrame is jsdom's own (nothing here plays).
 *
 * ## Why this is red before the implementation
 * - `$lib/audio-spectrum` / `$lib/spectrum-visibility` do not exist; then the band is not in the DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import AudioViewer from './AudioViewer.svelte';
import { AUDIO_WAVEFORM_HEIGHT_STORAGE_KEY, audioWaveformNote } from '$lib/audio-viewing';
import {
	DEFAULT_SPECTRUM_HEIGHT,
	SPECTRUM_HEIGHT_STORAGE_KEY,
	SPECTRUM_SAMPLE_RATE,
	createPeakHold,
	resetPeakHold,
	spectrumBandNote,
	spectrumLanes,
} from '$lib/audio-spectrum';
import { applySpectrumShown, setSpectrumAvailable } from '$lib/spectrum-visibility';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('$lib/audio-spectrum', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/audio-spectrum')>();
	return {
		...actual,
		spectrumLanes: vi.fn(actual.spectrumLanes),
		resetPeakHold: vi.fn(actual.resetPeakHold),
		createPeakHold: vi.fn(actual.createPeakHold),
	};
});
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = {
		label: 'main',
		emit: vi.fn(async () => undefined),
		onFocusChanged: vi.fn(async () => () => {}),
		listen: vi.fn(async () => () => {}),
	};
	return { ...actual, getCurrentWindow: () => fake };
});

const elementProto = Element.prototype as unknown as {
	setPointerCapture?: (id: number) => void;
	releasePointerCapture?: (id: number) => void;
	hasPointerCapture?: (id: number) => boolean;
};
if (typeof elementProto.setPointerCapture !== 'function') {
	elementProto.setPointerCapture = () => {};
	elementProto.releasePointerCapture = () => {};
	elementProto.hasPointerCapture = () => false;
}

class ImmediateResizeObserver {
	#callback: (entries: { target: Element }[], observer: unknown) => void;
	constructor(callback: (entries: { target: Element }[], observer: unknown) => void) {
		this.#callback = callback;
	}
	observe(target: Element): void {
		queueMicrotask(() => this.#callback([{ target }], this));
	}
	unobserve(): void {}
	disconnect(): void {}
}

type FakeAudioBuffer = {
	numberOfChannels: number;
	length: number;
	sampleRate: number;
	getChannelData(channel: number): Float32Array;
};

function toneBuffer(rate: number): FakeAudioBuffer {
	const length = rate;
	const l = new Float32Array(length);
	for (let i = 0; i < length; i++) l[i] = Math.sin((2 * Math.PI * 1000 * i) / rate);
	const r = new Float32Array(length);
	return { numberOfChannels: 2, length, sampleRate: rate, getChannelData: (c) => (c === 0 ? l : r) };
}

const PROPS = {
	uri: 'file:///Users/a/music/take.mp3',
	src: 'vellis-asset://local/Users/a/music/take.mp3',
};

const SPECTRUM = '[data-testid="audio-spectrum"]';
const band = () => document.querySelector(SPECTRUM) as HTMLElement | null;
const divider = () => document.querySelector('.spectrum-divider') as HTMLElement | null;
const spectrumNote = () => (band()?.querySelector('.spectrum-note') as HTMLElement | null) ?? null;
const spectrumLabels = () => Array.from(band()?.querySelectorAll('.spectrum-lane-label') ?? []).map((el) => el.textContent);
const waveformBand = () => document.querySelector('.audio-waveform') as HTMLElement | null;
const waveformDivider = () => document.querySelector('.waveform-divider') as HTMLElement | null;
const waveformNote = () => document.querySelector('.waveform-note') as HTMLElement | null;
const bandHeight = () => Number.parseFloat((band() as HTMLElement).style.height);

function isBefore(a: Element, b: Element): boolean {
	return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

async function pointer(el: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', clientY: number) {
	const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
	const init: Record<string, unknown> = {
		bubbles: true,
		cancelable: true,
		composed: true,
		clientX: 20,
		clientY,
		button: 0,
		buttons: type === 'pointerup' ? 0 : 1,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true,
	};
	await fireEvent(el, new Ctor(type, init as MouseEventInit));
}

let offlineContexts: Array<{ numberOfChannels: number; sampleRate: number }>;
let audioContextConstructions: number;
let createMediaElementSourceSpy: ReturnType<typeof vi.fn>;
let pauseSpy: ReturnType<typeof vi.fn>;
let fetchOk: boolean;

beforeEach(() => {
	localStorage.clear();
	setSpectrumAvailable(false);
	applySpectrumShown(true);
	vi.mocked(spectrumLanes).mockClear();
	vi.mocked(resetPeakHold).mockClear();
	vi.mocked(createPeakHold).mockClear();
	fetchOk = true;
	vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({
			ok: fetchOk,
			status: fetchOk ? 200 : 404,
			headers: { get: () => null },
			arrayBuffer: async () => new ArrayBuffer(64),
			bytes: async () => new Uint8Array(64),
		})),
	);
	offlineContexts = [];
	audioContextConstructions = 0;
	createMediaElementSourceSpy = vi.fn();
	class FakeOfflineAudioContext {
		sampleRate: number;
		constructor(...args: unknown[]) {
			const opts =
				typeof args[0] === 'object' && args[0] !== null
					? (args[0] as { numberOfChannels: number; sampleRate: number })
					: { numberOfChannels: args[0] as number, sampleRate: args[2] as number };
			offlineContexts.push({ numberOfChannels: opts.numberOfChannels, sampleRate: opts.sampleRate });
			this.sampleRate = opts.sampleRate;
		}
		async decodeAudioData(_bytes: ArrayBuffer): Promise<FakeAudioBuffer> {
			return toneBuffer(this.sampleRate);
		}
		createMediaElementSource = createMediaElementSourceSpy;
	}
	class FakeAudioContext {
		constructor() {
			audioContextConstructions += 1;
		}
		createMediaElementSource = createMediaElementSourceSpy;
	}
	vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
	vi.stubGlobal('AudioContext', FakeAudioContext);
	vi.stubGlobal('webkitAudioContext', FakeAudioContext);
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
	pauseSpy = vi.fn(() => undefined);
	vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined);
	vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pauseSpy as unknown as HTMLMediaElement['pause']);
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get: () => 320,
	});
});

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** Mount an inline mp3 (60 s, paused, currentTime read / write) and let the metadata arrive. */
async function mountAudio() {
	const utils = render(AudioViewer, { props: PROPS });
	const audio = document.querySelector('audio') as HTMLAudioElement;
	expect(audio).not.toBeNull();
	let time = 0;
	Object.defineProperty(audio, 'currentTime', {
		configurable: true,
		get: () => time,
		set: (value: number) => {
			time = value;
		},
	});
	Object.defineProperty(audio, 'paused', { configurable: true, get: () => true });
	Object.defineProperty(audio, 'duration', { configurable: true, get: () => 60 });
	await fireEvent(audio, new Event('loadedmetadata'));
	await fireEvent(audio, new Event('durationchange'));
	return { ...utils, audio, setTime: (value: number) => (time = value) };
}

async function waitForSpectrumReady() {
	await vi.waitFor(() => {
		expect(spectrumNote()).toBeNull();
		expect(spectrumLabels()).toEqual(['L', 'R']);
	});
}

function pane(): HTMLElement {
	const el = document.querySelector('[role="application"]');
	expect(el).not.toBeNull();
	return el as HTMLElement;
}

describe('AudioViewer spectrum band — placement above the waveform and the analyzing note (AC-91-2 contract 2 / 10)', () => {
	it('mounts the divider, the band and its canvas above the waveform band, saying "analyzing" first', () => {
		render(AudioViewer, { props: PROPS });

		const toolbar = document.querySelector('.audio-toolbar') as HTMLElement;
		expect(toolbar).not.toBeNull();
		expect(band(), 'the spectrum band').not.toBeNull();
		expect(divider(), 'the spectrum divider').not.toBeNull();
		expect(divider()?.getAttribute('role')).toBe('separator');
		expect(divider()?.getAttribute('aria-label')).toBe('Resize Spectrum');
		expect(band()?.querySelector('canvas.spectrum-canvas')).not.toBeNull();
		expect((document.querySelector('.audio-pane') as HTMLElement).contains(band())).toBe(true);

		expect(isBefore(toolbar, divider() as Element)).toBe(true);
		expect(isBefore(divider() as Element, band() as Element)).toBe(true);
		expect(isBefore(band() as Element, waveformDivider() as Element)).toBe(true);
		expect(isBefore(waveformDivider() as Element, waveformBand() as Element)).toBe(true);
		expect((waveformBand() as HTMLElement).contains(band())).toBe(false);

		expect(spectrumNote()?.textContent?.trim()).toBe(audioWaveformNote(null, true));
		expect(spectrumNote()?.textContent?.trim()).toBe(spectrumBandNote(null, true));
		expect(bandHeight()).toBe(DEFAULT_SPECTRUM_HEIGHT);
	});
});

describe('AudioViewer spectrum band — ready at 32 kHz stereo, the <audio> untouched (AC-91-3 / 6)', () => {
	it('decodes at 32 kHz with 2+ channels (the waveform still at 8 kHz), shows L / R, builds no AudioContext and never pauses', async () => {
		const { audio } = await mountAudio();
		await waitForSpectrumReady();

		const spectrumDecode = offlineContexts.find((c) => c.sampleRate === SPECTRUM_SAMPLE_RATE);
		expect(spectrumDecode).toBeDefined();
		expect(spectrumDecode?.numberOfChannels).toBeGreaterThanOrEqual(2);
		expect(offlineContexts.some((c) => c.sampleRate === 8000)).toBe(true);
		await vi.waitFor(() => {
			expect(waveformNote()).toBeNull();
		});
		expect(audioContextConstructions).toBe(0);
		expect(createMediaElementSourceSpy).not.toHaveBeenCalled();
		expect(pauseSpy).not.toHaveBeenCalled();
		expect(document.querySelector('audio')).toBe(audio);
		expect(audio.hasAttribute('controls')).toBe(false);
	});
});

describe('AudioViewer spectrum band — the waveform\'s reason when the file cannot be read (AC-91-7 contract 10)', () => {
	it('a failed fetch shows "unreadable" in the audio wording in both bands and leaves playback alone', async () => {
		fetchOk = false;
		const { audio } = await mountAudio();
		// The audio viewer's waveform says "Could not read this audio" (audioWaveformNote, requirement 50); the spectrum
		// band says the same (contract 10), not the video wording of waveformBandNote.
		const expected = audioWaveformNote({ state: 'unreadable' }, false);
		expect(expected).toBe('Could not read this audio');
		await vi.waitFor(() => {
			expect(spectrumNote()?.textContent?.trim()).toBe(expected);
			expect(waveformNote()?.textContent?.trim()).toBe(expected);
		});
		expect(document.querySelector('audio')).toBe(audio);
		expect(pauseSpy).not.toHaveBeenCalled();
	});
});

describe('AudioViewer spectrum band — follows ←/→ and seeks while paused; a seek resets the peak hold (AC-91-4 / 5)', () => {
	it('ArrowRight moves the position to 5 s and the lanes are computed there; seeked at 12.5 s resets the hold and computes at 12.5 s', async () => {
		const { audio, setTime } = await mountAudio();
		await waitForSpectrumReady();
		vi.mocked(spectrumLanes).mockClear();

		await fireEvent.keyDown(pane(), { key: 'ArrowRight' });
		await vi.waitFor(() => {
			const positions = vi.mocked(spectrumLanes).mock.calls.map(([, position]) => position);
			expect(positions.some((p) => Math.abs(p - 5) < 1e-6), `lanes at 5 s (saw ${positions.join(', ')})`).toBe(true);
		});

		const resetsBefore = vi.mocked(resetPeakHold).mock.calls.length + vi.mocked(createPeakHold).mock.calls.length;
		vi.mocked(spectrumLanes).mockClear();
		setTime(12.5);
		await fireEvent(audio, new Event('seeking'));
		await fireEvent(audio, new Event('seeked'));
		await vi.waitFor(() => {
			const positions = vi.mocked(spectrumLanes).mock.calls.map(([, position]) => position);
			expect(positions.some((p) => Math.abs(p - 12.5) < 1e-6), `lanes at 12.5 s (saw ${positions.join(', ')})`).toBe(true);
		});
		await vi.waitFor(() => {
			expect(vi.mocked(resetPeakHold).mock.calls.length + vi.mocked(createPeakHold).mock.calls.length).toBeGreaterThan(resetsBefore);
		});
		expect(pauseSpy).not.toHaveBeenCalled();
	});
});

describe('AudioViewer spectrum band — shown / hidden by the app-wide setting (AC-91-8 contract 11)', () => {
	it('hiding removes the divider and the band, the waveform stays; showing brings them back', async () => {
		await mountAudio();
		expect(band()).not.toBeNull();
		applySpectrumShown(false);
		await vi.waitFor(() => {
			expect(band()).toBeNull();
			expect(divider()).toBeNull();
		});
		expect(waveformBand()).not.toBeNull();
		expect(waveformDivider()).not.toBeNull();
		applySpectrumShown(true);
		await vi.waitFor(() => {
			expect(band()).not.toBeNull();
		});
	});

	it('mounting with the setting hidden shows no band until it is turned on', async () => {
		applySpectrumShown(false);
		await mountAudio();
		expect(band()).toBeNull();
		expect(waveformBand()).not.toBeNull();
		applySpectrumShown(true);
		await vi.waitFor(() => {
			expect(band()).not.toBeNull();
		});
	});
});

describe('AudioViewer spectrum band — the height drags and is remembered under its own key (AC-91-9 contract 2)', () => {
	it('dragging the spectrum divider grows the band and saves vellis.spectrum-height; the audio waveform height and key stay', async () => {
		await mountAudio();
		await waitForSpectrumReady();
		const heightBefore = bandHeight();
		expect(heightBefore).toBe(DEFAULT_SPECTRUM_HEIGHT);
		const waveformHeightBefore = (waveformBand() as HTMLElement).style.height;

		const handle = divider() as HTMLElement;
		await pointer(handle, 'pointerdown', 300);
		await pointer(handle, 'pointermove', 270);
		await vi.waitFor(() => {
			expect(bandHeight()).toBe(heightBefore + 30);
		});
		await pointer(handle, 'pointerup', 270);
		expect(localStorage.getItem(SPECTRUM_HEIGHT_STORAGE_KEY)).toBe(String(heightBefore + 30));
		expect(localStorage.getItem(AUDIO_WAVEFORM_HEIGHT_STORAGE_KEY)).toBeNull();
		expect((waveformBand() as HTMLElement).style.height).toBe(waveformHeightBefore);
	});

	it('a saved spectrum height is restored on mount (the same key in both viewers)', async () => {
		localStorage.setItem(SPECTRUM_HEIGHT_STORAGE_KEY, '160');
		await mountAudio();
		await vi.waitFor(() => {
			expect(bandHeight()).toBe(160);
		});
	});
});
