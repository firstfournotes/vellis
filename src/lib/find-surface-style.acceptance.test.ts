/**
 * 要件#54 追補b の受け入れテスト(docs/requirements/req-54.md「追補b」)— 純関数側(unit)
 *
 * 人間ゲート④の NG(backlog 178)=「html 文書で ⌘F を押すと複製面の見た目が閲覧
 * (iframe)と変わる」の機械判定できる範囲を固定する。原因は2つ:
 *
 * 1. 文書 `<head>` の `<style>` を複製面(Shadow DOM)へそのまま移しても、
 *    `body{…}` / `html{…}` / `:root{…}` の規則が**何にも当たらない**
 *    (Shadow の中に body は無く、中身は `div.vellis-html-find-root` の下にある)
 * 2. アプリ側の継承プロパティ(font-family=sans 等)が Shadow DOM へ流れ込み、
 *    iframe の UA 既定(serif・16px・黒字白地・body margin 8px)と違って見える
 *
 * ## 実装側に求める形(implementer はこれに従う。API 契約=本テストが決める)
 *
 * ```ts
 * // src/lib/find-surface-style.ts(新規・純関数・依存追加ゼロ)
 *
 * // 複製面のルート要素のセレクタ。Viewer.svelte が複製面ルートに付けている
 * // class(vellis-html-find-root)と対
 * export const FIND_SURFACE_ROOT_SELECTOR = '.vellis-html-find-root';
 *
 * // 複製面のルートに当てる基底 CSS(iframe の UA 既定の再現)。要点:
 * // - `all: initial` で**アプリ側からの継承を遮断**する(宣言順は all が先。
 * //   後に置くと serif 等の宣言が消される)
 * // - その上で `display: block`・`font-family: serif`・`font-size: 16px`・
 * //   `color: #000000`・`background-color: #ffffff`・`margin: 8px`(body の UA 既定)
 * // - `p` / `h1` 等の UA 既定余白は **UA に任せる**(基底 CSS では触らない)
 * export const FIND_SURFACE_BASE_CSS: string;
 *
 * // 文書 <style> のテキストを複製面用に書き換える。**セレクタだけ**を触り、
 * // 宣言(値)と規則の並び順は無傷で通す:
 * // - 素の要素セレクタ `body` / `html` / 擬似クラス `:root` → FIND_SURFACE_ROOT_SELECTOR
 * // - `html body`(両方ルートに写る組)→ ルートセレクタ**1つ**に潰す
 * // - `body > .box` / `body .content` / `body.dark` → ルートセレクタを頭にした形
 * // - `,` 区切りの各セレクタ・`@media {…}` の中も同様
 * // - `body` を**含むだけ**の語(`tbody` / `.tbody` / `#nobody` / `.body`)は触らない
 * export function rewriteSurfaceCss(css: string): string;
 * ```
 *
 * 配線(Shadow DOM への挿入と順序)は src/components/Viewer.findfix.wiring.test.ts。
 * 見た目の最終確認は人間ゲート(acceptance.md 要件#54 ④の再確認)。
 *
 * ## JSDOM 上の注意
 * JSDOM の getComputedStyle は Shadow DOM 越しのカスケードを計算しないため、
 * **文字列(CSS テキスト)の契約**として判定する。空白の揺れで落ちないよう、
 * 比較は `norm()`(空白の正規化)を通す。
 */
import { describe, expect, test } from 'vitest';
import {
	FIND_SURFACE_BASE_CSS,
	FIND_SURFACE_ROOT_SELECTOR,
	rewriteSurfaceCss,
} from './find-surface-style';

/** CSS テキストの空白を正規化する(契約は字面ではなく構造)。 */
function norm(css: string): string {
	return css
		.replace(/\s+/g, ' ')
		.replace(/\s*([{}:;,>])\s*/g, '$1')
		.trim();
}

/** 書き換えの期待を `norm` 同士で比べる。 */
function expectRewrite(input: string, expected: string) {
	expect(norm(rewriteSurfaceCss(input))).toBe(norm(expected));
}

const ROOT = '.vellis-html-find-root';

