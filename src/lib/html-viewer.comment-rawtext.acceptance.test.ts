/**
 * 要件#8 追補a の受け入れテスト — `retargetLinks` のコメントの終わりの読み方と生の文字の要素
 * (docs/requirements/req-08.md「追補a」(2026-10-19)・AC-8-追a (a)〜(c)・Issue #386 = backlog 16)
 *
 * `src/lib/html-viewer.ts` の `retargetLinks`(リンクを押しても枠が移らないよう、`<a>` / `<area>`
 * の行き先を退避する走査)が、HTML の構文の読み方と2点でずれている:
 * - コメントの終わりを `-->` だけで探す。HTML ではすぐ閉じる `<!-->`・`<!--->` も、閉じの
 *   `--!>` もコメントの終わりなので、その後ろの本物のリンクを「コメントの中」と見て退避しない
 *   (= 押すとプレビューが外のページに置き換わる)
 * - 生の文字として読む要素を `script`・`style`・`textarea`・`title` だけで見ている。`xmp`・
 *   `plaintext` などの中の `<a href>` を本物のタグとして書き換え、表示される文字が変わる
 *
 * ## 契約(追補a)
 * 1. コメントの終わりを HTML と同じに読む: `<!--` の直後が `>` か `->` ならそこで閉じる
 *    (`<!-->`・`<!--->`)。それ以外は、最初に現れる `-->` か `--!>` で閉じる。閉じが無ければ
 *    文書の終わりまで(今のまま)
 * 2. 生の文字として読む要素を HTML と揃える: 今の4つに `xmp`・`iframe`・`noembed`・`noframes`
 *    を足す(終わりのタグまで生の文字)。`plaintext` は文書の終わりまで生の文字
 * 3. 不変: 退避する属性と退避先の名前・`<base>` / `<link>` の `href` を触らない・エスケープ
 *    された文字・属性の値・`<pre>` の中の本物のリンクは退避する・閉じていないタグの扱い
 *    (= 既存の `html-viewer.acceptance.test.ts` が無改変で緑 = AC (d)。このファイルでは扱わない)
 *
 * ## 観測方式(既存の要件#8 の受け入れテストと同じ家風)
 *
 * `retargetLinks` は export されていないので、公開されている入口 `buildSrcdoc` を通す。
 * 書き換えは「`<base>` 注入・リンク style 注入・`href` → `data-vellis-href` の改名」だけなので、
 * 注入物を除いて退避名を `href` へ戻せば原文に逐語復元できる(`stripInjections`)。
 * 退避の有無は開きタグの文字列で判定する(`vellisHref` / `hasActiveHref`)。
 *
 * 期待値はいずれも jsdom(parse5)の DOMParser で「後ろの `<a>` が要素になるか・中の
 * `<a href>` が文字のままか」を実測して確かめたもの(2026-10-19)。
 *
 * 実装前に赤い理由: `retargetLinks` のコメント読みが `-->` だけを探すので、`<!-->`・`<!--->`・
 * `--!>` の後ろを文書の終わり(または後出の `-->`)まで読み飛ばし、本物の `<a>` を退避しない
 * ((a)-1〜(a)-4 が赤)。`RAW_TEXT_END` に `xmp` / `iframe` / `noembed` / `noframes` /
 * `plaintext` が無いので、中の `<a href>` を退避してしまう((c)-1〜(c)-5 が赤)。
 * (a)-5(`<!---->`)と (b)-1〜(b)-3 は契約1 の境界を固定する退行防止で、現行でも緑。
 */
import { describe, expect, test } from 'vitest';
import { buildSrcdoc } from './html-viewer';

const DOC_URI = 'file:///a/b/doc.html';

/** srcdoc 中の最初の <base …> タグ(文書順)を取り出す。無ければテスト失敗 */
function firstBaseTag(srcdoc: string): string {
	const m = srcdoc.match(/<base\b[^>]*>/i);
	if (m === null) {
		throw new Error(`<base> が srcdoc に注入されていない: ${srcdoc.slice(0, 120)}`);
	}
	return m[0];
}

/** srcdoc 中の <a …> 開きタグを文書順にすべて返す(コメント・生の文字の中のものも含む) */
function anchorTags(srcdoc: string): string[] {
	return [...srcdoc.matchAll(/<a\b[^>]*>/gi)].map((m) => m[0]);
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

/**
 * 注入されたリンク style(data-vellis 退避名を参照する <style> ブロック)をすべて返す。
 * 1ブロックにまとめるか分けるかは実装裁量なので複数形で扱う
 */
function injectedStyleBlocks(srcdoc: string): string[] {
	return [...srcdoc.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)]
		.map((m) => m[0])
		.filter((s) => s.includes('data-vellis'));
}

