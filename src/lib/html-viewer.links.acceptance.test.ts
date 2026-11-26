/**
 * 要件#88 の受け入れテスト(docs/requirements/req-88.md)— srcdoc の側(AC-88-1〜AC-88-4・`renderForDisplay`)
 * 「HTML の表示の中のリンクを使えるようにする(ローカルの別のファイルは Vellis で・外部の URL はブラウザで)」
 *
 * 作り(req-88.md「作り(決めたこと)」§1): `buildSrcdoc` に 4 つ目の引数 `links?: { token: string }` を足す。
 * `links` を渡したとき、`<a>` / `<area>` の開きタグの**名前のすぐ後ろ**に ` href="<行き先>" target="_self"` を差し込み、
 * 元の `href` / `xlink:href` / `target` / `download` は `data-vellis-*` に逐語で残す。行き先は、値(前後の空白を除く)が
 * `#` で始まるなら `about:srcdoc` + 値、それ以外は `vellis-asset://link/<token>?href=<encodeURIComponent(値)>`。
 * 値は原文の属性値の綴りのまま(文字参照は解かない=解くのは受け取った側 `decideHtmlLink`)。
 *
 * ## 確定契約(implementer はこれに従う=オーケストレーターが名前を決めた・2026-11-26)
 *
 * ```ts
 * // src/lib/html-viewer.ts
 * export function buildSrcdoc(content: string, docUri: string, zoom?: number, links?: { token: string }): string;
 * // src/lib/file-type.ts — HTML のとき links を buildSrcdoc に渡す
 * export async function renderForDisplay(uri, content, zoom?, codeTheme?, links?: { token: string }): Promise<DisplayResult>;
 * ```
 *
 * ## 判定するもの
 * - **AC-88-1** `links` なしの `buildSrcdoc` は変わらない: 要件#8 のテスト(html-viewer.acceptance.test.ts ほか)と印刷の
 *   テスト(print-html.acceptance.test.ts)が書き換えなしで通ること(それらのファイル自身が判定する)。本ファイルは
 *   「`links` を省くと専用の URL も `target="_self"` も入らない」の守りだけを足す
 * - **AC-88-2** リンクの差し込み: `<a>` / `<area>` / SVG の `<a>`(`xlink:href`・SVG2 の `href`)に差し込みが入り、元の属性は
 *   `data-vellis-*` に逐語で残る。ダブルクォート・シングルクォート・クォートなし・大文字の属性名のどれでも同じ。
 *   差し込みを除いて名前を戻すと原文に戻る。`href` と `xlink:href` が両方あれば `href`・同じ名前が複数なら最初のもの。
 *   文字参照(`&amp;`)は解かずに URL に入れる。前後に空白のある値は、往復して空白を除いた行き先になる
 * - **AC-88-3** ページ内のリンク(`#…` だけの `href`)は `about:srcdoc#…`(トークンは入らない・`"` は `&quot;`)
 * - **AC-88-4** 差し込まないもの: `href` の無い `<a>`・空(空白だけ)の `href`・`<base>` / `<link>` の `href`・`<image xlink:href>`・
 *   コメントや生テキスト(`<script>`・`<textarea>`・`<xmp>`)の中の `<a>`・エスケープ済みのテキスト・属性値の中の `href=`
 * - `renderForDisplay`: HTML のとき `links`(と zoom)を `buildSrcdoc` にそのまま渡す。HTML 以外は `links` を渡しても変わらない
 *
 * ## 判定しないもの
 * - Rust の判定(AC-88-5)= src-tauri/tests/acceptance_req88.rs・することを決める純関数(AC-88-6)= html-link.acceptance.test.ts・
 *   配線(AC-88-7)= html-link.page-wiring.acceptance.test.ts・実機(AC-88-8)
 *
 * ## 判断の記録(test-writer・2026-11-26)
 * - 空の `href`(`""`・空白だけ)の「変えない」は「差し込みをしない」と読んだ。`href` → `data-vellis-href` の付け替えは今の
 *   `buildSrcdoc` が空の値にもしているので、そのまま(付け替えの有無は固定せず、往復で原文に戻ることだけを見る)
 * - 大文字の属性名(`HREF`・`TARGET`)の付け替え先は小文字の `data-vellis-*`(今の `buildSrcdoc` と同じ)。往復の検査は
 *   小文字の原文だけで行う(要件#8 のテストと同じ)
 * - トークンに `[A-Za-z0-9_-]` 以外が入ったときの振る舞いは固定しない(作る側 `createLinkToken` の契約で守る)
 *
 * ## 実装前の見立て(赤の理由)
 * - `buildSrcdoc` が 4 つ目の引数を見ないので、差し込み(` href="vellis-asset://link/…" target="_self"`・`about:srcdoc#…`)と
 *   `target` / `download` の付け替えが無く、AC-88-2・AC-88-3・`renderForDisplay` の `links` の分が赤。AC-88-4 の「差し込まない」と
 *   AC-88-1 の守りは、今の作りでも差し込みが無いので最初から緑(守り)
 */
