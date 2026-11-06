/**
 * 要件#56 の受け入れテスト(docs/requirements/req-56.md)— テーマの配線(AC-56-8 のテーマ側)
 *
 * 契約 3「テーマ」のフロント側(構造の正本= docs/theme-architecture.md §2.2・§5・§7 (j)(k)(o))。
 * Rust が単一真実源(`theme.rs` が読む・検証する・補う・配る)で、フロントは解決済みのテーマを受け取って
 * `<style id="vellis-theme">` に 3 ブロックで書き、Shiki を描き直すだけ。検証の二重実装は持たない
 * (例外= Shiki のテーマ名を `shiki` の `bundledThemes` の鍵で照合すること)。
 *
 * 判定するもの:
 * - `THEME_CHANGED_EVENT === 'theme_changed'` で Rust の `theme.rs` の同名定数と同じ値
 * - `src/routes/+layout.ts` の `load` が `invoke('get_theme')` を `await` して `{ theme }` を返す。失敗したら
 *   `{ theme: null }`(Default= theme.css のまま)
 * - 解決済みテーマ → CSS 文字列(`:root{}` / `:root[data-theme="dark"]{}` /
 *   `@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){} }` の 3 ブロック・鍵は `--` 付き)
 * - `<style id="vellis-theme">` 1 つを `<head>` の最後の `<style>` として作り、2 回目以降は書き換える(増えない)
 * - `theme_changed` を `listen` し、受けた payload を渡す
 * - Shiki の名前は `bundledThemes` の鍵で照合し、無ければ Default の名前に戻して `console.warn`
 * - `+page.svelte` がテーマを当て(`applyTheme(`)、`theme_changed` の購読の中で当て直して描き直す(ソース走査)
 *
 * 判定しないもの: Rust の解決(acceptance_req56_theme.rs)・ちらつきの有無・見え方(人間ゲート 4)。
 *
 * ## 確定契約(implementer はこれに従う。theme-architecture §10 の `src/lib/theme.ts` を具体化)
 *
 * ```ts
 * // src/lib/theme.ts(新規)
 * export const THEME_CHANGED_EVENT = 'theme_changed';      // Rust: vellis_lib::theme::THEME_CHANGED_EVENT
 * export const THEME_STYLE_ID = 'vellis-theme';
 * export const DEFAULT_CODE_THEMES = { light: 'github-light', dark: 'github-dark' } as const;
 * /** Rust の `ResolvedTheme` の JSON(serde)。鍵は `--` を省いた平らな名前・code は (light, dark) のタプル=配列 *\/
 * export type ResolvedTheme = {
 *   name: string;
 *   light: Record<string, string>;
 *   dark: Record<string, string>;
 *   code: [string, string];
 *   warnings: string[];
 * };
 * /** 3 ブロックの CSS。light の鍵は `:root{}` に、dark の鍵は `:root[data-theme="dark"]{}` と
 *     `@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){} }` に、`--` を付けて書く *\/
 * export function themeCss(theme: ResolvedTheme): string;
 * /** `<style id="vellis-theme">` を doc.head の末尾(最後の <style>)に 1 つだけ持ち、中身を themeCss(theme) にする *\/
 * export function applyTheme(theme: ResolvedTheme, doc?: Document): HTMLStyleElement;
 * /** shiki の bundledThemes にあれば name、無ければ fallback(console.warn 1 回) *\/
 * export function resolveCodeTheme(name: string, fallback: string): string;
 * /** 実効モードに応じた Shiki の名前(code[0] / code[1] を resolveCodeTheme に通したもの) *\/
 * export function codeThemeFor(theme: ResolvedTheme, effective: 'light' | 'dark'): string;
 * /** invoke('get_theme')。失敗(reject)は null *\/
 * export function fetchTheme(): Promise<ResolvedTheme | null>;
 * /** $lib/events の listen で theme_changed を購読し、payload(ResolvedTheme)を渡す *\/
 * export function registerThemeChangedListener(onChanged: (theme: ResolvedTheme) => void): Promise<() => void>;
 *
 * // src/routes/+layout.ts(既存。ssr = false / prerender = true はそのまま)
 * export async function load(): Promise<{ theme: ResolvedTheme | null }>;   // await fetchTheme()
 * ```
 *
 * - `+page.svelte` は `$lib/theme` を import し、`applyTheme(` を呼び、`registerThemeChangedListener(` の引数の中で
 *   `applyTheme(` と描き直し(`render` / `redraw` / `highlight` のいずれかを名に含む呼び出し)を行う
 *
 * 判定方式: `@tauri-apps/api/core` の invoke と、`$lib/events` の下位 `@tauri-apps/api/webviewWindow` /
 * `@tauri-apps/api/event` の listen をモックする。CSS は小さな字句解析で規則に分ける。
 *
 * 実装前の見立て(赤の理由): `src/lib/theme.ts` と `src-tauri/src/theme.rs` が無い・`+layout.ts` に load が無い・
 * `+page.svelte` に配線が無い。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Handler = (e: { payload: unknown }) => void;

const { registry, invokeMock } = vi.hoisted(() => ({
	registry: new Map<string, Handler[]>(),
	invokeMock: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

function record(event: string, handler: Handler): Promise<() => void> {
	const list = registry.get(event) ?? [];
	list.push(handler);
	registry.set(event, list);
	return Promise.resolve(() => {});
}

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (event: string, handler: Handler) => record(event, handler) }));
vi.mock('@tauri-apps/api/webviewWindow', () => {
	class FakeWebviewWindow {
		readonly label = 'req56-theme';
		listen(event: string, handler: Handler): Promise<() => void> {
			return record(event, handler);
		}
	}
	return { getCurrentWebviewWindow: () => new FakeWebviewWindow(), WebviewWindow: FakeWebviewWindow };
});

import {
	DEFAULT_CODE_THEMES,
	THEME_CHANGED_EVENT,
	THEME_STYLE_ID,
	applyTheme,
	codeThemeFor,
	fetchTheme,
	registerThemeChangedListener,
	resolveCodeTheme,
	themeCss,
	type ResolvedTheme,
} from './theme';

const REPO_ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/** 解決済みテーマの見本(Rust の ResolvedTheme の JSON と同じ形。鍵は `--` 無し)。 */
const SAMPLE: ResolvedTheme = {
	name: 'forest',
	light: { 'color-accent': '#1f7a4d', 'doc-size': '17px', 'color-bg-base': '#f1f2f4' },
	dark: { 'color-accent': '#3fae78', 'doc-size': '17px', 'color-bg-base': '#141518' },
	code: ['github-light', 'vitesse-dark'],
	warnings: [],
};

