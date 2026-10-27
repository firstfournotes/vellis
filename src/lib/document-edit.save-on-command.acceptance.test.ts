/**
 * 要件#48 追補i(2026-10-12・backlog 341)の受け入れテスト AC-48-追i (a)(b)=
 * 削除の印が立って dirty でないとき、Command + S(File > Save)が何もしない、の是正。
 * (c)= store の筋道は `src/components/Viewer.external-removed-i.wiring.test.ts`
 * (runes を含む `stores/window-state.svelte.ts` は component プロジェクトでしか動かない)。
 *
 * unit プロジェクト(svelte プラグインなし)なので、純関数の真理値表と
 * `+page.svelte` のソース走査(`readFileSync`)だけを判定する。
 *
 * ## テストが前提にする名前(契約(追補i)2= req-48.md)
 * - `$lib/document-edit` が `shouldSaveOnCommand` を export する
 * - 引数の形: `shouldSaveOnCommand({ mode, dirty, externalRemoved }: { mode: EditMode;
 *   dirty: boolean; externalRemoved: boolean }): boolean`
 * - 意味: `mode === 'edit' && (dirty || externalRemoved)`
 *
 * ## 判定するもの(契約(追補i)1〜3= req-48.md)
 * - (a) 真理値表 8 通り: `mode: 'view'` は dirty と印にかかわらず偽。`mode: 'edit'` は
 *   dirty か印のどちらかが真なら真、両方とも偽なら偽
 * - (b) 配線(ソース走査): `+page.svelte` の `saveCurrentEdits` の関数本体(関数の範囲を
 *   括弧の対応で切り出す)が `shouldSaveOnCommand(` を呼び、その引数に
 *   `windowState.externalRemoved` を渡す(契約2 では `windowState.editMode`・
 *   `windowState.dirty` も)。本体に `!windowState.dirty` が残っていない。
 *   `shouldSaveOnCommand` を `$lib/document-edit` から import している。
 *   保存の経路(`saveDocument(`)は本体に残る(契約3 の不変)
 *
 * ## 想定される赤(実装前)
 * - (a) `shouldSaveOnCommand` が export されていない → 8 通りすべて「not a function」で赤
 *   (`pnpm check` でも import の型エラー)
 * - (b) `saveCurrentEdits` の本体に `shouldSaveOnCommand(` が無い → 赤。
 *   `!windowState.dirty` が残っている → 赤。import が無い → 赤。
 *   `saveDocument(` が本体にある、は不変の固定で実装前から緑
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldSaveOnCommand, type EditMode } from './document-edit';

// ---------------------------------------------------------------------------
// (a) 真理値表 8 通り(契約(追補i)2)
// ---------------------------------------------------------------------------

type Row = { mode: EditMode; dirty: boolean; externalRemoved: boolean; expected: boolean };

const TRUTH_TABLE: Row[] = [
	// 閲覧中は dirty と印にかかわらず偽(契約3: 閲覧中の Command + S は何もしない)
	{ mode: 'view', dirty: false, externalRemoved: false, expected: false },
	{ mode: 'view', dirty: false, externalRemoved: true, expected: false },
	{ mode: 'view', dirty: true, externalRemoved: false, expected: false },
	{ mode: 'view', dirty: true, externalRemoved: true, expected: false },
	// 編集中で未変更かつ印が無ければ偽(契約3: 同じ内容を書き戻して mtime を動かさない)
	{ mode: 'edit', dirty: false, externalRemoved: false, expected: false },
	// 編集中で印が立っていれば dirty でなくても真(契約1= backlog 341 の是正)
	{ mode: 'edit', dirty: false, externalRemoved: true, expected: true },
	// 編集中で dirty なら真(従来どおり)
	{ mode: 'edit', dirty: true, externalRemoved: false, expected: true },
	{ mode: 'edit', dirty: true, externalRemoved: true, expected: true },
];

describe('AC-48-追i (a): shouldSaveOnCommand の真理値表 8 通り', () => {
	test.each(TRUTH_TABLE)(
		'mode=$mode dirty=$dirty externalRemoved=$externalRemoved → $expected',
		({ mode, dirty, externalRemoved, expected }) => {
			const result = shouldSaveOnCommand({ mode, dirty, externalRemoved });
			expect(typeof result).toBe('boolean');
			expect(result).toBe(expected);
		}
	);

	test('view は 4 通りすべて偽・edit は「dirty か印のどちらか」のときだけ真(表の要約)', () => {
		const views = TRUTH_TABLE.filter((r) => r.mode === 'view');
		expect(views).toHaveLength(4);
		for (const r of views) expect(shouldSaveOnCommand(r)).toBe(false);

		const edits = TRUTH_TABLE.filter((r) => r.mode === 'edit');
		expect(edits).toHaveLength(4);
		for (const r of edits) expect(shouldSaveOnCommand(r)).toBe(r.dirty || r.externalRemoved);
	});
});

// ---------------------------------------------------------------------------
// (b) 配線(ソース走査)— +page.svelte の saveCurrentEdits
// ---------------------------------------------------------------------------

const PAGE_PATH = resolve(__dirname, '../routes/+page.svelte');

/** コメント(行・ブロック)を落とす(コメントの中の語を数えない)。 */
function stripJsComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** `start` 以降で最初の `{` から、対応する `}` までの中身。 */
function braceBody(src: string, start: number, what: string): string {
	const open = src.indexOf('{', start);
	expect(open, `${what}: opening brace`).toBeGreaterThanOrEqual(0);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	throw new Error(`${what}: unbalanced braces`);
}

