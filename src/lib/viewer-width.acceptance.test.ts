/**
 * 要件#20 の受け入れテスト(requirements.md #20)— 要件#56 契約 4 による仕様置き換え後の契約
 *
 * 旧契約(2026-08-17 由谷決定=案A「ウィンドウ幅追従・固定上限を設けない」)は、要件#56(UI の作り直し)
 * 契約 4(2026-11-02 由谷決定)で **「本文の行長に上限 72ch(`--doc-measure`)を設け、View ▸ Toggle Full Width で
 * 幅いっぱい(要件#20 の見え方)に切り替えられる」** に置き換わった。本ファイルは要件側更新
 * (req-56.md 棚卸し 2 で事前承認)として、判定を新契約へ書き換えたもの。過去行の書き換えはしない=
 * 要件#56 契約 4 の本行が正。
 *
 * 新契約(要件#56 契約 4・起案時判断 (f)(g)):
 * (a) `.markdown-body` 単体のブロック(本文の面)には `max-width` を置かない。上限は**地の文のブロック**
 *     (`.markdown-body` 直下の p / h1〜h6 / ul / ol / blockquote / dl / hr)に `max-width: var(--doc-measure)` で
 *     当てる。表・pre・画像だけの段落は幅いっぱい。地の文の当て方の詳細は要件#56 の
 *     `design-tokens.acceptance.test.ts`(AC-56-7)が判定する
 * (a') `.markdown-body` 単体のブロックに width / max-inline-size 等の固定幅の再導入もない(100% / auto は可)
 * (b) **幅いっぱいの状態**(`<html data-doc-measure="full">`=判断 (g))では、地の文のブロックの `max-width` が
 *     `none` に戻り、要件#20 の「ウィンドウ幅追従・固定上限なし」の見え方になる(どの上限も残らない)
 * (c) `.markdown-body` 単体のブロックの `padding` 宣言は維持されている(余白まで消えていない)。不変
 *
 * 判定方式: ソース検査型(markdown.css をテキストとして読み、機械判定する)。
 *
 * ## 範囲の注記
 * - `.markdown-body img` や `.markdown-body table` などの子要素セレクタが持つ `max-width: 100%`
 *   (はみ出し防止)は本要件の対象外。(a)(a')(c) の検査はセレクタが `.markdown-body` 単体のブロックに限る。
 * - `@media print` スコープ(印刷用は src/styles/print.css 側)は検査対象にしない。
 *   markdown.css 内に @media print が現れた場合もその中身は除外する。
 * - プレーンテキスト表示(`.markdown-body` を共有)も同じ切替に従う(要件#56 契約 4)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const MARKDOWN_CSS_PATH = resolve(REPO_ROOT, 'src/styles/markdown.css');

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** @media print { … } スコープを(ネストした括弧ごと)取り除く。 */
function stripPrintMedia(css: string): string {
	let out = '';
	let i = 0;
	while (i < css.length) {
		const m = css.slice(i).match(/@media[^{]*\bprint\b[^{]*\{/);
		if (!m || m.index === undefined) {
			out += css.slice(i);
			break;
		}
		out += css.slice(i, i + m.index);
		let depth = 1;
		let j = i + m.index + m[0].length;
		while (j < css.length && depth > 0) {
			if (css[j] === '{') depth += 1;
			else if (css[j] === '}') depth -= 1;
			j += 1;
		}
		i = j;
	}
	return out;
}

type Decl = { prop: string; value: string };

function declarationsOf(css: string): Decl[] {
	const out: Decl[] = [];
	const re = /([-\w]+)\s*:\s*([^{};]+)(?=[;}])/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) {
		out.push({ prop: m[1], value: m[2].trim() });
	}
	return out;
}

function markdownCss(): string {
	return stripPrintMedia(stripCssComments(readFileSync(MARKDOWN_CSS_PATH, 'utf8')));
}

/**
 * セレクタが `.markdown-body` 単体のブロック本文を全部集めて返す
 * (`.markdown-body h1` などの子孫セレクタは一致しない)。
 */
function markdownBodyBaseDecls(): Decl[] {
	const bodies = [...markdownCss().matchAll(/(?:^|[}{;])\s*\.markdown-body\s*\{([^}]*)\}/g)].map(
		(m) => m[1],
	);
	expect(bodies.length, '.markdown-body 単体セレクタのブロックがあること').toBeGreaterThan(0);
	return declarationsOf(bodies.join('\n'));
}

