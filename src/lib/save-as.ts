/**
 * File ▸ Save As…(別の名前で保存・Shift + Command + S)の一手(要件#89 契約1〜7)。
 *
 * menu-open.ts / root-switch-request.ts と同じ「依存を受け取る薄い一手」。保存のダイアログを出し、選んだ場所へ今の面の
 * 文字列を Rust の `save_document_as`(照合なし・一時ファイル+rename)で書き、書けたら窓を新しいファイルに切り替える
 * (決定①)。開いているフォルダの中なら今のタブで開き、外ならフォルダも切り替える(決定②)。開き方は +page.svelte が
 * `SaveAsDeps` で渡す(未保存の確認は挟まない=中身は書けている)。
 */
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '$lib/ipc';
import { windowState } from '../stores/window-state.svelte';
import type { FileEditorHandle } from '../editor/file-editor';

/** File ▸ Save As… のクリックが届くイベント名(menu.rs の MENU_SAVE_AS_EVENT と同じ綴り)。 */
export const MENU_SAVE_AS_EVENT = 'menu_save_as';
/** メニューの英語のラベル(menu.rs と同じ綴り・末尾は … の 1 文字)。 */
export const SAVE_AS_LABEL = 'Save As…';
/** Rust の command 名。 */
export const SAVE_AS_COMMAND = 'save_document_as';

/** Rust の `SaveAsResult` と同じ綴り(snake_case)。 */
export interface SaveAsResult {
	uri: string;
	within_root: boolean;
}

export type SaveAsOutcome = 'unavailable' | 'cancelled' | 'saved' | 'saved-outside-root' | 'overwrote-self' | 'failed';

export interface SaveAsDeps {
	/** 開いているフォルダの中に書けた: 今のタブでそのファイルを開く(Explorer の行を押したのと同じ経路。未保存の確認は挟まない)。 */
	openInRoot: (uri: string) => Promise<unknown>;
	/** フォルダの外に書けた: フォルダを新しいファイルのあるフォルダに切り替えて開く(set_root → 文書。未保存の確認は挟まない)。 */
	openOutsideRoot: (uri: string) => Promise<unknown>;
}

/** 'file:///a/b%20c.md' → '/a/b c.md'(percent-decode)。file:// でなければ null。 */
export function fileUriToPath(uri: string): string | null {
	if (!uri.startsWith('file://')) return null;
	const rest = uri.slice('file://'.length);
	if (!rest.startsWith('/')) return null;
	try {
		return decodeURIComponent(rest);
	} catch {
		// Explorer の URI はパスを符号化しない形(`100%.md` のような名前)もある。崩れた符号はそのまま
		return rest;
	}
}

/** 契約1: 面があり、読み取り専用でなく、file:// の文書のときだけ真。 */
export function canSaveAs(handle: FileEditorHandle | null | undefined): handle is FileEditorHandle {
	return !!handle && !handle.readOnly && fileUriToPath(handle.uri) !== null;
}

/**
 * File ▸ Save As…(Shift + Command + S)の一手。例外を外へ出さない(失敗は alert で知らせて 'failed')。
 *
 * 1. canSaveAs でなければ 'unavailable'(ダイアログも command も呼ばない)
 * 2. 保存のダイアログ(既定=今のファイルの場所と名前=決定⑧・種類で絞らない=決定②)。キャンセルなら 'cancelled'
 * 3. `save_document_as`(path・content=今の面の文字列をそのまま)。失敗は alert → 'failed'(面も窓も触らない)
 * 4. 選んだ場所が今のファイル自身なら(契約7)面と窓に保存済みを記帳 → 'overwrote-self'(開き直さない)
 * 5. それ以外は新しいファイルを開く(元の文書の面と窓の文書には触らない=元のファイルは変わっていない)
 */
export async function saveAs(handle: FileEditorHandle | null | undefined, deps: SaveAsDeps): Promise<SaveAsOutcome> {
	if (!canSaveAs(handle)) return 'unavailable';
	const currentPath = fileUriToPath(handle.uri)!;
	let path: string | null;
	try {
		path = await save({ defaultPath: currentPath });
	} catch (err) {
		alert(`Could not save: ${err}`);
		return 'failed';
	}
	if (typeof path !== 'string' || path === '') return 'cancelled';

	const content = handle.text();
	let result: SaveAsResult;
	try {
		result = await invoke<SaveAsResult>(SAVE_AS_COMMAND, { path, content });
	} catch (err) {
		alert(`Could not save: ${err}`);
		return 'failed';
	}

	if (path === currentPath) {
		handle.markSaved(content);
		windowState.markSaved(content);
		return 'overwrote-self';
	}
	if (result.within_root) {
		await deps.openInRoot(result.uri);
		return 'saved';
	}
	await deps.openOutsideRoot(result.uri);
	return 'saved-outside-root';
}
