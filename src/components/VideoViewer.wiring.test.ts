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

/**
 * 要件#47(音声波形帯の時間軸ズーム)の配線スモーク。
 *
 * ## 確定契約(implementer はこれに従う)
 * - 操作部(シークバーの並び)に3ボタン: aria-label「波形を拡大」(×2)・
 *   「波形を縮小」(÷2)・「波形を等倍に戻す」(=1)(契約④)
 * - シークバーへ重ねる窓指標は `.seek-window-indicator`。位置は inline style の
 *   left/width(px)で持つ。**倍率 1 では出さない**(waveformWindowIndicator が
 *   null=契約③)ので、指標の有無が「拡大中かどうか」の DOM 観測点になる
 * - 帯(`.video-waveform`)上の Option(alt)+wheel で倍率変更(追補a=2026-09-03 由谷指示。
 *   ctrl+wheel は macOS の画面拡大と衝突するため倍率を変えない)・Shift+wheel(または deltaX)で
 *   窓の横スクロール(契約④)。幅は bind:clientWidth の帯幅を使う
 *   (getBoundingClientRect は jsdom で常に 0 のため、実装が rect 幅に依存すると
 *   ここが赤のまま残る=幅の供給源も契約)
 * - 倍率変更で描画 effect が走り直す(canvas 据え置きで窓の内容を描き替える=契約⑨。
 *   観測は既存作法どおり getContext('2d') の呼び出し回数)
 * - src が変われば等倍・先頭へ戻る(契約①=要件#44 のリセット effect に相乗り)
 *
 * jsdom の `<video>` は duration を持たない(NaN)ので、duration getter を被せて
 * durationchange を dispatch し、barDuration=60 秒の「ズーム可能な状態」を作る
 * (readyState/audioTracks を被せる既存ケースと同じ作法)。
 */
describe('VideoViewer 配線スモーク(要件#47 波形の時間軸ズーム)', () => {
	/** ズーム可能な状態(尺 60 秒)を作ってマウントする。 */
	async function renderZoomable() {
		const utils = render(VideoViewer, { props: PROPS });
		const video = document.querySelector('video.video') as HTMLVideoElement;
		expect(video).not.toBeNull();
		Object.defineProperty(video, 'duration', { configurable: true, get: () => 60 });
		await fireEvent(video, new Event('durationchange'));
		return { ...utils, video };
	}

	const indicator = () =>
		document.querySelector('.seek-window-indicator') as HTMLElement | null;

	it('「＋」「−」「等倍」の3ボタンが出る・等倍では窓指標が無い(契約③④)', async () => {
		await renderZoomable();

		expect(screen.getByRole('button', { name: '波形を拡大' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '波形を縮小' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '波形を等倍に戻す' })).toBeTruthy();

		// 倍率 1 では指標を出さない(契約③=waveformWindowIndicator が null)。
		expect(indicator()).toBeNull();
	});

	it('「＋」で倍率が上がり(指標が出る)描画 effect が走り直す・「等倍」で戻る(契約④⑨)', async () => {
		await renderZoomable();

		// マウント時の描画が済んでから、ズームによる描き替えの「増分」を数える。
		await vi.waitFor(() => {
			expect(getContextSpy).toHaveBeenCalledWith('2d');
		});
		const before = getContextSpy.mock.calls.length;

		await fireEvent.click(screen.getByRole('button', { name: '波形を拡大' }));
		await vi.waitFor(() => {
			expect(indicator()).not.toBeNull();
		});
		// 倍率変更は canvas の描き替えを伴う(据え置き canvas に窓の内容を描く=契約⑨)。
		await vi.waitFor(() => {
			expect(getContextSpy.mock.calls.length).toBeGreaterThan(before);
		});

		await fireEvent.click(screen.getByRole('button', { name: '波形を等倍に戻す' }));
		await vi.waitFor(() => {
			expect(indicator()).toBeNull();
		});
	});

	it('帯上の Option+wheel で拡大・Shift+wheel で窓が横に動く(契約④・追補a)', async () => {
		await renderZoomable();
		const band = document.querySelector('.video-waveform') as HTMLElement;
		expect(band).not.toBeNull();

		// ctrl+wheel は倍率を変えない(画面拡大に譲る=追補a)。
		await fireEvent.wheel(band, { ctrlKey: true, deltaY: -240, deltaMode: 0 });
		expect(indicator()).toBeNull();

		// Option(alt)+wheel の上回し(deltaY<0)=拡大。−240px は指数写像でちょうど2倍。
		await fireEvent.wheel(band, { altKey: true, deltaY: -240, deltaMode: 0 });
		await vi.waitFor(() => {
			expect(indicator()).not.toBeNull();
		});
		const leftBefore = Number.parseFloat(indicator()?.style.left ?? '0');

		// Shift+wheel(縦成分を横に読み替え)=窓を後ろへ送る → 指標の left が増える。
		await fireEvent.wheel(band, { shiftKey: true, deltaY: 120, deltaMode: 0 });
		await vi.waitFor(() => {
			expect(Number.parseFloat(indicator()?.style.left ?? '0')).toBeGreaterThan(leftBefore);
		});
	});

	it('src が変わると等倍・先頭へ戻る(指標が消える=契約①)', async () => {
		const { rerender } = await renderZoomable();

		await fireEvent.click(screen.getByRole('button', { name: '波形を拡大' }));
		await vi.waitFor(() => {
			expect(indicator()).not.toBeNull();
		});

		// 別素材へ差し替え(要件#44 契約③のリセット effect に相乗り=契約①)。
		await rerender({
			uri: 'file:///Users/a/movies/other.webm',
			src: 'vellis-asset://local/Users/a/movies/other.webm',
		});
		await vi.waitFor(() => {
			expect(indicator()).toBeNull();
		});
	});
});

