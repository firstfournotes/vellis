import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertIpcInterceptionWorks,
	clearCapturedIpc,
	clickExplorerRow,
	emitMenu,
	explorerHasRow,
	installGateRecorder,
	readCapturedIpc,
	readGateRecord,
	report,
	restoreGateRecorder,
	setIpcCapture,
	shot,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Requirement #48 追補r human gate (Issue #767), driven on the webdriver build
 * (docs/requirements/req-48.md「追補r」, 契約1〜7, AC-48-追r (a)〜(f)):
 *
 *   In the source editor (`<pre class="vellis-plaintext" contenteditable>`,
 *   `white-space: pre-wrap`) WebKit treats the document's final `\n` as a
 *   placeholder for the empty last line: Return at the end of the last line
 *   followed by a character drops it (`abc\n` → `abc\nx`), Return alone at the
 *   end of a document without a final newline adds one too many (`abc` →
 *   `abc\n\n`). The fix keeps one invisible `\n` (a sentinel) at the end of the
 *   `<pre>` — its content is "source + `\n`" — takes the buffer without it,
 *   and puts it back when WebKit eats it.
 *
 * The data is the same as the human gate's (`fixtures/edit/767-*`, see
 * `fixtures/edit/README.md`); the files are copied into a gate directory and
 * the originals are never written.
 *
 * How each step is driven (gate-helpers rules: menus are events, nothing is
 * clicked natively):
 *  - Return is a synthetic `keydown` on the `<pre>`, which the product turns into
 *    WebKit's `insertLineBreak` (追補n). Typing a character is
 *    `document.execCommand('insertText')` — WebKit's InsertTextCommand. Whether
 *    that command removes the placeholder the way a real key does is exactly
 *    what this gate finds out, so every step's `textContent` goes into the
 *    report.
 *  - Paste is a `ClipboardEvent('paste')` with a `DataTransfer` (追補n).
 *  - Command + S is `menu_save`; the file is compared byte for byte.
 *  - Command + Z is `document.execCommand('undo')` (the menu's undo manager).
 *  - Edit is `menu_edit` (Command + E).
 *
 * Gate items (AC-48-追r):
 *  - r-1 (a)  `abc`: Return at the end → save → `abc\n`.
 *  - r-2 (b)  `abc\n`: Return at the end of `abc` → `x` → save → `abc\nx\n`.
 *  - r-3 (c)  open `abc\n`, `abc`, the CRLF file, do nothing, Command + S and
 *             Done: nothing is asked, the bytes are unchanged, the editor shows
 *             exactly one sentinel.
 *  - r-4 (d)  `abc`: paste `one\ntwo\n` at the end → save → `abcone\ntwo\n`.
 *  - r-5 (e)  the three-line file: Return in the middle of `second line` → `x`,
 *             and at the end of `third line` → `x`; the CRLF file: Return at the
 *             end of `third line` → `x` (the final `\r\n` stays; the inserted
 *             break is LF — README: aligning it to CRLF is another issue); the
 *             Markdown file: Command + E → Return at the end of the last line →
 *             `x` → the final newline stays.
 *  - r-6 (e)  undo after Return at the end of `abc`: the editor is back to the
 *             sentinel alone, Done asks nothing, the file is untouched.
 *  - r-7 (f)  the file changes on disk while the (clean) editor is open: the
 *             new text is shown with one sentinel.
 *
 * Everything read from the page is kept in the report
 * (`$VELLIS_GATE_SHOTS/req48r-report.jsonl`, `[gate]` lines in the CI log).
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const gateDir = path.join(startRoot, 'req48r-gate');
/** The human gate's data (fixtures/edit/README.md「#767」). Read, never written. */
const editFixtures = path.join(__dirname, '..', '..', '..', 'fixtures', 'edit');
const REPORT = 'req48r-report.jsonl';
const BODY = 'article.viewer .markdown-body';
const EDITOR = `${BODY} pre.vellis-plaintext[contenteditable="true"]`;

/** The fixtures and the bytes they must hold (fixtures/edit/README.md). */
const FIXTURES = {
	a: { name: '767-a-ends-with-newline.txt', content: 'abc\n' },
	b: { name: '767-b-no-final-newline.txt', content: 'abc' },
	c: { name: '767-c-three-lines.txt', content: 'first line\nsecond line\nthird line\n' },
	d: { name: '767-d-crlf.txt', content: 'first line\r\nsecond line\r\nthird line\r\n' },
	e: { name: '767-e-markdown.md', content: '# Trailing newline\n\nThe last line of this Markdown file ends with a newline.\n' },
	/** Not in fixtures/edit: a document that is one newline (契約8, the 4th case). */
	f: { name: 'req48r-newline-only.txt', content: '\n' },
} as const;
type FixtureKey = keyof typeof FIXTURES;
/** The keys whose file is the human gate's data in fixtures/edit (checked byte for byte). */
const FROM_EDIT: FixtureKey[] = ['a', 'b', 'c', 'd', 'e'];

const MD_HEADING = 'Trailing newline';
/** The sentinel: the editor shows "source + SENTINEL" (契約1). */
const SENTINEL = '\n';
/** End of `abc` (= the end of the last line of `abc\n`, before its `\n`). */
const END_ABC = 3;

const uri = (p: string) => `file://${p}`;
const gateFile = (k: FixtureKey) => path.join(gateDir, FIXTURES[k].name);

interface PreSnapshot {
	editing: boolean;
	text: string | null;
	children: number;
	hasDivOrBr: boolean;
	caret: number;
	/** `\n` count of `text` (-1 without a pre). */
	lf: number;
}

interface EventOutcome extends PreSnapshot {
	dispatched: boolean;
	defaultPrevented: boolean;
	error: string | null;
}

/** The editor `<pre>` as the page sees it (text, markup, caret as a character offset). */
async function preSnapshot(): Promise<PreSnapshot> {
	return browser.execute(
		(editorSel, bodySel) => {
			const editing = document.querySelector<HTMLElement>(editorSel);
			const pre = editing ?? document.querySelector<HTMLElement>(`${bodySel} pre.vellis-plaintext`);
			let caret = -1;
			const sel = window.getSelection();
			if (pre && sel && sel.rangeCount > 0 && sel.isCollapsed && pre.contains(sel.anchorNode)) {
				const range = sel.getRangeAt(0);
				const probe = range.cloneRange();
				probe.selectNodeContents(pre);
				probe.setEnd(range.startContainer, range.startOffset);
				caret = probe.toString().length;
			}
			const text = pre?.textContent ?? null;
			return {
				editing: editing !== null,
				text,
				children: pre?.childElementCount ?? -1,
				hasDivOrBr: pre?.querySelector('div, br') !== null,
				caret,
				lf: text === null ? -1 : (text.match(/\n/g) ?? []).length,
			};
		},
		EDITOR,
		BODY,
	);
}

/** Put the caret (or a selection) at character offsets of the editor's `textContent`. */
async function placeCaret(start: number, end: number = start): Promise<void> {
	const ok = await browser.execute(
		(editorSel, s, e) => {
			const pre = document.querySelector<HTMLElement>(editorSel);
			if (!pre) return false;
			pre.focus();
			const locate = (offset: number): [Text, number] | null => {
				const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
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
			const a = locate(s);
			const b = locate(e);
			if (!a || !b) return false;
			const range = document.createRange();
			range.setStart(a[0], a[1]);
			range.setEnd(b[0], b[1]);
			const sel = window.getSelection();
			if (!sel) return false;
			sel.removeAllRanges();
			sel.addRange(range);
			return true;
		},
		EDITOR,
		start,
		end,
	);
	if (!ok) throw new Error(`could not place the caret at ${start}..${end} (is the editor open?)`);
}

/** Dispatch a Return `keydown` on the editor (the product turns it into insertLineBreak) and read what it did. */
async function pressReturn(): Promise<EventOutcome> {
	const r = await browser.execute((editorSel) => {
		const pre = document.querySelector<HTMLElement>(editorSel);
		if (!pre) return { dispatched: false, defaultPrevented: false, error: 'editor not open' };
		try {
			const ev = new KeyboardEvent('keydown', {
				key: 'Enter',
				code: 'Enter',
				keyCode: 13,
				which: 13,
				bubbles: true,
				cancelable: true,
				composed: true,
			});
			pre.dispatchEvent(ev);
			return { dispatched: true, defaultPrevented: ev.defaultPrevented, error: null };
		} catch (e) {
			return { dispatched: false, defaultPrevented: false, error: String(e) };
		}
	}, EDITOR);
	await browser.pause(150);
	return { ...r, ...(await preSnapshot()) };
}

/** Dispatch a `paste` on the editor with a real `DataTransfer` carrying text/plain. */
async function pasteInto(plain: string): Promise<EventOutcome> {
	const r = await browser.execute(
		(editorSel, p) => {
			const pre = document.querySelector<HTMLElement>(editorSel);
			if (!pre) return { dispatched: false, defaultPrevented: false, error: 'editor not open' };
			try {
				if (typeof DataTransfer !== 'function') throw new Error('DataTransfer constructor missing');
				const dt = new DataTransfer();
				dt.setData('text/plain', p);
				const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
				const roundTrip = ev.clipboardData?.getData('text/plain') ?? null;
				if (roundTrip !== p) throw new Error(`clipboardData did not carry text/plain (got ${JSON.stringify(roundTrip)})`);
				pre.dispatchEvent(ev);
				return { dispatched: true, defaultPrevented: ev.defaultPrevented, error: null };
			} catch (e) {
				return { dispatched: false, defaultPrevented: false, error: String(e) };
			}
		},
		EDITOR,
		plain,
	);
	await browser.pause(150);
	return { ...r, ...(await preSnapshot()) };
}

/** Type with WebKit's own editing (`insertText` fires `input` like a key press would). */
async function typeText(text: string): Promise<{ ok: boolean } & PreSnapshot> {
	const ok = await browser.execute((t) => document.execCommand('insertText', false, t), text);
	await browser.pause(150);
	return { ok, ...(await preSnapshot()) };
}

/** Command + Z's undo manager, driven from the page (the native menu is out of WebDriver's reach). */
async function undo(): Promise<{ ok: boolean } & PreSnapshot> {
	const ok = await browser.execute(() => document.execCommand('undo'));
	await browser.pause(150);
	return { ok, ...(await preSnapshot()) };
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

/** Bytes of a file on disk, with the counts the gate cares about. */
function onDiskBytes(file: string): { text: string; lf: number; cr: number; equalsUtf8: (s: string) => boolean } {
	const bytes = fs.readFileSync(file);
	let lf = 0;
	let cr = 0;
	for (const b of bytes) {
		if (b === 0x0a) lf++;
		if (b === 0x0d) cr++;
	}
	return {
		text: bytes.toString('utf8'),
		lf,
		cr,
		equalsUtf8: (s: string) => Buffer.compare(bytes, Buffer.from(s, 'utf8')) === 0,
	};
}

async function saveCallsSoFar(): Promise<Array<{ ok: boolean; content: string | null }>> {
	return (await readCapturedIpc())
		.filter((c) => c.cmd === 'save_document')
		.map((c) => ({ ok: c.ok, content: (c.args as { content?: string } | null)?.content ?? null }));
}

async function clearLogs(): Promise<void> {
	await browser.execute(() => {
		const r = (window as unknown as { __gate?: { ipc: string[]; dialogs: string[] } }).__gate;
		if (r) {
			r.ipc = [];
			r.dialogs = [];
		}
	});
	await clearCapturedIpc();
}

/** Expand `req48r-gate/` if its rows are not shown. */
async function ensureGateDirExpanded(): Promise<void> {
	if (await explorerHasRow(uri(gateFile('a')))) return;
	await waitForExplorerRow(uri(gateDir), { timeout: 20_000, nudgeDir: startRoot, nudgePrefix: 'req48r' });
	await clickExplorerRow(uri(gateDir));
	await waitForExplorerRow(uri(gateFile('a')), { timeout: 15_000 });
}

/** The newest `seq` of the captured IPC (-1 when nothing is captured yet). */
async function latestIpcSeq(): Promise<number> {
	return (await readCapturedIpc()).reduce((max, c) => Math.max(max, c.seq), -1);
}

/**
 * Open a .txt of the gate in the plain view.
 *
 * `expectedOnDisk` is the file's bytes (default: read now); the plain view shows
 * them with CRLF turned into LF (the HTML parser's doing, not the product's).
 * Two documents of the gate can hold the same text (767-b is `abc\n` after r-1),
 * and the text alone cannot tell which one is open, so this also waits for the
 * `open_document` IPC of exactly this file to have answered after the click.
 */
async function openTextForViewing(k: FixtureKey, expectedOnDisk: string = fs.readFileSync(gateFile(k), 'utf8')): Promise<void> {
	const file = gateFile(k);
	const expectedView = expectedOnDisk.replace(/\r\n/g, '\n');
	await ensureGateDirExpanded();
	const since = await latestIpcSeq();
	await clickExplorerRow(uri(file));
	await browser.waitUntil(
		async () =>
			(await readCapturedIpc()).some(
				(c) => c.seq > since && c.cmd === 'open_document' && c.ok && (c.args as { uri?: string } | null)?.uri === uri(file),
			),
		{ timeout: 15_000, timeoutMsg: `${FIXTURES[k].name}: no open_document for ${uri(file)} after the click` },
	);
	await browser.waitUntil(
		async () => {
			const v = await preSnapshot();
			return !v.editing && v.text === expectedView;
		},
		{ timeout: 15_000, timeoutMsg: `${FIXTURES[k].name} did not open in the plain-text view (now: ${JSON.stringify(await preSnapshot())})` },
	);
	await browser.pause(100);
}

/** Open the Markdown fixture in the rendered view (no pre, the heading shown). */
async function openMarkdownForViewing(): Promise<void> {
	await ensureGateDirExpanded();
	await clickExplorerRow(uri(gateFile('e')));
	await browser.waitUntil(
		async () =>
			browser.execute(
				(body, heading) =>
					document.querySelector(`${body} pre.vellis-plaintext`) === null &&
					Array.from(document.querySelectorAll(`${body} h1`)).some((h) => h.textContent === heading),
				BODY,
				MD_HEADING,
			),
		{ timeout: 15_000, timeoutMsg: `${FIXTURES.e.name} did not render` },
	);
	await browser.pause(200);
}

/**
 * Enter the editor with the Edit menu event (Command + E) and check the shape
 * the fix promises: "source + one `\n`", no elements (契約1・7).
 */
async function enterEditor(source: string): Promise<PreSnapshot> {
	await emitMenu('menu_edit');
	await browser.waitUntil(async () => (await preSnapshot()).editing, {
		timeout: 5_000,
		timeoutMsg: 'menu_edit did not enter the editor',
	});
	await browser.pause(150);
	const v = await preSnapshot();
	report(REPORT, { gate: '48r-enter-editor', source, text: v.text, lf: v.lf, children: v.children });
	expect(v.text).toBe(source + SENTINEL);
	expect(v.children).toBe(0);
	expect(v.hasDivOrBr).toBe(false);
	return v;
}

/** Command + S = File > Save, then wait until the file on disk is `expected`. */
async function saveAndWaitForDisk(file: string, expected: string): Promise<void> {
	await emitMenu('menu_save');
	await browser.waitUntil(async () => fs.readFileSync(file, 'utf8') === expected, {
		timeout: 10_000,
		timeoutMsg: `menu_save did not write the expected text (on disk now: ${JSON.stringify(fs.readFileSync(file, 'utf8'))})`,
	});
}

/**
 * Leave the editor without a dialog: put the text back to what is on disk plus
 * the sentinel (the buffer is then not dirty) and press Done Editing.
 */
async function revertEditAndLeaveEditor(file: string): Promise<void> {
	if (!(await preSnapshot()).editing) return;
	const onDisk = fs.readFileSync(file, 'utf8');
	await browser.execute(
		(editorSel, text) => {
			const pre = document.querySelector<HTMLElement>(editorSel)!;
			if (pre.textContent !== text) {
				pre.textContent = text;
				pre.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
			}
			document.querySelector<HTMLButtonElement>('[data-testid="edit-done"]')?.click();
		},
		EDITOR,
		onDisk + SENTINEL,
	);
	await browser.waitUntil(async () => !(await preSnapshot()).editing, {
		timeout: 5_000,
		timeoutMsg: 'Done Editing did not leave the editor after the text was reverted',
	});
}

/** Done Editing when nothing is dirty: no ask (`plugin:dialog|message`) may appear. */
async function leaveEditorExpectingNoAsk(): Promise<{ left: boolean; asks: number; dialogs: string[] }> {
	await clearLogs();
	await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="edit-done"]')?.click());
	let left = false;
	try {
		await browser.waitUntil(async () => !(await preSnapshot()).editing, { timeout: 5_000 });
		left = true;
	} catch {
		left = false;
	}
	const rec = await readGateRecord();
	return { left, asks: rec.ipc.filter((c) => c === 'plugin:dialog|message').length, dialogs: rec.dialogs };
}

// --- diagnostics for the undo / redo gates (r-10 was red in one CI run and green in another) ---

interface HistoryState {
	undoEnabled: boolean | null;
	redoEnabled: boolean | null;
	/** The editor's child nodes: text nodes as their `data`, elements as `<name>`. */
	nodes: string[] | null;
}

/** `queryCommandEnabled('undo' / 'redo')` and the editor's child nodes, as the page sees them now. */
async function historyState(): Promise<HistoryState> {
	return browser.execute((editorSel) => {
		const q = (cmd: string) => {
			try {
				return document.queryCommandEnabled(cmd);
			} catch {
				return null;
			}
		};
		const pre = document.querySelector<HTMLElement>(editorSel);
		return {
			undoEnabled: q('undo'),
			redoEnabled: q('redo'),
			nodes: pre ? Array.from(pre.childNodes).map((n) => (n.nodeType === 3 ? (n as Text).data : `<${n.nodeName}>`)) : null,
		};
	}, EDITOR);
}

/** Record every `input` on the page (its `inputType`) into `window.__req48rInputs`. Idempotent. */
async function installInputRecorder(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __req48rInputs?: string[]; __req48rInputsInstalled?: boolean };
		w.__req48rInputs = [];
		if (w.__req48rInputsInstalled) return;
		w.__req48rInputsInstalled = true;
		document.addEventListener('input', (e) => w.__req48rInputs?.push((e as InputEvent).inputType ?? '?'), true);
	});
}

