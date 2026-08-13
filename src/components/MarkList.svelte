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
			alert(`agent-inbox.md を書き出しました:\n${res.path}\n\n対象 ${res.mark_ids.length} 件 (Open → Sent)`);
		} catch (err) {
			alert(`generate_inbox 失敗: ${err}`);
		}
	}

	async function resolve(mark: Mark) {
		await marksStore.update({
			rootUri,
			id: mark.id,
			patch: { status: 'resolved' },
		});
	}

	async function remove(mark: Mark) {
		if (!confirm(`このマークを削除しますか?\n\n${mark.instruction.slice(0, 80)}`)) return;
		await marksStore.remove({ rootUri, id: mark.id });
	}

	function previewText(text: string): string {
		const trimmed = text.trim().replace(/\s+/g, ' ');
		return trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed;
	}
</script>

<aside class="mark-list" aria-label="マーク一覧">
	<header>
		<h2>
			マーク
			{#if marksStore.recentDrift.length > 0}
				<button
					type="button"
					class="drift-badge"
					title="AI 編集で位置が変わった/失われたマークがあります。クリックで通知をクリア。"
					onclick={() => marksStore.acknowledgeDrift()}
				>
					! {marksStore.recentDrift.length}
				</button>
			{/if}
		</h2>
		<div class="header-actions">
			<button type="button" class="primary" onclick={generateInbox} disabled={marksStore.all.length === 0}>
				inbox 生成
			</button>
			<button type="button" class="ghost" onclick={onClose} aria-label="閉じる">×</button>
		</div>
	</header>
	<nav class="filter-tabs" aria-label="マークフィルタ">
		<button
			type="button"
			class="filter-tab"
			class:active={filter === 'all'}
			onclick={() => onFilterChange?.('all')}
		>
			すべて ({marksStore.all.length})
		</button>
		<button
			type="button"
			class="filter-tab"
			class:active={filter === 'drift'}
			title="AI 編集で位置がずれたマーク (changed_by_agent / stale)"
			onclick={() => onFilterChange?.('drift')}
		>
			drift ({marksStore.all.filter((m) => DRIFT_STATUSES.includes(m.status)).length})
		</button>
	</nav>
	{#if marksStore.loading}
		<p class="empty">読み込み中…</p>
	{:else if marksStore.lastError}
		<p class="error">{marksStore.lastError}</p>
	{:else if filtered.length === 0}
		{#if filter === 'drift'}
			<p class="empty">drift 対象のマークはありません。</p>
		{:else}
			<p class="empty">マークはまだありません。<br />本文を選択して「指示を追加」を押してください。</p>
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
							<button type="button" onclick={() => onShowDiff(mark)}>差分</button>
						{/if}
						{#if mark.status !== 'resolved'}
							<button type="button" onclick={() => resolve(mark)}>解決</button>
						{/if}
						<button type="button" onclick={() => remove(mark)}>削除</button>
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
		background-color: #fafafa;
		border-left: 1px solid #e5e7eb;
		overflow-y: auto;
	}

	header {
		position: sticky;
		top: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		background-color: #ffffff;
		border-bottom: 1px solid #e5e7eb;
		z-index: 1;
	}

	header h2 {
		margin: 0;
		font-size: 14px;
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
		border: 1px solid #fca5a5;
		background-color: #fee2e2;
		color: #991b1b;
		cursor: pointer;
	}

	.drift-badge:hover {
		background-color: #fecaca;
	}

	.header-actions {
		display: flex;
		gap: 6px;
	}

	header button {
		font-size: 11px;
		padding: 4px 10px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background-color: #ffffff;
		cursor: pointer;
	}

	header button.primary {
		background-color: #2563eb;
		border-color: #2563eb;
		color: #ffffff;
	}

	header button.primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	header button.ghost {
		border-color: transparent;
		font-size: 16px;
		padding: 0 8px;
		color: #6b7280;
	}

	.filter-tabs {
		display: flex;
		gap: 0;
		border-bottom: 1px solid #e5e7eb;
		background-color: #ffffff;
	}

	.filter-tab {
		flex: 1;
		font-size: 11px;
		padding: 6px 4px;
		border: none;
		border-bottom: 2px solid transparent;
		background-color: transparent;
		color: #6b7280;
		cursor: pointer;
	}

	.filter-tab:hover {
		color: #1f2937;
	}

	.filter-tab.active {
		color: #1e40af;
		border-bottom-color: #2563eb;
	}

	.empty,
	.error {
		padding: 16px 12px;
		font-size: 12px;
		color: #6b7280;
		text-align: center;
	}

	.error {
		color: #b91c1c;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li {
		padding: 8px 12px;
		border-bottom: 1px solid #e5e7eb;
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
		border-radius: 3px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.status-open {
		background-color: #dbeafe;
		color: #1e40af;
	}
	.status-sent_to_agent {
		background-color: #fef3c7;
		color: #92400e;
	}
	.status-changed_by_agent {
		background-color: #fed7aa;
		color: #9a3412;
	}
	.status-resolved {
		background-color: #dcfce7;
		color: #166534;
	}
	.status-stale {
		background-color: #fee2e2;
		color: #991b1b;
	}

	.file {
		font-family: ui-monospace, SFMono-Regular, monospace;
		color: #374151;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.lines {
		color: #6b7280;
	}

	.instruction {
		margin: 0;
		font-size: 12px;
		color: #1f2937;
		line-height: 1.4;
	}

	.actions {
		display: flex;
		gap: 6px;
		justify-content: flex-end;
	}

	.actions button {
		font-size: 11px;
		padding: 2px 8px;
		border: 1px solid #d1d5db;
		border-radius: 3px;
		background-color: #ffffff;
		color: #374151;
		cursor: pointer;
	}

	.actions button:hover {
		background-color: #f3f4f6;
	}
</style>
