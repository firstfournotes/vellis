/**
 * 要件#23 の受け入れテスト — カメラ操作 VM(requirements.md #23 ④)
 * 「マウスで回転(左ドラッグ)・パン(右ドラッグ)・ズーム(ホイール)ができる」の
 * 機械判定部分: 入力ソース非依存の純関数 VM(デルタ → カメラ状態)。
 *
 * 要件#26(2026-08-20 由谷決定)により、回転は yaw/pitch の球面座標から
 * 画面(カメラ)基準の3軸トラックボール=向き(クォータニオン)ベースへ仕様変更。
 * 本ファイルの回転系ケースは #26 承認の下で新契約へ更新済み。
 * パン・ズーム・純関数性のケースは従来の性質を維持している。
 * トラックボール固有の性質(画面基準・ロール・ジンバルフリー・正規化)は
 * `model-camera.trackball.acceptance.test.ts`(acceptance/#26)が判定する。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * `src/lib/model-camera.ts` に:
 *
 * ```ts
 * // オービットカメラ状態: target を距離 distance から orientation の向きで見る。
 * // orientation はカメラのワールド姿勢クォータニオン [x, y, z, w](長さ 1)。
 * // 単位クォータニオン [0,0,0,1] = カメラは target + [0,0,distance] に置かれ
 * // −Z を向き、up は +Y(three.js の既定カメラと同じ = 配線は
 * // camera.quaternion へそのまま写せる)。
 * export interface CameraState {
 *   target: [number, number, number];
 *   distance: number;
 *   orientation: [number, number, number, number];
 * }
 * // 1 操作ぶんのデルタ。全フィールド任意・省略 = 変化なし。
 * // 回転3軸は「カメラ(画面)基準」= 現在の orientation のローカル軸回り(rad・右手系)。
 * export interface CameraDelta {
 *   rotateX?: number; // 画面横軸(カメラ right)回り。正でカメラは下側へ回り込む
 *   rotateY?: number; // 画面縦軸(カメラ up)回り。正でカメラは右側へ回り込む
 *   rotateZ?: number; // 画面法線(視線)回りのロール
 *   panX?: number;    // 視平面パン(右ドラッグ / SpaceMouse tx·ty)。world 単位
 *   panY?: number;
 *   zoom?: number;    // 距離に掛ける係数(ホイール / SpaceMouse tz)。1 = 変化なし
 * }
 * export function applyCameraDelta(state: CameraState, delta: CameraDelta): CameraState;
 * export function cameraPosition(state: CameraState): [number, number, number];
 * ```
 *
 * - 純関数: 入力 state を変異させず新しい state を返す。同じ入力は同じ出力(決定性)
 * - 回転はビュー空間適用 = orientation への右掛け:
 *   orientation' = normalize(orientation ⊗ qx(rotateX) ⊗ qy(rotateY) ⊗ qz(rotateZ))
 *   (qx/qy/qz = カメラローカル X/Y/Z 軸の axis-angle。合成順序は X→Y→Z で固定
 *    = 1 デルタでの複合回転は単軸デルタの逐次適用と一致)。target・distance は不変
 * - 旧 yaw/pitch フィールドは廃止。pitch クランプも廃止(ジンバルフリー=#26 側で判定)
 * - パンは視平面内の移動: target だけが変わり、移動量の長さは hypot(panX, panY) に
 *   一致(視平面基底 = 適用前 orientation の right/up・正規直交)。向きは姿勢に追従
 * - ズームは乗算(distance × zoom)・正の下限でクランプ(0 や負に落ちない)
 * - cameraPosition(state) = target + distance × R(orientation)·[0,0,1]
 *
 * 6DoF デルタ(#24)との関係: SpaceMouse の 6 軸はこのデルタの
 * rotateX/rotateY/rotateZ/panX/panY/zoom に写像する(写像は #24 の持ち場)。
 */
