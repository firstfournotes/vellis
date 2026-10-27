/**
 * 要件#66 追補b の受け入れテスト(docs/requirements/req-66.md「追補b」・backlog 342)
 * — E2E の比べる側(oracle)の除外の読み方を、アプリ(`src-tauri/src/settings.rs`)と同じにする
 *
 * ## 契約(implementer はこれに従う)
 * 1. 新規 `tests/e2e/settings-excludes.ts`(Node の標準モジュールだけ・wdio を import しない=vitest から読める)
 *    - `DEFAULT_FILES_EXCLUDE: readonly string[]` = `**／.*`・`**／.git`・`**／.DS_Store`・`**／.vellis`
 *    - `DEFAULT_SEARCH_EXCLUDE: readonly string[]` = `**／node_modules`・`**／target`・`**／dist`・`**／build`・`**／.git`・`**／.svelte-kit`
 *    - `activeExcludePatterns(text: string | null): string[]` = 検索で効く除外の型(`files.exclude` と `search.exclude` の
 *      値が `true` の行を合わせて重複を除いたもの。並びは問わない)。読み方は `settings::parse_settings` と同じ:
 *      `null` → 両方の既定/JSON でない・オブジェクトでない → 両方の既定/キーが無い → そのキーの既定/
 *      キーの値がオブジェクト → その中の値が `true` の行だけ(既定は足さない。`false` の行と真偽値でない行は効かない)/
 *      キーの値がオブジェクトでない → そのキーの既定
 * 2. spec `tests/e2e/specs/req66-find-in-folder-gate.e2e.ts` の `readSettingsExcludes` は settings.json を読んで
 *    (無ければ `null`)`activeExcludePatterns` に渡す。spec の中に既定の一覧を持たない
 * 3. 記録 `66-1-size-vs-gear` の note に `loses` を残さない
 *
 * ## 受け入れ基準 AC-66-追b
 * - (a) `DEFAULT_FILES_EXCLUDE` / `DEFAULT_SEARCH_EXCLUDE` が settings.rs の `DEFAULT_SETTINGS_JSON` の
 *       `files.exclude` / `search.exclude` の行(値 true)と集合として等しい
 * - (b) `activeExcludePatterns(null)` = 両方の既定(`**／.*` と `**／.vellis` を含む)。不正な JSON・配列・数値も同じ
 * - (c) `files.exclude` だけ → その `true` の行 + `search.exclude` の既定。`"**／.*": false` で `**／.*` は効かない。
 *       真偽値でない行は効かない。`search.exclude` が文字列 → `search.exclude` は既定
 * - (d) ソース走査: spec が `../settings-excludes` から `activeExcludePatterns` を import し `readSettingsExcludes` の
 *       本体が呼ぶ。spec に `'**／.DS_Store'` が無い。`66-1-size-vs-gear` の note に `loses` が無い
 * - (e) ソース走査: `tests/e2e/settings-excludes.ts` の import は `node:` で始まるものだけ
 *
 * ## 修正前に赤になる理由
 * `tests/e2e/settings-excludes.ts` が無いので、このファイルの import が解決できず収集に失敗する。
 *
 * (このコメントの `**／` は全角スラッシュ=ブロックコメントを閉じないための表記。コードでは本物の `/`)
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import { DEFAULT_FILES_EXCLUDE, DEFAULT_SEARCH_EXCLUDE, activeExcludePatterns } from '../../tests/e2e/settings-excludes';

const REPO_ROOT = resolve(__dirname, '../..');
const SETTINGS_RS = resolve(REPO_ROOT, 'src-tauri/src/settings.rs');
const SPEC = resolve(REPO_ROOT, 'tests/e2e/specs/req66-find-in-folder-gate.e2e.ts');
const MODULE = resolve(REPO_ROOT, 'tests/e2e/settings-excludes.ts');

/** 並びを問わない比較のために、重複を除いて並べ替えた配列にする。 */
const asSet = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** `settings.rs` の `DEFAULT_SETTINGS_JSON` の raw 文字列(`r#"…"#`)を取り出して JSON として読む。 */
function defaultSettingsJsonFromSource(): Record<string, unknown> {
	const rs = readFileSync(SETTINGS_RS, 'utf-8');
	const m = /const\s+DEFAULT_SETTINGS_JSON\s*:\s*&str\s*=\s*r#"([\s\S]*?)"#\s*;/.exec(rs);
	expect(m, 'settings.rs に const DEFAULT_SETTINGS_JSON: &str = r#"…"#; がある').not.toBeNull();
	return JSON.parse(m![1]!) as Record<string, unknown>;
}

