/**
 * 要件#56 の受け入れテスト(docs/requirements/req-56.md)— 見え方の変化の購読と波形の描き直し
 * (契約 7 第2段 (e)「波形(AudioViewer)はテーマ/モードの変化で描き直す」)
 *
 * 第1段の残課題(実装の要点 15): AudioViewer の波形は canvas に描くので、テーマやモードが変わっても
 * 描き直すまで前の色のまま。`drawWaveform` は `getComputedStyle(canvas)` で今の色を引くので、
 * 「見え方が変わった」ことを知らせて描き直させればよい。見え方が変わる経路は 3 つ=
 * テーマ(`theme_changed`・`$lib/theme`)・モード(`<html data-theme>` の付け外し・`$lib/ui-chrome`)・
 * OS の外観(System のときの `prefers-color-scheme` の変化)。
 *
 * 判定するもの:
 * - `src/lib/theme.ts` の `observeAppearance(onChange)` が、`theme_changed` の受信・`<html data-theme>` の変化・
 *   `matchMedia('(prefers-color-scheme: dark)')` の `change` のどれでも `onChange` を呼び、戻り値の関数で全部やめる
 * - `src/components/AudioViewer.svelte` が `$lib/theme` の `observeAppearance(` を呼び、その中で波形を描き直す
 *   (`drawWaveform(` か redraw を名に含む呼び出し)(ソース検査型)
 *
 * 判定しないもの(人間ゲート 4): 実機で View ▸ Appearance を切り替えたときに波形の色が変わること。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * ```ts
 * // src/lib/theme.ts に追加
 * /** 見え方(テーマ・モード・OS の外観)が変わったら onChange。theme_changed の listen + root(既定 document.documentElement)
 *     の data-theme の MutationObserver + matchMedia('(prefers-color-scheme: dark)') の change。戻り値=全部の解除 *\/
 * export function observeAppearance(onChange: () => void, root?: HTMLElement): Promise<() => void>;
 * ```
 *
 * - `AudioViewer.svelte` は `import { observeAppearance } from '$lib/theme'` し、マウント中だけ購読して(onMount / $effect の
 *   cleanup で解除)、届いたら `drawWaveform(` を今の材料で呼び直す(描画 effect を起こす書き方でもよいが、
 *   `observeAppearance(` の引数の中に `drawWaveform(` か `redraw` を含むこと)
 *
 * 判定方式: theme.wiring.test.ts と同じく `@tauri-apps/api/event` / `webviewWindow` の listen をモック。
 * MutationObserver は jsdom のもの。matchMedia は `change` のリスナーを捕まえる stub。
 *
 * 実装前の見立て(赤の理由): `observeAppearance` が無い(import で undefined)・AudioViewer に購読が無い。
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
		registry.set(
			event,
			(registry.get(event) ?? []).filter((h) => h !== handler),
		);
	});
}

vi.mock('@tauri-apps/api/event', () => ({ listen: (event: string, handler: Handler) => record(event, handler) }));
vi.mock('@tauri-apps/api/webviewWindow', () => {
	class FakeWebviewWindow {
		readonly label = 'req56-appearance';
		listen(event: string, handler: Handler): Promise<() => void> {
			return record(event, handler);
		}
	}
	return { getCurrentWebviewWindow: () => new FakeWebviewWindow(), WebviewWindow: FakeWebviewWindow };
});

import { THEME_CHANGED_EVENT, observeAppearance, type ResolvedTheme } from './theme';

const REPO_ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

const SAMPLE: ResolvedTheme = {
	name: 'forest',
	light: { 'color-accent': '#1f7a4d' },
	dark: { 'color-accent': '#3fae78' },
	code: ['github-light', 'github-dark'],
	warnings: [],
};

/** `change` のリスナーを捕まえる matchMedia(jsdom には無い)。 */
type MediaListener = (e: { matches: boolean; media: string }) => void;
let mediaListeners: MediaListener[] = [];
let mediaQueries: string[] = [];

function stubMatchMedia(): void {
	const impl = (query: string): MediaQueryList => {
		mediaQueries.push(query);
		return {
			matches: false,
			media: query,
			onchange: null,
			addEventListener: (_type: string, listener: MediaListener) => {
				mediaListeners.push(listener);
			},
			removeEventListener: (_type: string, listener: MediaListener) => {
				mediaListeners = mediaListeners.filter((l) => l !== listener);
			},
			addListener: (listener: MediaListener) => {
				mediaListeners.push(listener);
			},
			removeListener: (listener: MediaListener) => {
				mediaListeners = mediaListeners.filter((l) => l !== listener);
			},
			dispatchEvent: () => false,
		} as unknown as MediaQueryList;
	};
	Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(impl) });
}

function fireThemeChanged(): void {
	for (const h of registry.get(THEME_CHANGED_EVENT) ?? []) h({ payload: SAMPLE });
}

function fireOsAppearance(dark: boolean): void {
	for (const l of [...mediaListeners]) l({ matches: dark, media: '(prefers-color-scheme: dark)' });
}

