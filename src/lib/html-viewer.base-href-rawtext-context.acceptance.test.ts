/**
 * 要件#8 追補d の受け入れテスト — base の href の逃がし・生の文字の要素の終わりのタグの境界・
 * svg / math / select の文脈
 * (docs/requirements/req-08.md「追補d」(2026-10-25)・AC-8-追d (a)〜(d)・Issue #380・#705)
 *
 * `src/lib/html-viewer.ts` に 2 つの不具合がある:
 * - #380: `buildSrcdoc` は `<base href="…">` に `toAssetUri(docUri)` をそのまま入れ、`&` を
 *   逃がしていない。フォルダ名に `&copy` のような文字参照に見える並びがあると、属性の値として
 *   復号されて base がずれ、相対の画像が解決できない
 * - #705: `retargetLinks` は (1) 終わりのタグを前方一致で探す(`</xmp` が `</xmpx>` でも閉じと
 *   みなす)(2) `<svg>` / `<math>`(foreign content)や `<select>` の中では `xmp`・`style` などは
 *   生の文字の要素にならないのに、生の文字として読み飛ばすので、後ろの本物のリンクが退避されない
 *
 * ## 確定契約(追補d 1〜4。implementer はこれに従う)
 * 1. `buildSrcdoc` は base の href の値を属性値として逃がす(`&` → `&amp;`・`"` → `&quot;`)。
 *    逃がした結果を属性として読むと `toAssetUri(docUri)` と同じ文字列に戻る
 * 2. `retargetLinks` の生の文字の要素の終わりのタグは、名前の後ろに境界(空白・`/`・`>`・文書の
 *    終わり)があるときだけ閉じとみなす(`</xmp>`・`</xmp >`・`</XMP>` は閉じ、`</xmpx>` は
 *    閉じない)。`RAW_TEXT_END` の全部の要素で同じ
 * 3. `retargetLinks` は、`<svg>…</svg>`・`<math>…</math>`(入れ子の数を数える)と
 *    `<select>…</select>` の中では、生の文字の要素の開きタグを生の文字の始まりとして扱わない
 *    (そのまま後ろのタグを走査する)。`<plaintext>` も同じ。起案時判断 (c): 自己終了の
 *    `<svg/>` / `<math/>`(タグが `/>` で終わる。引用符の無い値の `/` は数えない)は文脈を開かない
 * 4. 不変: 退避する属性の定義(`NAVIGATING_ATTRIBUTES`)・生の文字の要素の集合・それ以外の文脈
 *    での読み飛ばし・追補a〜c の振る舞い(= 既存の要件8 のテストが無改変で緑 = AC (e)。
 *    このファイルでは扱わない)
 *
 * ## 観測方式(既存の要件#8 の受け入れテストと同じ家風)
 * `retargetLinks` は export されていないので、公開されている入口 `buildSrcdoc` を通す(契約に
 * export は求めない)。注入されるのは `<base>`・リンク style・`href` → `data-vellis-href` の改名
 * だけなので:
 * - 「退避されない」= 出力が `<base …>` の注入を除いて入力そのまま(`endsWith(content)`)で、
 *   `data-vellis-href` を含まない
 * - 「退避される」= `<a …>` の開きタグに `data-vellis-href="…"` があり、有効な `href=` が無い
 * base の href は、DOMParser で読んだ `<base>` の `href` 属性の値(= ブラウザが見る値)で判定する。
 *
 * 期待値は HTML の構文の読み方(生の文字の要素の終わりのタグは「名前+境界」・foreign content と
 * select の中では xmp / style などは普通の要素)に従う。`&copy` は `;` が無くても `/` が続けば
 * 属性の値の中で `©` に復号される(名前つき文字参照の互換規則)。
 *
 * 実装前に赤い理由: (a)=`buildSrcdoc` が `&` を逃がさないので `&copy` / `&amp;` を含むパスの
 * `<base>` の値がずれる。(b)=`RAW_TEXT_END` の正規表現 `/<\/xmp/gi` が `</xmpx>` にも当たるので、
 * まだ xmp の中にある `<a>` を退避してしまう(各要素の「x を足した終わりのタグ」の例)。
 * (c)=svg / math / select の中でも生の文字として読み飛ばすので、閉じが無い `<xmp>` 等の後ろの
 * 本物の `<a>` を文書の終わりまで退避しない。(d) と「境界があれば閉じる」の例は現行でも緑
 * (退行防止)。
 */
import { describe, expect, test } from 'vitest';
import { buildSrcdoc } from './html-viewer';
import { toAssetUri } from './uri';

const DOC_URI = 'file:///a/b/doc.html';