import { describe, expect, test } from 'vitest';
import { renderForDisplay } from './file-type';
import { buildSrcdoc } from './html-viewer';
import { DEFAULT_ZOOM } from './zoom';

const DOC_URI = 'file:///a/b/doc.html';
const TOKEN = 'tok_ABC-123_xyz';
const LINKS = { token: TOKEN };

/** 行き先の専用の URL(契約の形そのまま)。 */
function linkUrl(raw: string): string {
	return `vellis-asset://link/${TOKEN}?href=${encodeURIComponent(raw)}`;
}

/** タグの名前のすぐ後ろに差し込まれる文字列。 */
function injected(raw: string): string {
	return ` href="${linkUrl(raw)}" target="_self"`;
}

/** 文書順の開きタグ(`<a …>` など)。 */
function openTags(out: string, name: string): string[] {
	return [...out.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
}

function onlyTag(out: string, name: string): string {
	const tags = openTags(out, name);
	expect(tags, `<${name}> が 1 つあること`).toHaveLength(1);
	return tags[0];
}

/**
 * タグの中の属性 `name` の値(引用符の種類は寛容に読む)。`href` を探すとき `xlink:href` / `data-vellis-href` に
 * 当たらないように、前が `-` `:` 英数のときは数えない。無ければ undefined。
 */
function attr(tag: string, name: string): string | undefined {
	const re = new RegExp(`(?<![-\\w:])${name.replace(':', '\\:')}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
	const m = tag.match(re);
	if (m === null) return undefined;
	return m[1] ?? m[2] ?? m[3];
}

/** 有効な(付け替えられていない)属性 `name` が残っているか(値なしの属性も数える)。 */
function hasActive(tag: string, name: string): boolean {
	return new RegExp(`(?<![-\\w:])${name.replace(':', '\\:')}(?=[\\s/>=])`, 'i').test(tag.replace(/^<\w+/, '<x'));
}

/** 専用の URL の `href` パラメータを復号した値。 */
function hrefParam(url: string): string {
	const u = new URL(url);
	expect(u.protocol).toBe('vellis-asset:');
	expect(u.host).toBe('link');
	expect(u.pathname).toBe(`/${TOKEN}`);
	const href = u.searchParams.get('href');
	expect(href, `href パラメータがあること: ${url}`).not.toBeNull();
	return href as string;
}

/** 注入された <base>(最初の 1 個)とリンク style・差し込んだ ` href="…" target="_self"` を取り除く。 */
function stripInjections(srcdoc: string): string {
	const base = srcdoc.match(/<base\b[^>]*>/i);
	expect(base, '<base> が注入されていること').not.toBeNull();
	let out = srcdoc.replace((base as RegExpMatchArray)[0], '');
	for (const style of [...out.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0])) {
		if (style.includes('data-vellis')) out = out.replace(style, '');
	}
	return out.replace(/ href="(?:vellis-asset:\/\/link\/[^"]*|about:srcdoc[^"]*)" target="_self"/g, '');
}

/** `data-vellis-*` を元の名前に戻す(長い名前から順に)。 */
function restoreNames(s: string): string {
	return s
		.replaceAll('data-vellis-xlink-href', 'xlink:href')
		.replaceAll('data-vellis-download', 'download')
		.replaceAll('data-vellis-target', 'target')
		.replaceAll('data-vellis-href', 'href');
}

/** 差し込みを除いて名前を戻すと原文に逐語で戻る。 */
function expectRoundTrip(doc: string, out: string) {
	expect(restoreNames(stripInjections(out))).toBe(doc);
}

const LINKS_DOC = [
	'<p><a href="https://external.example/page">外部</a></p>',
	'<p><a href="other/page2.html">相対</a></p>',
	'<p><a href="#top">アンカー</a></p>',
	"<p><a href='single.html'>単引用</a></p>",
	'<p><a href=bare.html>クォートなし</a></p>',
	'<p><a href="x.html" target="_blank" download>新しい窓</a></p>',
	'<map name="m"><area shape="rect" coords="0,0,10,10" href="https://external.example/area" alt="a"></map>',
].join('\n');

const SVG_DOC = [
	'<p><a href="https://external.example/html">HTML リンク</a></p>',
	'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 20 20">',
	'<a xlink:href="https://external.example/svg"><text x="1" y="10">SVG リンク</text></a>',
	'<a href="#svg2-target"><circle cx="5" cy="5" r="2" /></a>',
	'<image xlink:href="images/photo.png" width="10" height="10" />',
	'</svg>',
].join('\n');

// ---------------------------------------------------------------------------
// AC-88-1 — links なしは変わらない(守り。本体は要件#8・要件#38 のテストが書き換えなしで通ること)
// ---------------------------------------------------------------------------

describe('AC-88-1 links なしの buildSrcdoc は変わらない(守り)', () => {
	test('links を省くと専用の URL も target="_self" も入らず、3 引数・4 引数(undefined)の呼び方でも同じ出力', () => {
		const two = buildSrcdoc(LINKS_DOC, DOC_URI);
		expect(two).not.toContain('vellis-asset://link/');
		expect(two).not.toContain('target="_self"');
		expect(two).not.toContain('about:srcdoc');
		expect(two).not.toContain('data-vellis-target');
		expect(two).not.toContain('data-vellis-download');
		expect(buildSrcdoc(LINKS_DOC, DOC_URI, DEFAULT_ZOOM)).toBe(two);
		expect(buildSrcdoc(LINKS_DOC, DOC_URI, DEFAULT_ZOOM, undefined)).toBe(two);
		expect(buildSrcdoc(LINKS_DOC, DOC_URI, undefined, undefined)).toBe(two);
	});
});

// ---------------------------------------------------------------------------
// AC-88-2 — リンクの差し込み
// ---------------------------------------------------------------------------

describe('AC-88-2 リンクの差し込み: <a> / <area> の名前のすぐ後ろに href="vellis-asset://link/<token>?href=…" target="_self"', () => {
	test('ダブルクォートの外部リンク: タグが契約の形そのまま(差し込み+元の href は data-vellis-href に逐語)', () => {
		const out = buildSrcdoc('<p><a href="https://external.example/page">外部</a></p>', DOC_URI, undefined, LINKS);
		expect(onlyTag(out, 'a')).toBe(
			`<a${injected('https://external.example/page')} data-vellis-href="https://external.example/page">`,
		);
	});

	test('相対パスのリンクも同じ形(URL の解決は srcdoc ではしない=原文の綴りを encodeURIComponent)', () => {
		const out = buildSrcdoc('<p><a href="other/page2.html">相対</a></p>', DOC_URI, undefined, LINKS);
		expect(onlyTag(out, 'a')).toBe(`<a${injected('other/page2.html')} data-vellis-href="other/page2.html">`);
		expect(linkUrl('other/page2.html')).toBe(`vellis-asset://link/${TOKEN}?href=other%2Fpage2.html`);
	});

	test('シングルクォートの href: 差し込みはダブルクォート・元の値は引用符ごと逐語', () => {
		const out = buildSrcdoc("<p><a href='single.html'>単引用</a></p>", DOC_URI, undefined, LINKS);
		expect(onlyTag(out, 'a')).toBe(`<a${injected('single.html')} data-vellis-href='single.html'>`);
	});

	test('クォートなしの href も同じ', () => {
		const out = buildSrcdoc('<p><a href=bare.html>クォートなし</a></p>', DOC_URI, undefined, LINKS);
		expect(onlyTag(out, 'a')).toBe(`<a${injected('bare.html')} data-vellis-href=bare.html>`);
	});

	test('大文字の属性名(HREF・TARGET・DOWNLOAD)も同じ(HTML の属性名は大文字小文字不問)。タグの名前の綴りは保つ', () => {
		const out = buildSrcdoc(
			'<p><A HREF="https://external.example/big" TARGET=\'_top\' DOWNLOAD="file.pdf">B</A></p>',
			DOC_URI,
			undefined,
			LINKS,
		);
		const tag = onlyTag(out, 'a');
		expect(tag.startsWith(`<A${injected('https://external.example/big')}`)).toBe(true);
		expect(attr(tag, 'href')).toBe(linkUrl('https://external.example/big'));
		expect(attr(tag, 'target')).toBe('_self');
		expect(attr(tag, 'data-vellis-href')).toBe('https://external.example/big');
		expect(attr(tag, 'data-vellis-target')).toBe('_top');
		expect(attr(tag, 'data-vellis-download')).toBe('file.pdf');
		expect(hasActive(tag, 'download')).toBe(false);
		expect(tag.match(/(?<![-\w:])target\s*=/gi), 'target= は差し込んだ 1 つだけ').toHaveLength(1);
	});

	test('<area href> も同じ形(shape / coords / alt はそのまま・差し込みは名前のすぐ後ろ)', () => {
		const out = buildSrcdoc(LINKS_DOC, DOC_URI, undefined, LINKS);
		expect(onlyTag(out, 'area')).toBe(
			`<area${injected('https://external.example/area')} shape="rect" coords="0,0,10,10" ` +
				'data-vellis-href="https://external.example/area" alt="a">',
		);
	});

	test('target="_blank" と値なしの download は data-vellis-target / data-vellis-download に付け替わり、差し込みの target="_self" だけが効く', () => {
		const out = buildSrcdoc('<p><a href="x.html" target="_blank" download>新しい窓</a></p>', DOC_URI, undefined, LINKS);
		const tag = onlyTag(out, 'a');
		expect(tag).toBe(`<a${injected('x.html')} data-vellis-href="x.html" data-vellis-target="_blank" data-vellis-download>`);
		expect(hasActive(tag, 'download')).toBe(false);
		expect(attr(tag, 'target')).toBe('_self');
	});

	test('SVG の <a xlink:href> にも差し込みが入り、xlink:href は data-vellis-xlink-href に逐語で残る', () => {
		const out = buildSrcdoc(SVG_DOC, DOC_URI, undefined, LINKS);
		const tags = openTags(out, 'a');
		expect(tags).toHaveLength(3);
		expect(tags[0]).toBe(`<a${injected('https://external.example/html')} data-vellis-href="https://external.example/html">`);
		expect(tags[1]).toBe(
			`<a${injected('https://external.example/svg')} data-vellis-xlink-href="https://external.example/svg">`,
		);
		expect(hasActive(tags[1], 'xlink:href')).toBe(false);
	});

	test('href と xlink:href が両方あれば href の値を使う(順序にかかわらず)。両方とも付け替える', () => {
		const out = buildSrcdoc(
			'<svg><a xlink:href="from-xlink.html" href="from-href.html"><text>t</text></a></svg>',
			DOC_URI,
			undefined,
			LINKS,
		);
		const tag = onlyTag(out, 'a');
		expect(tag).toBe(
			`<a${injected('from-href.html')} data-vellis-xlink-href="from-xlink.html" data-vellis-href="from-href.html">`,
		);
	});

	test('同じ名前の href が複数あれば最初の値を使う(2 つ目も付け替えて残す)', () => {
		const out = buildSrcdoc('<p><a href="first.html" href="second.html">t</a></p>', DOC_URI, undefined, LINKS);
		expect(onlyTag(out, 'a')).toBe(
			`<a${injected('first.html')} data-vellis-href="first.html" data-vellis-href="second.html">`,
		);
	});

	test('文字参照(&amp; / &quot; / &#47; / &#x2F;)は解かずに原文の綴りのまま URL に入れる(解くのは受け取った側)', () => {
		for (const raw of [
			'https://e.example/?a=1&amp;b=2',
			'other&#47;page.html',
			'other&#x2F;page.html',
			'q.html?t=&quot;x&quot;',
		]) {
			const out = buildSrcdoc(`<p><a href="${raw}">t</a></p>`, DOC_URI, undefined, LINKS);
			const tag = onlyTag(out, 'a');
			expect(attr(tag, 'data-vellis-href'), raw).toBe(raw);
			expect(hrefParam(attr(tag, 'href') as string), raw).toBe(raw);
			expect(attr(tag, 'href'), raw).toBe(linkUrl(raw));
		}
	});

	test('前後に空白のある値: data-vellis-href は逐語・URL の href を復号して空白を除くと元の行き先(往復で同じ行き先)', () => {
		const out = buildSrcdoc('<p><a href="  pad.html  ">t</a></p>', DOC_URI, undefined, LINKS);
		const tag = onlyTag(out, 'a');
		expect(attr(tag, 'data-vellis-href')).toBe('  pad.html  ');
		expect(attr(tag, 'target')).toBe('_self');
		expect(hrefParam(attr(tag, 'href') as string).trim()).toBe('pad.html');
	});

	test('トークンは URL のパスにそのまま置かれる(`_` と `-` を含む)', () => {
		const out = buildSrcdoc('<p><a href="x.html">t</a></p>', DOC_URI, undefined, { token: 'A-b_9' });
		expect(attr(onlyTag(out, 'a'), 'href')).toBe('vellis-asset://link/A-b_9?href=x.html');
	});

	test('差し込みを除いて data-vellis-* を元の名前に戻すと原文に逐語で戻る(HTML リンク・target・download・area)', () => {
		const out = buildSrcdoc(LINKS_DOC, DOC_URI, undefined, LINKS);
		const stripped = stripInjections(out);
		expect(stripped).toContain('data-vellis-href');
		expect(stripped).toContain('data-vellis-target');
		expect(stripped).toContain('data-vellis-download');
		expectRoundTrip(LINKS_DOC, out);
	});

	test('差し込みを除いて名前を戻すと原文に戻る(SVG の xlink:href と SVG2 の href の混在)', () => {
		const out = buildSrcdoc(SVG_DOC, DOC_URI, undefined, LINKS);
		// 差し込みがあることを先に確かめる(無くても往復は成り立つので、それだけでは判定にならない=照合の P3-4)
		expect(out).toContain(injected('https://external.example/svg'));
		expect(out).toContain(' href="about:srcdoc#svg2-target" target="_self"');
		expect(stripInjections(out)).toContain('data-vellis-xlink-href');
		expectRoundTrip(SVG_DOC, out);
	});

	test('<base> の注入・リンクの見た目の style・ズームの style は links つきでも今までどおり同居する', () => {
		const out = buildSrcdoc(LINKS_DOC, DOC_URI, 150, LINKS);
		expect(out.match(/<base\b/gi)).toHaveLength(1);
		expect(attr(out.match(/<base\b[^>]*>/i)![0], 'href')).toBe('vellis-asset://local/a/b/doc.html');
		const styles = [...out.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0]);
		expect(styles.some((s) => /\[data-vellis-href\]/.test(s) && /\[data-vellis-xlink-href\]/.test(s))).toBe(true);
		expect(out).toContain(':root{zoom:150%}');
		expect(out).toContain(linkUrl('https://external.example/page'));
		expect(buildSrcdoc(LINKS_DOC, DOC_URI, 150, LINKS)).toBe(out);
	});

	test('<pre> の中の実タグも差し込む(リンクはリンク=要件#8 と同じ読み)', () => {
		const out = buildSrcdoc('<pre><a href="./raw.html">pre 内の実リンク</a></pre>', DOC_URI, undefined, LINKS);
		expect(onlyTag(out, 'a')).toBe(`<a${injected('./raw.html')} data-vellis-href="./raw.html">`);
	});
});

