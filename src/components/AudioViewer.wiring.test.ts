/**
 * AudioViewer のコンポーネント配線スモーク(要件#50 1周目=契約③⑨⑩)。
 *
 * ## 判定するもの(1周目)
 * - **再生の1経路(契約③)**: `<audio>` が `vellis-asset:` src で**1つだけ**出る・
 *   ネイティブ `controls` を出さない(トランスポートは自前=波形帯とシークバーの
 *   横軸一致を保つため)
 * - **トランスポートの存在(契約③⑨)**: 再生/停止ボタン・シークバー・時刻表示・
 *   ミュートが DOM に居る(VideoViewer と同じ見た目の自前バー)
 * - **キーボード操作(契約⑩)**: Space で再生/停止・**←→ で ±5 秒・Shift+←→ で
 *   ±1 秒**(音声にフレームは無いので要件#37 のコマ送りを置き換える)
 * - **remote プレースホルダ(契約②)**: ssh:// では `<audio>` を出さず
 *   プレースホルダを出す(導線なし=要件#19 の前例)
 * - **再生ヘッドの rAF 駆動(契約④)**: `requestVideoFrameCallback` は
 *   `HTMLAudioElement` に無いので、再生中は `requestAnimationFrame` で
 *   `currentTime` を読む。rAF をモックしてコールバック1回で時刻表示へ
 *   反映されることを確認する
 *
 * ## 周回分割
 * - 波形帯・canvas 到達・L/R レーン・ズーム3ボタン・Option/Shift ホイール・
 *   クリックシーク・縮退文言・帯の高さは**2周目**=本ファイル後半の
 *   「AudioViewer 配線スモーク(要件#50 2周目)」describe が判定する
 *   (確定契約=セレクタと観測点はその describe 直前のコメントに固定)
 * - wav の Rust 経路(契約⑯)は3周目。2周目の波形テストは fetch 経路(mp3)で行う
 *   (wav は経路の実体が3周目まで無く、縮退表示になるため)
 *
 * ## 確定契約(implementer はこれに従う)
 * - **新規 `src/components/AudioViewer.svelte`**(`VideoViewer` に音声モードを足す案は
 *   不採用=契約⑨)。props は `{ uri, src }`(VideoViewer と同型)。表示形態は
 *   `audioViewMode(uri)`($lib/audio-viewing)で内部導出する
 * - キーボードの受け口はフォーカス可能な `role="application"` のペイン
 *   (VideoViewer の `.video-pane` と同じ整理)。Space(key=' ')で再生/停止、
 *   ArrowRight/ArrowLeft で `currentTime` へ ±5 秒、Shift 併用で ±1 秒
 * - DOM の観測点(本テストが固定するセレクタ):
 *   - `<audio>`(inline のとき1つ・`controls` 属性なし・src= `vellis-asset:` URI)
 *   - 再生/停止ボタン=テキスト「再生」⇄「停止」・ミュート=「消音」(aria-pressed)
 *     (VideoViewer の同名ボタンと同じ語)
 *   - シークバー= `input type="range"` / aria-label「再生位置」
 *   - 時刻表示= `.audio-time`(mm:ss を含む表記。83.5 秒なら「1:23」を含む=
 *     `formatMilliTime` の HH:MM:SS.mmm でも m:ss でも可)
 *   - remote プレースホルダ= `.audio-placeholder`(文言は契約⑫=2周目の持ち場なので
 *     ここでは固定しない)
 *
 * ## スタブの設計(VideoViewer.wiring.test.ts の家風)
 * - ResizeObserver: jsdom に無い。即発火版(将来の波形帯の bind:clientWidth 用。
 *   1周目の断言には使わない)
 * - clientWidth: jsdom はレイアウトを持たず常に 0 → 正の幅を返す getter を被せる
 * - getContext: spy(null 返し)。波形帯を先行実装しても安全に抜けられるように
 * - fetch / $lib/ipc: 波形解析(2周目)が先行実装されても Tauri 実体なしで
 *   縮退へ落ちるよう、失敗 spy とモジュールモックを置く
 * - HTMLMediaElement.play / pause: jsdom は実装を持たない(not implemented)ので
 *   prototype を spy に差し替え、「呼ばれたこと」だけを観測する
 * - paused / currentTime / duration: jsdom の <audio> はメディアを読まないので、
 *   要素インスタンスに getter/setter を被せて再生状態を作る
 *
 * 実再生の体感・2時間級ファイルのプローブは人間ゲート。ここは配線の生存だけを見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import AudioViewer from './AudioViewer.svelte';
// クリックシークが吸着(要件#37)を通らないことの観測点(契約⑧)。実体はそのまま、
// nearestFrame だけを spy で包む(呼ばれないことを固定する)。
import { nearestFrame } from '$lib/video-frame';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('$lib/video-frame', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/video-frame')>();
	return { ...actual, nearestFrame: vi.fn(actual.nearestFrame) };
});

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

/** インライン再生対象(ローカル wav)の props。audioViewMode → 'inline' になる形。 */
const PROPS = {
	uri: 'file:///Users/a/music/take.wav',
	src: 'vellis-asset://local/Users/a/music/take.wav',
};

