/**
 * 要件#23 追補a の受け入れテスト — ModelViewer の `loadModel` の世代の確かめ
 * (docs/requirements/req-23.md「追補a」・AC-23-追a (a)〜(c)・Issue #423 = backlog 53)
 *
 * `src` が続けて2回変わると(監視中のファイルが続けて書き換わる= `binary_file_changed` で
 * 版数付きの `src` が続けて降る)、遅れて届いた古い読み込みが新しい表示を上書きしうる。
 *
 * ## 契約(追補a)
 * 1. 読み込みごとに世代を振り、読み込み(fetch・解析)が終わった時点でその世代が最新で
 *    なければ結果を表示に載せない(作った形状・材質は捨てる= dispose)
 * 2. 古い読み込みの失敗も、最新でなければ表示しない(エラーの表示で新しい表示を消さない)
 * 3. 不変: 1回だけの読み込みの振る舞い・256 MB の上限・カメラの扱い・エラーの文言
 *
 * ## 観測方式(OBJ / PLY / SpaceMouse の wiring テストと同じ家風)
 *
 * JSDOM には WebGL が無いので `vi.mock('three')` で `WebGLRenderer` だけをスタブ(render に
 * 渡された Scene と camera を記録)に差し替え、残りは本物。fetch は **`src` ごとに応答を
 * 変える偽 Response** で、A(古い `src`)の本文(`arrayBuffer()`)を deferred で止めておき、
 * B(新しい `src`)が表示された**後**に解放する= 「A の読み込みを B より後に終わらせる」。
 * (b)-2 では同じ deferred を **reject** して「fetch 側の失敗の遅着」(実機では通信の失敗・
 * HTTP エラーの遅着)を作る= 本文も解析も無いまま `catch` 節へ入る経路。
 *
 * これに加えて `$lib/model-viewing` の `parseModel` を**素通しの包み**で差し替える(結果は
 * 本物のまま返す)。目的は2つ ――
 * - 解析結果の形状・材質に `dispose` のスパイを仕掛け、「A の形状は dispose される・B の
 *   形状は dispose されない」を実体で判定する(A はシーンに入らないので、他に掴む手が無い)
 * - (a)-2 では **解析の完了**を止める(本文は届いて解析も済んだが、`parseModel` の解決だけ
 *   B の後にする)。契約1 は「fetch・解析が終わった時点で」確かめると言っており、fetch 直後
 *   だけ見て解析後を見ない実装を通さないため
 *
 * 判定は振る舞いで行う(世代トークンの持ち方・変数名は実装裁量):
 * - ツールバーの `.model-stats`(B = 4 triangles / A = 12 triangles。数が違うこと自体が
 *   「どちらが載ったか」の判定材料)・`.model-message`(Loading… / エラー)の有無
 * - スタブ renderer に渡った Scene に居る Mesh(B の形状だけ・A の 36 頂点の形状は居ない)
 * - 形状・材質の `dispose` スパイ
 * - render に渡った camera の姿勢の値コピー(A が載れば bounds が違うので視点が変わる=
 *   「カメラの扱い」不変の確認)
 *
 * ## 確定契約(implementer はこれに従う)
 * - `ModelViewer.svelte` の `loadModel` に世代を持たせる。古い世代の結果は `load` にも
 *   シーンにもカメラにも載せず、作った形状・材質は dispose する
 * - 古い世代の失敗は `load` を `error` にせず、今のモデル(B)を `disposeModel` しない
 * - 1回だけの読み込み・順番どおりの A → B(A が先に完了)・256 MB の上限と文言は不変
 *
 * 実装前に赤い理由: 現行の `loadModel` に世代の確かめが無く、A の遅着は `disposeModel`(B を
 * 捨てる)→ A をシーンへ → `load = ready(12 triangles)` と進み、A の遅い失敗は
 * `disposeModel` → `load = error` と進む((a)-1 / (a)-2 / (a)-3 / (b) が赤)。(c) の3件は
 * 不変条件の退行防止で最初から緑。
 *
 * (b)-2 は reviewer の差し戻し(P2)で実装後に足した分: (b) は本文が届いてから解析で失敗する
 * 経路(= `arrayBuffer()` 後の世代の確かめを通り抜けてから `catch` へ入る)しか踏まないので、
 * 本文が届く前に fetch 側で失敗する経路(`arrayBuffer()` の reject)を別に押さえる。現実装では
 * 緑。`catch` 節の `if (!isCurrent()) return;` を外す変異では `disposeModel`(B を捨てる)→
 * `load = error` と進むので、`.model-message` が出て `.model-stats` が消え、B の dispose
 * スパイが呼ばれて赤になる。要件#23 追補b(4)(2026-10-19)で、(b)-2 は A の `arrayBuffer()` が
 * 呼ばれてから B へ切り替える段取りに改めた(追補b の 2= fetch 直後の世代の確かめで A が本文を
 * 読まずに抜けると、reject させる本文の promise を誰も待たないため。判定は不変)。
 *
 * スタブ(既存 wiring テストの家風): ResizeObserver = no-op・requestAnimationFrame = 即時実行・
 * `$lib/events` の listen = no-op(SpaceMouse 購読)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

/** dispose を持つもの(BufferGeometry / Material)。 */
type Disposable = { dispose: () => void };

