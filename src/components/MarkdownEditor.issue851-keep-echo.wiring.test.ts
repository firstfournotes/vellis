/**
 * Issue #851 (3) — `showSaveConflict` → `keepMyEdits` でディスクを読み直す経路(`theirs === null`)でも selfHash を忘れる
 * (Markdown の面=ProseMirror。component プロジェクト・JSDOM に Viewer を載せる。CodeMirror の面は CodeEditor.issue851-keep-echo.wiring.test.ts)。
 *
 * Issue #848 (2) は `applyNow`(watcher から届いた外部変更の取り込み)で selfHash を忘れるようにした。保存の照合で断られて
 * (`showSaveConflict`・theirs は null)Keep My Edits を押すと、ディスクを読み直して基準の版にする(=外部の版を取り込んだ)のに
 * selfHash が残る。その後に外部が自分の以前の保存と同じ中身に戻すと、エコーとして捨てられる(watcher が書き込みを取りこぼした
 * ときだけ起きる経路)。
 *
 * ## 契約(implementer はこれに従う)
 * - `keepMyEdits` がディスクを読み直して基準の版にしたら(`theirs === null` の経路)、selfHash も忘れる。その後に届く
 *   「自分の以前の保存と同じ中身」は普通の外部変更として扱う(dirty で重ならなければマージ・重なれば帯)
 * - 取り込みの後に**もう一度保存**したら、その保存のエコーは今までどおり `ignore-echo`
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - 保存の拒否は `saveFileEditor` に `invoke('save_document')` を `SAVE_CONFLICT_PREFIX` で reject させる(Viewer.issue848-sticky.wiring と同じ)。
 *   ディスクの読み直しは `invoke('open_document', { uri })` の戻りで与える
 * - ディスクの版 D は自分の保存 A の Intro を変えたもの。自分は Tail を直している。A が戻ると merge3(D, 自分, A) は Intro の変更が
 *   両側で同じ(D→A)なので clean=`apply`・Tail の編集は残る・基準の版は A
 * - selfHash を忘れる時点(押した瞬間か・読み直しが済んだ後か)は固定しない。読み直しの後に A が届く
 *
 * ## 修正前に赤になる理由
 * - `keepMyEdits` の `readDisk().then(setBase)` が selfHash に触らないので、A が届くと最初の `hash === selfHash` で 'ignore-echo'
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
import { SAVE_CONFLICT_PREFIX, saveFileEditor, type MarkdownEditorHandle } from '../editor/file-editor';
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
const KEEP = '[data-testid="external-conflict-keep"]';

/** `invoke` の振る舞い(テストごとに差し替える)。 */
let diskContent: string | null = null;
let rejectNextSave = false;

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
function must(container: ParentNode, selector: string, what: string): HTMLElement {
	const el = q(container, selector);
	if (!el) throw new Error(`${what} is missing (${selector})`);
	return el;
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
/** 保存が照合で断られる(ディスクが変わっていた)。帯が出る。 */
async function saveRejected(container: ParentNode) {
	rejectNextSave = true;
	await saveFileEditor(handle());
	await settleLong();
	expect(rejectNextSave, 'save_document was called').toBe(false);
	expect(handle().conflict).toBe(true);
	expect(handle().dirty).toBe(true);
	expect(q(container, CONFLICT), '断られた保存の後の重なりの帯').not.toBeNull();
}
function arrive(content: string) {
	return windowState.applyFileChanged(doc(MD_URI, content));
}

beforeEach(() => {
	diskContent = null;
	rejectNextSave = false;
	vi.stubGlobal('alert', alertMock);
	invokeMock.mockReset();
	invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
		if (cmd === 'save_document' && rejectNextSave) {
			rejectNextSave = false;
			throw `${SAVE_CONFLICT_PREFIX}: expected 3-7aigaz-3772q3`;
		}
		if (cmd === 'open_document') {
			if (diskContent === null) throw new Error('open_document: no disk content in this test');
			const uri = (args as { uri?: string } | undefined)?.uri ?? MD_URI;
			return { uri, content: diskContent, modified: 2 } satisfies DocumentPayload;
		}
		return null;
	});
	alertMock.mockReset();
	windowState.clearDocument();
});
afterEach(() => {
	cleanup();
	windowState.clearDocument();
	vi.unstubAllGlobals();
});

