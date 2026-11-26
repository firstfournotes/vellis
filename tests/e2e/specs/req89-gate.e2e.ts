import { browser } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
	clickExplorerRow,
	emitMenu,
	explorerNames,
	faceText,
	installEventRecorder,
	installGateRecorder,
	mdFaceText,
	readCapturedIpc,
	removeEventRecorder,
	report,
	restoreGateRecorder,
	setIpcCapture,
	SHOTS_DIR,
	waitForAppMounted,
	waitForExplorerRow,
	waitForFace,
} from '../gate-helpers';

/**
 * 要件#89 AC-89-10 — the device gate (webdriver only; no real input, no operator). Modelled on
 * issue848-gate.e2e.ts: an 80-paragraph Markdown file scrolled to the end, a paragraph near the end
 * edited by the user, the same paragraph written from outside (tmp + rename, as AI tools write).
 *
 * What the gate judges (each judgement = one JSON line in `$VELLIS_GATE_SHOTS/req89-report.jsonl`,
 * `pass` true / false; a line without `pass` is a fact):
 *  - (m1) Markdown face: overlap → the banner has Merge… → the merge view lists one chunk (the user's
 *         paragraph against the AI's), Apply is disabled until a choice is made → My Edits → Apply →
 *         the banner is down, Unsaved stays, the face holds the user's paragraph AND the AI's
 *         non-overlapping paragraph (merged automatically) → Command + S (menu_save) is accepted with
 *         an expectedHash and the disk is exactly as chosen
 *  - (m2) CodeMirror face: the same with Both → both versions of the line land on disk in that order
 *  - (m3) Cancel changes nothing (banner, face, Unsaved)
 *  - (s1) Save As… inside the root: the save dialog is asked with defaultPath = the current file; the
 *         chosen file holds the face's text byte for byte; the original is untouched; the window shows
 *         the new file (active Explorer row, set_tab_title), not dirty, no banner, no Unsaved dialog
 *  - (s2) Save As… outside the root: the file is written and the root switches to its folder
 *  - (s3) Cancel in the dialog: nothing is written, the face stays dirty
 *  - (s4) Save As… while the conflict banner is up (the escape route of Issue #848): the new file holds
 *         the user's edit, the window switches, the banner is gone
 *  - (s5) the native menu bar (AX): File ▸ Save As… shows Shift + Command + S and pressing it runs the
 *         same path (save_document_as)
 *  - the last `it` fails when any judgement failed, so the wdio exit status is the verdict
 *
 * The native save panel cannot be driven by webdriver and AX against an NSSavePanel (a remote view
 * service) is the least reliable part of a gate, so the dialog is stubbed at the IPC seam the app
 * already has: `plugin:dialog|save` (the request of `save()` from @tauri-apps/plugin-dialog) is
 * answered by a `fetch` wrapper with the path the gate chose (or null for Cancel) and the options the
 * app sent are recorded — which is how 契約2 (defaultPath) is judged on the device. The Unsaved Changes
 * dialog (plugin:dialog|message) is answered "Don't Save" by the same stub, and counted: a Save As…
 * that switches the window must NOT ask it (the content was just written).
 *
 * Fixtures (run-gate-spec.sh `req89`): ma・mb・sa・sb・sc .md = the 80-paragraph "Long report" (one
 * paragraph = one line), merge.txt = 30 lines, an empty `sub/` folder inside the root, and an empty
 * folder outside the root at $VELLIS_GATE_REQ89_OUTSIDE.
 *
 * Build and run (the binary is a copy outside src-tauri/target, not named `vellis` — lib.sh):
 *   pnpm tauri build --debug --no-bundle -f webdriver
 *   cp src-tauri/target/debug/vellis <out>/vellis-gate89
 *   xcrun swiftc -O scripts/gate-device/axtool.swift -o <out>/axtool
 *   export VELLIS_GATE_BIN=<out>/vellis-gate89 VELLIS_GATE_AXTOOL=<out>/axtool VELLIS_GATE_OUT=<out>
 *   scripts/gate-device/run-gate-spec.sh req89
 * Runs only under that script (VELLIS_GATE_DEVICE=1); self-skipping otherwise.
 *
 * Selectors the implementation must provide (the contract of Viewer.merge.wiring.test.ts and
 * src/lib/save-as.wiring.test.ts): external-conflict-merge / merge-view / merge-chunk /
 * merge-chunk-mine / merge-chunk-theirs / merge-choose-mine / merge-choose-theirs / merge-choose-both /
 * merge-apply / merge-cancel; the menu event `menu_save_as`; the command `save_document_as` with
 * `{ path, content }`; the menu item "Save As…" with Shift + Command + S.
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const outside = process.env.VELLIS_GATE_REQ89_OUTSIDE ?? '';
const REPORT = 'req89-report.jsonl';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';

const fileOf = (rel: string) => path.join(root, rel);
const uriOf = (rel: string) => `file://${fileOf(rel).split(path.sep).join('/')}`;
const uriOfAbs = (abs: string) => `file://${abs.split(path.sep).join('/')}`;

const BADGE = 'article.viewer [data-testid="unsaved-badge"]';
const CONFLICT = '[data-testid="external-conflict-banner"]';
const CONFLICT_MERGE = '[data-testid="external-conflict-merge"]';
const MERGE_VIEW = '[data-testid="merge-view"]';
const MERGE_CHUNK = '[data-testid="merge-chunk"]';
const MERGE_APPLY = '[data-testid="merge-apply"]';
const MERGE_CANCEL = '[data-testid="merge-cancel"]';
const SAVE_CONFLICT_PREFIX = 'The file was changed on disk';
const SAVE_AS_COMMAND = 'save_document_as';
const MENU_SAVE_AS_EVENT = 'menu_save_as';

// --- judgement ---------------------------------------------------------------------------------

const fails: string[] = [];
function judge(gate: string, item: string, pass: boolean, extra: Record<string, unknown> = {}): boolean {
	report(REPORT, { gate, item, pass, ...extra });
	if (!pass) fails.push(`${gate}: ${item}`);
	return pass;
}
function fact(gate: string, item: string, extra: Record<string, unknown> = {}): void {
	report(REPORT, { gate, item, ...extra });
}
function skipped(gate: string, item: string, why: string): void {
	report(REPORT, { gate, item, note: `skipped: ${why}` });
}

// --- the disk ----------------------------------------------------------------------------------

/** As AI tools and editors save: a sibling, then a rename over the file (a new inode). */
function writeAtomic(abs: string, content: string): void {
	const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, abs);
}
const edit = (from: string, to: string) => (s: string) => {
	if (!s.includes(from)) throw new Error(`fixture has no ${JSON.stringify(from)}`);
	return s.replace(from, to);
};
const paragraph = (n: number) => `topic ${n} in one long line`;
const readIf = (abs: string): string | null => (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);

