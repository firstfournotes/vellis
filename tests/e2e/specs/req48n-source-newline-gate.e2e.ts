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
 * Requirement #48 追補n human gate (Issue #765), driven on the webdriver build
 * (docs/requirements/req-48.md「追補n」, 契約1〜4, AC-48-追n (a)〜(d)):
 *
 *   In the source editor (`<pre class="vellis-plaintext" contenteditable>`),
 *   WebKit answers Return with a `<div>` and `bufferFromPre` (`textContent`)
 *   loses the line break, so a save writes the file without it. The fix takes
 *   Return and paste itself: Return puts one `\n` at the caret (not during an
 *   IME composition, not with Command / Control), paste puts text/plain with
 *   CRLF / CR / LF all turned into `\n`, both through WebKit's editing commands
 *   (`insertLineBreak` / `insertText`) so Command + Z undoes them.
 *
 * Gate items (req-48.md「人間ゲート(追補n)」) and how each is driven here:
 *  - n-1  .txt → Edit → Return in the middle of a line → type → Command + S →
 *         reopen: the line break is there. Return is a synthetic `keydown`
 *         dispatched on the `<pre>` (WebKit performs no default action for an
 *         untrusted key event, so before the fix nothing is inserted and the
 *         gate is red); typing is `document.execCommand('insertText')`, which
 *         is WebKit's own editing; Command + S is the `menu_save` event (menus
 *         are not clicked — gate-helpers rule); the file is compared byte for
 *         byte; "reopen" is start-doc.md and back.
 *  - n-2  the Return that confirms a Japanese IME conversion inserts no line
 *         break: `keydown` with `isComposing: true` and with `keyCode: 229`,
 *         plus Command / Control + Return, are left alone (`defaultPrevented`
 *         false, text unchanged); Shift + Return does insert.
 *  - n-3  pasting several lines keeps the lines: `ClipboardEvent('paste')`
 *         with a `DataTransfer` carrying text/plain with CRLF / CR / LF and a
 *         text/html the fix must not use; a selection is replaced; an empty
 *         text/plain inserts nothing; the save is checked on disk.
 *  - n-4  Command + Z undoes Return and the paste (契約4): the real shortcut
 *         goes to the native Edit menu, which WebDriver cannot reach, so this
 *         spec calls `document.execCommand('undo')` — the same undo manager the
 *         menu item drives. One undo per operation brings the text back.
 *
 * Everything read from the page is kept in the report
 * (`$VELLIS_GATE_SHOTS/req48n-report.jsonl`, `[gate]` lines in the CI log).
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const gateDir = path.join(startRoot, 'req48n-gate');
const editFile = path.join(gateDir, 'newline.txt');
/** Created by scripts/e2e.sh (`# Start`); opened to "reopen" the .txt afterwards. */
const otherFile = path.join(startRoot, 'start-doc.md');
const REPORT = 'req48n-report.jsonl';
const BODY = 'article.viewer .markdown-body';
const EDITOR = `${BODY} pre.vellis-plaintext[contenteditable="true"]`;

/** LF only (契約5: CRLF documents are out of scope). 'first' = 0..5, 'first line' = 0..10. */
const ORIGINAL = 'first line\nsecond line\n';
const MID_FIRST = 5;
const END_FIRST_LINE = 10;

const PASTE_MIXED = 'A\r\nB\rC\nD';
const PASTE_MIXED_NORMALIZED = 'A\nB\nC\nD';
const PASTE_HTML = '<b>A</b><div>B</div><div>C</div><div>D</div>';

const uri = (p: string) => `file://${p}`;

interface PreSnapshot {
	editing: boolean;
	text: string | null;
	innerHTML: string | null;
	children: number;
	hasDivOrBr: boolean;
	caret: number;
}

interface EventOutcome extends PreSnapshot {
	dispatched: boolean;
	defaultPrevented: boolean;
	error: string | null;
}

interface ReturnInit {
	shiftKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	ctrlKey?: boolean;
	isComposing?: boolean;
	keyCode?: number;
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
			return {
				editing: editing !== null,
				text: pre?.textContent ?? null,
				innerHTML: pre?.innerHTML ?? null,
				children: pre?.childElementCount ?? -1,
				hasDivOrBr: pre?.querySelector('div, br') !== null,
				caret,
			};
		},
		EDITOR,
		BODY,
	);
}

