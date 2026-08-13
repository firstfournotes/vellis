<script lang="ts">
	import {
		DEFAULT_SIZE_MODE,
		DEFAULT_SVG_VIEW_MODE,
		canToggleSource,
		toggleSizeMode,
		toggleSvgViewMode,
		type ImageSizeMode,
		type SvgViewMode,
	} from '$lib/image-viewing';

	let {
		uri,
		src,
		source = '',
	}: {
		/** 表示中のファイルの絶対 URI(file: / ssh:)。SVG 判定と表示名に使う。 */
		uri: string;
		/** `<img>` に載せる `vellis-asset:` URI(`renderForDisplay` が組み立て済み)。 */
		src: string;
		/** SVG のソース。ラスタ画像では空文字(読んでいないため)。 */
		source?: string;
	} = $props();

	let sizeMode = $state<ImageSizeMode>(DEFAULT_SIZE_MODE);
	let svgViewMode = $state<SvgViewMode>(DEFAULT_SVG_VIEW_MODE);
	// 読み込み失敗(10MB 超・未対応形式・破損・ssh 切断)。壊れ画像アイコンの
	// 代わりにプレースホルダを出すための1状態(要件#16 ⑧)。
	let loadFailed = $state(false);

	let fileName = $derived(uri.slice(uri.lastIndexOf('/') + 1));
	let sourceAvailable = $derived(canToggleSource(uri));
	let showingSource = $derived(sourceAvailable && svgViewMode === 'source');

	// 別のファイルへ移ったら表示状態を既定へ戻す。前のファイルで実寸/ソースに
	// していたことを次のファイルへ持ち越さない(既定=フィット・画像表示)。
	$effect(() => {
		void uri;
		sizeMode = DEFAULT_SIZE_MODE;
		svgViewMode = DEFAULT_SVG_VIEW_MODE;
	});

	// 読み込み直しが起きるたびに失敗状態を落とす。SVG は監視が効く(要件#16 ⑦)ので、
	// 壊れていたファイルが直れば source の変化がここを通り、もう一度描きにいく。
	$effect(() => {
		void src;
		void source;
		loadFailed = false;
	});
</script>

<!--
	要件#16: 画像はレンダリング結果を見せる。SVG も `<img>` 経由に限定する —
	inline 展開や `<object>` を使わないこと自体がサンドボックス(secure static
	mode = スクリプト不実行・外部参照なし)で、要件#8 の不変条件と一貫する。
	マーク・部分選択コピー・マークダウンコピーは画像に意味がないので置かない
	(HtmlViewer と同じ整理)。
-->
<article class="image-viewer">
	<header class="image-toolbar">
		{#if !showingSource}
			<button
				type="button"
				class="toolbar-button"
				class:active={sizeMode === 'actual'}
				title={sizeMode === 'fit' ? '原寸で表示(スクロール)' : 'ウインドウに合わせて表示'}
				aria-pressed={sizeMode === 'actual'}
				onclick={() => (sizeMode = toggleSizeMode(sizeMode))}
			>
				{sizeMode === 'fit' ? '実寸表示' : 'フィット表示'}
			</button>
		{/if}
		{#if sourceAvailable}
			<button
				type="button"
				class="toolbar-button"
				class:active={showingSource}
				title={showingSource ? '画像として表示' : 'SVG のソースを表示'}
				aria-pressed={showingSource}
				onclick={() => (svgViewMode = toggleSvgViewMode(svgViewMode))}
			>
				{showingSource ? '画像表示' : 'ソース表示'}
			</button>
		{/if}
		<span class="image-name" title={uri}>{fileName}</span>
	</header>

	{#if showingSource}
		<div class="image-source"><pre>{source}</pre></div>
	{:else if loadFailed}
		<div class="image-stage">
			<p class="image-error">画像を表示できませんでした({fileName})。</p>
		</div>
	{:else}
		<div class="image-stage">
			<!--
				SVG が書き換わったら `<img>` を作り直す。URI は同じままなので、
				要素を置き換えないと画面が古い絵のまま残る(取得は毎回発火する —
				asset プロトコルは `Cache-Control: no-store` を返す)。ラスタ画像は
				監視しない=source が常に空なので、この key は動かない。
			-->
			{#key source}
				<img
					class="image"
					class:actual={sizeMode === 'actual'}
					{src}
					alt={fileName}
					onerror={() => (loadFailed = true)}
				/>
			{/key}
		</div>
	{/if}
</article>

<style>
	.image-viewer {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow: hidden;
		background-color: var(--color-bg-primary);
	}

	.image-toolbar {
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

	.toolbar-button.active {
		background-color: var(--color-bg-tree-active);
	}

	.image-name {
		font-size: 12px;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/*
	 * 透過画像の背景はテーマの単色(要件#16 ⑤)。市松模様は使わない。
	 * 中央寄せは flex の justify/align ではなく画像側の `margin: auto` で行う —
	 * 実寸表示で画像がはみ出したとき、justify-content: center だと左側が
	 * スクロールで辿り着けない位置へ切れる。
	 */
	.image-stage {
		flex: 1;
		display: flex;
		overflow: auto;
		padding: 16px;
		background-color: var(--color-bg-primary);
	}

	/*
	 * フィット(既定): 収まらない画像だけを縮める。max-* は縮小しかしないので、
	 * 小さいアイコンは原寸のまま — 引き伸ばさない(要件#16 ④)。
	 */
	.image {
		margin: auto;
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
	}

	/* 実寸: 上限を外して原寸で置き、はみ出したぶんは .image-stage のスクロールで見る。 */
	.image.actual {
		max-width: none;
		max-height: none;
	}

	.image-error {
		margin: auto;
		font-size: 13px;
		color: var(--color-text-secondary);
	}

	/* SVG のソース表示。プレーンテキスト(要件#2)と同じ逐語表示。 */
	.image-source {
		flex: 1;
		overflow: auto;
		padding: 16px;
	}

	.image-source pre {
		margin: 0;
		font-family: var(--md-font-mono);
		font-size: 90%;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--color-text-primary);
	}
</style>
