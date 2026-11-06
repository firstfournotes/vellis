/**
 * 要件#37 追補i(Issue #788)=動画を一時停止したまま窓が見えなくなると、戻っても
 * シークが終わらない。受け入れ基準 AC-37-追i (a)〜(e) の配線テスト(JSDOM・component
 * プロジェクト・偽のタイマー)。(f)=既存テストの無改変は、このファイルを足すだけで満たす。
 *
 * ## 判定するもの(AC-37-追i)
 * (a) hidden を経験した `<video>` で、visible の間に `seeking` が 1.5 秒続く →
 *     `<video>` が別の DOM ノードに替わる(同じ `src`)・新しい要素の `loadedmetadata` で
 *     `currentTime` が止まったシークの行き先になる(先頭の初期シークではない)・
 *     一時停止のまま(`play()` を呼ばない)・`muted` が保たれる・索引の取得
 *     (`get_video_frame_index`)と波形の解析(`extract_waveform_audio`・`decodeAudioData`)を
 *     やり直さない・波形のズームと窓(窓指標)が保たれる・シークバーの尺(max=10 秒)が
 *     保たれる・表示(#n・時間・つまみ)は行き先を示す
 * (b) 1.5 秒より前(1.0 秒)に `seeking` が終われば作り直さない。その後の普通のシークも
 *     作り直さない
 * (c) hidden を経験していない要素は、`seeking` が 5 秒続いても作り直さない
 * (d) hidden の間は数えない: シーク直後に hidden → 5 秒経過しても作り直さず、visible に
 *     戻ってから 1.4 秒では作り直さず、1.6 秒で作り直す
 * (e) 作り直した要素でも止まったら(hidden を経験したうえで 3 秒続いても)、それ以上
 *     作り直さない。その後の利用者の新しいシーク(別の行き先)は 1 から数え、1.5 秒で
 *     作り直す
 * (e) 重ね(実装で決めた点 (e)・由谷の事後確認待ち): 止まったシークの最中(1.0 秒)に
 *     別の位置へシークを重ねたら、1.5 秒は最後の要求から数え直す ―― 最初の要求から 2.4 秒
 *     (最後から 1.4 秒)では作り直さず、最後から 1.6 秒で作り直す。行き先は最後の要求の位置
 *
 * ## 表示の判定の取り方(契約3「表示は行き先を示す」)
 * 新しい要素の `seeked` が来た後は、表示側の既存の読み直し(`seeked` → 位置を読む)だけで
 * 行き先が出てしまい、作り直しが表示を合わせたかどうかを見分けられない。そこで表示
 * (#n・時間表示・つまみ)は、**作り直しの直後(新しい要素の `loadedmetadata` の前)**と、
 * **作り直した要素の戻しのシークが止まっている間**((e) の契約4 の場面)にも判定する。
 * 止まった要素は `seeked` を出していないので、そこで行き先が出るのは作り直しの処理が表示を
 * 行き先へ合わせた証拠になる(`expectReadoutShows`)。
 *
 * ## 境目の取り方
 * 「1.5 秒以上」の境目は、1.4 秒(作り直さない)と 1.6 秒(作り直す)で挟む。1.5 秒
 * ちょうどは「以上」と「超えたら」で割れうるので判定に使わない。
 *
 * ## 作り直しの観測
 * 「作り直した」は `<video>` の DOM ノードが別物に替わったこと(`document.querySelector`
 * の結果が `!==`・古い要素が `isConnected=false`)で見る。実装の内部(鍵の持ち方・
 * 関数名)には依存しない。
 *
 * ## スタブ(既存の VideoViewer.*.wiring.test.ts の家風)
 * - `$lib/ipc` の `invoke`: `get_video_frame_index` → 30fps CFR・300 フレーム(10 秒)の
 *   索引、`extract_waveform_audio` → 小さな ArrayBuffer(= ok)、他は null
 * - `OfflineAudioContext.decodeAudioData` → ステレオ 2ch(ready の帯に L/R ラベルが出る)
 * - ResizeObserver 即発火版・clientWidth=320・getContext null・fetch 失敗
 * - `<video>` の偽物(`instrumentMedia`): `currentTime`(setter が代入値を控え、`seeking`
 *   を true にして `seeking` イベントを出す。止まらないモードでは microtask で `seeked` を
 *   出して `seeking` を false に戻す。止まるモードでは `seeked` を出さず `seeking` のまま)・
 *   `paused`・`play`/`pause`・`readyState`(HAVE_METADATA)・`duration`(10 秒)
 * - `HTMLMediaElement.prototype.play` を spy: 作り直された要素に、こちらが偽物を被せる前に
 *   `play()` が呼ばれても捕まえる(契約3=`play()` を呼ばない)
 * - `document.visibilityState` / `document.hidden` を instance 側で上書きし、
 *   `visibilitychange`(bubbles)を document へ流す
 * - 偽のタイマー(`vi.useFakeTimers`): setTimeout/setInterval/Date/performance/rAF。
 *   既存テストの `flushTasks`(実 setTimeout)は使えないので、`flush()`=
 *   `tick()`+`advanceTimersByTimeAsync(0)` で microtask と期限の来たタイマーを流す。
 *   `vi.waitFor` は偽のタイマーの下では自動で時間を進めるので、段取り(索引・波形の到着
 *   待ち)にだけ使い、1.5 秒の計測が始まった後は使わない
 *
 * ## 行き先
 * 索引のある動画でシークバーを 3 秒へ動かして離す(input → change)と、`onScrubCommit` が
 * 最寄りフレーム 90 の真ん中 `seekTimeForFrame(index, 90)`(=3 + 1/60 秒)へシークする。
 * これが「止まった要素の `currentTime`(最後に要求した位置)」=新しい要素の行き先。
 * 表示は #90・00:00:03.000・つまみ 3.0167。
 *
 * ## 想定される赤(実装前)
 * 現状の `VideoViewer` は `seeking` も `visibilitychange` も見ておらず、`<video>` は
 * `{#key src}` でしか作り直されない。(a)(d)(e) は「別の要素に替わる」の判定で赤。
 * (b)(c) は不変の確認で、実装前から緑(契約5)。(e) の前半(作り直した要素は
 * それ以上作り直さない)は、作り直しそのものが無い実装前では前段で赤になる。
 * 表示の判定(`expectReadoutShows`)は、作り直しのときに表示を行き先へ合わせる処理を
 * 外すと赤になる(止まった要素の位置=#0 のまま)。(e) 重ねは、重ねた `seeking` で数え
 * 直さない実装(最初の要求から 1.5 秒で作り直す)では「2.4 秒では作り直さない」で赤になる。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import VideoViewer from './VideoViewer.svelte';
import { invoke } from '$lib/ipc';
import {
	frameIndexFromPayload,
	initialSeekTime,
	seekTimeForFrame,
	type FrameIndex,
	type VideoFrameIndexPayload,
} from '$lib/video-frame';

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

/** `OfflineAudioContext.decodeAudioData` が返す構造的 AudioBuffer。 */
type FakeAudioBuffer = {
	numberOfChannels: number;
	length: number;
	sampleRate: number;
	getChannelData(channel: number): Float32Array;
};

