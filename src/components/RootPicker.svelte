<script lang="ts">
	/**
	 * History picker screen shown on an argument-less launch (要件#4).
	 *
	 * Presentational only: the list and both callbacks come from +page.svelte
	 * (view model = $lib/root-picker). An empty history is not a dead end —
	 * the folder dialog button is always present.
	 */
	import type { RootPickerEntry } from '$lib/root-picker';

	let {
		entries,
		error,
		onSelect,
		onPickFolder
	}: {
		entries: RootPickerEntry[];
		error: string | null;
		onSelect: (uri: string) => void;
		onPickFolder: () => void;
	} = $props();
</script>

<div class="root-picker">
	<div class="picker-content">
		<h1 class="app-name">Vellis</h1>
		<p class="hint">開くフォルダを選んでください</p>

		{#if entries.length > 0}
			<ul class="history-list">
				{#each entries as entry (entry.uri)}
					<li>
						<button class="history-item" onclick={() => onSelect(entry.uri)}>
							<span class="history-label">{entry.label}</span>
							<span class="history-uri">{entry.uri}</span>
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="empty-history">最近開いたフォルダはありません</p>
		{/if}

		{#if error}
			<p class="error" role="alert">{error}</p>
		{/if}

		<button class="pick-folder" onclick={onPickFolder}>フォルダを選択…</button>
	</div>
</div>

<style>
	.root-picker {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 0;
		overflow-y: auto;
		background-color: var(--color-bg-primary);
	}

	.picker-content {
		width: 100%;
		max-width: 420px;
		padding: 32px 16px;
		text-align: center;
	}

	.app-name {
		font-size: 2rem;
		font-weight: 300;
		color: var(--color-text-primary);
		margin: 0 0 4px;
		letter-spacing: 0.05em;
	}

	.hint {
		font-size: 0.95rem;
		color: var(--color-text-secondary);
		margin: 0 0 20px;
	}

	.history-list {
		list-style: none;
		margin: 0 0 16px;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		overflow: hidden;
		text-align: left;
	}

	.history-list li + li {
		border-top: 1px solid var(--color-border);
	}

	.history-item {
		width: 100%;
		display: block;
		background: transparent;
		border: none;
		cursor: pointer;
		font: inherit;
		padding: 8px 12px;
		text-align: left;
	}

	.history-item:hover {
		background-color: var(--color-bg-hover);
	}

	.history-label {
		display: block;
		color: var(--color-text-primary);
	}

	.history-uri {
		display: block;
		font-size: 11px;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.empty-history {
		font-size: 0.9rem;
		color: var(--color-text-placeholder);
		margin: 0 0 16px;
	}

	.error {
		font-size: 0.85rem;
		color: var(--color-text-danger);
		margin: 0 0 12px;
	}

	.pick-folder {
		background-color: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text-primary);
		cursor: pointer;
		font: inherit;
		padding: 6px 16px;
	}

	.pick-folder:hover {
		background-color: var(--color-bg-hover);
	}
</style>
