/**
 * 要件#41 追補j(Issue #604=backlog 234)=音声トラックの無い webm で
 * 「Could not decode the audio」と出る、の受け入れテスト(AC-41-追j (a)〜(e))。
 *
 * ## 背景(req-41.md 追補j)
 * mp4/mov は Rust の抽出の応答で音声の有無が分かり「This video has no audio track」と
 * 出るが、webm は `fetch` → `decodeAudioData` の経路で、音声が無いことと復号の失敗を
 * 区別していない(WebKit は音声の無い webm の復号を拒否する)。由谷の決定(2026-10-26)
 * =「有無を調べる」「フロントで調べる」。
 *
 * ## 契約(追補j)
 * 1. `analyzeWaveform` の `fetch` の経路で **`decode` が失敗したとき**、読み込んだ
 *    バイト列が EBML(先頭が `1A 45 DF A3`)なら Segment の Tracks を読み、
 *    **TrackEntry が 1 つ以上あって、どれも音声(TrackType=2)でない**と分かれば
 *    `no-audio`(帯の文言は mp4 と同じ「This video has no audio track」)
 * 2. 分からないとき(EBML でない・Tracks が見つからない・壊れている・音声のトラックが
 *    ある・TrackEntry が 0)は今のまま `decode-failed`
 * 3. `decode` が成功したときは今と同じ(Tracks は読まない)
 * 4. 不変: `waveformPlan`(webm は `fetch` のまま)・mp4/mov/wav の経路・文言・
 *    Tauri のコマンド・`AudioViewer`・依存
 *
 * ## 公開の面(implementer はこれに従う)
 * `src/lib/audio-waveform.ts` から新設 export:
 *   `webmTrackKinds(bytes: ArrayBuffer | Uint8Array):
 *      { audio: number; video: number; other: number } | null`
 * - EBML でない・Tracks が見つからない・壊れている・TrackEntry が 0 なら `null`
 * - `Uint8Array` は **byteOffset 付きの view** も受ける(`bytes.buffer` を素で読まない)
 * - どんな入力でも throw しない(契約⑤ fail-open と同じ家風)
 * - `audio` = TrackType 2 の TrackEntry の数・`video` = TrackType 1・`other` = それ以外
 *   (字幕 17 など)
 * 本ファイルは namespace import(`AudioWaveform.webmTrackKinds`)で参照する ――
 * 実装前(export 不在)でもモジュール読込が落ちず、赤は該当ケースの assertion
 * (`not a function`)で出る(要件#45 追記と同じ作法)。
 *
 * ## EBML のバイト列はテストの中で合成する
 * ID は EBML の規定どおりマーカー付きのバイト列(`1A 45 DF A3`=4 バイト ID・`AE`=
 * 1 バイト ID)、サイズは VINT(先頭バイトの最上位の 1 の位置が幅・その下位ビットと
 * 続くバイトが値。幅 1 なら `0x80 | n`・未知は `01 FF FF FF FF FF FF FF`)。
 * MediaRecorder が吐く webm(Issue の素材の典型)は Segment も Cluster も**サイズ未知**
 * で、Tracks の前に SeekHead/Void/Info が並ぶ ―― (e) はこの形を扱えることを固定する。
 *
 * ## 想定される赤(実装前)
 * - (a) の各ケース: 今の `analyzeWaveform` は decode の失敗を一律 `decode-failed` に
 *   するので `no-audio` の期待が赤
 * - (e) の各ケース: `webmTrackKinds` が未 export で `not a function` の赤
 * - (b)(c)(d) は実装前から緑(契約 2・3 の「今のまま」の固定=実装が踏み越えないための柵)
 * - (f) 既存の `audio-waveform.acceptance.test.ts` は無改変
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { analyzeWaveform, waveformBandNote, waveformPlan } from './audio-waveform';
import type { WaveformAudioBuffer, WaveformDecode, WaveformExtraction } from './audio-waveform';
import * as AudioWaveform from './audio-waveform';
import { toAssetUri } from './uri';

// ---------------------------------------------------------------------------
// EBML(webm)のバイト列の合成
// ---------------------------------------------------------------------------

/** 使う要素 ID(マーカー付きのバイト列=ファイルにそのまま並ぶ形)。 */
const ID = {
	EBML: [0x1a, 0x45, 0xdf, 0xa3],
	EBMLVersion: [0x42, 0x86],
	EBMLReadVersion: [0x42, 0xf7],
	EBMLMaxIDLength: [0x42, 0xf2],
	EBMLMaxSizeLength: [0x42, 0xf3],
	DocType: [0x42, 0x82],
	DocTypeVersion: [0x42, 0x87],
	DocTypeReadVersion: [0x42, 0x85],
	Segment: [0x18, 0x53, 0x80, 0x67],
	SeekHead: [0x11, 0x4d, 0x9b, 0x74],
	Seek: [0x4d, 0xbb],
	SeekID: [0x53, 0xab],
	SeekPosition: [0x53, 0xac],
	Void: [0xec],
	Info: [0x15, 0x49, 0xa9, 0x66],
	TimestampScale: [0x2a, 0xd7, 0xb1],
	Duration: [0x44, 0x89],
	MuxingApp: [0x4d, 0x80],
	WritingApp: [0x57, 0x41],
	Tracks: [0x16, 0x54, 0xae, 0x6b],
	TrackEntry: [0xae],
	TrackNumber: [0xd7],
	TrackUID: [0x73, 0xc5],
	TrackType: [0x83],
	CodecID: [0x86],
	Video: [0xe0],
	PixelWidth: [0xb0],
	PixelHeight: [0xba],
	Audio: [0xe1],
	SamplingFrequency: [0xb5],
	Channels: [0x9f],
	Cluster: [0x1f, 0x43, 0xb6, 0x75],
	Timestamp: [0xe7],
	SimpleBlock: [0xa3],
} as const;

