/**
 * 要件#89 の受け入れテスト(docs/requirements/req-89.md)— マージの画面のモデル(純関数)
 * AC-89-6(契約9・14)・AC-89-7 の「選びを当てる」(契約11)・AC-89-8 の「同じ塊の選びは残す」(契約12)。unit プロジェクト。
 *
 * ## 確定契約(implementer はこれに従う=test-writer が固定・2026-11-26)
 *
 * ```ts
 * // --- src/editor/merge-chunks.ts(新規・純関数・依存なし=契約14「依存は足さない」。merge.ts / line-diff.ts は書き換えない)
 * export type MergeChoice = 'mine' | 'theirs' | 'both';
 * export type MergePart =
 *   | { kind: 'clean'; text: string }                       // 重ならない所(両側の重ならない変更は当てた後の文字列)
 *   | { kind: 'conflict'; mine: string; theirs: string };   // 重なった塊: 同じ base の範囲の、自分の版とディスクの版
 * /** 基準の版・自分の修正・ディスクの版の 3 方向の塊。差分が大きすぎる(merge3 と同じ上限)ときは null。重なりが無ければ conflict は 0 個。 *\/
 * export function mergeChunks(base: string, mine: string, theirs: string): MergePart[] | null;
 * /** 選びを当てた文字列。choices[i] は i 番目の conflict(conflict だけを数えた並び)の選び。未選択(null / undefined)が残れば null。 *\/
 * export function applyChoices(parts: readonly MergePart[], choices: ReadonlyArray<MergeChoice | null | undefined>): string | null;
 * /** 作り直し(契約12): 新しい塊の並びに、mine と theirs の中身が同じ古い塊の選びを引き継ぐ。古い塊は 1 回だけ使う(並びの順に)。他は null。 *\/
 * export function carryChoices(oldParts: readonly MergePart[], oldChoices: ReadonlyArray<MergeChoice | null | undefined>, newParts: readonly MergePart[]): Array<MergeChoice | null>;
 * ```
 *
 * 規則(契約9・14・決定④⑤):
 * - 行の単位は merge3 と同じ(`splitLines`=改行コードを含めて 1 行・`diffHunks`+`splitByLine`=置き換えは 1 行ずつ、行数の差は末尾の挿入か
 *   削除。純粋な削除は 1 つの範囲のまま)。「重なる」も merge3 の `overlaps` と同じ(同じ行を両側が違う中身に・片側が消した範囲に他方が触れた・
 *   同じ位置へ別々の挿入)。両側で同じ変更をした行は 1 回だけ入れて clean
 * - 重なった塊=重なる hunk のうち、base の範囲が重なるか接する(間に触っていない行が無い)ものをまとめた 1 つ。塊の `mine` / `theirs` は、
 *   その base の範囲を自分の版 / ディスクの版にしたもの(片側が消していれば '')
 * - 重ならない hunk(片側だけが変えた行)は clean に当てて入れる(重なった塊に隣り合っていても clean=契約14「行の単位」)
 * - clean は隣り合うものを 1 つにまとめ、空の clean は置かない。conflict は隣り合わない(接するものは 1 つの塊)
 * - `applyChoices`: clean はそのまま・'mine' / 'theirs' はその版・'both' は自分の後にディスク(決定⑤)。自分の版が改行で終わらず
 *   ディスクの版が空でないときは、間に改行を 1 つ入れる(ディスクの版の最後の行の改行コード。無ければ '\n')
 * - 重なりが無いとき `applyChoices(mergeChunks(b, m, t), [])` は `merge3(b, m, t).text` と同じ
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - 塊の単位は契約14 どおり**行**で固定(決定④の「続いて重なった行」=接する重なった行を 1 つに)。片側だけが変えた行は、重なった行に
 *   隣り合っていても clean(T6)。raw の hunk(ユーザーの 1 回の置き換え)の単位でまとめる案は選ばなかった(契約14「merge3 と同じ」)
 * - その帰結: 自分が 1 行を 2 行に置き換え、ディスクが同じ 1 行を別の 1 行にしたとき、2 行目(挿入)は merge3 と同じく重ならない=clean。
 *   T10 は塊が 1 つで `theirs` が 'C\n'、全部 'mine' の結果が自分の版と同じことだけを固定し、挿入の置き場所(塊の後)は固定しない
 *   (後で要件側が決め直せるように)
 * - 'both' の間の改行(自分の版が改行で終わらないとき)は test-writer が決めた(契約には無い。'B-m' + 'B-t' を 'B-mB-t' にはしない)
 * - choices は conflict だけを数えた並びの番号(画面の塊の番号と同じ)。parts の番号ではない
 * - 差分が大きすぎるときは null(merge3 が conflict にするのと同じ入力)。画面はそのとき「Too many differences to merge.」を出し Apply を押せない
 *   (Viewer.merge.wiring.test.ts)
 *
 * ## 修正前に赤になる理由
 * - `src/editor/merge-chunks.ts` が無いので import で落ちる(全ケースが赤)
 */
