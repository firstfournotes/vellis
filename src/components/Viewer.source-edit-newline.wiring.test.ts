/**
 * 要件#48 追補n の受け入れテスト(docs/requirements/req-48.md「追補n」・Issue #765)
 * — ソース編集の `<pre contenteditable>` で Return と貼り付けが `\n` を入れる配線
 * (component プロジェクト)
 *
 * WebKit は contenteditable の Return で `<div>` を足し、`bufferFromPre`
 * (`textContent`)から改行が消える。追補n はソース編集の `<pre>` に限って Return と
 * 貼り付けを自前で受け、`\n` の文字として入れる。ここは `Viewer.svelte` を JSDOM に
 * マウントし、text 文書と markdown のソース編集(ブロック編集でない方)の両方で、
 * **keydown / paste → DOM と編集バッファ → 保存の IPC** の配線を判定する。
 * 要件#48 の wiring(Viewer.edit.wiring.test.ts)と要件#52 の wiring
 * (Viewer.codeedit.wiring.test.ts=Enter と貼り付けを自前で入れている前例)は
 * 書き換えず、本追補用に新設(家風はそこに倣う)。
 *
 * ## 判定するもの(契約番号は req-48.md 追補n の 1〜6・AC は AC-48-追n の (a)〜(f))
 * - **AC (a)・契約1・3**: ソース編集の `<pre>` で Command・Control の付かない Return
 *   (修飾なし・Shift・Option)の keydown → `defaultPrevented` が true になり、
 *   キャレットの位置に `\n` が 1 つ入る(`<div>`・`<br>` は生えない)。編集バッファは
 *   `<pre>` の `textContent` と同じになり dirty。選択範囲があれば置き換わる。
 *   続けて 2 回押すと `\n\n`(キャレットが入れた改行の後ろへ進む)
 * - **AC (b)・契約1**: IME の変換中(`isComposing`・`keyCode` 229)と Command / Control
 *   付きの Return は止めない(`defaultPrevented` が false)し、何も入れない
 * - **AC (c)・契約2・3**: 貼り付けは既定を止め、text/plain だけを CRLF・CR・LF を
 *   すべて `\n` にしてキャレットの位置へ入れる。text/html は使われない(要素が
 *   混入しない)。選択範囲は置き換わる。text/plain が空(html だけ)なら既定は
 *   止めるが何も入らず dirty にもならない
 * - **契約4(取り消しの履歴)**: `document.execCommand` が WebKit のように使える
 *   環境(偽物で再現)では、Return は `insertLineBreak` 1 回、貼り付けは行ごとの
 *   `insertText` と `insertLineBreak` の交互で入れる(`\n` を含む `insertText` は
 *   WebKit が `<div>` にするので呼ばない)。`execCommand` が無い(JSDOM 既定)か
 *   false を返す環境では、キャレットの位置へ直接差し込んでバッファを揃える
 * - **AC (d)**: 入れた改行が `save_document` の IPC に渡る content に入り、保存で
 *   dirty が消える(⌘S の本体 `saveDocument`・門は `shouldSaveOnCommand`=
 *   codeedit wiring の AC-52-9 と同じ確かめ方)
 * - **AC (e)・契約5**: 閲覧中の `<pre>`・markdown のブロック編集(要件#49)・
 *   コードブロックの編集(要件#52)・HTML の編集面(要件#53)には、この Return /
 *   貼り付けの処理が付かない(既存の振る舞いのまま)
 * - **AC (f)・契約6**: 既存テストの無改変は本ファイルでは判定しない(フルスイート)。
 *   `contenteditable="true"` のままであることは入口の確認で毎回見る
 *
 * ## 判定しないもの
 * - 本物の WKWebView での `insertLineBreak` の振る舞い・Command + Z の取り消し・
 *   日本語入力の確定 Return → E2E(tests/e2e/specs/req48n-source-newline-gate.e2e.ts)
 *   と人間ゲート(req-48.md 追補n)
 * - CRLF の文書で Return が入れる改行(契約5=範囲の外)
 *
 * ## JSDOM 上の編集操作について(codeedit wiring の家風)
 * JSDOM の contenteditable には既定の編集動作が無く、`document.execCommand` も無い
 * (`typeof document.execCommand === 'undefined'`)。Return の改行・貼り付けの挿入は
 * Viewer 側のハンドラが行う前提で判定する。契約4 の WebKit の経路は、
 * `document.execCommand` を**偽物**に差し替えて再現する: `insertLineBreak` は選択を
 * 消して `\n` のテキストを入れ、`insertText` は値を入れる(値に `\n` があれば WebKit
 * と同じく `<div>` を生やす=誤った呼び方が DOM に現れる)。どちらも WebKit と同じく
 * 挿入のあとに `input` イベントを発火する。
 *
 * ## スタブの設計(Viewer.edit.wiring.test.ts の家風)
 * - $lib/ipc / @tauri-apps/plugin-opener / @tauri-apps/plugin-dialog: モジュールモック
 * - $lib/mermaid-mounter: AC (e) の markdown フィクスチャは本番パイプライン(`render`)
 *   を通すので、mermaid の dynamic import を発火させない
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({
	mountMermaid: vi.fn(async () => undefined),
}));

import { invoke } from '$lib/ipc';
import { saveDocument } from '$lib/save-document';
import { shouldSaveOnCommand } from '$lib/document-edit';

const invokeMock = vi.mocked(invoke);

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const TXT_URI = 'file:///Users/a/notes/memo.txt';
/** 'first' = 0..5・' line' = 5..10・'\n' = 10・'second line' = 11..22・'\n' = 22。 */
const TXT_CONTENT = 'first line\nsecond line\n';
const MD_URI = 'file:///Users/a/notes/plan.md';
/** '# Plan' = 0..6・'\n\n' = 6..8・'- item' = 8..14・'\n' = 14。 */
const MD_CONTENT = '# Plan\n\n- item\n';

