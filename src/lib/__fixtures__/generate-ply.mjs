/**
 * 要件#58 の PLY フィクスチャ生成(一回きり)。実行: node generate-ply.mjs
 *
 * すべて同じ8点(立方体 [0,30]^3 の角)を使う。寸法 30 は STL(10)・3MF(20)・
 * OBJ(5)と違う値 — 数値そのものが「正しいローダーに渡った」ことの判定材料
 * (要件#23 の作法。docs/requirements/req-58.md「受け入れ基準」前提)。
 *
 * | ファイル | 内容 |
 * |---|---|
 * | cloud-ascii.ply        | 色なし ASCII 点群(8点・面なし) |
 * | cloud-color-ascii.ply  | 頂点色つき ASCII 点群(uchar red/green/blue + nx ny nz) |
 * | cloud-binary-le.ply    | binary_little_endian 点群(同じ8点・色なし) |
 * | cloud-binary-be.ply    | binary_big_endian 点群(同じ8点・色なし) |
 * | cube-mesh.ply          | 面ありメッシュ(8頂点・12三角形・法線/色なし) |
 * | cube-color-mesh.ply    | 面あり+頂点色つきメッシュ(同じ8頂点・12三角形・uchar red/green/blue。追補a= AC-58-20) |
 * | empty.ply              | 頂点0(element vertex 0)— 既存の失敗経路へ落ちる入力 |
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(new URL(import.meta.url)));

/** 立方体 [0,30]^3 の 8 角。 */
const POINTS = [
	[0, 0, 0],
	[30, 0, 0],
	[30, 30, 0],
	[0, 30, 0],
	[0, 0, 30],
	[30, 0, 30],
	[30, 30, 30],
	[0, 30, 30],
];

/** 立方体の 12 三角形(頂点は POINTS の添字)。 */
const FACES = [
	[0, 1, 2],
	[0, 2, 3],
	[4, 5, 6],
	[4, 6, 7],
	[0, 1, 5],
	[0, 5, 4],
	[1, 2, 6],
	[1, 6, 5],
	[2, 3, 7],
	[2, 7, 6],
	[3, 0, 4],
	[3, 4, 7],
];

// --- 色なし ASCII 点群 -------------------------------------------------------
const asciiCloud = [
	'ply',
	'format ascii 1.0',
	'comment Vellis test fixture (requirement #58): 8-point cloud, bbox [0,30]^3',
	'element vertex 8',
	'property float x',
	'property float y',
	'property float z',
	'end_header',
	...POINTS.map((p) => p.join(' ')),
	'',
].join('\n');
writeFileSync(join(HERE, 'cloud-ascii.ply'), asciiCloud);

// --- 頂点色つき ASCII 点群(Revopoint 風: x y z nx ny nz red green blue)-----
const N = (1 / Math.sqrt(3)).toFixed(6); // 中心 (15,15,15) から外向きの単位法線成分
const colorCloud = [
	'ply',
	'format ascii 1.0',
	'comment Vellis test fixture (requirement #58): colored point cloud (uchar RGB)',
	'element vertex 8',
	'property float x',
	'property float y',
	'property float z',
	'property float nx',
	'property float ny',
	'property float nz',
	'property uchar red',
	'property uchar green',
	'property uchar blue',
	'end_header',
	...POINTS.map((p) => {
		const n = p.map((v) => (v === 0 ? `-${N}` : N)).join(' ');
		const c = p.map((v) => (v === 0 ? 0 : 255)).join(' ');
		return `${p.join(' ')} ${n} ${c}`;
	}),
	'',
].join('\n');
writeFileSync(join(HERE, 'cloud-color-ascii.ply'), colorCloud);

// --- binary 点群(LE / BE・色なし・同じ8点)---------------------------------
function binaryCloud(formatLine, littleEndian) {
	const header = [
		'ply',
		`format ${formatLine} 1.0`,
		'comment Vellis test fixture (requirement #58): 8-point cloud, bbox [0,30]^3',
		'element vertex 8',
		'property float x',
		'property float y',
		'property float z',
		'end_header',
		'',
	].join('\n');
	const headerBytes = new TextEncoder().encode(header);
	const body = new ArrayBuffer(POINTS.length * 3 * 4);
	const view = new DataView(body);
	POINTS.flat().forEach((v, i) => view.setFloat32(i * 4, v, littleEndian));
	return Buffer.concat([Buffer.from(headerBytes), Buffer.from(body)]);
}
writeFileSync(join(HERE, 'cloud-binary-le.ply'), binaryCloud('binary_little_endian', true));
writeFileSync(join(HERE, 'cloud-binary-be.ply'), binaryCloud('binary_big_endian', false));

// --- 面ありメッシュ(8頂点・12三角形・法線なし)------------------------------
const meshPly = [
	'ply',
	'format ascii 1.0',
	'comment Vellis test fixture (requirement #58): cube mesh, 12 triangles, bbox [0,30]^3',
	'element vertex 8',
	'property float x',
	'property float y',
	'property float z',
	'element face 12',
	'property list uchar int vertex_indices',
	'end_header',
	...POINTS.map((p) => p.join(' ')),
	...FACES.map((f) => `3 ${f.join(' ')}`),
	'',
].join('\n');
writeFileSync(join(HERE, 'cube-mesh.ply'), meshPly);

// --- 面あり+頂点色つきメッシュ(追補a・AC-58-20 用。色は colorCloud と同じ割り当て)---
const colorMeshPly = [
	'ply',
	'format ascii 1.0',
	'comment Vellis test fixture (requirement #58 addendum a): colored cube mesh, 12 triangles, bbox [0,30]^3',
	'element vertex 8',
	'property float x',
	'property float y',
	'property float z',
	'property uchar red',
	'property uchar green',
	'property uchar blue',
	'element face 12',
	'property list uchar int vertex_indices',
	'end_header',
	...POINTS.map((p) => `${p.join(' ')} ${p.map((v) => (v === 0 ? 0 : 255)).join(' ')}`),
	...FACES.map((f) => `3 ${f.join(' ')}`),
	'',
].join('\n');
writeFileSync(join(HERE, 'cube-color-mesh.ply'), colorMeshPly);

// --- 頂点0 ------------------------------------------------------------------
const emptyPly = [
	'ply',
	'format ascii 1.0',
	'comment Vellis test fixture (requirement #58): zero vertices',
	'element vertex 0',
	'property float x',
	'property float y',
	'property float z',
	'end_header',
	'',
].join('\n');
writeFileSync(join(HERE, 'empty.ply'), emptyPly);

console.log('generated: cloud-ascii / cloud-color-ascii / cloud-binary-le / cloud-binary-be / cube-mesh / cube-color-mesh / empty (.ply)');
