<script lang="ts">
	/**
	 * ツリーのコンテキストメニュー(要件#19)。ネイティブ popup_menu は使わず
	 * 自前の div を絶対配置する(契約①)。開いているメニューは常に1つで、
	 * 状態は `stores/context-menu.svelte` が持つ。
	 */
	import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
	import { open as openDialog } from '@tauri-apps/plugin-dialog';
	import {
		clampMenuPosition,
		planContextAction,
		planOpenWith,
		type ContextMenuEntry,
		type ContextMenuItemId
	} from '$lib/context-menu';
	import { contextMenu } from '../stores/context-menu.svelte';

	let el = $state<HTMLDivElement | null>(null);
	/**
	 * 実寸を測ってからクランプするので、初回描画の1フレームだけ座標が決まらない。
	 * その間は非表示にしておき、ウインドウ端で一瞬はみ出して見えるのを避ける。
	 */
	let pos = $state<{ x: number; y: number } | null>(null);

	$effect(() => {
		if (!contextMenu.open) {
			pos = null;
			return;
		}
		const node = el;
		if (!node) return;
		const raw = { x: contextMenu.x, y: contextMenu.y };
		const rect = node.getBoundingClientRect();
		pos = clampMenuPosition(
			raw,
			{ width: rect.width, height: rect.height },
			{ width: window.innerWidth, height: window.innerHeight }
		);
	});

	/**
	 * 項目の実行。計画は純関数側が持ち、ここは呼ぶだけ。失敗しても警告に留めて
	 * アプリは壊さない(Finder / 既定アプリが応えないことはある)。
	 */
	async function activate(id: ContextMenuItemId) {
		const entry = contextMenu.entry;
		contextMenu.close();
		if (!entry) return;
		const action = planContextAction(id, entry);
		if (!action) return;
		try {
			if (action.command === 'reveal_item_in_dir') {
				await revealItemInDir(action.path);
			} else if (action.command === 'open_path') {
				await openPath(action.path);
			} else if (action.command === 'pick-app') {
				await openWithPickedApp(entry);
			} else {
				await navigator.clipboard.writeText(action.text);
			}
		} catch (err) {
			console.warn(`context menu action ${id} failed for ${entry.uri}:`, err);
		}
	}

	/**
	 * 「アプリを選択して開く…」(要件#21)。/Applications を既定に .app を選ばせ、
	 * 選ばれた .app で開く。macOS のダイアログは .app をファイルとして選べる。
	 * キャンセルは無変化(計画側が null を返す)。
	 */
	async function openWithPickedApp(entry: ContextMenuEntry) {
		const selected = await openDialog({
			multiple: false,
			directory: false,
			defaultPath: '/Applications',
			filters: [{ name: 'Applications', extensions: ['app'] }]
		});
		const plan = planOpenWith(entry, typeof selected === 'string' ? selected : null);
		if (!plan) return;
		await openPath(plan.path, plan.with);
	}

	function handleWindowPointerDown(e: PointerEvent) {
		if (!contextMenu.open) return;
		// メニュー内のクリックは項目の実行が受け持つ。外側なら閉じる。
		if (el && e.target instanceof Node && el.contains(e.target)) return;
		contextMenu.close();
	}

	function handleWindowKeyDown(e: KeyboardEvent) {
		if (contextMenu.open && e.key === 'Escape') contextMenu.close();
	}
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeyDown} />

{#if contextMenu.open}
	<!-- 自前メニューの上では webview 既定のメニューを出さない(ツリー上と同じ扱い)。 -->
	<div
		class="context-menu"
		bind:this={el}
		role="menu"
		tabindex="-1"
		style="left: {(pos?.x ?? contextMenu.x)}px; top: {(pos?.y ?? contextMenu.y)}px; visibility: {pos
			? 'visible'
			: 'hidden'}"
		oncontextmenu={(e) => e.preventDefault()}
	>
		{#each contextMenu.items as item (item.id)}
			<button
				class="context-menu-item"
				role="menuitem"
				disabled={!item.enabled}
				onclick={() => activate(item.id)}
			>
				{item.label}
			</button>
		{/each}
	</div>
{/if}

<style>
	.context-menu {
		position: fixed;
		z-index: 100;
		min-width: 160px;
		padding: 4px 0;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background-color: var(--color-bg-primary);
		box-shadow: 0 4px 16px var(--color-shadow);
	}

	.context-menu-item {
		display: block;
		width: 100%;
		padding: 5px 14px;
		border: none;
		background: none;
		color: var(--color-text-primary);
		font: inherit;
		font-size: 13px;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}

	.context-menu-item:hover:not(:disabled) {
		background-color: var(--color-bg-hover);
		color: var(--color-text-hover);
	}

	/* ssh リモートの「Finder で表示」「既定アプリで開く」= 出すが押せない(契約⑤)。 */
	.context-menu-item:disabled {
		color: var(--color-text-muted);
		cursor: default;
	}
</style>
