/**
 * 要件#48 追補r の受け入れテスト(docs/requirements/req-48.md「追補r」・Issue #767)
 * — ソース編集の `<pre contenteditable>` の末尾に置く見えない改行(番兵)の配線
 * (component プロジェクト)
 *
 * WebKit は `white-space: pre-wrap` の contenteditable で、文書の末尾の `\n` を
 * 「空の最後の行を見せるための仮の改行」として扱う。最後の行で Return → 文字を
 * 打つと末尾の改行が消え(`abc\n` → `abc\nx`)、末尾に改行の無い文書で Return だけ
 * 押すと 1 つ多くなる(`abc` → `abc\n\n`)。追補r は編集の `<pre>` の中身を
 * 「原文 + `\n`」にし(番兵が仮の改行の役を受け持つ)、バッファは末尾の `\n` を
 * 1 つ除いて取り、入力で番兵が消えたら DOM で付け直す。ここは `Viewer.svelte` を
 * JSDOM にマウントし、**`<pre>` の中身 ↔ 編集バッファ ↔ 保存の IPC** の配線を判定する。
 * 追補n の wiring(Viewer.source-edit-newline.wiring.test.ts)は契約6 の比較の部分だけ
 * 直し、本追補用に新設(家風はそこに倣う)。
 *
 * ## 判定するもの(契約番号は req-48.md 追補r の 1〜7・AC は AC-48-追r の (a)〜(g))
 * - **契約1・2・7**: 編集に入ると `<pre>` の `textContent` は「原文 + `\n`」、
 *   編集バッファは原文そのもの(番兵を除く)、dirty ではない。`abc\n`・`abc`・CRLF・
 *   空の文書・markdown のソース編集で同じ。`contenteditable="true"` のまま
 * - **AC (c)・契約2・5**: 何もしなければ dirty にならず、⌘S の門は開かず、Done /
 *   Esc は何も聞かずに閲覧へ戻る。バッファをそのまま保存すると content は原文と
 *   byte 等価(番兵はファイルに書かない)
 * - **契約3**: 入力のあと `<pre>` の中身が `\n` で終わっていなければ(WebKit が仮の
 *   改行を消した=テストでは DOM のテキストノードを書き換えて `input` を送る)、
 *   末尾に `\n` が 1 つだけ足される。キャレット(潰れた選択も範囲も)は動かない。
 *   `\n` で終わっていれば足さない(2 つにならない)。中身が空になっても番兵 1 つ。
 *   取り消しで番兵ごと戻っても・番兵だけ残っても、バッファは正しく dirty でない
 * - **AC (a)(b)(d)・契約1〜3**: WebKit の仮の改行を偽物の `execCommand` で再現し
 *   (下の「偽物の約束」)、`abc` の末尾で Return → バッファ `abc\n`・`abc\n` の行末で
 *   Return → `x` → `abc\nx\n`・`abc` の末尾に `one\ntwo\n` を貼る → `abcone\ntwo\n`
 *   (1 つ多くない)。保存の content も同じ
 * - **AC (e)・契約5**: 途中の行の Return → `x`・CRLF の文書・追補n の貼り付けは今まで
 *   どおり(回帰の守り)
 * - **AC (f)・契約5**: 外部変更の取り込み(`applyFileChanged` → `apply`)の後も番兵は
 *   1 つだけ。取り込んだ中身が `\n` で終わらなくても 1 つ。編集と同じ中身の取り込みで
 *   番兵が重ならない
 * - **契約5(追補p)**: Command + E で入るときの閲覧の選択 → 原文の位置の写しが
 *   番兵で変わらない(文書の末尾のキャレットは番兵の手前に置かれる)
 * - **AC (g)・契約6**: 既存テストの無改変(契約6 で直したもの以外)は本ファイルでは
 *   判定しない(フルスイート)
 *
 * ## 判定しないもの
 * - 本物の WKWebView の仮の改行の振る舞い・Command + Z・見え方(契約4=最後の空の行が
 *   見える)→ E2E(tests/e2e/specs/req48r-trailing-newline-gate.e2e.ts)と人間ゲート
 * - 検索のハイライト(契約5)=要件#54 の wiring が持つ
 * - 番兵を `bufferFromPre` で除くか Viewer の側で除くかは実装の判断。ここは
 *   `windowState.editBuffer`(Viewer を通った結果)だけを見るので、どちらでも通る
 *
 * ## 偽物の約束(`installFakeExecCommand`)
 * JSDOM には `document.execCommand` が無い。追補n の偽物(`insertLineBreak` は `\n` の
 * 文字・`insertText` は値。どちらも `input` を発火)に、2026-10-29 に WKWebView で
 * 確かめた仮の改行の振る舞いを次のとおり写して足す:
 * - `insertLineBreak`: 入れた `\n` の後ろに何も無い(文書の末尾)なら、WebKit の
 *   `InsertLineBreakCommand` と同じく仮の改行として `\n` をもう 1 つ足す。キャレットは
 *   入れた `\n` の後ろ(仮の改行の手前)。観察: `abc` の末尾で Return → `abc\n\n`
 * - `insertText`: キャレットの後ろが文書の末尾の `\n` 1 文字だけなら、WebKit の
 *   `InsertTextCommand` と同じくその `\n` を仮の改行として消してから入れる。観察:
 *   `abc\n` の `abc` の行末で Return → `x` → `abc\nx`
 * - 途中の行(キャレットの後ろに他の文字がある)では何も特別なことをしない。観察:
 *   `abc\n.x` の `abc` の行末で Return → `x` → `abc\nx\n.x`
 * この偽物は番兵の無い今の実装で Issue #767 の表の 4 行をそのまま再現する(=AC (a)(b)(d)
 * は実装前に赤)。CRLF の `\r` は仮の改行の判定に含めない(本物は E2E の 767-d)。
 *
 * ## スタブの設計(Viewer.edit.wiring.test.ts の家風)
 * - $lib/ipc / @tauri-apps/plugin-opener / @tauri-apps/plugin-dialog(`message` は
 *   edit-guard の関門=呼ばれないことを見る): モジュールモック
 * - $lib/mermaid-mounter: markdown のフィクスチャで mermaid の dynamic import を
 *   発火させない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({
	mountMermaid: vi.fn(async () => undefined),
}));

import { message } from '@tauri-apps/plugin-dialog';
import { invoke } from '$lib/ipc';
import { saveDocument } from '$lib/save-document';
import { shouldSaveOnCommand } from '$lib/document-edit';

const invokeMock = vi.mocked(invoke);
const messageMock = vi.mocked(message);

// ---------------------------------------------------------------------------
// フィクスチャ(fixtures/edit/767-* と同じ中身)
// ---------------------------------------------------------------------------

const TXT_URI = 'file:///Users/a/notes/memo.txt';
/** 767-a: 末尾に改行あり。 */
const LF = 'abc\n';
/** 767-b: 末尾に改行なし。 */
const NOEOL = 'abc';
/** 767-d と同じ形: CRLF。'first' = 0..5・'\r\n' = 5..7・'second' = 7..13・'\r\n' = 13..15。 */
const CRLF = 'first\r\nsecond\r\n';
/** 空の文書。 */
const EMPTY = '';
/** 途中の行の確認: 'abc' = 0..3・'\n' = 3・'.x' = 4..6・'\n' = 6。 */
const MID = 'abc\n.x\n';
const MD_URI = 'file:///Users/a/notes/plan.md';
/** '# Plan' = 0..6・'\n\n' = 6..8・'- item' = 8..14・'\n' = 14。 */
const MD_CONTENT = '# Plan\n\n- item\n';

