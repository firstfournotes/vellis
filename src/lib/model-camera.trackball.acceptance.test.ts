/**
 * 要件#26 の受け入れテスト — 画面基準3軸トラックボール回転(requirements.md #26)
 * 「3D ビューアのカメラ回転を画面基準の3軸トラックボールへ変更する。
 *  マウスドラッグ回転も同方式に統一」の機械判定部分。
 *
 * 契約の全文は `model-camera.acceptance.test.ts`(#23 改)のヘッダを正とする。
 * 本ファイルはトラックボール化で新たに固定される性質だけを判定する:
 * - cameraPosition = target + distance × R(orientation)·[0,0,1] の関係
 * - 回転デルタのビュー空間適用(= orientation への右掛け)。ヨー後・ロール後の
 *   rotateX が世界軸ではなく「そのとき画面に見えている横軸」で効くこと
 * - ロールが機能する(up ベクトルが回る)こと
 * - パンがロール後も画面基準軸に追従すること
 * - ジンバルロックしない(旧 pitch ±π/2 クランプの廃止 = 天地を跨いで回り続ける)
 * - クォータニオンの正規化(多数回合成しても長さ 1 のまま数値ドリフトしない)
 *
 * マウスドラッグ・SpaceMouse からこのデルタへの配線は reviewer 照合
 * (SpaceMouse の軸写像は spacemouse.acceptance.test.ts が判定)。
 * 回転方向の実感(符号が体に合うか)は人間ゲート。
 */
import { describe, expect, test } from 'vitest';
import { applyCameraDelta, cameraPosition, type CameraState } from './model-camera';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

/** テスト側の独立実装: クォータニオン [x,y,z,w] でベクトルを回す(v' = q v q*)。 */
function rotateVec(q: Quat, v: Vec3): Vec3 {
	const [qx, qy, qz, qw] = q;
	// t = 2 (q_vec × v)
	const tx = 2 * (qy * v[2] - qz * v[1]);
	const ty = 2 * (qz * v[0] - qx * v[2]);
	const tz = 2 * (qx * v[1] - qy * v[0]);
	// v' = v + w t + q_vec × t
	return [
		v[0] + qw * tx + (qy * tz - qz * ty),
		v[1] + qw * ty + (qz * tx - qx * tz),
		v[2] + qw * tz + (qx * ty - qy * tx),
	];
}

function quatLength(q: Quat): number {
	return Math.hypot(q[0], q[1], q[2], q[3]);
}

/** state の up ベクトル(world)。ロールの観測に使う。 */
function upVector(state: CameraState): Vec3 {
	return rotateVec(state.orientation, [0, 1, 0]);
}

function baseState(): CameraState {
	const state: CameraState = {
		target: [0, 0, 0],
		distance: 10,
		orientation: [0, 0, 0, 1],
	};
	Object.freeze(state.target);
	Object.freeze(state.orientation);
	return Object.freeze(state);
}

function expectVecClose(actual: Vec3, expected: Vec3, digits = 6) {
	for (const axis of [0, 1, 2] as const) {
		expect(actual[axis], `axis ${axis}`).toBeCloseTo(expected[axis], digits);
	}
}

describe('トラックボール — orientation と cameraPosition の関係', () => {
	test('cameraPosition = target + distance × R(orientation)·[0,0,1](組み立てた状態で検算)', () => {
		let state = applyCameraDelta(baseState(), { rotateX: 0.7, rotateY: -1.1 });
		state = applyCameraDelta(state, { rotateZ: 0.4, rotateX: 0.2, panX: 3, panY: -2 });
		const back = rotateVec(state.orientation, [0, 0, 1]);
		expectVecClose(cameraPosition(state), [
			state.target[0] + state.distance * back[0],
			state.target[1] + state.distance * back[1],
			state.target[2] + state.distance * back[2],
		]);
	});
});

describe('トラックボール — 回転はビュー空間(画面基準)で効く', () => {
	test('画面縦軸で 90° 回した後の rotateX も「画面の上下傾き」になる(垂直変位が単位姿勢時と同じ)', () => {
		const a = 0.3;
		const fromIdentity = applyCameraDelta(baseState(), { rotateX: a });
		const yawed = applyCameraDelta(baseState(), { rotateY: Math.PI / 2 });
		const thenTilted = applyCameraDelta(yawed, { rotateX: a });
		// 単位姿勢: y は -d·sin(a) 下がる。ヨー後も画面横軸回転なら同じだけ下がる。
		expect(cameraPosition(fromIdentity)[1]).toBeCloseTo(-10 * Math.sin(a), 6);
		expect(cameraPosition(thenTilted)[1]).toBeCloseTo(-10 * Math.sin(a), 6);
		// 世界 X 軸回転(左掛け)の誤実装だと yawed のカメラ([d,0,0])は
		// 世界 X 軸上にあり y が動かない — それを棄却する。
		expect(Math.abs(cameraPosition(thenTilted)[1])).toBeGreaterThan(1);
	});

	test('ロール 90° 後の rotateX は回った後の画面横軸で効く(変位が ±X 方向へ移る)', () => {
		const a = 0.3;
		const rolled = applyCameraDelta(baseState(), { rotateZ: Math.PI / 2 });
		const thenTilted = applyCameraDelta(rolled, { rotateX: a });
		const pos = cameraPosition(thenTilted);
		// ロールで画面の縦横が入れ替わっているので、傾きは world Y ではなく world X に出る
		expect(pos[1]).toBeCloseTo(0, 6);
		expect(Math.abs(pos[0])).toBeCloseTo(10 * Math.sin(a), 6);
	});
});