/** ステレオ 2ch。ready の帯に L/R ラベルが出る構成。 */
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

/** インライン再生対象(mp4 ローカル)。videoViewMode → 'inline'。 */
const MP4_PROPS = {
	uri: 'file:///Users/a/movies/clip.mp4',
	src: 'vellis-asset://local/Users/a/movies/clip.mp4',
};

/** フレーム索引(30fps CFR・300 フレーム=10 秒)。 */
const FRAME_INDEX_PAYLOAD: VideoFrameIndexPayload = {
	timescale: 30,
	sampleTimes: Array.from({ length: 300 }, (_, i) => i),
	duration: 300,
	fpsNum: 30,
	fpsDen: 1,
	isCfr: true,
};

/** `<video>` に被せる尺(秒)。索引の尺(10 秒)と同じ。 */
const MEDIA_DURATION_SECONDS = 10;

/** 止まりの判定の閾値(契約1)と、その両側の計測点(ms)。 */
const STALL_THRESHOLD_MS = 1500;
const JUST_BEFORE_THRESHOLD_MS = 1400;
const PAST_THRESHOLD_MS = 1600;

/** 利用者が最初にシークする位置(秒)とそのフレーム・2 回目(別の行き先)。 */
const FIRST_SEEK_SECONDS = 3;
const FIRST_SEEK_FRAME = 90;
const SECOND_SEEK_SECONDS = 5;
const SECOND_SEEK_FRAME = 150;
/** 行き先の時間表示(HH:MM:SS.mmm)。 */
const FIRST_SEEK_TIME_TEXT = '00:00:03.000';
const SECOND_SEEK_TIME_TEXT = '00:00:05.000';
/** (e) 重ね: 止まったシークの最中に、新しいシークを重ねるまでの時間(ms)。 */
const OVERLAP_AFTER_MS = 1000;

const videoElement = () => document.querySelector('video.video') as HTMLVideoElement | null;
const seekSlider = () => document.querySelector('input.video-seek') as HTMLInputElement;
const timeText = () => document.querySelector('.video-time')?.textContent ?? null;
/** `#n`。索引が無い間は要素そのものが出ない(索引が居ることの陽性の観測)。 */
const frameText = () => document.querySelector('.video-frame')?.textContent ?? null;
const noteEl = () => document.querySelector('.waveform-note') as HTMLElement | null;
const laneLabelTexts = () =>
	Array.from(document.querySelectorAll('.waveform-lane-label')).map((el) => el.textContent);
