/**
 * 要件#48 追補h(2026-10-12・backlog 337〜339)の受け入れテスト AC-48-追h (a)(b)(d)(e)(f)=
 * 削除の帯の端の振る舞い・バイナリの削除の固定・編集と同じ中身の外部変更。
 * (c)= `decideFileChanged` の純関数は `src/lib/document-edit.same-content.acceptance.test.ts`。
 *
 * runes を含む `stores/window-state.svelte.ts` は component プロジェクト(*.wiring.test.ts)
 * でしかコンパイルできないため、状態遷移・帯・配線をここで判定する
 * (`Viewer.external-removed.wiring.test.ts`= 追補g と同じ家風。追補g の名前
 * `applyFileRemoved` / `externalRemoved` / testid `external-removed-banner` / `-save` / `-close`
 * をそのまま使う)。
 *
 * ## 判定するもの(契約(追補h)1〜5= req-48.md)
 * - (a) 契約1: 外部変更の帯が出ている dirty の文書に同じ uri の削除 → 印が立ち、
 *   `externalChange` が null(外部変更の帯が消え、削除の帯だけ)。文書・バッファ・モードは残る
 * - (b) 契約2: 印が立ったあと編集を原文に戻す(dirty が偽)→ 帯は残り(印は下ろさない)、
 *   文言 `This file was deleted outside the app.`(`Your edits have not been saved.` を含まない)・
 *   `Save` の title `Save the file again`・`Close` の title `Close the file`。
 *   もう一度編集して dirty → 追補g の文言と title に戻る。
 *   dirty でなくても Save は同じパスに書き直して印が消え、Close は閉じ、保存せずに編集を
 *   終えれば閉じる(追補g 契約3 はそのまま)
 * - (d) 契約3: 編集中で dirty の文書に、編集バッファと同じ中身の `file_changed` → `apply`・
 *   `externalChange` は null・dirty が偽・`editMode` は `'edit'` のまま・文書の content が届いた版。
 *   削除の印が立ったあと同じ中身で作り直されたとき → 印も外部変更の帯も無く dirty が偽。
 *   中身が違えば今までどおり `external-conflict`(不変)
 * - (e) 契約4: 画像(`.png`)を表示中にその uri の削除 → `'close'`・文書が閉じ・印は立たない
 * - (f) 配線(ソース走査): `window-state.svelte.ts` の `applyFileChanged` の本体が
 *   `decideFileChanged(` に `editBuffer` を渡す
 *
 * ## 値固定(契約(追補h)2)
 * - dirty でないとき: 文言 `This file was deleted outside the app.`・Save title `Save the file again`・
 *   Close title `Close the file`
 * - dirty のとき(追補g 契約2 のまま): `This file was deleted outside the app. Your edits have not
 *   been saved.`・`Save your edits to the file again`・`Close the file (your edits are discarded)`
 *
 * ## 想定される赤(実装前)
 * - (a) `applyFileRemoved` が `externalChange` を null にしない → `toBe(null)` が赤・
 *   Viewer では外部変更の帯が残る → `queryByTestId('external-change-banner')` の null 判定が赤
 * - (b) 文言と title が dirty を見ずに固定 → dirty でないときの文言・title の件が赤。
 *   「印は下ろさない」「もう一度編集して戻る」「Save / Close / 編集終了の振る舞い」は
 *   不変の固定で実装前から緑
 * - (d) `applyFileChanged` が `editBuffer` を渡さない → 同じ中身でも `external-conflict`=赤。
 *   「違えば external-conflict」は不変の固定で緑
 * - (e) バイナリの削除は今の実装で `'close'`= 要件側更新の固定で実装前から緑
 * - (f) `decideFileChanged(` の引数に `editBuffer` が無い → 赤
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
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));

import { ask } from '@tauri-apps/plugin-dialog';
import { invoke } from '$lib/ipc';

const askMock = vi.mocked(ask);
const invokeMock = vi.mocked(invoke);
const alertMock = vi.fn((_message?: unknown) => {});

// ---------------------------------------------------------------------------
// 値固定(契約(追補h)2・追補g 契約2)
// ---------------------------------------------------------------------------

/** dirty のとき(追補g 契約2 のまま)。 */
const REMOVED_MESSAGE_DIRTY = 'This file was deleted outside the app. Your edits have not been saved.';
const REMOVED_SAVE_TITLE_DIRTY = 'Save your edits to the file again';
const REMOVED_CLOSE_TITLE_DIRTY = 'Close the file (your edits are discarded)';