describe('トラックボール — ロール(画面法線回転)が機能する', () => {
	test('rotateZ 90° で up ベクトルが 90° 回り、カメラ位置は変わらない', () => {
		const state = baseState();
		const rolled = applyCameraDelta(state, { rotateZ: Math.PI / 2 });
		expectVecClose(cameraPosition(rolled), cameraPosition(state));
		// 視線(+Z back)回りの右手回転: up (0,1,0) → (-1,0,0)
		expectVecClose(upVector(rolled), [-1, 0, 0]);
	});

	test('ロールは往復すると元に戻る(rotateZ a → −a)', () => {
		const there = applyCameraDelta(baseState(), { rotateZ: 0.8 });
		const back = applyCameraDelta(there, { rotateZ: -0.8 });
		expectVecClose(upVector(back), [0, 1, 0]);
	});
});

describe('トラックボール — パンはロール後も画面基準軸に追従する', () => {
	test('ロール 90° 後の panX は world +Y 方向へ動く(画面の「右」が回っている)', () => {
		const rolled = applyCameraDelta(baseState(), { rotateZ: Math.PI / 2 });
		const panned = applyCameraDelta(rolled, { panX: 2 });
		const disp: Vec3 = [
			panned.target[0] - rolled.target[0],
			panned.target[1] - rolled.target[1],
			panned.target[2] - rolled.target[2],
		];
		// 画面右 = R(orientation)·[1,0,0] = ロール 90° で (0,1,0)
		expectVecClose(disp, [0, 2, 0]);
	});
});

describe('トラックボール — ジンバルロックしない(旧 pitch クランプの廃止)', () => {
	test('rotateX 90° を 2 回で天地を跨いで真後ろへ抜ける(旧仕様ならクランプで止まる)', () => {
		let state = baseState();
		state = applyCameraDelta(state, { rotateX: Math.PI / 2 });
		state = applyCameraDelta(state, { rotateX: Math.PI / 2 });
		// 単位姿勢(カメラ +Z)から縦に 180°: カメラは −Z 側・上下反転
		expectVecClose(cameraPosition(state), [0, 0, -10]);
		expectVecClose(upVector(state), [0, -1, 0]);
	});

	test('rotateX 90° を 4 回で一周して元の位置・姿勢に戻る(回転が退化しない)', () => {
		let state = baseState();
		for (let i = 0; i < 4; i++) {
			state = applyCameraDelta(state, { rotateX: Math.PI / 2 });
		}
		expectVecClose(cameraPosition(state), cameraPosition(baseState()));
		expectVecClose(upVector(state), [0, 1, 0]);
	});

	test('真上通過の前後で rotateY(画面縦軸)が効き続ける(極で回転が死なない)', () => {
		// 真上付近(rotateX ≈ −90° でカメラは頭上)へ持っていってから縦軸回転
		let state = applyCameraDelta(baseState(), { rotateX: -Math.PI / 2 });
		const before = cameraPosition(state);
		state = applyCameraDelta(state, { rotateY: 0.5 });
		const after = cameraPosition(state);
		const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
		expect(moved).toBeGreaterThan(1);
	});
});

describe('トラックボール — 正規化(数値ドリフトしない)', () => {
	test('小さな複合回転を 5000 回合成しても orientation の長さは 1 のまま', () => {
		let state = baseState();
		for (let i = 0; i < 5000; i++) {
			state = applyCameraDelta(state, { rotateX: 0.013, rotateY: 0.007, rotateZ: 0.011 });
		}
		expect(quatLength(state.orientation)).toBeCloseTo(1, 6);
		expect(state.distance).toBe(10);
		const pos = cameraPosition(state);
		for (const axis of [0, 1, 2] as const) {
			expect(Number.isFinite(pos[axis])).toBe(true);
		}
		// カメラは相変わらず target から distance の距離にいる(姿勢が汚れていない)
		expect(Math.hypot(pos[0], pos[1], pos[2])).toBeCloseTo(10, 5);
	});
});
