/**
 * 要件#71 追補a(2)・AC-71-8 の受け入れテスト(docs/requirements/req-71.md・backlog 280)—
 * マーク一覧(`MarkList.svelte`)の Resolve / Delete の失敗の配線
 * (component プロジェクト・JSDOM にマウントする)
 *
 * 「ファイルやフォルダを開けなかったときは利用者に知らせ、いま開いている文書の表示と
 * 変更追従を保つ」の範囲を広げ、マーク一覧の Resolve(`marksStore.update`)と
 * Delete(`marksStore.remove`)が失敗したら **alert で知らせ、一覧は変えず、
 * Unhandled Promise Rejection を漏らさない**。開く経路の同種の配線は
 * src/components/open-failure.wiring.test.ts(家風はそれに合わせる)。
 *
 * 判定範囲(AC-71-8):
 * - Resolve が失敗(`update_mark` が reject)→ `alert` が `Could not resolve the mark: <理由>` で **1 回**
 * - Delete が失敗(`remove_mark` が reject)→ `alert` が `Could not delete the mark: <理由>` で **1 回**
 * - どちらも一覧(`marksStore.all` と表示中の行)は変わらない・unhandledRejection が出ない
 * - 成功時は従来どおり(alert なし・Resolve で status が resolved に・Delete で行が消える・
 *   confirm で取り消せば何もしない)
 *
 * ## 配線に求める契約(implementer はこれに従う)
 * - `<理由>` は reject された値をそのまま `${err}` で挟む(Rust の `Err(String)` の素通し=要件51)。
 *   既存の `Could not add the mark: ${err}`(+page.svelte)・`Could not export the inbox: ${err}`
 *   (MarkList.svelte の generateInbox)と同じ形。文言関数を `$lib` に置くかは実装に任せる
 *   (置いても本テストは alert に渡った **値** で判定する)
 * - 失敗の catch は `MarkList.svelte` の `resolve` / `remove` の中で行い、`alert` は 1 回だけ。
 *   `marksStore.update` / `marksStore.remove` は失敗時に `all` を変えない(現状どおり=await の後で
 *   代入しているので、reject すれば触らない)。`confirm` の流れ・成功時の挙動は従来どおり
 *
 * ## 判定しないもの
 * - 実機の alert の見え方 → 人間ゲート(req-71.md)
 *
 * ## スタブの設計(open-failure.wiring の家風)
 * - $lib/ipc: モジュールモック。各テストが `installInvoke` で失敗させる command を選ぶ。
 *   reject の値は Rust に倣って **文字列**(`Err(String)`)。`list_marks` はフィクスチャの 2 件を返す
 * - `alert` / `confirm` は `vi.stubGlobal`(jsdom の両者は Not implemented)。
 *   unhandledRejection は `process.on` で拾って空であることを見る(vitest 自身も unhandled があると
 *   実行を失敗にする=二重の網)
 * - `marksStore` は窓ごとの singleton。各テストの前に `clear()` して、マウント時の `refresh` で
 *   フィクスチャを読み直させる
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import type { Mark } from '$lib/annotation';
import MarkList from './MarkList.svelte';
import { marksStore } from '../stores/marks.svelte';

const invokeMock = vi.mocked(invoke);

/** CJK を含まない=英語の判定(要件#51 の走査と同じ考え方)。 */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

// ---------------------------------------------------------------------------
// 失敗の理由(Rust の Err(String) の素通し)と、期待する文言
// ---------------------------------------------------------------------------

const RESOLVE_REASON = 'I/O error: Permission denied (os error 13): .vellis/marks.json';
const DELETE_REASON = 'mark not found: m-2';

const RESOLVE_MESSAGE = `Could not resolve the mark: ${RESOLVE_REASON}`;
const DELETE_MESSAGE = `Could not delete the mark: ${DELETE_REASON}`;

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const ROOT = 'file:///Users/x/notes';

function mark(id: string, instruction: string, status: Mark['status'] = 'open'): Mark {
	return {
		id,
		file: 'a.md',
		anchor: {
			start_line: 3,
			end_line: 4,
			start_offset: 0,
			end_offset: 10,
			selected_text: 'alpha',
			selected_markdown: 'alpha',
			heading_path: ['A'],
			context_before: '',
			context_after: '',
			file_hash: 'deadbeef',
		},
		instruction,
		status,
		created_at: '2026-10-05T00:00:00Z',
		updated_at: '2026-10-05T00:00:00Z',
		schema_version: 1,
	};
}

const M1 = mark('m-1', 'Tighten the intro paragraph');
const M2 = mark('m-2', 'Add an example to section two');
const MARKS: Mark[] = [M1, M2];

