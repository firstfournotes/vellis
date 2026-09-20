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
	.find-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		background-color: #f9fafb;
		border-bottom: 1px solid #e5e7eb;
		font-size: 12px;
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
		top: var(--vellis-find-bar-top, 0px);
		z-index: 9;
	}

	.find-input {
		flex: 0 1 240px;
		min-width: 0;
		font-size: 12px;
		padding: 3px 8px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background-color: #ffffff;
		color: #111827;
	}

	.find-input:focus {
		outline: 2px solid #93c5fd;
		outline-offset: -1px;
	}

	/* 件数は幅が揺れると Prev/Next が踊るので、最小幅を取って左寄せで固定する。 */
	.find-count {
		min-width: 72px;
		color: #6b7280;
		font-variant-numeric: tabular-nums;
	}

	.find-button {
		font-size: 12px;
		padding: 3px 10px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background-color: #ffffff;
		color: #374151;
		cursor: pointer;
	}

	.find-button:hover {
		background-color: #f3f4f6;
	}
</style>
