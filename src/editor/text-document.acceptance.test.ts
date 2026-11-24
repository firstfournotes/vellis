/**
 * 要件#74 第1段の受け入れテスト(docs/requirements/req-74.md)— 文書モデル(text)
 * (AC-74-1(第1段の分)・AC-74-32・契約 2・15・契約19 の「第1段の作り」3。unit プロジェクト・DOM なし)
 *
 * コードのファイルと plain text の文書モデル `src/editor/text-document.ts` を実体で判定する。
 * `@codemirror/state` は DOM 無しで動くので、打鍵は `EditorState` の取引として当てる。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする名前。推奨名は req-74.md 契約19「第1段の作り」3)
 *
 * ```ts
 * // --- src/editor/text-document.ts(新規・純関数・DOM なし)
 * import type { EditorState } from '@codemirror/state';
 * export type LineEnding = '\n' | '\r\n' | '\r';
 * export interface TextDocument {
 *   readonly uri: string;
 *   readonly readOnly: boolean;
 *   /** CodeMirror の文書(履歴の拡張を含む)。 *\/
 *   readonly state: EditorState;
 *   /** 基準の版(最後にディスクと揃えた文字列)。 *\/
 *   readonly base: string;
 *   /** contentHash(base)(保存の照合に渡す `expectedHash`=契約14)。 *\/
 *   readonly baseHash: string;
 *   readonly lineEnding: { dominant: LineEnding; mixed: boolean };
 *   readonly indentUnit: string;
 * }
 * export function createTextDocument(content: string, opts: { uri: string; readOnly: boolean }): TextDocument;
 * /** 取り出し。原文を byte のまま返す(CRLF・CR・混在・BOM をそのまま)。 *\/
 * export function documentText(doc: TextDocument): string;
 * /** 取引を当てた後の文書(state だけ替える・base は変えない)。 *\/
 * export function withState(doc: TextDocument, state: EditorState): TextDocument;
 * /** dirty = isDirty(documentText(doc), doc.base)(`$lib/document-edit` の isDirty=byte 比較)。 *\/
 * export function isDocumentDirty(doc: TextDocument): boolean;
 * /** 改行コードの検出。数が同じなら '\n'。1 つも無ければ { dominant: '\n', mixed: false }。 *\/
 * export function detectLineEnding(content: string): { dominant: LineEnding; mixed: boolean };
 * /** 字下げの単位(行頭の字下げから。タブか空白 N 個。決められなければ '\t')。 *\/
 * export function detectIndentUnit(content: string): string;
 * ```
 *
 * 文書モデルは CodeMirror の既定(`\r\n` を 1 つの改行として読み `\n` で繋ぐ)に頼らない(契約15)。
 * **実現の方法は実装裁量**(`EditorState.lineSeparator`・CR を行の中の文字として持つ、など)なので、本テストは
 * 取引の位置を `state.doc.line(n).from` から作り(行の中の文字の挿入・削除)、取り出した文字列だけを見る。
 *
 * ## 判断の記録(test-writer 2026-11-16)
 * - `withState` を契約に足した(10-10 の推奨名には無い)。取引を当てた後の `documentText` を DOM 無しで判定するには、
 *   state を替えた文書を作る口が要る。面(CodeEditor.svelte)が同じ関数を使う必要はない
 * - 改行を含む挿入(Enter・貼り付け)は面の側の規則(契約15「新しく入れる改行は dominant」)なので、ここでは
 *   行の中の文字だけを当て、Enter と貼り付けは `CodeEditor.wiring.test.ts` で判定する
 * - `contentHash` の表は Rust の `content_hash`(acceptance_req74.rs の AC-74-16)と同じ値を両側で固定する
 *
 * ## 修正前に赤になる理由
 * - `src/editor/text-document.ts` が無く、`@codemirror/state` も依存に無いので import で落ちる(全ケースが赤)。
 *   `contentHash` の表のケースだけは既存の `$lib/document-edit` を見るので実装前から緑(Rust 側の表の対)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { EditorState } from '@codemirror/state';
import { redo, undo, undoDepth } from '@codemirror/commands';

import { contentHash } from '$lib/document-edit';
import {
	createTextDocument,
	detectIndentUnit,
	detectLineEnding,
	documentText,
	isDocumentDirty,
	replaceWith,
	withState,
	type TextDocument,
} from './text-document';

const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURES = resolve(REPO_ROOT, 'fixtures/editing');

function fixture(name: string): string {
	return readFileSync(resolve(FIXTURES, name), 'utf8');
}

/** AC-74-1 の一覧(req-74.md「フィクスチャ」の第1段の分)。 */
const TEXT_FIXTURES = [
	'lf.txt',
	'crlf.txt',
	'cr.txt',
	'mixed.txt',
	'bom-crlf.txt',
	'no-final-newline.txt',
	'empty.txt',
	'indent-tabs.go',
	'indent-spaces.py',
	'indent-two-spaces.ts',
	'special-chars.txt',
	'long-line.log',
	'settings.json',
	'sample.rs',
	'query.graphql',
] as const;