/** TrackType の値(Matroska)。 */
const TRACK_VIDEO = 1;
const TRACK_AUDIO = 2;
const TRACK_SUBTITLE = 17;

/** サイズ未知(全ビット 1・幅 8)。MediaRecorder の Segment/Cluster がこれ。 */
const UNKNOWN_SIZE: readonly number[] = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/**
 * サイズを VINT に書く。幅は値が収まる最小(明示も可)。幅 w の最大値 2^(7w)−1 は
 * 「未知」の予約なので値には使わない。
 */
function vintSize(n: number, width?: number): number[] {
	let w = width ?? 1;
	if (width === undefined) while (n >= 2 ** (7 * w) - 1) w += 1;
	const out: number[] = [];
	let v = n;
	for (let i = 0; i < w; i++) {
		out.unshift(v & 0xff);
		v = Math.floor(v / 256);
	}
	out[0] |= 0x80 >> (w - 1);
	return out;
}

/** 要素 = ID + サイズ(VINT) + 本体。`size` を渡すとサイズの欄をそのまま置く(未知・壊れ用)。 */
function el(id: readonly number[], payload: readonly number[], size?: readonly number[]): number[] {
	return [...id, ...(size ?? vintSize(payload.length)), ...payload];
}

/** 符号なし整数(big-endian・最小バイト数・最低 1 バイト)。 */
function uint(n: number): number[] {
	const out: number[] = [];
	let v = n;
	do {
		out.unshift(v & 0xff);
		v = Math.floor(v / 256);
	} while (v > 0);
	return out;
}

/** ASCII 文字列。 */
function ascii(s: string): number[] {
	return Array.from(s, (c) => c.charCodeAt(0) & 0x7f);
}

/** IEEE754 倍精度(big-endian)。 */
function float64(d: number): number[] {
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, d);
	return Array.from(new Uint8Array(view.buffer));
}

function ebmlHeader(): number[] {
	return el(ID.EBML, [
		...el(ID.EBMLVersion, uint(1)),
		...el(ID.EBMLReadVersion, uint(1)),
		...el(ID.EBMLMaxIDLength, uint(4)),
		...el(ID.EBMLMaxSizeLength, uint(8)),
		...el(ID.DocType, ascii('webm')),
		...el(ID.DocTypeVersion, uint(4)),
		...el(ID.DocTypeReadVersion, uint(2)),
	]);
}

function seekHead(): number[] {
	return el(ID.SeekHead, [
		...el(ID.Seek, [...el(ID.SeekID, ID.Tracks), ...el(ID.SeekPosition, uint(0x1234))]),
		...el(ID.Seek, [...el(ID.SeekID, ID.Cluster), ...el(ID.SeekPosition, uint(0x5678))]),
	]);
}

function voidEl(length: number): number[] {
	return el(ID.Void, new Array<number>(length).fill(0));
}

function info(): number[] {
	return el(ID.Info, [
		...el(ID.TimestampScale, uint(1_000_000)),
		...el(ID.Duration, float64(12_500)),
		...el(ID.MuxingApp, ascii('vellis-test')),
		...el(ID.WritingApp, ascii('vellis-test')),
	]);
}

type TrackSpec = { number: number; type: number; codec: string };

function trackEntry(spec: TrackSpec): number[] {
	const specific =
		spec.type === TRACK_VIDEO
			? el(ID.Video, [...el(ID.PixelWidth, uint(640)), ...el(ID.PixelHeight, uint(360))])
			: spec.type === TRACK_AUDIO
				? el(ID.Audio, [
						...el(ID.SamplingFrequency, float64(48_000)),
						...el(ID.Channels, uint(2)),
					])
				: [];
	return el(ID.TrackEntry, [
		...el(ID.TrackNumber, uint(spec.number)),
		...el(ID.TrackUID, uint(0x10 + spec.number)),
		...el(ID.TrackType, uint(spec.type)),
		...el(ID.CodecID, ascii(spec.codec)),
		...specific,
	]);
}

