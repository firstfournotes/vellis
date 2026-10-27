/**
 * 要件#41 追補i AC (e) の受け入れテスト(docs/requirements/req-41.md「追補i」= Issue #468 / backlog 98)
 * — フロント層
 *
 * 契約 2(追補i): Rust の抽出コマンドは上限に当たったとき `no-audio` ではなく `too-large` で拒否する。
 * ところが `src/lib/audio-waveform.ts` の `invokeWaveformBytes` は `no-audio` / `unsupported-codec`
 * 以外の拒否をすべて `unreadable` に倒すので、そのままでは帯が「Could not read the audio」になる。
 * この受け口が Rust の拒否 `too-large` を `{ state: 'too-large' }` に写すことを固定する。
 *
 * 判定範囲(AC-41-追i (e)):
 * - `extractWaveformAudio`(mov / mp4 の抽出= `extract_waveform_audio`)が拒否 `too-large` を
 *   `{ state: 'too-large' }` に写す(文字列でも Error でも)
 * - `analyzeWavWaveform`(wav の解析= `analyze_wav_waveform`。同じ受け口を通る)も同じ
 * - 不変: `no-audio` / `unsupported-codec` / `unreadable` はそのまま、知らない理由は `unreadable`、
 *   `ok` の raw バイトは `ok`
 * - 帯の写し(契約 2「動画の帯の文言は too-large の既存の写し方に従う」): `analyzeWaveform` は
 *   抽出の `too-large` をそのまま結果に通し decode しない。`waveformBandNote` の文言は既存の
 *   「The file is too large to build a waveform」
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * ```ts
 * // src/lib/audio-waveform.ts
 * export type WaveformExtraction =
 *   | { state: 'ok'; bytes: ArrayBuffer }
 *   | { state: 'no-audio' }
 *   | { state: 'too-large' }          // 追補i で追加(WavWaveformAnalysis も同型なので一緒に増える)
 *   | { state: 'unsupported-codec' }
 *   | { state: 'unreadable' };
 * // invokeWaveformBytes の catch: reason.includes('too-large') → { state: 'too-large' }
 * // (no-audio / unsupported-codec と同じ並び。知らない理由は unreadable のまま)
 * ```
 *
 * Rust 側(`plan_audio_extraction` / `refusal_reason`)は src-tauri/tests/acceptance_req41i.rs が判定する。
 * 実機で 7 分の 44.1kHz PCM mov に波形が出ることは人間ゲート(要件#41 人間ゲート 5 の文言の判断)。
 *
 * ## 赤の源
 * 今の `invokeWaveformBytes` は `too-large` を `unreadable` に倒すので、`too-large` を期待する
 * ケースが赤。`WaveformExtraction` に `'too-large'` が無いので型検査(pnpm check)も赤。不変の
 * ケースは固定の役(今も緑)。
 *
 * モックは `./ipc`(実装 `audio-waveform.ts` が `import { invoke } from './ipc'` で読む同じファイル)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ipc', () => ({ invoke: vi.fn() }));

import { invoke } from './ipc';
import {
	analyzeWaveform,
	analyzeWavWaveform,
	extractWaveformAudio,
	waveformBandNote,
} from './audio-waveform';
import type { WaveformExtraction } from './audio-waveform';

const invokeMock = vi.mocked(invoke);

const VIDEO_MOV = 'file:///Users/a/movies/seven-minutes-pcm.mov';
const VIDEO_MP4 = 'file:///Users/a/movies/long.mp4';
const AUDIO_WAV = 'file:///Users/a/audio/two-hours.wav';

beforeEach(() => {
	invokeMock.mockReset();
});

// ---------------------------------------------------------------------------
// AC-41-追i (e) — invokeWaveformBytes が Rust の拒否 too-large を写す
// ---------------------------------------------------------------------------

describe('extractWaveformAudio — Rust の拒否 too-large を { state: "too-large" } に写す(AC (e))', () => {
	it('extract_waveform_audio が "too-large" で拒否 → { state: "too-large" }', async () => {
		invokeMock.mockRejectedValueOnce('too-large');

		const result = await extractWaveformAudio(VIDEO_MOV);

		expect(result).toEqual({ state: 'too-large' });
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledWith('extract_waveform_audio', { uri: VIDEO_MOV });
	});

	it('拒否が Error オブジェクトで届いても同じ(String(err) に理由が含まれる)', async () => {
		invokeMock.mockRejectedValueOnce(new Error('too-large'));

		await expect(extractWaveformAudio(VIDEO_MOV)).resolves.toEqual({ state: 'too-large' });
	});

	it('mp4 も同じ受け口(要件#45 で mp4 も抽出経路)', async () => {
		invokeMock.mockRejectedValueOnce('too-large');

		await expect(extractWaveformAudio(VIDEO_MP4)).resolves.toEqual({ state: 'too-large' });
		expect(invokeMock).toHaveBeenCalledWith('extract_waveform_audio', { uri: VIDEO_MP4 });
	});

	it('too-large は no-audio / unreadable とは別の状態(帯の文言が変わる当のもの)', async () => {
		invokeMock.mockRejectedValueOnce('too-large');

		const result = await extractWaveformAudio(VIDEO_MOV);

		expect(result.state).not.toBe('no-audio');
		expect(result.state).not.toBe('unreadable');
	});
});

describe('analyzeWavWaveform — wav の解析も同じ受け口で too-large を写す', () => {
	it('analyze_wav_waveform が "too-large" で拒否 → { state: "too-large" }', async () => {
		invokeMock.mockRejectedValueOnce('too-large');

		await expect(analyzeWavWaveform(AUDIO_WAV)).resolves.toEqual({ state: 'too-large' });
		expect(invokeMock).toHaveBeenCalledWith('analyze_wav_waveform', { uri: AUDIO_WAV });
	});
});

// ---------------------------------------------------------------------------
// 不変(契約 3「ほかの理由の写し方」)
// ---------------------------------------------------------------------------

describe('不変 — ほかの理由の写し方と ok の受け取り', () => {
	it('no-audio / unsupported-codec / unreadable はそのまま・知らない理由は unreadable', async () => {
		const cases = [
			['no-audio', 'no-audio'],
			['unsupported-codec', 'unsupported-codec'],
			['unreadable', 'unreadable'],
			['something nobody expected', 'unreadable'],
			['', 'unreadable'],
		] as const;
		for (const [reason, state] of cases) {
			invokeMock.mockRejectedValueOnce(reason);
			await expect(extractWaveformAudio(VIDEO_MOV), `reason=${reason}`).resolves.toEqual({
				state,
			});
		}
	});

	it('拒否の理由が無い(undefined)→ unreadable(fail-open)', async () => {
		invokeMock.mockRejectedValueOnce(undefined);

		await expect(extractWaveformAudio(VIDEO_MOV)).resolves.toEqual({ state: 'unreadable' });
	});

	it('ok の raw バイト(ArrayBuffer)は ok のまま', async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		invokeMock.mockResolvedValueOnce(bytes.buffer);

		const result = await extractWaveformAudio(VIDEO_MOV);

		expect(result.state).toBe('ok');
		if (result.state === 'ok') {
			expect(new Uint8Array(result.bytes)).toEqual(bytes);
		}
	});
});

// ---------------------------------------------------------------------------
// 帯の写し(契約 2「動画の帯の文言は too-large の既存の写し方に従う」)
// ---------------------------------------------------------------------------

describe('帯の写し — 抽出の too-large はそのまま結果へ・文言は既存の too-large', () => {
	it('mov: 抽出が too-large → 解析結果も too-large・decode されない', async () => {
		const decode = vi.fn();
		const extract = vi.fn(async (): Promise<WaveformExtraction> => ({ state: 'too-large' }));

		const result = await analyzeWaveform(VIDEO_MOV, {
			durationSeconds: 420,
			hasAudioTrack: true,
			decode,
			extract,
		});

		expect(result).toEqual({ state: 'too-large' });
		expect(extract).toHaveBeenCalledTimes(1);
		expect(extract).toHaveBeenCalledWith(VIDEO_MOV);
		expect(decode).not.toHaveBeenCalled();
	});

	it('mp4: 同じ(抽出経路=要件#45)', async () => {
		const decode = vi.fn();
		const extract = vi.fn(async (): Promise<WaveformExtraction> => ({ state: 'too-large' }));

		const result = await analyzeWaveform(VIDEO_MP4, {
			durationSeconds: 420,
			hasAudioTrack: true,
			decode,
			extract,
		});

		expect(result).toEqual({ state: 'too-large' });
		expect(decode).not.toHaveBeenCalled();
	});

	it('wav: 解析の too-large もそのまま結果へ(音声ビューアの文言の根拠)', async () => {
		const decode = vi.fn();
		const extract = vi.fn();
		const analyzeWav = vi.fn(async (): Promise<WaveformExtraction> => ({ state: 'too-large' }));

		const result = await analyzeWaveform(AUDIO_WAV, {
			durationSeconds: 7200,
			hasAudioTrack: true,
			decode,
			extract,
			analyzeWav,
		});

		expect(result).toEqual({ state: 'too-large' });
		expect(analyzeWav).toHaveBeenCalledWith(AUDIO_WAV);
		expect(extract).not.toHaveBeenCalled();
		expect(decode).not.toHaveBeenCalled();
	});

	it('帯の文言は既存の too-large の文言(no-audio の文言ではない)', () => {
		expect(waveformBandNote({ state: 'too-large' }, false)).toBe(
			'The file is too large to build a waveform',
		);
		expect(waveformBandNote({ state: 'too-large' }, false)).not.toBe(
			waveformBandNote({ state: 'no-audio' }, false),
		);
	});
});
