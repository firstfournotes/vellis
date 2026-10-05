/**
 * 要件#37 追補b(backlog 238)=同じ動画を開き直すと表示だけ先頭へ戻り、画面と再生は
 * 途中のまま。受け入れ基準 AC-37-追b の配線テスト(JSDOM・component プロジェクト)。
 *
 * ## 判定するもの(AC-37-追b・由谷の決定 2026-10-01「開き直したら画面も再生も先頭へ戻す」)
 * 同じ動画を開き直したとき(`{#key src}` が文字列一致で `<video>` を据え置く場合)に、
 * 初めて開いたときと同じ状態へそろえる:
 * - (a) 索引の無い webm: 尺を与え → 7.25 秒へシーク(seeked)して停止 → 開き直すと、
 *   `<video>` は同一要素のまま `video.currentTime` に `initialSeekTime(null)` が代入され、
 *   シークバーの値と時間表示が先頭を指す(契約 追補b 2)
 * - (b) 同じ webm を再生中(`paused=false`・`play` イベント済み)に開き直すと
 *   `video.pause()` が呼ばれ、再生ボタンが Play の表示になる(契約 追補b 1)。
 *   止めたうえで先頭へも戻る(契約 追補b 2 は再生中でも同じ)
 * - (c) 索引のある動画(`get_video_frame_index` のモックが索引を返す)で再生中に
 *   開き直しても (b) と同じく止まり、`currentTime` が `initialSeekTime(index)`
 *   (先頭フレームの精密値)になる(契約 追補b 3)
 *
 * ## 再現する経路
 * 追補a(`VideoViewer.reopen.wiring.test.ts`)と同じホスト
 * `__fixtures__/VideoViewerReopenHost.svelte`(+page.svelte の setDocument →
 * videoDisplay の作り直し → メンバー式で渡す、を写したもの)。`reopen()` が
 * Explorer で同じファイルをもう一度クリックした操作に相当し、子の読み込み直し
 * effect は再実行されるが `<video>` は据え置き=`loadedmetadata` は来ない。
 *
 * ## `<video>` の差し替え(jsdom の HTMLMediaElement は play/pause 未実装・paused は常に true)
 * 要素ごとに `currentTime`(getter/setter)・`paused`・`pause()`・`play()` を被せて観測する。
 * - `currentTime` の setter は代入値を控えたうえで microtask で `seeked` を出す
 *   (実機でシーク完了に `seeked` が来るのと同じ形)。これで表示側(`position`)が
 *   実位置に追従し、「currentTime が先頭 ⇒ シークバー・時間表示も先頭」を同じ経路で見る
 * - `pause()` は `paused=true` にして `pause` イベントを出す(実機と同じ順)
 * - `readyState` は (c) でだけ HAVE_METADATA(1)を被せる(索引到着時の初期シーク
 *   effect が `readyState < HAVE_METADATA` で抜けないように=初回の開きで精密値が当たる
 *   ことまで含めて実機の形にする)
 *
 * ## 想定される赤(実装前)
 * - (a) 読み込み直しの effect は状態だけを初期化し、`<video>` には触れない。索引の無い
 *   webm では索引到着の寄せ直しも走らないので、開き直し後に `currentTime` は代入されない
 *   → setter 未呼び出しで赤(backlog 238 の症状そのもの)
 * - (b) `pause()` を呼ぶ処理が無い → 未呼び出しで赤(ボタンの Play 表示だけは
 *   `playing=false` の初期化で実装前から出る=「音は続くのにボタンが Play」の症状)
 * - (c) 索引は取り直されるが、`applyInitialSeek` は `!el.paused` で抜ける(再生中)
 *   → `pause()` も `currentTime` 代入も無く赤。停止中なら索引の取り直しで当たるため、
 *   必ず再生中にしてから開き直す
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import VideoViewerReopenHost from './__fixtures__/VideoViewerReopenHost.svelte';
import { invoke } from '$lib/ipc';
import {
	frameIndexFromPayload,
	initialSeekTime,
	type VideoFrameIndexPayload,
} from '$lib/video-frame';

vi.mock('$lib/ipc', () => ({
	// 既定: get_video_frame_index → null(索引なしの縮退=webm)。(c) だけ索引を返す。
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

/** フレーム索引の無い動画(webm ローカル)。videoViewMode → 'inline'。 */
const WEBM_PROPS = {
	uri: 'file:///Users/a/movies/clip.webm',
	src: 'vellis-asset://local/Users/a/movies/clip.webm',
};

