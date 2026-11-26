/**
 * 要件#89 の受け入れテスト(docs/requirements/req-89.md)— 重なりを選んでマージする画面の配線(component プロジェクト)
 * AC-89-6(契約8・9)・AC-89-7(契約10・11)・AC-89-8(契約12)・AC-89-9(契約13)。モデルの純関数は merge-chunks.acceptance.test.ts。
 *
 * ## 確定契約(implementer はこれに従う=test-writer が固定・2026-11-26)
 *
 * ```ts
 * // --- src/editor/file-editor.ts に足す(どの面も実装する。テストの代役の handle は持たなくてよいので省略可の形)
 * export interface FileEditorHandle { …;
 *   /**
 *    * マージの Apply(契約11): `merged` を面に**取引 1 つ**で入れる(履歴に積む=Command + Z 1 回で前の文字列に戻る。
 *    * 外部変更の取り込みの replaceText とは違い addToHistory は true)。基準の版を `disk`(マージに使ったディスクの版)にし、
 *    * 重なりを下ろす(conflict=false・theirs=null)。dirty は文字列の比較のまま(merged !== disk なら Unsaved)。
 *    * 次の Command + S は expectedHash()=contentHash(disk) で照合する。
 *    *\/
 *   applyMerge?(merged: string, disk: string): void;
 * }
 * // --- src/components/EditorDiffView.svelte のマージの形(新しい部品は作らない=implementer の判断 2026-11-26: design-tokens-stage2 の部品の集合を
 * //     動かさない・由谷の決定「今の Show Differences の画面を広げる」。ペインの文書の場所に重ねる 1 枚・印刷では隠す)
 * //   マージの形の入力: base(基準の版)・mine(今の文字列)・theirs(ディスクの版)・rebuilt(作り直しの印=boolean)・onCancel・onApply(merged: string)
 * //   <section class="merge-view" data-testid="merge-view" role="dialog" aria-label="Merge Changes">
 * //     header: 題 'Merge Changes'・<button data-testid="merge-cancel">Cancel</button>・<button data-testid="merge-apply" disabled={未選択あり}>Apply</button>
 * //     {#if rebuilt} <div data-testid="merge-rebuilt-notice" role="status">The file on disk changed again. The chunks were rebuilt.</div>
 * //     本体: mergeChunks(base, mine, theirs) の並び。clean は文脈として出してよい(testid は固定しない)。conflict ごとに
 * //       <div class="merge-chunk" data-testid="merge-chunk" data-index={塊の番号(0 始まり)}>
 * //         <pre data-testid="merge-chunk-mine">{mine}</pre> <pre data-testid="merge-chunk-theirs">{theirs}</pre>
 * //         <button data-testid="merge-choose-mine" aria-pressed>My Edits</button>
 * //         <button data-testid="merge-choose-theirs" aria-pressed>On Disk</button>
 * //         <button data-testid="merge-choose-both" aria-pressed>Both</button>      (選ぶと aria-pressed="true"・他は "false")
 * //     mergeChunks が null なら本体は <p data-testid="merge-too-many">Too many differences to merge.</p> だけで Apply は押せない
 * //   選びの状態は塊の並び(conflict の番号)で持ち、theirs が変わって作り直すときは carryChoices で引き継ぐ
 * // --- src/components/EditorDiffView.svelte
 * //   衝突のとき(onKeep / onUseDisk があるとき)の footer に <button data-testid="editor-diff-merge">Merge…</button>(onMerge?: () => void)。未保存の差分には出さない
 * // --- src/components/Viewer.svelte
 * //   重なりの帯に 4 つ目 <button data-testid="external-conflict-merge">Merge…</button> → mergeView を開く
 * //     (base=handle.baseText()・mine=handle.text()・theirs=await handle.conflictText()=届いた内容か、保存の照合の衝突ならディスクを読み直した内容)
 * //   差分の画面(衝突)の Merge… も同じ(差分の画面は閉じる)
 * //   開いている間に外部変更がまた届いて重なりの中身が変わったら theirs を取り直して作り直し、rebuilt を立てる(知る口は実装の自由。推奨: 面の
 * //   version を、重なりの相手(theirs)が変わるときも進める)。重なりが解けた(conflict=false)・面が替わったら閉じる
 * //   Cancel → 閉じるだけ(文書・帯はそのまま)。Apply(merged) → handle.applyMerge(merged, theirs) → 閉じる(帯は conflict=false で下りる)
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - 3 つの選び方のラベルは英語の UI に合わせ 'My Edits' / 'On Disk' / 'Both'(帯の 'Keep My Edits' / 'Use the File on Disk' と同じ語)。
 *   本テストは testid と aria-pressed で判定し、ラベルの字面は固定しない(Apply / Cancel / Merge… は固定)
 * - 作り直しの知らせの文言は推奨(上)だが、固定するのは testid と role=status だけ
 * - 開いている間に届いた外部変更が重ならなくなった(面が取り込んで conflict が下りた)ときは画面を閉じる(差分の画面と同じ家風)
 * - Markdown の面の Apply は raw の間も効く(raw の CodeMirror に取引 1 つ)。rendered では replaceChangedBlocks と同じ当て方だが履歴に積む
 *
 * ## 修正前に赤になる理由
 * - `external-conflict-merge` も `merge-view` も無く、`src/editor/merge-chunks.ts` が無い(import で落ちる)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EditorView } from '@codemirror/view';
import { undo as cmUndo, undoDepth as cmUndoDepth } from '@codemirror/commands';
import { undo as pmUndo, undoDepth as pmUndoDepth } from 'prosemirror-history';
import { TextSelection } from 'prosemirror-state';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { contentHash } from '$lib/document-edit';
import { SAVE_CONFLICT_PREFIX, saveFileEditor, type FileEditorHandle, type MarkdownEditorHandle } from '../editor/file-editor';
import { applyChoices, mergeChunks, type MergeChoice, type MergePart } from '../editor/merge-chunks';
import { textSpots } from '../editor/markdown.testkit';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn(), save: vi.fn() }));
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
	};
});
import { invoke } from '$lib/ipc';
const invokeMock = vi.mocked(invoke);
const alertMock = vi.fn();

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

const REPO_ROOT = resolve(__dirname, '../..');
const TXT_URI = 'file:///Users/a/notes/memo.txt';
const MD_URI = 'file:///Users/a/notes/plan.md';
const TXT = 'first line\nsecond line\nthird line\n';
const MD = '# Plan\n\nIntro **bold** word.\n\nSecond paragraph.\n\nTail paragraph.\n';

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
async function mountText(content = TXT, uri = TXT_URI) {
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
function q(container: ParentNode, testid: string): HTMLElement | null {
	return container.querySelector(`[data-testid="${testid}"]`);
}
function all(container: ParentNode, testid: string): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)];
}
function must(container: ParentNode, testid: string): HTMLElement {
	const el = q(container, testid);
	if (!el) throw new Error(`[data-testid="${testid}"] が無い`);
	return el;
}
function handle(): FileEditorHandle {
	const h = windowState.fileEditor;
	if (!h) throw new Error('windowState.fileEditor が登録されていない');
	return h;
}
function text(): string {
	return handle().text();
}
function cmView(container: ParentNode): EditorView {
	const root = container.querySelector<HTMLElement>('[data-testid="code-editor"]');
	if (!root) throw new Error('コードの面が無い');
	const v = EditorView.findFromDOM(root);
	if (!v) throw new Error('EditorView.findFromDOM が null');
	return v;
}
function typeCm(view: EditorView, s: string, at = 0) {
	view.dispatch({ changes: { from: at, insert: s }, selection: { anchor: at + s.length }, userEvent: 'input.type' });
}
function conflictsOf(parts: MergePart[] | null): Array<{ mine: string; theirs: string }> {
	return (parts ?? []).filter((p): p is { kind: 'conflict'; mine: string; theirs: string } => p.kind === 'conflict');
}
/** 画面の塊を読む(番号順)。 */
function chunks(container: ParentNode): Array<{ index: string; mine: string; theirs: string; pressed: Record<MergeChoice, string | null> }> {
	return all(container, 'merge-chunk').map((el) => ({
		index: el.getAttribute('data-index') ?? '',
		mine: el.querySelector('[data-testid="merge-chunk-mine"]')?.textContent ?? '',
		theirs: el.querySelector('[data-testid="merge-chunk-theirs"]')?.textContent ?? '',
		pressed: {
			mine: el.querySelector('[data-testid="merge-choose-mine"]')?.getAttribute('aria-pressed') ?? null,
			theirs: el.querySelector('[data-testid="merge-choose-theirs"]')?.getAttribute('aria-pressed') ?? null,
			both: el.querySelector('[data-testid="merge-choose-both"]')?.getAttribute('aria-pressed') ?? null,
		},
	}));
}
const strip = (s: string) => s.replace(/(\r\n|\r|\n)$/, '');
/** 画面の塊が mergeChunks の conflict と同じ(順も・中身も)。 */
function expectChunksMatch(container: ParentNode, base: string, mine: string, theirs: string) {
	const parts = mergeChunks(base, mine, theirs);
	expect(parts, 'mergeChunks は塊を返す').not.toBeNull();
	const expected = conflictsOf(parts);
	const shown = chunks(container);
	expect(shown.map((c) => c.index)).toEqual(expected.map((_, i) => String(i)));
	expect(shown.map((c) => strip(c.mine))).toEqual(expected.map((c) => strip(c.mine)));
	expect(shown.map((c) => strip(c.theirs))).toEqual(expected.map((c) => strip(c.theirs)));
	return parts!;
}
async function choose(container: ParentNode, index: number, choice: MergeChoice) {
	const chunk = all(container, 'merge-chunk')[index];
	if (!chunk) throw new Error(`merge-chunk ${index} が無い`);
	const button = chunk.querySelector<HTMLElement>(`[data-testid="merge-choose-${choice}"]`);
	if (!button) throw new Error(`merge-choose-${choice} が無い`);
	await fireEvent.click(button);
	await settleLong();
}
function applyButton(container: ParentNode): HTMLButtonElement {
	return must(container, 'merge-apply') as HTMLButtonElement;
}
/** dirty のコードの面に、1 行目と 3 行目で重なる外部変更を届けて帯を出す。 */
async function makeTwoConflicts(container: HTMLElement) {
	const view = cmView(container);
	typeCm(view, 'MINE ', 0);
	typeCm(view, 'MINE ', view.state.doc.line(3).from);
	await settle();
	const theirs = TXT.replace('first line', 'THEIRS first line').replace('third line', 'THEIRS third line');
	expect(windowState.applyFileChanged(doc(TXT_URI, theirs))).toBe('external-conflict');
	await settleLong();
	expect(q(container, 'external-conflict-banner')).not.toBeNull();
	return { mine: text(), theirs, view };
}
/** dirty のコードの面に、1 行目だけで重なる外部変更(3 行目は theirs だけが変えた=自動で入る)。 */
async function makeOneConflict(container: HTMLElement) {
	const view = cmView(container);
	typeCm(view, 'MINE ', 0);
	await settle();
	const theirs = TXT.replace('first line', 'THEIRS first line').replace('third line', 'THEIRS third line');
	expect(windowState.applyFileChanged(doc(TXT_URI, theirs))).toBe('external-conflict');
	await settleLong();
	expect(q(container, 'external-conflict-banner')).not.toBeNull();
	return { mine: text(), theirs, view };
}
async function openMerge(container: HTMLElement) {
	await fireEvent.click(must(container, 'external-conflict-merge'));
	await settleLong();
	await new Promise((r) => setTimeout(r, 20));
	await settle();
	return must(container, 'merge-view');
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
	alertMock.mockReset();
	vi.stubGlobal('alert', alertMock);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AC-89-6: Merge… の入口と塊の並び(契約8・9)', () => {
	it('重なりの帯に external-conflict-merge(Merge…)があり、押すと merge-view(role=dialog)が出て、塊が mergeChunks(基準の版, 今, 届いた内容)の conflict と一致', async () => {
		const { container } = await mountText();
		const { mine, theirs } = await makeTwoConflicts(container);
		const button = must(container, 'external-conflict-merge');
		expect(button.tagName).toBe('BUTTON');
		expect(button.textContent?.trim()).toBe('Merge…');
		expect(q(container, 'merge-view')).toBeNull();
		const view = await openMerge(container);
		expect(view.getAttribute('role')).toBe('dialog');
		expect(view.getAttribute('aria-label')).toBe('Merge Changes');
		const parts = expectChunksMatch(container, TXT, mine, theirs);
		expect(conflictsOf(parts)).toHaveLength(2);
		expect(text(), '開いただけでは文書は変わらない').toBe(mine);
		expect(handle().conflict).toBe(true);
		expect(q(container, 'external-conflict-banner'), '帯はそのまま').not.toBeNull();
	});

	it('重ならない変更は自動で入り塊にならない(3 行目は theirs だけ)・塊ごとに 3 つの選び方(mine / theirs / both)の button がある', async () => {
		const { container } = await mountText();
		const { mine, theirs } = await makeOneConflict(container);
		await openMerge(container);
		const parts = expectChunksMatch(container, TXT, mine, theirs);
		expect(conflictsOf(parts)).toHaveLength(1);
		const chunk = all(container, 'merge-chunk')[0]!;
		for (const choice of ['mine', 'theirs', 'both'] as const) {
			const b = chunk.querySelector<HTMLElement>(`[data-testid="merge-choose-${choice}"]`);
			expect(b, `merge-choose-${choice}`).not.toBeNull();
			expect(b!.tagName).toBe('BUTTON');
			expect(b!.getAttribute('aria-pressed')).toBe('false');
		}
		await choose(container, 0, 'both');
		expect(chunks(container)[0]!.pressed).toEqual({ mine: 'false', theirs: 'false', both: 'true' });
		await choose(container, 0, 'theirs');
		expect(chunks(container)[0]!.pressed).toEqual({ mine: 'false', theirs: 'true', both: 'false' });
	});

	it('差分の画面(衝突)にも editor-diff-merge(Merge…)があり、押すと差分の画面が閉じて merge-view が開く。未保存の差分には無い', async () => {
		const { container } = await mountText();
		const { mine, theirs } = await makeTwoConflicts(container);
		await fireEvent.click(must(container, 'external-conflict-diff'));
		await settleLong();
		const mergeButton = must(container, 'editor-diff-merge');
		expect(mergeButton.textContent?.trim()).toBe('Merge…');
		await fireEvent.click(mergeButton);
		await settleLong();
		await new Promise((r) => setTimeout(r, 20));
		await settle();
		expect(q(container, 'editor-diff'), '差分の画面は閉じる').toBeNull();
		must(container, 'merge-view');
		expectChunksMatch(container, TXT, mine, theirs);
		await fireEvent.click(must(container, 'merge-cancel'));
		await settleLong();
		// 未保存の差分(Unsaved の札)には Merge… は無い
		handle().keepMyEdits();
		await settleLong();
		await fireEvent.click(must(container, 'unsaved-badge'));
		await settleLong();
		must(container, 'editor-diff');
		expect(q(container, 'editor-diff-merge')).toBeNull();
	});

	it('差分が大きすぎるときは merge-too-many が出て Apply は押せない', async () => {
		const n = 3000;
		const mk = (p: string) => Array.from({ length: n }, (_, i) => `${p}${i}\n`).join('');
		const { container } = await mountText(mk('b'));
		const view = cmView(container);
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: mk('m') }, userEvent: 'input.paste' });
		await settle();
		expect(windowState.applyFileChanged(doc(TXT_URI, mk('t')))).toBe('external-conflict');
		await settleLong();
		await openMerge(container);
		expect(must(container, 'merge-too-many').textContent?.trim()).toBe('Too many differences to merge.');
		expect(all(container, 'merge-chunk')).toHaveLength(0);
		expect(applyButton(container).disabled).toBe(true);
	});
});

