/**
 * 行の差分(要件#74 契約13・契約19・第4段 4-1・由谷の決定 4-2=自前・依存なし)。3 方向マージ(`merge.ts`)と差分表示
 * (`EditorDiffView.svelte`)が共有する。行は改行コード(`\r\n`・`\r`・`\n`)を含めて 1 行(`a\r\n` と `a\n` は別の行)。
 * 差分は Myers の O(ND)。編集の距離が上限(`MAX_EDIT_DISTANCE`)を超えたら null。
 */

/** Myers の差分で辿る編集の距離の上限。超えたら conflict として扱う。 */
export const MAX_EDIT_DISTANCE = 4000;

/** 行(終端の改行を含む)に割る。末尾の空の行は数えない。 */
export function splitLines(text: string): string[] {
	const out: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === 13) {
			if (text.charCodeAt(i + 1) === 10) i++;
			out.push(text.slice(start, i + 1));
			start = i + 1;
		} else if (c === 10) {
			out.push(text.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < text.length) out.push(text.slice(start));
	return out;
}

/** base の `[from, to)` の行を `lines` に置き換える塊。 */
export interface Hunk {
	from: number;
	to: number;
	lines: string[];
}

/** a → b の差分を塊にする。距離が上限を超えたら null。 */
export function diffHunks(a: string[], b: string[]): Hunk[] | null {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const n = endA - start;
	const m = endB - start;
	if (n === 0 && m === 0) return [];
	if (n === 0) return [{ from: start, to: start, lines: b.slice(start, endB) }];
	if (m === 0) return [{ from: start, to: endA, lines: [] }];

	// Myers の O(ND)。trace に各段の V を写して、後ろから辿る。
	const max = Math.min(n + m, MAX_EDIT_DISTANCE);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let found = false;
	for (let d = 0; d <= max && !found; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
			else x = v[offset + k - 1]! + 1;
			let y = x - k;
			while (x < n && y < m && a[start + x] === b[start + y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = true;
				break;
			}
		}
	}
	if (!found) return null;

	// 後ろから辿って、base の行ごとの「残す / 消す」と b の行ごとの「足す」を集める。
	type Op = { kind: 'keep' | 'del' | 'ins'; a: number; b: number };
	const ops: Op[] = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const vd = trace[d]!;
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
		else prevK = k - 1;
		const prevX = d === 0 ? 0 : vd[offset + prevK]!;
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
			ops.push({ kind: 'keep', a: x, b: y });
		}
		if (d === 0) break;
		if (x === prevX) ops.push({ kind: 'ins', a: x, b: --y });
		else ops.push({ kind: 'del', a: --x, b: y });
		x = prevX;
		y = prevY;
	}
	ops.reverse();

	const hunks: Hunk[] = [];
	let current: Hunk | null = null;
	for (const op of ops) {
		if (op.kind === 'keep') {
			if (current) hunks.push(current);
			current = null;
			continue;
		}
		if (!current) current = { from: start + op.a, to: start + op.a, lines: [] };
		if (op.kind === 'del') current.to = start + op.a + 1;
		else current.lines.push(b[start + op.b]!);
	}
	if (current) hunks.push(current);
	return hunks;
}

/** 差分の上限(merge.ts と同じ 4000)。 */
export const MAX_LINE_DIFF_DISTANCE = MAX_EDIT_DISTANCE;

/** a の行 [aStart, aStart + aLines.length) を bLines に置き換える塊。行は行末の改行コードを含む。行番号は 0 始まり。 */
export interface DiffHunk {
	aStart: number;
	aLines: string[];
	bStart: number;
	bLines: string[];
}

/** a → b の行の差分(塊は a の順・重ならない・空の塊は無い)。編集の距離が上限を超えたら null。同じなら []。 */
export function lineDiff(a: string, b: string): DiffHunk[] | null {
	const aLines = splitLines(a);
	const bLines = splitLines(b);
	const hunks = diffHunks(aLines, bLines);
	if (hunks === null) return null;
	const out: DiffHunk[] = [];
	let delta = 0;
	for (const h of hunks) {
		const removed = aLines.slice(h.from, h.to);
		if (removed.length === 0 && h.lines.length === 0) continue;
		out.push({ aStart: h.from, aLines: removed, bStart: h.from + delta, bLines: [...h.lines] });
		delta += h.lines.length - removed.length;
	}
	return out;
}
