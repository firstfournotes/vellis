/**
 * 要件#57 の受け入れテスト — OBJ 形式の 3D 表示(docs/requirements/req-57.md)
 * 「3D モデル表示に OBJ 形式(Wavefront .obj)を追加する(幾何のみ・材質は対象外)」
 *
 * 本ファイルの判定範囲: AC-57-1〜12・15(分類・経路選択・パース・材質無視・
 * 縮退・決定性・依存の不変)。ビューア配線(AC-57-13/14)は
 * src/components/ModelViewer.obj.wiring.test.ts が持つ。
 *
 * ## 確定契約(implementer はこれに従う。正本= docs/requirements/req-57.md)
 *
 * 1. `detectFileType`(src/lib/file-type.ts): `MODEL3D_EXTENSIONS` に `obj` を
 *    追加し `.obj` を `'model3d'` と判定する(契約①)。境界規則は既存を継承
 *    (大文字小文字不問・最終セグメントの最後の拡張子・ディレクトリ名を誤認しない)。
 *    既存分類は不変。
 * 2. 経路は種別で決まるので追加の分岐は不要(契約①④): `readsAsText`(obj)= false・
 *    `openCommandFor`(obj)= `open_binary_document`・`renderForDisplay`(obj)=
 *    `modelSrc = toAssetUri(uri)`・`restoreSnapshot` は model3d 経路
 *    (`set_root` → `open_binary_document`、`open_document` は呼ばない)。
 * 3. `parseModel`(src/lib/model-viewing.ts): 拡張子スイッチに `obj` を足し、
 *    three 同梱の `three/examples/jsm/loaders/OBJLoader.js` でパースする(契約②)。
 *    `OBJLoader.parse` は文字列を取るので `TextDecoder`(**fatal: false**)で変換する。
 *    戻りは `ParsedModel` で STL / 3MF と同じ形。法線が無ければ既存 `summarize` の
 *    `computeVertexNormals` 経路で補完。四角形面は三角形化(1 面 → 2 三角形)。
 *    `g` / `o` の複数グループは 1 つの `object` に統合。
 * 4. 材質(契約③): `mtllib` / `usemtl` は無視し `.mtl` を取りに行かない
 *    (fetch を発行しない)。マテリアルは STL と同じ単色
 *    (`MeshStandardMaterial`・`0xb9c0c8` / metalness 0.1 / roughness 0.65・map なし)。
 * 5. 縮退(契約⑤): 面が 1 つも無い OBJ は既存の失敗経路
 *    (`boundsOf` の「The model has no drawable geometry」)で reject。新しい文言は
 *    足さない。壊れた行・未知の行は読み飛ばす(面が読めるぶんは表示する)。
 * 6. 不変(契約⑥): 依存追加ゼロ(package.json / Cargo.toml の dependencies に
 *    追加しない)。src-tauri/** 無改変・既存 STL / 3MF acceptance の無改変緑は
 *    test-runner のフルスイートと reviewer 照合が判定する(本ファイルは依存の
 *    固定だけを機械判定する= git diff に依存しない形)。
 *
 * フィクスチャは OBJ がテキスト形式であることを利用して文字列リテラルで組む
 * (src/lib/__fixtures__/ にバイナリは足さない)。立方体は **[0,5]^3** —
 * STL([0,10]^3)・3MF([0,20]^3)と違う寸法にしてあり、数値そのものが
 * 「正しいローダーに渡った」ことの判定材料になる(要件#23 の作法)。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mesh, MeshStandardMaterial, Object3D } from 'three';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import { detectFileType, renderForDisplay } from './file-type';
import { readsAsText } from './image-viewing';
import { parseModel } from './model-viewing';
import { openCommandFor } from './open-document';
import { restoreSnapshot } from './reload-state';
import { toAssetUri } from './uri';

const invokeMock = vi.mocked(invoke);

const ROOT = 'file:///Users/a/work';
const OBJ = `${ROOT}/models/cube.obj`;

// ---------------------------------------------------------------------------
// フィクスチャ(文字列リテラル)。立方体 [0,5]^3(STL の 10・3MF の 20 と違う値)。
// ---------------------------------------------------------------------------

/** 立方体の 8 頂点([0,5]^3)。 */
const CUBE_VERTICES = `v 0 0 0
v 5 0 0
v 5 5 0
v 0 5 0
v 0 0 5
v 5 0 5
v 5 5 5
v 0 5 5
`;