/** ssh リモート(audioViewMode → 'remote')の props。 */
const REMOTE_PROPS = {
	uri: 'ssh://alice@host:22/remote/take.wav',
	src: 'vellis-asset://ssh/alice@host:22/remote/take.wav',
};

/** 積み残しの非同期(microtask 連鎖ごと)を流しきる。 */
async function flushTasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

let playSpy: ReturnType<typeof vi.fn>;
let pauseSpy: ReturnType<typeof vi.fn>;
let rafSpy: ReturnType<typeof vi.fn>;
let rafCallbacks: FrameRequestCallback[];
let getContextSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	// $lib/ipc の invoke に前のケースが仕込んだ応答(mockResolvedValue)を既定へ戻す。
	// afterEach の vi.restoreAllMocks() は vi.mock ファクトリ製の vi.fn の仕込みを
	// 戻さない(Vitest 4)ため、ここで明示的にリセットする(既定=null 応答)。
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockResolvedValue(null);
	vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		}),
	);
	// rAF は自動では回さず、テストがコールバックを手で1回ずつ起こす(契約④の観測点)。
	rafCallbacks = [];
	rafSpy = vi.fn((cb: FrameRequestCallback) => {
		rafCallbacks.push(cb);
		return rafCallbacks.length;
	});
	vi.stubGlobal('requestAnimationFrame', rafSpy);
	vi.stubGlobal(
		'cancelAnimationFrame',
		vi.fn(() => undefined),
	);
	// 描画 effect の到達観測(2周目=契約⑦⑨)。null 返しのまま、呼ばれた事実だけを見る。
	getContextSpy = vi
		.spyOn(HTMLCanvasElement.prototype, 'getContext')
		.mockImplementation(() => null) as unknown as ReturnType<typeof vi.fn>;
	// jsdom の play/pause は not implemented ―― 呼ばれた事実だけを観測する。
	playSpy = vi.fn(async () => undefined);
	pauseSpy = vi.fn(() => undefined);
	vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
		playSpy as unknown as HTMLMediaElement['play'],
	);
	vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
		pauseSpy as unknown as HTMLMediaElement['pause'],
	);
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

/**
 * jsdom の <audio> はメディアを読まないので、再生状態をインスタンスに被せて作る。
 * currentTime は読み書き両対応(←→ の秒送りは「読んで ±n して代入」の観測点)。
 */
function stubMedia(el: HTMLAudioElement, duration = 300) {
	let time = 0;
	let paused = true;
	Object.defineProperty(el, 'currentTime', {
		configurable: true,
		get: () => time,
		set: (value: number) => {
			time = value;
		},
	});
	Object.defineProperty(el, 'paused', { configurable: true, get: () => paused });
	Object.defineProperty(el, 'duration', { configurable: true, get: () => duration });
	return {
		get time() {
			return time;
		},
		set time(value: number) {
			time = value;
		},
		setPaused(value: boolean) {
			paused = value;
		},
	};
}

/** inline でマウントし、メディア状態のスタブと尺(durationchange)まで整える。 */
async function renderInline() {
	const utils = render(AudioViewer, { props: PROPS });
	const audio = document.querySelector('audio') as HTMLAudioElement;
	expect(audio).not.toBeNull();
	const media = stubMedia(audio);
	await fireEvent(audio, new Event('loadedmetadata'));
	await fireEvent(audio, new Event('durationchange'));
	return { ...utils, audio, media };
}

/** キーボードの受け口(role="application" のペイン)。 */
function pane(): HTMLElement {
	const el = document.querySelector('[role="application"]');
	expect(el, 'キーボードの受け口(role="application")が要る').not.toBeNull();
	return el as HTMLElement;
}

