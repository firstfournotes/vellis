/**
 * 編集面の右クリックのネイティブのポップアップ(要件#74 第2段 2-6・契約8)。
 *
 * `EditorMenuEntry` の並びを Tauri の JS の menu API(`@tauri-apps/api/menu`)へ写して、窓の上に popup する。
 * Cut / Copy / Paste は OS の定義済みの項目なので、クリップボードは JS(`navigator.clipboard`)を通らない。
 * 依存・Tauri command・capability は増えない(`core:menu:default` は `core:default` の中)。
 */
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import type { EditorMenuEntry } from '../editor/editor-context-menu';

type NativeItem = MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu;

/**
 * ネイティブの項目の id(要件#74 実機ゲート・事後確認 (16))。Rust の on_menu_event は `format-` で始まる id を
 * メニューバーの Format として前面の窓へ送る(menu_format)ので、右クリックの Format の項目が同じ id だと JS の action と
 * 2 回走ってトグルが打ち消し合う。`format-` で始まる entry の id は `ctx-` を前に付けて別の id にする
 * (onAction に渡すのは entry の id のまま)。entry が `nativeId` を持てばそれを使う(Reload File=Issue #822)。
 */
function nativeId(id: string): string {
	return id.startsWith('format-') ? `ctx-${id}` : id;
}

async function toNative(entry: EditorMenuEntry, onAction: (id: string) => void): Promise<NativeItem> {
	switch (entry.kind) {
		case 'predefined':
			return PredefinedMenuItem.new({ item: entry.item });
		case 'separator':
			return PredefinedMenuItem.new({ item: 'Separator' });
		case 'item': {
			const action = () => onAction(entry.id);
			const base = { id: entry.nativeId ?? nativeId(entry.id), text: entry.label, action, ...(entry.accelerator ? { accelerator: entry.accelerator } : {}) };
			if (entry.checked !== undefined) return CheckMenuItem.new({ ...base, checked: entry.checked });
			return MenuItem.new(base);
		}
		case 'submenu': {
			const items: NativeItem[] = [];
			for (const child of entry.items) items.push(await toNative(child, onAction));
			return Submenu.new({ id: entry.id, text: entry.label, items });
		}
	}
}

/**
 * `entries` を Tauri の menu に写して popup する。項目を押すと `onAction(id)`。`at` があればその位置(ウィンドウの
 * 論理座標)、無ければカーソルの位置。作れない・出せないときは console.error に残して投げない。
 */
export async function popupMenu(
	entries: EditorMenuEntry[],
	onAction: (id: string) => void,
	at?: { x: number; y: number },
): Promise<void> {
	try {
		const items: NativeItem[] = [];
		for (const entry of entries) items.push(await toNative(entry, onAction));
		const menu = await Menu.new({ items });
		if (at) await menu.popup(new LogicalPosition(at.x, at.y));
		else await menu.popup();
	} catch (err) {
		console.error('Could not show the context menu:', err);
	}
}
