/**
 * 明示保存の一手(要件#48 契約⑤)。
 *
 * 保存は ⌘S / File > Save からしか走らない — 自動保存は無い。ここは経路を1本に
 * 束ねるだけの薄い層で、root 外拒否も保存前スナップショットも atomic write も
 * Rust 側の `save_document` コマンドの持ち場(契約①⑤)。
 *
 * 順序に意味がある: `markSaved` は **invoke が成功してから** 呼ぶ。先に呼ぶと、
 * 書き込みに失敗しているのに dirty が消え「保存できたつもり」の表示になる。
 * 失敗は reject のまま呼び出し側へ伝え、編集バッファは dirty のまま残す。
 */
import { invoke } from '$lib/ipc';
import { windowState } from '../stores/window-state.svelte';

/**
 * File > Save(⌘S)のクリックがフロントへ届くイベント名(契約⑤)。
 *
 * `menu.rs` の `MENU_SAVE_EVENT` と綴りを合わせること。メニューは「保存したい」と
 * 言うだけで、何を保存するか(編集中かどうか・バッファの中身)を知っているのは
 * 窓の側 — Open… / Print… / ズームと同じ分担。
 */
export const MENU_SAVE_EVENT = 'menu_save';

/**
 * 編集バッファを原本へ書き戻す。成功したときだけ保存済みとして記帳する。
 *
 * 記帳(`markSaved`)は dirty の解消と `lastSavedHash` の更新を兼ねる。後者が
 * あることで、この保存が起こす `file_changed` を自己書き込みのエコーとして
 * 捨てられる(契約⑥)= 編集中の DOM が再レンダーで飛ばない。
 */
export async function saveDocument(uri: string, content: string): Promise<void> {
	await invoke<void>('save_document', { uri, content });
	windowState.markSaved(content);
}
