/**
 * 要件#64 の受け入れテスト(docs/requirements/req-64.md)— Recent Files の区画の配線
 * (component プロジェクト・`RecentFiles.svelte` を JSDOM に単体マウントする)
 *
 * 判定範囲(AC 番号は req-64.md の受け入れ基準):
 * - AC-64-14 区画の表示(行=ファイル名+相対フォルダ・`aria-current`・0 件の文言・見出しと Clear・
 *   Close 無し・`aria-expanded`・目印・閉じた状態・英語・`data-zoom-region` と `zoom`)(契約6)
 * - AC-64-15 開閉とドラッグ(クリック=開閉と保存・上へ 40px=高さ +40 と保存・2px=クリック扱い・
 *   閉じているときのドラッグは何もしない・Clear では開閉しない)(契約6)
 * - AC-64-16 クリックで開く(confirmDiscardEdits → openForDisplay → windowState → onOpened・
 *   Command + クリック=new_tab・Shift + クリック=new_window・区画は開いたまま)(契約7)
 * - AC-64-17 失敗・消去・読み直し(alert と読み直し・Clear・今の文書の変化で読み直す・閉じている間は
 *   読まない)(契約8〜10)
 * - AC-64-18 ページの配線(`+page.svelte` / `Explorer.svelte` のソース走査)(契約5〜7・10)。
 *   置き場は AC-55-14 のソース走査(FindInFolder.wiring.test.ts)に揃える
 *
 * ## 配線に求める契約(implementer はこれに従う=test-writer 決定 2026-09-28)
 * - 新規 `src/components/RecentFiles.svelte`。props:
 *   `rootUri: string`(今の窓の root・末尾 `/` 無し)・
 *   `currentUri: string | null`(今開いている文書の URI。選択色と、開いている間の読み直しの合図)・
 *   `paneHeight: number`(左ペインの高さ px。高さの上限=paneHeight − MIN_TREE_HEIGHT の材料。
 *   +page.svelte は左ペインの器の `clientHeight` を渡す)・
 *   `explorerZoom?: number`(既定 100=`DEFAULT_ZOOM`。一覧にだけ CSS `zoom` を当てる)・
 *   `onOpened: (uri: string) => void`(この窓で文書を開いた**後**に呼ぶ。+page.svelte はこれを受けて
 *   `ancestorDirs` で祖先を展開し `scrollTreeItemIntoView` で行を見せる)
 *   ※ Go メニュー(Command + Shift + R)で「区画を開いて先頭の行へフォーカス」を +page.svelte から
 *   起こす口(例: 進めるたびに開いてフォーカスする counter prop `openRequest?: number`)は本テストの
 *   判定外=名前と形は implementer 裁量(人間ゲート 7)
 * - testid: `recent-files`(区画の外側の要素。`data-zoom-region="explorer"` を持ち、開いているとき
 *   inline の `height: <n>px` を持つ)・`recent-files-header`(見出し行。`<button>` か `role="button"`・
 *   `aria-expanded` に開閉・pointerdown / pointermove / pointerup で開閉とドラッグ)・
 *   `recent-files-marker`(開閉の目印。閉=› 開=⌄ 相当のテキスト。開閉で文字が変わる)・
 *   `recent-files-title`(見出し `Recent Files`)・`recent-files-clear`(`<button>` `Clear`)・
 *   `recent-files-list`(一覧の器。`explorerZoom !== 100` のとき inline `zoom: <n>%`・100 では宣言無し)・
 *   `recent-files-row`(1 行= `<button>`・`data-uri` と `title` に完全な URI・今の文書なら
 *   `aria-current="true"`)・`recent-files-row-name`・`recent-files-row-folder`・
 *   `recent-files-empty`(0 件の `No recent files`)
 * - 文言は `$lib/recent-files` の定数(`Recent Files` / `No recent files` / `Clear`)。CJK 無し(要件#51)
 * - 開閉・高さの読み書きは `$lib/recent-files-section` だけを通す(区画も +page.svelte も
 *   localStorage / sessionStorage に直接触れない)。高さの保存は pointerup の時点
 * - 見出し行のクリック(3px 未満)で開閉を反転して `saveSectionExpanded`。開いているときの 3px 以上の
 *   上下ドラッグで `dragSectionHeight` の高さを `height` に反映し、離した時点で `saveSectionHeight`
 *   (離しても開閉しない)。閉じているときのドラッグは何もしない。Clear ボタン上の pointer / click は
 *   開閉に使わない(ブラウザは Clear の pointerdown / pointerup も見出し行へバブルさせる)
 * - 読み直し: 開いた状態で描かれたとき・見出し行で開いたとき・開いている間に `currentUri` /
 *   `rootUri` が変わったときに `loadRecentFiles(rootUri)`(= `invoke('list_recent_files', { root })`)。
 *   閉じている間は読まない
 * - 行のクリック: `confirmDiscardEdits()` → 偽なら何もしない → `openForDisplay(uri)`(`.md` は
 *   `open_document`・`.png` は `open_binary_document`)→ `windowState.setDocument` → `onOpened(uri)`。
 *   失敗は `alert(recentFileOpenFailedMessage(err))` して一覧を読み直す(`onOpened` は呼ばない)。
 *   Command + クリック(Shift なし)= `planNewTab` / `openNewTab`(`invoke('new_tab', { path, root,
 *   expandedDirs })`・確認なし)。Shift + クリック= `invoke('new_window', { path, root })`(確認なし)。
 *   どのクリックでも区画は開いたまま
 * - Clear: `invoke('clear_recent_files', { root: rootUri })` の後に一覧を空にする(読み直しでも可)
 *
 * ## スタブの設計(FindInFolder.wiring / Explorer.newtab wiring の家風)
 * - $lib/ipc: モジュールモック。`list_recent_files` はテスト側の配列を返し、`clear_recent_files` は
 *   その配列を空にする(Rust の鏡)。`open_document` / `open_binary_document` は DocumentPayload 形
 *   (失敗させたいときは reject)。`new_tab` / `new_window` はラベルを返す
 * - $lib/edit-guard: confirmDiscardEdits のモック
 * - JSDOM は `setPointerCapture` 系を持たないので Element.prototype に no-op を足す。ポインタ操作は
 *   `pointerdown → (pointermove) → pointerup → click` の列で送る(ブラウザは離した後に click も
 *   送るので、実装が pointerup で開閉しても click で開閉しても同じ列で判定できる)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { invoke } from '$lib/ipc';
import { confirmDiscardEdits } from '$lib/edit-guard';
import RecentFiles from './RecentFiles.svelte';
import { windowState } from '../stores/window-state.svelte';
import {
	MIN_TREE_HEIGHT,
	SECTION_EXPANDED_STORAGE_KEY,
	SECTION_HEIGHT_STORAGE_KEY,
	clampSectionHeight,
	saveSectionExpanded,
	saveSectionHeight,
} from '$lib/recent-files-section';

const invokeMock = vi.mocked(invoke);
const confirmMock = vi.mocked(confirmDiscardEdits);

/** CJK を含まない=英語の判定(要件#51 の走査と同じ考え方)。 */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

