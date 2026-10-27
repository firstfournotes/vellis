/**
 * 要件#23 追補e (b) の受け入れテスト — 色つき 3MF のファイル側の色が出る
 * (docs/requirements/req-23.md「追補e」(2026-10-25)・AC-23-追e (b)・Issue #558)
 *
 * 要件#23 契約④「3MF はファイル側の色・マテリアルをローダーが組むので触らない」を固定する
 * テストが無かった(`cube.3mf` は色を持たず、ローダーの既定の白になるだけ)。要件#58 追補a の
 * reviewer P2。
 *
 * ## 確定契約(テストの追補= 振る舞いは変えない。正本= docs/requirements/req-23.md 追補e 契約2・3)
 *
 * 1. 色を持つ 3MF(`basematerials` の `displaycolor` を三角形に当てたもの)を `parseModel` に
 *    渡すと、結果のメッシュのマテリアルの色は **`displaycolor` から three.js の `ThreeMFLoader`
 *    が組む値**(`material.color.setStyle('#RRGGBB', SRGBColorSpace)`= sRGB → 作業色空間の変換を
 *    含む)であり、STL / OBJ の既定色 `0xb9c0c8` に握り潰されていない。
 * 2. 不変: 3MF の読み込み(三角形数・bounds・kind・pointCount)・色の無い 3MF はローダーの
 *    既定(白)のまま・STL の既定マテリアル(`0xb9c0c8`)。
 *
 * ## フィクスチャ
 * `src/lib/__fixtures__/cube-color.3mf`(生成= 同ディレクトリ `generate-3mf-color.py`・説明は
 * README.md)。立方体 [0,40]^3・12 三角形・`base name="Red" displaycolor="#FF0000"` を
 * `object pid="2" pindex="0"` で全三角形に当てる。`ThreeMFLoader` はこれを
 * `buildBasematerialsMeshes` で非インデックスの Mesh 1 つ(36 頂点)に組む。
 *
 * ## 判定
 * 期待色はテスト内で同じ手順(`new Color().setStyle('#FF0000', SRGBColorSpace)`)で作って
 * `Color.equals` で比べる(作業色空間の既定が変わっても両者は同じ経路なので一致する)。
 * 併せて `getHex(SRGBColorSpace)` が `0xff0000`・`0xb9c0c8` でないこと・赤が支配的なこと
 * (r > 0.9・g, b < 0.1= 握り潰しや乗算の有無をチャンネルで見る)を判定する。
 *
 * ## 赤/緑の見込み
 * 現行の `parseModel` は 3MF の分岐でローダーの出力を素通ししているので、本ファイルは
 * 実装前から緑のはず(退行の歯止め)。3MF のマテリアルを `stlMaterial()` に差し替える変異で赤。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
	Color,
	SRGBColorSpace,
	type Material,
	type Mesh,
	type MeshStandardMaterial,
	type Object3D,
} from 'three';
import { parseModel } from './model-viewing';

/** `displaycolor` の値(generate-3mf-color.py の DISPLAY_COLOR と同じ)。 */
const DISPLAY_COLOR = '#FF0000';
/** STL / OBJ の既定色(握り潰されていないことの対照)。 */
const DEFAULT_GREY = 0xb9c0c8;
/** `ThreeMFLoader` の `buildDefaultMesh` の色(色を持たない 3MF の既定)。 */
const LOADER_DEFAULT_WHITE = 0xffffff;

/** フィクスチャを ArrayBuffer で読む(Buffer のオフセット混入を避けて切り出す)。 */
function fixture(name: string): ArrayBuffer {
	const buf = readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)));
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** object 配下の Mesh を列挙する(グループ構成に依存しない観測)。 */
function meshesOf(object: Object3D): Mesh[] {
	const meshes: Mesh[] = [];
	object.traverse((child) => {
		if ((child as Mesh).isMesh) meshes.push(child as Mesh);
	});
	return meshes;
}

/** 色を持つマテリアル(MeshPhongMaterial / MeshStandardMaterial のどちらでも `color` を持つ)。 */
type ColoredMaterial = Material & { color: Color; name: string };