// --- the page ----------------------------------------------------------------------------------

async function exists(sel: string): Promise<boolean> {
	return browser.execute((s) => document.querySelector(s) !== null, sel);
}
async function waitFor(sel: string, what: string, timeout = 10_000): Promise<boolean> {
	return browser
		.waitUntil(async () => exists(sel), { timeout, timeoutMsg: `${what}: ${sel} never appeared` })
		.then(() => true)
		.catch(() => false);
}
async function waitGone(sel: string, what: string, timeout = 10_000): Promise<boolean> {
	return browser
		.waitUntil(async () => !(await exists(sel)), { timeout, timeoutMsg: `${what}: ${sel} is still there` })
		.then(() => true)
		.catch(() => false);
}
async function click(sel: string): Promise<boolean> {
	return browser.execute((s) => {
		const el = document.querySelector<HTMLElement>(s);
		if (!el) return false;
		el.click();
		return true;
	}, sel);
}
async function isDisabled(sel: string): Promise<boolean | null> {
	return browser.execute((s) => {
		const el = document.querySelector<HTMLButtonElement>(s);
		return el ? el.disabled : null;
	}, sel);
}
async function pmText(): Promise<string> {
	return (await mdFaceText()) ?? '';
}
async function anyText(): Promise<string> {
	return (await mdFaceText()) ?? (await faceText()) ?? '';
}
/** The Explorer row shown as the current document (`.explorer-item.active`), by its URI (the row's title). */
async function activeRowUri(): Promise<string | null> {
	return browser.execute(() => document.querySelector<HTMLElement>('.explorer-item.active')?.title ?? null);
}
/**
 * Wait until the active Explorer row is `uri`. On a miss the evidence for the report: the active row,
 * every Explorer row (title = URI), the window's document.title, the `set_tab_title` calls since
 * `mark` (docUri = the window's current document), and a screenshot.
 */
