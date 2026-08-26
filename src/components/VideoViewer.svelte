<script lang="ts">
	import { openPath } from '@tauri-apps/plugin-opener';
	import { planOpenVideoExternally, videoViewMode } from '$lib/video-viewing';

	let {
		uri,
		src,
	}: {
		/** 表示中のファイルの絶対 URI(file: / ssh:)。再生可否の判定と表示名に使う。 */
		uri: string;
		/**
		 * `<video>` に載せる `vellis-asset:` URI(`renderForDisplay` が組み立て、
		 * 変更のたび版数が付く=要件#22 の機構)。プレースホルダのときは使わない。
		 */
		src: string;
	} = $props();

	// 再生の開始に失敗した(コーデック未対応・ファイル消滅・ssh 切断)。黒画面のまま
	// 何も起きないより、表示できないことを文字で返す(ImageViewer の要件#16 ⑧と同じ整理)。
	let loadFailed = $state(false);

	let fileName = $derived(uri.slice(uri.lastIndexOf('/') + 1));
	let mode = $derived(videoViewMode(uri));
	/** 「既定アプリで開く」を出せるか。ssh は null =出さない(要件#19 の前例)。 */
	let externalPlan = $derived(planOpenVideoExternally(uri));

	// 読み込み直しが起きるたびに失敗状態を落とす。ディスク上のファイルが直れば
	// 版数付きの新しい src が降ってくるので、もう一度再生を試みる。
	$effect(() => {
		void src;
		loadFailed = false;
	});

	/**
	 * OS の既定アプリへ渡す(要件#19 / #21 と同じ opener 経路)。計画は純関数側が
	 * 持ち、ここは呼ぶだけ。失敗しても警告に留める — 既定アプリが応えないことはある。
	 */
	async function openExternally(): Promise<void> {
		if (!externalPlan) return;
		try {
			await openPath(externalPlan.path);
		} catch (err) {
			console.warn(`open_path failed for ${uri}:`, err);
		}
	}
</script>

<!--
	要件#28: 動画はアプリ内で再生する。デコードは WebKit に任せ、操作は
	ネイティブの `controls` をそのまま出す(独自の再生 UI は作らない)。自動再生は
	しない — 開いた瞬間に音が鳴らないこと自体が契約。マーク・部分選択コピーは
	動画に意味がないので置かない(ImageViewer / ModelViewer と同じ整理)。
-->
<article class="video-viewer">
	<header class="video-toolbar">
		<span class="video-name" title={uri}>{fileName}</span>
	</header>

	<div class="video-stage">
		{#if mode === 'inline' && !loadFailed}
			<!--
				src が変われば(別ファイル・ディスク上の変更による版数更新)プレーヤーごと
				作り直す。前のファイルの再生位置や再生中の状態を持ち越さないため。
			-->
			{#key src}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					class="video"
					{src}
					controls
					preload="metadata"
					onerror={() => (loadFailed = true)}
				></video>
			{/key}
		{:else}
			<div class="video-placeholder">
				<p class="video-message">
					{#if mode === 'remote'}
						リモート(ssh)の動画はアプリ内で再生できません({fileName})。
					{:else if loadFailed}
						この動画を再生できませんでした({fileName})。コーデックが未対応の可能性があります。
					{:else}
						この形式の動画はアプリ内で再生できません({fileName})。
					{/if}
				</p>
				{#if externalPlan}
					<button type="button" class="toolbar-button" onclick={openExternally}>
						既定アプリで開く
					</button>
				{/if}
			</div>
		{/if}
	</div>
</article>

<style>
	.video-viewer {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow: hidden;
		background-color: var(--color-bg-primary);
	}

	.video-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
		padding: 6px 12px;
		background-color: var(--color-bg-primary);
		border-bottom: 1px solid var(--color-border);
	}

	.toolbar-button {
		font-size: 12px;
		padding: 4px 10px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background-color: var(--color-bg-secondary);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.toolbar-button:hover {
		background-color: var(--color-bg-hover);
	}

	.video-name {
		font-size: 12px;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/*
	 * 再生面。背景はテーマの単色(要件#16 ⑤の画像と同じ考え)で、レターボックスの
	 * 帯もこの色になる。
	 */
	.video-stage {
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
		padding: 16px;
		background-color: var(--color-bg-primary);
	}

	/* 収まらない動画だけを縮める。小さい動画は原寸のまま(引き伸ばさない)。 */
	.video {
		margin: auto;
		max-width: 100%;
		max-height: 100%;
	}

	.video-placeholder {
		margin: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		text-align: center;
	}

	.video-message {
		margin: 0;
		font-size: 13px;
		color: var(--color-text-secondary);
	}
</style>
