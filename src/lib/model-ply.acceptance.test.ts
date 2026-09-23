/**
 * 要件#58 の受け入れテスト — PLY 形式の 3D 表示(docs/requirements/req-58.md)
 * 「3D モデル表示に PLY 形式を追加する(点群が主・Revopoint 出力)」
 *
 * 本ファイルの判定範囲: AC-58-1〜16(分類・経路選択・3エンコーディングの
 * パース・点群/メッシュの振り分け・頂点色・点群マテリアル・法線・縮退・
 * 決定性・表示ラベルの純関数・既存形式の不変・依存の不変)。
 * ビューア配線(AC-58-17〜19)は src/components/ModelViewer.ply.wiring.test.ts が持つ。
 *
 * ## 確定契約(implementer はこれに従う。正本= docs/requirements/req-58.md)
 *
 * 1. `detectFileType`(src/lib/file-type.ts): `MODEL3D_EXTENSIONS` に `ply` を
 *    追加し `.ply` を `'model3d'` と判定する(契約①)。境界規則は既存を継承。
 *    既存分類は不変(分類表の変化はこの1語だけ)。
 * 2. 経路は種別で決まるので追加の分岐は不要(契約①): `readsAsText`(ply)= false・
 *    `openCommandFor`(ply)= `open_binary_document`・`openForDisplay` は
 *    それを1回だけ invoke・`renderForDisplay`(ply)= `modelSrc = toAssetUri(uri)`・
 *    `restoreSnapshot` は model3d 経路(`set_root` → `open_binary_document`)。
 * 3. `parseModel`(src/lib/model-viewing.ts): 拡張子スイッチに `ply` を足し、
 *    three 同梱の `three/examples/jsm/loaders/PLYLoader.js` でパースする(契約②)。
 *    `PLYLoader.parse(ArrayBuffer)` は ascii / binary_little_endian /
 *    binary_big_endian をヘッダで自動判別する。返る `BufferGeometry` を包むのは
 *    `parseModel` の持ち場: **index あり(= `face` 要素あり)→ `THREE.Mesh`
 *    (`kind: 'mesh'`・マテリアルは STL と同じ既定)/ index なし → `THREE.Points`
 *    (`kind: 'points'`・マテリアルは契約③)**。`color` 属性があれば
 *    `vertexColors: true`。法線はメッシュのときだけ無ければ補い、点群では
 *    計算しない(ファイル由来の `nx ny nz` は残る)。
 * 4. 点群マテリアル(契約③): `PointsMaterial`・`size = 2`・
 *    `sizeAttenuation: false`(画面ピクセル固定 2px)。点サイズ UI は出さない。
 * 5. `ParsedModel`(契約④)は**追加だけ**で広げる — `kind?: 'mesh' | 'points'`・
 *    `pointCount?: number`(kind によらず頂点数)。既存フィールド
 *    (`object` / `triangleCount` / `bounds`)は名前も意味も不変。
 *    **点群の `triangleCount` は 0**(現行 `triangleCountOf` の
 *    `position.count / 3` フォールバックを点群に適用しない)。
 *    表示ラベルは純関数 **`modelStatsLabel(parsed: ParsedModel): string`** を
 *    model-viewing.ts に置く — 点群 `"N points"`・メッシュ `"N triangles"`
 *    (toLocaleString の3桁区切り・英語)。
 * 6. 縮退(契約⑥): 頂点0の PLY・壊れたヘッダは既存の失敗経路で reject
 *    (`boundsOf` の「The model has no drawable geometry」ほか例外)。ハングしない。
 * 7. 不変(契約⑦): 依存追加ゼロ(package.json / Cargo.toml)。`src-tauri/**`
 *    無改変・STL / 3MF / OBJ の既存 acceptance の無改変緑は test-runner の
 *    フルスイートと reviewer 照合が判定する(本ファイルは依存の固定と
 *    PLYLoader の import 元だけを機械判定する= git diff に依存しない形)。
 *
 * フィクスチャは src/lib/__fixtures__/(生成= generate-ply.mjs・README 参照)。
 * すべて同じ8点=立方体 **[0,30]^3** の角 — STL([0,10]^3)・3MF([0,20]^3)・
 * OBJ([0,5]^3)と違う寸法で、数値そのものが「正しいローダーに渡った」ことの
 * 判定材料になる(要件#23 の作法)。壊れたヘッダはテスト内でバイト列を組む。
 *
 * 注: `kind` / `pointCount` / `modelStatsLabel` は未実装の追加分なので、
 * 型は本ファイル内の拡張型(`PlyParsedModel`)と動的 import で観測する —
 * 実装前でも `pnpm check` は通り、赤は vitest のアサーションとして出る。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
	Mesh,
	MeshStandardMaterial,
	Object3D,
	Points,
	PointsMaterial,
} from 'three';
import { SRGBColorSpace } from 'three';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import { detectFileType, renderForDisplay } from './file-type';
import { readsAsText } from './image-viewing';
import { parseModel, type ParsedModel } from './model-viewing';
import { openCommandFor, openForDisplay } from './open-document';
import { restoreSnapshot } from './reload-state';
import { toAssetUri } from './uri';

const invokeMock = vi.mocked(invoke);

const ROOT = 'file:///Users/a/work';
const PLY = `${ROOT}/scans/scan.ply`;

/** 契約④の追加フィールド(未実装なので optional 拡張型で観測する)。 */
type PlyParsedModel = ParsedModel & { kind?: 'mesh' | 'points'; pointCount?: number };