/** `open`(`(` の位置)から対応する `)` までの中身。 */
function parenBody(src: string, open: number, what: string): string {
	expect(open, `${what}: opening paren`).toBeGreaterThanOrEqual(0);
	expect(src[open], `${what}: opening paren`).toBe('(');
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '(') depth++;
		else if (src[i] === ')') {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	throw new Error(`${what}: unbalanced parens`);
}

/** `+page.svelte` の `saveCurrentEdits` の関数本体(コメントを落としたソースから切り出す)。 */
function saveCurrentEditsBody(): string {
	const src = stripJsComments(readFileSync(PAGE_PATH, 'utf8'));
	const at = src.search(/\bfunction\s+saveCurrentEdits\s*\(/);
	expect(at, 'function saveCurrentEdits( in +page.svelte').toBeGreaterThanOrEqual(0);
	// 引数リストの `)` の後ろから、関数本体の `{ … }` を括弧の対応で切り出す。
	const paramsClose = src.indexOf(')', at);
	return braceBody(src, paramsClose, 'saveCurrentEdits body');
}

describe('AC-48-追i (b): 配線(ソース走査)— +page.svelte の saveCurrentEdits は shouldSaveOnCommand で決める', () => {
	test('saveCurrentEdits の本体が shouldSaveOnCommand( を呼ぶ', () => {
		const body = saveCurrentEditsBody();
		expect(body).toMatch(/\bshouldSaveOnCommand\s*\(/);
	});

	test('shouldSaveOnCommand( の引数に windowState.externalRemoved を渡す', () => {
		const body = saveCurrentEditsBody();
		const call = body.search(/\bshouldSaveOnCommand\s*\(/);
		expect(call, 'shouldSaveOnCommand( in saveCurrentEdits body').toBeGreaterThanOrEqual(0);
		const args = parenBody(body, body.indexOf('(', call), 'shouldSaveOnCommand(…)');

		expect(args).toMatch(/\bwindowState\.externalRemoved\b/);
	});

	test('shouldSaveOnCommand( の引数に windowState.editMode と windowState.dirty も渡す(契約(追補i)2)', () => {
		const body = saveCurrentEditsBody();
		const call = body.search(/\bshouldSaveOnCommand\s*\(/);
		expect(call, 'shouldSaveOnCommand( in saveCurrentEdits body').toBeGreaterThanOrEqual(0);
		const args = parenBody(body, body.indexOf('(', call), 'shouldSaveOnCommand(…)');

		expect(args).toMatch(/\bwindowState\.editMode\b/);
		expect(args).toMatch(/\bwindowState\.dirty\b/);
	});

	test('saveCurrentEdits の本体に !windowState.dirty が残っていない(dirty だけで早く返らない)', () => {
		const body = saveCurrentEditsBody();
		expect(body).not.toMatch(/!\s*windowState\.dirty\b/);
	});

	test("shouldSaveOnCommand を '$lib/document-edit' から import している", () => {
		const src = stripJsComments(readFileSync(PAGE_PATH, 'utf8'));
		// `import { …, shouldSaveOnCommand, … } from '$lib/document-edit'` の形(複数行可)。
		const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\$lib\/document-edit['"]/g)];
		expect(imports.length, "import { … } from '$lib/document-edit' in +page.svelte").toBeGreaterThan(0);
		const names = imports.map((m) => m[1]).join(',');
		expect(names).toMatch(/\bshouldSaveOnCommand\b/);
	});

	test('保存の経路は変えない: saveCurrentEdits の本体が saveDocument( を呼ぶ(契約(追補i)3 の不変)', () => {
		const body = saveCurrentEditsBody();
		expect(body).toMatch(/\bsaveDocument\s*\(/);
	});
});
