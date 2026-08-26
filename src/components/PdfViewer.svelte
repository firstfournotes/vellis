<script lang="ts">
	import { openPath } from '@tauri-apps/plugin-opener';
	import { planOpenPdfExternally, pdfViewMode } from '$lib/pdf-viewing';

	let {
		uri,
		src,
	}: {
		/** 表示中のファイルの絶対 URI(file: / ssh:)。表示形態の判定と表示名に使う。 */
		uri: string;
		/**
		 * `<iframe>` に載せる `vellis-asset:` URI(`renderForDisplay` が組み立て、
		 * 変更のたび版数が付く=要件#22 の機構)。プレースホルダのときは使わない。
		 */
		src: string;
	} = $props();

	/**
	 * 先頭を読んでみた結果。`checking` = 確認中・`ready` = iframe に渡してよい・
	 * `error` = 読めない(消えた・壊れている)のでプレースホルダ。
	 *
	 * `<iframe>` は中身の PDF を描けなくても `onerror` を上げない(空白のまま黙る)ので、
	 * 表示に入る前に先頭バイトを自分で確かめる — 契約⑥のフォールバックを出す手掛かりが
	 * 他に無いため。`<video>` の `onerror` に当たる役目をこの先読みが果たす。
	 */
	let load = $state<'checking' | 'ready' | 'error'>('checking');

	let fileName = $derived(uri.slice(uri.lastIndexOf('/') + 1));
	let mode = $derived(pdfViewMode(uri));
	/** 「既定アプリで開く」を出せるか。ssh は null =出さない(要件#19 の前例)。 */
	let externalPlan = $derived(planOpenPdfExternally(uri));

	// src が変わるたび(別ファイル・ディスク上の変更による版数更新)に確かめ直す。
	// 直ったファイルは新しい src で降ってくるので、そのときまた読めるようになる。
	$effect(() => {
		const target = src;
		load = 'checking';
		if (mode !== 'inline') return;

		let cancelled = false;
		void readableAsPdf(target).then((ok) => {
			if (!cancelled) load = ok ? 'ready' : 'error';
		});
		return () => {
			cancelled = true;
		};
	});

	/** `%PDF-`。壊れた PDF・消えたファイルをここで見分ける。 */
	const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

	/**
	 * 先頭 1KiB のどこかに `%PDF-` があるか。PDF リーダーは先頭に余分なバイトが
	 * 挟まっていても 1KiB 以内なら受け付けるので、同じ幅で探す。
	 */
	function hasPdfMagic(head: Uint8Array): boolean {
		for (let i = 0; i + PDF_MAGIC.length <= head.length; i++) {
			if (PDF_MAGIC.every((byte, k) => head[i + k] === byte)) return true;
		}
		return false;
	}

	/**
	 * PDF として開けそうか。先頭 1KiB だけを取りに行く(要件#27 の Range/206 配信)ので、
	 * 何百 MB の PDF でも全量は読まない — 続きは `<iframe>` の中の PDF ビューアが
	 * 必要なぶんだけ取りに行く。
	 */
	async function readableAsPdf(assetSrc: string): Promise<boolean> {
		try {
			const response = await fetch(assetSrc, { headers: { Range: 'bytes=0-1023' } });
			if (!response.ok) return false;
			return hasPdfMagic(new Uint8Array(await response.arrayBuffer()));
		} catch (err) {
			console.warn(`pdf head check failed for ${uri}:`, err);
			return false;
		}
	}

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
	要件#29: PDF はアプリ内で表示する。描画は WKWebView のネイティブ PDF ビューアに
	任せ(実機プローブで確認済み=docs/pdf-viewing.md §7)、ライブラリは足さない。
	`sandbox` は付けない — 付けるとネイティブ PDF ビューアが立ち上がらないため。
	ページ送り・ズーム・テキスト選択は WebKit 側の UI がそのまま出る(独自の操作 UI は
	作らない=VideoViewer の `controls` と同じ整理)。マーク・部分選択コピーは置かない。
-->
<article class="pdf-viewer">
	<header class="pdf-toolbar">
		<span class="pdf-name" title={uri}>{fileName}</span>
	</header>

	<div class="pdf-stage">
		{#if mode === 'inline' && load === 'ready'}
			<!--
				src が変われば(別ファイル・ディスク上の変更による版数更新)ビューアごと
				作り直す。前のファイルのページ位置やズームを持ち越さないため。
			-->
			{#key src}
				<iframe class="pdf-frame" {src} title="PDF 表示({fileName})"></iframe>
			{/key}
		{:else if mode === 'inline' && load === 'checking'}
			<div class="pdf-placeholder">
				<p class="pdf-message">読み込み中…({fileName})</p>
			</div>
		{:else}
			<div class="pdf-placeholder">
				<p class="pdf-message">
					{#if mode === 'remote'}
						リモート(ssh)の PDF はアプリ内で表示できません({fileName})。
					{:else}
						この PDF を表示できませんでした({fileName})。ファイルが壊れているか、暗号化されている可能性があります。
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
	.pdf-viewer {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow: hidden;
		background-color: var(--color-bg-primary);
	}

	.pdf-toolbar {
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

	.pdf-name {
		font-size: 12px;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/*
	 * 表示面。PDF ビューアは面いっぱいに広げる(動画と違い、余白を置くと
	 * ページ送りの操作面が狭くなるだけなので padding は入れない)。
	 */
	.pdf-stage {
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
		background-color: var(--color-bg-primary);
	}

	.pdf-frame {
		flex: 1;
		min-width: 0;
		border: none;
	}

	.pdf-placeholder {
		margin: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		text-align: center;
	}

	.pdf-message {
		margin: 0;
		font-size: 13px;
		color: var(--color-text-secondary);
	}
</style>
