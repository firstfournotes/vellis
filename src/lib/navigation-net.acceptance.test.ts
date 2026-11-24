/**
 * 要件#74 第3段 3-5 の続き(ドロップの周回の差し戻しの直し)— on_navigation の網を張っても、外のリンクと iframe が壊れない
 * (docs/requirements/req-74.md 状態節 8d071ec の事後確認 (26)。網と判定の関数の契約は
 *  `src-tauri/tests/acceptance_req74_navigation.rs`・`acceptance_req74_navigation_url.rs` の冒頭)
 *
 * 網(`is_app_url`)はアプリ自身の URL のほかへの移動を断る。wry の on_navigation は main frame だけでなく iframe の移動にも
 * 呼ばれる(wry-0.54.4 `src/wkwebview/navigation.rs:50-82` は targetFrame を見ない)。今の作りを読んで、網で壊れないことを
 * 事実として固定する(守りのテスト)。
 *
 * ## 読んだ結果(2026-11-20)
 * - 外のリンクは navigation を使わない: Viewer.svelte の handleClick と MarkdownEditor.svelte の handleClickEvent / navigate は、
 *   `isExternal(href)` のとき既定の動作を止めて `@tauri-apps/plugin-opener` の `openUrl(href)`(IPC で OS の既定のアプリが
 *   開く)。UpdateBanner の Download も `openUrl`。`location.href =`・`location.assign`・`window.open` などの主の窓を移す
 *   API は src に無い(SvelteKit は SPA で、画面の切り替えは history API=WKWebView の navigation の判定に出ても同じ origin)
 * - iframe に載せるもの: HtmlViewer は `<iframe srcdoc>`(移動の URL は `about:srcdoc`)を `sandbox=""` で載せる(主の窓を
 *   動かす allow-top-navigation が無い。リンクの href は buildSrcdoc が data-vellis-href に移す=要件#8)。PdfViewer は
 *   `toAssetUri` の `vellis-asset://local/…` / `vellis-asset://ssh/…` を `<iframe src>` に載せる。どれも網が認める集合に入る
 *   (Rust の unit `the_frames_the_app_loads_are_allowed` と同じ形)
 *
 * ## 赤になる理由
 * どれも今の作りの事実なので最初から緑(守り)。網の直しで外のリンクの開き方や iframe の URL を変えると赤になる。
 *
 * @vitest-environment jsdom
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SANDBOX_ATTRIBUTE } from '$lib/html-viewer';
import { toAssetUri } from '$lib/uri';

const REPO_ROOT = resolve(__dirname, '../..');
const SRC = resolve(REPO_ROOT, 'src');

function read(rel: string): string {
	return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/** src の .ts / .svelte(テストと fixture を除く)。 */
function productSources(): Array<{ rel: string; text: string }> {
	const out: Array<{ rel: string; text: string }> = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) {
				if (name === '__fixtures__' || name === 'node_modules') continue;
				walk(path);
			} else if (/\.(ts|svelte)$/.test(name) && !/\.(test|spec)\.ts$/.test(name)) {
				out.push({ rel: relative(REPO_ROOT, path), text: readFileSync(path, 'utf8') });
			}
		}
	};
	walk(SRC);
	return out;
}

/** コメント(`//`・`/* *\/`・`<!-- -->`)を落とす(文字列の中の `//` は `://` だけ残す素朴な落とし方)。 */
function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** `function <name>(` の本体(最初の `{` から対応する `}` まで)。 */
function functionBody(source: string, name: string): string {
	const head = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
	expect(head, `function ${name}( があること`).toBeGreaterThanOrEqual(0);
	const open = source.indexOf('{', head);
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		if (source[i] === '{') depth += 1;
		else if (source[i] === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(open, i + 1);
		}
	}
	throw new Error(`function ${name} の本体が閉じていない`);
}