type FailingCommands = Partial<Record<'update_mark' | 'remove_mark' | 'list_marks', string>>;

/**
 * invoke のモック。`failing` に挙げた command は **その文字列で reject** する(Rust の Err(String))。
 * それ以外: list_marks はフィクスチャ・update_mark は patch を当てた Mark・remove_mark は undefined・他は null。
 */
function installInvoke(failing: FailingCommands = {}) {
	invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		const reason = (failing as Record<string, string | undefined>)[cmd];
		if (reason !== undefined) throw reason;
		if (cmd === 'list_marks') return MARKS.map((m) => ({ ...m, anchor: { ...m.anchor } }));
		if (cmd === 'update_mark') {
			const a = args as { id: string; patch: Partial<Mark> };
			const base = MARKS.find((m) => m.id === a.id);
			if (!base) throw `mark not found: ${a.id}`;
			return { ...base, ...a.patch, updated_at: '2026-10-05T00:00:01Z' };
		}
		if (cmd === 'remove_mark') return undefined;
		return null;
	});
}

const callsOf = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd);

/** 非同期のクリック処理(confirm → invoke → catch → alert)を流しきり、unhandledRejection の検出点も越える。 */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
	await flushAsync();
	await flushAsync();
}

const alertMock = vi.fn((_message?: unknown) => {});
const confirmMock = vi.fn((_message?: unknown) => true);

/** Unhandled Promise Rejection を出さない(AC-71-8)。 */
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
	unhandled.push(reason);
};

beforeAll(() => {
	process.on('unhandledRejection', onUnhandled);
});

afterAll(() => {
	process.off('unhandledRejection', onUnhandled);
});

beforeEach(() => {
	installInvoke();
	unhandled.length = 0;
	alertMock.mockClear();
	confirmMock.mockClear();
	confirmMock.mockReturnValue(true);
	vi.stubGlobal('alert', alertMock);
	vi.stubGlobal('confirm', confirmMock);
	marksStore.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	marksStore.clear();
});

/** 一覧をマウントし、`list_marks` でフィクスチャ 2 件が並ぶまで待つ。 */
async function mountMarkList() {
	const onSelect = vi.fn((_m: Mark) => {});
	const onClose = vi.fn(() => {});
	const utils = render(MarkList, { props: { rootUri: ROOT, onSelect, onClose } });
	await waitFor(() => expect(callsOf('list_marks').length).toBe(1), { timeout: 1500 });
	await waitFor(() => expect(rows().length).toBe(2), { timeout: 1500 });
	expect(marksStore.all.map((m) => m.id)).toEqual(['m-1', 'm-2']);
	return { ...utils, onSelect, onClose };
}

/** 一覧の行(`<li>`)。 */
const rows = () => Array.from(document.querySelectorAll('aside.mark-list li')) as HTMLElement[];
/** `id` のマークの行。instruction の冒頭で特定する。 */
function rowOf(m: Mark): HTMLElement {
	const li = rows().find((el) => el.textContent?.includes(m.instruction));
	if (!li) throw new Error(`row for ${m.id} not rendered`);
	return li;
}
const resolveButton = (m: Mark) => within(rowOf(m)).getByRole('button', { name: 'Resolve' });
const deleteButton = (m: Mark) => within(rowOf(m)).getByRole('button', { name: 'Delete' });

/** 一覧がフィクスチャのまま(store も DOM も)。 */
function expectListUnchanged() {
	expect(marksStore.all.map((m) => [m.id, m.status])).toEqual([
		['m-1', 'open'],
		['m-2', 'open'],
	]);
	expect(rows()).toHaveLength(2);
	for (const m of MARKS) {
		const li = rowOf(m);
		expect(within(li).getByText('Open')).toBeTruthy();
		expect(within(li).queryByRole('button', { name: 'Resolve' })).not.toBeNull();
		expect(within(li).queryByRole('button', { name: 'Delete' })).not.toBeNull();
	}
	expect(screen.queryByText(/Loading…/)).toBeNull();
	expect(document.querySelector('aside.mark-list .error')).toBeNull();
}

// ---------------------------------------------------------------------------
// AC-71-8 — Resolve の失敗
// ---------------------------------------------------------------------------

