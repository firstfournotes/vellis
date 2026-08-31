/**
 * 出所マップ(`vedit-map` v1)の読み取りと再生位置への突き合わせ(requirements.md #40)。
 *
 * 「動画の隣のサイドカー `<動画ファイル名>.map.json` を読み、いま見ている部分がどの素材の
 *  どの範囲から来たかを表示する」のうち、DOM を持たない部分をここに集める
 * (`video-frame.ts` / `video-viewing.ts` と同じ家風)。`ProvenancePanel.svelte` は
 * 描画だけを持ち、「どこを読むか」「読んだものが信用できるか」「いまの秒はどの区間か」
 * 「その区間は素材のどの時刻か」はすべてこの純関数群が答える(契約⑪)。
 *
 * 設計の要は3つ(検討記録 docs/provenance-panel.md §4.3)。
 *
 * 1. **突き合わせの鍵は秒**。`segments` の半開区間 `[start.sec, end.sec)` へ再生位置を
 *    表引きする。`frame` は fps 不明のとき `null` になり得るので鍵にできない(契約⑤)。
 *    秒を正にすることで、フレーム索引の取れない webm でもパネルが動く
 * 2. **表示する `frame` はマップの値そのまま**。Vellis 側で fps から計算し直すと丸め規則が
 *    生成側と二重定義になる。例外は現在位置の素材側参考フレーム1点だけで、これは逆写像で
 *    求めた素材時刻から計算する(`sourceFrameAt`・Q29)
 * 3. **シークの正本は Vellis のフレーム索引**。区間頭は要件#37 の吸着経路
 *    (`nearestFrame` → `seekTimeForFrame`)へ通す(`segmentStartSeconds`)
 *
 * スキーマの正本は tool-video-editor の `docs/spec.md`「出所マップ(`map`)」節にあり、
 * ここでは再掲しない(二重定義を作らない)。**Vellis は読むだけで、生成も書き込みも
 * 一切しない**(契約③)。取得は `open_document` 系ではなく asset プロトコルへの `fetch`
 * ―― サイドカーは副読物であって「開いている文書」ではなく、窓の DocumentSession を
 * 差し替えると表示中の動画の監視が外れる(契約④)。
 *
 * 検証は境界で厳格に行い、**理由をつけて縮退する**(§4.5 の8段)。どの段でも再生は
 * 止めない ―― パネルだけがメッセージを出す(契約⑨ fail-open)。
 */
import { pathForCopy, pathForReveal } from './context-menu';
import { resolveRelative, toAssetUri } from './uri';
import { formatMilliTime, nearestFrame, seekTimeForFrame, type FrameIndex } from './video-frame';

// ---------------------------------------------------------------------------
// 型(parse 後の正規化形)
// ---------------------------------------------------------------------------

/** 有理数(フレームレート)。29.97fps は `{num: 30000, den: 1001}`。 */
export type Rational = { num: number; den: number };

/**
 * 時刻。`sec` と `frame` の両持ちで、`frame` は fps 不明(VFR 入力・出力 fps 不明)の
 * とき `null` になる(スキーマ §時刻の表現)。
 */
export type MapTime = { sec: number; frame: number | null };

/** 素材1つぶんの情報(`inputs` の値)。 */
export type ProvenanceInput = {
	/** マップ置き場基準の相対 POSIX パス(`..` を含んでよい)。 */
	path: string;
	/** シナリオに書かれた生の文字列(表示専用。相対の基準が違うので `path` とは一致しない)。 */
	scenarioPath: string;
	/** その素材のフレームレート。VFR は null。 */
	fps: Rational | null;
	duration: MapTime;
};

/** その区間に映っている素材1つ(`segments[].sources[]` の要素)。 */
export type ProvenanceSource = {
	/** `transition` のときだけ `out`(消えていく側)/ `in`(現れる側)。`clip` は null。 */
	role: 'out' | 'in' | null;
	/** `inputs` のキー。 */
	input: string;
	/** シナリオの `clips[].id`。 */
	clip: string;
	mode: 'extract' | 'cut' | 'full';
	speed: number;
	/** その素材の時間軸での使用範囲(半開区間)。 */
	from: MapTime;
	to: MapTime;
};

