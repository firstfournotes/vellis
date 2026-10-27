/**
 * 要件#41 追補g(backlog 236)の配線テスト — AudioViewer(AC-41-追g (a)・JSDOM)。
 * 正本: docs/requirements/req-41.md「追補g」(契約1〜8 と受け入れ基準 (a)。音声ビューアは
 * 契約7=事前実測(2026-10-09)で「同じずれあり」と判定され、動画と同じ形で当てる)。
 *
 * ## AC 対応表((a)1〜4 の音声分)
 * - (a)1 構造: 帯 `.audio-waveform`(`.audio-stage` の中)に `.waveform-axis` が1つ・inline style の
 *   `left` と `right` が m px(m = SEEK_THUMB_INSET_PX − 1・契約2)。`canvas.waveform-canvas` と
 *   `.waveform-head`(出ているとき)はその中、`.waveform-note` と `.waveform-lane-label` はその外(帯の中)
 * - (a)2 窓指標: 「Zoom In Waveform」を1回押した状態(窓 = 15〜45 秒)の `.seek-window-indicator`
 *   の left / width が `seekThumbWindowIndicator(15, 30, 60, 320)` と一致する(修正前は 80 / 160)
 * - (a)3 クリック: canvas の上(clientX = m + 80)→ 15 秒。左の余白(帯へ clientX = m/2)→ 0 秒・
 *   右の余白(clientX = m + 320 + m/2)→ 60 秒。拡大中(窓 15〜45 秒)の左の余白 → 15 秒・
 *   右の余白 → 45 秒(判断4)。**どれも `nearestFrame` を呼ばない**(吸着なし=要件#50 契約⑧)
 * - (a)4 Option+ホイールのアンカー: 帯の上で clientX = m + 160 の Option+ホイール(deltaY −240=
 *   2倍)のあと、窓指標が `seekThumbWindowIndicator(15, 30, 60, 320)` と一致する
 *
 * ## 確定契約(implementer はこれに従う=契約6・7)
 * - 帯 `.audio-waveform` の中に `.waveform-axis` を1つ(器のクラス名は動画と同じ)。左右は
 *   inline style の `left` / `right`(px)= `SEEK_THUMB_INSET_PX − 1`
 * - `canvas.waveform-canvas`(aria-label「Audio waveform (click to seek)」は canvas に残す)と
 *   `.waveform-head` を器の中へ。`bind:clientWidth={waveformWidth}` を帯から器へ
 * - クリックの受け口は帯全体。x と幅の基準は canvas の `getBoundingClientRect()`。
 *   余白の x は `windowXToTime(x, 横軸の幅, s, w)` の clamp で端へ寄せ、`currentTime` へ直行
 *   (`nearestFrame` は呼ばない)。Option+ホイールのアンカー x も canvas の rect の左端から
 * - `.waveform-note` / `.waveform-lane-label` は器の外(帯の直下)。帯の inline の `height` は帯のまま
 * - ステレオの L/R 2レーンは同じ器の canvas に描き、再生ヘッドは両レーンを貫く1本のまま
 *
 * ## スタブの設計(AudioViewer.wiring.test.ts 2周目の家風)
 * - ResizeObserver 即発火版・`clientWidth` = 320 の getter・`getContext` の null spy・
 *   play/pause の spy・rAF の手回し・`OfflineAudioContext` の偽物(ステレオ 2ch)・fetch 成功
 *   (mp3 の fetch 経路で ready にする。文言のケースだけ fetch を失敗させる)
 * - `<audio>` に `currentTime`(読み書き)・`paused`・`duration`(60)を被せ、
 *   `loadedmetadata` / `durationchange` を流す
 * - rect は実機に似せて被せる: 帯 `{ left: 0, width: 320 + 2m }`・canvas `{ left: m, width: 320 }`
 * - `$lib/video-frame` の `nearestFrame` を spy で包む(呼ばれないことの観測点)
 * - クリックの前に `currentTime` へ番兵(33.3)を置く ―― 受け口が無くて何も起きない場合を
 *   「期待値と偶然一致」で緑にしないため
 *
 * ## 判定しないもの
 * - 純関数の式と定数の値(`waveform-thumb-axis.acceptance.test.ts`)・実機のつまみとの一致
 *   (AC (d) の E2E)・見た目(余白に波形が描かれない・`cursor: pointer`)は reviewer 照合
 *
 * ## 修正前の見込み(赤の理由)
 * `.waveform-axis` が無い(構造)・窓指標が `waveformWindowIndicator` の 80 / 160(窓指標・
 * アンカー)・帯に click の受け口が無く余白のクリックで `currentTime` が番兵のまま(クリック)。
 * canvas 上のクリック → 15 秒だけは修正前から緑(不変の確認)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import AudioViewer from './AudioViewer.svelte';
import { nearestFrame } from '$lib/video-frame';
import {
	SEEK_THUMB_INSET_PX,
	seekThumbWindowIndicator,
	waveformWindowIndicator,
} from '$lib/waveform-zoom';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('$lib/video-frame', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/video-frame')>();
	return { ...actual, nearestFrame: vi.fn(actual.nearestFrame) };
});

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

/** ステレオ 2ch(ready の帯に L/R ラベルが出る構成)。 */
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

