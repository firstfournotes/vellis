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
			`${diff.file} を snapshot ${diff.snapshot_id} の状態に復元します。\n\n` +
				'この操作は AI が編集した変更を上書きします。続行しますか?',
		);
		if (!ok) return;
		try {
			await revertToSnapshot({
				rootUri,
				snapshotId: diff.snapshot_id,
				files: [diff.file],
			});
			alert(`復元しました: ${diff.file}`);
			onClose();
		} catch (e) {
			alert(`復元失敗: ${e}`);
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
			<h2 id="diff-title">変更差分: {mark.file}</h2>
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
						snapshot に戻す
					</button>
				{/if}
				<button type="button" class="close" onclick={onClose} aria-label="閉じる">
					×
				</button>
			</div>
		</header>
		<div class="body">
			{#if loading}
				<p class="placeholder">差分を計算中…</p>
			{:else if error}
				<p class="placeholder error">
					差分が取得できません: {error}<br />
					generate_inbox を一度実行して snapshot を作成してください。
				</p>
			{:else if !diff}
				<p class="placeholder">スナップショットがありません。</p>
			{:else if diff.hunks.length === 0}
				<p class="placeholder">差分はありません。</p>
			{:else if mode === 'inline'}
				<pre class="inline-diff">
{#each diff.hunks as h, i (i)}{#if h.kind === 'equal'}<span class="hunk-equal">{h.text}</span>{:else if h.kind === 'delete'}<span class={classifyHunk(h)} title="削除 (snapshot 側)">{prefixLines(h.text, '-')}</span>{:else}<span class={classifyHunk(h)} title="挿入 (現在側)">{prefixLines(h.text, '+')}</span>{/if}{/each}
				</pre>
			{:else}
				<div class="side-by-side">
					<pre class="col col-before"><span class="col-label">snapshot</span>{diff.before}</pre>
					<pre class="col col-after"><span class="col-label">現在</span>{diff.after}</pre>
				</div>
			{/if}
		</div>
	</section>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background-color: rgba(0, 0, 0, 0.5);
		z-index: 200;
	}

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
		background-color: #ffffff;
		border-radius: 8px;
		box-shadow: 0 24px 64px rgba(0, 0, 0, 0.25);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 16px;
		border-bottom: 1px solid #e5e7eb;
	}

	h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		font-family: ui-monospace, SFMono-Regular, monospace;
		color: #1f2937;
	}

	.header-right {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.mode-toggle {
		display: flex;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		overflow: hidden;
	}

	.mode-tab {
		font-size: 11px;
		padding: 4px 10px;
		border: none;
		border-right: 1px solid #d1d5db;
		background-color: #ffffff;
		color: #6b7280;
		cursor: pointer;
	}

	.mode-tab:last-child {
		border-right: none;
	}

	.mode-tab.active {
		background-color: #2563eb;
		color: #ffffff;
	}

	.revert,
	.close {
		font-size: 12px;
		padding: 4px 12px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background-color: #ffffff;
		cursor: pointer;
	}

	.revert {
		color: #b91c1c;
		border-color: #fca5a5;
	}

	.revert:hover {
		background-color: #fef2f2;
	}

	.close {
		font-size: 16px;
		padding: 0 10px;
		border-color: transparent;
		color: #6b7280;
	}

	.body {
		flex: 1;
		overflow: auto;
		padding: 12px 16px;
		background-color: #fafafa;
	}

	.placeholder {
		text-align: center;
		color: #6b7280;
		font-size: 12px;
		padding: 32px 16px;
	}

	.placeholder.error {
		color: #b91c1c;
	}

	pre {
		margin: 0;
		font-family: ui-monospace, SFMono-Regular, monospace;
		font-size: 12px;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.inline-diff {
		background-color: #ffffff;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		padding: 8px 12px;
	}

	.hunk-equal {
		color: #374151;
	}

	.hunk-insert {
		display: inline;
		background-color: #dcfce7;
		color: #166534;
	}

	.hunk-delete {
		display: inline;
		background-color: #fee2e2;
		color: #991b1b;
		text-decoration: line-through;
	}

	.hunk-anchor {
		outline: 2px solid #fde047;
	}

	.side-by-side {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	.col {
		background-color: #ffffff;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		padding: 8px 12px;
		position: relative;
		overflow-x: auto;
	}

	.col-label {
		display: block;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #6b7280;
		margin-bottom: 4px;
	}
</style>
