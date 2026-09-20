/**
 * html の複製面に「閲覧(iframe)と同じ見え方」を作るための CSS 細工(要件#54 追補b)。
 *
 * 要件#53 の `buildEditSurface` が作る sanitize 済み複製は Shadow DOM の中へ出す。
 * そこには **`<body>` も `<html>` も無い** ―― 中身は `div.vellis-html-find-root` の
 * 下にぶら下がる。そのため文書 `<head>` の `<style>` をそのまま移すと、
 * `body{max-width:40em;margin:2em auto;font-family:serif}` のような規則が**何にも
 * 当たらず**、閲覧との見た目が食い違う(人間ゲート④の NG=backlog 178)。
 *
 * さらに、Shadow DOM は**継承プロパティを素通しする** ―― アプリ側の
 * `font-family: sans-serif` 等が複製面へ流れ込み、iframe の UA 既定(serif・16px・
 * 黒字白地・`body` の margin 8px)と違って見える。
 *
 * ここに置くのはその2つへの答えだけ:
 *
 * - {@link FIND_SURFACE_BASE_CSS} = **UA 既定の再現**(継承の遮断つき)
 * - {@link rewriteSurfaceCss} = 文書スタイルの**セレクタだけ**を複製面向けに写す
 *
 * どちらも純関数・依存追加ゼロ(契約⑦)。DOM へ入れる順番と場所は
 * `../components/Viewer.svelte` の持ち場。
 */

/**
 * 複製面のルート要素のセレクタ。`Viewer.svelte` がルートに付ける class と対。
 */
export const FIND_SURFACE_ROOT_SELECTOR = '.vellis-html-find-root';

/**
 * 複製面のルートに当てる基底 CSS(iframe の UA 既定の再現=追補b)。
 *
 * - `all: initial` を**先頭**に置いてアプリ側からの継承を遮断する。後ろに置くと
 *   続く `font-family: serif` 等を自分で消してしまう
 * - その上で `<body>` の UA 既定(serif・16px・黒字白地・margin 8px)を宣言する。
 *   ルートは `display: block`(`all: initial` は display を inline に戻すため)
 * - `p` / `h1` などの UA 既定余白には**触らない** ―― ブラウザの既定に任せるのが
 *   いちばん iframe に近い。ここで書くと行間や見出しの余白がずれる
 *
 * 文書側のスタイルはこの**後**に入れる(文書が基底を上書きできる=AC-54b-7)。
 *
 * 引数でルートを取るのは、要件#53 の編集面(`.vellis-html-edit-root`)にも同じ
 * 手当てが要るため ―― 同じ文書を同じ見え方で出す道具を2つ持たない。
 */
export function surfaceBaseCss(rootSelector: string): string {
	return [
		rootSelector,
		'{',
		'all: initial;',
		'display: block;',
		'font-family: serif;',
		'font-size: 16px;',
		'color: #000000;',
		'background-color: #ffffff;',
		'margin: 8px;',
		'}',
	].join('');
}

/** 検索の複製面(`.vellis-html-find-root`)の基底 CSS。 */
export const FIND_SURFACE_BASE_CSS = surfaceBaseCss(FIND_SURFACE_ROOT_SELECTOR);

/** 中に規則(セレクタ+宣言)を持つ at-rule。中身を再帰的に書き換える。 */
const NESTED_AT_RULE = /^@(?:media|supports|container|layer|scope|document|-moz-document)\b/i;

/**
 * ルートへ写す単独セレクタ(`body` / `html` / `:root`)。
 *
 * 直前の文字で「`body` を含むだけの語」を弾く ―― `tbody` `.tbody` `#nobody`
 * `.body` はどれも別物で、触ると文書の見た目を壊す。直後は `[\w-]` でないこと
 * (`bodyguard` のような型セレクタに当てない)。
 */
