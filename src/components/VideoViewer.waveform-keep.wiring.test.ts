/**
 * 要件#44 追補a(backlog 239)=同じ動画を開き直すたびに波形を解析し直す。
 * 受け入れ基準 AC-44-追a の配線テスト(JSDOM・component プロジェクト)。
 *
 * ## 判定するもの(AC-44-追a)
 * 1. 波形の解析が1回終わった状態(帯に波形=ステレオの L/R ラベルが出て「解析中」の
 *    文言が消えた状態)で、アプリが同じファイルを開き直したときと同じ形で読み込み直しを
 *    起こすと:
 *    - 解析は呼ばれない=抽出コマンド(`extract_waveform_audio` の invoke)と
 *      `decodeAudioData` の呼び出し回数が増えない
 *    - 帯は「解析中」にならない=開き直しの間に `.waveform-note` が一度も DOM に
 *      現れない(MutationObserver で瞬間的な表示も捕まえる)
 *    - 帯は直前の波形のまま=`.waveform-note` は無く、L/R ラベルが残っている
 * 2. `src` が変わったとき(同じファイルの版数の更新= `?v=2`)は従来どおり解析が
 *    呼ばれ直す=抽出コマンドの呼び出しが1回増え、帯は新しい解析の結果になる
 *    (契約 追補a の「不変」の確認。実装前後とも緑のはず)
 *
 * ## 再現する経路
 * 1. は要件#37 追補a/追補b と同じホスト `__fixtures__/VideoViewerReopenHost.svelte`
 * (+page.svelte の setDocument → videoDisplay の作り直し → メンバー式で渡す、を写した
 * もの)。`reopen()` が Explorer で同じファイルをもう一度クリックした操作に相当し、
 * 子の読み込み直し effect は再実行されるが `{#key src}` は文字列一致で `<video>` を
 * 据え置く。読み込み直しが本当に走ったことは、開き直し前に 7.25 秒へ動かした
 * シークバーが 0 へ戻ること(要件#37 追補b の既存の振る舞い)で確かめる。
 * 2. は `src` を別の文字列にするだけなので、ホストを使わず testing-library の
 * `rerender` で起こす(VideoViewer.mute.wiring.test.ts と同じ作法)。
 *
 * ## 解析を「終わった」状態にする方法(VideoViewer.wiring.test.ts の家風に足す)
 * - mp4 なので解析 IO は抽出コマンド(要件#45 契約①)。`$lib/ipc` の `invoke` モックは
 *   `extract_waveform_audio` にだけ小さな `ArrayBuffer` を返し(= `{ state: 'ok' }`)、
 *   それ以外(`get_video_frame_index` など)は null(索引なしの縮退)
 * - decode は jsdom に無い `OfflineAudioContext` を stubGlobal で置き、`decodeAudioData`
 *   が構造的 AudioBuffer(ステレオ 2ch)を返す(AudioViewer.wiring.test.ts と同じ形)。
 *   ステレオにするのは、ready の帯だけに出る L/R ラベル(`.waveform-lane-label`)を
 *   「波形がある」ことの DOM 観測点にするため
 * - 解析 effect はメタデータの到達を `waitForMetadata` で待つ(契約②)。jsdom の
 *   `<video>` は readyState 0 のままなので、要素に `readyState=1`(HAVE_METADATA)を
 *   被せてから `loadedmetadata` を流す。**readyState を被せるのが要点** ―― これが無いと
 *   開き直し後の(実装前の)やり直し解析はメタデータ待ちで止まり、抽出は呼ばれないまま
 *   「解析中」だけが出続ける=呼び出し回数の判定が空振り(偽の緑)になる。被せておけば
 *   やり直し解析は即座に抽出まで進むので、回数と文言の両方で赤が出る
 *
 * ## 想定される赤(実装前)
 * 読み込み直しの effect は同じ `src` の開き直しでも `waveform = null`・`analyzedSrc = null`
 * で控えを捨てる(req-44.md 追補a「原因」)。そのため開き直し直後に解析 effect が
 * 再実行され、帯に「解析中」(Analyzing audio…)が出て、抽出コマンドが2回目の
 * 呼び出しを受ける → 1. の「回数が増えない」「文言が現れない」の両方が赤。
 * 2. は実装前から緑(不変の確認)。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import VideoViewer from './VideoViewer.svelte';
import VideoViewerReopenHost from './__fixtures__/VideoViewerReopenHost.svelte';
import { invoke } from '$lib/ipc';

vi.mock('$lib/ipc', () => ({
	// 既定は null(get_video_frame_index → 索引なしの縮退)。beforeEach で抽出だけ ok にする。
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

/** `OfflineAudioContext.decodeAudioData` が返す構造的 AudioBuffer(`WaveformAudioBuffer` 互換)。 */
type FakeAudioBuffer = {
	numberOfChannels: number;
	length: number;
	sampleRate: number;
	getChannelData(channel: number): Float32Array;
};

