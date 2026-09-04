/**
 * 要件#40 の受け入れテスト(requirements.md #40)
 * 「動画ビューアに「素材パネル」(出所パネル)を追加する: 動画の隣のサイドカー
 *  `<動画ファイル名>.map.json`(vedit-map v1・tool-video-editor 要件15 が生成)を読み、
 *  再生位置に同期して「いま見ている部分がどの素材のどの範囲から来たか」を
 *  右サイドバーに表示する」
 *
 * ## 本ファイルの判定範囲(要件の機械判定分=契約⑬の列挙に対応)
 * サイドカー URI の組み立て(契約③)・取得分岐 200/404/500/ネットワーク失敗/上限超/
 * 非 UTF-8(契約④⑨・fetch モック)・スキーマ検証=正常+縮退8段(検出順込み)+
 * 未知キー寛容(契約⑨)・表引き=半開区間の境界・端 clamp・hint 同値(契約⑤⑪)・
 * 逆写像=speed≠1・transition 2源独立・clamp(契約⑥)・整形=map の frame そのまま/
 * 参考フレームの有理数計算と VFR null/speed 出し分け(契約⑤⑥=Q29)・区間クリックの
 * シーク先(契約⑤)・overlays 抽出(契約⑥c)・素材 URI 解決と導線計画(契約⑦)・
 * 鮮度警告 ±0.05 秒と名前不一致(契約⑩)。
 *
 * フィクスチャは tool-video-editor/docs/spec.md「出所マップ(`map`)」節の実例 JSON を
 * **文字列リテラルとしてそのまま**保持する(越境契約=vedit-map v1 の照合。契約③⑬)。
 * 派生フィクスチャはすべてこの実例への patch(`jsonWith`)で作り、バイナリ資産・
 * 外部ファイルは持たない。生成側 req-15 は未実装のため、実 map.json との噛み合わせは
 * 人間ゲートで req-15 達成後に確認する(契約⑬=Q28)。
 *
 * ## 既存 acceptance との関係
 * - 時間表記・シーク吸着の値の根拠は要件#37(video-frame.acceptance.test.ts)と
 *   要件#39(video-initial-frame.acceptance.test.ts)が固定済み。本ファイルは
 *   `formatMilliTime` / `nearestFrame` / `seekTimeForFrame` との**同値を等式で結ぶだけ**
 *   (#39 の buildSrcdoc/seekTimeForFrame 等式契約と同じ家風)で、値の再導出はしない
 * - 導線の OS パス変換の根拠は要件#19/#21(context-menu.acceptance.test.ts)が固定済み。
 *   `pathForReveal` / `pathForCopy` との同値を等式で結ぶ
 * - 既存 acceptance・既存 export(video-frame.ts / uri.ts / context-menu.ts)には
 *   一切手を触れない(要件#40 契約⑫=既存挙動の不変)
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * 実装先: `src/lib/video-provenance.ts`(新規。判定はここの純関数に集め、
 * コンポーネントは配線だけ=契約⑪・video-frame.ts と同じ家風)
 *
 * ### 型(parse 後の正規化形)
 * - `Rational = { num: number; den: number }`
 * - `MapTime = { sec: number; frame: number | null }`
 * - `ProvenanceInput = { path: string; scenarioPath: string; fps: Rational | null;
 *   duration: MapTime }`
 * - `ProvenanceSource = { role: 'out' | 'in' | null; input: string; clip: string;
 *   mode: 'extract' | 'cut' | 'full'; speed: number; from: MapTime; to: MapTime }`
 * - `ProvenanceSegment = { kind: 'clip' | 'transition'; type: string | null;
 *   start: MapTime; end: MapTime; sources: ProvenanceSource[] }`
 * - `ProvenanceOverlay = { index: number; kind: 'image' | 'video' | 'text';
 *   start: MapTime; end: MapTime; path: string | null; scenarioPath: string | null;
 *   text: string | null; fps: Rational | null;
 *   extract: { from: MapTime; to: MapTime }[] | null; loop: boolean }`
 * - `ProvenanceMap = { format: 'vedit-map'; version: 1; scenario: { path: string };
 *   video: { path: string; scenarioPath: string }; fps: Rational | null;
 *   duration: MapTime; inputs: Record<string, ProvenanceInput>;
 *   segments: ProvenanceSegment[]; overlays: ProvenanceOverlay[] }`
 *
 * 正規化規則: snake→camel(`scenario_path`→`scenarioPath`)・**未知キーは結果に
 * 持ち込まない**(無視=前方互換)・clip の `sources[].role` と clip 区間の `type` は
 * **null 補完**(undefined を残さない)・数値(sec/frame)は変換しない・
 * `inputs` のキー順(シナリオ宣言順)と `sources` の配列順(out→in)を保持する。
 *
 * ### 縮退8段(§4.5)との1対1対応
 * - `ProvenanceLoad =
 *     | { state: 'ok'; text: string }
 *     | { state: 'absent' } | { state: 'unreadable' } | { state: 'too-large' }`
 *   (判別子は `state`。表示用の付加フィールドの追加は自由=テストは toMatchObject)
 * - `ProvenanceParseError = 'invalid-json' | 'not-vedit-map' | 'unsupported-version'
 *     | 'malformed' | 'inconsistent-segments'`
 * - `ProvenanceParse = { ok: true; map: ProvenanceMap }
 *     | { ok: false; error: ProvenanceParseError }`(付加フィールド自由)
 * - **検出順=段の順**: 取得(absent→unreadable→too-large)が内容より先・内容は
 *   invalid-json → not-vedit-map → unsupported-version → malformed →
 *   inconsistent-segments。JSON 値が object でない(null・配列・プリミティブ)や
 *   `format` キーが無いものは **not-vedit-map**(「別形式」)、`version` は
 *   **数値の 1 に厳密一致**のみ受理(欠落・"1"・2 は unsupported-version)
 * - 第7段(malformed)=形の不正: トップレベル9キーの欠落/型不正・時刻 object の
 *   sec 非数値・frame が整数でも null でもない・fps が {num,den} でも null でもない・
 *   kind/mode の列挙外・source の必須キー欠落・transition source の role 欠落
 * - 第8段(inconsistent-segments)=形は正しいが辻褄が合わない: 先頭 start≠0・
 *   隣接不一致・末尾 end≠duration・end≤start・clip の sources≠1件・
 *   transition の sources≠2件・inputs にない input 参照・segments が空配列。
 *   **数値比較の許容=丸め粒度 1e-6**(sec は小数第6位丸め=§2.2-9)
 *
 * ### 関数(17)+定数
 * - `PROVENANCE_MAP_MAX_BYTES = 8 * 1024 * 1024`(契約⑨の 8MB 上限)
 * - `sidecarUriFor(videoUri: string): string` — 拡張子ごと連結で `.map.json` を足す
 *   (`final.mp4` → `final.mp4.map.json`。URI 文字列のまま=再エンコードしない)
 * - `loadProvenanceMap(videoUri: string): Promise<ProvenanceLoad>` — **唯一の IO**。
 *   `fetch(toAssetUri(sidecarUriFor(videoUri)))` を**1回だけ**呼ぶ。throw しない。
 *   404=absent・その他 HTTP エラー/ネットワーク失敗/**非 UTF-8**=unreadable・
 *   8MiB **超**=too-large(ちょうど 8MiB は ok)。非 UTF-8 の検出には fatal な
 *   デコードが要る(Web 仕様の `text()` は U+FFFD 置換で失敗しない)ため、
 *   `arrayBuffer()`/`bytes()` + `TextDecoder('utf-8', { fatal: true })` 相当で読む。
 *   サイズは content-length でも本文実測でもよい(テストは両者を一致させて与える)
 * - `parseProvenanceMap(text: string): ProvenanceParse` — 検証の本体(第4〜8段)+
 *   snake→camel 正規化
 * - `segmentIndexAt(segments: ProvenanceSegment[], t: number,
 *   hint?: number | null): number` — 半開区間 `[start.sec, end.sec)` への表引き。
 *   範囲外は端へ clamp(t<先頭→0・t≥末尾 end→最終添字)。**hint は結果を変えない**
 * - `sourceTimeAt(segment: ProvenanceSegment, source: ProvenanceSource,
 *   t: number): number` — 逆写像 `from.sec + (t − start.sec) × speed` を
 *   **[from.sec, to.sec] へ clamp**(v1 例外=不連続丸めの source でも to を超えない)
 * - `sourceFrameAt(fps: Rational | null, inputSec: number): number | null` — Q29 の
 *   参考フレーム `floor(inputSec × num / den)`。**素材時刻を 1e-6 秒粒度へ丸めてから
 *   整数演算で求める**(例: `floor(round(sec×1e6) × num / (den × 1e6))`)。10進小数の
 *   素材時刻がフレーム境界の正確な倍数のとき、浮動小数の途中丸めで1つ手前に落ちては
 *   ならない(NTSC ケースで固定)。fps が null(VFR)は null
 * - `formatMapTime(sec: number): string` — `formatMilliTime` と同値
 * - `formatMapFrame(frame: number | null): string` — n → `#n`(#37 の表記と同じ)・
 *   null → `''`(番号を出さない)
 * - `formatSpeed(speed: number): string | null` — 1 → null(出さない=契約⑥)・
 *   その他 → `'×' + String(speed)`
 * - `describeSourceAt(segment: ProvenanceSegment, source: ProvenanceSource,
 *   input: ProvenanceInput, t: number): SourceCard` —
 *   `SourceCard = { role: 'out' | 'in' | null; inputKey: string; fileName: string;
 *   clip: string; mode: string; speedText: string | null; fromText: string;
 *   toText: string; fromFrameText: string; toFrameText: string; path: string;
 *   scenarioPath: string; inputSec: number; inputTimeText: string;
 *   inputFrame: number | null }`。inputKey=`source.input`・fileName=`input.path` の
 *   末尾セグメント・from/to の表示は **map の値そのまま**(fps から再計算しない=
 *   契約⑤)・inputSec=`sourceTimeAt` と同値・inputFrame=`sourceFrameAt(input.fps,
 *   inputSec)` と同値・speedText=`formatSpeed(source.speed)` と同値。
 *   path/scenarioPath は title 属性用の素材データ(組み立ては配線側)
 * - `describeSegment(map: ProvenanceMap, segmentIndex: number, t: number):
 *   SegmentCard` — `SegmentCard = { kind: 'clip' | 'transition';
 *   transitionType: string | null; overlapping: boolean; sources: SourceCard[] }`。
 *   overlapping は transition のとき true(「重なり中」の判定フラグ)・sources は
 *   配列順(out→in)のまま各 source へ `describeSourceAt` を適用したもの
 * - `segmentStartSeconds(segment: ProvenanceSegment,
 *   index: FrameIndex | null): number` — 区間クリックのシーク先。索引あり=
 *   `seekTimeForFrame(index, nearestFrame(index, start.sec))` と同値(#37 の吸着
 *   経路の再利用=契約⑤)・null(webm 等の縮退)= `start.sec` そのまま
 * - `overlaysAt(overlays: ProvenanceOverlay[], t: number): ProvenanceOverlay[]` —
 *   `[start.sec, end.sec)`(半開=時刻表現の仕様どおり)に t が掛かるものだけを
 *   配列順(index 順=重ね順)のまま返す
 * - `inputUriFor(mapUri: string, inputPath: string): string` —
 *   `resolveRelative(mapUri, inputPath)` と同値(`..` は解決時点で正規化)
 * - `planRevealInput(mapUri: string, inputPath: string):
 *   { command: 'reveal_item_in_dir'; path: string }` — path は
 *   `pathForReveal(inputUriFor(…))` と同値(#19 の再利用=契約⑦)
 * - `planCopyInputPath(mapUri: string, inputPath: string):
 *   { command: 'copy'; text: string }` — text は `pathForCopy(inputUriFor(…))` と同値
 * - `provenanceWarnings(map: ProvenanceMap, videoUri: string,
 *   actualDurationSec: number | null): ProvenanceWarning[]` —
 *   `ProvenanceWarning = 'video-name-mismatch' | 'duration-mismatch'`。
 *   名前=videoUri の末尾セグメント(percent-decode 後)と `video.path` の末尾
 *   セグメントの比較・尺=|duration.sec − actual| が **0.05 を超える**とき
 *   (actual が null なら尺は判定しない=契約⑩)。両方出るときの順は
 *   [name, duration] 固定
 *
 * いずれも純関数(load を除く)・入力を書き換えない(共有フィクスチャは deep freeze
 * してあり、変異があれば strict mode の throw で落ちる)。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - ツールバーのボタン「素材」(常時表示・常時有効=契約⑨)と対象の絞り
 *   (mp4/mov/webm×ローカル inline のみ。mkv/avi・ssh・非動画にはボタンも出さない=契約①)
 * - 右サイドバー(MarkList 同型・320px/max-width 40vw・テーマ変数 CSS・マーク一覧と
 *   同時に開ける並び=契約②)・開閉は reload-state に載せない(契約⑪=Q26)
 * - 位置のコールバック prop 持ち上げと**パネル閉時は上げない**(契約⑪=Q20)
 * - 動画本体の変更検知(版数付き src への $effect)に連動した map 再読(契約⑧=Q16)・
 *   `open_document`/`open_binary_document` を使わない(契約④)
 * - パネル内の文言(縮退8段の説明文・「重なり中(両方が映っています)」・±1 フレーム
 *   参考値の注記・警告帯・title 属性の組み立て)と描画順
 * - 依存追加なし・Rust 変更なし・CSP/capability 不変(契約⑫)
 *
 * ## 人間ゲート(acceptance/acceptance.md)
 * - 実機の同期体感・区間切替・ハイライト追従・区間クリックで区間頭のフレームが出る・
 *   Finder 表示/パスコピーの実挙動・サイドバー2枚の見た目・縮退と警告の見え方・
 *   webm で動くこと。**実 map.json での確認は req-15 達成後**(Q28)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	PROVENANCE_MAP_MAX_BYTES,
	describeSegment,
	describeSourceAt,
	formatMapFrame,
	formatMapTime,
	formatSpeed,
	inputUriFor,
	loadProvenanceMap,
	overlaysAt,
	parseProvenanceMap,
	planCopyInputPath,
	planRevealInput,
	provenanceWarnings,
	segmentIndexAt,
	segmentStartSeconds,
	sidecarUriFor,
	sourceFrameAt,
	sourceTimeAt,
} from './video-provenance';
import type {
	ProvenanceInput,
	ProvenanceMap,
	ProvenanceSegment,
	ProvenanceSource,
} from './video-provenance';
import { formatMilliTime, nearestFrame, seekTimeForFrame } from './video-frame';
import type { FrameIndex } from './video-frame';
import { pathForCopy, pathForReveal } from './context-menu';
import { resolveRelative, toAssetUri } from './uri';

// ---------------------------------------------------------------------------
// フィクスチャ — spec.md「出所マップ(map)」節の実例 JSON を一字一句そのまま保持
// (越境契約 vedit-map v1 の照合。派生はすべて jsonWith による patch で作る)
// ---------------------------------------------------------------------------

const SPEC_MAP_JSON = `{
  "format": "vedit-map",
  "version": 1,
  "scenario": { "path": "../final.vedit.json" },
  "video": { "path": "final.mp4", "scenario_path": "out/final.mp4" },
  "fps": { "num": 30, "den": 1 },
  "duration": { "sec": 5.5, "frame": 165 },
  "inputs": {
    "raw": {
      "path": "../media/raw.mov",
      "scenario_path": "media/raw.mov",
      "fps": { "num": 30, "den": 1 },
      "duration": { "sec": 10.0, "frame": 300 }
    },
    "broll": {
      "path": "../media/broll.mp4",
      "scenario_path": "media/broll.mp4",
      "fps": { "num": 30, "den": 1 },
      "duration": { "sec": 10.0, "frame": 300 }
    }
  },
  "segments": [
    {
      "kind": "clip",
      "start": { "sec": 0.0, "frame": 0 },
      "end": { "sec": 2.5, "frame": 75 },
      "sources": [
        {
          "input": "raw",
          "clip": "opening",
          "mode": "extract",
          "speed": 1,
          "from": { "sec": 2.0, "frame": 60 },
          "to": { "sec": 4.5, "frame": 135 }
        }
      ]
    },
    {
      "kind": "transition",
      "type": "crossfade",
      "start": { "sec": 2.5, "frame": 75 },
      "end": { "sec": 3.0, "frame": 90 },
      "sources": [
        {
          "role": "out",
          "input": "raw",
          "clip": "opening",
          "mode": "extract",
          "speed": 1,
          "from": { "sec": 4.5, "frame": 135 },
          "to": { "sec": 5.0, "frame": 150 }
        },
        {
          "role": "in",
          "input": "broll",
          "clip": "scene2",
          "mode": "extract",
          "speed": 1,
          "from": { "sec": 1.0, "frame": 30 },
          "to": { "sec": 1.5, "frame": 45 }
        }
      ]
    },
    {
      "kind": "clip",
      "start": { "sec": 3.0, "frame": 90 },
      "end": { "sec": 5.5, "frame": 165 },
      "sources": [
        {
          "input": "broll",
          "clip": "scene2",
          "mode": "extract",
          "speed": 1,
          "from": { "sec": 1.5, "frame": 45 },
          "to": { "sec": 4.0, "frame": 120 }
        }
      ]
    }
  ],
  "overlays": []
}
`;

/** spec 実例の正規化後の期待形(snake→camel・role/type の null 補完・未知キーなし)。 */
const SPEC_MAP_EXPECTED: ProvenanceMap = {
	format: 'vedit-map',
	version: 1,
	scenario: { path: '../final.vedit.json' },
	video: { path: 'final.mp4', scenarioPath: 'out/final.mp4' },
	fps: { num: 30, den: 1 },
	duration: { sec: 5.5, frame: 165 },
	inputs: {
		raw: {
			path: '../media/raw.mov',
			scenarioPath: 'media/raw.mov',
			fps: { num: 30, den: 1 },
			duration: { sec: 10.0, frame: 300 },
		},
		broll: {
			path: '../media/broll.mp4',
			scenarioPath: 'media/broll.mp4',
			fps: { num: 30, den: 1 },
			duration: { sec: 10.0, frame: 300 },
		},
	},
	segments: [
		{
			kind: 'clip',
			type: null,
			start: { sec: 0.0, frame: 0 },
			end: { sec: 2.5, frame: 75 },
			sources: [
				{
					role: null,
					input: 'raw',
					clip: 'opening',
					mode: 'extract',
					speed: 1,
					from: { sec: 2.0, frame: 60 },
					to: { sec: 4.5, frame: 135 },
				},
			],
		},
		{
			kind: 'transition',
			type: 'crossfade',
			start: { sec: 2.5, frame: 75 },
			end: { sec: 3.0, frame: 90 },
			sources: [
				{
					role: 'out',
					input: 'raw',
					clip: 'opening',
					mode: 'extract',
					speed: 1,
					from: { sec: 4.5, frame: 135 },
					to: { sec: 5.0, frame: 150 },
				},
				{
					role: 'in',
					input: 'broll',
					clip: 'scene2',
					mode: 'extract',
					speed: 1,
					from: { sec: 1.0, frame: 30 },
					to: { sec: 1.5, frame: 45 },
				},
			],
		},
		{
			kind: 'clip',
			type: null,
			start: { sec: 3.0, frame: 90 },
			end: { sec: 5.5, frame: 165 },
			sources: [
				{
					role: null,
					input: 'broll',
					clip: 'scene2',
					mode: 'extract',
					speed: 1,
					from: { sec: 1.5, frame: 45 },
					to: { sec: 4.0, frame: 120 },
				},
			],
		},
	],
	overlays: [],
};