/** 三角形面(f a b c)だけの立方体= 12 三角形。vn 行は無い(AC-57-5 の前提)。 */
const CUBE_TRI = `${CUBE_VERTICES}f 1 2 3
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

/** 四角形面(f a b c d)だけの立方体= 6 四角形 → 三角形化で 12 三角形。 */
const CUBE_QUAD = `${CUBE_VERTICES}f 1 2 3 4
f 5 6 7 8
f 1 2 6 5
f 2 3 7 6
f 3 4 8 7
f 4 1 5 8
`;

/**
 * o で 2 グループ: 立方体 [0,5]^3(12 三角形)+ x=10..12 の三角形 1 枚。
 * 合計 13 三角形・全体の外接箱は [0,0,0]-[12,5,5]。
 */
const TWO_GROUPS = `o CubeA
${CUBE_TRI}o TriB
v 10 0 0
v 12 0 0
v 10 2 0
f 9 10 11
`;

/** コメント・空行・vt・未知キーワードを混ぜた立方体(12 三角形のまま読める)。 */
const NOISY_CUBE = `# exported by nothing in particular

vt 0 0
vt 1 0
s off
foobar 1 2 3
${CUBE_TRI}
# trailing comment
`;

/** mtllib / usemtl を含む立方体(.mtl は読みに行かない)。 */
const CUBE_WITH_MTL = `mtllib cube.mtl
usemtl red
${CUBE_TRI}`;

function toBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function expectBounds(
	bounds: { min: [number, number, number]; max: [number, number, number] },
	min: [number, number, number],
	max: [number, number, number],
): void {
	for (const axis of [0, 1, 2] as const) {
		expect(bounds.min[axis], `min[${axis}]`).toBeCloseTo(min[axis], 5);
		expect(bounds.max[axis], `max[${axis}]`).toBeCloseTo(max[axis], 5);
	}
}

/** object 配下の Mesh を列挙する(グループ構成に依存しない観測)。 */
function meshesOf(object: Object3D): Mesh[] {
	const meshes: Mesh[] = [];
	object.traverse((child) => {
		if ((child as Mesh).isMesh) meshes.push(child as Mesh);
	});
	return meshes;
}

beforeEach(() => {
	invokeMock.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// AC-57-1 — detectFileType: .obj は model3d(契約①)
// ---------------------------------------------------------------------------

describe('AC-57-1 detectFileType — .obj を model3d と判定する(要件#57 ①)', () => {
	test('ベース名の obj は model3d', () => {
		expect(detectFileType('cube.obj')).toBe('model3d');
	});

	test('大文字小文字を問わない(PART.OBJ)', () => {
		expect(detectFileType('PART.OBJ')).toBe('model3d');
		expect(detectFileType('Part.Obj')).toBe('model3d');
	});

	test('パス・file:// URI でも最終セグメントの拡張子で判定する', () => {
		expect(detectFileType('/tmp/scan.obj')).toBe('model3d');
		expect(detectFileType(OBJ)).toBe('model3d');
	});

	test('最後の拡張子だけで判定する(mesh.obj.txt は text)', () => {
		expect(detectFileType('mesh.obj.txt')).toBe('text');
		expect(detectFileType('notes.txt.obj')).toBe('model3d');
	});

	test('ディレクトリ名中の .obj を拡張子と誤認しない', () => {
		expect(detectFileType('file:///home/user.obj/Makefile')).toBe('text');
	});

	test('既存分類は不変(stl / 3mf / md / html / 画像 / 動画 / 音声 / pdf / binary / フォールバック)', () => {
		expect(detectFileType('part.stl')).toBe('model3d');
		expect(detectFileType('bracket.3mf')).toBe('model3d');
		expect(detectFileType('README.md')).toBe('markdown');
		expect(detectFileType('page.html')).toBe('html');
		expect(detectFileType('icon.svg')).toBe('image');
		expect(detectFileType('photo.png')).toBe('image');
		expect(detectFileType('clip.mp4')).toBe('video');
		expect(detectFileType('take.wav')).toBe('audio');
		expect(detectFileType('paper.pdf')).toBe('pdf');
		expect(detectFileType('report.zip')).toBe('binary');
		expect(detectFileType('data.xyz')).toBe('text'); // 未知拡張子のフォールバックも不変
		expect(detectFileType('Makefile')).toBe('text');
	});
});

// ---------------------------------------------------------------------------
// AC-57-2 — 経路が種別で決まる(契約①④)
// ---------------------------------------------------------------------------

describe('AC-57-2 経路選択 — obj は model3d の既存経路に乗る(要件#57 ①④)', () => {
	test('readsAsText: .obj は false(model3d 全体が false)', () => {
		expect(readsAsText('x.obj')).toBe(false);
		expect(readsAsText(OBJ)).toBe(false);
	});

	test('openCommandFor: obj は open_binary_document', () => {
		expect(openCommandFor(OBJ)).toBe('open_binary_document');
	});

	test('renderForDisplay: obj は modelSrc = toAssetUri(uri)・html は空・index は null', async () => {
		const res = await renderForDisplay(OBJ, '');
		expect(res.modelSrc).toBe(toAssetUri(OBJ));
		expect(res.html).toBe('');
		expect(res.index).toBeNull();
		// 他のビューアの合図と排他(modelSrc の存在だけが ModelViewer を選ぶ)
		expect(res.srcdoc).toBeUndefined();
		expect(res.imageSrc).toBeUndefined();
		expect(res.videoSrc).toBeUndefined();
		expect(res.audioSrc).toBeUndefined();
		expect(res.pdfSrc).toBeUndefined();
	});

	test('restoreSnapshot: obj の docUri は set_root → open_binary_document(open_document は呼ばない)', async () => {
		const rootPayload = { root_uri: ROOT, entries: [], document_retained: false };
		const modelPayload = { uri: OBJ, content: '', modified: null };
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'set_root') return rootPayload;
			if (cmd === 'open_binary_document') return modelPayload;
			throw new Error(`unexpected command: ${cmd}`);
		});

		const res = await restoreSnapshot({ rootUri: ROOT, docUri: OBJ, expandedDirs: [] });

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root', 'open_binary_document']);
		expect(invokeMock.mock.calls[1]?.[1]).toEqual({ uri: OBJ });
		expect(res).toEqual({ ok: true, root: rootPayload, document: modelPayload });
	});
});

// ---------------------------------------------------------------------------
// AC-57-3〜7 — parseModel の OBJ パース(契約②)
// ---------------------------------------------------------------------------

describe('AC-57-3〜7 parseModel — OBJ の幾何(要件#57 ②)', () => {
	test('AC-57-3: 三角形面の立方体が 12 三角形・bbox [0,5]^3 で読める', async () => {
		const model = await parseModel(OBJ, toBuffer(CUBE_TRI));
		expect(model.triangleCount).toBe(12);
		expectBounds(model.bounds, [0, 0, 0], [5, 5, 5]);
		expect(model.object).toBeTruthy();
	});

	test('AC-57-4: 四角形面の立方体は三角形化されて 12 三角形・bounds は三角形版と一致', async () => {
		const quad = await parseModel(OBJ, toBuffer(CUBE_QUAD));
		expect(quad.triangleCount).toBe(12); // 四角形 1 面 → 2 三角形(扇状分割)
		const tri = await parseModel(OBJ, toBuffer(CUBE_TRI));
		expect(quad.bounds).toEqual(tri.bounds);
	});

	test('AC-57-5: vn 行が無くても reject されず、ジオメトリに normal 属性が生えている', async () => {
		const model = await parseModel(OBJ, toBuffer(CUBE_TRI));
		const meshes = meshesOf(model.object);
		expect(meshes.length).toBeGreaterThan(0);
		for (const mesh of meshes) {
			// computeVertexNormals が効いた=そのまま描いても真っ黒にならない
			expect(mesh.geometry.getAttribute('normal'), 'normal 属性').toBeTruthy();
		}
	});

	test('AC-57-6: g / o の 2 グループは 1 つの object に統合され、triangleCount は合計・bounds は全体の外接箱', async () => {
		const model = await parseModel(OBJ, toBuffer(TWO_GROUPS));
		expect(model.object).toBeTruthy(); // 戻りは単一の Object3D
		expect(model.triangleCount).toBe(13); // 12 + 1 の合計
		expectBounds(model.bounds, [0, 0, 0], [12, 5, 5]); // 両グループを包む外接箱
	});

	test('AC-57-7: コメント・空行・未知キーワード・vt 行を含んでも失敗せず、面の数どおり読める', async () => {
		// OBJLoader は未知の行を console.warn で読み飛ばす(例外にしない)。
		// テスト出力を汚さないよう warn は握りつぶす(呼ばれること自体は判定しない)。
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const model = await parseModel(OBJ, toBuffer(NOISY_CUBE));
		expect(model.triangleCount).toBe(12);
		expectBounds(model.bounds, [0, 0, 0], [5, 5, 5]);
	});
});

// ---------------------------------------------------------------------------
// AC-57-8 — MTL を無視する(契約③)
// ---------------------------------------------------------------------------

describe('AC-57-8 parseModel — mtllib / usemtl は無視し .mtl を取りに行かない(要件#57 ③)', () => {
	test('mtllib / usemtl を含む OBJ が読め、fetch は一度も呼ばれない', async () => {
		const fetchSpy = vi.fn(async () => {
			throw new Error('parseModel must not fetch sidecar files');
		});
		vi.stubGlobal('fetch', fetchSpy);

		const model = await parseModel(OBJ, toBuffer(CUBE_WITH_MTL));

		expect(model.triangleCount).toBe(12);
		expect(fetchSpy).not.toHaveBeenCalled(); // .mtl もテクスチャも読みに行かない
	});

	test('マテリアルは STL と同じ単色(MeshStandardMaterial・0xb9c0c8・map なし)', async () => {
		const model = await parseModel(OBJ, toBuffer(CUBE_WITH_MTL));
		const meshes = meshesOf(model.object);
		expect(meshes.length).toBeGreaterThan(0);
		for (const mesh of meshes) {
			const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
			for (const material of materials) {
				const standard = material as MeshStandardMaterial;
				expect(standard.isMeshStandardMaterial, 'MeshStandardMaterial であること').toBe(true);
				expect(standard.map, 'テクスチャは貼らない').toBeFalsy();
				// STL と見た目を揃える既知の値(契約③= stlMaterial と同じ)
				expect(standard.color.getHexString()).toBe('b9c0c8');
				expect(standard.metalness).toBeCloseTo(0.1, 5);
				expect(standard.roughness).toBeCloseTo(0.65, 5);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// AC-57-9〜10 — 縮退(契約⑤)
// ---------------------------------------------------------------------------

describe('AC-57-9 parseModel — 幾何の無い OBJ は既存の失敗経路で reject(要件#57 ⑤)', () => {
	const NO_GEOMETRY = [
		['空ファイル', ''],
		['コメントだけ', '# nothing here\n# still nothing\n'],
		['v 行だけ(面なし)', CUBE_VERTICES],
	] as const;

	for (const [label, source] of NO_GEOMETRY) {
		test(`${label}は reject し、文言は既存の「The model has no drawable geometry」のまま`, async () => {
			vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			await expect(parseModel(OBJ, toBuffer(source))).rejects.toThrow(
				'The model has no drawable geometry',
			);
		});
	}
});

describe('AC-57-10 parseModel — 非 UTF-8 バイト(要件#57 ⑤)', () => {
	test('不正なバイト列を混ぜても例外にならず、面が読める範囲は読める', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		// 有効な立方体の途中に、単独行の不正 UTF-8 バイト(0xFF 0xFE 0x80)を挟む。
		// TextDecoder(fatal: false)は置換文字にして読み進み、その行は
		// 未知の行として読み飛ばされる — 残りの 12 面はそのまま読める。
		const head = new TextEncoder().encode(CUBE_VERTICES);
		const garbage = new Uint8Array([0xff, 0xfe, 0x80, 0x0a]);
		const tail = new TextEncoder().encode(CUBE_TRI.slice(CUBE_VERTICES.length));
		const bytes = new Uint8Array(head.length + garbage.length + tail.length);
		bytes.set(head, 0);
		bytes.set(garbage, head.length);
		bytes.set(tail, head.length + garbage.length);

		const model = await parseModel(OBJ, bytes.buffer as ArrayBuffer);
		expect(model.triangleCount).toBe(12);
		expectBounds(model.bounds, [0, 0, 0], [5, 5, 5]);
	});

	test('バイナリを .obj と名付けたファイルは幾何ゼロとして既存の reject 経路へ落ちる', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		// 非 ASCII(0x80 以上)だけの無意味なバイト列 — 偶然 `f 1 2 3` のような
		// 有効行が生まれないことを保証しつつ、OBJ の面が 1 つも無い入力を作る。
		const junk = new Uint8Array(256);
		for (let i = 0; i < junk.length; i++) junk[i] = 0x80 + ((i * 37) % 128);
		await expect(parseModel(OBJ, junk.buffer as ArrayBuffer)).rejects.toThrow(
			'The model has no drawable geometry',
		);
	});
});

// ---------------------------------------------------------------------------
// AC-57-11〜12 — 決定性と拡張子の境界(契約②)
// ---------------------------------------------------------------------------

describe('AC-57-11〜12 parseModel — 決定性と拡張子の境界(要件#57 ②)', () => {
	test('AC-57-11: 同じバイト列は同じ triangleCount / bounds を返す', async () => {
		const a = await parseModel(OBJ, toBuffer(CUBE_TRI));
		const b = await parseModel(OBJ, toBuffer(CUBE_TRI));
		expect(a.triangleCount).toBe(b.triangleCount);
		expect(a.bounds).toEqual(b.bounds);
	});

	test('AC-57-12: CUBE.OBJ でも読む(大文字小文字を問わない)', async () => {
		const model = await parseModel('file:///m/CUBE.OBJ', toBuffer(CUBE_TRI));
		expect(model.triangleCount).toBe(12);
	});

	test('AC-57-12: 対象外の拡張子(step 等)は従来どおり reject する', async () => {
		await expect(parseModel('file:///m/part.step', toBuffer(CUBE_TRI))).rejects.toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// AC-57-15 — 不変と依存(契約⑥)
// ---------------------------------------------------------------------------

/**
 * 依存追加ゼロの固定(git diff に依存しない形): dependencies の名前一覧そのものを
 * 要件#57 周回開始時点(2026-09-21)の実測値に固定する。実装が依存を足せば
 * この一覧が変わって赤くなる。devDependencies は対象外(契約⑤の @types/three 前例)。
 * 「src-tauri/** 無改変」「既存 STL / 3MF acceptance の無改変緑」は test-runner の
 * フルスイート実行と reviewer 照合が判定する(ここでは判定しない)。
 */
describe('AC-57-15 不変 — 依存追加ゼロ(要件#57 ⑥)', () => {
	test('package.json の dependencies に追加が無い(OBJLoader は three 同梱)', () => {
		const pkg = JSON.parse(
			readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'),
		) as { dependencies: Record<string, string> };
		expect(Object.keys(pkg.dependencies).sort()).toEqual(
			[
				'@shikijs/rehype',
				'@tauri-apps/api',
				'@tauri-apps/plugin-dialog',
				'@tauri-apps/plugin-opener',
				'hast-util-to-mdast',
				'mdast-util-to-markdown',
				'mdast-util-to-string',
				'mermaid',
				'rehype-parse',
				'rehype-raw',
				'rehype-sanitize',
				'rehype-stringify',
				'remark-gfm',
				'remark-parse',
				'remark-rehype',
				'three',
				'unified',
				'unist-util-visit',
			].sort(),
		);
	});

	test('src-tauri/Cargo.toml の [dependencies] に追加が無い(Rust 側は一切触らない)', () => {
		const toml = readFileSync(
			fileURLToPath(new URL('../../src-tauri/Cargo.toml', import.meta.url)),
			'utf-8',
		);
		// [dependencies] セクションだけを切り出し、キー名を集める。
		const section = toml.split(/^\[dependencies\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
		const names = [...section.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]).sort();
		expect(names).toEqual(
			[
				'tauri',
				'tauri-plugin-opener',
				'serde',
				'serde_json',
				'clap',
				'thiserror',
				'tokio',
				'async-trait',
				'notify',
				'libc',
				'tracing',
				'tracing-subscriber',
				'mime_guess',
				'http',
				'percent-encoding',
				'tauri-plugin-dialog',
				'reqwest',
				'russh',
				'russh-sftp',
				'bytes',
				'dirs',
				'ulid',
				'chrono',
				'strsim',
				'sha2',
				'similar',
				'hidapi',
				'toml',
				'tauri-plugin-webdriver',
				'tauri-plugin-window-state',
			].sort(),
		);
	});
});
