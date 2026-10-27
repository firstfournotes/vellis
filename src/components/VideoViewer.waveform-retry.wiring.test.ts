/**
 * 要件#44 追補b(Issue #620=backlog 250)=一時的な波形の抽出の失敗も控えに残り、
 * 同じ動画を開き直しても解析し直さない。
 * 受け入れ基準 AC-44-追b の配線テスト(JSDOM・component プロジェクト)。
 *
 * ## 契約(追補b)
 * 1. 同じ `src` の開き直し(追補a と同じ判定)で、控えの結果が **`unreadable`** のときは
 *    控え(`waveform`・`analyzedSrc`)を捨てて解析し直す。帯は解析し直しの間「解析中」に
 *    なる(初めて開いたときと同じ)
 * 2. 控えの結果がそれ以外(`ready`・`no-audio`・`too-large`・`unsupported-codec`・
 *    `decode-failed`)のときは、追補a のまま控えを使い、解析し直さない
 * 3. 不変: 追補a の「解析が終わる前に開き直したらやり直す」「`src` が変わったら捨てる」・
 *    時間軸の窓を戻す振る舞い・文言・`analyzeWaveform` の判定・`AudioViewer`
 *
 * ## 判定するもの(AC-44-追b)
 * (a) 解析の結果が `unreadable` で終わった状態で同じ `src` を開き直すと、解析がもう一度
 *     呼ばれ(抽出コマンドの呼び出しが 1 回増える)、帯がいったん「解析中」になり、
 *     2 回目の結果(`ready`=L/R ラベル・文言なし)が出る。そのあと `ready` の状態で
 *     もう一度開き直しても解析は呼ばれない(追補a が解析し直した後も効く)
 * (b) 結果が `no-audio`・`decode-failed` で終わった状態の開き直しでは、解析は呼ばれない
 *     (抽出・decode の回数が増えない・帯は「解析中」にならず縮退の文言のまま)
 * (c) 追補a の `VideoViewer.waveform-keep.wiring.test.ts` は無改変(本ファイルは触らない)
 *
 * ## 再現する経路(追補a のテストと同じ)
 * ホスト `__fixtures__/VideoViewerReopenHost.svelte` の `reopen()` が Explorer で同じ
 * ファイルをもう一度クリックした操作に相当する。読み込み直しが本当に走ったことは、
 * 開き直し前に 7.25 秒へ動かしたシークバーが 0 へ戻ること(要件#37 追補b)で確かめる
 * ―― (b) は「何も起きない」ことの判定なので、開き直し自体が起きた証拠が要る。
 *
 * ## 1 回目を縮退で終わらせる手段(偽の緑を防ぐ)
 * mp4 なので解析 IO は抽出コマンド(`extract_waveform_audio` の invoke)。`$lib/ipc` の
 * `invoke` モックの応答で結果を作り分ける(`invokeWaveformBytes` の写し方=
 * audio-waveform.ts):
 * - `unreadable`   = invoke が `null` を返す(raw バイトでない応答=知らない理由。
 *                    `VideoViewer.reopen-userseek.wiring.test.ts` の既定の作法)
 * - `no-audio`     = invoke が `'no-audio'` を含むメッセージで reject する
 * - `decode-failed`= invoke は ok(小さな `ArrayBuffer`)・`decodeAudioData` が reject
 * 2 回目を `ready` にするには、2 回目の invoke だけ `ArrayBuffer` を返す。2 回目の応答は
 * **保留できる Promise** にして、帯が「解析中」になった瞬間を取りこぼさず判定する
 * (`reopen-userseek` の `mockIndexDeferredOnSecondCall` と同じ作法)。
 *
 * `readyState=1`(HAVE_METADATA)を `<video>` に被せておくのが要点(追補a のテストと同じ)
 * ―― これが無いと開き直し後のやり直し解析はメタデータ待ちで止まり、抽出は呼ばれない
 * まま「解析中」だけが出る=回数の判定が空振りになる。
 *
 * ## 「解析中」の文言の取り方
 * 文言の実体(`Analyzing audio…`)は `waveformBandNote` の実装裁量なので固定しない。
 * 最初の解析が始まる前(メタデータ到達前)の帯の文言が「解析中」そのものなので、
 * それを控えておき、開き直し後の帯と等しいことで判定する。
 *
 * ## 想定される赤(実装前)
 * (a): 読み込み直しの effect は同じ `src` の開き直しでは控えを捨てない(追補a)ので、
 *      `unreadable` の控えが残り、帯は「Could not read the audio」のまま・抽出は 2 回目を
 *      受けない → 「帯が解析中になる」「抽出が 2 回」の両方が赤。
 * (b): 実装前から緑(契約 2=追補a の振る舞いの固定。実装が踏み越えないための柵)。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import VideoViewerReopenHost from './__fixtures__/VideoViewerReopenHost.svelte';
import { invoke } from '$lib/ipc';

vi.mock('$lib/ipc', () => ({
	// 既定は null(get_video_frame_index → 索引なしの縮退・抽出 → unreadable)。
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

/** 縮退の文言(要件#45 契約③の `waveformBandNote`。文言そのものは不変=追補b 契約 3)。 */
const NOTE_UNREADABLE = 'Could not read the audio';
const NOTE_NO_AUDIO = 'This video has no audio track';
const NOTE_DECODE_FAILED = 'Could not decode the audio';

