/**
 * 要件#48 追補g(2026-10-11・backlog 330)の受け入れテスト AC-48-追g (a)〜(f)=
 * 外部で削除されても dirty なら閉じない(帯で知らせ、保存すれば同じパスに書く)。
 *
 * runes を含む `stores/window-state.svelte.ts` は component プロジェクト(*.wiring.test.ts)
 * でしかコンパイルできないため、状態遷移・帯・関門の全部をここで判定する
 * (`Viewer.edit.wiring.test.ts` と同じ家風)。
 *
 * ## test-writer が決めた名前(implementer はこれに合わせる)
 * - store の入口: `windowState.applyFileRemoved(uri: string)`。返り値は決定の文字列
 *   `'keep'`(dirty なので文書を保つ・印を立てる)/ `'close'`(dirty でないので従来どおり
 *   `clearDocument`)/ `'ignore'`(表示中の文書の uri ではない・文書が無い)
 * - 印: `windowState.externalRemoved: boolean`(既定 false)
 * - 帯: `data-testid="external-removed-banner"`・`role="alert"`・外部変更の帯と同じ見た目=
 *   class に `external-change` を持つ(同じ規則で描く)
 *   - 文言(値固定・契約(追補g)2): `This file was deleted outside the app. Your edits have not been saved.`
 *   - `data-testid="external-removed-save"`: 文字 `Save`・title `Save your edits to the file again`
 *   - `data-testid="external-removed-close"`: 文字 `Close`・title `Close the file (your edits are discarded)`
 *
 * ## 判定するもの(契約(追補g)1〜4= req-48.md)
 * - (a) dirty の文書に同じ uri の削除 → 文書・バッファ・モードが残り印が立つ。閲覧中 /
 *   編集中で未変更なら閉じる。別の uri・文書なしでは何も起きない
 * - (b) 印が立つと帯が出る(文言・ボタン2つ・title・role)。印が無ければ出ない
 * - (c) 帯の Save → `save_document` が同じ uri と編集バッファの中身で呼ばれ、成功すると印と
 *   dirty が消える(失敗なら残る)。Close → 文書が閉じ、`save_document` は呼ばれない。
 *   Command + S と同じ経路= `markSaved`(`$lib/save-document` の成功後の記帳)で印が消える
 * - (d) 印のあと同じ文書の `file_changed`(中身が編集と違う)→ 印が消えて外部変更の帯
 * - (e) 別の文書を開く・root が変わる・`clearDocument` → 印が消える。保存せずに編集を終える
 *   (Esc / Done / Command + E の関門= `confirmDiscardEdits` で破棄)→ 文書が閉じる。
 *   関門でキャンセルなら残り、保存を選べば文書は残って印が消える
 * - (f) 配線(ソース走査): `+page.svelte` の `file_removed` の listener が
 *   `windowState.applyFileRemoved(` を通り、listener の中で直に `clearDocument(` を呼ばない。
 *   store の `applyFileRemoved` の本体が `dirty` を見て `clearDocument(` に分岐する
 *
 * ## 想定される赤(実装前)
 * `applyFileRemoved` が無い(TypeError)・`externalRemoved` が undefined(`toBe(false)` が赤)・
 * 帯の testid が無い・`+page.svelte` の listener が `clearDocument()` を直に呼んでいる。
 * 「印が無ければ帯が出ない」(b) の1件だけは実装前から緑(否定の固定)。
 *
 * ## スタブの設計(Viewer.edit.wiring.test.ts と同じ)
 * - $lib/ipc / @tauri-apps/plugin-opener: モジュールモック。`invoke` の既定応答は
 *   beforeEach で `mockReset` → `mockResolvedValue(null)` し直す(ファクトリの vi.fn は
 *   restoreAllMocks で戻らない)
 * - @tauri-apps/plugin-dialog: `message` をモック(関門 `confirmDiscardEdits` は実体を通す)。
 *   要件#48 追補o(2026-10-28・由谷承認の書き換え)で `ask` 2 枚から `message` 1 枚の 3 択へ。
 *   確認の部分(モック・答え・回数)だけを直し、確認の後の期待値は変えていない
 * - `alert` は `vi.stubGlobal`(保存失敗の通知が jsdom の未実装で落ちないように)
 * - `$state` のオブジェクトは deep proxy なので同一性(`toBe`)では見ず、uri / content で見る
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

import { message } from '@tauri-apps/plugin-dialog';
import { invoke } from '$lib/ipc';
import { confirmDiscardEdits } from '$lib/edit-guard';
import { saveDocument } from '$lib/save-document';

const messageMock = vi.mocked(message);
const invokeMock = vi.mocked(invoke);
const alertMock = vi.fn((_message?: unknown) => {});

// ---------------------------------------------------------------------------
// 値固定(契約(追補g)2)
// ---------------------------------------------------------------------------

const REMOVED_MESSAGE = 'This file was deleted outside the app. Your edits have not been saved.';
const REMOVED_SAVE_TITLE = 'Save your edits to the file again';
const REMOVED_CLOSE_TITLE = 'Close the file (your edits are discarded)';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const TXT_URI = 'file:///Users/a/notes/memo.txt';
const OTHER_URI = 'file:///Users/a/notes/other.txt';
const TXT_CONTENT = 'first line\nsecond line\n';
const EDITED = TXT_CONTENT + 'my edit\n';

function txtDoc(content: string = TXT_CONTENT): DocumentPayload {
	return { uri: TXT_URI, content, modified: 1 };
}

/** file-type.ts の renderPlainText と同形のマークアップ(text 種別の html prop)。 */
function plainTextHtml(content: string): string {
	const escaped = content.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
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
function renderText(content: string = TXT_CONTENT) {
	const doc = txtDoc(content);
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, plainTextHtml(content)) });
}

