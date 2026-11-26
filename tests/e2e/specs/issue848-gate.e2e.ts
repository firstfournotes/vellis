import { browser } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
	appendToFace,
	clickExplorerRow,
	emitMenu,
	faceText,
	installEventRecorder,
	installGateRecorder,
	mdFaceText,
	readCapturedIpc,
	readEventRecord,
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
 * Issue #848 — the device gate (webdriver only; no real input, no operator). Grew out of the
 * reproduction spec `inv848.e2e.ts` (2026-11-26): an 80-paragraph Markdown file scrolled to the
 * end, a paragraph near the end edited, the same paragraph written from outside (tmp + rename, as
 * AI tools write), Command + S → the conflict banner was in the DOM with rect.top = −5347 (above the
 * window; WebKit's scroll anchoring moved scrollTop by the banner's height, so nothing visibly
 * changed) and `save_document` was refused — "Command + S does nothing".
 *
 * 由谷の決定 2026-11-26: the overlapping-change banner, the removed banner and the merged notice are
 * fixed under the toolbar (sticky, as the find bar), covering the top of the body is accepted. And
 * the echo bug found on the way: after an external change was taken in, a later external write
 * whose content equals our own earlier save must not be dropped as the echo of that save.
 *
 * What the gate judges (each judgement = one JSON line in `$VELLIS_GATE_SHOTS/issue848-report.jsonl`,
 * `pass` true / false; a line without `pass` is a fact):
 *  - (a) long document scrolled to the end, an overlapping external write → the conflict banner's
 *        rect is inside the visible viewer area (below the toolbar, above the window's bottom) and
 *        `document.elementFromPoint` at its centre hits the banner
 *  - (b) the same after a refused Save — `menu_save` (the event File ▸ Save emits) and File ▸ Save
 *        pressed by AX (axtool) — the banner stays on screen, nothing written
 *  - (c) the merged notice of a non-overlapping write is on screen the same way
 *  - (d) the removed banner (the file moved away under a dirty face) is on screen the same way; its
 *        Save writes the file back with the edit
 *  - (e) Keep My Edits, then Save: the user's edit is on disk (the save is not refused)
 *  - (f) control: the same overlapping write with the document at scrollTop = 0 is still on screen
 *  - (g) the echo scenario end to end on both faces: save A → external B taken in → external A
 *        again → the face shows A (no banner, not dirty), and the next edit + Save writes
 *  - the last `it` fails when any judgement failed, so the wdio exit status is the verdict
 *
 * Fixtures (run-gate-spec.sh `issue848`): la・lc・ld・lf・lg・lg2 .md = the 80-paragraph "Long report"
 * (one paragraph = one line), echo.txt = 30 lines. Dialogs of the page (the Unsaved Changes
 * dialog when moving to the next file) are answered "Don't Save" by a stub.
 *
 * Build and run (the binary is a copy outside src-tauri/target, not named `vellis` — lib.sh):
 *   pnpm tauri build --debug --no-bundle -f webdriver
 *   cp src-tauri/target/debug/vellis <out>/vellis-gate848
 *   xcrun swiftc -O scripts/gate-device/axtool.swift -o <out>/axtool
 *   export VELLIS_GATE_BIN=<out>/vellis-gate848 VELLIS_GATE_AXTOOL=<out>/axtool VELLIS_GATE_OUT=<out>
 *   scripts/gate-device/run-gate-spec.sh issue848
 * Runs only under that script (VELLIS_GATE_DEVICE=1); self-skipping otherwise.
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const REPORT = 'issue848-report.jsonl';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';

const fileOf = (rel: string) => path.join(root, rel);
const uriOf = (rel: string) => `file://${fileOf(rel).split(path.sep).join('/')}`;

const PM = 'article.viewer [data-testid="markdown-editor"] .ProseMirror';
const BADGE = 'article.viewer [data-testid="unsaved-badge"]';
const CONFLICT = '[data-testid="external-conflict-banner"]';
const CONFLICT_KEEP = '[data-testid="external-conflict-keep"]';
const MERGED = '[data-testid="external-merged-notice"]';
const REMOVED = '[data-testid="external-removed-banner"]';
const REMOVED_SAVE = '[data-testid="external-removed-save"]';
const SAVE_CONFLICT_PREFIX = 'The file was changed on disk';

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
async function pmText(): Promise<string> {
	return (await mdFaceText()) ?? '';
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
		PM,
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
async function scrollTop(): Promise<number> {
	return browser.execute(() => Math.round(document.querySelector<HTMLElement>('article.viewer')?.scrollTop ?? -1));
}

interface Visibility {
	exists: boolean;
	onScreen: boolean;
	hitIsBanner: boolean;
	rect: { top: number; bottom: number; height: number } | null;
	visibleTop: number;
	visibleBottom: number;
	hit: string | null;
	position: string | null;
	scrollTop: number;
}
/**
 * Where an element is against what the user can see: the viewer scroller's rect, cut at the
 * toolbar's bottom and the window's bottom. `onScreen` = the whole element lies in that band;
 * `hitIsBanner` = `document.elementFromPoint` at its centre is the element or inside it (nothing
 * covers it).
 */
async function visibility(sel: string): Promise<Visibility> {
	return browser.execute((s) => {
		const el = document.querySelector<HTMLElement>(s);
		const viewer = document.querySelector<HTMLElement>('article.viewer');
		const tb = document.querySelector<HTMLElement>('article.viewer .viewer-toolbar');
		const vr = viewer?.getBoundingClientRect();
		const top = tb ? tb.getBoundingClientRect().bottom : (vr?.top ?? 0);
		const bottom = Math.min(vr?.bottom ?? window.innerHeight, window.innerHeight);
		const base = { visibleTop: Math.round(top), visibleBottom: Math.round(bottom), scrollTop: Math.round(viewer?.scrollTop ?? -1) };
		if (!el) return { exists: false, onScreen: false, hitIsBanner: false, rect: null, hit: null, position: null, ...base };
		const r = el.getBoundingClientRect();
		const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return {
			exists: true,
			onScreen: r.height > 0 && r.top >= top - 1 && r.bottom <= bottom + 1,
			hitIsBanner: !!hit && (hit === el || el.contains(hit)),
			rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) },
			hit: hit ? `${hit.tagName.toLowerCase()}.${(hit as HTMLElement).className}`.slice(0, 80) : null,
			position: getComputedStyle(el).position,
			...base,
		};
	}, sel);
}
/** One judgement: the element is there, inside the visible band, and the hit test lands on it. */
async function judgeVisible(gate: string, item: string, sel: string): Promise<Visibility> {
	const v = await visibility(sel);
	judge(gate, item, v.exists && v.onScreen && v.hitIsBanner, { ...v });
	return v;
}

