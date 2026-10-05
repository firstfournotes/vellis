/**
 * 要件#37 追補c(backlog 137)=動画の `<video>` を作り直すと消音の状態が要素へ反映されない。
 * 受け入れ基準 AC-37-追c の配線テスト(JSDOM・component プロジェクト)。
 *
 * ## 判定するもの(AC-37-追c)
 * 動画をマウント → 消音ボタン(`Mute`)を押す(要素の `muted` が true・ボタンが `Muted`・
 * `aria-pressed="true"`)→ `src` を別の値に変えて `<video>` を作り直す(要素が別物に
 * なったことも確認)→ **新しい要素の `muted` が true** で、ボタンは `Muted`・
 * `aria-pressed="true"` のまま。消音を解除してから作り直したときは、新しい要素の
 * `muted` が false(ボタンは `Mute`・`aria-pressed="false"`)。
 *
 * ## 契約(追補c)
 * 消音は素材ではなく利用者の設定なので、`{#key src}` で `<video>` が作り直されても
 * 引き継ぐ。`<video muted={audioMuted}>` とし、ボタンの表示(`Muted`・`aria-pressed`)と
 * 要素の `muted` が一致する(要件#50 追補e(2) の `AudioViewer` と同じ形)。
 *
 * ## 再現する経路
 * `src` が別の文字列になると `{#key src}` が `<video>` を作り直す(別の動画を開く・
 * ディスク上の変更で版数が変わる)。ここでは testing-library の `rerender` で `src` を
 * 別の値にする(VideoViewer.wiring.test.ts「src が変わると等倍・先頭へ戻る」と同じ作法)。
 * 同じ `src` の開き直し(追補a・追補b=`<video>` 据え置き)はこのテストの対象外。
 *
 * ## 赤になる理由(実装前)
 * 現状の `<video>` は `muted` を受け取っていない(消音は `toggleMute` が要素の `muted`
 * を直接書き換え、`volumechange` で `audioMuted` に写すだけ)。作り直された新しい要素は
 * 既定の `muted=false` で生まれ、`audioMuted` は true のまま残る ―― つまり「新しい要素の
 * `muted` が true」の判定が false で赤になる(ボタン表示だけは `Muted` のまま=実機で
 * 見えた「表示は消音・音は出る」のずれそのもの)。消音解除のケースは不変の確認で、
 * 実装前後とも緑(契約「消音を解除した状態で作り直したときは新しい要素も消音されない」)。
 *
 * ## スタブ(VideoViewer.wiring.test.ts の家風)
 * - $lib/ipc の invoke → null(get_video_frame_index → 索引なしの縮退)
 * - ResizeObserver 即発火版・clientWidth=320・getContext null・fetch 失敗
 * - jsdom の HTMLMediaElement は `muted` を IDL プロパティとして持ち、変化時に
 *   `volumechange` を発火する(jsdom 29)。Svelte 5 は `muted={…}` をプロパティ代入で
 *   反映する(NON_STATIC_PROPERTIES)ので、実装後は新要素の `muted` が読める。
 *   `volumechange` は jsdom 版差への保険として明示的にも流す(AudioViewer のテストと同じ)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import VideoViewer from './VideoViewer.svelte';

vi.mock('$lib/ipc', () => ({
	// get_video_frame_index → null(索引なしの縮退)。他コマンドも null で足りる。
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

/** インライン再生対象(mp4 ローカル)の props。videoViewMode → 'inline' になる形。 */
const PROPS = {
	uri: 'file:///Users/a/movies/clip.mp4',
	src: 'vellis-asset://local/Users/a/movies/clip.mp4',
};

/** 別の動画(src が別の文字列=`{#key src}` が `<video>` を作り直す経路)。 */
const NEXT_PROPS = {
	uri: 'file:///Users/a/movies/other.mp4',
	src: 'vellis-asset://local/Users/a/movies/other.mp4',
};

/** 積み残しの非同期を流しきる(macrotask 2周)。 */
async function flushTasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

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
	// jsdom の clientWidth は常に 0(レイアウトなし)。bind:clientWidth に正の幅を見せる。
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

