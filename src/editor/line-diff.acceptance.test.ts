/**
 * 要件#74 第4段 4-1 — 行の差分の純関数(契約13・契約19・由谷の決定 2026-11-17 午後 4-2=自前・依存なし)。
 * 正本: docs/review/req74-stage34-prep.md の (C) 1「差分の計算」と (D) AC-74-59。
 *
 * ## 対応する受け入れ基準
 * - AC-74-59: `lineDiff` の値固定表=同じ・1 行の変更・追加・削除・先頭と末尾・末尾の改行の有無・CRLF ↔ LF(行末の改行コードを含めて差になる)・
 *   空 ↔ 空でない・上限を超える(null)。`merge.acceptance.test.ts` は無改変で緑(merge3 の振る舞いは変えない)
 *
 * ## 確定契約(implementer はこれに従う=推奨名は stage34-prep の (C) 1)
 *
 * ```ts
 * // --- src/editor/line-diff.ts(新規。merge.ts の splitLines / diffHunks(Myers・MAX_EDIT_DISTANCE=4000)を共有に出す)
 * /** a の行 [aStart, aStart + aLines.length) を bLines に置き換える塊。行は行末の改行コードを含む。行番号は 0 始まり。 *\/
 * export interface DiffHunk { aStart: number; aLines: string[]; bStart: number; bLines: string[] }
 * /** a → b の行の差分(塊は a の順・重ならない・空の塊は無い)。編集の距離が上限を超えたら null。同じなら []。 *\/
 * export function lineDiff(a: string, b: string): DiffHunk[] | null;
 * /** 差分の上限(merge.ts と同じ 4000)。 *\/
 * export const MAX_LINE_DIFF_DISTANCE: number;
 * ```
 *
 * ## 修正前に赤になる理由
 * - `src/editor/line-diff.ts` が無いので import で落ちる
 */
import { describe, expect, test } from 'vitest';
import { lineDiff, MAX_LINE_DIFF_DISTANCE, type DiffHunk } from './line-diff';
import { merge3 } from './merge';

/** 塊を a に当てて b を組み立て直す(塊の整合の検算)。 */
function applyHunks(a: string, hunks: DiffHunk[]): string {
	const lines = a.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
	const out: string[] = [];
	let at = 0;
	for (const h of hunks) {
		out.push(...lines.slice(at, h.aStart));
		out.push(...h.bLines);
		at = h.aStart + h.aLines.length;
	}
	out.push(...lines.slice(at));
	return out.join('');
}
function expectConsistent(a: string, b: string, hunks: DiffHunk[]) {
	expect(applyHunks(a, hunks), '塊を a に当てると b').toBe(b);
	let prevEnd = -1;
	let bAt = 0;
	for (const h of hunks) {
		expect(h.aStart, '塊は a の順で重ならない').toBeGreaterThanOrEqual(prevEnd);
		expect(h.aLines.length + h.bLines.length, '空の塊は無い').toBeGreaterThan(0);
		expect(h.bStart, 'bStart は a との対応').toBe(bAt + (h.aStart - Math.max(prevEnd, 0)));
		bAt = h.bStart + h.bLines.length;
		prevEnd = h.aStart + h.aLines.length;
	}
}