/** dirty でないとき(契約(追補h)2)。 */
const REMOVED_MESSAGE_CLEAN = 'This file was deleted outside the app.';
const REMOVED_MESSAGE_DIRTY_TAIL = 'Your edits have not been saved.';
const REMOVED_SAVE_TITLE_CLEAN = 'Save the file again';
const REMOVED_CLOSE_TITLE_CLEAN = 'Close the file';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const TXT_URI = 'file:///Users/a/notes/memo.txt';
const PNG_URI = 'file:///Users/a/pics/photo.png';
const TXT_CONTENT = 'first line\nsecond line\n';
const EDITED = TXT_CONTENT + 'my edit\n';
const OUTSIDE = 'rewritten outside\n';

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

/** 画像(.png)を windowState と Viewer の両方に載せてマウントする(Viewer.find の mountBinary と同形)。 */
function renderPng() {
	const doc: DocumentPayload = { uri: PNG_URI, content: '', modified: 1 };
	windowState.setDocument(doc);
	return render(Viewer, { props: baseProps(doc, '') });
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

/** 編集面の中身を `content` にして input を飛ばす(原文に戻す・もう一度編集する)。 */
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

const saveCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'save_document');

const bannerText = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';

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
// (a) 削除が届いたら外部変更の帯を畳む(契約(追補h)1)
// ---------------------------------------------------------------------------

describe('AC-48-追h (a): WindowState — 外部変更の帯が出ている dirty の文書の削除 → 印が立ち externalChange が null', () => {
	it('external-conflict のあとの applyFileRemoved → keep・externalRemoved=true・externalChange=null', () => {
		makeDirtyInStore();
		expect(windowState.applyFileChanged({ uri: TXT_URI, content: OUTSIDE, modified: 9 })).toBe(
			'external-conflict'
		);
		expect(windowState.externalChange).toEqual({ content: OUTSIDE, modified: 9 });

		const decision = windowState.applyFileRemoved(TXT_URI);

		expect(decision).toBe('keep');
		expect(windowState.externalRemoved).toBe(true);
		expect(windowState.externalChange).toBe(null);
	});

	it('畳んでも文書・バッファ・モード・dirty はそのまま(追補g 契約1 は不変)', () => {
		makeDirtyInStore();
		windowState.applyFileChanged({ uri: TXT_URI, content: OUTSIDE, modified: 9 });

		windowState.applyFileRemoved(TXT_URI);

		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.currentDocument?.content).toBe(TXT_CONTENT);
		expect(windowState.editBuffer).toBe(EDITED);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.dirty).toBe(true);
	});

	it('畳んだ外部版は Reload(acceptExternalChange)で戻らない(脇に置いた版はもう無い)', () => {
		makeDirtyInStore();
		windowState.applyFileChanged({ uri: TXT_URI, content: OUTSIDE, modified: 9 });
		windowState.applyFileRemoved(TXT_URI);

		windowState.acceptExternalChange();

		// externalChange が null なので何もしない: 文書は残り、編集も印もそのまま。
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.currentDocument?.content).toBe(TXT_CONTENT);
		expect(windowState.editBuffer).toBe(EDITED);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.externalRemoved).toBe(true);
	});
});