/**
 * backlog 141: 動画が停止中はシーク位置を変更できない(要件#37 契約③の抜け)。
 *
 * 表示位置の駆動 $effect は、`requestVideoFrameCallback`(rVFC)を持つ環境では
 * **rVFC だけ**で `position` を進める。rVFC は新しいフレームが提示されたときに
 * しか鳴らないので、停止中にシークしても `position` が動かず、スライダーを
 * 離すと `onScrubCommit` が `scrubbing = null` にして古い `position` へ戻る
 * (=「動かない」)。rVFC の無い環境向けフォールバックには `seeked` リスナが
 * あるのに、rVFC 経路には無いのが抜け。
 *
 * ## 判定するもの
 * - **rVFC を持つ環境**(prototype に生やして再現)で、停止中に `currentTime` を
 *   変えて `seeked` を発火させたら `position`(シークバー value = barPosition)が
 *   追従すること。**rVFC は一度も鳴らさない**(停止中なので鳴らないのが正)
 * - rVFC の提示時刻でも従来どおり追従すること(seeked の追加が rVFC 経路の
 *   **置き換え**にならないための回帰ガード。既存挙動の固定なので実装前から緑)
 *
 * ## スタブの設計(本ファイル既存の家風)
 * - rVFC/cancel: prototype へ configurable に定義し afterEach で外す。登録された
 *   コールバックは配列に控えるだけで、テストから明示的に呼ばない限り鳴らない
 *   =「停止中」の再現。**render 前に定義する**こと(effect は最初の実行で
 *   rVFC の有無を見て経路を選ぶため、後付けだと fallback 経路に落ちて
 *   誤って緑になる)。登録が起きたこと自体も判定し、経路の取り違えを塞ぐ
 * - duration / currentTime: jsdom の <video> は実装を持たないので getter を
 *   被せる(readyState/audioTracks を被せる既存ケースと同じ作法)
 */
describe('VideoViewer 配線スモーク(backlog 141: 停止中シークの位置追従・要件#37 契約③)', () => {
	let rvfcCallbacks: Array<(now: number, metadata: { mediaTime: number }) => void>;

	beforeEach(() => {
		rvfcCallbacks = [];
		Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
			configurable: true,
			value: (callback: (now: number, metadata: { mediaTime: number }) => void) => {
				rvfcCallbacks.push(callback);
				return rvfcCallbacks.length;
			},
		});
		Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
			configurable: true,
			value: () => {},
		});
	});

	afterEach(() => {
		// 先にアンマウントを済ませる ―― effect の teardown が cancelVideoFrameCallback を
		// 呼ぶので、prototype から外すのはその後(外側 afterEach の cleanup より前に
		// この内側 afterEach が走るため、ここで自前に呼ぶ。cleanup は冪等)。
		cleanup();
		Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
		Reflect.deleteProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
	});

	/** 尺 60 秒・rVFC 経路が選ばれた状態でマウントする。 */
	async function renderWithRvfc() {
		render(VideoViewer, { props: PROPS });
		const video = document.querySelector('video.video') as HTMLVideoElement;
		expect(video).not.toBeNull();
		Object.defineProperty(video, 'duration', { configurable: true, get: () => 60 });
		await fireEvent(video, new Event('durationchange'));
		// 表示位置の effect が rVFC 経路を選んだことの確認 ―― ここが 0 のままなら
		// fallback(timeupdate/seeked)経路に落ちていて、以降の判定が意味を失う。
		await vi.waitFor(() => {
			expect(rvfcCallbacks.length).toBeGreaterThan(0);
		});
		return video;
	}

	const seekSlider = () => document.querySelector('input.video-seek') as HTMLInputElement;

	it('停止中の seeked で position(シークバー)が追従する ―― rVFC は鳴らさない', async () => {
		const video = await renderWithRvfc();
		// 停止中のシーク: currentTime だけが動き、新フレームの提示(rVFC)は起きない。
		Object.defineProperty(video, 'currentTime', {
			configurable: true,
			get: () => 12.5,
			set: () => {},
		});

		await fireEvent(video, new Event('seeked'));

		// rVFC 経路に seeked の読み直しが無い現状では position=0 のまま
		// =ここがタイムアウトで落ちる(backlog 141 の症状そのもの)。
		await vi.waitFor(() => {
			expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(12.5, 3);
		});
	});

	it('rVFC の提示時刻でも従来どおり追従する(seeked 追加で rVFC 経路を置き換えない=回帰ガード)', async () => {
		await renderWithRvfc();

		rvfcCallbacks[rvfcCallbacks.length - 1](0, { mediaTime: 3.25 });

		await vi.waitFor(() => {
			expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(3.25, 3);
		});
	});
});
