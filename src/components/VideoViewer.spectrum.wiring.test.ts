/**
 * Requirement #91 (docs/requirements/req-91.md) — the spectrum band inside VideoViewer (component project, jsdom).
 * AC-91-2 (the band's placement between the video and the waveform), AC-91-3 (L / R labels), AC-91-4 (the peak hold is
 * reset by a seek), AC-91-5 (the lanes follow the playback position while paused), AC-91-6 (no touch of the playback path,
 * the waveform still decodes at 8 kHz), AC-91-7 (the same degraded reason as the waveform, playback not stopped),
 * AC-91-8 (shown / hidden by the app-wide setting and by the menu event; the window reports availability), AC-91-9 (the
 * band height drags and is remembered under its own key).
 *
 * The pure functions are `src/lib/audio-spectrum.acceptance.test.ts`; the setting is
 * `src/lib/spectrum-visibility.acceptance.test.ts`; AudioViewer has its own `AudioViewer.spectrum.wiring.test.ts`.
 *
 * ## Fixed contract (the implementer follows this; the same DOM in VideoViewer and AudioViewer)
 *
 * ```text
 * .spectrum-divider[role="separator"][aria-orientation="horizontal"][aria-label="Resize Spectrum"]   // drag handle above the band
 * [data-testid="audio-spectrum"].spectrum-band[style="height: <px>px"]                           // the band (absent when hidden)
 *   canvas.spectrum-canvas                                                                      // the curve, the peak line, the grid
 *   .spectrum-note                        // spectrumBandNote(source, analyzing) while it is not null (analyzing / the degraded reason)
 *   .spectrum-lane-label                  // 'L' then 'R' for stereo, none for mono (like .waveform-lane-label)
 * Document order in VideoViewer: .video-stage → .spectrum-divider → [data-testid="audio-spectrum"] → .waveform-divider → .video-waveform
 * (the band is inside .video-controls, above the waveform's own divider; it is not inside .video-stage nor .video-waveform).
 * - The source: analyzeSpectrumSource(uri, { durationSeconds, hasAudioTrack: detectAudioTrack(el), decode: decodeSpectrumAudio,
 *   extract: extractWaveformAudio, loadWav }) after loadedmetadata, like the waveform; mp4 / mov bytes come from the SAME
 *   `extract_waveform_audio` command. decodeSpectrumAudio = OfflineAudioContext(channels >= 2, …, 32000).decodeAudioData.
 * - Each frame / position change: spectrumLanes(source, position) from $lib/audio-spectrum (this test spies on it).
 * - A seek (`seeking` / `seeked` on the <video>) calls resetPeakHold (or makes a new hold with createPeakHold).
 * - Shown / hidden: subscribeSpectrumShown + currentSpectrumShown from $lib/spectrum-visibility; hidden = the divider and the
 *   band are not in the DOM. On mount setSpectrumAvailable(true), on destroy setSpectrumAvailable(false) (the report to Rust).
 * - Height: loadSpectrumHeight / dragSpectrum… / saveSpectrumHeight of $lib/audio-spectrum (key vellis.spectrum-height);
 *   the waveform's height and key are untouched.
 * - Nothing of this touches the <video>: no AudioContext, no createMediaElementSource, no pause(), the same element.
 * - The canvas's full CSS width is the 20 Hz…16 kHz log axis (x = frequencyToX(hz, canvas width), no horizontal inset);
 *   the dB grid may be drawn on the canvas, the tick labels are DOM elements (`.spectrum-tick`) or drawn inside the
 *   band (the device gate req91-gate.e2e.ts finds the 1 kHz / 5 kHz peaks by column on the canvas).
 * ```
 *
 * ## Stubs (the house style of VideoViewer.wiring.test.ts)
 * ResizeObserver (immediate), clientWidth = 320, getContext → null (observed only), fetch → throws (mp4 does not fetch),
 * invoke: extract_waveform_audio → 64 bytes (both analyses extract), everything else → null. OfflineAudioContext is a fake
 * that records (channels, sampleRate) and decodes to a 1 s stereo buffer with a 1 kHz tone in L at the requested rate.
 * AudioContext is a fake that records its construction (it must stay at zero). HTMLMediaElement.play / pause are spies.
 * Pointer capture methods are polyfilled (jsdom has none).
 *
 * ## Why this is red before the implementation
 * - `$lib/audio-spectrum` / `$lib/spectrum-visibility` do not exist (the imports fail); then the band is not in the DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import VideoViewer from './VideoViewer.svelte';
import { invoke } from '$lib/ipc';
import { waveformBandNote } from '$lib/audio-waveform';
import { WAVEFORM_HEIGHT_STORAGE_KEY } from '$lib/waveform-resize';
import {
	DEFAULT_SPECTRUM_HEIGHT,
	SPECTRUM_HEIGHT_STORAGE_KEY,
	SPECTRUM_SAMPLE_RATE,
	createPeakHold,
	resetPeakHold,
	spectrumBandNote,
	spectrumLanes,
} from '$lib/audio-spectrum';
import {
	MENU_SHOW_SPECTRUM_EVENT,
	SPECTRUM_STATE_EVENT,
	applySpectrumShown,
	registerSpectrumVisibilityListeners,
	setSpectrumAvailable,
} from '$lib/spectrum-visibility';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openPath: vi.fn(async () => undefined),
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
type Handler = (e: { payload: unknown }) => void;
vi.mock('$lib/events', () => {
	const handlers = new Map<string, Handler[]>();
	return {
		listen: async (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const cur = handlers.get(event) ?? [];
				const at = cur.indexOf(handler);
				if (at >= 0) cur.splice(at, 1);
			};
		},
		__eventHandlers: handlers,
	};
});
const windowEmitMock = vi.fn(async (_event: string, _payload?: unknown) => undefined);
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = {
		label: 'main',
		emit: (event: string, payload?: unknown) => windowEmitMock(event, payload),
		onFocusChanged: vi.fn(async () => () => {}),
		listen: vi.fn(async () => () => {}),
	};
	return { ...actual, getCurrentWindow: () => fake };
});
import * as eventsModule from '$lib/events';
const menuHandlers = (eventsModule as unknown as { __eventHandlers: Map<string, Handler[]> }).__eventHandlers;

/** jsdom has no pointer capture; the dividers call it on pointerdown / pointerup. */
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