/** 'first' の直後(行の途中)。 */
const MID_FIRST = 5;
/** 'first line' の 'line'(6..10)。選択範囲の置き換えに使う。 */
const SEL_LINE: [number, number] = [6, 10];

/** CRLF・CR・LF が混ざった貼り付け(契約2: どれも `\n` 1 つになる)。 */
const PASTE_MIXED = 'A\r\nB\rC\nD';
const PASTE_MIXED_NORMALIZED = 'A\nB\nC\nD';
/** text/html に同時に載せるリッチテキスト(使われてはいけない)。 */
const PASTE_HTML = '<b>A</b><div>B</div><div>C</div><div>D</div>';

function txtDoc(content: string = TXT_CONTENT): DocumentPayload {
	return { uri: TXT_URI, content, modified: 1 };
}

function mdDoc(): DocumentPayload {
	return { uri: MD_URI, content: MD_CONTENT, modified: 1 };
}

/** file-type.ts の renderPlainText と同形のマークアップ(text 種別の html prop)。 */
function plainTextHtml(content: string): string {
	const escaped = content.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
	);
	return `<pre class="vellis-plaintext">\n${escaped}</pre>`;
}

function baseProps(doc: DocumentPayload, html: string, index: SourceIndex | null = null) {
	return {
		document: doc,
		html,
		index,
		onRequestAddMark: vi.fn(),
		onToggleMarks: vi.fn(),
		marksOpen: false,
	};
}

/** text 文書を windowState と Viewer の両方に載せてマウントする。 */
function renderText(content: string = TXT_CONTENT) {
	const doc = txtDoc(content);
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, plainTextHtml(content)) });
}

/**
 * markdown 文書をマウントする(ソース編集の判定用)。html に `data-vellis-node-id`
 * が無く index も null なので、本文のダブルクリックはブロック編集ではなく
 * 要件#48 のソース編集モードへ入る(Viewer.edit.wiring.test.ts と同じ形)。
 */
function renderMarkdownSource() {
	const doc = mdDoc();
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, '<h1>Plan</h1>\n<ul><li>item</li></ul>') });
}

function getPre(container: HTMLElement): HTMLElement {
	const pre = container.querySelector('pre.vellis-plaintext');
	if (!pre) throw new Error('pre.vellis-plaintext not found');
	return pre as HTMLElement;
}

/** ソース編集モードの `<pre>`(要件#48)。無ければ null。 */
function sourcePre(container: HTMLElement): HTMLElement | null {
	return container.querySelector('pre.vellis-plaintext');
}

function isEditable(el: Element): boolean {
	return el.getAttribute('contenteditable') === 'true';
}

/** ハンドラが await を連ねても連鎖全体を確定させる(edit wiring の家風)。 */
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

/** 本文のダブルクリックでソース編集に入り、contenteditable の `<pre>` を返す。 */
async function enterSourceEdit(container: HTMLElement, expectedText: string): Promise<HTMLElement> {
	await fireEvent.dblClick(container.querySelector('.markdown-body') as HTMLElement);
	await settle();
	const pre = getPre(container);
	expect(isEditable(pre), 'ソース編集の pre が contenteditable="true" であること(契約6)').toBe(true);
	expect(pre.textContent).toBe(expectedText);
	expect(windowState.editMode).toBe('edit');
	expect(windowState.dirty).toBe(false);
	return pre;
}

// ---------------------------------------------------------------------------
// キャレット・イベントのヘルパー
// ---------------------------------------------------------------------------

