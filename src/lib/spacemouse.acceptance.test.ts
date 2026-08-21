/**
 * 要件#24 の受け入れテスト — 6DoF 軸値 → CameraDelta 写像(フロント層)
 * 「3D モデル表示(要件#23)を 3Dconnexion SpaceMouse(6DoF)で操作できる
 *  (回転・パン・ズーム)」の機械判定部分: 生 6 軸値をカメラ VM
 * (model-camera.ts の applyCameraDelta)へ流し込むデルタに変換する純関数。
 *
 * 要件#26(2026-08-20 由谷決定)により回転写像を画面基準3軸トラックボールの
 * 新デルタ(rotateX/rotateY/rotateZ)へ更新済み。従来無視していた ry を
 * ロールとして使用する。パン・ズーム・デッドゾーン・感度のケースは不変。
 *
 * HID/SDK レポート → 6 軸値のデコードは Rust 側が担い、Tauri イベントの listen と
 * ModelViewer.svelte への配線は reviewer 照合。操作の方向・感度の実感と
 * 3DxWare 併存挙動は人間ゲート。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * `src/lib/spacemouse.ts` に:
 *
 * ```ts
 * // Rust が emit する 1 イベントぶんの生 6 軸値(素通し・概ね ±350)
 * export interface SpaceMouseAxes {
 *   tx: number; ty: number; tz: number; // 並進
 *   rx: number; ry: number; rz: number; // 回転
 * }
 * export interface SpaceMouseOptions {
 *   deadzone?: number;           // 生値単位。既定 10
 *   rotateSensitivity?: number;  // フル倒し 1 イベントの回転量(rad)。既定 > 0
 *   panSensitivity?: number;     // フル倒し 1 イベントのパン量。既定 > 0
 *   zoomSensitivity?: number;    // フル倒し 1 イベントの log(zoom)。既定 > 0
 * }
 * export function spaceMouseToCameraDelta(
 *   axes: SpaceMouseAxes,
 *   options?: SpaceMouseOptions,
 * ): CameraDelta; // 全フィールド確定値で返す(zoom は 1 = 変化なし)
 * ```
 *
 * 写像の確定仕様(このテストが固定する):
 * - 正規化: フルスケール 350(SpaceMouse Wireless の実効レンジ)。
 *   norm(v) = 0(|v| <= deadzone のとき)/
 *   sign(v) × (|v| − deadzone) / (350 − deadzone)(それ以外・±1 にクランプ)
 *   — デッドゾーン境界で連続(閾値を跨いだ瞬間に値が跳ねない)
 * - 並進: panX = −norm(tx) × panSensitivity・panY = norm(ty) × panSensitivity
 *   (2026-08-20 由谷実機判定で両軸反転済み・#26 でも不変)
 * - ズーム: zoom = exp(norm(tz) × zoomSensitivity)= 指数写像。
 *   ゼロ入力で 1・±対称(zoom(v) × zoom(−v) = 1)= applyCameraDelta の
 *   乗算合成と整合(押し引きで往復したら元の距離に戻る)
 * - 回転(#26 更新・画面基準トラックボール):
 *   rotateX = −norm(rx) × rotateSensitivity(キャップを向こうに倒す=画面横軸回転)
 *   rotateY = norm(rz) × rotateSensitivity(キャップを横に倒す=画面縦軸回転)
 *   rotateZ = norm(ry) × rotateSensitivity(キャップをひねる=画面法線ロール。
 *   従来無視→使用)
 *   軸対応の根拠: #25 で切り替えた 3Dconnexion SDK は Y-up 軸規約
 *   (rx=前後チルト・ry=垂直軸ひねり・rz=横倒し)で軸値を届ける。旧写像
 *   rz→yaw が実機で「横に倒すと世界垂直軸で回る」挙動だったこととも整合。
 *   rotateX の負符号は旧 rx→pitch(+)の実機で確認済みの操作感
 *   (向こうに倒す→モデルが前に転がる=カメラが上へ回り込む)を新 VM の
 *   符号規約(rotateX 正=カメラ下降)の下で維持するため。
 * - 純関数: 入力を変異させない・同じ入力は同じ出力
 * - 符号・軸対応の既定は上記で固定する。実機の操作感で逆と分かった軸は要件側で
 *   仕様を直してからテストを更新する(実装の周回では書き換えない)
 */