const ROOT_LIKE_SELECTOR = /(^|[^\w\-.#%\]])(?::root|body|html)(?![\w\-])/g;

/** 引用符で囲まれた範囲の終わり(閉じ引用符の次)。 */
function skipQuoted(css: string, at: number): number {
	const quote = css[at];
	let i = at + 1;
	while (i < css.length) {
		if (css[i] === '\\') {
			i += 2;
			continue;
		}
		if (css[i] === quote) return i + 1;
		i++;
	}
	return css.length;
}

/** コメントの終わり(閉じ記号の次)。 */
function skipComment(css: string, at: number): number {
	const end = css.indexOf('*/', at + 2);
	return end < 0 ? css.length : end + 2;
}

/** `open` の `{` に対応する `}` の位置(見つからなければ末尾)。 */
function findBlockEnd(css: string, open: number): number {
	let depth = 0;
	let i = open;
	while (i < css.length) {
		const ch = css[i];
		if (ch === '"' || ch === "'") {
			i = skipQuoted(css, i);
			continue;
		}
		if (ch === '/' && css[i + 1] === '*') {
			i = skipComment(css, i);
			continue;
		}
		if (ch === '{') {
			depth++;
			i++;
			continue;
		}
		if (ch === '}') {
			depth--;
			if (depth === 0) return i;
			i++;
			continue;
		}
		i++;
	}
	return css.length;
}

/** セレクタ並びを `,` で割る(括弧・角括弧・引用符の中の `,` は割らない)。 */
function splitSelectorList(list: string): string[] {
	const parts: string[] = [];
	let current = '';
	let depth = 0;
	let i = 0;
	while (i < list.length) {
		const ch = list[i];
		if (ch === '"' || ch === "'") {
			const end = skipQuoted(list, i);
			current += list.slice(i, end);
			i = end;
			continue;
		}
		if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
		else if (ch === ',' && depth === 0) {
			parts.push(current);
			current = '';
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	parts.push(current);
	return parts;
}

/**
 * 1本の複合セレクタを書き換える。
 *
 * 属性セレクタ(`[...]`)と文字列の中は触らない ―― `[data-body="body"]` の中身は
 * セレクタではなく値で、写す相手ではない。
 */
function rewriteSelector(selector: string, root: string): string {
	let out = '';
	let plain = '';
	let i = 0;
	const flush = () => {
		out += plain.replace(ROOT_LIKE_SELECTOR, (_m, lead: string) => lead + root);
		plain = '';
	};
	while (i < selector.length) {
		const ch = selector[i];
		if (ch === '"' || ch === "'") {
			const end = skipQuoted(selector, i);
			flush();
			out += selector.slice(i, end);
			i = end;
			continue;
		}
		if (ch === '[') {
			const close = selector.indexOf(']', i);
			const end = close < 0 ? selector.length : close + 1;
			flush();
			out += selector.slice(i, end);
			i = end;
			continue;
		}
		plain += ch;
		i++;
	}
	flush();
	return collapseRepeatedRoot(out, root);
}

/**
 * `html body` のように両方がルートへ写った組を**1つ**に潰す。
 *
 * 写しっぱなしだと `.vellis-html-find-root .vellis-html-find-root` になり、
 * ルートは1つしかないので何にも当たらなくなる(直そうとして壊す典型)。
 */
function collapseRepeatedRoot(selector: string, root: string): string {
	const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pair = new RegExp(escaped + '(?:\\s*>\\s*|\\s+)' + escaped + '(?![\\w\\-])', 'g');
	let current = selector;
	for (;;) {
		const next = current.replace(pair, root);
		if (next === current) return current;
		current = next;
	}
}

/** セレクタ並び(前後の空白は温存)を書き換える。 */
function rewriteSelectorList(prelude: string, root: string): string {
	const lead = /^\s*/.exec(prelude)?.[0] ?? '';
	const tail = /\s*$/.exec(prelude)?.[0] ?? '';
	const body = prelude.slice(lead.length, prelude.length - tail.length);
	if (body.length === 0) return prelude;
	return (
		lead +
		splitSelectorList(body)
			.map((sel) => rewriteSelector(sel, root))
			.join(',') +
		tail
	);
}

/** 規則の並びを順に書き換える(at-rule の中も同じ手で潜る)。 */
function rewriteRules(css: string, root: string): string {
	let out = '';
	let prelude = '';
	let i = 0;
	while (i < css.length) {
		const ch = css[i];
		if (ch === '"' || ch === "'") {
			const end = skipQuoted(css, i);
			prelude += css.slice(i, end);
			i = end;
			continue;
		}
		if (ch === '/' && css[i + 1] === '*') {
			const end = skipComment(css, i);
			prelude += css.slice(i, end);
			i = end;
			continue;
		}
		if (ch === '{') {
			const end = findBlockEnd(css, i);
			const inner = css.slice(i + 1, end);
			const name = prelude.trim();
			if (name.startsWith('@')) {
				// `@media` などは中に規則を持つので潜る。`@font-face` / `@keyframes` /
				// `@page` の中は宣言かキーフレーム選択子なので、そのまま通す。
				out +=
					prelude + '{' + (NESTED_AT_RULE.test(name) ? rewriteRules(inner, root) : inner) + '}';
			} else {
				out += rewriteSelectorList(prelude, root) + '{' + inner + '}';
			}
			i = end < css.length ? end + 1 : css.length;
			prelude = '';
			continue;
		}
		if (ch === ';' || ch === '}') {
			// `@import …;` や壊れた CSS の余った `}`。そのまま流す。
			out += prelude + ch;
			prelude = '';
			i++;
			continue;
		}
		prelude += ch;
		i++;
	}
	return out + prelude;
}

/**
 * 文書 `<style>` のテキストを複製面用に書き換える(追補b)。
 *
 * 触るのは**セレクタだけ**で、宣言(値)と規則の並び順は無傷で通す:
 *
 * - `body` / `html` / `:root` → {@link FIND_SURFACE_ROOT_SELECTOR}
 * - `html body` → ルートセレクタ**1つ**(`.root .root` にしない)
 * - `body > .box` / `body .content` / `body.dark` → ルートを頭にした形
 * - `,` 区切りの各セレクタ・`@media {…}` の中も同じ
 * - `tbody` / `.tbody` / `#nobody` / `.body` は**触らない**
 *
 * CSS の完全なパーサではない(そこまでは要らない)。文書が持つ普通の規則を写す
 * のに足りるだけの走査で、引用符・コメント・入れ子の括弧は跨がないようにしてある。
 */
export function rewriteSurfaceCss(
	css: string,
	rootSelector: string = FIND_SURFACE_ROOT_SELECTOR,
): string {
	if (css.length === 0) return css;
	return rewriteRules(css, rootSelector);
}