const ROOT = 'file:///Users/x/notes';
const OTHER_ROOT = 'file:///Users/x/other';
const MD = `${ROOT}/docs/spec/a.md`;
const PNG = `${ROOT}/img/photo.png`;
const TOP = `${ROOT}/plan.md`;
const SPACED = `${ROOT}/my docs/plan two.md`;
/** 展開中として windowState に入れる URI(new_tab の expandedDirs に載る)。 */
const EXPANDED = `${ROOT}/archive`;
/** 左ペインの高さ(px)。高さの上限= 600 − 100 = 500。 */
const PANE = 600;
/** ドラッグのテストで保存しておく開始時の高さ(px)。 */
const START_HEIGHT = 200;

// JSDOM は pointer capture を実装していない(要件#9 / #42 の仕切りと同じ呼び方を許す)。
const elementProto = Element.prototype as unknown as Record<string, unknown>;
if (typeof elementProto.setPointerCapture !== 'function') {
	elementProto.setPointerCapture = () => {};
	elementProto.releasePointerCapture = () => {};
	elementProto.hasPointerCapture = () => false;
}

/** invoke のモックが `list_recent_files` に返す一覧(Rust の recent-files.json の鏡)。 */
let recent: string[] = [];
/** true なら `open_document` / `open_binary_document` を reject する(「見つからない」)。 */
let openFails = false;

function installInvoke() {
	recent = [];
	openFails = false;
	invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === 'list_recent_files') return [...recent];
		if (cmd === 'clear_recent_files') {
			recent = [];
			return null;
		}
		if (cmd === 'open_document' || cmd === 'open_binary_document') {
			if (openFails) throw new Error(`not found: ${String(args?.uri)}`);
			return { uri: args?.uri, content: '', modified: null };
		}
		if (cmd === 'new_tab' || cmd === 'new_window') return 'vellis-2';
		return null;
	});
}

/** command 名で invoke の呼び出しを引く。 */
const callsOf = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd);
const listCalls = () => callsOf('list_recent_files');

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

type MountOptions = {
	rootUri?: string;
	currentUri?: string | null;
	paneHeight?: number;
	explorerZoom?: number;
};

/** 区画をマウントする。`explorerZoom` は渡したときだけ props に載せる(既定 100 の判定用)。 */
function mountSection(options: MountOptions = {}) {
	/** onOpened が呼ばれた時点で windowState に入っていた文書の URI(「開いた後に呼ぶ」の判定)。 */
	const seenAtOpened: (string | null | undefined)[] = [];
	const onOpened = vi.fn((_uri: string) => {
		seenAtOpened.push(windowState.currentDocument?.uri ?? null);
	});
	const props: Record<string, unknown> = {
		rootUri: options.rootUri ?? ROOT,
		currentUri: options.currentUri ?? null,
		paneHeight: options.paneHeight ?? PANE,
		onOpened,
	};
	if (options.explorerZoom !== undefined) props.explorerZoom = options.explorerZoom;
	const utils = render(RecentFiles, { props: props as never });
	return { onOpened, seenAtOpened, ...utils };
}

