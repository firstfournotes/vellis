/**
 * レンダリング済み Markdown のブロック単位編集(要件#49)。
 *
 * Spec: `docs/requirements/req-49.md` 契約①②③④⑥。ここは**純関数だけ**を持つ —
 * DOM も状態も持たず、`Viewer.svelte` の配線から直接呼べる形にしてある
 * (要件#48 の `$lib/document-edit` と同じ分担)。
 *
 * 往復は「レンダリング DOM → mdast → Markdown」を `hast-util-to-mdast` +
 * `mdast-util-to-markdown` で行い、得た Markdown で `NodeMeta.position` の範囲を
 * 丸ごと差し替える(契約②)。整形器は通さない — 差し替えるのは編集したブロックの
 * 範囲だけで、その外側は 1 byte も動かさない(契約⑥)。
 *
 * ブロックのマーカー(`## ` / `- ` / `2. ` / `| ` / alert の `[!NOTE]` 行)は
 * mdast のインライン内容には含まれないので、元スライスから採って前後に戻す。
 * そうしないと差し替えで見出しが段落へ・リスト項目が別リストへ落ちる。
 */
import { toMdast } from 'hast-util-to-mdast';
import { toMarkdown } from 'mdast-util-to-markdown';
import type { Element as HastElement, ElementContent, Properties } from 'hast';
import type { PhrasingContent, RootContent } from 'mdast';
import { isBlockType } from './source-index';
import type { NodeMeta, SourceIndex, SourcePosition } from './types';

/** ダブルクリックされた要素をどう扱うか(契約①③)。 */
export type EditTarget =
	/** そのブロックだけを contenteditable にする。`el` は編集単位のブロック要素。 */
	| { kind: 'block'; el: HTMLElement; meta: NodeMeta }
	/**
	 * 要件#52 契約①: トップレベルの code fence。中身を素テキストにして
	 * その場で編集する。`el` は `data-vellis-node-id` を持つ `<pre>`
	 * (Shiki 出力のものも含む=要件#52 契約④)。
	 */
	| { kind: 'code'; el: HTMLElement; meta: NodeMeta }
	/** 編集不可領域。要件#48 のソース編集モードへ誘導する。 */
	| { kind: 'source' };