// --- the save ----------------------------------------------------------------------------------

interface SaveResult {
	saves: Array<{ ok: boolean; body: unknown; expectedHash: string | null }>;
	refused: boolean;
	written: boolean;
}
async function ipcMark(): Promise<number> {
	return (await readCapturedIpc()).length;
}
async function savesSince(mark: number): Promise<SaveResult['saves']> {
	return (await readCapturedIpc())
		.slice(mark)
		.filter((c) => c.cmd === 'save_document')
		.map((s) => ({ ok: s.ok, body: s.body, expectedHash: (s.args as { expectedHash?: string } | null)?.expectedHash ?? null }));
}
async function waitForSave(mark: number): Promise<SaveResult> {
	await browser
		.waitUntil(async () => (await savesSince(mark)).length > 0, { timeout: 8_000 })
		.catch(() => undefined);
	await browser.pause(800);
	const saves = await savesSince(mark);
	return {
		saves,
		refused: saves.some((s) => s.ok === false && String(s.body ?? '').startsWith(SAVE_CONFLICT_PREFIX)),
		written: saves.some((s) => s.ok === true),
	};
}
/** File ▸ Save as the menu item emits it to this window. */
async function saveByMenuEvent(): Promise<SaveResult> {
	const mark = await ipcMark();
	await emitMenu('menu_save');
	return waitForSave(mark);
}
/** File ▸ Save pressed in the native menu bar by AX (axtool) → Rust → `menu_save` to the window. */
async function saveByAx(): Promise<{ result: SaveResult; press: string } | { error: string }> {
	if (!axtool || !bin) return { error: 'VELLIS_GATE_AXTOOL / VELLIS_GATE_BIN not set' };
	try {
		const env = { ...process.env, AXTOOL_EXPECT_EXE: bin };
		const first = execFileSync(axtool, ['pids-of-exe', bin], { encoding: 'utf8', env, timeout: 30_000 }).trim().split('\n')[0];
		if (!first) return { error: 'no app process of the build under test' };
		const pid = (JSON.parse(first) as { pid: number }).pid;
		const mark = await ipcMark();
		const press = execFileSync(axtool, ['menu', String(pid), 'File', 'Save'], { encoding: 'utf8', env, timeout: 30_000 }).trim();
		return { result: await waitForSave(mark), press };
	} catch (e) {
		const err = e as { stderr?: string; message?: string };
		return { error: err.stderr?.trim() || err.message || String(e) };
	}
}

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
async function eventsMark(): Promise<number> {
	return (await readEventRecord()).length;
}
async function fileEventsSince(mark: number): Promise<string[]> {
	return (await readEventRecord())
		.slice(mark)
		.map((e) => e.event)
		.filter((e) => e === 'file_changed' || e === 'file_removed');
}
async function shot(name: string): Promise<string> {
	const file = path.join(SHOTS_DIR, `${name}.png`);
	fs.mkdirSync(SHOTS_DIR, { recursive: true });
	await browser.saveScreenshot(file);
	return file;
}

