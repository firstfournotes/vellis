/**
 * 要件#88 の受け入れテスト(docs/requirements/req-88.md)— 文字参照を解く 2 つの側(AC-88-6・照合の P2-2)
 *
 * `decideHtmlLink` は `href` の文字参照を「HTML の属性値と同じ規則」で解く。作りは 2 つの側を持つ:
 * アプリ(WKWebView)では `DOMParser` の不活性な文書に属性値として読ませて HTML パーサに解かせ、DOM の無いところでは
 * 数値参照と基本の名前つき参照だけを解く予備の側に落ちる。本ファイルは **同じ期待値を両方の側で回す**(片方しか見ないと、
 * アプリで実際に通る側の違いが見えない)。
 *
 * - DOM の側: `@vitest-environment jsdom`(このリポジトリの unit プロジェクトは jsdom が既定・navigation-net.acceptance.test.ts
 *   ほかに前例)。`typeof DOMParser === 'function'` を前提として確かめてから回す
 * - 予備の側: `vi.stubGlobal('DOMParser', undefined)` で DOM を外して同じ表を回す
 *
 * 期待(HTML の属性値の規則):
 * - `&amp;`・`&#47;`・`&#x2F;`・`&quot;` を解く
 * - `&#106;avascript:`(文字参照で書いたスキーム)は解いてから判定して none。`java&#x9;script:`(スキームの中のタブ)も none
 * - `;` の無い `&copy=1` は解かない(属性値の中では `=` が続く名前つき参照は文字のまま)→ パスにそのまま残る
 * - 1 回だけ解く: `&amp;#106;avascript:x` は `&#106;avascript:x` になるだけで、2 回解いて `javascript:` にはならない
 *   (相対パスとして今の文書から解決される file: の URI になる)
 *
 * ## 実装前の見立て(赤の理由)
 * `./html-link` が無ければ import で全件赤。両方の側が同じ規則で解けていなければ、どちらかの describe が赤になる。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { decideHtmlLink, type HtmlLinkAction } from './html-link';

const TOKEN = 'tok_ABC-123_xyz';
const DOC = 'file:///a/b/doc.html';

function decide(raw: string): HtmlLinkAction {
	return decideHtmlLink({ url: `vellis-asset://link/${TOKEN}?href=${encodeURIComponent(raw)}`, token: TOKEN, docUri: DOC });
}

const NONE: HtmlLinkAction = { kind: 'none' };

/** 両方の側で同じ答えになる表: [原文の href, 期待]。 */
const CASES: Array<[raw: string, expected: HtmlLinkAction]> = [
	['https://e.example/?a=1&amp;b=2', { kind: 'external', url: 'https://e.example/?a=1&b=2' }],
	['other&#47;page.html', { kind: 'open', uri: 'file:///a/b/other/page.html' }],
	['other&#x2F;page.html', { kind: 'open', uri: 'file:///a/b/other/page.html' }],
	['https://e.example/?t=&quot;x&quot;', { kind: 'external', url: 'https://e.example/?t="x"' }],
	['&#106;avascript:alert(1)', NONE],
	['java&#x9;script:alert(1)', NONE],
	['notes&copy=1.html', { kind: 'open', uri: 'file:///a/b/notes&copy=1.html' }],
	['https://e.example/?q=&amp;amp;', { kind: 'external', url: 'https://e.example/?q=&amp;' }],
];

function runTheTable() {
	for (const [raw, expected] of CASES) {
		test(`${JSON.stringify(raw)} → ${JSON.stringify(expected)}`, () => {
			expect(decide(raw)).toEqual(expected);
		});
	}

	test('`&amp;#106;avascript:x` は 1 回だけ解く(2 回解いて javascript: にならず、今の文書からの相対パスの file: になる)', () => {
		const action = decide('&amp;#106;avascript:x');
		expect(action.kind).toBe('open');
		expect((action as { kind: 'open'; uri: string }).uri.startsWith('file:///a/b/')).toBe(true);
	});
}

describe('AC-88-6 文字参照 — DOM の側(アプリで実際に通る側: DOMParser)', () => {
	test('前提: この環境に DOMParser がある(jsdom)', () => {
		expect(typeof DOMParser).toBe('function');
	});

	runTheTable();
});

describe('AC-88-6 文字参照 — 予備の側(DOM が無いとき)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('前提: DOMParser を外すと typeof が undefined になる', () => {
		vi.stubGlobal('DOMParser', undefined);
		expect(typeof DOMParser).toBe('undefined');
	});

	for (const [raw, expected] of CASES) {
		test(`${JSON.stringify(raw)} → ${JSON.stringify(expected)}(DOMParser なし)`, () => {
			vi.stubGlobal('DOMParser', undefined);
			expect(decide(raw)).toEqual(expected);
		});
	}

	test('`&amp;#106;avascript:x` は 1 回だけ解く(DOMParser なし)', () => {
		vi.stubGlobal('DOMParser', undefined);
		const action = decide('&amp;#106;avascript:x');
		expect(action.kind).toBe('open');
		expect((action as { kind: 'open'; uri: string }).uri.startsWith('file:///a/b/')).toBe(true);
	});
});