/** One second of stereo at `rate`: a full-scale 1 kHz tone in L, silence in R. */
function toneBuffer(rate: number): FakeAudioBuffer {
	const length = rate;
	const l = new Float32Array(length);
	for (let i = 0; i < length; i++) l[i] = Math.sin((2 * Math.PI * 1000 * i) / rate);
	const r = new Float32Array(length);
	return { numberOfChannels: 2, length, sampleRate: rate, getChannelData: (c) => (c === 0 ? l : r) };
}

const PROPS = {
	uri: 'file:///Users/a/movies/clip.mp4',
	src: 'vellis-asset://local/Users/a/movies/clip.mp4',
};

const SPECTRUM = '[data-testid="audio-spectrum"]';
const band = () => document.querySelector(SPECTRUM) as HTMLElement | null;
const divider = () => document.querySelector('.spectrum-divider') as HTMLElement | null;
const spectrumNote = () => (band()?.querySelector('.spectrum-note') as HTMLElement | null) ?? null;
const spectrumLabels = () => Array.from(band()?.querySelectorAll('.spectrum-lane-label') ?? []).map((el) => el.textContent);
const waveformBand = () => document.querySelector('.video-waveform') as HTMLElement | null;
const waveformDivider = () => document.querySelector('.waveform-divider') as HTMLElement | null;
const waveformNote = () => document.querySelector('.waveform-note') as HTMLElement | null;
const waveformLabels = () => Array.from(document.querySelectorAll('.waveform-lane-label')).map((el) => el.textContent);
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

const stateReports = () =>
	windowEmitMock.mock.calls.filter(([event]) => event === SPECTRUM_STATE_EVENT).map(([, payload]) => payload as { label: string; shown: boolean; available: boolean });

let offlineContexts: Array<{ numberOfChannels: number; sampleRate: number }>;
let audioContextConstructions: number;
let createMediaElementSourceSpy: ReturnType<typeof vi.fn>;
let pauseSpy: ReturnType<typeof vi.fn>;
let getContextSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	localStorage.clear();
	menuHandlers.clear();
	windowEmitMock.mockClear();
	setSpectrumAvailable(false);
	applySpectrumShown(true);
	windowEmitMock.mockClear();
	vi.mocked(spectrumLanes).mockClear();
	vi.mocked(resetPeakHold).mockClear();
	vi.mocked(createPeakHold).mockClear();
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockImplementation(async (command: string) => (command === 'extract_waveform_audio' ? new ArrayBuffer(64) : null));

	vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		}),
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
	getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null) as unknown as ReturnType<typeof vi.fn>;
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

/** Mount an inline mp4 with a 60 s duration and let the metadata arrive (both analyses wait for it). */
async function mountVideo() {
	const utils = render(VideoViewer, { props: PROPS });
	const video = document.querySelector('video.video') as HTMLVideoElement;
	expect(video).not.toBeNull();
	Object.defineProperty(video, 'duration', { configurable: true, get: () => 60 });
	await fireEvent(video, new Event('durationchange'));
	await fireEvent(video, new Event('loadedmetadata'));
	return { ...utils, video };
}

