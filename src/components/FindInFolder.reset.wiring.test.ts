/**
 * 要件#55 追補e の受け入れテスト(docs/requirements/req-55.md「追補e 検索パネルを開き直しても
 * 検索できる」= backlog 216)— フロントの配線(AC-55-43)
 *
 * 発端: 3 回以上検索 → Close → Command + Shift + F で開き直す → 何を探しても `No results`。
 * `SearchSession` はマウントごとに世代を 1 から振り直すのに、Rust の `ResultStore` は窓の
 * 最新世代を持ち続けるため。直し= パネルを開いたら Rust 側の状態を捨てる command
 * `search_in_folder_reset` を呼び、それが終わるまで最初の検索を投げない(e-2)。
 *
 * 判定範囲(AC-55-43):
 * - マウントしただけで `invoke('search_in_folder_reset')` が 1 回呼ばれる(打鍵は不要・引数なし)
 * - reset が終わる前に打っても `search_in_folder` は投げない。reset が resolve したら投げる
 *   (= 順序の逆転を防ぐ: reset が検索の後に届いて走り出した世代を消さない)
 * - reset が reject しても黙って続行: 検索は投げる・状態表示に失敗を出さない
 * - 開き直し(unmount → 再 mount)のたびに reset を呼び直し、その窓の最初の検索(世代 1)は
 *   reset の後に来る。打鍵を重ねても reset は 1 マウントにつき 1 回
 * - e-3 不変: 世代は 1 から・invoke の引数名はそのまま
 *
 * ## 配線に求める契約(implementer はこれに従う)
 * - `FindInFolder.svelte` はマウント時に `invoke('search_in_folder_reset')` を 1 回呼ぶ
 *   (引数は渡さない。渡すなら空オブジェクトまで)
 * - `search_in_folder` の invoke は reset の完了(resolve / reject どちらでも)を待ってから
 *   投げる。待ち方は自由(reset の promise を保持して検索の前に await する、など)
 * - reset の失敗は状態表示(`find-in-folder-status`)に出さない・例外を外へ出さない
 * - 既存の配線テスト(FindInFolder.wiring.test.ts)は無改変で緑のまま。そちらの invoke モックは
 *   未知の command に `null` を返すので、reset は即 resolve 扱いになり既存ケースの順序は変わらない
 *
 * ## スタブの設計
 * - $lib/ipc: `search_in_folder_reset` はテストから手で resolve / reject できる deferred。
 *   `search_in_folder` は呼ばれた引数を記録して pending のまま(応答は本テストの判定に不要)
 * - $lib/events: listen は noop の unlisten を返す(progress / done は本テストの対象外)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({
	listen: vi.fn(async () => () => {}),
}));
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

import { invoke } from '$lib/ipc';
import FindInFolder from './FindInFolder.svelte';

const invokeMock = vi.mocked(invoke);

const RESET = 'search_in_folder_reset';
const SEARCH = 'search_in_folder';
const ROOT = 'file:///Users/x/notes';

/** 既存の配線テストが実時間で待つ debounce の上限(契約: 300ms 以下)。これより長く待って「来ない」を見る。 */
const DEBOUNCE_CEILING_MS = 300;
const QUIET_MS = DEBOUNCE_CEILING_MS + 150;

type Deferred = { resolve: (v?: unknown) => void; reject: (e: unknown) => void };
let resets: Deferred[] = [];

function installInvoke() {
	resets = [];
	invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === RESET) {
			return await new Promise((resolve, reject) => {
				resets.push({ resolve, reject });
			});
		}
		if (cmd === SEARCH) {
			// 応答は本テストの判定に不要: pending のまま(呼ばれた順と引数だけ見る)。
			void args;
			return await new Promise(() => {});
		}
		if (cmd === 'open_document' || cmd === 'open_binary_document') {
			return { uri: args?.uri, content: '', modified: null };
		}
		return null;
	});
}

const calls = () => invokeMock.mock.calls;
const resetCalls = () => calls().filter((c) => c[0] === RESET);
const searchCalls = () => calls().filter((c) => c[0] === SEARCH);

