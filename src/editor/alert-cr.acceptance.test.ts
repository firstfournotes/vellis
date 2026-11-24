/**
 * 要件#74 第2段 2-6 — CR だけの文書のアラート(契約15・由谷の決定 2026-11-17 朝 (1): 閲覧側 `src/markdown/plugins/alert.ts` も直して
 * 閲覧・印刷・編集面をそろえる。AC-56-17 の alert.ts の SHA 1 本の更新=要件側更新の承認済み)。
 *
 * ## 確定契約(implementer はこれに従う)
 * - `src/markdown/plugins/alert.ts` の印の行の判定(`MARKER`)は、`[!TYPE]`(+行末の空白)の後が `\r\n` / `\r` / `\n` のどれでも、
 *   または文の終わりでも効く。同じ行に本文が続けばアラートでない(GitHub と同じ)。印の行を剥がすとき、改行の綴り(`\r` / `\r\n`)も一緒に剥がす
 * - 編集面(`src/editor/from-mdast.ts`)の特別扱い `recognizeCrOnlyAlerts` / `CR_MARKER` は要らなくなるので消す(閲覧の plugin が CR を
 *   読むので、読み込みでも同じ remark の道で alert になる)。書き出しは契約6 の 1 段目=触らなければ byte 等価
 * - AC-56-17(`src/lib/ui-invariants.acceptance.test.ts` の `MARKDOWN_TREE_SHA['src/markdown/plugins/alert.ts']`)は実装の後に
 *   test-writer が今の値に更新する(要件側更新・承認済み)。alert.ts 以外の `src/markdown/**` は触らない
 *
 * ## 修正前に赤になる理由
 * - 閲覧の `MARKER` は `\n` か文末しか見ないので、CR だけ(と、印の行が `\r\n` で終わる CRLF)の文書で alert にならない。
 *   `from-mdast.ts` に `recognizeCrOnlyAlerts` が残っている
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { render } from '../markdown/renderer';
import { createMarkdownDocument, markdownText } from './markdown-document';
import { blockNames } from './markdown.testkit';

const URI = 'file:///Users/a/notes/alert.md';
const KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
const EOLS: Array<[string, string]> = [
	['LF', '\n'],
	['CRLF', '\r\n'],
	['CR', '\r'],
];

function alertDoc(kind: string, eol: string, marker = `[!${kind.toUpperCase()}]`): string {
	return `> ${marker}${eol}> first line of the body${eol}> second line${eol}${eol}After the alert.${eol}`;
}
function parse(html: string): HTMLElement {
	const root = document.createElement('div');
	root.innerHTML = html;
	return root;
}

describe('閲覧(render)の alert.ts: 印の行が \\r\\n / \\r / \\n のどれで終わっても alert になる(閲覧・印刷がそろう)', () => {
	for (const kind of KINDS) {
		for (const [label, eol] of EOLS) {
			test(`${kind} / ${label}`, async () => {
				const root = parse((await render(alertDoc(kind, eol), URI)).html);
				const bq = root.querySelector(`blockquote.markdown-alert.markdown-alert-${kind}`);
				expect(bq, 'blockquote.markdown-alert').not.toBeNull();
				const title = bq!.querySelector('.markdown-alert-title');
				expect(title?.textContent?.trim()).toBe(kind[0]!.toUpperCase() + kind.slice(1));
				const body = bq!.textContent ?? '';
				expect(body).toContain('first line of the body');
				expect(body).toContain('second line');
				expect(body, '印は本文に残らない').not.toContain('[!');
				expect(body, '改行の綴りが本文に残らない').not.toMatch(/\r/);
			});
		}
	}

	test('印の行の後ろに空白があっても(`[!TIP]  ` + CR)alert になり、本文の先頭に空白も改行の綴りも残らない', async () => {
		const root = parse((await render(alertDoc('tip', '\r', '[!TIP]  '), URI)).html);
		const bq = root.querySelector('blockquote.markdown-alert.markdown-alert-tip');
		expect(bq).not.toBeNull();
		const firstP = bq!.querySelector('p:not(.markdown-alert-title)');
		expect(firstP?.textContent?.replace(/\s+/g, ' ').trim()).toBe('first line of the body second line');
	});

	test('同じ行に本文が続けばアラートでない(どの改行でも・GitHub と同じ)', async () => {
		for (const [, eol] of EOLS) {
			const src = `> [!NOTE] not an alert${eol}> more${eol}`;
			const root = parse((await render(src, URI)).html);
			expect(root.querySelector('blockquote.markdown-alert')).toBeNull();
			expect(root.querySelector('blockquote')?.textContent).toContain('[!NOTE] not an alert');
		}
	});

	test('CR だけの文書でも、印だけの引用(本文なし)は alert になり中身は表題だけ', async () => {
		const root = parse((await render('> [!WARNING]\r\rNext.\r', URI)).html);
		const bq = root.querySelector('blockquote.markdown-alert.markdown-alert-warning');
		expect(bq).not.toBeNull();
		expect(bq!.textContent?.replace(/\s+/g, ' ').trim()).toBe('Warning');
	});

	test('混在の文書(印の行は CR・本文は LF)でも alert', async () => {
		const root = parse((await render('> [!IMPORTANT]\r> body\n\nAfter.\n', URI)).html);
		expect(root.querySelector('blockquote.markdown-alert.markdown-alert-important')).not.toBeNull();
	});

	test('LF の文書の描画は今のまま(退行なし): 表題の class と本文', async () => {
		const root = parse((await render('> [!NOTE]\n> Hello **there**.\n', URI)).html);
		const bq = root.querySelector('blockquote.markdown-alert.markdown-alert-note')!;
		expect(bq.querySelector('.markdown-alert-title')?.textContent).toBe('Note');
		expect(bq.querySelector('strong')?.textContent).toBe('there');
	});
});

describe('編集面(from-mdast)は閲覧と同じ道で alert を読む(特別扱いが要らない)', () => {
	for (const [label, eol] of EOLS) {
		test(`${label}: alert ノード(kind)になり、触らなければ書き出しは byte 等価`, () => {
			const src = alertDoc('caution', eol);
			const m = createMarkdownDocument(src, { uri: URI, readOnly: false });
			expect(blockNames(m.state.doc)[0]).toBe('alert');
			expect(m.state.doc.child(0).attrs.kind).toBe('caution');
			expect(m.state.doc.child(0).textContent).not.toContain('[!');
			expect(m.state.doc.child(0).textContent).not.toMatch(/\r/);
			expect(markdownText(m)).toBe(src);
		});
	}

	test('from-mdast.ts に CR だけの特別扱い(recognizeCrOnlyAlerts / CR_MARKER)が残っていない(閲覧の plugin が CR を読む)', () => {
		const src = readFileSync(resolve(__dirname, 'from-mdast.ts'), 'utf8');
		expect(src).not.toContain('recognizeCrOnlyAlerts');
		expect(src).not.toContain('CR_MARKER');
	});

	test('閲覧の alert.ts の MARKER は 3 種の改行を受ける(ソース走査: `\\r` を見る)', () => {
		const src = readFileSync(resolve(__dirname, '../markdown/plugins/alert.ts'), 'utf8');
		const marker = /const MARKER = (\/.*\/[a-z]*);/.exec(src)?.[1] ?? '';
		expect(marker, 'MARKER の正規表現').not.toBe('');
		expect(marker).toMatch(/\\r/);
	});
});
