/**
 * Copy planning for the rendered Markdown body (requirement #32).
 *
 * Requirement #32 replaces the requirement #13 contract: ⌘C over the rendered
 * body copies **what the user sees** — the visible text of the DOM selection —
 * and nothing else.  Resolving the selection back to the Markdown source
 * (notation markers, node-level fallback that widened a partial selection to
 * the whole block) is deliberately gone from the copy path; that was the cause
 * of backlog #20 / #21 / #22 / #27 and #71.
 *
 * The absence of `SourceIndex` / `source` in `planSelectionCopy`'s signature is
 * itself part of contract ①: there is no way for this path to reach the
 * original Markdown.  The source-resolution helpers in `../markdown/selection`
 * (`resolveSelectionToMarkdown`, `buildAnchor`) stay untouched — the mark
 * feature (ai-collab) is built on them (contract ④).
 *
 * Copying the full Markdown source is a separate, unchanged feature: the
 * toolbar's 「マークダウンをコピー」 button (contract ⑤).
 */

/**
 * Decide what a `copy` event over the rendered body should put on the
 * clipboard.
 *
 * @returns the plain-text string the handler should write (after
 *   `e.preventDefault()` + `clipboardData.setData('text/plain', …)`), or
 *   `null` to leave the event alone and let the browser copy as it normally
 *   would.
 *
 * `null` is returned when there is nothing the user actually selected as text:
 * a collapsed selection (caret / no selection at all) and — out of scope for
 * requirement #32, so handed back to the browser rather than guessed at — a
 * non-collapsed selection that carries no visible text (an image on its own,
 * say), where forcing an empty `text/plain` would only destroy the flavours
 * the browser would otherwise have supplied.
 */
export function planSelectionCopy(sel: Selection): string | null {
	if (sel.isCollapsed || sel.rangeCount === 0) return null;

	// `Selection.toString()` is the visible text of the selection, straight
	// from the engine: entity references already resolved, escapes already
	// applied, Shiki's highlight spans and block boundaries already flattened.
	// That is exactly the contract, so it is returned verbatim — no trimming,
	// no normalisation, no re-derivation from the DOM.
	const text = sel.toString();
	return text === '' ? null : text;
}
