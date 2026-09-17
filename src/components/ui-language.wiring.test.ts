/**
 * 要件#51 の受け入れテスト(正本 docs/requirements/req-51.md)— component 層
 * 「UI 文言の全英語化」のうち、実 DOM のアクセシブル名で引く値固定(契約⑥(c))。
 *
 * 本ファイルの持ち場:
 * - AC-51-3 音声プレーヤー(AudioViewer)の主要文言の値固定:
 *   再生/停止・消音/消音中・波形の拡大/縮小/等倍・シーク(再生位置)・
 *   プレーヤー本体の aria-label が英語。remote(ssh)の出し分けは不変(契約⑩)
 * - AC-51-4 動画プレーヤー(VideoViewer)の主要文言の値固定:
 *   再生/停止・コマ送り(±1/±10 の名前と title)・波形3ボタン。
 *   波形帯を持たない(インライン再生できない)動画で当該ボタンが出ない
 *   出し分けは不変(契約⑩)
 * - AC-51-7 の DOM 到達スモーク: ProvenancePanel の縮退文言が実 DOM に英語で出る
 *   (9種の値固定そのものは src/lib/ui-language.acceptance.test.ts のソース走査)
 *
 * ## 確定契約(implementer はこれに従う=アクセシブル名の英語固定値)
 * - 再生 → "Play"・停止 → "Pause"(title は "Play (Space)" / "Pause (Space)")
 * - 消音 → "Mute"・消音中 → "Muted"(aria-pressed の往復は不変・title の解除は "Unmute")
 * - シークバー(aria-label)→ "Playback Position"
 * - 波形を拡大 → "Zoom In Waveform"・波形を縮小 → "Zoom Out Waveform"・
 *   波形を等倍に戻す → "Reset Waveform Zoom"(可視テキスト「等倍」は "1×" を推奨)
 * - 波形の高さハンドル(aria-label)→ "Resize Waveform"
 * - 波形帯(aria-label)→ "Audio waveform (click to seek)"
 * - プレーヤー本体(role="application")の aria-label は
 *   "Audio player (<ファイル名>). …" / "Video player (<ファイル名>). …" で始まる
 *   (キー操作の説明文の続きは implementer の裁量。CJK なしは走査が担保)
 * - コマ送りボタンの可視名は従来どおり −1 / +1 / −10 / +10(U+2212)。title は英語
 * - VideoViewer の素材パネルトグル → "Sources"(パネルの見出しと同じ語)
 * - 再生不可プレースホルダの文言は値固定しない(英語であることは AC-51-1 の走査と
 *   本ファイルの CJK 不在判定が担保。推奨文言は用語集=テスト作成報告)
 *
 * ## スタブの設計(AudioViewer.wiring.test.ts / VideoViewer.wiring.test.ts の家風)
 * ResizeObserver 即発火版・clientWidth 固定・getContext null spy・fetch 失敗
 * (波形は縮退へ=文言判定には十分)。VideoViewer のコマ送りは frameIndex が要るので
 * get_video_frame_index に最小のフレーム索引を返させる。
 *
 * 文言の妥当性そのもの・読み上げの自然さは人間ゲート(acceptance/acceptance.md #51)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import type { Mock } from 'vitest';
import AudioViewer from './AudioViewer.svelte';
import VideoViewer from './VideoViewer.svelte';
import ProvenancePanel from './ProvenancePanel.svelte';
import { invoke } from '$lib/ipc';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openPath: vi.fn(async () => undefined),
	revealItemInDir: vi.fn(async () => undefined),
}));

const invokeMock = invoke as unknown as Mock<(cmd: string, args?: unknown) => Promise<unknown>>;

/** 日本語(CJK)の検知(要件#35 と同じ定義)。 */
const CJK_PATTERN = /[　-〿぀-ヿ一-鿿＀-￯]/;

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

