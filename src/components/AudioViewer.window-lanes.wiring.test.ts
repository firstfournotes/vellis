/**
 * 要件#50 追補f(2026-10-25・Issue #505)の配線テスト — AudioViewer の振る舞い(AC-50-追f の
 * 「描けるなら振る舞いも」・JSDOM)。正本: docs/requirements/req-50.md「追補f」契約 1〜3。
 *
 * 「2 時間級の素材を拡大しているとき、波形の高さのドラッグがカクつく」―― 高さが変わるたびに
 * 描画の `$effect` が `windowLanes`(全標本の走査)を計算し直すのが原因。追補f のあとは、
 * **高さのドラッグで帯は描き直されるが、窓の標本の集め直し(`windowPeaks`)は走らない**。
 *
 * ## 判定するもの
 * - 本命: 拡大(「Zoom In Waveform」1 回=ズーム 2)したあと、帯の上端ハンドルを 2 回ドラッグして
 *   高さを変える。帯は描き直される(`getContext('2d')` の回数が増える・inline の高さが変わる)が、
 *   `windowPeaks` / `windowPeaksFromCoarse` の呼び出し回数は**増えない**
 * - 対照: 同じ状態でもう 1 回拡大(ズーム 4)すると `windowPeaks` は呼ばれる(集め直しが
 *   ズームには反応する=`$derived` が古いまま固まっていない・spy の配線が生きている)
 * - 不変(契約 3): ドラッグで高さが変わり(240 → 280)、pointerup で保存される
 *
 * ## スタブの設計(AudioViewer.waveform-axis.wiring.test.ts の写し)
 * ResizeObserver 即発火版・`clientWidth` = 320・`getContext` の null spy・rAF の手回し・
 * `OfflineAudioContext` の偽物(ステレオ 2ch・標本を保持する短さ)・fetch 成功(mp3 の経路で
 * ready にする)。`$lib/waveform-zoom` は実物を包み、`windowPeaks` / `windowPeaksFromCoarse` だけを
 * spy にする(集め直しの観測点)。JSDOM に無い `setPointerCapture` 系は no-op を足す
 * (RecentFiles.sash.wiring.test.ts の作法)。
 *
 * ## 実装前の見込み(赤の理由)
 * 描画の `$effect` が高さにも依存し、その本体で `windowLanes(` を呼ぶので、ドラッグのたびに
 * `windowPeaks` が 2 回(L/R)ずつ増える=本命が赤。対照と不変は実装前から緑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import AudioViewer from './AudioViewer.svelte';
import { AUDIO_WAVEFORM_HEIGHT_STORAGE_KEY, DEFAULT_AUDIO_WAVEFORM_HEIGHT } from '$lib/audio-viewing';
import { windowPeaks, windowPeaksFromCoarse } from '$lib/waveform-zoom';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('$lib/waveform-zoom', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/waveform-zoom')>();
	return {
		...actual,
		windowPeaks: vi.fn(actual.windowPeaks),
		windowPeaksFromCoarse: vi.fn(actual.windowPeaksFromCoarse),
	};
});

/** JSDOM は `setPointerCapture` 系を持たないので Element.prototype に no-op を足す。 */
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

/** observe された要素を microtask で1回だけ通知する即発火 ResizeObserver。 */
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

/** ステレオ 2ch・標本を保持する短さ(拡大時は `samples` の経路= windowPeaks を通る)。 */
function stereoBuffer(): FakeAudioBuffer {
	const l = Float32Array.from([0.5, -0.5, 0.25, -0.25]);
	const r = Float32Array.from([0.1, -0.1, 0.75, -0.75]);
	return {
		numberOfChannels: 2,
		length: l.length,
		sampleRate: 8000,
		getChannelData: (c: number) => (c === 0 ? l : r),
	};
}

const PROPS = {
	uri: 'file:///Users/a/music/long-take.mp3',
	src: 'vellis-asset://local/Users/a/music/long-take.mp3',
};