/** ステレオ 2ch。ready の帯に L/R ラベルが出る構成(`waveformLanes` の規則)。 */
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

/** インライン再生対象(mp4 ローカル)。videoViewMode → 'inline'・解析は extract 経路。 */
const MP4_PROPS = {
	uri: 'file:///Users/a/movies/clip.mp4',
	src: 'vellis-asset://local/Users/a/movies/clip.mp4',
};

/** 同じファイルの版数の更新(要件#22 の機構)= `src` だけが別の文字列になる。 */
const MP4_PROPS_V2 = {
	uri: MP4_PROPS.uri,
	src: `${MP4_PROPS.src}?v=2`,
};

/** 積み残しの非同期を流しきる(macrotask 2周)。 */
async function flushTasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const videoElement = () => document.querySelector('video.video') as HTMLVideoElement | null;
const band = () => document.querySelector('.video-waveform') as HTMLElement | null;
const noteEl = () => document.querySelector('.waveform-note') as HTMLElement | null;
const laneLabelTexts = () =>
	Array.from(document.querySelectorAll('.waveform-lane-label')).map((el) => el.textContent);
const seekSlider = () => document.querySelector('input.video-seek') as HTMLInputElement;

/** 抽出コマンド(mp4 の解析 IO)の呼び出しだけを数える。invoke は索引の問い合わせにも使われる。 */
const extractCalls = () =>
	invokeMock.mock.calls.filter(([command]) => command === 'extract_waveform_audio');

let decodeSpy: Mock<(bytes: ArrayBuffer) => Promise<FakeAudioBuffer>>;

