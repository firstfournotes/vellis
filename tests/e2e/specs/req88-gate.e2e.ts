import { browser } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
	assertEventRecorderWorks,
	assertIpcInterceptionWorks,
	clearCapturedIpc,
	clickExplorerRow,
	explorerHasRow,
	installEventRecorder,
	installGateRecorder,
	mdFaceText,
	MD_FACE,
	FACE,
	faceText,
	pixelAt,
	pixelDistance,
	readCapturedIpc,
	readEventRecord,
	readGateRecord,
	removeEventRecorder,
	report,
	restoreGateRecorder,
	setIpcBlock,
	setIpcCapture,
	shotBitmap,
	SHOTS_DIR,
	waitForAppMounted,
	waitForExplorerRow,
	type CapturedIpc,
} from '../gate-helpers';

/**
 * Requirement #88 (links inside the HTML preview: a local file opens in this tab, an outside
 * URL goes to the OS) — AC-88-8, the device gate, against the live webview of a webdriver build
 * on a real screen (docs/requirements/req-88.md 契約 1〜14・作り・AC-88-8).
 *
 * What the gate judges, in two stages that run apart or together (`VELLIS_GATE_VARIANT` =
 * `a` | `b` | `all`, set by `scripts/gate-device/run-gate-spec.sh req88 <variant>`; mocha's grep
 * through `VELLIS_GATE_GREP='stage A'` / `'stage B'` / `'gate A-2'` narrows further):
 *
 * Stage A — no real key or mouse; webdriver only. The frame's content is sandboxed (opaque
 * origin), so the page cannot click a link inside it. Instead the spec makes the situation a
 * click makes: a frame of THIS window navigating to the link URL
 * `vellis-asset://link/<token>?href=<the attribute value>`. A throwaway sandboxed `<iframe>` is
 * appended to the app's page with that URL as its `src` (the viewer's own frame is left alone:
 * `srcdoc` wins over `src`, so pointing its `src` would do nothing — 判断の記録 1). wry hands
 * every frame navigation to Tauri's `on_navigation`; the plugin in `html_link.rs` refuses it and
 * reports `html_link_clicked` to this window; the page decides (`decideHtmlLink`). The token is
 * read from the parent-readable `iframe.srcdoc` of the viewer (`buildSrcdoc` with `links`).
 *  - A-1  the srcdoc of links.html carries ` href="vellis-asset://link/<token>?href=notes.md"
 *         target="_self"` and `data-vellis-href="notes.md"`; `sandbox` is "" (契約 9)
 *  - A-2  a relative Markdown → notes.md opens in this tab (the same view as the Explorer's row
 *         click; `open_document` once; the window count unchanged; no alert) (契約 2・3)
 *  - A-3  a relative HTML → page2.html's frame, with the SAME token in its srcdoc (作り 3)
 *  - A-4  a PDF → the PDF frame (vellis-asset: source)        (契約 3)
 *  - A-5  an image → the image viewer                         (契約 3)
 *  - A-6  a folder-relative path, an absolute path, `notes.md#part` (the `#…` is not used), and
 *         the document itself (nothing happens)                (契約 2・4)
 *  - A-7  https (with `&amp;` in the attribute value) and mailto → `plugin:opener|open_url` once,
 *         with the decoded URL; the frame stays. The command is BLOCKED at the fetch layer (the
 *         interception is proven first), so no browser or mail app opens (契約 1)
 *  - A-8  a wrong token, no token, `javascript:`, `data:`, `vbscript:`, an empty href, no href
 *         → nothing: no IPC, the frame as it was, no dialog (契約 7・11)
 *  - A-9  a missing file and a folder → one alert each (`Could not open the file: …`), the frame
 *         as it was (契約 5)
 *  - A-10 tricks.html (a nested frame / meta refresh / an image at the link URL with a fake
 *         token), four seconds with no click → nothing opens, no alert (契約 11)
 *  - A-11 the same report while a Markdown file is shown → nothing (作り 3)
 *  - A-12 two windows: the report in this window changes the other window's document not at
 *         all (契約 12; File ▸ New Window pressed by AX, the other window read by AX)
 *  - A-13 the app's log gained no `navigation refused` line from any of it, and none names a
 *         link target (作り 2)
 *
 * Stage B — real clicks, sent by the operator (`scripts/gate-device/req88-gate.sh`, realinput)
 * into the frame of bands.html: six link bands of 100 CSS px from the top of the frame, so the
 * point is computed, and the pixels of a screenshot tell where the frame is and what it shows
 * (the frame's content is not readable from the page).
 *  - B-0  the bands are where the fixture puts them (pixel colours) — else the environment
 *  - B-1  a plain relative link (notes.md) → this tab shows notes.md
 *  - B-2  `target="_blank"` to an outside URL → `open_url` once (blocked), the frame stays
 *  - B-3  a `download` link (pic.png) → the image in this tab (契約 8)
 *  - B-4  an SVG `<a xlink:href>` (paper.pdf) → the PDF in this tab
 *  - B-5  an `<area>` (sub/deep.md) → the Markdown in this tab
 *  - B-6  `#sec` → the frame scrolls to the red section (pixels), the srcdoc the same, no IPC,
 *         no report (契約 6・10)
 *  - B-7  the window count never changed (今のタブ) and no dialog came from the product
 *
 * Not here: the print document (契約 13) is fixed byte for byte by the unit test
 * `src/lib/html-link.page-wiring.acceptance.test.ts`, so the device does not print.
 *
 * Each judgement is one JSON line in `$VELLIS_GATE_SHOTS/req88-report.jsonl` (`pass` true /
 * false, `side` = the variant; a line without `pass` is a fact; `gate: "environment"` = the
 * environment, not the product). The operator takes the steps the page cannot: real clicks, the
 * front, dialogs, screenshots. This spec writes `<SHOTS_DIR>/req88-op-<variant>/req-<n>.json`
 * and waits for `ack-<n>.json`. Without the operator (VELLIS_GATE_REQ88_OPERATOR unset) stage B
 * is reported as skipped and stage A runs in full.
 *
 * Build and run (from the repository root; the binary is a copy outside src-tauri/target, not
 * named `vellis` — lib.sh):
 *   pnpm tauri build --debug --no-bundle -f webdriver          # 配布と同じ作り(dev-features なし)
 *   cp src-tauri/target/debug/vellis <out>/vellis-gate88
 *   xcrun swiftc -O scripts/gate-device/axtool.swift    -o <out>/axtool
 *   xcrun swiftc -O scripts/gate-device/realinput.swift -o <out>/realinput   # stage B; Accessibility for this terminal
 *   export VELLIS_GATE_BIN=<out>/vellis-gate88 VELLIS_GATE_AXTOOL=<out>/axtool VELLIS_GATE_OUT=<out> VELLIS_GATE_REALINPUT=<out>/realinput
 *   scripts/gate-device/run-gate-spec.sh req88 a              # stage A alone (no operator needed)
 *   scripts/gate-device/req88-gate.sh b                       # stage B alone (the operator starts run-gate-spec.sh)
 *   scripts/gate-device/req88-gate.sh all                     # both
 * Runs only under those scripts (VELLIS_GATE_DEVICE=1).
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const VARIANT = process.env.VELLIS_GATE_VARIANT ?? 'a';
const OPERATOR = process.env.VELLIS_GATE_REQ88_OPERATOR === '1';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const realinput = process.env.VELLIS_GATE_REALINPUT ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';
const REPORT = 'req88-report.jsonl';
const OP_DIR = path.join(SHOTS_DIR, `req88-op-${VARIANT}`);
const APP_LOG = path.join(SHOTS_DIR, `req88-${VARIANT}-app.log`);

const STAGE_A = VARIANT === 'a' || VARIANT === 'all';
const STAGE_B = VARIANT === 'b' || VARIANT === 'all';

const uriOf = (abs: string) => `file://${abs.split(path.sep).join('/')}`;
const fileOf = (rel: string) => path.join(root, rel);
const fileUri = (rel: string) => uriOf(fileOf(rel));

// The viewer's DOM: +page.svelte mounts HtmlViewer / PdfViewer / ImageViewer in `.viewer-main`
// (2026-11-21 run out-nav: not inside `article.viewer`); the Markdown face is MD_FACE.
const HTML_FRAME = '.viewer-main iframe.html-viewer';
const PDF_FRAME = '.viewer-main iframe.pdf-frame';
const IMAGE = '.viewer-main .image-viewer img';
const EXPLORER_HEADER = '.explorer-header';
const OPEN_URL = 'plugin:opener|open_url';
const OPEN_CMDS = ['open_document', 'open_binary_document'];
const LINK_EVENT = 'html_link_clicked';
const TOKEN_RE = /vellis-asset:\/\/link\/([A-Za-z0-9_-]+)\?href=/;
const ALERT_PREFIX = 'alert:Could not open the file: ';
const OUTSIDE = 'https://vellis-gate88.invalid';

/** The link URL `buildSrcdoc` writes for an attribute value `raw` (the value as written, percent-encoded). */
const linkUrl = (token: string, raw: string) => `vellis-asset://link/${token}?href=${encodeURIComponent(raw)}`;

