/**
 * 要件#55 追補g の受け入れテスト(docs/requirements/req-55.md「追補g 語を空にしたとき・パネルを
 * 閉じたときも古い走査を止める」= Issue #580 / backlog 210)— フロントの配線(AC-55-50)
 *
 * 発端: 追補d の d-3 は「古い世代」だけを打ち切る。`ResultStore.latest` は新しい検索が来たときだけ
 * 進むので、語を消す・パネルを閉じると、走っている走査は最後まで走る(ssh で数分かかる走査が
 * 接続を圧迫したまま残る)。直し= 追補e の `search_in_folder_reset`(`forget`=結果と最新世代を
 * 捨て、`epoch` を進める)を、語を空にしたときとパネルを閉じたときにも呼ぶ。`epoch` が変わるので
 * 走っている走査は次のファイルの区切りで止まる(追補f f-3)。command は増えない(g-4)。
 *
 * 判定範囲(AC-55-50):
 * - g-1 語を打って検索が走ったあと語を空にすると、`invoke('search_in_folder_reset')` が**その場で**
 *   呼ばれる(debounce を待たない・引数なし・空文字の検索は投げない)。debounce が切れる前に
 *   空にしても同じ。空にするたびに呼ぶ(打ち直すだけでは呼ばない)
 * - g-1 空にしたあと語を打つと、検索は**そのリセットの完了**(resolve / reject どちらでも)を
 *   待ってから投げる(追補e e-2 と同じ順序の守り)。リセットの失敗は状態表示に出さない
 * - g-1 の補足(reviewer P2): マウント時の reset(追補e)がまだ済んでいないうちに語を打って空にしたら、
 *   次の検索は**マウント時の reset と空にしたときの reset の両方**の完了を待つ(空にしたときの reset
 *   だけが済んでも投げない=「空にしたときの reset に差し替える」実装は赤)
 * - g-2 パネルを外す(unmount)と `invoke('search_in_folder_reset')` が呼ばれる。応答は待たない・
 *   失敗は黙って続行(例外を外へ出さない=未処理の reject があれば vitest が落とす)
 * - g-2 の補足(順序の守り): 外したときの reset が pending の間は、開き直したパネルは自分の reset を
 *   投げない。外したときの reset が済む(resolve / reject どちらでも)と開き直したパネルの reset が
 *   投げられ、その検索はその完了の後に来る(閉じた reset → 開いた reset → 検索の順)
 * - g-2 の補足の補足(reviewer P2): 閉じたパネルの**まだ済んでいない reset**(マウント時のもの)も
 *   「閉じたときの reset」に含める。外したときの reset だけが済んでも、閉じたパネルのマウント時の
 *   reset が pending なら開き直したパネルの reset は投げない(`closingReset` を外したときの reset
 *   だけに差し替える実装は赤)
 * - (2)(3) Rust 側は `src-tauri/tests/acceptance_req55g.rs`(AC-55-51〜52)
 *
 * ## 配線に求める契約(implementer はこれに従う)
 * - 検索欄が空になった(input イベントで value が `''`)ら、`invoke(SEARCH_IN_FOLDER_RESET_COMMAND)` を
 *   timer を挟まずに呼ぶ(`schedule('')` の経路で直接)。引数は渡さない(渡すなら空オブジェクトまで)
 * - その後の `search_in_folder` は、その reset の完了を待ってから投げる(追補e の `resetDone` に
 *   その promise(失敗も resolve に畳む)を**合流させる**=まだ済んでいないマウント時の reset も
 *   待つ。差し替えにしない)。待つ間に語が変わった世代は投げない(既存)
 * - `onDestroy` で `invoke(SEARCH_IN_FOLDER_RESET_COMMAND)` を呼ぶ。await しない・reject は握りつぶす
 * - 外したときの reset の promise(失敗も resolve に畳む)を、そのパネルのまだ済んでいない reset
 *   (`resetDone`)と合流させてモジュールの変数に持ち、次にマウントしたパネルはそれを await してから
 *   自分の reset を投げる(g-2 の補足)。自分の reset の完了を待ってから最初の検索を投げる
 *   (追補e e-2)のは従来どおり
 * - g-4 不変: 世代の規則(`SearchSession`)・invoke の引数名・Show more(語が空でないときの保持)・
 *   既存の配線テストは無改変で緑(`FindInFolder.wiring.test.ts` の invoke モックは未知の command に
 *   `null` を返すので、増えた reset は即 resolve 扱い)
 *
 * ## スタブの設計(FindInFolder.reset.wiring.test.ts と同じ)
 * - $lib/ipc: `search_in_folder_reset` はテストから手で resolve / reject できる deferred(呼ばれた
 *   順に `resets[]`。`resets[0]` はマウント時のもの=追補e)。`search_in_folder` は呼ばれた引数を
 *   記録して pending のまま(応答は本テストの判定に不要)
 * - $lib/events: listen は noop の unlisten を返す(progress / done は本テストの対象外)
 * - afterEach: `cleanup()` の unmount でも reset が飛ぶ(g-2)。その deferred を残すと次のケースのパネルが
 *   「前のパネルの閉じた reset の完了」を待ち続ける(g-2 の補足)ので、残った reset を全部 resolve して
 *   からモックを消す
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

/** reset の引数は無し(undefined)か、渡すなら空オブジェクトまで(窓ラベルなどをフロントから渡さない)。 */
function expectNoArgs(call: unknown[]) {
	const args = call[1];
	expect(args === undefined || Object.keys(args as object).length === 0).toBe(true);
}

