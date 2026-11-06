/**
 * 要件#83 追補a の受け入れテスト(docs/requirements/req-83.md「### 追補a」)— Recent Folders の行の × と Delete キーで
 * 履歴から外す(AC-83-28 の (1)〜(8)=契約10・13 の書き足し・契約5 (aa) の注記・契約14 の Remove from Recent Folders)。
 * component プロジェクト・`Dashboard.svelte` を JSDOM にマウントする。準備は `Dashboard.wiring.test.ts` の写し
 * (ストアの購読は最初の init で控えて毎回戻す=801956e の形)。
 *
 * ## 確定契約(implementer はこれに従う。名前と DOM は test-writer が固定・2026-11-06)
 * - DOM(契約10 追補a): Recent Folders の各行は **包みの要素 `.recent-row`** で、その直下に行のボタン
 *   `button.recent-folder`(今のまま=`title` は URI・`missing`・`.ssh-badge`)と × のボタン `button.recent-remove` を
 *   **兄弟として** 持つ(× を `button.recent-folder` の中に入れない=button の入れ子にしない)。
 *   - 包みと × の class に `recent-folder` を含む名前を使わない(E2E の `req83-gate` が `recent-folder` の class で行を
 *     見分けるため。例: `recent-row`・`recent-remove` は可、`recent-folder-row` は不可)
 *   - × は `aria-label="Remove from Recent Folders"`・`title="Remove from Recent Folders"`(右クリックの項目と同じ文言)・
 *     アイコンは `i-x`(`<Icon name="x" />`=`<use href="#i-x">`)・`tabindex="-1"`(Tab の止まり先にしない)
 *   - すべての行に出す(見つからない行・SSH の行も)。Bookmarks のタイル・Recently Modified の行には出さない
 * - × を押す(契約10 追補a): 確認なしで `invoke('remove_history_entry', { uri })` を 1 回。返った履歴で行を描き直す。
 *   行は開かない(`confirmDiscard`・`set_root`・`open_document`・`onOpened` を呼ばない)。`plugin-dialog` の `ask` /
 *   `confirm` / `message` も呼ばない
 * - 見え方(契約10 追補a=CSS のソース走査): `Dashboard.svelte` の `<style>` に
 *   - `.recent-remove` を既定で `visibility: hidden` にする規則(`display: none` ではない=場所を取ったまま)
 *   - `.recent-row:hover` のとき `visibility: visible` にする規則と、`.recent-row:focus-within` のとき `visible` にする規則
 *     (1 つの規則にセレクタを並べても、別々でもよい。空白と並びは問わない)
 * - Delete キー(契約13 追補a): `button.recent-folder` にフォーカスがあるときの、修飾キー(meta / alt / ctrl / shift)なしの
 *   `Backspace` と `Delete` の keydown → × と同じく外す。`isComposing` のとき・右クリックのメニュー(`contextMenu.open`)が
 *   開いている間は何もしない。Recently Modified の行・Bookmark のタイル・上の段のボタンでは何もしない
 * - 外した後のフォーカス(契約13 追補a【推奨】): キーで外したとき、またはフォーカスが外した行(包みの中)にあったとき=
 *   同じ位置に来た行(=次の行)へ(その行が区画の止まり先 `tabindex="0"` になる)。外したのが最後の行なら前の行へ。
 *   行が残らなければ Bookmarks の区画の止まり先(`tabindex="0"` のタイル)へ。マウスの × で、フォーカスが別の場所(例:
 *   タイル)にあったときは動かさない
 * - Show All(契約10): 畳んだ状態で外すと 7 番目が繰り上がり、補足が `6 of N-1`。広げた状態は広げたまま(`Show Less` の
 *   まま)。6 件以下になれば補足も `Show All` / `Show Less` も消える
 * - 失敗(契約5 (aa)・追補a): `remove_history_entry` が reject → ×・Delete キー・右クリックの `Remove from Recent Folders`
 *   のどれでも行は残り、Dashboard の注記(`[role="alert"]`=今の `p.error`)に
 *   `Could not remove the folder from Recent Folders: <理由>`(理由は reject の値をそのまま=要件51。推奨は
 *   `$lib/dashboard` の `removeRecentFolderFailedMessage(reason)`。このテストは文言だけを見る)。`alert()` は出さない。
 *   注記の消え方は開けなかったときの注記と同じ(次に開けたら消える)
 * - Tab の順(契約13 (am)): 上の段のボタン 3 つ → Bookmarks(1 つ)→ Recent Folders(1 つ)→ Show All →
 *   Recently Modified(1 つ)→ Rescan。× が増えても変わらない
 *
 * ## スタブの設計(Dashboard.wiring.test.ts と同じ)
 * - $lib/ipc の invoke: command 名で応答(`installInvoke`)。`remove_history_entry` は各テストが reject にできる
 * - $lib/events の listen: event 名ごとに handler を記録
 * - @tauri-apps/plugin-dialog: `open` / `ask` / `confirm` / `message` をすべてモック(呼ばれないことを見る)
 * - `alert` は `vi.stubGlobal`
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick, type ComponentProps } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));
vi.mock('$lib/edit-guard', () => ({ confirmDiscardEdits: vi.fn(async () => true) }));
vi.mock('@tauri-apps/plugin-opener', () => ({
	revealItemInDir: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
	openUrl: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
	open: vi.fn(async () => null),
	ask: vi.fn(async () => false),
	confirm: vi.fn(async () => false),
	message: vi.fn(async () => undefined),
}));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import { open as openDialog, ask as askDialog, confirm as confirmDialog, message as messageDialog } from '@tauri-apps/plugin-dialog';
import type { Bookmark } from '$lib/bookmarks';
import Dashboard from './Dashboard.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { contextMenu } from '../stores/context-menu.svelte';
import { bookmarks } from '../stores/bookmarks.svelte';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const openDialogMock = openDialog as unknown as Mock<
	(options?: Record<string, unknown>) => Promise<string | string[] | null>
>;
const askDialogMock = askDialog as unknown as Mock<(...args: unknown[]) => Promise<boolean>>;
const confirmDialogMock = confirmDialog as unknown as Mock<(...args: unknown[]) => Promise<boolean>>;
const messageDialogMock = messageDialog as unknown as Mock<(...args: unknown[]) => Promise<void>>;

type Handler = (e: { payload: unknown }) => void;
const handlers: Record<string, Handler[]> = {};
/**
 * ストアの `bookmarks_changed` の handler。ストアは窓(=このモジュール)に 1 つで、契約 9 のとおり最初の `init()` で
 * 1 回だけ購読し 2 回目以降は購読し直さない。そのため最初の init の直後(まだ何もマウントしていない)に控え、
 * 各テストの準備で `handlers` を空にした後にこれだけ戻す(コンポーネントが登録した handler はテストごとに消す)。
 */