async function waitForSwitch(uri: string, mark: number, shotName: string): Promise<{ switched: boolean; evidence: Record<string, unknown> }> {
	const switched = await browser
		.waitUntil(async () => (await activeRowUri()) === uri, { timeout: 10_000 })
		.then(() => true)
		.catch(() => false);
	const evidence: Record<string, unknown> = {
		expected: uri,
		active: await activeRowUri(),
		tabTitles: await tabTitlesSince(mark),
		documentTitle: await browser.execute(() => document.title),
		rows: await browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).map((r) => r.title)),
		rowNames: await explorerNames(),
		badge: await exists(BADGE),
		banner: await exists(CONFLICT),
	};
	if (!switched) evidence.screenshot = await shot(shotName);
	return { switched, evidence };
}
/** Put the caret at the end of the CodeMirror line that holds `needle` and type `text` (not the face's last line, which may be an empty line 31 after a trailing newline). */
async function typeAtEndOfCmLine(needle: string, text: string): Promise<boolean> {
	return browser.execute(
		(sel, nd, t) => {
			const content = document.querySelector<HTMLElement>(sel);
			if (!content) return false;
			const line = Array.from(content.querySelectorAll<HTMLElement>('.cm-line')).find((l) => (l.textContent ?? '').includes(nd));
			if (!line) return false;
			content.focus();
			const range = document.createRange();
			range.selectNodeContents(line);
			range.collapse(false);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			return document.execCommand('insertText', false, t);
		},
		'article.viewer [data-testid="code-editor"] .cm-content',
		needle,
		text,
	);
}
/** Put the caret at the end of the text that holds `needle` in the ProseMirror face and type `text`. */
async function typeAfter(needle: string, text: string): Promise<boolean> {
	return browser.execute(
		(sel, nd, t) => {
			const rootEl = document.querySelector<HTMLElement>(sel);
			if (!rootEl) return false;
			const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
			let node: Text | null = null;
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				if ((n as Text).data.includes(nd)) {
					node = n as Text;
					break;
				}
			}
			if (!node) return false;
			rootEl.focus();
			const i = node.data.indexOf(nd) + nd.length;
			const r = document.createRange();
			r.setStart(node, i);
			r.setEnd(node, i);
			const s = window.getSelection();
			s?.removeAllRanges();
			s?.addRange(r);
			return document.execCommand('insertText', false, t);
		},
		'article.viewer [data-testid="markdown-editor"] .ProseMirror',
		needle,
		text,
	);
}
async function scrollViewerTo(where: 'bottom' | number): Promise<void> {
	await browser.execute((w) => {
		const v = document.querySelector<HTMLElement>('article.viewer');
		if (v) v.scrollTop = w === 'bottom' ? v.scrollHeight : (w as number);
	}, where);
	await browser.pause(300);
}
interface Visibility {
	exists: boolean;
	onScreen: boolean;
	hitIsTarget: boolean;
	rect: { top: number; bottom: number; height: number } | null;
}
/** The element lies in the visible viewer band (below the toolbar, above the window's bottom) and the hit test lands on it. */
async function visibility(sel: string): Promise<Visibility> {
	return browser.execute((s) => {
		const el = document.querySelector<HTMLElement>(s);
		const viewer = document.querySelector<HTMLElement>('article.viewer');
		const tb = document.querySelector<HTMLElement>('article.viewer .viewer-toolbar');
		const vr = viewer?.getBoundingClientRect();
		const top = tb ? tb.getBoundingClientRect().bottom : (vr?.top ?? 0);
		const bottom = Math.min(vr?.bottom ?? window.innerHeight, window.innerHeight);
		if (!el) return { exists: false, onScreen: false, hitIsTarget: false, rect: null };
		const r = el.getBoundingClientRect();
		const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return {
			exists: true,
			onScreen: r.height > 0 && r.top >= top - 1 && r.bottom <= bottom + 1,
			hitIsTarget: !!hit && (hit === el || el.contains(hit)),
			rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) },
		};
	}, sel);
}
async function shot(name: string): Promise<string> {
	const file = path.join(SHOTS_DIR, `${name}.png`);
	fs.mkdirSync(SHOTS_DIR, { recursive: true });
	await browser.saveScreenshot(file);
	return file;
}

// --- the merge view ----------------------------------------------------------------------------

interface ChunkRead {
	index: string;
	mine: string;
	theirs: string;
}
async function readChunks(): Promise<ChunkRead[]> {
	return browser.execute((sel) =>
		Array.from(document.querySelectorAll<HTMLElement>(sel)).map((el) => ({
			index: el.getAttribute('data-index') ?? '',
			mine: el.querySelector('[data-testid="merge-chunk-mine"]')?.textContent ?? '',
			theirs: el.querySelector('[data-testid="merge-chunk-theirs"]')?.textContent ?? '',
		})),
		MERGE_CHUNK,
	);
}
async function choose(index: number, choice: 'mine' | 'theirs' | 'both'): Promise<boolean> {
	return browser.execute(
		(sel, i, c) => {
			const chunk = document.querySelectorAll<HTMLElement>(sel)[i];
			const b = chunk?.querySelector<HTMLElement>(`[data-testid="merge-choose-${c}"]`);
			if (!b) return false;
			b.click();
			return true;
		},
		MERGE_CHUNK,
		index,
		choice,
	);
}

// --- IPC: saves, Save As…, the tab title -------------------------------------------------------

interface SaveRecord {
	ok: boolean;
	body: unknown;
	expectedHash: string | null;
}
async function ipcMark(): Promise<number> {
	return (await readCapturedIpc()).length;
}
async function cmdsSince(mark: number, cmd: string) {
	return (await readCapturedIpc()).slice(mark).filter((c) => c.cmd === cmd);
}
async function waitForCmd(mark: number, cmd: string, timeout = 8_000): Promise<boolean> {
	return browser
		.waitUntil(async () => (await cmdsSince(mark, cmd)).length > 0, { timeout })
		.then(() => true)
		.catch(() => false);
}
async function savesSince(mark: number): Promise<SaveRecord[]> {
	return (await cmdsSince(mark, 'save_document')).map((s) => ({
		ok: s.ok,
		body: s.body,
		expectedHash: (s.args as { expectedHash?: string } | null)?.expectedHash ?? null,
	}));
}
async function saveByMenuEvent(): Promise<{ saves: SaveRecord[]; refused: boolean; written: boolean }> {
	const mark = await ipcMark();
	await emitMenu('menu_save');
	await waitForCmd(mark, 'save_document');
	await browser.pause(800);
	const saves = await savesSince(mark);
	return {
		saves,
		refused: saves.some((s) => s.ok === false && String(s.body ?? '').startsWith(SAVE_CONFLICT_PREFIX)),
		written: saves.some((s) => s.ok === true),
	};
}
interface SaveAsRecord {
	ok: boolean;
	body: unknown;
	path: string | null;
	content: string | null;
}
async function saveAsSince(mark: number): Promise<SaveAsRecord[]> {
	return (await cmdsSince(mark, SAVE_AS_COMMAND)).map((s) => {
		const args = s.args as { path?: string; content?: string } | null;
		return { ok: s.ok, body: s.body, path: args?.path ?? null, content: args?.content ?? null };
	});
}
/** `set_tab_title` calls since `mark` ({ root, docUri }). */
async function tabTitlesSince(mark: number): Promise<Array<{ root: string | null; docUri: string | null }>> {
	return (await cmdsSince(mark, 'set_tab_title')).map((s) => {
		const args = s.args as { root?: string | null; docUri?: string | null } | null;
		return { root: args?.root ?? null, docUri: args?.docUri ?? null };
	});
}

