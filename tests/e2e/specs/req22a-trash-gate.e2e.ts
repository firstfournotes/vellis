import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertEventRecorderWorks,
	assertIpcInterceptionWorks,
	clearCapturedIpc,
	clearEventRecord,
	clickExplorerRow,
	emitMenu,
	explorerHasRow,
	explorerNames,
	installEventRecorder,
	installGateRecorder,
	readCapturedIpc,
	readEventRecord,
	readGateRecord,
	removeEventRecorder,
	report,
	restoreGateRecorder,
	setIpcBlock,
	setIpcCapture,
	shot,
	trashDir,
	trashItem,
	waitForAppMounted,
	waitForExplorerRow,
	type CapturedIpc,
	type RecordedEvent,
} from '../gate-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Requirement #22 追補a human gate (Issue #759, PR #760), driven on the webdriver
 * build (docs/requirements/req-22.md「追補a の人間ゲート」). The founder has
 * already confirmed, on another Mac with v0.5.3, that Finder's "Move to Trash"
 * closes a clean Markdown document and shows the removed banner on a dirty one;
 * this spec drives the rest:
 *
 *  gate 1  rename inside the same folder → a clean document closes
 *  gate 2  a raster image (png) in the Trash → the view closes
 *  gate 3  dirty document → Trash → banner; "Put Back" → the removed banner
 *          goes and the external-change banner takes its place (AC-48-追g (d));
 *          Trash again → the removed banner is back
 *  gate 4  dirty document → Trash → banner; Command + S writes the file at its
 *          path again → the banner goes; Trash again → the document closes
 *          (the save made it clean, 要件#48 追補g 契約1); put back, reopened and
 *          edited → Trash → the dirty banner is back
 *  gate 5  the open document's parent folder is moved / put in the Trash →
 *          does the document close? (an observation, not a contract: closing
 *          is fine, not closing is recorded for a separate Issue — req-22.md)
 *
 * Nothing is clicked in Finder. "Move to Trash" is the very call Finder makes,
 * `-[NSFileManager trashItemAtURL:resultingItemURL:error:]` (gate-helpers
 * `trashItem`), and on one volume it is a rename into `~/.Trash` — which is why
 * FSEvents carries no REMOVED flag and the hub has to notice the file is gone
 * (契約1). The spec checks that premise each time (fixture and `~/.Trash` on
 * one device; the item keeps its inode) and fails when it does not hold, so a
 * copy-and-delete Trash never passes for a rename. "Put Back" is the reverse
 * rename (`fs.renameSync` out of the Trash); a plain rename / move is
 * `fs.renameSync`.
 *
 * The Trash is the real user's: wdio keeps the real HOME (only the app runs in
 * the throwaway home). Every item this spec puts there is remembered by the
 * path NSFileManager reports and taken out again in `after()`.
 *
 * What is observed: the DOM (empty state / `h1` / the editor `<pre>` / the two
 * banners `external-removed-banner` and `external-change-banner` with their
 * wording and button titles / the image viewer), the Tauri events
 * `file_removed` / `file_changed` / `binary_file_changed` as the page receives
 * them (a second listener next to the app's own, gate-helpers
 * `installEventRecorder`), the IPC commands `open_document` /
 * `open_binary_document` / `save_document` with their args, dialogs (stubbed
 * and recorded), and the file system. All of it goes into the `[gate]` lines so
 * a red says what was on the screen and what had arrived.
 *
 * Waits: an event is given 10 s to show in the DOM (acceptance_req22a.rs waits
 * 5 s for the event alone; the UI adds IPC and rendering). "Does not happen"
 * is a 2 s quiet window after the operation, as in acceptance_req22a.rs.
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const gateDir = path.join(startRoot, 'req22a-gate');
const REPORT = 'req22a-report.jsonl';
const BODY = 'article.viewer .markdown-body';

/** Gate fixtures (one file per gate so a failure never leaks into the next). */
const renameMe = path.join(gateDir, 'rename-me.md');
const renamed = path.join(gateDir, 'renamed.md');
const picture = path.join(gateDir, 'picture.png');
const restoreMe = path.join(gateDir, 'restore-me.md');
const resaveMe = path.join(gateDir, 'resave-me.md');
const parentTrash = path.join(gateDir, 'parent-trash');
const innerTrash = path.join(parentTrash, 'inner.md');
const parentMove = path.join(gateDir, 'parent-move');
const innerMove = path.join(parentMove, 'inner.md');
const movedParent = path.join(startRoot, 'req22a-moved-parent');
const closer = path.join(gateDir, 'closer.md');
/** Never opened, never moved: its row says "the gate folder is expanded". */
const keep = path.join(gateDir, 'keep.md');

