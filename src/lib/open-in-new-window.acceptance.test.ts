/**
 * 要件#59 の受け入れテスト(docs/requirements/req-59.md)— 純関数と実行列
 * 「ツリーの右クリックから、そのフォルダを root にした新しいウィンドウを開く」
 *
 * 契約(2026-09-18 登録・丸番号は req-59.md「契約番号と本文の対応」):
 * - ① 入口=コンテキストメニューに「Open in New Window」(Open With… の次・
 *   Copy Path の前)
 * - ② 開く先=フォルダ項目はそれ自身・ファイル項目は親フォルダを root に。
 *   親が取れないときは disabled
 * - ③ 実行=既存の `new_window` command を流用(`src-tauri/**` 無改変)。
 *   引数は `{ path, root, expandedDirs: [] }`
 * - ⑥ ssh リモートも対象(Duplicate Window と同じ扱い=グレーアウトしない)
 * - ⑧ 不変=既存項目の挙動と文言・空白部メニュー・`src-tauri/**`・依存追加ゼロ
 *
 * 判定範囲(本ファイル): AC-59-4〜10・AC-59-14・AC-59-15。項目数と順序の
 * 台帳(AC-59-2 の全列挙)は context-menu.acceptance.test.ts(契約⑦の要件側
 * 更新)、配線(AC-59-11〜13)は ContextMenu.newwindow.wiring.test.ts、
 * 実機で窓が開くこと・新窓の初期状態・履歴は人間ゲート(acceptance.md 要件#59)。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * ```ts
 * // --- src/lib/uri.ts へ追加(起案時判断 (f)=Explorer.svelte の private 実装の引き上げ) ---
 * // URI 文字列から親ディレクトリの URI を導出する純関数。OS へ問い合わせない。
 * // 規則: 末尾のスラッシュを落としてから最後の '/' で切る。スキームと
 * // authority([user@]host[:port])は跨がない。authority 直下・スキーム無しは null。
 * // パーセントエンコードは復号しない(new_window へは URI のまま渡す)。
 * export function parentUri(uri: string): string | null;
 *
 * // --- src/lib/context-menu.ts へ追加 ---
 * // ContextMenuItemId に 'open-in-new-window' を追加(LABELS は 'Open in New Window')。
 * // ContextAction に1種類追加:
 * //   | { command: 'new-window'; root: string; path: string | null }
 * // planContextAction('open-in-new-window', entry) が返す:
 * //   - dir      → { command: 'new-window', root: entry.uri, path: null }
 * //   - file     → { command: 'new-window', root: parentUri(entry.uri), path: entry.uri }
 * //   - symlink  → file と同じ(指し先の種別をフロントは知らない=要件#19 の家風)
 * //   - 親が取れないファイル/symlink → null(グレーアウトの安全網)
 * //   - ssh でも null にしない(契約⑥=duplicate-window と同じ有効側)
 *
 * // --- 新規 src/lib/open-in-new-window.ts ---
 * // 計画 → invoke('new_window', { path, root, expandedDirs: [] }) を1回。
 * // 解決値(新窓のラベル)をそのまま返す。set_root は呼ばない。
 * // 失敗は reject をそのまま伝える(catch と alert は +page.svelte の合流点=
 * // duplicateWindow とまったく同じ分担。reviewer 照合)。
 * export function openInNewWindow<Label = string>(
 *   plan: { command: 'new-window'; root: string; path: string | null }
 * ): Promise<Label>;
 *
 * // 失敗 alert の文言(要件#35 ③・duplicateWindowFailedMessage と同じ形。英語=要件#51)。
 * export function openInNewWindowFailedMessage(err: unknown): string;
 * // => `Could not open a new window: ${err}`
 * ```
 *
 * invoke は `$lib/ipc` の薄いラッパを vi.mock する(duplicate-window と同じ家風・
 * モックは共有しない=本ファイルは自前で持つ)。実装側も同じ場所から import すること。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - +page.svelte: onOpenInNewWindow の合流点で openInNewWindow(plan) を呼び、
 *   失敗を catch して alert(openInNewWindowFailedMessage(err))(ハンドラの外へ
 *   出さない=契約③④)。既存ウィンドウの状態には触らない
 * - Explorer.svelte: prop の中継(onDuplicateWindow と並ぶ形)と、goUp が
 *   $lib/uri の parentUri を使う配線
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import { parentUri } from './uri';
import { buildContextMenu, planContextAction, type ContextMenuEntry } from './context-menu';
import { openInNewWindow, openInNewWindowFailedMessage } from './open-in-new-window';

const invokeMock = vi.mocked(invoke);

const REPO_ROOT = resolve(__dirname, '../..');

const localFile: ContextMenuEntry = {
	uri: 'file:///Users/x/notes/plan.md',
	name: 'plan.md',
	kind: 'file',
};
const localDir: ContextMenuEntry = {
	uri: 'file:///Users/x/notes',
	name: 'notes',
	kind: 'dir',
};
const localSymlink: ContextMenuEntry = {
	uri: 'file:///Users/x/notes/link',
	name: 'link',
	kind: 'symlink',
};
const sshFile: ContextMenuEntry = {
	uri: 'ssh://alice@host:22/srv/notes/plan.md',
	name: 'plan.md',
	kind: 'file',
};
const sshDir: ContextMenuEntry = {
	uri: 'ssh://alice@host:22/srv/notes',
	name: 'notes',
	kind: 'dir',
};
/** authority 直下のファイル=親が取れない(契約②の縮退)。 */
const rootFile: ContextMenuEntry = {
	uri: 'file:///notes.md',
	name: 'notes.md',
	kind: 'file',
};