let storeHandlers: Handler[] | null = null;

// ---------------------------------------------------------------------------
// 確定契約の名前(上の「確定契約」のとおり)
// ---------------------------------------------------------------------------

const ROW_WRAP = 'recent-row';
const REMOVE_BUTTON = 'recent-remove';
const REMOVE_LABEL = 'Remove from Recent Folders';
const REMOVE_ICON_HREF = '#i-x';
const removeFailedMessage = (reason: string) => `Could not remove the folder from Recent Folders: ${reason}`;
const REMOVE_REASON = 'Permission denied (os error 13)';

// ---------------------------------------------------------------------------
// フィクスチャ(Dashboard.wiring.test.ts と同じ)
// ---------------------------------------------------------------------------

const AURORA = 'file:///Users/x/aurora';
const GONE_FOLDER = 'file:///Users/x/gone';
const SSH_FOLDER = 'ssh://alice@host:22/srv/notes';
const PLAN = 'file:///Users/x/aurora/plan.md';
const HISTORY: string[] = [
	AURORA,
	SSH_FOLDER,
	GONE_FOLDER,
	...Array.from({ length: 11 }, (_, i) => `file:///Users/x/folder-${i}`),
];
const BOOKMARKS: Bookmark[] = [
	{ uri: AURORA, kind: 'folder' },
	{ uri: PLAN, kind: 'file' },
	{ uri: SSH_FOLDER, kind: 'folder' },
];
const MISSING = new Set([GONE_FOLDER, PLAN]);

type ModifiedFile = { uri: string; folder: string; modified: number };
type Scan = { generation: number; files: ModifiedFile[]; folders: number; truncated: boolean };
const F1: ModifiedFile = { uri: `${AURORA}/docs/design/a.html`, folder: AURORA, modified: 1_700_000_300_000 };

type RootPayload = { root_uri: string; entries: unknown[]; document_retained: boolean };

/** 各テストが差し替える応答。 */
let history: string[] = [];
let scanResponse: ((generation: number) => Promise<Scan>) | null = null;
let setRootResponse: ((uri: string) => RootPayload) | Error = (uri) => ({ root_uri: uri, entries: [], document_retained: false });
let openDocResponse: ((uri: string) => DocumentPayload) | Error = (uri) => ({ uri, content: '# doc\n', modified: 1 });
/** `remove_history_entry` の失敗(reject の値)。null なら成功=履歴から外して返す。 */
let removeFailure: unknown = null;

function installInvoke() {
	invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		switch (cmd) {
			case 'set_root': {
				if (setRootResponse instanceof Error) throw setRootResponse;
				return setRootResponse(String(args?.uri));
			}
			case 'open_document':
			case 'open_binary_document': {
				if (openDocResponse instanceof Error) throw openDocResponse;
				return openDocResponse(String(args?.uri));
			}
			case 'list_history':
				return history;
			case 'list_bookmarks':
				return BOOKMARKS;
			case 'list_missing_paths': {
				const uris = (args?.uris as string[] | undefined) ?? [];
				return uris.filter((u) => MISSING.has(u));
			}
			case 'scan_recently_modified': {
				const generation = Number(args?.generation);
				if (scanResponse) return scanResponse(generation);
				return { generation, files: [], folders: 2, truncated: false } satisfies Scan;
			}
			case 'add_bookmark':
			case 'remove_bookmark':
			case 'move_bookmark':
				return bookmarks.list;
			case 'remove_history_entry': {
				if (removeFailure !== null) throw removeFailure;
				history = history.filter((u) => u !== String(args?.uri));
				return history;
			}
			default:
				return null;
		}
	});
}

const callsOf = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd);
const argsOf = (cmd: string) => callsOf(cmd).map((c) => c[1] as Record<string, unknown> | undefined);

const alertMock = vi.fn((_message?: unknown) => {});
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
	await flushAsync();
	await flushAsync();
	await tick();
}

function emit(event: string, payload: unknown) {
	const hs = handlers[event] ?? [];
	expect(hs.length, `someone subscribed to ${event}`).toBeGreaterThan(0);
	for (const h of hs) h({ payload });
}

type DashboardProps = ComponentProps<typeof Dashboard>;

let confirmAnswer = true;

async function mountDashboard(extra: Partial<DashboardProps> = {}) {
	const onPickFolder = vi.fn();
	const onClose = vi.fn();
	const onOpened = vi.fn((_root: RootPayload | null, _doc: DocumentPayload | null) => {});
	const confirmDiscard = vi.fn(async () => confirmAnswer);
	const props: DashboardProps = {
		error: null,
		currentRoot: null,
		confirmDiscard,
		onOpened,
		onClose,
		onPickFolder,
		...extra,
	};
	const result = render(Dashboard, { props });
	await settle();
	await settle();
	return { ...result, onPickFolder, onClose, onOpened, confirmDiscard };
}

const tiles = () => [...document.querySelectorAll<HTMLButtonElement>('.bookmark-tile')];
const tileOf = (uri: string) => {
	const found = tiles().filter((t) => t.title === uri);
	expect(found, `exactly one tile with title === ${uri}`).toHaveLength(1);
	return found[0]!;
};
const recentRows = () => [...document.querySelectorAll<HTMLButtonElement>('.recent-folder')];
const recentRowOf = (uri: string) => {
	const found = recentRows().filter((r) => r.title === uri);
	expect(found, `exactly one recent row with title === ${uri}`).toHaveLength(1);
	return found[0]!;
};
const modifiedRows = () => [...document.querySelectorAll<HTMLButtonElement>('.modified-row')];
const section = (name: 'bookmarks' | 'recent-folders' | 'recently-modified') =>
	document.querySelector<HTMLElement>(`section.dashboard-${name}`)!;
