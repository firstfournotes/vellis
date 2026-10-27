/**
 * 要件#50 追補f(2026-10-25・Issue #505)の受け入れテスト AC-50-追f (a)(b)(c) — ソース走査。
 * 正本: docs/requirements/req-50.md「追補f」契約 1〜3。
 *
 * 「2 時間級の素材を拡大しているとき、波形の高さのドラッグがカクつく」―― 描画の `$effect` が
 * 幅・高さにも依存し、そのたびに `windowLanes`(保持している標本の O(n) の走査)を計算し直すのが
 * 原因。追補f は `windowLanes(ready, zoom, start, seconds)` の計算を `$derived` に分け、描画の
 * `$effect` はその値を読んで描くだけにする(`AudioViewer.svelte` と `VideoViewer.svelte` の両方)。
 *
 * ## 判定するもの(両ビューア・`<script>` の走査= waveform-lane-width.wiring.test.ts の作法)
 * - (a) `windowLanes(` を呼ぶのは `$derived(` / `$derived.by(` の中だけ。描画の `$effect`
 *   (本体で `drawWaveform(` を呼ぶもの)の本体には `windowLanes(` が無い
 * - (b) その `$derived` の式は帯の幅・高さ・横軸の尺(`waveformWidth` / `waveformHeight` /
 *   `barDuration` / `waveformCanvas` / `seekWidth`)を読まない。依存は波形の結果・ズーム・窓の始まり・
 *   窓の秒数(`waveform` / `waveformZoom` / `waveformWindowStart` / `waveformSeconds`)に閉じる
 * - (c) 描画の `$effect` の本体はその `$derived` の変数名を読む。幅と高さ(`waveformWidth` /
 *   `waveformHeight`)も読み続ける(不変: 高さのドラッグで描き直す)
 * - 不変: `function windowLanes(` の中身(標本の集め方)は変えない=`windowPeaks(` と
 *   `windowPeaksFromCoarse(` の呼び出しは `windowLanes` の本体の中だけに残る
 *
 * ## 確定契約(implementer はこれに従う)
 * - `let <name> = $derived(…windowLanes(…)…)` か `let <name> = $derived.by(() => { … windowLanes(…) … })`
 *   を両ビューアに置く(名前は自由。例: `waveformLanes`)。`ready` の判定(`result?.state === 'ready'`)
 *   は `$derived` の中で行ってよい(波形の結果は依存に含まれる)
 * - 描画の `$effect` は `windowLanes(` を呼ばず、`<name>` を読んで `drawWaveform(canvas, <name>, …)` へ渡す
 * - `function windowLanes(…)` の中身は無改変
 *
 * ## 実装前の見込み(赤の理由)
 * 両ビューアとも `windowLanes(` の呼び出しは描画の `$effect` の中にあり、`$derived` の中には無い
 * ((a) が赤・(c) は `$derived` が見つからず赤)。(b) も `$derived` が無いので赤。不変のケースは緑。
 *
 * ## 判定しないもの
 * - 描かれる絵が同じこと(契約 2)= 既存の AC-47/50 系の wiring テストが無改変で緑(AC (d))
 * - 高さのドラッグで `windowLanes` が走り直さないこと(振る舞い)= AudioViewer.window-lanes.wiring.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VIEWERS = [
	{ name: 'VideoViewer.svelte', path: resolve(__dirname, 'VideoViewer.svelte') },
	{ name: 'AudioViewer.svelte', path: resolve(__dirname, 'AudioViewer.svelte') },
] as const;

/** 幅・高さ・横軸の尺=`$derived` が読んではいけない名前(契約 1)。 */
const SIZE_NAMES = ['waveformWidth', 'waveformHeight', 'barDuration', 'waveformCanvas', 'seekWidth'] as const;

// ---------------------------------------------------------------------------
// ソースの整形(waveform-lane-width.wiring.test.ts の写し)
// ---------------------------------------------------------------------------

/** `<script ...>…</script>` の中身。 */
function scriptOf(source: string, name: string): string {
	const m = source.match(/<script[^>]*>([\s\S]*?)<\/script>/);
	expect(m, `${name} に <script> ブロックがある`).not.toBeNull();
	return m![1];
}

