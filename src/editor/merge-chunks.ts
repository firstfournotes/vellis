/**
 * マージの画面のモデル(要件#89 契約9・11・12・14)。純関数・依存なし(契約14「依存は足さない」)。
 *
 * 基準の版・自分の修正・ディスクの版の 3 方向で、重ならない変更は当てた文字列(clean)に、重なった所は塊(conflict)に
 * 並べる。行の単位・「重なる」の判定・同じ変更の扱いは `merge.ts` の `merge3` と同じ(merge.ts / line-diff.ts は書き換え
 * ない=要件#74 の 3 方向マージの約束を動かさない)。重なりが無ければ、clean をつないだ文字列は `merge3` の text と同じ。
 *
 * - 塊=重なる hunk のうち、base の範囲が重なるか接する(間に触っていない行が無い)ものをまとめた 1 つ(決定④)。塊の
 *   `mine` / `theirs` は、その base の範囲を自分の版 / ディスクの版にしたもの(片側が消していれば '')
 * - 片側だけが変えた行は、重なった塊に隣り合っていても clean に当てて入れる(行の単位)
 * - clean は隣り合うものを 1 つにまとめ、空の clean は置かない
 */

import { diffHunks, splitLines, type Hunk } from './line-diff';
import { byPosition, overlaps, sameHunk, splitByLine } from './merge';

export type MergeChoice = 'mine' | 'theirs' | 'both';
export type MergePart = { kind: 'clean'; text: string } | { kind: 'conflict'; mine: string; theirs: string };
export type MergeConflict = Extract<MergePart, { kind: 'conflict' }>;

/** 塊の並びのうち、重なった塊(conflict)だけ。 */
export function conflictsOf(parts: readonly MergePart[] | null): MergeConflict[] {
	return (parts ?? []).filter((p): p is MergeConflict => p.kind === 'conflict');
}

/** base の `[from, to)` を、その側の塊(範囲の中のもの)を当てた文字列にする。 */
function sideText(baseLines: readonly string[], from: number, to: number, hunks: Hunk[]): string {
	let out = '';
	let at = from;
	for (const hunk of [...hunks].sort(byPosition)) {
		for (; at < hunk.from; at++) out += baseLines[at]!;
		out += hunk.lines.join('');
		at = Math.max(at, hunk.to);
	}
	for (; at < to; at++) out += baseLines[at]!;
	return out;
}

type Group = { from: number; to: number; mine: Hunk[]; theirs: Hunk[] };
type Item = { from: number; to: number } & ({ kind: 'hunk'; hunk: Hunk } | { kind: 'group'; group: Group });

/**
 * 基準の版・自分の修正・ディスクの版の 3 方向の塊。差分が大きすぎる(merge3 と同じ上限)ときは null。
 * 重なりが無ければ conflict は 0 個。
 */