const input = () => screen.getByTestId('find-in-folder-input') as HTMLInputElement;
const status = () => screen.getByTestId('find-in-folder-status');

/** マイクロタスクと Svelte の tick だけ流す(timer は進めない=「待ち時間を置かずに」の判定に使う)。 */
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

/** `index` 番目の reset を終わらせる(成功)。resolve 後のマイクロタスクまで流す。 */
async function finishReset(index: number) {
	const d = resets[index];
	expect(d, `reset #${index}`).toBeTruthy();
	d.resolve(null);
	await settle();
}

/** `index` 番目の reset を失敗で終わらせる。 */
async function failReset(index: number) {
	const d = resets[index];
	expect(d, `reset #${index}`).toBeTruthy();
	d.reject(new Error('reset failed (test)'));
	await settle();
}

/** マウントして、マウント時の reset(追補e・`resets[0]`)を済ませる。以降の reset は追補g のもの。 */
async function openPanel() {
	const panel = mountPanel();
	await waitFor(() => expect(resetCalls().length).toBe(1));
	await finishReset(0);
	return panel;
}

/** 語を打って、`search_in_folder` が `count` 件になるまで待つ(debounce を実時間で待つ)。 */
async function searchFor(value: string, count: number) {
	await typeQuery(value);
	await waitFor(() => expect(searchCalls().length).toBe(count), { timeout: 1500 });
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
	// g-2: cleanup の unmount でも reset が飛ぶ。残った deferred を終わらせ、次のケースのパネルが
	// 「前のパネルの閉じた reset」を待ち続けないようにする(g-2 の補足)。
	for (const d of resets) d.resolve(null);
	vi.clearAllMocks();
});

