/**
 * 要件#74 第1段の由谷決定 4(2026-11-16)・第2段 2-3 F16 — CodeMirror の面(コードの面と raw)の検索で、`toLowerCase` で
 * 長さが変わる文字(`İ` U+0130 → `i̇` 2 文字)の後ろでも一致の位置が元の文字列を指す(`cm-find.ts` の `matchesIn`)。
 *
 * 契約(第1段で固定済み): `matchesIn(text, query): MatchRange[]` は `findMatches`(要件54・大文字小文字を畳む)の一致を
 * 元の文字列の位置へ写し直す。畳みで長さが変わらない文書では `findMatches` と同じ。
 *
 * ## 修正前に赤になる理由
 * - このファイルは 2-3 の P3 の穴締め(F16)。`matchesIn` は第1段で既にあるので、ここは後追いの固定(緑の見込み)。
 *   面の側(両方の面で装飾の位置が正しい)は CodeEditor.wiring / RawSource.wiring の F16 が見る
 */
import { describe, expect, test } from 'vitest';
import { findMatches } from '$lib/find-in-document';
import { matchesIn } from './cm-find';

const I_DOT = 'İ'; // U+0130。toLowerCase() → 'i̇'(2 文字)
const SS = 'ß'; // toLowerCase は 1 文字のまま(toUpperCase で伸びる)

describe('F16: matchesIn は畳みで長さが変わる文字の後ろでも元の位置を指す', () => {
	test(`${I_DOT} が 1 つ前にある`, () => {
		const text = `${I_DOT}stanbul needle\n`;
		expect(text.toLowerCase().length).toBe(text.length + 1);
		const found = matchesIn(text, 'needle');
		expect(found).toHaveLength(1);
		expect(text.slice(found[0]!.start, found[0]!.end)).toBe('needle');
		// 素の findMatches は畳んだ文字列の位置なので 1 ずれる(=写し直しが要る理由)
		const naive = findMatches(text, 'needle');
		expect(naive[0]!.start).toBe(found[0]!.start + 1);
	});

	test(`${I_DOT} が複数(行をまたいで)ある・一致が複数`, () => {
		const text = `${I_DOT}${I_DOT} needle ${I_DOT}\nplain needle\n${I_DOT}x Needle end\n`;
		const found = matchesIn(text, 'needle');
		expect(found).toHaveLength(3);
		for (const r of found) expect(text.slice(r.start, r.end).toLowerCase()).toBe('needle');
		expect(found.map((r) => r.start)).toEqual([text.indexOf('needle'), text.indexOf('plain needle') + 6, text.indexOf('Needle')]);
	});

	test(`語そのものに ${I_DOT} が入る(一致の長さが元の文字列で数えられる)`, () => {
		const text = `go ${I_DOT}stanbul and istanbul\n`;
		const found = matchesIn(text, `${I_DOT}stanbul`);
		expect(found.length).toBeGreaterThanOrEqual(1);
		expect(text.slice(found[0]!.start, found[0]!.end)).toBe(`${I_DOT}stanbul`);
		for (const r of found) expect(r.end - r.start).toBeLessThanOrEqual(`${I_DOT}stanbul`.length + 1);
	});

	test('サロゲート対(絵文字)と İ が混じる', () => {
		const text = `😀 ${I_DOT} needle 😀😀 needle\n`;
		const found = matchesIn(text, 'needle');
		expect(found).toHaveLength(2);
		for (const r of found) expect(text.slice(r.start, r.end)).toBe('needle');
	});

	test(`長さが変わらない文書(${SS}・日本語)では findMatches と同じ`, () => {
		const text = `stra${SS}e needle 日本語 needle\n`;
		expect(matchesIn(text, 'needle')).toEqual(findMatches(text, 'needle'));
		expect(matchesIn(text, 'zzz')).toEqual([]);
	});
});
