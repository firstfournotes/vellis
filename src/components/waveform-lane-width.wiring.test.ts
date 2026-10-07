/**
 * 要件#47 追補b(2026-10-07・backlog 252)の配線テスト AC-47-追b (c)。
 * 「等倍の波形の帯の山が時間に比例して手前に寄る」の修正が、動画と音声の両ビューアの
 * 帯の描画に配線されていることをソース走査で機械判定する(Explorer.symlink-contrast /
 * Explorer.header の wiring テストと同じ作法= `.svelte` の `<script>` を読む)。
 *
 * ## 判定するもの(契約(追補b)2・3= req-47.md)
 * `VideoViewer.svelte` と `AudioViewer.svelte` のそれぞれで:
 * 1. `waveformLaneDrawWidth` を `$lib/waveform-zoom` から import し、呼んでいる
 * 2. `peakRects(` の第2引数が **その結果**(帯の幅の変数そのものではない)。
 *    受け付ける形(確定契約=implementer はこれに従う):
 *    - 第2引数に `waveformLaneDrawWidth(...)` をそのまま書く
 *    - `const laneWidth = waveformLaneDrawWidth(...)` で束ねた名前を渡す
 *    - 上のどちらかを `drawWaveform(...)` などの関数の引数に渡し、その仮引数名を
 *      `peakRects(` の第2引数に使う(仮引数 → 呼び出し側の実引数 → 束縛、と辿る)
 *    帯の幅の名前(`width` / `waveformWidth` / `seekWidth` / `canvas.width`)を
 *    第2引数に書いたままなら赤
 * 3. 描画の `$effect`(本体で `drawWaveform(` を呼ぶもの)の本体で `durationSeconds` と
 *    `barDuration` を読む(Svelte の依存追跡に入れる=要件#42 の高さ・要件#47 の倍率と
 *    同じ作法。コメントの中の語は数えない)
 *
 * ## 走査の作法
 * - `<script>` ブロックだけを読み、コメント(行コメントとブロックコメント)と文字列の
 *   中身は落としてから見る(コメントに `peakRects(` や `{#key}` が出ても数えない・
 *   括弧の対応を壊さない)
 * - `peakRects(` の実引数は括弧の対応で切り出し、深さ 0 のカンマで分ける
 *
 * ## 想定される赤(実装前)
 * 両ビューアとも `waveformLaneDrawWidth` を import していない(1 が赤)・
 * `peakRects(lanes[i], width, box.h)` と帯の幅をそのまま渡している(2 が赤)・
 * 描画 effect の本体は `waveformZoom` / `waveformWindowStart` / `waveformSeconds` までで
 * `durationSeconds` / `barDuration` を読んでいない(3 が赤)。
 *
 * ## 判定しないもの
 * - 幅の値そのもの(純関数)= `src/lib/waveform-zoom.lanewidth.acceptance.test.ts`
 * - canvas の実寸・レーンの境目の線・再生ヘッド・シークの写像が帯の幅のままであること
 *   (契約2 の「不変」)は既存の AC-41/47/50 系が見る
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VIEWERS = [
	{ name: 'VideoViewer.svelte', path: resolve(__dirname, 'VideoViewer.svelte') },
	{ name: 'AudioViewer.svelte', path: resolve(__dirname, 'AudioViewer.svelte') },
] as const;

/** 帯の幅そのもの(契約2 で「変わらない」側)。これが `peakRects(` の第2引数なら修正前。 */
const BAND_WIDTH_NAMES = new Set(['width', 'waveformWidth', 'seekWidth', 'canvas.width']);

// ---------------------------------------------------------------------------
// ソースの整形
// ---------------------------------------------------------------------------

/** `<script ...>…</script>` の中身。 */
function scriptOf(source: string, name: string): string {
	const m = source.match(/<script[^>]*>([\s\S]*?)<\/script>/);
	expect(m, `${name} に <script> ブロックがある`).not.toBeNull();
	return m![1];
}

