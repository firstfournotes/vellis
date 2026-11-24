/**
 * 要件#74 第2〜4段の実機ゲート(2026-11-18・bf6a804 の運転手)で見つかった製品の不具合の受け入れ(右クリックのメニューの分)。
 * 契約8(経路は 1 本=同じ命令が二重に効かない)・AC-74-27(編集面の右クリックの Format)。記録は scratchpad の req74-gate24/。
 *
 * ## 件と、修正前に赤になる理由
 * - (2) 右クリックのメニューの Format ▸ Bold などが効かない: 写したネイティブの項目の id がメニューバーと同じ `format-bold` で、
 *   JS の action(`runEditorMenuAction` → runFormatCommand)と、Rust の on_menu_event(`src-tauri/src/lib.rs` の `format-` 始まりを
 *   menu_format として前面の窓へ送る → +page が runFormatCommand)の 2 回走り、トグルが打ち消し合う
 * - (3) 右クリックのメニューがポインタの約 37 pt 上に開く: `native-menu.ts` が `LogicalPosition(clientX, clientY)` を渡し、Tauri は
 *   それを窓の座標(タイトルバー 32 pt を含む)として扱う
 *
 * ## 判定の作り(推奨の解釈。報告に列挙)
 * - (2) 「項目を 1 回選ぶ」= ネイティブの項目の action があれば呼ぶ+Rust がその id を menu_format として転送するなら +page と同じく
 *   runFormatCommand(id, handle) を呼ぶ。Rust の転送の決まりは `lib.rs` の on_menu_event の menu_format の腕の条件(`id.starts_with(…)` /
 *   `!id.starts_with(…)` / `id == …` の && の並び。定数は `menu.rs` から読む)をそのまま評価する。項目は文言(Bold / Heading 2)で探す
 *   (id の綴りは問わない)。期待=命令がちょうど 1 回(取引 1 つ)で、選択に太字が付く / 見出し 2 になる。JS の action を外して Rust の
 *   転送に任せても、id を替えて Rust が転送しないようにしても通る
 * - (3) popup の位置は「渡さない(カーソルの位置)」か「ポインタの client 座標そのものではない(タイトルバーの分を足した窓の座標など)」。
 *   jsdom の devicePixelRatio は 1
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';

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
import { runFormatCommand, type FormatItemId } from './commands';
import { createMarkdownDocument } from './markdown-document';
import type { MarkdownEditorHandle } from './file-editor';

const REPO_ROOT = resolve(__dirname, '../..');
const URI = 'file:///Users/a/notes/plan.md';
const MD = 'Intro paragraph here.\n\nafter\n';

// ---------------------------------------------------------------------------
// Rust の on_menu_event の menu_format の腕(ソースから読む)
// ---------------------------------------------------------------------------

function rustConsts(): Map<string, string> {
	const src = readFileSync(resolve(REPO_ROOT, 'src-tauri/src/menu.rs'), 'utf8');
	const out = new Map<string, string>();
	for (const m of src.matchAll(/pub const ([A-Z0-9_]+): &str = "([^"]*)";/g)) out.set(m[1]!, m[2]!);
	return out;
}
/** menu_format を送る腕の条件(`id if <guard> =>`)。 */
function formatArmGuard(): string {
	const src = readFileSync(resolve(REPO_ROOT, 'src-tauri/src/lib.rs'), 'utf8');
	const arms = [...src.matchAll(/id if ([^\n]*?) =>\s*\{([\s\S]*?)\n\s*\}/g)];
	const arm = arms.find((m) => /MENU_FORMAT_EVENT/.test(m[2]!));
	if (!arm) throw new Error('lib.rs の on_menu_event に menu_format を送る腕が見つからない(このテストの Rust の模型を見直す)');
	return arm[1]!;
}
/** Rust がこの id を menu_format として前面の窓へ送るか(腕の条件を評価する)。 */
function rustForwardsAsFormat(id: string | undefined): boolean {
	if (id === undefined) return false; // id を渡さなければ Tauri が振る(メニューバーの id と重ならない)
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
	return formatArmGuard()
		.split('&&')
		.every((term) => {
			const t = term.trim();
			let m = /^(!?)id\.starts_with\((.+)\)$/.exec(t);
			if (m) return (m[1] === '!') !== id.startsWith(value(m[2]!));
			m = /^id\s*(==|!=)\s*(.+)$/.exec(t);
			if (m) return (m[1] === '==') === (id === value(m[2]!));
			throw new Error(`lib.rs の menu_format の腕の条件 \`${t}\` を評価できない(このテストの Rust の模型を見直す)`);
		});
}

// ---------------------------------------------------------------------------
// 面(本物の文書モデルと取引)
// ---------------------------------------------------------------------------

