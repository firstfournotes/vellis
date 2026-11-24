/**
 * 要件#74 第1段の受け入れテスト(docs/requirements/req-74.md)— CodeMirror の配色
 * (AC-74-30 (2)・契約5・(ai) 決定・契約19 の「第1段の作り」13。unit プロジェクト)
 *
 * (ai)=「Shiki のテーマの色の表(TextMate の tokenColors)から、Lezer のタグ → TextMate のスコープの対応表で色を引いて
 * 作る」。本テストは **タグ → スコープの表を固定**し、Shiki の同梱テーマ(`shiki` の `bundledThemes`=既にある devDependency)
 * から期待する色を**テストの中で引いて**、`highlightStyleFor(テーマ名)` の `HighlightStyle` が同じ色を持つことを見る。
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 契約19「第1段の作り」13・AC-74-30)
 *
 * ```ts
 * // --- src/editor/code-theme.ts(新規)
 * import { HighlightStyle } from '@codemirror/language';
 * /** Shiki の同梱テーマの名前(`github-light` など)から CodeMirror の HighlightStyle を作る(テーマの JSON は遅延読み込み)。 *\/
 * export async function highlightStyleFor(theme: string): Promise<HighlightStyle>;
 * /** タグ → TextMate のスコープ(本テストの TAG_SCOPES と同じ表。実装も同じ表を持つ)。 *\/
 * export const TAG_SCOPES: ReadonlyArray<{ tag: Tag; scope: string }>;
 * /** スコープの色の解決(純関数): tokenColors のうち、スコープが target と一致するか `scope + '.'` で前置するものの中で
 *  *  **最も長いスコープ**の foreground。同じ長さなら後の行。1 つも無ければ theme の fg(前景色)。小文字の #rrggbb。 *\/
 * export function scopeColor(theme: { fg?: string; colors?: Record<string, string>; tokenColors: TokenColor[] }, target: string): string;
 * ```
 *
 * スコープの解決の規則は TextMate の「最も具体的な一致」を、**前置の一致・最長**で近似したもの(値固定)。
 * `HighlightStyle.specs`(公開の読み取り専用=`TagStyle[]`)の中に、表の各タグを `tag` に持つ spec があり、その `color`
 * がこの規則で引いた色と一致すること。
 *
 * ## 判断の記録(test-writer 2026-11-16)
 * - タグ → スコープの表(契約の「キーワード・文字列・コメント・数値・型・関数名・属性 / プロパティ・演算子」+ タグ名):
 *   `keyword`→`keyword`・`string`→`string`・`comment`→`comment`・`number`→`constant.numeric`・`typeName`→`entity.name.type`・
 *   `function(variableName)`→`entity.name.function`・`propertyName`→`support.type.property-name`・`operator`→`keyword.operator`・
 *   `tagName`→`entity.name.tag`。github-light / github-dark では `constant.numeric` は `constant` の行、`entity.name.type` と
 *   `entity.name.function` は `entity.name` の行、`support.type.property-name` は `support` の行、`keyword.operator` は `keyword`
 *   の行に解決する(2026-11-16 に shiki 4 の同梱テーマで実測)
 * - 期待値はテーマ JSON から引く(Shiki の版が上がって色が変わっても追従する)が、要件の趣旨(v)の見比べの相手として
 *   github-light の keyword `#d73a49`・string `#032f62`・comment `#6a737d`、github-dark の keyword `#f97583`・string `#9ecbff`
 *   も**実測値で固定**する(表の解決の規則そのものの確かめ)
 *
 * ## 修正前に赤になる理由
 * - `src/editor/code-theme.ts` が無く、`@codemirror/language` / `@lezer/highlight` も依存に無いので import で落ちる
 *   (「前提」の Shiki の実測だけは実装前から緑)
 */
import { describe, expect, test } from 'vitest';
import { bundledThemes } from 'shiki';
import { tags, type Tag } from '@lezer/highlight';
import type { HighlightStyle } from '@codemirror/language';

import { highlightStyleFor, scopeColor, TAG_SCOPES } from './code-theme';

