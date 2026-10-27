/**
 * 要件#23 追補b の受け入れテスト — 外れたあとの読み込みと、fetch 直後の世代の確かめ
 * (docs/requirements/req-23.md「追補b」(2026-10-19)・AC-23-追b (a)〜(c)・Issue #703)
 *
 * 追補a(世代の確かめ)のあとも、読み込みの途中でコンポーネントが外れると、遅れて終わった
 * 読み込みが `ensureScene(host)` を呼び、外れた host に renderer(WebGL の context)を
 * 作り直して、その後は解放しない。あわせて、最新でない読み込みも本文(`arrayBuffer()`)を
 * 最後まで読む。
 *
 * ## 契約(追補b)
 * 1. コンポーネントが外れたら世代を進める(追補a の確かめがそのまま効き、外れたあとに
 *    終わった読み込みは何も作らない= renderer を作り直さない)
 * 2. `await fetch()` の直後にも世代を確かめ、最新でなければ本文を読まずに抜ける
 * 3. 不変: 追補a の振る舞い・1回だけの読み込み・256 MB の上限
 *    (= `ModelViewer.generation.wiring.test.ts` が無改変で緑 = AC (c)。このファイルでは扱わない)
 *
 * ## 観測方式(`ModelViewer.generation.wiring.test.ts` と同じ家風)
 *
 * JSDOM には WebGL が無いので `vi.mock('three')` で `WebGLRenderer` だけをスタブ(生成回数と
 * render に渡された Scene を記録)に差し替え、残りは本物。fetch は **`src` ごとに応答を変える
 * 偽 Response** で、ここでは追補a のテストより一段手前= **fetch そのものの解決**も deferred で
 * 止められる形にし、Response の `arrayBuffer` を `vi.fn` にして「呼ばれたかどうか」を見る。
 * `$lib/model-viewing` の `parseModel` は素通しの包み(結果は本物)で、形状・材質に dispose
 * のスパイを仕掛け、指示があれば解析の完了だけを止める((a)-2 用)。
 *
 * 判定は振る舞いで行う(世代の進め方・フラグの持ち方は実装裁量):
 * - (a): `unmount()` のあとに読み込みを終わらせても、スタブ renderer が1度も生成されない
 *   (`captured.constructed === 0`)・描画要求も出ない。形状は作られたなら dispose されている
 *   ((a)-2 は解析まで済ませているので必ず dispose)
 * - (b): A → B のあと A の fetch を解決しても、A の Response の `arrayBuffer` は呼ばれず、
 *   表示は B のまま(stats・シーンの Mesh・B の dispose スパイ・カメラ姿勢)
 *
 * 実装前に赤い理由: 外れても `loadGeneration` は進まないので、外れたあとに本文・解析が終わると
 * `isCurrent()` が真のまま `ensureScene(host)` へ進み、スタブ renderer が生成される((a)-1 /
 * (a)-2 が赤)。`await fetch()` の直後に世代の確かめが無いので、外れたあと((a)-3)も B の
 * 表示後((b))も A の `arrayBuffer()` が呼ばれる((a)-3 / (b) が赤)。
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
	/** スタブ renderer が生成された回数(= `new WebGLRenderer` の回数)。 */
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

/** `ModelViewer` が fetch の応答に求めるもの(ok / status / arrayBuffer)だけを持つ偽 Response。 */
interface FakeResponse {
	ok: boolean;
	status: number;
	arrayBuffer: () => Promise<ArrayBuffer>;
}

/** すぐ届く 200 応答。本文の取り方(`arrayBuffer`)は呼び出し側が渡す。 */
function okResponse(arrayBuffer: () => Promise<ArrayBuffer>): FakeResponse {
	return { ok: true, status: 200, arrayBuffer };
}

/**
 * fetch を「src ごとに応答の届き方が違う偽 Response」に固定する。
 * 値は fetch の戻り= Response の Promise(fetch そのものを deferred で止められる)。
 */
function stubFetchResponses(table: Record<string, () => Promise<FakeResponse>>): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request) => {
			const key = String(input);
			const respond = table[key];
			if (!respond) throw new Error(`unexpected fetch in test: ${key}`);
			return respond();
		}),
	);
}

