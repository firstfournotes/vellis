/**
 * 要件#23 追補c の受け入れテスト — ModelViewer の `Content-Length` の先読み
 * (docs/requirements/req-23.md「追補c」(2026-10-19)・AC-23-追c (a)〜(c)・Issue #422 = backlog 52)
 *
 * `ModelViewer.svelte` の 256 MB の上限の判定は `arrayBuffer()` の後なので、上限を超えるファイルも
 * 一度は全部メモリに載る。
 *
 * ## 契約(追補c)
 * 1. 応答に `Content-Length` があり、256 MB を超えていれば、`arrayBuffer()` を呼ばずに今と同じ
 *    文言のエラーにする(`The file is too large (<n>MB; limit 256MB)`。n は `Content-Length` から)
 * 2. `Content-Length` が無い・数でない・上限以下のときは今のまま(`arrayBuffer()` の後の判定も残す)
 * 3. 不変: 文言・上限の値・世代の確かめ(追補a・b)
 *
 * ## 観測方式(`ModelViewer.generation.wiring.test.ts` / `ModelViewer.stale-load.wiring.test.ts` と同じ家風)
 *
 * JSDOM には WebGL が無いので `vi.mock('three')` で `WebGLRenderer` だけをスタブ(生成回数と render に
 * 渡された Scene を記録)に差し替え、残りは本物。fetch は **`src` ごとに応答を変える偽 Response** で、
 * ここでは `headers.get('content-length')` の返り値を場合ごとに変え(`audio-viewing.acceptance.test.ts`
 * の `fakeAudioResponse` と同じ最小の headers= `get` だけ・名前は大文字小文字を問わない)、
 * `arrayBuffer` を `vi.fn` にして「呼ばれたかどうか」を見る。`$lib/model-viewing` の `parseModel` は
 * 素通しの包み(結果は本物)で「解析に進んだか」を数える。
 *
 * 判定は振る舞いで行う(ヘッダの読み方・数の変換の仕方は実装裁量):
 * - (a): `Content-Length` が上限超なら `arrayBuffer` が 1 度も呼ばれず、解析もされず、renderer も
 *   作られず、`.model-message` に今と同じ文言(n は `Content-Length` を MiB に丸めた値= 今の
 *   `Math.round(bytes / (1024 * 1024))` と同じ)が出る。本文には**小さな本物の OBJ** を置いて
 *   あるので、ヘッダを見ずに本文を読む実装では 12 triangles が出て赤になる(ヘッダだけで決まること)
 * - (b): `Content-Length` が無い(null)・数でない(`abc`)・上限以下だが本文が上限超(嘘の申告)の
 *   ときは、`arrayBuffer` が 1 度呼ばれてから今までどおり判定する(257 MB と名乗る偽バッファで
 *   同じ文言)
 * - (c): `Content-Length` が上限以下(本文の実寸・ちょうど 256 MiB)なら普通に表示される
 *   (12 triangles・形状がシーンに居る)。ちょうど 256 MiB は「超えていれば」の境界= 拒否しない
 * - 不変(契約 3): A → B と変えたあと A の fetch が上限超の `Content-Length` で遅れて解決しても、
 *   エラーは出ず B が出たまま(先読みの拒否も世代の確かめを通る)
 *
 * 偽 Response の `Content-Length` と本文の長さは一致させていない場合がある(ちょうど 256 MiB・嘘の
 * 申告)。256 MB の実体を確保せずに境界を試すための二重の作り= ModelViewer はヘッダと
 * `arrayBuffer()` の `byteLength` しか見ない。
 *
 * ## 既存テストへの注意(implementer 向け)
 * 既存の wiring テスト(generation / stale-load / obj / ply)の偽 Response には `headers` が**無い**。
 * `response.headers.get(...)` を無防備に呼ぶとそれらが TypeError → catch → エラー表示で赤になる。
 * 契約 2 の「`Content-Length` が無い」を `headers` 自体が無い場合も含めて扱うこと
 * (例: `response.headers?.get('content-length')`)。
 *
 * ## 赤になる理由(実装前)
 * 現行の `loadModel` はヘッダを見ずに `arrayBuffer()` を呼ぶので、(a)-1 / (a)-2 は本文(小さな
 * 本物の OBJ)が表示されて文言が出ず、かつ `arrayBuffer` が呼ばれて赤。(b)・(c)・不変の各件は
 * 今の振る舞いの固定(退行防止)で最初から緑。
 *
 * スタブ(既存 wiring テストの家風): ResizeObserver = no-op・requestAnimationFrame = 即時実行・
 * `$lib/events` の listen = no-op(SpaceMouse 購読)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

const captured = vi.hoisted(() => ({
	/** スタブ renderer の render に渡された Scene(同一インスタンス=今のシーンの状態を見られる)。 */
	scenes: [] as unknown[],
	/** スタブ renderer が生成された回数(= `new WebGLRenderer` の回数)。 */
	constructed: 0,
	/** `parseModel` が呼ばれた回数(= 本文を解析に進めた回数)。 */
	parsed: 0,
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

