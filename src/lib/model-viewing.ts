/**
 * 3D モデル(STL / 3MF)の読込と正規化(requirements.md #23 ②)。
 *
 * 「3D モデルファイル(STL・3MF)を開いたら 3D 表示し…」のうち、
 * バイト列 → 描画対象への変換をここに集める。`ModelViewer.svelte` が
 * `fetch(vellis-asset:…)` で得た ArrayBuffer をこの1本の入口に渡し、
 * 返ってきた `object` をシーンに add し、`bounds` から初期カメラを決める
 * (`image-viewing.ts` と同じく、DOM を持たない判断はすべてこちら側)。
 *
 * 形式の振り分けは拡張子で行う(`detectFileType` が `model3d` と答える2種)。
 * 中身のスニッフィングはしない — STL の ASCII / バイナリ判別だけは
 * STLLoader が自前で行う。stl / 3mf 以外で呼ばれたら reject する:
 * 呼び出し側(経路選択)のバグを黙って通さないため。
 *
 * モデルはデータとしてパースするだけでスクリプト実行面がないので、要件#8 の
 * 「スクリプトは実行しない」不変条件と矛盾しない(docs/3d-model-viewing.md §3)。
 */
import { Box3, Mesh, MeshStandardMaterial, type BufferGeometry, type Object3D } from 'three';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

/** パース結果。描画対象と、カメラ合わせ・表示情報に使う実測値。 */
export interface ParsedModel {
	/** シーンへ add する描画対象(STL は Mesh・3MF はローダーが組んだ Group)。 */
	object: Object3D;
	/** 三角形の総数。巨大メッシュの判断材料でもある。 */
	triangleCount: number;
	/** world 変換適用後のバウンディングボックス(初期カメラの収まりに使う)。 */
	bounds: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * STL の既定マテリアル。STL は色を持たない形式なので、こちらで与えるしかない
 * (3MF はファイル側の色・マテリアルをローダーが組み立てるので触らない)。
 * 無彩色・弱い金属感で、面の向きが陰影で分かる程度の粗さにしてある。
 */
function stlMaterial(): MeshStandardMaterial {
	return new MeshStandardMaterial({ color: 0xb9c0c8, metalness: 0.1, roughness: 0.65 });
}

/** 小文字の最終拡張子。`file-type.ts` の `extensionOf` と同じ規則。 */
function extensionOf(nameOrUri: string): string {
	const segment = nameOrUri.slice(nameOrUri.lastIndexOf('/') + 1);
	const dot = segment.lastIndexOf('.');
	if (dot <= 0) return '';
	return segment.slice(dot + 1).toLowerCase();
}

/** ジオメトリ1つぶんの三角形数。index 付きなら index が正。 */
function triangleCountOf(geometry: BufferGeometry): number {
	const index = geometry.getIndex();
	if (index !== null) return Math.floor(index.count / 3);
	const position = geometry.getAttribute('position');
	return position ? Math.floor(position.count / 3) : 0;
}

/**
 * 三角形数の合計と、法線の補完。
 *
 * 法線を持たない STL / 3MF はそのまま描くと真っ黒になるので、無ければここで
 * 計算する(ローダーの出力に手を入れるのはこの1点だけ)。
 */
function summarize(object: Object3D): number {
	let triangles = 0;
	object.traverse((child) => {
		const geometry = (child as Mesh).geometry as BufferGeometry | undefined;
		if (!geometry || !geometry.isBufferGeometry) return;
		if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
		triangles += triangleCountOf(geometry);
	});
	return triangles;
}

/** world 変換(3MF の build transform 等)を適用したバウンディングボックス。 */
function boundsOf(object: Object3D): ParsedModel['bounds'] {
	object.updateMatrixWorld(true);
	const box = new Box3().setFromObject(object);
	if (box.isEmpty()) throw new Error('モデルに描画できる形状がありません');
	return {
		min: [box.min.x, box.min.y, box.min.z],
		max: [box.max.x, box.max.y, box.max.z],
	};
}

/**
 * モデルのバイト列を描画対象へ変換する。
 *
 * 同期パーサ(STLLoader / ThreeMFLoader の `parse`)を Promise の中で呼ぶので、
 * 壊れたファイル(ZIP でない 3MF 等)の例外はそのまま reject になる。
 * 決定的: 同じバイト列からは必ず同じ `triangleCount` / `bounds` が出る。
 */
export async function parseModel(nameOrUri: string, buffer: ArrayBuffer): Promise<ParsedModel> {
	const extension = extensionOf(nameOrUri);
	let object: Object3D;
	switch (extension) {
		case 'stl': {
			const geometry = new STLLoader().parse(buffer);
			object = new Mesh(geometry, stlMaterial());
			break;
		}
		case '3mf':
			object = new ThreeMFLoader().parse(buffer);
			break;
		default:
			throw new Error(`3D モデルとして開けない拡張子です: ${nameOrUri}`);
	}

	const triangleCount = summarize(object);
	return { object, triangleCount, bounds: boundsOf(object) };
}