describe('AC-89-7: Apply / Cancel(契約10・11)', () => {
	it('全部の塊を選ぶまで Apply は disabled。Cancel で閉じて何も変わらない(文書・帯・conflict・dirty)', async () => {
		const { container } = await mountText();
		const { mine, theirs } = await makeTwoConflicts(container);
		await openMerge(container);
		expect(applyButton(container).disabled, '未選択').toBe(true);
		await choose(container, 0, 'mine');
		expect(applyButton(container).disabled, '1 つだけ選んだ').toBe(true);
		await choose(container, 1, 'theirs');
		expect(applyButton(container).disabled, '全部選んだ').toBe(false);
		await fireEvent.click(must(container, 'merge-cancel'));
		await settleLong();
		expect(q(container, 'merge-view')).toBeNull();
		expect(text()).toBe(mine);
		expect(handle().conflict).toBe(true);
		expect(handle().dirty).toBe(true);
		expect(q(container, 'external-conflict-banner')).not.toBeNull();
		expect(handle().expectedHash(), '基準の版は変わらない').toBe(contentHash(TXT));
		expect(await handle().conflictText?.()).toBe(theirs);
	});

	it('Apply: マージした文字列が面に入り(取引 1 つ=undo 1 回で戻る)、基準の版=ディスクの版・帯は下り・Unsaved のまま。次の保存はその版との照合で通る', async () => {
		const { container } = await mountText();
		const { mine, theirs, view } = await makeTwoConflicts(container);
		await openMerge(container);
		const parts = expectChunksMatch(container, TXT, mine, theirs);
		await choose(container, 0, 'mine');
		await choose(container, 1, 'both');
		const expected = applyChoices(parts, ['mine', 'both'])!;
		expect(expected).toBe('MINE first line\nsecond line\nMINE third line\nTHEIRS third line\n');
		const depthBefore = cmUndoDepth(view.state);
		await fireEvent.click(applyButton(container));
		await settleLong();
		expect(q(container, 'merge-view'), '閉じる').toBeNull();
		expect(text()).toBe(expected);
		expect(handle().conflict).toBe(false);
		expect(q(container, 'external-conflict-banner'), '帯は下りる').toBeNull();
		expect(handle().dirty, 'Unsaved のまま(決定⑥)').toBe(true);
		expect(q(container, 'unsaved-badge')).not.toBeNull();
		expect(handle().baseText?.(), '基準の版はマージに使ったディスクの版').toBe(theirs);
		expect(handle().expectedHash()).toBe(contentHash(theirs));
		expect(windowState.currentDocument?.content, '窓の文書もディスクの版に').toBe(theirs);
		expect(cmUndoDepth(view.state) - depthBefore, '取引 1 つ').toBe(1);
		expect(cmUndo(view)).toBe(true);
		await settle();
		expect(text(), 'Command + Z 1 回で前の文字列').toBe(mine);
		expect(handle().dirty).toBe(true);
		// 次の Command + S はディスクの版との照合(expectedHash=contentHash(theirs))で保存できる
		invokeMock.mockResolvedValue(null);
		await saveFileEditor(handle());
		await settleLong();
		expect(invokeMock).toHaveBeenCalledWith('save_document', { uri: TXT_URI, content: mine, expectedHash: contentHash(theirs) });
		expect(handle().dirty).toBe(false);
		expect(handle().conflict).toBe(false);
	});

	it("'theirs' だけを選べば面はディスクの版そのもの(mine の変更は全部重なっていた)", async () => {
		const { container } = await mountText();
		const { theirs } = await makeTwoConflicts(container);
		await openMerge(container);
		await choose(container, 0, 'theirs');
		await choose(container, 1, 'theirs');
		await fireEvent.click(applyButton(container));
		await settleLong();
		expect(text()).toBe(theirs);
		expect(handle().dirty, 'ディスクの版と同じなので Unsaved でない').toBe(false);
		expect(handle().conflict).toBe(false);
	});

	it('Apply の後に保存すると、保存の後の面は基準の版=保存した文字列(dirty でない・帯なし)', async () => {
		const { container } = await mountText();
		const { mine, theirs } = await makeOneConflict(container);
		await openMerge(container);
		const parts = mergeChunks(TXT, mine, theirs)!;
		await choose(container, 0, 'mine');
		const merged = applyChoices(parts, ['mine'])!;
		expect(merged, '重ならない 3 行目は自動で入る').toBe('MINE first line\nsecond line\nTHEIRS third line\n');
		await fireEvent.click(applyButton(container));
		await settleLong();
		expect(text()).toBe(merged);
		await saveFileEditor(handle());
		await settleLong();
		expect(invokeMock).toHaveBeenCalledWith('save_document', { uri: TXT_URI, content: merged, expectedHash: contentHash(theirs) });
		expect(handle().dirty).toBe(false);
		expect(q(container, 'unsaved-badge')).toBeNull();
		expect(q(container, 'external-conflict-banner')).toBeNull();
	});
});