describe('AC-48-追h (a): Viewer — 外部変更の帯が出ているところへ削除 → 削除の帯だけが出る', () => {
	it('external-change-banner が出ている dirty の文書の削除 → external-change-banner が消え、external-removed-banner が出る', async () => {
		await renderDirty();
		windowState.applyFileChanged({ uri: TXT_URI, content: OUTSIDE, modified: 9 });
		await tick();
		expect(screen.getByTestId('external-change-banner')).toBeTruthy();
		expect(screen.queryByTestId('external-removed-banner')).toBeNull();

		windowState.applyFileRemoved(TXT_URI);
		await tick();

		expect(screen.queryByTestId('external-change-banner')).toBeNull();
		expect(screen.queryByTestId('external-overwrite')).toBeNull();
		expect(screen.queryByTestId('external-reload')).toBeNull();
		expect(screen.getByTestId('external-removed-banner')).toBeTruthy();
		expect(screen.getAllByRole('alert')).toHaveLength(1);
	});

	it('削除の帯に切り替わっても編集面(contenteditable)とバッファは残る', async () => {
		const { container } = await renderDirty();
		windowState.applyFileChanged({ uri: TXT_URI, content: OUTSIDE, modified: 9 });
		await tick();

		windowState.applyFileRemoved(TXT_URI);
		await tick();

		expect(getPre(container).getAttribute('contenteditable')).toBe('true');
		expect(windowState.editBuffer).toBe(EDITED);
	});
});

// ---------------------------------------------------------------------------
// (b) 削除の帯の文言は dirty に合わせる(契約(追補h)2)
// ---------------------------------------------------------------------------

describe('AC-48-追h (b): Viewer — 印が立ったあと編集を原文に戻す → 帯は残り、文言と title が dirty でない版になる', () => {
	it('原文に戻す → dirty が偽・印は下ろさない・帯は残る', async () => {
		const { pre } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();

		await typeInto(pre, TXT_CONTENT);

		expect(windowState.dirty).toBe(false);
		expect(windowState.externalRemoved).toBe(true);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.editMode).toBe('edit');
		const banner = screen.getByTestId('external-removed-banner');
		expect(banner.getAttribute('role')).toBe('alert');
		expect(banner.classList.contains('external-change')).toBe(true);
	});

	it('原文に戻す → 文言は "This file was deleted outside the app."(未保存の編集の一文を含まない)', async () => {
		const { pre } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();

		await typeInto(pre, TXT_CONTENT);

		const text = bannerText(screen.getByTestId('external-removed-banner'));
		expect(text).toContain(REMOVED_MESSAGE_CLEAN);
		expect(text).not.toContain(REMOVED_MESSAGE_DIRTY_TAIL);
	});

	it('原文に戻す → Save の title は "Save the file again"(文字は Save のまま)', async () => {
		const { pre } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();

		await typeInto(pre, TXT_CONTENT);

		const save = screen.getByTestId('external-removed-save');
		expect(save.tagName).toBe('BUTTON');
		expect(save.textContent?.trim()).toBe('Save');
		expect(save.getAttribute('title')).toBe(REMOVED_SAVE_TITLE_CLEAN);
	});

	it('原文に戻す → Close の title は "Close the file"(文字は Close のまま)', async () => {
		const { pre } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();

		await typeInto(pre, TXT_CONTENT);

		const close = screen.getByTestId('external-removed-close');
		expect(close.tagName).toBe('BUTTON');
		expect(close.textContent?.trim()).toBe('Close');
		expect(close.getAttribute('title')).toBe(REMOVED_CLOSE_TITLE_CLEAN);
	});

	it('原文に戻してからもう一度編集(dirty)→ 追補g の文言と title に戻る', async () => {
		const { pre } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();
		await typeInto(pre, TXT_CONTENT);
		expect(windowState.dirty).toBe(false);

		await typeInto(pre, EDITED);

		expect(windowState.dirty).toBe(true);
		expect(windowState.externalRemoved).toBe(true);
		expect(bannerText(screen.getByTestId('external-removed-banner'))).toContain(REMOVED_MESSAGE_DIRTY);
		expect(screen.getByTestId('external-removed-save').getAttribute('title')).toBe(
			REMOVED_SAVE_TITLE_DIRTY
		);
		expect(screen.getByTestId('external-removed-close').getAttribute('title')).toBe(
			REMOVED_CLOSE_TITLE_DIRTY
		);
	});

	it('dirty のまま(戻していない)なら追補g の文言と title(dirty の版が勝手に変わらない)', async () => {
		await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();

		expect(bannerText(screen.getByTestId('external-removed-banner'))).toContain(REMOVED_MESSAGE_DIRTY);
		expect(screen.getByTestId('external-removed-save').getAttribute('title')).toBe(
			REMOVED_SAVE_TITLE_DIRTY
		);
		expect(screen.getByTestId('external-removed-close').getAttribute('title')).toBe(
			REMOVED_CLOSE_TITLE_DIRTY
		);
	});
});

