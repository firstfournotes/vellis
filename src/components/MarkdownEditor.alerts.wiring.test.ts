/**
 * 要件#90 の受け入れテスト(docs/requirements/req-90.md)— Markdown の編集面(ProseMirror)の配線(component プロジェクト・JSDOM)
 * AC-90-2(印・まとめ・札で開く)・AC-90-3(見出しで畳む)・AC-90-4(byte と Undo)・AC-90-5(検索)・AC-90-6(印刷)・
 * AC-90-7(設定が全部の窓に効く・畳んだのは残らない)・AC-90-8(カーソル・矢印キー・選択・Raw Source)
 *
 * 純モデル(`src/lib/alert-visibility.ts`)の判定は `src/lib/alert-visibility.acceptance.test.ts`。ここは Viewer を JSDOM に載せ、
 * 設定の変更(メニューのイベント / applyAlertVisibility / 他の窓の storage)が面の DOM にどう出るか・面の操作が文書を変えないかを見る。
 *
 * ## 確定契約(implementer はこれに従う。面と読み取り専用の描画で同じ DOM の形)
 *
 * ```text
 * // --- アラートの枠(markdown-schema の alert の toDOM = blockquote.markdown-alert.markdown-alert-<kind>。NodeView か node decoration で属性を足す)
 * blockquote.markdown-alert[data-alert-kind="<kind>"][data-alert-state="shown" | "collapsed" | "hidden"]
 *   - hidden    = 全体の設定で隠した種類の枠。`hidden` 属性(el.hidden === true)で見えなくする。**中身は DOM に残す**(textContent は変えない=
 *                 検索が数えられる・契約5)。印はこの枠の前(下)
 *   - collapsed = 見出しを押して畳んだ枠。`data-alert-summary` 属性に中身の最初の数語(= alertSummary(本文の textContent))。見出し
 *                 (.markdown-alert-title)は見えたまま、中身は DOM に残す(1 行に畳む見た目は CSS)。
 *   - shown     = 出ている(札で開いた・検索で開いた枠も shown)
 * // --- 印(契約2。続けて隠れた枠の組ごとに 1 つ・組の最初の枠の直前の兄弟要素)
 * div.vellis-alert-marker[data-testid="alert-marker"][data-alert-counts="note:2" | "warning:2,note:1" …]
 *   > button[data-testid="alert-marker-label"][aria-label="NOTE 2"][data-label="NOTE 2"]   // 文字は CSS(content: attr(data-label))で描き textContent は ''
 *   - 面では contenteditable=false の中(ProseMirror の widget decoration ならそのまま)
 *   - 印の直後に続く兄弟要素(data-alert-state="hidden" の枠の連なり)がその組の枠。印の数 = groupHiddenAlerts の組の数
 *   - 札(button)を押す(mousedown → mouseup → click)と、その組の枠だけが shown になり印は消える。全体の設定(currentAlertVisibility /
 *     localStorage)は変わらない。設定を変え直す(その種類を出す → 隠す)と、開いた枠もまた hidden
 * // --- 見出し(契約3): .markdown-alert-title を押すと shown ⇄ collapsed(その枠だけ)
 * // --- 契約4: 隠す・畳む・開くのどれも、handle.text()・dirty・undoDepth・Unsaved の札を変えない。打って Undo しても隠した・畳んだ状態は変わらない
 * // --- 契約8(面): hidden / collapsed の枠の中へ選択を置く取引は、枠の外(前か後ろ)へ直される。ArrowRight / ArrowDown(前の段落の末尾)・
 * //     ArrowLeft / ArrowUp(次の段落の先頭)は隠した枠を飛ばす(jsdom ではブラウザがカーソルを動かさないので、面の keymap がブロックの境で
 * //     自分で飛ばすこと)。枠をまたいだ選択の削除・コピーは中身ごと(今の ProseMirror の既定を塞がない)。Raw Source は原文の全部
 * // --- 契約5(Viewer の検索): 件数は面の容器の textContent(隠した・畳んだ中身を含む)。現在の一致が hidden / collapsed の枠の中なら、
 * //     その枠だけを shown にする(CSS.highlights の無い jsdom でも起きること=塗る effect ではなく rangeAtMatch で枠を見つける)
 * // --- 契約6(面の印刷): beforeprint の `[data-testid="markdown-editor-print"]` の中には hidden の種類の枠が無く・.vellis-alert-marker が無く・
 * //     collapsed の枠は blockquote[data-alert-state="collapsed"][data-alert-summary] で出る(shown の枠と地の文はそのまま)
 * // --- 契約7: 設定は $lib/alert-visibility の store(applyAlertVisibility・storage イベント)から来る。面は mount のとき currentAlertVisibility()
 * //     を当て、subscribeAlertVisibility で追う。畳んだ・札で開いたは面の中だけ(uri が変わって作り直すと消える)
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - 設定の受け手(registerAlertVisibilityListeners)は +page.svelte の持ち場なので、このテストが beforeEach で登録する($lib/events のモックに
 *   handler が入る=メニューのイベントを模せる)。面は store を購読するだけ
 * - 「中身は DOM に残す」を契約にしたのは、Viewer の検索(契約5)が容器の textContent で数えるため。見た目は hidden 属性・CSS に任せる
 * - 札の文字を CSS で描く(textContent '')のは、表の行と列の印(#832)と同じ家風=検索・コピーに札の字を混ぜないため
 * - 矢印キーは ArrowRight / ArrowLeft(文字の端)と ArrowDown / ArrowUp(1 行の段落の端)の 4 つを見る。jsdom では PM 自身は
 *   矢印を処理しないので、面の keymap が境で飛ばさないと赤
 * - 「畳んだ中へカーソルは入らない」も契約8 の字面どおり見る(畳んだ枠を直すには見出しを押して開く)
 *
 * ## 修正前に赤になる理由
 * - `$lib/alert-visibility` が無く import で落ちる。あとは data-alert-state / 印 / 見出しのクリックの受け手が無い
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { TextSelection } from 'prosemirror-state';
import { undo, undoDepth } from 'prosemirror-history';
import { deleteSelection } from 'prosemirror-commands';
import type { EditorView as PMView } from 'prosemirror-view';
import { EditorView as CMView } from '@codemirror/view';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import { blockPos, textSpots } from '../editor/markdown.testkit';
import {
	ALERT_VISIBILITY_STORAGE_KEY,
	ALL_ALERTS_SHOWN,
	MENU_ALERTS_HIDE_ALL_EVENT,
	MENU_ALERTS_SHOW_ALL_EVENT,
	MENU_ALERTS_TOGGLE_KIND_EVENT,
	alertSummary,
	applyAlertVisibility,
	currentAlertVisibility,
	hideAll,
	loadAlertVisibility,
	registerAlertVisibilityListeners,
	serializeAlertVisibility,
	type AlertKind,
	type AlertVisibility,
} from '$lib/alert-visibility';

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
import { invoke } from '$lib/ipc';
import * as eventsModule from '$lib/events';

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
// フィクスチャ(台本のような文書)と helper
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/scripts/episode-12.md';
const OTHER_URI = 'file:///Users/a/scripts/other.md';
/**
 * 最上位ブロック: 0 見出し / 1 地の文 / 2 NOTE / 3 TIP / 4 地の文 / 5 WARNING / 6 NOTE / 7 WARNING / 8 地の文。
 * アラートの枠は文書の順に [NOTE, TIP, WARNING, NOTE, WARNING]。
 * 語: 'camera' は NOTE[0] だけ・'channel' は地の文 1 と NOTE[1]・'card' は TIP だけ・'maker' は WARNING 2 つ。
 */
