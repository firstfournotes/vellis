/**
 * 要件#38 追補h の受け入れテスト(docs/requirements/req-38.md「追補h(2026-10-07・backlog 244)」)
 * — Viewer の配線(AC-38-追h (b)。component プロジェクト・ソース読みだけでマウントしない=
 * Explorer.symlink-contrast.wiring.test.ts / Viewer.findfix.wiring.test.ts の AC-54c-1 と同じ家風)
 *
 * 純関数 `holdScrollForPrint` の契約は `src/lib/print-scroll.acceptance.test.ts`(unit)で判定する。
 * ここは `Viewer.svelte` が mount 時にそれを `window` と `viewerEl` で呼び、破棄時に外すことを
 * ソース走査で固定する(契約(追補h)2)。jsdom は `beforeprint` / `afterprint` を出さず、
 * 印刷の挙動はマウントしても判定できないため、配線はソースで見る。
 *
 * ## 判定するもの(AC-38-追h (b))
 * - (b-1) `Viewer.svelte` の `<script>` が `$lib/print-scroll` から `holdScrollForPrint` を import する
 * - (b-2) `holdScrollForPrint(window, () => [viewerEl])` の形で呼ぶ(空白は自由。
 *   第 1 引数は `window` そのもの・第 2 引数は `viewerEl` を 1 つ返す arrow)
 * - (b-3) その呼び出しは `onMount(…)` か `$effect(…)` の中にあり、返り値を破棄時に呼ぶ:
 *   - `onMount(() => holdScrollForPrint(…))`(式本体の arrow=戻り値がそのまま後始末)か、
 *   - `return holdScrollForPrint(…)`(返り値をそのまま後始末として返す)か、
 *   - `const x = holdScrollForPrint(…)` と受けて、同じ block の `return () => { … }` の中で
 *     `x()` / `x?.()` を呼ぶ、か、`return x`(変数のまま後始末として返す)
 *   mount 時に呼ぶものなので、`onMount` / `$effect` の外(トップレベルや別の関数)で
 *   呼んでいる場合は失敗にする
 *
 * ## 判断の記録(test-writer 2026-10-07)
 * - 呼び出しの block を切り出すため、文字列・テンプレート文字列・コメントを飛ばして括弧を数える
 *   小さな走査器を持つ(Viewer.svelte の日本語コメントに半角括弧が混ざっても誤計数しない)
 * - `onMount` の既存 block(Command + F の `listen`)に足しても、新しい `onMount` / `$effect` を
 *   増やしても、どちらでも通る
 *
 * ## 赤になる理由(実装前)
 * `Viewer.svelte` は `$lib/print-scroll` を import しておらず `holdScrollForPrint` を呼んでいない
 * ((b-1)(b-2)(b-3) すべて赤)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VIEWER_PATH = resolve(__dirname, 'Viewer.svelte');

const CALL_NAME = 'holdScrollForPrint';

/** `holdScrollForPrint(window, () => [viewerEl])`(空白は自由)。 */
const CALL_RE = /holdScrollForPrint\(\s*window\s*,\s*\(\s*\)\s*=>\s*\[\s*viewerEl\s*\]\s*\)/g;

// ---------------------------------------------------------------------------
// ソースの切り出し
// ---------------------------------------------------------------------------

/** `<script …>…</script>` の中身(最初の 1 つ。Viewer.svelte は 1 つしか持たない)。 */
function scriptOf(source: string): string {
	const m = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
	expect(m, 'Viewer.svelte に <script> があること').toBeTruthy();
	return (m as RegExpMatchArray)[1];
}

/**
 * 文字列・テンプレート文字列・コメントを空白に置き換えた複写(長さは同じ=位置がずれない)。
 * 括弧を数えるときはこちらを見る。`strings: false` ならコメントだけを抜く。
 */
