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

<div class="update-banner" role="status">
	<span class="update-message">新しいバージョン v{version} が公開されています</span>
	<button class="update-download" onclick={download}>ダウンロード</button>
	<button class="update-close" onclick={onClose} aria-label="通知を閉じる" title="閉じる">✕</button>
</div>

<style>
	.update-banner {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-shrink: 0;
		padding: 6px 12px;
		font-size: 13px;
		color: var(--color-text-primary);
		background-color: var(--color-bg-secondary);
		border-bottom: 1px solid var(--color-border);
	}

	.update-message {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.update-download {
		background-color: var(--color-bg-primary);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text-primary);
		cursor: pointer;
		font: inherit;
		font-size: 13px;
		padding: 2px 12px;
	}

	.update-download:hover {
		background-color: var(--color-bg-hover);
	}

	.update-close {
		background: transparent;
		border: none;
		border-radius: 4px;
		color: var(--color-text-secondary);
		cursor: pointer;
		font: inherit;
		font-size: 13px;
		line-height: 1;
		padding: 4px 6px;
	}

	.update-close:hover {
		background-color: var(--color-bg-hover);
		color: var(--color-text-hover);
	}
</style>