describe('Issue #851 (3) Markdown の面: 保存の照合で断られ Keep My Edits でディスクを読み直した後は、以前の保存と同じ中身が届いても捨てない', () => {
	it('K1 保存 A → Tail を打つ → 保存が断られる(ディスクは D=Intro が違う)→ Keep My Edits(D を読む・基準は D)→ 外部 A が届く → apply(マージ)・Tail の編集は残る・基準は A', async () => {
		const { container } = await mountMd();
		type('x', 2);
		const A = await save();
		expect(A).toBe(MD.replace('Second paragraph', 'xSecond paragraph'));
		type('y', 4);
		await settle();
		const mine = text();
		expect(mine).toBe(A.replace('Tail paragraph.', 'yTail paragraph.'));
		// ディスクは AI が Intro を変えた D(watcher は取りこぼした=file_changed は届いていない)
		const D = A.replace('Intro paragraph', 'Intro paragraph AI1');
		diskContent = D;
		await saveRejected(container);
		await fireEvent.click(must(container, KEEP, 'Keep My Edits'));
		await settleLong();
		expect(invokeMock).toHaveBeenCalledWith('open_document', expect.objectContaining({ uri: MD_URI }));
		expect(handle().conflict).toBe(false);
		expect(q(container, CONFLICT)).toBeNull();
		expect(handle().expectedHash(), 'Keep My Edits はディスクの版 D を基準にする').toBe(contentHash(D));
		expect(windowState.currentDocument?.content).toBe(D);
		expect(text(), '自分の編集はそのまま').toBe(mine);
		expect(handle().dirty).toBe(true);
		// AI が A に戻す(自分の以前の保存と同じ中身)。ディスクの版 D を取り込んだ後なのでエコーではない
		expect(arrive(A), 'ディスクを読み直した後の A は捨てない').toBe('apply');
		await settleLong();
		expect(text(), 'Intro は A の版・Tail の編集は残る').toBe(A.replace('Tail paragraph.', 'yTail paragraph.'));
		expect(handle().dirty).toBe(true);
		expect(handle().expectedHash(), '基準の版が A に進む(次の保存の照合が合う)').toBe(contentHash(A));
		expect(windowState.currentDocument?.content).toBe(A);
		expect(q(container, MERGED), '取り込みの知らせ').not.toBeNull();
		expect(q(container, CONFLICT)).toBeNull();
		expect(alertMock).not.toHaveBeenCalled();
	});

	it('K2 Keep My Edits(読み直し)の後にもう一度保存したら、その保存のエコーは ignore-echo のまま(閉じた側の固定)', async () => {
		const { container } = await mountMd();
		type('x', 2);
		const A1 = await save();
		type('y', 4);
		await settle();
		diskContent = A1.replace('Intro paragraph', 'Intro paragraph AI1');
		await saveRejected(container);
		await fireEvent.click(must(container, KEEP, 'Keep My Edits'));
		await settleLong();
		expect(handle().conflict).toBe(false);
		const A2 = await save();
		expect(A2).toBe(A1.replace('Tail paragraph.', 'yTail paragraph.'));
		const stateBefore = view().state;
		expect(arrive(A2), '新しい保存のエコー').toBe('ignore-echo');
		await settle();
		expect(view().state).toBe(stateBefore);
		expect(text()).toBe(A2);
		// 以前の保存 A1 が届いたら外部変更(clean な面にそのまま当たる)
		expect(arrive(A1), '以前の保存 A1 は今の selfHash ではない').toBe('apply');
		await settleLong();
		expect(text()).toBe(A1);
	});
});
