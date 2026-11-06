/**
 * 要件#56 の受け入れテスト(docs/requirements/req-56.md)— モードと幅いっぱいの配線(AC-56-8 のモード側・AC-56-9)
 *
 * 契約 3「モード」(Light / Dark / System・既定 System・localStorage `vellis.theme`・`<html data-theme>`・
 * System は属性なし=起案時判断 (a)(b)(c))と、契約 4「幅いっぱいの切替」(View ▸ Toggle Full Width・
 * `<html data-doc-measure="full">`・localStorage `vellis.doc-measure`=判断 (g)(h))のフロント側。
 * メニューのイベントは `menu.rs` が見ている窓へ `emit_to` し、フロントが `listen` して属性の付け外しと
 * 保存を行う(Zoom In 等と同じ形)。テーマの経路(`src/lib/theme.ts`=theme.wiring.test.ts)とは交わらない。
 *
 * 判定するもの:
 * - AC-56-8(モード)= 3 つのイベント名(Rust の `menu.rs` と同綴り)を `listen` し、受けたら
 *   `document.documentElement` の `data-theme` を付け外しして localStorage `vellis.theme` に書く。
 *   起動時に保存値を読んで当て直す。System は属性を外す。実効モード(属性があればその値・無ければ
 *   `matchMedia('(prefers-color-scheme: dark)')`)が変わったことを Shiki の描き直しのために知らせる
 * - AC-56-9(幅いっぱい)= `Toggle Full Width` のイベント名を `listen` し、受けたら `data-doc-measure="full"`
 *   を切り替えて localStorage `vellis.doc-measure` に保存する。起動時に保存値を読んで当て直す
 * - `+page.svelte` が `$lib/ui-chrome` の購読と復元を呼んでいる(ソース走査)
 *
 * 判定しないもの: 他の窓への `storage` イベントでの追従(契約 3 の本文。AC に無いので人間ゲート 4 で見る)・
 * メニューの実クリック(Rust 側=acceptance_req56.rs)・見え方(人間ゲート)。
 *
 * ## 確定契約(implementer はこれに従う。ファイル名と関数名は本ファイルが決める=theme-architecture §10 に無い部分)
 *
 * ```ts
 * // src/lib/ui-chrome.ts(新規・Tauri は $lib/events の listen 経由でだけ触る)
 * export const THEME_MODE_STORAGE_KEY = 'vellis.theme';            // 判断 (c)
 * export const DOC_MEASURE_STORAGE_KEY = 'vellis.doc-measure';     // 判断 (h)
 * export const MENU_APPEARANCE_LIGHT_EVENT = 'menu_appearance_light';
 * export const MENU_APPEARANCE_DARK_EVENT = 'menu_appearance_dark';
 * export const MENU_APPEARANCE_SYSTEM_EVENT = 'menu_appearance_system';
 * export const MENU_TOGGLE_FULL_WIDTH_EVENT = 'menu_toggle_full_width';
 * //   ↑ 4 つは src-tauri/src/menu.rs の同名 `pub const` と同じ値
 * export type ThemeMode = 'light' | 'dark' | 'system';
 * export type DocMeasure = 'measure' | 'full';
 * /** 保存値。無い・解釈できない → 'system' *\/
 * export function loadThemeMode(): ThemeMode;
 * /** `root`(既定 document.documentElement)の data-theme を付け外しして保存する。'system' は属性を外し 'system' を保存 *\/
 * export function applyThemeMode(mode: ThemeMode, root?: HTMLElement): void;
 * /** 実効モード= data-theme があればその値・無ければ matchMedia('(prefers-color-scheme: dark)').matches で 'dark' / 'light' *\/
 * export function effectiveMode(root?: HTMLElement): 'light' | 'dark';
 * /** 保存値。無い・解釈できない → 'measure'(72ch) *\/
 * export function loadDocMeasure(): DocMeasure;
 * /** 'full' なら data-doc-measure="full" を付け、'measure' なら外す。どちらも保存する *\/
 * export function applyDocMeasure(value: DocMeasure, root?: HTMLElement): void;
 * /** 起動時: 保存値を読んでモードと幅いっぱいの両方を当て直す *\/
 * export function restoreUiChrome(root?: HTMLElement): void;
 * export type UiChromeHandlers = {
 *   onEffectiveModeChange?: (mode: 'light' | 'dark') => void;   // Shiki の描き直しに使う(判断 (n))
 *   onDocMeasureChange?: (value: DocMeasure) => void;
 * };
 * /** 4 つのイベントを $lib/events の listen で購読する。戻り値は全部を解除する関数 *\/
 * export function registerUiChromeListeners(handlers?: UiChromeHandlers): Promise<() => void>;
 * ```
 *
 * - `+page.svelte` は `$lib/ui-chrome` を import し、`restoreUiChrome(` と `registerUiChromeListeners(` を呼ぶ
 *
 * 判定方式: `@tauri-apps/api/webviewWindow`(`$lib/events` の下位)と `@tauri-apps/api/event` の listen を
 * モックして登録されたハンドラを直接起こす。localStorage は jsdom のもの(`vitest.config.ts` の execArgv)。
 *
 * 実装前の見立て(赤の理由): `src/lib/ui-chrome.ts` が無い(import で落ちる)・`menu.rs` に定数が無い・
 * `+page.svelte` に呼び出しが無い。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Handler = (e: { payload: unknown }) => void;

const { registry, unlistenCalls } = vi.hoisted(() => ({
	registry: new Map<string, Handler[]>(),
	unlistenCalls: [] as string[],
}));

function record(event: string, handler: Handler): Promise<() => void> {
	const list = registry.get(event) ?? [];
	list.push(handler);
	registry.set(event, list);
	return Promise.resolve(() => {
		unlistenCalls.push(event);
	});
}

vi.mock('@tauri-apps/api/event', () => ({ listen: (event: string, handler: Handler) => record(event, handler) }));

vi.mock('@tauri-apps/api/webviewWindow', () => {
	class FakeWebviewWindow {
		readonly label = 'req56-ui-chrome';
		listen(event: string, handler: Handler): Promise<() => void> {
			return record(event, handler);
		}
	}
	return { getCurrentWebviewWindow: () => new FakeWebviewWindow(), WebviewWindow: FakeWebviewWindow };
});

import {
	DOC_MEASURE_STORAGE_KEY,
	MENU_APPEARANCE_DARK_EVENT,
	MENU_APPEARANCE_LIGHT_EVENT,
	MENU_APPEARANCE_SYSTEM_EVENT,
	MENU_TOGGLE_FULL_WIDTH_EVENT,
	THEME_MODE_STORAGE_KEY,
	applyDocMeasure,
	applyThemeMode,
	effectiveMode,
	loadDocMeasure,
	loadThemeMode,
	registerUiChromeListeners,
	restoreUiChrome,
} from './ui-chrome';

const REPO_ROOT = resolve(__dirname, '../..');
const menuRs = () => readFileSync(resolve(REPO_ROOT, 'src-tauri/src/menu.rs'), 'utf8');
const pageSvelte = () => readFileSync(resolve(REPO_ROOT, 'src/routes/+page.svelte'), 'utf8');

const root = () => document.documentElement;

/** OS の外観を模す matchMedia(jsdom には無い)。 */
function stubMatchMedia(osDark: boolean): void {
	const impl = (query: string): MediaQueryList =>
		({
			matches: osDark && /prefers-color-scheme\s*:\s*dark/.test(query),
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}) as unknown as MediaQueryList;
	Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(impl) });
}

