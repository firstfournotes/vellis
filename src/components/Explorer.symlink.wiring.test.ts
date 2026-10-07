/**
 * 要件#70 の受け入れテスト(docs/requirements/req-70.md)— Explorer の配線
 * (AC-70-8〜11・契約 3〜8。component プロジェクト・`Explorer.svelte` を JSDOM にマウントする=
 * Explorer.zoom.wiring.test.ts と同じ家風)
 *
 * 「Explorer(ツリー)でシンボリックリンクの行がそれと分かるように表示する」。一覧の行が
 * リンクかどうかを運ぶ Rust 側は src-tauri/tests/acceptance_req70.rs(AC-70-1〜7)。ここは
 * `link` 付きの `Entry` をツリーに流し、**印(`.link-badge`)・行のクラス(`is-link` /
 * `is-broken-link`)・ツールチップ(`.icon` / `.name` の `title`)・リンク切れのクリックが何も
 * しないこと・差し替え(`applyDirectoryEvent` / `setChildEntries`)の後も印が残ること**を判定する。
 *
 * ## 配線に求める契約(implementer はこれに従う=本テストが前提にする名前と形)
 * - フロントの型 `Entry`(`stores/window-state.svelte.ts`)に `link?: { target?: string; broken: boolean }`
 * - `ExplorerItem.svelte`: `entry.link` のある行は `<button class="explorer-item">` に `is-link`、
 *   `link.broken` なら `is-broken-link` も付ける。`.icon` の中に `.link-badge` を 1 つ置き、それは
 *   `viewBox` を持つインライン `<svg>`(またはそれを包む要素)で `aria-hidden="true"`・子孫に
 *   `<title>` を置かない。`.name` の中身は名前の文字だけ。アイコンの絵文字は今のまま
 *   (フォルダ=U+1F4C1・それ以外=U+1F4C4)
 * - 行の `<button>` の `title` は**リンクの行も URI だけ**(Go to の行送り・既存テストのキー)。
 *   リンクの行では `.icon` と `.name` の span に `title` を付け、`<URI>\n<2 行目>` の形にする。
 *   2 行目は `Symbolic link → <target>` / `Broken symbolic link → <target>` / `Symbolic link`
 *   (target 無し)/ `Broken symbolic link`(リンク切れで target 無し)。矢印は U+2192・区切りは `\n` 1 つ
 * - リンクでない行の DOM は今のまま(`is-link`・`.link-badge`・子孫の `title` を持たない)
 * - `is-broken-link` の行のクリック(修飾キーなし・metaKey・shiftKey)は何もしない=
 *   `open_document` / `open_binary_document` / `new_tab` / `new_window` を呼ばず、
 *   `confirmDiscardEdits` も `alert` も呼ばず、`windowState.currentDocument` と `selectedTreeUri` は
 *   そのまま。辿れるリンクの行のクリックは今どおり(`open_document` をリンクの URI で)
 * - `ExplorerItem.svelte` の `<style>` に、`is-broken-link` を含むセレクタで `.name` に
 *   `color: var(--color-text-muted)` を当てる規則がある(色の直書きは theme.acceptance.test.ts が禁じる)
 *
 * ## 判定しないもの
 * - 印の見た目・選択中やホバーの背景との重なり・ズームでの拡縮 → 人間ゲート 1・4
 * - ssh の一覧が `{ broken: false }` を付けること(Rust 側)→ reviewer 照合・人間ゲート 5
 * - 既存スイートが無改変で緑(AC-70-12)→ test-runner のフルスイートと `pnpm check`
 *
 * ## スタブの設計(Explorer.newtab / open-failure.wiring の家風)
 * - $lib/ipc: モジュールモック(open_document は DocumentPayload 形・list_dir は各テストが
 *   `listDirReply` で差す一覧・他は null)。observe するのは command 名
 * - $lib/edit-guard: confirmDiscardEdits(true)=呼ばれる/呼ばれないの観測
 * - `alert` は `vi.stubGlobal`
 * - plugin-opener / plugin-dialog: Explorer が抱える ContextMenu.svelte の import を成立させるだけ
 * - ツリーのデータは props(root / entries)と windowState に直接入れる。AC-70-11 だけ展開中の
 *   フォルダを置き、ExplorerItem の展開 effect(subscribe_dir / list_dir)を通して子を取らせる
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/edit-guard', () => ({ confirmDiscardEdits: vi.fn(async () => true) }));
vi.mock('@tauri-apps/plugin-opener', () => ({
	revealItemInDir: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
	openUrl: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
	open: vi.fn(async () => null),
	ask: vi.fn(async () => false),
}));

import { invoke } from '$lib/ipc';
import { confirmDiscardEdits } from '$lib/edit-guard';
import Explorer from './Explorer.svelte';
import { windowState, type DocumentPayload, type Entry } from '../stores/window-state.svelte';
import { contextMenu } from '../stores/context-menu.svelte';

const invokeMock = vi.mocked(invoke);
const confirmMock = vi.mocked(confirmDiscardEdits);

// ---------------------------------------------------------------------------
// フィクスチャ(Rust の list が返す形をそのまま並べる=フォルダが先・名前順)
// ---------------------------------------------------------------------------

const ROOT = 'file:///Users/x/notes';
/** 普通のフォルダ(AC-70-11 で展開する)。 */
const PLAIN_DIR = `${ROOT}/docs`;
/** フォルダへのリンク(`kind: 'dir'`・辿れる)。 */
const DIR_LINK = `${ROOT}/shared-link`;
/** リンク切れで target 無し(`kind: 'symlink'`)。 */
const BROKEN_NO_TARGET = `${ROOT}/ghost.md`;
/** ファイルへのリンク(`kind: 'file'`・辿れる・相対のリンク先)。 */
const FILE_LINK = `${ROOT}/link.md`;
/** リンク切れ(`kind: 'symlink'`・target あり)。 */
const BROKEN = `${ROOT}/missing.md`;
/** 普通のファイル。 */
const PLAIN = `${ROOT}/plain.md`;
/** ssh の形(リンクだがリンク先不明=`{ broken: false }`)。URI は file のままで形だけ借りる。 */
const SSH_LIKE = `${ROOT}/remote-link.md`;

