/**
 * Issue #851 (6) — 2 MiB 超の読み取り専用の知らせ(`markdown-too-large-notice`)は貼り付かない(ソース走査・unit プロジェクト)。
 *
 * Issue #848 で `.merged-notice` を sticky にしたとき、同じ class を共有するこの知らせも貼り付いた(#848 の判断の記録で
 * 「受け入れる」と書いた)。#851 で由谷が「小さな指摘も対応」=元に戻す: 本文と一緒にスクロールする(#848 の前のとおり)。
 *
 * ## 契約(implementer はこれに従う)
 * - `Viewer.svelte` のテンプレートで `data-testid="markdown-too-large-notice"` の要素の class(専用の class か、
 *   `.merged-notice` + 修飾 class)を `<style>` の規則で重ねると、`position` は sticky でない
 * - `.merged-notice` 自身(取り込みの知らせ `external-merged-notice`)は sticky のまま(Viewer.issue848-sticky.acceptance.test.ts)
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - 作りは固定しない(`class="too-large-notice"` でも `class="merged-notice merged-notice--static"` でも通る)。重ね方は
 *   class だけのセレクタを詳細度(class の数)と書かれた順で重ねる(viewer-sticky-stack.testkit.ts の `cascadedDeclarations`)。
 *   DOM に載せた側は Viewer.issue851-stack.wiring.test.ts の T1 / T2
 * - `class:name` の指令は拾わない(静的な class 属性で書く前提。使うなら wiring の T1 が実物の classList で見る)
 *
 * ## 修正前に赤になる理由
 * - 知らせの class が `merged-notice` だけで、`.merged-notice { position: sticky }` が当たる
 */
import { describe, expect, it } from 'vitest';
import { componentSource, styleOf } from './viewer-sticky.testkit';
import { cascadedDeclarations, templateClassOf } from './viewer-sticky-stack.testkit';

const SOURCE = componentSource('src/components/Viewer.svelte');
const CSS = styleOf(SOURCE);

describe('Issue #851 (6): 閾値超えの知らせは貼り付かない(Viewer.svelte のソース走査)', () => {
	it('markdown-too-large-notice の class を <style> で重ねると position は sticky でない', () => {
		const classes = templateClassOf(SOURCE, 'markdown-too-large-notice');
		expect(classes.length, '知らせに class がある').toBeGreaterThan(0);
		const decl = cascadedDeclarations(CSS, classes);
		expect(decl.get('position'), `class=${JSON.stringify(classes)} の position`).not.toBe('sticky');
	});

	it('external-merged-notice(取り込みの知らせ)の class を重ねると position は sticky のまま(Issue #848)', () => {
		const classes = templateClassOf(SOURCE, 'external-merged-notice');
		expect(classes).toContain('merged-notice');
		expect(cascadedDeclarations(CSS, classes).get('position')).toBe('sticky');
	});

	it('2 つの知らせは同じ class の集合ではない(片方だけ貼り付くには見た目の規則が分かれている)', () => {
		const tooLarge = [...templateClassOf(SOURCE, 'markdown-too-large-notice')].sort();
		const merged = [...templateClassOf(SOURCE, 'external-merged-notice')].sort();
		expect(tooLarge).not.toEqual(merged);
	});
});
