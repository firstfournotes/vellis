/**
 * 要件#74 第1段の受け入れテスト(docs/requirements/req-74.md)— キー割り当てと触っていない範囲の不変
 * (AC-74-33・契約5・契約19 の「第1段の作り」16。unit プロジェクト・DOM なし)
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 契約19「第1段の作り」16)
 *
 * ```ts
 * // --- src/editor/code-keymap.ts(新規)
 * import type { KeyBinding } from '@codemirror/view';
 * /** `@codemirror/commands` から選んで組んだ割り当て。`basicSetup`・`defaultKeymap` 丸ごと・`searchKeymap` は使わない。 *\/
 * export const CODE_KEYMAP: readonly KeyBinding[];
 * ```
 *
 * 入れるもの: Enter(改行+前の行の字下げ)・Tab / Shift-Tab(字下げの単位で 1 段。複数行はまとめて)・Mod-z / Mod-Shift-z
 * (undo / redo)・矢印と Shift の選択・行頭 / 行末(Home / End か Mod-ArrowLeft / Mod-ArrowRight)。
 *
 * 入れないもの(AC-74-33): `menu.rs` の全アクセラレータ(ソース走査で集める)・Format の表(契約8)のキー・
 * Option + Command + U(raw=契約23)・Command + D / Command + Shift + D(複数カーソル)・Command + Option + 矢印(要件75 の分割の案)・
 * Option + 上下(行の移動=第3段)・Command + /(コメント=第3段)・Command + ] / Command + [(Format の字下げ)。
 *
 * ## キーの読み方(値固定)
 * - `menu.rs` の文字列リテラルのうち `A+B+…` の形(修飾の後に 1 つのキー)を集める。`CmdOrCtrl` / `Cmd` / `Command` / `Super` /
 *   `Meta`=Mod・`Ctrl` / `Control`=Ctrl・`Alt` / `Option`=Alt・`Shift`=Shift。キーは小文字で、`Backslash`→`\`・
 *   `Up`/`Down`/`Left`/`Right`→`ArrowUp`…・`Period`→`.`・`Comma`→`,`・`Plus`→`+`・`Minus`→`-`・`Equal`→`=`
 * - KeyBinding は macOS で効くもの(`mac` があればそれ・無ければ `key`)を読み、`shift` があれば Shift を足した組も見る。
 *   `Mod` / `Cmd` / `Meta`=Mod・`Ctrl` / `Control`=Ctrl・`Alt`=Alt・`Shift`=Shift(`Mod--` の最後の `-` はキー)
 *
 * ## 判断の記録(test-writer 2026-11-16)
 * - 「触っていない範囲の不変」(AC-74-33 後半)は文書モデルの取引で判定する(行の中の挿入・削除・複数行の貼り付け)。
 *   貼り付けで入る改行の綴り(dominant)は面の規則なので、ここでは**打った範囲の前後が byte 等価**だけを見る
 *   (接頭辞・接尾辞の一致)。改行の綴りは CodeEditor.wiring.test.ts
 * - 乱数は xorshift32(種 0x74_0001)で固定し、各フィクスチャに 40 箇所ずつ
 *
 * ## 修正前に赤になる理由
 * - `src/editor/code-keymap.ts` / `src/editor/text-document.ts` が無く、`@codemirror/*` も依存に無いので import で落ちる
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { KeyBinding } from '@codemirror/view';

import { CODE_KEYMAP } from './code-keymap';
import { createTextDocument, documentText, withState } from './text-document';

const REPO_ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// キーの正規化
// ---------------------------------------------------------------------------

type Combo = string; // "Alt+Mod+Shift:key" の形(修飾は辞書順)

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
	pageup: 'PageUp',
	pagedown: 'PageDown',
};

function normalizeKey(raw: string): string {
	const lower = raw.toLowerCase();
	if (KEY_NAMES[lower]) return KEY_NAMES[lower];
	return raw.length === 1 ? raw.toLowerCase() : raw;
}

function combo(mods: Iterable<string>, key: string): Combo {
	return [...new Set(mods)].sort().join('+') + ':' + normalizeKey(key);
}

/** `menu.rs` のアクセラレータ(`"CmdOrCtrl+Shift+F"` の形)を集めて正規化する。 */
function menuAccelerators(): Combo[] {
	const src = readFileSync(resolve(REPO_ROOT, 'src-tauri/src/menu.rs'), 'utf8');
	const out: Combo[] = [];
	for (const m of src.matchAll(/"((?:[A-Za-z]+\+)+[^"+\s]+)"/g)) {
		const literal = m[1]!;
		const parts = literal.split('+');
		const key = parts.pop()!;
		const mods = parts.map((p) => MOD_NAMES[p.toLowerCase()]);
		if (mods.some((x) => x === undefined)) continue; // 修飾でない語を含む(アクセラレータではない)
		out.push(combo(mods as string[], key));
	}
	return out;
}