describe('AudioViewer 配線スモーク(要件#50 1周目=契約③⑨⑩)', () => {
	it('<audio> が vellis-asset: src で1つだけ出て、controls 属性を出さない(契約③)', () => {
		render(AudioViewer, { props: PROPS });

		const audios = document.querySelectorAll('audio');
		expect(audios).toHaveLength(1);
		const audio = audios[0] as HTMLAudioElement;
		expect(audio.getAttribute('src')).toBe(PROPS.src);
		// ネイティブ controls は出さない=波形帯とシークバーの横軸一致を自前バーで保つ。
		expect(audio.hasAttribute('controls')).toBe(false);
	});

	it('トランスポート(再生/停止・シークバー・時刻表示・ミュート)が DOM に居る(契約③⑨)', async () => {
		await renderInline();

		expect(screen.getByRole('button', { name: '再生' })).toBeTruthy();
		expect(screen.getByRole('slider', { name: '再生位置' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '消音' })).toBeTruthy();
		expect(document.querySelector('.audio-time')).not.toBeNull();
	});

	it('Space で再生/停止をトグルする(契約⑩)', async () => {
		const { media } = await renderInline();
		const target = pane();

		// 停止中に Space → play()。
		await fireEvent.keyDown(target, { key: ' ' });
		expect(playSpy).toHaveBeenCalledTimes(1);
		expect(pauseSpy).not.toHaveBeenCalled();

		// 再生中に Space → pause()。
		media.setPaused(false);
		await fireEvent.keyDown(target, { key: ' ' });
		expect(pauseSpy).toHaveBeenCalledTimes(1);
	});

	it('←→ で currentTime ±5 秒・Shift+←→ で ±1 秒(契約⑩=コマ送りの置き換え)', async () => {
		const { media } = await renderInline();
		const target = pane();
		media.time = 30;

		await fireEvent.keyDown(target, { key: 'ArrowRight' });
		expect(media.time).toBeCloseTo(35);

		await fireEvent.keyDown(target, { key: 'ArrowLeft' });
		expect(media.time).toBeCloseTo(30);

		await fireEvent.keyDown(target, { key: 'ArrowRight', shiftKey: true });
		expect(media.time).toBeCloseTo(31);

		await fireEvent.keyDown(target, { key: 'ArrowLeft', shiftKey: true });
		expect(media.time).toBeCloseTo(30);
	});

	it('ssh リモートは <audio> を出さずプレースホルダを出す(契約②=導線なし)', () => {
		render(AudioViewer, { props: REMOTE_PROPS });

		expect(document.querySelector('audio')).toBeNull();
		expect(document.querySelector('.audio-placeholder')).not.toBeNull();
	});

	it('再生ヘッドは rAF 駆動 ―― play 後のコールバック1回で currentTime が時刻表示へ反映される(契約④)', async () => {
		const { audio, media } = await renderInline();
		const timeText = () => document.querySelector('.audio-time')?.textContent ?? '';

		// 再生開始。83.5 秒(=1分23秒)の位置を rAF が読みに来る。
		media.time = 83.5;
		media.setPaused(false);
		await fireEvent(audio, new Event('play'));
		await flushTasks();

		// 再生開始で rAF ループが張られていること(timeupdate 駆動ではないこと)。
		expect(rafSpy).toHaveBeenCalled();

		// 積まれたコールバックを1回ぶん起こす → currentTime が時刻表示へ届く。
		// (ループの再スケジュールで積み増される分は次回以降=ここでは1回で足りる)
		const pending = rafCallbacks.splice(0);
		for (const cb of pending) cb(performance.now());
		await flushTasks();

		expect(timeText()).toContain('1:23');
	});
});