/** コメントを空白に・文字列リテラルの中身を空白に落とす(位置と改行は保つ)。 */
function stripCommentsAndStrings(code: string): string {
	let out = '';
	let i = 0;
	const blank = (c: string) => (c === '\n' ? '\n' : ' ');
	while (i < code.length) {
		const ch = code[i];
		const next = code[i + 1];
		if (ch === '/' && next === '/') {
			while (i < code.length && code[i] !== '\n') {
				out += ' ';
				i++;
			}
			continue;
		}
		if (ch === '/' && next === '*') {
			const end = code.indexOf('*/', i + 2);
			const stop = end < 0 ? code.length : end + 2;
			for (; i < stop; i++) out += blank(code[i]);
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			const quote = ch;
			out += quote;
			i++;
			while (i < code.length && code[i] !== quote) {
				if (code[i] === '\\') {
					out += ' ';
					i++;
					if (i >= code.length) break;
				}
				out += blank(code[i]);
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

/** `open` の位置(`(` または `{`)から対応する閉じ括弧までの範囲 [open, close]。 */
function balancedRange(code: string, open: number): [number, number] {
	const lhs = code[open];
	expect(lhs === '(' || lhs === '{', `位置 ${open} は ( か {`).toBe(true);
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		const c = code[i];
		if (c === '(' || c === '{' || c === '[') depth++;
		else if (c === ')' || c === '}' || c === ']') {
			depth--;
			if (depth === 0) return [open, i];
		}
	}
	throw new Error(`${lhs} に対応する閉じ括弧が無い(位置 ${open})`);
}

/** `name(` の呼び出し位置の列(定義 `function name(` は除く)。 */
function callSites(code: string, name: string): number[] {
	const out: number[] = [];
	const re = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g');
	for (let m = re.exec(code); m !== null; m = re.exec(code)) {
		const before = code.slice(Math.max(0, m.index - 12), m.index);
		if (/function\s+$/.test(before)) continue;
		out.push(m.index);
	}
	return out;
}

type Derived = { name: string | null; range: [number, number]; body: string };

/** `$derived(…)` と `$derived.by(…)` のそれぞれ(束ねる変数名・範囲・式の本文)。 */
function deriveds(code: string): Derived[] {
	const out: Derived[] = [];
	const re = /\$derived(?:\.by)?\s*\(/g;
	for (let m = re.exec(code); m !== null; m = re.exec(code)) {
		const open = m.index + m[0].length - 1;
		const range = balancedRange(code, open);
		const head = code.slice(Math.max(0, m.index - 120), m.index);
		const bind = /(?:let|const)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*$/.exec(head);
		out.push({ name: bind ? bind[1] : null, range, body: code.slice(range[0] + 1, range[1]) });
	}
	return out;
}

/** `$effect(() => { … })` の本体のうち `drawWaveform(` を呼ぶもの(=帯の描画 effect)。 */
function drawingEffectBody(code: string, name: string): string {
	const bodies: string[] = [];
	const re = /\$effect\s*\(\s*\(\s*\)\s*=>\s*\{/g;
	for (let m = re.exec(code); m !== null; m = re.exec(code)) {
		const open = m.index + m[0].length - 1;
		const [s, e] = balancedRange(code, open);
		bodies.push(code.slice(s + 1, e));
	}
	const drawing = bodies.filter((body) => /(?<![\w$.])drawWaveform\s*\(/.test(body));
	expect(drawing, `${name} に drawWaveform( を呼ぶ描画 $effect がちょうど1つある`).toHaveLength(1);
	return drawing[0];
}

/**
 * `function windowLanes(…) { … }` の本体。引数の型 `WaveformResult & { state: 'ready' }` にも
 * `{` があるので、本体の始まりは**引数リストの閉じ括弧(括弧の対応で探す)の後ろ**の最初の `{`
 * (戻り値の型 `: WaveformPeaks[]` を挟む)。
 */
function windowLanesBody(code: string, name: string): string {
	const m = /function\s+windowLanes\s*\(/.exec(code);
	expect(m, `${name} に function windowLanes( がある(不変)`).not.toBeNull();
	const paramsOpen = m!.index + m![0].length - 1;
	const [, paramsClose] = balancedRange(code, paramsOpen);
	const open = code.indexOf('{', paramsClose + 1);
	expect(open, `${name} の function windowLanes(…) に本体の { がある`).toBeGreaterThan(paramsClose);
	const [s, e] = balancedRange(code, open);
	return code.slice(s + 1, e);
}

const reads = (body: string, ident: string) => new RegExp(`(?<![\\w$.])${ident}(?![\\w$])`).test(body);

/**
 * `body` が `ident` を直接読むか、`body` が読む別の `$derived` の名前(1〜2 段)を通して読むか
 * (例: `let waveformReady = $derived(waveform?.state === 'ready' ? waveform : null)` を
 * `windowLanes(waveformReady, …)` に渡す形)。
 */
function readsVia(src: string, body: string, ident: string, depth = 0): boolean {
	if (reads(body, ident)) return true;
	if (depth >= 2) return false;
	return deriveds(src).some((d) => d.name !== null && reads(body, d.name) && readsVia(src, d.body, ident, depth + 1));
}

/** 深さ 0 のカンマで分ける。 */
function splitTopLevel(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of list) {
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		if (ch === ')' || ch === ']' || ch === '}') depth--;
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

/** `windowLanes(` を呼ぶ `$derived`(ちょうど 1 つを期待)。 */
function lanesDerived(code: string, name: string): Derived {
	const hits = deriveds(code).filter((d) => callSites(d.body, 'windowLanes').length > 0);
	expect(hits, `${name}: windowLanes( を呼ぶ $derived がちょうど 1 つある`).toHaveLength(1);
	return hits[0];
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

for (const viewer of VIEWERS) {
	describe(`AC-50-追f: ${viewer.name} の windowLanes は $derived で計算し、描画の $effect はその値を読む`, () => {
		const code = () => stripCommentsAndStrings(scriptOf(readFileSync(viewer.path, 'utf8'), viewer.name));

		it('(a) windowLanes( の呼び出しはすべて $derived / $derived.by の中にある', () => {
			const src = code();
			const sites = callSites(src, 'windowLanes');
			expect(sites.length, 'windowLanes( の呼び出しが 1 つ以上ある').toBeGreaterThanOrEqual(1);
			const ranges = deriveds(src).map((d) => d.range);
			for (const at of sites) {
				const inside = ranges.some(([s, e]) => at > s && at < e);
				const line = src.slice(0, at).split('\n').length;
				expect(inside, `${viewer.name}:${line} の windowLanes( が $derived の外にある(描画の $effect の中=修正前の形)`).toBe(true);
			}
		});

		it('(a) 描画の $effect の本体に windowLanes( が無い', () => {
			const body = drawingEffectBody(code(), viewer.name);
			expect(callSites(body, 'windowLanes'), '描画 effect の中で windowLanes を呼ばない').toHaveLength(0);
		});

		it('(b) その $derived は幅・高さ・横軸の尺(waveformWidth / waveformHeight / barDuration / waveformCanvas / seekWidth)を読まない', () => {
			const d = lanesDerived(code(), viewer.name);
			for (const ident of SIZE_NAMES) {
				expect(reads(d.body, ident), `$derived の中で ${ident} を読んでいる(高さのドラッグで集め直してしまう)`).toBe(false);
			}
		});

		it('(b) その $derived の依存は波形の結果・ズーム・窓の始まり・窓の秒数(直接か、それらを束ねた名前経由)', () => {
			const src = code();
			const d = lanesDerived(src, viewer.name);
			// `windowLanes(ready, zoom, start, seconds)` の 4 引数を渡している(中身は不変)。
			const call = callSites(d.body, 'windowLanes')[0];
			const [s, e] = balancedRange(d.body, d.body.indexOf('(', call));
			const args = splitTopLevel(d.body.slice(s + 1, e));
			expect(args, 'windowLanes(result, zoom, start, seconds) の 4 引数').toHaveLength(4);
			// 波形の結果・ズーム・窓の始まり・窓の秒数を($derived の式か、それを束ねた別の $derived 経由で)読む。
			expect(readsVia(src, d.body, 'waveform'), '$derived は波形の結果 waveform を読む').toBe(true);
			expect(readsVia(src, d.body, 'waveformZoom'), '$derived はズーム waveformZoom を読む').toBe(true);
			expect(readsVia(src, d.body, 'waveformWindowStart'), '$derived は窓の始まり waveformWindowStart を読む').toBe(true);
			expect(readsVia(src, d.body, 'waveformSeconds'), '$derived は窓の秒数 waveformSeconds を読む').toBe(true);
		});

		it('(c) 描画の $effect の本体はその $derived の値を読み、幅と高さも読み続ける(高さのドラッグで描き直す)', () => {
			const src = code();
			const d = lanesDerived(src, viewer.name);
			expect(d.name, '$derived は let/const で名前に束ねる(描画 effect が読むため)').not.toBeNull();
			const body = drawingEffectBody(src, viewer.name);
			expect(reads(body, d.name!), `描画 effect の本体が ${d.name} を読む`).toBe(true);
			expect(reads(body, 'waveformWidth'), '描画 effect は幅を読み続ける').toBe(true);
			expect(reads(body, 'waveformHeight'), '描画 effect は高さを読み続ける').toBe(true);
			// 描く材料として drawWaveform( に渡っている(読んで捨てていない)。
			const drawAt = callSites(body, 'drawWaveform')[0];
			const [s, e] = balancedRange(body, body.indexOf('(', drawAt));
			expect(reads(body.slice(s + 1, e), d.name!), `drawWaveform( の引数に ${d.name} を渡す`).toBe(true);
		});

		it('不変: windowLanes の中身は変えない(標本の集め方=windowPeaks / windowPeaksFromCoarse の呼び出しは windowLanes の本体の中だけ)', () => {
			const src = code();
			const body = windowLanesBody(src, viewer.name);
			expect(callSites(body, 'windowPeaks')).toHaveLength(1);
			expect(callSites(body, 'windowPeaksFromCoarse')).toHaveLength(1);
			expect(callSites(src, 'windowPeaks'), 'windowPeaks( は windowLanes の中の 1 回だけ').toHaveLength(1);
			expect(callSites(src, 'windowPeaksFromCoarse'), 'windowPeaksFromCoarse( は windowLanes の中の 1 回だけ').toHaveLength(1);
			// 等倍は解析済みの lanes をそのまま返す経路が残る。
			expect(body).toMatch(/zoom\s*<=\s*1/);
			expect(body).toContain('return result.lanes');
		});
	});
}