/** Wait until the spectrum is ready: no note, L / R labels. */
async function waitForSpectrumReady() {
	await vi.waitFor(() => {
		expect(spectrumNote()).toBeNull();
		expect(spectrumLabels()).toEqual(['L', 'R']);
	});
}

describe('VideoViewer spectrum band — placement and the analyzing note (AC-91-2 contract 2 / 10)', () => {
	it('mounts a divider, the band and its canvas between the video and the waveform, saying "analyzing" until the result arrives', () => {
		render(VideoViewer, { props: PROPS });

		const stage = document.querySelector('.video-stage') as HTMLElement;
		expect(stage).not.toBeNull();
		expect(band(), 'the spectrum band').not.toBeNull();
		expect(divider(), 'the spectrum divider').not.toBeNull();
		expect(divider()?.getAttribute('role')).toBe('separator');
		expect(divider()?.getAttribute('aria-orientation')).toBe('horizontal');
		expect(divider()?.getAttribute('aria-label')).toBe('Resize Spectrum');
		expect(band()?.querySelector('canvas.spectrum-canvas'), 'the spectrum canvas').not.toBeNull();
		expect(band()?.classList.contains('spectrum-band')).toBe(true);

		// Between the video and the waveform: after the stage, before the waveform's divider and band; inside neither.
		expect(isBefore(stage, divider() as Element)).toBe(true);
		expect(isBefore(divider() as Element, band() as Element)).toBe(true);
		expect(isBefore(band() as Element, waveformDivider() as Element)).toBe(true);
		expect(isBefore(waveformDivider() as Element, waveformBand() as Element)).toBe(true);
		expect(stage.contains(band())).toBe(false);
		expect((waveformBand() as HTMLElement).contains(band())).toBe(false);

		// Before any result the band says what the waveform says while analyzing.
		expect(spectrumNote()?.textContent?.trim()).toBe(spectrumBandNote(null, true));
		expect(spectrumBandNote(null, true)).toBe(waveformBandNote(null, true));
		expect(bandHeight()).toBe(DEFAULT_SPECTRUM_HEIGHT);
	});
});

describe('VideoViewer spectrum band — ready from a 32 kHz stereo decode; the playback path and the waveform are untouched (AC-91-3 / 6)', () => {
	it('shows L / R once decoded at 32 kHz with 2+ channels; the waveform still decodes at 8 kHz; no AudioContext, no createMediaElementSource, no pause', async () => {
		const { video } = await mountVideo();
		await waitForSpectrumReady();

		// The spectrum's own decode: an OfflineAudioContext at 32 kHz with at least two channels (L / R).
		const spectrumDecode = offlineContexts.find((c) => c.sampleRate === SPECTRUM_SAMPLE_RATE);
		expect(spectrumDecode, 'an OfflineAudioContext at 32000 Hz').toBeDefined();
		expect(spectrumDecode?.numberOfChannels).toBeGreaterThanOrEqual(2);
		// The waveform's decode is unchanged: mono at 8 kHz (contract 9).
		expect(offlineContexts.some((c) => c.sampleRate === 8000)).toBe(true);
		await vi.waitFor(() => {
			expect(waveformNote()).toBeNull();
			expect(waveformLabels()).toEqual(['L', 'R']);
		});
		// Both analyses took the Rust extraction (mp4 never fetches).
		const extractCalls = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'extract_waveform_audio');
		expect(extractCalls.length).toBeGreaterThanOrEqual(1);
		expect(fetch).not.toHaveBeenCalled();

		// The playback path is not touched (contract 8).
		expect(audioContextConstructions).toBe(0);
		expect(createMediaElementSourceSpy).not.toHaveBeenCalled();
		expect(pauseSpy).not.toHaveBeenCalled();
		expect(document.querySelector('video.video')).toBe(video);
		// The spectrum canvas is drawn (the draw effect reaches it).
		expect(getContextSpy).toHaveBeenCalledWith('2d');
	});
});

