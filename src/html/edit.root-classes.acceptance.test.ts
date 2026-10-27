/**
 * 要件#54 追補e の受け入れテスト — `buildEditSurface` が文書の `<html>` / `<body>` の class を
 * `rootClasses` として返す(docs/requirements/req-54.md「追補e」(2026-10-25)・AC-54-追e (c)・
 * Issue #551)
 *
 * `html.dark body{…}` を `.root.dark{…}` に畳んでも(AC-54-追e (b))、複製面・編集面のルートは
 * 文書の `<html>` の class を持たないので当たらない。そこで `buildEditSurface` が class の語を
 * 持ち出し、`Viewer.svelte` がルートの class に足す(配線は
 * `src/components/Viewer.surface-root-classes.wiring.test.ts`=AC-54-追e (d))。
 *
 * ## 確定契約(追補e 3。implementer はこれに従う)
 *
 * ```ts
 * // src/html/edit.ts(既存の型にフィールドを 1 つ足す)
 * export type EditSurface = {
 *   html: string;
 *   index: EditSurfaceIndex;
 *   styles: string[];
 *   /** 文書の <html> と <body> の class の語(出てきた順・重複なし)。無ければ []。 *\/
 *   rootClasses: string[];
 * };
 * ```
 * - 「出てきた順」= `<html>` の class の語 → `<body>` の class の語。語は ASCII 空白
 *   (空白・タブ・改行)で区切る。語の大小は変えない(class は大小を区別する)
 * - 起案時判断 (b): 持ち出すのは class の語だけ(id・属性は持ち出さない)
 * - 不変: `html` / `index` / `styles` は class の有無で変わらない
 *
 * ## 型について
 * 本テストは実装前にも `pnpm check` を通す必要があるので、`rootClasses` は型を介さず
 * `rootClassesOf()` で読む(実装後は `surface.rootClasses` と同じ値)。
 *
 * 実装前に赤い理由: `EditSurface` に `rootClasses` が無く `undefined` が返るので、
 * `toEqual([...])` / `toEqual([])` がどれも失敗する。
 */
import { describe, expect, test } from 'vitest';
import { buildEditSurface } from './edit';

const DOC_URI = 'file:///Users/a/site/page.html';

/** `rootClasses` を型を介さずに読む(実装前は undefined)。 */
function rootClassesOf(surface: unknown): unknown {
	return (surface as { rootClasses?: unknown }).rootClasses;
}

function doc(htmlAttrs: string, bodyAttrs: string): string {
	return [
		'<!doctype html>',
		`<html${htmlAttrs}>`,
		'<head><title>t</title><style>html.dark body{background:#222}</style></head>',
		`<body${bodyAttrs}>`,
		'<p id="a">Hello</p>',
		'</body>',
		'</html>',
		'',
	].join('\n');
}

describe('AC-54-追e (c) — buildEditSurface が <html> / <body> の class の語を rootClasses で返す', () => {
	test('<html class="dark x"><body class="y dark"> → [dark, x, y](出てきた順・重複なし)', () => {
		const surface = buildEditSurface(doc(' class="dark x"', ' class="y dark"'), DOC_URI);
		expect(rootClassesOf(surface)).toEqual(['dark', 'x', 'y']);
	});

	test('<html class="b"><body class="a"> → [b, a](html の語が先・並べ替えない)', () => {
		const surface = buildEditSurface(doc(' class="b"', ' class="a"'), DOC_URI);
		expect(rootClassesOf(surface)).toEqual(['b', 'a']);
	});

	test('<body class="z"> だけ → [z]', () => {
		const surface = buildEditSurface(doc('', ' class="z"'), DOC_URI);
		expect(rootClassesOf(surface)).toEqual(['z']);
	});

	test('<html class="h"> だけ → [h]', () => {
		const surface = buildEditSurface(doc(' class="h"', ''), DOC_URI);
		expect(rootClassesOf(surface)).toEqual(['h']);
	});

	test('class が無ければ空の配列', () => {
		const surface = buildEditSurface(doc('', ''), DOC_URI);
		expect(rootClassesOf(surface)).toEqual([]);
	});

	test('<html> も <body> も書かれていない断片でも空の配列', () => {
		const surface = buildEditSurface('<p>bare</p>', DOC_URI);
		expect(rootClassesOf(surface)).toEqual([]);
	});

	test('空白(空白・タブ・改行)で区切り、前後の空白と重複は落とす', () => {
		const surface = buildEditSurface(doc(' class="  a \t b\nc  a "', ' class="c d"'), DOC_URI);
		expect(rootClassesOf(surface)).toEqual(['a', 'b', 'c', 'd']);
	});

	test('属性名の大小は HTML どおり無視し、語の大小は変えない(CLASS="Dark" → Dark)', () => {
		const surface = buildEditSurface(doc(' CLASS="Dark"', ' class="Dark light"'), DOC_URI);
		expect(rootClassesOf(surface)).toEqual(['Dark', 'light']);
	});

	test('id・lang などの属性は持ち出さない(起案時判断 (b)=class の語だけ)', () => {
		const surface = buildEditSurface(doc(' id="top" lang="ja" class="dark"', ' id="b"'), DOC_URI);
		expect(rootClassesOf(surface)).toEqual(['dark']);
	});
});

describe('AC-54-追e (c) — class を足しても html / index / styles は変わらない(不変)', () => {
	test('class の有無で html と styles が同じ・index の件数も同じ', () => {
		const plain = buildEditSurface(doc('', ''), DOC_URI);
		const classed = buildEditSurface(doc(' class="dark x"', ' class="y dark"'), DOC_URI);
		expect(classed.html).toBe(plain.html);
		expect(classed.styles).toEqual(plain.styles);
		expect(classed.index.size).toBe(plain.index.size);
		// 編集面の HTML はルートの class を含まない(ルートは Viewer が作る)。
		expect(classed.html).not.toContain('y dark');
	});
});
