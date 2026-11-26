/**
 * 要件#88 の受け入れテスト(docs/requirements/req-88.md)— 届いたクリックから「すること」を決める側(AC-88-6)
 * 「HTML の表示の中のリンクを使えるようにする(ローカルの別のファイルは Vellis で・外部の URL はブラウザで)」
 *
 * 仕組み(req-88.md「作り(決めたこと)」§3): クリックすると iframe は `vellis-asset://link/<token>?href=…` へ
 * ナビゲーションしようとし、Rust が拒否してその窓にイベント `html_link_clicked`(payload `{ url }`)を送る。
 * 窓は、届いた URL・窓ごとのトークン・今の文書の URI から、純関数 `decideHtmlLink` で することを決める。
 *
 * ## 確定契約(implementer はこれに従う=オーケストレーターが名前を決めた・2026-11-26)
 *
 * ```ts
 * // src/lib/html-link.ts(新規)
 * export const HTML_LINK_CLICKED_EVENT = 'html_link_clicked';     // Rust navigation.rs の同名定数と同じリテラル
 * export function createLinkToken(): string;                        // [A-Za-z0-9_-]+・128 bit 以上の乱数(crypto.getRandomValues)・呼ぶたびに違う
 * export type HtmlLinkAction = { kind: 'none' } | { kind: 'external'; url: string } | { kind: 'open'; uri: string };
 * export function decideHtmlLink(input: { url: string; token: string; docUri: string }): HtmlLinkAction;
 * ```
 *
 * `decideHtmlLink` の規則(契約 1・2・4・7・作り §3):
 * - URL が `vellis-asset://link/<token>?href=…` の形でない・トークンが違う → `none`
 * - `href` の文字参照を解き(HTML の属性値と同じ規則= `&amp;` `&quot;` `&#47;` `&#x2F;` …)、前後の空白を除く
 * - http・https・mailto・tel(大文字小文字を区別しない)→ `external`(url はその値)
 * - それ以外でスキームつき(`javascript:`・`data:`・`vbscript:`・`blob:` …)→ `none`。ただし `file:` はローカルのファイル
 * - `new URL(href, docUri)` で解決し `#…` を除く。結果が `file:` / `ssh:` で今の文書と違えば `open`(uri はその結果)。
 *   同じなら `none`。解決できなければ `none`。空の href → `none`
 *
 * ## 判定しないもの
 * - srcdoc の差し込み(AC-88-1〜4)= html-viewer.links.acceptance.test.ts・Rust の判定(AC-88-5)= acceptance_req88.rs・
 *   配線(AC-88-7)= html-link.page-wiring.acceptance.test.ts・実機(AC-88-8)
 *
 * ## 判断の記録(test-writer・2026-11-26)
 * - `external` の `url` は、文字参照を解いて前後の空白を除いた**そのままの綴り**(`HTTPS://Example.com/x` はそのまま)。
 *   Markdown のリンク(Viewer.svelte の `openUrl(href)`)が href を原文のまま渡しているのに合わせた。正規化(小文字化・
 *   `new URL().href`)は求めない
 * - 「形が違う」には、パスにトークン以外の区切りがある(`vellis-asset://link/<token>/extra?href=…`)・`href` パラメータが
 *   無い・host が `link` でない、を含めた
 * - `#…` だけの href が(srcdoc では about:srcdoc になるので普通は届かないが)届いたら、解決先が今の文書自身になるので
 *   `none`(契約 4 の「今の文書自身のときは何もしない」と同じ規則で片づく)
 * - トークンの長さの下限は 22 文字(64 種の文字で 128 bit を表す最短)。文字の種類が少ない作り(16 進など)なら
 *   もっと長くなるだけで、下限を破らない
 *
 * ## 実装前の見立て(赤の理由)
 * `./html-link` が無いので import で全件赤(コンパイルできない)。
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HTML_LINK_CLICKED_EVENT, createLinkToken, decideHtmlLink, type HtmlLinkAction } from './html-link';

const REPO_ROOT = resolve(__dirname, '../..');

const TOKEN = 'tok_ABC-123_xyz';
const DOC = 'file:///a/b/doc.html';
const SSH_DOC = 'ssh://alice@host.example:22/srv/docs/index.html';

/** srcdoc が作るのと同じ形の専用の URL(`buildSrcdoc` の契約= encodeURIComponent の原文)。 */
function clicked(raw: string, token: string = TOKEN): string {
	return `vellis-asset://link/${token}?href=${encodeURIComponent(raw)}`;
}

function decide(raw: string, docUri: string = DOC, token: string = TOKEN): HtmlLinkAction {
	return decideHtmlLink({ url: clicked(raw, token), token: TOKEN, docUri });
}

const NONE: HtmlLinkAction = { kind: 'none' };

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// イベント名
// ---------------------------------------------------------------------------

