<script lang="ts">
	/**
	 * 書式のツールバー(要件#74 第4段 4-2・要件56 のモックの画面2 の 5・6・由谷の決定 4-5・4-6)。Markdown の編集面(rendered・書ける)の
	 * ビューアのツールバーの下の 2 段目。中身はモックどおり=段落の種類の選択と、文字の装飾 5 | リスト 3 と引用 | 表 / Code Block / 画像 / 脚注 |
	 * Clear Formatting。押すとメニューバーの Format と同じ経路(`runFormatCommand`=取引 1 つ・変換中は確定の後に 1 回)。
	 * ボタンの mousedown は止めて、編集面のフォーカスと選択を奪わない。段落の種類の選択(select)の mousedown は止めない
	 * (止めると本物のクリックで選択肢が開かない=要件#74 実機ゲート・事後確認 (15)。select がフォーカスを取っても、
	 * 編集面の選択は ProseMirror の状態に残る)。押下の印(aria-pressed)は `activeFormat`。
	 */
	import { tick } from 'svelte';
	import Icon from './Icon.svelte';
	import { runFormatCommand, type FormatItemId } from '../editor/commands';
	import { activeFormat } from '../editor/active-format';
	import { FORMAT_TOOLBAR_BLOCK_TYPES, FORMAT_TOOLBAR_ITEMS, formatToolbarName, formatToolbarTitle } from '../editor/format-toolbar';
	import type { MarkdownEditorHandle } from '../editor/file-editor';

	let { handle }: { handle: MarkdownEditorHandle } = $props();

	/** 押下の印を持つ項目(mark 4・リスト 3・Quote・Code Block)。Link… / Insert / Clear は持たない。 */
	const PRESSABLE: ReadonlySet<FormatItemId> = new Set<FormatItemId>([
		'format-bold',
		'format-italic',
		'format-strikethrough',
		'format-inline-code',
		'format-bulleted-list',
		'format-numbered-list',
		'format-task-list',
		'format-quote',
		'format-code-block',
	]);

	/** ボタンの字形(モックの sprite の名前)。 */
	const ICONS: Partial<Record<FormatItemId, string>> = {
		'format-bold': 'bold',
		'format-italic': 'italic',
		'format-strikethrough': 'strike',
		'format-inline-code': 'code',
		'format-link': 'chain',
		'format-bulleted-list': 'list-ul',
		'format-numbered-list': 'list-ol',
		'format-task-list': 'task',
		'format-quote': 'quote',
		'format-insert-table': 'table',
		'format-code-block': 'codeblock',
		'format-insert-image': 'image',
		'format-insert-footnote': 'footnote',
		'format-clear': 'clear',
	};

	/** 今の装飾(面の取引のたびに読み直す)。 */
	let active = $derived.by(() => {
		void handle.version;
		return activeFormat(handle.view.state);
	});

	/** 段落の種類の選択の値(見出し n / Body Text。どちらでもなければ空)。 */
	let blockType = $derived(FORMAT_TOOLBAR_BLOCK_TYPES.find((id) => active.has(id)) ?? '');

	function keepFocus(e: MouseEvent) {
		e.preventDefault();
	}

	function run(id: FormatItemId) {
		runFormatCommand(id, handle);
	}

	/** 選択を選んでいる最中(mousedown〜change)。この間は面の段落の種類で選択の値を上書きしない。 */
	let choosing = false;

	function startChoosing() {
		// 既定の動作(選択肢を開く)は止めない
		choosing = true;
	}

	function handleChange(e: Event) {
		const el = e.currentTarget as HTMLSelectElement;
		const id = el.value as FormatItemId;
		choosing = false;
		if (id) run(id);
		// 当たらなかったとき(変換中など)も、今の段落の種類に戻す
		void tick().then(() => {
			if (selectEl && selectEl.value !== blockType) selectEl.value = blockType;
		});
	}

	let selectEl: HTMLSelectElement | undefined = $state();

	/**
	 * 選択の値は段落の種類が変わったときだけ合わせる(`value={…}` で書くと、ボタンの押下の印と同じ描き直しの中で毎回
	 * 合わせ直され、選んだ直後の値を上書きしてしまう)。
	 */
	$effect(() => {
		const value = blockType;
		const el = selectEl;
		if (el && !choosing && el.value !== value) el.value = value;
	});
</script>

<div class="format-toolbar" data-testid="format-toolbar" role="toolbar" aria-label="Formatting">
	<select
		class="format-block-type"
		data-testid="format-block-type"
		aria-label="Paragraph style"
		bind:this={selectEl}
		onmousedown={startChoosing}
		onchange={handleChange}
	>
		{#each FORMAT_TOOLBAR_BLOCK_TYPES as id (id)}
			<option value={id}>{formatToolbarName(id)}</option>
		{/each}
	</select>
	{#each FORMAT_TOOLBAR_ITEMS as item, index (`${item}-${index}`)}
		{#if item === '|'}
			<span class="format-toolbar-sep" aria-hidden="true"></span>
		{:else}
			<button
				type="button"
				class="format-toolbar-button"
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
	/* モックの .fmt: 2 段目に 40px の帯・ボタンは 28px・組の区切りは 1px の縦線 */
	.format-toolbar {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 2px;
		min-height: 40px;
		padding: 0 10px;
		border-bottom: 1px solid var(--color-border);
		background-color: var(--color-bg-surface);
	}

	.format-block-type {
		height: 28px;
		font: inherit;
		font-size: var(--text-sm);
		padding: 0 6px;
		margin-right: 4px;
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
		background-color: var(--color-bg-raised);
		color: var(--color-text-primary);
	}

	.format-toolbar-sep {
		width: 1px;
		height: 18px;
		margin: 0 6px;
		background-color: var(--color-border);
	}

	.format-toolbar-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: none;
		border-radius: 6px;
		background-color: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.format-toolbar-button:hover {
		background-color: var(--color-bg-hover);
	}

	.format-toolbar-button.on {
		background-color: var(--color-accent-soft);
		color: var(--color-accent-text);
	}

	/* 印刷では刷らない(print.css は触らない=AC-56-16。部品の側で隠す) */
	@media print {
		.format-toolbar {
			display: none;
		}
	}
</style>
