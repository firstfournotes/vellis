<script lang="ts">
	import { onMount } from 'svelte';
	import { windowState } from '../stores/window-state.svelte';
	import { getBuildInfo, type BuildInfo } from '../lib/buildInfo';

	let buildInfo = $state<BuildInfo | null>(null);

	onMount(async () => {
		try {
			buildInfo = await getBuildInfo();
		} catch {
			// Tauri 環境外 (テスト等) では noop
		}
	});

	const fileName = $derived(
		windowState.currentDocument
			? windowState.currentDocument.uri.split('/').pop() ?? ''
			: ''
	);

	const rootDisplay = $derived(
		windowState.root
			? windowState.root
					.replace(/^file:\/\//, '')
					.replace(/\/$/, '')
			: ''
	);

	const versionTitle = $derived(
		buildInfo
			? `Vellis ${buildInfo.version}\nBuild: ${buildInfo.buildNumber}\nBuilt: ${buildInfo.buildTime}`
			: ''
	);
</script>

<footer class="status-bar">
	<span class="status-root" title={windowState.root}>{rootDisplay}</span>
	<span class="status-spacer"></span>
	{#if fileName}
		<span class="status-file" title={windowState.currentDocument?.uri}>{fileName}</span>
	{/if}
	{#if buildInfo}
		<span class="status-version" title={versionTitle}>v{buildInfo.version}</span>
	{/if}
</footer>

<style>
	.status-bar {
		display: flex;
		align-items: center;
		height: 24px;
		padding: 0 10px;
		font-size: 12px;
		color: #ffffff;
		background-color: #24292e;
		flex-shrink: 0;
		gap: 8px;
		white-space: nowrap;
		overflow: hidden;
	}

	.status-root {
		overflow: hidden;
		text-overflow: ellipsis;
		opacity: 0.8;
	}

	.status-spacer {
		flex: 1;
	}

	.status-file {
		flex-shrink: 0;
		font-weight: 500;
	}

	.status-version {
		flex-shrink: 0;
		opacity: 0.55;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
</style>
