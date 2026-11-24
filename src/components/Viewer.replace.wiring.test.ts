/**
 * 要件#74 第3段 3-3 — 置換の入口と UI(AC-74-55)と面での置換(AC-74-28 の配線)。由谷の決定 2026-11-17 昼: 3-11=コードの面・plain text・raw だけ
 * (Markdown の rendered は (k) のまま出さない)・3-12=Edit ▸ Find and Replace…(Option + Command + F)・置換の欄の Return=Replace・Replace All はボタンだけ。
 * 正本: docs/review/req74-stage34-prep.md の (A) 4 と (B) AC-74-28・AC-74-55。
 *
 * ## 対応する受け入れ基準
 * - AC-74-55(フロント): `menu_find_replace` で、コードと raw の面では検索バーに置換の行(`replace-input`・`replace-one`・`replace-all`)が出て
 *   置換の入力欄にフォーカス(語が空なら検索の入力欄)。Markdown の rendered・読み取り専用では置換の行が出ない(検索バーだけ)。
 *   Command + F(`menu_find`)は置換の行の出し入れを変えない。Close と Esc で行ごと閉じる。置換の行の開閉は窓ごと(ファイルを替えても保つ)
 * - AC-74-28 の配線: Replace は現在の一致だけ(次の現在は替えた文字の終わり以降の最初の一致=CodeMirror の選択もそこ)・Replace All は
 *   取引 1 つ(undo 1 回で原文)・件数は替えた後の数・語が空なら何もしない・置換の語が空なら消す・`isComposing` の Enter では替えない・
 *   dirty は文字列の比較・替えなかった範囲は byte 等価(CRLF)
 *
 * ## 確定契約(implementer はこれに従う。純関数と handle の口は src/editor/cm-replace.acceptance.test.ts の先頭)
 *
 * ```ts
 * // --- FindBar.svelte に足す props(文言は英語)
 * //   replaceOpen: boolean・replaceQuery: string・onReplaceQueryChange(value)・onReplace()・onReplaceAll()
 * //   2 段目(replaceOpen のとき): <input data-testid="replace-input" aria-label="Replace with" placeholder="Replace">
 * //     <button data-testid="replace-one">Replace</button> <button data-testid="replace-all">Replace All</button>
 * //   置換の入力欄の Enter=onReplace(isComposing の Enter は送らない)。Replace All にキーは無い
 * // --- Viewer.svelte
 * //   $lib/events の listen(MENU_FIND_REPLACE_EVENT) → 置換を出せる面(windowState.fileEditor の replaceCurrent が関数=コード・plain text・raw・
 * //   読み取り専用でない)なら openFind() + replaceOpen = true + 置換の入力欄にフォーカス(語が空なら検索の入力欄)。出せない面では openFind() だけ
 * //   replaceOpen は窓ごとの $state(文書を替えても保つ)。FindBar には replaceOpen && 置換を出せる面 のときだけ真を渡す
 * //   onReplace → fileEditor.replaceCurrent(replaceQuery)・onReplaceAll → fileEditor.replaceAll(replaceQuery)。件数は面の onFindResults で数え直し、
 * //   現在の番目は面が選んだもの(替えた文字の終わり以降の最初の一致)に合わせる
 * //   closeFind()(Close・Esc)で行ごと閉じる(replaceOpen は窓の状態として残してよいが、バーが閉じれば行も見えない)
 * ```
 *
 * ## 修正前に赤になる理由
 * - Viewer が `menu_find_replace` を購読せず、FindBar に置換の行が無く、handle に replaceCurrent / replaceAll が無い
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { EditorView } from '@codemirror/view';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import { formatCount } from '$lib/find-in-document';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({ mountMermaid: vi.fn(async () => undefined) }));
vi.mock('$lib/events', () => {
	const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
	return {
		listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const cur = handlers.get(event) ?? [];
				const at = cur.indexOf(handler);
				if (at >= 0) cur.splice(at, 1);
			};
		},
		__eventHandlers: handlers,
	};
});
import * as eventsModule from '$lib/events';
const menuHandlers = (eventsModule as unknown as { __eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>> }).__eventHandlers;

/** menu.rs の MENU_FIND_EVENT / MENU_FIND_REPLACE_EVENT と同綴り(値固定は unit 側)。 */
const MENU_FIND = 'menu_find';
const MENU_FIND_REPLACE = 'menu_find_replace';
const NO_RESULTS = formatCount(0, 0, 'q');