/**
 * 要件#50 2周目 — 波形帯の配線(契約④⑥⑦⑧⑪⑫⑬)。
 *
 * ## 確定契約(implementer はこれに従う)
 * - 帯は**常時 DOM**(`.audio-stage` の中): `.audio-waveform`(inline style の
 *   height(px)を持つ)+ `canvas.waveform-canvas`。VideoViewer の帯と同じセレクタ
 *   体系を使う(契約⑨=複製で立てる・共通化は backlog): 縮退/解析中の文言=
 *   `.waveform-note`・ステレオの L/R ラベル= `.waveform-lane-label`(style top で
 *   縦位置)・シークバーへ重ねる窓指標= `.seek-window-indicator`(倍率 1 では出さない)
 * - 解析は自動起動で、mp3/m4a は fetch 経路(契約⑤の枝(c))=
 *   `fetch(vellis-asset)` → `OfflineAudioContext(…, 8000).decodeAudioData`。ready の
 *   レーン構成は `waveformLanes` の既存規則(契約⑥=1ch は1レーン・2ch は
 *   L(上)/R(下)の2レーン。L/R ラベルは2レーンのときだけ出す)
 * - ズームは要件#47 の配線をそのまま引く(契約⑦): aria-label「波形を拡大」
 *   「波形を縮小」「波形を等倍に戻す」の3ボタン・帯上の Option(alt)+wheel で
 *   アンカー拡大(ctrl+wheel は倍率を変えない)・Shift+wheel(または deltaX)で
 *   横送り・幅の供給源は bind:clientWidth(`waveform-zoom.ts` は無改変=契約⑤)
 * - クリックシーク(契約⑧): canvas クリックの x(getBoundingClientRect 基準)→
 *   時刻 → `currentTime` へ代入。**`nearestFrame` を呼ばない**(音声にフレーム索引は
 *   存在しない=吸着なしの直行)
 * - 帯の高さ(契約⑪): 既定 **240px**・localStorage の保存キーは
 *   **`vellis.audio-waveform-height`**(動画の `vellis.waveform-height` とは別)。
 *   上下限は `waveform-resize.ts` の既存規則の流用(同ファイルは無改変=契約⑤)。
 *   ここではキー分離の読み込み側を固定し、ドラッグでの保存の実挙動は reviewer 照合
 * - 縮退文言(契約⑫): 音声ビューア用の文言テーブルを別に持つ。ここでは「動画向けの
 *   語(『この動画に音声トラックはありません』)を出さない」ことを固定し、状態網羅は
 *   型(`Record<Exclude<…, 'ready'>, string>` の維持)と reviewer 照合に委ねる
 * - fail-open(契約⑫⑬): 波形の解析が失敗しても `<audio>` とトランスポートは残る
 * - 解析尺(契約④): `analyzeWaveform` の `durationSeconds` が `audioAxisDuration` の
 *   **第2引数**へ流れる= `<audio>` の duration が NaN でもシークバーの軸が解析尺で立つ
 *
 * ## スタブ追加(2周目)
 * - OfflineAudioContext: jsdom に無い。`decodeAudioData` が固定の構造的 AudioBuffer
 *   (`decodedBuffer` 変数)を返す偽物を stubGlobal で置く
 * - fetch: この describe では成功版(小さなバイト列)へ差し替える。既定の失敗版は
 *   fail-open ケースが個別に戻す
 * - localStorage: 各ケースの前に高さ2キーを消す(vite.config の execArgv 設定で使える)
 */