/** 波形は fetch 経路(mp3)で ready にする。 */
const PROPS = {
	uri: 'file:///Users/a/music/song.mp3',
	src: 'vellis-asset://local/Users/a/music/song.mp3',
};

/** 尺 60 秒。 */
const DURATION = 60;
/** 横軸(器・canvas・シークバーの器)の幅=clientWidth の stub。 */
const AXIS_WIDTH = 320;
/** 帯の左右の余白(px)=器の left / right(契約2)。 */
const m = SEEK_THUMB_INSET_PX - 1;
/** クリックの前に置く番兵(どの期待値とも一致しない値)。 */
const SENTINEL = 33.3;

function rectOf(left: number, width: number): DOMRect {
	return {
		left,
		top: 0,
		right: left + width,
		bottom: 240,
		width,
		height: 240,
		x: left,
		y: 0,
		toJSON: () => ({}),
	} as DOMRect;
}

const band = () => document.querySelector('.audio-stage .audio-waveform') as HTMLElement | null;
const canvasEl = () =>
	document.querySelector('.audio-stage canvas.waveform-canvas') as HTMLCanvasElement | null;
const axisEl = () => band()?.querySelector('.waveform-axis') as HTMLElement | null;
const noteEl = () => document.querySelector('.waveform-note') as HTMLElement | null;
const laneLabels = () => Array.from(document.querySelectorAll('.waveform-lane-label')) as HTMLElement[];
const indicator = () => document.querySelector('.seek-window-indicator') as HTMLElement | null;

let getContextSpy: ReturnType<typeof vi.fn>;

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
		localStorage.removeItem('vellis.audio-waveform-height');
	} catch {
		// storage 不可の環境では既定高のまま(本ファイルの判定に高さは関わらない)
	}
	vi.mocked(nearestFrame).mockClear();
});

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/**
 * マウントして尺 60 秒の「ズーム・シーク可能な状態」を作り、解析を ready
 * (ステレオ=L/R ラベル・再生ヘッドあり・文言なし)まで進める。`ready: false` は
 * fetch を失敗させて縮退文言を出す。
 */