const textOf = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const buttonByText = (text: string) =>
	[...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => textOf(b).startsWith(text)) ?? null;
const removeButtons = () => [...document.querySelectorAll<HTMLButtonElement>(`button.${REMOVE_BUTTON}`)];
/** 行の包み(`.recent-row`)= 行のボタンの親。 */
const wrapOf = (uri: string) => {
	const wrap = recentRowOf(uri).parentElement;
	expect(wrap, `the row ${uri} has a parent`).not.toBeNull();
	expect(wrap!.classList.contains(ROW_WRAP), `the parent of the row ${uri} is .${ROW_WRAP} (got <${wrap!.tagName.toLowerCase()} class="${wrap!.className}">)`).toBe(true);
	return wrap!;
};
/** 行の ×(包みの直下の `button.recent-remove`)。 */
const removeButtonOf = (uri: string) => {
	const button = wrapOf(uri).querySelector<HTMLButtonElement>(`:scope > button.${REMOVE_BUTTON}`);
	expect(button, `the row ${uri} has a sibling button.${REMOVE_BUTTON}`).not.toBeNull();
	return button!;
};
const alertNote = () => document.querySelector('[role="alert"]');
const active = () => document.activeElement as HTMLElement | null;

async function rightClick(target: Element) {
	await fireEvent.contextMenu(target, { clientX: 20, clientY: 20 });
	await tick();
}

const menuItem = (name: string) => screen.getByRole('menuitem', { name }) as HTMLButtonElement;
const menuCount = () => document.querySelectorAll('.context-menu').length;

async function clickItem(name: string) {
	await fireEvent.click(menuItem(name));
	await settle();
}

/** 行にフォーカスを置いてキーを押す(行の keydown=契約13 追補a)。 */
async function pressOn(el: HTMLElement, key: string, init: Record<string, unknown> = {}) {
	el.focus();
	expect(document.activeElement, 'the element takes focus before the key').toBe(el);
	await fireEvent.keyDown(el, { key, ...init });
	await settle();
}

function expectNothingRemoved() {
	expect(callsOf('remove_history_entry')).toHaveLength(0);
	expect(callsOf('remove_bookmark')).toHaveLength(0);
	expect(recentRows().map((r) => r.title)).toEqual(HISTORY.slice(0, 6));
}

beforeEach(async () => {
	for (const k of Object.keys(handlers)) delete handlers[k];
	listenMock.mockImplementation(async (event, handler) => {
		(handlers[event] ??= []).push(handler as Handler);
		return () => {};
	});
	history = [...HISTORY];
	scanResponse = null;
	setRootResponse = (uri) => ({ root_uri: uri, entries: [], document_retained: false });
	openDocResponse = (uri) => ({ uri, content: '# doc\n', modified: 1 });
	removeFailure = null;
	confirmAnswer = true;
	installInvoke();
	alertMock.mockClear();
	vi.stubGlobal('alert', alertMock);
	openDialogMock.mockReset();
	openDialogMock.mockResolvedValue(null);
	askDialogMock.mockClear();
	confirmDialogMock.mockClear();
	messageDialogMock.mockClear();
	windowState.version = '1.2.3';
	// ページと同じく起動時に 1 回(2 回目以降は何もしない=契約 9)。最初の init の購読を控えて毎回戻し、
	// 直前のテストの一覧を event で BOOKMARKS に戻す(ストアは窓に 1 つ)。購読していなければここで落ちる。
	await bookmarks.init();
	storeHandlers ??= [...(handlers['bookmarks_changed'] ?? [])];
	handlers['bookmarks_changed'] = [...storeHandlers];
	emit('bookmarks_changed', BOOKMARKS);
	await tick();
	invokeMock.mockClear();
});

