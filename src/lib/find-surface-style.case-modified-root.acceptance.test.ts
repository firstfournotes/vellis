/**
 * 要件#54 追補e の受け入れテスト — `rewriteSurfaceCss` の大小無視と修飾つきの連鎖の畳み込み
 * (docs/requirements/req-54.md「追補e」(2026-10-25)・AC-54-追e (a)(b)・Issue #550・#551)
 *
 * 複製面(Command + F の検索面)と HTML の編集面は Shadow DOM の中に `<body>` / `<html>` を
 * 持たないので、文書の `body{}` / `html{}` / `:root{}` はルート要素(`.vellis-html-find-root`
 * など)へ写してから入れる(追補b)。その写し方に 2 つ穴がある:
 * - #550: 写す判定が小文字だけを見るので `BODY{}` / `Body{}` / `HTML{}` / `:ROOT{}` が写らない。
 *   CSS の型セレクタは大小を区別しないので、iframe では効き複製面では効かない
 * - #551: `html body` の素の組だけを 1 つに畳むので、`html.dark body` は `.root.dark .root` に
 *   なる。ルートは 1 つしかないので何にも当たらない
 *
 * ## 確定契約(追補e 1・2・4。implementer はこれに従う)
 *
 * ```ts
 * // src/lib/find-surface-style.ts(既存・シグネチャは不変)
 * export function rewriteSurfaceCss(css: string, rootSelector?: string): string;
 * ```
 * 1. `html` / `body` / `:root` を**大文字小文字を区別せずに**ルートへ写す(`BODY`・`Body`・
 *    `HTML`・`:ROOT` も)。セレクタのほかの部分(class 名・id・属性の値)の大小は変えない
 * 2. 修飾つきの連鎖(`html.dark body`・`html[lang=ja] body`・`html#x > body.y` など、ルートへ
 *    写った 2 つが子孫か子の結合子で並ぶもの)も 1 つのルートに畳み、両方の修飾をそのルートに
 *    付ける(例: `html.dark body` → `.root.dark`・`html.a body.b` → `.root.a.b`)。起案時判断
 *    (a): 修飾は class だけでなく id・属性もセレクタに書かれたとおり付ける
 * 4. 不変: 素の `html body` を畳む今の振る舞い・写さない場所(`.body`・`#html`・属性の値・
 *    文字列の中)・`FIND_SURFACE_BASE_CSS`
 *
 * ## 観測方式(`find-surface-style.acceptance.test.ts` と同じ家風)
 * 出力は CSS テキストなので、空白の揺れで落ちないよう `norm()` を通して比べる。畳んだ結果の
 * 修飾の並びは契約の例(`html.a body.b` → `.root.a.b`=html 側が先・body 側が後)に合わせて
 * 字面で固定する。id を含む例だけは契約に字面が無いので、「ルートが 1 つ・結合子が無い・
 * 両方の修飾を含む」の構造で判定する。
 *
 * 実装前に赤い理由: `ROOT_LIKE_SELECTOR` が `/(?::root|body|html)/` を大小区別で見るので
 * (a) の大文字が写らない。`collapseRepeatedRoot` がルート 2 つの**隣接**だけを畳むので、
 * 間に修飾(`.dark` など)が挟まる (b) は `.root.dark .root` のまま残る。
 */
import { describe, expect, test } from 'vitest';
import { FIND_SURFACE_ROOT_SELECTOR, rewriteSurfaceCss } from './find-surface-style';

/** CSS テキストの空白を正規化する(契約は字面ではなく構造)。 */
function norm(css: string): string {
	return css
		.replace(/\s+/g, ' ')
		.replace(/\s*([{}:;,>])\s*/g, '$1')
		.trim();
}

const R = FIND_SURFACE_ROOT_SELECTOR; // '.vellis-html-find-root'

/** セレクタ並びの中でルートセレクタが現れる回数。 */
function countRoot(selector: string): number {
	return selector.split(R).length - 1;
}

/** `{` の前のセレクタ部分(規則 1 つの CSS に限る)。 */
function selectorOf(css: string): string {
	return norm(css).split('{')[0];
}

// ---------------------------------------------------------------------------
// AC-54-追e (a) — 大文字小文字を区別せずにルートへ写す(#550)
// ---------------------------------------------------------------------------

