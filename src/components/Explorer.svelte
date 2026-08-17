<script lang="ts">
	import { invoke } from '$lib/ipc';
	import { detectFileType } from '$lib/file-type';
	import { openForDisplay } from '$lib/open-document';
	import { DEFAULT_PANE_WIDTH } from '$lib/pane-resize';
	import { windowState, type Entry } from '../stores/window-state.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import ExplorerItem from './ExplorerItem.svelte';

	type RootPayload = {
		root_uri: string;
		entries: Entry[];
		document_retained: boolean;
	};

	let {
		root,
		entries,
		selectedUri,
		width = DEFAULT_PANE_WIDTH
	}: {
		root: string;
		entries: Entry[];
		selectedUri: string | undefined;
		/**
		 * ペイン幅(px・要件#9)。値の妥当性(下限200・ウインドウ幅50%の上限)は
		 * `$lib/pane-resize` が持ち、ここは受け取った幅を反映するだけ。
		 */
		width?: number;
	} = $props();

	function parentUri(uri: string): string | null {
		const trimmed = uri.replace(/\/+$/, '');
		const schemeIdx = trimmed.indexOf('://');
		if (schemeIdx === -1) return null;
		const pathStart = trimmed.indexOf('/', schemeIdx + 3);
		if (pathStart === -1) return null;
		const lastSlash = trimmed.lastIndexOf('/');
		if (lastSlash <= pathStart) return null;
		return trimmed.slice(0, lastSlash);
	}

	let parent = $derived(parentUri(root));

	async function goUp() {
		if (!parent) return;
		const res = await invoke<RootPayload>('set_root', { uri: parent });
		windowState.applyRoot(res.root_uri, res.entries, res.document_retained);
	}

	async function handleFileClick(e: MouseEvent, entry: Entry) {
		// 要件#2: バイナリは表示対象外。エラーにはせず、開かないだけにする。
		// 画像(要件#16)はここを通る — image は binary ではない。
		if (detectFileType(entry.uri) === 'binary') return;
		if (e.shiftKey) {
			// Open in a new window -- current window state is unaffected.
			await invoke('new_window', { path: entry.uri, root });
		} else {
			// Open in this window. Main drops the old DocumentSession (auto watch
			// cleanup). ラスタ画像だけは `open_document` を通らない(要件#16 ⑦)。
			windowState.setDocument(await openForDisplay(entry.uri));
		}
	}
</script>

<aside class="explorer" style="width: {width}px">
	<div class="explorer-header">
		<span class="explorer-title">Explorer</span>
		<button
			class="up-button"
			onclick={goUp}
			disabled={!parent}
			title="親フォルダへ移動"
			aria-label="親フォルダへ移動"
		>
			↑
		</button>
	</div>
	<nav class="explorer-list">
		{#each entries as entry (entry.uri)}
			<ExplorerItem
				{entry}
				depth={0}
				{selectedUri}
				onFileClick={handleFileClick}
			/>
		{/each}
	</nav>
</aside>

<!--
	コンテキストメニューはウインドウにつき1つ(要件#19)。position: fixed なので
	Explorer の overflow には切られず、ツリーの外にもはみ出して表示できる。
-->
<ContextMenu />

<style>
	/*
	 * 幅は `width` prop(既定 = DEFAULT_PANE_WIDTH)からインラインで与える(要件#9)。
	 * 以前ここにあった width / min-width / max-width の固定値は、判定を一箇所に
	 * まとめるため `$lib/pane-resize` の clamp に移した。ここでは伸縮だけ止める。
	 */
	.explorer {
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--color-border);
		background-color: var(--color-bg-secondary);
		overflow: hidden;
	}

	.explorer-header {
		padding: 6px 8px 6px 12px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-secondary);
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.up-button {
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		color: var(--color-text-secondary);
		cursor: pointer;
		font-size: 14px;
		line-height: 1;
		padding: 2px 8px;
	}

	.up-button:hover:not(:disabled) {
		background-color: var(--color-bg-hover);
		border-color: var(--color-border);
		color: var(--color-text-hover);
	}

	.up-button:disabled {
		cursor: default;
		opacity: 0.3;
	}

	.explorer-list {
		flex: 1;
		overflow-y: auto;
		padding: 4px 0;
	}
</style>
