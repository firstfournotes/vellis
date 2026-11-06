<script lang="ts">
	import { onMount } from 'svelte';
	import { windowState } from '../stores/window-state.svelte';
	import { getBuildInfo, type BuildInfo } from '../lib/buildInfo';
	import Icon from './Icon.svelte';

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
	<!-- root の前にフォルダのアイコン(モックのステータスバー)。 -->
	{#if rootDisplay}<span class="status-icon"><Icon name="folder" size={13} /></span>{/if}
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
	/*
	 * ステータスバー(モックの `.sb`= 24px・小さく薄い文字・窓の地の色)。本文の面との
	 * 境目は上端の 1px の線(ダークで境界が沈まないように=第1段の人間ゲートの指摘)。
	 */
	.status-bar {
		display: flex;
		align-items: center;
		box-sizing: border-box;
		height: 24px;
		padding: 0 12px 0 14px;
		font-size: var(--text-xs);
		color: var(--color-text-muted);
		background-color: var(--color-bg-base);
		border-top: 1px solid var(--color-border);
		flex-shrink: 0;
		gap: 14px;
		white-space: nowrap;
		overflow: hidden;
	}

	.status-icon {
		display: inline-flex;
		flex-shrink: 0;
		margin-right: -9px; /* アイコンと root の間はモックの 5px(バーの gap 14px から詰める) */
	}

	.status-root {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.status-spacer {
		flex: 1;
	}

	.status-file {
		flex-shrink: 0;
		font-weight: 500;
		color: var(--color-text-secondary);
	}

	.status-version {
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
	}
</style>
