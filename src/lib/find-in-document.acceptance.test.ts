/**
 * 要件#54 の受け入れテスト(docs/requirements/req-54.md)— 純関数側(unit)
 *
 * 「開いているファイル内の検索」の一致計算(AC-54-1/2/3)・件数表示(AC-54-4)・
 * Prev/Next の循環(AC-54-5/6)・ハイライト適用の分岐(AC-54-9/13 の純関数側=
 * Highlight API があれば CSS.highlights へ登録・無ければ <mark> フォールバックし
 * 確定前に外せる)を、新規モジュール `src/lib/find-in-document.ts` の純関数として
 * 判定する。配線(⌘F → 検索バー → Viewer)は
 * src/components/Viewer.find.wiring.test.ts(component 側)。AC-54-15(メニュー)は
 * src-tauri/tests/acceptance_req54.rs。
 *
 * ## 実装側に求める形(implementer はこれに従う。API 契約=本テストが決める)
 *
 * ```ts
 * // src/lib/find-in-document.ts(新規・依存追加ゼロ=標準の文字列操作と DOM のみ)
 *
 * // menu.rs の MENU_FIND_EVENT と綴りを合わせる(要件#48 の MENU_EDIT_EVENT と同型)
 * export const MENU_FIND_EVENT = 'menu_find';
 *
 * // 表示テキスト上の一致範囲。start は含む・end は含まない。オフセットは
 * // 検索対象コンテナの textContent 基準(原文=ソースへは写像しない・契約②)
 * export type MatchRange = { start: number; end: number };
 *
 * // 契約③: 大文字小文字を区別しない(toLowerCase の素朴比較・ロケール畳み込み
 * // なし)・正規表現を解釈しない部分一致を、重なりなく左から。空文字 query は []
 * export function findMatches(text: string, query: string): MatchRange[];
 *
 * // 契約④: 件数表示。current は 0 始まりの現在一致。query が空文字 → ''、
 * // 一致 0 件 → 'No results'、それ以外 → `${current + 1} of ${total}`(英語=要件#51)
 * export function formatCount(current: number, total: number, query: string): string;
 *
 * // 契約④: Prev/Next の送り(0 始まり)。direction は Next=1 / Prev=-1。
 * // 両端で循環・1件だけなら留まる・total 0 は 0 を返す
 * export function stepIndex(current: number, total: number, direction: 1 | -1): number;
 *
 * // CSS Custom Highlight API の登録名(::highlight() セレクタと対)
 * export const FIND_HIGHLIGHT_NAME = 'vellis-find';
 * export const FIND_CURRENT_HIGHLIGHT_NAME = 'vellis-find-current';
 * // フォールバック <mark> の目印属性(全一致に付く。現在一致にはさらに後者も)
 * export const FIND_MARK_ATTRIBUTE = 'data-vellis-find';
 * export const FIND_CURRENT_MARK_ATTRIBUTE = 'data-vellis-find-current';
 *
 * // Highlight API の注入点。JSDOM は CSS.highlights / Highlight を持たないため、
 * // 「あれば使い、無ければフォールバック」の分岐は api が null かどうかで切る
 * // (req-54 前提節の指示どおり両経路を機械判定できる形)
 * export type HighlightApi = {
 * 	registry: { set(name: string, value: unknown): void; delete(name: string): boolean };
 * 	createHighlight: (ranges: Range[]) => unknown;
 * };
 * // win(既定 globalThis)に CSS.highlights と Highlight の両方があるときだけ
 * // HighlightApi を返す(registry は CSS.highlights そのもの・createHighlight は
 * // new Highlight(...ranges))。どちらかが無ければ null = <mark> フォールバック
 * export function detectHighlightApi(win?: unknown): HighlightApi | null;
 *
 * // ranges(container.textContent のオフセット)をハイライトする。
 * // api あり: DOM は一切書き換えず、
 * //   registry.set(FIND_HIGHLIGHT_NAME, createHighlight(全一致の Range 配列)) と
 * //   registry.set(FIND_CURRENT_HIGHLIGHT_NAME, createHighlight([現在一致の Range]))
 * //   を登録する(DOM を変えないので #49/#53 の索引と衝突しない=採用理由)
 * // api なし: 各一致を <mark data-vellis-find> で包み、現在一致の mark には
 * //   data-vellis-find-current も付ける。textContent と data-vellis-* 索引属性
 * //   (値・数)は不変。要素境界をまたぐ一致は複数の mark に分かれてよい
 * // ranges が空なら何もしない
 * export function applyHighlights(
 * 	container: Element,
 * 	ranges: MatchRange[],
 * 	currentIndex: number,
 * 	api: HighlightApi | null,
 * ): void;
 * // ハイライトを全て外す。api あり: registry.delete(両名)。api なし: <mark> を
 * // 外して innerHTML が適用前と同一へ戻る(編集の確定より前に必ず外せる=AC-54-13)
 * export function clearHighlights(container: Element, api: HighlightApi | null): void;
 * ```
 *
 * ## 判定するもの(AC 番号は req-54.md の受け入れ基準)
 * - AC-54-1 一致位置の計算(契約③): 大文字小文字を区別しない・部分一致・
 *   重なりなく左から(`aa` を `aaaa` から探すと2件)
 * - AC-54-2 正規表現を解釈しない(契約③): `a.c` は `abc` に当たらず `a.c` に当たる。
 *   `*` `[` `(` `\` で例外にならない
 * - AC-54-3 空文字と無一致(契約③④): 空文字は0件で表示は空。無一致は 'No results'
 * - AC-54-4 件数表示 `n of m`(契約④)
 * - AC-54-5 Prev/Next の循環(契約④)
 * - AC-54-6 語を変えると先頭へ(契約④)— 「再検索後の現在一致は先頭」の純関数側=
 *   findMatches が常に左から並んだ配列を返し、先頭一致 = index 0 で表現できること
 * - AC-54-9/13 の純関数側: ハイライト適用の分岐(CSS Custom Highlight API /
 *   <mark> フォールバック)と、フォールバックを確定前に外して DOM が元に戻ること
 * - AC-54-14 不変と依存(契約⑦): package.json の dependencies に追加が無い・
 *   tauri.conf.json の CSP と capability の値固定・不変ファイルの SHA-256 固定
 *
 * ## 判定しないもの
 * - 検索バーの表示・キー操作・種別ごとの対象・再検索の契機 → Viewer.find.wiring.test.ts
 * - メニュー項目(Find…・⌘F・menu_find の emit)→ src-tauri/tests/acceptance_req54.rs
 * - ハイライトの見た目・scrollIntoView の体感 → 人間ゲート(acceptance.md 要件#54)
 *
 * ## 境界の明示(tasks/lessons.md「仕様の境界を明示的に渡す」)
 * 語が本文の末尾で終わる・本文全体と一致・改行/連続空白は正規化しない・
 * Unicode 結合文字は正規化しない、を1件ずつ固定する。
 */