/** 窓指標。倍率 1 では出ない=居ることが「拡大中(ズームと窓が残っている)」の合図。 */
const indicator = () => document.querySelector('.seek-window-indicator') as HTMLElement | null;

const indexCalls = () =>
	invokeMock.mock.calls.filter(([command]) => command === 'get_video_frame_index');
const extractCalls = () =>
	invokeMock.mock.calls.filter(([command]) => command === 'extract_waveform_audio');

/** Svelte の flush と microtask、期限の来た偽タイマーを流す(時間は進めない)。 */
async function flush(): Promise<void> {
	await tick();
	await vi.advanceTimersByTimeAsync(0);
	await tick();
}

/** 偽の時計を `ms` 進め、その間に期限の来たタイマーと microtask を流す。 */
async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await tick();
}

/** ページの可視状態。instance 側の getter で jsdom の既定('visible')を覆う。 */
let visibilityState: DocumentVisibilityState = 'visible';

async function setPageVisibility(state: DocumentVisibilityState): Promise<void> {
	visibilityState = state;
	document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
	await flush();
}

/** hidden → visible を 1 往復させる(要素に hidden を経験させる)。時間は進めない。 */
async function experienceHidden(): Promise<void> {
	await setPageVisibility('hidden');
	await setPageVisibility('visible');
}

type MediaStub = {
	el: HTMLVideoElement;
	/** アプリ側から `currentTime` に代入された値(代入順)。 */
	assigned: number[];
	/** true の間は、シークが終わらない(`seeked` を出さず `seeking` のまま)。 */
	stall: boolean;
	play: Mock<() => Promise<void>>;
	pause: Mock<() => void>;
	isPaused: () => boolean;
	isSeeking: () => boolean;
	/** 止まっていたシークを終わらせる(`seeking` を false に戻して `seeked` を出す)。 */
	finishSeek: () => void;
};

/**
 * jsdom の `<video>` に再生状態とシークの観測口を被せる。
 * jsdom の HTMLMediaElement は `currentTime`・`seeking`・`paused` を instance の素の値で
 * 持ち、`play`/`pause` は未実装なので、すべて own property で覆う。
 */
function instrumentMedia(el: HTMLVideoElement, options: { stall: boolean }): MediaStub {
	let currentTime = 0;
	let seeking = false;
	let paused = true;
	const assigned: number[] = [];

	const stub: MediaStub = {
		el,
		assigned,
		stall: options.stall,
		play: vi.fn(async () => {
			paused = false;
			el.dispatchEvent(new Event('play'));
		}),
		pause: vi.fn(() => {
			paused = true;
			el.dispatchEvent(new Event('pause'));
		}),
		isPaused: () => paused,
		isSeeking: () => seeking,
		finishSeek: () => {
			seeking = false;
			el.dispatchEvent(new Event('seeked'));
		},
	};

	Object.defineProperty(el, 'currentTime', {
		configurable: true,
		get: () => currentTime,
		set: (value: number) => {
			currentTime = value;
			assigned.push(value);
			// 実機: 代入の時点で seeking=true になり、seeking イベントが来る。
			seeking = true;
			el.dispatchEvent(new Event('seeking'));
			if (stub.stall) return;
			// 止まらないシークは完了して seeked が来る(表示側が位置を読み直す)。
			queueMicrotask(() => {
				seeking = false;
				el.dispatchEvent(new Event('seeked'));
			});
		},
	});
	Object.defineProperty(el, 'seeking', { configurable: true, get: () => seeking });
	Object.defineProperty(el, 'paused', { configurable: true, get: () => paused });
	Object.defineProperty(el, 'play', { configurable: true, value: stub.play });
	Object.defineProperty(el, 'pause', { configurable: true, value: stub.pause });
	// HAVE_METADATA 済み(索引到着の寄せ直し effect が readyState で抜けない)。
	Object.defineProperty(el, 'readyState', { configurable: true, get: () => 1 });
	Object.defineProperty(el, 'duration', {
		configurable: true,
		get: () => MEDIA_DURATION_SECONDS,
	});

	return stub;
}

/** `currentTime` へ最後に代入された値(未代入なら undefined)。 */
function lastAssigned(stub: MediaStub): number | undefined {
	return stub.assigned.length > 0 ? stub.assigned[stub.assigned.length - 1] : undefined;
}

/**
 * 表示(#n・時間表示・シークバーのつまみ)が行き先を示していることを確かめる(契約3)。
 *
 * 止まった要素は `seeked` を出していない(表示側が位置を読み直す口が無い)ので、作り直しの
 * 直後〜新しい要素の `seeked` までのあいだに行き先が出ていれば、それは作り直しが表示を
 * 行き先へ合わせた証拠。`when` は失敗時の文言に載せる場面の名前。
 */
function expectReadoutShows(frame: number, time: string, seconds: number, when: string): void {
	expect(frameText(), `${when}: #n が行き先のフレームを示すこと`).toBe(`#${frame}`);
	expect(timeText(), `${when}: 時間表示が行き先を示すこと`).toBe(time);
	expect(Number.parseFloat(seekSlider().value), `${when}: つまみが行き先を示すこと`).toBeCloseTo(
		seconds,
		3,
	);
}