/** 辞書の値が `true` のキーだけ。 */
function trueKeys(dict: unknown): string[] {
	expect(dict).toBeTypeOf('object');
	expect(dict).not.toBeNull();
	expect(Array.isArray(dict)).toBe(false);
	return Object.entries(dict as Record<string, unknown>)
		.filter(([, v]) => v === true)
		.map(([k]) => k);
}

const BOTH_DEFAULTS = () => asSet([...DEFAULT_FILES_EXCLUDE, ...DEFAULT_SEARCH_EXCLUDE]);

/** ブロックコメントと行コメントを落とす(ソース走査でコメント中の語を拾わないため)。 */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** `start` の位置にある `{` に対応する閉じ括弧までの本体。 */
function balancedBlock(src: string, start: number): string {
	const open = src.indexOf('{', start);
	expect(open, `"{" after offset ${start}`).toBeGreaterThanOrEqual(0);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth += 1;
		else if (c === '}') {
			depth -= 1;
			if (depth === 0) return src.slice(open, i + 1);
		}
	}
	throw new Error(`unbalanced block at ${start}`);
}

// ───────────────────────── (a) 既定がアプリのソースと一致 ─────────────────────────

describe('AC-66-追b (a): the defaults equal the `DEFAULT_SETTINGS_JSON` lines of settings.rs', () => {
	test('DEFAULT_FILES_EXCLUDE = files.exclude lines (value true) of DEFAULT_SETTINGS_JSON, as a set', () => {
		const json = defaultSettingsJsonFromSource();
		const want = trueKeys(json['files.exclude']);
		expect(want.length).toBeGreaterThan(0);
		expect(asSet(DEFAULT_FILES_EXCLUDE)).toEqual(asSet(want));
		// 集合として等しい=重複も無い
		expect(DEFAULT_FILES_EXCLUDE.length).toBe(asSet(DEFAULT_FILES_EXCLUDE).length);
	});

	test('DEFAULT_SEARCH_EXCLUDE = search.exclude lines (value true) of DEFAULT_SETTINGS_JSON, as a set', () => {
		const json = defaultSettingsJsonFromSource();
		const want = trueKeys(json['search.exclude']);
		expect(want.length).toBeGreaterThan(0);
		expect(asSet(DEFAULT_SEARCH_EXCLUDE)).toEqual(asSet(want));
		expect(DEFAULT_SEARCH_EXCLUDE.length).toBe(asSet(DEFAULT_SEARCH_EXCLUDE).length);
	});

	test('the defaults are the lists 契約1 enumerates (`**/.*` and `**/.vellis` among files.exclude)', () => {
		expect(asSet(DEFAULT_FILES_EXCLUDE)).toEqual(asSet(['**/.*', '**/.git', '**/.DS_Store', '**/.vellis']));
		expect(asSet(DEFAULT_SEARCH_EXCLUDE)).toEqual(
			asSet(['**/node_modules', '**/target', '**/dist', '**/build', '**/.git', '**/.svelte-kit']),
		);
	});
});

// ───────────────────────── (b) 無い・壊れている → 両方の既定 ─────────────────────────

describe('AC-66-追b (b): no file / not JSON / not an object → both defaults', () => {
	test('activeExcludePatterns(null) = both defaults as a set, with `**/.*` and `**/.vellis`', () => {
		const got = activeExcludePatterns(null);
		expect(Array.isArray(got)).toBe(true);
		expect(asSet(got)).toEqual(BOTH_DEFAULTS());
		expect(got).toContain('**/.*');
		expect(got).toContain('**/.vellis');
		// 重複を除いたもの(`**/.git` は両方の既定にあるが 1 回)
		expect(got.length).toBe(asSet(got).length);
		expect(got.filter((p) => p === '**/.git')).toHaveLength(1);
	});

	test.each([
		['empty text', ''],
		['broken JSON', '{"files.exclude": {'],
		['plain words', 'not json at all'],
		['trailing comma', '{"files.exclude": {"**/x": true,}}'],
	])('not valid JSON (%s) → both defaults', (_label, text) => {
		expect(asSet(activeExcludePatterns(text))).toEqual(BOTH_DEFAULTS());
	});

	test.each([
		['empty array', '[]'],
		['array of objects', '[{"files.exclude": {"**/x": true}}]'],
		['number', '42'],
		['string', '"files.exclude"'],
		['JSON null', 'null'],
		['boolean', 'true'],
	])('JSON that is not an object (%s) → both defaults', (_label, text) => {
		expect(asSet(activeExcludePatterns(text))).toEqual(BOTH_DEFAULTS());
	});

	test('an object without either key (unknown keys only) → both defaults', () => {
		expect(asSet(activeExcludePatterns('{}'))).toEqual(BOTH_DEFAULTS());
		expect(asSet(activeExcludePatterns('{"other": {"**/x": true}}'))).toEqual(BOTH_DEFAULTS());
	});
});

