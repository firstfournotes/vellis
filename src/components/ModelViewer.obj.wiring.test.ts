/**
 * 要件#57 の受け入れテスト — ModelViewer の OBJ 配線(AC-57-13 / AC-57-14)
 * (docs/requirements/req-57.md 契約④⑤。分類・パース本体は
 *  src/lib/model-obj.acceptance.test.ts が持つ)
 *
 * ## 観測方式の選択(req-57.md「既存テストの棚卸し」で test-writer 裁量とされた点)
 *
 * **`three` の部分モック方式を採る**: JSDOM には WebGL コンテキストが無く
 * `WebGLRenderer` を生成できないため、`vi.mock('three')` で `WebGLRenderer` だけを
 * スタブ(canvas 要素を持ち、render 呼び出しで渡された Scene を記録する)に
 * 差し替え、残り(Scene / PerspectiveCamera / ローダー等)は `vi.importActual` の
 * 本物を使う。これにより fetch → parseModel → シーン構築 → ready 表示という
 * 実配線をそのまま通し、「プレースホルダではなく 3D の面が出る状態」を
 * 「スタブ renderer に渡された Scene が面(position 属性を持つ Mesh)を含む」
 * ことで機械判定する。観測をパース成立だけに寄せる案は、ビューア側の配線
 * (loadModel → ensureScene → ready)を素通しにしてしまうので採らない。
 *
 * ## 確定契約(implementer はこれに従う)
 * - `ModelViewer.svelte` は**無改変**(契約④⑥)— `parseModel` が `.obj` を
 *   受けるようになれば、この配線は既存のまま OBJ でも成立する。
 *   本テストが赤い理由は実装前は「parseModel が obj を reject する」ことだけで
 *   あるべきで、緑にするために ModelViewer 側へ OBJ 分岐を足してはならない
 * - ready 時: `.model-stats` に `{n} triangles`(toLocaleString)が出る(既存 UI)
 * - エラー時(幾何の無い OBJ): `parseModel` の reject が `load.kind === 'error'` に
 *   落ち、`.model-message` に既存の英語文言(The model has no drawable geometry)が
 *   出る。この経路は `ensureScene` の手前で決まる= canvas は作られない
 *
 * スタブ(既存 wiring テストの家風): ResizeObserver = no-op・fetch = OBJ バイト列を
 * 返す偽 Response・requestAnimationFrame = 即時実行(requestRender の 1 フレーム
 * 遅延をその場で消化する)・$lib/events の listen = no-op(SpaceMouse 購読)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';

const captured = vi.hoisted(() => ({
	/** スタブ renderer の render に渡された Scene(描画要求の記録)。 */
	scenes: [] as unknown[],
	/** スタブ renderer が生成された回数(エラー経路では 0 のはず)。 */
	constructed: 0,
}));

vi.mock('$lib/events', () => ({
	listen: vi.fn(async () => () => undefined),
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
		render(scene: unknown, _camera: unknown): void {
			captured.scenes.push(scene);
		}
		dispose(): void {}
	}
	return { ...actual, WebGLRenderer: StubWebGLRenderer };
});

import type { Mesh, Object3D } from 'three';
import ModelViewer from './ModelViewer.svelte';

/** 立方体 [0,5]^3・三角形 12 面(model-obj.acceptance.test.ts と同じ寸法系)。 */
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

/** 幾何の無い OBJ(コメントだけ)= 既存の reject 経路へ落ちる。 */
const EMPTY_OBJ = `# just a comment, no geometry
`;

const PROPS = {
	uri: 'file:///Users/a/models/cube.obj',
	src: 'vellis-asset://local/Users/a/models/cube.obj',
};

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

beforeEach(() => {
	captured.scenes.length = 0;
	captured.constructed = 0;
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

describe('ModelViewer × OBJ の配線(要件#57 ④⑤)', () => {
	it('AC-57-13: .obj の modelSrc でマウントすると 3D の面が出る状態になり、三角形数が表示される', async () => {
		stubFetchWith(CUBE_OBJ);
		render(ModelViewer, { props: PROPS });

		// ready に達し、ツールバーに三角形数(12 triangles)が出る。
		await vi.waitFor(() => {
			expect(document.querySelector('.model-stats')?.textContent ?? '').toContain('12 triangles');
		});

		// プレースホルダ(Loading… / エラー文言)は出ていない。
		expect(document.querySelector('.model-message')).toBeNull();

		// スタブ renderer へ描画要求が届き、その Scene が面を含む —
		// 立方体 12 三角形=非インデックスの position 36 頂点を持つ Mesh が居る。
		expect(captured.scenes.length).toBeGreaterThan(0);
		const scene = captured.scenes.at(-1) as Object3D;
		const meshes: Mesh[] = [];
		scene.traverse((child) => {
			if ((child as Mesh).isMesh) meshes.push(child as Mesh);
		});
		expect(meshes.length, 'Scene にモデルの Mesh が居ること').toBeGreaterThan(0);
		const positions = meshes.reduce(
			(sum, mesh) => sum + (mesh.geometry.getAttribute('position')?.count ?? 0),
			0,
		);
		expect(positions, '12 三角形ぶんの頂点(3 × 12)').toBe(36);
	});

	it('AC-57-14: 幾何の無い .obj は .model-message に既存のエラー文言が出る(STL / 3MF と同じ見え方)', async () => {
		stubFetchWith(EMPTY_OBJ);
		render(ModelViewer, { props: PROPS });

		await vi.waitFor(() => {
			expect(document.querySelector('.model-message')?.textContent ?? '').toBe(
				'The model has no drawable geometry',
			);
		});

		// エラー経路は ensureScene の手前で決まる= 3D の描画面(canvas)は作られない。
		expect(captured.constructed).toBe(0);
		expect(document.querySelector('.model-stage canvas')).toBeNull();
		expect(document.querySelector('.model-stats')).toBeNull();
	});
});
