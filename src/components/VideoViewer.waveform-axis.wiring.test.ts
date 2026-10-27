/**
 * 要件#41 追補g(backlog 236)の配線テスト — VideoViewer(AC-41-追g (a)・JSDOM)。
 * 正本: docs/requirements/req-41.md「追補g」(契約1〜6・8 と受け入れ基準 (a))。
 *
 * シークバーのネイティブ `<input type="range">` はつまみの中心が両端から `inset`
 * (= `SEEK_THUMB_INSET_PX`)ずつ内側の範囲を動く。波形の帯の横軸をその可動域に合わせる
 * =帯の中に横軸の器 `.waveform-axis` を置き、canvas・再生ヘッド・クリック・ホイールの
 * アンカーをすべてその器の幅と左端に乗せる(契約3・6)。
 *
 * ## AC 対応表((a)1〜4 の動画分)
 * - (a)1 構造: 帯 `.video-waveform` の中に `.waveform-axis` が1つ・inline style の `left` と
 *   `right` が m px(m = SEEK_THUMB_INSET_PX − 1=帯の枠線 1px を差し引いた値・契約2)。
 *   `canvas.waveform-canvas` と `.waveform-head`(出ているとき)はその中、`.waveform-note` と
 *   `.waveform-lane-label` はその外(帯の中)
 * - (a)2 窓指標: 「Zoom In Waveform」を1回押した状態(窓 = 15〜45 秒)の
 *   `.seek-window-indicator` の left / width が `seekThumbWindowIndicator(15, 30, 60, 320)` と
 *   一致する(修正前は `waveformWindowIndicator` の 80 / 160)
 * - (a)3 クリック: canvas の上(clientX = m + 80)→ 15 秒。左の余白(帯へ clientX = m/2)→
 *   0 秒・右の余白(clientX = m + 320 + m/2)→ 60 秒。索引なし(既定のモック)で上のとおり、
 *   索引あり(`get_video_frame_index` が索引を返す)で `seekTimeForFrame(index, nearestFrame(index, t))`
 *   (t = 15 / 0 / 60)。拡大中(窓 15〜45 秒)の左の余白 → 15 秒・右の余白 → 45 秒
 *   (索引ありは同じ吸着経路)
 * - (a)4 Option+ホイールのアンカー: 帯の上で clientX = m + 160(横軸の中央)の Option+ホイール
 *   (deltaY −240=2倍)のあと、窓指標が `seekThumbWindowIndicator(15, 30, 60, 320)` と一致する
 *   (アンカーを帯の左端から測ると m ぶん右へずれ、窓の開始が 15 秒にならない)
 *
 * ## 確定契約(implementer はこれに従う=契約6)
 * - 帯の中に `.waveform-axis` を1つ。上下いっぱいに絶対配置・左右は inline style の
 *   `left` / `right`(px)= `SEEK_THUMB_INSET_PX − 1`(数値の直書きはしない)
 * - `canvas.waveform-canvas` と `.waveform-head` を器の中へ。`bind:clientWidth={waveformWidth}`
 *   を帯から器へ付け替える(既存の純関数は無改変で「帯の幅」が横軸の幅になる)
 * - クリックの受け口は帯全体(余白を含む)。x と幅の基準は **canvas の `getBoundingClientRect()`**
 *   (受け口が帯でも canvas の rect を読む)。Option+ホイールのアンカー x も canvas の rect の
 *   左端から測る。ホイールの受け口(`onwheel`)は帯のまま
 * - 余白のクリックは canvas と同じ `waveformZoomSeekTime(x, 横軸の幅, s, w, index)` を通す
 *   (端へのシークも要件#37 の吸着経路。索引なしは 0 / 尺)。`requestedFrame` と
 *   `initialSeekPending` の扱いも canvas のクリックと同じ
 * - `.waveform-note` / `.waveform-lane-label` は器の外(帯の直下)。帯の inline の `height` は帯のまま
 *
 * ## スタブの設計(VideoViewer.wiring.test.ts / waveform-keep / ui-language の家風)
 * - ResizeObserver 即発火版・`clientWidth` = 320 の getter(帯・器・シークバーの器・canvas の
 *   すべてに効く=横軸の幅も `seekWidth` も 320)・`getContext` の null spy・fetch 失敗
 * - rect は実機に似せて被せる: 帯 `{ left: 0, width: 320 + 2m }`・canvas `{ left: m, width: 320 }`
 *   (jsdom の `getBoundingClientRect` は常に 0)。器や帯の rect を基準にすると値がずれる
 * - `<video>` は jsdom が実装を持たないので、要素に `duration`(60)・`currentTime`(読み書き)・
 *   `readyState` を被せ、`durationchange` / `loadedmetadata` を流す
 * - 索引あり: `get_video_frame_index` のモックが 30fps × 1800 フレーム(尺 60 秒)の索引を返す
 *   (ui-language.wiring.test.ts の作法)。到着はコマ送りボタン「−1」の出現で待つ
 * - 波形 ready: `extract_waveform_audio` が小さな ArrayBuffer を返し、`OfflineAudioContext`
 *   の偽物がステレオ 2ch を返す(waveform-keep の作法)。再生ヘッドと L/R ラベルを出すため
 * - クリックの前に `currentTime` へ番兵(33.3)を置く ―― 受け口が無くて何も起きない場合を
 *   「期待値と偶然一致」で緑にしないため(索引ありの初期シークは左の余白の期待値と同じ値)
 *
 * ## 判定しないもの
 * - 純関数の式と定数の値(`waveform-thumb-axis.acceptance.test.ts`)・実機のつまみとの一致
 *   (AC (d) の E2E)・見た目(余白に波形が描かれないこと・`cursor: pointer`)は reviewer 照合
 *
 * ## 修正前の見込み(赤の理由)
 * `.waveform-axis` が無い(構造)・窓指標が `waveformWindowIndicator` の 80 / 160(窓指標・
 * アンカー)・帯に click の受け口が無く余白のクリックで `currentTime` が番兵のまま(クリック)。
 * canvas 上のクリック → 15 秒だけは修正前から緑(不変の確認)。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import VideoViewer from './VideoViewer.svelte';
import { invoke } from '$lib/ipc';
import {
	SEEK_THUMB_INSET_PX,
	seekThumbWindowIndicator,
	waveformWindowIndicator,
} from '$lib/waveform-zoom';
import { frameIndexFromPayload, nearestFrame, seekTimeForFrame } from '$lib/video-frame';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openPath: vi.fn(async () => undefined),
}));

const invokeMock = invoke as unknown as Mock<(cmd: string, args?: unknown) => Promise<unknown>>;

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

/** インライン再生対象(mp4 ローカル)。 */
const PROPS = {
	uri: 'file:///Users/a/movies/clip.mp4',
	src: 'vellis-asset://local/Users/a/movies/clip.mp4',
};

