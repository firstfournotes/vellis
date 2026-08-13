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
			<h2 id="instr-title">AI 修正指示</h2>
		</header>
		<section class="preview">
			<span class="preview-label">対象範囲</span>
			<pre>{preview}</pre>
		</section>
		<section>
			<label for="instr-textarea">指示内容</label>
			<textarea
				id="instr-textarea"
				bind:this={textarea}
				bind:value={instruction}
				rows="6"
				placeholder="例: この説明を最新仕様に合わせて修正してください"
			></textarea>
		</section>
		<footer>
			<button type="button" onclick={onCancel}>取り消し (Esc)</button>
			<button type="button" class="primary" onclick={submit} disabled={!instruction.trim()}>
				送信 (Cmd/Ctrl+Enter)
			</button>
		</footer>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background-color: rgba(0, 0, 0, 0.4);
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
		background-color: #ffffff;
		border-radius: 8px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.2);
	}

	header h2 {
		margin: 0 0 4px;
		font-size: 16px;
		font-weight: 600;
	}

	.preview-label {
		font-size: 11px;
		color: #6b7280;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.preview pre {
		margin: 4px 0 0;
		padding: 8px 12px;
		background-color: #f3f4f6;
		border-radius: 4px;
		font-size: 12px;
		max-height: 160px;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}

	label {
		display: block;
		font-size: 12px;
		color: #374151;
		margin-bottom: 4px;
	}

	textarea {
		width: 100%;
		font-family: inherit;
		font-size: 13px;
		padding: 8px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		resize: vertical;
		box-sizing: border-box;
	}

	footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	footer button {
		font-size: 12px;
		padding: 6px 14px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background-color: #ffffff;
		color: #374151;
		cursor: pointer;
	}

	footer button:hover:not(:disabled) {
		background-color: #f3f4f6;
	}

	footer button.primary {
		background-color: #2563eb;
		border-color: #2563eb;
		color: #ffffff;
	}

	footer button.primary:hover:not(:disabled) {
		background-color: #1d4ed8;
	}

	footer button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
