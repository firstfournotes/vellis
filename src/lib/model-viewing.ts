/**
 * 3D モデル(STL / 3MF / OBJ / PLY)の読込と正規化(requirements.md #23 ②・#57 ②・#58 ②)。
 *
 * 「3D モデルファイル(STL・3MF)を開いたら 3D 表示し…」のうち、
 * バイト列 → 描画対象への変換をここに集める。`ModelViewer.svelte` が
 * `fetch(vellis-asset:…)` で得た ArrayBuffer をこの1本の入口に渡し、
 * 返ってきた `object` をシーンに add し、`bounds` から初期カメラを決める
 * (`image-viewing.ts` と同じく、DOM を持たない判断はすべてこちら側)。
 *
 * 形式の振り分けは拡張子で行う(`detectFileType` が `model3d` と答える4種)。
 * 中身のスニッフィングはしない — STL の ASCII / バイナリ判別と PLY の
 * ascii / binary_little_endian / binary_big_endian の判別は、それぞれ
 * STLLoader / PLYLoader がヘッダを見て自前で行う。stl / 3mf / obj / ply 以外で
 * 呼ばれたら reject する: 呼び出し側(経路選択)のバグを黙って通さないため。
 *
 * 描画対象は三角形メッシュとはかぎらない(要件#58)。PLY は点群が主用途で、
 * 面(`face` 要素)を持たないファイルは `Points` として描く。種別は戻り値の
 * `kind` が持ち、三角形数・法線の補完はメッシュのときだけ意味を持つ。
 *
 * モデルはデータとしてパースするだけでスクリプト実行面がないので、要件#8 の
 * 「スクリプトは実行しない」不変条件と矛盾しない(docs/3d-model-viewing.md §3)。
 */
import {
	Box3,
	Mesh,
	MeshStandardMaterial,
	Points,
	PointsMaterial,
	type BufferGeometry,
	type Object3D,
} from 'three';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

/** パース結果。描画対象と、カメラ合わせ・表示情報に使う実測値。 */
export interface ParsedModel {
	/** シーンへ add する描画対象(STL / 面あり PLY は Mesh・3MF / OBJ はローダーが組んだ Group・面なし PLY は Points)。 */
	object: Object3D;
	/** 三角形の総数。巨大メッシュの判断材料でもある。点群では 0(要件#58 ④)。 */
	triangleCount: number;
	/** world 変換適用後のバウンディングボックス(初期カメラの収まりに使う)。 */
	bounds: { min: [number, number, number]; max: [number, number, number] };
	/**
	 * 描画対象の種別(要件#58 ④)。`parseModel` は形式によらず必ず埋めるが、
	 * 既存の呼び出し側の型を壊さないため optional にしてある。
	 */
	kind?: 'mesh' | 'points';
	/** 頂点(点)の数。`kind` によらず頂点数(要件#58 ④)。同じく必ず埋まる。 */
	pointCount?: number;
}

/**
 * STL / OBJ の既定マテリアル。STL は色を持たない形式なので、こちらで与えるしかない
 * (3MF はファイル側の色・マテリアルをローダーが組み立てるので触らない)。
 * 無彩色・弱い金属感で、面の向きが陰影で分かる程度の粗さにしてある。
 *
 * OBJ も同じ値を使う(要件#57 ③)。材質は隣の `.mtl` にあり初版では読まないので、
 * 見た目を STL と揃え、要件#23 の三灯ライティングとの相性を既知の値に固定する。
 */
function stlMaterial(): MeshStandardMaterial {
	return new MeshStandardMaterial({ color: 0xb9c0c8, metalness: 0.1, roughness: 0.65 });
}

/**
 * 点群の既定マテリアル(要件#58 ③)。
 *
 * `PointsMaterial` は無照明なので、`ModelViewer` の三灯ライティングは点群に
 * 効かない — 点に面の向きは無いので、効かないことが正しい。
 *
 * 大きさは**画面ピクセル固定の 2px**(`sizeAttenuation: false`)。three.js は
 * `size × devicePixelRatio` を `gl_PointSize` に渡すので Retina でも見かけは
 * 2 CSS ピクセルになる。距離減衰を入れると寄ったときに点が巨大化し、引くと
 * 消えてしまうので採らない(起案時判断 (c))。点サイズの UI は初版では出さない。
 *
 * 色はファイル側の頂点色があればそれを使い(`vertexColors`)、無ければ STL と
 * 同じ無彩色の単色で描く。three.js の最終色は「マテリアル色 × 頂点色」なので、
 * 頂点色を使うときはマテリアル色を白にしてファイル側の色をそのまま出す(追補a)。
 */
function pointCloudMaterial(vertexColors: boolean): PointsMaterial {
	return new PointsMaterial({
		color: vertexColors ? 0xffffff : 0xb9c0c8,
		size: 2,
		sizeAttenuation: false,
		vertexColors,
	});
}

