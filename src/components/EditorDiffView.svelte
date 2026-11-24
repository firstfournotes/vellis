<script lang="ts">
	/**
	 * 差分表示(要件#74 第4段 4-1・契約13・契約19・由谷の決定 4-1〜4-4)。衝突の差分(重なりの帯の Show Differences)と
	 * 未保存の変更の差分(Unsaved の札)だけ。1 列の unified・原文の文字列・読むだけ(塊ごとの選択はしない)。
	 *
	 * 行の差分は `src/editor/line-diff.ts` の `lineDiff`(3 方向マージと共有)。前後 3 行の文脈を出し、それより長い変わらない連なりは
	 * 「N unchanged lines」に畳む(押すと開く)。改行コードだけが違う行には「Line endings differ」。差分が大きすぎれば本文は
	 * 「Too many differences to show.」だけ。文言は英語。
	 */
	import { onMount } from 'svelte';
	import { lineDiff } from '../editor/line-diff';

	let {
		title,
		leftName,
		rightName,
		left,
		right,
		onClose,
		onKeep,
		onUseDisk,
	}: {
		title: string;
		leftName: string;
		rightName: string;
		left: string;
		right: string;
		onClose: () => void;
		/** 衝突のときだけ: Keep My Edits(帯と同じ)。 */
		onKeep?: () => void;
		/** 衝突のときだけ: Use the File on Disk(帯と同じ)。 */
		onUseDisk?: () => void;
	} = $props();

	/** 前後に出す文脈の行の数。 */
	const CONTEXT = 3;

	type Line = { kind: 'context' | 'delete' | 'insert'; text: string; a: number | null; b: number | null; eol: boolean };
	type Row = { type: 'line'; line: Line } | { type: 'fold'; id: number; lines: Line[] };

	let expanded = $state<ReadonlySet<number>>(new Set());
	let panelEl: HTMLElement | undefined = $state();

	const strip = (line: string) => line.replace(/\r\n$|\r$|\n$/, '');
	const eolOf = (line: string) => line.slice(strip(line).length);

	/** 差分の行(全部)。lineDiff が null なら null。 */
	let lines = $derived.by((): Line[] | null => {
		const hunks = lineDiff(left, right);
		if (hunks === null) return null;
		const aLines = left.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
		const out: Line[] = [];
		let a = 0;
		let b = 0;
		const context = (until: number) => {
			while (a < until) {
				out.push({ kind: 'context', text: strip(aLines[a]!), a: a + 1, b: b + 1, eol: false });
				a++;
				b++;
			}
		};
		for (const h of hunks) {
			context(h.aStart);
			h.aLines.forEach((l, i) => {
				const pair = h.bLines[i];
				const eol = pair !== undefined && strip(pair) === strip(l) && eolOf(pair) !== eolOf(l);
				out.push({ kind: 'delete', text: strip(l), a: a + 1, b: null, eol });
				a++;
			});
			h.bLines.forEach((l, i) => {
				const pair = h.aLines[i];
				const eol = pair !== undefined && strip(pair) === strip(l) && eolOf(pair) !== eolOf(l);
				out.push({ kind: 'insert', text: strip(l), a: null, b: b + 1, eol });
				b++;
			});
		}
		context(aLines.length);
		return out;
	});

	/** 行を、文脈の前後 3 行を残して畳んだ並びにする(開いた畳みはそのまま出す)。 */
	let rows = $derived.by((): Row[] => {
		const all = lines;
		if (!all) return [];
		const out: Row[] = [];
		let i = 0;
		let foldId = 0;
		while (i < all.length) {
			if (all[i]!.kind !== 'context') {
				out.push({ type: 'line', line: all[i]! });
				i++;
				continue;
			}
			let j = i;
			while (j < all.length && all[j]!.kind === 'context') j++;
			const run = all.slice(i, j);
			const head = i === 0 ? 0 : CONTEXT;
			const tail = j === all.length ? 0 : CONTEXT;
			if (run.length > head + tail) {
				for (const line of run.slice(0, head)) out.push({ type: 'line', line });
				const id = foldId++;
				const middle = run.slice(head, run.length - tail);
				if (expanded.has(id)) for (const line of middle) out.push({ type: 'line', line });
				else out.push({ type: 'fold', id, lines: middle });
				for (const line of run.slice(run.length - tail)) out.push({ type: 'line', line });
			} else {
				for (const line of run) out.push({ type: 'line', line });
			}
			i = j;
		}
		return out;
	});

	function expand(id: number) {
		expanded = new Set([...expanded, id]);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || e.isComposing) return;
		e.preventDefault();
		e.stopPropagation();
		onClose();
	}

	onMount(() => {
		panelEl?.focus({ preventScroll: true });
	});
</script>