function getPre(container: HTMLElement): HTMLElement {
	const pre = container.querySelector('pre.vellis-plaintext');
	if (!pre) throw new Error('pre.vellis-plaintext not found');
	return pre as HTMLElement;
}

/** store だけで dirty の編集状態にする(Viewer 無し)。 */
function makeDirtyInStore(): void {
	windowState.setDocument(txtDoc());
	expect(windowState.beginEdit()).toBe(true);
	windowState.updateBuffer(EDITED);
	expect(windowState.dirty).toBe(true);
}

/** Viewer を載せ、ダブルクリック → input で dirty にする。 */
async function renderDirty() {
	const rendered = renderText();
	await fireEvent.dblClick(rendered.container.querySelector('.markdown-body') as HTMLElement);
	await tick();
	const pre = getPre(rendered.container);
	pre.textContent = EDITED;
	await fireEvent.input(pre);
	expect(windowState.dirty).toBe(true);
	return { ...rendered, pre };
}

/** message → (保存) → endEdit と await を連ねる処理を流しきる。 */
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

const saveCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'save_document');

/** 印の読み出し(未実装なら undefined が返り、`toBe(false)` / `toBe(true)` の赤で分かる)。 */
const removedFlag = () => (windowState as unknown as { externalRemoved?: boolean }).externalRemoved;