function tracks(specs: readonly TrackSpec[], size?: readonly number[]): number[] {
	return el(ID.Tracks, specs.flatMap(trackEntry), size);
}

function cluster(sizeKind: 'known' | 'unknown' = 'known'): number[] {
	const payload = [
		...el(ID.Timestamp, uint(0)),
		...el(ID.SimpleBlock, [0x81, 0x00, 0x00, 0x80, 0x01, 0x02, 0x03, 0x04]),
	];
	return el(ID.Cluster, payload, sizeKind === 'unknown' ? UNKNOWN_SIZE : undefined);
}

function segment(children: readonly number[], sizeKind: 'known' | 'unknown'): number[] {
	return el(ID.Segment, children, sizeKind === 'unknown' ? UNKNOWN_SIZE : undefined);
}

const VIDEO_ONLY: readonly TrackSpec[] = [{ number: 1, type: TRACK_VIDEO, codec: 'V_VP9' }];
const AUDIO_ONLY: readonly TrackSpec[] = [{ number: 1, type: TRACK_AUDIO, codec: 'A_OPUS' }];
const VIDEO_AND_AUDIO: readonly TrackSpec[] = [
	{ number: 1, type: TRACK_VIDEO, codec: 'V_VP8' },
	{ number: 2, type: TRACK_AUDIO, codec: 'A_OPUS' },
];

type WebmShape = {
	tracks: readonly TrackSpec[];
	/** Segment のサイズ。MediaRecorder は未知。 */
	segmentSize?: 'known' | 'unknown';
	/** Tracks の前に並ぶ要素。 */
	preamble?: readonly ('seekhead' | 'void' | 'info')[];
	/** Tracks の後の Cluster の数とサイズの種類。 */
	clusters?: number;
	clusterSize?: 'known' | 'unknown';
	/** Tracks の要素そのものを差し替える(壊れ・空の Tracks 用)。 */
	tracksOverride?: readonly number[];
};

/** webm(EBML ヘッダ + Segment)のバイト列を合成する。 */
function webm(shape: WebmShape): Uint8Array {
	const preamble = (shape.preamble ?? ['seekhead', 'void', 'info']).flatMap((kind) =>
		kind === 'seekhead' ? seekHead() : kind === 'void' ? voidEl(64) : info(),
	);
	const clusters = Array.from({ length: shape.clusters ?? 1 }, () =>
		cluster(shape.clusterSize ?? 'known'),
	).flat();
	const body = [...preamble, ...(shape.tracksOverride ?? tracks(shape.tracks)), ...clusters];
	return Uint8Array.from([...ebmlHeader(), ...segment(body, shape.segmentSize ?? 'known')]);
}

/** 合成した本文の中で `id` が最初に現れる位置(切り詰め用)。 */
function indexOfId(bytes: Uint8Array, id: readonly number[]): number {
	outer: for (let i = 0; i + id.length <= bytes.length; i++) {
		for (let j = 0; j < id.length; j++) if (bytes[i + j] !== id[j]) continue outer;
		return i;
	}
	return -1;
}

/** `Uint8Array` から**独立した** `ArrayBuffer`(byteOffset 0・長さ一致)を作る。 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** mp4 の先頭(ftyp 箱)。EBML ではない。 */
const MP4_HEAD = Uint8Array.from([
	0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
	0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32,
]);

// ---------------------------------------------------------------------------
// analyzeWaveform 側のフィクスチャ(audio-waveform.acceptance.test.ts と同じ作法)
// ---------------------------------------------------------------------------

const VIDEO_WEBM = 'file:///Users/a/movies/screen-recording.webm';

/** fetch モックへ返す Response もどき(既存の受け入れテストと同じ形)。 */
function fakeResponse(status: number, body: Uint8Array = new Uint8Array(0)) {
	const buffer = toBuffer(body);
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: {
			get: (name: string) =>
				name.toLowerCase() === 'content-length' ? String(buffer.byteLength) : null,
		},
		arrayBuffer: vi.fn(async () => buffer),
		bytes: vi.fn(async () => new Uint8Array(buffer)),
	};
}

function firstRequestUrl(fetchMock: ReturnType<typeof vi.fn>): string {
	const arg: unknown = fetchMock.mock.calls[0][0];
	if (typeof arg === 'string') return arg;
	if (arg instanceof URL) return arg.href;
	return String((arg as { url?: unknown })?.url ?? arg);
}