describe('AC-54-追e (a) — BODY / Body / HTML / :ROOT もルートへ写る(大小無視)', () => {
	test('BODY{color:red} がルートへ写る(宣言は無傷)', () => {
		expect(norm(rewriteSurfaceCss('BODY{color:red}'))).toBe(norm(`${R}{color:red}`));
	});

	test('Body{margin:0}(先頭だけ大文字)も写る', () => {
		expect(norm(rewriteSurfaceCss('Body{margin:0}'))).toBe(norm(`${R}{margin:0}`));
	});

	test('HTML{font-size:16px} も写る', () => {
		expect(norm(rewriteSurfaceCss('HTML{font-size:16px}'))).toBe(norm(`${R}{font-size:16px}`));
	});

	test(':ROOT{--x:1} も写る', () => {
		expect(norm(rewriteSurfaceCss(':ROOT{--x:1}'))).toBe(norm(`${R}{--x:1}`));
	});

	test('BODY.Dark は写すが、class 名の大小(Dark)は変えない', () => {
		expect(norm(rewriteSurfaceCss('BODY.Dark{color:red}'))).toBe(norm(`${R}.Dark{color:red}`));
	});

	test('BODY > .Box は結合子ごとルートを頭に(.Box の大小は変えない)', () => {
		expect(norm(rewriteSurfaceCss('BODY > .Box{x:1}'))).toBe(norm(`${R}>.Box{x:1}`));
	});

	test(', 区切りの中の BODY も独立に写る(他は無傷)', () => {
		expect(norm(rewriteSurfaceCss('p, BODY, .a{x:1}'))).toBe(norm(`p,${R},.a{x:1}`));
	});

	test('@media の中の BODY も写る', () => {
		expect(norm(rewriteSurfaceCss('@media (min-width: 1px){BODY{x:1}}'))).toBe(
			norm(`@media (min-width: 1px){${R}{x:1}}`),
		);
	});

	test('別の rootSelector を渡したときも大小無視で写る(編集面の経路)', () => {
		expect(norm(rewriteSurfaceCss('HTML{x:1}', '.vellis-html-edit-root'))).toBe(
			norm('.vellis-html-edit-root{x:1}'),
		);
	});
});

describe('AC-54-追e (a) — 大文字でも写してはいけない場所は写さない(不変)', () => {
	test('.BODY(class)は写らない', () => {
		expect(norm(rewriteSurfaceCss('.BODY{x:1}'))).toBe(norm('.BODY{x:1}'));
	});

	test('#Html(id)は写らない', () => {
		expect(norm(rewriteSurfaceCss('#Html{x:1}'))).toBe(norm('#Html{x:1}'));
	});

	test('TBODY(body を含むだけの型セレクタ)は写らない', () => {
		expect(norm(rewriteSurfaceCss('TBODY{x:1}'))).toBe(norm('TBODY{x:1}'));
	});

	test('属性の値 [data-body="BODY"] と文字列 "HTML" は触らない', () => {
		const css = '[data-body="BODY"]{x:1}p::before{content:"HTML"}';
		expect(norm(rewriteSurfaceCss(css))).toBe(norm(css));
	});
});

// ---------------------------------------------------------------------------
// AC-54-追e (b) — 修飾つきの連鎖を 1 つのルートに畳む(#551)
// ---------------------------------------------------------------------------