import { describe, expect, test } from 'vitest';
import { applyCameraDelta, type CameraState } from './model-camera';
import { spaceMouseToCameraDelta, type SpaceMouseAxes } from './spacemouse';

const FULL_SCALE = 350;
const DEFAULT_DEADZONE = 10;

/** 全軸ゼロを基準に一部だけ指定する。凍結して純関数性(非変異)も同時に検査。 */
function axes(partial: Partial<SpaceMouseAxes> = {}): SpaceMouseAxes {
	return Object.freeze({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, ...partial });
}

/** デッドゾーン d・フルスケール 350 での期待正規化値。 */
function norm(v: number, d: number): number {
	if (Math.abs(v) <= d) return 0;
	const n = (Math.sign(v) * (Math.abs(v) - d)) / (FULL_SCALE - d);
	return Math.max(-1, Math.min(1, n));
}

/** 凍結した基準カメラ状態(#26 の向きベース契約)。 */
function frozenState(): CameraState {
	const state: CameraState = {
		target: [1, 2, 3],
		distance: 10,
		orientation: [0, 0, 0, 1],
	};
	Object.freeze(state.target);
	Object.freeze(state.orientation);
	return Object.freeze(state);
}

describe('spaceMouseToCameraDelta — ゼロ入力・デッドゾーン', () => {
	test('ゼロ入力はゼロデルタ(zoom は 1)', () => {
		const delta = spaceMouseToCameraDelta(axes());
		expect(delta.rotateX ?? 0).toBe(0);
		expect(delta.rotateY ?? 0).toBe(0);
		expect(delta.rotateZ ?? 0).toBe(0);
		expect(delta.panX ?? 0).toBe(0);
		expect(delta.panY ?? 0).toBe(0);
		expect(delta.zoom ?? 1).toBe(1);
	});

	test('ゼロデルタを applyCameraDelta に流すと状態が変わらない', () => {
		const state = frozenState();
		const after = applyCameraDelta(state, spaceMouseToCameraDelta(axes()));
		expect(after.target).toEqual([1, 2, 3]);
		expect(after.distance).toBe(10);
		expect(after.orientation[3]).toBeCloseTo(1, 10);
	});

	test('既定デッドゾーン(10)以下の微小入力は全軸ゼロに丸める(静止時ノイズ対策)', () => {
		const delta = spaceMouseToCameraDelta(
			axes({ tx: 5, ty: -5, tz: 10, rx: -10, ry: 3, rz: 7 }),
		);
		expect(delta.rotateX ?? 0).toBe(0);
		expect(delta.rotateY ?? 0).toBe(0);
		expect(delta.rotateZ ?? 0).toBe(0);
		expect(delta.panX ?? 0).toBe(0);
		expect(delta.panY ?? 0).toBe(0);
		expect(delta.zoom ?? 1).toBe(1);
	});

	test('デッドゾーン境界で連続(閾値直後の出力は微小・跳ねない)', () => {
		const justOver = spaceMouseToCameraDelta(
			axes({ tx: DEFAULT_DEADZONE + 1 }),
			{ panSensitivity: 1 },
		);
		expect(justOver.panX).toBeLessThan(0);
		expect(justOver.panX!).toBeGreaterThan(-0.01);
	});

	test('deadzone はオプションで変えられる', () => {
		const wide = spaceMouseToCameraDelta(axes({ tx: 50 }), { deadzone: 60, panSensitivity: 1 });
		expect(wide.panX ?? 0).toBe(0);
		const none = spaceMouseToCameraDelta(axes({ tx: 50 }), { deadzone: 0, panSensitivity: 1 });
		expect(none.panX).toBeCloseTo(-50 / FULL_SCALE, 10);
	});
});

