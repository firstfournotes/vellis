/**
 * 要件#29 の受け入れテスト(requirements.md #29)
 * 「PDF ファイルを開いたらアプリ内でインライン表示する(初版ローカル限定・ssh はプレースホルダ)」
 *
 * 実現方式は2段構えの検証ファースト(契約①=机上で採用も棄却もしない)を経て、
 * **案A=WKWebView ネイティブ・iframe 方式に確定**した(2026-08-26 由谷実機プローブ=
 * iframe・embed・object・直ロードの全方式で表示可。requirements.md #29 追記と
 * docs/pdf-viewing.md 参照。案B=PDF.js 同梱は不要になった)。本ファイルが固定するのは:
 * ①`pdf` 分類(binary からの移動)②表示形態の一点判定=純関数 VM(ローカル=インライン・
 * ssh=プレースホルダ=契約⑤)と「既定アプリで開く」計画(契約⑥のフォールバック導線)
 * ③テキスト読み経路への非流入 ④開く経路=要件#22 基盤の再利用(契約⑨)
 * ⑤`renderForDisplay` の表示ディスパッチ ⑥版数クエリによるキャッシュ破りの再利用(契約⑨)
 * ⑦CSP の frame-src 緩和と不変ガード(案A 確定分)。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * 1. `detectFileType`(src/lib/file-type.ts): `FileType` に `'pdf'` を追加し、拡張子 pdf
 *    (大文字小文字不問・最終 `/` セグメントの最後の拡張子)を `'pdf'` と判定する。
 *    `pdf` は BINARY_EXTENSIONS から移動する。他のバイナリ拡張子(zip/gz/exe/dll/woff2/
 *    mp3/tiff/heic/doc/docx/dmg 等)と既存分類(markdown/html/image/model3d/video/text)は
 *    不変。
 * 2. `src/lib/pdf-viewing.ts`(新規・純関数 VM。video-viewing.ts と同型=DOM なし・判定を
 *    一点集約):
 *    - `pdfViewMode(uri: string): PdfViewMode`
 *      `type PdfViewMode = 'inline' | 'remote'`
 *      ローカル(file スキーム)=`'inline'`(アプリ内インライン表示)・ssh リモート=
 *      `'remote'`(プレースホルダ+導線なし=契約⑤・初版ローカル限定。判別は URI スキーム
 *      のみで、パスの中身では分岐しない=要件#28 ⑥と同型・backlog #60 の O(n²) を
 *      顕在化させない)
 *    - `planOpenPdfExternally(uri: string): { command: 'open_path'; path: string } | null`
 *      開けない/壊れた/暗号化 PDF のプレースホルダが持つ「既定アプリで開く」実行計画
 *      (契約⑥=VideoViewer 同型・要件#19 の opener 再利用。path は context-menu.ts の
 *      pathForReveal と同じ URI→OS パス変換)。ssh は null=導線を出さない(契約⑤=
 *      要件#19 の disabled 前例踏襲)
 * 3. `readsAsText`(src/lib/image-viewing.ts): pdf は false — 現行ロジックは pdf(binary)で
 *    true を返し `open_document` のテキスト読み経路へ誤流入するため。
 * 4. `openCommandFor` / `openForDisplay`(src/lib/open-document.ts): pdf は
 *    `open_binary_document` を1回 invoke し解決値をそのまま返す(契約⑨=要件#22 の
 *    watch-only セッション。変更の自動反映・削除追従が付随)。
 * 5. `restoreSnapshot`(src/lib/reload-state.ts): docUri が pdf なら
 *    `set_root` → `open_binary_document`(`open_document` は呼ばない)。
 *    要件#10 の reload 復元に PDF も乗る(契約⑨付随)。
 * 6. `renderForDisplay`(src/lib/file-type.ts): pdf は本文を HTML に載せず、
 *    `DisplayResult.pdfSrc`(= `toAssetUri(uri)`)を返す(video の videoSrc が雛形)。
 *    ssh も pdf 分類なので pdfSrc 経路に乗り、プレースホルダの出し分けは VM
 *    (pdfViewMode)の持ち場。`pdfSrc` の存在が PDF ビューアを選ぶ合図(`srcdoc`→
 *    HtmlViewer・`imageSrc`→ImageViewer・`modelSrc`→ModelViewer・`videoSrc`→VideoViewer
 *    と同じ流儀)。
 * 7. 変更追従のキャッシュ破りは要件#22 の `imageSrcWithVersion`(src/lib/image-watch.ts)
 *    をそのまま PDF の src にも使う(binaryVersion の版数クエリ。別名は要らない)。
 * 8. CSP(src-tauri/tauri.conf.json): `frame-src` ディレクティブを新設し、少なくとも
 *    `'self'` と `vellis-asset:` を含む(iframe 方式の成立条件=要件#8 の「frame-src は
 *    追加しない」判断を一段広げる、承認済みの緩和。asset: http://asset.localhost 等を
 *    足すかは実装裁量なので固定しない)。緩和は frame-src に限定し、`object-src 'none'`
 *    (要件#8 以来の embed/object 封鎖)・`frame-ancestors 'none'`・`default-src`・
 *    `base-uri` は従来値のまま。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - PdfViewer 相当コンポーネントの `<iframe src="vellis-asset:…">` の実装形・
 *   プレースホルダ UI と「既定アプリで開く」ボタンの配線・+page.svelte の pdfSrc 分岐・
 *   binary_file_changed / file_removed の listen が PDF にも効くこと・版数リセット・
 *   PDF 内リンクの航行なし(契約④)
 *
 * ## 人間ゲート候補(機械判定不能 → acceptance/acceptance.md)
 * - 実表示(ページ送り・ズーム・テキスト選択=契約③。不可なら案B 再検討をファウンダーに
 *   諮る=requirements.md #29 追記)・開けない/壊れた/暗号化 PDF の実挙動(契約⑥)・
 *   大容量 PDF の体感(契約⑦)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import { pathForReveal } from './context-menu';
import { detectFileType, renderForDisplay } from './file-type';
import { imageSrcWithVersion } from './image-watch';
import { readsAsText } from './image-viewing';
import { openCommandFor, openForDisplay } from './open-document';
import { planOpenPdfExternally, pdfViewMode } from './pdf-viewing';
import { restoreSnapshot } from './reload-state';
import { toAssetUri } from './uri';

const invokeMock = vi.mocked(invoke);

const ROOT = 'file:///Users/a/work';
const PDF = `${ROOT}/docs/manual.pdf`;
const SSH_PDF = 'ssh://alice@host:22/remote/manual.pdf';

beforeEach(() => {
	invokeMock.mockReset();
});

/** 名前→判定結果のレコードにして、失敗時にどの名前が外れたか見えるようにする */
function classify(names: string[]): Record<string, string> {
	return Object.fromEntries(names.map((n) => [n, detectFileType(n)]));
}