/* eslint-disable @typescript-eslint/no-explicit-any -- 生 JSON(snake_case)への patch は型を持たない */

/** spec 実例を複製して patch を適用し、JSON テキストへ戻す(派生フィクスチャの唯一の作り方)。 */
function jsonWith(patch: (raw: any) => void): string {
	const raw = JSON.parse(SPEC_MAP_JSON);
	patch(raw);
	return JSON.stringify(raw);
}

/** parse が ok であることを確かめて map を取り出す(縮退フィクスチャの誤用防止)。 */
function parseOk(text: string): ProvenanceMap {
	const parsed = parseProvenanceMap(text);
	if (!parsed.ok) throw new Error(`fixture must parse, got: ${parsed.error}`);
	return parsed.map;
}

/** strict mode では凍結オブジェクトへの書き込みが throw する=被検関数の変異検出。 */
function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value as object)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

let cachedSpecMap: ProvenanceMap | null = null;
/** 共有の spec 実例 map(deep freeze 済み。読み取り専用グループで使い回す)。 */
function specMap(): ProvenanceMap {
	if (!cachedSpecMap) cachedSpecMap = deepFreeze(parseOk(SPEC_MAP_JSON));
	return cachedSpecMap;
}

/** raw 入力を VFR にした変種(fps null・raw を指す入力側 frame すべて null)。 */
function vfrJson(): string {
	return jsonWith((raw) => {
		raw.inputs.raw.fps = null;
		raw.inputs.raw.duration.frame = null;
		for (const seg of raw.segments) {
			for (const src of seg.sources) {
				if (src.input === 'raw') {
					src.from.frame = null;
					src.to.frame = null;
				}
			}
		}
	});
}

