/**
 * 要件#48 の受け入れテスト(requirements.md #48)— WindowState 編集状態と
 * Viewer の contenteditable 配線(component プロジェクト)
 *
 * runes を含む `stores/window-state.svelte.ts` は svelte プラグインの効く
 * component プロジェクト(*.wiring.test.ts)でしかコンパイルできないため、
 * 契約③④⑥の**状態遷移の実体**はここで判定する(純関数 VM と保存経路は
 * src/lib/document-edit.acceptance.test.ts=unit 側)。
 *
 * ## 判定するもの(契約番号は requirements.md #48 の①〜⑨)
 * - **WindowState(契約③④⑥)**: beginEdit の可否(text は入れる・画像/ssh は
 *   入れない)・dirty 遷移(updateBuffer / markSaved)・endEdit・
 *   applyFileChanged の3分岐(ignore-echo / external-conflict / apply)・
 *   acceptExternalChange・clearDocument / applyRoot での編集状態リセット
 * - **Viewer 配線(契約②③⑥)**:
 *   - 閲覧中の `<pre class="vellis-plaintext">` は contenteditable ではない
 *   - `.markdown-body` のダブルクリックで編集モードへ(単クリック・キー入力
 *     では入らない=閲覧中の誤タッチで dirty にならない)
 *   - 編集中は contenteditable="true"・「Done」(data-testid="edit-done")あり
 *   - input で editBuffer が更新され dirty になる
 *   - Esc /「Done」で閲覧へ戻る
 *   - **追補c(2026-09-09 由谷決定)**: dirty のままの Esc /「Done」は
 *     `confirmDiscardEdits`(保存 / 破棄 / キャンセル)を通る — キャンセルなら
 *     編集中のまま・破棄なら即閲覧・保存なら `save_document` 成功後に閲覧。
 *     非 dirty は従来どおり確認なしで即閲覧(⌘E トグルとの非対称の解消)
 *   - markdown 種別の編集はソース編集=レンダリング HTML ではなく
 *     `document.content` を `<pre contenteditable>` に出す
 *   - 外部変更衝突時はバナー(data-testid="external-change-banner")と
 *     「上書き保存」(external-overwrite)/「読み直す」(external-reload)が出る
 *
 * ## 判定しないもの
 * - 保存の IPC 経路(unit 側 saveDocument)・Rust 書き込み(acceptance_req48.rs)
 * - Edit メニュー・⌘S・閉窓/別ファイル/root 変更時の確認ダイアログ・IME・
 *   衝突表示の見え方 → reviewer 照合+人間ゲート(acceptance/acceptance.md)
 *
 * ## スタブの設計(VideoViewer.wiring.test.ts の家風)
 * - $lib/ipc / @tauri-apps/plugin-opener: モジュールモック(Tauri 実体なし)
 * - @tauri-apps/plugin-dialog: `ask` をモック(追補c で Viewer が edit-guard を
 *   通るため)。edit-guard 自体はモックしない — 関門の実体(`confirmDiscardEdits`)
 *   を通し、`ask` の呼び出し回数・順序・返り値で3択を再現する
 *   (menu-open.acceptance.test.ts の家風)
 * - mermaid: 本テストの html に `.vellis-mermaid` は無く、dynamic import は
 *   発火しない(mermaid-mounter の設計)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { contentHash } from '$lib/document-edit';

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
import { UNSAVED_PROCEED_MESSAGE, UNSAVED_SAVE_MESSAGE } from '$lib/edit-guard';

const askMock = vi.mocked(ask);
const invokeMock = vi.mocked(invoke);

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const TXT_URI = 'file:///Users/a/notes/memo.txt';
const TXT_CONTENT = 'first line\nsecond line\n';
const MD_URI = 'file:///Users/a/notes/plan.md';
const MD_CONTENT = '# Plan\n\n- item\n';

function txtDoc(content: string = TXT_CONTENT): DocumentPayload {
	return { uri: TXT_URI, content, modified: 1 };
}

function mdDoc(): DocumentPayload {
	return { uri: MD_URI, content: MD_CONTENT, modified: 1 };
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

/** contenteditable が有効か(属性なし・"false" はどちらも「無効」)。 */
function isEditable(el: HTMLElement): boolean {
	return el.getAttribute('contenteditable') === 'true';
}

