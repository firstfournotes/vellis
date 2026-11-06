<script lang="ts">
	/**
	 * Marks sidebar (Phase 4.1 MVP).
	 * Spec: `docs/ai-collab.md` 改訂 2 §11.4.
	 *
	 * Phase 4.1 keeps the layout simple: status badge, file path, line
	 * range, instruction preview, resolve / delete actions.  Tabs and
	 * sort options live with the polish work in Phase 4.2 onward.
	 */
	import { marksStore } from '../stores/marks.svelte';
	import type { Mark, MarkStatus } from '../lib/annotation';
	import Icon from './Icon.svelte';

	type FilterMode = 'all' | 'drift';

	let {
		rootUri,
		filter = 'all',
		onFilterChange,
		onSelect,
		onShowDiff,
		onClose,
	}: {
		rootUri: string;
		filter?: FilterMode;
		onFilterChange?: (next: FilterMode) => void;
		onSelect: (mark: Mark) => void;
		onShowDiff?: (mark: Mark) => void;
		onClose: () => void;
	} = $props();

	const DRIFT_STATUSES: ReadonlyArray<MarkStatus> = ['changed_by_agent', 'stale'];

	const filtered = $derived(
		filter === 'drift'
			? marksStore.all.filter((m) => DRIFT_STATUSES.includes(m.status))
			: marksStore.all,
	);

	$effect(() => {
		// Re-fetch when the root changes.
		if (rootUri) marksStore.refresh(rootUri);
	});

	const STATUS_LABEL: Record<MarkStatus, string> = {
		open: 'Open',
		sent_to_agent: 'Sent',
		changed_by_agent: 'Changed',
		resolved: 'Resolved',
		stale: 'Stale',
	};

	async function generateInbox() {
		try {
			const res = await marksStore.generateInbox(rootUri, { status: 'open' });
			alert(`Exported agent-inbox.md:\n${res.path}\n\n${res.mark_ids.length} marks (Open → Sent)`);
		} catch (err) {
			alert(`Could not export the inbox: ${err}`);
		}
	}

	// 要件#71 追補a(2): 失敗したら alert で知らせる。store は失敗時に一覧を変えないので
	// (await の後で代入する)、ここで catch すれば一覧はそのまま・Unhandled Rejection も出ない。
	// lastError には入れない(入れると一覧がエラー表示に置き換わる)。
	async function resolve(mark: Mark) {
		try {
			await marksStore.update({
				rootUri,
				id: mark.id,
				patch: { status: 'resolved' },
			});
		} catch (err) {
			alert(`Could not resolve the mark: ${err}`);
		}
	}

	async function remove(mark: Mark) {
		if (!confirm(`Delete this mark?\n\n${mark.instruction.slice(0, 80)}`)) return;
		try {
			await marksStore.remove({ rootUri, id: mark.id });
		} catch (err) {
			alert(`Could not delete the mark: ${err}`);
		}
	}

	function previewText(text: string): string {
		const trimmed = text.trim().replace(/\s+/g, ' ');
		return trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed;
	}
</script>

