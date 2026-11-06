<script lang="ts">
	/**
	 * DiffView — full-screen overlay that compares the snapshot copy of
	 * a file against the current on-disk content.
	 *
	 * Spec: `docs/ai-collab.md` 改訂 2 §11.5.  Phase 4.3 ships inline
	 * mode by default and side-by-side as a layout toggle; a yellow
	 * accent on lines overlapping the originating mark anchor is added
	 * when an `anchor` prop is supplied.
	 */
	import {
		diffAgainstSnapshot,
		revertToSnapshot,
		type DiffResponse,
		type Hunk,
		type Mark,
	} from '$lib/annotation';
	import Icon from './Icon.svelte';

	let {
		open,
		rootUri,
		mark,
		onClose,
	}: {
		open: boolean;
		rootUri: string;
		mark: Mark | null;
		onClose: () => void;
	} = $props();

	let mode = $state<'inline' | 'side-by-side'>('inline');
	let diff = $state<DiffResponse | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (!open || !mark || !rootUri) {
			diff = null;
			error = null;
			return;
		}
		loading = true;
		error = null;
		diffAgainstSnapshot({
			rootUri,
			uri: `file://${rootUri.replace(/^file:\/\//, '').replace(/\/$/, '')}/${mark.file}`,
		})
			.then((res) => {
				diff = res;
			})
			.catch((e) => {
				error = String(e);
				diff = null;
			})
			.finally(() => {
				loading = false;
			});
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	}

	async function revertFile() {
		if (!diff || !mark) return;
		const ok = confirm(
			`Restore ${diff.file} to the state of snapshot ${diff.snapshot_id}.\n\n` +
				'This will overwrite changes made by the AI. Continue?',
		);
		if (!ok) return;
		try {
			await revertToSnapshot({
				rootUri,
				snapshotId: diff.snapshot_id,
				files: [diff.file],
			});
			alert(`Restored: ${diff.file}`);
			onClose();
		} catch (e) {
			alert(`Could not restore: ${e}`);
		}
	}

	function lineRangeOverlapsAnchor(
		range: [number, number] | null,
		anchorStart: number,
		anchorEnd: number,
	): boolean {
		if (!range) return false;
		const [s, e] = range;
		return !(e < anchorStart || s > anchorEnd);
	}

	function classifyHunk(h: Hunk): string {
		if (!mark) return `hunk-${h.kind}`;
		const overlaps = lineRangeOverlapsAnchor(
			h.after_lines,
			mark.anchor.start_line,
			mark.anchor.end_line,
		);
		return overlaps ? `hunk-${h.kind} hunk-anchor` : `hunk-${h.kind}`;
	}

	function prefixLines(text: string, prefix: string): string {
		return text
			.split('\n')
			.map((line, i, arr) =>
				i === arr.length - 1 && line === '' ? '' : prefix + ' ' + line,
			)
			.join('\n');
	}
</script>