beforeAll(() => {
	const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
	const emptyRects = () => Object.assign([] as DOMRect[], { item: (_i: number) => null }) as unknown as DOMRectList;
	const rangeProto = Range.prototype as unknown as Record<string, unknown>;
	if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = emptyRects;
	if (typeof rangeProto.getBoundingClientRect !== 'function') rangeProto.getBoundingClientRect = zeroRect;
	if (typeof (document as unknown as Record<string, unknown>).elementFromPoint !== 'function') {
		(document as unknown as Record<string, unknown>).elementFromPoint = () => null;
	}
});

const TXT_URI = 'file:///Users/a/notes/memo.txt';
const TXT_B_URI = 'file:///Users/a/notes/other.txt';
const SSH_TXT_URI = 'ssh://host/srv/notes/memo.txt';
const MD_URI = 'file:///Users/a/notes/plan.md';
const MD = '# Plan\n\nIntro cat paragraph.\n\nSecond cat.\n';

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
function plainHtml(content: string): string {
	return `<pre class="vellis-plaintext">\n${content.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)}</pre>`;
}
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false };
}
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}
async function settleLong() {
	await settle();
	await new Promise((r) => setTimeout(r, 0));
	await settle();
}
async function wait(ms: number) {
	await new Promise((r) => setTimeout(r, ms));
	await settle();
}
async function mountText(content: string, uri = TXT_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const result = render(Viewer, { props: baseProps(d, plainHtml(content), null) });
	await settleLong();
	return result;
}
async function mountMd(content = MD, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index) });
	await settleLong();
	return result;
}
async function emit(event: string) {
	await settle();
	const list = [...(menuHandlers.get(event) ?? [])];
	expect(list.length, `Viewer が $lib/events の listen で '${event}' を購読していること`).toBeGreaterThan(0);
	for (const h of list) h({ payload: undefined });
	await settleLong();
}
function q(container: ParentNode, testid: string): HTMLElement | null {
	return container.querySelector(`[data-testid="${testid}"]`);
}
function must(container: ParentNode, testid: string): HTMLElement {
	const el = q(container, testid);
	if (!el) throw new Error(`[data-testid="${testid}"] が無い`);
	return el;
}
async function typeInto(el: HTMLElement, value: string) {
	await fireEvent.input(el, { target: { value } });
	await settleLong();
	await wait(30);
}
function countText(container: ParentNode): string {
	return (q(container, 'find-count')?.textContent ?? '').trim();
}
function cmView(container: ParentNode): EditorView {
	const root = container.querySelector<HTMLElement>('[data-testid="code-editor"], [data-testid="raw-source-editor"]');
	if (!root) throw new Error('CodeMirror の面が無い');
	const v = EditorView.findFromDOM(root);
	if (!v) throw new Error('EditorView.findFromDOM が null');
	return v;
}
function text(): string {
	const h = windowState.fileEditor;
	if (!h) throw new Error('windowState.fileEditor が無い');
	return h.text();
}
async function keyOn(el: Element, key: string, init: KeyboardEventInit = {}) {
	el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true, ...init }));
	await settleLong();
	await wait(30);
}
/** 置換の行を開き、語と置換の語を入れる。 */
async function openReplace(container: HTMLElement, query: string, replacement: string) {
	await emit(MENU_FIND_REPLACE);
	await typeInto(must(container, 'find-input'), query);
	await typeInto(must(container, 'replace-input'), replacement);
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	menuHandlers.clear();
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('AC-74-55: Find and Replace… の入口と置換の行', () => {
	it('コードの面(plain text)で menu_find_replace → 検索バー+置換の行(入力欄・Replace・Replace All。文言は英語)。語が空なので検索の入力欄にフォーカス', async () => {
		const { container } = await mountText('one two one\n');
		await emit(MENU_FIND_REPLACE);
		expect(q(container, 'find-bar')).not.toBeNull();
		const input = must(container, 'replace-input') as HTMLInputElement;
		expect(input.tagName).toBe('INPUT');
		expect(input.getAttribute('aria-label')).toBe('Replace with');
		expect(input.getAttribute('placeholder')).toBe('Replace');
		expect(must(container, 'replace-one').textContent?.trim()).toBe('Replace');
		expect(must(container, 'replace-all').textContent?.trim()).toBe('Replace All');
		expect(document.activeElement).toBe(must(container, 'find-input'));
		expect(container.querySelectorAll('[data-testid="find-bar"]')).toHaveLength(1);
	});

	it('語が入っているときの menu_find_replace は置換の入力欄にフォーカス', async () => {
		const { container } = await mountText('one two one\n');
		await emit(MENU_FIND);
		await typeInto(must(container, 'find-input'), 'two');
		await emit(MENU_FIND_REPLACE);
		expect(document.activeElement).toBe(must(container, 'replace-input'));
		expect((must(container, 'find-input') as HTMLInputElement).value).toBe('two');
	});

	it('menu_find(Command + F)だけでは置換の行は出ない。行が出た後の menu_find は行を閉じない', async () => {
		const { container } = await mountText('one two one\n');
		await emit(MENU_FIND);
		expect(q(container, 'find-bar')).not.toBeNull();
		expect(q(container, 'replace-input')).toBeNull();
		await emit(MENU_FIND_REPLACE);
		expect(q(container, 'replace-input')).not.toBeNull();
		await emit(MENU_FIND);
		expect(q(container, 'replace-input'), 'Command + F は行の出し入れを変えない').not.toBeNull();
		expect(document.activeElement).toBe(must(container, 'find-input'));
	});

	it('Markdown の rendered では menu_find_replace でも置換の行が出ない(検索バーだけ=(k))', async () => {
		const { container } = await mountMd();
		await emit(MENU_FIND_REPLACE);
		expect(q(container, 'find-bar')).not.toBeNull();
		expect(q(container, 'replace-input')).toBeNull();
		expect(q(container, 'replace-one')).toBeNull();
		expect(q(container, 'replace-all')).toBeNull();
	});

	it('raw(View ▸ Raw Source)では置換の行が出て、raw の文字列に当たる', async () => {
		const { container } = await mountMd();
		(windowState.fileEditor as MarkdownEditorHandle).toggleRaw();
		await settleLong();
		await wait(30);
		await openReplace(container, 'cat', 'dog');
		expect(countText(container)).toBe('1 of 2');
		await fireEvent.click(must(container, 'replace-one'));
		await settleLong();
		await wait(30);
		expect(text()).toBe('# Plan\n\nIntro dog paragraph.\n\nSecond cat.\n');
		expect(countText(container)).toBe('1 of 1');
		await fireEvent.click(must(container, 'replace-all'));
		await settleLong();
		await wait(30);
		expect(text()).toBe('# Plan\n\nIntro dog paragraph.\n\nSecond dog.\n');
		expect(countText(container)).toBe(NO_RESULTS);
	});

	it('読み取り専用の面(SSH の text)では検索バーだけで置換の行は出ない', async () => {
		const { container } = await mountText('one two one\n', SSH_TXT_URI);
		await emit(MENU_FIND_REPLACE);
		expect(q(container, 'find-bar')).not.toBeNull();
		expect(q(container, 'replace-input')).toBeNull();
	});

	it('Close で行ごと閉じる。Esc(置換の入力欄で)でも行ごと閉じる', async () => {
		const { container } = await mountText('one two one\n');
		await emit(MENU_FIND_REPLACE);
		await fireEvent.click(must(container, 'find-close'));
		await settleLong();
		expect(q(container, 'find-bar')).toBeNull();
		expect(q(container, 'replace-input')).toBeNull();

		await emit(MENU_FIND_REPLACE);
		expect(q(container, 'replace-input')).not.toBeNull();
		await keyOn(must(container, 'replace-input'), 'Escape');
		expect(q(container, 'find-bar')).toBeNull();
		expect(q(container, 'replace-input')).toBeNull();
	});

	it('置換の行の開閉は窓ごと: 別の text の文書に替えても行は出たまま', async () => {
		const { container, rerender } = await mountText('one two one\n');
		await emit(MENU_FIND_REPLACE);
		expect(q(container, 'replace-input')).not.toBeNull();
		const b = doc(TXT_B_URI, 'alpha beta\n');
		windowState.setDocument(b);
		await rerender(baseProps(b, plainHtml('alpha beta\n'), null));
		await settleLong();
		await wait(30);
		expect(q(container, 'find-bar')).not.toBeNull();
		expect(q(container, 'replace-input')).not.toBeNull();
	});
});

describe('AC-74-28(配線): 面での Replace / Replace All', () => {
	it('Replace は現在の一致だけ。次の現在は替えた文字の終わり以降の最初の一致(cat → concat で 2 of 3・選択もそこ)。dirty になる', async () => {
		const { container } = await mountText('cat cat cat\n');
		await openReplace(container, 'cat', 'concat');
		expect(countText(container)).toBe('1 of 3');
		await fireEvent.click(must(container, 'replace-one'));
		await settleLong();
		await wait(30);
		expect(text()).toBe('concat cat cat\n');
		expect(countText(container), '替えた文字(concat)の中の cat で止まらない').toBe('2 of 3');
		const sel = cmView(container).state.selection.main;
		expect([sel.from, sel.to]).toEqual([7, 10]);
		expect(windowState.fileEditor?.dirty).toBe(true);
	});

	it('置換の入力欄の Enter=Replace(isComposing の Enter は替えない)。最後の一致を替えたら先頭へ回る', async () => {
		const { container } = await mountText('a1 a2\n');
		await openReplace(container, 'a', 'b');
		const input = must(container, 'replace-input');
		await keyOn(input, 'Enter', { isComposing: true });
		expect(text(), '変換確定の Enter では替えない').toBe('a1 a2\n');
		await keyOn(input, 'Enter');
		expect(text()).toBe('b1 a2\n');
		expect(countText(container)).toBe('1 of 1');
		await keyOn(input, 'Enter');
		expect(text()).toBe('b1 b2\n');
		expect(countText(container)).toBe(NO_RESULTS);
		await keyOn(input, 'Enter');
		expect(text(), '一致が無ければ何もしない').toBe('b1 b2\n');
	});

	it('Replace All は全部を取引 1 つで。件数は替えた後の数。Control + Z 1 回で原文(dirty でない)', async () => {
		const { container } = await mountText('one two one\nTWO\n');
		await openReplace(container, 'two', 'x');
		expect(countText(container)).toBe('1 of 2');
		await fireEvent.click(must(container, 'replace-all'));
		await settleLong();
		await wait(30);
		expect(text()).toBe('one x one\nx\n');
		expect(countText(container)).toBe(NO_RESULTS);
		expect(windowState.fileEditor?.dirty).toBe(true);
		const view = cmView(container);
		view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
		await settleLong();
		await wait(30);
		expect(text()).toBe('one two one\nTWO\n');
		expect(windowState.fileEditor?.dirty).toBe(false);
	});

	it('語が空なら Replace も Replace All も何もしない。置換の語が空なら一致を消す', async () => {
		const { container } = await mountText('a-b-c\n');
		await emit(MENU_FIND_REPLACE);
		await typeInto(must(container, 'replace-input'), 'zzz');
		await fireEvent.click(must(container, 'replace-one'));
		await fireEvent.click(must(container, 'replace-all'));
		await settleLong();
		expect(text()).toBe('a-b-c\n');
		expect(windowState.fileEditor?.dirty).toBe(false);
		await typeInto(must(container, 'find-input'), '-');
		await typeInto(must(container, 'replace-input'), '');
		await fireEvent.click(must(container, 'replace-all'));
		await settleLong();
		await wait(30);
		expect(text()).toBe('abc\n');
	});

	it('`$&` と `\\n` は文字どおり', async () => {
		const { container } = await mountText('x\n');
		await openReplace(container, 'x', '$&\\n');
		await fireEvent.click(must(container, 'replace-one'));
		await settleLong();
		expect(text()).toBe('$&\\n\n');
	});

	it('CRLF の文書で Replace All しても替えなかった範囲は byte 等価', async () => {
		const { container } = await mountText('alpha\r\nbeta\r\nalpha\r\n');
		await openReplace(container, 'alpha', 'A');
		await fireEvent.click(must(container, 'replace-all'));
		await settleLong();
		await wait(30);
		expect(text()).toBe('A\r\nbeta\r\nA\r\n');
	});
});

// 第3段の P3 の穴(後追いの固定): P11
describe('P3 P11: 置換の行を Close したあとの Command + F(Find… だけ)では置換の行は出ない', () => {
	it('Find and Replace… → Close → menu_find → 検索バーだけ(replace-input なし)。もう一度 Find and Replace… で行が戻る', async () => {
		const { container } = await mountText('one two one\n');
		await emit(MENU_FIND_REPLACE);
		expect(q(container, 'replace-input')).not.toBeNull();
		await fireEvent.click(must(container, 'find-close'));
		await settleLong();
		expect(q(container, 'find-bar')).toBeNull();
		await emit(MENU_FIND);
		expect(q(container, 'find-bar')).not.toBeNull();
		expect(q(container, 'replace-input'), 'Command + F では置換の行は出ない').toBeNull();
		expect(q(container, 'replace-one')).toBeNull();
		await emit(MENU_FIND_REPLACE);
		expect(q(container, 'replace-input')).not.toBeNull();
	});
});