async function takeInputs(): Promise<string[]> {
	return browser.execute(() => {
		const w = window as unknown as { __req48rInputs?: string[] };
		const out = [...(w.__req48rInputs ?? [])];
		w.__req48rInputs = [];
		return out;
	});
}

/**
 * Make the page garbage-collect (the probe's `churn()`: 40 arrays of 200,000
 * objects, built and dropped), three times.
 *
 * Why (2026-10-29): WebKit may drop the JS wrapper of a node that an undo took
 * out of the DOM. A fix that remembers the source's line-break nodes in a
 * `WeakSet` then loses the mark, and the redo that brings the node back sees a
 * "sentinel" and removes the typed line break (CI run 40856179517 red, run
 * 40853980702 green: whether the GC ran was luck). Churning between the undo
 * and the redo makes it run every time, so a `WeakSet` fix is red every time
 * (scratchpad wkprobe/probe7.swift) and the `Set` fix green (probe8.swift).
 */
async function churnGarbage(): Promise<number> {
	let kept = 0;
	for (let n = 0; n < 3; n++) {
		kept += await browser.execute(() => {
			let keep = 0;
			for (let r = 0; r < 40; r++) {
				const a: Array<{ i: number; s: string }> = [];
				for (let i = 0; i < 200_000; i++) a.push({ i, s: 'x' + i });
				keep += a.length;
			}
			return keep;
		});
	}
	return kept;
}

