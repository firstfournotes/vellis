/**
 * Issue #839 — 文書を作り直す道(Reload File の Don't Save・Use the File on Disk・同じ URI の開き直し=`handle.reset`)で、脚注の番号と
 * 書式のツールバーの押下表示が古いまま残る見込み。component プロジェクト・JSDOM に Viewer を載せる(FormatToolbar.wiring.test.ts と同じ家風)。
 *
 * `MarkdownEditor.svelte` は取引の後の仕事(`refreshFootnoteNumbers`・`stateVersion++`)を `dispatchTransaction` に並べているが、
 * `view.updateState` で文書を入れ替える `resetDocument` はそこを通らない。再利用された脚注の NodeView の番号が古いまま残り、
 * 書式のツールバー(`handle.version` を見て `activeFormat` を引き直す)は次の取引まで古い押下表示のまま。
 *
 * ## 固定する振る舞い(直った後)
 * - `handle.reset(next)` の直後、面の脚注の番号(`sup.footnote-ref a` の文字・`section.footnote-definition[data-footnote-number]`)は
 *   新しい文書の参照の順(判断 6)どおり。参照の段落を前に足して順が入れ替わる文書で見る
 * - `handle.reset(next)` の直後、書式のツールバーの押下表示(段落の種類の select・Bold の aria-pressed)は新しい文書と選択の状態どおり
 *   (見出しの中にいた → 作り直して段落の先頭 → Body Text・Bold なし)
 * - Use the File on Disk(重なりの帯 → `useFileOnDisk`)でも同じ
 *
 * ## 判断の記録(test-writer 2026-11-28)
 * - 直し方は縛らない(plugin の `view().update` に置く・`resetDocument` から呼び直す、のどちらでも)。固定するのは作り直しの直後の DOM と
 *   ツールバーの表示だけ
 * - ツールバーは「次の取引まで古い」ので、取引を起こさずに(settle だけで)見る。`handle.version` そのものは実装の口なので見ない
 * - 「同じ URI の開き直し」は +page の経路(`applyText` → `face.reset`)なので、面の側は `handle.reset` で代表させる
 *
 * ## 修正前に赤になる理由
 * - `resetDocument` が `refreshFootnoteNumbers` を呼ばず、再利用された `sup.footnote-ref` の数字が前の文書のまま
 *   (a=1・b=2 のまま。新しい文書では b=1・a=2)。`stateVersion` も進まないので select は見出し 1 のまま
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { TextSelection } from 'prosemirror-state';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import { textSpots } from '../editor/markdown.testkit';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({ mountMermaid: vi.fn(async () => undefined) }));
vi.mock('$lib/events', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = { label: 'main', emit: vi.fn(async () => undefined), onFocusChanged: vi.fn(async () => () => {}), listen: vi.fn(async () => () => {}) };
	return { ...actual, getCurrentWindow: () => fake };
});

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

const MD_URI = 'file:///Users/a/notes/notes.md';
/** 参照の順: a → 1・b → 2。 */
const FN_BEFORE = ['Alpha[^a] text.', '', 'Beta[^b] text.', '', '[^a]: Note A.', '', '[^b]: Note B.', ''].join('\n');
/** 参照の段落を前に足す: b → 1・a → 2(再利用された Alpha / Beta の NodeView の番号が入れ替わる)。 */
const FN_AFTER = ['Zero[^b] first.', '', ...FN_BEFORE.split('\n')].join('\n');
/** ブロック 0 が見出し(太字入り)・ブロック 1 が段落。 */
const HEAD_BEFORE = '# Title **bold** word\n\nBody paragraph.\n';
/** 見出しの無い文書(作り直すと選択は先頭の段落)。 */
const HEAD_AFTER = 'Plain paragraph only.\n\nSecond paragraph.\n';

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false, fileEditor: true };
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
async function mountMd(content: string) {
	const d = doc(MD_URI, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, MD_URI);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index) });
	await settleLong();
	return result;
}

const PM = 'article.viewer .markdown-body [data-testid="markdown-editor"] .ProseMirror';