const SCRIPT = [
	'# Episode 12 script',
	'',
	'Hello and welcome back to the channel.',
	'',
	'> [!NOTE]',
	'> Camera: slow zoom on the desk.',
	'',
	'> [!TIP]',
	'> Card: Episode 12 title card',
	'',
	'Today we talk about desk printers.',
	'',
	'> [!WARNING]',
	'> Needs a shoot: ask the maker about the model name.',
	'',
	'> [!NOTE]',
	'> Animation: fade in the channel logo.',
	'',
	'> [!WARNING]',
	'> Confirm the price with the maker.',
	'',
	'That is all for today. See you next time.',
	'',
].join('\n');
const OTHER = '# Other\n\nAnother document.\n';
const ALERT_BLOCKS = [2, 3, 5, 6, 7];
const KIND_ORDER: AlertKind[] = ['note', 'tip', 'warning', 'note', 'warning'];

const v = (shown: Partial<Record<AlertKind, boolean>>): AlertVisibility =>
	({ note: true, tip: true, important: true, warning: true, caution: true, ...shown }) as AlertVisibility;

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
async function mountMd(content = SCRIPT, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index, { fileEditor: true }) });
	await settleLong();
	return result;
}
async function reopen(r: Awaited<ReturnType<typeof mountMd>>, content: string, uri: string) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const html = await renderMarkdown(content, uri);
	await r.rerender(baseProps(d, html.html, html.index, { fileEditor: true }));
	await settleLong();
	await new Promise((res) => setTimeout(res, 20));
	await settle();
}

const BODY = 'article.viewer .markdown-body';
const PM = `${BODY} [data-testid="markdown-editor"] .ProseMirror`;
const RAW = `${BODY} [data-testid="raw-source-editor"]`;
const BADGE = '[data-testid="unsaved-badge"]';
const PRINT = '[data-testid="markdown-editor-print"]';
const ALERT = 'blockquote.markdown-alert';
const MARKER = '.vellis-alert-marker';
const LABEL = '[data-testid="alert-marker-label"]';
const TITLE = '.markdown-alert-title';

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
function view(): PMView {
	return handle().view;
}
function text(): string {
	return handle().text();
}
function pm(container: ParentNode): HTMLElement {
	const el = q(container, PM);
	if (!el) throw new Error('編集面(ProseMirror)が無い');
	return el;
}
/** 面のアラートの枠(文書の順)。 */
function alerts(root: ParentNode): HTMLElement[] {
	return qa(root, ALERT);
}
function stateOf(el: Element): string | null {
	return el.getAttribute('data-alert-state');
}
function states(root: ParentNode): (string | null)[] {
	return alerts(root).map(stateOf);
}
function markers(root: ParentNode): HTMLElement[] {
	return qa(root, MARKER);
}
function labelOf(marker: Element): HTMLButtonElement {
	const b = marker.querySelector<HTMLButtonElement>(LABEL);
	if (!b) throw new Error('印の札(button)が無い');
	return b;
}
/** 印の直後に続く hidden の枠の連なり(= その印の組)。 */
function groupOf(marker: Element): HTMLElement[] {
	const out: HTMLElement[] = [];
	let el = marker.nextElementSibling as HTMLElement | null;
	while (el && el.matches(`${ALERT}[data-alert-state="hidden"]`)) {
		out.push(el);
		el = el.nextElementSibling as HTMLElement | null;
	}
	return out;
}
function titleOf(alert: Element): HTMLElement {
	const t = alert.querySelector<HTMLElement>(TITLE);
	if (!t) throw new Error('枠の見出しが無い');
	return t;
}
/** 枠の本文の文字(見出しを除く)。 */
function bodyTextOf(alert: Element): string {
	const title = alert.querySelector(TITLE)?.textContent ?? '';
	const all = alert.textContent ?? '';
	return all.startsWith(title) ? all.slice(title.length) : all.replace(title, '');
}
/** 本物のクリックと同じ列(mousedown → mouseup → click)。 */
async function userClick(el: Element) {
	await fireEvent.mouseDown(el, { button: 0, buttons: 1 });
	await fireEvent.mouseUp(el, { button: 0 });
	await fireEvent.click(el, { button: 0 });
	await settleLong();
}
function selectPm(from: number, to = from) {
	const vw = view();
	vw.dispatch(vw.state.tr.setSelection(TextSelection.create(vw.state.doc, from, to)));
}
function keyPm(k: string, init: KeyboardEventInit = {}) {
	view().dom.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
}
function blockStart(i: number): number {
	return blockPos(view().state.doc, i);
}
function blockEnd(i: number): number {
	return blockPos(view().state.doc, i) + view().state.doc.child(i).nodeSize;
}
/** 最上位ブロック i の最初の文字の位置と文字列。 */
function spot(i: number) {
	const s = textSpots(view().state.doc, i)[0];
	if (!s) throw new Error(`ブロック ${i} に文字が無い`);
	return s;
}
async function emitMenu(event: string, payload: unknown = undefined) {
	await settle();
	const list = [...(menuHandlers.get(event) ?? [])];
	expect(list.length, `'${event}' が購読されていること`).toBeGreaterThan(0);
	for (const h of list) h({ payload });
	await settleLong();
}
async function apply(next: AlertVisibility) {
	applyAlertVisibility(next);
	await settleLong();
}
async function emitMenuFind() {
	await emitMenu('menu_find');
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
function clipboard(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		api: {
			setData: (t: string, val: string) => void data.set(t, val),
			getData: (t: string) => data.get(t) ?? '',
			clearData: () => data.clear(),
			types: [...data.keys()],
		},
	};
}
/** 契約4: 文書の中身・dirty・履歴・札のどれも変わっていない。 */
function expectUntouched(container: ParentNode, depth = 0) {
	expect(text(), '書き出しは原文のまま').toBe(SCRIPT);
	expect(handle().dirty, 'dirty でない').toBe(false);
	expect(undoDepth(view().state), 'Undo に積まない').toBe(depth);
	expect(q(container, BADGE), 'Unsaved の札は出ない').toBeNull();
}