function blankStringsAndComments(code: string, opts: { strings: boolean } = { strings: true }): string {
	const out = code.split('');
	let i = 0;
	const n = code.length;
	const blank = (from: number, to: number) => {
		for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
	};
	while (i < n) {
		const c = code[i];
		const next = code[i + 1];
		if (c === '/' && next === '/') {
			const end = code.indexOf('\n', i);
			const to = end < 0 ? n : end;
			blank(i, to);
			i = to;
			continue;
		}
		if (c === '/' && next === '*') {
			const end = code.indexOf('*/', i + 2);
			const to = end < 0 ? n : end + 2;
			blank(i, to);
			i = to;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			let j = i + 1;
			while (j < n) {
				if (code[j] === '\\') {
					j += 2;
					continue;
				}
				if (code[j] === c) break;
				if (c !== '`' && code[j] === '\n') break;
				j++;
			}
			const to = Math.min(n, j + 1);
			if (opts.strings) blank(i + 1, to - 1);
			i = to;
			continue;
		}
		i++;
	}
	return out.join('');
}

/** コメントだけを空白に置き換えた複写(文字列は残す)。 */
function blankComments(code: string): string {
	return blankStringsAndComments(code, { strings: false });
}

type Block = { kind: 'onMount' | '$effect'; start: number; end: number; body: string };

/**
 * `onMount(` / `$effect(` の呼び出しを全部拾い、括弧の釣り合いで引数の終わりまでを block にする。
 * body は元のソースから切り出す(文字列の中身も含む)。
 */
function mountBlocks(script: string): Block[] {
	const masked = blankStringsAndComments(script);
	const blocks: Block[] = [];
	const re = /(?<![\w$.])(onMount|\$effect)\s*\(/g;
	for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
		const open = m.index + m[0].length - 1;
		let depth = 0;
		let close = -1;
		for (let i = open; i < masked.length; i++) {
			const ch = masked[i];
			if (ch === '(' || ch === '{' || ch === '[') depth++;
			else if (ch === ')' || ch === '}' || ch === ']') {
				depth--;
				if (depth === 0) {
					close = i;
					break;
				}
			}
		}
		expect(close, `${m[1]}( の括弧が閉じていること`).toBeGreaterThan(open);
		blocks.push({
			kind: m[1] as Block['kind'],
			start: m.index,
			end: close + 1,
			body: script.slice(open + 1, close),
		});
	}
	return blocks;
}

