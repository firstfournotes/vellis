/**
 * 要件#48 追補i(2026-10-12・backlog 341)の受け入れテスト AC-48-追i (c)=
 * 削除の印が立って dirty でないとき、Command + S(File > Save)で書き直せる — store の筋道。
 * (a) 真理値表と (b) `+page.svelte` のソース走査は
 * `src/lib/document-edit.save-on-command.acceptance.test.ts`。
 *
 * runes を含む `stores/window-state.svelte.ts` は component プロジェクト(*.wiring.test.ts)
 * でしかコンパイルできないため、store の値を `shouldSaveOnCommand` に渡して保存の経路
 * (`saveDocument`)を通す筋道をここで判定する(`Viewer.external-removed.wiring.test.ts`=
 * 追補g・`Viewer.external-removed-h.wiring.test.ts`= 追補h と同じ家風。追補g の名前
 * `applyFileRemoved` / `externalRemoved` / testid `external-removed-banner` をそのまま使う)。
 *
 * ## テストが前提にする名前(契約(追補i)2= req-48.md)
 * - `$lib/document-edit` が `shouldSaveOnCommand({ mode, dirty, externalRemoved }: { mode: EditMode;
 *   dirty: boolean; externalRemoved: boolean }): boolean` を export する
 * - 呼ぶ側は store の `windowState.editMode`・`windowState.dirty`・`windowState.externalRemoved`
 *   をそのまま渡す(ここでは `+page.svelte` の `saveCurrentEdits` と同じ渡し方を手で組む)
 *
 * ## 判定するもの(契約(追補i)1〜3= req-48.md)
 * - (c) text 文書を開いて編集に入り、dirty にして同じ uri の `applyFileRemoved` で印を立て、
 *   バッファを原文に戻す(dirty が偽・印は真)→ store の値を `shouldSaveOnCommand` に渡すと真
 *   → `saveDocument(uri, editBuffer)`(`invoke` はモックで成功)→ `save_document` が同じ uri と
 *   原文で 1 回呼ばれ、印が消える(dirty は偽のまま・編集中のまま)。Viewer では帯が消える
 * - 対照(契約3 の不変): 印も dirty も無い編集中では偽(保存の command は呼ばれない)・
 *   閲覧中も偽。dirty で印があるとき・dirty で印が無いときは従来どおり真
 * - 失敗(契約1): `invoke` が reject → `saveDocument` が reject を伝え、印は残る
 *
 * ## 想定される赤(実装前)
 * - `shouldSaveOnCommand` が export されていない → それを呼ぶ件がすべて「not a function」で赤
 *   (`pnpm check` でも import の型エラー)。store の遷移そのもの(印が立つ・原文に戻すと
 *   dirty が偽・`saveDocument` 成功で印が消える)は追補g/h の実装で既に成り立つ
 *
 * ## スタブの設計(Viewer.external-removed.wiring.test.ts と同じ)
 * - $lib/ipc / @tauri-apps/plugin-opener: モジュールモック。`invoke` の既定応答は
 *   beforeEach で `mockReset` → `mockResolvedValue(null)` し直す
 * - @tauri-apps/plugin-dialog: `ask` をモック
 * - `alert` は `vi.stubGlobal`
 * - `$state` のオブジェクトは deep proxy なので同一性(`toBe`)では見ず、uri / content で見る
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));

import { ask } from '@tauri-apps/plugin-dialog';
import { invoke } from '$lib/ipc';
import { saveDocument } from '$lib/save-document';
import { shouldSaveOnCommand } from '$lib/document-edit';

const askMock = vi.mocked(ask);
const invokeMock = vi.mocked(invoke);
const alertMock = vi.fn((_message?: unknown) => {});

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const TXT_URI = 'file:///Users/a/notes/memo.txt';
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

/**
 * backlog 341 の状況を store だけで作る: dirty の編集中に削除が届いて印が立ち、
 * そのあと編集を原文に戻した(dirty が偽・印は真・編集中のまま)。
 */
function makeRemovedThenCleanInStore(): void {
	makeDirtyInStore();
	expect(windowState.applyFileRemoved(TXT_URI)).toBe('keep');
	expect(windowState.externalRemoved).toBe(true);
	windowState.updateBuffer(TXT_CONTENT);
	expect(windowState.dirty).toBe(false);
	expect(windowState.externalRemoved).toBe(true);
	expect(windowState.editMode).toBe('edit');
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

/** 編集面の中身を `content` にして input を飛ばす(原文に戻す)。 */
async function typeInto(pre: HTMLElement, content: string) {
	pre.textContent = content;
	await fireEvent.input(pre);
	await tick();
}

/** 保存 → markSaved → 再描画と await を連ねる処理を流しきる。 */
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

/** `+page.svelte` の `saveCurrentEdits` と同じ渡し方: store の値をそのまま純関数へ。 */
function decideFromStore(): boolean {
	return shouldSaveOnCommand({
		mode: windowState.editMode,
		dirty: windowState.dirty,
		externalRemoved: windowState.externalRemoved,
	});
}

const saveCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'save_document');