/** inline でマウントし、`<video>` と消音ボタン(`Mute`)が居る状態まで進める。 */
async function renderInline() {
	const utils = render(VideoViewer, { props: PROPS });
	const video = videoElement();
	expect(video, 'inline の <video> がマウントで居ること').not.toBeNull();
	const el = video as HTMLVideoElement;
	expect(el.muted, 'マウント直後は消音されていないこと(契約②=自動再生も音も無し)').toBe(false);
	expect(screen.getByRole('button', { name: 'Mute' }).getAttribute('aria-pressed')).toBe('false');
	await flushTasks();
	return { ...utils, video: el };
}

/** 消音ボタンを押して「要素 muted=true・ボタン Muted・aria-pressed=true」まで進める。 */
async function muteViaButton(video: HTMLVideoElement): Promise<void> {
	await fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
	// jsdom が volumechange を自動発火するとは限らないので明示的に流す(表示の同期)。
	await fireEvent(video, new Event('volumechange'));
	expect(video.muted, '消音ボタンで要素の muted が true になること').toBe(true);
	expect(
		screen.getByRole('button', { name: 'Muted' }).getAttribute('aria-pressed'),
		'消音中はボタンが Muted・aria-pressed="true" であること',
	).toBe('true');
}

describe('VideoViewer 配線(要件#37 追補c・backlog 137: <video> を作り直しても消音を引き継ぐ)', () => {
	it('AC-37-追c: 消音 → src 変更で <video> を作り直し → 新要素の muted が true・ボタンは Muted のまま', async () => {
		const { rerender, video } = await renderInline();

		await muteViaButton(video);

		// 別の動画へ(src が別の文字列)= `{#key src}` で `<video>` が作り直される。
		await rerender(NEXT_PROPS);
		await flushTasks();

		const next = videoElement();
		expect(next, '作り直し後も <video> が居ること').not.toBeNull();
		expect(next, '{#key src} で要素は作り直されること(別物の要素)').not.toBe(video);
		expect(next?.getAttribute('src'), '新しい要素は新しい src を持つこと').toBe(NEXT_PROPS.src);

		expect(
			next?.muted,
			'新しい <video> 要素にも消音状態が反映されること(muted={audioMuted})',
		).toBe(true);
		expect(
			screen.getByRole('button', { name: 'Muted' }).getAttribute('aria-pressed'),
			'ボタンの消音表示(Muted・aria-pressed="true")は src 切替をまたいで維持されること',
		).toBe('true');
		expect(
			screen.queryByRole('button', { name: 'Mute' }),
			'「Mute」(未消音)の表示に戻っていないこと',
		).toBeNull();
	});

	it('AC-37-追c: 消音を解除してから src 変更で作り直し → 新要素の muted が false・ボタンは Mute(不変の確認)', async () => {
		const { rerender, video } = await renderInline();

		await muteViaButton(video);

		// 消音を解除(ボタンは「Muted」=押すと Unmute)。
		await fireEvent.click(screen.getByRole('button', { name: 'Muted' }));
		await fireEvent(video, new Event('volumechange'));
		expect(video.muted, '解除で要素の muted が false に戻ること').toBe(false);
		expect(
			screen.getByRole('button', { name: 'Mute' }).getAttribute('aria-pressed'),
			'解除後はボタンが Mute・aria-pressed="false" であること',
		).toBe('false');

		await rerender(NEXT_PROPS);
		await flushTasks();

		const next = videoElement();
		expect(next, '作り直し後も <video> が居ること').not.toBeNull();
		expect(next, '{#key src} で要素は作り直されること(別物の要素)').not.toBe(video);

		expect(
			next?.muted,
			'消音を解除した状態で作り直した新しい要素は消音されないこと',
		).toBe(false);
		expect(
			screen.getByRole('button', { name: 'Mute' }).getAttribute('aria-pressed'),
			'ボタンも Mute・aria-pressed="false" のままであること',
		).toBe('false');
		expect(screen.queryByRole('button', { name: 'Muted' })).toBeNull();
	});
});
