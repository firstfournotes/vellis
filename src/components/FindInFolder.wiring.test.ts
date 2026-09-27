/**
 * 要件#55 の受け入れテスト(docs/requirements/req-55.md)— 検索パネルの配線
 * (component プロジェクト・`FindInFolder.svelte` を JSDOM に単体マウントする)
 *
 * 判定範囲(AC 番号は req-55.md の受け入れ基準):
 * - AC-55-14 パネルの構成と文言(英語・値固定)・Explorer へ戻る操作(Close)・揮発
 *   (localStorage に書かない)。⌘⇧F の受信と root 未選択のガードは +page.svelte の
 *   持ち場なので**ソース走査**で固定する(`MENU_FIND_IN_FOLDER_EVENT` の購読・
 *   `shouldShowFindInFolder` の使用・`<FindInFolder` と `<Explorer` の共存・
 *   `Explorer.svelte` の DOM に手を入れない=契約⑨)
 * - AC-55-15 入力すると `invoke('search_in_folder', { root, query, generation })` が
 *   呼ばれる。空文字では呼ばれない。世代番号は単調増加
 * - AC-55-13 の配線面: 古い世代の結果が後から届いても表示に反映されない
 * - AC-55-12 の配線面: 結果はファイルごとのグループ(相対パス・件数・行番号+行テキスト)
 * - AC-55-16 結果クリック → `open_document`(当該 URI)→ `onOpen(uri, query)`。
 *   同じ語で要件#54 の検索が起動する側は `Viewer.svelte` の新 prop `findInitialQuery` で
 *   判定する(語が無くても `No results` で止まり、エラーにならない)
 *
 * ## 配線に求める契約(implementer はこれに従う)
 * - 新規 `src/components/FindInFolder.svelte`。props:
 *   `rootUri: string`(root の URI・末尾 `/` 無し)・
 *   `onOpen: (uri: string, query: string) => void`(文書を開いた**後**に呼ぶ。+page.svelte は
 *   これを受けて Viewer へ語を渡し #54 の検索を起動する)・`onClose: () => void`(Explorer へ戻る)
 * - testid: `find-in-folder`(パネル)・`find-in-folder-input`(<input>)・
 *   `find-in-folder-status`(状態表示・role="status")・`find-in-folder-results`(結果一覧)・
 *   `find-in-folder-group`(ファイルごとのグループ・`data-path`)・`find-in-folder-group-path`・
 *   `find-in-folder-group-count`・`find-in-folder-hit`(1 行・`data-path` / `data-line`)・
 *   `find-in-folder-hit-line`・`find-in-folder-hit-text`・`find-in-folder-close`(ボタン)
 * - 文言は英語(要件#51): placeholder `Find in folder`・Close ボタンの文言 `Close`・
 *   状態表示は `$lib/find-in-folder` の `formatFolderStatus`(`Searching…` / `No results` /
 *   `n results in m files`)
 * - 入力(input イベント)のたびに `SearchSession.next()` で世代を進め、`$lib/ipc` の
 *   `invoke(SEARCH_IN_FOLDER_COMMAND, { root: rootUri, query, generation })` を呼ぶ。
 *   引数名は camelCase のこの 3 つ。debounce を入れるなら **300ms 以下**(本テストは
 *   実時間で待つ)。空文字は invoke しない(結果と状態を空に戻す)
 * - 戻り `SearchResponse = { generation, total, files, hits }`(追補a・2026-09-25 で
 *   `total` / `files` が増え、`hits` は先頭 1 ページ=200 件)。`SearchSession.accept` を
 *   通し、null(古い世代)なら捨てる。invoke の reject は状態表示に留め、例外を外へ出さない
 * - 追補a(段階渡し・案 1): 状態表示は `total` / `files` で全件の件数。結果一覧は取り込んだ分だけ。
 *   `total > 取り込んだ件数` のとき一覧の末尾に `<button data-testid="find-in-folder-show-more">`
 *   (文言 `FIND_IN_FOLDER_SHOW_MORE(remaining)` = `Show more (N remaining)`)を出し、押すと
 *   `invoke('search_in_folder_page', { generation, offset: <取り込んだ件数>, limit: 200 })`
 *   (引数名はこの 3 つ・generation は表示中の結果の世代)。戻り `{ generation, hits }` を
 *   `SearchSession.isCurrent` で選び、現在世代なら末尾に足す。全部取り込んだらボタンは消える。
 *   打ち替え(新世代)・空文字で前の世代の結果とページは捨てる
 * - 追補b-2: クリックした結果の uri が `windowState.currentDocument?.uri` と同じなら
 *   `confirmDiscardEdits` / `openForDisplay` / `setDocument` を呼ばず(dirty でも)
 *   `onOpen(uri, query, index)` だけを 1 回呼ぶ。index = `matchIndex(shownHits, hit, query)`
 *   (`ordinal` があれば `ordinal - 1`、無ければ `occurrenceIndex`)
 * - 結果の行のクリック: `confirmDiscardEdits()`(`$lib/edit-guard`)→ 偽なら何もしない →
 *   `openForDisplay(uri)`(`$lib/open-document`・`uri = rootUri + '/' + path`)→
 *   `windowState.setDocument(payload)` → `onOpen(uri, query)`。open が reject したら
 *   `onOpen` を呼ばず、例外を外へ出さない。パネルは閉じない(`onClose` を呼ばない)
 * - localStorage / sessionStorage に書かない(ウインドウ単位・揮発)
 * - `Viewer.svelte` に prop `findInitialQuery?: string` を足す: `findRequest` が進んだとき、
 *   `findInitialQuery` が空でなければ検索バーの語をそれにしてから開く(空なら従来どおり)。
 *   +page.svelte は `onOpen(uri, query)` で `findInitialQuery = query; findRequest += 1`
 *
 * ## スタブの設計(Explorer.newtab / Viewer.find wiring の家風)
 * - $lib/ipc: モジュールモック。`search_in_folder` は世代ごとに手で resolve できる deferred、
 *   `open_document` は DocumentPayload 形
 * - $lib/edit-guard: confirmDiscardEdits のモック
 * - plugin-opener / plugin-dialog / mermaid-mounter: Viewer の import を成立させるだけ
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/edit-guard', () => ({ confirmDiscardEdits: vi.fn(async () => true) }));
vi.mock('@tauri-apps/plugin-opener', () => ({
	revealItemInDir: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
	openUrl: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
	open: vi.fn(async () => null),
	ask: vi.fn(async () => false),
}));
vi.mock('$lib/mermaid-mounter', () => ({ mountMermaid: vi.fn(async () => undefined) }));
// 要件#55 追補d(2026-09-25): `search_progress` / `search_done` の購読。`$lib/events` の listen を
// 名前ごとの handler 登録に置き換え、テストから `eventBus.emit(name, payload)` で発火する。
// unlisten を呼ぶと登録が外れ、名前が `unlistened` に積まれる。Viewer の `menu_find` の購読も
// このモックを通る(resolve するだけ=既存ケースの挙動は変わらない)。
const eventBus = vi.hoisted(() => {
	type Handler = (e: { payload: unknown }) => void;
	const handlers = new Map<string, Set<Handler>>();
	const unlistened: string[] = [];
	return {
		handlers,
		unlistened,
		reset() {
			handlers.clear();
			unlistened.length = 0;
		},
		emit(name: string, payload: unknown) {
			for (const h of Array.from(handlers.get(name) ?? [])) h({ payload });
		},
		subscribe(name: string, handler: Handler): () => void {
			let set = handlers.get(name);
			if (!set) {
				set = new Set();
				handlers.set(name, set);
			}
			set.add(handler);
			return () => {
				set?.delete(handler);
				unlistened.push(name);
			};
		},
	};
});
vi.mock('$lib/events', () => ({
	listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) =>
		eventBus.subscribe(event, handler)
	),
}));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import { confirmDiscardEdits } from '$lib/edit-guard';
import FindInFolder from './FindInFolder.svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { SearchHit } from '$lib/find-in-folder';
// 要件#55 追補b: 第 3 引数(番目)の突き合わせに使う。
import { occurrenceIndex } from '$lib/find-in-folder';
// 要件#65 契約13: 欄の値のリセット(`resetSearchScope`)と分割の純関数(`splitPatterns`)。
// 名前空間 import なので、未実装でもこのファイルの読み込みは失敗しない(該当ケースだけが赤)。
import * as findInFolderModule from '$lib/find-in-folder';

const invokeMock = vi.mocked(invoke);
const confirmMock = vi.mocked(confirmDiscardEdits);

/** CJK を含まない=英語の判定(要件#51 の走査と同じ考え方)。 */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

const ROOT = 'file:///Users/x/notes';
const HITS: SearchHit[] = [
	{ path: 'docs/a.md', line: 3, text: 'alpha one', ordinal: 1 },
	{ path: 'docs/a.md', line: 7, text: 'ALPHA two', ordinal: 2 },
	{ path: 'b.txt', line: 1, text: 'alpha', ordinal: 1 },
];

/** Rust の PAGE_SIZE と同値(モックは Rust の ResultStore の鏡として先頭 1 ページだけ返す)。 */
const PAGE = 200;

