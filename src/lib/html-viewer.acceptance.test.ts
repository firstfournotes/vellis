/**
 * 要件#8 の受け入れテスト(requirements.md #8)
 * 「HTML ファイル(html/htm)はソースではなくレンダリング結果を表示する(スクリプトは実行しない)」
 *
 * 決定の記録: docs/html-viewing.md(2026-08-08 由谷決定=案B: sandbox iframe + srcdoc)
 * 追補(2026-08-10 由谷決定=案A・目視ゲートNG対応): sandbox は自フレーム航行を止めない
 * (外部リンクの実航行を目視確認。base 注入により相対・アンカーも vellis-asset: へ
 * 航行し得る)ため、buildSrcdoc の前処理でリンク航行を無効化する。
 * 同日追補(xlink): SVG リンク(<a xlink:href>)も専用退避名で無効化の対象とする。
 *
 * 契約(このテストが実装に要求するもの):
 *
 * 1. `detectFileType`(src/lib/file-type.ts): 分類 'html' を新設し FileType へ追加
 *    - html / htm(大文字小文字不問・最終 `/` セグメントの最後の拡張子)→ 'html'
 *    - 要件#2 の text 契約からの分離であり、他の分類は不変
 *      (md/markdown/mdx=markdown・既知ブロックリスト=binary・それ以外=text)。
 *      契約は html/htm のみなので xhtml は text のまま
 *
 * 2. `src/lib/html-viewer.ts`(新規): HtmlViewer.svelte が使う純 TS 表面
 *    - `SANDBOX_ATTRIBUTE: string` — iframe の sandbox 属性値。トークンとして
 *      allow-scripts / allow-same-origin を含まない(他トークンは実装裁量。
 *      空文字=全制限も可)
 *    - `buildSrcdoc(content: string, docUri: string): string` — iframe の srcdoc を構築
 *      - `<base href="…">` を1個だけ注入する。href は toAssetUri(docUri) と同形
 *        (file:///a/b/doc.html → vellis-asset://local/a/b/doc.html)。相対画像は
 *        この base により Markdown 画像と同経路(resolveRelative → toAssetUri と
 *        同値)へ解決される
 *      - 注入位置は head 相当(doctype より後・本文より前)。content 内に既存の
 *        <base> があってもそれより前に来る(HTML の base は先勝ち)
 *      - リンク航行の無効化(2026-08-10 追補): <a>/<area> の href 属性(大文字
 *        HREF・シングルクォート/クォートなしを含む)を data-vellis-href へ改名して
 *        退避する(外部・相対・アンカーすべて)。書き換えはタグ内の属性位置に
 *        限定し、エスケープ済みテキスト・地の文・属性値の中の href= 表記、
 *        a/area 以外の要素(base・link 等)の href は対象外。併せてリンクの
 *        見た目を維持する style([data-vellis-href] を対象に色・下線・カーソル)
 *        を注入する
 *      - SVG リンクの無効化(2026-08-10 追補・xlink): <a> の xlink:href は専用名
 *        data-vellis-xlink-href へ退避する(data-vellis-href へ合流させると逆変換の
 *        逐語復元性が壊れるため)。<image> 等リンク以外の xlink:href は対象外。
 *        style のセレクタは専用退避名([data-vellis-xlink-href])も覆う
 *      - 書き換えは「base 注入・style 注入・href/xlink:href 退避」のみ(注入物を
 *        除去し data-vellis-xlink-href / data-vellis-href をそれぞれ xlink:href /
 *        href へ戻すと原文が逐語復元できる)。<script> も剥がさない=忠実性。
 *        実行阻止は sandbox+CSP の責務
 *
 * 3. `renderForDisplay`(src/lib/file-type.ts): 'html' の表示ディスパッチ
 *    - DisplayResult に `srcdoc?: string` を追加(存在する ⇔ html ファイル。
 *      画面側はこれを分岐点に HtmlViewer へ渡す)
 *    - html: srcdoc=buildSrcdoc(content, uri)・html=''(生 content を DOM 直挿入
 *      経路に載せない)・index=null
 *    - markdown / text / binary: srcdoc なし(従来どおり)
 *
 * スコープ外(このテストは扱わない): HtmlViewer.svelte / +page.svelte の配線=
 * reviewer 照合・見た目忠実性(インライン SVG/CSS の描画)=人間ゲート
 * (acceptance/acceptance.md)・外部 .css / ssh リモートの相対リソース解決・
 * safe_mime の text/html 降格(不変)・CSP(変更するとしても frame-src 'self' 相当まで)
 */
