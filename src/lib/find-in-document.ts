/**
 * 開いている1文書の中の検索(要件#54)。
 *
 * ここに置くのは**画面を持たない部分**だけ ―― 一致の計算・件数の文言・送りの
 * 循環・ハイライトの付け外し。検索バーの見た目は `../components/FindBar.svelte`、
 * 「どの DOM を探すか」と再検索の契機は `../components/Viewer.svelte` の持ち場。
 *
 * 探す相手は**原文(ソース)ではなく表示テキスト**(契約②)。したがってオフセットは
 * すべて「検索対象コンテナの `textContent` 上の位置」で、原文の位置へは写像しない。
 * Markdown の記法文字(`**` や `[]()`)が一致を邪魔しないのはこのため。
 *
 * ハイライトは **CSS Custom Highlight API** を第一候補にする(契約④)―― DOM を
 * 一切書き換えないので、要件#49 の `data-vellis-node-id` と要件#53 の
 * `data-vellis-hid` の索引に触れずに済む。API の無い環境では `<mark>` で包む
 * フォールバックに落ちるが、**編集の確定より前に必ず外す**(外さないと確定が
 * `<mark>` ごと原文へ焼き付く)。どちらの経路も機械判定できるよう、API の検出は
 * `detectHighlightApi` に切り出して注入できる形にしてある(JSDOM は
 * `CSS.highlights` を持たないので、そのままではフォールバックしか通らない)。
 *
 * 依存追加ゼロ(契約⑦): 標準の文字列操作と DOM だけで書く。
 */

/**
 * Edit メニュー「Find…」(⌘F)のイベント名。`src-tauri/src/menu.rs` の
 * `MENU_FIND_EVENT` と同綴りで、両側のテストが同じリテラルを固定する(要件#34 の家風)。
 */
export const MENU_FIND_EVENT = 'menu_find';

/** 表示テキスト上の一致範囲。`start` は含み `end` は含まない。 */
export type MatchRange = { start: number; end: number };

/** CSS Custom Highlight API の登録名(`::highlight()` セレクタと対)。 */
export const FIND_HIGHLIGHT_NAME = 'vellis-find';
export const FIND_CURRENT_HIGHLIGHT_NAME = 'vellis-find-current';

/** フォールバック `<mark>` の目印。全一致に前者、現在の一致にはさらに後者が付く。 */
export const FIND_MARK_ATTRIBUTE = 'data-vellis-find';
export const FIND_CURRENT_MARK_ATTRIBUTE = 'data-vellis-find-current';

/**
 * ハイライトの登録先。`CSS.highlights` と `Highlight` をそのまま抱えるのではなく
 * この形に包むのは、**環境の有無で経路が分かれること自体を判定できるように**する
 * ため(req-54 受け入れ基準の前提節)。
 */
export type HighlightApi = {
	registry: { set(name: string, value: unknown): void; delete(name: string): boolean };
	createHighlight: (ranges: Range[]) => unknown;
};

// ---------------------------------------------------------------------------
// 一致の計算(契約③)
// ---------------------------------------------------------------------------

/**
 * 表示テキストから語の一致範囲を左から順に集める(契約③)。
 *
 * - **大文字小文字を区別しない**: `toLowerCase()` による素朴な比較で、ロケール
 *   固有の畳み込み(トルコ語の i 等)は考慮しない
 * - **正規表現を解釈しない**: `indexOf` なので `.` も `*` も文字そのもの。語を
 *   エスケープする必要がなく、`\` や `(` で例外にもならない
 * - **重なりなく左から**: 見つけた一致の直後から次を探す(`aa` を `aaaa` から
 *   探すと2件)
 * - **正規化しない**: 改行・連続空白・Unicode 結合文字は表示テキストのまま
 *
 * 空文字の語は常に0件(契約③)―― `indexOf('')` は 0 を返して無限に当たるので、
 * 入口で切る。
 */
export function findMatches(text: string, query: string): MatchRange[] {
	if (query.length === 0 || text.length === 0) return [];
	const haystack = text.toLowerCase();
	const needle = query.toLowerCase();
	const found: MatchRange[] = [];
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at < 0) break;
		found.push({ start: at, end: at + needle.length });
		from = at + needle.length;
	}
	return found;
}

// ---------------------------------------------------------------------------
// 件数と送り(契約④)
// ---------------------------------------------------------------------------

/** 一致0件のときの文言(英語=要件#51)。 */
const NO_RESULTS = 'No results';

/**
 * 件数表示(契約④)。`current` は0始まりの現在一致で、表示は1始まり。
 *
 * 語が空のときだけ**空文字**にする ―― まだ何も探していない状態で「No results」と
 * 出すのは、打ち間違えたかのように見えて紛らわしい。空白だけの語は語として扱う
 * (探した結果0件なので「No results」)。
 */
