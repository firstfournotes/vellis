/**
 * 要件#37 追補e(backlog 248)=開き直しの後、索引が届く前にユーザーがシークしたら、
 * 遅れて届いた索引による初期シークの寄せ直しを割り込ませない(要件#39 契約⑤の配線)。
 * 受け入れ基準 AC-37-追e の配線テスト(JSDOM・component プロジェクト)。
 *
 * ## このテストの性格(回帰の番人)
 * 実装は変えない=テストの追加だけなので、**最初から緑になる**。検証力は reviewer が
 * 一時的な書き換えで赤になることを確かめる: `VideoViewer.svelte` の
 * `onScrubInput` / `onScrubCommit` にある `initialSeekPending = false;`(ユーザーの
 * シークバー操作で初期シークの旗を降ろす処理)を**両方**外すと、索引到着時の
 * `applyInitialSeek` が `currentTime` を先頭の精密値へ書き換えて (1) が赤になる。
 * 片方だけ外しても、もう片方が旗を降ろすので緑のまま(実機の操作は input → change の
 * 順に両方を通る)。
 *
 * ## 判定するもの(AC-37-追e)
 * (1) 索引のある動画を開く → 開き直す(追補b の経路=`<video>` は据え置き・索引は
 *     取り直し)→ 取り直しの応答が**届く前に**シークバーで 3 秒へシークして離す →
 *     保留していた索引を返し、**届いたことをフレーム番号の表示(`.video-frame`=索引が
 *     あるときだけ出る・3 秒なら `#90`)で陽性に確かめてから** → `currentTime` が先頭の
 *     精密値 `initialSeekTime(index)` に書き換えられず 3 秒付近のまま・シークバーの値も
 *     3 秒付近のまま(時間表示 `00:00:03.000` は索引の有無で同じ文字列なので、索引到着の
 *     根拠にはしない)
 * (2) 陽性対照: 同じ段取りでシークしないまま索引を返すと、`currentTime` が
 *     `initialSeekTime(index)` になる(寄せ直しそのものは働いている=(1) が「寄せ直しが
 *     もともと走らないから緑」ではないことの裏付け)
 *
 * ## 再現する経路
 * 追補a/b と同じホスト `__fixtures__/VideoViewerReopenHost.svelte`(書き換えない)。
 * `reopen()` が Explorer で同じファイルをもう一度クリックした操作に相当する。
 * `get_video_frame_index` のモックは 1 回目(初めて開いたとき)は即返し、2 回目
 * (開き直しの取り直し)は Promise を保留して手動で resolve する ―― 「索引が届く前」を
 * 作るための細工で、実機では Rust 側の解析が終わるまでの間に相当する。
 *
 * ## `<video>` の差し替え(追補b のテストと同じ形)
 * jsdom の HTMLMediaElement は play/pause 未実装・paused は常に true・duration は NaN
 * なので、要素ごとに `currentTime`(getter/setter)・`paused`・`pause()`・`play()`・
 * `readyState`(HAVE_METADATA=1)・`duration`(10 秒)を被せて観測する。
 * - `currentTime` の setter は代入値を控えたうえで microtask で `seeked` を出す
 *   (表示側 `position` が実位置に追従する=シークバーの値を同じ経路で見る)
 * - `duration` を 10 秒にして `durationchange` を出しておくのは、索引の取り直しの間
 *   (`frameIndex=null`)もシークバーの範囲が `mediaDuration` で保たれ、操作できる
 *   状態にするため(実機では `<video>` が尺を申告済みなのと同じ)
 *
 * ## シークバーの操作の仕方
 * 実機の「3 秒へ動かして離す」= `input`(掴んでいる間の追従・`onScrubInput`)→
 * `change`(離した・`onScrubCommit`)。既存の配線テストが `<input>` へ値を入れる形
 * (`fireEvent.input(el, { target: { value } })`)に合わせ、`fireEvent.change` を続ける。
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

/** フレーム索引のある動画(mp4 ローカル)。videoViewMode → 'inline'。 */
const MP4_PROPS = {
	uri: 'file:///Users/a/movies/clip.mp4',
	src: 'vellis-asset://local/Users/a/movies/clip.mp4',
};