describe('要件#55 追補g・AC-55-50 (g-1): 語を空にしたら search_in_folder_reset を呼び、次の検索はその完了を待つ', () => {
	it('語を打って検索が走ったあと語を空にすると、reset がその場で invoke される(debounce を待たない・引数なし・検索は投げない)', async () => {
		await openPanel();
		await searchFor('alpha', 1);
		expect(resetCalls().length, 'precondition: only the mount-time reset so far').toBe(1);

		await typeQuery('');
		// timer は進めない: マイクロタスクだけ流して「その場で」呼ばれたことを見る。
		await settle();
		expect(resetCalls().length, 'clearing the query must reset right away').toBe(2);
		expectNoArgs(resetCalls()[1]);
		expect(searchCalls().length, 'an empty query is never searched').toBe(1);

		// debounce が切れても、空文字の検索は投げず、reset も重ねない。
		await sleep(QUIET_MS);
		expect(searchCalls().length).toBe(1);
		expect(resetCalls().length).toBe(2);
	});

	it('debounce が切れる前に空にしても reset を呼ぶ・空にする前の語の検索は投げない', async () => {
		await openPanel();
		await typeQuery('alpha');
		await typeQuery('');
		await settle();
		expect(resetCalls().length, 'clearing while the debounce is pending still resets').toBe(2);
		expectNoArgs(resetCalls()[1]);

		await sleep(QUIET_MS);
		expect(searchCalls().length, 'the cleared query is never sent').toBe(0);
		expect(resetCalls().length).toBe(2);
	});

	it('空にしたあと語を打つと、検索はそのリセットの完了を待ってから投げられる(e-2 と同じ順序の守り)', async () => {
		await openPanel();
		await searchFor('alpha', 1);
		const firstGeneration = lastSearchArgs().generation;

		await typeQuery('');
		await settle();
		expect(resetCalls().length).toBe(2);

		await typeQuery('beta');
		// debounce の上限より長く待っても、空にしたときの reset が pending の間は検索が来ない。
		await sleep(QUIET_MS);
		expect(searchCalls().length, 'the search after clearing must wait for that reset').toBe(1);

		await finishReset(1);
		await waitFor(() => expect(searchCalls().length).toBe(2), { timeout: 1500 });

		const args = lastSearchArgs();
		expect(args.root).toBe(ROOT);
		expect(args.query).toBe('beta');
		// g-4: 同じパネルなので世代は 1 から振り直さず、前の検索より進む。
		expect(args.generation).toBeGreaterThan(firstGeneration);

		// 並び: 空にしたときの reset → その後の search。打ち直しで reset は呼び直さない。
		const names = calls().map((c) => c[0]);
		expect(names.lastIndexOf(SEARCH)).toBeGreaterThan(names.lastIndexOf(RESET));
		expect(resetCalls().length, 'typing a new query does not reset').toBe(2);
	});

	it('空にしたあとのリセットが reject しても黙って続行する: 次の検索は投げる・状態表示に失敗を出さない', async () => {
		await openPanel();
		await searchFor('alpha', 1);

		await typeQuery('');
		await settle();
		expect(resetCalls().length).toBe(2);

		await typeQuery('beta');
		await sleep(QUIET_MS);
		expect(searchCalls().length).toBe(1);

		await failReset(1);
		await waitFor(() => expect(searchCalls().length).toBe(2), { timeout: 1500 });
		expect(lastSearchArgs().query).toBe('beta');

		// 失敗は状態表示に出さない: 検索中(応答待ち)の表示のまま。`Search failed` 等にしない。
		const text = status().textContent ?? '';
		expect(text).not.toMatch(/fail|error|reset/i);
	});

	it('空にしたあとのリセットが打鍵前に reject しても、状態表示は空のまま・次の検索は待たずに投げる', async () => {
		await openPanel();
		await searchFor('alpha', 1);

		await typeQuery('');
		await settle();
		await failReset(1);
		await sleep(50);

		expect((status().textContent ?? '').trim()).toBe('');
		expect(screen.getByTestId('find-in-folder')).toBeTruthy();
		expect(searchCalls().length).toBe(1);

		// reset は(失敗で)済んでいるので、次の検索は debounce だけで投げられる。
		await searchFor('beta', 2);
		expect(lastSearchArgs().query).toBe('beta');
		expect(status().textContent ?? '').not.toMatch(/fail|error|reset/i);
	});

	it('空にするたびに reset を呼ぶ(打ち直して再び空にすれば、もう 1 回)', async () => {
		await openPanel();
		await searchFor('alpha', 1);

		await typeQuery('');
		await settle();
		expect(resetCalls().length).toBe(2);
		await finishReset(1);

		await searchFor('beta', 2);
		expect(resetCalls().length, 'typing again does not reset').toBe(2);

		await typeQuery('');
		await settle();
		expect(resetCalls().length, 'the second clear resets again').toBe(3);
		expectNoArgs(resetCalls()[2]);
		expect(searchCalls().length).toBe(2);
	});

	it('マウント時の reset が済む前に語を打って空にし、空にしたときの reset だけが済んでも検索は投げられない。マウント時の reset が済むと投げられる(両方の完了を待つ)', async () => {
		// マウント時の reset(追補e・`resets[0]`)は済ませない(openPanel は使わない)。
		mountPanel();
		await waitFor(() => expect(resetCalls().length).toBe(1));

		// 語を打つ。マウント時の reset が pending なので検索はまだ来ない(e-2)。
		await typeQuery('alpha');
		await sleep(QUIET_MS);
		expect(searchCalls().length, 'precondition: the mount-time reset is still pending').toBe(0);

		// 空にする → 空にしたときの reset(`resets[1]`)がその場で飛ぶ。
		await typeQuery('');
		await settle();
		expect(resetCalls().length).toBe(2);
		expectNoArgs(resetCalls()[1]);

		// 空にしたときの reset だけを済ませる。マウント時の reset はまだ pending。
		await finishReset(1);

		// 語を打ち直しても、マウント時の reset が済むまで検索は投げられない
		// (空にしたときの reset に差し替える実装は、ここで検索が飛んで赤)。
		await typeQuery('beta');
		await sleep(QUIET_MS);
		expect(
			searchCalls().length,
			'the search must also wait for the still-pending mount-time reset'
		).toBe(0);

		// マウント時の reset が済む → 検索が投げられる。空にする前の語(alpha)は世代が古いので投げない。
		await finishReset(0);
		await waitFor(() => expect(searchCalls().length).toBe(1), { timeout: 1500 });
		await sleep(50);
		expect(searchCalls().length, 'the cleared word (alpha) is never sent').toBe(1);
		const args = lastSearchArgs();
		expect(args.root).toBe(ROOT);
		expect(args.query).toBe('beta');

		// 並び: マウント時の reset → 空にしたときの reset → 検索。打ち直しで reset は増えない。
		const names = calls().map((c) => c[0]);
		expect(names.lastIndexOf(SEARCH)).toBeGreaterThan(names.lastIndexOf(RESET));
		expect(resetCalls().length, 'typing a new query does not reset').toBe(2);
	});
});