/** 直近の search の引数(camelCase の 3 つ + 追補の欄)。 */
function lastSearchArgs(): { root: string; query: string; generation: number } {
	const last = searchCalls().at(-1);
	expect(last, 'a search_in_folder call').toBeTruthy();
	return (last as unknown[])[1] as { root: string; query: string; generation: number };
}

const input = () => screen.getByTestId('find-in-folder-input') as HTMLInputElement;
const status = () => screen.getByTestId('find-in-folder-status');

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mountPanel() {
	const onOpen = vi.fn((_uri: string, _query: string, _index: number) => {});
	const onClose = vi.fn(() => {});
	const utils = render(FindInFolder, { props: { rootUri: ROOT, onOpen, onClose } });
	return { onOpen, onClose, ...utils };
}

async function typeQuery(value: string) {
	await fireEvent.input(input(), { target: { value } });
}

/** 直近の reset を終わらせる(成功)。resolve 後のマイクロタスクまで流す。 */
async function finishReset(index = resets.length - 1) {
	const d = resets[index];
	expect(d, `reset #${index}`).toBeTruthy();
	d.resolve(null);
	await settle();
}

/** 直近の reset を失敗で終わらせる。 */
async function failReset(index = resets.length - 1) {
	const d = resets[index];
	expect(d, `reset #${index}`).toBeTruthy();
	d.reject(new Error('reset failed (test)'));
	await settle();
}