function fire(event: string): void {
	const handlers = registry.get(event) ?? [];
	expect(handlers.length, `${event} が listen されていること`).toBeGreaterThan(0);
	for (const h of handlers) h({ payload: null });
}

function rustConst(name: string): string | undefined {
	return menuRs().match(new RegExp(`pub const ${name}: &str = "([^"]+)";`))?.[1];
}

beforeEach(() => {
	registry.clear();
	unlistenCalls.length = 0;
	localStorage.clear();
	root().removeAttribute('data-theme');
	root().removeAttribute('data-doc-measure');
	stubMatchMedia(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC-56-8(モード)— 定数
// ---------------------------------------------------------------------------

describe('AC-56-8 モードの定数(契約 3・判断 (c)): イベント名は menu.rs と同綴り・保存キーは vellis.theme', () => {
	test('保存キーは vellis.theme(全窓で 1 値=ズームと同じ流儀)', () => {
		expect(THEME_MODE_STORAGE_KEY).toBe('vellis.theme');
	});

	test('3 つのイベント名は値固定で、menu.rs の同名 pub const と同じ', () => {
		expect(MENU_APPEARANCE_LIGHT_EVENT).toBe('menu_appearance_light');
		expect(MENU_APPEARANCE_DARK_EVENT).toBe('menu_appearance_dark');
		expect(MENU_APPEARANCE_SYSTEM_EVENT).toBe('menu_appearance_system');
		expect(rustConst('MENU_APPEARANCE_LIGHT_EVENT')).toBe(MENU_APPEARANCE_LIGHT_EVENT);
		expect(rustConst('MENU_APPEARANCE_DARK_EVENT')).toBe(MENU_APPEARANCE_DARK_EVENT);
		expect(rustConst('MENU_APPEARANCE_SYSTEM_EVENT')).toBe(MENU_APPEARANCE_SYSTEM_EVENT);
	});
});

// ---------------------------------------------------------------------------
// AC-56-8(モード)— 付け外しと保存・復元・実効モード
// ---------------------------------------------------------------------------

describe('AC-56-8 data-theme の付け外しと保存(契約 3・判断 (b)(c))', () => {
	test("applyThemeMode('dark') → <html data-theme=\"dark\"> と localStorage 'dark'", () => {
		applyThemeMode('dark');
		expect(root().getAttribute('data-theme')).toBe('dark');
		expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('dark');
	});

	test("applyThemeMode('light') → <html data-theme=\"light\"> と localStorage 'light'", () => {
		applyThemeMode('light');
		expect(root().getAttribute('data-theme')).toBe('light');
		expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('light');
	});

	test("applyThemeMode('system') → 属性を外し(OS に従う)、localStorage は 'system'", () => {
		applyThemeMode('dark');
		applyThemeMode('system');
		expect(root().hasAttribute('data-theme')).toBe(false);
		expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('system');
	});

	test("loadThemeMode: 未保存 → 'system'(既定=OS 追従)・保存値 → その値・解釈できない値 → 'system'", () => {
		expect(loadThemeMode()).toBe('system');
		localStorage.setItem(THEME_MODE_STORAGE_KEY, 'dark');
		expect(loadThemeMode()).toBe('dark');
		localStorage.setItem(THEME_MODE_STORAGE_KEY, 'light');
		expect(loadThemeMode()).toBe('light');
		localStorage.setItem(THEME_MODE_STORAGE_KEY, 'blue');
		expect(loadThemeMode()).toBe('system');
	});

	test('restoreUiChrome は起動時に保存値を読んで当て直す(dark + full)', () => {
		localStorage.setItem(THEME_MODE_STORAGE_KEY, 'dark');
		localStorage.setItem(DOC_MEASURE_STORAGE_KEY, 'full');
		restoreUiChrome();
		expect(root().getAttribute('data-theme')).toBe('dark');
		expect(root().getAttribute('data-doc-measure')).toBe('full');
	});

	test('restoreUiChrome は保存が無ければ属性を付けない(System・72ch)', () => {
		root().setAttribute('data-theme', 'dark');
		root().setAttribute('data-doc-measure', 'full');
		restoreUiChrome();
		expect(root().hasAttribute('data-theme')).toBe(false);
		expect(root().hasAttribute('data-doc-measure')).toBe(false);
	});

	test('effectiveMode: 属性があればその値・無ければ matchMedia(prefers-color-scheme: dark)に従う', () => {
		root().setAttribute('data-theme', 'dark');
		stubMatchMedia(false);
		expect(effectiveMode()).toBe('dark');
		root().setAttribute('data-theme', 'light');
		stubMatchMedia(true);
		expect(effectiveMode()).toBe('light');
		root().removeAttribute('data-theme');
		stubMatchMedia(true);
		expect(effectiveMode()).toBe('dark');
		stubMatchMedia(false);
		expect(effectiveMode()).toBe('light');
	});
});

// ---------------------------------------------------------------------------
// AC-56-8(モード)— メニューのイベントの購読
// ---------------------------------------------------------------------------

describe('AC-56-8 registerUiChromeListeners(契約 3): 3 つのモードのイベントを listen して属性・保存・描き直しの通知', () => {
	test('4 つのイベント(Light / Dark / System / Toggle Full Width)がちょうど購読される', async () => {
		await registerUiChromeListeners();
		expect([...registry.keys()].sort()).toEqual(
			[
				MENU_APPEARANCE_DARK_EVENT,
				MENU_APPEARANCE_LIGHT_EVENT,
				MENU_APPEARANCE_SYSTEM_EVENT,
				MENU_TOGGLE_FULL_WIDTH_EVENT,
			].sort(),
		);
	});

	test('Dark のイベント → data-theme="dark"・保存・onEffectiveModeChange("dark")', async () => {
		const onEffectiveModeChange = vi.fn();
		await registerUiChromeListeners({ onEffectiveModeChange });
		fire(MENU_APPEARANCE_DARK_EVENT);
		expect(root().getAttribute('data-theme')).toBe('dark');
		expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('dark');
		expect(onEffectiveModeChange).toHaveBeenLastCalledWith('dark');
	});

	test('Light のイベント → data-theme="light"・保存・onEffectiveModeChange("light")', async () => {
		const onEffectiveModeChange = vi.fn();
		await registerUiChromeListeners({ onEffectiveModeChange });
		fire(MENU_APPEARANCE_LIGHT_EVENT);
		expect(root().getAttribute('data-theme')).toBe('light');
		expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('light');
		expect(onEffectiveModeChange).toHaveBeenLastCalledWith('light');
	});

	test('System のイベント → 属性を外し・保存・実効モードは OS の外観(ダークなら "dark")', async () => {
		stubMatchMedia(true);
		const onEffectiveModeChange = vi.fn();
		await registerUiChromeListeners({ onEffectiveModeChange });
		fire(MENU_APPEARANCE_LIGHT_EVENT);
		fire(MENU_APPEARANCE_SYSTEM_EVENT);
		expect(root().hasAttribute('data-theme')).toBe(false);
		expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('system');
		expect(onEffectiveModeChange).toHaveBeenLastCalledWith('dark');
	});

	test('モードの切替はテーマの <style> に触れない(#vellis-theme を書き換えない=経路が交わらない)', async () => {
		const style = document.createElement('style');
		style.id = 'vellis-theme';
		style.textContent = ':root{--probe:1}';
		document.head.appendChild(style);
		try {
			await registerUiChromeListeners();
			fire(MENU_APPEARANCE_DARK_EVENT);
			fire(MENU_APPEARANCE_SYSTEM_EVENT);
			expect(document.getElementById('vellis-theme')?.textContent).toBe(':root{--probe:1}');
		} finally {
			style.remove();
		}
	});

	test('戻り値の関数で 4 つの購読がすべて解除される', async () => {
		const off = await registerUiChromeListeners();
		off();
		expect(unlistenCalls.sort()).toEqual(
			[
				MENU_APPEARANCE_DARK_EVENT,
				MENU_APPEARANCE_LIGHT_EVENT,
				MENU_APPEARANCE_SYSTEM_EVENT,
				MENU_TOGGLE_FULL_WIDTH_EVENT,
			].sort(),
		);
	});
});

// ---------------------------------------------------------------------------
// AC-56-9 — 幅いっぱいの切替
// ---------------------------------------------------------------------------

describe('AC-56-9 幅いっぱい切替の配線(契約 4・判断 (g)(h)): Toggle Full Width のイベント・data-doc-measure・vellis.doc-measure', () => {
	test('イベント名は menu_toggle_full_width で menu.rs の同名 pub const と同じ・保存キーは vellis.doc-measure', () => {
		expect(MENU_TOGGLE_FULL_WIDTH_EVENT).toBe('menu_toggle_full_width');
		expect(rustConst('MENU_TOGGLE_FULL_WIDTH_EVENT')).toBe(MENU_TOGGLE_FULL_WIDTH_EVENT);
		expect(DOC_MEASURE_STORAGE_KEY).toBe('vellis.doc-measure');
	});

	test("applyDocMeasure('full') → <html data-doc-measure=\"full\"> と保存・'measure' → 属性を外して保存", () => {
		applyDocMeasure('full');
		expect(root().getAttribute('data-doc-measure')).toBe('full');
		expect(localStorage.getItem(DOC_MEASURE_STORAGE_KEY)).toBe('full');
		applyDocMeasure('measure');
		expect(root().hasAttribute('data-doc-measure')).toBe(false);
		expect(localStorage.getItem(DOC_MEASURE_STORAGE_KEY)).toBe('measure');
	});

	test("loadDocMeasure: 未保存 → 'measure'(72ch)・'full' → 'full'・解釈できない値 → 'measure'", () => {
		expect(loadDocMeasure()).toBe('measure');
		localStorage.setItem(DOC_MEASURE_STORAGE_KEY, 'full');
		expect(loadDocMeasure()).toBe('full');
		localStorage.setItem(DOC_MEASURE_STORAGE_KEY, 'wide');
		expect(loadDocMeasure()).toBe('measure');
	});

	test('Toggle Full Width のイベントで full ⇄ measure を切り替え、保存し、onDocMeasureChange に知らせる(2 回目で戻る)', async () => {
		const onDocMeasureChange = vi.fn();
		await registerUiChromeListeners({ onDocMeasureChange });
		fire(MENU_TOGGLE_FULL_WIDTH_EVENT);
		expect(root().getAttribute('data-doc-measure')).toBe('full');
		expect(localStorage.getItem(DOC_MEASURE_STORAGE_KEY)).toBe('full');
		expect(onDocMeasureChange).toHaveBeenLastCalledWith('full');
		fire(MENU_TOGGLE_FULL_WIDTH_EVENT);
		expect(root().hasAttribute('data-doc-measure')).toBe(false);
		expect(localStorage.getItem(DOC_MEASURE_STORAGE_KEY)).toBe('measure');
		expect(onDocMeasureChange).toHaveBeenLastCalledWith('measure');
	});

	test('幅いっぱいの切替はモードに触れない(data-theme と vellis.theme は変わらない)', async () => {
		applyThemeMode('dark');
		await registerUiChromeListeners();
		fire(MENU_TOGGLE_FULL_WIDTH_EVENT);
		expect(root().getAttribute('data-theme')).toBe('dark');
		expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('dark');
	});
});

// ---------------------------------------------------------------------------
// +page.svelte の配線(ソース走査)
// ---------------------------------------------------------------------------

describe('AC-56-8・9 +page.svelte の配線: $lib/ui-chrome の復元と購読を呼んでいる', () => {
	test("+page.svelte が '$lib/ui-chrome' を import し、restoreUiChrome( と registerUiChromeListeners( を呼ぶ", () => {
		const src = pageSvelte();
		expect(src).toMatch(/from\s+['"]\$lib\/ui-chrome['"]/);
		expect(src).toContain('restoreUiChrome(');
		expect(src).toContain('registerUiChromeListeners(');
	});
});