// --- the gates ---------------------------------------------------------------------------------

/** (a)(b)(e) on la.md: scrolled to the end, paragraph 78 edited, the same paragraph written from outside. */
async function gateOverlapScrolled(rel: string): Promise<void> {
	const base = fs.readFileSync(fileOf(rel), 'utf8');
	await scrollViewerTo('bottom');
	if (!(await typeAfter(paragraph(78), ' USER1'))) throw new Error('could not type into paragraph 78');
	await scrollViewerTo('bottom');
	const before = await scrollTop();
	fact('a', 'the document is scrolled to the end before the external write', { scrollTop: before, badge: await exists(BADGE) });
	writeAtomic(fileOf(rel), edit(paragraph(78), 'topic 78 (edited by the AI) in one long line')(base));
	const came = await waitFor(CONFLICT, 'the conflict banner');
	judge('a', 'an overlapping external write under a dirty face scrolled to the end raises the conflict banner', came, {});
	const v = await judgeVisible('a', 'the conflict banner is inside the visible viewer area (below the toolbar, above the window’s bottom) and the hit test at its centre lands on it', CONFLICT);
	fact('a', 'screenshot after the external write', { file: await shot('issue848-a-conflict'), position: v.position, scrollTop_before: before, scrollTop_after: v.scrollTop });
	judge('a', 'the face keeps the user’s edit (the document did not change)', (await pmText()).includes('USER1') && !(await pmText()).includes('edited by the AI'), {});

	// (b) the refused save by the menu event
	const s1 = await saveByMenuEvent();
	judge('b', 'File ▸ Save (menu_save) with the banner up: save_document runs and is REFUSED ("The file was changed on disk…"), nothing written', s1.saves.length >= 1 && s1.refused && !s1.written && !fs.readFileSync(fileOf(rel), 'utf8').includes('USER1'), { saves: s1.saves });
	await judgeVisible('b', 'after the refused Save the conflict banner is still inside the visible viewer area and the hit test lands on it', CONFLICT);
	judge('b', 'after the refused Save the Unsaved badge is still up and the edit is still in the face', (await exists(BADGE)) && (await pmText()).includes('USER1'), {});

	// (b) the refused save through the native menu bar (AX)
	const ax = await saveByAx();
	if ('error' in ax) {
		skipped('b', 'File ▸ Save pressed by AX', ax.error);
		report(REPORT, { gate: 'environment', item: 'File ▸ Save by AX could not be pressed', reason: ax.error });
	} else {
		judge('b', 'File ▸ Save pressed by AX in the menu bar: save_document runs and is refused the same way, nothing written', ax.result.saves.length >= 1 && ax.result.refused && !ax.result.written, { press: ax.press, saves: ax.result.saves });
		await judgeVisible('b', 'after the AX Save the conflict banner is still inside the visible viewer area and the hit test lands on it', CONFLICT);
	}
	fact('b', 'screenshot after the refused saves', { file: await shot('issue848-b-refused') });

	// (e) Keep My Edits, then Save writes
	await browser.execute((sel) => (document.querySelector(sel) as HTMLElement | null)?.click(), CONFLICT_KEEP);
	const gone = await waitGone(CONFLICT, 'the conflict banner after Keep My Edits', 5_000);
	judge('e', 'Keep My Edits takes the banner down and keeps the edit', gone && (await pmText()).includes('USER1'), {});
	const s2 = await saveByMenuEvent();
	const disk = fs.readFileSync(fileOf(rel), 'utf8');
	judge('e', 'Save after Keep My Edits is accepted and the user’s edit is on disk (the AI’s version of the paragraph is overwritten)', s2.written && !s2.refused && disk.includes('USER1') && !disk.includes('edited by the AI'), { saves: s2.saves });
	judge('e', 'after that save the Unsaved badge is gone', !(await exists(BADGE)), {});
}