{#if open && mark}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="overlay" onclick={onClose}></div>
	<section
		class="diff-view"
		role="dialog"
		aria-modal="true"
		aria-labelledby="diff-title"
		onkeydown={handleKeydown}
	>
		<header>
			<h2 id="diff-title">Changes: {mark.file}</h2>
			<div class="header-right">
				<div class="mode-toggle" role="tablist">
					<button
						type="button"
						class="mode-tab"
						class:active={mode === 'inline'}
						onclick={() => (mode = 'inline')}
					>
						inline
					</button>
					<button
						type="button"
						class="mode-tab"
						class:active={mode === 'side-by-side'}
						onclick={() => (mode = 'side-by-side')}
					>
						side-by-side
					</button>
				</div>
				{#if diff}
					<button type="button" class="revert" onclick={revertFile}>
						Revert to Snapshot
					</button>
				{/if}
				<button type="button" class="close" onclick={onClose} aria-label="Close">
					<Icon name="x" size={16} />
				</button>
			</div>
		</header>
		<div class="body">
			{#if loading}
				<p class="placeholder">Computing diff…</p>
			{:else if error}
				<p class="placeholder error">
					Could not compute the diff: {error}<br />
					Run generate_inbox once to create a snapshot.
				</p>
			{:else if !diff}
				<p class="placeholder">No snapshot available.</p>
			{:else if diff.hunks.length === 0}
				<p class="placeholder">No differences.</p>
			{:else if mode === 'inline'}
				<pre class="inline-diff">
{#each diff.hunks as h, i (i)}{#if h.kind === 'equal'}<span class="hunk-equal">{h.text}</span>{:else if h.kind === 'delete'}<span class={classifyHunk(h)} title="Deleted (snapshot side)">{prefixLines(h.text, '-')}</span>{:else}<span class={classifyHunk(h)} title="Inserted (current side)">{prefixLines(h.text, '+')}</span>{/if}{/each}
				</pre>
			{:else}
				<div class="side-by-side">
					<pre class="col col-before"><span class="col-label">snapshot</span>{diff.before}</pre>
					<pre class="col col-after"><span class="col-label">Current</span>{diff.after}</pre>
				</div>
			{/if}
		</div>
	</section>
{/if}

<style>
	/* 暗くする層(要件#56 契約 4= `--color-shadow`)。 */
	.overlay {
		position: fixed;
		inset: 0;
		background-color: var(--color-shadow);
		z-index: 200;
	}

	/* 重なりの 1 段(要件#56 契約 4= `--color-bg-raised` + `--shadow-2` + `--radius-md`)。 */
	.diff-view {
		position: fixed;
		top: 5vh;
		left: 50%;
		transform: translateX(-50%);
		width: min(1200px, calc(100vw - 32px));
		height: 90vh;
		z-index: 201;
		display: flex;
		flex-direction: column;
		background-color: var(--color-bg-raised);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-2);
		overflow: hidden;
		color: var(--color-text-primary);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--color-border);
	}

	h2 {
		margin: 0;
		font-size: var(--text-md);
		font-weight: 600;
		font-family: var(--font-mono);
		color: var(--color-text-primary);
	}

	.header-right {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.mode-toggle {
		display: flex;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}

	.mode-tab {
		font: inherit;
		font-size: var(--text-xs);
		padding: 4px 10px;
		border: none;
		border-right: 1px solid var(--color-border-strong);
		background-color: var(--color-bg-raised);
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.mode-tab:hover:not(.active) {
		color: var(--color-text-primary);
	}

	.mode-tab:last-child {
		border-right: none;
	}

	.mode-tab.active {
		background-color: var(--color-accent);
		color: var(--color-on-accent);
	}

	.revert,
	.close {
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 500;
		padding: 4px 12px;
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
		background-color: var(--color-bg-raised);
		cursor: pointer;
	}

	.revert {
		color: var(--color-danger);
		border-color: var(--color-danger);
	}

	.revert:hover {
		background-color: var(--color-danger-soft);
	}

	.close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border-color: transparent;
		background-color: transparent;
		color: var(--color-text-secondary);
	}

	.close:hover {
		background-color: var(--color-bg-hover);
		color: var(--color-text-primary);
	}

	.body {
		flex: 1;
		overflow: auto;
		padding: 12px 16px;
		background-color: var(--color-bg-base);
	}

	.placeholder {
		text-align: center;
		color: var(--color-text-secondary);
		font-size: 12px;
		padding: 32px 16px;
	}

	.placeholder.error {
		color: var(--color-danger);
	}

	pre {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.inline-diff {
		background-color: var(--color-bg-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 8px 12px;
	}

	.hunk-equal {
		color: var(--color-text-primary);
	}

	.hunk-insert {
		display: inline;
		background-color: var(--color-success-soft);
		color: var(--color-success);
	}

	.hunk-delete {
		display: inline;
		background-color: var(--color-danger-soft);
		color: var(--color-danger);
		text-decoration: line-through;
	}

	.hunk-anchor {
		outline: 2px solid var(--color-warning);
	}

	.side-by-side {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	.col {
		background-color: var(--color-bg-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 8px 12px;
		position: relative;
		overflow-x: auto;
	}

	.col-label {
		display: block;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-text-secondary);
		margin-bottom: 4px;
	}
</style>
