/**
 * 要件#50 の受け入れテスト・1周目(requirements.md #50)
 * 「音声ファイル(wav / mp3 / m4a)をアプリ内で再生でき、プレーヤー画面に音声の波形を
 *  表示する。ステレオは左右チャンネルを別々に表示する」のうち、**1周目=分類・開く経路・
 *  再生の土台**の純関数部分をここで判定する。
 *
 * ## 本ファイルの判定範囲(1周目)
 * ①分類=`detectFileType` の `'audio'` 追加と `readsAsText` の遷移(契約①)
 * ②表示判定=`audioViewMode` の2値と `toAudioSrc`(契約②)
 * ③開く経路=`openCommandFor` / `openForDisplay` が `open_binary_document` を通ること(契約①後段)
 * ④表示ディスパッチ=`renderForDisplay` の `audioSrc`(契約①)
 * ⑤横軸の尺=`audioAxisDuration` の3規則(契約④(b))
 *
 * ## 周回分割
 * - 2周目(本ファイル末尾の「要件#50 2周目」セクションで判定): 契約④(a) の
 *   `durationSeconds` と契約⑬(b) の分離した2定数の**経路別の当たり先**。
 *   経路3枝化と fetch 上限定数そのものは audio-waveform.acceptance.test.ts の
 *   要件#50 セクション、帯の配線(レーン・ズーム・クリックシーク・縮退文言・高さ)は
 *   AudioViewer.wiring.test.ts が判定する
 * - 3周目(ここでは判定しない): wav の Rust 経路の中身(契約⑯⑰=
 *   src-tauri/tests/acceptance_req50.rs と TS 側受け口)
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * 1. `detectFileType`(src/lib/file-type.ts): `FileType` に `'audio'` を追加し、
 *    `AUDIO_EXTENSIONS` を新設して **wav / mp3 / m4a の3種だけ**を `'audio'` と判定する
 *    (大文字小文字不問・最終セグメントの最後の拡張子=既存の境界規則)。3種は
 *    `BINARY_EXTENSIONS` から移し、**flac / ogg は `binary` に据え置く**(WebKit の対応が
 *    版依存のため=要件#28 で mkv/avi をプレースホルダにした判断と同じ筋)。
 *    集合は video の前例どおり非公開でよく、固定は本ファイルの分類テーブルで行う。
 * 2. `readsAsText`(src/lib/image-viewing.ts): `'audio'` を false 側に加える
 *    (現状 binary は `open_document` を通り `FsError::InvalidUtf8` で開けない)。
 *    これにより `openCommandFor` は `open_binary_document` を返す(要件#22 の
 *    watch-only セッション=変更反映・削除追従が付随)。
 * 3. `renderForDisplay`(src/lib/file-type.ts): audio は本文を HTML に載せず
 *    `{ html: '', index: null, audioSrc: toAssetUri(uri) }` を返す(`videoSrc` /
 *    `pdfSrc` と同型)。`audioSrc` の存在が `AudioViewer.svelte` を選ぶ合図。
 * 4. `src/lib/audio-viewing.ts`(新規・純関数 VM。video-viewing.ts の家風):
 *    - `audioViewMode(uri: string): AudioViewMode`
 *      `type AudioViewMode = 'inline' | 'remote'` の**2値**(対象拡張子はすべて
 *      再生できる前提なので「非対応コンテナ」の枝を持たない=`videoViewMode` との差)。
 *      判別は URI スキームのみ(`ssh:` → `'remote'`・それ以外 `'inline'`)
 *    - `toAudioSrc(absoluteUri: string): string` = `toAssetUri`(toVideoSrc と同じ流儀)
 *    - `audioAxisDuration(mediaDuration: number | undefined, analyzedDuration: number | null | undefined): number`
 *      横軸に使う尺の優先規則(契約④(b)):
 *      (i) `<audio>` の duration が**有限かつ 0 超ならそれを採る**(VBR で不正確でも
 *          要素側を優先 ―― `currentTime` は要素のタイムライン上にあり、シークバーと
 *          波形が同じ軸に乗ることが着地精度より重要)
 *      (ii) 非有限(NaN / Infinity / undefined)または 0 以下なら解析尺
 *      (iii) どちらも無ければ 0
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - +page.svelte の audioSrc 分岐・binary_file_changed / file_removed の listen が
 *   音声にも効くこと(要件#28 の同項目と同じ扱い)
 * - AudioViewer.svelte の配線は AudioViewer.wiring.test.ts の持ち場
 *
 * ## 人間ゲート候補(機械判定不能 → acceptance/acceptance.md)
 * - 実ファイルでの再生の体感・2時間級の実ファイルのプローブ(契約③⑰=周回の初手)
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import { audioAxisDuration, audioViewMode, toAudioSrc } from './audio-viewing';
// 2周目(契約④(a)⑬(b))の判定対象。WAVEFORM_MAX_FETCH_BYTES(新設)は実装前でも
// モジュール読込が落ちないよう namespace 経由で参照する(audio-waveform.acceptance の
// #45/#50 セクションと同じ作法)。
import { WAVEFORM_MAX_SOURCE_BYTES, analyzeWaveform } from './audio-waveform';
import * as AudioWaveform from './audio-waveform';
import type { WaveformAudioBuffer, WaveformExtraction } from './audio-waveform';
import { detectFileType, renderForDisplay } from './file-type';
import { readsAsText } from './image-viewing';
import { openCommandFor, openForDisplay } from './open-document';
import { toAssetUri } from './uri';

const invokeMock = vi.mocked(invoke);

const ROOT = 'file:///Users/a/work';
const WAV = `${ROOT}/music/take.wav`;
const SSH_WAV = 'ssh://alice@host:22/remote/take.wav';

/** audio 分類の全3拡張子(契約①=BINARY_EXTENSIONS から移動)。 */
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a'] as const;
/** binary に据え置く音声拡張子(契約①=WebKit の対応が版依存)。 */
const HELD_BACK_EXTENSIONS = ['flac', 'ogg'] as const;

beforeEach(() => {
	invokeMock.mockReset();
});

