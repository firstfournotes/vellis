/**
 * 要件#74 第2段 2-2 の受け入れテスト(docs/requirements/req-74.md)— 装飾のコマンドと Format の配線の純関数・閾値
 * (AC-74-8 の純関数の分・AC-74-11(コマンド 1 回=undo 1 段)・AC-74-22 の定数・契約8・10・11・18。
 *  第2段の作り(案)の項目 7・10・11・21。unit プロジェクト・DOM なし)
 *
 * ## 仮の前提(由谷の確認待ち=「第2段の準備で出た判断」1〜3・5・7・8 を推奨と仮定。違えばこのファイルは捨てる)
 * - 判断 1〜3(2-1 と同じ)。判断 3 により Bulleted / Numbered / Task List・Indent は `prosemirror-schema-list`
 * - 判断 8: 閾値= 2 MiB(`MARKDOWN_EDIT_LIMIT_BYTES`)
 * - 判断 4(Format の並び)は Rust のメニュー(2-3)の話で、ここでは ID の集合だけを固定する
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 第2段の作り(案)7・10・11・21。無いものは test-writer が固定)
 *
 * ```ts
 * // --- src/editor/commands.ts(新規・純関数)
 * export const FORMAT_ITEM_IDS: readonly FormatItemId[];   // 項目 10 の表の ID 全部(27 個)
 * export type FormatItemId = 'format-bold' | 'format-italic' | 'format-strikethrough' | 'format-inline-code' | 'format-link'
 *   | 'format-body-text' | 'format-heading-1' | … | 'format-heading-6' | 'format-bulleted-list' | 'format-numbered-list' | 'format-task-list'
 *   | 'format-quote' | 'format-code-block' | 'format-alert-note' | 'format-alert-tip' | 'format-alert-important' | 'format-alert-warning'
 *   | 'format-alert-caution' | 'format-indent' | 'format-outdent' | 'format-insert-table' | 'format-insert-rule' | 'format-insert-footnote'
 *   | 'format-insert-image' | 'format-clear';
 * export const FORMAT_COMMANDS: Record<FormatItemId, Command>;   // Command = prosemirror-state の (state, dispatch?, view?) => boolean。取引 1 つ=undo 1 段
 * //   format-link / format-insert-image は入力欄・ダイアログを出す面の仕事なので、Command は「リンクの mark を外す(リンクの中)・
 * //   それ以外は false」/「false」でよい(面の側=MarkdownEditor が入力欄を出す)
 * export const MENU_FORMAT_EVENT = 'menu_format';           // lib.rs が前面の窓へ送るイベント(payload=項目の ID)
 * /** Format のイベントの受け手(契約8): handle が Markdown の編集面(kind 'markdown'・raw でない・readOnly でない)のときだけ
 *  *  FORMAT_COMMANDS[id](view.state, view.dispatch, view) を当てて true。raw・コード(kind 'text')・読み取り専用・null では
 *  *  何もせず false。view.composing の間は控え、compositionend の後に 1 回だけ当てる(返り値は false)。 *\/
 * export function runFormatCommand(id: FormatItemId, handle: FileEditorHandle | null): boolean;
 *
 * // --- src/editor/markdown-limits.ts(新規)
 * export const MARKDOWN_EDIT_LIMIT_BYTES = 2 * 1024 * 1024;
 * export function markdownTooLarge(content: string): boolean;   // UTF-8 の byte 数が MARKDOWN_EDIT_LIMIT_BYTES を超える(ちょうどは false)
 *
 * // --- src/routes/+page.svelte(ソース走査)
 * // listen(MENU_FORMAT_EVENT, (e) => { if (rootPicker.open) return; runFormatCommand(e.payload, windowState.fileEditor); })
 * //   … 受け手の中で `rootPicker.open`(Dashboard=契約16)を見てから `runFormatCommand(` に `windowState.fileEditor` を渡す
 * ```
 *
 * ## 修正前に赤になる理由
 * - `src/editor/commands.ts`・`src/editor/markdown-limits.ts` が無いので import で落ちる。`+page.svelte` に `MENU_FORMAT_EVENT` の受け手が無い
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { history, undo, undoDepth } from 'prosemirror-history';

import { markdownSchema } from './markdown-schema';
import { createMarkdownDocument, markdownText, withState } from './markdown-document';
import { FORMAT_COMMANDS, FORMAT_ITEM_IDS, MENU_FORMAT_EVENT, runFormatCommand, type FormatItemId } from './commands';
import { MARKDOWN_EDIT_LIMIT_BYTES, markdownTooLarge } from './markdown-limits';
import { blockNames, textSpots } from './markdown.testkit';

const REPO_ROOT = resolve(__dirname, '../..');

const EXPECTED_IDS: FormatItemId[] = [
	'format-bold',
	'format-italic',
	'format-strikethrough',
	'format-inline-code',
	'format-link',
	'format-body-text',
	'format-heading-1',
	'format-heading-2',
	'format-heading-3',
	'format-heading-4',
	'format-heading-5',
	'format-heading-6',
	'format-bulleted-list',
	'format-numbered-list',
	'format-task-list',
	'format-quote',
	'format-code-block',
	'format-alert-note',
	'format-alert-tip',
	'format-alert-important',
	'format-alert-warning',
	'format-alert-caution',
	'format-indent',
	'format-outdent',
	'format-insert-table',
	'format-insert-rule',
	'format-insert-footnote',
	'format-insert-image',
	'format-clear',
	// 要件74 第3段 3-2(Format ▸ Table=契約8・3-6)
	'format-table-row-above',
	'format-table-row-below',
	'format-table-column-left',
	'format-table-column-right',
	'format-table-delete-row',
	'format-table-delete-column',
	'format-table-delete',
];

function open(src: string) {
	return createMarkdownDocument(src, { uri: 'file:///Users/a/doc.md', readOnly: false });
}

/** `block` の text の `[from, to)` を選んで command を当て、文書と undo の段数を返す。 */
function applyOn(src: string, block: number, from: number, to: number, id: FormatItemId) {
	const doc = open(src);
	const spot = textSpots(doc.state.doc, block)[0]!;
	const selected = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, spot.pos + from, spot.pos + to)));
	const depth0 = undoDepth(selected);
	let next = selected;
	const ok = FORMAT_COMMANDS[id](selected, (tr) => (next = selected.apply(tr)));
	const after = withState(doc, next);
	return { ok, after, text: markdownText(after), depthBefore: depth0, depthAfter: undoDepth(next), state: next };
}

