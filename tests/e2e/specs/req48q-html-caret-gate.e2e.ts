import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertIpcInterceptionWorks,
	clickExplorerRow,
	emitMenu,
	explorerHasRow,
	installGateRecorder,
	readGateRecord,
	report,
	restoreGateRecorder,
	shot,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Requirement #48 追補q human gate (Issue #774), driven on the webdriver build
 * (docs/requirements/req-48.md「追補q」, 契約1〜3, AC-48-追q (a)〜(c)):
 *
 *   In the html edit surface (requirement #53, a Shadow DOM) a double-click on
 *   a paragraph entered the block edit with the caret at the *start* of the
 *   block, not where the user double-clicked (追補p 契約1 (d) fell through to
 *   its "block start" escape). `document.caretRangeFromPoint` answers a point
 *   inside a shadow tree with a Range retargeted to the host, so the position
 *   never landed inside the block. 2026-10-29, checked in WKWebView:
 *   `document.caretPositionFromPoint(x, y, { shadowRoots: [root] })` returns
 *   the text node inside the shadow tree and the right character; without
 *   `shadowRoots` it, like `caretRangeFromPoint`, answers outside the shadow.
 *   The fix takes the position with `shadowRoots` and puts a collapsed caret
 *   at that character; when that is not possible, the block start as before.
 *
 * Gate (req-48.md「人間ゲート(追補q)」): open `fixtures/edit/774-html-edit-caret.html`,
 * Command + E, double-click in the middle of a word (`w20` of `P01`) → `X`
 * lands inside that word. The same inside bold, a link, a heading, a list item
 * and a table cell. How it is driven here:
 *  - the fixture is copied from the repository into the E2E start root
 *    (`req48q-gate/`), opened from the Explorer, and the surface is brought up
 *    with the `menu_edit` event (menus are not clicked — gate-helpers rule)
 *  - the point is the left quarter of the second character of the word, from
 *    the character's own Range rect inside the shadow tree (real WebKit layout);
 *    what WebKit's own `caretPositionFromPoint(…, { shadowRoots })` says for
 *    that point is recorded as `probe` and must be that character (±1)
 *  - the double-click is a WebDriver pointer action when the Intermediary
 *    Node performs actions and a `dblclick` reaches the page, otherwise a
 *    synthetic `dblclick` with the same client coordinates dispatched on the
 *    element at that point *inside the shadow tree* (the surface listens on
 *    its ShadowRoot; an event dispatched on the host never passes it)
 *  - the caret inside the shadow tree is read, in this order, with
 *    `ShadowRoot.getSelection()` (Chromium only), then
 *    `Selection.getComposedRanges` (WebKit), and when neither can see it, by
 *    typing: `execCommand('insertText', 'X')` (WebKit's own editing) and the
 *    index at which the block's text now differs. Typing is done whenever the
 *    block is editable, so the report always carries where `X` went
 *  - Esc on the block discards the edit (nothing is committed, so leaving the
 *    editor afterwards needs no dialog)
 *
 * Everything read from the page is kept in the report
 * (`$VELLIS_GATE_SHOTS/req48q-report.jsonl`, `[gate]` lines in the CI log).
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const gateDir = path.join(startRoot, 'req48q-gate');
/** The repository fixture (fixtures/edit/README.md, #774) — copied, not edited. */
const fixtureSource = path.join(__dirname, '..', '..', '..', 'fixtures', 'edit', '774-html-edit-caret.html');
const htmlFile = path.join(gateDir, '774-html-edit-caret.html');
const REPORT = 'req48q-report.jsonl';
const HTML_SURFACE = '[data-testid="html-edit-surface"]';

const uri = (p: string) => `file://${p}`;

interface GateCase {
	gate: string;
	label: string;
	/** Leaf block inside the surface (selector inside the ShadowRoot). */
	block: string;
	/** Inline element inside the block the word sits in (null = a bare text node). */
	inner: string | null;
	/** The word to double-click (its first occurrence in the block's text). */
	word: string;
}

/** The gate's items: a paragraph, bold, a link, a heading, a list item, a table cell. */
const GATES: GateCase[] = [
	{ gate: 'q-1', label: 'paragraph middle (#p01, w20)', block: '#p01', inner: null, word: 'w20' },
	{ gate: 'q-2', label: 'inside <strong> (#p02)', block: '#p02', inner: 'strong', word: 'strong' },
	{ gate: 'q-3', label: 'inside <a> (#p02)', block: '#p02', inner: 'a', word: 'link' },
	{ gate: 'q-4', label: 'heading (#h01)', block: '#h01', inner: null, word: 'heading' },
	{ gate: 'q-5', label: 'list item, inside <strong> (#li02)', block: '#li02', inner: 'strong', word: 'w04' },
	{ gate: 'q-6', label: 'table cell (#td01)', block: '#td01', inner: null, word: 'w03' },
];

interface Aim {
	x: number;
	y: number;
	/** Character index (in the block's `textContent`) the point is aimed at: the word's 2nd character. */
	k: number;
	wordStart: number;
	wordEnd: number;
	text: string;
	blockTag: string;
	blockId: string;
	innerTag: string | null;
	/** Rect of the aimed character (viewport px). */
	rect: { left: number; top: number; width: number; height: number };
	/** WebKit's own `caretPositionFromPoint(x, y, { shadowRoots: [shadow] })` for the point, as an offset inside the block (-1 = outside / unavailable). */
	probe: { offset: number; landed: string | null; available: boolean };
	/** Whether `caretRangeFromPoint(x, y)` lands inside the block (expected false: it answers the host side). */
	rangeInsideBlock: boolean;
	error: string | null;
}

interface CaretShape {
	method: 'shadow-getSelection' | 'getComposedRanges' | 'none';
	form: string | null;
	inside: boolean;
	collapsed: boolean;
	start: number;
	end: number;
}

interface Typed {
	ok: boolean;
	text: string | null;
	/** Index at which the block's text now differs from before (-1 = no single `X` was inserted). */
	index: number;
}

interface DoubleClickOutcome {
	route: 'actions' | 'synthetic';
	dblclicks: number;
	actionsError: string | null;
	/** The element the synthetic event was dispatched on (tag#id), null on the actions route. */
	dispatchedOn: string | null;
}

/** The surface is up with the fixture's blocks in it. */
async function surfaceUp(): Promise<boolean> {
	return browser.execute((surfaceSel) => {
		const shadow = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot;
		return !!shadow && shadow.querySelector('#p01') !== null && shadow.querySelector('#td01') !== null;
	}, HTML_SURFACE);
}

/** Expand `req48q-gate/` if its rows are not shown. */
async function ensureGateDirExpanded(): Promise<void> {
	if (await explorerHasRow(uri(htmlFile))) return;
	await waitForExplorerRow(uri(gateDir), { timeout: 20_000, nudgeDir: startRoot, nudgePrefix: 'req48q' });
	await clickExplorerRow(uri(gateDir));
	await waitForExplorerRow(uri(htmlFile), { timeout: 15_000 });
}

/** Open the fixture (rendered html view) from the Explorer. */
async function openHtml(): Promise<void> {
	await ensureGateDirExpanded();
	await clickExplorerRow(uri(htmlFile));
	await browser.waitUntil(
		async () =>
			browser.execute(
				(surfaceSel) => document.querySelector('iframe.html-viewer') !== null || document.querySelector(surfaceSel) !== null,
				HTML_SURFACE,
			),
		{ timeout: 15_000, timeoutMsg: '774-html-edit-caret.html did not open' },
	);
	await browser.pause(300);
}

/** Command + E (the menu event) brings the html edit surface (Shadow DOM) up. */
async function enterSurface(): Promise<void> {
	if (await surfaceUp()) return;
	await emitMenu('menu_edit');
	await browser.waitUntil(surfaceUp, { timeout: 10_000, timeoutMsg: 'the html edit surface did not appear' });
	await browser.pause(300);
}

/** What this WebKit offers for reading a caret inside a shadow tree (for the report). */
async function surfaceEnv(): Promise<Record<string, unknown>> {
	return browser.execute((surfaceSel) => {
		const shadow = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot;
		const doc = document as unknown as Record<string, unknown>;
		const selProto = Selection.prototype as unknown as Record<string, unknown>;
		const shadowProto = ShadowRoot.prototype as unknown as Record<string, unknown>;
		return {
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			userAgent: navigator.userAgent,
			caretRangeFromPoint: typeof doc.caretRangeFromPoint,
			caretPositionFromPoint: typeof doc.caretPositionFromPoint,
			getComposedRanges: typeof selProto.getComposedRanges,
			shadowGetSelection: typeof shadowProto.getSelection,
			shadowElementFromPoint: typeof shadowProto.elementFromPoint,
			surfaceUp: !!shadow,
			blocks: shadow ? shadow.querySelectorAll('[data-vellis-hid]').length : 0,
		};
	}, HTML_SURFACE);
}

/**
 * Aim at the 2nd character of `word` inside `block` (`inner`): scroll the block
 * into view, take that character's rect from a Range inside the shadow tree,
 * and record what WebKit's own `caretPositionFromPoint` says for the point.
 */
async function aimAt(c: GateCase): Promise<Aim> {
	return browser.execute(
		(surfaceSel, blockSel, innerSel, word) => {
			const out: Aim = {
				x: -1,
				y: -1,
				k: -1,
				wordStart: -1,
				wordEnd: -1,
				text: '',
				blockTag: '',
				blockId: '',
				innerTag: null,
				rect: { left: 0, top: 0, width: 0, height: 0 },
				probe: { offset: -1, landed: null, available: false },
				rangeInsideBlock: false,
				error: null,
			};
			const shadow = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot;
			const block = shadow?.querySelector<HTMLElement>(blockSel) ?? null;
			if (!shadow || !block) {
				out.error = `block ${blockSel} not in the surface`;
				return out;
			}
			const text = block.textContent ?? '';
			out.text = text;
			out.blockTag = block.tagName.toLowerCase();
			out.blockId = block.id;
			const wordStart = text.indexOf(word);
			if (wordStart < 0) {
				out.error = `word '${word}' not in ${blockSel}`;
				return out;
			}
			out.wordStart = wordStart;
			out.wordEnd = wordStart + word.length;
			const k = wordStart + 1;
			out.k = k;
			const locate = (offset: number): [Text, number] | null => {
				const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
				let seen = 0;
				let last: Text | null = null;
				while (walker.nextNode()) {
					const t = walker.currentNode as Text;
					last = t;
					if (offset <= seen + t.data.length) return [t, offset - seen];
					seen += t.data.length;
				}
				return last ? [last, last.data.length] : null;
			};
			const a = locate(k);
			const b = locate(k + 1);
			if (!a || !b) {
				out.error = 'no text node for the aimed character';
				return out;
			}
			const holder = a[0].parentElement;
			out.innerTag = holder && holder !== block ? holder.tagName.toLowerCase() : null;
			if (innerSel && (!holder || holder.tagName.toLowerCase() !== innerSel)) {
				out.error = `aimed character is in <${holder?.tagName.toLowerCase() ?? '?'}>, not <${innerSel}>`;
				return out;
			}
			block.scrollIntoView({ block: 'center' });
			const range = document.createRange();
			range.setStart(a[0], a[1]);
			range.setEnd(b[0], b[1]);
			const rects = range.getClientRects();
			const r = rects.length > 0 ? rects[0]! : range.getBoundingClientRect();
			out.rect = { left: r.left, top: r.top, width: r.width, height: r.height };
			if (r.width <= 0 || r.height <= 0) {
				out.error = 'the aimed character has no rect';
				return out;
			}
			out.x = r.left + r.width * 0.25;
			out.y = r.top + r.height / 2;
			const offsetOf = (node: Node, offset: number) => {
				const probe = document.createRange();
				probe.selectNodeContents(block);
				probe.setEnd(node, offset);
				return probe.toString().length;
			};
			const describe = (node: Node | null) => {
				if (!node) return null;
				const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
				return el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` : node.nodeName;
			};
			const doc = document as unknown as {
				caretPositionFromPoint?: (x: number, y: number, options?: { shadowRoots?: ShadowRoot[] }) => { offsetNode: Node; offset: number } | null;
			};
			if (typeof doc.caretPositionFromPoint === 'function') {
				out.probe.available = true;
				try {
					const pos = doc.caretPositionFromPoint(out.x, out.y, { shadowRoots: [shadow] });
					if (pos) {
						out.probe.landed = describe(pos.offsetNode);
						if (block.contains(pos.offsetNode)) out.probe.offset = offsetOf(pos.offsetNode, pos.offset);
					}
				} catch (e) {
					out.probe.landed = `error: ${String(e)}`;
				}
			}
			const legacy = document.caretRangeFromPoint(out.x, out.y);
			out.rangeInsideBlock = !!legacy && block.contains(legacy.startContainer);
			return out;
		},
		HTML_SURFACE,
		c.block,
		c.inner,
		c.word,
	);
}

/**
 * A real double-click at viewport (x, y): a WebDriver pointer action (two
 * down/up pairs) and, when no `dblclick` reached the page, a synthetic
 * `dblclick` MouseEvent with the same client coordinates dispatched on the
 * element at that point inside the shadow tree.
 */
async function realDoubleClick(x: number, y: number): Promise<DoubleClickOutcome> {
	await browser.execute(() => {
		const w = window as unknown as { __req48qDbl?: number; __req48qDblListener?: EventListener };
		w.__req48qDbl = 0;
		if (!w.__req48qDblListener) {
			w.__req48qDblListener = () => {
				w.__req48qDbl = (w.__req48qDbl ?? 0) + 1;
			};
			document.addEventListener('dblclick', w.__req48qDblListener, true);
		}
	});
	let actionsError: string | null = null;
	try {
		await browser
			.action('pointer', { parameters: { pointerType: 'mouse' } })
			.move({ x: Math.round(x), y: Math.round(y), origin: 'viewport' })
			.down()
			.up()
			.pause(60)
			.down()
			.up()
			.perform();
	} catch (e) {
		actionsError = String(e);
	}
	await browser.pause(200);
	let dblclicks = await browser.execute(() => (window as unknown as { __req48qDbl?: number }).__req48qDbl ?? 0);
	if (dblclicks > 0) return { route: 'actions', dblclicks, actionsError, dispatchedOn: null };
	const dispatchedOn = await browser.execute(
		(surfaceSel, px, py) => {
			const host = document.querySelector<HTMLElement>(surfaceSel);
			const shadow = host?.shadowRoot ?? null;
			const inner = shadow ? shadow.elementFromPoint(px, py) : null;
			const el = inner ?? host ?? document.body;
			el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, clientX: px, clientY: py, detail: 2, button: 0 }));
			return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`;
		},
		HTML_SURFACE,
		x,
		y,
	);
	await browser.pause(200);
	dblclicks = await browser.execute(() => (window as unknown as { __req48qDbl?: number }).__req48qDbl ?? 0);
	return { route: 'synthetic', dblclicks, actionsError, dispatchedOn };
}

/** The editable block inside the surface (tag#id and its text), or null. */
async function editableBlock(): Promise<{ tag: string; id: string; text: string } | null> {
	return browser.execute((surfaceSel) => {
		const el = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');
		return el ? { tag: el.tagName.toLowerCase(), id: el.id, text: el.textContent ?? '' } : null;
	}, HTML_SURFACE);
}

/**
 * The caret inside the surface's editable block, read with
 * `ShadowRoot.getSelection()` when it exists, else `Selection.getComposedRanges`
 * (dictionary form first, then the older rest-args form). `method: 'none'`
 * when neither can see into the shadow tree.
 */
async function measureCaret(): Promise<CaretShape> {
	return browser.execute((surfaceSel) => {
		const out: CaretShape = { method: 'none', form: null, inside: false, collapsed: false, start: -1, end: -1 };
		const shadow = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot;
		const el = shadow?.querySelector<HTMLElement>('[contenteditable="true"]');
		if (!shadow || !el) return out;
		const offsetOf = (node: Node, offset: number) => {
			const probe = document.createRange();
			probe.selectNodeContents(el);
			probe.setEnd(node, offset);
			return probe.toString().length;
		};
		const take = (r: { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number; collapsed?: boolean } | null) => {
			if (!r || !el.contains(r.startContainer) || !el.contains(r.endContainer)) return false;
			out.inside = true;
			out.start = offsetOf(r.startContainer, r.startOffset);
			out.end = offsetOf(r.endContainer, r.endOffset);
			out.collapsed = r.collapsed ?? (r.startContainer === r.endContainer && r.startOffset === r.endOffset);
			return true;
		};
		const shadowSel = (shadow as unknown as { getSelection?: () => Selection | null }).getSelection?.();
		if (shadowSel && shadowSel.rangeCount > 0) {
			out.method = 'shadow-getSelection';
			if (take(shadowSel.getRangeAt(0))) return out;
		}
		const sel = window.getSelection() as unknown as
			| (Selection & { getComposedRanges?: (...args: unknown[]) => StaticRange[] })
			| null;
		if (sel && typeof sel.getComposedRanges === 'function') {
			out.method = 'getComposedRanges';
			let ranges: StaticRange[] = [];
			try {
				ranges = sel.getComposedRanges({ shadowRoots: [shadow] });
				out.form = 'options';
			} catch {
				ranges = [];
			}
			if (!(ranges.length > 0 && take(ranges[0]!))) {
				try {
					ranges = sel.getComposedRanges(shadow);
					out.form = 'rest';
					if (ranges.length > 0) take(ranges[0]!);
				} catch {
					// neither form; typing decides
				}
			}
		}
		return out;
	}, HTML_SURFACE);
}

/** Type `X` with WebKit's own editing and find where it went in the editable block. */
async function typeX(before: string): Promise<Typed> {
	const ok = await browser.execute(() => document.execCommand('insertText', false, 'X'));
	await browser.pause(150);
	const after = await editableBlock();
	const text = after?.text ?? null;
	let index = -1;
	if (text !== null && text.length === before.length + 1) {
		index = 0;
		while (index < before.length && text[index] === before[index]) index++;
		if (text[index] !== 'X') index = -1;
	}
	return { ok, text, index };
}

/** Esc on the editable block discards the block edit; true when the block's text is back to `original` and nothing is editable. */
async function discardBlock(original: string | null): Promise<boolean | null> {
	const r = await browser.execute(
		(surfaceSel, orig) => {
			const shadow = document.querySelector<HTMLElement>(surfaceSel)?.shadowRoot;
			const el = shadow?.querySelector<HTMLElement>('[contenteditable="true"]');
			if (!shadow || !el) return null;
			el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }));
			const back = orig === null || Array.from(shadow.querySelectorAll<HTMLElement>('[data-vellis-hid]')).some((b) => b.textContent === orig);
			return back && shadow.querySelector('[contenteditable="true"]') === null;
		},
		HTML_SURFACE,
		original,
	);
	await browser.pause(100);
	return r;
}

