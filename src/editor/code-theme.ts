/**
 * CodeMirror の面の配色(要件#74 契約5・(ai) 決定・契約19 の「第1段の作り」13・AC-74-30 (2))。
 *
 * Shiki の同梱テーマ(TextMate の tokenColors)から、Lezer のタグ → TextMate のスコープの表で色を引いて
 * `HighlightStyle` を作る。字句の切り方が Shiki と違う箇所は色が違ってよい(起案時判断 (v))。
 * 背景・前景・選択・カーソル・行番号の色はテーマから取らず Vellis のトークン(`--color-*`)のまま。
 *
 * テーマの JSON は `shiki` の `bundledThemes` から遅延読み込みする(印刷と Markdown の今の描画が使う
 * のと同じ同梱テーマ)。
 */
import { HighlightStyle, type TagStyle } from '@codemirror/language';
import { tags, type Tag } from '@lezer/highlight';
import { bundledThemes, type BundledTheme } from 'shiki';

export type TokenColor = { scope?: string | string[]; settings: { foreground?: string; fontStyle?: string } };
export type ThemeColors = { fg?: string; colors?: Record<string, string>; tokenColors: TokenColor[] };

/** タグ → TextMate のスコープ(受け入れテストが固定する表)。 */
export const TAG_SCOPES: ReadonlyArray<{ tag: Tag; scope: string }> = [
	{ tag: tags.keyword, scope: 'keyword' },
	{ tag: tags.string, scope: 'string' },
	{ tag: tags.comment, scope: 'comment' },
	{ tag: tags.number, scope: 'constant.numeric' },
	{ tag: tags.typeName, scope: 'entity.name.type' },
	{ tag: tags.function(tags.variableName), scope: 'entity.name.function' },
	{ tag: tags.propertyName, scope: 'support.type.property-name' },
	{ tag: tags.operator, scope: 'keyword.operator' },
	{ tag: tags.tagName, scope: 'entity.name.tag' },
];

/**
 * 表の外の補い(周回0 の 0-7 の試作の表から、上の 9 つと重ならないもの)。上の表の後に並べるので、
 * 上の 9 つのタグの色はいつも上の表で決まる。
 */
const EXTRA_TAG_SCOPES: ReadonlyArray<{ tag: Tag; scope: string }> = [
	{ tag: tags.function(tags.propertyName), scope: 'entity.name.function' },
	{ tag: tags.definitionKeyword, scope: 'storage.type' },
	{ tag: tags.modifier, scope: 'storage.modifier' },
	{ tag: tags.self, scope: 'variable.language.this' },
	{ tag: tags.bool, scope: 'constant.language' },
	{ tag: tags.null, scope: 'constant.language' },
	{ tag: tags.atom, scope: 'constant.language' },
	{ tag: tags.regexp, scope: 'string.regexp' },
	{ tag: tags.escape, scope: 'constant.character.escape' },
	{ tag: tags.className, scope: 'entity.name.type.class' },
	{ tag: tags.namespace, scope: 'entity.name.type.module' },
	{ tag: tags.macroName, scope: 'entity.name.function.macro' },
	{ tag: tags.attributeName, scope: 'entity.other.attribute-name' },
	{ tag: tags.heading, scope: 'markup.heading' },
	{ tag: tags.link, scope: 'markup.underline.link' },
	{ tag: tags.url, scope: 'markup.underline.link' },
	{ tag: tags.inserted, scope: 'markup.inserted' },
	{ tag: tags.deleted, scope: 'markup.deleted' },
	{ tag: tags.changed, scope: 'markup.changed' },
	{ tag: tags.invalid, scope: 'invalid.illegal' },
];

/**
 * スコープの色の解決(純関数): tokenColors のうち、スコープが target と一致するか `scope + '.'` で
 * 前置するものの中で最も長いスコープの foreground。同じ長さなら後の行。1 つも無ければ theme の
 * fg(前景色)。小文字の #rrggbb。
 */
export function scopeColor(theme: ThemeColors, target: string): string {
	let best: { length: number; color: string } | null = null;
	for (const tc of theme.tokenColors) {
		const fg = tc.settings.foreground;
		if (!fg) continue;
		const scopes = Array.isArray(tc.scope) ? tc.scope : tc.scope ? tc.scope.split(',') : [];
		for (const raw of scopes) {
			const scope = raw.trim();
			if (scope.length === 0) continue;
			if (scope !== target && !target.startsWith(scope + '.')) continue;
			if (!best || scope.length >= best.length) best = { length: scope.length, color: fg.toLowerCase() };
		}
	}
	return (best?.color ?? theme.fg ?? theme.colors?.['editor.foreground'] ?? '').toLowerCase();
}

/** 呼び手が知らない名前を渡したときのテーマ(themes/default.json の `code.light`)。 */
const FALLBACK_THEME = 'github-light';

const cache = new Map<string, Promise<HighlightStyle>>();

async function loadTheme(name: string): Promise<ThemeColors> {
	const loader = (bundledThemes as Record<string, (() => Promise<unknown>) | undefined>)[name];
	const mod = (await (loader ?? bundledThemes[FALLBACK_THEME as BundledTheme])()) as {
		default?: ThemeColors;
	} & ThemeColors;
	return (mod.default ?? mod) as ThemeColors;
}

/** Shiki の同梱テーマの名前(`github-light` など)から CodeMirror の HighlightStyle を作る(テーマの JSON は遅延読み込み)。 */
export function highlightStyleFor(theme: string): Promise<HighlightStyle> {
	let style = cache.get(theme);
	if (!style) {
		style = loadTheme(theme).then((json) => {
			const specs: TagStyle[] = [...TAG_SCOPES, ...EXTRA_TAG_SCOPES].map(({ tag, scope }) => ({
				tag,
				color: scopeColor(json, scope),
			}));
			return HighlightStyle.define(specs);
		});
		style.catch(() => cache.delete(theme));
		cache.set(theme, style);
	}
	return style;
}