describe('AC-71-8: Resolve で marksStore.update が失敗 → alert 1 回・一覧は不変・unhandled なし', () => {
	it('update_mark が reject → alert(`Could not resolve the mark: <理由>`)が 1 回(理由は素通し・英語)', async () => {
		installInvoke({ update_mark: RESOLVE_REASON });
		await mountMarkList();

		await fireEvent.click(resolveButton(M1));
		await settle();

		expect(callsOf('update_mark')).toHaveLength(1);
		expect(callsOf('update_mark')[0]?.[1]).toEqual({ rootUri: ROOT, id: 'm-1', patch: { status: 'resolved' } });
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(alertMock.mock.calls[0][0]).toBe(RESOLVE_MESSAGE);
		expect(String(alertMock.mock.calls[0][0])).not.toMatch(CJK);
	});

	it('一覧(marksStore.all と表示中の行)は前のまま・Resolve ボタンも残る', async () => {
		installInvoke({ update_mark: RESOLVE_REASON });
		await mountMarkList();

		await fireEvent.click(resolveButton(M1));
		await settle();

		expectListUnchanged();
		// 失敗しても store の lastError に流し込んで一覧を消さない(表示は行のまま)。
		expect(marksStore.lastError).toBeNull();
	});

	it('Unhandled Promise Rejection を出さない', async () => {
		installInvoke({ update_mark: RESOLVE_REASON });
		await mountMarkList();

		await fireEvent.click(resolveButton(M2));
		await settle();

		expect(unhandled).toEqual([]);
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(alertMock.mock.calls[0][0]).toBe(RESOLVE_MESSAGE);
	});

	it('成功する Resolve は従来どおり(alert なし・status が resolved に・Resolve ボタンが消える)', async () => {
		await mountMarkList();

		await fireEvent.click(resolveButton(M1));
		await settle();

		expect(callsOf('update_mark')).toHaveLength(1);
		expect(alertMock).not.toHaveBeenCalled();
		expect(unhandled).toEqual([]);
		expect(marksStore.all.map((m) => [m.id, m.status])).toEqual([
			['m-1', 'resolved'],
			['m-2', 'open'],
		]);
		expect(rows()).toHaveLength(2);
		expect(within(rowOf(M1)).getByText('Resolved')).toBeTruthy();
		expect(within(rowOf(M1)).queryByRole('button', { name: 'Resolve' })).toBeNull();
		expect(within(rowOf(M2)).queryByRole('button', { name: 'Resolve' })).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-71-8 — Delete の失敗
// ---------------------------------------------------------------------------

describe('AC-71-8: Delete で marksStore.remove が失敗 → alert 1 回・一覧は不変・unhandled なし', () => {
	it('remove_mark が reject → alert(`Could not delete the mark: <理由>`)が 1 回(理由は素通し・英語)', async () => {
		installInvoke({ remove_mark: DELETE_REASON });
		await mountMarkList();

		await fireEvent.click(deleteButton(M2));
		await settle();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(callsOf('remove_mark')).toHaveLength(1);
		expect(callsOf('remove_mark')[0]?.[1]).toEqual({ rootUri: ROOT, id: 'm-2' });
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(alertMock.mock.calls[0][0]).toBe(DELETE_MESSAGE);
		expect(String(alertMock.mock.calls[0][0])).not.toMatch(CJK);
	});

	it('一覧(marksStore.all と表示中の行)は前のまま・消したかった行も残る', async () => {
		installInvoke({ remove_mark: DELETE_REASON });
		await mountMarkList();

		await fireEvent.click(deleteButton(M2));
		await settle();

		expectListUnchanged();
		expect(marksStore.lastError).toBeNull();
	});

	it('Unhandled Promise Rejection を出さない', async () => {
		installInvoke({ remove_mark: DELETE_REASON });
		await mountMarkList();

		await fireEvent.click(deleteButton(M1));
		await settle();

		expect(unhandled).toEqual([]);
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(alertMock.mock.calls[0][0]).toBe(DELETE_MESSAGE);
	});

	it('成功する Delete は従来どおり(alert なし・その行が消え、もう 1 件は残る)', async () => {
		await mountMarkList();

		await fireEvent.click(deleteButton(M2));
		await settle();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(callsOf('remove_mark')).toHaveLength(1);
		expect(alertMock).not.toHaveBeenCalled();
		expect(unhandled).toEqual([]);
		expect(marksStore.all.map((m) => m.id)).toEqual(['m-1']);
		expect(rows()).toHaveLength(1);
		expect(rowOf(M1)).toBeTruthy();
	});

	it('confirm で取り消すと従来どおり何もしない(remove_mark を呼ばず・alert なし・一覧は不変)', async () => {
		installInvoke({ remove_mark: DELETE_REASON });
		confirmMock.mockReturnValue(false);
		await mountMarkList();

		await fireEvent.click(deleteButton(M2));
		await settle();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(callsOf('remove_mark')).toHaveLength(0);
		expect(alertMock).not.toHaveBeenCalled();
		expect(unhandled).toEqual([]);
		expectListUnchanged();
	});
});