/** フレーム索引のある動画(mp4 ローカル)。 */
const MP4_PROPS = {
	uri: 'file:///Users/a/movies/clip.mp4',
	src: 'vellis-asset://local/Users/a/movies/clip.mp4',
};

/**
 * (c) 用のフレーム索引(30fps CFR・300 フレーム=10 秒)。7.25 秒へのシークが
 * 尺の内側に収まる長さにする。先頭フレームの精密値は `(0 + 1/30) / 2` 秒で、
 * 縮退値 `initialSeekTime(null)` とは別の値になる(取り違えを判定で区別できる)。
 */
const FRAME_INDEX_PAYLOAD: VideoFrameIndexPayload = {
	timescale: 30,
	sampleTimes: Array.from({ length: 300 }, (_, i) => i),
	duration: 300,
	fpsNum: 30,
	fpsDen: 1,
	isCfr: true,
};

/** 開き直し前にユーザーが動かしておく位置(秒)。 */
const USER_SEEK_SECONDS = 7.25;

/** 積み残しの非同期を流しきる(macrotask 2周)。 */
async function flushTasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const seekSlider = () => document.querySelector('input.video-seek') as HTMLInputElement;
const videoElement = () => document.querySelector('video.video') as HTMLVideoElement | null;
const timeText = () => document.querySelector('.video-time')?.textContent ?? null;
const playButton = () =>
	Array.from(document.querySelectorAll('button.video-button')).find((button) =>
		/^(Play|Pause)$/.test(button.textContent?.trim() ?? ''),
	) as HTMLButtonElement | undefined;

/**
 * jsdom の `<video>` に再生状態とシークの観測口を被せる。
 *
 * 返す `currentTimeSetter` が「アプリ側から `currentTime` に代入された値」の記録。
 * `pause` / `play` は呼ばれたことを観測する vi.fn で、実機と同じく `paused` を
 * 切り替えてイベントを出す。
 */
function instrumentMedia(el: HTMLVideoElement, options: { readyState?: number } = {}) {
	let currentTime = 0;
	let paused = true;

	const currentTimeSetter = vi.fn((value: number) => {
		currentTime = value;
		// 実機ではシーク完了に `seeked` が来る。表示側がそれを拾って位置を読み直す。
		queueMicrotask(() => el.dispatchEvent(new Event('seeked')));
	});
	const pause = vi.fn(() => {
		paused = true;
		el.dispatchEvent(new Event('pause'));
	});
	const play = vi.fn(async () => {
		paused = false;
		el.dispatchEvent(new Event('play'));
	});

	Object.defineProperty(el, 'currentTime', {
		configurable: true,
		get: () => currentTime,
		set: (value: number) => currentTimeSetter(value),
	});
	Object.defineProperty(el, 'paused', { configurable: true, get: () => paused });
	Object.defineProperty(el, 'pause', { configurable: true, value: pause });
	Object.defineProperty(el, 'play', { configurable: true, value: play });
	if (options.readyState !== undefined) {
		const { readyState } = options;
		Object.defineProperty(el, 'readyState', { configurable: true, get: () => readyState });
	}

	return {
		currentTimeSetter,
		pause,
		play,
		/** ユーザーのシーク相当: 実位置を動かし、完了の `seeked` を出す(setter は通さない)。 */
		async seekTo(seconds: number): Promise<void> {
			currentTime = seconds;
			await fireEvent(el, new Event('seeked'));
		},
		/** 再生中にする: `paused=false` にして `play` イベントを出す(AC (b) の前提)。 */
		async startPlaying(): Promise<void> {
			paused = false;
			await fireEvent(el, new Event('play'));
		},
		isPaused: () => paused,
	};
}

/** 開き直し後に `currentTime` へ最後に代入された値(未代入なら undefined)。 */
function lastAssignedCurrentTime(setter: Mock<(value: number) => void>): number | undefined {
	const calls = setter.mock.calls;
	return calls.length > 0 ? calls[calls.length - 1][0] : undefined;
}

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
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
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

/**
 * 索引なし webm をホスト経由でマウントし、`<video>` を差し替えてから尺 12.5 を
 * 申告させ、シークバーが操作できる状態(AC の前段「尺を与える」)まで進める。
 */
