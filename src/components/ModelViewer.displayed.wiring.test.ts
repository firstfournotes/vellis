/**
 * 要件#64 追補f の受け入れテスト — ModelViewer の `onDisplayed`(docs/requirements/req-64.md 追補f・
 * Issue #717・AC-64-追f (d) の 3D の分)
 *
 * 「表示できた」の定義(契約3)= 3D は読み込みが ready(形状がシーンに載った時点)。大きすぎの断り
 * (256 MB 超)・壊れたモデル(幾何が無い)のエラー表示では呼ばない。
 *
 * ほかの 4 つのビューア(Image・Pdf・Video・Audio)と `+page.svelte` の配線は
 * src/components/recent-files-displayed.wiring.test.ts(three のモックが要る ModelViewer だけをここに分ける=
 * `ModelViewer.*.wiring.test.ts` の家風)。
 *
 * ## 確定契約(implementer はこれに従う)
 * - `ModelViewer.svelte` の props に省略できる `onDisplayed?: () => void` を足す。`loadModel` が
 *   `load = { kind: 'ready', … }` にした時点(= その読み込みが最新で、形状をシーンに載せた後)で 1 回呼ぶ。
 *   `error`(大きすぎ・HTTP・解析の失敗)では呼ばない。最新でない世代の結果では呼ばない(追補a・b の
 *   世代の確かめの中に置く)
 * - `src` が変わるたびの読み直し(版の更新)でも ready になれば呼んでよい(1 回開くごとに 1 回に絞るのは
 *   `+page.svelte` の `shouldRecordDisplayedOnce`= src/lib/recent-files-displayed.acceptance.test.ts)
 *
 * ## 観測方式(`ModelViewer.content-length.wiring.test.ts` と同じ家風)
 * JSDOM には WebGL が無いので `vi.mock('three')` で `WebGLRenderer` だけをスタブに差し替え、残りは本物。
 * fetch は偽 Response: 総量の問い合わせ(`Range: bytes=0-0`)には 206 + `Content-Range` で総量を
 * 答えるか(大きすぎの経路)、206 でない応答で「分からない」と答え(本文へ進む)、本文の要求には
 * 小さな本物の OBJ を返す。
 *
 * 実装前に赤い理由: `onDisplayed` が props に無いので、ready になっても呼ばれない((a) が赤。
 * `pnpm check` も未知の prop で赤)。(b)(c) は「呼ばれない」の固定で最初から緑(退行防止)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

const captured = vi.hoisted(() => ({
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
		render(_scene: unknown, _camera: unknown): void {}
		dispose(): void {}
	}
	return { ...actual, WebGLRenderer: StubWebGLRenderer };
});

import ModelViewer from './ModelViewer.svelte';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

/** 立方体 [0,5]^3・12 三角形。 */
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

/** 幾何の無い OBJ(コメントだけ)= 壊れたモデルの失敗経路(The model has no drawable geometry)。 */
const EMPTY_OBJ = `# just a comment, no geometry
`;

const MIB = 1024 * 1024;
/** 上限(要件#23 契約⑥・`ModelViewer.svelte` の `MAX_BYTES`)。 */
const LIMIT_BYTES = 256 * MIB;

const URI = 'file:///Users/a/models/part.obj';
const SRC = 'vellis-asset://local/Users/a/models/part.obj';

function bytesOf(source: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(source);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

class NoopResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

/** 要求の `Range` ヘッダ(`init.headers` は素のオブジェクト・`Headers`・タプル配列のどれでも)。 */
function rangeOf(init: RequestInit | undefined): string | null {
	const headers = init?.headers;
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get('range');
	if (Array.isArray(headers)) {
		const hit = headers.find(([name]) => name.toLowerCase() === 'range');
		return hit ? hit[1] : null;
	}
	const record = headers as Record<string, string>;
	const key = Object.keys(record).find((name) => name.toLowerCase() === 'range');
	return key ? record[key] : null;
}

/**
 * fetch を固定する。`total` があれば総量の問い合わせ(`Range: bytes=0-0`)に 206 + `Content-Range` で
 * 答える(大きすぎの経路)。無ければ 200(総量は分からない → 本文へ進む)。本文の要求には `body`。
 */
function stubFetch(options: { total?: number; body: ArrayBuffer }): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			if (rangeOf(init) === 'bytes=0-0' && options.total !== undefined) {
				return {
					ok: true,
					status: 206,
					headers: {
						get: (name: string) =>
							name.toLowerCase() === 'content-range' ? `bytes 0-0/${options.total}` : null,
					},
					arrayBuffer: async () => new ArrayBuffer(1),
				};
			}
			return {
				ok: true,
				status: 200,
				headers: { get: () => null },
				arrayBuffer: async () => options.body,
			};
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

const statsText = () => document.querySelector('.model-stats')?.textContent ?? null;
const messageText = () => document.querySelector('.model-message')?.textContent ?? null;

beforeEach(() => {
	captured.constructed = 0;
	vi.stubGlobal('ResizeObserver', NoopResizeObserver);
	vi.stubGlobal(
		'requestAnimationFrame',
		vi.fn((cb: FrameRequestCallback) => {
			cb(0);
			return 1;
		}),
	);
	vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('AC-64-追f(d) ModelViewer の onDisplayed(契約3= 3D は読み込みが ready)', () => {
	it('(a) 正常なモデルが ready になると onDisplayed を 1 回呼ぶ', async () => {
		stubFetch({ body: bytesOf(CUBE_OBJ) });
		const onDisplayed = vi.fn();
		render(ModelViewer, { props: { uri: URI, src: SRC, onDisplayed } });

		await vi.waitFor(() => expect(statsText()).toBe('12 triangles'));
		await settle();
		expect(captured.constructed).toBe(1);
		expect(onDisplayed).toHaveBeenCalledTimes(1);

		// 追加の描画・再描画では増えない。
		await settle();
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	it('(b) 256 MB を超える(大きすぎの断り)では呼ばない', async () => {
		stubFetch({ total: LIMIT_BYTES + 1, body: bytesOf(CUBE_OBJ) });
		const onDisplayed = vi.fn();
		render(ModelViewer, { props: { uri: URI, src: SRC, onDisplayed } });

		await vi.waitFor(() => expect(messageText()).toContain('The file is too large'));
		await settle();
		expect(statsText()).toBeNull();
		expect(captured.constructed).toBe(0);
		expect(onDisplayed).not.toHaveBeenCalled();
	});

	it('(c) 壊れたモデル(幾何が無い)のエラー表示では呼ばない', async () => {
		stubFetch({ body: bytesOf(EMPTY_OBJ) });
		const onDisplayed = vi.fn();
		render(ModelViewer, { props: { uri: URI, src: SRC, onDisplayed } });

		await vi.waitFor(() => expect(messageText()).toContain('The model has no drawable geometry'));
		await settle();
		expect(statsText()).toBeNull();
		expect(onDisplayed).not.toHaveBeenCalled();
	});

	it('onDisplayed を省略しても ready まで進む(省略できる callback)', async () => {
		stubFetch({ body: bytesOf(CUBE_OBJ) });
		render(ModelViewer, { props: { uri: URI, src: SRC } });
		await vi.waitFor(() => expect(statsText()).toBe('12 triangles'));
	});
});
