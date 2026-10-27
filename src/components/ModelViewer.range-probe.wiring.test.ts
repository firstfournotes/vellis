/**
 * 要件#23 追補d の受け入れテスト — ModelViewer の読み込みの前の `Range: bytes=0-0` の問い合わせ
 * (docs/requirements/req-23.md「追補d」(2026-10-20)・AC-23-追d (a)〜(d)・Issue #708)
 *
 * 追補c の先読み(`Content-Length`)で避けられるのは WebView 側の複製だけ。`vellis-asset` の応答は、
 * Range の無い要求では Rust 側(`commands/asset.rs`)がファイルを丸ごと `Vec<u8>` に読むので、
 * 256 MB を超えるファイルもアプリのプロセスには一度は全部載る。
 *
 * ## 契約(追補d)
 * 1. 3D の読み込みは、本文を取る前に、同じ URL へ `Range: bytes=0-0` の要求を1回送り、応答が 206 で
 *    `Content-Range` の総量(`bytes 0-0/<total>`)が 256 MB を超えていれば、本文を取らずに今と同じ
 *    文言で断る(`The file is too large (<n>MB; limit 256MB)`・n は総量から `Math.round`)
 * 2. 応答が 206 でない・総量が読めない・上限以下・問い合わせが失敗したときは、今のまま本文を取る
 *    (追補c の先読みと `arrayBuffer()` の後の判定も残す)
 * 3. 世代の確かめ(追補a・b)は問い合わせの後にも行う(古い読み込みは問い合わせの結果で何もしない)
 * 4. 不変: 文言・上限・`vellis-asset` の Range の扱い(Rust 側は変えない)
 *
 * ## 観測方式(`ModelViewer.content-length.wiring.test.ts` / `ModelViewer.stale-load.wiring.test.ts` と同じ家風)
 *
 * JSDOM には WebGL が無いので `vi.mock('three')` で `WebGLRenderer` だけをスタブ(生成回数と render に
 * 渡された Scene を記録)に差し替え、残りは本物。`$lib/model-viewing` の `parseModel` は素通しの包み
 * (結果は本物)で「解析に進んだか」を数える。
 *
 * fetch は **要求の `headers` の `Range` を見て、問い合わせと本文を分けて答える偽 fetch**(`stubFetchByRange`)。
 * `src` ごとに `probe`(Range 付きの要求への応答)と `body`(Range の無い要求への応答)を持ち、どちらも
 * deferred で止められる。Range は `init.headers` が素のオブジェクト・`Headers`・タプル配列のどれでも、
 * また `Request` を渡す形でも読む(ヘッダの渡し方は実装裁量)。
 *
 * 問い合わせへの 206 応答は Rust 側 `commands/asset.rs` の形に合わせる= `Content-Range: bytes 0-0/<total>`・
 * `Content-Length: 1`・`Accept-Ranges: bytes`・本文 1 バイト。**`Content-Length` が 1 なのは意図的**で、
 * 問い合わせの応答の `Content-Length` を総量と取り違える実装(1 バイト → 上限以下 → 本文を取る)を (a) で
 * 赤にする。本文の 200 応答は追補c と同じ(`Content-Length` 付き・`arrayBuffer` は `vi.fn`)。
 *
 * 判定は振る舞いで行う(ヘッダの読み方・`Content-Range` の解析の仕方は実装裁量):
 * - (a): 問い合わせが 206・総量が上限超なら、Range の無い fetch は 1 度も送られず、`arrayBuffer` も
 *   解析も renderer も無く、`.model-message` に今と同じ文言(n は `Math.round(total / MiB)`)が出る。
 *   本文側の 200 は本番と同じく総量を `Content-Length` に申告する(本文は小さな本物の OBJ)ので、
 *   問い合わせを飛ばして本文を取る実装でも追補c が同じ文言を出す= 赤の決め手は文言ではなく
 *   「問い合わせが送られた・Range の無い fetch が無い・本文の応答が要求されていない」の 3 つ
 * - (b): 総量が上限以下(実寸・ちょうど 256 MiB)なら、問い合わせの**答えを待ってから** Range の無い fetch を
 *   送り(問い合わせを止めている間は本文の要求が出ない)、普通に表示される。問い合わせは 1 回だけ
 * - (c): 206 でない(200・Range を見ない偽 fetch= 既存の wiring テストの家風)・`Content-Range` が無い・
 *   総量が読めない(`bytes 0-0/*`)・問い合わせが reject する、のどれでも今まで通り本文を取って表示される。
 *   本文の読み込み(`arrayBuffer`)は**通算 1 回**= Range を無視して全本文を返す 200 を「問い合わせ」として
 *   読み切る(= 避けたかった複製そのもの)実装は赤
 * - (d): A → B と変えたとき、A の問い合わせの応答(上限超・上限以下・reject)が B の表示後に来ても A は
 *   何もしない(エラーは出ず B が出たまま・A の本文は要求されない・renderer は作り直されない)。外れた
 *   あとに問い合わせの応答が来ても本文は要求されず renderer も作られない(追補b の形)
 *
 * ## 既存テストへの注意(implementer 向け・AC (e)「追補a〜c のテストは緑」)
 * 既存の wiring テストの偽 fetch は Range を見ずに 200 と全本文を返す(generation / stale-load /
 * content-length / obj / ply / spacemouse)。契約 2 の「206 でない → 本文を取る」でそれらは壊れないが、
 * **fetch そのものを deferred で止めて `expect(globalThis.fetch).toHaveBeenCalledWith(SRC_A)` を待つ**
 * 3 件(stale-load (a)-3・(b)、content-length 契約 3)は、最初の fetch が Range 付き(引数 2 つ)になると
 * 引数 1 つの `[SRC_A]` に一致せず、止めた問い合わせが解決するまで本文の fetch も出ないので待ちが切れる。
 * これはテスト側の段取りの問題(追補b(4) と同型)で、解消は要件側の判断に委ねる(このファイルでは扱わない)。
 *
 * ## 赤になる理由(実装前)
 * 現行の `loadModel` は問い合わせを送らず `fetch(assetSrc)` で本文を取るので、(a) は問い合わせが無く
 * 本文が要求されて赤(文言自体は追補c の先読みで同じものが出る)、(b)・(c)-2〜4・(d) は「問い合わせが
 * 送られた」の待ちが満たされずに赤。(c)-1(Range を見ない偽 fetch で今まで通り表示される)だけは
 * 退行防止で最初から緑。
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

/** 契約 1 の問い合わせの Range ヘッダの値。 */
const PROBE_RANGE = 'bytes=0-0';

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

