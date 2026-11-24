/**
 * 要件#74 第2段 2-3(raw とメニュー)— 面の側の配線(AC-74-9・契約3・23・項目 9・16・21)。
 *
 * **仮の前提(2026-11-17・由谷の確認待ち)**: 2-1・2-2 の判断 1〜3・5・7・8 に加えて、判断 9=Raw Source のチェック印は
 * フロントからのイベント `raw_source_state`(payload `{ label, raw }`)で前面の窓の値を Rust に知らせる・判断 10=別の文書を
 * 開いたら raw を引き継がない。回答が推奨と違えば「判断 9 に依存」「判断 10 に依存」の describe を書き直す。
 *
 * ## 対応する受け入れ基準
 * - AC-74-9  Markdown を開いた直後に ProseMirror の編集面が出て打てる(読み取り専用の描画を経ない)。`MENU_EDIT_EVENT` では何も
 *            変わらない。View ▸ Raw Source のイベントで raw(CodeMirror)に切り替わり、raw の文字列が契約6 の書き出しと一致する。
 *            raw で打って戻すと文書モデルが読み直され、dirty が文字列の比較どおり、カーソルがその位置のブロックにあり、
 *            Command + Z 1 回で raw での編集がまとめて戻る。raw ⇄ rendered の往復で確認が出ない。コードと plain text では
 *            Raw Source のイベントで何も変わらない
 * - 契約23   切り替えでカーソル・選択・dirty を保つ。raw の間の外部変更・保存は第1段の CodeMirror の面と同じ。
 *            IME の変換中は切り替えを確定まで待つ。raw の履歴は raw に入るたびに新しく始まる
 * - 項目 16  raw の間は `.markdown-body` に CSS の zoom を掛けず、CodeMirror の文字の大きさで掛ける
 * - 項目 21  閾値を超えた Markdown(今の描画)でも Raw Source で raw に入れる
 * - 判断 9   raw_source_state を、面が出たとき(文書が変わった)・切り替えたとき・面が消えたときに送る
 * - 契約17・項目 15(第1段の AC-74-31 と同じ規則): raw の面の検索の件数は文書全体の文字列に findMatches を当てた数(画面に
 *            出ていない行も含む)。Next で選択が次の一致へ移り、その取引は scrollIntoView を伴う
 * - F7  閾値超えの raw で dirty のまま Raw Source を押しても今の描画へ戻らず raw のまま(未保存の編集を捨てない)
 * - F9  閾値超えの文書を raw で見ているとき別の閾値超えの文書を開くと raw でなく今の描画(+知らせ)で開く(判断 10 を閾値超えにも)
 * - F15 CRLF の文書で rendered のカーソル・選択が raw の同じ文字を指す(\r\n の 1 文字分のずれが無い)。戻るときも
 * - F16 raw の検索で `İ` の後ろでも一致の装飾の位置が正しい(cm-find.ts の写し直し・第1段の由谷決定 4)
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 第2段の作り(案)9。無いものは test-writer が固定)
 *
 * ```ts
 * // --- src/editor/file-editor.ts に足す
 * export interface MarkdownEditorHandle extends FileEditorHandle {
 *   readonly raw: boolean;          // raw の面を出しているか
 *   toggleRaw(): void;              // rendered ⇄ raw。変換中(view.composing)なら compositionend の後に 1 回だけ切り替える
 *   // raw の間も text() / dirty / expectedHash() / markSaved() / applyFileChanged() / reset() は raw の文字列に対して働く
 * }
 * // --- src/components/RawSourceEditor.svelte(新規・面の中。第1段の CodeMirror の部品を使う)
 * //   根 <div data-testid="raw-source-editor" data-vellis-lang="markdown" style:font-size={zoom≠100 なら `${zoom}%`}> の中に .cm-editor。
 * //   raw の間は markdown-editor の根の中に ProseMirror(.ProseMirror[contenteditable=true])を**出さない**(同じ場所で切り替わる)
 * // --- MarkdownEditor.svelte / Viewer.svelte
 * //   面(Markdown の編集面か、閾値超えの今の描画)は $lib/events の listen(MENU_RAW_SOURCE_EVENT) を購読して handle.toggleRaw()。
 * //   raw の間 Viewer は `.markdown-body` に style:zoom を出さず、RawSourceEditor に zoom を渡す(CodeEditor と同じ)
 * //   面が出たとき(mount)に announceRawSource(false)・切り替えで announceRawSource(raw)・面が消えたとき(unmount)に announceRawSource(false)
 * // --- 閾値超え(項目 21): 今の描画の窓でも MENU_RAW_SOURCE_EVENT で raw(RawSourceEditor)が出て、windowState.fileEditor に
 * //   kind 'markdown'・raw true の handle が登録される(保存・外部変更は第1段と同じ)。もう一度で今の描画に戻る
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-17)
 * - raw の CodeMirror は `EditorView.findFromDOM(.cm-editor)` で取り、`dispatch({ changes })` で打つ(第1段のテストと同じ)。
 *   CRLF の文書では CodeMirror の doc は `\n` なので、カーソルの位置の写しは LF の文書でだけ見る
 * - Rust への emit は `@tauri-apps/api/window` の getCurrentWindow().emit をモックして見る(`$lib/events` の listen は既存のモック)
 *
 * ## 修正前に赤になる理由
 * - handle に `toggleRaw` が無く、`raw-source-editor` の testid も `menu_raw_source` の購読も無い。`src/editor/raw-sync.ts` が無い
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { TextSelection } from 'prosemirror-state';
import { undoDepth } from 'prosemirror-history';
import type { EditorView as PMView } from 'prosemirror-view';
import { EditorView as CMView } from '@codemirror/view';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { contentHash } from '$lib/document-edit';
import { findMatches, formatCount } from '$lib/find-in-document';
import { saveFileEditor, type FileEditorHandle, type MarkdownEditorHandle } from '../editor/file-editor';
import { MARKDOWN_EDIT_LIMIT_BYTES } from '../editor/markdown-limits';
import { MENU_RAW_SOURCE_EVENT, RAW_SOURCE_STATE_EVENT } from '../editor/raw-sync';
import { findField } from '../editor/cm-find';
import { blockPos, fixture, textSpots } from '../editor/markdown.testkit';

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
const windowEmitMock = vi.fn(async (_event: string, _payload?: unknown) => undefined);
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = {
		label: 'main',
		emit: (event: string, payload?: unknown) => windowEmitMock(event, payload),
		onFocusChanged: vi.fn(async () => () => {}),
		listen: vi.fn(async () => () => {}),
	};
	return { ...actual, getCurrentWindow: () => fake };
});
import { ask } from '@tauri-apps/plugin-dialog';
import { invoke } from '$lib/ipc';
import * as eventsModule from '$lib/events';

const askMock = vi.mocked(ask);
const invokeMock = vi.mocked(invoke);
const menuHandlers = (eventsModule as unknown as { __eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>> }).__eventHandlers;

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

const MD_URI = 'file:///Users/a/notes/plan.md';
const TXT_URI = 'file:///Users/a/notes/readme.txt';
const MD = ['# Plan', '', 'Intro paragraph with **bold** word.', '', 'Second paragraph here.', '', '- item one', '- item two', '', 'Tail paragraph.', ''].join('\n');
const RAW_ONLY = fixture('raw-only.md');

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
async function mountMd(content: string, extra: ViewerProps = {}, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index, { fileEditor: true, ...extra }) });
	await settleLong();
	return result;
}
async function mountText(content: string, extra: ViewerProps = {}) {
	const d = doc(TXT_URI, content);
	windowState.setDocument(d);
	const result = render(Viewer, { props: baseProps(d, '', null, { fileEditor: true, ...extra }) });
	await settleLong();
	return result;
}

const FACE = 'article.viewer .markdown-body [data-testid="markdown-editor"]';
const PM = `${FACE} .ProseMirror`;
const RAW = 'article.viewer .markdown-body [data-testid="raw-source-editor"]';
const CM = `${RAW} .cm-editor`;
const BADGE = '[data-testid="unsaved-badge"]';
const TOO_LARGE = '[data-testid="markdown-too-large-notice"]';

function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h) throw new Error('windowState.fileEditor が登録されていない');
	if (h.kind !== 'markdown') throw new Error(`handle.kind が markdown でない: ${String(h.kind)}`);
	return h;
}
function pm(): PMView {
	return handle().view;
}
function text(): string {
	return handle().text();
}
function cm(container: ParentNode): CMView {
	const el = q(container, CM);
	if (!el) throw new Error('raw の CodeMirror が無い');
	const v = CMView.findFromDOM(el as HTMLElement);
	if (!v) throw new Error('EditorView.findFromDOM が null');
	return v;
}
function selectPm(from: number, to = from) {
	const v = pm();
	v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)));
}
function keyPm(k: string, init: KeyboardEventInit = {}) {
	pm().dom.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
}
function compositionPm(kind: 'compositionstart' | 'compositionend') {
	pm().dom.dispatchEvent(new CompositionEvent(kind, { bubbles: true, data: '' }));
}
/** View ▸ Raw Source(lib.rs → 前面の窓の `menu_raw_source`)。 */
async function emitRawSource() {
	await settle();
	const list = [...(menuHandlers.get(MENU_RAW_SOURCE_EVENT) ?? [])];
	expect(list.length, `面が '${MENU_RAW_SOURCE_EVENT}' を購読していること`).toBeGreaterThan(0);
	for (const h of list) h({ payload: undefined });
	await settleLong();
	await new Promise((r) => setTimeout(r, 20));
	await settle();
}
function rawStateCalls(): Array<{ label: string; raw: boolean }> {
	return windowEmitMock.mock.calls.filter(([e]) => e === RAW_SOURCE_STATE_EVENT).map(([, p]) => p as { label: string; raw: boolean });
}
function cmInsert(container: ParentNode, find: string, insert: string, replaceLen = 0) {
	const v = cm(container);
	const at = v.state.doc.toString().indexOf(find);
	expect(at, `raw に "${find}" がある`).toBeGreaterThanOrEqual(0);
	v.dispatch({ changes: { from: at, to: at + replaceLen, insert }, selection: { anchor: at + insert.length } });
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	windowState.externalRemoved = false;
	menuHandlers.clear();
	invokeMock.mockReset();
	invokeMock.mockImplementation(async () => null);
	askMock.mockReset();
	windowEmitMock.mockClear();
	vi.spyOn(window, 'confirm').mockImplementation(() => {
		throw new Error('window.confirm が呼ばれた');
	});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC-74-9: 切り替え
// ---------------------------------------------------------------------------

describe('AC-74-9・契約3: 開いた直後は ProseMirror の編集面(raw でない)で、今の編集の入口(Edit ▸ Edit・ダブルクリック)は無い', () => {
	it('mount 直後: PM が contenteditable・raw-source-editor は無い・handle.raw=false', async () => {
		const { container } = await mountMd(MD);
		expect(q(container, PM)?.getAttribute('contenteditable')).toBe('true');
		expect(q(container, RAW)).toBeNull();
		expect(handle().raw).toBe(false);
		expect(handle().dirty).toBe(false);
	});

	it("menu_edit の受け手は無く(Edit ▸ Edit は撤去)、ダブルクリックでも何も変わらない", async () => {
		const { container } = await mountMd(MD);
		expect(menuHandlers.get('menu_edit') ?? []).toHaveLength(0);
		expect('beginEdit' in windowState).toBe(false);
		await fireEvent.dblClick(q(container, '.markdown-body p')!);
		await settleLong();
		expect(q(container, PM)).not.toBeNull();
		expect(handle().raw).toBe(false);
		expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(1);
	});
});

describe('AC-74-9・契約23: View ▸ Raw Source で raw(CodeMirror)に切り替わる', () => {
	it('raw の面が出て PM は消え、raw の文字列=契約6 の書き出し=handle.text()・handle.raw=true・contenteditable は 1 つ', async () => {
		const { container } = await mountMd(MD);
		const before = text();
		await emitRawSource();
		expect(q(container, RAW), 'raw-source-editor').not.toBeNull();
		expect(q(container, RAW)!.getAttribute('data-vellis-lang')).toBe('markdown');
		expect(q(container, CM), '.cm-editor').not.toBeNull();
		expect(container.querySelectorAll('.ProseMirror[contenteditable="true"]'), 'PM は出さない').toHaveLength(0);
		expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(1);
		expect(handle().raw).toBe(true);
		expect(handle().kind).toBe('markdown');
		expect(cm(container).state.doc.toString()).toBe(before);
		expect(text()).toBe(MD);
		expect(handle().dirty).toBe(false);
	});

	it('もう一度で rendered に戻る(PM が出て raw は消える)。往復で確認(ask / confirm)は出ない', async () => {
		const { container } = await mountMd(MD);
		await emitRawSource();
		await emitRawSource();
		expect(q(container, RAW)).toBeNull();
		expect(q(container, PM)?.getAttribute('contenteditable')).toBe('true');
		expect(handle().raw).toBe(false);
		expect(text()).toBe(MD);
		expect(askMock).not.toHaveBeenCalled();
		expect(undoDepth(pm().state), '変わっていなければ履歴に積まない').toBe(0);
	});

	it('dirty の文書でも往復で確認が出ず、dirty は保たれる(札も残る)', async () => {
		const { container } = await mountMd(MD);
		const spot = textSpots(pm().state.doc, 2)[0]!;
		pm().dispatch(pm().state.tr.insertText('X', spot.pos));
		await settle();
		expect(handle().dirty).toBe(true);
		await emitRawSource();
		expect(handle().dirty).toBe(true);
		expect(q(container, BADGE), 'raw でも Unsaved の札').not.toBeNull();
		expect(cm(container).state.doc.toString()).toContain('XSecond paragraph');
		await emitRawSource();
		expect(handle().dirty).toBe(true);
		expect(text()).toBe(MD.replace('Second', 'XSecond'));
		expect(askMock).not.toHaveBeenCalled();
	});

	it('カーソルと選択を写す: PM の選択 → raw の同じ文字 → 戻すと同じ位置(触っていないブロックは正確)', async () => {
		const { container } = await mountMd(MD);
		const spot = textSpots(pm().state.doc, 2)[0]!; // 'Second paragraph here.'
		selectPm(spot.pos + 2, spot.pos + 9);
		await emitRawSource();
		const base = MD.indexOf('Second paragraph here.');
		const sel = cm(container).state.selection.main;
		expect(sel.anchor).toBe(base + 2);
		expect(sel.head).toBe(base + 9);
		await emitRawSource();
		expect(pm().state.selection.from).toBe(spot.pos + 2);
		expect(pm().state.selection.to).toBe(spot.pos + 9);
	});

	it('raw で打って戻す: 文書モデルが読み直され・dirty が文字列どおり・カーソルがそのブロック・Ctrl+Z 1 回でまとめて戻る', async () => {
		const { container } = await mountMd(MD);
		const depth = undoDepth(pm().state);
		const headingBefore = pm().state.doc.child(0);
		await emitRawSource();
		cmInsert(container, 'item two', 'item 2', 'item two'.length);
		cmInsert(container, 'Tail paragraph.', 'Tail ZZ paragraph.', 'Tail paragraph.'.length);
		const raw = cm(container).state.doc.toString();
		expect(raw).toBe(MD.replace('- item two', '- item 2').replace('Tail paragraph.', 'Tail ZZ paragraph.'));
		expect(text(), 'raw の間の text() は raw の文字列').toBe(raw);
		expect(handle().dirty).toBe(true);
		await emitRawSource();
		expect(handle().raw).toBe(false);
		expect(text()).toBe(raw);
		expect(handle().dirty).toBe(true);
		expect(pm().state.doc.child(0), '触っていない見出しは同じ Node').toBe(headingBefore);
		// カーソルは最後に打った Tail のブロックの中
		const tailStart = blockPos(pm().state.doc, 4);
		expect(pm().state.selection.from).toBeGreaterThanOrEqual(tailStart);
		expect(pm().state.selection.from).toBeLessThanOrEqual(tailStart + pm().state.doc.child(4).nodeSize);
		// 履歴に 1 段・Ctrl+Z 1 回で 2 つのブロックの直しが戻り dirty でなくなる
		expect(undoDepth(pm().state)).toBe(depth + 1);
		keyPm('z', { ctrlKey: true });
		await settleLong();
		expect(text()).toBe(MD);
		expect(handle().dirty).toBe(false);
	});

	it('raw で打って戻し、もう一度 raw に入ると CodeMirror の履歴は新しく始まる(raw の Ctrl+Z で前の raw の編集は戻らない)', async () => {
		const { container } = await mountMd(MD);
		await emitRawSource();
		cmInsert(container, 'item two', 'item 2', 'item two'.length);
		await emitRawSource();
		await emitRawSource();
		const v = cm(container);
		expect(v.state.doc.toString()).toContain('item 2');
		v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
		await settle();
		expect(cm(container).state.doc.toString(), 'raw の履歴は空').toContain('item 2');
		expect(text()).toContain('item 2');
	});

	it('CRLF の文書: raw の text() は \\r\\n を保ち、raw で打って戻しても改行は byte のまま', async () => {
		const crlf = MD.replace(/\n/g, '\r\n');
		const { container } = await mountMd(crlf);
		expect(text()).toBe(crlf);
		await emitRawSource();
		expect(text()).toBe(crlf);
		cmInsert(container, 'Tail paragraph.', 'Tail!', 'Tail'.length);
		expect(text()).toBe(crlf.replace('Tail paragraph.', 'Tail! paragraph.'));
		expect((text().match(/\r\n/g) ?? []).length).toBe((crlf.match(/\r\n/g) ?? []).length);
		await emitRawSource();
		expect(text()).toBe(crlf.replace('Tail paragraph.', 'Tail! paragraph.'));
	});

	it('契約10: 変換中に来た Raw Source は compositionend の後に 1 回だけ切り替える', async () => {
		const { container } = await mountMd(MD);
		compositionPm('compositionstart');
		await settle();
		await emitRawSource();
		expect(q(container, RAW), '変換中は切り替えない').toBeNull();
		expect(handle().raw).toBe(false);
		compositionPm('compositionend');
		await settleLong();
		await new Promise((r) => setTimeout(r, 20));
		await settle();
		expect(q(container, RAW), '確定の後に切り替わる').not.toBeNull();
		expect(handle().raw).toBe(true);
	});

	it('AC-74-6: raw で直すもの(front matter・生 HTML・参照定義・閉じていないフェンス)を raw で直して戻すと、そのまま書き出しに入る', async () => {
		const { container } = await mountMd(RAW_ONLY);
		await emitRawSource();
		expect(cm(container).state.doc.toString()).toBe(RAW_ONLY);
		cmInsert(container, 'draft: true', 'draft: false', 'draft: true'.length);
		cmInsert(container, '生 HTML のブロック', '生 HTML の <em>塊</em>', '生 HTML のブロック'.length);
		cmInsert(container, 'https://example.com/one', 'https://example.com/uno?q=a&b=c', 'https://example.com/one'.length);
		cmInsert(container, 'const unclosed = true;', 'const unclosed = `x`;', 'const unclosed = true;'.length);
		const raw = cm(container).state.doc.toString();
		await emitRawSource();
		expect(text()).toBe(raw);
		expect(text()).toContain('<em>塊</em>');
		expect(text()).toContain('?q=a&b=c');
		expect(text()).toContain('`x`;');
		expect(handle().dirty).toBe(true);
		keyPm('z', { ctrlKey: true });
		await settleLong();
		expect(text()).toBe(RAW_ONLY);
	});
});

describe('契約23: raw の間の外部変更・保存は第1段の CodeMirror の面と同じ', () => {
	it('dirty でない raw に外部変更 → raw の文字列が差し替わり dirty でない。戻すと PM にも反映', async () => {
		const { container } = await mountMd(MD);
		await emitRawSource();
		const incoming = MD.replace('item one', 'item uno') + '\nMore.\n';
		windowState.applyFileChanged(doc(MD_URI, incoming));
		await settleLong();
		expect(cm(container).state.doc.toString()).toBe(incoming);
		expect(text()).toBe(incoming);
		expect(handle().dirty).toBe(false);
		await emitRawSource();
		expect(text()).toBe(incoming);
		expect(pm().state.doc.textContent).toContain('More.');
	});

	it('raw で打って Command + S(saveFileEditor): save_document に raw の文字列と基準の版の expectedHash・保存の後 dirty でない', async () => {
		const { container } = await mountMd(MD);
		await emitRawSource();
		cmInsert(container, 'Tail paragraph.', 'Tail saved.', 'Tail paragraph.'.length);
		const edited = text();
		await saveFileEditor(handle());
		await settleLong();
		const call = invokeMock.mock.calls.find(([name]) => name === 'save_document');
		expect(call, 'save_document が呼ばれる').toBeTruthy();
		expect(call![1]).toEqual({ uri: MD_URI, content: edited, expectedHash: contentHash(MD) });
		expect(handle().dirty).toBe(false);
		expect(handle().expectedHash()).toBe(contentHash(edited));
		await emitRawSource();
		expect(text()).toBe(edited);
		expect(handle().dirty).toBe(false);
	});

	it('Reload File(handle.reset)は raw でも効き、raw の文字列が差し替わって dirty でない', async () => {
		const { container } = await mountMd(MD);
		await emitRawSource();
		cmInsert(container, 'Tail paragraph.', 'Tail X.', 'Tail paragraph.'.length);
		const fresh = MD.replace('# Plan', '# Plan v2');
		handle().reset(fresh);
		await settleLong();
		expect(cm(container).state.doc.toString()).toBe(fresh);
		expect(text()).toBe(fresh);
		expect(handle().dirty).toBe(false);
	});
});

describe('項目 16: raw の間は .markdown-body に zoom を掛けず、CodeMirror の文字の大きさで掛ける', () => {
	it('zoom=150', async () => {
		const { container } = await mountMd(MD, { zoom: 150 });
		const body = q(container, 'article.viewer .markdown-body')!;
		expect(body.style.zoom, 'rendered では今どおり .markdown-body の zoom').toMatch(/150|1\.5/);
		await emitRawSource();
		expect(body.style.zoom ?? '', 'raw では .markdown-body に zoom が無い').toBe('');
		expect(q(container, RAW)!.style.fontSize).toMatch(/1\.5|150%/);
		for (const el of [q(container, RAW)!, q(container, CM)!]) {
			expect(el.style.transform ?? '').toBe('');
		}
		await emitRawSource();
		expect(body.style.zoom).toMatch(/150|1\.5/);
	});
});

describe('項目 21・契約18: 閾値を超えた Markdown(今の描画)でも Raw Source で raw に入れる', () => {
	it('知らせの窓で Raw Source → raw-source-editor が出て handle(kind markdown・raw true)が登録され、もう一度で今の描画に戻る', async () => {
		const big = `# Big\n\nfirst paragraph\n\n${'a'.repeat(MARKDOWN_EDIT_LIMIT_BYTES)}\n`;
		const { container } = await mountMd(big, {}, 'file:///Users/a/notes/big.md');
		expect(q(container, TOO_LARGE)).not.toBeNull();
		expect(windowState.fileEditor).toBeNull();
		await emitRawSource();
		expect(q(container, RAW)).not.toBeNull();
		const h = windowState.fileEditor as MarkdownEditorHandle | null;
		expect(h?.kind).toBe('markdown');
		expect(h?.raw).toBe(true);
		expect(h?.text()).toBe(big);
		expect(cm(container).state.doc.length).toBe(big.length);
		await emitRawSource();
		expect(q(container, RAW)).toBeNull();
		expect(q(container, TOO_LARGE), '今の描画の知らせに戻る').not.toBeNull();
		expect(windowState.fileEditor).toBeNull();
	});
});

describe('AC-74-9: コードと plain text では Raw Source のイベントで何も変わらない', () => {
	it('.txt の窓: code-editor のまま・raw-source-editor は出ない・text() 不変・kind text', async () => {
		const content = 'plain text\nsecond line\n';
		const { container } = await mountText(content);
		const h = windowState.fileEditor as FileEditorHandle | null;
		expect(h?.kind).toBe('text');
		for (const f of menuHandlers.get(MENU_RAW_SOURCE_EVENT) ?? []) f({ payload: undefined });
		await settleLong();
		expect(q(container, '[data-testid="code-editor"]')).not.toBeNull();
		expect(q(container, RAW)).toBeNull();
		expect(windowState.fileEditor).toBe(h);
		expect(h?.text()).toBe(content);
		expect(h?.dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 判断 9・10 に依存
// ---------------------------------------------------------------------------

describe('判断 9 に依存: raw_source_state を前面の窓の値で送る(payload { label, raw })', () => {
	it('面が出たとき raw=false・切り替えで true / false・面が消えたとき false(最後の値)', async () => {
		await mountMd(MD);
		expect(rawStateCalls().at(-1)).toEqual({ label: 'main', raw: false });
		await emitRawSource();
		expect(rawStateCalls().at(-1)).toEqual({ label: 'main', raw: true });
		await emitRawSource();
		expect(rawStateCalls().at(-1)).toEqual({ label: 'main', raw: false });
		await emitRawSource();
		expect(rawStateCalls().at(-1)).toEqual({ label: 'main', raw: true });
		cleanup();
		await settleLong();
		expect(rawStateCalls().at(-1), '面が消えたら印を消す').toEqual({ label: 'main', raw: false });
	});

	it('閾値超えの窓で raw に入ったときも true、戻ると false', async () => {
		const big = `# Big\n\n${'a'.repeat(MARKDOWN_EDIT_LIMIT_BYTES)}\n`;
		await mountMd(big, {}, 'file:///Users/a/notes/big.md');
		await emitRawSource();
		expect(rawStateCalls().at(-1)).toEqual({ label: 'main', raw: true });
		await emitRawSource();
		expect(rawStateCalls().at(-1)).toEqual({ label: 'main', raw: false });
	});
});

describe('判断 10 に依存: 別の文書を開いたら raw を引き継がない', () => {
	it('raw のまま別の Markdown を開く(uri が変わる)→ 新しい文書は rendered・handle.raw=false・印も false', async () => {
		const r = await mountMd(MD);
		await emitRawSource();
		expect(handle().raw).toBe(true);
		const other = '# Other\n\nAnother document.\n';
		const d2 = doc('file:///Users/a/notes/other.md', other);
		windowState.setDocument(d2);
		const html = await renderMarkdown(other, d2.uri);
		await r.rerender(baseProps(d2, html.html, html.index, { fileEditor: true }));
		await settleLong();
		await new Promise((r2) => setTimeout(r2, 20));
		await settle();
		expect(handle().uri).toBe(d2.uri);
		expect(handle().raw).toBe(false);
		expect(q(r.container, RAW)).toBeNull();
		expect(q(r.container, PM)?.getAttribute('contenteditable')).toBe('true');
		expect(text()).toBe(other);
		expect(rawStateCalls().at(-1)).toEqual({ label: 'main', raw: false });
	});

	it('raw のまま .txt を開く → code-editor(kind text)で、印は false', async () => {
		const r = await mountMd(MD);
		await emitRawSource();
		const d2 = doc(TXT_URI, 'plain\n');
		windowState.setDocument(d2);
		await r.rerender(baseProps(d2, '', null, { fileEditor: true }));
		await settleLong();
		await new Promise((r2) => setTimeout(r2, 20));
		await settle();
		expect(q(r.container, RAW)).toBeNull();
		expect(q(r.container, '[data-testid="code-editor"]')).not.toBeNull();
		expect((windowState.fileEditor as FileEditorHandle | null)?.kind).toBe('text');
		expect(rawStateCalls().at(-1)).toEqual({ label: 'main', raw: false });
	});
});

// ---------------------------------------------------------------------------
// 判断 9 に依存(ソース走査): 窓が前面になったときも送る
// ---------------------------------------------------------------------------

describe('判断 9 に依存(ソース走査): 窓が前面になったとき(onFocusChanged)にも raw_source_state を送る', () => {
	it('+page.svelte / Viewer.svelte / MarkdownEditor.svelte / raw-sync.ts のどこかで onFocusChanged( の近くに announceRawSource( か RAW_SOURCE_STATE_EVENT がある', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const root = resolve(__dirname, '../..');
		const files = ['src/routes/+page.svelte', 'src/components/Viewer.svelte', 'src/components/MarkdownEditor.svelte', 'src/editor/raw-sync.ts'];
		const hits = files.filter((f) => {
			let src = '';
			try {
				src = readFileSync(resolve(root, f), 'utf8');
			} catch {
				return false;
			}
			return [...src.matchAll(/onFocusChanged\(/g)].some((m) => {
				const window = src.slice(m.index!, m.index! + 1500);
				return window.includes('announceRawSource(') || window.includes('RAW_SOURCE_STATE_EVENT');
			});
		});
		expect(hits, '前面になった窓の raw を Rust に知らせる口').not.toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 契約17・項目 15: raw の検索は全文(第1段の AC-74-31 と同じ規則)
// ---------------------------------------------------------------------------

async function emitMenuFind() {
	await settle();
	const list = [...(menuHandlers.get('menu_find') ?? [])];
	expect(list.length, "Viewer が 'menu_find' を購読していること").toBeGreaterThan(0);
	for (const h of list) h({ payload: undefined });
	await settle();
}
async function typeQuery(container: ParentNode, value: string) {
	const input = q(container, '[data-testid="find-input"]') as HTMLInputElement | null;
	expect(input, '検索バーの入力欄').toBeTruthy();
	await fireEvent.input(input!, { target: { value } });
	await settleLong();
	await new Promise((r) => setTimeout(r, 200));
	await settle();
}
function countText(container: ParentNode): string {
	return (q(container, '[data-testid="find-count"]')?.textContent ?? '').trim();
}

describe('契約17・項目 15: raw の面の検索の件数は全文(見えていない行を含む)で、Next で選択が移りスクロールする', () => {
	const LINES = 800;
	const bigMd = ['# Long', '', ...Array.from({ length: LINES }, (_, i) => (i === 0 || i === 400 || i === LINES - 1 ? `line ${i} has a Needle here` : `line ${i} plain`)), ''].join('\n');

	it('件数が findMatches(raw の全文, 語) と一致する(3 件。見えている行だけなら少ない)', async () => {
		const { container } = await mountMd(bigMd);
		await emitRawSource();
		expect(cm(container).state.doc.toString()).toBe(bigMd);
		await emitMenuFind();
		await typeQuery(container, 'needle');
		const matches = findMatches(bigMd, 'needle');
		expect(matches).toHaveLength(3);
		expect(countText(container)).toBe(formatCount(0, matches.length, 'needle'));
	});

	it('Next で選択が次の一致へ移り(循環)、その取引は scrollIntoView を伴う。raw でも dirty にならない', async () => {
		const { container } = await mountMd(bigMd);
		await emitRawSource();
		const v = cm(container);
		const dispatched: unknown[] = [];
		const original = v.dispatch.bind(v);
		vi.spyOn(v, 'dispatch').mockImplementation((...args: unknown[]) => {
			dispatched.push(...args);
			return (original as (...a: unknown[]) => void)(...args);
		});
		await emitMenuFind();
		await typeQuery(container, 'needle');
		const matches = findMatches(bigMd, 'needle');
		expect(v.state.selection.main.from).toBe(matches[0]!.start);
		expect(v.state.selection.main.to).toBe(matches[0]!.end);
		const input = q(container, '[data-testid="find-input"]')!;
		dispatched.length = 0;
		await fireEvent.keyDown(input, { key: 'Enter' });
		await settleLong();
		expect(countText(container)).toBe(formatCount(1, 3, 'needle'));
		expect(v.state.selection.main.from).toBe(matches[1]!.start);
		const scrolled = dispatched.some((a) => {
			const spec = a as { scrollIntoView?: boolean; effects?: unknown };
			return spec.scrollIntoView === true || (Array.isArray(spec.effects) && spec.effects.length > 0);
		});
		expect(scrolled, 'Next の取引は選択の位置へスクロールする(scrollIntoView)').toBe(true);
		await fireEvent.keyDown(input, { key: 'Enter' });
		await settleLong();
		expect(v.state.selection.main.from).toBe(matches[2]!.start);
		await fireEvent.keyDown(input, { key: 'Enter' });
		await settleLong();
		expect(v.state.selection.main.from, '最後の次は先頭').toBe(matches[0]!.start);
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
		await settleLong();
		expect(v.state.selection.main.from, 'Prev で最後へ').toBe(matches[2]!.start);
		expect(handle().dirty).toBe(false);
		expect(text()).toBe(bigMd);
	});

	it('raw で打つと件数が張り直される(増える)・rendered に戻ると見えている文字の数え方に戻る', async () => {
		const { container } = await mountMd(bigMd);
		await emitRawSource();
		await emitMenuFind();
		await typeQuery(container, 'needle');
		expect(countText(container)).toBe(formatCount(0, 3, 'needle'));
		cmInsert(container, 'line 200 plain', 'line 200 needle plain', 'line 200 plain'.length);
		await settleLong();
		await new Promise((r) => setTimeout(r, 250));
		await settle();
		expect(countText(container)).toBe(formatCount(0, 4, 'needle'));
	});
});

// ---------------------------------------------------------------------------
// P3 の穴(reviewer 2026-11-17): F7・F9・F15・F16
// ---------------------------------------------------------------------------

describe('F7・契約18・契約16: 閾値超えの raw で dirty のまま Raw Source を押しても今の描画へ戻らない(未保存の編集を捨てない)', () => {
	const big = `# Big\n\nfirst paragraph\n\n${'a'.repeat(MARKDOWN_EDIT_LIMIT_BYTES)}\n`;
	const BIG_URI = 'file:///Users/a/notes/big.md';

	it('dirty なら raw のまま・文書と dirty が保たれ・確認も出ない。保存して dirty でなくなれば戻れる', async () => {
		const { container } = await mountMd(big, {}, BIG_URI);
		await emitRawSource();
		cmInsert(container, 'first paragraph', 'first EDITED paragraph', 'first paragraph'.length);
		const edited = text();
		expect(handle().dirty).toBe(true);
		await emitRawSource();
		expect(q(container, RAW), 'raw のまま').not.toBeNull();
		expect(q(container, TOO_LARGE), '今の描画には戻らない').toBeNull();
		expect(windowState.fileEditor, 'handle は残る').not.toBeNull();
		expect(handle().raw).toBe(true);
		expect(text()).toBe(edited);
		expect(handle().dirty).toBe(true);
		expect(q(container, BADGE)).not.toBeNull();
		expect(askMock).not.toHaveBeenCalled();
		expect(rawStateCalls().at(-1)).toEqual({ label: 'main', raw: true });
		// 保存 → dirty でない → 今度は戻れる
		await saveFileEditor(handle());
		await settleLong();
		expect(handle().dirty).toBe(false);
		await emitRawSource();
		expect(q(container, RAW)).toBeNull();
		expect(q(container, TOO_LARGE)).not.toBeNull();
		expect(windowState.fileEditor).toBeNull();
	});

	it('打って戻した(dirty でない)なら今の描画へ戻る', async () => {
		const { container } = await mountMd(big, {}, BIG_URI);
		await emitRawSource();
		cmInsert(container, 'first paragraph', 'first X paragraph', 'first paragraph'.length);
		cmInsert(container, 'first X paragraph', 'first paragraph', 'first X paragraph'.length);
		expect(handle().dirty).toBe(false);
		await emitRawSource();
		expect(q(container, RAW)).toBeNull();
		expect(q(container, TOO_LARGE)).not.toBeNull();
	});
});

describe('F9・判断 10 に依存: 閾値超えの raw のまま別の文書を開くと raw を引き継がない', () => {
	const big1 = `# Big one\n\nfirst\n\n${'a'.repeat(MARKDOWN_EDIT_LIMIT_BYTES)}\n`;
	const big2 = `# Big two\n\nsecond\n\n${'b'.repeat(MARKDOWN_EDIT_LIMIT_BYTES)}\n`;

	it('別の閾値超えの文書 → 今の描画(+知らせ)で開き raw でない・handle なし・印 false', async () => {
		const r = await mountMd(big1, {}, 'file:///Users/a/notes/big1.md');
		await emitRawSource();
		expect(q(r.container, RAW)).not.toBeNull();
		const d2 = doc('file:///Users/a/notes/big2.md', big2);
		windowState.setDocument(d2);
		const html = await renderMarkdown(big2, d2.uri);
		await r.rerender(baseProps(d2, html.html, html.index, { fileEditor: true }));
		await settleLong();
		await new Promise((r2) => setTimeout(r2, 20));
		await settle();
		expect(q(r.container, RAW), 'raw を引き継がない').toBeNull();
		expect(q(r.container, TOO_LARGE), '知らせつきの今の描画').not.toBeNull();
		expect(windowState.fileEditor).toBeNull();
		expect(windowState.editBlocked).toBe(true);
		expect(rawStateCalls().at(-1)).toEqual({ label: 'main', raw: false });
	});

	it('閾値超えの raw → 普通の Markdown → rendered(PM)で開く', async () => {
		const r = await mountMd(big1, {}, 'file:///Users/a/notes/big1.md');
		await emitRawSource();
		const d2 = doc(MD_URI, MD);
		windowState.setDocument(d2);
		const html = await renderMarkdown(MD, d2.uri);
		await r.rerender(baseProps(d2, html.html, html.index, { fileEditor: true }));
		await settleLong();
		await new Promise((r2) => setTimeout(r2, 20));
		await settle();
		expect(q(r.container, RAW)).toBeNull();
		expect(q(r.container, PM)?.getAttribute('contenteditable')).toBe('true');
		expect(handle().raw).toBe(false);
		expect(rawStateCalls().at(-1)).toEqual({ label: 'main', raw: false });
	});
});

describe('F15・契約23: CRLF の文書でもカーソル・選択が raw の同じ文字を指し、戻るときも同じ位置(\\r\\n のずれが無い)', () => {
	const crlf = MD.replace(/\n/g, '\r\n');

	it('カーソル(Second| paragraph の col 7)→ raw の同じ文字 → 戻ると同じ位置', async () => {
		const { container } = await mountMd(crlf);
		const spot = textSpots(pm().state.doc, 2)[0]!;
		selectPm(spot.pos + 7);
		await emitRawSource();
		const v = cm(container);
		const cmDoc = v.state.doc.toString();
		const head = v.state.selection.main.head;
		expect(head).toBe(cmDoc.indexOf('Second paragraph here.') + 7);
		expect(cmDoc.slice(head, head + 9), 'raw のカーソルの右の文字').toBe('paragraph');
		await emitRawSource();
		expect(pm().state.selection.from).toBe(spot.pos + 7);
		expect(pm().state.selection.empty).toBe(true);
	});

	it('行をまたぐ選択(Second の col 2 〜 Tail の col 4)→ raw の両端が同じ文字 → 戻ると同じ範囲', async () => {
		const { container } = await mountMd(crlf);
		const second = textSpots(pm().state.doc, 2)[0]!;
		const tail = textSpots(pm().state.doc, 4)[0]!;
		selectPm(second.pos + 2, tail.pos + 4);
		await emitRawSource();
		const v = cm(container);
		const cmDoc = v.state.doc.toString();
		const sel = v.state.selection.main;
		expect(sel.anchor).toBe(cmDoc.indexOf('Second paragraph here.') + 2);
		expect(sel.head).toBe(cmDoc.indexOf('Tail paragraph.') + 4);
		expect(cmDoc.slice(sel.anchor, sel.anchor + 4)).toBe('cond');
		expect(cmDoc.slice(sel.head, sel.head + 10)).toBe(' paragraph');
		await emitRawSource();
		expect(pm().state.selection.anchor).toBe(second.pos + 2);
		expect(pm().state.selection.head).toBe(tail.pos + 4);
		expect(text()).toBe(crlf);
	});

	it('raw で打った位置のカーソルが rendered の同じ文字(最終ブロック・CRLF)', async () => {
		const { container } = await mountMd(crlf);
		await emitRawSource();
		cmInsert(container, 'Tail paragraph.', 'Tail ZZ paragraph.', 'Tail paragraph.'.length);
		await emitRawSource();
		const tail = textSpots(pm().state.doc, 4)[0]!;
		expect(tail.text).toBe('Tail ZZ paragraph.');
		expect(pm().state.selection.from).toBe(tail.pos + 'Tail ZZ paragraph.'.length);
		expect(text()).toBe(crlf.replace('Tail paragraph.', 'Tail ZZ paragraph.'));
	});
});

describe('F16・第1段の由谷決定 4: raw の検索で İ の後ろでも一致の装飾の位置が正しい(cm-find の写し直し)', () => {
	const I_DOT = 'İ';
	const src = `# ${I_DOT}stanbul\n\n${I_DOT}${I_DOT} needle here\n\nplain needle\n\n${I_DOT}x Needle end\n`;

	it('装飾(findField)の各範囲の文字が needle で、数が全文の一致の数', async () => {
		const { container } = await mountMd(src);
		await emitRawSource();
		const v = cm(container);
		const cmDoc = v.state.doc.toString();
		expect(cmDoc.toLowerCase().length).toBeGreaterThan(cmDoc.length);
		await emitMenuFind();
		await typeQuery(container, 'needle');
		expect(countText(container)).toBe(formatCount(0, 3, 'needle'));
		const ranges: Array<{ from: number; to: number }> = [];
		v.state.field(findField).between(0, cmDoc.length, (from, to) => {
			ranges.push({ from, to });
		});
		expect(ranges).toHaveLength(3);
		for (const r of ranges) expect(cmDoc.slice(r.from, r.to).toLowerCase(), `装飾 ${r.from}-${r.to}`).toBe('needle');
		expect(v.state.selection.main.from).toBe(cmDoc.indexOf('needle'));
		expect(cmDoc.slice(v.state.selection.main.from, v.state.selection.main.to)).toBe('needle');
		// DOM の装飾も同じ文字(描かれている分)
		for (const el of container.querySelectorAll(`${RAW} .cm-vellis-find, ${RAW} .cm-vellis-find-current`)) {
			expect(el.textContent?.toLowerCase()).toBe('needle');
		}
	});

	it('Next で選択が İ の後ろの一致へ正しく移る', async () => {
		const { container } = await mountMd(src);
		await emitRawSource();
		const v = cm(container);
		const cmDoc = v.state.doc.toString();
		await emitMenuFind();
		await typeQuery(container, 'needle');
		const input = q(container, '[data-testid="find-input"]')!;
		await fireEvent.keyDown(input, { key: 'Enter' });
		await settleLong();
		expect(cmDoc.slice(v.state.selection.main.from, v.state.selection.main.to)).toBe('needle');
		expect(v.state.selection.main.from).toBe(cmDoc.indexOf('plain needle') + 6);
		await fireEvent.keyDown(input, { key: 'Enter' });
		await settleLong();
		expect(cmDoc.slice(v.state.selection.main.from, v.state.selection.main.to)).toBe('Needle');
	});
});

describe('F16: コードの面(CodeEditor)でも同じ写し直し(.txt に İ)', () => {
	it('装飾の各範囲の文字が needle', async () => {
		const I_DOT = 'İ';
		const content = `${I_DOT}stanbul needle\n${I_DOT}${I_DOT} needle\nplain needle\n`;
		const { container } = await mountText(content);
		const el = q(container, '[data-testid="code-editor"] .cm-editor');
		expect(el).not.toBeNull();
		const v = CMView.findFromDOM(el as HTMLElement)!;
		await emitMenuFind();
		await typeQuery(container, 'needle');
		expect(countText(container)).toBe(formatCount(0, 3, 'needle'));
		const cmDoc = v.state.doc.toString();
		const ranges: Array<{ from: number; to: number }> = [];
		v.state.field(findField).between(0, cmDoc.length, (from, to) => {
			ranges.push({ from, to });
		});
		expect(ranges).toHaveLength(3);
		for (const r of ranges) expect(cmDoc.slice(r.from, r.to)).toBe('needle');
		expect(cmDoc.slice(v.state.selection.main.from, v.state.selection.main.to)).toBe('needle');
	});
});

// ---------------------------------------------------------------------------
// 要件74 第3段 3-3 — raw でも Option + 上下と Command + /(Markdown の注釈 <!-- -->)が効く(AC-74-56 (7)・3-13)。
// 契約は src/editor/code-keymap.acceptance.test.ts の AC-74-56 の節(raw の CodeMirror も CODE_KEYMAP・Markdown の文法の commentTokens)。
// ---------------------------------------------------------------------------

describe('3-3: raw の Option + 上下と Command + /(AC-74-56)', () => {
	function rawView(container: ParentNode): CMView {
		const el = q(container, CM);
		if (!el) throw new Error('raw の .cm-editor が無い');
		const v = CMView.findFromDOM(el);
		if (!v) throw new Error('EditorView.findFromDOM が null');
		return v;
	}
	async function waitForLanguage(view: CMView) {
		for (let i = 0; i < 100; i++) {
			if (view.state.languageDataAt<unknown>('commentTokens', 0).length > 0) return;
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error('raw の言語(Markdown の commentTokens)が読み込まれない');
	}
	function keyCm(view: CMView, k: string, init: KeyboardEventInit = {}) {
		view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
	}

	it('Command + / で行が <!-- … --> になり、もう 1 回で byte 等価', async () => {
		const { container } = await mountMd(MD);
		handle().toggleRaw();
		await settleLong();
		const view = rawView(container);
		await waitForLanguage(view);
		view.dispatch({ selection: { anchor: 2 } });
		keyCm(view, '/', { ctrlKey: true });
		await settleLong();
		expect(text().split('\n')[0]).toBe('<!-- # Plan -->');
		expect(handle().dirty).toBe(true);
		keyCm(view, '/', { ctrlKey: true });
		await settleLong();
		expect(text()).toBe(MD);
		expect(handle().dirty).toBe(false);
	});

	it('Option + 下で 1 行目(# Plan)が空行と入れ替わる。Control + Z で戻る', async () => {
		const { container } = await mountMd(MD);
		handle().toggleRaw();
		await settleLong();
		const view = rawView(container);
		view.dispatch({ selection: { anchor: 1 } });
		keyCm(view, 'ArrowDown', { altKey: true });
		await settleLong();
		expect(text().startsWith('\n# Plan\nIntro')).toBe(true);
		keyCm(view, 'z', { ctrlKey: true });
		await settleLong();
		expect(text()).toBe(MD);
	});
});
