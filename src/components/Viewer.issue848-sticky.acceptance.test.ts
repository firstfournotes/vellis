/**
 * Issue #848 (1) — 重なりの帯・削除の帯・取り込みの知らせをツールバーの直下に固定する(由谷の決定 2026-11-26)。
 * `src/components/Viewer.svelte` の `<style>` のソース走査(unit プロジェクト・AC-74-42 の CodeEditor の CSS と同じ流儀)。
 *
 * ## 契約(implementer はこれに従う)
 *
 * ```css
 * /* Viewer.svelte の <style>。`.external-change`(重なりの帯 external-conflict-banner・削除の帯 external-removed-banner)と
 *    `.merged-notice`(取り込みの知らせ external-merged-notice)はどのスクロール位置でも見えている: *\/
 * .external-change { position: sticky; top: <Viewer のカスタムプロパティ var(--vellis-…) から求める式>; z-index: <1 以上>; … }
 * .merged-notice   { position: sticky; top: <同じ>; z-index: <1 以上>; … }
 * /* `top` = ツールバーの直下。検索バーが開いている間はその下(検索バーの `--vellis-find-bar-top` と同じ仕組み=Viewer が実寸を
 *    カスタムプロパティに入れる。名前は実装裁量。どこに来るかは Viewer.issue848-sticky.wiring.test.ts が値で見る)。
 *    本文の上端(帯の高さ分)に重なるのは受け入れる(由谷 2026-11-26)。 *\/
 * ```
 * - `.external-change` の直前の CSS コメント(要件#48 契約⑥「本文の上に重ねない … 本文と一緒にスクロールして退く」)は
 *   この判断に書き換える(Issue #848 を記す)。`.merged-notice` のコメントも「本文の上に重ねない」と言わない。
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - `top` の式の形・カスタムプロパティの名前・px の値は固定しない(契約は「ツールバーの直下・検索バーの下」だけ)。ここでは
 *   「sticky である・top が Viewer のカスタムプロパティ(`--vellis-*`)から決まる・z-index がある」まで。どこに来るかは DOM のテスト。
 * - `.merged-notice` は `markdown-too-large-notice`(閾値超えの知らせ)も使う class なので、そちらも貼り付く(同じ場所の知らせなので受け入れる)。
 * - 検索バー(FindBar.svelte)の CSS は変えない前提(契約は「同じ仕組みで積む」)。ここでは見ない。
 *
 * ## 修正前に赤になる理由
 * - `.external-change` / `.merged-notice` に `position` / `top` / `z-index` の宣言が無い。コメントは「本文と一緒にスクロールして退く」のまま。
 */
import { describe, expect, it } from 'vitest';
import { commentBefore, componentSource, declarationsOf, rulesFor, styleOf } from './viewer-sticky.testkit';

const css = () => styleOf(componentSource('src/components/Viewer.svelte'));
const BANNERS = ['.external-change', '.merged-notice'] as const;

describe('Issue #848 (1): 帯と知らせは Viewer.svelte の <style> で sticky(ツールバーの直下に貼り付く)', () => {
	it('前提: Viewer.svelte の <style> に .external-change と .merged-notice の規則があり、ツールバーは sticky・top: 0 のまま', () => {
		const style = css();
		for (const sel of BANNERS) expect(rulesFor(style, sel).length, `${sel} の規則`).toBeGreaterThan(0);
		const toolbar = declarationsOf(style, '.viewer-toolbar');
		expect(toolbar.get('position')).toBe('sticky');
		expect(toolbar.get('top')).toBe('0');
	});

	for (const sel of BANNERS) {
		it(`${sel}: position: sticky`, () => {
			expect(declarationsOf(css(), sel).get('position')).toBe('sticky');
		});

		it(`${sel}: top は Viewer のカスタムプロパティ(var(--vellis-…))から決まる(固定の 0 ではない)`, () => {
			const top = declarationsOf(css(), sel).get('top');
			expect(top, `${sel} に top の宣言`).toBeDefined();
			expect(top!).toMatch(/var\(\s*--vellis-[a-z0-9-]+/);
		});

		it(`${sel}: z-index があり 1 以上(本文の文字の上に載る)`, () => {
			const z = declarationsOf(css(), sel).get('z-index');
			expect(z, `${sel} に z-index の宣言`).toBeDefined();
			expect(Number(z)).toBeGreaterThanOrEqual(1);
		});

		it(`${sel}: 直前の CSS コメントが「本文の上に重ねない」「本文と一緒にスクロール(して退く)」と言わない`, () => {
			const comment = commentBefore(css(), sel);
			expect(comment, `${sel} の直前にコメント(判断の記録)がある`).not.toBeNull();
			expect(comment!).not.toMatch(/重ねない/);
			expect(comment!).not.toMatch(/一緒にスクロール/);
		});
	}

	it('.external-change の直前の CSS コメントが Issue #848(帯を貼り付ける判断)を記す', () => {
		const comment = commentBefore(css(), '.external-change');
		expect(comment).not.toBeNull();
		expect(comment!).toMatch(/848/);
	});
});