/** 'abc' の行末(最後の行の末尾=文書の末尾の `\n` の手前)。 */
const END_ABC = 3;

/** 末尾に貼る 2 行(最後に改行あり)。 */
const PASTE_TWO_LINES = 'one\ntwo\n';

function txtDoc(content: string): DocumentPayload {
	return { uri: TXT_URI, content, modified: 1 };
}

/** file-type.ts の renderPlainText と同形のマークアップ(text 種別の html prop)。 */
function plainTextHtml(content: string): string {
	const escaped = content.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
	);
	return `<pre class="vellis-plaintext">\n${escaped}</pre>`;
}

function baseProps(doc: DocumentPayload, html: string) {
	return {
		document: doc,
		html,
		index: null,
		onRequestAddMark: vi.fn(),
		onToggleMarks: vi.fn(),
		marksOpen: false,
	};
}

/** text 文書を windowState と Viewer の両方に載せてマウントする。 */
function renderText(content: string) {
	const doc = txtDoc(content);
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, plainTextHtml(content)) });
}

/**
 * markdown 文書をマウントする(ソース編集の判定用)。html に `data-vellis-node-id`
 * が無く index も null なので、本文のダブルクリックはブロック編集ではなく
 * 要件#48 のソース編集モードへ入る(追補n の wiring と同じ形)。
 */
function renderMarkdownSource() {
	const doc: DocumentPayload = { uri: MD_URI, content: MD_CONTENT, modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, '<h1>Plan</h1>\n<ul><li>item</li></ul>') });
}

function getPre(container: HTMLElement): HTMLElement {
	const pre = container.querySelector('pre.vellis-plaintext');
	if (!pre) throw new Error('pre.vellis-plaintext not found');
	return pre as HTMLElement;
}

function isEditable(el: Element): boolean {
	return el.getAttribute('contenteditable') === 'true';
}

/** ハンドラが await を連ねても連鎖全体を確定させる(edit wiring の家風)。 */
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

/** `<pre>` に要素(`<div>`・`<br>` など)が生えていない=改行は文字として入っている。 */
function expectTextOnly(pre: HTMLElement) {
	expect(pre.childElementCount, 'pre の中に要素が生えていないこと').toBe(0);
	expect(pre.querySelector('div, br')).toBeNull();
}

/**
 * 契約1・2: `<pre>` の中身は「`source` + `\n`」(番兵が 1 つだけ)、編集バッファは
 * `source` そのもの。
 */
function expectSentinelAround(pre: HTMLElement, source: string) {
	expect(pre.textContent, '<pre> の中身は原文 + 番兵の `\\n`(契約1)').toBe(source + '\n');
	expect(windowState.editBuffer, 'バッファは番兵を除いた原文(契約2)').toBe(source);
	expectTextOnly(pre);
}

/** 本文のダブルクリックでソース編集に入り、contenteditable の `<pre>` を返す。 */
async function enterSourceEdit(container: HTMLElement, source: string): Promise<HTMLElement> {
	await fireEvent.dblClick(container.querySelector('.markdown-body') as HTMLElement);
	await settle();
	const pre = getPre(container);
	expect(isEditable(pre), 'ソース編集の pre が contenteditable="true" であること(契約7)').toBe(true);
	expect(windowState.editMode).toBe('edit');
	expectSentinelAround(pre, source);
	expect(windowState.dirty, '入っただけでは dirty にならない').toBe(false);
	return pre;
}

// ---------------------------------------------------------------------------
// キャレット・イベントのヘルパー
// ---------------------------------------------------------------------------

/**
 * 要素の中の文字オフセット(`textContent` 基準)へキャレット(または選択範囲)を置く。
 * テキストノードが複数に割れていても辿れるように、ノードを歩いて割り当てる。
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

/** 選択の両端(`textContent` 基準の文字オフセット)。`el` の中に無ければ null。 */
function selectionOffsets(el: HTMLElement): { start: number; end: number; collapsed: boolean } | null {
	const sel = el.ownerDocument.defaultView?.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
	const offsetOf = (node: Node, offset: number) => {
		const probe = el.ownerDocument.createRange();
		probe.selectNodeContents(el);
		probe.setEnd(node, offset);
		return probe.toString().length;
	};
	return {
		start: offsetOf(range.startContainer, range.startOffset),
		end: offsetOf(range.endContainer, range.endOffset),
		collapsed: range.collapsed,
	};
}

/** キャレットの位置(`textContent` 基準の文字オフセット)。潰れた選択でなければ -1。 */
function caretOffset(el: HTMLElement): number {
	const s = selectionOffsets(el);
	return s && s.collapsed ? s.start : -1;
}

/** keydown(Return)を dispatch して、そのイベントを返す。 */
async function pressReturn(el: HTMLElement): Promise<KeyboardEvent> {
	const ev = new KeyboardEvent('keydown', {
		key: 'Enter',
		code: 'Enter',
		bubbles: true,
		cancelable: true,
	});
	el.dispatchEvent(ev);
	await settle();
	return ev;
}

/** paste を dispatch する(JSDOM に ClipboardEvent が無いので最小のオブジェクトを載せる)。 */
async function dispatchPaste(el: HTMLElement, plain: string): Promise<Event> {
	const ev = new Event('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(ev, 'clipboardData', {
		value: {
			types: ['text/plain'],
			getData: (type: string) => (type === 'text/plain' ? plain : ''),
		},
	});
	el.dispatchEvent(ev);
	await settle();
	return ev;
}

/** WebKit と同じ形の `input` を送る(`oninput` が走る)。 */
async function fireInput(el: HTMLElement, inputType = 'insertText', data: string | null = null) {
	el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }));
	await settle();
}

/**
 * WebKit が仮の改行を消した・取り消しが DOM を戻した、を再現する: `<pre>` の
 * テキストノードを**作り直さずに**中身を `text` へ書き換える(キャレットの載った
 * ノードを生かしたままにするため)。そのうえで `caret`(範囲なら [start, end])に
 * 選択を置き、`input` を送る。
 */
async function rewriteDomAndInput(
	pre: HTMLElement,
	text: string,
	caret: number | [number, number],
	inputType = 'insertText',
) {
	pre.normalize();
	const first = pre.firstChild;
	if (first && first.nodeType === 3) {
		(first as Text).data = text;
		while (first.nextSibling) first.nextSibling.remove();
	} else {
		pre.textContent = text;
	}
	if (Array.isArray(caret)) placeCaret(pre, caret[0], caret[1]);
	else placeCaret(pre, caret);
	await fireInput(pre, inputType);
}

// ---------------------------------------------------------------------------
// 偽の execCommand(WebKit の編集コマンド+仮の改行の振る舞い。約束はヘッダ)
// ---------------------------------------------------------------------------

interface ExecCall {
	command: string;
	value: string | undefined;
}

type FakeExecCommand = (command: string, showUi?: boolean, value?: string) => boolean;

let restoreExecCommand: (() => void) | null = null;