function materialsOf(mesh: Mesh): ColoredMaterial[] {
	const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
	return list as ColoredMaterial[];
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

describe('AC-23-追e (b) parseModel — 色つき 3MF はファイルの displaycolor が出る(要件#23 追補e 契約2)', () => {
	test('マテリアルの色が three.js が displaycolor から組む値(setStyle(#FF0000, SRGBColorSpace))と一致する', async () => {
		const model = await parseModel('file:///m/cube-color.3mf', fixture('cube-color.3mf'));
		const meshes = meshesOf(model.object);
		expect(meshes.length, '色つきの Mesh が 1 つ組まれる').toBe(1);

		const expected = new Color().setStyle(DISPLAY_COLOR, SRGBColorSpace);
		for (const material of materialsOf(meshes[0])) {
			expect(material.color, 'color を持つマテリアル').toBeDefined();
			expect(material.color.equals(expected), `色が ${DISPLAY_COLOR} の作業色空間の値と一致`).toBe(true);
		}
	});

	test('getHex(SRGBColorSpace) は 0xff0000 で、STL の既定色 0xb9c0c8 ではない', async () => {
		const model = await parseModel('file:///m/cube-color.3mf', fixture('cube-color.3mf'));
		for (const mesh of meshesOf(model.object)) {
			for (const material of materialsOf(mesh)) {
				const hex = material.color.getHex(SRGBColorSpace);
				expect(hex.toString(16)).toBe((0xff0000).toString(16));
				expect(hex, '0xb9c0c8 に握り潰されていない').not.toBe(DEFAULT_GREY);
			}
		}
	});

	test('赤が支配的(r > 0.9・g, b < 0.1)= 既定色との乗算や差し替えが無い', async () => {
		const model = await parseModel('file:///m/cube-color.3mf', fixture('cube-color.3mf'));
		for (const mesh of meshesOf(model.object)) {
			for (const material of materialsOf(mesh)) {
				expect(material.color.r, 'r').toBeGreaterThan(0.9);
				expect(material.color.g, 'g').toBeLessThan(0.1);
				expect(material.color.b, 'b').toBeLessThan(0.1);
			}
		}
	});

	test('ローダーが組んだマテリアルがそのまま(name が basematerial の "Red")', async () => {
		const model = await parseModel('file:///m/cube-color.3mf', fixture('cube-color.3mf'));
		for (const mesh of meshesOf(model.object)) {
			for (const material of materialsOf(mesh)) {
				expect(material.name).toBe('Red');
			}
		}
	});

	test('幾何は変わらない: 12 三角形・bbox [0,40]^3・kind mesh・pointCount 36(非インデックス 12×3)', async () => {
		const model = await parseModel('file:///m/cube-color.3mf', fixture('cube-color.3mf'));
		expect(model.triangleCount).toBe(12);
		expectBounds(model.bounds, [0, 0, 0], [40, 40, 40]);
		expect(model.kind).toBe('mesh');
		expect(model.pointCount).toBe(36);
	});
});

describe('AC-23-追e 契約3 parseModel — 不変: 色の無い 3MF はローダーの既定の白・STL は 0xb9c0c8(要件#23 追補e 契約3)', () => {
	test('色の無い cube.3mf のマテリアルはローダーの既定(0xffffff)で、0xb9c0c8 でもない', async () => {
		const model = await parseModel('file:///m/cube.3mf', fixture('cube.3mf'));
		const meshes = meshesOf(model.object);
		expect(meshes.length).toBeGreaterThan(0);
		for (const mesh of meshes) {
			for (const material of materialsOf(mesh)) {
				const hex = material.color.getHex(SRGBColorSpace);
				expect(hex.toString(16)).toBe(LOADER_DEFAULT_WHITE.toString(16));
				expect(hex).not.toBe(DEFAULT_GREY);
			}
		}
	});

	test('STL の既定マテリアルは今までどおり MeshStandardMaterial・0xb9c0c8', async () => {
		const model = await parseModel('file:///m/cube.stl', fixture('cube-ascii.stl'));
		const meshes = meshesOf(model.object);
		expect(meshes.length).toBe(1);
		const material = materialsOf(meshes[0])[0] as unknown as MeshStandardMaterial;
		expect(material.isMeshStandardMaterial).toBe(true);
		expect(material.color.getHex(SRGBColorSpace).toString(16)).toBe(DEFAULT_GREY.toString(16));
	});
});
