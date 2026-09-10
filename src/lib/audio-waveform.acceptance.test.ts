/**
 * 要件#41 の受け入れテスト(requirements.md #41)— TS 層
 * 「動画ビューアに音声波形タイムラインを追加する: シークバーの直上に音声の
 *  min/max エンベロープ帯と再生ヘッドを表示し、波形を見ながらカット位置を
 *  探せるようにする(用途=編集下見のカット位置探し)」
 *
 * ## 本ファイルの判定範囲(要件の機械判定分=契約⑧の列挙に対応)
 * 経路判定(mp4/webm=fetch+decode 経路・mov=Rust 抽出経路=契約③改訂)・
 * バケット化(エンベロープの本数・境界・min/max の値=契約②③)・上限判定
 * (経路別の門=要件#50 契約⑬(b) で分離: fetch 側 `WAVEFORM_MAX_FETCH_BYTES` 512MiB・
 * 抽出側 `WAVEFORM_MAX_SOURCE_BYTES` 256MiB 据え置き。content-length 事前判定+実測の
 * 二重判定= video-provenance.ts の 8MiB キャップと同型)・縮退分岐(音声なし・mov の
 * 未対応コーデック・上限超過・読取失敗=契約⑤。fetch モック)・クリック位置→時刻→
 * フレーム吸着のシーク先計算(契約⑥=要件#37 の nearestFrame/seekTimeForFrame との
 * 等式契約)・**レーン分解とレーン縦配置(追補d=第2周: 2ch は L/R 上下2段・
 * 1ch は1段・3ch 以上は mono 縮退・帯総高不変)**。Rust 側の純関数
 * (サンプル表走査・m4a 再梱包・WAV 包装)は `src-tauri/tests/acceptance_req41.rs`、
 * コンポーネントの配線(canvas の bind:this・描画 effect の生存)は
 * `src/components/VideoViewer.wiring.test.ts`(第2周のスモーク)が判定する。
 *
 * ## 実機プローブで確定した前提(2026-09-01 訂正・契約③⑤の根拠)
 * - webm(VP8/VP9+Opus)は decodeAudioData で復号**できる**(実測)。
 *   「webm/Opus はデコード失敗想定」の縮退分岐は存在しない
 * - mov(QuickTime コンテナ)は decodeAudioData が食えない(実測)→ Rust 側で
 *   音声トラックを**無再エンコード抽出**(AAC→ADTS 再構成・PCM→WAV 包装)して
 *   decodeAudioData に渡す二経路構成
 * - 音声トラックなしと非対応コンテナは同一例外(EncodingError)で**区別不能**
 *   (実測)→ 縮退の出し分けは事前のコンテナ/トラック判定で行う。例外種別からの
 *   出し分けは契約に含めない(テストもしない)
 *
 * ## 【要件#45(2026-09-02)追補=波形v2】
 * requirements.md #45 契約①②が本ファイルの旧契約の一部を置き換える(オーケストレーター
 * 承認済の要件側判断): **mp4 も Rust 抽出経路(extract)へ**(fetch 経路は webm のみ。
 * content-length 事前判定は webm 用の loadWaveformSource に現状維持で残置)・
 * **実尺上限 WAVEFORM_MAX_DURATION_SECONDS(too-long 縮退)は撤廃**(定数 export・
 * skip 理由・WaveformResult の 'too-long' ごと削除)。以下の旧記述(契約③④の
 * mp4=fetch・60分上限)はこの追補で読み替えること。新契約の判定は本ファイル末尾の
 * 「要件#45」セクションが固定する。
 *
 * ## 【要件#50(2026-09-10)追補=音声ファイルの波形】
 * requirements.md #50 契約⑤⑬(b) がさらに一部を改訂する(追補a に列挙された範囲のみ):
 * **fetch 経路の上限は新設 `WAVEFORM_MAX_FETCH_BYTES = 512MiB` へ分離**
 * (`loadWaveformSource` の二重判定はこちらを見る。webm もこの引き上げを受ける=
 * #45 契約④「webm は現状維持」のこの一点に限る明示改訂・緩む方向のみ)、
 * `WAVEFORM_MAX_SOURCE_BYTES = 256MiB` は**抽出経路の門として値も名前も据え置き**。
 * `waveformPlan` は **wav → 新設 `wav` 経路**を加えた3枝になる(wav は fetch も
 * extract も通らない)。新契約の判定は本ファイル末尾の「要件#50」セクションが固定する。
 *
 * 実 decode(OfflineAudioContext(mono/8kHz)の decodeAudioData=契約③)は jsdom に
 * 存在しないため、モジュールは decode と mov 抽出(extract)を注入引数で受け、
 * AudioBuffer は構造的型(WaveformAudioBuffer)で扱う(契約⑦)。本テストは
 * プレーンオブジェクトの AudioBuffer もどきで全経路を機械判定する。
 *
 * ## 既存 acceptance との関係
 * - シーク吸着の値の根拠は要件#37(video-frame.acceptance.test.ts)が固定済み。
 *   本ファイルは `nearestFrame` / `seekTimeForFrame` との**同値を等式で結ぶだけ**
 *   (#39/#40 の等式契約と同じ家風)で、値の再導出はしない
 * - 既存 export(video-frame.ts / uri.ts)と既存 acceptance には一切手を触れない
 *   (契約⑧=既存挙動の不変)
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * 実装先: `src/lib/audio-waveform.ts`(新規。判定・計算はここの純関数に集め、
 * コンポーネントは配線だけ=契約⑦・video-frame.ts / video-provenance.ts と同じ家風)
 *
 * ### 定数(契約③④。値は初期値として acceptance で固定=調整は要件側の改定)
 * - `WAVEFORM_MAX_SOURCE_BYTES = 256 * 1024 * 1024` — **抽出経路(抽出後の音声
 *   バイト列)専用の門**(要件#50 契約⑬(b) で fetch 側と分離・値も名前も据え置き)
 * - `WAVEFORM_MAX_FETCH_BYTES = 512 * 1024 * 1024` — **fetch 経路(ファイル全量)の
 *   門**(要件#50 契約⑬(b) 新設。mp3/m4a/webm に当たる・wav はどちらの門も通らない)
 * - `WAVEFORM_MAX_DURATION_SECONDS = 3600`(実尺上限60分・両経路共通)
 * - `WAVEFORM_BUCKETS = 2000`(「約2000バケット」の既定本数)
 *
 * ### 型
 * - `WaveformAudioBuffer = { numberOfChannels: number; length: number;
 *   sampleRate: number; getChannelData(channel: number): Float32Array }`
 *   (Web Audio の AudioBuffer と構造的に互換=実物もそのまま渡せる)
 * - `WaveformDecode = (bytes: ArrayBuffer) => Promise<WaveformAudioBuffer>`
 * - `WaveformExtraction = { state: 'ok'; bytes: ArrayBuffer }
 *     | { state: 'no-audio' } | { state: 'unsupported-codec' }
 *     | { state: 'unreadable' }`(mov 抽出の応答。Rust コマンド応答を配線側で
 *   この形へ写す=写し方は reviewer 照合)
 * - `WaveformExtract = (videoUri: string) => Promise<WaveformExtraction>`
 * - `WaveformPeaks = { mins: Float32Array; maxs: Float32Array }`(同じ長さ)
 * - `PeakRect = { x: number; y: number; w: number; h: number }`
 * - `WaveformPlan = { route: 'fetch' } | { route: 'extract' }
 *     | { route: 'skip'; reason: 'no-audio' | 'too-long' }`
 * - `WaveformSource = { state: 'ok'; bytes: ArrayBuffer }
 *     | { state: 'too-large' } | { state: 'unreadable' }`
 * - `WaveformResult = { state: 'ready'; lanes: WaveformPeaks[] }
 *     | { state: 'no-audio' } | { state: 'too-long' } | { state: 'too-large' }
 *     | { state: 'unreadable' } | { state: 'unsupported-codec' }
 *     | { state: 'decode-failed' }`
 *   (第2周=追補d で ready の `peaks` を `lanes` へ改訂。レーン構成は
 *    waveformLanes の規則=下記)
 *   (判別子は `state`。表示用の付加フィールドの追加は自由=テストは toMatchObject。
 *    帯に出す説明文そのものは人間ゲート=契約⑤)
 *
 * ### 関数(12)
 * - `waveformPlan(videoUri: string, durationSeconds: number | null,
 *   hasAudioTrack: boolean | null): WaveformPlan` — 経路と取得可否の事前判定
 *   (契約①③④⑤)。判定順は固定: hasAudioTrack === false → skip/no-audio
 *   (経路より先=音声が無ければ経路は関係ない)→ durationSeconds が 60 分「超」
 *   (Infinity 含む)→ skip/too-long(ちょうど 3600 は可・null / NaN =尺不明は
 *   尺では弾かない=fail-open・バイト上限が守る)→ URI 末尾セグメントの拡張子が
 *   .mov(大文字小文字不問)→ extract 経路・それ以外(mp4/webm/不明)→ fetch 経路
 *   (対象の絞り mp4/mov/webm は配線=契約①。ここは fail-open で fetch に倒す)
 * - `loadWaveformSource(videoUri: string): Promise<WaveformSource>` — fetch 経路の
 *   **唯一の IO**。`fetch(toAssetUri(videoUri))` を**1回だけ**呼ぶ(動画本体)。
 *   throw しない。ネットワーク失敗・HTTP エラー(404 含む=再生中の実体が読めないのは
 *   「無い」ではなく縮退)→ unreadable。content-length 申告が上限「超」→ **本文を
 *   読まずに** too-large(契約④の事前判定)。実測(arrayBuffer/bytes)が上限超 →
 *   too-large(二重判定)。ちょうど上限は ok(超だけを弾く=8MiB キャップと同じ読み)
 * - `mixToMono(channels: Float32Array[]): Float32Array` — 全チャンネルの標本ごとの
 *   平均。1ch は値そのまま・0ch は長さ0・入力を書き換えない
 * - `extractPeaks(samples: Float32Array, buckets: number): WaveformPeaks` —
 *   min/max バケット化。本数 n = min(buckets, samples.length)(buckets < 1 は 0)。
 *   バケット i の範囲は **[floor(i×N/n), floor((i+1)×N/n))**(N=サンプル数。
 *   全サンプルがちょうど1つのバケットに属し、全体の min/max が保存される)。
 *   非有限サンプル(NaN/±Infinity)は **0 として扱う**。値の clamp はしない
 *   (描画側 peakRects の仕事)
 * - `peaksFromAudioBuffer(buffer: WaveformAudioBuffer, buckets = WAVEFORM_BUCKETS):
 *   WaveformPeaks` — `extractPeaks(mixToMono(全チャンネルの getChannelData), buckets)`
 *   と同値(構造的型の入口=契約⑦。既存 export のまま=lanes 化後も不変)
 * - `waveformLanes(buffer: WaveformAudioBuffer, buckets = WAVEFORM_BUCKETS):
 *   WaveformPeaks[]` — レーン分解(追補d)。1ch → [ch0 の extractPeaks]・
 *   2ch → **[L, R]**(getChannelData(0)/(1) を各々 extractPeaks。上=L・下=R)・
 *   3ch 以上 → [全 ch 平均 mono の1本](= peaksFromAudioBuffer と同値の縮退)・
 *   0ch → []。入力を書き換えない
 * - `laneBoxes(laneCount: number, height: number): { y: number; h: number }[]` —
 *   レーンの縦配置(追補d)。帯総高 height を**隙間なく等分割**
 *   (y = height×i/n・h = height/n。総和= height =帯総高不変。区切り線の描画は
 *   配線側の裁量)。laneCount < 1 は []
 * - `peakRects(peaks: WaveformPeaks, width: number, height: number): PeakRect[]` —
 *   描画幾何(契約②)。バケット i は x = width×i/n・w = width/n(先頭は 0・末尾の
 *   右端は width)。縦は振幅を [-1,1] へ clamp して y = (1−max)×height/2・
 *   h = max(0, (max−min)×height/2)(無音は中央線上の高さ0・フルスケールは全高)
 * - `positionToX(seconds: number, durationSeconds: number, width: number): number` —
 *   再生ヘッドの x。seconds を [0, duration] へ clamp して比例配分。duration・width が
 *   正の有限でない/seconds が非有限なら 0(描画を壊さない防御)
 * - `xToSeconds(x: number, width: number, durationSeconds: number): number` —
 *   逆変換。x を [0, width] へ clamp。width が正の有限でない/x・duration が
 *   非有限なら 0。positionToX と往復同値(シークバーと同じ 0〜barDuration の軸)
 * - `waveformSeekTime(x: number, width: number, durationSeconds: number,
 *   index: FrameIndex | null): number` — 波形クリック→シーク先(契約⑥)。
 *   t = xToSeconds(x, width, durationSeconds)。索引あり=
 *   `seekTimeForFrame(index, nearestFrame(index, t))` と同値(#37 の吸着経路の
 *   再利用)・null(索引の取れない動画の縮退)= t そのまま
 * - `analyzeWaveform(videoUri: string, input: { durationSeconds: number | null;
 *   hasAudioTrack: boolean | null; decode: WaveformDecode;
 *   extract: WaveformExtract; buckets?: number }): Promise<WaveformResult>` —
 *   縮退分岐の統合(契約①③④⑤)。throw しない。
 *   waveformPlan の skip → その reason を状態として返す(fetch も extract もしない)。
 *   fetch 経路(mp4/webm)= loadWaveformSource → 縮退はそのまま状態へ(decode
 *   しない)→ ok の bytes を decode。extract 経路(mov)= extract(videoUri) を
 *   **1回だけ**呼ぶ(fetch しない)→ no-audio / unsupported-codec / unreadable は
 *   そのまま状態へ・extract の reject/同期 throw → unreadable(fail-open)→
 *   ok の bytes が 256MiB「超」→ too-large(**抽出後音声バイトへの適用**=契約④。
 *   ちょうどは可・decode しない)→ decode。
 *   decode の reject・同期 throw → decode-failed(破損データ等の総受け。
 *   **例外種別から音声なし/非対応コンテナを推定しない**=区別不能が実測事実。
 *   出し分けは事前判定= hasAudioTrack と extract の応答で行う)。
 *   decode 結果が空(numberOfChannels < 1 または length < 1)→ no-audio。
 *   それ以外 → ready + `waveformLanes(decoded, buckets ?? WAVEFORM_BUCKETS)` と
 *   同値の lanes(追補d)。decode には取得/抽出したバイト列がそのまま渡る
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - ツールバーのトグル(要件#40「素材」ボタンと同じ aria-pressed 作法)・既定は閉・
 *   開いて初めて解析する・結果の src 単位キャッシュ(契約①)
 *   **【要件#44(2026-09-02)追補】**: このうちトグル・既定閉・遅延解析は失効 ――
 *   波形は**常時表示**(トグルと waveformOpen の廃止・帯とハンドルは常時 DOM)へ、
 *   解析は src 変化(+inline)での**自動起動**へ改訂。音声トラック事前判定
 *   (detectAudioTrack)はメタデータ到達を effect の依存に入れず、effect 内の
 *   非同期フローで loadedmetadata を await してから行う(要件#44 契約②)。
 *   src 単位キャッシュ(analyzedSrc)と解析中/縮退表示は現行のまま(契約③)。
 *   常時表示・即解析の配線は VideoViewer.wiring.test.ts が機械判定し、残る接続は
 *   引き続き reviewer 照合。本ファイルの純関数契約(経路・バケット・縮退・シーク)は
 *   この改訂の影響を受けない
 * - 帯の配置(`.video-controls` 内のシークバー直上)・横軸がシークバーと同一
 *   (幅・0〜barDuration の一致)・再生ヘッドの追従(契約②)
 * - 実 decode = OfflineAudioContext(mono/8kHz)の decodeAudioData を
 *   WaveformDecode として注入する接続(契約③)
 * - mov 抽出の IPC 配線= Rust コマンド(例: `extract_waveform_audio`)の登録・
 *   応答形・invoke を WaveformExtract へ写す接続(契約③改訂。Rust 側の純関数は
 *   src-tauri/tests/acceptance_req41.rs が判定)
 * - 既存 `<video>` の音声出力経路に触れない(createMediaElementSource 不使用=
 *   既存再生挙動の不変)・依存追加ゼロ・CSP 変更ゼロ・Rust 追加は mov 抽出
 *   コマンドのみ(契約③⑧)
 * - 対象の絞り(mp4/mov/webm×ローカル inline のみ=契約①)・縮退の説明文言(契約⑤)・
 *   再生を止めない fail-open の実挙動(契約⑤)
 *
 * ## 人間ゲート(acceptance/acceptance.md)
 * - 波形の見た目・シークバーとの横軸一致の体感・解析待ちの体感・実素材での縮退表示
 *   (音声なし mp4・未対応コーデックの mov)・実 mov(AAC/PCM 音声)と実 webm
 *   (Opus 音声)で波形が出ること・波形クリックで狙ったカット位置に跳べる体感・
 *   **ステレオ実素材で L/R 2段が上下に見えること(追補d)**
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	WAVEFORM_BUCKETS,
	WAVEFORM_MAX_SOURCE_BYTES,
	analyzeWaveform,
	extractPeaks,
	laneBoxes,
	loadWaveformSource,
	mixToMono,
	peakRects,
	peaksFromAudioBuffer,
	positionToX,
	waveformLanes,
	waveformPlan,
	waveformSeekTime,
	xToSeconds,
} from './audio-waveform';
import type {
	WaveformAudioBuffer,
	WaveformDecode,
	WaveformExtract,
	WaveformExtraction,
	WaveformPeaks,
} from './audio-waveform';
// 要件#45 追記: 新設 export(waveformBandNote)は namespace 経由で参照する ――
// 実装前(export 不在)でも本ファイルのモジュール読込が落ちず、既存ケースが
// 巻き添えにならないため(赤は該当ケースの assertion で出る)。
import * as AudioWaveform from './audio-waveform';
import type { WaveformResult } from './audio-waveform';
import { nearestFrame, seekTimeForFrame } from './video-frame';
import type { FrameIndex } from './video-frame';
import { toAssetUri } from './uri';

// ---------------------------------------------------------------------------
// フィクスチャとヘルパー
// ---------------------------------------------------------------------------

const VIDEO = 'file:///Users/a/movies/final.mp4';
const VIDEO_MOV = 'file:///Users/a/movies/final.mov';

/**
 * fetch モックへ返す Response もどき(video-provenance.acceptance.test.ts の作法)。
 * こちらは契約④の「content-length 事前判定で本文を読まない」を判定するため、
 * 申告値(declared)を本文と切り離して指定でき、本文読み(arrayBuffer/bytes)は
 * spy で観測する。text() は持たない(波形はバイナリ経路のみ)。
 * declared: undefined=本文実測と同値・null=ヘッダ無し・number=その申告値。
 */