/** `host` の中で、`range` の始まりから末尾までの文字。 */
function textAfter(host: Element, node: Node, offset: number): string {
	const probe = host.ownerDocument.createRange();
	probe.selectNodeContents(host);
	probe.setStart(node, offset);
	return probe.toString();
}

/** `host` の最後のテキストノード。 */
function lastTextNode(host: Element): Text | null {
	const walker = host.ownerDocument.createTreeWalker(host, 4 /* NodeFilter.SHOW_TEXT */);
	let last: Text | null = null;
	while (walker.nextNode()) last = walker.currentNode as Text;
	return last;
}

function installFakeExecCommand(): ExecCall[] {
	const calls: ExecCall[] = [];
	const fake: FakeExecCommand = (command, _showUi, value) => {
		calls.push({ command, value });
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
		range.collapse(true);
		// 約束(insertText): キャレットの後ろが文書の末尾の `\n` 1 文字だけなら、仮の
		// 改行として消してから入れる(`abc\n` の行末で Return → `x` → `abc\nx`)。
		if (command === 'insertText' && text.length > 0) {
			if (textAfter(host, range.startContainer, range.startOffset) === '\n') {
				const last = lastTextNode(host);
				if (last && last.data.endsWith('\n')) last.data = last.data.slice(0, -1);
			}
		}
		if (text.length > 0) {
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
			// WebKit と同じく、キャレットは入れた文字のテキストノードの中(末尾)に置く
			// (`<div>` を生やしたときだけその後ろ)。
			if (tail === first) range.setStart(first, first.data.length);
			else range.setStartAfter(tail);
			range.collapse(true);
			// 約束(insertLineBreak): 入れた `\n` の後ろに何も無ければ、仮の改行を
			// もう 1 つ足す(`abc` の末尾で Return → `abc\n\n`)。キャレットは入れた
			// `\n` の後ろのまま(仮の改行の手前)。
			if (command === 'insertLineBreak' && textAfter(host, range.startContainer, range.startOffset) === '') {
				const placeholder = document.createTextNode('\n');
				tail.parentNode?.insertBefore(placeholder, tail.nextSibling);
			}
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

/** 偽物の WebKit で文字を打つ(E2E の `typeText` と同じ=`insertText` 1 回)。 */
async function typeViaExecCommand(text: string): Promise<boolean> {
	const ok = document.execCommand('insertText', false, text);
	await settle();
	return ok;
}

/** ⌘S の門(+page.svelte の saveCurrentEdits が見るもの=追補i)。 */
function saveGateOpen(): boolean {
	return shouldSaveOnCommand({
		mode: windowState.editMode,
		dirty: windowState.dirty,
		externalRemoved: windowState.externalRemoved,
	});
}

/** バッファを保存し、`save_document` に渡った content を返す。 */
async function saveBuffer(uri: string): Promise<string | null> {
	invokeMock.mockResolvedValueOnce(undefined);
	await saveDocument(uri, windowState.editBuffer ?? '');
	const call = invokeMock.mock.calls.find((c) => c[0] === 'save_document');
	return call ? ((call[1] as { content?: string } | undefined)?.content ?? null) : null;
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
// 契約1・2・7 — 編集に入ると「原文 + `\n`」・バッファは原文・dirty でない
// ---------------------------------------------------------------------------

describe('契約1・2・7 — 編集の <pre> は「原文 + `\\n`」・バッファは番兵を除いた原文', () => {
	const docs: Array<[string, string]> = [
		['abc\\n(末尾に改行あり=767-a)', LF],
		['abc(末尾に改行なし=767-b)', NOEOL],
		['CRLF(767-d の形)', CRLF],
		['空の文書', EMPTY],
		['途中の行のある文書', MID],
	];
	it.each(docs)('%s: textContent は原文 + `\\n`・editBuffer は原文・dirty でない', async (_label, content) => {
		const { container } = renderText(content);

		const pre = await enterSourceEdit(container, content);

		// 番兵は末尾の `\n` 1 文字だけ(2 つにならない・`\r\n` にならない)。
		expect(pre.textContent?.endsWith('\n')).toBe(true);
		expect((pre.textContent ?? '').slice(0, -1)).toBe(content);
		expect(windowState.dirty).toBe(false);
	});

	it('markdown のソース編集(ダブルクリック)でも同じ', async () => {
		const { container } = renderMarkdownSource();

		await enterSourceEdit(container, MD_CONTENT);
	});

	it('Command + E(windowState.beginEdit)で入っても同じ', async () => {
		const { container } = renderText(LF);

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		const pre = getPre(container);
		expect(isEditable(pre)).toBe(true);
		expectSentinelAround(pre, LF);
		expect(windowState.dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC (c) — 何もしなければ dirty にならず、保存は byte 等価(番兵はファイルに書かない)
// ---------------------------------------------------------------------------

describe('AC-48-追r (c) — 何もしなければ dirty にならず、保存は byte 等価・Done は聞かない(契約2・5)', () => {
	const docs: Array<[string, string]> = [
		['abc\\n', LF],
		['abc', NOEOL],
		['CRLF', CRLF],
		['空の文書', EMPTY],
	];
	it.each(docs)('%s: ⌘S の門は閉じたまま・バッファの保存は原文と同じ content・currentDocument は原文のまま', async (_label, content) => {
		const { container } = renderText(content);
		await enterSourceEdit(container, content);

		expect(windowState.dirty).toBe(false);
		expect(saveGateOpen(), 'dirty でないので ⌘S は何もしない').toBe(false);

		// 保存の経路に番兵が入らないこと(バッファそのものを保存しても原文と byte 等価)。
		const saved = await saveBuffer(TXT_URI);
		expect(saved).toBe(content);
		expect(saved).not.toBe(content + '\n');
		expect(windowState.currentDocument?.content).toBe(content);
		expect(windowState.dirty).toBe(false);
	});

	it.each(docs)('%s: Done は何も聞かずに閲覧へ戻る(確認の 1 枚は出ない)', async (_label, content) => {
		const { container } = renderText(content);
		await enterSourceEdit(container, content);

		await fireEvent.click(screen.getByTestId('edit-done'));
		await settle();

		expect(messageMock).not.toHaveBeenCalled();
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(invokeMock).not.toHaveBeenCalledWith('save_document', expect.anything());
		// 閲覧の pre には番兵は無い(閲覧は今までどおり)。閲覧は `{@html}` の HTML の
		// 解析で CRLF が LF 1 文字になる(番兵とは無関係の前からの性質=追補p の
		// Viewer.edit-caret.wiring.test.ts と同じ前提)。
		expect(isEditable(getPre(container))).toBe(false);
		expect(getPre(container).textContent).toBe(content.replace(/\r\n/g, '\n'));
	});

	it('abc\\n: Esc も何も聞かずに閲覧へ戻る', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);

		await fireEvent.keyDown(pre, { key: 'Escape' });
		await settle();

		expect(messageMock).not.toHaveBeenCalled();
		expect(windowState.editMode).toBe('view');
	});

	it('markdown のソース編集でも ⌘S の門は閉じたまま・保存の content は原文と同じ', async () => {
		const { container } = renderMarkdownSource();
		await enterSourceEdit(container, MD_CONTENT);

		expect(saveGateOpen()).toBe(false);
		expect(await saveBuffer(MD_URI)).toBe(MD_CONTENT);
	});
});

// ---------------------------------------------------------------------------
// 契約3 — 番兵が消えたら付け直す(キャレットと選択は動かない・2 つにしない)
// ---------------------------------------------------------------------------

describe('契約3 — 入力で末尾の `\\n` が消えたら 1 つ付け直す。キャレットと選択は動かない', () => {
	it('最後の行に文字を打って WebKit が仮の改行を消した(DOM が `abc\\nx`)→ input → DOM は `abc\\nx\\n`・バッファ `abc\\nx`・キャレットは x の後ろのまま', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);

		// DOM: 'abc\n\n' → 'abc\nx'(番兵が消えた)。キャレットは x の後ろ(5)。
		await rewriteDomAndInput(pre, 'abc\nx', 5);

		expectSentinelAround(pre, 'abc\nx');
		expect(windowState.dirty).toBe(true);
		expect(caretOffset(pre), 'キャレットは動かない(番兵の手前=文書の末尾)').toBe(5);
		expect(isEditable(pre)).toBe(true);
		expect(windowState.editMode).toBe('edit');
	});

	it('途中にキャレットがあっても動かない(行の途中で番兵が消えた形)', async () => {
		const { container } = renderText(MID);
		const pre = await enterSourceEdit(container, MID);

		// 'abc\n.x\n' + 番兵 → 'aXbc\n.x'(末尾の `\n` が消えた)・キャレットは X の後ろ(2)。
		await rewriteDomAndInput(pre, 'aXbc\n.x', 2);

		expectSentinelAround(pre, 'aXbc\n.x');
		expect(caretOffset(pre)).toBe(2);
	});

	it('範囲の選択があっても両端は動かず、潰れない', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);

		// 'abc\nx' に書き換え、'bc' を選んだまま input。
		await rewriteDomAndInput(pre, 'abc\nx', [1, 3]);

		expectSentinelAround(pre, 'abc\nx');
		expect(selectionOffsets(pre)).toEqual({ start: 1, end: 3, collapsed: false });
	});

	it('`\\n` で終わっていれば足さない(番兵が 2 つにならない)・バッファは末尾の 1 つを除いたもの', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);

		await rewriteDomAndInput(pre, 'abc\nx\n', 5);

		expectSentinelAround(pre, 'abc\nx');
		expect(pre.textContent).not.toBe('abc\nx\n\n');
		expect(caretOffset(pre)).toBe(5);
	});

	it('同じ中身で input が続けて来ても番兵は 1 つのまま(冪等)', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);

		await rewriteDomAndInput(pre, 'abc\nx', 5);
		await fireInput(pre);
		await fireInput(pre);

		expectSentinelAround(pre, 'abc\nx');
		expect(caretOffset(pre)).toBe(5);
	});

	it('中身を全部消しても(DOM が空)番兵が 1 つ付き、バッファは空・dirty', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);

		pre.textContent = '';
		await fireInput(pre, 'deleteContentBackward');

		expectSentinelAround(pre, '');
		expect(windowState.dirty).toBe(true);
	});

	it('CRLF の文書で `\\r\\n` の後ろの番兵が消えても、足すのは `\\n` 1 文字(`\\r\\n` にしない)', async () => {
		const { container } = renderText(CRLF);
		const pre = await enterSourceEdit(container, CRLF);

		// 'first\r\nsecond\r\n' + 番兵 → 最後の行に x を打って番兵が消えた形。
		await rewriteDomAndInput(pre, 'first\r\nsecond\r\nx', 16);

		expectSentinelAround(pre, 'first\r\nsecond\r\nx');
		expect(caretOffset(pre)).toBe(16);
	});

	it('取り消しで番兵ごと戻った(DOM が `abc`)→ input(historyUndo)→ 番兵が付き、バッファは原文・dirty でない', async () => {
		const { container } = renderText(NOEOL);
		const pre = await enterSourceEdit(container, NOEOL);
		// 一度編集して dirty にする(末尾で Return を押した形= `abc\n` + 番兵)。
		await rewriteDomAndInput(pre, 'abc\n\n', 4);
		expectSentinelAround(pre, 'abc\n');
		expect(windowState.dirty).toBe(true);

		await rewriteDomAndInput(pre, 'abc', 3, 'historyUndo');

		expectSentinelAround(pre, NOEOL);
		expect(windowState.dirty).toBe(false);
		expect(caretOffset(pre)).toBe(3);
	});

	it('取り消しで番兵だけ残った(DOM が `abc\\n`)→ input(historyUndo)→ バッファは原文・dirty でない・番兵は 1 つ', async () => {
		const { container } = renderText(NOEOL);
		const pre = await enterSourceEdit(container, NOEOL);
		await rewriteDomAndInput(pre, 'abc\n\n', 4);
		expect(windowState.dirty).toBe(true);

		await rewriteDomAndInput(pre, 'abc\n', 3, 'historyUndo');

		expectSentinelAround(pre, NOEOL);
		expect(windowState.dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC (a)(b)(d) — WebKit の仮の改行(偽物)があっても、末尾の改行がずれない
// ---------------------------------------------------------------------------

describe('AC-48-追r (a)(b)(d) — WebKit の仮の改行(偽物の execCommand)で末尾の改行がずれない(契約1〜3)', () => {
	it('(a) `abc` の末尾で Return だけ → バッファ `abc\\n`(1 つ多くない)・保存の content も `abc\\n`', async () => {
		const { container } = renderText(NOEOL);
		const pre = await enterSourceEdit(container, NOEOL);
		const calls = installFakeExecCommand();
		placeCaret(pre, END_ABC);

		const ev = await pressReturn(pre);

		expect(ev.defaultPrevented).toBe(true);
		expect(calls.map((c) => c.command)).toEqual(['insertLineBreak']);
		expectSentinelAround(pre, 'abc\n');
		expect(windowState.dirty).toBe(true);
		expect(caretOffset(pre), 'キャレットは入れた改行の後ろ(番兵の手前)').toBe(END_ABC + 1);

		expect(saveGateOpen()).toBe(true);
		expect(await saveBuffer(TXT_URI)).toBe('abc\n');
		expect(windowState.dirty).toBe(false);
		// 保存の後も番兵は 1 つのまま($effect が書き戻さない)。
		expectSentinelAround(pre, 'abc\n');
	});

	it('(b) `abc\\n` の `abc` の行末で Return → `x` → バッファ `abc\\nx\\n`(末尾の改行が消えない)・保存の content も同じ', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		installFakeExecCommand();
		placeCaret(pre, END_ABC);

		await pressReturn(pre);
		expectSentinelAround(pre, 'abc\n\n');
		expect(caretOffset(pre)).toBe(END_ABC + 1);
		expect(await typeViaExecCommand('x')).toBe(true);

		expectSentinelAround(pre, 'abc\nx\n');
		expect(caretOffset(pre)).toBe(END_ABC + 2);
		expect(windowState.dirty).toBe(true);
		expect(await saveBuffer(TXT_URI)).toBe('abc\nx\n');
	});

	it('(b) の変形: `abc` の末尾で Return → `x` → `abc\\nx`(今までどおり正しい)', async () => {
		const { container } = renderText(NOEOL);
		const pre = await enterSourceEdit(container, NOEOL);
		installFakeExecCommand();
		placeCaret(pre, END_ABC);

		await pressReturn(pre);
		await typeViaExecCommand('x');

		expectSentinelAround(pre, 'abc\nx');
		expect(await saveBuffer(TXT_URI)).toBe('abc\nx');
	});

	it('最後の空の行(末尾の改行の後ろ)で文字を打つと `abc\\nx`(ほかのエディタと同じ=不具合ではない)', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		installFakeExecCommand();
		placeCaret(pre, LF.length);

		await typeViaExecCommand('x');

		expectSentinelAround(pre, 'abc\nx');
		expect(caretOffset(pre)).toBe(LF.length + 1);
	});

	it('(d) `abc` の末尾に `one\\ntwo\\n` を貼る → バッファ `abcone\\ntwo\\n`(1 つ多くない)・保存の content も同じ', async () => {
		const { container } = renderText(NOEOL);
		const pre = await enterSourceEdit(container, NOEOL);
		installFakeExecCommand();
		placeCaret(pre, END_ABC);

		const ev = await dispatchPaste(pre, PASTE_TWO_LINES);

		expect(ev.defaultPrevented).toBe(true);
		expectSentinelAround(pre, NOEOL + PASTE_TWO_LINES);
		expect(caretOffset(pre), 'キャレットは貼った文字の後ろ(番兵の手前)').toBe((NOEOL + PASTE_TWO_LINES).length);
		expect(windowState.dirty).toBe(true);
		expect(await saveBuffer(TXT_URI)).toBe(NOEOL + PASTE_TWO_LINES);
	});

	it('(d) の変形: `abc\\n` の最後の空の行に `one\\ntwo\\n` を貼る → `abc\\none\\ntwo\\n`', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		installFakeExecCommand();
		placeCaret(pre, LF.length);

		await dispatchPaste(pre, PASTE_TWO_LINES);

		expectSentinelAround(pre, LF + PASTE_TWO_LINES);
		expect(await saveBuffer(TXT_URI)).toBe(LF + PASTE_TWO_LINES);
	});

	it('(a) の後に続けてもう一度 Return → `abc\\n\\n`(番兵は 1 つのまま)', async () => {
		const { container } = renderText(NOEOL);
		const pre = await enterSourceEdit(container, NOEOL);
		installFakeExecCommand();
		placeCaret(pre, END_ABC);

		await pressReturn(pre);
		await pressReturn(pre);

		expectSentinelAround(pre, 'abc\n\n');
		expect(caretOffset(pre)).toBe(END_ABC + 2);
	});

	it('execCommand が無い環境(JSDOM の既定=直接差し込み)でも (a)(b)(d) と同じバッファ', async () => {
		const { container } = renderText(NOEOL);
		const pre = await enterSourceEdit(container, NOEOL);
		placeCaret(pre, END_ABC);

		await pressReturn(pre);
		expectSentinelAround(pre, 'abc\n');
		await dispatchPaste(pre, PASTE_TWO_LINES);

		expectSentinelAround(pre, 'abc\n' + PASTE_TWO_LINES);
		expect(await saveBuffer(TXT_URI)).toBe('abc\n' + PASTE_TWO_LINES);
	});
});