const section = () => screen.getByTestId('recent-files') as HTMLElement;
const header = () => screen.getByTestId('recent-files-header') as HTMLElement;
const marker = () => screen.getByTestId('recent-files-marker') as HTMLElement;
const title = () => screen.getByTestId('recent-files-title') as HTMLElement;
const clearButton = () => screen.getByTestId('recent-files-clear') as HTMLButtonElement;
const list = () => screen.queryByTestId('recent-files-list') as HTMLElement | null;
const rows = () => screen.queryAllByTestId('recent-files-row') as HTMLElement[];
const emptyNote = () => screen.queryByTestId('recent-files-empty');
const expanded = () => header().getAttribute('aria-expanded');
const heightOf = () => Number.parseFloat(section().style.height);

/** マウント後の読み込み(list_recent_files → 行の描画)を待つ。 */
async function loaded(count: number) {
	await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(1));
	await waitFor(() => expect(rows()).toHaveLength(count));
	await settle();
}

/** inline の `zoom` 宣言があるか(Explorer.zoom.wiring と同じ見方)。 */
function hasInlineZoom(el: HTMLElement): boolean {
	if (el.style.getPropertyValue('zoom') !== '') return true;
	return /(^|;)\s*zoom\s*:/i.test(el.getAttribute('style') ?? '');
}

/** ポインタイベントを 1 つ送る(JSDOM 29 は PointerEvent を持つ。無い環境では MouseEvent)。 */
function pointer(el: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', clientY: number) {
	const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
	const init: Record<string, unknown> = {
		bubbles: true,
		cancelable: true,
		composed: true,
		clientX: 20,
		clientY,
		button: 0,
		buttons: type === 'pointerup' ? 0 : 1,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true,
	};
	el.dispatchEvent(new Ctor(type, init as MouseEventInit));
}

/**
 * 押して(必要なら動かして)離す。ブラウザと同じく、離した後に同じ要素へ click も送る
 * (pointerup で開閉する実装でも click で開閉する実装でも同じ列で判定する)。
 */
async function press(el: Element, fromY: number, toY: number = fromY) {
	pointer(el, 'pointerdown', fromY);
	await tick();
	if (toY !== fromY) {
		pointer(el, 'pointermove', toY);
		await tick();
	}
	pointer(el, 'pointerup', toY);
	await tick();
	await fireEvent.click(el, { clientX: 20, clientY: toY });
	await settle();
}

const alertMock = vi.fn((_message?: unknown) => {});

