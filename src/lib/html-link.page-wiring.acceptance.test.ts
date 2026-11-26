/**
 * 要件#88 の受け入れテスト(docs/requirements/req-88.md)— 配線(AC-88-7)
 * 「HTML の表示の中のリンクを使えるようにする(ローカルの別のファイルは Vellis で・外部の URL はブラウザで)」
 *
 * AC-88-7 が言っていること**だけ**を固定する(変数名・関数の分け方など、要件が言っていない作りの細部は固定しない):
 * - 画面の HTML の表示は `links` つきの srcdoc を使う(`+page.svelte` の `renderForDisplay(…)` の呼び出しに 5 つ目の
 *   引数がある・トークンは `createLinkToken()` で作る)
 * - 印刷の文書は `links` なしの `buildSrcdoc` を使う(`print-html.ts` の呼び出しは 2 引数のまま・`buildPrintDocument` の
 *   出力に専用の URL も `target="_self"` も無く、CSP の `<meta>` を除くと `buildSrcdoc(content, docUri)` と byte で同じ)
 * - `html_link_clicked` を受けて(`$lib/events` の `listen`= 今の窓だけの購読・契約 12)、`decideHtmlLink` で決め、外部は
 *   `openUrl`(`@tauri-apps/plugin-opener`)、ローカルは Explorer のファイルの行のクリックと同じ経路
 *   (`openForDisplay` → 文書の差し替え・失敗は `alert(openFileFailedMessage(err))`= 要件#71 契約2)
 * - `sandbox` の値(空)と `tauri.conf.json` の CSP の文字列が今と同じ
 *
 * 配線の置き場は `+page.svelte` と `src/lib/html-link.ts` のどちらでもよい(両方の和集合を読む)。Explorer のクリックの
 * 経路の名前は `src/components/Explorer.svelte` の `handleFileClick` を読んで確かめた(2026-11-26):
 * `confirmDiscardEdits()` → `windowState.setDocument(await openForDisplay(entry.uri))`・失敗は `alert(openFileFailedMessage(err))`。
 *
 * ## 判定しないもの
 * - HTML を表示していないときに届いた通知を捨てること・`confirmDiscardEdits` を通すこと(HTML の表示に編集の面は無いので
 *   今は素通し)・payload の形(`{ url }`)の読み方 → reviewer の照合と実機(AC-88-8)
 *
 * ## 判断の記録(test-writer・2026-11-26)
 * - 配線のテストはソースの文字列の走査(`navigation-net.acceptance.test.ts` と同じ家風)。`+page.svelte` は runes の
 *   部品で、`listen` の購読を単体で起こせないため
 * - 「同じ経路」は `openForDisplay` と `openFileFailedMessage` と `alert(` の 3 つの名前の存在で読む(Explorer と同じ関数を
 *   通ること)。`windowState.setDocument(` は +page.svelte に既にあるので判定に使わない
 *
 * ## 実装前の見立て(赤の理由)
 * - `src/lib/html-link.ts` が無く、`+page.svelte` の `renderForDisplay(` は 4 引数・`HTML_LINK_CLICKED_EVENT` / `decideHtmlLink` /
 *   `createLinkToken` / `openUrl` / `openFileFailedMessage` のどれも +page.svelte に無い → 配線の 5 件が赤
 * - 印刷・sandbox・CSP の不変は最初から緑(守り)
 *
 * @vitest-environment jsdom
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));

import { SANDBOX_ATTRIBUTE, buildSrcdoc } from './html-viewer';
import { PRINT_CSP_META, buildPrintDocument } from './print-html';

const REPO_ROOT = resolve(__dirname, '../..');

function read(rel: string): string {
	return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

function readOptional(rel: string): string {
	return existsSync(resolve(REPO_ROOT, rel)) ? read(rel) : '';
}

/** コメント(`//`・`/* *\/`・`<!-- -->`)を落とす(文字列の中の `//` は `://` だけ残す素朴な落とし方)。 */
function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * `name(` の呼び出し(定義 `function name(` と import は除く)の引数の文字列を全部返す。括弧の対応は
 * 文字列リテラル(' " `)を飛ばして数える。
 */
function callArgs(code: string, name: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`(?<![\\w$.])${name}\\s*(?:<[^()]*?>)?\\(`, 'g');
	for (const m of code.matchAll(re)) {
		const idx = m.index ?? 0;
		const before = code.slice(Math.max(0, idx - 40), idx);
		if (/function\s+$/.test(before) || /\bimport\b[^;]*$/.test(before)) continue;
		const open = idx + m[0].length - 1;
		let depth = 0;
		let quote: string | null = null;
		for (let i = open; i < code.length; i += 1) {
			const c = code[i];
			if (quote !== null) {
				if (c === '\\') i += 1;
				else if (c === quote) quote = null;
				continue;
			}
			if (c === "'" || c === '"' || c === '`') quote = c;
			else if (c === '(' || c === '[' || c === '{') depth += 1;
			else if (c === ')' || c === ']' || c === '}') {
				depth -= 1;
				if (depth === 0) {
					out.push(code.slice(open + 1, i));
					break;
				}
			}
		}
	}
	return out;
}