/** (c) on lc.md: scrolled to the end, paragraph 79 edited, paragraph 3 written from outside (no overlap). */
async function gateMergedScrolled(rel: string): Promise<void> {
	const base = fs.readFileSync(fileOf(rel), 'utf8');
	await scrollViewerTo('bottom');
	if (!(await typeAfter(paragraph(79), ' USER1'))) throw new Error('could not type into paragraph 79');
	await scrollViewerTo('bottom');
	writeAtomic(fileOf(rel), edit(paragraph(3), 'topic 3 AI1 in one long line')(base));
	const came = await waitFor(MERGED, 'the merged notice', 8_000);
	judge('c', 'a non-overlapping external write under a dirty face scrolled to the end raises the merged notice', came, {});
	const v = await judgeVisible('c', 'the merged notice is inside the visible viewer area and the hit test at its centre lands on it', MERGED);
	fact('c', 'screenshot with the notice', { file: await shot('issue848-c-merged'), position: v.position });
	judge('c', 'the merge took the AI’s paragraph and kept the user’s edit (dirty)', (await pmText()).includes('topic 3 AI1') && (await pmText()).includes('USER1') && (await exists(BADGE)), {});
}

/** (d) on ld.md: scrolled to the end, paragraph 78 edited, the file moved away. */
async function gateRemovedScrolled(rel: string): Promise<void> {
	await scrollViewerTo('bottom');
	if (!(await typeAfter(paragraph(78), ' USER1'))) throw new Error('could not type into paragraph 78');
	await scrollViewerTo('bottom');
	const moved = fileOf(rel.replace(/\.md$/, '.moved-away.md'));
	fs.renameSync(fileOf(rel), moved);
	const came = await waitFor(REMOVED, 'the removed banner');
	judge('d', 'the file moved away under a dirty face scrolled to the end raises the removed banner', came, {});
	const v = await judgeVisible('d', 'the removed banner is inside the visible viewer area and the hit test at its centre lands on it', REMOVED);
	fact('d', 'screenshot with the removed banner', { file: await shot('issue848-d-removed'), position: v.position });
	const mark = await ipcMark();
	await browser.execute((sel) => (document.querySelector(sel) as HTMLElement | null)?.click(), REMOVED_SAVE);
	const s = await waitForSave(mark);
	const back = fs.existsSync(fileOf(rel)) ? fs.readFileSync(fileOf(rel), 'utf8') : null;
	judge('d', 'the banner’s Save writes the file back to the same path with the edit (no expectedHash), the banner goes', s.written && s.saves.every((x) => x.expectedHash === null) && back !== null && back.includes('USER1') && !(await exists(REMOVED)), { saves: s.saves });
	fs.rmSync(moved, { force: true });
}

/** (f) control on lf.md: the same overlapping write with the document at the top. */
async function gateControlTop(rel: string): Promise<void> {
	const base = fs.readFileSync(fileOf(rel), 'utf8');
	if (!(await typeAfter(paragraph(2), ' USER1'))) throw new Error('could not type into paragraph 2');
	await scrollViewerTo(0);
	writeAtomic(fileOf(rel), edit(paragraph(2), 'topic 2 (AI) in one long line')(base));
	const came = await waitFor(CONFLICT, 'the conflict banner (control)');
	judge('f', 'control at scrollTop = 0: the conflict banner comes', came, {});
	await judgeVisible('f', 'control at scrollTop = 0: the conflict banner is inside the visible viewer area and the hit test lands on it', CONFLICT);
	const s = await saveByMenuEvent();
	judge('f', 'control: the Save is refused the same way and the banner stays', s.refused && !s.written && (await exists(CONFLICT)), { saves: s.saves });
}