const DIR_LINK_TARGET = '/Users/x/shared';
const FILE_LINK_TARGET = '../shared/a.md';
const BROKEN_TARGET = 'no-such.md';

const FOLDER_ICON = '\u{1F4C1}';
const FILE_ICON = '\u{1F4C4}';
const ARROW = '→';

const entries: Entry[] = [
	{ uri: PLAIN_DIR, name: 'docs', kind: 'dir' },
	{ uri: DIR_LINK, name: 'shared-link', kind: 'dir', link: { target: DIR_LINK_TARGET, broken: false } },
	{ uri: BROKEN_NO_TARGET, name: 'ghost.md', kind: 'symlink', link: { broken: true } },
	{ uri: FILE_LINK, name: 'link.md', kind: 'file', link: { target: FILE_LINK_TARGET, broken: false } },
	{ uri: BROKEN, name: 'missing.md', kind: 'symlink', link: { target: BROKEN_TARGET, broken: true } },
	{ uri: PLAIN, name: 'plain.md', kind: 'file' },
	{ uri: SSH_LIKE, name: 'remote-link.md', kind: 'symlink', link: { broken: false } },
];

const LINK_ROWS: { uri: string; name: string; icon: string; secondLine: string }[] = [
	{ uri: DIR_LINK, name: 'shared-link', icon: FOLDER_ICON, secondLine: `Symbolic link ${ARROW} ${DIR_LINK_TARGET}` },
	{ uri: FILE_LINK, name: 'link.md', icon: FILE_ICON, secondLine: `Symbolic link ${ARROW} ${FILE_LINK_TARGET}` },
	{ uri: SSH_LIKE, name: 'remote-link.md', icon: FILE_ICON, secondLine: 'Symbolic link' },
	{ uri: BROKEN, name: 'missing.md', icon: FILE_ICON, secondLine: `Broken symbolic link ${ARROW} ${BROKEN_TARGET}` },
	{ uri: BROKEN_NO_TARGET, name: 'ghost.md', icon: FILE_ICON, secondLine: 'Broken symbolic link' },
];
const NON_LINK_ROWS = [
	{ uri: PLAIN_DIR, name: 'docs', icon: FOLDER_ICON },
	{ uri: PLAIN, name: 'plain.md', icon: FILE_ICON },
];

