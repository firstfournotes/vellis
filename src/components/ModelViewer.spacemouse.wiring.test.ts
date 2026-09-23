/**
 * 要件#24 追補b の受け入れテスト — SpaceMouse の入力は前面のウィンドウの
 * 3D ビューアだけが受ける(AC-24-12)
 * (docs/requirements/req-24.md「追補b」「フロント配線(追補b)」。軸の写像本体は
 *  src/lib/spacemouse.acceptance.test.ts が持ち、ここは無改変)
 *
 * ## 観測点(test-writer 裁量)= スタブ renderer の `render` に渡る PerspectiveCamera の姿勢
 *
 * `ModelViewer.svelte` の SpaceMouse 経路は
 *   listen('spacemouse_input') → onSpaceMouseInput → applyDelta → applyCameraDelta
 *   → syncCamera(camera.position / quaternion / near / far / projectionMatrix を更新)
 *   → requestRender → renderer.render(scene, camera)
 * であり、「カメラの状態」= VM の `cameraState` は `syncCamera` が three の
 * `PerspectiveCamera` 実体に**そのまま写す**(写像はこの 1 箇所だけ)。そこで
 * `vi.mock('three')` で `WebGLRenderer` だけをスタブに差し替え(OBJ / PLY の
 * wiring テストと同一方式)、`render` に渡ってきた camera の**参照**を掴み、
 * イベント配達の前後で姿勢(position・quaternion・near・far・projectionMatrix)の
 * **値のコピー**を比べる。
 *
 * 「動いた / 動かない」を取り違えない根拠:
 * - 参照ではなく値のコピーを比べる(camera は同一インスタンスなので、参照比較では
 *   常に「同じ」になってしまう)
 * - 描画要求の回数を観測点にしない(実装が「捨てる」代わりに無変化の状態で
 *   syncCamera を呼んでも契約違反ではなく、逆に描画されなくても状態が変われば違反)
 * - **真のケース(AC-24-12b)が同じ観測点で「確かに変わる」ことを担保する**。
 *   入力はデッドゾーン 10 を大きく超えるフルスケール(6 軸とも 350)で、
 *   回転(quaternion が変わる)・ズーム(target からの距離が e^0.02 倍= 2% 変わる)
 *   ・パン(target が動く)のすべてを含む。偽のケースだけなら観測点が死んでいても
 *   緑になるため、真のケースを必ず同じ入力・同じ比較関数で置く
 * - 観測は同期で成立する(applyDelta → syncCamera は同期。rAF は即時実行に
 *   スタブして描画記録も同期で取れる)
 *
 * ## 確定契約(implementer はこれに従う)
 * - `onSpaceMouseInput` は **イベントごとに** `document.hasFocus()` を見る。偽なら
 *   `applyDelta` を呼ばない(cameraState を一切変えない)。真なら従来どおり
 * - 購読開始時に一度だけ見て覚える実装は不可(AC-24-12c: 偽→真→偽 の切替で
 *   真のときの入力だけが効く)
 * - モデル未表示(loading / error)のときは従来どおり動かない(AC-24-12d)。
 *   この経路は `ensureScene` の手前なので renderer は作られず、描画要求も出ない
 * - Rust 側(`src-tauri/**`)・`spacemouse.ts`・`model-camera.ts` は無改変
 *
 * 実装前に赤い理由: 現状の `onSpaceMouseInput` は `load.kind === 'ready'` だけを
 * 見て `applyDelta` するため、`hasFocus()` が偽でもカメラが動く
 * (AC-24-12a・AC-24-12c が赤)。AC-24-12b / d は従来挙動の確認で最初から緑
 * (b は観測点の生存確認・d は退行防止)。
 *
 * スタブ(既存 wiring テストの家風): ResizeObserver = no-op・fetch = OBJ バイト列を
 * 返す偽 Response・requestAnimationFrame = 即時実行・$lib/events の listen =
 * ハンドラを捕まえる(テストから任意の SpaceMouseAxes を届ける)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';

const captured = vi.hoisted(() => ({
	/** スタブ renderer の render に渡された camera(参照。姿勢は都度コピーして比べる)。 */
	cameras: [] as unknown[],
	/** スタブ renderer が生成された回数(未表示経路では 0 のはず)。 */
	constructed: 0,
	/** $lib/events.listen で登録されたハンドラ(イベント名 → ハンドラ)。 */
	handlers: new Map<string, (e: { payload: unknown }) => void>(),
	/** listen が呼ばれた回数(購読が生きていることの確認)。 */
	listened: 0,
}));