describe('契約8: FORMAT_COMMANDS は項目 10 の表の ID をすべて持つ(Insert ▸ と Clear Formatting を含む=(an))', () => {
	test('FORMAT_ITEM_IDS の集合', () => {
		expect([...FORMAT_ITEM_IDS].sort()).toEqual([...EXPECTED_IDS].sort());
	});

	test('どの ID にも Command(関数)がある。表に無い ID は無い', () => {
		for (const id of EXPECTED_IDS) expect(typeof FORMAT_COMMANDS[id], id).toBe('function');
		expect(Object.keys(FORMAT_COMMANDS).sort()).toEqual([...EXPECTED_IDS].sort());
	});

	test("MENU_FORMAT_EVENT === 'menu_format'", () => {
		expect(MENU_FORMAT_EVENT).toBe('menu_format');
	});
});

describe('契約8・11: コマンド × 入力 × 選択 → 書き出し(1 回=undo 1 段・外すときは綴りを問わず外す)', () => {
	test.each([
		['Bold を付ける', 'plain words\n', 0, 5, 'format-bold', '**plain** words\n'],
		['Bold を外す(**)', '**plain** words\n', 0, 5, 'format-bold', 'plain words\n'],
		['Bold を外す(__)', '__plain__ words\n', 0, 5, 'format-bold', 'plain words\n'],
		['Italic を付ける', 'plain words\n', 0, 5, 'format-italic', '*plain* words\n'],
		['Strikethrough', 'plain words\n', 0, 5, 'format-strikethrough', '~~plain~~ words\n'],
		['Inline Code', 'plain words\n', 0, 5, 'format-inline-code', '`plain` words\n'],
		['Heading 2', 'plain words\n', 0, 0, 'format-heading-2', '## plain words\n'],
		['Heading 2 を同じ段で押すと段落に戻る', '## plain words\n', 0, 0, 'format-heading-2', 'plain words\n'],
		['Body Text', '### plain words\n', 0, 0, 'format-body-text', 'plain words\n'],
		['Bulleted List', 'plain words\n', 0, 0, 'format-bulleted-list', '- plain words\n'],
		['Bulleted List を外す', '- plain words\n', 0, 0, 'format-bulleted-list', 'plain words\n'],
		['Numbered List', 'plain words\n', 0, 0, 'format-numbered-list', '1. plain words\n'],
		['Task List', 'plain words\n', 0, 0, 'format-task-list', '- [ ] plain words\n'],
		['Quote', 'plain words\n', 0, 0, 'format-quote', '> plain words\n'],
		['Quote を外す', '> plain words\n', 0, 0, 'format-quote', 'plain words\n'],
		['Code Block', 'plain words\n', 0, 0, 'format-code-block', '```\nplain words\n```\n'],
		['Alert ▸ Warning', 'plain words\n', 0, 0, 'format-alert-warning', '> [!WARNING]\n> plain words\n'],
		['Clear Formatting', '**a** *b* ~~c~~ `d`\n', 0, 0, 'format-clear', 'a b c d\n'],
	] as Array<[string, string, number, number, FormatItemId, string]>)('%s', (_label, src, from, to, id, expected) => {
		const doc = open(src);
		const spots = textSpots(doc.state.doc, 0);
		const first = spots[0]!;
		const last = spots[spots.length - 1]!;
		// Clear Formatting は段落全体を選ぶ。
		const selFrom = id === 'format-clear' ? first.pos : first.pos + from;
		const selTo = id === 'format-clear' ? last.pos + last.text.length : first.pos + to;
		const selected = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, selFrom, selTo)));
		let next = selected;
		const ok = FORMAT_COMMANDS[id](selected, (tr) => (next = selected.apply(tr)));
		expect(ok).toBe(true);
		const after = withState(doc, next);
		expect(markdownText(after)).toBe(expected);
		expect(undoDepth(next), 'コマンド 1 回=undo 1 段').toBe(undoDepth(selected) + 1);
		let undone = next;
		undo(next, (tr) => (undone = next.apply(tr)));
		expect(markdownText(withState(doc, undone)), 'undo 1 回で原文').toBe(src);
	});

	test('空の選択の Bold はカーソルの単語に付く。単語の上でなければ stored mark(文書は変わらない)', () => {
		const onWord = applyOn('alpha beta\n', 0, 2, 2, 'format-bold');
		expect(onWord.ok).toBe(true);
		expect(onWord.text).toBe('**alpha** beta\n');
		const between = applyOn('alpha beta\n', 0, 5, 5, 'format-bold');
		expect(between.text).toBe('alpha beta\n');
		expect(between.state.storedMarks?.some((m) => m.type.name === 'strong') ?? false).toBe(true);
	});

	test('複数ブロックの選択に Heading 3 → 各ブロックが見出し', () => {
		const doc = open('one\n\ntwo\n\nthree\n');
		const a = textSpots(doc.state.doc, 0)[0]!;
		const b = textSpots(doc.state.doc, 1)[0]!;
		const selected = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, a.pos, b.pos + 3)));
		let next = selected;
		expect(FORMAT_COMMANDS['format-heading-3'](selected, (tr) => (next = selected.apply(tr)))).toBe(true);
		expect(markdownText(withState(doc, next))).toBe('### one\n\n### two\n\nthree\n');
	});

	test('Increase Indent でリスト項目が 1 段深く、Decrease Indent で戻る', () => {
		const doc = open('- a\n- b\n');
		const b = textSpots(doc.state.doc, 0).find((s) => s.text === 'b')!;
		const selected = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, b.pos)));
		let next = selected;
		expect(FORMAT_COMMANDS['format-indent'](selected, (tr) => (next = selected.apply(tr)))).toBe(true);
		expect(markdownText(withState(doc, next))).toBe('- a\n  - b\n');
		let back = next;
		expect(FORMAT_COMMANDS['format-outdent'](next, (tr) => (back = next.apply(tr)))).toBe(true);
		expect(markdownText(withState(doc, back))).toBe('- a\n- b\n');
	});

	test('Insert ▸ Table: カーソルの次に 2 列・見出しの行と空の行 1 つの表', () => {
		const r = applyOn('intro\n\nafter\n', 0, 2, 2, 'format-insert-table');
		expect(r.ok).toBe(true);
		expect(blockNames(r.state.doc)).toEqual(['paragraph', 'table', 'paragraph']);
		const table = r.state.doc.child(1);
		expect(table.childCount).toBe(2);
		expect(table.child(0).childCount).toBe(2);
		expect(table.child(1).childCount).toBe(2);
		expect(r.text.startsWith('intro\n\n|')).toBe(true);
		expect(r.text.endsWith('\n\nafter\n')).toBe(true);
	});

	test('Insert ▸ Horizontal Rule: 区切り線が入る(綴りは流儀=例が無ければ ---)', () => {
		const r = applyOn('intro\n\nafter\n', 0, 2, 2, 'format-insert-rule');
		expect(blockNames(r.state.doc)).toEqual(['paragraph', 'horizontal_rule', 'paragraph']);
		expect(r.text).toBe('intro\n\n---\n\nafter\n');
	});

	test('Insert ▸ Footnote: カーソルに脚注参照(まだ使っていない最小の番号)、末尾に定義', () => {
		const r = applyOn('text[^1] here\n\n[^1]: one\n', 0, 4, 4, 'format-insert-footnote');
		expect(r.ok).toBe(true);
		const names = blockNames(r.state.doc);
		expect(names[names.length - 1]).toBe('footnote_definition');
		expect(r.text).toContain('[^2]');
		expect(r.text).toMatch(/\[\^2\]:/);
		// カーソルは新しい定義の中へ。
		const $head = r.state.selection.$head;
		let inDefinition = false;
		for (let d = $head.depth; d > 0; d--) if ($head.node(d).type.name === 'footnote_definition') inDefinition = true;
		expect(inDefinition).toBe(true);
	});

	test('Link…(第4段 4-5・4-10): リンクの中でも外でも Command は false で文書は不変(欄=Text と Link・Remove Link・Done は面の側)', () => {
		// 最初の text は 'see '(リンクの外)。リンクの text は 2 つ目。
		const outside = applyOn('see [here](https://a.example) now\n', 0, 1, 1, 'format-link');
		const doc = open('see [here](https://a.example) now\n');
		const link = textSpots(doc.state.doc, 0).find((s) => s.marks.includes('link'))!;
		const selected = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, link.pos + 1)));
		let next = selected;
		let dispatched = 0;
		expect(
			FORMAT_COMMANDS['format-link'](selected, (tr) => {
				dispatched++;
				next = selected.apply(tr);
			}),
			'リンクの中: すぐ外さず欄を開く(Command は false)'
		).toBe(false);
		expect(dispatched).toBe(0);
		expect(markdownText(withState(doc, next))).toBe('see [here](https://a.example) now\n');
		expect(outside.ok, 'リンクの外(欄は面の側)').toBe(false);
		expect(outside.text).toBe('see [here](https://a.example) now\n');
	});

	test('Image…: Command は false(ファイルを選ぶダイアログは面の側)', () => {
		const r = applyOn('intro\n', 0, 2, 2, 'format-insert-image');
		expect(r.ok).toBe(false);
		expect(r.text).toBe('intro\n');
	});

	test('code_block の中では文字の装飾(Bold)は当たらない', () => {
		const r = applyOn('```\ncode here\n```\n', 0, 0, 4, 'format-bold');
		expect(r.ok).toBe(false);
		expect(r.text).toBe('```\ncode here\n```\n');
	});
});