import { describe, expect, test } from 'vitest';

import { merge3 } from './merge';
import { applyChoices, carryChoices, mergeChunks, type MergePart } from './merge-chunks';

function lines(...xs: string[]): string {
	return xs.join('\n');
}
const BASE = lines('one', 'two', 'three', 'four', 'five', '');

const clean = (text: string): MergePart => ({ kind: 'clean', text });
const conflict = (mine: string, theirs: string): MergePart => ({ kind: 'conflict', mine, theirs });
function conflicts(parts: MergePart[] | null): MergePart[] {
	return (parts ?? []).filter((p) => p.kind === 'conflict');
}

describe('AC-89-6: mergeChunks の塊の作り方(契約9・14)', () => {
	test('T1 重ならない変更(mine=2 行目・theirs=4 行目)→ conflict は無く、clean 1 つ=merge3 と同じ文字列', () => {
		const mine = lines('one', 'TWO', 'three', 'four', 'five', '');
		const theirs = lines('one', 'two', 'three', 'FOUR', 'five', '');
		const parts = mergeChunks(BASE, mine, theirs);
		expect(parts).toEqual([clean(lines('one', 'TWO', 'three', 'FOUR', 'five', ''))]);
		expect(applyChoices(parts!, [])).toBe((merge3(BASE, mine, theirs) as { text: string }).text);
	});

	test('T2 どちらも触っていない・片側だけ・同じ変更 → conflict は 0 個で、文字列は merge3 と同じ', () => {
		const mine = lines('one', 'TWO', 'three', 'four', 'five', '');
		for (const [b, m, t] of [
			[BASE, BASE, BASE],
			[BASE, mine, BASE],
			[BASE, BASE, mine],
			[BASE, mine, mine],
			['', '', ''],
			['', '', 'theirs\n'],
		] as const) {
			const parts = mergeChunks(b, m, t);
			expect(parts, `${JSON.stringify([b, m, t])} は null でない`).not.toBeNull();
			expect(conflicts(parts)).toEqual([]);
			expect(applyChoices(parts!, [])).toBe((merge3(b, m, t) as { text: string }).text);
			for (const p of parts!) if (p.kind === 'clean') expect(p.text, '空の clean は置かない').not.toBe('');
		}
	});

	test('T3 同じ行を両側が別の中身に → その 1 行が塊(前後は clean)', () => {
		const mine = lines('one', 'two', 'three-mine', 'four', 'five', '');
		const theirs = lines('one', 'two', 'three-theirs', 'four', 'five', '');
		expect(mergeChunks(BASE, mine, theirs)).toEqual([
			clean('one\ntwo\n'),
			conflict('three-mine\n', 'three-theirs\n'),
			clean('four\nfive\n'),
		]);
	});

	test('T4 続いて重なった行(3 行目と 4 行目)は 1 つの塊(決定④)', () => {
		const mine = lines('one', 'two', 'THREE-m', 'FOUR-m', 'five', '');
		const theirs = lines('one', 'two', 'THREE-t', 'FOUR-t', 'five', '');
		expect(mergeChunks(BASE, mine, theirs)).toEqual([
			clean('one\ntwo\n'),
			conflict('THREE-m\nFOUR-m\n', 'THREE-t\nFOUR-t\n'),
			clean('five\n'),
		]);
	});

	test('T5 触っていない行を挟んだ 2 つの重なり(2 行目と 4 行目)は 2 つの塊', () => {
		const mine = lines('one', 'TWO-m', 'three', 'FOUR-m', 'five', '');
		const theirs = lines('one', 'TWO-t', 'three', 'FOUR-t', 'five', '');
		expect(mergeChunks(BASE, mine, theirs)).toEqual([
			clean('one\n'),
			conflict('TWO-m\n', 'TWO-t\n'),
			clean('three\n'),
			conflict('FOUR-m\n', 'FOUR-t\n'),
			clean('five\n'),
		]);
	});

	test('T6 mine が 3・4 行目を変え、theirs が 4 行目だけ → 3 行目は clean に入り(自動)、塊は 4 行目だけ(契約14=行の単位)', () => {
		const mine = lines('one', 'two', 'THREE-m', 'FOUR-m', 'five', '');
		const theirs = lines('one', 'two', 'three', 'FOUR-t', 'five', '');
		expect(mergeChunks(BASE, mine, theirs)).toEqual([
			clean('one\ntwo\nTHREE-m\n'),
			conflict('FOUR-m\n', 'FOUR-t\n'),
			clean('five\n'),
		]);
	});

	test('T7 theirs が消した行を mine が変えた → 塊の theirs は空文字列', () => {
		const mine = lines('one', 'two', 'three', 'FOUR', 'five', '');
		const theirs = lines('one', 'two', 'three', 'five', '');
		expect(mergeChunks(BASE, mine, theirs)).toEqual([
			clean('one\ntwo\nthree\n'),
			conflict('FOUR\n', ''),
			clean('five\n'),
		]);
	});

	test('T8 同じ位置へ別々の挿入 → 塊(両側とも挿入した行だけ)', () => {
		const mine = lines('one', 'two', 'X', 'three', 'four', 'five', '');
		const theirs = lines('one', 'two', 'Y', 'three', 'four', 'five', '');
		expect(mergeChunks(BASE, mine, theirs)).toEqual([
			clean('one\ntwo\n'),
			conflict('X\n', 'Y\n'),
			clean('three\nfour\nfive\n'),
		]);
	});

	test('T9 mine が消した範囲の内側に theirs が挿入(merge3 の N5)→ 塊の mine は空・theirs は挿入を含む範囲', () => {
		const base = lines('one', 'two', 'three', 'four', '');
		const mine = lines('one', 'four', '');
		const theirs = lines('one', 'two', 'X', 'three', 'four', '');
		expect(mergeChunks(base, mine, theirs)).toEqual([clean('one\n'), conflict('', 'two\nX\nthree\n'), clean('four\n')]);
	});

	test('T10 mine が 1 行を 2 行に、theirs が同じ行を別の 1 行に → 塊は 1 つ・theirs は C・全部 mine なら自分の版と同じ', () => {
		const mine = lines('one', 'two', 'A', 'B', 'four', 'five', '');
		const theirs = lines('one', 'two', 'C', 'four', 'five', '');
		const parts = mergeChunks(BASE, mine, theirs);
		expect(conflicts(parts)).toHaveLength(1);
		expect((conflicts(parts)[0] as { theirs: string }).theirs).toBe('C\n');
		expect((conflicts(parts)[0] as { mine: string }).mine.startsWith('A\n')).toBe(true);
		expect(applyChoices(parts!, ['mine'])).toBe(mine);
	});

	test('両側の重ならない変更は clean に当たり、重なった所だけが塊(自動マージ+塊)', () => {
		const mine = lines('ONE-m', 'two', 'THREE-m', 'four', 'five', '');
		const theirs = lines('one', 'two', 'THREE-t', 'four', 'FIVE-t', '');
		expect(mergeChunks(BASE, mine, theirs)).toEqual([
			clean('ONE-m\ntwo\n'),
			conflict('THREE-m\n', 'THREE-t\n'),
			clean('four\nFIVE-t\n'),
		]);
	});

	test('CRLF の文書: 触っていない行の \\r\\n が残り、塊の中身も \\r\\n を含む', () => {
		const base = 'one\r\ntwo\r\nthree\r\n';
		const mine = 'one\r\nTWO-m\r\nthree\r\n';
		const theirs = 'one\r\nTWO-t\r\nthree\r\n';
		expect(mergeChunks(base, mine, theirs)).toEqual([clean('one\r\n'), conflict('TWO-m\r\n', 'TWO-t\r\n'), clean('three\r\n')]);
	});

	test('最後の行(改行なし)を両側が別に変えた → 塊の中身は改行なし', () => {
		expect(mergeChunks('a\nb', 'a\nB-m', 'a\nB-t')).toEqual([clean('a\n'), conflict('B-m', 'B-t')]);
	});

	test('空の base に両側が別の中身 → 塊 1 つだけ(clean なし)', () => {
		expect(mergeChunks('', 'mine\n', 'theirs\n')).toEqual([conflict('mine\n', 'theirs\n')]);
	});

	test('重なりの判定は merge3 と同じ: merge3 が conflict なら塊が 1 つ以上、clean なら 0 個', () => {
		const cases: Array<[string, string, string]> = [
			[BASE, lines('one', 'two', 'three-mine', 'four', 'five', ''), lines('one', 'two', 'three-theirs', 'four', 'five', '')],
			[BASE, lines('one', 'two', 'three', 'FOUR', 'five', ''), lines('one', 'two', 'three', 'five', '')],
			[BASE, lines('ONE', 'two', 'three', 'four', 'five', ''), lines('1', 'two', 'three', 'four', 'five', '')],
			['a\nb\nc\n', 'a\nb\nc', 'a\nb\nC\n'],
			[BASE, lines('one', 'TWO', 'three', 'four', 'five', ''), lines('one', 'two', 'three', 'FOUR', 'five', '')],
			[lines('one', 'two', 'three', ''), lines('one', 'TWO', 'three', ''), lines('one', 'X', 'two', 'three', '')],
			['a\nb\nc', 'A\nb\nc', 'a\nb\nc\n'],
			[lines('one', 'two', 'three', 'four', ''), lines('one', 'TWO', 'three', 'four', ''), lines('one', 'TWO', 'THREE', 'four', '')],
		];
		for (const [b, m, t] of cases) {
			const parts = mergeChunks(b, m, t);
			expect(parts, JSON.stringify([b, m, t])).not.toBeNull();
			const n = conflicts(parts).length;
			if (merge3(b, m, t).kind === 'conflict') expect(n, `conflict: ${JSON.stringify([b, m, t])}`).toBeGreaterThan(0);
			else expect(n, `clean: ${JSON.stringify([b, m, t])}`).toBe(0);
		}
	});

	test('差分が大きすぎる(merge3 の上限超え)→ null', () => {
		const n = 3000;
		const mk = (p: string) => Array.from({ length: n }, (_, i) => `${p}${i}\n`).join('');
		expect(mergeChunks(mk('b'), mk('m'), mk('t'))).toBeNull();
	});

	test('正規化: clean は隣り合わず空でなく、conflict も隣り合わない・純関数(同じ入力は同じ出力)', () => {
		const mine = lines('ONE-m', 'TWO-m', 'THREE-m', 'four', 'FIVE-m', '');
		const theirs = lines('ONE-t', 'two', 'THREE-t', 'FOUR-t', 'five', '');
		const parts = mergeChunks(BASE, mine, theirs)!;
		for (let i = 1; i < parts.length; i++) expect(parts[i]!.kind, `parts[${i - 1}] と parts[${i}]`).not.toBe(parts[i - 1]!.kind);
		for (const p of parts) if (p.kind === 'clean') expect(p.text).not.toBe('');
		expect(mergeChunks(BASE, mine, theirs)).toEqual(parts);
	});
});