const DOC_BEFORE: DocumentPayload = { uri: PLAIN, content: '# plain\n', modified: 1 };

/** `list_dir` の応答(AC-70-11 が差し替える)。 */
let listDirReply: Entry[] = [];

function installInvoke() {
	invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === 'open_document' || cmd === 'open_binary_document') {
			return { uri: args?.uri, content: '', modified: null };
		}
		if (cmd === 'list_dir') return listDirReply;
		if (cmd === 'new_window' || cmd === 'new_tab') return 'vellis-2';
		return null;
	});
}

const callsOf = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd);

const alertMock = vi.fn((_message?: unknown) => {});

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 非同期のクリック処理・展開 effect・store の反映を流しきる。 */
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
	await flushAsync();
	await flushAsync();
}

function mountExplorer(rows: Entry[] = entries) {
	const result = render(Explorer, {
		props: {
			root: ROOT,
			entries: rows,
			selectedUri: undefined,
			onDuplicateWindow: vi.fn(),
			onOpenInNewWindow: vi.fn(),
		},
	});
	const nav = result.container.querySelector('nav.explorer-list');
	if (!(nav instanceof HTMLElement)) throw new Error('Explorer must render nav.explorer-list');
	return { ...result, nav };
}

/** `scrollTreeItemIntoView`(+page.svelte)と同じ引き方: `.explorer-item` を `title === uri` で探す。 */
function rowsByTitle(nav: HTMLElement, uri: string): HTMLElement[] {
	return [...nav.querySelectorAll<HTMLElement>('.explorer-item')].filter((row) => row.title === uri);
}

function rowOf(nav: HTMLElement, uri: string): HTMLButtonElement {
	const rows = rowsByTitle(nav, uri);
	expect(rows, `exactly one row with title === ${uri}`).toHaveLength(1);
	const row = rows[0];
	if (!(row instanceof HTMLButtonElement)) throw new Error(`row ${uri} must be a <button class="explorer-item">`);
	return row;
}

function spanOf(row: HTMLElement, cls: 'icon' | 'name'): HTMLElement {
	const span = row.querySelector(`.${cls}`);
	if (!(span instanceof HTMLElement)) throw new Error(`row must contain .${cls}`);
	return span;
}

/** `.link-badge` の実体の `<svg>`(badge 自身が svg か、badge の中の svg)。 */
function svgOfBadge(badge: Element): SVGElement {
	const svg = badge instanceof SVGSVGElement ? badge : badge.querySelector('svg');
	if (!(svg instanceof SVGElement)) throw new Error('.link-badge must be an inline <svg> or wrap one');
	return svg;
}

beforeEach(() => {
	listDirReply = [];
	installInvoke();
	confirmMock.mockResolvedValue(true);
	alertMock.mockClear();
	vi.stubGlobal('alert', alertMock);
	windowState.applyRoot(ROOT, entries, false);
	windowState.setExpandedDirs([]);
});