/** overlays を2件(video+text)持つ変種。全キーをスキーマの表どおりに持つ。 */
function overlaysJson(): string {
	return jsonWith((raw) => {
		raw.overlays = [
			{
				index: 0,
				kind: 'video',
				start: { sec: 0.0, frame: 0 },
				end: { sec: 2.0, frame: 60 },
				path: '../media/logo.mov',
				scenario_path: 'media/logo.mov',
				text: null,
				fps: { num: 30, den: 1 },
				extract: [{ from: { sec: 0.0, frame: 0 }, to: { sec: 2.0, frame: 60 } }],
				loop: false,
			},
			{
				index: 1,
				kind: 'text',
				start: { sec: 1.0, frame: 30 },
				end: { sec: 4.0, frame: 120 },
				path: null,
				scenario_path: null,
				text: 'テロップの先頭',
				fps: null,
				extract: null,
				loop: true,
			},
		];
	});
}

/** `[bounds[i], bounds[i+1])` の clip 区間列(表引きテスト専用の最小形)。 */
function simpleSegments(bounds: number[]): ProvenanceSegment[] {
	const segments: ProvenanceSegment[] = [];
	for (let i = 0; i + 1 < bounds.length; i++) {
		segments.push({
			kind: 'clip',
			type: null,
			start: { sec: bounds[i], frame: null },
			end: { sec: bounds[i + 1], frame: null },
			sources: [
				{
					role: null,
					input: 'raw',
					clip: `c${i}`,
					mode: 'extract',
					speed: 1,
					from: { sec: 0, frame: null },
					to: { sec: bounds[i + 1] - bounds[i], frame: null },
				},
			],
		});
	}
	return segments;
}

/** 逆写像テスト用の単発 clip 区間。 */
function clipSegment(
	startSec: number,
	endSec: number,
	fromSec: number,
	toSec: number,
	speed: number,
): { segment: ProvenanceSegment; source: ProvenanceSource } {
	const source: ProvenanceSource = {
		role: null,
		input: 'raw',
		clip: 'c',
		mode: 'extract',
		speed,
		from: { sec: fromSec, frame: null },
		to: { sec: toSec, frame: null },
	};
	const segment: ProvenanceSegment = {
		kind: 'clip',
		type: null,
		start: { sec: startSec, frame: null },
		end: { sec: endSec, frame: null },
		sources: [source],
	};
	return { segment, source };
}

/** CFR フレーム索引を合成する(times[i] = i × fpsDen / fpsNum。#39 と同じ作り)。 */
function cfrIndex(fpsNum: number, fpsDen: number, frameCount: number): FrameIndex {
	const times = Array.from({ length: frameCount }, (_, i) => (i * fpsDen) / fpsNum);
	return { times, duration: (frameCount * fpsDen) / fpsNum, fpsNum, fpsDen, isCfr: true };
}

const VIDEO = 'file:///Users/a/movies/final.mp4';
const SIDECAR = 'file:///Users/a/movies/final.mp4.map.json';

// ---------------------------------------------------------------------------
// sidecarUriFor — サイドカー URI の組み立て(契約③=拡張子ごと連結)
// ---------------------------------------------------------------------------

describe('sidecarUriFor — 動画 URI からサイドカー URI(要件#40 契約③)', () => {
	it('拡張子ごと連結で .map.json を足す(final.mp4 → final.mp4.map.json)', () => {
		expect(sidecarUriFor(VIDEO)).toBe(SIDECAR);
	});

	it('mp4 と mov は衝突しない(1出力1ファイル=命名の不変条件)', () => {
		const mp4 = sidecarUriFor('file:///a/final.mp4');
		const mov = sidecarUriFor('file:///a/final.mov');
		expect(mp4).toBe('file:///a/final.mp4.map.json');
		expect(mov).toBe('file:///a/final.mov.map.json');
		expect(mp4).not.toBe(mov);
	});

	it('パーセントエンコード済みの名前はそのまま連結(再エンコードしない)', () => {
		expect(sidecarUriFor('file:///a/%E7%B4%A0%E6%9D%90.mp4')).toBe(
			'file:///a/%E7%B4%A0%E6%9D%90.mp4.map.json',
		);
	});

	it('webm でも同じ命名(フレーム索引の有無とサイドカー命名は無関係=契約⑤の前提)', () => {
		expect(sidecarUriFor('file:///a/clip.webm')).toBe('file:///a/clip.webm.map.json');
	});
});

// ---------------------------------------------------------------------------
// loadProvenanceMap — 取得段の縮退(第1〜3段)と要求 URL(契約④⑨・fetch モック)
// ---------------------------------------------------------------------------

/** fetch モックへ返す Response もどき。text() は Web 仕様どおり lossy(throw しない)。 */
function fakeResponse(status: number, body: Uint8Array | string = ''): unknown {
	const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: {
			get: (name: string) =>
				name.toLowerCase() === 'content-length' ? String(bytes.byteLength) : null,
		},
		arrayBuffer: async () =>
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		bytes: async () => bytes,
		text: async () => new TextDecoder('utf-8').decode(bytes),
	};
}

describe('loadProvenanceMap — 取得分岐と要求 URL(要件#40 契約④⑨)', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** 最初の fetch 呼び出しの要求先(文字列・URL・Request のどれで渡されてもよい)。 */
	function requestedUrl(): string {
		const arg: unknown = fetchMock.mock.calls[0][0];
		if (typeof arg === 'string') return arg;
		if (arg instanceof URL) return arg.href;
		return String((arg as { url?: unknown })?.url ?? arg);
	}

	it('200 → ok(text はサイドカーの中身そのまま)・要求は vellis-asset://local/....map.json 形式', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(200, SPEC_MAP_JSON));
		const result = await loadProvenanceMap(VIDEO);
		expect(result).toMatchObject({ state: 'ok', text: SPEC_MAP_JSON });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		// 要求 URL は「サイドカー URI の asset 変換」と同値、かつ絶対形も固定する。
		expect(requestedUrl()).toBe(toAssetUri(sidecarUriFor(VIDEO)));
		expect(requestedUrl()).toBe('vellis-asset://local/Users/a/movies/final.mp4.map.json');
	});

	it('404 → absent(不在は失敗ではなく正常な分岐=第1段)', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(404));
		expect(await loadProvenanceMap(VIDEO)).toMatchObject({ state: 'absent' });
	});

	it('HTTP エラー(500)→ unreadable(第2段)', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(500));
		expect(await loadProvenanceMap(VIDEO)).toMatchObject({ state: 'unreadable' });
	});

	it('ネットワーク失敗(fetch reject)→ unreadable(throw しない=fail-open)', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		expect(await loadProvenanceMap(VIDEO)).toMatchObject({ state: 'unreadable' });
	});

	it('非 UTF-8 の本文 → unreadable(lossy な text() では検出できない=fatal デコード必須)', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(200, new Uint8Array([0x7b, 0xc3, 0x28, 0x7d])));
		expect(await loadProvenanceMap(VIDEO)).toMatchObject({ state: 'unreadable' });
	});

	it('8MiB 超 → too-large(第3段。content-length と本文実測は一致させてある)', async () => {
		const body = new Uint8Array(8 * 1024 * 1024 + 1).fill(0x20);
		fetchMock.mockResolvedValueOnce(fakeResponse(200, body));
		expect(await loadProvenanceMap(VIDEO)).toMatchObject({ state: 'too-large' });
	});

	it('ちょうど 8MiB は ok(上限「超」だけを弾く)・定数も固定', async () => {
		expect(PROVENANCE_MAP_MAX_BYTES).toBe(8 * 1024 * 1024);
		const max = 8 * 1024 * 1024;
		const body = `{"pad":"${'a'.repeat(max - 10)}"}`;
		expect(new TextEncoder().encode(body).byteLength).toBe(max);
		fetchMock.mockResolvedValueOnce(fakeResponse(200, body));
		const result = await loadProvenanceMap(VIDEO);
		expect(result).toMatchObject({ state: 'ok' });
		if (result.state === 'ok') expect(result.text.length).toBe(max);
	});

	it('webm でも同じ取得経路(要求 URL の命名が揃う)', async () => {
		fetchMock.mockResolvedValueOnce(fakeResponse(404));
		await loadProvenanceMap('file:///a/clip.webm');
		expect(requestedUrl()).toBe('vellis-asset://local/a/clip.webm.map.json');
	});
});