/**
 * PLYLoader が「バイト列」と認めるバッファに揃える(要件#58 ②)。
 *
 * `PLYLoader.parse` は入口で **`data instanceof ArrayBuffer`** を見て、偽なら
 * 引数を ASCII の文字列として扱う(STLLoader の `typeof data === 'string'` と
 * 違い、この判定は realm をまたぐと通らない)。別 realm で作られた ArrayBuffer —
 * jsdom を混ぜた実行環境や、別 window から渡ってきたバッファ — をそのまま渡すと、
 * 例外も警告も出さずに**頂点0のジオメトリ**が返り、「壊れたファイル」と区別が
 * つかなくなる。
 *
 * そこで、判定が通らないバッファのときだけ自 realm へ写し取る。通常の経路
 * (`fetch(...).arrayBuffer()`)は同じ realm なのでそのまま素通りし、百万点規模の
 * バッファを無駄にコピーすることはない。
 */
function sameRealmBuffer(buffer: ArrayBuffer): ArrayBuffer {
	if (buffer instanceof ArrayBuffer) return buffer;
	const source = new Uint8Array(buffer);
	const copy = new ArrayBuffer(source.byteLength);
	new Uint8Array(copy).set(source);
	return copy;
}

/**
 * PLY の `BufferGeometry` を描画対象へ包む(要件#58 ②③)。
 *
 * `PLYLoader.parse` は STLLoader と同じく `BufferGeometry` を返すだけなので、
 * メッシュか点群かをここで決める。判定材料は **index の有無** ―― PLYLoader は
 * `face` 要素があるときだけ index を立てるので、これが「面を持つファイルか」
 * そのものの答えになる(中身のスニッフィングは要らない)。
 *
 * 頂点色は `color` 属性の有無だけを見る。`red/green/blue`・`r/g/b`・
 * `diffuse_red` 系という綴りの揺れも、uchar / float という型の違いも、
 * ローダーが吸収して1つの属性に載せてくれる(sRGB → 作業色空間の変換も
 * PLYLoader 側が済ませる= 起案時判断 (g))。
 */
function wrapPlyGeometry(geometry: BufferGeometry): { object: Object3D; kind: 'mesh' | 'points' } {
	const vertexColors = geometry.getAttribute('color') !== undefined;
	if (geometry.getIndex() === null) {
		return { object: new Points(geometry, pointCloudMaterial(vertexColors)), kind: 'points' };
	}
	const material = stlMaterial();
	if (vertexColors) {
		// 点群と同じく、頂点色を既定色で乗算させない(追補a)
		material.color.setHex(0xffffff);
		material.vertexColors = true;
	}
	return { object: new Mesh(geometry, material), kind: 'mesh' };
}

/**
 * OBJLoader が実際に解釈するキーワード(要件#57 ⑤)。
 *
 * `v` は `vn` / `vt` も同じ枝で捌かれる。`usemap` はローダーが警告して無視する。
 */
const OBJ_KEYWORDS = new Set([
	'v',
	'vn',
	'vt',
	'f',
	'l',
	'p',
	'o',
	'g',
	's',
	'usemtl',
	'mtllib',
	'usemap',
]);

/**
 * 未知のキーワード行を落としてから OBJLoader に渡す(要件#57 ⑤)。
 *
 * OBJLoader は行を**先頭1文字**で振り分ける。そのため `foobar 1 2 3` のような
 * 未知のキーワード行が「面(`f`)」の枝に落ち、`parseInt('oobar')` = NaN の
 * 頂点を持つ多角形として取り込まれてしまう(三角形数が増え、bounds が NaN に
 * なって初期カメラまで壊れる)。契約は「未知の行は読み飛ばし、読める面はその
 * ぶんを表示する」なので、先頭トークンがローダーの知るキーワードでない行を
 * ここで捨てる。コメント(`#`)と空行はローダー側の扱いに任せてそのまま通す。
 *
 * 行の正規化(CRLF と `\` の行継続)は OBJLoader と同じ順序で先に済ませる —
 * 継続行の後半を単独の未知行と誤判定しないため。
 */
function sanitizeObjSource(text: string): string {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/\\\n/g, '')
		.split('\n')
		.filter((line) => {
			const trimmed = line.trimStart();
			if (trimmed.length === 0 || trimmed.startsWith('#')) return true;
			return OBJ_KEYWORDS.has(trimmed.split(/\s+/, 1)[0]);
		})
		.join('\n');
}

/**
 * OBJLoader の出力を Vellis の描画方針に合わせる(要件#57 ②③⑤)。
 *
 * 1. **材質**= 面(`Mesh`)のマテリアルを STL と同じ単色に差し替える。OBJLoader の
 *    既定は `MeshPhongMaterial` で、`usemtl` があれば名前ごとに別インスタンスが
 *    付くが、`.mtl` を読まない初版では中身が空の器でしかない。差し替えた側は
 *    もう誰も参照しないので dispose する。
 * 2. **縮退**= 面が1つも無ければ中身を捨てる。OBJLoader は面も線も無いファイルを
 *    「点群」と解釈して `v` 行を `Points` にするが、本要件の対象は面のある OBJ
 *    なので、頂点だけ・コメントだけ・空ファイルは既存の失敗経路
 *    (`boundsOf` の「The model has no drawable geometry」)へ落とす。
 *    面があるファイルの `l` / `p` はローダーの出力のまま残す。
 */
