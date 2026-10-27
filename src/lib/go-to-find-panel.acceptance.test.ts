/**
 * 要件#60 追補e の受け入れテスト(docs/requirements/req-60.md「追補e(2026-10-25・Issue #572)」)
 * — Go to で跳べたら検索パネル(要件#55)を閉じて Explorer に戻してからツリーの行へ運ぶ
 * (unit プロジェクト・`+page.svelte` のソース走査=既存の要件60 / 55 の +page 走査と同じ家風)
 *
 * 発見: 検索パネルを出している間は左ペインに Explorer の DOM が無いので、Go to で跳んでも
 * ツリーの行は見えず、行き先がフォルダだとバーが閉じるだけで何も起きないように見える。
 *
 * ## 配線に求める契約(追補e 1〜3。implementer はこれに従う)
 * - `runGoTo` は、跳べた(`revealed`=ツリーの行へ運ぶ URI が null でない)ときだけ、検索パネルを
 *   出していれば(`findInFolderOpen` を読む)`findInFolderOpen = false` にし、`await tick()` を経て
 *   から `scrollTreeItemIntoView(` を呼ぶ(Go メニューの Recent Files=`handleMenuRecentFiles` と同じ形)
 * - 跳べなかった(「無い」・リンク切れ・開く側が落ちた)とき・root の外で新しい窓だけが開いたとき
 *   (`revealed === null` の早期の return)より前には `findInFolderOpen = false` を置かない
 * - 閉じ方は Close ボタンと同じ(`findInFolderOpen = false` だけ。検索の語や結果を別に残す手当ては
 *   しない=起案時判断 (b))。`revealPath` の判定と手段・バーの開閉はそのまま
 *
 * ## 判定(AC-60-追e)
 * - (a) `runGoTo` の本体で、最後の `revealed === null` の早期の return より後に、`findInFolderOpen`
 *   を読む箇所 → `findInFolderOpen = false` → `await tick()` → `scrollTreeItemIntoView(` の順に並ぶ
 * - (b) `findInFolderOpen = false` は、その早期の return より前には無い(`runGoTo` の本体の中で)
 * - (c) 既存の AC-60 のテストは無改変で緑(このファイルは足すだけ。周回の評価=フルスイート)
 * - 不変の守り: `<FindInFolder … onClose={…}>` は今までどおり `findInFolderOpen = false` で閉じる
 *   (= Go to で閉じるときと同じ形)・`handleMenuRecentFiles` の閉じ方(`findInFolderOpen = false` →
 *   `await tick()`)はそのまま
 *
 * ## 判断の記録(test-writer 2026-10-25)
 * - 走査は `async function runGoTo(` から対応する閉じ括弧までを本体とし、行・ブロックのコメントを
 *   落としてから位置関係を見る(コメントの文字で通さない)
 * - 「`findInFolderOpen` を見て」は、代入ではない読み(`if (findInFolderOpen)` など)が代入より前に
 *   あることで判定する。`if` の書き方(ブロック・1 行)は問わない
 * - `await tick()` は代入とスクロールの間に 1 つあればよい(閉じたときだけ待つ形・常に待つ形の
 *   どちらも契約の「DOM に反映されるのを待ってから運ぶ」を満たす)
 * - 「無い」ときにパネルを閉じない(起案時判断 (a))は (b) で早期の return より前に代入が無いことで判定
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../routes/+page.svelte');
const page = () => readFileSync(PAGE_PATH, 'utf-8');

/** 行コメント・ブロックコメントを落とす(位置関係の判定をコメントの文字で通さないため)。 */
function stripJsComments(code: string): string {
	return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/**
 * `open` の位置の開き括弧(`(` / `{`)に対応する閉じ括弧までの中身。文字列・テンプレート・
 * コメントの中の括弧は数えない(GoToBar.brokenlink.wiring.test.ts の `balancedArgs` と同じ簡易版)。
 */
function balanced(source: string, open: number): { inner: string; end: number } {
	const openCh = source[open];
	const closeCh = openCh === '(' ? ')' : '}';
	let depth = 0;
	let quote: string | null = null;
	for (let i = open; i < source.length; i++) {
		const ch = source[i];
		if (quote) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			continue;
		}
		if (ch === '/' && source[i + 1] === '/') {
			const nl = source.indexOf('\n', i);
			i = nl === -1 ? source.length : nl;
			continue;
		}
		if (ch === '/' && source[i + 1] === '*') {
			const end = source.indexOf('*/', i + 2);
			i = end === -1 ? source.length : end + 1;
			continue;
		}
		if (ch === openCh) depth++;
		if (ch === closeCh) {
			depth--;
			if (depth === 0) return { inner: source.slice(open + 1, i), end: i };
		}
	}
	return { inner: source.slice(open + 1), end: source.length };
}

/** `function <name>(` の本体(波括弧の中・コメント抜き)。 */
function functionBody(src: string, name: string): string {
	const head = src.indexOf(`function ${name}(`);
	expect(head, `function ${name}( in +page.svelte`).toBeGreaterThanOrEqual(0);
	const paren = src.indexOf('(', head);
	const args = balanced(src, paren);
	const brace = src.indexOf('{', args.end);
	expect(brace, `function ${name}(…) { … }`).toBeGreaterThan(args.end);
	return stripJsComments(balanced(src, brace).inner);
}