beforeEach(() => {
	// 抽出コマンドだけ ok(小さなバイト列)。他のコマンドは null(索引なしの縮退)。
	invokeMock.mockReset();
	invokeMock.mockImplementation(async (command: string) =>
		command === 'extract_waveform_audio' ? new ArrayBuffer(8) : null,
	);

	decodeSpy = vi.fn(async (_bytes: ArrayBuffer) => stereoBuffer());
	const decode = decodeSpy;
	// jsdom に OfflineAudioContext は無い。decode だけを偽物で受ける。
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
	// webm 用の fetch 経路は mp4 では通らない。呼ばれても unreadable 縮退へ(家風の失敗版)。
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
 * `<video>` を HAVE_METADATA 済みにして `loadedmetadata` を流し、解析(抽出 → decode)が
 * 1回終わって帯に波形(L/R ラベル・文言なし)が出るところまで進める。
 */
async function finishFirstAnalysis(el: HTMLVideoElement): Promise<void> {
	// 解析前の帯は「解析中」の文言(契約⑤=無地の帯を作らない)。文言の実体は
	// waveformBandNote の実装裁量なので、ここでは「文言がある」ことだけを見る。
	expect(noteEl(), '解析前は帯に文言(解析中)が出ていること').not.toBeNull();
	expect((noteEl()?.textContent ?? '').length).toBeGreaterThan(0);
	expect(laneLabelTexts(), '解析前に L/R ラベルは無いこと').toEqual([]);

	// jsdom の readyState は常に 0。HAVE_METADATA 済みを被せてから到達を流す(本文の
	// 「readyState を被せるのが要点」を参照)。
	Object.defineProperty(el, 'readyState', { configurable: true, get: () => 1 });
	await fireEvent(el, new Event('loadedmetadata'));

	await vi.waitFor(() => {
		expect(extractCalls(), '抽出コマンドが1回呼ばれること').toHaveLength(1);
		expect(noteEl(), '解析が終わると文言が消えること').toBeNull();
		expect(laneLabelTexts(), 'ステレオの L/R ラベルが出ること(波形あり)').toEqual(['L', 'R']);
	});
	expect(decodeSpy).toHaveBeenCalledTimes(1);

	// 解析の非同期を流しきり、「終わった」状態を確定させる(以後の回数の増分だけを見る)。
	await flushTasks();
	expect(extractCalls()).toHaveLength(1);
	expect(decodeSpy).toHaveBeenCalledTimes(1);
}

describe('VideoViewer 配線(要件#44 追補a・backlog 239: 同じ動画の開き直しで波形を解析し直さない)', () => {
	it('AC-44-追a: 解析が1回終わった同じ mp4 を開き直しても、解析は呼ばれず(抽出・decode の回数は据え置き)、帯は「解析中」にならず直前の波形のまま', async () => {
		const { component } = render(VideoViewerReopenHost, { props: MP4_PROPS });
		const video = videoElement();
		expect(video).not.toBeNull();
		const el = video as HTMLVideoElement;

		await finishFirstAnalysis(el);

		// 読み込み直しが本当に走ったことを後で確かめる仕込み: 尺 12.5 を申告して
		// シークバーを操作可能にし、位置を 7.25 へ(fallback 経路: seeked → currentTime)。
		Object.defineProperty(el, 'duration', { configurable: true, get: () => 12.5 });
		await fireEvent(el, new Event('durationchange'));
		Object.defineProperty(el, 'currentTime', {
			configurable: true,
			get: () => 7.25,
			set: () => {},
		});
		await fireEvent(el, new Event('seeked'));
		await vi.waitFor(() => {
			expect(seekSlider().disabled).toBe(false);
			expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(7.25, 3);
		});
		// 仕込みの間に解析が増えていないこと(尺の変化は解析の依存ではない=既存の整理)。
		await flushTasks();
		expect(extractCalls()).toHaveLength(1);
		expect(noteEl()).toBeNull();

		// 開き直しの間に帯へ文言が「一瞬でも」入ったら捕まえる。Svelte の {#if} は分岐が
		// 切り替わるたびに新しい <span class="waveform-note"> を作るので、追加ノードを見る。
		const notesShown: string[] = [];
		const target = band();
		expect(target).not.toBeNull();
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of Array.from(record.addedNodes)) {
					if (!(node instanceof Element)) continue;
					const note = node.matches('.waveform-note') ? node : node.querySelector('.waveform-note');
					if (note) notesShown.push(note.textContent ?? '');
				}
			}
		});
		observer.observe(target as HTMLElement, { childList: true, subtree: true, characterData: true });

		// アプリが同じファイルを開き直したときと同じ形(setDocument → videoDisplay の
		// 組み立て直し)。loadedmetadata は出さない(実機でも来ない)。
		component.reopen();
		await tick();
		// 開き直し直後(effect の flush 直後)の帯: 解析し直していれば、ここで既に「解析中」。
		expect(noteEl(), '開き直し直後に帯が「解析中」になっていないこと').toBeNull();
		await flushTasks();
		observer.disconnect();

		// 経路の確認①: `{#key src}` は同じ文字列なので <video> は据え置き。
		expect(videoElement()).toBe(el);
		// 経路の確認②: 読み込み直しの初期化は走っている(再生位置は先頭へ=要件#37 追補b 不変)。
		await vi.waitFor(() => {
			expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(0, 3);
		});

		// 本題(AC-44-追a):
		// (a) 解析は呼ばれない=抽出コマンドも decode も回数が増えない。
		expect(extractCalls(), '開き直しで抽出コマンドが呼ばれ直さないこと').toHaveLength(1);
		expect(decodeSpy, '開き直しで decode が呼ばれ直さないこと').toHaveBeenCalledTimes(1);
		// (b) 帯は「解析中」にならない=開き直しの間に文言が一度も現れない。
		expect(notesShown, '開き直しの間に帯へ文言(解析中)が一度も出ないこと').toEqual([]);
		// (c) 帯は直前の波形のまま=文言なし・L/R ラベルは残っている。
		expect(noteEl()).toBeNull();
		expect(laneLabelTexts()).toEqual(['L', 'R']);
	});

	it('AC-44-追a(不変の確認): src が変わったとき(版数の更新)は解析が呼ばれ直す', async () => {
		const { rerender } = render(VideoViewer, { props: MP4_PROPS });
		const first = videoElement();
		expect(first).not.toBeNull();

		await finishFirstAnalysis(first as HTMLVideoElement);

		// 同じファイルの版数の更新= src だけが別の文字列になる。`{#key src}` が <video> を
		// 作り直す(別物の要素)。
		await rerender(MP4_PROPS_V2);
		await flushTasks();
		const next = videoElement();
		expect(next, 'src が変われば <video> が居ること').not.toBeNull();
		expect(next, '{#key src} で要素は作り直されること').not.toBe(first);

		// 新しい要素にもメタデータの到達を作る(解析 effect が新旧どちらの要素を待って
		// いても、ここで待ちが解けて抽出へ進む)。
		Object.defineProperty(next as HTMLVideoElement, 'readyState', {
			configurable: true,
			get: () => 1,
		});
		await fireEvent(next as HTMLVideoElement, new Event('loadedmetadata'));

		// 控えは捨てられ、抽出コマンドが呼ばれ直す(要件#44 契約③= src 単位の控え)。
		await vi.waitFor(() => {
			expect(extractCalls(), 'src が変わると抽出コマンドがもう1回呼ばれること').toHaveLength(2);
		});
		expect(extractCalls()[1][1]).toEqual({ uri: MP4_PROPS_V2.uri });

		// 解析し直した結果で帯が立ち直る(文言なし・L/R ラベル)。
		await vi.waitFor(() => {
			expect(noteEl()).toBeNull();
			expect(laneLabelTexts()).toEqual(['L', 'R']);
		});
		expect(decodeSpy).toHaveBeenCalledTimes(2);
	});
});