beforeEach(() => {
	installInvoke();
	confirmMock.mockResolvedValue(true);
	windowState.applyRoot(ROOT, [], false);
	windowState.setExpandedDirs([EXPANDED, EXPANDED]);
	Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
	alertMock.mockClear();
	vi.stubGlobal('alert', alertMock);
	try {
		localStorage.clear();
		sessionStorage.clear();
	} catch {
		// storage が無い環境は無視
	}
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-64-14 — 区画の表示(契約6)
// ---------------------------------------------------------------------------

describe('AC-64-14: 区画の表示 — 行・aria-current・0 件・見出しと Clear・aria-expanded・目印・閉じた状態(契約6)', () => {
	it('開いた状態で描かれると list_recent_files が { root } で 1 回呼ばれ、渡した順に 3 行が出る', async () => {
		recent = [MD, PNG, TOP];
		mountSection();
		await loaded(3);

		expect(listCalls()).toHaveLength(1);
		expect(listCalls()[0][1]).toEqual({ root: ROOT });
		expect(expanded()).toBe('true');
		expect(rows().map((r) => r.getAttribute('data-uri'))).toEqual([MD, PNG, TOP]);
		expect(rows().map((r) => r.getAttribute('title'))).toEqual([MD, PNG, TOP]);
		for (const row of rows()) expect(row.tagName, 'a row is a button (Tab / Enter work)').toBe('BUTTON');
	});

	it('各行にファイル名(太め)と root からの相対フォルダ(root 直下は空)が出る', async () => {
		recent = [MD, PNG, TOP];
		mountSection();
		await loaded(3);

		const name = (row: HTMLElement) =>
			row.querySelector('[data-testid="recent-files-row-name"]')?.textContent?.trim();
		const folder = (row: HTMLElement) =>
			row.querySelector('[data-testid="recent-files-row-folder"]')?.textContent?.trim();
		expect(rows().map(name)).toEqual(['a.md', 'photo.png', 'plan.md']);
		expect(rows().map(folder)).toEqual(['docs/spec', 'img', '']);
	});

	it('空白を含むパスは %エンコードせずそのまま出る(名前・フォルダ・title)', async () => {
		recent = [SPACED];
		mountSection();
		await loaded(1);

		const row = rows()[0];
		expect(row.querySelector('[data-testid="recent-files-row-name"]')?.textContent?.trim()).toBe('plan two.md');
		expect(row.querySelector('[data-testid="recent-files-row-folder"]')?.textContent?.trim()).toBe('my docs');
		expect(row.getAttribute('title')).toBe(SPACED);
		expect(row.getAttribute('title')).not.toContain('%20');
	});

	it('今開いている文書(currentUri)の行だけに aria-current="true" がある', async () => {
		recent = [MD, PNG, TOP];
		mountSection({ currentUri: PNG });
		await loaded(3);

		expect(rows()[1].getAttribute('aria-current')).toBe('true');
		expect(rows()[0].getAttribute('aria-current')).not.toBe('true');
		expect(rows()[2].getAttribute('aria-current')).not.toBe('true');
	});

	it('文書を開いていない(currentUri=null)ときは、どの行にも aria-current="true" が無い', async () => {
		recent = [MD, PNG, TOP];
		mountSection({ currentUri: null });
		await loaded(3);

		for (const row of rows()) expect(row.getAttribute('aria-current')).not.toBe('true');
	});

	it('0 件では `No recent files` が出て、行は無い', async () => {
		recent = [];
		mountSection();
		await waitFor(() => expect(listCalls()).toHaveLength(1));
		await waitFor(() => expect(emptyNote()).toBeTruthy());

		expect(emptyNote()?.textContent?.trim()).toBe('No recent files');
		expect(rows()).toHaveLength(0);
	});

	it('見出し行: 見出し `Recent Files`・ボタン `Clear`・`Close` ボタンは無い・見出し行はボタンとして振る舞う', async () => {
		recent = [MD];
		mountSection();
		await loaded(1);

		expect(title().textContent?.trim()).toBe('Recent Files');
		expect(clearButton().tagName).toBe('BUTTON');
		expect(clearButton().textContent?.trim()).toBe('Clear');
		expect(header().contains(clearButton()), 'Clear sits in the header row').toBe(true);
		const closeButtons = [...section().querySelectorAll('button')].filter(
			(b) => b.textContent?.trim() === 'Close' || b.getAttribute('aria-label') === 'Close'
		);
		expect(closeButtons, 'no Close button (the section is not a swapped-in panel)').toHaveLength(0);
		const actsAsButton = header().tagName === 'BUTTON' || header().getAttribute('role') === 'button';
		expect(actsAsButton, 'the header row is a button (or role="button") that toggles').toBe(true);
	});

	it('見出し行の aria-expanded が開閉に一致し、目印の文字が開閉で変わる(CJK 無し)', async () => {
		recent = [MD];
		mountSection();
		await loaded(1);
		expect(expanded()).toBe('true');
		const openMarker = marker().textContent?.trim() ?? '';
		expect(openMarker.length).toBeGreaterThan(0);
		expect(openMarker).not.toMatch(CJK);
		cleanup();

		saveSectionExpanded(false);
		mountSection();
		await settle();
		expect(expanded()).toBe('false');
		const closedMarker = marker().textContent?.trim() ?? '';
		expect(closedMarker.length).toBeGreaterThan(0);
		expect(closedMarker).not.toMatch(CJK);
		expect(closedMarker).not.toBe(openMarker);
	});

	it('閉じた状態では一覧の行も `No recent files` も描かない(見出し行だけ)し、読み込みもしない', async () => {
		saveSectionExpanded(false);
		recent = [MD, PNG, TOP];
		mountSection();
		await settle();

		expect(expanded()).toBe('false');
		expect(rows()).toHaveLength(0);
		expect(emptyNote()).toBeNull();
		expect(section().textContent ?? '').not.toContain('No recent files');
		expect(title().textContent?.trim()).toBe('Recent Files');
		expect(listCalls()).toHaveLength(0);
	});

	it('区画の文字列に CJK が無い(要件#51)— 行が出ている状態で textContent と title / aria-label', async () => {
		recent = [MD, PNG, TOP];
		mountSection({ currentUri: MD });
		await loaded(3);

		expect(section().textContent ?? '').not.toMatch(CJK);
		for (const el of [section(), ...section().querySelectorAll('*')]) {
			for (const attr of ['title', 'aria-label']) {
				const value = el.getAttribute(attr);
				if (value !== null) expect(value, `${attr} on <${el.tagName.toLowerCase()}>`).not.toMatch(CJK);
			}
		}
	});
});

describe('AC-64-14: 区画は Explorer の領域(data-zoom-region="explorer")に属し、一覧にだけ zoom が当たる(要件#63)', () => {
	it('区画の外側の要素が data-zoom-region="explorer" を持ち、見出し行も一覧もその中にある', async () => {
		recent = [MD];
		mountSection();
		await loaded(1);

		expect(section().getAttribute('data-zoom-region')).toBe('explorer');
		expect(header().closest('[data-zoom-region]')).toBe(section());
		expect(rows()[0].closest('[data-zoom-region]')).toBe(section());
		expect(section().querySelectorAll('[data-zoom-region]'), 'no nested region marker').toHaveLength(0);
	});

	it('explorerZoom=150 で一覧に zoom: 150% が付き、見出し行と区画の外側には付かない', async () => {
		recent = [MD];
		mountSection({ explorerZoom: 150 });
		await loaded(1);

		const listEl = list();
		expect(listEl, 'recent-files-list exists while expanded').toBeTruthy();
		expect((listEl as HTMLElement).style.getPropertyValue('zoom')).toBe('150%');
		expect(hasInlineZoom(header())).toBe(false);
		expect(hasInlineZoom(section())).toBe(false);
		expect(hasInlineZoom(clearButton())).toBe(false);
	});

	it('explorerZoom=100(既定・省略)では zoom の宣言そのものを出さない(Explorer と同じ流儀)', async () => {
		recent = [MD];
		mountSection({ explorerZoom: 100 });
		await loaded(1);
		expect(hasInlineZoom(list() as HTMLElement)).toBe(false);
		expect(hasInlineZoom(header())).toBe(false);
		cleanup();

		mountSection();
		await loaded(1);
		expect(hasInlineZoom(list() as HTMLElement)).toBe(false);
		expect(hasInlineZoom(header())).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-64-15 — 開閉とドラッグ(契約6)
// ---------------------------------------------------------------------------

describe('AC-64-15: 見出し行のクリックで開閉が反転し、開閉の保存が更新される(契約6)', () => {
	it('pointerdown → pointerup(移動 0)で 開 → 閉 → 開。保存キーが false / true と更新される', async () => {
		recent = [MD, PNG];
		mountSection();
		await loaded(2);
		expect(expanded()).toBe('true');

		await press(header(), 300);
		expect(expanded()).toBe('false');
		expect(localStorage.getItem(SECTION_EXPANDED_STORAGE_KEY)).toBe('false');
		expect(rows()).toHaveLength(0);
		expect(emptyNote()).toBeNull();

		await press(header(), 300);
		expect(expanded()).toBe('true');
		expect(localStorage.getItem(SECTION_EXPANDED_STORAGE_KEY)).toBe('true');
		await waitFor(() => expect(rows()).toHaveLength(2));
	});

	it('閉じた状態で描かれた区画も、クリックで開いて保存が true になる', async () => {
		saveSectionExpanded(false);
		recent = [MD];
		mountSection();
		await settle();
		expect(expanded()).toBe('false');

		await press(header(), 300);

		expect(expanded()).toBe('true');
		expect(localStorage.getItem(SECTION_EXPANDED_STORAGE_KEY)).toBe('true');
		await waitFor(() => expect(rows()).toHaveLength(1));
	});
});

describe('AC-64-15: 見出し行の上下ドラッグで高さが変わり、離した時点で保存される(契約6)', () => {
	it('開いた状態で上へ 40px ドラッグ → 区画の高さ(style)が 40px 増え、保存され、開閉は変わらない', async () => {
		saveSectionHeight(START_HEIGHT);
		recent = [MD];
		mountSection();
		await loaded(1);
		const before = heightOf();
		expect(before, 'the saved height is applied at mount (clamped to the pane)').toBe(
			clampSectionHeight(START_HEIGHT, PANE)
		);

		await press(header(), 300, 260);

		expect(heightOf()).toBe(before + 40);
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe(String(before + 40));
		expect(expanded()).toBe('true');
		expect(localStorage.getItem(SECTION_EXPANDED_STORAGE_KEY)).not.toBe('false');
		expect(rows()).toHaveLength(1);
	});

	it('下へ 30px ドラッグ → 高さが 30px 減る(範囲内)', async () => {
		saveSectionHeight(START_HEIGHT);
		recent = [MD];
		mountSection();
		await loaded(1);
		const before = heightOf();

		await press(header(), 300, 330);

		expect(heightOf()).toBe(clampSectionHeight(before - 30, PANE));
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe(String(clampSectionHeight(before - 30, PANE)));
		expect(expanded()).toBe('true');
	});

	it('paneHeight を超えて引いても最大(paneHeight − MIN_TREE_HEIGHT)で止まる=prop の paneHeight が上限の材料', async () => {
		saveSectionHeight(START_HEIGHT);
		recent = [MD];
		mountSection({ paneHeight: PANE });
		await loaded(1);

		await press(header(), 300, -1000);

		expect(heightOf()).toBe(PANE - MIN_TREE_HEIGHT);
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe(String(PANE - MIN_TREE_HEIGHT));
		expect(expanded()).toBe('true');
	});

	it('2px の移動では開閉だけが反転し、高さの保存は変わらない(クリック扱い)', async () => {
		saveSectionHeight(START_HEIGHT);
		recent = [MD];
		mountSection();
		await loaded(1);

		await press(header(), 300, 298);

		expect(expanded()).toBe('false');
		expect(localStorage.getItem(SECTION_EXPANDED_STORAGE_KEY)).toBe('false');
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe(String(START_HEIGHT));
	});

	it('閉じた状態で 40px ドラッグしても開かず、高さの保存も変わらない', async () => {
		saveSectionExpanded(false);
		saveSectionHeight(START_HEIGHT);
		recent = [MD];
		mountSection();
		await settle();
		expect(expanded()).toBe('false');

		await press(header(), 300, 260);

		expect(expanded()).toBe('false');
		expect(localStorage.getItem(SECTION_EXPANDED_STORAGE_KEY)).toBe('false');
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe(String(START_HEIGHT));
		expect(rows()).toHaveLength(0);
		expect(listCalls()).toHaveLength(0);
	});

	it('Clear のクリック(pointerdown / pointerup / click が見出し行へバブルしても)では開閉しない', async () => {
		saveSectionHeight(START_HEIGHT);
		recent = [MD, PNG];
		mountSection();
		await loaded(2);

		pointer(clearButton(), 'pointerdown', 300);
		await tick();
		pointer(clearButton(), 'pointerup', 300);
		await tick();
		await fireEvent.click(clearButton());
		await settle();

		expect(expanded()).toBe('true');
		expect(localStorage.getItem(SECTION_EXPANDED_STORAGE_KEY)).not.toBe('false');
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe(String(START_HEIGHT));
		expect(callsOf('clear_recent_files')).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// AC-64-16 — クリックで開く(契約7)
// ---------------------------------------------------------------------------

describe('AC-64-16: 行のクリック → confirmDiscardEdits → openForDisplay → windowState → onOpened(契約7)', () => {
	it('.md の行 → confirmDiscardEdits の後に open_document { uri } が 1 回・windowState の文書がその URI・onOpened(uri) が 1 回(開いた後)', async () => {
		recent = [MD, PNG, TOP];
		const { onOpened, seenAtOpened } = mountSection();
		await loaded(3);

		await fireEvent.click(rows()[0]);
		await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
		await settle();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(callsOf('open_document')).toHaveLength(1);
		expect(callsOf('open_document')[0][1]).toEqual({ uri: MD });
		expect(callsOf('open_binary_document')).toHaveLength(0);
		const openIndex = invokeMock.mock.calls.findIndex((c) => c[0] === 'open_document');
		expect(confirmMock.mock.invocationCallOrder[0]).toBeLessThan(invokeMock.mock.invocationCallOrder[openIndex]);
		expect(windowState.currentDocument?.uri).toBe(MD);
		expect(onOpened.mock.calls[0][0]).toBe(MD);
		expect(seenAtOpened, 'onOpened is called after the document is in windowState').toEqual([MD]);
		expect(callsOf('new_tab')).toHaveLength(0);
		expect(callsOf('new_window')).toHaveLength(0);
		expect(expanded(), 'the section stays open').toBe('true');
	});

	it('.png の行 → open_binary_document { uri }(ラスタ画像は読まずに開く=要件#22)', async () => {
		recent = [MD, PNG, TOP];
		const { onOpened } = mountSection();
		await loaded(3);

		await fireEvent.click(rows()[1]);
		await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));

		expect(callsOf('open_binary_document')).toHaveLength(1);
		expect(callsOf('open_binary_document')[0][1]).toEqual({ uri: PNG });
		expect(callsOf('open_document')).toHaveLength(0);
		expect(windowState.currentDocument?.uri).toBe(PNG);
		expect(onOpened.mock.calls[0][0]).toBe(PNG);
		expect(expanded()).toBe('true');
	});

	it('confirmDiscardEdits が false なら何も開かず onOpened も呼ばれない(区画は開いたまま)', async () => {
		confirmMock.mockResolvedValue(false);
		recent = [MD, PNG, TOP];
		const { onOpened } = mountSection();
		await loaded(3);

		await fireEvent.click(rows()[0]);
		await settle();
		await settle();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(callsOf('open_document')).toHaveLength(0);
		expect(callsOf('open_binary_document')).toHaveLength(0);
		expect(onOpened).not.toHaveBeenCalled();
		expect(windowState.currentDocument).toBeNull();
		expect(expanded()).toBe('true');
	});

	it("Command + クリック → invoke('new_tab', { path, root, expandedDirs }) が 1 回。confirmDiscardEdits と open_document は呼ばない", async () => {
		recent = [MD, PNG, TOP];
		const { onOpened } = mountSection();
		await loaded(3);

		await fireEvent.click(rows()[0], { metaKey: true });
		await waitFor(() => expect(callsOf('new_tab')).toHaveLength(1));
		await settle();

		expect(callsOf('new_tab')[0][1]).toEqual({
			path: MD,
			root: ROOT,
			// windowState.expandedDirs の [EXPANDED, EXPANDED] は normalizeExpandedDirs で重複除去される。
			expandedDirs: [EXPANDED],
		});
		expect(confirmMock).not.toHaveBeenCalled();
		expect(callsOf('open_document')).toHaveLength(0);
		expect(callsOf('open_binary_document')).toHaveLength(0);
		expect(callsOf('new_window')).toHaveLength(0);
		expect(onOpened).not.toHaveBeenCalled();
		expect(windowState.currentDocument).toBeNull();
		expect(expanded()).toBe('true');
	});

	it("Shift + クリック → invoke('new_window', { path, root }) が 1 回。confirmDiscardEdits と open_document は呼ばない", async () => {
		recent = [MD, PNG, TOP];
		const { onOpened } = mountSection();
		await loaded(3);

		await fireEvent.click(rows()[2], { shiftKey: true });
		await waitFor(() => expect(callsOf('new_window')).toHaveLength(1));
		await settle();

		expect(callsOf('new_window')[0][1]).toEqual({ path: TOP, root: ROOT });
		expect(confirmMock).not.toHaveBeenCalled();
		expect(callsOf('open_document')).toHaveLength(0);
		expect(callsOf('open_binary_document')).toHaveLength(0);
		expect(callsOf('new_tab')).toHaveLength(0);
		expect(onOpened).not.toHaveBeenCalled();
		expect(windowState.currentDocument).toBeNull();
		expect(expanded()).toBe('true');
	});
});

// ---------------------------------------------------------------------------
// AC-64-17 — 失敗・消去・読み直し(契約8〜10)
// ---------------------------------------------------------------------------

describe('AC-64-17: 開くのが失敗すると alert が出て一覧を読み直す(契約8)', () => {
	it('open_document が reject → alert(`Could not open the file: …`)が 1 回・list_recent_files がもう一度・onOpened は呼ばれない', async () => {
		recent = [MD, PNG, TOP];
		const { onOpened } = mountSection();
		await loaded(3);
		expect(listCalls()).toHaveLength(1);
		openFails = true;
		// Rust が「見つからない」で除いた後の一覧(読み直すと消えた行が無くなる)。
		recent = [PNG, TOP];

		await fireEvent.click(rows()[0]);
		await waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(listCalls()).toHaveLength(2));
		await settle();

		expect(String(alertMock.mock.calls[0][0])).toMatch(/^Could not open the file: /);
		expect(String(alertMock.mock.calls[0][0])).not.toMatch(CJK);
		expect(onOpened).not.toHaveBeenCalled();
		expect(windowState.currentDocument).toBeNull();
		expect(listCalls()[1][1]).toEqual({ root: ROOT });
		await waitFor(() => expect(rows().map((r) => r.getAttribute('data-uri'))).toEqual([PNG, TOP]));
		expect(expanded()).toBe('true');
	});
});

describe('AC-64-17: Clear → clear_recent_files { root } の後に一覧が空になる(契約9)', () => {
	it('Clear のクリックで clear_recent_files が { root } で 1 回・行が消えて `No recent files`・確認ダイアログは出さない', async () => {
		recent = [MD, PNG, TOP];
		mountSection();
		await loaded(3);

		await fireEvent.click(clearButton());
		await waitFor(() => expect(callsOf('clear_recent_files')).toHaveLength(1));
		await waitFor(() => expect(rows()).toHaveLength(0));
		await settle();

		expect(callsOf('clear_recent_files')[0][1]).toEqual({ root: ROOT });
		expect(emptyNote()?.textContent?.trim()).toBe('No recent files');
		expect(confirmMock).not.toHaveBeenCalled();
		expect(expanded()).toBe('true');
	});
});

describe('AC-64-17: 反映の時機 — 開いている間は今の文書 / root が変わるたびに読み直し、閉じている間は読まない(契約10)', () => {
	it('開いた状態で currentUri(prop)が変わると list_recent_files がもう一度呼ばれ、aria-current が移る', async () => {
		recent = [MD, PNG, TOP];
		const { rerender } = mountSection({ currentUri: null });
		await loaded(3);
		expect(listCalls()).toHaveLength(1);
		// 開いた文書が先頭へ来た後の一覧(Rust が記録した鏡)。
		recent = [PNG, MD, TOP];

		await rerender({ currentUri: PNG });
		await waitFor(() => expect(listCalls()).toHaveLength(2));
		await settle();

		expect(listCalls()[1][1]).toEqual({ root: ROOT });
		await waitFor(() => expect(rows().map((r) => r.getAttribute('data-uri'))).toEqual([PNG, MD, TOP]));
		expect(rows()[0].getAttribute('aria-current')).toBe('true');
		expect(rows()[1].getAttribute('aria-current')).not.toBe('true');
	});

	it('開いた状態で rootUri(prop)が変わると、新しい root で読み直す(↑・Open Folder…=契約10)', async () => {
		recent = [MD];
		const { rerender } = mountSection();
		await loaded(1);
		recent = [`${OTHER_ROOT}/x.md`];

		await rerender({ rootUri: OTHER_ROOT });
		await waitFor(() => expect(listCalls()).toHaveLength(2));
		await settle();

		expect(listCalls()[1][1]).toEqual({ root: OTHER_ROOT });
		await waitFor(() => expect(rows().map((r) => r.getAttribute('data-uri'))).toEqual([`${OTHER_ROOT}/x.md`]));
	});

	it('閉じた状態では currentUri が変わっても呼ばれず、見出し行で開いたときに 1 回呼ばれる', async () => {
		saveSectionExpanded(false);
		recent = [MD, PNG, TOP];
		const { rerender } = mountSection({ currentUri: null });
		await settle();
		expect(listCalls()).toHaveLength(0);

		await rerender({ currentUri: PNG });
		await settle();
		await settle();
		expect(listCalls()).toHaveLength(0);
		expect(rows()).toHaveLength(0);

		await press(header(), 300);
		await waitFor(() => expect(listCalls()).toHaveLength(1));
		await waitFor(() => expect(rows()).toHaveLength(3));
		expect(listCalls()[0][1]).toEqual({ root: ROOT });
		expect(rows()[1].getAttribute('aria-current')).toBe('true');
	});
});

// ---------------------------------------------------------------------------
// AC-64-18 — ページの配線(+page.svelte / Explorer.svelte のソース走査)(契約5〜7・10)
// ---------------------------------------------------------------------------

describe('AC-64-18(ソース走査): +page.svelte が Command + Shift + R を受けて区画を出し、Explorer の下に積む・Explorer.svelte は不変(契約5〜7・10)', () => {
	const page = () => readFileSync(resolve(__dirname, '../routes/+page.svelte'), 'utf-8');
	const explorer = () => readFileSync(resolve(__dirname, 'Explorer.svelte'), 'utf-8');
	const componentSource = () => readFileSync(resolve(__dirname, 'RecentFiles.svelte'), 'utf-8');
	const libSource = () => readFileSync(resolve(__dirname, '../lib/recent-files.ts'), 'utf-8');

	/** コメント(`//`・`/* … *\/`・`<!-- … -->`)を落とす(要件#51 の走査と同じ考え方の簡易版)。 */
	const withoutComments = (src: string) =>
		src
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/(^|[^:])\/\/.*$/gm, '$1');

	it('+page.svelte が MENU_RECENT_FILES_EVENT を $lib/recent-files から import して listen する', () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*MENU_RECENT_FILES_EVENT[^}]*\}\s*from\s*'\$lib\/recent-files'/);
		expect(src).toMatch(/listen\(\s*MENU_RECENT_FILES_EVENT\s*,/);
	});

	it('+page.svelte は区画を出すガードに shouldShowRecentFiles を使う(root 無し・履歴選択画面・検索パネル)', () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*shouldShowRecentFiles[^}]*\}\s*from\s*'\$lib\/recent-files'/);
		expect(src).toMatch(/shouldShowRecentFiles\(/);
	});

	it('+page.svelte が RecentFiles を rootUri / onOpened / explorerZoom(と currentUri / paneHeight)付きでマウントする', () => {
		const src = page();
		expect(src).toMatch(/import RecentFiles from '\.\.\/components\/RecentFiles\.svelte'/);
		const tag = /<RecentFiles\b([\s\S]*?)\/>/.exec(src);
		expect(tag, '<RecentFiles … /> tag exists').toBeTruthy();
		const attrs = (tag as RegExpExecArray)[1];
		expect(attrs).toMatch(/\brootUri=/);
		expect(attrs).toMatch(/\bonOpened=/);
		expect(attrs).toMatch(/\bexplorerZoom=/);
		// test-writer 決定: 今の文書と左ペインの高さも prop で渡す(区画の読み直しの合図と高さの上限の材料)。
		expect(attrs).toMatch(/\bcurrentUri=/);
		expect(attrs).toMatch(/\bpaneHeight=/);
	});

	it('<RecentFiles は検索パネルの分岐({#if showFindInFolder})の外=Explorer 側にあり、<Explorer と <FindInFolder は残る', () => {
		const src = page();
		const ifAt = src.indexOf('{#if showFindInFolder}');
		expect(ifAt, '{#if showFindInFolder} still swaps the panel in (要件#55 の形は不変)').toBeGreaterThanOrEqual(0);
		const elseAt = src.indexOf('{:else}', ifAt);
		expect(elseAt).toBeGreaterThan(ifAt);
		expect(src.slice(ifAt, elseAt), 'the search-panel branch must not hold the section').not.toContain('<RecentFiles');
		expect(src.indexOf('<RecentFiles'), 'the section is mounted on the Explorer side').toBeGreaterThan(elseAt);
		expect(src).toMatch(/<Explorer\b/);
		expect(src).toMatch(/<FindInFolder[\s\S]*?rootUri=/);
	});

	it('Recent Files 用の sessionStorage / localStorage のキーを +page.svelte・RecentFiles.svelte・recent-files.ts は持たない(保存は recent-files-section.ts の中だけ)', () => {
		for (const line of page().split('\n')) {
			if (/(local|session)Storage/.test(line)) {
				expect(line, '+page.svelte must not persist anything for Recent Files itself').not.toMatch(/recent/i);
			}
		}
		expect(withoutComments(componentSource())).not.toMatch(/(local|session)Storage/);
		expect(withoutComments(libSource())).not.toMatch(/(local|session)Storage/);
		expect(withoutComments(componentSource())).toMatch(/\$lib\/recent-files-section/);
	});

	it('Explorer.svelte は Recent Files を知らない(見出し行にボタンを足していない=契約12)', () => {
		const src = explorer();
		for (const token of ['Recent Files', 'list_recent_files', 'MENU_RECENT_FILES_EVENT', 'menu_recent_files', 'onRecentFiles']) {
			expect(src, `Explorer.svelte must not contain "${token}"`).not.toContain(token);
		}
	});
});
