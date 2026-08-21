/**
 * 要件#23 の受け入れテスト — 分類と経路選択(requirements.md #23)
 * 「3D モデルファイル(STL・3MF)を開いたら 3D 表示し、マウスで回転(左ドラッグ)・
 *  パン(右ドラッグ)・ズーム(ホイール)ができる」
 *
 * 本ファイルの判定範囲: ①`model3d` 分類 ②開く経路(要件#22 基盤の再利用)
 * ③`renderForDisplay` の表示ディスパッチ。パース結果は model-parse.acceptance.test.ts、
 * カメラ VM は model-camera.acceptance.test.ts が持つ。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * 1. `detectFileType`(src/lib/file-type.ts): `FileType` に `'model3d'` を追加し、
 *    拡張子 stl / 3mf(大文字小文字不問・最終セグメントの最後の拡張子)を
 *    `'model3d'` と判定する。既存分類(markdown/html/image/binary/text)は不変。
 * 2. `readsAsText`(src/lib/image-viewing.ts): model3d は false —
 *    STL はバイナリ形あり・3MF は ZIP なので UTF-8 テキスト読込を通せない。
 * 3. `openCommandFor` / `openForDisplay`(src/lib/open-document.ts): model3d は
 *    `open_binary_document` を1回 invoke し解決値をそのまま返す(要件#22 の
 *    watch-only セッション=変更反映・削除追従が付随)。既存の md/svg=
 *    `open_document`・ラスタ=`open_binary_document` は不変。
 * 4. `restoreSnapshot`(src/lib/reload-state.ts): docUri が model3d なら
 *    `set_root` → `open_binary_document`(`open_document` は呼ばない)。
 *    要件#10 の reload 復元に 3D モデルも乗る。
 * 5. `renderForDisplay`(src/lib/file-type.ts): model3d は本文を HTML に載せず、
 *    `DisplayResult.modelSrc`(= `toAssetUri(uri)`)を返す。`modelSrc` の存在が
 *    ModelViewer.svelte を選ぶ合図(`srcdoc` → HtmlViewer・`imageSrc` → ImageViewer
 *    と同じ流儀)。本体バイトは ModelViewer が fetch(vellis-asset) で取る。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - ModelViewer.svelte: modelSrc の fetch → parseModel → three.js シーン構築、
 *   マウス入力(左ドラッグ/右ドラッグ/ホイール)→ カメラ VM への配線
 * - binary_file_changed / file_removed の listen がモデルにも効くこと
 *
 * ## 人間ゲート候補(機械判定不能 → acceptance/acceptance.md)
 * - WebGL 描画の見た目(モデルが見える・ライティング・初期カメラの収まり)
 * - 操作感: 左ドラッグ回転・右ドラッグパン・ホイールズームの方向と感度
 * - 実機での変更反映・削除クローズ・reload 復元(STL/3MF ファイル)
 * - 巨大メッシュ(100MB 級 STL)のプログレス/上限の挙動
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import { detectFileType, renderForDisplay } from './file-type';
import { readsAsText } from './image-viewing';
import { openCommandFor, openForDisplay } from './open-document';
import { restoreSnapshot } from './reload-state';
import { toAssetUri } from './uri';

const invokeMock = vi.mocked(invoke);

const ROOT = 'file:///Users/a/work';
const STL = `${ROOT}/models/part.stl`;
const TMF = `${ROOT}/models/bracket.3mf`;

const MODEL_EXTENSIONS = ['stl', '3mf'] as const;

beforeEach(() => {
	invokeMock.mockReset();
});

function invokedCommands(): string[] {
	return invokeMock.mock.calls.map((c) => c[0] as string);
}

// ---------------------------------------------------------------------------
// detectFileType — model3d 分類(要件#23 ①)
// ---------------------------------------------------------------------------

describe('detectFileType — stl / 3mf を model3d と判定する(要件#23 ①)', () => {
	test('ベース名の stl / 3mf は model3d', () => {
		expect(detectFileType('part.stl')).toBe('model3d');
		expect(detectFileType('bracket.3mf')).toBe('model3d');
	});

	test('大文字小文字を問わない', () => {
		expect(detectFileType('PART.STL')).toBe('model3d');
		expect(detectFileType('Bracket.3MF')).toBe('model3d');
	});

	test('パス・file:// URI でも最終セグメントの拡張子で判定する', () => {
		expect(detectFileType('/tmp/scan.stl')).toBe('model3d');
		expect(detectFileType(STL)).toBe('model3d');
		expect(detectFileType(TMF)).toBe('model3d');
	});

	test('最後の拡張子だけで判定する(既存の境界規則の継承)', () => {
		expect(detectFileType('part.stl.txt')).toBe('text');
		expect(detectFileType('notes.txt.stl')).toBe('model3d');
	});

	test('ディレクトリ名中の .stl を拡張子と誤認しない', () => {
		expect(detectFileType('file:///home/user.stl/Makefile')).toBe('text');
	});

	test('既存分類は不変(markdown / html / image / binary / text)', () => {
		expect(detectFileType('README.md')).toBe('markdown');
		expect(detectFileType('page.html')).toBe('html');
		expect(detectFileType('icon.svg')).toBe('image');
		expect(detectFileType('photo.png')).toBe('image');
		expect(detectFileType('report.pdf')).toBe('binary');
		expect(detectFileType('notes.txt')).toBe('text');
		expect(detectFileType('data.xyz')).toBe('text'); // 未知拡張子のフォールバックも不変
		expect(detectFileType('Makefile')).toBe('text');
	});
});

// ---------------------------------------------------------------------------
// 経路選択 — model3d は open_binary_document(要件#23 ②=要件#22 基盤の再利用)
// ---------------------------------------------------------------------------

describe('経路選択 — model3d はテキスト読込を通さない(要件#23 ②)', () => {
	test('readsAsText: stl / 3mf は false(バイナリ形あり=UTF-8 読込不可)', () => {
		for (const ext of MODEL_EXTENSIONS) {
			expect(readsAsText(`model.${ext}`), `.${ext}`).toBe(false);
		}
	});

	test('readsAsText: 既存の判定は不変(md/html/txt/svg=true・ラスタ=false)', () => {
		expect(readsAsText('README.md')).toBe(true);
		expect(readsAsText('report.html')).toBe(true);
		expect(readsAsText('notes.txt')).toBe(true);
		expect(readsAsText('icon.svg')).toBe(true);
		expect(readsAsText('photo.png')).toBe(false);
	});

	test('openCommandFor: model3d は open_binary_document', () => {
		for (const ext of MODEL_EXTENSIONS) {
			expect(openCommandFor(`${ROOT}/m/sample.${ext}`), `.${ext}`).toBe('open_binary_document');
		}
	});

	test('openCommandFor: 既存の振り分けは不変', () => {
		expect(openCommandFor(`${ROOT}/notes/plan.md`)).toBe('open_document');
		expect(openCommandFor(`${ROOT}/pics/diagram.svg`)).toBe('open_document');
		expect(openCommandFor(`${ROOT}/pics/photo.png`)).toBe('open_binary_document');
	});

	test('openForDisplay: model3d は open_binary_document を1回呼び、解決値をそのまま返す', async () => {
		for (const uri of [STL, TMF]) {
			invokeMock.mockReset();
			const payload = { uri, content: '', modified: null };
			invokeMock.mockResolvedValue(payload);

			const res = await openForDisplay(uri);

			expect(invokeMock.mock.calls, uri).toEqual([['open_binary_document', { uri }]]);
			expect(res, uri).toBe(payload);
		}
	});

	test('openForDisplay: invoke 失敗(ファイル消滅等)は reject を伝播する', async () => {
		const err = 'watch failed: no such file';
		invokeMock.mockRejectedValue(err);

		await expect(openForDisplay(STL)).rejects.toBe(err);
	});
});

// ---------------------------------------------------------------------------
// restoreSnapshot — model3d の docUri も reload 復元に乗る(要件#23 ②付随)
// ---------------------------------------------------------------------------

describe('restoreSnapshot — model3d docUri の reload 復元', () => {
	const rootPayload = { root_uri: ROOT, entries: [], document_retained: false };
	const modelPayload = { uri: STL, content: '', modified: null };
	const snapshot = { rootUri: ROOT, docUri: STL, expandedDirs: [] };

	test('set_root → open_binary_document の順で呼び、document に解決値を返す', async () => {
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'set_root') return rootPayload;
			if (cmd === 'open_binary_document') return modelPayload;
			throw new Error(`unexpected command: ${cmd}`);
		});

		const res = await restoreSnapshot(snapshot);

		expect(invokedCommands()).toEqual(['set_root', 'open_binary_document']);
		expect(invokeMock.mock.calls[1]?.[1]).toEqual({ uri: STL });
		expect(res).toEqual({ ok: true, root: rootPayload, document: modelPayload });
	});

	test('open_document は呼ばない(UTF-8 読込で必ず失敗する経路を通さない)', async () => {
		invokeMock.mockResolvedValue(rootPayload);

		await restoreSnapshot(snapshot);

		expect(invokedCommands()).not.toContain('open_document');
	});
});

// ---------------------------------------------------------------------------
// renderForDisplay — model3d は modelSrc で ModelViewer を選ぶ(要件#23 ③)
// ---------------------------------------------------------------------------

describe('renderForDisplay — model3d の表示ディスパッチ(要件#23 ③)', () => {
	test('model3d: modelSrc = vellis-asset URI・html は空・index は null', async () => {
		for (const uri of [STL, TMF]) {
			const res = await renderForDisplay(uri, '');
			expect(res.modelSrc, uri).toBe(toAssetUri(uri));
			expect(res.html, uri).toBe('');
			expect(res.index, uri).toBeNull();
			// 他のビューアの合図と排他(modelSrc の存在だけが ModelViewer を選ぶ)
			expect(res.srcdoc, uri).toBeUndefined();
			expect(res.imageSrc, uri).toBeUndefined();
		}
	});

	test('model3d 以外に modelSrc は付かない(既存経路の不変)', async () => {
		const image = await renderForDisplay(`${ROOT}/pics/photo.png`, '');
		expect(image.modelSrc).toBeUndefined();
		expect(image.imageSrc).toBe(toAssetUri(`${ROOT}/pics/photo.png`));

		const text = await renderForDisplay(`${ROOT}/notes/memo.txt`, 'hello');
		expect(text.modelSrc).toBeUndefined();
		expect(text.html).toContain('hello');
	});
});