describe('契約8: runFormatCommand は Markdown の編集面にだけ当てる', () => {
	test('handle が null → false', () => {
		expect(runFormatCommand('format-bold', null)).toBe(false);
	});

	test("kind が 'text'(CodeMirror の面)の handle → false・何も呼ばない", () => {
		let called = false;
		const handle = {
			kind: 'text' as const,
			uri: 'file:///a.ts',
			readOnly: false,
			dirty: false,
			conflict: false,
			notice: null,
			text: () => 'x',
			expectedHash: () => '',
			markSaved: () => {},
			applyFileChanged: () => 'apply' as const,
			keepMyEdits: () => {},
			useFileOnDisk: () => {},
			showSaveConflict: () => {},
			reset: () => {},
			preparePrint: async () => {
				called = true;
			},
		};
		expect(runFormatCommand('format-bold', handle)).toBe(false);
		expect(called).toBe(false);
	});

	test('読み取り専用の Markdown の handle → false', () => {
		const doc = open('plain\n');
		const view = {
			state: doc.state,
			dispatch: () => {
				throw new Error('must not dispatch');
			},
			composing: false,
		};
		const handle = {
			kind: 'markdown' as const,
			raw: false,
			view: view as unknown as import('prosemirror-view').EditorView,
			uri: 'file:///a.md',
			readOnly: true,
			dirty: false,
			conflict: false,
			notice: null,
			text: () => 'plain\n',
			expectedHash: () => '',
			markSaved: () => {},
			applyFileChanged: () => 'apply' as const,
			keepMyEdits: () => {},
			useFileOnDisk: () => {},
			showSaveConflict: () => {},
			reset: () => {},
			preparePrint: async () => {},
		};
		expect(runFormatCommand('format-bold', handle)).toBe(false);
		// raw の間も当てない。
		expect(runFormatCommand('format-bold', { ...handle, readOnly: false, raw: true })).toBe(false);
	});
});