import { describe, expect, test } from 'vitest';
import { detectFileType, renderForDisplay, type FileType } from './file-type';
import { SANDBOX_ATTRIBUTE, buildSrcdoc } from './html-viewer';
import { resolveRelative, toAssetUri } from './uri';

/** 名前→判定結果のレコードにして、失敗時にどの名前が外れたか見えるようにする */
function classify(names: string[]): Record<string, string> {
	return Object.fromEntries(names.map((n) => [n, detectFileType(n)]));
}

function expectAll(names: string[], expected: FileType) {
	expect(classify(names)).toEqual(Object.fromEntries(names.map((n) => [n, expected])));
}

/** sandbox 属性値をトークン列に分解する(HTML のトークンは ASCII 大文字小文字不問) */
function sandboxTokens(): string[] {
	return SANDBOX_ATTRIBUTE.toLowerCase()
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);
}

/** srcdoc 中の最初の <base …> タグ(文書順)を取り出す。無ければテスト失敗 */
function firstBaseTag(srcdoc: string): string {
	const m = srcdoc.match(/<base\b[^>]*>/i);
	if (m === null) {
		throw new Error(`<base> が srcdoc に注入されていない: ${srcdoc.slice(0, 120)}`);
	}
	return m[0];
}

/** 最初の <base> の href 値(引用符の種類は実装裁量なので寛容に読む) */
function firstBaseHref(srcdoc: string): string {
	const tag = firstBaseTag(srcdoc);
	const m = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
	const href = m?.[1] ?? m?.[2] ?? m?.[3];
	if (href === undefined) {
		throw new Error(`注入された <base> に href がない: ${tag}`);
	}
	return href;
}

function countBaseTags(srcdoc: string): number {
	return (srcdoc.match(/<base\b/gi) ?? []).length;
}

/* ---- 追補(2026-08-10)= リンク航行の無効化のヘルパ ---- */

/** srcdoc 中で re に最初に一致するタグ文字列。無ければテスト失敗 */
function findTag(srcdoc: string, re: RegExp): string {
	const m = srcdoc.match(re);
	if (m === null) {
		throw new Error(`タグが見つからない (${re}): ${srcdoc.slice(0, 120)}`);
	}
	return m[0];
}