// ───────────────────────── (c) 契約1 の読み方 ─────────────────────────

describe('AC-66-追b (c): a present key replaces its default entirely; the other key keeps its default', () => {
	test('files.exclude only → its true lines + the search.exclude default (files.exclude default is not added)', () => {
		const got = activeExcludePatterns('{"files.exclude": {"**/foo": true, "**/bar": true}}');
		expect(asSet(got)).toEqual(asSet(['**/foo', '**/bar', ...DEFAULT_SEARCH_EXCLUDE]));
		expect(got).not.toContain('**/.*');
		expect(got).not.toContain('**/.vellis');
		expect(got).not.toContain('**/.DS_Store');
	});

	test('`"**/.*": false` turns `**/.*` off (it does not fall back to the default)', () => {
		const got = activeExcludePatterns(
			'{"files.exclude": {"**/.*": false, "**/.git": true, "**/.DS_Store": true, "**/.vellis": true}}',
		);
		expect(got).not.toContain('**/.*');
		expect(asSet(got)).toEqual(asSet(['**/.git', '**/.DS_Store', '**/.vellis', ...DEFAULT_SEARCH_EXCLUDE]));
	});

	test('files.exclude with only `"**/.*": false` → nothing from files.exclude; search.exclude default stays', () => {
		const got = activeExcludePatterns('{"files.exclude": {"**/.*": false}}');
		expect(got).not.toContain('**/.*');
		expect(got).not.toContain('**/.vellis');
		expect(got).not.toContain('**/.DS_Store');
		expect(asSet(got)).toEqual(asSet(DEFAULT_SEARCH_EXCLUDE));
	});

	test('lines whose value is not a boolean do not count (string / number / null / object / array)', () => {
		const got = activeExcludePatterns(
			'{"files.exclude": {"**/s": "true", "**/n": 1, "**/z": 0, "**/u": null, "**/o": {"on": true}, "**/a": [true], "**/ok": true, "**/off": false}}',
		);
		expect(asSet(got)).toEqual(asSet(['**/ok', ...DEFAULT_SEARCH_EXCLUDE]));
	});

	test('search.exclude whose value is a string → search.exclude default (files.exclude untouched)', () => {
		const got = activeExcludePatterns('{"search.exclude": "**/node_modules"}');
		expect(asSet(got)).toEqual(BOTH_DEFAULTS());
		const withFiles = activeExcludePatterns('{"files.exclude": {"**/a": true}, "search.exclude": "**/custom"}');
		expect(asSet(withFiles)).toEqual(asSet(['**/a', ...DEFAULT_SEARCH_EXCLUDE]));
		expect(withFiles).not.toContain('**/custom');
	});

	test.each([
		['array', '["**/x"]'],
		['number', '7'],
		['JSON null', 'null'],
		['boolean', 'true'],
	])('a key whose value is not an object (%s) → that key keeps its default', (_label, value) => {
		expect(asSet(activeExcludePatterns(`{"files.exclude": ${value}}`))).toEqual(BOTH_DEFAULTS());
		expect(asSet(activeExcludePatterns(`{"search.exclude": ${value}}`))).toEqual(BOTH_DEFAULTS());
		const mixed = activeExcludePatterns(`{"files.exclude": ${value}, "search.exclude": {"**/only": true}}`);
		expect(asSet(mixed)).toEqual(asSet(['**/only', ...DEFAULT_FILES_EXCLUDE]));
	});

	test('search.exclude only → its true lines + the files.exclude default', () => {
		const got = activeExcludePatterns('{"search.exclude": {"**/target": false, "**/custom": true}}');
		expect(asSet(got)).toEqual(asSet(['**/custom', ...DEFAULT_FILES_EXCLUDE]));
		expect(got).not.toContain('**/target');
		expect(got).not.toContain('**/node_modules');
	});

	test('both keys present as empty objects → nothing is excluded', () => {
		expect(activeExcludePatterns('{"files.exclude": {}, "search.exclude": {}}')).toEqual([]);
	});

	test('the union drops duplicates across the two lists', () => {
		const got = activeExcludePatterns('{"files.exclude": {"**/node_modules": true, "**/.git": true}}');
		expect(got.filter((p) => p === '**/node_modules')).toHaveLength(1);
		expect(got.filter((p) => p === '**/.git')).toHaveLength(1);
		expect(asSet(got)).toEqual(asSet(['**/node_modules', '**/.git', ...DEFAULT_SEARCH_EXCLUDE]));
	});
});