/** 出力タイムラインの区間1つ。 */
export type ProvenanceSegment = {
	kind: 'clip' | 'transition';
	/** `transition` の種別(`crossfade` 等)。`clip` は null。 */
	type: string | null;
	start: MapTime;
	end: MapTime;
	/** `clip` は1件・`transition` は2件で、配列順が out → in。 */
	sources: ProvenanceSource[];
};

/** オーバーレイ層1つ(`segments` とは独立=タイムラインを分割しない)。 */
export type ProvenanceOverlay = {
	/** シナリオの `overlays` 配列での位置。後の要素ほど上に重なる。 */
	index: number;
	kind: 'image' | 'video' | 'text';
	start: MapTime;
	end: MapTime;
	path: string | null;
	scenarioPath: string | null;
	text: string | null;
	fps: Rational | null;
	/** 解決済みの使用区間(動画素材のみ)。 */
	extract: { from: MapTime; to: MapTime }[] | null;
	loop: boolean;
};

/** 検証を通ったマップ全体。 */
export type ProvenanceMap = {
	format: 'vedit-map';
	version: 1;
	scenario: { path: string };
	video: { path: string; scenarioPath: string };
	/** 出力のフレームレート。読み取れなければ null(出力側の frame もすべて null)。 */
	fps: Rational | null;
	duration: MapTime;
	/** 入力名 → 素材。**キー順はシナリオの宣言順**で、その順を保つ。 */
	inputs: Record<string, ProvenanceInput>;
	segments: ProvenanceSegment[];
	overlays: ProvenanceOverlay[];
};

/**
 * 取得の結果(§4.5 の第1〜3段)。
 *
 * **不在(`absent`)は失敗ではない** ―― マップを作っていない動画のほうがむしろ普通で、
 * 「壊れている」とは層が違う。
 */
export type ProvenanceLoad =
	| { state: 'ok'; text: string }
	| { state: 'absent' }
	| { state: 'unreadable' }
	| { state: 'too-large' };

/** 内容の検証で見つかる不備(§4.5 の第4〜8段。順が検出順)。 */
export type ProvenanceParseError =
	| 'invalid-json'
	| 'not-vedit-map'
	| 'unsupported-version'
	| 'malformed'
	| 'inconsistent-segments';

/** 検証の結果。 */
export type ProvenanceParse =
	| { ok: true; map: ProvenanceMap }
	| { ok: false; error: ProvenanceParseError };

/** 現在位置カード1枚ぶんの表示データ(素材1つに対応)。 */
export type SourceCard = {
	role: 'out' | 'in' | null;
	/** `inputs` のキー(表示の主)。 */
	inputKey: string;
	/** 素材のファイル名(表示の副)。 */
	fileName: string;
	clip: string;
	mode: string;
	/** 等速(1)のときは null =出さない。 */
	speedText: string | null;
	/** 使用範囲の表示。**マップの値そのまま**で fps から再計算しない。 */
	fromText: string;
	toText: string;
	fromFrameText: string;
	toFrameText: string;
	/** title 属性用の素材データ(組み立ては配線側)。 */
	path: string;
	scenarioPath: string;
	/** 逆写像で求めた現在位置の素材時刻(秒)。 */
	inputSec: number;
	inputTimeText: string;
	/** 素材側の参考フレーム番号(±1 あり得る近似・VFR は null)。 */
	inputFrame: number | null;
};

/** 現在位置の区間1つぶんの表示データ。 */
export type SegmentCard = {
	kind: 'clip' | 'transition';
	transitionType: string | null;
	/** transition = 2素材が重なって映っている。 */
	overlapping: boolean;
	/** 配列順(out → in)のままのカード。 */
	sources: SourceCard[];
};

/** 鮮度の警告(§4.7)。順は [名前, 尺] で固定。 */
export type ProvenanceWarning = 'video-name-mismatch' | 'duration-mismatch';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/**
 * 読み込むマップの上限(8MiB・契約⑨)。
 *
 * asset プロトコルの 200 応答自体に上限は無い(要件#27 のストリーミング化以降、
 * 50MB の `MAX_FILE_SIZE` は全量読み経路だけの制約)ので、上限はここで決める。
 */