/** block の本体(文字列・コメントを抜いた形)で、呼び出しの返り値が破棄時に呼ばれるか。 */
function disposesResult(bodyMasked: string): { ok: boolean; why: string } {
	// 形 0: onMount(() => holdScrollForPrint(…))(式本体の arrow=戻り値がそのまま後始末)
	if (new RegExp(`^\\s*\\(\\s*\\)\\s*=>\\s*${CALL_NAME}\\s*\\(`).test(bodyMasked)) {
		return { ok: true, why: '() => holdScrollForPrint(…)' };
	}
	// 形 1: return holdScrollForPrint(…)
	if (new RegExp(`\\breturn\\s+${CALL_NAME}\\s*\\(`).test(bodyMasked)) {
		return { ok: true, why: 'return holdScrollForPrint(…)' };
	}
	// 形 2: const x = holdScrollForPrint(…) → return () => { … x() … } / return x
	const assign = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${CALL_NAME}\\s*\\(`).exec(
		bodyMasked,
	);
	if (!assign) {
		return { ok: false, why: '返り値を return も変数で受けもしていない' };
	}
	const name = assign[1];
	const escaped = name.replace(/\$/g, '\\$');
	// return x
	if (new RegExp(`\\breturn\\s+${escaped}\\s*;`).test(bodyMasked)) {
		return { ok: true, why: `return ${name}` };
	}
	// return () => { … x() … } / return () => x()
	const ret = /\breturn\s*\(\s*\)\s*=>/g;
	for (let r = ret.exec(bodyMasked); r !== null; r = ret.exec(bodyMasked)) {
		const tail = bodyMasked.slice(r.index + r[0].length);
		// arrow の本体: `{ … }` なら釣り合いで切る・式ならセミコロンまで。
		let closure = '';
		const trimmed = tail.replace(/^\s*/, '');
		if (trimmed.startsWith('{')) {
			let depth = 0;
			for (let i = 0; i < trimmed.length; i++) {
				const ch = trimmed[i];
				if (ch === '{') depth++;
				else if (ch === '}') {
					depth--;
					if (depth === 0) {
						closure = trimmed.slice(0, i + 1);
						break;
					}
				}
			}
		} else {
			const semi = trimmed.indexOf(';');
			closure = semi < 0 ? trimmed : trimmed.slice(0, semi);
		}
		if (new RegExp(`(?<![\\w$.])${escaped}\\s*(?:\\?\\.)?\\s*\\(\\s*\\)`).test(closure)) {
			return { ok: true, why: `return () => { … ${name}() … }` };
		}
	}
	return { ok: false, why: `${name} を後始末(return () => { … } の中か return ${name})で呼んでいない` };
}

// ---------------------------------------------------------------------------
// AC-38-追h (b)
// ---------------------------------------------------------------------------

describe('AC-38-追h (b): Viewer.svelte は mount 時に holdScrollForPrint(window, () => [viewerEl]) を呼び、破棄時に外す', () => {
	const source = readFileSync(VIEWER_PATH, 'utf8');
	const script = scriptOf(source);

	it('(b-1) $lib/print-scroll から holdScrollForPrint を import している', () => {
		// モジュール名は文字列なので、コメントだけを抜いた複写で見る(コメントアウトした import は数えない)。
		const importRe = /import\s*\{[^}]*\bholdScrollForPrint\b[^}]*\}\s*from\s*['"]\$lib\/print-scroll['"]/;
		expect(
			importRe.test(blankComments(script)),
			"Viewer.svelte の <script> に import { holdScrollForPrint } from '$lib/print-scroll' があること",
		).toBe(true);
	});

	it('(b-2) holdScrollForPrint(window, () => [viewerEl]) の形で呼んでいる', () => {
		const masked = blankStringsAndComments(script);
		const calls = masked.match(CALL_RE) ?? [];
		expect(
			calls.length,
			'holdScrollForPrint(window, () => [viewerEl]) の呼び出しが 1 つ以上あること(コメント・文字列の中は数えない)',
		).toBeGreaterThan(0);
	});

	it('(b-3) 呼び出しは onMount / $effect の中にあり、返り値を破棄時に呼ぶ', () => {
		const masked = blankStringsAndComments(script);
		const callRe = new RegExp(`(?<![\\w$.])${CALL_NAME}\\s*\\(`, 'g');
		const callSites: number[] = [];
		for (let m = callRe.exec(masked); m !== null; m = callRe.exec(masked)) {
			// import 文の中の名前は呼び出しではない(`(` が続かないので元々当たらないが念のため)。
			callSites.push(m.index);
		}
		expect(callSites.length, 'holdScrollForPrint( の呼び出しがあること').toBeGreaterThan(0);

		const blocks = mountBlocks(script);
		expect(blocks.length, 'onMount( / $effect( の block があること').toBeGreaterThan(0);

		for (const at of callSites) {
			const block = blocks.find((b) => b.start <= at && at < b.end);
			expect(
				block,
				`holdScrollForPrint の呼び出し(offset ${at})が onMount / $effect の中にあること(mount 時に呼ぶ)`,
			).toBeTruthy();
			const bodyMasked = blankStringsAndComments((block as Block).body);
			const verdict = disposesResult(bodyMasked);
			expect(
				verdict.ok,
				`${(block as Block).kind} の中で holdScrollForPrint の返り値を破棄時に呼ぶこと: ${verdict.why}`,
			).toBe(true);
		}
	});
});