// ---------------------------------------------------------------------------
// AC-88-3 — ページ内のリンク
// ---------------------------------------------------------------------------

describe('AC-88-3 ページ内のリンク: `#…` だけの href は about:srcdoc#…(トークンは入らない)', () => {
	test('<a href="#top"> → href="about:srcdoc#top" target="_self"・元の値は data-vellis-href に逐語', () => {
		const out = buildSrcdoc('<p><a href="#top">アンカー</a></p>', DOC_URI, undefined, LINKS);
		const tag = onlyTag(out, 'a');
		expect(tag).toBe('<a href="about:srcdoc#top" target="_self" data-vellis-href="#top">');
		expect(tag).not.toContain(TOKEN);
		expect(tag).not.toContain('vellis-asset://link/');
	});

	test('SVG の <a href="#svg2-target"> も about:srcdoc#…', () => {
		const out = buildSrcdoc(SVG_DOC, DOC_URI, undefined, LINKS);
		expect(openTags(out, 'a')[2]).toBe('<a href="about:srcdoc#svg2-target" target="_self" data-vellis-href="#svg2-target">');
	});

	test('値の `"` は &quot; にして属性値を壊さない(シングルクォートの原文)', () => {
		const out = buildSrcdoc('<p><a href=\'#a"b\'>t</a></p>', DOC_URI, undefined, LINKS);
		expect(onlyTag(out, 'a')).toBe('<a href="about:srcdoc#a&quot;b" target="_self" data-vellis-href=\'#a"b\'>');
	});

	test('前後の空白を除いてから `#` を見る(" #top " → about:srcdoc#top)。`#` だけ・文字参照つきも逐語', () => {
		expect(attr(onlyTag(buildSrcdoc('<a href=" #top ">t</a>', DOC_URI, undefined, LINKS), 'a'), 'href')).toBe(
			'about:srcdoc#top',
		);
		expect(attr(onlyTag(buildSrcdoc('<a href="#">t</a>', DOC_URI, undefined, LINKS), 'a'), 'href')).toBe('about:srcdoc#');
		expect(attr(onlyTag(buildSrcdoc('<a href="#a&amp;b">t</a>', DOC_URI, undefined, LINKS), 'a'), 'href')).toBe(
			'about:srcdoc#a&amp;b',
		);
	});

	test('ページ内のリンクを含む文書も、差し込みを除いて名前を戻すと原文に戻る', () => {
		const doc = '<h1 id="top">T</h1><p><a href="#top">上へ</a> <a href="other.html#sec">別</a></p>';
		const out = buildSrcdoc(doc, DOC_URI, undefined, LINKS);
		const tags = openTags(out, 'a');
		expect(attr(tags[0], 'href')).toBe('about:srcdoc#top');
		// 別のファイルへの `#…` つきは専用の URL(`#` は受け取った側が除く)
		expect(attr(tags[1], 'href')).toBe(linkUrl('other.html#sec'));
		expectRoundTrip(doc, out);
	});
});