/** タグ内の data-vellis-href の値(引用符の種類は実装裁量なので寛容に読む)。無ければテスト失敗 */
function vellisHref(tag: string): string {
	const m = tag.match(/\bdata-vellis-href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
	const href = m?.[1] ?? m?.[2] ?? m?.[3];
	if (href === undefined) {
		throw new Error(`href が data-vellis-href へ退避されていない: ${tag}`);
	}
	return href;
}

/**
 * タグに有効な(退避されていない)href 属性が残っているか。
 * data-vellis-href は前の `-` を lookbehind で除外して数えない
 */
function hasActiveHref(tag: string): boolean {
	return /(?<![-\w])href\s*=/i.test(tag);
}

/** タグ内の data-vellis-xlink-href(SVG リンクの専用退避名)の値。無ければテスト失敗 */
function xlinkHref(tag: string): string {
	const m = tag.match(/\bdata-vellis-xlink-href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
	const href = m?.[1] ?? m?.[2] ?? m?.[3];
	if (href === undefined) {
		throw new Error(`xlink:href が data-vellis-xlink-href へ退避されていない: ${tag}`);
	}
	return href;
}

/** タグに有効な(退避されていない)xlink:href 属性が残っているか */
function hasActiveXlinkHref(tag: string): boolean {
	return /(?<![-\w])xlink:href\s*=/i.test(tag);
}

/**
 * 注入されたリンク style(data-vellis 退避名を参照する <style> ブロック)をすべて返す。
 * 1ブロックにまとめるか分けるかは実装裁量なので複数形で扱う
 */
function injectedStyleBlocks(srcdoc: string): string[] {
	return [...srcdoc.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)]
		.map((m) => m[0])
		.filter((s) => s.includes('data-vellis'));
}

/**
 * 注入物を除去する(文書順で最初の <base> 1個+リンク style)。逐語復元の検査用 —
 * 追補後の書き換えは「base 注入・style 注入・href/xlink:href 退避」のみで、
 * 退避は data-vellis-xlink-href → xlink:href・data-vellis-href → href の逆変換で戻る
 */
function stripInjections(srcdoc: string): string {
	let out = srcdoc.replace(firstBaseTag(srcdoc), '');
	for (const style of injectedStyleBlocks(out)) {
		out = out.replace(style, '');
	}
	return out;
}

describe('detectFileType — html 分類(要件#8)', () => {
	test('html / htm を html と判定する', () => {
		expectAll(['report.html', 'legacy.htm'], 'html');
	});

	test('拡張子の大文字小文字を問わない', () => {
		expectAll(['INDEX.HTML', 'Page.Htm', 'mixed.hTmL'], 'html');
	});

	test('パス・URI を渡しても最終セグメントの拡張子で判定する', () => {
		expectAll(['file:///reports/summary.html', '/srv/docs/page.htm'], 'html');
	});

	test('最後の拡張子だけで判定する', () => {
		expect(detectFileType('page.html.txt')).toBe('text');
		expect(detectFileType('archive.html.gz')).toBe('binary');
		expect(detectFileType('notes.txt.html')).toBe('html');
	});

	test('契約は html/htm のみ: xhtml は html 分類に含めない(text のまま)', () => {
		expectAll(['doc.xhtml'], 'text');
	});
});

describe('detectFileType — 要件#2 契約の不変ガード(html 分離後。画像系は要件#16 で image へ)', () => {
	test('md→markdown・text 系→text・既知バイナリ→binary・画像系→image(要件#16)', () => {
		expectAll(['README.md', 'notes.markdown', 'page.mdx'], 'markdown');
		expectAll(['notes.txt', 'data.xyz', 'Makefile'], 'text');
		expectAll(['doc.pdf'], 'binary');
		expectAll(['icon.svg', 'photo.png'], 'image');
	});
});

describe('SANDBOX_ATTRIBUTE — スクリプト不実行の sandbox 値(要件#8)', () => {
	test('文字列定数であり、allow-scripts トークンを含まない', () => {
		expect(typeof SANDBOX_ATTRIBUTE).toBe('string');
		expect(sandboxTokens()).not.toContain('allow-scripts');
	});

	test('allow-same-origin トークンを含まない(srcdoc を親オリジンから隔離する)', () => {
		expect(sandboxTokens()).not.toContain('allow-same-origin');
	});
});

describe('buildSrcdoc — <base> 注入(要件#8)', () => {
	const DOC_URI = 'file:///a/b/doc.html';
	const DOC_ASSET = 'vellis-asset://local/a/b/doc.html';

	const FULL_DOC = [
		'<!doctype html>',
		'<html>',
		'<head>',
		'<title>Quarterly Report</title>',
		'</head>',
		'<body>',
		'<h1 id="top">サマリー</h1>',
		'<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="gray" /></svg>',
		'<img src="images/chart.svg" alt="chart">',
		'<script>alert(1)</script>',
		'</body>',
		'</html>',
	].join('\n');

	const FRAG_URI = 'file:///notes/frag.html';
	const FRAG_DOC = '<p>概要</p>\n<img src="fig.png" alt="fig">\n';

	const OWN_BASE_URI = 'file:///site/page.htm';
	const OWN_BASE_DOC =
		'<html><head><base href="https://example.com/assets/"><title>t</title></head>' +
		'<body><img src="pic.png" alt=""></body></html>';

	test('base href は文書 URI の toAssetUri 形(file:///a/b/doc.html → vellis-asset://local/a/b/doc.html)', () => {
		const out = buildSrcdoc(FULL_DOC, DOC_URI);
		expect(firstBaseHref(out)).toBe(DOC_ASSET);
		expect(firstBaseHref(out)).toBe(toAssetUri(DOC_URI));
	});

	test('相対画像が base で Markdown 画像と同経路に解決される URI 形になっている', () => {
		const href = firstBaseHref(buildSrcdoc(FULL_DOC, DOC_URI));
		// 文書内の相対 src がブラウザの base 解決でどこへ向かうかを URL で再現し、
		// Markdown 画像経路(rewrite-uri: resolveRelative → toAssetUri)と同値であることを固定する
		expect(new URL('images/chart.svg', href).toString()).toBe(
			'vellis-asset://local/a/b/images/chart.svg',
		);
		for (const rel of ['images/chart.svg', './fig.png', '../shared/logo.png']) {
			expect(new URL(rel, href).toString()).toBe(toAssetUri(resolveRelative(DOC_URI, rel)));
		}
	});

	test('<head> のある文書: doctype より後・本文より前に1個だけ注入され、注入物を除去すると原文が逐語復元できる', () => {
		const out = buildSrcdoc(FULL_DOC, DOC_URI);
		const tag = firstBaseTag(out);
		const at = out.indexOf(tag);
		// doctype が先頭のまま(quirks モード落ちしない)・本文のどの要素よりも前
		expect(out.startsWith('<!doctype html>')).toBe(true);
		expect(at).toBeGreaterThan(out.indexOf('<!doctype html>'));
		expect(at).toBeLessThan(out.indexOf('<h1'));
		expect(at).toBeLessThan(out.indexOf('<img'));
		expect(at).toBeLessThan(out.indexOf('<script'));
		// base 注入は1個のみ。書き換えは注入物(base・リンク style)に限られ、除去で原文復元
		expect(countBaseTags(out)).toBe(1);
		expect(stripInjections(out)).toBe(FULL_DOC);
	});

	test('<head> のない素片 HTML: 本文より前に注入され、注入物を除去すると原文が逐語復元できる', () => {
		const out = buildSrcdoc(FRAG_DOC, FRAG_URI);
		const tag = firstBaseTag(out);
		expect(firstBaseHref(out)).toBe('vellis-asset://local/notes/frag.html');
		expect(out.indexOf(tag)).toBeLessThan(out.indexOf('<p>'));
		expect(out.indexOf(tag)).toBeLessThan(out.indexOf('<img'));
		expect(countBaseTags(out)).toBe(1);
		expect(stripInjections(out)).toBe(FRAG_DOC);
	});

	test('content に既存の <base> があっても注入 base が先に来る(HTML の base は先勝ち)', () => {
		const out = buildSrcdoc(OWN_BASE_DOC, OWN_BASE_URI);
		const tag = firstBaseTag(out);
		// 文書順で最初の base =注入されたもの(こちらが有効になる)
		expect(tag).toContain('vellis-asset://local/site/page.htm');
		expect(out.indexOf(tag)).toBeLessThan(out.indexOf('https://example.com/assets/'));
		// 既存 base は剥がさず残す(注入物を除去すると原文復元)
		expect(countBaseTags(out)).toBe(2);
		expect(stripInjections(out)).toBe(OWN_BASE_DOC);
	});

	test('<script> を含む content も逐語で保持される(実行阻止は sandbox+CSP の責務であり、剥がして達成しない)', () => {
		const out = buildSrcdoc(FULL_DOC, DOC_URI);
		expect(out).toContain('<script>alert(1)</script>');
		// インライン SVG(主用途: AI 生成レポートの図)もサニタイズされない
		expect(out).toContain('<svg viewBox="0 0 10 10">');
	});
});

describe('buildSrcdoc — リンク航行の無効化(要件#8 追補 2026-08-10)', () => {
	const LINKS_URI = 'file:///a/b/doc.html';

	/** 外部・相対・アンカー+引用符の各種形(すべて退避対象)+ area */
	const LINKS_DOC = [
		'<p><a href="https://external.example/page">外部</a></p>',
		'<p><a href="other/page2.html">相対</a></p>',
		'<p><a href="#top">アンカー</a></p>',
		"<p><a href='single.html'>単引用</a></p>",
		'<p><a href=bare.html>クォートなし</a></p>',
		'<map name="m"><area shape="rect" coords="0,0,10,10" href="https://external.example/area" alt="a"></map>',
	].join('\n');

	test('外部・相対・アンカー・引用符差の <a href> がすべて data-vellis-href へ退避される', () => {
		const out = buildSrcdoc(LINKS_DOC, LINKS_URI);
		const anchors = [...out.matchAll(/<a\b[^>]*>/gi)].map((m) => m[0]);
		expect(anchors).toHaveLength(5);
		expect(anchors.map(vellisHref)).toEqual([
			'https://external.example/page',
			'other/page2.html',
			'#top',
			'single.html',
			'bare.html',
		]);
		for (const tag of anchors) {
			expect(hasActiveHref(tag), `href が退避されず残っている: ${tag}`).toBe(false);
		}
	});

	test('<area href> も退避される(shape / coords / alt は不変)', () => {
		const out = buildSrcdoc(LINKS_DOC, LINKS_URI);
		const area = findTag(out, /<area\b[^>]*>/i);
		expect(vellisHref(area)).toBe('https://external.example/area');
		expect(hasActiveHref(area)).toBe(false);
		expect(area).toContain('shape="rect"');
		expect(area).toContain('coords="0,0,10,10"');
		expect(area).toContain('alt="a"');
	});

	test('大文字 HREF も退避される(HTML の属性名は大文字小文字不問)', () => {
		const out = buildSrcdoc('<p><A HREF="https://external.example/big">B</A></p>', LINKS_URI);
		const tag = findTag(out, /<a\b[^>]*>/i);
		expect(hasActiveHref(tag)).toBe(false);
		expect(vellisHref(tag)).toBe('https://external.example/big');
	});

	test('退避は href の属性名改名のみ: 注入物を除去し data-vellis-href を href へ戻すと原文が逐語復元できる', () => {
		const out = buildSrcdoc(LINKS_DOC, LINKS_URI);
		// 前提を注入 style 除去後に検査する(style 内の退避名参照で偽成立しないように)
		const stripped = stripInjections(out);
		expect(stripped).toContain('data-vellis-href');
		expect(stripped.replaceAll('data-vellis-href', 'href')).toBe(LINKS_DOC);
	});

	test('リンクの見た目を維持する style が注入される([data-vellis-href] を対象に色・下線・カーソル)', () => {
		const out = buildSrcdoc(LINKS_DOC, LINKS_URI);
		const style = injectedStyleBlocks(out).join('\n');
		if (style === '') {
			throw new Error('data-vellis 退避名を対象にした <style> が注入されていない');
		}
		expect(style).toMatch(/\[data-vellis-href\]/);
		expect(style).toMatch(/(?<![-\w])color\s*:/i);
		expect(style).toMatch(/text-decoration[\w-]*\s*:[^;}]*underline/i);
		expect(style).toMatch(/cursor\s*:/i);
	});

	test('base 注入と共存する(base 契約は不変・base の href は退避されない)', () => {
		const out = buildSrcdoc(LINKS_DOC, LINKS_URI);
		expect(stripInjections(out)).toContain('data-vellis-href'); // リンク退避と同時に
		expect(firstBaseHref(out)).toBe(toAssetUri(LINKS_URI));
		expect(countBaseTags(out)).toBe(1);
		expect(hasActiveHref(firstBaseTag(out))).toBe(true);
	});

	test('退避対象は a/area のみ: 既存 <base>・<link> の href は書き換えない', () => {
		const doc =
			'<html><head><base href="https://example.com/assets/">' +
			'<link rel="stylesheet" href="style.css"></head>' +
			'<body><a href="x.html">x</a></body></html>';
		const out = buildSrcdoc(doc, LINKS_URI);
		expect(out).toContain('<base href="https://example.com/assets/">');
		expect(out).toContain('<link rel="stylesheet" href="style.css">');
		const a = findTag(out, /<a\b[^>]*>/i);
		expect(hasActiveHref(a)).toBe(false);
		expect(vellisHref(a)).toBe('x.html');
	});

	test('href を持たない <a name>/<a id> は無害通過(退避も付加もされない)', () => {
		const doc = '<p><a name="top">アンカー先</a> と <a id="mark">目印</a></p>';
		const out = buildSrcdoc(doc, LINKS_URI);
		expect(out).toContain('<a name="top">');
		expect(out).toContain('<a id="mark">');
		expect(stripInjections(out)).toBe(doc);
	});

	test('タグ外のテキストは書き換えない(エスケープ済みコード例・地の文の href= 表記)', () => {
		const doc = [
			'<p>コード例: <code>&lt;a href="https://example.com/"&gt;link&lt;/a&gt;</code></p>',
			'<p>地の文にある href="value" という表記も対象外。</p>',
		].join('\n');
		const out = buildSrcdoc(doc, LINKS_URI);
		expect(out).toContain('&lt;a href="https://example.com/"&gt;');
		expect(out).toContain('href="value"');
		expect(stripInjections(out)).toBe(doc);
	});

	test('<pre> 内でも実タグは退避される(エスケープされていない実リンクは無効化=仕様)', () => {
		const out = buildSrcdoc('<pre><a href="./raw.html">pre 内の実リンク</a></pre>', LINKS_URI);
		const a = findTag(out, /<a\b[^>]*>/i);
		expect(hasActiveHref(a)).toBe(false);
		expect(vellisHref(a)).toBe('./raw.html');
	});

	test('属性値の中の href= 表記は書き換えず、実 href 属性だけを退避する', () => {
		const out = buildSrcdoc('<p><a title="see href=docs" href="./target.html">t</a></p>', LINKS_URI);
		const a = findTag(out, /<a\b[^>]*>/i);
		expect(a).toContain('title="see href=docs"'); // 属性値は逐語のまま
		expect(vellisHref(a)).toBe('./target.html'); // 実 href は退避される
		expect(a).not.toMatch(/(?<![-\w])href\s*=\s*"\.\/target\.html"/); // 実 href が属性として残っていない
	});
});

