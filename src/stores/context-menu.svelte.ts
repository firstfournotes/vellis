/**
 * ツリーのコンテキストメニューの開閉状態(要件#19)。
 *
 * ウインドウにつき開くメニューは1つ。状態をここに集めることで、別アイテムを
 * 右クリックしたときは「開き直し」がそのまま前のメニューを閉じることになる。
 * ツリーの空白部分から開くメニュー(要件#34)も、文書の本文から開くメニュー(要件#80
 * 契約 8)も同じ1つを使い回す — 本文のメニューを開けばツリーのメニューは閉じ、その逆も同じ。
 * Dashboard のタイルと行のメニュー(要件#83 契約 14)も同じ1つ(Explorer と Dashboard は
 * 同時に出ないので、窓に開くメニューは常に1つのまま)。
 *
 * Pin to Bookmarks / Unpin from Bookmarks(要件#83 契約 7)の出し分けは、開いた時点の窓の
 * Bookmark の一覧(`stores/bookmarks.svelte`)で決める。
 */
import {
	buildContextMenu,
	buildTreePaneMenu,
	buildViewerMenu,
	type ContextMenuEntry,
	type ContextMenuItem,
	type DashboardMenuTarget
} from '../lib/context-menu';
import { isBookmarked } from '../lib/bookmarks';
import { bookmarks } from './bookmarks.svelte';
import { windowState } from './window-state.svelte';

class ContextMenuStore {
	/**
	 * 右クリックされたアイテム。ツリーの空白部分・文書の本文から開いたときは null —
	 * そのメニューはアイテムに依存しない項目しか持たない(要件#34・#80)。
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
	/**
	 * 本文のメニュー(要件#80 契約 8)を開いたときの今の文書の URI。Pin / Unpin(要件#83 契約 7)の
	 * 対象。ほかのメニューでは null。
	 */
	viewerUri = $state<string | null>(null);
	/** Dashboard のメニュー(要件#83 契約 14)を開いた対象。ほかのメニューでは null。 */
	dashboardTarget = $state<DashboardMenuTarget | null>(null);

	/**
	 * ツリーの行の右クリック。`openDocUri` は今の窓で開いている文書の URI(要件#80 契約 9=
	 * その行のときだけ Reload File が有効)。省略・null は「開いていない」。`pinned`(要件#83
	 * 契約 7)を省くと窓の Bookmark の一覧から決める。
	 */
	openAt(
		entry: ContextMenuEntry,
		x: number,
		y: number,
		openDocUri?: string | null,
		pinned?: boolean
	): void {
		this.reset();
		this.entry = entry;
		this.items = buildContextMenu(entry, openDocUri, pinned ?? isBookmarked(bookmarks.list, entry.uri));
		this.showAt(x, y);
	}

	/** ツリーの空白部分の右クリック(要件#34③)。窓操作の項目だけを出す。 */
	openTreePaneAt(x: number, y: number): void {
		this.reset();
		this.items = buildTreePaneMenu();
		this.showAt(x, y);
	}

	/**
	 * 文書の本文の右クリック(要件#80 契約 8)。項目は今の文書の Reload File と Pin / Unpin
	 * (要件#83 契約 7)。`docUri` を省くと窓の今の文書。
	 */
	openViewerAt(x: number, y: number, docUri?: string | null): void {
		this.reset();
		const uri = docUri === undefined ? (windowState.currentDocument?.uri ?? null) : docUri;
		this.viewerUri = uri;
		this.items = buildViewerMenu(uri !== null && isBookmarked(bookmarks.list, uri));
		this.showAt(x, y);
	}

	/**
	 * Dashboard のタイル・行・Add Bookmark… のメニュー(要件#83 契約 14・7)。項目は Dashboard が
	 * 組み(`buildBookmarkTileMenu` ほか)、押した項目は `ContextMenu.svelte` の `onDashboardItem`
	 * へ対象と一緒に渡る。
	 */
	openDashboardAt(target: DashboardMenuTarget, items: ContextMenuItem[], x: number, y: number): void {
		this.reset();
		this.dashboardTarget = target;
		this.items = items;
		this.showAt(x, y);
	}

	close(): void {
		this.reset();
		this.items = [];
		this.open = false;
	}

	private reset(): void {
		this.entry = null;
		this.viewerUri = null;
		this.dashboardTarget = null;
	}

	private showAt(x: number, y: number): void {
		this.x = x;
		this.y = y;
		this.open = true;
	}
}

export const contextMenu = new ContextMenuStore();