/** 尺 60 秒。 */
const DURATION = 60;
/** 横軸(器・canvas・シークバーの器)の幅=clientWidth の stub。 */
const AXIS_WIDTH = 320;
/** 帯の左右の余白(px)=器の left / right(契約2)。 */
const m = SEEK_THUMB_INSET_PX - 1;

/** 30fps × 1800 フレーム=尺 60 秒の CFR 索引(`get_video_frame_index` の応答)。 */
const FRAME_INDEX_PAYLOAD = {
	timescale: 30,
	sampleTimes: Array.from({ length: 1800 }, (_, i) => i),
	duration: 1800,
	fpsNum: 30,
	fpsDen: 1,
	isCfr: true,
};
const INDEX = frameIndexFromPayload(FRAME_INDEX_PAYLOAD)!;

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

const band = () => document.querySelector('.video-waveform') as HTMLElement | null;
const canvasEl = () => band()?.querySelector('canvas.waveform-canvas') as HTMLCanvasElement | null;
const axisEl = () => band()?.querySelector('.waveform-axis') as HTMLElement | null;
const noteEl = () => document.querySelector('.waveform-note') as HTMLElement | null;
const laneLabels = () => Array.from(document.querySelectorAll('.waveform-lane-label')) as HTMLElement[];
const indicator = () => document.querySelector('.seek-window-indicator') as HTMLElement | null;

