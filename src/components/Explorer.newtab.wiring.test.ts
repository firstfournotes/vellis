/**
 * 要件#62 の受け入れテスト(docs/requirements/req-62.md)— Explorer の配線
 * (AC-62-11・契約 3。component プロジェクト・`Explorer.svelte` を JSDOM にマウントする
 * 最初のテスト)
 *
 * 「ツリーのファイルを Command+クリック= そのファイルを新しいタブで開く」。
 * 純関数(計画)と実行列は src/lib/new-tab.acceptance.test.ts(unit 側)。ここは
 * `Explorer.svelte` をマウントし、**ファイル項目を metaKey 付きでクリック →
 * `invoke('new_tab', …)` が1回**の配線と、修飾キー無し / Shift+クリックが従来どおり
 * であることを判定する。
 *
 * ## 配線に求める契約(implementer はこれに従う)
 * - `Explorer.svelte` の `handleFileClick` が `e.metaKey` を見る。Command+クリックは
 *   `invoke('new_tab', { path: <そのファイルの URI>, root: <今の root>, expandedDirs: <今の
 *   窓の展開を normalizeExpandedDirs で整形したもの> })` を1回(`$lib/new-tab` の
 *   planNewTab → openNewTab を通ってよい。invoke は `$lib/ipc` 経由=本テストはそこを観測する)
 * - Command+クリックでは **今のタブの文書は動かない**ので `confirmDiscardEdits` を呼ばない
 *   (Shift+クリック=新しい窓と同じ線引き)。`open_document` / `open_binary_document` /
 *   `new_window` も呼ばない。`windowState.currentDocument` は変わらない
 * - 修飾キー無しのクリックは従来どおり `openForDisplay`(`open_document`)を通り、
 *   `confirmDiscardEdits` を先に聞く。Shift+クリックは従来どおり `new_window`
 *   (引数 `{ path, root }`)で、`confirmDiscardEdits` を聞かない
 *
 * ## 判定しないもの
 * - 失敗 alert(newTabFailedMessage)の合流点 → reviewer 照合
 * - Rust 側 `new_tab` の実体・実機でタブとして右隣に開くこと → 人間ゲート(AppKit の実挙動)
 *
 * ## スタブの設計(ContextMenu.newwindow.wiring.test.ts の家風)
 * - $lib/ipc: モジュールモック(new_tab / open_document / new_window の観測台。
 *   open_document には DocumentPayload 形を返させて setDocument を成立させる)
 * - $lib/edit-guard: confirmDiscardEdits のモック(呼ばれる/呼ばれないの観測)
 * - @tauri-apps/plugin-opener / plugin-dialog: Explorer が抱える ContextMenu.svelte の
 *   import を成立させるだけ
 * - ツリーのデータは props(root / entries)と windowState(root / expandedDirs)に直接入れる。
 *   展開中ディレクトリはツリーに描画しない URI にして、ExplorerItem の展開 effect
 *   (subscribe_dir / list_dir)が観測を汚さないようにする
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === 'open_document' || cmd === 'open_binary_document') {
			return { uri: args?.uri, content: '', modified: null };
		}
		return 'vellis-2';
	}),
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
import { confirmDiscardEdits } from '$lib/edit-guard';
import Explorer from './Explorer.svelte';
import { windowState, type Entry } from '../stores/window-state.svelte';
import { contextMenu } from '../stores/context-menu.svelte';

const invokeMock = vi.mocked(invoke);
const confirmMock = vi.mocked(confirmDiscardEdits);

const ROOT = 'file:///Users/x/notes';
const FILE = 'file:///Users/x/notes/plan.md';
const DIR = 'file:///Users/x/notes/sub';
/** 展開中として windowState に入れる URI(ツリーには描画しない=展開 effect を起こさない)。 */
const EXPANDED = 'file:///Users/x/notes/archive';

const entries: Entry[] = [
	{ uri: FILE, name: 'plan.md', kind: 'file' },
	{ uri: DIR, name: 'sub', kind: 'dir' },
];

/** 非同期の handleFileClick(confirm → invoke)を流しきる。 */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Explorer を最小の props でマウントする。 */
function mountExplorer() {
	const onDuplicateWindow = vi.fn();
	const onOpenInNewWindow = vi.fn();
	render(Explorer, {
		props: {
			root: ROOT,
			entries,
			selectedUri: undefined,
			onDuplicateWindow,
			onOpenInNewWindow,
		},
	});
	return { onDuplicateWindow, onOpenInNewWindow };
}

/** ツリーのファイル行(ExplorerItem の button は title に URI を持つ)。 */
const fileRow = () => screen.getByTitle(FILE);