/** シークバーで `seconds` へ動かして離す(input → change)。 */
async function scrubSeekBarTo(seconds: number): Promise<void> {
	const value = String(seconds);
	await fireEvent.input(seekSlider(), { target: { value } });
	await fireEvent.change(seekSlider(), { target: { value } });
	await flush();
}

/** 止まるモードにしてからシークバーで動かし、行き先が要求されたまま止まっていることを確かめる。 */
async function stalledScrubTo(stub: MediaStub, seconds: number, frame: number, index: FrameIndex) {
	stub.stall = true;
	await scrubSeekBarTo(seconds);
	const destination = seekTimeForFrame(index, frame);
	expect(lastAssigned(stub), '離した位置の最寄りフレームの真ん中へシークが要求されること').toBeCloseTo(
		destination,
		6,
	);
	expect(stub.isSeeking(), 'シークは終わらない(seeking=true のまま)').toBe(true);
	return destination;
}

let decodeSpy: Mock<(bytes: ArrayBuffer) => Promise<FakeAudioBuffer>>;
/** 作り直された要素に偽物を被せる前の `play()` も捕まえる prototype の spy。 */
let protoPlaySpy: MockInstance;

beforeEach(() => {
	vi.useFakeTimers({
		toFake: [
			'setTimeout',
			'clearTimeout',
			'setInterval',
			'clearInterval',
			'setImmediate',
			'clearImmediate',
			'Date',
			'performance',
			'requestAnimationFrame',
			'cancelAnimationFrame',
		],
	});

	invokeMock.mockReset();
	invokeMock.mockImplementation(async (command: string) => {
		if (command === 'get_video_frame_index') return FRAME_INDEX_PAYLOAD;
		if (command === 'extract_waveform_audio') return new ArrayBuffer(8);
		return null;
	});

	decodeSpy = vi.fn(async (_bytes: ArrayBuffer) => stereoBuffer());
	const decode = decodeSpy;
	vi.stubGlobal(
		'OfflineAudioContext',
		class {
			constructor(_channels: number, _length: number, _sampleRate: number) {}
			decodeAudioData(bytes: ArrayBuffer): Promise<FakeAudioBuffer> {
				return decode(bytes);
			}
		},
	);

	vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		}),
	);
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
	protoPlaySpy = vi
		.spyOn(HTMLMediaElement.prototype, 'play')
		.mockImplementation(async () => undefined);
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get: () => 320,
	});

	visibilityState = 'visible';
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => visibilityState,
	});
	Object.defineProperty(document, 'hidden', {
		configurable: true,
		get: () => visibilityState === 'hidden',
	});
});

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
	Reflect.deleteProperty(document, 'visibilityState');
	Reflect.deleteProperty(document, 'hidden');
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

type Mounted = {
	el: HTMLVideoElement;
	stub: MediaStub;
	index: FrameIndex;
	/** 段取りが終わった時点の窓指標(左端・幅)。作り直しで保たれることの比較元。 */
	indicatorBox: { left: string; width: string };
};

/**
 * 索引あり mp4 をマウントし、索引と波形が届いて先頭フレームに初期シークされ、消音し、
 * 波形を 2 倍に拡大した「一時停止中の下見」の状態まで進める。すべて visible の間。
 */
async function mountReadyVideo(): Promise<Mounted> {
	const index = frameIndexFromPayload(FRAME_INDEX_PAYLOAD);
	expect(index).not.toBeNull();

	render(VideoViewer, { props: MP4_PROPS });
	const video = videoElement();
	expect(video, 'inline の <video> がマウントで居ること').not.toBeNull();
	const el = video as HTMLVideoElement;
	const stub = instrumentMedia(el, { stall: false });

	// メタデータの到達(索引の寄せ直しと波形の解析がここから進む)。
	await fireEvent(el, new Event('loadedmetadata'));
	await vi.waitFor(() => {
		expect(indexCalls(), '索引の問い合わせが 1 回出ること').toHaveLength(1);
		expect(frameText(), '索引が届いて先頭フレーム #0 が出ること').toBe('#0');
		expect(extractCalls(), '波形の抽出が 1 回呼ばれること').toHaveLength(1);
		expect(noteEl(), '解析が終わって帯の文言が消えること').toBeNull();
		expect(laneLabelTexts(), 'ステレオの L/R ラベルが出ること').toEqual(['L', 'R']);
	});
	await flush();
	expect(decodeSpy).toHaveBeenCalledTimes(1);
	expect(lastAssigned(stub), '初期シークが先頭フレームの精密値に当たること').toBeCloseTo(
		initialSeekTime(index!),
		6,
	);
	// シークバーの尺は索引の尺(10 秒)。`durationchange` は出さない ―― 尺が索引から来て
	// いることを、作り直しの後の「尺が保たれる」判定の根拠にするため。
	expect(seekSlider().disabled).toBe(false);
	expect(Number(seekSlider().max)).toBeCloseTo(MEDIA_DURATION_SECONDS, 3);

	// 消音(追補c の経路)。
	await fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
	await fireEvent(el, new Event('volumechange'));
	expect(el.muted, '消音ボタンで要素の muted が true になること').toBe(true);
	expect(screen.getByRole('button', { name: 'Muted' }).getAttribute('aria-pressed')).toBe('true');

	// 波形を 2 倍に(要件#47)。倍率 1 では出ない窓指標が居ることで「拡大中」を観測する。
	await fireEvent.click(screen.getByRole('button', { name: 'Zoom In Waveform' }));
	await flush();
	const box = indicator();
	expect(box, '2 倍に拡大すると窓指標が出ること').not.toBeNull();
	const indicatorBox = { left: (box as HTMLElement).style.left, width: (box as HTMLElement).style.width };

	expect(stub.play).not.toHaveBeenCalled();
	expect(protoPlaySpy).not.toHaveBeenCalled();
	expect(stub.isPaused()).toBe(true);

	return { el, stub, index: index!, indicatorBox };
}