// ---------------------------------------------------------------------------
// AC-88-4 — 差し込まないもの
// ---------------------------------------------------------------------------

describe('AC-88-4 差し込まないもの(要件#8 の限定性と同じ)', () => {
	test('href の無い <a name> / <a id> は無害通過(差し込みも付け替えも無い)', () => {
		const doc = '<p><a name="top">アンカー先</a> と <a id="mark">目印</a></p>';
		const out = buildSrcdoc(doc, DOC_URI, undefined, LINKS);
		expect(out).toContain('<a name="top">');
		expect(out).toContain('<a id="mark">');
		expect(stripInjections(out)).toBe(doc);
	});

	test('空の href(""・空白だけ)には差し込まない(target="_self" も専用の URL も入らない)。往復で原文に戻る', () => {
		for (const doc of ['<p><a href="">空</a></p>', '<p><a href="   ">空白</a></p>', "<p><a href=''>空</a></p>"]) {
			const out = buildSrcdoc(doc, DOC_URI, undefined, LINKS);
			const tag = onlyTag(out, 'a');
			expect(tag, doc).not.toContain('target=');
			expect(tag, doc).not.toContain('vellis-asset://link/');
			expect(tag, doc).not.toContain('about:srcdoc');
			expectRoundTrip(doc, out);
		}
	});

	test('<base> / <link> の href は書き換えない(差し込みも無い)', () => {
		const doc =
			'<html><head><base href="https://example.com/assets/">' +
			'<link rel="stylesheet" href="style.css"></head>' +
			'<body><a href="x.html">x</a></body></html>';
		const out = buildSrcdoc(doc, DOC_URI, undefined, LINKS);
		expect(out).toContain('<base href="https://example.com/assets/">');
		expect(out).toContain('<link rel="stylesheet" href="style.css">');
		expect(out.match(/<base\b/gi), '注入した <base> と原文の <base> の 2 つ').toHaveLength(2);
		expect(onlyTag(out, 'a')).toBe(`<a${injected('x.html')} data-vellis-href="x.html">`);
		expectRoundTrip(doc, out);
	});

	test('<image xlink:href> は書き換えない(画像参照)', () => {
		const out = buildSrcdoc(SVG_DOC, DOC_URI, undefined, LINKS);
		expect(out).toContain('<image xlink:href="images/photo.png" width="10" height="10" />');
	});

	test('コメント・生テキスト(<script> / <textarea> / <xmp>)の中の <a href> は変えない', () => {
		const doc = [
			'<!-- <a href="in-comment.html">c</a> -->',
			'<script>var s = \'<a href="in-script.html">s</a>\';</script>',
			'<textarea><a href="in-textarea.html">t</a></textarea>',
			'<xmp><a href="in-xmp.html">x</a></xmp>',
			'<p><a href="real.html">real</a></p>',
		].join('\n');
		const out = buildSrcdoc(doc, DOC_URI, undefined, LINKS);
		expect(out).toContain('<!-- <a href="in-comment.html">c</a> -->');
		expect(out).toContain('<a href="in-script.html">s</a>');
		expect(out).toContain('<textarea><a href="in-textarea.html">t</a></textarea>');
		expect(out).toContain('<xmp><a href="in-xmp.html">x</a></xmp>');
		expect(out).toContain(`<a${injected('real.html')} data-vellis-href="real.html">`);
		expect((out.match(/vellis-asset:\/\/link\//g) ?? []).length, '専用の URL は実リンクの 1 つだけ').toBe(1);
		expectRoundTrip(doc, out);
	});

	test('エスケープ済みのテキスト・地の文の href= 表記・属性値の中の href= は書き換えない', () => {
		const doc = [
			'<p>コード例: <code>&lt;a href="https://example.com/"&gt;link&lt;/a&gt;</code></p>',
			'<p>地の文にある href="value" という表記も対象外。</p>',
			'<p><a title="see href=docs" href="./target.html">t</a></p>',
		].join('\n');
		const out = buildSrcdoc(doc, DOC_URI, undefined, LINKS);
		expect(out).toContain('&lt;a href="https://example.com/"&gt;');
		expect(out).toContain('href="value"');
		expect(onlyTag(out, 'a')).toBe(`<a${injected('./target.html')} title="see href=docs" data-vellis-href="./target.html">`);
		expectRoundTrip(doc, out);
	});
});

// ---------------------------------------------------------------------------
// renderForDisplay — HTML のとき links を buildSrcdoc に渡す
// ---------------------------------------------------------------------------

describe('renderForDisplay — HTML は links(と zoom)を buildSrcdoc にそのまま渡し、HTML 以外は links を見ない', () => {
	const uri = 'file:///reports/summary.html';
	const content = '<h1>Report</h1>\n<p><a href="other.html">next</a> <a href="https://e.example/">ext</a></p>\n';

	test('html + links: srcdoc は buildSrcdoc(content, uri, 既定の zoom, links) と同一で、専用の URL を含む', async () => {
		const result = await renderForDisplay(uri, content, undefined, undefined, LINKS);
		expect(result.srcdoc).toBe(buildSrcdoc(content, uri, DEFAULT_ZOOM, LINKS));
		expect(result.srcdoc).toContain(linkUrl('other.html'));
		expect(result.srcdoc).toContain(linkUrl('https://e.example/'));
		expect(result.html).toBe('');
		expect(result.index).toBeNull();
	});

	test('html + zoom + links: 両方が srcdoc に乗る', async () => {
		const result = await renderForDisplay(uri, content, 150, undefined, LINKS);
		expect(result.srcdoc).toBe(buildSrcdoc(content, uri, 150, LINKS));
		expect(result.srcdoc).toContain(':root{zoom:150%}');
		expect(result.srcdoc).toContain(linkUrl('other.html'));
	});

	test('html で links を省くと今までどおり(buildSrcdoc(content, uri) と同一・専用の URL なし)', async () => {
		const result = await renderForDisplay(uri, content);
		expect(result.srcdoc).toBe(buildSrcdoc(content, uri));
		expect(result.srcdoc).not.toContain('vellis-asset://link/');
	});

	test('markdown / text / pdf に links を渡しても srcdoc は無く、出力は links なしと同じ', async () => {
		const md = await renderForDisplay('file:///notes/doc.md', '# title\n[x](other.md)\n', undefined, undefined, LINKS);
		const txt = await renderForDisplay('file:///notes/memo.txt', 'plain <a href="x">\n', undefined, undefined, LINKS);
		const pdf = await renderForDisplay('file:///docs/report.pdf', '', undefined, undefined, LINKS);
		expect(md.srcdoc).toBeUndefined();
		expect(txt.srcdoc).toBeUndefined();
		expect(pdf.srcdoc).toBeUndefined();
		expect(md.html).toBe((await renderForDisplay('file:///notes/doc.md', '# title\n[x](other.md)\n')).html);
		expect(txt.html).toBe((await renderForDisplay('file:///notes/memo.txt', 'plain <a href="x">\n')).html);
		expect(pdf.pdfSrc).toBe('vellis-asset://local/docs/report.pdf');
	});
});
