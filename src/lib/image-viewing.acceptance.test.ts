/**
 * 要件#16 の受け入れテスト(requirements.md #16)
 * 「画像ファイル(png/jpg/jpeg/gif/webp/avif/bmp/ico)と SVG ファイルを開いたとき、
 *  レンダリング結果(画像)を表示する」
 *
 * 決定の記録: docs/image-viewing.md(2026-08-12 由谷決定=Q1 案 a′「SVG は <img> 既定+
 * ソース切替トグル」・Q2〜Q7 推奨どおり=対象9種・フィット既定+実寸トグル・フロント完結・
 * ssh リモート含む・要件#2 acceptance の要件側更新承認(Q6)・透過背景はテーマ単色)
 *
 * 契約(このテストが実装に要求するもの。丸数字は requirements.md #16 の契約番号):
 *
 * 1. `detectFileType`(src/lib/file-type.ts): 分類 'image' を新設し FileType へ追加(①)
 *    - png / jpg / jpeg / gif / webp / avif / bmp / ico / svg の9種 → 'image'
 *      (大文字小文字不問・最終 `/` セグメントの最後の拡張子。ベース名 / パス / URI で同じ)
 *    - 要件#2 の binary から8種・text から svg を移す契約変更(2026-08-12 要件側判断)。
 *      tiff / tif / heic はプラットフォーム依存(WKWebView 以外で描けない)を分類表に
 *      持ち込まないため移さない=binary のまま
 *    - 他の分類は不変: md 系=markdown・html/htm=html(要件#8)・pdf zip 等=binary・
 *      それ以外=text。xml は text のまま(XML のうち svg だけを移す)
 *
 * 2. `src/lib/image-viewing.ts`(新規): ImageViewer が使う純 TS 表面(②③④⑥⑦)
 *    - `toImageSrc(absoluteUri: string): string` — `<img src>` に載せる vellis-asset: URI の
 *      構築(②)。既存 toAssetUri(src/lib/uri.ts)と同値:
 *      file:///a/b.png → vellis-asset://local/a/b.png・
 *      ssh://alice@h:22/p.png → vellis-asset://ssh/alice@h:22/p.png(ssh リモートも対象=⑥)
 *    - `readsAsText(nameOrUri: string): boolean` — open_document(テキスト読込)を通すかの
 *      述語(⑦=フロント完結の割り切り)。svg=true(UTF-8 XML なので従来経路のまま=
 *      ソース切替の素材も監視も従来どおり効く)・ラスタ8種=false(InvalidUtf8 で失敗する
 *      ため通さない)・md / html / txt=true(既存経路の不変)
 *    - `canToggleSource(nameOrUri: string): boolean` — ソース表示へ切り替えられるか(③)。
 *      svg のみ true。ラスタ8種はトグルなし=false・画像以外も false(トグルは画像
 *      ビューアの概念)
 *    - サイズモード(④): `DEFAULT_SIZE_MODE` は 'fit'(フィット既定)・
 *      `toggleSizeMode(mode)` が 'fit' ⇄ 'actual' を往復する(実寸トグル1個。
 *      ズーム / パンは契約外=状態は2値)
 *    - SVG 表示モード(③): `DEFAULT_SVG_VIEW_MODE` は 'image'(既定=画像表示)・
 *      `toggleSvgViewMode(mode)` が 'image' ⇄ 'source' を往復する
 *
 * 3. `renderForDisplay`(src/lib/file-type.ts): image の表示ディスパッチ(②⑦)
 *    - image: 本文(content)を html に載せない・index=null・srcdoc なし
 *      (「srcdoc の存在 ⇔ html ファイル」=要件#8 の契約を保つ)。
 *      画像 src の持たせ方(DisplayResult の新フィールドの形)は実装裁量
 *
 * スコープ外(このテストは扱わない):
 * - 実際の `<img>` 描画(PNG 透過・アニメ GIF・SVG の secure static mode=スクリプト
 *   不実行/外部参照なし)・フィット/実寸の見た目(原寸以上に拡大しない CSS)・
 *   透過背景のテーマ単色(⑤)・onerror プレースホルダ(⑧)・ssh 実機の表示
 *   =人間ゲート(acceptance/acceptance.md)
 * - Explorer のクリック分岐(image を握り潰さない)・+page.svelte の配線・
 *   ImageViewer.svelte の実体・トグル UI の置き場=reviewer 照合
 * - CSP / safe_mime / sanitize / Rust の無変更・依存追加なし(⑨)=差分ゼロは reviewer 照合
 */