describe('AC-48-追h (b): dirty でなくなっても帯の Save / Close と編集終了の振る舞いは追補g のまま', () => {
	it('原文に戻してから Save → save_document が同じ uri と原文で呼ばれ、成功で印と帯が消える', async () => {
		const { pre } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();
		await typeInto(pre, TXT_CONTENT);

		await fireEvent.click(screen.getByTestId('external-removed-save'));
		await settle();

		expect(saveCalls()).toEqual([['save_document', { uri: TXT_URI, content: TXT_CONTENT }]]);
		expect(windowState.externalRemoved).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.currentDocument?.content).toBe(TXT_CONTENT);
		expect(screen.queryByTestId('external-removed-banner')).toBeNull();
		expect(askMock).not.toHaveBeenCalled();
	});

	it('原文に戻してから Close → 文書が閉じ、save_document は呼ばれない', async () => {
		const { pre } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();
		await typeInto(pre, TXT_CONTENT);

		await fireEvent.click(screen.getByTestId('external-removed-close'));
		await settle();

		expect(windowState.currentDocument).toBe(null);
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(windowState.externalRemoved).toBe(false);
		expect(saveCalls()).toEqual([]);
	});

	it('原文に戻してから Esc(dirty でないので関門は聞かない)→ 保存せずに編集を終える=文書が閉じる', async () => {
		const { pre } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();
		await typeInto(pre, TXT_CONTENT);
		expect(windowState.dirty).toBe(false);

		await fireEvent.keyDown(pre, { key: 'Escape' });
		await settle();

		expect(askMock).not.toHaveBeenCalled();
		expect(windowState.currentDocument).toBe(null);
		expect(windowState.externalRemoved).toBe(false);
		expect(saveCalls()).toEqual([]);
	});

	it('store: 原文に戻してから endEdit → 文書が閉じる(追補g 契約3 はそのまま)', () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);
		windowState.updateBuffer(TXT_CONTENT);
		expect(windowState.dirty).toBe(false);
		expect(windowState.externalRemoved).toBe(true);

		windowState.endEdit();

		expect(windowState.currentDocument).toBe(null);
		expect(windowState.externalRemoved).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// (d) 編集と同じ中身の外部変更は衝突にしない(契約(追補h)3)
// ---------------------------------------------------------------------------

describe('AC-48-追h (d): WindowState — 編集中で dirty の文書に、編集バッファと同じ中身の file_changed → apply', () => {
	it('同じ中身 → apply・externalChange は null・dirty が偽・editMode は edit のまま・content が届いた版', () => {
		makeDirtyInStore();

		const decision = windowState.applyFileChanged({ uri: TXT_URI, content: EDITED, modified: 9 });

		expect(decision).toBe('apply');
		expect(windowState.externalChange).toBe(null);
		expect(windowState.dirty).toBe(false);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.editBuffer).toBe(EDITED);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(windowState.currentDocument?.content).toBe(EDITED);
		expect(windowState.currentDocument?.modified).toBe(9);
	});

	it('削除の印が立ったあと同じ中身で作り直された → apply・印も外部変更の帯も無く dirty が偽・編集中のまま', () => {
		makeDirtyInStore();
		expect(windowState.applyFileRemoved(TXT_URI)).toBe('keep');
		expect(windowState.externalRemoved).toBe(true);

		const decision = windowState.applyFileChanged({ uri: TXT_URI, content: EDITED, modified: 9 });

		expect(decision).toBe('apply');
		expect(windowState.externalRemoved).toBe(false);
		expect(windowState.externalChange).toBe(null);
		expect(windowState.dirty).toBe(false);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.editBuffer).toBe(EDITED);
		expect(windowState.currentDocument?.content).toBe(EDITED);
	});

	it('外部変更の帯が出ているところへ、編集と同じ中身が届く → apply・帯が畳まれる', () => {
		makeDirtyInStore();
		expect(windowState.applyFileChanged({ uri: TXT_URI, content: OUTSIDE, modified: 9 })).toBe(
			'external-conflict'
		);

		const decision = windowState.applyFileChanged({ uri: TXT_URI, content: EDITED, modified: 10 });

		expect(decision).toBe('apply');
		expect(windowState.externalChange).toBe(null);
		expect(windowState.dirty).toBe(false);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.currentDocument?.content).toBe(EDITED);
	});

	it('中身が違えば今までどおり external-conflict(文書・バッファは動かず、外部版を脇に置く)', () => {
		makeDirtyInStore();

		const decision = windowState.applyFileChanged({ uri: TXT_URI, content: OUTSIDE, modified: 9 });

		expect(decision).toBe('external-conflict');
		expect(windowState.externalChange).toEqual({ content: OUTSIDE, modified: 9 });
		expect(windowState.currentDocument?.content).toBe(TXT_CONTENT);
		expect(windowState.editBuffer).toBe(EDITED);
		expect(windowState.dirty).toBe(true);
	});

	it('削除の印のあと中身が違う作り直し → 今までどおり external-conflict(追補g (d) は不変)', () => {
		makeDirtyInStore();
		windowState.applyFileRemoved(TXT_URI);

		const decision = windowState.applyFileChanged({ uri: TXT_URI, content: OUTSIDE, modified: 9 });

		expect(decision).toBe('external-conflict');
		expect(windowState.externalRemoved).toBe(false);
		expect(windowState.externalChange).toEqual({ content: OUTSIDE, modified: 9 });
		expect(windowState.dirty).toBe(true);
	});

	it('保存した内容のエコーは今までどおり ignore-echo(同じ中身の判定より先)', () => {
		makeDirtyInStore();
		windowState.markSaved(EDITED);
		windowState.updateBuffer(EDITED + 'more\n');
		expect(windowState.dirty).toBe(true);

		const decision = windowState.applyFileChanged({ uri: TXT_URI, content: EDITED, modified: 9 });

		expect(decision).toBe('ignore-echo');
		expect(windowState.externalChange).toBe(null);
		expect(windowState.editBuffer).toBe(EDITED + 'more\n');
		expect(windowState.dirty).toBe(true);
	});
});