/** 出力の最初の `<a …>` 開きタグ。無ければテスト失敗 */
function firstAnchorTag(srcdoc: string): string {
	const m = srcdoc.match(/<a\b[^>]*>/i);
	if (m === null) {
		throw new Error(`<a> が見つからない: ${srcdoc.slice(0, 160)}`);
	}
	return m[0];
}

/** 出力のすべての `<a …>` 開きタグ(文書順) */
function anchorTags(srcdoc: string): string[] {
	return [...srcdoc.matchAll(/<a\b[^>]*>/gi)].map((m) => m[0]);
}

/** タグが退避されている(data-vellis-href を持ち、有効な href= が無い)か */
function isRetargeted(tag: string): boolean {
	return /\bdata-vellis-href\s*=/i.test(tag) && !/(?<![-\w])href\s*=/i.test(tag);
}

/** タグが触られていない(有効な href= を持ち、data-vellis-href が無い)か */
function isUntouched(tag: string): boolean {
	return /(?<![-\w])href\s*=/i.test(tag) && !/\bdata-vellis-href\s*=/i.test(tag);
}

/** 退避されること(開きタグが 1 つのときの判定) */
function expectRetargeted(content: string): void {
	const out = buildSrcdoc(content, DOC_URI);
	const tag = firstAnchorTag(out);
	expect(isRetargeted(tag), `<a> が退避されること: ${tag}  (入力: ${content})`).toBe(true);
}

/** 退避されないこと=出力が base の注入を除いて入力そのまま */
function expectUntouched(content: string): void {
	const out = buildSrcdoc(content, DOC_URI);
	expect(out, `退避されず、入力がそのまま残ること (入力: ${content})`).toContain(content);
	expect(out.endsWith(content), `注入は <base> だけで末尾は入力そのまま (入力: ${content})`).toBe(true);
	expect(out, 'data-vellis-href が現れないこと').not.toContain('data-vellis-href');
}

/** DOMParser で読んだ最初の `<base>` の href 属性の値(= ブラウザが解釈する値)。無ければ失敗 */
function parsedBaseHref(srcdoc: string): string {
	const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
	const base = doc.querySelector('base');
	if (base === null) {
		throw new Error(`<base> が見つからない: ${srcdoc.slice(0, 160)}`);
	}
	const href = base.getAttribute('href');
	if (href === null) {
		throw new Error(`<base> に href が無い: ${base.outerHTML}`);
	}
	return href;
}

/** 契約 2 の「生の文字の要素」の集合(plaintext は終わりのタグが無いので別扱い) */
const RAW_TEXT_WITH_END_TAG = [
	'script',
	'style',
	'textarea',
	'title',
	'xmp',
	'iframe',
	'noembed',
	'noframes',
] as const;

// ---------------------------------------------------------------------------
// AC-8-追d (a) — base の href を属性値として逃がす(#380)
// ---------------------------------------------------------------------------

describe('AC-8-追d (a) — <base> の href を DOMParser で読むと toAssetUri(docUri) と同じ(#380)', () => {
	const FULL = '<!doctype html><html><head><title>t</title></head><body><img src="img.png"></body></html>';

	test.each([
		['&copy(セミコロン無しの名前つき文字参照に見える並び)', 'file:///Users/a/&copy/doc.html'],
		['&not', 'file:///Users/a/&not/doc.html'],
		['&amp;(綴りそのまま残るべき)', 'file:///Users/a/x&amp;y/doc.html'],
		['ssh の文書でも同じ', 'ssh://user@host/data/&copy/doc.html'],
	])('%s', (_label, docUri) => {
		const out = buildSrcdoc(FULL, docUri);
		expect(parsedBaseHref(out)).toBe(toAssetUri(docUri));
	});

	test('" を含むパス(URL が %22 に符号化する)でも同じ', () => {
		const docUri = 'file:///Users/a/say"hi"/doc.html';
		const out = buildSrcdoc(FULL, docUri);
		expect(parsedBaseHref(out)).toBe(toAssetUri(docUri));
	});

	test('文字参照に見えない & (a&b) も同じ', () => {
		const docUri = 'file:///Users/a/a&b/doc.html';
		const out = buildSrcdoc(FULL, docUri);
		expect(parsedBaseHref(out)).toBe(toAssetUri(docUri));
	});

	test('<head> の無い断片でも同じ(注入は先頭・パーサが head へ持ち上げる)', () => {
		const docUri = 'file:///Users/a/&copy/doc.html';
		const out = buildSrcdoc('<p>bare</p>', docUri);
		expect(parsedBaseHref(out)).toBe(toAssetUri(docUri));
	});

	test('文書が自分の <base> を持っていても、最初の <base>(注入したもの)の値が同じ', () => {
		const docUri = 'file:///Users/a/&copy/doc.html';
		const out = buildSrcdoc(
			'<html><head><base href="https://example.com/assets/"><title>t</title></head><body></body></html>',
			docUri,
		);
		expect(parsedBaseHref(out)).toBe(toAssetUri(docUri));
	});

	test('& も " も無い普通のパスでは、逃がしの前後で字面が変わらない(不変・過剰に逃がさない)', () => {
		const out = buildSrcdoc('<p>bare</p>', DOC_URI);
		expect(out.startsWith('<base href="vellis-asset://local/a/b/doc.html">')).toBe(true);
		expect(parsedBaseHref(out)).toBe(toAssetUri(DOC_URI));
	});
});