// ---------------------------------------------------------------------------
// AC (e) — 途中の行・CRLF・追補n の貼り付けは今までどおり(回帰の守り)
// ---------------------------------------------------------------------------

describe('AC-48-追r (e) — 途中の行・CRLF・追補n の貼り付けは今までどおり(契約5)', () => {
	it('途中の行(`abc\\n.x\\n` の `abc` の行末)で Return → `x` → `abc\\nx\\n.x\\n`', async () => {
		const { container } = renderText(MID);
		const pre = await enterSourceEdit(container, MID);
		installFakeExecCommand();
		placeCaret(pre, END_ABC);

		await pressReturn(pre);
		await typeViaExecCommand('x');

		expectSentinelAround(pre, 'abc\nx\n.x\n');
		expect(caretOffset(pre)).toBe(END_ABC + 2);
		expect(await saveBuffer(TXT_URI)).toBe('abc\nx\n.x\n');
	});

	it('途中の行で改行入りの貼り付け → 行がそのまま保たれ、末尾の改行も残る', async () => {
		const { container } = renderText(MID);
		const pre = await enterSourceEdit(container, MID);
		installFakeExecCommand();
		placeCaret(pre, END_ABC);

		await dispatchPaste(pre, 'X\r\nY');

		expectSentinelAround(pre, 'abcX\nY\n.x\n');
	});

	it('CRLF の文書(767-d の形)の最後の行の行末で Return → `x` → 末尾の `\\r\\n` が残る(入れた改行は LF)', async () => {
		const { container } = renderText(CRLF);
		const pre = await enterSourceEdit(container, CRLF);
		installFakeExecCommand();
		// 'second' の末尾(13)= 末尾の `\r\n` の手前。
		placeCaret(pre, 13);

		await pressReturn(pre);
		await typeViaExecCommand('x');

		expectSentinelAround(pre, 'first\r\nsecond\nx\r\n');
		expect(await saveBuffer(TXT_URI)).toBe('first\r\nsecond\nx\r\n');
	});

	it('CRLF の文書で何もせず保存 → byte 等価(`\\r` が落ちない・番兵が入らない)', async () => {
		const { container } = renderText(CRLF);
		await enterSourceEdit(container, CRLF);

		expect(windowState.dirty).toBe(false);
		expect(await saveBuffer(TXT_URI)).toBe(CRLF);
	});

	it('markdown のソース編集の末尾の行で Return → `x` → 末尾の改行が残る(767-e)', async () => {
		const { container } = renderMarkdownSource();
		const pre = await enterSourceEdit(container, MD_CONTENT);
		installFakeExecCommand();
		// '- item' の末尾(14)= 末尾の `\n` の手前。
		placeCaret(pre, 14);

		await pressReturn(pre);
		await typeViaExecCommand('x');

		expectSentinelAround(pre, '# Plan\n\n- item\nx\n');
		expect(await saveBuffer(MD_URI)).toBe('# Plan\n\n- item\nx\n');
	});
});