type TokenColor = { scope?: string | string[]; settings: { foreground?: string; fontStyle?: string } };
type ThemeJson = { fg?: string; colors?: Record<string, string>; tokenColors: TokenColor[] };

/** 本テストが固定する対応表(実装の TAG_SCOPES と同じでなければ赤)。 */
const EXPECTED_TAG_SCOPES: ReadonlyArray<{ name: string; tag: Tag; scope: string }> = [
	{ name: 'keyword', tag: tags.keyword, scope: 'keyword' },
	{ name: 'string', tag: tags.string, scope: 'string' },
	{ name: 'comment', tag: tags.comment, scope: 'comment' },
	{ name: 'number', tag: tags.number, scope: 'constant.numeric' },
	{ name: 'typeName', tag: tags.typeName, scope: 'entity.name.type' },
	{ name: 'function(variableName)', tag: tags.function(tags.variableName), scope: 'entity.name.function' },
	{ name: 'propertyName', tag: tags.propertyName, scope: 'support.type.property-name' },
	{ name: 'operator', tag: tags.operator, scope: 'keyword.operator' },
	{ name: 'tagName', tag: tags.tagName, scope: 'entity.name.tag' },
];

const THEMES = ['github-light', 'github-dark'] as const;

async function loadTheme(name: (typeof THEMES)[number]): Promise<ThemeJson> {
	const mod = (await bundledThemes[name]()) as { default?: ThemeJson } & ThemeJson;
	return (mod.default ?? mod) as ThemeJson;
}

/** テスト側の参照実装(契約の規則をそのまま書いたもの)。 */
function referenceScopeColor(theme: ThemeJson, target: string): string {
	let best: { length: number; color: string } | null = null;
	for (const tc of theme.tokenColors) {
		const fg = tc.settings.foreground;
		if (!fg) continue;
		const scopes = Array.isArray(tc.scope) ? tc.scope : tc.scope ? [tc.scope] : [];
		for (const raw of scopes) {
			const scope = raw.trim();
			if (scope !== target && !target.startsWith(scope + '.')) continue;
			if (!best || scope.length >= best.length) best = { length: scope.length, color: fg.toLowerCase() };
		}
	}
	return (best?.color ?? theme.fg ?? theme.colors?.['editor.foreground'] ?? '').toLowerCase();
}