const OTHER: ResolvedTheme = {
	name: 'default',
	light: { 'color-accent': '#4256e8' },
	dark: { 'color-accent': '#5566ee' },
	code: ['github-light', 'github-dark'],
	warnings: [],
};

// --- CSS の字句解析(design-tokens.acceptance.test.ts と同じ読み方) ---------------------------

type Decl = { prop: string; value: string };
type Rule = { selector: string; body: string; at: string[] };

function declarationsOf(css: string): Decl[] {
	const out: Decl[] = [];
	const re = /([-\w]+)\s*:\s*([^{};]+)(?=[;}])/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) out.push({ prop: m[1], value: m[2].trim() });
	return out;
}

function parseRules(css: string): Rule[] {
	const rules: Rule[] = [];
	const stack: string[] = [];
	let prelude = '';
	let i = 0;
	while (i < css.length) {
		const c = css[i];
		if (c === '{') {
			const p = prelude.replace(/\s+/g, ' ').trim();
			prelude = '';
			if (p.startsWith('@')) {
				stack.push(p);
				i += 1;
				continue;
			}
			let depth = 1;
			let j = i + 1;
			while (j < css.length && depth > 0) {
				if (css[j] === '{') depth += 1;
				else if (css[j] === '}') depth -= 1;
				j += 1;
			}
			rules.push({ selector: p, body: css.slice(i + 1, j - 1), at: [...stack] });
			i = j;
			continue;
		}
		if (c === '}') {
			stack.pop();
			prelude = '';
			i += 1;
			continue;
		}
		prelude += c;
		i += 1;
	}
	return rules;
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const withoutNot = (s: string) => s.replace(/:not\([^)]*\)/g, '');
const targetsDark = (s: string) => /\[data-theme\s*=\s*["']?dark["']?\s*\]/.test(withoutNot(s));
const targetsLight = (s: string) => /\[data-theme\s*=\s*["']?light["']?\s*\]/.test(withoutNot(s));
const excludesLight = (s: string) => /:not\(\s*\[data-theme\s*=\s*["']?light["']?\s*\]\s*\)/.test(s);
const isDarkMedia = (at: string) => /^@media\b/.test(at) && /prefers-color-scheme\s*:\s*dark/.test(at);

function blocksOf(css: string) {
	const rules = parseRules(stripComments(css));
	return {
		light: rules.filter((r) => r.at.length === 0 && /:root/.test(r.selector) && !targetsDark(r.selector) && !targetsLight(r.selector)),
		attrDark: rules.filter((r) => r.at.length === 0 && targetsDark(r.selector)),
		mediaDark: rules.filter((r) => r.at.some(isDarkMedia)),
	};
}

function propsOf(rules: Rule[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const d of rules.flatMap((r) => declarationsOf(r.body))) if (d.prop.startsWith('--')) out[d.prop] = d.value;
	return out;
}

function withDashes(values: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(values).map(([k, v]) => [`--${k}`, v]));
}

/** `start` の位置にある呼び出しの、対応する閉じ括弧までのテキスト。 */
function balancedCall(src: string, start: number): string {
	const open = src.indexOf('(', start);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '(' || c === '[' || c === '{') depth += 1;
		else if (c === ')' || c === ']' || c === '}') {
			depth -= 1;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced call at ${start}`);
}

beforeEach(() => {
	registry.clear();
	invokeMock.mockReset();
	for (const el of document.head.querySelectorAll('style')) el.remove();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// イベント名
// ---------------------------------------------------------------------------

describe('AC-56-8 THEME_CHANGED_EVENT(契約 3): Rust の theme.rs と同じ値 theme_changed', () => {
	test("値は 'theme_changed'", () => {
		expect(THEME_CHANGED_EVENT).toBe('theme_changed');
	});

	test('src-tauri/src/theme.rs の pub const THEME_CHANGED_EVENT と同綴り', () => {
		const rs = read('src-tauri/src/theme.rs');
		const m = rs.match(/pub const THEME_CHANGED_EVENT: &str = "([^"]+)";/);
		expect(m, 'theme.rs must declare THEME_CHANGED_EVENT').toBeTruthy();
		expect(m?.[1]).toBe(THEME_CHANGED_EVENT);
	});

	test('Default の Shiki の対は github-light / github-dark(判断 (m))', () => {
		expect(DEFAULT_CODE_THEMES).toEqual({ light: 'github-light', dark: 'github-dark' });
		expect(THEME_STYLE_ID).toBe('vellis-theme');
	});
});

// ---------------------------------------------------------------------------
// 起動時の受け渡し(判断 (j))
// ---------------------------------------------------------------------------

describe('AC-56-8 起動時の受け渡し(判断 (j)): +layout.ts の load が invoke("get_theme") を await して返す', () => {
	test("fetchTheme は invoke('get_theme') の結果を返す", async () => {
		invokeMock.mockResolvedValueOnce(SAMPLE);
		await expect(fetchTheme()).resolves.toEqual(SAMPLE);
		expect(invokeMock).toHaveBeenCalledWith('get_theme', undefined);
	});

	test('fetchTheme は invoke の失敗を null にして外へ出さない(Default= theme.css のまま)', async () => {
		invokeMock.mockRejectedValueOnce(new Error('no backend'));
		await expect(fetchTheme()).resolves.toBeNull();
	});

	test('+layout.ts の load() は { theme } を返し、その theme は get_theme の結果', async () => {
		invokeMock.mockResolvedValue(SAMPLE);
		const layout = (await import('../routes/+layout')) as { load?: () => Promise<{ theme: unknown }>; ssr?: boolean };
		expect(typeof layout.load, '+layout.ts は load を export すること').toBe('function');
		expect(layout.ssr, 'ssr = false はそのまま').toBe(false);
		const data = await layout.load!();
		expect(invokeMock).toHaveBeenCalledWith('get_theme', undefined);
		expect(data.theme).toEqual(SAMPLE);
	});

	test('+layout.ts の load() は get_theme が失敗しても { theme: null } で描画を止めない', async () => {
		invokeMock.mockRejectedValue(new Error('no backend'));
		vi.resetModules();
		const layout = (await import('../routes/+layout')) as unknown as { load: () => Promise<{ theme: unknown }> };
		await expect(layout.load()).resolves.toEqual({ theme: null });
	});
});

// ---------------------------------------------------------------------------
// 注入(判断 (k))
// ---------------------------------------------------------------------------

describe('AC-56-8 注入(判断 (k)): 解決済みテーマを 3 ブロックで <style id="vellis-theme"> に書く', () => {
	test('themeCss は :root{} / :root[data-theme="dark"]{} / @media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){} } の 3 ブロック', () => {
		const { light, attrDark, mediaDark } = blocksOf(themeCss(SAMPLE));
		expect(light.length, ':root(属性なし)のブロック').toBeGreaterThan(0);
		expect(attrDark.length, ':root[data-theme="dark"] のブロック').toBeGreaterThan(0);
		expect(mediaDark.length, '@media (prefers-color-scheme: dark) の中のブロック').toBeGreaterThan(0);
		for (const r of mediaDark) {
			expect(excludesLight(r.selector), `${r.selector} は :not([data-theme="light"])`).toBe(true);
			expect(/:root/.test(r.selector)).toBe(true);
		}
		for (const r of attrDark) expect(/^:root/.test(r.selector), `${r.selector} は :root から始まる`).toBe(true);
	});

	test('light の鍵は :root に、dark の鍵は 2 つのダークのブロックに、-- を付けてそのまま書かれる', () => {
		const { light, attrDark, mediaDark } = blocksOf(themeCss(SAMPLE));
		expect(propsOf(light)).toEqual(withDashes(SAMPLE.light));
		expect(propsOf(attrDark)).toEqual(withDashes(SAMPLE.dark));
		expect(propsOf(mediaDark)).toEqual(withDashes(SAMPLE.dark));
	});

	test('themeCss はトークン以外の宣言を書かない(値をそのまま流すだけ・セレクタは 3 つだけ)', () => {
		const rules = parseRules(stripComments(themeCss(SAMPLE)));
		const nonToken = rules.flatMap((r) => declarationsOf(r.body)).filter((d) => !d.prop.startsWith('--'));
		expect(nonToken).toEqual([]);
		expect(rules.length).toBe(3);
	});

	test('applyTheme は <style id="vellis-theme"> を <head> の最後の <style> として 1 つ作り、中身は themeCss(theme)', () => {
		const earlier = document.createElement('style');
		earlier.textContent = ':root{--earlier:1}';
		document.head.appendChild(earlier);

		const el = applyTheme(SAMPLE, document);
		const styles = [...document.head.querySelectorAll('style')];
		expect(el.id).toBe('vellis-theme');
		expect(styles[styles.length - 1]).toBe(el);
		expect(el.textContent).toBe(themeCss(SAMPLE));
		expect(document.querySelectorAll('#vellis-theme').length).toBe(1);
	});

	test('applyTheme を 2 回呼んでも <style> は増えず、中身だけ書き換わる(theme_changed のたびに呼ぶ形)', () => {
		const first = applyTheme(SAMPLE, document);
		const second = applyTheme(OTHER, document);
		expect(second).toBe(first);
		expect(document.querySelectorAll('#vellis-theme').length).toBe(1);
		expect(first.textContent).toBe(themeCss(OTHER));
	});

	test('applyTheme は theme.css と同じセレクタで後から宣言する(文書順で勝つ)= 3 つのセレクタが theme.css にもある', () => {
		const injected = parseRules(stripComments(themeCss(SAMPLE))).map((r) => `${r.at.join(' ')}|${r.selector}`.replace(/\s+/g, ''));
		const generated = new Set(
			parseRules(stripComments(read('src/styles/theme.css'))).map((r) => `${r.at.join(' ')}|${r.selector}`.replace(/\s+/g, '')),
		);
		expect(injected.filter((s) => !generated.has(s)), 'theme.css に無いセレクタ(at-rule 込み)').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// theme_changed の購読
// ---------------------------------------------------------------------------

describe('AC-56-8 theme_changed の購読(契約 3): listen して payload を渡す', () => {
	test('registerThemeChangedListener は theme_changed を listen し、受けた ResolvedTheme をそのまま渡す', async () => {
		const onChanged = vi.fn();
		await registerThemeChangedListener(onChanged);
		const handlers = registry.get(THEME_CHANGED_EVENT) ?? [];
		expect(handlers.length, 'theme_changed が listen されていること').toBeGreaterThan(0);
		for (const h of handlers) h({ payload: SAMPLE });
		expect(onChanged).toHaveBeenCalledTimes(1);
		expect(onChanged).toHaveBeenCalledWith(SAMPLE);
	});

	test('他のイベントは購読しない(テーマの経路はモードの経路と交わらない)', async () => {
		await registerThemeChangedListener(() => {});
		expect([...registry.keys()]).toEqual([THEME_CHANGED_EVENT]);
	});
});

// ---------------------------------------------------------------------------
// Shiki の名前の照合(判断 (o))
// ---------------------------------------------------------------------------

describe('AC-56-8 Shiki の名前(判断 (o)): bundledThemes の鍵で照合し、無ければ Default の名前に戻す', () => {
	test('同梱の名前はそのまま(github-dark・vitesse-dark)', () => {
		expect(resolveCodeTheme('github-dark', DEFAULT_CODE_THEMES.dark)).toBe('github-dark');
		expect(resolveCodeTheme('vitesse-dark', DEFAULT_CODE_THEMES.dark)).toBe('vitesse-dark');
	});

	test('同梱に無い名前は fallback に戻して console.warn する', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(resolveCodeTheme('no-such-theme', DEFAULT_CODE_THEMES.dark)).toBe('github-dark');
		expect(warn).toHaveBeenCalled();
	});

	test('codeThemeFor は実効モードで code[0] / code[1] を選び、無い名前は Default に戻す', () => {
		expect(codeThemeFor(SAMPLE, 'light')).toBe('github-light');
		expect(codeThemeFor(SAMPLE, 'dark')).toBe('vitesse-dark');
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const broken: ResolvedTheme = { ...SAMPLE, code: ['no-such-light', 'no-such-dark'] };
		expect(codeThemeFor(broken, 'light')).toBe(DEFAULT_CODE_THEMES.light);
		expect(codeThemeFor(broken, 'dark')).toBe(DEFAULT_CODE_THEMES.dark);
	});
});

// ---------------------------------------------------------------------------
// +page.svelte の配線(ソース走査)
// ---------------------------------------------------------------------------

describe('AC-56-8 +page.svelte の配線: テーマを当て、theme_changed で当て直して Shiki を描き直す', () => {
	test("+page.svelte が '$lib/theme' を import し applyTheme( を呼ぶ", () => {
		const src = read('src/routes/+page.svelte');
		expect(src).toMatch(/from\s+['"]\$lib\/theme['"]/);
		expect(src).toContain('applyTheme(');
	});

	test('registerThemeChangedListener( の引数の中で applyTheme( と描き直し(render / redraw / highlight)を呼ぶ', () => {
		const src = read('src/routes/+page.svelte');
		const at = src.indexOf('registerThemeChangedListener(');
		expect(at, '+page.svelte が registerThemeChangedListener( を呼ぶこと').toBeGreaterThanOrEqual(0);
		const call = balancedCall(src, at);
		expect(call).toContain('applyTheme(');
		expect(call).toMatch(/render|redraw|highlight/i);
	});
});
