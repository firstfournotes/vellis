/**
 * 要件#20 の受け入れテスト(requirements.md #20)
 * 「Markdown 本文(プレーンテキスト表示含む)の表示幅はウィンドウ幅に追従する
 *   (固定上限を設けない。行長の調整はユーザーがウィンドウ幅で行う)」
 *   =2026-08-17 由谷決定(案A=旧 max-width: 980px の撤廃)
 *
 * 契約:
 * (a) src/styles/markdown.css の `.markdown-body` ベース宣言ブロック
 *     (セレクタが `.markdown-body` 単体のブロック)に `max-width` 宣言がない
 *     (旧 980px 固定の再導入をブロックする)。
 * (b) 同ブロックに中央寄せの `margin: … auto …`(幅上限とセットだった名残)がない。
 * (c) 同ブロックの `padding` 宣言は維持されている(幅上限の撤廃で余白まで
 *     消えていないこと)。
 *
 * 判定方式: ソース検査型(markdown.css をテキストとして読み、機械判定する)。
 *
 * ## 範囲の注記
 * - `.markdown-body img` や `.markdown-body table` などの子要素セレクタが持つ
 *   `max-width: 100%`(はみ出し防止)は本要件の対象外。検査はセレクタが
 *   `.markdown-body` 単体のブロックに限る。
 * - `@media print` スコープ(印刷用は src/styles/print.css 側)は検査対象にしない。
 *   markdown.css 内に @media print が現れた場合もその中身は除外する。
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

/**
 * セレクタが `.markdown-body` 単体のブロック本文を全部集めて返す
 * (`.markdown-body h1` などの子孫セレクタは一致しない)。
 */
function markdownBodyBaseDecls(): Decl[] {
	const css = stripPrintMedia(stripCssComments(readFileSync(MARKDOWN_CSS_PATH, 'utf8')));
	const bodies = [...css.matchAll(/(?:^|[}{;])\s*\.markdown-body\s*\{([^}]*)\}/g)].map(
		(m) => m[1],
	);
	expect(bodies.length, '.markdown-body 単体セレクタのブロックがあること').toBeGreaterThan(0);
	return declarationsOf(bodies.join('\n'));
}

describe('要件#20: Markdown 本文の表示幅はウィンドウ幅に追従する(固定上限なし)', () => {
	test('(a) .markdown-body ベースブロックに max-width 宣言がない', () => {
		const offenders = markdownBodyBaseDecls()
			.filter((d) => d.prop.toLowerCase() === 'max-width')
			.map((d) => `${d.prop}: ${d.value}`);
		expect(offenders, '.markdown-body に残る幅上限宣言').toEqual([]);
	});

	test('(a\') width / max-inline-size 等による固定幅上限の再導入もない', () => {
		const WIDTH_PROPS = new Set(['width', 'max-inline-size', 'inline-size']);
		const offenders = markdownBodyBaseDecls()
			.filter((d) => WIDTH_PROPS.has(d.prop.toLowerCase()))
			// 100% / auto はウィンドウ幅追従なので許容(px/rem 等の固定値が違反)
			.filter((d) => !/^(100%|auto)$/i.test(d.value))
			.map((d) => `${d.prop}: ${d.value}`);
		expect(offenders, '.markdown-body に残る固定幅系宣言').toEqual([]);
	});

	test('(b) 中央寄せの margin: … auto …(幅上限の名残)がない', () => {
		const offenders = markdownBodyBaseDecls()
			.filter((d) => /^margin(-inline|-left|-right)?$/i.test(d.prop))
			.filter((d) => /\bauto\b/i.test(d.value))
			.map((d) => `${d.prop}: ${d.value}`);
		expect(offenders, '.markdown-body に残る中央寄せ margin 宣言').toEqual([]);
	});

	test('(c) padding 宣言は維持されている(余白まで消えていない)', () => {
		const paddings = markdownBodyBaseDecls().filter((d) =>
			/^padding(-\w+)?$/i.test(d.prop),
		);
		expect(paddings.length, '.markdown-body に padding 宣言があること').toBeGreaterThan(0);
	});
});
