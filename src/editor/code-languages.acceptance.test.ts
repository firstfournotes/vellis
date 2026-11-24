/**
 * 要件#74 第1段の受け入れテスト(docs/requirements/req-74.md)— 言語の対応表
 * (AC-74-30 (1)・契約5・契約20・契約19 の「第1段の作り」15。unit プロジェクト)
 *
 * 要件69 の `CODE_LANGUAGES`(Shiki の言語 id・2026-11-16 の main で 36)のそれぞれに、CodeMirror の文法
 * (`@codemirror/language-data` の `LanguageDescription` の name)か「文法なし(色なし)」が対応表にあることを判定する。
 * 対応表そのもの(どの id がどの name か)は周回0 の 0-8 で作って「実装の要点」に記帳するので、ここでは
 * **表の鍵の集合・値が解決できること・文法が無いと決まっているもの**だけを固定する。
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 契約19「第1段の作り」・スコープ節)
 *
 * ```ts
 * // --- src/editor/code-languages.ts(新規)
 * import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
 * /** CODE_LANGUAGES の各 id → `@codemirror/language-data` の `languages[].name`(文法なし=null)。鍵は CODE_LANGUAGES と同じ集合。 *\/
 * export const CODE_LANGUAGE_GRAMMARS: Readonly<Record<string, string | null>>;
 * /** 表から LanguageDescription を引く(表に無い id・文法なしは null)。 *\/
 * export function grammarFor(langId: string): LanguageDescription | null;
 * /** 文法を遅延読み込みして LanguageSupport を返す(文法なし・表に無い id は null。失敗も null=例外を外へ出さない)。 *\/
 * export async function languageSupportFor(langId: string): Promise<LanguageSupport | null>;
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-16)
 * - 契約20「CodeMirror 側に文法が無い見込みのもの(svelte=html で代用・graphql・makefile)は色なし」のうち、
 *   `@codemirror/language-data` 6.5 と `@codemirror/legacy-modes` 6.5 のどちらにも無い **graphql・makefile は null で固定**した。
 *   svelte は「html で代用」が見込みなので、null か解決できる name のどちらでもよい(固定しない)
 * - 確実に文法がある id(typescript・javascript・rust・python・json・css・yaml・go・java・cpp・c・php・sql・xml)は
 *   **null でない**ことまで固定する(name の綴りは `languages[].name` で解決できればよい)
 *
 * ## 修正前に赤になる理由
 * - `src/editor/code-languages.ts` が無く、`@codemirror/language` / `@codemirror/language-data` も依存に無いので import で落ちる
 */
import { describe, expect, test } from 'vitest';
import { LanguageDescription, LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

import { CODE_LANGUAGES, languageForFile } from '$lib/code-language';
import { CODE_LANGUAGE_GRAMMARS, grammarFor, languageSupportFor } from './code-languages';

/** 2026-11-16 の main の 36 の言語 id(要件69 の表。増減したら要件69 側の変更=ここも要件側更新)。 */
const EXPECTED_IDS = [
	'typescript',
	'tsx',
	'javascript',
	'jsx',
	'rust',
	'python',
	'ruby',
	'go',
	'java',
	'kotlin',
	'swift',
	'c',
	'cpp',
	'csharp',
	'php',
	'shellscript',
	'fish',
	'powershell',
	'json',
	'jsonc',
	'yaml',
	'toml',
	'xml',
	'ini',
	'css',
	'scss',
	'less',
	'sql',
	'graphql',
	'lua',
	'r',
	'diff',
	'vue',
	'svelte',
	'makefile',
	'docker',
];

/** 文法が確実にある id(language-data の公式の文法)。 */
const SURELY_HAS_GRAMMAR = ['typescript', 'javascript', 'rust', 'python', 'json', 'css', 'yaml', 'go', 'java', 'cpp', 'c', 'php', 'sql', 'xml'];

/** 文法が無い(色なし)と決まっている id(契約20)。 */
const SURELY_NO_GRAMMAR = ['graphql', 'makefile'];

describe('前提: 要件69 の CODE_LANGUAGES は 36 の言語 id', () => {
	test('集合が一致する', () => {
		expect([...CODE_LANGUAGES].sort()).toEqual([...EXPECTED_IDS].sort());
	});
});

describe('AC-74-30 (1): CODE_LANGUAGE_GRAMMARS の鍵は CODE_LANGUAGES と同じ集合', () => {
	test('鍵の集合', () => {
		expect(Object.keys(CODE_LANGUAGE_GRAMMARS).sort()).toEqual([...CODE_LANGUAGES].sort());
	});

	test('値は language-data の languages[].name(厳密一致で解決できる)か null', () => {
		for (const [id, name] of Object.entries(CODE_LANGUAGE_GRAMMARS)) {
			if (name === null) continue;
			expect(typeof name, id).toBe('string');
			const desc = LanguageDescription.matchLanguageName(languages, name, false);
			expect(desc, `${id} → "${name}" は @codemirror/language-data の name に無い`).not.toBeNull();
			expect(desc!.name).toBe(name);
		}
	});

	test.each(SURELY_HAS_GRAMMAR)('%s には文法がある', (id) => {
		expect(CODE_LANGUAGE_GRAMMARS[id]).not.toBeNull();
		expect(grammarFor(id)).toBeInstanceOf(LanguageDescription);
	});

	test.each(SURELY_NO_GRAMMAR)('%s は文法なし(色なし)', (id) => {
		expect(CODE_LANGUAGE_GRAMMARS[id]).toBeNull();
		expect(grammarFor(id)).toBeNull();
	});

	test('grammarFor は表に無い id で null(例外にしない)', () => {
		expect(grammarFor('not-a-language')).toBeNull();
		expect(grammarFor('')).toBeNull();
	});

	test('grammarFor の name は表の値と同じ', () => {
		for (const [id, name] of Object.entries(CODE_LANGUAGE_GRAMMARS)) {
			const desc = grammarFor(id);
			if (name === null) expect(desc, id).toBeNull();
			else expect(desc?.name, id).toBe(name);
		}
	});
});

describe('AC-74-30 (1): languageSupportFor は文法を遅延読み込みする', () => {
	test('typescript → LanguageSupport', async () => {
		const support = await languageSupportFor('typescript');
		expect(support).toBeInstanceOf(LanguageSupport);
	});

	test('rust → LanguageSupport', async () => {
		expect(await languageSupportFor('rust')).toBeInstanceOf(LanguageSupport);
	});

	test('文法なしの id・表に無い id → null(例外を外へ出さない)', async () => {
		expect(await languageSupportFor('graphql')).toBeNull();
		expect(await languageSupportFor('makefile')).toBeNull();
		expect(await languageSupportFor('not-a-language')).toBeNull();
	});

	test('ファイル名から言語へ(要件69 の languageForFile)→ 表の鍵に必ずある', () => {
		for (const name of ['a.ts', 'b.rs', 'c.py', 'settings.json', 'Makefile', 'Dockerfile', '.zshrc', 'q.graphql']) {
			const id = languageForFile(name);
			expect(id, name).not.toBeNull();
			expect(Object.prototype.hasOwnProperty.call(CODE_LANGUAGE_GRAMMARS, id!), `${name} → ${id}`).toBe(true);
		}
		// plain text は言語なし(表を引かない)。
		expect(languageForFile('notes.txt')).toBeNull();
		expect(languageForFile('app.log')).toBeNull();
	});
});
