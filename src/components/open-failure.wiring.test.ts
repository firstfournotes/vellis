/**
 * 要件#71 の受け入れテスト(docs/requirements/req-71.md)— 開く経路の失敗の配線
 * (component プロジェクト・`Explorer.svelte` / `Viewer.svelte` / `FindInFolder.svelte` を
 * JSDOM にマウントする)
 *
 * 「ファイルやフォルダを開けなかったときは利用者に知らせ、いま開いている文書の表示と
 * 変更追従を保つ」。Rust 側(前のセッションを落とさない=契約1)は
 * src-tauri/tests/acceptance_req71.rs。履歴選択画面のフォルダ選択と起動処理(契約3 後半・
 * 契約5)は src/lib/open-failure.acceptance.test.ts。ここは **この窓で開くのが失敗したら
 * alert で知らせ、画面は前の文書のまま・Unhandled Promise Rejection を漏らさない** 配線を
 * 3 つの入口で判定する。
 *
 * 判定範囲(AC 番号は req-71.md の受け入れ基準):
 * - AC-71-2(契約2・6): ツリーのクリック(`Explorer.svelte` の `handleFileClick`)・Markdown の
 *   内部リンク(`Viewer.svelte` の `handleClick`)・Find in Folder の結果のクリック
 *   (`FindInFolder.svelte` の `openHit`)で開くのが失敗 → `alert` が
 *   `Could not open the file: <理由>` で **1 回**・`windowState.currentDocument` とツリーの選択は
 *   変わらない・unhandledRejection が出ない
 * - AC-71-3(契約3・6)の前半: 親フォルダへ(`goUp`)で `set_root` が失敗 → `alert` が
 *   `Could not open the folder: <理由>`・root(`windowState.root` / `entries`)は変わらない
 * - AC-71-4(契約4・6): ツリーと内部リンクの Shift + クリックで `new_window` が失敗 → `alert` が
 *   `Could not open a new window: <理由>`(既存の `openInNewWindowFailedMessage` と同じ文字列)
 *
 * ## 配線に求める契約(implementer はこれに従う)
 * - `<理由>` は reject された値をそのまま `${err}` で挟む(Rust の `Err(String)` の素通し=要件51)。
 *   文言は既存の Recent Files と同じ `Could not open the file: ${err}`(`$lib/open-document` の
 *   `openFileFailedMessage` に置き、`recentFileOpenFailedMessage` と同じ値=unit 側で判定)・
 *   `Could not open the folder: ${err}`(`$lib/root-picker` の `openFolderFailedMessage`)・
 *   `Could not open a new window: ${err}`(既存 `openInNewWindowFailedMessage`)
 * - 失敗の catch は入口の中で行い、`alert` は 1 回だけ。`windowState.setDocument` は呼ばない
 *   (前の文書が表示され続ける)。`confirmDiscardEdits` の流れ・成功時の挙動は従来どおり
 * - FindInFolder は従来どおり `onOpen` を呼ばず・パネルも閉じない(AC-55-16 と両立)。
 *   加えて alert を 1 回出す
 *
 * ## 判定しないもの
 * - 変更追従が続くこと(Rust 側=AC-71-1)・実機の alert の見え方 → 人間ゲート
 *
 * ## スタブの設計(Explorer.newtab / FindInFolder.wiring の家風)
 * - $lib/ipc: モジュールモック。各テストが `installInvoke` で失敗させる command を選ぶ。
 *   reject の値は Rust に倣って **文字列**(`Err(String)`)
 * - $lib/edit-guard: confirmDiscardEdits(true)
 * - $lib/events: listen を即 resolve する noop(Viewer の menu_find・FindInFolder の
 *   search_progress / search_done の購読を成立させるだけ)
 * - plugin-opener / plugin-dialog / mermaid-mounter: import を成立させるだけ
 * - `alert` は `vi.stubGlobal`。unhandledRejection は `process.on` で拾って空であることを見る
 *   (vitest 自身も unhandled があると実行を失敗にする=契約6 の二重の網)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/edit-guard', () => ({ confirmDiscardEdits: vi.fn(async () => true) }));
vi.mock('$lib/events', () => ({
	listen: vi.fn(async (_event: string, _handler: (e: { payload: unknown }) => void) => () => {}),
}));
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

import { invoke } from '$lib/ipc';
import { confirmDiscardEdits } from '$lib/edit-guard';
import { openInNewWindowFailedMessage } from '$lib/open-in-new-window';
import { recentFileOpenFailedMessage } from '$lib/recent-files';
import type { SearchHit } from '$lib/find-in-folder';
import Explorer from './Explorer.svelte';
import Viewer from './Viewer.svelte';
import FindInFolder from './FindInFolder.svelte';
import { windowState, type DocumentPayload, type Entry } from '../stores/window-state.svelte';
import { contextMenu } from '../stores/context-menu.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';

const invokeMock = vi.mocked(invoke);
const confirmMock = vi.mocked(confirmDiscardEdits);

/** CJK を含まない=英語の判定(要件#51 の走査と同じ考え方)。 */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