/** 尺 60 秒。 */
const DURATION = 60;
/** 横軸(器・canvas)の幅=clientWidth の stub。 */
const AXIS_WIDTH = 320;

const band = () => document.querySelector('.audio-stage .audio-waveform') as HTMLElement | null;
const divider = () => document.querySelector('.audio-stage .waveform-divider') as HTMLElement | null;
const noteEl = () => document.querySelector('.waveform-note') as HTMLElement | null;
const laneLabels = () => Array.from(document.querySelectorAll('.waveform-lane-label')) as HTMLElement[];
const indicator = () => document.querySelector('.seek-window-indicator') as HTMLElement | null;

let getContextSpy: ReturnType<typeof vi.fn>;

/** 集め直しの回数(L/R の 2 レーンぶんが 1 回の計算で 2 件増える)。 */
const regatherCount = () =>
	vi.mocked(windowPeaks).mock.calls.length + vi.mocked(windowPeaksFromCoarse).mock.calls.length;
/** 描き直しの回数(drawWaveform は毎回 getContext('2d') を呼ぶ)。 */
const drawCount = () => getContextSpy.mock.calls.filter((c) => c[0] === '2d').length;

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			arrayBuffer: async () => new ArrayBuffer(8),
			bytes: async () => new Uint8Array(8),
		})),
	);
	vi.stubGlobal(
		'OfflineAudioContext',
		class {
			constructor(_channels: number, _length: number, _sampleRate: number) {}
			async decodeAudioData(_bytes: ArrayBuffer): Promise<FakeAudioBuffer> {
				return stereoBuffer();
			}
		},
	);
	vi.stubGlobal(
		'requestAnimationFrame',
		vi.fn(() => 1),
	);
	vi.stubGlobal(
		'cancelAnimationFrame',
		vi.fn(() => undefined),
	);
	getContextSpy = vi
		.spyOn(HTMLCanvasElement.prototype, 'getContext')
		.mockImplementation(() => null) as unknown as ReturnType<typeof vi.fn>;
	vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined);
	vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get: () => AXIS_WIDTH,
	});
	try {
		localStorage.removeItem(AUDIO_WAVEFORM_HEIGHT_STORAGE_KEY);
	} catch {
		// storage 不可の環境では既定高のまま
	}
	vi.mocked(windowPeaks).mockClear();
	vi.mocked(windowPeaksFromCoarse).mockClear();
});

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** マウントして尺 60 秒・解析 ready(ステレオ=L/R ラベル)まで進め、最初の描画を待つ。 */
async function mountAudio() {
	render(AudioViewer, { props: PROPS });
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
	Object.defineProperty(audio, 'duration', { configurable: true, get: () => DURATION });
	await fireEvent(audio, new Event('loadedmetadata'));
	await fireEvent(audio, new Event('durationchange'));

	await vi.waitFor(() => {
		expect(noteEl(), '解析が終わると文言が消えること').toBeNull();
		expect(laneLabels().map((el) => el.textContent)).toEqual(['L', 'R']);
	});
	// 横軸の幅が確定して最初の描画が走る(bind:clientWidth → ResizeObserver 経由)のを待つ。
	await vi.waitFor(() => {
		expect(drawCount()).toBeGreaterThanOrEqual(1);
	});
	expect(band()).not.toBeNull();
	expect(divider(), '帯の上端ハンドル .waveform-divider').not.toBeNull();
}

/** 「Zoom In Waveform」を 1 回押す(窓 15〜45 秒・ズーム ×2)。 */
async function zoomInOnce(): Promise<void> {
	await fireEvent.click(screen.getByRole('button', { name: 'Zoom In Waveform' }));
	await vi.waitFor(() => {
		expect(indicator()).not.toBeNull();
	});
}

/** ポインタイベントを 1 つ送る(JSDOM 29 は PointerEvent を持つ。無い環境では MouseEvent)。 */
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