import { afterEach, describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	applyHighlights,
	clearHighlights,
	detectHighlightApi,
	FIND_CURRENT_HIGHLIGHT_NAME,
	FIND_CURRENT_MARK_ATTRIBUTE,
	FIND_HIGHLIGHT_NAME,
	FIND_MARK_ATTRIBUTE,
	findMatches,
	formatCount,
	MENU_FIND_EVENT,
	stepIndex,
	type HighlightApi,
	type MatchRange,
} from './find-in-document';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** 一致の中身が期待どおりで、かつ各範囲が query と(大文字小文字を除き)同じ
 * 文字列を指すことを確かめて返す。 */
function expectMatches(text: string, query: string, expected: string[]): MatchRange[] {
	const ranges = findMatches(text, query);
	expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(expected);
	for (const r of ranges) {
		expect(text.slice(r.start, r.end).toLowerCase()).toBe(query.toLowerCase());
	}
	return ranges;
}

const mounted: HTMLElement[] = [];

/** DOM フィクスチャを document に載せて返す(textContent 基準のオフセット計算と
 * Range の toString に実 DOM が要る)。 */
function mountFixture(html: string): HTMLElement {
	const host = document.createElement('div');
	host.innerHTML = html;
	document.body.appendChild(host);
	mounted.push(host);
	return host;
}

afterEach(() => {
	for (const el of mounted.splice(0)) el.remove();
});