export const PROVENANCE_MAP_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 秒の比較に使う許容(丸め粒度)。
 *
 * 生成側は `sec` を小数第6位に丸めて書く(スキーマ §時刻の表現)ので、区間の辻褄は
 * この粒度で見る。これより細かいズレを不整合と呼ぶと、正しいマップを弾いてしまう。
 */
const SECOND_EPSILON = 1e-6;

/** 参考フレームの計算で秒を整数へ持ち上げる倍率(= 丸め粒度の逆数)。 */
const SECOND_SCALE = 1_000_000;

/** 鮮度警告を出す尺の差(秒・§4.7。生成側の受け入れ許容と同値)。 */
const DURATION_TOLERANCE_SECONDS = 0.05;

// ---------------------------------------------------------------------------
// サイドカーの位置と取得(第1〜3段)
// ---------------------------------------------------------------------------

/**
 * 動画 URI からサイドカーの URI(契約③)。
 *
 * **拡張子ごと連結**する(`final.mp4` → `final.mp4.map.json`)。拡張子を置き換える
 * 命名だと `final.mp4` と `final.mov` を併せて焼いたときに衝突する。URI 文字列のまま
 * 足すので、パーセントエンコード済みの名前を再エンコードしない。
 */
export function sidecarUriFor(videoUri: string): string {
	return `${videoUri}.map.json`;
}

/**
 * サイドカーを取ってくる ―― **このモジュール唯一の IO**(契約④)。
 *
 * `open_document` / `open_binary_document` は使わない: あれらは窓の DocumentSession を
 * 差し替えるので、呼んだ瞬間に表示中の動画の変更監視が外れる。asset プロトコルは
 * エラー応答にも CORS ヘッダを付ける(backlog #55 対応)ので、404 をそのまま状態として
 * 観測できる。
 *
 * **throw しない**(契約⑨ fail-open)。ネットワーク失敗も非 UTF-8 も縮退の一種として返す。
 * 非 UTF-8 の検出には fatal なデコードが要る ―― Web 仕様の `Response.text()` は
 * 不正バイトを U+FFFD へ置換するので、壊れたファイルが「読めた」ことになってしまう。
 */
export async function loadProvenanceMap(videoUri: string): Promise<ProvenanceLoad> {
	let response: Response;
	try {
		response = await fetch(toAssetUri(sidecarUriFor(videoUri)));
	} catch {
		return { state: 'unreadable' };
	}

	if (response.status === 404) return { state: 'absent' };
	if (!response.ok) return { state: 'unreadable' };

	// 申告サイズで弾けるものは本文を読む前に落とす(巨大なファイルを抱え込まない)。
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > PROVENANCE_MAP_MAX_BYTES) {
		return { state: 'too-large' };
	}

	try {
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > PROVENANCE_MAP_MAX_BYTES) return { state: 'too-large' };
		return { state: 'ok', text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) };
	} catch {
		return { state: 'unreadable' };
	}
}

// ---------------------------------------------------------------------------
// 検証と正規化(第4〜8段)
// ---------------------------------------------------------------------------

/**
 * 形の不正(第7段)を見つけたときに投げる内部例外。
 *
 * 検証は入れ子の奥で失敗するので、戻り値で持ち上げると全段が `null` 検査で埋まる。
 * 例外はこのモジュールの中だけで完結し、外へは `ProvenanceParse` として返る。
 */
class MalformedMapError extends Error {}

function fail(): never {
	throw new MalformedMapError();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
	if (!isPlainObject(value)) fail();
	return value;
}

function asArray(value: unknown): unknown[] {
	if (!Array.isArray(value)) fail();
	return value;
}

function asString(value: unknown): string {
	if (typeof value !== 'string') fail();
	return value;
}

function asNullableString(value: unknown): string | null {
	return value === null ? null : asString(value);
}

function asBoolean(value: unknown): boolean {
	if (typeof value !== 'boolean') fail();
	return value;
}

function asNumber(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) fail();
	return value;
}

function asInteger(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value)) fail();
	return value;
}

/** フレーム番号は整数 or null(fps 不明)。それ以外は形の不正。 */
function asFrame(value: unknown): number | null {
	return value === null ? null : asInteger(value);
}

function asOneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
	for (const candidate of allowed) {
		if (value === candidate) return candidate;
	}
	return fail();
}