describe('AC-89-7: applyChoices の 3 つの選び方(契約9・11・決定⑤)', () => {
	const parts: MergePart[] = [clean('one\n'), conflict('TWO-m\n', 'TWO-t\n'), clean('three\n'), conflict('FOUR-m\n', 'FOUR-t\n'), clean('five\n')];

	test("'mine' / 'theirs' / 'both'(自分の後にディスク)", () => {
		expect(applyChoices(parts, ['mine', 'mine'])).toBe(lines('one', 'TWO-m', 'three', 'FOUR-m', 'five', ''));
		expect(applyChoices(parts, ['theirs', 'theirs'])).toBe(lines('one', 'TWO-t', 'three', 'FOUR-t', 'five', ''));
		expect(applyChoices(parts, ['both', 'theirs'])).toBe(lines('one', 'TWO-m', 'TWO-t', 'three', 'FOUR-t', 'five', ''));
		expect(applyChoices(parts, ['theirs', 'both'])).toBe(lines('one', 'TWO-t', 'three', 'FOUR-m', 'FOUR-t', 'five', ''));
	});

	test('未選択の塊が残れば null(選び終えるまで Apply できない=契約10)', () => {
		expect(applyChoices(parts, [])).toBeNull();
		expect(applyChoices(parts, ['mine'])).toBeNull();
		expect(applyChoices(parts, ['mine', null])).toBeNull();
		expect(applyChoices(parts, [undefined, 'theirs'])).toBeNull();
	});

	test('片側が空の塊(消した行): theirs を選べば消え、both は自分の版だけ', () => {
		const p: MergePart[] = [clean('one\n'), conflict('FOUR\n', ''), clean('five\n')];
		expect(applyChoices(p, ['theirs'])).toBe('one\nfive\n');
		expect(applyChoices(p, ['mine'])).toBe('one\nFOUR\nfive\n');
		expect(applyChoices(p, ['both'])).toBe('one\nFOUR\nfive\n');
	});

	test("'both' で自分の版が改行で終わらないときは間に改行を入れる(最後の行)", () => {
		expect(applyChoices([clean('a\n'), conflict('B-m', 'B-t')], ['both'])).toBe('a\nB-m\nB-t');
		expect(applyChoices([clean('a\r\n'), conflict('B-m', 'B-t\r\n')], ['both'])).toBe('a\r\nB-m\r\nB-t\r\n');
	});

	test('conflict が無ければ choices は空でよく、clean をつないだ文字列', () => {
		expect(applyChoices([clean('x\n'), clean('y\n')], [])).toBe('x\ny\n');
		expect(applyChoices([], [])).toBe('');
	});

	test('引数の parts と choices を変えない', () => {
		const copy = structuredClone(parts);
		const choices: Array<'mine' | 'theirs' | 'both' | null> = ['mine', 'both'];
		applyChoices(parts, choices);
		expect(parts).toEqual(copy);
		expect(choices).toEqual(['mine', 'both']);
	});
});