describe('AC-54-追e (b) — html.dark body などの修飾つきの連鎖がルート 1 つに畳まれる', () => {
	test('html.dark body{…} → ルート 1 つに .dark が付いた形', () => {
		expect(norm(rewriteSurfaceCss('html.dark body{background:#222;color:#eee}'))).toBe(
			norm(`${R}.dark{background:#222;color:#eee}`),
		);
	});

	test('html.a > body.b{…}(子結合子)→ .a.b が付いた形', () => {
		expect(norm(rewriteSurfaceCss('html.a > body.b{x:1}'))).toBe(norm(`${R}.a.b{x:1}`));
	});

	test('html.a body.b{…}(子孫結合子)→ .a.b が付いた形', () => {
		expect(norm(rewriteSurfaceCss('html.a body.b{x:1}'))).toBe(norm(`${R}.a.b{x:1}`));
	});

	test('HTML.dark BODY{…}(大文字)も同じ形', () => {
		expect(norm(rewriteSurfaceCss('HTML.dark BODY{x:1}'))).toBe(norm(`${R}.dark{x:1}`));
	});

	test(':root.dark body{…}(:root と body の組)も畳む', () => {
		expect(norm(rewriteSurfaceCss(':root.dark body{x:1}'))).toBe(norm(`${R}.dark{x:1}`));
	});

	test('html[lang=ja] body{…}(属性の修飾)→ ルート 1 つに [lang=ja] が付いた形', () => {
		expect(norm(rewriteSurfaceCss('html[lang=ja] body{x:1}'))).toBe(norm(`${R}[lang=ja]{x:1}`));
	});

	test('html#x > body.y{…}(id の修飾)→ ルート 1 つ・結合子なし・#x と .y を持つ', () => {
		const selector = selectorOf(rewriteSurfaceCss('html#x > body.y{x:1}'));
		expect(selector.startsWith(R), 'ルートが頭に来る: ' + selector).toBe(true);
		expect(countRoot(selector), 'ルートは 1 つ: ' + selector).toBe(1);
		expect(selector, '結合子(空白・>)が残らない').not.toMatch(/[\s>]/);
		expect(selector).toContain('#x');
		expect(selector).toContain('.y');
	});

	test('畳んだあとに続く子孫セレクタは残る: html.dark body .box → ルート.dark .box', () => {
		expect(norm(rewriteSurfaceCss('html.dark body .box{x:1}'))).toBe(norm(`${R}.dark .box{x:1}`));
	});

	test('畳んだあとに続く子セレクタも残る: html.dark body > p → ルート.dark>p', () => {
		expect(norm(rewriteSurfaceCss('html.dark body > p{x:1}'))).toBe(norm(`${R}.dark>p{x:1}`));
	});

	test(', 区切りの各セレクタを独立に畳む', () => {
		expect(norm(rewriteSurfaceCss('html.dark body.light p, body.x{x:1}'))).toBe(
			norm(`${R}.dark.light p,${R}.x{x:1}`),
		);
	});

	test('@media の中でも畳む', () => {
		expect(norm(rewriteSurfaceCss('@media screen{html.dark body{x:1}}'))).toBe(
			norm(`@media screen{${R}.dark{x:1}}`),
		);
	});

	test('宣言の中の url("body.png") などは無傷のまま畳む', () => {
		expect(norm(rewriteSurfaceCss('html.dark body{background:url("body.png")}'))).toBe(
			norm(`${R}.dark{background:url("body.png")}`),
		);
	});

	test('別の rootSelector(編集面)でも同じく畳む', () => {
		expect(norm(rewriteSurfaceCss('html.dark body{x:1}', '.vellis-html-edit-root'))).toBe(
			norm('.vellis-html-edit-root.dark{x:1}'),
		);
	});
});

describe('AC-54-追e (b) — 素の html body は今までどおりルート 1 つ・畳んではいけないものは畳まない(不変)', () => {
	test('html body{…} → ルート 1 つ', () => {
		expect(norm(rewriteSurfaceCss('html body{x:1}'))).toBe(norm(`${R}{x:1}`));
	});

	test('html > body{…} → ルート 1 つ', () => {
		expect(norm(rewriteSurfaceCss('html > body{x:1}'))).toBe(norm(`${R}{x:1}`));
	});

	test('html.dark .body(class の .body はルートではない)は畳まない', () => {
		expect(norm(rewriteSurfaceCss('html.dark .body{x:1}'))).toBe(norm(`${R}.dark .body{x:1}`));
	});

	test('html.dark tbody(tbody はルートではない)は畳まない', () => {
		expect(norm(rewriteSurfaceCss('html.dark tbody{x:1}'))).toBe(norm(`${R}.dark tbody{x:1}`));
	});

	test('body.dark 単独(連鎖ではない)は従来どおり class を引き継ぐ', () => {
		expect(norm(rewriteSurfaceCss('body.dark{x:1}'))).toBe(norm(`${R}.dark{x:1}`));
	});
});