const doc = (title: string) => `# ${title}\n\nA line that stays as it is on disk.\n`;
const EDIT = 'An edit the gate check typed and did not save.\n';

/** The banners' wording (src/components/Viewer.svelte, 要件#48 追補g/h). */
const REMOVED_DIRTY = 'This file was deleted outside the app. Your edits have not been saved.';
const CHANGED = 'This file was changed outside the app. It differs from your edits.';
const SAVE_TITLE_DIRTY = 'Save your edits to the file again';

/** The UI is given this long for an event to show (header comment). */
const ARRIVAL = 10_000;
/** "Does not happen" window after an operation (acceptance_req22a.rs QUIET_WINDOW). */
const QUIET = 2_000;

const uri = (p: string) => `file://${p}`;

/** Items this spec put in the Trash, by the path NSFileManager reported. */
const trashed: { original: string; inTrash: string; gate: string }[] = [];

// --- fixture -------------------------------------------------------------------

function buildFixture(): void {
	fs.rmSync(gateDir, { recursive: true, force: true });
	fs.mkdirSync(parentTrash, { recursive: true });
	fs.mkdirSync(parentMove, { recursive: true });
	fs.writeFileSync(renameMe, doc('Rename me'));
	// A real PNG from the repository (Tauri's 32×32 app icon): `file-type.ts`
	// lists png as an image, so the app opens it with `open_binary_document`.
	fs.copyFileSync(path.join(repoRoot, 'src-tauri', 'icons', '32x32.png'), picture);
	fs.writeFileSync(restoreMe, doc('Restore me'));
	fs.writeFileSync(resaveMe, doc('Resave me'));
	fs.writeFileSync(innerTrash, doc('Inner trash'));
	fs.writeFileSync(innerMove, doc('Inner move'));
	fs.writeFileSync(closer, doc('Closer'));
	fs.writeFileSync(keep, doc('Keep'));
}

// --- what the window shows -------------------------------------------------------

interface BannerView {
	present: boolean;
	text: string | null;
	saveTitle: string | null;
	closeTitle: string | null;
	buttons: string[];
}

interface View {
	emptyState: boolean;
	h1: string | null;
	editing: boolean;
	editorText: string | null;
	removed: BannerView;
	changed: { present: boolean; text: string | null; buttons: string[] };
	image: { shown: boolean; alt: string | null; error: boolean };
}

async function view(): Promise<View> {
	return browser.execute((body) => {
		const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
		const removedEl = document.querySelector('[data-testid="external-removed-banner"]');
		const changedEl = document.querySelector('[data-testid="external-change-banner"]');
		const img = document.querySelector<HTMLImageElement>('article.image-viewer img.image');
		return {
			emptyState: document.querySelector('.empty-state') !== null,
			h1: document.querySelector(`${body} h1`)?.textContent ?? null,
			editing: document.querySelector(`${body} pre.vellis-plaintext[contenteditable="true"]`) !== null,
			editorText: document.querySelector(`${body} pre.vellis-plaintext`)?.textContent ?? null,
			removed: {
				present: removedEl !== null,
				text: text(removedEl?.querySelector('.external-change-text') ?? null),
				saveTitle: removedEl?.querySelector('[data-testid="external-removed-save"]')?.getAttribute('title') ?? null,
				closeTitle: removedEl?.querySelector('[data-testid="external-removed-close"]')?.getAttribute('title') ?? null,
				buttons: Array.from(removedEl?.querySelectorAll('button') ?? []).map((b) => text(b) ?? ''),
			},
			changed: {
				present: changedEl !== null,
				text: text(changedEl?.querySelector('.external-change-text') ?? null),
				buttons: Array.from(changedEl?.querySelectorAll('button') ?? []).map((b) => text(b) ?? ''),
			},
			image: {
				shown: img !== null,
				alt: img?.getAttribute('alt') ?? null,
				error: document.querySelector('article.image-viewer .image-error') !== null,
			},
		};
	}, BODY);
}

/** Poll `check` until it holds or `timeout` passes; never throws (evidence is reported either way). */
async function pollUntil(check: () => Promise<boolean>, timeout: number): Promise<{ ok: boolean; ms: number }> {
	const t0 = Date.now();
	for (;;) {
		if (await check()) return { ok: true, ms: Date.now() - t0 };
		if (Date.now() - t0 >= timeout) return { ok: false, ms: Date.now() - t0 };
		await browser.pause(200);
	}
}

// --- the events, filtered -------------------------------------------------------