/**
 * Put the caret (or a selection) at character offsets of the editor's
 * `textContent`, walking the text nodes (WebKit splits them after an insert).
 */
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

/** Dispatch a Return `keydown` on the editor and read what it did. */
async function pressReturn(init: ReturnInit = {}): Promise<EventOutcome> {
	const r = await browser.execute(
		(editorSel, i) => {
			const pre = document.querySelector<HTMLElement>(editorSel);
			if (!pre) return { dispatched: false, defaultPrevented: false, error: 'editor not open' };
			try {
				const ev = new KeyboardEvent('keydown', {
					key: 'Enter',
					code: 'Enter',
					keyCode: i.keyCode ?? 13,
					which: i.keyCode ?? 13,
					bubbles: true,
					cancelable: true,
					composed: true,
					shiftKey: !!i.shiftKey,
					altKey: !!i.altKey,
					metaKey: !!i.metaKey,
					ctrlKey: !!i.ctrlKey,
					isComposing: !!i.isComposing,
				});
				pre.dispatchEvent(ev);
				return { dispatched: true, defaultPrevented: ev.defaultPrevented, error: null };
			} catch (e) {
				return { dispatched: false, defaultPrevented: false, error: String(e) };
			}
		},
		EDITOR,
		init,
	);
	await browser.pause(150);
	return { ...r, ...(await preSnapshot()) };
}

/**
 * Dispatch a `paste` on the editor with a real `DataTransfer` (text/plain and,
 * when given, text/html). WebKit performs no default insertion for an untrusted
 * ClipboardEvent, so what ends up in the `<pre>` is the fix's doing.
 */
async function pasteInto(data: { plain: string | null; html?: string }): Promise<EventOutcome> {
	const r = await browser.execute(
		(editorSel, d) => {
			const pre = document.querySelector<HTMLElement>(editorSel);
			if (!pre) return { dispatched: false, defaultPrevented: false, error: 'editor not open' };
			try {
				if (typeof DataTransfer !== 'function') throw new Error('DataTransfer constructor missing');
				const dt = new DataTransfer();
				if (d.plain !== null) dt.setData('text/plain', d.plain);
				if (d.html !== undefined) dt.setData('text/html', d.html);
				const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
				const roundTrip = ev.clipboardData?.getData('text/plain') ?? null;
				if (d.plain !== null && roundTrip !== d.plain) throw new Error(`clipboardData did not carry text/plain (got ${JSON.stringify(roundTrip)})`);
				pre.dispatchEvent(ev);
				return { dispatched: true, defaultPrevented: ev.defaultPrevented, error: null };
			} catch (e) {
				return { dispatched: false, defaultPrevented: false, error: String(e) };
			}
		},
		EDITOR,
		data,
	);
	await browser.pause(150);
	return { ...r, ...(await preSnapshot()) };
}

/** Type with WebKit's own editing (`insertText` fires `input` like a key press would). */
async function typeText(text: string): Promise<boolean> {
	const ok = await browser.execute((t) => document.execCommand('insertText', false, t), text);
	await browser.pause(150);
	return ok;
}