describe('buildSrcdoc — SVG リンクの無効化(要件#8 追補 2026-08-10・xlink)', () => {
	const SVG_URI = 'file:///a/b/doc.html';

	/** HTML リンクと SVG リンク(xlink / SVG2 素の href)の混在+リンク以外の xlink:href */
	const SVG_DOC = [
		'<p><a href="https://external.example/html">HTML リンク</a></p>',
		'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 20 20">',
		'<a xlink:href="https://external.example/svg"><text x="1" y="10">SVG リンク</text></a>',
		'<a href="#svg2-target"><circle cx="5" cy="5" r="2" /></a>',
		'<image xlink:href="images/photo.png" width="10" height="10" />',
		'</svg>',
	].join('\n');

	/** 文書順の <a> 開きタグ: [0]=HTML href・[1]=xlink:href・[2]=SVG2 素の href */
	function anchorTags(out: string): string[] {
		const tags = [...out.matchAll(/<a\b[^>]*>/gi)].map((m) => m[0]);
		expect(tags).toHaveLength(3);
		return tags;
	}

	test('<a xlink:href> は専用名 data-vellis-xlink-href へ退避される(xlink:href 残存なし)', () => {
		const out = buildSrcdoc(SVG_DOC, SVG_URI);
		const svgLink = anchorTags(out)[1];
		expect(xlinkHref(svgLink)).toBe('https://external.example/svg');
		expect(hasActiveXlinkHref(svgLink)).toBe(false);
		expect(hasActiveHref(svgLink)).toBe(false); // data-vellis-href への合流もしていない
	});

	test('href と xlink:href の混在: それぞれの退避名に退避され、逆変換で原文が逐語復元できる', () => {
		const out = buildSrcdoc(SVG_DOC, SVG_URI);
		// 前提を注入 style 除去後に検査する(style 内の退避名参照で偽成立しないように)
		const stripped = stripInjections(out);
		expect(stripped).toContain('data-vellis-xlink-href');
		expect(stripped).toContain('data-vellis-href'); // xlink 退避名の部分文字列ではない
		expect(
			stripped
				.replaceAll('data-vellis-xlink-href', 'xlink:href')
				.replaceAll('data-vellis-href', 'href'),
		).toBe(SVG_DOC);
	});

	test('SVG 内 <a> の素の href(SVG2)も data-vellis-href 退避でカバーされる', () => {
		const out = buildSrcdoc(SVG_DOC, SVG_URI);
		const svg2Link = anchorTags(out)[2];
		expect(vellisHref(svg2Link)).toBe('#svg2-target');
		expect(hasActiveHref(svg2Link)).toBe(false);
	});

	test('リンク以外の xlink:href(<image>)は書き換えない(画像参照を壊さない)', () => {
		const out = buildSrcdoc(SVG_DOC, SVG_URI);
		expect(out).toContain('<image xlink:href="images/photo.png" width="10" height="10" />');
	});

	test('style 注入のセレクタが専用退避名([data-vellis-xlink-href])も覆う', () => {
		const out = buildSrcdoc(SVG_DOC, SVG_URI);
		const style = injectedStyleBlocks(out).join('\n');
		expect(style).toMatch(/\[data-vellis-xlink-href\]/);
	});
});

