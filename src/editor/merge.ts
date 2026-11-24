/**
 * 行単位の 3 方向マージ(要件#74 契約13・契約19 の「第1段の作り」4)。純関数・依存なし
 * (契約20「node-diff3 などは足さない」)。
 *
 * - 行は改行コード(`\r\n`・`\r`・`\n`)を含めて 1 行(`a\r\n` と `a\n` は別の行)。両側とも触って
 *   いない行は byte のまま残る
 * - base → mine と base → theirs の差分(Myers)を、base の行の範囲の塊にして並べる
 * - 重なりは**行の単位**で数える(契約13・2026-11-16 に明確にした)。塊は行の単位に割る(置き換えは
 *   先頭から 1 行ずつの置き換えに、行数の差は末尾の挿入か削除に)。両側で同じ変更をした行は 1 回だけ
 *   入れ、残りの行どうしが重ならなければ clean。同じ行を両側が違う中身に変えた・片側が消した行を他方が
 *   変えた・同じ位置へ別々の中身を挿入した・ある行の範囲の内側へ挿入した、ときだけ conflict。
 *   隣り合う別々の行の変更は clean
 * - 差分が大きすぎる(編集の距離が `MAX_EDIT_DISTANCE` を超える)ときは conflict にする(文書に
 *   触れずに利用者に選ばせるほうが安全)
 */

import { diffHunks, splitLines, type Hunk } from './line-diff';

export type MergeResult = { kind: 'clean'; text: string } | { kind: 'conflict' };

/**
 * 塊を行の単位に割る。`[from, to)` を `lines` に置き換える塊を、先頭から 1 行ずつの置き換えと、
 * 行数の差の分の末尾の削除(base の行が多い)か挿入(新しい行が多い)にする。
 */
function splitByLine(hunk: Hunk): Hunk[] {
	const baseCount = hunk.to - hunk.from;
	const common = Math.min(baseCount, hunk.lines.length);
	const out: Hunk[] = [];
	for (let i = 0; i < common; i++) {
		out.push({ from: hunk.from + i, to: hunk.from + i + 1, lines: [hunk.lines[i]!] });
	}
	if (baseCount > common) out.push({ from: hunk.from + common, to: hunk.to, lines: [] });
	if (hunk.lines.length > common) {
		out.push({ from: hunk.from + common, to: hunk.from + common, lines: hunk.lines.slice(common) });
	}
	return out;
}

function sameHunk(a: Hunk, b: Hunk): boolean {
	return a.from === b.from && a.to === b.to && a.lines.length === b.lines.length && a.lines.every((l, i) => l === b.lines[i]);
}

/** 2 つの塊が同じ base の範囲を取り合うか。 */
function overlaps(a: Hunk, b: Hunk): boolean {
	const aEmpty = a.from === a.to;
	const bEmpty = b.from === b.to;
	if (aEmpty && bEmpty) return a.from === b.from;
	if (aEmpty) return b.from < a.from && a.from < b.to;
	if (bEmpty) return a.from < b.from && b.from < a.to;
	return a.from < b.to && b.from < a.to;
}

/** 行単位の 3 方向マージ。行末の改行コードは行の一部(両側とも触っていない行は byte のまま)。 */
export function merge3(base: string, mine: string, theirs: string): MergeResult {
	if (mine === theirs) return { kind: 'clean', text: mine };
	if (mine === base) return { kind: 'clean', text: theirs };
	if (theirs === base) return { kind: 'clean', text: mine };

	const baseLines = splitLines(base);
	const oursRaw = diffHunks(baseLines, splitLines(mine));
	const othersRaw = diffHunks(baseLines, splitLines(theirs));
	if (!oursRaw || !othersRaw) return { kind: 'conflict' };
	const ours = oursRaw.flatMap(splitByLine);
	const others = othersRaw.flatMap(splitByLine);

	// 両側の塊を base の位置で並べ、取り合いが無いかを見る。
	const all: Hunk[] = [];
	for (const hunk of [...ours, ...others]) {
		if (all.some((h) => sameHunk(h, hunk))) continue; // 同じ変更は 1 回だけ
		all.push(hunk);
	}
	for (const a of ours) {
		for (const b of others) {
			if (sameHunk(a, b)) continue;
			if (overlaps(a, b)) return { kind: 'conflict' };
		}
	}
	// 同じ位置の挿入と、その位置から始まる置き換えは、挿入を先に置く。
	all.sort((a, b) => a.from - b.from || (a.to - a.from) - (b.to - b.from));

	let out = '';
	let at = 0;
	for (const hunk of all) {
		for (; at < hunk.from; at++) out += baseLines[at]!;
		out += hunk.lines.join('');
		at = Math.max(at, hunk.to);
	}
	for (; at < baseLines.length; at++) out += baseLines[at]!;
	return { kind: 'clean', text: out };
}