// --- the tools (pid-pinned child processes, as req84) ----------------------------------------

function tool(exe: string, args: string[]): Record<string, unknown>[] {
	let out: string;
	try {
		out = execFileSync(exe, args, {
			encoding: 'utf8',
			timeout: 30_000,
			env: { ...process.env, AXTOOL_EXPECT_EXE: bin, REALINPUT_EXPECT_EXE: bin },
		});
	} catch (e) {
		const err = e as { stderr?: string; message?: string };
		throw new Error(`${path.basename(exe)} ${args.join(' ')} failed: ${err.stderr?.trim() || err.message}`);
	}
	return out
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}
const ax = (args: string[]) => tool(axtool, args);

function appPid(): number {
	const pids = ax(['pids-of-exe', bin]).map((r) => r.pid as number);
	if (pids.length !== 1) throw new Error(`expected one app process of ${bin}, found ${JSON.stringify(pids)}`);
	return pids[0]!;
}

interface AxWin {
	index: number;
	title: string;
	subrole: string;
	x: number;
	y: number;
	w: number;
	h: number;
	main: boolean;
}
/** The app's standard windows by AX (title, frame, main). */
function stdWindows(pid: number): AxWin[] {
	try {
		return (ax(['axwins', String(pid)]) as unknown as AxWin[]).filter((w) => w.subrole === 'AXStandardWindow');
	} catch {
		return [];
	}
}
/** The AX strings of window `index` of the app, web content included; null when they cannot be read. */
function axTexts(pid: number, index: number): string[] | null {
	try {
		return (ax(['texts', String(pid), String(index)])[0]?.texts as string[] | undefined) ?? null;
	} catch {
		return null;
	}
}

// --- the operator (scripts/gate-device/req88-gate.sh) ------------------------------------------

let opSeq = 0;

async function operator(step: string, args: Record<string, unknown> = {}, timeoutMs = 90_000): Promise<Record<string, unknown> | null> {
	if (!OPERATOR) return null;
	fs.mkdirSync(OP_DIR, { recursive: true });
	const seq = ++opSeq;
	const req = path.join(OP_DIR, `req-${seq}.json`);
	const ack = path.join(OP_DIR, `ack-${seq}.json`);
	const tmp = `${req}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ seq, step, args, at: Date.now() }));
	fs.renameSync(tmp, req);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(ack)) {
			const text = fs.readFileSync(ack, 'utf8');
			if (text.trim() !== '') {
				const answer = JSON.parse(text) as Record<string, unknown>;
				report(REPORT, { gate: 'operator', side: VARIANT, step, args, answer });
				return answer;
			}
		}
		await browser.pause(300);
	}
	throw new Error(`operator step ${step} (#${seq}) was not answered within ${timeoutMs} ms`);
}

// --- judgement ---------------------------------------------------------------------------------

let fails: string[] = [];
function judge(gate: string, item: string, pass: boolean, extra: Record<string, unknown> = {}): boolean {
	report(REPORT, { gate, side: VARIANT, item, pass, ...extra });
	if (!pass) fails.push(`${gate}: ${item}`);
	return pass;
}
function fact(gate: string, item: string, extra: Record<string, unknown> = {}): void {
	report(REPORT, { gate, side: VARIANT, item, ...extra });
}
function skipped(gate: string, item: string, why: string): void {
	report(REPORT, { gate, side: VARIANT, item, note: `skipped: ${why}` });
}
let realInputBlocked: string | null = null;
let calibrationBlocked: string | null = null;
/**
 * The environment, not the product, stopped a gate (the front could not be taken, the user was at
 * the keyboard, the frame is not where the fixture puts it): one `environment` row (no pass), the
 * real input of this `it` is stopped, and the `it` ends on an `environment:` error.
 */
function environment(item: string, extra: Record<string, unknown> = {}): never {
	realInputBlocked = item;
	report(REPORT, { gate: 'environment', side: VARIANT, item, reason: item, ...extra });
	throw new Error(`environment: ${item}`);
}
function requireRealInput(): void {
	if (realInputBlocked) throw new Error(`environment: ${realInputBlocked}`);
}

// --- the page ----------------------------------------------------------------------------------

async function exists(selector: string): Promise<boolean> {
	return browser.execute((s) => document.querySelector(s) !== null, selector);
}
async function waitFor(selector: string, what: string, timeout = 20_000): Promise<void> {
	await browser.waitUntil(async () => exists(selector), { timeout, timeoutMsg: `${what}: ${selector} never appeared` });
}
interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}
async function rectOf(selector: string): Promise<Rect | null> {
	return browser.execute((s) => {
		const el = document.querySelector(s);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	}, selector);
}

/** What the window shows: which viewer is up and what it holds (the comparison "the same view as the Explorer's click"). */
interface View {
	kind: 'html' | 'pdf' | 'image' | 'markdown' | 'code' | 'none';
	srcdoc: string | null;
	sandbox: string | null;
	pdf_src: string | null;
	img_src: string | null;
	md_text: string | null;
	code_text: string | null;
	badge: boolean;
}
async function view(): Promise<View> {
	const dom = await browser.execute(
		(html, pdf, img, md, face) => {
			const h = document.querySelector<HTMLIFrameElement>(html);
			const p = document.querySelector<HTMLIFrameElement>(pdf);
			const i = document.querySelector<HTMLImageElement>(img);
			const strip = (s: string | null) => (s === null ? null : s.split('?')[0] ?? s);
			return {
				kind: h ? 'html' : p ? 'pdf' : i ? 'image' : document.querySelector(md) ? 'markdown' : document.querySelector(face) ? 'code' : 'none',
				srcdoc: h ? h.srcdoc : null,
				sandbox: h ? h.getAttribute('sandbox') : null,
				pdf_src: strip(p?.getAttribute('src') ?? null),
				img_src: strip(i?.getAttribute('src') ?? null),
				badge: document.querySelector('[data-testid="unsaved-badge"]') !== null,
			};
		},
		HTML_FRAME,
		PDF_FRAME,
		IMAGE,
		MD_FACE,
		FACE,
	);
	const kind = dom.kind as View['kind'];
	return { ...dom, kind, md_text: kind === 'markdown' ? await mdFaceText() : null, code_text: kind === 'code' ? await faceText() : null };
}
/** The part of a view that must be the same when the same file is shown (the frame's srcdoc, the source, the text). */
function signature(v: View): Record<string, unknown> {
	return { kind: v.kind, srcdoc: v.srcdoc, pdf_src: v.pdf_src, img_src: v.img_src, md_text: v.md_text, code_text: v.code_text };
}
const sameSignature = (a: View, b: View) => JSON.stringify(signature(a)) === JSON.stringify(signature(b));
/** A view in the report: the srcdoc shortened. */
function brief(v: View): Record<string, unknown> {
	return { ...v, srcdoc: v.srcdoc === null ? null : `${v.srcdoc.slice(0, 160)}… (${v.srcdoc.length} chars)`, md_text: v.md_text?.slice(0, 120) ?? null, code_text: v.code_text?.slice(0, 120) ?? null };
}
async function waitView(pred: (v: View) => boolean, what: string, timeout = 15_000): Promise<View> {
	let last: View | null = null;
	try {
		await browser.waitUntil(
			async () => {
				last = await view();
				return pred(last);
			},
			{ timeout, timeoutMsg: what },
		);
	} catch {
		// the caller judges what is shown now
	}
	return last ?? (await view());
}

