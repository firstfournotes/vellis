/**
 * 要件#57 追補a の受け入れテスト — 壊れた面の番号の `f` 行を落とす
 * (docs/requirements/req-57.md「追補a」(2026-10-25)・AC-57-追a (a)〜(c)・Issue #553)
 *
 * `f 1 2 x` のように頂点の番号が数でない面があると、`OBJLoader` の `parseInt` が NaN を返し、
 * NaN の頂点が取り込まれて bounds を汚す(初期カメラが外れる)。番号が 0・範囲外・前に出て
 * いない頂点を指すときも `vertices[...]` が undefined になって同じく NaN を生む。
 *
 * ## 確定契約(implementer はこれに従う。正本= docs/requirements/req-57.md 追補a)
 *
 * 1. `src/lib/model-viewing.ts` の `sanitizeObjSource` は、`f` 行のうち、頂点の参照
 *    (`v`・`v/vt`・`v//vn`・`v/vt/vn` の先頭の `v`)のどれかが**有効な番号でない**行を、
 *    行ごと落とす。
 *    - 有効な番号= 符号つきの整数で、0 でなく、その行より前に出てきた `v` 行の数を N として、
 *      正なら 1〜N・負なら −1〜−N
 *    - `vt`・`vn` の番号は見ない(描画は `v` だけで決まる)
 * 2. 落とした結果、面が 1 つも残らなければ、今までどおり「The model has no drawable geometry」
 *    の失敗の経路へ落ちる(要件57 の縮退)
 * 3. 不変: 正しい OBJ の読み込み・三角形の数・bounds・`l` / `p` の扱い・行の継続(`\`)と CRLF の
 *    正規化・知らないキーワードの行を落とす今の振る舞い
 *
 * 起案時判断(由谷の事後確認待ち): (a) 三角形単位ではなく**行(面)単位**で落とす
 * (多角形の一部の頂点だけが壊れていても面ごと落とす) (b) 範囲外の番号(N より大きい)も落とす。
 *
 * ## 観測方式
 * 純関数 `parseModel` の出力(`triangleCount`・`bounds`)だけで判定する。「落ちた」は
 * 「正しい三角形 1 つ+壊れた面」で triangleCount が 1 のまま・bounds が有限で正しい三角形
 * だけの OBJ と一致すること。「残った」は壊れた `vt` / `vn` を持つ面だけで triangleCount 1・
 * bounds が有限であること。フィクスチャは文字列リテラル(要件#57 の作法)。三角形は
 * (0,0,0)-(4,0,0)-(0,4,4)= bbox [0,0,0]-[4,4,4](立方体 [0,5]^3 と違う値)。
 *
 * ## 赤になる理由(実装前)
 * 今の `sanitizeObjSource` は先頭トークンが既知のキーワードかしか見ないので、`f 1 2 x` 等は
 * `OBJLoader` に渡って NaN の頂点になる。triangleCount が 2 になり、bounds に NaN が入る
 * ((a)・(b) の「落ちる」4 件・行単位・前方参照・継続行・CRLF)。(c) は `Box3.isEmpty()` が
 * NaN の比較で false になるため reject されず resolve してしまう。「残る」側(`f 1/1 2/x 3`・
 * `v//vn`・`v/vt/vn`・負の番号・`l` / `p`)は退行の歯止めで実装前から緑。
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseModel, type ParsedModel } from './model-viewing';

const OBJ = 'file:///Users/a/work/models/broken.obj';

type Bounds = ParsedModel['bounds'];

// ---------------------------------------------------------------------------
// フィクスチャ(文字列リテラル)
// ---------------------------------------------------------------------------

/** 三角形 1 枚ぶんの 3 頂点。bbox [0,0,0]-[4,4,4]。 */
const TRI_VERTICES = `v 0 0 0
v 4 0 0
v 0 4 4
`;

/** 正しい三角形だけの OBJ(比較の基準)。 */
const GOOD = `${TRI_VERTICES}f 1 2 3
`;

const GOOD_MIN: [number, number, number] = [0, 0, 0];
const GOOD_MAX: [number, number, number] = [4, 4, 4];