import { describe, expect, test } from 'vitest';
import { detectFileType, renderForDisplay, type FileType } from './file-type';
import {
	DEFAULT_SIZE_MODE,
	DEFAULT_SVG_VIEW_MODE,
	canToggleSource,
	readsAsText,
	toImageSrc,
	toggleSizeMode,
	toggleSvgViewMode,
} from './image-viewing';
import { toAssetUri } from './uri';

/** 名前→判定結果のレコードにして、失敗時にどの名前が外れたか見えるようにする */
function classify(names: string[]): Record<string, string> {
	return Object.fromEntries(names.map((n) => [n, detectFileType(n)]));
}

function expectAll(names: string[], expected: FileType) {
	expect(classify(names)).toEqual(Object.fromEntries(names.map((n) => [n, expected])));
}

/** 対象9種のうちラスタ8種(svg を除く)のサンプル名 */
const RASTER_SAMPLES = [
	'photo.png',
	'photo.jpg',
	'photo.jpeg',
	'anim.gif',
	'pic.webp',
	'pic.avif',
	'shot.bmp',
	'favicon.ico',
];

describe('detectFileType — image 分類(要件#16 ①)', () => {
	test('対象9種(ラスタ8種+svg)を image と判定する', () => {
		expectAll([...RASTER_SAMPLES, 'icon.svg'], 'image');
	});

	test('拡張子の大文字小文字を問わない', () => {
		expectAll(['PHOTO.PNG', 'PIC.Jpeg', 'ICON.SVG', 'BANNER.WebP'], 'image');
	});

	test('パス・URI(file / ssh)を渡しても最終セグメントの拡張子で判定する', () => {
		expectAll(
			[
				'file:///pics/photo.png',
				'/tmp/screenshots/shot.jpeg',
				'ssh://alice@host:22/remote/diagram.svg',
			],
			'image',
		);
	});

	test('最後の拡張子だけで判定する(archive.png.gz=binary・notes.txt.png=image)', () => {
		expect(detectFileType('archive.png.gz')).toBe('binary');
		expect(detectFileType('notes.txt.png')).toBe('image');
	});

	test('tiff / tif / heic は image に含めない(プラットフォーム依存のため binary のまま)', () => {
		expectAll(['scan.tiff', 'scan.tif', 'iphone.heic'], 'binary');
	});
});

describe('detectFileType — 既存分類の不変ガード(image 分離後も要件#2 / #8 の契約が残る)', () => {
	test('markdown / html / text 系は従来どおり', () => {
		expectAll(['README.md', 'notes.markdown', 'page.mdx'], 'markdown');
		expectAll(['report.html', 'legacy.htm'], 'html');
		expectAll(['notes.txt', 'config.json', 'data.xml', 'Makefile', '.gitignore'], 'text');
	});

	test('画像以外の既知バイナリは binary のまま(pdf zip gz exe dll woff2 mp3 mp4)', () => {
		expectAll(
			['doc.pdf', 'a.zip', 'a.gz', 'a.exe', 'a.dll', 'font.woff2', 'a.mp3', 'a.mp4'],
			'binary',
		);
	});
});