function expectAll(
	names: string[],
	expected: 'markdown' | 'html' | 'text' | 'binary' | 'image' | 'model3d' | 'video' | 'pdf',
) {
	expect(classify(names)).toEqual(Object.fromEntries(names.map((n) => [n, expected])));
}

function invokedCommands(): string[] {
	return invokeMock.mock.calls.map((c) => c[0] as string);
}

// ---------------------------------------------------------------------------
// detectFileType — pdf 分類(要件#29 契約=binary からの移動)
// ---------------------------------------------------------------------------

describe('detectFileType — pdf を pdf と判定する(要件#29)', () => {
	test('ベース名の pdf は pdf(binary からの移動)', () => {
		expectAll(['manual.pdf'], 'pdf');
	});

	test('大文字小文字を問わない', () => {
		expectAll(['REPORT.PDF', 'Doc.Pdf'], 'pdf');
	});

	test('パス・file:// URI・ssh:// URI でも最終セグメントの拡張子で判定する(ssh も分類は pdf=プレースホルダ判定は VM の持ち場)', () => {
		expect(detectFileType('/tmp/spec.pdf')).toBe('pdf');
		expect(detectFileType(PDF)).toBe('pdf');
		expect(detectFileType(SSH_PDF)).toBe('pdf');
	});

	test('最後の拡張子だけで判定する(既存の境界規則の継承)', () => {
		expect(detectFileType('report.pdf.txt')).toBe('text');
		expect(detectFileType('notes.txt.pdf')).toBe('pdf');
		expect(detectFileType('backup.pdf.gz')).toBe('binary');
	});

	test('ディレクトリ名中の .pdf を拡張子と誤認しない', () => {
		expect(detectFileType('file:///home/user.pdf/Makefile')).toBe('text');
	});

	test('pdf 以外の既存 binary は不変(zip/gz/exe/dll/woff2=要件#2 の代表例)', () => {
		expectAll(['a.zip', 'a.gz', 'a.exe', 'a.dll', 'font.woff2'], 'binary');
	});

	test('pdf 以外の文書・プラットフォーム依存画像・ディスクイメージも binary のまま(doc/docx/xls/tiff/heic/dmg)', () => {
		expectAll(['a.doc', 'a.docx', 'a.xls', 'scan.tiff', 'iphone.heic', 'disk.dmg'], 'binary');
	});

	test('既存分類は不変(markdown / html / image / model3d / video / text)', () => {
		expect(detectFileType('README.md')).toBe('markdown');
		expect(detectFileType('page.html')).toBe('html');
		expect(detectFileType('icon.svg')).toBe('image');
		expect(detectFileType('photo.png')).toBe('image');
		expect(detectFileType('part.stl')).toBe('model3d');
		expect(detectFileType('clip.mp4')).toBe('video');
		expect(detectFileType('clip.mkv')).toBe('video');
		expect(detectFileType('notes.txt')).toBe('text');
		expect(detectFileType('data.xyz')).toBe('text'); // 未知拡張子のフォールバックも不変
		expect(detectFileType('Makefile')).toBe('text');
	});
});