export function formatCount(current: number, total: number, query: string): string {
	if (query.length === 0) return '';
	if (total <= 0) return NO_RESULTS;
	return `${current + 1} of ${total}`;
}

/**
 * Prev/Next の送り(契約④)。`direction` は Next=1 / Prev=-1 で、**両端で循環**
 * する(最後の次は1件目・1件目の前は最後)。1件だけならどちらでも留まり、
 * 0件は 0 のまま(送りで壊れない)。
 */
export function stepIndex(current: number, total: number, direction: 1 | -1): number {
	if (total <= 0) return 0;
	return (((current + direction) % total) + total) % total;
}

// ---------------------------------------------------------------------------
// ハイライト(契約④)
// ---------------------------------------------------------------------------

/**
 * `win`(既定は `globalThis`)が CSS Custom Highlight API を備えているか。
 *
 * `CSS.highlights` と `Highlight` の**両方**が揃ったときだけ `HighlightApi` を
 * 返す ―― 片方だけの中途半端な環境で API 経路に入ると、登録はできても描画されない
 * (あるいは例外になる)ので、そこはフォールバックに落とす方が安全。
 */
export function detectHighlightApi(win: unknown = globalThis): HighlightApi | null {
	if (typeof win !== 'object' || win === null) return null;
	const scope = win as { CSS?: { highlights?: unknown }; Highlight?: unknown };
	const registry = scope.CSS?.highlights as HighlightApi['registry'] | undefined;
	if (
		!registry ||
		typeof registry.set !== 'function' ||
		typeof (registry as { delete?: unknown }).delete !== 'function'
	) {
		return null;
	}
	const ctor = scope.Highlight;
	if (typeof ctor !== 'function') return null;
	const Highlight = ctor as new (...ranges: Range[]) => unknown;
	return {
		registry,
		createHighlight: (ranges: Range[]) => new Highlight(...ranges),
	};
}

/** `container.textContent` 上の位置と、それを担うテキストノードの対応。 */
type TextSpan = { node: Text; start: number; end: number };

/**
 * コンテナ配下のテキストノードを文書順に並べ、`textContent` 上の位置を振る。
 *
 * `textContent` は子孫のテキストをこの順で連結したものなので、この表がそのまま
 * 「オフセット → ノードと位置」の写像になる。
 */
function textSpans(container: Element): TextSpan[] {
	const owner = container.ownerDocument;
	const walker = owner.createTreeWalker(container, NodeFilter.SHOW_TEXT);
	const spans: TextSpan[] = [];
	let offset = 0;
	let node = walker.nextNode() as Text | null;
	while (node) {
		const length = node.nodeValue?.length ?? 0;
		if (length > 0) {
			spans.push({ node, start: offset, end: offset + length });
			offset += length;
		}
		node = walker.nextNode() as Text | null;
	}
	return spans;
}

/** 一致範囲を1つの DOM `Range` にする(要素境界をまたいでもよい)。 */
function rangeOf(owner: Document, spans: TextSpan[], match: MatchRange): Range | null {
	const head = spans.find((s) => match.start >= s.start && match.start < s.end);
	const tail = spans.find((s) => match.end > s.start && match.end <= s.end);
	if (!head || !tail) return null;
	const range = owner.createRange();
	range.setStart(head.node, match.start - head.start);
	range.setEnd(tail.node, match.end - tail.start);
	return range;
}

/** 一致範囲を、テキストノードごとの断片へ割る(`<mark>` は木を跨げないため)。 */
type WrapJob = { node: Text; from: number; to: number; current: boolean };

function jobsOf(spans: TextSpan[], ranges: MatchRange[], currentIndex: number): WrapJob[] {
	const jobs: WrapJob[] = [];
	ranges.forEach((match, at) => {
		for (const span of spans) {
			if (span.end <= match.start || span.start >= match.end) continue;
			const from = Math.max(match.start, span.start) - span.start;
			const to = Math.min(match.end, span.end) - span.start;
			if (to > from) jobs.push({ node: span.node, from, to, current: at === currentIndex });
		}
	});
	return jobs;
}

/**
 * テキストノードの `[from, to)` を `<mark>` で包む。
 *
 * 呼び出し側は**文書順の逆**に回す ―― 同じノードの後ろの断片を先に切り出して
 * おけば、前の断片のオフセットは分割の影響を受けない。
 */
function wrapSegment(owner: Document, job: WrapJob) {
	let target = job.node;
	const length = target.nodeValue?.length ?? 0;
	if (job.to < length) target.splitText(job.to);
	if (job.from > 0) target = target.splitText(job.from);
	const parent = target.parentNode;
	if (!parent) return;
	const mark = owner.createElement('mark');
	mark.setAttribute(FIND_MARK_ATTRIBUTE, '');
	if (job.current) mark.setAttribute(FIND_CURRENT_MARK_ATTRIBUTE, '');
	parent.replaceChild(mark, target);
	mark.appendChild(target);
}