// --- the dialog stub ---------------------------------------------------------------------------

interface DialogStub {
	/** What the next `plugin:dialog|save` answers (a path, or null = Cancel). */
	saveAnswer: string | null;
	/** The options of every save dialog asked ({ defaultPath, … } as the app sent them). */
	saves: unknown[];
	/** Every Unsaved Changes (message) dialog asked, answered "Don't Save". */
	messages: string[];
}
async function installDialogStub(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __req89?: DialogStub };
		if (w.__req89) return;
		const stub: DialogStub = { saveAnswer: null, saves: [], messages: [] };
		w.__req89 = stub;
		const inner = window.fetch;
		const ok = (body: unknown) =>
			Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } }));
		window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
			const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
			const cmd = decodeURIComponent(url);
			if (cmd.startsWith('ipc://localhost/plugin:dialog|save')) {
				let options: unknown = null;
				try {
					options = typeof init?.body === 'string' ? (JSON.parse(init.body) as { options?: unknown }).options ?? null : null;
				} catch {
					options = init?.body ?? null;
				}
				stub.saves.push(options);
				return ok(stub.saveAnswer);
			}
			if (cmd.startsWith('ipc://localhost/plugin:dialog|message')) {
				stub.messages.push(typeof init?.body === 'string' ? init.body : '?');
				return ok("Don't Save");
			}
			return inner.call(this, input, init);
		} as typeof window.fetch;
	});
}
async function setSaveAnswer(answer: string | null): Promise<void> {
	await browser.execute((a) => {
		const w = window as unknown as { __req89?: DialogStub };
		if (!w.__req89) throw new Error('dialog stub is not installed');
		w.__req89.saveAnswer = a;
	}, answer);
}
async function readStub(): Promise<Pick<DialogStub, 'saves' | 'messages'>> {
	return browser.execute(() => {
		const w = window as unknown as { __req89?: DialogStub };
		return { saves: w.__req89?.saves ?? [], messages: w.__req89?.messages ?? [] };
	});
}
const defaultPathOf = (options: unknown): string | null => (options && typeof options === 'object' ? ((options as { defaultPath?: string }).defaultPath ?? null) : null);

/** Save As… through the menu event with the stubbed dialog answering `answer`. */
async function saveAsByMenuEvent(answer: string | null) {
	const before = await readStub();
	await setSaveAnswer(answer);
	const mark = await ipcMark();
	await emitMenu(MENU_SAVE_AS_EVENT);
	const came = await browser
		.waitUntil(async () => (await readStub()).saves.length > before.saves.length, { timeout: 8_000 })
		.then(() => true)
		.catch(() => false);
	if (answer !== null) await waitForCmd(mark, SAVE_AS_COMMAND);
	await browser.pause(1_200);
	const after = await readStub();
	return {
		dialogAsked: came,
		dialogOptions: after.saves.slice(before.saves.length),
		messagesAsked: after.messages.length - before.messages.length,
		saveAs: await saveAsSince(mark),
		tabTitles: await tabTitlesSince(mark),
		mark,
	};
}

// --- AX ----------------------------------------------------------------------------------------

function appPid(): number | null {
	if (!axtool || !bin) return null;
	const env = { ...process.env, AXTOOL_EXPECT_EXE: bin };
	const first = execFileSync(axtool, ['pids-of-exe', bin], { encoding: 'utf8', env, timeout: 30_000 }).trim().split('\n')[0];
	return first ? (JSON.parse(first) as { pid: number }).pid : null;
}
interface MenuDetail {
	title: string;
	enabled: boolean;
	cmd_char: string;
	cmd_modifiers: number;
	separator: boolean;
	submenu: boolean;
}
function fileMenuDetail(pid: number): MenuDetail[] {
	const env = { ...process.env, AXTOOL_EXPECT_EXE: bin };
	const out = execFileSync(axtool, ['menudetail', String(pid), 'File'], { encoding: 'utf8', env, timeout: 30_000 }).trim();
	return out ? out.split('\n').map((l) => JSON.parse(l) as MenuDetail) : [];
}
function pressFileMenu(pid: number, item: string): string {
	const env = { ...process.env, AXTOOL_EXPECT_EXE: bin };
	return execFileSync(axtool, ['menu', String(pid), 'File', item], { encoding: 'utf8', env, timeout: 30_000 }).trim();
}

// --- opening -----------------------------------------------------------------------------------

async function openMd(rel: string): Promise<void> {
	await clickExplorerRow(uriOf(rel));
	await browser.waitUntil(async () => (await pmText()).includes('Long report'), { timeout: 20_000, timeoutMsg: `open ${rel}` });
	await browser.pause(600);
}
async function openTxt(rel: string, marker: string): Promise<void> {
	await clickExplorerRow(uriOf(rel));
	await waitForFace(marker, 20_000);
	await browser.pause(600);
}

