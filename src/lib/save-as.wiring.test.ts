/**
 * 要件#89 の受け入れテスト(docs/requirements/req-89.md)— Save As…(別の名前で保存)のフロントの一手
 * AC-89-1(契約1 の「編集できる文書だけで効く」)・AC-89-2(契約2・3)・AC-89-3(契約4)・AC-89-4(契約5)・AC-89-5(契約6・7)。unit プロジェクト。
 *
 * ## 確定契約(implementer はこれに従う=test-writer が固定・2026-11-26)
 *
 * ```ts
 * // --- src/lib/save-as.ts(新規。menu-open.ts / root-switch-request.ts と同じ「依存を受け取る薄い一手」)
 * /** File ▸ Save As… のクリックが届くイベント名(menu.rs の MENU_SAVE_AS_EVENT と同じ綴り)。 *\/
 * export const MENU_SAVE_AS_EVENT = 'menu_save_as';
 * /** メニューの英語のラベル(menu.rs と同じ綴り・末尾は … の 1 文字)。 *\/
 * export const SAVE_AS_LABEL = 'Save As…';
 * /** Rust の command 名。 *\/
 * export const SAVE_AS_COMMAND = 'save_document_as';
 * /** Rust の `SaveAsResult` と同じ綴り(snake_case)。 *\/
 * export interface SaveAsResult { uri: string; within_root: boolean }
 * export type SaveAsOutcome = 'unavailable' | 'cancelled' | 'saved' | 'saved-outside-root' | 'overwrote-self' | 'failed';
 * export interface SaveAsDeps {
 *   /** 開いているフォルダの中に書けた: 今のタブでそのファイルを開く(Explorer の行を押したのと同じ経路。未保存の確認は挟まない=中身は書けている)。 *\/
 *   openInRoot: (uri: string) => Promise<unknown>;
 *   /** フォルダの外に書けた: フォルダを新しいファイルのあるフォルダに切り替えて開く(set_root → 文書。未保存の確認は挟まない)。 *\/
 *   openOutsideRoot: (uri: string) => Promise<unknown>;
 * }
 * /** 契約1: 面があり、読み取り専用でなく、file:// の文書のときだけ真。 *\/
 * export function canSaveAs(handle: FileEditorHandle | null | undefined): boolean;
 * /** 'file:///a/b%20c.md' → '/a/b c.md'(percent-decode)。file:// でなければ null。 *\/
 * export function fileUriToPath(uri: string): string | null;
 * /**
 *  * File ▸ Save As…(Shift + Command + S)の一手。
 *  * 1. canSaveAs でなければ 'unavailable'(ダイアログも command も呼ばない)
 *  * 2. `save({ defaultPath: fileUriToPath(handle.uri) })`(@tauri-apps/plugin-dialog)。null なら 'cancelled'(何も呼ばない)
 *  * 3. `invoke(SAVE_AS_COMMAND, { path, content: handle.text() })`。失敗は `alert('Could not save: ' + err)` → 'failed'(面も窓も触らない)
 *  * 4. 選んだ path が今のファイル自身なら(契約7)書けた後 `handle.markSaved(content)`・`windowState.markSaved(content)` → 'overwrote-self'(開き直さない)
 *  * 5. それ以外は result.within_root で deps.openInRoot(result.uri) → 'saved' / deps.openOutsideRoot(result.uri) → 'saved-outside-root'。
 *  *    元の文書の面と windowState.currentDocument には触らない(markSaved を呼ばない=元のファイルは変わっていない)
 *  *\/
 * export async function saveAs(handle: FileEditorHandle, deps: SaveAsDeps): Promise<SaveAsOutcome>;
 * // --- src/routes/+page.svelte(reviewer の照合): listen(MENU_SAVE_AS_EVENT, () => saveAs(windowState.fileEditor, deps)) を MENU_SAVE_EVENT の隣に。
 * //   deps.openInRoot = Explorer の行を押したのと同じ open の経路(確認なし)・deps.openOutsideRoot = set_root(親フォルダ) → 同じ open
 * //   (Dashboard の planDashboardOpen → set_root → openForDisplay と同じ順)。Dashboard の間(rootPicker.open)は何もしない
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - 契約2 の「場所は自由に選べる」はダイアログの既定(filters を付けない)で表す。本テストは `save` が 1 回・`defaultPath` が今のファイルのパスである
 *   ことだけを固定し、title などの他の option は固定しない
 * - 契約7「自分自身を選んだら上書き」は同じ command(save_document_as=照合なし)で書き、面と窓に markSaved を記帳する。開き直しはしない
 *   (今の文書のまま・帯は markSaved で下りる)。save_document(照合つき)を呼ぶ案は、macOS が上書きを確かめた後なので選ばなかった
 * - 契約4 の「新しい文書は Unsaved でない・帯は出ていない」は、開き直しの経路(setDocument が別の URI で面を作り直す)の性質なので本テストは
 *   「元の面と currentDocument を saveAs が触らない」ことで表し、実機(AC-89-10)で確かめる
 * - 'saved' の後に元のファイルが Unsaved のまま残ることの扱い(窓は新しいファイルに切り替わるので見えない)は契約どおり触らない
 *
 * ## 修正前に赤になる理由
 * - `src/lib/save-as.ts` が無いので import で落ちる(全ケースが赤)
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn(), ask: vi.fn(), message: vi.fn() }));

import { invoke } from '$lib/ipc';
import { save } from '@tauri-apps/plugin-dialog';
import { contentHash } from '$lib/document-edit';
import { windowState } from '../stores/window-state.svelte';
import type { FileEditorHandle } from '../editor/file-editor';
import { canSaveAs, fileUriToPath, MENU_SAVE_AS_EVENT, SAVE_AS_COMMAND, SAVE_AS_LABEL, saveAs, type SaveAsDeps } from './save-as';

const invokeMock = vi.mocked(invoke);
const saveMock = vi.mocked(save);
const alertMock = vi.fn();

const URI = 'file:///Users/a/notes/plan.md';
const PATH = '/Users/a/notes/plan.md';
const CONTENT = '﻿# Plan\r\n\r\nSecond line\r\n';

function fakeHandle(over: Partial<FileEditorHandle> = {}): FileEditorHandle & { markSaved: ReturnType<typeof vi.fn> } {
	const text = over.text ?? (() => CONTENT);
	return {
		kind: 'text',
		uri: URI,
		readOnly: false,
		dirty: true,
		conflict: false,
		notice: null,
		text,
		expectedHash: () => contentHash('base'),
		markSaved: vi.fn(),
		applyFileChanged: () => 'apply',
		keepMyEdits: () => {},
		useFileOnDisk: () => {},
		showSaveConflict: () => {},
		reset: () => {},
		preparePrint: async () => {},
		baseText: () => 'base',
		conflictText: async () => null,
		...over,
	} as FileEditorHandle & { markSaved: ReturnType<typeof vi.fn> };
}

function deps(): SaveAsDeps & { openInRoot: ReturnType<typeof vi.fn>; openOutsideRoot: ReturnType<typeof vi.fn> } {
	return { openInRoot: vi.fn(async () => undefined), openOutsideRoot: vi.fn(async () => undefined) };
}

beforeEach(() => {
	invokeMock.mockReset();
	saveMock.mockReset();
	alertMock.mockReset();
	vi.stubGlobal('alert', alertMock);
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.externalRemoved = false;
	windowState.setDocument({ uri: URI, content: 'base', modified: 1 });
});

describe('AC-89-1: 定数と canSaveAs(契約1)', () => {
	test('イベント名・ラベル・command 名は固定(Rust 側と同じ綴り)', () => {
		expect(MENU_SAVE_AS_EVENT).toBe('menu_save_as');
		expect(SAVE_AS_LABEL).toBe('Save As…');
		expect(SAVE_AS_COMMAND).toBe('save_document_as');
	});

	test('編集できる文書(面があり読み取り専用でない file://)だけ真。面なし・読み取り専用・ssh は偽', () => {
		expect(canSaveAs(fakeHandle())).toBe(true);
		expect(canSaveAs(fakeHandle({ kind: 'markdown' }))).toBe(true);
		expect(canSaveAs(fakeHandle({ dirty: false })), 'dirty でなくても使える(別の名前で保存)').toBe(true);
		expect(canSaveAs(null)).toBe(false);
		expect(canSaveAs(undefined)).toBe(false);
		expect(canSaveAs(fakeHandle({ readOnly: true })), '読み取り専用(2 MiB 超の Markdown・ssh)').toBe(false);
		expect(canSaveAs(fakeHandle({ uri: 'ssh://host/a/b.md' }))).toBe(false);
	});

	test('fileUriToPath: percent-decode して絶対パス・file:// でなければ null', () => {
		expect(fileUriToPath(URI)).toBe(PATH);
		expect(fileUriToPath('file:///Users/a/my%20notes/plan%23x.md')).toBe('/Users/a/my notes/plan#x.md');
		expect(fileUriToPath('ssh://host/a.md')).toBeNull();
		expect(fileUriToPath('https://example.com/a.md')).toBeNull();
	});

	test('面が無い・読み取り専用なら saveAs は unavailable で、ダイアログも command も呼ばない', async () => {
		const d = deps();
		expect(await saveAs(fakeHandle({ readOnly: true }), d)).toBe('unavailable');
		expect(await saveAs(fakeHandle({ uri: 'ssh://host/a.md' }), d)).toBe('unavailable');
		expect(saveMock).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalled();
		expect(d.openInRoot).not.toHaveBeenCalled();
		expect(d.openOutsideRoot).not.toHaveBeenCalled();
	});
});

describe('AC-89-2: ダイアログの既定と書く中身(契約2・3)', () => {
	test('save ダイアログは 1 回・defaultPath=今のファイルのパス(同じフォルダ・同じ名前=決定⑧)', async () => {
		saveMock.mockResolvedValue(null);
		await saveAs(fakeHandle(), deps());
		expect(saveMock).toHaveBeenCalledTimes(1);
		const options = saveMock.mock.calls[0]![0] as { defaultPath?: string; filters?: unknown };
		expect(options.defaultPath).toBe(PATH);
		expect(options.filters, '種類で絞らない(場所も名前も自由)').toBeUndefined();
	});

	test('選んだ場所へ、今の面の文字列をそのまま(BOM・CRLF を保って)save_document_as に渡す。expectedHash は渡さない', async () => {
		saveMock.mockResolvedValue('/Users/a/notes/copy.md');
		invokeMock.mockResolvedValue({ uri: 'file:///Users/a/notes/copy.md', within_root: true });
		const outcome = await saveAs(fakeHandle(), deps());
		expect(outcome).toBe('saved');
		expect(invokeMock).toHaveBeenCalledTimes(1);
		const [cmd, args] = invokeMock.mock.calls[0]!;
		expect(cmd).toBe(SAVE_AS_COMMAND);
		expect(args).toEqual({ path: '/Users/a/notes/copy.md', content: CONTENT });
		expect(args).not.toHaveProperty('expectedHash');
		expect(args).not.toHaveProperty('expected_hash');
	});
});

describe('AC-89-3: 書けた後は窓が新しいファイルを開く(契約4・決定①②)', () => {
	test('開いているフォルダの中(within_root=true)→ openInRoot(新しい URI)。元の面と窓の文書には触らない', async () => {
		saveMock.mockResolvedValue('/Users/a/notes/sub/copy.md');
		invokeMock.mockResolvedValue({ uri: 'file:///Users/a/notes/sub/copy.md', within_root: true });
		const h = fakeHandle();
		const d = deps();
		let docAtOpen: string | null = null;
		d.openInRoot.mockImplementation(async () => {
			docAtOpen = windowState.currentDocument?.content ?? null;
		});
		expect(await saveAs(h, d)).toBe('saved');
		expect(d.openInRoot).toHaveBeenCalledTimes(1);
		expect(d.openInRoot).toHaveBeenCalledWith('file:///Users/a/notes/sub/copy.md');
		expect(d.openOutsideRoot).not.toHaveBeenCalled();
		expect(h.markSaved, '元のファイルは触っていないので元の面に保存済みを記帳しない').not.toHaveBeenCalled();
		expect(docAtOpen, '開き直しの時点で窓の文書は元のまま').toBe('base');
		expect(alertMock).not.toHaveBeenCalled();
	});

	test('開いているフォルダの外(within_root=false)→ openOutsideRoot(新しい URI)=フォルダも切り替える', async () => {
		saveMock.mockResolvedValue('/Users/a/elsewhere/copy.md');
		invokeMock.mockResolvedValue({ uri: 'file:///Users/a/elsewhere/copy.md', within_root: false });
		const h = fakeHandle();
		const d = deps();
		expect(await saveAs(h, d)).toBe('saved-outside-root');
		expect(d.openOutsideRoot).toHaveBeenCalledTimes(1);
		expect(d.openOutsideRoot).toHaveBeenCalledWith('file:///Users/a/elsewhere/copy.md');
		expect(d.openInRoot).not.toHaveBeenCalled();
		expect(h.markSaved).not.toHaveBeenCalled();
	});

	test('開く経路の URI は Rust の結果(result.uri)を使う(ダイアログの文字列から自前で組まない)', async () => {
		saveMock.mockResolvedValue('/Users/a/notes/My Notes/copy.md');
		invokeMock.mockResolvedValue({ uri: 'file:///Users/a/notes/My%20Notes/copy.md', within_root: true });
		const d = deps();
		await saveAs(fakeHandle(), d);
		expect(d.openInRoot).toHaveBeenCalledWith('file:///Users/a/notes/My%20Notes/copy.md');
	});
});

describe('AC-89-4: キャンセルと失敗(契約5)', () => {
	test('キャンセル(null)→ cancelled。command も開き直しも alert も無く、面は dirty のまま', async () => {
		saveMock.mockResolvedValue(null);
		const h = fakeHandle();
		const d = deps();
		expect(await saveAs(h, d)).toBe('cancelled');
		expect(invokeMock).not.toHaveBeenCalled();
		expect(d.openInRoot).not.toHaveBeenCalled();
		expect(d.openOutsideRoot).not.toHaveBeenCalled();
		expect(h.markSaved).not.toHaveBeenCalled();
		expect(alertMock).not.toHaveBeenCalled();
		expect(windowState.currentDocument?.content).toBe('base');
	});

	test('書けなかった(command が reject)→ alert で知らせ failed。窓の文書・面はそのまま・開き直さない・例外を外へ出さない', async () => {
		saveMock.mockResolvedValue('/Volumes/ReadOnly/copy.md');
		invokeMock.mockRejectedValue('Permission denied (os error 13)');
		const h = fakeHandle();
		const d = deps();
		await expect(saveAs(h, d)).resolves.toBe('failed');
		expect(alertMock).toHaveBeenCalledTimes(1);
		const message = String(alertMock.mock.calls[0]![0]);
		expect(message).toMatch(/^Could not save/);
		expect(message).toContain('Permission denied');
		expect(d.openInRoot).not.toHaveBeenCalled();
		expect(d.openOutsideRoot).not.toHaveBeenCalled();
		expect(h.markSaved).not.toHaveBeenCalled();
		expect(windowState.currentDocument?.content).toBe('base');
	});

	test('ダイアログ自体が失敗(reject)しても例外を外へ出さず、何も書かない', async () => {
		saveMock.mockRejectedValue(new Error('dialog unavailable'));
		const d = deps();
		const outcome = await saveAs(fakeHandle(), d);
		expect(['cancelled', 'failed']).toContain(outcome);
		expect(invokeMock).not.toHaveBeenCalled();
		expect(d.openInRoot).not.toHaveBeenCalled();
		expect(d.openOutsideRoot).not.toHaveBeenCalled();
	});
});

describe('AC-89-5: 帯が出ている間も使える・自分自身を選んだら上書き(契約6・7)', () => {
	test('重なりの帯(conflict)の間も、削除の帯(externalRemoved)の間も、同じ経路で書けて切り替わる', async () => {
		saveMock.mockResolvedValue('/Users/a/notes/rescue.md');
		invokeMock.mockResolvedValue({ uri: 'file:///Users/a/notes/rescue.md', within_root: true });
		windowState.externalRemoved = true;
		const h = fakeHandle({ conflict: true });
		const d = deps();
		expect(await saveAs(h, d)).toBe('saved');
		expect(invokeMock).toHaveBeenCalledWith(SAVE_AS_COMMAND, { path: '/Users/a/notes/rescue.md', content: CONTENT });
		expect(d.openInRoot).toHaveBeenCalledWith('file:///Users/a/notes/rescue.md');
	});

	test('選んだ場所が今のファイル自身 → 同じ command で上書き(照合なし)し、面と窓に保存済みを記帳。開き直さない', async () => {
		saveMock.mockResolvedValue(PATH);
		invokeMock.mockResolvedValue({ uri: URI, within_root: true });
		const h = fakeHandle({ conflict: true });
		const d = deps();
		expect(await saveAs(h, d)).toBe('overwrote-self');
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledWith(SAVE_AS_COMMAND, { path: PATH, content: CONTENT });
		expect(h.markSaved).toHaveBeenCalledTimes(1);
		expect(h.markSaved).toHaveBeenCalledWith(CONTENT);
		expect(windowState.currentDocument?.content, '窓の文書も保存済みの中身に').toBe(CONTENT);
		expect(d.openInRoot).not.toHaveBeenCalled();
		expect(d.openOutsideRoot).not.toHaveBeenCalled();
		expect(alertMock).not.toHaveBeenCalled();
	});

	test('自分自身の判定はパスで行う(URI の percent-encoding の違いに惑わされない)', async () => {
		saveMock.mockResolvedValue('/Users/a/my notes/plan.md');
		invokeMock.mockResolvedValue({ uri: 'file:///Users/a/my%20notes/plan.md', within_root: true });
		const h = fakeHandle({ uri: 'file:///Users/a/my%20notes/plan.md' });
		windowState.setDocument({ uri: 'file:///Users/a/my%20notes/plan.md', content: 'base', modified: 1 });
		const d = deps();
		expect(await saveAs(h, d)).toBe('overwrote-self');
		expect(h.markSaved).toHaveBeenCalledWith(CONTENT);
		expect(d.openInRoot).not.toHaveBeenCalled();
	});

	test('自分自身への上書きが失敗したら alert で、面は記帳しない', async () => {
		saveMock.mockResolvedValue(PATH);
		invokeMock.mockRejectedValue('No space left on device (os error 28)');
		const h = fakeHandle();
		expect(await saveAs(h, deps())).toBe('failed');
		expect(h.markSaved).not.toHaveBeenCalled();
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(windowState.currentDocument?.content).toBe('base');
	});
});