type Pending = {
	args: { root: string; query: string; generation: number };
	/**
	 * 全件を渡すと、Rust の ResultStore と同じく `{ generation, total, files, hits: 先頭 200 }` で
	 * 応える(要件側更新・追補a 2026-09-25: 応答の形だけ変え、意味は変えない)。
	 * `total` / `files` を明示すれば hits と無関係に上書きできる。全件はページの材料として残る。
	 */
	resolve: (hits: SearchHit[], counts?: { total?: number; files?: number }) => void;
	reject: (err: unknown) => void;
};
type PendingPage = {
	args: { generation: number; offset: number; limit: number };
	/** 省略時はその世代の全件から offset / limit で切り出す(世代が無ければ空)。 */
	resolve: (hits?: SearchHit[]) => void;
	reject: (err: unknown) => void;
};
let pending: Pending[] = [];
let pendingPages: PendingPage[] = [];
let storedByGeneration = new Map<number, SearchHit[]>();

function distinctPaths(hits: SearchHit[]): number {
	return new Set(hits.map((h) => h.path)).size;
}

function installInvoke() {
	pending = [];
	pendingPages = [];
	storedByGeneration = new Map();
	invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === 'search_in_folder') {
			return await new Promise((res, rej) => {
				const a = args as Pending['args'];
				pending.push({
					args: a,
					resolve: (hits, counts) => {
						storedByGeneration.set(a.generation, hits);
						res({
							generation: a.generation,
							total: counts?.total ?? hits.length,
							files: counts?.files ?? distinctPaths(hits),
							hits: hits.slice(0, PAGE),
						});
					},
					reject: rej,
				});
			});
		}
		if (cmd === 'search_in_folder_page') {
			return await new Promise((res, rej) => {
				const a = args as PendingPage['args'];
				pendingPages.push({
					args: a,
					resolve: (hits) => {
						const all = storedByGeneration.get(a.generation) ?? [];
						res({
							generation: a.generation,
							hits: hits ?? all.slice(a.offset, a.offset + a.limit),
						});
					},
					reject: rej,
				});
			});
		}
		if (cmd === 'open_document' || cmd === 'open_binary_document') {
			return { uri: args?.uri, content: '', modified: null };
		}
		return null;
	});
}

function searchCalls() {
	return invokeMock.mock.calls.filter((c) => c[0] === 'search_in_folder');
}

function pageCalls() {
	return invokeMock.mock.calls.filter((c) => c[0] === 'search_in_folder_page');
}

const showMore = () => screen.queryByTestId('find-in-folder-show-more');

/** Show more を押して page の invoke が 1 件増えるまで待つ。 */
async function clickShowMore() {
	const before = pageCalls().length;
	const button = showMore();
	expect(button, 'Show more button').toBeTruthy();
	await fireEvent.click(button as HTMLElement);
	await waitFor(() => expect(pageCalls().length).toBe(before + 1));
	return pendingPages[pendingPages.length - 1];
}

function openCalls() {
	return invokeMock.mock.calls.filter(
		(c) => c[0] === 'open_document' || c[0] === 'open_binary_document'
	);
}

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

function mountPanel(props: { rootUri?: string } = {}) {
	const onOpen = vi.fn((_uri: string, _query: string) => {});
	const onClose = vi.fn(() => {});
	const utils = render(FindInFolder, {
		props: { rootUri: props.rootUri ?? ROOT, onOpen, onClose },
	});
	return { onOpen, onClose, ...utils };
}

const input = () => screen.getByTestId('find-in-folder-input') as HTMLInputElement;
const status = () => screen.getByTestId('find-in-folder-status');
const groups = () => screen.queryAllByTestId('find-in-folder-group');
const hitRows = () => screen.queryAllByTestId('find-in-folder-hit');

/** 入力して invoke が 1 件増えるまで待つ(debounce があっても 300ms 以下なら通る)。 */
async function typeAndWait(value: string) {
	const before = searchCalls().length;
	await fireEvent.input(input(), { target: { value } });
	await waitFor(() => expect(searchCalls().length).toBe(before + 1), { timeout: 1500 });
	return pending[pending.length - 1];
}