// ---------------------------------------------------------------------------
// AC (f) — 外部変更の取り込みの後も番兵は 1 つだけ(契約5)
// ---------------------------------------------------------------------------

describe('AC-48-追r (f) — 外部変更の取り込み(apply)の後も番兵は 1 つだけ(契約5)', () => {
	it('dirty でない編集中に外部で書き換わる → <pre> は新しい原文 + `\\n`・バッファは新しい原文・dirty でない', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		const rewritten = 'abc\nnew\n';

		expect(windowState.applyFileChanged({ uri: TXT_URI, content: rewritten, modified: 2 })).toBe('apply');
		await settle();

		expect(getPre(container)).toBe(pre);
		expect(isEditable(pre)).toBe(true);
		expectSentinelAround(pre, rewritten);
		expect(windowState.dirty).toBe(false);
		expect(saveGateOpen()).toBe(false);
	});

	it('取り込んだ中身が `\\n` で終わらなくても番兵は 1 つ', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);

		expect(windowState.applyFileChanged({ uri: TXT_URI, content: 'xyz', modified: 2 })).toBe('apply');
		await settle();

		expectSentinelAround(pre, 'xyz');
		expect(windowState.dirty).toBe(false);
	});

	it('編集と同じ中身の取り込み(追補h 契約3)では番兵が重ならない', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		await rewriteDomAndInput(pre, 'abc\nx', 5);
		expectSentinelAround(pre, 'abc\nx');
		expect(windowState.dirty).toBe(true);

		expect(windowState.applyFileChanged({ uri: TXT_URI, content: 'abc\nx', modified: 2 })).toBe('apply');
		await settle();

		expectSentinelAround(pre, 'abc\nx');
		expect(windowState.dirty).toBe(false);
	});

	it('取り込みの後に最後の行で打って番兵が消えても、やはり 1 つ付け直される', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		const rewritten = 'abc\nnew\n';
		windowState.applyFileChanged({ uri: TXT_URI, content: rewritten, modified: 2 });
		await settle();
		expectSentinelAround(pre, rewritten);

		await rewriteDomAndInput(pre, 'abc\nnew\nx', 9);

		expectSentinelAround(pre, 'abc\nnew\nx');
		expect(caretOffset(pre)).toBe(9);
		expect(windowState.dirty).toBe(true);
	});

	it('取り込みの後の保存にも番兵は入らない', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		windowState.applyFileChanged({ uri: TXT_URI, content: 'abc\nnew\n', modified: 2 });
		await settle();
		await rewriteDomAndInput(pre, 'abc\nnew\nx', 9);

		expect(await saveBuffer(TXT_URI)).toBe('abc\nnew\nx');
		expectSentinelAround(pre, 'abc\nnew\nx');
	});
});