async function mountWebmWithDuration() {
	const { component } = render(VideoViewerReopenHost, { props: WEBM_PROPS });

	const video = videoElement();
	expect(video).not.toBeNull();
	const el = video as HTMLVideoElement;
	const media = instrumentMedia(el);

	// 索引の問い合わせが起きて null 縮退になっていること(索引の寄せ直しが走らない前提)。
	await vi.waitFor(() => {
		expect(invokeMock.mock.calls.some(([command]) => command === 'get_video_frame_index')).toBe(
			true,
		);
	});
	await flushTasks();

	// jsdom の <video> は duration を持たない(NaN)。有限値 12.5 を被せて durationchange を出す。
	Object.defineProperty(el, 'duration', { configurable: true, get: () => 12.5 });
	await fireEvent(el, new Event('durationchange'));
	await vi.waitFor(() => {
		expect(seekSlider().disabled).toBe(false);
		expect(Number(seekSlider().max)).toBeCloseTo(12.5, 3);
	});

	return { component, video: el, media };
}

/**
 * 索引あり mp4 をホスト経由でマウントし、索引到着による初回の初期シーク(精密値)が
 * 当たるところまで進める。開き直し後の代入だけを見られるよう setter の記録は空にして返す。
 */
async function mountMp4WithIndex() {
	invokeMock.mockImplementation(async (command: string) =>
		command === 'get_video_frame_index' ? FRAME_INDEX_PAYLOAD : null,
	);
	const index = frameIndexFromPayload(FRAME_INDEX_PAYLOAD);
	expect(index).not.toBeNull();

	const { component } = render(VideoViewerReopenHost, { props: MP4_PROPS });

	const video = videoElement();
	expect(video).not.toBeNull();
	const el = video as HTMLVideoElement;
	// HAVE_METADATA 済みにして、索引到着の寄せ直しが初回から効く実機の形にする。
	const media = instrumentMedia(el, { readyState: 1 });

	// 初回の開き: 索引が届いて先頭フレームの精密値へ初期シークされる(要件#39 契約③)。
	await vi.waitFor(() => {
		expect(lastAssignedCurrentTime(media.currentTimeSetter)).toBeCloseTo(
			initialSeekTime(index),
			6,
		);
	});
	await flushTasks();
	// 索引の尺(10 秒)でシークバーが使える。
	await vi.waitFor(() => {
		expect(seekSlider().disabled).toBe(false);
		expect(Number(seekSlider().max)).toBeCloseTo(10, 3);
	});
	media.currentTimeSetter.mockClear();

	return { component, video: el, media, index: index! };
}

/**
 * 開き直し前の共通の形: 7.25 秒へ動かして、表示がそこを指していることを見る。
 * 時間表示は索引の有無で変わる(索引ありはそのフレームの提示開始時刻=30fps なら
 * 217 フレーム目の 7.233 秒・索引なしは実位置そのまま 7.250)。
 */
async function seekToUserPosition(
	media: ReturnType<typeof instrumentMedia>,
	expectedTimeText: string,
): Promise<void> {
	await media.seekTo(USER_SEEK_SECONDS);
	await vi.waitFor(() => {
		expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(USER_SEEK_SECONDS, 3);
	});
	expect(timeText()).toBe(expectedTimeText);
}

/** 同じファイルの開き直し(setDocument → videoDisplay の組み立て直し)。 */
async function reopenSameFile(component: { reopen: () => void }): Promise<void> {
	component.reopen();
	await tick();
	await flushTasks();
}