let offListeners: (() => void) | null = null;

beforeEach(async () => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	windowState.externalRemoved = false;
	menuHandlers.clear();
	invokeMock.mockReset();
	invokeMock.mockImplementation(async () => null);
	windowEmitMock.mockClear();
	localStorage.clear();
	applyAlertVisibility(ALL_ALERTS_SHOWN);
	Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
	offListeners = await registerAlertVisibilityListeners();
});
afterEach(() => {
	offListeners?.();
	offListeners = null;
	cleanup();
	windowState.clearDocument();
	windowState.fileEditor = null;
	applyAlertVisibility(ALL_ALERTS_SHOWN);
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC-90-2 — 種類ごとに隠すと印になり、続けて隠れたものはまとまり、札で開く(契約2)
// ---------------------------------------------------------------------------

describe('AC-90-2 契約2: 既定は全部出ていて、枠は data-alert-kind / data-alert-state を持つ', () => {
	it('5 つの枠が文書の順に出て(shown)、kind が class と一致し、印は無い', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		const list = alerts(face);
		expect(list).toHaveLength(5);
		expect(list.map((el) => el.getAttribute('data-alert-kind'))).toEqual(KIND_ORDER);
		for (const [i, el] of list.entries()) {
			expect(el.classList.contains(`markdown-alert-${KIND_ORDER[i]}`)).toBe(true);
			expect(stateOf(el), `枠 ${i} は shown`).toBe('shown');
			expect(el.hidden).toBe(false);
		}
		expect(markers(face)).toHaveLength(0);
		expectUntouched(container);
	});
});

describe('AC-90-2 契約2: 種類を隠すと hidden になり、その場所に印(細い線+札)が残る', () => {
	it('NOTE を隠す(メニューの toggle_kind): NOTE の 2 枠が hidden(中身は DOM に残る)・間に TIP が出ているので印は 2 つ(NOTE 1 ずつ)', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await emitMenu(MENU_ALERTS_TOGGLE_KIND_EVENT, 'note');
		expect(states(face)).toEqual(['hidden', 'shown', 'shown', 'hidden', 'shown']);
		const [n1, , , n2] = alerts(face);
		expect(n1!.hidden).toBe(true);
		expect(n2!.hidden).toBe(true);
		expect(n1!.textContent, '中身は DOM に残す(検索のため)').toContain('Camera: slow zoom on the desk.');
		const ms = markers(face);
		expect(ms).toHaveLength(2);
		for (const m of ms) {
			expect(m.getAttribute('data-testid')).toBe('alert-marker');
			expect(m.getAttribute('data-alert-counts')).toBe('note:1');
			const label = labelOf(m);
			expect(label.tagName).toBe('BUTTON');
			expect(label.getAttribute('aria-label')).toBe('NOTE 1');
			expect(label.getAttribute('data-label')).toBe('NOTE 1');
			expect((label.textContent ?? '').trim(), '札の字は CSS で描く(textContent は空)').toBe('');
			expect(m.closest('[contenteditable="false"]'), '印は編集の外').not.toBeNull();
		}
		expect(groupOf(ms[0]!)).toEqual([n1]);
		expect(groupOf(ms[1]!)).toEqual([n2]);
		// 地の文はそのまま見える
		for (const p of qa(face, ':scope > p')) expect(p.hidden).toBe(false);
		expect(face.textContent).toContain('Today we talk about desk printers.');
		expectUntouched(container);
	});

	it('NOTE と WARNING を隠す: 5〜7 番目のブロックは続けて隠れるので 1 つの印「WARNING 2 · NOTE 1」(data-alert-counts="warning:2,note:1")', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await apply(v({ note: false, warning: false }));
		expect(states(face)).toEqual(['hidden', 'shown', 'hidden', 'hidden', 'hidden']);
		const ms = markers(face);
		expect(ms).toHaveLength(2);
		expect(ms[0]!.getAttribute('data-alert-counts')).toBe('note:1');
		expect(labelOf(ms[0]!).getAttribute('aria-label')).toBe('NOTE 1');
		expect(ms[1]!.getAttribute('data-alert-counts')).toBe('warning:2,note:1');
		expect(labelOf(ms[1]!).getAttribute('aria-label')).toBe('WARNING 2 · NOTE 1');
		const list = alerts(face);
		expect(groupOf(ms[1]!)).toEqual([list[2], list[3], list[4]]);
		expectUntouched(container);
	});

	it('全部隠す(hide_all)→ 5 枠 hidden・印は 2 つ(NOTE 1 · TIP 1 / WARNING 2 · NOTE 1)。全部出す(show_all)→ 元どおり', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await emitMenu(MENU_ALERTS_HIDE_ALL_EVENT);
		expect(states(face)).toEqual(['hidden', 'hidden', 'hidden', 'hidden', 'hidden']);
		const ms = markers(face);
		expect(ms.map((m) => labelOf(m).getAttribute('aria-label'))).toEqual(['NOTE 1 · TIP 1', 'WARNING 2 · NOTE 1']);
		expect(ms.map((m) => m.getAttribute('data-alert-counts'))).toEqual(['note:1,tip:1', 'warning:2,note:1']);
		await emitMenu(MENU_ALERTS_SHOW_ALL_EVENT);
		expect(states(face)).toEqual(['shown', 'shown', 'shown', 'shown', 'shown']);
		expect(markers(face)).toHaveLength(0);
		expectUntouched(container);
	});
});