describe('要件#55 追補g・AC-55-50 (g-2): パネルを外すと search_in_folder_reset を呼ぶ(応答は待たない・失敗は黙って続行)', () => {
	it('語を打って検索が走ったあとパネルを外す(unmount)と、reset がその場で invoke される(引数なし・応答は待たない)', async () => {
		const panel = await openPanel();
		await searchFor('alpha', 1);
		expect(resetCalls().length).toBe(1);

		panel.unmount();
		await settle();
		expect(screen.queryByTestId('find-in-folder')).toBeNull();
		expect(resetCalls().length, 'unmounting the panel must reset').toBe(2);
		expectNoArgs(resetCalls()[1]);
		// 応答は待たない: この reset は resolve しないまま(pending)で、外れ終わっている。
		expect(searchCalls().length).toBe(1);
	});

	it('マウントしただけで外しても reset を呼ぶ(マウント時の 1 回 + 外したときの 1 回)', async () => {
		const panel = await openPanel();
		expect(resetCalls().length).toBe(1);

		panel.unmount();
		await settle();
		expect(resetCalls().length).toBe(2);
		expectNoArgs(resetCalls()[1]);
		expect(searchCalls().length).toBe(0);
	});

	it('外したときの reset が reject しても黙って続行する(例外を外へ出さない)', async () => {
		const panel = await openPanel();
		await searchFor('alpha', 1);

		panel.unmount();
		await settle();
		expect(resetCalls().length).toBe(2);

		// 未処理の reject が残れば vitest が "Unhandled Rejection" として落とす(=握りつぶす契約)。
		await failReset(1);
		await sleep(20);
		expect(resetCalls().length).toBe(2);
		expect(searchCalls().length).toBe(1);
	});
});