function audioBuf(channels: (number[] | Float32Array)[], sampleRate = 8000): WaveformAudioBuffer {
	const data = channels.map((ch) => Float32Array.from(ch));
	return {
		numberOfChannels: data.length,
		length: data[0]?.length ?? 0,
		sampleRate,
		getChannelData: (channel: number) => data[channel],
	};
}

/** decode が reject する(WebKit の EncodingError を模す)。 */
function decodeRejecting() {
	return vi.fn<WaveformDecode>(async () => {
		throw new DOMException('Unable to decode audio data', 'EncodingError');
	});
}

/** decode が同期 throw する。 */
function decodeThrowingSync() {
	return vi.fn<WaveformDecode>(() => {
		throw new Error('boom');
	});
}

function decodeTo(buffer: WaveformAudioBuffer) {
	return vi.fn<WaveformDecode>(async () => buffer);
}

function extractNever() {
	return vi.fn(async (_videoUri: string): Promise<WaveformExtraction> => ({ state: 'unreadable' }));
}

/** webm の実機の事前判定(WebKit の audioTracks は当てにならない=null)で解析を呼ぶ。 */
async function analyzeWebm(body: Uint8Array, decode: WaveformDecode, fetchMock: ReturnType<typeof vi.fn>) {
	fetchMock.mockResolvedValueOnce(fakeResponse(200, body));
	const extract = extractNever();
	const result = await analyzeWaveform(VIDEO_WEBM, {
		durationSeconds: 12.5,
		hasAudioTrack: null,
		decode,
		extract,
	});
	return { result, extract };
}

// ---------------------------------------------------------------------------
// (e) webmTrackKinds — Tracks の読み取りは純関数
// ---------------------------------------------------------------------------

