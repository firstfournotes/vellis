/**
 * 要件#58 追補c の受け入れテスト — OBJ の `parseModel` の結果の `kind`・`pointCount`
 * (docs/requirements/req-58.md「追補c」(2026-10-25)・AC-58-追c・Issue #555)
 *
 * AC-58-15 は STL・3MF の `kind` / `pointCount` だけを固定していて OBJ は固定されていなかった
 * (要件#58 の reviewer P2)。AC-58-15 の既存のテストは変えず、別のテストとして足す。
 *
 * ## 確定契約(テストの追補= 振る舞いは変えない。正本= docs/requirements/req-58.md 追補c)
 *
 * OBJ の `parseModel` の結果も `kind` が `'mesh'`・`pointCount` が頂点数である。頂点数は
 * **three.js の位置の属性の数**(`ParsedModel.pointCount` の定義・AC-58-15 の STL と同じ数え方)。
 * `OBJLoader` は面を非インデックスで組むので、立方体(`v` 8 行・12 三角形)の位置の属性は
 * 12 × 3 = **36**(STL の 36 と同じ・3MF の 8 とは違う)。
 *
 * 注(オーケストレーターへ): AC-58-追c の本文「`v` 行の数(three.js の位置の属性の数)」は、
 * `OBJLoader` の出力では `v` 行の数(8)と位置の属性の数(36)が一致しない。契約「振る舞いは
 * 変えない」と `ParsedModel.pointCount` の既定義(AC-58-15 の STL= 位置の属性の数)に合わせ、
 * 本ファイルは**位置の属性の数**で固定する。`v` 行の数(8)を求めるなら実装の変更になる。
 *
 * ## 赤/緑の見込み
 * 現行の `parseModel` は形式によらず `kind` を `'mesh'` で初期化し、`summarize` が位置の
 * 属性の数を `pointCount` に入れるので、本ファイルは実装前から緑のはず(退行の歯止め)。
 * OBJ の分岐で `kind` を落とす・`pointCount` を 0 にする変異で赤。
 */
import { describe, expect, test } from 'vitest';
import type { Mesh, Object3D } from 'three';
import { modelStatsLabel, parseModel } from './model-viewing';

const OBJ = 'file:///Users/a/work/models/cube.obj';

/** 立方体の 8 頂点([0,5]^3・要件#57 と同じ寸法)。 */
const CUBE_VERTICES = `v 0 0 0
v 5 0 0
v 5 5 0
v 0 5 0
v 0 0 5
v 5 0 5
v 5 5 5
v 0 5 5
`;

/** 三角形面だけの立方体= 12 三角形・位置の属性 36。 */
const CUBE_TRI = `${CUBE_VERTICES}f 1 2 3
f 1 3 4
f 5 6 7
f 5 7 8
f 1 2 6
f 1 6 5
f 2 3 7
f 2 7 6
f 3 4 8
f 3 8 7
f 4 1 5
f 4 5 8
`;

/** 四角形面だけの立方体= 三角形化で 12 三角形・位置の属性 36。 */
const CUBE_QUAD = `${CUBE_VERTICES}f 1 2 3 4
f 5 6 7 8
f 1 2 6 5
f 2 3 7 6
f 3 4 8 7
f 4 1 5 8
`;

/** o で 2 グループ: 立方体(12 三角形)+三角形 1 枚= 13 三角形・位置の属性 39。 */
const TWO_GROUPS = `o CubeA
${CUBE_TRI}o TriB
v 10 0 0
v 12 0 0
v 10 2 0
f 9 10 11
`;

function toBuffer(text: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(text);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** object 配下の Mesh の位置の属性の数の合計(= 契約の「頂点数」を結果の幾何から直接数える)。 */
function positionCountOf(object: Object3D): number {
	let count = 0;
	object.traverse((child) => {
		const mesh = child as Mesh;
		if (!mesh.isMesh) return;
		count += mesh.geometry.getAttribute('position')?.count ?? 0;
	});
	return count;
}

describe('AC-58-追c parseModel — OBJ の kind は mesh・pointCount は位置の属性の数(要件#58 追補c)', () => {
	test('三角形面の立方体: kind mesh・pointCount 36(非インデックス 12×3)・位置の属性の合計と一致', async () => {
		const model = await parseModel(OBJ, toBuffer(CUBE_TRI));
		expect(model.kind).toBe('mesh');
		expect(model.pointCount).toBe(36);
		expect(model.pointCount).toBe(positionCountOf(model.object));
		expect(model.pointCount, '非インデックスなので三角形数 × 3').toBe(model.triangleCount * 3);
	});

	test('四角形面の立方体: 三角形化後の位置の属性の数 36 が pointCount・kind mesh', async () => {
		const model = await parseModel(OBJ, toBuffer(CUBE_QUAD));
		expect(model.kind).toBe('mesh');
		expect(model.pointCount).toBe(36);
		expect(model.pointCount).toBe(positionCountOf(model.object));
	});

	test('2 グループ(13 三角形): pointCount は全グループの合計 39・kind mesh', async () => {
		const model = await parseModel(OBJ, toBuffer(TWO_GROUPS));
		expect(model.kind).toBe('mesh');
		expect(model.triangleCount).toBe(13);
		expect(model.pointCount).toBe(39);
		expect(model.pointCount).toBe(positionCountOf(model.object));
	});

	test('kind が mesh なので表示ラベルは三角形数(12 triangles)で、points にはならない', async () => {
		const model = await parseModel(OBJ, toBuffer(CUBE_TRI));
		expect(modelStatsLabel(model)).toBe('12 triangles');
	});

	test('決定性: 同じ OBJ は同じ kind / pointCount を返す', async () => {
		const a = await parseModel(OBJ, toBuffer(CUBE_TRI));
		const b = await parseModel(OBJ, toBuffer(CUBE_TRI));
		expect(a.kind).toBe(b.kind);
		expect(a.pointCount).toBe(b.pointCount);
	});
});
