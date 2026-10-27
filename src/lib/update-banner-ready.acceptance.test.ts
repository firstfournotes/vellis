/**
 * 要件#14 追補b(2026-10-25・Issue #393)の受け入れテスト — フロント(AC-14-追b (c)・ソース走査)。
 * 正本: docs/requirements/req-14.md「追補b」契約 2。
 *
 * 「更新を確かめた後に開いた窓には、更新のバナーが出ない」―― Tauri の event は貯まらないので、
 * 窓は `update_available` の listen を**登録し終えたあと**に、自分の窓の label を payload にした
 * `update_banner_ready` を emit し、Rust が覚えている payload をその窓だけへ送り直してもらう。
 *
 * ## 判定するもの(`src/routes/+page.svelte` の走査= open-failure.acceptance.test.ts の作法)
 * - (c)1 `update_banner_ready` の emit がちょうど 1 つあり、event 名は定数で持つ
 *   (`+page.svelte` の `const X = 'update_banner_ready'` か、`$lib/...` から import した
 *   `export const X = 'update_banner_ready'`。文字列リテラルを直に書いた形も受け付ける)
 * - (c)2 その emit の payload(第 2 引数)は窓の label(`.label` を読む式か、それを束ねた変数)
 * - (c)3 その emit は `update_available` の `await listen(...)` の**後ろ**にある(listen より前に
 *   emit しない=前に emit すると答えが届いても listener が無く、取りこぼす)
 * - 不変: `update_available` の listen は残り、payload を `updateBanner` に入れ直すだけ(1 枚のまま)
 *
 * ## 確定契約(implementer はこれに従う)
 * - event 名の値は Rust の `UPDATE_BANNER_READY_EVENT` と同じ `'update_banner_ready'`
 *   (Rust 側は acceptance_req14b.rs が固定)
 * - emit の口は問わない: `emit` from `@tauri-apps/api/event`・`getCurrentWindow().emit`・
 *   `getCurrentWebviewWindow().emit`・`$lib/events` に足した `emit` のどれでもよい。
 *   `emitTo` は使わない(Rust は app に対する listen で受ける)
 * - label は `getCurrentWindow().label` / `getCurrentWebviewWindow().label`(ハードコードしない)
 * - Tauri command は足さない(走査は `invoke(` の新規追加を見ないが、Rust 側の
 *   acceptance_req14b.rs と既存の AC-60-20 が固定する)
 *
 * ## 走査の作法
 * コメントと文字列の中身を落とした版で括弧の対応と呼び出しの位置を取り、同じ位置から
 * 文字列を残した版を切り出して引数の字面(event 名・import 元)を読む(両方とも位置を保つ整形)。
 *
 * ## 実装前の見込み(赤の理由)
 * `+page.svelte` に emit の呼び出しが 1 つも無い((c)1〜3 が赤)。不変のケースは実装前から緑。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const PAGE_PATH = resolve(__dirname, '../routes/+page.svelte');
const EVENT_NAME = 'update_banner_ready';

// ---------------------------------------------------------------------------
// ソースの整形(waveform-lane-width.wiring.test.ts の写し。どちらも位置を保つ)
// ---------------------------------------------------------------------------

/** `<script ...>…</script>` の中身(最初のブロック=`lang="ts"` のもの)。 */
function scriptOf(source: string): string {
	const m = source.match(/<script[^>]*>([\s\S]*?)<\/script>/);
	expect(m, '+page.svelte に <script> ブロックがある').not.toBeNull();
	return m![1];
}

/**
 * コメントを空白に落とす。`keepStrings` が偽なら文字列リテラルの中身も空白に落とす
 * (括弧の対応をコメントや文字列に惑わされないため)。どちらも文字数と改行の位置を保つ。
 */
function stripComments(code: string, keepStrings: boolean): string {
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
					out += keepStrings ? code[i] : blank(code[i]);
					i++;
					if (i >= code.length) break;
				}
				out += keepStrings ? code[i] : blank(code[i]);
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