afterEach(() => {
	contextMenu.close();
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-83-28 の 1 — 各行の ×(契約10 追補a)
// ---------------------------------------------------------------------------

describe('AC-83-28 (1): 各行に × のボタン(button.recent-folder の兄弟・aria-label と title・i-x・tabindex="-1")', () => {
	it('見える 6 行のそれぞれが .recent-row に包まれ、行のボタンの兄弟に button.recent-remove がある(入れ子でない)', async () => {
		await mountDashboard();
		expect(recentRows()).toHaveLength(6);

		for (const uri of HISTORY.slice(0, 6)) {
			const row = recentRowOf(uri);
			const wrap = wrapOf(uri);
			const remove = removeButtonOf(uri);
			expect(remove.parentElement, `× of ${uri} is a sibling of the row (same parent)`).toBe(row.parentElement);
			expect(row.contains(remove), `× of ${uri} is not nested in button.recent-folder`).toBe(false);
			expect(remove.contains(row), `the row is not nested in the ×`).toBe(false);
			expect(wrap.querySelectorAll(':scope > button.recent-folder'), `one row button directly under .${ROW_WRAP}`).toHaveLength(1);
			expect(wrap.querySelectorAll(`:scope > button.${REMOVE_BUTTON}`), `one × directly under .${ROW_WRAP}`).toHaveLength(1);
			expect(remove.tagName).toBe('BUTTON');
		}
		expect(removeButtons(), 'one × per visible row, none elsewhere').toHaveLength(6);
	});

	it('× の aria-label と title は Remove from Recent Folders・アイコンは i-x・tabindex="-1"', async () => {
		await mountDashboard();

		for (const uri of HISTORY.slice(0, 6)) {
			const remove = removeButtonOf(uri);
			expect(remove.getAttribute('aria-label'), `aria-label of × (${uri})`).toBe(REMOVE_LABEL);
			expect(remove.getAttribute('title'), `title of × (${uri})`).toBe(REMOVE_LABEL);
			expect(remove.getAttribute('tabindex'), `tabindex of × (${uri})`).toBe('-1');
			expect(remove.tabIndex).toBe(-1);
			const use = remove.querySelector('svg use');
			expect(use, `× (${uri}) draws an icon with <use>`).not.toBeNull();
			expect(use!.getAttribute('href') ?? use!.getAttribute('xlink:href')).toBe(REMOVE_ICON_HREF);
			expect(remove.getAttribute('type') ?? 'button', 'the × is not a submit button').toBe('button');
		}
	});

	it('SSH の行と見つからない行にも × がある。行のボタン自体は今のまま(title=URI・missing・SSH の札)', async () => {
		await mountDashboard();

		const sshRemove = removeButtonOf(SSH_FOLDER);
		expect(sshRemove.getAttribute('aria-label')).toBe(REMOVE_LABEL);
		expect(textOf(recentRowOf(SSH_FOLDER).querySelector('.ssh-badge'))).toBe('SSH');

		const goneRemove = removeButtonOf(GONE_FOLDER);
		expect(goneRemove.getAttribute('aria-label')).toBe(REMOVE_LABEL);
		expect(recentRowOf(GONE_FOLDER).classList.contains('missing')).toBe(true);

		// 広げると 14 行すべてに × が出る。
		await fireEvent.click(buttonByText('Show All')!);
		await tick();
		expect(recentRows()).toHaveLength(14);
		expect(removeButtons()).toHaveLength(14);
		for (const uri of HISTORY) expect(removeButtonOf(uri).getAttribute('aria-label')).toBe(REMOVE_LABEL);
	});

	it("包みと × の class に 'recent-folder' を含む名前を使わない(E2E の req83-gate が行を見分ける印)。タイルと Recently Modified の行には × が無い", async () => {
		scanResponse = async (generation) => ({ generation, files: [F1], folders: 1, truncated: false });
		await mountDashboard();

		for (const uri of HISTORY.slice(0, 6)) {
			const wrap = wrapOf(uri);
			const remove = removeButtonOf(uri);
			for (const el of [wrap, remove]) {
				for (const cls of el.classList) {
					expect(cls.includes('recent-folder'), `class "${cls}" on <${el.tagName.toLowerCase()}> must not contain "recent-folder"`).toBe(false);
				}
			}
		}
		expect(document.querySelectorAll(`.bookmark-tile .${REMOVE_BUTTON}, .add-bookmark .${REMOVE_BUTTON}`), 'no × in the tiles ((f))').toHaveLength(0);
		expect(modifiedRows()).toHaveLength(1);
		expect(section('recently-modified').querySelectorAll(`.${REMOVE_BUTTON}`), 'no × in Recently Modified').toHaveLength(0);
		expect(section('bookmarks').querySelectorAll(`.${REMOVE_BUTTON}`), 'no × in Bookmarks').toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC-83-28 の 2 — × を押す(契約10 追補a)
// ---------------------------------------------------------------------------

describe('AC-83-28 (2): × を押す → remove_history_entry(その URI) が 1 回・行が消える・開かない・確認なし', () => {
	it('消えた行の × → remove_history_entry({ uri }) が 1 回・その行が消える', async () => {
		await mountDashboard();
		invokeMock.mockClear();

		await fireEvent.click(removeButtonOf(GONE_FOLDER));
		await settle();

		expect(argsOf('remove_history_entry')).toEqual([{ uri: GONE_FOLDER }]);
		expect(recentRows().some((r) => r.title === GONE_FOLDER)).toBe(false);
		expect(removeButtons().length).toBe(recentRows().length);
	});

	it('× は行を開かない: confirmDiscard・set_root・open_document・open_binary_document・onOpened・onClose を呼ばない', async () => {
		const { confirmDiscard, onOpened, onClose } = await mountDashboard({ currentRoot: 'file:///Users/x/other' });
		invokeMock.mockClear();

		await fireEvent.click(removeButtonOf(AURORA));
		await settle();

		expect(argsOf('remove_history_entry')).toEqual([{ uri: AURORA }]);
		expect(confirmDiscard).not.toHaveBeenCalled();
		expect(callsOf('set_root')).toHaveLength(0);
		expect(callsOf('open_document')).toHaveLength(0);
		expect(callsOf('open_binary_document')).toHaveLength(0);
		expect(onOpened).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(alertNote()).toBeNull();
	});

	it('確認のダイアログを出さない(plugin-dialog の ask / confirm / message・plugin:dialog|message の invoke・alert)。SSH の行も同じ', async () => {
		await mountDashboard();
		invokeMock.mockClear();

		await fireEvent.click(removeButtonOf(SSH_FOLDER));
		await settle();

		expect(argsOf('remove_history_entry')).toEqual([{ uri: SSH_FOLDER }]);
		expect(recentRows().some((r) => r.title === SSH_FOLDER)).toBe(false);
		expect(askDialogMock).not.toHaveBeenCalled();
		expect(confirmDialogMock).not.toHaveBeenCalled();
		expect(messageDialogMock).not.toHaveBeenCalled();
		expect(openDialogMock).not.toHaveBeenCalled();
		expect(callsOf('plugin:dialog|message')).toHaveLength(0);
		expect(callsOf('plugin:dialog|ask')).toHaveLength(0);
		expect(callsOf('plugin:dialog|confirm')).toHaveLength(0);
		expect(alertMock).not.toHaveBeenCalled();
		expect(contextMenu.open, 'the × does not open the context menu').toBe(false);
		expect(menuCount()).toBe(0);
	});

	it('続けて 2 つ外す → それぞれ 1 回ずつ・remove_bookmark は呼ばない', async () => {
		await mountDashboard();
		invokeMock.mockClear();

		await fireEvent.click(removeButtonOf(GONE_FOLDER));
		await settle();
		await fireEvent.click(removeButtonOf(AURORA));
		await settle();

		expect(argsOf('remove_history_entry')).toEqual([{ uri: GONE_FOLDER }, { uri: AURORA }]);
		expect(callsOf('remove_bookmark')).toHaveLength(0);
		expect(recentRows().map((r) => r.title)).toEqual([SSH_FOLDER, ...HISTORY.slice(3, 8)]);
		expect(tiles().map((t) => t.title), 'the bookmarks are untouched').toEqual([AURORA, PLAN, SSH_FOLDER]);
	});
});

// ---------------------------------------------------------------------------
// AC-83-28 の 3 — 見え方(CSS のソース走査)
// ---------------------------------------------------------------------------

describe('AC-83-28 (3): × は行の :hover と :focus-within のときだけ見え、それ以外は visibility: hidden(場所を取る)', () => {
	type Rule = { selectors: string[]; declarations: string };

	/** セレクタの列を一番外の `,` で分ける(`:is(:hover, :focus-within)` の中の `,` では分けない)。 */
	function splitSelectors(list: string): string[] {
		const out: string[] = [];
		let depth = 0;
		let current = '';
		for (const ch of list) {
			if (ch === '(') depth++;
			else if (ch === ')') depth = Math.max(0, depth - 1);
			if (ch === ',' && depth === 0) {
				out.push(current);
				current = '';
			} else {
				current += ch;
			}
		}
		out.push(current);
		return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0);
	}

	/** `<style>…</style>` の中の `selector { declarations }` を順に拾う(コメントは落とす・空白は 1 つに畳む)。 */
	function styleRules(source: string, what: string): Rule[] {
		const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source);
		expect(m, `${what} has a <style> block`).toBeTruthy();
		const css = (m as RegExpExecArray)[1].replace(/\/\*[\s\S]*?\*\//g, '');
		const out: Rule[] = [];
		const re = /([^{}]+)\{([^{}]*)\}/g;
		let hit: RegExpExecArray | null;
		while ((hit = re.exec(css)) !== null) {
			out.push({ selectors: splitSelectors(hit[1]), declarations: hit[2] });
		}
		return out;
	}

	const declares = (declarations: string, property: string, value: string) =>
		new RegExp(`(^|;|\\s)${property}\\s*:\\s*${value}\\s*(!important)?\\s*(;|$)`, 'm').test(declarations);

	const SOURCE = () => readFileSync(resolve(__dirname, 'Dashboard.svelte'), 'utf-8');
	/** セレクタが × を指す(`.recent-remove` で終わる。`button.recent-remove` も可)。 */
	const targetsRemove = (s: string) => new RegExp(`(^|[\\s>+~)])(button)?\\.${REMOVE_BUTTON}$`).test(s);
	const hasPseudo = (s: string) => /:hover|:focus/.test(s);
	/** `.recent-row:hover … .recent-remove` のように、包みの状態で × を指すセレクタ(`:is(:hover, …)` の形も可)。 */
	const wrapStateSelector = (s: string, state: ':hover' | ':focus-within') =>
		targetsRemove(s) && s.includes(`.${ROW_WRAP}`) && s.includes(state) && s.indexOf(state) < s.lastIndexOf(`.${REMOVE_BUTTON}`);

	it('既定の規則: .recent-remove に visibility: hidden(display: none ではない)', () => {
		const rules = styleRules(SOURCE(), 'Dashboard.svelte');
		const plain = rules.filter((r) => r.selectors.some((s) => targetsRemove(s) && !hasPseudo(s)));
		expect(plain.length, `a rule for .${REMOVE_BUTTON} without :hover / :focus`).toBeGreaterThan(0);
		expect(
			plain.some((r) => declares(r.declarations, 'visibility', 'hidden')),
			`one of ${JSON.stringify(plain.map((r) => r.selectors))} declares visibility: hidden`
		).toBe(true);
		expect(
			plain.some((r) => declares(r.declarations, 'display', 'none')),
			'the × keeps its place (no display: none)'
		).toBe(false);
	});

	it('行の :hover で visible、行の :focus-within で visible の規則がある(書き方の揺れは問わない)', () => {
		const rules = styleRules(SOURCE(), 'Dashboard.svelte');
		const visibleFor = (state: ':hover' | ':focus-within') =>
			rules.filter((r) => r.selectors.some((s) => wrapStateSelector(s, state)) && declares(r.declarations, 'visibility', 'visible'));
		expect(visibleFor(':hover').length, `a rule .${ROW_WRAP}:hover … .${REMOVE_BUTTON} { visibility: visible }`).toBeGreaterThan(0);
		expect(visibleFor(':focus-within').length, `a rule .${ROW_WRAP}:focus-within … .${REMOVE_BUTTON} { visibility: visible }`).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// AC-83-28 の 4 — Delete キー(契約13 追補a)
// ---------------------------------------------------------------------------

describe('AC-83-28 (4): 行にフォーカスがあるときの Backspace / Delete → 外す。修飾キー・IME・メニュー・ほかの区画では何もしない', () => {
	it('Backspace → remove_history_entry(その行の URI) が 1 回・行が消える', async () => {
		await mountDashboard();
		invokeMock.mockClear();

		await pressOn(recentRowOf(GONE_FOLDER), 'Backspace');

		expect(argsOf('remove_history_entry')).toEqual([{ uri: GONE_FOLDER }]);
		expect(recentRows().some((r) => r.title === GONE_FOLDER)).toBe(false);
	});

	it('Delete → 同じく外す(fn + Delete)', async () => {
		await mountDashboard();
		invokeMock.mockClear();

		await pressOn(recentRowOf(SSH_FOLDER), 'Delete');

		expect(argsOf('remove_history_entry')).toEqual([{ uri: SSH_FOLDER }]);
		expect(recentRows().some((r) => r.title === SSH_FOLDER)).toBe(false);
	});

	it('キーで外しても行は開かない(confirmDiscard・set_root・onOpened なし)・確認なし', async () => {
		const { confirmDiscard, onOpened } = await mountDashboard({ currentRoot: 'file:///Users/x/other' });
		invokeMock.mockClear();

		await pressOn(recentRowOf(AURORA), 'Delete');

		expect(argsOf('remove_history_entry')).toEqual([{ uri: AURORA }]);
		expect(confirmDiscard).not.toHaveBeenCalled();
		expect(callsOf('set_root')).toHaveLength(0);
		expect(onOpened).not.toHaveBeenCalled();
		expect(askDialogMock).not.toHaveBeenCalled();
		expect(confirmDialogMock).not.toHaveBeenCalled();
		expect(messageDialogMock).not.toHaveBeenCalled();
		expect(alertMock).not.toHaveBeenCalled();
	});

	const modifiers: Array<[string, Record<string, boolean>]> = [
		['metaKey', { metaKey: true }],
		['altKey', { altKey: true }],
		['ctrlKey', { ctrlKey: true }],
		['shiftKey', { shiftKey: true }],
	];
	it.each(modifiers)('%s を伴う Backspace / Delete は何もしない', async (_name, init) => {
		await mountDashboard();
		invokeMock.mockClear();

		await pressOn(recentRowOf(GONE_FOLDER), 'Backspace', init);
		await pressOn(recentRowOf(GONE_FOLDER), 'Delete', init);

		expectNothingRemoved();
	});

	it('IME の変換中(isComposing)は何もしない', async () => {
		await mountDashboard();
		invokeMock.mockClear();

		await pressOn(recentRowOf(GONE_FOLDER), 'Backspace', { isComposing: true });
		await pressOn(recentRowOf(GONE_FOLDER), 'Delete', { isComposing: true });

		expectNothingRemoved();
	});

	it('右クリックのメニューが開いている間は何もしない(メニューは開いたまま)', async () => {
		await mountDashboard();
		invokeMock.mockClear();

		const row = recentRowOf(GONE_FOLDER);
		row.focus();
		await rightClick(row);
		expect(contextMenu.open).toBe(true);
		expect(menuCount()).toBe(1);

		await fireEvent.keyDown(row, { key: 'Delete' });
		await settle();
		await fireEvent.keyDown(row, { key: 'Backspace' });
		await settle();

		expectNothingRemoved();
		expect(contextMenu.open, 'Delete does not close the menu either').toBe(true);
	});

	it('Recently Modified の行・Bookmark のタイル・Add Bookmark…・上の段のボタンでは何もしない', async () => {
		scanResponse = async (generation) => ({ generation, files: [F1], folders: 1, truncated: false });
		await mountDashboard();
		invokeMock.mockClear();
		expect(modifiedRows()).toHaveLength(1);

		const others: HTMLElement[] = [
			modifiedRows()[0]!,
			tileOf(AURORA),
			tileOf(PLAN),
			document.querySelector<HTMLButtonElement>('.add-bookmark')!,
			buttonByText('Open…')!,
			buttonByText('Select Folder…')!,
		];
		for (const el of others) {
			await pressOn(el, 'Delete');
			await pressOn(el, 'Backspace');
		}

		expectNothingRemoved();
		expect(modifiedRows().map((r) => r.title)).toEqual([F1.uri]);
		expect(tiles().map((t) => t.title)).toEqual([AURORA, PLAN, SSH_FOLDER]);
		expect(callsOf('set_root')).toHaveLength(0);
	});

	it('矢印キーの既存の動き(↑ / ↓)は変わらない', async () => {
		await mountDashboard();
		invokeMock.mockClear();

		await pressOn(recentRowOf(HISTORY[0]!), 'ArrowDown');
		expect(active()?.title).toBe(HISTORY[1]);
		await fireEvent.keyDown(active()!, { key: 'ArrowUp' });
		await tick();
		expect(active()?.title).toBe(HISTORY[0]);
		expectNothingRemoved();
	});
});

// ---------------------------------------------------------------------------
// AC-83-28 の 5 — 外した後のフォーカス(契約13 追補a【推奨】)
// ---------------------------------------------------------------------------

describe('AC-83-28 (5): キーで外した後のフォーカス=同じ位置の行 / 最後なら前の行 / 残らなければ Bookmarks の止まり先。マウスの × は別の場所のフォーカスを動かさない', () => {
	it('真ん中の行(index 2)を Delete → 同じ位置に来た行(元の index 3)にフォーカス・その行が区画の止まり先', async () => {
		await mountDashboard();

		await pressOn(recentRowOf(GONE_FOLDER), 'Delete');

		expect(recentRows().map((r) => r.title)).toEqual([AURORA, SSH_FOLDER, ...HISTORY.slice(3, 7)]);
		const landed = active();
		expect(landed?.classList.contains('recent-folder'), `focus is on a recent row (got ${landed?.outerHTML.slice(0, 80)})`).toBe(true);
		expect(landed?.title).toBe(HISTORY[3]);
		expect(recentRows().indexOf(landed as HTMLButtonElement)).toBe(2);
		expect(landed?.tabIndex, 'the focused row is the tab stop of the section').toBe(0);
		expect(recentRows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
	});

	it('先頭の行を Backspace → 新しい先頭の行へ', async () => {
		await mountDashboard();

		await pressOn(recentRowOf(AURORA), 'Backspace');

		expect(recentRows()[0]?.title).toBe(SSH_FOLDER);
		expect(active()).toBe(recentRows()[0]);
		expect(active()?.tabIndex).toBe(0);
	});

	it('最後の行を Delete(履歴 3 件)→ 前の行へ', async () => {
		history = [AURORA, SSH_FOLDER, GONE_FOLDER];
		await mountDashboard();
		expect(recentRows()).toHaveLength(3);

		await pressOn(recentRowOf(GONE_FOLDER), 'Delete');

		expect(recentRows().map((r) => r.title)).toEqual([AURORA, SSH_FOLDER]);
		expect(active()?.title).toBe(SSH_FOLDER);
		expect(active()?.tabIndex).toBe(0);
	});

	it('広げた状態で最後の行(14 番目)を Delete → 前の行(13 番目)へ', async () => {
		await mountDashboard();
		await fireEvent.click(buttonByText('Show All')!);
		await tick();
		expect(recentRows()).toHaveLength(14);

		await pressOn(recentRowOf(HISTORY[13]!), 'Delete');

		expect(recentRows()).toHaveLength(13);
		expect(active()?.title).toBe(HISTORY[12]);
		expect(active()?.tabIndex).toBe(0);
	});

	it('畳んだ 14 件で見えている最後の行(index 5)を Delete → 7 番目が同じ位置に繰り上がるので、その行(HISTORY[6])へ(前の行ではない=オーケストレーター決定 2026-11-06)', async () => {
		await mountDashboard();
		expect(recentRows()).toHaveLength(6);

		await pressOn(recentRowOf(HISTORY[5]!), 'Delete');

		expect(recentRows().map((r) => r.title)).toEqual([...HISTORY.slice(0, 5), HISTORY[6]!]);
		expect(active()?.title, 'focus moves to the row that took the same position').toBe(HISTORY[6]);
		expect(recentRows().indexOf(active() as HTMLButtonElement)).toBe(5);
		expect(active()?.tabIndex).toBe(0);
		expect(recentRows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
	});

	it('唯一の行を Delete → 行が残らないので Bookmarks の区画の止まり先(tabindex="0" のタイル)へ', async () => {
		history = [GONE_FOLDER];
		await mountDashboard();
		expect(recentRows()).toHaveLength(1);

		await pressOn(recentRowOf(GONE_FOLDER), 'Delete');

		expect(recentRows()).toHaveLength(0);
		expect(textOf(section('recent-folders'))).toContain('No recently opened folders');
		const landed = active();
		expect(section('bookmarks').contains(landed), `focus is inside Bookmarks (got ${landed?.outerHTML.slice(0, 80)})`).toBe(true);
		expect(landed?.tabIndex).toBe(0);
		expect(landed).toBe(tileOf(AURORA));
	});

	it('フォーカスが外した行にあるときのマウスの × → 同じ位置に来た行へ', async () => {
		await mountDashboard();
		recentRowOf(GONE_FOLDER).focus();
		expect(active()).toBe(recentRowOf(GONE_FOLDER));

		await fireEvent.click(removeButtonOf(GONE_FOLDER));
		await settle();

		expect(recentRows().some((r) => r.title === GONE_FOLDER)).toBe(false);
		expect(active()?.title).toBe(HISTORY[3]);
		expect(active()?.tabIndex).toBe(0);
	});

	it('フォーカスが別の場所(タイル)にあるときのマウスの × → フォーカスは動かない', async () => {
		await mountDashboard();
		expect(active()).toBe(tileOf(AURORA));

		await fireEvent.click(removeButtonOf(GONE_FOLDER));
		await settle();

		expect(recentRows().some((r) => r.title === GONE_FOLDER)).toBe(false);
		expect(active()).toBe(tileOf(AURORA));
	});
});

// ---------------------------------------------------------------------------
// AC-83-28 の 6 — Show All との兼ね合い(契約10)
// ---------------------------------------------------------------------------

describe('AC-83-28 (6): 畳んだ状態で外すと 7 番目が繰り上がり 6 of N-1。広げた状態は広げたまま', () => {
	it("畳んだ状態(14 件)で × → 6 行のまま・7 番目が繰り上がる・'6 of 13'・Show All のまま", async () => {
		await mountDashboard();
		expect(textOf(section('recent-folders'))).toContain('6 of 14');

		await fireEvent.click(removeButtonOf(GONE_FOLDER));
		await settle();

		expect(recentRows().map((r) => r.title)).toEqual([AURORA, SSH_FOLDER, ...HISTORY.slice(3, 7)]);
		expect(recentRows()[5]?.title, 'the 7th entry moves up into the 6th row').toBe(HISTORY[6]);
		expect(textOf(section('recent-folders'))).toContain('6 of 13');
		expect(textOf(section('recent-folders'))).not.toContain('6 of 14');
		expect(buttonByText('Show All')).not.toBeNull();
		expect(buttonByText('Show Less')).toBeNull();
	});

	it('畳んだ状態で Delete キー → 同じ(7 番目が繰り上がる)', async () => {
		await mountDashboard();

		await pressOn(recentRowOf(HISTORY[5]!), 'Delete');

		expect(recentRows()).toHaveLength(6);
		expect(recentRows()[5]?.title).toBe(HISTORY[6]);
		expect(textOf(section('recent-folders'))).toContain('6 of 13');
	});

	it("広げた状態で × → 13 行・広げたまま(Show Less のまま)・'6 of 13'", async () => {
		await mountDashboard();
		await fireEvent.click(buttonByText('Show All')!);
		await tick();
		expect(recentRows()).toHaveLength(14);

		await fireEvent.click(removeButtonOf(HISTORY[9]!));
		await settle();

		expect(recentRows().map((r) => r.title)).toEqual(HISTORY.filter((u) => u !== HISTORY[9]));
		expect(buttonByText('Show Less')).not.toBeNull();
		expect(buttonByText('Show All')).toBeNull();
		expect(textOf(section('recent-folders'))).toContain('6 of 13');
	});

	it('7 件から 1 件外して 6 件 → 補足も Show All / Show Less も消える(契約10 の今の規則)', async () => {
		history = HISTORY.slice(0, 7);
		await mountDashboard();
		expect(textOf(section('recent-folders'))).toContain('6 of 7');
		expect(buttonByText('Show All')).not.toBeNull();

		await fireEvent.click(removeButtonOf(HISTORY[1]!));
		await settle();

		expect(recentRows().map((r) => r.title)).toEqual([HISTORY[0], ...HISTORY.slice(2, 7)]);
		expect(textOf(section('recent-folders'))).not.toMatch(/\d+ of \d+/);
		expect(buttonByText('Show All')).toBeNull();
		expect(buttonByText('Show Less')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-83-28 の 7 — 失敗(契約5 (aa)・追補a)
// ---------------------------------------------------------------------------

describe('AC-83-28 (7): remove_history_entry が reject → 行は残り、role="alert" に Could not remove the folder from Recent Folders: <理由>', () => {
	it('× の経路: 行は残る・注記に理由・alert は出ない・ダイアログも出ない', async () => {
		removeFailure = REMOVE_REASON;
		await mountDashboard();
		invokeMock.mockClear();

		await fireEvent.click(removeButtonOf(GONE_FOLDER));
		await settle();

		expect(argsOf('remove_history_entry')).toEqual([{ uri: GONE_FOLDER }]);
		expect(recentRows().map((r) => r.title), 'the rows are unchanged').toEqual(HISTORY.slice(0, 6));
		expect(textOf(section('recent-folders'))).toContain('6 of 14');
		const note = alertNote();
		expect(note, 'a note with role="alert"').not.toBeNull();
		expect(textOf(note)).toBe(removeFailedMessage(REMOVE_REASON));
		expect(alertMock).not.toHaveBeenCalled();
		expect(messageDialogMock).not.toHaveBeenCalled();
		expect(askDialogMock).not.toHaveBeenCalled();
	});

	it('Delete キーの経路: 行は残る・注記に理由', async () => {
		removeFailure = REMOVE_REASON;
		await mountDashboard();
		invokeMock.mockClear();

		await pressOn(recentRowOf(SSH_FOLDER), 'Delete');

		expect(argsOf('remove_history_entry')).toEqual([{ uri: SSH_FOLDER }]);
		expect(recentRows().map((r) => r.title)).toEqual(HISTORY.slice(0, 6));
		expect(textOf(alertNote())).toBe(removeFailedMessage(REMOVE_REASON));
		expect(alertMock).not.toHaveBeenCalled();
	});

	it('右クリックの Remove from Recent Folders の経路(既存の ContextMenu の配線): 行は残る・注記に理由(記録に残すだけを改める)', async () => {
		removeFailure = REMOVE_REASON;
		await mountDashboard();
		invokeMock.mockClear();

		await rightClick(recentRowOf(AURORA));
		await clickItem(REMOVE_LABEL);

		expect(argsOf('remove_history_entry')).toEqual([{ uri: AURORA }]);
		expect(recentRows().map((r) => r.title)).toEqual(HISTORY.slice(0, 6));
		expect(textOf(alertNote())).toBe(removeFailedMessage(REMOVE_REASON));
		expect(contextMenu.open).toBe(false);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it('理由は reject の値をそのまま挟む(要件51): 別の理由なら別の文言', async () => {
		removeFailure = 'No such file or directory (os error 2)';
		await mountDashboard();

		await fireEvent.click(removeButtonOf(GONE_FOLDER));
		await settle();

		expect(textOf(alertNote())).toBe('Could not remove the folder from Recent Folders: No such file or directory (os error 2)');
	});

	it('注記の消え方は開けなかったときの注記と同じ: 次に行を開けたら消える', async () => {
		removeFailure = REMOVE_REASON;
		const { onOpened } = await mountDashboard();
		await fireEvent.click(removeButtonOf(GONE_FOLDER));
		await settle();
		expect(alertNote()).not.toBeNull();

		await fireEvent.click(recentRowOf(HISTORY[3]!));
		await settle();
		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(alertNote()).toBeNull();
	});

	it('失敗の後に直れば外せる(次の × で行が消え、注記も消える)', async () => {
		removeFailure = REMOVE_REASON;
		await mountDashboard();
		await fireEvent.click(removeButtonOf(GONE_FOLDER));
		await settle();
		expect(textOf(alertNote())).toBe(removeFailedMessage(REMOVE_REASON));

		removeFailure = null;
		await fireEvent.click(removeButtonOf(GONE_FOLDER));
		await settle();
		expect(recentRows().some((r) => r.title === GONE_FOLDER)).toBe(false);
		expect(alertNote()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-83-28 の 8 — Tab の止まり先の順は変わらない(契約13 (am))
// ---------------------------------------------------------------------------

describe('AC-83-28 (8): Tab の止まり先の順(契約13 (am))は × が増えても変わらない', () => {
	it('Open… → New Window → Select Folder… → タイル → Recent Folders の行 → Show All → Recently Modified の行 → Rescan(× には止まらない)', async () => {
		scanResponse = async (generation) => ({ generation, files: [F1], folders: 1, truncated: false });
		await mountDashboard();
		const user = userEvent.setup();
		expect(modifiedRows()).toHaveLength(1);

		expect(tiles().filter((t) => t.tabIndex === 0), 'one tab stop among the tiles').toHaveLength(1);
		expect(recentRows().filter((r) => r.tabIndex === 0), 'one tab stop among the recent rows').toHaveLength(1);
		expect(removeButtons().every((b) => b.tabIndex === -1), 'no × is a tab stop').toBe(true);

		buttonByText('Open…')!.focus();
		expect(active()).toBe(buttonByText('Open…'));

		await user.tab();
		expect(active()).toBe(buttonByText('New Window'));
		await user.tab();
		expect(active()).toBe(buttonByText('Select Folder…'));
		await user.tab();
		expect(active()).toBe(tileOf(AURORA));
		await user.tab();
		const row = active();
		expect(row?.classList.contains('recent-folder'), `Tab lands on a recent row (got ${row?.outerHTML.slice(0, 80)})`).toBe(true);
		expect(row?.title).toBe(HISTORY[0]);
		await user.tab();
		expect(textOf(active()), 'Tab skips every × and lands on Show All').toBe('Show All');
		await user.tab();
		expect(active()).toBe(modifiedRows()[0]);
		await user.tab();
		expect(active()?.getAttribute('aria-label')).toBe('Rescan');

		// 逆向きも × を飛ばす。
		await user.tab({ shift: true });
		expect(active()).toBe(modifiedRows()[0]);
		await user.tab({ shift: true });
		expect(textOf(active())).toBe('Show All');
		await user.tab({ shift: true });
		expect(active()?.classList.contains('recent-folder')).toBe(true);
		await user.tab({ shift: true });
		expect(active()).toBe(tileOf(AURORA));
	});

	it('行の区画に入って ↓ で 2 行目へ移った後も、Tab は Show All へ(× を飛ばす)・× に tabindex="-1" のまま', async () => {
		await mountDashboard();
		const user = userEvent.setup();
		expect(active()).toBe(tileOf(AURORA));

		await user.tab();
		expect(active()?.title).toBe(HISTORY[0]);
		await fireEvent.keyDown(active()!, { key: 'ArrowDown' });
		await tick();
		expect(active()?.title).toBe(HISTORY[1]);
		expect(removeButtons().every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);

		await user.tab();
		expect(textOf(active())).toBe('Show All');
	});
});
