/**
 * 要件#23 追補e (a) の受け入れテスト — 大きさの上限の文言の MB は切り上げ
 * (docs/requirements/req-23.md「追補e」(2026-10-25)・AC-23-追e (a)・Issue #716)
 *
 * 268,435,457 バイト(上限+1)の STL で「The file is too large (256MB; limit 256MB)」と出て、
 * 上限と同じなのに大きすぎると読める。`ModelViewer.svelte` の `tooLargeError` が大きさを
 * `Math.round` で MB に丸めるため。
 *
 * ## 確定契約(implementer はこれに従う。正本= docs/requirements/req-23.md 追補e 契約1・3)
 *
 * 1. `tooLargeError` の大きさは MB(MiB= 1024 × 1024)に**切り上げ**て出す(`Math.ceil`)。上限を
 *    少しでも超えれば 257MB 以上になり、上限の 256MB と食い違わない。文言の形
 *    (`The file is too large (<n>MB; limit 256MB)`)は今のまま
 * 2. 不変: 上限 `MAX_BYTES`(256 MiB)と判定の場所= 総量の問い合わせ(追補d)・`Content-Length` の
 *    先読み(追補c)・`arrayBuffer()` の後(要件#23 ⑥)の 3 か所。上限ちょうどは断らない
 *
 * 起案時判断(由谷の事後確認待ち): (a) 小数 1 桁で出す案ではなく切り上げ(文言の形が変わらない)。
 *
 * ## 観測方式(`ModelViewer.range-probe.wiring.test.ts`= 要件#23 追補d と同じ家風)
 * JSDOM には WebGL が無いので `vi.mock('three')` で `WebGLRenderer` だけをスタブに差し替え、残りは本物。
 * `$lib/model-viewing` の `parseModel` は素通しの包みで「解析に進んだか」を数える。fetch は要求の
 * `Range` を見て問い合わせ(Range 付き)と本文(Range 無し)を分けて答える偽 fetch。
 *
 * 3 か所の判定それぞれに大きさを与える:
 * - 問い合わせ= 206 の `Content-Range: bytes 0-0/<total>` の総量
 * - 先読み= 問い合わせには 200(`Content-Range` 無し= 総量不明)で答え、本文の 200 の `Content-Length`
 * - 読んだ後= 問い合わせ 200・本文に `Content-Length` 無し・`arrayBuffer()` が `byteLength` だけを名乗る
 *   偽バッファを返す(257 MB を確保しない。既存 generation / content-length テストの作法)
 *
 * ## 判定
 * - 上限+1 バイト → 「The file is too large (257MB; limit 256MB)」(3 か所とも)
 * - 300 MiB ちょうど → 「The file is too large (300MB; limit 256MB)」(3 か所とも= 整数 MB は変わらない)
 * - 300 MiB + 1 バイト → 「301MB」(切り上げは上限の近くだけの特別扱いではない)
 * - 上限ちょうど(256 MiB)→ 断らない(問い合わせ・先読みは 12 triangles が表示される。読んだ後は
 *   偽バッファが解析に渡る= `parseModel` が 1 回呼ばれ、文言は too large ではない)
 *
 * ## 赤になる理由(実装前)
 * 現行の `tooLargeError` は `Math.round(bytes / MiB)` なので、上限+1 バイトは 256 に丸まり
 * 「(256MB; limit 256MB)」が出る(3 か所の「257MB」が赤)。300 MiB + 1 バイトも 300 に丸まって赤。
 * 300 MiB ちょうど・上限ちょうどの 6 件は退行の歯止めで実装前から緑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

const captured = vi.hoisted(() => ({
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
		render(_scene: unknown, _camera: unknown): void {}
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

import ModelViewer from './ModelViewer.svelte';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

/** 立方体 [0,5]^3・12 三角形(本文の実体。小さな本物の OBJ)。 */
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

const MIB = 1024 * 1024;
/** 上限(要件#23 契約⑥・`ModelViewer.svelte` の `MAX_BYTES`)。 */
const LIMIT_BYTES = 256 * MIB;

const URI = 'file:///Users/a/models/part.obj';
const SRC = 'vellis-asset://local/Users/a/models/part.obj?v=1';