describe('AC-89-8: 開いている間の外部変更(契約12・決定⑦)', () => {
	it('また届いて重なりが変わったら、新しいディスクの版で塊を作り直し、同じ塊の選びは残り、作り直しの知らせが出る', async () => {
		const { container } = await mountText();
		const { mine, theirs } = await makeTwoConflicts(container);
		await openMerge(container);
		expect(q(container, 'merge-rebuilt-notice'), '最初は知らせなし').toBeNull();
		await choose(container, 0, 'mine');
		await choose(container, 1, 'both');
		const theirs2 = theirs.replace('THEIRS third line', 'AGAIN third line');
		expect(windowState.applyFileChanged(doc(TXT_URI, theirs2))).toBe('external-conflict');
		await settleLong();
		await new Promise((r) => setTimeout(r, 20));
		await settle();
		must(container, 'merge-view');
		const parts = expectChunksMatch(container, TXT, mine, theirs2);
		expect(conflictsOf(parts)).toHaveLength(2);
		const shown = chunks(container);
		expect(shown[0]!.pressed, '同じ塊(1 行目)の選びは残る').toEqual({ mine: 'true', theirs: 'false', both: 'false' });
		expect(shown[1]!.pressed, '中身が変わった塊(3 行目)は未選択').toEqual({ mine: 'false', theirs: 'false', both: 'false' });
		expect(applyButton(container).disabled).toBe(true);
		const notice = must(container, 'merge-rebuilt-notice');
		expect(notice.getAttribute('role')).toBe('status');
		expect(notice.textContent?.trim()).not.toBe('');
		expect(text(), '文書は変わらない').toBe(mine);
		// 作り直した塊を選んで Apply → 新しいディスクの版が基準
		await choose(container, 1, 'theirs');
		await fireEvent.click(applyButton(container));
		await settleLong();
		expect(text()).toBe(applyChoices(parts, ['mine', 'theirs']));
		expect(handle().expectedHash()).toBe(contentHash(theirs2));
	});

	it('また届いた変更が重ならなくなった(面が取り込んで帯が下りた)ら画面は閉じる', async () => {
		const { container } = await mountText();
		const { mine } = await makeTwoConflicts(container);
		await openMerge(container);
		expect(windowState.applyFileChanged(doc(TXT_URI, mine))).toBe('apply');
		await settleLong();
		expect(handle().conflict).toBe(false);
		expect(q(container, 'merge-view')).toBeNull();
		expect(q(container, 'external-conflict-banner')).toBeNull();
		expect(text()).toBe(mine);
	});
});

