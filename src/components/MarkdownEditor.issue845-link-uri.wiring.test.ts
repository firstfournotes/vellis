/**
 * Issue #845 — Markdown の本文のリンクで、空白や日本語を含む名前のファイルが開けない疑い(URI がパーセントエンコードされたまま
 * `open_document` / `new_window` に渡る)。component プロジェクト・JSDOM に Viewer を載せる(MarkdownEditor.wiring.test.ts の「航行」と同じ家風)。
 *
 * `MarkdownEditor.svelte` の `resolveHref` は `new URL(href, uri).toString()` をそのまま渡す。`URL` はパスをパーセントエンコードするので
 * `./メモ 1.md` は `file:///…/%E3%83%A1%E3%83%A2%201.md` になるが、Rust の `fs/uri.rs` はデコードせず、アプリのほかの URI(Explorer の行・
 * `open_document`)はエンコードしない形。要件88 の HTML のリンクは開く前に `toDocumentUri` でパスを戻している。
 *
 * ## 固定する振る舞い(直った後)
 * - リンクのクリックで `open_document` に渡る `uri` は**アプリの形**(パスを符号化しない=`file://` + 字面のままのパス)
 *   - リンク先に空白・日本語がそのまま書かれている(`<./メモ 1.md>`)→ `file:///Users/a/My Docs/メモ 1.md`
 *   - リンク先がパーセントエンコードで書かれている(`./notes%20two.md`)→ `file:///Users/a/My Docs/notes two.md`(符号は戻す)
 *   - リンク先に単独の `%`(`50%off.md`。`%of` は符号でない)→ `file:///Users/a/My Docs/50%off.md`(崩れた符号で全体を諦めない)
 * - Shift + クリック(`new_window` の `path`)も同じ形
 * - 文書のフォルダ名に `#`・`?`・`%`・空白があっても、相対のリンクは**そのフォルダの中**に解ける(`new URL` が fragment / query に読まない)
 * - 今までの `./other.md`・`../up.md`・`sub/deep.md` は変わらない(回帰の守り)
 *
 * ## 判断の記録(test-writer 2026-11-28)
 * - 「アプリの形」は Rust の `Uri::with_path`(`format!("file://{}", path.display())`)と同じ=`file://` + パスの字面。ホストは無い
 * - 直し方は縛らない(Markdown の側も `toDocumentUri` を通す・アプリの URI → URL の変換を 1 か所にまとめる、のどちらでも)。
 *   Issue のコメントの 2 件(フォルダ名の `#` / `?`・`%` と空白の同居)も同じテストで固定する(`toDocumentUri` が崩れた符号で
 *   エンコードしたままを返す道は、`50%off.md` のケースが塞ぐ)
 * - ssh の文書は Markdown の編集面を作らない(読み取り専用の描画)ので、ssh のリンクはここでは見ない(実機の確認へ)
 * - `html` prop(読み取り専用の描画)は文書の URI と無関係なので、描画器には無難な URI で描かせる(`#` を含む URI で描画器が落ちても
 *   本件の判定に混ぜない)
 *
 * ## 修正前に赤になる理由
 * - `open_document` / `new_window` に `file:///Users/a/My%20Docs/%E3%83%A1%E3%83%A2%201.md` のようなエンコードした URI が渡る。
 *   `file:///Users/a/b#c/doc.md` の `other.md` は `file:///Users/a/other.md` に解ける(`#c/doc.md` を fragment と読む)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import type { MarkdownEditorHandle } from '../editor/file-editor';

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
import { invoke } from '$lib/ipc';
import { message } from '@tauri-apps/plugin-dialog';

const invokeMock = vi.mocked(invoke);
const messageMock = vi.mocked(message);

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

const ROOT = 'file:///Users/a';
/** 描画器(読み取り専用の html)に渡す無難な URI。文書の URI とは独立。 */
const RENDER_URI = 'file:///Users/a/render/plan.md';

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
async function mountMd(uri: string, content: string) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, RENDER_URI);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index) });
	await settleLong();
	return result;
}

const PM = 'article.viewer .markdown-body [data-testid="markdown-editor"] .ProseMirror';

function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h || h.kind !== 'markdown') throw new Error('Markdown の handle が無い');
	return h;
}
/** 文言 `label` のリンク(編集面の中)。 */
function link(container: ParentNode, label: string): HTMLAnchorElement {
	const a = [...container.querySelectorAll<HTMLAnchorElement>(`${PM} a`)].find((x) => x.textContent === label);
	if (!a) throw new Error(`編集面にリンク「${label}」が無い`);
	return a;
}
async function click(container: ParentNode, label: string, init: MouseEventInit = {}) {
	await fireEvent.click(link(container, label), init);
	await settleLong();
}
function openedUri(): string {
	const calls = invokeMock.mock.calls.filter((c) => c[0] === 'open_document');
	expect(calls, 'open_document が 1 回').toHaveLength(1);
	return String((calls[0]![1] as { uri: string }).uri);
}
function newWindowPath(): string {
	const calls = invokeMock.mock.calls.filter((c) => c[0] === 'new_window');
	expect(calls, 'new_window が 1 回').toHaveLength(1);
	expect((calls[0]![1] as { root: string | null }).root).toBe(ROOT);
	return String((calls[0]![1] as { path: string }).path);
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	windowState.externalRemoved = false;
	windowState.root = ROOT;
	invokeMock.mockReset();
	invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
		if (cmd === 'open_document') return doc((args as { uri: string }).uri, '# Other\n');
		return null;
	});
	messageMock.mockReset();
	vi.stubGlobal('alert', vi.fn());
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 空白・日本語・% を含む名前のファイル
// ---------------------------------------------------------------------------