function bytesOf(source: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(source);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 本体を確保せず `byteLength` だけを名乗る偽バッファ(上限判定は byteLength しか見ない)。 */
function claimedBuffer(byteLength: number): ArrayBuffer {
	return { byteLength } as unknown as ArrayBuffer;
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

/** 総量 `total` を名乗る問い合わせの 206 応答(Rust 側 `asset.rs` の形)。 */
function probe206(total: number): FakeResponse {
	return {
		ok: true,
		status: 206,
		headers: headersOf({
			'Accept-Ranges': 'bytes',
			'Content-Length': '1',
			'Content-Range': `bytes 0-0/${total}`,
		}),
		arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
	};
}

/** 問い合わせに総量を答えない 200(`Content-Range` 無し)= 実装は本文を取る(追補d 契約2)。 */
function probeUnknown(): FakeResponse {
	return {
		ok: true,
		status: 200,
		headers: headersOf({}),
		arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
	};
}

/** 本文の 200 応答。`declared` が null なら `Content-Length` を付けない。 */
function okResponse(
	arrayBuffer: () => Promise<ArrayBuffer>,
	declared: number | null,
): FakeResponse {
	const headers: Record<string, string> = { 'Accept-Ranges': 'bytes' };
	if (declared !== null) headers['Content-Length'] = String(declared);
	return { ok: true, status: 200, headers: headersOf(headers), arrayBuffer };
}

type FetchInput = string | URL | { url: string; headers: { get: (name: string) => string | null } };

function urlOf(input: FetchInput): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

/** 要求の `Range` ヘッダの値(無ければ null)。ヘッダの渡し方は実装裁量なので複数の形を読む。 */
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

interface Served {
	/** Range 付きの要求(問い合わせ)への応答。 */
	probe: () => Promise<FakeResponse>;
	/** Range の無い要求(本文)への応答。 */
	body: () => Promise<FakeResponse>;
}

/** fetch を「要求の Range を見て、問い合わせと本文を分けて答える偽 fetch」に固定する。 */
function stubFetchByRange(served: Served): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: FetchInput, init?: RequestInit) => {
			const key = urlOf(input);
			if (key !== SRC) throw new Error(`unexpected fetch in test: ${key}`);
			return rangeOf(input, init) === null ? served.body() : served.probe();
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

/** 読み込みが終わる(Loading… が消える= 文言が出るか本文が表示される)まで待ってから落ち着かせる。 */
async function waitUntilLoaded(): Promise<void> {
	await vi.waitFor(() => {
		expect(messageText() ?? '').not.toContain('Loading…');
	});
	await settle();
}

/** 上限超のエラー表示の形: 文言が出て、stats も canvas も無く、解析もされていない。 */
function expectRejectedWithMessage(expected: string): void {
	expect(messageText(), '上限超えの文言').toBe(expected);
	expect(statsText(), '三角形数は出ない').toBeNull();
	expect(captured.constructed, '上限超えは ensureScene の手前で決まる= canvas は作られない').toBe(0);
	expect(captured.parsed, '上限超えの本文は解析に進まない').toBe(0);
}

/** 立方体(12 triangles)が普通に表示されている形。 */
function expectCubeDisplayed(): void {
	expect(messageText(), 'エラーも Loading… も出ない').toBeNull();
	expect(statsText()).toBe('12 triangles');
	expect(captured.parsed, '本文が解析に進んだ').toBe(1);
}

function tooLarge(mb: number): string {
	return `The file is too large (${mb}MB; limit 256MB)`;
}

/** 3 か所の判定それぞれに「大きさ `bytes`」を与える `Served` を作る。 */
const checkpoints = {
	/** 総量の問い合わせ(追補d)に 206 で `bytes` を答える。本文は小さな本物。 */
	probe(bytes: number): Served {
		const cube = bytesOf(CUBE_OBJ);
		return {
			probe: async () => probe206(bytes),
			body: async () => okResponse(async () => cube, cube.byteLength),
		};
	},
	/** 問い合わせは総量不明(200)。本文の `Content-Length` に `bytes` を申告する。本文は小さな本物。 */
	contentLength(bytes: number): Served {
		const cube = bytesOf(CUBE_OBJ);
		return {
			probe: async () => probeUnknown(),
			body: async () => okResponse(async () => cube, bytes),
		};
	},
	/** 問い合わせは総量不明(200)・本文に `Content-Length` 無し。`arrayBuffer()` が `bytes` を名乗る偽バッファを返す。 */
	arrayBuffer(bytes: number): Served {
		return {
			probe: async () => probeUnknown(),
			body: async () => okResponse(async () => claimedBuffer(bytes), null),
		};
	},
} as const;

type Checkpoint = keyof typeof checkpoints;
const CHECKPOINTS: [Checkpoint, string][] = [
	['probe', '総量の問い合わせ(追補d)'],
	['contentLength', 'Content-Length の先読み(追補c)'],
	['arrayBuffer', 'arrayBuffer() の後(要件#23 ⑥)'],
];

async function mountWith(served: Served): Promise<void> {
	stubFetchByRange(served);
	render(ModelViewer, { props: { uri: URI, src: SRC } });
	await waitUntilLoaded();
}

beforeEach(() => {
	captured.constructed = 0;
	captured.parsed = 0;
	vi.stubGlobal('ResizeObserver', NoopResizeObserver);
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

describe('ModelViewer × 大きさの上限の文言の MB は切り上げ(要件#23 追補e・AC-23-追e (a))', () => {
	// -----------------------------------------------------------------------
	// 上限+1 バイト → 257MB(3 か所とも)
	// -----------------------------------------------------------------------

	for (const [checkpoint, label] of CHECKPOINTS) {
		it(`AC-23-追e (a)-1 [${label}]: 256 MiB + 1 バイトは「The file is too large (257MB; limit 256MB)」(256MB ではない)`, async () => {
			await mountWith(checkpoints[checkpoint](LIMIT_BYTES + 1));
			expectRejectedWithMessage(tooLarge(257));
		});
	}

	// -----------------------------------------------------------------------
	// 300 MiB ちょうど → 300MB・300 MiB + 1 バイト → 301MB
	// -----------------------------------------------------------------------

	for (const [checkpoint, label] of CHECKPOINTS) {
		it(`AC-23-追e (a)-2 [${label}]: 300 MiB ちょうどは「The file is too large (300MB; limit 256MB)」(文言の形は今のまま)`, async () => {
			await mountWith(checkpoints[checkpoint](300 * MIB));
			expectRejectedWithMessage(tooLarge(300));
		});
	}

	it('AC-23-追e (a)-2 [総量の問い合わせ]: 300 MiB + 1 バイトは「301MB」= 切り上げは上限の近くだけの特別扱いではない', async () => {
		await mountWith(checkpoints.probe(300 * MIB + 1));
		expectRejectedWithMessage(tooLarge(301));
	});

	// -----------------------------------------------------------------------
	// 上限ちょうど → 断らない(今までどおり)
	// -----------------------------------------------------------------------

	it('AC-23-追e (a)-3 [総量の問い合わせ]: 256 MiB ちょうどは断らず、本文を取って 12 triangles が表示される', async () => {
		await mountWith(checkpoints.probe(LIMIT_BYTES));
		expectCubeDisplayed();
	});

	it('AC-23-追e (a)-3 [Content-Length の先読み]: 256 MiB ちょうどは断らず、12 triangles が表示される', async () => {
		await mountWith(checkpoints.contentLength(LIMIT_BYTES));
		expectCubeDisplayed();
	});

	it('AC-23-追e (a)-3 [arrayBuffer() の後]: 256 MiB ちょうどを名乗るバッファは断られず解析に渡る(文言は too large ではない)', async () => {
		// 偽バッファは本物の ArrayBuffer ではないので解析は別の理由で失敗するが、「上限ちょうどは
		// 断らない」= 大きさの判定を通って parseModel まで届くことだけを見る。
		await mountWith(checkpoints.arrayBuffer(LIMIT_BYTES));
		expect(captured.parsed, '上限ちょうどは解析に進む').toBe(1);
		expect(messageText() ?? '', '大きさの文言は出ない').not.toContain('The file is too large');
	});
});