describe('AC-90-2 契約2: 札を押すと、その印の枠だけが開く(全体の設定は変えない)', () => {
	it('NOTE と WARNING を隠し、2 つ目の印の札を押す → その 3 枠が shown・印が消える。1 つ目の印と設定はそのまま', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await apply(v({ note: false, warning: false }));
		const saved = localStorage.getItem(ALERT_VISIBILITY_STORAGE_KEY);
		const emitsBefore = windowEmitMock.mock.calls.length;
		const second = markers(face)[1]!;
		await userClick(labelOf(second));
		expect(states(face)).toEqual(['hidden', 'shown', 'shown', 'shown', 'shown']);
		for (const el of alerts(face).slice(2)) expect(el.hidden).toBe(false);
		const ms = markers(face);
		expect(ms).toHaveLength(1);
		expect(labelOf(ms[0]!).getAttribute('aria-label')).toBe('NOTE 1');
		expect(currentAlertVisibility(), '全体の設定は変わらない').toEqual(v({ note: false, warning: false }));
		expect(localStorage.getItem(ALERT_VISIBILITY_STORAGE_KEY)).toBe(saved);
		expect(windowEmitMock.mock.calls.length, 'Rust にも知らせ直さない(設定は変わっていない)').toBe(emitsBefore);
		expectUntouched(container);
	});

	it('札で開いた枠は、その種類を出して隠し直すとまた hidden(印が戻る)', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await apply(v({ note: false }));
		await userClick(labelOf(markers(face)[0]!));
		expect(states(face)).toEqual(['shown', 'shown', 'shown', 'hidden', 'shown']);
		await apply(ALL_ALERTS_SHOWN);
		expect(states(face)).toEqual(['shown', 'shown', 'shown', 'shown', 'shown']);
		await apply(v({ note: false }));
		expect(states(face)).toEqual(['hidden', 'shown', 'shown', 'hidden', 'shown']);
		expect(markers(face)).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// AC-90-3 — 見出しで 1 つずつ畳む・開く(契約3)
// ---------------------------------------------------------------------------

describe('AC-90-3 契約3: 枠の見出しを押すと、その枠だけ畳む・開く', () => {
	it('TIP の見出しを押す → collapsed・data-alert-summary が中身の最初の数語・見出しは見えたまま・中身は DOM に残る。もう一度で shown', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		const tip = alerts(face)[1]!;
		const body = bodyTextOf(tip);
		await userClick(titleOf(tip));
		expect(stateOf(tip)).toBe('collapsed');
		expect(tip.hidden).toBe(false);
		const summary = tip.getAttribute('data-alert-summary') ?? '';
		expect(summary.length).toBeGreaterThan(0);
		expect(summary).toBe(alertSummary(body));
		expect(summary.startsWith('Card: Episode 12')).toBe(true);
		expect(titleOf(tip).hidden).toBe(false);
		expect(tip.textContent, '中身は DOM に残す').toContain('Card: Episode 12 title card');
		expect(states(face)).toEqual(['shown', 'collapsed', 'shown', 'shown', 'shown']);
		expect(markers(face), '畳んでも印は出ない').toHaveLength(0);
		await userClick(titleOf(tip));
		expect(stateOf(tip)).toBe('shown');
		expect(tip.hasAttribute('data-alert-summary')).toBe(false);
		expectUntouched(container);
	});

	it('2 つの枠を畳むとそれぞれ独立に畳まれ、片方を開いてももう片方は畳んだまま', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		const [, tip, warning] = alerts(face);
		await userClick(titleOf(tip!));
		await userClick(titleOf(warning!));
		expect(states(face)).toEqual(['shown', 'collapsed', 'collapsed', 'shown', 'shown']);
		expect(warning!.getAttribute('data-alert-summary')?.startsWith('Needs a shoot')).toBe(true);
		await userClick(titleOf(tip!));
		expect(states(face)).toEqual(['shown', 'shown', 'collapsed', 'shown', 'shown']);
		expectUntouched(container);
	});

	it('全体の設定で隠れている枠は印のまま(畳んだ枠の種類を隠すと hidden になり、出し直すと shown に戻る=畳んだ形は設定に負ける)', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		const tip = alerts(face)[1]!;
		await userClick(titleOf(tip));
		expect(stateOf(tip)).toBe('collapsed');
		await apply(v({ tip: false }));
		expect(stateOf(alerts(face)[1]!)).toBe('hidden');
		expect(markers(face)).toHaveLength(1);
		expect(labelOf(markers(face)[0]!).getAttribute('aria-label')).toBe('TIP 1');
	});
});

// ---------------------------------------------------------------------------
// AC-90-4 — 保存の byte・Undo の履歴が変わらない(契約4)
// ---------------------------------------------------------------------------