beforeEach(() => {
	installInvoke();
	confirmMock.mockResolvedValue(true);
	windowState.currentDocument = null;
	Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
	try {
		localStorage.clear();
	} catch {
		// storage が無い環境は無視
	}
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-55-14 — パネルの構成・文言・Explorer へ戻る・揮発(契約①)
// ---------------------------------------------------------------------------

describe('AC-55-14: 検索パネルの構成 — 入力欄・結果一覧・状態表示・Close・英語(契約①⑥)', () => {
	it('testid が固定され、入力欄・状態表示・結果一覧・Close が出る', () => {
		mountPanel();

		expect(screen.getByTestId('find-in-folder')).toBeTruthy();
		expect(input().tagName).toBe('INPUT');
		expect(status()).toBeTruthy();
		expect(screen.getByTestId('find-in-folder-results')).toBeTruthy();
		expect(screen.getByTestId('find-in-folder-close')).toBeTruthy();
	});

	it('placeholder は `Find in folder`・Close の文言は `Close`・状態表示は role=status(値固定・英語)', () => {
		mountPanel();

		expect(input().placeholder).toBe('Find in folder');
		expect(screen.getByTestId('find-in-folder-close').textContent?.trim()).toBe('Close');
		expect(status().getAttribute('role')).toBe('status');
		const label = input().getAttribute('aria-label') ?? '';
		expect(label.length).toBeGreaterThan(0);
		expect(label).not.toMatch(CJK);
	});

	it('パネル全体の文言に CJK が無い(要件#51)— 結果表示中も', async () => {
		mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(HITS);
		await settle();

		expect(screen.getByTestId('find-in-folder').textContent ?? '').not.toMatch(CJK);
	});

	it('まだ何も打っていないとき状態表示は空・結果は無い', () => {
		mountPanel();

		expect(status().textContent?.trim()).toBe('');
		expect(groups()).toHaveLength(0);
	});

	it('Close ボタンで onClose が 1 回(Explorer へ戻る)', async () => {
		const { onClose } = mountPanel();

		await fireEvent.click(screen.getByTestId('find-in-folder-close'));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('localStorage / sessionStorage に何も書かない(ウインドウ単位・揮発)', async () => {
		mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(HITS);
		await settle();

		expect(Object.keys(localStorage)).toEqual([]);
		expect(Object.keys(sessionStorage)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-55-15 — 入力で search_in_folder が root・語・世代番号つきで呼ばれる(契約①⑤)
// ---------------------------------------------------------------------------

describe('AC-55-15: 入力すると invoke(search_in_folder, { root, query, generation })(契約①⑤)', () => {
	it('語を入れると search_in_folder が root・query・generation(正の整数)で 1 回', async () => {
		mountPanel();

		const p = await typeAndWait('alpha');

		expect(searchCalls()).toHaveLength(1);
		expect(p.args.root).toBe(ROOT);
		expect(p.args.query).toBe('alpha');
		expect(Number.isInteger(p.args.generation)).toBe(true);
		expect(p.args.generation).toBeGreaterThanOrEqual(1);
		// 要件側更新(要件#65 契約11・13・2026-09-25): 検索パネルの欄の 3 引数
		// (include / exclude / useExcludeSettings)が加わった。他の assert は無改変。
		expect(Object.keys(p.args).sort()).toEqual([
			'exclude',
			'generation',
			'include',
			'query',
			'root',
			'useExcludeSettings',
		]);
	});

	it('打ち替えるたびに世代番号が増える', async () => {
		mountPanel();

		const p1 = await typeAndWait('a');
		const p2 = await typeAndWait('ab');
		const p3 = await typeAndWait('abc');

		expect(p2.args.generation).toBeGreaterThan(p1.args.generation);
		expect(p3.args.generation).toBeGreaterThan(p2.args.generation);
		expect(p3.args.query).toBe('abc');
	});

	it('空文字では呼ばれない(マウント直後も・消したときも)。結果と状態は空に戻る', async () => {
		mountPanel();
		await new Promise((r) => setTimeout(r, 350));
		expect(searchCalls()).toHaveLength(0);

		const p = await typeAndWait('alpha');
		p.resolve(HITS);
		await settle();
		expect(groups().length).toBeGreaterThan(0);

		await fireEvent.input(input(), { target: { value: '' } });
		await new Promise((r) => setTimeout(r, 350));
		await settle();

		expect(searchCalls()).toHaveLength(1);
		expect(groups()).toHaveLength(0);
		expect(status().textContent?.trim()).toBe('');
	});

	it('検索中は状態表示に Searching… が出る', async () => {
		mountPanel();

		await typeAndWait('alpha');
		await settle();

		expect(status().textContent?.trim()).toBe('Searching…');
	});

	it('invoke が reject しても例外を外へ出さず、パネルは残る', async () => {
		mountPanel();
		const p = await typeAndWait('alpha');

		p.reject(new Error('boom'));
		await settle();

		expect(screen.getByTestId('find-in-folder')).toBeTruthy();
		expect(input().value).toBe('alpha');
	});
});

// ---------------------------------------------------------------------------
// AC-55-12 / AC-55-13 の配線面 — グループ表示・古い世代の破棄(契約⑥⑧)
// ---------------------------------------------------------------------------

describe('AC-55-12(配線): 結果はファイルごとのグループ — 相対パス・件数・行番号+行テキスト(契約⑥)', () => {
	it('3 件 / 2 ファイルの結果 → グループ 2 つ・行 3 つ・状態表示に全体の件数', async () => {
		mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(HITS);
		await settle();

		const gs = groups();
		expect(gs).toHaveLength(2);
		expect(gs[0].getAttribute('data-path')).toBe('docs/a.md');
		expect(gs[1].getAttribute('data-path')).toBe('b.txt');
		expect(
			gs[0].querySelector('[data-testid="find-in-folder-group-path"]')?.textContent?.trim()
		).toBe('docs/a.md');
		expect(
			gs[0].querySelector('[data-testid="find-in-folder-group-count"]')?.textContent?.trim()
		).toBe('2');
		expect(
			gs[1].querySelector('[data-testid="find-in-folder-group-count"]')?.textContent?.trim()
		).toBe('1');

		const rows = hitRows();
		expect(rows).toHaveLength(3);
		expect(rows[0].getAttribute('data-path')).toBe('docs/a.md');
		expect(rows[0].getAttribute('data-line')).toBe('3');
		expect(
			rows[0].querySelector('[data-testid="find-in-folder-hit-line"]')?.textContent?.trim()
		).toBe('3');
		expect(
			rows[0].querySelector('[data-testid="find-in-folder-hit-text"]')?.textContent?.trim()
		).toBe('alpha one');
		expect(rows[1].getAttribute('data-line')).toBe('7');
		expect(rows[2].getAttribute('data-path')).toBe('b.txt');

		expect(status().textContent?.trim()).toBe('3 results in 2 files');
	});

	it('0 件は No results(値固定)で、グループは出ない', async () => {
		mountPanel();
		const p = await typeAndWait('nothing');
		p.resolve([]);
		await settle();

		expect(status().textContent?.trim()).toBe('No results');
		expect(groups()).toHaveLength(0);
	});

	it('多数(5,001 件)でも件数は全件で、Show more を繰り返せば全件の行が出る(上限なしは不変)', async () => {
		// 要件側更新(追補a・2026-09-25): 応答は先頭 200 件だけ運ぶので、全件は 25 回の
		// Show more で取り込む(200 + 24 * 200 = 5,000、最後の 1 件で 25 回目)。
		const many: SearchHit[] = [];
		for (let i = 1; i <= 5_001; i++) {
			many.push({ path: 'big.txt', line: i, text: `alpha ${i}`, ordinal: i });
		}
		mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(many);
		await settle();

		expect(status().textContent?.trim()).toBe('5001 results in 1 file');
		expect(hitRows()).toHaveLength(PAGE);
		expect(showMore()?.textContent?.trim()).toBe('Show more (4801 remaining)');

		let clicks = 0;
		while (showMore() !== null) {
			const page = await clickShowMore();
			expect(page.args.limit).toBe(PAGE);
			expect(page.args.offset).toBe(PAGE * (clicks + 1));
			page.resolve();
			await settle();
			clicks += 1;
			expect(clicks).toBeLessThanOrEqual(25);
		}

		expect(clicks).toBe(25);
		expect(hitRows()).toHaveLength(5_001);
		expect(hitRows()[5_000].getAttribute('data-line')).toBe('5001');
		expect(status().textContent?.trim()).toBe('5001 results in 1 file');
	}, 30_000);
});

describe('AC-55-13(配線): 古い世代の結果は表示に反映されない(契約⑧)', () => {
	it('新しい世代が先に届き、古い世代が後から届いても表示は新しいまま', async () => {
		mountPanel();
		const p1 = await typeAndWait('a');
		const p2 = await typeAndWait('ab');

		p2.resolve([{ path: 'new.md', line: 1, text: 'ab new' }]);
		await settle();
		expect(groups().map((g) => g.getAttribute('data-path'))).toEqual(['new.md']);

		p1.resolve([{ path: 'old.md', line: 1, text: 'a old' }]);
		await settle();
		expect(groups().map((g) => g.getAttribute('data-path'))).toEqual(['new.md']);
		expect(status().textContent?.trim()).toBe('1 result in 1 file');
	});

	it('古い世代が先に届いても(新しい世代が未着)古い結果は出さない', async () => {
		mountPanel();
		const p1 = await typeAndWait('a');
		await typeAndWait('ab');

		p1.resolve([{ path: 'old.md', line: 1, text: 'a old' }]);
		await settle();

		expect(groups()).toHaveLength(0);
		expect(status().textContent?.trim()).not.toBe('1 result in 1 file');
	});
});

// ---------------------------------------------------------------------------
// AC-55-16 — 結果クリックで開いて、同じ語で要件#54 の検索を起動(契約⑦)
// ---------------------------------------------------------------------------

describe('AC-55-16: 結果クリック → open_document(当該 URI)→ onOpen(uri, query)(契約⑦)', () => {
	async function mountWithResults() {
		const mounted = mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(HITS);
		await settle();
		return mounted;
	}

	it('行をクリックすると open_document が root + path の URI で 1 回、続いて onOpen(uri, query)', async () => {
		const { onOpen } = await mountWithResults();

		await fireEvent.click(hitRows()[2]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(openCalls()).toHaveLength(1);
		expect(openCalls()[0][0]).toBe('open_document');
		expect(openCalls()[0][1]).toEqual({ uri: `${ROOT}/b.txt` });
		expect(onOpen).toHaveBeenCalledWith(`${ROOT}/b.txt`, 'alpha', 0);
		const openOrder = invokeMock.mock.invocationCallOrder[invokeMock.mock.calls.indexOf(openCalls()[0])];
		expect(openOrder).toBeLessThan(onOpen.mock.invocationCallOrder[0]);
		expect(windowState.currentDocument?.uri).toBe(`${ROOT}/b.txt`);
	});

	it('入れ子のパスも URI に組める(docs/a.md)', async () => {
		const { onOpen } = await mountWithResults();

		await fireEvent.click(hitRows()[0]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(openCalls()[0][1]).toEqual({ uri: `${ROOT}/docs/a.md` });
		expect(onOpen).toHaveBeenCalledWith(`${ROOT}/docs/a.md`, 'alpha', 0);
	});

	it('クリック後もパネルは開いたまま(onClose は呼ばれない・結果も残る)', async () => {
		const { onOpen, onClose } = await mountWithResults();

		await fireEvent.click(hitRows()[0]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(onClose).not.toHaveBeenCalled();
		expect(hitRows()).toHaveLength(3);
		expect(input().value).toBe('alpha');
	});

	it('編集の破棄を聞く経路(confirmDiscardEdits)を素通りしない — 偽なら開かない', async () => {
		confirmMock.mockResolvedValue(false);
		const { onOpen } = await mountWithResults();

		await fireEvent.click(hitRows()[0]);
		await settle();
		await settle();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(openCalls()).toHaveLength(0);
		expect(onOpen).not.toHaveBeenCalled();
	});

	it('open_document が失敗しても例外を外へ出さず、onOpen は呼ばれない', async () => {
		const { onOpen } = await mountWithResults();
		invokeMock.mockImplementation(async (cmd: string) => {
			if (cmd === 'open_document') throw new Error('not found');
			return null;
		});

		await fireEvent.click(hitRows()[0]);
		await settle();
		await settle();

		expect(onOpen).not.toHaveBeenCalled();
		expect(screen.getByTestId('find-in-folder')).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// AC-55-16(#54 側)— Viewer が語を受け取って検索バーを開く(契約⑦)
// ---------------------------------------------------------------------------

describe('AC-55-16(#54 側): Viewer の findInitialQuery — 同じ語で検索バーが開く・無ければ No results', () => {
	const MD_URI = 'file:///Users/x/notes/docs/a.md';
	const MD = '# Alpha\n\nalpha beta gamma.\n';
	let rendered: { html: string; index: SourceIndex };

	beforeAll(async () => {
		const r = await renderMarkdown(MD, MD_URI);
		rendered = { html: r.html, index: r.index };
	});

	function mountViewer(findInitialQuery: string) {
		const doc: DocumentPayload = { uri: MD_URI, content: MD, modified: 1 };
		windowState.setDocument(doc);
		return render(Viewer, {
			props: {
				document: doc,
				html: rendered.html,
				index: rendered.index,
				onRequestAddMark: vi.fn(),
				onToggleMarks: vi.fn(),
				marksOpen: false,
				findRequest: 1,
				findInitialQuery,
			},
		});
	}

	it('findRequest が進み findInitialQuery が渡ると、その語で検索バーが開き件数が出る', async () => {
		const { container } = mountViewer('alpha');

		await waitFor(() => {
			const bar = container.querySelector('[data-testid="find-bar"]');
			expect(bar, '検索バーが開くこと').toBeTruthy();
		});
		const findInput = container.querySelector('[data-testid="find-input"]') as HTMLInputElement;
		expect(findInput.value).toBe('alpha');
		await waitFor(() => {
			const count = container.querySelector('[data-testid="find-count"]')?.textContent?.trim();
			expect(count).toBe('1 of 2');
		});
	});

	it('開いた文書に語が無ければ No results で止まる(エラーにならない)', async () => {
		const { container } = mountViewer('omega');

		await waitFor(() => {
			expect(container.querySelector('[data-testid="find-bar"]')).toBeTruthy();
		});
		const findInput = container.querySelector('[data-testid="find-input"]') as HTMLInputElement;
		expect(findInput.value).toBe('omega');
		await waitFor(() => {
			const count = container.querySelector('[data-testid="find-count"]')?.textContent?.trim();
			expect(count).toBe('No results');
		});
	});
});

// ---------------------------------------------------------------------------
// AC-55-14(+page.svelte / Explorer.svelte のソース走査)— 受信・ガード・共存・不変(契約①⑨)
// ---------------------------------------------------------------------------

describe('AC-55-14(ソース走査): +page.svelte が ⌘⇧F を受けてパネルを出す・Explorer は不変(契約①⑨)', () => {
	const page = () => readFileSync(resolve(__dirname, '../routes/+page.svelte'), 'utf-8');
	const explorer = () => readFileSync(resolve(__dirname, 'Explorer.svelte'), 'utf-8');

	it('+page.svelte が MENU_FIND_IN_FOLDER_EVENT を $lib/find-in-folder から import して listen する', () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*MENU_FIND_IN_FOLDER_EVENT[^}]*\}\s*from\s*'\$lib\/find-in-folder'/);
		expect(src).toMatch(/listen\(\s*MENU_FIND_IN_FOLDER_EVENT\s*,/);
	});

	it('+page.svelte は root 未選択のガードに shouldShowFindInFolder を使う', () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*shouldShowFindInFolder[^}]*\}\s*from\s*'\$lib\/find-in-folder'/);
		expect(src).toMatch(/shouldShowFindInFolder\(/);
	});

	it('+page.svelte が FindInFolder を Explorer と並べてマウントし、onOpen / onClose / rootUri を渡す', () => {
		const src = page();
		expect(src).toMatch(/import FindInFolder from '\.\.\/components\/FindInFolder\.svelte'/);
		expect(src).toMatch(/<FindInFolder[\s\S]*?rootUri=/);
		expect(src).toMatch(/<FindInFolder[\s\S]*?onOpen=/);
		expect(src).toMatch(/<FindInFolder[\s\S]*?onClose=/);
		expect(src).toMatch(/<Explorer\b/);
	});

	it('+page.svelte は Viewer へ findInitialQuery を渡す(結果クリックの語で #54 を起動する口)', () => {
		const src = page();
		expect(src).toMatch(/findInitialQuery/);
		expect(src).toMatch(/<Viewer[\s\S]*?findInitialQuery/);
	});

	it('Explorer.svelte は検索パネルを知らない(DOM を変えない=契約⑨)', () => {
		// 要件側更新(追補c・2026-09-25): prop `onFindInFolder` と見出し行のボタンは許容。
		// Explorer が知ってはいけないのは Tauri の検索コマンドとメニューのイベント名。
		const src = explorer();
		expect(src).not.toMatch(/search_in_folder/);
		expect(src).not.toMatch(/MENU_FIND_IN_FOLDER_EVENT/);
		expect(src).not.toMatch(/menu_find_in_folder/);
	});

	it('FindInFolder.svelte は data-zoom-region を付けない(要件#63 の判別に割り込まない=契約⑨)', () => {
		const src = readFileSync(resolve(__dirname, 'FindInFolder.svelte'), 'utf-8');
		expect(src).not.toMatch(/data-zoom-region/);
	});
});

// ---------------------------------------------------------------------------
// 要件#55 追補b(2026-09-25)— 結果クリックで onOpen(uri, query, index) の第 3 引数に
// そのファイル内の番目(occurrenceIndex・0 始まり)が入る
//
// 配線に求める契約: `onOpen: (uri: string, query: string, index: number) => void`。
// index = `$lib/find-in-folder` の `occurrenceIndex(<表示中の全 hit>, <クリックした hit>, <結果を出した語>)`。
// +page.svelte はこれを `pendingFolderFind` に持ち、`findInitialIndex` として Viewer へ渡す。
// ---------------------------------------------------------------------------

describe('要件#55 追補b・AC-55-20: 結果クリック → onOpen の第 3 引数が occurrenceIndex と一致する', () => {
	const A = 'docs/a.md';
	const INDEXED: SearchHit[] = [
		{ path: A, line: 3, text: 'alpha one' },
		{ path: A, line: 5, text: 'Alpha ALPHA' },
		{ path: A, line: 9, text: 'alpha near the end' },
		{ path: 'b.txt', line: 1, text: 'alpha' },
		{ path: 'b.txt', line: 4, text: 'alpha again' },
	];

	async function mountIndexed() {
		const mounted = mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(INDEXED);
		await settle();
		expect(hitRows()).toHaveLength(INDEXED.length);
		return mounted;
	}

	const thirdArg = (fn: ReturnType<typeof vi.fn>) => (fn.mock.calls[0] as unknown[])[2];

	it('先頭の行をクリックすると第 3 引数は 0', async () => {
		const { onOpen } = await mountIndexed();

		await fireEvent.click(hitRows()[0]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(onOpen.mock.calls[0][0]).toBe(`${ROOT}/${A}`);
		expect(onOpen.mock.calls[0][1]).toBe('alpha');
		expect(thirdArg(onOpen)).toBe(0);
		expect(thirdArg(onOpen)).toBe(occurrenceIndex(INDEXED, INDEXED[0], 'alpha'));
	});

	it('後ろの行をクリックすると第 3 引数は前の行の出現数の合計(1 行 2 回も数える)', async () => {
		const { onOpen } = await mountIndexed();

		// A line 9: lines 3 (1) + 5 (2) = 3
		await fireEvent.click(hitRows()[2]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(onOpen.mock.calls[0][0]).toBe(`${ROOT}/${A}`);
		expect(thirdArg(onOpen)).toBe(3);
		expect(thirdArg(onOpen)).toBe(occurrenceIndex(INDEXED, INDEXED[2], 'alpha'));
	});

	it('別のファイルの行は数えない(b.txt の 2 行目は 1)', async () => {
		const { onOpen } = await mountIndexed();

		await fireEvent.click(hitRows()[4]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(onOpen.mock.calls[0][0]).toBe(`${ROOT}/b.txt`);
		expect(thirdArg(onOpen)).toBe(1);
		expect(thirdArg(onOpen)).toBe(occurrenceIndex(INDEXED, INDEXED[4], 'alpha'));
	});

	it('番目は結果を出した語で数える(入力欄を打ち替えた後でも、表示中の結果の語)', async () => {
		const { onOpen } = await mountIndexed();
		// Retype without letting the new search resolve: the shown results are still for 'alpha'.
		await typeAndWait('alphab');

		await fireEvent.click(hitRows()[1]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(onOpen.mock.calls[0][1]).toBe('alpha');
		expect(thirdArg(onOpen)).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// 要件#55 追補a(2026-09-25・案 1)— 結果を段階的に渡す(配線)
// ---------------------------------------------------------------------------

/** 10 ファイル × 100 行 = 1,000 件(パス順・行番号順)。ordinal = 行の通し番号(1 行 1 回)。 */
function thousand(): SearchHit[] {
	const hits: SearchHit[] = [];
	for (let f = 0; f < 10; f++) {
		for (let i = 1; i <= 100; i++) {
			hits.push({ path: `f${String(f).padStart(2, '0')}.md`, line: i, text: `alpha ${i}`, ordinal: i });
		}
	}
	return hits;
}

describe('要件#55 追補a・AC-55-29: 状態表示は全件・一覧は先頭 200 件・Show more で続きを search_in_folder_page から取り込む', () => {
	it('total 1000 / files 10 / hits 200 → 状態表示は 1000 results in 10 files・行は 200・末尾に Show more (800 remaining)', async () => {
		mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(thousand());
		await settle();

		expect(status().textContent?.trim()).toBe('1000 results in 10 files');
		expect(hitRows()).toHaveLength(PAGE);
		expect(groups().map((g) => g.getAttribute('data-path'))).toEqual(['f00.md', 'f01.md']);

		const button = showMore();
		expect(button).toBeTruthy();
		expect(button?.tagName).toBe('BUTTON');
		expect(button?.textContent?.trim()).toBe('Show more (800 remaining)');
		expect(button?.textContent ?? '').not.toMatch(CJK);
		// The button sits inside the results list, after the last hit row.
		const results = screen.getByTestId('find-in-folder-results');
		expect(results.contains(button as Node)).toBe(true);
		const rows = hitRows();
		const lastRow = rows[rows.length - 1];
		expect(lastRow.compareDocumentPosition(button as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('Show more を押すと invoke(search_in_folder_page, { generation, offset: 200, limit: 200 })・行が 400 に・残りが 600 に', async () => {
		mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(thousand());
		await settle();

		const page = await clickShowMore();

		expect(pageCalls()).toHaveLength(1);
		expect(page.args).toEqual({ generation: p.args.generation, offset: PAGE, limit: PAGE });
		expect(Object.keys(page.args).sort()).toEqual(['generation', 'limit', 'offset']);
		// Until the page arrives nothing changes.
		expect(hitRows()).toHaveLength(PAGE);

		page.resolve();
		await settle();

		expect(hitRows()).toHaveLength(400);
		expect(groups().map((g) => g.getAttribute('data-path'))).toEqual(['f00.md', 'f01.md', 'f02.md', 'f03.md']);
		expect(hitRows()[200].getAttribute('data-path')).toBe('f02.md');
		expect(hitRows()[200].getAttribute('data-line')).toBe('1');
		expect(showMore()?.textContent?.trim()).toBe('Show more (600 remaining)');
		expect(status().textContent?.trim()).toBe('1000 results in 10 files');
		// No new search was started; the query and the input are untouched.
		expect(searchCalls()).toHaveLength(1);
		expect(input().value).toBe('alpha');
	});

	it('繰り返し押すと offset が進み(400, 600, 800)、全部取り込んだらボタンが消える', async () => {
		mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(thousand());
		await settle();

		const offsets: number[] = [];
		while (showMore() !== null) {
			const page = await clickShowMore();
			offsets.push(page.args.offset);
			page.resolve();
			await settle();
			expect(offsets.length).toBeLessThanOrEqual(4);
		}

		expect(offsets).toEqual([200, 400, 600, 800]);
		expect(hitRows()).toHaveLength(1000);
		expect(groups()).toHaveLength(10);
		expect(showMore()).toBeNull();
		expect(status().textContent?.trim()).toBe('1000 results in 10 files');
	});

	it('total <= 取り込んだ件数ならボタンは出ない(3 件・ちょうど 200 件・0 件)', async () => {
		mountPanel();
		const p1 = await typeAndWait('alpha');
		p1.resolve(HITS);
		await settle();
		expect(hitRows()).toHaveLength(3);
		expect(showMore()).toBeNull();

		const p2 = await typeAndWait('alphab');
		p2.resolve(thousand().slice(0, PAGE));
		await settle();
		expect(hitRows()).toHaveLength(PAGE);
		expect(status().textContent?.trim()).toBe('200 results in 2 files');
		expect(showMore()).toBeNull();

		const p3 = await typeAndWait('nothing');
		p3.resolve([]);
		await settle();
		expect(showMore()).toBeNull();
	});

	it('打ち替えると前の世代のページは捨てられ、新しい結果に置き換わる・空文字でも消える', async () => {
		mountPanel();
		const p1 = await typeAndWait('alpha');
		p1.resolve(thousand());
		await settle();
		(await clickShowMore()).resolve();
		await settle();
		expect(hitRows()).toHaveLength(400);

		const p2 = await typeAndWait('alphab');
		p2.resolve(HITS);
		await settle();

		expect(hitRows()).toHaveLength(3);
		expect(showMore()).toBeNull();
		expect(status().textContent?.trim()).toBe('3 results in 2 files');

		const p3 = await typeAndWait('alpha');
		p3.resolve(thousand());
		await settle();
		expect(showMore()?.textContent?.trim()).toBe('Show more (800 remaining)');

		await fireEvent.input(input(), { target: { value: '' } });
		await new Promise((r) => setTimeout(r, 350));
		await settle();
		expect(hitRows()).toHaveLength(0);
		expect(showMore()).toBeNull();
	});

	it('Show more の invoke が reject しても例外を外へ出さず、取り込んだ分とパネルは残る', async () => {
		mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(thousand());
		await settle();

		const page = await clickShowMore();
		page.reject(new Error('boom'));
		await settle();
		await settle();

		expect(screen.getByTestId('find-in-folder')).toBeTruthy();
		expect(hitRows()).toHaveLength(PAGE);
		expect(input().value).toBe('alpha');
	});
});

describe('要件#55 追補a・AC-55-29(世代): 打ち替え後に届いた古い世代のページは取り込まれない(契約⑧)', () => {
	it('古い世代のページが新しい検索の後に届いても行は増えず、新しい結果だけが出る', async () => {
		mountPanel();
		const p1 = await typeAndWait('alpha');
		p1.resolve(thousand());
		await settle();
		const stalePage = await clickShowMore();
		expect(stalePage.args.generation).toBe(p1.args.generation);

		// Retype: a new generation is in flight, the old page has not arrived yet.
		const p2 = await typeAndWait('alphab');
		expect(p2.args.generation).toBeGreaterThan(p1.args.generation);

		stalePage.resolve();
		await settle();
		expect(hitRows().length, 'stale page must not be appended').not.toBe(400);
		expect(hitRows().length).toBeLessThanOrEqual(PAGE);

		p2.resolve(HITS);
		await settle();
		expect(hitRows()).toHaveLength(3);
		expect(showMore()).toBeNull();
		expect(status().textContent?.trim()).toBe('3 results in 2 files');
	});

	it('新しい結果が先に出てから古い世代のページが届いても、新しい結果のまま', async () => {
		mountPanel();
		const p1 = await typeAndWait('alpha');
		p1.resolve(thousand());
		await settle();
		const stalePage = await clickShowMore();

		const p2 = await typeAndWait('alphab');
		p2.resolve(HITS);
		await settle();
		expect(hitRows()).toHaveLength(3);

		stalePage.resolve();
		await settle();

		expect(hitRows()).toHaveLength(3);
		expect(groups().map((g) => g.getAttribute('data-path'))).toEqual(['docs/a.md', 'b.txt']);
		expect(showMore()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 要件#55 追補a — 番目は ordinal から(ページ分けで手元に無い行があっても正確)
// ---------------------------------------------------------------------------

describe('要件#55 追補a・AC-55-30: 結果クリック → onOpen の第 3 引数は ordinal - 1(無ければ occurrenceIndex)', () => {
	it('ordinal があればそれを使う: 手元に前の行が無くても ordinal 7 の行は 6', async () => {
		const { onOpen } = mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve([{ path: 'docs/a.md', line: 40, text: 'alpha late', ordinal: 7 }]);
		await settle();

		await fireEvent.click(hitRows()[0]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(onOpen).toHaveBeenCalledWith(`${ROOT}/docs/a.md`, 'alpha', 6);
	});

	it('ordinal は手元の行の数え方より優先される(前の行が 1 つあっても ordinal 2 なら 1、ordinal 5 なら 4)', async () => {
		const { onOpen } = mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve([
			{ path: 'docs/a.md', line: 3, text: 'alpha one', ordinal: 1 },
			{ path: 'docs/a.md', line: 9, text: 'alpha alpha', ordinal: 5 },
		]);
		await settle();

		await fireEvent.click(hitRows()[1]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(onOpen).toHaveBeenCalledWith(`${ROOT}/docs/a.md`, 'alpha', 4);
	});

	it('ページで取り込んだ行も ordinal から数える', async () => {
		const { onOpen } = mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(thousand());
		await settle();
		(await clickShowMore()).resolve();
		await settle();

		// Row 250 = f02.md line 51 (ordinal 51).
		const row = hitRows()[250];
		expect(row.getAttribute('data-path')).toBe('f02.md');
		expect(row.getAttribute('data-line')).toBe('51');
		await fireEvent.click(row);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(onOpen).toHaveBeenCalledWith(`${ROOT}/f02.md`, 'alpha', 50);
	});
});

// ---------------------------------------------------------------------------
// 要件#55 追補b-2(2026-09-25・人間ゲート 7 NG)— 同じ文書は開き直さない
// ---------------------------------------------------------------------------

describe('要件#55 追補b-2・AC-55-31: クリックした結果が今開いている文書なら開き直さず onOpen だけを呼ぶ', () => {
	const A_URI = `${ROOT}/docs/a.md`;

	async function mountWithResultsAndCurrent(uri: string) {
		const mounted = mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(HITS);
		await settle();
		const current: DocumentPayload = { uri, content: '# a\n\nalpha one\n', modified: 1 };
		windowState.setDocument(current);
		// `currentDocument` is a $state field (deep proxy), so object identity cannot prove
		// that setDocument was not called; count the calls instead (calls through).
		const setDocumentSpy = vi.spyOn(windowState, 'setDocument');
		setDocumentSpy.mockClear();
		confirmMock.mockClear();
		invokeMock.mockClear();
		return { ...mounted, current, setDocumentSpy };
	}

	it('同じ文書の行 → confirmDiscardEdits / open_document / open_binary_document を呼ばず、onOpen(uri, query, ordinal - 1) が 1 回', async () => {
		const { onOpen, current, setDocumentSpy } = await mountWithResultsAndCurrent(A_URI);

		await fireEvent.click(hitRows()[1]); // docs/a.md line 7, ordinal 2
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
		await settle();

		expect(onOpen).toHaveBeenCalledWith(A_URI, 'alpha', 1);
		expect(confirmMock).not.toHaveBeenCalled();
		expect(openCalls()).toHaveLength(0);
		// setDocument was not called either; the current document is still the same one.
		expect(setDocumentSpy).not.toHaveBeenCalled();
		expect(windowState.currentDocument?.uri).toBe(current.uri);
	});

	it('同じ文書で 2 回目のクリック(別の行)も開き直さない — 先頭に戻る原因を作らない', async () => {
		const { onOpen, current, setDocumentSpy } = await mountWithResultsAndCurrent(A_URI);

		await fireEvent.click(hitRows()[0]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
		await fireEvent.click(hitRows()[1]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
		await settle();

		expect(onOpen.mock.calls[0]).toEqual([A_URI, 'alpha', 0]);
		expect(onOpen.mock.calls[1]).toEqual([A_URI, 'alpha', 1]);
		expect(confirmMock).not.toHaveBeenCalled();
		expect(openCalls()).toHaveLength(0);
		expect(setDocumentSpy).not.toHaveBeenCalled();
		expect(windowState.currentDocument?.uri).toBe(current.uri);
	});

	it('編集中(dirty)でも同じ文書なら確認を出さない(文書は動かない)', async () => {
		const { onOpen, current, setDocumentSpy } = await mountWithResultsAndCurrent(A_URI);
		windowState.editMode = 'edit';
		windowState.editBuffer = '# a\n\nalpha one (edited)\n';
		expect(windowState.dirty).toBe(true);

		await fireEvent.click(hitRows()[1]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
		await settle();

		expect(onOpen).toHaveBeenCalledWith(A_URI, 'alpha', 1);
		expect(confirmMock).not.toHaveBeenCalled();
		expect(openCalls()).toHaveLength(0);
		expect(setDocumentSpy).not.toHaveBeenCalled();
		expect(windowState.currentDocument?.uri).toBe(current.uri);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.editBuffer).toBe('# a\n\nalpha one (edited)\n');
	});

	it('違うファイルの行は従来どおり confirmDiscardEdits → open_document → onOpen', async () => {
		const { onOpen } = await mountWithResultsAndCurrent(A_URI);

		await fireEvent.click(hitRows()[2]); // b.txt
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(openCalls()).toHaveLength(1);
		expect(openCalls()[0][1]).toEqual({ uri: `${ROOT}/b.txt` });
		expect(onOpen).toHaveBeenCalledWith(`${ROOT}/b.txt`, 'alpha', 0);
		expect(windowState.currentDocument?.uri).toBe(`${ROOT}/b.txt`);
	});

	it('違うファイルで編集中なら確認が出て、偽なら開かず onOpen も呼ばない(既存の経路は不変)', async () => {
		const { onOpen, current } = await mountWithResultsAndCurrent(A_URI);
		windowState.editMode = 'edit';
		windowState.editBuffer = 'changed';
		confirmMock.mockResolvedValue(false);

		await fireEvent.click(hitRows()[2]);
		await settle();
		await settle();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(openCalls()).toHaveLength(0);
		expect(onOpen).not.toHaveBeenCalled();
		expect(windowState.currentDocument?.uri).toBe(current.uri);
	});

	it('何も開いていない(currentDocument が null)ときは従来どおり開く', async () => {
		const { onOpen } = mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(HITS);
		await settle();
		expect(windowState.currentDocument).toBeNull();

		await fireEvent.click(hitRows()[0]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(openCalls()).toHaveLength(1);
		expect(onOpen).toHaveBeenCalledWith(A_URI, 'alpha', 0);
	});
});

// ---------------------------------------------------------------------------
// 要件#55 追補d(2026-09-25)— 見つかった順に段階的に出す(search_progress / search_done)
//
// 配線に求める契約(implementer はこれに従う):
// - マウント時に `$lib/events` の `listen(SEARCH_PROGRESS_EVENT, ..)` と `listen(SEARCH_DONE_EVENT, ..)`
//   を購読し、破棄時に unlisten する
// - `search_progress { generation, hits, filesScanned }`: 世代が `SearchSession.isCurrent` なら
//   `hits` を結果一覧の末尾に**追記**(グループは path 初出順・並べ替えない)。ただし表示は
//   `FIND_IN_FOLDER_PAGE_SIZE`(200)行で止め、それ以降の hits は数えるだけ。状態表示は
//   `formatFolderStatus({ searching: true, total: 受け取った件数, files: 受け取った hits の path の数 })`
//   = `Searching… N results in M files so far`
// - `search_done { generation, total, files }`: 現在世代なら searching を終え、`total` / `files` を
//   その値にする(`N results in M files`)。invoke の応答より先に来てよい
// - 世代が違う progress / done は捨てる(打ち替え後に届いた古い世代は表示に触れない)
// - **表示の源は progress**。`search_in_folder` の応答は `total` / `files` と Show more の起点
//   (`ResultStore` が埋まった合図)に使う。応答が先に来たとき(local で速いとき)は応答の
//   `hits` を出す。両方来ても同じ行(path + line)を二重に出さない
// - Show more は従来どおり: 応答後、`total > 表示行数` なら `Show more (N remaining)`。押すと
//   `search_in_folder_page { generation, offset: 表示行数, limit: 200 }`
// ---------------------------------------------------------------------------

const listenMock = vi.mocked(listen);

beforeEach(() => {
	eventBus.reset();
});

function subscribedNames(): string[] {
	return listenMock.mock.calls.map((c) => c[0] as string);
}

/** マウントして両イベントの購読が済むまで待つ。 */
async function mountSubscribed() {
	const utils = mountPanel();
	await waitFor(() => {
		expect(subscribedNames()).toContain('search_progress');
		expect(subscribedNames()).toContain('search_done');
	});
	return utils;
}

async function emitProgress(generation: number, hits: SearchHit[], filesScanned = 0) {
	eventBus.emit('search_progress', { generation, hits, filesScanned });
	await settle();
}

async function emitDone(generation: number, total: number, files: number) {
	eventBus.emit('search_done', { generation, total, files });
	await settle();
}

function rowKeys(): string[] {
	return hitRows().map((r) => `${r.getAttribute('data-path')}:${r.getAttribute('data-line')}`);
}

describe('要件#55 追補d・AC-55-40: search_progress で追記・search_done で確定・世代違いは捨てる・200 件で止めて Show more', () => {
	it('マウントで search_progress / search_done を $lib/events の listen で購読し、破棄で unlisten する', async () => {
		const { unmount } = await mountSubscribed();
		expect(subscribedNames().filter((n) => n === 'search_progress')).toHaveLength(1);
		expect(subscribedNames().filter((n) => n === 'search_done')).toHaveLength(1);

		unmount();
		await settle();

		expect(eventBus.unlistened).toContain('search_progress');
		expect(eventBus.unlistened).toContain('search_done');
	});

	it('progress が届いた分だけ順に追記され、状態表示は `Searching… N results in M files so far`', async () => {
		await mountSubscribed();
		const p = await typeAndWait('alpha');
		expect(hitRows()).toHaveLength(0);
		expect(status().textContent?.trim()).toBe('Searching…');

		await emitProgress(p.args.generation, HITS.slice(0, 2), 1);

		expect(rowKeys()).toEqual(['docs/a.md:3', 'docs/a.md:7']);
		expect(groups().map((g) => g.getAttribute('data-path'))).toEqual(['docs/a.md']);
		expect(status().textContent?.trim()).toBe('Searching… 2 results in 1 file so far');

		await emitProgress(p.args.generation, HITS.slice(2), 2);

		expect(rowKeys()).toEqual(['docs/a.md:3', 'docs/a.md:7', 'b.txt:1']);
		expect(groups().map((g) => g.getAttribute('data-path'))).toEqual(['docs/a.md', 'b.txt']);
		expect(screen.getAllByTestId('find-in-folder-group-count')[0].textContent).toContain('2');
		expect(status().textContent?.trim()).toBe('Searching… 3 results in 2 files so far');
		expect(showMore()).toBeNull();
		// The response has not arrived; nothing else was invoked.
		expect(searchCalls()).toHaveLength(1);
		expect(pageCalls()).toHaveLength(0);
	});

	it('追記は走査順のまま(同じ path が離れて届いても 1 グループに合流し、行の順は入れ替えない)', async () => {
		await mountSubscribed();
		const p = await typeAndWait('alpha');
		const later: SearchHit = { path: 'docs/a.md', line: 20, text: 'alpha late', ordinal: 3 };

		await emitProgress(p.args.generation, [HITS[2], HITS[0]]);
		await emitProgress(p.args.generation, [later]);

		expect(groups().map((g) => g.getAttribute('data-path'))).toEqual(['b.txt', 'docs/a.md']);
		expect(rowKeys()).toEqual(['b.txt:1', 'docs/a.md:3', 'docs/a.md:20']);
	});

	it('search_done で `N results in M files` に確定する(invoke の応答より先に来てよい)。応答が後から来ても二重に出ない', async () => {
		await mountSubscribed();
		const p = await typeAndWait('alpha');
		await emitProgress(p.args.generation, HITS, 2);
		expect(status().textContent?.trim()).toBe('Searching… 3 results in 2 files so far');

		await emitDone(p.args.generation, 3, 2);

		expect(status().textContent?.trim()).toBe('3 results in 2 files');
		expect(rowKeys()).toEqual(['docs/a.md:3', 'docs/a.md:7', 'b.txt:1']);
		expect(showMore()).toBeNull();

		p.resolve(HITS);
		await settle();

		expect(rowKeys()).toEqual(['docs/a.md:3', 'docs/a.md:7', 'b.txt:1']);
		expect(status().textContent?.trim()).toBe('3 results in 2 files');
		expect(showMore()).toBeNull();
	});

	it('progress と応答が両方届いても同じ行(path + line)は 1 回だけ(応答が done より先の順でも)', async () => {
		await mountSubscribed();
		const p = await typeAndWait('alpha');
		await emitProgress(p.args.generation, HITS.slice(0, 2));
		p.resolve(HITS);
		await settle();

		expect(rowKeys()).toEqual(['docs/a.md:3', 'docs/a.md:7', 'b.txt:1']);
		expect(status().textContent?.trim()).toBe('3 results in 2 files');

		await emitProgress(p.args.generation, HITS.slice(2));
		await emitDone(p.args.generation, 3, 2);

		expect(rowKeys()).toEqual(['docs/a.md:3', 'docs/a.md:7', 'b.txt:1']);
		expect(status().textContent?.trim()).toBe('3 results in 2 files');
	});

	it('応答が先に来たら(local で速いとき)応答の hits を出す。遅れて届いた同世代の progress / done で表示は変わらない', async () => {
		await mountSubscribed();
		const p = await typeAndWait('alpha');
		p.resolve(HITS);
		await settle();

		expect(rowKeys()).toEqual(['docs/a.md:3', 'docs/a.md:7', 'b.txt:1']);
		expect(status().textContent?.trim()).toBe('3 results in 2 files');

		await emitProgress(p.args.generation, HITS, 2);
		await emitDone(p.args.generation, 3, 2);

		expect(rowKeys()).toEqual(['docs/a.md:3', 'docs/a.md:7', 'b.txt:1']);
		expect(status().textContent?.trim()).toBe('3 results in 2 files');
		expect(status().textContent ?? '').not.toContain('so far');
	});

	it('世代が違う progress / done は捨てる(打ち替え後に届いた古い世代は表示に触れない)', async () => {
		await mountSubscribed();
		const p1 = await typeAndWait('alpha');
		const p2 = await typeAndWait('alphab');
		expect(p2.args.generation).toBeGreaterThan(p1.args.generation);

		await emitProgress(p1.args.generation, HITS, 2);
		expect(hitRows()).toHaveLength(0);
		expect(status().textContent?.trim()).toBe('Searching…');

		await emitDone(p1.args.generation, 3, 2);
		expect(status().textContent?.trim()).toBe('Searching…');
		expect(hitRows()).toHaveLength(0);

		// A generation that was never issued is not current either.
		await emitProgress(p2.args.generation + 1, HITS, 2);
		expect(hitRows()).toHaveLength(0);

		await emitProgress(p2.args.generation, [HITS[2]], 1);
		expect(rowKeys()).toEqual(['b.txt:1']);
		expect(status().textContent?.trim()).toBe('Searching… 1 result in 1 file so far');

		await emitDone(p2.args.generation, 1, 1);
		expect(status().textContent?.trim()).toBe('1 result in 1 file');
	});

	it('新しい語を打つと前の世代の progress で出した行は消え、新しい世代の progress だけが出る', async () => {
		await mountSubscribed();
		const p1 = await typeAndWait('alpha');
		await emitProgress(p1.args.generation, HITS, 2);
		expect(hitRows()).toHaveLength(3);

		const p2 = await typeAndWait('alphab');
		await emitProgress(p2.args.generation, [HITS[0]], 1);

		expect(rowKeys()).toEqual(['docs/a.md:3']);
		expect(status().textContent?.trim()).toBe('Searching… 1 result in 1 file so far');
	});

	it('progress で 200 行に達したら追記を止めて数えるだけ。done と応答の後は Show more (残り) から search_in_folder_page で取り込む', async () => {
		await mountSubscribed();
		const p = await typeAndWait('alpha');
		const all = thousand().slice(0, 250); // f00 x100, f01 x100, f02 x50

		await emitProgress(p.args.generation, all.slice(0, 100), 1);
		expect(hitRows()).toHaveLength(100);
		expect(status().textContent?.trim()).toBe('Searching… 100 results in 1 file so far');

		await emitProgress(p.args.generation, all.slice(100, 200), 2);
		expect(hitRows()).toHaveLength(PAGE);
		expect(status().textContent?.trim()).toBe('Searching… 200 results in 2 files so far');

		await emitProgress(p.args.generation, all.slice(200, 250), 3);
		expect(hitRows(), 'rows stop at 200').toHaveLength(PAGE);
		expect(groups().map((g) => g.getAttribute('data-path'))).toEqual(['f00.md', 'f01.md']);
		expect(status().textContent?.trim()).toBe('Searching… 250 results in 3 files so far');

		await emitDone(p.args.generation, 250, 3);
		expect(status().textContent?.trim()).toBe('250 results in 3 files');
		expect(hitRows()).toHaveLength(PAGE);

		p.resolve(all);
		await settle();
		expect(hitRows()).toHaveLength(PAGE);
		const button = showMore();
		expect(button).toBeTruthy();
		expect(button?.textContent?.trim()).toBe('Show more (50 remaining)');

		const page = await clickShowMore();
		expect(page.args).toEqual({ generation: p.args.generation, offset: PAGE, limit: PAGE });
		page.resolve();
		await settle();

		expect(hitRows()).toHaveLength(250);
		expect(groups().map((g) => g.getAttribute('data-path'))).toEqual(['f00.md', 'f01.md', 'f02.md']);
		expect(hitRows()[200].getAttribute('data-path')).toBe('f02.md');
		expect(hitRows()[200].getAttribute('data-line')).toBe('1');
		expect(showMore()).toBeNull();
		expect(status().textContent?.trim()).toBe('250 results in 3 files');
		expect(searchCalls()).toHaveLength(1);
	});

	it('1 回の progress が 200 行の境をまたいでも表示は 200 行で止まり、超えた分は件数にだけ入る', async () => {
		await mountSubscribed();
		const p = await typeAndWait('alpha');
		const all = thousand().slice(0, 230);

		await emitProgress(p.args.generation, all.slice(0, 195), 2);
		await emitProgress(p.args.generation, all.slice(195, 230), 3);

		expect(hitRows()).toHaveLength(PAGE);
		expect(rowKeys()[PAGE - 1]).toBe('f01.md:100');
		expect(status().textContent?.trim()).toBe('Searching… 230 results in 3 files so far');
	});

	it('progress で出した行のクリックは従来どおり open_document → onOpen(uri, query, ordinal - 1)', async () => {
		const { onOpen } = await mountSubscribed();
		const p = await typeAndWait('alpha');
		await emitProgress(p.args.generation, HITS, 2);

		const rows = hitRows();
		await fireEvent.click(rows[1]);
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

		expect(openCalls()).toHaveLength(1);
		expect(openCalls()[0][1]).toEqual({ uri: `${ROOT}/docs/a.md` });
		expect(onOpen).toHaveBeenCalledWith(`${ROOT}/docs/a.md`, 'alpha', 1);
	});

	it('パネルの文言は走査中も CJK を含まない(要件#51)・ストレージに書かない', async () => {
		await mountSubscribed();
		const p = await typeAndWait('alpha');
		await emitProgress(p.args.generation, HITS, 2);

		expect(screen.getByTestId('find-in-folder').textContent ?? '').not.toMatch(CJK);
		expect(Object.keys(localStorage)).toEqual([]);
		expect(Object.keys(sessionStorage)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 要件#65 契約13(2026-09-25 確定)— AC-65-15 検索パネルの欄=フロント
// files to include / files to exclude / 歯車(Use Exclude Settings)/ …(Toggle Search Details)
//
// 配線に求める契約(implementer はこれに従う):
// - `$lib/find-in-folder` に追加(窓の生存中だけ覚える=モジュールの変数。ストレージには書かない):
//   `export type SearchScopeFields = { include: string; exclude: string; useExcludeSettings: boolean; detailsOpen: boolean }`
//   `export function getSearchScope(): SearchScopeFields`(現在値のコピー)
//   `export function setSearchScope(patch: Partial<SearchScopeFields>): void`
//   `export function resetSearchScope(): void`(既定 = { include: '', exclude: '', useExcludeSettings: true, detailsOpen: true })
//   `export function splitPatterns(text: string): string[]`(カンマで割って trim・空要素を落とす純関数)
// - `FindInFolder.svelte`: 検索欄(`find-in-folder-input`)の下に
//   `<input data-testid="find-in-folder-include">`(見えるラベル `files to include`)・
//   `<input data-testid="find-in-folder-exclude">`(見えるラベル `files to exclude`)・
//   exclude の右端に `<button data-testid="find-in-folder-use-exclude-settings" aria-pressed="true|false" title="Use Exclude Settings">`。
//   検索欄の右に `<button data-testid="find-in-folder-toggle-details" aria-expanded="true|false" title="Toggle Search Details">…</button>`。
//   2 欄と歯車は `aria-expanded="false"` のとき DOM から外す(`{#if}`)。初期状態は出す(aria-expanded="true")
// - マウント時に `getSearchScope()` で欄・歯車・折りたたみを復元し、変更のたびに `setSearchScope` へ書く
//   (パネルを閉じて開き直しても残る・窓を閉じれば消える)
// - `search_in_folder` の invoke 引数は `{ root, query, generation, include: splitPatterns(include),
//   exclude: splitPatterns(exclude), useExcludeSettings }`(引数名はこの綴り。Tauri が Rust 側の
//   `use_exclude_settings` へ写す)
// - 欄(input イベント)か歯車を変えたら、語が空でなければ検索欄の入力と同じ経路(世代を進めて
//   debounce → invoke)で探し直す。語が空なら何もしない(invoke しない)
// - 文言は英語(要件#51)。折りたたんでも欄の値は効き続ける
// ---------------------------------------------------------------------------

type ScopeArgs = {
	root: string;
	query: string;
	generation: number;
	include: string[];
	exclude: string[];
	useExcludeSettings: boolean;
};

const scopeArgs = (p: Pending): ScopeArgs => p.args as unknown as ScopeArgs;

const includeField = () => screen.getByTestId('find-in-folder-include') as HTMLInputElement;
const excludeField = () => screen.getByTestId('find-in-folder-exclude') as HTMLInputElement;
const gear = () => screen.getByTestId('find-in-folder-use-exclude-settings') as HTMLButtonElement;
const detailsToggle = () => screen.getByTestId('find-in-folder-toggle-details') as HTMLButtonElement;

/** 欄を変えて invoke が 1 件増えるまで待つ(検索欄の入力と同じ経路=debounce があっても 300ms 以下)。 */
async function changeFieldAndWait(el: HTMLInputElement, value: string) {
	const before = searchCalls().length;
	await fireEvent.input(el, { target: { value } });
	await waitFor(() => expect(searchCalls().length).toBe(before + 1), { timeout: 1500 });
	return pending[pending.length - 1];
}

/** 歯車を押して invoke が 1 件増えるまで待つ。 */
async function clickGearAndWait() {
	const before = searchCalls().length;
	await fireEvent.click(gear());
	await waitFor(() => expect(searchCalls().length).toBe(before + 1), { timeout: 1500 });
	return pending[pending.length - 1];
}

describe('要件#65 契約13・AC-65-15: 検索パネルの欄 — include / exclude / 歯車 / … の配線', () => {
	beforeEach(() => {
		findInFolderModule.resetSearchScope();
	});

	it('include・exclude の input、歯車(aria-pressed=true)、…(aria-expanded=true)が出る。文言は英語で値固定', () => {
		mountPanel();

		expect(includeField().tagName).toBe('INPUT');
		expect(excludeField().tagName).toBe('INPUT');
		expect(includeField().value).toBe('');
		expect(excludeField().value).toBe('');
		expect(gear().tagName).toBe('BUTTON');
		expect(gear().getAttribute('aria-pressed')).toBe('true');
		expect(gear().getAttribute('title')).toBe('Use Exclude Settings');
		expect(detailsToggle().tagName).toBe('BUTTON');
		expect(detailsToggle().getAttribute('aria-expanded')).toBe('true');
		expect(detailsToggle().getAttribute('title')).toBe('Toggle Search Details');

		const text = screen.getByTestId('find-in-folder').textContent ?? '';
		expect(text).toContain('files to include');
		expect(text).toContain('files to exclude');
		expect(text).not.toMatch(CJK);
		// 2 欄は検索欄の下に並ぶ。
		const query = input();
		expect(query.compareDocumentPosition(includeField()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(includeField().compareDocumentPosition(excludeField()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('語を入れると include: []・exclude: []・useExcludeSettings: true が渡る(引数キーは 6 つ)', async () => {
		mountPanel();

		const p = await typeAndWait('alpha');

		const args = scopeArgs(p);
		expect(args.root).toBe(ROOT);
		expect(args.query).toBe('alpha');
		expect(args.include).toEqual([]);
		expect(args.exclude).toEqual([]);
		expect(args.useExcludeSettings).toBe(true);
		expect(Object.keys(p.args).sort()).toEqual([
			'exclude',
			'generation',
			'include',
			'query',
			'root',
			'useExcludeSettings',
		]);
	});

	it('語 alpha のまま include に `docs/**, *.md` を入れると、新しい世代で include: [docs/**, *.md] で呼び直す', async () => {
		mountPanel();
		const p1 = await typeAndWait('alpha');

		const p2 = await changeFieldAndWait(includeField(), 'docs/**, *.md');

		expect(searchCalls()).toHaveLength(2);
		const args = scopeArgs(p2);
		expect(args.query).toBe('alpha');
		expect(args.root).toBe(ROOT);
		expect(args.include).toEqual(['docs/**', '*.md']);
		expect(args.exclude).toEqual([]);
		expect(args.useExcludeSettings).toBe(true);
		expect(args.generation).toBeGreaterThan(scopeArgs(p1).generation);
		expect(includeField().value).toBe('docs/**, *.md');
	});

	it('exclude 欄も同じ経路で渡る。要素は trim され、空要素・空白だけの要素は落ちる', async () => {
		mountPanel();
		await typeAndWait('alpha');

		const p = await changeFieldAndWait(excludeField(), ' , **/*.log ,, node_modules ');

		const args = scopeArgs(p);
		expect(args.exclude).toEqual(['**/*.log', 'node_modules']);
		expect(args.include).toEqual([]);
		expect(args.query).toBe('alpha');
		expect(excludeField().value).toBe(' , **/*.log ,, node_modules ');
	});

	it('splitPatterns はカンマで割って trim し、空要素を落とす純関数', () => {
		const split = findInFolderModule.splitPatterns;
		expect(split('docs/**, *.md')).toEqual(['docs/**', '*.md']);
		expect(split(' , a ,, ')).toEqual(['a']);
		expect(split('')).toEqual([]);
		expect(split('   ')).toEqual([]);
		expect(split('**/node_modules')).toEqual(['**/node_modules']);
	});

	it('歯車を押すと useExcludeSettings: false で呼び直し(aria-pressed=false)、もう一度押すと true に戻る', async () => {
		mountPanel();
		const p1 = await typeAndWait('alpha');

		const p2 = await clickGearAndWait();
		expect(gear().getAttribute('aria-pressed')).toBe('false');
		expect(scopeArgs(p2).useExcludeSettings).toBe(false);
		expect(scopeArgs(p2).query).toBe('alpha');
		expect(scopeArgs(p2).generation).toBeGreaterThan(scopeArgs(p1).generation);

		const p3 = await clickGearAndWait();
		expect(gear().getAttribute('aria-pressed')).toBe('true');
		expect(scopeArgs(p3).useExcludeSettings).toBe(true);
		expect(scopeArgs(p3).generation).toBeGreaterThan(scopeArgs(p2).generation);
	});

	it('語が空なら欄を変えても歯車を押しても呼ばれない。値は覚えていて、語を入れたときに渡る', async () => {
		mountPanel();

		await fireEvent.input(includeField(), { target: { value: 'docs/**' } });
		await fireEvent.click(gear());
		await new Promise((r) => setTimeout(r, 350));
		await settle();

		expect(searchCalls()).toHaveLength(0);
		expect(includeField().value).toBe('docs/**');
		expect(gear().getAttribute('aria-pressed')).toBe('false');

		const p = await typeAndWait('alpha');
		expect(scopeArgs(p).include).toEqual(['docs/**']);
		expect(scopeArgs(p).useExcludeSettings).toBe(false);
	});

	it('… で 2 欄と歯車が隠れても(aria-expanded=false)値は保たれ、次の検索で渡る。出し直すと値が見える', async () => {
		mountPanel();
		await typeAndWait('alpha');
		await changeFieldAndWait(includeField(), 'docs/**');

		await fireEvent.click(detailsToggle());
		await settle();

		expect(detailsToggle().getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByTestId('find-in-folder-include')).toBeNull();
		expect(screen.queryByTestId('find-in-folder-exclude')).toBeNull();
		expect(screen.queryByTestId('find-in-folder-use-exclude-settings')).toBeNull();
		expect(screen.getByTestId('find-in-folder-input')).toBeTruthy();

		const p = await typeAndWait('alphab');
		expect(scopeArgs(p).include).toEqual(['docs/**']);
		expect(scopeArgs(p).query).toBe('alphab');

		await fireEvent.click(detailsToggle());
		await settle();

		expect(detailsToggle().getAttribute('aria-expanded')).toBe('true');
		expect(includeField().value).toBe('docs/**');
	});

	it('パネルを閉じて開き直しても欄の値・歯車・折りたたみが残る(窓の生存中だけ覚える)', async () => {
		const first = mountPanel();
		await typeAndWait('alpha');
		await changeFieldAndWait(includeField(), 'docs/**, *.md');
		await changeFieldAndWait(excludeField(), '**/*.log');
		await clickGearAndWait();
		expect(gear().getAttribute('aria-pressed')).toBe('false');

		first.unmount();
		await settle();
		expect(screen.queryByTestId('find-in-folder')).toBeNull();

		mountPanel();

		expect(includeField().value).toBe('docs/**, *.md');
		expect(excludeField().value).toBe('**/*.log');
		expect(gear().getAttribute('aria-pressed')).toBe('false');
		expect(detailsToggle().getAttribute('aria-expanded')).toBe('true');

		const p = await typeAndWait('alpha');
		expect(scopeArgs(p).include).toEqual(['docs/**', '*.md']);
		expect(scopeArgs(p).exclude).toEqual(['**/*.log']);
		expect(scopeArgs(p).useExcludeSettings).toBe(false);
	});

	it('折りたたみも開き直しで残る。resetSearchScope で既定(空・ON・出す)に戻る', async () => {
		const first = mountPanel();
		await fireEvent.click(detailsToggle());
		await settle();
		expect(detailsToggle().getAttribute('aria-expanded')).toBe('false');
		first.unmount();
		await settle();

		const second = mountPanel();
		expect(detailsToggle().getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByTestId('find-in-folder-include')).toBeNull();
		second.unmount();
		await settle();

		findInFolderModule.resetSearchScope();
		mountPanel();
		expect(detailsToggle().getAttribute('aria-expanded')).toBe('true');
		expect(includeField().value).toBe('');
		expect(excludeField().value).toBe('');
		expect(gear().getAttribute('aria-pressed')).toBe('true');
	});

	it('localStorage / sessionStorage は空のまま(欄も歯車もブラウザ保存領域に書かない=AC-55-14 と同じ検査)', async () => {
		mountPanel();
		await typeAndWait('alpha');
		await changeFieldAndWait(includeField(), 'docs/**');
		await changeFieldAndWait(excludeField(), '**/*.log');
		await clickGearAndWait();
		await fireEvent.click(detailsToggle());
		await settle();

		expect(Object.keys(localStorage)).toEqual([]);
		expect(Object.keys(sessionStorage)).toEqual([]);
	});

	it('欄を出している間もパネル全体の文言に CJK が無い(要件#51)', async () => {
		mountPanel();
		const p = await typeAndWait('alpha');
		p.resolve(HITS);
		await settle();

		expect(screen.getByTestId('find-in-folder').textContent ?? '').not.toMatch(CJK);
		for (const el of [includeField(), excludeField()]) {
			for (const attr of ['placeholder', 'aria-label', 'title']) {
				expect(el.getAttribute(attr) ?? '').not.toMatch(CJK);
			}
		}
	});
});
