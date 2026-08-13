/**
 * 要件#2 の受け入れテスト(requirements.md #2)
 * 「表示可能なテキストファイルはプレーンテキストとしてそのまま表示する」
 *
 * 契約(このテストが実装 `src/lib/file-type.ts` に要求するもの):
 *
 * 1. `detectFileType(nameOrUri: string): 'markdown' | 'text' | 'binary'`
 *    - 入力はベース名・パス・file:// URI のいずれでもよく、最終 `/` セグメントの
 *      「最後の拡張子」だけで判定する(ディレクトリ名中のドットは無視)
 *    - markdown: md / markdown / mdx(大文字小文字不問)
 *      根拠: 既存判定 looks_like_markdown(src-tauri/src/window/manager.rs:59)と
 *      Viewer.svelte:106 の /\.(md|markdown|mdx)$/i に一致させる
 *    - binary: 既知バイナリ拡張子のブロックリスト(大文字小文字不問)。
 *      本テストが固定する代表例: pdf zip gz exe dll woff2 mp3 mp4
 *      (png jpg jpeg gif webp bmp ico は要件#16 により image 分類へ分離)
 *    - text: 上記以外のすべて。既知テキスト拡張子(txt json log csv yaml yml
 *      toml xml ts js rs py sh)・拡張子なし(Makefile 等)・ドットファイル・
 *      未知拡張子を含む
 *      根拠: 読込層(open_document)が非 UTF-8 を FsError::InvalidUtf8、10MB 超を
 *      FileTooLarge で拒否する既存の安全網があるため、未知はテキスト側に倒すのが
 *      「表示可能なテキストはそのまま表示する」の趣旨に合う(最終判定は読込層)
 *    - svg と画像8種(png jpg jpeg gif webp avif bmp ico)は要件#16 により
 *      image 分類へ分離(2026-08-12 要件側判断・由谷承認=Q6)。分離後の契約は
 *      image-viewing.acceptance.test.ts が固定する
 *
 * 2. `renderForDisplay(uri: string, content: string): Promise<{ html: string; index: SourceIndex | null }>`
 *    表示経路の分岐(+page.svelte の $effect がこの関数を通す):
 *    - markdown: 既存 render()(src/markdown/renderer.ts)へ委譲。html は Markdown
 *      変換済み・index は非 null
 *    - text: Markdown 変換を通さず、content を HTML エスケープした 1 個の連続
 *      テキストとして html に載せる(textContent で原文が改行・タブ込みで逐語
 *      復元できる)。index は null
 *    - binary: 非表示対象。例外を投げず、content を html に含めない(具体 UI は
 *      問わない。空 html でもプレースホルダでもよい)。index は null
 */
import { describe, expect, test } from 'vitest';
import { detectFileType, renderForDisplay } from './file-type';

/** 名前→判定結果のレコードにして、失敗時にどの名前が外れたか見えるようにする */
function classify(names: string[]): Record<string, string> {
	return Object.fromEntries(names.map((n) => [n, detectFileType(n)]));
}

function expectAll(names: string[], expected: 'markdown' | 'text' | 'binary' | 'image') {
	expect(classify(names)).toEqual(Object.fromEntries(names.map((n) => [n, expected])));
}

/** html を jsdom に載せて表示テキスト(エンティティ復号済み)を取り出す */
function displayedText(html: string): string {
	const div = document.createElement('div');
	div.innerHTML = html;
	return div.textContent ?? '';
}

describe('detectFileType — markdown 系', () => {
	test('md / markdown / mdx を markdown と判定する', () => {
		expectAll(['README.md', 'notes.markdown', 'page.mdx'], 'markdown');
	});

	test('拡張子の大文字小文字を問わない', () => {
		expectAll(['README.MD', 'NOTES.Markdown', 'PAGE.MDX'], 'markdown');
	});
});