// --- the gates: merge --------------------------------------------------------------------------

/** (m1) ma.md: paragraph 78 edited by both, paragraph 3 by the AI only → Merge… → My Edits → Apply → Save. */
async function gateMergeMarkdown(rel: string): Promise<void> {
	const base = fs.readFileSync(fileOf(rel), 'utf8');
	await scrollViewerTo('bottom');
	if (!(await typeAfter(paragraph(78), ' USER1'))) throw new Error('could not type into paragraph 78');
	await scrollViewerTo('bottom');
	const theirs = edit(paragraph(3), 'topic 3 AI1 in one long line')(edit(paragraph(78), 'topic 78 (edited by the AI) in one long line')(base));
	writeAtomic(fileOf(rel), theirs);
	judge('m1', 'the overlapping external write raises the conflict banner', await waitFor(CONFLICT, 'the conflict banner'), {});
	const v = await visibility(CONFLICT_MERGE);
	judge('m1', 'the banner has a Merge… button on screen (inside the visible viewer area, hit test lands on it)', v.exists && v.onScreen && v.hitIsTarget, { ...v });
	fact('m1', 'screenshot with the banner', { file: await shot('req89-m1-banner') });
	await click(CONFLICT_MERGE);
	judge('m1', 'Merge… opens the merge view', await waitFor(MERGE_VIEW, 'the merge view', 8_000), {});
	const chunks = await readChunks();
	judge('m1', 'exactly one chunk: the user’s paragraph 78 against the AI’s (paragraph 3 is not a chunk — it merges automatically)', chunks.length === 1 && chunks[0]!.mine.includes('USER1') && chunks[0]!.theirs.includes('edited by the AI') && !chunks[0]!.mine.includes('AI1') && !chunks[0]!.theirs.includes('AI1'), { chunks });
	judge('m1', 'Apply is disabled before a choice', (await isDisabled(MERGE_APPLY)) === true, {});
	judge('m1', 'My Edits can be chosen on the chunk', await choose(0, 'mine'), {});
	await browser.pause(300);
	judge('m1', 'Apply is enabled once every chunk is chosen', (await isDisabled(MERGE_APPLY)) === false, {});
	fact('m1', 'screenshot of the merge view with the choice made', { file: await shot('req89-m1-merge') });
	await click(MERGE_APPLY);
	const closed = await waitGone(MERGE_VIEW, 'the merge view after Apply', 8_000);
	const bannerGone = await waitGone(CONFLICT, 'the conflict banner after Apply', 5_000);
	const text = await pmText();
	judge('m1', 'Apply closes the view, takes the banner down, keeps Unsaved, and the face holds the user’s paragraph 78 plus the AI’s paragraph 3', closed && bannerGone && (await exists(BADGE)) && text.includes('USER1') && !text.includes('edited by the AI') && text.includes('topic 3 AI1'), {});
	const s = await saveByMenuEvent();
	const disk = fs.readFileSync(fileOf(rel), 'utf8');
	judge('m1', 'Command + S after Apply is accepted (expectedHash sent, not refused) and the disk is exactly as chosen', s.written && !s.refused && s.saves.every((x) => x.expectedHash !== null) && disk.includes('USER1') && !disk.includes('edited by the AI') && disk.includes('topic 3 AI1'), { saves: s.saves });
	judge('m1', 'after that save the Unsaved badge is gone', !(await exists(BADGE)), {});
}

/** (m2) merge.txt (CodeMirror): the last line edited by both → Merge… → Both → Apply → Save. */
async function gateMergeText(rel: string): Promise<void> {
	const base = fs.readFileSync(fileOf(rel), 'utf8');
	// The fixture ends with a newline, so the face's last `.cm-line` is an empty line 31: type at the END OF
	// LINE 30 itself, so the user's edit and the AI's rewrite of line 30 really overlap (gate run 2026-11-26:
	// appending to the last line landed on line 31, merged cleanly, and no banner came).
	if (!(await typeAtEndOfCmLine('line 30 of the merge fixture', ' USER1'))) throw new Error('could not type at the end of line 30');
	await browser.waitUntil(async () => ((await faceText()) ?? '').includes('line 30 of the merge fixture USER1'), { timeout: 5_000 });
	const typed = (await faceText()) ?? '';
	judge('m2', 'the edit sits on line 30 itself (the line the AI rewrites), so the two changes overlap', typed.includes('line 30 of the merge fixture USER1') && !/\n USER1/.test(typed), { tail: typed.slice(-80) });
	const theirs = edit('line 30 of the merge fixture', 'line 30 AI1')(edit('line 05 of the merge fixture', 'line 05 AI2')(base));
	writeAtomic(fileOf(rel), theirs);
	judge('m2', 'CodeMirror face: the overlapping write raises the conflict banner', await waitFor(CONFLICT, 'the conflict banner'), {});
	await click(CONFLICT_MERGE);
	judge('m2', 'Merge… opens the merge view on the CodeMirror face', await waitFor(MERGE_VIEW, 'the merge view', 8_000), {});
	const chunks = await readChunks();
	judge('m2', 'one chunk (line 30); line 05 merges automatically', chunks.length === 1 && chunks[0]!.mine.includes('USER1') && chunks[0]!.theirs.includes('line 30 AI1'), { chunks });
	judge('m2', 'Both can be chosen', await choose(0, 'both'), {});
	await browser.pause(300);
	await click(MERGE_APPLY);
	const closed = await waitGone(MERGE_VIEW, 'the merge view after Apply', 8_000);
	const text = (await faceText()) ?? '';
	const mineAt = text.indexOf('line 30 of the merge fixture USER1');
	const theirsAt = text.indexOf('line 30 AI1');
	judge('m2', 'Apply with Both: the user’s line, then the AI’s line, and line 05 from the AI; the banner is down; Unsaved stays', closed && !(await exists(CONFLICT)) && (await exists(BADGE)) && mineAt >= 0 && theirsAt > mineAt && text.includes('line 05 AI2'), { mineAt, theirsAt });
	const s = await saveByMenuEvent();
	const disk = fs.readFileSync(fileOf(rel), 'utf8');
	judge('m2', 'Command + S is accepted and the disk holds both lines in that order', s.written && !s.refused && disk.indexOf('line 30 of the merge fixture USER1') >= 0 && disk.indexOf('line 30 AI1') > disk.indexOf('line 30 of the merge fixture USER1') && disk.includes('line 05 AI2'), { saves: s.saves });
}