<aside class="mark-list" aria-label="Marks">
	<header>
		<h2>
			Marks
			{#if marksStore.recentDrift.length > 0}
				<button
					type="button"
					class="drift-badge"
					title="Some marks moved or were lost during AI edits. Click to clear this notice."
					onclick={() => marksStore.acknowledgeDrift()}
				>
					! {marksStore.recentDrift.length}
				</button>
			{/if}
		</h2>
		<div class="header-actions">
			<button type="button" class="primary" onclick={generateInbox} disabled={marksStore.all.length === 0}>
				Generate Inbox
			</button>
			<button type="button" class="ghost" onclick={onClose} aria-label="Close"><Icon name="x" size={14} /></button>
		</div>
	</header>
	<nav class="filter-tabs" aria-label="Mark Filter">
		<button
			type="button"
			class="filter-tab"
			class:active={filter === 'all'}
			onclick={() => onFilterChange?.('all')}
		>
			All ({marksStore.all.length})
		</button>
		<button
			type="button"
			class="filter-tab"
			class:active={filter === 'drift'}
			title="Marks that drifted during AI edits (changed_by_agent / stale)"
			onclick={() => onFilterChange?.('drift')}
		>
			drift ({marksStore.all.filter((m) => DRIFT_STATUSES.includes(m.status)).length})
		</button>
	</nav>
	{#if marksStore.loading}
		<p class="empty">Loading…</p>
	{:else if marksStore.lastError}
		<p class="error">{marksStore.lastError}</p>
	{:else if filtered.length === 0}
		{#if filter === 'drift'}
			<p class="empty">No drifted marks.</p>
		{:else}
			<p class="empty">No marks yet.<br />Select text and press Add Instruction.</p>
		{/if}
	{:else}
		<ul>
			{#each filtered as mark (mark.id)}
				<li>
					<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
					<div class="row" onclick={() => onSelect(mark)}>
						<span class="status status-{mark.status}">{STATUS_LABEL[mark.status]}</span>
						<span class="file">{mark.file}</span>
						<span class="lines">L{mark.anchor.start_line}-{mark.anchor.end_line}</span>
					</div>
					<p class="instruction">{previewText(mark.instruction)}</p>
					<div class="actions">
						{#if onShowDiff && mark.status !== 'open'}
							<button type="button" onclick={() => onShowDiff(mark)}>Diff</button>
						{/if}
						{#if mark.status !== 'resolved'}
							<button type="button" onclick={() => resolve(mark)}>Resolve</button>
						{/if}
						<button type="button" onclick={() => remove(mark)}>Delete</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</aside>

<style>
	.mark-list {
		width: 320px;
		max-width: 40vw;
		display: flex;
		flex-direction: column;
		background-color: var(--color-bg-base);
		border-left: 1px solid var(--color-border);
		overflow-y: auto;
	}

	header {
		position: sticky;
		top: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		background-color: var(--color-bg-surface);
		border-bottom: 1px solid var(--color-border);
		z-index: 1;
	}

	header h2 {
		margin: 0;
		font-size: var(--text-md);
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.drift-badge {
		font-size: 10px;
		font-weight: 700;
		padding: 1px 6px;
		border-radius: 8px;
		border: 1px solid var(--color-danger);
		background-color: var(--color-danger-soft);
		color: var(--color-danger);
		cursor: pointer;
	}

	.drift-badge:hover {
		background-color: var(--color-danger-soft);
	}

	.header-actions {
		display: flex;
		gap: 6px;
	}

	header button {
		font: inherit;
		font-size: var(--text-xs);
		font-weight: 500;
		padding: 4px 10px;
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
		background-color: var(--color-bg-raised);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	header button.primary {
		background-color: var(--color-accent);
		border-color: transparent;
		color: var(--color-on-accent);
	}

	header button.primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	header button.ghost {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border-color: transparent;
		border-radius: 5px;
		background-color: transparent;
		color: var(--color-text-secondary);
	}

	header button.ghost:hover {
		background-color: var(--color-bg-hover);
		color: var(--color-text-primary);
	}

	.filter-tabs {
		display: flex;
		gap: 0;
		border-bottom: 1px solid var(--color-border);
		background-color: var(--color-bg-surface);
	}

	.filter-tab {
		flex: 1;
		font: inherit;
		font-size: var(--text-xs);
		padding: 6px 4px;
		border: none;
		border-bottom: 2px solid transparent;
		background-color: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.filter-tab:hover {
		color: var(--color-text-primary);
	}

	.filter-tab.active {
		color: var(--color-accent-text);
		border-bottom-color: var(--color-accent);
	}

	.empty,
	.error {
		padding: 16px 12px;
		font-size: 12px;
		color: var(--color-text-secondary);
		text-align: center;
	}

	.error {
		color: var(--color-danger);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li {
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		cursor: pointer;
	}

	.status {
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 4px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.status-open {
		background-color: var(--color-accent-soft);
		color: var(--color-accent-text);
	}
	.status-sent_to_agent {
		background-color: var(--color-bg-active);
		color: var(--color-text-secondary);
	}
	.status-changed_by_agent {
		background-color: var(--color-warning-soft);
		color: var(--color-warning);
	}
	.status-resolved {
		background-color: var(--color-success-soft);
		color: var(--color-success);
	}
	.status-stale {
		background-color: var(--color-danger-soft);
		color: var(--color-danger);
	}

	.file {
		font-family: var(--font-mono);
		color: var(--color-text-primary);
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.lines {
		color: var(--color-text-secondary);
	}

	.instruction {
		margin: 0;
		font-size: 12px;
		color: var(--color-text-primary);
		line-height: 1.4;
	}

	.actions {
		display: flex;
		gap: 6px;
		justify-content: flex-end;
	}

	.actions button {
		font: inherit;
		font-size: var(--text-xs);
		padding: 2px 8px;
		border: 1px solid var(--color-border-strong);
		border-radius: 4px;
		background-color: var(--color-bg-raised);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.actions button:hover {
		background-color: var(--color-bg-hover);
	}
</style>