// ---------------------------------------------------------------------------
// 失敗の理由(Rust の Err(String) の素通し)と、期待する文言
// ---------------------------------------------------------------------------

const OPEN_REASON = 'invalid UTF-8: file:///Users/x/notes/sjis.txt';
const FOLDER_REASON = 'I/O error: No path was found (os error 2): file:///Users/x';
const WINDOW_REASON = 'window label already exists: vellis-2';

const FILE_MESSAGE = `Could not open the file: ${OPEN_REASON}`;
const FOLDER_MESSAGE = `Could not open the folder: ${FOLDER_REASON}`;
const WINDOW_MESSAGE = `Could not open a new window: ${WINDOW_REASON}`;

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const ROOT = 'file:///Users/x/notes';
const PARENT = 'file:///Users/x';
/** 表示中の文書 A(ツリーにもある)。 */
const A = 'file:///Users/x/notes/a.md';
/** 開けない文書 B(UTF-8 でない .txt=open_document を通る)。 */
const B = 'file:///Users/x/notes/sjis.txt';
const DIR = 'file:///Users/x/notes/docs';

const entries: Entry[] = [
	{ uri: A, name: 'a.md', kind: 'file' },
	{ uri: B, name: 'sjis.txt', kind: 'file' },
	{ uri: DIR, name: 'docs', kind: 'dir' },
];

const DOC_A: DocumentPayload = { uri: A, content: '# A\n', modified: 1 };

/** Viewer 用: 内部リンクを 1 つ含む Markdown。`MD_URI` でレンダーすると href は LINK_TARGET。 */
const MD_URI = 'file:///Users/x/notes/a.md';
const LINK_TARGET = 'file:///Users/x/notes/other.md';
const LINK_MD = ['# A', '', 'See [other](./other.md) here.', ''].join('\n');

/** FindInFolder 用の検索結果。 */
const HITS: SearchHit[] = [
	{ path: 'docs/hit.md', line: 3, text: 'alpha one', ordinal: 1 },
	{ path: 'b.txt', line: 1, text: 'alpha', ordinal: 1 },
];
const HIT_URI = `${ROOT}/docs/hit.md`;

type FailingCommands = Partial<Record<'open_document' | 'open_binary_document' | 'new_window' | 'set_root', string>>;

type PendingSearch = { resolve: (hits: SearchHit[]) => void };
let pendingSearches: PendingSearch[] = [];

/**
 * invoke のモック。`failing` に挙げた command は **その文字列で reject** する(Rust の Err(String))。
 * それ以外: open_document / open_binary_document は DocumentPayload 形・search_in_folder は
 * 手で resolve する deferred・new_window はラベル・set_root は RootPayload 形・他は null。
 */