beforeEach(() => {
	// 前のテストの編集状態・文書を持ち越さない。実装前はメソッド不在でも
	// beforeEach では落とさない(赤は各テストのアサーションで出す)。
	(windowState as { endEdit?: () => void }).endEdit?.();
	windowState.clearDocument();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// WindowState — 編集状態の遷移(契約③④)
// ---------------------------------------------------------------------------

describe('WindowState — beginEdit の可否と dirty 遷移(契約③④)', () => {
	it('text 文書で beginEdit → true・editMode=edit・バッファ=content・dirty ではない', () => {
		windowState.setDocument(txtDoc());

		expect(windowState.beginEdit()).toBe(true);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.editBuffer).toBe(TXT_CONTENT);
		expect(windowState.dirty).toBe(false);
	});

	it('画像文書では beginEdit → false・view のまま', () => {
		windowState.setDocument({ uri: 'file:///Users/a/pics/p.png', content: '', modified: null });

		expect(windowState.beginEdit()).toBe(false);
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
	});

	it('ssh root の text 文書では beginEdit → false(SSH は読み取り専用のまま=契約①)', () => {
		windowState.setDocument({ uri: 'ssh://host/notes/memo.txt', content: 'x', modified: null });

		expect(windowState.beginEdit()).toBe(false);
		expect(windowState.editMode).toBe('view');
	});

	it('updateBuffer で dirty になり、保存済み content と同一へ戻せば dirty が消える', () => {
		windowState.setDocument(txtDoc());
		windowState.beginEdit();

		windowState.updateBuffer(TXT_CONTENT + 'more');
		expect(windowState.dirty).toBe(true);

		windowState.updateBuffer(TXT_CONTENT);
		expect(windowState.dirty).toBe(false);
	});

	it('endEdit で view へ戻り、バッファと外部変更が破棄される', () => {
		windowState.setDocument(txtDoc());
		windowState.beginEdit();
		windowState.updateBuffer('changed');

		windowState.endEdit();

		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(windowState.externalChange).toBe(null);
		expect(windowState.dirty).toBe(false);
	});

	it('markSaved で content と lastSavedHash が更新され dirty が消える・edit のまま(契約⑤⑥)', () => {
		windowState.setDocument(txtDoc());
		windowState.beginEdit();
		const edited = TXT_CONTENT + 'appended\n';
		windowState.updateBuffer(edited);

		windowState.markSaved(edited);

		expect(windowState.currentDocument?.content).toBe(edited);
		expect(windowState.dirty).toBe(false);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.lastSavedHash).toBe(contentHash(edited));
	});

	it('clearDocument は編集状態もリセットする(契約④=別ファイルへの持ち越しなし)', () => {
		windowState.setDocument(txtDoc());
		windowState.beginEdit();
		windowState.updateBuffer('changed');

		windowState.clearDocument();

		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(windowState.externalChange).toBe(null);
	});

	it('applyRoot も編集状態をリセットする(root 変更で編集を持ち越さない)', () => {
		windowState.setDocument(txtDoc());
		windowState.beginEdit();
		windowState.updateBuffer('changed');

		windowState.applyRoot('file:///Users/a/other-root', [], false);

		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
	});
});

describe('WindowState — applyFileChanged の3分岐(契約⑥)', () => {
	it('保存した content と同一の file_changed は ignore-echo(文書・編集状態が動かない)', () => {
		windowState.setDocument(txtDoc());
		windowState.beginEdit();
		const saved = TXT_CONTENT + 'saved\n';
		windowState.updateBuffer(saved);
		windowState.markSaved(saved);

		const decision = windowState.applyFileChanged({
			uri: TXT_URI,
			content: saved,
			modified: 2,
		});

		expect(decision).toBe('ignore-echo');
		expect(windowState.editMode).toBe('edit');
		expect(windowState.editBuffer).toBe(saved);
		expect(windowState.currentDocument?.content).toBe(saved);
		expect(windowState.externalChange).toBe(null);
	});

	it('編集中+dirty に外部変更 → external-conflict(currentDocument 不変・外部版を保持)', () => {
		windowState.setDocument(txtDoc());
		windowState.beginEdit();
		windowState.updateBuffer(TXT_CONTENT + 'my edit\n');

		const decision = windowState.applyFileChanged({
			uri: TXT_URI,
			content: 'rewritten outside\n',
			modified: 9,
		});

		expect(decision).toBe('external-conflict');
		expect(windowState.currentDocument?.content).toBe(TXT_CONTENT);
		expect(windowState.editBuffer).toBe(TXT_CONTENT + 'my edit\n');
		expect(windowState.externalChange).toEqual({ content: 'rewritten outside\n', modified: 9 });
	});

	it('閲覧中の外部変更 → apply(従来どおり setDocument 相当で更新)', () => {
		windowState.setDocument(txtDoc());

		const decision = windowState.applyFileChanged({
			uri: TXT_URI,
			content: 'rewritten outside\n',
			modified: 9,
		});

		expect(decision).toBe('apply');
		expect(windowState.currentDocument?.content).toBe('rewritten outside\n');
	});

	it('編集中でも未変更なら apply(外部版に追従してよい)', () => {
		windowState.setDocument(txtDoc());
		windowState.beginEdit();

		const decision = windowState.applyFileChanged({
			uri: TXT_URI,
			content: 'rewritten outside\n',
			modified: 9,
		});

		expect(decision).toBe('apply');
		expect(windowState.currentDocument?.content).toBe('rewritten outside\n');
	});

	it('acceptExternalChange は外部版を採用して編集を破棄する(「読み直す」の実体)', () => {
		windowState.setDocument(txtDoc());
		windowState.beginEdit();
		windowState.updateBuffer(TXT_CONTENT + 'my edit\n');
		windowState.applyFileChanged({ uri: TXT_URI, content: 'external\n', modified: 9 });

		windowState.acceptExternalChange();

		expect(windowState.currentDocument?.content).toBe('external\n');
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(windowState.externalChange).toBe(null);
	});
});