function normalizeMapTime(value: unknown): MapTime {
	const raw = asObject(value);
	return { sec: asNumber(raw.sec), frame: asFrame(raw.frame) };
}

function normalizeRational(value: unknown): Rational | null {
	if (value === null) return null;
	const raw = asObject(value);
	return { num: asNumber(raw.num), den: asNumber(raw.den) };
}

/**
 * `role` は `transition` のときだけ必須。`clip` では書かれないので `null` で補う
 * (`undefined` を結果に残さない=正規化の約束)。
 */
function normalizeRole(value: unknown, kind: 'clip' | 'transition'): 'out' | 'in' | null {
	if (kind === 'transition') return asOneOf(value, ['out', 'in'] as const);
	if (value === undefined || value === null) return null;
	return asOneOf(value, ['out', 'in'] as const);
}

function normalizeSource(value: unknown, kind: 'clip' | 'transition'): ProvenanceSource {
	const raw = asObject(value);
	return {
		role: normalizeRole(raw.role, kind),
		input: asString(raw.input),
		clip: asString(raw.clip),
		mode: asOneOf(raw.mode, ['extract', 'cut', 'full'] as const),
		speed: asNumber(raw.speed),
		from: normalizeMapTime(raw.from),
		to: normalizeMapTime(raw.to),
	};
}

function normalizeSegment(value: unknown): ProvenanceSegment {
	const raw = asObject(value);
	const kind = asOneOf(raw.kind, ['clip', 'transition'] as const);
	const type = raw.type === undefined || raw.type === null ? null : asString(raw.type);
	return {
		kind,
		type,
		start: normalizeMapTime(raw.start),
		end: normalizeMapTime(raw.end),
		sources: asArray(raw.sources).map((source) => normalizeSource(source, kind)),
	};
}

function normalizeExtract(value: unknown): { from: MapTime; to: MapTime }[] | null {
	if (value === null) return null;
	return asArray(value).map((range) => {
		const raw = asObject(range);
		return { from: normalizeMapTime(raw.from), to: normalizeMapTime(raw.to) };
	});
}

function normalizeOverlay(value: unknown): ProvenanceOverlay {
	const raw = asObject(value);
	return {
		index: asInteger(raw.index),
		kind: asOneOf(raw.kind, ['image', 'video', 'text'] as const),
		start: normalizeMapTime(raw.start),
		end: normalizeMapTime(raw.end),
		path: asNullableString(raw.path),
		scenarioPath: asNullableString(raw.scenario_path),
		text: asNullableString(raw.text),
		fps: normalizeRational(raw.fps),
		extract: normalizeExtract(raw.extract),
		loop: asBoolean(raw.loop),
	};
}

function normalizeInput(value: unknown): ProvenanceInput {
	const raw = asObject(value);
	return {
		path: asString(raw.path),
		scenarioPath: asString(raw.scenario_path),
		fps: normalizeRational(raw.fps),
		duration: normalizeMapTime(raw.duration),
	};
}

/** トップレベルの必須キー(スキーマ §マップのトップレベル)。 */
const REQUIRED_TOP_LEVEL_KEYS = [
	'format',
	'version',
	'scenario',
	'video',
	'fps',
	'duration',
	'inputs',
	'segments',
	'overlays',
] as const;

function normalizeMap(raw: Record<string, unknown>): ProvenanceMap {
	for (const key of REQUIRED_TOP_LEVEL_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(raw, key)) fail();
	}

	const scenario = asObject(raw.scenario);
	const video = asObject(raw.video);
	const inputs: Record<string, ProvenanceInput> = {};
	// キー順はシナリオの宣言順(スキーマの不変条件)。反復の順のまま詰め直す。
	for (const [name, value] of Object.entries(asObject(raw.inputs))) {
		inputs[name] = normalizeInput(value);
	}

	return {
		format: 'vedit-map',
		version: 1,
		scenario: { path: asString(scenario.path) },
		video: { path: asString(video.path), scenarioPath: asString(video.scenario_path) },
		fps: normalizeRational(raw.fps),
		duration: normalizeMapTime(raw.duration),
		inputs,
		segments: asArray(raw.segments).map(normalizeSegment),
		overlays: asArray(raw.overlays).map(normalizeOverlay),
	};
}

