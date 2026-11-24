/**
 * 要件#74 第1段の受け入れテスト(docs/requirements/req-74.md)— 3方向マージの純関数
 * (AC-74-14 (1)・契約13・契約19 の「第1段の作り」4。unit プロジェクト)
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 契約19「第1段の作り」4)
 *
 * ```ts
 * // --- src/editor/merge.ts(新規・純関数・依存なし=契約20「node-diff3 などは足さない」)
 * export type MergeResult = { kind: 'clean'; text: string } | { kind: 'conflict' };
 * /** 行単位の 3 方向マージ。行末の改行コードは行の一部(両側とも触っていない行は byte のまま)。 *\/
 * export function merge3(base: string, mine: string, theirs: string): MergeResult;
 * ```
 *
 * 規則(契約13・契約19-4):
 * - `mine === base` なら theirs をそのまま返す(clean)。`theirs === base` なら mine をそのまま(clean)。
 *   `mine === theirs` なら mine(同じ変更は 1 回だけ=clean)
 * - 重ならない変更(別の行の変更・別の場所の追加と削除)は両方入る(clean)
 * - 同じ行(隣接する範囲)を両側が別の内容に変えたら conflict。conflict のときは文書に触れない(text を返さない)
 * - 行の区切りは `\r\n`・`\r`・`\n`。行の比較は改行コードを含めて行う(`a\r\n` と `a\n` は別の行)
 *
 * ## 判断の記録(test-writer 2026-11-16)
 * - 「重なる」の粒度は**行**で固定した(契約13「マージは行単位の純関数」)。同じ行を両側が別の内容に変えると conflict。
 *   片側が消した行を他方が変えたのも conflict。隣り合う別々の行の変更は clean(行単位の diff3 の既定)
 * - 末尾の改行の有無の変更は最後の行の変更として扱う(`c` ⇄ `c\n` は最後の行が変わった)
 *
 * ## 修正前に赤になる理由
 * - `src/editor/merge.ts` が無いので import で落ちる(全ケースが赤)
 */
import { describe, expect, test } from 'vitest';

import { merge3 } from './merge';

const BASE = ['one', 'two', 'three', 'four', 'five', ''].join('\n');

function lines(...xs: string[]): string {
	return xs.join('\n');
}