/** `if (isExternal(href)) { … }` の中身。 */
function externalBranch(body: string): string {
	const at = body.search(/if\s*\(\s*isExternal\(\s*href\s*\)\s*\)\s*\{/);
	expect(at, 'if (isExternal(href)) { の枝があること').toBeGreaterThanOrEqual(0);
	return functionBody(`function branch() ${body.slice(body.indexOf('{', at))}`, 'branch');
}

const OPENER_IMPORT = /import\s*\{[^}]*\bopenUrl\b[^}]*\}\s*from\s*['"]@tauri-apps\/plugin-opener['"]/;

describe('網を張っても外のリンクは壊れない — 外のリンクは navigation でなく openUrl で OS が開く', () => {
	test('src(テスト以外)の .ts / .svelte は、主の窓を移す API(location.href = / location.assign / location.replace / window.location = / document.location / window.open)を使わない', () => {
		const PATTERNS: Array<[label: string, re: RegExp]> = [
			['location.href =', /\blocation\.href\s*=(?!=)/],
			['location.assign(', /\blocation\.assign\s*\(/],
			['location.replace(', /\blocation\.replace\s*\(/],
			['window.location =', /\bwindow\.location\s*=(?!=)/],
			['document.location', /\bdocument\.location\b/],
			['window.open(', /\bwindow\.open\s*\(/],
		];
		const sources = productSources();
		expect(sources.length, '前提: src のソースを読めている').toBeGreaterThan(50);
		const offenders: string[] = [];
		for (const { rel, text } of sources) {
			const code = stripComments(text);
			for (const [label, re] of PATTERNS) if (re.test(code)) offenders.push(`${rel}: ${label}`);
		}
		expect(offenders, '主の窓を移す API は網に断られる(アプリの外へ出るなら openUrl で OS に渡す)').toEqual([]);
	});

	test('Viewer.svelte の handleClick: 外のリンクは既定の動作を止めて openUrl(href)(@tauri-apps/plugin-opener)', () => {
		const src = stripComments(read('src/components/Viewer.svelte'));
		expect(src).toMatch(OPENER_IMPORT);
		const branch = externalBranch(functionBody(src, 'handleClick'));
		expect(branch).toMatch(/\be\.preventDefault\(\)/);
		expect(branch).toMatch(/\bopenUrl\(\s*href\s*\)/);
		expect(branch.indexOf('preventDefault'), '既定の動作を先に止める').toBeLessThan(branch.indexOf('openUrl'));
	});

	test('MarkdownEditor.svelte: リンクのクリックは既定の動作を止めて navigate へ、navigate は外のリンクを openUrl(href)(@tauri-apps/plugin-opener)', () => {
		const src = stripComments(read('src/components/MarkdownEditor.svelte'));
		expect(src).toMatch(OPENER_IMPORT);
		const click = functionBody(src, 'handleClickEvent');
		expect(click).toMatch(/\bevent\.preventDefault\(\)/);
		expect(click).toMatch(/\bnavigate\(\s*href/);
		expect(click.indexOf('preventDefault'), '既定の動作を先に止める').toBeLessThan(click.search(/\bnavigate\(/));
		const branch = externalBranch(functionBody(src, 'navigate'));
		expect(branch).toMatch(/\bopenUrl\(\s*href\s*\)/);
	});

	test('UpdateBanner.svelte の Download は openUrl(リンクでなくボタン=navigation を使わない)', () => {
		const src = stripComments(read('src/components/UpdateBanner.svelte'));
		expect(src).toMatch(OPENER_IMPORT);
		expect(functionBody(src, 'download')).toMatch(/\bopenUrl\(/);
	});
});

describe('網を張っても iframe は壊れない — iframe に載せる URL は網が認める形', () => {
	test('HtmlViewer は <iframe srcdoc>(移動の URL は about:srcdoc)を sandbox=""(allow-top-navigation なし=主の窓を動かせない)で載せる', () => {
		const src = stripComments(read('src/components/HtmlViewer.svelte'));
		expect(src).toMatch(/<iframe\b[^>]*\bsandbox=\{SANDBOX_ATTRIBUTE\}[^>]*\{srcdoc\}/);
		expect(src).not.toMatch(/<iframe\b[^>]*\bsrc=/);
		expect(SANDBOX_ATTRIBUTE, 'sandbox の許可は空(allow-top-navigation・allow-popups・allow-scripts なし)').toBe('');
	});

	test('PdfViewer の <iframe src> は toAssetUri の vellis-asset://local/… / vellis-asset://ssh/…(Rust の網の unit と同じ形)', () => {
		const src = stripComments(read('src/components/PdfViewer.svelte'));
		expect(src).toMatch(/<iframe\b[^>]*\{src\}/);
		expect(toAssetUri('file:///Users/a/Documents/report.pdf')).toBe('vellis-asset://local/Users/a/Documents/report.pdf');
		expect(toAssetUri('ssh://alice@host.example:22/srv/docs/report.pdf')).toBe(
			'vellis-asset://ssh/alice@host.example:22/srv/docs/report.pdf',
		);
		expect(toAssetUri('ssh://host.example/srv/docs/report.pdf')).toBe('vellis-asset://ssh/host.example/srv/docs/report.pdf');
	});

	test('src のソースが載せる <iframe> は HtmlViewer と PdfViewer の 2 つだけ(増えたら網の認める集合を見直す)', () => {
		const withIframe = productSources()
			.filter(({ text }) => /<iframe\b/.test(stripComments(text)))
			.map(({ rel }) => rel)
			.sort();
		expect(withIframe).toEqual(['src/components/HtmlViewer.svelte', 'src/components/PdfViewer.svelte']);
	});
});