function open(name: string, readOnly = false): TextDocument {
	return createTextDocument(fixture(name), { uri: `file:///Users/a/project/${name}`, readOnly });
}

/** 原文を行(終端の改行を含む)に割る。文書モデルの行と 1 対 1 に対応する前提で位置を写す。 */
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

/** 原文の `lineNo`(1 起点)行目の本文(改行を除く)の `col` 文字目の、原文全体でのオフセット。 */
function originalOffset(content: string, lineNo: number, col: number): number {
	const lines = splitKeepingEnds(content);
	let offset = 0;
	for (let i = 0; i < lineNo - 1; i++) offset += lines[i]!.length;
	return offset + col;
}

/** 行の本文(改行を除く)の長さ。 */
function lineBodyLength(content: string, lineNo: number): number {
	return splitKeepingEnds(content)[lineNo - 1]!.replace(/\r\n|\r|\n$/u, '').length;
}

// ---------------------------------------------------------------------------
// AC-74-1(第1段の分)— 原文の往復(契約 2・15)
// ---------------------------------------------------------------------------

describe('AC-74-1: createTextDocument → documentText の往復が byte で一致する(編集なし)', () => {
	test.each(TEXT_FIXTURES)('%s', (name) => {
		const content = fixture(name);
		const doc = open(name);
		expect(documentText(doc)).toBe(content);
		expect(doc.base).toBe(content);
		expect(doc.baseHash).toBe(contentHash(content));
		expect(doc.uri).toBe(`file:///Users/a/project/${name}`);
		expect(doc.readOnly).toBe(false);
	});

	test('開いた直後は dirty でない(すべてのフィクスチャ)', () => {
		for (const name of TEXT_FIXTURES) {
			expect(isDocumentDirty(open(name)), name).toBe(false);
		}
	});

	test('readOnly は opts のまま持つ(SSH root=契約 3・4)', () => {
		const doc = createTextDocument('x\n', { uri: 'ssh://host/srv/a.txt', readOnly: true });
		expect(doc.readOnly).toBe(true);
		expect(documentText(doc)).toBe('x\n');
	});

	test('開いた直後の undo の段数は 0(履歴は文書モデルに付く=契約11)', () => {
		expect(undoDepth(open('lf.txt').state)).toBe(0);
	});

	test('withState は state だけを替え、base・baseHash・uri・lineEnding・indentUnit は変えない', () => {
		const doc = open('crlf.txt');
		const next = doc.state.update({ changes: { from: 0, insert: 'X' } }).state;
		const edited = withState(doc, next);
		expect(edited.state).toBe(next);
		expect(edited.base).toBe(doc.base);
		expect(edited.baseHash).toBe(doc.baseHash);
		expect(edited.uri).toBe(doc.uri);
		expect(edited.lineEnding).toEqual(doc.lineEnding);
		expect(edited.indentUnit).toBe(doc.indentUnit);
		expect(documentText(edited)).toBe('X' + fixture('crlf.txt'));
		expect(isDocumentDirty(edited)).toBe(true);
		// 元の文書は不変(純関数)。
		expect(documentText(doc)).toBe(fixture('crlf.txt'));
	});
});