const SPACED_DIR_URI = 'file:///Users/a/My Docs/plan.md';
const SPACED_LINKS = [
	'See [spaced](<./メモ 1.md>), [encoded](./notes%20two.md), [percent](50%off.md), [sub](sub/deep.md), [up](../up.md).',
	'',
].join('\n');

describe('Issue #845: 本文のリンクで開く URI はアプリの形(パスを符号化しない)', () => {
	it('空白と日本語をそのまま書いたリンク(<./メモ 1.md>)→ open_document の uri は字面のまま', async () => {
		const { container } = await mountMd(SPACED_DIR_URI, SPACED_LINKS);
		await click(container, 'spaced');
		expect(openedUri()).toBe('file:///Users/a/My Docs/メモ 1.md');
		expect(messageMock, '未保存の確認は出ない(dirty でない)').not.toHaveBeenCalled();
		// 別の文書が開けると windowState.setDocument が fileEditor を外す(Viewer は載せ直さない)ので handle() は見ない。dirty でないことは上の messageMock の期待が表す
	});

	it('パーセントエンコードで書いたリンク(./notes%20two.md)→ 符号を戻した uri', async () => {
		const { container } = await mountMd(SPACED_DIR_URI, SPACED_LINKS);
		await click(container, 'encoded');
		expect(openedUri()).toBe('file:///Users/a/My Docs/notes two.md');
	});

	it('単独の % を含む名前(50%off.md)と空白のフォルダが同居しても、フォルダの空白は戻し % は字面のまま', async () => {
		const { container } = await mountMd(SPACED_DIR_URI, SPACED_LINKS);
		await click(container, 'percent');
		expect(openedUri()).toBe('file:///Users/a/My Docs/50%off.md');
	});

	it('Shift + クリック(新しい窓)の path も同じ形', async () => {
		const { container } = await mountMd(SPACED_DIR_URI, SPACED_LINKS);
		await click(container, 'spaced', { shiftKey: true });
		expect(newWindowPath()).toBe('file:///Users/a/My Docs/メモ 1.md');
		expect(invokeMock.mock.calls.some((c) => c[0] === 'open_document'), 'この窓では開かない').toBe(false);
	});

	it('サブフォルダ(sub/deep.md)と上のフォルダ(../up.md)も同じ形(フォルダ名の空白は字面のまま)', async () => {
		const { container } = await mountMd(SPACED_DIR_URI, SPACED_LINKS);
		await click(container, 'sub');
		expect(openedUri()).toBe('file:///Users/a/My Docs/sub/deep.md');
		invokeMock.mockClear();
		await click(container, 'up');
		expect(openedUri()).toBe('file:///Users/a/up.md');
	});
});

// ---------------------------------------------------------------------------
// 文書のフォルダ名に #・?・% があるとき(Issue のコメント)
// ---------------------------------------------------------------------------

const OTHER_LINK = 'Go to [other](other.md).\n';

describe('Issue #845(コメント): 文書のフォルダ名に #・?・% があっても、相対のリンクはそのフォルダの中に解ける', () => {
	it('フォルダ名に #(file:///Users/a/b#c/doc.md の other.md → file:///Users/a/b#c/other.md)', async () => {
		const { container } = await mountMd('file:///Users/a/b#c/doc.md', OTHER_LINK);
		await click(container, 'other');
		expect(openedUri()).toBe('file:///Users/a/b#c/other.md');
	});

	it('フォルダ名に ?(file:///Users/a/q?r/doc.md の other.md → file:///Users/a/q?r/other.md)', async () => {
		const { container } = await mountMd('file:///Users/a/q?r/doc.md', OTHER_LINK);
		await click(container, 'other');
		expect(openedUri()).toBe('file:///Users/a/q?r/other.md');
	});

	it('フォルダ名に % と空白(file:///Users/a/50% off/doc.md の other.md → file:///Users/a/50% off/other.md)', async () => {
		const { container } = await mountMd('file:///Users/a/50% off/doc.md', OTHER_LINK);
		await click(container, 'other');
		expect(openedUri()).toBe('file:///Users/a/50% off/other.md');
	});

	it('フォルダ名に # のとき Shift + クリックの path も同じフォルダの中', async () => {
		const { container } = await mountMd('file:///Users/a/b#c/doc.md', OTHER_LINK);
		await click(container, 'other', { shiftKey: true });
		expect(newWindowPath()).toBe('file:///Users/a/b#c/other.md');
	});

	it('回帰の守り: 普通のフォルダ(file:///Users/a/notes/plan.md の other.md)は変わらない', async () => {
		const { container } = await mountMd('file:///Users/a/notes/plan.md', OTHER_LINK);
		await click(container, 'other');
		expect(openedUri()).toBe('file:///Users/a/notes/other.md');
	});
});