beforeEach(() => {
	invokeMock.mockReset();
	invokeMock.mockImplementation(async () => null);
	vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		}),
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
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get: () => AXIS_WIDTH,
	});
});

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/**
 * マウントして尺 60 秒の「ズーム・シーク可能な状態」を作る。
 * - `indexed`: `get_video_frame_index` が索引を返す(到着をコマ送りボタンで待つ)
 * - `ready`: 解析を ready(ステレオ=L/R ラベル・再生ヘッドあり・文言なし)まで進める
 */
async function mountVideo(options: { indexed?: boolean; ready?: boolean } = {}) {
	const { indexed = false, ready = false } = options;
	invokeMock.mockImplementation(async (command: string) => {
		if (command === 'get_video_frame_index') return indexed ? FRAME_INDEX_PAYLOAD : null;
		if (command === 'extract_waveform_audio') return ready ? new ArrayBuffer(8) : null;
		return null;
	});

	const utils = render(VideoViewer, { props: PROPS });
	const video = document.querySelector('video.video') as HTMLVideoElement;
	expect(video).not.toBeNull();

	let time = 0;
	Object.defineProperty(video, 'currentTime', {
		configurable: true,
		get: () => time,
		set: (value: number) => {
			time = value;
		},
	});
	Object.defineProperty(video, 'duration', { configurable: true, get: () => DURATION });
	await fireEvent(video, new Event('durationchange'));

	if (ready) {
		Object.defineProperty(video, 'readyState', { configurable: true, get: () => 1 });
		await fireEvent(video, new Event('loadedmetadata'));
		await vi.waitFor(() => {
			expect(noteEl(), '解析が終わると文言が消えること').toBeNull();
			expect(laneLabels().map((el) => el.textContent)).toEqual(['L', 'R']);
		});
	}
	if (indexed) {
		await screen.findByRole('button', { name: '−1' });
		const slider = screen.getByRole('slider', { name: 'Playback Position' }) as HTMLInputElement;
		expect(slider.max).toBe(String(DURATION));
	}

	// 横軸の幅が確定する(bind:clientWidth → ResizeObserver 経由)のを待つ。
	await vi.waitFor(() => {
		expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith('2d');
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
	return { ...utils, video, band: theBand, canvas, media };
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

describe('AC-41-追g (a)1 VideoViewer: 帯の中の横軸の器 .waveform-axis(契約6)', () => {
	it('帯の中に .waveform-axis が1つ・inline の left/right が m px・canvas と再生ヘッドはその中・L/R ラベルはその外', async () => {
		await mountVideo({ ready: true });
		const theBand = band() as HTMLElement;

		const axes = theBand.querySelectorAll('.waveform-axis');
		expect(axes, '帯の中に横軸の器が1つ').toHaveLength(1);
		const axis = axes[0] as HTMLElement;
		expect(axis.style.left).toBe(`${m}px`);
		expect(axis.style.right).toBe(`${m}px`);

		const canvas = canvasEl();
		expect(canvas).not.toBeNull();
		expect(axis.contains(canvas), 'canvas は器の中').toBe(true);

		const head = theBand.querySelector('.waveform-head');
		expect(head, 'ready・位置 0 で再生ヘッドが出ている').not.toBeNull();
		expect(axis.contains(head), '再生ヘッドは器の中').toBe(true);

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
		await mountVideo();
		const theBand = band() as HTMLElement;

		await vi.waitFor(() => {
			expect((noteEl()?.textContent ?? '').length).toBeGreaterThan(0);
		});
		const axis = axisEl();
		expect(axis).not.toBeNull();
		expect(axis!.contains(canvasEl())).toBe(true);
		const note = noteEl() as HTMLElement;
		expect(theBand.contains(note), '文言は帯の中').toBe(true);
		expect(axis!.contains(note), '文言は器の外').toBe(false);
	});
});

describe('AC-41-追g (a)2 VideoViewer: 窓指標がつまみの可動域に乗る(契約4)', () => {
	it('「Zoom In Waveform」1回(窓 15〜45 秒)の指標が seekThumbWindowIndicator(15, 30, 60, 320) と一致する', async () => {
		await mountVideo();
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

describe('AC-41-追g (a)3 VideoViewer: canvas と余白のクリック(契約5・6)', () => {
	it('索引なし・等倍: canvas の上 → 15 秒・左の余白 → 0 秒・右の余白 → 60 秒', async () => {
		const { band: theBand, canvas, media } = await mountVideo();

		media.time = SENTINEL;
		await fireEvent.click(canvas, { clientX: m + 80 });
		expect(media.time).toBeCloseTo(15, 6);

		media.time = SENTINEL;
		await fireEvent.click(theBand, { clientX: m / 2 });
		expect(media.time, '左の余白 → 先頭').toBe(0);

		media.time = SENTINEL;
		await fireEvent.click(theBand, { clientX: m + AXIS_WIDTH + m / 2 });
		expect(media.time, '右の余白 → 末尾').toBe(DURATION);
	});

	it('索引あり・等倍: canvas の上 / 左の余白 / 右の余白 → seekTimeForFrame(index, nearestFrame(index, 15 / 0 / 60))', async () => {
		const { band: theBand, canvas, media } = await mountVideo({ indexed: true });

		media.time = SENTINEL;
		await fireEvent.click(canvas, { clientX: m + 80 });
		expect(media.time).toBe(seekTimeForFrame(INDEX, nearestFrame(INDEX, 15)));

		media.time = SENTINEL;
		await fireEvent.click(theBand, { clientX: m / 2 });
		const first = seekTimeForFrame(INDEX, nearestFrame(INDEX, 0));
		expect(media.time, '左の余白 → 先頭フレームの中').toBe(first);
		expect(first).toBeGreaterThan(0);

		media.time = SENTINEL;
		await fireEvent.click(theBand, { clientX: m + AXIS_WIDTH + m / 2 });
		const last = seekTimeForFrame(INDEX, nearestFrame(INDEX, DURATION));
		expect(media.time, '右の余白 → 最終フレームの中(尺ちょうどには行かない)').toBe(last);
		expect(last).toBeLessThan(DURATION);
	});

	it('索引なし・拡大中(窓 15〜45 秒): 左の余白 → 15 秒・右の余白 → 45 秒(判断4=窓の端)', async () => {
		const { band: theBand, media } = await mountVideo();
		await zoomInOnce();

		media.time = SENTINEL;
		await fireEvent.click(theBand, { clientX: m / 2 });
		expect(media.time, '左の余白 → 窓の先頭').toBeCloseTo(15, 6);

		media.time = SENTINEL;
		await fireEvent.click(theBand, { clientX: m + AXIS_WIDTH + m / 2 });
		expect(media.time, '右の余白 → 窓の末尾').toBeCloseTo(45, 6);
	});

	it('索引あり・拡大中(窓 15〜45 秒): 左/右の余白 → seekTimeForFrame(index, nearestFrame(index, 15 / 45))', async () => {
		const { band: theBand, media } = await mountVideo({ indexed: true });
		await zoomInOnce();

		media.time = SENTINEL;
		await fireEvent.click(theBand, { clientX: m / 2 });
		expect(media.time).toBe(seekTimeForFrame(INDEX, nearestFrame(INDEX, 15)));

		media.time = SENTINEL;
		await fireEvent.click(theBand, { clientX: m + AXIS_WIDTH + m / 2 });
		expect(media.time).toBe(seekTimeForFrame(INDEX, nearestFrame(INDEX, 45)));
	});
});

describe('AC-41-追g (a)4 VideoViewer: Option+ホイールのアンカーは横軸の左端から測る(契約3)', () => {
	it('帯の上で clientX = m + 160 の Option+ホイール(−240=2倍)のあと、窓指標が seekThumbWindowIndicator(15, 30, 60, 320) と一致する', async () => {
		const { band: theBand } = await mountVideo();

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
