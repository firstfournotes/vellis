/**
 * #835 — Markdown の編集面でタスクリストの印が描かれず、クリックで切り替えられない(要件74 契約17「タスクの印: クリックで切り替わる」・
 * AC-74-21 の面の分。component プロジェクト・JSDOM に Viewer を載せる。AC-74-21 の文書モデルの純関数の分は
 * `src/editor/markdown-document.acceptance.test.ts` にあり、ここは面の wiring(印の DOM・クリックの受け手・取引・読み取り専用)を見る)。
 *
 * ## 確定契約(オーケストレーターの決定 2026-11-24。implementer はこれに従う)
 *
 * ```ts
 * // --- 面のタスクの項目(checked が null でない list_item)ごとに、項目の頭に印として <input type="checkbox"> を出す
 * //   - 置き場: その項目の <li class="task-list-item">(markdown.css の規則が当たる。今の toDOM の class は保つ)の中で、
 * //     項目の本文の最初の文字より前(入れ子の項目の印はその入れ子の li の中)
 * //   - contenteditable="false"・checked は文書(list_item.attrs.checked)の値と一致
 * //   - 印は文書の中身ではない: 書き出し(handle.text())・面の textContent・検索(findMatches(textContent, 語))に出ない
 * // --- 印をクリックすると checked が反転する
 * //   - 取引 1 つ(undoDepth が 1 増える・undo 1 段で元に戻る)
 * //   - 書き出しは `[ ]` ⇄ `[x]` の 1 文字だけが変わり、他は byte 等価(AC-74-21 と同じ)・未保存の印(unsaved-badge)が付く
 * //   - 入れ子のタスク・順序つきリストのタスク(`1. [ ] x`)でも同じ
 * // --- 読み取り専用の面(MarkdownEditor の readOnly=true)では印は出すが押せない(disabled か、押しても文書が変わらない。印の checked は文書の値のまま)
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-24)
 * - 印の置き場は「その `li.task-list-item` の中で本文の最初の文字より前」とだけ固定し、`li` の直下か `<p>` の中か(NodeView か widget か)は
 *   問わない(作りは実装裁量)。入れ子では `input.closest('li') === li` で自分の印だけを数える
 * - クリックは mousedown(button 0)→ mouseup → click の順で送る(本物のクリックと同じ列。ブラウザの既定でチェックボックスは click で
 *   反転するので、実装が mousedown で切り替えるだけだと印と文書がずれる=その検出も兼ねる)
 * - undo は `prosemirror-history` の `undo` 命令を直接当てる(jsdom のキーの写像の差を避ける)
 * - 読み取り専用の面は Viewer を通して作れない(SSH root は今の描画・閾値超えは raw だけ)ので、`MarkdownEditor` を直接 `readOnly=true` で
 *   載せて見る。「押せない」は `disabled` か「文書が不変で印の checked も文書の値のまま」のどちらかで合格
 * - フィクスチャはこのファイルの中に置く(入れ子・順序つき・印の無い項目を 1 つの文書に)
 *
 * ## 修正前に赤になる理由
 * - `list_item.toDOM` は `li.task-list-item[data-checked]` を付けるだけで、`input[type="checkbox"]` が無い(印の describe が全件赤)。
 *   クリックの受け手も無いので切り替えの describe も赤(印が見つからず落ちる)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { undo, undoDepth } from 'prosemirror-history';
import type { EditorView } from 'prosemirror-view';

import Viewer from './Viewer.svelte';
import MarkdownEditor from './MarkdownEditor.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { findMatches } from '$lib/find-in-document';
import type { MarkdownEditorHandle } from '../editor/file-editor';

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
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = { label: 'main', emit: vi.fn(async () => undefined), onFocusChanged: vi.fn(async () => () => {}), listen: vi.fn(async () => () => {}) };
	return { ...actual, getCurrentWindow: () => fake };
});
import { invoke } from '$lib/ipc';

const invokeMock = vi.mocked(invoke);

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

// ---------------------------------------------------------------------------
// フィクスチャと helper
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/tasks.md';

/** 印のある項目は文書の順に 7 つ: open・done / first・second / parent・child・other(入れ子)。plain item には印が無い。 */
const TASKS = [
	'# Tasks',
	'',
	'- [ ] open task',
	'- [x] done task',
	'- plain item',
	'',
	'1. [ ] first step',
	'2. [x] second step',
	'',
	'- [ ] parent',
	'  - [x] child',
	'  - [ ] other child',
	'',
	'Tail.',
	'',
].join('\n');
const EXPECTED_CHECKED = [false, true, false, true, false, true, false];

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
type ViewerProps = { fileEditor?: boolean; zoom?: number; codeTheme?: string };
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null, extra: ViewerProps) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false, ...extra };
}
async function settle(rounds = 8) {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
	await tick();
}
async function settleLong() {
	await settle();
	await new Promise((r) => setTimeout(r, 0));
	await settle();
}
/** Markdown の文書を windowState と Viewer に載せ、fileEditor=true で描く。 */
async function mountMd(content: string, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index, { fileEditor: true }) });
	await settleLong();
	return result;
}
/** 読み取り専用の面: MarkdownEditor を直接 readOnly=true で載せる(Viewer からは作れない=判断の記録)。 */
async function mountReadOnly(content: string, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const result = render(MarkdownEditor, { props: { uri, content, readOnly: true } });
	await settleLong();
	return result;
}