/** `revealed === null` を見る最後の早期の return の位置(その `return` の末尾)。 */
function lastEarlyReturn(body: string): number {
	const checks = [...body.matchAll(/revealed\s*===\s*null/g)];
	expect(checks.length, 'runGoTo keeps the `revealed === null` early return(s)').toBeGreaterThanOrEqual(1);
	const last = checks[checks.length - 1].index ?? 0;
	const ret = body.indexOf('return', last);
	expect(ret, 'the last `revealed === null` check is followed by a return').toBeGreaterThan(last);
	return ret + 'return'.length;
}

/** `findInFolderOpen = false` の位置の一覧(`g` 付きの正規表現は lastIndex を持ち回るので毎回作る)。 */
const assignsFalse = (code: string): number[] =>
	[...code.matchAll(/\bfindInFolderOpen\s*=\s*false\b/g)].map((m) => m.index ?? -1);
/** 代入ではない読み(`if (findInFolderOpen)`・`findInFolderOpen &&` など)の数。 */
const countReads = (code: string): number =>
	[...code.matchAll(/\bfindInFolderOpen\b(?!\s*=[^=])/g)].length;
const AWAIT_TICK = /\bawait\s+tick\s*\(\s*\)/;

// ---------------------------------------------------------------------------
// (a) 跳べたとき: パネルを見て閉じ、tick を待ってから運ぶ
// ---------------------------------------------------------------------------

describe('AC-60-追e (a): runGoTo は跳べたとき findInFolderOpen を見て閉じ、await tick() を経てからツリーの行へ運ぶ(契約 追補e 1)', () => {
	test('早期の return より後に、読み → `findInFolderOpen = false` → `await tick()` → `scrollTreeItemIntoView(` の順に並ぶ', () => {
		const body = functionBody(page(), 'runGoTo');
		expect(body, 'the body still delegates to revealPath').toContain('revealPath(');
		const after = lastEarlyReturn(body);

		const scroll = body.indexOf('scrollTreeItemIntoView(', after);
		expect(scroll, 'scrollTreeItemIntoView( after the early returns (unchanged)').toBeGreaterThan(after);

		const assigns = assignsFalse(body).filter((i) => i > after);
		expect(
			assigns.length,
			'runGoTo closes the Find in Folder panel (`findInFolderOpen = false`) once it could reveal a tree row'
		).toBeGreaterThanOrEqual(1);
		const assign = assigns[0];
		expect(assign, 'the panel is closed before scrolling the row into view').toBeLessThan(scroll);

		expect(
			countReads(body.slice(after, assign)),
			'runGoTo reads `findInFolderOpen` (e.g. `if (findInFolderOpen)`) before closing it — same shape as handleMenuRecentFiles'
		).toBeGreaterThanOrEqual(1);

		expect(
			body.slice(assign, scroll).search(AWAIT_TICK),
			'an `await tick()` sits between `findInFolderOpen = false` and scrollTreeItemIntoView( (the Explorer must be back in the DOM)'
		).toBeGreaterThanOrEqual(0);
	});

	test('閉じるのは `findInFolderOpen = false` だけ(Close ボタンと同じ形=起案時判断 (b))', () => {
		const src = page();
		const body = functionBody(src, 'runGoTo');
		// Close ボタンの閉じ方(不変): <FindInFolder … onClose={…}> が findInFolderOpen = false。
		const tag = /<FindInFolder\b[\s\S]*?\/>/.exec(src);
		expect(tag, '+page.svelte renders <FindInFolder … />').toBeTruthy();
		expect((tag as RegExpExecArray)[0]).toMatch(/onClose=\{[^}]*findInFolderOpen\s*=\s*false/);
		// Go to の閉じ方も同じ代入(別の検索の状態を触る手当ては足さない)。
		expect(assignsFalse(body).length).toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// (b) 跳べなかったとき・新しい窓だけのとき: パネルを閉じない
// ---------------------------------------------------------------------------

describe('AC-60-追e (b): 跳べなかった・新しい窓だけのときはパネルを閉じない(契約 追補e 2・起案時判断 (a))', () => {
	test('`findInFolderOpen = false` は `revealed === null` の早期の return より前には無い', () => {
		const body = functionBody(page(), 'runGoTo');
		const after = lastEarlyReturn(body);
		expect(
			assignsFalse(body.slice(0, after)).length,
			'no `findInFolderOpen = false` before the `revealed === null` early return (a miss keeps the panel and its results)'
		).toBe(0);
	});

	test('revealPath の手段(open / selectTreeItem / newWindow / notFound / brokenLink)の中でもパネルを閉じない', () => {
		const body = functionBody(page(), 'runGoTo');
		const call = body.indexOf('revealPath(');
		expect(call).toBeGreaterThanOrEqual(0);
		const deps = balanced(body, body.indexOf('(', call)).inner;
		expect(assignsFalse(deps).length, 'the deps object passed to revealPath does not touch the panel').toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 不変の守り: Go メニュー Recent Files の閉じ方(同じ形の先例)はそのまま
// ---------------------------------------------------------------------------

describe('AC-60-追e(不変): handleMenuRecentFiles の閉じ方(findInFolderOpen = false → await tick())は変わらない(契約 追補e 3)', () => {
	test('handleMenuRecentFiles は findInFolderOpen を読み、false にして await tick() を待つ', () => {
		const body = functionBody(page(), 'handleMenuRecentFiles');
		const assigns = assignsFalse(body);
		expect(assigns.length).toBeGreaterThanOrEqual(1);
		expect(countReads(body.slice(0, assigns[0]))).toBeGreaterThanOrEqual(1);
		expect(body.slice(assigns[0])).toMatch(AWAIT_TICK);
	});
});