/** Open a document of the root by its Explorer row and wait until the view shows it. */
async function openDoc(rel: string, pred: (v: View) => boolean): Promise<View> {
	// A file below a folder is listed only once that folder is expanded: click each collapsed ancestor's row first
	// (2026-11-26 run A #1: "explorer never listed …/sub/deep.md" — the Explorer starts with folders collapsed).
	const parts = rel.split('/');
	for (let i = 1; i < parts.length; i += 1) {
		if (await explorerHasRow(fileUri(parts.slice(0, i + 1).join('/')))) continue;
		await clickExplorerRow(fileUri(parts.slice(0, i).join('/')));
		await browser.pause(600);
	}
	await clickExplorerRow(fileUri(rel));
	const v = await waitView(pred, `open ${rel}`, 30_000);
	if (!pred(v)) throw new Error(`${rel} did not open (now: ${JSON.stringify(brief(v))})`);
	await browser.pause(400);
	return v;
}
const showsHtml = (marker: string) => (v: View) => v.kind === 'html' && (v.srcdoc ?? '').includes(marker);
const showsMd = (marker: string) => (v: View) => v.kind === 'markdown' && (v.md_text ?? '').includes(marker);
const showsPdf = (name: string) => (v: View) => v.kind === 'pdf' && (v.pdf_src ?? '').startsWith('vellis-asset:') && (v.pdf_src ?? '').includes(name);
const showsImage = (name: string) => (v: View) => v.kind === 'image' && (v.img_src ?? '').includes(name);

/** The window's token, read from the viewer's srcdoc (the parent can read the attribute; the document inside cannot). */
async function tokenOf(v: View): Promise<string | null> {
	return TOKEN_RE.exec(v.srcdoc ?? '')?.[1] ?? null;
}

/**
 * The situation a click makes, without a click: a throwaway sandboxed frame of this window
 * navigates to `url`. The frame is tiny and off the viewport; it is removed after `settleMs`.
 */
async function probe(url: string, settleMs = 1_500): Promise<void> {
	await browser.execute((u) => {
		const f = document.createElement('iframe');
		f.setAttribute('sandbox', '');
		f.setAttribute('data-req88-probe', '1');
		f.setAttribute('title', 'req88 probe');
		f.style.cssText = 'position:fixed;left:-40px;top:-40px;width:8px;height:8px;opacity:0;pointer-events:none;border:0';
		f.src = u;
		document.body.appendChild(f);
	}, url);
	await browser.pause(settleMs);
	await browser.execute(() => document.querySelectorAll('iframe[data-req88-probe]').forEach((f) => f.remove()));
}

// --- marks over the recorders ------------------------------------------------------------------

async function ipcMark(): Promise<number> {
	return (await readCapturedIpc()).length;
}
async function ipcAfter(mark: number, cmds?: string[]): Promise<CapturedIpc[]> {
	const all = (await readCapturedIpc()).slice(mark);
	return cmds ? all.filter((e) => cmds.includes(e.cmd)) : all;
}
/** Every IPC command name the page sent since `mark` (the recorder's full list, not only the captured ones). */
async function allIpcMark(): Promise<number> {
	return (await readGateRecord()).ipc.length;
}
async function allIpcAfter(mark: number): Promise<string[]> {
	return (await readGateRecord()).ipc.slice(mark);
}
async function dialogsMark(): Promise<number> {
	return (await readGateRecord()).dialogs.length;
}
async function dialogsAfter(mark: number): Promise<string[]> {
	return (await readGateRecord()).dialogs.slice(mark);
}
async function eventsMark(): Promise<number> {
	return (await readEventRecord()).length;
}
async function linkEventsAfter(mark: number): Promise<string[]> {
	return (await readEventRecord())
		.slice(mark)
		.filter((e) => e.event === LINK_EVENT)
		.map((e) => String((e.payload as { url?: unknown } | null)?.url ?? ''));
}
const urlArg = (c: CapturedIpc) => ((c.args as { url?: unknown } | null)?.url ?? null) as string | null;
const uriArg = (c: CapturedIpc) => ((c.args as { uri?: unknown } | null)?.uri ?? null) as string | null;
const briefIpc = (list: CapturedIpc[]) => list.map((c) => ({ cmd: c.cmd, ok: c.ok, url: urlArg(c), uri: uriArg(c), body: typeof c.body === 'string' ? c.body.slice(0, 120) : c.ok ? '(ok)' : c.body }));

/** The `navigation refused` warnings in the app's log (ANSI colours stripped). */
function refusedNavigations(): string[] {
	if (!fs.existsSync(APP_LOG)) return [];
	// eslint-disable-next-line no-control-regex
	const text = fs.readFileSync(APP_LOG, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
	return text.split('\n').filter((l) => /navigation refused/.test(l));
}
/** Lines of the app's log that name a link target of this gate (the URL must never be logged — 作り 2). */
function logLinesNamingTargets(): string[] {
	if (!fs.existsSync(APP_LOG)) return [];
	const text = fs.readFileSync(APP_LOG, 'utf8');
	return text.split('\n').filter((l) => /vellis-gate88\.invalid|nowhere\.md|vellis-asset:\/\/link\//.test(l));
}

// --- real input: the screen (req84) ------------------------------------------------------------

interface Screen {
	pid: number;
	frame: { x: number; y: number; w: number; h: number; number: number };
	dx: number;
	dy: number;
	route: 'pid' | 'hid';
}
let screen: Screen | null = null;

function toScreen(clientX: number, clientY: number): { x: number; y: number } {
	if (!screen) throw new Error('screen not calibrated');
	return { x: Math.round(screen.frame.x + screen.dx + clientX), y: Math.round(screen.frame.y + screen.dy + clientY) };
}
function refreshFrame(pid: number): void {
	if (!screen) return;
	const wins = ax(['cgwins', String(pid)]).filter((w) => w.onscreen === true);
	const w = wins.sort((a, b) => (b.w as number) * (b.h as number) - (a.w as number) * (a.h as number))[0];
	if (w) screen.frame = { x: w.x as number, y: w.y as number, w: w.w as number, h: w.h as number, number: w.number as number };
}

interface MouseRec {
	type: string;
	clientX: number;
	clientY: number;
}
/** The page's own view of real mouse input (the calibration click lands on the Explorer header, which the page sees). */
async function installMouseHook(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __gate88mouse?: MouseRec[] };
		if (w.__gate88mouse) return;
		const list: MouseRec[] = [];
		w.__gate88mouse = list;
		window.addEventListener('mousedown', (e) => list.push({ type: 'mousedown', clientX: e.clientX, clientY: e.clientY }), true);
	});
}
async function mouseEvents(): Promise<MouseRec[]> {
	return browser.execute(() => JSON.parse(JSON.stringify((window as unknown as { __gate88mouse?: MouseRec[] }).__gate88mouse ?? [])) as MouseRec[]);
}

