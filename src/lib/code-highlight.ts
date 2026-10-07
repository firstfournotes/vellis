/**
 * コードのファイルの閲覧表示の色付け(要件#69 契約3・5・6)。
 *
 * `renderForDisplay` の `text` 分岐が、`languageForFile` で言語の決まったファイルに
 * 使う。出力は今のプレーン表示と同じ class の `<pre>` 1つで、文字の色だけが付く:
 *
 *   <pre class="vellis-plaintext" data-vellis-lang="<id>"><code>
 *     <span class="line"><span style="color:#D73A49">const</span>…</span>\n…
 *   </code></pre>
 *
 * Shiki の `<pre>` の class・style・tabindex は持ち込まない(判断 (j))ので、
 * `codeToHtml` ではなくトークンから組み立てる。トークン化は 1 行ずつ
 * `grammarState` で継ぎ、行ごとに経過時間を確かめる(判断 (r)。1回で呼んだのと
 * 同じトークンになり、時間の増え方は 2% 程度=実測)。言語の読み込みを待つ以外は
 * 途中で処理を譲らない
 * (判断 (q): 譲ると同じ uri の古い内容の結果が後から新しい表示を上書きしうる)。
 *
 * ハイライタは Markdown の `@shikijs/rehype` と同じ `getSingletonHighlighter`
 * (窓に1つ)を使う。上限を超えたとき・失敗したときは null を返し、呼び出し側が
 * プレーン表示にする(例外を外へ出さない=契約6)。
 */
import {
	getSingletonHighlighter,
	getTokenStyleObject,
	stringifyTokenStyle,
	type BundledLanguage,
	type GrammarState,
	type ThemedToken,
} from 'shiki';

/** フェンスと同じテーマ(起案時判断 (f))。 */
const THEME = 'github-light';

/** 文字数(JavaScript の文字列の長さ)の上限。超えたら色付けしない。 */
const MAX_CHARS = 524_288;
/** 行数(`\n` 区切り・末尾の `\n` の後ろの空は数えない)の上限。 */
const MAX_LINES = 10_000;
/** トークン化にかけてよい時間(ミリ秒・行ごとに判定)。言語の読み込みの待ちは含めない。 */
const TIME_LIMIT_MS = 500;
/**
 * この文字数以上の行はその行だけ色を付けない(Shiki の `tokenizeMaxLineLength`)。
 * 1 行の中の走査は途中で止められず、文法によっては文字数の 2 乗の時間になるので
 * 短めに抑える(判断 (r))。
 */
const MAX_LINE_LENGTH = 2_000;

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

function lineCount(content: string): number {
	let count = 0;
	for (let at = content.indexOf('\n'); at >= 0; at = content.indexOf('\n', at + 1)) count++;
	return content.endsWith('\n') ? count : count + 1;
}

function renderLine(tokens: ThemedToken[]): string {
	let out = '<span class="line">';
	for (const token of tokens) {
		const style = stringifyTokenStyle(token.htmlStyle || getTokenStyleObject(token));
		out += style ? `<span style="${escapeHtml(style)}">` : '<span>';
		out += escapeHtml(token.content) + '</span>';
	}
	return out + '</span>';
}

/**
 * `content` を `lang`(Shiki の言語 id)で色付けした html。上限(契約6)に
 * 当たったとき・失敗したときは null。
 */
export async function highlightCode(content: string, lang: string): Promise<string | null> {
	if (content.length > MAX_CHARS || lineCount(content) > MAX_LINES) return null;
	try {
		const highlighter = await getSingletonHighlighter({ themes: [THEME], langs: [lang] });

		const start = performance.now();
		// Shiki と同じ行の割り方(`\r?\n`。単独の CR は行の中に残る)。
		const lines = content.split(/\r?\n/);
		const rendered: string[] = [];
		let grammarState: GrammarState | undefined;
		for (const line of lines) {
			const tokens = highlighter.codeToTokensBase(line, {
				// 表(`$lib/code-language`)の id はどれも Shiki の言語名か別名。
				lang: lang as BundledLanguage,
				theme: THEME,
				grammarState,
				tokenizeMaxLineLength: MAX_LINE_LENGTH,
			});
			grammarState = highlighter.getLastGrammarState(tokens);
			rendered.push(renderLine(tokens[0]));
			if (performance.now() - start > TIME_LIMIT_MS) return null;
		}

		return (
			`<pre class="vellis-plaintext" data-vellis-lang="${escapeHtml(lang)}"><code>` +
			rendered.join('\n') +
			'</code></pre>'
		);
	} catch {
		return null;
	}
}