// ---------------------------------------------------------------------------
// AC-8-追d (b) — 生の文字の要素の終わりのタグは「名前+境界」で閉じる(#705 (1))
// ---------------------------------------------------------------------------

describe('AC-8-追d (b) — </xmpx> は閉じではない・</xmp>・</xmp >・</XMP> は閉じ(#705 (1))', () => {
	test('<xmp></xmpx><a href="x"> の a は退避されない(まだ xmp の中)', () => {
		expectUntouched('<xmp></xmpx><a href="x">link</a>');
	});

	test('<xmp></xmp ><a href="x"> の a は退避される(空白が境界)', () => {
		expectRetargeted('<xmp></xmp ><a href="x">link</a>');
	});

	test('<XMP></XMP><a href="x"> の a は退避される(名前の大小は無視)', () => {
		expectRetargeted('<XMP></XMP><a href="x">link</a>');
	});

	test('<xmp></xmp/><a href="x"> の a は退避される(/ が境界)', () => {
		expectRetargeted('<xmp></xmp/><a href="x">link</a>');
	});

	test('<xmp></xmp\\n><a href="x"> の a は退避される(改行も空白)', () => {
		expectRetargeted('<xmp></xmp\n><a href="x">link</a>');
	});

	test('<xmp></xmpx>…</xmp><a href="x"> は本物の閉じの後ろだけ退避される', () => {
		const out = buildSrcdoc('<xmp></xmpx><a href="x">in</a></xmp><a href="y">out</a>', DOC_URI);
		const tags = anchorTags(out);
		expect(tags).toHaveLength(2);
		expect(isUntouched(tags[0]), `xmp の中の a は触らない: ${tags[0]}`).toBe(true);
		expect(isRetargeted(tags[1]), `xmp の後ろの a は退避する: ${tags[1]}`).toBe(true);
	});

	describe('RAW_TEXT_END の全部の要素で同じ', () => {
		test.each(RAW_TEXT_WITH_END_TAG)('%s: <X></Xx><a href="x"> の a は退避されない', (name) => {
			expectUntouched(`<${name}></${name}x><a href="x">link</a>`);
		});

		test.each(RAW_TEXT_WITH_END_TAG)('%s: <X></X><a href="x"> の a は退避される(不変)', (name) => {
			expectRetargeted(`<${name}></${name}><a href="x">link</a>`);
		});

		test.each(RAW_TEXT_WITH_END_TAG)('%s: <X></X ><a href="x"> の a は退避される', (name) => {
			expectRetargeted(`<${name}></${name} ><a href="x">link</a>`);
		});

		test.each(RAW_TEXT_WITH_END_TAG)('%s: <X></X/><a href="x"> の a は退避される', (name) => {
			expectRetargeted(`<${name}></${name}/><a href="x">link</a>`);
		});

		test.each(RAW_TEXT_WITH_END_TAG)('%s: <X></X(大文字)><a href="x"> の a は退避される', (name) => {
			const upper = name.toUpperCase();
			expectRetargeted(`<${name}></${upper}><a href="x">link</a>`);
		});
	});
});

// ---------------------------------------------------------------------------
// AC-8-追d (c) — svg / math / select の中では生の文字の要素にならない(#705 (2))
// ---------------------------------------------------------------------------

describe('AC-8-追d (c) — <svg> / <math> / <select> の中の xmp・style などは生の文字にしない(#705 (2))', () => {
	test('<svg><xmp></svg><a href="https://x"> の a は退避される', () => {
		expectRetargeted('<svg><xmp></svg><a href="https://x">link</a>');
	});

	test('<math><style></math><a href="https://x"> の a は退避される', () => {
		expectRetargeted('<math><style></math><a href="https://x">link</a>');
	});

	test('<select><xmp></select><a href="https://x"> の a は退避される', () => {
		expectRetargeted('<select><xmp></select><a href="https://x">link</a>');
	});

	test('<svg><svg></svg><xmp></svg><a href="https://x">(入れ子)の a は退避される', () => {
		expectRetargeted('<svg><svg></svg><xmp></svg><a href="https://x">link</a>');
	});

	test('<math><math></math><style></math><a href="https://x">(入れ子)の a は退避される', () => {
		expectRetargeted('<math><math></math><style></math><a href="https://x">link</a>');
	});

	test('<SVG><XMP></SVG><a href="x">(大文字)の a は退避される', () => {
		expectRetargeted('<SVG><XMP></SVG><a href="x">link</a>');
	});

	test('<svg><plaintext></svg><a href="x"> の a は退避される(plaintext も同じ)', () => {
		expectRetargeted('<svg><plaintext></svg><a href="x">link</a>');
	});

	test('<select><plaintext></select><a href="x"> の a は退避される', () => {
		expectRetargeted('<select><plaintext></select><a href="x">link</a>');
	});

	test.each(RAW_TEXT_WITH_END_TAG)('<svg><%s></svg><a href="x"> の a は退避される(集合の全部)', (name) => {
		expectRetargeted(`<svg><${name}></svg><a href="x">link</a>`);
	});

	test('svg の中の a(xmp を閉じたあと)も引き続き退避される(不変)', () => {
		expectRetargeted('<svg><xmp></xmp><a href="x">link</a></svg>');
	});
});