/**
 * Find the window and measure the WKWebView's offset in it with one real left click on the
 * Explorer header (a click there does nothing), as req84 does. Never throws: when no real input
 * can go out, an `environment` row is written and stage B's real input is stopped.
 */
async function calibrate(pid: number): Promise<void> {
	const wins = ax(['cgwins', String(pid)]).filter((w) => w.onscreen === true);
	if (wins.length === 0) throw new Error('the test app has no on-screen window');
	const w = wins.sort((a, b) => (b.w as number) * (b.h as number) - (a.w as number) * (a.h as number))[0]!;
	const inner = await browser.execute(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }));
	const guess = { dx: Math.round(((w.w as number) - inner.innerWidth) / 2), dy: (w.h as number) - inner.innerHeight };
	screen = { pid, frame: { x: w.x as number, y: w.y as number, w: w.w as number, h: w.h as number, number: w.number as number }, dx: guess.dx, dy: guess.dy, route: 'hid' };
	const block = (item: string, extra: Record<string, unknown>) => {
		calibrationBlocked = item;
		realInputBlocked = item;
		report(REPORT, { gate: 'environment', side: VARIANT, item, reason: item, ...extra });
	};
	if (!OPERATOR) {
		block('no operator: the calibration click cannot be sent, so no real input in this run (stage B is skipped)', {});
		return;
	}
	const header = await rectOf(EXPLORER_HEADER);
	if (!header) {
		block('the Explorer header is not on screen; no point for the calibration click', {});
		return;
	}
	const cy = Math.round(header.y + header.height / 2);
	const candidates = [
		{ name: 'explorer header centre', x: Math.round(header.x + header.width / 2), y: cy },
		{ name: 'explorer header left', x: Math.round(header.x + 24), y: cy },
		{ name: 'explorer header right', x: Math.round(header.x + header.width * 0.8), y: cy },
	];
	const tried: Array<Record<string, unknown>> = [];
	let chosen: { name: string; x: number; y: number; s: { x: number; y: number } } | null = null;
	for (const c of candidates) {
		const s = toScreen(c.x, c.y);
		const at = await operator('windowat', { x: s.x, y: s.y });
		tried.push({ candidate: c, screen: s, windowat: at });
		if (at?.app_window === true) {
			chosen = { ...c, s };
			break;
		}
	}
	if (!chosen) {
		block('no calibration point lies under the app’s own window (something covers the Explorer header); no real input in this run', { tried });
		return;
	}
	let md: MouseRec | undefined;
	const attempts: Array<{ route: string; answer: Record<string, unknown> | null }> = [];
	for (const route of ['hid', 'pid'] as const) {
		const before = (await mouseEvents()).length;
		const answer = await operator('click', { x: chosen.s.x, y: chosen.s.y, route }, 240_000);
		await browser.pause(400);
		attempts.push({ route, answer });
		if (answer?.idle_short === true) {
			block(`the user was at the keyboard (idle ${String(answer.idle_s)} s) when the calibration click was due; no real input in this run`, { answer });
			return;
		}
		md = (await mouseEvents()).slice(before).find((m) => m.type === 'mousedown');
		if (md) {
			screen.route = route;
			break;
		}
	}
	if (!md) {
		block(`the calibration click at ${chosen.name} was not seen by the page on either route; no real input in this run`, { chosen, attempts });
		return;
	}
	const measured = { dx: chosen.s.x - screen.frame.x - md.clientX, dy: chosen.s.y - screen.frame.y - md.clientY };
	const drift = { dx: measured.dx - guess.dx, dy: measured.dy - guess.dy };
	screen.dx = measured.dx;
	screen.dy = measured.dy;
	report(REPORT, { gate: 'calibration', side: VARIANT, pid, window: w, inner, guess, measured, drift, mousedown: md, chosen, tried, attempts });
	if (Math.abs(drift.dx) > 4 || Math.abs(drift.dy) > 4) block(`the calibration click drifted by ${JSON.stringify(drift)}; no real input in this run`, { drift });
}

/**
 * A real single left click at a viewport point through the operator: the HID route first (the
 * route WebKit takes for a real click), then the pid route when the first was not sent. The frame
 * is sandboxed, so the page never sees the click — what follows (the view, the IPC, the pixels)
 * tells whether it landed.
 */
async function realClick(clientX: number, clientY: number): Promise<{ sent: boolean; route: string | null; answers: Array<Record<string, unknown> | null> }> {
	requireRealInput();
	refreshFrame(screen!.pid);
	const s = toScreen(clientX, clientY);
	const answers: Array<Record<string, unknown> | null> = [];
	for (const route of [screen!.route, screen!.route === 'hid' ? 'pid' : 'hid']) {
		const a = await operator('click', { x: s.x, y: s.y, route }, 240_000);
		answers.push(a);
		if (a && a.idle_short === true) environment(`the user was at the keyboard (idle ${String(a.idle_s)} s) when the click at (${s.x}, ${s.y}) was due; not sent`, { answer: a });
		if (a && a.front === false) environment(`the driver could not bring the window to the front for the click at (${s.x}, ${s.y}); not sent`, { answer: a });
		if (a?.sent === true) return { sent: true, route, answers };
	}
	return { sent: false, route: null, answers };
}

// --- pixels of the frame (stage B) -------------------------------------------------------------

type Rgb = [number, number, number];
const hexRgb = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
/** The bands of bands.html (req88-fixtures.sh): 100 CSS px each from the top of the frame (600 px in all fit the default window's viewer). */
const BAND_H = 100;
const BANDS = [
	{ n: 1, what: 'a plain relative link (notes.md)', color: '#1f5fbf' },
	{ n: 2, what: 'target="_blank" to an outside URL', color: '#2f8f4f' },
	{ n: 3, what: 'a download link (pic.png)', color: '#8f4f2f' },
	{ n: 4, what: 'an SVG <a xlink:href> (paper.pdf)', color: '#4f2f8f' },
	{ n: 5, what: 'an <area> of an image map (sub/deep.md)', color: '#2f6f6f' },
	{ n: 6, what: 'an in-page link (#sec)', color: '#bf1f5f' },
] as const;
const SECTION_RED = '#ff0000';
/** Two pixels of band `n` (near its left edge and at its centre), as [r, g, b] of a fresh screenshot, with where they were read. */
async function bandPixels(name: string, frame: Rect, n: number): Promise<{ left: Rgb; centre: Rgb; file: string; at: Record<string, unknown> }> {
	const { bmp, dpr, file } = await shotBitmap(name);
	const y = frame.y + BAND_H * (n - 1) + 14;
	const xl = frame.x + 24;
	const xc = frame.x + frame.width / 2;
	const read = (x: number, yy: number): Rgb => pixelAt(bmp, Math.min(bmp.width - 1, Math.round(x * dpr)), Math.min(bmp.height - 1, Math.round(yy * dpr)));
	return { left: read(xl, y), centre: read(xc, y), file, at: { css: { xl, xc, y }, dpr, bitmap: { w: bmp.width, h: bmp.height } } };
}
const closeTo = (a: Rgb, hex: string, tol = 48) => pixelDistance(a, hexRgb(hex)) <= tol;

// --- stage A -----------------------------------------------------------------------------------

let token: string | null = null;
let expected: Record<string, View> = {};
let openCmd: Record<string, string | null> = {};
let refusedAtStart = 0;
let logNamingAtStart = 0;

/** The view and the open command the Explorer's own click produces for each target (the reference of "the same view"). */
async function recordExplorerViews(): Promise<void> {
	for (const [rel, pred] of [
		['notes.md', showsMd('REQ88 NOTES marker')],
		['page2.html', showsHtml('REQ88 PAGE2 marker')],
		['paper.pdf', showsPdf('paper.pdf')],
		['pic.png', showsImage('pic.png')],
		['sub/deep.md', showsMd('REQ88 DEEP marker')],
	] as Array<[string, (v: View) => boolean]>) {
		const m = await ipcMark();
		expected[rel] = await openDoc(rel, pred);
		openCmd[rel] = (await ipcAfter(m, OPEN_CMDS)).find((c) => uriArg(c) === fileUri(rel))?.cmd ?? null;
	}
	fact('A', 'the Explorer’s own click on each target: the view and the open command it uses (the reference for "the same view")', { views: Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, brief(v)])), open_cmd: openCmd });
}