beforeEach(() => {
	installInvoke();
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

describe('要件#55 追補e・AC-55-43: パネルを開いたら search_in_folder_reset を呼び、最初の検索はその完了を待つ(e-1 の呼び出し・e-2)', () => {
	it('マウントしただけで search_in_folder_reset が 1 回 invoke される(打鍵なし・引数なし)', async () => {
		mountPanel();
		await waitFor(() => expect(resetCalls().length).toBe(1));
		await settle();

		expect(resetCalls().length).toBe(1);
		const args = resetCalls()[0][1];
		// 引数なし(undefined)か、渡すなら空オブジェクトまで。窓ラベルなどをフロントから渡さない。
		expect(args === undefined || Object.keys(args as object).length === 0).toBe(true);
		// マウントだけでは検索は投げない(語が無い)。
		expect(searchCalls().length).toBe(0);
	});

	it('reset が終わる前に打っても search_in_folder は投げない・reset が resolve したら投げる', async () => {
		mountPanel();
		await waitFor(() => expect(resetCalls().length).toBe(1));

		await typeQuery('alpha');
		// debounce の上限より長く待っても、reset が pending の間は検索が来ない。
		await sleep(QUIET_MS);
		expect(searchCalls().length, 'search must wait for the reset to finish').toBe(0);

		await finishReset();
		await waitFor(() => expect(searchCalls().length).toBe(1), { timeout: 1500 });

		const args = lastSearchArgs();
		expect(args.root).toBe(ROOT);
		expect(args.query).toBe('alpha');
		expect(args.generation).toBe(1);
		// reset は 1 回のまま(打鍵で呼び直さない)。
		expect(resetCalls().length).toBe(1);
	});

	it('reset の呼び出しは、同じ窓の最初の search_in_folder より前に並ぶ', async () => {
		mountPanel();
		await waitFor(() => expect(resetCalls().length).toBe(1));
		await finishReset();

		await typeQuery('alpha');
		await waitFor(() => expect(searchCalls().length).toBe(1), { timeout: 1500 });

		const names = calls().map((c) => c[0]);
		const resetAt = names.indexOf(RESET);
		const searchAt = names.indexOf(SEARCH);
		expect(resetAt).toBeGreaterThanOrEqual(0);
		expect(searchAt).toBeGreaterThan(resetAt);
	});

	it('reset が reject しても黙って続行する: 検索は投げる・状態表示に失敗を出さない', async () => {
		mountPanel();
		await waitFor(() => expect(resetCalls().length).toBe(1));

		await typeQuery('alpha');
		await sleep(QUIET_MS);
		expect(searchCalls().length).toBe(0);

		await failReset();
		await waitFor(() => expect(searchCalls().length).toBe(1), { timeout: 1500 });
		expect(lastSearchArgs().query).toBe('alpha');
		expect(lastSearchArgs().generation).toBe(1);

		// 失敗は状態表示に出さない: 検索中(応答待ち)の表示のまま。`Search failed` 等にしない。
		const text = status().textContent ?? '';
		expect(text).not.toMatch(/fail|error|reset/i);
	});

	it('reset が reject しても打鍵前なら状態表示は空のまま(失敗を見せない・例外を外へ出さない)', async () => {
		mountPanel();
		await waitFor(() => expect(resetCalls().length).toBe(1));
		await failReset();
		await sleep(50);

		expect((status().textContent ?? '').trim()).toBe('');
		expect(searchCalls().length).toBe(0);
		expect(screen.getByTestId('find-in-folder')).toBeTruthy();
	});

	it('reset を待っている間に打ち替えても、reset 完了後に最新の語が投げられ、世代は投げる順に増える', async () => {
		mountPanel();
		await waitFor(() => expect(resetCalls().length).toBe(1));

		await typeQuery('alp');
		await sleep(QUIET_MS);
		await typeQuery('alpha');
		await sleep(QUIET_MS);
		expect(searchCalls().length).toBe(0);

		await finishReset();
		await waitFor(() => expect(searchCalls().length).toBeGreaterThanOrEqual(1), { timeout: 1500 });
		await sleep(QUIET_MS);

		// 古い語('alp')を投げるかどうかは実装の自由(Rust 側は新しい世代で止める)。
		// 最新の語('alpha')は必ず最後に投げられていること。
		const queries = searchCalls().map((c) => (c[1] as { query: string }).query);
		expect(queries.at(-1)).toBe('alpha');
		expect(queries.filter((q) => q === 'alpha').length).toBe(1);
		// 世代は投げる順に単調増加(e-3: SearchSession の規則は不変)。
		const generations = searchCalls().map((c) => (c[1] as { generation: number }).generation);
		for (let i = 1; i < generations.length; i++) expect(generations[i]).toBeGreaterThan(generations[i - 1]);
		expect(resetCalls().length).toBe(1);
	});

	it('開き直し(unmount → mount)のたびに reset を呼び直し、2 回目の窓の世代 1 の検索は 2 回目の reset の後に来る', async () => {
		// 1 回目: 3 回以上検索して閉じる(backlog 216 の再現手順)。
		const first = mountPanel();
		await waitFor(() => expect(resetCalls().length).toBe(1));
		await finishReset(0);
		for (const q of ['a', 'ab', 'abc']) {
			await typeQuery(q);
			await sleep(QUIET_MS);
		}
		await waitFor(() => expect(searchCalls().length).toBe(3), { timeout: 1500 });
		expect(lastSearchArgs().generation).toBe(3);
		first.unmount();
		const callsBeforeReopen = calls().length;

		// 2 回目: 開き直す。
		mountPanel();
		await waitFor(() => expect(resetCalls().length).toBe(2));
		await typeQuery('alpha');
		await sleep(QUIET_MS);
		expect(searchCalls().length, 'the reopened panel waits for its own reset').toBe(3);

		await finishReset(1);
		await waitFor(() => expect(searchCalls().length).toBe(4), { timeout: 1500 });

		const reopened = lastSearchArgs();
		expect(reopened.query).toBe('alpha');
		expect(reopened.generation, 'SearchSession restarts at 1 per panel (AC-55-13)').toBe(1);

		const afterReopen = calls().slice(callsBeforeReopen).map((c) => c[0]);
		expect(afterReopen.indexOf(RESET)).toBeGreaterThanOrEqual(0);
		expect(afterReopen.indexOf(SEARCH)).toBeGreaterThan(afterReopen.indexOf(RESET));
	});

	it('reset が済んだ後の 2 回目以降の検索は待たずに投げる(reset は 1 マウントにつき 1 回・毎回の打鍵で呼ばない)', async () => {
		mountPanel();
		await waitFor(() => expect(resetCalls().length).toBe(1));
		await finishReset();

		await typeQuery('alpha');
		await waitFor(() => expect(searchCalls().length).toBe(1), { timeout: 1500 });
		await typeQuery('alphab');
		await waitFor(() => expect(searchCalls().length).toBe(2), { timeout: 1500 });

		expect(resetCalls().length).toBe(1);
		expect(lastSearchArgs().generation).toBe(2);
	});
});
