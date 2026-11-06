/**
 * モード(Light / Dark / System)と本文の幅(72ch / 幅いっぱい)のフロント側
 * (要件#56 契約 3・4・起案時判断 (a)(b)(c)(g)(h))。
 *
 * どちらも窓の見た目だけの好みなので、ズーム(要件#36)と同じ流儀で持つ: View メニューの項目は
 * `menu.rs` が見ている窓へ `emit_to` し、ここが `listen` して `<html>` の属性を付け外しし、
 * localStorage に保存する(全窓で 1 値・起動時に読む・他の窓は `storage` イベントで追従)。
 *
 * - モード= `<html data-theme="light" | "dark">`。System は属性を外して OS の外観に従う。
 *   保存キー `vellis.theme`(`settings.json` には書かない)
 * - 幅= `<html data-doc-measure="full">` で幅いっぱい、無ければ 72ch(`markdown.css`)。
 *   保存キー `vellis.doc-measure`
 *
 * テーマの経路(`$lib/theme`= `settings.json`・Rust・`theme_changed`)とは交わらない。モードが
 * 変わると効く CSS のブロックが変わるだけで、`<style id="vellis-theme">` には触れない。Shiki だけは
 * 実効モードでテーマ名が変わるので、描き直しのために `onEffectiveModeChange` で知らせる。
 */
import { listen } from './events';

/** モードの保存キー(判断 (c))。 */
export const THEME_MODE_STORAGE_KEY = 'vellis.theme';
/** 幅いっぱいの保存キー(判断 (h))。 */
export const DOC_MEASURE_STORAGE_KEY = 'vellis.doc-measure';

/** View ▸ Appearance ▸ Light / Dark / System と View ▸ Toggle Full Width のイベント名。
 *  `src-tauri/src/menu.rs` の同名の定数と同綴り。 */
export const MENU_APPEARANCE_LIGHT_EVENT = 'menu_appearance_light';
export const MENU_APPEARANCE_DARK_EVENT = 'menu_appearance_dark';
export const MENU_APPEARANCE_SYSTEM_EVENT = 'menu_appearance_system';
export const MENU_TOGGLE_FULL_WIDTH_EVENT = 'menu_toggle_full_width';

export type ThemeMode = 'light' | 'dark' | 'system';
export type DocMeasure = 'measure' | 'full';

const THEME_ATTRIBUTE = 'data-theme';
const DOC_MEASURE_ATTRIBUTE = 'data-doc-measure';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function rootElement(): HTMLElement {
	return document.documentElement;
}

/** localStorage が使えない文脈でも落ちない(読めなければ null・書けなければ何もしない)。 */
function readStorage(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// 保存できなくても今の窓には当たっている。
	}
}

