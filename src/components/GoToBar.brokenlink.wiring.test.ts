/**
 * 要件#70 追補b の受け入れテスト(docs/requirements/req-70.md「追補b(2026-10-06・backlog 305)」)
 * — GoToBar のリンク切れの文言と +page.svelte の配線(AC-70-追b (g)(h)。component プロジェクト・
 * GoToBar.svelte を JSDOM に単体マウントする=GoToBar.wiring.test.ts と同じ家風)
 *
 * 解決と跳躍(`revealPath` が `brokenLink` を呼ぶこと=(a)〜(f))は
 * `src/lib/go-to-broken-link.acceptance.test.ts`(unit 側)。
 *
 * ## 配線に求める契約(追補b 2・3)
 * - `GoToBar` は `brokenLink?: boolean` を受け取り、立つと表示欄(`go-to-message`)に
 *   `GO_TO_BROKEN_LINK_MESSAGE`(= 'Broken symbolic link'・$lib/go-to-path から)を出す。
 *   `notFound` より優先する(両方立っていてもリンク切れの文言)
 * - 消え方は「無い」と同じ: 入力欄の値が変わったら消える・次の Go で出し直す。バーは開いたまま
 * - `+page.svelte`: `revealPath` の deps に `brokenLink` を渡し、`<GoToBar>` に `brokenLink` を渡す
 *
 * ## 判定(AC-70-追b)
 * - (g) `GoToBar` に `brokenLink` を渡すと表示欄にその文言、入力を変えると消える。`notFound` と
 *   両方立っていてもリンク切れの文言
 * - (h) `+page.svelte` の配線(ソース走査): `revealPath(` の第2引数(deps のオブジェクト)に
 *   `brokenLink` のキーがある・`<GoToBar … />` の属性に `brokenLink` がある
 *
 * ## 判断の記録(test-writer 2026-10-06)
 * - (h) の走査は `revealPath(` の括弧の対応で引数の範囲を切り出し、その中に `brokenLink` の
 *   キー(`brokenLink:` / `brokenLink(` / 省略記法)を探す。`<GoToBar` は次の `/>` までを属性とみなし、
 *   `brokenLink=` か `{brokenLink}` を探す(`bind:` などの書き方は問わない)
 * - 「次の Go で出し直す」は契約(追補b)2 の明文なので (g) に含める
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import GoToBar from './GoToBar.svelte';
import * as goToPath from '$lib/go-to-path';

const BROKEN_LINK_TEXT = 'Broken symbolic link';
const brokenLinkMessage = () => (goToPath as unknown as Record<string, unknown>).GO_TO_BROKEN_LINK_MESSAGE;

function mountBar(props: { notFound?: boolean; brokenLink?: boolean } = {}) {
	const onGo = vi.fn((_input: string) => {});
	const onClose = vi.fn(() => {});
	const utils = render(GoToBar, {
		// brokenLink は追補b で足す prop(実装前の型には無い)。
		props: { onGo, onClose, notFound: props.notFound ?? false, brokenLink: props.brokenLink ?? false } as never,
	});
	return { onGo, onClose, ...utils };
}

const input = () => screen.getByTestId('go-to-input') as HTMLInputElement;
const message = () => screen.getByTestId('go-to-message');

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (g) バーの表示欄
// ---------------------------------------------------------------------------

describe('AC-70-追b (g): GoToBar の表示欄にリンク切れの文言', () => {
	it('brokenLink を立てると表示欄に `Broken symbolic link`(値固定=GO_TO_BROKEN_LINK_MESSAGE)が出る', () => {
		mountBar({ brokenLink: true });

		expect(message().textContent?.trim()).toBe(BROKEN_LINK_TEXT);
		expect(message().textContent?.trim()).toBe(brokenLinkMessage());
	});

	it('notFound と両方立っていてもリンク切れの文言(「無い」の文言は出ない)', () => {
		mountBar({ brokenLink: true, notFound: true });

		expect(message().textContent?.trim()).toBe(BROKEN_LINK_TEXT);
		expect(message().textContent ?? '').not.toContain(goToPath.GO_TO_NOT_FOUND_MESSAGE);
	});

	it('入力欄の値が変わると消える(バーと入力した文字は残る)', async () => {
		const { onClose } = mountBar({ brokenLink: true });
		expect(message().textContent?.trim()).toBe(BROKEN_LINK_TEXT);

		await fireEvent.input(input(), { target: { value: 'docs/x' } });

		expect(message().textContent ?? '').not.toContain(BROKEN_LINK_TEXT);
		expect(screen.getByTestId('go-to-bar')).toBeTruthy();
		expect(input().value).toBe('docs/x');
		expect(onClose).not.toHaveBeenCalled();
	});

	it('消えた後、次の Go で出し直す(「無い」と同じ消え方)', async () => {
		const { onGo } = mountBar({ brokenLink: true });

		await fireEvent.input(input(), { target: { value: 'gone.md' } });
		expect(message().textContent ?? '').not.toContain(BROKEN_LINK_TEXT);

		await fireEvent.click(screen.getByTestId('go-to-go'));

		expect(onGo).toHaveBeenCalledTimes(1);
		expect(message().textContent?.trim()).toBe(BROKEN_LINK_TEXT);
	});

	it('brokenLink も notFound も立っていなければ表示欄は空', () => {
		mountBar({ brokenLink: false, notFound: false });

		expect(message().textContent?.trim()).toBe('');
	});
});

// ---------------------------------------------------------------------------
// (h) +page.svelte の配線(ソース走査)
// ---------------------------------------------------------------------------

const PAGE_PATH = resolve(__dirname, '../routes/+page.svelte');

/** `open` の位置の `(` に対応する `)` までの中身(文字列・テンプレートの中の括弧は数えない簡易版)。 */
function balancedArgs(source: string, openParen: number): string {
	let depth = 0;
	let quote: string | null = null;
	for (let i = openParen; i < source.length; i++) {
		const ch = source[i];
		if (quote) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			continue;
		}
		if (ch === '/' && source[i + 1] === '/') {
			const nl = source.indexOf('\n', i);
			i = nl === -1 ? source.length : nl;
			continue;
		}
		if (ch === '/' && source[i + 1] === '*') {
			const end = source.indexOf('*/', i + 2);
			i = end === -1 ? source.length : end + 1;
			continue;
		}
		if (ch === '(') depth++;
		if (ch === ')') {
			depth--;
			if (depth === 0) return source.slice(openParen + 1, i);
		}
	}
	return source.slice(openParen + 1);
}

