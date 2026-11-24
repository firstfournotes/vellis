/**
 * 要件#74 第2段 2-2 の受け入れテスト(docs/requirements/req-74.md)— Markdown の編集面のキー割り当て
 * (AC-74-8 の後半「ProseMirror に渡すキー割り当てに Format のショートカットと同じキーが無い」・契約8・第2段の作り(案)の項目 8。
 *  unit プロジェクト・DOM なし)
 *
 * ## 仮の前提(由谷の確認待ち): 2-1 の判断 1〜3(判断 3 により Enter / Tab のリストの操作は prosemirror-schema-list)
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 第2段の作り(案)8)
 *
 * ```ts
 * // --- src/editor/markdown-keymap.ts(新規)
 * /** prosemirror-keymap の `keymap(bindings)` に渡す形(キー名 → Command)。 *\/
 * export const MARKDOWN_KEYMAP: Readonly<Record<string, Command>>;
 * ```
 *
 * 入れるもの: Enter(リストの中は splitListItem・ほかは splitBlock)・Shift-Enter(hard break)・Backspace・Delete・Tab・Shift-Tab・
 * Mod-z・Shift-Mod-z。矢印・選択・行頭 / 行末は既定(ブラウザ)。`baseKeymap` を丸ごとは使わない(`Mod-[` などが入る)。
 * 入れないもの: Format の表のキー・`menu.rs` の全アクセラレータ・Option + Command + U(raw)・Command + D / Shift + D / Option + 矢印・Command + /。
 *
 * ## 修正前に赤になる理由
 * - `src/editor/markdown-keymap.ts` が無いので import で落ちる
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { createMarkdownDocument } from './markdown-document';

import { MARKDOWN_KEYMAP } from './markdown-keymap';

const REPO_ROOT = resolve(__dirname, '../..');

type Combo = string;
const MOD_NAMES: Record<string, 'Mod' | 'Ctrl' | 'Alt' | 'Shift'> = {
	cmdorctrl: 'Mod',
	cmd: 'Mod',
	command: 'Mod',
	super: 'Mod',
	meta: 'Mod',
	mod: 'Mod',
	ctrl: 'Ctrl',
	control: 'Ctrl',
	alt: 'Alt',
	option: 'Alt',
	shift: 'Shift',
};
const KEY_NAMES: Record<string, string> = {
	backslash: '\\',
	up: 'ArrowUp',
	down: 'ArrowDown',
	left: 'ArrowLeft',
	right: 'ArrowRight',
	arrowup: 'ArrowUp',
	arrowdown: 'ArrowDown',
	arrowleft: 'ArrowLeft',
	arrowright: 'ArrowRight',
	period: '.',
	comma: ',',
	plus: '+',
	minus: '-',
	equal: '=',
	space: ' ',
	esc: 'Escape',
	escape: 'Escape',
	return: 'Enter',
	enter: 'Enter',
	tab: 'Tab',
	backspace: 'Backspace',
	delete: 'Delete',
	home: 'Home',
	end: 'End',
};
function normalizeKey(raw: string): string {
	const lower = raw.toLowerCase();
	if (KEY_NAMES[lower]) return KEY_NAMES[lower];
	return raw.length === 1 ? raw.toLowerCase() : raw;
}
function combo(mods: Iterable<string>, key: string): Combo {
	return [...new Set(mods)].sort().join('+') + ':' + normalizeKey(key);
}
/** `menu.rs` のアクセラレータ(`"CmdOrCtrl+Shift+F"` の形)を集めて正規化(第1段の code-keymap.acceptance と同じ読み方)。 */
function menuAccelerators(): Combo[] {
	const src = readFileSync(resolve(REPO_ROOT, 'src-tauri/src/menu.rs'), 'utf8');
	const out: Combo[] = [];
	for (const m of src.matchAll(/"((?:[A-Za-z]+\+)+[^"+\s]+)"/g)) {
		const parts = m[1]!.split('+');
		const key = parts.pop()!;
		const mods = parts.map((p) => MOD_NAMES[p.toLowerCase()]);
		if (mods.some((x) => x === undefined)) continue;
		out.push(combo(mods as string[], key));
	}
	return out;
}
/** prosemirror-keymap のキー名(`Shift-Mod-z`・`Mod-[`)を正規化。 */
function pmCombo(name: string): Combo {
	const parts = name.split(/-(?!$)/);
	const key = parts.pop()!;
	const mods = parts.map((p) => {
		const mod = MOD_NAMES[p.toLowerCase()];
		if (!mod) throw new Error(`unknown modifier in "${name}": ${p}`);
		return mod;
	});
	return combo(mods, key);
}
function allCombos(): Combo[] {
	return Object.keys(MARKDOWN_KEYMAP).map(pmCombo);
}