/** `open`(`(`)から対応する `)` までの中身の長さ(`(` の直後から `)` の直前まで)。 */
function balancedLength(code: string, open: number): number {
	expect(code[open]).toBe('(');
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		const c = code[i];
		if (c === '(' || c === '{' || c === '[') depth++;
		else if (c === ')' || c === '}' || c === ']') {
			depth--;
			if (depth === 0) return i - open - 1;
		}
	}
	throw new Error(`unbalanced call at ${open}`);
}

/** 深さ 0 のカンマで分けた各引数の [始点, 終点)(`inner` の中の位置・前後の空白は詰める)。 */
function splitRanges(inner: string): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	let depth = 0;
	let start = 0;
	const push = (s: number, e: number) => {
		while (s < e && /\s/.test(inner[s])) s++;
		while (e > s && /\s/.test(inner[e - 1])) e--;
		if (e > s) out.push([s, e]);
	};
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;
		else if (ch === ',' && depth === 0) {
			push(start, i);
			start = i + 1;
		}
	}
	push(start, inner.length);
	return out;
}

type Call = { at: number; end: number; args: string[] };

/** 位置 `open` の `(` から始まる呼び出しの引数(文字列を残した字面)と終わり。 */
function callAt(stripped: string, withStrings: string, at: number, open: number): Call {
	const len = balancedLength(stripped, open);
	const inner = stripped.slice(open + 1, open + 1 + len);
	const args = splitRanges(inner).map(([s, e]) => withStrings.slice(open + 1 + s, open + 1 + e));
	return { at, end: open + len + 2, args };
}