/** command 名で invoke の呼び出しを引く。 */
const callsOf = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd);

beforeEach(() => {
	// 展開は「今の窓の展開」を引き継ぐ(契約4)。root と一緒に windowState へ直接入れる。
	windowState.applyRoot(ROOT, entries, false);
	windowState.setExpandedDirs([EXPANDED, EXPANDED]);
});

afterEach(() => {
	contextMenu.close();
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-62-11 — Command+クリック → new_tab(契約3)
// ---------------------------------------------------------------------------

describe('AC-62-11: ファイルの Command+クリックは new_tab を1回・今のタブは動かさない(契約3)', () => {
	it("metaKey 付きクリック → invoke('new_tab', { path: そのファイル, root: 今の root, expandedDirs: 今の展開 }) が1回", async () => {
		mountExplorer();

		await fireEvent.click(fileRow(), { metaKey: true });
		await flushAsync();

		const newTab = callsOf('new_tab');
		expect(newTab).toHaveLength(1);
		expect(newTab[0]?.[1]).toEqual({
			path: FILE,
			root: ROOT,
			// windowState.expandedDirs の [EXPANDED, EXPANDED] は normalizeExpandedDirs で
			// 重複除去される(契約4=要件#34 と同じ規則)。
			expandedDirs: [EXPANDED],
		});
	});

	it('open_document / open_binary_document / new_window は呼ばれず、confirmDiscardEdits も聞かない', async () => {
		mountExplorer();

		await fireEvent.click(fileRow(), { metaKey: true });
		await flushAsync();

		expect(callsOf('open_document')).toHaveLength(0);
		expect(callsOf('open_binary_document')).toHaveLength(0);
		expect(callsOf('new_window')).toHaveLength(0);
		expect(confirmMock).not.toHaveBeenCalled();
	});

	it('今のタブの文書は動かない(windowState.currentDocument は変わらない)', async () => {
		const before = { uri: 'file:///Users/x/notes/other.md', content: 'x', modified: null };
		windowState.setDocument(before);
		mountExplorer();

		await fireEvent.click(fileRow(), { metaKey: true });
		await flushAsync();

		expect(windowState.currentDocument).toEqual(before);
		expect(callsOf('new_tab')).toHaveLength(1);
	});

	it('展開が無ければ expandedDirs は空配列(発明しない)', async () => {
		windowState.setExpandedDirs([]);
		mountExplorer();

		await fireEvent.click(fileRow(), { metaKey: true });
		await flushAsync();

		expect(callsOf('new_tab')[0]?.[1]).toEqual({ path: FILE, root: ROOT, expandedDirs: [] });
	});
});

// ---------------------------------------------------------------------------
// AC-62-11 — 修飾キー無し / Shift は従来どおり(契約3・10)
// ---------------------------------------------------------------------------

describe('AC-62-11: 修飾キー無しのクリックは従来どおり openForDisplay(今のタブを置き換える)', () => {
	it("クリック → confirmDiscardEdits を聞いてから invoke('open_document', { uri }) が1回・new_tab は呼ばない", async () => {
		mountExplorer();

		await fireEvent.click(fileRow());
		await flushAsync();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		const opened = callsOf('open_document');
		expect(opened).toHaveLength(1);
		expect(opened[0]?.[1]).toEqual({ uri: FILE });
		expect(callsOf('new_tab')).toHaveLength(0);
		expect(callsOf('new_window')).toHaveLength(0);
		expect(windowState.currentDocument?.uri).toBe(FILE);
	});

	it('confirmDiscardEdits が false なら何も開かない(要件#48 契約④=従来どおり)', async () => {
		confirmMock.mockResolvedValueOnce(false);
		mountExplorer();

		await fireEvent.click(fileRow());
		await flushAsync();

		expect(callsOf('open_document')).toHaveLength(0);
		expect(callsOf('new_tab')).toHaveLength(0);
	});
});

describe('AC-62-11: Shift+クリックは従来どおり new_window(契約10=別の窓で開くまま)', () => {
	it("shiftKey 付きクリック → invoke('new_window', { path, root }) が1回・new_tab は呼ばない・confirm は聞かない", async () => {
		mountExplorer();

		await fireEvent.click(fileRow(), { shiftKey: true });
		await flushAsync();

		const newWindow = callsOf('new_window');
		expect(newWindow).toHaveLength(1);
		expect(newWindow[0]?.[1]).toEqual({ path: FILE, root: ROOT });
		expect(callsOf('new_tab')).toHaveLength(0);
		expect(callsOf('open_document')).toHaveLength(0);
		expect(confirmMock).not.toHaveBeenCalled();
	});
});