/**
 * 要素の中の文字オフセット(`textContent` 基準)へキャレット(または選択範囲)を置く。
 * テキストノードが複数に割れていても(挿入のあと)辿れるように、ノードを歩いて
 * オフセットを割り当てる。
 */
function placeCaret(el: HTMLElement, start: number, end: number = start) {
	const doc = el.ownerDocument;
	const locate = (offset: number): [Text, number] => {
		const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
		let seen = 0;
		let last: Text | null = null;
		while (walker.nextNode()) {
			const t = walker.currentNode as Text;
			last = t;
			const len = t.data.length;
			if (offset <= seen + len) return [t, offset - seen];
			seen += len;
		}
		if (!last) throw new Error('テキストノードが無い');
		return [last, last.data.length];
	};
	const [startNode, startOffset] = locate(start);
	const [endNode, endOffset] = locate(end);
	const range = doc.createRange();
	range.setStart(startNode, startOffset);
	range.setEnd(endNode, endOffset);
	const sel = doc.defaultView?.getSelection();
	if (!sel) throw new Error('Selection が取れない');
	sel.removeAllRanges();
	sel.addRange(range);
}

/** キャレットの位置(`textContent` 基準の文字オフセット)。選択が無ければ -1。 */
function caretOffset(el: HTMLElement): number {
	const sel = el.ownerDocument.defaultView?.getSelection();
	if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return -1;
	const range = sel.getRangeAt(0);
	const probe = range.cloneRange();
	probe.selectNodeContents(el);
	probe.setEnd(range.startContainer, range.startOffset);
	return probe.toString().length;
}

/** keydown を dispatch して、そのイベント(`defaultPrevented` を見る)を返す。 */
async function pressKey(el: HTMLElement, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
	const ev = new KeyboardEvent('keydown', {
		key: 'Enter',
		code: 'Enter',
		bubbles: true,
		cancelable: true,
		...init,
	});
	el.dispatchEvent(ev);
	await settle();
	return ev;
}

/**
 * paste を dispatch して、そのイベントを返す。JSDOM に `ClipboardEvent` /
 * `DataTransfer` は無いので、`clipboardData.getData(type)` だけを持つ最小の
 * オブジェクトを載せる(codeedit wiring の `fireEvent.paste` と同じ形)。
 */
async function dispatchPaste(el: HTMLElement, data: Record<string, string>): Promise<Event> {
	const ev = new Event('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(ev, 'clipboardData', {
		value: {
			types: Object.keys(data),
			getData: (type: string) => data[type] ?? '',
		},
	});
	el.dispatchEvent(ev);
	await settle();
	return ev;
}

/** `<pre>` に要素(`<div>`・`<br>` など)が生えていない=改行は文字として入っている。 */
function expectTextOnly(pre: HTMLElement) {
	expect(pre.childElementCount, 'pre の中に要素が生えていないこと').toBe(0);
	expect(pre.querySelector('div, br')).toBeNull();
}

/** 契約3: 編集バッファは `<pre>` の `textContent` と同じで、`expected` に一致。 */
function expectBufferIs(pre: HTMLElement, expected: string) {
	expect(pre.textContent).toBe(expected);
	expect(windowState.editBuffer).toBe(expected);
	expectTextOnly(pre);
}

// ---------------------------------------------------------------------------
// 偽の execCommand(契約4 の WebKit の経路を JSDOM で再現する)
// ---------------------------------------------------------------------------

interface ExecCall {
	command: string;
	value: string | undefined;
}

type FakeExecCommand = (command: string, showUi?: boolean, value?: string) => boolean;

let restoreExecCommand: (() => void) | null = null;

/**
 * `document.execCommand` を WebKit のように振る舞う偽物にする。
 *
 * - `insertLineBreak`: 選択を消し、`\n` の**文字**を入れる(2026-10-28 に WKWebView
 *   の `contenteditable` な `<pre>`(white-space: pre-wrap)で確かめた事実)
 * - `insertText`: 選択を消し、値を入れる。値に `\n` があれば WebKit と同じく 2 行目
 *   以降を `<div>` にする(=`\n` を `insertText` に渡す誤った呼び方は DOM に現れる)
 * - どちらも入れたあとに `input` を発火する(WebKit と同じ=`oninput` が走る)
 * - `returns: false` なら何もせず false を返す(コマンドが使えない環境の再現)
 */