import { describe, expect, test } from 'vitest';
import { applyCameraDelta, cameraPosition, type CameraState } from './model-camera';

/** 単位クォータニオン。 */
const IDENTITY: [number, number, number, number] = [0, 0, 0, 1];

/** 変異検出のため深く凍結した基準状態を毎回作る。 */
function baseState(): CameraState {
	const state: CameraState = {
		target: [1, 2, 3],
		distance: 10,
		orientation: [0, 0, 0, 1],
	};
	Object.freeze(state.target);
	Object.freeze(state.orientation);
	return Object.freeze(state);
}

/** target の変位ベクトル。 */
function displacement(before: CameraState, after: CameraState): [number, number, number] {
	return [
		after.target[0] - before.target[0],
		after.target[1] - before.target[1],
		after.target[2] - before.target[2],
	];
}

function length(v: [number, number, number]): number {
	return Math.hypot(v[0], v[1], v[2]);
}

function expectVecClose(actual: [number, number, number], expected: [number, number, number]) {
	for (const axis of [0, 1, 2] as const) {
		expect(actual[axis], `axis ${axis}`).toBeCloseTo(expected[axis], 6);
	}
}

describe('applyCameraDelta — 純関数性', () => {
	test('空デルタは同値の状態を返し、入力を変異させない', () => {
		const state = baseState();
		const next = applyCameraDelta(state, {});
		expect(next.target).toEqual([1, 2, 3]);
		expect(next.distance).toBe(10);
		expectVecClose(
			[next.orientation[0], next.orientation[1], next.orientation[2]],
			[0, 0, 0],
		);
		expect(Math.abs(next.orientation[3])).toBeCloseTo(1, 10);
		expect(state).toEqual({ target: [1, 2, 3], distance: 10, orientation: IDENTITY });
	});

	test('決定性: 同じ入力からは同じ出力', () => {
		const delta = { rotateX: 0.4, rotateY: -0.1, rotateZ: 0.2, panX: 2, panY: -1, zoom: 0.8 };
		const a = applyCameraDelta(baseState(), delta);
		const b = applyCameraDelta(baseState(), delta);
		expect(a).toEqual(b);
	});

	test('凍結済み state への適用でも入力は不変(新しい state を返す)', () => {
		const state = baseState();
		applyCameraDelta(state, { rotateX: 1, rotateZ: 0.5, panX: 5, zoom: 2 });
		expect(state).toEqual({ target: [1, 2, 3], distance: 10, orientation: IDENTITY });
	});
});

describe('applyCameraDelta — 回転(左ドラッグ)', () => {
	test('回転デルタは orientation だけを変える(target・distance は不変)', () => {
		const next = applyCameraDelta(baseState(), { rotateX: 0.5, rotateY: -0.15, rotateZ: 0.2 });
		expect(next.target).toEqual([1, 2, 3]);
		expect(next.distance).toBe(10);
		expect(next.orientation).not.toEqual(IDENTITY);
	});

	test('rotateY(画面縦軸)a: 単位姿勢からカメラは水平に a だけ回り込む', () => {
		const a = 0.4;
		const next = applyCameraDelta(baseState(), { rotateY: a });
		expectVecClose(cameraPosition(next), [
			1 + 10 * Math.sin(a),
			2,
			3 + 10 * Math.cos(a),
		]);
	});

	test('rotateX(画面横軸)a: 単位姿勢からカメラは垂直面内で a だけ下側へ回り込む', () => {
		const a = 0.3;
		const next = applyCameraDelta(baseState(), { rotateX: a });
		expectVecClose(cameraPosition(next), [
			1,
			2 - 10 * Math.sin(a),
			3 + 10 * Math.cos(a),
		]);
	});

	test('rotateZ(ロール)は cameraPosition を変えない(視線回りの回転)', () => {
		const state = baseState();
		const next = applyCameraDelta(state, { rotateZ: 1.2 });
		expectVecClose(cameraPosition(next), cameraPosition(state));
		expect(next.orientation).not.toEqual(IDENTITY);
	});

	test('複合回転の合成順序は X→Y→Z の逐次適用と一致(決定的な固定順序)', () => {
		const combined = applyCameraDelta(baseState(), { rotateX: 0.3, rotateY: -0.5, rotateZ: 0.7 });
		let sequential = applyCameraDelta(baseState(), { rotateX: 0.3 });
		sequential = applyCameraDelta(sequential, { rotateY: -0.5 });
		sequential = applyCameraDelta(sequential, { rotateZ: 0.7 });
		expectVecClose(cameraPosition(combined), cameraPosition(sequential));
		for (const i of [0, 1, 2, 3] as const) {
			expect(Math.abs(combined.orientation[i]), `q[${i}]`).toBeCloseTo(
				Math.abs(sequential.orientation[i]),
				6,
			);
		}
	});
});