describe('VideoViewer 配線(要件#37 追補b・backlog 238: 同じ動画の開き直しで画面も再生も先頭へ戻す)', () => {
	it('AC-37-追b (a): 索引なし webm を 7.25 秒で停止中に開き直すと、currentTime が initialSeekTime(null) に設定され、シークバーと時間表示が先頭を指す', async () => {
		const { component, video, media } = await mountWebmWithDuration();
		await seekToUserPosition(media, '00:00:07.250');
		expect(media.isPaused()).toBe(true);
		media.currentTimeSetter.mockClear();

		await reopenSameFile(component);

		// 経路の確認: `{#key src}` は同じ文字列なので <video> は据え置き。
		expect(videoElement()).toBe(video);

		// 本題(契約 追補b 2): 据え置かれた <video> に先頭への初期シークが当て直される。
		// 実装前は何も代入されず(currentTime は 7.25 のまま)ここで赤。
		await vi.waitFor(() => {
			expect(media.currentTimeSetter).toHaveBeenCalled();
			expect(lastAssignedCurrentTime(media.currentTimeSetter)).toBeCloseTo(
				initialSeekTime(null),
				6,
			);
		});
		expect(video.currentTime).toBeCloseTo(initialSeekTime(null), 6);

		// 表示も先頭(シーク完了の seeked を経て実位置に追従した値)。
		await vi.waitFor(() => {
			expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(0, 3);
			expect(timeText()).toBe('00:00:00.000');
		});
		// 停止中の開き直しなので再生は始めない(要件#39 契約②=自動再生しない)。
		expect(media.play).not.toHaveBeenCalled();
		expect(media.isPaused()).toBe(true);
	});

	it('AC-37-追b (b): 索引なし webm を再生中に開き直すと video.pause() が呼ばれ、再生ボタンが Play になり、先頭へ戻る', async () => {
		const { component, video, media } = await mountWebmWithDuration();
		await seekToUserPosition(media, '00:00:07.250');

		// 再生中にする(paused=false・play イベント済み)。ボタンは Pause 表示。
		await media.startPlaying();
		await vi.waitFor(() => {
			expect(playButton()?.textContent?.trim()).toBe('Pause');
		});
		expect(media.isPaused()).toBe(false);
		media.currentTimeSetter.mockClear();

		await reopenSameFile(component);

		expect(videoElement()).toBe(video);

		// 本題(契約 追補b 1): <video> を止める。実装前は pause() が呼ばれず
		// (音は続くのにボタンだけ Play になる症状)ここで赤。
		await vi.waitFor(() => {
			expect(media.pause).toHaveBeenCalled();
		});
		expect(media.isPaused()).toBe(true);
		// ボタンの表示と実際の再生状態が一致する(Play)。
		await vi.waitFor(() => {
			expect(playButton()?.textContent?.trim()).toBe('Play');
		});
		// 止めたうえで先頭へも戻る(契約 追補b 2 は再生中の開き直しでも同じ)。
		await vi.waitFor(() => {
			expect(lastAssignedCurrentTime(media.currentTimeSetter)).toBeCloseTo(
				initialSeekTime(null),
				6,
			);
		});
		await vi.waitFor(() => {
			expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(0, 3);
			expect(timeText()).toBe('00:00:00.000');
		});
		// 止めたあとに勝手に再生し直さない。
		expect(media.play).not.toHaveBeenCalled();
	});

	it('AC-37-追b (c): 索引のある動画を再生中に開き直しても止まり、currentTime が initialSeekTime(index) になる', async () => {
		const { component, video, media, index } = await mountMp4WithIndex();
		await seekToUserPosition(media, '00:00:07.233');

		await media.startPlaying();
		await vi.waitFor(() => {
			expect(playButton()?.textContent?.trim()).toBe('Pause');
		});
		expect(media.isPaused()).toBe(false);
		media.currentTimeSetter.mockClear();

		await reopenSameFile(component);

		expect(videoElement()).toBe(video);

		// 止まる(契約 追補b 3=索引のある動画でも同じ)。実装前は索引の取り直しで
		// applyInitialSeek まで来ても `!el.paused` で抜けるため、pause() も代入も無く赤。
		await vi.waitFor(() => {
			expect(media.pause).toHaveBeenCalled();
		});
		expect(media.isPaused()).toBe(true);
		await vi.waitFor(() => {
			expect(playButton()?.textContent?.trim()).toBe('Play');
		});

		// 先頭フレームの精密値へ戻る(縮退値 initialSeekTime(null) ではない)。
		await vi.waitFor(() => {
			expect(media.currentTimeSetter).toHaveBeenCalled();
			expect(lastAssignedCurrentTime(media.currentTimeSetter)).toBeCloseTo(
				initialSeekTime(index),
				6,
			);
		});
		expect(video.currentTime).toBeCloseTo(initialSeekTime(index), 6);
		expect(video.currentTime).not.toBeCloseTo(initialSeekTime(null), 6);

		// 表示も先頭: シークバーの値は実位置(先頭フレームの内側)・時間表示は先頭フレーム。
		await vi.waitFor(() => {
			expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(initialSeekTime(index), 3);
			expect(timeText()).toBe('00:00:00.000');
		});
		expect(media.play).not.toHaveBeenCalled();
	});
});