/** Open links.html and read the window's token from its srcdoc. */
async function openLinks(): Promise<View> {
	const v = await openDoc('links.html', showsHtml('REQ88 LINKS marker'));
	const t = await tokenOf(v);
	if (t) {
		if (token && token !== t) fact('A', 'the token in the srcdoc changed between two openings of links.html (the window’s token should be one per page load)', { before: token, now: t });
		token = t;
	}
	return v;
}

/** One report → the outcome: the view afterwards, the IPC, the dialogs, the link events, with `wait` deciding when to stop waiting. */
interface Outcome {
	before: View;
	after: View;
	ipc: CapturedIpc[];
	all_ipc: string[];
	dialogs: string[];
	events: string[];
	windows: { before: number; after: number };
}
async function fire(pid: number, url: string, wait: (v: View) => boolean, timeout = 15_000): Promise<Outcome> {
	const before = await view();
	const m = await ipcMark();
	const ma = await allIpcMark();
	const d = await dialogsMark();
	const e = await eventsMark();
	const wb = stdWindows(pid).length;
	await probe(url);
	const after = await waitView(wait, `after ${url}`, timeout);
	await browser.pause(600);
	return { before, after, ipc: await ipcAfter(m), all_ipc: await allIpcAfter(ma), dialogs: await dialogsAfter(d), events: await linkEventsAfter(e), windows: { before: wb, after: stdWindows(pid).length } };
}
const outcomeBrief = (o: Outcome) => ({ before: brief(o.before), after: brief(o.after), ipc: briefIpc(o.ipc), all_ipc: o.all_ipc, dialogs: o.dialogs, events: o.events, windows: o.windows });

/** A report that must open `rel` in this tab: the same view as the Explorer's click, the same open command once, no alert. */
async function judgeOpens(pid: number, gate: string, what: string, raw: string, rel: string, pred: (v: View) => boolean): Promise<void> {
	await openLinks();
	if (!token) throw new Error('no token in the srcdoc of links.html');
	const o = await fire(pid, linkUrl(token, raw), pred);
	const opens = o.ipc.filter((c) => OPEN_CMDS.includes(c.cmd));
	const same = expected[rel] ? sameSignature(o.after, expected[rel]) : false;
	judge(gate, `${what}: ${rel} opens in this tab — the view is the Explorer’s (${expected[rel]?.kind ?? '?'}), ${openCmd[rel] ?? 'open'} called once with its URI (ok), the window count unchanged, no alert, no open_url`, pred(o.after) && same && opens.length === 1 && opens[0]!.cmd === openCmd[rel] && opens[0]!.ok === true && uriArg(opens[0]!) === fileUri(rel) && o.windows.before === o.windows.after && o.dialogs.length === 0 && !o.ipc.some((c) => c.cmd === OPEN_URL), { href: raw, url: linkUrl(token, raw), same_view_as_explorer: same, ...outcomeBrief(o) });
	fact(gate, `${what}: the report reached the page (html_link_clicked seen by the second listener: ${o.events.length})`, { events: o.events });
}

/** A report that must do nothing: the frame as it was, no IPC at all, no alert. */
async function judgeNothing(pid: number, gate: string, what: string, url: string, extra: Record<string, unknown> = {}): Promise<Outcome> {
	const o = await fire(pid, url, () => false, 3_000);
	judge(gate, `${what}: nothing happens — the frame's srcdoc as it was, no open / open_url IPC, no alert, the window count unchanged`, sameSignature(o.before, o.after) && o.after.kind === o.before.kind && o.ipc.length === 0 && o.dialogs.length === 0 && o.windows.before === o.windows.after, { url, ...extra, ...outcomeBrief(o) });
	return o;
}

async function gateA1(): Promise<void> {
	const v = await openLinks();
	const t = await tokenOf(v);
	const s = v.srcdoc ?? '';
	judge('A-1', 'links.html: the srcdoc carries ` href="vellis-asset://link/<token>?href=notes.md" target="_self"` on the link and keeps `data-vellis-href="notes.md"`; the token is base64url of 22+ characters', t !== null && /^[A-Za-z0-9_-]{22,}$/.test(t) && s.includes(` href="vellis-asset://link/${t}?href=notes.md" target="_self"`) && s.includes('data-vellis-href="notes.md"'), { token: t, srcdoc_head: s.slice(0, 200), has_base: s.includes('<base href="vellis-asset://local/') });
	judge('A-1', 'the frame’s `sandbox` is "" (契約 9: not loosened)', v.sandbox === '', { sandbox: v.sandbox });
	fact('A-1', 'the token of this window (one per page load; the srcdoc is rebuilt with it)', { token: t });
}

async function gateA2to5(pid: number): Promise<void> {
	await judgeOpens(pid, 'A-2', 'a relative Markdown link', 'notes.md', 'notes.md', showsMd('REQ88 NOTES marker'));
	await judgeOpens(pid, 'A-3', 'a relative HTML link', 'page2.html', 'page2.html', showsHtml('REQ88 PAGE2 marker'));
	const v = await view();
	judge('A-3', 'page2.html’s srcdoc carries the SAME token as links.html did (one token per window; the second document is clickable too)', (await tokenOf(v)) === token, { token_before: token, token_now: await tokenOf(v) });
	await judgeOpens(pid, 'A-4', 'a relative PDF link', 'paper.pdf', 'paper.pdf', showsPdf('paper.pdf'));
	await judgeOpens(pid, 'A-5', 'a relative image link', 'pic.png', 'pic.png', showsImage('pic.png'));
}

async function gateA6(pid: number): Promise<void> {
	await judgeOpens(pid, 'A-6', 'a link one folder down (sub/deep.md)', 'sub/deep.md', 'sub/deep.md', showsMd('REQ88 DEEP marker'));
	await judgeOpens(pid, 'A-6', `an absolute path (${fileOf('notes.md')})`, fileOf('notes.md'), 'notes.md', showsMd('REQ88 NOTES marker'));
	await judgeOpens(pid, 'A-6', 'a link with a fragment on another file (notes.md#part: the `#…` is not used)', 'notes.md#part', 'notes.md', showsMd('REQ88 NOTES marker'));
	await openLinks();
	await judgeNothing(pid, 'A-6', 'a link to the document itself (links.html)', linkUrl(token!, 'links.html'));
}

async function gateA7(pid: number): Promise<void> {
	for (const c of [
		{ what: 'https with `&amp;` in the attribute value', raw: `${OUTSIDE}/p?a=1&amp;b=2`, url: `${OUTSIDE}/p?a=1&b=2` },
		{ what: 'mailto', raw: 'mailto:someone@vellis-gate88.invalid', url: 'mailto:someone@vellis-gate88.invalid' },
	]) {
		await openLinks();
		const o = await fire(pid, linkUrl(token!, c.raw), () => false, 3_000);
		const opens = o.ipc.filter((x) => x.cmd === OPEN_URL);
		judge('A-7', `${c.what}: plugin:opener|open_url exactly once with ${c.url} (blocked at the fetch layer, so nothing outside opened), the frame as it was, no alert, no open_document`, opens.length === 1 && urlArg(opens[0]!) === c.url && opens[0]!.ok === false && sameSignature(o.before, o.after) && o.dialogs.length === 0 && !o.ipc.some((x) => OPEN_CMDS.includes(x.cmd)), { href: c.raw, ...outcomeBrief(o) });
	}
}