/** MutationObserver の通知(microtask)を流す。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const root = () => document.documentElement;

beforeEach(() => {
	registry.clear();
	unlistenCalls.length = 0;
	mediaListeners = [];
	mediaQueries = [];
	root().removeAttribute('data-theme');
	stubMatchMedia();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// observeAppearance
// ---------------------------------------------------------------------------

describe('契約 7 第2段 (e) observeAppearance: テーマ・モード・OS の外観のどれが変わっても知らせる', () => {
	test('export されている(関数)', () => {
		expect(typeof observeAppearance).toBe('function');
	});

	test('theme_changed を受けたら onChange を呼ぶ', async () => {
		const onChange = vi.fn();
		await observeAppearance(onChange);
		expect((registry.get(THEME_CHANGED_EVENT) ?? []).length, 'theme_changed を listen すること').toBeGreaterThan(0);
		fireThemeChanged();
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	test('<html data-theme> の付け外し(モードの切替)で onChange を呼ぶ', async () => {
		const onChange = vi.fn();
		await observeAppearance(onChange);
		root().setAttribute('data-theme', 'dark');
		await flush();
		expect(onChange).toHaveBeenCalledTimes(1);
		root().setAttribute('data-theme', 'light');
		await flush();
		expect(onChange).toHaveBeenCalledTimes(2);
		root().removeAttribute('data-theme');
		await flush();
		expect(onChange).toHaveBeenCalledTimes(3);
	});

	test('root を渡せばその要素の data-theme を見る(document.documentElement が既定)', async () => {
		const onChange = vi.fn();
		const el = document.createElement('div');
		document.body.appendChild(el);
		try {
			await observeAppearance(onChange, el);
			el.setAttribute('data-theme', 'dark');
			await flush();
			expect(onChange).toHaveBeenCalledTimes(1);
		} finally {
			el.remove();
		}
	});

	test("OS の外観の変化= matchMedia('(prefers-color-scheme: dark)') の change で onChange を呼ぶ", async () => {
		const onChange = vi.fn();
		await observeAppearance(onChange);
		expect(mediaQueries.some((q) => /prefers-color-scheme\s*:\s*dark/.test(q)), 'prefers-color-scheme: dark を問い合わせること').toBe(true);
		expect(mediaListeners.length, 'change のリスナーを付けること').toBeGreaterThan(0);
		fireOsAppearance(true);
		expect(onChange).toHaveBeenCalledTimes(1);
		fireOsAppearance(false);
		expect(onChange).toHaveBeenCalledTimes(2);
	});

	test('戻り値の関数で 3 つの購読がすべて外れる(以後どの変化でも呼ばれない)', async () => {
		const onChange = vi.fn();
		const off = await observeAppearance(onChange);
		off();
		expect(unlistenCalls).toContain(THEME_CHANGED_EVENT);
		expect(mediaListeners, 'matchMedia の change リスナーが外れること').toEqual([]);
		fireThemeChanged();
		root().setAttribute('data-theme', 'dark');
		await flush();
		fireOsAppearance(true);
		expect(onChange).not.toHaveBeenCalled();
	});

	test('matchMedia が無い環境(古い WebView・SSR)でも落ちず、テーマとモードの変化は知らせる', async () => {
		Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined });
		const onChange = vi.fn();
		const off = await observeAppearance(onChange);
		fireThemeChanged();
		root().setAttribute('data-theme', 'dark');
		await flush();
		expect(onChange).toHaveBeenCalledTimes(2);
		off();
	});
});

// ---------------------------------------------------------------------------
// AudioViewer.svelte — 配線(ソース検査)
// ---------------------------------------------------------------------------

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

describe('契約 7 第2段 (e) AudioViewer.svelte: observeAppearance で波形を描き直す', () => {
	const audio = () => read('src/components/AudioViewer.svelte');

	test("'$lib/theme' から observeAppearance を import し、呼んでいる", () => {
		const src = audio();
		const importStmt = src.match(/import\s*\{[^}]*\}\s*from\s*['"]\$lib\/theme['"]/)?.[0] ?? '';
		expect(importStmt, "'$lib/theme' の import").not.toBe('');
		expect(importStmt).toMatch(/\bobserveAppearance\b/);
		expect(src).toContain('observeAppearance(');
	});

	test('observeAppearance( の引数の中で波形を描き直す(drawWaveform( か redraw を名に含む呼び出し)', () => {
		const src = audio();
		const at = src.indexOf('observeAppearance(');
		expect(at).toBeGreaterThanOrEqual(0);
		const call = balancedCall(src, at);
		expect(call).toMatch(/drawWaveform\(|redraw/i);
	});

	test('購読はマウント中だけ(onMount か $effect の中で呼び、戻り値の解除関数を受ける)', () => {
		const src = audio();
		const at = src.indexOf('observeAppearance(');
		expect(at).toBeGreaterThanOrEqual(0);
		expect(/onMount\(|\$effect\(/.test(src.slice(0, at)), 'onMount / $effect の中で購読すること').toBe(true);
		// 解除: 戻り値(Promise<() => void>)を .then で受けるか await して、cleanup で呼ぶ
		const around = src.slice(Math.max(0, at - 200), at + 400);
		expect(around, '解除関数を受けること').toMatch(/\.then\(|await\s+observeAppearance\(/);
	});
});