// parseModel は素通し(結果は本物)。呼ばれた回数だけを数える。
vi.mock('$lib/model-viewing', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/model-viewing')>();
	return {
		...actual,
		parseModel: vi.fn(async (nameOrUri: string, buffer: ArrayBuffer) => {
			captured.parsed += 1;
			return actual.parseModel(nameOrUri, buffer);
		}),
	};
});

import type { Mesh, Object3D } from 'three';
import ModelViewer from './ModelViewer.svelte';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

/** 立方体 [0,5]^3・12 三角形(OBJLoader は非インデックス= position 36 頂点)。 */
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

/** 四面体 [0,10]^3・4 三角形(position 12 頂点)。A → B の切り替えの B 側。 */
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

const MIB = 1024 * 1024;
/** 上限(要件#23 契約⑥・`ModelViewer.svelte` の `MAX_BYTES`)。 */
const LIMIT_BYTES = 256 * MIB;

const URI = 'file:///Users/a/models/part.obj';
/** 版 1(古い方= A)。`imageSrcWithVersion(src, 1)` の形。 */
const SRC_A = 'vellis-asset://local/Users/a/models/part.obj?v=1';
/** 版 2(新しい方= B)。 */
const SRC_B = 'vellis-asset://local/Users/a/models/part.obj?v=2';