function toBuffer(text: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(text);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function parseObj(source: string): Promise<ParsedModel> {
	return parseModel(OBJ, toBuffer(source));
}

/** bounds の 6 値がすべて有限(NaN / Infinity を含まない)。 */
function expectFiniteBounds(bounds: Bounds): void {
	for (const axis of [0, 1, 2] as const) {
		expect(Number.isFinite(bounds.min[axis]), `min[${axis}] が有限`).toBe(true);
		expect(Number.isFinite(bounds.max[axis]), `max[${axis}] が有限`).toBe(true);
	}
}

function expectBounds(
	bounds: Bounds,
	min: [number, number, number],
	max: [number, number, number],
): void {
	expectFiniteBounds(bounds);
	for (const axis of [0, 1, 2] as const) {
		expect(bounds.min[axis], `min[${axis}]`).toBeCloseTo(min[axis], 5);
		expect(bounds.max[axis], `max[${axis}]`).toBeCloseTo(max[axis], 5);
	}
}

/** 「正しい三角形 1 つ+壊れた行」が、正しい三角形だけの OBJ と同じ結果になること(= 壊れた行が落ちた)。 */
async function expectDropped(brokenLine: string): Promise<void> {
	const model = await parseObj(`${GOOD}${brokenLine}\n`);
	expect(model.triangleCount, `壊れた行「${brokenLine}」は三角形にならない`).toBe(1);
	expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
	const reference = await parseObj(GOOD);
	expect(model.bounds, '正しい三角形だけの OBJ と同じ bounds').toEqual(reference.bounds);
}

/** 「その面だけ」で三角形 1 つ・有限の bounds になること(= 残った)。 */
async function expectKept(faceLine: string, declarations = ''): Promise<void> {
	const model = await parseObj(`${TRI_VERTICES}${declarations}${faceLine}\n`);
	expect(model.triangleCount, `「${faceLine}」は面として残る`).toBe(1);
	expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC-57-追a (a) — 正しい三角形 1 つ+ `f 1 2 x`
// ---------------------------------------------------------------------------

describe('AC-57-追a (a) parseModel — 頂点の番号が数でない f 行は落ちる(要件#57 追補a 契約1)', () => {
	test('正しい三角形 1 つ+ f 1 2 x: triangleCount 1・bounds は有限で、正しい三角形だけの OBJ と同じ', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await expectDropped('f 1 2 x');
	});

	test('前提: 正しい三角形だけの OBJ は triangleCount 1・bbox [0,0,0]-[4,4,4](比較の基準が成立している)', async () => {
		const model = await parseObj(GOOD);
		expect(model.triangleCount).toBe(1);
		expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
	});
});

// ---------------------------------------------------------------------------
// AC-57-追a (b) — 0・範囲外・負の範囲外は落ち、vt が壊れているだけの面は残る
// ---------------------------------------------------------------------------

describe('AC-57-追a (b) parseModel — 番号の有効範囲(要件#57 追補a 契約1・起案時判断 (b))', () => {
	test('f 1 2 0(0 は無効)は落ちる', async () => {
		await expectDropped('f 1 2 0');
	});

	test('f 1 2 9(v は 3 つ・N より大きい)は落ちる', async () => {
		await expectDropped('f 1 2 9');
	});

	test('f 1 2 -9(負で −N より小さい)は落ちる', async () => {
		await expectDropped('f 1 2 -9');
	});

	test('f 1/1 2/x 3(v は正しく vt が壊れている)は残る= vt の番号は見ない', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await expectKept('f 1/1 2/x 3', 'vt 0 0\n');
	});

	test('正しい三角形+ f 1/1 2/x 3 は 2 三角形(残った面が数に入る)', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const model = await parseObj(`${TRI_VERTICES}vt 0 0\nf 1 2 3\nf 1/1 2/x 3\n`);
		expect(model.triangleCount).toBe(2);
		expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
	});
});

// ---------------------------------------------------------------------------
// 契約1 の残り — 参照の 4 つの形・負の有効番号・前方参照・行(面)単位
// ---------------------------------------------------------------------------