const bandHeight = () => Number.parseFloat((band() as HTMLElement).style.height);

describe('AC-50-追f(振る舞い・AudioViewer): 拡大中の高さのドラッグで帯は描き直すが、窓の標本は集め直さない', () => {
	it('ズーム 2 でハンドルを 2 回ドラッグ: 高さが変わり描き直されるのに windowPeaks の回数は増えない', async () => {
		await mountAudio();
		expect(regatherCount(), '等倍では解析済みの lanes をそのまま使う(集め直し無し)').toBe(0);

		await zoomInOnce();
		// 拡大で 1 回集め直す(L/R で 2 件)。ここが 0 のままなら spy の配線が死んでいる。
		await vi.waitFor(() => {
			expect(regatherCount()).toBeGreaterThanOrEqual(2);
		});
		const gatheredAfterZoom = regatherCount();
		const drawnAfterZoom = drawCount();
		const heightBefore = bandHeight();
		expect(heightBefore).toBe(DEFAULT_AUDIO_WAVEFORM_HEIGHT);

		const handle = divider() as HTMLElement;
		await pointer(handle, 'pointerdown', 300);
		await pointer(handle, 'pointermove', 280); // 上へ 20px → 高さ +20
		await vi.waitFor(() => {
			expect(bandHeight(), '1 回目の動きで高さが変わる').toBe(heightBefore + 20);
			expect(drawCount(), '高さが変わったので帯は描き直す').toBeGreaterThan(drawnAfterZoom);
		});
		const drawnAfterFirstMove = drawCount();
		expect(
			regatherCount(),
			'高さのドラッグでは windowPeaks を呼び直さない(窓の標本は $derived が持ち、幅・高さに依存しない)',
		).toBe(gatheredAfterZoom);

		await pointer(handle, 'pointermove', 260); // さらに 20px → 高さ +40
		await vi.waitFor(() => {
			expect(bandHeight(), '2 回目の動きで高さが変わる').toBe(heightBefore + 40);
			expect(drawCount()).toBeGreaterThan(drawnAfterFirstMove);
		});
		expect(regatherCount(), '2 回目の動きでも集め直さない').toBe(gatheredAfterZoom);

		await pointer(handle, 'pointerup', 260);
		expect(regatherCount(), 'pointerup でも集め直さない').toBe(gatheredAfterZoom);
	});

	it('対照: もう 1 回拡大(ズーム 4)すると集め直しは走る(ズームには反応する)', async () => {
		await mountAudio();
		await zoomInOnce();
		await vi.waitFor(() => {
			expect(regatherCount()).toBeGreaterThanOrEqual(2);
		});
		const gatheredAtZoom2 = regatherCount();

		await fireEvent.click(screen.getByRole('button', { name: 'Zoom In Waveform' }));
		await vi.waitFor(() => {
			expect(regatherCount(), 'ズームが変われば窓の標本を集め直す').toBeGreaterThan(gatheredAtZoom2);
		});
	});

	it('不変(契約 3): ドラッグで高さは 240 → 280 に変わり、pointerup で保存される', async () => {
		await mountAudio();
		await zoomInOnce();
		const handle = divider() as HTMLElement;
		await pointer(handle, 'pointerdown', 300);
		await pointer(handle, 'pointermove', 260);
		await vi.waitFor(() => {
			expect(bandHeight()).toBe(DEFAULT_AUDIO_WAVEFORM_HEIGHT + 40);
		});
		await pointer(handle, 'pointerup', 260);
		let saved: string | null = null;
		try {
			saved = localStorage.getItem(AUDIO_WAVEFORM_HEIGHT_STORAGE_KEY);
		} catch {
			saved = null;
		}
		expect(saved, '確定した高さが保存される').toBe(String(DEFAULT_AUDIO_WAVEFORM_HEIGHT + 40));
	});
});