vi.mock('$lib/events', () => ({
	listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
		captured.handlers.set(event, handler);
		captured.listened += 1;
		return () => {
			captured.handlers.delete(event);
		};
	}),
}));

// JSDOM に WebGL は無い: WebGLRenderer だけをスタブへ差し替え、残りは本物を使う。
vi.mock('three', async (importOriginal) => {
	const actual = await importOriginal<typeof import('three')>();
	class StubWebGLRenderer {
		domElement = document.createElement('canvas');
		constructor(_parameters?: unknown) {
			captured.constructed += 1;
		}
		setPixelRatio(_ratio: number): void {}
		setClearAlpha(_alpha: number): void {}
		setSize(_w: number, _h: number, _updateStyle?: boolean): void {}
		render(_scene: unknown, camera: unknown): void {
			captured.cameras.push(camera);
		}
		dispose(): void {}
	}
	return { ...actual, WebGLRenderer: StubWebGLRenderer };
});

import type { PerspectiveCamera } from 'three';
import type { SpaceMouseAxes } from '$lib/spacemouse';
import ModelViewer from './ModelViewer.svelte';

/** 立方体 [0,5]^3・三角形 12 面(ModelViewer.obj.wiring.test.ts と同じ)。 */
const CUBE_OBJ = `v 0 0 0
v 5 0 0
v 5 5 0
v 0 5 0
v 0 0 5
v 5 0 5
v 5 5 5
v 0 5 5
f 1 2 3
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

/** 幾何の無い OBJ(コメントだけ)= error 経路(The model has no drawable geometry)。 */
const EMPTY_OBJ = `# just a comment, no geometry
`;

const PROPS = {
	uri: 'file:///Users/a/models/cube.obj',
	src: 'vellis-asset://local/Users/a/models/cube.obj',
};

/**
 * 十分に大きい入力: 6 軸ともフルスケール(350)。デッドゾーン 10 を大きく超え、
 * 回転(rx/ry/rz)・パン(tx/ty)・ズーム(tz)のすべてがカメラ状態を変える。
 */
const FULL_INPUT: SpaceMouseAxes = { tx: 350, ty: 350, tz: 350, rx: 350, ry: 350, rz: 350 };

class NoopResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

/** fetch を「この OBJ ソースを返す偽 Response」に固定する。 */
function stubFetchWith(source: string): void {
	const bytes = new TextEncoder().encode(source);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({
			ok: true,
			status: 200,
			arrayBuffer: async () => bytes.buffer.slice(0),
		})),
	);
}

/** fetch を「永遠に解決しない」= loading のまま止まる状態に固定する。 */
function stubFetchPending(): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(() => new Promise<never>(() => undefined)),
	);
}

/** カメラ姿勢の値コピー(参照比較を避ける)。 */
interface Pose {
	position: number[];
	quaternion: number[];
	near: number;
	far: number;
	projection: number[];
}

function poseOf(camera: PerspectiveCamera): Pose {
	return {
		position: camera.position.toArray(),
		quaternion: camera.quaternion.toArray(),
		near: camera.near,
		far: camera.far,
		projection: camera.projectionMatrix.toArray(),
	};
}

/** 購読済みの spacemouse_input ハンドラへ 1 イベント届ける(Rust の emit の代役)。 */
function deliver(axes: SpaceMouseAxes): void {
	const handler = captured.handlers.get('spacemouse_input');
	expect(handler, 'spacemouse_input が購読されていること').toBeDefined();
	handler!({ payload: axes });
}

/** モデルを ready まで表示し、render に渡った camera の参照を返す。 */
async function mountReady(): Promise<PerspectiveCamera> {
	stubFetchWith(CUBE_OBJ);
	render(ModelViewer, { props: PROPS });
	await vi.waitFor(() => {
		expect(document.querySelector('.model-stats')?.textContent ?? '').toContain('12 triangles');
	});
	await vi.waitFor(() => {
		expect(captured.handlers.has('spacemouse_input')).toBe(true);
	});
	expect(captured.cameras.length, 'ready までに描画要求が届くこと').toBeGreaterThan(0);
	return captured.cameras.at(-1) as PerspectiveCamera;
}

/** document.hasFocus() の戻りを固定する(前面 = 真・裏 = 偽)。 */
function setFocus(focused: boolean): void {
	vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

beforeEach(() => {
	captured.cameras.length = 0;
	captured.constructed = 0;
	captured.handlers.clear();
	captured.listened = 0;
	vi.stubGlobal('ResizeObserver', NoopResizeObserver);
	// requestRender の 1 フレーム遅延をその場で消化する(描画記録を同期で観測する)。
	vi.stubGlobal(
		'requestAnimationFrame',
		vi.fn((cb: FrameRequestCallback) => {
			cb(0);
			return 1;
		}),
	);
	vi.stubGlobal(
		'cancelAnimationFrame',
		vi.fn(() => undefined),
	);
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('ModelViewer × SpaceMouse の前面判定(要件#24 追補b・AC-24-12)', () => {
	it('AC-24-12a: モデル表示済み+hasFocus 偽 → フルスケール入力でもカメラの状態が一切変わらない', async () => {
		const camera = await mountReady();
		setFocus(false);
		const before = poseOf(camera);

		deliver(FULL_INPUT);

		expect(document.hasFocus).toHaveBeenCalled();
		const after = poseOf(camera);
		expect(after.position, '位置(パン・ズーム)が変わらない').toEqual(before.position);
		expect(after.quaternion, '向き(回転)が変わらない').toEqual(before.quaternion);
		expect(after.near, 'near が変わらない').toBe(before.near);
		expect(after.far, 'far が変わらない').toBe(before.far);
		expect(after.projection, '投影が変わらない').toEqual(before.projection);
	});

	it('AC-24-12b: モデル表示済み+hasFocus 真 → 同じ入力でカメラが変わる(観測点の生存確認・従来どおり)', async () => {
		const camera = await mountReady();
		setFocus(true);
		const before = poseOf(camera);

		deliver(FULL_INPUT);

		const after = poseOf(camera);
		expect(after.quaternion, '回転で向きが変わる').not.toEqual(before.quaternion);
		expect(after.position, 'パン・ズームで位置が変わる').not.toEqual(before.position);
		// 描画要求も届く(真のときは従来どおり描き直す)。
		expect(captured.cameras.at(-1), '入力後に描画要求が届く').toBe(camera);
		expect(captured.cameras.length).toBeGreaterThan(1);
	});

	it('AC-24-12c: 同じビューアに 偽 → 真 → 偽 と切り替えて届けると、真のときの入力だけが効く(判定はイベントごと)', async () => {
		const camera = await mountReady();
		const pose0 = poseOf(camera);

		// 1 発目: 裏(偽)→ 変わらない
		setFocus(false);
		deliver(FULL_INPUT);
		const pose1 = poseOf(camera);
		expect(pose1, '偽: 変わらない').toEqual(pose0);

		// 2 発目: 前面(真)→ 変わる
		setFocus(true);
		deliver(FULL_INPUT);
		const pose2 = poseOf(camera);
		expect(pose2.quaternion, '真: 向きが変わる').not.toEqual(pose1.quaternion);
		expect(pose2.position, '真: 位置が変わる').not.toEqual(pose1.position);

		// 3 発目: また裏(偽)→ 2 発目の姿勢のまま(購読時に一度覚える実装なら
		// ここで動いてしまう= イベントごとの判定であることの確認)
		setFocus(false);
		deliver(FULL_INPUT);
		const pose3 = poseOf(camera);
		expect(pose3, '偽: 2 発目の姿勢のまま').toEqual(pose2);
	});

	it('AC-24-12d-1: モデル未表示(読み込み中)+hasFocus 真 → 動かない(従来どおり・renderer 未生成)', async () => {
		stubFetchPending();
		render(ModelViewer, { props: PROPS });
		await vi.waitFor(() => {
			expect(document.querySelector('.model-message')?.textContent ?? '').toContain('Loading…');
		});
		await vi.waitFor(() => {
			expect(captured.handlers.has('spacemouse_input')).toBe(true);
		});
		setFocus(true);

		expect(() => deliver(FULL_INPUT)).not.toThrow();

		// ensureScene の手前= 3D の描画面は作られず、描画要求も出ない。
		expect(captured.constructed).toBe(0);
		expect(captured.cameras.length).toBe(0);
		expect(document.querySelector('.model-stage canvas')).toBeNull();
	});

	it('AC-24-12d-2: モデル未表示(幾何なしのエラー)+hasFocus 真 → 動かない(従来どおり・renderer 未生成)', async () => {
		stubFetchWith(EMPTY_OBJ);
		render(ModelViewer, { props: PROPS });
		await vi.waitFor(() => {
			expect(document.querySelector('.model-message')?.textContent ?? '').toBe(
				'The model has no drawable geometry',
			);
		});
		await vi.waitFor(() => {
			expect(captured.handlers.has('spacemouse_input')).toBe(true);
		});
		setFocus(true);

		expect(() => deliver(FULL_INPUT)).not.toThrow();

		expect(captured.constructed).toBe(0);
		expect(captured.cameras.length).toBe(0);
		expect(document.querySelector('.model-stage canvas')).toBeNull();
	});
});