export function mergeChunks(base: string, mine: string, theirs: string): MergePart[] | null {
	const only = (text: string): MergePart[] => (text === '' ? [] : [{ kind: 'clean', text }]);
	if (mine === theirs) return only(mine);
	if (mine === base) return only(theirs);
	if (theirs === base) return only(mine);

	const baseLines = splitLines(base);
	const oursRaw = diffHunks(baseLines, splitLines(mine));
	if (!oursRaw) return null;
	const othersRaw = diffHunks(baseLines, splitLines(theirs));
	if (!othersRaw) return null;
	const ours = oursRaw.flatMap(splitByLine);
	const others = othersRaw.flatMap(splitByLine);

	// 重なる塊(両側とも)に印を付ける。同じ変更は重ならない。
	const oursConflict = new Set<Hunk>();
	const othersConflict = new Set<Hunk>();
	for (const a of ours) {
		for (const b of others) {
			if (sameHunk(a, b) || !overlaps(a, b)) continue;
			oursConflict.add(a);
			othersConflict.add(b);
		}
	}

	// 重なる塊を、base の範囲が重なるか接するものでまとめる(決定④)。
	const tagged = [
		...ours.filter((h) => oursConflict.has(h)).map((hunk) => ({ hunk, side: 'mine' as const })),
		...others.filter((h) => othersConflict.has(h)).map((hunk) => ({ hunk, side: 'theirs' as const })),
	].sort((a, b) => byPosition(a.hunk, b.hunk));
	const groups: Group[] = [];
	for (const { hunk, side } of tagged) {
		const last = groups[groups.length - 1];
		if (last && hunk.from <= last.to) {
			last.to = Math.max(last.to, hunk.to);
			last[side].push(hunk);
		} else {
			groups.push({ from: hunk.from, to: hunk.to, mine: side === 'mine' ? [hunk] : [], theirs: side === 'theirs' ? [hunk] : [] });
		}
	}

	// 重ならない塊(同じ変更は 1 回だけ)と、まとめた塊を base の位置で並べる。
	const items: Item[] = groups.map((group) => ({ kind: 'group', group, from: group.from, to: group.to }));
	const cleanHunks: Hunk[] = [];
	for (const hunk of [...ours.filter((h) => !oursConflict.has(h)), ...others.filter((h) => !othersConflict.has(h))]) {
		if (cleanHunks.some((h) => sameHunk(h, hunk))) continue;
		cleanHunks.push(hunk);
	}
	for (const hunk of cleanHunks) items.push({ kind: 'hunk', hunk, from: hunk.from, to: hunk.to });
	items.sort(byPosition);

	const parts: MergePart[] = [];
	let text = '';
	const flush = () => {
		if (text !== '') parts.push({ kind: 'clean', text });
		text = '';
	};
	let at = 0;
	for (const item of items) {
		for (; at < item.from; at++) text += baseLines[at]!;
		if (item.kind === 'hunk') {
			text += item.hunk.lines.join('');
		} else {
			flush();
			const g = item.group;
			parts.push({ kind: 'conflict', mine: sideText(baseLines, g.from, g.to, g.mine), theirs: sideText(baseLines, g.from, g.to, g.theirs) });
		}
		at = Math.max(at, item.to);
	}
	for (; at < baseLines.length; at++) text += baseLines[at]!;
	flush();
	return parts;
}

/** 文字列の最後の行の改行コード(無ければ null)。 */
function trailingEol(text: string): string | null {
	const m = /(\r\n|\r|\n)$/.exec(text);
	return m ? m[1]! : null;
}

/**
 * 選びを当てた文字列(契約11)。choices[i] は i 番目の conflict(conflict だけを数えた並び)の選び。未選択(null / undefined)が
 * 残れば null。'both' は自分の後にディスク(決定⑤)。自分の版が改行で終わらずディスクの版が空でないときは、間に改行を 1 つ
 * 入れる(ディスクの版の最後の行の改行コード。無ければ '\n')。
 */
export function applyChoices(parts: readonly MergePart[], choices: ReadonlyArray<MergeChoice | null | undefined>): string | null {
	let out = '';
	let index = 0;
	for (const part of parts) {
		if (part.kind === 'clean') {
			out += part.text;
			continue;
		}
		const choice = choices[index++];
		if (choice === 'mine') out += part.mine;
		else if (choice === 'theirs') out += part.theirs;
		else if (choice === 'both') {
			const gap = part.mine !== '' && part.theirs !== '' && trailingEol(part.mine) === null ? (trailingEol(part.theirs) ?? '\n') : '';
			out += part.mine + gap + part.theirs;
		} else return null;
	}
	return out;
}

/**
 * 作り直し(契約12): 新しい塊の並びに、mine と theirs の中身が同じ古い塊の選びを引き継ぐ。古い塊は 1 回だけ使う(並びの順に)。
 * 他は null。結果の長さは新しい conflict の数。
 */
export function carryChoices(
	oldParts: readonly MergePart[],
	oldChoices: ReadonlyArray<MergeChoice | null | undefined>,
	newParts: readonly MergePart[],
): Array<MergeChoice | null> {
	const old = conflictsOf(oldParts);
	const used = old.map(() => false);
	const out: Array<MergeChoice | null> = [];
	for (const part of newParts) {
		if (part.kind !== 'conflict') continue;
		const j = old.findIndex((o, i) => !used[i] && o.mine === part.mine && o.theirs === part.theirs);
		if (j < 0) {
			out.push(null);
			continue;
		}
		used[j] = true;
		out.push(oldChoices[j] ?? null);
	}
	return out;
}