/** 要求に `Range` ヘッダが付いているか(`init.headers` は素のオブジェクト・`Headers`・タプル配列のどれでも)。 */
function hasRangeHeader(init: RequestInit | undefined): boolean {
	const headers = init?.headers;
	if (!headers) return false;
	if (typeof (headers as Headers).get === 'function') return (headers as Headers).get('range') !== null;
	const entries: [string, string][] = Array.isArray(headers)
		? (headers as [string, string][])
		: Object.entries(headers as Record<string, string>);
	return entries.some(([name]) => name.toLowerCase() === 'range');
}

/**
 * 要件#23 追補d(5) の改め直し(2026-10-20): 読み込みは本文の前に `Range: bytes=0-0` の問い合わせを送る
 * (追補d 契約 1)。fetch を止める 3 件((a)-3・(b)・content-length の契約 3)では、**Range の付いた要求には
 * すぐ 200(`Content-Range` なし= 追補d 契約 2 で本文へ進む)で答え、Range の無い要求(本文)だけを今までどおり
 * `table` の deferred で止める**。こうして止まるのが本文の fetch になり、本来確かめていた経路(本文の fetch の
 * 直後の世代の確かめ)を通る。待ち方(`toHaveBeenCalledWith(SRC_A)`= 引数 1 つの本文の fetch)と判定は不変。
 */