const payloadUri = (e: RecordedEvent) => (e.payload as { uri?: string } | null)?.uri ?? null;

/** Events of `uri` seen since `sinceMs` (page clock = spec clock), by name. */
function eventsFor(all: RecordedEvent[], target: string, sinceMs: number) {
	const mine = all.filter((e) => e.at >= sinceMs && payloadUri(e) === uri(target));
	const count = (name: string) => mine.filter((e) => e.event === name).length;
	return {
		fileRemoved: count('file_removed'),
		fileChanged: count('file_changed'),
		binaryFileChanged: count('binary_file_changed'),
		sequence: mine.map((e) => `${e.event}@+${e.at - sinceMs}ms`),
	};
}

/** `open_document` / `open_binary_document` request URIs captured since the last clear. */
function openedUris(captured: CapturedIpc[]): string[] {
	return captured
		.filter((c) => c.cmd === 'open_document' || c.cmd === 'open_binary_document')
		.map((c) => (c.args as { uri?: string } | null)?.uri ?? '?');
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
	await clearEventRecord();
}

/** Everything a gate wants in its `[gate]` line at a given moment. */
async function evidence(target: string, sinceMs: number) {
	const all = await readEventRecord();
	const rec = await readGateRecord();
	return {
		view: await view(),
		events: eventsFor(all, target, sinceMs),
		otherEvents: all
			.filter((e) => e.at >= sinceMs && payloadUri(e) !== uri(target))
			.map((e) => `${e.event}:${payloadUri(e) ?? JSON.stringify(e.payload)}@+${e.at - sinceMs}ms`),
		opened: openedUris(await readCapturedIpc()),
		dialogs: rec.dialogs,
		onDisk: fs.existsSync(target),
	};
}

// --- Trash, Put Back -------------------------------------------------------------

interface TrashOutcome {
	original: string;
	inTrash: string;
	/** The fixture and `~/.Trash` are on one device (st_dev). */
	sameDevice: boolean;
	/** The item kept its inode: a rename, not a copy + delete. */
	sameInode: boolean;
	insideTrash: boolean;
	at: number;
	ms: number;
}

/**
 * Finder's "Move to Trash" on `target`, with the premise of 追補a checked and
 * recorded: a same-volume rename into `~/.Trash`. Throws when the premise does
 * not hold (then nothing about the product can be concluded from what follows).
 */
function moveToTrash(target: string, gate: string): TrashOutcome {
	const before = fs.statSync(target);
	const trashStat = fs.statSync(trashDir());
	const t0 = Date.now();
	const inTrash = trashItem(target);
	const ms = Date.now() - t0;
	trashed.push({ original: target, inTrash, gate });
	const after = fs.statSync(inTrash);
	const outcome: TrashOutcome = {
		original: target,
		inTrash,
		sameDevice: before.dev === trashStat.dev,
		sameInode: before.ino === after.ino && before.dev === after.dev,
		insideTrash: inTrash.startsWith(trashDir() + path.sep),
		at: t0,
		ms,
	};
	report(REPORT, { gate, step: 'move-to-trash', ...outcome });
	if (!outcome.sameDevice || !outcome.sameInode || !outcome.insideTrash) {
		throw new Error(`"Move to Trash" was not a same-volume rename into ~/.Trash: ${JSON.stringify(outcome)}`);
	}
	return outcome;
}

/** Finder's "Put Back": the reverse rename out of the Trash. */
function putBack(item: TrashOutcome): number {
	fs.renameSync(item.inTrash, item.original);
	const i = trashed.findIndex((t) => t.inTrash === item.inTrash);
	if (i >= 0) trashed.splice(i, 1);
	return Date.now();
}

/**
 * Take out of the Trash everything this spec put there: rename each item into a
 * bin under start-root (same volume as the Trash, checked in `before()`; a
 * plain process may not list `~/.Trash`, but a rename by path works), then
 * delete the bin. `fs.rmSync` on the Trash path is the fallback.
 */
function emptyOwnTrash(): { removed: string[]; failed: string[] } {
	const removed: string[] = [];
	const failed: string[] = [];
	const bin = fs.mkdtempSync(path.join(startRoot, 'req22a-trash-return-'));
	for (const t of trashed.splice(0)) {
		try {
			if (!fs.existsSync(t.inTrash)) continue;
			const back = path.join(bin, `${removed.length + failed.length}-${path.basename(t.inTrash)}`);
			try {
				fs.renameSync(t.inTrash, back);
			} catch {
				fs.rmSync(t.inTrash, { recursive: true, force: true });
			}
			removed.push(t.inTrash);
		} catch (err) {
			failed.push(`${t.inTrash}: ${String(err)}`);
		}
	}
	fs.rmSync(bin, { recursive: true, force: true });
	return { removed, failed };
}