/** `{ selector, body }` の列(at-rule の入れ子は使っていない前提。@media print は除去済み)。 */
function rules(): Array<{ selector: string; decls: Decl[] }> {
	const css = markdownCss();
	const out: Array<{ selector: string; decls: Decl[] }> = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) {
		const selector = m[1].replace(/\s+/g, ' ').trim();
		if (selector.startsWith('@')) continue;
		out.push({ selector, decls: declarationsOf(m[2]) });
	}
	return out;
}

/** `[data-doc-measure="full"]` を前置したセレクタか(幅いっぱいの状態)。 */
function isFullWidthSelector(selector: string): boolean {
	return /\[data-doc-measure\s*=\s*["']?full["']?\s*\]/.test(selector);
}

describe('要件#20(要件#56 契約 4 で置き換え): 本文の行長は 72ch 上限、Toggle Full Width でウィンドウ幅追従に戻る', () => {
	test('(a) .markdown-body ベースブロックに max-width 宣言がない(上限は地の文のブロックに --doc-measure で当てる)', () => {
		const offenders = markdownBodyBaseDecls()
			.filter((d) => d.prop.toLowerCase() === 'max-width')
			.map((d) => `${d.prop}: ${d.value}`);
		expect(offenders, '.markdown-body 自体に置かれた幅上限宣言').toEqual([]);

		const measured = rules().filter(
			(r) => !isFullWidthSelector(r.selector) && r.decls.some((d) => d.prop === 'max-width' && /var\(\s*--doc-measure\b/.test(d.value)),
		);
		expect(measured.length, '地の文のブロックに max-width: var(--doc-measure) があること(要件#56 契約 4)').toBeGreaterThan(0);
	});

	test("(a') width / max-inline-size 等による固定幅上限の再導入もない", () => {
		const WIDTH_PROPS = new Set(['width', 'max-inline-size', 'inline-size']);
		const offenders = markdownBodyBaseDecls()
			.filter((d) => WIDTH_PROPS.has(d.prop.toLowerCase()))
			// 100% / auto はウィンドウ幅追従なので許容(px/rem 等の固定値が違反)
			.filter((d) => !/^(100%|auto)$/i.test(d.value))
			.map((d) => `${d.prop}: ${d.value}`);
		expect(offenders, '.markdown-body に残る固定幅系宣言').toEqual([]);
	});

	test('(b) 幅いっぱいの状態([data-doc-measure="full"])では地の文の max-width が none に戻り、要件#20 の見え方(固定上限なし)になる', () => {
		const full = rules().filter((r) => isFullWidthSelector(r.selector));
		expect(full.length, '[data-doc-measure="full"] を前置した規則があること(View ▸ Toggle Full Width)').toBeGreaterThan(0);
		const widths = full.flatMap((r) => r.decls.filter((d) => d.prop === 'max-width').map((d) => `${r.selector} { max-width: ${d.value} }`));
		expect(widths.length, '幅いっぱいの規則が max-width を扱うこと').toBeGreaterThan(0);
		const notNone = widths.filter((w) => !/max-width: none \}$/.test(w));
		expect(notNone, '幅いっぱいなのに残る上限').toEqual([]);
		// 幅いっぱいの規則には --doc-measure を参照する宣言が無い(上限が残らない)
		const leaked = full.flatMap((r) => r.decls.filter((d) => /var\(\s*--doc-measure\b/.test(d.value))).map((d) => `${d.prop}: ${d.value}`);
		expect(leaked, '幅いっぱいの規則に残った --doc-measure 参照').toEqual([]);
	});

	test('(c) padding 宣言は維持されている(余白まで消えていない)', () => {
		const paddings = markdownBodyBaseDecls().filter((d) =>
			/^padding(-\w+)?$/i.test(d.prop),
		);
		expect(paddings.length, '.markdown-body に padding 宣言があること').toBeGreaterThan(0);
	});
});