/** 秒の一致(丸め粒度 1e-6 を許容)。 */
function secondsDiffer(a: number, b: number): boolean {
	return Math.abs(a - b) > SECOND_EPSILON;
}

/**
 * 区間列の辻褄(第8段)。形は正しいのに意味が通らない状態をここで落とす。
 *
 * 「出力タイムラインを隙間なく完全分割する」という不変条件(スキーマ §区間列)に
 * 寄りかかって表引きから「該当なし」を消しているので、寄りかかる先が崩れていないことを
 * 入口で確かめる。
 */
function segmentsAreConsistent(map: ProvenanceMap): boolean {
	const segments = map.segments;
	if (segments.length === 0) return false;
	if (secondsDiffer(segments[0].start.sec, 0)) return false;

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (!(segment.end.sec - segment.start.sec > SECOND_EPSILON)) return false;
		if (segment.sources.length !== (segment.kind === 'transition' ? 2 : 1)) return false;
		for (const source of segment.sources) {
			if (!Object.prototype.hasOwnProperty.call(map.inputs, source.input)) return false;
		}
		if (i + 1 < segments.length && secondsDiffer(segment.end.sec, segments[i + 1].start.sec)) {
			return false;
		}
	}

	return !secondsDiffer(segments[segments.length - 1].end.sec, map.duration.sec);
}

/**
 * サイドカーの中身を検証して正規化する(第4〜8段・契約⑨)。
 *
 * 段の順がそのまま検出順で、前の段で落ちたら後ろは見ない。とりわけ **`version` が 1 で
 * ないマップは中身を読まない** ―― 意味の変わったキーを推測で読むほうが、読まないより悪い。
 * v1 の内側では未知キーを無視する(前方互換)。正規化の過程で拾わないので、結果にも
 * 持ち込まれない。
 */
export function parseProvenanceMap(text: string): ProvenanceParse {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { ok: false, error: 'invalid-json' };
	}

	// object でない JSON 値・`format` が違うものは「別形式のファイル」。
	if (!isPlainObject(value) || value.format !== 'vedit-map') {
		return { ok: false, error: 'not-vedit-map' };
	}
	// 数値の 1 に厳密一致だけを受理する("1" や欠落は「新しい形式」と同じ扱い)。
	if (value.version !== 1) return { ok: false, error: 'unsupported-version' };

	let map: ProvenanceMap;
	try {
		map = normalizeMap(value);
	} catch (err) {
		if (err instanceof MalformedMapError) return { ok: false, error: 'malformed' };
		throw err;
	}

	if (!segmentsAreConsistent(map)) return { ok: false, error: 'inconsistent-segments' };
	return { ok: true, map };
}

// ---------------------------------------------------------------------------
// 表引きと逆写像
// ---------------------------------------------------------------------------

/**
 * その秒がどの区間か(契約⑤)。半開区間 `[start.sec, end.sec)` への表引き。
 *
 * 区間列は出力タイムラインを完全分割しているので「該当なし」は無く、範囲外は端へ
 * clamp する(再生位置が末尾 `end` ちょうどに来るのは日常的で、そこで表示が消えるのは
 * 不便でしかない)。
 *
 * `hint` は**結果を変えない**(契約⑪)。連続再生で直前の添字を渡せば1回の範囲判定で
 * 済むという速さのためだけの引数で、誤った hint を渡しても素引きと同じ答えになる。
 */
export function segmentIndexAt(
	segments: ProvenanceSegment[],
	t: number,
	hint?: number | null,
): number {
	const last = segments.length - 1;
	if (last < 0) return 0;

	if (typeof hint === 'number' && Number.isInteger(hint) && hint >= 0 && hint <= last) {
		const hinted = segments[hint];
		if (t >= hinted.start.sec && t < hinted.end.sec) return hint;
	}

	if (!(t >= segments[0].start.sec)) return 0;
	if (t >= segments[last].end.sec) return last;

	// 不変条件: segments[lo].start.sec <= t < segments[hi].start.sec(hi は番兵=区間列の外)。
	let lo = 0;
	let hi = segments.length;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (segments[mid].start.sec <= t) lo = mid;
		else hi = mid;
	}
	return lo;
}