// ---------------------------------------------------------------------------
// Viewer — contenteditable 配線(契約②③⑥)
// ---------------------------------------------------------------------------

describe('Viewer — text 種別の編集モード配線(契約②③)', () => {
	it('閲覧中: pre.vellis-plaintext は contenteditable ではない', () => {
		const { container } = renderText();

		expect(isEditable(getPre(container))).toBe(false);
	});

	it('単クリックとキー入力では編集モードに入らず dirty にもならない(契約③)', async () => {
		const { container } = renderText();
		const body = container.querySelector('.markdown-body') as HTMLElement;

		await fireEvent.click(body);
		await fireEvent.keyDown(body, { key: 'a' });

		expect(windowState.editMode).toBe('view');
		expect(windowState.dirty).toBe(false);
		expect(isEditable(getPre(container))).toBe(false);
	});

	it('ダブルクリックで編集モード: contenteditable="true" と Done ボタンが現れる', async () => {
		const { container } = renderText();
		const body = container.querySelector('.markdown-body') as HTMLElement;

		await fireEvent.dblClick(body);
		await tick();

		expect(windowState.editMode).toBe('edit');
		expect(isEditable(getPre(container))).toBe(true);
		expect(screen.getByTestId('edit-done')).toBeTruthy();
	});

	it('input で editBuffer が更新され dirty になる(契約④)', async () => {
		const { container } = renderText();
		const body = container.querySelector('.markdown-body') as HTMLElement;
		await fireEvent.dblClick(body);
		await tick();

		const pre = getPre(container);
		pre.textContent = 'edited by hand\n';
		await fireEvent.input(pre);

		expect(windowState.editBuffer).toBe('edited by hand\n');
		expect(windowState.dirty).toBe(true);
	});

	it('Esc で閲覧へ戻る(契約③)', async () => {
		const { container } = renderText();
		const body = container.querySelector('.markdown-body') as HTMLElement;
		await fireEvent.dblClick(body);
		await tick();

		await fireEvent.keyDown(getPre(container), { key: 'Escape' });
		await tick();

		expect(windowState.editMode).toBe('view');
		expect(isEditable(getPre(container))).toBe(false);
	});

	it('「Done」ボタンで閲覧へ戻る(契約③)', async () => {
		const { container } = renderText();
		await fireEvent.dblClick(container.querySelector('.markdown-body') as HTMLElement);
		await tick();

		await fireEvent.click(screen.getByTestId('edit-done'));
		await tick();

		expect(windowState.editMode).toBe('view');
		expect(isEditable(getPre(container))).toBe(false);
	});
});

describe('Viewer — markdown のソース編集モード(契約②)', () => {
	it('編集中はレンダリング HTML ではなく document.content を contenteditable な pre に出す', async () => {
		const doc = mdDoc();
		windowState.setDocument(doc);
		const { container } = render(Viewer, {
			props: baseProps(doc, '<h1>Plan</h1>\n<ul><li>item</li></ul>'),
		});

		// 閲覧中はレンダリング結果が見えている(既存挙動=契約⑨)。
		expect(container.querySelector('h1')).toBeTruthy();
		expect(container.querySelector('pre.vellis-plaintext')).toBeNull();

		await fireEvent.dblClick(container.querySelector('.markdown-body') as HTMLElement);
		await tick();

		const pre = getPre(container);
		expect(isEditable(pre)).toBe(true);
		expect(pre.textContent).toBe(MD_CONTENT);
		expect(container.querySelector('h1')).toBeNull();
	});
});