describe('HTML_LINK_CLICKED_EVENT — Rust(navigation.rs)と同じリテラル', () => {
	test("値は 'html_link_clicked'", () => {
		expect(HTML_LINK_CLICKED_EVENT).toBe('html_link_clicked');
	});

	test('src-tauri/src/window/navigation.rs の pub const HTML_LINK_CLICKED_EVENT と同じ', () => {
		const rust = readFileSync(resolve(REPO_ROOT, 'src-tauri/src/window/navigation.rs'), 'utf8');
		const m = rust.match(/pub\s+const\s+HTML_LINK_CLICKED_EVENT\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"]+)"/);
		expect(m, 'navigation.rs に pub const HTML_LINK_CLICKED_EVENT: &str = "…" があること').not.toBeNull();
		expect(m![1]).toBe(HTML_LINK_CLICKED_EVENT);
	});
});

// ---------------------------------------------------------------------------
// トークン
// ---------------------------------------------------------------------------

describe('createLinkToken — 窓ごとのトークン(URL のパスに置ける乱数)', () => {
	test('[A-Za-z0-9_-]+ だけで、128 bit を表せる長さ(22 文字以上)', () => {
		for (let i = 0; i < 20; i += 1) {
			const token = createLinkToken();
			expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(token.length).toBeGreaterThanOrEqual(22);
		}
	});

	test('呼ぶたびに違う(200 回で重複なし)', () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i += 1) seen.add(createLinkToken());
		expect(seen.size).toBe(200);
	});

	test('crypto.getRandomValues を 16 byte(128 bit)以上で使う(Math.random や randomUUID の 122 bit ではない)', () => {
		const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
		createLinkToken();
		expect(spy).toHaveBeenCalled();
		const bytes = spy.mock.calls.reduce((sum, [arr]) => sum + ((arr as ArrayBufferView | null)?.byteLength ?? 0), 0);
		expect(bytes).toBeGreaterThanOrEqual(16);
	});

	test('専用の URL のパスにそのまま置いて、URL として読み戻せる', () => {
		const token = createLinkToken();
		const u = new URL(`vellis-asset://link/${token}?href=x`);
		expect(u.pathname).toBe(`/${token}`);
	});
});

// ---------------------------------------------------------------------------
// AC-88-6 — することを決める純関数
// ---------------------------------------------------------------------------

describe('AC-88-6 decideHtmlLink: トークンが違う・形が違う → 何もしない', () => {
	test('トークンが違う → none(外部でもローカルでも)', () => {
		expect(decideHtmlLink({ url: clicked('https://example.com/', 'other-token'), token: TOKEN, docUri: DOC })).toEqual(NONE);
		expect(decideHtmlLink({ url: clicked('other.html', 'other-token'), token: TOKEN, docUri: DOC })).toEqual(NONE);
		expect(decideHtmlLink({ url: clicked('other.html', TOKEN.toLowerCase()), token: TOKEN, docUri: DOC })).toEqual(NONE);
		expect(decideHtmlLink({ url: clicked('other.html', `${TOKEN}x`), token: TOKEN, docUri: DOC })).toEqual(NONE);
	});

	test('専用の URL の形でない → none(アプリの URL・外のページ・ごみ・空)', () => {
		for (const url of [
			'vellis-asset://local/a/b/other.html',
			'vellis-asset://ssh/alice@host/x.html',
			`vellis-asset://local/link/${TOKEN}?href=other.html`,
			`vellis-asset://links/${TOKEN}?href=other.html`,
			`vellis-asset://link/${TOKEN}/extra?href=other.html`,
			`vellis-asset://link/${TOKEN}`,
			`vellis-asset://link/${TOKEN}?other=1`,
			`vellis-asset://link/?href=other.html`,
			`https://example.com/link/${TOKEN}?href=other.html`,
			`about:srcdoc#top`,
			`file:///a/b/other.html`,
			'not a url',
			'',
		]) {
			expect(decideHtmlLink({ url, token: TOKEN, docUri: DOC }), url).toEqual(NONE);
		}
	});

	test('ポートつき・利用者名つきの専用の URL(host が `link` そのものでない)→ none(照合の P3-6)', () => {
		for (const url of [
			`vellis-asset://link:80/${TOKEN}?href=other.html`,
			`vellis-asset://u@link/${TOKEN}?href=other.html`,
			`vellis-asset://u:p@link/${TOKEN}?href=https%3A%2F%2Fexample.com%2F`,
		]) {
			expect(decideHtmlLink({ url, token: TOKEN, docUri: DOC }), url).toEqual(NONE);
		}
	});

	test('空の href(空文字・空白だけ)→ none', () => {
		expect(decide('')).toEqual(NONE);
		expect(decide('   ')).toEqual(NONE);
	});

	test('Rust が読み戻した URL(url クレートの再直列化= WHATWG の形)でも同じ答え', () => {
		const normalized = new URL(clicked("a b's.html")).href;
		expect(decideHtmlLink({ url: normalized, token: TOKEN, docUri: DOC })).toEqual({
			kind: 'open',
			uri: "file:///a/b/a%20b's.html",
		});
	});
});