describe('AC-57-追a 契約1 parseModel — 参照の形(v / v/vt / v//vn / v/vt/vn)と N の数え方', () => {
	test('v//vn の形で v が壊れた f 1//1 2//1 x//1 は落ちる', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const model = await parseObj(`${TRI_VERTICES}vn 0 0 1\nf 1 2 3\nf 1//1 2//1 x//1\n`);
		expect(model.triangleCount).toBe(1);
		expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
	});

	test('v//vn の形で vn だけが範囲外の f 1//1 2//9 3//1 は残る= vn の番号は見ない', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await expectKept('f 1//1 2//9 3//1', 'vn 0 0 1\n');
	});

	test('v/vt/vn の形で vt だけが壊れた f 1/1/1 2/x/1 3/1/1 は残る', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await expectKept('f 1/1/1 2/x/1 3/1/1', 'vt 0 0\nvn 0 0 1\n');
	});

	test('v/vt/vn の形で v が壊れた f 1/1/1 2/1/1 x/1/1 は落ちる', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const model = await parseObj(`${TRI_VERTICES}vt 0 0\nvn 0 0 1\nf 1 2 3\nf 1/1/1 2/1/1 x/1/1\n`);
		expect(model.triangleCount).toBe(1);
		expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
	});

	test('負の有効番号 f -3 -2 -1(−N〜−1)は残る', async () => {
		await expectKept('f -3 -2 -1');
	});

	test('前に出ていない頂点を指す面(v 行より前の f 1 2 3)は落ちる= N はその行より前の v 行の数', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const model = await parseObj(`f 1 2 3\n${GOOD}`);
		expect(model.triangleCount, '前方参照の面は数に入らない').toBe(1);
		expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
	});

	test('起案時判断 (a): 四角形 f 1 2 3 x は三角形単位でなく面ごと落ちる(扇状分割の片側も残さない)', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		// 三角形単位で落とす実装なら (1,2,3) が残って 2 三角形になる。行単位なら 1。
		const model = await parseObj(`${GOOD}f 1 2 3 x\n`);
		expect(model.triangleCount).toBe(1);
		expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
	});
});

// ---------------------------------------------------------------------------
// AC-57-追a (c) — 全部の面が壊れている OBJ
// ---------------------------------------------------------------------------

describe('AC-57-追a (c) parseModel — 全部の面が壊れていれば既存の失敗経路へ落ちる(要件#57 追補a 契約2)', () => {
	test('f 1 2 x だけの OBJ は「The model has no drawable geometry」で reject する', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await expect(parseObj(`${TRI_VERTICES}f 1 2 x\n`)).rejects.toThrow(
			'The model has no drawable geometry',
		);
	});

	test('壊れ方の違う面が複数(x・0・範囲外・負の範囲外)でも、全部壊れていれば同じ文言で reject する', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await expect(
			parseObj(`${TRI_VERTICES}f 1 2 x\nf 1 2 0\nf 1 2 9\nf 1 2 -9\n`),
		).rejects.toThrow('The model has no drawable geometry');
	});
});

// ---------------------------------------------------------------------------
// 契約3 — 不変(行の継続・CRLF・l / p)
// ---------------------------------------------------------------------------

describe('AC-57-追a 契約3 parseModel — 継続行・CRLF・l / p は今までどおり(要件#57 追補a 契約3)', () => {
	test('行の継続(`\\`)で分かれた正しい面 f 1 2 \\ + 3 は 1 三角形として残る(継続を結んでから判定する)', async () => {
		const model = await parseObj(`${TRI_VERTICES}f 1 2 \\\n3\n`);
		expect(model.triangleCount).toBe(1);
		expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
	});

	test('行の継続で分かれた壊れた面 f 1 2 \\ + x は結んだうえで落ちる', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const model = await parseObj(`${GOOD}f 1 2 \\\nx\n`);
		expect(model.triangleCount).toBe(1);
		expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
	});

	test('CRLF の OBJ でも、正しい面は残り壊れた面は落ちる', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const crlf = `${GOOD}f 1 2 x\n`.replace(/\n/g, '\r\n');
		const model = await parseObj(crlf);
		expect(model.triangleCount).toBe(1);
		expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
	});

	test('面のあるファイルの l / p 行は今までどおり通り、triangleCount と bounds を変えない', async () => {
		// OBJLoader は l / p を見るとその object の種別を Line / Points に切り替えるので、面と
		// 同じ object に置くと面が消える(ローダーの仕様)。別の o グループに置いて、面の object
		// が Mesh のまま残る形で判定する(面のある object の三角形数と bounds が変わらないこと)。
		const model = await parseObj(`o Tri\n${GOOD}o Lines\nl 1 2\no Pts\np 3\n`);
		expect(model.triangleCount).toBe(1);
		expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
	});

	test('知らないキーワードの行は今までどおり落ちる(foobar 1 2 3)', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const model = await parseObj(`${GOOD}foobar 1 2 3\n`);
		expect(model.triangleCount).toBe(1);
		expectBounds(model.bounds, GOOD_MIN, GOOD_MAX);
	});
});
