<script lang="ts">
	/**
	 * 浮遊バー(要件#74 第4段 4-3・要件56 のモックの画面2 の 8・由谷の決定 4-7)。Markdown の編集面で空でない文字の選択が落ち着いたとき、
	 * 選択のすぐ上(入らなければ下)に出る小さなツールバー。中身=段落の種類の選択・Bold・Italic・Strikethrough・Inline Code・Link… |
	 * Clear Formatting。押すと書式のツールバーと同じ経路(`run`=面が `runFormatCommand` を呼ぶ)。mousedown は止めて選択を保つ。
	 * 出し入れと位置は面(MarkdownEditor)が決める。ここは描くだけ。
	 */
	import { tick } from 'svelte';
	import Icon from './Icon.svelte';
	import type { FormatItemId } from '../editor/commands';
	import { activeFormat } from '../editor/active-format';
	import {
		FORMAT_ITEM_ICONS as ICONS,
		FORMAT_TOOLBAR_BLOCK_TYPES,
		PRESSABLE_FORMAT_ITEMS as PRESSABLE,
		SELECTION_BAR_ITEMS,
		formatToolbarName,
		formatToolbarTitle,
	} from '../editor/format-toolbar';
	import type { MarkdownEditorHandle } from '../editor/file-editor';

	let {
		handle,
		left,
		top,
		placement,
		run,
		el = $bindable(),
	}: {
		handle: MarkdownEditorHandle;
		left: number;
		top: number;
		placement: 'above' | 'below';
		/** 項目を当てる(面がメニューと同じ経路で当てる)。 */
		run: (id: FormatItemId) => void;
		/** バーの要素(面が大きさを測る)。 */
		el?: HTMLElement;
	} = $props();

	let active = $derived.by(() => {
		void handle.version;
		return activeFormat(handle.view.state);
	});
	let blockType = $derived(FORMAT_TOOLBAR_BLOCK_TYPES.find((id) => active.has(id)) ?? '');

	let selectEl: HTMLSelectElement | undefined = $state();
	/** 選択を選んでいる最中(mousedown〜change)は、面の段落の種類で値を上書きしない(FormatToolbar と同じ)。 */
	let choosing = false;

	$effect(() => {
		const value = blockType;
		const s = selectEl;
		if (s && !choosing && s.value !== value) s.value = value;
	});

	function keepFocus(e: MouseEvent) {
		e.preventDefault();
	}

	function startChoosing(e: MouseEvent) {
		e.preventDefault();
		choosing = true;
	}

	function handleChange(e: Event) {
		const id = (e.currentTarget as HTMLSelectElement).value as FormatItemId;
		choosing = false;
		if (id) run(id);
		void tick().then(() => {
			if (selectEl && selectEl.value !== blockType) selectEl.value = blockType;
		});
	}
</script>

<div
	class="selection-bar"
	data-testid="selection-bar"
	role="toolbar"
	aria-label="Formatting"
	data-placement={placement}
	style:position="absolute"
	style:left="{left}px"
	style:top="{top}px"
	bind:this={el}
>
	<select
		class="selection-block-type"
		data-testid="selection-block-type"
		aria-label="Paragraph style"
		bind:this={selectEl}
		onmousedown={startChoosing}
		onchange={handleChange}
	>
		{#each FORMAT_TOOLBAR_BLOCK_TYPES as id (id)}
			<option value={id}>{formatToolbarName(id)}</option>
		{/each}
	</select>
	{#each SELECTION_BAR_ITEMS as item, index (`${item}-${index}`)}
		{#if item === '|'}
			<span class="selection-bar-sep" aria-hidden="true"></span>
		{:else}
			<button
				type="button"
				class="selection-bar-button"
				class:on={PRESSABLE.has(item) && active.has(item)}
				data-format-id={item}
				title={formatToolbarTitle(item)}
				aria-label={formatToolbarName(item)}
				aria-pressed={PRESSABLE.has(item) ? active.has(item) : undefined}
				onmousedown={keepFocus}
				onclick={() => run(item)}
			>
				<Icon name={ICONS[item] ?? 'format'} size={16} />
			</button>
		{/if}
	{/each}
</div>

<style>
	/* モックの浮遊バー(オーバーレイの 1 段=地・影・角は要件56 のトークン) */
	.selection-bar {
		z-index: 15;
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 3px 4px;
		background-color: var(--color-bg-raised);
		box-shadow: var(--shadow-2);
		border-radius: var(--radius-md);
		white-space: nowrap;
	}

	.selection-block-type {
		height: 26px;
		font: inherit;
		font-size: var(--text-sm);
		padding: 0 4px;
		margin-right: 2px;
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
		background-color: var(--color-bg-raised);
		color: var(--color-text-primary);
	}

	.selection-bar-sep {
		width: 1px;
		height: 18px;
		margin: 0 4px;
		background-color: var(--color-border);
	}

	.selection-bar-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		padding: 0;
		border: none;
		border-radius: 6px;
		background-color: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.selection-bar-button:hover {
		background-color: var(--color-bg-hover);
	}

	.selection-bar-button.on {
		background-color: var(--color-accent-soft);
		color: var(--color-accent-text);
	}

	/* 印刷では刷らない(print.css は触らない=AC-56-16。部品の側で隠す) */
	@media print {
		.selection-bar {
			display: none;
		}
	}
</style>
