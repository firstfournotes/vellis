/**
 * SpaceMouse(6DoF)の生軸値 → カメラデルタの写像(requirements.md #24)。
 *
 * Rust 側(`src-tauri/src/spacemouse.rs`)は HID レポートを i16 のまま流すだけで、
 * 「どちらへ倒したらどう動くか」の意味づけは全部ここにある。出口は
 * `model-camera.ts` の `CameraDelta` — マウス(要件#23)と同じ 1 本の入口へ
 * 合流するので、ModelViewer 側に入力ソースごとの分岐は増えない。
 */

import type { CameraDelta } from './model-camera';

/** Rust が emit する 1 イベントぶんの生 6 軸値(i16 素通し・概ね ±350)。 */
export interface SpaceMouseAxes {
	/** 並進(左右・上下・前後)。 */
	tx: number;
	ty: number;
	tz: number;
	/** 回転(前後チルト・ロール・垂直軸のひねり)。 */
	rx: number;
	ry: number;
	rz: number;
}

export interface SpaceMouseOptions {
	/** 生値単位の不感帯。既定 10。 */
	deadzone?: number;
	/** フル倒し 1 イベントぶんの回転量(rad)。 */
	rotateSensitivity?: number;
	/** フル倒し 1 イベントぶんのパン量(world 単位)。 */
	panSensitivity?: number;
	/** フル倒し 1 イベントぶんの log(zoom)。 */
	zoomSensitivity?: number;
}

/** 実効レンジ。SpaceMouse Wireless はフル倒しでおよそこの値に達する。 */
const FULL_SCALE = 350;

/**
 * 既定の不感帯。台に置いたまま指を触れているだけでも数カウントは揺れるので、
 * この幅は「静止しているのにモデルが漂う」のを防ぐための最低限。
 */
const DEFAULT_DEADZONE = 10;

/**
 * 既定の感度。1 イベント(≒1/60 秒)ぶんの量なので、フル倒しを 1 秒続けると
 * 回転は約 1.8rad(100 度強)・ズームは約 e^1.2(3.3 倍)になる目安。
 * 実機の感触で調整する余地を残して、呼び出し側から上書きできる。
 */
const DEFAULT_ROTATE_SENSITIVITY = 0.03;
const DEFAULT_PAN_SENSITIVITY = 0.02;
const DEFAULT_ZOOM_SENSITIVITY = 0.02;

/**
 * 生値 → −1..1。不感帯ぶんを差し引いてから割るので、閾値を跨いだ瞬間の値は
 * ゼロ付近から連続に立ち上がる(閾値で跳ねない)。
 */
function normalize(value: number, deadzone: number): number {
	if (!Number.isFinite(value)) return 0;
	const magnitude = Math.abs(value);
	if (magnitude <= deadzone) return 0;
	const span = Math.max(FULL_SCALE - deadzone, Number.EPSILON);
	const scaled = ((magnitude - deadzone) / span) * Math.sign(value);
	return Math.max(-1, Math.min(1, scaled));
}

/** −0 を 0 に均す(デルタの「変化なし」は符号を持たない)。 */
function zeroSafe(value: number): number {
	return value === 0 ? 0 : value;
}

/**
 * 6 軸の生値 1 イベントぶんを `applyCameraDelta` に渡せるデルタへ写す。
 *
 * 割り当ては 3D ビューアの慣例に合わせてある: 並進の左右・上下がパン、
 * 前後がズーム。回転3軸は要件#26 のトラックボール化で画面基準になったので、
 * キャップの3自由度がそのまま画面の3軸に対応する — 向こうに倒す(rx)= 画面横軸、
 * 横に倒す(rz)= 画面縦軸、ひねる(ry)= 画面法線のロール。ry は旧仕様では
 * カメラ状態に roll が無く捨てていたが、#26 で使い道ができた。rx の負符号は
 * 旧 rx→pitch(+)で実機確認済みの操作感を、新しい符号規約(rotateX 正 =
 * カメラが下側へ回り込む)の下で保つためのもの。ズームだけ指数写像なのは、
 * 距離が乗算で合成されるため — 押して引いたら元の距離にきっちり戻る。
 *
 * パンは左右(tx)を反転し、上下(ty)は素通しにする。2026-08-20 の実機判定で
 * 旧仕様(tx をそのまま panX・ty を反転して panY)は左右・上下とも操作感が
 * 逆と分かったため、要件#24 側の仕様を差し替えた。
 */
export function spaceMouseToCameraDelta(
	axes: SpaceMouseAxes,
	options: SpaceMouseOptions = {},
): CameraDelta {
	const deadzone = options.deadzone ?? DEFAULT_DEADZONE;
	const rotate = options.rotateSensitivity ?? DEFAULT_ROTATE_SENSITIVITY;
	const pan = options.panSensitivity ?? DEFAULT_PAN_SENSITIVITY;
	const zoom = options.zoomSensitivity ?? DEFAULT_ZOOM_SENSITIVITY;

	return {
		rotateX: zeroSafe(-normalize(axes.rx, deadzone) * rotate),
		rotateY: zeroSafe(normalize(axes.rz, deadzone) * rotate),
		rotateZ: zeroSafe(normalize(axes.ry, deadzone) * rotate),
		panX: zeroSafe(-normalize(axes.tx, deadzone) * pan),
		panY: zeroSafe(normalize(axes.ty, deadzone) * pan),
		zoom: Math.exp(normalize(axes.tz, deadzone) * zoom),
	};
}