function bytesOf(source: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(source);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 本体を確保せず byteLength だけを名乗る偽バッファ(ModelViewer は `arrayBuffer()` 後の上限判定で
 * byteLength しか見ない。`generation.wiring` の (c)-3 と同じ作法)。
 */
function claimedBuffer(byteLength: number): ArrayBuffer {
	return { byteLength } as unknown as ArrayBuffer;
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

/** `ModelViewer` が fetch の応答に求めるもの(ok / status / headers / arrayBuffer)だけを持つ偽 Response。 */
interface FakeResponse {
	ok: boolean;
	status: number;
	headers: { get: (name: string) => string | null };
	arrayBuffer: () => Promise<ArrayBuffer>;
}

/**
 * `Content-Length` だけを持つ(か、持たない)最小の headers。名前の大文字小文字は問わない
 * (`audio-viewing.acceptance.test.ts` の `fakeAudioResponse` と同じ作り)。
 * `declared` が null ならヘッダ無し= `get` は null を返す。
 */
function headersWithContentLength(declared: string | null): FakeResponse['headers'] {
	return {
		get: (name: string) => (name.toLowerCase() === 'content-length' ? declared : null),
	};
}

/** すぐ届く 200 応答。`Content-Length` の申告と本文の取り方(`arrayBuffer`)は呼び出し側が渡す。 */
function okResponse(
	declared: string | null,
	arrayBuffer: () => Promise<ArrayBuffer>,
): FakeResponse {
	return { ok: true, status: 200, headers: headersWithContentLength(declared), arrayBuffer };
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
 * (追補d 契約 1)。fetch を止める契約 3 では、**Range の付いた要求にはすぐ 200(`Content-Range` なし・
 * `Content-Length` なし= 追補d 契約 2 で本文へ進む)で答え、Range の無い要求(本文)だけを今までどおり `table` の
 * deferred で止める**。こうして止まるのが本文の fetch になり、本来確かめていた経路(本文の fetch の直後の
 * 世代の確かめと先読みの拒否)を通る。待ち方(`toHaveBeenCalledWith(SRC_A)`= 引数 1 つの本文の fetch)と判定は不変。
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
				return okResponse(null, async () => new ArrayBuffer(0));
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

/** 上限超のエラー表示の形: 文言が出て、stats も canvas も無く、解析もされていない。 */
function expectRejectedWithMessage(expected: string): void {
	expect(messageText(), '今と同じ文言のエラーが出ること').toBe(expected);
	expect(statsText(), '三角形数は出ない').toBeNull();
	expect(captured.constructed, '上限超えは ensureScene の手前で決まる= canvas は作られない').toBe(0);
	expect(captured.parsed, '上限超えの本文は解析に進まない').toBe(0);
}

/** 立方体(12 triangles)が普通に表示されている形。 */
function expectCubeDisplayed(): void {
	expect(messageText(), 'エラーも Loading… も出ない').toBeNull();
	const meshes = meshesIn(lastScene());
	expect(meshes.length, 'シーンの Mesh は 1 つ').toBe(1);
	expect(positionCount(meshes[0]), '立方体の頂点数').toBe(CUBE_POSITIONS);
}

beforeEach(() => {
	captured.scenes.length = 0;
	captured.constructed = 0;
	captured.parsed = 0;
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

describe('ModelViewer × Content-Length の先読み(要件#23 追補c・AC-23-追c)', () => {
	// -----------------------------------------------------------------------
	// (a) Content-Length が 256 MB を超える応答では arrayBuffer() が呼ばれず、今と同じ文言が出る
	// -----------------------------------------------------------------------

	it('AC-23-追c (a)-1: Content-Length が 257 MiB なら arrayBuffer() を呼ばずに「The file is too large (257MB; limit 256MB)」が出る', async () => {
		const declared = 257 * MIB;
		// 本文は小さな本物の OBJ= ヘッダを見ずに本文を読む実装では 12 triangles が出てしまう。
		const arrayBuffer = vi.fn(async () => bytesOf(CUBE_OBJ));
		stubFetchResponses({ [SRC_A]: async () => okResponse(String(declared), arrayBuffer) });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		// 読み込みが終わるまで待つ(Loading… が消える= 文言が出るか、ヘッダを見ない実装なら
		// 本文が表示されて message が無くなる)。
		await vi.waitFor(() => {
			expect(messageText() ?? '').not.toContain('Loading…');
		});
		await settle();

		expectRejectedWithMessage('The file is too large (257MB; limit 256MB)');
		expect(arrayBuffer, '本文(arrayBuffer)は読まれない').not.toHaveBeenCalled();
	});

	it('AC-23-追c (a)-2(境界): Content-Length が 256 MiB + 1 バイトなら arrayBuffer() を呼ばずに今の丸め(Math.ceil)と同じ文言(257MB)が出る', async () => {
		const declared = LIMIT_BYTES + 1;
		const arrayBuffer = vi.fn(async () => bytesOf(CUBE_OBJ));
		stubFetchResponses({ [SRC_A]: async () => okResponse(String(declared), arrayBuffer) });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(messageText() ?? '').not.toContain('Loading…');
		});
		await settle();

		// 今の `arrayBuffer()` 後の判定が 256 MiB + 1 のバッファに出す文言と同じ
		// (n = `Math.ceil((256 MiB + 1) / MiB)` = 257)。
		// 2026-10-26: 要件23 追補e(Issue #716)で丸めを `Math.round` → `Math.ceil` に変えたため、
		// 期待を 256MB → 257MB に改めた(由谷承認 2026-10-26)。
		expectRejectedWithMessage('The file is too large (257MB; limit 256MB)');
		expect(arrayBuffer, '本文(arrayBuffer)は読まれない').not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// (b) Content-Length が無い・数でない・嘘の申告のときは、今までどおり arrayBuffer() の後に判定する
	// -----------------------------------------------------------------------

	it('AC-23-追c (b)-1: Content-Length が無い応答では arrayBuffer() の後に判定し、257 MB と名乗るバッファで同じ文言が出る', async () => {
		const arrayBuffer = vi.fn(async () => claimedBuffer(257 * MIB));
		stubFetchResponses({ [SRC_A]: async () => okResponse(null, arrayBuffer) });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(messageText()).toBe('The file is too large (257MB; limit 256MB)');
		});

		expect(arrayBuffer, 'ヘッダが無いので本文を読んでから判定する').toHaveBeenCalledTimes(1);
		expectRejectedWithMessage('The file is too large (257MB; limit 256MB)');
	});

	it('AC-23-追c (b)-2(契約 2「数でない」): Content-Length が数でなければ arrayBuffer() の後に判定する', async () => {
		const arrayBuffer = vi.fn(async () => claimedBuffer(257 * MIB));
		stubFetchResponses({ [SRC_A]: async () => okResponse('abc', arrayBuffer) });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(messageText()).toBe('The file is too large (257MB; limit 256MB)');
		});

		expect(arrayBuffer, '数でない申告は無いのと同じ= 本文を読んでから判定する').toHaveBeenCalledTimes(1);
		expectRejectedWithMessage('The file is too large (257MB; limit 256MB)');
	});

	it('AC-23-追c (b)-3(契約 2「arrayBuffer() の後の判定も残す」): Content-Length は上限以下だが本文が 257 MB と名乗れば、今までどおり拒否する', async () => {
		const arrayBuffer = vi.fn(async () => claimedBuffer(257 * MIB));
		stubFetchResponses({ [SRC_A]: async () => okResponse(String(1000), arrayBuffer) });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(messageText()).toBe('The file is too large (257MB; limit 256MB)');
		});

		expect(arrayBuffer, '申告が上限以下なら本文を読む').toHaveBeenCalledTimes(1);
		expectRejectedWithMessage('The file is too large (257MB; limit 256MB)');
	});

	// -----------------------------------------------------------------------
	// (c) Content-Length が上限以下なら普通に表示される
	// -----------------------------------------------------------------------

	it('AC-23-追c (c)-1: Content-Length が本文の実寸(上限以下)なら 12 triangles が普通に表示される', async () => {
		const body = bytesOf(CUBE_OBJ);
		const arrayBuffer = vi.fn(async () => body);
		stubFetchResponses({ [SRC_A]: async () => okResponse(String(body.byteLength), arrayBuffer) });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(statsText()).toBe('12 triangles');
		});

		expect(arrayBuffer).toHaveBeenCalledTimes(1);
		expect(captured.parsed, '本文が解析に進む').toBe(1);
		expectCubeDisplayed();
	});

	it('AC-23-追c (c)-2(境界): Content-Length がちょうど 256 MiB なら「超えていない」= 本文を読んで普通に表示される', async () => {
		// 申告はちょうど上限・本文は小さな本物の OBJ(256 MiB の実体は確保しない)。
		const arrayBuffer = vi.fn(async () => bytesOf(CUBE_OBJ));
		stubFetchResponses({ [SRC_A]: async () => okResponse(String(LIMIT_BYTES), arrayBuffer) });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(statsText()).toBe('12 triangles');
		});

		expect(arrayBuffer, 'ちょうど上限は拒否しない= 本文を読む').toHaveBeenCalledTimes(1);
		expectCubeDisplayed();
	});

	// -----------------------------------------------------------------------
	// 不変(契約 3): 先読みの拒否も世代の確かめを通る(追補a・b)
	// -----------------------------------------------------------------------

	it('契約 3(不変): A → B のあと A の fetch が上限超の Content-Length で遅れて解決しても、エラーは出ず B が出たまま', async () => {
		const fetchGateA = deferred<FakeResponse>();
		const arrayBufferA = vi.fn(async () => bytesOf(CUBE_OBJ));
		const bodyB = bytesOf(TETRA_OBJ);
		// 要件#23 追補d(5) の改め直し(2026-10-20): 問い合わせ(Range 付き)にはすぐ 200 で答え、本文の fetch だけを止める。
		stubFetchResponsesAnsweringProbe({
			[SRC_A]: () => fetchGateA.promise,
			[SRC_B]: async () => okResponse(String(bodyB.byteLength), async () => bodyB),
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
		const constructedBefore = captured.constructed;
		const parsedBefore = captured.parsed;

		// A の fetch が、上限超の申告を付けて B の表示後に解決する。
		fetchGateA.resolve(okResponse(String(257 * MIB), arrayBufferA));
		await settle();

		expect(messageText(), '古い世代の上限超えはエラーとして出さない').toBeNull();
		expect(statsText(), 'B が出たまま').toBe('4 triangles');
		expect(arrayBufferA, '最新でない A の本文は読まれない(追補b)').not.toHaveBeenCalled();
		expect(captured.parsed, 'A は解析されない').toBe(parsedBefore);
		expect(captured.constructed, 'renderer は作り直されない').toBe(constructedBefore);
		const meshes = meshesIn(lastScene());
		expect(meshes.length, 'シーンの Mesh は B の 1 つだけ').toBe(1);
		expect(positionCount(meshes[0]), 'B(四面体)の頂点数').toBe(TETRA_POSITIONS);
	});
});