/** `ModelViewer` が fetch の応答に求めるもの(ok / status / headers / arrayBuffer)だけを持つ偽 Response。 */
interface FakeResponse {
	ok: boolean;
	status: number;
	headers: { get: (name: string) => string | null };
	arrayBuffer: () => Promise<ArrayBuffer>;
}

/** 名前の大文字小文字を問わない最小の headers(`get` だけ)。 */
function headersOf(table: Record<string, string>): FakeResponse['headers'] {
	const lower = new Map(Object.entries(table).map(([name, value]) => [name.toLowerCase(), value]));
	return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/**
 * 問い合わせ(`Range: bytes=0-0`)への 206 応答。Rust 側 `commands/asset.rs` の形に合わせる=
 * `Content-Range: bytes 0-0/<total>`・`Content-Length: 1`・`Accept-Ranges: bytes`・本文 1 バイト。
 * `contentRange` が null なら `Content-Range` を付けない((c)-2 用)。
 */
function partialResponse(contentRange: string | null): FakeResponse {
	const headers: Record<string, string> = { 'Accept-Ranges': 'bytes', 'Content-Length': '1' };
	if (contentRange !== null) headers['Content-Range'] = contentRange;
	return {
		ok: true,
		status: 206,
		headers: headersOf(headers),
		arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
	};
}

/** 総量 `total` を名乗る問い合わせの 206 応答。 */
function probe206(total: number): FakeResponse {
	return partialResponse(`bytes 0-0/${total}`);
}

/**
 * 本文の 200 応答(追補c と同じ形= `Content-Length` に `declared` を申告)。
 * 本文の取り方(`arrayBuffer`)は呼び出し側が渡す(呼ばれた回数を見る)。
 */
function okResponse(
	arrayBuffer: () => Promise<ArrayBuffer>,
	declared: number,
): FakeResponse {
	return {
		ok: true,
		status: 200,
		headers: headersOf({ 'Accept-Ranges': 'bytes', 'Content-Length': String(declared) }),
		arrayBuffer,
	};
}

type FetchInput = string | URL | { url: string; headers: { get: (name: string) => string | null } };

function urlOf(input: FetchInput): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

/**
 * 要求の `Range` ヘッダの値(無ければ null)。`init.headers` は素のオブジェクト・`Headers`・タプル配列の
 * どれでも読み、`Request` を渡す形なら `input.headers` から読む(ヘッダの渡し方は実装裁量)。
 */
function rangeOf(input: FetchInput, init: RequestInit | undefined): string | null {
	const headers = init?.headers;
	if (headers) {
		if (typeof (headers as Headers).get === 'function') return (headers as Headers).get('range');
		const entries: [string, string][] = Array.isArray(headers)
			? (headers as [string, string][])
			: Object.entries(headers as Record<string, string>);
		const hit = entries.find(([name]) => name.toLowerCase() === 'range');
		return hit ? hit[1] : null;
	}
	if (typeof input === 'object' && !(input instanceof URL)) return input.headers.get('range');
	return null;
}

/** `src` 1 つぶんの答え方= 問い合わせ(Range 付き)と本文(Range 無し)を分けて持つ。 */
interface Served {
	/** Range 付きの要求(問い合わせ)への応答。引数は Range ヘッダの値。 */
	probe: (range: string) => Promise<FakeResponse>;
	/** Range の無い要求(本文)への応答。 */
	body: () => Promise<FakeResponse>;
}

/**
 * fetch を「要求の Range を見て、src ごとに問い合わせと本文を分けて答える偽 fetch」に固定する。
 * 値は fetch の戻り= Response の Promise(問い合わせも本文も deferred で止められる)。
 */
function stubFetchByRange(table: Record<string, Served>): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: FetchInput, init?: RequestInit) => {
			const key = urlOf(input);
			const served = table[key];
			if (!served) throw new Error(`unexpected fetch in test: ${key}`);
			const range = rangeOf(input, init);
			return range === null ? served.body() : served.probe(range);
		}),
	);
}