describe('AC-89-9: Markdown(rendered・raw)の面と保存の照合の衝突(契約13)', () => {
	it('Markdown の rendered の面: 塊は原文の文字列(**bold** の記号が見える)。Apply は取引 1 つ(prosemirror-history の undo 1 回で戻る)・基準の版=ディスクの版', async () => {
		const { container } = await mountMd();
		const h = handle() as MarkdownEditorHandle;
		const spot = textSpots(h.view.state.doc, 1)[0]!;
		h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, spot.pos)).insertText('MINE ', spot.pos));
		await settle();
		const mine = text();
		const theirs = MD.replace('Intro **bold** word.', 'THEIRS **bold** word.').replace('Tail paragraph.', 'Tail paragraph (AI).');
		expect(windowState.applyFileChanged(doc(MD_URI, theirs))).toBe('external-conflict');
		await settleLong();
		await openMerge(container);
		const parts = expectChunksMatch(container, MD, mine, theirs);
		expect(conflictsOf(parts)).toHaveLength(1);
		expect(chunks(container)[0]!.mine).toContain('**bold**');
		expect(chunks(container)[0]!.theirs).toContain('THEIRS **bold** word.');
		await choose(container, 0, 'both');
		const expected = applyChoices(parts, ['both'])!;
		expect(expected).toContain('Tail paragraph (AI).');
		const depthBefore = pmUndoDepth(h.view.state);
		await fireEvent.click(applyButton(container));
		await settleLong();
		expect(q(container, 'merge-view')).toBeNull();
		expect(text()).toBe(expected);
		expect(handle().conflict).toBe(false);
		expect(handle().dirty).toBe(true);
		expect(handle().baseText?.()).toBe(theirs);
		expect(handle().expectedHash()).toBe(contentHash(theirs));
		expect(pmUndoDepth(h.view.state) - depthBefore, '取引 1 つ').toBe(1);
		expect(pmUndo(h.view.state, h.view.dispatch)).toBe(true);
		await settle();
		expect(text(), 'undo 1 回で前の文字列').toBe(mine);
	});

	it('Markdown の raw の面でも同じ(raw の CodeMirror に取引 1 つ)', async () => {
		const { container } = await mountMd();
		const h = handle() as MarkdownEditorHandle;
		const spot = textSpots(h.view.state.doc, 1)[0]!;
		h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, spot.pos)).insertText('MINE ', spot.pos));
		await settle();
		h.toggleRaw();
		await settleLong();
		await new Promise((r) => setTimeout(r, 30));
		await settle();
		expect(h.raw).toBe(true);
		const mine = text();
		const theirs = MD.replace('Intro **bold** word.', 'THEIRS **bold** word.');
		expect(windowState.applyFileChanged(doc(MD_URI, theirs))).toBe('external-conflict');
		await settleLong();
		await openMerge(container);
		const parts = expectChunksMatch(container, MD, mine, theirs);
		await choose(container, 0, 'theirs');
		await fireEvent.click(applyButton(container));
		await settleLong();
		expect(text()).toBe(applyChoices(parts, ['theirs']));
		expect(text()).toBe(theirs);
		expect(handle().conflict).toBe(false);
		expect(handle().expectedHash()).toBe(contentHash(theirs));
		expect(h.raw, 'raw のまま').toBe(true);
	});

	it('保存の照合で断られて帯が出た場合(届いた中身が無い)は、ディスクを読んで(open_document)塊を作る', async () => {
		const { container } = await mountText();
		const view = cmView(container);
		typeCm(view, 'MINE ', 0);
		await settle();
		const mine = text();
		const disk = TXT.replace('first line', 'DISK first line').replace('second line', 'DISK second line');
		invokeMock.mockRejectedValueOnce(`${SAVE_CONFLICT_PREFIX} since it was opened. Nothing was written.`);
		await saveFileEditor(handle());
		await settleLong();
		expect(handle().conflict).toBe(true);
		invokeMock.mockImplementation(async (cmd: string) => (cmd === 'open_document' ? doc(TXT_URI, disk) : null));
		await openMerge(container);
		expect(invokeMock).toHaveBeenCalledWith('open_document', { uri: TXT_URI });
		const parts = expectChunksMatch(container, TXT, mine, disk);
		expect(conflictsOf(parts)).toHaveLength(1);
		await choose(container, 0, 'mine');
		await fireEvent.click(applyButton(container));
		await settleLong();
		expect(text()).toBe('MINE first line\nDISK second line\nthird line\n');
		expect(handle().expectedHash(), '基準の版=読んだディスクの版').toBe(contentHash(disk));
		expect(handle().conflict).toBe(false);
		invokeMock.mockImplementation(async () => null);
		await saveFileEditor(handle());
		await settleLong();
		expect(invokeMock).toHaveBeenCalledWith('save_document', { uri: TXT_URI, content: 'MINE first line\nDISK second line\nthird line\n', expectedHash: contentHash(disk) });
	});
});