describe('AudioViewer 配線スモーク(要件#50 2周目=波形帯・レーン・ズーム・クリックシーク・高さ・縮退文言)', () => {
	/** 波形は fetch 経路で判定する(wav の経路実体は3周目のため)。 */
	const MP3_PROPS = {
		uri: 'file:///Users/a/music/song.mp3',
		src: 'vellis-asset://local/Users/a/music/song.mp3',
	};

	type FakeAudioBuffer = {
		numberOfChannels: number;
		length: number;
		sampleRate: number;
		getChannelData(channel: number): Float32Array;
	};

	/** decodeAudioData が返す構造的 AudioBuffer。各ケースが差し替える。 */
	let decodedBuffer: FakeAudioBuffer;

	function monoBuffer(length = 8, sampleRate = 8000): FakeAudioBuffer {
		const ch = new Float32Array(length).fill(0.5);
		return { numberOfChannels: 1, length, sampleRate, getChannelData: () => ch };
	}

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

	/** 音声トラックなし相当(decode 結果が空)。analyzeWaveform が no-audio に落とす形。 */
	function emptyBuffer(): FakeAudioBuffer {
		return {
			numberOfChannels: 0,
			length: 0,
			sampleRate: 8000,
			getChannelData: () => new Float32Array(0),
		};
	}

	beforeEach(() => {
		decodedBuffer = monoBuffer();
		// 解析の入口(fetch)は成功させる(ファイル共通の失敗版を上書き)。
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
		// jsdom に OfflineAudioContext は無い。decode だけを偽物で受ける。
		vi.stubGlobal(
			'OfflineAudioContext',
			class {
				constructor(_channels: number, _length: number, _sampleRate: number) {}
				async decodeAudioData(_bytes: ArrayBuffer): Promise<FakeAudioBuffer> {
					return decodedBuffer;
				}
			},
		);
		try {
			localStorage.removeItem('vellis.audio-waveform-height');
			localStorage.removeItem('vellis.waveform-height');
		} catch {
			// storage 不可の環境では既定高の判定だけが立つ(キー分離ケースは storage 前提)
		}
	});

	/** inline でマウントし、メディア状態と尺まで整える(1周目の renderInline の mp3 版)。 */
	async function renderWaveformInline(duration = 60) {
		const utils = render(AudioViewer, { props: MP3_PROPS });
		const audio = document.querySelector('audio') as HTMLAudioElement;
		expect(audio).not.toBeNull();
		const media = stubMedia(audio, duration);
		await fireEvent(audio, new Event('loadedmetadata'));
		await fireEvent(audio, new Event('durationchange'));
		return { ...utils, audio, media };
	}

	const band = () => document.querySelector('.audio-waveform') as HTMLElement | null;
	const canvasEl = () =>
		document.querySelector('.audio-stage canvas.waveform-canvas') as HTMLCanvasElement | null;
	const noteEl = () => document.querySelector('.waveform-note');
	const laneLabels = () => Array.from(document.querySelectorAll('.waveform-lane-label'));
	const indicator = () => document.querySelector('.seek-window-indicator') as HTMLElement | null;

	it('帯は .audio-stage の中に常時居て、描画 effect が canvas に到達する(契約⑥⑨=常時表示)', async () => {
		await renderWaveformInline();

		// 帯と canvas はクリックなしで DOM に居る(器 .audio-stage の中=契約⑨)。
		expect(band()).not.toBeNull();
		expect(canvasEl()).not.toBeNull();

		// bind:this が生きていれば描画 effect が getContext('2d') に到達する
		// (VideoViewer と同じ観測点=無地の帯バグの再発防止)。
		await vi.waitFor(() => {
			expect(getContextSpy).toHaveBeenCalledWith('2d');
		});
	});

	it('ステレオは L(上)/R(下)の2レーン ―― L/R ラベルが上下に出る(契約⑥)', async () => {
		decodedBuffer = stereoBuffer();
		await renderWaveformInline();

		await vi.waitFor(() => {
			expect(laneLabels()).toHaveLength(2);
		});
		const [first, second] = laneLabels() as HTMLElement[];
		expect(first.textContent).toBe('L');
		expect(second.textContent).toBe('R');
		// 上=L・下=R(laneBoxes の縦配置=style top の大小で判定する)。
		expect(Number.parseFloat(first.style.top)).toBeLessThan(Number.parseFloat(second.style.top));
		// ready なので縮退文言は出ない。
		expect(noteEl()).toBeNull();
	});

	it('mono は1レーン ―― ラベル無しで波形が出る(契約⑥=解析完了で文言が消える)', async () => {
		decodedBuffer = monoBuffer();
		await renderWaveformInline();

		// 「帯ごと無い」を「文言が消えた」と読まないための前提(canvas が居ること)。
		expect(canvasEl()).not.toBeNull();
		// 解析が ready に達すると「解析中…」の文言が消える(帯=波形そのもの)。
		await vi.waitFor(() => {
			expect(noteEl()).toBeNull();
		});
		// 1レーンに L/R ラベルは無い(段が1つならラベルは何も足さない)。
		expect(laneLabels()).toHaveLength(0);
	});

	it('ズーム3ボタンが出る・等倍では窓指標なし・「＋」で指標が出て「等倍」で消える(契約⑦)', async () => {
		await renderWaveformInline(60);

		expect(screen.getByRole('button', { name: '波形を拡大' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '波形を縮小' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '波形を等倍に戻す' })).toBeTruthy();
		expect(indicator()).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: '波形を拡大' }));
		await vi.waitFor(() => {
			expect(indicator()).not.toBeNull();
		});

		await fireEvent.click(screen.getByRole('button', { name: '波形を等倍に戻す' }));
		await vi.waitFor(() => {
			expect(indicator()).toBeNull();
		});
	});

	it('帯上の Option+wheel で拡大(ctrl は倍率を変えない)・Shift+wheel で窓が横へ動く(契約⑦)', async () => {
		await renderWaveformInline(60);
		const target = band() as HTMLElement;
		expect(target).not.toBeNull();

		// ctrl+wheel は macOS の画面拡大に譲る(要件#47 追補a)。
		await fireEvent.wheel(target, { ctrlKey: true, deltaY: -240, deltaMode: 0 });
		expect(indicator()).toBeNull();

		// Option(alt)+wheel の上回し=拡大。−240px は指数写像でちょうど2倍。
		await fireEvent.wheel(target, { altKey: true, deltaY: -240, deltaMode: 0 });
		await vi.waitFor(() => {
			expect(indicator()).not.toBeNull();
		});
		const leftBefore = Number.parseFloat(indicator()?.style.left ?? '0');

		// Shift+wheel(縦成分を横に読み替え)=窓を後ろへ送る → 指標の left が増える。
		await fireEvent.wheel(target, { shiftKey: true, deltaY: 120, deltaMode: 0 });
		await vi.waitFor(() => {
			expect(Number.parseFloat(indicator()?.style.left ?? '0')).toBeGreaterThan(leftBefore);
		});
	});

	it('クリックシーク: 帯の x → currentTime へ直行し、nearestFrame は呼ばれない(契約⑧=吸着なし)', async () => {
		const { media } = await renderWaveformInline(60);
		await vi.waitFor(() => {
			expect(noteEl()).toBeNull();
		});

		const canvas = canvasEl() as HTMLCanvasElement;
		expect(canvas).not.toBeNull();
		// jsdom はレイアウトを持たないので、クリック座標の基準(rect)を被せる。
		canvas.getBoundingClientRect = () =>
			({
				left: 0,
				top: 0,
				right: 320,
				bottom: 240,
				width: 320,
				height: 240,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			}) as DOMRect;

		vi.mocked(nearestFrame).mockClear();
		await fireEvent.click(canvas, { clientX: 80 });

		// 倍率 1・幅 320px の x=80 は尺 60 秒の 1/4 = 15 秒(吸着なしの線形写像)。
		expect(media.time).toBeCloseTo(15, 5);
		// 音声にフレーム索引は無い ―― 要件#37 の吸着経路を通さない(契約⑧)。
		expect(vi.mocked(nearestFrame)).not.toHaveBeenCalled();
	});

	it('帯の高さは既定 240px ―― 動画の保存キー(vellis.waveform-height)には引っ張られない(契約⑪)', async () => {
		localStorage.setItem('vellis.waveform-height', '100');
		await renderWaveformInline();

		expect(band()?.style.height).toBe('240px');
	});

	it('保存キー vellis.audio-waveform-height から高さを復元する(契約⑪=キー分離)', async () => {
		localStorage.setItem('vellis.audio-waveform-height', '300');
		await renderWaveformInline();

		expect(band()?.style.height).toBe('300px');
	});

	it('縮退文言は音声ビューア用 ―― 動画向けの「この動画に…」を出さない(契約⑫)', async () => {
		// decode 結果が空= no-audio 縮退。動画の文言テーブルのままだと
		// 「この動画に音声トラックはありません」が出てしまう(音声ファイルに対して嘘)。
		decodedBuffer = emptyBuffer();
		await renderWaveformInline();

		await vi.waitFor(() => {
			const note = noteEl()?.textContent ?? '';
			expect(note.length).toBeGreaterThan(0);
			expect(note).not.toContain('音声を解析中');
		});
		expect(noteEl()?.textContent ?? '').not.toContain('この動画');
	});

	it('fail-open: 波形の解析が失敗しても <audio> とトランスポートは残る(契約⑫⑬)', async () => {
		// 解析の入口を落とす(unreadable 縮退)。再生の経路は <audio> で独立。
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('Failed to fetch');
			}),
		);
		await renderWaveformInline();

		await vi.waitFor(() => {
			expect((noteEl()?.textContent ?? '').length).toBeGreaterThan(0);
		});
		expect(document.querySelector('audio')).not.toBeNull();
		expect(screen.getByRole('button', { name: '再生' })).toBeTruthy();
		expect(screen.getByRole('slider', { name: '再生位置' })).toBeTruthy();
	});

	it('解析尺が横軸へ流れる ―― duration が NaN でもシークバーの軸が解析尺で立つ(契約④)', async () => {
		// 84000 標本 @8kHz = 10.5 秒。<audio> は尺を言えない(NaN)状況を作る。
		decodedBuffer = monoBuffer(84000, 8000);
		await renderWaveformInline(Number.NaN);

		const slider = screen.getByRole('slider', { name: '再生位置' }) as HTMLInputElement;
		await vi.waitFor(() => {
			// audioAxisDuration(NaN, 10.5) = 10.5 が max へ届く=解析尺が第2引数に流れた証明。
			expect(slider.max).toBe('10.5');
		});
		expect(slider.disabled).toBe(false);
	});
});