/** `parseModel` の結果の記録。形状・材質には dispose のスパイを仕掛けてある。 */
interface ParsedRecord {
	triangleCount: number;
	geometries: Disposable[];
	materials: Disposable[];
}

const captured = vi.hoisted(() => ({
	/** スタブ renderer の render に渡された Scene(同一インスタンス=今のシーンの状態を見られる)。 */
	scenes: [] as unknown[],
	/** スタブ renderer の render に渡された camera(参照。姿勢は都度コピーして比べる)。 */
	cameras: [] as unknown[],
	/** スタブ renderer が生成された回数。 */
	constructed: 0,
	/** `parseModel` の結果(解決順)。 */
	parsed: [] as ParsedRecord[],
	/**
	 * 解析の完了を止める指示。`byteLength` が一致する入力の `parseModel` は、本物の解析を
	 * 済ませて記録した後、`promise` が解決するまで返らない((a)-2 用)。
	 */
	holdParse: null as null | { byteLength: number; promise: Promise<void> },
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
		render(scene: unknown, camera: unknown): void {
			captured.scenes.push(scene);
			captured.cameras.push(camera);
		}
		dispose(): void {}
	}
	return { ...actual, WebGLRenderer: StubWebGLRenderer };
});

// parseModel は素通し(結果は本物)。結果の形状・材質に dispose のスパイを仕掛け、
// 指示があれば解決だけを止める。
vi.mock('$lib/model-viewing', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/model-viewing')>();
	return {
		...actual,
		parseModel: vi.fn(async (nameOrUri: string, buffer: ArrayBuffer) => {
			const parsed = await actual.parseModel(nameOrUri, buffer);
			const record: ParsedRecord = {
				triangleCount: parsed.triangleCount,
				geometries: [],
				materials: [],
			};
			parsed.object.traverse((node) => {
				const mesh = node as { geometry?: Disposable; material?: unknown };
				if (mesh.geometry) {
					vi.spyOn(mesh.geometry, 'dispose');
					record.geometries.push(mesh.geometry);
				}
				const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
				for (const material of materials) {
					const m = material as Disposable | undefined;
					if (m && typeof m.dispose === 'function') {
						vi.spyOn(m, 'dispose');
						record.materials.push(m);
					}
				}
			});
			captured.parsed.push(record);
			const hold = captured.holdParse;
			if (hold && hold.byteLength === buffer.byteLength) await hold.promise;
			return parsed;
		}),
	};
});

import type { Mesh, Object3D, PerspectiveCamera } from 'three';
import ModelViewer from './ModelViewer.svelte';

// ---------------------------------------------------------------------------
// フィクスチャ。同じファイル(uri)の版違い= src だけが変わる(imageSrcWithVersion の形)。
// A と B は三角形数も bounds も違う= どちらが載ったかを数と視点で判定できる。
// ---------------------------------------------------------------------------

/** A: 立方体 [0,5]^3・12 三角形(OBJLoader は非インデックス= position 36 頂点)。 */
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