function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h || h.kind !== 'markdown') throw new Error('Markdown の handle が無い');
	return h;
}
/** 面の脚注の参照の番号(文書の順)と、定義の番号(label → data-footnote-number)。 */
function footnoteNumbers(container: ParentNode) {
	const refs = [...container.querySelectorAll<HTMLElement>(`${PM} sup.footnote-ref`)].map((sup) => [
		sup.getAttribute('data-label'),
		sup.querySelector('a')?.textContent ?? '',
	]);
	const defs = Object.fromEntries(
		[...container.querySelectorAll<HTMLElement>(`${PM} section.footnote-definition`)].map((s) => [
			s.getAttribute('data-label'),
			s.getAttribute('data-footnote-number'),
		]),
	);
	return { refs, defs };
}
function cursorInBlock(block: number, col: number) {
	const v = handle().view;
	const spot = textSpots(v.state.doc, block)[0]!;
	v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, spot.pos + col)));
}
async function showToolbar(container: HTMLElement) {
	if (!q(container, '[data-testid="format-toolbar"]')) {
		await fireEvent.click(q(container, '[data-testid="format-toolbar-toggle"]')!);
		await settleLong();
	}
	const bar = q(container, '[data-testid="format-toolbar"]');
	if (!bar) throw new Error('書式のツールバーが出ない');
	return bar;
}
function blockType(container: ParentNode): string {
	return (q(container, '[data-testid="format-block-type"]') as HTMLSelectElement).value;
}
function pressed(container: ParentNode, id: string): string | null {
	return q(container, `[data-testid="format-toolbar"] [data-format-id="${id}"]`)!.getAttribute('aria-pressed');
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	windowState.externalRemoved = false;
	localStorage.clear();
	vi.stubGlobal('alert', vi.fn());
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 脚注の番号
// ---------------------------------------------------------------------------

describe('Issue #839: 文書を作り直した直後、面の脚注の番号は新しい文書の参照の順', () => {
	it('前提: 開いた直後の番号は a=1・b=2', async () => {
		const { container } = await mountMd(FN_BEFORE);
		expect(footnoteNumbers(container)).toEqual({ refs: [['a', '1'], ['b', '2']], defs: { a: '1', b: '2' } });
	});

	it('handle.reset(参照の段落を前に足した文書)→ 再利用された参照も含めて b=1・a=2 になる', async () => {
		const { container } = await mountMd(FN_BEFORE);
		handle().reset(FN_AFTER);
		await settleLong();
		expect(handle().text()).toBe(FN_AFTER);
		expect(handle().dirty).toBe(false);
		expect(footnoteNumbers(container)).toEqual({
			refs: [
				['b', '1'],
				['a', '2'],
				['b', '1'],
			],
			defs: { a: '2', b: '1' },
		});
	});

	it('Use the File on Disk(重なりの帯)でも、作り直した直後の番号は新しい文書どおり', async () => {
		const { container } = await mountMd(FN_BEFORE);
		// 面の 1 行目を直してから、同じ 1 行目を別の中身にした外部変更 → 重なりの帯(マージできない)
		const v = handle().view;
		const spot = textSpots(v.state.doc, 0)[0]!;
		v.dispatch(v.state.tr.insertText('x', spot.pos));
		await settle();
		expect(handle().dirty).toBe(true);
		const disk = FN_AFTER.replace('Alpha[^a] text.', 'Alpha[^a] changed on disk.');
		const decision = handle().applyFileChanged(doc(MD_URI, disk));
		await settleLong();
		expect(decision, '前提: 同じ行を直したので重なり').toBe('external-conflict');
		handle().useFileOnDisk();
		await settleLong();
		expect(handle().text()).toBe(disk);
		expect(footnoteNumbers(container)).toEqual({
			refs: [
				['b', '1'],
				['a', '2'],
				['b', '1'],
			],
			defs: { a: '2', b: '1' },
		});
	});
});

// ---------------------------------------------------------------------------
// 書式のツールバーの押下表示
// ---------------------------------------------------------------------------

describe('Issue #839: 文書を作り直した直後、書式のツールバーの押下表示は新しい文書と選択の状態どおり', () => {
	it('見出し 1 の太字の中 → handle.reset(見出しの無い文書)→ 取引を起こさなくても Body Text・Bold なし', async () => {
		const { container } = await mountMd(HEAD_BEFORE);
		await showToolbar(container);
		// 見出しの中の **bold** の中へ
		const v = handle().view;
		const bold = textSpots(v.state.doc, 0).find((t) => t.marks.includes('strong'))!;
		v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, bold.pos + 1)));
		await settleLong();
		expect(blockType(container), '前提: 見出し 1').toBe('format-heading-1');
		expect(pressed(container, 'format-bold'), '前提: 太字の中').toBe('true');

		handle().reset(HEAD_AFTER);
		await settleLong();
		expect(handle().text()).toBe(HEAD_AFTER);
		expect(blockType(container), '作り直した直後は新しい文書の選択(先頭の段落)の種類').toBe('format-body-text');
		expect(pressed(container, 'format-bold'), '太字は押下表示でない').toBe('false');
	});

	it('段落の中 → handle.reset(見出しで始まる文書)→ 見出し 1 が押下表示', async () => {
		const { container } = await mountMd(HEAD_AFTER);
		await showToolbar(container);
		cursorInBlock(1, 3);
		await settleLong();
		expect(blockType(container), '前提: 段落').toBe('format-body-text');

		handle().reset(HEAD_BEFORE);
		await settleLong();
		expect(blockType(container), '作り直した直後は先頭の見出しの種類').toBe('format-heading-1');
	});
});