function installInvoke(failing: FailingCommands = {}) {
	pendingSearches = [];
	invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		const reason = (failing as Record<string, string | undefined>)[cmd];
		if (reason !== undefined) throw reason;
		if (cmd === 'open_document' || cmd === 'open_binary_document') {
			return { uri: args?.uri, content: '', modified: null };
		}
		if (cmd === 'search_in_folder') {
			return await new Promise((res) => {
				const generation = (args as { generation: number }).generation;
				pendingSearches.push({
					resolve: (hits) =>
						res({ generation, total: hits.length, files: new Set(hits.map((h) => h.path)).size, hits }),
				});
			});
		}
		if (cmd === 'new_window') return 'vellis-2';
		if (cmd === 'set_root') {
			return { root_uri: args?.uri, entries: [], document_retained: false };
		}
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

/** 契約6: 上の経路から Unhandled Promise Rejection を出さない。 */
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
	confirmMock.mockResolvedValue(true);
	unhandled.length = 0;
	alertMock.mockClear();
	vi.stubGlobal('alert', alertMock);
	Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
	windowState.applyRoot(ROOT, entries, false);
	windowState.setExpandedDirs([]);
	windowState.setDocument(DOC_A);
	try {
		localStorage.clear();
		sessionStorage.clear();
	} catch {
		// storage が無い環境は無視
	}
});