/** (m3) mb.md: Merge… then Cancel changes nothing. */
async function gateMergeCancel(rel: string): Promise<void> {
	const base = fs.readFileSync(fileOf(rel), 'utf8');
	await scrollViewerTo('bottom');
	if (!(await typeAfter(paragraph(78), ' USER1'))) throw new Error('could not type into paragraph 78');
	writeAtomic(fileOf(rel), edit(paragraph(78), 'topic 78 (edited by the AI) in one long line')(base));
	if (!(await waitFor(CONFLICT, 'the conflict banner'))) throw new Error('no conflict banner');
	const before = await pmText();
	await click(CONFLICT_MERGE);
	if (!(await waitFor(MERGE_VIEW, 'the merge view', 8_000))) throw new Error('no merge view');
	await choose(0, 'theirs');
	await click(MERGE_CANCEL);
	const closed = await waitGone(MERGE_VIEW, 'the merge view after Cancel', 5_000);
	judge('m3', 'Cancel closes the view; the banner, the face and Unsaved are unchanged', closed && (await exists(CONFLICT)) && (await exists(BADGE)) && (await pmText()) === before && before.includes('USER1'), {});
	const s = await saveByMenuEvent();
	judge('m3', 'after Cancel a Save is still refused (nothing was merged, the base is still the old version)', s.refused && !s.written && !fs.readFileSync(fileOf(rel), 'utf8').includes('USER1'), { saves: s.saves });
}

// --- the gates: Save As… -----------------------------------------------------------------------

/** (s1) sa.md → sub/sa-copy.md (inside the root). */
async function gateSaveAsInRoot(rel: string): Promise<void> {
	const original = fs.readFileSync(fileOf(rel), 'utf8');
	if (!(await typeAfter(paragraph(2), ' USER1'))) throw new Error('could not type into paragraph 2');
	await browser.pause(300);
	const faceBefore = await pmText();
	const target = fileOf('sub/sa-copy.md');
	const r = await saveAsByMenuEvent(target);
	judge('s1', 'Save As… (menu_save_as) asks the save dialog once with defaultPath = the current file (same folder, same name)', r.dialogAsked && r.dialogOptions.length === 1 && defaultPathOf(r.dialogOptions[0]) === fileOf(rel), { options: r.dialogOptions });
	judge('s1', 'save_document_as runs once with the chosen path and succeeds; no save_document', r.saveAs.length === 1 && r.saveAs[0]!.ok && r.saveAs[0]!.path === target && (await savesSince(r.mark)).length === 0, { saveAs: r.saveAs.map((s) => ({ ok: s.ok, path: s.path, body: s.body })) });
	const written = readIf(target);
	judge('s1', 'the new file holds the face’s text byte for byte (the user’s edit included)', written !== null && written === r.saveAs[0]?.content && written.includes('USER1') && written.startsWith('# Long report'), { bytes: written?.length ?? null });
	judge('s1', 'the original file is untouched', fs.readFileSync(fileOf(rel), 'utf8') === original, {});
	const sw = await waitForSwitch(uriOf('sub/sa-copy.md'), r.mark, 'req89-s1-switch-miss');
	judge('s1', 'the window shows the new file (the active Explorer row is sub/sa-copy.md; set_tab_title names it)', sw.switched && (sw.evidence.tabTitles as Array<{ docUri: string | null }>).some((t) => t.docUri === uriOf('sub/sa-copy.md')), sw.evidence);
	judge('s1', 'the new document is not Unsaved, has no banner, and shows the same text', !(await exists(BADGE)) && !(await exists(CONFLICT)) && (await pmText()) === faceBefore, {});
	judge('s1', 'no Unsaved Changes dialog was asked on the way (the content was just written)', r.messagesAsked === 0, { messagesAsked: r.messagesAsked });
	fact('s1', 'screenshot after Save As…', { file: await shot('req89-s1-saved-as') });
}

