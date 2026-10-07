/**
 * コードのファイルの言語判定(要件#69 契約2)。
 *
 * `text` 分類のファイルのうち、色付けする言語を Shiki の言語 id で返す。表は
 * ここだけに置き、Markdown のフェンスもこの表の言語を読み込む(契約9)。
 *
 * 見るのは最後の `/` の後ろの名前だけ(パス・`file://`・`ssh://` で同じ)。まず
 * 名前の完全一致(大文字小文字を区別)、次に最後の拡張子(`detectFileType` と
 * 同じ取り方=先頭のドットだけの名前は拡張子なし・小文字にそろえる)。
 *
 * `file-type.ts` を import しない(`file-type` → `renderer` → ここ、の循環を
 * 作らない)。拡張子の取り方が同じなのはそのため写している。
 */

/** Shiki の言語 id → 拡張子(小文字)。どれも `detectFileType` で `text` になるもの。 */
const EXTENSIONS: Record<string, string[]> = {
	typescript: ['ts', 'mts', 'cts'],
	tsx: ['tsx'],
	javascript: ['js', 'mjs', 'cjs'],
	jsx: ['jsx'],
	rust: ['rs'],
	python: ['py', 'pyi'],
	ruby: ['rb'],
	go: ['go'],
	java: ['java'],
	kotlin: ['kt', 'kts'],
	swift: ['swift'],
	c: ['c', 'h'],
	cpp: ['cc', 'cpp', 'cxx', 'hpp', 'hh'],
	csharp: ['cs'],
	php: ['php'],
	shellscript: ['sh', 'bash', 'zsh'],
	fish: ['fish'],
	powershell: ['ps1'],
	json: ['json'],
	jsonc: ['jsonc'],
	yaml: ['yaml', 'yml'],
	toml: ['toml'],
	xml: ['xml', 'xhtml', 'plist'],
	ini: ['ini'],
	css: ['css'],
	scss: ['scss'],
	less: ['less'],
	sql: ['sql'],
	graphql: ['graphql', 'gql'],
	lua: ['lua'],
	r: ['r'],
	diff: ['diff', 'patch'],
	vue: ['vue'],
	svelte: ['svelte'],
};

/**
 * ファイル名(完全一致・大文字小文字を区別)→ Shiki の言語 id(判断 (p))。
 * `makefile` は Shiki では `make` の別名だが、別名のままでも読み込める。
 */
const FILE_NAMES = new Map([
	['Makefile', 'makefile'],
	['Dockerfile', 'docker'],
	['.bashrc', 'shellscript'],
	['.zshrc', 'shellscript'],
	['.profile', 'shellscript'],
]);

const BY_EXTENSION = new Map(
	Object.entries(EXTENSIONS).flatMap(([id, exts]) => exts.map((ext) => [ext, id] as const)),
);

/** 表の言語 id(拡張子・ファイル名の両方から)。フェンスで読み込んでよい言語の元。 */
export const CODE_LANGUAGES: readonly string[] = [
	...new Set([...Object.keys(EXTENSIONS), ...FILE_NAMES.values()]),
];

/** 色付けする言語の Shiki の id。表に無ければ null。 */
export function languageForFile(nameOrUri: string): string | null {
	const name = nameOrUri.slice(nameOrUri.lastIndexOf('/') + 1);
	const byName = FILE_NAMES.get(name);
	if (byName) return byName;
	const dot = name.lastIndexOf('.');
	if (dot <= 0) return null;
	return BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? null;
}