describe('AC-48-追h (d): Viewer — 同じ中身の file_changed では帯が出ず、編集面は残る', () => {
	it('dirty の編集中に同じ中身が届く → external-change-banner は出ず、contenteditable と中身は残る', async () => {
		const { container } = await renderDirty();

		const decision = windowState.applyFileChanged({ uri: TXT_URI, content: EDITED, modified: 9 });
		await tick();

		expect(decision).toBe('apply');
		expect(screen.queryByTestId('external-change-banner')).toBeNull();
		expect(screen.queryByTestId('external-removed-banner')).toBeNull();
		expect(screen.queryByRole('alert')).toBeNull();
		const pre = getPre(container);
		expect(pre.getAttribute('contenteditable')).toBe('true');
		expect(pre.textContent).toBe(EDITED);
		expect(windowState.dirty).toBe(false);
		expect(windowState.editMode).toBe('edit');
	});

	it('削除の帯が出ているところへ同じ中身で作り直し → 帯は両方とも無く、dirty が偽', async () => {
		const { container } = await renderDirty();
		windowState.applyFileRemoved(TXT_URI);
		await tick();
		expect(screen.getByTestId('external-removed-banner')).toBeTruthy();

		const decision = windowState.applyFileChanged({ uri: TXT_URI, content: EDITED, modified: 9 });
		await tick();

		expect(decision).toBe('apply');
		expect(screen.queryByTestId('external-removed-banner')).toBeNull();
		expect(screen.queryByTestId('external-change-banner')).toBeNull();
		expect(windowState.externalRemoved).toBe(false);
		expect(windowState.externalChange).toBe(null);
		expect(windowState.dirty).toBe(false);
		expect(getPre(container).getAttribute('contenteditable')).toBe('true');
	});
});