describe('AC-74-14 (1): merge3 の値固定表', () => {
	test('どちらも触っていない → base のまま clean', () => {
		expect(merge3(BASE, BASE, BASE)).toEqual({ kind: 'clean', text: BASE });
	});

	test('mine だけが変えた → mine(外部変更なし)', () => {
		const mine = lines('one', 'TWO', 'three', 'four', 'five', '');
		expect(merge3(BASE, mine, BASE)).toEqual({ kind: 'clean', text: mine });
	});

	test('theirs だけが変えた → theirs(未編集の取り込みと同じ)', () => {
		const theirs = lines('one', 'two', 'THREE', 'four', 'five', '');
		expect(merge3(BASE, BASE, theirs)).toEqual({ kind: 'clean', text: theirs });
	});

	test('同じ変更を両側がした → 1 回だけ入る(clean)', () => {
		const same = lines('one', 'two', 'THREE', 'four', 'five', '');
		expect(merge3(BASE, same, same)).toEqual({ kind: 'clean', text: same });
	});

	test('別の行の変更(mine=2 行目・theirs=4 行目)→ 両方入る', () => {
		const mine = lines('one', 'TWO', 'three', 'four', 'five', '');
		const theirs = lines('one', 'two', 'three', 'FOUR', 'five', '');
		expect(merge3(BASE, mine, theirs)).toEqual({
			kind: 'clean',
			text: lines('one', 'TWO', 'three', 'FOUR', 'five', ''),
		});
	});

	test('同じ行を両側が別の内容に変えた → conflict', () => {
		const mine = lines('one', 'two', 'three-mine', 'four', 'five', '');
		const theirs = lines('one', 'two', 'three-theirs', 'four', 'five', '');
		expect(merge3(BASE, mine, theirs)).toEqual({ kind: 'conflict' });
	});

	test('mine が行を足し、theirs が別の場所の行を消した → 両方入る', () => {
		const mine = lines('one', 'two', 'two-and-a-half', 'three', 'four', 'five', '');
		const theirs = lines('one', 'two', 'three', 'four', '');
		expect(merge3(BASE, mine, theirs)).toEqual({
			kind: 'clean',
			text: lines('one', 'two', 'two-and-a-half', 'three', 'four', ''),
		});
	});

	test('theirs が消した行を mine が変えた → conflict', () => {
		const mine = lines('one', 'two', 'three', 'FOUR', 'five', '');
		const theirs = lines('one', 'two', 'three', 'five', '');
		expect(merge3(BASE, mine, theirs)).toEqual({ kind: 'conflict' });
	});

	test('ファイルの先頭に theirs が足し、末尾に mine が足した → 両方入る', () => {
		const mine = lines('one', 'two', 'three', 'four', 'five', 'six', '');
		const theirs = lines('zero', 'one', 'two', 'three', 'four', 'five', '');
		expect(merge3(BASE, mine, theirs)).toEqual({
			kind: 'clean',
			text: lines('zero', 'one', 'two', 'three', 'four', 'five', 'six', ''),
		});
	});

	test('ファイルの先頭の行を両側が別に変えた → conflict', () => {
		const mine = lines('ONE', 'two', 'three', 'four', 'five', '');
		const theirs = lines('1', 'two', 'three', 'four', 'five', '');
		expect(merge3(BASE, mine, theirs)).toEqual({ kind: 'conflict' });
	});

	test('CRLF の文書: 触っていない行の \\r\\n が残り、変えた行だけが差し替わる', () => {
		const base = 'one\r\ntwo\r\nthree\r\nfour\r\n';
		const mine = 'one\r\nTWO\r\nthree\r\nfour\r\n';
		const theirs = 'one\r\ntwo\r\nthree\r\nFOUR\r\n';
		expect(merge3(base, mine, theirs)).toEqual({ kind: 'clean', text: 'one\r\nTWO\r\nthree\r\nFOUR\r\n' });
	});

	test('改行コードは行の一部: theirs が 1 行だけ LF に変えたら、その行だけが LF になる', () => {
		const base = 'one\r\ntwo\r\nthree\r\n';
		const theirs = 'one\r\ntwo\nthree\r\n';
		const mine = 'one\r\ntwo\r\nTHREE\r\n';
		expect(merge3(base, mine, theirs)).toEqual({ kind: 'clean', text: 'one\r\ntwo\nTHREE\r\n' });
	});

	test('末尾の改行を theirs が足し、mine が先頭の行を変えた → 両方入る', () => {
		const base = 'a\nb\nc';
		const mine = 'A\nb\nc';
		const theirs = 'a\nb\nc\n';
		expect(merge3(base, mine, theirs)).toEqual({ kind: 'clean', text: 'A\nb\nc\n' });
	});

	test('末尾の改行を mine が消し、theirs が最後の行を変えた → conflict(同じ最後の行)', () => {
		const base = 'a\nb\nc\n';
		const mine = 'a\nb\nc';
		const theirs = 'a\nb\nC\n';
		expect(merge3(base, mine, theirs)).toEqual({ kind: 'conflict' });
	});

	test('空の base に両側が別の内容を書いた → conflict・同じ内容なら clean', () => {
		expect(merge3('', 'mine\n', 'theirs\n')).toEqual({ kind: 'conflict' });
		expect(merge3('', 'same\n', 'same\n')).toEqual({ kind: 'clean', text: 'same\n' });
		expect(merge3('', '', 'theirs\n')).toEqual({ kind: 'clean', text: 'theirs\n' });
	});

	test('theirs が全部消した(空にした)が mine は触っていない → 空(clean)', () => {
		expect(merge3(BASE, BASE, '')).toEqual({ kind: 'clean', text: '' });
	});

	test('conflict の結果は text を持たない(文書に触れない=契約13「文書モデルを変えずに帯」)', () => {
		const result = merge3('x\n', 'y\n', 'z\n');
		expect(result.kind).toBe('conflict');
		expect('text' in result).toBe(false);
	});

	test('純関数: 同じ入力は同じ出力・引数の文字列を変えない', () => {
		const mine = lines('one', 'TWO', 'three', 'four', 'five', '');
		const theirs = lines('one', 'two', 'three', 'FOUR', 'five', '');
		const a = merge3(BASE, mine, theirs);
		const b = merge3(BASE, mine, theirs);
		expect(a).toEqual(b);
	});
});