describe('AC-54b-1 — body / html / :root の単独セレクタがルートへ写る(追補b)', () => {
	test('FIND_SURFACE_ROOT_SELECTOR は Viewer の複製面ルートの class と対', () => {
		expect(FIND_SURFACE_ROOT_SELECTOR).toBe(ROOT);
	});

	test('body 単独', () => {
		expectRewrite(
			'body{max-width:40em;margin:2em auto;font-family:serif}',
			ROOT + '{max-width:40em;margin:2em auto;font-family:serif}',
		);
	});

	test('html 単独', () => {
		expectRewrite('html{font-size:18px}', ROOT + '{font-size:18px}');
	});

	test(':root 単独(カスタムプロパティの置き場)', () => {
		expectRewrite(':root{--accent:#f00}', ROOT + '{--accent:#f00}');
	});
});

describe('AC-54b-2 — 複合セレクタ(追補b)', () => {
	test('html body はルートセレクタ1つに潰れる(.root .root にしない)', () => {
		expectRewrite('html body{color:#333}', ROOT + '{color:#333}');
	});

	test('body > .box は子結合子ごとルートを頭に', () => {
		expectRewrite('body > .box{padding:1em}', ROOT + ' > .box{padding:1em}');
	});

	test('body .content は子孫結合子ごとルートを頭に', () => {
		expectRewrite('body .content{line-height:1.8}', ROOT + ' .content{line-height:1.8}');
	});

	test('body.dark はクラスをルートに引き継ぐ', () => {
		expectRewrite('body.dark{background:#111}', ROOT + '.dark{background:#111}');
	});
});

describe('AC-54b-3 — , 区切りと @media の中(追補b)', () => {
	test(', 区切りの各セレクタを独立に書き換える(他は無傷)', () => {
		expectRewrite('h1, body, .note{margin-top:0}', 'h1,' + ROOT + ',.note{margin-top:0}');
	});

	test('@media の中の body も書き換わる(同居する他の規則は無傷)', () => {
		expectRewrite(
			'@media (min-width:600px){body{margin:1em}h1{font-size:2em}}',
			'@media (min-width:600px){' + ROOT + '{margin:1em}h1{font-size:2em}}',
		);
	});
});

describe('AC-54b-4 — 他のセレクタは無傷・body を含む語は誤変換しない(追補b)', () => {
	test('p / tbody / .tbody / #nobody / .body は触らず、規則の並びも保たれる', () => {
		const untouched = [
			'p{margin:1em 0}',
			'.tbody{color:red}',
			'#nobody{color:blue}',
			'tbody{border-collapse:collapse}',
			'.body{padding:0}',
		];
		const input = [...untouched, 'body{margin:2em auto}'].join('\n');
		const expected = [...untouched, ROOT + '{margin:2em auto}'].join('\n');
		expectRewrite(input, expected);
	});

	test('body の規則が無ければ全体が無傷で通る', () => {
		const css = 'h2{color:#222}\n.card{border:1px solid #ddd}';
		expectRewrite(css, css);
	});
});

describe('AC-54b-5 — 基底 CSS=iframe の UA 既定の再現(追補b)', () => {
	const base = norm(FIND_SURFACE_BASE_CSS);

	test('ルートセレクタへの規則である', () => {
		expect(base).toContain(ROOT + '{');
	});

	test('all:initial で継承を遮断し、serif 16px 黒字白地・body 既定 margin 8px を宣言する', () => {
		const required = [
			'all:initial',
			'display:block',
			'font-family:serif',
			'font-size:16px',
			'color:#000000',
			'background-color:#ffffff',
			'margin:8px',
		];
		for (const decl of required) {
			expect(base, decl + ' が基底 CSS にあること').toContain(decl);
		}
		// all:initial は他の宣言より**前**(後に置くと serif 等が消される)。
		const allAt = base.indexOf('all:initial');
		for (const decl of required.slice(1)) {
			expect(allAt, 'all:initial は ' + decl + ' より前にあること').toBeLessThan(
				base.indexOf(decl),
			);
		}
	});

	test('p / h1 等の UA 既定余白には触らない(UA に任せる)', () => {
		expect(base).not.toMatch(/(^|[{};,])(p|h1|h2|h3|h4|h5|h6|ul|ol|li|blockquote)\{/);
	});
});