describe('AC-90-4 契約4: 隠す・畳む・開くは画面の側だけ(書き出し byte 等価・dirty でない・Undo に積まない)', () => {
	it('隠す → 札で開く → 畳む → 開く → 全部隠す → 全部出す、の後も text() は原文・undoDepth 0・dirty でない', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await apply(v({ note: false }));
		await userClick(labelOf(markers(face)[0]!));
		await userClick(titleOf(alerts(face)[1]!));
		await userClick(titleOf(alerts(face)[1]!));
		await apply(hideAll());
		await apply(ALL_ALERTS_SHOWN);
		expectUntouched(container);
		expect(text().length).toBe(SCRIPT.length);
	});

	it('CRLF の文書でも改行は byte のまま', async () => {
		const crlf = SCRIPT.replace(/\n/g, '\r\n');
		const { container } = await mountMd(crlf);
		const face = pm(container);
		await apply(v({ warning: false }));
		await userClick(titleOf(alerts(face)[0]!));
		expect(text()).toBe(crlf);
		expect(handle().dirty).toBe(false);
		expect(undoDepth(view().state)).toBe(0);
	});

	it('隠して・畳んでから 1 文字打ち、Undo で戻す: 文書は原文に戻り、隠した・畳んだ状態はそのまま(履歴に乗っていない)', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await apply(v({ note: false }));
		await userClick(titleOf(alerts(face)[1]!));
		const before = states(face);
		expect(before).toEqual(['hidden', 'collapsed', 'shown', 'hidden', 'shown']);
		const s = spot(1);
		view().dispatch(view().state.tr.insertText('X', s.pos));
		await settleLong();
		expect(handle().dirty).toBe(true);
		expect(undoDepth(view().state)).toBe(1);
		expect(states(face), '打っても状態は変わらない').toEqual(before);
		const vw = view();
		expect(undo(vw.state, vw.dispatch)).toBe(true);
		await settleLong();
		expect(text()).toBe(SCRIPT);
		expect(handle().dirty).toBe(false);
		expect(states(face), 'Undo でも状態は変わらない(履歴に積んでいない)').toEqual(before);
		expect(markers(face)).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// AC-90-8 — 編集の画面でのカーソル・矢印キー・選択の削除とコピー・Raw Source(契約8)
// ---------------------------------------------------------------------------

describe('AC-90-8 契約8: 隠した・畳んだ枠の中にカーソルは入らない', () => {
	it('hidden の枠(ブロック 5)の中へ選択を置く取引は、枠の外へ直される', async () => {
		const { container } = await mountMd();
		await apply(v({ warning: false }));
		expect(states(pm(container))[2]).toBe('hidden');
		const inside = spot(5).pos + 3;
		selectPm(inside);
		await settle();
		const from = view().state.selection.from;
		expect(from <= blockStart(5) || from >= blockEnd(5), `選択 ${from} は枠 [${blockStart(5)}, ${blockEnd(5)}] の外`).toBe(true);
		expectUntouched(container);
	});

	it('collapsed の枠(ブロック 3)の中へ選択を置く取引も、枠の外へ直される', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await userClick(titleOf(alerts(face)[1]!));
		expect(stateOf(alerts(face)[1]!)).toBe('collapsed');
		selectPm(spot(3).pos + 2);
		await settle();
		const from = view().state.selection.from;
		expect(from <= blockStart(3) || from >= blockEnd(3), `選択 ${from} は枠 [${blockStart(3)}, ${blockEnd(3)}] の外`).toBe(true);
	});

	it('出ている枠の中には入れる(直されない=対照)', async () => {
		await mountMd();
		const inside = spot(3).pos + 2;
		selectPm(inside);
		await settle();
		expect(view().state.selection.from).toBe(inside);
	});
});

describe('AC-90-8 契約8: 矢印キーは隠した枠(ブロック 5〜7)を飛ばす', () => {
	async function hideMiddle(container: ParentNode) {
		await apply(v({ note: false, warning: false }));
		expect(states(pm(container)).slice(2)).toEqual(['hidden', 'hidden', 'hidden']);
	}

	it('ArrowRight: ブロック 4 の末尾から → ブロック 7 の後ろ(ブロック 8 の中)へ', async () => {
		const { container } = await mountMd();
		await hideMiddle(container);
		const s = spot(4);
		selectPm(s.pos + s.text.length);
		keyPm('ArrowRight');
		await settle();
		const from = view().state.selection.from;
		expect(from, `選択 ${from} は隠した枠の後ろ(>= ${blockStart(8)})`).toBeGreaterThanOrEqual(blockStart(8));
		expect(from).toBeLessThanOrEqual(blockEnd(8));
	});

	it('ArrowLeft: ブロック 8 の先頭から → ブロック 5 の前(ブロック 4 の中)へ', async () => {
		const { container } = await mountMd();
		await hideMiddle(container);
		selectPm(spot(8).pos);
		keyPm('ArrowLeft');
		await settle();
		const to = view().state.selection.to;
		expect(to, `選択 ${to} は隠した枠の前(<= ${blockStart(5)})`).toBeLessThanOrEqual(blockStart(5));
		expect(to).toBeGreaterThanOrEqual(blockStart(4));
	});

	it('ArrowDown: ブロック 4(1 行の段落)の末尾から → ブロック 8 へ', async () => {
		const { container } = await mountMd();
		await hideMiddle(container);
		const s = spot(4);
		selectPm(s.pos + s.text.length);
		keyPm('ArrowDown');
		await settle();
		expect(view().state.selection.from).toBeGreaterThanOrEqual(blockStart(8));
	});

	it('ArrowUp: ブロック 8 の先頭から → ブロック 4 へ', async () => {
		const { container } = await mountMd();
		await hideMiddle(container);
		selectPm(spot(8).pos);
		keyPm('ArrowUp');
		await settle();
		expect(view().state.selection.to).toBeLessThanOrEqual(blockStart(5));
	});

	it('隠していなければ矢印で枠を飛ばさない(対照: ArrowRight はブロック 4 の末尾から WARNING の中へ)', async () => {
		await mountMd();
		const s = spot(4);
		selectPm(s.pos + s.text.length);
		keyPm('ArrowRight');
		await settle();
		const from = view().state.selection.from;
		// jsdom ではブラウザがカーソルを動かさないので「動かない」か「WARNING(ブロック 5)の中」のどちらか。飛ばして 8 へ行くのは誤り
		expect(from).toBeLessThan(blockStart(8));
	});
});

describe('AC-90-8 契約8: 枠をまたいだ選択の削除・コピーは中身ごと', () => {
	it('地の文 1 の途中から TIP の途中までを選んで削除 → 隠した NOTE の中身も消える(dirty・書き出しに Camera も [!NOTE] も無い)', async () => {
		const { container } = await mountMd();
		await apply(v({ note: false }));
		expect(states(pm(container))[0]).toBe('hidden');
		const a = spot(1);
		const b = spot(3);
		selectPm(a.pos + 5, b.pos + 4);
		const vw = view();
		expect(deleteSelection(vw.state, vw.dispatch)).toBe(true);
		await settleLong();
		const out = text();
		expect(out).not.toContain('Camera');
		expect(out).not.toContain('[!NOTE]\n> Camera');
		expect(out).toContain('Hello');
		expect(out).toContain('Animation: fade in the channel logo.');
		expect(handle().dirty).toBe(true);
		// NOTE の枠は消える(TIP の残りが枠のまま残るか地の文に併合されるかは ProseMirror の既定に任せる)
		expect(alerts(pm(container)).length).toBeLessThan(5);
		expect(qa(pm(container), 'blockquote.markdown-alert-note')).toHaveLength(1);
	});

	it('同じ範囲をコピー → text/plain に隠した NOTE の中身(Camera: slow zoom on the desk.)が入る', async () => {
		const { container } = await mountMd();
		await apply(v({ note: false }));
		const a = spot(1);
		const b = spot(3);
		selectPm(a.pos + 5, b.pos + 4);
		const clip = clipboard();
		await fireEvent.copy(view().dom, { clipboardData: clip.api });
		const plain = clip.data.get('text/plain') ?? '';
		expect(plain).toContain('Camera: slow zoom on the desk.');
		expect(plain).toContain('welcome back to the channel.');
		expect(plain, '札の字は入らない').not.toContain('NOTE 1');
		expectUntouched(container);
	});
});

// ---------------------------------------------------------------------------
// reviewer 差し戻し(2026-11-26)F1・F2 — 結合の抑止と、続けて隠れた枠での選択の直し(契約8)
// ---------------------------------------------------------------------------

describe('AC-90-8 契約8(F1): 隠した・畳んだ枠の境の Backspace / Delete は結合しない(front-matter-guard と同じく何もしない)', () => {
	it('(a) 隠した枠(5〜7)の直後の段落 8 の先頭で Backspace → text() 不変・履歴に積まない・選択は枠の外(段落 8 の中)', async () => {
		const { container } = await mountMd();
		await apply(v({ note: false, warning: false }));
		expect(states(pm(container)).slice(2)).toEqual(['hidden', 'hidden', 'hidden']);
		selectPm(spot(8).pos);
		keyPm('Backspace');
		await settleLong();
		expect(text(), '段落 8 が隠した枠の中へ結合しない').toBe(SCRIPT);
		expect(undoDepth(view().state)).toBe(0);
		const from = view().state.selection.from;
		expect(from, `選択 ${from} は隠した枠の外(>= ${blockStart(8)})`).toBeGreaterThanOrEqual(blockStart(8));
		expect(handle().dirty).toBe(false);
	});

	it('(b) 隠した枠(5〜7)の直前の段落 4 の末尾で Delete → text() 不変・選択は枠の外(段落 4 の中)', async () => {
		const { container } = await mountMd();
		await apply(v({ note: false, warning: false }));
		const s = spot(4);
		selectPm(s.pos + s.text.length);
		keyPm('Delete');
		await settleLong();
		expect(text(), '枠の最初の段落が外へ出ない').toBe(SCRIPT);
		expect(undoDepth(view().state)).toBe(0);
		const from = view().state.selection.from;
		expect(from, `選択 ${from} は隠した枠の前(<= ${blockStart(5)})`).toBeLessThanOrEqual(blockStart(5));
		expect(states(pm(container)).slice(2)).toEqual(['hidden', 'hidden', 'hidden']);
	});

	it('(c) 畳んだ NOTE(ブロック 2)の前後でも同じ: 段落 1 の末尾の Delete・TIP(ブロック 3)の先頭の Backspace で text() 不変・畳んだまま', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await userClick(titleOf(alerts(face)[0]!));
		expect(stateOf(alerts(face)[0]!)).toBe('collapsed');
		const s1 = spot(1);
		selectPm(s1.pos + s1.text.length);
		keyPm('Delete');
		await settleLong();
		expect(text()).toBe(SCRIPT);
		expect(view().state.selection.from).toBeLessThanOrEqual(blockStart(2));
		selectPm(spot(3).pos);
		keyPm('Backspace');
		await settleLong();
		expect(text()).toBe(SCRIPT);
		expect(view().state.selection.from).toBeGreaterThanOrEqual(blockStart(3));
		expect(undoDepth(view().state)).toBe(0);
		expect(stateOf(alerts(face)[0]!), '畳んだままで文書も不変').toBe('collapsed');
		expectUntouched(container);
	});

	it('対照: 出ている枠の直後(段落 4 の先頭)の Backspace は今までどおり結合する(抑止は隠した・畳んだ枠だけ)', async () => {
		await mountMd();
		selectPm(spot(4).pos);
		keyPm('Backspace');
		await settleLong();
		expect(text()).not.toBe(SCRIPT);
		expect(handle().dirty).toBe(true);
	});
});