const BODY = 'article.viewer .markdown-body';
const PM_IN_VIEWER = `${BODY} [data-testid="markdown-editor"] .ProseMirror`;
const BADGE = '[data-testid="unsaved-badge"]';

function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
function qa(container: ParentNode, selector: string): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(selector)];
}
function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h) throw new Error('windowState.fileEditor が登録されていない');
	if (h.kind !== 'markdown') throw new Error(`handle.kind が markdown でない: ${String(h.kind)}`);
	return h;
}
function view(): EditorView {
	return handle().view;
}
function text(): string {
	return handle().text();
}
/** 面のタスクの項目(文書の順)。 */
function taskItems(root: ParentNode): HTMLLIElement[] {
	return [...root.querySelectorAll<HTMLLIElement>('li.task-list-item')];
}
/** その項目自身の印(入れ子の項目の印は数えない)。 */
function marksOf(li: HTMLLIElement): HTMLInputElement[] {
	return [...li.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter((input) => input.closest('li') === li);
}
function markOf(li: HTMLLIElement): HTMLInputElement {
	const marks = marksOf(li);
	if (marks.length !== 1) throw new Error(`項目の印がちょうど 1 つでない: ${marks.length}`);
	return marks[0]!;
}
/** 項目の本文の最初の(空白でない)文字のノード。入れ子の項目の文字も含むが、本文は入れ子より前にある。 */
function firstTextNode(li: HTMLLIElement): Text | null {
	const walker = li.ownerDocument.createTreeWalker(li, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	while (node) {
		if ((node.textContent ?? '').trim() !== '') return node as Text;
		node = walker.nextNode();
	}
	return null;
}
/** 文書の list_item(checked が null でない)の checked を文書の順に。 */
function docChecked(v: EditorView): boolean[] {
	const out: boolean[] = [];
	v.state.doc.descendants((n) => {
		if (n.type.name === 'list_item' && n.attrs.checked !== null) out.push(n.attrs.checked as boolean);
		return true;
	});
	return out;
}
/** 2 つの文字列で違う位置(同じ長さが前提)。 */
function changedPositions(a: string, b: string): number[] {
	const out: number[] = [];
	const n = Math.max(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(i);
	return out;
}
/** 本物のクリックと同じ列(mousedown → mouseup → click)。 */
async function userClick(el: Element) {
	await fireEvent.mouseDown(el, { button: 0, buttons: 1 });
	await fireEvent.mouseUp(el, { button: 0 });
	await fireEvent.click(el, { button: 0 });
	await settleLong();
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	invokeMock.mockReset();
	invokeMock.mockImplementation(async () => null);
});
afterEach(() => {
	cleanup();
	windowState.clearDocument();
	windowState.fileEditor = null;
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 印の描画
// ---------------------------------------------------------------------------

describe('#835 契約17: タスクの項目ごとに印(input[type=checkbox])が項目の頭に出る', () => {
	it('印のある項目 7 つにそれぞれちょうど 1 つの印があり、contenteditable=false・checked が文書の値と一致。印の無い項目には無い', async () => {
		const { container } = await mountMd(TASKS);
		const pm = q(container, PM_IN_VIEWER)!;
		expect(pm, '編集面').not.toBeNull();
		const items = taskItems(pm);
		expect(items, 'li.task-list-item の数').toHaveLength(7);
		expect(docChecked(view()), '文書の側の checked(前提)').toEqual(EXPECTED_CHECKED);
		const marks = items.map((li) => marksOf(li));
		expect(marks.map((m) => m.length), '項目ごとの印の数').toEqual([1, 1, 1, 1, 1, 1, 1]);
		for (const [i, [mark]] of marks.entries()) {
			expect(mark!.getAttribute('contenteditable'), `印 ${i} は編集の外`).toBe('false');
			expect(mark!.checked, `印 ${i} の checked`).toBe(EXPECTED_CHECKED[i]);
		}
		// 印の無い項目(plain item)には input が無い
		const plain = qa(pm, 'li').find((li) => (li.textContent ?? '').includes('plain item'))!;
		expect(plain, 'plain item の li').toBeTruthy();
		expect(plain.classList.contains('task-list-item')).toBe(false);
		expect(plain.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
		// 面全体の印の数= 7(余計な印が無い)
		expect(qa(pm, 'input[type="checkbox"]')).toHaveLength(7);
	});

	it('印は項目の本文の最初の文字より前にある(入れ子の項目の印はその入れ子の li の中)', async () => {
		const { container } = await mountMd(TASKS);
		const pm = q(container, PM_IN_VIEWER)!;
		const items = taskItems(pm);
		expect(items).toHaveLength(7);
		for (const [i, li] of items.entries()) {
			const mark = markOf(li);
			const first = firstTextNode(li);
			expect(first, `項目 ${i} の本文`).not.toBeNull();
			expect(
				mark.compareDocumentPosition(first!) & Node.DOCUMENT_POSITION_FOLLOWING,
				`項目 ${i} の印が本文「${first!.textContent?.trim()}」より前にある`,
			).toBeTruthy();
		}
		// 入れ子: parent の li の中の印は 3 つ(自分 + child + other)だが自分のものは 1 つ、child の li の中は 1 つ
		const parent = items.find((li) => (firstTextNode(li)?.textContent ?? '').includes('parent'))!;
		const child = items.find((li) => (firstTextNode(li)?.textContent ?? '').includes('child') && li !== parent)!;
		expect(parent.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
		expect(marksOf(parent)).toHaveLength(1);
		expect(marksOf(child)).toHaveLength(1);
		expect(parent.contains(child)).toBe(true);
	});

	it('印は文書の中身ではない: 書き出しは原文のまま・dirty でない・面の textContent と検索に印の文字が出ない', async () => {
		const { container } = await mountMd(TASKS);
		const pm = q(container, PM_IN_VIEWER)!;
		expect(taskItems(pm)).toHaveLength(7);
		expect(text()).toBe(TASKS);
		expect(handle().dirty).toBe(false);
		expect(q(container, BADGE)).toBeNull();
		const visible = pm.textContent ?? '';
		expect(visible).not.toMatch(/\[[ xX]\]/);
		expect(findMatches(visible, 'open task')).toHaveLength(1);
		expect(findMatches(visible, '[x]')).toHaveLength(0);
		for (const li of taskItems(pm)) expect(markOf(li).textContent ?? '').toBe('');
	});
});

// ---------------------------------------------------------------------------
// クリックで切り替わる
// ---------------------------------------------------------------------------

describe('#835 契約17・AC-74-21: 印をクリックすると checked が反転し、書き出しは `[ ]` ⇄ `[x]` の 1 文字だけが変わる', () => {
	it('未完 → 完了: `- [ ] open task` → `- [x] open task`。他は byte 等価・印と文書の checked が反転・未保存の印が付く・取引 1 つ', async () => {
		const { container } = await mountMd(TASKS);
		const pm = q(container, PM_IN_VIEWER)!;
		const mark = markOf(taskItems(pm)[0]!);
		const depthBefore = undoDepth(view().state);
		await userClick(mark);
		const out = text();
		expect(out).toBe(TASKS.replace('- [ ] open task', '- [x] open task'));
		expect(out.length).toBe(TASKS.length);
		const diff = changedPositions(TASKS, out);
		expect(diff).toHaveLength(1);
		expect(TASKS[diff[0]!]).toBe(' ');
		expect(out[diff[0]!]).toBe('x');
		expect(docChecked(view())).toEqual([true, true, false, true, false, true, false]);
		expect(markOf(taskItems(pm)[0]!).checked, '印の checked が文書に追う').toBe(true);
		expect(handle().dirty).toBe(true);
		expect(q(container, BADGE), '未保存の印').not.toBeNull();
		expect(undoDepth(view().state) - depthBefore, '取引 1 つ').toBe(1);
	});

	it('完了 → 未完: `- [x] done task` → `- [ ] done task`', async () => {
		const { container } = await mountMd(TASKS);
		const pm = q(container, PM_IN_VIEWER)!;
		await userClick(markOf(taskItems(pm)[1]!));
		const out = text();
		expect(out).toBe(TASKS.replace('- [x] done task', '- [ ] done task'));
		const diff = changedPositions(TASKS, out);
		expect(diff).toHaveLength(1);
		expect(TASKS[diff[0]!]).toBe('x');
		expect(out[diff[0]!]).toBe(' ');
		expect(docChecked(view())).toEqual([false, false, false, true, false, true, false]);
		expect(markOf(taskItems(pm)[1]!).checked).toBe(false);
	});

	it('2 回押すと元に戻る(書き出しが原文と byte 等価・dirty でない・印も元の値)', async () => {
		const { container } = await mountMd(TASKS);
		const pm = q(container, PM_IN_VIEWER)!;
		await userClick(markOf(taskItems(pm)[0]!));
		expect(text()).not.toBe(TASKS);
		await userClick(markOf(taskItems(pm)[0]!));
		expect(text()).toBe(TASKS);
		expect(handle().dirty).toBe(false);
		expect(docChecked(view())).toEqual(EXPECTED_CHECKED);
		expect(markOf(taskItems(pm)[0]!).checked).toBe(false);
	});

	it('undo 1 段で元に戻る(書き出しが原文・印の checked も戻る)', async () => {
		const { container } = await mountMd(TASKS);
		const pm = q(container, PM_IN_VIEWER)!;
		await userClick(markOf(taskItems(pm)[0]!));
		expect(text()).toBe(TASKS.replace('- [ ] open task', '- [x] open task'));
		const v = view();
		expect(undo(v.state, v.dispatch), 'undo が効く').toBe(true);
		await settleLong();
		expect(text()).toBe(TASKS);
		expect(docChecked(view())).toEqual(EXPECTED_CHECKED);
		expect(markOf(taskItems(pm)[0]!).checked).toBe(false);
	});

	it('順序つきリストのタスク: `1. [ ] first step` → `1. [x] first step`。他は byte 等価', async () => {
		const { container } = await mountMd(TASKS);
		const pm = q(container, PM_IN_VIEWER)!;
		const first = taskItems(pm).find((li) => (firstTextNode(li)?.textContent ?? '').includes('first step'))!;
		expect(first).toBeTruthy();
		await userClick(markOf(first));
		const out = text();
		expect(out).toBe(TASKS.replace('1. [ ] first step', '1. [x] first step'));
		expect(changedPositions(TASKS, out)).toHaveLength(1);
		expect(docChecked(view())).toEqual([false, true, true, true, false, true, false]);
		expect(markOf(first).checked).toBe(true);
	});

	it('入れ子のタスク: 子 `  - [x] child` → `  - [ ] child`。親の印と書き出しは変わらない', async () => {
		const { container } = await mountMd(TASKS);
		const pm = q(container, PM_IN_VIEWER)!;
		const items = taskItems(pm);
		const parent = items.find((li) => (firstTextNode(li)?.textContent ?? '').includes('parent'))!;
		const child = items.find((li) => (firstTextNode(li)?.textContent ?? '').trim() === 'child')!;
		expect(child, '入れ子の項目 child').toBeTruthy();
		expect(parent.contains(child)).toBe(true);
		await userClick(markOf(child));
		const out = text();
		expect(out).toBe(TASKS.replace('  - [x] child', '  - [ ] child'));
		const diff = changedPositions(TASKS, out);
		expect(diff).toHaveLength(1);
		expect(TASKS[diff[0]!]).toBe('x');
		expect(out[diff[0]!]).toBe(' ');
		expect(docChecked(view())).toEqual([false, true, false, true, false, false, false]);
		expect(markOf(child).checked).toBe(false);
		expect(markOf(parent).checked, '親の印は不変').toBe(false);
	});

	it('入れ子の親の印を押すと親だけが変わる(`- [ ] parent` → `- [x] parent`)', async () => {
		const { container } = await mountMd(TASKS);
		const pm = q(container, PM_IN_VIEWER)!;
		const parent = taskItems(pm).find((li) => (firstTextNode(li)?.textContent ?? '').includes('parent'))!;
		await userClick(markOf(parent));
		const out = text();
		expect(out).toBe(TASKS.replace('- [ ] parent', '- [x] parent'));
		expect(changedPositions(TASKS, out)).toHaveLength(1);
		expect(docChecked(view())).toEqual([false, true, false, true, true, true, false]);
	});

	it('CRLF の文書でも 1 文字だけが変わる(改行コードは保たれる)', async () => {
		const src = TASKS.replace(/\n/g, '\r\n');
		const { container } = await mountMd(src);
		const pm = q(container, PM_IN_VIEWER)!;
		await userClick(markOf(taskItems(pm)[0]!));
		const out = text();
		expect(out).toBe(src.replace('- [ ] open task', '- [x] open task'));
		expect(out.length).toBe(src.length);
		expect(changedPositions(src, out)).toHaveLength(1);
		expect(out).toContain('\r\n');
	});
});

// ---------------------------------------------------------------------------
// 読み取り専用の面
// ---------------------------------------------------------------------------

describe('#835 契約17: 読み取り専用の面では印は出るが押せない', () => {
	it('印は 7 つあり checked が文書の値と一致。押しても文書は変わらず(dirty でない)、印の checked も文書の値のまま(か disabled)', async () => {
		const { container } = await mountReadOnly(TASKS);
		const pm = q(container, '.ProseMirror')!;
		expect(pm, '読み取り専用の編集面').not.toBeNull();
		expect(pm.getAttribute('contenteditable'), '読み取り専用').toBe('false');
		expect(handle().readOnly).toBe(true);
		const items = taskItems(pm);
		expect(items).toHaveLength(7);
		for (const [i, li] of items.entries()) {
			const mark = markOf(li);
			expect(mark.checked, `印 ${i} の checked`).toBe(EXPECTED_CHECKED[i]);
		}
		const mark = markOf(items[0]!);
		const depthBefore = undoDepth(view().state);
		await userClick(mark);
		expect(text(), '文書は不変').toBe(TASKS);
		expect(handle().dirty).toBe(false);
		expect(docChecked(view())).toEqual(EXPECTED_CHECKED);
		expect(undoDepth(view().state), '取引が積まれない').toBe(depthBefore);
		const stillMirrorsDoc = markOf(items[0]!).checked === false;
		expect(mark.disabled || stillMirrorsDoc, '押せない: disabled か、印の checked が文書の値のまま').toBe(true);
	});
});