/**
 * 作り直された新しい `<video>` を取り出し、別物であることを確かめてから偽物を被せる。
 * 止まった要素は DOM から外れている。
 */
function takeReplacement(previous: HTMLVideoElement, options: { stall: boolean }) {
	const next = videoElement();
	expect(next, '作り直しの後も <video> が居ること').not.toBeNull();
	expect(next, '<video> が別の DOM ノードに替わること').not.toBe(previous);
	expect(previous.isConnected, '止まった要素は DOM から外れること').toBe(false);
	const el = next as HTMLVideoElement;
	const stub = instrumentMedia(el, options);
	return { el, stub };
}

describe('VideoViewer 配線(要件#37 追補i・Issue #788: hidden を経験した <video> のシークが止まったら作り直す)', () => {
	it('AC-37-追i (a): hidden を経験した要素で seeking が 1.5 秒続く → 同じ src で <video> が別の要素に替わり、loadedmetadata で行き先へシーク・一時停止・消音・索引と波形は取り直さず・ズームと尺は保たれ・表示は行き先', async () => {
		const { el, stub, index, indicatorBox } = await mountReadyVideo();
		await experienceHidden();

		const destination = await stalledScrubTo(stub, FIRST_SEEK_SECONDS, FIRST_SEEK_FRAME, index);
		const indexCallsBefore = indexCalls().length;
		const extractCallsBefore = extractCalls().length;
		const decodeCallsBefore = decodeSpy.mock.calls.length;

		// 境目の手前(1.4 秒)ではまだ作り直さない。
		await advance(JUST_BEFORE_THRESHOLD_MS);
		expect(videoElement(), '1.4 秒では作り直さないこと').toBe(el);

		// 1.5 秒を超えた(1.6 秒)ら作り直す。
		await advance(PAST_THRESHOLD_MS - JUST_BEFORE_THRESHOLD_MS);
		const next = takeReplacement(el, { stall: false });

		// 同じ src のまま(契約2)。
		expect(next.el.getAttribute('src'), '新しい要素は同じ src を持つこと').toBe(MP4_PROPS.src);
		// 消音は保たれる(契約3・追補c の `muted={audioMuted}`)。
		expect(next.el.muted, '新しい要素も消音されていること').toBe(true);
		expect(screen.getByRole('button', { name: 'Muted' }).getAttribute('aria-pressed')).toBe('true');
		// 作り直しの時点で play() は呼ばれていない(偽物を被せる前の呼び出しは prototype の spy が捕まえる)。
		expect(protoPlaySpy, '作り直しで play() を呼ばないこと').not.toHaveBeenCalled();
		expect(stub.play, '止まった要素にも play() を呼ばないこと').not.toHaveBeenCalled();

		// 表示は作り直しの直後(新しい要素の loadedmetadata より前)から行き先を示す(契約3)。
		// 止まった要素は seeked を出しておらず、新しい要素はまだ何も出していないので、
		// ここで行き先が出るのは作り直しが表示を合わせたから。
		expect(next.stub.assigned, '新しい要素にはまだシークしていないこと').toHaveLength(0);
		expectReadoutShows(FIRST_SEEK_FRAME, FIRST_SEEK_TIME_TEXT, destination, '作り直しの直後');

		// 新しい要素の loadedmetadata では、初期シークの先頭ではなく行き先へ(契約2)。
		await fireEvent(next.el, new Event('loadedmetadata'));
		await flush();
		expect(
			next.stub.assigned.some((value) => Math.abs(value - destination) < 1e-6),
			`loadedmetadata で行き先 ${destination} へシークすること(代入: ${JSON.stringify(next.stub.assigned)})`,
		).toBe(true);
		expect(lastAssigned(next.stub), '最後に要求した位置が行き先であること(先頭へ戻さない)').toBeCloseTo(
			destination,
			6,
		);
		expect(lastAssigned(next.stub)).not.toBeCloseTo(initialSeekTime(index), 6);
		expect(lastAssigned(next.stub)).not.toBeCloseTo(initialSeekTime(null), 6);
		expect(next.el.currentTime).toBeCloseTo(destination, 6);

		// 一時停止のまま(契約3)。
		expect(next.stub.play, '新しい要素に play() を呼ばないこと').not.toHaveBeenCalled();
		expect(protoPlaySpy).not.toHaveBeenCalled();
		expect(next.stub.isPaused()).toBe(true);
		expect(screen.queryByTitle('Pause (Space)'), '再生中の表示になっていないこと').toBeNull();

		// 表示は行き先を示す(#90・00:00:03.000・つまみ 3.0167)。
		expect(frameText()).toBe(`#${FIRST_SEEK_FRAME}`);
		expect(timeText()).toBe('00:00:03.000');
		expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(destination, 3);

		// 索引と波形は取り直さない・捨てない(契約3)。
		expect(indexCalls(), '索引の問い合わせが増えないこと').toHaveLength(indexCallsBefore);
		expect(extractCalls(), '波形の抽出が増えないこと').toHaveLength(extractCallsBefore);
		expect(decodeSpy.mock.calls, 'decode が増えないこと').toHaveLength(decodeCallsBefore);
		expect(noteEl(), '帯が「解析中」に戻らないこと').toBeNull();
		expect(laneLabelTexts(), '波形(L/R)が残っていること').toEqual(['L', 'R']);

		// 波形のズームと窓は保たれる(窓指標が同じ位置・幅のまま)。
		const box = indicator();
		expect(box, '拡大中の窓指標が残っていること(等倍へ戻していない)').not.toBeNull();
		expect((box as HTMLElement).style.left).toBe(indicatorBox.left);
		expect((box as HTMLElement).style.width).toBe(indicatorBox.width);

		// シークバーの尺は保たれる(索引の 10 秒・操作できる)。
		expect(seekSlider().disabled).toBe(false);
		expect(Number(seekSlider().max)).toBeCloseTo(MEDIA_DURATION_SECONDS, 3);
	});

	it('AC-37-追i (b): hidden を経験していても、1.5 秒より前に seeking が終われば作り直さない(その後の普通のシークも)', async () => {
		const { el, stub, index } = await mountReadyVideo();
		await experienceHidden();

		await stalledScrubTo(stub, FIRST_SEEK_SECONDS, FIRST_SEEK_FRAME, index);

		// 1.0 秒で終わる(遅いが止まっていないシーク)。
		await advance(1000);
		expect(videoElement()).toBe(el);
		stub.finishSeek();
		await flush();
		expect(stub.isSeeking()).toBe(false);

		// その後どれだけ経っても作り直さない。
		await advance(STALL_THRESHOLD_MS * 2);
		expect(videoElement(), '1.5 秒前に終わったシークでは作り直さないこと').toBe(el);
		expect(frameText()).toBe(`#${FIRST_SEEK_FRAME}`);

		// 普通のシーク(すぐ終わる)も作り直さない。
		stub.stall = false;
		await scrubSeekBarTo(SECOND_SEEK_SECONDS);
		expect(stub.isSeeking()).toBe(false);
		await advance(STALL_THRESHOLD_MS * 2);
		expect(videoElement(), '止まっていないシークでは作り直さないこと').toBe(el);
		expect(frameText()).toBe(`#${SECOND_SEEK_FRAME}`);

		expect(stub.play).not.toHaveBeenCalled();
		expect(protoPlaySpy).not.toHaveBeenCalled();
		expect(indexCalls()).toHaveLength(1);
		expect(extractCalls()).toHaveLength(1);
	});

	it('AC-37-追i (c): hidden を経験していない要素は、seeking が 5 秒続いても作り直さない', async () => {
		const { el, stub, index } = await mountReadyVideo();
		// visible のまま(hidden を一度も経験しない)。

		await stalledScrubTo(stub, FIRST_SEEK_SECONDS, FIRST_SEEK_FRAME, index);

		await advance(5000);
		expect(videoElement(), 'hidden を経験していない要素は作り直さないこと').toBe(el);
		expect(el.isConnected).toBe(true);
		expect(stub.isSeeking(), 'シークは止まったまま(こちらで終わらせていない)').toBe(true);

		expect(stub.play).not.toHaveBeenCalled();
		expect(protoPlaySpy).not.toHaveBeenCalled();
		expect(indexCalls()).toHaveLength(1);
		expect(extractCalls()).toHaveLength(1);
	});

	it('AC-37-追i (d): hidden の間は数えない ―― シーク直後に hidden で 5 秒経っても作り直さず、visible に戻ってから 1.4 秒では作り直さず、1.6 秒で作り直す', async () => {
		const { el, stub, index } = await mountReadyVideo();
		await experienceHidden();

		const destination = await stalledScrubTo(stub, FIRST_SEEK_SECONDS, FIRST_SEEK_FRAME, index);

		// シークの直後(visible の時間は経っていない)に hidden になり、そのまま 5 秒。
		await setPageVisibility('hidden');
		await advance(5000);
		expect(videoElement(), 'hidden の間は数えない(5 秒経っても作り直さない)こと').toBe(el);

		// visible に戻ってから数え直す。
		await setPageVisibility('visible');
		await advance(JUST_BEFORE_THRESHOLD_MS);
		expect(videoElement(), 'visible に戻って 1.4 秒では作り直さないこと').toBe(el);

		await advance(PAST_THRESHOLD_MS - JUST_BEFORE_THRESHOLD_MS);
		const next = takeReplacement(el, { stall: false });

		await fireEvent(next.el, new Event('loadedmetadata'));
		await flush();
		expect(lastAssigned(next.stub), '新しい要素は行き先へシークすること').toBeCloseTo(destination, 6);
		expect(frameText()).toBe(`#${FIRST_SEEK_FRAME}`);
		expect(next.stub.play).not.toHaveBeenCalled();
		expect(protoPlaySpy).not.toHaveBeenCalled();
	});

	it('AC-37-追i (e): 作り直した要素でも止まったら、それ以上作り直さない。その後の新しいシーク(別の行き先)は 1 から数えて 1.5 秒で作り直す', async () => {
		const { el, stub, index } = await mountReadyVideo();
		await experienceHidden();

		const firstDestination = await stalledScrubTo(stub, FIRST_SEEK_SECONDS, FIRST_SEEK_FRAME, index);

		// 1 回目の作り直し。
		await advance(PAST_THRESHOLD_MS);
		const second = takeReplacement(el, { stall: true });

		// 作り直した要素の loadedmetadata で行き先へシーク ―― これも止まる。
		await fireEvent(second.el, new Event('loadedmetadata'));
		await flush();
		expect(lastAssigned(second.stub)).toBeCloseTo(firstDestination, 6);
		expect(second.stub.isSeeking()).toBe(true);

		// 戻しのシークが止まっている間も、表示は行き先を示す(契約3)。新しい要素は seeked を
		// 出していないので、ここで行き先が出るのは作り直しが表示を合わせたから。
		expectReadoutShows(
			FIRST_SEEK_FRAME,
			FIRST_SEEK_TIME_TEXT,
			firstDestination,
			'作り直した要素の戻しのシークが止まっている間',
		);

		// 作り直した要素にも hidden を経験させる(契約1 の条件をすべて満たしたうえで、
		// 契約4 の上限だけが作り直しを止めることを確かめる)。visible の時間は経っていない。
		await experienceHidden();
		await advance(STALL_THRESHOLD_MS * 2);
		expect(videoElement(), '同じ行き先で 2 回目の作り直しはしないこと').toBe(second.el);
		expect(second.el.isConnected).toBe(true);
		expect(second.stub.isSeeking()).toBe(true);
		expect(second.stub.play).not.toHaveBeenCalled();
		expect(protoPlaySpy).not.toHaveBeenCalled();
		// 作り直さずに待っている間も、表示は行き先のまま(先頭や古い位置へ戻らない)。
		expectReadoutShows(
			FIRST_SEEK_FRAME,
			FIRST_SEEK_TIME_TEXT,
			firstDestination,
			'2 回目の作り直しをせずに 3 秒待った後',
		);

		// 利用者の新しいシーク(別の行き先=5 秒)。このシークは 1 から数える。
		const secondDestination = await stalledScrubTo(
			second.stub,
			SECOND_SEEK_SECONDS,
			SECOND_SEEK_FRAME,
			index,
		);
		await advance(JUST_BEFORE_THRESHOLD_MS);
		expect(videoElement(), '新しいシークも 1.4 秒では作り直さないこと').toBe(second.el);

		await advance(PAST_THRESHOLD_MS - JUST_BEFORE_THRESHOLD_MS);
		const third = takeReplacement(second.el, { stall: false });

		// 2 回目の作り直しの直後(loadedmetadata の前)から、表示は新しい行き先を示す(契約3)。
		expect(third.stub.assigned, '3 つ目の要素にはまだシークしていないこと').toHaveLength(0);
		expectReadoutShows(
			SECOND_SEEK_FRAME,
			SECOND_SEEK_TIME_TEXT,
			secondDestination,
			'新しいシークの作り直しの直後',
		);

		await fireEvent(third.el, new Event('loadedmetadata'));
		await flush();
		expect(lastAssigned(third.stub), '新しい要素は新しい行き先へシークすること').toBeCloseTo(
			secondDestination,
			6,
		);
		expect(lastAssigned(third.stub)).not.toBeCloseTo(firstDestination, 6);
		expect(frameText()).toBe(`#${SECOND_SEEK_FRAME}`);
		expect(timeText()).toBe(SECOND_SEEK_TIME_TEXT);
		expect(third.el.muted).toBe(true);
		expect(third.stub.play).not.toHaveBeenCalled();
		expect(protoPlaySpy).not.toHaveBeenCalled();

		// 2 回の作り直しをまたいでも、索引と波形は取り直していない。
		expect(indexCalls()).toHaveLength(1);
		expect(extractCalls()).toHaveLength(1);
		expect(decodeSpy).toHaveBeenCalledTimes(1);
		expect(laneLabelTexts()).toEqual(['L', 'R']);
	});

	it('AC-37-追i (e) 重ね: 止まったシークの最中(1.0 秒)に別の位置へシークを重ねたら、最後の要求から数え直す ―― 最初の要求から 2.4 秒(最後から 1.4 秒)では作り直さず、最後から 1.6 秒で作り直す。行き先は最後の要求の位置', async () => {
		const { el, stub, index } = await mountReadyVideo();
		await experienceHidden();

		// 最初の要求(3 秒)。止まる。
		const firstDestination = await stalledScrubTo(stub, FIRST_SEEK_SECONDS, FIRST_SEEK_FRAME, index);

		// 1.0 秒たったところで、別の位置(5 秒)へ重ねる。こちらも止まる(seeked は来ない)。
		await advance(OVERLAP_AFTER_MS);
		expect(videoElement(), '重ねる前(1.0 秒)はまだ作り直していないこと').toBe(el);
		const secondDestination = await stalledScrubTo(
			stub,
			SECOND_SEEK_SECONDS,
			SECOND_SEEK_FRAME,
			index,
		);
		expect(
			stub.assigned.some((value) => Math.abs(value - firstDestination) < 1e-6),
			'最初の要求も同じ要素に出ていたこと(重ねたのであって置き換えたのではない)',
		).toBe(true);
		expect(el.currentTime, 'シーク中の currentTime は最後に要求した位置を返すこと').toBeCloseTo(
			secondDestination,
			6,
		);

		// 最後の要求から 1.4 秒(最初の要求からは 2.4 秒=1.5 秒を超えている)ではまだ作り直さない。
		await advance(JUST_BEFORE_THRESHOLD_MS);
		expect(
			videoElement(),
			'最初の要求から 2.4 秒でも、最後の要求から 1.4 秒なら作り直さないこと',
		).toBe(el);
		expect(el.isConnected).toBe(true);
		expect(stub.isSeeking()).toBe(true);

		// 最後の要求から 1.6 秒で作り直す。
		await advance(PAST_THRESHOLD_MS - JUST_BEFORE_THRESHOLD_MS);
		const next = takeReplacement(el, { stall: false });
		expect(next.el.getAttribute('src')).toBe(MP4_PROPS.src);
		expect(next.el.muted).toBe(true);
		expect(protoPlaySpy).not.toHaveBeenCalled();
		expect(stub.play).not.toHaveBeenCalled();

		// 作り直しの直後(loadedmetadata の前)から、表示は最後の要求の行き先(#150・5 秒)。
		expect(next.stub.assigned).toHaveLength(0);
		expectReadoutShows(
			SECOND_SEEK_FRAME,
			SECOND_SEEK_TIME_TEXT,
			secondDestination,
			'重ねたシークの作り直しの直後',
		);

		// 新しい要素の loadedmetadata では、最後の要求の位置へ(最初の要求の位置や先頭ではない)。
		await fireEvent(next.el, new Event('loadedmetadata'));
		await flush();
		expect(lastAssigned(next.stub), '新しい要素は最後の要求の位置へシークすること').toBeCloseTo(
			secondDestination,
			6,
		);
		expect(
			next.stub.assigned.some((value) => Math.abs(value - firstDestination) < 1e-6),
			'最初の要求の位置へは戻さないこと',
		).toBe(false);
		expect(lastAssigned(next.stub)).not.toBeCloseTo(initialSeekTime(index), 6);
		expect(next.el.currentTime).toBeCloseTo(secondDestination, 6);
		expectReadoutShows(
			SECOND_SEEK_FRAME,
			SECOND_SEEK_TIME_TEXT,
			secondDestination,
			'重ねたシークの作り直しの戻しの後',
		);

		// 一時停止のまま・索引と波形は取り直さない(契約3)。
		expect(next.stub.play).not.toHaveBeenCalled();
		expect(protoPlaySpy).not.toHaveBeenCalled();
		expect(next.stub.isPaused()).toBe(true);
		expect(indexCalls()).toHaveLength(1);
		expect(extractCalls()).toHaveLength(1);
		expect(decodeSpy).toHaveBeenCalledTimes(1);
		expect(laneLabelTexts()).toEqual(['L', 'R']);
	});
});
