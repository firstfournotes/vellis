/**
 * 要件#58 の受け入れテスト — ModelViewer の PLY 配線(AC-58-17 / 18 / 19)
 * (docs/requirements/req-58.md 契約④⑥。分類・パース本体は
 *  src/lib/model-ply.acceptance.test.ts が持つ)
 *
 * ## 観測方式(要件#57 で確立した作法をそのまま使う)
 *
 * JSDOM には WebGL コンテキストが無く `WebGLRenderer` を生成できないため、
 * `vi.mock('three')` で `WebGLRenderer` だけをスタブ(canvas 要素を持ち、
 * render 呼び出しで渡された Scene を記録する)に差し替え、残り(Scene /
 * PerspectiveCamera / ローダー等)は `vi.importActual` の本物を使う
 * (ModelViewer.obj.wiring.test.ts と同一方式)。fetch は PLY バイト列を返す
 * 偽 Response に固定する。
 *
 * ## 確定契約(implementer はこれに従う)
 * - ready 時のツールバー表示は `kind` で出し分ける(契約④):
 *   点群 → `{pointCount.toLocaleString()} points`・メッシュ → 従来どおり
 *   `{triangleCount.toLocaleString()} triangles`。文言は英語(要件#51)
 * - 点群もメッシュも同じ配線(fetch → parseModel → ensureScene → ready)に乗り、
 *   点群では Scene に `Points`(isPoints)が入る
 * - エラー時(頂点0の PLY): `parseModel` の reject が `load.kind === 'error'` に
 *   落ち、`.model-message` に既存の英語文言(The model has no drawable geometry)が
 *   出る。この経路は `ensureScene` の手前で決まる= canvas は作られない
 *
 * 実装前に赤い理由: `parseModel` が `.ply` を reject する
 * (`Not a supported 3D model extension`)ため、AC-58-17 / 18 は ready に達せず、
 * AC-58-19 は文言が既存の失敗経路のもの(上記)と一致しない。
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

import type { Mesh, Object3D, Points } from 'three';
import ModelViewer from './ModelViewer.svelte';

// ---------------------------------------------------------------------------
// フィクスチャ(ASCII PLY は文字列で組める)。8点=立方体 [0,30]^3 の角 —
// src/lib/__fixtures__/cloud-ascii.ply / cube-mesh.ply と同じ寸法系。
// ---------------------------------------------------------------------------

/** 面なし ASCII 点群(8点)→ ツールバーは「8 points」。 */
const CLOUD_PLY = `ply
format ascii 1.0
element vertex 8
property float x
property float y
property float z
end_header
0 0 0
30 0 0
30 30 0
0 30 0
0 0 30
30 0 30
30 30 30
0 30 30
`;

/** 面ありメッシュ(8頂点・12三角形)→ ツールバーは従来どおり「12 triangles」。 */
const MESH_PLY = `ply
format ascii 1.0
element vertex 8
property float x
property float y
property float z
element face 12
property list uchar int vertex_indices
end_header
0 0 0
30 0 0
30 30 0
0 30 0
0 0 30
30 0 30
30 30 30
0 30 30
3 0 1 2
3 0 2 3
3 4 5 6
3 4 6 7
3 0 1 5
3 0 5 4
3 1 2 6
3 1 6 5
3 2 3 7
3 2 7 6
3 3 0 4
3 3 4 7
`;

/** 頂点0の PLY = 既存の失敗経路(boundsOf)へ落ちる壊れた入力。 */
const EMPTY_PLY = `ply
format ascii 1.0
element vertex 0
property float x
property float y
property float z
end_header
`;

const PROPS = {
	uri: 'file:///Users/a/scans/scan.ply',
	src: 'vellis-asset://local/Users/a/scans/scan.ply',
};

class NoopResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

/** fetch を「この PLY ソースを返す偽 Response」に固定する。 */
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

function lastScene(): Object3D {
	expect(captured.scenes.length, 'スタブ renderer へ描画要求が届くこと').toBeGreaterThan(0);
	return captured.scenes.at(-1) as Object3D;
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

describe('ModelViewer × PLY の配線(要件#58 ④⑥)', () => {
	it('AC-58-17: 点群 PLY を開くとエラーにならず、ツールバーに「8 points」が出て Scene に Points が居る', async () => {
		stubFetchWith(CLOUD_PLY);
		render(ModelViewer, { props: PROPS });

		// ready に達し、ツールバーの表示は点数(triangles ではない)。
		await vi.waitFor(() => {
			expect(document.querySelector('.model-stats')?.textContent ?? '').toBe('8 points');
		});

		// プレースホルダ(Loading… / エラー文言)は出ていない。
		expect(document.querySelector('.model-message')).toBeNull();

		// スタブ renderer へ描画要求が届き、その Scene が点群(isPoints)を含む。
		const scene = lastScene();
		const points: Points[] = [];
		const meshes: Mesh[] = [];
		scene.traverse((child) => {
			if ((child as Points).isPoints) points.push(child as Points);
			if ((child as Mesh).isMesh) meshes.push(child as Mesh);
		});
		expect(points.length, 'Scene に点群の Points が居ること').toBe(1);
		expect(points[0].geometry.getAttribute('position')?.count, '8 点').toBe(8);
		expect(meshes.length, '点群を Mesh として描かない').toBe(0);
	});

	it('AC-58-18: 面あり PLY を開くと従来どおり「12 triangles」が出る(メッシュの見え方は不変)', async () => {
		stubFetchWith(MESH_PLY);
		render(ModelViewer, { props: PROPS });

		await vi.waitFor(() => {
			expect(document.querySelector('.model-stats')?.textContent ?? '').toBe('12 triangles');
		});

		expect(document.querySelector('.model-message')).toBeNull();

		// Scene には Mesh が居る(STL / 3MF と同じ扱い)。
		const scene = lastScene();
		const meshes: Mesh[] = [];
		scene.traverse((child) => {
			if ((child as Mesh).isMesh) meshes.push(child as Mesh);
		});
		expect(meshes.length, 'Scene にモデルの Mesh が居ること').toBeGreaterThan(0);
	});

	it('AC-58-19: 壊れた(頂点0の)PLY は英語のエラー表示が出て、points も triangles も出ない', async () => {
		stubFetchWith(EMPTY_PLY);
		render(ModelViewer, { props: PROPS });

		// 既存の失敗経路の文言そのもの(実装前は「Not a supported 3D model
		// extension: …」が出るため、この一致判定が赤の根拠になる)。
		await vi.waitFor(() => {
			expect(document.querySelector('.model-message')?.textContent ?? '').toBe(
				'The model has no drawable geometry',
			);
		});

		// 統計表示は出ない(points / triangles のどちらも)。
		expect(document.querySelector('.model-stats')).toBeNull();

		// エラー経路は ensureScene の手前で決まる= 3D の描画面(canvas)は作られない。
		expect(captured.constructed).toBe(0);
		expect(document.querySelector('.model-stage canvas')).toBeNull();
	});
});