async function mountAudio(options: { ready?: boolean } = {}) {
	const { ready = true } = options;
	if (!ready) {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('Failed to fetch');
			}),
		);
	}

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
	Object.defineProperty(audio, 'duration', { configurable: true, get: () => DURATION });
	await fireEvent(audio, new Event('loadedmetadata'));
	await fireEvent(audio, new Event('durationchange'));

	if (ready) {
		await vi.waitFor(() => {
			expect(noteEl(), '解析が終わると文言が消えること').toBeNull();
			expect(laneLabels().map((el) => el.textContent)).toEqual(['L', 'R']);
		});
	} else {
		await vi.waitFor(() => {
			expect((noteEl()?.textContent ?? '').length).toBeGreaterThan(0);
		});
	}

	// 横軸の幅が確定する(bind:clientWidth → ResizeObserver 経由)のを待つ。
	await vi.waitFor(() => {
		expect(getContextSpy).toHaveBeenCalledWith('2d');
	});

	// 実機に似せた rect: 帯は余白込み・canvas は横軸ぶん。
	const theBand = band() as HTMLElement;
	const canvas = canvasEl() as HTMLCanvasElement;
	expect(theBand).not.toBeNull();
	expect(canvas).not.toBeNull();
	theBand.getBoundingClientRect = () => rectOf(0, AXIS_WIDTH + 2 * m);
	canvas.getBoundingClientRect = () => rectOf(m, AXIS_WIDTH);

	const media = {
		get time() {
			return time;
		},
		set time(value: number) {
			time = value;
		},
	};
	return { ...utils, audio, band: theBand, canvas, media };
}

/** 「Zoom In Waveform」を1回押して窓 15〜45 秒にする(アンカー=横軸の中央 160px)。 */
async function zoomInOnce(): Promise<void> {
	await fireEvent.click(screen.getByRole('button', { name: 'Zoom In Waveform' }));
	await vi.waitFor(() => {
		expect(indicator()).not.toBeNull();
	});
}

function indicatorBox(): { left: number; width: number } {
	const el = indicator() as HTMLElement;
	return { left: Number.parseFloat(el.style.left), width: Number.parseFloat(el.style.width) };
}

/** 窓 15〜45 秒・横軸 320px の期待される窓指標(契約4)。 */
function expectedIndicator(): { left: number; width: number } {
	const expected = seekThumbWindowIndicator(15, 30, DURATION, AXIS_WIDTH);
	expect(expected, 'seekThumbWindowIndicator(15, 30, 60, 320) は null でないこと').not.toBeNull();
	return expected as { left: number; width: number };
}

describe('AC-41-追g (a)1 AudioViewer: 帯の中の横軸の器 .waveform-axis(契約6・7)', () => {
	it('帯の中に .waveform-axis が1つ・inline の left/right が m px・canvas と再生ヘッドはその中・L/R ラベルはその外', async () => {
		await mountAudio();
		const theBand = band() as HTMLElement;

		const axes = theBand.querySelectorAll('.waveform-axis');
		expect(axes, '帯の中に横軸の器が1つ').toHaveLength(1);
		const axis = axes[0] as HTMLElement;
		expect(axis.style.left).toBe(`${m}px`);
		expect(axis.style.right).toBe(`${m}px`);

		const canvas = canvasEl();
		expect(canvas).not.toBeNull();
		expect(axis.contains(canvas), 'canvas は器の中').toBe(true);
		expect(canvas?.getAttribute('aria-label')).toBe('Audio waveform (click to seek)');

		const heads = theBand.querySelectorAll('.waveform-head');
		expect(heads, 'ready・位置 0 で再生ヘッドが1本出ている(両レーンを貫く1本のまま)').toHaveLength(1);
		expect(axis.contains(heads[0]), '再生ヘッドは器の中').toBe(true);

		const labels = laneLabels();
		expect(labels).toHaveLength(2);
		for (const label of labels) {
			expect(theBand.contains(label), 'L/R ラベルは帯の中').toBe(true);
			expect(axis.contains(label), 'L/R ラベルは器の外').toBe(false);
		}
		// 帯の高さは帯の inline style のまま(契約6=帯全体のまま残すもの)。
		expect(theBand.style.height).toMatch(/^\d+(\.\d+)?px$/);
	});

	it('縮退文言 .waveform-note は器の外(帯の中)・器は文言の有無によらず在る', async () => {
		await mountAudio({ ready: false });
		const theBand = band() as HTMLElement;

		const axis = axisEl();
		expect(axis).not.toBeNull();
		expect(axis!.contains(canvasEl())).toBe(true);
		const note = noteEl() as HTMLElement;
		expect(note).not.toBeNull();
		expect(theBand.contains(note), '文言は帯の中').toBe(true);
		expect(axis!.contains(note), '文言は器の外').toBe(false);
	});
});