// 3周目の観測点: analyze_wav_waveform の invoke(モジュールモックは本ファイル冒頭)。
import { invoke } from '$lib/ipc';

/**
 * 要件#50 3周目 — wav の Rust 経路の配線(契約⑯)と食い違い記録(契約④(b))。
 *
 * ## 確定契約(implementer はこれに従う)
 * - AudioViewer は `analyzeWaveform` の input に **`analyzeWav: analyzeWavWaveform`**
 *   ($lib/audio-waveform の新 export= `invoke('analyze_wav_waveform', { uri })` の
 *   実体)を渡す ―― wav の src では fetch も OfflineAudioContext も通らずに帯が出る。
 *   raw 応答のレイアウトと ready への写像は audio-viewing.acceptance.test.ts の
 *   3周目セクションが正本(ここでは配線の生存だけを見る)
 * - 食い違い記録(契約④(b)): 要素の duration と解析尺 `durationSeconds` の両方が
 *   得られたとき `durationMismatch($lib/audio-viewing)` で判定し、true なら
 *   **console.warn で記録する(メッセージに「解析尺」を含む)**。記録先は要件行に
 *   明記が無いため console.warn に固定(2026-09-10 テスト作成時の要件側判断)。
 *   表示は要素側の軸のまま=シークバーの max は要素の duration から動かない
 */