function specColorFor(style: HighlightStyle, tag: Tag): string | null {
	for (const spec of style.specs) {
		const list = Array.isArray(spec.tag) ? (spec.tag as readonly Tag[]) : [spec.tag as Tag];
		if (list.includes(tag)) {
			const color = (spec as { color?: string }).color;
			return typeof color === 'string' ? color.toLowerCase() : null;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// 前提の確認 — Shiki の同梱テーマの実測(2026-11-16)。表の解決の規則の確かめ
// ---------------------------------------------------------------------------

describe('前提: github-light / github-dark の代表のスコープの色(shiki の同梱テーマ・実測)', () => {
	test('github-light', async () => {
		const theme = await loadTheme('github-light');
		expect(referenceScopeColor(theme, 'keyword')).toBe('#d73a49');
		expect(referenceScopeColor(theme, 'string')).toBe('#032f62');
		expect(referenceScopeColor(theme, 'comment')).toBe('#6a737d');
		expect(referenceScopeColor(theme, 'entity.name.tag')).toBe('#22863a');
		// 前置の一致: constant.numeric → constant・entity.name.function → entity.name・keyword.operator → keyword
		expect(referenceScopeColor(theme, 'constant.numeric')).toBe('#005cc5');
		expect(referenceScopeColor(theme, 'entity.name.function')).toBe('#6f42c1');
		expect(referenceScopeColor(theme, 'keyword.operator')).toBe('#d73a49');
	});

	test('github-dark', async () => {
		const theme = await loadTheme('github-dark');
		expect(referenceScopeColor(theme, 'keyword')).toBe('#f97583');
		expect(referenceScopeColor(theme, 'string')).toBe('#9ecbff');
		expect(referenceScopeColor(theme, 'comment')).toBe('#6a737d');
		expect(referenceScopeColor(theme, 'entity.name.tag')).toBe('#85e89d');
	});
});

// ---------------------------------------------------------------------------
// AC-74-30 (2) — 配色
// ---------------------------------------------------------------------------

describe('AC-74-30 (2): TAG_SCOPES は固定の表', () => {
	test('表の中身(タグとスコープの組・順は問わない)', () => {
		const actual = TAG_SCOPES.map((row) => ({ tag: row.tag, scope: row.scope }));
		for (const row of EXPECTED_TAG_SCOPES) {
			expect(actual, `TAG_SCOPES に ${row.name} → ${row.scope} がある`).toContainEqual({ tag: row.tag, scope: row.scope });
		}
		expect(actual).toHaveLength(EXPECTED_TAG_SCOPES.length);
	});
});

describe('AC-74-30 (2): scopeColor はスコープの前置の一致・最長で色を引く', () => {
	test.each(THEMES)('%s: 表のすべてのスコープで参照実装と一致', async (name) => {
		const theme = await loadTheme(name);
		for (const row of EXPECTED_TAG_SCOPES) {
			expect(scopeColor(theme, row.scope), `${name} ${row.scope}`).toBe(referenceScopeColor(theme, row.scope));
		}
	});

	test('どの行にも当たらないスコープは前景色(fg)に落ちる', () => {
		const theme: ThemeJson = {
			fg: '#ABCDEF',
			tokenColors: [{ scope: 'keyword', settings: { foreground: '#111111' } }],
		};
		expect(scopeColor(theme, 'markup.quote')).toBe('#abcdef');
		expect(scopeColor(theme, 'keyword')).toBe('#111111');
		expect(scopeColor(theme, 'keyword.operator')).toBe('#111111');
		// `keywords`(ドット境界でない前置)は一致しない。
		expect(scopeColor(theme, 'keywords')).toBe('#abcdef');
	});

	test('長いスコープが勝つ・同じ長さなら後の行が勝つ・foreground の無い行は飛ばす', () => {
		const theme: ThemeJson = {
			fg: '#000000',
			tokenColors: [
				{ scope: 'entity.name.function', settings: { foreground: '#222222' } },
				{ scope: ['entity', 'entity.name'], settings: { foreground: '#111111' } },
				{ scope: 'entity.name.type', settings: { fontStyle: 'italic' } },
				{ scope: 'keyword', settings: { foreground: '#333333' } },
				{ scope: 'keyword', settings: { foreground: '#444444' } },
			],
		};
		expect(scopeColor(theme, 'entity.name.function')).toBe('#222222');
		expect(scopeColor(theme, 'entity.name.type')).toBe('#111111');
		expect(scopeColor(theme, 'keyword')).toBe('#444444');
	});
});

describe('AC-74-30 (2): highlightStyleFor(テーマ名) の色が Shiki のそのテーマの代表のスコープの色と一致する', () => {
	test.each(THEMES)('%s', async (name) => {
		const theme = await loadTheme(name);
		const style = await highlightStyleFor(name);
		for (const row of EXPECTED_TAG_SCOPES) {
			const expected = referenceScopeColor(theme, row.scope);
			expect(expected, `${name}: ${row.scope} の色が引ける`).toMatch(/^#[0-9a-f]{6}$/);
			expect(specColorFor(style, row.tag), `${name}: HighlightStyle の ${row.name}(${row.scope})`).toBe(expected);
		}
	});

	test('github-light と github-dark で違う色になる(モードに追従する=契約5)', async () => {
		const light = await highlightStyleFor('github-light');
		const dark = await highlightStyleFor('github-dark');
		expect(specColorFor(light, tags.keyword)).toBe('#d73a49');
		expect(specColorFor(dark, tags.keyword)).toBe('#f97583');
		expect(specColorFor(light, tags.string)).not.toBe(specColorFor(dark, tags.string));
	});

	test('HighlightStyle として使える(style() がクラス名を返す)', async () => {
		const style = await highlightStyleFor('github-light');
		expect(typeof style.style([tags.keyword])).toBe('string');
	});
});