function fakeResponse(
	status: number,
	body: Uint8Array = new Uint8Array(0),
	declared?: number | null,
) {
	const declaredLength = declared === undefined ? body.byteLength : declared;
	const buffer =
		body.byteOffset === 0 && body.byteLength === body.buffer.byteLength
			? body.buffer
			: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: {
			get: (name: string) =>
				name.toLowerCase() === 'content-length' && declaredLength !== null
					? String(declaredLength)
					: null,
		},
		arrayBuffer: vi.fn(async () => buffer),
		bytes: vi.fn(async () => new Uint8Array(buffer)),
	};
}

/** 最初の fetch 呼び出しの要求先(文字列・URL・Request のどれで渡されてもよい)。 */
function firstRequestUrl(fetchMock: ReturnType<typeof vi.fn>): string {
	const arg: unknown = fetchMock.mock.calls[0][0];
	if (typeof arg === 'string') return arg;
	if (arg instanceof URL) return arg.href;
	return String((arg as { url?: unknown })?.url ?? arg);
}

/** 構造的 AudioBuffer(契約⑦)。jsdom に実 AudioBuffer が無くてもプレーンオブジェクトで足りる。 */
function audioBuf(channels: (number[] | Float32Array)[], sampleRate = 8000): WaveformAudioBuffer {
	const data = channels.map((ch) => Float32Array.from(ch));
	return {
		numberOfChannels: data.length,
		length: data[0]?.length ?? 0,
		sampleRate,
		getChannelData: (channel: number) => data[channel],
	};
}

/** decode モック(受け取ったバイト列を無視して固定の AudioBuffer を返す)。 */
function decodeTo(buffer: WaveformAudioBuffer) {
	return vi.fn(async (_bytes: ArrayBuffer) => buffer);
}

/** extract モック(mov 抽出経路の応答を固定で返す)。 */
function extractTo(extraction: WaveformExtraction) {
	return vi.fn(async (_videoUri: string) => extraction);
}

/** fetch 経路のテストに渡す「呼ばれないはず」の extract。呼ばれの有無は spy で判定する。 */
function extractNever() {
	return extractTo({ state: 'unreadable' });
}

/** 決定的な擬似ノイズ(k/128 の2進小数=float32 で正確に表せる値だけを使う)。 */
function dyadicNoise(length: number): Float32Array {
	return Float32Array.from({ length }, (_, i) => (((i * 37 + 11) % 257) - 128) / 128);
}