function fakeHandle() {
	let state: EditorState = createMarkdownDocument(MD, { uri: URI, readOnly: false }).state;
	let dispatched = 0;
	const view = {
		get state() {
			return state;
		},
		dispatch(tr: Transaction) {
			dispatched++;
			state = state.apply(tr);
		},
		composing: false,
		focus() {},
		dom: document.createElement('div'),
	};
	const handle = {
		kind: 'markdown' as const,
		raw: false,
		view: view as unknown as import('prosemirror-view').EditorView,
		uri: URI,
		readOnly: false,
		dirty: false,
		conflict: false,
		notice: null,
		version: 0,
		text: () => '',
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
	};
	return {
		handle: handle as unknown as MarkdownEditorHandle,
		get state() {
			return state;
		},
		select(from: number, to: number) {
			state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
		},
		get dispatched() {
			return dispatched;
		},
	};
}

async function flush() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

async function rightClick(handle: MarkdownEditorHandle) {
	const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 50 });
	expect(handleEditorContextMenu(ev, { surface: 'markdown', uri: URI, readOnly: false, handle })).toBe(true);
	await flush();
	expect(popupMock, 'popup が 1 回').toHaveBeenCalledTimes(1);
}
/** 文言で探したネイティブの項目(Bold など)。 */
function nativeItem(label: string): Made {
	const found = made.filter((m) => (m.kind === 'MenuItem' || m.kind === 'CheckMenuItem') && m.opts.text === label);
	expect(found, `ネイティブの項目 ${label}`).toHaveLength(1);
	return found[0]!;
}
/** 項目を 1 回選ぶ: JS の action(あれば)と、Rust の転送(すれば +page と同じく runFormatCommand)。 */
async function chooseOnce(item: Made, handle: MarkdownEditorHandle) {
	const action = item.opts.action as (() => void) | undefined;
	if (action) action();
	await flush();
	const id = item.opts.id as string | undefined;
	if (rustForwardsAsFormat(id)) runFormatCommand(id as FormatItemId, handle);
	await flush();
}

beforeEach(() => {
	made.length = 0;
	popupMock.mockClear();
});
afterEach(() => {
	vi.clearAllMocks();
});

describe('実機ゲート (2) 契約8: 右クリックのメニューの Format の項目を 1 回選ぶと、書式の命令がちょうど 1 回だけ走る', () => {
	test('前提(Rust の模型): メニューバーの Format ▸ Bold(menu.rs の id)は Rust が menu_format として転送する', () => {
		const consts = rustConsts();
		const boldId = [...consts.entries()].find(([k]) => /^FORMAT_BOLD(_ITEM)?_ID$/.test(k))?.[1] ?? 'format-bold';
		expect(rustForwardsAsFormat(boldId)).toBe(true);
	});

	test('Bold: 選んだ語(Intro)に太字が付く・取引ちょうど 1 つ(JS の action と Rust の転送で 2 回走らない)', async () => {
		const face = fakeHandle();
		face.select(1, 1 + 'Intro'.length);
		await rightClick(face.handle);
		const before = face.dispatched;
		await chooseOnce(nativeItem('Bold'), face.handle);
		expect(face.dispatched - before, '命令は 1 回').toBe(1);
		const intro = face.state.doc.child(0).child(0);
		expect(intro.text).toBe('Intro');
		expect(intro.marks.map((m) => m.type.name), '太字が付いている(2 回走ると打ち消し合って付かない)').toEqual(['strong']);
	});

	test('Paragraph ▸ Heading 2: カーソルの段落が見出し 2 になる・取引ちょうど 1 つ', async () => {
		const face = fakeHandle();
		face.select(3, 3);
		await rightClick(face.handle);
		const before = face.dispatched;
		await chooseOnce(nativeItem('Heading 2'), face.handle);
		expect(face.dispatched - before, '命令は 1 回').toBe(1);
		expect(face.state.doc.child(0).type.name).toBe('heading');
		expect(face.state.doc.child(0).attrs.level).toBe(2);
	});
});

describe('実機ゲート (3) AC-74-27: 右クリックのメニューはポインタの位置に開く(client 座標をそのまま窓の座標として渡さない)', () => {
	test('popup は位置なし(カーソルの位置)か、client 座標(40, 50)そのものではない位置', async () => {
		const face = fakeHandle();
		await rightClick(face.handle);
		const at = popupMock.mock.calls[0]![0] as { x?: number; y?: number } | undefined;
		if (at !== undefined) {
			expect(at.x === 40 && at.y === 50, `popup の位置 ${JSON.stringify(at)} が client 座標そのもの(タイトルバーの分だけ上にずれる)`).toBe(false);
		}
	});
});
