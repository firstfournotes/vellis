/**
 * 要件#69 の受け入れテスト(docs/requirements/req-69.md)— 純関数側(unit)
 * 「コードのファイル(.ts・.rs・.py・.json・.yaml・.sh など)を開いたときも、
 *  Markdown のコードフェンスと同じようにシンタックスハイライトして表示する」
 *
 * 配線(Viewer の編集・検索の件数)は src/components/Viewer.codehighlight.wiring.test.ts
 * (component 側)。色の見た目そのものは人間ゲート。
 *
 * ## 実装側に求める形(契約 1〜10 のうち、このテストが固定するもの)
 *
 * ```ts
 * // src/lib/code-language.ts(新規・依存追加ゼロ・file-type.ts を import しない=契約2)
 * // 最後の `/` の後ろの名前だけを見る。まず名前の完全一致(Makefile・Dockerfile・
 * // .bashrc・.zshrc・.profile)、次に最後の拡張子(小文字にそろえる・先頭のドット
 * // だけの名前は拡張子なし)。表に無ければ null
 * export function languageForFile(nameOrUri: string): string | null; // Shiki の言語 id
 * ```
 *
 * `renderForDisplay(uri, content, zoom?)`(src/lib/file-type.ts)の `text` 分岐:
 * - `languageForFile` が id を返し、上限(契約6)に当たらなければ色付き html
 *   `<pre class="vellis-plaintext" data-vellis-lang="<id>"><code><span class="line">…`
 *   (トークンは `<span style="color:#xxxxxx">`・行の間は `\n`・`<pre>` に `shiki` /
 *   `github-light` の class・`style`・`tabindex` を付けない=契約3)。`index` は null
 * - それ以外は今の `renderPlainText` と同じ文字列
 *   `<pre class="vellis-plaintext">\n` + エスケープ済み原文 + `</pre>`(契約1・6)
 * - 上限(契約6・判断 (m)): 文字数 524,288 超・行数 10,000 超(`\n` 区切り。末尾が
 *   `\n` ならその後ろの空は数えない)・トークン化 500ms 超(`performance.now()` で測り、
 *   判定は 1 行ごと=判断 (r))のどれかでプレーン。2,000 文字以上の行はその行だけ色なし
 *   (`tokenizeMaxLineLength: 2000`=判断 (r))。例外を外へ出さない
 * - Markdown のフェンス(契約9): 表の言語(id または Shiki の別名)なら色が付く。
 *   表に無い言語は今のまま付けない。表の全言語を最初に読み込まない(判断 (o))
 *
 * ## 判定するもの(AC 番号は req-69.md の受け入れ基準)
 * - AC-69-10(契約9)フェンス: ```go・```kt・```c++・```ps1・```dockerfile に色・
 *   ```ts・```bash・```html・```markdown は今のまま色・```haskell・```foo は付かない。
 *   **この describe はファイルの先頭に置き、コードのファイルの表示を一度も通さずに
 *   描画する**(読み込みの順に依らないことの判定。vitest はファイル内の describe を
 *   定義順に走らせ、各 describe の beforeAll はそこへ入るまで走らない)
 * - AC-69-1(契約2)言語の表: 拡張子 52・ファイル名 5 を値で固定。大文字の拡張子・
 *   パス・file:// ・ssh:// ・ディレクトリ名のドット
 * - AC-69-2(契約1・2)色付けしないもの: `.txt` `.log` `.csv` `.tsv` `.gitignore` `.env`
 *   `LICENSE` `README` 未知の拡張子・`makefile`(小文字)・`Makefile.am`・
 *   `Dockerfile.dev` は null。表の拡張子・名前はどれも `detectFileType` が `text`。
 *   code-language.ts は file-type.ts を import しない(ソース検査)
 * - AC-69-3(契約1・3)色付きの出力の形と、例の色の値(2026-10-05 に shiki 4.0.2 /
 *   github-light で実測した値を固定: TS `const`=#D73A49・Rust `fn`=#D73A49・
 *   Python `def`=#D73A49・JSON `"k"`=#005CC5・YAML `key`=#22863A・sh `echo`=#005CC5・
 *   Dockerfile `FROM`=#D73A49・Makefile `all`=#6F42C1)
 * - AC-69-4(契約5)表示テキストとエスケープ: 色付きの `textContent` はプレーン表示の
 *   `textContent` と完全一致(タブ・先頭の空行・末尾の改行なし/空行2つ・空文字・CRLF・
 *   単独の CR・BOM・サロゲートペア・`<script>`・`&amp;`・引用符)。出る要素は
 *   pre・code・span、属性は class・style・data-vellis-lang だけ
 * - AC-69-5(契約1)色付けしないものの html は今の `renderPlainText` と文字列一致
 *   (実装前から緑になる不変の判定=退行の防衛線)
 * - AC-69-6(契約6)上限: 文字数 524,288 / 524,289・行数 10,000 / 10,001(末尾 `\n` の
 *   有無)・2,000 文字の行(1,999 は色付き・判断 (r))・時間(`performance.now()` を呼ぶ
 *   たびに 1,000 進める=判定が 1 行ごとでも、最初の 1 行の後の計測で必ず 500ms を超える)。**境目のテストは `performance.now()` を一定値に固定**して時間の
 *   上限が紛れ込まないようにする(並列実行で機械の速さがぶれる)
 * - AC-69-8(契約7)検索の純関数側: 色付き / プレーンで `findMatches` の結果が一致・
 *   `rangeAtMatch` が一致した文字列を指す・`<mark>` フォールバックを外すと html が戻る
 * - AC-69-9(契約8)ssh:// と file:// で同じ html・zoom 引数は効かない・内容を変えれば
 *   新しい内容・print.css の `.markdown-body span` に `print-color-adjust: exact`
 *
 * ## 判定しないもの
 * - 色の見た目・ズーム/印刷の実機・大きなファイルの体感 → 人間ゲート
 * - 言語の読み込み失敗時のプレーン化(契約6 末尾)→ reviewer 照合
 * - `package.json` / `pnpm-lock.yaml` / `find-in-document.ts` / CSS の不変(AC-69-11)→
 *   reviewer の `git diff`(SHA-256 の固定は足さない)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { languageForFile } from './code-language';
import { detectFileType, renderForDisplay } from './file-type';
import { render } from '../markdown/renderer';
import { applyHighlights, clearHighlights, findMatches, rangeAtMatch } from './find-in-document';

const REPO_ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// フィクスチャとヘルパー
// ---------------------------------------------------------------------------

/** 契約の言語の表(id → 拡張子・ファイル名)。拡張子 52・ファイル名 5・言語 36。 */
const LANGUAGE_TABLE: Array<[id: string, exts: string[], names: string[]]> = [
	['typescript', ['ts', 'mts', 'cts'], []],
	['tsx', ['tsx'], []],
	['javascript', ['js', 'mjs', 'cjs'], []],
	['jsx', ['jsx'], []],
	['rust', ['rs'], []],
	['python', ['py', 'pyi'], []],
	['ruby', ['rb'], []],
	['go', ['go'], []],
	['java', ['java'], []],
	['kotlin', ['kt', 'kts'], []],
	['swift', ['swift'], []],
	['c', ['c', 'h'], []],
	['cpp', ['cc', 'cpp', 'cxx', 'hpp', 'hh'], []],
	['csharp', ['cs'], []],
	['php', ['php'], []],
	['shellscript', ['sh', 'bash', 'zsh'], ['.bashrc', '.zshrc', '.profile']],
	['fish', ['fish'], []],
	['powershell', ['ps1'], []],
	['json', ['json'], []],
	['jsonc', ['jsonc'], []],
	['yaml', ['yaml', 'yml'], []],
	['toml', ['toml'], []],
	['xml', ['xml', 'xhtml', 'plist'], []],
	['ini', ['ini'], []],
	['css', ['css'], []],
	['scss', ['scss'], []],
	['less', ['less'], []],
	['sql', ['sql'], []],
	['graphql', ['graphql', 'gql'], []],
	['lua', ['lua'], []],
	['r', ['r'], []],
	['diff', ['diff', 'patch'], []],
	['vue', ['vue'], []],
	['svelte', ['svelte'], []],
	['makefile', [], ['Makefile']],
	['docker', [], ['Dockerfile']],
];

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
};