// ---------------------------------------------------------------------------
// (e) バイナリ(画像)の削除は閉じる(契約(追補h)4・要件#22 ②)
// ---------------------------------------------------------------------------

describe('AC-48-追h (e): 画像(.png)を表示中にその uri の削除 → close・文書が閉じ・印は立たない', () => {
	it('Viewer に .png を載せて applyFileRemoved → close・currentDocument=null・externalRemoved=false・帯なし', async () => {
		renderPng();
		expect(windowState.currentDocument?.uri).toBe(PNG_URI);
		expect(windowState.externalRemoved).toBe(false);

		const decision = windowState.applyFileRemoved(PNG_URI);
		await tick();

		expect(decision).toBe('close');
		expect(windowState.currentDocument).toBe(null);
		expect(windowState.externalRemoved).toBe(false);
		expect(windowState.externalChange).toBe(null);
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(screen.queryByTestId('external-removed-banner')).toBeNull();
	});

	it('store: .png は編集に入れない(beginEdit=false・dirty になり得ない)ので削除は常に close', () => {
		windowState.setDocument({ uri: PNG_URI, content: '', modified: 1 });
		expect(windowState.beginEdit()).toBe(false);
		expect(windowState.dirty).toBe(false);

		const decision = windowState.applyFileRemoved(PNG_URI);

		expect(decision).toBe('close');
		expect(windowState.currentDocument).toBe(null);
		expect(windowState.externalRemoved).toBe(false);
	});

	it('.png を表示中に別の uri の削除 → ignore(画像は残る)', () => {
		renderPng();

		const decision = windowState.applyFileRemoved(TXT_URI);

		expect(decision).toBe('ignore');
		expect(windowState.currentDocument?.uri).toBe(PNG_URI);
		expect(windowState.externalRemoved).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// (f) 配線(ソース走査)
// ---------------------------------------------------------------------------

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

describe('AC-48-追h (f): 配線(ソース走査)— applyFileChanged が decideFileChanged に editBuffer を渡す', () => {
	it('window-state.svelte.ts の applyFileChanged の本体で decideFileChanged( の引数に editBuffer がある', () => {
		const src = stripJsComments(readFileSync(STORE_PATH, 'utf8'));
		const at = src.search(/\bapplyFileChanged\s*\(/);
		expect(at, 'applyFileChanged( in window-state.svelte.ts').toBeGreaterThanOrEqual(0);
		const body = braceBody(src, src.indexOf(')', at), 'applyFileChanged body');

		const call = body.search(/\bdecideFileChanged\s*\(/);
		expect(call, 'decideFileChanged( in applyFileChanged body').toBeGreaterThanOrEqual(0);
		const args = parenBody(body, body.indexOf('(', call), 'decideFileChanged(…)');

		expect(args).toMatch(/\beditBuffer\b/);
	});

	it('applyFileChanged の本体は判断を decideFileChanged( に委ね、自前で editBuffer === を比べない', () => {
		const src = stripJsComments(readFileSync(STORE_PATH, 'utf8'));
		const at = src.search(/\bapplyFileChanged\s*\(/);
		const body = braceBody(src, src.indexOf(')', at), 'applyFileChanged body');

		// 同じ中身の判定は純関数の仕事(契約(追補h)3「decideFileChanged の入力に足す」)。
		expect(body).not.toMatch(/editBuffer\s*[=!]==?\s*payload\.content/);
		expect(body).not.toMatch(/payload\.content\s*[=!]==?\s*(this\.)?editBuffer/);
	});
});