const AUDIO_PROPS = {
	uri: 'file:///Users/a/sounds/take.mp3',
	src: 'vellis-asset://local/Users/a/sounds/take.mp3',
};
const VIDEO_PROPS = {
	uri: 'file:///Users/a/movies/clip.mp4',
	src: 'vellis-asset://local/Users/a/movies/clip.mp4',
};

/** コマ送りを成立させる最小のフレーム索引(30fps CFR・3フレーム)。 */
const FRAME_INDEX_PAYLOAD = {
	timescale: 30,
	sampleTimes: [0, 1, 2],
	duration: 3,
	fpsNum: 30,
	fpsDen: 1,
	isCfr: true,
};

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

// ---------------------------------------------------------------------------
// AC-51-3 — AudioViewer の主要文言の値固定
// ---------------------------------------------------------------------------

describe('AC-51-3: AudioViewer の主要 UI のアクセシブル名は英語の固定値', () => {
	it('再生/シーク/消音/波形3ボタンが英語名で引ける', () => {
		render(AudioViewer, { props: AUDIO_PROPS });

		expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
		expect(screen.getByRole('slider', { name: 'Playback Position' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Mute' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Zoom In Waveform' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Zoom Out Waveform' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Reset Waveform Zoom' })).toBeTruthy();
	});

	it('再生中は Pause・消音中は Muted(状態語も英語=挙動は不変)', async () => {
		render(AudioViewer, { props: AUDIO_PROPS });

		// jsdom は play() を実装しないので、要素のイベントで再生状態を作る
		// (AudioViewer.wiring.test.ts と同じ読み=onplay が playing を立てる)。
		const audio = document.querySelector('audio');
		expect(audio).not.toBeNull();
		await fireEvent(audio!, new Event('play'));
		expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
		expect(
			screen.getByRole('button', { name: 'Muted' }).getAttribute('aria-pressed'),
		).toBe('true');
	});

	it('プレーヤー本体の aria-label は "Audio player (" で始まる英語(CJK なし)', () => {
		render(AudioViewer, { props: AUDIO_PROPS });

		const pane = screen.getByRole('application');
		const label = pane.getAttribute('aria-label') ?? '';
		expect(label.startsWith('Audio player (')).toBe(true);
		expect(label).toContain('take.mp3');
		expect(label).not.toMatch(CJK_PATTERN);
	});

	it('波形帯とリサイズハンドルの aria-label も英語の固定値', () => {
		render(AudioViewer, { props: AUDIO_PROPS });

		expect(document.querySelector('[aria-label="Audio waveform (click to seek)"]')).not.toBeNull();
		expect(document.querySelector('[aria-label="Resize Waveform"]')).not.toBeNull();
	});

	it('出し分け不変: remote(ssh)ではプレーヤーを出さずプレースホルダ(英語)を出す', () => {
		render(AudioViewer, {
			props: { uri: 'ssh://alice@host:22/srv/take.mp3', src: '' },
		});

		expect(document.querySelector('audio')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
		const placeholder = document.querySelector('.audio-placeholder');
		expect(placeholder).not.toBeNull();
		const text = placeholder?.textContent ?? '';
		expect(text.length).toBeGreaterThan(0);
		expect(text).toContain('take.mp3');
		expect(text).not.toMatch(CJK_PATTERN);
	});
});

// ---------------------------------------------------------------------------
// AC-51-4 — VideoViewer の主要文言の値固定
// ---------------------------------------------------------------------------

describe('AC-51-4: VideoViewer の主要 UI のアクセシブル名は英語の固定値', () => {
	it('再生/シーク/消音/波形3ボタン・素材パネルトグルが英語名で引ける', () => {
		// 素材パネルのトグルは onToggleProvenance がある時だけ出る(要件#40 契約①⑨の
		// 出し分け=契約⑩で不変)。名前 'Sources' の値固定にはコールバックの実体は不要。
		render(VideoViewer, { props: { ...VIDEO_PROPS, onToggleProvenance: () => {} } });

		expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
		expect(screen.getByRole('slider', { name: 'Playback Position' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Mute' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Zoom In Waveform' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Zoom Out Waveform' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Reset Waveform Zoom' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Sources' })).toBeTruthy();
	});

	it('再生中は Pause(状態語も英語=挙動は不変)', async () => {
		render(VideoViewer, { props: VIDEO_PROPS });

		const video = document.querySelector('video');
		expect(video).not.toBeNull();
		await fireEvent(video!, new Event('play'));
		expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
	});

	it('プレーヤー本体の aria-label は "Video player (" で始まる英語(CJK なし)', () => {
		render(VideoViewer, { props: VIDEO_PROPS });

		const pane = screen.getByRole('application');
		const label = pane.getAttribute('aria-label') ?? '';
		expect(label.startsWith('Video player (')).toBe(true);
		expect(label).toContain('clip.mp4');
		expect(label).not.toMatch(CJK_PATTERN);
	});

	it('コマ送り: 可視名 −1/+1/−10/+10 は不変・title は英語(CJK なし)', async () => {
		invokeMock.mockImplementation(async (cmd: string) =>
			cmd === 'get_video_frame_index' ? FRAME_INDEX_PAYLOAD : null,
		);
		render(VideoViewer, { props: VIDEO_PROPS });

		// フレーム索引は非同期で届く=コマ送りボタンの出現を待つ。
		const back1 = await screen.findByRole('button', { name: '−1' });
		const forward1 = screen.getByRole('button', { name: '+1' });
		const back10 = screen.getByRole('button', { name: '−10' });
		const forward10 = screen.getByRole('button', { name: '+10' });
		for (const button of [back1, forward1, back10, forward10]) {
			const title = button.getAttribute('title') ?? '';
			expect(title.length).toBeGreaterThan(0);
			expect(title).not.toMatch(CJK_PATTERN);
		}
	});

	it('出し分け不変: インライン再生できない形式では再生系ボタンが出ず、プレースホルダは英語', () => {
		render(VideoViewer, {
			props: {
				uri: 'file:///Users/a/movies/legacy.avi',
				src: 'vellis-asset://local/Users/a/movies/legacy.avi',
			},
		});

		// 波形帯を持たない(インライン再生しない)動画では再生・波形ボタンが出ない(契約⑩)。
		expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Zoom In Waveform' })).toBeNull();
		expect(screen.queryByRole('slider', { name: 'Playback Position' })).toBeNull();
		// 外部再生の導線は #35 と同じ語。
		expect(screen.getByRole('button', { name: 'Open with Default App' })).toBeTruthy();
		const placeholder = document.querySelector('.video-placeholder');
		expect(placeholder).not.toBeNull();
		expect(placeholder?.textContent ?? '').not.toMatch(CJK_PATTERN);
	});
});

// ---------------------------------------------------------------------------
// AC-51-7(DOM 到達スモーク)— ProvenancePanel の縮退文言が英語で実 DOM に出る
// ---------------------------------------------------------------------------

describe('AC-51-7 スモーク: ProvenancePanel の縮退文言・見出しが英語で DOM に出る', () => {
	const PANEL_PROPS = {
		videoUri: 'file:///Users/a/movies/clip.mp4',
		position: 0,
		actualDurationSec: null,
		onSeekSegment: () => {},
		onClose: () => {},
	};

	it('読み込み中(load=null)の縮退文言と見出し・閉じるボタンが英語の固定値', () => {
		render(ProvenancePanel, { props: { ...PANEL_PROPS, load: null } });

		expect(screen.getByText('Loading the provenance map…')).toBeTruthy();
		expect(screen.getByRole('heading', { name: 'Sources' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
	});

	it('読めない(unreadable)の縮退文言が英語の固定値', () => {
		render(ProvenancePanel, {
			props: { ...PANEL_PROPS, load: { state: 'unreadable' as const } },
		});

		expect(screen.getByText('Could not read the provenance map.')).toBeTruthy();
	});
});