describe('Viewer — 外部変更衝突の表示(契約⑥)', () => {
	it('external-conflict でバナーと「上書き保存」「読み直す」が現れる', async () => {
		const { container } = renderText();
		await fireEvent.dblClick(container.querySelector('.markdown-body') as HTMLElement);
		await tick();
		const pre = getPre(container);
		pre.textContent = TXT_CONTENT + 'my edit\n';
		await fireEvent.input(pre);

		const decision = windowState.applyFileChanged({
			uri: TXT_URI,
			content: 'rewritten outside\n',
			modified: 9,
		});
		await tick();

		expect(decision).toBe('external-conflict');
		expect(screen.getByTestId('external-change-banner')).toBeTruthy();
		expect(screen.getByTestId('external-overwrite')).toBeTruthy();
		expect(screen.getByTestId('external-reload')).toBeTruthy();
	});

	it('衝突していないとき(閲覧中)はバナーが出ない', () => {
		renderText();

		expect(screen.queryByTestId('external-change-banner')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Viewer — dirty な Esc / Done は確認関門を通る(契約③ 追補c)
// ---------------------------------------------------------------------------

describe('Viewer — dirty 時の Esc / Done は confirmDiscardEdits を通る(追補c)', () => {
	const EDITED = TXT_CONTENT + 'my edit\n';

	/** 編集モードへ入り、input で dirty にした状態の pre を返す。 */
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

	/**
	 * Esc / Done ハンドラは ask → (ask) → (保存) → endEdit と await を連ねるため、
	 * fireEvent の解決だけでは途中までしか進まない。マイクロタスクを数周流して
	 * 連鎖全体を確定させる。
	 */
	async function settle() {
		for (let i = 0; i < 8; i++) await Promise.resolve();
		await tick();
	}

	it('dirty で Esc → 1枚目キャンセルなら編集中のまま(バッファ・contenteditable 維持)', async () => {
		const { container, pre } = await renderDirty();
		askMock.mockResolvedValueOnce(false); // 1枚目: キャンセル

		await fireEvent.keyDown(pre, { key: 'Escape' });
		await settle();

		expect(askMock).toHaveBeenCalledTimes(1);
		expect(askMock.mock.calls[0][0]).toBe(UNSAVED_PROCEED_MESSAGE);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.editBuffer).toBe(EDITED);
		expect(isEditable(getPre(container))).toBe(true);
	});

	it('dirty で Done クリック → 1枚目キャンセルなら編集中のまま', async () => {
		const { container } = await renderDirty();
		askMock.mockResolvedValueOnce(false); // 1枚目: キャンセル

		await fireEvent.click(screen.getByTestId('edit-done'));
		await settle();

		expect(askMock).toHaveBeenCalledTimes(1);
		expect(windowState.editMode).toBe('edit');
		expect(windowState.editBuffer).toBe(EDITED);
		expect(isEditable(getPre(container))).toBe(true);
	});

	it('dirty で Esc → 続ける→破棄するなら閲覧へ戻りバッファ破棄・保存は走らない', async () => {
		const { container, pre } = await renderDirty();
		askMock.mockResolvedValueOnce(true); // 1枚目: 続ける
		askMock.mockResolvedValueOnce(false); // 2枚目: 破棄する

		await fireEvent.keyDown(pre, { key: 'Escape' });
		await settle();

		expect(askMock).toHaveBeenCalledTimes(2);
		expect(askMock.mock.calls[1][0]).toBe(UNSAVED_SAVE_MESSAGE);
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(isEditable(getPre(container))).toBe(false);
		expect(invokeMock).not.toHaveBeenCalledWith('save_document', expect.anything());
	});

	it('dirty で Done → 続ける→保存するなら save_document が呼ばれてから閲覧へ戻る', async () => {
		await renderDirty();
		askMock.mockResolvedValueOnce(true); // 1枚目: 続ける
		askMock.mockResolvedValueOnce(true); // 2枚目: 保存する

		await fireEvent.click(screen.getByTestId('edit-done'));
		await settle();

		expect(askMock).toHaveBeenCalledTimes(2);
		expect(invokeMock).toHaveBeenCalledWith('save_document', {
			uri: TXT_URI,
			content: EDITED,
		});
		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBe(null);
		expect(windowState.currentDocument?.content).toBe(EDITED);
		expect(windowState.dirty).toBe(false);
	});

	it('非 dirty なら Esc / Done とも確認なしで即閲覧へ(従来どおり)', async () => {
		const { container } = renderText();
		const body = container.querySelector('.markdown-body') as HTMLElement;

		// Esc(非 dirty)
		await fireEvent.dblClick(body);
		await tick();
		await fireEvent.keyDown(getPre(container), { key: 'Escape' });
		await settle();
		expect(windowState.editMode).toBe('view');

		// Done(非 dirty)
		await fireEvent.dblClick(body);
		await tick();
		await fireEvent.click(screen.getByTestId('edit-done'));
		await settle();
		expect(windowState.editMode).toBe('view');

		expect(askMock).not.toHaveBeenCalled();
	});
});