/** 引数の文字列を最上位のコンマで分ける(入れ子の括弧・文字列の中のコンマは分けない)。 */
function splitArgs(args: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < args.length; i += 1) {
		const c = args[i];
		if (quote !== null) {
			if (c === '\\') i += 1;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') quote = c;
		else if (c === '(' || c === '[' || c === '{') depth += 1;
		else if (c === ')' || c === ']' || c === '}') depth -= 1;
		else if (c === ',' && depth === 0) {
			parts.push(args.slice(start, i).trim());
			start = i + 1;
		}
	}
	const last = args.slice(start).trim();
	if (last !== '') parts.push(last);
	return parts;
}

/** `import { … } from '<module>'` の `{ … }` の中の名前(複数行の import も読む)。 */
function importedNames(code: string, module: string): string[] {
	const re = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]${module.replace(/[$.]/g, '\\$&')}['"]`, 'g');
	return [...code.matchAll(re)].flatMap((m) =>
		m[1]
			.split(',')
			.map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop() ?? '')
			.filter((s) => s !== ''),
	);
}

const PAGE = 'src/routes/+page.svelte';
const LINK_MODULE = 'src/lib/html-link.ts';
const WIRING_FILES = [PAGE, LINK_MODULE];

/** 配線を置いてよい 2 ファイルの、コメントを落としたコード。無いファイルは空。 */
function wiringSources(): Array<{ rel: string; code: string }> {
	return WIRING_FILES.map((rel) => ({ rel, code: stripComments(readOptional(rel)) }));
}

function unionCode(): string {
	return wiringSources()
		.map((s) => s.code)
		.join('\n');
}

// ---------------------------------------------------------------------------
// 画面の HTML の表示は links つきの srcdoc
// ---------------------------------------------------------------------------