/** `modelStatsLabel` は未実装 — 静的 import だとファイル全体がリンク時に落ちる
 *  ため、動的 import で取り出す(存在の有無そのものが AC-58-14 の判定)。 */
async function importModelStatsLabel(): Promise<unknown> {
	const mod = (await import('./model-viewing')) as unknown as Record<string, unknown>;
	return mod['modelStatsLabel'];
}

/** フィクスチャを ArrayBuffer で読む(Buffer のオフセット混入を避けて切り出す)。 */
function fixture(name: string): ArrayBuffer {
	const buf = readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)));
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function parsePly(name: string): Promise<PlyParsedModel> {
	return (await parseModel(PLY, fixture(name))) as PlyParsedModel;
}

function expectBounds(
	bounds: { min: [number, number, number]; max: [number, number, number] },
	min: [number, number, number],
	max: [number, number, number],
): void {
	for (const axis of [0, 1, 2] as const) {
		expect(bounds.min[axis], `min[${axis}]`).toBeCloseTo(min[axis], 5);
		expect(bounds.max[axis], `max[${axis}]`).toBeCloseTo(max[axis], 5);
	}
}

/** object 配下の Points を列挙する(包み方に依存しない観測)。 */
function pointsOf(object: Object3D): Points[] {
	const found: Points[] = [];
	object.traverse((child) => {
		if ((child as Points).isPoints) found.push(child as Points);
	});
	return found;
}

/** object 配下の Mesh を列挙する。 */
function meshesOf(object: Object3D): Mesh[] {
	const found: Mesh[] = [];
	object.traverse((child) => {
		if ((child as Mesh).isMesh) found.push(child as Mesh);
	});
	return found;
}

/** 単一の描画対象(Points / Mesh)を取り出す。1つだけであることも判定する。 */
function solePoints(object: Object3D): Points {
	const found = pointsOf(object);
	expect(found.length, '点群は 1 つの Points で描く').toBe(1);
	return found[0];
}

function soleMesh(object: Object3D): Mesh {
	const found = meshesOf(object);
	expect(found.length, 'メッシュ PLY は 1 つの Mesh で描く').toBe(1);
	return found[0];
}

function materialOf<T>(target: Points | Mesh): T {
	const material = target.material;
	return (Array.isArray(material) ? material[0] : material) as T;
}

/** AC-58-14 用の合成 ParsedModel(ラベル関数は object の中身を見ない前提)。 */
function statsInput(
	kind: 'mesh' | 'points',
	pointCount: number,
	triangleCount: number,
): ParsedModel {
	return {
		object: {} as never,
		triangleCount,
		bounds: { min: [0, 0, 0], max: [1, 1, 1] },
		kind,
		pointCount,
	} as PlyParsedModel as ParsedModel;
}