function escapeHtml(source: string): string {
	return source.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** 今の `renderPlainText`(file-type.ts)と同形の文字列。契約1・5・6 の「プレーン」の値。 */
function plainHtml(content: string): string {
	return `<pre class="vellis-plaintext">\n${escapeHtml(content)}</pre>`;
}

/** html を jsdom に載せる(`{@html}` と同じく HTML の構文解析を通す)。 */
function mount(html: string): HTMLDivElement {
	const div = document.createElement('div');
	div.innerHTML = html;
	return div;
}

function textOf(html: string): string {
	return mount(html).textContent ?? '';
}

/** `style` 付きの span のうち、表示テキストが `text` と一致する最初のもの。 */
function styledSpan(scope: ParentNode, text: string): HTMLElement | null {
	return (
		([...scope.querySelectorAll('span[style]')] as HTMLElement[]).find(
			(el) => el.textContent === text,
		) ?? null
	);
}

function styledSpans(scope: ParentNode): HTMLElement[] {
	return [...scope.querySelectorAll('span[style]')] as HTMLElement[];
}

/**
 * 時間の上限(契約6 (3))を境目のテストに紛れ込ませない: `performance.now()` を
 * 一定の値に固定する(経過時間は常に 0)。
 */
function freezeNow() {
	vi.spyOn(performance, 'now').mockReturnValue(0);
}

/**
 * `performance.now()` を呼ぶたびに 1,000 進める。開始と最初の判定(1 行ごと=判断 (r))の
 * 2 回目の呼び出しで経過が 1,000ms になり、どの行の後に見ても 500ms を超えている。
 */
function racingNow() {
	let t = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => (t += 1000));
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC-69-10 — Markdown のフェンス(契約9)。**ファイルの表示を一度も通していない状態**で
// 描画する=このファイルの最初の describe(上のヘッダ参照)
// ---------------------------------------------------------------------------

describe('AC-69-10 — フェンスは表の言語(id・別名)に色が付く(契約9・読み込みの順に依らない)', () => {
	const MD_URI = 'file:///Users/a/notes/fences.md';

	async function fencePre(lang: string, body: string): Promise<HTMLElement> {
		const result = await render('```' + lang + '\n' + body + '\n```\n', MD_URI);
		const pre = mount(result.html).querySelector('pre');
		if (!pre) throw new Error('フェンスの pre が無い: ' + lang);
		return pre as HTMLElement;
	}

	test('```go: コードのファイルを一度も表示していなくても func に色(#D73A49)が付く', async () => {
		const pre = await fencePre('go', 'func main() {}');
		const func = styledSpan(pre, 'func');
		expect(func, '`func` の span に style が付くこと').not.toBeNull();
		expect(func?.getAttribute('style')).toBe('color:#D73A49');
	});

	test.each([
		['kt', 'fun main() {}'],
		['c++', 'int main() { return 0; }'],
		['ps1', 'Write-Host "hi"'],
		['dockerfile', 'FROM alpine'],
	])('```%s(Shiki の別名)の pre に style 付きの span が出る', async (lang, body) => {
		const pre = await fencePre(lang, body);
		expect(styledSpans(pre).length).toBeGreaterThan(0);
	});

	test.each([
		['ts', 'const a = 1;'],
		['bash', 'echo hi'],
		['html', '<p>x</p>'],
		['markdown', '# title'],
	])('```%s は今のまま色が付く', async (lang, body) => {
		const pre = await fencePre(lang, body);
		expect(styledSpans(pre).length).toBeGreaterThan(0);
	});

	test.each([
		['haskell', 'main :: IO ()\nmain = putStrLn "hi"'],
		['foo', 'bar baz'],
	])('```%s(表に無い)は色が付かず、code の中身は原文の行のまま', async (lang, body) => {
		const pre = await fencePre(lang, body);
		expect(styledSpans(pre)).toHaveLength(0);
		const code = pre.querySelector('code');
		expect(code).not.toBeNull();
		// 今の出力(実測): 色なしのフェンスの <code> は原文の行+末尾の改行をそのまま持つ。
		expect(code?.textContent).toBe(body + '\n');
	});
});

// ---------------------------------------------------------------------------
// AC-69-1 — 言語の表(契約2)
// ---------------------------------------------------------------------------

describe('AC-69-1 — languageForFile は表どおりの言語 id を返す(契約2)', () => {
	test('表の拡張子 52 個(`a.<拡張子>`)がそれぞれの id になる(値固定)', () => {
		const expected: Record<string, string> = {};
		const actual: Record<string, string | null> = {};
		for (const [id, exts] of LANGUAGE_TABLE) {
			for (const ext of exts) {
				expected['a.' + ext] = id;
				actual['a.' + ext] = languageForFile('a.' + ext);
			}
		}
		expect(Object.keys(expected)).toHaveLength(52);
		expect(actual).toEqual(expected);
	});

	test('表のファイル名 5 個(完全一致)がそれぞれの id になる(値固定)', () => {
		const expected: Record<string, string> = {};
		const actual: Record<string, string | null> = {};
		for (const [id, , names] of LANGUAGE_TABLE) {
			for (const name of names) {
				expected[name] = id;
				actual[name] = languageForFile(name);
			}
		}
		expect(Object.keys(expected)).toHaveLength(5);
		expect(actual).toEqual(expected);
	});

	test('表の言語は 36(id の重複なし)', () => {
		const ids = LANGUAGE_TABLE.map(([id]) => id);
		expect(new Set(ids).size).toBe(36);
	});

	test('大文字の拡張子は小文字にそろえて判定する(A.TS・Main.RS)', () => {
		expect(languageForFile('A.TS')).toBe('typescript');
		expect(languageForFile('Main.RS')).toBe('rust');
	});

	test('パス・file:// ・ssh:// のどれでも最後の `/` の後ろの名前で同じに判定する', () => {
		expect(languageForFile('/home/u/a.py')).toBe('python');
		expect(languageForFile('file:///p/a.py')).toBe('python');
		expect(languageForFile('ssh://host/home/u/a.go')).toBe('go');
		expect(languageForFile('ssh://host/home/u/Dockerfile')).toBe('docker');
	});

	test('ディレクトリ名のドットを拡張子と誤認しない', () => {
		expect(languageForFile('/home/user.name/Makefile')).toBe('makefile');
		expect(languageForFile('file:///home/user.name/Makefile')).toBe('makefile');
		expect(languageForFile('/a.b/LICENSE')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-69-2 — 色付けしないもの・表は text の中だけ(契約1・2)
// ---------------------------------------------------------------------------

describe('AC-69-2 — 表に無いファイルは null・表の拡張子はどれも text(契約1・2)', () => {
	const NOT_HIGHLIGHTED = [
		'notes.txt',
		'app.log',
		'data.csv',
		'data.tsv',
		'.gitignore',
		'.env',
		'LICENSE',
		'README',
		'x.unknownext',
		// ファイル名は大文字小文字を区別する(判断 (p))
		'makefile',
		// 名前の完全一致でなく、最後の拡張子(am / dev)が表に無い
		'Makefile.am',
		'Dockerfile.dev',
	];

	test('色付けしないファイルは null', () => {
		expect(Object.fromEntries(NOT_HIGHLIGHTED.map((n) => [n, languageForFile(n)]))).toEqual(
			Object.fromEntries(NOT_HIGHLIGHTED.map((n) => [n, null])),
		);
	});

	test('表の拡張子・ファイル名は detectFileType がすべて text(text でないものが表に無い)', () => {
		const names: string[] = [];
		for (const [, exts, fileNames] of LANGUAGE_TABLE) {
			for (const ext of exts) names.push('a.' + ext);
			names.push(...fileNames);
		}
		expect(Object.fromEntries(names.map((n) => [n, detectFileType(n)]))).toEqual(
			Object.fromEntries(names.map((n) => [n, 'text'])),
		);
	});

	test('text でない種別の拡張子(md・html・svg・png・pdf)は表に無い=null', () => {
		for (const name of ['a.md', 'a.html', 'a.svg', 'a.png', 'a.pdf']) {
			expect(languageForFile(name), name).toBeNull();
		}
	});

	test('code-language.ts は file-type.ts を import しない(循環を作らない=契約2・ソース検査)', () => {
		const source = readFileSync(resolve(REPO_ROOT, 'src/lib/code-language.ts'), 'utf8');
		expect(source).not.toMatch(/from\s+['"][^'"]*file-type['"]/);
		expect(source).not.toMatch(/import\s*\(\s*['"][^'"]*file-type['"]\s*\)/);
	});
});

// ---------------------------------------------------------------------------
// AC-69-3 — 色付きの出力の形(契約1・3)
// ---------------------------------------------------------------------------

describe('AC-69-3 — 色付きの html は vellis-plaintext の pre 1つ・code・style 付き span(契約1・3)', () => {
	test('.ts: pre は class=vellis-plaintext だけ・data-vellis-lang=typescript・style / tabindex なし・pre > code・const が #D73A49・index は null', async () => {
		const result = await renderForDisplay('file:///p/a.ts', 'const a = 1;\n');
		const div = mount(result.html);

		expect(result.index).toBeNull();
		expect(div.children).toHaveLength(1);
		const pre = div.children[0] as HTMLElement;
		expect(pre.tagName).toBe('PRE');
		expect(pre.className).toBe('vellis-plaintext');
		expect(pre.getAttribute('data-vellis-lang')).toBe('typescript');
		expect(pre.hasAttribute('style')).toBe(false);
		expect(pre.hasAttribute('tabindex')).toBe(false);
		expect(pre.querySelector(':scope > code')).not.toBeNull();

		const constSpan = styledSpan(pre, 'const');
		expect(constSpan, '`const` の span に style が付くこと').not.toBeNull();
		expect(constSpan?.getAttribute('style')).toBe('color:#D73A49');
	});

	test('行は `<code>` の下の `span.line`、行の間は `\\n`、トークンは行の中の `span[style]`', async () => {
		const result = await renderForDisplay('file:///p/a.ts', 'const a = 1;\nconst b = 2;\n');
		const code = mount(result.html).querySelector('pre > code');
		expect(code).not.toBeNull();
		const lines = [...(code as HTMLElement).querySelectorAll(':scope > span.line')];
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines[0].textContent).toBe('const a = 1;');
		expect(lines[1].textContent).toBe('const b = 2;');
		expect(lines[0].querySelectorAll('span[style]').length).toBeGreaterThan(0);
		// 行の間の改行は <code> 直下のテキストノード。
		const between = lines[0].nextSibling;
		expect(between?.nodeType).toBe(Node.TEXT_NODE);
		expect(between?.textContent).toBe('\n');
	});

	test.each([
		['file:///p/main.rs', 'fn main() {}\n', 'rust', 'fn', 'color:#D73A49'],
		['file:///p/app.py', 'def f():\n    pass\n', 'python', 'def', 'color:#D73A49'],
		['file:///p/data.json', '{"k": 1}\n', 'json', '"k"', 'color:#005CC5'],
		['file:///p/conf.yaml', 'key: value\n', 'yaml', 'key', 'color:#22863A'],
		['file:///p/run.sh', 'echo hi\n', 'shellscript', 'echo', 'color:#005CC5'],
		['file:///p/Dockerfile', 'FROM alpine\n', 'docker', 'FROM', 'color:#D73A49'],
		['file:///p/Makefile', 'all:\n\techo hi\n', 'makefile', 'all', 'color:#6F42C1'],
	])(
		'%s: data-vellis-lang=%s と、style 付きの span(%s が %s)が出る',
		async (uri, content, lang, token, style) => {
			const result = await renderForDisplay(uri, content);
			const div = mount(result.html);
			const pre = div.querySelector('pre.vellis-plaintext');
			expect(pre).not.toBeNull();
			expect(pre?.getAttribute('data-vellis-lang')).toBe(lang);
			expect(styledSpans(pre as HTMLElement).length).toBeGreaterThan(0);
			const span = styledSpan(pre as HTMLElement, token);
			expect(span, '`' + token + '` の span に style が付くこと').not.toBeNull();
			expect(span?.getAttribute('style')).toBe(style);
			expect(result.index).toBeNull();
		},
	);
});

// ---------------------------------------------------------------------------
// AC-69-4 — 表示テキストとエスケープ(契約5)
// ---------------------------------------------------------------------------

describe('AC-69-4 — 色付きの textContent はプレーン表示の textContent と完全一致(契約5)', () => {
	const SOURCES: Array<[label: string, source: string]> = [
		['タブ', 'const\ta = 1;\n\tconst b = 2;\n'],
		['先頭の空行', '\nconst a = 1;\n'],
		['末尾の改行なし', 'const a = 1;'],
		['末尾の空行2つ', 'const a = 1;\n\n\n'],
		['空文字', ''],
		['CRLF', 'const a = 1;\r\nconst b = 2;\r\n'],
		['単独の CR', 'const a = 1;\rconst b = 2;\r'],
		['BOM', '﻿const a = 1;\n'],
		['サロゲートペア', 'const s = "\u{1F600}";\n'],
		['<script>', '<script>alert(1)</script>\n'],
		['&amp;', 'const s = "&amp;";\n'],
		['引用符', 'const s = "a" + \'b\';\n'],
	];

	test.each(SOURCES)('%s: textContent がプレーン表示と一致する', async (_label, source) => {
		const result = await renderForDisplay('file:///p/a.ts', source);
		expect(textOf(result.html)).toBe(textOf(plainHtml(source)));
	});

	test('LF だけの原文では textContent が原文そのもの', async () => {
		for (const [label, source] of SOURCES) {
			if (/\r/.test(source)) continue;
			const result = await renderForDisplay('file:///p/a.ts', source);
			expect(textOf(result.html), label).toBe(source);
		}
	});

	test('<script が html に出ない・出る要素は pre / code / span だけ・属性は class / style / data-vellis-lang だけ', async () => {
		for (const [label, source] of SOURCES) {
			const result = await renderForDisplay('file:///p/a.ts', source);
			expect(result.html, label).not.toContain('<script');
			const div = mount(result.html);
			const tags = new Set([...div.querySelectorAll('*')].map((el) => el.tagName.toLowerCase()));
			expect([...tags].sort(), label).toEqual(
				[...tags].filter((t) => ['pre', 'code', 'span'].includes(t)).sort(),
			);
			const attrs = new Set(
				[...div.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name)),
			);
			expect([...attrs].sort(), label).toEqual(
				[...attrs].filter((a) => ['class', 'style', 'data-vellis-lang'].includes(a)).sort(),
			);
		}
	});

	test('色付きの出力でも生の < > & " \' はエスケープされている(原文の文字が html の構文に混ざらない)', async () => {
		const source = 'if (a < b && c > "d") { s = \'<x>\'; }\n';
		const result = await renderForDisplay('file:///p/a.ts', source);
		// 構文解析して戻った表示テキストが原文に一致する=エスケープが正しい。
		expect(textOf(result.html)).toBe(source);
		// タグとして解釈される `<x>` が出ていない。
		expect(mount(result.html).querySelector('x')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-69-5 — 色付けしないものの html は今のまま(契約1)
// ---------------------------------------------------------------------------

describe('AC-69-5 — 表に無いファイルの html は renderPlainText と文字列で一致(契約1)', () => {
	const CONTENT = '# not-a-heading\n<script>alert(1)</script>\n*not-em*\n\tindented & "q" \'s\'\n';

	test.each(['notes.txt', 'LICENSE', '.gitignore', 'x.unknownext'])(
		'%s: `<pre class="vellis-plaintext">\\n` + エスケープ済み原文 + `</pre>`',
		async (name) => {
			const result = await renderForDisplay('file:///p/' + name, CONTENT);
			expect(result.html).toBe(plainHtml(CONTENT));
			expect(result.index).toBeNull();
		},
	);
});

// ---------------------------------------------------------------------------
// AC-69-6 — 大きなファイルの上限(契約6・判断 (m))
// ---------------------------------------------------------------------------

describe('AC-69-6 — 上限を超えたらプレーン・超えなければ色付き(契約6)', () => {
	const TS_URI = 'file:///p/big.ts';

	/**
	 * 1 行 64 文字(改行込み)の TypeScript。524,288 = 64 × 8,192 なので、8,192 行で
	 * ちょうど文字数の上限に乗る(行数は 10,000 以下・1 行は 20,000 文字未満)。
	 */
	function sixtyFourCharLines(count: number): string {
		let out = '';
		for (let i = 0; i < count; i++) {
			const head = `const v${i} = ${i}; // `;
			out += head + 'x'.repeat(63 - head.length) + '\n';
		}
		return out;
	}

	/**
	 * 512KB / 10,000 行のトークン化はフルスイートの並列実行下で 3.7〜4.3 秒かかり、
	 * vitest の既定 5 秒に近い。境目の重いテストにだけタイムアウトを明示する(判定は同じ)。
	 */
	const HEAVY_TIMEOUT = 30_000;

	test('前提: 64 文字 × 8,192 行はちょうど 524,288 文字', () => {
		expect(sixtyFourCharLines(8192)).toHaveLength(524_288);
	});

	test('文字数 524,288 は色付き・524,289 はプレーン(時間は固定)', async () => {
		freezeNow();
		const atLimit = sixtyFourCharLines(8192);
		const colored = await renderForDisplay(TS_URI, atLimit);
		expect(styledSpans(mount(colored.html)).length).toBeGreaterThan(0);
		expect(mount(colored.html).querySelector('pre')?.getAttribute('data-vellis-lang')).toBe(
			'typescript',
		);

		const overLimit = atLimit + 'x';
		expect(overLimit).toHaveLength(524_289);
		const plain = await renderForDisplay(TS_URI, overLimit);
		expect(plain.html).toBe(plainHtml(overLimit));
	}, HEAVY_TIMEOUT);

	test('行数: `x\\n` × 10,000 と `x\\n` × 9,999 + `x` は色付き(時間は固定)', async () => {
		freezeNow();
		for (const source of ['x\n'.repeat(10_000), 'x\n'.repeat(9_999) + 'x']) {
			const result = await renderForDisplay(TS_URI, source);
			expect(styledSpans(mount(result.html)).length, JSON.stringify(source.length)).toBeGreaterThan(
				0,
			);
		}
	}, HEAVY_TIMEOUT);

	test('行数: `x\\n` × 10,001 と `x\\n` × 10,000 + `x` はプレーン(時間は固定)', async () => {
		freezeNow();
		for (const source of ['x\n'.repeat(10_001), 'x\n'.repeat(10_000) + 'x']) {
			const result = await renderForDisplay(TS_URI, source);
			expect(result.html, JSON.stringify(source.length)).toBe(plainHtml(source));
		}
	}, HEAVY_TIMEOUT);

	/**
	 * 行コメントの長い行(判断 (r))。`const x = "…";` の形は文法の走査が 1 行の中で
	 * 文字数の 2 乗の時間になるので、長い行のフィクスチャには使わない(実測: 2,000 字で
	 * コメント 0.3ms・文字列 62ms。どちらも 2,000 字で色なし・1,999 字で色付き)。
	 */
	function commentLine(length: number): string {
		const line = '// ' + 'a'.repeat(length - 3);
		expect(line).toHaveLength(length);
		return line;
	}

	test('2,000 文字の行はその行だけ色なし・次の行には色が付く(時間は固定)', async () => {
		freezeNow();
		const long = commentLine(2_000);
		const result = await renderForDisplay(TS_URI, long + '\nconst a = 1;\n');
		const lines = [...mount(result.html).querySelectorAll('pre > code > span.line')];
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines[0].textContent).toBe(long);
		expect(lines[0].querySelectorAll('span[style]')).toHaveLength(0);
		expect(lines[1].querySelectorAll('span[style]').length).toBeGreaterThan(0);
	});

	test('1,999 文字の行には色が付く(時間は固定)', async () => {
		freezeNow();
		const long = commentLine(1_999);
		const result = await renderForDisplay(TS_URI, long + '\nconst a = 1;\n');
		const lines = [...mount(result.html).querySelectorAll('pre > code > span.line')];
		expect(lines[0].textContent).toBe(long);
		expect(lines[0].querySelectorAll('span[style]').length).toBeGreaterThan(0);
	});

	test('performance.now() が呼ぶたびに 1,000 進むと、上限内の原文でもプレーン(時間の上限 500ms)', async () => {
		racingNow();
		const source = 'const a = 1;\nconst b = 2;\n';
		const result = await renderForDisplay(TS_URI, source);
		expect(result.html).toBe(plainHtml(source));
		expect(result.index).toBeNull();
	});

	test('どの場合も例外を投げない(上限超えの文字数・行数・時間)', async () => {
		racingNow();
		await expect(renderForDisplay(TS_URI, 'const a = 1;\n')).resolves.toBeDefined();
		vi.restoreAllMocks();
		freezeNow();
		await expect(renderForDisplay(TS_URI, 'x\n'.repeat(10_001))).resolves.toBeDefined();
		await expect(renderForDisplay(TS_URI, sixtyFourCharLines(8192) + 'x')).resolves.toBeDefined();
	}, HEAVY_TIMEOUT);
});

// ---------------------------------------------------------------------------
// AC-69-8 — 検索の純関数側(契約7)
// ---------------------------------------------------------------------------

describe('AC-69-8 — 色付きの表示でもプレーン表示と同じ一致・範囲(契約7)', () => {
	const SOURCE = 'const a = 1;\nconst b = a + 1;\n';
	let colored: HTMLDivElement;
	let plain: HTMLDivElement;

	beforeAll(async () => {
		const result = await renderForDisplay('file:///p/search.ts', SOURCE);
		colored = mount(result.html);
		plain = mount(plainHtml(SOURCE));
		// 前提: 色付きである(そうでなければ検索の判定が同じ DOM 同士の比較になる)。
		expect(styledSpans(colored).length).toBeGreaterThan(0);
	});

	test.each([
		['const', 'const'],
		['トークンをまたぐ', 'a = 1'],
		['行をまたぐ', '1;\nconst'],
		['大文字', 'CONST'],
	])('%s(%s): findMatches が一致し、rangeAtMatch が一致した文字列を指す', (_label, query) => {
		const coloredText = colored.textContent ?? '';
		const plainText = plain.textContent ?? '';
		expect(coloredText).toBe(plainText);

		const expected = findMatches(plainText, query);
		expect(expected.length).toBeGreaterThan(0);
		const actual = findMatches(coloredText, query);
		expect(actual).toEqual(expected);

		for (const match of actual) {
			const range = rangeAtMatch(colored, match);
			expect(range).not.toBeNull();
			expect(range?.toString()).toBe(coloredText.slice(match.start, match.end));
			expect(range?.toString().toLowerCase()).toBe(query.toLowerCase());
		}
	});

	test('<mark> のフォールバックを付けて外すと html が付ける前と同じ文字列に戻る', () => {
		const before = colored.innerHTML;
		const matches = findMatches(colored.textContent ?? '', 'a = 1');
		expect(matches.length).toBeGreaterThan(0);

		applyHighlights(colored, matches, 0, null);
		expect(colored.querySelectorAll('mark[data-vellis-find]').length).toBeGreaterThan(0);
		// 表示テキストは mark で変わらない。
		expect(colored.textContent).toBe(SOURCE);

		clearHighlights(colored, null);
		expect(colored.querySelectorAll('mark').length).toBe(0);
		expect(colored.innerHTML).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// AC-69-9 — ssh・zoom・変更追従・印刷の規則(契約8)
// ---------------------------------------------------------------------------

describe('AC-69-9 — ssh:// も同じに色付け・zoom は効かない・内容を変えれば追従(契約8)', () => {
	const SOURCE = 'def f():\n    return 1\n';

	test('ssh://host/home/u/a.py の html は file:///home/u/a.py と同じ(色付き)', async () => {
		const ssh = await renderForDisplay('ssh://host/home/u/a.py', SOURCE);
		const local = await renderForDisplay('file:///home/u/a.py', SOURCE);
		expect(styledSpans(mount(local.html)).length).toBeGreaterThan(0);
		expect(ssh.html).toBe(local.html);
	});

	test('zoom 引数は text の出力に効かない(1.5 でも html は同じ)', async () => {
		const zoomed = await renderForDisplay('file:///home/u/a.py', SOURCE, 1.5);
		const plainZoom = await renderForDisplay('file:///home/u/a.py', SOURCE);
		expect(zoomed.html).toBe(plainZoom.html);
	});

	test('同じ uri で内容を変えて呼び直すと新しい内容の textContent になる', async () => {
		const first = await renderForDisplay('file:///home/u/a.py', SOURCE);
		const changed = 'def g():\n    return 2\n';
		const second = await renderForDisplay('file:///home/u/a.py', changed);
		expect(textOf(first.html)).toBe(SOURCE);
		expect(textOf(second.html)).toBe(changed);
		expect(styledSpans(mount(second.html)).length).toBeGreaterThan(0);
	});

	test('前提: print.css の @media print に `.markdown-body span` を含む print-color-adjust: exact の規則がある', () => {
		const css = readFileSync(resolve(REPO_ROOT, 'src/styles/print.css'), 'utf8');
		const start = css.indexOf('@media print');
		expect(start).toBeGreaterThanOrEqual(0);
		// `@media print {` の中身を波括弧の対応で切り出す。
		const open = css.indexOf('{', start);
		let depth = 0;
		let end = -1;
		for (let i = open; i < css.length; i++) {
			if (css[i] === '{') depth++;
			else if (css[i] === '}' && --depth === 0) {
				end = i;
				break;
			}
		}
		expect(end).toBeGreaterThan(open);
		const block = css.slice(open + 1, end);
		const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
		const hit = rules.find(
			([, selectors, body]) =>
				selectors
					.split(',')
					.map((s) => s.trim())
					.includes('.markdown-body span') && /print-color-adjust\s*:\s*exact/.test(body),
		);
		expect(hit, '.markdown-body span に print-color-adjust: exact').toBeTruthy();
	});
});