// ---------------------------------------------------------------------------
// 契約 2 — dirty は文字列の比較(打って戻したら dirty でない)
// ---------------------------------------------------------------------------

describe('契約2: dirty は取引の有無でなく文字列の比較で決まる', () => {
	test('1 文字打って消すと dirty でない', () => {
		const doc = open('lf.txt');
		const typed = withState(doc, doc.state.update({ changes: { from: 0, insert: 'Q' } }).state);
		expect(isDocumentDirty(typed)).toBe(true);
		const reverted = withState(typed, typed.state.update({ changes: { from: 0, to: 1, insert: '' } }).state);
		expect(isDocumentDirty(reverted)).toBe(false);
		expect(documentText(reverted)).toBe(fixture('lf.txt'));
	});

	test('空の文書に打つと dirty・消すと戻る', () => {
		const doc = open('empty.txt');
		const typed = withState(doc, doc.state.update({ changes: { from: 0, insert: 'a' } }).state);
		expect(documentText(typed)).toBe('a');
		expect(isDocumentDirty(typed)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 契約 15 — detectLineEnding / detectIndentUnit(値固定表)
// ---------------------------------------------------------------------------

describe('契約15: detectLineEnding', () => {
	const table: Array<{ name: string; content: string; dominant: '\n' | '\r\n' | '\r'; mixed: boolean }> = [
		{ name: 'LF だけ', content: 'a\nb\nc\n', dominant: '\n', mixed: false },
		{ name: 'CRLF だけ', content: 'a\r\nb\r\n', dominant: '\r\n', mixed: false },
		{ name: 'CR だけ', content: 'a\rb\rc', dominant: '\r', mixed: false },
		{ name: '改行なし', content: 'abc', dominant: '\n', mixed: false },
		{ name: '空', content: '', dominant: '\n', mixed: false },
		{ name: '混在(CRLF が多い)', content: 'a\r\nb\r\nc\nd\r\n', dominant: '\r\n', mixed: true },
		{ name: '混在(LF が多い)', content: 'a\nb\nc\r\n', dominant: '\n', mixed: true },
		{ name: '混在(CR が多い)', content: 'a\rb\rc\n', dominant: '\r', mixed: true },
		{ name: '数が同じ(LF 1・CRLF 1)→ LF', content: 'a\nb\r\n', dominant: '\n', mixed: true },
		{ name: '数が同じ(CR 1・CRLF 1)→ LF', content: 'a\rb\r\n', dominant: '\n', mixed: true },
		{ name: 'BOM 付き CRLF', content: '﻿a\r\nb\r\n', dominant: '\r\n', mixed: false },
	];

	test.each(table)('$name', ({ content, dominant, mixed }) => {
		expect(detectLineEnding(content)).toEqual({ dominant, mixed });
	});

	test('フィクスチャの実測(mixed.txt=CRLF 4・LF 1・CR 1)', () => {
		expect(detectLineEnding(fixture('mixed.txt'))).toEqual({ dominant: '\r\n', mixed: true });
		expect(detectLineEnding(fixture('crlf.txt'))).toEqual({ dominant: '\r\n', mixed: false });
		expect(detectLineEnding(fixture('cr.txt'))).toEqual({ dominant: '\r', mixed: false });
		expect(detectLineEnding(fixture('lf.txt'))).toEqual({ dominant: '\n', mixed: false });
		expect(open('mixed.txt').lineEnding).toEqual({ dominant: '\r\n', mixed: true });
	});
});

describe('契約5・19-3: detectIndentUnit', () => {
	const table: Array<{ name: string; content: string; unit: string }> = [
		{ name: 'タブ', content: 'a\n\tb\n\t\tc\n', unit: '\t' },
		{ name: '空白 4', content: 'a\n    b\n        c\n', unit: '    ' },
		{ name: '空白 2', content: 'a\n  b\n    c\n', unit: '  ' },
		{ name: '字下げが無い → タブ', content: 'a\nb\nc\n', unit: '\t' },
		{ name: '空 → タブ', content: '', unit: '\t' },
		{ name: 'タブと空白が混ざる(タブの行が多い)', content: '\ta\n\tb\n  c\n', unit: '\t' },
		{ name: 'タブと空白が混ざる(空白の行が多い)', content: '  a\n  b\n\tc\n', unit: '  ' },
	];

	test.each(table)('$name', ({ content, unit }) => {
		expect(detectIndentUnit(content)).toBe(unit);
	});

	test('フィクスチャの実測', () => {
		expect(detectIndentUnit(fixture('indent-tabs.go'))).toBe('\t');
		expect(detectIndentUnit(fixture('indent-spaces.py'))).toBe('    ');
		expect(detectIndentUnit(fixture('indent-two-spaces.ts'))).toBe('  ');
		expect(open('indent-spaces.py').indentUnit).toBe('    ');
	});
});

// ---------------------------------------------------------------------------
// AC-74-32 — 改行コード(契約15): 行の中の挿入・削除で、触っていない改行コードがそのまま
// ---------------------------------------------------------------------------

describe('AC-74-32: 行の中に打っても触っていない改行コードがそのまま残る', () => {
	const cases: Array<{ name: string; lineNo: number; col: number }> = [
		{ name: 'crlf.txt', lineNo: 2, col: 4 },
		{ name: 'lf.txt', lineNo: 2, col: 4 },
		{ name: 'cr.txt', lineNo: 2, col: 4 },
		{ name: 'mixed.txt', lineNo: 2, col: 1 },
		{ name: 'mixed.txt', lineNo: 5, col: 2 },
		{ name: 'bom-crlf.txt', lineNo: 2, col: 0 },
		{ name: 'no-final-newline.txt', lineNo: 3, col: 3 },
		{ name: 'special-chars.txt', lineNo: 3, col: 11 },
	];

	test.each(cases)('$name の $lineNo 行目 $col 文字目に 1 文字挿入', ({ name, lineNo, col }) => {
		const content = fixture(name);
		const doc = open(name);
		const line = doc.state.doc.line(lineNo);
		const typed = withState(doc, doc.state.update({ changes: { from: line.from + col, insert: 'Z' } }).state);
		const at = originalOffset(content, lineNo, col);
		expect(documentText(typed)).toBe(content.slice(0, at) + 'Z' + content.slice(at));
	});

	test.each(cases.filter((c) => c.col > 0))('$name の $lineNo 行目 $col 文字目の直前を 1 文字削除', ({
		name,
		lineNo,
		col,
	}) => {
		const content = fixture(name);
		const doc = open(name);
		const line = doc.state.doc.line(lineNo);
		const edited = withState(doc, doc.state.update({ changes: { from: line.from + col - 1, to: line.from + col } }).state);
		const at = originalOffset(content, lineNo, col);
		expect(documentText(edited)).toBe(content.slice(0, at - 1) + content.slice(at));
	});

	test('文書モデルの行数は原文の改行の数+1(CRLF・CR・混在でも行が割れない・増えない)', () => {
		for (const name of ['lf.txt', 'crlf.txt', 'cr.txt', 'mixed.txt', 'bom-crlf.txt', 'no-final-newline.txt']) {
			const content = fixture(name);
			const doc = open(name);
			expect(doc.state.doc.lines, name).toBe(splitKeepingEnds(content).length);
			// 各行の本文の長さも原文と同じ(改行の文字が行の中に漏れていない・行末の文字が削れていない)。
			for (let n = 1; n <= doc.state.doc.lines; n++) {
				expect(doc.state.doc.line(n).text.length, `${name} L${n}`).toBe(lineBodyLength(content, n));
			}
		}
	});

	test('CRLF の文書で 1 文字打って取り出すと \\r\\n がすべて残り、\\n だけの改行が 1 つも生まれない', () => {
		const doc = open('crlf.txt');
		const typed = withState(doc, doc.state.update({ changes: { from: doc.state.doc.line(1).to, insert: '!' } }).state);
		const out = documentText(typed);
		expect(out.match(/\r\n/g)?.length).toBe(fixture('crlf.txt').match(/\r\n/g)!.length);
		expect(out.replace(/\r\n/g, '')).not.toContain('\n');
		expect(out.replace(/\r\n/g, '')).not.toContain('\r');
	});

	test('CR だけの文書で 1 文字打って取り出すと \\r だけが残る', () => {
		const doc = open('cr.txt');
		const typed = withState(doc, doc.state.update({ changes: { from: doc.state.doc.line(3).from, insert: '!' } }).state);
		const out = documentText(typed);
		expect(out).not.toContain('\n');
		expect(out.match(/\r/g)?.length).toBe(fixture('cr.txt').match(/\r/g)!.length);
	});

	test('文書モデルは CodeMirror の既定(\\n で繋ぐ)に頼っていない=CRLF の文書の documentText は state.doc.toString() と違う', () => {
		const doc = open('crlf.txt');
		// 既定のまま(`lineSeparator` なしで CR を落とす作り)なら toString() は LF 区切りになり、往復で CRLF が消える。
		// どんな持ち方でも、取り出しは原文に戻ること(上の往復)が本体。ここはそれが「既定の toString の写し」では
		// 成り立たないことを示す対照。
		expect(documentText(doc)).toBe(fixture('crlf.txt'));
		expect(documentText(doc)).not.toBe(fixture('crlf.txt').replace(/\r\n/g, '\n'));
	});
});

// ---------------------------------------------------------------------------
// AC-74-16 の表(フロント側)— contentHash の値固定(Rust の content_hash と同じ値)
// ---------------------------------------------------------------------------

/**
 * 同じ表を `src-tauri/tests/acceptance_req74.rs` の AC-74-16 が `content_hash` に当てる。片方だけを直すと
 * 保存の照合(契約14)がすべて衝突になるので、両側を同じコミットで直す。
 */
export const CONTENT_HASH_TABLE: ReadonlyArray<{ name: string; input: string; hash: string }> = [
	{ name: 'empty', input: '', hash: '0-ztntfp-45h' },
	{ name: 'ascii', input: 'abc', hash: '3-7aigaz-3772q3' },
	{ name: 'japanese', input: '日本語のテキスト\n', hash: '9-mdn3tu-iq79uo' },
	{ name: 'surrogate', input: 'a😀b', hash: '4-13waept-zlbdid' },
	{ name: 'crlf', input: 'line one\r\nline two\r\n', hash: 'k-1oi56o7-2or8vz' },
	{ name: 'bom', input: '﻿bom', hash: '4-1nrhob8-29w4w2' },
	{ name: 'longx', input: 'x'.repeat(100_000), hash: '255s-3s8zlx-vloc1x' },
];

describe('AC-74-16(表のフロント側): contentHash の値は Rust の content_hash と同じ表で固定', () => {
	test.each(CONTENT_HASH_TABLE)('$name', ({ input, hash }) => {
		expect(contentHash(input)).toBe(hash);
	});

	test('文書モデルの baseHash はこの contentHash', () => {
		for (const { input, hash } of CONTENT_HASH_TABLE) {
			expect(createTextDocument(input, { uri: 'file:///a.txt', readOnly: false }).baseHash).toBe(hash);
		}
	});
});

// ---------------------------------------------------------------------------
// 前提の確認 — @codemirror/state が DOM 無しで取引を当てられる(テストの土台)
// ---------------------------------------------------------------------------

describe('前提: @codemirror/state は DOM 無しで取引を当てられる', () => {
	test('EditorState.create → update → doc.toString()', () => {
		const state = EditorState.create({ doc: 'a\nb' });
		expect(state.update({ changes: { from: 1, insert: 'X' } }).state.doc.toString()).toBe('aX\nb');
	});
});

// ---------------------------------------------------------------------------
// 変異の生き残りを締める(2026-11-16・test-runner の変異テスト M5・M6・M8)
// ---------------------------------------------------------------------------

/** `EditorState` に `undo` / `redo` のコマンドを DOM 無しで当てる。 */
function runCommand(state: EditorState, command: typeof undo): EditorState {
	let next = state;
	const ran = command({ state, dispatch: (tr) => (next = tr.state) });
	expect(ran, 'command ran').toBe(true);
	return next;
}

describe('AC-74-32(M5): 少数派の改行そのものを消すと、隣の文字が改行に化けない', () => {
	// mixed.txt = one\r\n two\n three\r\n four\r\n five\r six\r\n(dominant=CRLF。LF と CR が少数派)
	test('2 行目の LF(少数派)を消す → "twothree" が繋がり、ほかの改行はそのまま', () => {
		const mixed = fixture('mixed.txt');
		const doc = open('mixed.txt');
		const line2 = doc.state.doc.line(2);
		const edited = withState(doc, doc.state.update({ changes: { from: line2.to, to: line2.to + 1 }, userEvent: 'delete.backward' }).state);
		expect(documentText(edited)).toBe('one\r\ntwothree\r\nfour\r\nfive\rsix\r\n');
		expect(documentText(edited)).toBe(mixed.replace('two\n', 'two'));
	});

	test('5 行目の CR(少数派)を消す → "fivesix" が繋がる', () => {
		const doc = open('mixed.txt');
		const line5 = doc.state.doc.line(5);
		const edited = withState(doc, doc.state.update({ changes: { from: line5.to, to: line5.to + 1 }, userEvent: 'delete.forward' }).state);
		expect(documentText(edited)).toBe('one\r\ntwo\nthree\r\nfour\r\nfivesix\r\n');
	});

	test('少数派の改行を含む範囲を消す(行末の 1 文字+改行)→ 範囲の外が byte 等価', () => {
		const mixed = fixture('mixed.txt');
		const doc = open('mixed.txt');
		const line2 = doc.state.doc.line(2);
		const edited = withState(doc, doc.state.update({ changes: { from: line2.to - 1, to: line2.to + 1 } }).state);
		expect(documentText(edited)).toBe(mixed.replace('two\n', 'tw'));
	});

	test('少数派の改行の直前に打っても、改行の綴りは動かない', () => {
		const mixed = fixture('mixed.txt');
		const doc = open('mixed.txt');
		const line2 = doc.state.doc.line(2);
		const edited = withState(doc, doc.state.update({ changes: { from: line2.to, insert: 'X' } }).state);
		expect(documentText(edited)).toBe(mixed.replace('two\n', 'twoX\n'));
	});
});

describe('AC-74-11 / 32(M6): 消した少数派の改行は undo で元の綴りに戻る(主たる改行に化けない)', () => {
	test('LF を消して undo → 原文と byte 等価。redo → 消えた状態', () => {
		const mixed = fixture('mixed.txt');
		const doc = open('mixed.txt');
		const line2 = doc.state.doc.line(2);
		const deleted = doc.state.update({ changes: { from: line2.to, to: line2.to + 1 }, userEvent: 'delete.backward' }).state;
		expect(documentText(withState(doc, deleted))).toBe(mixed.replace('two\n', 'two'));
		const undone = runCommand(deleted, undo);
		expect(documentText(withState(doc, undone))).toBe(mixed);
		expect(isDocumentDirty(withState(doc, undone))).toBe(false);
		const redone = runCommand(undone, redo);
		expect(documentText(withState(doc, redone))).toBe(mixed.replace('two\n', 'two'));
	});

	test('CR を消して undo → 原文と byte 等価', () => {
		const mixed = fixture('mixed.txt');
		const doc = open('mixed.txt');
		const line5 = doc.state.doc.line(5);
		const deleted = doc.state.update({ changes: { from: line5.to, to: line5.to + 1 }, userEvent: 'delete.forward' }).state;
		expect(documentText(withState(doc, runCommand(deleted, undo)))).toBe(mixed);
	});

	test('LF だけの文書(少数派が CRLF)で CRLF を消して undo → 原文と byte 等価', () => {
		const content = 'a\nb\r\nc\nd\n'; // dominant=LF・2 行目の CRLF が少数派
		const doc = createTextDocument(content, { uri: 'file:///a.txt', readOnly: false });
		const line2 = doc.state.doc.line(2);
		const deleted = doc.state.update({ changes: { from: line2.to, to: line2.to + 1 }, userEvent: 'delete.backward' }).state;
		expect(documentText(withState(doc, deleted))).toBe('a\nbc\nd\n');
		expect(documentText(withState(doc, runCommand(deleted, undo)))).toBe(content);
	});

	test('複数の少数派の改行を 1 つの取引で消して undo → 全部が元の綴り', () => {
		const mixed = fixture('mixed.txt');
		const doc = open('mixed.txt');
		const line2 = doc.state.doc.line(2);
		const line5 = doc.state.doc.line(5);
		const deleted = doc.state.update({
			changes: [
				{ from: line2.to, to: line2.to + 1 },
				{ from: line5.to, to: line5.to + 1 },
			],
			userEvent: 'delete',
		}).state;
		expect(documentText(withState(doc, deleted))).toBe('one\r\ntwothree\r\nfour\r\nfivesix\r\n');
		expect(documentText(withState(doc, runCommand(deleted, undo)))).toBe(mixed);
	});
});

describe('AC-74-13 / 32(M8): 外部変更の取り込み(replaceWith)で混在の文書の少数派の改行が主たる改行に化けない', () => {
	function applied(doc: TextDocument, target: string): string {
		return documentText(withState(doc, doc.state.update(replaceWith(doc.state, target)).state));
	}

	test('文字だけが変わった届いた内容 → documentText が届いた内容と byte 等価(LF・CR の行がそのまま)', () => {
		const mixed = fixture('mixed.txt');
		const doc = open('mixed.txt');
		const target = mixed.replace('two\n', 'TWO\n').replace('five\r', 'FIVE\r');
		expect(applied(doc, target)).toBe(target);
	});

	test('届いた内容が改行の綴りを変えた(3 行目の CRLF → LF)→ その綴りが入る', () => {
		const mixed = fixture('mixed.txt');
		const doc = open('mixed.txt');
		const target = mixed.replace('three\r\n', 'three\n');
		expect(applied(doc, target)).toBe(target);
	});

	test('先頭に行が足された届いた内容 → 後ろの少数派の改行が位置ごと保たれる', () => {
		const mixed = fixture('mixed.txt');
		const doc = open('mixed.txt');
		const target = 'zero\r\n' + mixed;
		expect(applied(doc, target)).toBe(target);
	});

	test('LF の文書に CRLF 混じりの内容が届いた → 届いた綴りのまま', () => {
		const doc = open('lf.txt');
		const target = fixture('lf.txt').replace('beta gamma\n', 'beta gamma\r\n');
		expect(applied(doc, target)).toBe(target);
	});
});