/** 項目1つを引く(位置は AC-59-1/2 = context-menu.acceptance.test.ts の持ち場)。 */
const itemFor = (entry: ContextMenuEntry) =>
	buildContextMenu(entry).filter((i) => i.id === 'open-in-new-window');

beforeEach(() => {
	invokeMock.mockReset();
	invokeMock.mockResolvedValue('vellis-2');
});

// ---------------------------------------------------------------------------
// AC-59-4 — parentUri: 親フォルダの導出(契約②)
// ---------------------------------------------------------------------------

describe('AC-59-4: parentUri — URI 文字列から親ディレクトリを導出(契約②)', () => {
	test('file URI: 最後のセグメントを落とす', () => {
		expect(parentUri('file:///a/b/c.md')).toBe('file:///a/b');
	});

	test('ssh URI([user@]host[:port])でも同じ規則・authority は跨がない', () => {
		expect(parentUri('ssh://user@h:22/a/b/c.md')).toBe('ssh://user@h:22/a/b');
	});

	test('末尾スラッシュは先に落とす(file:///a/b/ → file:///a)', () => {
		expect(parentUri('file:///a/b/')).toBe('file:///a');
	});

	test('末尾スラッシュが複数でも同じ(file:///a/b/// → file:///a)', () => {
		expect(parentUri('file:///a/b///')).toBe('file:///a');
	});

	test('パーセントエンコードは保つ(復号しない=new_window へは URI のまま)', () => {
		expect(parentUri('file:///a/My%20Docs/read%20me.md')).toBe('file:///a/My%20Docs');
	});

	test('authority 直下は null(file:///c.md・ssh://host/c.md)', () => {
		expect(parentUri('file:///c.md')).toBeNull();
		expect(parentUri('ssh://host/c.md')).toBeNull();
	});

	test('スキームの無い文字列は null', () => {
		expect(parentUri('/Users/x/notes/plan.md')).toBeNull();
		expect(parentUri('notes.md')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-59-5 / AC-59-6 — planContextAction('open-in-new-window', …) の計画(契約②③)
// ---------------------------------------------------------------------------

describe('AC-59-5: フォルダ項目の計画 — そのフォルダを root に・文書は開かない(契約②③)', () => {
	test("dir → { command: 'new-window', root: そのフォルダの URI, path: null }", () => {
		expect(planContextAction('open-in-new-window', localDir)).toEqual({
			command: 'new-window',
			root: 'file:///Users/x/notes',
			path: null,
		});
	});

	test('URI は変形しない — 末尾スラッシュ付きの dir はそのまま root に載る', () => {
		const dirWithSlash: ContextMenuEntry = {
			uri: 'file:///Users/x/notes/',
			name: 'notes',
			kind: 'dir',
		};
		expect(planContextAction('open-in-new-window', dirWithSlash)).toEqual({
			command: 'new-window',
			root: 'file:///Users/x/notes/',
			path: null,
		});
	});

	test('URI は変形しない — パーセントエンコードされた dir も verbatim', () => {
		const encoded: ContextMenuEntry = {
			uri: 'file:///Users/x/My%20Docs',
			name: 'My Docs',
			kind: 'dir',
		};
		expect(planContextAction('open-in-new-window', encoded)).toEqual({
			command: 'new-window',
			root: 'file:///Users/x/My%20Docs',
			path: null,
		});
	});
});

describe('AC-59-6: ファイル項目の計画 — 親フォルダを root に・そのファイルを開く(契約②③)', () => {
	test("file → { command: 'new-window', root: 親フォルダ, path: そのファイルの URI }", () => {
		expect(planContextAction('open-in-new-window', localFile)).toEqual({
			command: 'new-window',
			root: 'file:///Users/x/notes',
			path: 'file:///Users/x/notes/plan.md',
		});
	});

	test('symlink もファイルと同じ計画(指し先の種別をフロントは知らない=要件#19 の家風)', () => {
		expect(planContextAction('open-in-new-window', localSymlink)).toEqual({
			command: 'new-window',
			root: 'file:///Users/x/notes',
			path: 'file:///Users/x/notes/link',
		});
	});

	test('パーセントエンコードされたファイルは root も path も URI のまま(復号しない)', () => {
		const encoded: ContextMenuEntry = {
			uri: 'file:///Users/x/My%20Docs/read%20me.md',
			name: 'read me.md',
			kind: 'file',
		};
		expect(planContextAction('open-in-new-window', encoded)).toEqual({
			command: 'new-window',
			root: 'file:///Users/x/My%20Docs',
			path: 'file:///Users/x/My%20Docs/read%20me.md',
		});
	});
});

// ---------------------------------------------------------------------------
// AC-59-7 — 親が取れないときは disabled と null(契約②の縮退)
// ---------------------------------------------------------------------------

describe('AC-59-7: authority 直下のファイル — disabled と null(契約②)', () => {
	test('file:///notes.md のファイル項目 → open-in-new-window は enabled: false', () => {
		expect(itemFor(rootFile)).toEqual([
			{ id: 'open-in-new-window', label: 'Open in New Window', enabled: false },
		]);
	});

	test('ssh://host/notes.md のファイル項目も enabled: false(authority を跨がない)', () => {
		expect(
			itemFor({ uri: 'ssh://host/notes.md', name: 'notes.md', kind: 'file' })
		).toEqual([{ id: 'open-in-new-window', label: 'Open in New Window', enabled: false }]);
	});

	test('planContextAction は null(グレーアウトの安全網=既存の null 家風)', () => {
		expect(planContextAction('open-in-new-window', rootFile)).toBeNull();
		expect(
			planContextAction('open-in-new-window', {
				uri: 'ssh://host/notes.md',
				name: 'notes.md',
				kind: 'file',
			})
		).toBeNull();
	});

	test('フォルダ項目は authority 直下でも enabled: true(自身が root になる=親を見ない)', () => {
		const rootDir: ContextMenuEntry = { uri: 'file:///notes', name: 'notes', kind: 'dir' };
		expect(itemFor(rootDir)).toEqual([
			{ id: 'open-in-new-window', label: 'Open in New Window', enabled: true },
		]);
		expect(planContextAction('open-in-new-window', rootDir)).toEqual({
			command: 'new-window',
			root: 'file:///notes',
			path: null,
		});
	});
});

// ---------------------------------------------------------------------------
// AC-59-8 — ssh でも有効(契約⑥)
// ---------------------------------------------------------------------------

describe('AC-59-8: ssh リモートでも有効 — remote null の家風の対象外(契約⑥)', () => {
	test('ssh のファイル / フォルダ / symlink で enabled: true', () => {
		expect(itemFor(sshFile)).toEqual([
			{ id: 'open-in-new-window', label: 'Open in New Window', enabled: true },
		]);
		expect(itemFor(sshDir)).toEqual([
			{ id: 'open-in-new-window', label: 'Open in New Window', enabled: true },
		]);
		expect(itemFor({ ...sshFile, kind: 'symlink' })).toEqual([
			{ id: 'open-in-new-window', label: 'Open in New Window', enabled: true },
		]);
	});

	test('計画は local と同形(root は ssh URI のまま・null にしない)', () => {
		expect(planContextAction('open-in-new-window', sshDir)).toEqual({
			command: 'new-window',
			root: 'ssh://alice@host:22/srv/notes',
			path: null,
		});
		expect(planContextAction('open-in-new-window', sshFile)).toEqual({
			command: 'new-window',
			root: 'ssh://alice@host:22/srv/notes',
			path: 'ssh://alice@host:22/srv/notes/plan.md',
		});
	});
});

// ---------------------------------------------------------------------------
// AC-59-9 — openInNewWindow: 実行列(契約③)
// ---------------------------------------------------------------------------

describe('AC-59-9: openInNewWindow — new_window を1回・expandedDirs は常に空(契約③)', () => {
	test("dir の計画 → invoke('new_window', { path: null, root, expandedDirs: [] }) を1回だけ", async () => {
		await openInNewWindow({ command: 'new-window', root: 'file:///Users/x/notes', path: null });

		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('new_window');
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({
			path: null,
			root: 'file:///Users/x/notes',
			expandedDirs: [],
		});
	});

	test('file の計画 → path にそのファイルの URI・展開は発明しない(契約⑤)', async () => {
		await openInNewWindow({
			command: 'new-window',
			root: 'ssh://alice@host:22/srv/notes',
			path: 'ssh://alice@host:22/srv/notes/plan.md',
		});

		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({
			path: 'ssh://alice@host:22/srv/notes/plan.md',
			root: 'ssh://alice@host:22/srv/notes',
			expandedDirs: [],
		});
	});

	test('解決値(新窓のラベル)をそのまま返す', async () => {
		invokeMock.mockResolvedValueOnce('vellis-7');
		await expect(
			openInNewWindow({ command: 'new-window', root: 'file:///Users/x/notes', path: null })
		).resolves.toBe('vellis-7');
	});

	test('set_root は呼ばない — root を開くのは新窓側の init_window(契約④)', async () => {
		await openInNewWindow({ command: 'new-window', root: 'file:///Users/x/notes', path: null });

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['new_window']);
	});
});

// ---------------------------------------------------------------------------
// AC-59-10 — 失敗の扱い(契約③④)
// ---------------------------------------------------------------------------

describe('AC-59-10: 失敗の扱い — 文言は値固定・reject は catch できる形で伝える(契約③④)', () => {
	test("文字列エラー → 'Could not open a new window: <err>'(値固定・英語=要件#51)", () => {
		expect(openInNewWindowFailedMessage('no window')).toBe(
			'Could not open a new window: no window'
		);
	});

	test('Error オブジェクトは文字列化して挟む(duplicateWindowFailedMessage と同じ形)', () => {
		expect(openInNewWindowFailedMessage(new Error('boom'))).toBe(
			'Could not open a new window: Error: boom'
		);
	});

	test('invoke の reject はそのまま伝わる(合流点の catch → alert が受ける=分担は #34 と同一)', async () => {
		const failure = new Error('window creation failed');
		invokeMock.mockRejectedValueOnce(failure);

		// rejects で受けられる= unhandled rejection にならない形で失敗が返ること。
		// +page.svelte が catch して alert(openInNewWindowFailedMessage(err)) する配線は
		// reviewer 照合(ハンドラの外へ出さない=契約④の残り半分)。
		await expect(
			openInNewWindow({ command: 'new-window', root: 'file:///Users/x/notes', path: null })
		).rejects.toBe(failure);
	});

	test('失敗しても追加の invoke はしない(set_root で現在の窓を触らない=契約④)', async () => {
		invokeMock.mockRejectedValueOnce(new Error('boom'));
		await openInNewWindow({
			command: 'new-window',
			root: 'file:///Users/x/notes',
			path: null,
		}).catch(() => {});

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['new_window']);
	});
});

// ---------------------------------------------------------------------------
// AC-59-14 — Rust 無改変と依存追加ゼロ(契約③⑧のソース検査)
// ---------------------------------------------------------------------------

describe('AC-59-14: src-tauri 無改変・依存追加ゼロ(契約③⑧)', () => {
	test('menu.rs に open-in-new-window 系の文字列が無い(File メニューへ足さない=起案時判断 (g))', () => {
		const menuRs = readFileSync(resolve(REPO_ROOT, 'src-tauri/src/menu.rs'), 'utf-8');
		expect(menuRs).not.toContain('open-in-new-window');
		expect(menuRs).not.toContain('open_in_new_window');
		expect(menuRs).not.toContain('Open in New Window');
	});

	test('capabilities/default.json は無改変(new_window は既に呼べる=Shift+クリックが通っている)', () => {
		const capability = JSON.parse(
			readFileSync(resolve(REPO_ROOT, 'src-tauri/capabilities/default.json'), 'utf-8')
		) as { permissions: Array<string | { identifier: string }> };
		const identifiers = capability.permissions.map((p) =>
			typeof p === 'string' ? p : p.identifier
		);
		// 要件#59 登録時点の permission 一覧(この順)。追加も削除も並べ替えもしない。
		expect(identifiers).toEqual([
			'core:default',
			'opener:allow-open-url',
			'opener:allow-reveal-item-in-dir',
			'opener:allow-open-path',
			'dialog:default',
			'window-state:default',
			'core:window:allow-destroy',
		]);
	});

	test('package.json の依存キーが登録時点と同一(runtime / dev とも)', () => {
		const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		// 要件#59 登録時点(2026-09-20)の依存(AC-51-10 と同じ固定方式)。
		expect(Object.keys(pkg.dependencies).sort()).toEqual(
			[
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
			].sort()
		);
		expect(Object.keys(pkg.devDependencies).sort()).toEqual(
			[
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
			].sort()
		);
	});

	test('Cargo.toml の [dependencies] のクレート集合が登録時点と同一', () => {
		const cargo = readFileSync(resolve(REPO_ROOT, 'src-tauri/Cargo.toml'), 'utf-8');
		const section = cargo.split(/^\[dependencies\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
		const crates = section
			.split('\n')
			.map((line) => /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1])
			.filter((name): name is string => !!name);
		// 要件#59 登録時点(2026-09-20)のクレート一覧。追加ゼロ(契約⑧)。
		expect([...crates].sort()).toEqual(
			[
				'tauri',
				'tauri-plugin-opener',
				'serde',
				'serde_json',
				'clap',
				'thiserror',
				'tokio',
				'async-trait',
				'notify',
				'libc',
				'tracing',
				'tracing-subscriber',
				'mime_guess',
				'http',
				'percent-encoding',
				'tauri-plugin-dialog',
				'reqwest',
				'russh',
				'russh-sftp',
				'bytes',
				'dirs',
				'ulid',
				'chrono',
				'strsim',
				'sha2',
				'similar',
				'hidapi',
				'toml',
				'tauri-plugin-webdriver',
				'tauri-plugin-window-state',
			].sort()
		);
	});
});

// ---------------------------------------------------------------------------
// AC-59-15 — 親フォルダ導出の共有(契約②・起案時判断 (f))
// ---------------------------------------------------------------------------

describe('AC-59-15: parentUri の引き上げ — Explorer.svelte と同じ答え・重複の不在(起案時判断 (f))', () => {
	// Explorer.svelte の「親フォルダへ移動」(goUp)が使っていた private 実装と
	// 同じ答えを返すこと(引き上げ前の実測値=2026-09-20)。
	test('goUp と同じ答え: root の URI → 1つ上のフォルダ', () => {
		expect(parentUri('file:///Users/x/notes')).toBe('file:///Users/x');
		expect(parentUri('ssh://alice@host:22/srv/notes')).toBe('ssh://alice@host:22/srv');
	});

	test('goUp と同じ答え: authority 直下の root は null(↑ボタンの disabled と同じ縮退)', () => {
		expect(parentUri('file:///Users')).toBeNull();
		expect(parentUri('ssh://alice@host:22/srv')).toBeNull();
	});

	test('goUp と同じ答え: 末尾スラッシュ付きの root でも同じ', () => {
		expect(parentUri('file:///Users/x/notes/')).toBe('file:///Users/x');
	});

	test('Explorer.svelte に同等の private 実装が残っていない(ソース走査=AC-51-8 と同じ作法)', () => {
		const explorer = readFileSync(
			resolve(REPO_ROOT, 'src/components/Explorer.svelte'),
			'utf-8'
		);
		expect(explorer).not.toMatch(/function\s+parentUri\s*\(/);
		expect(explorer).not.toMatch(/const\s+parentUri\s*=/);
	});

	test("Explorer.svelte は $lib/uri の parentUri を import して使う(共有の固定)", () => {
		const explorer = readFileSync(
			resolve(REPO_ROOT, 'src/components/Explorer.svelte'),
			'utf-8'
		);
		expect(explorer).toMatch(/import\s*\{[^}]*\bparentUri\b[^}]*\}\s*from\s*['"]\$lib\/uri['"]/);
	});
});
