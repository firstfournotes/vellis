<script lang="ts">
	import { untrack } from 'svelte';
	import { invoke } from '$lib/ipc';
	import { windowState, type Entry } from '../stores/window-state.svelte';
	import ExplorerItem from './ExplorerItem.svelte';

	let {
		entry,
		depth = 0,
		selectedUri,
		onFileClick
	}: {
		entry: Entry;
		depth?: number;
		selectedUri: string | undefined;
		onFileClick: (e: MouseEvent, entry: Entry) => void;
	} = $props();

	let loading = $state(false);
	let loadError = $state<string | null>(null);

	/**
	 * 子はウインドウ状態が持つ(要件#18)。`directory_changed` が届いたときに
	 * ツリーの外から差し替えられる必要があるため。ここは映すだけ。
	 */
	const children = $derived(windowState.childEntries[entry.uri] ?? null);

	const isDir = $derived(entry.kind === 'dir');
	/**
	 * 開閉の状態はウインドウ状態が持つ(要件#10)。ここは映すだけなので、
	 * reload スナップショットからの復元も「集合に URI が入る」だけで届く。
	 */
	const expanded = $derived(isDir && windowState.isExpanded(entry.uri));
	const active = $derived(entry.uri === selectedUri);
	const caret = $derived(isDir ? (expanded ? '▾' : '▸') : '');
	const icon = $derived(isDir ? '\u{1F4C1}' : '\u{1F4C4}');

	/**
	 * 子の読み込みと監視は「開いている」ことに紐付ける。クリックで開いたときも、
	 * 復元で最初から開いた状態で現れたときも同じ経路を通る。
	 *
	 * 開いている間だけ backend にディレクトリ監視を持たせる(要件#18)。折りたたみ・
	 * 親の折りたたみ・ノードの消滅はどれもこの effect の後始末に集まるので、
	 * 解除の呼び忘れが起きる場所が1つしかない。開くたびに読み直すのは、閉じている
	 * 間の変更は届かない(監視が無い)ため — 開いている間の更新は
	 * `directory_changed` の担当。
	 */
	$effect(() => {
		if (!expanded) return;
		const uri = entry.uri;
		void subscribeDir(uri);
		// 読むのは expanded だけにする。childEntries / loading を追跡すると
		// 自分の書き込みで再実行され続ける。
		untrack(() => {
			if (!loading) void loadChildren();
		});
		return () => {
			void invoke('unsubscribe_dir', { uri });
		};
	});

	/**
	 * 監視の登録は失敗しても展開自体は成立させる(自動反映が付かないだけ)。
	 * ssh リモートは対象外で、backend 側が no-op で受ける(要件#18 ⑤)。
	 */
	async function subscribeDir(uri: string) {
		try {
			await invoke('subscribe_dir', { uri });
		} catch (err) {
			console.warn(`subscribe_dir failed for ${uri}:`, err);
		}
	}

	async function loadChildren() {
		loading = true;
		loadError = null;
		try {
			windowState.setChildEntries(entry.uri, await invoke<Entry[]>('list_dir', { uri: entry.uri }));
		} catch (err) {
			loadError = String(err);
			windowState.setChildEntries(entry.uri, []);
		} finally {
			loading = false;
		}
	}

	function handleClick(e: MouseEvent) {
		if (isDir) {
			windowState.toggleExpanded(entry.uri);
		} else {
			onFileClick(e, entry);
		}
	}
</script>

<button
	class="explorer-item"
	class:active
	class:is-dir={isDir}
	style="padding-left: {8 + depth * 14}px"
	onclick={handleClick}
	title={entry.uri}
>
	<span class="caret">{caret}</span>
	<span class="icon">{icon}</span>
	<span class="name">{entry.name}</span>
</button>

{#if isDir && expanded}
	{#if loading && !children}
		<div class="tree-note" style="padding-left: {8 + (depth + 1) * 14}px">読み込み中...</div>
	{:else if loadError}
		<div class="tree-note error" style="padding-left: {8 + (depth + 1) * 14}px">{loadError}</div>
	{:else if children && children.length === 0}
		<div class="tree-note empty" style="padding-left: {8 + (depth + 1) * 14}px">(空)</div>
	{:else if children}
		{#each children as child (child.uri)}
			<ExplorerItem
				entry={child}
				depth={depth + 1}
				{selectedUri}
				{onFileClick}
			/>
		{/each}
	{/if}
{/if}

<style>
	.explorer-item {
		display: flex;
		align-items: center;
		gap: 4px;
		width: 100%;
		padding: 4px 12px 4px 8px;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.explorer-item:hover {
		background-color: var(--color-bg-tree-hover);
	}

	.explorer-item.active {
		background-color: var(--color-bg-tree-active);
		font-weight: 600;
	}

	.caret {
		display: inline-block;
		width: 10px;
		color: var(--color-text-secondary);
		font-size: 10px;
		flex-shrink: 0;
	}

	.icon {
		flex-shrink: 0;
		font-size: 14px;
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.is-dir .name {
		font-weight: 500;
	}

	.tree-note {
		font-size: 12px;
		color: var(--color-text-muted);
		padding-top: 2px;
		padding-bottom: 2px;
		font-style: italic;
	}

	.tree-note.error {
		color: var(--color-text-danger);
		font-style: normal;
	}
</style>