/**
 * Range を**見ない**偽 fetch(既存の wiring テストの家風そのもの)= どの要求にも同じ 200 と全本文を返す。
 * (c)-1 で「本番でない環境でも新しい実装が壊れない」ことを確かめる。
 */
function stubFetchIgnoringRange(table: Record<string, () => Promise<FakeResponse>>): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: FetchInput, _init?: RequestInit) => {
			const key = urlOf(input);
			const respond = table[key];
			if (!respond) throw new Error(`unexpected fetch in test: ${key}`);
			return respond();
		}),
	);
}

/** 偽 fetch に届いた要求の並び= [URL, Range の値(無ければ null)]。 */
function fetchCalls(): [string, string | null][] {
	const calls = vi.mocked(globalThis.fetch).mock.calls as unknown as [FetchInput, RequestInit?][];
	return calls.map(([input, init]) => [urlOf(input), rangeOf(input, init)]);
}

/** Range の無い要求(本文の要求)の URL の並び。 */
function bodyRequests(): string[] {
	return fetchCalls()
		.filter(([, range]) => range === null)
		.map(([url]) => url);
}

/** Range 付きの要求(問い合わせ)の [URL, Range] の並び。 */
function probeRequests(): [string, string | null][] {
	return fetchCalls().filter(([, range]) => range !== null);
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
	expect(statsText()).toBe('12 triangles');
	const meshes = meshesIn(lastScene());
	expect(meshes.length, 'シーンの Mesh は 1 つ').toBe(1);
	expect(positionCount(meshes[0]), '立方体の頂点数').toBe(CUBE_POSITIONS);
}

/** 四面体(4 triangles= B)だけが表示されている形。 */
function expectTetraDisplayed(): void {
	expect(messageText(), 'エラーも Loading… も出ない').toBeNull();
	expect(statsText(), 'B が出たまま').toBe('4 triangles');
	const meshes = meshesIn(lastScene());
	expect(meshes.length, 'シーンの Mesh は B の 1 つだけ').toBe(1);
	expect(positionCount(meshes[0]), 'B(四面体)の頂点数').toBe(TETRA_POSITIONS);
}