/** (g) on lg.md (ProseMirror face): save A → external B taken in → external A again → the face shows A → edit + Save writes. */
async function gateEchoMarkdown(rel: string): Promise<void> {
	if (!(await typeAfter(paragraph(2), ' USER1'))) throw new Error('could not type into paragraph 2');
	const em = await eventsMark();
	const s1 = await saveByMenuEvent();
	judge('g', 'Markdown face: the first Save writes (A = the user’s edit on disk)', s1.written && !s1.refused && fs.readFileSync(fileOf(rel), 'utf8').includes('USER1'), { saves: s1.saves });
	const A = fs.readFileSync(fileOf(rel), 'utf8');
	await browser.pause(2_000);
	judge('g', 'Markdown face: the echo of the own save (file_changed with A) changes nothing — no banner, no notice, not dirty, the face keeps A', !(await exists(CONFLICT)) && !(await exists(MERGED)) && !(await exists(BADGE)) && (await pmText()).includes('USER1'), { file_events: await fileEventsSince(em) });
	const B = edit(paragraph(5), 'topic 5 AI1 in one long line')(A);
	writeAtomic(fileOf(rel), B);
	const tookB = await browser.waitUntil(async () => (await pmText()).includes('topic 5 AI1'), { timeout: 10_000 }).then(() => true).catch(() => false);
	judge('g', 'Markdown face: the AI’s write B is taken in (clean face: the text follows, not dirty)', tookB && !(await exists(BADGE)), {});
	writeAtomic(fileOf(rel), A);
	const backToA = await browser.waitUntil(async () => !(await pmText()).includes('topic 5 AI1'), { timeout: 10_000 }).then(() => true).catch(() => false);
	judge('g', 'Markdown face: the AI writes A (the user’s earlier save) back — it is NOT dropped as an echo: the face shows A again, no banner, not dirty', backToA && (await pmText()).includes('USER1') && !(await exists(CONFLICT)) && !(await exists(BADGE)), { face_has_AI1: (await pmText()).includes('topic 5 AI1'), file_events: await fileEventsSince(em) });
	if (!(await typeAfter('USER1', ' USER2'))) throw new Error('could not type USER2');
	const s2 = await saveByMenuEvent();
	const disk = fs.readFileSync(fileOf(rel), 'utf8');
	judge('g', 'Markdown face: the next edit + Save is accepted (no stale-hash refusal) and lands on disk', s2.written && !s2.refused && disk.includes('USER2') && !disk.includes('AI1'), { saves: s2.saves });
}

/** (g) on echo.txt (CodeMirror face): the same sequence. */
async function gateEchoText(rel: string): Promise<void> {
	if (!(await appendToFace('USER1'))) throw new Error('could not type into the CodeMirror face');
	await browser.waitUntil(async () => ((await faceText()) ?? '').includes('USER1'), { timeout: 5_000 });
	const em = await eventsMark();
	const s1 = await saveByMenuEvent();
	judge('g', 'CodeMirror face: the first Save writes (A)', s1.written && !s1.refused && fs.readFileSync(fileOf(rel), 'utf8').includes('USER1'), { saves: s1.saves });
	const A = fs.readFileSync(fileOf(rel), 'utf8');
	await browser.pause(2_000);
	judge('g', 'CodeMirror face: the echo of the own save changes nothing — no banner, no notice, not dirty', !(await exists(CONFLICT)) && !(await exists(MERGED)) && !(await exists(BADGE)) && ((await faceText()) ?? '').includes('USER1'), { file_events: await fileEventsSince(em) });
	const B = edit('line 05', 'line 05 AI1')(A);
	writeAtomic(fileOf(rel), B);
	const tookB = await browser.waitUntil(async () => ((await faceText()) ?? '').includes('line 05 AI1'), { timeout: 10_000 }).then(() => true).catch(() => false);
	judge('g', 'CodeMirror face: the AI’s write B is taken in (clean face: the text follows, not dirty)', tookB && !(await exists(BADGE)), {});
	writeAtomic(fileOf(rel), A);
	const backToA = await browser.waitUntil(async () => !((await faceText()) ?? '').includes('line 05 AI1'), { timeout: 10_000 }).then(() => true).catch(() => false);
	judge('g', 'CodeMirror face: the AI writes A back — NOT dropped as an echo: the face shows A again, no banner, not dirty', backToA && ((await faceText()) ?? '').includes('USER1') && !(await exists(CONFLICT)) && !(await exists(BADGE)), { file_events: await fileEventsSince(em) });
	if (!(await appendToFace(' USER2'))) throw new Error('could not type USER2');
	const s2 = await saveByMenuEvent();
	const disk = fs.readFileSync(fileOf(rel), 'utf8');
	judge('g', 'CodeMirror face: the next edit + Save is accepted and lands on disk', s2.written && !s2.refused && disk.includes('USER2') && !disk.includes('AI1'), { saves: s2.saves });
}