function parseThemeMode(value: string | null): ThemeMode {
	return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

function parseDocMeasure(value: string | null): DocMeasure {
	return value === 'full' ? 'full' : 'measure';
}

function setThemeAttribute(mode: ThemeMode, root: HTMLElement): void {
	if (mode === 'system') root.removeAttribute(THEME_ATTRIBUTE);
	else root.setAttribute(THEME_ATTRIBUTE, mode);
}

function setDocMeasureAttribute(value: DocMeasure, root: HTMLElement): void {
	if (value === 'full') root.setAttribute(DOC_MEASURE_ATTRIBUTE, 'full');
	else root.removeAttribute(DOC_MEASURE_ATTRIBUTE);
}

/** OS の外観を問い合わせる `MediaQueryList`(`matchMedia` の無い文脈では null)。 */
function darkQuery(): MediaQueryList | null {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
	return window.matchMedia(DARK_QUERY);
}

/** 保存されたモード。無い・解釈できない → 'system'(既定= OS に従う)。 */
export function loadThemeMode(): ThemeMode {
	return parseThemeMode(readStorage(THEME_MODE_STORAGE_KEY));
}

/** `root` の data-theme を付け外しして保存する。'system' は属性を外し、'system' を保存する。 */
export function applyThemeMode(mode: ThemeMode, root: HTMLElement = rootElement()): void {
	setThemeAttribute(mode, root);
	writeStorage(THEME_MODE_STORAGE_KEY, mode);
}

/** 実効モード= data-theme があればその値、無ければ OS の外観(`prefers-color-scheme: dark`)。 */
export function effectiveMode(root: HTMLElement = rootElement()): 'light' | 'dark' {
	const attribute = root.getAttribute(THEME_ATTRIBUTE);
	if (attribute === 'light' || attribute === 'dark') return attribute;
	return darkQuery()?.matches ? 'dark' : 'light';
}

/** 保存された幅。無い・解釈できない → 'measure'(72ch)。 */
export function loadDocMeasure(): DocMeasure {
	return parseDocMeasure(readStorage(DOC_MEASURE_STORAGE_KEY));
}

/** 'full' なら data-doc-measure="full" を付け、'measure' なら外す。どちらも保存する。 */
export function applyDocMeasure(value: DocMeasure, root: HTMLElement = rootElement()): void {
	setDocMeasureAttribute(value, root);
	writeStorage(DOC_MEASURE_STORAGE_KEY, value);
}

/** 起動時: 保存値を読んでモードと幅の両方を当て直す(保存はし直さない)。 */
export function restoreUiChrome(root: HTMLElement = rootElement()): void {
	setThemeAttribute(loadThemeMode(), root);
	setDocMeasureAttribute(loadDocMeasure(), root);
}

export type UiChromeHandlers = {
	/** 実効モードが(変わったかもしれない)とき。Shiki の描き直しに使う(判断 (n))。 */
	onEffectiveModeChange?: (mode: 'light' | 'dark') => void;
	/** 幅が切り替わったとき。 */
	onDocMeasureChange?: (value: DocMeasure) => void;
};

/**
 * View メニューの 4 つのイベントを購読する。あわせて、System のときの OS の外観の切替と、
 * 他の窓での選択(`storage` イベント)にも追従する。戻り値は全部を解除する関数。
 */
export async function registerUiChromeListeners(handlers: UiChromeHandlers = {}): Promise<() => void> {
	const notifyMode = () => handlers.onEffectiveModeChange?.(effectiveMode());
	const chooseMode = (mode: ThemeMode) => {
		applyThemeMode(mode);
		notifyMode();
	};
	const toggleFullWidth = () => {
		const next: DocMeasure = rootElement().getAttribute(DOC_MEASURE_ATTRIBUTE) === 'full' ? 'measure' : 'full';
		applyDocMeasure(next);
		handlers.onDocMeasureChange?.(next);
	};

	const unlisteners = await Promise.all([
		listen(MENU_APPEARANCE_LIGHT_EVENT, () => chooseMode('light')),
		listen(MENU_APPEARANCE_DARK_EVENT, () => chooseMode('dark')),
		listen(MENU_APPEARANCE_SYSTEM_EVENT, () => chooseMode('system')),
		listen(MENU_TOGGLE_FULL_WIDTH_EVENT, toggleFullWidth),
	]);

	// System のまま OS の外観が変わったとき(属性があるときは効くブロックが変わらない)。
	const query = darkQuery();
	const onOsChange = () => {
		if (!rootElement().hasAttribute(THEME_ATTRIBUTE)) notifyMode();
	};
	query?.addEventListener('change', onOsChange);

	// 他の窓がモードや幅を選んだとき(同じ origin の localStorage の変更)。保存はし直さない。
	const onStorage = (e: StorageEvent) => {
		if (e.key === THEME_MODE_STORAGE_KEY) {
			setThemeAttribute(parseThemeMode(e.newValue), rootElement());
			notifyMode();
		} else if (e.key === DOC_MEASURE_STORAGE_KEY) {
			const value = parseDocMeasure(e.newValue);
			setDocMeasureAttribute(value, rootElement());
			handlers.onDocMeasureChange?.(value);
		}
	};
	window.addEventListener('storage', onStorage);

	return () => {
		for (const off of unlisteners) off();
		query?.removeEventListener('change', onOsChange);
		window.removeEventListener('storage', onStorage);
	};
}