beforeEach(() => {
	invokeMock.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// AC-58-1 — detectFileType: .ply は model3d(契約①)
// ---------------------------------------------------------------------------

describe('AC-58-1 detectFileType — .ply を model3d と判定する(要件#58 ①)', () => {
	test('ベース名の ply は model3d', () => {
		expect(detectFileType('scan.ply')).toBe('model3d');
	});

	test('大文字小文字を問わない(SCAN.PLY)', () => {
		expect(detectFileType('SCAN.PLY')).toBe('model3d');
		expect(detectFileType('Scan.Ply')).toBe('model3d');
	});

	test('パス・file:// URI でも最終セグメントの拡張子で判定する', () => {
		expect(detectFileType('/tmp/scan.ply')).toBe('model3d');
		expect(detectFileType(PLY)).toBe('model3d');
	});

	test('最後の拡張子だけで判定する(scan.ply.txt は text)', () => {
		expect(detectFileType('scan.ply.txt')).toBe('text');
		expect(detectFileType('notes.txt.ply')).toBe('model3d');
	});

	test('ディレクトリ名中の .ply を拡張子と誤認しない', () => {
		expect(detectFileType('file:///home/user.ply/Makefile')).toBe('text');
	});

	test('既存分類は不変(stl / 3mf / obj / md / html / 画像 / 動画 / 音声 / pdf / binary / フォールバック)', () => {
		expect(detectFileType('part.stl')).toBe('model3d');
		expect(detectFileType('bracket.3mf')).toBe('model3d');
		expect(detectFileType('cube.obj')).toBe('model3d');
		expect(detectFileType('README.md')).toBe('markdown');
		expect(detectFileType('page.html')).toBe('html');
		expect(detectFileType('icon.svg')).toBe('image');
		expect(detectFileType('photo.png')).toBe('image');
		expect(detectFileType('clip.mp4')).toBe('video');
		expect(detectFileType('take.wav')).toBe('audio');
		expect(detectFileType('paper.pdf')).toBe('pdf');
		expect(detectFileType('report.zip')).toBe('binary');
		expect(detectFileType('cloud.xyz')).toBe('text'); // 他の点群形式は対象外のまま(要件#58 スコープ)
		expect(detectFileType('cloud.pcd')).toBe('text');
		expect(detectFileType('Makefile')).toBe('text');
	});
});

// ---------------------------------------------------------------------------
// AC-58-2 — テキスト読込を通さない(契約①)
// ---------------------------------------------------------------------------

describe('AC-58-2 経路選択 — ply は model3d の既存経路に乗る(要件#58 ①)', () => {
	test('readsAsText: .ply は false(binary PLY があるので UTF-8 読込を通せない)', () => {
		expect(readsAsText('scan.ply')).toBe(false);
		expect(readsAsText(PLY)).toBe(false);
	});

	test('openCommandFor: ply は open_binary_document', () => {
		expect(openCommandFor(PLY)).toBe('open_binary_document');
	});

	test('openForDisplay: open_binary_document を1回だけ invoke し、解決値をそのまま返す', async () => {
		const payload = { uri: PLY, content: '', modified: null };
		invokeMock.mockResolvedValue(payload);

		const res = await openForDisplay(PLY);

		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledWith('open_binary_document', { uri: PLY });
		expect(res).toBe(payload);
	});

	test('既存の振り分けは不変(md はテキスト経路・png はバイナリ経路)', () => {
		expect(readsAsText('README.md')).toBe(true);
		expect(openCommandFor(`${ROOT}/README.md`)).toBe('open_document');
		expect(readsAsText('photo.png')).toBe(false);
		expect(openCommandFor(`${ROOT}/photo.png`)).toBe('open_binary_document');
	});
});

// ---------------------------------------------------------------------------
// AC-58-3 — reload 復元と表示ディスパッチ(契約①)
// ---------------------------------------------------------------------------

describe('AC-58-3 restoreSnapshot / renderForDisplay — ply は model3d 経路(要件#58 ①)', () => {
	test('restoreSnapshot: ply の docUri は set_root → open_binary_document(open_document は呼ばない)', async () => {
		const rootPayload = { root_uri: ROOT, entries: [], document_retained: false };
		const modelPayload = { uri: PLY, content: '', modified: null };
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'set_root') return rootPayload;
			if (cmd === 'open_binary_document') return modelPayload;
			throw new Error(`unexpected command: ${cmd}`);
		});

		const res = await restoreSnapshot({ rootUri: ROOT, docUri: PLY, expandedDirs: [] });

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root', 'open_binary_document']);
		expect(invokeMock.mock.calls[1]?.[1]).toEqual({ uri: PLY });
		expect(res).toEqual({ ok: true, root: rootPayload, document: modelPayload });
	});

	test('renderForDisplay: ply は modelSrc = toAssetUri(uri)・html は空・index は null', async () => {
		const res = await renderForDisplay(PLY, '');
		expect(res.modelSrc).toBe(toAssetUri(PLY));
		expect(res.html).toBe('');
		expect(res.index).toBeNull();
		// 他のビューアの合図と排他(modelSrc の存在だけが ModelViewer を選ぶ)
		expect(res.srcdoc).toBeUndefined();
		expect(res.imageSrc).toBeUndefined();
		expect(res.videoSrc).toBeUndefined();
		expect(res.audioSrc).toBeUndefined();
		expect(res.pdfSrc).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// AC-58-4〜7 — parseModel: 3エンコーディングの点群とメッシュ(契約②④)
// ---------------------------------------------------------------------------

describe('AC-58-4〜7 parseModel — PLY のパースと振り分け(要件#58 ②④)', () => {
	test('AC-58-4: 面なし ASCII 点群が kind points・pointCount 8・triangleCount 0・bbox [0,30]^3 で読める', async () => {
		const model = await parsePly('cloud-ascii.ply');
		expect(model.kind).toBe('points');
		expect(model.pointCount).toBe(8);
		expect(model.triangleCount).toBe(0); // position.count / 3 のフォールバックを点群に適用しない
		expectBounds(model.bounds, [0, 0, 0], [30, 30, 30]);
		expect(model.object).toBeTruthy();
	});

	test('AC-58-5: binary_little_endian 点群が ASCII 版と同じ結果で読める', async () => {
		const ascii = await parsePly('cloud-ascii.ply');
		const le = await parsePly('cloud-binary-le.ply');
		expect(le.kind).toBe(ascii.kind);
		expect(le.pointCount).toBe(ascii.pointCount);
		expect(le.triangleCount).toBe(ascii.triangleCount);
		expect(le.bounds).toEqual(ascii.bounds);
	});

	test('AC-58-6: binary_big_endian 点群も同じ結果 — 3エンコーディングすべてが揃う', async () => {
		const ascii = await parsePly('cloud-ascii.ply');
		const be = await parsePly('cloud-binary-be.ply');
		expect(be.kind).toBe(ascii.kind);
		expect(be.pointCount).toBe(ascii.pointCount);
		expect(be.triangleCount).toBe(ascii.triangleCount);
		expect(be.bounds).toEqual(ascii.bounds);
		expect(be.kind).toBe('points');
		expect(be.pointCount).toBe(8);
	});

	test('AC-58-7: face 要素を持つ PLY はメッシュ — kind mesh・triangleCount 12・pointCount 8・bbox [0,30]^3', async () => {
		const model = await parsePly('cube-mesh.ply');
		expect(model.kind).toBe('mesh');
		expect(model.triangleCount).toBe(12);
		expect(model.pointCount).toBe(8); // pointCount は kind によらず頂点数
		expectBounds(model.bounds, [0, 0, 0], [30, 30, 30]);
	});
});

// ---------------------------------------------------------------------------
// AC-58-8 — 描画対象の型(契約②③)
// ---------------------------------------------------------------------------

describe('AC-58-8 描画対象 — 面なしは Points・面ありは Mesh(要件#58 ②③)', () => {
	test('面なし PLY の描画対象は Points(isPoints === true)で、Mesh を含まない', async () => {
		const model = await parsePly('cloud-ascii.ply');
		const points = solePoints(model.object);
		expect(points.isPoints).toBe(true);
		expect(meshesOf(model.object)).toHaveLength(0);
	});

	test('面あり PLY の描画対象は Mesh(isMesh === true)で、Points を含まない', async () => {
		const model = await parsePly('cube-mesh.ply');
		const mesh = soleMesh(model.object);
		expect(mesh.isMesh).toBe(true);
		expect(pointsOf(model.object)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC-58-9 — 頂点色(契約②)
// ---------------------------------------------------------------------------

describe('AC-58-9 頂点色 — color 属性があれば vertexColors、無ければ単色(要件#58 ②)', () => {
	test('uchar red/green/blue を持つ点群は color 属性が載り、マテリアルの vertexColors が true', async () => {
		const model = await parsePly('cloud-color-ascii.ply');
		const points = solePoints(model.object);
		expect(points.geometry.getAttribute('color'), 'color 属性').toBeTruthy();
		expect(materialOf<PointsMaterial>(points).vertexColors).toBe(true);
	});

	test('色を持たない点群は color 属性が無く vertexColors は false(単色で描く)', async () => {
		const model = await parsePly('cloud-ascii.ply');
		const points = solePoints(model.object);
		expect(points.geometry.getAttribute('color')).toBeFalsy();
		expect(materialOf<PointsMaterial>(points).vertexColors).toBe(false);
	});

	test('色を持たないメッシュ PLY も vertexColors は false', async () => {
		const model = await parsePly('cube-mesh.ply');
		const mesh = soleMesh(model.object);
		expect(mesh.geometry.getAttribute('color')).toBeFalsy();
		expect(materialOf<MeshStandardMaterial>(mesh).vertexColors).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-58-10 — 点群マテリアル(契約③)
// ---------------------------------------------------------------------------

describe('AC-58-10 点群マテリアル — PointsMaterial・size 2・sizeAttenuation false(要件#58 ③)', () => {
	test('点群のマテリアルは PointsMaterial で、size === 2・sizeAttenuation === false', async () => {
		const model = await parsePly('cloud-ascii.ply');
		const material = materialOf<PointsMaterial>(solePoints(model.object));
		expect(material.isPointsMaterial, 'PointsMaterial であること').toBe(true);
		expect(material.size).toBe(2);
		expect(material.sizeAttenuation).toBe(false);
	});

	test('頂点色つき点群でも同じ値(色の有無は size / sizeAttenuation に影響しない)', async () => {
		const model = await parsePly('cloud-color-ascii.ply');
		const material = materialOf<PointsMaterial>(solePoints(model.object));
		expect(material.isPointsMaterial).toBe(true);
		expect(material.size).toBe(2);
		expect(material.sizeAttenuation).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-58-11 — 法線の扱い(契約②)
// ---------------------------------------------------------------------------

describe('AC-58-11 法線 — メッシュだけ補い、点群では作らない(要件#58 ②)', () => {
	test('面ありで法線を持たない PLY は normal 属性が補われる(真っ黒にならない)', async () => {
		const model = await parsePly('cube-mesh.ply');
		const mesh = soleMesh(model.object);
		expect(mesh.geometry.getAttribute('normal'), 'computeVertexNormals による補完').toBeTruthy();
	});

	test('面なし(点群)では normal 属性を作らない(百万点への法線計算をしない)', async () => {
		const model = await parsePly('cloud-ascii.ply');
		const points = solePoints(model.object);
		expect(points.geometry.getAttribute('normal')).toBeFalsy();
	});

	test('ファイル側が nx ny nz を持つ点群では、その normal 属性は残る', async () => {
		const model = await parsePly('cloud-color-ascii.ply');
		const points = solePoints(model.object);
		expect(points.geometry.getAttribute('normal'), 'PLYLoader が読んだ法線').toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// AC-58-12 — 縮退(契約⑥)
// ---------------------------------------------------------------------------

describe('AC-58-12 縮退 — 頂点0・壊れたヘッダは reject(要件#58 ⑥)', () => {
	test('頂点0の PLY は既存の失敗経路で reject する(The model has no drawable geometry)', async () => {
		await expect(parseModel(PLY, fixture('empty.ply'))).rejects.toThrow(
			'The model has no drawable geometry',
		);
	});

	test('本体が欠けた binary ヘッダ(vertex 1000 なのに 8 バイト)は例外で reject する', async () => {
		// PLYLoader の DataView 読みが境界外で投げる — ハングも未定義動作も起こさない。
		const header =
			'ply\nformat binary_little_endian 1.0\nelement vertex 1000\n' +
			'property float x\nproperty float y\nproperty float z\nend_header\n';
		const headerBytes = new TextEncoder().encode(header);
		const bytes = new Uint8Array(headerBytes.length + 8);
		bytes.set(headerBytes, 0);
		await expect(parseModel(PLY, bytes.buffer as ArrayBuffer)).rejects.toBeTruthy();
	});

	test('PLY ですらないバイト列(magic なし)も reject する', async () => {
		// 非 ASCII 主体の無意味なバイト列 — 頂点が読めず、既存の失敗経路へ落ちる。
		const junk = new Uint8Array(64);
		for (let i = 0; i < junk.length; i++) junk[i] = 0x80 + ((i * 31) % 100);
		await expect(parseModel(PLY, junk.buffer as ArrayBuffer)).rejects.toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// AC-58-13 — 決定性(契約②)
// ---------------------------------------------------------------------------

describe('AC-58-13 決定性 — 同じバイト列は同じ結果(要件#58 ②)', () => {
	test('点群: 同じバイト列は同じ kind / pointCount / triangleCount / bounds を返す', async () => {
		const a = await parsePly('cloud-binary-le.ply');
		const b = await parsePly('cloud-binary-le.ply');
		expect(a.kind).toBe(b.kind);
		expect(a.pointCount).toBe(b.pointCount);
		expect(a.triangleCount).toBe(b.triangleCount);
		expect(a.bounds).toEqual(b.bounds);
	});

	test('メッシュ: 同じバイト列は同じ結果を返す', async () => {
		const a = await parsePly('cube-mesh.ply');
		const b = await parsePly('cube-mesh.ply');
		expect(a.kind).toBe(b.kind);
		expect(a.pointCount).toBe(b.pointCount);
		expect(a.triangleCount).toBe(b.triangleCount);
		expect(a.bounds).toEqual(b.bounds);
	});
});

// ---------------------------------------------------------------------------
// AC-58-14 — 表示ラベルの純関数(契約④)
// ---------------------------------------------------------------------------

describe('AC-58-14 modelStatsLabel — 点群は N points・メッシュは N triangles(要件#58 ④)', () => {
	test('model-viewing.ts が modelStatsLabel(parsed) を export している', async () => {
		expect(typeof (await importModelStatsLabel())).toBe('function');
	});

	test('点群: "N points"(3桁区切り・英語)', async () => {
		const label = (await importModelStatsLabel()) as (parsed: ParsedModel) => string;
		expect(typeof label).toBe('function');
		expect(label(statsInput('points', 8, 0))).toBe('8 points');
		expect(label(statsInput('points', 1_000_000, 0))).toBe('1,000,000 points');
	});

	test('メッシュ: "N triangles"(従来どおりの文言・3桁区切り)', async () => {
		const label = (await importModelStatsLabel()) as (parsed: ParsedModel) => string;
		expect(typeof label).toBe('function');
		expect(label(statsInput('mesh', 8, 12))).toBe('12 triangles');
		expect(label(statsInput('mesh', 500_000, 1_000_000))).toBe('1,000,000 triangles');
	});
});

// ---------------------------------------------------------------------------
// AC-58-15 — 既存形式の不変(契約④⑦)
// ---------------------------------------------------------------------------

describe('AC-58-15 既存形式の不変 — STL / 3MF は従来どおり+kind/pointCount が埋まる(要件#58 ④⑦)', () => {
	test('ASCII STL: triangleCount 12・bbox [0,10]^3 は不変で、kind mesh・pointCount 36(非インデックス 12×3)', async () => {
		const model = (await parseModel('file:///m/cube.stl', fixture('cube-ascii.stl'))) as PlyParsedModel;
		expect(model.triangleCount).toBe(12);
		expectBounds(model.bounds, [0, 0, 0], [10, 10, 10]);
		expect(model.kind).toBe('mesh');
		expect(model.pointCount).toBe(36);
	});

	test('3MF: triangleCount 12・bbox [0,20]^3 は不変で、kind mesh・pointCount 8(インデックス済み頂点)', async () => {
		const model = (await parseModel('file:///m/cube.3mf', fixture('cube.3mf'))) as PlyParsedModel;
		expect(model.triangleCount).toBe(12);
		expectBounds(model.bounds, [0, 0, 0], [20, 20, 20]);
		expect(model.kind).toBe('mesh');
		expect(model.pointCount).toBe(8);
	});

	test('対象外の拡張子(step 等)は従来どおり reject する', async () => {
		await expect(parseModel('file:///m/part.step', fixture('cloud-ascii.ply'))).rejects.toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// AC-58-16 — 依存追加ゼロと PLYLoader の出どころ(契約⑦)
// ---------------------------------------------------------------------------

/**
 * 依存追加ゼロの固定(git diff に依存しない形): dependencies の名前一覧そのものを
 * 要件#58 周回開始時点(2026-09-21)の実測値に固定する。実装が依存を足せば
 * この一覧が変わって赤くなる(要件#57 AC-57-15 と同じ作法)。
 */
describe('AC-58-16 不変 — 依存追加ゼロ・PLYLoader は three 同梱(要件#58 ⑦)', () => {
	test('package.json の dependencies に追加が無い', () => {
		const pkg = JSON.parse(
			readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'),
		) as { dependencies: Record<string, string> };
		expect(Object.keys(pkg.dependencies).sort()).toEqual(
			[
				'@shikijs/rehype',
				'@tauri-apps/api',
				'@tauri-apps/plugin-dialog',
				'@tauri-apps/plugin-opener',
				'hast-util-to-mdast',
				'mdast-util-to-markdown',
				'mdast-util-to-string',
				'mermaid',
				'rehype-parse',
				'rehype-raw',
				'rehype-sanitize',
				'rehype-stringify',
				'remark-gfm',
				'remark-parse',
				'remark-rehype',
				'three',
				'unified',
				'unist-util-visit',
			].sort(),
		);
	});

	test('src-tauri/Cargo.toml の [dependencies] に追加が無い(Rust 側は一切触らない)', () => {
		const toml = readFileSync(
			fileURLToPath(new URL('../../src-tauri/Cargo.toml', import.meta.url)),
			'utf-8',
		);
		const section = toml.split(/^\[dependencies\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
		const names = [...section.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]).sort();
		expect(names).toEqual(
			[
				'tauri',
				'tauri-plugin-opener',
				'serde',
				'serde_json',
				'clap',
				'thiserror',
				'tokio',
				'async-trait',
				'notify',
				'libc',
				'tracing',
				'tracing-subscriber',
				'mime_guess',
				'http',
				'percent-encoding',
				'tauri-plugin-dialog',
				'reqwest',
				'russh',
				'russh-sftp',
				'bytes',
				'dirs',
				'ulid',
				'chrono',
				'strsim',
				'sha2',
				'similar',
				'hidapi',
				'toml',
				'tauri-plugin-webdriver',
				'tauri-plugin-window-state',
			].sort(),
		);
	});

	test('PLYLoader の import 元は three/examples/jsm/loaders/PLYLoader.js(model-viewing.ts のソース)', () => {
		const source = readFileSync(
			fileURLToPath(new URL('./model-viewing.ts', import.meta.url)),
			'utf-8',
		);
		expect(source).toMatch(/from\s+'three\/examples\/jsm\/loaders\/PLYLoader\.js'/);
	});
});

// ---------------------------------------------------------------------------
// AC-58-20 — 追補a: 頂点色つき PLY のマテリアル色は白(頂点色がそのまま出る)
// ---------------------------------------------------------------------------

/**
 * 追補a(docs/requirements/req-58.md・2026-09-23): three.js は
 * **最終色 = マテリアル色 × 頂点色**。`vertexColors` を立てるときもマテリアル色が
 * `0xb9c0c8` のままだと、ファイルの頂点色が各チャンネル 185/192/200 倍(約 73%)に
 * 減光+寒色化する(実機で赤 255 → 185 を実測)。
 *
 * 契約(AC-58-20): **頂点色を持つ PLY のマテリアル色は `0xffffff`・持たない PLY は
 * 従来どおり `0xb9c0c8`**。点群(`PointsMaterial`)とメッシュ(`MeshStandardMaterial`)
 * の両方で固定する。併せて追補a が壊してはいけないもの(`vertexColors` の真偽・
 * `size` 2・`sizeAttenuation` false・STL / 3MF / OBJ の単色)も同じ describe で観測する
 * (既存 AC-58-9 / 10 / 15 は書き換えず、新規ケースとして足す)。
 *
 * 色の判定は `material.color.getHex(SRGBColorSpace)` で行う。three 0.185 は
 * `ColorManagement.enabled = true` が既定で、`new Color(0xb9c0c8)` / `setHex` は
 * 引数を sRGB とみなして作業色空間(リニア)へ変換して保持する。`getHex` の既定引数も
 * `SRGBColorSpace` なので既定のままでも同じ値に戻るが、set / get の色空間が対になって
 * いることをテスト側で明示するため引数を書く(sRGB ↔ リニアの往復は 8bit 値で
 * 正確に元へ戻る= 0xb9c0c8 / 0xffffff とも丸め誤差なし)。
 * `getHexString` は同じ経路の文字列化なので判定には使わない(16進の前ゼロ処理が絡む
 * だけで意味は同じだが、数値比較の方が失敗時の差分が読みやすい)。
 *
 * 赤の根拠(実装前): `pointCloudMaterial` は `color: 0xb9c0c8` 固定・メッシュ側は
 * `stlMaterial()` の `0xb9c0c8` をそのまま使うため、頂点色つき 2 ケース
 * (点群・メッシュ)の `0xffffff` 期待が `0xb9c0c8` で失敗する。
 */

/** 白=頂点色がそのまま出る(乗算で変わらない)。 */
const WHITE = 0xffffff;
/** 従来の単色(STL と同じ既定)。 */
const DEFAULT_GREY = 0xb9c0c8;

function colorHexOf(target: Points | Mesh): number {
	return materialOf<PointsMaterial | MeshStandardMaterial>(target).color.getHex(SRGBColorSpace);
}

/** AC-58-20 の OBJ 不変判定用の最小立方体([0,5]^3・要件#57 と同じ寸法)。 */
const OBJ_CUBE = [
	'v 0 0 0',
	'v 5 0 0',
	'v 5 5 0',
	'v 0 5 0',
	'v 0 0 5',
	'v 5 0 5',
	'v 5 5 5',
	'v 0 5 5',
	'f 1 2 3',
	'f 1 3 4',
	'f 5 6 7',
	'f 5 7 8',
	'f 1 2 6',
	'f 1 6 5',
	'f 2 3 7',
	'f 2 7 6',
	'f 3 4 8',
	'f 3 8 7',
	'f 4 1 5',
	'f 4 5 8',
	'',
].join('\n');

describe('AC-58-20 追補a — 頂点色つき PLY のマテリアル色は 0xffffff・無ければ 0xb9c0c8(点群・メッシュとも)', () => {
	test('頂点色つき点群: PointsMaterial の color が 0xffffff(頂点色が減光されずそのまま出る)', async () => {
		const model = await parsePly('cloud-color-ascii.ply');
		const points = solePoints(model.object);
		expect(points.geometry.getAttribute('color'), '前提: color 属性あり').toBeTruthy();
		expect(materialOf<PointsMaterial>(points).vertexColors, '前提: vertexColors').toBe(true);
		expect(colorHexOf(points).toString(16)).toBe(WHITE.toString(16));
	});

	test('頂点色なし点群: PointsMaterial の color は従来どおり 0xb9c0c8', async () => {
		const model = await parsePly('cloud-ascii.ply');
		const points = solePoints(model.object);
		expect(materialOf<PointsMaterial>(points).vertexColors).toBe(false);
		expect(colorHexOf(points).toString(16)).toBe(DEFAULT_GREY.toString(16));
	});

	test('頂点色なし binary 点群(LE / BE)も 0xb9c0c8(エンコーディングで分岐しない)', async () => {
		for (const name of ['cloud-binary-le.ply', 'cloud-binary-be.ply']) {
			const model = await parsePly(name);
			const points = solePoints(model.object);
			expect(materialOf<PointsMaterial>(points).vertexColors, name).toBe(false);
			expect(colorHexOf(points).toString(16), name).toBe(DEFAULT_GREY.toString(16));
		}
	});

	test('頂点色つきメッシュ PLY: color 属性が載り vertexColors が true・MeshStandardMaterial の color が 0xffffff', async () => {
		const model = await parsePly('cube-color-mesh.ply');
		expect(model.kind).toBe('mesh');
		expect(model.triangleCount).toBe(12);
		expect(model.pointCount).toBe(8);
		expectBounds(model.bounds, [0, 0, 0], [30, 30, 30]);
		const mesh = soleMesh(model.object);
		expect(mesh.geometry.getAttribute('color'), 'PLYLoader が読んだ頂点色').toBeTruthy();
		const material = materialOf<MeshStandardMaterial>(mesh);
		expect(material.isMeshStandardMaterial, 'STL と同じ MeshStandardMaterial').toBe(true);
		expect(material.vertexColors).toBe(true);
		expect(colorHexOf(mesh).toString(16)).toBe(WHITE.toString(16));
	});

	test('頂点色なしメッシュ PLY: MeshStandardMaterial の color は従来どおり 0xb9c0c8', async () => {
		const model = await parsePly('cube-mesh.ply');
		const mesh = soleMesh(model.object);
		expect(materialOf<MeshStandardMaterial>(mesh).vertexColors).toBe(false);
		expect(colorHexOf(mesh).toString(16)).toBe(DEFAULT_GREY.toString(16));
	});

	test('白にしても点群マテリアルの他の値は不変(PointsMaterial・size 2・sizeAttenuation false)', async () => {
		for (const name of ['cloud-color-ascii.ply', 'cloud-ascii.ply']) {
			const model = await parsePly(name);
			const material = materialOf<PointsMaterial>(solePoints(model.object));
			expect(material.isPointsMaterial, name).toBe(true);
			expect(material.size, name).toBe(2);
			expect(material.sizeAttenuation, name).toBe(false);
		}
	});

	test('白にしてもメッシュ側の他の値は不変(頂点色つき / なしとも metalness 0.1・roughness 0.65 = STL と同じ既定)', async () => {
		for (const name of ['cube-color-mesh.ply', 'cube-mesh.ply']) {
			const model = await parsePly(name);
			const material = materialOf<MeshStandardMaterial>(soleMesh(model.object));
			expect(material.isMeshStandardMaterial, name).toBe(true);
			expect(material.metalness, name).toBeCloseTo(0.1, 6);
			expect(material.roughness, name).toBeCloseTo(0.65, 6);
		}
	});

	test('STL(ascii / binary)/ OBJ は頂点色を持たないので従来どおり 0xb9c0c8・vertexColors false(追補a の影響範囲外)', async () => {
		// 3MF はここに含めない: 要件#23 の契約は「STL = 無彩色 0xb9c0c8・3MF = ファイル側の
		// 色・マテリアルをローダーが組むので触らない」。3MF の不変は次のケースで固定する。
		const inputs: Array<[string, ArrayBuffer]> = [
			['file:///m/cube.stl', fixture('cube-ascii.stl')],
			['file:///m/cube-bin.stl', fixture('cube-binary.stl')],
			['file:///m/cube.obj', new TextEncoder().encode(OBJ_CUBE).buffer as ArrayBuffer],
		];
		for (const [uri, buffer] of inputs) {
			const model = await parseModel(uri, buffer);
			const meshes = meshesOf(model.object);
			expect(meshes.length, `${uri}: Mesh が 1 つ以上`).toBeGreaterThan(0);
			for (const mesh of meshes) {
				const material = materialOf<MeshStandardMaterial>(mesh);
				expect(material.vertexColors, uri).toBe(false);
				expect(colorHexOf(mesh).toString(16), uri).toBe(DEFAULT_GREY.toString(16));
			}
		}
	});

	test('3MF はファイル側のマテリアルのまま(stlMaterial に差し替えられず・vertexColors false・追補a の影響範囲外)', async () => {
		// 要件#23 の契約: 3MF は色・マテリアルを ThreeMFLoader が組むので parseModel は触らない。
		// cube.3mf の色そのものには依存せず、「0xb9c0c8 の既定に握り潰されていない」ことと
		// 「頂点色経路(vertexColors)に乗っていない」ことだけを固定する。
		const model = await parseModel('file:///m/cube.3mf', fixture('cube.3mf'));
		const meshes = meshesOf(model.object);
		expect(meshes.length, 'Mesh が 1 つ以上').toBeGreaterThan(0);
		for (const mesh of meshes) {
			const material = materialOf<MeshStandardMaterial>(mesh);
			expect(material.vertexColors).toBe(false);
			expect(colorHexOf(mesh).toString(16)).not.toBe(DEFAULT_GREY.toString(16));
		}
	});
});
