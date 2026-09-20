<script lang="ts">
	/**
	 * パスを打って跳ぶバー(要件#60 契約①⑥⑦)。
	 *
	 * 閲覧面の上部に敷く一時 UI で、持つのは**入力欄・Go・Close・「無い」の表示欄**の
	 * 4つだけ。パスの解釈も解決も跳躍も持たない —— それは `$lib/go-to-path` の純関数と
	 * `revealPath` の持ち場で、どの deps を渡すかは `+page.svelte` が決める。ここは
	 * 値を映して操作を上へ伝えるだけ(要件#54 の `FindBar` と同じ家風)。
	 *
	 * 置き場が `Viewer.svelte` の中ではなく `+page.svelte` なのは、Go to が文書では
	 * なく**ツリー**に効く操作で、**文書が開いていなくても出る**ため(契約①)。
	 *
	 * 文言は英語(要件#51)。
	 */
	let {
		onGo,
		onClose,
		notFound = false,
		inputEl = $bindable(),
		onComposingChange,
	}: {
		/** ⏎ / Go=打った文字列をそのまま(trim せず)渡す。畳むのは純関数の持ち場。 */
		onGo: (input: string) => void;
		/** Esc / Close=バーを閉じる。 */
		onClose: () => void;
		/** 直前の Go が「無い」で終わったか(契約⑥)。立つと表示欄に文言が出る。 */
		notFound?: boolean;
		/** 入力欄の実体。⇧⌘G の再送でフォーカスと全選択を戻すために親が握る。 */
		inputEl?: HTMLInputElement;
		/** IME の変換中か(Esc の宛先を決める `+page.svelte` 側へ伝える=契約⑦)。 */
		onComposingChange?: (composing: boolean) => void;
	} = $props();

	import { GO_TO_NOT_FOUND_MESSAGE } from '$lib/go-to-path';

	/** 打たれている文字列。閉じれば消える(揮発=契約①)。 */
	let value = $state('');

	/**
	 * 契約⑥: 「無い」は**入力欄の値が変わった時点で消える**(次の ⏎ を待たない)。
	 * 親の `notFound` はまだ立ったままなので、消したことをここで覚える。次の Go で
	 * 忘れ直すので、二度続けて外したときもちゃんともう一度出る。
	 */
	let dismissed = $state(false);

	let showNotFound = $derived(notFound && !dismissed);

	/** 変換中は Esc も ⏎ も IME に委ねる(要件#48/#49/#52/#53/#54 と同じ規約)。 */
	let composing = $state(false);

	function setComposing(next: boolean) {
		composing = next;
		onComposingChange?.(next);
	}

	function handleInput(e: Event) {
		value = (e.currentTarget as HTMLInputElement).value;
		dismissed = true;
	}

	function go() {
		dismissed = false;
		onGo(value);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.isComposing || composing) return;
		if (e.key === 'Enter') {
			e.preventDefault();
			go();
			return;
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	}
</script>

<div class="go-to-bar" data-testid="go-to-bar" role="search">
	<input
		type="text"
		class="go-to-input"
		data-testid="go-to-input"
		aria-label="Go to path"
		placeholder="Path"
		spellcheck="false"
		autocomplete="off"
		autocapitalize="off"
		autocorrect="off"
		{value}
		bind:this={inputEl}
		oninput={handleInput}
		onkeydown={handleKeydown}
		oncompositionstart={() => setComposing(true)}
		oncompositionend={() => setComposing(false)}
	/>
	<!--
		表示欄は**常に DOM にあり普段は空**(契約⑥)。出し入れで行の高さが揺れると、
		打ち直している最中にボタンの位置が動く。
	-->
	<span class="go-to-message" data-testid="go-to-message" role="status"
		>{showNotFound ? GO_TO_NOT_FOUND_MESSAGE : ''}</span
	>
	<button
		type="button"
		class="go-to-button"
		data-testid="go-to-go"
		aria-label="Go"
		title="Go to the path (Enter)"
		onclick={go}
	>
		Go
	</button>
	<button
		type="button"
		class="go-to-button"
		data-testid="go-to-close"
		aria-label="Close"
		title="Close the go to bar (Esc)"
		onclick={onClose}
	>
		Close
	</button>
</div>

<style>
	/*
	 * 閲覧面の上部に敷く1行(契約①)。外部変更の帯・検索バーと同じ「本文の上に
	 * 重ねない」流儀で、文書が無いとき(EmptyState)もこの位置に出る。
	 */
	.go-to-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		background-color: #f9fafb;
		border-bottom: 1px solid #e5e7eb;
		font-size: 12px;
		flex-shrink: 0;
	}

	.go-to-input {
		flex: 0 1 360px;
		min-width: 0;
		font-size: 12px;
		padding: 3px 8px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background-color: #ffffff;
		color: #111827;
	}

	.go-to-input:focus {
		outline: 2px solid #93c5fd;
		outline-offset: -1px;
	}

	/*
	 * 「無い」は入力欄の隣に薄く出す(追補b (m)「入力バーの中に薄く出す」)。
	 * 幅は伸ばせるままにして、長いメッセージでもボタンを押し出さない。
	 */
	.go-to-message {
		flex: 1 1 auto;
		min-width: 0;
		color: #b45309;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.go-to-button {
		font-size: 12px;
		padding: 3px 10px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background-color: #ffffff;
		color: #374151;
		cursor: pointer;
		flex-shrink: 0;
	}

	.go-to-button:hover {
		background-color: #f3f4f6;
	}
</style>