/** extractPeaks の参照実装(floor 境界の線形走査)。契約の分割規則そのもの。 */
function refPeaks(samples: Float32Array, buckets: number): { mins: number[]; maxs: number[] } {
	const n = Math.min(buckets, samples.length);
	const mins: number[] = [];
	const maxs: number[] = [];
	for (let i = 0; i < n; i++) {
		const from = Math.floor((i * samples.length) / n);
		const to = Math.floor(((i + 1) * samples.length) / n);
		let mn = Infinity;
		let mx = -Infinity;
		for (let j = from; j < to; j++) {
			const v = Number.isFinite(samples[j]) ? samples[j] : 0;
			mn = Math.min(mn, v);
			mx = Math.max(mx, v);
		}
		mins.push(mn);
		maxs.push(mx);
	}
	return { mins, maxs };
}

/** CFR フレーム索引を合成する(times[i] = i × fpsDen / fpsNum。#39/#40 と同じ作り)。 */
function cfrIndex(fpsNum: number, fpsDen: number, frameCount: number): FrameIndex {
	const times = Array.from({ length: frameCount }, (_, i) => (i * fpsDen) / fpsNum);
	return { times, duration: (frameCount * fpsDen) / fpsNum, fpsNum, fpsDen, isCfr: true };
}

// ---------------------------------------------------------------------------
// 定数 — 上限とバケット数の初期値(契約③④)
// ---------------------------------------------------------------------------

describe('定数 — 上限とバケット数(要件#41 契約③④・実尺上限は要件#45 契約②で撤廃・fetch 上限は要件#50 契約⑬(b) で分離)', () => {
	it('WAVEFORM_MAX_SOURCE_BYTES=256MiB(抽出側の門として存置)・既定バケット=2000(WAVEFORM_MAX_DURATION_SECONDS は撤廃)', () => {
		expect(WAVEFORM_MAX_SOURCE_BYTES).toBe(256 * 1024 * 1024);
		expect(WAVEFORM_BUCKETS).toBe(2000);
	});

	it('WAVEFORM_MAX_FETCH_BYTES=512MiB(fetch 側の門=要件#50 契約⑬(b) 新設。2時間の mp3/m4a 320kbps=275MiB が通る)', () => {
		expect(fetchLimitBytes()).toBe(512 * 1024 * 1024);
	});
});

// ---------------------------------------------------------------------------
// waveformPlan — 経路と取得可否の事前判定(契約①③④⑤)
// ---------------------------------------------------------------------------

describe('waveformPlan — 経路と取得可否の事前判定(要件#41 契約①③④⑤)', () => {
	// 「mp4 / webm → fetch」の旧ケースは要件#45 契約①で失効(mp4 → extract・
	// webm → fetch の新契約は末尾の #45 セクションが固定)= 2026-09-02 更新で削除。

	it('mov → Rust 抽出経路(QuickTime は decodeAudioData が食えない=実測)', () => {
		expect(waveformPlan(VIDEO_MOV, 10, true)).toEqual({ route: 'extract' });
	});

	it('拡張子は大文字小文字を区別しない(.MOV / .Mov も extract)', () => {
		expect(waveformPlan('file:///a/CAMERA.MOV', 10, true)).toEqual({ route: 'extract' });
		expect(waveformPlan('file:///a/clip.Mov', 10, true)).toEqual({ route: 'extract' });
	});

	it('パーセントエンコード名・パス途中のドットでも末尾拡張子で判定する(要件#45: mp4 も extract)', () => {
		expect(waveformPlan('file:///a/%E7%B4%A0%E6%9D%90.mov', 10, true)).toEqual({
			route: 'extract',
		});
		expect(waveformPlan('file:///a/v1.2.final.mp4', 10, true)).toEqual({ route: 'extract' });
		expect(waveformPlan('file:///a.mov/clip.mp4', 10, true)).toEqual({ route: 'extract' });
	});

	it('不明な拡張子は fetch に倒す(対象の絞り mp4/mov/webm は配線=契約①・fail-open)', () => {
		expect(waveformPlan('file:///a/clip.mkv', 10, true)).toEqual({ route: 'fetch' });
	});

	it('音声トラックなし(false)→ skip/no-audio が経路より先(mov でも)', () => {
		expect(waveformPlan(VIDEO, 10, false)).toEqual({ route: 'skip', reason: 'no-audio' });
		expect(waveformPlan(VIDEO_MOV, 10, false)).toEqual({ route: 'skip', reason: 'no-audio' });
		expect(waveformPlan(VIDEO, 7200, false)).toEqual({ route: 'skip', reason: 'no-audio' });
	});

	// 「60分超 → too-long」「Infinity → too-long」の旧ケースは要件#45 契約②の
	// too-long 撤廃で失効(60分超でも経路へ進むことは末尾の #45 セクションが固定)
	// = 2026-09-02 更新で削除。

	it('尺不明(null)・音声有無不明(null)は弾かず経路へ進む(fail-open。mp4 の尺不明は #45 セクションで固定)', () => {
		expect(waveformPlan(VIDEO_MOV, null, null)).toEqual({ route: 'extract' });
	});
});

// ---------------------------------------------------------------------------
// loadWaveformSource — fetch 経路の取得と上限の二重判定(契約③④・fetch モック)
// ---------------------------------------------------------------------------

describe('loadWaveformSource — fetch 経路の取得と上限の二重判定(要件#41 契約③④)', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('200 → ok(bytes は本文そのまま)・要求は動画本体の asset 変換 URL・fetch は1回', async () => {
		const body = new Uint8Array([7, 8, 9]);
		fetchMock.mockResolvedValueOnce(fakeResponse(200, body));
		const result = await loadWaveformSource(VIDEO);
		expect(result).toMatchObject({ state: 'ok' });
		if (result.state === 'ok') expect(new Uint8Array(result.bytes)).toEqual(body);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		// 要求 URL は「動画 URI の asset 変換」と同値、かつ絶対形も固定する(#40 と同作法)。
		expect(firstRequestUrl(fetchMock)).toBe(toAssetUri(VIDEO));
		expect(firstRequestUrl(fetchMock)).toBe('vellis-asset://local/Users/a/movies/final.mp4');
	});

	it('webm でも同じ取得経路(サイドカーではなく動画そのもの=契約①③)', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(404));
		await loadWaveformSource('file:///a/clip.webm');
		expect(firstRequestUrl(fetchMock)).toBe('vellis-asset://local/a/clip.webm');
	});

	it('HTTP 404 → unreadable(再生中の実体が読めないのは「無い」ではなく縮退)', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(404));
		expect(await loadWaveformSource(VIDEO)).toMatchObject({ state: 'unreadable' });
	});

	it('HTTP エラー(500)→ unreadable', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(500));
		expect(await loadWaveformSource(VIDEO)).toMatchObject({ state: 'unreadable' });
	});

	it('ネットワーク失敗(fetch reject)→ unreadable(throw しない=fail-open)', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		expect(await loadWaveformSource(VIDEO)).toMatchObject({ state: 'unreadable' });
	});

	// 上限4件の参照定数は要件#50 契約⑬(b) で fetch 側の門(WAVEFORM_MAX_FETCH_BYTES=
	// 512MiB)へ差し替え(2026-09-10 追補a)。「超」だけを弾く・ちょうどは通す・
	// 事前判定+実測の二重判定、という判定の意味は不変。

	it('content-length 申告が上限超 → too-large・本文は読まない(契約④の事前判定)', async () => {
		const response = fakeResponse(200, new Uint8Array([1, 2, 3]), fetchLimitBytes() + 1);
		fetchMock.mockResolvedValueOnce(response);
		expect(await loadWaveformSource(VIDEO)).toMatchObject({ state: 'too-large' });
		expect(response.arrayBuffer).not.toHaveBeenCalled();
		expect(response.bytes).not.toHaveBeenCalled();
	});

	it('content-length 申告がちょうど上限 → 弾かない(「超」だけを弾く)', async () => {
		fetchMock.mockResolvedValueOnce(
			fakeResponse(200, new Uint8Array([1, 2, 3]), fetchLimitBytes()),
		);
		expect(await loadWaveformSource(VIDEO)).toMatchObject({ state: 'ok' });
	});

	it('content-length 無し・実測が上限超 → too-large(二重判定の実測側)', async () => {
		fetchMock.mockResolvedValueOnce(
			fakeResponse(200, new Uint8Array(fetchLimitBytes() + 1), null),
		);
		expect(await loadWaveformSource(VIDEO)).toMatchObject({ state: 'too-large' });
	});

	it('content-length 無し・実測ちょうど上限 → ok', async () => {
		fetchMock.mockResolvedValueOnce(
			fakeResponse(200, new Uint8Array(fetchLimitBytes()), null),
		);
		const result = await loadWaveformSource(VIDEO);
		expect(result).toMatchObject({ state: 'ok' });
		if (result.state === 'ok') expect(result.bytes.byteLength).toBe(fetchLimitBytes());
	});
});

// ---------------------------------------------------------------------------
// mixToMono — 平均で mono 化(契約③)
// ---------------------------------------------------------------------------

describe('mixToMono — 平均で mono 化(要件#41 契約③)', () => {
	it('1ch は値そのまま', () => {
		const mono = mixToMono([Float32Array.from([0.25, -0.5, 1])]);
		expect(Array.from(mono)).toEqual([0.25, -0.5, 1]);
	});

	it('2ch は標本ごとの平均', () => {
		const mono = mixToMono([Float32Array.from([1, -1]), Float32Array.from([0, 0.5])]);
		expect(Array.from(mono)).toEqual([0.5, -0.25]);
	});

	it('3ch でも平均', () => {
		const mono = mixToMono([
			Float32Array.from([0.75]),
			Float32Array.from([0.25]),
			Float32Array.from([0.5]),
		]);
		expect(Array.from(mono)).toEqual([0.5]);
	});

	it('チャンネル0本 → 長さ0の Float32Array', () => {
		const mono = mixToMono([]);
		expect(mono).toBeInstanceOf(Float32Array);
		expect(mono.length).toBe(0);
	});

	it('入力チャンネルを書き換えない', () => {
		const left = Float32Array.from([0.5, -0.5]);
		const right = Float32Array.from([0.25, 0.25]);
		mixToMono([left, right]);
		expect(Array.from(left)).toEqual([0.5, -0.5]);
		expect(Array.from(right)).toEqual([0.25, 0.25]);
	});
});

// ---------------------------------------------------------------------------
// extractPeaks — min/max バケット化(契約②③=本数・境界・値)
// ---------------------------------------------------------------------------

