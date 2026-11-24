/**
 * 要件69 の言語 id(Shiki の id=`CODE_LANGUAGES`)→ CodeMirror の文法(要件#74 契約5・20・AC-74-30 (1))。
 *
 * `LanguageDescription.matchFilename` は使わない(`.pyi`・`.zsh`・`.bashrc`・`.jsonc`・`.plist` などを
 * 取りこぼす=周回0 の 0-8)。ファイル名から言語 id を決めるのは要件69 の `languageForFile` のまま、
 * ここは id → `@codemirror/language-data` の `languages[].name` の表だけを持つ。
 *
 * 2026-11-16 由谷決定: svelte は HTML・fish は Shell の文法で代用し、graphql と makefile は色なし(null)。
 * jsonc は JSON(Lezer)のまま(注釈は色が付かない)。文法は使うときに遅延読み込みする。
 */
import { LanguageSupport, type LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

/** CODE_LANGUAGES の各 id → `@codemirror/language-data` の `languages[].name`(文法なし=null)。 */
export const CODE_LANGUAGE_GRAMMARS: Readonly<Record<string, string | null>> = {
	typescript: 'TypeScript',
	tsx: 'TSX',
	javascript: 'JavaScript',
	jsx: 'JSX',
	rust: 'Rust',
	python: 'Python',
	ruby: 'Ruby',
	go: 'Go',
	java: 'Java',
	kotlin: 'Kotlin',
	swift: 'Swift',
	c: 'C',
	cpp: 'C++',
	csharp: 'C#',
	php: 'PHP',
	shellscript: 'Shell',
	fish: 'Shell',
	powershell: 'PowerShell',
	json: 'JSON',
	jsonc: 'JSON',
	yaml: 'YAML',
	toml: 'TOML',
	xml: 'XML',
	ini: 'Properties files',
	css: 'CSS',
	scss: 'SCSS',
	less: 'LESS',
	sql: 'SQL',
	graphql: null,
	lua: 'Lua',
	r: 'R',
	diff: 'diff',
	vue: 'Vue',
	svelte: 'HTML',
	makefile: null,
	docker: 'Dockerfile',
};

const BY_NAME = new Map(languages.map((desc) => [desc.name, desc] as const));

/** 表から LanguageDescription を引く(表に無い id・文法なしは null)。 */
export function grammarFor(langId: string): LanguageDescription | null {
	if (!Object.prototype.hasOwnProperty.call(CODE_LANGUAGE_GRAMMARS, langId)) return null;
	const name = CODE_LANGUAGE_GRAMMARS[langId];
	if (!name) return null;
	return BY_NAME.get(name) ?? null;
}

/** 文法を遅延読み込みして LanguageSupport を返す(文法なし・表に無い id は null。失敗も null=例外を外へ出さない)。 */
export async function languageSupportFor(langId: string): Promise<LanguageSupport | null> {
	const desc = grammarFor(langId);
	if (!desc) return null;
	try {
		const support = await desc.load();
		// 第3段 3-14: jsonc は JSON の文法のまま、Command + / の注釈は `//`(JSON の文法は注釈の記号を持たない)
		if (langId === 'jsonc') {
			return new LanguageSupport(support.language, [support.support, support.language.data.of({ commentTokens: { line: '//' } })]);
		}
		return support;
	} catch (err) {
		console.warn(`Could not load the ${desc.name} grammar`, err);
		return null;
	}
}
