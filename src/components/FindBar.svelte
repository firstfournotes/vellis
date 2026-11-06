<script lang="ts">
	/**
	 * 文書内検索のバー(要件#54 契約①)。
	 *
	 * 閲覧面の上部に敷く一時 UI で、持つのは**入力欄・件数・Prev・Next・Close**の
	 * 5つだけ。一致の計算もハイライトも持たない ―― 計算は
	 * `$lib/find-in-document` の純関数、どの DOM を探すかと再検索の契機は
	 * `Viewer.svelte` の持ち場で、ここは値を映して操作を上へ伝えるだけ。
	 *
	 * Esc を**ここで受けない**のは、検索バーが開いているときの Esc が
	 * 「バーを閉じる」と「編集を破棄する」の取り合いになるため(req-54
	 * 「既存テストの棚卸し」)。取り合いは文書レベルの捕捉で1箇所に決める必要が
	 * あるので、Viewer が document の capture で受ける。ここが受けるのは
	 * **Enter / Shift+Enter** の送りだけ。
	 *
	 * 文言は英語(要件#51)。
	 */
	let {
		query,
		count,
		inputEl = $bindable(),
		onQueryChange,
		onPrev,
		onNext,
		onClose,
		onComposingChange,
	}: {
		/** 入力欄に出す語。 */
		query: string;
		/** 件数表示(`n of m` / `No results` / 空)。値は `formatCount` が決める。 */
		count: string;
		/** 入力欄の実体。⌘F の再送でフォーカスと全選択を戻すために親が握る。 */
		inputEl?: HTMLInputElement;
		onQueryChange: (value: string) => void;
		onPrev: () => void;
		onNext: () => void;
		onClose: () => void;
		/** IME の変換中か(Esc の宛先を決める Viewer 側へ伝える=契約⑤)。 */
		onComposingChange: (composing: boolean) => void;
	} = $props();

	function handleInput(e: Event) {
		onQueryChange((e.currentTarget as HTMLInputElement).value);
	}

	/**
	 * 契約④: Enter=次へ・Shift+Enter=前へ。IME の変換確定の Enter は送りに
	 * 使わない(要件#48/#49/#52/#53 と同じ規約)。
	 */
	function handleKeydown(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (e.key !== 'Enter') return;
		e.preventDefault();
		if (e.shiftKey) onPrev();
		else onNext();
	}
</script>

<!--
	`find-bar--sticky` は追補c(1) の印。見た目の規則は下の `<style>` にあるが、
	JSDOM は Svelte の `<style>` を計算しないので、契約を判定できる手掛かりとして
	class 自体を出しておく(受け入れテストはこの class を見る)。
-->
<div class="find-bar find-bar--sticky" data-testid="find-bar" role="search">
	<input
		type="text"
		class="find-input"
		data-testid="find-input"
		aria-label="Find in document"
		placeholder="Find"
		spellcheck="false"
		autocomplete="off"
		value={query}
		bind:this={inputEl}
		oninput={handleInput}
		onkeydown={handleKeydown}
		oncompositionstart={() => onComposingChange(true)}
		oncompositionend={() => onComposingChange(false)}
	/>
	<span class="find-count" data-testid="find-count" role="status">{count}</span>
	<button
		type="button"
		class="find-button"
		data-testid="find-prev"
		aria-label="Prev"
		title="Previous match (Shift+Enter)"
		onclick={onPrev}
	>
		Prev
	</button>
	<button
		type="button"
		class="find-button"
		data-testid="find-next"
		aria-label="Next"
		title="Next match (Enter)"
		onclick={onNext}
	>
		Next
	</button>
	<button
		type="button"
		class="find-button"
		data-testid="find-close"
		aria-label="Close"
		title="Close the find bar (Esc)"
		onclick={onClose}
	>
		Close
	</button>
</div>

<style>
	/*
	 * 閲覧面の上部に敷く1行(契約①)。外部変更の帯・構造変化の通知と同じ「本文の
	 * 上に重ねない」流儀 —— 検索中の本文を隠さないため。
	 */
	/*
	 * 要件#56 第2段: 見た目はモックのファイル内検索(右上に浮かぶ 1 段= `--color-bg-raised` +
	 * `--shadow-2` + `--radius-md`)。ただし契約①の「本文の上に重ねない」は守るので、行の
	 * 場所は取ったまま(右に寄せた札として置く)。
	 */
	.find-bar {
		display: flex;
		align-items: center;
		gap: 4px;
		align-self: flex-end;
		box-sizing: border-box;
		width: fit-content;
		max-width: calc(100% - 24px);
		margin: 8px 12px 4px;
		padding: 5px 5px 5px 6px;
		background-color: var(--color-bg-raised);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-2);
		font-size: var(--text-sm);
		color: var(--color-text-primary);
	}

	/*
	 * 要件#54 追補c(1): 本文と一緒にスクロールして消えないよう、閲覧面の上部に
	 * 留める。ツールバー(.viewer-toolbar = sticky・top:0・z-index:10)の直下に
	 * 積むので、`top` はその高さ分 —— 実寸は Viewer が `--vellis-find-bar-top` に
	 * 入れてくれる(ツールバーが無ければ 0 のまま上端に貼り付く)。z-index は
	 * ツールバーより下・本文より上。本文の上には重ねない(契約①)。
	 */
	.find-bar--sticky {
		position: sticky;
		/* 札の上の 8px の間(margin)を貼り付いた後も保つ。 */
		top: calc(var(--vellis-find-bar-top, 0px) + 8px);
		z-index: 9;
	}

	/* 入力欄(モックの `.inp`= 26px・角丸 6px)。フォーカスはアクセントの縁とリング。 */
	.find-input {
		flex: 0 1 220px;
		min-width: 0;
		height: 26px;
		box-sizing: border-box;
		font: inherit;
		font-size: var(--text-sm);
		padding: 0 8px;
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
		background-color: var(--color-bg-raised);
		color: var(--color-text-primary);
	}

	.find-input::placeholder {
		color: var(--color-text-muted);
	}

	.find-input:focus {
		border-color: var(--color-accent);
		outline: 2px solid var(--color-focus-ring);
		outline-offset: -1px;
	}

	/* 件数は幅が揺れると Prev/Next が踊るので、最小幅を取って左寄せで固定する。 */
	.find-count {
		min-width: 72px;
		padding: 0 6px;
		color: var(--color-text-secondary);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	/* 札の中の文字ボタン(モックの `.ib` と同じく地は透明・ホバーで面)。 */
	.find-button {
		height: 26px;
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 500;
		padding: 0 9px;
		border: 1px solid transparent;
		border-radius: 6px;
		background-color: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		white-space: nowrap;
	}

	.find-button:hover {
		background-color: var(--color-bg-hover);
		color: var(--color-text-primary);
	}
</style>