// ---------------------------------------------------------------------------
// parseProvenanceMap — 正常(spec 実例の照合と正規化)
// ---------------------------------------------------------------------------

describe('parseProvenanceMap — spec 実例の正常受理と正規化(要件#40 契約③⑨)', () => {
	it('spec.md の実例 JSON をそのまま受理する(越境契約の照合)', () => {
		expect(parseProvenanceMap(SPEC_MAP_JSON)).toMatchObject({ ok: true });
	});

	it('正規化後の全体が期待形と一致(snake→camel・role/type の null 補完・未知キーなし)', () => {
		expect(parseOk(SPEC_MAP_JSON)).toEqual(SPEC_MAP_EXPECTED);
	});

	it('inputs のキー順を保持する(シナリオ宣言順=スキーマの不変条件)', () => {
		expect(Object.keys(parseOk(SPEC_MAP_JSON).inputs)).toEqual(['raw', 'broll']);
	});

	it('transition の sources は配列順 out→in のまま・role も併記(2枚カードの根拠)', () => {
		const transition = parseOk(SPEC_MAP_JSON).segments[1];
		expect(transition.kind).toBe('transition');
		expect(transition.type).toBe('crossfade');
		expect(transition.sources.map((s) => s.role)).toEqual(['out', 'in']);
		expect(transition.sources.map((s) => s.input)).toEqual(['raw', 'broll']);
	});

	it('数値は map の値のまま(sec/frame を変換・再計算しない=契約⑤)', () => {
		const map = parseOk(SPEC_MAP_JSON);
		expect(map.duration).toEqual({ sec: 5.5, frame: 165 });
		expect(map.segments[0].sources[0].from).toEqual({ sec: 2.0, frame: 60 });
		expect(map.segments[0].end).toEqual({ sec: 2.5, frame: 75 });
	});

	it('決定的: 同じテキストを2回 parse しても同じ結果', () => {
		expect(parseOk(SPEC_MAP_JSON)).toEqual(parseOk(SPEC_MAP_JSON));
	});
});

// ---------------------------------------------------------------------------
// parseProvenanceMap — 縮退 第4〜6段と検出順(契約⑨)
// ---------------------------------------------------------------------------

describe('parseProvenanceMap — 第4〜6段の縮退と検出順(要件#40 契約⑨)', () => {
	it('JSON でない → invalid-json(第4段)', () => {
		for (const text of ['', '{', 'hello', '{"format": "vedit-map",']) {
			expect(parseProvenanceMap(text)).toMatchObject({ ok: false, error: 'invalid-json' });
		}
	});

	it('format ≠ "vedit-map"(object でない JSON 値・format 欠落を含む)→ not-vedit-map(第5段)', () => {
		for (const text of ['null', '"vedit"', '[]', '{}', '42']) {
			expect(parseProvenanceMap(text)).toMatchObject({ ok: false, error: 'not-vedit-map' });
		}
		expect(
			parseProvenanceMap(
				jsonWith((raw) => {
					raw.format = 'geojson';
				}),
			),
		).toMatchObject({ ok: false, error: 'not-vedit-map' });
	});

	it('version ≠ 1(数値の 1 に厳密一致のみ受理)→ unsupported-version(第6段=読まない・推測しない)', () => {
		for (const version of [2, 0, '1', null] as const) {
			expect(
				parseProvenanceMap(
					jsonWith((raw) => {
						raw.version = version;
					}),
				),
			).toMatchObject({ ok: false, error: 'unsupported-version' });
		}
		expect(
			parseProvenanceMap(
				jsonWith((raw) => {
					delete raw.version;
				}),
			),
		).toMatchObject({ ok: false, error: 'unsupported-version' });
	});

	it('検出順=段の順: format 違いは version より先に勝つ(第5段>第6段)', () => {
		expect(parseProvenanceMap('{"format": "other", "version": 99}')).toMatchObject({
			ok: false,
			error: 'not-vedit-map',
		});
	});

	it('検出順=段の順: version 違いは中身を見ない(第6段>第7段)', () => {
		expect(
			parseProvenanceMap(
				jsonWith((raw) => {
					raw.version = 2;
					raw.segments = 'broken';
				}),
			),
		).toMatchObject({ ok: false, error: 'unsupported-version' });
	});

	it('検出順=段の順: 形の不正は辻褄より先に勝つ(第7段>第8段)', () => {
		expect(
			parseProvenanceMap(
				jsonWith((raw) => {
					raw.segments[0].start.sec = 0.5; // 辻褄も壊す
					raw.duration = { sec: '5.5', frame: 165 }; // 形も壊す
				}),
			),
		).toMatchObject({ ok: false, error: 'malformed' });
	});
});

// ---------------------------------------------------------------------------
// parseProvenanceMap — 第7段 malformed(形の不正=キーの有無・型・列挙値)
// ---------------------------------------------------------------------------

describe('parseProvenanceMap — 第7段 malformed(要件#40 契約⑨)', () => {
	const MALFORMED: [string, (raw: any) => void][] = [
		[
			'トップレベル必須キー欠落(overlays)',
			(raw) => {
				delete raw.overlays;
			},
		],
		[
			'トップレベル必須キー欠落(inputs)',
			(raw) => {
				delete raw.inputs;
			},
		],
		[
			'video が object でない',
			(raw) => {
				raw.video = 'final.mp4';
			},
		],
		[
			'duration.sec が数値でない',
			(raw) => {
				raw.duration = { sec: '5.5', frame: 165 };
			},
		],
		[
			'segments が配列でない',
			(raw) => {
				raw.segments = {};
			},
		],
		[
			'overlays が配列でない',
			(raw) => {
				raw.overlays = 'none';
			},
		],
		[
			'inputs が object でない',
			(raw) => {
				raw.inputs = 3;
			},
		],
		[
			'segment.kind が列挙外',
			(raw) => {
				raw.segments[0].kind = 'gap';
			},
		],
		[
			'source.mode が列挙外',
			(raw) => {
				raw.segments[0].sources[0].mode = 'trim';
			},
		],
		[
			'source の from 欠落',
			(raw) => {
				delete raw.segments[0].sources[0].from;
			},
		],
		[
			'frame が整数でも null でもない(文字列)',
			(raw) => {
				raw.segments[0].sources[0].from.frame = '60';
			},
		],
		[
			'frame が非整数',
			(raw) => {
				raw.segments[0].end.frame = 74.5;
			},
		],
		[
			'fps の den 欠落({num,den} でも null でもない)',
			(raw) => {
				raw.inputs.raw.fps = { num: 30 };
			},
		],
		[
			'transition の source に role が無い',
			(raw) => {
				delete raw.segments[1].sources[0].role;
			},
		],
	];

	for (const [name, patch] of MALFORMED) {
		it(`malformed: ${name}`, () => {
			expect(parseProvenanceMap(jsonWith(patch))).toMatchObject({
				ok: false,
				error: 'malformed',
			});
		});
	}
});

// ---------------------------------------------------------------------------
// parseProvenanceMap — 第8段 inconsistent-segments(形は正しいが辻褄が合わない)
// ---------------------------------------------------------------------------

describe('parseProvenanceMap — 第8段 inconsistent-segments(要件#40 契約⑨)', () => {
	const INCONSISTENT: [string, (raw: any) => void][] = [
		[
			'先頭 start ≠ 0',
			(raw) => {
				raw.segments[0].start.sec = 0.5;
			},
		],
		[
			'隣接不一致(要素 i の end ≠ 要素 i+1 の start)',
			(raw) => {
				raw.segments[1].start.sec = 2.6;
			},
		],
		[
			'末尾 end ≠ duration',
			(raw) => {
				raw.duration.sec = 6.0;
			},
		],
		[
			'end ≤ start(長さ0の区間)',
			(raw) => {
				raw.segments[1].end.sec = 2.5;
			},
		],
		[
			'clip の sources ≠ 1件',
			(raw) => {
				raw.segments[0].sources.push({ ...raw.segments[0].sources[0] });
			},
		],
		[
			'transition の sources ≠ 2件',
			(raw) => {
				raw.segments[1].sources.pop();
			},
		],
		[
			'inputs にない input キーの参照',
			(raw) => {
				raw.segments[2].sources[0].input = 'missing';
			},
		],
		[
			'segments が空(完全分割が成り立たない)',
			(raw) => {
				raw.segments = [];
			},
		],
	];

	for (const [name, patch] of INCONSISTENT) {
		it(`inconsistent-segments: ${name}`, () => {
			expect(parseProvenanceMap(jsonWith(patch))).toMatchObject({
				ok: false,
				error: 'inconsistent-segments',
			});
		});
	}
});

