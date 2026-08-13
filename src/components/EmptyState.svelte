<script lang="ts">
	import { windowState } from '../stores/window-state.svelte';
</script>

<div class="empty-state">
	<div class="empty-content">
		<h1 class="app-name">Vellis</h1>
		{#if windowState.version}
			<p class="version">v{windowState.version}</p>
		{/if}
		<p class="hint">ファイルを選択してください</p>
	</div>
</div>

<style>
	.empty-state {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		background-color: #ffffff;
	}

	.empty-content {
		text-align: center;
		color: #656d76;
	}

	.app-name {
		font-size: 2rem;
		font-weight: 300;
		color: #1f2328;
		margin: 0 0 4px;
		letter-spacing: 0.05em;
	}

	.version {
		font-size: 0.85rem;
		color: #a0a8b0;
		margin: 0 0 16px;
	}

	.hint {
		font-size: 0.95rem;
		margin: 0;
	}
</style>