/** 読み込みが終わる(Loading… が消える= 文言が出るか本文が表示される)まで待ってから落ち着かせる。 */
async function waitUntilLoaded(): Promise<void> {
	await vi.waitFor(() => {
		expect(messageText() ?? '').not.toContain('Loading…');
	});
	await settle();
}

/** 問い合わせが 1 回・`bytes=0-0` で送られていること(契約 1)。 */
function expectProbedOnce(url: string): void {
	expect(probeRequests(), `${url} への問い合わせは Range: bytes=0-0 で 1 回`).toEqual([[url, PROBE_RANGE]]);
}

/**
 * B(四面体)を、問い合わせ 206(上限以下)→ 本文 200 で普通に答える `Served`。
 * `bodyB` は共有の `arrayBuffer` スパイ(A の本文が読まれていないことを A 側のスパイで見るため、B は別)。
 */
function servedB(): Served {
	const body = bytesOf(TETRA_OBJ);
	return {
		probe: async () => probe206(body.byteLength),
		body: async () => okResponse(async () => body, body.byteLength),
	};
}

/**
 * A の問い合わせを止めたまま B へ切り替え、B の表示(4 triangles)を待つ。
 * 返り値は A の問い合わせのゲート(テストが後から解決・拒否する)と A 側のスパイ。
 */
