/**
 * 要件#55 の受け入れテスト(docs/requirements/req-55.md)— フロントの純関数と不変
 * (unit プロジェクト)
 *
 * 「開いている root フォルダの配下を串刺しで検索する」。走査は Rust(src-tauri/tests/
 * acceptance_req55.rs)。ここは `src/lib/find-in-folder.ts` の**画面を持たない部分**=
 * 結果のグループ化(契約⑥)・世代番号によるキャンセル(契約⑧)・状態表示の文言・
 * root 未選択のガード(契約①)と、依存・不変(契約⑧)を判定する。
 *
 * 判定範囲(AC 番号は req-55.md の受け入れ基準):
 * - AC-55-12 結果のグループ化(`groupHits`)
 * - AC-55-13 世代番号でのキャンセル(`SearchSession`)
 * - AC-55-14 の一部: 文言の値固定(英語)・root 未選択のガード(`shouldShowFindInFolder`)
 * - AC-55-18 フロント側: package.json の依存キー・CSP・capability・要件#54 の export の不変
 * - AC-55-28(追補a・2026-09-25)段階渡しの純関数部分: `SearchResponse` は
 *   `{ generation, total, files, hits }`・`SearchHit.ordinal?: number`・
 *   `SEARCH_IN_FOLDER_PAGE_COMMAND` / `FIND_IN_FOLDER_PAGE_SIZE` / `FIND_IN_FOLDER_SHOW_MORE`
 *   の値固定・`matchIndex`(`ordinal` があれば `ordinal - 1`、無ければ `occurrenceIndex`)
 * 配線(パネル・入力・結果クリック)は src/components/FindInFolder.wiring.test.ts。
 * 人間ゲート 1〜5(応答・ssh・見た目・跳び・起案時判断)はここでは判定しない。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * ```ts
 * // --- 新規 src/lib/find-in-folder.ts(純関数。Tauri を import しない)---
 *
 * /** Edit メニュー「Find in Folder…」(⌘⇧F)のイベント名。menu.rs の MENU_FIND_IN_FOLDER_EVENT と同綴り。 *\/
 * export const MENU_FIND_IN_FOLDER_EVENT = 'menu_find_in_folder';
 * /** Tauri command 名(契約⑤)。invoke の第 1 引数。 *\/
 * export const SEARCH_IN_FOLDER_COMMAND = 'search_in_folder';
 * /** 0 件の文言(英語=要件#51)。 *\/
 * export const FIND_IN_FOLDER_NO_RESULTS = 'No results';
 * /** 検索中の文言。 *\/
 * export const FIND_IN_FOLDER_SEARCHING = 'Searching…';
 *
 * /** Rust の SearchHit と同形。path は root からの相対・line は 1 始まり。 *\/
 * export type SearchHit = { path: string; line: number; text: string };
 * /** command の戻り。generation は投げた世代がそのまま返る。 *\/
 * export type SearchResponse = { generation: number; hits: SearchHit[] };
 * export type FileGroup = { path: string; count: number; hits: { line: number; text: string }[] };
 *
 * /** 平坦な一致一覧をファイルごとにまとめる(契約⑥)。グループの順=path の初出順・
 *  *  グループ内の順=入力順。同じ path が離れて現れても 1 グループに合流する。入力は変更しない。 *\/
 * export function groupHits(hits: SearchHit[]): FileGroup[];
 *
 * /** 世代番号(契約⑧)。next() で 1 つ進めた番号を invoke に渡し、戻ってきた世代が
 *  *  current と違えば捨てる。最初の next() は 1 を返す(0 = まだ何も投げていない)。 *\/
 * export class SearchSession {
 *   get current(): number;
 *   next(): number;
 *   isCurrent(generation: number): boolean;
 *   /** 現在世代の結果だけを返し、古い世代は null。 *\/
 *   accept<T>(generation: number, result: T): T | null;
 * }
 *
 * /** 状態表示(契約⑥)。query が空なら ''、検索中は FIND_IN_FOLDER_SEARCHING、
 *  *  0 件は FIND_IN_FOLDER_NO_RESULTS、それ以外は `${total} result(s) in ${files} file(s)`。 *\/
 * export function formatFolderStatus(s: {
 *   query: string; searching: boolean; total: number; files: number;
 * }): string;
 *
 * /** 契約①: root が開かれていて、履歴選択画面でないときだけパネルを出す。 *\/
 * export function shouldShowFindInFolder(rootUri: string | null | undefined, rootPickerOpen: boolean): boolean;
 * ```
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
	FIND_IN_FOLDER_NO_RESULTS,
	FIND_IN_FOLDER_SEARCHING,
	MENU_FIND_IN_FOLDER_EVENT,
	SEARCH_IN_FOLDER_COMMAND,
	SearchSession,
	formatFolderStatus,
	groupHits,
	shouldShowFindInFolder,
	type FileGroup,
	type SearchHit,
} from './find-in-folder';
import * as findInDocument from './find-in-document';
// 要件#55 追補b(2026-09-25)。追補a 未確定のため `ordinal` ではなく手元の行テキストから数える純関数。
import { occurrenceIndex } from './find-in-folder';
// 要件#55 追補a(2026-09-25・案 1)。段階渡しの定数・文言と、`ordinal` を優先する番目の選択。
import {
	FIND_IN_FOLDER_PAGE_SIZE,
	FIND_IN_FOLDER_SHOW_MORE,
	SEARCH_IN_FOLDER_PAGE_COMMAND,
	matchIndex,
	type SearchResponse,
} from './find-in-folder';
// 要件#55 追補d(2026-09-25)。段階的な表示のイベント名・payload の型・走査中の状態表示。
import {
	SEARCH_DONE_EVENT,
	SEARCH_PROGRESS_EVENT,
	type SearchDonePayload,
	type SearchProgressPayload,
} from './find-in-folder';

const REPO_ROOT = resolve(__dirname, '../..');

/** CJK を含まない=英語の判定(要件#51 の走査と同じ考え方)。 */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

