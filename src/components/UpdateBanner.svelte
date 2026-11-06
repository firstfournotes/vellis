<script lang="ts">
	/**
	 * 新バージョンの告知バナー(要件#14)。
	 *
	 * 非モーダル — ビューアの上に薄く1行載るだけで、閲覧も操作も止めない。
	 * 更新の適用はしない: 「ダウンロード」は Releases ページを既定ブラウザへ
	 * 渡すだけ(Viewer の外部リンクと同じ opener 経路)。「閉じる」は呼び出し
	 * 側の state を落とすだけで、何も保存しない = 次回起動でまた出る
	 * (`docs/update-notification.md` §6-Q4)。
	 *
	 * 表示専用。イベントの購読と開閉は +page.svelte が持つ(窓ごとに独立)。
	 */
	import { openUrl } from '@tauri-apps/plugin-opener';
	import Icon from './Icon.svelte';

	let {
		version,
		url,
		onClose
	}: {
		version: string;
		url: string;
		onClose: () => void;
	} = $props();

	function download() {
		void openUrl(url);
	}
</script>

<!--
	モック画面 7 の更新トースト(要件#56 第2段)。右下に浮かぶ 1 段(`--color-bg-raised` +
	`--shadow-2` + `--radius-md`)で、本文の操作は止めない(非モーダルのまま)。
-->
<div class="update-banner" role="status">
	<span class="update-message">A new version v{version} is available</span>
	<button class="update-download" onclick={download}
		><Icon name="download" size={14} />Download</button
	>
	<button class="update-close" onclick={onClose} aria-label="Dismiss" title="Close"
		><Icon name="x" size={14} /></button
	>
</div>

<style>
	/*
	 * 右下のトースト(モックの `.toast`)。並びは文言・Download・閉じるのまま(DOM の順は
	 * 変えない)で、grid で「文言 + 閉じる」の行と Download の行に置く。下端は StatusBar
	 * (24px)の上に浮かせる。重なりの 1 段(要件#56 契約 4)。
	 */
	.update-banner {
		position: fixed;
		right: 18px;
		bottom: 36px;
		z-index: 150;
		box-sizing: border-box;
		width: min(340px, calc(100vw - 36px));
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas:
			'message close'
			'download .';
		align-items: center;
		gap: 10px 8px;
		padding: 12px 10px 12px 16px;
		font-size: var(--text-md);
		color: var(--color-text-primary);
		background-color: var(--color-bg-raised);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-2);
	}

	.update-message {
		grid-area: message;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* 主ボタン(モックの `.btn.pri`)。 */
	.update-download {
		grid-area: download;
		justify-self: start;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 28px;
		padding: 0 12px;
		border: 1px solid transparent;
		border-radius: 6px;
		background-color: var(--color-accent);
		color: var(--color-on-accent);
		cursor: pointer;
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 500;
	}

	.update-download:hover {
		filter: brightness(1.1);
	}

	.update-close {
		grid-area: close;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: 5px;
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.update-close:hover {
		background-color: var(--color-bg-hover);
		color: var(--color-text-primary);
	}
</style>