describe('toImageSrc — <img src> 用の vellis-asset: URI 構築(要件#16 ②⑥)', () => {
	test('ローカル絶対 URI を vellis-asset://local/… へ変換する(toAssetUri と同値)', () => {
		const uri = 'file:///pics/photo.png';
		expect(toImageSrc(uri)).toBe('vellis-asset://local/pics/photo.png');
		expect(toImageSrc(uri)).toBe(toAssetUri(uri));
	});

	test('ssh リモート URI(user@host:port)も変換できる(toAssetUri と同値)', () => {
		const uri = 'ssh://alice@host:22/remote/photo.jpg';
		expect(toImageSrc(uri)).toBe('vellis-asset://ssh/alice@host:22/remote/photo.jpg');
		expect(toImageSrc(uri)).toBe(toAssetUri(uri));
	});

	test('user なしの ssh URI で余分な @ を出さない', () => {
		expect(toImageSrc('ssh://host/pics/diagram.svg')).toBe(
			'vellis-asset://ssh/host/pics/diagram.svg',
		);
	});
});

describe('readsAsText — open_document を通すかの述語(要件#16 ③⑦)', () => {
	test('svg は true(UTF-8 XML。ソース切替の素材を従来のテキスト経路で得る)', () => {
		expect(readsAsText('icon.svg')).toBe(true);
		expect(readsAsText('file:///pics/diagram.svg')).toBe(true);
	});

	test('ラスタ8種は false(テキスト読込を通さない=フロント完結の割り切り)', () => {
		for (const name of RASTER_SAMPLES) {
			expect(readsAsText(name), name).toBe(false);
		}
	});

	test('md / html / txt は true(既存経路の不変)', () => {
		expect(readsAsText('README.md')).toBe(true);
		expect(readsAsText('report.html')).toBe(true);
		expect(readsAsText('notes.txt')).toBe(true);
	});
});

describe('canToggleSource — ソース切替は SVG のみ(要件#16 ③)', () => {
	test('svg は true(大文字・パス / URI も同様)', () => {
		expect(canToggleSource('icon.svg')).toBe(true);
		expect(canToggleSource('ICON.SVG')).toBe(true);
		expect(canToggleSource('file:///pics/diagram.svg')).toBe(true);
	});

	test('ラスタ8種は false(トグルなし)', () => {
		for (const name of RASTER_SAMPLES) {
			expect(canToggleSource(name), name).toBe(false);
		}
	});

	test('画像以外も false(トグルは画像ビューアの概念)', () => {
		expect(canToggleSource('README.md')).toBe(false);
		expect(canToggleSource('notes.txt')).toBe(false);
	});
});

describe('表示モードの状態遷移(要件#16 ③④)', () => {
	test('サイズモードの既定はフィット(原寸以上に拡大しない側)', () => {
		expect(DEFAULT_SIZE_MODE).toBe('fit');
	});

	test('実寸トグル1個: fit ⇄ actual を往復する(第3の状態はない)', () => {
		expect(toggleSizeMode('fit')).toBe('actual');
		expect(toggleSizeMode('actual')).toBe('fit');
		expect(toggleSizeMode(toggleSizeMode('fit'))).toBe('fit');
	});

	test('SVG 表示モードの既定は画像表示', () => {
		expect(DEFAULT_SVG_VIEW_MODE).toBe('image');
	});

	test('ソース切替トグル: image ⇄ source を往復する', () => {
		expect(toggleSvgViewMode('image')).toBe('source');
		expect(toggleSvgViewMode('source')).toBe('image');
		expect(toggleSvgViewMode(toggleSvgViewMode('image'))).toBe('image');
	});
});

describe('renderForDisplay — image 経路(要件#16 ②⑦)', () => {
	test('image: 本文を html に載せず、index は null・srcdoc なし', async () => {
		// フロント完結の配線ではラスタ画像の content は空だが、届いても安全に落とす
		// (既存 binary 経路と同じ整理。テキスト経路=<pre> への転落を検知する)
		const result = await renderForDisplay('file:///pics/photo.png', 'RAWIMAGEBYTES');
		expect(result.html).not.toContain('RAWIMAGEBYTES');
		expect(result.index).toBeNull();
		// srcdoc の存在 ⇔ html ファイル(要件#8 の契約)を image でも保つ
		expect(result.srcdoc).toBeUndefined();
	});
});