function normalizeObj(group: Object3D): Object3D {
	let hasFaces = false;
	group.traverse((child) => {
		const mesh = child as Mesh;
		if (!mesh.isMesh) return;
		hasFaces = true;
		const previous = mesh.material;
		mesh.material = stlMaterial();
		for (const material of Array.isArray(previous) ? previous : [previous]) material?.dispose();
	});
	if (!hasFaces) group.clear();
	return group;
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
 * 三角形数と頂点数の合計、および法線の補完。
 *
 * 法線を持たない STL / 3MF はそのまま描くと真っ黒になるので、無ければここで
 * 計算する(ローダーの出力に手を入れるのはこの1点だけ)。
 *
 * **点群(`Points`)は数えも計算もしない**(要件#58 ②④)。面が無いので
 * `triangleCountOf` の「index が無ければ `position.count / 3`」という
 * フォールバックは意味を持たず、通すと 100 万点が 33 万三角形として表示されて
 * しまう。法線も、無照明で描く以上ただの待ち時間にしかならない(百万点)。
 * 頂点数だけは描画対象の種別によらず数える。
 */
function summarize(object: Object3D): { triangleCount: number; pointCount: number } {
	let triangles = 0;
	let points = 0;
	object.traverse((child) => {
		const geometry = (child as Mesh).geometry as BufferGeometry | undefined;
		if (!geometry || !geometry.isBufferGeometry) return;
		points += geometry.getAttribute('position')?.count ?? 0;
		if ((child as Points).isPoints) return;
		if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
		triangles += triangleCountOf(geometry);
	});
	return { triangleCount: triangles, pointCount: points };
}

/**
 * ツールバーに出す表示情報(要件#58 ④)。
 *
 * 点群に三角形は無く、メッシュの点数は見ても意味が薄いので、`kind` で出し分ける。
 * DOM を持たない判断なのでここに置き、`ModelViewer` は文字列を貼るだけにする。
 * 文言は英語(要件#51)・3桁区切り・単複の出し分けはしない(既存の `triangles`
 * と同じ規約)。区切りはロケールに揺れないよう `en-US` で固定する。
 */
export function modelStatsLabel(parsed: ParsedModel): string {
	if (parsed.kind === 'points') {
		return `${(parsed.pointCount ?? 0).toLocaleString('en-US')} points`;
	}
	return `${parsed.triangleCount.toLocaleString('en-US')} triangles`;
}

/** world 変換(3MF の build transform 等)を適用したバウンディングボックス。 */
function boundsOf(object: Object3D): ParsedModel['bounds'] {
	object.updateMatrixWorld(true);
	const box = new Box3().setFromObject(object);
	if (box.isEmpty()) throw new Error('The model has no drawable geometry');
	return {
		min: [box.min.x, box.min.y, box.min.z],
		max: [box.max.x, box.max.y, box.max.z],
	};
}

/**
 * モデルのバイト列を描画対象へ変換する。
 *
 * 同期パーサ(STLLoader / ThreeMFLoader / OBJLoader / PLYLoader の `parse`)を Promise の
 * 中で呼ぶので、壊れたファイル(ZIP でない 3MF 等)の例外はそのまま reject になる。
 * 決定的: 同じバイト列からは必ず同じ `kind` / `pointCount` / `triangleCount` / `bounds` が出る。
 */
export async function parseModel(nameOrUri: string, buffer: ArrayBuffer): Promise<ParsedModel> {
	const extension = extensionOf(nameOrUri);
	let object: Object3D;
	/** 描画対象の種別。面を持たない PLY だけが 'points' になる(要件#58 ④)。 */
	let kind: 'mesh' | 'points' = 'mesh';
	switch (extension) {
		case 'stl': {
			const geometry = new STLLoader().parse(buffer);
			object = new Mesh(geometry, stlMaterial());
			break;
		}
		case '3mf':
			object = new ThreeMFLoader().parse(buffer);
			break;
		case 'obj': {
			// OBJ はテキスト形式で、OBJLoader.parse は文字列を取る(STL / 3MF は
			// ArrayBuffer)。壊れたバイトは置換文字にして読み進む(fatal: false)—
			// その行は未知の行として読み飛ばされ、読める面はそのまま残る(要件#57 ⑤)。
			const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
			object = normalizeObj(new OBJLoader().parse(sanitizeObjSource(text)));
			break;
		}
		case 'ply': {
			// PLYLoader はヘッダの `format` を見て ascii / binary_little_endian /
			// binary_big_endian を自動判別する(要件#58 ②)。返るのは BufferGeometry
			// なので、メッシュか点群かを決めて包むのはこちらの持ち場。
			const wrapped = wrapPlyGeometry(new PLYLoader().parse(sameRealmBuffer(buffer)));
			object = wrapped.object;
			kind = wrapped.kind;
			break;
		}
		default:
			throw new Error(`Not a supported 3D model extension: ${nameOrUri}`);
	}

	const { triangleCount, pointCount } = summarize(object);
	return { object, triangleCount, bounds: boundsOf(object), kind, pointCount };
}