// ---------------------------------------------------------------------------
// parseProvenanceMap — 寛容(未知キー無視・null の許容・丸め許容 1e-6)
// ---------------------------------------------------------------------------

describe('parseProvenanceMap — v1 内の前方互換と許容(要件#40 契約⑨)', () => {
	it('未知のトップレベルキーは無視する(結果にも持ち込まない)', () => {
		const map = parseOk(
			jsonWith((raw) => {
				raw.future_key = { anything: true };
			}),
		);
		expect(map).toEqual(SPEC_MAP_EXPECTED);
	});

	it('segment・source の未知キーは無視する', () => {
		const map = parseOk(
			jsonWith((raw) => {
				raw.segments[0].filters = ['blur'];
				raw.segments[0].sources[0].note = 'x';
			}),
		);
		expect(map).toEqual(SPEC_MAP_EXPECTED);
	});

	it('input・overlay の未知キーは無視する', () => {
		const withOverlayExtras = jsonWith((raw) => {
			raw.inputs.raw.checksum = 'abc';
			raw.overlays = JSON.parse(overlaysJson()).overlays;
			raw.overlays[0].opacity = 0.5;
		});
		const map = parseOk(withOverlayExtras);
		expect(map.inputs.raw).toEqual(SPEC_MAP_EXPECTED.inputs.raw);
		expect(map.overlays[0]).not.toHaveProperty('opacity');
	});

	it('出力 fps が null(出力側 frame すべて null)でも受理する', () => {
		const map = parseOk(
			jsonWith((raw) => {
				raw.fps = null;
				raw.duration.frame = null;
				for (const seg of raw.segments) {
					seg.start.frame = null;
					seg.end.frame = null;
				}
			}),
		);
		expect(map.fps).toBeNull();
		expect(map.duration).toEqual({ sec: 5.5, frame: null });
		expect(map.segments[0].end.frame).toBeNull();
	});

	it('VFR 入力(入力側 fps と frame が null)でも受理する', () => {
		const map = parseOk(vfrJson());
		expect(map.inputs.raw.fps).toBeNull();
		expect(map.segments[0].sources[0].from).toEqual({ sec: 2.0, frame: null });
	});

	it('丸め粒度 1e-6 の範囲内のズレは辻褄違反にしない(先頭 start・隣接)', () => {
		expect(
			parseProvenanceMap(
				jsonWith((raw) => {
					raw.segments[0].start.sec = 0.0000001;
					raw.segments[1].start.sec = 2.5000002;
				}),
			),
		).toMatchObject({ ok: true });
	});
});

// ---------------------------------------------------------------------------
// segmentIndexAt — 半開区間の表引き(契約⑤⑪=秒が正本・端 clamp・hint 同値)
// ---------------------------------------------------------------------------

describe('segmentIndexAt — 半開区間 [start.sec, end.sec) の表引き(要件#40 契約⑤⑪)', () => {
	it('区間境界は次区間の頭(半開: start は含む・end は含まない)', () => {
		const segments = specMap().segments;
		expect(segmentIndexAt(segments, 0)).toBe(0);
		expect(segmentIndexAt(segments, 2.5)).toBe(1);
		expect(segmentIndexAt(segments, 3.0)).toBe(2);
	});

	it('区間内はその区間', () => {
		const segments = specMap().segments;
		expect(segmentIndexAt(segments, 1.0)).toBe(0);
		expect(segmentIndexAt(segments, 2.4999999)).toBe(0);
		expect(segmentIndexAt(segments, 2.75)).toBe(1);
		expect(segmentIndexAt(segments, 5.499)).toBe(2);
	});

	it('端は clamp: t=duration(末尾 end)以降は最終区間・負値は先頭区間', () => {
		const segments = specMap().segments;
		expect(segmentIndexAt(segments, 5.5)).toBe(2);
		expect(segmentIndexAt(segments, 100)).toBe(2);
		expect(segmentIndexAt(segments, -1)).toBe(0);
	});

	it('単一区間列はどの t でも 0', () => {
		const one = simpleSegments([0, 5.5]);
		for (const t of [-1, 0, 2.75, 5.5, 99]) {
			expect(segmentIndexAt(one, t)).toBe(0);
		}
	});

	it('hint は結果を変えない(正しい hint・誤った hint・範囲外 hint・未指定の全同値)', () => {
		const segments = specMap().segments;
		const ts = [-0.1, 0, 1.3, 2.5, 2.6, 3.0, 5.4, 5.5, 7];
		const hints: (number | null | undefined)[] = [undefined, null, -5, 0, 1, 2, 99];
		for (const t of ts) {
			const expected = segmentIndexAt(segments, t);
			for (const hint of hints) {
				expect(segmentIndexAt(segments, t, hint)).toBe(expected);
			}
		}
	});

	it('連続再生パターン(hint=直前の結果)でも素引きと一致する', () => {
		const segments = specMap().segments;
		let hint = 0;
		for (let t = 0; t < 5.5; t += 0.05) {
			const result = segmentIndexAt(segments, t, hint);
			expect(result).toBe(segmentIndexAt(segments, t));
			hint = result;
		}
	});

	it('大規模区間列(1000区間)で線形走査の参照実装と一致する(二分探索の正しさ)', () => {
		const bounds = Array.from({ length: 1001 }, (_, i) => i);
		const segments = simpleSegments(bounds);
		const linear = (t: number): number => {
			if (t < bounds[1]) return 0;
			for (let i = 0; i < segments.length; i++) {
				if (t >= bounds[i] && t < bounds[i + 1]) return i;
			}
			return segments.length - 1;
		};
		for (const t of [0, 0.5, 1, 499.999, 500, 500.5, 998, 999.5, 1000, 1234, -3]) {
			expect(segmentIndexAt(segments, t)).toBe(linear(t));
			expect(segmentIndexAt(segments, t, 500)).toBe(linear(t));
		}
	});
});

// ---------------------------------------------------------------------------
// sourceTimeAt — 逆写像 input_t = from.sec + (t − start.sec) × speed(契約⑥)
// ---------------------------------------------------------------------------

describe('sourceTimeAt — 逆写像と clamp(要件#40 契約⑥)', () => {
	it('speed=1: 式そのまま(spec 実例 seg0・t=1.0 → 素材 3.0 秒)', () => {
		const seg = specMap().segments[0];
		expect(sourceTimeAt(seg, seg.sources[0], 1.0)).toBeCloseTo(3.0, 12);
	});

	it('区間頭 t=start.sec → from.sec', () => {
		const seg = specMap().segments[0];
		expect(sourceTimeAt(seg, seg.sources[0], 0)).toBeCloseTo(2.0, 12);
	});

	it('区間末直前は to.sec 直前', () => {
		const seg = specMap().segments[0];
		expect(sourceTimeAt(seg, seg.sources[0], 2.4999999)).toBeCloseTo(4.4999999, 6);
	});

	it('speed=2: 入力側を2倍で消費する', () => {
		const { segment, source } = clipSegment(0, 2.5, 2.0, 7.0, 2);
		expect(sourceTimeAt(segment, source, 1.25)).toBeCloseTo(4.5, 12);
	});

	it('speed=0.5: 入力側を半分で消費する', () => {
		const { segment, source } = clipSegment(4, 6, 10, 11, 0.5);
		expect(sourceTimeAt(segment, source, 5)).toBeCloseTo(10.5, 12);
	});

	it('transition は2つの sources へ独立に適用する(どちらか一方に決めない)', () => {
		const seg = specMap().segments[1];
		const [out, into] = seg.sources;
		expect(out.role).toBe('out');
		expect(into.role).toBe('in');
		expect(sourceTimeAt(seg, out, 2.75)).toBeCloseTo(4.75, 12);
		expect(sourceTimeAt(seg, into, 2.75)).toBeCloseTo(1.25, 12);
	});

	it('clamp 下: t < start.sec でも from.sec より手前を返さない', () => {
		const seg = specMap().segments[0];
		expect(sourceTimeAt(seg, seg.sources[0], -1)).toBe(2.0);
	});

	it('clamp 上: t = end.sec(半開の外)は to.sec で止まる', () => {
		const seg = specMap().segments[0];
		expect(sourceTimeAt(seg, seg.sources[0], 2.5)).toBe(4.5);
	});

	it('v1 例外(不連続の丸めで to−from < (end−start)×speed)でも to.sec を超えない', () => {
		// 重なりが繋ぎ目側の区間より長いときの丸め(§2.2-5 例外)を模した source。
		const { segment, source } = clipSegment(0, 0.5, 1.0, 1.2, 1);
		expect(sourceTimeAt(segment, source, 0.4)).toBe(1.2);
	});
});

// ---------------------------------------------------------------------------
// sourceFrameAt — 素材側の参考フレーム(契約⑥=Q29・有理数 fps・VFR null)
// ---------------------------------------------------------------------------