async function gateA8(pid: number): Promise<void> {
	await openLinks();
	const t = token!;
	const cases: Array<{ what: string; url: string }> = [
		{ what: 'a wrong token (the right href notes.md)', url: linkUrl('WRONGTOKEN0000000000000', 'notes.md') },
		{ what: 'no token (vellis-asset://link/?href=notes.md)', url: 'vellis-asset://link/?href=notes.md' },
		{ what: 'javascript: with the right token', url: linkUrl(t, 'javascript:alert(1)') },
		{ what: 'data: with the right token', url: linkUrl(t, 'data:text/html,<h1>x</h1>') },
		{ what: 'vbscript: with the right token', url: linkUrl(t, 'vbscript:msgbox') },
		{ what: 'an empty href with the right token', url: linkUrl(t, '   ') },
		{ what: 'the right token with no href at all', url: `vellis-asset://link/${t}` },
	];
	let seen = 0;
	for (const c of cases) {
		const o = await judgeNothing(pid, 'A-8', c.what, c.url);
		seen += o.events.length;
	}
	if (seen === 0) report(REPORT, { gate: 'environment', side: VARIANT, item: 'A-8: none of the seven reports was seen by the second listener (html_link_clicked); the "nothing happens" rows above may be vacuous — the positive gates (A-2〜A-6) show whether the route is live', reason: 'no event seen' });
	else fact('A-8', `the reports reached the page (${seen} html_link_clicked seen by the second listener) and the page dropped every one`, { seen });
}

async function gateA9(pid: number): Promise<void> {
	for (const c of [
		{ what: 'a missing file (nowhere.md)', raw: 'nowhere.md', rel: 'nowhere.md' },
		{ what: 'a folder (sub/)', raw: 'sub/', rel: 'sub/' },
	]) {
		await openLinks();
		const o = await fire(pid, linkUrl(token!, c.raw), () => false, 3_000);
		const opens = o.ipc.filter((x) => OPEN_CMDS.includes(x.cmd));
		judge('A-9', `${c.what}: one alert "${ALERT_PREFIX.slice('alert:'.length)}…", the open command failed once, the frame as it was (links.html), no open_url`, o.dialogs.length === 1 && o.dialogs[0]!.startsWith(ALERT_PREFIX) && opens.length === 1 && opens[0]!.ok === false && sameSignature(o.before, o.after) && showsHtml('REQ88 LINKS marker')(o.after) && !o.ipc.some((x) => x.cmd === OPEN_URL), { href: c.raw, ...outcomeBrief(o) });
	}
}

async function gateA10(pid: number): Promise<void> {
	const m = await ipcMark();
	const d = await dialogsMark();
	const e = await eventsMark();
	const refusedBefore = refusedNavigations().length;
	const wb = stdWindows(pid).length;
	const v = await openDoc('tricks.html', showsHtml('REQ88 TRICKS marker'));
	await browser.pause(4_000);
	const after = await view();
	const ipc = await ipcAfter(m);
	const opensOther = ipc.filter((c) => OPEN_CMDS.includes(c.cmd) && uriArg(c) !== fileUri('tricks.html'));
	const events = await linkEventsAfter(e);
	judge('A-10', 'tricks.html (a nested <iframe src="vellis-asset://link/<fake>…">, <meta http-equiv="refresh"> to it, <img src> at it) opened and left for 4 s with no click: nothing else opens — no open_url, no other open command, no alert, the frame still tricks.html, the window count unchanged', sameSignature(v, after) && showsHtml('REQ88 TRICKS marker')(after) && !ipc.some((c) => c.cmd === OPEN_URL) && opensOther.length === 0 && (await dialogsAfter(d)).length === 0 && stdWindows(pid).length === wb, { ipc: briefIpc(ipc), dialogs: await dialogsAfter(d), events, view: brief(after) });
	fact('A-10', `the nested frame’s navigation ${events.some((u) => u.includes('FAKETOKEN')) ? 'was reported to the page with the fake token (and dropped)' : 'was not seen by the second listener (sandbox / CSP may have stopped it before the handler)'}; "navigation refused" lines gained: ${refusedNavigations().length - refusedBefore}`, { events, refused_gained: refusedNavigations().length - refusedBefore });
}

async function gateA11(pid: number): Promise<void> {
	await openDoc('notes.md', showsMd('REQ88 NOTES marker'));
	const o = await fire(pid, linkUrl(token!, 'page2.html'), () => false, 3_000);
	judge('A-11', 'the same report while notes.md (Markdown) is shown: dropped — the Markdown face as it was, no open IPC, no alert', o.after.kind === 'markdown' && sameSignature(o.before, o.after) && o.ipc.length === 0 && o.dialogs.length === 0, outcomeBrief(o));
}

async function gateA12(pid: number): Promise<void> {
	const before = stdWindows(pid);
	let pressed: Record<string, unknown> | null = null;
	try {
		pressed = ax(['menu', String(pid), 'File', 'New Window'])[0] ?? null;
	} catch (e) {
		report(REPORT, { gate: 'environment', side: VARIANT, item: `A-12: File ▸ New Window could not be pressed by AX (${String(e)}); the two-window check is not judged`, reason: 'menu press failed' });
		return;
	}
	let wins: AxWin[] = before;
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		wins = stdWindows(pid);
		if (wins.length === before.length + 1) break;
		await browser.pause(300);
	}
	const other = wins.find((w) => !before.some((b) => b.title === w.title && Math.abs(b.x - w.x) < 3 && Math.abs(b.y - w.y) < 3)) ?? null;
	if (wins.length !== before.length + 1 || !other) {
		report(REPORT, { gate: 'environment', side: VARIANT, item: 'A-12: a second window did not appear within 15 s of File ▸ New Window; not judged', reason: 'no second window', pressed, windows: wins });
		return;
	}
	try {
		await browser.pause(1_500);
		// webdriver must still drive the first window: the page hooks installed in `before` live only there.
		const stillFirst = await browser.execute(() => '__gate88mouse' in window && '__gate' in window);
		if (!stillFirst) {
			report(REPORT, { gate: 'environment', side: VARIANT, item: 'A-12: after the second window opened, the page webdriver drives is not the first window any more (the hooks of `before` are missing); not judged', reason: 'webdriver window changed' });
			return;
		}
		await openLinks();
		const firstIdx = stdWindows(pid).find((w) => w.index !== other.index)?.index ?? 0;
		const o = await fire(pid, linkUrl(token!, 'notes.md'), showsMd('REQ88 NOTES marker'));
		const otherTexts = axTexts(pid, other.index);
		const firstTexts = axTexts(pid, firstIdx);
		const otherShows = otherTexts ? otherTexts.some((t) => t.includes('REQ88 NOTES marker')) : null;
		const firstShows = firstTexts ? firstTexts.some((t) => t.includes('REQ88 NOTES marker')) : null;
		if (otherShows === null) report(REPORT, { gate: 'environment', side: VARIANT, item: 'A-12: the AX strings of the second window could not be read; not judged', reason: 'no AX texts', other });
		else judge('A-12', 'two windows: the report in this window opens notes.md here and changes the other window’s document not at all (its AX strings hold no "REQ88 NOTES marker")', showsMd('REQ88 NOTES marker')(o.after) && otherShows === false, { other, first_index: firstIdx, first_window_shows_marker_by_ax: firstShows, other_window_shows_marker_by_ax: otherShows, ...outcomeBrief(o) });
	} finally {
		try {
			const now = stdWindows(pid).find((w) => w.title === other.title && Math.abs(w.x - other.x) < 3 && Math.abs(w.y - other.y) < 3) ?? other;
			ax(['close', String(pid), String(now.index)]);
			await browser.pause(1_000);
			fact('A-12', 'the second window was closed by AX', { windows: stdWindows(pid).length });
		} catch (e) {
			fact('A-12', `the second window could not be closed by AX (${String(e)})`, {});
		}
	}
}

