/**
 * 要件#58 追補b の受け入れテスト(docs/requirements/req-58.md「追補b(2026-10-20・Issue #557)」)
 * — 壊れた PLY は利用者向けの1文で reject する(AC-58-21 (a)(b)(c)・契約 1・2・4。unit プロジェクト。
 *   ModelViewer の配線 (d) は src/components/ModelViewer.ply-damaged.wiring.test.ts が持つ)
 *
 * 今は、本体が欠けた binary ヘッダの PLY を開くと PLYLoader の内部例外(WebKit では「Out of bounds access」・
 * Node では「Offset is outside the bounds of the DataView」)がそのまま `.model-message` に出る。
 *
 * ## 契約(追補b)— implementer はこれに従う
 * 1. `parseModel` の PLY の分岐で、`PLYLoader.parse` と `wrapPlyGeometry` が投げた例外は、
 *    `The PLY file is damaged and could not be read` の `Error` にして reject する(元の例外は `cause` に入れる)。
 *    文言は `model-viewing.ts` から定数として export する
 * 2. 頂点0の PLY は今までどおり `The model has no drawable geometry`(`boundsOf` の経路。parse は投げない)
 * 3. `ModelViewer` は今の失敗の経路のまま、この文を `.model-message` に出す(= wiring テスト)
 * 4. 不変: 正常な PLY(ascii / binary の両方・点群とメッシュ)・STL / 3MF / OBJ の失敗の文言・大きすぎるとき・
 *    HTTP の失敗。依存の追加なし
 *
 * ## 確定した API(test-writer 2026-10-20 決定)
 * ```ts
 * // src/lib/model-viewing.ts
 * export const PLY_UNREADABLE_MESSAGE = 'The PLY file is damaged and could not be read';
 * ```
 * 未実装の export なので、静的な名前付き import(実装前に `pnpm check` が落ちる)ではなく名前空間 import から
 * 取り出す(go-to-broken-link.acceptance.test.ts と同じ家風)。`parseModel` の signature は不変。
 *
 * ## 判定(AC-58-21)
 * - (a) 本体が欠けた binary ヘッダ(AC-58-12 と同じ組み方)は (1) の文で reject する。
 *   文に `Out of bounds`・`RangeError`・`DataView`(・`Offset`)を含まない。元の例外は `cause`
 * - (b) PLY ですらないバイト列は (1) の文か `The model has no drawable geometry` のどちらかで reject する
 *   (内部の文を出さない)
 * - (c) 頂点0の PLY は `The model has no drawable geometry` のまま
 * - (e) 既存のテストは無改変で緑= test-runner のフルスイートが判定(本ファイルでは扱わない)
 *
 * ## 判断の記録(test-writer 2026-10-20)
 * - 契約 1 の「`PLYLoader.parse` と `wrapPlyGeometry` が投げた例外」は、バイト列だけでは `wrapPlyGeometry` を
 *   投げさせられないので、`PLYLoader.prototype.parse` を差し替えて (1) parse が任意の例外を投げる・(2) parse が
 *   返した "ジオメトリ" を包む段で投げる、の2通りを別に判定する(`cause` が元の例外そのものであることもここで見る)
 * - (b) の「どちらか」は実装裁量(PLYLoader が投げるかどうかで行き先が変わる)なので、2つの文の集合で判定し、
 *   内部の文を含まないことだけを固定する。今の PLYLoader は magic 無しのバイト列を頂点0として返すので、
 *   (b) は実装前から緑になり得る(退行防止の位置づけ)
 * - 実装前に赤: 定数の存在・(a) の4件(文言が DataView の RangeError のまま・`cause` 無し)。
 *   (b)(c) と「不変」の節は実装前から緑(退行防止)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

import * as modelViewing from './model-viewing';
import { parseModel } from './model-viewing';

/** 契約 1 の文言(値固定・英語=要件#51)。 */
const PLY_UNREADABLE_MESSAGE = 'The PLY file is damaged and could not be read';
/** 既存の失敗経路(`boundsOf`)の文言(契約 2・不変)。 */
const NO_GEOMETRY_MESSAGE = 'The model has no drawable geometry';
/** 利用者に見せない内部の文(WebKit / Node の DataView の RangeError に現れる語)。 */
const INTERNAL_WORDS = ['Out of bounds', 'RangeError', 'DataView', 'Offset'] as const;