/** (s2) sb.md → $OUTSIDE/sb-moved.md: the root switches to that folder. */
async function gateSaveAsOutsideRoot(rel: string): Promise<void> {
	if (!outside) {
		skipped('s2', 'Save As… outside the root', 'VELLIS_GATE_REQ89_OUTSIDE is not set');
		return;
	}
	if (!(await typeAfter(paragraph(2), ' USER1'))) throw new Error('could not type into paragraph 2');
	await browser.pause(300);
	const target = path.join(outside, 'sb-moved.md');
	const r = await saveAsByMenuEvent(target);
	judge('s2', 'save_document_as succeeds for a path outside the root', r.saveAs.length === 1 && r.saveAs[0]!.ok && r.saveAs[0]!.path === target, { saveAs: r.saveAs.map((s) => ({ ok: s.ok, path: s.path, body: s.body })) });
	const written = readIf(target);
	judge('s2', 'the file outside the root holds the face’s text', written !== null && written.includes('USER1') && written === r.saveAs[0]?.content, {});
	const rowCame = await waitForExplorerRow(uriOfAbs(target), { timeout: 15_000 }).then(() => true).catch(() => false);
	const sw = await waitForSwitch(uriOfAbs(target), r.mark, 'req89-s2-switch-miss');
	const titles = sw.evidence.tabTitles as Array<{ root: string | null; docUri: string | null }>;
	judge('s2', 'the root switches to the new file’s folder (the Explorer lists it, the row is active, set_tab_title carries the new root)', rowCame && sw.switched && titles.some((t) => t.docUri === uriOfAbs(target) && (t.root ?? '').replace(/\/$/, '') === uriOfAbs(outside).replace(/\/$/, '')), { rowCame, ...sw.evidence });
	judge('s2', 'the new document is not Unsaved and has no banner', !(await exists(BADGE)) && !(await exists(CONFLICT)) && (await pmText()).includes('USER1'), {});
	judge('s2', 'no Unsaved Changes dialog was asked', r.messagesAsked === 0, { messagesAsked: r.messagesAsked });
	fact('s2', 'screenshot after Save As… outside the root', { file: await shot('req89-s2-root-switched') });
	// back to the fixtures root for the gates that follow
	await setSaveAnswer(null);
}

/** (s3)(s4) sc.md: Cancel, then Save As… while the conflict banner is up. */
async function gateSaveAsCancelAndWhileConflict(rel: string): Promise<void> {
	const original = fs.readFileSync(fileOf(rel), 'utf8');
	await scrollViewerTo('bottom');
	if (!(await typeAfter(paragraph(78), ' USER1'))) throw new Error('could not type into paragraph 78');
	await browser.pause(300);
	// (s3) Cancel
	const r1 = await saveAsByMenuEvent(null);
	judge('s3', 'Cancel in the dialog: the dialog was asked, nothing runs, nothing is written, the face stays dirty with the edit', r1.dialogAsked && r1.saveAs.length === 0 && (await exists(BADGE)) && (await pmText()).includes('USER1') && fs.readFileSync(fileOf(rel), 'utf8') === original && (await activeRowUri()) === uriOf(rel), { saveAs: r1.saveAs });
	// (s4) the escape route: the banner is up, Save As… to a new file
	writeAtomic(fileOf(rel), edit(paragraph(78), 'topic 78 (edited by the AI) in one long line')(original));
	judge('s4', 'the overlapping write raises the conflict banner', await waitFor(CONFLICT, 'the conflict banner'), {});
	const target = fileOf('sub/sc-rescue.md');
	const r2 = await saveAsByMenuEvent(target);
	const written = readIf(target);
	judge('s4', 'Save As… works while the banner is up: the new file holds the user’s edit (not the AI’s paragraph)', r2.saveAs.length === 1 && r2.saveAs[0]!.ok && written !== null && written.includes('USER1') && !written.includes('edited by the AI'), { saveAs: r2.saveAs.map((s) => ({ ok: s.ok, path: s.path, body: s.body })) });
	const sw = await waitForSwitch(uriOf('sub/sc-rescue.md'), r2.mark, 'req89-s4-switch-miss');
	judge('s4', 'the window switches to the new file; no banner, not Unsaved; the original keeps the AI’s version', sw.switched && !(await exists(CONFLICT)) && !(await exists(BADGE)) && fs.readFileSync(fileOf(rel), 'utf8').includes('edited by the AI'), { ...sw.evidence, originalHasAi: fs.readFileSync(fileOf(rel), 'utf8').includes('edited by the AI') });
	judge('s4', 'no Unsaved Changes dialog was asked', r2.messagesAsked === 0, { messagesAsked: r2.messagesAsked });
}

