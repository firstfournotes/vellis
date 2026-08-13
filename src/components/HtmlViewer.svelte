<script lang="ts">
	import { SANDBOX_ATTRIBUTE } from '$lib/html-viewer';

	let { srcdoc }: { srcdoc: string } = $props();
</script>

<!--
	要件#8: HTML はソースではなくレンダリング結果を見せる。スクリプトは二重に
	止まる — sandbox(allow-scripts なし)と、srcdoc がアプリから継承する CSP
	(script-src 'self')。allow-same-origin もないので不透明オリジンになる。
	リンクは踏んでも遷移しない静的スナップショット(docs/html-viewing.md 案B)。
-->
<iframe class="html-viewer" title="HTML プレビュー" sandbox={SANDBOX_ATTRIBUTE} {srcdoc}></iframe>

<style>
	.html-viewer {
		flex: 1;
		min-width: 0;
		height: 100%;
		border: none;
		background-color: var(--color-bg-primary);
	}
</style>
