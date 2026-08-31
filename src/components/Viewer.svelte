<script lang="ts">
	import { tick } from 'svelte';
	import { invoke } from '$lib/ipc';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import { isExternal } from '$lib/uri';
	import { sha256 } from '$lib/annotation';
	import { mountMermaid } from '$lib/mermaid-mounter';
	import { planSelectionCopy } from '$lib/copy-selection';
	import { DEFAULT_ZOOM } from '$lib/zoom';
	import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
	import type { SourceIndex } from '../markdown/types';
	import { buildAnchor, type BuiltAnchor } from '../markdown/selection';

	let {
		document,
		html,
		index,
		onRequestAddMark,
		onToggleMarks,
		marksOpen,
		zoom = DEFAULT_ZOOM,
	}: {
		document: DocumentPayload;
		html: string;
		index: SourceIndex | null;
		onRequestAddMark: (anchor: BuiltAnchor) => void;
		onToggleMarks: () => void;
		marksOpen: boolean;
		/**
		 * 本文の表示倍率(パーセント・要件#36)。非対象の表示(バイナリの
		 * プレースホルダ)には既定=等倍が渡る。
		 */
		zoom?: number;
	} = $props();

	let copyLabel = $state('マークダウンをコピー');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let bodyEl: HTMLDivElement | undefined = $state();

	// After every html prop change, look for `.vellis-mermaid` placeholders
	// in the rendered body and have the mounter replace them with SVG.
	// Mermaid is dynamic-imported on first need; documents without mermaid
	// blocks never trigger the import (`docs/mermaid.md` §6.3 / §9.4 #3).
	$effect(() => {
		// Re-run whenever the html prop changes.
		void html;
		tick().then(() => {
			if (bodyEl) void mountMermaid(bodyEl);
		});
	});

	async function copyAllAsMarkdown() {
		await navigator.clipboard.writeText(document.content);
		copyLabel = 'コピーしました';
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			copyLabel = 'マークダウンをコピー';
		}, 1000);
	}

	async function addInstructionFromSelection() {
		if (!index) {
			alert('レンダリング中です。少し待ってから再度お試しください。');
			return;
		}
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) {
			alert('本文の範囲を選択してから「指示を追加」を押してください。');
			return;
		}
		const fileHash = await sha256(document.content);
		const anchor = buildAnchor(sel, index, document.content, fileHash);
		if (!anchor) {
			alert('選択範囲を解決できません。レンダー範囲内で選択してください。');
			return;
		}
		onRequestAddMark(anchor);
	}

	function handleCopy(e: ClipboardEvent) {
		// Requirement #32: copy exactly the visible text of the selection.
		// The Markdown-source resolution that used to run here (requirement
		// #13 / copy-original-markdown.md §B-3) is gone from the copy path —
		// it widened partial selections to whole blocks and reintroduced
		// notation markers (backlog #20-#22, #27, #71).  `index` is not
		// consulted at all any more; it stays for mark creation (buildAnchor).
		const sel = window.getSelection();
		if (!sel) return;
		const text = planSelectionCopy(sel);
		if (text === null) return; // browser default (collapsed selection etc.)
		e.preventDefault();
		e.clipboardData?.setData('text/plain', text);
	}

	async function handleClick(e: MouseEvent) {
		const target = (e.target as HTMLElement).closest('a');
		if (!target) return;
		const href = target.getAttribute('href');
		if (!href) return;

		// External links (http/https/mailto/tel) are delegated to the OS.
		if (isExternal(href)) {
			e.preventDefault();
			openUrl(href);
			return;
		}

		// Internal links (data-vellis-link): .md files navigate within Viewer.
		if (target.hasAttribute('data-vellis-link')) {
			e.preventDefault();
			if (/\.(md|markdown|mdx)$/i.test(href)) {
				if (e.shiftKey) {
					await invoke('new_window', { path: href, root: windowState.root });
				} else {
					const doc = await invoke<DocumentPayload>('open_document', { uri: href });
					windowState.setDocument(doc);
				}
			}
			// Non-md files (PDF, etc.) are noop in Phase 1.
		}
	}
</script>

<article class="viewer">
	<header class="viewer-toolbar">
		<button
			type="button"
			class="toolbar-button"
			title="文書全体のマークダウン原文をクリップボードにコピー"
			onclick={copyAllAsMarkdown}
		>
			{copyLabel}
		</button>
		<button
			type="button"
			class="toolbar-button"
			title="選択範囲に AI 指示を追加 (ai-collab)"
			onclick={addInstructionFromSelection}
		>
			指示を追加
		</button>
		<button
			type="button"
			class="toolbar-button"
			class:active={marksOpen}
			title="マーク一覧サイドバーを開閉"
			onclick={onToggleMarks}
			aria-pressed={marksOpen}
		>
			マーク一覧
		</button>
	</header>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<!--
		要件#36: ズームは本文コンテナだけに掛ける。`zoom` は `transform: scale` と
		違ってレイアウトごと拡大するので、本文中の画像・表・コードブロック・
		mermaid 図が一体で拡縮しつつ、行はウインドウ幅で折り返し直される
		(要件#20 の「幅はウインドウに追従」がそのまま生きる)。ツールバーは
		外にあるので UI の大きさは変わらない。等倍のときは宣言そのものを出さない
		— ズームを入れる前と同じ DOM に戻す(srcdoc 側の `zoomStyleTag` と同じ)。
	-->
	<div
		class="markdown-body"
		style:zoom={zoom === DEFAULT_ZOOM ? null : `${zoom}%`}
		bind:this={bodyEl}
		onclick={handleClick}
		oncopy={handleCopy}
	>
		{@html html}
	</div>
</article>

<style>
	.viewer {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		min-width: 0;
		background-color: #ffffff;
	}

	.viewer-toolbar {
		position: sticky;
		top: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		background-color: #ffffff;
		border-bottom: 1px solid #e5e7eb;
	}

	.toolbar-button {
		font-size: 12px;
		padding: 4px 10px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background-color: #f9fafb;
		color: #374151;
		cursor: pointer;
	}

	.toolbar-button:hover {
		background-color: #f3f4f6;
	}

	.toolbar-button.active {
		background-color: #dbeafe;
		border-color: #93c5fd;
		color: #1e40af;
	}
</style>
