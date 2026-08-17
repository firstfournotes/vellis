/**
 * ツリーのコンテキストメニューの開閉状態(要件#19)。
 *
 * ウインドウにつき開くメニューは1つ。状態をここに集めることで、別アイテムを
 * 右クリックしたときは「開き直し」がそのまま前のメニューを閉じることになる。
 */
import { buildContextMenu, type ContextMenuEntry, type ContextMenuItem } from '../lib/context-menu';

class ContextMenuStore {
	entry = $state<ContextMenuEntry | null>(null);
	items = $state<ContextMenuItem[]>([]);
	/** 右クリック地点(クライアント座標)。ウインドウ端のクランプは表示側が行う。 */
	x = $state(0);
	y = $state(0);

	get open(): boolean {
		return this.entry !== null;
	}

	openAt(entry: ContextMenuEntry, x: number, y: number): void {
		this.entry = entry;
		this.items = buildContextMenu(entry);
		this.x = x;
		this.y = y;
	}

	close(): void {
		this.entry = null;
		this.items = [];
	}
}

export const contextMenu = new ContextMenuStore();
