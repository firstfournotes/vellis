/**
 * 3D 表示のカメラ操作 VM(requirements.md #23 ④ / #26)。
 *
 * 「マウスで回転(左ドラッグ)・パン(右ドラッグ)・ズーム(ホイール)ができる」の
 * 状態遷移だけをここに集める。DOM も three.js も知らない純関数で、入力ソースにも
 * 依存しない — マウス(要件#23)も SpaceMouse(要件#24)も、それぞれのイベントを
 * `CameraDelta` に変換してこの1本の入口から書き込む。`ModelViewer.svelte` は
 * 「イベント→デルタ」と「状態→three.js カメラ」の写像だけを持つ
 * (`image-viewing.ts` と `ImageViewer.svelte` の関係と同じ家風)。
 *
 * 要件#26(2026-08-20 由谷決定)で、回転は yaw/pitch の球面座標から
 * 「画面基準の3軸トラックボール」= カメラ姿勢クォータニオンへの右掛けに変わった。
 * 回転軸が常に「いま画面に見えている縦横と視線」なので、モデルをどう回した後でも
 * ドラッグの向きと回り方が一致し、天地を跨いでも極で回転が死なない(ジンバルフリー)。
 *
 * 座標系は Y-up(three.js の既定)。target を中心に、距離 `distance` だけ離れた
 * 位置から `orientation` の姿勢で見るオービットカメラ1台ぶんの状態を持つ。
 */

/**
 * オービットカメラ状態: `target` を距離 `distance` から `orientation` の向きで見る。
 *
 * `orientation` はカメラのワールド姿勢クォータニオン `[x, y, z, w]`(長さ 1)。
 * 単位クォータニオン `[0,0,0,1]` = カメラは `target + [0,0,distance]` に置かれ
 * −Z を向き、up は +Y — three.js の既定カメラそのものなので、配線側は
 * `camera.quaternion` へこの値をそのまま写せる。
 */
export interface CameraState {
	target: [number, number, number];
	distance: number;
	orientation: [number, number, number, number];
}

/**
 * 1 操作ぶんのデルタ。全フィールド任意で、省略は「変化なし」。
 *
 * 回転3軸は「カメラ(画面)基準」= 現在の姿勢のローカル軸回り(rad・右手系)。
 */
export interface CameraDelta {
	/** 画面横軸(カメラ right)回り。正でカメラは下側へ回り込む。 */
	rotateX?: number;
	/** 画面縦軸(カメラ up)回り。正でカメラは右側へ回り込む。 */
	rotateY?: number;
	/** 画面法線(視線)回りのロール。 */
	rotateZ?: number;
	/** 視平面パン(右ドラッグ / SpaceMouse の並進軸)。world 単位。 */
	panX?: number;
	panY?: number;
	/** 距離に掛ける係数(ホイール / SpaceMouse の前後)。1 = 変化なし。 */
	zoom?: number;
}

/** 距離の下限。ズームインの連打で 0 や負に落ちてカメラが裏返るのを防ぐ。 */
const MIN_DISTANCE = 1e-6;

type Quat = [number, number, number, number];
type Vec3 = [number, number, number];

/** クォータニオンの積 a ⊗ b(回転としては「a のあとに、a のローカル軸で b」)。 */
function multiply(a: Quat, b: Quat): Quat {
	const [ax, ay, az, aw] = a;
	const [bx, by, bz, bw] = b;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];
}