describe('applyCameraDelta — パン(右ドラッグ)', () => {
	test('target だけが動き、姿勢と距離は変わらない', () => {
		const state = baseState();
		const next = applyCameraDelta(state, { panX: 3, panY: 4 });
		expect(next.orientation).toEqual(state.orientation);
		expect(next.distance).toBe(state.distance);
		expect(next.target).not.toEqual(state.target);
	});

	test('移動量の長さは hypot(panX, panY)(視平面基底は正規直交)', () => {
		const state = baseState();
		const next = applyCameraDelta(state, { panX: 3, panY: 4 });
		expect(length(displacement(state, next))).toBeCloseTo(5, 6);
	});

	test('移動の向きは姿勢に追従する: 画面縦軸で π 回すと panX の変位が反転する', () => {
		const front = baseState();
		const back = applyCameraDelta(baseState(), { rotateY: Math.PI });
		const dispFront = displacement(front, applyCameraDelta(front, { panX: 2 }));
		const dispBack = displacement(back, applyCameraDelta(back, { panX: 2 }));
		for (const axis of [0, 1, 2] as const) {
			expect(dispBack[axis], `axis ${axis}`).toBeCloseTo(-dispFront[axis], 6);
		}
	});
});

describe('applyCameraDelta — ズーム(ホイール)', () => {
	test('distance に係数が掛かり、target と姿勢は変わらない', () => {
		const state = baseState();
		const next = applyCameraDelta(state, { zoom: 0.5 });
		expect(next.distance).toBeCloseTo(5, 10);
		expect(next.target).toEqual([1, 2, 3]);
		expect(next.orientation).toEqual(state.orientation);
	});

	test('連打は乗算で合成される(0.5 × 0.5 = 0.25 倍)', () => {
		const once = applyCameraDelta(baseState(), { zoom: 0.5 });
		const twice = applyCameraDelta(once, { zoom: 0.5 });
		expect(twice.distance).toBeCloseTo(2.5, 10);
	});

	test('ズームアウト側(係数 > 1)も対称に効く', () => {
		const next = applyCameraDelta(baseState(), { zoom: 2 });
		expect(next.distance).toBeCloseTo(20, 10);
	});

	test('係数 0 でも距離は正の下限でクランプ(カメラが裏返らない)', () => {
		const next = applyCameraDelta(baseState(), { zoom: 0 });
		expect(next.distance).toBeGreaterThan(0);
	});
});

describe('applyCameraDelta — 複合デルタ(SpaceMouse は全軸同時に来る)', () => {
	test('回転・パン・ズームが 1 デルタで同時に適用される', () => {
		const state = baseState();
		const next = applyCameraDelta(state, { rotateY: 0.1, panX: 1, zoom: 0.5 });
		expect(next.orientation).not.toEqual(IDENTITY);
		expect(next.distance).toBeCloseTo(5, 10);
		expect(next.target).not.toEqual(state.target);
	});
});