describe('AudioViewer 配線スモーク(要件#50 3周目=wav の Rust 経路と食い違い記録)', () => {
	/** raw 応答(acceptance の正本レイアウトの縮約版=mono・samples あり)。 */
	function wavRaw(durationSeconds: number): ArrayBuffer {
		const frames = 16;
		const buffer = new ArrayBuffer(32 + frames * 4 + 8);
		const view = new DataView(buffer);
		view.setUint32(0, 1, true); // channels
		view.setUint32(4, 8000, true); // sampleRate
		view.setUint32(8, frames, true);
		view.setUint32(12, 512, true); // coarseStep
		view.setUint32(16, 1, true); // coarseLen = ceil(16/512)
		view.setUint32(20, 1, true); // hasSamples
		view.setFloat64(24, durationSeconds, true);
		let at = 32;
		for (let i = 0; i < frames; i++) {
			view.setFloat32(at, ((i % 4) - 2) / 4, true);
			at += 4;
		}
		view.setFloat32(at, -0.5, true); // coarse min
		view.setFloat32(at + 4, 0.25, true); // coarse max
		return buffer;
	}

	/** wav の inline マウント(1周目の renderInline と同じ流れ・尺だけ可変)。 */
	async function renderWavInline(mediaDuration: number, analyzedDuration: number) {
		vi.mocked(invoke).mockResolvedValue(wavRaw(analyzedDuration));
		const utils = render(AudioViewer, { props: PROPS });
		const audio = document.querySelector('audio') as HTMLAudioElement;
		expect(audio).not.toBeNull();
		const media = stubMedia(audio, mediaDuration);
		await fireEvent(audio, new Event('loadedmetadata'));
		await fireEvent(audio, new Event('durationchange'));
		return { ...utils, audio, media };
	}

	it('wav の src では analyze_wav_waveform が invoke され、fetch を使わずに帯が ready へ達する(契約⑯の配線)', async () => {
		await renderWavInline(300, 300);

		// 解析が ready に達して「解析中…」が消える=wav 経路が実際に働いた証明
		// (ファイル共通の fetch スタブは失敗するので、fetch 経路では ready に届かない)。
		await vi.waitFor(() => {
			expect(document.querySelector('.waveform-note')).toBeNull();
		});
		expect(vi.mocked(invoke)).toHaveBeenCalledWith('analyze_wav_waveform', { uri: PROPS.uri });
		expect(globalThis.fetch).not.toHaveBeenCalled();
		// 描画 effect が canvas に到達している(帯が実際に描かれる配線)。
		await vi.waitFor(() => {
			expect(getContextSpy).toHaveBeenCalledWith('2d');
		});
	});

	it('要素申告と解析尺の食い違いを console.warn で記録し、軸は要素側のまま(契約④(b))', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		// 要素=300 秒・解析尺=100 秒(1 秒も 1% も超える食い違い)。
		await renderWavInline(300, 100);

		await vi.waitFor(() => {
			const recorded = warnSpy.mock.calls.some((args) =>
				args.some((arg) => typeof arg === 'string' && arg.includes('解析尺')),
			);
			expect(recorded, '食い違いが console.warn(「解析尺」を含む)で記録されること').toBe(true);
		});

		// 表示は要素側の軸のまま(契約④(b)=記録はしても軸は動かさない)。
		const slider = screen.getByRole('slider', { name: '再生位置' }) as HTMLInputElement;
		expect(slider.max).toBe('300');
	});
});

/**
 * 要件#50 追補e — src 変更時のリセットと消音の維持(契約③⑨の修正周回・
 * 2026-09-10 由谷決定=PR #179 レビュー指摘の(1)(2))。
 *
 * +page.svelte は AudioViewer を `{#key}` で囲まないため、同一インスタンスが音声
 * ファイル間で再利用される ―― src 変更 `$effect` が波形系しかリセットしないと、
 * 一度の読込失敗で再生可能なファイルもプレースホルダのまま・再生中に別ファイルを
 * 開くと `playing` と前ファイルの尺が残る。
 *
 * ## 確定契約(implementer はこれに従う)
 * - src 変更 `$effect` で **`loadFailed` / `playing` / `position` / `mediaDuration` /
 *   `scrubbing` もリセット**する(`VideoViewer.svelte:255-261` と同じ整理)
 * - `<audio muted={audioMuted}>` を付け、`{#key src}` の再生成後も消音状態を要素へ
 *   反映する(消音状態そのものは src 切替をまたいで**維持**=リセットしない)
 */
