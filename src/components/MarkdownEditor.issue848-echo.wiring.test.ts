/**
 * Issue #848 (2) — 自分の保存のエコーの判定が、外部変更を取り込んだ後も残る不具合(Markdown の面=ProseMirror。
 * component プロジェクト・JSDOM に Viewer を載せる。CodeMirror の面は CodeEditor.issue848-echo.wiring.test.ts)。
 *
 * 保存 → AI が変更(取り込む)→ AI が自分の保存の版と同じ中身に戻す、と、戻した書き込みが「自分の保存のエコー」として
 * 捨てられる(`selfHash` が外部の取り込みの後も残る)。面は古い中身のまま、次の保存は余計な衝突になる。
 *
 * ## 契約(implementer はこれに従う)
 * - `selfHash`(自分の最後の保存のハッシュ)は、**自分のエコーでない外部変更を 1 つ取り込んだら忘れる**
 *   (取り込み=そのまま当てた・マージした・重なりの帯にした、のどれでも)。その後に届く「自分の以前の保存と同じ中身」は
 *   普通の外部変更として扱う(面が従う。dirty で重なれば帯)。
 * - 保存の直後のエコー(同じ中身が続けて届く)は今までどおり `ignore-echo`(取引なし)。外部変更を取り込んだ後に**もう一度保存**
 *   したら、その保存のエコーも `ignore-echo`。
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - 「重なりの帯にした」も取り込みに数える(契約の文言どおり)。帯を出している間にディスクが基準の版(=自分の保存 A)に戻ったら、
 *   それはエコーではなく「衝突が解けた」知らせ: 3 方向マージ(基準 A・自分・届いた A)は clean なので `apply` になり、帯が下りて
 *   自分の編集が残る(dirty のまま)と読む。知らせ(merged notice)の有無は見ない
 * - 外部変更の到着は第1段・第2段と同じく `windowState.applyFileChanged(payload)`。文書の文字列は `handle.text()`
 *
 * ## 修正前に赤になる理由
 * - `applyFileChanged` の最初の `if (selfHash !== null && hash === selfHash) return 'ignore-echo'` が、取り込みの後も A を捨てる
 *   (E1〜E4 の「A が戻る」判定が 'ignore-echo' になり、面も基準の版も進まない)。E5 は今も緑(閉じた側の固定)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { EditorView } from 'prosemirror-view';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { contentHash } from '$lib/document-edit';
import { saveFileEditor, type MarkdownEditorHandle } from '../editor/file-editor';
import { textSpots } from '../editor/markdown.testkit';

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
import { invoke } from '$lib/ipc';

const invokeMock = vi.mocked(invoke);
const alertMock = vi.fn((_m?: unknown) => {});

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

const MD_URI = 'file:///Users/a/notes/plan.md';
// ブロック: 0 見出し・1 Intro・2 Second・3 リスト・4 Tail
const MD = ['# Plan', '', 'Intro paragraph with **bold** word.', '', 'Second paragraph here.', '', '- item one', '- item two', '', 'Tail paragraph.', ''].join('\n');

const CONFLICT = '[data-testid="external-conflict-banner"]';
const MERGED = '[data-testid="external-merged-notice"]';

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false };
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
async function mountMd(content = MD, uri = MD_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index) });
	await settleLong();
	return result;
}
function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
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
/** 最上位ブロック `block` の最初の code でない text の先頭に `s` を打つ。 */
function type(s: string, block: number) {
	const v = view();
	const spot = textSpots(v.state.doc, block).find((t) => !t.inCode)!;
	v.dispatch(v.state.tr.insertText(s, spot.pos));
}
/** 面の今の文字列を保存したことにする(invoke は成功)。保存した文字列(=ディスクの A)を返す。 */
async function save(): Promise<string> {
	const saved = text();
	await saveFileEditor(handle());
	await settle();
	expect(invokeMock).toHaveBeenLastCalledWith('save_document', expect.objectContaining({ uri: MD_URI, content: saved }));
	expect(handle().dirty).toBe(false);
	expect(handle().expectedHash()).toBe(contentHash(saved));
	return saved;
}
function arrive(content: string) {
	return windowState.applyFileChanged(doc(MD_URI, content));
}

beforeEach(() => {
	vi.stubGlobal('alert', alertMock);
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
	alertMock.mockReset();
	windowState.clearDocument();
});
afterEach(() => {
	cleanup();
	windowState.clearDocument();
	vi.unstubAllGlobals();
});