// ---------------------------------------------------------------------------
// AC-55-12 — 結果のグループ化(契約⑥)
// ---------------------------------------------------------------------------

describe('AC-55-12: groupHits — ファイルごとのグループ(相対パス・件数・行の一覧)・順序保持(契約⑥)', () => {
	const hits: SearchHit[] = [
		{ path: 'docs/a.md', line: 3, text: 'alpha one' },
		{ path: 'docs/a.md', line: 7, text: 'ALPHA two' },
		{ path: 'b.txt', line: 1, text: 'alpha' },
		{ path: 'z/c.html', line: 12, text: '<p>alpha</p>' },
	];

	test('空の一覧は空のグループ', () => {
		expect(groupHits([])).toEqual([]);
	});

	test('path ごとに 1 グループ・count は行数・hits は {line, text} だけ', () => {
		const groups = groupHits(hits);
		expect(groups).toEqual([
			{
				path: 'docs/a.md',
				count: 2,
				hits: [
					{ line: 3, text: 'alpha one' },
					{ line: 7, text: 'ALPHA two' },
				],
			},
			{ path: 'b.txt', count: 1, hits: [{ line: 1, text: 'alpha' }] },
			{ path: 'z/c.html', count: 1, hits: [{ line: 12, text: '<p>alpha</p>' }] },
		] satisfies FileGroup[]);
	});

	test('グループの順は path の初出順(並べ替えない=Rust 側の順序をそのまま見せる)', () => {
		const groups = groupHits(hits);
		expect(groups.map((g) => g.path)).toEqual(['docs/a.md', 'b.txt', 'z/c.html']);
	});

	test('グループ内の順は入力順(行番号で並べ替えない)', () => {
		const groups = groupHits([
			{ path: 'x.md', line: 9, text: 'nine' },
			{ path: 'x.md', line: 2, text: 'two' },
		]);
		expect(groups[0].hits.map((h) => h.line)).toEqual([9, 2]);
	});

	test('同じ path が離れて現れても 1 グループに合流し、初出の位置に残る', () => {
		const groups = groupHits([
			{ path: 'a.md', line: 1, text: 'a1' },
			{ path: 'b.md', line: 1, text: 'b1' },
			{ path: 'a.md', line: 5, text: 'a5' },
		]);
		expect(groups.map((g) => [g.path, g.count])).toEqual([
			['a.md', 2],
			['b.md', 1],
		]);
		expect(groups[0].hits).toEqual([
			{ line: 1, text: 'a1' },
			{ line: 5, text: 'a5' },
		]);
	});

	test('count の合計は入力の件数(打ち切りなし=全件が見える)', () => {
		const many: SearchHit[] = [];
		for (let i = 1; i <= 5_500; i++) many.push({ path: `f${i % 7}.md`, line: i, text: `l${i}` });
		const groups = groupHits(many);
		expect(groups.reduce((n, g) => n + g.count, 0)).toBe(5_500);
		expect(groups).toHaveLength(7);
	});

	test('入力の配列と要素を変更しない', () => {
		const input: SearchHit[] = [
			{ path: 'a.md', line: 1, text: 'a1' },
			{ path: 'a.md', line: 2, text: 'a2' },
		];
		const snapshot = JSON.stringify(input);
		groupHits(input);
		expect(JSON.stringify(input)).toBe(snapshot);
	});
});

// ---------------------------------------------------------------------------
// AC-55-13 — 世代番号でのキャンセル(契約⑧)
// ---------------------------------------------------------------------------