const FORMAT_KEYS: Combo[] = [
	combo(['Mod'], 'b'),
	combo(['Mod'], 'i'),
	combo(['Mod', 'Shift'], 'x'),
	combo(['Mod', 'Shift'], 'c'),
	combo(['Mod'], 'k'),
	...['0', '1', '2', '3', '4', '5', '6'].map((n) => combo(['Mod', 'Alt'], n)),
	combo(['Mod', 'Shift'], '8'),
	combo(['Mod', 'Shift'], '7'),
	combo(['Mod', 'Shift'], 'l'),
	combo(['Mod', 'Shift'], '.'),
	combo(['Mod', 'Alt'], 'c'),
	combo(['Mod'], ']'),
	combo(['Mod'], '['),
	combo(['Mod', 'Alt'], 'u'),
];
const RESERVED_KEYS: Combo[] = [
	combo(['Mod'], 'd'),
	combo(['Mod', 'Shift'], 'd'),
	...['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map((k) => combo(['Mod', 'Alt'], k)),
	combo(['Alt'], 'ArrowUp'),
	combo(['Alt'], 'ArrowDown'),
	combo(['Mod'], '/'),
];

describe('AC-74-8: MARKDOWN_KEYMAP は必要なキーを持つ', () => {
	test('キー名 → Command の表で、空でない', () => {
		expect(Object.keys(MARKDOWN_KEYMAP).length).toBeGreaterThan(0);
		for (const [k, v] of Object.entries(MARKDOWN_KEYMAP)) expect(typeof v, k).toBe('function');
	});

	test.each([
		['Enter', combo([], 'Enter')],
		['Shift-Enter(hard break)', combo(['Shift'], 'Enter')],
		['Backspace', combo([], 'Backspace')],
		['Delete', combo([], 'Delete')],
		['Tab', combo([], 'Tab')],
		['Shift-Tab', combo(['Shift'], 'Tab')],
		['Mod-z(undo)', combo(['Mod'], 'z')],
		['Shift-Mod-z(redo)', combo(['Mod', 'Shift'], 'z')],
	])('%s がある', (_label, want) => {
		expect(allCombos()).toContain(want);
	});
});

describe('AC-74-8: MARKDOWN_KEYMAP に入れないキー', () => {
	test('Format の表のキーと raw のキー(Command + B / I / K / Shift + X・C・7・8・L・Period / Option + 0〜6・C・U / ] / [)が無い', () => {
		const mine = new Set(allCombos());
		expect(FORMAT_KEYS.filter((k) => mine.has(k))).toEqual([]);
	});

	test('menu.rs の全アクセラレータと重ならない', () => {
		const mine = new Set(allCombos());
		expect(menuAccelerators().filter((a) => mine.has(a))).toEqual([]);
	});

	test('複数カーソル・分割の案・行の移動・コメントのキーが無い', () => {
		const mine = new Set(allCombos());
		expect(RESERVED_KEYS.filter((k) => mine.has(k))).toEqual([]);
	});

	test('baseKeymap を丸ごと入れていない(Mod-[ / Mod-] / Mod-Enter / Alt-ArrowUp が無い)', () => {
		const mine = new Set(allCombos());
		for (const k of [combo(['Mod'], '['), combo(['Mod'], ']'), combo(['Mod'], 'Enter'), combo(['Alt'], 'ArrowUp'), combo(['Mod', 'Alt'], 'Enter')]) {
			expect(mine.has(k), k).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// 要件74 第2段 2-6(AC-74-54 の 2-6 の分): 表のセルの中の Shift + Enter は何もしない
// ---------------------------------------------------------------------------

describe('AC-74-54(2-6): MARKDOWN_KEYMAP の Shift-Enter は table_cell / table_header の中で取引を起こさず true(鍵は食う)', () => {
	const TABLE = '| a | b |\n| - | - |\n| c | d |\n';

	function stateIn(cellText: string) {
		const m = createMarkdownDocument(TABLE, { uri: 'file:///Users/a/t.md', readOnly: false });
		let pos = -1;
		m.state.doc.descendants((n, p) => {
			if (n.isText && n.text === cellText) pos = p;
			return pos < 0;
		});
		expect(pos).toBeGreaterThan(0);
		return m.state.apply(m.state.tr.setSelection(TextSelection.create(m.state.doc, pos + 1)));
	}

	test('table_cell の中: dispatch されず true', () => {
		const state = stateIn('c');
		expect(state.selection.$from.parent.type.name).toBe('table_cell');
		const dispatch = vi.fn();
		expect(MARKDOWN_KEYMAP['Shift-Enter']!(state, dispatch)).toBe(true);
		expect(dispatch).not.toHaveBeenCalled();
	});

	test('table_header の中も同じ', () => {
		const state = stateIn('a');
		expect(state.selection.$from.parent.type.name).toBe('table_header');
		const dispatch = vi.fn();
		expect(MARKDOWN_KEYMAP['Shift-Enter']!(state, dispatch)).toBe(true);
		expect(dispatch).not.toHaveBeenCalled();
	});

	test('段落では今のまま hard_break を入れる', () => {
		const m = createMarkdownDocument('para\n', { uri: 'file:///Users/a/p.md', readOnly: false });
		const state = m.state.apply(m.state.tr.setSelection(TextSelection.create(m.state.doc, 3)));
		let applied = state;
		expect(MARKDOWN_KEYMAP['Shift-Enter']!(state, (tr) => (applied = state.apply(tr)))).toBe(true);
		let hb = 0;
		applied.doc.descendants((n) => {
			if (n.type.name === 'hard_break') hb++;
			return true;
		});
		expect(hb).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// 要件74 第3段 3-2【3-10】: 表のセルの Enter は同じ列の 1 つ下のセルへ(最後の行では何もしない)。契約は table-commands.acceptance.test.ts の先頭
// (MARKDOWN_KEYMAP.Enter の先頭に goToCellBelow)。
// ---------------------------------------------------------------------------

describe('AC-74-54【3-10】: MARKDOWN_KEYMAP の Enter は table_cell / table_header で 1 つ下のセルの先頭へ', () => {
	const TABLE = '| a | b |\n| - | - |\n| c | d |\n| e | f |\n';

	function stateAt(cellText: string) {
		const m = createMarkdownDocument(TABLE, { uri: 'file:///Users/a/t.md', readOnly: false });
		let pos = -1;
		m.state.doc.descendants((n, p) => {
			if (n.isText && n.text === cellText) pos = p;
			return pos < 0;
		});
		expect(pos).toBeGreaterThan(0);
		return m.state.apply(m.state.tr.setSelection(TextSelection.create(m.state.doc, pos + 1)));
	}
	function cellText(state: import('prosemirror-state').EditorState): string {
		return state.selection.$from.parent.textContent;
	}

	test('見出し b の中で Enter → 本文 1 行目の d の先頭(文書は不変・取引 1 つ)', () => {
		const state = stateAt('b');
		let applied = state;
		let n = 0;
		expect(
			MARKDOWN_KEYMAP.Enter!(state, (tr) => {
				n++;
				applied = state.apply(tr);
			})
		).toBe(true);
		expect(n).toBe(1);
		expect(applied.doc.eq(state.doc)).toBe(true);
		expect(cellText(applied)).toBe('d');
		expect(applied.selection.$from.parentOffset).toBe(0);
	});

	test('c の中で Enter → e の先頭', () => {
		const state = stateAt('c');
		let applied = state;
		expect(MARKDOWN_KEYMAP.Enter!(state, (tr) => (applied = state.apply(tr)))).toBe(true);
		expect(cellText(applied)).toBe('e');
		expect(applied.selection.$from.parentOffset).toBe(0);
	});

	test('最後の行 f の中で Enter → true(鍵は食う)・dispatch なし・セルは割れない', () => {
		const state = stateAt('f');
		const dispatch = vi.fn();
		expect(MARKDOWN_KEYMAP.Enter!(state, dispatch)).toBe(true);
		expect(dispatch).not.toHaveBeenCalled();
	});

	test('段落では今のまま段落を割る', () => {
		const m = createMarkdownDocument('para\n', { uri: 'file:///Users/a/p.md', readOnly: false });
		const state = m.state.apply(m.state.tr.setSelection(TextSelection.create(m.state.doc, 3)));
		let applied = state;
		expect(MARKDOWN_KEYMAP.Enter!(state, (tr) => (applied = state.apply(tr)))).toBe(true);
		expect(applied.doc.childCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 要件74 締め(P2・オーケストレーターの判断 2026-11-17): 見出しの中の Shift + Enter は表のセルと同じく取引なしで鍵を食う(h1〜h6)。
// (h3〜h6 では `### alpha  \nbeta` と書かれて読み直すと見出しと段落に割れ、h1 / h2 は setext に変わるため)
// ---------------------------------------------------------------------------

describe('締め P2: MARKDOWN_KEYMAP の Shift-Enter は heading(h1〜h6)の中で取引を起こさず true(鍵は食う)', () => {
	for (const level of [1, 2, 3, 6]) {
		test(`h${level} の真ん中で Shift + Enter → dispatch されず true・文書は不変`, () => {
			const src = `${'#'.repeat(level)} alpha beta\n\npara\n`;
			const m = createMarkdownDocument(src, { uri: 'file:///Users/a/h.md', readOnly: false });
			let pos = -1;
			m.state.doc.descendants((n, p) => {
				if (n.isText && n.text === 'alpha beta') pos = p;
				return pos < 0;
			});
			expect(pos).toBeGreaterThan(0);
			const state = m.state.apply(m.state.tr.setSelection(TextSelection.create(m.state.doc, pos + 5)));
			expect(state.selection.$from.parent.type.name).toBe('heading');
			expect(state.selection.$from.parent.attrs.level).toBe(level);
			const dispatch = vi.fn();
			expect(MARKDOWN_KEYMAP['Shift-Enter']!(state, dispatch)).toBe(true);
			expect(dispatch).not.toHaveBeenCalled();
			// 先頭と末尾でも同じ
			for (const at of [pos, pos + 'alpha beta'.length]) {
				const s = m.state.apply(m.state.tr.setSelection(TextSelection.create(m.state.doc, at)));
				const d = vi.fn();
				expect(MARKDOWN_KEYMAP['Shift-Enter']!(s, d)).toBe(true);
				expect(d).not.toHaveBeenCalled();
			}
		});
	}
});
