/**
 * 要件#58 追補b の受け入れテスト — ModelViewer の配線(AC-58-21 (d)・契約 3)
 * (docs/requirements/req-58.md「追補b(2026-10-20・Issue #557)」。パース本体 (a)〜(c) は
 *  src/lib/model-ply-damaged.acceptance.test.ts が持つ)
 *
 * ## 契約(追補b・配線の分)
 * 3. `ModelViewer` は今の失敗の経路(`parseModel` の reject → `load.kind === 'error'`)のまま、
 *    `The PLY file is damaged and could not be read` を `.model-message` に出す(統計は出さず、描画面も作らない)
 * 4. 不変: 頂点0の PLY は今までどおり `The model has no drawable geometry`
 *
 * 確定した API: `src/lib/model-viewing.ts` の `PLY_UNREADABLE_MESSAGE`(値はこのファイルでも文字列で固定する=
 * 配線テストは値そのものを `.model-message` に求める)。`ModelViewer` の props(`uri` / `src`)は不変。
 *
 * ## 観測方式(ModelViewer.ply.wiring.test.ts と同じ家風+追補d の問い合わせへの応答)
 * JSDOM には WebGL が無いので `vi.mock('three')` で `WebGLRenderer` だけをスタブ(生成回数と render に
 * 渡された Scene を記録)に差し替え、残りは本物。`ModelViewer` は本文を取る前に同じ URL へ
 * `Range: bytes=0-0` の問い合わせを送る(要件#23 追補d)ので、偽 fetch は **Range 付きの要求には 206
 * (`Content-Range: bytes 0-0/<total>`・`Content-Length: 1`・本文 1 バイト)、Range の無い要求には 200 と
 * 全本文** を返す(ModelViewer.range-probe.wiring.test.ts の `stubFetchByRange` と同じ形)。
 *
 * ## 判定
 * - (d) 壊れたヘッダの PLY(本体が欠けた binary ヘッダ= AC-58-12 と同じ組み方)を開くと `.model-message` が
 *   (1) の文そのもの。`.model-stats` は無く、renderer も canvas も作られない
 * - 不変: 頂点0の PLY は `The model has no drawable geometry`(問い合わせに答える偽 fetch でも同じ)
 *
 * 実装前に赤: (d) は `.model-message` が PLYLoader の内部例外の文(Node では
 * 「Offset is outside the bounds of the DataView」)のままで一致しない。不変の1件は実装前から緑。
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

import ModelViewer from './ModelViewer.svelte';

/** 契約 1 の文言(src/lib/model-viewing.ts の `PLY_UNREADABLE_MESSAGE` と同じ値)。 */
const PLY_UNREADABLE_MESSAGE = 'The PLY file is damaged and could not be read';
/** 既存の失敗経路の文言(不変)。 */
const NO_GEOMETRY_MESSAGE = 'The model has no drawable geometry';

const PROPS = {
	uri: 'file:///Users/a/scans/scan.ply',
	src: 'vellis-asset://local/Users/a/scans/scan.ply',
};

/** 本体が欠けた binary ヘッダ(vertex 1000 なのに 8 バイト)= AC-58-12 と同じ組み方。 */
function truncatedBinaryPly(): Uint8Array {
	const header =
		'ply\nformat binary_little_endian 1.0\nelement vertex 1000\n' +
		'property float x\nproperty float y\nproperty float z\nend_header\n';
	const headerBytes = new TextEncoder().encode(header);
	const bytes = new Uint8Array(headerBytes.length + 8);
	bytes.set(headerBytes, 0);
	return bytes;
}

/** 頂点0の PLY = 既存の失敗経路(boundsOf)へ落ちる入力(不変の判定)。 */
const EMPTY_PLY = `ply
format ascii 1.0
element vertex 0
property float x
property float y
property float z
end_header
`;

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

type FetchInput = string | URL | { url: string; headers: { get: (name: string) => string | null } };

/** 要求の `Range` ヘッダの値(無ければ null)。ヘッダの渡し方は実装裁量なので一通り読む。 */
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

/**
 * fetch を「問い合わせ(Range 付き)には 206 と総量・本文(Range 無し)には 200 と全本文」を返す偽 fetch に
 * 固定する(Rust 側 `commands/asset.rs` の形。ModelViewer.range-probe.wiring.test.ts と同じ)。
 */
function stubFetchServing(bytes: Uint8Array): void {
	const total = bytes.byteLength;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: FetchInput, init?: RequestInit): Promise<FakeResponse> => {
			if (rangeOf(input, init) !== null) {
				return {
					ok: true,
					status: 206,
					headers: headersOf({
						'Accept-Ranges': 'bytes',
						'Content-Length': '1',
						'Content-Range': `bytes 0-0/${total}`,
					}),
					arrayBuffer: async () => new ArrayBuffer(1),
				};
			}
			return {
				ok: true,
				status: 200,
				headers: headersOf({ 'Accept-Ranges': 'bytes', 'Content-Length': String(total) }),
				arrayBuffer: async () =>
					bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
			};
		}),
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
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('ModelViewer × 壊れた PLY の配線(要件#58 追補b・契約 3)', () => {
	it('AC-58-21 (d): 壊れたヘッダの PLY を開くと .model-message が「The PLY file is damaged and could not be read」になり、統計も描画面も無い', async () => {
		stubFetchServing(truncatedBinaryPly());
		render(ModelViewer, { props: PROPS });

		// 文そのもの(実装前は PLYLoader の内部例外の文が出るため、この一致判定が赤の根拠になる)。
		await vi.waitFor(() => {
			expect(document.querySelector('.model-message')?.textContent ?? '').toBe(PLY_UNREADABLE_MESSAGE);
		});

		// 統計表示は出ない(points / triangles のどちらも)。
		expect(document.querySelector('.model-stats')).toBeNull();

		// エラー経路は ensureScene の手前で決まる= 3D の描画面(canvas)は作られない。
		expect(captured.constructed).toBe(0);
		expect(document.querySelector('.model-stage canvas')).toBeNull();
		expect(captured.scenes.length).toBe(0);
	});

	it('不変: 頂点0の PLY は今までどおり「The model has no drawable geometry」(問い合わせに答える偽 fetch でも同じ)', async () => {
		stubFetchServing(new TextEncoder().encode(EMPTY_PLY));
		render(ModelViewer, { props: PROPS });

		await vi.waitFor(() => {
			expect(document.querySelector('.model-message')?.textContent ?? '').toBe(NO_GEOMETRY_MESSAGE);
		});

		expect(document.querySelector('.model-stats')).toBeNull();
		expect(captured.constructed).toBe(0);
	});
});