describe('AC-90-8 契約8(F2): 続けて隠れた枠(5〜7)では、選択の直しが連なりを越えて枠の外へ出る(display: none の中に残らない)', () => {
	const outsideRun = (pos: number) => pos <= blockStart(5) || pos >= blockStart(8);

	it('前(段落 4)から真ん中の枠 6 の中へ → 連なりの後ろ(段落 8 以降)へ', async () => {
		const { container } = await mountMd();
		await apply(v({ note: false, warning: false }));
		expect(states(pm(container)).slice(2)).toEqual(['hidden', 'hidden', 'hidden']);
		selectPm(spot(4).pos);
		selectPm(spot(6).pos + 2);
		await settle();
		const from = view().state.selection.from;
		expect(from, `選択 ${from} は 5〜7 の外`).toSatisfy(outsideRun);
		expect(from).toBeGreaterThanOrEqual(blockStart(8));
	});

	it('後ろ(段落 8)から真ん中の枠 6 の中へ → 連なりの前(段落 4 以前)へ', async () => {
		await mountMd();
		await apply(v({ note: false, warning: false }));
		selectPm(spot(8).pos);
		selectPm(spot(6).pos + 2);
		await settle();
		const from = view().state.selection.from;
		expect(from, `選択 ${from} は 5〜7 の外`).toSatisfy(outsideRun);
		expect(from).toBeLessThanOrEqual(blockStart(5));
	});

	it('後ろから最後の枠 7 の中へ → 枠 6・5 に留まらず連なりの前へ。前から最初の枠 5 の中へ → 連なりの後ろへ', async () => {
		await mountMd();
		await apply(v({ note: false, warning: false }));
		selectPm(spot(8).pos);
		selectPm(spot(7).pos + 3);
		await settle();
		expect(view().state.selection.from).toBeLessThanOrEqual(blockStart(5));
		selectPm(spot(4).pos);
		selectPm(spot(5).pos + 3);
		await settle();
		expect(view().state.selection.from).toBeGreaterThanOrEqual(blockStart(8));
	});

	it('範囲の選択(anchor は段落 4・head は枠 6 の中)→ head だけが連なりの外へ(anchor はそのまま)', async () => {
		await mountMd();
		await apply(v({ note: false, warning: false }));
		const a = spot(4).pos + 3;
		selectPm(a, spot(6).pos + 2);
		await settle();
		const sel = view().state.selection;
		expect(sel.anchor).toBe(a);
		expect(sel.head, `head ${sel.head} は 5〜7 の外`).toSatisfy(outsideRun);
		expect(text()).toBe(SCRIPT);
	});
});

// ---------------------------------------------------------------------------
// reviewer 差し戻し(2026-11-26)F5 — 見出しは操作子(a11y)
// ---------------------------------------------------------------------------

describe('AC-90-3(F5): 見出しは操作子 — role=button・aria-expanded・tabindex・Enter / Space で畳む・開く。左ボタン以外とドラッグ選択では畳まない', () => {
	it('出ている枠の見出しは role="button"・aria-expanded="true"・tabindex="0"。畳むと aria-expanded="false"', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		for (const el of alerts(face)) {
			const t = titleOf(el);
			expect(t.getAttribute('role')).toBe('button');
			expect(t.getAttribute('aria-expanded')).toBe('true');
			expect(t.getAttribute('tabindex')).toBe('0');
		}
		await userClick(titleOf(alerts(face)[1]!));
		expect(stateOf(alerts(face)[1]!)).toBe('collapsed');
		expect(titleOf(alerts(face)[1]!).getAttribute('aria-expanded')).toBe('false');
		expect(titleOf(alerts(face)[0]!).getAttribute('aria-expanded')).toBe('true');
	});

	it('見出しで Enter → 畳む(collapsed)。Space → 開く(shown)。文書は不変', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await fireEvent.keyDown(titleOf(alerts(face)[1]!), { key: 'Enter' });
		await settleLong();
		expect(stateOf(alerts(face)[1]!)).toBe('collapsed');
		await fireEvent.keyDown(titleOf(alerts(face)[1]!), { key: ' ' });
		await settleLong();
		expect(stateOf(alerts(face)[1]!)).toBe('shown');
		expectUntouched(container);
	});

	it('右ボタン(button=2)の mousedown / mouseup / click では畳まない', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		const t = titleOf(alerts(face)[1]!);
		await fireEvent.mouseDown(t, { button: 2, buttons: 2 });
		await fireEvent.mouseUp(t, { button: 2 });
		await fireEvent.click(t, { button: 2 });
		await settleLong();
		expect(stateOf(alerts(face)[1]!)).toBe('shown');
	});

	it('見出しの字をドラッグで選んだ(click の時点で選択が空でない)ときは畳まない', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		const t = titleOf(alerts(face)[1]!);
		const textNode = t.firstChild;
		expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
		await fireEvent.mouseDown(t, { button: 0, buttons: 1 });
		const range = document.createRange();
		range.setStart(textNode!, 0);
		range.setEnd(textNode!, (textNode!.textContent ?? '').length);
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		sel.addRange(range);
		await fireEvent.mouseUp(t, { button: 0 });
		await fireEvent.click(t, { button: 0 });
		await settleLong();
		expect(stateOf(alerts(face)[1]!), 'ドラッグ選択では畳まない').toBe('shown');
		sel.removeAllRanges();
		expectUntouched(container);
	});
});