describe('extractPeaks — min/max バケット化(要件#41 契約②③)', () => {
	it('単一バケットは全体の min/max', () => {
		const peaks = extractPeaks(Float32Array.from([0.25, -0.5, 0.125]), 1);
		expect(Array.from(peaks.mins)).toEqual([-0.5]);
		expect(Array.from(peaks.maxs)).toEqual([0.25]);
	});

	it('割り切れる分割(N=4・buckets=2)の境界と値', () => {
		const peaks = extractPeaks(Float32Array.from([0.5, -0.25, 0.75, -0.5]), 2);
		expect(Array.from(peaks.mins)).toEqual([-0.25, -0.5]);
		expect(Array.from(peaks.maxs)).toEqual([0.5, 0.75]);
	});

	it('端数分割は floor(i×N/n) 境界(N=7・buckets=3 → [0,2)[2,4)[4,7))', () => {
		const samples = Float32Array.from([0.125, 0.25, -0.375, 0.5, 0.625, -0.75, 0.875]);
		const peaks = extractPeaks(samples, 3);
		expect(Array.from(peaks.mins)).toEqual([0.125, -0.375, -0.75]);
		expect(Array.from(peaks.maxs)).toEqual([0.25, 0.5, 0.875]);
	});

	it('サンプル数 < バケット数 → 本数=サンプル数(各バケット1サンプル)', () => {
		const peaks = extractPeaks(Float32Array.from([0.5, -0.25, 0.125]), 5);
		expect(Array.from(peaks.mins)).toEqual([0.5, -0.25, 0.125]);
		expect(Array.from(peaks.maxs)).toEqual([0.5, -0.25, 0.125]);
	});

	it('空入力 → 空 peaks', () => {
		const peaks = extractPeaks(new Float32Array(0), 2000);
		expect(peaks.mins.length).toBe(0);
		expect(peaks.maxs.length).toBe(0);
	});

	it('buckets < 1 → 空 peaks(防御)', () => {
		const peaks = extractPeaks(Float32Array.from([0.5]), 0);
		expect(peaks.mins.length).toBe(0);
		expect(peaks.maxs.length).toBe(0);
	});

	it('NaN は 0 として扱う(全 NaN バケットは 0/0)', () => {
		const mixed = extractPeaks(Float32Array.from([NaN, 0.5]), 1);
		expect(Array.from(mixed.mins)).toEqual([0]);
		expect(Array.from(mixed.maxs)).toEqual([0.5]);

		const allNaN = extractPeaks(Float32Array.from([NaN, NaN]), 1);
		expect(Array.from(allNaN.mins)).toEqual([0]);
		expect(Array.from(allNaN.maxs)).toEqual([0]);
	});

	it('±Infinity も 0 として扱う(デコード異常値の防御)', () => {
		const peaks = extractPeaks(Float32Array.from([Infinity, -0.5, -Infinity, 0.25]), 1);
		expect(Array.from(peaks.mins)).toEqual([-0.5]);
		expect(Array.from(peaks.maxs)).toEqual([0.25]);
	});

	it('出力は同じ長さの Float32Array 2本', () => {
		const peaks = extractPeaks(Float32Array.from([0.5, -0.5, 0.25]), 2);
		expect(peaks.mins).toBeInstanceOf(Float32Array);
		expect(peaks.maxs).toBeInstanceOf(Float32Array);
		expect(peaks.mins.length).toBe(peaks.maxs.length);
		expect(peaks.mins.length).toBe(2);
	});

	it('参照実装(floor 境界の線形走査)と全一致(N=1000/n=37・N=8000/n=2000)', () => {
		for (const [n, buckets] of [
			[1000, 37],
			[8000, 2000],
		] as const) {
			const samples = dyadicNoise(n);
			const peaks = extractPeaks(samples, buckets);
			const ref = refPeaks(samples, buckets);
			expect(Array.from(peaks.mins)).toEqual(ref.mins);
			expect(Array.from(peaks.maxs)).toEqual(ref.maxs);
		}
	});

	it('大域性質: どのサンプルも1つのバケットに属す(全体の min/max が保存される)', () => {
		const samples = dyadicNoise(1000);
		const peaks = extractPeaks(samples, 37);
		expect(Math.max(...Array.from(peaks.maxs))).toBe(Math.max(...Array.from(samples)));
		expect(Math.min(...Array.from(peaks.mins))).toBe(Math.min(...Array.from(samples)));
	});

	it('スパイクが正しいバケットに落ちる(N=16000・n=2000=8サンプル/バケット)', () => {
		const samples = new Float32Array(16000);
		samples[8 * 1234 + 3] = 0.5;
		const peaks = extractPeaks(samples, 2000);
		expect(peaks.maxs[1234]).toBe(0.5);
		expect(peaks.maxs[1233]).toBe(0);
		expect(peaks.maxs[1235]).toBe(0);
		expect(peaks.mins[1234]).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// peaksFromAudioBuffer — 構造的 AudioBuffer の入口(契約⑦)
// ---------------------------------------------------------------------------

describe('peaksFromAudioBuffer — 構造的 AudioBuffer の入口(要件#41 契約⑦)', () => {
	it('2ch のプレーンオブジェクト(実 AudioBuffer 不要)で mixToMono+extractPeaks と同値', () => {
		const buffer = audioBuf([
			[0.5, -0.5, 0.25, -0.25],
			[0.25, 0.25, -0.75, 0.25],
		]);
		const peaks = peaksFromAudioBuffer(buffer, 2);
		expect(peaks).toEqual(
			extractPeaks(mixToMono([buffer.getChannelData(0), buffer.getChannelData(1)]), 2),
		);
		// 絶対値も1点固定(等式の空回り防止): mono = [0.375, -0.125, -0.25, 0]
		expect(Array.from(peaks.mins)).toEqual([-0.125, -0.25]);
		expect(Array.from(peaks.maxs)).toEqual([0.375, 0]);
	});

	it('1ch はそのチャンネルの extractPeaks と同値', () => {
		const buffer = audioBuf([[0.125, -0.625, 0.5]]);
		expect(peaksFromAudioBuffer(buffer, 3)).toEqual(extractPeaks(buffer.getChannelData(0), 3));
	});

	it('既定バケット数は WAVEFORM_BUCKETS(短い音声は全サンプル分)', () => {
		expect(peaksFromAudioBuffer(audioBuf([new Array(6000).fill(0)])).mins.length).toBe(
			WAVEFORM_BUCKETS,
		);
		expect(peaksFromAudioBuffer(audioBuf([[0.5, -0.5, 0.25, -0.25]])).mins.length).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// waveformLanes — レーン分解(追補d=第2周)
// ---------------------------------------------------------------------------

describe('waveformLanes — レーン分解(要件#41 追補d)', () => {
	it('1ch → 1レーン(そのチャンネルの extractPeaks と同値)', () => {
		const buffer = audioBuf([[0.5, -0.25, 0.125, -0.5]]);
		const lanes = waveformLanes(buffer, 2);
		expect(lanes).toHaveLength(1);
		expect(lanes[0]).toEqual(extractPeaks(buffer.getChannelData(0), 2));
	});

	it('2ch → [L, R] の2レーン(上=L=ch0・下=R=ch1。平均しない)', () => {
		const left = [0.5, -0.5, 0.25, -0.25];
		const right = [0.25, 0.25, -0.75, 0.25];
		const buffer = audioBuf([left, right]);
		const lanes = waveformLanes(buffer, 2);
		expect(lanes).toHaveLength(2);
		expect(lanes[0]).toEqual(extractPeaks(Float32Array.from(left), 2));
		expect(lanes[1]).toEqual(extractPeaks(Float32Array.from(right), 2));
		// 絶対値も固定(等式の空回り防止)。mono 平均([0.375, …])とは一致しない値。
		expect(Array.from(lanes[0].maxs)).toEqual([0.5, 0.25]);
		expect(Array.from(lanes[1].mins)).toEqual([0.25, -0.75]);
	});

	it('3ch 以上 → 全 ch 平均 mono の1レーンへ縮退(peaksFromAudioBuffer と同値)', () => {
		const buffer = audioBuf([
			[0.75, 0.25],
			[0.25, 0.25],
			[0.5, 0.25],
		]);
		const lanes = waveformLanes(buffer, 2);
		expect(lanes).toHaveLength(1);
		expect(lanes[0]).toEqual(peaksFromAudioBuffer(buffer, 2));
		expect(Array.from(lanes[0].maxs)).toEqual([0.5, 0.25]);
	});

	it('0ch → [](レーンなし)', () => {
		expect(waveformLanes(audioBuf([]), 2)).toEqual([]);
	});

	it('既定バケット数は WAVEFORM_BUCKETS(analyzeWaveform の既定と同じ)', () => {
		const buffer = audioBuf([new Array(6000).fill(0), new Array(6000).fill(0)]);
		const lanes = waveformLanes(buffer);
		expect(lanes).toHaveLength(2);
		expect(lanes[0].mins.length).toBe(WAVEFORM_BUCKETS);
		expect(lanes[1].mins.length).toBe(WAVEFORM_BUCKETS);
	});

	it('入力チャンネルを書き換えない', () => {
		const left = Float32Array.from([0.5, -0.5]);
		const right = Float32Array.from([0.25, 0.25]);
		const buffer: WaveformAudioBuffer = {
			numberOfChannels: 2,
			length: 2,
			sampleRate: 8000,
			getChannelData: (channel) => (channel === 0 ? left : right),
		};
		waveformLanes(buffer, 1);
		expect(Array.from(left)).toEqual([0.5, -0.5]);
		expect(Array.from(right)).toEqual([0.25, 0.25]);
	});
});

// ---------------------------------------------------------------------------
// laneBoxes — レーンの縦配置(追補d=第2周)
// ---------------------------------------------------------------------------

describe('laneBoxes — レーンの縦配置(要件#41 追補d)', () => {
	it('1レーン → 全高1箱(mono。帯総高不変)', () => {
		expect(laneBoxes(1, 56)).toEqual([{ y: 0, h: 56 }]);
	});

	it('2レーン → 上下等分割(上=L・下=R の器。隙間なし・総高不変)', () => {
		expect(laneBoxes(2, 56)).toEqual([
			{ y: 0, h: 28 },
			{ y: 28, h: 28 },
		]);
	});

	it('奇数高でも実数の等分割で連続被覆(y[i+1] = y[i]+h[i]・総和 = height)', () => {
		const boxes = laneBoxes(2, 57);
		expect(boxes[0]).toEqual({ y: 0, h: 28.5 });
		expect(boxes[1]).toEqual({ y: 28.5, h: 28.5 });
		expect(boxes.reduce((sum, box) => sum + box.h, 0)).toBe(57);
	});

	it('3レーンでも同じ規則(y = height×i/n・h = height/n)', () => {
		expect(laneBoxes(3, 60)).toEqual([
			{ y: 0, h: 20 },
			{ y: 20, h: 20 },
			{ y: 40, h: 20 },
		]);
	});

	it('0レーン・負値 → [](縮退の帯は文言のみ=箱を作らない)', () => {
		expect(laneBoxes(0, 56)).toEqual([]);
		expect(laneBoxes(-1, 56)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// peakRects — 描画幾何(契約②)
// ---------------------------------------------------------------------------

describe('peakRects — エンベロープ帯の描画幾何(要件#41 契約②)', () => {
	it('横は等分割(先頭 x=0・末尾の右端=width)', () => {
		const peaks: WaveformPeaks = {
			mins: Float32Array.from([0, 0, 0, 0]),
			maxs: Float32Array.from([0, 0, 0, 0]),
		};
		const rects = peakRects(peaks, 350, 40);
		expect(rects).toHaveLength(4);
		expect(rects[0].x).toBe(0);
		expect(rects.map((r) => r.w)).toEqual([87.5, 87.5, 87.5, 87.5]);
		expect(rects[1].x).toBe(87.5);
		expect(rects[3].x + rects[3].w).toBe(350);
	});

	it('縦は振幅の線形写像(フルスケール→全高・無音→中央線上の高さ0・混合値)', () => {
		const peaks: WaveformPeaks = {
			mins: Float32Array.from([-1, 0, -0.25]),
			maxs: Float32Array.from([1, 0, 0.5]),
		};
		const rects = peakRects(peaks, 300, 100);
		expect(rects[0]).toEqual({ x: 0, w: 100, y: 0, h: 100 });
		expect(rects[1]).toEqual({ x: 100, w: 100, y: 50, h: 0 });
		expect(rects[2]).toEqual({ x: 200, w: 100, y: 25, h: 37.5 });
	});

	it('振幅は [-1,1] へ clamp(decodeAudioData は 1 を超え得る)', () => {
		const rects = peakRects(
			{ mins: Float32Array.from([-3]), maxs: Float32Array.from([2]) },
			10,
			100,
		);
		expect(rects[0]).toEqual({ x: 0, w: 10, y: 0, h: 100 });
	});

	it('min > max の壊れ入力は h=0(防御)', () => {
		const rects = peakRects(
			{ mins: Float32Array.from([0.5]), maxs: Float32Array.from([0.25]) },
			10,
			100,
		);
		expect(rects[0].h).toBe(0);
		expect(rects[0].y).toBe(37.5);
	});

	it('空 peaks → []', () => {
		expect(peakRects({ mins: new Float32Array(0), maxs: new Float32Array(0) }, 300, 40)).toEqual(
			[],
		);
	});
});

// ---------------------------------------------------------------------------
// positionToX / xToSeconds — 横軸の往復変換(契約②)
// ---------------------------------------------------------------------------

describe('positionToX / xToSeconds — 横軸の往復変換(要件#41 契約②)', () => {
	it('positionToX: 比例配分と端 clamp', () => {
		expect(positionToX(2.75, 5.5, 200)).toBe(100);
		expect(positionToX(0, 5.5, 200)).toBe(0);
		expect(positionToX(5.5, 5.5, 200)).toBe(200);
		expect(positionToX(7, 5.5, 200)).toBe(200);
		expect(positionToX(-1, 5.5, 200)).toBe(0);
	});

	it('positionToX: 縮退(尺・幅・秒が壊れているときは 0=描画を壊さない)', () => {
		expect(positionToX(1, 0, 200)).toBe(0);
		expect(positionToX(1, NaN, 200)).toBe(0);
		expect(positionToX(1, Infinity, 200)).toBe(0);
		expect(positionToX(NaN, 5.5, 200)).toBe(0);
		expect(positionToX(1, 5.5, NaN)).toBe(0);
	});

	it('xToSeconds: 比例配分と端 clamp', () => {
		expect(xToSeconds(100, 200, 5.5)).toBe(2.75);
		expect(xToSeconds(0, 200, 5.5)).toBe(0);
		expect(xToSeconds(200, 200, 5.5)).toBe(5.5);
		expect(xToSeconds(260, 200, 5.5)).toBe(5.5);
		expect(xToSeconds(-4, 200, 5.5)).toBe(0);
	});

	it('xToSeconds: 縮退(幅・座標・尺が壊れているときは 0)', () => {
		expect(xToSeconds(10, 0, 5.5)).toBe(0);
		expect(xToSeconds(10, NaN, 5.5)).toBe(0);
		expect(xToSeconds(NaN, 200, 5.5)).toBe(0);
		expect(xToSeconds(10, 200, NaN)).toBe(0);
		expect(xToSeconds(10, 200, Infinity)).toBe(0);
	});

	it('往復同値(クリック位置と再生ヘッドが同じ軸に乗る)', () => {
		for (const t of [0, 0.1, 2.75, 5.5]) {
			expect(xToSeconds(positionToX(t, 5.5, 317), 317, 5.5)).toBeCloseTo(t, 10);
		}
		for (const x of [0, 1, 158.5, 317]) {
			expect(positionToX(xToSeconds(x, 317, 5.5), 5.5, 317)).toBeCloseTo(x, 10);
		}
	});
});

// ---------------------------------------------------------------------------
// waveformSeekTime — クリック→時刻→フレーム吸着(契約⑥=#37 の等式契約)
// ---------------------------------------------------------------------------

describe('waveformSeekTime — クリック→時刻→フレーム吸着(要件#41 契約⑥)', () => {
	// 30fps・90フレーム=3秒の CFR 索引。
	const index = cfrIndex(30, 1, 90);

	it('索引 null(索引の取れない動画の縮退)→ xToSeconds の時刻へそのままシーク', () => {
		expect(waveformSeekTime(150, 300, 3, null)).toBe(xToSeconds(150, 300, 3));
		expect(waveformSeekTime(150, 300, 3, null)).toBe(1.5);
	});

	it('索引あり → nearestFrame→seekTimeForFrame の吸着経路と同値(#37 の等式契約)', () => {
		for (const x of [0, 37, 149.5, 150, 220.4, 299, 300]) {
			const t = xToSeconds(x, 300, 3);
			expect(waveformSeekTime(x, 300, 3, index)).toBe(
				seekTimeForFrame(index, nearestFrame(index, t)),
			);
		}
	});

	it('絶対値アンカー: 中央クリック(1.5秒=フレーム45境界)→ 半フレーム内側 1.5+1/60', () => {
		expect(waveformSeekTime(150, 300, 3, index)).toBeCloseTo(1.5 + 1 / 60, 12);
	});

	it('左端クリックは先頭フレームの半フレーム内側(=#39 の初期表示と同じ点)', () => {
		expect(waveformSeekTime(0, 300, 3, index)).toBeCloseTo(1 / 60, 12);
	});

	it('範囲外の x は clamp(負値→先頭フレーム・幅超→最終フレーム)', () => {
		expect(waveformSeekTime(-50, 300, 3, index)).toBe(seekTimeForFrame(index, 0));
		expect(waveformSeekTime(9999, 300, 3, index)).toBe(
			seekTimeForFrame(index, nearestFrame(index, 3)),
		);
	});
});

// ---------------------------------------------------------------------------
// analyzeWaveform — fetch 経路(webm)の統合と縮退(契約①③④⑤。
// 要件#45 契約①④で mp4 は extract 経路へ移行=本 describe は webm へ改訂)
// ---------------------------------------------------------------------------

describe('analyzeWaveform — fetch 経路(webm)の統合と縮退(要件#41 契約①③④⑤・要件#45 改訂)', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('正常系: 取得→decode→レーン分解 → ready(2ch は L/R の lanes・extract は呼ばれない)', async () => {
		const buffer = audioBuf([
			[0.5, -0.5, 0.25, -0.25],
			[0.25, 0.25, -0.75, 0.25],
		]);
		const extract = extractNever();
		fetchMock.mockResolvedValueOnce(fakeResponse(200, new Uint8Array([1, 2, 3, 4])));
		const result = await analyzeWaveform(VIDEO_WEBM, {
			durationSeconds: 12,
			hasAudioTrack: true,
			decode: decodeTo(buffer),
			extract,
		});
		expect(result).toMatchObject({ state: 'ready' });
		if (result.state === 'ready') {
			expect(result.lanes).toHaveLength(2);
			expect(result.lanes).toEqual(waveformLanes(buffer));
			expect(result.lanes[0]).toEqual(extractPeaks(buffer.getChannelData(0), WAVEFORM_BUCKETS));
			expect(result.lanes[1]).toEqual(extractPeaks(buffer.getChannelData(1), WAVEFORM_BUCKETS));
		}
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(extract).not.toHaveBeenCalled();
		expect(firstRequestUrl(fetchMock)).toBe(toAssetUri(VIDEO_WEBM));
		expect(firstRequestUrl(fetchMock)).toBe('vellis-asset://local/Users/a/movies/final.webm');
	});

	it('decode には取得した本文のバイト列がそのまま渡る', async () => {
		const body = new Uint8Array([9, 8, 7, 6, 5]);
		fetchMock.mockResolvedValueOnce(fakeResponse(200, body));
		const decode = decodeTo(audioBuf([[0.25]]));
		await analyzeWaveform(VIDEO_WEBM, {
			durationSeconds: 1,
			hasAudioTrack: true,
			decode,
			extract: extractNever(),
		});
		expect(decode).toHaveBeenCalledTimes(1);
		expect(new Uint8Array(decode.mock.calls[0][0])).toEqual(body);
	});

	it('音声トラックなし → no-audio・fetch/extract/decode すべて呼ばれない(事前判定)', async () => {
		const decode = decodeTo(audioBuf([[0.25]]));
		const extract = extractNever();
		const result = await analyzeWaveform(VIDEO, {
			durationSeconds: 10,
			hasAudioTrack: false,
			decode,
			extract,
		});
		expect(result).toMatchObject({ state: 'no-audio' });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(extract).not.toHaveBeenCalled();
		expect(decode).not.toHaveBeenCalled();
	});

	// 「実尺60分超 → too-long」の旧ケースは要件#45 契約②の too-long 撤廃で失効
	// (60分超でも解析へ進むことは末尾の #45 セクションが固定)= 2026-09-02 更新で削除。

	it('尺は縮退の理由にならない(3600秒でも尺不明(null)でも解析へ進む=要件#45 契約②)', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(200, new Uint8Array([1])));
		const exact = await analyzeWaveform(VIDEO_WEBM, {
			durationSeconds: 3600,
			hasAudioTrack: true,
			decode: decodeTo(audioBuf([[0.25, -0.25]])),
			extract: extractNever(),
		});
		expect(exact).toMatchObject({ state: 'ready' });

		fetchMock.mockResolvedValueOnce(fakeResponse(200, new Uint8Array([1])));
		const unknown = await analyzeWaveform(VIDEO_WEBM, {
			durationSeconds: null,
			hasAudioTrack: null,
			decode: decodeTo(audioBuf([[0.25, -0.25]])),
			extract: extractNever(),
		});
		expect(unknown).toMatchObject({ state: 'ready' });
	});

	it('HTTP エラー・ネットワーク失敗 → unreadable(decode されない・throw しない)', async () => {
		const decode = decodeTo(audioBuf([[0.25]]));
		fetchMock.mockResolvedValueOnce(fakeResponse(500));
		expect(
			await analyzeWaveform(VIDEO_WEBM, {
				durationSeconds: 5,
				hasAudioTrack: true,
				decode,
				extract: extractNever(),
			}),
		).toMatchObject({ state: 'unreadable' });

		fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		expect(
			await analyzeWaveform(VIDEO_WEBM, {
				durationSeconds: 5,
				hasAudioTrack: true,
				decode,
				extract: extractNever(),
			}),
		).toMatchObject({ state: 'unreadable' });
		expect(decode).not.toHaveBeenCalled();
	});

	// 「content-length 超過 → too-large」の旧ケース(mp4 前提)は、同内容の webm 版を
	// 末尾の #45 セクション(契約④=現状維持)が固定するため重複を避けて削除
	// = 2026-09-02 更新。

	it('decode の reject(破損データ等)→ decode-failed(例外種別からの出し分けはしない)', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(200, new Uint8Array([1])));
		const decode: WaveformDecode = async () => {
			throw new Error('EncodingError');
		};
		expect(
			await analyzeWaveform(VIDEO_WEBM, {
				durationSeconds: 5,
				hasAudioTrack: true,
				decode,
				extract: extractNever(),
			}),
		).toMatchObject({ state: 'decode-failed' });
	});

	it('decode の同期 throw でも decode-failed(throw しない=fail-open)', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(200, new Uint8Array([1])));
		const decode: WaveformDecode = () => {
			throw new Error('boom');
		};
		expect(
			await analyzeWaveform(VIDEO_WEBM, {
				durationSeconds: 5,
				hasAudioTrack: true,
				decode,
				extract: extractNever(),
			}),
		).toMatchObject({ state: 'decode-failed' });
	});

	it('decode 結果が空(0ch・0サンプル)→ no-audio(縮退の防御)', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(200, new Uint8Array([1])));
		const zeroChannels = await analyzeWaveform(VIDEO_WEBM, {
			durationSeconds: 5,
			hasAudioTrack: true,
			decode: decodeTo(audioBuf([])),
			extract: extractNever(),
		});
		expect(zeroChannels).toMatchObject({ state: 'no-audio' });

		fetchMock.mockResolvedValueOnce(fakeResponse(200, new Uint8Array([1])));
		const zeroLength = await analyzeWaveform(VIDEO_WEBM, {
			durationSeconds: 5,
			hasAudioTrack: true,
			decode: decodeTo(audioBuf([[]])),
			extract: extractNever(),
		});
		expect(zeroLength).toMatchObject({ state: 'no-audio' });
	});

	it('buckets 指定が反映される(「約2000」は既定値=引数で調整可能)', async () => {
		const buffer = audioBuf([[0.125, 0.25, -0.5, 0.75, -0.125, 0.375, -0.25, 0.5]]);
		fetchMock.mockResolvedValueOnce(fakeResponse(200, new Uint8Array([1])));
		const result = await analyzeWaveform(VIDEO_WEBM, {
			durationSeconds: 5,
			hasAudioTrack: true,
			decode: decodeTo(buffer),
			extract: extractNever(),
			buckets: 4,
		});
		expect(result).toMatchObject({ state: 'ready' });
		if (result.state === 'ready') {
			expect(result.lanes).toHaveLength(1);
			expect(result.lanes[0].mins.length).toBe(4);
			expect(result.lanes).toEqual(waveformLanes(buffer, 4));
		}
	});
});

// ---------------------------------------------------------------------------
// analyzeWaveform — extract 経路(mov=Rust 抽出)の統合と縮退(契約③④⑤改訂)
// ---------------------------------------------------------------------------

describe('analyzeWaveform — extract 経路(mov)の統合と縮退(要件#41 契約③④⑤)', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('mov 正常系: extract→decode → ready・fetch は呼ばれない・decode に抽出バイトそのまま', async () => {
		const extracted = Uint8Array.from([0xff, 0xf1, 1, 2, 3]);
		const buffer = audioBuf([[0.5, -0.5]]);
		const extract = extractTo({ state: 'ok', bytes: extracted.buffer as ArrayBuffer });
		const decode = decodeTo(buffer);
		const result = await analyzeWaveform(VIDEO_MOV, {
			durationSeconds: 12,
			hasAudioTrack: true,
			decode,
			extract,
		});
		expect(result).toMatchObject({ state: 'ready' });
		if (result.state === 'ready') {
			expect(result.lanes).toEqual(waveformLanes(buffer));
		}
		expect(fetchMock).not.toHaveBeenCalled();
		expect(extract).toHaveBeenCalledTimes(1);
		expect(extract).toHaveBeenCalledWith(VIDEO_MOV);
		expect(decode).toHaveBeenCalledTimes(1);
		expect(new Uint8Array(decode.mock.calls[0][0])).toEqual(extracted);
	});

	it('mov で抽出応答が no-audio → no-audio(音声トラックなしの事前出し分け=契約⑤)', async () => {
		const decode = decodeTo(audioBuf([[0.25]]));
		const result = await analyzeWaveform(VIDEO_MOV, {
			durationSeconds: 5,
			hasAudioTrack: null,
			decode,
			extract: extractTo({ state: 'no-audio' }),
		});
		expect(result).toMatchObject({ state: 'no-audio' });
		expect(decode).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('mov の未対応コーデック → unsupported-codec(契約⑤の縮退・decode されない)', async () => {
		const decode = decodeTo(audioBuf([[0.25]]));
		const result = await analyzeWaveform(VIDEO_MOV, {
			durationSeconds: 5,
			hasAudioTrack: true,
			decode,
			extract: extractTo({ state: 'unsupported-codec' }),
		});
		expect(result).toMatchObject({ state: 'unsupported-codec' });
		expect(decode).not.toHaveBeenCalled();
	});

	it('mov で抽出応答が unreadable → unreadable', async () => {
		const result = await analyzeWaveform(VIDEO_MOV, {
			durationSeconds: 5,
			hasAudioTrack: true,
			decode: decodeTo(audioBuf([[0.25]])),
			extract: extractTo({ state: 'unreadable' }),
		});
		expect(result).toMatchObject({ state: 'unreadable' });
	});

	it('extract の reject・同期 throw → unreadable(throw しない=fail-open)', async () => {
		const rejecting: WaveformExtract = async () => {
			throw new Error('ipc failed');
		};
		expect(
			await analyzeWaveform(VIDEO_MOV, {
				durationSeconds: 5,
				hasAudioTrack: true,
				decode: decodeTo(audioBuf([[0.25]])),
				extract: rejecting,
			}),
		).toMatchObject({ state: 'unreadable' });

		const throwing: WaveformExtract = () => {
			throw new Error('boom');
		};
		expect(
			await analyzeWaveform(VIDEO_MOV, {
				durationSeconds: 5,
				hasAudioTrack: true,
				decode: decodeTo(audioBuf([[0.25]])),
				extract: throwing,
			}),
		).toMatchObject({ state: 'unreadable' });
	});

	it('抽出後音声バイトが 256MiB 超 → too-large(契約④の抽出経路側・decode されない)・ちょうどは可', async () => {
		const decode = decodeTo(audioBuf([[0.25, -0.25]]));
		const over = await analyzeWaveform(VIDEO_MOV, {
			durationSeconds: 5,
			hasAudioTrack: true,
			decode,
			extract: extractTo({ state: 'ok', bytes: new ArrayBuffer(WAVEFORM_MAX_SOURCE_BYTES + 1) }),
		});
		expect(over).toMatchObject({ state: 'too-large' });
		expect(decode).not.toHaveBeenCalled();

		const exact = await analyzeWaveform(VIDEO_MOV, {
			durationSeconds: 5,
			hasAudioTrack: true,
			decode,
			extract: extractTo({ state: 'ok', bytes: new ArrayBuffer(WAVEFORM_MAX_SOURCE_BYTES) }),
		});
		expect(exact).toMatchObject({ state: 'ready' });
	});

	// 「mov でも事前判定が先(60分超 → too-long)」の旧ケースは要件#45 契約②の
	// too-long 撤廃で失効(60分超の mov が extract へ進むことは末尾の #45 セクションが
	// 固定)= 2026-09-02 更新で削除。
});

// ===========================================================================
// 要件#45 の受け入れテスト(requirements.md #45)— 波形v2: サイズ非依存の波形表示
// ===========================================================================
//
// 「音声波形をファイルサイズに関わらず表示する」(2026-09-02 由谷指示・backlog #97
// の昇格)。13分・高ビットレートの mp4 が too-large 縮退する現象の解消。
//
// ## 契約(requirements.md 49行目=#45 が正本)
// ① mp4 も Rust 抽出経路(extract_waveform_audio)へ寄せ、動画全量 fetch を廃止。
//    WAVEFORM_MAX_SOURCE_BYTES=256MiB の判定は**抽出後の音声バイトのみ**に適用
//    (要件#41 契約③(a) の fetch 経路と契約④の content-length 事前判定は
//    本要件が置き換える)
// ② 実尺上限 WAVEFORM_MAX_DURATION_SECONDS=60分の判定(too-long 縮退)を撤廃
// ③ 解析中は波形帯に「音声を解析中…」等のインジケータ(状態の存在をテストで固定・
//    文言は実装裁量)
// ④ 対象= mp4/mov。webm は現状維持(fetch 経路+256MiB 超 too-large 縮退のまま)
// ⑤ fail-open 不変・縮退理由の出し分け(no-audio/unsupported-codec 等)と
//    mov 経路の既存挙動は維持 ⑥ 依存追加なし
//
// ## 期待 API(implementer はこれに従う)
// - `waveformPlan` / `analyzeWaveform` は**既存シグネチャのまま挙動改訂**:
//   mp4(末尾拡張子 .mp4・大文字小文字不問)→ extract 経路・too-long 判定なし
// - 新設 `waveformBandNote(result: WaveformResult | null, analyzing: boolean):
//   string | null` — 帯に出す文言の純関数(契約③)。null =波形そのものを出す。
//   解析前(result null)と解析中(analyzing)は非空の文言・縮退状態は理由ごとに
//   相異なる非空の文言(VideoViewer の WAVEFORM_MESSAGES/waveformNote 相当を
//   純関数化して機械判定可能にする)
//
// ## 旧仕様(要件#41)を固定していた既存ケースとの関係
// 上記①②は #41 の契約を置き換えるため、旧仕様固定の17ケース+import 1行は
// 2026-09-02 のオーケストレーター承認(要件側判断)で新契約へ更新済み ――
// mp4→fetch 前提の分岐系は webm へ書き換え・too-long 系と mp4 の経路固定は
// 削除(本セクションが新契約を固定)。webm の fetch 経路と loadWaveformSource
// 自体の挙動は現状維持(契約④)なので、loadWaveformSource の既存ケースは
// 無改変のまま有効。

const VIDEO_WEBM = 'file:///Users/a/movies/final.webm';

// ---------------------------------------------------------------------------
// waveformPlan — mp4 も Rust 抽出経路へ(要件#45 契約①④)
// ---------------------------------------------------------------------------

describe('waveformPlan — mp4 は Rust 抽出経路へ(要件#45 契約①④)', () => {
	it('mp4 → extract(動画全量 fetch の廃止)', () => {
		expect(waveformPlan(VIDEO, 10, true)).toEqual({ route: 'extract' });
	});

	it('拡張子は大文字小文字を区別しない(.MP4 / .Mp4 も extract)', () => {
		expect(waveformPlan('file:///a/CAMERA.MP4', 10, true)).toEqual({ route: 'extract' });
		expect(waveformPlan('file:///a/clip.Mp4', 10, true)).toEqual({ route: 'extract' });
	});

	it('パス途中のドット・パーセントエンコード名でも末尾拡張子で判定する', () => {
		expect(waveformPlan('file:///a/v1.2.final.mp4', 10, true)).toEqual({ route: 'extract' });
		expect(waveformPlan('file:///a/%E7%B4%A0%E6%9D%90.mp4', 10, true)).toEqual({
			route: 'extract',
		});
		// パス途中に .mp4 ディレクトリがあっても末尾が webm なら fetch(契約④)。
		expect(waveformPlan('file:///a.mp4/clip.webm', 10, true)).toEqual({ route: 'fetch' });
	});

	it('mov は従来どおり extract・webm は従来どおり fetch(契約④⑤)', () => {
		expect(waveformPlan(VIDEO_MOV, 10, true)).toEqual({ route: 'extract' });
		expect(waveformPlan(VIDEO_WEBM, 10, true)).toEqual({ route: 'fetch' });
	});

	it('不明な拡張子は fetch のまま(fail-open の方向は不変)', () => {
		expect(waveformPlan('file:///a/clip.mkv', 10, true)).toEqual({ route: 'fetch' });
	});

	it('音声トラックなし(false)は経路より先(mp4 でも skip/no-audio =契約⑤)', () => {
		expect(waveformPlan(VIDEO, 10, false)).toEqual({ route: 'skip', reason: 'no-audio' });
	});
});

// ---------------------------------------------------------------------------
// waveformPlan — 実尺上限(too-long)の撤廃(要件#45 契約②)
// ---------------------------------------------------------------------------

describe('waveformPlan — 実尺上限 too-long の撤廃(要件#45 契約②)', () => {
	it('60分超でも skip しない(mp4/mov → extract・webm → fetch)', () => {
		expect(waveformPlan(VIDEO, 7200, true)).toEqual({ route: 'extract' });
		expect(waveformPlan(VIDEO_MOV, 7200, true)).toEqual({ route: 'extract' });
		expect(waveformPlan(VIDEO_WEBM, 7200, true)).toEqual({ route: 'fetch' });
	});

	it('尺が Infinity(尺不定の異常値)でも skip しない(尺による縮退は存在しない)', () => {
		expect(waveformPlan(VIDEO, Infinity, true)).toEqual({ route: 'extract' });
		expect(waveformPlan(VIDEO_WEBM, Infinity, true)).toEqual({ route: 'fetch' });
	});

	it('尺不明(null / NaN)も従来どおり経路へ進む(fail-open 維持)', () => {
		expect(waveformPlan(VIDEO, null, true)).toEqual({ route: 'extract' });
		expect(waveformPlan(VIDEO, NaN, true)).toEqual({ route: 'extract' });
		expect(waveformPlan(VIDEO_WEBM, null, null)).toEqual({ route: 'fetch' });
	});
});

// ---------------------------------------------------------------------------
// analyzeWaveform — mp4 の extract 経路(要件#45 契約①④⑤)
// ---------------------------------------------------------------------------

describe('analyzeWaveform — mp4 の extract 経路(要件#45 契約①④⑤)', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('mp4 正常系: extract→decode → ready・fetch は呼ばれない・decode に抽出バイトそのまま', async () => {
		const extracted = Uint8Array.from([0x4d, 0x34, 1, 2, 3]);
		const buffer = audioBuf([[0.5, -0.5]]);
		const extract = extractTo({ state: 'ok', bytes: extracted.buffer as ArrayBuffer });
		const decode = decodeTo(buffer);
		const result = await analyzeWaveform(VIDEO, {
			durationSeconds: 780, // 13分(実機で too-large になっていた尺=解消の対象)
			hasAudioTrack: true,
			decode,
			extract,
		});
		expect(result).toMatchObject({ state: 'ready' });
		if (result.state === 'ready') {
			expect(result.lanes).toEqual(waveformLanes(buffer));
		}
		expect(fetchMock).not.toHaveBeenCalled();
		expect(extract).toHaveBeenCalledTimes(1);
		expect(extract).toHaveBeenCalledWith(VIDEO);
		expect(decode).toHaveBeenCalledTimes(1);
		expect(new Uint8Array(decode.mock.calls[0][0])).toEqual(extracted);
	});

	it('mp4 で抽出応答 no-audio / unsupported-codec / unreadable → そのまま状態へ(出し分け維持=契約⑤)', async () => {
		for (const state of ['no-audio', 'unsupported-codec', 'unreadable'] as const) {
			const decode = decodeTo(audioBuf([[0.25]]));
			const result = await analyzeWaveform(VIDEO, {
				durationSeconds: 5,
				hasAudioTrack: null,
				decode,
				extract: extractTo({ state }),
			});
			expect(result).toMatchObject({ state });
			expect(decode).not.toHaveBeenCalled();
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('mp4 で extract の reject・同期 throw → unreadable(fail-open 維持=契約⑤)', async () => {
		const rejecting: WaveformExtract = async () => {
			throw new Error('ipc failed');
		};
		expect(
			await analyzeWaveform(VIDEO, {
				durationSeconds: 5,
				hasAudioTrack: true,
				decode: decodeTo(audioBuf([[0.25]])),
				extract: rejecting,
			}),
		).toMatchObject({ state: 'unreadable' });

		const throwing: WaveformExtract = () => {
			throw new Error('boom');
		};
		expect(
			await analyzeWaveform(VIDEO, {
				durationSeconds: 5,
				hasAudioTrack: true,
				decode: decodeTo(audioBuf([[0.25]])),
				extract: throwing,
			}),
		).toMatchObject({ state: 'unreadable' });
	});

	it('256MiB 判定は抽出後の音声バイトのみに適用(超 → too-large・ちょうどは可=契約①)', async () => {
		const decode = decodeTo(audioBuf([[0.25, -0.25]]));
		const over = await analyzeWaveform(VIDEO, {
			durationSeconds: 780,
			hasAudioTrack: true,
			decode,
			extract: extractTo({ state: 'ok', bytes: new ArrayBuffer(WAVEFORM_MAX_SOURCE_BYTES + 1) }),
		});
		expect(over).toMatchObject({ state: 'too-large' });
		expect(decode).not.toHaveBeenCalled();

		const exact = await analyzeWaveform(VIDEO, {
			durationSeconds: 780,
			hasAudioTrack: true,
			decode,
			extract: extractTo({ state: 'ok', bytes: new ArrayBuffer(WAVEFORM_MAX_SOURCE_BYTES) }),
		});
		expect(exact).toMatchObject({ state: 'ready' });
		// 動画本体のサイズは判定に関与しない= content-length 事前判定の fetch 自体が無い。
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('60分超の mp4 でも解析へ進む(too-long 撤廃=契約②)', async () => {
		const buffer = audioBuf([[0.25, -0.25]]);
		const extract = extractTo({ state: 'ok', bytes: new Uint8Array([1, 2]).buffer as ArrayBuffer });
		const result = await analyzeWaveform(VIDEO, {
			durationSeconds: 7200,
			hasAudioTrack: true,
			decode: decodeTo(buffer),
			extract,
		});
		expect(result).toMatchObject({ state: 'ready' });
		expect(extract).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// analyzeWaveform — webm は fetch 経路の現状維持(要件#45 契約④)
// ---------------------------------------------------------------------------

describe('analyzeWaveform — webm は fetch 経路の現状維持(要件#45 契約④)', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('webm 正常系: fetch→decode → ready・extract は呼ばれない', async () => {
		const buffer = audioBuf([[0.5, -0.5]]);
		const extract = extractNever();
		fetchMock.mockResolvedValueOnce(fakeResponse(200, new Uint8Array([1, 2, 3])));
		const result = await analyzeWaveform(VIDEO_WEBM, {
			durationSeconds: 12,
			hasAudioTrack: true,
			decode: decodeTo(buffer),
			extract,
		});
		expect(result).toMatchObject({ state: 'ready' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(extract).not.toHaveBeenCalled();
		expect(firstRequestUrl(fetchMock)).toBe(toAssetUri(VIDEO_WEBM));
	});

	// webm 上限2件は要件#50 契約⑬(b) で fetch 側の門(512MiB)へ追随(2026-09-10 追補a。
	// #45 契約④「webm は現状維持」のこの一点に限る明示改訂=緩む方向のみ)。
	it('webm の content-length 申告が 512MiB 超 → too-large・本文を読まない(fetch 側の門)', async () => {
		const response = fakeResponse(200, new Uint8Array([1, 2]), fetchLimitBytes() + 1);
		fetchMock.mockResolvedValueOnce(response);
		const decode = decodeTo(audioBuf([[0.25]]));
		expect(
			await analyzeWaveform(VIDEO_WEBM, {
				durationSeconds: 5,
				hasAudioTrack: true,
				decode,
				extract: extractNever(),
			}),
		).toMatchObject({ state: 'too-large' });
		expect(response.arrayBuffer).not.toHaveBeenCalled();
		expect(response.bytes).not.toHaveBeenCalled();
		expect(decode).not.toHaveBeenCalled();
	});

	it('webm の実測が 512MiB 超 → too-large(二重判定の実測側も fetch 側の門)', async () => {
		fetchMock.mockResolvedValueOnce(
			fakeResponse(200, new Uint8Array(fetchLimitBytes() + 1), null),
		);
		expect(
			await analyzeWaveform(VIDEO_WEBM, {
				durationSeconds: 5,
				hasAudioTrack: true,
				decode: decodeTo(audioBuf([[0.25]])),
				extract: extractNever(),
			}),
		).toMatchObject({ state: 'too-large' });
	});

	it('60分超の webm も fetch へ進む(too-long 撤廃は経路共通=契約②)', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(200, new Uint8Array([1])));
		const result = await analyzeWaveform(VIDEO_WEBM, {
			durationSeconds: 7200,
			hasAudioTrack: true,
			decode: decodeTo(audioBuf([[0.25, -0.25]])),
			extract: extractNever(),
		});
		expect(result).toMatchObject({ state: 'ready' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// analyzeWaveform — mov 経路の既存挙動維持+too-long 撤廃(要件#45 契約②⑤)
// ---------------------------------------------------------------------------

describe('analyzeWaveform — mov 経路(要件#45 契約②⑤)', () => {
	it('60分超の mov も extract へ進み ready(too-long 撤廃。他の mov 挙動は #41 ケースが固定)', async () => {
		const buffer = audioBuf([[0.5, -0.5]]);
		const extract = extractTo({ state: 'ok', bytes: new Uint8Array([1, 2]).buffer as ArrayBuffer });
		const result = await analyzeWaveform(VIDEO_MOV, {
			durationSeconds: 7200,
			hasAudioTrack: true,
			decode: decodeTo(buffer),
			extract,
		});
		expect(result).toMatchObject({ state: 'ready' });
		expect(extract).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// waveformBandNote — 解析中状態の出し分け(要件#45 契約③)
// ---------------------------------------------------------------------------

describe('waveformBandNote — 解析中状態の出し分け(要件#45 契約③)', () => {
	// 実装前は export が無い= undefined。namespace 経由なのでモジュール読込は落ちず、
	// 赤は各ケースの assertion で出る。
	const bandNote = (AudioWaveform as unknown as Record<string, unknown>).waveformBandNote as
		| ((result: WaveformResult | null, analyzing: boolean) => string | null)
		| undefined;

	const READY: WaveformResult = {
		state: 'ready',
		lanes: [{ mins: new Float32Array(1), maxs: new Float32Array(1) }],
	};

	it('waveformBandNote が export されている(帯の文言の純関数)', () => {
		expect(bandNote).toBeTypeOf('function');
	});

	it('解析前(結果 null)・解析中(analyzing)→ 非空の文言(インジケータの存在。文言は実装裁量)', () => {
		expect(bandNote).toBeTypeOf('function');
		const before = bandNote!(null, false);
		const during = bandNote!(null, true);
		expect(typeof before).toBe('string');
		expect((before as string).length).toBeGreaterThan(0);
		expect(typeof during).toBe('string');
		expect((during as string).length).toBeGreaterThan(0);
	});

	it('ready → null(帯には波形そのものを出す=文言なし)', () => {
		expect(bandNote).toBeTypeOf('function');
		expect(bandNote!(READY, false)).toBeNull();
	});

	it('縮退状態はそれぞれ非空の文言・相互に相異・解析中の文言とも相異(出し分け維持=契約⑤)', () => {
		expect(bandNote).toBeTypeOf('function');
		const degraded = [
			'no-audio',
			'too-large',
			'unreadable',
			'unsupported-codec',
			'decode-failed',
		] as const;
		const notes = degraded.map((state) => bandNote!({ state } as WaveformResult, false));
		for (const note of notes) {
			expect(typeof note).toBe('string');
			expect((note as string).length).toBeGreaterThan(0);
		}
		const analyzing = bandNote!(null, true) as string;
		expect(new Set([...notes, analyzing]).size).toBe(degraded.length + 1);
	});
});

// ===========================================================================
// 要件#50 の受け入れテスト(requirements.md #50)— 音声波形: 経路3枝化と上限分離(2周目)
// ===========================================================================
//
// 「音声ファイル(wav / mp3 / m4a)をアプリ内で再生でき、プレーヤー画面に音声の波形を
//  表示する」のうち、本ファイルが受け持つのは**経路の3枝化(契約⑤)と fetch 上限の
//  分離(契約⑬(b))**。
//
// ## 契約(requirements.md 54行目=#50 が正本)
// ⑤ `waveformPlan` の経路は3枝になる:
//    (a) mov / mp4(ISO BMFF)→ 既存 `extract`(判定も定数も完全に不変)
//    (b) **wav → 新設 `wav` 経路**(実体=契約⑯の Rust コマンド。**サイズ・尺に依らず
//        常に wav 経路**=サイズで分けると閾値をまたいだ瞬間に波形の細かさが変わり
//        「約25分の崖」が残るため)。判別子は既存 `WaveformPlan` と同じ `route`
//        (`{ route: 'wav' }`。契約⑯が要素を足す余地を残すため照合は toMatchObject)
//    (c) それ以外(mp3 / m4a / webm / 不明)→ 既存 `fetch` 経路
//    hasAudioTrack === false → skip/no-audio が経路より先、は従来どおり。
// ⑬(b) 上限定数・判定の分離:
//    - 新設 `WAVEFORM_MAX_FETCH_BYTES = 512 * 1024 * 1024` — `loadWaveformSource` の
//      content-length 事前判定と実測の二重判定はこちらを見る(上の4件+webm 2件を
//      2026-09-10 追補a で差し替え済み。「超」だけを弾く等、判定の意味は不変)
//    - `WAVEFORM_MAX_SOURCE_BYTES = 256MiB` は抽出経路の門として値も名前も据え置き
//      (:329 の固定と抽出側 too-large の既存ケースは無改変で有効なまま)
//    - **wav はどちらの門も通らない**(⑬(c)=wav 経路は fetch しない。尺で縮退しない)
//
// ## 周回分割(ここでは判定しないもの=3周目)
// - wav 経路の中身(契約⑯= `analyze_wav_waveform` の IPC 応答の形・RIFF パース・
//   受け口の WaveformResult への写し)は3周目(src-tauri/tests/acceptance_req50.rs と
//   TS 側受け口テスト)の持ち場。ここでは「wav が fetch / extract のどちらにも
//   流れない」ことだけを固定し、wav 経路の解析結果の状態には断言を置かない
//   (throw しない= fail-open だけは既存契約どおり要求する)
// - `analyzeWaveform` の `durationSeconds`(契約④(a))と門の経路別の当たり先の統合は
//   audio-viewing.acceptance.test.ts の要件#50 2周目セクションが判定する

const AUDIO_WAV = 'file:///Users/a/music/take.wav';
const AUDIO_MP3 = 'file:///Users/a/music/song.mp3';
const AUDIO_M4A = 'file:///Users/a/music/voice.m4a';

/**
 * fetch 側の上限 `WAVEFORM_MAX_FETCH_BYTES`(要件#50 契約⑬(b))。新設 export は
 * namespace 経由で参照する(#45 の waveformBandNote と同じ作法)―― 実装前は
 * undefined なので、参照した各ケースだけが assertion で赤になり、モジュール読込は
 * 落ちない。function 宣言は巻き上がるので、ファイル前半の fetch 上限ケースからも
 * 呼べる。
 */
function fetchLimitBytes(): number {
	const value = (AudioWaveform as unknown as Record<string, unknown>).WAVEFORM_MAX_FETCH_BYTES;
	expect(
		value,
		'WAVEFORM_MAX_FETCH_BYTES(要件#50 契約⑬(b))が export されていること',
	).toBeTypeOf('number');
	return value as number;
}

// ---------------------------------------------------------------------------
// waveformPlan — 経路の3枝化(要件#50 契約⑤)
// ---------------------------------------------------------------------------

describe('waveformPlan — wav を加えた経路3枝(要件#50 契約⑤)', () => {
	it('wav → 新設 wav 経路(サイズ・尺に依らず常に=約25分の崖を残さない)', () => {
		expect(waveformPlan(AUDIO_WAV, null, true)).toMatchObject({ route: 'wav' });
		expect(waveformPlan(AUDIO_WAV, 7200, true)).toMatchObject({ route: 'wav' });
		expect(waveformPlan(AUDIO_WAV, null, null)).toMatchObject({ route: 'wav' });
	});

	it('拡張子は大文字小文字を区別せず、末尾セグメントで判定する(.WAV / .Wav も wav 経路・パス途中の .wav に引っ張られない)', () => {
		expect(waveformPlan('file:///a/TAKE.WAV', null, true)).toMatchObject({ route: 'wav' });
		expect(waveformPlan('file:///a/take.Wav', null, true)).toMatchObject({ route: 'wav' });
		expect(waveformPlan('file:///a.wav/clip.mp4', null, true)).toEqual({ route: 'extract' });
		expect(waveformPlan('file:///a.wav/clip.mp3', null, true)).toEqual({ route: 'fetch' });
	});

	it('mp3 / m4a → 既存 fetch 経路(枝(c))', () => {
		expect(waveformPlan(AUDIO_MP3, null, true)).toEqual({ route: 'fetch' });
		expect(waveformPlan(AUDIO_M4A, null, true)).toEqual({ route: 'fetch' });
	});

	it('mov / mp4 → extract・webm / 不明 → fetch は不変(枝(a)(c)=動画側の判定は完全不変)', () => {
		expect(waveformPlan(VIDEO, 10, true)).toEqual({ route: 'extract' });
		expect(waveformPlan(VIDEO_MOV, 10, true)).toEqual({ route: 'extract' });
		expect(waveformPlan(VIDEO_WEBM, 10, true)).toEqual({ route: 'fetch' });
		expect(waveformPlan('file:///a/clip.mkv', 10, true)).toEqual({ route: 'fetch' });
	});

	it('音声トラックなし(false)→ skip/no-audio が経路より先(wav でも)', () => {
		expect(waveformPlan(AUDIO_WAV, null, false)).toEqual({ route: 'skip', reason: 'no-audio' });
	});
});

// ---------------------------------------------------------------------------
// analyzeWaveform — wav はどちらの門も通らない(要件#50 契約⑤⑬(c))
// ---------------------------------------------------------------------------

describe('analyzeWaveform — wav は fetch / extract のどちらにも流れない(要件#50 契約⑤⑬(c))', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('wav では fetch も extract も呼ばれず、throw もしない(fail-open。wav 経路の中身=IPC 応答の形は3周目)', async () => {
		const extract = extractNever();
		const result = await analyzeWaveform(AUDIO_WAV, {
			durationSeconds: null,
			hasAudioTrack: null,
			decode: decodeTo(audioBuf([[0.5, -0.5]])),
			extract,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(extract).not.toHaveBeenCalled();
		// 状態の中身(縮退か ready か)は3周目の持ち場。ここでは「WaveformResult として
		// 返る」ことだけを固定する。
		expect(typeof result.state).toBe('string');
	});
});