/**
 * フレーム索引(30fps CFR・300 フレーム=10 秒)。先頭フレームの精密値は
 * `(0 + 1/30) / 2` 秒で、縮退値 `initialSeekTime(null)` とも 3 秒とも離れている。
 */
const FRAME_INDEX_PAYLOAD: VideoFrameIndexPayload = {
	timescale: 30,
	sampleTimes: Array.from({ length: 300 }, (_, i) => i),
	duration: 300,
	fpsNum: 30,
	fpsDen: 1,
	isCfr: true,
};

/** `<video>` に被せる尺(秒)。索引の尺(10 秒)と同じにしておく。 */
const MEDIA_DURATION_SECONDS = 10;

/** 開き直しの後、索引が届く前にユーザーが動かす位置(秒)。 */
const USER_SEEK_SECONDS = 3;

/** 積み残しの非同期を流しきる(macrotask 2周)。 */
async function flushTasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const seekSlider = () => document.querySelector('input.video-seek') as HTMLInputElement;
const videoElement = () => document.querySelector('video.video') as HTMLVideoElement | null;
const timeText = () => document.querySelector('.video-time')?.textContent ?? null;
/**
 * フレーム番号の表示(`#n`)。索引が null の間は要素そのものが出ない
 * (`barCapabilities(null).frameReadout=false`)ので、「索引が届いた」ことの陽性の観測に使う。
 * 時間表示は索引の有無で同じ文字列(3 秒なら `00:00:03.000`)になり、区別できない。
 */
const frameText = () => document.querySelector('.video-frame')?.textContent ?? null;

/** 3 秒は 30fps で 90 フレーム目(索引到着後のフレーム番号の期待値)。 */
const USER_SEEK_FRAME_TEXT = '#90';

/**
 * jsdom の `<video>` に再生状態とシークの観測口を被せる(追補b のテストと同じ形)。
 * 返す `currentTimeSetter` が「アプリ側から `currentTime` に代入された値」の記録。
 */
function instrumentMedia(el: HTMLVideoElement) {
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
	// HAVE_METADATA 済み(索引到着の寄せ直し effect が `readyState < HAVE_METADATA` で抜けない)。
	Object.defineProperty(el, 'readyState', { configurable: true, get: () => 1 });
	// 尺を申告済みにする(索引の取り直しの間もシークバーが使える)。
	Object.defineProperty(el, 'duration', {
		configurable: true,
		get: () => MEDIA_DURATION_SECONDS,
	});

	return { currentTimeSetter, pause, play, isPaused: () => paused };
}

/** `currentTime` へ最後に代入された値(未代入なら undefined)。 */
function lastAssignedCurrentTime(setter: Mock<(value: number) => void>): number | undefined {
	const calls = setter.mock.calls;
	return calls.length > 0 ? calls[calls.length - 1][0] : undefined;
}

/**
 * `get_video_frame_index` の応答を「1 回目は即返す・2 回目は保留」にする。
 * 返す `resolveSecond()` が、保留していた 2 回目(開き直しの取り直し)の索引を届ける。
 */