/**
 * 現在位置に対応する素材側の時刻(秒・契約⑥)。
 *
 * `input_t = from.sec + (t − start.sec) × speed`(スキーマ §逆写像)を使用範囲へ
 * clamp する。clamp が要るのは v1 の例外があるため ―― トランジションの重なりが繋ぎ目側の
 * 区間より長いと入力上の使用範囲が不連続になり、`sources` は単一区間しか書けないので
 * 繋ぎ目側へ丸められる。このとき等式だけが崩れるので、素材の範囲外を指さないようにする。
 */
export function sourceTimeAt(
	segment: ProvenanceSegment,
	source: ProvenanceSource,
	t: number,
): number {
	const mapped = source.from.sec + (t - segment.start.sec) * source.speed;
	return Math.min(Math.max(mapped, source.from.sec), source.to.sec);
}

/**
 * 素材側の参考フレーム番号(Q29)。`floor(素材時刻 × num / den)`。
 *
 * 素材時刻を**丸め粒度(1e-6 秒)の整数へ持ち上げてから**整数演算で割る。10進小数の
 * 素材時刻がフレーム境界の正確な倍数のとき(NTSC の 100.1 秒 = 3000 フレーム目ちょうど)、
 * 浮動小数のまま掛け算すると途中の丸めで境界のわずかに手前に落ち、番号が1つ小さくなる。
 *
 * VFR の素材(`fps` が null)はフレーム番号が定義できないので null =出さない。
 */
export function sourceFrameAt(fps: Rational | null, inputSec: number): number | null {
	if (!fps) return null;
	const ticks = Math.round(inputSec * SECOND_SCALE);
	return Math.floor((ticks * fps.num) / (fps.den * SECOND_SCALE));
}

// ---------------------------------------------------------------------------
// 整形
// ---------------------------------------------------------------------------

/** 秒 → `HH:MM:SS.mmm`。表記は要件#37 の位置表示と同じもの。 */
export function formatMapTime(sec: number): string {
	return formatMilliTime(sec);
}

/** フレーム番号 → `#n`。null(fps 不明)は空文字=番号を出さない。 */
export function formatMapFrame(frame: number | null): string {
	return frame === null ? '' : `#${frame}`;
}

/** 速度 → `×2` 等。等速(1)は null =出さない(契約⑥)。 */
export function formatSpeed(speed: number): string | null {
	return speed === 1 ? null : `×${String(speed)}`;
}

/** URI・相対パスの末尾セグメント。 */
function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

// ---------------------------------------------------------------------------
// カードの組み立て
// ---------------------------------------------------------------------------

/**
 * 素材1つぶんの現在位置カード(契約⑥a)。
 *
 * 使用範囲(`from` / `to`)の表示は**マップの値そのまま**で、fps から計算し直さない
 * (契約⑤)。計算し直すと丸め規則が生成側と二重定義になり、生成側の受け入れ基準が
 * 見張っているはずの食い違いを Vellis 側が黙って隠してしまう。
 */
export function describeSourceAt(
	segment: ProvenanceSegment,
	source: ProvenanceSource,
	input: ProvenanceInput,
	t: number,
): SourceCard {
	const inputSec = sourceTimeAt(segment, source, t);
	return {
		role: source.role,
		inputKey: source.input,
		fileName: baseName(input.path),
		clip: source.clip,
		mode: source.mode,
		speedText: formatSpeed(source.speed),
		fromText: formatMapTime(source.from.sec),
		toText: formatMapTime(source.to.sec),
		fromFrameText: formatMapFrame(source.from.frame),
		toFrameText: formatMapFrame(source.to.frame),
		path: input.path,
		scenarioPath: input.scenarioPath,
		inputSec,
		inputTimeText: formatMapTime(inputSec),
		inputFrame: sourceFrameAt(input.fps, inputSec),
	};
}

/**
 * 区間1つぶんの現在位置カード(契約⑥a)。
 *
 * `transition` は2素材が重なって映っているので、逆写像を**2つの `sources` へ独立に**
 * 適用して2枚のカードを返す。どちらか一方に決めてはならない(スキーマ §逆写像)。
 * 並びは配列順(out → in)のまま=消えていく側が先。
 */
