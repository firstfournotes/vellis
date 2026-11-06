/**
 * 要件#56 の受け入れテスト(docs/requirements/req-56.md)— 不変の固定(AC-56-11〜17)
 *
 * 「UI の作り直し(見た目の刷新)」は機能・操作・文言・掴み手・iframe・印刷・`src/markdown/**`・依存を
 * 変えない(契約 5・6・7)。本ファイルはそれらを**再起案時点(2026-11-02・main `a95a27c`。本ブランチの
 * 土台 `a6e834f` でも同じ値)の実測値**で固定する。見た目の良し悪しは一切見ない(人間ゲート)。
 *
 * 判定するもの:
 * - AC-56-11 依存追加ゼロ= `package.json` の dependencies / devDependencies と `Cargo.toml` の
 *   `[dependencies]` に、再起案時点の集合に無い名前が増えていない(鍵の集合で判定。`serde_json` に
 *   `features = ["preserve_order"]` を足すこと・`scripts` に `theme:css` を足すことは依存の追加ではない)
 * - AC-56-12 掴み手の不変= `src/components/*.svelte` の `data-testid` の値の集合(52 箇所・52 種)と
 *   `aria-label` の値の集合(39 箇所・29 種)が減っていない
 * - AC-56-13 文言の不変= `menu.rs` の文字列リテラル(新しいメニュー項目のラベルを含む)に CJK が無い
 *   (要件#51 の値固定テスト 28 + 12 件が無改変で緑なことは reviewer 照合)
 * - AC-56-14 iframe まわりの不変= `HtmlViewer.svelte` と `html-viewer.ts` の SHA-256
 * - AC-56-15 `tauri.conf.json` の不変= `app.windows[0]` は 4 項目だけ(Overlay の鍵の**追加なし**=
 *   2026-11-02 のスパイクで Overlay は取り下げ)・窓は 1 つ・`app.security.csp` は不変・窓の生成 2 箇所に
 *   `title_bar_style(` が無い
 * - AC-56-16 `print.css` の不変= SHA-256 と `var(--` 参照 0 件
 * - AC-56-17 `src/markdown/**` の不変= `renderer.ts` 以外のファイル集合と SHA-256・`renderer.ts` の export
 *
 * 判定しないもの: AC-56-10(記号アイコンの撤去)は第2段で別のテストにする(本ファイルには無い)。
 *
 * 測り方(2026-11-02 実測・いずれもリポジトリ直下で):
 * - 依存= `node -e 'const p=require("./package.json");console.log(Object.keys(p.dependencies).sort(),Object.keys(p.devDependencies).sort())'`・
 *   `awk '/^\[dependencies\]/{s=1;next}/^\[/{s=0}s && /^[a-zA-Z0-9_-]+ *=/{sub(/ *=.*\/,"");print}' src-tauri/Cargo.toml`
 *   (31 名。要件の脚注 [^deps] は「26 行」と書くが、名前を数えると 31。`[target.'cfg(target_os = "macos")'.dependencies]` は別節なので数えない)
 * - 掴み手= `grep -o -E 'data-testid="[^"]+"' src/components/*.svelte | wc -l`(52)・`grep -o 'aria-label=' src/components/*.svelte | wc -l`(39)
 * - SHA= `shasum -a 256 <path>`(要件の脚注 [^sha] と一致)・`find src/markdown -type f | sort | xargs shasum -a 256`
 *
 * 本ファイルは「不変」を固定するので、実装前から緑である(意図どおり。赤になるのは本要件の実装が
 * 不変の範囲に手を入れたとき)。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');

function readText(rel: string): string {
	return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

function sha256(rel: string): string {
	return createHash('sha256').update(readFileSync(resolve(REPO_ROOT, rel))).digest('hex');
}

function listFilesRecursive(dirRel: string): string[] {
	const out: string[] = [];
	const walk = (abs: string) => {
		for (const name of readdirSync(abs)) {
			const p = join(abs, name);
			if (statSync(p).isDirectory()) walk(p);
			else out.push(relative(REPO_ROOT, p));
		}
	};
	walk(resolve(REPO_ROOT, dirRel));
	return out.sort();
}

function componentSources(): Array<{ name: string; text: string }> {
	const dir = resolve(REPO_ROOT, 'src/components');
	return readdirSync(dir)
		.filter((f) => f.endsWith('.svelte'))
		.sort()
		.map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));
}

/** 行コメント(`//`。`://` は除く)を落とす(acceptance_req63.rs の strip_line_comments と同じ)。 */
function stripRustLineComments(src: string): string {
	return src
		.split('\n')
		.map((line) => {
			for (let i = 0; i + 1 < line.length; i += 1) {
				if (line[i] === '/' && line[i + 1] === '/' && (i === 0 || line[i - 1] !== ':')) return line.slice(0, i);
			}
			return line;
		})
		.join('\n');
}