describe('Issue #848 (2) Markdown の面: 外部変更を取り込んだ後は、以前の保存と同じ中身が届いても捨てない', () => {
	it('E1 clean の面: 保存 A → エコー A は ignore-echo → 外部 B を当てる → 外部 A(以前の保存と同じ)が届く → apply・面は A・基準の版も A', async () => {
		const { container } = await mountMd();
		type('x', 2);
		const A = await save();
		expect(A).toBe(MD.replace('Second paragraph', 'xSecond paragraph'));
		// 保存の直後のエコー(今までどおり捨てる)
		const stateBefore = view().state;
		expect(arrive(A)).toBe('ignore-echo');
		await settle();
		expect(view().state).toBe(stateBefore);
		// AI の変更 B(clean な面にそのまま当たる)
		const B = A.replace('Tail paragraph.', 'Tail paragraph AI1.');
		expect(arrive(B)).toBe('apply');
		await settleLong();
		expect(text()).toBe(B);
		expect(handle().dirty).toBe(false);
		// AI が A に戻す: エコーではない(外部の取り込みの後)
		expect(arrive(A), '取り込みの後の A は捨てない').toBe('apply');
		await settleLong();
		expect(text(), '面は A に従う').toBe(A);
		expect(handle().dirty).toBe(false);
		expect(handle().expectedHash(), '基準の版が A に進む(次の保存の照合が合う)').toBe(contentHash(A));
		expect(windowState.currentDocument?.content).toBe(A);
		expect(q(container, CONFLICT)).toBeNull();
	});

	it('E2 dirty・重ならない: 保存 A → 外部 B(Intro)を当てる → Tail を打つ → 外部 A が届く → apply(マージ)・Intro は A の版・Tail の編集は残る', async () => {
		const { container } = await mountMd();
		type('x', 2);
		const A = await save();
		const B = A.replace('Intro paragraph', 'Intro paragraph AI1');
		expect(arrive(B)).toBe('apply');
		await settleLong();
		expect(text()).toBe(B);
		type('y', 4);
		await settle();
		const mine = text();
		expect(mine).toBe(B.replace('Tail paragraph.', 'yTail paragraph.'));
		expect(handle().dirty).toBe(true);
		expect(arrive(A), '取り込みの後の A は捨てない(重ならないのでマージ)').toBe('apply');
		await settleLong();
		expect(text()).toBe(A.replace('Tail paragraph.', 'yTail paragraph.'));
		expect(handle().dirty).toBe(true);
		expect(handle().expectedHash()).toBe(contentHash(A));
		expect(q(container, MERGED), '取り込みの知らせ').not.toBeNull();
		expect(q(container, CONFLICT)).toBeNull();
	});

	it('E3 dirty・重なる: 保存 A → 外部 B(Intro)を当てる → Intro を打つ → 外部 A が届く → external-conflict・帯・文書は変わらない。Use the File on Disk で A', async () => {
		const { container } = await mountMd();
		type('x', 2);
		const A = await save();
		const B = A.replace('Intro paragraph', 'Intro paragraph AI1');
		expect(arrive(B)).toBe('apply');
		await settleLong();
		type('y', 1);
		await settle();
		const mine = text();
		expect(mine).toBe(B.replace('Intro paragraph AI1', 'yIntro paragraph AI1'));
		expect(arrive(A), '取り込みの後の A は捨てない(重なるので帯)').toBe('external-conflict');
		await settleLong();
		expect(text(), '選ぶまで文書は変わらない').toBe(mine);
		expect(handle().conflict).toBe(true);
		expect(q(container, CONFLICT), '重なりの帯').not.toBeNull();
		await fireEvent.click(q(container, '[data-testid="external-conflict-disk"]')!);
		await settleLong();
		expect(text()).toBe(A);
		expect(handle().dirty).toBe(false);
		expect(q(container, CONFLICT)).toBeNull();
	});

	it('E4 帯にした後: 保存 A → Intro を打つ → 外部 B(Intro)で帯 → ディスクが A に戻る → 捨てずに当てる(衝突が解ける): 帯が下り・自分の編集は残る', async () => {
		const { container } = await mountMd();
		type('x', 2);
		const A = await save();
		type('y', 1);
		await settle();
		const mine = text();
		const B = A.replace('Intro paragraph', 'Intro paragraph AI1');
		expect(arrive(B)).toBe('external-conflict');
		await settleLong();
		expect(q(container, CONFLICT)).not.toBeNull();
		expect(arrive(A), '帯にしたのも取り込み。基準の版と同じ A が戻ったのはエコーではない').toBe('apply');
		await settleLong();
		expect(handle().conflict, '衝突が解ける').toBe(false);
		expect(q(container, CONFLICT)).toBeNull();
		expect(text(), '自分の編集は残る').toBe(mine);
		expect(handle().dirty).toBe(true);
		expect(handle().expectedHash()).toBe(contentHash(A));
	});

	it('E5 取り込みの後にもう一度保存したら、その保存のエコーは ignore-echo のまま(閉じた側の固定)', async () => {
		await mountMd();
		type('x', 2);
		const A1 = await save();
		const B = A1.replace('Tail paragraph.', 'Tail paragraph AI1.');
		expect(arrive(B)).toBe('apply');
		await settleLong();
		type('z', 1);
		await settle();
		const A2 = await save();
		expect(A2).not.toBe(B);
		const stateBefore = view().state;
		expect(arrive(A2), '新しい保存のエコー').toBe('ignore-echo');
		await settle();
		expect(view().state).toBe(stateBefore);
		expect(text()).toBe(A2);
		// 古い保存 A1 が届いたらそれは外部変更(clean な面にそのまま当たる)
		expect(arrive(A1), '以前の保存 A1 は今の selfHash ではない').toBe('apply');
		await settleLong();
		expect(text()).toBe(A1);
	});
});
