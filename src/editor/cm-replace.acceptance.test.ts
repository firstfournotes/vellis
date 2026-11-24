/**
 * 要件#74 第3段 3-3 — 置換の純関数(契約5 の (x)・契約15・契約17・由谷の決定 2026-11-17 昼: 3-11=コードの面・plain text・raw だけ、
 * 3-12=Edit ▸ Find and Replace…(Option + Command + F)・置換の欄の Return=Replace・Replace All はボタンだけ・undo 1 段)。
 * 正本: docs/review/req74-stage34-prep.md の (A) 4 と (B) AC-74-28・AC-74-55。
 *
 * ## 対応する受け入れ基準
 * - AC-74-28 (1)〜(5)(8) の純関数の分: Replace は現在の一致だけを文字どおり替え、次の現在は替えた文字の終わり以降の最初の一致。
 *   Replace All は `matchesIn` の全部を取引 1 つ(undo 1 回で byte 等価)で替えて数を返す。替えなかった範囲は byte 等価(LF・CRLF・CR・混在・BOM)。
 *   件数は替えた後の `matchesIn` の数。語が空なら何もしない・置換の語が空なら一致を消す。読み取り専用では取引なし
 * - AC-74-55 のフロントの定数: `MENU_FIND_REPLACE_EVENT === 'menu_find_replace'`(`find-in-document.ts` は SHA 固定なので足さない)
 *
 * ## 確定契約(implementer はこれに従う=推奨名は stage34-prep の (A) 4)
 *
 * ```ts
 * // --- src/editor/cm-replace.ts(新規)
 * export const MENU_FIND_REPLACE_EVENT = 'menu_find_replace';
 * /** 現在の一致(ranges[current])を replacement の文字どおりに替える取引 1 つ。選択は替えた文字の後ろ(空)。userEvent 'input.replace'。
 *  *  ranges が空・current が範囲外・state.readOnly なら null。 *\/
 * export function replaceOne(state: EditorState, ranges: readonly MatchRange[], current: number, replacement: string): TransactionSpec | null;
 * /** 数え直した ranges のうち、替えた文字の終わり(replacedEnd)以降で最初の一致の番目。無ければ 0(先頭へ回る)。 *\/
 * export function nextCurrentAfter(ranges: readonly MatchRange[], replacedEnd: number): number;
 * /** matchesIn(文書, query) の全部を取引 1 つで replacement に替える。count=替えた数。query が空・一致なし・readOnly なら spec null・count 0。 *\/
 * export function replaceAll(state: EditorState, query: string, replacement: string): { spec: TransactionSpec | null; count: number };
 * // --- src/editor/file-editor.ts に足す(CodeMirror の面=コード・plain text・raw だけが持つ。Markdown の rendered・読み取り専用では undefined)
 * export interface FileEditorHandle { …;
 *   /** 今の語の現在の一致を replacement に替え、替えた文字の終わり以降の最初の一致を現在に。語が空・一致なしなら false。 *\/
 *   replaceCurrent?(replacement: string): boolean;
 *   /** 今の語の全部を取引 1 つで替える。返り値は替えた数。 *\/
 *   replaceAll?(replacement: string): number;
 * }
 * // MarkdownEditorHandle の replaceCurrent / replaceAll は raw のときだけ関数(rendered では undefined)
 * ```
 *
 * 位置は CodeMirror の文書の位置(`matchesIn(state.doc.toString(), query)` が返すもの=MatchRange { start, end })。
 *
 * ## 修正前に赤になる理由
 * - `src/editor/cm-replace.ts` が無いので import で落ちる
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { EditorState } from '@codemirror/state';
import { undo, undoDepth } from '@codemirror/commands';
import { matchesIn } from './cm-find';
import { createTextDocument, documentText, isDocumentDirty, withState } from './text-document';
import { MENU_FIND_REPLACE_EVENT, nextCurrentAfter, replaceAll, replaceOne } from './cm-replace';

const REPO_ROOT = resolve(__dirname, '../..');
const fixture = (name: string) => readFileSync(resolve(REPO_ROOT, 'fixtures/editing', name), 'utf8');

function open(src: string, readOnly = false) {
	return createTextDocument(src, { uri: 'file:///Users/a/notes/memo.txt', readOnly });
}
function apply(state: EditorState, spec: ReturnType<typeof replaceOne>): EditorState {
	if (!spec) throw new Error('spec が null');
	return state.update(spec).state;
}
function undoOnce(state: EditorState): EditorState {
	let next = state;
	undo({ state, dispatch: (tr) => (next = tr.state) });
	return next;
}

describe('AC-74-55: フロントの定数', () => {
	test("MENU_FIND_REPLACE_EVENT === 'menu_find_replace'(find-in-document.ts には足さない=SHA 固定)", () => {
		expect(MENU_FIND_REPLACE_EVENT).toBe('menu_find_replace');
		const fid = readFileSync(resolve(REPO_ROOT, 'src/lib/find-in-document.ts'), 'utf8');
		expect(fid).not.toContain('menu_find_replace');
	});
});

describe('AC-74-28 (1): replaceOne は現在の一致だけを文字どおり替える', () => {
	test('3 つの一致の 2 つ目だけが替わり、選択は替えた文字の後ろ(空)。前後は byte 等価', () => {
		const doc = open('cat Cat cAt\n');
		const ranges = matchesIn(doc.state.doc.toString(), 'cat');
		expect(ranges).toHaveLength(3);
		const spec = replaceOne(doc.state, ranges, 1, 'dog');
		expect(spec).not.toBeNull();
		const next = apply(doc.state, spec);
		expect(documentText(withState(doc, next))).toBe('cat dog cAt\n');
		expect(next.selection.main.empty).toBe(true);
		expect(next.selection.main.head).toBe(4 + 3);
		expect(undoDepth(next)).toBe(undoDepth(doc.state) + 1);
		expect(isDocumentDirty(withState(doc, next))).toBe(true);
	});

	test('大文字小文字を合わせない(ABC に当たっても置換の語そのまま)・`$&` も `\\n` も文字', () => {
		const doc = open('x ABC y\n');
		const ranges = matchesIn(doc.state.doc.toString(), 'abc');
		const next = apply(doc.state, replaceOne(doc.state, ranges, 0, 'q$&\\n$1'));
		expect(documentText(withState(doc, next))).toBe('x q$&\\n$1 y\n');
	});

	test('置換の語が空なら一致を消す', () => {
		const doc = open('one two one\n');
		const ranges = matchesIn(doc.state.doc.toString(), 'two ');
		const next = apply(doc.state, replaceOne(doc.state, ranges, 0, ''));
		expect(documentText(withState(doc, next))).toBe('one one\n');
	});

	test('一致が無い・番目が範囲外・読み取り専用 → null', () => {
		const doc = open('one two\n');
		expect(replaceOne(doc.state, [], 0, 'x')).toBeNull();
		const ranges = matchesIn(doc.state.doc.toString(), 'one');
		expect(replaceOne(doc.state, ranges, 5, 'x')).toBeNull();
		const ro = open('one two\n', true);
		expect(replaceOne(ro.state, matchesIn(ro.state.doc.toString(), 'one'), 0, 'x')).toBeNull();
	});

	test("userEvent は 'input.replace'", () => {
		const doc = open('one two\n');
		const spec = replaceOne(doc.state, matchesIn(doc.state.doc.toString(), 'one'), 0, 'x')!;
		const tr = doc.state.update(spec);
		expect(tr.isUserEvent('input.replace')).toBe(true);
	});
});

describe('AC-74-28 (1): 次の現在=替えた文字の終わり以降で最初の一致(nextCurrentAfter)', () => {
	test('替えた文字が語を含んでも、その中で止まらない(cat → concat)', () => {
		const doc = open('cat cat cat\n');
		const ranges = matchesIn(doc.state.doc.toString(), 'cat');
		const next = apply(doc.state, replaceOne(doc.state, ranges, 0, 'concat'));
		const text = next.doc.toString();
		expect(text).toBe('concat cat cat\n');
		const recounted = matchesIn(text, 'cat');
		expect(recounted.map((r) => r.start)).toEqual([3, 7, 11]);
		expect(nextCurrentAfter(recounted, 0 + 'concat'.length)).toBe(1);
	});

	test('最後の一致を替えたら先頭へ回る(0)。一致が無ければ 0', () => {
		expect(nextCurrentAfter([{ start: 0, end: 3 }, { start: 4, end: 7 }], 8)).toBe(0);
		expect(nextCurrentAfter([], 8)).toBe(0);
		expect(nextCurrentAfter([{ start: 0, end: 3 }, { start: 8, end: 11 }], 8)).toBe(1);
	});
});

describe('AC-74-28 (2)(4)(5)(8): replaceAll は全部を取引 1 つで替え、数を返す', () => {
	test('3 つの一致 → count 3・text が替わる・undo 1 回で byte 等価', () => {
		const src = 'cat Cat\ncAt and category\n';
		const doc = open(src);
		const { spec, count } = replaceAll(doc.state, 'cat', 'dog');
		expect(count).toBe(4);
		const next = apply(doc.state, spec);
		expect(documentText(withState(doc, next))).toBe('dog dog\ndog and dogegory\n');
		expect(undoDepth(next)).toBe(undoDepth(doc.state) + 1);
		const back = undoOnce(next);
		expect(documentText(withState(doc, back))).toBe(src);
		expect(isDocumentDirty(withState(doc, back))).toBe(false);
	});

	test('替えた後の件数は数え直す(替えた文字が語を含めば 0 にならない=それで正しい)', () => {
		const doc = open('cat cat\n');
		const { spec, count } = replaceAll(doc.state, 'cat', 'concat');
		expect(count).toBe(2);
		const next = apply(doc.state, spec);
		expect(matchesIn(next.doc.toString(), 'cat')).toHaveLength(2);
	});

	test('語が空 → spec null・count 0。一致なし → spec null・count 0。読み取り専用 → spec null', () => {
		const doc = open('one two\n');
		expect(replaceAll(doc.state, '', 'x')).toEqual({ spec: null, count: 0 });
		expect(replaceAll(doc.state, 'zzz', 'x')).toEqual({ spec: null, count: 0 });
		const ro = open('one two\n', true);
		expect(replaceAll(ro.state, 'one', 'x').spec).toBeNull();
	});

	test('置換の語が空なら全部消す', () => {
		const doc = open('a-b-c\n');
		const { spec, count } = replaceAll(doc.state, '-', '');
		expect(count).toBe(2);
		expect(documentText(withState(doc, apply(doc.state, spec)))).toBe('abc\n');
	});
});

describe('AC-74-28 (3): 替えなかった範囲は byte 等価(改行コード・BOM)', () => {
	for (const [name, query, repl] of [
		['lf.txt', 'alpha', 'ALPHA'],
		['crlf.txt', 'alpha', 'ALPHA'],
		['cr.txt', 'alpha', 'ALPHA'],
		['mixed.txt', 'e', 'E'],
		['bom-crlf.txt', 'title', 'TITLE'],
		['special-chars.txt', 'a', 'A'],
	] as const) {
		test(`${name}: replaceAll('${query}' → '${repl}') は JS の replaceAll(大文字小文字を無視)と同じ文字列`, () => {
			const src = fixture(name);
			const doc = open(src);
			const { spec, count } = replaceAll(doc.state, query, repl);
			const expected = src.replace(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), repl);
			expect(count).toBe(matchesIn(doc.state.doc.toString(), query).length);
			expect(count).toBeGreaterThan(0);
			expect(documentText(withState(doc, apply(doc.state, spec)))).toBe(expected);
		});
		test(`${name}: replaceOne(先頭の一致)は前後が byte 等価`, () => {
			const src = fixture(name);
			const doc = open(src);
			const ranges = matchesIn(doc.state.doc.toString(), query);
			const next = apply(doc.state, replaceOne(doc.state, ranges, 0, repl));
			const out = documentText(withState(doc, next));
			const at = src.toLowerCase().indexOf(query.toLowerCase());
			expect(at).toBeGreaterThanOrEqual(0);
			expect(out).toBe(src.slice(0, at) + repl + src.slice(at + query.length));
		});
	}

	test('BOM は先頭のまま(bom-crlf.txt の 1 文字目を替えても BOM は残る)', () => {
		const src = fixture('bom-crlf.txt');
		const doc = open(src);
		const { spec } = replaceAll(doc.state, 'title', '');
		const out = documentText(withState(doc, apply(doc.state, spec)));
		expect(out.charCodeAt(0)).toBe(0xfeff);
		expect(out).toBe('﻿\r\nbody line\r\n');
	});
});