// ---------------------------------------------------------------------------
// 実機ゲート(2026-11-26・42627f8)の直し (A) — Show All / Hide All は全部の種類を当て直し、札で開いた・畳んだを全部捨てる
// ---------------------------------------------------------------------------

describe('AC-90-2・AC-90-7(A): Show All / Hide All(とショートカット)は 1 つずつの開き(札)・畳みを全部捨てる(判断 i は種類ごとのチェックだけ)', () => {
	it('NOTE と WARNING を隠し、2 つ目の印の札で開き、TIP を畳んでから Hide All → 5 枠とも hidden・印は全部の組(NOTE 1 · TIP 1 / WARNING 2 · NOTE 1)', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await apply(v({ note: false, warning: false }));
		await userClick(labelOf(markers(face)[1]!));
		await userClick(titleOf(alerts(face)[1]!));
		expect(states(face)).toEqual(['hidden', 'collapsed', 'shown', 'shown', 'shown']);
		await emitMenu(MENU_ALERTS_HIDE_ALL_EVENT);
		expect(states(face), '札で開いた枠も hidden に戻る').toEqual(['hidden', 'hidden', 'hidden', 'hidden', 'hidden']);
		for (const el of alerts(face)) expect(el.hidden).toBe(true);
		expect(markers(face).map((m) => labelOf(m).getAttribute('aria-label'))).toEqual(['NOTE 1 · TIP 1', 'WARNING 2 · NOTE 1']);
		expect(currentAlertVisibility()).toEqual(hideAll());
		expectUntouched(container);
	});

	it('NOTE を隠し、TIP を畳み、NOTE の印の札で開いてから Show All → 5 枠とも shown(畳みも捨てる・data-alert-summary 無し・印無し)', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await apply(v({ note: false }));
		await userClick(titleOf(alerts(face)[1]!));
		await userClick(labelOf(markers(face)[0]!));
		expect(states(face)).toEqual(['shown', 'collapsed', 'shown', 'hidden', 'shown']);
		await emitMenu(MENU_ALERTS_SHOW_ALL_EVENT);
		expect(states(face)).toEqual(['shown', 'shown', 'shown', 'shown', 'shown']);
		expect(alerts(face)[1]!.hasAttribute('data-alert-summary')).toBe(false);
		expect(markers(face)).toHaveLength(0);
		expectUntouched(container);
	});

	it('対照(判断 i): 種類ごとのチェックは触った種類だけ捨てる — TIP を畳んだまま WARNING を隠す → TIP は collapsed のまま', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await userClick(titleOf(alerts(face)[1]!));
		await emitMenu(MENU_ALERTS_TOGGLE_KIND_EVENT, 'warning');
		expect(states(face)).toEqual(['shown', 'collapsed', 'hidden', 'shown', 'hidden']);
	});
});

describe('AC-90-8 契約8: Raw Source ではいつも全部見える', () => {
	it('全部隠して Raw Source → CodeMirror の文字列は原文の全部(5 つの枠を含む)。戻すと hidden のまま', async () => {
		const { container } = await mountMd();
		await apply(hideAll());
		expect(states(pm(container))).toEqual(['hidden', 'hidden', 'hidden', 'hidden', 'hidden']);
		handle().toggleRaw();
		await settleLong();
		const el = q(container, `${RAW} .cm-editor`);
		expect(el, 'raw の面').not.toBeNull();
		const cm = CMView.findFromDOM(el as HTMLElement)!;
		expect(cm.state.doc.toString()).toBe(SCRIPT);
		expect(cm.state.doc.toString().match(/> \[!(NOTE|TIP|WARNING)\]/g)).toHaveLength(5);
		handle().toggleRaw();
		await settleLong();
		expect(states(pm(container))).toEqual(['hidden', 'hidden', 'hidden', 'hidden', 'hidden']);
		expect(text()).toBe(SCRIPT);
	});
});

// ---------------------------------------------------------------------------
// AC-90-5 — 検索で隠れた枠の中が見つかり、そこへ移ると開く(契約5)
// ---------------------------------------------------------------------------

describe('AC-90-5 契約5: 検索(Command + F)は隠した・畳んだ枠の中も数え、その一致へ移るとその枠だけを開く', () => {
	it("'camera'(隠した NOTE[0] の中だけ)→ 1 of 1 で、その枠が shown に(印は NOTE[1] の分だけ残る)。設定は変わらない", async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await apply(v({ note: false }));
		await emitMenuFind();
		await typeQuery(container, 'camera');
		expect(countText(container)).toBe('1 of 1');
		expect(states(face)).toEqual(['shown', 'shown', 'shown', 'hidden', 'shown']);
		expect(markers(face)).toHaveLength(1);
		expect(groupOf(markers(face)[0]!)).toEqual([alerts(face)[3]]);
		expect(currentAlertVisibility()).toEqual(v({ note: false }));
		expectUntouched(container);
	});

	it("'channel'(地の文 1 と隠した NOTE[1])→ 1 of 2 では NOTE[1] は hidden のまま。Next で 2 of 2 → NOTE[1] だけ shown(NOTE[0] は hidden)", async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await apply(v({ note: false }));
		await emitMenuFind();
		await typeQuery(container, 'channel');
		expect(countText(container)).toBe('1 of 2');
		expect(states(face)).toEqual(['hidden', 'shown', 'shown', 'hidden', 'shown']);
		await fireEvent.keyDown(q(container, '[data-testid="find-input"]')!, { key: 'Enter' });
		await settleLong();
		expect(countText(container)).toBe('2 of 2');
		expect(states(face)).toEqual(['hidden', 'shown', 'shown', 'shown', 'shown']);
		expect(markers(face)).toHaveLength(1);
		expectUntouched(container);
	});

	it("畳んだ TIP の中の 'card' → 一致に数え(1 of 2)、現在の一致がその中なので TIP が shown に", async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await userClick(titleOf(alerts(face)[1]!));
		expect(stateOf(alerts(face)[1]!)).toBe('collapsed');
		await emitMenuFind();
		await typeQuery(container, 'card');
		expect(countText(container)).toBe('1 of 2');
		expect(stateOf(alerts(face)[1]!)).toBe('shown');
		expectUntouched(container);
	});

	it("'maker'(隠した WARNING 2 枠)→ 1 of 2 で WARNING[0] だけ開き、Next で WARNING[1] も開く", async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await apply(v({ warning: false }));
		await emitMenuFind();
		await typeQuery(container, 'maker');
		expect(countText(container)).toBe('1 of 2');
		expect(states(face)).toEqual(['shown', 'shown', 'shown', 'shown', 'hidden']);
		await fireEvent.keyDown(q(container, '[data-testid="find-input"]')!, { key: 'Enter' });
		await settleLong();
		expect(states(face)).toEqual(['shown', 'shown', 'shown', 'shown', 'shown']);
		expect(markers(face)).toHaveLength(0);
		expect(currentAlertVisibility()).toEqual(v({ warning: false }));
	});
});