describe('要件#55 追補g・AC-55-50 (g-2 の補足): 開き直したパネルの reset は、外したときの reset の完了を待ってから投げる', () => {
	/**
	 * 検索 → 外す → すぐ開き直して打つ。外したときの reset(`resets[1]`)を `finishClosingReset` で
	 * 終わらせ、開き直したパネルの reset(`resets[2]`)→ 検索(世代 1)の順を見る。
	 */
	async function reopenAndSearch(finishClosingReset: (index: number) => Promise<void>) {
		const first = await openPanel();
		await searchFor('alpha', 1);
		first.unmount();
		await settle();
		expect(resetCalls().length, 'closing the panel resets (g-2)').toBe(2);
		const callsBeforeReopen = calls().length;

		// 開き直して、すぐ打つ。外したときの reset が pending の間は、自分の reset も検索も投げない。
		mountPanel();
		await typeQuery('beta');
		await sleep(QUIET_MS);
		expect(resetCalls().length, 'the reopened panel must wait for the closing reset before its own').toBe(2);
		expect(searchCalls().length).toBe(1);

		// 外したときの reset が済む → 開き直したパネルの reset が投げられる。検索はまだ(自分の reset を待つ=e-2)。
		await finishClosingReset(1);
		await waitFor(() => expect(resetCalls().length).toBe(3));
		expectNoArgs(resetCalls()[2]);
		await sleep(QUIET_MS);
		expect(searchCalls().length, "the search waits for the reopened panel's own reset").toBe(1);

		// 開き直したパネルの reset が済む → 検索(世代 1)が来る。
		await finishReset(2);
		await waitFor(() => expect(searchCalls().length).toBe(2), { timeout: 1500 });
		const reopened = lastSearchArgs();
		expect(reopened.root).toBe(ROOT);
		expect(reopened.query).toBe('beta');
		expect(reopened.generation, 'SearchSession restarts at 1 per panel (AC-55-13)').toBe(1);

		// 開き直し以降の並び: 開き直したパネルの reset(1 回だけ)→ 検索。失敗は状態表示に出さない。
		const afterReopen = calls().slice(callsBeforeReopen).map((c) => c[0]);
		expect(afterReopen.filter((name) => name === RESET).length).toBe(1);
		expect(afterReopen.indexOf(SEARCH)).toBeGreaterThan(afterReopen.indexOf(RESET));
		expect(status().textContent ?? '').not.toMatch(/fail|error|reset/i);
	}

	it('外したときの reset が pending の間は開き直したパネルの reset が投げられない。resolve すると投げられ、検索はその完了の後に来る', async () => {
		await reopenAndSearch(finishReset);
	});

	it('外したときの reset が reject しても同じ: 開き直したパネルの reset が投げられ、検索はその完了の後に来る', async () => {
		await reopenAndSearch(failReset);
	});

	it('マウント時の reset が済む前にパネルを外し、外したときの reset だけが済んでも開き直したパネルの reset は投げられない。マウント時の reset が済むと投げられる(閉じたパネルの未完の reset も待つ)', async () => {
		// 最初のパネル: マウント時の reset(`resets[0]`)を済ませないまま外す。
		const first = mountPanel();
		await waitFor(() => expect(resetCalls().length).toBe(1));
		first.unmount();
		await settle();
		expect(screen.queryByTestId('find-in-folder')).toBeNull();
		expect(resetCalls().length, 'closing the panel resets (g-2)').toBe(2);
		expectNoArgs(resetCalls()[1]);

		// 外したときの reset(`resets[1]`)だけを済ませる。閉じたパネルのマウント時の reset はまだ pending。
		await finishReset(1);
		const callsBeforeReopen = calls().length;

		// 開き直して、すぐ打つ。閉じたパネルのマウント時の reset が pending の間は、自分の reset も
		// 検索も投げない(`closingReset` を外したときの reset だけにする実装は、ここで reset が飛んで赤)。
		mountPanel();
		await typeQuery('beta');
		await sleep(QUIET_MS);
		expect(
			resetCalls().length,
			"the reopened panel must also wait for the closed panel's still-pending mount-time reset"
		).toBe(2);
		expect(searchCalls().length).toBe(0);

		// 閉じたパネルのマウント時の reset が済む → 開き直したパネルの reset(`resets[2]`)が投げられる。
		// 検索はまだ(自分の reset を待つ=e-2)。
		await finishReset(0);
		await waitFor(() => expect(resetCalls().length).toBe(3));
		expectNoArgs(resetCalls()[2]);
		await sleep(QUIET_MS);
		expect(searchCalls().length, "the search waits for the reopened panel's own reset").toBe(0);

		// 開き直したパネルの reset が済む → 検索(世代 1)が来る。
		await finishReset(2);
		await waitFor(() => expect(searchCalls().length).toBe(1), { timeout: 1500 });
		const reopened = lastSearchArgs();
		expect(reopened.root).toBe(ROOT);
		expect(reopened.query).toBe('beta');
		expect(reopened.generation, 'SearchSession restarts at 1 per panel (AC-55-13)').toBe(1);

		// 開き直し以降の並び: 開き直したパネルの reset(1 回だけ)→ 検索。失敗は状態表示に出さない。
		const afterReopen = calls().slice(callsBeforeReopen).map((c) => c[0]);
		expect(afterReopen.filter((name) => name === RESET).length).toBe(1);
		expect(afterReopen.indexOf(SEARCH)).toBeGreaterThan(afterReopen.indexOf(RESET));
		expect(status().textContent ?? '').not.toMatch(/fail|error|reset/i);
	});
});