describe('renderForDisplay — html の表示ディスパッチ(要件#8)', () => {
	test('html: srcdoc に base 注入済み content を返し、html は空・index は null', async () => {
		const uri = 'file:///reports/summary.html';
		const content = '<h1>Report</h1>\n<script>alert(1)</script>\n<img src="images/p.png" alt="">\n';
		const result = await renderForDisplay(uri, content);
		// iframe へ渡す実体: buildSrcdoc と同一(base 注入済み・逐語)
		expect(result.srcdoc).toBe(buildSrcdoc(content, uri));
		expect(result.srcdoc).toContain('vellis-asset://local/reports/summary.html');
		expect(result.srcdoc).toContain('<script>alert(1)</script>');
		// 生 content を DOM 直挿入経路({@html} 側)に載せない
		expect(result.html).toBe('');
		expect(result.index).toBeNull();
	});

	test('html 以外(markdown / text / binary)は srcdoc を持たない', async () => {
		const md = await renderForDisplay('file:///notes/doc.md', '# title\n');
		const txt = await renderForDisplay('file:///notes/memo.txt', 'plain\n');
		const bin = await renderForDisplay('file:///docs/report.pdf', 'PAYLOAD');
		expect(md.srcdoc).toBeUndefined();
		expect(txt.srcdoc).toBeUndefined();
		expect(bin.srcdoc).toBeUndefined();
	});
});
