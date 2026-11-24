/**
 * 要件#84 AC-84-10・11(フロントの今の AI 連携の出し分け)— 要件74 第2段 2-5(2026-11-17 仮・契約21・棚卸し 8「書き直し(editor_inline を
 * 外すとき)」=承認済み (as))で `editor_inline` の分を外した。残るのは `ai_marks` だけ。
 *
 * ## 確定契約(implementer はこれに従う)
 * ```ts
 * // src/lib/legacy-features.ts
 * export const AI_MARKS_FLAG = 'ai_marks';
 * export interface LegacyUi { ai: boolean }                 // edit は無い
 * export function legacyUi(isEnabled: (name: string) => boolean): LegacyUi;   // 聞く名前は AI_MARKS_FLAG だけ
 * // EDITOR_INLINE_FLAG は export されない
 * ```
 * +page.svelte: `legacyUi(` は 1 回・`<Viewer` に `aiTools={legacy.ai}`(`editable=` は無い)・MENU_SAVE_EVENT の受け手は edit を見ない・
 * marks / show_marks / init.show_marks / MarkList・InstructionDialog・DiffView の ai の門は今のまま。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as legacyModule from './legacy-features';
import { AI_MARKS_FLAG, legacyUi } from './legacy-features';

const REPO_ROOT = resolve(__dirname, '../..');
const PAGE_PATH = resolve(REPO_ROOT, 'src/routes/+page.svelte');

function stripComments(src: string): string {
	const noHtml = src.replace(/<!--[\s\S]*?-->/g, '');
	const noBlock = noHtml.replace(/\/\*[\s\S]*?\*\//g, '');
	return noBlock
		.split('\n')
		.map((line) => {
			for (let i = 0; i + 1 < line.length; i++) {
				if (line[i] === '/' && line[i + 1] === '/' && (i === 0 || line[i - 1] !== ':')) return line.slice(0, i);
			}
			return line;
		})
		.join('\n');
}
function balancedBody(src: string, open: number, what: string): string {
	const pairs: Record<string, string> = { '(': ')', '{': '}' };
	const close = pairs[src[open]!];
	if (!close) throw new Error(`${what}: not an opening bracket at ${open}`);
	let depth = 0;
	let quote: string | null = null;
	for (let i = open; i < src.length; i++) {
		const c = src[i]!;
		if (quote) {
			if (c === '\\') {
				i++;
				continue;
			}
			if (c === quote) quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			continue;
		}
		if (c === src[open]) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	throw new Error(`${what}: unbalanced ${src[open]}`);
}
function callArgs(src: string, needle: string, what: string): string {
	const at = src.indexOf(needle);
	expect(at, `${what}: \`${needle}\` in +page.svelte`).toBeGreaterThanOrEqual(0);
	return balancedBody(src, src.indexOf('(', at), what);
}
const page = () => stripComments(readFileSync(PAGE_PATH, 'utf8'));
function legacyBinding(src: string): string {
	const m = /const\s+(\w+)\s*=\s*\$derived\(\s*legacyUi\(/.exec(src);
	expect(m, 'const <name> = $derived(legacyUi(…)) in +page.svelte').not.toBeNull();
	return m![1]!;
}
const ref = (name: string, key: string) => new RegExp(`\\b${name}\\.${key}\\b`);

describe('AC-84-10(2-5 の後): 定数は Rust のレジストリと同じ綴りで、editor_inline の分は無い', () => {
	test("AI_MARKS_FLAG === 'ai_marks'", () => {
		expect(AI_MARKS_FLAG).toBe('ai_marks');
	});
	test('EDITOR_INLINE_FLAG は export されていない(AC-74-46)', () => {
		expect('EDITOR_INLINE_FLAG' in legacyModule).toBe(false);
	});
	test('legacyUi(isEnabled) は { ai } だけを返し、聞く名前は AI_MARKS_FLAG だけ', () => {
		const asked: string[] = [];
		const ui = legacyUi((name) => {
			asked.push(name);
			return name === AI_MARKS_FLAG;
		});
		expect(ui).toEqual({ ai: true });
		expect(Object.keys(ui)).toEqual(['ai']);
		expect(asked).toEqual([AI_MARKS_FLAG]);
		expect(legacyUi(() => false)).toEqual({ ai: false });
	});
	test('featureFlags が届く前(isEnabled が全部偽)は { ai: false }=閉じた側', () => {
		expect(legacyUi(() => false).ai).toBe(false);
	});
});

describe('AC-84-11(2-5 の後): +page.svelte の配線(ソース走査)', () => {
	test('1. legacyUi( を 1 回だけ呼び、featureFlags.isEnabled を渡して $derived で束ねる', () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*\blegacyUi\b[^}]*\}\s*from\s*'\$lib\/legacy-features'/);
		expect(src.match(/\blegacyUi\(/g) ?? []).toHaveLength(1);
		expect(callArgs(src, 'legacyUi(', 'legacyUi(…)')).toContain('featureFlags.isEnabled');
		legacyBinding(src);
	});
	test('2. <Viewer に aiTools= があり ai を渡す。editable= と fileEditor= は無い(撤去)', () => {
		const src = page();
		const name = legacyBinding(src);
		const at = src.indexOf('<Viewer');
		expect(at).toBeGreaterThanOrEqual(0);
		let depth = 0;
		let end = -1;
		for (let i = at; i < src.length; i++) {
			const c = src[i]!;
			if (c === '{') depth++;
			else if (c === '}') depth--;
			else if (c === '>' && depth === 0) {
				end = i;
				break;
			}
		}
		const tag = src.slice(at, end + 1);
		expect(tag).toMatch(new RegExp(`\\baiTools=\\{\\s*${name}\\.ai\\s*\\}`));
		expect(tag).not.toMatch(/\beditable=/);
		expect(tag).not.toMatch(/\bfileEditor=/);
	});
	test('3. MENU_EDIT_EVENT の受け手が無く、MENU_SAVE_EVENT の受け手は edit を見ずに saveCurrentEdits( を呼ぶ', () => {
		const src = page();
		const name = legacyBinding(src);
		expect(src).not.toContain('MENU_EDIT_EVENT');
		expect(src).not.toContain('toggleEditMode(');
		expect(src).not.toMatch(ref(name, 'edit'));
		const handler = callArgs(src, 'listen(MENU_SAVE_EVENT', 'listen(MENU_SAVE_EVENT, …)');
		expect(handler).toContain('saveCurrentEdits(');
		expect(handler).not.toMatch(/\.edit\b|EDITOR_FILE_FLAG|editor_file/);
	});
	test('4. marksStore.rebindForFile( を呼ぶ $effect が、その前に ai を見る(今のまま)', () => {
		const src = page();
		const name = legacyBinding(src);
		let found: string | null = null;
		let search = 0;
		for (;;) {
			const at = src.indexOf('$effect(', search);
			if (at < 0) break;
			const body = balancedBody(src, at + '$effect'.length, '$effect(…)');
			if (body.includes('marksStore.rebindForFile(')) {
				found = body;
				break;
			}
			search = at + '$effect('.length;
		}
		expect(found).not.toBeNull();
		expect(found!.search(ref(name, 'ai'))).toBeGreaterThanOrEqual(0);
		expect(found!.search(ref(name, 'ai'))).toBeLessThan(found!.indexOf('rebindForFile('));
	});
	test("5. listen の 'show_marks' の受け手が ai を見る(今のまま)", () => {
		const src = page();
		const name = legacyBinding(src);
		const marker = src.indexOf("'show_marks'");
		expect(marker).toBeGreaterThanOrEqual(0);
		const listenAt = src.lastIndexOf('listen', marker);
		const args = balancedBody(src, src.indexOf('(', listenAt), "listen('show_marks', …)");
		expect(args).toMatch(ref(name, 'ai'));
	});
	test('6. <MarkList・<InstructionDialog・<DiffView がどれも ai の {#if の中にある(今のまま)', () => {
		const src = page();
		const name = legacyBinding(src);
		const tokens = /\{#if\s+([^}]*)\}|\{:else(?:\s+if\s+([^}]*))?\}|\{\/if\}/g;
		const stack: string[] = [];
		const gated: Record<string, boolean> = {};
		let m: RegExpExecArray | null;
		let last = 0;
		const check = (from: number, to: number) => {
			const chunk = src.slice(from, to);
			for (const comp of ['<MarkList', '<InstructionDialog', '<DiffView']) {
				if (chunk.includes(comp)) gated[comp] = stack.some((c) => ref(name, 'ai').test(c) && !new RegExp(`!\\s*${name}\\.ai\\b`).test(c));
			}
		};
		while ((m = tokens.exec(src))) {
			check(last, m.index);
			if (m[0].startsWith('{#if')) stack.push(m[1]!);
			else if (m[0].startsWith('{:else')) {
				stack.pop();
				stack.push(m[2] ?? '!(else)');
			} else stack.pop();
			last = tokens.lastIndex;
		}
		check(last, src.length);
		for (const comp of ['<MarkList', '<InstructionDialog', '<DiffView']) expect(gated[comp], `${comp} is inside {#if ${name}.ai}`).toBe(true);
	});
});