function installFakeExecCommand(opts: { returns?: boolean } = {}): ExecCall[] {
	const calls: ExecCall[] = [];
	const fake: FakeExecCommand = (command, _showUi, value) => {
		calls.push({ command, value });
		if (opts.returns === false) return false;
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return false;
		const range = sel.getRangeAt(0);
		const anchor = range.commonAncestorContainer;
		const host = (anchor instanceof Element ? anchor : anchor.parentElement)?.closest(
			'[contenteditable="true"]',
		);
		if (!host) return false;
		if (command !== 'insertLineBreak' && command !== 'insertText') return false;
		const text = command === 'insertLineBreak' ? '\n' : (value ?? '');
		range.deleteContents();
		if (text.length > 0) {
			// insertLineBreak は `\n` の文字のテキストノード 1 つ(WKWebView で確かめた
			// 事実)。`\n` を `<div>` にするのは insertText に改行を渡したときだけ。
			const lines = command === 'insertLineBreak' ? ['\n'] : text.split('\n');
			const first = document.createTextNode(lines[0] ?? '');
			range.insertNode(first);
			let tail: Node = first;
			for (const line of lines.slice(1)) {
				const div = document.createElement('div');
				div.textContent = line;
				tail.parentNode?.insertBefore(div, tail.nextSibling);
				tail = div;
			}
			range.setStartAfter(tail);
			range.collapse(true);
			sel.removeAllRanges();
			sel.addRange(range);
		}
		host.dispatchEvent(
			new InputEvent('input', {
				bubbles: true,
				inputType: command,
				data: command === 'insertText' ? text : null,
			}),
		);
		return true;
	};
	Object.defineProperty(document, 'execCommand', { value: fake, configurable: true, writable: true });
	restoreExecCommand = () => {
		delete (document as unknown as { execCommand?: unknown }).execCommand;
		restoreExecCommand = null;
	};
	return calls;
}

/** `insertText` の空文字(空行の扱いは実装裁量)を除いた呼び出しの並び。 */
function effectiveCalls(calls: ExecCall[]): string[] {
	return calls
		.filter((c) => !(c.command === 'insertText' && (c.value ?? '') === ''))
		.map((c) => (c.command === 'insertText' ? `insertText:${c.value}` : c.command));
}

beforeEach(() => {
	expect(typeof document.execCommand, 'JSDOM の既定では execCommand が無いこと(前提)').toBe(
		'undefined',
	);
	windowState.endEdit();
	windowState.clearDocument();
});

afterEach(() => {
	restoreExecCommand?.();
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC (a) — Return はキャレットの位置に `\n` を 1 つ入れる(契約1・3)
// ---------------------------------------------------------------------------

describe('AC-48-追n (a) — Return で `\\n` が入り、バッファと dirty が更新される(契約1・3)', () => {
	it('修飾なしの Return: 既定が止まり、行の途中に `\\n` が入る(要素は生えない)・バッファ=textContent・dirty', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);

		const ev = await pressKey(pre);

		expect(ev.defaultPrevented).toBe(true);
		expectBufferIs(pre, 'first\n line\nsecond line\n');
		expect(windowState.dirty).toBe(true);
		expect(windowState.editMode).toBe('edit');
		// 編集は続いている(Return で確定・離脱しない)。
		expect(isEditable(pre)).toBe(true);
	});

	const allowedMods: Array<[string, KeyboardEventInit]> = [
		['Shift', { shiftKey: true }],
		['Option', { altKey: true }],
	];
	it.each(allowedMods)('%s + Return も同じく `\\n` を 1 つ入れる', async (_label, mods) => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);

		const ev = await pressKey(pre, mods);

		expect(ev.defaultPrevented).toBe(true);
		expectBufferIs(pre, 'first\n line\nsecond line\n');
		expect(windowState.dirty).toBe(true);
	});

	it('選択範囲があれば `\\n` で置き換わる', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, ...SEL_LINE);

		const ev = await pressKey(pre);

		expect(ev.defaultPrevented).toBe(true);
		expectBufferIs(pre, 'first \n\nsecond line\n');
		expect(windowState.dirty).toBe(true);
	});

	it('続けて 2 回押すと `\\n\\n`(キャレットは入れた改行の後ろへ進む)', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);

		await pressKey(pre);
		expect(caretOffset(pre), '1 回目の改行の直後にキャレットがあること').toBe(MID_FIRST + 1);
		await pressKey(pre);

		expectBufferIs(pre, 'first\n\n line\nsecond line\n');
		expect(caretOffset(pre)).toBe(MID_FIRST + 2);
	});

	it('末尾での Return は末尾に `\\n` を足す', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, TXT_CONTENT.length);

		await pressKey(pre);

		expectBufferIs(pre, TXT_CONTENT + '\n');
	});

	it('markdown のソース編集でも同じ(ブロック編集ではない方)', async () => {
		const { container } = renderMarkdownSource();
		const pre = await enterSourceEdit(container, MD_CONTENT);
		// '# Plan' の途中('# Pl' の直後)。
		placeCaret(pre, 4);

		const ev = await pressKey(pre);

		expect(ev.defaultPrevented).toBe(true);
		expectBufferIs(pre, '# Pl\nan\n\n- item\n');
		expect(windowState.dirty).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC (b) — IME の変換中と Command / Control 付きは止めない・何も入れない(契約1)
// ---------------------------------------------------------------------------

describe('AC-48-追n (b) — IME の変換中・Command / Control 付きの Return は素通し(契約1)', () => {
	const passThrough: Array<[string, KeyboardEventInit]> = [
		['isComposing', { isComposing: true }],
		['keyCode 229(変換を確定する Return)', { keyCode: 229 }],
		['isComposing + keyCode 229', { isComposing: true, keyCode: 229 }],
		['Command', { metaKey: true }],
		['Control', { ctrlKey: true }],
		['Command + Shift', { metaKey: true, shiftKey: true }],
	];
	it.each(passThrough)('%s: defaultPrevented が false・何も入らない・dirty にならない', async (_label, init) => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);

		const ev = await pressKey(pre, init);

		expect(ev.defaultPrevented).toBe(false);
		expect(pre.textContent).toBe(TXT_CONTENT);
		expectTextOnly(pre);
		expect(windowState.editBuffer).toBe(TXT_CONTENT);
		expect(windowState.dirty).toBe(false);
		// 編集は続いている。
		expect(isEditable(pre)).toBe(true);
		expect(windowState.editMode).toBe('edit');
	});

	it('IME の変換中は WebKit の経路でも execCommand を呼ばない(偽物の呼び出しが 0 件)', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);
		const calls = installFakeExecCommand();

		const ev = await pressKey(pre, { isComposing: true });

		expect(ev.defaultPrevented).toBe(false);
		expect(calls).toEqual([]);
		expect(pre.textContent).toBe(TXT_CONTENT);
	});
});

