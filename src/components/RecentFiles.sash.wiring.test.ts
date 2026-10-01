/**
 * 要件#64 追補c の受け入れテスト(docs/requirements/req-64.md「追補c」)— Recent Files の区画の
 * 境目のつかみ所(sash)とリサイズのカーソル
 * (component プロジェクト・`RecentFiles.svelte` を JSDOM に単体マウントする)
 *
 * 判定範囲:
 * - AC-64-20 つかみ所(契約 追補c 1〜4):
 *   1. 開いた状態でつかみ所の要素があり、閉じた状態では無い(閉じているときは出さない)
 *   2. つかみ所の上で pointerdown → pointermove(上へ 40px)→ pointerup で区画の高さが 40px 増えて
 *      保存され、開閉は変わらない(見出し行のドラッグと同じ `dragSectionHeight` の範囲・保存は
 *      離した時点)
 *   3. つかみ所は**ドラッグ専用**: 3px 未満(0px・2px)で離して click まで届いても開閉しない
 *   4. ソース走査: `RecentFiles.svelte` の `<style>` に、つかみ所へ `cursor: ns-resize` を当てる規則が
 *      ある(ドラッグ中だけの `.dragging` 条件付きではない=ポインタを載せただけで出る)。見出し行の
 *      それ以外の場所のカーソルは `pointer` のまま(契約 追補c 5)
 *   既存の AC-64-14〜18(`RecentFiles.wiring.test.ts`)は無改変で緑であること(このファイルは足すだけ)
 *
 * ## 配線に求める契約(implementer はこれに従う=test-writer 決定 2026-09-30)
 * - testid `recent-files-sash`(つかみ所。区画が開いているときだけ描く。見出し行
 *   `recent-files-header` とは別の要素)。クラス `recent-files-sash` を持ち、`<style>` に
 *   `.recent-files-sash`(単独・`.recent-files .recent-files-sash` のような修飾も可。`.dragging`
 *   で条件付けしない)へ `cursor: ns-resize` を当てる規則を書く
 * - DOM の置き場(区画の子か・見出し行の中か)は implementer 裁量。本テストは testid で探し、置き場に
 *   依存しない(イベントはつかみ所の要素に直接送る。見出し行へバブルしても開閉しないことは 3 で見る)
 * - つかみ所の pointerdown / pointermove / pointerup で、見出し行のドラッグと同じく `dragSectionHeight`
 *   の高さを区画の inline `height` に反映し、離した時点で `saveSectionHeight`。移動中は保存しない。
 *   3px 未満で離しても開閉しない(`saveSectionExpanded` も呼ばない)
 *
 * ## スタブの設計(RecentFiles.wiring.test.ts と同じ家風)
 * - $lib/ipc: モジュールモック(`list_recent_files` はテスト側の配列を返す)
 * - $lib/edit-guard・tauri plugin-opener / plugin-dialog: モジュールモック(区画の import 先が要る)
 * - JSDOM は `setPointerCapture` 系を持たないので Element.prototype に no-op を足す。ポインタ操作は
 *   `pointerdown → (pointermove) → pointerup → click` の列で送る(ブラウザは離した後に click も送る)
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

const ROOT = 'file:///Users/x/notes';
const MD = `${ROOT}/docs/spec/a.md`;
/** 左ペインの高さ(px)。高さの上限= 600 − 100 = 500。 */
const PANE = 600;
/** ドラッグのテストで保存しておく開始時の高さ(px)。 */
const START_HEIGHT = 200;

/** つかみ所の testid とクラス名(test-writer 決定 2026-09-30・追補c)。 */
const SASH_TESTID = 'recent-files-sash';
const SASH_CLASS = 'recent-files-sash';

// JSDOM は pointer capture を実装していない(要件#9 / #42 の仕切りと同じ呼び方を許す)。
const elementProto = Element.prototype as unknown as Record<string, unknown>;
if (typeof elementProto.setPointerCapture !== 'function') {
	elementProto.setPointerCapture = () => {};
	elementProto.releasePointerCapture = () => {};
	elementProto.hasPointerCapture = () => false;
}

/** invoke のモックが `list_recent_files` に返す一覧。 */
let recent: string[] = [];

function installInvoke() {
	recent = [];
	invokeMock.mockImplementation(async (cmd: string) => {
		if (cmd === 'list_recent_files') return [...recent];
		if (cmd === 'clear_recent_files') {
			recent = [];
			return null;
		}
		return null;
	});
}

const listCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'list_recent_files');

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