describe('AC-55-13: SearchSession — 現在の世代と違う結果は破棄・新しい世代だけ採用(契約⑧)', () => {
	test('next() は 1 から単調増加し、current がそれに追随する', () => {
		const s = new SearchSession();
		expect(s.current).toBe(0);
		expect(s.next()).toBe(1);
		expect(s.next()).toBe(2);
		expect(s.next()).toBe(3);
		expect(s.current).toBe(3);
	});

	test('isCurrent は現在の世代だけ真(古い世代・未来の世代・0 は偽)', () => {
		const s = new SearchSession();
		const g1 = s.next();
		expect(s.isCurrent(g1)).toBe(true);
		const g2 = s.next();
		expect(s.isCurrent(g1)).toBe(false);
		expect(s.isCurrent(g2)).toBe(true);
		expect(s.isCurrent(0)).toBe(false);
		expect(s.isCurrent(g2 + 1)).toBe(false);
	});

	test('accept は現在世代の結果をそのまま返し、古い世代は null', () => {
		const s = new SearchSession();
		const g1 = s.next();
		const g2 = s.next();
		const stale = ['stale'];
		const fresh = ['fresh'];
		expect(s.accept(g1, stale)).toBeNull();
		expect(s.accept(g2, fresh)).toBe(fresh);
	});

	test('順序が入れ替わって届いても(新→旧)旧は捨てられ、新は残る', () => {
		const s = new SearchSession();
		const g1 = s.next();
		const g2 = s.next();
		// g2(新)が先に届く
		expect(s.accept(g2, 'B')).toBe('B');
		// g1(旧)が後から届く= 表示に反映してはいけない
		expect(s.accept(g1, 'A')).toBeNull();
		// 新しい世代を投げた後は g2 も古い
		const g3 = s.next();
		expect(s.accept(g2, 'B')).toBeNull();
		expect(s.accept(g3, 'C')).toBe('C');
	});

	test('accept は結果を変換しない(空配列・0 件でも null と区別できる)', () => {
		const s = new SearchSession();
		const g = s.next();
		const empty: SearchHit[] = [];
		expect(s.accept(g, empty)).toBe(empty);
		expect(s.accept(g, 0)).toBe(0);
	});

	test('セッションは互いに独立(ウインドウ単位=揮発)', () => {
		const a = new SearchSession();
		const b = new SearchSession();
		a.next();
		a.next();
		expect(b.current).toBe(0);
		expect(b.next()).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC-55-14(一部)— 文言の値固定・root 未選択のガード(契約①⑥)
// ---------------------------------------------------------------------------

describe('AC-55-14/⑥: 文言は英語で値固定・root 未選択では出さない(契約①⑥)', () => {
	test('イベント名・command 名は menu.rs / lib.rs と同綴り(値固定)', () => {
		expect(MENU_FIND_IN_FOLDER_EVENT).toBe('menu_find_in_folder');
		expect(SEARCH_IN_FOLDER_COMMAND).toBe('search_in_folder');
	});

	test('文言の値固定(英語=要件#51)', () => {
		expect(FIND_IN_FOLDER_NO_RESULTS).toBe('No results');
		expect(FIND_IN_FOLDER_SEARCHING).toBe('Searching…');
		expect(FIND_IN_FOLDER_NO_RESULTS).not.toMatch(CJK);
		expect(FIND_IN_FOLDER_SEARCHING).not.toMatch(CJK);
	});

	test('formatFolderStatus — 語が空なら空文字(まだ何も探していない)', () => {
		expect(formatFolderStatus({ query: '', searching: false, total: 0, files: 0 })).toBe('');
		expect(formatFolderStatus({ query: '', searching: true, total: 0, files: 0 })).toBe('');
	});

	test('formatFolderStatus — 検索中は Searching…', () => {
		expect(formatFolderStatus({ query: 'a', searching: true, total: 0, files: 0 })).toBe(
			FIND_IN_FOLDER_SEARCHING
		);
	});

	test('formatFolderStatus — 0 件は No results', () => {
		expect(formatFolderStatus({ query: 'a', searching: false, total: 0, files: 0 })).toBe(
			'No results'
		);
	});

	test('formatFolderStatus — 件数とファイル数(単数/複数)', () => {
		expect(formatFolderStatus({ query: 'a', searching: false, total: 1, files: 1 })).toBe(
			'1 result in 1 file'
		);
		expect(formatFolderStatus({ query: 'a', searching: false, total: 3, files: 2 })).toBe(
			'3 results in 2 files'
		);
		expect(formatFolderStatus({ query: 'a', searching: false, total: 5_001, files: 1 })).toBe(
			'5001 results in 1 file'
		);
	});

	test('shouldShowFindInFolder — root があり履歴選択画面でないときだけ真', () => {
		expect(shouldShowFindInFolder('file:///Users/x/notes', false)).toBe(true);
		expect(shouldShowFindInFolder('ssh://alice@host/data', false)).toBe(true);
		expect(shouldShowFindInFolder('', false)).toBe(false);
		expect(shouldShowFindInFolder(null, false)).toBe(false);
		expect(shouldShowFindInFolder(undefined, false)).toBe(false);
		expect(shouldShowFindInFolder('file:///Users/x/notes', true)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-55-18 — 不変と依存(契約⑧)。open-in-new-window / go-to-path の acceptance と同じ固定方式
// ---------------------------------------------------------------------------

describe('AC-55-18: 依存追加ゼロ・不変(契約⑧)', () => {
	test('package.json の依存キーが周回開始時点(2026-09-24)と同一(runtime / dev とも)', () => {
		const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		expect(Object.keys(pkg.dependencies).sort()).toEqual(
			[
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
			].sort()
		);
		expect(Object.keys(pkg.devDependencies).sort()).toEqual(
			[
				'@sveltejs/adapter-static',
				'@sveltejs/kit',
				'@sveltejs/vite-plugin-svelte',
				'@tauri-apps/cli',
				'@testing-library/svelte',
				'@testing-library/user-event',
				'@types/hast',
				'@types/mdast',
				'@types/node',
				'@types/three',
				'@wdio/cli',
				'@wdio/globals',
				'@wdio/local-runner',
				'@wdio/mocha-framework',
				'@wdio/spec-reporter',
				'expect-webdriverio',
				'happy-dom',
				'jsdom',
				'shiki',
				'svelte',
				'svelte-check',
				'tsx',
				'typescript',
				'vite',
				'vitest',
				'webdriverio',
			].sort()
		);
	});

	test('tauri.conf.json の CSP を値固定(検索は CSP に触れない)', () => {
		const conf = JSON.parse(
			readFileSync(resolve(REPO_ROOT, 'src-tauri/tauri.conf.json'), 'utf-8')
		) as { app: { security: { csp: string } } };
		expect(conf.app.security).toEqual({
			csp: "default-src 'self' tauri: customprotocol: asset:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: vellis-asset: asset: http://asset.localhost tauri: customprotocol:; font-src 'self' data:; media-src 'self' vellis-asset: asset: http://asset.localhost; frame-src 'self' vellis-asset:; connect-src 'self' ipc: http://ipc.localhost vellis-asset: asset: http://asset.localhost tauri: customprotocol:; object-src 'none'; base-uri 'self' vellis-asset:; frame-ancestors 'none'",
		});
	});

	test('capabilities/default.json の permission 一覧を値固定(追加・削除・並べ替え無し)', () => {
		const capability = JSON.parse(
			readFileSync(resolve(REPO_ROOT, 'src-tauri/capabilities/default.json'), 'utf-8')
		) as { permissions: Array<string | { identifier: string }> };
		const identifiers = capability.permissions.map((p) =>
			typeof p === 'string' ? p : p.identifier
		);
		expect(identifiers).toEqual([
			'core:default',
			'opener:allow-open-url',
			'opener:allow-reveal-item-in-dir',
			'opener:allow-open-path',
			'dialog:default',
			'window-state:default',
			'core:window:allow-destroy',
		]);
	});

	test('要件#54 の find-in-document.ts の export(名前と定数の値)が不変', () => {
		expect(Object.keys(findInDocument).sort()).toEqual(
			[
				'MENU_FIND_EVENT',
				'FIND_HIGHLIGHT_NAME',
				'FIND_CURRENT_HIGHLIGHT_NAME',
				'FIND_MARK_ATTRIBUTE',
				'FIND_CURRENT_MARK_ATTRIBUTE',
				'findMatches',
				'formatCount',
				'stepIndex',
				'detectHighlightApi',
				'applyHighlights',
				'rangeAtMatch',
				'scrollRangeIntoContainer',
				'clearHighlights',
			].sort()
		);
		expect(findInDocument.MENU_FIND_EVENT).toBe('menu_find');
		expect(findInDocument.FIND_HIGHLIGHT_NAME).toBe('vellis-find');
		expect(findInDocument.FIND_CURRENT_HIGHLIGHT_NAME).toBe('vellis-find-current');
		expect(findInDocument.FIND_MARK_ATTRIBUTE).toBe('data-vellis-find');
		expect(findInDocument.FIND_CURRENT_MARK_ATTRIBUTE).toBe('data-vellis-find-current');
	});

	test('find-in-folder.ts は Tauri を import しない(純関数=配線から独立)', () => {
		const src = readFileSync(resolve(__dirname, 'find-in-folder.ts'), 'utf-8');
		expect(src).not.toMatch(/@tauri-apps\//);
		expect(src).not.toMatch(/\$lib\/ipc/);
		expect(src).not.toMatch(/\$lib\/events/);
		expect(src).not.toMatch(/localStorage/);
	});
});

// ---------------------------------------------------------------------------
// 要件#55 追補b(2026-09-25)— クリックした一致へ跳ぶ
//
// 契約(req-55.md「追補b」。追補a 未確定のため `SearchHit.ordinal` ではなくフロントの
// 純関数で数える。追補a が案 1 で確定したら `ordinal` を使う形へ別途足す):
//
// ```ts
// /** 結果の行 `clicked` が、そのファイルの中で何番目の一致か(0 始まり)。
//  *  同じ `path` の一致行のうち `clicked.line` より前の行の `text` に含まれる `query` の
//  *  重ならない出現回数(大小無視)の合計。クリック行自身は数えない(その行の最初の
//  *  出現=その番目)。他の path の行・後ろの行は数えない。`query` が空なら 0。
//  *  入力(配列・要素)は変更しない。 *\/
// export function occurrenceIndex(hits: SearchHit[], clicked: SearchHit, query: string): number;
// ```
// ---------------------------------------------------------------------------

describe('要件#55 追補b・AC-55-19: occurrenceIndex — クリック行より前の行の出現回数の合計(0 始まり)', () => {
	const A = 'docs/a.md';
	const B = 'b.txt';
	const hits: SearchHit[] = [
		{ path: A, line: 3, text: 'alpha one' },
		{ path: A, line: 5, text: 'Alpha and ALPHA again' },
		{ path: A, line: 9, text: 'alpha alpha alpha' },
		{ path: B, line: 1, text: 'alpha' },
		{ path: B, line: 2, text: 'alpha alpha' },
		{ path: A, line: 12, text: 'last alpha' },
	];

	test('先頭の一致行をクリックすると 0(前の行が無い)', () => {
		expect(occurrenceIndex(hits, hits[0], 'alpha')).toBe(0);
		expect(occurrenceIndex(hits, hits[3], 'alpha')).toBe(0);
	});

	test('前の行に 1 回あれば 1(クリック行自身の出現は数えない)', () => {
		// A: line 3 -> 1 occurrence before line 5. line 5 itself has 2 but is not counted.
		expect(occurrenceIndex(hits, hits[1], 'alpha')).toBe(1);
	});

	test('1 行に 2 回ある行が前に 1 つあれば 2(大小無視で数える)', () => {
		const two: SearchHit[] = [
			{ path: A, line: 1, text: 'Alpha ALPHA' },
			{ path: A, line: 2, text: 'alpha' },
		];
		expect(occurrenceIndex(two, two[1], 'alpha')).toBe(2);
		// A: lines 3 (1) + 5 (2) = 3 before line 9.
		expect(occurrenceIndex(hits, hits[2], 'alpha')).toBe(3);
	});

	test('他の path の行は数えない・後ろの行も数えない(配列順ではなく行番号で見る)', () => {
		// A line 12 is listed after B rows: B must not be counted, A lines 3/5/9 must (1+2+3=6).
		expect(occurrenceIndex(hits, hits[5], 'alpha')).toBe(6);
		// B line 2: only B line 1 counts (1), not the A rows listed earlier in the array.
		expect(occurrenceIndex(hits, hits[4], 'alpha')).toBe(1);
		// Order of the array does not matter: reversed input gives the same answer.
		const reversed = [...hits].reverse();
		expect(occurrenceIndex(reversed, hits[5], 'alpha')).toBe(6);
		expect(occurrenceIndex(reversed, hits[2], 'alpha')).toBe(3);
	});

	test('重ならない出現で数える(`aaaa` から `aa` は 2・`aaa` からは 1)', () => {
		const rows: SearchHit[] = [
			{ path: A, line: 1, text: 'aaaa' },
			{ path: A, line: 2, text: 'aaa' },
			{ path: A, line: 3, text: 'aa' },
		];
		expect(occurrenceIndex(rows, rows[1], 'aa')).toBe(2);
		expect(occurrenceIndex(rows, rows[2], 'aa')).toBe(3);
	});

	test('大小無視: 語が大文字でも行が大文字でも同じ数', () => {
		expect(occurrenceIndex(hits, hits[2], 'ALPHA')).toBe(3);
		expect(occurrenceIndex(hits, hits[2], 'AlPhA')).toBe(3);
	});

	test('query が空なら 0(前に何行あっても)', () => {
		expect(occurrenceIndex(hits, hits[2], '')).toBe(0);
		expect(occurrenceIndex(hits, hits[5], '')).toBe(0);
	});

	test('clicked と同じ path・line の行が hits に無くても、前の行だけで数える(hits は破壊しない)', () => {
		const snapshot = JSON.stringify(hits);
		const clicked: SearchHit = { path: A, line: 7, text: 'alpha (not in hits)' };
		// Before line 7 in A: lines 3 (1) + 5 (2) = 3.
		expect(occurrenceIndex(hits, clicked, 'alpha')).toBe(3);
		expect(JSON.stringify(hits)).toBe(snapshot);
		expect(hits.map((h) => h.line)).toEqual([3, 5, 9, 1, 2, 12]);
	});
});

// ---------------------------------------------------------------------------
// 要件#55 追補b(ソース走査)— +page.svelte が番目を Viewer まで運ぶ
// ---------------------------------------------------------------------------

describe('要件#55 追補b・AC-55-22(ソース走査): +page.svelte が onOpen の第 3 引数を pendingFolderFind に持ち findInitialIndex を Viewer へ渡す', () => {
	const page = () => readFileSync(resolve(REPO_ROOT, 'src/routes/+page.svelte'), 'utf-8');

	/** `function <name>(` から、その関数を閉じる `\n\t}` までの本文。 */
	function functionBody(src: string, name: string): string {
		const start = src.indexOf(`function ${name}(`);
		expect(start, `function ${name}( in +page.svelte`).toBeGreaterThanOrEqual(0);
		const end = src.indexOf('\n\t}', start);
		expect(end).toBeGreaterThan(start);
		return src.slice(start, end);
	}

	test('onOpen の受け口は第 3 引数(番目)を受け、pendingFolderFind にそれを持つ', () => {
		const src = page();
		// <FindInFolder ... onOpen={<handler>}
		const bound = /<FindInFolder[\s\S]*?onOpen=\{(\w+)\}/.exec(src);
		expect(bound, 'FindInFolder の onOpen に関数名が束縛されていること').toBeTruthy();
		const handler = (bound as RegExpExecArray)[1];
		const sig = new RegExp(`function ${handler}\\(\\s*\\w+\\s*:\\s*string\\s*,\\s*\\w+\\s*:\\s*string\\s*,\\s*(\\w+)\\s*:\\s*number`);
		const m = sig.exec(src);
		expect(m, `${handler}(uri: string, query: string, <index>: number) の形であること`).toBeTruthy();
		const indexParam = (m as RegExpExecArray)[1];
		const body = functionBody(src, handler);
		expect(body).toMatch(/pendingFolderFind\s*=\s*\{/);
		expect(body).toMatch(new RegExp(`pendingFolderFind\\s*=\\s*\\{[^}]*\\b${indexParam}\\b`));
	});

	test('findInitialIndex を状態に持ち、pendingFolderFind から入れて <Viewer> へ渡す', () => {
		const src = page();
		expect(src).toMatch(/let findInitialIndex = \$state/);
		expect(src).toMatch(/findInitialIndex = pending\.\w+/);
		expect(src).toMatch(/<Viewer[\s\S]*?findInitialIndex/);
	});

	test('handleMenuFind と文書切替の経路では findInitialIndex = 0 に戻す(Command + F の意味論は不変)', () => {
		const src = page();
		expect(functionBody(src, 'handleMenuFind')).toMatch(/findInitialIndex = 0/);
		// Every place that clears the query for a plain advance also clears the index.
		const clears = [...src.matchAll(/findInitialQuery = '';/g)];
		expect(clears.length).toBeGreaterThanOrEqual(2);
		for (const hit of clears) {
			const at = hit.index ?? 0;
			const window = src.slice(Math.max(0, at - 200), at + 200);
			expect(window, `findInitialIndex = 0 near offset ${at}`).toMatch(/findInitialIndex = 0/);
		}
	});
});

// ---------------------------------------------------------------------------
// 要件#55 追補a(2026-09-25・案 1)— 段階渡しの純関数部分
//
// 確定契約(`src/lib/find-in-folder.ts` に追加。Tauri を import しない):
//
// ```ts
// /** 続きを取りに行く Tauri command 名。invoke の第 1 引数。 *\/
// export const SEARCH_IN_FOLDER_PAGE_COMMAND = 'search_in_folder_page';
// /** 1 ページの件数(Rust の `search::PAGE_SIZE` と同値)。 *\/
// export const FIND_IN_FOLDER_PAGE_SIZE = 200;
// /** 「Show more」ボタンの文言(英語=要件#51)。残り件数を添える。 *\/
// export function FIND_IN_FOLDER_SHOW_MORE(remaining: number): string; // `Show more (${remaining} remaining)`
//
// /** Rust の SearchHit と同形。ordinal = そのファイルの先頭からの出現の通し番号(1 始まり)。
//  *  古い応答(追補a 前)には無いので省略可。 *\/
// export type SearchHit = { path: string; line: number; text: string; ordinal?: number };
// /** search_in_folder の戻り。total / files は全件の値・hits は先頭 1 ページ。 *\/
// export type SearchResponse = { generation: number; total: number; files: number; hits: SearchHit[] };
// /** search_in_folder_page の戻り。 *\/
// export type SearchPageResponse = { generation: number; hits: SearchHit[] };
//
// /** クリックした行の番目(0 始まり)。`clicked.ordinal` があれば `ordinal - 1`(ページ分けで
//  *  手元に無い行があっても正確)。無ければ `occurrenceIndex(hits, clicked, query)` に落ちる。 *\/
// export function matchIndex(hits: SearchHit[], clicked: SearchHit, query: string): number;
// ```
// ---------------------------------------------------------------------------

describe('要件#55 追補a・AC-55-28: 段階渡しの定数・型・文言・matchIndex', () => {
	test('command 名とページ件数は値固定(Rust の search_in_folder_page / PAGE_SIZE と同値)', () => {
		expect(SEARCH_IN_FOLDER_PAGE_COMMAND).toBe('search_in_folder_page');
		expect(FIND_IN_FOLDER_PAGE_SIZE).toBe(200);
	});

	test('「Show more」の文言は残り件数つきで値固定(英語=要件#51)', () => {
		expect(FIND_IN_FOLDER_SHOW_MORE(800)).toBe('Show more (800 remaining)');
		expect(FIND_IN_FOLDER_SHOW_MORE(1)).toBe('Show more (1 remaining)');
		expect(FIND_IN_FOLDER_SHOW_MORE(4801)).toBe('Show more (4801 remaining)');
		expect(FIND_IN_FOLDER_SHOW_MORE(800)).not.toMatch(CJK);
	});

	test('SearchResponse は { generation, total, files, hits }・SearchHit.ordinal は省略可(型の固定)', () => {
		const withOrdinal: SearchHit = { path: 'a.md', line: 3, text: 'alpha', ordinal: 1 };
		const withoutOrdinal: SearchHit = { path: 'a.md', line: 3, text: 'alpha' };
		const response: SearchResponse = {
			generation: 1,
			total: 1000,
			files: 10,
			hits: [withOrdinal, withoutOrdinal],
		};
		expect(Object.keys(response).sort()).toEqual(['files', 'generation', 'hits', 'total']);
		expect(response.hits[0].ordinal).toBe(1);
		expect(response.hits[1].ordinal).toBeUndefined();
	});

	test('formatFolderStatus は total / files(全件の値)で件数を出す — 手元の 200 件ではない', () => {
		expect(formatFolderStatus({ query: 'a', searching: false, total: 1000, files: 10 })).toBe(
			'1000 results in 10 files'
		);
		expect(formatFolderStatus({ query: 'a', searching: false, total: 201, files: 1 })).toBe(
			'201 results in 1 file'
		);
	});

	const A = 'docs/a.md';
	const shown: SearchHit[] = [
		{ path: A, line: 3, text: 'alpha one', ordinal: 1 },
		{ path: A, line: 5, text: 'Alpha ALPHA', ordinal: 2 },
		{ path: A, line: 9, text: 'alpha near the end', ordinal: 4 },
		{ path: 'b.txt', line: 1, text: 'alpha', ordinal: 1 },
	];

	test('matchIndex — ordinal があれば ordinal - 1(手元の行とは無関係に決まる)', () => {
		expect(matchIndex(shown, shown[0], 'alpha')).toBe(0);
		expect(matchIndex(shown, shown[1], 'alpha')).toBe(1);
		expect(matchIndex(shown, shown[2], 'alpha')).toBe(3);
		expect(matchIndex(shown, shown[3], 'alpha')).toBe(0);
		// The row is the only one at hand for its file (earlier rows are on a page not fetched):
		// occurrenceIndex would say 0, ordinal says 6.
		const late: SearchHit = { path: A, line: 40, text: 'alpha late', ordinal: 7 };
		expect(occurrenceIndex([late], late, 'alpha')).toBe(0);
		expect(matchIndex([late], late, 'alpha')).toBe(6);
		expect(matchIndex([], late, 'alpha')).toBe(6);
	});

	test('matchIndex — ordinal が無ければ occurrenceIndex に落ちる(追補a 前の応答・手元の行で数える)', () => {
		const legacy: SearchHit[] = [
			{ path: A, line: 3, text: 'alpha one' },
			{ path: A, line: 5, text: 'Alpha ALPHA' },
			{ path: A, line: 9, text: 'alpha near the end' },
		];
		expect(matchIndex(legacy, legacy[0], 'alpha')).toBe(0);
		expect(matchIndex(legacy, legacy[2], 'alpha')).toBe(3);
		expect(matchIndex(legacy, legacy[2], 'alpha')).toBe(occurrenceIndex(legacy, legacy[2], 'alpha'));
		expect(matchIndex(legacy, legacy[2], '')).toBe(0);
	});

	test('matchIndex は入力を変更しない', () => {
		const snapshot = JSON.stringify(shown);
		matchIndex(shown, shown[2], 'alpha');
		expect(JSON.stringify(shown)).toBe(snapshot);
	});
});

// ---------------------------------------------------------------------------
// 要件#55 追補d(2026-09-25)— 段階的な表示の定数・型・走査中の状態表示(純関数)
//
// 確定契約(implementer はこれに従う):
//   export const SEARCH_PROGRESS_EVENT = 'search_progress';   // Rust search/mod.rs と同綴り
//   export const SEARCH_DONE_EVENT = 'search_done';
//   /** search_progress の payload(Rust の SearchProgressEvent・camelCase)。 */
//   export type SearchProgressPayload = { generation: number; hits: SearchHit[]; filesScanned: number };
//   /** search_done の payload(Rust の SearchDoneEvent)。 */
//   export type SearchDonePayload = { generation: number; total: number; files: number };
//   formatFolderStatus: searching かつ total > 0 なら
//     `Searching… ${total} result(s) in ${files} file(s) so far`(searching かつ 0 件は従来の `Searching…`)
// ---------------------------------------------------------------------------

describe('要件#55 追補d・AC-55-39: 段階的な表示のイベント名・payload の型・走査中の状態表示', () => {
	test('イベント名は値固定で、Rust の search/mod.rs の定数と同綴り', () => {
		expect(SEARCH_PROGRESS_EVENT).toBe('search_progress');
		expect(SEARCH_DONE_EVENT).toBe('search_done');

		const rust = readFileSync(resolve(REPO_ROOT, 'src-tauri/src/search/mod.rs'), 'utf8');
		const progress = rust.match(/pub const SEARCH_PROGRESS_EVENT: &str = "([^"]+)";/);
		const done = rust.match(/pub const SEARCH_DONE_EVENT: &str = "([^"]+)";/);
		expect(progress?.[1]).toBe(SEARCH_PROGRESS_EVENT);
		expect(done?.[1]).toBe(SEARCH_DONE_EVENT);
	});

	test('payload の型は { generation, hits, filesScanned } / { generation, total, files }(camelCase)', () => {
		const hit: SearchHit = { path: 'docs/a.md', line: 3, text: 'alpha one', ordinal: 1 };
		const progress: SearchProgressPayload = { generation: 7, hits: [hit], filesScanned: 12 };
		const done: SearchDonePayload = { generation: 7, total: 250, files: 3 };
		// Type-level: an extra or misspelled key does not fit the type.
		const progressKeys = Object.keys(progress).sort();
		expect(progressKeys).toEqual(['filesScanned', 'generation', 'hits']);
		expect(Object.keys(done).sort()).toEqual(['files', 'generation', 'total']);
		const check: Record<keyof SearchProgressPayload, true> = {
			generation: true,
			hits: true,
			filesScanned: true,
		};
		expect(Object.keys(check).sort()).toEqual(progressKeys);
		const checkDone: Record<keyof SearchDonePayload, true> = { generation: true, total: true, files: true };
		expect(Object.keys(checkDone).sort()).toEqual(['files', 'generation', 'total']);
	});

	test('formatFolderStatus — 走査中に件数があれば `Searching… N results in M files so far`', () => {
		expect(formatFolderStatus({ query: 'a', searching: true, total: 12, files: 3 })).toBe(
			'Searching… 12 results in 3 files so far'
		);
		expect(formatFolderStatus({ query: 'a', searching: true, total: 1, files: 1 })).toBe(
			'Searching… 1 result in 1 file so far'
		);
		expect(formatFolderStatus({ query: 'a', searching: true, total: 250, files: 1 })).toBe(
			'Searching… 250 results in 1 file so far'
		);
	});

	test('formatFolderStatus — 走査中の 0 件は従来の `Searching…`・語が空なら空・終了後は従来の形', () => {
		expect(formatFolderStatus({ query: 'a', searching: true, total: 0, files: 0 })).toBe(
			FIND_IN_FOLDER_SEARCHING
		);
		expect(formatFolderStatus({ query: '', searching: true, total: 12, files: 3 })).toBe('');
		expect(formatFolderStatus({ query: 'a', searching: false, total: 12, files: 3 })).toBe(
			'12 results in 3 files'
		);
		expect(formatFolderStatus({ query: 'a', searching: false, total: 0, files: 0 })).toBe(
			FIND_IN_FOLDER_NO_RESULTS
		);
	});

	test('走査中の文言は `Searching…` で始まり ` so far` で終わる・CJK を含まない(要件#51)', () => {
		const s = formatFolderStatus({ query: 'a', searching: true, total: 12, files: 3 });
		expect(s.startsWith(FIND_IN_FOLDER_SEARCHING)).toBe(true);
		expect(s.endsWith(' so far')).toBe(true);
		expect(s).not.toMatch(CJK);
	});
});