describe('AC-88-6 decideHtmlLink: http・https・mailto・tel → 外部(確かめずに OS へ)', () => {
	test('http / https / mailto / tel は external で、url は解いた値そのまま', () => {
		for (const raw of [
			'https://external.example/page',
			'http://example.com/index.html?q=1#frag',
			'mailto:someone@example.com',
			'tel:+81-3-0000-0000',
		]) {
			expect(decide(raw), raw).toEqual({ kind: 'external', url: raw });
		}
	});

	test('スキームの判定は大文字小文字を区別しない(HTTPS: / MailTo:)', () => {
		expect(decide('HTTPS://Example.com/x')).toEqual({ kind: 'external', url: 'HTTPS://Example.com/x' });
		expect(decide('MailTo:a@example.com')).toEqual({ kind: 'external', url: 'MailTo:a@example.com' });
	});

	test('ssh の文書からでも外部は外部', () => {
		expect(decide('https://external.example/', SSH_DOC)).toEqual({ kind: 'external', url: 'https://external.example/' });
	});
});

describe('AC-88-6 decideHtmlLink: 相対・絶対パス・file: → 解決した URI のファイルを開く', () => {
	test('相対パス(./ ../ を含む)は文書の URI から解決した file: の URI', () => {
		expect(decide('other/page2.html')).toEqual({ kind: 'open', uri: 'file:///a/b/other/page2.html' });
		expect(decide('./sibling.md')).toEqual({ kind: 'open', uri: 'file:///a/b/sibling.md' });
		expect(decide('../up.pdf')).toEqual({ kind: 'open', uri: 'file:///a/up.pdf' });
		expect(decide('images/photo.png')).toEqual({ kind: 'open', uri: 'file:///a/b/images/photo.png' });
	});

	test('絶対パスは file: の root から', () => {
		expect(decide('/srv/docs/x.pdf')).toEqual({ kind: 'open', uri: 'file:///srv/docs/x.pdf' });
	});

	test('file: の URL はそのまま(ローカルのファイルとして扱う。ssh の文書からでも file:)', () => {
		expect(decide('file:///tmp/z.md')).toEqual({ kind: 'open', uri: 'file:///tmp/z.md' });
		expect(decide('file:///tmp/z.md', SSH_DOC)).toEqual({ kind: 'open', uri: 'file:///tmp/z.md' });
	});

	test('空白のあるパスは URL の形(パーセント符号化)で、既に符号化されたものはそのまま', () => {
		expect(decide('My Docs/x.md')).toEqual({ kind: 'open', uri: 'file:///a/b/My%20Docs/x.md' });
		expect(decide('My%20Docs/x.md')).toEqual({ kind: 'open', uri: 'file:///a/b/My%20Docs/x.md' });
	});

	test('ssh の文書からの相対パス・絶対パスは ssh の URI(利用者名・host・port を保つ)', () => {
		expect(decide('../img/x.png', SSH_DOC)).toEqual({ kind: 'open', uri: 'ssh://alice@host.example:22/srv/img/x.png' });
		expect(decide('other.md', SSH_DOC)).toEqual({ kind: 'open', uri: 'ssh://alice@host.example:22/srv/docs/other.md' });
		expect(decide('/etc/x.md', SSH_DOC)).toEqual({ kind: 'open', uri: 'ssh://alice@host.example:22/etc/x.md' });
		expect(decide('other.md', 'ssh://host.example/srv/docs/index.html')).toEqual({
			kind: 'open',
			uri: 'ssh://host.example/srv/docs/other.md',
		});
	});

	test('開けるのは Vellis が表示できるもの全部= 種類で絞らない(md / html / pdf / png / txt / rs / 拡張子なし)', () => {
		for (const name of ['a.md', 'b.html', 'c.pdf', 'd.png', 'e.txt', 'f.rs', 'Makefile', 'g.mp4']) {
			expect(decide(name), name).toEqual({ kind: 'open', uri: `file:///a/b/${name}` });
		}
	});
});

describe('AC-88-6 decideHtmlLink: javascript: / data: ほかのスキーム → 何もしない', () => {
	test('javascript: data: vbscript: blob: ftp: about: vellis-asset: は none', () => {
		for (const raw of [
			'javascript:alert(1)',
			'JavaScript:alert(1)',
			'data:text/html,%3Ch1%3Ehi%3C/h1%3E',
			'vbscript:msgbox(1)',
			'blob:tauri://localhost/abc',
			'ftp://example.com/x',
			'about:blank',
			'vellis-asset://local/a/b/other.html',
			'tauri://localhost/index.html',
		]) {
			expect(decide(raw), raw).toEqual(NONE);
		}
	});
});