function mountSection() {
	return render(RecentFiles, {
		props: {
			rootUri: ROOT,
			currentUri: null,
			paneHeight: PANE,
			onOpened: vi.fn(),
		} as never,
	});
}

const section = () => screen.getByTestId('recent-files') as HTMLElement;
const header = () => screen.getByTestId('recent-files-header') as HTMLElement;
const sash = () => screen.getByTestId(SASH_TESTID) as HTMLElement;
const sashOrNull = () => screen.queryByTestId(SASH_TESTID) as HTMLElement | null;
const rows = () => screen.queryAllByTestId('recent-files-row') as HTMLElement[];
const expanded = () => header().getAttribute('aria-expanded');
const heightOf = () => Number.parseFloat(section().style.height);

/** マウント後の読み込み(list_recent_files → 行の描画)を待つ。 */
async function loaded(count: number) {
	await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(1));
	await waitFor(() => expect(rows()).toHaveLength(count));
	await settle();
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

beforeEach(() => {
	installInvoke();
	windowState.applyRoot(ROOT, [], false);
	Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
	vi.stubGlobal('alert', vi.fn());
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
// AC-64-20 (1) — つかみ所の有無(契約 追補c 1・4)
// ---------------------------------------------------------------------------

describe('AC-64-20: 開いた状態でつかみ所(recent-files-sash)があり、閉じた状態では無い(契約 追補c 1・4)', () => {
	it('開いた状態で描かれると、つかみ所の要素が 1 つある(見出し行とは別の要素・クラス recent-files-sash)', async () => {
		recent = [MD];
		mountSection();
		await loaded(1);
		expect(expanded()).toBe('true');

		const el = sash();
		expect(el, 'the sash is not the header row itself (the header keeps cursor: pointer)').not.toBe(header());
		expect(el.classList.contains(SASH_CLASS), `the sash carries class "${SASH_CLASS}" (the cursor rule targets it)`).toBe(true);
	});

	it('閉じた状態で描かれるとつかみ所は無く、見出し行のクリックで開くと現れ、閉じると消える', async () => {
		saveSectionExpanded(false);
		recent = [MD];
		mountSection();
		await settle();
		expect(expanded()).toBe('false');
		expect(sashOrNull(), 'no sash while collapsed').toBeNull();

		await press(header(), 300);
		expect(expanded()).toBe('true');
		await waitFor(() => expect(rows()).toHaveLength(1));
		expect(sashOrNull(), 'the sash appears once expanded').not.toBeNull();

		await press(header(), 300);
		expect(expanded()).toBe('false');
		expect(sashOrNull(), 'the sash goes away when collapsed again').toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-64-20 (2) — つかみ所のドラッグで高さが変わり、離した時点で保存(契約 追補c 2)
// ---------------------------------------------------------------------------

describe('AC-64-20: つかみ所の上下ドラッグで区画の高さが変わり、離した時点で保存され、開閉は変わらない(契約 追補c 2)', () => {
	it('上へ 40px(pointerdown → pointermove → pointerup → click)→ 高さ(style)が 40px 増え、保存され、開閉は変わらない', async () => {
		saveSectionHeight(START_HEIGHT);
		recent = [MD];
		mountSection();
		await loaded(1);
		const before = heightOf();
		expect(before, 'the saved height is applied at mount (clamped to the pane)').toBe(
			clampSectionHeight(START_HEIGHT, PANE)
		);

		const el = sash();
		pointer(el, 'pointerdown', 300);
		await tick();
		pointer(el, 'pointermove', 260);
		await tick();
		expect(heightOf(), 'the height follows the pointer while dragging').toBe(before + 40);
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY), 'not saved until released').toBe(String(START_HEIGHT));

		pointer(el, 'pointerup', 260);
		await tick();
		await fireEvent.click(el, { clientX: 20, clientY: 260 });
		await settle();

		expect(heightOf()).toBe(before + 40);
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe(String(before + 40));
		expect(expanded(), 'a drag on the sash never toggles').toBe('true');
		expect(localStorage.getItem(SECTION_EXPANDED_STORAGE_KEY)).not.toBe('false');
		expect(rows()).toHaveLength(1);
		expect(sashOrNull(), 'the sash stays while expanded').not.toBeNull();
	});

	it('下へ 30px → 高さが 30px 減る(範囲内)・保存される・開閉は変わらない', async () => {
		saveSectionHeight(START_HEIGHT);
		recent = [MD];
		mountSection();
		await loaded(1);
		const before = heightOf();

		await press(sash(), 300, 330);

		expect(heightOf()).toBe(clampSectionHeight(before - 30, PANE));
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe(String(clampSectionHeight(before - 30, PANE)));
		expect(expanded()).toBe('true');
	});

	it('paneHeight を超えて引いても最大(paneHeight − MIN_TREE_HEIGHT)で止まる=見出し行のドラッグと同じ範囲', async () => {
		saveSectionHeight(START_HEIGHT);
		recent = [MD];
		mountSection();
		await loaded(1);

		await press(sash(), 300, -1000);

		expect(heightOf()).toBe(PANE - MIN_TREE_HEIGHT);
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe(String(PANE - MIN_TREE_HEIGHT));
		expect(expanded()).toBe('true');
	});
});

// ---------------------------------------------------------------------------
// AC-64-20 (3) — つかみ所はドラッグ専用(契約 追補c 3)
// ---------------------------------------------------------------------------

describe('AC-64-20: つかみ所はドラッグ専用 — 3px 未満で離して click まで届いても開閉しない(契約 追補c 3)', () => {
	it('移動 0 のクリックでも 2px の移動でも、aria-expanded・開閉の保存・高さ(style と保存)が変わらない', async () => {
		saveSectionHeight(START_HEIGHT);
		recent = [MD];
		mountSection();
		await loaded(1);
		const before = heightOf();

		await press(sash(), 300);
		expect(expanded(), 'a plain click on the sash does not toggle').toBe('true');
		expect(localStorage.getItem(SECTION_EXPANDED_STORAGE_KEY)).not.toBe('false');
		expect(heightOf()).toBe(before);
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe(String(START_HEIGHT));

		await press(sash(), 300, 298);
		expect(expanded(), 'a 2px press on the sash does not toggle').toBe('true');
		expect(localStorage.getItem(SECTION_EXPANDED_STORAGE_KEY)).not.toBe('false');
		expect(heightOf()).toBe(before);
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe(String(START_HEIGHT));
		expect(rows()).toHaveLength(1);
		expect(sashOrNull()).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-64-20 (4) — ソース走査: つかみ所に cursor: ns-resize(契約 追補c 1・5)
// ---------------------------------------------------------------------------

describe('AC-64-20(ソース走査): RecentFiles.svelte の <style> がつかみ所に cursor: ns-resize を当て、見出し行は pointer のまま(契約 追補c 1・5)', () => {
	const componentSource = () => readFileSync(resolve(__dirname, 'RecentFiles.svelte'), 'utf-8');

	/** `<style>…</style>` の中身(コメントを落とす)。 */
	function styleSource(): string {
		const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(componentSource());
		expect(m, 'RecentFiles.svelte has a <style> block').toBeTruthy();
		return (m as RegExpExecArray)[1].replace(/\/\*[\s\S]*?\*\//g, '');
	}

	type Rule = { selectors: string[]; declarations: string };

	/** 入れ子なしの `selector { declarations }` を順に拾う(Svelte の scoped CSS はこの形)。 */
	function rules(): Rule[] {
		const out: Rule[] = [];
		const re = /([^{}]+)\{([^{}]*)\}/g;
		let m: RegExpExecArray | null;
		const src = styleSource();
		while ((m = re.exec(src)) !== null) {
			out.push({
				selectors: m[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0),
				declarations: m[2],
			});
		}
		return out;
	}

	const hasCursor = (declarations: string, value: string) =>
		new RegExp(`(^|;|\\s)cursor\\s*:\\s*${value}\\s*(!important)?\\s*(;|$)`, 'm').test(declarations);

	it(`つかみ所(.${SASH_CLASS})に cursor: ns-resize を当てる規則がある(.dragging で条件付けしない=載せただけで出る)`, () => {
		const atRest = rules().filter((r) =>
			r.selectors.some((s) => s.includes(`.${SASH_CLASS}`) && !/dragging/.test(s))
		);
		expect(atRest.length, `a rule targets .${SASH_CLASS} without a .dragging condition`).toBeGreaterThan(0);
		expect(
			atRest.some((r) => hasCursor(r.declarations, 'ns-resize')),
			`one of the .${SASH_CLASS} rules declares cursor: ns-resize`
		).toBe(true);
	});

	it('見出し行(.recent-files-header)のカーソルは pointer のまま(追補c 5=それ以外の場所は今のまま)', () => {
		const headerRules = rules().filter((r) =>
			r.selectors.some((s) => s.includes('.recent-files-header') && !/dragging|hover|focus|\[/.test(s))
		);
		expect(headerRules.some((r) => hasCursor(r.declarations, 'pointer'))).toBe(true);
	});
});