function gateA13(): void {
	const refused = refusedNavigations().length - refusedAtStart;
	const naming = logLinesNamingTargets().slice(logNamingAtStart);
	judge('A-13', 'the app’s log gained no "navigation refused" line from the link reports of stage A (a link click is refused without a warning), and no line names a link target (vellis-gate88.invalid / nowhere.md / vellis-asset://link/)', refused === 0 && naming.length === 0, { refused_gained: refused, lines_naming_targets: naming.map((l) => l.slice(0, 300)), log: APP_LOG, log_exists: fs.existsSync(APP_LOG) });
}

// --- stage B -----------------------------------------------------------------------------------

/** Open bands.html, check its frame is on screen and the bands are where the fixture puts them (pixels). */
async function openBands(name: string): Promise<{ frame: Rect; v: View }> {
	const v = await openDoc('bands.html', showsHtml('REQ88 BAND 1'));
	await browser.pause(800);
	const frame = await rectOf(HTML_FRAME);
	if (!frame || frame.width < 200 || frame.height < BAND_H * 6 + 20) environment(`B: the HTML frame is not on screen or too small for six bands (${JSON.stringify(frame)}); the bands cannot be clicked`, { frame });
	if ((v.srcdoc ?? '').includes(':root{zoom:')) environment(`B: the preview is zoomed (the srcdoc carries a zoom style); the bands are not at ${BAND_H} CSS px — not clicked`, {});
	const px = await Promise.all(BANDS.map((b) => bandPixels(`req88-${VARIANT}-${name}-band${b.n}`, frame, b.n)));
	const ok = px.every((p, i) => closeTo(p.left, BANDS[i]!.color) && closeTo(p.centre, BANDS[i]!.color));
	if (!ok) environment(`B: the pixels of the frame do not show the six bands where the fixture puts them (zoom, scroll, a sheet over the window?); not clicked`, { frame, pixels: px.map((p, i) => ({ band: i + 1, expect: BANDS[i]!.color, left: p.left, centre: p.centre, file: p.file })) });
	fact('B-0', `bands.html: the six bands are at ${BAND_H} CSS px each from the top of the frame (pixel colours match the fixture)`, { frame, pixels: px.map((p, i) => ({ band: i + 1, expect: BANDS[i]!.color, left: p.left, centre: p.centre })), shot: px[0]!.file });
	return { frame, v };
}
function bandPoint(frame: Rect, n: number): { x: number; y: number } {
	return { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + BAND_H * (n - 1) + BAND_H / 2) };
}

async function clickBand(pid: number, n: number, wait: (v: View) => boolean, timeout = 15_000): Promise<Outcome & { click: Awaited<ReturnType<typeof realClick>>; point: { x: number; y: number }; frame: Rect }> {
	const { frame } = await openBands(`before-band${n}`);
	const before = await view();
	const m = await ipcMark();
	const ma = await allIpcMark();
	const d = await dialogsMark();
	const e = await eventsMark();
	const wb = stdWindows(pid).length;
	const point = bandPoint(frame, n);
	const click = await realClick(point.x, point.y);
	if (!click.sent) environment(`B-${n}: the click on band ${n} could not be sent on either route`, { answers: click.answers });
	const after = await waitView(wait, `after the click on band ${n}`, timeout);
	await browser.pause(800);
	return { before, after, ipc: await ipcAfter(m), all_ipc: await allIpcAfter(ma), dialogs: await dialogsAfter(d), events: await linkEventsAfter(e), windows: { before: wb, after: stdWindows(pid).length }, click, point, frame };
}

async function judgeBandOpens(pid: number, n: number, rel: string, pred: (v: View) => boolean): Promise<void> {
	const b = BANDS[n - 1]!;
	const o = await clickBand(pid, n, pred);
	const opens = o.ipc.filter((c) => OPEN_CMDS.includes(c.cmd));
	const same = expected[rel] ? sameSignature(o.after, expected[rel]) : false;
	judge(`B-${n}`, `a real click (${o.click.route}) on band ${n} — ${b.what}: ${rel} opens in this tab (the Explorer’s view, ${openCmd[rel] ?? 'open'} once ok), the window count unchanged, no alert, no open_url`, pred(o.after) && same && opens.length === 1 && opens[0]!.ok === true && uriArg(opens[0]!) === fileUri(rel) && o.windows.before === o.windows.after && o.dialogs.length === 0 && !o.ipc.some((c) => c.cmd === OPEN_URL), { point: o.point, click: o.click, same_view_as_explorer: same, ...outcomeBrief(o) });
	fact(`B-${n}`, `the click’s report (html_link_clicked seen by the second listener: ${o.events.length})`, { events: o.events });
}

async function gateB2(pid: number): Promise<void> {
	const o = await clickBand(pid, 2, () => false, 3_000);
	const opens = o.ipc.filter((c) => c.cmd === OPEN_URL);
	const px = await bandPixels(`req88-${VARIANT}-after-band2`, o.frame, 1);
	judge('B-2', `a real click (${o.click.route}) on band 2 — target="_blank" to ${OUTSIDE}/blank: plugin:opener|open_url exactly once with that URL (blocked, so no browser), the frame as it was (srcdoc the same, band 1 still at the top), no alert, no open command`, opens.length === 1 && urlArg(opens[0]!) === `${OUTSIDE}/blank` && opens[0]!.ok === false && sameSignature(o.before, o.after) && closeTo(px.left, BANDS[0]!.color) && o.dialogs.length === 0 && !o.ipc.some((c) => OPEN_CMDS.includes(c.cmd)), { point: o.point, click: o.click, pixels_after: px, ...outcomeBrief(o) });
	const f = await operator('front');
	fact('B-2', 'the front app after the click (the opener was blocked at the fetch layer, so no browser could come to the front; recorded, not judged)', { front: f });
}

async function gateB6(pid: number): Promise<void> {
	const o = await clickBand(pid, 6, () => false, 1_500);
	const px = await bandPixels(`req88-${VARIANT}-after-band6`, o.frame, 1);
	judge('B-6', `a real click (${o.click.route}) on band 6 — #sec: the frame scrolls inside itself so the red section is at its top (pixels ${SECTION_RED}), the srcdoc the same (no navigation of the frame), no IPC, no html_link_clicked report, no alert`, closeTo(px.left, SECTION_RED) && closeTo(px.centre, SECTION_RED) && sameSignature(o.before, o.after) && o.ipc.length === 0 && o.events.length === 0 && o.dialogs.length === 0, { point: o.point, click: o.click, pixels_after: px, expect: SECTION_RED, ...outcomeBrief(o) });
}