// ---------------------------------------------------------------------------
// 変異の生き残りを締める(2026-11-16・test-runner の変異テスト M2)
// ---------------------------------------------------------------------------

describe('AC-74-14 (1)(M2): 同じ変更+片側だけの別の変更で、同じ行が 2 回入らない', () => {
	test('両側が 2 行目を同じく変え、theirs だけが 3 行目も変えた → 2 行目は 1 回だけ', () => {
		const base = lines('one', 'two', 'three', 'four', '');
		const mine = lines('one', 'TWO', 'three', 'four', '');
		const theirs = lines('one', 'TWO', 'THREE', 'four', '');
		expect(merge3(base, mine, theirs)).toEqual({ kind: 'clean', text: lines('one', 'TWO', 'THREE', 'four', '') });
	});

	test('両側が同じ行を足し、mine だけが別の行も変えた → 足した行は 1 回だけ', () => {
		const base = lines('one', 'two', 'three', '');
		const mine = lines('one', 'one-and-a-half', 'two', 'THREE', '');
		const theirs = lines('one', 'one-and-a-half', 'two', 'three', '');
		expect(merge3(base, mine, theirs)).toEqual({ kind: 'clean', text: lines('one', 'one-and-a-half', 'two', 'THREE', '') });
	});

	test('両側が同じ行を消し、theirs だけが末尾に足した → 消した行が戻らず、足した行は 1 回', () => {
		const base = lines('one', 'two', 'three', '');
		const mine = lines('one', 'three', '');
		const theirs = lines('one', 'three', 'four', '');
		expect(merge3(base, mine, theirs)).toEqual({ kind: 'clean', text: lines('one', 'three', 'four', '') });
	});

	test('同じ変更が 2 か所あり、片側だけが 3 か所目を変えた → 行数が base と同じ', () => {
		const base = lines('a', 'b', 'c', 'd', 'e', '');
		const mine = lines('A', 'b', 'C', 'd', 'e', '');
		const theirs = lines('A', 'b', 'C', 'd', 'E', '');
		const result = merge3(base, mine, theirs);
		expect(result).toEqual({ kind: 'clean', text: lines('A', 'b', 'C', 'd', 'E', '') });
		expect((result as { text: string }).text.split('\n')).toHaveLength(6);
	});
});

// ---------------------------------------------------------------------------
// reviewer の当て直し(2026-11-16・N5・N6)— 契約13 の重なりの条件
// (同じ行を違う中身に・消した行に触れた=内側への挿入を含む・同じ位置に別々の挿入)
// ---------------------------------------------------------------------------

describe('AC-74-14 (1)(N5・N6): 消した範囲の内側への挿入は conflict・置き換えの前への挿入は clean', () => {
	test('N5: mine が 2〜3 行目を消し、theirs が 2 行目と 3 行目の間に挿入 → conflict(消した行に触れた)', () => {
		const base = lines('one', 'two', 'three', 'four', '');
		const mine = lines('one', 'four', '');
		const theirs = lines('one', 'two', 'X', 'three', 'four', '');
		expect(merge3(base, mine, theirs)).toEqual({ kind: 'conflict' });
	});

	test('N6: mine が 2 行目を置き換え、theirs が 2 行目の前に挿入 → clean・one / X / TWO / three の順', () => {
		const base = lines('one', 'two', 'three', '');
		const mine = lines('one', 'TWO', 'three', '');
		const theirs = lines('one', 'X', 'two', 'three', '');
		expect(merge3(base, mine, theirs)).toEqual({ kind: 'clean', text: lines('one', 'X', 'TWO', 'three', '') });
	});

	test('N6 の対: theirs が置き換え、mine が前に挿入 → 同じ順(入れ替えても結果が同じ)', () => {
		const base = lines('one', 'two', 'three', '');
		const mine = lines('one', 'X', 'two', 'three', '');
		const theirs = lines('one', 'TWO', 'three', '');
		expect(merge3(base, mine, theirs)).toEqual({ kind: 'clean', text: lines('one', 'X', 'TWO', 'three', '') });
	});
});