// ---------------------------------------------------------------------------
// 契約5(追補p)— 入るときのキャレットの写しは番兵で変わらない
// ---------------------------------------------------------------------------

describe('契約5(追補p)— Command + E で入るときのキャレットの位置は番兵で変わらない', () => {
	const spots: Array<[string, number]> = [
		['先頭', 0],
		['行の途中', 2],
		['最後の行の行末(末尾の `\\n` の手前)', END_ABC],
		['文書の末尾(末尾の `\\n` の後ろ=番兵の手前)', LF.length],
	];
	it.each(spots)('%s: 閲覧の選択の文字数がそのまま編集の pre のキャレットになり、番兵はその後ろ', async (_label, offset) => {
		const { container } = renderText(LF);
		const view = getPre(container);
		expect(view.textContent).toBe(LF);
		placeCaret(view, offset);

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		const editor = getPre(container);
		expect(isEditable(editor)).toBe(true);
		expectSentinelAround(editor, LF);
		expect(caretOffset(editor)).toBe(offset);
		expect((editor.textContent ?? '').slice(offset)).toBe(LF.slice(offset) + '\n');
	});

	it('範囲の選択も両端がそのまま(文書の末尾まで選んでも番兵は含まない)', async () => {
		const { container } = renderText(LF);
		const view = getPre(container);
		placeCaret(view, 1, LF.length);

		expect(windowState.beginEdit()).toBe(true);
		await settle();

		const editor = getPre(container);
		expectSentinelAround(editor, LF);
		expect(selectionOffsets(editor)).toEqual({ start: 1, end: LF.length, collapsed: false });
	});

	it('末尾に改行の無い文書の末尾(= 番兵の手前)に置かれ、そこで Return → `abc\\n`', async () => {
		const { container } = renderText(NOEOL);
		const view = getPre(container);
		placeCaret(view, NOEOL.length);

		expect(windowState.beginEdit()).toBe(true);
		await settle();
		const editor = getPre(container);
		expect(caretOffset(editor)).toBe(NOEOL.length);
		installFakeExecCommand();

		await pressReturn(editor);

		expectSentinelAround(editor, 'abc\n');
	});
});

// ---------------------------------------------------------------------------
// 契約8 / AC (h) — 取り消し・やり直しで番兵を二重にしない
// ---------------------------------------------------------------------------

/**
 * `<pre>` の中身を、与えたテキストノードの並びに**作り直す**(WebKit が取り消しで
 * 戻した DOM の形を再現する)。選択は `caret`=[ノードの番号, そのノードの中の offset]
 * に置く(取り消しの直後に WebKit がキャレットを置くノードを選べるように)。
 */
function setTextNodes(pre: HTMLElement, pieces: string[], caret: [number, number]) {
	const nodes = pieces.map((p) => pre.ownerDocument.createTextNode(p));
	pre.replaceChildren(...nodes);
	const [index, offset] = caret;
	const sel = pre.ownerDocument.defaultView?.getSelection();
	if (!sel) throw new Error('Selection が取れない');
	sel.collapse(nodes[index]!, offset);
}

/** 選択の始まりが `pre` の中にあるか(ノードが外されて選択が飛んでいないこと)。 */
function selectionInside(pre: HTMLElement): boolean {
	const sel = pre.ownerDocument.defaultView?.getSelection();
	return !!sel && sel.rangeCount > 0 && pre.contains(sel.getRangeAt(0).startContainer);
}

describe('契約8 / AC-48-追r (h) — 取り消し・やり直しの後、末尾に並んだ番兵を 1 つにする(キャレットは動かない)', () => {
	it('取り消し: WebKit が戻した番兵と付け直した番兵が並ぶ(`abc\\n`・`\\n`・`\\n`)→ historyUndo → バッファ `abc\\n`・番兵 1 つ・キャレットは最後の空の行のまま', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		// 最後の空の行で `x` を打ち(番兵が消え、付け直された)、取り消した直後の DOM。
		// キャレットは WebKit が戻した元の番兵のノードの頭(= 原文の 4 文字目)。
		setTextNodes(pre, ['abc\n', '\n', '\n'], [1, 0]);
		expect(pre.textContent).toBe('abc\n\n\n');

		await fireInput(pre, 'historyUndo');

		expectSentinelAround(pre, LF);
		expect(windowState.dirty, '打つ前に戻ったので dirty でない').toBe(false);
		expect(selectionInside(pre), '番兵を減らしても選択は飛ばない').toBe(true);
		expect(caretOffset(pre)).toBe(LF.length);
	});

	it('取り消し: キャレットが原文のノードの末尾にあっても同じ', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		setTextNodes(pre, ['abc\n', '\n', '\n'], [0, 4]);

		await fireInput(pre, 'historyUndo');

		expectSentinelAround(pre, LF);
		expect(windowState.dirty).toBe(false);
		expect(caretOffset(pre)).toBe(LF.length);
	});

	it('やり直し(historyRedo)でも同じく 1 つにする', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		setTextNodes(pre, ['abc\n', '\n', '\n'], [0, 4]);

		await fireInput(pre, 'historyRedo');

		expectSentinelAround(pre, LF);
		expect(windowState.dirty).toBe(false);
		expect(caretOffset(pre)).toBe(LF.length);
	});

	it('取り消しで番兵が 3 つ並んでも 1 つにする', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		setTextNodes(pre, ['abc\n', '\n', '\n', '\n'], [0, 4]);

		await fireInput(pre, 'historyUndo');

		expectSentinelAround(pre, LF);
		expect(caretOffset(pre)).toBe(LF.length);
	});

	it('取り消しの後に番兵が 1 つしか無ければ何も減らさない(打った改行を消さない)', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		// 原文の末尾で Return を 1 回押した形(`abc\n\n` + 番兵)を取り消しで戻した…のではなく、
		// この形がそのまま残った取り消し(途中の編集の取り消し)。原文のノードの末尾の改行は番兵ではない。
		setTextNodes(pre, ['abc\n\n', '\n'], [0, 5]);

		await fireInput(pre, 'historyUndo');

		expectSentinelAround(pre, 'abc\n\n');
		expect(caretOffset(pre)).toBe(5);
	});

	it('普通の入力(insertText・insertLineBreak)では末尾の `\\n\\n` を 1 つにしない(打った改行を消さない)', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		// 最後の空の行で Return を押した直後の形: 原文 `abc\n` + 打った `\n` + 番兵。
		setTextNodes(pre, ['abc\n', '\n', '\n'], [1, 1]);

		await fireInput(pre, 'insertLineBreak');

		expectSentinelAround(pre, 'abc\n\n');
		expect(windowState.dirty).toBe(true);
		expect(caretOffset(pre)).toBe(5);

		setTextNodes(pre, ['abc\n', '\n', '\n'], [1, 1]);
		await fireInput(pre, 'insertText', '\n');

		expectSentinelAround(pre, 'abc\n\n');
	});

	it('偽物の WebKit で辿る: 最後の空の行で `x` → 番兵が付け直される → 取り消しが戻した形 → バッファは打つ前', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		installFakeExecCommand();
		placeCaret(pre, LF.length);
		await typeViaExecCommand('x');
		expectSentinelAround(pre, 'abc\nx');

		// 取り消し: WebKit は `x` を消し、仮の改行として消した `\n` を戻す。付け直した
		// 番兵のノードはそのまま残る(契約8 の観察)。
		setTextNodes(pre, ['abc\n', '\n', '\n'], [1, 0]);
		await fireInput(pre, 'historyUndo');

		expectSentinelAround(pre, LF);
		expect(windowState.dirty).toBe(false);
		expect(caretOffset(pre)).toBe(LF.length);
	});
});