beforeEach(() => {
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
	messageMock.mockReset();
	alertMock.mockClear();
	vi.stubGlobal('alert', alertMock);
	// 前のテストの編集状態・文書を持ち越さない。
	windowState.endEdit();
	windowState.clearDocument();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (a) WindowState — applyFileRemoved の分岐
// ---------------------------------------------------------------------------

describe('AC-48-追g (a): WindowState.applyFileRemoved — dirty なら保つ・そうでなければ閉じる・別の uri は無視', () => {
	it('既定では印は立っていない(externalRemoved === false)', () => {
		windowState.setDocument(txtDoc());
		expect(removedFlag()).toBe(false);
	});

	it('dirty の文書に同じ uri の削除 → keep: 文書・バッファ・モードが残り、印が立つ・dirty のまま', () => {
		makeDirtyInStore();

		const decision = windowState.applyFileRemoved(TXT_URI);

		expect(decision).toBe('keep');
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.currentDocument?.content).toBe(TXT_CONTENT);
		expect(windowState.editBuffer).toBe(EDITED);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.dirty).toBe(true);
		expect(removedFlag()).toBe(true);
	});

	it('閲覧中の文書に同じ uri の削除 → close: 従来どおり閉じる(印は立たない)', () => {
		windowState.setDocument(txtDoc());

		const decision = windowState.applyFileRemoved(TXT_URI);

		expect(decision).toBe('close');
		expect(windowState.currentDocument).toBe(null);
		expect(removedFlag()).toBe(false);
	});

	it('編集中でも未変更なら close: 閉じて編集状態も畳む(印は立たない)', () => {
		windowState.setDocument(txtDoc());
		expect(windowState.beginEdit()).toBe(true);
		expect(windowState.dirty).toBe(false);

		const decision = windowState.applyFileRemoved(TXT_URI);

		expect(decision).toBe('close');
		expect(windowState.currentDocument).toBe(null);
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(removedFlag()).toBe(false);
	});

	it('dirty でも別の uri の削除 → ignore: 何も起きない(文書・バッファ・モード・印)', () => {
		makeDirtyInStore();

		const decision = windowState.applyFileRemoved(OTHER_URI);

		expect(decision).toBe('ignore');
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.currentDocument?.content).toBe(TXT_CONTENT);
		expect(windowState.editBuffer).toBe(EDITED);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.dirty).toBe(true);
		expect(removedFlag()).toBe(false);
	});

	it('閲覧中に別の uri の削除 → ignore: 文書は残る', () => {
		windowState.setDocument(txtDoc());

		const decision = windowState.applyFileRemoved(OTHER_URI);

		expect(decision).toBe('ignore');
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(removedFlag()).toBe(false);
	});

	it('文書が無いときの削除 → ignore(落ちない・印は立たない)', () => {
		expect(windowState.currentDocument).toBe(null);

		const decision = windowState.applyFileRemoved(TXT_URI);

		expect(decision).toBe('ignore');
		expect(windowState.currentDocument).toBe(null);
		expect(removedFlag()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// (c)(d)(e) WindowState — 印が消えるとき(契約(追補g)3)
// ---------------------------------------------------------------------------

describe('AC-48-追g (c)(d)(e): WindowState — 印が消えるとき', () => {
	it('(c) 保存の記帳(markSaved= Command + S と同じ経路の成功後)で印と dirty が消え、編集中のまま', () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);
		expect(removedFlag()).toBe(true);

		windowState.markSaved(EDITED);

		expect(removedFlag()).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.currentDocument?.content).toBe(EDITED);
	});

	it('(c) `$lib/save-document` の saveDocument は save_document を同じ uri と中身で呼び、成功で印が消える', async () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);

		await saveDocument(TXT_URI, EDITED);

		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: EDITED }]]);
		expect(removedFlag()).toBe(false);
		expect(windowState.dirty).toBe(false);
	});

	it('(c) 保存に失敗したら印も dirty も残る', async () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);
		invokeMock.mockRejectedValueOnce(new Error('disk full'));

		await expect(saveDocument(TXT_URI, EDITED)).rejects.toThrow();

		expect(removedFlag()).toBe(true);
		expect(windowState.dirty).toBe(true);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
	});

	it('(d) 印のあと同じ文書の file_changed(中身が編集と違う)→ 印が消え、外部変更の衝突になる', () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);
		expect(removedFlag()).toBe(true);

		const decision = windowState.applyFileChanged({ uri: TXT_URI, content: 'recreated outside\n', modified: 9 });

		expect(decision).toBe('external-conflict');
		expect(removedFlag()).toBe(false);
		expect(windowState.externalChange).toEqual({ content: 'recreated outside\n', modified: 9 });
		expect(windowState.currentDocument?.content).toBe(TXT_CONTENT);
		expect(windowState.editBuffer).toBe(EDITED);
		expect(windowState.dirty).toBe(true);
	});

	it('(e) 別の文書を開く(setDocument)→ 印が消える', () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);

		windowState.setDocument({ uri: OTHER_URI, content: 'other\n', modified: 1 });

		expect(removedFlag()).toBe(false);
		expect(windowState.currentDocument?.uri).toBe(OTHER_URI);
		expect(windowState.editMode).toBe('view');
	});

	it('(e) root が変わる(applyRoot・文書が残る切替)→ 印が消える', () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);

		windowState.applyRoot('file:///Users/a/other-root', [], true);

		expect(removedFlag()).toBe(false);
		expect(windowState.editMode).toBe('view');
	});

	it('(e) root が変わる(applyRoot・文書も閉じる切替)→ 印が消える', () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);

		windowState.applyRoot('file:///Users/a/other-root', [], false);

		expect(removedFlag()).toBe(false);
		expect(windowState.currentDocument).toBe(null);
	});

	it('(e) clearDocument → 印が消える', () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);

		windowState.clearDocument();

		expect(removedFlag()).toBe(false);
		expect(windowState.currentDocument).toBe(null);
	});
});