describe('AC-89-8: carryChoices=作り直しで同じ塊の選びが残る(契約12・決定⑦)', () => {
	test('mine と theirs が同じ塊の選びは残り、中身が変わった塊は null', () => {
		const old: MergePart[] = [clean('one\n'), conflict('A\n', 'B\n'), clean('x\n'), conflict('C\n', 'D\n')];
		const next: MergePart[] = [clean('one\n'), conflict('A\n', 'B\n'), clean('x\n'), conflict('C\n', 'D2\n')];
		expect(carryChoices(old, ['mine', 'both'], next)).toEqual(['mine', null]);
	});

	test('塊の番号がずれても(前に新しい塊が入る)中身で引き継ぐ', () => {
		const old: MergePart[] = [conflict('A\n', 'B\n')];
		const next: MergePart[] = [conflict('X\n', 'Y\n'), clean('m\n'), conflict('A\n', 'B\n')];
		expect(carryChoices(old, ['theirs'], next)).toEqual([null, 'theirs']);
	});

	test('同じ中身の塊が 2 つあれば順に 1 回ずつ使う', () => {
		const old: MergePart[] = [conflict('A\n', 'B\n'), clean('m\n'), conflict('A\n', 'B\n')];
		const next: MergePart[] = [conflict('A\n', 'B\n'), clean('n\n'), conflict('A\n', 'B\n'), clean('o\n'), conflict('A\n', 'B\n')];
		expect(carryChoices(old, ['mine', 'theirs'], next)).toEqual(['mine', 'theirs', null]);
	});

	test('古い選びが null なら null のまま・片側だけ同じ塊は引き継がない・新しい塊が無ければ []', () => {
		const old: MergePart[] = [conflict('A\n', 'B\n'), conflict('C\n', 'D\n')];
		expect(carryChoices(old, [null, 'mine'], [conflict('A\n', 'B\n'), conflict('C\n', 'E\n'), conflict('F\n', 'D\n')])).toEqual([null, null, null]);
		expect(carryChoices(old, ['mine', 'mine'], [clean('all merged\n')])).toEqual([]);
	});

	test('結果の長さは新しい conflict の数で、引数を変えない', () => {
		const old: MergePart[] = [conflict('A\n', 'B\n')];
		const oldChoices: Array<'mine' | 'theirs' | 'both' | null> = ['both'];
		const next: MergePart[] = [clean('p\n'), conflict('A\n', 'B\n'), conflict('Q\n', 'R\n')];
		const out = carryChoices(old, oldChoices, next);
		expect(out).toHaveLength(2);
		expect(out).toEqual(['both', null]);
		expect(oldChoices).toEqual(['both']);
	});
});