// ---------------------------------------------------------------------------
// AC (c) — 貼り付けは text/plain だけを、改行を `\n` にして入れる(契約2・3)
// ---------------------------------------------------------------------------

describe('AC-48-追n (c) — 貼り付けは text/plain だけ・改行は `\\n`(契約2・3)', () => {
	it('CRLF・CR・LF の混ざった text/plain がすべて `\\n` になってキャレットの位置へ入る・text/html は使われない', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);

		const ev = await dispatchPaste(pre, { 'text/plain': PASTE_MIXED, 'text/html': PASTE_HTML });

		expect(ev.defaultPrevented).toBe(true);
		expectBufferIs(pre, 'first' + PASTE_MIXED_NORMALIZED + ' line\nsecond line\n');
		expect(pre.textContent).not.toContain('\r');
		expect(pre.querySelector('b')).toBeNull();
		expect(windowState.dirty).toBe(true);
		expect(isEditable(pre)).toBe(true);
	});

	it('貼り付けたあとのキャレットは入れた文字の後ろにある(続けて Return すると直後に改行が入る)', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);

		await dispatchPaste(pre, { 'text/plain': 'X\r\nY' });
		expect(caretOffset(pre)).toBe(MID_FIRST + 'X\nY'.length);
		await pressKey(pre);

		expectBufferIs(pre, 'firstX\nY\n line\nsecond line\n');
	});

	it('選択範囲があれば貼り付けで置き換わる', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, ...SEL_LINE);

		const ev = await dispatchPaste(pre, { 'text/plain': 'X\r\nY', 'text/html': '<i>X</i><div>Y</div>' });

		expect(ev.defaultPrevented).toBe(true);
		expectBufferIs(pre, 'first X\nY\nsecond line\n');
		expect(pre.querySelector('i')).toBeNull();
		expect(windowState.dirty).toBe(true);
	});

	it('末尾に改行で終わる複数行を貼ると行がそのまま保たれる', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, TXT_CONTENT.length);

		await dispatchPaste(pre, { 'text/plain': 'one\r\ntwo\r\n' });

		expectBufferIs(pre, TXT_CONTENT + 'one\ntwo\n');
	});

	const emptyPastes: Array<[string, Record<string, string>]> = [
		['text/plain が空(text/html だけ)', { 'text/plain': '', 'text/html': PASTE_HTML }],
		['text/plain が無い(text/html だけ)', { 'text/html': PASTE_HTML }],
		['何も無い', {}],
	];
	it.each(emptyPastes)('%s: 既定は止まるが何も入らず dirty にならない', async (_label, data) => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);

		const ev = await dispatchPaste(pre, data);

		// 契約2: 既定の動作(WebKit なら HTML が入る)は止める。
		expect(ev.defaultPrevented).toBe(true);
		expect(pre.textContent).toBe(TXT_CONTENT);
		expectTextOnly(pre);
		expect(windowState.editBuffer).toBe(TXT_CONTENT);
		expect(windowState.dirty).toBe(false);
	});

	it('markdown のソース編集でも同じ(ブロック編集ではない方)', async () => {
		const { container } = renderMarkdownSource();
		const pre = await enterSourceEdit(container, MD_CONTENT);
		// '- item' の直後('\n' の前)。
		placeCaret(pre, 14);

		const ev = await dispatchPaste(pre, { 'text/plain': '\r\n- two', 'text/html': '<ul><li>two</li></ul>' });

		expect(ev.defaultPrevented).toBe(true);
		expectBufferIs(pre, '# Plan\n\n- item\n- two\n');
		expect(pre.querySelector('ul')).toBeNull();
		expect(windowState.dirty).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 契約4 — 取り消しの履歴に乗せる(WebKit の編集コマンド)・使えなければ直接差し込む
// ---------------------------------------------------------------------------

describe('契約4 — execCommand が使える環境では WebKit の編集コマンドで入れる(取り消しの履歴)', () => {
	it('Return は insertLineBreak を 1 回だけ呼ぶ(insertText は呼ばない)・結果のバッファが正しい', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);
		const calls = installFakeExecCommand();

		const ev = await pressKey(pre);

		expect(ev.defaultPrevented).toBe(true);
		expect(calls.map((c) => c.command)).toEqual(['insertLineBreak']);
		expectBufferIs(pre, 'first\n line\nsecond line\n');
		expect(windowState.dirty).toBe(true);
	});

	it('選択範囲のある Return も insertLineBreak 1 回で置き換わる', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, ...SEL_LINE);
		const calls = installFakeExecCommand();

		await pressKey(pre);

		expect(calls.map((c) => c.command)).toEqual(['insertLineBreak']);
		expectBufferIs(pre, 'first \n\nsecond line\n');
	});

	it('貼り付けは行ごとの insertText と insertLineBreak を交互に呼ぶ(`\\n` を含む insertText は無い)', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);
		const calls = installFakeExecCommand();

		const ev = await dispatchPaste(pre, { 'text/plain': PASTE_MIXED, 'text/html': PASTE_HTML });

		expect(ev.defaultPrevented).toBe(true);
		expect(effectiveCalls(calls)).toEqual([
			'insertText:A',
			'insertLineBreak',
			'insertText:B',
			'insertLineBreak',
			'insertText:C',
			'insertLineBreak',
			'insertText:D',
		]);
		// WebKit が `<div>` にする呼び方(改行入りの insertText・insertHTML・insertParagraph)は無い。
		for (const c of calls) {
			expect(['insertText', 'insertLineBreak']).toContain(c.command);
			expect(c.value ?? '').not.toMatch(/[\r\n]/);
		}
		expectBufferIs(pre, 'first' + PASTE_MIXED_NORMALIZED + ' line\nsecond line\n');
		expect(windowState.dirty).toBe(true);
	});

	it('空行を含む貼り付けは insertLineBreak が続けて呼ばれ、空行が保たれる', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, TXT_CONTENT.length);
		const calls = installFakeExecCommand();

		await dispatchPaste(pre, { 'text/plain': 'X\r\n\r\nY\n' });

		expect(effectiveCalls(calls)).toEqual([
			'insertText:X',
			'insertLineBreak',
			'insertLineBreak',
			'insertText:Y',
			'insertLineBreak',
		]);
		expectBufferIs(pre, TXT_CONTENT + 'X\n\nY\n');
	});

	it('text/plain が空なら execCommand を呼ばない', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);
		const calls = installFakeExecCommand();

		const ev = await dispatchPaste(pre, { 'text/plain': '', 'text/html': PASTE_HTML });

		expect(ev.defaultPrevented).toBe(true);
		expect(calls).toEqual([]);
		expect(pre.textContent).toBe(TXT_CONTENT);
		expect(windowState.dirty).toBe(false);
	});

	it('execCommand が false を返す環境では、Return をキャレットの位置へ直接差し込んでバッファを揃える', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);
		const calls = installFakeExecCommand({ returns: false });

		const ev = await pressKey(pre);

		expect(ev.defaultPrevented).toBe(true);
		// コマンドは試されたが使えなかった(false)ので、直接差し込む。
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expectBufferIs(pre, 'first\n line\nsecond line\n');
		expect(windowState.dirty).toBe(true);
	});

	it('execCommand が false を返す環境では、貼り付けも直接差し込んでバッファを揃える', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);
		installFakeExecCommand({ returns: false });

		const ev = await dispatchPaste(pre, { 'text/plain': PASTE_MIXED, 'text/html': PASTE_HTML });

		expect(ev.defaultPrevented).toBe(true);
		expectBufferIs(pre, 'first' + PASTE_MIXED_NORMALIZED + ' line\nsecond line\n');
		expect(windowState.dirty).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC (d) — 保存(⌘S)で入れた改行がディスクへ向かう content に入る