// --- driving the app -----------------------------------------------------------

async function ensureGateDirExpanded(): Promise<void> {
	if (await explorerHasRow(uri(keep))) return;
	await waitForExplorerRow(uri(gateDir), { timeout: 30_000, nudgeDir: startRoot, nudgePrefix: 'req22a' });
	await clickExplorerRow(uri(gateDir));
	await waitForExplorerRow(uri(keep), { timeout: 15_000 });
}

async function expandFolder(dir: string, child: string): Promise<void> {
	await ensureGateDirExpanded();
	if (await explorerHasRow(uri(child))) return;
	await clickExplorerRow(uri(dir));
	await waitForExplorerRow(uri(child), { timeout: 15_000 });
}

/** Open a Markdown fixture from the tree and wait for its heading. */
async function openMarkdown(file: string, title: string): Promise<void> {
	await clickExplorerRow(uri(file));
	await browser.waitUntil(async () => (await view()).h1 === title, {
		timeout: 15_000,
		timeoutMsg: `${path.basename(file)} did not open (view: ${JSON.stringify(await view())})`,
	});
}

/** Edit > Edit (the menu event), then append EDIT to the source so the document is dirty. */
async function enterEditAndType(): Promise<void> {
	await emitMenu('menu_edit');
	await browser.waitUntil(async () => (await view()).editing, {
		timeout: 5_000,
		timeoutMsg: 'menu_edit did not enter the editor',
	});
	await browser.execute(
		(body, extra) => {
			const pre = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext[contenteditable="true"]`)!;
			pre.textContent = (pre.textContent ?? '') + extra;
			pre.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: extra }));
		},
		BODY,
		EDIT,
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

/**
 * Leave no document open and no editor, without a dialog: the removed banner's
 * Close (`clearDocument`), else put the buffer back to the fixture text and
 * press Done Editing, else open `closer.md` and delete it (a clean document
 * closes on `file_removed`). `plugin:dialog|message` is blocked meanwhile so an
 * unexpected ask can never leave a native sheet on the window.
 */
async function closeAnyOpenDocument(): Promise<Record<string, unknown>> {
	const steps: string[] = [];
	await setIpcBlock(['plugin:dialog|message']);
	try {
		let v = await view();
		if (v.emptyState) return { steps };
		if (v.removed.present) {
			await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="external-removed-close"]')?.click());
			steps.push('removed-banner-close');
			if ((await pollUntil(async () => (await view()).emptyState, 5_000)).ok) return { steps };
			v = await view();
		}
		if (v.editing) {
			// The buffer is the fixture text plus EDIT (enterEditAndType); strip the
			// edit so the buffer equals the document and Done asks nothing.
			const original = v.editorText !== null && v.editorText.endsWith(EDIT) ? v.editorText.slice(0, -EDIT.length) : null;
			await browser.execute(
				(body, text) => {
					const pre = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext[contenteditable="true"]`);
					if (pre && text !== null) {
						pre.textContent = text;
						pre.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
					}
					document.querySelector<HTMLButtonElement>('[data-testid="edit-done"]')?.click();
				},
				BODY,
				original,
			);
			steps.push('revert-and-done');
			await pollUntil(async () => !(await view()).editing, 5_000);
			v = await view();
			if (v.emptyState) return { steps };
		}
		// A clean document closes when its file goes: open closer.md and delete it.
		if (!fs.existsSync(closer)) fs.writeFileSync(closer, doc('Closer'));
		await ensureGateDirExpanded();
		await openMarkdown(closer, 'Closer');
		fs.rmSync(closer, { force: true });
		steps.push('closer-deleted');
		const closed = await pollUntil(async () => (await view()).emptyState, ARRIVAL);
		return { steps, closed: closed.ok, view: closed.ok ? undefined : await view() };
	} finally {
		await setIpcBlock([]);
	}
}

// --- the gates -------------------------------------------------------------------