describe('AC-8-追d (c) — 自己終了の <svg/> / <math/> は文脈を開かない(起案時判断 (c))', () => {
	// 実装後の追加(reviewer P3-1)。`<svg/>` でも文脈を開く変異が生き残ったので固定する。
	// 外せば `<svg/>` の後ろの `<xmp>` が「svg の中」と見なされて生の文字にならず、
	// 中の a が退避されて赤になる(1・2・4・5)。3 は「引用符の無い値の `/` は自己終了ではない」
	// の裏側=`<svg a=b/>` を自己終了と読む変異で赤になる。
	test('<svg/><xmp><a href="x"></xmp> の a は退避されない(svg は開いていないので xmp は生の文字)', () => {
		expectUntouched('<svg/><xmp><a href="x">link</a></xmp>');
	});

	test('<math/><style><a href="x"></style> の a は退避されない', () => {
		expectUntouched('<math/><style><a href="x">link</a></style>');
	});

	test('<svg a=b/><xmp></svg><a href="x">(引用符の無い値の / は自己終了ではない=svg が開く)の a は退避される', () => {
		expectRetargeted('<svg a=b/><xmp></svg><a href="x">link</a>');
	});

	test('<svg width="1" /><xmp><a href="x"></xmp>(/> の前に空白)の a は退避されない', () => {
		expectUntouched('<svg width="1" /><xmp><a href="x">link</a></xmp>');
	});

	test('<svg><svg/></svg><xmp><a href="x"></xmp>(入れ子の自己終了は数に入らない)の a は退避されない', () => {
		expectUntouched('<svg><svg/></svg><xmp><a href="x">link</a></xmp>');
	});
});

describe('AC-8-追d (c) — 文脈から抜けたら元どおり生の文字として読む(不変)', () => {
	test('<svg></svg><xmp><a href="x"></xmp> の a は退避されない', () => {
		expectUntouched('<svg></svg><xmp><a href="x">link</a></xmp>');
	});

	test('<svg><svg></svg></svg><xmp><a href="x"></xmp>(入れ子を全部閉じた後)の a は退避されない', () => {
		expectUntouched('<svg><svg></svg></svg><xmp><a href="x">link</a></xmp>');
	});

	test('<math></math><style><a href="x"></style> の a は退避されない', () => {
		expectUntouched('<math></math><style><a href="x">link</a></style>');
	});

	test('<select></select><xmp><a href="x"></xmp> の a は退避されない', () => {
		expectUntouched('<select></select><xmp><a href="x">link</a></xmp>');
	});
});

// ---------------------------------------------------------------------------
// AC-8-追d (d) — svg / math / select の外では今までどおり(不変)
// ---------------------------------------------------------------------------

describe('AC-8-追d (d) — svg・math・select の外の <xmp><a href="x"></xmp> は今までどおり退避しない', () => {
	test('<xmp><a href="x"></xmp> の a は退避されない', () => {
		expectUntouched('<xmp><a href="x">link</a></xmp>');
	});

	test('<p><xmp><a href="x"></xmp></p> の a は退避されない', () => {
		expectUntouched('<p><xmp><a href="x">link</a></xmp></p>');
	});

	test('<style><a href="x"></style> の a は退避されない', () => {
		expectUntouched('<style><a href="x">link</a></style>');
	});

	test('<xmp><a href="x"></xmp><a href="y"> は後ろの a だけ退避される', () => {
		const out = buildSrcdoc('<xmp><a href="x">in</a></xmp><a href="y">out</a>', DOC_URI);
		const tags = anchorTags(out);
		expect(tags).toHaveLength(2);
		expect(isUntouched(tags[0]), `xmp の中の a は触らない: ${tags[0]}`).toBe(true);
		expect(isRetargeted(tags[1]), `xmp の後ろの a は退避する: ${tags[1]}`).toBe(true);
	});
});