describe('AudioViewer 配線スモーク(要件#50 追補e=src 変更時のリセットと消音の維持)', () => {
	/** 「別ファイルを開いた」を表す props(PROPS と同ディレクトリの別 wav)。 */
	const NEXT_PROPS = {
		uri: 'file:///Users/a/music/take2.wav',
		src: 'vellis-asset://local/Users/a/music/take2.wav',
	};

	beforeEach(() => {
		// 3周目 describe の renderWavInline が invoke へ仕込んだ wav 応答を既定へ戻す
		// (ファイル共通 beforeEach と二重だが、実行順に依存しないことをここでも明示する)。
		// 既定=null 応答 → wav の解析は unreadable 縮退になり、barDuration は
		// mediaDuration だけで決まる ―― 「尺リセットで slider.max='0'」の前提。
		vi.mocked(invoke).mockReset();
		vi.mocked(invoke).mockResolvedValue(null);
	});

	it('読込エラー後に src が変わると <audio> が再生成されて読み込みを試みる(追補e(1)=loadFailed のリセット)', async () => {
		const { rerender } = render(AudioViewer, { props: PROPS });
		const audio = document.querySelector('audio') as HTMLAudioElement;
		expect(audio).not.toBeNull();

		// 読み込み失敗 → プレースホルダに落ち、<audio> は消える(既存挙動)。
		await fireEvent(audio, new Event('error'));
		expect(document.querySelector('audio')).toBeNull();
		expect(document.querySelector('.audio-placeholder')?.textContent ?? '').toContain(
			'この音声を再生できませんでした',
		);

		// ディスク上の実体が差し替わると版数付きの新しい src が届く(要件#22 の機構)。
		await rerender({ ...PROPS, src: `${PROPS.src}?v=2` });
		await flushTasks();

		// loadFailed が残ったままだと、再生可能になったファイルもプレースホルダのまま。
		const revived = document.querySelector('audio') as HTMLAudioElement | null;
		expect(revived, 'src が変われば <audio> が再生成されること').not.toBeNull();
		expect(revived?.getAttribute('src')).toBe(`${PROPS.src}?v=2`);
		expect(document.querySelector('.audio-placeholder')).toBeNull();
	});

	it('再生中に src が変わると停止表示・位置 0・尺リセット(追補e(1)=playing / position / mediaDuration)', async () => {
		const { rerender, audio, media } = await renderInline();

		// 再生中の状態を作る(83.5 秒地点・rAF 1回で時刻表示へ反映=1周目の作法)。
		media.time = 83.5;
		media.setPaused(false);
		await fireEvent(audio, new Event('play'));
		await flushTasks();
		for (const cb of rafCallbacks.splice(0)) cb(performance.now());
		await flushTasks();
		expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
		expect(document.querySelector('.audio-time')?.textContent ?? '').toContain('1:23');

		// 別ファイルを開く(src 変更)。新要素の durationchange は**まだ来ていない**
		// 状態で判定する ―― 前ファイルの状態が持ち越されていないことだけを見る。
		await rerender(NEXT_PROPS);
		await flushTasks();

		expect(
			screen.getByRole('button', { name: '再生' }),
			'再生中の表示(「停止」)を持ち越さないこと',
		).toBeTruthy();
		expect(
			document.querySelector('.audio-time')?.textContent ?? '',
			'再生位置 83.5 秒を持ち越さないこと',
		).toContain('0:00:00');
		const slider = screen.getByRole('slider', { name: '再生位置' }) as HTMLInputElement;
		expect(slider.max, '前ファイルの尺(300 秒)をシークバーの max が引き継がないこと').toBe(
			'0',
		);
	});

	it('消音 → src 変更 → 新要素の muted が true で表示も「消音中」(追補e(2)=muted={audioMuted})', async () => {
		const { rerender, audio } = await renderInline();

		await fireEvent.click(screen.getByRole('button', { name: '消音' }));
		// jsdom が volumechange を自動発火するとは限らないので明示的に流す(表示の同期)。
		await fireEvent(audio, new Event('volumechange'));
		expect(audio.muted).toBe(true);
		expect(screen.getByRole('button', { name: '消音中' }).getAttribute('aria-pressed')).toBe(
			'true',
		);

		await rerender(NEXT_PROPS);
		await flushTasks();

		const next = document.querySelector('audio') as HTMLAudioElement | null;
		expect(next).not.toBeNull();
		expect(next, '{#key src} で要素は作り直されること').not.toBe(audio);
		expect(
			next?.muted,
			'新しい <audio> 要素にも消音状態が反映されること(muted={audioMuted})',
		).toBe(true);
		expect(
			screen.getByRole('button', { name: '消音中' }).getAttribute('aria-pressed'),
			'UI 側の消音表示は src 切替をまたいで維持されること',
		).toBe('true');
	});
});
