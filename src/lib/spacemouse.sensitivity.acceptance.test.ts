/**
 * 要件#24 追補c の受け入れテスト(AC-24-13)— 回転の既定感度を 1.5 倍にする
 *
 * 人間ゲート 2(感度の量感)で由谷「モデルを回すのはもう少し早い方がいい」
 * (2026-09-23)→ 1.5 倍を選択。`DEFAULT_ROTATE_SENSITIVITY` を 0.03 → 0.045 に
 * する契約を、`rotateSensitivity` を渡さない呼び出しの出力値で固定する。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * - 回転の既定感度 = 0.045 rad/イベント(回転3軸すべてに同じ倍率)
 * - パン既定 0.02・ズーム既定 0.02・デッドゾーン 10・フルスケール 350・
 *   軸の写像と符号(rx→−rotateX / rz→rotateY / ry→rotateZ / tx→−panX /
 *   tz→exp ズーム)は不変
 * - `rotateSensitivity` を明示的に渡したときはその値が効く(従来どおり)
 *
 * 既存の `spacemouse.acceptance.test.ts` は既定感度を「正であること」しか固定
 * していないため、本ファイルが具体値を担う(既存テストは無改変)。
 *
 * toBeCloseTo の桁は既存テストに揃えて 10(許容 5e-11)。フル倒し(+350)は
 * デッドゾーン控除後に (350−10)/(350−10) = 1 ちょうどに正規化されるので出力は
 * 「1 × 既定感度」そのもの — 浮動小数の誤差は 1e-16 台に収まり、一方で旧既定
 * 0.03 との差 0.015 は桁違いに大きいので、この桁で新旧を確実に区別できる。
 */
import { describe, expect, test } from 'vitest';
import { spaceMouseToCameraDelta, type SpaceMouseAxes } from './spacemouse';

const FULL_SCALE = 350;

/** 追補c で決まった回転の既定感度(rad/イベント)。 */
const EXPECTED_DEFAULT_ROTATE = 0.045;
/** 追補c 以前から不変のパン・ズーム既定感度。 */
const EXPECTED_DEFAULT_PAN = 0.02;
const EXPECTED_DEFAULT_ZOOM = 0.02;

/** 全軸ゼロを基準に一部だけ指定する。凍結して非変異も同時に検査。 */
function axes(partial: Partial<SpaceMouseAxes> = {}): SpaceMouseAxes {
	return Object.freeze({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, ...partial });
}

describe('spaceMouseToCameraDelta — 回転の既定感度は 0.045(追補c・AC-24-13)', () => {
	test('rx フル倒し(+350)・オプション無しで rotateX = −0.045', () => {
		const delta = spaceMouseToCameraDelta(axes({ rx: FULL_SCALE }));
		expect(delta.rotateX).toBeCloseTo(-EXPECTED_DEFAULT_ROTATE, 10);
	});

	test('rz フル倒し(+350)・オプション無しで rotateY = +0.045', () => {
		const delta = spaceMouseToCameraDelta(axes({ rz: FULL_SCALE }));
		expect(delta.rotateY).toBeCloseTo(EXPECTED_DEFAULT_ROTATE, 10);
	});

	test('ry フル倒し(+350)・オプション無しで rotateZ = +0.045', () => {
		const delta = spaceMouseToCameraDelta(axes({ ry: FULL_SCALE }));
		expect(delta.rotateZ).toBeCloseTo(EXPECTED_DEFAULT_ROTATE, 10);
	});

	test('回転3軸を同時にフル倒ししても各軸に同じ既定倍率が効く(軸ごとに変えない)', () => {
		const delta = spaceMouseToCameraDelta(
			axes({ rx: FULL_SCALE, ry: FULL_SCALE, rz: FULL_SCALE }),
		);
		expect(delta.rotateX).toBeCloseTo(-EXPECTED_DEFAULT_ROTATE, 10);
		expect(delta.rotateY).toBeCloseTo(EXPECTED_DEFAULT_ROTATE, 10);
		expect(delta.rotateZ).toBeCloseTo(EXPECTED_DEFAULT_ROTATE, 10);
	});
});

describe('spaceMouseToCameraDelta — パン・ズームの既定は追補c 以前のまま(AC-24-13)', () => {
	test('tx フル倒し(+350)・オプション無しで panX = −0.02(追補a の反転符号・既定 0.02 不変)', () => {
		const delta = spaceMouseToCameraDelta(axes({ tx: FULL_SCALE }));
		expect(delta.panX).toBeCloseTo(-EXPECTED_DEFAULT_PAN, 10);
	});

	test('tz フル倒し(+350)・オプション無しで zoom = exp(0.02)(既定 0.02 不変)', () => {
		const delta = spaceMouseToCameraDelta(axes({ tz: FULL_SCALE }));
		expect(delta.zoom).toBeCloseTo(Math.exp(EXPECTED_DEFAULT_ZOOM), 10);
	});

	test('回転・パン・ズームを同時にフル倒しした1回の呼び出しで、回転だけが 0.045・パン −0.02・zoom exp(0.02)', () => {
		const delta = spaceMouseToCameraDelta(
			axes({ tx: FULL_SCALE, tz: FULL_SCALE, rx: FULL_SCALE }),
		);
		expect(delta.rotateX).toBeCloseTo(-EXPECTED_DEFAULT_ROTATE, 10);
		expect(delta.panX).toBeCloseTo(-EXPECTED_DEFAULT_PAN, 10);
		expect(delta.zoom).toBeCloseTo(Math.exp(EXPECTED_DEFAULT_ZOOM), 10);
	});
});

describe('spaceMouseToCameraDelta — 明示指定が既定に勝つ(AC-24-13)', () => {
	test('rotateSensitivity: 0.05 を渡すと rotateX = −0.05(既定 0.045 は使われない)', () => {
		const delta = spaceMouseToCameraDelta(axes({ rx: FULL_SCALE }), { rotateSensitivity: 0.05 });
		expect(delta.rotateX).toBeCloseTo(-0.05, 10);
	});

	test('rotateSensitivity を明示しても、渡していないパン・ズームは既定のまま', () => {
		const delta = spaceMouseToCameraDelta(
			axes({ tx: FULL_SCALE, tz: FULL_SCALE, rx: FULL_SCALE }),
			{ rotateSensitivity: 0.05 },
		);
		expect(delta.rotateX).toBeCloseTo(-0.05, 10);
		expect(delta.panX).toBeCloseTo(-EXPECTED_DEFAULT_PAN, 10);
		expect(delta.zoom).toBeCloseTo(Math.exp(EXPECTED_DEFAULT_ZOOM), 10);
	});
});