/** 長さ 1 に均す。長さが失われた(数値的に潰れた)ときは単位に戻す。 */
function normalize(q: Quat): Quat {
	const length = Math.hypot(q[0], q[1], q[2], q[3]);
	if (!(length > 0) || !Number.isFinite(length)) return [0, 0, 0, 1];
	return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** 基本軸(0=X, 1=Y, 2=Z)回りの角度 `angle` の回転。 */
function fromAxisAngle(axis: 0 | 1 | 2, angle: number): Quat {
	const half = angle / 2;
	const q: Quat = [0, 0, 0, Math.cos(half)];
	q[axis] = Math.sin(half);
	return q;
}

/** クォータニオンでベクトルを回す(v' = q v q*)。 */
function rotateVec(q: Quat, v: Vec3): Vec3 {
	const [qx, qy, qz, qw] = q;
	const tx = 2 * (qy * v[2] - qz * v[1]);
	const ty = 2 * (qz * v[0] - qx * v[2]);
	const tz = 2 * (qx * v[1] - qy * v[0]);
	return [
		v[0] + qw * tx + (qy * tz - qz * ty),
		v[1] + qw * ty + (qz * tx - qx * tz),
		v[2] + qw * tz + (qx * ty - qy * tx),
	];
}

/**
 * カメラ位置(world 座標)。three.js のカメラへ状態を写すための唯一の変換で、
 * `ModelViewer.svelte` はここで得た位置に置く(向きは orientation をそのまま使う)。
 *
 * 姿勢のローカル +Z はカメラの「後ろ向き」= target からカメラへの方向。
 */
export function cameraPosition(state: CameraState): Vec3 {
	const back = rotateVec(state.orientation, [0, 0, 1]);
	return [
		state.target[0] + state.distance * back[0],
		state.target[1] + state.distance * back[1],
		state.target[2] + state.distance * back[2],
	];
}

/**
 * デルタ1つぶんを適用した新しいカメラ状態を返す。
 *
 * 入力の `state` は変異させない(凍結された state でも呼べる)。
 *
 * 回転はビュー空間適用 = 姿勢への右掛け
 * `orientation' = normalize(orientation ⊗ qx ⊗ qy ⊗ qz)` — 軸が現在の姿勢に
 * ぶら下がるので「画面の横軸・縦軸・視線」で回る。合成順は X→Y→Z の固定で、
 * 1 デルタの複合回転は単軸デルタの逐次適用と一致する。
 *
 * パンは視平面内の平行移動(target だけが動く)。基底には回転を適用する前の姿勢を
 * 使う — 1 デルタ内での回転とパンは同時に起きた操作であり、順序で結果が変わらない
 * ようにする。ズームは距離への乗算なので、ホイールの連打は遠近どちらの向きも対称
 * に効く。
 */
export function applyCameraDelta(state: CameraState, delta: CameraDelta): CameraState {
	const rotateX = delta.rotateX ?? 0;
	const rotateY = delta.rotateY ?? 0;
	const rotateZ = delta.rotateZ ?? 0;

	// 回転が無いデルタでは姿勢の数値に一切触れない(正規化の丸めも入れない)。
	let orientation: Quat = [...state.orientation];
	if (rotateX !== 0 || rotateY !== 0 || rotateZ !== 0) {
		let next = orientation;
		if (rotateX !== 0) next = multiply(next, fromAxisAngle(0, rotateX));
		if (rotateY !== 0) next = multiply(next, fromAxisAngle(1, rotateY));
		if (rotateZ !== 0) next = multiply(next, fromAxisAngle(2, rotateZ));
		// 毎回均すので、何千回合成しても長さが 1 から漂わない。
		orientation = normalize(next);
	}

	const panX = delta.panX ?? 0;
	const panY = delta.panY ?? 0;
	let target: Vec3 = [state.target[0], state.target[1], state.target[2]];
	if (panX !== 0 || panY !== 0) {
		const right = rotateVec(state.orientation, [1, 0, 0]);
		const up = rotateVec(state.orientation, [0, 1, 0]);
		target = [
			target[0] + right[0] * panX + up[0] * panY,
			target[1] + right[1] * panX + up[1] * panY,
			target[2] + right[2] * panX + up[2] * panY,
		];
	}

	const distance = Math.max(state.distance * (delta.zoom ?? 1), MIN_DISTANCE);

	return { target, distance, orientation };
}