/** 注入物を除去する(文書順で最初の <base> 1個+リンク style)。逐語復元の検査用 */
function stripInjections(srcdoc: string): string {
	let out = srcdoc.replace(firstBaseTag(srcdoc), '');
	for (const style of injectedStyleBlocks(out)) {
		out = out.replace(style, '');
	}
	return out;
}

/** 注入物を除き、退避名を href へ戻した文字列(= 原文と一致すべきもの) */
function restored(srcdoc: string): string {
	return stripInjections(srcdoc).replaceAll('data-vellis-href', 'href');
}

/** 退避されたタグであること: 有効な href が残らず、data-vellis-href に元の値がある */
function expectRetargeted(tag: string, href: string): void {
	expect(hasActiveHref(tag), `href が退避されず残っている: ${tag}`).toBe(false);
	expect(vellisHref(tag)).toBe(href);
}

/** 触られていないタグであること: 有効な href がそのまま・退避名は付いていない */
function expectUntouched(tag: string, href: string): void {
	expect(hasActiveHref(tag), `href が退避されてしまっている: ${tag}`).toBe(true);
	expect(tag).not.toContain('data-vellis-href');
	expect(tag).toContain(`href="${href}"`);
}

describe('buildSrcdoc — コメントの終わりの読み方(要件#8 追補a・AC-8-追a (a)(b))', () => {
	/** コメントの後ろに置く本物のリンク(退避されるべきもの) */
	const TRAILING_LINK = '<a href="https://x">a</a>';

	/** `comment` で閉じたコメントの後ろの <a href> が退避され、コメントは逐語のまま・原文復元できる */
	function expectTrailingLinkRetargeted(comment: string): void {
		const doc = comment + TRAILING_LINK;
		const out = buildSrcdoc(doc, DOC_URI);
		const anchors = anchorTags(out);
		expect(anchors, `<a> は1つだけ: ${out}`).toHaveLength(1);
		expectRetargeted(anchors[0], 'https://x');
		expect(out, 'コメントそのものは逐語のまま').toContain(comment);
		expect(restored(out)).toBe(doc);
	}

	test('AC-8-追a (a)-1: すぐ閉じる <!--> の後ろの <a href> が退避される', () => {
		expectTrailingLinkRetargeted('<!-->');
	});

	test('AC-8-追a (a)-2: すぐ閉じる <!---> の後ろの <a href> が退避される', () => {
		expectTrailingLinkRetargeted('<!--->');
	});

	test('AC-8-追a (a)-3: --!> で閉じたコメント(<!-- c --!>)の後ろの <a href> が退避される', () => {
		expectTrailingLinkRetargeted('<!-- c --!>');
	});

	test('AC-8-追a (a)-4: --!> が先に現れればそこで閉じ、後出の --> は地の文(契約1「最初に現れる --> か --!>」)', () => {
		// `--!>` の後ろのリンクも、さらに後ろの ` --> ` を越えたリンクも、どちらも本物のタグ
		const doc = '<!-- c --!><a href="https://x">a</a> --> <a href="https://y">b</a>';
		const out = buildSrcdoc(doc, DOC_URI);
		const anchors = anchorTags(out);
		expect(anchors).toHaveLength(2);
		expectRetargeted(anchors[0], 'https://x');
		expectRetargeted(anchors[1], 'https://y');
		expect(out, '地の文の --> は逐語のまま').toContain('</a> --> <a');
		expect(restored(out)).toBe(doc);
	});

	test('AC-8-追a (a)-5(契約1 の境界): <!----> は空コメントとして閉じ、後ろの <a href> が退避される', () => {
		// `<!--` の直後は `-->`(`>` でも `->` でもない)= 一般則「最初の -->」で index 4 の
		// `-->` が閉じ。すぐ閉じる形の特別扱いが、この形を巻き込まないことを固定する
		expectTrailingLinkRetargeted('<!---->');
	});

	test('AC-8-追a (b)-1: <!-- <a href="x"> --> の中は今までどおり触らない(退避も style 注入もされない)', () => {
		const doc = '<!-- <a href="x"> --><p>t</p>';
		const out = buildSrcdoc(doc, DOC_URI);
		expect(out).toContain('<!-- <a href="x"> -->');
		expect(out, '退避が1件も無いので退避名はどこにも現れない(style も注入されない)').not.toContain(
			'data-vellis',
		);
		expect(stripInjections(out)).toBe(doc);
	});

	test('AC-8-追a (b)-2: 中に -- を含むコメント(<!-- a -- … -->)は最初の --> まで続く(中の <a href> は触らず・後ろは退避)', () => {
		const doc = '<!-- a -- <a href="x">in</a> --><a href="https://y">out</a>';
		const out = buildSrcdoc(doc, DOC_URI);
		expect(out, 'コメントは丸ごと逐語のまま').toContain('<!-- a -- <a href="x">in</a> -->');
		const anchors = anchorTags(out);
		expect(anchors).toHaveLength(2);
		expectUntouched(anchors[0], 'x');
		expectRetargeted(anchors[1], 'https://y');
		expect(restored(out)).toBe(doc);
	});

	test('AC-8-追a (b)-3: --! の後ろが > でなければ閉じない(<!-- a --! … -->。閉じるのは --!> だけ)', () => {
		const doc = '<!-- a --! <a href="x">in</a> --><a href="https://y">out</a>';
		const out = buildSrcdoc(doc, DOC_URI);
		expect(out, 'コメントは丸ごと逐語のまま').toContain('<!-- a --! <a href="x">in</a> -->');
		const anchors = anchorTags(out);
		expect(anchors).toHaveLength(2);
		expectUntouched(anchors[0], 'x');
		expectRetargeted(anchors[1], 'https://y');
		expect(restored(out)).toBe(doc);
	});
});

