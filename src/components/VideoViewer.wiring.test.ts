/**
 * VideoViewer のコンポーネント配線スモーク(要件#41 第2周・要件#44 で常時表示へ改訂)。
 *
 * ## 判定するもの
 * 要件#44 契約①②の配線を機械判定に載せる:
 * - **常時表示(契約①)**: ツールバーの「波形」トグルボタンと waveformOpen 状態は
 *   廃止され、波形帯・リサイズハンドル・canvas はマウントだけで DOM に居る
 *   (クリック不要)。トグルボタンが存在しないことも判定する
 * - **canvas 到達(要件#41 第2周から存続)**: 描画 $effect が canvas に到達して
 *   `getContext('2d')` が呼ばれる。到達には canvas の `bind:this={waveformCanvas}` が
 *   生きていることが必要 ―― 純関数だけの acceptance では捕まえられなかった
 *   「解析は ready・帯は無地」の配線バグ(2026-09-01 実機)の再発防止。
 *   常時表示化に伴い、トグルを押す行は消えてマウント直後の判定になった
 * - **即解析(契約②)**: 解析は src 設定(+inline)で自動起動する。ただし音声
 *   トラック事前判定(detectAudioTrack)はメタデータ到達後 ―― effect の依存に
 *   loadedmetadata を入れず、effect 内の非同期フローで await するのが契約なので、
 *   「メタデータ到達前は解析の IO が走らない・loadedmetadata 発火後に走る」の
 *   前後で判定する。**要件#45 契約①の改訂**: mp4 の解析 IO は fetch(全量取得)
 *   ではなく Rust 抽出コマンド(extract_waveform_audio の invoke)になったため、
 *   観測点は invoke のコマンド名。fetch は「呼ばれないこと」(webm 用経路の非使用=
 *   全量 fetch 廃止)の観測に回る= 2026-09-02 オーケストレーター承認の要件側更新
 *
 * 旧「aria-pressed 往復」テストはトグルの廃止で意味ごと消滅(要件#44 契約④=
 * 2026-09-02 由谷承認の要件側判断)。
 *
 * ## スタブの設計
 * - ResizeObserver: jsdom に無い。observe された要素を microtask で1回通知する
 *   即発火版(Svelte 5 の bind:clientWidth はこの通知を機に `el.clientWidth` を
 *   読み直す=通知エントリの中身は見ない)
 * - clientWidth: jsdom はレイアウトを持たず常に 0。HTMLElement.prototype に
 *   getter を被せて正の幅を返す(幅 0 のままだと描画 effect が**正しく**早期
 *   return するため、bind:this バグと区別がつかない)
 * - getContext: spy(null 返し)。drawWaveform は ctx null で安全に抜ける設計
 *   なので、**呼ばれたことだけ**を観測する(2D API の実装は要らない)
 * - fetch: spy(失敗させる=呼ばれても unreadable 縮退へ)。要件#45 で mp4 は
 *   extract 経路になったため、mp4 のテストでは**呼ばれないこと**(全量 fetch 廃止)を
 *   観測する(VideoViewer で fetch を呼ぶのは webm の波形解析だけ)
 * - loadedmetadata: jsdom の `<video>` はメタデータを読まないので、テストから
 *   dispatch して「到達」を作る(readyState は 0 のままなので detectAudioTrack は
 *   null 返し=解析はその先の縮退分岐に委ねられる。契約⑤の fail-open と同じ読み)
 * - $lib/ipc / @tauri-apps/plugin-opener: モジュールモック(Tauri 実体なしで
 *   loadFrameIndex → null 縮退・外部オープンは不使用)
 *
 * 波形の見た目そのもの(レーンの絵・色)と「開いた直後の解析中表示」の体感は
 * 人間ゲート。ここは配線の生存だけを見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import VideoViewer from './VideoViewer.svelte';
// モック済みの invoke(下の vi.mock)を観測用に取り出す(要件#45=mp4 の解析 IO)。
import { invoke } from '$lib/ipc';

vi.mock('$lib/ipc', () => ({
	// get_video_frame_index → null(索引なしの縮退)。他コマンドも null で足りる。
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openPath: vi.fn(async () => undefined),
}));

/**
 * observe された要素を microtask で1回だけ通知する即発火 ResizeObserver。
 * Svelte 5 の bind:clientWidth はこの通知を受けて要素の実プロパティを読む。
 */
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

/**
 * 積み残しの非同期を流しきる(macrotask 1周=そこまでに積まれた microtask 連鎖ごと)。
 * 「まだ呼ばれていない」側の判定に使うので、待ちすぎより流しきりを優先して2周回す。
 */
async function flushTasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

let getContextSpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
	fetchSpy = vi.fn(async () => {
		throw new TypeError('Failed to fetch');
	});
	vi.stubGlobal('fetch', fetchSpy);
	getContextSpy = vi
		.spyOn(HTMLCanvasElement.prototype, 'getContext')
		.mockImplementation(() => null) as unknown as ReturnType<typeof vi.fn>;
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

describe('VideoViewer 配線スモーク(要件#41 第2周・要件#44 常時表示)', () => {
	it('マウントで波形帯とリサイズハンドルが常時出る(トグルボタンは無い=要件#44 契約①)', () => {
		render(VideoViewer, { props: PROPS });

		// トグルは意味ごと廃止 ―― ボタンが残っていたら常時表示になっていない。
		expect(screen.queryByRole('button', { name: '波形' })).toBeNull();

		// 帯・上端ハンドル・canvas はクリックなしで DOM に居る(要件#42 のハンドルも常時)。
		expect(document.querySelector('.video-waveform')).not.toBeNull();
		expect(document.querySelector('.waveform-divider')).not.toBeNull();
		expect(document.querySelector('canvas.waveform-canvas')).not.toBeNull();
	});

	it('マウントだけで描画 effect が canvas に到達する(bind:this の生存証明)', async () => {
		render(VideoViewer, { props: PROPS });

		// bind:clientWidth(ResizeObserver 経由)→ 幅確定 → 描画 effect と microtask を
		// 数段またぐため、到達を待って判定する。canvas が常時 DOM に居ない・bind:this が
		// 無い、のどちらでも getContext は一度も呼ばれない=ここがタイムアウトで落ちる。
		await vi.waitFor(() => {
			expect(getContextSpy).toHaveBeenCalledWith('2d');
		});
	});

	it('解析は src 設定で自動起動し、メタデータ到達を待ってから走る(要件#44 契約②・要件#45 契約①=mp4 は extract)', async () => {
		// mp4 の解析 IO は Rust 抽出コマンド(要件#45 契約①)。invoke はフレーム索引
		// (get_video_frame_index)にも使われるため、観測はコマンド名で絞る。
		// 呼び出し履歴はテスト間で持ち越されるので、この試験の分だけ数える。
		const extractCalls = () =>
			vi.mocked(invoke).mock.calls.filter(([command]) => command === 'extract_waveform_audio');
		vi.mocked(invoke).mockClear();

		render(VideoViewer, { props: PROPS });

		// メタデータ到達前は解析の IO(抽出 invoke)が走らない ―― detectAudioTrack は
		// loadedmetadata を await してから、が契約②。jsdom の <video> は自分では
		// メタデータを読まないので、この時点の抽出呼び出しはフライング起動の証拠になる。
		await flushTasks();
		expect(extractCalls()).toHaveLength(0);

		const video = document.querySelector('video.video');
		expect(video).not.toBeNull();
		await fireEvent(video as HTMLVideoElement, new Event('loadedmetadata'));

		// 到達後はユーザー操作なしで解析が起動する(mp4=extract 経路=要件#45 契約①。
		// モックの invoke は null を返し unreadable 縮退に落ちるのは想定内 ――
		// 見るのは起動の事実だけ)。fetch(webm 用経路)が呼ばれないことも固定する
		// =動画全量 fetch の廃止。
		await vi.waitFor(() => {
			expect(extractCalls().length).toBeGreaterThan(0);
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('audioTracks が空でも解析へ進む(WebKit の充填遅延を「音声なし」と誤読しない=backlog 102)', async () => {
		// WebKit(WKWebView)は audioTracks の充填が loadedmetadata より遅れることがある。
		// その瞬間の length 0 を false と読むと、音のある動画がすべて no-audio 縮退になる
		// (2026-09-02 実機)。ここでは「メタデータ到達済み・audioTracks は空」を作り、
		// 事前判定がスキップせず抽出(extract invoke)へ進むことを固定する。
		const extractCalls = () =>
			vi.mocked(invoke).mock.calls.filter(([command]) => command === 'extract_waveform_audio');
		vi.mocked(invoke).mockClear();

		render(VideoViewer, { props: PROPS });

		const video = document.querySelector('video.video') as HTMLVideoElement;
		expect(video).not.toBeNull();
		// jsdom の readyState は常に 0。HAVE_METADATA 済み+空の audioTracks を要素に被せ、
		// detectAudioTrack が「充填前の 0」を見る実機の形を再現する。
		Object.defineProperty(video, 'readyState', { configurable: true, get: () => 1 });
		Object.defineProperty(video, 'audioTracks', { configurable: true, get: () => ({ length: 0 }) });
		await fireEvent(video, new Event('loadedmetadata'));

		// 空の audioTracks でスキップせず、解析(抽出)が起動するのが正 ―― no-audio の
		// 最終判定は抽出コマンドの応答に委ねられる(契約⑤)。
		await vi.waitFor(() => {
			expect(extractCalls().length).toBeGreaterThan(0);
		});
	});
});
