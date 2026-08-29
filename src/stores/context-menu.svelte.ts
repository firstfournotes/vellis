/**
 * ツリーのコンテキストメニューの開閉状態(要件#19)。
 *
 * ウインドウにつき開くメニューは1つ。状態をここに集めることで、別アイテムを
 * 右クリックしたときは「開き直し」がそのまま前のメニューを閉じることになる。
 * ツリーの空白部分から開くメニュー(要件#34)も同じ1つを使い回す。
 */
import {
	buildContextMenu,
	buildTreePaneMenu,
	type ContextMenuEntry,
	type ContextMenuItem
} from '../lib/context-menu';

class ContextMenuStore {
	/**
	 * 右クリックされたアイテム。ツリーの空白部分から開いたときは null —
	 * そのメニューはアイテムに依存しない項目しか持たない(要件#34)。
	 */
	entry = $state<ContextMenuEntry | null>(null);
	items = $state<ContextMenuItem[]>([]);
	/** 右クリック地点(クライアント座標)。ウインドウ端のクランプは表示側が行う。 */
	x = $state(0);
	y = $state(0);
	/**
	 * 開いているか。アイテムの有無とは独立に持つ — 空白部のメニューは
	 * `entry` が null のまま開く(要件#34③)。
	 */
	open = $state(false);

	openAt(entry: ContextMenuEntry, x: number, y: number): void {
		this.entry = entry;
		this.items = buildContextMenu(entry);
		this.showAt(x, y);
	}

	/** ツリーの空白部分の右クリック(要件#34③)。窓操作の項目だけを出す。 */
	openTreePaneAt(x: number, y: number): void {
		this.entry = null;
		this.items = buildTreePaneMenu();
		this.showAt(x, y);
	}

	close(): void {
		this.entry = null;
		this.items = [];
		this.open = false;
	}

	private showAt(x: number, y: number): void {
		this.x = x;
		this.y = y;
		this.open = true;
	}
}

export const contextMenu = new ContextMenuStore();