describe('sourceFrameAt — floor(素材時刻 × num/den)(要件#40 契約⑥=Q29)', () => {
	it('整数 fps: floor(sec × fps)', () => {
		expect(sourceFrameAt({ num: 30, den: 1 }, 3.5)).toBe(105);
		expect(sourceFrameAt({ num: 30, den: 1 }, 0)).toBe(0);
		expect(sourceFrameAt({ num: 25, den: 1 }, 0.199999)).toBe(4);
	});

	it('NTSC の丸め落とし穴: 100.1 秒 × 30000/1001 は 3000(浮動小数の途中丸めで 2999 に落ちない)', () => {
		expect(sourceFrameAt({ num: 30000, den: 1001 }, 100.1)).toBe(3000);
	});

	it('NTSC の丸め落とし穴: 600.6 秒 × 24000/1001 は 14400', () => {
		expect(sourceFrameAt({ num: 24000, den: 1001 }, 600.6)).toBe(14400);
	});

	it('NTSC の境界対: フレーム境界の直後は次の番号・直前は前の番号(floor であって round でない)', () => {
		// フレーム1の境界は 1001/30000 ≈ 0.0333667 秒。小数第6位の丸めで前後に振れる2値。
		expect(sourceFrameAt({ num: 30000, den: 1001 }, 0.033367)).toBe(1);
		expect(sourceFrameAt({ num: 30000, den: 1001 }, 0.033366)).toBe(0);
	});

	it('VFR(fps=null)は null(番号を出さない)', () => {
		expect(sourceFrameAt(null, 3.2)).toBeNull();
		expect(sourceFrameAt(null, 0)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 整形 — formatMapTime / formatMapFrame / formatSpeed(契約⑤⑥)
// ---------------------------------------------------------------------------

describe('整形(要件#40 契約⑤⑥)', () => {
	it('formatMapTime は formatMilliTime と同値(#37 の根拠を等式で再利用)', () => {
		for (const sec of [0, 0.12, 2.5, 4.5, 5.5, 3599.9996, 3600]) {
			expect(formatMapTime(sec)).toBe(formatMilliTime(sec));
		}
	});

	it('formatMapTime の絶対値を1点固定(等式の空回り防止)', () => {
		expect(formatMapTime(2.5)).toBe('00:00:02.500');
	});

	it('formatMapFrame: 番号は #n(#37 のフレーム表記と同じ)', () => {
		expect(formatMapFrame(75)).toBe('#75');
		expect(formatMapFrame(0)).toBe('#0');
	});

	it('formatMapFrame: null(VFR・fps 不明)は空文字=番号を出さない', () => {
		expect(formatMapFrame(null)).toBe('');
	});

	it('formatSpeed: 1 のときは出さない(null)', () => {
		expect(formatSpeed(1)).toBeNull();
	});

	it('formatSpeed: 1 以外は ×付き', () => {
		expect(formatSpeed(2)).toBe('×2');
		expect(formatSpeed(0.5)).toBe('×0.5');
		expect(formatSpeed(1.25)).toBe('×1.25');
	});
});

// ---------------------------------------------------------------------------
// describeSegment / describeSourceAt — 現在位置カードの表示データ(契約⑥)
// ---------------------------------------------------------------------------

describe('describeSegment / describeSourceAt — 現在位置カード(要件#40 契約⑥)', () => {
	it('clip のカード: 素材名・ファイル名・使用範囲・素材時刻・参考フレーム・出し分けの全項目', () => {
		const map = specMap();
		const seg = map.segments[0];
		const card = describeSourceAt(seg, seg.sources[0], map.inputs.raw, 1.0);
		expect(card).toEqual({
			role: null,
			inputKey: 'raw',
			fileName: 'raw.mov',
			clip: 'opening',
			mode: 'extract',
			speedText: null,
			fromText: '00:00:02.000',
			toText: '00:00:04.500',
			fromFrameText: '#60',
			toFrameText: '#135',
			path: '../media/raw.mov',
			scenarioPath: 'media/raw.mov',
			inputSec: 3.0,
			inputTimeText: '00:00:03.000',
			inputFrame: 90,
		});
	});

	it('カードの各値は下位関数と同値(逆写像・整形・参考フレームを等式で結ぶ)', () => {
		const map = specMap();
		for (const [i, seg] of map.segments.entries()) {
			const t = (seg.start.sec + seg.end.sec) / 2;
			for (const src of seg.sources) {
				const card = describeSourceAt(seg, src, map.inputs[src.input], t);
				expect(card.inputSec).toBe(sourceTimeAt(seg, src, t));
				expect(card.inputTimeText).toBe(formatMapTime(card.inputSec));
				expect(card.inputFrame).toBe(sourceFrameAt(map.inputs[src.input].fps, card.inputSec));
				expect(card.speedText).toBe(formatSpeed(src.speed));
				expect(card.fromText).toBe(formatMapTime(src.from.sec));
				expect(card.fromFrameText).toBe(formatMapFrame(src.from.frame));
			}
			expect(segmentIndexAt(map.segments, t)).toBe(i);
		}
	});

	it('describeSegment(clip): 種別・transition なし・重なりなし・カード1枚', () => {
		const map = specMap();
		const card = describeSegment(map, 0, 1.0);
		expect(card.kind).toBe('clip');
		expect(card.transitionType).toBeNull();
		expect(card.overlapping).toBe(false);
		expect(card.sources).toHaveLength(1);
		expect(card.sources).toEqual([
			describeSourceAt(map.segments[0], map.segments[0].sources[0], map.inputs.raw, 1.0),
		]);
	});

	it('describeSegment(transition): out→in の2枚カード・重なり中・逆写像は2源へ独立適用', () => {
		const map = specMap();
		const card = describeSegment(map, 1, 2.75);
		expect(card.kind).toBe('transition');
		expect(card.transitionType).toBe('crossfade');
		expect(card.overlapping).toBe(true);
		expect(card.sources.map((s) => s.role)).toEqual(['out', 'in']);
		expect(card.sources.map((s) => s.inputKey)).toEqual(['raw', 'broll']);
		expect(card.sources[0].inputSec).toBeCloseTo(4.75, 12);
		expect(card.sources[1].inputSec).toBeCloseTo(1.25, 12);
	});

	it('VFR 入力のカード: 参考フレームなし(null)・範囲端の番号も空(map の null のまま)', () => {
		const map = parseOk(vfrJson());
		const seg = map.segments[0];
		const card = describeSourceAt(seg, seg.sources[0], map.inputs.raw, 1.0);
		expect(card.inputFrame).toBeNull();
		expect(card.fromFrameText).toBe('');
		expect(card.toFrameText).toBe('');
		expect(card.inputSec).toBeCloseTo(3.0, 12);
	});

	it('map の frame 値そのまま+speed の出し分け(fps から再計算しない=契約⑤)', () => {
		// from.frame を fps 換算(60)とわざと食い違う 61 にする — 再計算していれば #60 になってしまう。
		const asIs = parseOk(
			jsonWith((raw) => {
				raw.segments[0].sources[0].from.frame = 61;
			}),
		);
		const cardA = describeSourceAt(
			asIs.segments[0],
			asIs.segments[0].sources[0],
			asIs.inputs.raw,
			0,
		);
		expect(cardA.fromFrameText).toBe('#61');

		const fast = parseOk(
			jsonWith((raw) => {
				raw.segments[0].sources[0].speed = 2;
				raw.segments[0].sources[0].to = { sec: 7.0, frame: 210 };
			}),
		);
		const cardB = describeSourceAt(
			fast.segments[0],
			fast.segments[0].sources[0],
			fast.inputs.raw,
			1.0,
		);
		expect(cardB.speedText).toBe('×2');
		expect(cardB.inputSec).toBeCloseTo(4.0, 12);
	});
});

// ---------------------------------------------------------------------------
// segmentStartSeconds — 区間クリックのシーク先(契約⑤=#37 の吸着経路を等式で再利用)
// ---------------------------------------------------------------------------

describe('segmentStartSeconds — 区間頭へのシーク先(要件#40 契約⑤)', () => {
	/** 30fps・166フレーム(5.533秒)= spec 実例の出力(5.5秒)を覆う索引。 */
	const INDEX = cfrIndex(30, 1, 166);

	it('索引あり: nearestFrame→seekTimeForFrame の吸着と同値(#37 の既存経路の再利用)', () => {
		for (const seg of specMap().segments) {
			expect(segmentStartSeconds(seg, INDEX)).toBe(
				seekTimeForFrame(INDEX, nearestFrame(INDEX, seg.start.sec)),
			);
		}
	});

	it('吸着の実値: start=2.5(frame 75)→ 提示時刻+半フレーム', () => {
		expect(segmentStartSeconds(specMap().segments[1], INDEX)).toBeCloseTo(2.5 + 1 / 60, 10);
	});

	it('索引なし(webm 等の縮退)= start.sec そのまま', () => {
		for (const seg of specMap().segments) {
			expect(segmentStartSeconds(seg, null)).toBe(seg.start.sec);
		}
	});

	it('シーク先はその区間自身に落ちる(吸着してもクリックした区間を外さない)', () => {
		const segments = specMap().segments;
		for (const [i, seg] of segments.entries()) {
			expect(segmentIndexAt(segments, segmentStartSeconds(seg, INDEX))).toBe(i);
			expect(segmentIndexAt(segments, segmentStartSeconds(seg, null))).toBe(i);
		}
	});
});

// ---------------------------------------------------------------------------
// overlaysAt — 現在時刻に掛かる overlay の抽出(契約⑥c=別枠・最小表示)
// ---------------------------------------------------------------------------

describe('overlaysAt — 現在時刻に掛かるものだけ(要件#40 契約⑥c)', () => {
	it('掛かっているものだけを返す(logo=[0,2)・text=[1,4) の変種)', () => {
		const overlays = parseOk(overlaysJson()).overlays;
		expect(overlaysAt(overlays, 0.5).map((o) => o.index)).toEqual([0]);
		expect(overlaysAt(overlays, 1.5).map((o) => o.index)).toEqual([0, 1]);
		expect(overlaysAt(overlays, 3.0).map((o) => o.index)).toEqual([1]);
	});

	it('境界は半開: start は掛かる・end は掛からない(時刻表現の仕様どおり)', () => {
		const overlays = parseOk(overlaysJson()).overlays;
		expect(overlaysAt(overlays, 1.0).map((o) => o.index)).toEqual([0, 1]);
		expect(overlaysAt(overlays, 2.0).map((o) => o.index)).toEqual([1]);
	});

	it('どれにも掛からない時刻と overlays が空の map は []', () => {
		expect(overlaysAt(parseOk(overlaysJson()).overlays, 4.5)).toEqual([]);
		expect(overlaysAt(specMap().overlays, 1.0)).toEqual([]);
	});

	it('並びは配列順(index 順=重ね順)のまま', () => {
		const overlays = parseOk(overlaysJson()).overlays;
		expect(overlaysAt(overlays, 1.5).map((o) => o.index)).toEqual([0, 1]);
	});

	it('中身は parse 済み overlay そのまま(kind・テキスト先頭・extract の使用区間・loop)', () => {
		const overlays = parseOk(overlaysJson()).overlays;
		const [logo, text] = overlaysAt(overlays, 1.5);
		expect(logo).toEqual({
			index: 0,
			kind: 'video',
			start: { sec: 0.0, frame: 0 },
			end: { sec: 2.0, frame: 60 },
			path: '../media/logo.mov',
			scenarioPath: 'media/logo.mov',
			text: null,
			fps: { num: 30, den: 1 },
			extract: [{ from: { sec: 0.0, frame: 0 }, to: { sec: 2.0, frame: 60 } }],
			loop: false,
		});
		expect(text.kind).toBe('text');
		expect(text.text).toBe('テロップの先頭');
		expect(text.path).toBeNull();
		expect(text.extract).toBeNull();
		expect(text.loop).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 素材 URI の解決と導線 — inputUriFor / planRevealInput / planCopyInputPath(契約⑦)
// ---------------------------------------------------------------------------

describe('素材 URI 解決と導線計画(要件#40 契約⑦)', () => {
	const MAP_URI = 'file:///a/b/final.mp4.map.json';

	it('inputUriFor は resolveRelative(map の URI, inputs[].path) と同値(spec 実例の全 inputs)', () => {
		// 要件#46 追補a=型の絞り込みのみ(ProvenanceInput.path の string | null 化に伴う。
		// spec 実例に null path は無いので実行時の意味は不変)。
		const paths: string[] = Object.values(specMap().inputs)
			.map((input: ProvenanceInput) => input.path)
			.filter((p): p is string => p !== null);
		for (const path of paths) {
			expect(inputUriFor(MAP_URI, path)).toBe(resolveRelative(MAP_URI, path));
		}
		expect(inputUriFor(MAP_URI, '../media/raw.mov')).toBe('file:///a/media/raw.mov');
	});

	it('.. は解決の時点で正規化され、導線に渡る絶対 URI に残らない(asset の 400 拒否を踏まない)', () => {
		expect(inputUriFor(MAP_URI, '../../x/../media/raw.mov')).not.toContain('..');
	});

	it('同ディレクトリの素材はマップの隣に解決される', () => {
		expect(inputUriFor(MAP_URI, 'raw.mov')).toBe('file:///a/b/raw.mov');
	});

	it('planRevealInput: Finder 表示の計画(pathForReveal の再利用を等式で固定)', () => {
		const uri = inputUriFor(MAP_URI, '../media/raw.mov');
		expect(planRevealInput(MAP_URI, '../media/raw.mov')).toEqual({
			command: 'reveal_item_in_dir',
			path: pathForReveal(uri),
		});
		expect(planRevealInput(MAP_URI, '../media/raw.mov').path).toBe('/a/media/raw.mov');
	});

	it('planCopyInputPath: パスコピーの計画(pathForCopy の再利用を等式で固定)', () => {
		const uri = inputUriFor(MAP_URI, '../media/raw.mov');
		expect(planCopyInputPath(MAP_URI, '../media/raw.mov')).toEqual({
			command: 'copy',
			text: pathForCopy(uri),
		});
		expect(planCopyInputPath(MAP_URI, '../media/raw.mov').text).toBe('/a/media/raw.mov');
	});

	it('日本語ファイル名: URI ではエンコードされ、OS パスでは復号される(#19 の変換と同じ)', () => {
		const uri = inputUriFor(MAP_URI, '../media/素材.mov');
		expect(uri).toBe('file:///a/media/%E7%B4%A0%E6%9D%90.mov');
		expect(planRevealInput(MAP_URI, '../media/素材.mov').path).toBe('/a/media/素材.mov');
		expect(planCopyInputPath(MAP_URI, '../media/素材.mov').text).toBe('/a/media/素材.mov');
	});
});

// ---------------------------------------------------------------------------
// provenanceWarnings — 鮮度警告2つ(契約⑩=名前不一致・尺ずれ ±0.05 秒超)
// ---------------------------------------------------------------------------

describe('provenanceWarnings — 鮮度警告(要件#40 契約⑩)', () => {
	it('名前一致・尺一致 → 警告なし', () => {
		expect(provenanceWarnings(specMap(), VIDEO, 5.5)).toEqual([]);
	});

	it('video.path のファイル名と開いている動画名の不一致 → video-name-mismatch', () => {
		expect(provenanceWarnings(specMap(), 'file:///Users/a/movies/other.mp4', 5.5)).toEqual([
			'video-name-mismatch',
		]);
	});

	it('尺の差が 0.05 秒超 → duration-mismatch(±両方向)・0.05 以内は出さない', () => {
		expect(provenanceWarnings(specMap(), VIDEO, 5.56)).toEqual(['duration-mismatch']);
		expect(provenanceWarnings(specMap(), VIDEO, 5.44)).toEqual(['duration-mismatch']);
		expect(provenanceWarnings(specMap(), VIDEO, 5.54)).toEqual([]);
		expect(provenanceWarnings(specMap(), VIDEO, 5.46)).toEqual([]);
	});

	it('両方のときは [名前, 尺] の固定順', () => {
		expect(provenanceWarnings(specMap(), 'file:///a/other.mp4', 6.0)).toEqual([
			'video-name-mismatch',
			'duration-mismatch',
		]);
	});

	it('実尺が取れない(null)ときは尺を判定しない(名前だけは判定する)', () => {
		expect(provenanceWarnings(specMap(), VIDEO, null)).toEqual([]);
		expect(provenanceWarnings(specMap(), 'file:///a/other.mp4', null)).toEqual([
			'video-name-mismatch',
		]);
	});

	it('パーセントエンコードされた URI は復号して比較する(日本語ファイル名で一致)', () => {
		const map = parseOk(
			jsonWith((raw) => {
				raw.video.path = '動画.mp4';
			}),
		);
		expect(provenanceWarnings(map, 'file:///a/%E5%8B%95%E7%94%BB.mp4', 5.5)).toEqual([]);
		expect(provenanceWarnings(map, 'file:///a/%E5%8B%95%E7%94%BB2.mp4', 5.5)).toEqual([
			'video-name-mismatch',
		]);
	});
});

// ===========================================================================
// 要件#46 — プレースホルダー入力(vedit spec 2026-09-01 拡張)の受理と合成素材の扱い
// ===========================================================================
/*
 * 要件#46 の受け入れテスト(requirements.md #46)
 * 「素材パネル(要件#40)が vedit のプレースホルダー入力を含む素材マップを読めるように
 *  する。プレースホルダー入力は `inputs[].path` / `scenario_path` を null で書き、
 *  読み手は path が null の入力を合成素材とみなす(tool-video-editor/docs/spec.md:669
 *  の読み手契約=v1 スキーマへのキー追加なしの 2026-09-01 拡張)」
 *
 * ## 本ファイル追加分の判定範囲(要件#46 の機械判定分)
 * - 契約①: `parseProvenanceMap` がプレースホルダー入り map を ok で受理する
 *   (`normalizeInput` の path / scenario_path を `asNullableString` へ緩める=
 *   overlays 側 :386-388 と同型の寛容さ。片方だけ null も型としては受理・
 *   文字列でも null でもない値は従来どおり malformed)
 * - 契約③: 通常入力(path は文字列)の既存挙動は不変(spec 実例の parse 結果が
 *   SPEC_MAP_EXPECTED と一致・SourceCard の既存フィールドは従来の値のまま)
 * - 合成素材の印は `card.path === null`(要件②の文言そのもの):
 *   `describeSourceAt` が null path の input で throw せず、`path` / `scenarioPath` を
 *   null のまま SourceCard へ通す。パネル(ProvenancePanel.svelte)は
 *   `source.path === null` で「Finder で表示」「パスをコピー」の非活性と合成素材表示を
 *   切り替える**配線だけ**を持つ(要件#40 契約⑪と同じ家風。配線は reviewer 照合・
 *   見た目は人間ゲート)
 * - path を使わない関数(segmentIndexAt / provenanceWarnings)はプレースホルダー
 *   入りでも既存どおり(代表ケースのみ)・同じテキストの parse は決定的
 *
 * ## 確定契約(implementer はこれに従う)
 * - `ProvenanceInput.path: string | null`・`ProvenanceInput.scenarioPath: string | null`
 *   (`normalizeInput` は `asNullableString(raw.path)` / `asNullableString(raw.scenario_path)`)
 * - `SourceCard.path: string | null`・`SourceCard.scenarioPath: string | null` 化
 *   (**フィールドの追加はしない**=既存カードの完全一致比較と両立させる。
 *   合成素材の判定は `path === null` で足りる)。
 *   `fileName` は null path でも空文字でない表示用文字列(値は実装裁量=
 *   テストは型と非空だけを固定)。他フィールドの計算(inputSec・inputFrame・
 *   from/to の表示=map の値そのまま)は path と無関係に従来どおり
 * - 依存追加なし・Rust 無変更(契約⑤)
 *
 * ## フィクスチャの前提(オーケストレーター判断 2026-09-03)
 * spec.md には null path を含む JSON 実例が存在しない(spec.md:669 の散文契約のみ。
 * vedit 側 tests/test_req16_placeholder.py AC-16-9 が「キー集合・並び=
 * ["path","scenario_path","fps","duration"]・path/scenario_path=None・
 * fps/duration=宣言値」を固定している)。よって契約④「spec 2026-09-01 拡張の実例と
 * 一字一句一致」は、既存の SPEC_MAP_JSON(spec 実例・一字一句)への `jsonWith` patch で
 * プレースホルダー入力エントリをキー集合・並びとも spec 表どおり
 * `{"path": null, "scenario_path": null, "fps": {…}, "duration": {…}}` の形で追加する、
 * と解釈する。既存の spec 実例エントリ(raw / broll)には触れない。
 */

/**
 * プレースホルダー入力 `ph` を持つ変種(要件#46)。
 *
 * inputs へ `ph` を spec 表のキー集合・並びどおりに追加し(path / scenario_path は
 * null・fps / duration は宣言値=常に CFR なので frame も定義される)、末尾 clip 区間の
 * source が `ph` を指すようにする。raw / broll のエントリ自体は無傷
 * (broll が未参照になるが、parse の整合検査は「参照先が inputs にあること」だけを見る)。
 */
function placeholderJson(): string {
	return jsonWith((raw) => {
		raw.inputs.ph = {
			path: null,
			scenario_path: null,
			fps: { num: 30, den: 1 },
			duration: { sec: 10.0, frame: 300 },
		};
		raw.segments[2].sources[0].input = 'ph';
	});
}

let cachedPlaceholderMap: ProvenanceMap | null = null;
/** 共有のプレースホルダー入り map(deep freeze 済み)。 */
function placeholderMap(): ProvenanceMap {
	if (!cachedPlaceholderMap) cachedPlaceholderMap = deepFreeze(parseOk(placeholderJson()));
	return cachedPlaceholderMap;
}

// ---------------------------------------------------------------------------
// parseProvenanceMap — プレースホルダー入力の受理(要件#46 契約①③)
// ---------------------------------------------------------------------------

describe('parseProvenanceMap — プレースホルダー入力の受理(要件#46 契約①)', () => {
	it('path / scenario_path が null の入力を含む map を ok で受理し、正規化形は null を保持する', () => {
		const parsed = parseProvenanceMap(placeholderJson());
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.map.inputs.ph).toEqual({
			path: null,
			scenarioPath: null,
			fps: { num: 30, den: 1 },
			duration: { sec: 10.0, frame: 300 },
		});
	});

	it('path だけ null(scenario_path は文字列)も型としては受理する(asNullableString の同型=overlays 側と同じ寛容さ)', () => {
		const map = parseOk(
			jsonWith((raw) => {
				raw.inputs.ph = {
					path: null,
					scenario_path: 'gap',
					fps: { num: 30, den: 1 },
					duration: { sec: 10.0, frame: 300 },
				};
			}),
		);
		expect(map.inputs.ph.path).toBeNull();
		expect(map.inputs.ph.scenarioPath).toBe('gap');
	});

	it('scenario_path だけ null(path は文字列)も型としては受理する', () => {
		const map = parseOk(
			jsonWith((raw) => {
				raw.inputs.ph = {
					path: '../media/gap.mp4',
					scenario_path: null,
					fps: { num: 30, den: 1 },
					duration: { sec: 10.0, frame: 300 },
				};
			}),
		);
		expect(map.inputs.ph.path).toBe('../media/gap.mp4');
		expect(map.inputs.ph.scenarioPath).toBeNull();
	});

	it('path が文字列でも null でもない(数値)は従来どおり malformed', () => {
		const text = jsonWith((raw) => {
			raw.inputs.raw.path = 123;
		});
		expect(parseProvenanceMap(text)).toMatchObject({ ok: false, error: 'malformed' });
	});

	it('scenario_path が文字列でも null でもない(数値)は従来どおり malformed', () => {
		const text = jsonWith((raw) => {
			raw.inputs.raw.scenario_path = 123;
		});
		expect(parseProvenanceMap(text)).toMatchObject({ ok: false, error: 'malformed' });
	});

	it('既存の spec 実例の parse 結果は不変(契約③=既存挙動の不変)', () => {
		expect(parseProvenanceMap(SPEC_MAP_JSON)).toEqual({ ok: true, map: SPEC_MAP_EXPECTED });
	});

	it('決定性: 同じテキストを2回 parse して同じ結果', () => {
		const text = placeholderJson();
		expect(parseProvenanceMap(text)).toEqual(parseProvenanceMap(text));
	});
});

// ---------------------------------------------------------------------------
// describeSourceAt / describeSegment — 合成素材フラグと null 安全(要件#46)
// ---------------------------------------------------------------------------

describe('describeSourceAt — 合成素材の SourceCard(要件#46)', () => {
	it('null path の input で throw せず、path/scenarioPath は null(=合成素材の印)・fileName は空でない表示用文字列', () => {
		const map = placeholderMap();
		const segment = map.segments[2];
		const card = describeSourceAt(segment, segment.sources[0], map.inputs.ph, 4.0);
		expect(card.path).toBeNull();
		expect(card.scenarioPath).toBeNull();
		expect(typeof card.fileName).toBe('string');
		expect(card.fileName.length).toBeGreaterThan(0);
	});

	it('合成素材でも path 以外の計算は従来どおり(逆写像・参考フレーム・map の値そのままの表示)', () => {
		const map = placeholderMap();
		const segment = map.segments[2];
		const source = segment.sources[0];
		const card = describeSourceAt(segment, source, map.inputs.ph, 4.0);
		// t=4.0: inputSec = 1.5 + (4.0 − 3.0) × 1 = 2.5・frame = floor(2.5 × 30) = 75
		expect(card.inputSec).toBe(sourceTimeAt(segment, source, 4.0));
		expect(card.inputSec).toBeCloseTo(2.5, 10);
		expect(card.inputFrame).toBe(sourceFrameAt(map.inputs.ph.fps, card.inputSec));
		expect(card.inputFrame).toBe(75);
		expect(card.inputTimeText).toBe(formatMapTime(card.inputSec));
		expect(card.fromText).toBe(formatMapTime(1.5));
		expect(card.toText).toBe(formatMapTime(4.0));
		expect(card.fromFrameText).toBe('#45');
		expect(card.toFrameText).toBe('#120');
		expect(card.inputKey).toBe('ph');
	});

	it('通常入力のカードは従来の値と同一(契約③=既存挙動の不変。フィールドの追加もない=完全一致)', () => {
		const map = specMap();
		const segment = map.segments[0];
		const card = describeSourceAt(segment, segment.sources[0], map.inputs.raw, 1.0);
		expect(card).toEqual({
			role: null,
			inputKey: 'raw',
			fileName: 'raw.mov',
			clip: 'opening',
			mode: 'extract',
			speedText: null,
			fromText: formatMapTime(2.0),
			toText: formatMapTime(4.5),
			fromFrameText: '#60',
			toFrameText: '#135',
			path: '../media/raw.mov',
			scenarioPath: 'media/raw.mov',
			inputSec: 3.0,
			inputTimeText: formatMapTime(3.0),
			inputFrame: 90,
		});
	});
});

describe('describeSegment — プレースホルダーを指す区間(要件#46)', () => {
	it('ph を指す区間の表引きが正常に動き、カードの path は null(=合成素材の印)', () => {
		const card = describeSegment(placeholderMap(), 2, 4.0);
		expect(card.kind).toBe('clip');
		expect(card.sources).toHaveLength(1);
		expect(card.sources[0].inputKey).toBe('ph');
		expect(card.sources[0].path).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// path を使わない関数 — プレースホルダー入りでも既存どおり(要件#46 契約③)
// ---------------------------------------------------------------------------

describe('path 非依存の関数はプレースホルダー入りでも既存どおり(要件#46 契約③)', () => {
	it('segmentIndexAt の表引きは変わらない(境界の半開・端 clamp の代表点)', () => {
		const segments = placeholderMap().segments;
		expect(segmentIndexAt(segments, 0)).toBe(0);
		expect(segmentIndexAt(segments, 2.75)).toBe(1);
		expect(segmentIndexAt(segments, 3.0)).toBe(2);
		expect(segmentIndexAt(segments, 5.5)).toBe(2);
	});

	it('provenanceWarnings の鮮度判定は変わらない(名前一致・尺一致で警告なし)', () => {
		expect(provenanceWarnings(placeholderMap(), VIDEO, 5.5)).toEqual([]);
	});
});