describe('spaceMouseToCameraDelta — 並進 → パン', () => {
	test('tx フル倒し(+350)で panX = −panSensitivity ちょうど(2026-08-20 実機判定で反転)', () => {
		const delta = spaceMouseToCameraDelta(axes({ tx: FULL_SCALE }), { panSensitivity: 0.5 });
		expect(delta.panX).toBeCloseTo(-0.5, 10);
		expect(delta.panY ?? 0).toBe(0);
	});

	test('ty は素通しで panY へ(2026-08-20 実機判定で反転)', () => {
		const delta = spaceMouseToCameraDelta(axes({ ty: FULL_SCALE }), { panSensitivity: 1 });
		expect(delta.panY).toBeCloseTo(1, 10);
		expect(delta.panX ?? 0).toBe(0);
	});

	test('正規化はデッドゾーン控除後の線形(中間値の検算)', () => {
		const raw = 180;
		const delta = spaceMouseToCameraDelta(axes({ tx: raw }), { panSensitivity: 1 });
		expect(delta.panX).toBeCloseTo(-norm(raw, DEFAULT_DEADZONE), 10);
	});

	test('フルスケール超え(異常個体・スパイク)は ±1 にクランプ', () => {
		const delta = spaceMouseToCameraDelta(axes({ tx: 700, ty: -32768 }), { panSensitivity: 1 });
		expect(delta.panX).toBeCloseTo(-1, 10);
		expect(delta.panY).toBeCloseTo(-1, 10);
	});

	test('負方向は対称(panX(-v) = -panX(v))', () => {
		const pos = spaceMouseToCameraDelta(axes({ tx: 200 }), { panSensitivity: 1 });
		const neg = spaceMouseToCameraDelta(axes({ tx: -200 }), { panSensitivity: 1 });
		expect(neg.panX).toBeCloseTo(-pos.panX!, 10);
	});
});

describe('spaceMouseToCameraDelta — 並進 z → ズーム(指数写像)', () => {
	test('tz フル倒しで zoom = exp(zoomSensitivity)', () => {
		const delta = spaceMouseToCameraDelta(axes({ tz: FULL_SCALE }), { zoomSensitivity: 0.3 });
		expect(delta.zoom).toBeCloseTo(Math.exp(0.3), 10);
	});

	test('押し引き対称: zoom(v) × zoom(−v) = 1(往復で距離が戻る)', () => {
		const opts = { zoomSensitivity: 0.25 };
		const push = spaceMouseToCameraDelta(axes({ tz: 240 }), opts);
		const pull = spaceMouseToCameraDelta(axes({ tz: -240 }), opts);
		expect(push.zoom! * pull.zoom!).toBeCloseTo(1, 10);
	});

	test('applyCameraDelta との合成: 同じ tz を n 回流すと距離は指数で単調変化', () => {
		const opts = { zoomSensitivity: 0.2 };
		let state: CameraState = { target: [0, 0, 0], distance: 10, orientation: [0, 0, 0, 1] };
		const delta = spaceMouseToCameraDelta(axes({ tz: FULL_SCALE }), opts);
		state = applyCameraDelta(state, delta);
		state = applyCameraDelta(state, delta);
		expect(state.distance).toBeCloseTo(10 * Math.exp(0.2) * Math.exp(0.2), 8);
	});
});