describe('VideoViewer spectrum band — the degraded reasons are the waveform\'s; playback is not stopped (AC-91-7 contract 10)', () => {
	it.each(['no-audio', 'too-large', 'unsupported-codec', 'unreadable'] as const)('%s from the extraction shows the same reason in both bands', async (reason) => {
		vi.mocked(invoke).mockImplementation(async (command: string) => {
			if (command === 'extract_waveform_audio') throw new Error(reason);
			return null;
		});
		const { video } = await mountVideo();

		const expected = waveformBandNote({ state: reason }, false);
		expect(expected).not.toBeNull();
		await vi.waitFor(() => {
			expect(spectrumNote()?.textContent?.trim()).toBe(expected);
			expect(waveformNote()?.textContent?.trim()).toBe(expected);
		});
		expect(spectrumLabels()).toEqual([]);
		expect(document.querySelector('video.video')).toBe(video);
		expect(pauseSpy).not.toHaveBeenCalled();
		expect(audioContextConstructions).toBe(0);
	});
});

describe('VideoViewer spectrum band — follows the playback position while paused; a seek resets the peak hold (AC-91-4 / 5)', () => {
	it('after a seek to 12.5 s the lanes are computed at 12.5 s and the peak hold is reset', async () => {
		const { video } = await mountVideo();
		await waitForSpectrumReady();
		vi.mocked(spectrumLanes).mockClear();
		const resetsBefore = vi.mocked(resetPeakHold).mock.calls.length + vi.mocked(createPeakHold).mock.calls.length;

		Object.defineProperty(video, 'currentTime', {
			configurable: true,
			get: () => 12.5,
			set: () => {},
		});
		await fireEvent(video, new Event('seeking'));
		await fireEvent(video, new Event('seeked'));

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

describe('VideoViewer spectrum band — shown / hidden by the app-wide setting and the menu; the window reports availability (AC-91-8 contract 11)', () => {
	it('hiding removes the divider and the band (the waveform stays); showing brings them back; the menu event toggles', async () => {
		await registerSpectrumVisibilityListeners();
		await mountVideo();
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
			expect(divider()).not.toBeNull();
		});

		// View ▸ Show Audio Spectrum arrives as the menu event and toggles.
		const handlers = menuHandlers.get(MENU_SHOW_SPECTRUM_EVENT) ?? [];
		expect(handlers.length, 'the menu event is listened to').toBeGreaterThan(0);
		for (const h of handlers) h({ payload: null });
		await vi.waitFor(() => {
			expect(band()).toBeNull();
		});
		expect(localStorage.getItem('vellis.spectrum-shown')).toBe('0');
		for (const h of handlers) h({ payload: null });
		await vi.waitFor(() => {
			expect(band()).not.toBeNull();
		});
	});

	it('mounting reports { shown: true, available: true } to Rust; unmounting reports available: false', async () => {
		const { unmount } = await mountVideo();
		await vi.waitFor(() => {
			expect(stateReports().some((r) => r.label === 'main' && r.shown === true && r.available === true)).toBe(true);
		});
		windowEmitMock.mockClear();
		unmount();
		await vi.waitFor(() => {
			expect(stateReports().some((r) => r.available === false)).toBe(true);
		});
	});
});

describe('VideoViewer spectrum band — the height drags and is remembered under its own key (AC-91-9 contract 2)', () => {
	it('dragging the spectrum divider up by 20 px grows the band by 20 px and saves vellis.spectrum-height; the waveform keeps its own', async () => {
		await mountVideo();
		await waitForSpectrumReady();
		const heightBefore = bandHeight();
		expect(heightBefore).toBe(DEFAULT_SPECTRUM_HEIGHT);
		const waveformHeightBefore = (waveformBand() as HTMLElement).style.height;

		const handle = divider() as HTMLElement;
		await pointer(handle, 'pointerdown', 300);
		await pointer(handle, 'pointermove', 280);
		await vi.waitFor(() => {
			expect(bandHeight()).toBe(heightBefore + 20);
		});
		expect(localStorage.getItem(SPECTRUM_HEIGHT_STORAGE_KEY), 'not saved while dragging').toBeNull();
		await pointer(handle, 'pointerup', 280);
		expect(localStorage.getItem(SPECTRUM_HEIGHT_STORAGE_KEY)).toBe(String(heightBefore + 20));
		expect(localStorage.getItem(WAVEFORM_HEIGHT_STORAGE_KEY)).toBeNull();
		expect((waveformBand() as HTMLElement).style.height).toBe(waveformHeightBefore);
	});

	it('a saved spectrum height is restored on mount; a saved waveform height does not leak into the spectrum', async () => {
		localStorage.setItem(SPECTRUM_HEIGHT_STORAGE_KEY, '150');
		localStorage.setItem(WAVEFORM_HEIGHT_STORAGE_KEY, '200');
		await mountVideo();
		await vi.waitFor(() => {
			expect(bandHeight()).toBe(150);
		});
		expect(Number.parseFloat((waveformBand() as HTMLElement).style.height)).toBe(200);
	});
});