// ---------------------------------------------------------------------------
// 契約9 の「塊ごとに選ぶ」には中身が読めることが要る(2026-11-26 実機のスクリーンショット: Markdown の段落=1 行が長く、
// 塊の欄が横スクロールで切れて読めなかった → オーケストレーターの判断で固定)
// ---------------------------------------------------------------------------

/** `<style>` の中で、セレクタに `token` を含む規則の宣言(コメントは除く)。 */
function rulesFor(css: string, token: string): Array<{ selector: string; body: string }> {
	const out: Array<{ selector: string; body: string }> = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	for (const m of css.matchAll(re)) {
		const selector = m[1]!.trim();
		if (selector.startsWith('@')) continue;
		if (selector.split(',').some((s) => s.includes(token))) out.push({ selector, body: m[2]! });
	}
	return out;
}
/** 宣言の並びから、最後に書かれた `prop` の値(無ければ null)。 */
function lastDecl(bodies: string[], prop: string): string | null {
	let value: string | null = null;
	for (const body of bodies) {
		for (const m of body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g'))) value = m[1]!.trim();
	}
	return value;
}
const WRAPPING_WHITE_SPACE = /^(pre-wrap|break-spaces)\b/;
const WRAPPING_OVERFLOW = /^(anywhere|break-word)\b/;

describe('契約9(読める塊): 自分の修正 / ディスクの版の欄と前後の文脈の行は長い行を折り返す(横スクロールに頼らない)', () => {
	const src = () => readFileSync(resolve(REPO_ROOT, 'src/components/EditorDiffView.svelte'), 'utf8');
	const styleOf = (s: string) => (s.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');

	function expectWraps(css: string, token: string, what: string) {
		const rules = rulesFor(css, token);
		expect(rules.length, `${what}: ${token} の規則がある`).toBeGreaterThan(0);
		const bodies = rules.map((r) => r.body);
		const ws = lastDecl(bodies, 'white-space');
		expect(ws, `${what}: white-space は pre-wrap か break-spaces(今は ${ws})`).toMatch(WRAPPING_WHITE_SPACE);
		const ow = lastDecl(bodies, 'overflow-wrap') ?? lastDecl(bodies, 'word-break');
		expect(ow, `${what}: overflow-wrap: anywhere / break-word(か word-break: break-word)で長い語も折る(今は ${ow})`).toMatch(WRAPPING_OVERFLOW);
		for (const r of rules) {
			expect(r.body, `${what}: 横スクロール(overflow-x: auto / scroll)に頼らない: ${r.selector}`).not.toMatch(/overflow(?:-x)?\s*:\s*(auto|scroll)/);
		}
		return rules;
	}

	it('ソース: merge-chunk-mine / merge-chunk-theirs の欄(.merge-text)と文脈の行(.merge-context)の CSS が折り返す', () => {
		const s = src();
		const css = styleOf(s);
		const mineTag = s.match(/<pre[^>]*data-testid="merge-chunk-mine"[^>]*>/)?.[0] ?? s.match(/<[a-z]+[^>]*data-testid="merge-chunk-mine"[^>]*>/)?.[0] ?? '';
		expect(mineTag, 'merge-chunk-mine の要素がある').not.toBe('');
		const classes = (mineTag.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean);
		expect(classes.length, '欄に class がある(CSS で折り返しを当てる)').toBeGreaterThan(0);
		const token = `.${classes[classes.length - 1]!}`;
		expectWraps(css, token, '塊の欄');
		expect(s, '文脈の行は .merge-context').toMatch(/class="[^"]*\bmerge-context\b[^"]*"/);
		expectWraps(css, '.merge-context', '文脈の行');
	});

	it('jsdom: 長い 1 行(Markdown の段落)の塊を開くと、欄の要素は折り返す class を持ち、中身は切らずに全部入っている', async () => {
		const longLine = `Paragraph two of the report. ${'It keeps going in one long line of text '.repeat(12)}end.`;
		const base = `# Report\n\n${longLine}\n\nTail paragraph.\n`;
		const { container } = await mountText(base);
		const view = cmView(container);
		typeCm(view, 'MINE ', view.state.doc.line(3).from);
		await settle();
		const theirs = base.replace('Paragraph two', 'THEIRS paragraph two');
		expect(windowState.applyFileChanged(doc(TXT_URI, theirs))).toBe('external-conflict');
		await settleLong();
		await openMerge(container);
		const s = src();
		const css = styleOf(s);
		const mine = must(container, 'merge-chunk-mine');
		const theirsEl = must(container, 'merge-chunk-theirs');
		for (const [el, name] of [[mine, 'mine'], [theirsEl, 'theirs']] as const) {
			const wrapping = [...el.classList].filter((c) => {
				const bodies = rulesFor(css, `.${c}`).map((r) => r.body);
				return WRAPPING_WHITE_SPACE.test(lastDecl(bodies, 'white-space') ?? '');
			});
			expect(wrapping.length, `${name} の欄に折り返しの class が当たる(${[...el.classList].join(' ')})`).toBeGreaterThan(0);
		}
		expect(mine.textContent).toContain(`MINE ${longLine}`);
		expect(theirsEl.textContent).toContain(longLine.replace('Paragraph two', 'THEIRS paragraph two'));
	});
});
