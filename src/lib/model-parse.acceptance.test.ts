/**
 * 要件#23 の受け入れテスト — モデルパース(requirements.md #23)
 *
 * 判定範囲: ArrayBuffer → 描画対象の正規化層。ModelViewer.svelte が
 * fetch(vellis-asset) で得たバイト列をここへ渡す。WebGL 描画そのものは
 * 機械判定不能(人間ゲート。一覧は model-viewing.acceptance.test.ts 冒頭)。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * `src/lib/model-viewing.ts` に:
 *
 * ```ts
 * export interface ParsedModel {
 *   // three.js の Object3D(シーンへ add する描画対象)。テストは中身の型までは
 *   // 見ない — 頂点数とバウンディングボックスが正であることが「パースできた」の判定
 *   object: object;
 *   triangleCount: number;
 *   bounds: { min: [number, number, number]; max: [number, number, number] };
 * }
 * export function parseModel(nameOrUri: string, buffer: ArrayBuffer): Promise<ParsedModel>;
 * ```
 *
 * - 形式は拡張子で振り分ける(stl → STLLoader・3mf → ThreeMFLoader。
 *   STL は ASCII / バイナリ両形式とも読める=STLLoader の自動判別に乗る)
 * - stl / 3mf 以外の拡張子は reject(呼び出し側のバグを黙って通さない)
 * - 壊れた 3MF(ZIP でない)は reject(ハング・未定義動作にしない)
 * - 決定性: 同じバイト列は同じ triangleCount / bounds を返す
 *
 * フィクスチャは src/lib/__fixtures__/(生成方法は同ディレクトリ README.md)。
 * 全部同じ立方体 12 三角形で、STL は bbox [0,10]^3・3MF は [0,20]^3 —
 * 数値が違うこと自体が「正しいローダーに渡った」ことの判定材料。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parseModel } from './model-viewing';

/** フィクスチャを ArrayBuffer で読む(Buffer のオフセット混入を避けて切り出す)。 */
function fixture(name: string): ArrayBuffer {
	const buf = readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)));
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
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

describe('parseModel — STL(要件#23 ②)', () => {
	test('ASCII STL: 立方体が 12 三角形・bbox [0,10]^3 で読める', async () => {
		const model = await parseModel('file:///m/cube.stl', fixture('cube-ascii.stl'));
		expect(model.triangleCount).toBe(12);
		expectBounds(model.bounds, [0, 0, 0], [10, 10, 10]);
		expect(model.object).toBeTruthy();
	});

	test('バイナリ STL: 同じ立方体が同じ結果で読める(両エンコーディング対応)', async () => {
		const model = await parseModel('file:///m/cube.stl', fixture('cube-binary.stl'));
		expect(model.triangleCount).toBe(12);
		expectBounds(model.bounds, [0, 0, 0], [10, 10, 10]);
	});
});

describe('parseModel — 3MF(要件#23 ②)', () => {
	test('最小 3MF(ZIP+XML): 立方体が 12 三角形・bbox [0,20]^3 で読める', async () => {
		const model = await parseModel('file:///m/cube.3mf', fixture('cube.3mf'));
		expect(model.triangleCount).toBe(12);
		expectBounds(model.bounds, [0, 0, 0], [20, 20, 20]);
		expect(model.object).toBeTruthy();
	});

	test('壊れた 3MF(ZIP でないバイト列)は reject する', async () => {
		const garbage = new TextEncoder().encode('this is not a zip archive').buffer as ArrayBuffer;
		await expect(parseModel('file:///m/broken.3mf', garbage)).rejects.toBeTruthy();
	});
});

describe('parseModel — 境界', () => {
	test('拡張子の大文字小文字を問わない', async () => {
		const model = await parseModel('file:///m/CUBE.STL', fixture('cube-ascii.stl'));
		expect(model.triangleCount).toBe(12);
	});

	test('対象外の拡張子(step 等)は reject する', async () => {
		await expect(parseModel('file:///m/part.step', fixture('cube-ascii.stl'))).rejects.toBeTruthy();
	});

	test('決定性: 同じバイト列は同じ triangleCount / bounds を返す', async () => {
		const a = await parseModel('file:///m/cube.3mf', fixture('cube.3mf'));
		const b = await parseModel('file:///m/cube.3mf', fixture('cube.3mf'));
		expect(a.triangleCount).toBe(b.triangleCount);
		expect(a.bounds).toEqual(b.bounds);
	});
});