/**
 * 一致をハイライトする(契約④)。`ranges` は `container.textContent` 上の位置。
 *
 * - **API あり**: DOM は一切書き換えず、全一致と現在の一致を別々の登録名で
 *   `CSS.highlights` へ載せる。要件#49/#53 の索引と衝突しないのがこの経路を
 *   第一候補にする理由
 * - **API なし**: 各一致を `<mark data-vellis-find>` で包み、現在の一致にだけ
 *   `data-vellis-find-current` も付ける。表示テキストと索引属性(値・数)は
 *   変わらないが、**確定の前には必ず `clearHighlights` で外す**こと
 *
 * `ranges` が空なら何もしない(空文字の語でハイライトを出さない=契約③)。
 */
export function applyHighlights(
	container: Element,
	ranges: MatchRange[],
	currentIndex: number,
	api: HighlightApi | null,
): void {
	if (ranges.length === 0) return;
	const owner = container.ownerDocument;
	const spans = textSpans(container);
	if (spans.length === 0) return;

	if (api) {
		const all: Range[] = [];
		for (const match of ranges) {
			const range = rangeOf(owner, spans, match);
			if (range) all.push(range);
		}
		if (all.length === 0) return;
		api.registry.set(FIND_HIGHLIGHT_NAME, api.createHighlight(all));
		const current = all[currentIndex] ?? all[0];
		api.registry.set(FIND_CURRENT_HIGHLIGHT_NAME, api.createHighlight([current]));
		return;
	}

	const jobs = jobsOf(spans, ranges, currentIndex);
	for (let at = jobs.length - 1; at >= 0; at--) wrapSegment(owner, jobs[at]);
}

/**
 * 一致1件を DOM の `Range` にする(要件#54 追補c)。
 *
 * 「表示テキスト上のオフセット」から、それを担うテキストノードと位置を引く
 * ―― ハイライトが使うのと同じ表(`textSpans`)なので、色の付く範囲と
 * スクロールの基準は必ず同じ場所を指す。当たらなければ `null`。
 */
export function rangeAtMatch(container: Element, match: MatchRange): Range | null {
	const spans = textSpans(container);
	if (spans.length === 0) return null;
	return rangeOf(container.ownerDocument, spans, match);
}

/**
 * 一致の文字範囲を、スクロール容器の**中央**へ運ぶ(要件#54 追補c)。
 *
 * 要素ではなく `Range` の矩形を基準にするのが要点 ―― ソース編集中の
 * `<pre contenteditable>` には子要素が無く、要素単位で中央寄せすると
 * `<pre>` 全体(=文書の真ん中)へ飛ぶ(backlog 179)。
 *
 * `scrollIntoView` / `scrollTo` を使わず `scrollTop` へ代入するのは、
 * **容器の中だけ**を動かしたいから(祖先まで巻き込まない)。上端より上へは
 * 行かないよう 0 で止める。
 */
export function scrollRangeIntoContainer(container: HTMLElement, range: Range): void {
	// レイアウトを持たない環境(JSDOM の Range には矩形が無い)では運べない。
	// 検索そのものは文字列の計算なので、ここは黙って何もしないのが正しい。
	if (typeof range.getBoundingClientRect !== 'function') return;
	const rangeRect = range.getBoundingClientRect();
	const containerRect = container.getBoundingClientRect();
	const delta =
		rangeRect.top + rangeRect.height / 2 - (containerRect.top + container.clientHeight / 2);
	container.scrollTop = Math.max(0, container.scrollTop + delta);
}

/**
 * ハイライトを全て外す(契約④・AC-54-13)。
 *
 * API 経路は登録名を捨てるだけ。フォールバックは `<mark>` を解いて `normalize()`
 * で分割したテキストノードを束ね直す ―― ここまでやって初めて `innerHTML` が適用前と
 * 同一に戻り、編集の確定が包む前の DOM を見られる。
 *
 * 経路を取り違えても取りこぼさないよう、どちらでも両方の後始末をする。
 */
export function clearHighlights(container: Element, api: HighlightApi | null): void {
	if (api) {
		api.registry.delete(FIND_HIGHLIGHT_NAME);
		api.registry.delete(FIND_CURRENT_HIGHLIGHT_NAME);
	}
	const marks = [...container.querySelectorAll(`mark[${FIND_MARK_ATTRIBUTE}]`)];
	for (const mark of marks) {
		const parent = mark.parentNode;
		if (!parent) continue;
		while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
		parent.removeChild(mark);
	}
	if (marks.length > 0) container.normalize();
}