// --- the run -----------------------------------------------------------------------------------

describe('Issue #848 gate: the banners stay on screen in a long document scrolled to the end; the echo of an earlier save is not dropped after an external change', function () {
	this.timeout(900_000);
	before(async function () {
		if (!DEVICE) this.skip();
		await waitForAppMounted();
		await installGateRecorder();
		await setIpcCapture(['save_document', 'open_document']);
		await installEventRecorder(['file_changed', 'file_removed', 'menu_save']);
		// The Unsaved Changes dialog (plugin:dialog|message) answers "Don't Save" without a native sheet,
		// so moving to the next gate's file never blocks.
		await browser.execute(() => {
			const w = window as unknown as { __issue848Dialogs?: string[] };
			if (w.__issue848Dialogs) return;
			w.__issue848Dialogs = [];
			const inner = window.fetch;
			window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
				const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
				if (decodeURIComponent(url).startsWith('ipc://localhost/plugin:dialog|message')) {
					w.__issue848Dialogs!.push(typeof init?.body === 'string' ? init.body : '?');
					return Promise.resolve(new Response(JSON.stringify("Don't Save"), { status: 200, headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } }));
				}
				return inner.call(this, input, init);
			} as typeof window.fetch;
		});
		await waitForExplorerRow(uriOf('la.md'), { timeout: 30_000 });
		fact('setup', 'the app is up with the fixtures', { root, innerHeight: await browser.execute(() => window.innerHeight) });
	});
	afterEach(async function () {
		if (!DEVICE) return;
		if (this.currentTest?.state === 'failed') {
			report(REPORT, { gate: 'failed', test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
		}
	});
	after(async function () {
		if (!DEVICE) return;
		report(REPORT, { gate: 'teardown', dialogs_stubbed: await browser.execute(() => (window as unknown as { __issue848Dialogs?: string[] }).__issue848Dialogs?.length ?? 0).catch(() => -1), fails });
		await removeEventRecorder().catch(() => undefined);
		await restoreGateRecorder().catch(() => undefined);
	});

	it('gates (a)(b)(e): long document scrolled to the end — the conflict banner is on screen after the overlapping write and after the refused Save (menu_save and AX File ▸ Save); Keep My Edits then Save writes the edit', async () => {
		await openMd('la.md');
		await gateOverlapScrolled('la.md');
	});
	it('gate (c): long document scrolled to the end — the merged notice of a non-overlapping write is on screen', async () => {
		await openMd('lc.md');
		await gateMergedScrolled('lc.md');
	});
	it('gate (d): long document scrolled to the end — the removed banner is on screen when the file is moved away; its Save writes the file back', async () => {
		await openMd('ld.md');
		await gateRemovedScrolled('ld.md');
	});
	it('gate (f): control — the same overlapping write at scrollTop = 0 is still on screen', async () => {
		await openMd('lf.md');
		await gateControlTop('lf.md');
	});
	it('gate (g): the echo scenario end to end on the Markdown face', async () => {
		await openMd('lg.md');
		await gateEchoMarkdown('lg.md');
	});
	it('gate (g): the echo scenario end to end on the CodeMirror face', async () => {
		await openTxt('echo.txt', 'line 01');
		await gateEchoText('echo.txt');
	});
	it('verdict: every judgement passed', () => {
		fact('verdict', fails.length === 0 ? 'all judgements passed' : `${fails.length} judgement(s) failed`, { fails });
		if (fails.length > 0) throw new Error(`issue848 gate: ${fails.length} judgement(s) failed:\n${fails.join('\n')}`);
	});
});