// ---------------------------------------------------------------------------
// AC-90-6 — 印刷の文書が画面と同じ(契約6)
// ---------------------------------------------------------------------------

describe('AC-90-6 契約6: 印刷は画面と同じ(隠した枠は刷らない・印は刷らない・畳んだ枠は畳んだ形)', () => {
	it('NOTE を隠し TIP を畳んで beforeprint → 印刷の置き場に NOTE の枠と印が無く、TIP は collapsed(data-alert-summary)、WARNING と地の文はある', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		await apply(v({ note: false }));
		await userClick(titleOf(alerts(face)[1]!));
		window.dispatchEvent(new Event('beforeprint'));
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		await settle();
		const print = q(container, PRINT);
		expect(print, '刷る直前の描画の置き場').not.toBeNull();
		expect(print!.querySelector('h1')?.textContent).toBe('Episode 12 script');
		expect(print!.querySelectorAll('blockquote.markdown-alert-note'), '隠した NOTE は刷らない').toHaveLength(0);
		expect(print!.textContent).not.toContain('Camera: slow zoom');
		expect(print!.textContent).not.toContain('Animation: fade in');
		expect(print!.querySelectorAll(MARKER), '印は刷らない').toHaveLength(0);
		const tip = print!.querySelector<HTMLElement>('blockquote.markdown-alert-tip');
		expect(tip, 'TIP は出る').not.toBeNull();
		expect(tip!.getAttribute('data-alert-state')).toBe('collapsed');
		expect(tip!.getAttribute('data-alert-summary')?.startsWith('Card: Episode 12')).toBe(true);
		const warnings = print!.querySelectorAll<HTMLElement>('blockquote.markdown-alert-warning');
		expect(warnings).toHaveLength(2);
		for (const w of warnings) expect(w.getAttribute('data-alert-state') ?? 'shown').toBe('shown');
		expect(print!.textContent).toContain('Needs a shoot: ask the maker about the model name.');
		expect(print!.textContent).toContain('Today we talk about desk printers.');
		expect(print!.textContent).toContain('That is all for today.');
		window.dispatchEvent(new Event('afterprint'));
		await settleLong();
		expect(q(container, PRINT)).toBeNull();
		expectUntouched(container);
	});

	it('何も隠していなければ 5 つの枠が全部刷られる(対照)', async () => {
		const { container } = await mountMd();
		window.dispatchEvent(new Event('beforeprint'));
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		await settle();
		const print = q(container, PRINT)!;
		expect(print.querySelectorAll(ALERT)).toHaveLength(5);
		expect(print.querySelectorAll(MARKER)).toHaveLength(0);
		window.dispatchEvent(new Event('afterprint'));
		await settleLong();
	});
});

// ---------------------------------------------------------------------------
// AC-90-7 — 設定がアプリ全体で残り、全部の窓に効く・畳んだのは残らない(契約7)
// ---------------------------------------------------------------------------

describe('AC-90-7 契約7: 設定はアプリ全体(localStorage)で、他の窓の切り替え(storage イベント)にも面が追う', () => {
	it('保存された設定(NOTE を隠す)で開く → 開いた時点で hidden と印', async () => {
		localStorage.setItem(ALERT_VISIBILITY_STORAGE_KEY, serializeAlertVisibility(v({ note: false })));
		loadAlertVisibility();
		const { container } = await mountMd();
		const face = pm(container);
		expect(states(face)).toEqual(['hidden', 'shown', 'shown', 'hidden', 'shown']);
		expect(markers(face)).toHaveLength(2);
		expectUntouched(container);
	});

	it('他の窓が WARNING を隠した(storage イベント)→ この窓の面も hidden に。戻せば shown', async () => {
		const { container } = await mountMd();
		const face = pm(container);
		window.dispatchEvent(
			new StorageEvent('storage', { key: ALERT_VISIBILITY_STORAGE_KEY, newValue: serializeAlertVisibility(v({ warning: false })) }),
		);
		await settleLong();
		expect(states(face)).toEqual(['shown', 'shown', 'hidden', 'shown', 'hidden']);
		window.dispatchEvent(
			new StorageEvent('storage', { key: ALERT_VISIBILITY_STORAGE_KEY, newValue: serializeAlertVisibility(ALL_ALERTS_SHOWN) }),
		);
		await settleLong();
		expect(states(face)).toEqual(['shown', 'shown', 'shown', 'shown', 'shown']);
		expectUntouched(container);
	});

	it('メニューで切り替えると localStorage に残り、alerts_state({ label, visibility })で Rust に知らせる', async () => {
		await mountMd();
		windowEmitMock.mockClear();
		await emitMenu(MENU_ALERTS_TOGGLE_KIND_EVENT, 'tip');
		expect(JSON.parse(localStorage.getItem(ALERT_VISIBILITY_STORAGE_KEY) ?? 'null')).toEqual(v({ tip: false }));
		const state = windowEmitMock.mock.calls.filter(([e]) => e === 'alerts_state');
		expect(state.length).toBeGreaterThanOrEqual(1);
		expect(state.at(-1)![1]).toEqual({ label: 'main', visibility: v({ tip: false }) });
	});
});

describe('AC-90-7 契約7: 1 つずつ畳んだ・札で開いたのは覚えない(文書を開き直すと全体の設定に戻る)', () => {
	it('TIP を畳み、NOTE の印の札で開いてから、別の文書を開いて戻る → TIP は shown・NOTE は hidden(印が戻る)', async () => {
		const r = await mountMd();
		const face = pm(r.container);
		await apply(v({ note: false }));
		await userClick(titleOf(alerts(face)[1]!));
		await userClick(labelOf(markers(face)[0]!));
		expect(states(face)).toEqual(['shown', 'collapsed', 'shown', 'hidden', 'shown']);
		await reopen(r, OTHER, OTHER_URI);
		expect(handle().uri).toBe(OTHER_URI);
		await reopen(r, SCRIPT, MD_URI);
		expect(handle().uri).toBe(MD_URI);
		const again = pm(r.container);
		expect(states(again)).toEqual(['hidden', 'shown', 'shown', 'hidden', 'shown']);
		expect(markers(again)).toHaveLength(2);
		expect(alerts(again)[1]!.hasAttribute('data-alert-summary')).toBe(false);
		expect(text()).toBe(SCRIPT);
	});
});
