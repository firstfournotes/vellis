/**
 * Issue #856 — Save As… の `fileUriToPath` が URI を percent-decode する(アプリの file URI は符号化しない)。
 * `save-as.wiring.test.ts`(要件#89)と同じモックの作り。
 *
 * アプリの file URI は Rust の `format!("file://{}", path.display())`(`fs/uri.rs` の `with_path`)で作る**符号化しない生の文字列**。
 * `fileUriToPath` が `decodeURIComponent` を通すと、名前に字面どおりの `%XX` があるフォルダ(例 `50%20off`)が `/…/50 off/` に化け、
 * 保存のダイアログの最初の場所がずれ、自分自身を選んだときの判定(契約7)も外れて開き直してしまう。
 *
 * ## 固定する振る舞い(直った後)
 * - `fileUriToPath('file://' + path)` は `path` をそのまま返す(`%20` も `%` も空白も日本語も字面のまま)。file:// でなければ null は今までどおり
 * - `saveAs`: ダイアログの `defaultPath` は字面のままのパス。ダイアログがその同じパスを返したら 'overwrote-self'(開き直さない)
 *
 * ## 判断の記録(test-writer 2026-11-28)
 * - 要件#89 の既存テスト `save-as.wiring.test.ts` の 2 ケース(「fileUriToPath: percent-decode して絶対パス」・「自分自身の判定はパスで行う
 *   (URI の percent-encoding の違いに惑わされない)」)は、符号化した URI を前提にしていて本件の直しと矛盾する(直すと赤になる)。
 *   本件では書き換えず報告に挙げる(要件側の判断)
 * - Rust の `SaveAsResult.uri` も `with_path` の形(符号化しない)なので、`result.uri` をそのまま開く経路(契約4)は変えない
 *
 * ## 修正前に赤になる理由
 * - `fileUriToPath('file:///Users/a/50%20off/plan.md')` が `/Users/a/50 off/plan.md` を返す。`saveAs` の defaultPath もそれになり、
 *   ダイアログが `/Users/a/50%20off/plan.md` を返すと「別のファイル」と判定して openInRoot へ行く
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn(), ask: vi.fn(), message: vi.fn() }));

import { invoke } from '$lib/ipc';
import { save } from '@tauri-apps/plugin-dialog';
import { contentHash } from '$lib/document-edit';
import { windowState } from '../stores/window-state.svelte';
import type { FileEditorHandle } from '../editor/file-editor';
import { fileUriToPath, SAVE_AS_COMMAND, saveAs, type SaveAsDeps } from './save-as';

const invokeMock = vi.mocked(invoke);
const saveMock = vi.mocked(save);
const alertMock = vi.fn();

const CONTENT = '# Plan\n\nbody\n';

/** Rust の `with_path` が作る形(パスを符号化しない)。フォルダ名が字面どおり `50%20off`。 */
const PERCENT_PATH = '/Users/a/50%20off/plan.md';
const PERCENT_URI = `file://${PERCENT_PATH}`;
/** 空白と日本語をそのまま持つパス。 */
const SPACED_PATH = '/Users/a/my notes/メモ 1.md';
const SPACED_URI = `file://${SPACED_PATH}`;

function fakeHandle(uri: string): FileEditorHandle & { markSaved: ReturnType<typeof vi.fn> } {
	return {
		kind: 'text',
		uri,
		readOnly: false,
		dirty: true,
		conflict: false,
		notice: null,
		text: () => CONTENT,
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
});

describe('Issue #856: fileUriToPath はアプリの file URI(符号化しない)のパスを字面のまま返す', () => {
	test('字面どおりの %XX を持つフォルダ名を decode しない', () => {
		expect(fileUriToPath(PERCENT_URI)).toBe(PERCENT_PATH);
		expect(fileUriToPath('file:///Users/a/docs/report%2Fv2.md')).toBe('/Users/a/docs/report%2Fv2.md');
	});

	test('空白・日本語・単独の % はそのまま(今までどおり)', () => {
		expect(fileUriToPath(SPACED_URI)).toBe(SPACED_PATH);
		expect(fileUriToPath('file:///Users/a/100%.md')).toBe('/Users/a/100%.md');
		expect(fileUriToPath('file:///Users/a/notes/plan.md')).toBe('/Users/a/notes/plan.md');
	});

	test('file:// でなければ null(今までどおり)', () => {
		expect(fileUriToPath('ssh://host/a.md')).toBeNull();
		expect(fileUriToPath('https://example.com/a.md')).toBeNull();
		expect(fileUriToPath('file:relative.md')).toBeNull();
	});
});

describe('Issue #856: saveAs のダイアログの既定と自分自身の判定は字面のままのパスで行う', () => {
	test('%20 を名前に持つフォルダ: defaultPath は字面のまま。同じパスが返れば上書き(開き直さない)', async () => {
		windowState.setDocument({ uri: PERCENT_URI, content: 'base', modified: 1 });
		saveMock.mockResolvedValue(PERCENT_PATH);
		invokeMock.mockResolvedValue({ uri: PERCENT_URI, within_root: true });
		const h = fakeHandle(PERCENT_URI);
		const d = deps();

		expect(await saveAs(h, d)).toBe('overwrote-self');
		expect(saveMock).toHaveBeenCalledTimes(1);
		expect((saveMock.mock.calls[0]![0] as { defaultPath?: string }).defaultPath).toBe(PERCENT_PATH);
		expect(invokeMock).toHaveBeenCalledWith(SAVE_AS_COMMAND, { path: PERCENT_PATH, content: CONTENT });
		expect(h.markSaved).toHaveBeenCalledWith(CONTENT);
		expect(windowState.currentDocument?.content).toBe(CONTENT);
		expect(d.openInRoot, '自分自身なので開き直さない').not.toHaveBeenCalled();
		expect(d.openOutsideRoot).not.toHaveBeenCalled();
		expect(alertMock).not.toHaveBeenCalled();
	});

	test('%20 を名前に持つフォルダ: 別の名前を選べば今までどおり開き直す(result.uri はそのまま)', async () => {
		windowState.setDocument({ uri: PERCENT_URI, content: 'base', modified: 1 });
		saveMock.mockResolvedValue('/Users/a/50%20off/copy.md');
		invokeMock.mockResolvedValue({ uri: 'file:///Users/a/50%20off/copy.md', within_root: true });
		const h = fakeHandle(PERCENT_URI);
		const d = deps();

		expect(await saveAs(h, d)).toBe('saved');
		expect(d.openInRoot).toHaveBeenCalledWith('file:///Users/a/50%20off/copy.md');
		expect(h.markSaved).not.toHaveBeenCalled();
	});

	test('空白と日本語の名前: defaultPath は字面のまま。同じパスが返れば上書き', async () => {
		windowState.setDocument({ uri: SPACED_URI, content: 'base', modified: 1 });
		saveMock.mockResolvedValue(SPACED_PATH);
		invokeMock.mockResolvedValue({ uri: SPACED_URI, within_root: true });
		const h = fakeHandle(SPACED_URI);
		const d = deps();

		expect(await saveAs(h, d)).toBe('overwrote-self');
		expect((saveMock.mock.calls[0]![0] as { defaultPath?: string }).defaultPath).toBe(SPACED_PATH);
		expect(d.openInRoot).not.toHaveBeenCalled();
	});
});