describe('AC-74-22 の定数(判断 8): MARKDOWN_EDIT_LIMIT_BYTES = 2 MiB・UTF-8 の byte で数える', () => {
	test('値', () => {
		expect(MARKDOWN_EDIT_LIMIT_BYTES).toBe(2 * 1024 * 1024);
	});

	test('ちょうど 2 MiB は編集面(false)・1 byte 超えで true・日本語は 3 byte で数える', () => {
		expect(markdownTooLarge('a'.repeat(MARKDOWN_EDIT_LIMIT_BYTES))).toBe(false);
		expect(markdownTooLarge('a'.repeat(MARKDOWN_EDIT_LIMIT_BYTES + 1))).toBe(true);
		// 'あ' は UTF-8 で 3 byte: 699,051 文字 = 2,097,153 byte > 2 MiB。
		expect(markdownTooLarge('あ'.repeat(699_051))).toBe(true);
		expect(markdownTooLarge('あ'.repeat(699_050))).toBe(false);
		expect(markdownTooLarge('')).toBe(false);
	});
});

describe('+page.svelte の配線(ソース走査): menu_format の受け手', () => {
	function stripComments(src: string): string {
		return src
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.split('\n')
			.map((line) => {
				for (let i = 0; i + 1 < line.length; i++) {
					if (line[i] === '/' && line[i + 1] === '/' && (i === 0 || line[i - 1] !== ':')) return line.slice(0, i);
				}
				return line;
			})
			.join('\n');
	}
	function balancedBody(src: string, open: number): string {
		const pairs: Record<string, string> = { '(': ')', '{': '}' };
		const close = pairs[src[open]!]!;
		let depth = 0;
		let quote: string | null = null;
		for (let i = open; i < src.length; i++) {
			const c = src[i]!;
			if (quote) {
				if (c === '\\') {
					i++;
					continue;
				}
				if (c === quote) quote = null;
				continue;
			}
			if (c === "'" || c === '"' || c === '`') {
				quote = c;
				continue;
			}
			if (c === src[open]) depth++;
			else if (c === close) {
				depth--;
				if (depth === 0) return src.slice(open + 1, i);
			}
		}
		throw new Error('unbalanced');
	}

	test('listen(MENU_FORMAT_EVENT の受け手が rootPicker.open を見てから runFormatCommand(…, windowState.fileEditor) を呼ぶ', () => {
		const src = stripComments(readFileSync(resolve(REPO_ROOT, 'src/routes/+page.svelte'), 'utf8'));
		expect(src).toMatch(/import\s*\{[^}]*\bMENU_FORMAT_EVENT\b[^}]*\}\s*from\s*'[^']*editor\/commands'/);
		expect(src).toMatch(/import\s*\{[^}]*\brunFormatCommand\b[^}]*\}\s*from\s*'[^']*editor\/commands'/);
		const at = src.indexOf('listen(MENU_FORMAT_EVENT');
		expect(at, 'listen(MENU_FORMAT_EVENT, …) in +page.svelte').toBeGreaterThanOrEqual(0);
		const handler = balancedBody(src, src.indexOf('(', at));
		const gate = handler.indexOf('rootPicker.open');
		const call = handler.indexOf('runFormatCommand(');
		expect(call, 'the handler calls runFormatCommand(').toBeGreaterThanOrEqual(0);
		expect(gate, 'the handler reads rootPicker.open (Dashboard: 契約16)').toBeGreaterThanOrEqual(0);
		expect(gate).toBeLessThan(call);
		expect(handler.slice(call)).toMatch(/runFormatCommand\([^)]*windowState\.fileEditor/);
	});
});

// 要件74 第2段 2-5(2026-11-17 仮): toggleEditMode / beginEdit / editBlocked の走査は撤去で外した(Command + E が登録されないことは
// acceptance_req74_removal.rs・+page に MENU_EDIT_EVENT が無いことは removal.acceptance.test.ts が見る)。