describe('webmTrackKinds — EBML の Tracks の読み取り(要件#41 追補j・AC-41-追j (e))', () => {
	const kinds = (bytes: ArrayBuffer | Uint8Array) => AudioWaveform.webmTrackKinds(bytes);

	it('映像のトラックだけの webm → { audio: 0, video: 1, other: 0 }', () => {
		expect(kinds(webm({ tracks: VIDEO_ONLY }))).toEqual({ audio: 0, video: 1, other: 0 });
	});

	it('映像+音声の webm → audio 1・video 1(音声のトラックがあると分かる)', () => {
		expect(kinds(webm({ tracks: VIDEO_AND_AUDIO }))).toEqual({ audio: 1, video: 1, other: 0 });
	});

	it('音声だけの webm → audio 1・video 0', () => {
		expect(kinds(webm({ tracks: AUDIO_ONLY }))).toEqual({ audio: 1, video: 0, other: 0 });
	});

	it('複数の TrackEntry(映像 1・音声 2・字幕 1)を数え分ける', () => {
		const specs: TrackSpec[] = [
			{ number: 1, type: TRACK_VIDEO, codec: 'V_VP9' },
			{ number: 2, type: TRACK_AUDIO, codec: 'A_OPUS' },
			{ number: 3, type: TRACK_AUDIO, codec: 'A_VORBIS' },
			{ number: 4, type: TRACK_SUBTITLE, codec: 'S_TEXT/WEBVTT' },
		];
		expect(kinds(webm({ tracks: specs }))).toEqual({ audio: 2, video: 1, other: 1 });
	});

	it('サイズ未知の Segment(MediaRecorder の形)でも Tracks を読める', () => {
		expect(kinds(webm({ tracks: VIDEO_ONLY, segmentSize: 'unknown' }))).toEqual({
			audio: 0,
			video: 1,
			other: 0,
		});
	});

	it('サイズ未知の Segment+サイズ未知の Cluster(MediaRecorder の典型)でも Tracks を読める', () => {
		const bytes = webm({
			tracks: VIDEO_AND_AUDIO,
			segmentSize: 'unknown',
			clusters: 3,
			clusterSize: 'unknown',
		});
		expect(kinds(bytes)).toEqual({ audio: 1, video: 1, other: 0 });
	});

	it('Tracks の前に SeekHead・Void・Info が並んでいても読める(順不同)', () => {
		expect(
			kinds(webm({ tracks: VIDEO_ONLY, preamble: ['void', 'seekhead', 'void', 'info'] })),
		).toEqual({ audio: 0, video: 1, other: 0 });
		expect(kinds(webm({ tracks: VIDEO_ONLY, preamble: ['seekhead', 'info', 'void'] }))).toEqual(
			{ audio: 0, video: 1, other: 0 },
		);
	});

	it('Tracks の前に何も無く(SeekHead/Void/Info 無し)、Cluster も無くても読める', () => {
		expect(kinds(webm({ tracks: VIDEO_ONLY, preamble: [], clusters: 0 }))).toEqual({
			audio: 0,
			video: 1,
			other: 0,
		});
	});

	it('サイズの欄が最小幅でなくても(幅 2・幅 8 の VINT)読める', () => {
		// 同じ値を幅 2・幅 8 で書く(mkvmerge など、サイズの欄を固定幅で書く muxer がある)。
		const entries = VIDEO_ONLY.flatMap(trackEntry);
		const tracksWide2 = el(ID.Tracks, entries, vintSize(entries.length, 2));
		const tracksWide8 = el(ID.Tracks, entries, vintSize(entries.length, 8));
		expect(tracksWide8.slice(ID.Tracks.length, ID.Tracks.length + 8)).not.toEqual(UNKNOWN_SIZE);
		expect(kinds(webm({ tracks: VIDEO_ONLY, tracksOverride: tracksWide2 }))).toEqual({
			audio: 0,
			video: 1,
			other: 0,
		});
		expect(kinds(webm({ tracks: VIDEO_ONLY, tracksOverride: tracksWide8 }))).toEqual({
			audio: 0,
			video: 1,
			other: 0,
		});
	});

	it('ArrayBuffer でも、byteOffset 付きの Uint8Array の view でも同じ結果', () => {
		const bytes = webm({ tracks: VIDEO_AND_AUDIO });
		expect(kinds(toBuffer(bytes))).toEqual({ audio: 1, video: 1, other: 0 });
		// 先頭に 5 バイトの余りを付けた buffer の上の view(byteOffset=5)。
		const padded = new Uint8Array(bytes.length + 5);
		padded.set(bytes, 5);
		const view = padded.subarray(5);
		expect(view.byteOffset).toBe(5);
		expect(kinds(view)).toEqual({ audio: 1, video: 1, other: 0 });
	});

	it('EBML でない(空・1 バイト・mp4 の ftyp・印が途中で切れた)→ null・throw しない', () => {
		for (const bytes of [
			new Uint8Array(0),
			Uint8Array.from([1]),
			MP4_HEAD,
			Uint8Array.from([0x1a, 0x45, 0xdf]),
			Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]),
		]) {
			expect(() => kinds(bytes)).not.toThrow();
			expect(kinds(bytes)).toBeNull();
		}
	});

	it('Tracks が無い(SeekHead・Info・Cluster だけの Segment)→ null', () => {
		expect(kinds(webm({ tracks: [], tracksOverride: [] }))).toBeNull();
		expect(kinds(webm({ tracks: [], tracksOverride: [], segmentSize: 'unknown' }))).toBeNull();
	});

	it('Tracks はあるが TrackEntry が 0(空・Void だけ)→ null', () => {
		expect(kinds(webm({ tracks: [] }))).toBeNull();
		expect(kinds(webm({ tracks: [], tracksOverride: el(ID.Tracks, voidEl(8)) }))).toBeNull();
	});

	it('途中で切れている(Tracks の先頭・TrackEntry の途中・Segment の直後)→ null・throw しない', () => {
		const whole = webm({ tracks: VIDEO_ONLY });
		const tracksAt = indexOfId(whole, ID.Tracks);
		expect(tracksAt).toBeGreaterThan(0);
		const cuts = [
			whole.subarray(0, tracksAt + 2), // Tracks の ID の途中
			whole.subarray(0, tracksAt + ID.Tracks.length), // サイズの欄が無い
			whole.subarray(0, tracksAt + ID.Tracks.length + 1 + 3), // TrackEntry の途中
			whole.subarray(0, indexOfId(whole, ID.Segment) + ID.Segment.length + 1), // Segment の本体なし
		];
		for (const cut of cuts) {
			expect(() => kinds(cut)).not.toThrow();
			expect(kinds(cut), `長さ ${cut.length} で切った本文`).toBeNull();
		}
	});

	it('サイズが壊れている(Tracks の申告が残りより大きい・TrackEntry の申告が Tracks より大きい・VINT の幅が不正)→ null・throw しない', () => {
		const entries = VIDEO_ONLY.flatMap(trackEntry);
		const broken = [
			// Tracks の申告サイズが本文の残りより大きい
			webm({ tracks: VIDEO_ONLY, tracksOverride: el(ID.Tracks, entries, vintSize(0x2000, 2)) }),
			// TrackEntry の申告サイズが Tracks の本体より大きい
			webm({
				tracks: VIDEO_ONLY,
				tracksOverride: el(ID.Tracks, el(ID.TrackEntry, entries.slice(2), vintSize(0x2000, 2))),
			}),
			// サイズの欄が 0x00(VINT として不正=幅 9 以上)
			webm({ tracks: VIDEO_ONLY, tracksOverride: [...ID.Tracks, 0x00, ...entries] }),
			// EBML ヘッダのサイズが本文全体より大きい
			Uint8Array.from([...ID.EBML, ...vintSize(0x2000, 2), ...ascii('webm')]),
		];
		for (const bytes of broken) {
			expect(() => kinds(bytes)).not.toThrow();
			expect(kinds(bytes)).toBeNull();
		}
	});
});