describe('AC-88-7 画面の HTML の表示は links つきの srcdoc を使う', () => {
	test('+page.svelte の renderForDisplay(…) の呼び出しは 5 つの引数(5 つ目= links)を渡す', () => {
		const calls = callArgs(stripComments(read(PAGE)), 'renderForDisplay');
		expect(calls.length, '+page.svelte に renderForDisplay(…) の呼び出しがあること').toBeGreaterThanOrEqual(1);
		for (const args of calls) {
			const parts = splitArgs(args);
			expect(parts, `renderForDisplay(${args})`).toHaveLength(5);
			expect(parts[4], '5 つ目の引数は links(undefined 固定ではない)').not.toBe('undefined');
		}
	});

	test('トークンは createLinkToken() で作る(定義の外で呼ばれている)', () => {
		const code = unionCode();
		const calls = callArgs(code, 'createLinkToken');
		expect(calls.length, 'createLinkToken() が呼ばれていること').toBeGreaterThanOrEqual(1);
		expect(importedNames(stripComments(read(PAGE)), '$lib/html-link').length, '+page.svelte が $lib/html-link を import していること').toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// 印刷の文書は links なし
// ---------------------------------------------------------------------------

describe('AC-88-7 印刷の文書は links なしの buildSrcdoc を使う(印刷の結果は変えない=契約 13)', () => {
	test('print-html.ts の buildSrcdoc(…) の呼び出しは 2 引数のまま', () => {
		const calls = callArgs(stripComments(read('src/lib/print-html.ts')), 'buildSrcdoc');
		expect(calls.length).toBeGreaterThanOrEqual(1);
		for (const args of calls) {
			expect(splitArgs(args), `buildSrcdoc(${args})`).toHaveLength(2);
		}
	});

	test('buildPrintDocument の出力に専用の URL も target="_self" も無く、CSP の <meta> を除くと buildSrcdoc(content, docUri) と byte で同じ', () => {
		const doc = [
			'<!doctype html><html><head><title>t</title></head><body>',
			'<p><a href="https://external.example/page" target="_blank">外部</a> <a href="other.html">別</a> <a href="#top">上</a></p>',
			'<svg><a xlink:href="https://external.example/svg"><text>s</text></a></svg>',
			'</body></html>',
		].join('\n');
		for (const uri of ['file:///a/b/doc.html', 'ssh://alice@host.example:22/srv/docs/doc.html']) {
			const printed = buildPrintDocument(doc, uri);
			expect(printed).not.toContain('vellis-asset://link/');
			expect(printed).not.toContain('target="_self"');
			expect(printed).not.toContain('about:srcdoc');
			expect(printed).not.toContain('data-vellis-target');
			expect(printed.replace(PRINT_CSP_META, '')).toBe(buildSrcdoc(doc, uri));
		}
	});
});

// ---------------------------------------------------------------------------
// クリックを受けて開く
// ---------------------------------------------------------------------------

describe('AC-88-7 html_link_clicked を受けて、外部は openUrl・ローカルは Explorer のクリックと同じ経路・失敗は alert', () => {
	test('HTML_LINK_CLICKED_EVENT を $lib/events の listen(今の窓だけの購読)で購読する', () => {
		const hits = wiringSources().filter(({ code }) => /(?<![\w$.])listen\s*(?:<[^()]*?>)?\(\s*HTML_LINK_CLICKED_EVENT\b/.test(code));
		expect(
			hits.map((h) => h.rel),
			'listen(HTML_LINK_CLICKED_EVENT, …) が +page.svelte か html-link.ts にあること',
		).not.toEqual([]);
		for (const { rel, code } of hits) {
			expect(importedNames(code, '$lib/events'), `${rel} は listen を $lib/events から import する`).toContain('listen');
		}
	});

	test('届いた URL は decideHtmlLink で決める(定義の外で呼ばれている)', () => {
		expect(callArgs(unionCode(), 'decideHtmlLink').length).toBeGreaterThanOrEqual(1);
		expect(importedNames(stripComments(read(PAGE)), '$lib/html-link')).toContain('HTML_LINK_CLICKED_EVENT');
	});

	test('外部は openUrl(@tauri-apps/plugin-opener)で OS に渡す', () => {
		const sources = wiringSources();
		expect(sources.some(({ code }) => /\bopenUrl\b/.test(code)), 'openUrl が配線にあること').toBe(true);
		const importing = sources.filter(({ code }) => importedNames(code, '@tauri-apps/plugin-opener').includes('openUrl'));
		expect(importing.map((s) => s.rel), 'openUrl を @tauri-apps/plugin-opener から import していること').not.toEqual([]);
	});

	test('ローカルは Explorer のファイルの行のクリックと同じ経路(openForDisplay)・失敗は alert(openFileFailedMessage(err))', () => {
		const sources = wiringSources();
		const code = unionCode();
		expect(/\bopenForDisplay\b/.test(code), 'openForDisplay が配線にあること').toBe(true);
		expect(/\bopenFileFailedMessage\b/.test(code), 'openFileFailedMessage が配線にあること').toBe(true);
		expect(/\balert\s*\(/.test(code), 'alert( が配線にあること').toBe(true);
		const importing = sources.filter(({ code }) => {
			const names = importedNames(code, '$lib/open-document');
			return names.includes('openForDisplay') && names.includes('openFileFailedMessage');
		});
		expect(
			importing.map((s) => s.rel),
			'openForDisplay と openFileFailedMessage を $lib/open-document から import していること(Explorer.svelte と同じ 2 つ)',
		).not.toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 安全の不変
// ---------------------------------------------------------------------------

describe('AC-88-7 sandbox の値と CSP の文字列は今と同じ(契約 9)', () => {
	test('SANDBOX_ATTRIBUTE は空のまま・HtmlViewer.svelte の <iframe> はそれを sandbox に使い、allow-* の字が無い', () => {
		expect(SANDBOX_ATTRIBUTE).toBe('');
		const src = stripComments(read('src/components/HtmlViewer.svelte'));
		expect(src).toMatch(/<iframe\b[^>]*\bsandbox=\{SANDBOX_ATTRIBUTE\}[^>]*\{srcdoc\}/);
		expect(src).not.toMatch(/allow-(scripts|same-origin|popups|top-navigation)/);
	});

	test('tauri.conf.json の app.security.csp は 2026-11-26 時点の文字列と同じ', () => {
		const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { app: { security: { csp: string } } };
		expect(conf.app.security.csp).toBe(
			"default-src 'self' tauri: customprotocol: asset:; script-src 'self' 'wasm-unsafe-eval'; " +
				"style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: vellis-asset: asset: http://asset.localhost tauri: customprotocol:; " +
				"font-src 'self' data:; media-src 'self' vellis-asset: asset: http://asset.localhost; frame-src 'self' vellis-asset:; " +
				"connect-src 'self' ipc: http://ipc.localhost vellis-asset: asset: http://asset.localhost tauri: customprotocol:; " +
				"object-src 'none'; base-uri 'self' vellis-asset:; frame-ancestors 'none'",
		);
	});
});