/** Put every gate file back to the fixture bytes. */
function resetGateFiles(): void {
	fs.mkdirSync(gateDir, { recursive: true });
	for (const k of Object.keys(FIXTURES) as FixtureKey[]) {
		fs.writeFileSync(gateFile(k), FIXTURES[k].content);
	}
}

describe('Requirement #48 追補r human gate (the final newline of the document survives the source editor)', () => {
	/** The file a test is editing, so afterEach can revert it. */
	let currentFile: string = gateFile('a');

	before(async () => {
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		// `open_document` is captured to tell which file the plain view shows (see openTextForViewing).
		await setIpcCapture(['save_document', 'open_document']);
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		// The human gate's data must be what the README says, byte for byte; a drift
		// is a fixture problem, reported as such (not as the product's).
		for (const k of FROM_EDIT) {
			const src = path.join(editFixtures, FIXTURES[k].name);
			const bytes = fs.readFileSync(src);
			const same = Buffer.compare(bytes, Buffer.from(FIXTURES[k].content, 'utf8')) === 0;
			report(REPORT, { gate: '48r-fixture-check', file: FIXTURES[k].name, same, bytes: bytes.toString('utf8') });
			if (!same) throw new Error(`fixtures/edit/${FIXTURES[k].name} does not hold the bytes fixtures/edit/README.md documents (got ${JSON.stringify(bytes.toString('utf8'))})`);
		}
		fs.rmSync(gateDir, { recursive: true, force: true });
		resetGateFiles();
		await ensureGateDirExpanded();
	});

	/**
	 * Every test ends out of the editor with the gate files back to the fixture
	 * bytes — also when an assertion failed half-way, so one failure cannot cascade.
	 */
	afterEach(async () => {
		const problems: Record<string, string> = {};
		try {
			await revertEditAndLeaveEditor(currentFile);
		} catch (err) {
			problems.leaveEditor = String(err);
		}
		if (fs.existsSync(gateDir)) resetGateFiles();
		try {
			await clearLogs();
		} catch (err) {
			problems.clearLogs = String(err);
		}
		if (Object.keys(problems).length > 0) report(REPORT, { gate: '48r-after-each', ...problems });
	});

	after(async () => {
		await restoreGateRecorder();
		fs.rmSync(gateDir, { recursive: true, force: true });
		for (const name of fs.readdirSync(startRoot)) {
			if (name.startsWith('req48r-')) fs.rmSync(path.join(startRoot, name), { recursive: true, force: true });
		}
	});

	it('gate r-1 (AC a): `abc` → Return at the end → Command + S → the file is `abc\\n` (not one too many); reopened it reads `abc\\n`', async () => {
		currentFile = gateFile('b');
		await openTextForViewing('b');
		await enterEditor(FIXTURES.b.content);
		await clearLogs();

		await placeCaret(END_ABC);
		const ret = await pressReturn();
		await safeShot('req48r-gate1-after-return');
		report(REPORT, { gate: '48r-1-return', ret });

		expect(ret.dispatched).toBe(true);
		expect(ret.defaultPrevented).toBe(true);
		expect(ret.hasDivOrBr).toBe(false);
		expect(ret.children).toBe(0);
		// The editor: `abc\n` + the sentinel. The caret sits after the inserted `\n`, before the sentinel.
		expect(ret.text).toBe('abc\n' + SENTINEL);
		expect(ret.caret).toBe(END_ABC + 1);

		const expected = 'abc\n';
		await saveAndWaitForDisk(currentFile, expected);
		const disk = onDiskBytes(currentFile);
		const saveCalls = await saveCallsSoFar();
		report(REPORT, { gate: '48r-1-saved', disk: { text: disk.text, lf: disk.lf, cr: disk.cr }, saveCalls, editor: await preSnapshot() });
		expect(disk.equalsUtf8(expected)).toBe(true);
		expect(disk.lf).toBe(1);
		expect(disk.cr).toBe(0);
		expect(saveCalls.length).toBe(1);
		expect(saveCalls[0]!.ok).toBe(true);
		expect(saveCalls[0]!.content).toBe(expected);
		// After the save the editor still shows exactly one sentinel (契約5: the $effect does not pile up).
		expect((await preSnapshot()).text).toBe(expected + SENTINEL);

		const left = await leaveEditorExpectingNoAsk();
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
		// Reopen: another document in between (one whose text differs from `abc\n`), then back.
		await openTextForViewing('c');
		await openTextForViewing('b', expected);
		const reopened = await preSnapshot();
		report(REPORT, { gate: '48r-1-reopened', reopened });
		expect(reopened.editing).toBe(false);
		expect(reopened.text).toBe(expected);

		// Put 767-b back to `abc` here (not only in afterEach), and wait for the
		// plain view to follow, so the next gate does not start on a view of `abc\n`
		// that happens to equal 767-a's text.
		fs.writeFileSync(currentFile, FIXTURES.b.content);
		await browser.waitUntil(
			async () => {
				const v = await preSnapshot();
				return !v.editing && v.text === FIXTURES.b.content;
			},
			{ timeout: 15_000, timeoutMsg: `the plain view did not follow 767-b being put back to ${JSON.stringify(FIXTURES.b.content)}` },
		);
	});

	it('gate r-2 (AC b): `abc\\n` → Return at the end of `abc` → `x` → Command + S → the file is `abc\\nx\\n` (the final newline survives)', async () => {
		currentFile = gateFile('a');
		await openTextForViewing('a');
		await enterEditor(FIXTURES.a.content);
		await clearLogs();

		await placeCaret(END_ABC);
		const ret = await pressReturn();
		const typed = await typeText('x');
		await safeShot('req48r-gate2-after-return-and-x');
		report(REPORT, { gate: '48r-2-return-x', ret, typed });

		expect(ret.defaultPrevented).toBe(true);
		expect(ret.text).toBe('abc\n\n' + SENTINEL);
		expect(ret.caret).toBe(END_ABC + 1);
		expect(typed.ok).toBe(true);
		expect(typed.hasDivOrBr).toBe(false);
		expect(typed.text).toBe('abc\nx\n' + SENTINEL);
		expect(typed.caret).toBe(END_ABC + 2);

		const expected = 'abc\nx\n';
		await saveAndWaitForDisk(currentFile, expected);
		const disk = onDiskBytes(currentFile);
		const saveCalls = await saveCallsSoFar();
		report(REPORT, { gate: '48r-2-saved', disk: { text: disk.text, lf: disk.lf, cr: disk.cr }, saveCalls });
		expect(disk.equalsUtf8(expected)).toBe(true);
		expect(disk.lf).toBe(2);
		expect(disk.cr).toBe(0);
		expect(saveCalls.length).toBe(1);
		expect(saveCalls[0]!.content).toBe(expected);

		const left = await leaveEditorExpectingNoAsk();
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
	});

	it('gate r-3 (AC c): open `abc\\n`, `abc` and the CRLF file, touch nothing → Command + S writes nothing new, Done asks nothing, the bytes are unchanged', async () => {
		const outcomes: Array<Record<string, unknown>> = [];
		for (const k of ['a', 'b', 'd'] as FixtureKey[]) {
			currentFile = gateFile(k);
			const original = FIXTURES[k].content;
			await openTextForViewing(k);
			const entered = await enterEditor(original);
			await clearLogs();

			// Command + S with nothing dirty: nothing may be written (and if the product
			// wrote, the bytes would still have to be the original).
			await emitMenu('menu_save');
			await browser.pause(800);
			const saveCalls = await saveCallsSoFar();
			const disk = onDiskBytes(currentFile);
			const afterSave = await preSnapshot();
			const left = await leaveEditorExpectingNoAsk();
			const view = await preSnapshot();
			outcomes.push({ file: FIXTURES[k].name, entered: entered.text, saveCalls, disk: { text: disk.text, lf: disk.lf, cr: disk.cr }, afterSave: afterSave.text, left, view: view.text });

			expect(disk.equalsUtf8(original)).toBe(true);
			for (const c of saveCalls) expect(c.content).toBe(original);
			expect(afterSave.text).toBe(original + SENTINEL);
			expect(left.left).toBe(true);
			expect(left.asks).toBe(0);
			expect(view.editing).toBe(false);
			// The plain view shows CRLF as LF (the HTML parser's doing; same as openTextForViewing).
			expect(view.text).toBe(original.replace(/\r\n/g, '\n'));
		}
		await safeShot('req48r-gate3-untouched');
		report(REPORT, { gate: '48r-3-untouched', outcomes });
		// The CRLF file keeps its CRs (契約5: the sentinel is one LF, never written).
		const d = onDiskBytes(gateFile('d'));
		expect(d.cr).toBe(3);
		expect(d.lf).toBe(3);
	});

	it('gate r-4 (AC d): `abc` → paste `one\\ntwo\\n` at the end → Command + S → the file is `abcone\\ntwo\\n` (not one too many)', async () => {
		currentFile = gateFile('b');
		await openTextForViewing('b');
		await enterEditor(FIXTURES.b.content);
		await clearLogs();

		await placeCaret(END_ABC);
		const pasted = await pasteInto('one\ntwo\n');
		await safeShot('req48r-gate4-after-paste');
		report(REPORT, { gate: '48r-4-paste', pasted });

		expect(pasted.dispatched).toBe(true);
		expect(pasted.defaultPrevented).toBe(true);
		expect(pasted.hasDivOrBr).toBe(false);
		expect(pasted.children).toBe(0);
		expect(pasted.text).toBe('abcone\ntwo\n' + SENTINEL);
		expect(pasted.caret).toBe('abcone\ntwo\n'.length);

		const expected = 'abcone\ntwo\n';
		await saveAndWaitForDisk(currentFile, expected);
		const disk = onDiskBytes(currentFile);
		const saveCalls = await saveCallsSoFar();
		report(REPORT, { gate: '48r-4-saved', disk: { text: disk.text, lf: disk.lf, cr: disk.cr }, saveCalls });
		expect(disk.equalsUtf8(expected)).toBe(true);
		expect(disk.lf).toBe(2);
		expect(saveCalls.length).toBe(1);
		expect(saveCalls[0]!.content).toBe(expected);

		const left = await leaveEditorExpectingNoAsk();
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
	});

	it('gate r-5a (AC e): three lines — Return in the middle of `second line` → `x`, then at the end of `third line` → `x`; both saves keep every line and the final newline', async () => {
		currentFile = gateFile('c');
		const original = FIXTURES.c.content;
		await openTextForViewing('c');
		await enterEditor(original);
		await clearLogs();

		// 1. Middle of the document: after 'second' (offset 17).
		const midAt = original.indexOf('second') + 'second'.length;
		await placeCaret(midAt);
		const ret1 = await pressReturn();
		const typed1 = await typeText('x');
		const after1 = original.slice(0, midAt) + '\nx' + original.slice(midAt);
		await saveAndWaitForDisk(currentFile, after1);
		const disk1 = onDiskBytes(currentFile);

		// 2. End of the last line: after 'third line' (before the final `\n`).
		const endAt = after1.length - 1;
		await placeCaret(endAt);
		const ret2 = await pressReturn();
		const typed2 = await typeText('x');
		const after2 = after1.slice(0, -1) + '\nx\n';
		await saveAndWaitForDisk(currentFile, after2);
		const disk2 = onDiskBytes(currentFile);
		const saveCalls = await saveCallsSoFar();
		await safeShot('req48r-gate5a-three-lines');
		report(REPORT, { gate: '48r-5a-three-lines', ret1, typed1, disk1: { text: disk1.text, lf: disk1.lf }, ret2, typed2, disk2: { text: disk2.text, lf: disk2.lf }, saveCalls });

		expect(ret1.defaultPrevented).toBe(true);
		expect(typed1.text).toBe(after1 + SENTINEL);
		expect(typed1.hasDivOrBr).toBe(false);
		expect(disk1.equalsUtf8(after1)).toBe(true);
		expect(disk1.lf).toBe(4);
		expect(ret2.defaultPrevented).toBe(true);
		expect(ret2.text).toBe(after1.slice(0, -1) + '\n\n' + SENTINEL);
		expect(typed2.text).toBe(after2 + SENTINEL);
		expect(typed2.hasDivOrBr).toBe(false);
		expect(disk2.equalsUtf8(after2)).toBe(true);
		expect(disk2.lf).toBe(5);
		expect(disk2.cr).toBe(0);
		expect(saveCalls.map((c) => c.content)).toEqual([after1, after2]);

		const left = await leaveEditorExpectingNoAsk();
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
	});

	it('gate r-5b (AC e): the CRLF file — Return at the end of `third line` → `x` → Command + S → the final `\\r\\n` stays (the inserted break is LF)', async () => {
		currentFile = gateFile('d');
		const original = FIXTURES.d.content;
		await openTextForViewing('d');
		await enterEditor(original);
		await clearLogs();

		// End of 'third line' = before the final `\r\n`.
		const endAt = original.length - 2;
		await placeCaret(endAt);
		const ret = await pressReturn();
		const typed = await typeText('x');
		const expected = original.slice(0, -2) + '\nx\r\n';
		await safeShot('req48r-gate5b-crlf');
		report(REPORT, { gate: '48r-5b-crlf', ret, typed });

		expect(ret.defaultPrevented).toBe(true);
		expect(typed.ok).toBe(true);
		expect(typed.text).toBe(expected + SENTINEL);
		expect(typed.hasDivOrBr).toBe(false);

		await saveAndWaitForDisk(currentFile, expected);
		const disk = onDiskBytes(currentFile);
		const saveCalls = await saveCallsSoFar();
		report(REPORT, { gate: '48r-5b-saved', disk: { text: disk.text, lf: disk.lf, cr: disk.cr }, saveCalls });
		expect(disk.equalsUtf8(expected)).toBe(true);
		expect(disk.cr).toBe(3);
		expect(disk.lf).toBe(4);
		expect(saveCalls.length).toBe(1);
		expect(saveCalls[0]!.content).toBe(expected);

		const left = await leaveEditorExpectingNoAsk();
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
	});

	it('gate r-5c (AC e): the Markdown file — Command + E → Return at the end of the last line → `x` → Command + S → the final newline stays', async () => {
		currentFile = gateFile('e');
		const original = FIXTURES.e.content;
		await openMarkdownForViewing();
		await enterEditor(original);
		await clearLogs();

		const endAt = original.length - 1;
		await placeCaret(endAt);
		const ret = await pressReturn();
		const typed = await typeText('x');
		const expected = original.slice(0, -1) + '\nx\n';
		await safeShot('req48r-gate5c-markdown');
		report(REPORT, { gate: '48r-5c-markdown', ret, typed });

		expect(ret.defaultPrevented).toBe(true);
		expect(typed.ok).toBe(true);
		expect(typed.text).toBe(expected + SENTINEL);
		expect(typed.hasDivOrBr).toBe(false);

		await saveAndWaitForDisk(currentFile, expected);
		const disk = onDiskBytes(currentFile);
		const saveCalls = await saveCallsSoFar();
		report(REPORT, { gate: '48r-5c-saved', disk: { text: disk.text, lf: disk.lf, cr: disk.cr }, saveCalls });
		expect(disk.equalsUtf8(expected)).toBe(true);
		expect(disk.lf).toBe((expected.match(/\n/g) ?? []).length);
		expect(saveCalls.length).toBe(1);
		expect(saveCalls[0]!.content).toBe(expected);

		const left = await leaveEditorExpectingNoAsk();
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
	});

	it('gate r-6 (AC e, 契約3): `abc` → Return at the end → undo → the editor is back to the sentinel alone, Done asks nothing, the file is untouched', async () => {
		currentFile = gateFile('b');
		await openTextForViewing('b');
		await enterEditor(FIXTURES.b.content);
		await clearLogs();

		await placeCaret(END_ABC);
		const ret = await pressReturn();
		const undone = await undo();
		await safeShot('req48r-gate6-after-undo');
		report(REPORT, { gate: '48r-6-undo', ret, undone });

		expect(ret.text).toBe('abc\n' + SENTINEL);
		expect(undone.ok).toBe(true);
		expect(undone.text).toBe(FIXTURES.b.content + SENTINEL);
		expect(undone.hasDivOrBr).toBe(false);

		// The undo also brought the buffer back (契約2・3), so Done asks nothing.
		const left = await leaveEditorExpectingNoAsk();
		report(REPORT, { gate: '48r-6-left-editor', ...left });
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
		expect(onDiskBytes(currentFile).equalsUtf8(FIXTURES.b.content)).toBe(true);
	});

	it('gate r-7 (AC f): the file changes on disk while the clean editor is open → the new text is shown with exactly one sentinel, Done asks nothing', async () => {
		currentFile = gateFile('a');
		await openTextForViewing('a');
		await enterEditor(FIXTURES.a.content);
		await clearLogs();

		const rewritten = 'abc\nnew\n';
		fs.writeFileSync(currentFile, rewritten);
		let applied: PreSnapshot | null = null;
		try {
			await browser.waitUntil(
				async () => {
					const v = await preSnapshot();
					return v.editing && v.text !== null && v.text.startsWith(rewritten);
				},
				{ timeout: 20_000 },
			);
		} finally {
			applied = await preSnapshot();
		}
		await safeShot('req48r-gate7-external-change');
		report(REPORT, { gate: '48r-7-external-change', applied });

		expect(applied!.editing).toBe(true);
		expect(applied!.text).toBe(rewritten + SENTINEL);
		expect(applied!.children).toBe(0);
		expect(applied!.lf).toBe(3);

		const left = await leaveEditorExpectingNoAsk();
		report(REPORT, { gate: '48r-7-left-editor', ...left });
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
		expect((await preSnapshot()).text).toBe(rewritten);
	});

	it('gate r-8 (AC h, 契約8): `abc\\n` → `x` on the last empty line → undo → the editor is `abc\\n` + one sentinel (not one too many); redo brings `x` back; Done after undo asks nothing', async () => {
		currentFile = gateFile('a');
		await openTextForViewing('a');
		await enterEditor(FIXTURES.a.content);
		await clearLogs();

		// The last empty line = after the final `\n` of the source, before the sentinel.
		await placeCaret(FIXTURES.a.content.length);
		const typed = await typeText('x');
		const undone = await undo();
		const redone = await browser.execute(() => document.execCommand('redo'));
		await browser.pause(150);
		const afterRedo = await preSnapshot();
		const undoneAgain = await undo();
		await safeShot('req48r-gate8-undo-redo');
		report(REPORT, { gate: '48r-8-undo-redo', typed, undone, redone, afterRedo, undoneAgain });

		// Typing on the last empty line: WebKit eats the sentinel and the fix puts it back (契約3).
		expect(typed.ok).toBe(true);
		expect(typed.text).toBe('abc\nx' + SENTINEL);
		expect(typed.hasDivOrBr).toBe(false);
		// Undo: WebKit restores the `\n` it ate; the re-added sentinel must not stay beside it (契約8).
		expect(undone.ok).toBe(true);
		expect(undone.text).toBe(FIXTURES.a.content + SENTINEL);
		expect(undone.lf).toBe(2);
		expect(undone.hasDivOrBr).toBe(false);
		expect(undone.caret).toBe(FIXTURES.a.content.length);
		// Redo: `x` is back, still one sentinel.
		expect(redone).toBe(true);
		expect(afterRedo.text).toBe('abc\nx' + SENTINEL);
		expect(undoneAgain.text).toBe(FIXTURES.a.content + SENTINEL);

		// The buffer is back to the source (契約2・8), so Done asks nothing and the file is untouched.
		const left = await leaveEditorExpectingNoAsk();
		report(REPORT, { gate: '48r-8-left-editor', ...left });
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
		expect(onDiskBytes(currentFile).equalsUtf8(FIXTURES.a.content)).toBe(true);
	});

	it('gate r-9 (AC i, 契約9): select everything → copy and cut events → the clipboard text is the source (no sentinel); after the cut the editor holds one sentinel', async () => {
		currentFile = gateFile('a');
		const original = FIXTURES.a.content;
		await openTextForViewing('a');
		await enterEditor(original);
		await clearLogs();

		/**
		 * Select the whole `<pre>` (sentinel included — WKWebView's selection string
		 * is then `abc\n\n`) and dispatch an untrusted copy / cut with a real
		 * `DataTransfer`. An untrusted ClipboardEvent never touches the system
		 * clipboard; what the fix wrote is read back from the same DataTransfer.
		 */
		const clip = async (type: 'copy' | 'cut') =>
			browser.execute(
				(editorSel, t) => {
					const pre = document.querySelector<HTMLElement>(editorSel);
					if (!pre) return { dispatched: false, defaultPrevented: false, selected: null as string | null, plain: null as string | null, error: 'editor not open' };
					try {
						const range = document.createRange();
						range.selectNodeContents(pre);
						const sel = window.getSelection()!;
						sel.removeAllRanges();
						sel.addRange(range);
						const selected = sel.toString();
						const dt = new DataTransfer();
						const ev = new ClipboardEvent(t, { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
						pre.dispatchEvent(ev);
						const plain = dt.types.includes('text/plain') ? dt.getData('text/plain') : null;
						return { dispatched: true, defaultPrevented: ev.defaultPrevented, selected, plain, error: null };
					} catch (e) {
						return { dispatched: false, defaultPrevented: false, selected: null as string | null, plain: null as string | null, error: String(e) };
					}
				},
				EDITOR,
				type,
			);

		const copied = await clip('copy');
		await browser.pause(150);
		const afterCopy = await preSnapshot();
		const cutOut = await clip('cut');
		await browser.pause(150);
		const afterCut = await preSnapshot();
		await safeShot('req48r-gate9-copy-cut');
		report(REPORT, { gate: '48r-9-copy-cut', copied, afterCopy, cutOut, afterCut });

		expect(copied.dispatched).toBe(true);
		expect(copied.selected).toBe(original + SENTINEL);
		expect(copied.defaultPrevented).toBe(true);
		expect(copied.plain).toBe(original);
		expect(afterCopy.text).toBe(original + SENTINEL);
		expect(cutOut.dispatched).toBe(true);
		expect(cutOut.defaultPrevented).toBe(true);
		expect(cutOut.plain).toBe(original);
		// The cut removed the source; the sentinel is put back (契約3・9).
		expect(afterCut.editing).toBe(true);
		expect(afterCut.text).toBe(SENTINEL);
		expect(afterCut.hasDivOrBr).toBe(false);
		expect(onDiskBytes(currentFile).equalsUtf8(original)).toBe(true);
	});

	// --- 契約8: Return を含む取り消し・やり直しで打った改行が失われない(4 通り) ---------
	// WebKit puts a Return in as a text node holding only `\n` (the sentinel's shape),
	// so telling the two apart by shape alone loses a typed line break. Each case
	// records every step's textContent; the buffer is read as the bytes a save
	// writes (cases 1〜3, dirty) or as "Done asks nothing" (case 4, back to the source).

	/** Redo driven as `document.execCommand('redo')` (the native menu is out of reach). */
	async function redo(): Promise<{ ok: boolean } & PreSnapshot> {
		const ok = await browser.execute(() => document.execCommand('redo'));
		await browser.pause(150);
		return { ok, ...(await preSnapshot()) };
	}

	it('gate r-10 (契約8-1): `abc` → Return at the end → undo → redo → the buffer is `abc\\n` (the typed line break survives the redo)', async () => {
		currentFile = gateFile('b');
		await openTextForViewing('b');
		await enterEditor(FIXTURES.b.content);
		await clearLogs();

		// Diagnostics (the redo did nothing in CI run 40856179517 but worked in
		// 40853980702): the undo / redo availability and the editor's nodes before and
		// after each step, the `input` types each step fired, and one retried redo
		// after 200 ms when the first did nothing. The verdict stays on the first redo.
		await installInputRecorder();
		await placeCaret(END_ABC);
		const ret = await pressReturn();
		const returnInputs = await takeInputs();
		const beforeUndo = await historyState();
		const undone = await undo();
		const afterUndo = await historyState();
		const undoInputs = await takeInputs();
		// GC between the undo and the redo (see churnGarbage): the node the undo took
		// out must still be known as a typed line break when the redo brings it back.
		const churned = await churnGarbage();
		const afterChurn = await historyState();
		const redone = await redo();
		const afterRedo = await historyState();
		const redoInputs = await takeInputs();
		let retriedRedo: Record<string, unknown> | null = null;
		if (redone.text !== 'abc\n' + SENTINEL) {
			await browser.pause(200);
			const again = await redo();
			retriedRedo = { ...again, state: await historyState(), inputs: await takeInputs() };
		}
		await safeShot('req48r-gate10-return-undo-redo');
		report(REPORT, {
			gate: '48r-10-return-undo-redo',
			ret,
			returnInputs,
			beforeUndo,
			undone,
			afterUndo,
			undoInputs,
			churned,
			afterChurn,
			redone,
			afterRedo,
			redoInputs,
			retriedRedo,
		});

		expect(ret.text).toBe('abc\n' + SENTINEL);
		expect(undone.ok).toBe(true);
		expect(undone.text).toBe('abc' + SENTINEL);
		expect(redone.ok).toBe(true);
		expect(redone.text).toBe('abc\n' + SENTINEL);
		expect(redone.hasDivOrBr).toBe(false);

		const expected = 'abc\n';
		await saveAndWaitForDisk(currentFile, expected);
		const disk = onDiskBytes(currentFile);
		const saveCalls = await saveCallsSoFar();
		report(REPORT, { gate: '48r-10-saved', disk: { text: disk.text, lf: disk.lf }, saveCalls });
		expect(disk.equalsUtf8(expected)).toBe(true);
		expect(saveCalls.map((c) => c.content)).toEqual([expected]);
	});

	/**
	 * WebKit's undo may take back two inputs typed in a row as one step (CI run
	 * 40853980702: Return, Return → one undo → `abc`; Return, `x` → one undo →
	 * `abc`). That is a correct undo and no doubled sentinel. The caret is put
	 * again between the steps (a selection change is expected to close the typing
	 * group); whichever way WebKit groups them, 契約8's point is checked: no typed
	 * line break is lost — the editor after undo (and after redo when the undo
	 * took both) is one of the two legitimate states, with one sentinel, and the
	 * saved bytes are the editor text without it. The grouping goes into the report.
	 */
	async function undoAfterTwoSteps(
		label: string,
		afterBoth: string,
		afterFirst: string,
	): Promise<{ grouping: 'separate' | 'grouped'; undone: { ok: boolean } & PreSnapshot; redone: ({ ok: boolean } & PreSnapshot) | null; expected: string }> {
		const undone = await undo();
		expect(undone.ok).toBe(true);
		expect(undone.hasDivOrBr).toBe(false);
		// After one undo the editor is the state before the second step, or before both.
		report(REPORT, { gate: `48r-${label}-undo-step`, undone: undone.text, separate: afterFirst + SENTINEL, grouped: FIXTURES.b.content + SENTINEL });
		expect([afterFirst + SENTINEL, FIXTURES.b.content + SENTINEL]).toContain(undone.text);
		// GC after the undo (see churnGarbage): the nodes the undo took out must still
		// be known as typed line breaks when a redo brings them back.
		const churned = await churnGarbage();
		report(REPORT, { gate: `48r-${label}-churned`, churned, state: await historyState() });
		if (undone.text === afterFirst + SENTINEL) return { grouping: 'separate', undone, redone: null, expected: afterFirst };
		// Both steps came back as one: redo must bring both back, with one sentinel.
		const redone = await redo();
		expect(redone.ok).toBe(true);
		expect(redone.hasDivOrBr).toBe(false);
		expect(redone.text).toBe(afterBoth + SENTINEL);
		return { grouping: 'grouped', undone, redone, expected: afterBoth };
	}

	it('gate r-11 (契約8-2): `abc` → Return twice at the end → undo once → no typed line break is lost (`abc\\n` + sentinel, or `abc` and redo gives `abc\\n\\n` back) and the save matches', async () => {
		currentFile = gateFile('b');
		await openTextForViewing('b');
		await enterEditor(FIXTURES.b.content);
		await clearLogs();

		await placeCaret(END_ABC);
		const ret1 = await pressReturn();
		// Place the caret again so the second Return is its own undo step (if WebKit agrees).
		await placeCaret(END_ABC + 1);
		const ret2 = await pressReturn();
		const outcome = await undoAfterTwoSteps('r-11', 'abc\n\n', 'abc\n');
		await safeShot('req48r-gate11-two-returns-undo');
		report(REPORT, { gate: '48r-11-two-returns-undo', ret1, ret2, grouping: outcome.grouping, undone: outcome.undone, redone: outcome.redone });

		expect(ret1.text).toBe('abc\n' + SENTINEL);
		expect(ret1.caret).toBe(END_ABC + 1);
		expect(ret2.text).toBe('abc\n\n' + SENTINEL);
		expect(ret2.caret).toBe(END_ABC + 2);

		await saveAndWaitForDisk(currentFile, outcome.expected);
		const disk = onDiskBytes(currentFile);
		const saveCalls = await saveCallsSoFar();
		report(REPORT, { gate: '48r-11-saved', grouping: outcome.grouping, disk: { text: disk.text, lf: disk.lf }, saveCalls });
		expect(disk.equalsUtf8(outcome.expected)).toBe(true);
		expect(saveCalls.map((c) => c.content)).toEqual([outcome.expected]);
		expect((await preSnapshot()).text).toBe(outcome.expected + SENTINEL);
	});

	it('gate r-12 (契約8-3): `abc` → Return at the end → `x` on the last line → undo → no typed line break is lost (`abc\\n` + sentinel, or `abc` and redo gives `abc\\nx` back), the restored placeholder and the re-added sentinel do not pile up, and the save matches', async () => {
		currentFile = gateFile('b');
		await openTextForViewing('b');
		await enterEditor(FIXTURES.b.content);
		await clearLogs();

		await placeCaret(END_ABC);
		const ret = await pressReturn();
		// Place the caret again (on the new last line) so `x` is its own undo step (if WebKit agrees).
		await placeCaret(END_ABC + 1);
		const typed = await typeText('x');
		const outcome = await undoAfterTwoSteps('r-12', 'abc\nx', 'abc\n');
		await safeShot('req48r-gate12-return-x-undo');
		report(REPORT, { gate: '48r-12-return-x-undo', ret, typed, grouping: outcome.grouping, undone: outcome.undone, redone: outcome.redone });

		expect(ret.text).toBe('abc\n' + SENTINEL);
		expect(ret.caret).toBe(END_ABC + 1);
		expect(typed.ok).toBe(true);
		expect(typed.text).toBe('abc\nx' + SENTINEL);
		expect(typed.hasDivOrBr).toBe(false);

		await saveAndWaitForDisk(currentFile, outcome.expected);
		const disk = onDiskBytes(currentFile);
		const saveCalls = await saveCallsSoFar();
		report(REPORT, { gate: '48r-12-saved', grouping: outcome.grouping, disk: { text: disk.text, lf: disk.lf }, saveCalls });
		expect(disk.equalsUtf8(outcome.expected)).toBe(true);
		expect(saveCalls.map((c) => c.content)).toEqual([outcome.expected]);
		expect((await preSnapshot()).text).toBe(outcome.expected + SENTINEL);
	});

	it('gate r-13 (契約8-4): a document that is one `\\n` → `x` on the last empty line → undo → the buffer is `\\n` (Done asks nothing, the file is untouched)', async () => {
		currentFile = gateFile('f');
		const original = FIXTURES.f.content;
		await openTextForViewing('f');
		await enterEditor(original);
		await clearLogs();

		await placeCaret(original.length);
		const typed = await typeText('x');
		const undone = await undo();
		await safeShot('req48r-gate13-newline-only-x-undo');
		report(REPORT, { gate: '48r-13-newline-only-x-undo', typed, undone });

		expect(typed.ok).toBe(true);
		expect(typed.text).toBe('\nx' + SENTINEL);
		expect(undone.ok).toBe(true);
		expect(undone.text).toBe(original + SENTINEL);
		expect(undone.lf).toBe(2);
		expect(undone.hasDivOrBr).toBe(false);

		const left = await leaveEditorExpectingNoAsk();
		report(REPORT, { gate: '48r-13-left-editor', ...left });
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
		expect(onDiskBytes(currentFile).equalsUtf8(original)).toBe(true);
	});
});