beforeEach(() => {
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
	askMock.mockReset();
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
// (c) store の筋道: 印が立って dirty でない → shouldSaveOnCommand が真 → saveDocument で書き直す
// ---------------------------------------------------------------------------

describe('AC-48-追i (c): WindowState — 印が立って dirty でない編集中は shouldSaveOnCommand が真', () => {
	it('dirty → 削除(印)→ 原文に戻す(dirty が偽・印は真)→ store の値を渡すと真', () => {
		makeRemovedThenCleanInStore();

		expect(decideFromStore()).toBe(true);
	});

	it('真のあと saveDocument(uri, editBuffer) → save_document が同じ uri と原文で 1 回呼ばれ、印が消える', async () => {
		makeRemovedThenCleanInStore();
		expect(decideFromStore()).toBe(true);
		const buffer = windowState.editBuffer;
		expect(buffer).toBe(TXT_CONTENT);

		await saveDocument(TXT_URI, buffer as string);

		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: TXT_CONTENT }]]);
		expect(windowState.externalRemoved).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.currentDocument?.content).toBe(TXT_CONTENT);
		expect(askMock).not.toHaveBeenCalled();
	});

	it('印が消えたあとは(dirty も無いので)もう一度渡すと偽(二重に書き戻さない)', async () => {
		makeRemovedThenCleanInStore();
		await saveDocument(TXT_URI, windowState.editBuffer as string);
		expect(windowState.externalRemoved).toBe(false);

		expect(decideFromStore()).toBe(false);
	});

	it('保存が失敗したら(invoke が reject)reject が伝わり、印は残る(契約(追補i)1)', async () => {
		makeRemovedThenCleanInStore();
		expect(decideFromStore()).toBe(true);
		invokeMock.mockRejectedValueOnce(new Error('disk full'));

		await expect(saveDocument(TXT_URI, windowState.editBuffer as string)).rejects.toThrow();

		expect(saveCalls()).toHaveLength(1);
		expect(windowState.externalRemoved).toBe(true);
		expect(windowState.dirty).toBe(false);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		// 失敗のあとも真のまま(もう一度 Command + S で書き直せる)。
		expect(decideFromStore()).toBe(true);
	});
});

describe('AC-48-追i (c) 対照: 印も dirty も無い編集中・閲覧中は偽(契約(追補i)3 の不変)', () => {
	it('編集中で未変更・印なし → 偽(同じ内容を書き戻して mtime を動かさない)', () => {
		windowState.setDocument(txtDoc());
		expect(windowState.beginEdit()).toBe(true);
		expect(windowState.dirty).toBe(false);
		expect(windowState.externalRemoved).toBe(false);
		expect(windowState.editMode).toBe('edit');

		expect(decideFromStore()).toBe(false);
		expect(saveCalls()).toEqual([]);
	});

	it('編集中で一度 dirty にして原文に戻した(印なし)→ 偽', () => {
		makeDirtyInStore();
		windowState.updateBuffer(TXT_CONTENT);
		expect(windowState.dirty).toBe(false);
		expect(windowState.externalRemoved).toBe(false);

		expect(decideFromStore()).toBe(false);
	});

	it('閲覧中(編集に入っていない)→ 偽', () => {
		windowState.setDocument(txtDoc());
		expect(windowState.editMode).toBe('view');
		expect(windowState.dirty).toBe(false);
		expect(windowState.externalRemoved).toBe(false);

		expect(decideFromStore()).toBe(false);
	});

	it('文書が無い(閲覧・何も開いていない)→ 偽', () => {
		expect(windowState.currentDocument).toBe(null);
		expect(windowState.editMode).toBe('view');

		expect(decideFromStore()).toBe(false);
	});

	it('編集中で dirty・印なし → 真(従来どおり)', () => {
		makeDirtyInStore();
		expect(windowState.externalRemoved).toBe(false);

		expect(decideFromStore()).toBe(true);
	});

	it('編集中で dirty・印あり → 真(追補g の帯の Save と同じ筋道)', () => {
		makeDirtyInStore();
		expect(windowState.applyFileRemoved(TXT_URI)).toBe('keep');
		expect(windowState.dirty).toBe(true);
		expect(windowState.externalRemoved).toBe(true);

		expect(decideFromStore()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// (c) Viewer: Command + S と同じ経路の成功で帯が消える(契約(追補i)1)
// ---------------------------------------------------------------------------

describe('AC-48-追i (c): Viewer — 原文に戻した状態で Command + S と同じ経路を通すと帯が消える', () => {
	it('dirty → 削除 → 原文に戻す → 帯あり → 真 → saveDocument 成功 → 帯が消え、編集面は残る', async () => {
		const { container, pre } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();
		await typeInto(pre, TXT_CONTENT);
		expect(windowState.dirty).toBe(false);
		expect(windowState.externalRemoved).toBe(true);
		expect(screen.getByTestId('external-removed-banner')).toBeTruthy();

		expect(decideFromStore()).toBe(true);
		await saveDocument(TXT_URI, windowState.editBuffer as string);
		await settle();

		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: TXT_CONTENT }]]);
		expect(windowState.externalRemoved).toBe(false);
		expect(screen.queryByTestId('external-removed-banner')).toBeNull();
		expect(screen.queryByRole('alert')).toBeNull();
		expect(getPre(container).getAttribute('contenteditable')).toBe('true');
		expect(windowState.editMode).toBe('edit');
		expect(askMock).not.toHaveBeenCalled();
	});

	it('保存が失敗したら帯は残る(印が残る)', async () => {
		const { pre } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();
		await typeInto(pre, TXT_CONTENT);
		expect(decideFromStore()).toBe(true);
		invokeMock.mockRejectedValueOnce(new Error('disk full'));

		await expect(saveDocument(TXT_URI, windowState.editBuffer as string)).rejects.toThrow();
		await settle();

		expect(windowState.externalRemoved).toBe(true);
		expect(screen.getByTestId('external-removed-banner')).toBeTruthy();
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
	});
});