/** 名前→判定結果のレコードにして、失敗時にどの名前が外れたか見えるようにする */
function classify(names: string[]): Record<string, string> {
	return Object.fromEntries(names.map((n) => [n, detectFileType(n)]));
}

function expectAll(
	names: string[],
	expected: 'markdown' | 'html' | 'text' | 'binary' | 'image' | 'model3d' | 'video' | 'pdf' | 'audio',
) {
	expect(classify(names)).toEqual(Object.fromEntries(names.map((n) => [n, expected])));
}

// ---------------------------------------------------------------------------
// detectFileType — audio 分類(要件#50 契約①)
// ---------------------------------------------------------------------------

describe('detectFileType — 音声3拡張子を audio と判定する(要件#50 契約①)', () => {
	test('ベース名の wav / mp3 / m4a は audio', () => {
		expectAll(
			AUDIO_EXTENSIONS.map((ext) => `take.${ext}`),
			'audio',
		);
	});

	test('大文字小文字を問わない', () => {
		expectAll(['TAKE.WAV', 'Song.MP3', 'a.M4a'], 'audio');
	});

	test('パス・file:// URI・ssh:// URI でも最終セグメントの拡張子で判定する(ssh も分類は audio=プレースホルダ判定は VM の持ち場)', () => {
		expect(detectFileType('/tmp/take.wav')).toBe('audio');
		expect(detectFileType(WAV)).toBe('audio');
		expect(detectFileType(SSH_WAV)).toBe('audio');
	});

	test('最後の拡張子だけで判定する(既存の境界規則の継承)', () => {
		expect(detectFileType('song.mp3.txt')).toBe('text');
		expect(detectFileType('notes.txt.wav')).toBe('audio');
		expect(detectFileType('backup.m4a.gz')).toBe('binary');
	});

	test('ディレクトリ名中の .mp3 を拡張子と誤認しない', () => {
		expect(detectFileType('file:///home/user.mp3/Makefile')).toBe('text');
	});

	test('flac / ogg は binary に据え置く(契約①=WebKit の対応が版依存・v1.1 候補)', () => {
		expectAll(
			HELD_BACK_EXTENSIONS.map((ext) => `album.${ext}`),
			'binary',
		);
	});

	test('非音声の既存 binary は不変(zip / gz / exe / dll / woff2 / tiff / heic / dmg)', () => {
		expectAll(
			['a.zip', 'a.gz', 'setup.exe', 'a.dll', 'font.woff2', 'scan.tiff', 'iphone.heic', 'disk.dmg'],
			'binary',
		);
	});

	test('既存分類は不変(markdown / html / image / model3d / video / pdf / text)', () => {
		expect(detectFileType('README.md')).toBe('markdown');
		expect(detectFileType('page.html')).toBe('html');
		expect(detectFileType('icon.svg')).toBe('image');
		expect(detectFileType('photo.png')).toBe('image');
		expect(detectFileType('part.stl')).toBe('model3d');
		expect(detectFileType('clip.mp4')).toBe('video');
		expect(detectFileType('clip.mkv')).toBe('video');
		expect(detectFileType('spec.pdf')).toBe('pdf');
		expect(detectFileType('notes.txt')).toBe('text');
		expect(detectFileType('data.xyz')).toBe('text'); // 未知拡張子のフォールバックも不変
		expect(detectFileType('Makefile')).toBe('text');
	});
});

// ---------------------------------------------------------------------------
// readsAsText — audio はテキスト読込を通さない(契約①後段)
// ---------------------------------------------------------------------------

