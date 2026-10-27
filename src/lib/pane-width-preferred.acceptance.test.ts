/**
 * 要件#9 追補a の受け入れテスト(docs/requirements/req-09.md「追補a(2026-10-25・Issue #381)」)
 * — 窓を縮めてから広げ直したら、Explorer の幅は利用者が選んだ幅へ戻る
 * (unit プロジェクト・`+page.svelte` のソース走査。純関数の判定は既存の
 * `pane-resize.acceptance.test.ts`(無改変)で足りる)
 *
 * 発見: `handleWindowResize` が縮めた後の表示中の幅 `explorerWidth` から clamp し直すので、同じ窓で
 * 広げ直しても上限で縮んだ値のまま(再起動すれば保存値に戻る)。
 *
 * ## 配線に求める契約(追補a 1〜4。implementer はこれに従う)
 * - `+page.svelte` は、利用者が選んだ幅(起動時に読んだ保存値・ドラッグで選んだ幅)を、表示中の幅
 *   `explorerWidth` とは別の窓ごとの変数に持つ。**名前は implementer 裁量**(例 `preferredExplorerWidth`)。
 *   本テストは `handleWindowResize` の `clampPaneWidth(` の第 1 引数からその名前を読み取る
 *   (`explorerWidth = clampPaneWidth(<選んだ幅>, window.innerWidth)` の形)。第 1 引数は単一の識別子で、
 *   `explorerWidth` ではないこと。その識別子は `<script>` で `let` 宣言されていること(`$state` でも素の
 *   `let` でもよい)
 * - 窓のリサイズでは選んだ幅から clamp し直すだけで、選んだ幅は書き換えない・保存もしない
 * - 起動時に保存値を読むところ(`loadPaneWidth(` の文)で選んだ幅を更新する。認める形は 2 つ:
 *   `loadPaneWidth(` を含む文で選んだ幅に代入する(`X = loadPaneWidth(…)`・`explorerWidth = X = …`)か、
 *   その文の直後(200 文字以内)で選んだ幅に代入する(`const w = loadPaneWidth(…); X = w;`)
 * - **契約 1-2(2026-10-25 起案に追加)**: 起動時の選んだ幅は保存値そのもの=窓の幅で clamp しない
 *   (下限 200px だけ=例 `loadPaneWidth(Number.POSITIVE_INFINITY)`)。`+page.svelte` の `loadPaneWidth(` の
 *   引数はどれも `innerWidth` を含まない。表示中の幅は、起動時にそれを今の窓の幅で clamp した値
 *   (`explorerWidth = clampPaneWidth(X, window.innerWidth)` を起動の経路に置くか、起動の経路で
 *   `handleWindowResize()` を呼ぶ)。`explorerWidth = loadPaneWidth(window.innerWidth); X = explorerWidth;`
 *   の形は 1-2 に反するので認めない
 * - ドラッグで幅が決まるところ(`.pane-divider` の `onpointermove` / `onpointerup` に束縛した関数のどちらか)で
 *   選んだ幅に代入する。保存(`savePaneWidth`)は今までどおり離した時点だけ
 * - 不変: 範囲(200px〜50%)・既定 250px・保存キー・`src/lib/pane-resize.ts` の純関数・新しい窓への適用
 *
 * ## 判定(AC-9-追a)
 * - (a) `handleWindowResize` は `clampPaneWidth(` に `explorerWidth` ではなく選んだ幅の変数を渡す
 *   (+ 選んだ幅を書き換えない=契約 2 の裏)
 * - (b) 起動時に保存値を読んだところと、ドラッグで幅が決まるところで、選んだ幅の変数を更新している
 * - (c) 窓のリサイズの経路では保存(`savePaneWidth` / `localStorage` / `setItem(`)を呼ばない
 * - (契約 1-2) 起動時の選んだ幅は窓の幅で clamp しない(`loadPaneWidth(` の引数に `innerWidth` が無い)・
 *   表示中の幅は起動の経路で選んだ幅を `clampPaneWidth(X, window.innerWidth)` した値(または
 *   `handleWindowResize()` を呼んで同じ式を通す)。純関数の表: `loadPaneWidth(Infinity)` は保存値を
 *   窓の幅で縮めず下限 200 だけ当て、`clampPaneWidth(それ, 窓の幅)` が表示中の幅になる
 * - (d) 既存の `pane-resize.acceptance.test.ts` は無改変で緑(このファイルは足すだけ)
 * - 不変の守り: ドラッグの確定(`onpointerup` の関数)では今までどおり `savePaneWidth(` を呼び、
 *   移動中(`onpointermove` の関数)では呼ばない
 *
 * ## 判断の記録(test-writer 2026-10-25)
 * - 変数名を固定しないため、(b)(c) も (a) で読み取った名前に依存する。(a) が満たされるまで (b) は
 *   名前が取れずに赤になる(未実装が理由の赤)
 * - 走査は `<script>` の中身からコメントを落として行う。`handleWindowResize` は `const … = () => {` の
 *   アロー関数でも `function handleWindowResize(` でもよい
 * - 起動時の `loadPaneWidth(` は `handleWindowResize` の外にあること(リサイズで保存値を読み直す形は
 *   「選んだ幅から clamp し直す」契約と別物なので認めない)
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clampPaneWidth, loadPaneWidth } from './pane-resize';

const PAGE_PATH = resolve(__dirname, '../routes/+page.svelte');
const page = () => readFileSync(PAGE_PATH, 'utf-8');

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** 行コメント・ブロックコメントを落とす。 */
function stripJsComments(code: string): string {
	return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** `open` の位置の開き括弧(`(` / `{`)に対応する閉じ括弧までの中身(文字列・コメントの中は数えない)。 */
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

/** `<script …>…</script>` の中身(コメント抜き)。 */
function script(): string {
	const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(page());
	expect(m, '+page.svelte has a <script> block').toBeTruthy();
	return stripJsComments((m as RegExpExecArray)[1]);
}

/** `function <name>(` の本体(波括弧の中)。 */
function functionBody(src: string, name: string): string {
	const head = src.indexOf(`function ${name}(`);
	expect(head, `function ${name}( in +page.svelte`).toBeGreaterThanOrEqual(0);
	const paren = src.indexOf('(', head);
	const args = balanced(src, paren);
	const brace = src.indexOf('{', args.end);
	expect(brace, `function ${name}(…) { … }`).toBeGreaterThan(args.end);
	return balanced(src, brace).inner;
}

/** `handleWindowResize` の本体(`const handleWindowResize = () => { … }` でも `function handleWindowResize(` でも)。 */
function resizeBody(src: string): string {
	const arrow = /\bhandleWindowResize\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/.exec(src);
	if (arrow) {
		const brace = arrow.index + arrow[0].length - 1;
		return balanced(src, brace).inner;
	}
	return functionBody(src, 'handleWindowResize');
}

/** `handleWindowResize` の `clampPaneWidth(` の第 1 引数=選んだ幅の変数名(AC (a))。 */
function chosenWidthName(src: string): string {
	const body = resizeBody(src);
	const call = body.indexOf('clampPaneWidth(');
	expect(call, 'handleWindowResize re-clamps with clampPaneWidth(').toBeGreaterThanOrEqual(0);
	const args = balanced(body, body.indexOf('(', call)).inner;
	const first = args.split(',')[0].trim();
	expect(first, 'the first argument of clampPaneWidth( is a single identifier (the chosen width)').toMatch(IDENT);
	expect(
		first,
		'handleWindowResize must clamp the width the user chose, not the currently displayed `explorerWidth` (Issue #381)'
	).not.toBe('explorerWidth');
	return first;
}

/** `X = …`(`==` ではない代入)の位置の一覧。 */
const assignments = (code: string, name: string): number[] =>
	[...code.matchAll(new RegExp(`(^|[^.\\w$])${name}\\s*=(?!=)`, 'g'))].map((m) => m.index ?? -1);

/** `.pane-divider` の開きタグに束縛された pointermove / pointerup の関数名。 */
function dividerHandlers(source: string): { move: string; up: string } {
	const tag = /<div\s[^>]*\bclass="pane-divider"[^>]*>/.exec(source);
	expect(tag, '+page.svelte has <div class="pane-divider" …> (requirement 9)').toBeTruthy();
	const open = (tag as RegExpExecArray)[0];
	const move = /onpointermove=\{(\w+)\}/.exec(open);
	const up = /onpointerup=\{(\w+)\}/.exec(open);
	expect(move, 'the divider binds onpointermove={<fn>}').toBeTruthy();
	expect(up, 'the divider binds onpointerup={<fn>}').toBeTruthy();
	return { move: (move as RegExpExecArray)[1], up: (up as RegExpExecArray)[1] };
}

// ---------------------------------------------------------------------------
// (a) handleWindowResize は選んだ幅から clamp し直す
// ---------------------------------------------------------------------------

describe('AC-9-追a (a): handleWindowResize は clampPaneWidth( に explorerWidth ではなく選んだ幅の変数を渡す(契約 追補a 1・2)', () => {
	test('第 1 引数は explorerWidth 以外の識別子で、その結果を explorerWidth に入れる', () => {
		const src = script();
		const name = chosenWidthName(src);
		const body = resizeBody(src);
		expect(body).toMatch(/\bexplorerWidth\s*=\s*clampPaneWidth\s*\(/);
		expect(body, 'no clamp from the displayed width remains').not.toMatch(/clampPaneWidth\s*\(\s*explorerWidth\b/);
		expect(body).toMatch(new RegExp(`clampPaneWidth\\s*\\(\\s*${name}\\s*,`));
	});

	test('選んだ幅の変数は <script> で let 宣言されている(窓ごとのメモリ)', () => {
		const src = script();
		const name = chosenWidthName(src);
		expect(src, `let ${name} … declared in +page.svelte`).toMatch(new RegExp(`\\blet\\s+${name}\\b`));
	});

	test('handleWindowResize は選んだ幅を書き換えない(窓の都合の縮小は選んだ幅に残さない)', () => {
		const src = script();
		const name = chosenWidthName(src);
		expect(assignments(resizeBody(src), name), `no \`${name} = …\` inside handleWindowResize`).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// (b) 起動時とドラッグで選んだ幅を更新する
// ---------------------------------------------------------------------------

describe('AC-9-追a (b): 起動時に保存値を読んだところと、ドラッグで幅が決まるところで選んだ幅を更新する(契約 追補a 1・3)', () => {
	test('起動時: loadPaneWidth( の文(またはその直後)で選んだ幅に代入する', () => {
		const src = script();
		const name = chosenWidthName(src);
		const resize = resizeBody(src);
		expect(resize, 'the resize path does not re-read the saved value').not.toContain('loadPaneWidth(');

		const call = src.indexOf('loadPaneWidth(');
		expect(call, '+page.svelte reads the saved width with loadPaneWidth( at startup').toBeGreaterThanOrEqual(0);
		const stmtStart = src.lastIndexOf('\n', call) + 1;
		const stmtEnd = src.indexOf(';', call);
		expect(stmtEnd).toBeGreaterThan(call);
		const statement = src.slice(stmtStart, stmtEnd + 1);
		const following = src.slice(stmtEnd + 1, stmtEnd + 1 + 200);
		expect(
			assignments(statement, name).length > 0 || assignments(following, name).length > 0,
			`the chosen width (${name}) is set where the saved value is read: either in the loadPaneWidth( statement or right after it`
		).toBe(true);
	});

	test('ドラッグ: 仕切りの pointermove / pointerup の関数のどちらかで選んだ幅に代入する', () => {
		const source = page();
		const src = script();
		const name = chosenWidthName(src);
		const { move, up } = dividerHandlers(source);
		const bodies = functionBody(src, move) + '\n' + functionBody(src, up);
		expect(
			assignments(bodies, name).length,
			`the chosen width (${name}) follows the drag (in ${move} or ${up})`
		).toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// 契約 1-2: 起動時の選んだ幅は保存値そのもの(窓の幅で clamp しない)・表示中の幅はそれを clamp した値
// ---------------------------------------------------------------------------

/** `src` から、与えた断片をすべて取り除いた残り(起動の経路だけを見るための控え)。 */
function without(src: string, parts: string[]): string {
	let rest = src;
	for (const part of parts) rest = rest.split(part).join('\n');
	return rest;
}

describe('AC-9-追a(契約 1-2): 起動時の選んだ幅は窓の幅で clamp せず、表示中の幅はそれを今の窓の幅で clamp した値', () => {
	test('+page.svelte の loadPaneWidth( の引数はどれも innerWidth を含まない(選んだ幅=保存値そのもの・下限 200 だけ)', () => {
		const src = script();
		const calls: string[] = [];
		const re = /\bloadPaneWidth\s*\(/g;
		for (let m = re.exec(src); m !== null; m = re.exec(src)) {
			calls.push(balanced(src, m.index + m[0].length - 1).inner.trim());
		}
		expect(calls.length, '+page.svelte reads the saved width with loadPaneWidth(').toBeGreaterThanOrEqual(1);
		for (const args of calls) {
			expect(
				args,
				`loadPaneWidth(${args}) — the chosen width must not be clamped by the window width at startup (contract 1-2; e.g. loadPaneWidth(Number.POSITIVE_INFINITY))`
			).not.toMatch(/innerWidth|clientWidth|outerWidth/);
			expect(args, 'loadPaneWidth( takes an explicit width bound (a non-empty argument)').not.toBe('');
		}
	});

	test('起動の経路(リサイズ・ドラッグの関数の外)で explorerWidth = clampPaneWidth(選んだ幅, window.innerWidth) にする(または handleWindowResize() を呼ぶ)', () => {
		const source = page();
		const src = script();
		const name = chosenWidthName(src);
		const { move, up } = dividerHandlers(source);
		const startup = without(src, [resizeBody(src), functionBody(src, move), functionBody(src, up)]);

		const derives = new RegExp(`\\bexplorerWidth\\s*=\\s*clampPaneWidth\\s*\\(\\s*${name}\\s*,\\s*window\\.innerWidth\\s*\\)`).test(startup);
		const reuses = /(^|[^.\w$])handleWindowResize\s*\(\s*\)\s*;/m.test(startup);
		expect(
			derives || reuses,
			`at startup the displayed width is the chosen width (${name}) clamped by the current window: explorerWidth = clampPaneWidth(${name}, window.innerWidth), or a call to handleWindowResize() right after reading the saved value`
		).toBe(true);
		expect(
			startup,
			'the displayed width is not taken from loadPaneWidth( directly at startup (it derives from the chosen width)'
		).not.toMatch(/\bexplorerWidth\s*=\s*loadPaneWidth\s*\(/);
	});

	test('純関数の表: loadPaneWidth(Infinity) は保存値を窓の幅で縮めず(下限 200 だけ)、clampPaneWidth(それ, 窓の幅) が表示中の幅', () => {
		const cases: Array<{ saved: string | null; chosen: number; shown: number }> = [
			// 広めに選んだ 900px: 選んだ幅はそのまま・600px の窓では 300px に見える
			{ saved: '900', chosen: 900, shown: 300 },
			// 人間ゲートの手順: 400px を選び 600px に縮めると 300px、広げ直せば(1200px)400px
			{ saved: '400', chosen: 400, shown: 300 },
			// 下限を割る保存値は 200 に(下限だけは当てる)
			{ saved: '150', chosen: 200, shown: 200 },
			// 未保存は既定 250(狭い窓では 50% の 300 に収まるのでそのまま)
			{ saved: null, chosen: 250, shown: 250 },
		];
		for (const c of cases) {
			localStorage.clear();
			if (c.saved !== null) localStorage.setItem('vellis.explorer-width', c.saved);
			const chosen = loadPaneWidth(Number.POSITIVE_INFINITY);
			expect(chosen, `loadPaneWidth(Infinity) with saved=${c.saved}`).toBe(c.chosen);
			expect(clampPaneWidth(chosen, 600), `clampPaneWidth(${chosen}, 600)`).toBe(c.shown);
		}
		// 広げ直せば選んだ幅に戻る(400 → 1200px の窓では 400)。
		localStorage.setItem('vellis.explorer-width', '400');
		const chosen = loadPaneWidth(Number.POSITIVE_INFINITY);
		expect(clampPaneWidth(chosen, 600)).toBe(300);
		expect(clampPaneWidth(chosen, 1200)).toBe(400);
		// 対照: 窓の幅で読むと選んだ幅そのものが 300 に縮む(=Issue #381 の狭い窓で起動した形)。
		expect(loadPaneWidth(600)).toBe(300);
		localStorage.clear();
	});
});

// ---------------------------------------------------------------------------
// (c) 窓のリサイズの経路では保存しない
// ---------------------------------------------------------------------------

describe('AC-9-追a (c): 窓のリサイズの経路では保存を呼ばない(契約 追補a 3)', () => {
	test('handleWindowResize は savePaneWidth / localStorage / setItem( を呼ばない', () => {
		const body = resizeBody(script());
		expect(body).not.toContain('savePaneWidth(');
		expect(body).not.toContain('localStorage');
		expect(body).not.toContain('setItem(');
	});
});

// ---------------------------------------------------------------------------
// 不変の守り — 保存はドラッグの確定だけ(契約 追補a 3・4)
// ---------------------------------------------------------------------------

describe('AC-9-追a(不変): 保存は仕切りを離した時点だけ(契約 追補a 3)', () => {
	test('pointerup の関数は savePaneWidth( を呼び、pointermove の関数は呼ばない', () => {
		const src = script();
		const { move, up } = dividerHandlers(page());
		expect(functionBody(src, up)).toContain('savePaneWidth(');
		expect(functionBody(src, move)).not.toContain('savePaneWidth(');
	});

	test('src/lib/pane-resize.ts の公開 API はそのまま(clampPaneWidth / loadPaneWidth / savePaneWidth を import する)', () => {
		const src = script();
		const imports = /import\s*\{([^}]*)\}\s*from\s*['"]\$lib\/pane-resize['"]/.exec(src);
		expect(imports, '+page.svelte imports from $lib/pane-resize').toBeTruthy();
		const names = (imports as RegExpExecArray)[1];
		for (const fn of ['clampPaneWidth', 'loadPaneWidth', 'savePaneWidth']) {
			expect(names, `${fn} still comes from $lib/pane-resize`).toMatch(new RegExp(`\\b${fn}\\b`));
		}
	});
});