describe('buildSrcdoc — 生の文字として読む要素(要件#8 追補a・AC-8-追a (c))', () => {
	/** 要素の後ろに置く本物のリンク(終わりのタグで生の文字が終わることの判定材料) */
	const AFTER_LINK = '<a href="https://y">after</a>';

	/**
	 * `rawText`(開きタグ〜終わりのタグ)の中の <a href="x"> は書き換えず、
	 * 終わりのタグの後ろの <a href> は退避される。原文は逐語復元できる
	 */
	function expectRawTextUntouched(rawText: string): void {
		const doc = rawText + AFTER_LINK;
		const out = buildSrcdoc(doc, DOC_URI);
		expect(out, '要素の中は逐語のまま').toContain(rawText);
		const anchors = anchorTags(out);
		expect(anchors, `<a> は中の1つと後ろの1つ: ${out}`).toHaveLength(2);
		expectUntouched(anchors[0], 'x');
		expectRetargeted(anchors[1], 'https://y');
		expect(restored(out)).toBe(doc);
	}

	test('AC-8-追a (c)-1: <xmp> の中の <a href> は書き換えない(終わりのタグの後ろは退避)', () => {
		expectRawTextUntouched('<xmp><a href="x">t</a></xmp>');
	});

	test('AC-8-追a (c)-2: <iframe> の中の <a href> は書き換えない(終わりのタグの後ろは退避)', () => {
		expectRawTextUntouched('<iframe><a href="x"></iframe>');
	});

	test('AC-8-追a (c)-3: <noembed> の中の <a href> は書き換えない(終わりのタグの後ろは退避)', () => {
		expectRawTextUntouched('<noembed><a href="x">t</a></noembed>');
	});

	test('AC-8-追a (c)-4: <noframes> の中の <a href> は書き換えない(終わりのタグの後ろは退避)', () => {
		expectRawTextUntouched('<noframes><a href="x">t</a></noframes>');
	});

	test('AC-8-追a (c)-5: <plaintext> の後ろは文書の終わりまで書き換えない(</plaintext> も効かない・手前のリンクは退避)', () => {
		const before = '<p><a href="https://before">before</a></p>';
		const tail = '<plaintext><a href="x">t</a></plaintext><a href="https://y">after</a>';
		const doc = before + tail;
		const out = buildSrcdoc(doc, DOC_URI);
		expect(out, '<plaintext> から文書の終わりまで逐語のまま').toContain(tail);
		expect(out.endsWith(tail), '文書の終わりが生の文字のまま').toBe(true);
		const anchors = anchorTags(out);
		expect(anchors).toHaveLength(3);
		expectRetargeted(anchors[0], 'https://before');
		expectUntouched(anchors[1], 'x');
		expectUntouched(anchors[2], 'https://y');
		expect(restored(out)).toBe(doc);
	});
});
