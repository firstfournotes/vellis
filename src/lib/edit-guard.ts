/**
 * 編集を失う操作の前に置く関門(要件#48 契約④)。
 *
 * dirty(編集バッファ≠保存済み content)のまま閉窓・別ファイル・root 変更に
 * 進むと、保存していない編集が黙って消える。その手前で「保存 / 破棄 /
 * キャンセル」を聞くのがここ。
 *
 * `save-document.ts` から分けてあるのは、あちらが `document-edit.acceptance.test.ts`
 * の import 先で、`@tauri-apps/plugin-dialog` を巻き込みたくないため(IPC を
 * モックした純関数テストの経路にダイアログの実体を持ち込まない)。
 *
 * 3択を `ask`(2択)2枚で表しているのは依存を増やさないため(契約⑦)。
 * 1枚目で「進むか / やめるか」、進むと決めた後の2枚目で「保存するか / 捨てるか」
 * を聞く — macOS の Save / Don't Save / Cancel と選べる結果は同じで、順序だけが
 * 「やめる」を先に置いた形になる。見え方は人間ゲート(acceptance/acceptance.md)。
 */
import { ask } from '@tauri-apps/plugin-dialog';
import { saveDocument } from '$lib/save-document';
import { windowState } from '../stores/window-state.svelte';

export const UNSAVED_TITLE = '保存していない変更があります';

/** 1枚目 — 進んでよいか(いいえ=操作そのものを取りやめる)。 */
export const UNSAVED_PROCEED_MESSAGE =
	'編集中の変更がまだ保存されていません。このまま続けますか?';

/** 2枚目 — 進むと決めた後、保存してから進むか捨てて進むか。 */
export const UNSAVED_SAVE_MESSAGE = '続ける前に変更を保存しますか?';

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

/**
 * 保存していない変更の扱いを聞く。dirty でなければ何も聞かずに `discard`
 * (=失うものが無いのでそのまま進む)を返す。
 */
export async function askUnsavedChoice(dirty: boolean): Promise<UnsavedChoice> {
	if (!dirty) return 'discard';
	const proceed = await ask(UNSAVED_PROCEED_MESSAGE, {
		title: UNSAVED_TITLE,
		kind: 'warning',
		okLabel: '続ける',
		cancelLabel: 'キャンセル',
	});
	if (!proceed) return 'cancel';
	const save = await ask(UNSAVED_SAVE_MESSAGE, {
		title: UNSAVED_TITLE,
		kind: 'warning',
		okLabel: '保存する',
		cancelLabel: '破棄する',
	});
	return save ? 'save' : 'discard';
}

/**
 * 編集を失う操作の直前に呼ぶ。進んでよければ true。
 *
 * `save` を選ばれたら**保存が成功してから** true を返す — 保存に失敗したまま
 * 進むと、聞いた意味が無くなる(失敗したら操作ごと取りやめて編集を残す)。
 * `discard` は編集モードを畳んでから進む(次の文書へ dirty を持ち越さない)。
 */
export async function confirmDiscardEdits(): Promise<boolean> {
	const doc = windowState.currentDocument;
	const buffer = windowState.editBuffer;
	const choice = await askUnsavedChoice(windowState.dirty);
	if (choice === 'cancel') return false;
	if (choice === 'save') {
		if (!doc || buffer === null) return true;
		try {
			await saveDocument(doc.uri, buffer);
		} catch (err) {
			alert(`保存に失敗しました: ${err}`);
			return false;
		}
	}
	windowState.endEdit();
	return true;
}