/** 偽の Highlight API(記録付き)。registry は Map = set/delete を満たす。 */
function fakeApi() {
	const registry = new Map<string, unknown>();
	const created: Range[][] = [];
	const api: HighlightApi = {
		registry,
		createHighlight: (ranges: Range[]) => {
			const copy = [...ranges];
			created.push(copy);
			return { ranges: copy };
		},
	};
	return { api, registry, created };
}

function marksOf(container: Element): HTMLElement[] {
	return [...container.querySelectorAll('mark[' + FIND_MARK_ATTRIBUTE + ']')] as HTMLElement[];
}

// ---------------------------------------------------------------------------
// AC-54-1 — 一致位置の計算(契約③)
// ---------------------------------------------------------------------------

describe('AC-54-1 — 一致位置の計算(契約③)', () => {
	test('大文字小文字を区別しない部分一致(Hello が hello に当たる・双方向)', () => {
		expectMatches('Say Hello world', 'hello', ['Hello']);
		expectMatches('say hello world', 'HELLO', ['hello']);
		expectMatches('miXEd CaSe', 'mixed case', ['miXEd CaSe']);
	});

	test('重なりなく左から(aa を aaaa から探すと2件・オフセットも固定)', () => {
		const ranges = expectMatches('aaaa', 'aa', ['aa', 'aa']);
		expect(ranges).toEqual([
			{ start: 0, end: 2 },
			{ start: 2, end: 4 },
		]);
	});

	test('複数一致は文書順(左から)で返る', () => {
		const ranges = expectMatches('one two one three ONE', 'one', ['one', 'one', 'ONE']);
		expect(ranges.map((r) => r.start)).toEqual([0, 8, 18]);
	});

	test('境界: 語が本文の末尾で終わる一致を落とさない', () => {
		expect(findMatches('say abc', 'abc')).toEqual([{ start: 4, end: 7 }]);
	});

	test('境界: 本文全体と一致する', () => {
		expect(findMatches('abc', 'abc')).toEqual([{ start: 0, end: 3 }]);
	});

	test('境界: 語が本文より長ければ0件', () => {
		expect(findMatches('ab', 'abc')).toEqual([]);
	});

	test('境界: 改行は正規化しない(空白の語は改行に当たらず、改行を含む語は当たる)', () => {
		expect(findMatches('foo\nbar', 'foo bar')).toEqual([]);
		expect(findMatches('foo\nbar', 'o\nb')).toEqual([{ start: 2, end: 5 }]);
	});

	test('境界: 連続空白は正規化しない', () => {
		expect(findMatches('foo  bar', 'foo bar')).toEqual([]);
		expect(findMatches('foo  bar', 'foo  bar')).toEqual([{ start: 0, end: 8 }]);
	});

	test('境界: Unicode 結合文字は正規化しない(e+結合アクセントは é に当たらない)', () => {
		expect(findMatches('éclair', 'éclair')).toEqual([]);
		expect(findMatches('éclair', 'éclair')).toEqual([{ start: 0, end: 6 }]);
	});
});

// ---------------------------------------------------------------------------
// AC-54-2 — 正規表現を解釈しない(契約③)
// ---------------------------------------------------------------------------

describe('AC-54-2 — 正規表現を解釈しない(契約③)', () => {
	test('a.c は abc に当たらず a.c に当たる', () => {
		expect(findMatches('abc', 'a.c')).toEqual([]);
		expect(findMatches('xa.cy', 'a.c')).toEqual([{ start: 1, end: 4 }]);
	});

	test('* を含む語で例外にならず文字そのものに当たる', () => {
		expect(() => findMatches('price is 3*4 today', '3*4')).not.toThrow();
		expectMatches('price is 3*4 today', '3*4', ['3*4']);
	});

	test('[ ( \\ を含む語で例外にならず文字そのものに当たる', () => {
		const text = 'see [note](a\\b) here';
		expect(() => findMatches(text, '[note](a\\b)')).not.toThrow();
		expectMatches(text, '[note](a\\b)', ['[note](a\\b)']);
		expect(() => findMatches(text, '[')).not.toThrow();
		expect(findMatches(text, '[')).toEqual([{ start: 4, end: 5 }]);
	});

	test('記法どおりの ** は表示テキストに ** があるときだけ当たる', () => {
		expect(findMatches('bold text', '**')).toEqual([]);
		expect(findMatches('a ** b', '**')).toEqual([{ start: 2, end: 4 }]);
	});
});