// ---------------------------------------------------------------------------
// AC-56-11 — 依存追加ゼロ
// ---------------------------------------------------------------------------

const PACKAGE_DEPENDENCIES = [
	'@shikijs/rehype',
	'@tauri-apps/api',
	'@tauri-apps/plugin-dialog',
	'@tauri-apps/plugin-opener',
	'hast-util-to-mdast',
	'mdast-util-to-markdown',
	'mdast-util-to-string',
	'mermaid',
	'rehype-parse',
	'rehype-raw',
	'rehype-sanitize',
	'rehype-stringify',
	'remark-gfm',
	'remark-parse',
	'remark-rehype',
	'three',
	'unified',
	'unist-util-visit',
] as const;

const PACKAGE_DEV_DEPENDENCIES = [
	'@sveltejs/adapter-static',
	'@sveltejs/kit',
	'@sveltejs/vite-plugin-svelte',
	'@tauri-apps/cli',
	'@testing-library/svelte',
	'@testing-library/user-event',
	'@types/hast',
	'@types/mdast',
	'@types/node',
	'@types/three',
	'@wdio/cli',
	'@wdio/globals',
	'@wdio/local-runner',
	'@wdio/mocha-framework',
	'@wdio/spec-reporter',
	'expect-webdriverio',
	'happy-dom',
	'jsdom',
	'shiki',
	'svelte',
	'svelte-check',
	'tsx',
	'typescript',
	'vite',
	'vitest',
	'webdriverio',
] as const;

const CARGO_DEPENDENCIES = [
	'async-trait',
	'bytes',
	'chrono',
	'clap',
	'dirs',
	'hidapi',
	'http',
	'libc',
	'mime_guess',
	'notify',
	'percent-encoding',
	'regex',
	'reqwest',
	'russh',
	'russh-sftp',
	'serde',
	'serde_json',
	'sha2',
	'similar',
	'strsim',
	'tauri',
	'tauri-plugin-dialog',
	'tauri-plugin-opener',
	'tauri-plugin-webdriver',
	'tauri-plugin-window-state',
	'thiserror',
	'tokio',
	'toml',
	'tracing',
	'tracing-subscriber',
	'ulid',
] as const;

/** `[dependencies]` 節(次の `[` で始まる行まで)の `name = …` の name。 */
function cargoDependencyNames(): string[] {
	const lines = readText('src-tauri/Cargo.toml').split('\n');
	const names: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (/^\[/.test(line)) {
			inSection = line.trim() === '[dependencies]';
			continue;
		}
		if (!inSection) continue;
		const m = line.match(/^([A-Za-z0-9_-]+)\s*=/);
		if (m) names.push(m[1]);
	}
	return names.sort();
}

function added(actual: readonly string[], expected: readonly string[]): string[] {
	const known = new Set(expected);
	return actual.filter((n) => !known.has(n));
}

