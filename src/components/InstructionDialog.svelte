<script lang="ts">
	/**
	 * Modal for entering an AI instruction against a marked range.
	 * Spec: `docs/ai-collab.md` 改訂 2 §11.2.
	 *
	 * Submit: Cmd/Ctrl+Enter or click 送信
	 * Cancel: Esc or click 取り消し
	 */
	let {
		open,
		preview,
		onSubmit,
		onCancel,
	}: {
		open: boolean;
		preview: string;
		onSubmit: (instruction: string) => void;
		onCancel: () => void;
	} = $props();

	let instruction = $state('');
	let textarea: HTMLTextAreaElement | undefined = $state(undefined);

	$effect(() => {
		if (open) {
			instruction = '';
			// Defer focus until the textarea is in the DOM.
			queueMicrotask(() => textarea?.focus());
		}
	});

	function submit() {
		const text = instruction.trim();
		if (!text) return;
		onSubmit(text);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onCancel();
		} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			submit();
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={onCancel}></div>
	<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="instr-title" onkeydown={handleKeydown}>
		<header>
			<h2 id="instr-title">AI Instruction</h2>
		</header>
		<section class="preview">
			<span class="preview-label">Selection</span>
			<pre>{preview}</pre>
		</section>
		<section>
			<label for="instr-textarea">Instruction</label>
			<textarea
				id="instr-textarea"
				bind:this={textarea}
				bind:value={instruction}
				rows="6"
				placeholder="e.g. Update this description to match the latest spec"
			></textarea>
		</section>
		<footer>
			<button type="button" onclick={onCancel}>Cancel (Esc)</button>
			<button type="button" class="primary" onclick={submit} disabled={!instruction.trim()}>
				Submit (Cmd/Ctrl+Enter)
			</button>
		</footer>
	</div>
{/if}

<style>
	/* 暗くする層(要件#56 契約 4= `--color-shadow`)。 */
	.backdrop {
		position: fixed;
		inset: 0;
		background-color: var(--color-shadow);
		z-index: 100;
	}

	.dialog {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: 101;
		width: min(640px, calc(100vw - 32px));
		max-height: calc(100vh - 64px);
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 20px;
		background-color: var(--color-bg-raised);
		color: var(--color-text-primary);
		/* 重なりの 1 段(要件#56 契約 4)。 */
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-2);
	}

	header h2 {
		margin: 0 0 4px;
		font-size: 16px;
		font-weight: 600;
	}

	.preview-label {
		font-size: 11px;
		color: var(--color-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.preview pre {
		margin: 4px 0 0;
		padding: 8px 12px;
		background-color: var(--color-bg-hover);
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		max-height: 160px;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}

	label {
		display: block;
		font-size: 12px;
		color: var(--color-text-primary);
		margin-bottom: 4px;
	}

	textarea {
		width: 100%;
		font-family: inherit;
		font-size: var(--text-md);
		padding: 8px;
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
		background-color: var(--color-bg-raised);
		color: var(--color-text-primary);
		resize: vertical;
		box-sizing: border-box;
	}

	textarea::placeholder {
		color: var(--color-text-muted);
	}

	footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	footer button {
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 500;
		padding: 6px 14px;
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
		background-color: var(--color-bg-raised);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	footer button:hover:not(:disabled) {
		background-color: var(--color-bg-hover);
	}

	footer button.primary {
		background-color: var(--color-accent);
		border-color: transparent;
		color: var(--color-on-accent);
	}

	/* 押せる主ボタンのホバーは同じアクセントを少し明るく(色を直書きしない)。 */
	footer button.primary:hover:not(:disabled) {
		background-color: var(--color-accent);
		filter: brightness(1.1);
	}

	footer button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