describe('AC-88-6 decideHtmlLink: 文字参照を解く(HTML の属性値と同じ規則)', () => {
	test('&amp; → & (外部の URL のクエリ)', () => {
		expect(decide('https://e.example/?a=1&amp;b=2')).toEqual({ kind: 'external', url: 'https://e.example/?a=1&b=2' });
	});

	test('&#47; と &#x2F; → /(ローカルのパス)・&quot; → "', () => {
		expect(decide('other&#47;page.html')).toEqual({ kind: 'open', uri: 'file:///a/b/other/page.html' });
		expect(decide('other&#x2F;page.html')).toEqual({ kind: 'open', uri: 'file:///a/b/other/page.html' });
		expect(decide('https://e.example/?t=&quot;x&quot;')).toEqual({ kind: 'external', url: 'https://e.example/?t="x"' });
	});

	test('文字参照で書かれたスキームも解いてから判定する(&#106;avascript: は none・http&#58; は外部)', () => {
		expect(decide('&#106;avascript:alert(1)')).toEqual(NONE);
		expect(decide('https&#58;//e.example/')).toEqual({ kind: 'external', url: 'https://e.example/' });
	});

	test('前後の空白(空白・タブ・改行)を除いてから判定する', () => {
		expect(decide('  https://e.example/  ')).toEqual({ kind: 'external', url: 'https://e.example/' });
		expect(decide('\n\tother.html \n')).toEqual({ kind: 'open', uri: 'file:///a/b/other.html' });
	});
});

describe('AC-88-6 decideHtmlLink: `#…` を除く・今の文書自身なら何もしない', () => {
	test('別のファイルの `#…` は除いて開く(開いた先でその位置へは跳ばない)', () => {
		expect(decide('other.html#sec')).toEqual({ kind: 'open', uri: 'file:///a/b/other.html' });
		expect(decide('../up.md#h2', DOC)).toEqual({ kind: 'open', uri: 'file:///a/up.md' });
		expect(decide('other.md#sec', SSH_DOC)).toEqual({ kind: 'open', uri: 'ssh://alice@host.example:22/srv/docs/other.md' });
	});

	test('解決した先が今の文書自身 → none(綴りの違い・`#…` つき・file: の絶対形)', () => {
		expect(decide('doc.html')).toEqual(NONE);
		expect(decide('./doc.html')).toEqual(NONE);
		expect(decide('../b/doc.html')).toEqual(NONE);
		expect(decide('doc.html#sec')).toEqual(NONE);
		expect(decide('file:///a/b/doc.html')).toEqual(NONE);
		expect(decide('file:///a/b/doc.html#sec')).toEqual(NONE);
		expect(decide('/a/b/doc.html')).toEqual(NONE);
		expect(decide('index.html#top', SSH_DOC)).toEqual(NONE);
	});

	test('クエリは `#…` と同じく除いて比べる: 今の文書自身にクエリが付いただけなら none・別のファイルならクエリを除いた URI を開く(照合の P3-3)', () => {
		expect(decide('doc.html?x=1')).toEqual(NONE);
		expect(decide('./doc.html?x=1#sec')).toEqual(NONE);
		expect(decide('file:///a/b/doc.html?x=1')).toEqual(NONE);
		expect(decide('other.html?x=1')).toEqual({ kind: 'open', uri: 'file:///a/b/other.html' });
		expect(decide('other.html?x=1#s')).toEqual({ kind: 'open', uri: 'file:///a/b/other.html' });
		expect(decide('other.md?x=1', SSH_DOC)).toEqual({ kind: 'open', uri: 'ssh://alice@host.example:22/srv/docs/other.md' });
	});

	test('`#…` だけの href が届いても今の文書自身なので none', () => {
		expect(decide('#top')).toEqual(NONE);
		expect(decide('#')).toEqual(NONE);
	});

	test('解決できない(今の文書の URI が URL でない)→ none(投げない)', () => {
		expect(decideHtmlLink({ url: clicked('other.html'), token: TOKEN, docUri: '' })).toEqual(NONE);
		expect(decideHtmlLink({ url: clicked('other.html'), token: TOKEN, docUri: 'not a uri' })).toEqual(NONE);
	});

	test('解決した先が file: / ssh: でない(文書の URI が別のスキーム)→ none', () => {
		expect(decideHtmlLink({ url: clicked('other.html'), token: TOKEN, docUri: 'https://example.com/a/doc.html' })).toEqual(
			NONE,
		);
	});
});