// ---------------------------------------------------------------------------

describe('AC-48-追n (d) — 保存で入れた改行が save_document の content に入る', () => {
	it('Return と貼り付けのあと、⌘S の門が開き、save_document の content に `\\n` が入り、成功で dirty が消える', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);
		await pressKey(pre);
		// 'first\n' の直後=2 行目の先頭(' line' の前)に貼る。
		placeCaret(pre, MID_FIRST + 1);
		await dispatchPaste(pre, { 'text/plain': 'pasted\r\n', 'text/html': '<p>pasted</p>' });
		const expected = 'first\npasted\n line\nsecond line\n';
		expectBufferIs(pre, expected);

		// ⌘S の門(+page.svelte の saveCurrentEdits が見るもの=追補i)。
		expect(
			shouldSaveOnCommand({
				mode: windowState.editMode,
				dirty: windowState.dirty,
				externalRemoved: windowState.externalRemoved,
			}),
		).toBe(true);
		invokeMock.mockResolvedValueOnce(undefined);

		await saveDocument(TXT_URI, windowState.editBuffer ?? '');

		expect(invokeMock).toHaveBeenCalledWith('save_document', { uri: TXT_URI, content: expected });
		expect(windowState.currentDocument?.content).toBe(expected);
		expect(windowState.dirty).toBe(false);
		// 保存後も編集は続き、DOM は入れたまま。
		expect(windowState.editMode).toBe('edit');
		expect(pre.textContent).toBe(expected);
	});

	it('WebKit の経路(偽の execCommand)で入れた改行も save_document の content に入る', async () => {
		const { container } = renderText();
		const pre = await enterSourceEdit(container, TXT_CONTENT);
		placeCaret(pre, MID_FIRST);
		installFakeExecCommand();
		await pressKey(pre);
		placeCaret(pre, MID_FIRST + 1);
		await dispatchPaste(pre, { 'text/plain': 'pasted\r\n' });
		const expected = 'first\npasted\n line\nsecond line\n';
		expectBufferIs(pre, expected);
		invokeMock.mockResolvedValueOnce(undefined);

		await saveDocument(TXT_URI, windowState.editBuffer ?? '');

		expect(invokeMock).toHaveBeenCalledWith('save_document', { uri: TXT_URI, content: expected });
		expect(windowState.dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC (e) — 閲覧中・ブロック編集・コード編集・HTML の編集面には付かない(契約5)
// ---------------------------------------------------------------------------

/** AC (e) の markdown: 段落(要件#49 のブロック編集)とトップレベル fence(要件#52)。 */
const BLOCKS_URI = 'file:///Users/a/notes/blocks.md';
const BLOCKS_MD = ['# Title', '', 'First paragraph.', '', '```json', '{', '  "a": 1', '}', '```', ''].join('\n');

/** AC (e) の html(要件#53 の編集面)。Viewer.htmledit.wiring.test.ts と同形。 */
const HTML_URI = 'file:///Users/a/site/page.html';
const HTML_SRC = [
	'<!doctype html>',
	'<html>',
	'<head>',
	'<title>Page</title>',
	'</head>',
	'<body>',
	'<p id="a" class="x">Hello <b>bold</b> &amp; world</p>',
	'<h2 id="h">Heading</h2>',
	'</body>',
	'</html>',
	'',
].join('\n');
const HTML_COMMIT_HI = HTML_SRC.replace('Hello <b>', 'Hi <b>');

describe('AC-48-追n (e) — 閲覧中・ブロック編集・コード編集・HTML の編集面には付かない(契約5)', () => {
	let blocks: { html: string; index: SourceIndex };

	beforeAll(async () => {
		const result = await renderMarkdown(BLOCKS_MD, BLOCKS_URI);
		blocks = { html: result.html, index: result.index };
		expect(blocks.index.byId.size).toBeGreaterThan(0);
	});

	function renderBlocksDoc() {
		const doc: DocumentPayload = { uri: BLOCKS_URI, content: BLOCKS_MD, modified: 1 };
		windowState.setDocument(doc);
		return render(Viewer, { props: baseProps(doc, blocks.html, blocks.index) });
	}

	function editables(scope: ParentNode): HTMLElement[] {
		return [...scope.querySelectorAll('[contenteditable="true"]')] as HTMLElement[];
	}

	it('閲覧中の text の pre: Return も貼り付けも止めず、何も入らず閲覧のまま', async () => {
		const { container } = renderText();
		const pre = getPre(container);
		expect(isEditable(pre)).toBe(false);
		const before = pre.textContent;
		placeCaret(pre, MID_FIRST);

		const key = await pressKey(pre);
		const paste = await dispatchPaste(pre, { 'text/plain': PASTE_MIXED });

		expect(key.defaultPrevented).toBe(false);
		expect(paste.defaultPrevented).toBe(false);
		expect(pre.textContent).toBe(before);
		expect(pre.textContent).not.toContain(PASTE_MIXED_NORMALIZED);
		expect(windowState.editMode).toBe('view');
		expect(windowState.dirty).toBe(false);
		expect(windowState.editBuffer).toBe(null);
		expect(isEditable(getPre(container))).toBe(false);
	});

	it('markdown のブロック編集(段落・要件#49): Return も貼り付けも止めず、段落に `\\n` は入らず、ソース編集の pre も出ない', async () => {
		const { container } = renderBlocksDoc();
		const p = container.querySelector('p[data-vellis-node-type="paragraph"]') as HTMLElement;
		expect(p).toBeTruthy();
		await fireEvent.dblClick(p);
		await settle();
		expect(editables(container)).toEqual([p]);
		const before = p.textContent;
		placeCaret(p, 5);

		const key = await pressKey(p);
		const paste = await dispatchPaste(p, { 'text/plain': PASTE_MIXED, 'text/html': PASTE_HTML });

		// 要件#49 のブロック編集には Return / 貼り付けの自前処理が無い(既存のまま)。
		expect(key.defaultPrevented).toBe(false);
		expect(paste.defaultPrevented).toBe(false);
		expect(p.textContent).toBe(before);
		expect(p.textContent).not.toContain('\n');
		expect(sourcePre(container)).toBeNull();
		expect(windowState.editBuffer === null || windowState.editBuffer === BLOCKS_MD).toBe(true);
		expect(windowState.dirty).toBe(false);
	});

	it('コードブロックの編集(要件#52): Return は自前の `\\n`(既存)で、バッファは確定まで動かない・ソース編集の pre も出ない', async () => {
		const { container } = renderBlocksDoc();
		const fence = [...container.querySelectorAll('pre')].find((el) =>
			(el.textContent ?? '').includes('"a"'),
		) as HTMLElement;
		expect(fence).toBeTruthy();
		await fireEvent.dblClick(fence);
		await settle();
		const list = editables(container);
		expect(list).toHaveLength(1);
		const ed = list[0]!;
		const beforeCount = (ed.textContent?.match(/\n/g) ?? []).length;
		placeCaret(ed, (ed.textContent ?? '').length);

		const key = await pressKey(ed);

		// 要件#52 契約②: 改行が 1 つ増え、編集は続く。
		expect(key.defaultPrevented).toBe(true);
		expect((ed.textContent?.match(/\n/g) ?? []).length).toBe(beforeCount + 1);
		expect(editables(container)).toHaveLength(1);
		// ソース編集の経路(契約3=即バッファへ)とは違い、確定するまでバッファは動かない。
		expect(windowState.editBuffer === null || windowState.editBuffer === BLOCKS_MD).toBe(true);
		expect(windowState.dirty).toBe(false);
		expect(sourcePre(container)).toBeNull();
	});

	it('HTML の編集面(要件#53): 段落の Return は確定で、原文に `\\n` は入らず、ソース編集の pre も出ない', async () => {
		const doc: DocumentPayload = { uri: HTML_URI, content: HTML_SRC, modified: 1 };
		windowState.setDocument(doc);
		const { container } = render(Viewer, { props: baseProps(doc, '') });
		expect(windowState.beginEdit()).toBe(true);
		await settle();
		const host = container.querySelector('[data-testid="html-edit-surface"]') as HTMLElement;
		expect(host).toBeTruthy();
		const shadow = host.shadowRoot as ShadowRoot;
		expect(shadow).toBeTruthy();
		const a = shadow.querySelector('#a') as HTMLElement;
		a.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true }));
		await settle();
		expect(editables(shadow)).toEqual([a]);
		expect(a.firstChild?.nodeType).toBe(3);
		(a.firstChild as Text).nodeValue = 'Hi ';

		a.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, composed: true }),
		);
		await settle();

		// 要件#53 契約⑥: Enter は確定(改行ではない)。
		expect(isEditable(a)).toBe(false);
		expect(windowState.editBuffer).toBe(HTML_COMMIT_HI);
		expect(windowState.dirty).toBe(true);
		expect(sourcePre(container)).toBeNull();
	});
});
