/**
 * Issue #822 — 右クリックのメニューの Reload File が 2 回走る見込み(ネイティブの項目の id がメニューバーと同じ)。
 * `editor-context-menu-once.wiring.test.ts`(実機ゲート (2)・Format の 2 回走り)と同じ作り。
 *
 * 編集面の右クリックのメニュー(`src/lib/native-menu.ts` の `popupMenu`)は項目を Tauri の menu に写す。Reload File の id `reload-file` は
 * メニューバーの `RELOAD_FILE_ITEM_ID`(menu.rs)と同じなので、押すと JS の action(`runEditorMenuAction` → `requestReloadFile`)と、
 * Rust の on_menu_event(`src-tauri/src/lib.rs` の `id == menu::RELOAD_FILE_ITEM_ID` の腕 → `menu_reload_file` を前面の窓へ → +page の
 * `registerReloadFileListener` の run)の 2 回走る見込み。未保存の変更があるときは確認が 2 回出る。
 *
 * ## 固定する振る舞い(直った後)
 * - 右クリックのメニューの Reload File を 1 回選ぶと、Reload File の実体(+page が `setReloadFileRequestHandler` で登録する `reload`)が
 *   **ちょうど 1 回**走る(Markdown・コード・raw のどの面でも)
 * - 直し方は縛らない: ネイティブの id をメニューバーと別にする(Format と同じ `ctx-` など)でも、JS の action を外して Rust の転送に任せる
 *   でも通る
 *
 * ## 判定の作り(推奨の解釈)
 * - 「項目を 1 回選ぶ」= ネイティブの項目の action があれば呼ぶ+Rust がその id を `menu_reload_file` として転送するなら、+page と同じく
 *   登録した `reload` を 1 回呼ぶ(+page の `registerReloadFileListener(run)` は イベント 1 回で run 1 回)。Rust の転送の決まりは `lib.rs` の
 *   on_menu_event で `MENU_RELOAD_FILE_EVENT` を送る腕の条件(`id == …` / `id.starts_with(…)` の && の並び。定数は `menu.rs` から読む)を
 *   そのまま評価する。項目は文言(Reload File)で探す(id の綴りは問わない)
 * - Pin to Bookmarks(`pin-to-bookmarks`)は menu.rs に同じ id の項目が無いので対象にしない
 *
 * ## 修正前に赤になる理由
 * - ネイティブの id が `reload-file` = `RELOAD_FILE_ITEM_ID` なので、JS の action と Rust の転送で `reload` が 2 回呼ばれる
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EditorState, Transaction } from 'prosemirror-state';

type Made = { kind: string; opts: Record<string, unknown> };
const made: Made[] = [];
const popupMock = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('@tauri-apps/api/menu', () => {
	const make = (kind: string) => ({
		new: vi.fn(async (opts: Record<string, unknown> = {}) => {
			made.push({ kind, opts });
			return { kind, opts, id: opts.id };
		}),
	});
	return {
		Menu: { new: vi.fn(async (opts: Record<string, unknown> = {}) => ({ kind: 'Menu', opts, popup: popupMock })) },
		MenuItem: make('MenuItem'),
		PredefinedMenuItem: make('PredefinedMenuItem'),
		Submenu: make('Submenu'),
		CheckMenuItem: make('CheckMenuItem'),
		IconMenuItem: make('IconMenuItem'),
	};
});
vi.mock('@tauri-apps/api/dpi', () => ({
	LogicalPosition: class {
		readonly type = 'Logical';
		constructor(
			public x: number,
			public y: number,
		) {}
	},
	PhysicalPosition: class {
		readonly type = 'Physical';
		constructor(
			public x: number,
			public y: number,
		) {}
	},
}));
vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('$lib/events', () => ({ listen: vi.fn(async () => () => {}) }));

import { handleEditorContextMenu } from './editor-context-menu-handler';
import { createMarkdownDocument } from './markdown-document';
import type { MarkdownEditorHandle } from './file-editor';
import { RELOAD_FILE_LABEL, setReloadFileRequestHandler } from '$lib/reload-file';

const REPO_ROOT = resolve(__dirname, '../..');
const URI = 'file:///Users/a/notes/plan.md';
const MD = 'Intro paragraph here.\n\nafter\n';

// ---------------------------------------------------------------------------
// Rust の on_menu_event の menu_reload_file の腕(ソースから読む)
// ---------------------------------------------------------------------------

function rustConsts(): Map<string, string> {
	const src = readFileSync(resolve(REPO_ROOT, 'src-tauri/src/menu.rs'), 'utf8');
	const out = new Map<string, string>();
	for (const m of src.matchAll(/pub const ([A-Z0-9_]+): &str = "([^"]*)";/g)) out.set(m[1]!, m[2]!);
	return out;
}
/** `MENU_RELOAD_FILE_EVENT` を送る腕の条件(`id if <guard> =>`)。無ければ null(Rust は転送しない)。 */
function reloadArmGuard(): string | null {
	const src = readFileSync(resolve(REPO_ROOT, 'src-tauri/src/lib.rs'), 'utf8');
	const arms = [...src.matchAll(/id if ([^\n]*?) =>\s*\{([\s\S]*?)\n\s*\}/g)];
	const arm = arms.find((m) => /MENU_RELOAD_FILE_EVENT/.test(m[2]!));
	return arm ? arm[1]! : null;
}
/** Rust がこの id を menu_reload_file として前面の窓へ送るか(腕の条件を評価する)。 */
function rustForwardsAsReload(id: string | undefined): boolean {
	if (id === undefined) return false; // id を渡さなければ Tauri が振る(メニューバーの id と重ならない)
	const guard = reloadArmGuard();
	if (guard === null) return false;
	const consts = rustConsts();
	const value = (expr: string): string => {
		const t = expr.trim();
		const lit = /^"([^"]*)"$/.exec(t);
		if (lit) return lit[1]!;
		const name = t.replace(/^menu::/, '');
		const v = consts.get(name);
		if (v === undefined) throw new Error(`menu.rs に定数 ${name} が無い(このテストの Rust の模型を見直す)`);
		return v;
	};
	return guard.split('&&').every((term) => {
		const t = term.trim();
		let m = /^(!?)id\.starts_with\((.+)\)$/.exec(t);
		if (m) return (m[1] === '!') !== id.startsWith(value(m[2]!));
		m = /^id\s*(==|!=)\s*(.+)$/.exec(t);
		if (m) return (m[1] === '==') === (id === value(m[2]!));
		throw new Error(`lib.rs の menu_reload_file の腕の条件 \`${t}\` を評価できない(このテストの Rust の模型を見直す)`);
	});
}