/** CodeMirror のキー名(`Mod-Shift-z`・`Mod--`)を正規化する。 */
function cmCombo(name: string, extraShift = false): Combo {
	const parts = name.split(/-(?!$)/);
	const key = parts.pop()!;
	const mods = parts.map((p) => {
		const mod = MOD_NAMES[p.toLowerCase()];
		if (!mod) throw new Error(`unknown modifier in KeyBinding "${name}": ${p}`);
		return mod;
	});
	if (extraShift) mods.push('Shift');
	return combo(mods, key);
}

/** macOS で効く組(`mac` があればそれ・無ければ `key`。`shift` 付きの組も)。 */
function macCombos(binding: KeyBinding): Combo[] {
	const name = binding.mac ?? binding.key;
	if (!name) return [];
	const out = [cmCombo(name)];
	if (binding.shift) out.push(cmCombo(name, true));
	return out;
}

function allCombos(): Combo[] {
	return CODE_KEYMAP.flatMap((b) => macCombos(b));
}

/** 契約8 の Format の表+契約23 の raw のキー(macOS)。 */
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

/** 複数カーソル・要件75 の分割の案(第3段 3-3 で Option + 上下と Command + / は CODE_KEYMAP に入った=要件側更新・行の複製は入れない)。 */
const RESERVED_KEYS: Combo[] = [
	combo(['Mod'], 'd'),
	combo(['Mod', 'Shift'], 'd'),
	...['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map((k) => combo(['Mod', 'Alt'], k)),
	combo(['Shift', 'Alt'], 'ArrowUp'),
	combo(['Shift', 'Alt'], 'ArrowDown'),
];

// ---------------------------------------------------------------------------
// AC-74-33 前半 — キー割り当て
// ---------------------------------------------------------------------------

describe('前提: menu.rs のアクセラレータが集まる', () => {
	test('Save(Mod+s)・Find(Mod+f)・Reload File(Mod+r)・Zoom In(Mod+=)・Show All Tabs(Mod+Shift+\\) を含む', () => {
		const accels = menuAccelerators();
		expect(accels).toContain(combo(['Mod'], 's'));
		expect(accels).toContain(combo(['Mod'], 'f'));
		expect(accels).toContain(combo(['Mod'], 'r'));
		expect(accels).toContain(combo(['Mod'], '='));
		expect(accels).toContain(combo(['Mod', 'Shift'], '\\'));
		expect(accels.length).toBeGreaterThanOrEqual(20);
	});
});

describe('AC-74-33: CODE_KEYMAP は必要なキーを持つ', () => {
	test('配列で、各要素が key か mac と run を持つ', () => {
		expect(Array.isArray(CODE_KEYMAP)).toBe(true);
		expect(CODE_KEYMAP.length).toBeGreaterThan(0);
		for (const b of CODE_KEYMAP) {
			expect(typeof (b.key ?? b.mac), JSON.stringify(b)).toBe('string');
			expect(typeof b.run).toBe('function');
		}
	});

	test.each([
		['Enter', combo([], 'Enter')],
		['Tab', combo([], 'Tab')],
		['Shift-Tab', combo(['Shift'], 'Tab')],
		['Mod-z(undo)', combo(['Mod'], 'z')],
		['Mod-Shift-z(redo)', combo(['Mod', 'Shift'], 'z')],
		['ArrowLeft', combo([], 'ArrowLeft')],
		['ArrowRight', combo([], 'ArrowRight')],
		['ArrowUp', combo([], 'ArrowUp')],
		['ArrowDown', combo([], 'ArrowDown')],
		['Shift-ArrowLeft(選択)', combo(['Shift'], 'ArrowLeft')],
		['Shift-ArrowRight(選択)', combo(['Shift'], 'ArrowRight')],
	])('%s がある', (_label, want) => {
		expect(allCombos()).toContain(want);
	});

	test('行頭 / 行末がある(Home・End か Mod-ArrowLeft・Mod-ArrowRight)', () => {
		const combos = allCombos();
		const start = combos.includes(combo([], 'Home')) || combos.includes(combo(['Mod'], 'ArrowLeft'));
		const end = combos.includes(combo([], 'End')) || combos.includes(combo(['Mod'], 'ArrowRight'));
		expect(start, '行頭').toBe(true);
		expect(end, '行末').toBe(true);
	});
});

describe('AC-74-33: CODE_KEYMAP に入れないキー', () => {
	test('menu.rs の全アクセラレータと重ならない', () => {
		const mine = new Set(allCombos());
		const clashes = menuAccelerators().filter((a) => mine.has(a));
		expect(clashes, 'menu.rs のアクセラレータと同じキー').toEqual([]);
	});

	test('Format の表のキーと raw のキー(契約8・23)が無い', () => {
		const mine = new Set(allCombos());
		expect(FORMAT_KEYS.filter((k) => mine.has(k))).toEqual([]);
	});

	test('複数カーソル(Mod-d / Mod-Shift-d)・分割の案(Mod-Alt-矢印)・行の複製(Shift-Alt-上下)が無い(第3段 3-3: Alt-上下と Mod-/ は入る)', () => {
		const mine = new Set(allCombos());
		expect(RESERVED_KEYS.filter((k) => mine.has(k))).toEqual([]);
	});

	test('`@codemirror/search` の割り当て(Mod-f・Mod-g・Mod-Shift-g・Mod-Alt-g・F3)が無い', () => {
		const mine = new Set(allCombos());
		for (const k of [combo(['Mod'], 'f'), combo(['Mod'], 'g'), combo(['Mod', 'Shift'], 'g'), combo(['Mod', 'Alt'], 'g'), combo([], 'F3')]) {
			expect(mine.has(k), k).toBe(false);
		}
	});

	test('同じキーが二重に入っていない', () => {
		const combos = allCombos();
		expect(new Set(combos).size).toBe(combos.length);
	});
});

// ---------------------------------------------------------------------------
// AC-74-33 後半 — 触っていない範囲の不変(打鍵・削除・貼り付け)
// ---------------------------------------------------------------------------

const FIXTURES = resolve(REPO_ROOT, 'fixtures/editing');
const INVARIANCE_FIXTURES = [
	'lf.txt',
	'crlf.txt',
	'cr.txt',
	'mixed.txt',
	'bom-crlf.txt',
	'no-final-newline.txt',
	'indent-tabs.go',
	'indent-spaces.py',
	'indent-two-spaces.ts',
	'special-chars.txt',
	'settings.json',
	'sample.rs',
] as const;

function fixture(name: string): string {
	return readFileSync(resolve(FIXTURES, name), 'utf8');
}

/** xorshift32(種を固定)。 */
function rng(seed: number): () => number {
	let x = seed >>> 0 || 1;
	return () => {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		return x / 0x1_0000_0000;
	};
}

/** 原文を行(終端の改行を含む)に割る。 */
function splitKeepingEnds(content: string): string[] {
	const out: string[] = [];
	let start = 0;
	for (let i = 0; i < content.length; i++) {
		const c = content[i];
		if (c === '\r') {
			if (content[i + 1] === '\n') i++;
			out.push(content.slice(start, i + 1));
			start = i + 1;
		} else if (c === '\n') {
			out.push(content.slice(start, i + 1));
			start = i + 1;
		}
	}
	out.push(content.slice(start));
	return out;
}

function bodyLength(lineWithEnd: string): number {
	return lineWithEnd.replace(/\r\n$|\r$|\n$/u, '').length;
}

/** 行の中の位置(サロゲート対の間に落ちないように調整)。 */
function pickPosition(content: string, random: () => number): { lineNo: number; col: number; offset: number; bodyLen: number } {
	const lines = splitKeepingEnds(content);
	const lineNo = 1 + Math.floor(random() * lines.length);
	const bodyLen = bodyLength(lines[lineNo - 1]!);
	let col = Math.floor(random() * (bodyLen + 1));
	let offset = 0;
	for (let i = 0; i < lineNo - 1; i++) offset += lines[i]!.length;
	// サロゲート対の中には置かない(置けば文字が壊れる=原文の側の問題でなく位置の問題)。
	const code = content.charCodeAt(offset + col);
	if (code >= 0xdc00 && code <= 0xdfff) col -= 1;
	return { lineNo, col, offset: offset + col, bodyLen };
}

const DETERMINISTIC: Array<{ name: string; lineNo: number; col: number }> = [
	{ name: 'crlf.txt', lineNo: 1, col: 0 },
	{ name: 'crlf.txt', lineNo: 2, col: 4 },
	{ name: 'cr.txt', lineNo: 3, col: 1 },
	{ name: 'mixed.txt', lineNo: 2, col: 3 },
	{ name: 'mixed.txt', lineNo: 5, col: 4 },
	{ name: 'bom-crlf.txt', lineNo: 1, col: 0 },
	{ name: 'no-final-newline.txt', lineNo: 3, col: 3 },
	{ name: 'special-chars.txt', lineNo: 1, col: 5 },
	{ name: 'sample.rs', lineNo: 3, col: 8 },
	{ name: 'settings.json', lineNo: 4, col: 12 },
];

function openFixture(name: string) {
	return createTextDocument(fixture(name), { uri: `file:///p/${name}`, readOnly: false });
}

describe('AC-74-33 後半: 決め打ちの位置で、打った範囲の外が byte 等価', () => {
	test.each(DETERMINISTIC)('$name L$lineNo:$col 挿入', ({ name, lineNo, col }) => {
		const content = fixture(name);
		const doc = openFixture(name);
		const at = doc.state.doc.line(lineNo).from + col;
		const out = documentText(withState(doc, doc.state.update({ changes: { from: at, insert: 'typed' } }).state));
		const lines = splitKeepingEnds(content);
		const offset = lines.slice(0, lineNo - 1).reduce((n, l) => n + l.length, 0) + col;
		expect(out).toBe(content.slice(0, offset) + 'typed' + content.slice(offset));
	});

	test.each(DETERMINISTIC)('$name L$lineNo:$col 複数行の貼り付け → 前後が byte 等価', ({ name, lineNo, col }) => {
		const content = fixture(name);
		const doc = openFixture(name);
		const at = doc.state.doc.line(lineNo).from + col;
		const out = documentText(withState(doc, doc.state.update({ changes: { from: at, insert: 'p1\np2\np3' } }).state));
		const lines = splitKeepingEnds(content);
		const offset = lines.slice(0, lineNo - 1).reduce((n, l) => n + l.length, 0) + col;
		expect(out.startsWith(content.slice(0, offset)), '前が同じ').toBe(true);
		expect(out.endsWith(content.slice(offset)), '後ろが同じ').toBe(true);
		expect(out.length).toBeGreaterThan(content.length);
	});
});

describe('AC-74-33 後半: 乱数の種を固定した多数の位置(各フィクスチャ 40 箇所)', () => {
	test.each(INVARIANCE_FIXTURES)('%s: 挿入・削除・貼り付け', (name) => {
		const content = fixture(name);
		const random = rng(0x74_0001 ^ name.length);
		const doc = openFixture(name);
		for (let i = 0; i < 40; i++) {
			const p = pickPosition(content, random);
			const at = doc.state.doc.line(p.lineNo).from + p.col;
			// 挿入
			{
				const out = documentText(withState(doc, doc.state.update({ changes: { from: at, insert: 'Q' } }).state));
				expect(out, `${name} insert L${p.lineNo}:${p.col}`).toBe(content.slice(0, p.offset) + 'Q' + content.slice(p.offset));
			}
			// 削除(行の中の 1 文字=改行を跨がない)
			if (p.col < p.bodyLen) {
				const next = content.charCodeAt(p.offset);
				const width = next >= 0xd800 && next <= 0xdbff ? 2 : 1;
				const out = documentText(withState(doc, doc.state.update({ changes: { from: at, to: at + width } }).state));
				expect(out, `${name} delete L${p.lineNo}:${p.col}`).toBe(content.slice(0, p.offset) + content.slice(p.offset + width));
			}
			// 貼り付け(複数行)
			{
				const out = documentText(withState(doc, doc.state.update({ changes: { from: at, insert: 'a\nb\n' } }).state));
				expect(out.startsWith(content.slice(0, p.offset)), `${name} paste-prefix L${p.lineNo}:${p.col}`).toBe(true);
				expect(out.endsWith(content.slice(p.offset)), `${name} paste-suffix L${p.lineNo}:${p.col}`).toBe(true);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 要件74 第3段 3-3 — 行の移動とコメントの切り替え(AC-74-56・契約5 の (x)・契約15・由谷の決定 3-13・3-14)
//
// 確定契約: CODE_KEYMAP に `{ key: 'Alt-ArrowUp', run: moveLineUp }`・`{ key: 'Alt-ArrowDown', run: moveLineDown }`・`{ key: 'Mod-/', run: toggleComment }`
// (どれも @codemirror/commands=依存は増えない。包むなら同じ振る舞い)。効く面=コード・plain text・raw・code fence の埋め込み(同じ CODE_KEYMAP)。
// - 行の移動: 選択(複数行なら全部)を含む行を 1 行上 / 下と入れ替え、選択は行と一緒に動く。先頭の行で上・末尾の行で下は何もしない。
//   動かした行と入れ替わった行の改行は文書の主たる改行コード(契約15)、ほかの行は byte 等価。BOM は先頭のまま
// - コメント: その言語の commentTokens(行の注釈があれば行・無ければ囲み)。選んだ行が全部注釈なら外し、そうでなければ全部に付ける
//   (字下げのいちばん浅い桁)。2 回で byte 等価。言語の無いもの(plain text・graphql・makefile)と注釈の無い言語(JSON)では何もしない。
//   jsonc は `//`(3-14=`languageSupportFor('jsonc')` が commentTokens を上書き)。読み取り専用では何もしない。1 回ごとに undo 1 段
// jsdom では run を `{ state, dispatch }` で呼ぶ(moveLine / toggleComment は StateCommand)。
// ---------------------------------------------------------------------------

import type { EditorState as CMState } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import { undo as cmUndo, undoDepth as cmUndoDepth } from '@codemirror/commands';
import { languageSupportFor } from './code-languages';

function bindingFor(key: string): KeyBinding {
	const b = CODE_KEYMAP.find((x) => x.key === key);
	if (!b) throw new Error(`CODE_KEYMAP に ${key} が無い`);
	return b;
}
function runKey(key: string, state: CMState): { ok: boolean; next: CMState; dispatched: number } {
	let next = state;
	let dispatched = 0;
	const target = {
		state,
		dispatch: (tr: { state: CMState }) => {
			dispatched++;
			next = tr.state;
		},
	} as unknown as Parameters<NonNullable<KeyBinding['run']>>[0];
	const ok = bindingFor(key).run!(target);
	return { ok, next, dispatched };
}
function withCursor(state: CMState, pos: number, head = pos): CMState {
	return state.update({ selection: EditorSelection.range(pos, head) }).state;
}
async function openWithLanguage(src: string, langId: string | null, name = 'x.txt', readOnly = false) {
	const support = langId ? await languageSupportFor(langId) : null;
	return createTextDocument(src, { uri: `file:///Users/a/${name}`, readOnly, extensions: support ?? [] });
}
function undoCm(state: CMState): CMState {
	let next = state;
	cmUndo({ state, dispatch: (tr) => (next = tr.state) });
	return next;
}

describe('AC-74-56 (1): CODE_KEYMAP に Alt-ArrowUp・Alt-ArrowDown・Mod-/ がある(ほかは入れない)', () => {
	test('3 つの割り当てがあり run を持つ', () => {
		for (const k of ['Alt-ArrowUp', 'Alt-ArrowDown', 'Mod-/']) expect(typeof bindingFor(k).run, k).toBe('function');
	});
	test('Mod-d / Mod-Shift-d / Mod-Alt-矢印 / Shift-Alt-上下(行の複製)は無いまま・menu.rs と重ならない', () => {
		const mine = new Set(allCombos());
		expect(RESERVED_KEYS.filter((k) => mine.has(k))).toEqual([]);
		expect(menuAccelerators().filter((a) => mine.has(a))).toEqual([]);
	});
});

describe('AC-74-56 (2)(3)(5)(6): 行の移動(Option + 上 / 下)', () => {
	test('lf.txt: 2 行目で上 → 1 行目と入れ替わり、カーソルは同じ列で一緒に動く。undo 1 回で原文', () => {
		const src = fixture('lf.txt'); // alpha / beta gamma / \tdelta / ...
		const doc = openFixture('lf.txt');
		const line2 = doc.state.doc.line(2);
		const s0 = withCursor(doc.state, line2.from + 2);
		const { ok, next, dispatched } = runKey('Alt-ArrowUp', s0);
		expect(ok).toBe(true);
		expect(dispatched).toBe(1);
		expect(documentText(withState(doc, next))).toBe('beta gamma\nalpha\n\tdelta\n  epsilon\n\nzeta\n');
		expect(next.selection.main.head).toBe(2);
		expect(cmUndoDepth(next)).toBe(cmUndoDepth(s0) + 1);
		expect(documentText(withState(doc, undoCm(next)))).toBe(src);
	});

	test('先頭の行で上・末尾の行で下は何もしない(取引なし・文書は byte 等価)', () => {
		const src = fixture('crlf.txt');
		const doc = openFixture('crlf.txt');
		const up = runKey('Alt-ArrowUp', withCursor(doc.state, 1));
		expect(up.dispatched).toBe(0);
		expect(documentText(withState(doc, up.next))).toBe(src);
		const last = doc.state.doc.line(doc.state.doc.lines);
		const down = runKey('Alt-ArrowDown', withCursor(doc.state, last.from));
		expect(down.dispatched).toBe(0);
		expect(documentText(withState(doc, down.next))).toBe(src);
	});

	test('複数行の選択で下 → 選んだ行が全部まとまって 1 行下と入れ替わり、選択が付いていく(crlf.txt)', () => {
		const doc = openFixture('crlf.txt'); // alpha / beta gamma / \tdelta / "  epsilon" / "" / zeta
		const l1 = doc.state.doc.line(1);
		const l2 = doc.state.doc.line(2);
		const s0 = withCursor(doc.state, l1.from + 1, l2.from + 2); // alpha〜beta
		const { ok, next } = runKey('Alt-ArrowDown', s0);
		expect(ok).toBe(true);
		expect(documentText(withState(doc, next))).toBe('\tdelta\r\nalpha\r\nbeta gamma\r\n  epsilon\r\n\r\nzeta\r\n');
		const sel = next.selection.main;
		expect(next.doc.lineAt(sel.from).number).toBe(2);
		expect(next.doc.lineAt(sel.to).number).toBe(3);
		expect(next.doc.sliceString(sel.from, sel.to)).toBe('lpha\nbe');
	});

	test('mixed.txt: 動かした行と入れ替わった行の改行は主たる改行コード(CRLF)、ほかの行は byte 等価', () => {
		// one\r\n two\n three\r\n four\r\n five\r six\r\n(主=CRLF)
		const doc = openFixture('mixed.txt');
		const line2 = doc.state.doc.line(2); // two(\n で終わる)
		const { ok, next } = runKey('Alt-ArrowUp', withCursor(doc.state, line2.from));
		expect(ok).toBe(true);
		expect(documentText(withState(doc, next))).toBe('two\r\none\r\nthree\r\nfour\r\nfive\rsix\r\n');
		// five(\r)を下へ=five と six が入れ替わり、両方 CRLF。ほかは元のまま
		const doc2 = openFixture('mixed.txt');
		const line5 = doc2.state.doc.line(5);
		const r2 = runKey('Alt-ArrowDown', withCursor(doc2.state, line5.from + 1));
		expect(documentText(withState(doc2, r2.next))).toBe('one\r\ntwo\nthree\r\nfour\r\nsix\r\nfive\r\n');
	});

	test('cr.txt: 主たる改行が CR の文書では CR のまま', () => {
		const doc = openFixture('cr.txt');
		const line2 = doc.state.doc.line(2);
		const { next } = runKey('Alt-ArrowUp', withCursor(doc.state, line2.from));
		expect(documentText(withState(doc, next))).toBe('beta gamma\ralpha\r\tdelta\r  epsilon\r\rzeta\r');
	});

	test('bom-crlf.txt: BOM はファイルの先頭のまま(2 行目を上へ)', () => {
		const doc = openFixture('bom-crlf.txt'); // ﻿ title / body line
		const line2 = doc.state.doc.line(2);
		const { ok, next } = runKey('Alt-ArrowUp', withCursor(doc.state, line2.from));
		expect(ok).toBe(true);
		expect(documentText(withState(doc, next))).toBe('﻿body line\r\ntitle\r\n');
	});

	test('読み取り専用では何もしない', () => {
		const doc = createTextDocument('a\nb\n', { uri: 'file:///Users/a/ro.txt', readOnly: true });
		const r = runKey('Alt-ArrowUp', withCursor(doc.state, 2));
		expect(r.ok).toBe(false);
		expect(r.dispatched).toBe(0);
	});
});

describe('AC-74-56 (4)(5)(6): コメントの切り替え(Command + /)', () => {
	const LINE: Array<[string, string, string]> = [
		['typescript', 'a.ts', '// '],
		['rust', 'a.rs', '// '],
		['python', 'a.py', '# '],
		['shellscript', 'a.sh', '# '],
		['yaml', 'a.yaml', '# '],
		['toml', 'a.toml', '# '],
		['sql', 'a.sql', '-- '],
		['lua', 'a.lua', '-- '],
	];
	for (const [lang, name, token] of LINE) {
		test(`${lang}: 1 行に '${token}' が付き、もう 1 回で byte 等価に戻る(undo 1 段ずつ)`, async () => {
			const src = 'first line\nsecond line\n';
			const doc = await openWithLanguage(src, lang, name);
			const s0 = withCursor(doc.state, 3);
			const { ok, next, dispatched } = runKey('Mod-/', s0);
			expect(ok).toBe(true);
			expect(dispatched).toBe(1);
			expect(documentText(withState(doc, next))).toBe(`${token}first line\nsecond line\n`);
			expect(cmUndoDepth(next)).toBe(cmUndoDepth(s0) + 1);
			const again = runKey('Mod-/', next);
			expect(documentText(withState(doc, again.next))).toBe(src);
		});
	}

	test('CSS は囲みの注釈 /* */、HTML(svelte の文法)は <!-- -->。もう 1 回で戻る', async () => {
		const css = await openWithLanguage('color: red;\n', 'css', 'a.css');
		const c1 = runKey('Mod-/', withCursor(css.state, 2));
		expect(documentText(withState(css, c1.next))).toBe('/* color: red; */\n');
		expect(documentText(withState(css, runKey('Mod-/', c1.next).next))).toBe('color: red;\n');

		const html = await openWithLanguage('<div></div>\n', 'svelte', 'a.svelte');
		const h1 = runKey('Mod-/', withCursor(html.state, 2));
		expect(documentText(withState(html, h1.next))).toBe('<!-- <div></div> -->\n');
		expect(documentText(withState(html, runKey('Mod-/', h1.next).next))).toBe('<div></div>\n');
	});

	test('複数行の選択は全部に付き、字下げのいちばん浅い桁。全部が注釈なら外す', async () => {
		const src = '  if (x) {\n    y();\n  }\n';
		const doc = await openWithLanguage(src, 'typescript', 'a.ts');
		const s0 = withCursor(doc.state, 0, src.length - 1);
		const { next } = runKey('Mod-/', s0);
		expect(documentText(withState(doc, next))).toBe('  // if (x) {\n  //   y();\n  // }\n');
		const back = runKey('Mod-/', next);
		expect(documentText(withState(doc, back.next))).toBe(src);
	});

	test('一部だけ注釈の複数行は全部に付く', async () => {
		const src = '// a\nb\n';
		const doc = await openWithLanguage(src, 'typescript', 'a.ts');
		const { next } = runKey('Mod-/', withCursor(doc.state, 0, src.length - 1));
		expect(documentText(withState(doc, next))).toBe('// // a\n// b\n');
	});

	test('CRLF の文書でも注釈の記号だけが入り、改行は byte 等価', async () => {
		const src = 'const a = 1;\r\nconst b = 2;\r\n';
		const doc = await openWithLanguage(src, 'typescript', 'a.ts');
		const { next } = runKey('Mod-/', withCursor(doc.state, 0));
		expect(documentText(withState(doc, next))).toBe('// const a = 1;\r\nconst b = 2;\r\n');
	});

	test('jsonc は // が付く(3-14)。JSON は何もしない(取引なし)', async () => {
		const jsonc = await openWithLanguage('{"a": 1}\n', 'jsonc', 'tsconfig.jsonc');
		const r = runKey('Mod-/', withCursor(jsonc.state, 1));
		expect(r.ok).toBe(true);
		expect(documentText(withState(jsonc, r.next))).toBe('// {"a": 1}\n');
		const json = await openWithLanguage('{"a": 1}\n', 'json', 'a.json');
		const j = runKey('Mod-/', withCursor(json.state, 1));
		expect(j.dispatched).toBe(0);
		expect(documentText(withState(json, j.next))).toBe('{"a": 1}\n');
	});

	test('言語の無いもの(plain text・graphql・makefile)では何もしない', async () => {
		for (const [lang, name] of [
			[null, 'memo.txt'],
			['graphql', 'q.graphql'],
			['makefile', 'Makefile'],
		] as Array<[string | null, string]>) {
			const doc = await openWithLanguage('hello\n', lang, name);
			const r = runKey('Mod-/', withCursor(doc.state, 1));
			expect(r.dispatched, name).toBe(0);
			expect(documentText(withState(doc, r.next)), name).toBe('hello\n');
		}
	});

	test('読み取り専用では何もしない', async () => {
		const doc = await openWithLanguage('a\n', 'typescript', 'a.ts', true);
		const r = runKey('Mod-/', withCursor(doc.state, 0));
		expect(r.ok).toBe(false);
		expect(r.dispatched).toBe(0);
	});
});