/** Command + Z's undo manager, driven from the page (the native menu is out of WebDriver's reach). */
async function undo(): Promise<boolean> {
	const ok = await browser.execute(() => document.execCommand('undo'));
	await browser.pause(150);
	return ok;
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

/** Bytes of the file on disk, with the counts the gate cares about. */
function onDiskBytes(): { text: string; lf: number; cr: number; equalsUtf8: (s: string) => boolean } {
	const bytes = fs.readFileSync(editFile);
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

/** Expand `req48n-gate/` if its rows are not shown. */
async function ensureGateDirExpanded(): Promise<void> {
	if (await explorerHasRow(uri(editFile))) return;
	await waitForExplorerRow(uri(gateDir), { timeout: 20_000, nudgeDir: startRoot, nudgePrefix: 'req48n' });
	await clickExplorerRow(uri(gateDir));
	await waitForExplorerRow(uri(editFile), { timeout: 15_000 });
}

/** Open newline.txt in the plain view (text as on disk). */
async function openFileForViewing(expectedText: string = fs.readFileSync(editFile, 'utf8')): Promise<void> {
	await ensureGateDirExpanded();
	await clickExplorerRow(uri(editFile));
	await browser.waitUntil(
		async () => {
			const v = await preSnapshot();
			return !v.editing && v.text === expectedText;
		},
		{ timeout: 15_000, timeoutMsg: `newline.txt did not open in the plain-text view (now: ${JSON.stringify(await preSnapshot())})` },
	);
}

/** Open newline.txt and enter the editor with the Edit menu event (Command + E). */
async function openFileAndEnterEditor(): Promise<void> {
	await openFileForViewing();
	await emitMenu('menu_edit');
	await browser.waitUntil(async () => (await preSnapshot()).editing, {
		timeout: 5_000,
		timeoutMsg: 'menu_edit did not enter the editor',
	});
	const v = await preSnapshot();
	expect(v.text).toBe(ORIGINAL);
	expect(v.children).toBe(0);
}

/** Command + S = File > Save, then wait until the file on disk is `expected`. */
async function saveAndWaitForDisk(expected: string): Promise<void> {
	await emitMenu('menu_save');
	await browser.waitUntil(async () => fs.readFileSync(editFile, 'utf8') === expected, {
		timeout: 10_000,
		timeoutMsg: `menu_save did not write the expected text (on disk now: ${JSON.stringify(fs.readFileSync(editFile, 'utf8'))})`,
	});
}

/**
 * Leave the editor without a dialog: put the text back to what is on disk (the
 * buffer is then not dirty) and press Done Editing, which asks nothing then.
 */
async function revertEditAndLeaveEditor(): Promise<void> {
	if (!(await preSnapshot()).editing) return;
	const onDisk = fs.readFileSync(editFile, 'utf8');
	await browser.execute(
		(editorSel, text) => {
			const pre = document.querySelector<HTMLElement>(editorSel)!;
			pre.textContent = text;
			pre.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
			document.querySelector<HTMLButtonElement>('[data-testid="edit-done"]')?.click();
		},
		EDITOR,
		onDisk,
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

describe('Requirement #48 追補n human gate (Return and paste in the source editor keep their line breaks)', () => {
	before(async () => {
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await setIpcCapture(['save_document']);
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		fs.rmSync(gateDir, { recursive: true, force: true });
		fs.mkdirSync(gateDir, { recursive: true });
		fs.writeFileSync(editFile, ORIGINAL);
		await ensureGateDirExpanded();
	});

	/**
	 * Every test ends out of the editor with the fixture back to ORIGINAL — also
	 * when an assertion failed half-way, so one failure cannot cascade.
	 */
	afterEach(async () => {
		const problems: Record<string, string> = {};
		try {
			await revertEditAndLeaveEditor();
		} catch (err) {
			problems.leaveEditor = String(err);
		}
		if (fs.existsSync(gateDir) && fs.readFileSync(editFile, 'utf8') !== ORIGINAL) fs.writeFileSync(editFile, ORIGINAL);
		try {
			await clearLogs();
		} catch (err) {
			problems.clearLogs = String(err);
		}
		if (Object.keys(problems).length > 0) report(REPORT, { gate: '48n-after-each', ...problems });
	});

	after(async () => {
		await restoreGateRecorder();
		fs.rmSync(gateDir, { recursive: true, force: true });
		for (const name of fs.readdirSync(startRoot)) {
			if (name.startsWith('req48n-')) fs.rmSync(path.join(startRoot, name), { recursive: true, force: true });
		}
	});

	it('gate n-1: Return in the middle of a line → type → Command + S → the file has the line break, and so does the reopened document', async () => {
		await openFileAndEnterEditor();
		await clearLogs();

		// Return after "first" (契約1): one `\n` as a character, no <div> / <br>.
		await placeCaret(MID_FIRST);
		const ret = await pressReturn();
		const afterReturn = 'first\n line\nsecond line\n';
		// Type on the new line, with WebKit's own editing.
		const typed = await typeText('typed');
		const afterType = await preSnapshot();
		const expected = 'first\ntyped line\nsecond line\n';
		await safeShot('req48n-gate1-after-return-and-type');
		report(REPORT, { gate: '48n-1-return', ret, typed, afterType });

		expect(ret.dispatched).toBe(true);
		expect(ret.defaultPrevented).toBe(true);
		expect(ret.hasDivOrBr).toBe(false);
		expect(ret.children).toBe(0);
		expect(ret.text).toBe(afterReturn);
		expect(ret.caret).toBe(MID_FIRST + 1);
		expect(typed).toBe(true);
		expect(afterType.text).toBe(expected);
		expect(afterType.hasDivOrBr).toBe(false);

		// Command + S (契約3 / AC (d)): the bytes on disk carry the `\n`.
		await saveAndWaitForDisk(expected);
		const disk = onDiskBytes();
		const saveCalls = (await readCapturedIpc())
			.filter((c) => c.cmd === 'save_document')
			.map((c) => ({ ok: c.ok, content: (c.args as { content?: string } | null)?.content ?? null }));
		report(REPORT, { gate: '48n-1-saved', disk: { text: disk.text, lf: disk.lf, cr: disk.cr, equalsExpected: disk.equalsUtf8(expected) }, saveCalls });
		expect(disk.equalsUtf8(expected)).toBe(true);
		expect(disk.lf).toBe(3);
		expect(disk.cr).toBe(0);
		expect(saveCalls.length).toBe(1);
		expect(saveCalls[0]!.ok).toBe(true);
		expect(saveCalls[0]!.content).toBe(expected);

		// Reopen: leave the (clean) editor, open another document, come back.
		const left = await leaveEditorExpectingNoAsk();
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
		await clickExplorerRow(uri(otherFile));
		await browser.waitUntil(
			async () => browser.execute((body) => document.querySelector(`${body} pre.vellis-plaintext`) === null, BODY),
			{ timeout: 15_000, timeoutMsg: 'start-doc.md did not replace the plain-text view' },
		);
		await openFileForViewing(expected);
		const reopened = await preSnapshot();
		await safeShot('req48n-gate1-reopened');
		report(REPORT, { gate: '48n-1-reopened', reopened, dialogs: (await readGateRecord()).dialogs });
		expect(reopened.editing).toBe(false);
		expect(reopened.text).toBe(expected);
	});

	it('gate n-2: the Return that confirms an IME conversion, and Command / Control + Return, insert nothing; Shift + Return does', async () => {
		await openFileAndEnterEditor();
		await clearLogs();
		await placeCaret(MID_FIRST);

		const cases: Array<[string, ReturnInit]> = [
			['isComposing', { isComposing: true }],
			['keyCode 229', { keyCode: 229 }],
			['isComposing + keyCode 229', { isComposing: true, keyCode: 229 }],
			['Command', { metaKey: true }],
			['Control', { ctrlKey: true }],
		];
		const outcomes: Array<{ label: string } & EventOutcome> = [];
		for (const [label, init] of cases) {
			await placeCaret(MID_FIRST);
			outcomes.push({ label, ...(await pressReturn(init)) });
		}
		await placeCaret(MID_FIRST);
		const shift = await pressReturn({ shiftKey: true });
		await safeShot('req48n-gate2-ime-and-modifiers');
		report(REPORT, { gate: '48n-2-pass-through', outcomes, shift });

		// Compared as labelled rows so a failure names the case.
		const rows = outcomes.map((o) => ({ label: o.label, dispatched: o.dispatched, defaultPrevented: o.defaultPrevented, text: o.text, hasDivOrBr: o.hasDivOrBr }));
		expect(rows).toEqual(
			cases.map(([label]) => ({ label, dispatched: true, defaultPrevented: false, text: ORIGINAL, hasDivOrBr: false })),
		);
		expect(shift.defaultPrevented).toBe(true);
		expect(shift.text).toBe('first\n line\nsecond line\n');
		expect(shift.hasDivOrBr).toBe(false);
		expect(fs.readFileSync(editFile, 'utf8')).toBe(ORIGINAL);
	});

	it('gate n-3: pasting several lines keeps the lines (CRLF / CR / LF → \\n, text/html unused, a selection replaced, empty text/plain inserts nothing) and the save writes them', async () => {
		await openFileAndEnterEditor();
		await clearLogs();

		// 1. Mixed line endings at the end of the first line, with an HTML flavour
		//    the fix must ignore (契約2).
		await placeCaret(END_FIRST_LINE);
		const p1 = await pasteInto({ plain: PASTE_MIXED, html: PASTE_HTML });
		const after1 = 'first line' + PASTE_MIXED_NORMALIZED + '\nsecond line\n';
		// 2. Replace the selected "second" (offsets 18..24 after step 1).
		const secondAt = after1.indexOf('second');
		await placeCaret(secondAt, secondAt + 'second'.length);
		const p2 = await pasteInto({ plain: 'X\r\nY', html: '<i>X</i><div>Y</div>' });
		const after2 = after1.replace('second', 'X\nY');
		// 3. Empty text/plain with HTML only: the default is stopped, nothing goes in.
		await placeCaret(MID_FIRST);
		const p3 = await pasteInto({ plain: '', html: '<b>nope</b>' });
		await safeShot('req48n-gate3-after-pastes');
		report(REPORT, { gate: '48n-3-pastes', p1, p2, p3 });

		expect(p1.dispatched).toBe(true);
		expect(p1.defaultPrevented).toBe(true);
		expect(p1.text).toBe(after1);
		expect(p1.hasDivOrBr).toBe(false);
		expect(p1.children).toBe(0);
		expect(p1.text).not.toContain('\r');
		expect(p1.caret).toBe(END_FIRST_LINE + PASTE_MIXED_NORMALIZED.length);
		expect(p2.defaultPrevented).toBe(true);
		expect(p2.text).toBe(after2);
		expect(p2.hasDivOrBr).toBe(false);
		expect(p3.dispatched).toBe(true);
		expect(p3.defaultPrevented).toBe(true);
		expect(p3.text).toBe(after2);
		expect(p3.hasDivOrBr).toBe(false);

		// Command + S: the lines are on disk, byte for byte, with no CR.
		await saveAndWaitForDisk(after2);
		const disk = onDiskBytes();
		const saveCalls = (await readCapturedIpc())
			.filter((c) => c.cmd === 'save_document')
			.map((c) => ({ ok: c.ok, content: (c.args as { content?: string } | null)?.content ?? null }));
		report(REPORT, { gate: '48n-3-saved', disk: { text: disk.text, lf: disk.lf, cr: disk.cr, equalsExpected: disk.equalsUtf8(after2) }, saveCalls });
		expect(disk.equalsUtf8(after2)).toBe(true);
		expect(disk.cr).toBe(0);
		expect(disk.lf).toBe((after2.match(/\n/g) ?? []).length);
		expect(saveCalls.length).toBe(1);
		expect(saveCalls[0]!.content).toBe(after2);

		const left = await leaveEditorExpectingNoAsk();
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
	});

	it('gate n-4: one undo each takes back the Return and the paste (契約4: WebKit editing commands, Command + Z driven as document.execCommand("undo"))', async () => {
		await openFileAndEnterEditor();
		await clearLogs();

		await placeCaret(MID_FIRST);
		const ret = await pressReturn();
		const undoReturnOk = await undo();
		const afterUndoReturn = await preSnapshot();

		await placeCaret(END_FIRST_LINE);
		const paste = await pasteInto({ plain: 'A\r\nB', html: '<b>A</b><div>B</div>' });
		const undoPasteOk = await undo();
		const afterUndoPaste = await preSnapshot();
		await safeShot('req48n-gate4-after-undo');
		report(REPORT, { gate: '48n-4-undo', ret, undoReturnOk, afterUndoReturn, paste, undoPasteOk, afterUndoPaste });

		expect(ret.text).toBe('first\n line\nsecond line\n');
		expect(undoReturnOk).toBe(true);
		expect(afterUndoReturn.text).toBe(ORIGINAL);
		expect(afterUndoReturn.hasDivOrBr).toBe(false);
		expect(paste.text).toBe('first lineA\nB\nsecond line\n');
		expect(undoPasteOk).toBe(true);
		expect(afterUndoPaste.text).toBe(ORIGINAL);
		expect(afterUndoPaste.hasDivOrBr).toBe(false);

		// The undo also brought the buffer back (契約3: `input` after undo → buffer =
		// textContent), so Done Editing asks nothing.
		const left = await leaveEditorExpectingNoAsk();
		report(REPORT, { gate: '48n-4-left-editor', ...left });
		expect(left.left).toBe(true);
		expect(left.asks).toBe(0);
		expect(fs.readFileSync(editFile, 'utf8')).toBe(ORIGINAL);
	});
});