describe('readsAsText — audio は open_document のテキスト読み経路へ流さない(要件#50 契約①)', () => {
	test('3拡張子すべて false(ローカル・ssh とも)', () => {
		for (const ext of AUDIO_EXTENSIONS) {
			expect(readsAsText(`take.${ext}`), `.${ext}`).toBe(false);
			expect(readsAsText(`${ROOT}/music/take.${ext}`), `file .${ext}`).toBe(false);
			expect(readsAsText(`ssh://alice@host:22/remote/take.${ext}`), `ssh .${ext}`).toBe(false);
		}
	});

	test('既存の判定は不変(md/html/txt/svg=true・ラスタ/model3d/video/pdf=false)', () => {
		expect(readsAsText('README.md')).toBe(true);
		expect(readsAsText('report.html')).toBe(true);
		expect(readsAsText('notes.txt')).toBe(true);
		expect(readsAsText('icon.svg')).toBe(true);
		expect(readsAsText('photo.png')).toBe(false);
		expect(readsAsText('part.stl')).toBe(false);
		expect(readsAsText('clip.mp4')).toBe(false);
		expect(readsAsText('spec.pdf')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 経路選択 — audio は open_binary_document(契約①後段=要件#22 基盤の再利用)
// ---------------------------------------------------------------------------

describe('経路選択 — audio は watch-only セッションを張る(要件#50 契約①)', () => {
	test('openCommandFor: 3拡張子すべて open_binary_document', () => {
		for (const ext of AUDIO_EXTENSIONS) {
			expect(openCommandFor(`${ROOT}/music/take.${ext}`), `.${ext}`).toBe('open_binary_document');
		}
	});

	test('openCommandFor: 既存の振り分けは不変', () => {
		expect(openCommandFor(`${ROOT}/notes/plan.md`)).toBe('open_document');
		expect(openCommandFor(`${ROOT}/pics/diagram.svg`)).toBe('open_document');
		expect(openCommandFor(`${ROOT}/pics/photo.png`)).toBe('open_binary_document');
		expect(openCommandFor(`${ROOT}/movies/clip.mp4`)).toBe('open_binary_document');
	});

	test('openForDisplay: 音声は open_binary_document を1回呼び、解決値をそのまま返す', async () => {
		const payload = { uri: WAV, content: '', modified: null };
		invokeMock.mockResolvedValue(payload);

		const res = await openForDisplay(WAV);

		expect(invokeMock.mock.calls).toEqual([['open_binary_document', { uri: WAV }]]);
		expect(res).toBe(payload);
	});
});

// ---------------------------------------------------------------------------
// audioViewMode / toAudioSrc — 表示判定の一点集約(契約②)
// ---------------------------------------------------------------------------

describe('audioViewMode — inline / remote の2値(要件#50 契約②)', () => {
	test('ローカルの wav / mp3 / m4a はインライン再生(inline)', () => {
		for (const ext of AUDIO_EXTENSIONS) {
			expect(audioViewMode(`${ROOT}/music/take.${ext}`), `.${ext}`).toBe('inline');
		}
	});

	test('ssh リモートは3拡張子とも remote(要件#19 の前例どおり導線なしプレースホルダ)', () => {
		for (const ext of AUDIO_EXTENSIONS) {
			expect(audioViewMode(`ssh://alice@host:22/remote/take.${ext}`), `.${ext}`).toBe('remote');
		}
	});

	test('リモート判別は URI スキームのみ(パス中の "ssh" では分岐しない)', () => {
		expect(audioViewMode(`${ROOT}/ssh/take.mp3`)).toBe('inline');
	});
});

describe('toAudioSrc — <audio src> 用の vellis-asset: URI 構築(要件#50 契約②)', () => {
	test('ローカル絶対 URI を vellis-asset://local/… へ変換する(toAssetUri と同値)', () => {
		expect(toAudioSrc(WAV)).toBe('vellis-asset://local/Users/a/work/music/take.wav');
		expect(toAudioSrc(WAV)).toBe(toAssetUri(WAV));
	});

	test('ssh リモート URI も toAssetUri と同値', () => {
		expect(toAudioSrc(SSH_WAV)).toBe(toAssetUri(SSH_WAV));
	});
});

// ---------------------------------------------------------------------------
// renderForDisplay — audio は audioSrc で AudioViewer を選ぶ(契約①)
// ---------------------------------------------------------------------------

describe('renderForDisplay — audio の表示ディスパッチ(要件#50 契約①)', () => {
	test('ローカル3拡張子すべて: audioSrc = vellis-asset URI・html は空・index は null', async () => {
		for (const ext of AUDIO_EXTENSIONS) {
			const uri = `${ROOT}/music/take.${ext}`;
			const res = await renderForDisplay(uri, '');
			expect(res.audioSrc, uri).toBe(toAssetUri(uri));
			expect(res.html, uri).toBe('');
			expect(res.index, uri).toBeNull();
			// 他のビューアの合図と排他(audioSrc の存在だけが AudioViewer を選ぶ)
			expect(res.srcdoc, uri).toBeUndefined();
			expect(res.imageSrc, uri).toBeUndefined();
			expect(res.modelSrc, uri).toBeUndefined();
			expect(res.videoSrc, uri).toBeUndefined();
			expect(res.pdfSrc, uri).toBeUndefined();
		}
	});

	test('ssh 音声も audioSrc 経路に乗る(プレースホルダの出し分けは audioViewMode の持ち場)', async () => {
		const res = await renderForDisplay(SSH_WAV, '');
		expect(res.audioSrc).toBe(toAssetUri(SSH_WAV));
		expect(res.html).toBe('');
		expect(res.index).toBeNull();
	});

	test('audio 以外に audioSrc は付かない(既存経路の不変)', async () => {
		const image = await renderForDisplay(`${ROOT}/pics/photo.png`, '');
		expect(image.audioSrc).toBeUndefined();
		expect(image.imageSrc).toBe(toAssetUri(`${ROOT}/pics/photo.png`));

		const video = await renderForDisplay(`${ROOT}/movies/clip.mp4`, '');
		expect(video.audioSrc).toBeUndefined();
		expect(video.videoSrc).toBe(toAssetUri(`${ROOT}/movies/clip.mp4`));

		const text = await renderForDisplay(`${ROOT}/notes/memo.txt`, 'hello');
		expect(text.audioSrc).toBeUndefined();
		expect(text.html).toContain('hello');

		// flac は据え置き=従来どおり binary プレースホルダ(契約①)
		const flac = await renderForDisplay(`${ROOT}/music/album.flac`, '');
		expect(flac.audioSrc).toBeUndefined();
		expect(flac.html).toContain('vellis-unsupported');
	});
});

// ---------------------------------------------------------------------------
// audioAxisDuration — 横軸に使う尺の優先規則(契約④(b))
// ---------------------------------------------------------------------------

describe('audioAxisDuration — 横軸の尺の3規則(要件#50 契約④)', () => {
	test('規則(i): 要素の duration が有限かつ 0 超なら要素側を採る(解析尺と食い違う VBR でも)', () => {
		expect(audioAxisDuration(3600, 3612.5)).toBe(3600);
		expect(audioAxisDuration(0.5, null)).toBe(0.5);
		// 解析尺が無くても要素側だけで立つ
		expect(audioAxisDuration(120, undefined)).toBe(120);
	});

	test('規則(ii): 要素の duration が非有限(NaN / Infinity / undefined)なら解析尺', () => {
		expect(audioAxisDuration(Number.NaN, 120.5)).toBe(120.5);
		expect(audioAxisDuration(Number.POSITIVE_INFINITY, 120.5)).toBe(120.5);
		expect(audioAxisDuration(undefined, 120.5)).toBe(120.5);
	});

	test('規則(ii): 要素の duration が 0 以下でも解析尺', () => {
		expect(audioAxisDuration(0, 120.5)).toBe(120.5);
		expect(audioAxisDuration(-1, 120.5)).toBe(120.5);
	});

	test('規則(iii): どちらも無ければ 0', () => {
		expect(audioAxisDuration(Number.NaN, null)).toBe(0);
		expect(audioAxisDuration(undefined, undefined)).toBe(0);
		expect(audioAxisDuration(0, 0)).toBe(0);
	});
});

// ===========================================================================
// 要件#50 2周目 — 解析尺 durationSeconds と上限の当たり先(契約④(a)⑬(b)(c)(d))
// ===========================================================================
//
// ## 確定契約(implementer はこれに従う)
// - 契約④(a): `analyzeWaveform` の ready 結果に **`durationSeconds`
//   (= `decoded.length / decoded.sampleRate`)を追加**する。算出は保持量
//   (retention)判定より**前**で、`samples: null` に縮退した長尺でも必ず埋まる。
//   `WaveformResult` の ready 型への追加は契約⑤の「受け口のみ改変」が明示的に許容する
//   (実装前は undefined なので照合は toMatchObject で赤になる)
// - 契約⑬(b): 上限の門は経路別 ―― fetch 経路(mp3 / m4a / webm)=新設
//   `WAVEFORM_MAX_FETCH_BYTES` 512MiB・extract 経路(mov / mp4 の抽出後音声バイト)=
//   `WAVEFORM_MAX_SOURCE_BYTES` 256MiB **据え置き**(512 へ引き上げない)
// - 契約⑬(c): wav はどちらの門も通らない(wav 経路は fetch / extract を呼ばない。
//   経路3枝そのものは audio-waveform.acceptance.test.ts の #50 セクションが固定)
//
// 定数値そのもの(512MiB / 256MiB)の固定と loadWaveformSource の二重判定の意味は
// audio-waveform.acceptance.test.ts の持ち場。ここは「音声3種+動画がどの門に
// 当たるか」と「解析尺が縮退と独立に返ること」を統合(analyzeWaveform)で判定する。

/** 構造的 AudioBuffer(audio-waveform.acceptance と同じ作法)。 */
function audioBuf(channels: Float32Array[], sampleRate = 8000): WaveformAudioBuffer {
	return {
		numberOfChannels: channels.length,
		length: channels[0]?.length ?? 0,
		sampleRate,
		getChannelData: (channel: number) => channels[channel],
	};
}

/** decode モック(受け取ったバイト列を無視して固定の AudioBuffer を返す)。 */
function decodeTo(buffer: WaveformAudioBuffer) {
	return vi.fn(async (_bytes: ArrayBuffer) => buffer);
}

/** extract モック(抽出経路の応答を固定で返す)。 */
function extractTo(extraction: WaveformExtraction) {
	return vi.fn(async (_videoUri: string) => extraction);
}

/**
 * fetch モックへ返す Response もどき(audio-waveform.acceptance の fakeResponse の
 * 縮約版)。declared: null =ヘッダ無し・number =その申告値。本文読み
 * (arrayBuffer/bytes)は spy で観測する。
 */
function fakeAudioResponse(body: Uint8Array, declared?: number | null) {
	const declaredLength = declared === undefined ? body.byteLength : declared;
	return {
		ok: true,
		status: 200,
		headers: {
			get: (name: string) =>
				name.toLowerCase() === 'content-length' && declaredLength !== null
					? String(declaredLength)
					: null,
		},
		arrayBuffer: vi.fn(async () => body.buffer),
		bytes: vi.fn(async () => body),
	};
}

/** fetch 側の上限(新設 export)。実装前は assertion で赤(モジュール読込は落とさない)。 */
function fetchLimitBytes(): number {
	const value = (AudioWaveform as unknown as Record<string, unknown>).WAVEFORM_MAX_FETCH_BYTES;
	expect(
		value,
		'WAVEFORM_MAX_FETCH_BYTES(要件#50 契約⑬(b))が export されていること',
	).toBeTypeOf('number');
	return value as number;
}

describe('analyzeWaveform — 解析尺 durationSeconds(要件#50 契約④(a)⑬(d))', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(fakeAudioResponse(new Uint8Array([1, 2, 3])));
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('短尺ステレオ(samples 保持あり): durationSeconds = decoded.length / decoded.sampleRate', async () => {
		// 12000 標本 @8kHz = 1.5 秒。ステレオでもフレーム数で数える(レーン数を掛けない)。
		const buffer = audioBuf([new Float32Array(12000), new Float32Array(12000)], 8000);
		const result = await analyzeWaveform(`${ROOT}/music/song.mp3`, {
			durationSeconds: null,
			hasAudioTrack: null,
			decode: decodeTo(buffer),
			extract: extractTo({ state: 'unreadable' }),
		});
		expect(result).toMatchObject({ state: 'ready', durationSeconds: 12000 / 8000 });
		if (result.state === 'ready') {
			expect(result.samples).not.toBeNull();
		}
	});

	test('長尺相当(保持量縮退で samples: null)でも durationSeconds は必ず埋まる(算出は retention 判定より前)', async () => {
		// 実サイズ(70分超)は unit テストで作れないので、注入 seam(maxRetainedSamples)で
		// 縮退だけを起こす(waveform-zoom.acceptance の保持縮退ケースと同じ作法)。
		const buffer = audioBuf([new Float32Array(10), new Float32Array(10)], 8000);
		const result = await analyzeWaveform(`${ROOT}/music/song.mp3`, {
			durationSeconds: null,
			hasAudioTrack: null,
			decode: decodeTo(buffer),
			extract: extractTo({ state: 'unreadable' }),
			maxRetainedSamples: 16, // 2 レーン×10 = 20 > 16 → samples: null
		});
		expect(result).toMatchObject({
			state: 'ready',
			samples: null,
			durationSeconds: 10 / 8000,
		});
	});

	test('durationSeconds は保持量の縮退と独立(同じ素材なら seam の有無で値が変わらない)', async () => {
		const buffer = audioBuf([new Float32Array(10), new Float32Array(10)], 8000);
		const input = {
			durationSeconds: null,
			hasAudioTrack: null,
			decode: decodeTo(buffer),
			extract: extractTo({ state: 'unreadable' } as WaveformExtraction),
		};
		const kept = await analyzeWaveform(`${ROOT}/music/voice.m4a`, input);
		const degraded = await analyzeWaveform(`${ROOT}/music/voice.m4a`, {
			...input,
			maxRetainedSamples: 16,
		});
		expect(kept).toMatchObject({ state: 'ready', durationSeconds: 10 / 8000 });
		expect(degraded).toMatchObject({ state: 'ready', durationSeconds: 10 / 8000 });
	});
});

describe('analyzeWaveform — 上限の門は経路別(要件#50 契約⑬(b)(c))', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const smallBuffer = () => audioBuf([Float32Array.from([0.5, -0.5])]);

	test('mp3 / m4a(fetch 経路)は 512MiB の門: 申告が超なら too-large・本文は読まない', async () => {
		for (const name of ['song.mp3', 'voice.m4a']) {
			const response = fakeAudioResponse(new Uint8Array([1, 2, 3]), fetchLimitBytes() + 1);
			fetchMock.mockResolvedValueOnce(response);
			const decode = decodeTo(smallBuffer());
			expect(
				await analyzeWaveform(`${ROOT}/music/${name}`, {
					durationSeconds: null,
					hasAudioTrack: null,
					decode,
					extract: extractTo({ state: 'unreadable' }),
				}),
				name,
			).toMatchObject({ state: 'too-large' });
			expect(response.arrayBuffer, name).not.toHaveBeenCalled();
			expect(response.bytes, name).not.toHaveBeenCalled();
			expect(decode, name).not.toHaveBeenCalled();
		}
	});

	test('fetch 側の門は 256MiB ではない: 旧上限超・512MiB 以下の申告は通る(2時間 mp3=275MiB が通る方向の引き上げ)', async () => {
		fetchMock.mockResolvedValueOnce(
			fakeAudioResponse(new Uint8Array([1, 2, 3]), WAVEFORM_MAX_SOURCE_BYTES + 1),
		);
		const result = await analyzeWaveform(`${ROOT}/music/song.mp3`, {
			durationSeconds: null,
			hasAudioTrack: null,
			decode: decodeTo(smallBuffer()),
			extract: extractTo({ state: 'unreadable' }),
		});
		expect(result).toMatchObject({ state: 'ready' });
	});

	test('mov / mp4(extract 経路)は 256MiB の門のまま: 抽出後音声バイトが 256MiB 超なら too-large(512 へ引き上げない)', async () => {
		const decode = decodeTo(smallBuffer());
		const result = await analyzeWaveform('file:///Users/a/movies/final.mp4', {
			durationSeconds: null,
			hasAudioTrack: true,
			decode,
			extract: extractTo({
				state: 'ok',
				bytes: new ArrayBuffer(WAVEFORM_MAX_SOURCE_BYTES + 1),
			}),
		});
		expect(result).toMatchObject({ state: 'too-large' });
		expect(decode).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test('wav はどちらの門も通らない(fetch / extract を呼ばない=契約⑬(c)。経路の中身は3周目)', async () => {
		const extract = extractTo({ state: 'unreadable' });
		await analyzeWaveform(WAV, {
			durationSeconds: 7200,
			hasAudioTrack: null,
			decode: decodeTo(smallBuffer()),
			extract,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(extract).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 要件#50 3周目 — wav の Rust 経路の TS 受け口(契約⑯⑤(ii))と
// 食い違い記録の判定(契約④(b))
// ===========================================================================
//
// ## 確定契約(implementer はこれに従う)
//
// - `src/lib/audio-waveform.ts` に追加:
//   - `export type WavWaveformAnalysis =
//        | { state: 'ok'; bytes: ArrayBuffer }
//        | { state: 'no-audio' } | { state: 'unsupported-codec' } | { state: 'unreadable' }`
//   - `export type WaveformAnalyzeWav = (uri: string) => Promise<WavWaveformAnalysis>`
//   - `analyzeWaveform` の input に **`analyzeWav?: WaveformAnalyzeWav`** を追加
//     (`extract` と同型の注入 seam。**省略可**=既存呼び出しと2周目の縮退を壊さない)
//   - `export async function analyzeWavWaveform(uri: string): Promise<WavWaveformAnalysis>`
//     = `invoke<ArrayBuffer>('analyze_wav_waveform', { uri })` の実体。reject の文字列に
//     `no-audio` / `unsupported-codec` を含めばその状態・それ以外は `unreadable`
//     (`extractWaveformAudio` と同じ写像)。ArrayBuffer / view どちらで届いても ok に写す
// - wav 経路(`plan.route === 'wav'`)の受け口:
//   - seam 未注入 → `{ state: 'unreadable' }`(2周目の挙動を維持=fail-open)
//   - seam の reject / 同期 throw → `unreadable`(throw しない)
//   - 縮退応答(`no-audio` / `unsupported-codec` / `unreadable`)→ そのまま state へ
//   - ok → raw レイアウト(下記)を読み ready へ写す。**壊れた raw(全長がヘッダの
//     申告と合わない・短すぎる)は `unreadable`**(throw しない)
// - raw レイアウト(**全て little-endian**。Rust 側の正本= src-tauri/tests/
//   acceptance_req50.rs のヘッダ doc と同一):
//   `u32 channels`(0)・`u32 sampleRate=8000`(4)・`u32 frames`(8)・
//   `u32 coarseStep=512`(12)・`u32 coarseLen`(16)・`u32 hasSamples`(20)・
//   `f64 durationSeconds`(24)・以降 hasSamples=1 のときレーン順に frames 個の f32、
//   続けてレーン順に「mins が coarseLen 個 → maxs が coarseLen 個」の f32。
//   レーン数は channels==2 なら 2・それ以外は 1(追補d の既存規則)
// - ready への写像:
//   - `samples` = raw のレーン列(hasSamples=0 なら `null` =要件#47 契約⑦の既存縮退
//     =最小窓 `waveformMinWindowSeconds(true, 8000)` = 128 秒に乗る)
//   - `lanes` = samples があれば各レーンの `extractPeaks(lane, WAVEFORM_BUCKETS)`・
//     無ければ `windowPeaksFromCoarse(coarse, 8000, 0, (coarseLen×WAVEFORM_COARSE_STEP)/8000,
//     WAVEFORM_BUCKETS)`(=全尺の窓)
//   - `coarse` = raw のまま(**再計算しない** ―― Rust は生標本から直接採るため
//     包絡が広い側にあり、それを保つ=契約⑯(b))
//   - `sampleRate` / `durationSeconds` = ヘッダのまま(解析尺は契約④(a) と同じ意味)
// - `src/lib/audio-viewing.ts` に追加:
//   - `export function durationMismatch(mediaDuration: number | undefined,
//        analyzedDuration: number | null | undefined): boolean`
//     契約④(b) の記録判定。**両方が有限かつ 0 超のときだけ**判定し、差が
//     「両者の大きい側の 1%」**または**「1 秒」を**超える**とき true(ちょうどは
//     false)。表示は要素側の軸のまま(`audioAxisDuration` は不変)。記録の配線
//     (console.warn)は AudioViewer.wiring.test.ts の持ち場
import { WAVEFORM_BUCKETS, extractPeaks } from './audio-waveform';
import { WAVEFORM_COARSE_STEP, windowPeaksFromCoarse } from './waveform-zoom';
import * as AudioViewing from './audio-viewing';

/** seam の応答型(実装前でもモジュール読込が落ちないよう、型はローカルに持つ)。 */
type WavAnalyzeResponse =
	| { state: 'ok'; bytes: ArrayBuffer }
	| { state: 'no-audio' }
	| { state: 'unsupported-codec' }
	| { state: 'unreadable' };

/** analyzeWav seam のモック(extractTo と同型)。 */
function analyzeWavTo(response: WavAnalyzeResponse) {
	return vi.fn(async (_uri: string) => response);
}

/** raw 応答(上記レイアウト)をテスト側で組む。Rust 実装と同じバイト列の正本。 */
function wavAnalysisRaw(input: {
	channels: number;
	frames: number;
	durationSeconds: number;
	samples: Float32Array[] | null;
	coarse: { mins: Float32Array; maxs: Float32Array }[];
	sampleRate?: number;
	coarseStep?: number;
}): ArrayBuffer {
	const lanes = input.samples?.length ?? input.coarse.length;
	const coarseLen = input.coarse[0]?.mins.length ?? 0;
	const sampleBytes = input.samples ? lanes * input.frames * 4 : 0;
	const buffer = new ArrayBuffer(32 + sampleBytes + lanes * coarseLen * 8);
	const view = new DataView(buffer);
	view.setUint32(0, input.channels, true);
	view.setUint32(4, input.sampleRate ?? 8000, true);
	view.setUint32(8, input.frames, true);
	view.setUint32(12, input.coarseStep ?? WAVEFORM_COARSE_STEP, true);
	view.setUint32(16, coarseLen, true);
	view.setUint32(20, input.samples ? 1 : 0, true);
	view.setFloat64(24, input.durationSeconds, true);
	let at = 32;
	if (input.samples) {
		for (const lane of input.samples) {
			for (const v of lane) {
				view.setFloat32(at, v, true);
				at += 4;
			}
		}
	}
	for (const lane of input.coarse) {
		for (const v of lane.mins) {
			view.setFloat32(at, v, true);
			at += 4;
		}
		for (const v of lane.maxs) {
			view.setFloat32(at, v, true);
			at += 4;
		}
	}
	return buffer;
}

/** 決定的な f32 標本列(丸めの影響を受けないよう Float32Array を先に確定させる)。 */
function deterministicLane(length: number, seed: number): Float32Array {
	const lane = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		lane[i] = (((i * 37 + seed * 11) % 201) - 100) / 100;
	}
	return lane;
}

describe('analyzeWaveform — wav 受け口(要件#50 契約⑯・3周目)', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** wav 経路の共通 input(seam 以外は「呼ばれないこと」の観測点)。 */
	function wavInput(analyzeWav: ReturnType<typeof analyzeWavTo>) {
		return {
			durationSeconds: null,
			hasAudioTrack: null,
			decode: decodeTo(audioBuf([Float32Array.from([0.5])])),
			extract: extractTo({ state: 'unreadable' } as WaveformExtraction),
			analyzeWav,
		};
	}

	test('wav では analyzeWav seam が URI で1回呼ばれ、fetch / extract / decode は呼ばれない(契約⑤⑬(c))', async () => {
		const raw = wavAnalysisRaw({
			channels: 1,
			frames: 4,
			durationSeconds: 0.5,
			samples: [Float32Array.from([0.1, -0.2, 0.3, -0.4])],
			coarse: [{ mins: Float32Array.from([-0.4]), maxs: Float32Array.from([0.3]) }],
		});
		const analyzeWav = analyzeWavTo({ state: 'ok', bytes: raw });
		const input = wavInput(analyzeWav);

		const result = await analyzeWaveform(WAV, input);

		expect(analyzeWav.mock.calls).toEqual([[WAV]]);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(input.extract).not.toHaveBeenCalled();
		expect(input.decode).not.toHaveBeenCalled();
		expect(result.state).toBe('ready');
	});

	test('raw 応答(ステレオ・samples あり)→ ready: lanes は samples の extractPeaks・coarse はヘッダのまま(再計算しない)・durationSeconds は Rust の解析尺', async () => {
		const l = deterministicLane(1024, 1);
		const r = deterministicLane(1024, 2);
		// coarse は samples から再計算した値と**わざと違う**広い包絡にして、
		// 「Rust の粗レベルをそのまま使う(生標本由来の広さを保つ)」ことを固定する。
		const coarse = [
			{ mins: Float32Array.from([-1.5, -1.25]), maxs: Float32Array.from([1.5, 1.25]) },
			{ mins: Float32Array.from([-1.75, -1.5]), maxs: Float32Array.from([1.75, 1.5]) },
		];
		const raw = wavAnalysisRaw({
			channels: 2,
			frames: 1024,
			durationSeconds: 12.5, // frames/8000=0.128 とは別=ヘッダの解析尺が採られる証明
			samples: [l, r],
			coarse,
		});

		const result = await analyzeWaveform(WAV, wavInput(analyzeWavTo({ state: 'ok', bytes: raw })));

		expect(result.state).toBe('ready');
		if (result.state !== 'ready') return;
		expect(result.lanes).toEqual([extractPeaks(l, WAVEFORM_BUCKETS), extractPeaks(r, WAVEFORM_BUCKETS)]);
		expect(result.samples).toEqual([l, r]);
		expect(result.coarse).toEqual(coarse);
		expect(result.sampleRate).toBe(8000);
		expect(result.durationSeconds).toBe(12.5);
	});

	test('mono の raw 応答 → 1レーン', async () => {
		const lane = deterministicLane(512, 3);
		const raw = wavAnalysisRaw({
			channels: 1,
			frames: 512,
			durationSeconds: 0.064,
			samples: [lane],
			coarse: [{ mins: Float32Array.from([-1]), maxs: Float32Array.from([1]) }],
		});

		const result = await analyzeWaveform(WAV, wavInput(analyzeWavTo({ state: 'ok', bytes: raw })));

		expect(result.state).toBe('ready');
		if (result.state !== 'ready') return;
		expect(result.lanes).toEqual([extractPeaks(lane, WAVEFORM_BUCKETS)]);
		expect(result.samples).toEqual([lane]);
	});

	test('samples 無し(長尺縮退)の raw 応答 → samples: null のまま・lanes は coarse から合成(windowPeaksFromCoarse と同値)', async () => {
		// frames は WAVEFORM_COARSE_STEP の倍数にして、全尺窓の合成が一意に決まる形で固定する。
		const frames = 4 * WAVEFORM_COARSE_STEP; // 2048
		const coarse = [
			{ mins: deterministicLane(4, 4).map((v) => -Math.abs(v)), maxs: deterministicLane(4, 5).map(Math.abs) },
			{ mins: deterministicLane(4, 6).map((v) => -Math.abs(v)), maxs: deterministicLane(4, 7).map(Math.abs) },
		];
		const raw = wavAnalysisRaw({
			channels: 2,
			frames,
			durationSeconds: 9000.125, // 2時間超の解析尺も f64 でそのまま届く
			samples: null,
			coarse,
		});

		const result = await analyzeWaveform(WAV, wavInput(analyzeWavTo({ state: 'ok', bytes: raw })));

		expect(result.state).toBe('ready');
		if (result.state !== 'ready') return;
		expect(result.samples).toBeNull();
		expect(result.coarse).toEqual(coarse);
		const windowSeconds = (4 * WAVEFORM_COARSE_STEP) / 8000;
		expect(result.lanes).toEqual([
			windowPeaksFromCoarse(coarse[0], 8000, 0, windowSeconds, WAVEFORM_BUCKETS),
			windowPeaksFromCoarse(coarse[1], 8000, 0, windowSeconds, WAVEFORM_BUCKETS),
		]);
		expect(result.durationSeconds).toBe(9000.125);
	});

	test('Rust の縮退(no-audio / unsupported-codec / unreadable)はそのまま state へ写る', async () => {
		for (const state of ['no-audio', 'unsupported-codec', 'unreadable'] as const) {
			const result = await analyzeWaveform(WAV, wavInput(analyzeWavTo({ state })));
			expect(result, state).toEqual({ state });
		}
	});

	test('seam の reject・壊れた raw(全長がヘッダの申告と合わない)→ unreadable(throw しない=fail-open)', async () => {
		const rejecting = vi.fn(async (_uri: string): Promise<WavAnalyzeResponse> => {
			throw new Error('ipc down');
		});
		expect(await analyzeWaveform(WAV, wavInput(rejecting))).toEqual({ state: 'unreadable' });

		// ヘッダにすら足りない 3 バイト。
		expect(
			await analyzeWaveform(WAV, wavInput(analyzeWavTo({ state: 'ok', bytes: new ArrayBuffer(3) }))),
		).toEqual({ state: 'unreadable' });

		// ヘッダは frames=4・hasSamples=1(全長 56 バイト)を申告するが、32 バイトで切れている。
		const lying = wavAnalysisRaw({
			channels: 1,
			frames: 4,
			durationSeconds: 1,
			samples: [Float32Array.from([0, 0, 0, 0])],
			coarse: [{ mins: Float32Array.from([0]), maxs: Float32Array.from([0]) }],
		}).slice(0, 32);
		expect(
			await analyzeWaveform(WAV, wavInput(analyzeWavTo({ state: 'ok', bytes: lying }))),
		).toEqual({ state: 'unreadable' });
	});

	test('seam 未注入(2周目の状態)→ unreadable(fail-open・throw しない)', async () => {
		const result = await analyzeWaveform(WAV, {
			durationSeconds: null,
			hasAudioTrack: null,
			decode: decodeTo(audioBuf([Float32Array.from([0.5])])),
			extract: extractTo({ state: 'unreadable' }),
		});
		expect(result).toEqual({ state: 'unreadable' });
	});

	test('analyzeWavWaveform — invoke("analyze_wav_waveform") の写像(ok=raw バイト・拒否語彙=状態・未知の失敗=unreadable)', async () => {
		const fn = (AudioWaveform as unknown as Record<string, unknown>).analyzeWavWaveform;
		expect(fn, 'analyzeWavWaveform(要件#50 契約⑯)が export されていること').toBeTypeOf(
			'function',
		);
		const analyzeWavWaveform = fn as (uri: string) => Promise<WavAnalyzeResponse>;

		const raw = new ArrayBuffer(32);
		invokeMock.mockResolvedValueOnce(raw);
		const ok = await analyzeWavWaveform(WAV);
		expect(invokeMock.mock.calls).toEqual([['analyze_wav_waveform', { uri: WAV }]]);
		expect(ok.state).toBe('ok');
		if (ok.state === 'ok') expect(ok.bytes.byteLength).toBe(32);

		invokeMock.mockRejectedValueOnce('no-audio');
		expect(await analyzeWavWaveform(WAV)).toEqual({ state: 'no-audio' });
		invokeMock.mockRejectedValueOnce('unsupported-codec');
		expect(await analyzeWavWaveform(WAV)).toEqual({ state: 'unsupported-codec' });
		invokeMock.mockRejectedValueOnce(new Error('boom'));
		expect(await analyzeWavWaveform(WAV)).toEqual({ state: 'unreadable' });
	});
});

// ---------------------------------------------------------------------------
// durationMismatch — 要素申告と解析尺の食い違い判定(要件#50 契約④(b))
// ---------------------------------------------------------------------------

describe('durationMismatch — 要素申告と解析尺の食い違い判定(要件#50 契約④(b))', () => {
	/** 実装前でもモジュール読込が落ちないよう namespace 経由で参照する(既存の作法)。 */
	function durationMismatchFn(): (
		mediaDuration: number | undefined,
		analyzedDuration: number | null | undefined,
	) => boolean {
		const fn = (AudioViewing as unknown as Record<string, unknown>).durationMismatch;
		expect(fn, 'durationMismatch(要件#50 契約④(b))が export されていること').toBeTypeOf(
			'function',
		);
		return fn as (m: number | undefined, a: number | null | undefined) => boolean;
	}

	test('1 秒以内かつ 1% 以内 → false(一致・ちょうど 1 秒・ちょうど 1% は記録しない)', () => {
		const durationMismatch = durationMismatchFn();
		expect(durationMismatch(7200, 7200)).toBe(false);
		expect(durationMismatch(7200, 7201)).toBe(false); // 差ちょうど 1 秒(1% = 72 秒以内)
		expect(durationMismatch(0.5, 0.505)).toBe(false); // 差ちょうど 1%(1 秒以内)
		expect(durationMismatch(60, 60.5)).toBe(false); // 0.83%・0.5 秒
	});

	test('1 秒超 → true(1% 未満でも記録する=2時間で 1.5 秒ずれる VBR)', () => {
		const durationMismatch = durationMismatchFn();
		expect(durationMismatch(7200, 7201.5)).toBe(true);
		expect(durationMismatch(7201.5, 7200)).toBe(true); // 対称
	});

	test('1% 超 → true(1 秒以内でも記録する=短尺の相対ずれ)', () => {
		const durationMismatch = durationMismatchFn();
		expect(durationMismatch(10, 10.2)).toBe(true);
		expect(durationMismatch(10.2, 10)).toBe(true); // 対称
	});

	test('どちらかが非有限・欠落・0 以下 → false(比べる材料が無ければ記録しない=fail-open)', () => {
		const durationMismatch = durationMismatchFn();
		expect(durationMismatch(Number.NaN, 100)).toBe(false);
		expect(durationMismatch(Number.POSITIVE_INFINITY, 100)).toBe(false);
		expect(durationMismatch(undefined, 100)).toBe(false);
		expect(durationMismatch(100, null)).toBe(false);
		expect(durationMismatch(100, undefined)).toBe(false);
		expect(durationMismatch(100, Number.NaN)).toBe(false);
		expect(durationMismatch(0, 100)).toBe(false);
		expect(durationMismatch(100, 0)).toBe(false);
		expect(durationMismatch(-5, 100)).toBe(false);
	});
});

// ===========================================================================
// 要件#50 追補e(4) — invoke 写像の同型固定(挙動不変リファクタの網)
// ===========================================================================
//
// `analyzeWavWaveform` と `extractWaveformAudio` の本体は `invokeWaveformBytes
// (command, args)` 1本に畳まれ、両 export は薄いラッパになる(追補e(4)。
// `WavWaveformAnalysis = WaveformExtraction` の別名化・`let raw: unknown` の除去=
// `ArrayBuffer | ArrayBufferView` で受ける)。挙動は不変なので、ここは**リファクタ
// 前から緑**の固定テスト ―― 縮退写像(拒否語彙 → 状態・未知の失敗 → unreadable)と
// **ArrayBufferView で届いた raw の受理**が、畳み込みの前後で両関数に同じ形で
// 残ることを機械判定する。上の wav 受け口 describe は analyzeWavWaveform の
// ArrayBuffer 側だけを固定しており、view 側と extractWaveformAudio 側はここが持つ。
describe('invoke 写像の同型固定(要件#50 追補e(4)=extractWaveformAudio / analyzeWavWaveform)', () => {
	const MOV = `${ROOT}/movies/final.mov`;

	test('extractWaveformAudio — invoke("extract_waveform_audio") の写像(ok=raw バイト・view 受理・拒否語彙=状態・未知の失敗=unreadable)', async () => {
		const { extractWaveformAudio } = AudioWaveform;

		// 素の ArrayBuffer → そのまま ok。
		const raw = new ArrayBuffer(8);
		invokeMock.mockResolvedValueOnce(raw);
		const ok = await extractWaveformAudio(MOV);
		expect(invokeMock.mock.calls).toEqual([['extract_waveform_audio', { uri: MOV }]]);
		expect(ok.state).toBe('ok');
		if (ok.state === 'ok') expect(ok.bytes).toBe(raw);

		// byteOffset 付きの view で包まれて届いても、指す範囲だけを ok に写す。
		const backing = new Uint8Array([0, 0, 1, 2, 3, 4, 0]);
		invokeMock.mockResolvedValueOnce(new Uint8Array(backing.buffer, 2, 4));
		const fromView = await extractWaveformAudio(MOV);
		expect(fromView.state).toBe('ok');
		if (fromView.state === 'ok') {
			expect(Array.from(new Uint8Array(fromView.bytes))).toEqual([1, 2, 3, 4]);
		}

		// 拒否語彙は状態へ・知らない失敗は unreadable(fail-open)。
		invokeMock.mockRejectedValueOnce('no-audio');
		expect(await extractWaveformAudio(MOV)).toEqual({ state: 'no-audio' });
		invokeMock.mockRejectedValueOnce('unsupported-codec');
		expect(await extractWaveformAudio(MOV)).toEqual({ state: 'unsupported-codec' });
		invokeMock.mockRejectedValueOnce(new Error('boom'));
		expect(await extractWaveformAudio(MOV)).toEqual({ state: 'unreadable' });
	});

	test('analyzeWavWaveform — ArrayBufferView(byteOffset 付き)で届いた raw も ok に写す(extractWaveformAudio と同型)', async () => {
		const { analyzeWavWaveform } = AudioWaveform;

		const backing = new Uint8Array(40);
		backing.set([9, 8, 7], 4);
		invokeMock.mockResolvedValueOnce(new Uint8Array(backing.buffer, 4, 32));

		const result = await analyzeWavWaveform(WAV);
		expect(invokeMock.mock.calls).toEqual([['analyze_wav_waveform', { uri: WAV }]]);
		expect(result.state).toBe('ok');
		if (result.state === 'ok') {
			expect(result.bytes.byteLength).toBe(32);
			expect(Array.from(new Uint8Array(result.bytes, 0, 3))).toEqual([9, 8, 7]);
		}
	});
});