/** 行コメント・ブロックコメントを落とす(配線の判定をコメントの文字で通さないため)。 */
function stripJsComments(code: string): string {
	return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

describe('AC-70-追b (h): +page.svelte の配線(ソース走査)', () => {
	it('revealPath の deps に brokenLink を渡す', () => {
		const source = readFileSync(PAGE_PATH, 'utf8');
		const calls: string[] = [];
		const re = /\brevealPath\s*\(/g;
		for (let m = re.exec(source); m !== null; m = re.exec(source)) {
			const open = m.index + m[0].length - 1;
			calls.push(stripJsComments(balancedArgs(source, open)));
		}
		expect(calls.length, '+page.svelte calls revealPath(…)').toBeGreaterThanOrEqual(1);
		expect(
			calls.some((args) => /(^|[\s,{])brokenLink\s*(:|\(|,|\}|$)/m.test(args)),
			'revealPath(raw, { …, brokenLink: () => …, … }) — the deps object needs a brokenLink key'
		).toBe(true);
	});

	it('<GoToBar> に brokenLink を渡す', () => {
		const source = readFileSync(PAGE_PATH, 'utf8');
		const start = source.search(/<GoToBar\b/);
		expect(start, '+page.svelte renders <GoToBar').toBeGreaterThanOrEqual(0);
		const end = source.indexOf('/>', start);
		expect(end, '<GoToBar … /> is self-closing').toBeGreaterThan(start);
		const attrs = source.slice(start, end);
		expect(
			/(^|\s)brokenLink\s*=|(^|\s)\{\s*brokenLink\s*\}/.test(attrs),
			'<GoToBar … brokenLink={…} /> — pass the broken-link state to the bar'
		).toBe(true);
	});
});