const ROOT = 'file:///Users/a/work';
const PLY = `${ROOT}/scans/scan.ply`;

/** フィクスチャを ArrayBuffer で読む(model-ply.acceptance.test.ts と同じ切り出し)。 */
function fixture(name: string): ArrayBuffer {
	const buf = readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)));
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** 本体が欠けた binary ヘッダ(vertex 1000 なのに 8 バイト)= AC-58-12 と同じ組み方。 */
function truncatedBinaryPly(): ArrayBuffer {
	const header =
		'ply\nformat binary_little_endian 1.0\nelement vertex 1000\n' +
		'property float x\nproperty float y\nproperty float z\nend_header\n';
	const headerBytes = new TextEncoder().encode(header);
	const bytes = new Uint8Array(headerBytes.length + 8);
	bytes.set(headerBytes, 0);
	return bytes.buffer as ArrayBuffer;
}

/** PLY ですらないバイト列(magic なし・非 ASCII 主体)= AC-58-12 と同じ組み方。 */
function junkBytes(): ArrayBuffer {
	const junk = new Uint8Array(64);
	for (let i = 0; i < junk.length; i++) junk[i] = 0x80 + ((i * 31) % 100);
	return junk.buffer as ArrayBuffer;
}

/** すべて 0 のバイト列(magic なし)。 */
function zeroBytes(): ArrayBuffer {
	return new Uint8Array(64).buffer as ArrayBuffer;
}

/** reject を待ち、`Error` で reject したことを確かめて返す。 */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
	let caught: unknown;
	let rejected = false;
	try {
		await promise;
	} catch (error) {
		caught = error;
		rejected = true;
	}
	expect(rejected, 'reject すること').toBe(true);
	expect(caught, 'Error で reject すること').toBeInstanceOf(Error);
	return caught as Error;
}

function expectNoInternalWords(message: string): void {
	for (const word of INTERNAL_WORDS) {
		expect(message, `内部の文「${word}」を含まない`).not.toContain(word);
	}
}