/** B: 四面体 [0,10]^3・4 三角形(position 12 頂点)。 */
const TETRA_OBJ = `v 0 0 0
v 10 0 0
v 0 10 0
v 0 0 10
f 1 2 3
f 1 2 4
f 1 3 4
f 2 3 4
`;

/** 幾何の無い OBJ(コメントだけ)= 既存の失敗経路(The model has no drawable geometry)。 */
const EMPTY_OBJ = `# just a comment, no geometry
`;

const CUBE_POSITIONS = 36;
const TETRA_POSITIONS = 12;

const URI = 'file:///Users/a/models/part.obj';
/** 版 1(古い方= A)。`imageSrcWithVersion(src, 1)` の形。 */
const SRC_A = 'vellis-asset://local/Users/a/models/part.obj?v=1';
/** 版 2(新しい方= B)。 */
const SRC_B = 'vellis-asset://local/Users/a/models/part.obj?v=2';

function bytesOf(source: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(source);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

class NoopResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

/**
 * fetch を「src ごとに本文の取り方が違う偽 Response」に固定する。
 * 値は `arrayBuffer()` の実装= 即時に返すか、deferred で止めるか。
 */
function stubFetchByUrl(table: Record<string, () => Promise<ArrayBuffer>>): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request) => {
			const key = String(input);
			const body = table[key];
			if (!body) throw new Error(`unexpected fetch in test: ${key}`);
			return { ok: true, status: 200, arrayBuffer: body };
		}),
	);
}

/** 保留中の読み込みの続き(マイクロタスク)を全部流し、Svelte の更新も反映する。 */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
}

function statsText(): string | null {
	return document.querySelector('.model-stats')?.textContent ?? null;
}

function messageText(): string | null {
	return document.querySelector('.model-message')?.textContent ?? null;
}

function lastScene(): Object3D {
	expect(captured.scenes.length, 'スタブ renderer へ描画要求が届いていること').toBeGreaterThan(0);
	return captured.scenes.at(-1) as Object3D;
}

function lastCamera(): PerspectiveCamera {
	expect(captured.cameras.length, 'スタブ renderer へ描画要求が届いていること').toBeGreaterThan(0);
	return captured.cameras.at(-1) as PerspectiveCamera;
}

function meshesIn(scene: Object3D): Mesh[] {
	const meshes: Mesh[] = [];
	scene.traverse((child) => {
		if ((child as Mesh).isMesh) meshes.push(child as Mesh);
	});
	return meshes;
}

