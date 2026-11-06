/**
 * テーマ(見た目の差し替え・要件#56 契約 3)のフロント側。
 *
 * テーマを読む・検証する・Default で補う・監視して全窓へ配るのは Rust の `theme.rs` の
 * 1 か所だけ(docs/theme-architecture.md §1「Rust が単一真実源」)。フロントは解決済みの
 * テーマを受け取り、`<style id="vellis-theme">` に 3 ブロックで書いて、Shiki のテーマ名を
 * 選ぶだけ。値の検証は二重に持たない(例外= Shiki のテーマ名を `shiki` の同梱テーマと
 * 照らすこと。一覧を持っているのがフロントだけなので=判断 (o))。
 *
 * - 起動: `src/routes/+layout.ts` の `load` が `fetchTheme()`(command `get_theme`)を待ってから
 *   `+page.svelte` を描く(判断 (j))。失敗したら null = `theme.css`(Default)のまま
 * - 変化: Rust が `theme_changed` を全窓へ送る → `registerThemeChangedListener` → `applyTheme`
 * - モード(Light / Dark / System)は別の軸(`$lib/ui-chrome`)。`<style>` の中身はモードで
 *   変わらず、どのブロックが効くかが `<html data-theme>` と OS の外観で変わるだけ
 */
import { bundledThemes } from 'shiki';
import { invoke } from './ipc';
import { listen } from './events';

/** 解決済みのテーマを全窓へ配るイベント名。Rust の `theme::THEME_CHANGED_EVENT` と同綴り。 */
export const THEME_CHANGED_EVENT = 'theme_changed';

/** 解決済みテーマを書く `<style>` の id(`theme.css` より後ろ= `<head>` の最後の `<style>`)。 */
export const THEME_STYLE_ID = 'vellis-theme';

/** Default のコードのテーマ(themes/default.json の `code`・判断 (m))。 */
export const DEFAULT_CODE_THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/**
 * Rust の `ResolvedTheme` の JSON。鍵は先頭の `--` を省いた平らな名前で、light と dark は
 * 65 名すべてを持つ。`code` は (light, dark) の Shiki のテーマ名。
 */
export type ResolvedTheme = {
	name: string;
	light: Record<string, string>;
	dark: Record<string, string>;
	code: [string, string];
	warnings: string[];
};

function declarations(values: Record<string, string>, indent: string): string {
	return Object.entries(values)
		.map(([name, value]) => `${indent}--${name}: ${value};\n`)
		.join('');
}

/**
 * 解決済みテーマの CSS。`theme.css` と同じ 3 つのセレクタで書く(後ろに置くので文書順で勝つ):
 * light の値は `:root{}`(属性なし= System で OS がライトのときにも当たる)、dark の値は
 * `:root[data-theme="dark"]{}` と `@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){} }`。
 */
export function themeCss(theme: ResolvedTheme): string {
	return (
		`:root {\n${declarations(theme.light, '\t')}}\n` +
		`:root[data-theme="dark"] {\n${declarations(theme.dark, '\t')}}\n` +
		'@media (prefers-color-scheme: dark) {\n' +
		`\t:root:not([data-theme="light"]) {\n${declarations(theme.dark, '\t\t')}\t}\n` +
		'}\n'
	);
}

/**
 * `<style id="vellis-theme">` を `doc.head` の末尾に 1 つだけ持ち、中身を `themeCss(theme)` にする。
 * 2 回目以降は同じ要素を末尾へ移して書き換える(増えない)。
 */
export function applyTheme(theme: ResolvedTheme, doc: Document = document): HTMLStyleElement {
	const found = doc.getElementById(THEME_STYLE_ID);
	const style =
		found !== null && found.tagName === 'STYLE' ? (found as HTMLStyleElement) : doc.createElement('style');
	style.id = THEME_STYLE_ID;
	doc.head.appendChild(style);
	style.textContent = themeCss(theme);
	return style;
}

/** `name` が Shiki の同梱テーマならそのまま、無ければ `fallback`(console.warn を 1 回)。 */
export function resolveCodeTheme(name: string, fallback: string): string {
	if (Object.prototype.hasOwnProperty.call(bundledThemes, name)) return name;
	console.warn(`Vellis: code theme "${name}" is not one of Shiki's bundled themes; using "${fallback}"`);
	return fallback;
}

/** 実効モードに応じた Shiki のテーマ名(テーマの `code` を同梱テーマと照らしたもの)。 */
export function codeThemeFor(theme: ResolvedTheme, effective: 'light' | 'dark'): string {
	return effective === 'dark'
		? resolveCodeTheme(theme.code[1], DEFAULT_CODE_THEMES.dark)
		: resolveCodeTheme(theme.code[0], DEFAULT_CODE_THEMES.light);
}

/** 起動時の受け渡し(command `get_theme`)。失敗は null にして外へ出さない(Default のまま描く)。 */
export async function fetchTheme(): Promise<ResolvedTheme | null> {
	try {
		return await invoke<ResolvedTheme>('get_theme');
	} catch {
		return null;
	}
}

/** `theme_changed` を購読し、届いた解決済みテーマを渡す。戻り値は購読の解除。 */
export function registerThemeChangedListener(
	onChanged: (theme: ResolvedTheme) => void,
): Promise<() => void> {
	return listen<ResolvedTheme>(THEME_CHANGED_EVENT, (e) => onChanged(e.payload));
}

/** OS の外観(System のときに効くダーク)を問い合わせる media query。 */
const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/**
 * 見え方(テーマ・モード・OS の外観)が変わったら `onChange` を呼ぶ(要件#56 契約 7 第2段 (e))。
 * canvas に描くもの(AudioViewer の波形)は `getComputedStyle` で今の色を引くので、知らせて
 * 描き直させればトークンの変化に追従する。経路は 3 つ:
 * - テーマ= `theme_changed`(Rust が全窓へ送る・`applyTheme` と同じ契機)
 * - モード= `root`(既定 `<html>`)の `data-theme` の付け外し(`$lib/ui-chrome`)
 * - OS の外観= `matchMedia('(prefers-color-scheme: dark)')` の `change`(無い環境では見ない)
 *
 * 戻り値の関数で 3 つとも外す。
 */
export async function observeAppearance(
	onChange: () => void,
	root: HTMLElement = document.documentElement,
): Promise<() => void> {
	const observer = new MutationObserver(() => onChange());
	observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

	const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_SCHEME_QUERY) : null;
	const onMedia = () => onChange();
	if (media !== null) {
		if (typeof media.addEventListener === 'function') media.addEventListener('change', onMedia);
		else media.addListener(onMedia);
	}

	let unlistenTheme: (() => void) | null = null;
	try {
		unlistenTheme = await listen<ResolvedTheme>(THEME_CHANGED_EVENT, () => onChange());
	} catch {
		// イベントの経路が無い(Tauri の外)ときもモードと OS の外観は見続ける
		unlistenTheme = null;
	}

	return () => {
		observer.disconnect();
		if (media !== null) {
			if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onMedia);
			else media.removeListener(onMedia);
		}
		unlistenTheme?.();
	};
}