describe('AC-74-59: lineDiff の値固定表', () => {
	test('同じ文字列 → []。空 ↔ 空 → []', () => {
		expect(lineDiff('a\nb\n', 'a\nb\n')).toEqual([]);
		expect(lineDiff('', '')).toEqual([]);
	});

	test('1 行の変更(真ん中)', () => {
		const a = 'one\ntwo\nthree\n';
		const b = 'one\nTWO\nthree\n';
		const hunks = lineDiff(a, b)!;
		expect(hunks).toEqual([{ aStart: 1, aLines: ['two\n'], bStart: 1, bLines: ['TWO\n'] }]);
		expectConsistent(a, b, hunks);
	});

	test('追加(真ん中に 2 行)と削除(1 行)', () => {
		const a = 'one\ntwo\n';
		const b = 'one\nx\ny\ntwo\n';
		expect(lineDiff(a, b)).toEqual([{ aStart: 1, aLines: [], bStart: 1, bLines: ['x\n', 'y\n'] }]);
		expect(lineDiff(b, a)).toEqual([{ aStart: 1, aLines: ['x\n', 'y\n'], bStart: 1, bLines: [] }]);
		expectConsistent(a, b, lineDiff(a, b)!);
		expectConsistent(b, a, lineDiff(b, a)!);
	});

	test('先頭と末尾の変更は別々の塊', () => {
		const a = 'one\ntwo\nthree\n';
		const b = 'ONE\ntwo\nTHREE\n';
		const hunks = lineDiff(a, b)!;
		expect(hunks).toEqual([
			{ aStart: 0, aLines: ['one\n'], bStart: 0, bLines: ['ONE\n'] },
			{ aStart: 2, aLines: ['three\n'], bStart: 2, bLines: ['THREE\n'] },
		]);
		expectConsistent(a, b, hunks);
	});

	test('末尾の改行の有無は最後の行の差になる', () => {
		const hunks = lineDiff('a\nb\n', 'a\nb')!;
		expect(hunks).toEqual([{ aStart: 1, aLines: ['b\n'], bStart: 1, bLines: ['b'] }]);
		expect(lineDiff('a\nb', 'a\nb\n')).toEqual([{ aStart: 1, aLines: ['b'], bStart: 1, bLines: ['b\n'] }]);
	});

	test('CRLF ↔ LF: 行末の改行コードを含めて差になる(中身が同じでも)', () => {
		const hunks = lineDiff('a\r\nb\r\n', 'a\nb\r\n')!;
		expect(hunks).toEqual([{ aStart: 0, aLines: ['a\r\n'], bStart: 0, bLines: ['a\n'] }]);
		expect(lineDiff('a\r\nb\r\n', 'a\nb\n')).toEqual([{ aStart: 0, aLines: ['a\r\n', 'b\r\n'], bStart: 0, bLines: ['a\n', 'b\n'] }]);
		expect(lineDiff('a\rb\r', 'a\rb\r')).toEqual([]);
	});

	test('空 ↔ 空でない(全部が追加 / 削除)', () => {
		expect(lineDiff('', 'a\nb\n')).toEqual([{ aStart: 0, aLines: [], bStart: 0, bLines: ['a\n', 'b\n'] }]);
		expect(lineDiff('a\nb\n', '')).toEqual([{ aStart: 0, aLines: ['a\n', 'b\n'], bStart: 0, bLines: [] }]);
	});

	test('BOM は 1 行目の一部(1 行目の差)', () => {
		expect(lineDiff('﻿a\nb\n', 'a\nb\n')).toEqual([{ aStart: 0, aLines: ['﻿a\n'], bStart: 0, bLines: ['a\n'] }]);
	});

	test('離れた 2 箇所の変更と、入れ替わり(塊は a の順・重ならない)', () => {
		const a = Array.from({ length: 12 }, (_, i) => `l${i}\n`).join('');
		const b = a.replace('l2\n', 'L2\n').replace('l9\n', 'L9\nextra\n');
		const hunks = lineDiff(a, b)!;
		expect(hunks).toHaveLength(2);
		expect(hunks[0]).toEqual({ aStart: 2, aLines: ['l2\n'], bStart: 2, bLines: ['L2\n'] });
		expect(hunks[1]!.aStart).toBe(9);
		expectConsistent(a, b, hunks);
	});

	test('編集の距離が上限(MAX_LINE_DIFF_DISTANCE=4000)を超えると null。超えなければ塊', () => {
		expect(MAX_LINE_DIFF_DISTANCE).toBe(4000);
		const n = 3000;
		const a = Array.from({ length: n }, (_, i) => `a${i}\n`).join('');
		const b = Array.from({ length: n }, (_, i) => `b${i}\n`).join('');
		expect(lineDiff(a, b)).toBeNull();
		const small = Array.from({ length: 1500 }, (_, i) => `a${i}\n`).join('');
		const smallB = Array.from({ length: 1500 }, (_, i) => `b${i}\n`).join('');
		expect(lineDiff(small, smallB), '距離 3000 は上限の内').not.toBeNull();
	});

	test('merge3 の振る舞いは変わらない(共有に出しても同じ結果)', () => {
		expect(merge3('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n')).toEqual({ kind: 'clean', text: 'A\nb\nC\n' });
		expect(merge3('a\nb\nc\n', 'A\nb\nc\n', 'X\nb\nc\n')).toEqual({ kind: 'conflict' });
	});
});

// 第4段の P3 の穴(D1・D2): 塊が複数で長さの違う組の bStart
describe('P3 D1 / D2: 複数の塊で長さが違うとき、2 つ目以降の bStart は前の塊の長さの差を映す', () => {
	test('l2 を 3 行に置き換え+l7 を削除 → 2 つ目の塊は aStart 7・bStart 9', () => {
		const a = Array.from({ length: 10 }, (_, i) => `l${i}\n`).join('');
		const b = ['l0\n', 'l1\n', 'X1\n', 'X2\n', 'X3\n', 'l3\n', 'l4\n', 'l5\n', 'l6\n', 'l8\n', 'l9\n'].join('');
		const hunks = lineDiff(a, b)!;
		expect(hunks).toEqual([
			{ aStart: 2, aLines: ['l2\n'], bStart: 2, bLines: ['X1\n', 'X2\n', 'X3\n'] },
			{ aStart: 7, aLines: ['l7\n'], bStart: 9, bLines: [] },
		]);
		expectConsistent(a, b, hunks);
	});
	test('先頭に 2 行の追加+真ん中の 2 行を 1 行に+末尾に 1 行の追加 → 3 つの塊の bStart が順に積み上がる', () => {
		const a = Array.from({ length: 8 }, (_, i) => `l${i}\n`).join('');
		const b = ['A\n', 'B\n', 'l0\n', 'l1\n', 'l2\n', 'M\n', 'l5\n', 'l6\n', 'l7\n', 'Z\n'].join('');
		const hunks = lineDiff(a, b)!;
		expect(hunks).toEqual([
			{ aStart: 0, aLines: [], bStart: 0, bLines: ['A\n', 'B\n'] },
			{ aStart: 3, aLines: ['l3\n', 'l4\n'], bStart: 5, bLines: ['M\n'] },
			{ aStart: 8, aLines: [], bStart: 9, bLines: ['Z\n'] },
		]);
		expectConsistent(a, b, hunks);
	});
});