/**
 * コメントを空白に・(`keepStrings` でなければ)文字列リテラルの中身を空に落とす
 * (位置は保たない・行は保つ)。括弧の対応と識別子の検索をコメントや文字列に
 * 惑わされずに行うため。import 元のパス(文字列)を見るときだけ中身を残す。
 */
function stripCommentsAndStrings(code: string, keepStrings = false): string {
	let out = '';
	let i = 0;
	while (i < code.length) {
		const ch = code[i];
		const next = code[i + 1];
		if (ch === '/' && next === '/') {
			while (i < code.length && code[i] !== '\n') i++;
			continue;
		}
		if (ch === '/' && next === '*') {
			const end = code.indexOf('*/', i + 2);
			const stop = end < 0 ? code.length : end + 2;
			for (; i < stop; i++) out += code[i] === '\n' ? '\n' : ' ';
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			const quote = ch;
			out += quote;
			i++;
			while (i < code.length && code[i] !== quote) {
				if (code[i] === '\\') {
					if (keepStrings) out += code[i];
					i++;
				}
				if (keepStrings) out += code[i] ?? '';
				else if (code[i] === '\n') out += '\n';
				i++;
			}
			out += quote;
			i++;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** `open` の位置(`(` または `{`)から対応する閉じ括弧までの中身。 */
function balanced(code: string, open: number, pair: '()' | '{}'): string {
	const [lhs, rhs] = pair;
	expect(code[open], `位置 ${open} は ${lhs}`).toBe(lhs);
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === lhs) depth++;
		else if (code[i] === rhs) {
			depth--;
			if (depth === 0) return code.slice(open + 1, i);
		}
	}
	throw new Error(`${lhs} に対応する ${rhs} が無い(位置 ${open})`);
}

/** 深さ 0 のカンマで分ける(括弧・角括弧・波括弧・山括弧の中では切らない)。 */
function splitTopLevel(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of list) {
		if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
		if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth--;
		if (ch === ',' && depth === 0) {
			out.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim().length > 0) out.push(current.trim());
	return out;
}

/** `name(` の呼び出し(定義 `function name(` は除く)ごとの実引数の列。 */
function callArgs(code: string, name: string): string[][] {
	const calls: string[][] = [];
	const re = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g');
	for (let m = re.exec(code); m !== null; m = re.exec(code)) {
		const before = code.slice(Math.max(0, m.index - 12), m.index);
		if (/function\s+$/.test(before)) continue;
		const open = m.index + m[0].length - 1;
		calls.push(splitTopLevel(balanced(code, open, '()')));
	}
	return calls;
}

/** `function name(params)` の仮引数名の列(型注釈と既定値を落とす)。 */
function paramNames(code: string, name: string): string[] | null {
	const re = new RegExp(`function\\s+${name}\\s*\\(`);
	const m = re.exec(code);
	if (!m) return null;
	const open = m.index + m[0].length - 1;
	return splitTopLevel(balanced(code, open, '()')).map((p) =>
		p
			.replace(/[?:=][\s\S]*$/, '')
			.trim(),
	);
}

/** `expr` が直接か名前経由かで `waveformLaneDrawWidth(...)` の結果か。 */
function derivesFromLaneDrawWidth(code: string, expr: string, depth = 0): boolean {
	const text = expr.trim();
	if (/^waveformLaneDrawWidth\s*\(/.test(text)) return true;
	if (depth > 4) return false;
	if (!/^[A-Za-z_$][\w$]*$/.test(text)) return false;

	// `const name = <expr>;` / `let name = <expr>;`
	const binding = new RegExp(`\\b(?:const|let)\\s+${text}\\s*(?::[^=;]+)?=\\s*([^;]+);`);
	const b = binding.exec(code);
	if (b && derivesFromLaneDrawWidth(code, b[1], depth + 1)) return true;

	// 関数の仮引数 → その関数の呼び出し側の実引数を辿る。
	const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
	for (let f = fnRe.exec(code); f !== null; f = fnRe.exec(code)) {
		const fn = f[1];
		const params = paramNames(code, fn);
		if (!params) continue;
		const k = params.indexOf(text);
		if (k < 0) continue;
		for (const args of callArgs(code, fn)) {
			if (args[k] !== undefined && derivesFromLaneDrawWidth(code, args[k], depth + 1)) return true;
		}
	}
	return false;
}

/** `$effect(() => { … })` の本体のうち、`drawWaveform(` を呼ぶもの(=帯の描画 effect)。 */
function drawingEffectBody(code: string, name: string): string {
	const bodies: string[] = [];
	const re = /\$effect\s*\(\s*\(\s*\)\s*=>\s*\{/g;
	for (let m = re.exec(code); m !== null; m = re.exec(code)) {
		const open = m.index + m[0].length - 1;
		bodies.push(balanced(code, open, '{}'));
	}
	const drawing = bodies.filter((body) => /(?<![\w$.])drawWaveform\s*\(/.test(body));
	expect(drawing, `${name} に drawWaveform( を呼ぶ描画 $effect がちょうど1つある`).toHaveLength(1);
	return drawing[0];
}

/** `$lib/waveform-zoom` からの import に `name` が含まれるか。 */
function importsFromWaveformZoom(code: string, name: string): boolean {
	const re = /import\s*\{([\s\S]*?)\}\s*from\s*['"]\$lib\/waveform-zoom['"]/g;
	for (let m = re.exec(code); m !== null; m = re.exec(code)) {
		const names = m[1].split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]);
		if (names.includes(name)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

for (const viewer of VIEWERS) {
	describe(`AC-47-追b (c): ${viewer.name} の帯は waveformLaneDrawWidth の幅でレーンの山を割り付ける`, () => {
		/** コメントと文字列の中身を落としたスクリプト(括弧の対応・引数の切り出し用)。 */
		const code = () => stripCommentsAndStrings(scriptOf(readFileSync(viewer.path, 'utf8'), viewer.name));
		/** コメントだけを落としたスクリプト(import 元のパス=文字列を見る用)。 */
		const codeWithStrings = () =>
			stripCommentsAndStrings(scriptOf(readFileSync(viewer.path, 'utf8'), viewer.name), true);

		it('waveformLaneDrawWidth を $lib/waveform-zoom から import している', () => {
			expect(importsFromWaveformZoom(codeWithStrings(), 'waveformLaneDrawWidth')).toBe(true);
		});

		it('waveformLaneDrawWidth を呼んでいる(import するだけではない)', () => {
			expect(callArgs(code(), 'waveformLaneDrawWidth').length).toBeGreaterThanOrEqual(1);
		});

		it('peakRects( の第2引数は帯の幅の変数そのものではない', () => {
			const calls = callArgs(code(), 'peakRects');
			expect(calls.length, 'peakRects( の呼び出しが1つ以上ある').toBeGreaterThanOrEqual(1);
			for (const args of calls) {
				expect(args.length, 'peakRects は (peaks, width, height) の3引数').toBe(3);
				expect(
					BAND_WIDTH_NAMES.has(args[1]),
					`peakRects の第2引数 \`${args[1]}\` が帯の幅そのものになっている(修正前の形)`,
				).toBe(false);
			}
		});

		it('peakRects( の第2引数は waveformLaneDrawWidth の結果(直接・const 束縛・関数の引数経由のいずれか)', () => {
			const source = code();
			const calls = callArgs(source, 'peakRects');
			expect(calls.length).toBeGreaterThanOrEqual(1);
			for (const args of calls) {
				expect(
					derivesFromLaneDrawWidth(source, args[1]),
					`peakRects の第2引数 \`${args[1]}\` が waveformLaneDrawWidth(...) の結果に辿り着かない`,
				).toBe(true);
			}
		});

		it('描画の $effect の本体で durationSeconds と barDuration を読む(依存追跡に入れる)', () => {
			const body = drawingEffectBody(code(), viewer.name);
			expect(/(?<![\w$])durationSeconds(?![\w$])/.test(body), '描画 effect の本体に durationSeconds').toBe(
				true,
			);
			expect(/(?<![\w$])barDuration(?![\w$])/.test(body), '描画 effect の本体に barDuration').toBe(true);
		});
	});
}