// ---------------------------------------------------------------------------
// (e) 保存せずに編集を終える= confirmDiscardEdits(Esc / Done / Command + E の関門)
// ---------------------------------------------------------------------------

describe('AC-48-追g (e): 保存せずに編集を終える(confirmDiscardEdits で破棄)→ 文書が閉じる', () => {
	it("破棄(Don't Save)→ 文書が閉じ、印も消え、save_document は呼ばれない", async () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);
		messageMock.mockResolvedValueOnce("Don't Save"); // 1 枚の 3 択: 保存しない

		const proceeded = await confirmDiscardEdits();

		expect(proceeded).toBe(true);
		expect(windowState.currentDocument).toBe(null);
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(removedFlag()).toBe(false);
		expect(saveCalls()).toEqual([]);
	});

	it('キャンセル(Cancel)→ 文書・バッファ・印はそのまま', async () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);
		messageMock.mockResolvedValueOnce('Cancel'); // 1 枚の 3 択: キャンセル

		const proceeded = await confirmDiscardEdits();

		expect(proceeded).toBe(false);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.editBuffer).toBe(EDITED);
		expect(windowState.editMode).toBe('edit');
		expect(removedFlag()).toBe(true);
	});

	it('保存する(Save)→ save_document が同じ uri と中身で呼ばれ、文書は残って印が消える', async () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);
		messageMock.mockResolvedValueOnce('Save'); // 1 枚の 3 択: 保存する

		const proceeded = await confirmDiscardEdits();

		expect(proceeded).toBe(true);
		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: EDITED }]]);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.currentDocument?.content).toBe(EDITED);
		expect(windowState.editMode).toBe('view');
		expect(removedFlag()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// (b) Viewer — 帯の表示
// ---------------------------------------------------------------------------

describe('AC-48-追g (b): Viewer — 印が立つと帯が出る(文言・ボタン2つ・title・role)', () => {
	it('dirty の文書の削除 → external-removed-banner(role=alert・外部変更の帯と同じ見た目)が出る', async () => {
		await renderDirty();

		windowState.applyFileRemoved(TXT_URI);
		await tick();

		const banner = screen.getByTestId('external-removed-banner');
		expect(banner.getAttribute('role')).toBe('alert');
		expect(banner.classList.contains('external-change')).toBe(true);
		expect(banner.textContent?.replace(/\s+/g, ' ').trim()).toContain(REMOVED_MESSAGE);
		// 外部変更の帯(契約⑥)とは別物。削除だけでは衝突の帯は出ない。
		expect(screen.queryByTestId('external-change-banner')).toBeNull();
	});

	it('帯の Save ボタン: 文字 "Save"・title 値固定', async () => {
		await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();

		const save = screen.getByTestId('external-removed-save');
		expect(save.tagName).toBe('BUTTON');
		expect(save.textContent?.trim()).toBe('Save');
		expect(save.getAttribute('title')).toBe(REMOVED_SAVE_TITLE);
	});

	it('帯の Close ボタン: 文字 "Close"・title 値固定', async () => {
		await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();

		const close = screen.getByTestId('external-removed-close');
		expect(close.tagName).toBe('BUTTON');
		expect(close.textContent?.trim()).toBe('Close');
		expect(close.getAttribute('title')).toBe(REMOVED_CLOSE_TITLE);
	});

	it('帯が出ても編集面(contenteditable)とバッファは残る', async () => {
		const { container } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();

		expect(getPre(container).getAttribute('contenteditable')).toBe('true');
		expect(windowState.editBuffer).toBe(EDITED);
	});

	it('印が無いときは帯が出ない(閲覧中・dirty で削除が無いとき)', async () => {
		renderText();
		expect(screen.queryByTestId('external-removed-banner')).toBeNull();
		cleanup();

		await renderDirty();
		expect(screen.queryByTestId('external-removed-banner')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// (c) Viewer — 帯の Save / Close
// ---------------------------------------------------------------------------

describe('AC-48-追g (c): Viewer — 帯の Save は同じ uri と編集バッファで保存し、Close は文書を閉じる', () => {
	it('Save → save_document(同じ uri・編集バッファの中身)が呼ばれ、成功すると印と dirty と帯が消える', async () => {
		await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();

		await fireEvent.click(screen.getByTestId('external-removed-save'));
		await settle();

		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: EDITED }]]);
		expect(removedFlag()).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.currentDocument?.content).toBe(EDITED);
		expect(screen.queryByTestId('external-removed-banner')).toBeNull();
		expect(messageMock).not.toHaveBeenCalled();
	});

	it('Save が失敗したら印・dirty・帯は残る(文書は閉じない)', async () => {
		await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();
		invokeMock.mockRejectedValueOnce(new Error('disk full'));

		await fireEvent.click(screen.getByTestId('external-removed-save'));
		await settle();

		expect(saveCalls()).toHaveLength(1);
		expect(removedFlag()).toBe(true);
		expect(windowState.dirty).toBe(true);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(screen.getByTestId('external-removed-banner')).toBeTruthy();
	});

	it('Close → 文書が閉じ(編集は捨てられ)、save_document は呼ばれない', async () => {
		await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();

		await fireEvent.click(screen.getByTestId('external-removed-close'));
		await settle();

		expect(windowState.currentDocument).toBe(null);
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(removedFlag()).toBe(false);
		expect(saveCalls()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// (d)(e) Viewer — 帯の入れ替わりと Esc / Done
// ---------------------------------------------------------------------------

describe('AC-48-追g (d)(e): Viewer — 作り直しで外部変更の帯へ・Esc / Done の破棄で閉じる', () => {
	it('(d) 印のあと同じ文書の file_changed(中身が違う)→ 削除の帯が消え、外部変更の帯が出る', async () => {
		await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();
		expect(screen.getByTestId('external-removed-banner')).toBeTruthy();

		const decision = windowState.applyFileChanged({ uri: TXT_URI, content: 'recreated outside\n', modified: 9 });
		await tick();

		expect(decision).toBe('external-conflict');
		expect(screen.queryByTestId('external-removed-banner')).toBeNull();
		expect(screen.getByTestId('external-change-banner')).toBeTruthy();
		expect(screen.getByTestId('external-overwrite')).toBeTruthy();
		expect(screen.getByTestId('external-reload')).toBeTruthy();
	});

	it("(e) Esc → Don't Save(保存しない)→ 文書が閉じる(save_document は呼ばれない)", async () => {
		const { pre } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();
		messageMock.mockResolvedValueOnce("Don't Save"); // 1 枚の 3 択: 保存しない

		await fireEvent.keyDown(pre, { key: 'Escape' });
		await settle();

		expect(messageMock).toHaveBeenCalledTimes(1);
		expect(windowState.currentDocument).toBe(null);
		expect(removedFlag()).toBe(false);
		expect(saveCalls()).toEqual([]);
	});

	it("(e) Done → Don't Save(保存しない)→ 文書が閉じる", async () => {
		await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();
		messageMock.mockResolvedValueOnce("Don't Save");

		await fireEvent.click(screen.getByTestId('edit-done'));
		await settle();

		expect(messageMock).toHaveBeenCalledTimes(1);
		expect(windowState.currentDocument).toBe(null);
		expect(removedFlag()).toBe(false);
		expect(saveCalls()).toEqual([]);
	});

	it('(e) Esc → Cancel(キャンセル)→ 文書・帯・バッファはそのまま', async () => {
		const { container, pre } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();
		messageMock.mockResolvedValueOnce('Cancel'); // 1 枚の 3 択: キャンセル

		await fireEvent.keyDown(pre, { key: 'Escape' });
		await settle();

		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.editBuffer).toBe(EDITED);
		expect(removedFlag()).toBe(true);
		expect(screen.getByTestId('external-removed-banner')).toBeTruthy();
		expect(getPre(container).getAttribute('contenteditable')).toBe('true');
	});
});

// ---------------------------------------------------------------------------
// (f) 配線(ソース走査)
// ---------------------------------------------------------------------------

const PAGE_PATH = resolve(__dirname, '../routes/+page.svelte');
const STORE_PATH = resolve(__dirname, '../stores/window-state.svelte.ts');

/** コメント(行・ブロック)を落とす(コメントの中の語を数えない)。 */
function stripJsComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** `start` 以降で最初の `{` から、対応する `}` までの中身。 */
function braceBody(src: string, start: number, what: string): string {
	const open = src.indexOf('{', start);
	expect(open, `${what}: opening brace`).toBeGreaterThanOrEqual(0);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	throw new Error(`${what}: unbalanced braces`);
}

/** `open`(`(` の位置)から対応する `)` までの中身。 */
function parenBody(src: string, open: number, what: string): string {
	expect(open, `${what}: opening paren`).toBeGreaterThanOrEqual(0);
	expect(src[open], `${what}: opening paren`).toBe('(');
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '(') depth++;
		else if (src[i] === ')') {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	throw new Error(`${what}: unbalanced parens`);
}

describe('AC-48-追g (f): 配線(ソース走査)', () => {
	it("+page.svelte の listen('file_removed') の listener は windowState.applyFileRemoved( を通り、直に clearDocument( を呼ばない", () => {
		const src = stripJsComments(readFileSync(PAGE_PATH, 'utf8'));
		const at = src.indexOf("'file_removed'");
		expect(at, "listen('file_removed') in +page.svelte").toBeGreaterThanOrEqual(0);
		// `listen(` の引数全体(イベント名 + listener)を括弧の対応で切り出す。
		const call = parenBody(src, src.lastIndexOf('(', at), "listen('file_removed', …)");
		expect(call).toContain("'file_removed'");

		expect(call).toContain('windowState.applyFileRemoved(');
		expect(call).not.toContain('clearDocument(');
	});

	it("+page.svelte に 'file_removed' の listen は 1 か所だけ(別の経路で clearDocument へ回らない)", () => {
		const src = stripJsComments(readFileSync(PAGE_PATH, 'utf8'));
		expect(src.split("'file_removed'").length - 1).toBe(1);
	});

	it('window-state.svelte.ts の applyFileRemoved の本体が dirty を見て clearDocument( に分岐する', () => {
		const src = stripJsComments(readFileSync(STORE_PATH, 'utf8'));
		const at = src.search(/\bapplyFileRemoved\s*\(/);
		expect(at, 'applyFileRemoved( in window-state.svelte.ts').toBeGreaterThanOrEqual(0);
		const body = braceBody(src, src.indexOf(')', at), 'applyFileRemoved body');

		expect(body).toMatch(/\bdirty\b/);
		expect(body).toContain('clearDocument(');
	});
});