export function describeSegment(
	map: ProvenanceMap,
	segmentIndex: number,
	t: number,
): SegmentCard {
	const segment = map.segments[segmentIndex];
	return {
		kind: segment.kind,
		transitionType: segment.type,
		overlapping: segment.kind === 'transition',
		sources: segment.sources.map((source) =>
			describeSourceAt(segment, source, map.inputs[source.input], t),
		),
	};
}

/**
 * 区間の頭へ跳ぶときのシーク先(秒・契約⑤)。
 *
 * シークの正本は Vellis のフレーム索引なので、区間頭の秒を要件#37 の吸着経路
 * (`nearestFrame` → `seekTimeForFrame`)へ通す ―― 秒をそのまま代入すると、境界の
 * 丸め次第で1つ手前のフレームが出て「クリックした区間の直前」に着いて見える。
 * 索引の無い動画(webm・解析不能)は秒そのまま(fail-open)。
 */
export function segmentStartSeconds(segment: ProvenanceSegment, index: FrameIndex | null): number {
	if (!index) return segment.start.sec;
	return seekTimeForFrame(index, nearestFrame(index, segment.start.sec));
}

/**
 * いま掛かっているオーバーレイ(契約⑥c)。境界は区間と同じ半開区間。
 *
 * 並びは配列順(`index` 順=重ね順)のまま。オーバーレイはタイムラインを分割しないので、
 * 区間リストとは別枠に置く(スキーマ §オーバーレイ層)。
 */
export function overlaysAt(overlays: ProvenanceOverlay[], t: number): ProvenanceOverlay[] {
	return overlays.filter((overlay) => t >= overlay.start.sec && t < overlay.end.sec);
}

// ---------------------------------------------------------------------------
// 素材への導線(契約⑦)
// ---------------------------------------------------------------------------

/**
 * 素材の絶対 URI。パスはマップ置き場基準の相対なので、マップの URI を基準に解決する。
 *
 * `resolveRelative` は `new URL()` 実装なので `..` は解決の時点で正規化され、導線へ
 * 渡る絶対 URI には残らない(asset プロトコルは `..` を含むパスを 400 で拒否する)。
 */
export function inputUriFor(mapUri: string, inputPath: string): string {
	return resolveRelative(mapUri, inputPath);
}

/** 「Finder で表示」の実行計画(要件#19 の OS パス変換を再利用)。 */
export function planRevealInput(
	mapUri: string,
	inputPath: string,
): { command: 'reveal_item_in_dir'; path: string } {
	return { command: 'reveal_item_in_dir', path: pathForReveal(inputUriFor(mapUri, inputPath)) };
}

/** 「パスをコピー」の実行計画(同上)。 */
export function planCopyInputPath(
	mapUri: string,
	inputPath: string,
): { command: 'copy'; text: string } {
	return { command: 'copy', text: pathForCopy(inputUriFor(mapUri, inputPath)) };
}

// ---------------------------------------------------------------------------
// 鮮度(契約⑩)
// ---------------------------------------------------------------------------

/** URI の末尾セグメント(パーセントデコード後)。壊れたエスケープは生のまま返す。 */
function uriFileName(uri: string): string {
	const withoutQuery = uri.split(/[?#]/)[0];
	const raw = baseName(withoutQuery);
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/**
 * 古いマップと新しい動画の並存に対する警告(§4.7)。
 *
 * マップは動画バイナリを読まずに生成できる(未レンダでも作れる)ので、**v1 では
 * 作り直しを確実には検出できない**。これは仕様であって、隠さずに緩和だけを置く ――
 * 名前の不一致と尺のずれの2つで、どちらも警告帯を出すだけでパネルは動き続ける。
 *
 * 実尺が判らない(索引も `<video>` の申告も無い)ときは尺を判定しない ―― 判らないことを
 * 「ずれている」と言い換えない。
 */
export function provenanceWarnings(
	map: ProvenanceMap,
	videoUri: string,
	actualDurationSec: number | null,
): ProvenanceWarning[] {
	const warnings: ProvenanceWarning[] = [];
	if (uriFileName(videoUri) !== baseName(map.video.path)) warnings.push('video-name-mismatch');
	if (
		actualDurationSec !== null &&
		Math.abs(map.duration.sec - actualDurationSec) > DURATION_TOLERANCE_SECONDS
	) {
		warnings.push('duration-mismatch');
	}
	return warnings;
}