/** (s5) the native menu bar by AX: File ▸ Save As… shows Shift + Command + S and runs the same path. */
async function gateSaveAsByAx(): Promise<void> {
	let pid: number | null = null;
	try {
		pid = appPid();
	} catch (e) {
		skipped('s5', 'File ▸ Save As… by AX', String(e));
		return;
	}
	if (pid === null) {
		skipped('s5', 'File ▸ Save As… by AX', 'VELLIS_GATE_AXTOOL / VELLIS_GATE_BIN not set, or no app process of the build under test');
		report(REPORT, { gate: 'environment', item: 'AX gates could not run', reason: 'no axtool / pid' });
		return;
	}
	let items: MenuDetail[] = [];
	try {
		items = fileMenuDetail(pid);
	} catch (e) {
		skipped('s5', 'File menu read by AX', String((e as { stderr?: string }).stderr ?? e));
		return;
	}
	const saveAs = items.find((i) => i.title === 'Save As…');
	const save = items.findIndex((i) => i.title === 'Save');
	const saveAsAt = items.findIndex((i) => i.title === 'Save As…');
	judge('s5', 'File has "Save As…" right after "Save", enabled, with Shift + Command + S (AXMenuItemCmdChar S, modifiers 1 = Shift)', !!saveAs && saveAs.enabled && saveAs.cmd_char.toUpperCase() === 'S' && saveAs.cmd_modifiers === 1 && save >= 0 && saveAsAt === save + 1, { items: items.map((i) => ({ title: i.title, cmd_char: i.cmd_char, cmd_modifiers: i.cmd_modifiers, enabled: i.enabled })) });
	// press it in the menu bar with the dialog stubbed
	const target = fileOf('sub/ax-copy.md');
	const before = await readStub();
	await setSaveAnswer(target);
	const mark = await ipcMark();
	let press = '';
	try {
		press = pressFileMenu(pid, 'Save As…');
	} catch (e) {
		skipped('s5', 'File ▸ Save As… pressed by AX', String((e as { stderr?: string }).stderr ?? e));
		return;
	}
	const ran = await waitForCmd(mark, SAVE_AS_COMMAND);
	await browser.pause(1_200);
	const after = await readStub();
	const saveAsCalls = await saveAsSince(mark);
	judge('s5', 'pressing File ▸ Save As… in the menu bar asks the save dialog and runs save_document_as with the chosen path; the file is written', ran && after.saves.length === before.saves.length + 1 && saveAsCalls.length === 1 && saveAsCalls[0]!.ok && saveAsCalls[0]!.path === target && readIf(target) !== null, { press, saveAs: saveAsCalls.map((s) => ({ ok: s.ok, path: s.path })) });
	await setSaveAnswer(null);
}

// --- the run -----------------------------------------------------------------------------------

describe('要件89 gate: Merge… picks the overlapping chunks and Save writes them; Save As… writes a new file and the window follows it', function () {
	this.timeout(900_000);
	before(async function () {
		if (!DEVICE) this.skip();
		await waitForAppMounted();
		await installGateRecorder();
		await setIpcCapture(['save_document', SAVE_AS_COMMAND, 'open_document', 'set_tab_title', 'set_root']);
		await installEventRecorder(['file_changed', 'file_removed', 'menu_save', MENU_SAVE_AS_EVENT]);
		await installDialogStub();
		await waitForExplorerRow(uriOf('ma.md'), { timeout: 30_000 });
		fact('setup', 'the app is up with the fixtures', { root, outside, innerHeight: await browser.execute(() => window.innerHeight) });
	});
	afterEach(async function () {
		if (!DEVICE) return;
		if (this.currentTest?.state === 'failed') {
			report(REPORT, { gate: 'failed', test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
		}
	});
	after(async function () {
		if (!DEVICE) return;
		const stub = await readStub().catch(() => ({ saves: [], messages: [] }));
		report(REPORT, { gate: 'teardown', dialogs_save: stub.saves.length, dialogs_message: stub.messages.length, fails });
		await removeEventRecorder().catch(() => undefined);
		await restoreGateRecorder().catch(() => undefined);
	});

	it('gate (m1): Markdown face — Merge… → My Edits → Apply → Command + S writes the chosen merge', async () => {
		await openMd('ma.md');
		await gateMergeMarkdown('ma.md');
	});
	it('gate (m2): CodeMirror face — Merge… → Both → Apply → Command + S writes both lines', async () => {
		await openTxt('merge.txt', 'line 01');
		await gateMergeText('merge.txt');
	});
	it('gate (m3): Cancel in the merge view changes nothing', async () => {
		await openMd('mb.md');
		await gateMergeCancel('mb.md');
	});
	it('gate (s1): Save As… inside the root — dialog defaults, bytes, the window follows the new file', async () => {
		await openMd('sa.md');
		await gateSaveAsInRoot('sa.md');
	});
	it('gate (s3)(s4): Cancel writes nothing; Save As… while the conflict banner is up is the escape route', async () => {
		await openMd('sc.md');
		await gateSaveAsCancelAndWhileConflict('sc.md');
	});
	it('gate (s5): the native menu bar — File ▸ Save As… with Shift + Command + S runs the same path', async () => {
		await openMd('mb.md');
		await gateSaveAsByAx();
	});
	// Last of the Save As… gates: it switches the root away from the fixtures folder.
	it('gate (s2): Save As… outside the root — the root switches to the new folder', async () => {
		await openMd('sb.md');
		await gateSaveAsOutsideRoot('sb.md');
	});
	it('verdict: every judgement passed', () => {
		fact('verdict', fails.length === 0 ? 'all judgements passed' : `${fails.length} judgement(s) failed`, { fails });
		if (fails.length > 0) throw new Error(`req89 gate: ${fails.length} judgement(s) failed:\n${fails.join('\n')}`);
	});
});