beforeEach(() => {
	// 3MF / STL の壊れた入力でローダーが console に出す分を黙らせる(判定は reject の文言)。
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 定数(契約 1)
// ---------------------------------------------------------------------------

describe('AC-58-21 定数 — PLY_UNREADABLE_MESSAGE(値固定・英語=要件#51)', () => {
	test("model-viewing.ts が PLY_UNREADABLE_MESSAGE を export し、値は 'The PLY file is damaged and could not be read'", () => {
		expect((modelViewing as unknown as Record<string, unknown>).PLY_UNREADABLE_MESSAGE).toBe(
			PLY_UNREADABLE_MESSAGE,
		);
	});
});

// ---------------------------------------------------------------------------
// (a) 本体が欠けた binary ヘッダ
// ---------------------------------------------------------------------------

describe('AC-58-21 (a) — 本体が欠けた binary ヘッダは利用者向けの1文で reject する(契約 1)', () => {
	test('文言は PLY_UNREADABLE_MESSAGE そのもの(Out of bounds / RangeError / DataView / Offset を含まない)', async () => {
		const error = await rejectionOf(parseModel(PLY, truncatedBinaryPly()));
		expect(error.message).toBe(PLY_UNREADABLE_MESSAGE);
		expectNoInternalWords(error.message);
	});

	test('元の例外(PLYLoader の内部例外)は cause に入る', async () => {
		const error = await rejectionOf(parseModel(PLY, truncatedBinaryPly()));
		const cause = (error as { cause?: unknown }).cause;
		expect(cause, '元の例外を cause に残す').toBeInstanceOf(Error);
		expect((cause as Error).message, 'cause は利用者向けの文ではなく元の例外').not.toBe(PLY_UNREADABLE_MESSAGE);
	});

	test('PLYLoader.parse が投げた任意の例外も同じ文に包み、cause はその例外そのもの', async () => {
		const original = new Error('synthetic loader failure');
		vi.spyOn(PLYLoader.prototype, 'parse').mockImplementation(() => {
			throw original;
		});

		const error = await rejectionOf(parseModel(PLY, fixture('cloud-ascii.ply')));
		expect(error.message).toBe(PLY_UNREADABLE_MESSAGE);
		expect((error as { cause?: unknown }).cause).toBe(original);
	});

	test('wrapPlyGeometry が投げた例外(parse の返り値を包む段)も同じ文に包み、cause はその例外そのもの', async () => {
		const original = new Error('synthetic geometry failure');
		const brokenGeometry = {
			isBufferGeometry: true,
			getAttribute: () => {
				throw original;
			},
			getIndex: () => {
				throw original;
			},
		};
		vi.spyOn(PLYLoader.prototype, 'parse').mockImplementation(
			() => brokenGeometry as unknown as ReturnType<PLYLoader['parse']>,
		);

		const error = await rejectionOf(parseModel(PLY, fixture('cloud-ascii.ply')));
		expect(error.message).toBe(PLY_UNREADABLE_MESSAGE);
		expect((error as { cause?: unknown }).cause).toBe(original);
	});
});

// ---------------------------------------------------------------------------
// (b) PLY ですらないバイト列
// ---------------------------------------------------------------------------

describe('AC-58-21 (b) — PLY ですらないバイト列は (1) の文か「no drawable geometry」で reject する(内部の文を出さない)', () => {
	test.each([
		['非 ASCII 主体の無意味なバイト列(AC-58-12 と同じ)', junkBytes],
		['すべて 0 のバイト列', zeroBytes],
	])('%s', async (_label, bytes) => {
		const error = await rejectionOf(parseModel(PLY, bytes()));
		expect([PLY_UNREADABLE_MESSAGE, NO_GEOMETRY_MESSAGE]).toContain(error.message);
		expectNoInternalWords(error.message);
	});
});

// ---------------------------------------------------------------------------
// (c) 頂点0の PLY(契約 2・不変)
// ---------------------------------------------------------------------------

describe('AC-58-21 (c) — 頂点0の PLY は「The model has no drawable geometry」のまま(契約 2)', () => {
	test('empty.ply → NO_GEOMETRY_MESSAGE(PLY の文に置き換えない)', async () => {
		const error = await rejectionOf(parseModel(PLY, fixture('empty.ply')));
		expect(error.message).toBe(NO_GEOMETRY_MESSAGE);
	});
});

// ---------------------------------------------------------------------------
// 不変(契約 4)
// ---------------------------------------------------------------------------

describe('AC-58-21 不変(契約 4) — 正常な PLY と STL / 3MF / OBJ の失敗の文言は今のまま', () => {
	test.each([
		['cloud-ascii.ply', 'points'],
		['cloud-binary-le.ply', 'points'],
		['cloud-binary-be.ply', 'points'],
		['cube-mesh.ply', 'mesh'],
	])('%s は今までどおり読める(kind=%s・8 頂点)', async (name, kind) => {
		const model = await parseModel(PLY, fixture(name));
		expect(model.kind).toBe(kind);
		expect(model.pointCount).toBe(8);
	});

	test.each(['stl', '3mf', 'obj'])(
		'壊れた .%s の reject の文言は PLY の文にならない(Issue の範囲外=今のまま)',
		async (extension) => {
			const error = await rejectionOf(parseModel(`${ROOT}/models/broken.${extension}`, junkBytes()));
			expect(error.message).not.toBe(PLY_UNREADABLE_MESSAGE);
		},
	);
});