describe('Requirement #22 追補a human gate (rename / Move to Trash / Put Back / Command + S / parent folder)', () => {
	before(async function () {
		this.timeout(120_000);
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await setIpcCapture(['open_document', 'open_binary_document', 'save_document']);
		await installEventRecorder(['file_removed', 'file_changed', 'binary_file_changed']);
		await assertEventRecorderWorks();
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		buildFixture();
		await ensureGateDirExpanded();
		const trashStat = fs.statSync(trashDir());
		const fixtureStat = fs.statSync(gateDir);
		report(REPORT, {
			gate: 'env',
			user: os.userInfo().username,
			trashDir: trashDir(),
			trashDev: trashStat.dev,
			fixtureDev: fixtureStat.dev,
			sameDevice: trashStat.dev === fixtureStat.dev,
			appHome: process.env.VELLIS_E2E_APP_HOME ?? null,
		});
		// 追補a is about a same-volume rename: the Trash must be on the fixture's volume.
		expect(trashStat.dev).toBe(fixtureStat.dev);
	});

	afterEach(async function () {
		this.timeout(60_000);
		const problems: Record<string, unknown> = {};
		try {
			const r = await closeAnyOpenDocument();
			if (r.steps && (r.steps as string[]).length > 0) problems.closeDocument = r;
		} catch (err) {
			problems.closeDocument = String(err);
		}
		if (Object.keys(problems).length > 0) report(REPORT, { gate: '22a-after-each', ...problems });
	});

	after(async function () {
		this.timeout(60_000);
		const teardown: Record<string, unknown> = {};
		try {
			teardown.dialogs = (await readGateRecord()).dialogs;
			await removeEventRecorder();
			await restoreGateRecorder();
		} catch (err) {
			teardown.page = String(err);
		}
		teardown.trash = emptyOwnTrash();
		fs.rmSync(gateDir, { recursive: true, force: true });
		fs.rmSync(movedParent, { recursive: true, force: true });
		for (const name of fs.readdirSync(startRoot)) {
			if (name.startsWith('req22a-')) fs.rmSync(path.join(startRoot, name), { recursive: true, force: true });
		}
		report(REPORT, { gate: 'teardown', ...teardown });
		if ((teardown.trash as { failed: string[] }).failed.length > 0) {
			throw new Error(`items this spec put in the Trash could not be taken out: ${JSON.stringify(teardown.trash)}`);
		}
	});

	it('gate 1: rename inside the same folder → the clean document closes, once, and the new name is not followed', async function () {
		this.timeout(120_000);
		await ensureGateDirExpanded();
		await openMarkdown(renameMe, 'Rename me');
		await clearLogs();
		await safeShot('req22a-gate1-before-rename');

		const at = Date.now();
		fs.renameSync(renameMe, renamed);
		const closed = await pollUntil(async () => (await view()).emptyState, ARRIVAL);
		await browser.pause(QUIET);
		const ev = await evidence(renameMe, at);
		const rows = await explorerNames();
		await safeShot('req22a-gate1-after-rename');
		report(REPORT, { gate: '22a-1', closed, rows, ...ev });

		// 契約1: the rename is a removal — the document closed on `file_removed`.
		expect(closed.ok).toBe(true);
		expect(ev.view.emptyState).toBe(true);
		expect(ev.view.h1).toBeNull();
		expect(ev.events.fileRemoved).toBe(1);
		// 契約3: no re-read of the vanished path (no `file_changed` for it).
		expect(ev.events.fileChanged).toBe(0);
		// 契約2: the new name is not opened.
		expect(ev.opened).toEqual([]);
		expect(ev.view.removed.present).toBe(false);
		expect(ev.dialogs).toEqual([]);
		// 契約5: the folder listing itself follows the rename (要件#18).
		const listed = await pollUntil(
			async () => (await explorerHasRow(uri(renamed))) && !(await explorerHasRow(uri(renameMe))),
			ARRIVAL,
		);
		report(REPORT, { gate: '22a-1-listing', listed, rows: await explorerNames() });
		expect(listed.ok).toBe(true);
	});

	it('gate 2: a raster image (png) put in the Trash → the view closes, once, with no binary_file_changed', async function () {
		this.timeout(120_000);
		await ensureGateDirExpanded();
		await clearLogs();
		await clickExplorerRow(uri(picture));
		await browser.waitUntil(async () => (await view()).image.shown && (await view()).image.alt === 'picture.png', {
			timeout: 15_000,
			timeoutMsg: `picture.png did not show in the image viewer (view: ${JSON.stringify(await view())})`,
		});
		const openedBefore = openedUris(await readCapturedIpc());
		const openCmds = (await readCapturedIpc()).map((c) => `${c.cmd}:${c.ok}`);
		await safeShot('req22a-gate2-before-trash');
		await clearLogs();

		const t = moveToTrash(picture, '22a-2');
		const closed = await pollUntil(async () => (await view()).emptyState, ARRIVAL);
		await browser.pause(QUIET);
		const ev = await evidence(picture, t.at);
		await safeShot('req22a-gate2-after-trash');
		report(REPORT, { gate: '22a-2', openedBefore, openCmds, closed, ...ev });

		// The image was opened through the binary session (要件#22) …
		expect(openedBefore).toEqual([uri(picture)]);
		expect(openCmds.some((c) => c.startsWith('open_binary_document:true'))).toBe(true);
		// … and 契約1: the Trash move closed the view on `file_removed`, once.
		expect(closed.ok).toBe(true);
		expect(ev.view.emptyState).toBe(true);
		expect(ev.view.image.shown).toBe(false);
		expect(ev.events.fileRemoved).toBe(1);
		// 契約3: no `binary_file_changed` for the vanished path.
		expect(ev.events.binaryFileChanged).toBe(0);
		expect(ev.opened).toEqual([]);
		expect(ev.dialogs).toEqual([]);
	});

	it('gate 3: dirty document → Trash → banner; Put Back → the banner goes; Trash again → the banner is back', async function () {
		this.timeout(180_000);
		await ensureGateDirExpanded();
		await openMarkdown(restoreMe, 'Restore me');
		await enterEditAndType();
		expect((await view()).editorText).toBe(doc('Restore me') + EDIT);
		await clearLogs();

		// 1. Trash → the removed banner (要件#48 追補g), document and edits kept.
		const t1 = moveToTrash(restoreMe, '22a-3');
		const shown1 = await pollUntil(async () => (await view()).removed.present, ARRIVAL);
		await browser.pause(QUIET);
		const a = await evidence(restoreMe, t1.at);
		await safeShot('req22a-gate3-a-trashed');
		report(REPORT, { gate: '22a-3-a-trashed', shown: shown1, ...a });
		expect(shown1.ok).toBe(true);
		expect(a.view.removed.present).toBe(true);
		expect(a.view.removed.text).toBe(REMOVED_DIRTY);
		expect(a.view.removed.buttons).toEqual(['Save', 'Close']);
		expect(a.view.removed.saveTitle).toBe(SAVE_TITLE_DIRTY);
		expect(a.view.editing).toBe(true);
		expect(a.view.editorText).toBe(doc('Restore me') + EDIT);
		expect(a.view.emptyState).toBe(false);
		expect(a.events.fileRemoved).toBe(1);
		expect(a.events.fileChanged).toBe(0);
		expect(a.dialogs).toEqual([]);

		// 2. Put Back → 人間ゲート: 帯が消える. The file is back at its path with the
		//    original text, which differs from the edits, so AC-48-追g (d) applies:
		//    the removed banner goes and the external-change banner takes its
		//    place (印が消え、外部変更の帯が出る). The view at the moment the removed
		//    banner went (`viewWhenGone`) and the events that arrived are recorded.
		await clearLogs();
		const backAt = putBack(t1);
		const gone = await pollUntil(async () => !(await view()).removed.present, ARRIVAL);
		const bFirst = await view();
		await browser.pause(QUIET);
		const b = await evidence(restoreMe, backAt);
		await safeShot('req22a-gate3-b-put-back');
		report(REPORT, { gate: '22a-3-b-put-back', gone, viewWhenGone: bFirst, ...b });
		expect(gone.ok).toBe(true);
		expect(b.view.removed.present).toBe(false);
		// AC-48-追g (d): the external-change banner, with its two choices.
		expect(b.view.changed.present).toBe(true);
		expect(b.view.changed.text).toBe(CHANGED);
		expect(b.view.changed.buttons).toEqual(['Overwrite', 'Reload']);
		// The edits are still there (要件#48 追補g: nothing is dropped silently).
		expect(b.view.editing).toBe(true);
		expect(b.view.editorText).toBe(doc('Restore me') + EDIT);
		expect(b.view.emptyState).toBe(false);
		expect(b.onDisk).toBe(true);
		expect(b.dialogs).toEqual([]);

		// 3. Trash again → the banner is back (the hub's `gone` was reset by the
		//    return; 契約3 counts one `file_removed` per move).
		await clearLogs();
		const t2 = moveToTrash(restoreMe, '22a-3');
		const shown2 = await pollUntil(async () => (await view()).removed.present, ARRIVAL);
		await browser.pause(QUIET);
		const c = await evidence(restoreMe, t2.at);
		await safeShot('req22a-gate3-c-trashed-again');
		report(REPORT, { gate: '22a-3-c-trashed-again', shown: shown2, ...c });
		expect(shown2.ok).toBe(true);
		expect(c.view.removed.present).toBe(true);
		expect(c.view.removed.text).toBe(REMOVED_DIRTY);
		// 要件#48 追補h 契約1: never both banners at once.
		expect(c.view.changed.present).toBe(false);
		expect(c.view.editing).toBe(true);
		expect(c.view.editorText).toBe(doc('Restore me') + EDIT);
		expect(c.events.fileRemoved).toBe(1);
		expect(c.events.fileChanged).toBe(0);
		expect(c.dialogs).toEqual([]);
	});

	it('gate 4: dirty document → Trash → banner; Command + S writes it back → the banner goes; Trash again → the (now clean) document closes; put back, edited again → Trash → the banner is back', async function () {
		this.timeout(180_000);
		await ensureGateDirExpanded();
		await openMarkdown(resaveMe, 'Resave me');
		await enterEditAndType();
		expect((await view()).editorText).toBe(doc('Resave me') + EDIT);
		await clearLogs();

		// 1. Trash → the removed banner.
		const t1 = moveToTrash(resaveMe, '22a-4');
		const shown1 = await pollUntil(async () => (await view()).removed.present, ARRIVAL);
		await browser.pause(QUIET);
		const a = await evidence(resaveMe, t1.at);
		await safeShot('req22a-gate4-a-trashed');
		report(REPORT, { gate: '22a-4-a-trashed', shown: shown1, ...a });
		expect(shown1.ok).toBe(true);
		expect(a.view.removed.text).toBe(REMOVED_DIRTY);
		expect(a.view.editing).toBe(true);
		expect(a.events.fileRemoved).toBe(1);
		expect(a.onDisk).toBe(false);

		// 2. Command + S = File > Save: the same `menu_save` event the menu item
		//    emits (gate-helpers rule: menus are not clicked). 要件#48 追補i
		//    `shouldSaveOnCommand`: dirty + removed → `save_document` to the same
		//    uri; the banner goes on success and the file is back with the edits.
		await clearLogs();
		const saveAt = Date.now();
		await emitMenu('menu_save');
		const saved = await pollUntil(
			async () =>
				(await readCapturedIpc()).some((c) => c.cmd === 'save_document' && c.ok) && !(await view()).removed.present,
			ARRIVAL,
		);
		await browser.pause(QUIET);
		const b = await evidence(resaveMe, saveAt);
		const saveCalls = (await readCapturedIpc())
			.filter((c) => c.cmd === 'save_document')
			.map((c) => ({ ok: c.ok, args: c.args, error: c.ok ? null : c.body }));
		const onDisk = fs.existsSync(resaveMe) ? fs.readFileSync(resaveMe, 'utf8') : null;
		await safeShot('req22a-gate4-b-saved');
		report(REPORT, { gate: '22a-4-b-saved', route: 'menu_save event (File > Save = Command + S)', saved, saveCalls, onDiskIsEdited: onDisk === doc('Resave me') + EDIT, ...b });
		expect(saved.ok).toBe(true);
		expect(saveCalls.length).toBe(1);
		expect(saveCalls[0]!.ok).toBe(true);
		expect((saveCalls[0]!.args as { uri?: string } | null)?.uri).toBe(uri(resaveMe));
		expect(onDisk).toBe(doc('Resave me') + EDIT);
		expect(b.view.removed.present).toBe(false);
		// The save's own echo is not an external change (要件#48 契約⑥).
		expect(b.view.changed.present).toBe(false);
		expect(b.view.editing).toBe(true);
		expect(b.view.editorText).toBe(doc('Resave me') + EDIT);
		expect(b.events.fileRemoved).toBe(0);
		expect(b.dialogs).toEqual([]);

		// 3. Trash again → the document closes. The save (`markSaved`) made the
		//    buffer equal the document, so it is clean; a clean document closes on
		//    `file_removed` (要件#48 追補g 契約1), and the hub — its `gone` reset by
		//    the save's own write — announces this second disappearance again
		//    (追補a 契約3: one `file_removed` per move).
		await clearLogs();
		const t2 = moveToTrash(resaveMe, '22a-4');
		const closed = await pollUntil(async () => (await view()).emptyState, ARRIVAL);
		await browser.pause(QUIET);
		const c = await evidence(resaveMe, t2.at);
		await safeShot('req22a-gate4-c-trashed-again-closed');
		report(REPORT, { gate: '22a-4-c-trashed-again', closed, ...c });
		expect(closed.ok).toBe(true);
		expect(c.view.emptyState).toBe(true);
		expect(c.view.h1).toBeNull();
		expect(c.view.editing).toBe(false);
		expect(c.view.removed.present).toBe(false);
		expect(c.view.changed.present).toBe(false);
		expect(c.events.fileRemoved).toBe(1);
		expect(c.events.fileChanged).toBe(0);
		expect(c.opened).toEqual([]);
		expect(c.dialogs).toEqual([]);

		// 4. The dirty banner once more, from a file at its path: the file the save
		//    wrote (now in the Trash after step 3) is *put back* — no new fixture —
		//    so what is reopened is exactly what Command + S wrote. Reopen (the
		//    document closed in step 3), edit again, Trash → the dirty banner.
		const backAt = putBack(t2);
		const putBackContent = fs.readFileSync(resaveMe, 'utf8');
		report(REPORT, { gate: '22a-4-d-put-back', how: 'put back the saved file from the Trash (fs.renameSync), then reopen', backAt, onDiskIsSavedContent: putBackContent === doc('Resave me') + EDIT });
		expect(putBackContent).toBe(doc('Resave me') + EDIT);
		await ensureGateDirExpanded();
		await waitForExplorerRow(uri(resaveMe), { timeout: ARRIVAL });
		await openMarkdown(resaveMe, 'Resave me');
		await enterEditAndType();
		expect((await view()).editorText).toBe(doc('Resave me') + EDIT + EDIT);
		await clearLogs();
		const t3 = moveToTrash(resaveMe, '22a-4');
		const shown3 = await pollUntil(async () => (await view()).removed.present, ARRIVAL);
		await browser.pause(QUIET);
		const d = await evidence(resaveMe, t3.at);
		await safeShot('req22a-gate4-d-trashed-dirty-again');
		report(REPORT, { gate: '22a-4-d-trashed-dirty-again', shown: shown3, ...d });
		expect(shown3.ok).toBe(true);
		expect(d.view.removed.present).toBe(true);
		expect(d.view.removed.text).toBe(REMOVED_DIRTY);
		expect(d.view.removed.saveTitle).toBe(SAVE_TITLE_DIRTY);
		expect(d.view.removed.buttons).toEqual(['Save', 'Close']);
		expect(d.view.changed.present).toBe(false);
		expect(d.view.editing).toBe(true);
		expect(d.view.editorText).toBe(doc('Resave me') + EDIT + EDIT);
		expect(d.view.emptyState).toBe(false);
		expect(d.events.fileRemoved).toBe(1);
		expect(d.events.fileChanged).toBe(0);
		expect(d.dialogs).toEqual([]);
	});

	// Gate 5 is an observation (req-22.md: no machine test covers it; closing is
	// fine, not closing goes to a separate Issue). It fails only when the harness
	// could not run the scenario; `closed` in the `[gate]` line is the answer.
	for (const c of [
		{ gate: '22a-5-trash', parent: parentTrash, inner: innerTrash, title: 'Inner trash', how: 'Move to Trash' },
		{ gate: '22a-5-move', parent: parentMove, inner: innerMove, title: 'Inner move', how: 'rename to another folder' },
	] as const) {
		it(`gate 5 (${c.how}): the open document's parent folder goes → does the document close? (observed, recorded)`, async function () {
			this.timeout(120_000);
			await expandFolder(c.parent, c.inner);
			await openMarkdown(c.inner, c.title);
			await clearLogs();
			await safeShot(`${c.gate}-before`);

			let at: number;
			if (c.how === 'Move to Trash') {
				at = moveToTrash(c.parent, c.gate).at;
			} else {
				at = Date.now();
				fs.renameSync(c.parent, movedParent);
			}
			const closed = await pollUntil(async () => (await view()).emptyState, ARRIVAL);
			await browser.pause(QUIET);
			const ev = await evidence(c.inner, at);
			const parentRowGone = await pollUntil(async () => !(await explorerHasRow(uri(c.parent))), 5_000);
			await safeShot(`${c.gate}-after`);
			report(REPORT, {
				gate: c.gate,
				how: c.how,
				observation: closed.ok ? 'document closed' : 'document stayed open (record for a separate Issue)',
				closed,
				parentRowGone,
				...ev,
			});
			// Harness checks only: the folder did go, nothing was opened, no dialog.
			expect(fs.existsSync(c.inner)).toBe(false);
			expect(ev.opened).toEqual([]);
			expect(ev.dialogs).toEqual([]);
			// When it did close, it closed the 追補a way: one `file_removed`, no re-read.
			if (closed.ok) {
				expect(ev.events.fileRemoved).toBe(1);
				expect(ev.events.fileChanged).toBe(0);
			}
		});
	}

	it('no dialog was raised by any of the gates', async () => {
		const rec = await readGateRecord();
		report(REPORT, { gate: '22a-dialogs', dialogs: rec.dialogs });
		expect(rec.dialogs).toEqual([]);
	});
});