/** 積み残しの非同期を流しきる(macrotask 2周)。 */
async function flushTasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const videoElement = () => document.querySelector('video.video') as HTMLVideoElement | null;
const band = () => document.querySelector('.video-waveform') as HTMLElement | null;
const noteEl = () => document.querySelector('.waveform-note') as HTMLElement | null;
const noteText = () => noteEl()?.textContent ?? null;
const laneLabelTexts = () =>
	Array.from(document.querySelectorAll('.waveform-lane-label')).map((el) => el.textContent);
const seekSlider = () => document.querySelector('input.video-seek') as HTMLInputElement;

/** 抽出コマンド(mp4 の解析 IO)の呼び出しだけを数える。invoke は索引の問い合わせにも使われる。 */
const extractCalls = () =>
	invokeMock.mock.calls.filter(([command]) => command === 'extract_waveform_audio');

let decodeSpy: Mock<(bytes: ArrayBuffer) => Promise<FakeAudioBuffer>>;

beforeEach(() => {
	// 既定: すべて null(抽出 → unreadable・索引 → なし)。各ケースが抽出の応答を決める。
	invokeMock.mockReset();
	invokeMock.mockImplementation(async () => null);

	decodeSpy = vi.fn(async (_bytes: ArrayBuffer) => stereoBuffer());
	const decode = (bytes: ArrayBuffer) => decodeSpy(bytes);
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
 * 抽出コマンドの応答を回ごとに決める invoke モック。`responses[i]` が i 回目の応答で、
 * 関数なら呼んで返す(reject させたいときは throw する関数を渡す)。それ以外のコマンド
 * (索引など)は null。
 */
function mockExtractResponses(responses: (unknown | (() => unknown))[]) {
	let calls = 0;
	invokeMock.mockImplementation(async (command: string) => {
		if (command !== 'extract_waveform_audio') return null;
		const response = responses[Math.min(calls, responses.length - 1)];
		calls += 1;
		return typeof response === 'function' ? (response as () => unknown)() : response;
	});
}

/**
 * `<video>` を HAVE_METADATA 済みにして `loadedmetadata` を流し、最初の解析を
 * `expected` の状態で終わらせる。戻り値は解析前の帯の文言(=「解析中」の文言)。
 */
async function finishFirstAnalysis(
	el: HTMLVideoElement,
	expected: { note: string | null; labels: string[]; decodeCalls: number },
): Promise<string> {
	// 解析前の帯は「解析中」の文言(契約⑤=無地の帯を作らない)。これを控えておく。
	const analyzingNote = noteText();
	expect(analyzingNote, '解析前は帯に文言(解析中)が出ていること').not.toBeNull();
	expect((analyzingNote ?? '').length).toBeGreaterThan(0);
	expect(analyzingNote, '「解析中」の文言は終わった状態の文言と区別できること').not.toBe(
		expected.note,
	);
	expect(laneLabelTexts(), '解析前に L/R ラベルは無いこと').toEqual([]);

	// jsdom の readyState は常に 0。HAVE_METADATA 済みを被せてから到達を流す。
	Object.defineProperty(el, 'readyState', { configurable: true, get: () => 1 });
	await fireEvent(el, new Event('loadedmetadata'));

	await vi.waitFor(() => {
		expect(extractCalls(), '抽出コマンドが1回呼ばれること').toHaveLength(1);
		expect(noteText(), '最初の解析が期待の状態で終わること').toBe(expected.note);
		expect(laneLabelTexts()).toEqual(expected.labels);
	});
	expect(decodeSpy).toHaveBeenCalledTimes(expected.decodeCalls);

	// 解析の非同期を流しきり、「終わった」状態を確定させる(以後の回数の増分だけを見る)。
	await flushTasks();
	expect(extractCalls()).toHaveLength(1);
	expect(decodeSpy).toHaveBeenCalledTimes(expected.decodeCalls);
	expect(noteText()).toBe(expected.note);
	return analyzingNote as string;
}

/**
 * 読み込み直しが本当に走ったことを後で確かめる仕込み: 尺 12.5 を申告してシークバーを
 * 操作可能にし、位置を 7.25 へ(fallback 経路: seeked → currentTime)。
 */
async function moveSeekBarAwayFromStart(el: HTMLVideoElement): Promise<void> {
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
	await flushTasks();
}

/** 開き直しの間の帯の文言を、DOM が変わるたびに記録する(瞬間的な表示も捕まえる)。 */
function watchNotes(target: HTMLElement) {
	const seen: (string | null)[] = [];
	const observer = new MutationObserver(() => {
		seen.push(noteText());
	});
	observer.observe(target, { childList: true, subtree: true, characterData: true });
	return { seen, stop: () => observer.disconnect() };
}

describe('VideoViewer 配線(要件#44 追補b・Issue #620: 控えが unreadable のときだけ開き直しで解析し直す)', () => {
	it('AC-44-追b (a): unreadable で終わった同じ mp4 を開き直すと、解析がもう一度呼ばれ、帯はいったん「解析中」になり、2 回目の結果(ready)が出る', async () => {
		// 1 回目は null(raw バイトでない応答 → unreadable)。2 回目は保留して、こちらが
		// 解いたときに ok(小さなバイト列)になる。
		let resolveSecond!: (bytes: ArrayBuffer) => void;
		const second = new Promise<ArrayBuffer>((resolve) => {
			resolveSecond = resolve;
		});
		mockExtractResponses([null, second]);

		const { component } = render(VideoViewerReopenHost, { props: MP4_PROPS });
		const video = videoElement();
		expect(video).not.toBeNull();
		const el = video as HTMLVideoElement;

		const analyzingNote = await finishFirstAnalysis(el, {
			note: NOTE_UNREADABLE,
			labels: [],
			decodeCalls: 0,
		});
		await moveSeekBarAwayFromStart(el);
		expect(extractCalls()).toHaveLength(1);
		expect(noteText()).toBe(NOTE_UNREADABLE);

		// アプリが同じファイルを開き直したときと同じ形。loadedmetadata は出さない(実機でも来ない)。
		component.reopen();
		await tick();

		// (a-1) 帯はいったん「解析中」になる(控えを捨てて解析し直している)。
		expect(noteText(), '開き直し直後に帯が「解析中」になること').toBe(analyzingNote);
		expect(laneLabelTexts()).toEqual([]);

		// (a-2) 解析がもう一度呼ばれる=抽出コマンドが 2 回目を受ける(同じ uri)。
		await vi.waitFor(() => {
			expect(extractCalls(), '開き直しで抽出コマンドがもう1回呼ばれること').toHaveLength(2);
		});
		expect(extractCalls()[1][1]).toEqual({ uri: MP4_PROPS.uri });
		// 応答を保留している間は「解析中」のまま(縮退の文言に戻らない)。
		await flushTasks();
		expect(noteText()).toBe(analyzingNote);
		expect(decodeSpy).not.toHaveBeenCalled();

		// 経路の確認①: `{#key src}` は同じ文字列なので <video> は据え置き。
		expect(videoElement()).toBe(el);
		// 経路の確認②: 読み込み直しの初期化は走っている(再生位置は先頭へ=要件#37 追補b 不変)。
		await vi.waitFor(() => {
			expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(0, 3);
		});

		// (a-3) 2 回目の結果(ready)が出る=文言なし・L/R ラベル。
		resolveSecond(new ArrayBuffer(8));
		await vi.waitFor(() => {
			expect(noteEl(), '2 回目の結果で文言が消えること').toBeNull();
			expect(laneLabelTexts(), '2 回目の結果(ステレオ)で L/R ラベルが出ること').toEqual(['L', 'R']);
		});
		expect(decodeSpy).toHaveBeenCalledTimes(1);
		await flushTasks();
		expect(extractCalls()).toHaveLength(2);

		// (a-4) ready になった後の開き直しは追補a のまま=解析は呼ばれず、帯は波形のまま。
		const notes = watchNotes(band() as HTMLElement);
		component.reopen();
		await tick();
		expect(noteEl(), 'ready の控えの開き直しで帯が「解析中」にならないこと').toBeNull();
		await flushTasks();
		notes.stop();
		expect(extractCalls(), 'ready の控えの開き直しで抽出が呼ばれ直さないこと').toHaveLength(2);
		expect(decodeSpy).toHaveBeenCalledTimes(1);
		expect(notes.seen.filter((note) => note !== null)).toEqual([]);
		expect(laneLabelTexts()).toEqual(['L', 'R']);
	});

	it.each<[string, () => void, string, number]>([
		[
			'no-audio(抽出の応答が no-audio)',
			() =>
				mockExtractResponses([
					() => {
						throw new Error('no-audio');
					},
				]),
			NOTE_NO_AUDIO,
			0,
		],
		[
			'decode-failed(抽出は ok・decode が失敗)',
			() => {
				mockExtractResponses([new ArrayBuffer(8)]);
				decodeSpy.mockImplementation(async () => {
					throw new DOMException('Unable to decode audio data', 'EncodingError');
				});
			},
			NOTE_DECODE_FAILED,
			1,
		],
	])(
		'AC-44-追b (b): %s で終わった同じ mp4 を開き直しても、解析は呼ばれず(抽出・decode の回数は据え置き)、帯は「解析中」にならず縮退の文言のまま',
		async (_label, arrange, expectedNote, decodeCalls) => {
			arrange();

			const { component } = render(VideoViewerReopenHost, { props: MP4_PROPS });
			const video = videoElement();
			expect(video).not.toBeNull();
			const el = video as HTMLVideoElement;

			const analyzingNote = await finishFirstAnalysis(el, {
				note: expectedNote,
				labels: [],
				decodeCalls,
			});
			await moveSeekBarAwayFromStart(el);
			expect(extractCalls()).toHaveLength(1);
			expect(noteText()).toBe(expectedNote);

			const notes = watchNotes(band() as HTMLElement);
			component.reopen();
			await tick();
			// 開き直し直後(effect の flush 直後)の帯: 解析し直していれば、ここで既に「解析中」。
			expect(noteText(), '開き直し直後に帯が「解析中」になっていないこと').toBe(expectedNote);
			await flushTasks();
			notes.stop();

			// 経路の確認①②(追補a のテストと同じ): <video> は据え置き・再生位置は先頭へ。
			expect(videoElement()).toBe(el);
			await vi.waitFor(() => {
				expect(Number.parseFloat(seekSlider().value)).toBeCloseTo(0, 3);
			});

			// 本題: 解析は呼ばれない・帯は縮退の文言のまま・「解析中」は一度も出ない。
			expect(extractCalls(), '開き直しで抽出コマンドが呼ばれ直さないこと').toHaveLength(1);
			expect(decodeSpy, '開き直しで decode が呼ばれ直さないこと').toHaveBeenCalledTimes(decodeCalls);
			expect(noteText()).toBe(expectedNote);
			expect(
				notes.seen.filter((note) => note !== expectedNote),
				'開き直しの間に帯の文言が縮退の文言以外(解析中など)になっていないこと',
			).toEqual([]);
			expect(notes.seen).not.toContain(analyzingNote);
			expect(laneLabelTexts()).toEqual([]);
		},
	);
});