// ───────────────────────── (d) spec の配線(ソース走査)─────────────────────────

describe('AC-66-追b (d): the E2E spec is wired to the module and carries no defaults', () => {
	const spec = () => readFileSync(SPEC, 'utf-8');

	test('the spec imports `activeExcludePatterns` from `../settings-excludes`', () => {
		const src = spec();
		const re = /^import\s*\{[^}]*\bactiveExcludePatterns\b[^}]*\}\s*from\s*['"]\.\.\/settings-excludes(?:\.ts)?['"]\s*;?/m;
		expect(src).toMatch(re);
	});

	test('the body of `readSettingsExcludes` calls `activeExcludePatterns(`', () => {
		const src = spec();
		const at = src.search(/function\s+readSettingsExcludes\s*\(/);
		expect(at, 'function readSettingsExcludes( exists in the spec').toBeGreaterThanOrEqual(0);
		// 引数の `)` の後の最初の `{…}` は戻り値の型注釈(`{ file: …; patterns: …; unsupported: … }`)でありうる。
		// ブロックの直後がまた `{` で始まる間は次のブロックへ進み、最後のブロックを本体とする。
		let pos = src.indexOf('{', src.indexOf(')', at));
		let body = balancedBlock(src, pos);
		while (/^\s*\{/.test(src.slice(pos + body.length))) {
			pos = src.indexOf('{', pos + body.length);
			body = balancedBlock(src, pos);
		}
		expect(body).toMatch(/\bactiveExcludePatterns\s*\(/);
	});

	test('the spec holds no default list (`**/.DS_Store` / `.svelte-kit` do not appear)', () => {
		const src = spec();
		expect(src).not.toContain('**/.DS_Store');
		expect(src).not.toContain("'.DS_Store'");
		expect(src).not.toContain('.svelte-kit');
	});

	test('the `66-1-size-vs-gear` record has a note and the note does not say `loses`', () => {
		const src = spec();
		const at = src.indexOf("gate: '66-1-size-vs-gear'");
		expect(at, "the spec reports gate: '66-1-size-vs-gear'").toBeGreaterThanOrEqual(0);
		const record = balancedBlock(src, src.lastIndexOf('{', at));
		const note = /note\s*:\s*(['"`])([\s\S]*?)\1/.exec(record);
		expect(note, 'the record has a note').not.toBeNull();
		expect(note![2]!.trim()).not.toBe('');
		expect(note![2]!).not.toMatch(/\bloses\b/i);
		expect(record).not.toMatch(/\bloses\b/i);
	});
});

// ───────────────────────── (e) モジュールの import(ソース走査)─────────────────────────

describe('AC-66-追b (e): tests/e2e/settings-excludes.ts imports only `node:` modules', () => {
	test('the module exists', () => {
		expect(existsSync(MODULE)).toBe(true);
	});

	test('every import / export-from / dynamic import / require specifier starts with `node:`', () => {
		const src = stripComments(readFileSync(MODULE, 'utf-8'));
		const specifiers: string[] = [];
		// static (複数行も可): import x from '…' / import { a,\n b } from '…' / export … from '…'
		for (const m of src.matchAll(/^\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gm)) specifiers.push(m[1]!);
		// side-effect: import '…'
		for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specifiers.push(m[1]!);
		// dynamic: import('…') / require('…')
		for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1]!);
		for (const s of specifiers) expect(s, `import specifier "${s}"`).toMatch(/^node:/);
	});

	test('the module (comments aside) does not read @wdio/* or webdriverio', () => {
		const src = stripComments(readFileSync(MODULE, 'utf-8'));
		expect(src).not.toMatch(/@wdio\//);
		expect(src).not.toMatch(/\bwebdriverio\b/);
	});
});