describe('AC-56-11 依存追加ゼロ(契約 5・7): package.json と Cargo.toml に再起案時点に無い依存が増えていない', () => {
	test(`package.json の dependencies(${PACKAGE_DEPENDENCIES.length})に追加が無い`, () => {
		const pkg = JSON.parse(readText('package.json')) as { dependencies?: Record<string, string> };
		expect(added(Object.keys(pkg.dependencies ?? {}), PACKAGE_DEPENDENCIES), '増えた runtime 依存').toEqual([]);
	});

	test(`package.json の devDependencies(${PACKAGE_DEV_DEPENDENCIES.length})に追加が無い`, () => {
		const pkg = JSON.parse(readText('package.json')) as { devDependencies?: Record<string, string> };
		expect(added(Object.keys(pkg.devDependencies ?? {}), PACKAGE_DEV_DEPENDENCIES), '増えた dev 依存').toEqual([]);
	});

	test(`Cargo.toml の [dependencies](${CARGO_DEPENDENCIES.length})に追加が無い(serde_json の feature 追加は鍵の集合を変えない)`, () => {
		expect(added(cargoDependencyNames(), CARGO_DEPENDENCIES), '増えた crate').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-56-12 — 掴み手の不変
// ---------------------------------------------------------------------------

/** 再起案時点の `data-testid` の値(52 箇所・52 種=すべて一意)。 */
const DATA_TESTIDS = [
	'edit-done',
	'edit-source',
	'external-change-banner',
	'external-overwrite',
	'external-reload',
	'external-removed-banner',
	'external-removed-close',
	'external-removed-save',
	'find-bar',
	'find-close',
	'find-count',
	'find-in-folder',
	'find-in-folder-close',
	'find-in-folder-exclude',
	'find-in-folder-group',
	'find-in-folder-group-count',
	'find-in-folder-group-path',
	'find-in-folder-hit',
	'find-in-folder-hit-line',
	'find-in-folder-hit-text',
	'find-in-folder-include',
	'find-in-folder-input',
	'find-in-folder-match-case',
	'find-in-folder-results',
	'find-in-folder-show-more',
	'find-in-folder-status',
	'find-in-folder-toggle-details',
	'find-in-folder-use-exclude-settings',
	'find-in-folder-use-regex',
	'find-in-folder-whole-word',
	'find-input',
	'find-next',
	'find-prev',
	'go-to-bar',
	'go-to-close',
	'go-to-go',
	'go-to-input',
	'go-to-message',
	'html-edit-surface',
	'html-find-surface',
	'htmledit-structure-notice',
	'recent-files',
	'recent-files-clear',
	'recent-files-empty',
	'recent-files-header',
	'recent-files-list',
	'recent-files-marker',
	'recent-files-row',
	'recent-files-row-folder',
	'recent-files-row-name',
	'recent-files-sash',
	'recent-files-title',
] as const;
const DATA_TESTID_OCCURRENCES = 52;

/**
 * 再起案時点の `aria-label` の値(39 箇所・29 種)。ソースに書かれたままの属性値
 * (`{式}` の補間を含む文字列と、式そのもの `{RECENT_FILES_TITLE}`)で固定する。
 */
const ARIA_LABELS = [
	'"3D model view ({fileName}). Drag to rotate, right-drag to pan, scroll to zoom"',
	'"Audio player ({fileName}). Space to play/pause, ←/→ to seek {COARSE_STEP_SECONDS} s, Shift+←/→ to seek {FINE_STEP_SECONDS} s"',
	'"Audio waveform (click to seek)"',
	'"Close"',
	'"Dismiss"',
	'"Find in document"',
	'"Find in folder"',
	'"Find in Folder"',
	'"Go to Parent Folder"',
	'"Go to path"',
	'"Go"',
	'"Mark Filter"',
	'"Marks"',
	'"Match Case"',
	'"Match Whole Word"',
	'"Next"',
	'"Playback Position"',
	'"Prev"',
	'"Reset Waveform Zoom"',
	'"Resize Recent Files"',
	'"Resize Waveform"',
	'"Sources"',
	'"Toggle Search Details"',
	'"Use Exclude Settings"',
	'"Use Regular Expression"',
	'"Video player ({fileName}). Space to play/pause, ←/→ to step one frame, Shift+←/→ to step {LARGE_FRAME_STEP} frames"',
	'"Zoom In Waveform"',
	'"Zoom Out Waveform"',
	'{RECENT_FILES_TITLE}',
] as const;
const ARIA_LABEL_OCCURRENCES = 39;

function allTestIdOccurrences(): string[] {
	return componentSources().flatMap(({ text }) =>
		[...text.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]),
	);
}

function allAriaLabelOccurrences(): string[] {
	return componentSources().flatMap(({ text }) =>
		[...text.matchAll(/aria-label=("[^"]*"|\{[^}]*\})/g)].map((m) => m[1]),
	);
}

describe('AC-56-12 掴み手の不変(契約 6): data-testid と aria-label の値の集合が減っていない', () => {
	test(`data-testid: 再起案時点の ${DATA_TESTIDS.length} 種がすべて残っている`, () => {
		const present = new Set(allTestIdOccurrences());
		expect(DATA_TESTIDS.filter((id) => !present.has(id)), '消えた data-testid').toEqual([]);
	});

	test(`data-testid: 出現数は ${DATA_TESTID_OCCURRENCES} 箇所以上`, () => {
		expect(allTestIdOccurrences().length).toBeGreaterThanOrEqual(DATA_TESTID_OCCURRENCES);
	});

	test(`aria-label: 再起案時点の ${ARIA_LABELS.length} 種(ソースの属性値のまま)がすべて残っている`, () => {
		const present = new Set(allAriaLabelOccurrences());
		expect(ARIA_LABELS.filter((v) => !present.has(v)), '消えた・変わった aria-label').toEqual([]);
	});

	test(`aria-label: 出現数は ${ARIA_LABEL_OCCURRENCES} 箇所以上`, () => {
		expect(allAriaLabelOccurrences().length).toBeGreaterThanOrEqual(ARIA_LABEL_OCCURRENCES);
	});
});

// ---------------------------------------------------------------------------
// AC-56-13 — 文言の不変(新しいメニュー項目も英語)
// ---------------------------------------------------------------------------

/** 要件#51 の ui-language.acceptance と同じ範囲(全角空白・かな・漢字・全角記号)。 */
const CJK_PATTERN = /[　-〿぀-ヿ一-鿿＀-￯]/;

describe('AC-56-13 文言の不変(契約 6): menu.rs の文字列リテラル(新しいメニュー項目のラベルを含む)に CJK が無い', () => {
	test('menu.rs のコード行の文字列リテラルに CJK 文字が 1 つも無い', () => {
		const code = stripRustLineComments(readText('src-tauri/src/menu.rs'));
		const literals = [...code.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
		expect(literals.length, 'menu.rs に文字列リテラルがあること').toBeGreaterThan(0);
		expect(literals.filter((s) => CJK_PATTERN.test(s)), 'CJK を含むリテラル').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-56-14 — iframe まわりの不変
// ---------------------------------------------------------------------------

const HTML_VIEWER_SVELTE_SHA = '7e33f1e2c5430e87f19ed91a12797d0756136f76f1249405312d2216577483d1';
const HTML_VIEWER_TS_SHA = 'f46496a025f1685c2bc03034a6e56b50e6dfd10a8a8d7fc6dbd03c4b83466b5d';

describe('AC-56-14 iframe まわりの不変(契約 6): HtmlViewer.svelte と html-viewer.ts の SHA-256', () => {
	test('src/components/HtmlViewer.svelte は再起案時点から不変', () => {
		expect(sha256('src/components/HtmlViewer.svelte')).toBe(HTML_VIEWER_SVELTE_SHA);
	});

	test('src/lib/html-viewer.ts は再起案時点から不変', () => {
		expect(sha256('src/lib/html-viewer.ts')).toBe(HTML_VIEWER_TS_SHA);
	});
});

// ---------------------------------------------------------------------------
// AC-56-15 — tauri.conf.json と窓の生成の不変(Overlay は取り下げ)
// ---------------------------------------------------------------------------

const WINDOW0_BEFORE = {
	title: 'vellis',
	tabbingIdentifier: 'vellis-noroot:main',
	width: 1280,
	height: 800,
} as const;

const CSP_BEFORE =
	"default-src 'self' tauri: customprotocol: asset:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: vellis-asset: asset: http://asset.localhost tauri: customprotocol:; font-src 'self' data:; media-src 'self' vellis-asset: asset: http://asset.localhost; frame-src 'self' vellis-asset:; connect-src 'self' ipc: http://ipc.localhost vellis-asset: asset: http://asset.localhost tauri: customprotocol:; object-src 'none'; base-uri 'self' vellis-asset:; frame-ancestors 'none'";

/** 製品の窓を作る 2 箇所(契約 4。`print.rs` は印刷用・`self_check` は自己点検用で対象外)。 */
const WINDOW_CREATION_SITES = ['src-tauri/src/ipc/handler.rs', 'src-tauri/src/commands/window.rs'] as const;

type TauriConf = {
	app: { windows: Array<Record<string, unknown>>; security: { csp: string } };
};

function tauriConf(): TauriConf {
	return JSON.parse(readText('src-tauri/tauri.conf.json')) as TauriConf;
}

describe('AC-56-15 tauri.conf.json の不変(契約 4・6): windows[0] は再起案時点の 4 項目だけ・CSP 不変・窓の生成に title_bar_style 無し', () => {
	test('app.windows は 1 つのまま', () => {
		expect(tauriConf().app.windows.length).toBe(1);
	});

	test('app.windows[0] は title / tabbingIdentifier / width / height の 4 項目だけで値も同じ(titleBarStyle / hiddenTitle / trafficLightPosition の追加なし)', () => {
		expect(tauriConf().app.windows[0]).toEqual(WINDOW0_BEFORE);
	});

	test('app.security.csp は不変(style-src は self + unsafe-inline のまま=<style> の注入に新しい許可は要らない)', () => {
		expect(tauriConf().app.security.csp).toBe(CSP_BEFORE);
		expect(CSP_BEFORE).toContain("style-src 'self' 'unsafe-inline'");
	});

	for (const site of WINDOW_CREATION_SITES) {
		test(`${site} のコード行に title_bar_style( が無い(標準のタイトルバーのまま)`, () => {
			const code = stripRustLineComments(readText(site));
			expect(code.includes('WebviewWindowBuilder::new('), `${site} は窓を作る箇所であること`).toBe(true);
			expect(code.includes('title_bar_style(')).toBe(false);
		});
	}
});

// ---------------------------------------------------------------------------
// AC-56-16 — print.css の不変
// ---------------------------------------------------------------------------

const PRINT_CSS_SHA = 'c966daeb86dd45fc5f090de6b1201cc8108b07200ec5842d5752f994abe72088';

describe('AC-56-16 print.css の不変(契約 6・判断 (p)): SHA-256 と var(--) 参照 0 件', () => {
	test('src/styles/print.css は再起案時点から不変', () => {
		expect(sha256('src/styles/print.css')).toBe(PRINT_CSS_SHA);
	});

	test('print.css は var(-- を 1 件も参照しない(印刷はトークンの影響を受けない)', () => {
		expect(readText('src/styles/print.css').match(/var\(--/g) ?? []).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-56-17 — src/markdown/** の不変
// ---------------------------------------------------------------------------

/** `find src/markdown -type f | sort | xargs shasum -a 256`(2026-11-02)。renderer.ts は別扱い。 */
const MARKDOWN_TREE_SHA: Record<string, string> = {
	'src/markdown/alert.acceptance.test.ts': '2870f094d41f1e431ddefeae2ef026e87bf30759638c622a8ea12475ea4db714',
	'src/markdown/code-edit.acceptance.test.ts': '7a5d27d547ee8d9a83af4cc230bc4bd95dce7f17287b736f1282b7e8878b948c',
	'src/markdown/edit-redirect-single.acceptance.test.ts': '397483a7dbe4537320083f4c0013add0193158bc529ceb298fd0f7fa149f0ae9',
	'src/markdown/edit-redirect.acceptance.test.ts': '8c0196200e7d3f8a9d9848503e30f4629fee43820440f12024abff2d5328214e',
	'src/markdown/edit-tasklist-strike.acceptance.test.ts': 'cd50ed9a8fed11dc84da1d91b8bf3314f8a0d04607baaa99da597615abe75399',
	'src/markdown/edit-tilde-single.acceptance.test.ts': 'b7d10a156b65ff66aa5659e282818eefa77c6fcc35cccffbaa3cfd559ae5eeef',
	'src/markdown/edit-tilde.acceptance.test.ts': '715ca45340479c2bebe694a019b3fb47a24a8d4c3b442de8b89c952f2b8cebae',
	'src/markdown/edit.acceptance.test.ts': '0f0d013af1189945a734dd2021f65b0033a6f1a0f7c8cb646e856fadd18d5b7a',
	'src/markdown/edit.ts': 'f8a5e377ffb0d7a65da0ca65965195e3a81cbc266e09178005aa7ead7b360a8b',
	'src/markdown/footnote.acceptance.test.ts': '9d61e214a6aa41f5cd4afc9d15074f33d40c2730591c95d772573b13889e6fb5',
	'src/markdown/plugins/alert.ts': '3ba83323a1ee73165bbba8e6289bbee97da6d49209b965909bae75aaeb4c755e',
	'src/markdown/plugins/code-attrs.ts': '195b84c41d4608fc4330a84b5e62d5d24b0a6dc83f19db8368216d4eeb582542',
	'src/markdown/plugins/fence-langs.ts': '06d615222e9312d2bc9380e5327ff85c5b893aaeb683a17bde1a9de1b8547b2c',
	'src/markdown/plugins/footnote-ids.ts': 'c9be25559ed8abc60de4bd9a16999b9a8bf1f464ca17f44b4aa314eb7051d11f',
	'src/markdown/plugins/mermaid.test.ts': 'ffb95db9f6472f77a9f4998df3dd5d430f9f51a9200d8b688d29841f47875bc3',
	'src/markdown/plugins/mermaid.ts': '4b5677a2b346e0bb554bffc08b144ed5d5edf7903190d83a63962e32e84da747',
	'src/markdown/plugins/rewrite-uri.test.ts': 'd1eb10c22653bf323c4ec3c9dcee8b610e3e332a3c6ff12fc0f92854396e42a8',
	'src/markdown/plugins/rewrite-uri.ts': '3a304d7c6f6a216129f7a0c53496d36838e54b884d0a16d454c2f306af8a62f1',
	'src/markdown/plugins/source-map.test.ts': '2fb082dc7572732bbec01ff4b1fdb0cecce99d784699a58cf62c687862d7d52f',
	'src/markdown/plugins/source-map.ts': 'd540ff0fc26fc5dece3a631afe11b0046144077013df94d20d1763a774deb96b',
	'src/markdown/renderer.test.ts': '22eea1caac41ae3dec921b388d5f2e36e4193f032f6397815c1c2707c5f1d4c7',
	'src/markdown/sample.test.ts': 'b82a1da869fe58e6c527d847a4123f8ca76117693a5d2a828cb439cbad816726',
	'src/markdown/sanitize-schema.no-et.test.ts': '5423e902935b765d74fd61617f052e917d646b35bfecce653ec6bb5988cebc0c',
	'src/markdown/sanitize-schema.test.ts': '26b6f09720fa75a0af63a2c8c3809a83da835891f7098bad05796b3986f5d325',
	'src/markdown/sanitize-schema.ts': '81af988ca8a9a39fd04cd8dc89381380f6e1d9e23f4c1f5901b3b638c49551c6',
	'src/markdown/selection.acceptance.test.ts': '15b734182ef273fa8710675c8df832250c5dfff87aa6af409cdfe9fed0dcbed2',
	'src/markdown/selection.test.ts': 'ad7ae215ed699891c790abf576d7095fbe360703fc231ba6c7edbc05404cbea4',
	'src/markdown/selection.ts': '8ee2fb364ac2f1bceb1102dcd3c370f30b449b6d0b30e5515f0d54186c2f2a03',
	'src/markdown/source-index.test.ts': '78a48c9b66aae61b8ccf5395aad2825ede9f8db88a6b475d39f81d4ce81fd181',
	'src/markdown/source-index.ts': '38e88b46bdc617d55583c8e5d6d83c40bc083c4ebf57bc66d278ba43f99b6a01',
	'src/markdown/types.ts': '2e2a1ac44fba6a987447775954ec38886b363e9c435b9254d185088c9e992892',
};
const RENDERER_PATH = 'src/markdown/renderer.ts';
/** renderer.ts の export 名(`export (async )?function|interface|type|const|class|enum <name>`)。 */
const RENDERER_EXPORTS_BEFORE = ['RenderResult', 'render'] as const;

describe('AC-56-17 src/markdown/** の不変(契約 6): renderer.ts 以外のファイル集合と SHA-256・renderer.ts の export', () => {
	test('src/markdown/** のファイル集合は再起案時点と同じ(renderer.ts を含めて増減なし)', () => {
		const files = listFilesRecursive('src/markdown');
		expect(files).toEqual([...Object.keys(MARKDOWN_TREE_SHA), RENDERER_PATH].sort());
	});

	test('renderer.ts 以外のすべてのファイルの SHA-256 が再起案時点から不変', () => {
		const changed = Object.entries(MARKDOWN_TREE_SHA)
			.filter(([rel, sha]) => sha256(rel) !== sha)
			.map(([rel]) => rel);
		expect(changed, '変わったファイル').toEqual([]);
	});

	test('renderer.ts の export の集合が減っていない(render / RenderResult)', () => {
		const src = readText(RENDERER_PATH);
		const names = new Set(
			[...src.matchAll(/^export\s+(?:async\s+)?(?:function|interface|type|const|let|class|enum)\s+([A-Za-z_$][\w$]*)/gm)].map(
				(m) => m[1],
			),
		);
		expect(RENDERER_EXPORTS_BEFORE.filter((n) => !names.has(n)), '消えた export').toEqual([]);
	});
});