// =================================================================================================
describe(`Requirement #88 AC-88-8 (links inside the HTML preview) — ${VARIANT === 'a' ? 'stage A: the link reports without real input' : VARIANT === 'b' ? 'stage B: real clicks on the bands' : 'stages A and B'}`, function () {
	this.timeout(900_000);
	let pid = 0;
	let windowsAtStart = 0;

	before(async function () {
		if (!DEVICE) this.skip();
		for (const [name, value] of Object.entries({ VELLIS_GATE_BIN: bin, VELLIS_GATE_AXTOOL: axtool, VELLIS_E2E_INITIAL_ROOT: root })) {
			if (!value) throw new Error(`${name} is not set`);
		}
		if (STAGE_B && OPERATOR && !realinput) throw new Error('VELLIS_GATE_REALINPUT is not set (stage B with the operator)');
		for (const f of ['links.html', 'bands.html', 'tricks.html', 'notes.md', 'page2.html', 'paper.pdf', 'pic.png', 'clear.png', 'sub/deep.md']) {
			if (!fs.existsSync(fileOf(f))) throw new Error(`fixture ${f} is missing in ${root} (req88-fixtures.sh)`);
		}
		if (fs.existsSync(fileOf('nowhere.md'))) throw new Error('nowhere.md exists; the missing-file gate needs it absent');
		fs.mkdirSync(SHOTS_DIR, { recursive: true });
		fs.rmSync(OP_DIR, { recursive: true, force: true });
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		// The opener is blocked for the whole run: an outside URL must never reach a browser or a mail app from a gate.
		await setIpcBlock([OPEN_URL]);
		await setIpcCapture([OPEN_URL, ...OPEN_CMDS]);
		await clearCapturedIpc();
		await installMouseHook();
		await installEventRecorder([LINK_EVENT]);
		await assertEventRecorderWorks();
		pid = appPid();
		await waitForExplorerRow(fileUri('links.html'), { timeout: 30_000, nudgeDir: root, nudgePrefix: 'req88-root' });
		windowsAtStart = stdWindows(pid).length;
		refusedAtStart = refusedNavigations().length;
		logNamingAtStart = logLinesNamingTargets().length;
		report(REPORT, { gate: 'setup', side: VARIANT, operator: OPERATOR, stages: { a: STAGE_A, b: STAGE_B }, pid, bin, root, windows: windowsAtStart, app_log: APP_LOG, idle: (await operator('idle')) ?? null });
		await recordExplorerViews();
		if (STAGE_B) await calibrate(pid);
	});

	beforeEach(function () {
		if (!DEVICE) return;
		fails = [];
		realInputBlocked = calibrationBlocked;
	});
	afterEach(async function () {
		if (!DEVICE) return;
		if (this.currentTest?.state === 'failed') {
			report(REPORT, { gate: 'failed', side: VARIANT, test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
		}
		// A probe frame left behind by a failed it, and the dialogs of this it (native ones, when the operator is there).
		await browser.execute(() => document.querySelectorAll('iframe[data-req88-probe]').forEach((f) => f.remove())).catch(() => undefined);
		await operator('dialog', { wait_s: 1, expect: '', answer: 'escape' }).catch(() => null);
	});
	after(async function () {
		if (!DEVICE) return;
		try {
			report(REPORT, { gate: 'teardown', side: VARIANT, windows: stdWindows(pid).length, page_dialogs: (await readGateRecord()).dialogs, captured: briefIpc(await readCapturedIpc()), refused_lines_total: refusedNavigations().length });
			await removeEventRecorder();
			await setIpcBlock([]);
			await restoreGateRecorder();
		} finally {
			await operator('done', {}, 60_000).catch(() => null);
		}
	});

	const itA = (title: string, fn: () => Promise<void> | void) => (STAGE_A ? it(title, fn) : it.skip(title, fn));
	const itB = (title: string, fn: () => Promise<void> | void) => (STAGE_B ? it(title, fn) : it.skip(title, fn));

	itA('stage A gate A-1: links.html’s srcdoc carries the link URL with the window’s token and target="_self", keeps data-vellis-href, and the frame’s sandbox is ""', async () => {
		await gateA1();
	});
	itA('stage A gate A-2〜A-5: a relative Markdown / HTML / PDF / image link opens that file in this tab — the same view as the Explorer’s click, the open command once, no alert; the second HTML carries the same token', async () => {
		await gateA2to5(pid);
	});
	itA('stage A gate A-6: a folder-relative path, an absolute path and `notes.md#part` open the file; the document itself does nothing', async () => {
		await gateA6(pid);
	});
	itA('stage A gate A-7: https (with &amp;) and mailto go to plugin:opener|open_url exactly once with the decoded URL (blocked here), the frame stays', async () => {
		await gateA7(pid);
	});
	itA('stage A gate A-8: a wrong token, no token, javascript: / data: / vbscript:, an empty href and no href do nothing', async () => {
		await gateA8(pid);
	});
	itA('stage A gate A-9: a missing file and a folder → one alert each ("Could not open the file: …"), the frame stays', async () => {
		await gateA9(pid);
	});
	itA('stage A gate A-10: tricks.html (nested frame / meta refresh / img at the link URL with a fake token) opens nothing in 4 s without a click', async () => {
		await gateA10(pid);
	});
	itA('stage A gate A-11: the same report while a Markdown file is shown is dropped', async () => {
		await gateA11(pid);
	});
	itA('stage A gate A-12: two windows — the report in this window leaves the other window’s document alone (File ▸ New Window by AX; the other window read by AX; closed afterwards)', async () => {
		await gateA12(pid);
	});
	itA('stage A gate A-13: the app’s log gained no "navigation refused" line from the link reports and names no link target', () => {
		gateA13();
	});

	itB('stage B gate B-1: a real click on band 1 (a plain relative link) opens notes.md in this tab', async () => {
		if (!OPERATOR) {
			skipped('B-1', 'real click on band 1', 'no operator (a judgement without the click sent would be a false green)');
			return;
		}
		await judgeBandOpens(pid, 1, 'notes.md', showsMd('REQ88 NOTES marker'));
	});
	itB('stage B gate B-2: a real click on band 2 (target="_blank" to an outside URL) → open_url once (blocked), the frame stays', async () => {
		if (!OPERATOR) {
			skipped('B-2', 'real click on band 2', 'no operator');
			return;
		}
		await gateB2(pid);
	});
	itB('stage B gate B-3: a real click on band 3 (a download link to pic.png) opens the image in this tab', async () => {
		if (!OPERATOR) {
			skipped('B-3', 'real click on band 3', 'no operator');
			return;
		}
		await judgeBandOpens(pid, 3, 'pic.png', showsImage('pic.png'));
	});
	itB('stage B gate B-4: a real click on band 4 (an SVG <a xlink:href> to paper.pdf) opens the PDF in this tab', async () => {
		if (!OPERATOR) {
			skipped('B-4', 'real click on band 4', 'no operator');
			return;
		}
		await judgeBandOpens(pid, 4, 'paper.pdf', showsPdf('paper.pdf'));
	});
	itB('stage B gate B-5: a real click on band 5 (an <area> of an image map to sub/deep.md) opens the Markdown in this tab', async () => {
		if (!OPERATOR) {
			skipped('B-5', 'real click on band 5', 'no operator');
			return;
		}
		await judgeBandOpens(pid, 5, 'sub/deep.md', showsMd('REQ88 DEEP marker'));
	});
	itB('stage B gate B-6: a real click on band 6 (#sec) scrolls inside the frame to the red section — the srcdoc the same, no IPC, no report', async () => {
		if (!OPERATOR) {
			skipped('B-6', 'real click on band 6', 'no operator');
			return;
		}
		await gateB6(pid);
	});
	itB('stage B gate B-7: the window count never changed (今のタブ) and no dialog came from the product during stage B', async () => {
		const d = await operator('dialog', { wait_s: 2, expect: '', answer: 'escape' });
		judge('B-7', 'the app has as many windows as at the start (every file opened in this tab)', stdWindows(pid).length === windowsAtStart, { at_start: windowsAtStart, now: stdWindows(pid).length });
		judge('B-7', 'no native dialog (sheet / dialog window / UserNotificationCenter) stands at the end of stage B', !d || d.dialogs === 0, { dialogs: d });
	});

	it('dialogs the page stubbed during the run: exactly the alerts the gates asked for (A-9: two) and no other', async () => {
		const rec = await readGateRecord();
		const asked = rec.dialogs.filter((d) => d.startsWith(ALERT_PREFIX));
		const others = rec.dialogs.filter((d) => !d.startsWith(ALERT_PREFIX));
		judge('dialogs', `no window.alert / confirm / prompt other than the "Could not open the file" alerts reached the page (${VARIANT})`, others.length === 0, { others, asked: asked.length });
		if (STAGE_A) judge('dialogs', 'the "Could not open the file" alerts are exactly the two of A-9 (a missing file, a folder)', asked.length === 2, { asked });
	});
});
