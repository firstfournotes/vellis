<script lang="ts">
	import { windowState } from '../stores/window-state.svelte';
</script>

<div class="empty-state">
	<div class="empty-content">
		<h1 class="app-name">Vellis</h1>
		{#if windowState.version}
			<p class="version">v{windowState.version}</p>
		{/if}
		<p class="hint">Select a file</p>
	</div>
</div>

<style>
	/*
	 * 文書が無いときの面(要件#56 判断 (r)= 塗るだけ)。文字の組はモックの起動画面の
	 * 銘(太い 30px・字間を詰める)・版(小さく薄く)・案内(15px・secondary)にそろえる。
	 */
	.empty-state {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		background-color: var(--color-bg-surface);
	}

	.empty-content {
		text-align: center;
		color: var(--color-text-secondary);
	}

	.app-name {
		font-size: 30px;
		font-weight: 700;
		line-height: 1.1;
		color: var(--color-text-primary);
		margin: 0 0 6px;
		letter-spacing: -0.02em;
	}

	.version {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
		margin: 0 0 18px;
	}

	.hint {
		font-size: var(--text-lg);
		margin: 0;
	}
</style>
