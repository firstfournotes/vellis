/**
 * 要件#37 追補a(backlog 224)=同じ webm をもう一度開くとシークバーが効かなくなる。
 * 受け入れ基準 AC-37-追a の配線テスト(JSDOM・component プロジェクト)。
 *
 * ## 判定するもの(AC-37-追a)
 * フレーム索引が取れない(null)webm の VideoViewer をマウントし、`<video>` の
 * `duration` を有限値 12.5 にして `durationchange` を出すと、シークバーが操作でき
 * (`disabled` でない)尺(`max`)が 12.5 になる。その後、**アプリが同じファイルを
 * 開き直したときと同じ形**で読み込み直しを起こす(`<video>` は作り直されず
 * `durationchange` は再発火しない)と、シークバーは引き続き操作でき、尺は 12.5 のまま。
 *
 * ## 再現する経路(src/routes/+page.svelte の実態・2026-10-01 調査)
 * Explorer で同じファイルをもう一度クリックすると `openForDisplay → windowState.setDocument`
 * が **同じ uri の新しいオブジェクト**を `currentDocument` に入れる。`videoDisplay`
 * ($derived.by)はそれを見て `{ uri, src }` を組み立て直す ―― 文字列は同じで
 * オブジェクトだけが新しい。VideoViewer へは `src={videoDisplay.src}`(メンバー式)で
 * 渡るので、子の prop getter は `videoDisplay` を読み、子の読み込み直し
 * `$effect(() => { void src; … mediaDuration = 0; … })` が再実行される。
 * 一方 `{#key src}` は文字列を比べるので `<video>` は据え置き=`durationchange` は
 * もう来ず、`mediaDuration` が 0 のまま残る(`barDuration = frameIndex?.duration ??
 * mediaDuration` で、索引の無い webm は 0 → `disabled`・`max=0`)。
 *
 * この経路を `__fixtures__/VideoViewerReopenHost.svelte` が最小で写す(`doc` =
 * currentDocument・`display` = videoDisplay・`reopen()` = setDocument)。
 * testing-library の `rerender` は使わない ―― あちらも内部の `$state.raw` を新しい
 * オブジェクトに差し替えるので今は同じ結果になるが、ライブラリ内部の都合に寄りかかると
 * 将来「値が同じなら通知しない」に変わった途端にテストが空振り(無条件で緑)になる。
 *
 * ## 不変の確認(契約 追補a 3点目)
 * 「開き直しで再生位置を初期化する既存の振る舞いは不変」なので、開き直し前に
 * 位置を 7.25 へ動かしておき、開き直し後にシークバーの値が 0 へ戻ることも見る。
 * これは同時に「読み込み直しの effect が本当に再実行された」証拠になる(再実行されて
 * いなければ値は 7.25 のまま=経路の取り違え)。
 *
 * ## スタブ(VideoViewer.wiring.test.ts の家風)
 * - $lib/ipc の invoke → null(get_video_frame_index → 索引なし=webm の縮退)
 * - ResizeObserver 即発火版・clientWidth=320・getContext null・fetch 失敗
 *   (webm の波形解析は fetch 経路。失敗は unreadable 縮退で、シークバーには関係しない)
 * - duration / currentTime は jsdom の `<video>` に実装が無いので getter を被せる
 * - rVFC は定義しない(fallback 経路=`seeked` で位置を読む)
 *
 * 想定: 実装前は開き直し後に `disabled`・`max="0"` となり、最後の waitFor がタイムアウトで赤。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import VideoViewerReopenHost from './__fixtures__/VideoViewerReopenHost.svelte';
import { invoke } from '$lib/ipc';

vi.mock('$lib/ipc', () => ({
	// get_video_frame_index → null(索引なしの縮退=webm)。他コマンドも null で足りる。
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openPath: vi.fn(async () => undefined),
}));

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

/** 積み残しの非同期を流しきる(macrotask 2周)。 */
async function flushTasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const seekSlider = () => document.querySelector('input.video-seek') as HTMLInputElement;
const videoElement = () => document.querySelector('video.video') as HTMLVideoElement | null;

beforeEach(() => {
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
 * 索引なし webm をホスト経由でマウントし、`<video>` に尺 12.5 を申告させて
 * シークバーが操作できる状態(AC の前段)まで進める。
 */
async function mountWebmWithDuration() {
	vi.mocked(invoke).mockClear();
	const { component } = render(VideoViewerReopenHost, { props: WEBM_PROPS });

	const video = videoElement();
	expect(video).not.toBeNull();
	const el = video as HTMLVideoElement;

	// 索引の問い合わせが起きて null 縮退になっていること(frameIndex が尺を補わない前提)。
	await vi.waitFor(() => {
		expect(
			vi.mocked(invoke).mock.calls.some(([command]) => command === 'get_video_frame_index'),
		).toBe(true);
	});
	await flushTasks();

	// jsdom の <video> は duration を持たない(NaN)。有限値 12.5 を被せて durationchange を出す。
	Object.defineProperty(el, 'duration', { configurable: true, get: () => 12.5 });
	await fireEvent(el, new Event('durationchange'));

	await vi.waitFor(() => {
		expect(seekSlider().disabled).toBe(false);
		expect(Number(seekSlider().max)).toBeCloseTo(12.5, 3);
	});

	return { component, video: el };
}

describe('VideoViewer 配線(要件#37 追補a・backlog 224: 同じ webm の開き直しでシークバーが残る)', () => {
	it('AC-37-追a: 索引なし webm を同じファイルとして開き直しても、シークバーは操作でき尺は 12.5 のまま', async () => {
		const { component, video } = await mountWebmWithDuration();

		// 開き直し前に位置を 7.25 へ(fallback 経路: seeked → currentTime を読む)。
		// 後段の「位置が 0 へ戻る」=読み込み直しが本当に走った証拠に使う。
		Object.defineProperty(video, 'currentTime', {
			configurable: true,
			get: () => 7.25,
			set: () => {},
		});
		await fireEvent(video, new Event('seeked'));
		await vi.waitFor(() => {
			expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(7.25, 3);
		});

		// アプリが同じファイルを開き直したときと同じ形(setDocument → videoDisplay の
		// 組み立て直し)。durationchange は出さない(実機でも来ない)。
		component.reopen();
		await tick();
		await flushTasks();

		// 経路の確認①: `{#key src}` は同じ文字列なので <video> は据え置き。
		expect(videoElement()).toBe(video);
		// 経路の確認②: 読み込み直しの初期化は走っている(再生位置は先頭へ=契約 追補a 不変)。
		await vi.waitFor(() => {
			expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(0, 3);
		});

		// 本題(AC-37-追a): 尺が 0 のまま残らず、シークバーは操作できる・max は総尺 12.5。
		// 実装前は mediaDuration=0 のまま durationchange が来ないので disabled・max="0"
		// =ここがタイムアウトで赤(backlog 224 の症状そのもの)。
		await vi.waitFor(() => {
			expect(seekSlider().disabled).toBe(false);
			expect(Number(seekSlider().max)).toBeCloseTo(12.5, 3);
		});
	});
});