describe('detectFileType — テキスト系', () => {
	test('代表的テキスト拡張子を text と判定する', () => {
		const exts = [
			'txt',
			'json',
			'log',
			'csv',
			'yaml',
			'yml',
			'toml',
			'xml',
			'ts',
			'js',
			'rs',
			'py',
			'sh',
		];
		expectAll(
			exts.map((ext) => `sample.${ext}`),
			'text',
		);
	});

	test('大文字拡張子も text', () => {
		expectAll(['NOTES.TXT', 'DATA.JSON'], 'text');
	});

	test('拡張子なしのファイル名は text(Makefile / LICENSE / Dockerfile)', () => {
		expectAll(['Makefile', 'LICENSE', 'Dockerfile'], 'text');
	});

	test('ドットファイルは text(.gitignore)', () => {
		expectAll(['.gitignore'], 'text');
	});

	test('未知の拡張子は text にフォールバックする(表示可否の最終判定は読込層の UTF-8 検査)', () => {
		expectAll(['data.xyz'], 'text');
	});

	test('svg は text ではなく image(要件#16 により分離。XML 一般は従来どおり text)', () => {
		expectAll(['icon.svg'], 'image');
		expectAll(['data.xml'], 'text');
	});
});

describe('detectFileType — バイナリ系', () => {
	test('代表的バイナリ拡張子を binary と判定する(画像8種は要件#16 で image へ分離済み)', () => {
		const exts = ['pdf', 'zip', 'gz', 'exe', 'dll', 'woff2', 'mp3', 'mp4'];
		expectAll(
			exts.map((ext) => `blob.${ext}`),
			'binary',
		);
	});

	test('大文字拡張子も binary', () => {
		expectAll(['ARCHIVE.ZIP', 'DOC.PDF'], 'binary');
	});
});

describe('detectFileType — 境界', () => {
	test('最後の拡張子だけで判定する', () => {
		expect(detectFileType('notes.md.txt')).toBe('text');
		expect(detectFileType('archive.tar.gz')).toBe('binary');
		expect(detectFileType('list.txt.md')).toBe('markdown');
	});

	test('パス・URI を渡しても最終セグメントの拡張子で判定する', () => {
		expect(detectFileType('file:///home/user/notes/readme.md')).toBe('markdown');
		expect(detectFileType('/tmp/archive.zip')).toBe('binary');
		expect(detectFileType('file:///data/config.json')).toBe('text');
	});

	test('ディレクトリ名中のドットを拡張子と誤認しない', () => {
		// user.name ディレクトリ直下の拡張子なしファイルは text
		expect(detectFileType('file:///home/user.name/Makefile')).toBe('text');
	});
});

describe('renderForDisplay — 表示経路の分岐', () => {
	test('markdown: 既存レンダラを通す(# が h1 になり index が付く)', async () => {
		const result = await renderForDisplay('file:///notes/doc.md', '# title\n\npara\n');
		expect(result.html).toContain('<h1');
		expect(result.html).toContain('title');
		expect(result.index).not.toBeNull();
	});

	test('text: Markdown 変換を通さず、エスケープ済みプレーンテキストとしてそのまま出す', async () => {
		const content = '# not-a-heading\n<script>alert(1)</script>\n*not-em*\n\tindented\n';
		const result = await renderForDisplay('file:///notes/memo.txt', content);
		// Markdown 変換されていない
		expect(result.html).not.toContain('<h1');
		expect(result.html).not.toContain('<em');
		// 生の <script> が html に混入しない(エスケープされている)
		expect(result.html).not.toContain('<script');
		expect(result.html).toContain('&lt;script&gt;');
		// 「そのまま表示」: 表示テキストから原文が改行・タブ込みで逐語復元できる
		expect(displayedText(result.html)).toContain(content);
		// プレーンテキストに SourceIndex は付かない
		expect(result.index).toBeNull();
	});

	test('text: JSON も逐語的にプレーン表示される', async () => {
		const content = '{"a": 1, "list": [true, null], "s": "<tag>"}\n';
		const result = await renderForDisplay('file:///data/config.json', content);
		expect(result.html).not.toContain('<tag>');
		expect(displayedText(result.html)).toContain(content);
		expect(result.index).toBeNull();
	});

	test('binary: 非表示対象(例外を投げず、本文を html に含めない)', async () => {
		// 実際の経路では binary は open されない想定だが、届いても安全に落とす
		const result = await renderForDisplay('file:///docs/report.pdf', 'BINARYPAYLOAD\x00\x01');
		expect(result.html).not.toContain('BINARYPAYLOAD');
		expect(result.index).toBeNull();
	});
});