function mockIndexDeferredOnSecondCall() {
	let resolveDeferred!: (payload: VideoFrameIndexPayload | null) => void;
	const deferred = new Promise<VideoFrameIndexPayload | null>((resolve) => {
		resolveDeferred = resolve;
	});
	let indexCalls = 0;
	invokeMock.mockImplementation(async (command: string) => {
		if (command !== 'get_video_frame_index') return null;
		indexCalls += 1;
		return indexCalls === 1 ? FRAME_INDEX_PAYLOAD : deferred;
	});
	return {
		indexCalls: () => indexCalls,
		resolveSecond: () => resolveDeferred(FRAME_INDEX_PAYLOAD),
	};
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
 * 索引あり mp4 をホスト経由でマウントし、初回の索引到着による初期シーク(精密値)が
 * 当たり、尺 10 秒でシークバーが使えるところまで進める。そのうえで開き直し、
 * 2 回目の索引の問い合わせが出た(=保留中)ところで返す。
 * setter の記録は開き直しの直前に空にする(開き直し以降の代入だけを見る)。
 */
async function mountReopenAndHoldIndex() {
	const gate = mockIndexDeferredOnSecondCall();
	const index = frameIndexFromPayload(FRAME_INDEX_PAYLOAD);
	expect(index).not.toBeNull();

	const { component } = render(VideoViewerReopenHost, { props: MP4_PROPS });

	const video = videoElement();
	expect(video).not.toBeNull();
	const el = video as HTMLVideoElement;
	const media = instrumentMedia(el);

	// 初回の開き: 索引(1 回目=即返し)が届いて先頭フレームの精密値へ初期シークされる。
	await vi.waitFor(() => {
		expect(lastAssignedCurrentTime(media.currentTimeSetter)).toBeCloseTo(
			initialSeekTime(index),
			6,
		);
	});
	await flushTasks();

	// `<video>` が尺を申告する(実機の durationchange)。索引の取り直し中もバーが使える。
	await fireEvent(el, new Event('durationchange'));
	await vi.waitFor(() => {
		expect(seekSlider().disabled).toBe(false);
		expect(Number(seekSlider().max)).toBeCloseTo(MEDIA_DURATION_SECONDS, 3);
	});
	expect(gate.indexCalls()).toBe(1);
	media.currentTimeSetter.mockClear();

	// 開き直し(setDocument → videoDisplay の組み立て直し)。`<video>` は据え置き。
	component.reopen();
	await tick();
	await flushTasks();
	expect(videoElement()).toBe(el);

	// 追補b の前段: 据え置かれた <video> にまず縮退値が当たる(精密値は索引待ち)。
	await vi.waitFor(() => {
		expect(lastAssignedCurrentTime(media.currentTimeSetter)).toBeCloseTo(
			initialSeekTime(null),
			6,
		);
	});
	// 索引の取り直しが出ていて、応答はまだ保留中(=「索引が届く前」の状態)。
	await vi.waitFor(() => {
		expect(gate.indexCalls()).toBe(2);
	});
	await flushTasks();
	// 保留中もシークバーは使える(mediaDuration の 10 秒)。
	expect(seekSlider().disabled).toBe(false);
	expect(Number(seekSlider().max)).toBeCloseTo(MEDIA_DURATION_SECONDS, 3);

	return { video: el, media, index: index!, gate };
}

/** シークバーで `seconds` へ動かして離す(input → change)。 */
async function scrubSeekBarTo(seconds: number): Promise<void> {
	const value = String(seconds);
	await fireEvent.input(seekSlider(), { target: { value } });
	await fireEvent.change(seekSlider(), { target: { value } });
}

describe('VideoViewer 配線(要件#37 追補e・backlog 248: 開き直しの後に触ったら初期シークを割り込ませない)', () => {
	it('AC-37-追e (1): 開き直しの後・索引が届く前にシークバーで 3 秒へシークして離すと、遅れて届いた索引で currentTime が先頭の精密値へ書き換えられず、シークバーも 3 秒付近のまま', async () => {
		const { video, media, index, gate } = await mountReopenAndHoldIndex();

		// ユーザーのシーク(索引はまだ届いていない=縮退の経路で 3 秒ちょうどへ)。
		await scrubSeekBarTo(USER_SEEK_SECONDS);
		await vi.waitFor(() => {
			expect(video.currentTime).toBeCloseTo(USER_SEEK_SECONDS, 3);
			expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(USER_SEEK_SECONDS, 3);
		});
		await flushTasks();
		// まだ索引は届いていない(フレーム番号の表示が無い=索引 null の縮退のまま)。
		expect(frameText()).toBeNull();
		const assignmentsBeforeIndex = media.currentTimeSetter.mock.calls.length;

		// 保留していた索引を届ける。届いたことは「索引があるときだけ出る」フレーム番号の
		// 表示で陽性に確かめる(時間表示 `00:00:03.000` は索引の有無で同じ文字列なので
		// 根拠にならない)。3 秒 × 30fps = 90 フレーム目。
		gate.resolveSecond();
		await vi.waitFor(() => {
			expect(frameText()).toBe(USER_SEEK_FRAME_TEXT);
		});
		// 索引到着後の effect(寄せ直し)が走り切るまで流す。
		await tick();
		await flushTasks();

		// 本題(契約 追補e): 索引が届いても寄せ直し(applyInitialSeek)は割り込まない。
		// 旗を降ろす処理を外すと、ここで initialSeekTime(index) が代入されて赤になる。
		// 索引到着後に `currentTime` へ代入された値の一覧(正常なら空=何も代入されない。
		// 空でなくても、先頭の精密値が含まれていなければ契約は守られている)。
		const assignedAfterIndex = media.currentTimeSetter.mock.calls
			.slice(assignmentsBeforeIndex)
			.map(([value]) => value);
		const rewoundToInitial = assignedAfterIndex.some(
			(value) => Math.abs(value - initialSeekTime(index)) < 1e-6,
		);
		expect(rewoundToInitial, `索引到着後の代入: ${JSON.stringify(assignedAfterIndex)}`).toBe(
			false,
		);
		expect(video.currentTime).toBeCloseTo(USER_SEEK_SECONDS, 2);
		expect(video.currentTime).not.toBeCloseTo(initialSeekTime(index), 6);

		// 表示も 3 秒付近のまま(索引が届いたのでフレーム番号 #90・時間はその提示時刻 3.000)。
		expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(USER_SEEK_SECONDS, 2);
		expect(frameText()).toBe(USER_SEEK_FRAME_TEXT);
		expect(timeText()).toBe('00:00:03.000');
		// 索引の到着でシークバーの範囲は索引の尺のまま(10 秒)で、操作できる。
		expect(seekSlider().disabled).toBe(false);
		expect(Number(seekSlider().max)).toBeCloseTo(10, 3);
		// 停止中の操作なので再生は始めない(要件#39 契約②)。
		expect(media.play).not.toHaveBeenCalled();
		expect(media.isPaused()).toBe(true);
	});

	it('AC-37-追e (2) 陽性対照: 開き直しの後にシークしないまま索引が届くと、currentTime が initialSeekTime(index) に寄せ直される', async () => {
		const { video, media, index, gate } = await mountReopenAndHoldIndex();
		await flushTasks();
		media.currentTimeSetter.mockClear();

		// 触らずに、保留していた索引を届ける。
		gate.resolveSecond();

		// 寄せ直しが働く: 先頭フレームの精密値が代入される(縮退値ではない)。
		await vi.waitFor(() => {
			expect(media.currentTimeSetter).toHaveBeenCalled();
			expect(lastAssignedCurrentTime(media.currentTimeSetter)).toBeCloseTo(
				initialSeekTime(index),
				6,
			);
		});
		expect(video.currentTime).toBeCloseTo(initialSeekTime(index), 6);
		expect(video.currentTime).not.toBeCloseTo(initialSeekTime(null), 6);

		// 表示も先頭(シーク完了の seeked を経て実位置に追従した値)。
		await vi.waitFor(() => {
			expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(initialSeekTime(index), 3);
			expect(timeText()).toBe('00:00:00.000');
		});
		expect(media.play).not.toHaveBeenCalled();
	});
});