// ---------------------------------------------------------------------------
// pdfViewMode — インライン可否の一点判定(要件#29 契約⑤=初版ローカル限定)
// ---------------------------------------------------------------------------

describe('pdfViewMode — ローカル=inline・ssh=remote(要件#29 契約⑤)', () => {
	test('ローカルの pdf はインライン表示(inline)', () => {
		expect(pdfViewMode(PDF)).toBe('inline');
		expect(pdfViewMode('file:///tmp/spec.pdf')).toBe('inline');
	});

	test('ssh リモートは remote(契約⑤=対象外・プレースホルダ+導線なし)', () => {
		expect(pdfViewMode(SSH_PDF)).toBe('remote');
		expect(pdfViewMode('ssh://host/remote/spec.pdf')).toBe('remote');
	});

	test('リモート判別は URI スキームのみ(パス中の "ssh" では分岐しない)', () => {
		expect(pdfViewMode(`${ROOT}/ssh/manual.pdf`)).toBe('inline');
	});
});

// ---------------------------------------------------------------------------
// planOpenPdfExternally — 「既定アプリで開く」計画(契約⑥=要件#19 再利用)
// ---------------------------------------------------------------------------

describe('planOpenPdfExternally — フォールバック導線の「既定アプリで開く」計画(要件#29 契約⑥)', () => {
	test('ローカルの pdf は open_path 計画(要件#19 の opener 再利用・OS パス変換は pathForReveal と同値)', () => {
		expect(planOpenPdfExternally(PDF)).toEqual({
			command: 'open_path',
			path: '/Users/a/work/docs/manual.pdf',
		});
		expect(planOpenPdfExternally(PDF)?.path).toBe(pathForReveal(PDF));
	});

	test('パーセントエンコードされたパスは復号した OS パスを渡す', () => {
		expect(planOpenPdfExternally('file:///docs/My%20Manual.pdf')).toEqual({
			command: 'open_path',
			path: '/docs/My Manual.pdf',
		});
	});

	test('ssh リモートは null=導線を出さない(契約⑤=要件#19 の disabled 前例踏襲)', () => {
		expect(planOpenPdfExternally(SSH_PDF)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// readsAsText — pdf はテキスト読込を通さない(要件#29=要件#22 基盤へ)
// ---------------------------------------------------------------------------

describe('readsAsText — pdf は open_document のテキスト読み経路へ流さない(要件#29)', () => {
	test('ベース名・file:// URI・ssh:// URI すべて false', () => {
		expect(readsAsText('manual.pdf')).toBe(false);
		expect(readsAsText(PDF)).toBe(false);
		expect(readsAsText(SSH_PDF)).toBe(false);
	});

	test('既存の判定は不変(md/html/txt/svg=true・ラスタ/model3d/video=false)', () => {
		expect(readsAsText('README.md')).toBe(true);
		expect(readsAsText('report.html')).toBe(true);
		expect(readsAsText('notes.txt')).toBe(true);
		expect(readsAsText('icon.svg')).toBe(true);
		expect(readsAsText('photo.png')).toBe(false);
		expect(readsAsText('part.stl')).toBe(false);
		expect(readsAsText('clip.mp4')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 経路選択 — pdf は open_binary_document(契約⑨=要件#22 基盤の再利用)
// ---------------------------------------------------------------------------

describe('経路選択 — pdf は watch-only セッションを張る(要件#29 契約⑨)', () => {
	test('openCommandFor: pdf は open_binary_document', () => {
		expect(openCommandFor(PDF)).toBe('open_binary_document');
		expect(openCommandFor(SSH_PDF)).toBe('open_binary_document');
	});

	test('openCommandFor: 既存の振り分けは不変', () => {
		expect(openCommandFor(`${ROOT}/notes/plan.md`)).toBe('open_document');
		expect(openCommandFor(`${ROOT}/pics/diagram.svg`)).toBe('open_document');
		expect(openCommandFor(`${ROOT}/pics/photo.png`)).toBe('open_binary_document');
		expect(openCommandFor(`${ROOT}/movies/clip.mp4`)).toBe('open_binary_document');
	});

	test('openForDisplay: pdf は open_binary_document を1回呼び、解決値をそのまま返す', async () => {
		const payload = { uri: PDF, content: '', modified: null };
		invokeMock.mockResolvedValue(payload);

		const res = await openForDisplay(PDF);

		expect(invokeMock.mock.calls).toEqual([['open_binary_document', { uri: PDF }]]);
		expect(res).toBe(payload);
	});

	test('openForDisplay: invoke 失敗(ファイル消滅等)は reject を伝播する', async () => {
		const err = 'watch failed: no such file';
		invokeMock.mockRejectedValue(err);

		await expect(openForDisplay(PDF)).rejects.toBe(err);
	});
});

// ---------------------------------------------------------------------------
// restoreSnapshot — pdf の docUri も reload 復元に乗る(契約⑨付随)
// ---------------------------------------------------------------------------

describe('restoreSnapshot — pdf docUri の reload 復元(要件#29 契約⑨)', () => {
	const rootPayload = { root_uri: ROOT, entries: [], document_retained: false };
	const pdfPayload = { uri: PDF, content: '', modified: null };
	const snapshot = { rootUri: ROOT, docUri: PDF, expandedDirs: [] };

	test('set_root → open_binary_document の順で呼び、document に解決値を返す', async () => {
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'set_root') return rootPayload;
			if (cmd === 'open_binary_document') return pdfPayload;
			throw new Error(`unexpected command: ${cmd}`);
		});

		const res = await restoreSnapshot(snapshot);

		expect(invokedCommands()).toEqual(['set_root', 'open_binary_document']);
		expect(invokeMock.mock.calls[1]?.[1]).toEqual({ uri: PDF });
		expect(res).toEqual({ ok: true, root: rootPayload, document: pdfPayload });
	});

	test('open_document は呼ばない(テキスト読みで必ず失敗する経路を通さない)', async () => {
		invokeMock.mockResolvedValue(rootPayload);

		await restoreSnapshot(snapshot);

		expect(invokedCommands()).not.toContain('open_document');
	});
});

// ---------------------------------------------------------------------------
// 版数クエリ — imageSrcWithVersion を PDF にもそのまま使う(要件#22 機構の再利用)
// ---------------------------------------------------------------------------

describe('版数クエリ — PDF の src にも要件#22 のキャッシュ破りがそのまま効く', () => {
	const SRC = 'vellis-asset://local/Users/a/work/docs/manual.pdf';

	test('版数0(初期表示)は素の URI のまま', () => {
		expect(imageSrcWithVersion(SRC, 0)).toBe(SRC);
	});

	test('版数1以上はクエリ(?)で別 URI・同じ版数は同じ src(決定的)', () => {
		const bumped = imageSrcWithVersion(SRC, 1);
		expect(bumped).not.toBe(SRC);
		expect(bumped.startsWith(`${SRC}?`)).toBe(true);
		expect(imageSrcWithVersion(SRC, 2)).not.toBe(bumped);
		expect(imageSrcWithVersion(SRC, 1)).toBe(bumped);
	});
});

// ---------------------------------------------------------------------------
// renderForDisplay — pdf は pdfSrc で PDF ビューアを選ぶ(要件#29)
// ---------------------------------------------------------------------------

describe('renderForDisplay — pdf の表示ディスパッチ(要件#29)', () => {
	test('ローカル pdf: pdfSrc = vellis-asset URI・html は空・index は null', async () => {
		const res = await renderForDisplay(PDF, '');
		expect(res.pdfSrc).toBe(toAssetUri(PDF));
		expect(res.html).toBe('');
		expect(res.index).toBeNull();
		// 他のビューアの合図と排他(pdfSrc の存在だけが PDF ビューアを選ぶ)
		expect(res.srcdoc).toBeUndefined();
		expect(res.imageSrc).toBeUndefined();
		expect(res.modelSrc).toBeUndefined();
		expect(res.videoSrc).toBeUndefined();
	});

	test('ssh pdf も pdfSrc 経路に乗る(プレースホルダの出し分けは pdfViewMode の持ち場)', async () => {
		const res = await renderForDisplay(SSH_PDF, '');
		expect(res.pdfSrc).toBe(toAssetUri(SSH_PDF));
		expect(res.html).toBe('');
		expect(res.index).toBeNull();
	});

	test('本文(content)を html に載せない(バイト列は vellis-asset 経由でしか渡らない)', async () => {
		const res = await renderForDisplay(PDF, 'PDFPAYLOAD\x00\x01');
		expect(res.html).not.toContain('PDFPAYLOAD');
	});

	test('pdf 以外に pdfSrc は付かない(既存経路の不変)', async () => {
		const image = await renderForDisplay(`${ROOT}/pics/photo.png`, '');
		expect(image.pdfSrc).toBeUndefined();
		expect(image.imageSrc).toBe(toAssetUri(`${ROOT}/pics/photo.png`));

		const video = await renderForDisplay(`${ROOT}/movies/clip.mp4`, '');
		expect(video.pdfSrc).toBeUndefined();
		expect(video.videoSrc).toBe(toAssetUri(`${ROOT}/movies/clip.mp4`));

		const text = await renderForDisplay(`${ROOT}/notes/memo.txt`, 'hello');
		expect(text.pdfSrc).toBeUndefined();
		expect(text.html).toContain('hello');

		const bin = await renderForDisplay(`${ROOT}/docs/archive.zip`, '');
		expect(bin.pdfSrc).toBeUndefined(); // zip は binary プレースホルダのまま(契約=代表例の固定継続)
	});
});

// ---------------------------------------------------------------------------
// CSP — frame-src の新設と不変ガード(要件#29 案A=iframe 方式の成立条件)
// ---------------------------------------------------------------------------

describe('CSP — frame-src の緩和と従来防御の維持(要件#29 案A 確定分)', () => {
	const confPath = resolve(__dirname, '../../src-tauri/tauri.conf.json');
	const conf = JSON.parse(readFileSync(confPath, 'utf-8')) as {
		app: { security: { csp: string } };
	};

	/** ディレクティブ名 → ソースリスト。無ければ null。 */
	function cspDirective(name: string): string[] | null {
		for (const part of conf.app.security.csp.split(';')) {
			const tokens = part.trim().split(/\s+/);
			if (tokens[0] === name) return tokens.slice(1);
		}
		return null;
	}

	test("frame-src ディレクティブが存在し 'self' と vellis-asset: を含む(<iframe src=\"vellis-asset:…\"> がブロックされない)", () => {
		const frameSrc = cspDirective('frame-src');
		expect(frameSrc, 'frame-src ディレクティブが新設されていること').not.toBeNull();
		expect(frameSrc).toContain("'self'");
		expect(frameSrc).toContain('vellis-asset:');
		// これ以外のソース(asset: http://asset.localhost 等)を足すかは実装裁量=固定しない
	});

	test("object-src は 'none' のまま(要件#8 以来の embed/object 封鎖を崩さない)", () => {
		expect(cspDirective('object-src')).toEqual(["'none'"]);
	});

	test('緩和は frame-src に限定(default-src / base-uri / frame-ancestors は従来値のまま)', () => {
		// default-src へ vellis-asset: を足す広い緩和で代用しない(iframe の許可は
		// frame-src で明示する=要件#8 の判断を「広げる範囲」を最小に保つ)
		expect(cspDirective('default-src')).toEqual(["'self'", 'tauri:', 'customprotocol:', 'asset:']);
		expect(cspDirective('base-uri')).toEqual(["'self'", 'vellis-asset:']);
		expect(cspDirective('frame-ancestors')).toEqual(["'none'"]);
	});
});