describe('spaceMouseToCameraDelta — 回転 → rotateX/rotateY/rotateZ(#26 画面基準)', () => {
	test('rx(向こうに倒す)→ rotateX・フル倒しで −rotateSensitivity ちょうど(他の回転は 0)', () => {
		const delta = spaceMouseToCameraDelta(axes({ rx: FULL_SCALE }), { rotateSensitivity: 0.05 });
		expect(delta.rotateX).toBeCloseTo(-0.05, 10);
		expect(delta.rotateY ?? 0).toBe(0);
		expect(delta.rotateZ ?? 0).toBe(0);
	});

	test('rz(横に倒す)→ rotateY(画面縦軸)・フル倒しで rotateSensitivity ちょうど', () => {
		const delta = spaceMouseToCameraDelta(axes({ rz: FULL_SCALE }), { rotateSensitivity: 0.05 });
		expect(delta.rotateY).toBeCloseTo(0.05, 10);
		expect(delta.rotateX ?? 0).toBe(0);
		expect(delta.rotateZ ?? 0).toBe(0);
	});

	test('ry(ひねる)→ rotateZ(画面法線ロール・従来無視→#26 で使用)', () => {
		const delta = spaceMouseToCameraDelta(axes({ ry: FULL_SCALE }), { rotateSensitivity: 0.05 });
		expect(delta.rotateZ).toBeCloseTo(0.05, 10);
		expect(delta.rotateX ?? 0).toBe(0);
		expect(delta.rotateY ?? 0).toBe(0);
	});

	test('回転軸は並進出力に混ざらない(パン 0・zoom 1 のまま)', () => {
		const delta = spaceMouseToCameraDelta(
			axes({ rx: FULL_SCALE, ry: -FULL_SCALE, rz: 200 }),
			{ rotateSensitivity: 1, panSensitivity: 1, zoomSensitivity: 1 },
		);
		expect(delta.panX ?? 0).toBe(0);
		expect(delta.panY ?? 0).toBe(0);
		expect(delta.zoom ?? 1).toBe(1);
	});

	test('負方向は対称(rotateY(-v) = -rotateY(v))', () => {
		const pos = spaceMouseToCameraDelta(axes({ rz: 200 }), { rotateSensitivity: 1 });
		const neg = spaceMouseToCameraDelta(axes({ rz: -200 }), { rotateSensitivity: 1 });
		expect(neg.rotateY).toBeCloseTo(-pos.rotateY!, 10);
	});
});

describe('spaceMouseToCameraDelta — 感度・既定値・純関数性', () => {
	test('感度係数は線形に効く(2 倍の感度で 2 倍の出力)', () => {
		const a = spaceMouseToCameraDelta(axes({ tx: 200, rz: 200 }), {
			panSensitivity: 0.1,
			rotateSensitivity: 0.02,
		});
		const b = spaceMouseToCameraDelta(axes({ tx: 200, rz: 200 }), {
			panSensitivity: 0.2,
			rotateSensitivity: 0.04,
		});
		expect(b.panX).toBeCloseTo(a.panX! * 2, 10);
		expect(b.rotateY).toBeCloseTo(a.rotateY! * 2, 10);
	});

	test('既定感度は正: フル倒し全軸で全出力が動く(具体値は感度調整に委ねる)', () => {
		const delta = spaceMouseToCameraDelta(
			axes({
				tx: FULL_SCALE,
				ty: FULL_SCALE,
				tz: FULL_SCALE,
				rx: FULL_SCALE,
				ry: FULL_SCALE,
				rz: FULL_SCALE,
			}),
		);
		expect(delta.panX).toBeLessThan(0);
		expect(delta.panY).toBeGreaterThan(0);
		expect(delta.zoom).toBeGreaterThan(1);
		expect(delta.rotateX).toBeLessThan(0);
		expect(delta.rotateY).toBeGreaterThan(0);
		expect(delta.rotateZ).toBeGreaterThan(0);
		expect(Number.isFinite(delta.zoom!)).toBe(true);
	});

	test('決定性: 同じ入力は同じ出力・入力は変異しない(凍結入力で検査)', () => {
		const input = axes({ tx: 123, ty: -45, tz: 67, rx: -89, ry: 12, rz: 34 });
		const first = spaceMouseToCameraDelta(input);
		const second = spaceMouseToCameraDelta(input);
		expect(second).toEqual(first);
	});

	test('applyCameraDelta との合成が決定的(全軸同時デルタを凍結状態に適用)', () => {
		const state = frozenState();
		const delta = spaceMouseToCameraDelta(
			axes({ tx: 100, ty: 100, tz: -100, rx: 50, ry: -70, rz: -50 }),
			{ panSensitivity: 1, rotateSensitivity: 0.1, zoomSensitivity: 0.2 },
		);
		const a = applyCameraDelta(state, delta);
		const b = applyCameraDelta(state, delta);
		expect(a).toEqual(b);
		expect(a.distance).toBeGreaterThan(0);
		expect(
			Math.hypot(a.orientation[0], a.orientation[1], a.orientation[2], a.orientation[3]),
		).toBeCloseTo(1, 6);
	});
});