/** `emit(` の呼び出し(`.emit(` と素の `emit(` の両方。`emitTo(` / `onemit` は含めない)。 */
function emitCalls(stripped: string, withStrings: string): Call[] {
	const out: Call[] = [];
	const re = /(?<![\w$])emit\s*\(/g;
	for (let m = re.exec(stripped); m !== null; m = re.exec(stripped)) {
		out.push(callAt(stripped, withStrings, m.index, m.index + m[0].length - 1));
	}
	return out;
}

/** `await listen<…>('update_available', …)` の呼び出し。無ければ落とす(不変の確認)。 */
function updateAvailableListen(stripped: string, withStrings: string): Call {
	const re = /\bawait\s+listen(?:<[^(]*?>)?\s*\(/g;
	for (let hit = re.exec(stripped); hit !== null; hit = re.exec(stripped)) {
		const call = callAt(stripped, withStrings, hit.index, hit.index + hit[0].length - 1);
		if (call.args[0] === "'update_available'" || call.args[0] === '"update_available"') return call;
	}
	throw new Error("+page.svelte must keep `await listen<…>('update_available', …)` (不変)");
}

/**
 * 式 `expr` が event 名 `'update_banner_ready'` に解決するか。
 * - 文字列リテラルそのもの
 * - `+page.svelte` の `const <id> = 'update_banner_ready'`
 * - `import { <id> } from '$lib/<mod>'` の先の `export const <id> = 'update_banner_ready'`
 */
function resolvesToEventName(withStrings: string, expr: string): boolean {
	const text = expr.trim();
	if (text === `'${EVENT_NAME}'` || text === `"${EVENT_NAME}"`) return true;
	if (!/^[A-Za-z_$][\w$]*$/.test(text)) return false;
	const local = new RegExp(`\\bconst\\s+${text}\\s*(?::[^=]+)?=\\s*['"]${EVENT_NAME}['"]`);
	if (local.test(withStrings)) return true;
	const imp = new RegExp(`import\\s*\\{[^}]*\\b${text}\\b[^}]*\\}\\s*from\\s*['"]\\$lib\\/([\\w./-]+)['"]`);
	const m = imp.exec(withStrings);
	if (!m) return false;
	const base = resolve(__dirname, m[1]);
	const candidates = [base, `${base}.ts`, `${base}.svelte.ts`, resolve(base, 'index.ts')];
	const file = candidates.find((p) => existsSync(p) && statSync(p).isFile());
	if (!file) return false;
	const mod = stripComments(readFileSync(file, 'utf-8'), true);
	return new RegExp(`export\\s+const\\s+${text}\\s*(?::[^=]+)?=\\s*['"]${EVENT_NAME}['"]`).test(mod);
}

/** 式 `expr` が窓の label(`.label` を読む式、またはそれを束ねた `const`/`let` の変数)か。 */
function isWindowLabel(stripped: string, expr: string, depth = 0): boolean {
	const text = expr.trim();
	if (/\.label\b/.test(text)) return true;
	if (depth > 3 || !/^[A-Za-z_$][\w$]*$/.test(text)) return false;
	const binding = new RegExp(`\\b(?:const|let)\\s+${text}\\s*(?::[^=;]+)?=\\s*([^;]+);`);
	const b = binding.exec(stripped);
	return b !== null && isWindowLabel(stripped, b[1], depth + 1);
}

/** 走査の材料: 文字列を落とした版(位置・括弧)と残した版(字面)。 */
function sources(): { stripped: string; withStrings: string } {
	const script = scriptOf(readFileSync(PAGE_PATH, 'utf-8'));
	const stripped = stripComments(script, false);
	const withStrings = stripComments(script, true);
	expect(withStrings.length, '2 つの整形は位置を保つ').toBe(stripped.length);
	return { stripped, withStrings };
}

/** `update_banner_ready` を送る emit(event 名で絞る)。 */
function bannerReadyEmits(): { calls: Call[]; stripped: string; withStrings: string } {
	const { stripped, withStrings } = sources();
	const calls = emitCalls(stripped, withStrings).filter(
		(c) => c.args.length >= 1 && resolvesToEventName(withStrings, c.args[0]),
	);
	return { calls, stripped, withStrings };
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

describe('AC-14-追b (c): +page.svelte は update_available の listen の後に、窓の label を payload にして update_banner_ready を emit する', () => {
	test('(c)1 update_banner_ready の emit がちょうど 1 つあり、event 名は定数(または同じ綴りのリテラル)。emitTo は使わない', () => {
		const { calls, stripped } = bannerReadyEmits();
		expect(calls, `exactly one emit(<${EVENT_NAME}>, …) in +page.svelte (found ${calls.length})`).toHaveLength(1);
		expect(stripped, 'emitTo is not the way to ask (Rust listens on the app)').not.toMatch(/\bemitTo\s*\(/);
	});

	test('(c)2 その emit の payload は窓の label(.label を読む式か、それを束ねた変数)で、ハードコードではない', () => {
		const { calls, stripped } = bannerReadyEmits();
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call.args.length, 'emit(event, payload) の 2 引数').toBe(2);
		expect(
			isWindowLabel(stripped, call.args[1]),
			`the payload \`${call.args[1]}\` must be the current window's label (…\`.label\`)`,
		).toBe(true);
		expect(call.args[1]).not.toMatch(/^['"][^'"]*['"]$/);
	});

	test("(c)3 その emit は `await listen('update_available', …)` の後ろにある(前にも、handler の中にも無い)", () => {
		const { calls, stripped, withStrings } = bannerReadyEmits();
		const listen = updateAvailableListen(stripped, withStrings);
		expect(calls).toHaveLength(1);
		expect(
			calls[0].at,
			'the banner_ready emit must come after the awaited update_available listen (an answer before the listener exists is lost)',
		).toBeGreaterThan(listen.end);
	});

	test('不変: update_available の listen は await され、payload を updateBanner に入れ直すだけ(バナーは 1 枚のまま)', () => {
		const { stripped, withStrings } = sources();
		const listen = updateAvailableListen(stripped, withStrings);
		expect(listen.args.length).toBe(2);
		expect(listen.args[1]).toMatch(/updateBanner\s*=\s*e\.payload\b/);
	});
});