// ---------------------------------------------------------------------------
// (a)〜(d) analyzeWaveform — decode が失敗した webm の Tracks 判定
// ---------------------------------------------------------------------------

describe('analyzeWaveform — decode が失敗した webm は Tracks で音声の有無を決める(要件#41 追補j・AC-41-追j (a)〜(d))', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('不変: webm の経路は fetch のまま(契約 4)', () => {
		expect(waveformPlan(VIDEO_WEBM, 12.5, null)).toEqual({ route: 'fetch' });
	});

	// (a)
	it('(a) 映像のトラックだけの webm で decode が reject → no-audio(fetch 1 回・extract なし・decode 1 回)', async () => {
		const decode = decodeRejecting();
		const { result, extract } = await analyzeWebm(webm({ tracks: VIDEO_ONLY }), decode, fetchMock);
		expect(result).toEqual({ state: 'no-audio' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(firstRequestUrl(fetchMock)).toBe(toAssetUri(VIDEO_WEBM));
		expect(extract).not.toHaveBeenCalled();
		expect(decode).toHaveBeenCalledTimes(1);
	});

	it('(a) MediaRecorder の形(サイズ未知の Segment/Cluster・SeekHead/Void/Info が先)の映像だけの webm で decode が同期 throw → no-audio', async () => {
		const decode = decodeThrowingSync();
		const body = webm({
			tracks: VIDEO_ONLY,
			segmentSize: 'unknown',
			preamble: ['seekhead', 'void', 'info'],
			clusters: 2,
			clusterSize: 'unknown',
		});
		const { result } = await analyzeWebm(body, decode, fetchMock);
		expect(result).toEqual({ state: 'no-audio' });
		expect(decode).toHaveBeenCalledTimes(1);
	});

	it('(a) 映像 2 本+字幕の webm(音声は無い)でも no-audio', async () => {
		const body = webm({
			tracks: [
				{ number: 1, type: TRACK_VIDEO, codec: 'V_VP9' },
				{ number: 2, type: TRACK_VIDEO, codec: 'V_AV1' },
				{ number: 3, type: TRACK_SUBTITLE, codec: 'S_TEXT/WEBVTT' },
			],
		});
		const { result } = await analyzeWebm(body, decodeRejecting(), fetchMock);
		expect(result).toEqual({ state: 'no-audio' });
	});

	it('(a) 帯の文言は mp4 の音声なしと同じ「This video has no audio track」', async () => {
		const { result } = await analyzeWebm(webm({ tracks: VIDEO_ONLY }), decodeRejecting(), fetchMock);
		expect(waveformBandNote(result, false)).toBe('This video has no audio track');
		expect(waveformBandNote(result, false)).toBe(waveformBandNote({ state: 'no-audio' }, false));
	});

	// (b)
	it('(b) 音声のトラックを含む webm(映像+音声)で decode が失敗 → decode-failed のまま', async () => {
		const { result } = await analyzeWebm(webm({ tracks: VIDEO_AND_AUDIO }), decodeRejecting(), fetchMock);
		expect(result).toEqual({ state: 'decode-failed' });
	});

	it('(b) 音声だけの webm で decode が失敗 → decode-failed のまま', async () => {
		const { result } = await analyzeWebm(
			webm({ tracks: AUDIO_ONLY, segmentSize: 'unknown', clusterSize: 'unknown' }),
			decodeThrowingSync(),
			fetchMock,
		);
		expect(result).toEqual({ state: 'decode-failed' });
	});

	// (c)
	it.each<[string, () => Uint8Array]>([
		['EBML でない(1 バイト)', () => Uint8Array.from([1])],
		['EBML でない(mp4 の ftyp)', () => MP4_HEAD],
		['空の本文', () => new Uint8Array(0)],
		['Tracks が無い', () => webm({ tracks: [], tracksOverride: [] })],
		['TrackEntry が 0', () => webm({ tracks: [] })],
		[
			'途中で切れた(TrackEntry の途中)',
			() => {
				const whole = webm({ tracks: VIDEO_ONLY });
				return whole.subarray(0, indexOfId(whole, ID.Tracks) + ID.Tracks.length + 1 + 3);
			},
		],
		[
			'サイズが壊れた(Tracks の申告が残りより大きい)',
			() =>
				webm({
					tracks: VIDEO_ONLY,
					tracksOverride: el(ID.Tracks, VIDEO_ONLY.flatMap(trackEntry), vintSize(0x2000, 2)),
				}),
		],
		[
			'サイズが壊れた(VINT の幅が不正)',
			() =>
				webm({
					tracks: VIDEO_ONLY,
					tracksOverride: [...ID.Tracks, 0x00, ...VIDEO_ONLY.flatMap(trackEntry)],
				}),
		],
	])('(c) %s で decode が失敗 → decode-failed(例外を投げない)', async (_label, make) => {
		const decode = decodeRejecting();
		await expect(analyzeWebm(make(), decode, fetchMock)).resolves.toMatchObject({
			result: { state: 'decode-failed' },
		});
		expect(decode).toHaveBeenCalledTimes(1);
	});

	// (d)
	it('(d) 映像だけの webm でも decode が成功すれば今と同じ結果(ready・decode には本文がそのまま 1 回渡る)', async () => {
		const buffer = audioBuf([
			[0.5, -0.5, 0.25, -0.25],
			[0.1, -0.1, 0.75, -0.75],
		]);
		const body = webm({ tracks: VIDEO_ONLY, segmentSize: 'unknown', clusterSize: 'unknown' });
		const decode = decodeTo(buffer);
		const { result } = await analyzeWebm(body, decode, fetchMock);
		expect(result).toMatchObject({ state: 'ready' });
		expect(decode).toHaveBeenCalledTimes(1);
		expect(new Uint8Array(decode.mock.calls[0][0])).toEqual(body);

		// 「今と同じ」= EBML でない本文を同じ decode にかけた結果と同じ波形。
		const { result: plain } = await analyzeWebm(Uint8Array.from([1, 2, 3]), decodeTo(buffer), fetchMock);
		expect(plain).toMatchObject({ state: 'ready' });
		expect(result).toEqual(plain);
	});
});

// ---------------------------------------------------------------------------
// 追補j 契約5・起案時判断 (b)(d)(e)(h) の弁別(reviewer の P2-1・P2-2・P3-1)
// ---------------------------------------------------------------------------

/** 契約5 の「写す長さ」(1 MiB)。実装の定数は公開していないので要件の値を書く。 */
const PROBE_BYTES = 1024 * 1024;

/** EBML ヘッダ + Segment を、子要素の並びを指定して組む(前置の種類を限らない版)。 */
function webmRaw(children: readonly number[], segmentSize: readonly number[] | 'known' | 'unknown'): Uint8Array {
	const seg =
		segmentSize === 'known' || segmentSize === 'unknown'
			? segment(children, segmentSize)
			: el(ID.Segment, children, segmentSize);
	return Uint8Array.from([...ebmlHeader(), ...seg]);
}

/** TrackType を持たない TrackEntry(Matroska では必須だが、欠けた素材の想定)。 */
function trackEntryWithoutType(number: number, codec: string): number[] {
	return el(ID.TrackEntry, [
		...el(ID.TrackNumber, uint(number)),
		...el(ID.TrackUID, uint(0x10 + number)),
		...el(ID.CodecID, ascii(codec)),
	]);
}

/**
 * decode が、渡された ArrayBuffer を `structuredClone(..., { transfer })` で切り離して
 * から reject する(実物の `decodeAudioData` が本文を detach する仕様の模倣)。
 */
function decodeDetachingThenRejecting() {
	return vi.fn<WaveformDecode>(async (bytes: ArrayBuffer) => {
		structuredClone(bytes, { transfer: [bytes] });
		throw new DOMException('Unable to decode audio data', 'EncodingError');
	});
}

describe('webmTrackKinds / analyzeWaveform — decode の前の写し・Segment の切り詰め・起案時判断 (b)(d)(e)(要件#41 追補j 契約5・起案時判断)', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// P2-1 契約5
	it.each<[string, 'known' | 'unknown']>([
		['サイズ既知の Segment', 'known'],
		['サイズ未知の Segment', 'unknown'],
	])('契約5: decode が本文を切り離してから失敗しても(%s)、映像だけの webm は no-audio(写しから Tracks を読む)', async (_label, segmentSize) => {
		const decode = decodeDetachingThenRejecting();
		const { result } = await analyzeWebm(
			webm({ tracks: VIDEO_ONLY, segmentSize, clusterSize: segmentSize }),
			decode,
			fetchMock,
		);
		// decode に渡った本文は本当に切り離されている(写さずに元を読む実装なら Tracks が無い)。
		expect(decode).toHaveBeenCalledTimes(1);
		expect(decode.mock.calls[0][0].byteLength, 'decode に渡した本文は切り離されていること').toBe(0);
		expect(result).toEqual({ state: 'no-audio' });
	});

	// P2-2 起案時判断 (h)
	it('(h)(i) webmTrackKinds: サイズ既知の Segment の申告が手元の長さを超えていても、手元にある Tracks は数える', () => {
		const children = [...seekHead(), ...info(), ...tracks(VIDEO_AND_AUDIO), ...cluster('known')];
		// 申告 2 MiB・実体は数百バイト(写し=先頭 1 MiB を渡されたときの形)。
		const bytes = webmRaw(children, vintSize(2 * PROBE_BYTES, 4));
		expect(bytes.length).toBeLessThan(2 * PROBE_BYTES);
		expect(AudioWaveform.webmTrackKinds(bytes)).toEqual({ audio: 1, video: 1, other: 0 });
		expect(AudioWaveform.webmTrackKinds(toBuffer(bytes))).toEqual({ audio: 1, video: 1, other: 0 });
	});

	it('(h)(i) analyzeWaveform: 1 MiB を超える本文(映像だけ・Segment のサイズ既知)で decode が失敗 → no-audio(写しの中で Segment を切り詰めて読む)', async () => {
		// Tracks の後ろに 1.25 MiB の Void を置き、本文全体を写し(1 MiB)より大きくする。
		const children = [
			...seekHead(),
			...info(),
			...tracks(VIDEO_ONLY),
			...voidEl(PROBE_BYTES + PROBE_BYTES / 4),
			...cluster('known'),
		];
		const body = webmRaw(children, 'known');
		expect(body.length).toBeGreaterThan(PROBE_BYTES);
		const decode = decodeDetachingThenRejecting();
		const { result } = await analyzeWebm(body, decode, fetchMock);
		expect(decode).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ state: 'no-audio' });
	});

	it('(h)(ii) analyzeWaveform: Tracks が先頭 1 MiB より後ろにある本文で decode が失敗 → decode-failed(写しから Tracks に届かない)', async () => {
		// Tracks の前に 1 MiB + 16 バイトの Void。本文全体なら Tracks は読める(対照)。
		const children = [
			...seekHead(),
			...voidEl(PROBE_BYTES + 16),
			...info(),
			...tracks(VIDEO_ONLY),
			...cluster('known'),
		];
		const body = webmRaw(children, 'known');
		// SeekHead の SeekID にも Tracks の ID のバイト列が入るので、Void より後ろで探す。
		const tracksAt = PROBE_BYTES + indexOfId(body.subarray(PROBE_BYTES), ID.Tracks);
		expect(tracksAt).toBeGreaterThan(PROBE_BYTES);
		expect(AudioWaveform.webmTrackKinds(body), '本文全体なら Tracks は読める(対照)').toEqual({
			audio: 0,
			video: 1,
			other: 0,
		});
		const { result } = await analyzeWebm(body, decodeRejecting(), fetchMock);
		expect(result).toEqual({ state: 'decode-failed' });
	});

	// P3-1 起案時判断 (d)
	it('(d) TrackType を持たない TrackEntry は other に数える', () => {
		const only = el(ID.Tracks, trackEntryWithoutType(1, 'V_VP9'));
		expect(AudioWaveform.webmTrackKinds(webmRaw([...info(), ...only, ...cluster()], 'known'))).toEqual({
			audio: 0,
			video: 0,
			other: 1,
		});
		// 音声 1 本と TrackType の無い 1 本 → audio 1・other 1。
		const mixed = el(ID.Tracks, [...trackEntry(AUDIO_ONLY[0]), ...trackEntryWithoutType(2, 'V_VP9')]);
		expect(AudioWaveform.webmTrackKinds(webmRaw([...info(), ...mixed], 'unknown'))).toEqual({
			audio: 1,
			video: 0,
			other: 1,
		});
	});

	it('(d) TrackType を持たない TrackEntry だけの webm で decode が失敗 → no-audio', async () => {
		const only = el(ID.Tracks, trackEntryWithoutType(1, 'V_VP9'));
		const body = webmRaw([...seekHead(), ...info(), ...only, ...cluster()], 'known');
		const { result } = await analyzeWebm(body, decodeRejecting(), fetchMock);
		expect(result).toEqual({ state: 'no-audio' });
	});

	// P3-1 起案時判断 (e)
	it('(e) hasAudioTrack: true(要素が音声ありと言う)でも、decode 失敗+Tracks に音声なしなら no-audio', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(200, webm({ tracks: VIDEO_ONLY })));
		const result = await analyzeWaveform(VIDEO_WEBM, {
			durationSeconds: 12.5,
			hasAudioTrack: true,
			decode: decodeRejecting(),
			extract: extractNever(),
		});
		expect(result).toEqual({ state: 'no-audio' });
	});

	// P3-1 起案時判断 (b)
	it('(b) Cluster が Tracks より前にある → null(探すのをやめる=分からない)・analyzeWaveform は decode-failed', async () => {
		const body = webmRaw([...seekHead(), ...info(), ...cluster('known'), ...tracks(VIDEO_ONLY)], 'known');
		expect(AudioWaveform.webmTrackKinds(body)).toBeNull();
		const { result } = await analyzeWebm(body, decodeRejecting(), fetchMock);
		expect(result).toEqual({ state: 'decode-failed' });
	});
});
