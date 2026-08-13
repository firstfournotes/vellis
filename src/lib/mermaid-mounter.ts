/**
 * `MermaidMounter` — Webview-side post-mount enhancement that turns
 * `<div class="vellis-mermaid" data-mermaid-source>` placeholders (produced
 * by `rehype-vellis-mermaid`) into rendered Mermaid SVG.
 *
 * Spec: `docs/mermaid.md` §6.
 *
 * Behaviour:
 *  - Lazy-imports the `mermaid` module on first need; cached for subsequent
 *    documents (`docs/mermaid.md` §6.3).  Documents without a mermaid block
 *    never trigger `import('mermaid')` (acceptance criterion §9.4 #3).
 *  - Initialises mermaid with `securityLevel: 'strict'` so its built-in
 *    DOMPurify scrubs SVG output before we insert it (`docs/mermaid.md` §8.1).
 *  - Renders placeholders sequentially: mermaid uses an off-screen DOM
 *    container internally and concurrent renders interleave (§6.4).
 *  - Tags rendered nodes with `vellis-mermaid-rendered` and skips them on
 *    subsequent calls so re-running on the same DOM is a no-op.
 *  - On render failure, swaps the placeholder body for an inline error UI
 *    that keeps the diagram source visible inside `<details>` (§6.5).
 */

const RENDERED_CLASS = 'vellis-mermaid-rendered';
const ERROR_CLASS = 'vellis-mermaid-error';
const PLACEHOLDER_SELECTOR = `.vellis-mermaid:not(.${RENDERED_CLASS})`;

type MermaidModule = typeof import('mermaid');

let mermaidPromise: Promise<MermaidModule> | null = null;

function loadMermaid(): Promise<MermaidModule> {
	if (!mermaidPromise) {
		mermaidPromise = import('mermaid').then((mod) => {
			mod.default.initialize({
				startOnLoad: false,
				securityLevel: 'strict',
				theme: 'default',
				fontFamily: 'inherit',
			});
			return mod;
		});
	}
	return mermaidPromise;
}

export interface MountOptions {
	/**
	 * Optional pre-loaded mermaid module. When provided, `loadMermaid` is
	 * bypassed entirely. Used by tests to avoid the ESM dynamic-import path
	 * (`docs/mermaid.md` §9.2).
	 */
	mermaid?: MermaidModule;
}

let renderCounter = 0;

function nextRenderId(el: HTMLElement): string {
	const nodeId = el.dataset.vellisNodeId;
	const seq = ++renderCounter;
	const suffix = nodeId ? `${nodeId}-${seq}` : `auto-${seq}`;
	return `vellis-mm-${suffix}`;
}

function renderError(el: HTMLElement, message: string, source: string): void {
	el.classList.add(RENDERED_CLASS, ERROR_CLASS);
	const details = document.createElement('details');
	const summary = document.createElement('summary');
	summary.textContent = 'Mermaid 図のレンダーに失敗しました';
	const errorPre = document.createElement('pre');
	errorPre.className = 'vellis-mermaid-error-message';
	errorPre.textContent = message;
	const sourcePre = document.createElement('pre');
	sourcePre.className = 'vellis-mermaid-fallback';
	sourcePre.textContent = source;
	details.append(summary, errorPre, sourcePre);
	el.replaceChildren(details);
}

async function renderOne(
	mermaid: MermaidModule,
	el: HTMLElement,
): Promise<void> {
	const source = el.dataset.mermaidSource ?? '';
	if (source.trim().length === 0) {
		renderError(el, '空の Mermaid ブロックです。', source);
		return;
	}
	try {
		const renderId = nextRenderId(el);
		const { svg, bindFunctions } = await mermaid.default.render(renderId, source);
		// Mermaid's SVG output is already sanitized by DOMPurify (we set
		// `securityLevel: 'strict'`). The Tauri CSP `script-src 'self'`
		// is the second line of defence — see `docs/mermaid.md` §8.
		el.innerHTML = svg;
		bindFunctions?.(el);
		el.classList.add(RENDERED_CLASS);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		renderError(el, msg, source);
	}
}

/**
 * Find every unrendered Mermaid placeholder under `root` and render it.
 * Safe to call on every document update — already-rendered nodes are
 * tagged with `vellis-mermaid-rendered` and skipped.
 */
export async function mountMermaid(
	root: ParentNode,
	opts: MountOptions = {},
): Promise<void> {
	const placeholders = root.querySelectorAll<HTMLElement>(PLACEHOLDER_SELECTOR);
	if (placeholders.length === 0) return;

	let mermaid: MermaidModule;
	try {
		mermaid = opts.mermaid ?? (await loadMermaid());
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		for (const el of placeholders) {
			const source = el.dataset.mermaidSource ?? '';
			renderError(el, `mermaid のロードに失敗しました: ${msg}`, source);
		}
		// Reset the failed promise so a future mount can retry.
		mermaidPromise = null;
		return;
	}

	for (const el of placeholders) {
		await renderOne(mermaid, el);
	}
}

/** Test-only hook: reset the lazy-import cache so each test starts fresh. */
export function __resetMermaidMounterForTests(): void {
	mermaidPromise = null;
	renderCounter = 0;
}