async function mountAProbePendingThenShowB() {
	const probeGateA = deferred<FakeResponse>();
	const arrayBufferA = vi.fn(async () => bytesOf(CUBE_OBJ));
	const probeA = vi.fn((_range: string) => probeGateA.promise);
	const bodyA = vi.fn(async () => okResponse(arrayBufferA, bytesOf(CUBE_OBJ).byteLength));
	stubFetchByRange({
		[SRC_A]: { probe: probeA, body: bodyA },
		[SRC_B]: servedB(),
	});

	const { rerender } = render(ModelViewer, { props: { uri: URI, src: SRC_A } });
	await vi.waitFor(() => {
		expect(probeA, 'A の問い合わせが送られていること').toHaveBeenCalledTimes(1);
	});
	expect(messageText(), 'A の問い合わせは止めてあるので Loading… のまま').toContain('Loading…');
	expect(bodyA, '問い合わせの答えが来るまで A の本文は要求されない').not.toHaveBeenCalled();

	await rerender({ uri: URI, src: SRC_B });
	await vi.waitFor(() => {
		expect(statsText()).toBe('4 triangles');
	});
	expectTetraDisplayed();

	return { probeGateA, probeA, bodyA, arrayBufferA };
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

describe('ModelViewer × 読み込みの前の Range: bytes=0-0 の問い合わせ(要件#23 追補d・AC-23-追d)', () => {
	// -----------------------------------------------------------------------
	// (a) 問い合わせが 206・Content-Range: bytes 0-0/<257 MiB> なら、本文の要求(Range の無い fetch)は
	//     送られず、文言が出る
	// -----------------------------------------------------------------------

	it('AC-23-追d (a)-1: 問い合わせが 206・総量 257 MiB なら、本文の要求は送られず「The file is too large (257MB; limit 256MB)」が出る', async () => {
		// 本文側の 200 は本番どおり総量を Content-Length に申告する(本文は小さな本物の OBJ)。
		// 問い合わせを飛ばす実装は追補c で同じ文言を出すが、本文を要求した時点で赤。
		const arrayBuffer = vi.fn(async () => bytesOf(CUBE_OBJ));
		const body = vi.fn(async () => okResponse(arrayBuffer, 257 * MIB));
		stubFetchByRange({ [SRC_A]: { probe: async () => probe206(257 * MIB), body } });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await waitUntilLoaded();

		expectRejectedWithMessage('The file is too large (257MB; limit 256MB)');
		expectProbedOnce(SRC_A);
		expect(body, '本文の要求(Range の無い fetch)は送られない').not.toHaveBeenCalled();
		expect(bodyRequests(), 'Range の無い fetch は 1 度も無い').toEqual([]);
		expect(arrayBuffer, '本文(arrayBuffer)は読まれない').not.toHaveBeenCalled();
	});

	it('AC-23-追d (a)-2(境界): 総量が 256 MiB + 1 バイトなら、本文の要求は送られず今の丸め(Math.ceil)と同じ文言(257MB)が出る', async () => {
		const arrayBuffer = vi.fn(async () => bytesOf(CUBE_OBJ));
		const body = vi.fn(async () => okResponse(arrayBuffer, LIMIT_BYTES + 1));
		stubFetchByRange({ [SRC_A]: { probe: async () => probe206(LIMIT_BYTES + 1), body } });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await waitUntilLoaded();

		// n = `Math.ceil((256 MiB + 1) / MiB)` = 257(追補c (a)-2 と同じ文言)。
		// 2026-10-26: 要件23 追補e(Issue #716)で丸めを `Math.round` → `Math.ceil` に変えたため、
		// 期待を 256MB → 257MB に改めた(由谷承認 2026-10-26)。
		expectRejectedWithMessage('The file is too large (257MB; limit 256MB)');
		expectProbedOnce(SRC_A);
		expect(body, '本文の要求(Range の無い fetch)は送られない').not.toHaveBeenCalled();
		expect(arrayBuffer, '本文(arrayBuffer)は読まれない').not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// (b) 総量が上限以下なら本文を取って表示する
	// -----------------------------------------------------------------------

	it('AC-23-追d (b)-1: 総量が本文の実寸(上限以下)なら、問い合わせの答えを待ってから本文を要求し、12 triangles が普通に表示される', async () => {
		const cube = bytesOf(CUBE_OBJ);
		const probeGate = deferred<FakeResponse>();
		const arrayBuffer = vi.fn(async () => cube);
		const body = vi.fn(async () => okResponse(arrayBuffer, cube.byteLength));
		stubFetchByRange({ [SRC_A]: { probe: () => probeGate.promise, body } });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(probeRequests()).toEqual([[SRC_A, PROBE_RANGE]]);
		});
		// 契約 1「本文を取る前に」= 問い合わせの答えが来るまで本文の要求は出ない。
		await settle();
		expect(body, '問い合わせを止めている間は本文を要求しない').not.toHaveBeenCalled();
		expect(messageText()).toContain('Loading…');

		probeGate.resolve(probe206(cube.byteLength));
		await vi.waitFor(() => {
			expect(statsText()).toBe('12 triangles');
		});

		expectProbedOnce(SRC_A);
		expect(bodyRequests(), '本文の要求(Range の無い fetch)は 1 回').toEqual([SRC_A]);
		expect(fetchCalls(), '順は問い合わせ → 本文').toEqual([
			[SRC_A, PROBE_RANGE],
			[SRC_A, null],
		]);
		expect(arrayBuffer, '本文は 1 回読む').toHaveBeenCalledTimes(1);
		expect(captured.parsed, '本文が解析に進む').toBe(1);
		expectCubeDisplayed();
	});

	it('AC-23-追d (b)-2(境界): 総量がちょうど 256 MiB なら「超えていない」= 本文を取って普通に表示される', async () => {
		// 総量と本文の申告はちょうど上限・本文は小さな本物の OBJ(256 MiB の実体は確保しない。追補c (c)-2 と同じ二重の作り)。
		const arrayBuffer = vi.fn(async () => bytesOf(CUBE_OBJ));
		const body = vi.fn(async () => okResponse(arrayBuffer, LIMIT_BYTES));
		stubFetchByRange({ [SRC_A]: { probe: async () => probe206(LIMIT_BYTES), body } });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(statsText()).toBe('12 triangles');
		});

		expectProbedOnce(SRC_A);
		expect(bodyRequests(), 'ちょうど上限は拒否しない= 本文を要求する').toEqual([SRC_A]);
		expect(arrayBuffer, '本文は 1 回読む').toHaveBeenCalledTimes(1);
		expectCubeDisplayed();
	});

	// -----------------------------------------------------------------------
	// (c) 206 でない(200)・Content-Range が無い・問い合わせが reject するときは、今まで通り本文を取る
	// -----------------------------------------------------------------------

	it('AC-23-追d (c)-1: Range を見ない偽 fetch(どの要求にも 200 と全本文= 既存の wiring テストの家風)でも、今まで通り表示され本文の読み込みは通算 1 回', async () => {
		const cube = bytesOf(CUBE_OBJ);
		// 問い合わせにも本文にも同じ arrayBuffer スパイ= 問い合わせの 200 を読み切る実装は 2 回になって赤
		// (Range を無視された 200 は全本文そのもの= 避けたかった複製)。
		const arrayBuffer = vi.fn(async () => cube);
		stubFetchIgnoringRange({ [SRC_A]: async () => okResponse(arrayBuffer, cube.byteLength) });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(statsText()).toBe('12 triangles');
		});
		await settle();

		expect(arrayBuffer, '本文の読み込みは通算 1 回(問い合わせの 200 を読み切らない)').toHaveBeenCalledTimes(1);
		expect(captured.parsed, '解析は 1 回').toBe(1);
		expect(captured.constructed, 'renderer は 1 つ').toBe(1);
		expectCubeDisplayed();
	});

	it('AC-23-追d (c)-2: 問い合わせが 206 でも Content-Range が無ければ、今まで通り本文を取って表示される', async () => {
		const cube = bytesOf(CUBE_OBJ);
		const arrayBuffer = vi.fn(async () => cube);
		const body = vi.fn(async () => okResponse(arrayBuffer, cube.byteLength));
		stubFetchByRange({ [SRC_A]: { probe: async () => partialResponse(null), body } });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(statsText()).toBe('12 triangles');
		});

		expectProbedOnce(SRC_A);
		expect(fetchCalls(), '順は問い合わせ → 本文').toEqual([
			[SRC_A, PROBE_RANGE],
			[SRC_A, null],
		]);
		expect(arrayBuffer, '本文は 1 回読む').toHaveBeenCalledTimes(1);
		expectCubeDisplayed();
	});

	it('AC-23-追d (c)-3(契約 2「総量が読めない」): Content-Range が bytes 0-0/*(総量不明)なら、今まで通り本文を取って表示される', async () => {
		const cube = bytesOf(CUBE_OBJ);
		const arrayBuffer = vi.fn(async () => cube);
		const body = vi.fn(async () => okResponse(arrayBuffer, cube.byteLength));
		stubFetchByRange({ [SRC_A]: { probe: async () => partialResponse('bytes 0-0/*'), body } });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(statsText()).toBe('12 triangles');
		});

		expectProbedOnce(SRC_A);
		expect(bodyRequests(), '本文の要求は 1 回').toEqual([SRC_A]);
		expect(arrayBuffer, '本文は 1 回読む').toHaveBeenCalledTimes(1);
		expectCubeDisplayed();
	});

	it('AC-23-追d (c)-4: 問い合わせが reject しても、エラーにはならず今まで通り本文を取って表示される', async () => {
		const cube = bytesOf(CUBE_OBJ);
		const arrayBuffer = vi.fn(async () => cube);
		const body = vi.fn(async () => okResponse(arrayBuffer, cube.byteLength));
		const probe = vi.fn(async (_range: string): Promise<FakeResponse> => {
			throw new TypeError('Failed to fetch');
		});
		stubFetchByRange({ [SRC_A]: { probe, body } });

		render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(statsText()).toBe('12 triangles');
		});

		expect(probe, '問い合わせは 1 回送られた').toHaveBeenCalledTimes(1);
		expect(probe).toHaveBeenCalledWith(PROBE_RANGE);
		expect(bodyRequests(), '問い合わせの失敗は本文の要求で埋め合わせる').toEqual([SRC_A]);
		expect(arrayBuffer, '本文は 1 回読む').toHaveBeenCalledTimes(1);
		expectCubeDisplayed();
	});

	// -----------------------------------------------------------------------
	// (d) A → B と変えたとき、A の問い合わせの応答が B の後に来ても A は何もしない(契約 3)
	// -----------------------------------------------------------------------

	it('AC-23-追d (d)-1: A → B のあと A の問い合わせが上限超の総量で B の表示後に解決しても、エラーは出ず B が出たまま(A の本文は要求されない)', async () => {
		const { probeGateA, bodyA, arrayBufferA } = await mountAProbePendingThenShowB();
		const constructedBefore = captured.constructed;
		const parsedBefore = captured.parsed;

		probeGateA.resolve(probe206(257 * MIB));
		await settle();

		expect(messageText(), '古い世代の上限超えはエラーとして出さない').toBeNull();
		expectTetraDisplayed();
		expect(bodyA, '古い A の本文は要求されない').not.toHaveBeenCalled();
		expect(arrayBufferA, '古い A の本文は読まれない').not.toHaveBeenCalled();
		expect(captured.parsed, 'A は解析されない').toBe(parsedBefore);
		expect(captured.constructed, 'renderer は作り直されない').toBe(constructedBefore);
	});

	it('AC-23-追d (d)-2: A → B のあと A の問い合わせが上限以下の総量で B の表示後に解決しても、A の本文は要求されず B が出たまま', async () => {
		const { probeGateA, bodyA, arrayBufferA } = await mountAProbePendingThenShowB();
		const constructedBefore = captured.constructed;
		const parsedBefore = captured.parsed;

		// 上限以下= 世代の確かめが無ければ A の本文の要求へ進んでしまう答え。
		probeGateA.resolve(probe206(bytesOf(CUBE_OBJ).byteLength));
		await settle();

		expect(bodyA, '古い A は問い合わせの結果で何もしない= 本文を要求しない').not.toHaveBeenCalled();
		expect(arrayBufferA, '古い A の本文は読まれない').not.toHaveBeenCalled();
		expect(bodyRequests(), 'Range の無い要求は B の 1 回だけ').toEqual([SRC_B]);
		expectTetraDisplayed();
		expect(captured.parsed, 'A は解析されない').toBe(parsedBefore);
		expect(captured.constructed, 'renderer は作り直されない').toBe(constructedBefore);
	});

	it('AC-23-追d (d)-3: A → B のあと A の問い合わせが B の表示後に reject しても、A の本文は要求されずエラーも出ず B が出たまま', async () => {
		const { probeGateA, bodyA, arrayBufferA } = await mountAProbePendingThenShowB();
		const constructedBefore = captured.constructed;
		const parsedBefore = captured.parsed;

		// 契約 2 の埋め合わせ(本文を取る)より前に世代を確かめること= 古い A は埋め合わせもしない。
		probeGateA.reject(new TypeError('Failed to fetch'));
		await settle();

		expect(messageText(), '古い世代の問い合わせの失敗はエラーとして出さない').toBeNull();
		expect(bodyA, '古い A は埋め合わせの本文も要求しない').not.toHaveBeenCalled();
		expect(arrayBufferA, '古い A の本文は読まれない').not.toHaveBeenCalled();
		expectTetraDisplayed();
		expect(captured.parsed, 'A は解析されない').toBe(parsedBefore);
		expect(captured.constructed, 'renderer は作り直されない').toBe(constructedBefore);
	});

	it('AC-23-追d (d)-4(追補b の形): 問い合わせの解決前に外し、そのあと上限以下の総量で解決しても、本文は要求されず renderer も作られない', async () => {
		const probeGate = deferred<FakeResponse>();
		const arrayBuffer = vi.fn(async () => bytesOf(CUBE_OBJ));
		const probe = vi.fn((_range: string) => probeGate.promise);
		const body = vi.fn(async () => okResponse(arrayBuffer, bytesOf(CUBE_OBJ).byteLength));
		stubFetchByRange({ [SRC_A]: { probe, body } });

		const { unmount } = render(ModelViewer, { props: { uri: URI, src: SRC_A } });
		await vi.waitFor(() => {
			expect(probe).toHaveBeenCalledTimes(1);
		});
		expect(messageText(), '問い合わせは止めてあるので Loading… のまま').toContain('Loading…');
		expect(captured.constructed, '前提: 外す前に renderer は無い').toBe(0);

		unmount();
		probeGate.resolve(probe206(bytesOf(CUBE_OBJ).byteLength));
		await settle();

		expect(body, '外れたあとは本文を要求しない').not.toHaveBeenCalled();
		expect(arrayBuffer, '本文は読まれない').not.toHaveBeenCalled();
		expect(captured.parsed, '解析もされない').toBe(0);
		expect(captured.constructed, '外れたあとに renderer(WebGLRenderer)は作られない').toBe(0);
		expect(captured.scenes.length, '描画要求も出ない').toBe(0);
	});
});
