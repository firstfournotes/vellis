<script lang="ts">
	/**
	 * 差分表示(要件#74 第4段 4-1・契約13・契約19・由谷の決定 4-1〜4-4)。衝突の差分(重なりの帯の Show Differences)と
	 * 未保存の変更の差分(Unsaved の札)だけ。1 列の unified・原文の文字列・読むだけ(塊ごとの選択はしない)。
	 *
	 * 行の差分は `src/editor/line-diff.ts` の `lineDiff`(3 方向マージと共有)。前後 3 行の文脈を出し、それより長い変わらない連なりは
	 * 「N unchanged lines」に畳む(押すと開く)。改行コードだけが違う行には「Line endings differ」。差分が大きすぎれば本文は
	 * 「Too many differences to show.」だけ。文言は英語。
	 *
	 * 要件#89 契約8〜12: `merge` を渡すと同じ 1 枚がマージの画面(Merge Changes)になる(由谷の決定=今の Show Differences の
	 * 画面を広げる)。塊は `mergeChunks`(基準の版・自分の修正・ディスクの版)の conflict。重ならない変更は自動で入り、塊ごとに
	 * My Edits / On Disk / Both を選ぶ。全部選ぶと Apply が押せる。届いた中身が変わって作り直すときは、同じ中身の塊の選びを
	 * 残す(`carryChoices`)。衝突の差分(onKeep / onUseDisk があるとき)には Merge…(onMerge)を出す。
	 */
	import { onMount, untrack } from 'svelte';
	import { lineDiff, splitLines } from '../editor/line-diff';
	import {
		applyChoices,
		carryChoices,
		conflictsOf,
		mergeChunks,
		type MergeChoice,
		type MergeConflict,
		type MergePart,
	} from '../editor/merge-chunks';

	let {
		title,
		leftName,
		rightName,
		left,
		right,
		onClose,
		onKeep,
		onUseDisk,
		onMerge,
		merge,
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
		/** 要件#89 契約8: 衝突のときだけ: Merge…(マージの画面へ)。 */
		onMerge?: () => void;
		/**
		 * 要件#89 契約9〜12: マージの画面にする。base=基準の版・mine=今の文字列・theirs=ディスクの版・rebuilt=作り直しの印。
		 * Cancel(と Escape)は onClose、Apply は onApply(マージした文字列)。見出しは title。
		 */
		merge?: {
			base: string;
			mine: string;
			theirs: string;
			rebuilt: boolean;
			onApply: (merged: string) => void;
		};
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
		const aLines = splitLines(left);
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

	// --- マージの画面(要件#89) ------------------------------------------------

	/** 画面の並び: 文脈(clean の前後の行)・畳んだ行の数・塊(conflict の番号つき)。 */
	type MergeRow =
		| { type: 'context'; key: string; lines: string[] }
		| { type: 'fold'; key: string; count: number }
		| { type: 'chunk'; key: string; index: number; chunk: MergeConflict };

	/** 塊の並び(mergeChunks)。null=差分が大きすぎる。中身(base・mine・theirs)が変わったときだけ作り直す。 */
	let mergeParts = $state.raw<MergePart[] | null>(null);
	/** 塊ごとの選び(conflict の番号の並び)。 */
	let choices = $state<Array<MergeChoice | null>>([]);
	let builtFrom: { base: string; mine: string; theirs: string } | null = null;

	// 最初の組み立て(描く前に走る)と、契約12: 届いた中身(か今の文字列・基準の版)が変わったら塊を作り直し、同じ中身の塊の選びを残す。
	$effect.pre(() => {
		const m = merge;
		if (!m) return;
		const { base, mine, theirs } = m;
		untrack(() => {
			if (builtFrom && builtFrom.base === base && builtFrom.mine === mine && builtFrom.theirs === theirs) return;
			const next = mergeChunks(base, mine, theirs);
			choices = carryChoices(mergeParts ?? [], choices, next ?? []);
			mergeParts = next;
			builtFrom = { base, mine, theirs };
		});
	});

	/** 選びを当てた文字列(未選択が残れば null=Apply は押せない)。 */
	let merged = $derived(mergeParts === null ? null : applyChoices(mergeParts, choices));
	let chunkCount = $derived(conflictsOf(mergeParts).length);

	function choose(index: number, choice: MergeChoice) {
		const next = [...choices];
		next[index] = choice;
		choices = next;
	}

	/** clean の前後に出す文脈(塊の前後 CONTEXT 行。長い連なりは「N unchanged lines」に畳む)。 */
	let mergeRows = $derived.by((): MergeRow[] => {
		const parts = mergeParts;
		if (!parts) return [];
		const out: MergeRow[] = [];
		let index = 0;
		parts.forEach((part, i) => {
			if (part.kind === 'conflict') {
				out.push({ type: 'chunk', key: `chunk-${i}`, index: index++, chunk: part });
				return;
			}
			// 出すのは前後 CONTEXT 行だけなので、改行の印を外すのもその行だけ
			const all = splitLines(part.text);
			const head = i === 0 ? 0 : CONTEXT;
			const tail = i === parts.length - 1 ? 0 : CONTEXT;
			if (all.length <= head + tail) {
				out.push({ type: 'context', key: `context-${i}`, lines: all.map(strip) });
				return;
			}
			if (head > 0) out.push({ type: 'context', key: `context-${i}-head`, lines: all.slice(0, head).map(strip) });
			out.push({ type: 'fold', key: `fold-${i}`, count: all.length - head - tail });
			if (tail > 0) out.push({ type: 'context', key: `context-${i}-tail`, lines: all.slice(all.length - tail).map(strip) });
		});
		return out;
	});

	onMount(() => {
		panelEl?.focus({ preventScroll: true });
	});
</script>

<div class="editor-diff-layer">
	{#if merge}
		<!-- 要件#89: マージの画面(同じ層・同じ見た目のトークン)。section に role="dialog" -->
		<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
		<section
			class="editor-diff merge-view"
			data-testid="merge-view"
			role="dialog"
			aria-label={title}
			tabindex="-1"
			bind:this={panelEl}
			onkeydown={handleKeydown}
		>
			<header class="editor-diff-header">
				<span class="editor-diff-title">{title}</span>
				<span class="editor-diff-names">
					{#if mergeParts === null}
						My Edits ↔ On Disk
					{:else if chunkCount === 0}
						No overlapping changes
					{:else}
						{chunkCount} overlapping {chunkCount === 1 ? 'change' : 'changes'}: choose what to keep
					{/if}
				</span>
				<button type="button" class="editor-diff-button" data-testid="merge-cancel" onclick={onClose}>Cancel</button>
				<button
					type="button"
					class="editor-diff-button"
					data-testid="merge-apply"
					disabled={merged === null}
					onclick={() => {
						if (merged !== null) merge?.onApply(merged);
					}}
				>
					Apply
				</button>
			</header>
			{#if merge.rebuilt}
				<div class="merge-rebuilt" data-testid="merge-rebuilt-notice" role="status">The file on disk changed again. The chunks were rebuilt.</div>
			{/if}
			<div class="editor-diff-body">
				{#if mergeParts === null}
					<p class="editor-diff-too-many" data-testid="merge-too-many">Too many differences to merge.</p>
				{:else}
					{#each mergeRows as row (row.key)}
						{#if row.type === 'context'}
							{#each row.lines as line, n (n)}
								<div class="diff-line merge-context"><span class="diff-text">{line}</span></div>
							{/each}
						{:else if row.type === 'fold'}
							<div class="merge-fold">{row.count} unchanged lines</div>
						{:else}
							<div class="merge-chunk" data-testid="merge-chunk" data-index={row.index}>
								<div class="merge-side" data-side="mine">
									<span class="merge-side-name">My Edits{row.chunk.mine === '' ? ' (removed)' : ''}</span>
									<pre class="merge-text" data-testid="merge-chunk-mine">{row.chunk.mine}</pre>
								</div>
								<div class="merge-side" data-side="theirs">
									<span class="merge-side-name">On Disk{row.chunk.theirs === '' ? ' (removed)' : ''}</span>
									<pre class="merge-text" data-testid="merge-chunk-theirs">{row.chunk.theirs}</pre>
								</div>
								<div class="merge-choices" role="group" aria-label="Keep for change {row.index + 1}">
									<button
										type="button"
										class="editor-diff-button merge-choice"
										data-testid="merge-choose-mine"
										aria-pressed={choices[row.index] === 'mine' ? 'true' : 'false'}
										onclick={() => choose(row.index, 'mine')}>My Edits</button
									>
									<button
										type="button"
										class="editor-diff-button merge-choice"
										data-testid="merge-choose-theirs"
										aria-pressed={choices[row.index] === 'theirs' ? 'true' : 'false'}
										onclick={() => choose(row.index, 'theirs')}>On Disk</button
									>
									<button
										type="button"
										class="editor-diff-button merge-choice"
										data-testid="merge-choose-both"
										title="Keep both: my edits, then the file on disk"
										aria-pressed={choices[row.index] === 'both' ? 'true' : 'false'}
										onclick={() => choose(row.index, 'both')}>Both</button
									>
								</div>
							</div>
						{/if}
					{/each}
				{/if}
			</div>
		</section>
	{:else}
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
				{#if onMerge}
					<button type="button" class="editor-diff-button" data-testid="editor-diff-merge" onclick={onMerge}>Merge…</button>
				{/if}
			</footer>
		{/if}
	</section>
	{/if}
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

	/* 要件#89: マージの画面 */
	.editor-diff-button:disabled {
		color: var(--color-text-muted);
		cursor: default;
	}

	.merge-rebuilt {
		padding: 4px 10px;
		background-color: var(--color-warning-soft);
		border-bottom: 1px solid var(--color-border-strong);
	}

	/* 契約9: 文脈の行は長い行を折り返す(.diff-line の white-space: pre を上書き) */
	.merge-context {
		color: var(--color-text-secondary);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.merge-fold {
		margin: 2px 10px;
		color: var(--color-text-muted);
	}

	.merge-chunk {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 4px 8px;
		margin: 4px 10px;
		padding: 6px;
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
	}

	.merge-side {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.merge-side-name {
		color: var(--color-text-secondary);
	}

	.merge-text {
		margin: 2px 0 0;
		padding: 2px 6px;
		min-height: 1.5em;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font: inherit;
	}

	.merge-side[data-side='mine'] .merge-text {
		background-color: var(--color-success-soft);
	}

	.merge-side[data-side='theirs'] .merge-text {
		background-color: var(--color-accent-soft);
	}

	.merge-choices {
		grid-column: 1 / -1;
		display: flex;
		gap: 6px;
		justify-content: flex-end;
	}

	.merge-choice[aria-pressed='true'] {
		background-color: var(--color-accent-soft);
		border-color: var(--color-accent);
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