describe('AC-41-追g (a)2 AudioViewer: 窓指標がつまみの可動域に乗る(契約4)', () => {
	it('「Zoom In Waveform」1回(窓 15〜45 秒)の指標が seekThumbWindowIndicator(15, 30, 60, 320) と一致する', async () => {
		await mountAudio();
		await zoomInOnce();

		const expected = expectedIndicator();
		const actual = indicatorBox();
		expect(actual.left).toBeCloseTo(expected.left, 6);
		expect(actual.width).toBeCloseTo(expected.width, 6);

		// 修正前の値(waveformWindowIndicator の 80 / 160)ではないこと。
		const legacy = waveformWindowIndicator(15, 30, DURATION, AXIS_WIDTH)!;
		expect(actual.left).not.toBeCloseTo(legacy.left, 6);
		expect(actual.width).not.toBeCloseTo(legacy.width, 6);
	});
});

describe('AC-41-追g (a)3 AudioViewer: canvas と余白のクリック(契約5・6=吸着なし)', () => {
	it('等倍: canvas の上 → 15 秒・左の余白 → 0 秒・右の余白 → 60 秒。nearestFrame は呼ばれない', async () => {
		const { band: theBand, canvas, media } = await mountAudio();

		media.time = SENTINEL;
		await fireEvent.click(canvas, { clientX: m + 80 });
		expect(media.time).toBeCloseTo(15, 6);

		media.time = SENTINEL;
		await fireEvent.click(theBand, { clientX: m / 2 });
		expect(media.time, '左の余白 → 先頭').toBe(0);

		media.time = SENTINEL;
		await fireEvent.click(theBand, { clientX: m + AXIS_WIDTH + m / 2 });
		expect(media.time, '右の余白 → 末尾').toBe(DURATION);

		// 音声にフレーム索引は無い ―― 端へのシークも要件#37 の吸着経路を通さない(要件#50 契約⑧)。
		expect(vi.mocked(nearestFrame)).not.toHaveBeenCalled();
	});

	it('拡大中(窓 15〜45 秒): 左の余白 → 15 秒・右の余白 → 45 秒(判断4=窓の端)。nearestFrame は呼ばれない', async () => {
		const { band: theBand, media } = await mountAudio();
		await zoomInOnce();

		media.time = SENTINEL;
		await fireEvent.click(theBand, { clientX: m / 2 });
		expect(media.time, '左の余白 → 窓の先頭').toBeCloseTo(15, 6);

		media.time = SENTINEL;
		await fireEvent.click(theBand, { clientX: m + AXIS_WIDTH + m / 2 });
		expect(media.time, '右の余白 → 窓の末尾').toBeCloseTo(45, 6);

		expect(vi.mocked(nearestFrame)).not.toHaveBeenCalled();
	});
});

describe('AC-41-追g (a)4 AudioViewer: Option+ホイールのアンカーは横軸の左端から測る(契約3)', () => {
	it('帯の上で clientX = m + 160 の Option+ホイール(−240=2倍)のあと、窓指標が seekThumbWindowIndicator(15, 30, 60, 320) と一致する', async () => {
		const { band: theBand } = await mountAudio();

		await fireEvent.wheel(theBand, { altKey: true, deltaY: -240, deltaMode: 0, clientX: m + AXIS_WIDTH / 2 });
		await vi.waitFor(() => {
			expect(indicator()).not.toBeNull();
		});

		// アンカーが横軸の中央(時刻 30 秒)なら窓は 15〜45 秒。帯の左端から測ると m px ぶん
		// 右(時刻 32.06 秒)がアンカーになり、窓の開始が 15 秒にならない。
		const expected = expectedIndicator();
		const actual = indicatorBox();
		expect(actual.left).toBeCloseTo(expected.left, 6);
		expect(actual.width).toBeCloseTo(expected.width, 6);
	});
});