<div class="editor-diff-layer">
	<!-- 契約どおり section に role="dialog"(DiffView.svelte と同じ形) -->
	<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
	<section
		class="editor-diff"
		data-testid="editor-diff"
		role="dialog"
		aria-label={title}
		tabindex="-1"
		bind:this={panelEl}
		onkeydown={handleKeydown}
	>
		<header class="editor-diff-header">
			<span class="editor-diff-title" data-testid="editor-diff-title">{title}</span>
			<span class="editor-diff-names">
				<span data-testid="editor-diff-left">{leftName}</span>
				<span aria-hidden="true">↔</span>
				<span data-testid="editor-diff-right">{rightName}</span>
			</span>
			<button type="button" class="editor-diff-button" data-testid="editor-diff-close" aria-label="Close" onclick={onClose}>Close</button>
		</header>
		<div class="editor-diff-body">
			{#if lines === null}
				<p class="editor-diff-too-many" data-testid="editor-diff-too-many">Too many differences to show.</p>
			{:else}
				{#each rows as row, index (row.type === 'fold' ? `fold-${row.id}` : `line-${index}`)}
					{#if row.type === 'fold'}
						<button type="button" class="editor-diff-expand" data-testid="editor-diff-expand" onclick={() => expand(row.id)}>
							{row.lines.length} unchanged lines
						</button>
					{:else}
						<div
							class="diff-line"
							data-testid="editor-diff-line"
							data-kind={row.line.kind}
							data-a={row.line.a ?? ''}
							data-b={row.line.b ?? ''}
						>
							<span class="diff-gutter">{row.line.a ?? ''}</span>
							<span class="diff-gutter">{row.line.b ?? ''}</span>
							<span class="diff-sign" aria-hidden="true">{row.line.kind === 'delete' ? '-' : row.line.kind === 'insert' ? '+' : ' '}</span>
							<span class="diff-text">{row.line.text}</span>
							{#if row.line.eol}
								<span class="diff-eol" data-testid="editor-diff-eol">Line endings differ</span>
							{/if}
						</div>
					{/if}
				{/each}
			{/if}
		</div>
		{#if onKeep || onUseDisk}
			<footer class="editor-diff-footer">
				{#if onKeep}
					<button type="button" class="editor-diff-button" data-testid="editor-diff-keep" onclick={onKeep}>Keep My Edits</button>
				{/if}
				{#if onUseDisk}
					<button type="button" class="editor-diff-button" data-testid="editor-diff-disk" onclick={onUseDisk}>Use the File on Disk</button>
				{/if}
			</footer>
		{/if}
	</section>
</div>

<style>
	/* ペインの文書の場所(article.viewer の見えている上端)に重ねる 1 枚。本文と一緒には流れない。 */
	.editor-diff-layer {
		position: sticky;
		top: 0;
		height: 0;
		z-index: 20;
	}

	/* 要件56 のオーバーレイのトークン(地・影・角)。 */
	.editor-diff {
		position: absolute;
		top: 8px;
		left: 12px;
		right: 12px;
		max-height: 70vh;
		display: flex;
		flex-direction: column;
		background-color: var(--color-bg-raised);
		box-shadow: var(--shadow-2);
		border-radius: var(--radius-md);
		color: var(--color-text-primary);
		font-size: var(--text-sm);
		outline: none;
	}

	.editor-diff-header,
	.editor-diff-footer {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
	}

	.editor-diff-header {
		border-bottom: 1px solid var(--color-border-strong);
	}

	.editor-diff-footer {
		justify-content: flex-end;
		border-top: 1px solid var(--color-border-strong);
	}

	.editor-diff-title {
		font-weight: 600;
	}

	.editor-diff-names {
		flex: 1;
		color: var(--color-text-secondary);
	}

	.editor-diff-button,
	.editor-diff-expand {
		font: inherit;
		font-size: var(--text-sm);
		padding: 2px 8px;
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
		background-color: var(--color-bg-raised);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.editor-diff-body {
		overflow: auto;
		padding: 4px 0;
		font-family: var(--font-mono);
		line-height: 1.5;
	}

	.editor-diff-expand {
		display: block;
		margin: 2px 10px;
		color: var(--color-text-secondary);
	}

	.diff-line {
		display: flex;
		gap: 8px;
		padding: 0 10px;
		white-space: pre;
	}

	/* 色は既存のトークン(由谷の決定): 足した行=success の淡色・消した行=danger の淡色 */
	.diff-line[data-kind='insert'] {
		background-color: var(--color-success-soft);
	}

	.diff-line[data-kind='delete'] {
		background-color: var(--color-danger-soft);
	}

	.diff-gutter {
		min-width: 3ch;
		text-align: right;
		color: var(--color-text-muted);
		user-select: none;
	}

	.diff-sign {
		color: var(--color-text-secondary);
		user-select: none;
	}

	.diff-eol {
		margin-left: auto;
		font-family: inherit;
		color: var(--color-text-secondary);
	}

	.editor-diff-too-many {
		margin: 8px 10px;
		color: var(--color-text-secondary);
	}

	/* 差分の画面は刷らない(print.css は触らない=AC-56-16。code-editor-print と同じく部品の側で) */
	@media print {
		.editor-diff-layer {
			display: none;
		}
	}
</style>