function stubFetchResponsesAnsweringProbe(
	table: Record<string, () => Promise<FakeResponse>>,
): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const key = String(input);
			const respond = table[key];
			if (!respond) throw new Error(`unexpected fetch in test: ${key}`);
			if (hasRangeHeader(init)) {
				return {
					ok: true,
					status: 200,
					headers: { get: (_name: string): string | null => null },
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			}
			return respond();
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

/** 外れたあとに読み込みが終わっても何も作られないこと(renderer 生成 0・描画要求 0)。 */
function expectNothingBuiltAfterUnmount(): void {
	expect(captured.constructed, '外れたあとに renderer(WebGLRenderer)は作られない').toBe(0);
	expect(captured.scenes.length, '外れたあとに描画要求も出ない').toBe(0);
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

describe('ModelViewer × 外れたあとの読み込み・fetch 直後の世代の確かめ(要件#23 追補b・AC-23-追b)', () => {
	// -----------------------------------------------------------------------
	// (a) 読み込みの途中でコンポーネントを外し、そのあと読み込みを終わらせると、
	//     renderer(WebGLRenderer)は作られず、形状は dispose される(または解析されない)
	// -----------------------------------------------------------------------

	it('AC-23-追b (a)-1: 本文(arrayBuffer)の到着前に外し、そのあと本文が届いても renderer は作られない(A は解析されないか dispose される)', async () => {
		const bodyGate = deferred<ArrayBuffer>();
		const arrayBufferA = vi.fn(() => bodyGate.promise);
		stubFetchResponses({ [SRC_A]: async () => okResponse(arrayBufferA) });

		const { unmount } = render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		// fetch は解決済みで、本文の取得(arrayBuffer)で止まっている= 読み込みの途中。
		await vi.waitFor(() => {
			expect(arrayBufferA).toHaveBeenCalledTimes(1);
		});
		expect(messageText(), '本文は止めてあるので Loading… のまま').toContain('Loading…');
		expect(captured.constructed, '前提: 外す前に renderer は無い').toBe(0);

		unmount();
		// 外れたあとに本文が届く= 読み込みが終わる。
		bodyGate.resolve(bytesOf(CUBE_OBJ));
		await settle();

		expectNothingBuiltAfterUnmount();
		// 形状が作られたなら(解析まで進んだなら)捨てられている。fetch 直後・本文直後の
		// 世代の確かめで抜ける実装では A は解析されず、作られもしない(それも契約内)。
		const a = recordWithTriangles(12);
		if (a) expectDisposed(a, 'A(外れたあとの遅着)');
	});

	it('AC-23-追b (a)-2: 解析の途中で外し、そのあと解析が終わっても renderer は作られず、作った形状・材質は dispose される', async () => {
		// A の本文は即届くが、解析の完了だけを止める(追補a (a)-2 と同じ仕掛け)。
		const cubeBytes = bytesOf(CUBE_OBJ);
		const parseGate = deferred<void>();
		captured.holdParse = { byteLength: cubeBytes.byteLength, promise: parseGate.promise };
		stubFetchResponses({ [SRC_A]: async () => okResponse(async () => cubeBytes) });

		const { unmount } = render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		// A は本物の解析を済ませた(形状が作られた)うえで止まっている。
		await vi.waitFor(() => {
			expect(recordWithTriangles(12)).toBeDefined();
		});
		expect(messageText(), '解析は止めてあるので Loading… のまま').toContain('Loading…');
		expect(captured.constructed, '前提: 外す前に renderer は無い').toBe(0);
		const a = recordWithTriangles(12)!;

		unmount();
		// 外れたあとに解析が終わる= 読み込みが終わる。
		parseGate.resolve();
		await settle();

		expectNothingBuiltAfterUnmount();
		expectDisposed(a, 'A(外れたあとの遅着)');
	});

	it('AC-23-追b (a)-3(契約1+2): fetch の解決前に外し、そのあと fetch が解決しても本文(arrayBuffer)は読まず、renderer も作られない', async () => {
		const fetchGate = deferred<FakeResponse>();
		const arrayBufferA = vi.fn(async () => bytesOf(CUBE_OBJ));
		// 要件#23 追補d(5) の改め直し(2026-10-20): 問い合わせ(Range 付き)にはすぐ 200 で答え、本文の fetch だけを止める。
		stubFetchResponsesAnsweringProbe({ [SRC_A]: () => fetchGate.promise });

		const { unmount } = render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		// fetch は呼ばれたが、まだ解決していない= 読み込みの途中。
		await vi.waitFor(() => {
			expect(globalThis.fetch).toHaveBeenCalledWith(SRC_A);
		});
		expect(messageText(), 'fetch は止めてあるので Loading… のまま').toContain('Loading…');

		unmount();
		// 外れたあとに fetch が解決する。
		fetchGate.resolve(okResponse(arrayBufferA));
		await settle();

		expect(arrayBufferA, '最新でない読み込みは本文を読まない').not.toHaveBeenCalled();
		expect(captured.parsed.length, '本文が無いので解析もされない').toBe(0);
		expectNothingBuiltAfterUnmount();
	});

	// -----------------------------------------------------------------------
	// (b) A → B と変えたとき、A の fetch が B より後に解決しても、A の arrayBuffer() は呼ばれない
	// -----------------------------------------------------------------------

	it('AC-23-追b (b): A → B のあと A の fetch が B の表示後に解決しても、A の arrayBuffer() は呼ばれず、表示は B のまま', async () => {
		const fetchGateA = deferred<FakeResponse>();
		const arrayBufferA = vi.fn(async () => bytesOf(CUBE_OBJ));
		// 要件#23 追補d(5) の改め直し(2026-10-20): 問い合わせ(Range 付き)にはすぐ 200 で答え、本文の fetch だけを止める。
		stubFetchResponsesAnsweringProbe({
			[SRC_A]: () => fetchGateA.promise,
			[SRC_B]: async () => okResponse(async () => bytesOf(TETRA_OBJ)),
		});

		const { rerender } = render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(globalThis.fetch).toHaveBeenCalledWith(SRC_A);
		});
		expect(messageText(), 'A の fetch は止めてあるので Loading… のまま').toContain('Loading…');

		await rerender({ uri: URI, src: SRC_B });
		await vi.waitFor(() => {
			expect(statsText()).toBe('4 triangles');
		});
		expect(messageText(), 'B の表示中にプレースホルダは出ない').toBeNull();
		expectSceneShowsOnlyB();
		const b = recordWithTriangles(4)!;
		const poseB = poseOf(lastCamera());
		const parsedBefore = captured.parsed.length;
		const constructedBefore = captured.constructed;

		// A の fetch を B の表示後に解決する。
		fetchGateA.resolve(okResponse(arrayBufferA));
		await settle();

		expect(arrayBufferA, '最新でない A の本文(arrayBuffer)は読まれない').not.toHaveBeenCalled();
		expect(captured.parsed.length, 'A は解析されない').toBe(parsedBefore);
		expect(statsText(), '表示は B のまま').toBe('4 triangles');
		expect(messageText(), 'エラーも Loading… も出ない').toBeNull();
		expectSceneShowsOnlyB();
		expectNotDisposed(b, 'B');
		expect(captured.constructed, 'renderer は作り直されない').toBe(constructedBefore);
		expect(poseOf(lastCamera()), 'カメラは B の視点のまま').toEqual(poseB);
	});
});
