/**
 * 編集面(Markdown の ProseMirror・コードの面・raw)の文字の上の右クリックの受け手(要件#74 第2段 2-6・契約8・契約17)。
 *
 * Option + 右クリックと読み取り専用の面は既定のまま(WebKit のメニュー/`+page` の本文のメニュー)。それ以外は既定の
 * メニューを止め、祖先(`+page` の `handleViewerContextMenu`)にも届かせず、ネイティブのメニューを出す。
 */
import { popupMenu } from '$lib/native-menu';
import { requestReloadFile } from '$lib/reload-file';
import { addBookmark, bookmarkSaveFailedMessage, isBookmarked, removeBookmark } from '$lib/bookmarks';
import { bookmarks } from '../stores/bookmarks.svelte';
import { activeFormat } from './active-format';
import { runFormatCommand, type FormatItemId } from './commands';
import type { FileEditorHandle, MarkdownEditorHandle } from './file-editor';
import { selectionTableCell } from './table-commands';
import {
	buildEditorContextMenu,
	EDITOR_MENU_PIN,
	EDITOR_MENU_RELOAD_FILE,
	EDITOR_MENU_UNPIN,
	type EditorSurface,
} from './editor-context-menu';

export interface EditorContextMenuTarget {
	surface: EditorSurface;
	/** 開いている文書の URI(Pin / Unpin の対象)。 */
	uri: string;
	/** 読み取り専用の面か(SSH の text など)。真なら何もしない。 */
	readOnly: boolean;
	/** 第3段 3-4: Markdown の面の handle(今の装飾・表の中か・Format の項目の実行に使う)。 */
	handle?: FileEditorHandle | MarkdownEditorHandle | null;
}

/** 項目を押したとき。Bookmark の失敗は本文のメニュー(ContextMenu.svelte)と同じく 1 回知らせる。 */
async function runEditorMenuAction(id: string, uri: string, handle: EditorContextMenuTarget['handle']): Promise<void> {
	// 第3段 3-4: Format ▸ / Table ▸ の項目はメニューバーの Format と同じ経路(変換中は確定後に 1 回)
	if (id.startsWith('format-')) {
		runFormatCommand(id as FormatItemId, handle ?? null);
		return;
	}
	if (id === EDITOR_MENU_RELOAD_FILE) {
		requestReloadFile(null);
		return;
	}
	if (id !== EDITOR_MENU_PIN && id !== EDITOR_MENU_UNPIN) return;
	try {
		if (id === EDITOR_MENU_PIN) await addBookmark(uri, 'file');
		else await removeBookmark(uri);
	} catch (err) {
		alert(bookmarkSaveFailedMessage(err));
	}
}

/** 面の `contextmenu` の受け手。メニューを出したら true。 */
export function handleEditorContextMenu(event: MouseEvent, target: EditorContextMenuTarget): boolean {
	if (event.altKey || target.readOnly) return false;
	event.preventDefault();
	event.stopPropagation();
	const md = target.surface === 'markdown' && target.handle?.kind === 'markdown' ? (target.handle as MarkdownEditorHandle) : null;
	const cell = event.target instanceof Element ? event.target.closest('td, th') : null;
	const entries = buildEditorContextMenu({
		surface: target.surface,
		inTable: md ? selectionTableCell(md.view.state) !== null : cell !== null,
		pinned: isBookmarked(bookmarks.list, target.uri),
		...(md ? { active: activeFormat(md.view.state) } : {}),
	});
	const uri = target.uri;
	const handle = target.handle;
	// 位置は渡さない(カーソルの位置に開く)。client 座標を渡すと Tauri は窓の座標(タイトルバーを含む)として扱い、
	// ポインタより上に開く(要件#74 実機ゲート (3))
	void popupMenu(entries, (id) => void runEditorMenuAction(id, uri, handle));
	return true;
}