// ---------------------------------------------------------------------------
// 契約9 / AC (i) — コピー・カットで番兵をクリップボードに入れない
// ---------------------------------------------------------------------------

/**
 * copy / cut を dispatch する。JSDOM に `ClipboardEvent` は無いので、`setData` で
 * 書かれたものを集める `clipboardData` の偽物を載せる(追補n の paste と同じ形)。
 * 返り値は、イベントと、書かれた text/plain(無ければ null)。
 */
async function dispatchClipboard(
	el: HTMLElement,
	type: 'copy' | 'cut',
): Promise<{ ev: Event; plain: string | null }> {
	const store: Record<string, string> = {};
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(ev, 'clipboardData', {
		value: {
			get types() {
				return Object.keys(store);
			},
			setData: (t: string, v: string) => {
				store[t] = v;
			},
			getData: (t: string) => store[t] ?? '',
		},
	});
	el.dispatchEvent(ev);
	await settle();
	return { ev, plain: store['text/plain'] ?? null };
}

/** `pre` の中身を全部選ぶ(番兵も含む= WKWebView で全部を選ぶと `abc\n\n` になる形)。 */
function selectAll(pre: HTMLElement) {
	const range = pre.ownerDocument.createRange();
	range.selectNodeContents(pre);
	const sel = pre.ownerDocument.defaultView?.getSelection();
	if (!sel) throw new Error('Selection が取れない');
	sel.removeAllRanges();
	sel.addRange(range);
	expect(range.toString(), '前提: 全部を選ぶと番兵が入る').toBe(pre.textContent ?? '');
}