afterEach(() => {
	contextMenu.close();
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-70-8 — 印(契約4・8)
// ---------------------------------------------------------------------------

describe('AC-70-8: link rows carry is-link and one .link-badge inside .icon (contract 4, 8)', () => {
	it.each(LINK_ROWS)('$name: <button> has is-link and exactly one .link-badge inside .icon', ({ uri }) => {
		const { nav } = mountExplorer();
		const row = rowOf(nav, uri);
		expect(row.classList.contains('is-link')).toBe(true);
		const badges = row.querySelectorAll('.link-badge');
		expect(badges).toHaveLength(1);
		expect(badges[0].closest('.icon'), 'the badge sits inside .icon').toBe(spanOf(row, 'icon'));
	});

	it.each(LINK_ROWS)('$name: the badge is an inline svg with viewBox, aria-hidden="true", and no <title>', ({ uri }) => {
		const { nav } = mountExplorer();
		const badge = rowOf(nav, uri).querySelector('.link-badge')!;
		const svg = svgOfBadge(badge);
		expect(svg.getAttribute('viewBox'), 'svg has a viewBox (scales with zoom)').toBeTruthy();
		const hidden = svg.getAttribute('aria-hidden') === 'true' || badge.getAttribute('aria-hidden') === 'true';
		expect(hidden, 'the badge is hidden from the accessibility tree (判断 (p))').toBe(true);
		expect(badge.querySelectorAll('title')).toHaveLength(0);
		expect(svg.querySelectorAll('title')).toHaveLength(0);
	});

	it.each(LINK_ROWS)('$name: .name holds the name only and the icon emoji is unchanged', ({ uri, name, icon }) => {
		const { nav } = mountExplorer();
		const row = rowOf(nav, uri);
		expect(spanOf(row, 'name').textContent).toBe(name);
		// The svg has no text, so the icon's text is still just the emoji.
		expect(spanOf(row, 'icon').textContent?.replace(/\s/g, '')).toBe(icon);
	});

	it.each(NON_LINK_ROWS)('$name (not a link): no is-link, no .link-badge, no descendant title', ({ uri, name, icon }) => {
		const { nav } = mountExplorer();
		const row = rowOf(nav, uri);
		expect(row.classList.contains('is-link')).toBe(false);
		expect(row.classList.contains('is-broken-link')).toBe(false);
		expect(row.querySelectorAll('.link-badge')).toHaveLength(0);
		expect(row.querySelectorAll('[title]'), 'only the <button> itself carries a title').toHaveLength(0);
		expect(spanOf(row, 'name').textContent).toBe(name);
		expect(spanOf(row, 'icon').textContent?.replace(/\s/g, '')).toBe(icon);
	});

	it('every badge lives inside nav.explorer-list (so the tree zoom scales it too)', () => {
		const { nav, container } = mountExplorer();
		expect(nav.querySelectorAll('.link-badge')).toHaveLength(LINK_ROWS.length);
		expect(container.querySelectorAll('.link-badge')).toHaveLength(LINK_ROWS.length);
	});
});

// ---------------------------------------------------------------------------
// AC-70-9 — ツールチップ(契約5)
// ---------------------------------------------------------------------------

describe('AC-70-9: the row title stays the URI; .icon/.name carry the two-line tooltip (contract 5)', () => {
	it.each(LINK_ROWS)('$name: <button title> is exactly the URI and the row is found by title once', ({ uri }) => {
		const { nav } = mountExplorer();
		expect(rowsByTitle(nav, uri)).toHaveLength(1);
		const row = rowOf(nav, uri);
		expect(row.getAttribute('title')).toBe(uri);
		// getByTitle throws when more than one element matches: the spans' two-line titles never equal the URI.
		expect(screen.getByTitle(uri)).toBe(row);
	});

	it.each(LINK_ROWS)('$name: .icon and .name title === "<URI>\\n<second line>"', ({ uri, secondLine }) => {
		const { nav } = mountExplorer();
		const row = rowOf(nav, uri);
		const expected = `${uri}\n${secondLine}`;
		expect(spanOf(row, 'icon').getAttribute('title')).toBe(expected);
		expect(spanOf(row, 'name').getAttribute('title')).toBe(expected);
	});

	it.each(NON_LINK_ROWS)('$name (not a link): .icon and .name have no title attribute', ({ uri }) => {
		const { nav } = mountExplorer();
		const row = rowOf(nav, uri);
		expect(spanOf(row, 'icon').hasAttribute('title')).toBe(false);
		expect(spanOf(row, 'name').hasAttribute('title')).toBe(false);
		expect(row.getAttribute('title')).toBe(uri);
	});
});

// ---------------------------------------------------------------------------
// AC-70-10 — リンク切れ(契約6・7)
// ---------------------------------------------------------------------------

describe('AC-70-10: broken links carry is-broken-link; resolvable links do not (contract 6)', () => {
	it('is-broken-link is on the two broken rows only', () => {
		const { nav } = mountExplorer();
		for (const uri of [BROKEN, BROKEN_NO_TARGET]) {
			const row = rowOf(nav, uri);
			expect(row.classList.contains('is-broken-link'), uri).toBe(true);
			expect(row.classList.contains('is-link'), uri).toBe(true);
		}
		for (const uri of [FILE_LINK, DIR_LINK, SSH_LIKE, PLAIN, PLAIN_DIR]) {
			expect(rowOf(nav, uri).classList.contains('is-broken-link'), uri).toBe(false);
		}
	});
});

describe('AC-70-10: ExplorerItem.svelte <style> mutes .name under is-broken-link via the theme token (contract 6, 7)', () => {
	function styleRules(): { selector: string; declarations: { prop: string; value: string }[] }[] {
		const source = readFileSync(resolve(__dirname, 'ExplorerItem.svelte'), 'utf8');
		const m = source.match(/<style[^>]*>([\s\S]*?)<\/style>/);
		expect(m, 'ExplorerItem.svelte has a <style> block').not.toBeNull();
		const css = m![1].replace(/\/\*[\s\S]*?\*\//g, ' ');
		const rules: { selector: string; declarations: { prop: string; value: string }[] }[] = [];
		const re = /([^{}]+)\{([^{}]*)\}/g;
		for (let r = re.exec(css); r !== null; r = re.exec(css)) {
			const declarations = r[2]
				.split(';')
				.map((d) => d.trim())
				.filter((d) => d.length > 0)
				.map((d) => {
					const idx = d.indexOf(':');
					return { prop: d.slice(0, idx).trim(), value: d.slice(idx + 1).replace(/\s+/g, '') };
				});
			rules.push({ selector: r[1].replace(/\s+/g, ' ').trim(), declarations });
		}
		return rules;
	}

	it('a rule whose selector contains is-broken-link and .name sets color: var(--color-text-muted)', () => {
		const matching = styleRules().filter(
			(rule) =>
				rule.selector.includes('is-broken-link') &&
				rule.selector.includes('.name') &&
				rule.declarations.some((d) => d.prop === 'color' && d.value === 'var(--color-text-muted)')
		);
		expect(matching.length, 'ExplorerItem.svelte needs e.g. `.is-broken-link .name { color: var(--color-text-muted); }`').toBeGreaterThanOrEqual(1);
	});
});

describe('AC-70-10: clicking a broken link does nothing (contract 6, 判断 (o))', () => {
	const modifiers: { label: string; init: MouseEventInit }[] = [
		{ label: 'plain click', init: {} },
		{ label: 'Command + click (metaKey)', init: { metaKey: true } },
		{ label: 'Shift + click (shiftKey)', init: { shiftKey: true } },
	];

	it.each(modifiers)('$label on missing.md: no open/new_tab/new_window invoke, no confirm, no alert, state unchanged', async ({ init }) => {
		windowState.setDocument(DOC_BEFORE);
		windowState.selectTreeItem(PLAIN);
		const { nav } = mountExplorer();

		await fireEvent.click(rowOf(nav, BROKEN), init);
		await settle();

		expect(callsOf('open_document')).toHaveLength(0);
		expect(callsOf('open_binary_document')).toHaveLength(0);
		expect(callsOf('new_tab')).toHaveLength(0);
		expect(callsOf('new_window')).toHaveLength(0);
		expect(confirmMock).not.toHaveBeenCalled();
		expect(alertMock).not.toHaveBeenCalled();
		expect(windowState.currentDocument).toEqual(DOC_BEFORE);
		expect(windowState.selectedTreeUri).toBe(PLAIN);
	});

	it('plain click on ghost.md (broken, no target) does nothing either', async () => {
		windowState.setDocument(DOC_BEFORE);
		const { nav } = mountExplorer();

		await fireEvent.click(rowOf(nav, BROKEN_NO_TARGET));
		await settle();

		expect(callsOf('open_document')).toHaveLength(0);
		expect(callsOf('open_binary_document')).toHaveLength(0);
		expect(callsOf('new_tab')).toHaveLength(0);
		expect(callsOf('new_window')).toHaveLength(0);
		expect(confirmMock).not.toHaveBeenCalled();
		expect(alertMock).not.toHaveBeenCalled();
		expect(windowState.currentDocument).toEqual(DOC_BEFORE);
	});

	it('contrast: a resolvable file link still opens as before (open_document with the link URI)', async () => {
		windowState.setDocument(DOC_BEFORE);
		const { nav } = mountExplorer();

		await fireEvent.click(rowOf(nav, FILE_LINK));
		await settle();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		const opened = callsOf('open_document');
		expect(opened).toHaveLength(1);
		expect(opened[0]?.[1]).toEqual({ uri: FILE_LINK });
		expect(windowState.currentDocument?.uri).toBe(FILE_LINK);
		expect(alertMock).not.toHaveBeenCalled();
	});

	it('contrast: the ssh-shaped link ({ broken: false }, kind symlink) still opens as before', async () => {
		const { nav } = mountExplorer();

		await fireEvent.click(rowOf(nav, SSH_LIKE));
		await settle();

		expect(callsOf('open_document')).toHaveLength(1);
		expect(callsOf('open_document')[0]?.[1]).toEqual({ uri: SSH_LIKE });
	});
});

// ---------------------------------------------------------------------------
// AC-70-11 — 差し替えの後も印が残る(契約3)
// ---------------------------------------------------------------------------

describe('AC-70-11: link survives applyRoot / applyDirectoryEvent / setChildEntries (contract 3)', () => {
	const CHILD_LINK = `${PLAIN_DIR}/child-link.md`;
	const CHILD_LINK_V2 = `${PLAIN_DIR}/renamed-link.md`;
	const CHILD_PLAIN = `${PLAIN_DIR}/child.md`;

	const childrenV1: Entry[] = [
		{ uri: CHILD_LINK, name: 'child-link.md', kind: 'file', link: { target: '../link.md', broken: false } },
		{ uri: CHILD_PLAIN, name: 'child.md', kind: 'file' },
	];
	const childrenV2: Entry[] = [
		{ uri: CHILD_LINK_V2, name: 'renamed-link.md', kind: 'symlink', link: { target: 'gone.md', broken: true } },
		{ uri: CHILD_PLAIN, name: 'child.md', kind: 'file' },
	];
	const childrenNoLink: Entry[] = [
		{ uri: CHILD_LINK_V2, name: 'renamed-link.md', kind: 'file' },
		{ uri: CHILD_PLAIN, name: 'child.md', kind: 'file' },
	];

	it('applyRoot keeps link on the rows and the tree renders the badge from the store entries', () => {
		expect(windowState.entries.find((e) => e.uri === FILE_LINK)?.link).toEqual({ target: FILE_LINK_TARGET, broken: false });
		expect(windowState.entries.find((e) => e.uri === SSH_LIKE)?.link).toEqual({ broken: false });
		expect(windowState.entries.find((e) => e.uri === PLAIN)?.link).toBeUndefined();

		const { nav } = mountExplorer(windowState.entries);
		expect(rowOf(nav, FILE_LINK).querySelectorAll('.link-badge')).toHaveLength(1);
		expect(spanOf(rowOf(nav, FILE_LINK), 'name').getAttribute('title')).toBe(`${FILE_LINK}\nSymbolic link ${ARROW} ${FILE_LINK_TARGET}`);
	});

	it('applyDirectoryEvent on the root keeps link; a listing without link removes the badge', async () => {
		const { nav, rerender } = mountExplorer(windowState.entries);
		expect(rowOf(nav, FILE_LINK).querySelectorAll('.link-badge')).toHaveLength(1);

		// directory_changed for the root: the same rows come again with link, plus a new broken one.
		const NEW_BROKEN = `${ROOT}/zzz-broken.md`;
		const refreshed: Entry[] = [...entries, { uri: NEW_BROKEN, name: 'zzz-broken.md', kind: 'symlink', link: { target: 'nowhere', broken: true } }];
		windowState.applyDirectoryEvent(ROOT, refreshed);
		expect(windowState.entries.find((e) => e.uri === FILE_LINK)?.link).toEqual({ target: FILE_LINK_TARGET, broken: false });
		expect(windowState.entries.find((e) => e.uri === NEW_BROKEN)?.link).toEqual({ target: 'nowhere', broken: true });

		// The page hands windowState.entries to Explorer as a prop; mirror that with rerender.
		await rerender({ entries: windowState.entries });
		await settle();
		expect(rowOf(nav, FILE_LINK).querySelectorAll('.link-badge')).toHaveLength(1);
		expect(rowOf(nav, FILE_LINK).classList.contains('is-link')).toBe(true);
		const added = rowOf(nav, NEW_BROKEN);
		expect(added.classList.contains('is-broken-link')).toBe(true);
		expect(added.querySelectorAll('.link-badge')).toHaveLength(1);
		expect(spanOf(added, 'icon').getAttribute('title')).toBe(`${NEW_BROKEN}\nBroken symbolic link ${ARROW} nowhere`);

		// A later listing where link.md is no longer a link (replaced by a real file): the badge goes away.
		const plainAgain: Entry[] = entries.map((e) => (e.uri === FILE_LINK ? { uri: FILE_LINK, name: 'link.md', kind: 'file' } : e));
		windowState.applyDirectoryEvent(ROOT, plainAgain);
		await rerender({ entries: windowState.entries });
		await settle();
		const row = rowOf(nav, FILE_LINK);
		expect(row.classList.contains('is-link')).toBe(false);
		expect(row.querySelectorAll('.link-badge')).toHaveLength(0);
		expect(row.querySelectorAll('[title]')).toHaveLength(0);
	});

	it('an expanded folder: list_dir children with link show the badge; applyDirectoryEvent keeps it; setChildEntries without link removes it', async () => {
		listDirReply = childrenV1;
		windowState.setExpandedDirs([PLAIN_DIR]);
		const { nav } = mountExplorer();
		await settle();

		// Children arrived through list_dir -> setChildEntries (ExplorerItem.loadChildren).
		expect(callsOf('list_dir').map((c) => c[1])).toEqual([{ uri: PLAIN_DIR }]);
		expect(windowState.childEntries[PLAIN_DIR]?.find((e) => e.uri === CHILD_LINK)?.link).toEqual({ target: '../link.md', broken: false });
		const child = rowOf(nav, CHILD_LINK);
		expect(child.classList.contains('is-link')).toBe(true);
		expect(child.querySelectorAll('.link-badge')).toHaveLength(1);
		expect(spanOf(child, 'name').getAttribute('title')).toBe(`${CHILD_LINK}\nSymbolic link ${ARROW} ../link.md`);
		const plainChild = rowOf(nav, CHILD_PLAIN);
		expect(plainChild.classList.contains('is-link')).toBe(false);
		expect(plainChild.querySelectorAll('.link-badge')).toHaveLength(0);

		// directory_changed for the expanded folder: a broken link replaces the first child.
		windowState.applyDirectoryEvent(PLAIN_DIR, childrenV2);
		await settle();
		expect(rowsByTitle(nav, CHILD_LINK)).toHaveLength(0);
		const renamed = rowOf(nav, CHILD_LINK_V2);
		expect(renamed.classList.contains('is-link')).toBe(true);
		expect(renamed.classList.contains('is-broken-link')).toBe(true);
		expect(renamed.querySelectorAll('.link-badge')).toHaveLength(1);
		expect(spanOf(renamed, 'icon').getAttribute('title')).toBe(`${CHILD_LINK_V2}\nBroken symbolic link ${ARROW} gone.md`);

		// setChildEntries with a listing that has no link: the badge and the tooltip disappear.
		windowState.setChildEntries(PLAIN_DIR, childrenNoLink);
		await settle();
		const noLink = rowOf(nav, CHILD_LINK_V2);
		expect(noLink.classList.contains('is-link')).toBe(false);
		expect(noLink.classList.contains('is-broken-link')).toBe(false);
		expect(noLink.querySelectorAll('.link-badge')).toHaveLength(0);
		expect(noLink.querySelectorAll('[title]')).toHaveLength(0);
	});
});