afterEach(() => {
	contextMenu.close();
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

function mountExplorer() {
	return render(Explorer, {
		props: {
			root: ROOT,
			entries,
			// +page.svelte は windowState.selectedUri を渡す。ここでは A が選ばれている状態を写す。
			selectedUri: A,
			onDuplicateWindow: vi.fn(),
			onOpenInNewWindow: vi.fn(),
		},
	});
}

/** ツリーのファイル行(ExplorerItem の button は title に URI を持つ)。 */
const row = (uri: string) => screen.getByTitle(uri);

let renderedLink: { html: string; index: SourceIndex };

beforeAll(async () => {
	const r = await renderMarkdown(LINK_MD, MD_URI);
	renderedLink = { html: r.html, index: r.index };
});

function mountViewer() {
	const doc: DocumentPayload = { uri: MD_URI, content: LINK_MD, modified: 1 };
	windowState.setDocument(doc);
	const utils = render(Viewer, {
		props: {
			document: doc,
			html: renderedLink.html,
			index: renderedLink.index,
			onRequestAddMark: vi.fn(),
			onToggleMarks: vi.fn(),
			marksOpen: false,
		},
	});
	const link = utils.container.querySelector('a[data-vellis-link]') as HTMLAnchorElement | null;
	if (!link) throw new Error('internal link not rendered');
	expect(link.getAttribute('href')).toBe(LINK_TARGET);
	return { ...utils, doc, link };
}

async function mountFindInFolderWithResults() {
	const onOpen = vi.fn((_uri: string, _query: string, _index: number) => {});
	const onClose = vi.fn(() => {});
	render(FindInFolder, { props: { rootUri: ROOT, onOpen, onClose } });
	const input = screen.getByTestId('find-in-folder-input') as HTMLInputElement;
	await fireEvent.input(input, { target: { value: 'alpha' } });
	await waitFor(() => expect(callsOf('search_in_folder').length).toBe(1), { timeout: 1500 });
	pendingSearches[pendingSearches.length - 1].resolve(HITS);
	await settle();
	const hits = screen.queryAllByTestId('find-in-folder-hit');
	expect(hits.length).toBeGreaterThan(0);
	return { onOpen, onClose, hits };
}

// ---------------------------------------------------------------------------
// AC-71-2 — ツリーのクリックで開けない(契約2・6)
// ---------------------------------------------------------------------------

describe('AC-71-2: ツリーのクリックで openForDisplay が失敗 → alert 1 回・表示中の文書と選択は不変・unhandled なし(契約2・6)', () => {
	it('open_document が reject → alert(`Could not open the file: <理由>`)が 1 回(理由は素通し・英語)', async () => {
		installInvoke({ open_document: OPEN_REASON });
		mountExplorer();

		await fireEvent.click(row(B));
		await settle();

		expect(callsOf('open_document')).toHaveLength(1);
		expect(callsOf('open_document')[0]?.[1]).toEqual({ uri: B });
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(alertMock.mock.calls[0][0]).toBe(FILE_MESSAGE);
		expect(String(alertMock.mock.calls[0][0])).not.toMatch(CJK);
		// 既存の Recent Files の文言と同じ文字列。
		expect(alertMock.mock.calls[0][0]).toBe(recentFileOpenFailedMessage(OPEN_REASON));
	});

	it('表示中の文書(currentDocument)とツリーの選択(selectedUri / active 行)は前のまま', async () => {
		installInvoke({ open_document: OPEN_REASON });
		mountExplorer();

		await fireEvent.click(row(B));
		await settle();

		expect(windowState.currentDocument).toEqual(DOC_A);
		expect(windowState.selectedUri).toBe(A);
		expect(windowState.selectedTreeUri).toBeNull();
		expect(row(A).classList.contains('active')).toBe(true);
		expect(row(B).classList.contains('active')).toBe(false);
	});

	it('Unhandled Promise Rejection を出さない(契約6)', async () => {
		installInvoke({ open_document: OPEN_REASON });
		mountExplorer();

		await fireEvent.click(row(B));
		await settle();

		expect(unhandled).toEqual([]);
		expect(alertMock).toHaveBeenCalledTimes(1);
	});

	it('成功するクリックは従来どおり(alert なし・currentDocument が差し替わる)', async () => {
		mountExplorer();

		await fireEvent.click(row(B));
		await settle();

		expect(alertMock).not.toHaveBeenCalled();
		expect(windowState.currentDocument?.uri).toBe(B);
		expect(unhandled).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-71-2 — Markdown の内部リンクで開けない(契約2・6)
// ---------------------------------------------------------------------------

describe('AC-71-2: 内部リンクのクリックで open_document が失敗 → alert 1 回・表示中の文書は不変・unhandled なし(契約2・6)', () => {
	it('open_document が reject → alert(`Could not open the file: <理由>`)が 1 回', async () => {
		installInvoke({ open_document: OPEN_REASON });
		const { link } = mountViewer();

		await fireEvent.click(link);
		await settle();

		expect(callsOf('open_document')).toHaveLength(1);
		expect(callsOf('open_document')[0]?.[1]).toEqual({ uri: LINK_TARGET });
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(alertMock.mock.calls[0][0]).toBe(FILE_MESSAGE);
		expect(alertMock.mock.calls[0][0]).toBe(recentFileOpenFailedMessage(OPEN_REASON));
	});

	it('表示中の文書は前のまま・Unhandled Promise Rejection を出さない', async () => {
		installInvoke({ open_document: OPEN_REASON });
		const { link, doc } = mountViewer();

		await fireEvent.click(link);
		await settle();

		expect(windowState.currentDocument).toEqual(doc);
		expect(unhandled).toEqual([]);
	});

	it('成功するクリックは従来どおり(alert なし・currentDocument がリンク先に差し替わる)', async () => {
		const { link } = mountViewer();

		await fireEvent.click(link);
		await settle();

		expect(alertMock).not.toHaveBeenCalled();
		expect(windowState.currentDocument?.uri).toBe(LINK_TARGET);
		expect(unhandled).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-71-2 — Find in Folder の結果のクリックで開けない(契約2・6)
// ---------------------------------------------------------------------------

describe('AC-71-2: Find in Folder の結果のクリックで open_document が失敗 → alert 1 回・onOpen なし・パネルと文書は不変(契約2・6)', () => {
	it('open_document が reject → alert(`Could not open the file: <理由>`)が 1 回・onOpen は呼ばれない', async () => {
		const { onOpen, hits } = await mountFindInFolderWithResults();
		installInvoke({ open_document: OPEN_REASON });

		await fireEvent.click(hits[0]);
		await settle();

		expect(callsOf('open_document')).toHaveLength(1);
		expect(callsOf('open_document')[0]?.[1]).toEqual({ uri: HIT_URI });
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(alertMock.mock.calls[0][0]).toBe(FILE_MESSAGE);
		expect(onOpen).not.toHaveBeenCalled();
	});

	it('パネルは残り(onClose なし)・表示中の文書は前のまま・Unhandled Promise Rejection を出さない', async () => {
		const { onClose, hits } = await mountFindInFolderWithResults();
		installInvoke({ open_document: OPEN_REASON });

		await fireEvent.click(hits[0]);
		await settle();

		expect(screen.getByTestId('find-in-folder')).toBeTruthy();
		expect(onClose).not.toHaveBeenCalled();
		expect(windowState.currentDocument).toEqual(DOC_A);
		expect(unhandled).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-71-3(前半)— 親フォルダへ(goUp)で set_root が失敗(契約3・6)
// ---------------------------------------------------------------------------

describe('AC-71-3: 親フォルダへ(goUp)で set_root が失敗 → alert(`Could not open the folder: <理由>`)・root は不変(契約3・6)', () => {
	const upButton = () => screen.getByTitle('Go to Parent Folder');

	it('set_root が reject → alert が 1 回・文言は `Could not open the folder: <理由>`(英語)', async () => {
		installInvoke({ set_root: FOLDER_REASON });
		mountExplorer();

		await fireEvent.click(upButton());
		await settle();

		expect(callsOf('set_root')).toHaveLength(1);
		expect(callsOf('set_root')[0]?.[1]).toEqual({ uri: PARENT });
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(alertMock.mock.calls[0][0]).toBe(FOLDER_MESSAGE);
		expect(String(alertMock.mock.calls[0][0])).not.toMatch(CJK);
	});

	it('root・entries・表示中の文書は前のまま・Unhandled Promise Rejection を出さない', async () => {
		installInvoke({ set_root: FOLDER_REASON });
		mountExplorer();

		await fireEvent.click(upButton());
		await settle();

		expect(windowState.root).toBe(ROOT);
		expect(windowState.entries).toEqual(entries);
		expect(windowState.currentDocument).toEqual(DOC_A);
		expect(unhandled).toEqual([]);
	});

	it('成功する goUp は従来どおり(alert なし・root が親に変わる)', async () => {
		mountExplorer();

		await fireEvent.click(upButton());
		await settle();

		expect(alertMock).not.toHaveBeenCalled();
		expect(windowState.root).toBe(PARENT);
		expect(unhandled).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-71-4 — Shift + クリックで new_window が失敗(契約4・6)
// ---------------------------------------------------------------------------

describe('AC-71-4: ツリーの Shift + クリックで new_window が失敗 → alert(`Could not open a new window: <理由>`)(契約4・6)', () => {
	it('new_window が reject → alert が 1 回・文言は既存の openInNewWindowFailedMessage と同じ', async () => {
		installInvoke({ new_window: WINDOW_REASON });
		mountExplorer();

		await fireEvent.click(row(B), { shiftKey: true });
		await settle();

		expect(callsOf('new_window')).toHaveLength(1);
		expect(callsOf('new_window')[0]?.[1]).toEqual({ path: B, root: ROOT });
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(alertMock.mock.calls[0][0]).toBe(WINDOW_MESSAGE);
		expect(alertMock.mock.calls[0][0]).toBe(openInNewWindowFailedMessage(WINDOW_REASON));
	});

	it('この窓の文書は動かない・open_document は呼ばない・Unhandled Promise Rejection を出さない', async () => {
		installInvoke({ new_window: WINDOW_REASON });
		mountExplorer();

		await fireEvent.click(row(B), { shiftKey: true });
		await settle();

		expect(callsOf('open_document')).toHaveLength(0);
		expect(windowState.currentDocument).toEqual(DOC_A);
		expect(windowState.selectedUri).toBe(A);
		expect(unhandled).toEqual([]);
	});
});

describe('AC-71-4: 内部リンクの Shift + クリックで new_window が失敗 → alert(`Could not open a new window: <理由>`)(契約4・6)', () => {
	it('new_window が reject → alert が 1 回・文言は既存の openInNewWindowFailedMessage と同じ', async () => {
		installInvoke({ new_window: WINDOW_REASON });
		const { link } = mountViewer();

		await fireEvent.click(link, { shiftKey: true });
		await settle();

		expect(callsOf('new_window')).toHaveLength(1);
		expect(callsOf('new_window')[0]?.[1]).toEqual({ path: LINK_TARGET, root: ROOT });
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(alertMock.mock.calls[0][0]).toBe(WINDOW_MESSAGE);
		expect(alertMock.mock.calls[0][0]).toBe(openInNewWindowFailedMessage(WINDOW_REASON));
	});

	it('この窓の文書は動かない・open_document は呼ばない・Unhandled Promise Rejection を出さない', async () => {
		installInvoke({ new_window: WINDOW_REASON });
		const { link, doc } = mountViewer();

		await fireEvent.click(link, { shiftKey: true });
		await settle();

		expect(callsOf('open_document')).toHaveLength(0);
		expect(windowState.currentDocument).toEqual(doc);
		expect(unhandled).toEqual([]);
	});
});