// ---------------------------------------------------------------------------
// 面と、+page が登録する Reload File の実体
// ---------------------------------------------------------------------------

function markdownHandle(): MarkdownEditorHandle {
	let state: EditorState = createMarkdownDocument(MD, { uri: URI, readOnly: false }).state;
	const view = {
		get state() {
			return state;
		},
		dispatch(tr: Transaction) {
			state = state.apply(tr);
		},
		composing: false,
		focus() {},
		dom: document.createElement('div'),
	};
	return {
		kind: 'markdown' as const,
		raw: false,
		view: view as unknown as import('prosemirror-view').EditorView,
		uri: URI,
		readOnly: false,
		dirty: false,
		conflict: false,
		notice: null,
		version: 0,
		text: () => MD,
		expectedHash: () => '',
		markSaved: () => {},
		applyFileChanged: () => 'apply' as const,
		keepMyEdits: () => {},
		useFileOnDisk: () => {},
		showSaveConflict: () => {},
		reset: () => {},
		preparePrint: async () => {},
		toggleRaw: () => {},
		model: () => {
			throw new Error('unused');
		},
	} as unknown as MarkdownEditorHandle;
}

async function flush() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

async function rightClick(target: Parameters<typeof handleEditorContextMenu>[1]) {
	const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 50 });
	expect(handleEditorContextMenu(ev, target)).toBe(true);
	await flush();
	expect(popupMock, 'popup が 1 回').toHaveBeenCalledTimes(1);
}
/** 文言で探したネイティブの項目。 */
function nativeItem(label: string): Made {
	const found = made.filter((m) => (m.kind === 'MenuItem' || m.kind === 'CheckMenuItem') && m.opts.text === label);
	expect(found, `ネイティブの項目 ${label}`).toHaveLength(1);
	return found[0]!;
}
/** 項目を 1 回選ぶ: JS の action(あれば)と、Rust の転送(すれば +page の購読と同じく reload を 1 回)。 */
async function chooseOnce(item: Made, reload: () => void) {
	const action = item.opts.action as (() => void) | undefined;
	if (action) action();
	await flush();
	if (rustForwardsAsReload(item.opts.id as string | undefined)) reload();
	await flush();
}

const reload = vi.fn((_target?: string | null) => undefined);

beforeEach(() => {
	made.length = 0;
	popupMock.mockClear();
	reload.mockClear();
	setReloadFileRequestHandler(reload);
});
afterEach(() => {
	setReloadFileRequestHandler(null);
	vi.clearAllMocks();
});

describe('Issue #822: 右クリックのメニューの Reload File を 1 回選ぶと、Reload File の実体がちょうど 1 回走る', () => {
	test('前提(Rust の模型): メニューバーの View ▸ Reload File(menu.rs の RELOAD_FILE_ITEM_ID)は Rust が menu_reload_file として転送する', () => {
		const id = rustConsts().get('RELOAD_FILE_ITEM_ID');
		expect(id, 'menu.rs に RELOAD_FILE_ITEM_ID がある').toBeDefined();
		expect(rustForwardsAsReload(id)).toBe(true);
	});

	test('Markdown の面: reload は 1 回(JS の action と Rust の転送で 2 回走らない)', async () => {
		await rightClick({ surface: 'markdown', uri: URI, readOnly: false, handle: markdownHandle() });
		await chooseOnce(nativeItem(RELOAD_FILE_LABEL), () => reload(null));
		expect(reload, 'Reload File の実体はちょうど 1 回').toHaveBeenCalledTimes(1);
	});

	test('コードの面: reload は 1 回', async () => {
		await rightClick({ surface: 'code', uri: 'file:///Users/a/notes/memo.txt', readOnly: false });
		await chooseOnce(nativeItem(RELOAD_FILE_LABEL), () => reload(null));
		expect(reload).toHaveBeenCalledTimes(1);
	});

	test('raw の面: reload は 1 回', async () => {
		await rightClick({ surface: 'raw', uri: URI, readOnly: false });
		await chooseOnce(nativeItem(RELOAD_FILE_LABEL), () => reload(null));
		expect(reload).toHaveBeenCalledTimes(1);
	});

	test('Reload File の項目は 1 つで、押せば実体は走る(0 回にはならない)', async () => {
		await rightClick({ surface: 'markdown', uri: URI, readOnly: false, handle: markdownHandle() });
		const item = nativeItem(RELOAD_FILE_LABEL);
		expect(item.kind).toBe('MenuItem');
		await chooseOnce(item, () => reload(null));
		expect(reload).toHaveBeenCalled();
	});
});