function positionCount(mesh: Mesh): number {
	return mesh.geometry.getAttribute('position')?.count ?? 0;
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

function recordWithTriangles(count: number): ParsedRecord | undefined {
	return captured.parsed.find((p) => p.triangleCount === count);
}

function expectDisposed(record: ParsedRecord, label: string): void {
	expect(record.geometries.length, `${label}: 形状があること`).toBeGreaterThan(0);
	for (const geometry of record.geometries) {
		expect(geometry.dispose, `${label}: 形状が dispose されること`).toHaveBeenCalled();
	}
	for (const material of record.materials) {
		expect(material.dispose, `${label}: 材質が dispose されること`).toHaveBeenCalled();
	}
}

function expectNotDisposed(record: ParsedRecord, label: string): void {
	expect(record.geometries.length, `${label}: 形状があること`).toBeGreaterThan(0);
	for (const geometry of record.geometries) {
		expect(geometry.dispose, `${label}: 形状が dispose されないこと`).not.toHaveBeenCalled();
	}
	for (const material of record.materials) {
		expect(material.dispose, `${label}: 材質が dispose されないこと`).not.toHaveBeenCalled();
	}
}

/** 今のシーンに居るのが B の形状(四面体 1 つ)だけで、A の形状(36 頂点)が居ないこと。 */
function expectSceneShowsOnlyB(): void {
	const meshes = meshesIn(lastScene());
	expect(meshes.length, 'シーンの Mesh は B の 1 つだけ').toBe(1);
	expect(positionCount(meshes[0]), 'B(四面体)の頂点数').toBe(TETRA_POSITIONS);
	const b = recordWithTriangles(4);
	expect(b, 'B の解析結果が記録されていること').toBeDefined();
	expect(b!.geometries, 'シーンの Mesh の形状は B の解析結果そのもの').toContain(meshes[0].geometry);
	expect(
		meshes.some((m) => positionCount(m) === CUBE_POSITIONS),
		'A(立方体・36 頂点)の形状はシーンに居ない',
	).toBe(false);
}

/**
 * B を表示済みの状態を作る: A を止めたまま src を B に変え、B の表示(4 triangles)を待つ。
 *
 * `aReached` は「A がどこまで進んでから B へ切り替えるか」の確かめ(`vi.waitFor` で満たされる
 * まで待つ)。既定は A の fetch が呼ばれた時点。(b)-2 は A の `arrayBuffer()` が呼ばれた時点
 * (要件#23 追補b(4)・2026-10-19)。
 */
async function mountAThenShowB(
	aReached: () => void = () => {
		expect(globalThis.fetch).toHaveBeenCalledWith(SRC_A);
	},
): Promise<void> {
	const { rerender } = render(ModelViewer, { props: { uri: URI, src: SRC_A } });
	await vi.waitFor(aReached);
	expect(messageText(), 'A は止めてあるので Loading… のまま').toContain('Loading…');

	await rerender({ uri: URI, src: SRC_B });
	await vi.waitFor(() => {
		expect(statsText()).toBe('4 triangles');
	});
	expect(messageText(), 'B の表示中にプレースホルダは出ない').toBeNull();
	expectSceneShowsOnlyB();
}

beforeEach(() => {
	captured.scenes.length = 0;
	captured.cameras.length = 0;
	captured.constructed = 0;
	captured.parsed.length = 0;
	captured.holdParse = null;
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

describe('ModelViewer × loadModel の世代の確かめ(要件#23 追補a・AC-23-追a)', () => {
	// -----------------------------------------------------------------------
	// (a) src を A → B と続けて変え、A の読み込みを B より後に終わらせると、表示は B のまま
	// -----------------------------------------------------------------------

	it('AC-23-追a (a)-1: A の本文が B の表示後に届いても、表示は B のまま(A の形状は載らず dispose・B は保持・視点不変)', async () => {
		const gateA = deferred<ArrayBuffer>();
		stubFetchByUrl({
			[SRC_A]: () => gateA.promise,
			[SRC_B]: async () => bytesOf(TETRA_OBJ),
		});
		await mountAThenShowB();
		const b = recordWithTriangles(4)!;
		const poseB = poseOf(lastCamera());

		// A の読み込みを B より後に終わらせる。
		gateA.resolve(bytesOf(CUBE_OBJ));
		await settle();

		expect(statsText(), '表示は B のまま').toBe('4 triangles');
		expect(messageText(), 'エラーも Loading… も出ない').toBeNull();
		expectSceneShowsOnlyB();
		expectNotDisposed(b, 'B');
		// A の形状が作られたなら(解析まで進んだなら)捨てられている。世代の確かめを
		// 本文の到着直後に置く実装では A は解析されず、作られもしない(それも契約内)。
		const a = recordWithTriangles(12);
		if (a) expectDisposed(a, 'A(遅着)');
		expect(poseOf(lastCamera()), 'カメラは B の視点のまま(A の bounds で組み直さない)').toEqual(poseB);
	});

	it('AC-23-追a (a)-2: A の解析が B の表示後に終わっても、表示は B のまま(作った A の形状・材質は dispose される)', async () => {
		// A の本文は即届くが、解析の完了だけを止める(契約1「fetch・解析が終わった時点で」)。
		const cubeBytes = bytesOf(CUBE_OBJ);
		expect(cubeBytes.byteLength, 'A と B は byteLength で区別できること').not.toBe(
			bytesOf(TETRA_OBJ).byteLength,
		);
		const parseGateA = deferred<void>();
		captured.holdParse = { byteLength: cubeBytes.byteLength, promise: parseGateA.promise };
		stubFetchByUrl({
			[SRC_A]: async () => cubeBytes,
			[SRC_B]: async () => bytesOf(TETRA_OBJ),
		});

		const { rerender } = render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		// A は本物の解析を済ませた(形状が作られた)うえで止まっている。
		await vi.waitFor(() => {
			expect(recordWithTriangles(12)).toBeDefined();
		});
		expect(messageText(), 'A の解析は止めてあるので Loading… のまま').toContain('Loading…');

		await rerender({ uri: URI, src: SRC_B });
		await vi.waitFor(() => {
			expect(statsText()).toBe('4 triangles');
		});
		expectSceneShowsOnlyB();
		const a = recordWithTriangles(12)!;
		const b = recordWithTriangles(4)!;
		const poseB = poseOf(lastCamera());

		// A の解析を B より後に終わらせる。
		parseGateA.resolve();
		await settle();

		expect(statsText(), '表示は B のまま').toBe('4 triangles');
		expect(messageText(), 'エラーも Loading… も出ない').toBeNull();
		expectSceneShowsOnlyB();
		expectDisposed(a, 'A(遅着)');
		expectNotDisposed(b, 'B');
		expect(poseOf(lastCamera()), 'カメラは B の視点のまま').toEqual(poseB);
	});

	it('AC-23-追a (a)-3: B がまだ読み込み中に A が届いても A は載らず(Loading… のまま)、B が届いたら B が出る', async () => {
		const gateA = deferred<ArrayBuffer>();
		const gateB = deferred<ArrayBuffer>();
		stubFetchByUrl({
			[SRC_A]: () => gateA.promise,
			[SRC_B]: () => gateB.promise,
		});
		const { rerender } = render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(globalThis.fetch).toHaveBeenCalledWith(SRC_A);
		});
		await rerender({ uri: URI, src: SRC_B });
		await vi.waitFor(() => {
			expect(globalThis.fetch).toHaveBeenCalledWith(SRC_B);
		});
		expect(messageText()).toContain('Loading…');

		// 古い A が先に届く(最新は B・まだ読み込み中)。
		gateA.resolve(bytesOf(CUBE_OBJ));
		await settle();

		expect(statsText(), 'A の三角形数は出ない(最新は B)').toBeNull();
		expect(messageText(), 'B の読み込み中のまま').toContain('Loading…');
		for (const scene of captured.scenes) {
			expect(
				meshesIn(scene as Object3D).some((m) => positionCount(m) === CUBE_POSITIONS),
				'A の形状はシーンに入らない',
			).toBe(false);
		}
		const a = recordWithTriangles(12);
		if (a) expectDisposed(a, 'A(古い世代)');

		// 最新の B が届く → B が出る。
		gateB.resolve(bytesOf(TETRA_OBJ));
		await vi.waitFor(() => {
			expect(statsText()).toBe('4 triangles');
		});
		expect(messageText()).toBeNull();
		expectSceneShowsOnlyB();
		expectNotDisposed(recordWithTriangles(4)!, 'B');
	});

	// -----------------------------------------------------------------------
	// (b) A の読み込みが B より後に失敗しても、エラーは出ず B が出たまま
	// -----------------------------------------------------------------------

	it('AC-23-追a (b): A の読み込みが B の表示後に失敗しても、エラーは出ず B が出たまま(B は dispose されない・視点不変)', async () => {
		const gateA = deferred<ArrayBuffer>();
		stubFetchByUrl({
			[SRC_A]: () => gateA.promise,
			[SRC_B]: async () => bytesOf(TETRA_OBJ),
		});
		await mountAThenShowB();
		const b = recordWithTriangles(4)!;
		const poseB = poseOf(lastCamera());

		// A の本文は届くが幾何が無い= 既存の失敗経路(The model has no drawable geometry)で
		// 遅れて失敗する。
		gateA.resolve(bytesOf(EMPTY_OBJ));
		await settle();

		expect(messageText(), '古い世代の失敗はエラーとして出さない').toBeNull();
		expect(statsText(), 'B が出たまま').toBe('4 triangles');
		expectSceneShowsOnlyB();
		expectNotDisposed(b, 'B');
		expect(poseOf(lastCamera()), 'カメラは B の視点のまま').toEqual(poseB);
	});

	it('AC-23-追a (b)-2: A の fetch 側の失敗(arrayBuffer の reject)が B の表示後に届いても、エラーは出ず B が出たまま(B は dispose されない・視点不変)', async () => {
		const gateA = deferred<ArrayBuffer>();
		const bodyA = vi.fn(() => gateA.promise);
		stubFetchByUrl({
			[SRC_A]: bodyA,
			[SRC_B]: async () => bytesOf(TETRA_OBJ),
		});
		// A の `arrayBuffer()` が呼ばれた(本文を待ち始めた)のを待ってから B へ切り替える
		// (要件#23 追補b(4)・2026-10-19)。fetch が呼ばれた時点で切り替えると、追補b の 2
		// (fetch 直後の世代の確かめ)で A は本文を読まずに抜け、下で reject させる gateA を
		// 誰も待たない(未処理の reject)。(b)-2 の意図= 本文の読み込みの途中の失敗の遅着。
		await mountAThenShowB(() => {
			expect(bodyA, 'A は本文を待ち始めている').toHaveBeenCalledTimes(1);
		});
		const b = recordWithTriangles(4)!;
		const poseB = poseOf(lastCamera());
		const parsedBefore = captured.parsed.length;

		// A の本文は届かず、fetch 側で失敗が遅れて届く(実機では通信の失敗・HTTP エラーの
		// 遅着)。本文も解析も無いまま `loadModel` の catch 節へ入る経路。
		gateA.reject(new TypeError('Failed to fetch'));
		await settle();

		expect(messageText(), '古い世代の fetch 側の失敗はエラーとして出さない').toBeNull();
		expect(statsText(), 'B が出たまま').toBe('4 triangles');
		expectSceneShowsOnlyB();
		expectNotDisposed(b, 'B');
		expect(captured.parsed.length, 'A は本文が無いので解析されない').toBe(parsedBefore);
		expect(poseOf(lastCamera()), 'カメラは B の視点のまま').toEqual(poseB);
	});

	// -----------------------------------------------------------------------
	// (c) 1回だけの読み込みは今までどおり表示される(不変条件・退行防止)
	// -----------------------------------------------------------------------

	it('AC-23-追a (c)-1: 1回だけの読み込みは今までどおり表示される(12 triangles・形状がシーンに居る)', async () => {
		stubFetchByUrl({ [SRC_A]: async () => bytesOf(CUBE_OBJ) });
		render(ModelViewer, { props: { uri: URI, src: SRC_A } });

		await vi.waitFor(() => {
			expect(statsText()).toBe('12 triangles');
		});
		expect(messageText()).toBeNull();
		const meshes = meshesIn(lastScene());
		expect(meshes.length).toBe(1);
		expect(positionCount(meshes[0])).toBe(CUBE_POSITIONS);
		expectNotDisposed(recordWithTriangles(12)!, 'A');
	});

	it('AC-23-追a (c)-2: 順番どおり A → B(A が先に完了)なら B に切り替わり、A の形状は dispose される(従来どおり)', async () => {
		stubFetchByUrl({
			[SRC_A]: async () => bytesOf(CUBE_OBJ),
			[SRC_B]: async () => bytesOf(TETRA_OBJ),
		});
		const { rerender } = render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(statsText()).toBe('12 triangles');
		});
		const a = recordWithTriangles(12)!;

		await rerender({ uri: URI, src: SRC_B });
		await vi.waitFor(() => {
			expect(statsText()).toBe('4 triangles');
		});
		expect(messageText()).toBeNull();
		expectSceneShowsOnlyB();
		expectDisposed(a, 'A(切替前)');
		expectNotDisposed(recordWithTriangles(4)!, 'B');
	});

	it('AC-23-追a (c)-3: 256 MB の上限と文言は不変(The file is too large (257MB; limit 256MB))', async () => {
		// 本体を確保せず byteLength だけを名乗る偽バッファ(ModelViewer は上限判定で
		// byteLength しか見ない)。257 MB を実際に確保してテストを重くしないため。
		const oversized = { byteLength: 257 * 1024 * 1024 } as unknown as ArrayBuffer;
		stubFetchByUrl({ [SRC_A]: async () => oversized });
		render(ModelViewer, { props: { uri: URI, src: SRC_A } });

		await vi.waitFor(() => {
			expect(messageText()).toBe('The file is too large (257MB; limit 256MB)');
		});
		expect(statsText()).toBeNull();
		expect(captured.constructed, '上限超えは ensureScene の手前で決まる= canvas は作られない').toBe(0);
	});
});