describe('契約9 / AC-48-追r (i) — 全部を選んでコピー・カットしてもクリップボードは原文と同じ(番兵が入らない)', () => {
	const docs: Array<[string, string]> = [
		['abc\\n', LF],
		['abc', NOEOL],
		['CRLF', CRLF],
	];
	it.each(docs)('%s: 全部を選んでコピー → text/plain は原文(番兵の `\\n` が無い)・既定は止める・DOM は変わらない', async (_label, content) => {
		const { container } = renderText(content);
		const pre = await enterSourceEdit(container, content);
		selectAll(pre);

		const { ev, plain } = await dispatchClipboard(pre, 'copy');

		expect(ev.defaultPrevented, '自前で書くので既定(番兵込み)を止める').toBe(true);
		expect(plain).toBe(content);
		expectSentinelAround(pre, content);
		expect(windowState.dirty).toBe(false);
	});

	it.each(docs)('%s: 全部を選んでカット → text/plain は原文・中身は空になり番兵が 1 つ付け直される・dirty', async (_label, content) => {
		const { container } = renderText(content);
		const pre = await enterSourceEdit(container, content);
		selectAll(pre);

		const { ev, plain } = await dispatchClipboard(pre, 'cut');

		expect(ev.defaultPrevented).toBe(true);
		expect(plain).toBe(content);
		expectSentinelAround(pre, '');
		expect(windowState.dirty).toBe(content.length > 0);
		expect(selectionInside(pre)).toBe(true);
	});

	it('番兵を含む途中からの選択(`c\\n` + 番兵)をコピー → `c\\n`', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		placeCaret(pre, 2, (pre.textContent ?? '').length);

		const { ev, plain } = await dispatchClipboard(pre, 'copy');

		expect(ev.defaultPrevented).toBe(true);
		expect(plain).toBe('c\n');
		expectSentinelAround(pre, LF);
	});

	it('番兵を含む途中からの選択をカット → クリップボードは `c\\n`・バッファは `ab`・番兵 1 つ', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		placeCaret(pre, 2, (pre.textContent ?? '').length);

		const { ev, plain } = await dispatchClipboard(pre, 'cut');

		expect(ev.defaultPrevented).toBe(true);
		expect(plain).toBe('c\n');
		expectSentinelAround(pre, 'ab');
		expect(windowState.dirty).toBe(true);
		expect(caretOffset(pre)).toBe(2);
	});

	it('途中だけを選んだコピー(`bc`)は選んだ文字のまま(自前で書くなら `bc`・既定に任せるなら何も書かない)', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		placeCaret(pre, 1, 3);

		const { ev, plain } = await dispatchClipboard(pre, 'copy');

		if (ev.defaultPrevented) expect(plain).toBe('bc');
		else expect(plain).toBeNull();
		expectSentinelAround(pre, LF);
		expect(selectionOffsets(pre)).toEqual({ start: 1, end: 3, collapsed: false });
	});

	it('原文の末尾まで(番兵の手前まで)の選択のコピーは原文そのもの', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		placeCaret(pre, 0, LF.length);

		const { ev, plain } = await dispatchClipboard(pre, 'copy');

		if (ev.defaultPrevented) expect(plain).toBe(LF);
		else expect(plain).toBeNull();
		expectSentinelAround(pre, LF);
	});

	it('選択が無い(潰れたキャレット)コピー・カットでは何も書かず、DOM もバッファも変わらない', async () => {
		const { container } = renderText(LF);
		const pre = await enterSourceEdit(container, LF);
		placeCaret(pre, 2);

		const copy = await dispatchClipboard(pre, 'copy');
		const cut = await dispatchClipboard(pre, 'cut');

		expect(copy.plain).toBeNull();
		expect(cut.plain).toBeNull();
		expectSentinelAround(pre, LF);
		expect(windowState.dirty).toBe(false);
		expect(caretOffset(pre)).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 契約8 / AC (h) — Return を含む取り消し・やり直しで、打った改行が失われない(4 通り)
// ---------------------------------------------------------------------------
//
// WebKit は Return を `\n` だけの**別のテキストノード**として入れる(番兵と同じ形。
// 2026-10-29 に implementer が WKWebView で確認)。偽物の `insertLineBreak` も `\n` の
// ノードを新しく作って入れるので、ここは偽物で Return / `x` を辿り、取り消し・やり直しは
// WebKit と同じく「同じノードを戻す / 外す」形で DOM を作り直して `input` を送る。
// `\n` だけのノードが並んでいることだけで番兵と見分けて減らす実装は、ここで改行を失う。

/** `pre` の子ノードの並び(同じノードを戻すために控える)。 */
function childNodesOf(pre: HTMLElement): Node[] {
	return [...pre.childNodes];
}

/** `\n` だけのテキストノード(Return で入った改行か番兵)。 */
function lineBreakNodes(nodes: Node[]): Text[] {
	return nodes.filter((n): n is Text => n.nodeType === 3 && (n as Text).data === '\n');
}

/** 最後の空でないノード(番兵の置き場)。 */
function lastNonEmpty(nodes: Node[]): Node {
	for (let i = nodes.length - 1; i >= 0; i--) {
		const n = nodes[i]!;
		if (!(n.nodeType === 3 && (n as Text).data === '')) return n;
	}
	throw new Error('空でないノードが無い');
}

/**
 * WebKit の取り消し・やり直しを再現する: `pre` の子を `nodes`(控えた**同じノード**)に
 * し、キャレットを (node, offset) に置いて、`inputType` の `input` を送る。
 */
async function historyStep(
	pre: HTMLElement,
	nodes: Node[],
	caret: [Node, number],
	inputType: 'historyUndo' | 'historyRedo',
) {
	pre.replaceChildren(...nodes);
	const sel = pre.ownerDocument.defaultView?.getSelection();
	if (!sel) throw new Error('Selection が取れない');
	sel.collapse(caret[0], caret[1]);
	await fireInput(pre, inputType);
}

describe('契約8 / AC-48-追r (h) — Return を含む取り消し・やり直しで打った改行が失われない(4 通り)', () => {
	it('1. `abc` の末尾で Return → 取り消し → やり直し → バッファ `abc\\n`', async () => {
		const { container } = renderText(NOEOL);
		const pre = await enterSourceEdit(container, NOEOL);
		installFakeExecCommand();
		placeCaret(pre, END_ABC);
		const source = pre.firstChild!;

		await pressReturn(pre);
		expectSentinelAround(pre, 'abc\n');
		const afterReturn = childNodesOf(pre);
		// Return の `\n` は別のノード(最初の `\n` のノード)。番兵は最後。
		const inserted = lineBreakNodes(afterReturn)[0]!;
		expect(inserted, 'Return の改行が別のノードで入っていること(前提)').not.toBe(lastNonEmpty(afterReturn));

		// 取り消し: WebKit は入れたノードを外す。
		await historyStep(pre, afterReturn.filter((n) => n !== inserted), [source, END_ABC], 'historyUndo');
		expectSentinelAround(pre, NOEOL);
		expect(windowState.dirty).toBe(false);
		expect(caretOffset(pre)).toBe(END_ABC);

		// やり直し: 同じノードを戻す。打った改行は番兵ではない。
		await historyStep(pre, afterReturn, [inserted, 1], 'historyRedo');

		expectSentinelAround(pre, 'abc\n');
		expect(windowState.dirty).toBe(true);
		expect(caretOffset(pre)).toBe(END_ABC + 1);
	});

	it('2. `abc` の末尾で Return を 2 回 → 1 回取り消し → バッファ `abc\\n`', async () => {
		const { container } = renderText(NOEOL);
		const pre = await enterSourceEdit(container, NOEOL);
		installFakeExecCommand();
		placeCaret(pre, END_ABC);

		await pressReturn(pre);
		await pressReturn(pre);
		expectSentinelAround(pre, 'abc\n\n');
		const afterTwo = childNodesOf(pre);
		const breaks = lineBreakNodes(afterTwo);
		expect(breaks.length, '改行のノード 2 つ + 番兵(前提)').toBe(3);
		const first = breaks[0]!;
		const second = breaks[1]!;

		// 1 回取り消し: 2 回目の Return のノードだけ外れる。
		await historyStep(pre, afterTwo.filter((n) => n !== second), [first, 1], 'historyUndo');

		expectSentinelAround(pre, 'abc\n');
		expect(windowState.dirty).toBe(true);
		expect(caretOffset(pre)).toBe(END_ABC + 1);
	});

	it('3. `abc` の末尾で Return → 最後の行で `x` → 取り消し → バッファ `abc\\n`', async () => {
		const { container } = renderText(NOEOL);
		const pre = await enterSourceEdit(container, NOEOL);
		installFakeExecCommand();
		placeCaret(pre, END_ABC);

		await pressReturn(pre);
		expectSentinelAround(pre, 'abc\n');
		const afterReturn = childNodesOf(pre);
		const inserted = lineBreakNodes(afterReturn)[0]!;
		const sentinel = lastNonEmpty(afterReturn) as Text;
		expect(sentinel.data).toBe('\n');

		// 最後の行(Return の改行の後ろ)で `x`: 偽物の WebKit は番兵を仮の改行として消し、
		// こちらが付け直す。
		expect(caretOffset(pre)).toBe(END_ABC + 1);
		await typeViaExecCommand('x');
		expectSentinelAround(pre, 'abc\nx');
		expect(sentinel.data, '元の番兵は WebKit に消された(前提)').toBe('');
		const afterX = childNodesOf(pre);
		const x = afterX.find((n) => n.nodeType === 3 && (n as Text).data === 'x');
		expect(x).toBeTruthy();

		// 取り消し: WebKit は `x` を外し、消した番兵の `\n` を戻す。付け直した番兵のノードは残る。
		sentinel.data = '\n';
		await historyStep(pre, afterX.filter((n) => n !== x), [inserted, 1], 'historyUndo');

		expectSentinelAround(pre, 'abc\n');
		expect(windowState.dirty).toBe(true);
		expect(caretOffset(pre)).toBe(END_ABC + 1);
	});

	it('4. 原文が `\\n` だけの文書で `x` を打つ → 取り消し → バッファ `\\n`', async () => {
		const NEWLINE_ONLY = '\n';
		const { container } = renderText(NEWLINE_ONLY);
		const pre = await enterSourceEdit(container, NEWLINE_ONLY);
		installFakeExecCommand();
		const before = childNodesOf(pre);
		const source = before[0] as Text;
		expect(source.data, '原文の `\\n` は番兵とは別のノード(前提)').toBe('\n');
		const sentinel = lastNonEmpty(before) as Text;
		expect(sentinel).not.toBe(source);

		// 最後の空の行(原文の `\n` の後ろ)で `x`。
		placeCaret(pre, NEWLINE_ONLY.length);
		await typeViaExecCommand('x');
		expectSentinelAround(pre, '\nx');
		expect(sentinel.data).toBe('');
		const afterX = childNodesOf(pre);
		const x = afterX.find((n) => n.nodeType === 3 && (n as Text).data === 'x');
		expect(x).toBeTruthy();

		sentinel.data = '\n';
		await historyStep(pre, afterX.filter((n) => n !== x), [source, 1], 'historyUndo');

		expectSentinelAround(pre, NEWLINE_ONLY);
		expect(windowState.dirty).toBe(false);
		expect(caretOffset(pre)).toBe(1);
	});
});
