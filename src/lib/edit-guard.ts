/**
 * 編集を失う操作の前に置く関門(要件#48 契約④)。
 *
 * dirty(面の文字列≠保存済みの版)のまま閉窓・別ファイル・root 変更に
 * 進むと、保存していない編集が黙って消える。その手前で「保存 / 破棄 /
 * キャンセル」を聞くのがここ。
 *
 * `save-document.ts` から分けてあるのは、あちらが `document-edit.acceptance.test.ts`
 * の import 先で、`@tauri-apps/plugin-dialog` を巻き込みたくないため(IPC を
 * モックした純関数テストの経路にダイアログの実体を持ち込まない)。
 *
 * 3択は `message` の `buttons: { yes, no, cancel }` で1枚に出す(追補o)— `ask` と
 * 同じ IPC なので依存も capability も増えない。macOS では yes(Save)が Return の
 * 既定になる。見え方は人間ゲート(acceptance/acceptance.md)。
 */
import { message } from '@tauri-apps/plugin-dialog';
import { saveFileEditor } from '../editor/file-editor';
import { windowState } from '../stores/window-state.svelte';

export const UNSAVED_TITLE = 'Unsaved Changes';

export const UNSAVED_SAVE_MESSAGE = 'Do you want to save your changes before continuing?';

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

/**
 * 保存していない変更の扱いを聞く。dirty でなければ何も聞かずに `discard`
 * (=失うものが無いのでそのまま進む)を返す。
 *
 * 戻り値は押されたボタンの文言。`Save` / `Don't Save` 以外(Cancel・Esc・想定外の
 * 値)はすべて `cancel` — 分からない答えを「進んでよい」とは取らない。
 *
 * ダイアログ(`message`)そのものが失敗したら `cancel` を返す(要件#48 追補k)—
 * 聞けなかったものを「進んでよい」とは取らず、編集を残して操作を取りやめる。
 * 失敗は `console.error` にだけ残す(出せない状況で別のダイアログを重ねない)。
 */
export async function askUnsavedChoice(dirty: boolean): Promise<UnsavedChoice> {
	if (!dirty) return 'discard';
	try {
		const answer = await message(UNSAVED_SAVE_MESSAGE, {
			title: UNSAVED_TITLE,
			kind: 'warning',
			buttons: { yes: 'Save', no: "Don't Save", cancel: 'Cancel' },
		});
		if (answer === 'Save') return 'save';
		if (answer === "Don't Save") return 'discard';
		return 'cancel';
	} catch (err) {
		console.error('Unsaved Changes dialog failed; keeping the edits', err);
		return 'cancel';
	}
}

/**
 * 編集を失う操作の直前に呼ぶ。進んでよければ true。
 *
 * `save` を選ばれたら**保存が成功してから** true を返す — 保存に失敗したまま
 * 進むと、聞いた意味が無くなる(失敗したら操作ごと取りやめて編集を残す)。
 * `discard` は面に触らずに進む(面は呼び手が文書ごと閉じる・切り替える・読み直す)。
 */
export async function confirmDiscardEdits(): Promise<boolean> {
	const face = windowState.fileEditor;
	const choice = await askUnsavedChoice(windowState.dirty);
	if (choice === 'cancel') return false;
	if (choice === 'save' && face) {
		// 要件#74 契約16: 面は saveFileEditor の経路(保存の照合つき)で保存する。保存できなかった
		// (照合の衝突・失敗。知らせは saveFileEditor が出す)なら操作ごと取りやめる。
		await saveFileEditor(face);
		if (face.dirty || windowState.externalRemoved) return false;
	}
	return true;
}