async function clearSelection(): Promise<void> {
	await browser.execute(() => window.getSelection()?.removeAllRanges());
}

/** Leave the editor with Done (nothing committed → no dialog). */
async function leaveSurface(): Promise<void> {
	await discardBlock(null);
	await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="edit-done"]')?.click());
	await browser.waitUntil(
		async () =>
			browser.execute(
				(surfaceSel) => document.querySelector(surfaceSel) === null && document.querySelector('[data-testid="edit-done"]') === null,
				HTML_SURFACE,
			),
		{ timeout: 5_000, timeoutMsg: 'could not leave the html edit surface' },
	);
}

/** Screenshot that must not fail a gate when the display is off (req-69 追補a). */
async function safeShot(name: string): Promise<string | null> {
	try {
		return await shot(name);
	} catch (e) {
		report(REPORT, { gate: 'shot-failed', name, error: String(e) });
		return null;
	}
}

describe('Requirement #48 追補q human gate (html edit surface: the caret goes where the user double-clicked)', () => {
	before(async () => {
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		fs.rmSync(gateDir, { recursive: true, force: true });
		fs.mkdirSync(gateDir, { recursive: true });
		fs.copyFileSync(fixtureSource, htmlFile);
		await openHtml();
		await enterSurface();
		const env = await surfaceEnv();
		report(REPORT, { gate: '48q-env', ...env });
	});

	afterEach(async () => {
		const problems: Record<string, string> = {};
		try {
			await discardBlock(null);
		} catch (err) {
			problems.discard = String(err);
		}
		if (fs.existsSync(gateDir) && fs.readFileSync(htmlFile, 'utf8') !== fs.readFileSync(fixtureSource, 'utf8')) {
			fs.copyFileSync(fixtureSource, htmlFile);
			problems.fileChanged = 'the fixture on disk had changed; restored';
		}
		if (Object.keys(problems).length > 0) report(REPORT, { gate: '48q-after-each', ...problems, dialogs: (await readGateRecord()).dialogs });
	});

	after(async () => {
		try {
			await leaveSurface();
		} catch (err) {
			report(REPORT, { gate: '48q-after', leave: String(err), dialogs: (await readGateRecord()).dialogs });
		}
		await restoreGateRecorder();
		fs.rmSync(gateDir, { recursive: true, force: true });
		for (const name of fs.readdirSync(startRoot)) {
			if (name.startsWith('req48q-')) fs.rmSync(path.join(startRoot, name), { recursive: true, force: true });
		}
	});

	for (const c of GATES) {
		it(`gate ${c.gate}: ${c.label} — a real double-click on the 2nd character of '${c.word}' → that block editable, a collapsed caret at that character, X lands inside the word`, async () => {
			await enterSurface();
			const aim = await aimAt(c);
			await clearSelection();
			const click = aim.error ? null : await realDoubleClick(aim.x, aim.y);
			let editable: { tag: string; id: string; text: string } | null = null;
			if (click) {
				try {
					await browser.waitUntil(
						async () => {
							editable = await editableBlock();
							return editable !== null;
						},
						{ timeout: 5_000, timeoutMsg: 'no block became editable after the double-click' },
					);
				} catch {
					editable = await editableBlock();
				}
			}
			const caret = editable ? await measureCaret() : null;
			const typed = editable ? await typeX(aim.text) : null;
			const restored = editable ? await discardBlock(aim.text) : null;
			await safeShot(`req48q-gate-${c.gate}`);
			report(REPORT, {
				gate: `48q-${c.gate}`,
				case: c,
				aim: { ...aim, text: aim.text.slice(0, 60) },
				click,
				editable,
				caret,
				typed: typed ? { ...typed, text: typed.text?.slice(Math.max(0, aim.k - 8), aim.k + 9) ?? null } : null,
				restored,
			});

			// the aim must resolve
			expect(aim.error).toBeNull();
			// document.caretPositionFromPoint exists in this WebKit (契約1 needs it)
			expect(aim.probe.available).toBe(true);
			// WebKit's own caretPositionFromPoint with shadowRoots lands inside the block
			expect(aim.probe.offset).toBeGreaterThanOrEqual(0);
			// the probe is the aimed character (or its right edge)
			expect(aim.probe.offset).toBeGreaterThanOrEqual(aim.k);
			// the probe is the aimed character (or its right edge)
			expect(aim.probe.offset).toBeLessThanOrEqual(aim.k + 1);
			// the double-click was sent
			expect(click).not.toBeNull();
			// a dblclick reached the page
			expect(click!.dblclicks).toBeGreaterThan(0);
			// the double-clicked block became editable
			expect(editable).not.toBeNull();
			// only the double-clicked block is editable
			expect(`${editable!.tag}#${editable!.id}`).toBe(`${aim.blockTag}#${aim.blockId}`);

			// The caret as the selection APIs see it (when they can see into the shadow tree).
			if (caret && caret.inside) {
				// <caret.method>: the caret is collapsed (the word is not selected)
				expect(caret.collapsed).toBe(true);
				// <caret.method>: the caret is at the double-clicked character
				expect(caret.start).toBe(aim.probe.offset);
			}
			// The caret as typing shows it (the gate's own wording: `X` lands inside the word).
			// execCommand insertText was accepted
			expect(typed!.ok).toBe(true);
			// exactly one X was inserted and found
			expect(typed!.index).toBeGreaterThanOrEqual(0);
			// X went in at the double-clicked character
			expect(typed!.index).toBe(aim.probe.offset);
			// X is inside the word (after its first character)
			expect(typed!.index).toBeGreaterThan(aim.wordStart);
			// X is inside the word (before its last character)
			expect(typed!.index).toBeLessThan(aim.wordEnd);
			// Esc discarded the block edit and put the text back
			expect(restored).toBe(true);
		});
	}
});