/** 編集単位になるブロック(契約①)= 段落・見出し・リスト項目・表セル・引用段落。 */
const EDITABLE_TYPES: ReadonlySet<string> = new Set([
	'paragraph',
	'heading',
	'listItem',
	'tableCell',
]);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * 中身を編集単位に繰り上げない領域(要件#49 契約③)。code fence は Shiki が
 * span へ分解していて DOM とテキストが 1 対 1 でなく、mermaid はプレースホルダ
 * なので、どちらも上へ辿らずその場で行き先を決める。
 *
 * 要件#52 契約① で、このうち**トップレベルの code fence だけ**は source では
 * なく `code`(中身の素テキスト編集)へ回る ―― 判断は `resolveFrozenRegion`。
 */
function isFrozenRegion(el: Element): boolean {
	const tag = el.tagName.toLowerCase();
	return tag === 'pre' || tag === 'code' || el.classList.contains('vellis-mermaid');
}

/**
 * 編集不可領域に当たったときの行き先を決める(要件#52 契約①③)。
 *
 * `code` になるのは**トップレベルの fence だけ**:
 * - `<pre>` に source-map の `data-vellis-node-id` があり(契約④)、その meta が
 *   `type === 'code'` ―― 生 HTML の `<pre>` や inline code は当たらない
 * - `parentBlockId === null` ―― リスト項目・引用の中の fence は行頭に `  ` や
 *   `> ` が付くので、中身の差し替えだけでは足りない(契約③)
 * - 原文スライスがフェンスで3分割できる ―― インデント式コードブロックは
 *   フェンス行を持たないので `splitCodeFence` が null を返す(契約③)
 * - `extra.lang !== 'mermaid'` ―― 図の代わりに定義を編集する形は再判断(契約③)
 *
 * どれかを外れたものは従来どおり source = 要件#48 のソース編集モードへ誘導する。
 */
function resolveFrozenRegion(el: Element, index: SourceIndex): EditTarget {
	// mermaid のプレースホルダは `<pre>` を内に持つが、図そのものは編集させない。
	if (el.classList.contains('vellis-mermaid')) return { kind: 'source' };

	const pre = el.closest('pre');
	if (!pre) return { kind: 'source' };
	const id = pre.getAttribute('data-vellis-node-id');
	const meta = id === null ? undefined : index.byId.get(id);
	if (!meta || meta.type !== 'code') return { kind: 'source' };
	if (meta.parentBlockId !== null) return { kind: 'source' };
	if (meta.extra?.lang === 'mermaid') return { kind: 'source' };
	if (splitCodeFence(index.sliceOf(meta.id)) === null) return { kind: 'source' };
	return { kind: 'code', el: pre as HTMLElement, meta };
}

/**
 * `target`(イベントの target 要素)から編集対象を決める。
 *
 * inline 要素(strong / em / code / a …)にも `data-vellis-node-id` は付くが、
 * 編集単位はブロックなので、それを含む最寄りの編集可能ブロックへ繰り上げる。
 * 途中で編集不可のブロック(code / html / blockquote 自体 / hr …)に当たったら
 * そこで打ち切る — その先に編集可能な祖先があっても、当たった側が編集不可。
 *
 * 要件#52 契約①: 打ち切り先のうち**トップレベルの code fence**だけは source では
 * なく `code` を返す ―― 中身は装飾もリンクも持たない素テキストなので、逆
 * シリアライズを通さずフェンス行の間だけを差し替えられる(`resolveFrozenRegion`)。
 */
export function resolveEditTarget(target: Element, index: SourceIndex | null): EditTarget {
	if (!index) return { kind: 'source' };

	let el: Element | null = target;
	while (el) {
		if (isFrozenRegion(el)) return resolveFrozenRegion(el, index);
		const id = el.getAttribute('data-vellis-node-id');
		const meta = id === null ? undefined : index.byId.get(id);
		if (meta) {
			if (EDITABLE_TYPES.has(meta.type)) {
				if (hasIrreversibleLink(el, index.sliceOf(meta.id))) return { kind: 'source' };
				return { kind: 'block', el: el as HTMLElement, meta };
			}
			if (isBlockType(meta.type)) return { kind: 'source' };
		}
		el = el.parentElement;
	}
	return { kind: 'source' };
}

// ---------------------------------------------------------------------------
// code fence の3分割と組み立て(要件#52 契約①②)
// ---------------------------------------------------------------------------

/** 原文スライスをフェンス3分割したもの(要件#52 契約①)。 */
export interface CodeFenceParts {
	/** 開始フェンス行(改行を含まない)。例: '```json' / '~~~yaml' */
	open: string;
	/**
	 * 中身 = スライスを行分割し最初と最後の行を除いた行を `\n` で連結したもの
	 * (= 編集に出す素テキスト)。空フェンスは ''。インデント付き fence では各行の
	 * 先頭から**構造上のインデントを除いた**素テキスト(追補a(6))。
	 */
	body: string;
	/** 終了フェンス行(改行を含まない)。例: '```'。インデントは原文のまま。 */
	close: string;
}

/** 開始フェンス行の印 ―― 行頭から ``` か ~~~ が3つ以上。 */
const FENCE_OPEN = /^(`{3,}|~{3,})/;

/**
 * 行の先頭から**最大 `indent` 個**のスペースを除く(追補a(6))。
 *
 * CommonMark の fence と同じ規則 ―― 開始フェンスが n スペース下がっているとき、
 * 中身の各行からは n スペースまでを除く(n 未満しか下がっていない行は**除ける分
 * だけ**除く)。タブは数えない ―― 追補a(6) が言うインデントはスペース幅なので、
 * タブを部分的に食うと中身が壊れる。
 */
function stripIndent(line: string, indent: number): string {
	let i = 0;
	while (i < indent && line[i] === ' ') i += 1;
	return line.slice(i);
}

/**
 * `index.sliceOf(meta.id)` のスライスをフェンス3分割する(要件#52 契約①)。
 *
 * `null` を返すのは「フェンスの中身編集に載せられないスライス」で、呼び手は
 * 契約③の誘導(ソース編集モード)へ回す:
 * - フェンスで始まらない ―― インデント式コードブロック・段落
 * - 終了フェンス行が無い ―― 閉じないまま文書末で終わった fence。最後の行を
 *   終了フェンスと決めつけると**コードの最終行を食う**ので、載せない側へ回す
 *
 * 終了フェンス行は CommonMark どおり「開始と同じ文字が同じ数以上・前後は空白だけ」
 * で見る。開始行の情報(言語指定)は読まない ―― 差し替えでは開始行も終了行も
 * 原文からそのまま採って書き戻す(契約②)ので、中身が何であれ触らない。
 *
 * `indent` は**開始フェンスのインデント幅**(追補a(6)。呼び手は
 * `meta.position.startColumn - 1` から採る ―― mdast の `position` は**フェンス記号
 * から**始まるのでスライスには開始行のインデントが入っていない)。中身の各行から
 * 最大 `indent` スペースを除いた素テキストを `body` に返す ―― 除かないと行頭の
 * 構造上のインデントが編集面へ露出し、確定でコードの字下げが変わる(Codex review
 * 指摘①)。既定の 0 はインデント無しの fence = 従来どおり。
 *
 * `indent` は**3分割できるかどうかの判定には効かない** ―― 分割の可否は開始行と
 * 終了行の形だけで決まるので、門(`resolveFrozenRegion`)は 0 のまま呼んでよい。
 */
export function splitCodeFence(slice: string, indent = 0): CodeFenceParts | null {
	const opened = FENCE_OPEN.exec(slice);
	if (!opened) return null;

	const lines = slice.split('\n');
	if (lines.length < 2) return null;

	const marker = opened[1];
	const close = lines[lines.length - 1];
	const closing = new RegExp(`^[ \t]{0,3}[${marker[0]}]{${marker.length},}[ \t]*$`);
	if (!closing.test(close)) return null;

	const body = lines
		.slice(1, -1)
		.map((line) => stripIndent(line, indent))
		.join('\n');
	return { open: lines[0], body, close };
}

/**
 * 中身の行のうち、**閉じフェンスとして解釈される**行の形(追補a(7))。
 *
 * CommonMark の閉じフェンスと同じ見方 ―― 行頭 0〜3 スペース + 開始と同じフェンス
 * 文字が開始フェンス長以上連続 + 残りは空白だけ。4 スペース以上下がった行は閉じ
 * フェンスになり得ないので候補ではない。
 */
function closingCandidate(marker: string): RegExp {
	return new RegExp(`^ {0,3}([${marker[0]}]{${marker.length},})[ \t]*$`);
}

/**
 * 中身と衝突しないフェンス行を作る(追補a(7))。
 *
 * 中身に閉じフェンス候補の行があると、確定した原文ではそこで fence が閉じてしまい
 * **元の終了フェンスが次のブロックを開いて後続の文書を飲み込む**(Codex review
 * 指摘②)。CommonMark の正規の逃がし方どおり、開始・終了フェンスのフェンス文字列を
 * **候補の最長 + 1**の長さへ伸ばす ―― info string(開始行のフェンス以降)と終了行の
 * インデントは保持する。
 *
 * 見るのは**再インデント後の行**(= 文書に実際に書かれる行)。インデント付き fence
 * では、素テキストで行頭に見えていた ``` が再インデントで 4 スペース以上下がり、
 * 閉じフェンスになり得なくなることがある ―― 判定は書かれる姿で行う。
 *
 * 候補が無ければ `open` / `close` をそのまま返す = フェンス行は byte 等価(契約⑥)。
 */
function growFence(open: string, close: string, lines: readonly string[]) {
	const opened = FENCE_OPEN.exec(open);
	if (!opened) return { open, close };

	const marker = opened[1];
	const candidate = closingCandidate(marker);
	let longest = 0;
	for (const line of lines) {
		const hit = candidate.exec(line);
		if (hit && hit[1].length > longest) longest = hit[1].length;
	}
	if (longest === 0) return { open, close };

	const fence = marker[0].repeat(longest + 1);
	return {
		open: fence + open.slice(marker.length),
		close: close.replace(new RegExp(`^([ \t]{0,3})[${marker[0]}]+`), (_m, pad: string) => pad + fence),
	};
}

/**
 * 確定用の差し替え文字列を組み立てる(要件#52 契約②)= 開始フェンス行 + 中身 +
 * 終了フェンス行。
 *
 * 中身の末尾は**改行1つ**に揃える(0個なら足し、2個以上なら1つへ)。原文どおりの
 * 数へ戻さないのは、編集中の素テキストに末尾改行があったかどうかが利用者の意図を
 * 表していないため ―― 規約を1つ決めておけば、同じ中身は何度確定しても同じ原文に
 * なる。中身が空(改行だけの場合も含む)なら改行なしで `open + '\n' + close`。
 *
 * `indent` は**開始フェンスのインデント幅**(追補a(6)。`splitCodeFence` に渡したのと
 * 同じ値)。**空行を除く**各行の先頭に `indent` スペースを付け直す ―― 空行に付けると
 * 原文へ行末空白が増え、無編集の往復が byte 等価でなくなる。開始フェンス行のインデント
 * は差し替え範囲の**外**(position はフェンス記号から始まる)、終了フェンス行の
 * インデントは `close` に入ったまま ―― どちらも原文のまま残る。
 *
 * 最後に、書かれる中身と衝突しないようフェンスを伸ばす(追補a(7)= `growFence`)。
 */
export function assembleCodeFence(open: string, body: string, close: string, indent = 0): string {
	const trimmed = body.replace(/\n+$/, '');
	if (trimmed.length === 0) return `${open}\n${close}`;

	const pad = ' '.repeat(indent);
	const lines = trimmed.split('\n').map((line) => (line.length === 0 ? line : pad + line));
	const fence = growFence(open, close, lines);
	return `${fence.open}\n${lines.join('\n')}\n${fence.close}`;
}

/** レンダー時に `rewrite-uri` が書いた内部 URI(原文には現れない綴り)。 */
const INTERNAL_URI = /^(file:|vellis-asset:)/;

/**
 * このブロックに、追補a(11) の読み取りで原文表記へ戻せないリンク・画像があるか
 * (追補a(7) の置き換え = AC-49-18・AC-49-23)。
 *
 * 判定は**要素ごと**に行う: 内部 URI を持つ `a[href]` / `img[src]` のうち、
 * **自分の原文スライスから行き先を読めないもの**が1つでもあれば戻せない。
 * 数の突き合わせ(内部 URI の数 対 スライス中の `](` の数)は採らない ――
 * 本文テキストや inline code の `](` が行き先として数えられ、参照リンクが同居する
 * ブロックで数が合ってしまって誘導を逃す(backlog 162)。
 *
 * 読めないのは次で、いずれも「自分のスライスに `](行き先)` が無い」ことの帰結:
 * - **参照リンク**(`[x][ref]` / `[ref][]` / `[ref]` / `![x][img]`): 行き先は別行の
 *   定義にあり、スライスは `[x][ref]` なので `](` を持たない
 * - **角括弧で囲んだ行き先** `](<a b.md>)`: `destinationsOf` が読まない表記
 * - **生 HTML のインライン `<img>`**: `rehype-raw` が再パースするので
 *   `data-source-*` を持たず、自分のスライスを採れない
 *
 * 戻せないと分かったブロックは編集させず、契約③の誘導(ソース編集モード)へ回す
 * ―― 追補a(4) の「逆写像を入れられない表記は契約③の誘導へ回してよい」の適用。
 *
 * `slice` は `index.sliceOf(meta.id)` = **初回レンダー基準**のブロックスライスで、
 * `serializeBlock` が行き先を読むのに使うもの(`originSlice`)と同じ ―― 門と本体が
 * 同じ原文を見ていないと、「門は素通りしたのに本体では読めない」という形で内部 URI が
 * 原文へ焼き付く(追補a(11)「位置の基準」/ AC-49-25)。
 */
function hasIrreversibleLink(el: Element, slice: string): boolean {
	const origin = originOf(el, slice);
	for (const node of el.querySelectorAll('a[href], img[src]')) {
		const uri = node.getAttribute('href') ?? node.getAttribute('src') ?? '';
		if (!INTERNAL_URI.test(uri)) continue;
		if (destinationOf(node, origin) === undefined) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// DOM → hast
// ---------------------------------------------------------------------------

/**
 * DOM 要素を hast へ写す(`hast-util-to-mdast` の入力)。
 *
 * `data-*` は落とす — source-map プラグインが stamp した位置情報で、逆シリアライズ
 * には要らない(残しても `toMdast` は見ないが、hast の property 名の綴りに合わない)。
 *
 * `href` / `src` はレンダー時に `rewrite-uri` が絶対化した内部 URI
 * (`file://` / `vellis-asset://`)なので、**その要素自身の原文スライス**から読んだ
 * 行き先の綴りへ戻す(追補a(11)= `destinationOf`)。ただしここで入れるのは**札**で、
 * 原文の綴りに戻すのは書き出しの後 ―― `tokenFor` と `restoreDestinations` を参照
 * (追補a(8)(c))。
 */
function toHastElement(el: Element, origin: BlockOrigin | undefined, tokens: Tokens): HastElement {
	const properties: Properties = {};
	for (const name of el.getAttributeNames()) {
		if (name.startsWith('data-')) continue;
		const value = el.getAttribute(name) ?? '';
		const original =
			(name === 'href' || name === 'src') && INTERNAL_URI.test(value)
				? destinationOf(el, origin)
				: undefined;
		properties[name === 'class' ? 'className' : name] =
			original === undefined ? value : tokenFor(original, tokens);
	}
	return {
		type: 'element',
		tagName: el.tagName.toLowerCase(),
		properties,
		children: toHastChildren(el, origin, tokens),
	};
}

/** 発行済みの札(札 → 原文の綴り)と、そのブロック用に選んだ接頭辞。 */
interface Tokens {
	prefix: string;
	map: Map<string, string>;
}

/** 札の芽。ブロックのどこにも現れない綴りになるまで伸ばす。 */
const TOKEN_SEED = 'xvellisuri';

/**
 * そのブロックに**現れ得ない**札の接頭辞を選ぶ(追補a(9))。
 *
 * 戻しは生成結果の `](札` に一致する位置で行うが、`toMarkdown` がエスケープを
 * 通さない構文 ―― **code span の中身**と**リンク文言**(`]` は `\]` に逃がすが
 * 直後の `(` は逃がさない)―― では、本文由来の `](札` がそのまま出力に残る。
 * 接頭辞が DOM のどこにも無ければ、本文・code span・文言・alt・title のどこにも
 * 札は現れ得ず、一致するのは自分で書いた行き先だけになる。
 *
 * 見るのは `outerHTML` **と** `textContent` の両方。`outerHTML` だけでは
 * `xvellis<span>uri0x</span>` のように**要素境界で割れた**綴りを見落とす ――
 * `hast-util-to-mdast` は `span` を unwrap するので、出力では繋がってしまう。
 * unwrap で繋がる文字列は必ず `textContent` の部分文字列になるので両方見れば足り、
 * 属性(title / alt)は `outerHTML` 側が引き続き拾う。
 *
 * 決めるのは**一度の走査**(追補a(13) = AC-49-24)。`x` を1つずつ足しながら
 * `includes` を掛けると、`xvellisurixxxx…` と `x` が続く病的な本文で入力長の二乗に
 * なる(backlog 164・reviewer 実測=10万文字で 1.75 秒)。`TOKEN_SEED` + `x`×k が
 * 本文に現れるのは「`TOKEN_SEED` の直後に `x` が k 個以上続く箇所がある」ときだけ
 * なので、**その最長の連続長 + 1** が求める k になる ―― 芽の出現位置を順に見て
 * 続く `x` を数えれば、掛かる手間は入力長に比例する。
 */
function tokenPrefixFor(el: Element): string {
	const haystack = el.outerHTML + (el.textContent ?? '');
	let longest = -1;
	for (let i = haystack.indexOf(TOKEN_SEED); i !== -1; i = haystack.indexOf(TOKEN_SEED, i + 1)) {
		let run = 0;
		while (haystack[i + TOKEN_SEED.length + run] === 'x') run += 1;
		if (run > longest) longest = run;
	}
	return longest < 0 ? TOKEN_SEED : TOKEN_SEED + 'x'.repeat(longest + 1);
}

/**
 * 原文の綴りを `toMarkdown` のエスケープから守るための差し込み札(追補a(8)(c))。
 *
 * `mdast-util-to-markdown` は行き先を書くとき `(` `)` を `\(` `\)` へエスケープし、
 * 原文にあった `\` は(mdast の url が解決済みの値なので)落とす ―― つまり綴りを
 * そのまま通す道が無い。そこで**書き出しの間だけ無害な札に差し替え**、生成後に
 * 札を原文の綴りへ戻す。札は記号を含まないので `toMarkdown` は何も足さない。
 */
function tokenFor(original: string, tokens: Tokens): string {
	const token = `${tokens.prefix}${tokens.map.size}x`;
	tokens.map.set(token, original);
	return token;
}

/** 生成結果の中で、札が**行き先として**書かれた位置。 */
const TOKEN_DESTINATION = /\]\(([A-Za-z0-9]+)(?=[\s)])/g;

/**
 * 書き出しが済んだ Markdown の**行き先の位置だけ**で札を原文の綴りへ戻す(追補a(9))。
 *
 * 出力全体を `split`/`join` で置換すると、本文テキストやリンク文言に札と同じ
 * 文字列があったときにそこまで行き先へ化ける ―― 稀だが確定的なデータ破壊。
 * 札は記号を含まないので `toMarkdown` は必ず `](札` の形でそのまま書く。その形に
 * 一致する位置だけを戻せば、本文は触らない。
 */
function restoreDestinations(markdown: string, tokens: Tokens): string {
	if (tokens.map.size === 0) return markdown;
	return markdown.replace(TOKEN_DESTINATION, (match, token: string) => {
		const original = tokens.map.get(token);
		return original === undefined ? match : `](${original}`;
	});
}

function toHastChildren(
	node: Node,
	origin: BlockOrigin | undefined,
	tokens: Tokens,
): ElementContent[] {
	const out: ElementContent[] = [];
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === TEXT_NODE) {
			out.push({ type: 'text', value: child.textContent ?? '' });
		} else if (child.nodeType === ELEMENT_NODE) {
			out.push(toHastElement(child as Element, origin, tokens));
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// 行き先は要素の原文範囲から読む(追補a(11))
// ---------------------------------------------------------------------------

/**
 * 行き先の終端になる文字 = **ASCII 空白と制御文字だけ**(CommonMark。追補a(8)(d))。
 *
 * `\s` で切ると U+3000(全角空白)や NBSP でも終端と見なしてしまい、
 * `[x](./a　b.md)` の行き先を最後まで読めない ―― 読めなかったものは
 * `hasIrreversibleLink` の誘導へ回り、**編集できるはずのブロックが編集できなくなる**
 * (backlog 160)。
 */
const ASCII_SPACE_OR_CONTROL = /[\u0000-\u0020\u007f]/;

/**
 * 原文スライスに書かれたリンク・画像の行き先(`](...)` の中身)を**原文の綴りのまま**
 * 読み出す(追補a(8))。
 *
 * 正規表現で済ませないのは、CommonMark の行き先が**バランスした括弧を含んでよい**
 * ため ―― `[a](./a(1).md)` を「`(` で止まる」読み方をすると `./a` しか採れず、
 * 読めないまま内部 URI が原文へ焼き付く(backlog 156)。
 *
 * 走査の規則は CommonMark どおり: `\` は次の1文字を食う・`(` で深さを増し `)` で
 * 減らす・深さ 0 の `)` と ASCII 空白(タイトルの手前)で終わる。角括弧付き
 * `](<...>)` は**読まない** ―― 原理的に戻せない表記として `hasIrreversibleLink` の
 * 誘導へ回す側なので、ここで採ると誘導の判定が緩む。
 */
function* destinationsOf(slice: string): Generator<string> {
	for (let i = 0; i < slice.length; i += 1) {
		if (slice[i] === '\\') {
			i += 1;
			continue;
		}
		if (slice[i] !== ']' || slice[i + 1] !== '(') continue;

		let j = i + 2;
		while (j < slice.length && ASCII_SPACE_OR_CONTROL.test(slice[j])) j += 1;
		if (slice[j] === '<') continue;

		const start = j;
		let depth = 0;
		for (; j < slice.length; j += 1) {
			const c = slice[j];
			if (c === '\\') {
				j += 1;
				continue;
			}
			if (c === '(') depth += 1;
			else if (c === ')') {
				if (depth === 0) break;
				depth -= 1;
			} else if (ASCII_SPACE_OR_CONTROL.test(c)) break;
		}
		yield slice.slice(start, j);
		i = j;
	}
}

/** ブロックの原文スライスと、その先頭に対応する**初回レンダー基準**の絶対 offset。 */
interface BlockOrigin {
	/** ブロック要素自身の `data-source-start`。子の絶対 offset を相対に直す基準。 */
	base: number;
	/** 初回レンダー基準のブロックスライス(`index.sliceOf(meta.id)`)。 */
	slice: string;
}

/**
 * ブロック要素とそのスライスから、子の行き先を読むための基準を作る(追補a(11)
 * 「位置の基準」)。
 *
 * 基準を**ブロック要素自身の `data-source-start`** に取るのは、子の `data-source-*`
 * が初回レンダー基準の絶対値だからで、同じ理由から `slice` も**初回レンダー基準の
 * 原文**(`index.sliceOf(meta.id)`)でなければならない ―― 確定時の原文
 * (`editBuffer`)と補正後の `meta.position` から切った窓は、追補a(1) の delta 補正の
 * ぶんだけでなく、**同じブロックを2回続けて編集すればブロックの中身そのものが初回と
 * 変わっている**ぶんもずれる(backlog 165 / AC-49-25)。
 *
 * 欲しいのは「レンダー時にその要素が原文でどう書かれていたか」であって現在の原文では
 * ないので、基準は初回で正しい。これで門(`hasIrreversibleLink`。`index.sliceOf` で
 * 判定する)と本体(`serializeBlock`)が**同じ原文を見る**ことになり、「門は素通り
 * したのに本体では読めない」という食い違いも消える。
 */
function originOf(el: Element, slice: string): BlockOrigin | undefined {
	const base = offsetAttr(el, 'data-source-start');
	return base === undefined ? undefined : { base, slice };
}

function offsetAttr(el: Element, name: string): number | undefined {
	const raw = el.getAttribute(name);
	if (raw === null) return undefined;
	const value = Number(raw);
	return Number.isInteger(value) ? value : undefined;
}

/**
 * `a` / `img` **自身の原文スライス**から、その要素の行き先の綴りを読む(追補a(11))。
 *
 * 要件#32 のソースマップは `a` / `img` にも自分の原文範囲を stamp しているので、
 * **初回レンダー基準のブロックスライス**(`origin.slice`)をその範囲で切れば、リンク
 * 表記(`[a](./a(1).md)` など)がそのまま採れる ―― `data-source-*` は初回レンダー
 * 基準の絶対 offset なので、確定後の原文から切ってはならない(追補a(11)「位置の
 * 基準」/ AC-49-25)。要素ごとに1対1で対応が付くため、原文の行き先を前向きに写した鍵で DOM の
 * href/src と突き合わせる必要がない ―― 正規化の食い違い(backlog 161)も
 * 同じ行き先の別綴りの畳み込み(backlog 154)も起きようがない。
 *
 * 読めたもののうち**最後**を採るのは、文言に画像を含むリンク
 * `[![alt](a.png)](./x.md)` では自分のスライスに子画像の `](` も入るためで、
 * 自分の行き先は常に末尾側にある。
 *
 * `undefined` を返すのは「行き先を読めない」= 参照リンク(スライスに `](` が無い)・
 * 角括弧付き `](<...>)`・`data-source-*` を持たない生 HTML の `<img>`。
 */
function destinationOf(node: Element, origin: BlockOrigin | undefined): string | undefined {
	if (origin === undefined) return undefined;
	const start = offsetAttr(node, 'data-source-start');
	const end = offsetAttr(node, 'data-source-end');
	if (start === undefined || end === undefined) return undefined;

	const from = start - origin.base;
	const to = end - origin.base;
	if (from < 0 || to > origin.slice.length || from >= to) return undefined;

	let destination: string | undefined;
	for (const raw of destinationsOf(origin.slice.slice(from, to))) destination = raw;
	return destination === undefined || destination.length === 0 ? undefined : destination;
}

// ---------------------------------------------------------------------------
// mdast → Markdown
// ---------------------------------------------------------------------------

/**
 * インライン内容を取り出すために降りる入れ物。
 *
 * `toMdast` が返すのはブロック(root > paragraph / listItem > paragraph /
 * tableCell …)なので、そのまま `toMarkdown` に渡すとマーカーごと書き直される —
 * bare な listItem は `*` に化け、`tableCell` には core の handler が無い。
 * 欲しいのはインライン内容だけなので、入れ物は剥がして中身を集める。
 */
const CONTENT_WRAPPERS: ReadonlySet<string> = new Set([
	'root',
	'paragraph',
	'heading',
	'list',
	'listItem',
	'blockquote',
	'table',
	'tableRow',
	'tableCell',
]);

function phrasingOf(nodes: readonly RootContent[]): PhrasingContent[] {
	const out: PhrasingContent[] = [];
	for (const node of nodes) {
		if (CONTENT_WRAPPERS.has(node.type) && 'children' in node) {
			out.push(...phrasingOf(node.children as RootContent[]));
		} else {
			out.push(node as PhrasingContent);
		}
	}
	return out;
}

/** ブロックのマーカー = 元スライスのうちインライン内容ではない前後。 */
interface Marker {
	prefix: string;
	suffix: string;
}

/**
 * 元スライスからマーカーを採る。
 *
 * - heading: ATX の `## ` / setext の `\n=====`
 * - listItem: `- ` / `*   ` / `2. `(番号も記法も原文のまま残す)
 * - tableCell: セルの position は `| a1 ` のようにパイプと詰め物を含む
 * - paragraph: alert 本文の段落は position が `[!NOTE]` 行を含んだままなので、
 *   その行と続く `> ` を前置きとして残す(消すと alert でなくなる)
 */
function markerOf(type: string, slice: string): Marker {
	if (type === 'heading') {
		const atx = /^[ \t]{0,3}#{1,6}[ \t]+/.exec(slice);
		if (atx) return { prefix: atx[0], suffix: '' };
		const setext = /\n[ \t]*(?:=+|-+)[ \t]*$/.exec(slice);
		if (setext) return { prefix: '', suffix: setext[0] };
		return { prefix: '', suffix: '' };
	}
	if (type === 'listItem') {
		const bullet = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.exec(slice);
		return { prefix: bullet ? bullet[0] : '', suffix: '' };
	}
	if (type === 'tableCell') {
		const prefix = /^[ \t]*\|?[ \t]*/.exec(slice)?.[0] ?? '';
		const suffix = /[ \t]*\|?[ \t]*$/.exec(slice.slice(prefix.length))?.[0] ?? '';
		return { prefix, suffix };
	}
	const alert = /^\[![A-Za-z]+\][^\S\n]*\n[ \t]*>[ \t]?/.exec(slice);
	return { prefix: alert ? alert[0] : '', suffix: '' };
}

/**
 * 編集後のブロック DOM を、`source.slice(startOffset, endOffset)` と差し替えられる
 * Markdown にする(契約②④)。
 *
 * 末尾に改行を足さない — `toMarkdown` は必ず足すが、そのまま差し戻すと空行が
 * 1つ増える = 整形になる(契約⑥)。
 *
 * `rewrite-uri` が絶対化したリンク・画像の URI は、**その要素自身の原文範囲**から
 * 読んだ綴りへ戻す(追補a(11))。`baseUri` はその方式では要らなくなったが、
 * `Viewer.svelte` と既存の受け入れテストが渡す形なので**署名は据え置き**にしてある。
 *
 * `originSlice` は**初回レンダー基準のブロックスライス**(`index.sliceOf(meta.id)`
 * = ダブルクリックの門 `hasIrreversibleLink` が見るのと同じもの)。子の
 * `data-source-*` は初回レンダー基準の絶対 offset なので、**行き先を読むスライスは
 * これ**を使う(追補a(11)「位置の基準」)。`source` と `meta.position` から切ると、
 * 同じブロックを2回続けて編集したとき ―― 1回目の確定でブロックの中身の長さが初回と
 * 変わっている ―― 窓が子の offset と対応せず、内部 URI が原文へ焼き付く
 * (backlog 165 / AC-49-25)。省略時は従来どおり `source` と `meta.position` から
 * 採る(単発編集では同じ値)。
 *
 * 一方で**マーカーの採取と差し替え範囲は現在の原文**(`source` と補正後の
 * `position`)から ―― こちらは「いま差し替える範囲」の話で、初回の綴りとは別の問い。
 */
export function serializeBlock(
	el: Element,
	meta: NodeMeta,
	source: string,
	baseUri?: string,
	originSlice?: string,
): string {
	const slice = source.slice(meta.position.startOffset, meta.position.endOffset);
	const { prefix, suffix } = markerOf(meta.type, slice);
	const origin = originOf(el, originSlice ?? slice);
	const tokens: Tokens = { prefix: tokenPrefixFor(el), map: new Map() };

	const mdast = toMdast({ type: 'root', children: [toHastElement(el, origin, tokens)] });
	const children = phrasingOf(mdast.type === 'root' ? mdast.children : []);
	const inline = restoreDestinations(
		toMarkdown({ type: 'paragraph', children }).replace(/\n+$/, ''),
		tokens,
	);

	return prefix + inline + suffix;
}

/**
 * `position.startOffset`〜`position.endOffset`(0 起点 UTF-16 code unit・end は
 * 排他)だけを `replacement` に置き換える。前後は byte 等価のまま(契約②⑥)。
 */
export function replaceRange(
	source: string,
	position: SourcePosition,
	replacement: string,
): string {
	return source.slice(0, position.startOffset) + replacement + source.slice(position.endOffset);
}