// ---------------------------------------------------------------------------
// AC-54-3 — 空文字と無一致(契約③④)
// ---------------------------------------------------------------------------

describe('AC-54-3 — 空文字と無一致(契約③④)', () => {
	test('空文字の語は常に0件', () => {
		expect(findMatches('anything', '')).toEqual([]);
		expect(findMatches('', '')).toEqual([]);
	});

	test('空文字の本文は(語があっても)0件', () => {
		expect(findMatches('', 'x')).toEqual([]);
	});

	test('空文字の語の件数表示は「No results」ではなく空文字列', () => {
		expect(formatCount(0, 0, '')).toBe('');
	});

	test('当たらない語は m=0 で表示は No results(空白だけの語も語として扱う)', () => {
		expect(findMatches('abc', 'zzz')).toEqual([]);
		expect(formatCount(0, 0, 'zzz')).toBe('No results');
		expect(formatCount(0, 0, ' ')).toBe('No results');
	});

	test('空文字の語はハイライトも出さない(applyHighlights([]) は DOM 不変)', () => {
		const host = mountFixture('<p>abc</p>');
		const before = host.innerHTML;
		applyHighlights(host, findMatches('abc', ''), 0, null);
		expect(host.innerHTML).toBe(before);
		expect(marksOf(host)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC-54-4 — 件数表示 n of m(契約④)
// ---------------------------------------------------------------------------

describe('AC-54-4 — 件数表示 n of m(契約④)', () => {
	test('5件あって3件目(0始まりの current=2)なら 3 of 5', () => {
		expect(formatCount(2, 5, 'x')).toBe('3 of 5');
	});

	test('1件目は 1 of m(n は1始まりで表示)', () => {
		expect(formatCount(0, 5, 'x')).toBe('1 of 5');
		expect(formatCount(0, 1, 'x')).toBe('1 of 1');
	});

	test('最後の一致は m of m', () => {
		expect(formatCount(4, 5, 'x')).toBe('5 of 5');
	});
});

// ---------------------------------------------------------------------------
// AC-54-5 — Prev/Next の循環(契約④)
// ---------------------------------------------------------------------------

describe('AC-54-5 — Prev/Next の循環(契約④)', () => {
	test('Next: 最後の一致で送ると1件目へ循環する', () => {
		expect(stepIndex(4, 5, 1)).toBe(0);
	});

	test('Prev: 1件目で戻ると最後へ循環する', () => {
		expect(stepIndex(0, 5, -1)).toBe(4);
	});

	test('中間は素直に前後へ', () => {
		expect(stepIndex(1, 5, 1)).toBe(2);
		expect(stepIndex(3, 5, -1)).toBe(2);
	});

	test('1件だけのときはどちらへ送っても同じ一致に留まる', () => {
		expect(stepIndex(0, 1, 1)).toBe(0);
		expect(stepIndex(0, 1, -1)).toBe(0);
	});

	test('0件は 0(送りで壊れない)', () => {
		expect(stepIndex(0, 0, 1)).toBe(0);
		expect(stepIndex(0, 0, -1)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC-54-6 — 語を変えると先頭へ(契約④・純関数側)
// ---------------------------------------------------------------------------

describe('AC-54-6 — 語を変えると先頭へ(契約④・純関数側)', () => {
	test('findMatches は常に左から並んだ配列を返す=再検索後の現在一致 index 0 が先頭の一致', () => {
		const text = 'gamma beta gamma beta beta';
		const first = findMatches(text, 'gamma');
		expect(first.map((r) => r.start)).toEqual([0, 11]);
		// 語を変えた再検索(現在一致は呼び出し側が 0 に戻す=配線側 AC-54-6)。
		const second = findMatches(text, 'beta');
		expect(second.map((r) => r.start)).toEqual([6, 17, 22]);
		expect(formatCount(0, second.length, 'beta')).toBe('1 of 3');
	});
});

// ---------------------------------------------------------------------------
// ハイライト適用の分岐(AC-54-9/13 の純関数側・契約④⑦)
// ---------------------------------------------------------------------------

describe('detectHighlightApi — Highlight API の検出(契約④)', () => {
	test('JSDOM(CSS.highlights なし)では null = <mark> フォールバックの経路', () => {
		expect(detectHighlightApi()).toBeNull();
	});

	test('CSS.highlights と Highlight が両方あれば HighlightApi を返す(registry は CSS.highlights そのもの)', () => {
		const registry = new Map<string, unknown>();
		class FakeHighlight {
			ranges: Range[];
			constructor(...ranges: Range[]) {
				this.ranges = ranges;
			}
		}
		const win = { CSS: { highlights: registry }, Highlight: FakeHighlight };
		const api = detectHighlightApi(win);
		expect(api).not.toBeNull();
		expect((api as HighlightApi).registry).toBe(registry);
		const host = mountFixture('<p>abcdef</p>');
		const doc = host.ownerDocument;
		const r1 = doc.createRange();
		r1.selectNodeContents(host);
		const made = (api as HighlightApi).createHighlight([r1]);
		expect(made).toBeInstanceOf(FakeHighlight);
		expect((made as FakeHighlight).ranges).toEqual([r1]);
	});

	test('Highlight コンストラクタが無ければ null(壊れた中間状態で API 経路に入らない)', () => {
		expect(detectHighlightApi({ CSS: { highlights: new Map() } })).toBeNull();
		expect(detectHighlightApi({ Highlight: class {} })).toBeNull();
		expect(detectHighlightApi({})).toBeNull();
	});
});

describe('applyHighlights — CSS Custom Highlight API 経路(契約④)', () => {
	test('DOM を書き換えず、全一致と現在一致を登録名で CSS.highlights へ登録する', () => {
		const host = mountFixture('<p data-vellis-node-id="7">Hello hello world</p>');
		const before = host.innerHTML;
		const text = host.textContent as string;
		const ranges = findMatches(text, 'hello');
		expect(ranges).toHaveLength(2);
		const { api, registry } = fakeApi();

		applyHighlights(host, ranges, 1, api);

		// DOM は一切変わらない(#49/#53 の索引と衝突しない=採用理由)。
		expect(host.innerHTML).toBe(before);
		expect(marksOf(host)).toHaveLength(0);
		// 全一致の登録: FIND_HIGHLIGHT_NAME に、2つの Range(中身は一致文字列)。
		const all = registry.get(FIND_HIGHLIGHT_NAME) as { ranges: Range[] } | undefined;
		expect(all, 'registry.set(FIND_HIGHLIGHT_NAME, createHighlight(...)) が呼ばれること').toBeTruthy();
		expect((all as { ranges: Range[] }).ranges.map((r) => r.toString())).toEqual([
			'Hello',
			'hello',
		]);
		// 現在一致の登録: FIND_CURRENT_HIGHLIGHT_NAME に、現在(index=1)の Range だけ。
		const current = registry.get(FIND_CURRENT_HIGHLIGHT_NAME) as { ranges: Range[] } | undefined;
		expect(current).toBeTruthy();
		expect((current as { ranges: Range[] }).ranges.map((r) => r.toString())).toEqual(['hello']);
	});

	test('要素境界をまたぐ一致も Range がその文字列を指す', () => {
		const host = mountFixture('<p>He<b>ll</b>o world</p>');
		const ranges = findMatches(host.textContent as string, 'hello');
		expect(ranges).toEqual([{ start: 0, end: 5 }]);
		const { api, registry } = fakeApi();

		applyHighlights(host, ranges, 0, api);

		const all = registry.get(FIND_HIGHLIGHT_NAME) as { ranges: Range[] };
		expect(all.ranges.map((r) => r.toString()).join('')).toBe('Hello');
	});

	test('clearHighlights は両方の登録名を registry から外す(DOM は元から不変)', () => {
		const host = mountFixture('<p>Hello hello</p>');
		const ranges = findMatches(host.textContent as string, 'hello');
		const { api, registry } = fakeApi();
		applyHighlights(host, ranges, 0, api);
		expect(registry.size).toBeGreaterThan(0);

		clearHighlights(host, api);

		expect(registry.has(FIND_HIGHLIGHT_NAME)).toBe(false);
		expect(registry.has(FIND_CURRENT_HIGHLIGHT_NAME)).toBe(false);
	});
});

describe('applyHighlights — <mark> フォールバック経路(契約④・AC-54-13)', () => {
	test('各一致が mark[data-vellis-find] で包まれ、現在一致だけ data-vellis-find-current を持つ', () => {
		const host = mountFixture('<p data-vellis-node-id="7">Hello hello world</p>');
		const text = host.textContent as string;
		const ranges = findMatches(text, 'hello');

		applyHighlights(host, ranges, 1, null);

		const marks = marksOf(host);
		expect(marks).toHaveLength(2);
		expect(marks.map((m) => m.textContent)).toEqual(['Hello', 'hello']);
		const currents = marks.filter((m) => m.hasAttribute(FIND_CURRENT_MARK_ATTRIBUTE));
		expect(currents).toHaveLength(1);
		expect(currents[0]).toBe(marks[1]);
		// 表示テキストは変わらない。
		expect(host.textContent).toBe(text);
	});

	test('索引属性(data-vellis-node-id)の値と数はフォールバックでも変わらない', () => {
		const host = mountFixture(
			'<p data-vellis-node-id="1">alpha beta</p><p data-vellis-node-id="2">beta <em data-vellis-hid="9">alpha</em></p>',
		);
		const idsBefore = [...host.querySelectorAll('[data-vellis-node-id]')].map((el) =>
			el.getAttribute('data-vellis-node-id'),
		);
		const hidsBefore = [...host.querySelectorAll('[data-vellis-hid]')].map((el) =>
			el.getAttribute('data-vellis-hid'),
		);

		applyHighlights(host, findMatches(host.textContent as string, 'alpha'), 0, null);

		expect(
			[...host.querySelectorAll('[data-vellis-node-id]')].map((el) =>
				el.getAttribute('data-vellis-node-id'),
			),
		).toEqual(idsBefore);
		expect(
			[...host.querySelectorAll('[data-vellis-hid]')].map((el) =>
				el.getAttribute('data-vellis-hid'),
			),
		).toEqual(hidsBefore);
		expect(marksOf(host).length).toBeGreaterThan(0);
	});

	test('要素境界をまたぐ一致は複数の mark に分かれてよいが、合計がその文字列で表示テキスト不変', () => {
		const host = mountFixture('<p>He<b>ll</b>o world</p>');
		const text = host.textContent as string;

		applyHighlights(host, findMatches(text, 'hello'), 0, null);

		const marks = marksOf(host);
		expect(marks.length).toBeGreaterThanOrEqual(1);
		expect(marks.map((m) => m.textContent).join('')).toBe('Hello');
		expect(host.textContent).toBe(text);
		expect((host.querySelector('b') as HTMLElement).textContent).toBe('ll');
	});

	test('clearHighlights で mark が全て外れ innerHTML が適用前と同一へ戻る(確定前に必ず外せる=AC-54-13)', () => {
		const host = mountFixture(
			'<p data-vellis-node-id="1">Hello <b>bold</b> hello</p><pre data-vellis-node-id="2">hello()</pre>',
		);
		const before = host.innerHTML;

		applyHighlights(host, findMatches(host.textContent as string, 'hello'), 2, null);
		expect(marksOf(host).length).toBeGreaterThan(0);

		clearHighlights(host, null);

		expect(marksOf(host)).toHaveLength(0);
		expect(host.innerHTML).toBe(before);
	});

	test('適用→適用(語の変更)を経ても clear で元に戻る(残骸の mark が積もらない)', () => {
		const host = mountFixture('<p>alpha beta alpha</p>');
		const before = host.innerHTML;

		applyHighlights(host, findMatches(host.textContent as string, 'alpha'), 0, null);
		clearHighlights(host, null);
		applyHighlights(host, findMatches(host.textContent as string, 'beta'), 0, null);
		expect(marksOf(host)).toHaveLength(1);
		clearHighlights(host, null);

		expect(marksOf(host)).toHaveLength(0);
		expect(host.innerHTML).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// 定数 — メニューイベント名と登録名の値固定(契約①④)
// ---------------------------------------------------------------------------

describe('定数の値固定(契約①④)', () => {
	test("MENU_FIND_EVENT は 'menu_find'(menu.rs の同名定数と両側で固定=要件#34 の家風)", () => {
		expect(MENU_FIND_EVENT).toBe('menu_find');
	});

	test('ハイライトの登録名と mark の目印属性', () => {
		expect(FIND_HIGHLIGHT_NAME).toBe('vellis-find');
		expect(FIND_CURRENT_HIGHLIGHT_NAME).toBe('vellis-find-current');
		expect(FIND_MARK_ATTRIBUTE).toBe('data-vellis-find');
		expect(FIND_CURRENT_MARK_ATTRIBUTE).toBe('data-vellis-find-current');
	});
});

// ---------------------------------------------------------------------------
// AC-54-14 — 不変と依存(契約⑦)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../..');

function readRepoFile(rel: string): string {
	const path = resolve(REPO_ROOT, rel);
	expect(existsSync(path), rel + ' が存在すること').toBe(true);
	return readFileSync(path, 'utf8');
}

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

describe('AC-54-14 — 不変と依存(契約⑦)', () => {
	test('package.json の dependencies に追加が無い(要件#53 時点の 18 件を値固定)', () => {
		const pkg = JSON.parse(readRepoFile('package.json')) as {
			dependencies: Record<string, string>;
		};
		expect(Object.keys(pkg.dependencies).sort()).toEqual([
			'@shikijs/rehype',
			'@tauri-apps/api',
			'@tauri-apps/plugin-dialog',
			'@tauri-apps/plugin-opener',
			'hast-util-to-mdast',
			'mdast-util-to-markdown',
			'mdast-util-to-string',
			'mermaid',
			'rehype-parse',
			'rehype-raw',
			'rehype-sanitize',
			'rehype-stringify',
			'remark-gfm',
			'remark-parse',
			'remark-rehype',
			'three',
			'unified',
			'unist-util-visit',
		]);
	});

	test('tauri.conf.json の CSP は不変(値固定=要件#53 AC-53-11 と同じ値)', () => {
		const conf = JSON.parse(readRepoFile('src-tauri/tauri.conf.json')) as {
			app: { security: { csp: string } };
		};
		expect(conf.app.security.csp).toBe(
			"default-src 'self' tauri: customprotocol: asset:; script-src 'self' 'wasm-unsafe-eval'; " +
				"style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: vellis-asset: asset: " +
				'http://asset.localhost tauri: customprotocol:; font-src \'self\' data:; ' +
				"media-src 'self' vellis-asset: asset: http://asset.localhost; frame-src 'self' vellis-asset:; " +
				"connect-src 'self' ipc: http://ipc.localhost vellis-asset: asset: http://asset.localhost " +
				"tauri: customprotocol:; object-src 'none'; base-uri 'self' vellis-asset:; frame-ancestors 'none'",
		);
	});

	test('capability(src-tauri/capabilities/default.json)は無改変(SHA-256 固定)', () => {
		expect(sha256(readRepoFile('src-tauri/capabilities/default.json'))).toBe(
			'faed09590bb5f8a89b1bf7d4ba6fa96b74767250d794edb4f50cd32dbe45bbff',
		);
	});

	// 契約⑦の不変ファイルを内容の SHA-256 で固定する(要件#49 AC-49-11 / #53
	// AC-53-11 と同じ型)。値は要件#54 着手時点(loop/req-54 4a25d01)の内容。
	// 後続要件が正当に変える場合は要件側で決めてから固定値を更新する。
	test('src/lib/html-viewer.ts は無改変(SHA-256 固定)', () => {
		expect(sha256(readRepoFile('src/lib/html-viewer.ts'))).toBe(
			'087755abba702a70ec8d78b7182b3661aa6071c71945fa347fc4a813c792809e',
		);
	});

	test('src/components/HtmlViewer.svelte は無改変(SHA-256 固定)', () => {
		expect(sha256(readRepoFile('src/components/HtmlViewer.svelte'))).toBe(
			'7e33f1e2c5430e87f19ed91a12797d0756136f76f1249405312d2216577483d1',
		);
	});

	test('src/html/edit.ts は無改変(SHA-256 固定=契約⑦「buildEditSurface を読み取り専用で流用」)', () => {
		expect(sha256(readRepoFile('src/html/edit.ts'))).toBe(
			'05f8eef1b9b59f87b5990010fd88ab298662f0df4816d7f88b64b2fc9a3d84ba',
		);
	});

	test('src/markdown/edit.ts は無改変(SHA-256 固定)', () => {
		expect(sha256(readRepoFile('src/markdown/edit.ts'))).toBe(
			'c778520df7a00e1fa0b070a9e13f32ba8188fc0df55c8230a95af2f4b523473b',
		);
	});
});
