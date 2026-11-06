import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertEventRecorderWorks,
	assertIpcInterceptionWorks,
	clearEventRecord,
	clickExplorerRow,
	colorKey,
	colorsIn,
	decodePng,
	emitEvent,
	emitMenu,
	installEventRecorder,
	installGateRecorder,
	pixelAt,
	pixelDistance,
	pointAtRegion,
	readEventRecord,
	readGateRecord,
	removeEventRecorder,
	report,
	restoreGateRecorder,
	shot,
	SHOTS_DIR,
	waitForAppMounted,
	waitForExplorerRow,
	zoomedShot,
} from '../gate-helpers';

/**
 * Requirement #56 (UI の作り直し) stage 2 — the machine-checkable part of the
 * human gates 2〜6 and 8 of docs/requirements/req-56.md (「人間ゲート」節), driven
 * against the live webview of a webdriver build on a real screen
 * (`scripts/gate-device/run-gate-spec.sh req56`). Gate 1 (the match with the
 * mock) and the eye's half of gate 6 stay with 由谷: this spec only leaves them
 * the light / dark screenshots `req56-<screen>-<light|dark>.png`, which
 * `scripts/gate-device/req56-gallery.mjs` lays out next to the mock's screens.
 * Gate 7 (print) is `scripts/gate-device/req56-print.sh`.
 *
 * What is judged (one JSON line per judgement in `$VELLIS_GATE_SHOTS/req56-report.jsonl`):
 *  - gate 2   every viewer (Markdown・plain text・HTML・image・PDF・audio・video・STL),
 *             every overlay (ContextMenu・FindBar・GoToBar・Find in Folder・the
 *             update toast), EmptyState and the StatusBar: no computed colour
 *             (color / background / border / outline / fill / stroke / shadow)
 *             equals a colour of the OLD palette — the literals that lived in
 *             `src/components/*.svelte` and `src/styles/*.css` before stage 1
 *             (`git show d5e8a70^:…`, fixed in OLD_PALETTE below), minus the
 *             ones the new tokens reuse. Light and dark. Shiki spans, the
 *             iframe, canvases and videos are out of scope (契約 2: documents
 *             do not follow the theme).
 *  - gate 3   paragraphs stop at `--doc-measure` (72ch, measured in that font's
 *             `ch`); table / code / image reach further; Zoom In widens the
 *             paragraph (ch follows the font); View ▸ Toggle Full Width puts
 *             `data-doc-measure="full"` on <html> and the paragraph spans the
 *             body; plain text (.txt) does the same. The restart half runs as
 *             `VELLIS_GATE_VARIANT=restart` in a second app on the same home.
 *  - gate 4   `~/.config/vellis/themes/forest.json` (theme-architecture §4.3)
 *             is listed in View ▸ Appearance (read by AX through the operator),
 *             chosen through `settings.json` (other keys keep their order),
 *             the computed tokens become forest's, a save is applied at once
 *             (`theme_changed`), a broken value falls back for that token
 *             only with ONE dialog, unreadable JSON / a missing file fall back
 *             whole; Light / Dark / System flip `data-theme` and the computed
 *             values, System follows the OS appearance (operator), Shiki's
 *             colours flip, the HTML iframe keeps its white paper; Export
 *             Default Theme… writes `my-theme.json`, then `my-theme-2.json`,
 *             and still works after the list was rebuilt (reviewer P2-2); the
 *             audio waveform is redrawn in the new colours (reviewer P2-1).
 *  - gate 5   the Explorer header and the StatusBar keep their place and size
 *             across Command + T (a real key), fullscreen in / out (a real key)
 *             and File ▸ New Window (AX; the new window's chrome is compared
 *             by screenshot). All through the operator.
 *  - gate 6   30 real Tab presses: every stop that is not <body> matches
 *             `:focus-visible` and carries a 2px solid outline in
 *             `--color-focus-ring`; the hover rules of Explorer / Recent Files /
 *             Find in Folder hits declare `var(--color-bg-hover)` and the
 *             selected rows compute to `--color-accent-soft` (the context menu's
 *             hover is `--color-accent`, 事後確認 6); every `svg.ui-icon` has the
 *             one viewBox and draws square at its declared size.
 *  - gate 8   起案時判断 req-56 (a)〜(r) and theme-architecture (a)〜(s): each
 *             either judged here (`judged-by`) or already fixed by vitest /
 *             cargo (`covered-by`), one report line each.
 *
 * The operator: steps the page cannot take (reading or pressing a native
 * submenu, the OS appearance, Command + T, fullscreen, New Window, counting
 * and capturing windows, dismissing the native warning dialog — which the
 * unbundled gate build shows through the system's UserNotificationCenter,
 * another process, so the driver looks there as well as at the app) are asked of
 * `scripts/gate-device/req56-gate.sh` through files: this spec writes
 * `<SHOTS_DIR>/req56-op/req-<n>.json` and waits for `ack-<n>.json`. Without
 * that driver (`VELLIS_GATE_REQ56_OPERATOR` unset) those judgements are
 * skipped and reported as such.
 *
 * Runs only under `scripts/gate-device/run-gate-spec.sh req56 main|restart`
 * (VELLIS_GATE_DEVICE=1), with VELLIS_GATE_REALINPUT built and trusted.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const VARIANT = process.env.VELLIS_GATE_VARIANT ?? 'main';
const OPERATOR = process.env.VELLIS_GATE_REQ56_OPERATOR === '1';
const KEEP_STATE = process.env.VELLIS_GATE_REQ56_KEEP_STATE === '1';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const realinput = process.env.VELLIS_GATE_REALINPUT ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';
const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? '';
const REPORT = 'req56-report.jsonl';
/** One request folder per phase (the driver watches `req56-op-main`, then `req56-op-restart`). */
const OP_DIR = path.join(SHOTS_DIR, `req56-op-${VARIANT}`);

const configDir = path.join(xdgConfigHome, 'vellis');
const themesDir = path.join(configDir, 'themes');
const settingsPath = path.join(configDir, 'settings.json');

const uri = (p: string) => `file://${p}`;
const file = (name: string) => path.join(root, name);

/** The fixtures `scripts/gate-device/req56-fixtures.sh` writes into the root. */
const FIX = {
	md: 'sample.md',
	txt: 'notes.txt',
	html: 'page.html',
	png: 'wide.png',
	pdf: 'one.pdf',
	wav: 'tone.wav',
	mp4: 'clip.mp4',
	stl: 'cube.stl',
	ts: 'code.ts',
} as const;

/** macOS virtual keycodes (US ANSI). */
const KEY = { tab: 48, t: 17, f: 3, return: 36 } as const;

const BODY = 'article.viewer .markdown-body';
const PARA = `${BODY} > p`;

/**
 * The OLD palette: every colour literal in the `<style>` of `src/components/*.svelte`
 * (and the FIND_SURFACE_CSS strings) and in `src/styles/{app,markdown,theme}.css`
 * at `d5e8a70^` (main before stage 1 = v0.5.5 + 2026-11-02 docs), extracted
 * 2026-11-03 with a script over `git show d5e8a70^:<file>` (`#620`, which that
 * script also picked up, was the text "Issue #620" in a VideoViewer comment,
 * not a colour, and is left out). Fixed here so the judgement does not move
 * with the tree. The ones a NEW token reuses (white,
 * the find colours, `#1f2328` = `--color-find-current-text`, `#8250df` =
 * `--color-emphasis`, `rgba(0,0,0,.4)` inside the dark `--shadow-1`) are taken
 * out at runtime against themes/default.json, so what is left is the part of
 * the old look that must be gone.
 */
const OLD_PALETTE = [
	'#0000ee', '#0969da', '#111827', '#166534', '#1a7f37', '#1d4ed8', '#1e40af', '#1f2328', '#1f2937',
	'#24292e', '#24292f', '#2563eb', '#374151', '#656d76', '#6b7280', '#78350f', '#7f1d1d',
	'#8250df', '#8b949e', '#92400e', '#93c5fd', '#991b1b', '#9a3412', '#9a6700', '#a0a8b0', '#b45309',
	'#b91c1c', '#c0c8d0', '#cf222e', '#d0d7de', '#d0e0f0', '#d1d5db', '#dbeafe', '#dcfce7', '#e5e7eb',
	'#e8e8e8', '#eaeef2', '#ef4444', '#eff1f3', '#f3f4f6', '#f6f8fa', '#f9fafb', '#fafafa', '#fb923c',
	'#fca5a5', '#fcd34d', '#fde047', '#fecaca', '#fed7aa', '#fee2e2', '#fef08a', '#fef2f2', '#fef3c7',
	'#ffffff', 'rgba(0,0,0,0.18)', 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0.25)', 'rgba(0,0,0,0.4)', 'rgba(0,0,0,0.5)',
];

interface DefaultTheme {
	version: number;
	code: { light: string; dark: string };
	common: Record<string, string>;
	light: Record<string, string>;
	dark: Record<string, string>;
}

const defaultTheme = JSON.parse(fs.readFileSync(path.join(repoRoot, 'themes', 'default.json'), 'utf8')) as DefaultTheme;

/** Default's value of a token in a mode (common, then the mode's block). */
function defaultToken(name: string, mode: 'light' | 'dark'): string {
	return defaultTheme[mode][name] ?? defaultTheme.common[name] ?? '';
}

/** Colour keys every token value of Default carries (light and dark, shadows included). */
function newTokenColorKeys(): Set<string> {
	const keys = new Set<string>();
	for (const block of [defaultTheme.common, defaultTheme.light, defaultTheme.dark]) {
		for (const v of Object.values(block)) for (const k of colorsIn(v)) keys.add(k);
	}
	return keys;
}

const FOREST = {
	version: 1,
	meta: { name: 'Forest', description: 'アクセントを緑に、本文を少し大きく' },
	code: { dark: 'vitesse-dark' },
	common: { 'doc-size': '17px' },
	light: { 'color-accent': '#1f7a4d', 'color-accent-text': '#176a42', 'color-focus-ring': '#1f7a4d' },
	dark: { 'color-accent': '#3fae78', 'color-accent-text': '#6fd9a3', 'color-focus-ring': '#6fd9a3' },
};

// --- the tools (pid-pinned child processes, as req48qr) --------------------------

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
const ri = (args: string[]) => tool(realinput, args);

function appPid(): number {
	const pids = ax(['pids-of-exe', bin]).map((r) => r.pid as number);
	if (pids.length !== 1) throw new Error(`expected one app process of ${bin}, found ${JSON.stringify(pids)}`);
	return pids[0]!;
}

interface FrontInfo {
	ok: boolean;
	frontmost: boolean;
	focused_window: { title: string } | null;
}

async function ensureFront(pid: number): Promise<FrontInfo> {
	let f = ri(['front', String(pid)])[0] as unknown as FrontInfo;
	if (!f.ok) {
		ax(['raise', String(pid), '0']);
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			await browser.pause(200);
			f = ri(['front', String(pid)])[0] as unknown as FrontInfo;
			if (f.ok) break;
		}
	}
	if (!f.ok) throw new Error(`the app is not frontmost with a focused window: ${JSON.stringify(f)}`);
	return f;
}

// --- the operator (scripts/gate-device/req56-gate.sh) ----------------------------

let opSeq = 0;

/**
 * Ask the shell driver for a step the page cannot take. Returns its answer, or
 * null when no driver is attached (the caller reports and skips).
 */
async function operator(
	step: string,
	args: Record<string, unknown> = {},
	timeoutMs = 90_000,
): Promise<Record<string, unknown> | null> {
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
				report(REPORT, { gate: 'operator', step, args, answer });
				return answer;
			}
		}
		await browser.pause(300);
	}
	throw new Error(`operator step ${step} (#${seq}) was not answered within ${timeoutMs} ms`);
}

// --- page helpers ----------------------------------------------------------------

async function exists(selector: string): Promise<boolean> {
	return browser.execute((s) => document.querySelector(s) !== null, selector);
}

async function waitFor(selector: string, what: string, timeout = 20_000): Promise<void> {
	await browser.waitUntil(async () => exists(selector), { timeout, timeoutMsg: `${what}: ${selector} never appeared` });
}

async function waitGone(selector: string, what: string, timeout = 10_000): Promise<void> {
	await browser.waitUntil(async () => !(await exists(selector)), { timeout, timeoutMsg: `${what}: ${selector} is still there` });
}

async function rootAttr(name: string): Promise<string | null> {
	return browser.execute((n) => document.documentElement.getAttribute(n), name);
}

/** The computed value of a token on <html> (the raw text, as the cascade left it). */
async function token(name: string): Promise<string> {
	return browser.execute((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
}

async function setMode(mode: 'light' | 'dark' | 'system'): Promise<void> {
	await emitMenu(`menu_appearance_${mode}`);
	await browser.waitUntil(async () => (await rootAttr('data-theme')) === (mode === 'system' ? null : mode), {
		timeout: 5_000,
		timeoutMsg: `data-theme did not become ${mode}`,
	});
	// A mode change is a cascade change: one frame is enough for computed values.
	await browser.pause(150);
}

async function effectiveMode(): Promise<'light' | 'dark'> {
	return browser.execute(() => {
		const a = document.documentElement.getAttribute('data-theme');
		if (a === 'light' || a === 'dark') return a;
		return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	});
}

async function openDoc(name: string, waitSelector: string): Promise<void> {
	await clickExplorerRow(uri(file(name)));
	await waitFor(waitSelector, `open ${name}`);
}

async function closeBar(closeSelector: string, barSelector: string): Promise<void> {
	await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.click(), closeSelector);
	await waitGone(barSelector, `close ${barSelector}`);
}

async function readSettings(): Promise<string> {
	return fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '';
}

function writeSettings(text: string): void {
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(settingsPath, text);
}

function writeTheme(name: string, text: string): void {
	fs.mkdirSync(themesDir, { recursive: true });
	fs.writeFileSync(path.join(themesDir, `${name}.json`), text);
}

/** Wait for the next `theme_changed` (debounce 150 ms + resolve) and return its payload. */
async function waitThemeChanged(what: string, timeout = 8_000): Promise<Record<string, unknown>> {
	const box: { seen: Record<string, unknown> | null } = { seen: null };
	await browser.waitUntil(
		async () => {
			const events = await readEventRecord();
			const e = events.find((x) => x.event === 'theme_changed');
			if (e) box.seen = e.payload as Record<string, unknown>;
			return box.seen !== null;
		},
		{ timeout, timeoutMsg: `${what}: no theme_changed arrived` },
	);
	await clearEventRecord();
	if (box.seen === null) throw new Error(`${what}: no theme_changed arrived`);
	return box.seen;
}

/** Lines of the app log (RUST_LOG=info; `tracing::warn!` lines are the theme warnings). */
function appLogLines(): string[] {
	const log = path.join(SHOTS_DIR, `req56-${VARIANT}-app.log`);
	return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : [];
}

interface DialogCount {
	/** Dialogs the operator dismissed (null without the operator). */
	dialogs: number | null;
	/** Of those, the ones whose texts carried `expectText` (null without the operator). */
	matched: number | null;
	/** Where each one was shown (sheet / app-window / unc = the system's UserNotificationCenter). */
	where: unknown[];
	warnLines: string[];
}

/**
 * The native warning dialog (tauri-plugin-dialog, from Rust): the page cannot
 * see it. The operator looks for it where it can be — a sheet or dialog
 * window of the app, or a window of the system's UserNotificationCenter (an
 * unbundled binary's message() is shown there, by another process: the
 * 2026-11-03 run counted 0 while 23 were on the screen) — records the texts,
 * dismisses it with a real Return and gives the app the front back. Without
 * the operator the app log's warn lines since `logMark` stand in (the dialog
 * then stays on the screen for 由谷 to close).
 */
async function dialogsSince(logMark: number, expectText: string): Promise<DialogCount> {
	const answer = await operator('dialog', { expect: expectText, wait_s: 6 });
	if (!answer) await browser.pause(1_500);
	const warnLines = appLogLines().slice(logMark).filter((l) => /WARN/.test(l) && /theme|Theme/.test(l));
	const dialogs = answer ? (answer.dialogs as number) : null;
	const matched = answer && typeof answer.matched === 'number' ? (answer.matched as number) : null;
	const where = answer && Array.isArray(answer.where) ? (answer.where as unknown[]) : [];
	return { dialogs, matched, where, warnLines };
}

/** Exactly one dialog, and it said what was expected (true without the operator: not judged). */
function oneDialog(d: DialogCount): boolean {
	if (d.dialogs === null) return true;
	return d.dialogs === 1 && (d.matched === null || d.matched === 1);
}

interface ColorHit {
	path: string;
	prop: string;
	value: string;
}

interface ColorScan {
	elements: number;
	distinct: string[];
	hits: ColorHit[];
}

/**
 * Every computed colour of every element (minus the exclusions), compared in
 * the page against the forbidden keys. Returns the hits and the distinct keys.
 */
async function scanColors(forbidden: string[]): Promise<ColorScan> {
	return browser.execute((bad: string[]) => {
		// Shiki's `<pre class="shiki …" style="background-color:…;color:…">` (and
		// the code-file `<pre data-vellis-lang>`) carry the github theme's colours
		// inline (#24292e …): a document's colours, not the UI's (契約 2).
		const EXCLUDE =
			'.markdown-body pre span, .markdown-body code span, pre.shiki, pre[data-vellis-lang], .markdown-body pre[style], iframe, canvas, video, audio, .mermaid, svg symbol';
		const PROPS = [
			'color',
			'background-color',
			'border-top-color',
			'border-right-color',
			'border-bottom-color',
			'border-left-color',
			'outline-color',
			'fill',
			'stroke',
			'box-shadow',
			'text-decoration-color',
			'caret-color',
		];
		const key = (css: string): string | null => {
			const m = /^rgba?\(([^)]+)\)$/.exec(css.trim());
			if (!m) return null;
			const p = (m[1] ?? '').split(/[,\s/]+/).filter(Boolean).map(Number);
			if (p.length < 3) return null;
			const a = p.length >= 4 ? p[3]! : 1;
			return `${Math.round(p[0]!)},${Math.round(p[1]!)},${Math.round(p[2]!)},${Math.round(a * 1000) / 1000}`;
		};
		const keysIn = (v: string): string[] => {
			const out: string[] = [];
			for (const m of v.matchAll(/rgba?\([^)]*\)/g)) {
				const k = key(m[0]);
				if (k) out.push(k);
			}
			return out;
		};
		const describe = (el: Element): string => {
			const parts: string[] = [];
			let e: Element | null = el;
			while (e && parts.length < 5 && e !== document.body) {
				const id = e.getAttribute('data-testid');
				const cls = (e.getAttribute('class') ?? '')
					.split(/\s+/)
					.filter((c) => c && !c.startsWith('svelte-'))
					.slice(0, 2)
					.join('.');
				parts.unshift(`${e.tagName.toLowerCase()}${id ? `[${id}]` : ''}${cls ? `.${cls}` : ''}`);
				e = e.parentElement;
			}
			return parts.join('>');
		};
		const badSet = new Set(bad);
		const distinct = new Set<string>();
		const hits: { path: string; prop: string; value: string }[] = [];
		let elements = 0;
		for (const el of Array.from(document.querySelectorAll('*'))) {
			if (el.closest(EXCLUDE)) continue;
			elements++;
			const cs = getComputedStyle(el);
			for (const prop of PROPS) {
				const v = cs.getPropertyValue(prop);
				if (!v || v === 'none') continue;
				for (const k of keysIn(v)) {
					distinct.add(k);
					if (badSet.has(k) && hits.length < 200) hits.push({ path: describe(el), prop, value: v });
				}
			}
		}
		return { elements, distinct: Array.from(distinct).sort(), hits };
	}, forbidden);
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

/** Width of one `ch` in the font of the first element matching `selector`. */
async function chWidth(selector: string): Promise<number> {
	return browser.execute((s) => {
		const el = document.querySelector(s) as HTMLElement | null;
		if (!el) return 0;
		const probe = document.createElement('span');
		probe.textContent = '0';
		probe.style.position = 'absolute';
		probe.style.visibility = 'hidden';
		probe.style.whiteSpace = 'pre';
		el.appendChild(probe);
		const w = probe.getBoundingClientRect().width;
		probe.remove();
		return w;
	}, selector);
}

/** Content box width (clientWidth minus horizontal padding) of the first match. */
async function contentWidth(selector: string): Promise<number> {
	return browser.execute((s) => {
		const el = document.querySelector(s) as HTMLElement | null;
		if (!el) return 0;
		const cs = getComputedStyle(el);
		return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
	}, selector);
}

interface WaveformSample {
	drawn: number;
	dominant: string | null;
	hash: string;
}

/** The waveform canvas: how many opaque pixels, their dominant colour key, a hash of the bitmap. */
async function sampleWaveform(): Promise<WaveformSample | null> {
	return browser.execute(() => {
		const c = document.querySelector('.audio-viewer canvas.waveform-canvas') as HTMLCanvasElement | null;
		if (!c || c.width === 0 || c.height === 0) return null;
		const ctx = c.getContext('2d');
		if (!ctx) return null;
		const d = ctx.getImageData(0, 0, c.width, c.height).data;
		const counts = new Map<string, number>();
		let drawn = 0;
		let hash = 0;
		for (let i = 0; i < d.length; i += 4) {
			const a = d[i + 3]!;
			hash = (hash * 31 + d[i]! + d[i + 1]! * 7 + d[i + 2]! * 13 + a * 17) >>> 0;
			if (a === 0) continue;
			drawn++;
			const k = `${d[i]},${d[i + 1]},${d[i + 2]},${Math.round((a / 255) * 1000) / 1000}`;
			counts.set(k, (counts.get(k) ?? 0) + 1);
		}
		let dominant: string | null = null;
		let best = 0;
		for (const [k, n] of counts) if (n > best) (best = n), (dominant = k);
		return { drawn, dominant, hash: hash.toString(16) };
	});
}

interface ChromeMeasure {
	innerWidth: number;
	innerHeight: number;
	header: Rect | null;
	status: Rect | null;
	app: Rect | null;
}

async function measureChrome(): Promise<ChromeMeasure> {
	return {
		innerWidth: await browser.execute(() => window.innerWidth),
		innerHeight: await browser.execute(() => window.innerHeight),
		header: await rectOf('aside.explorer .explorer-header'),
		status: await rectOf('footer.status-bar'),
		app: await rectOf('.app'),
	};
}

/**
 * The chrome is in place: header at the top edge, status bar on the bottom
 * edge, both their height. With `webAreaShrunkBy`, the web area must also be
 * that much shorter than the baseline — a tab bar that overlays the web area
 * instead of pushing it down (the 2026-11-02 spike) leaves innerHeight as it
 * was while hiding the top of the Explorer header (reviewer P2-1).
 */
function chromeInPlace(m: ChromeMeasure, base: ChromeMeasure, webAreaShrunkBy = 0): { ok: boolean; why: string[] } {
	const why: string[] = [];
	if (!m.header || !m.status) why.push('header or status bar missing');
	else {
		if (Math.abs(m.header.y) > 1) why.push(`header top ${m.header.y}`);
		if (Math.abs(m.header.height - (base.header?.height ?? 0)) > 1) why.push(`header height ${m.header.height}`);
		if (Math.abs(m.status.y + m.status.height - m.innerHeight) > 1) why.push(`status bar bottom ${m.status.y + m.status.height} vs innerHeight ${m.innerHeight}`);
		if (Math.abs(m.status.height - (base.status?.height ?? 0)) > 1) why.push(`status bar height ${m.status.height}`);
		if (m.header.width < 100) why.push(`header width ${m.header.width}`);
		if (webAreaShrunkBy > 0 && m.innerHeight > base.innerHeight - webAreaShrunkBy) {
			why.push(`web area not pushed down: innerHeight ${m.innerHeight} vs baseline ${base.innerHeight} (expected ≤ ${base.innerHeight - webAreaShrunkBy})`);
		}
	}
	return { ok: why.length === 0, why };
}

/**
 * A living window's CG frame as the driver reports it (`windows` / `new-tab` /
 * `close-extra-windows`): one per visible AX window (`index` = its AX index),
 * plus the baseline with `hidden: true` while it is a background tab. A closed
 * window's stale CG entry is never in here (the driver counts the living
 * windows from the Window menu, not from CG — tasks/lessons.md 2026-11-04).
 */
interface WindowFrame {
	number: number;
	x: number;
	y: number;
	w: number;
	h: number;
	index?: number | null;
	hidden?: boolean;
}

/** Every `svg.ui-icon` on the page: viewBox, declared and drawn size, the symbol it uses. */
async function collectIcons(): Promise<{ viewBox: string | null; attr: number; w: number; h: number; use: string | null; visible: boolean }[]> {
	return browser.execute(() =>
		Array.from(document.querySelectorAll<SVGSVGElement>('svg.ui-icon')).map((svg) => {
			const r = svg.getBoundingClientRect();
			return {
				viewBox: svg.getAttribute('viewBox'),
				attr: Number(svg.getAttribute('width')),
				w: Math.round(r.width * 100) / 100,
				h: Math.round(r.height * 100) / 100,
				use: svg.querySelector('use')?.getAttribute('href') ?? null,
				visible: r.width > 0,
			};
		}),
	);
}

/** The focused element after a Tab: what it is and how its ring computes (`tag: 'body'` when nothing has focus). */
async function focusedStop(): Promise<Record<string, unknown>> {
	return browser.execute(() => {
		const el = document.activeElement as HTMLElement | null;
		if (!el || el === document.body || el === document.documentElement) return { tag: 'body' };
		const cs = getComputedStyle(el);
		return {
			tag: el.tagName.toLowerCase(),
			testid: el.getAttribute('data-testid'),
			cls: (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => c && !c.startsWith('svelte-')).join('.'),
			inContextMenu: el.closest('.context-menu') !== null,
			focusVisible: el.matches(':focus-visible'),
			outlineStyle: cs.outlineStyle,
			outlineWidth: cs.outlineWidth,
			outlineColor: cs.outlineColor,
			boxShadow: cs.boxShadow,
		};
	});
}

/** A stop carries the ring: :focus-visible, 2px solid outline in the focus-ring token of the mode. */
function hasRing(s: Record<string, unknown>, ring: string | null): boolean {
	return s.focusVisible === true && s.outlineStyle === 'solid' && s.outlineWidth === '2px' && colorKey(String(s.outlineColor)) === ring;
}

// --- the gates ---------------------------------------------------------------------

describe('Requirement #56 stage 2 human gates, the machine part (gates 2〜6, 8)', function () {
	this.timeout(900_000);

	let forbidden: string[] = [];
	let excludedFromOld: string[] = [];
	let pid = 0;

	before(async function () {
		if (!DEVICE || VARIANT !== 'main') this.skip();
		for (const [name, value] of Object.entries({
			VELLIS_GATE_BIN: bin,
			VELLIS_GATE_AXTOOL: axtool,
			VELLIS_GATE_REALINPUT: realinput,
			VELLIS_E2E_INITIAL_ROOT: root,
			XDG_CONFIG_HOME: xdgConfigHome,
		})) {
			if (!value) throw new Error(`${name} is not set`);
		}
		for (const f of Object.values(FIX)) {
			if (!fs.existsSync(file(f))) throw new Error(`fixture ${f} is missing in ${root} (req56-fixtures.sh)`);
		}
		fs.mkdirSync(SHOTS_DIR, { recursive: true });
		fs.rmSync(OP_DIR, { recursive: true, force: true });
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await installEventRecorder(['theme_changed']);
		await assertEventRecorderWorks();
		await installEventRecorder(['theme_changed']);
		pid = appPid();
		const newKeys = newTokenColorKeys();
		const all = OLD_PALETTE.map((c) => ({ css: c, key: colorKey(c) }));
		forbidden = all.filter((c) => c.key !== null && !newKeys.has(c.key)).map((c) => c.key!);
		excludedFromOld = all.filter((c) => c.key !== null && newKeys.has(c.key)).map((c) => c.css);
		report(REPORT, {
			gate: 'setup',
			variant: VARIANT,
			operator: OPERATOR,
			keep_state: KEEP_STATE,
			pid,
			old_palette: OLD_PALETTE.length,
			forbidden: forbidden.length,
			reused_by_new_tokens: excludedFromOld,
			root,
			config_dir: configDir,
		});
		// A known starting point: Light (so the scans do not depend on the OS appearance), 72ch, Default theme.
		await emitMenu('menu_appearance_light');
		await browser.pause(200);
		if ((await rootAttr('data-doc-measure')) === 'full') await emitMenu('menu_toggle_full_width');
		await waitForExplorerRow(uri(file(FIX.md)), { timeout: 30_000, nudgeDir: root, nudgePrefix: 'req56' });
	});

	/**
	 * Every gate starts from the same screen: no overlay left open by a failed
	 * one (the Find in Folder panel replaces the Explorer and the Recent Files
	 * section, so a panel left open empties the Explorer for every later gate —
	 * the 2026-11-03 run), and the Explorer listing the root. When the Explorer
	 * is still empty, what the window shows, settings.json and the app log's
	 * tail go into the report, so the cause can be read.
	 */
	async function resetScreen(when: string): Promise<void> {
		const closed = await browser.execute(() => {
			const click = (s: string) => {
				const el = document.querySelector(s) as HTMLElement | null;
				if (el) el.click();
				return el !== null;
			};
			const out: string[] = [];
			if (click('[data-testid="find-in-folder-close"]')) out.push('find-in-folder');
			if (click('[data-testid="find-close"]')) out.push('find-bar');
			if (click('[data-testid="go-to-close"]')) out.push('go-to-bar');
			if (click('.update-banner .update-close')) out.push('update-banner');
			if (document.querySelector('.context-menu')) {
				document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
				document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
				out.push('context-menu');
			}
			return out;
		});
		if (closed.length > 0) report(REPORT, { gate: 'reset', when, closed });
		try {
			await waitForExplorerRow(uri(file(FIX.md)), { timeout: 15_000, nudgeDir: root, nudgePrefix: 'req56-reset' });
		} catch (e) {
			const screen = await browser.execute(() => ({
				explorer_items: document.querySelectorAll('.explorer-item').length,
				explorer: document.querySelector('aside.explorer') !== null,
				find_in_folder: document.querySelector('[data-testid="find-in-folder"]') !== null,
				root_picker: document.querySelector('.root-picker') !== null,
				empty_state: document.querySelector('.empty-state') !== null,
				recent_files: document.querySelector('[data-testid="recent-files"]') !== null,
				title: document.title,
				body_classes: document.body.className,
				left_pane: (document.querySelector('.app-body')?.firstElementChild as HTMLElement | null)?.className ?? null,
			}));
			report(REPORT, {
				gate: 'diagnostic',
				when,
				error: String(e),
				screen,
				settings_json: fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null,
				app_log_tail: appLogLines().slice(-20),
			});
			throw e;
		}
	}

	beforeEach(async function () {
		if (!DEVICE || VARIANT !== 'main') return;
		await resetScreen(`before: ${this.currentTest?.title ?? '?'}`);
	});

	afterEach(async function () {
		if (!DEVICE || VARIANT !== 'main') return;
		if (this.currentTest?.state === 'failed') {
			report(REPORT, { gate: 'failed', test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
		}
		await resetScreen(`after: ${this.currentTest?.title ?? '?'}`).catch(() => undefined);
	});

	after(async function () {
		if (!DEVICE || VARIANT !== 'main') return;
		try {
			const rec = await readGateRecord();
			report(REPORT, { gate: 'teardown', page_dialogs: rec.dialogs, keep_state: KEEP_STATE });
			if (!KEEP_STATE) {
				await emitMenu('menu_appearance_system');
				if ((await rootAttr('data-doc-measure')) === 'full') await emitMenu('menu_toggle_full_width');
				if (fs.existsSync(settingsPath)) {
					const text = await readSettings();
					writeSettings(text.replace(/"appearance\.theme"\s*:\s*"[^"]*"/, '"appearance.theme": "default"'));
				}
			}
			await removeEventRecorder();
			await restoreGateRecorder();
		} finally {
			await operator('done', {}, 10_000).catch(() => null);
		}
	});

	// ---------------------------------------------------------------- gate 2

	it('gate 2: no colour of the old palette is computed anywhere — every viewer, every overlay, EmptyState, StatusBar; light and dark', async () => {
		expect(forbidden.length).toBeGreaterThan(40);
		const scenes: { name: string; mock: string; open: () => Promise<void>; close?: () => Promise<void>; shot?: string }[] = [
			{
				name: 'emptystate',
				mock: 'none (RootPicker / EmptyState: tokens and sizes only)',
				open: async () => {
					await waitFor('.empty-state', 'EmptyState');
				},
				shot: 'emptystate',
			},
			{
				name: 'markdown',
				mock: 's2',
				open: async () => {
					await openDoc(FIX.md, PARA);
					await waitFor(`${BODY} pre code span`, 'Shiki spans');
				},
				shot: 's2-explorer-markdown',
			},
			{ name: 'plaintext', mock: 's2', open: async () => openDoc(FIX.txt, `${BODY} pre.vellis-plaintext`) },
			{ name: 'code', mock: 's2', open: async () => openDoc(FIX.ts, `${BODY} pre.vellis-plaintext[data-vellis-lang]`) },
			{ name: 'html', mock: 's2', open: async () => openDoc(FIX.html, 'iframe.html-viewer') },
			{ name: 'image', mock: 's6', open: async () => openDoc(FIX.png, '.image-viewer img.image') },
			{ name: 'pdf', mock: 's6', open: async () => openDoc(FIX.pdf, '.pdf-viewer') },
			{
				name: 'audio',
				mock: 's6',
				open: async () => {
					await openDoc(FIX.wav, '.audio-viewer canvas.waveform-canvas');
					await browser.waitUntil(async () => ((await sampleWaveform())?.drawn ?? 0) > 0, {
						timeout: 20_000,
						timeoutMsg: 'the waveform was never drawn',
					});
				},
				shot: 's6-audio',
			},
			{ name: 'video', mock: 's6', open: async () => openDoc(FIX.mp4, '.video-viewer'), shot: 's6-video' },
			{ name: 'model', mock: 's6', open: async () => openDoc(FIX.stl, '.model-viewer') },
			{
				name: 'findbar',
				mock: 's5 (ファイル内検索)',
				open: async () => {
					await openDoc(FIX.md, PARA);
					await emitMenu('menu_find');
					await waitFor('[data-testid="find-bar"]', 'FindBar');
					await browser.execute(() => {
						const input = document.querySelector<HTMLInputElement>('[data-testid="find-input"]')!;
						input.value = 'paragraph';
						input.dispatchEvent(new Event('input', { bubbles: true }));
					});
					await browser.pause(500);
				},
				close: async () => closeBar('[data-testid="find-close"]', '[data-testid="find-bar"]'),
				shot: 'findbar',
			},
			{
				name: 'gotobar',
				mock: 'none (GoToBar: tokens and sizes only)',
				open: async () => {
					await emitMenu('menu_go_to');
					await waitFor('[data-testid="go-to-bar"]', 'GoToBar');
				},
				close: async () => closeBar('[data-testid="go-to-close"]', '[data-testid="go-to-bar"]'),
				shot: 'gotobar',
			},
			{
				name: 'findinfolder',
				mock: 's5',
				open: async () => {
					await emitMenu('menu_find_in_folder');
					await waitFor('[data-testid="find-in-folder-input"]', 'Find in Folder');
					await browser.execute(() => {
						const input = document.querySelector<HTMLInputElement>('[data-testid="find-in-folder-input"]')!;
						input.value = 'paragraph';
						input.dispatchEvent(new Event('input', { bubbles: true }));
					});
					await waitFor('[data-testid="find-in-folder-hit"]', 'Find in Folder hits', 30_000);
				},
				close: async () => closeBar('[data-testid="find-in-folder-close"]', '[data-testid="find-in-folder"]'),
				shot: 's5-find-in-folder',
			},
			{
				name: 'contextmenu',
				mock: 's6 (右クリックメニュー)',
				open: async () => {
					await browser.execute((u) => {
						const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find((r) => r.title === u)!;
						const r = row.getBoundingClientRect();
						row.dispatchEvent(
							new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.x + 20, clientY: r.y + r.height / 2 }),
						);
					}, uri(file(FIX.md)));
					await waitFor('.context-menu', 'ContextMenu', 5_000);
				},
				close: async () => {
					await browser.execute(() => {
						document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
						document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
						document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
					});
					await waitGone('.context-menu', 'ContextMenu').catch(() => undefined);
				},
				shot: 's6-context-menu',
			},
			{
				name: 'updatebanner',
				mock: 's7 (トースト)',
				open: async () => {
					await emitEvent('update_available', { version: '99.0.0', url: 'https://example.invalid/vellis' });
					await waitFor('.update-banner', 'UpdateBanner', 5_000);
				},
				close: async () => closeBar('.update-banner .update-close', '.update-banner'),
				shot: 's7-toast',
			},
		];
		const skipped: string[] = [
			'rootpicker: not reachable from a window that has a root (needs_root_selection is decided at startup) — left to the eye',
			'marklist / provenancepanel / diffview / instructiondialog: the AI screens are not shown in the release build (機能リスト「しない」) — tokens are fixed by design-tokens-stage2.acceptance.test.ts',
		];
		let total = 0;
		for (const scene of scenes) {
			await scene.open();
			for (const mode of ['light', 'dark'] as const) {
				await setMode(mode);
				await browser.pause(250);
				const scan = await scanColors(forbidden);
				total += scan.hits.length;
				report(REPORT, {
					gate: 2,
					item: 'no old-palette colour',
					scene: scene.name,
					mock: scene.mock,
					mode,
					elements: scan.elements,
					distinct_colours: scan.distinct.length,
					hits: scan.hits.slice(0, 20),
					hit_count: scan.hits.length,
					pass: scan.hits.length === 0,
				});
				if (scene.shot) await shot(`req56-${scene.shot}-${mode}`);
			}
			await setMode('light');
			if (scene.close) await scene.close();
		}
		// The StatusBar alone, enlarged, light and dark (mock: the 24px bar of every screen).
		await openDoc(FIX.md, PARA);
		for (const mode of ['light', 'dark'] as const) {
			await setMode(mode);
			const r = await rectOf('footer.status-bar');
			if (r) await zoomedShot(`req56-statusbar-${mode}`, { x: 0, y: Math.max(0, r.y - 2), width: r.width, height: r.height + 2 }, 2);
		}
		await setMode('light');
		for (const s of skipped) report(REPORT, { gate: 2, item: 'scene skipped', note: s });
		expect(total).toBe(0);
	});

	// ---------------------------------------------------------------- gate 3

	it('gate 3: 72ch measure for prose, wide blocks reach further, zoom follows the font, Toggle Full Width spans the body, plain text too', async () => {
		await openDoc(FIX.md, PARA);
		await waitFor(`${BODY} > table`, 'table');
		await waitFor(`${BODY} > pre`, 'code fence');
		await waitFor(`${BODY} > p > img`, 'image paragraph');
		const measureToken = await token('--doc-measure');
		const ch = await chWidth(PARA);
		const para = (await rectOf(PARA))!;
		const table = (await rectOf(`${BODY} > table`))!;
		const pre = (await rectOf(`${BODY} > pre`))!;
		const imgPara = await browser.execute(() => {
			const p = Array.from(document.querySelectorAll<HTMLElement>('article.viewer .markdown-body > p')).find(
				(x) => x.children.length === 1 && x.firstElementChild?.tagName === 'IMG',
			);
			if (!p) return null;
			const r = p.getBoundingClientRect();
			return { x: r.x, y: r.y, width: r.width, height: r.height };
		});
		const body = await contentWidth(BODY);
		const expected = 72 * ch;
		const measurePass = measureToken === '72ch' && Math.abs(para.width - expected) <= 2 && para.width < body - 4;
		report(REPORT, {
			gate: 3,
			item: 'paragraph stops at --doc-measure',
			token: measureToken,
			ch_px: ch,
			expected_px: expected,
			paragraph_px: para.width,
			body_content_px: body,
			pass: measurePass,
		});
		const widePass = table.width > para.width + 8 && pre.width > para.width + 8 && (imgPara?.width ?? 0) > para.width + 8;
		report(REPORT, {
			gate: 3,
			item: 'table / code / image reach past the measure',
			paragraph_px: para.width,
			table_px: table.width,
			pre_px: pre.width,
			image_paragraph_px: imgPara?.width ?? null,
			pass: widePass,
		});
		// Zoom In: the paragraph grows with the font, and stays 72 of the new ch.
		await pointAtRegion('article.viewer');
		await emitMenu('menu_zoom_in');
		await browser.waitUntil(async () => ((await rectOf(PARA))?.width ?? 0) > para.width + 4, {
			timeout: 5_000,
			timeoutMsg: 'Zoom In did not widen the paragraph',
		});
		const zoomedPara = (await rectOf(PARA))!;
		const zoomedCh = await chWidth(PARA);
		// Zoom Out: back to the starting width (the measure follows the font both ways).
		await emitMenu('menu_zoom_out');
		await browser.waitUntil(async () => Math.abs(((await rectOf(PARA))?.width ?? 0) - para.width) <= 2, {
			timeout: 5_000,
			timeoutMsg: 'Zoom Out did not bring the paragraph back',
		}).catch(() => undefined);
		const outPara = (await rectOf(PARA))!;
		const outCh = await chWidth(PARA);
		// Zoom Out once more: narrower than the start, still 72 of the smaller ch.
		await emitMenu('menu_zoom_out');
		await browser.waitUntil(async () => ((await rectOf(PARA))?.width ?? 0) < para.width - 4, {
			timeout: 5_000,
			timeoutMsg: 'a second Zoom Out did not narrow the paragraph',
		}).catch(() => undefined);
		const smallPara = (await rectOf(PARA))!;
		const smallCh = await chWidth(PARA);
		const zoomPass =
			zoomedPara.width > para.width + 4 &&
			Math.abs(zoomedPara.width - 72 * zoomedCh) <= 3 &&
			Math.abs(outPara.width - para.width) <= 2 &&
			smallPara.width < para.width - 4 &&
			Math.abs(smallPara.width - 72 * smallCh) <= 3;
		report(REPORT, {
			gate: 3,
			item: 'Zoom In widens and Zoom Out narrows the paragraph; it stays 72ch of the font',
			before_px: para.width,
			zoom_in_px: zoomedPara.width,
			ch_zoom_in: zoomedCh,
			zoom_out_px: outPara.width,
			ch_zoom_out: outCh,
			zoom_out_twice_px: smallPara.width,
			ch_zoom_out_twice: smallCh,
			pass: zoomPass,
		});
		await emitMenu('menu_zoom_reset');
		await browser.pause(300);
		// Toggle Full Width.
		await emitMenu('menu_toggle_full_width');
		await browser.waitUntil(async () => (await rootAttr('data-doc-measure')) === 'full', { timeout: 5_000, timeoutMsg: 'data-doc-measure did not become full' });
		await browser.pause(200);
		const fullPara = (await rectOf(PARA))!;
		const fullBody = await contentWidth(BODY);
		const stored = await browser.execute(() => localStorage.getItem('vellis.doc-measure'));
		const fullPass = Math.abs(fullPara.width - fullBody) <= 4 && stored === 'full';
		report(REPORT, {
			gate: 3,
			item: 'Toggle Full Width: paragraph spans the body, choice stored',
			attribute: await rootAttr('data-doc-measure'),
			paragraph_px: fullPara.width,
			body_content_px: fullBody,
			stored,
			pass: fullPass,
		});
		await emitMenu('menu_toggle_full_width');
		await browser.waitUntil(async () => (await rootAttr('data-doc-measure')) === null, { timeout: 5_000, timeoutMsg: 'data-doc-measure did not come off' });
		// Plain text follows the same rule.
		await openDoc(FIX.txt, `${BODY} pre.vellis-plaintext`);
		const PRE = `${BODY} pre.vellis-plaintext`;
		const preCh = await chWidth(PRE);
		const preRect = (await rectOf(PRE))!;
		const preBody = await contentWidth(BODY);
		await emitMenu('menu_toggle_full_width');
		await browser.waitUntil(async () => (await rootAttr('data-doc-measure')) === 'full', { timeout: 5_000, timeoutMsg: 'full width (txt)' });
		await browser.pause(200);
		const preFull = (await rectOf(PRE))!;
		// The body's padding changes with the toggle (the measure is centred by
		// padding-left): the content width is read again after it.
		const preFullBody = await contentWidth(BODY);
		const txtPass = Math.abs(preRect.width - 72 * preCh) <= 2 && preRect.width < preBody - 4 && Math.abs(preFull.width - preFullBody) <= 4;
		report(REPORT, {
			gate: 3,
			item: 'plain text (.txt): 72ch, then full width',
			ch_px: preCh,
			measure_px: preRect.width,
			body_content_px: preBody,
			full_px: preFull.width,
			full_body_content_px: preFullBody,
			pass: txtPass,
		});
		await emitMenu('menu_toggle_full_width');
		await browser.waitUntil(async () => (await rootAttr('data-doc-measure')) === null, { timeout: 5_000, timeoutMsg: 'full width off (txt)' });
		// A code file stays full width regardless (第1段の追加 (3)).
		await openDoc(FIX.ts, `${BODY} pre.vellis-plaintext[data-vellis-lang]`);
		const codeRect = (await rectOf(`${BODY} pre.vellis-plaintext[data-vellis-lang]`))!;
		const codeBody = await contentWidth(BODY);
		report(REPORT, {
			gate: 3,
			item: 'a code file (data-vellis-lang) is full width without the toggle',
			code_px: codeRect.width,
			body_content_px: codeBody,
			pass: Math.abs(codeRect.width - codeBody) <= 4,
		});
		report(REPORT, { gate: 3, item: 'survives a restart', note: 'judged by VELLIS_GATE_VARIANT=restart (req56-gate.sh phase 2)' });
		expect(measurePass && widePass && zoomPass && fullPass && txtPass).toBe(true);
	});

	// ---------------------------------------------------------------- gate 6

	it('gate 6: a focus ring on every real Tab stop, hover and selected rows share the tokens, icons share one viewBox', async () => {
		await openDoc(FIX.md, PARA);
		// The Find in Folder panel REPLACES the Explorer and the Recent Files
		// section (要件#55 契約①・要件#64): the Tab walk is done twice — first over
		// the Explorer + Recent Files + viewer, then with the panel open.
		const recentExpanded = await browser.execute(() => document.querySelector('[data-testid="recent-files-header"]')?.getAttribute('aria-expanded'));
		if (recentExpanded === 'false') {
			await browser.execute(() => (document.querySelector('[data-testid="recent-files-header"]') as HTMLElement | null)?.click());
		}
		await waitFor('[data-testid="recent-files-row"]', 'Recent Files rows');
		const focusRing = { light: colorKey(defaultToken('color-focus-ring', 'light')), dark: colorKey(defaultToken('color-focus-ring', 'dark')) };
		const tabWalk = async (presses: number): Promise<Record<string, unknown>[]> => {
			// Start from the document body so the first Tab lands on the first stop.
			await browser.execute(() => {
				(document.activeElement as HTMLElement | null)?.blur();
				document.body.focus();
			});
			await ensureFront(pid);
			const out: Record<string, unknown>[] = [];
			for (let i = 0; i < presses; i++) {
				ri(['key', String(pid), String(KEY.tab)]);
				await browser.pause(120);
				out.push(await focusedStop());
			}
			return out;
		};
		const treeStops = await tabWalk(30);
		await emitMenu('menu_find_in_folder');
		await waitFor('[data-testid="find-in-folder-input"]', 'Find in Folder');
		await browser.execute(() => {
			const input = document.querySelector<HTMLInputElement>('[data-testid="find-in-folder-input"]')!;
			input.value = 'paragraph';
			input.dispatchEvent(new Event('input', { bubbles: true }));
		});
		await waitFor('[data-testid="find-in-folder-hit"]', 'Find in Folder hits', 30_000);
		const panelStops = await tabWalk(15);
		const stops = [...treeStops, ...panelStops];
		// The ring of the mode in effect (System follows the OS, so it is read, not assumed).
		const ring = focusRing[await effectiveMode()];
		const judged = stops.filter((s) => s.tag !== 'body');
		const bad = judged.filter((s) => !hasRing(s, ring));
		const distinct = new Set(judged.map((s) => `${s.tag}.${s.cls}[${s.testid ?? ''}]`));
		const recentStops = treeStops.filter((s) => String(s.testid ?? '').startsWith('recent-files')).length;
		const focusPass = judged.length >= 8 && distinct.size >= 5 && bad.length === 0 && recentStops >= 1;
		report(REPORT, {
			gate: 6,
			item: 'focus ring on every Tab stop (30 real Tab presses over Explorer + Recent Files + viewer, 15 with Find in Folder open)',
			stops: judged.length,
			distinct_elements: distinct.size,
			recent_files_stops: recentStops,
			ring_token: ring,
			failures: bad,
			sequence: stops.map((s) => `${s.tag}${s.cls ? `.${s.cls}` : ''}`),
			pass: focusPass,
		});
		// The context menu's items too: open it on the document's row, Tab three
		// times. The Find in Folder panel is still open from the second walk and
		// REPLACES the Explorer tree (no `.explorer-item` while it shows — the
		// 2026-11-03 run died on `row.getBoundingClientRect` of undefined): close
		// it first and wait for the row to be back; when it is not, say what the
		// screen shows and fail there.
		await closeBar('[data-testid="find-in-folder-close"]', '[data-testid="find-in-folder"]');
		await waitForExplorerRow(uri(file(FIX.md)), { timeout: 15_000, nudgeDir: root, nudgePrefix: 'req56-gate6' }).catch(() => undefined);
		const rowOpened = await browser.execute((u) => {
			const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find((r) => r.title === u);
			if (!row) {
				return {
					found: false,
					explorer_items: document.querySelectorAll('.explorer-item').length,
					find_in_folder_open: document.querySelector('[data-testid="find-in-folder"]') !== null,
					recent_files: document.querySelector('[data-testid="recent-files"]') !== null,
					left_pane: (document.querySelector('.app-body')?.firstElementChild as HTMLElement | null)?.className ?? null,
				};
			}
			const r = row.getBoundingClientRect();
			row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.x + 20, clientY: r.y + r.height / 2 }));
			return { found: true, explorer_items: document.querySelectorAll('.explorer-item').length };
		}, uri(file(FIX.md)));
		if (!rowOpened.found) {
			report(REPORT, { gate: 6, item: 'focus ring on the context menu items (3 real Tab presses with the menu open)', pass: false, screen: rowOpened, note: 'the Explorer row of sample.md is not on the screen after closing Find in Folder — the menu could not be opened' });
			throw new Error(`gate 6: no Explorer row for ${FIX.md} after closing Find in Folder: ${JSON.stringify(rowOpened)}`);
		}
		await waitFor('.context-menu', 'ContextMenu', 5_000);
		// The menu does not take focus when it opens (a tabindex=-1 container):
		// focus it so the first Tab lands on its first item (reviewer P2-6).
		await browser.execute(() => (document.querySelector('.context-menu') as HTMLElement | null)?.focus());
		await ensureFront(pid);
		const menuStops: Record<string, unknown>[] = [];
		for (let i = 0; i < 3; i++) {
			ri(['key', String(pid), String(KEY.tab)]);
			await browser.pause(120);
			menuStops.push(await focusedStop());
		}
		const menuOpen = await exists('.context-menu');
		const menuJudged = menuStops.filter((s) => s.inContextMenu === true);
		const menuBad = menuJudged.filter((s) => !hasRing(s, ring));
		const menuPass = menuJudged.length >= 1 && menuBad.length === 0;
		report(REPORT, {
			gate: 6,
			item: 'focus ring on the context menu items (3 real Tab presses with the menu open)',
			menu_still_open: menuOpen,
			stops_in_menu: menuJudged.length,
			failures: menuBad,
			sequence: menuStops.map((s) => `${s.tag}${s.cls ? `.${s.cls}` : ''}${s.inContextMenu ? ' (menu)' : ''}`),
			pass: menuPass,
			note: menuJudged.length === 0 ? 'Tab never landed on a .context-menu-item (the menu closed, or keeps focus elsewhere)' : undefined,
		});
		await browser.execute(() => {
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		});
		await waitGone('.context-menu', 'ContextMenu').catch(() => undefined);
		// Hover rules as declared (a synthetic mouseover does not trigger :hover; the
		// declared value is what every component must share).
		const hoverRules = await browser.execute(() => {
			const wanted: Record<string, RegExp> = {
				'explorer-item': /\.explorer-item(\.svelte-[\w-]+)?:hover/,
				'recent-files-row': /\.recent-files-row(\.svelte-[\w-]+)?:hover/,
				'find-in-folder-hit': /\.find-in-folder-hit(\.svelte-[\w-]+)?:hover/,
				'context-menu-item': /\.context-menu-item(\.svelte-[\w-]+)?:hover/,
			};
			const found: Record<string, string | null> = {};
			for (const sheet of Array.from(document.styleSheets)) {
				let rules: CSSRuleList;
				try {
					rules = sheet.cssRules;
				} catch {
					continue;
				}
				for (const rule of Array.from(rules)) {
					if (!(rule instanceof CSSStyleRule)) continue;
					for (const [name, re] of Object.entries(wanted)) {
						if (re.test(rule.selectorText)) found[name] = rule.style.getPropertyValue('background-color').trim();
					}
				}
			}
			return found;
		});
		const hoverExpected: Record<string, string> = {
			'explorer-item': 'var(--color-bg-hover)',
			'recent-files-row': 'var(--color-bg-hover)',
			'find-in-folder-hit': 'var(--color-bg-hover)',
			'context-menu-item': 'var(--color-accent)',
		};
		const hoverPass = Object.entries(hoverExpected).every(([k, v]) => hoverRules[k] === v);
		report(REPORT, { gate: 6, item: 'hover rules declare the shared tokens (context menu = accent, 事後確認 6)', found: hoverRules, expected: hoverExpected, pass: hoverPass });
		// Selected rows compute to --color-accent-soft (Explorer's active row, a Recent
		// Files row) — the search panel is closed (above), so both are on the screen.
		await waitFor('[data-testid="recent-files-row"]', 'Recent Files rows (panel closed)');
		const accentSoft = colorKey(defaultToken('color-accent-soft', 'light'));
		await browser.execute(() => (document.querySelector('[data-testid="recent-files-row"]') as HTMLElement | null)?.click());
		await browser.pause(500);
		const selected = await browser.execute(() => {
			const read = (s: string) => {
				const el = document.querySelector(s);
				return el ? getComputedStyle(el).backgroundColor : null;
			};
			return {
				explorer: read('.explorer-item.active'),
				recent: read('.recent-files-row.active'),
				explorer_count: document.querySelectorAll('.explorer-item.active').length,
			};
		});
		const selectedPass =
			selected.explorer !== null && colorKey(selected.explorer) === accentSoft && (selected.recent === null || colorKey(selected.recent) === accentSoft);
		report(REPORT, {
			gate: 6,
			item: 'selected rows compute to --color-accent-soft',
			token: accentSoft,
			explorer_active: selected.explorer,
			recent_active: selected.recent,
			note: selected.recent === null ? 'no Recent Files row carried .active after the click' : undefined,
			pass: selectedPass,
		});
		// Icons: one viewBox, square at the declared size — on the Markdown screen
		// (Explorer, Recent Files, Find in Folder, StatusBar) and on the audio
		// viewer, where the zoom-in / zoom-out pair lives (reviewer P2-2).
		const mdIcons = await collectIcons();
		await openDoc(FIX.wav, '.audio-viewer canvas.waveform-canvas');
		await waitFor('.audio-viewer svg.ui-icon', 'audio toolbar icons', 10_000);
		const audioIcons = await collectIcons();
		const icons = [...mdIcons, ...audioIcons];
		const visibleIcons = icons.filter((i) => i.visible);
		const viewBoxes = new Set(icons.map((i) => i.viewBox));
		const squareOff = visibleIcons.filter((i) => Math.abs(i.w - i.h) > 0.5 || Math.abs(i.w - i.attr) > 0.5);
		const zoomPair = visibleIcons.filter((i) => i.use === '#i-zoom-in' || i.use === '#i-zoom-out');
		const pairSizes = new Set(zoomPair.map((i) => i.w));
		const iconPass =
			icons.length > 0 && viewBoxes.size === 1 && viewBoxes.has('0 0 24 24') && squareOff.length === 0 && zoomPair.length >= 2 && pairSizes.size === 1;
		report(REPORT, {
			gate: 6,
			item: 'svg.ui-icon: one viewBox, square at the declared size, zoom-in / zoom-out alike (audio viewer)',
			icons: icons.length,
			on_markdown: mdIcons.length,
			on_audio: audioIcons.length,
			visible: visibleIcons.length,
			view_boxes: Array.from(viewBoxes),
			sizes: Array.from(new Set(visibleIcons.map((i) => i.w))).sort((a, b) => a - b),
			not_square: squareOff,
			zoom_pair_sizes: Array.from(pairSizes),
			pass: iconPass,
		});
		report(REPORT, { gate: 6, item: 'glyph shapes', note: 'left to the eye (req56-gallery.mjs); the + / − widths are judged above as the zoom pair' });
		expect(focusPass && menuPass && hoverPass && selectedPass && iconPass).toBe(true);
	});

	// ---------------------------------------------------------------- gate 4

	it('gate 4a: forest.json is listed, chosen through settings.json (key order kept), applied on save, one dialog when broken, Default when unreadable or missing', async () => {
		const accentLight = (v: string) => colorKey(v);
		// settings.json with two keys first, so the order can be watched.
		writeSettings('{\n  "files.exclude": {\n    "**/.git": true\n  },\n  "search.exclude": {\n    "**/node_modules": true\n  }\n}\n');
		await clearEventRecord();
		writeTheme('forest', JSON.stringify(FOREST, null, 2));
		await browser.pause(1_500);
		// Not chosen yet: the look is Default and no theme_changed went out.
		const noChange = (await readEventRecord()).filter((e) => e.event === 'theme_changed').length;
		const listed = await operator('menu-items', { menu: 'View', submenu: 'Appearance' });
		const listedNames = listed ? (listed.items as { title: string }[]).map((i) => i.title) : null;
		report(REPORT, {
			gate: 4,
			item: 'forest.json appears in View ▸ Appearance (AX), nothing changes until chosen',
			theme_changed_before_choice: noChange,
			appearance_items: listedNames,
			pass: noChange === 0 && (listedNames === null ? null : listedNames.includes('forest')),
			note: listedNames === null ? 'the list is read by the operator; skipped without it' : undefined,
		});
		// Chosen through the file (as an outside editor would): theme_changed, forest's values.
		let logMark = appLogLines().length;
		writeSettings((await readSettings()).replace(/\n}\s*$/, ',\n  "appearance.theme": "forest"\n}\n'));
		const changed = await waitThemeChanged('appearance.theme = forest');
		await browser.pause(200);
		const accent = await token('--color-accent');
		const docSize = await token('--doc-size');
		const ring = await token('--color-focus-ring');
		const applyPass =
			changed.name === 'forest' && accentLight(accent) === accentLight('#1f7a4d') && docSize === '17px' && accentLight(ring) === accentLight('#1f7a4d');
		report(REPORT, {
			gate: 4,
			item: 'appearance.theme = "forest" (edited outside) → theme_changed, computed tokens are forest\'s',
			payload_name: changed.name,
			accent,
			doc_size: docSize,
			focus_ring: ring,
			code: changed.code,
			pass: applyPass,
		});
		// Chosen through the menu: Default, then forest again — the key order survives the rewrite.
		const viaMenu = await operator('press-submenu', { menu: 'View', submenu: 'Appearance', item: 'Default' });
		if (viaMenu) {
			const back = await waitThemeChanged('menu Default');
			const text = await readSettings();
			const order = Array.from(text.matchAll(/"(files\.exclude|search\.exclude|appearance\.theme)"/g)).map((m) => m[1]);
			const orderPass = back.name === 'default' && order.join(',') === 'files.exclude,search.exclude,appearance.theme' && /"appearance\.theme":\s*"default"/.test(text);
			report(REPORT, { gate: 4, item: 'menu Default rewrites appearance.theme only, key order kept', payload_name: back.name, key_order: order, pass: orderPass });
			await operator('press-submenu', { menu: 'View', submenu: 'Appearance', item: 'forest' });
			const again = await waitThemeChanged('menu forest');
			report(REPORT, { gate: 4, item: 'menu forest applies again', payload_name: again.name, pass: again.name === 'forest' });
		} else {
			report(REPORT, { gate: 4, item: 'menu Default / forest (AX press)', note: 'skipped without the operator; the rewrite itself is fixed by acceptance_req56_theme.rs (AC-56-21)' });
		}
		// Saving the file again applies at once.
		const forest18 = { ...FOREST, common: { 'doc-size': '18px' } };
		writeTheme('forest', JSON.stringify(forest18, null, 2));
		const saved = await waitThemeChanged('forest.json saved with doc-size 18px');
		await browser.pause(200);
		const docSize18 = await token('--doc-size');
		report(REPORT, { gate: 4, item: 'saving forest.json is applied at once', payload_name: saved.name, doc_size: docSize18, pass: docSize18 === '18px' });
		// A broken value: that token falls back, the rest stays, one dialog.
		// The native dialog is dismissed by the operator before the page is read
		// again (an app-modal alert may hold the webview's main thread).
		logMark = appLogLines().length;
		const broken = { ...forest18, light: { ...forest18.light, 'color-accent': '12px' } };
		writeTheme('forest', JSON.stringify(broken, null, 2));
		const brokenDialog = await dialogsSince(logMark, 'color-accent');
		const brokenChanged = await waitThemeChanged('broken color-accent');
		await browser.pause(400);
		const brokenAccent = await token('--color-accent');
		const brokenRing = await token('--color-focus-ring');
		const brokenDoc = await token('--doc-size');
		const brokenPass =
			brokenChanged.name === 'forest' &&
			accentLight(brokenAccent) === accentLight(defaultToken('color-accent', 'light')) &&
			accentLight(brokenRing) === accentLight('#1f7a4d') &&
			brokenDoc === '18px' &&
			(brokenChanged.warnings as string[]).some((w) => w.includes('color-accent')) &&
			oneDialog(brokenDialog);
		report(REPORT, {
			gate: 4,
			item: '"color-accent": "12px" → that token is Default, the others stay, one dialog',
			accent: brokenAccent,
			focus_ring: brokenRing,
			doc_size: brokenDoc,
			warnings: brokenChanged.warnings,
			dialogs: brokenDialog.dialogs,
			dialogs_matched: brokenDialog.matched,
			dialogs_where: brokenDialog.where,
			log_warn_lines: brokenDialog.warnLines,
			pass: brokenPass,
			note: brokenDialog.dialogs === null ? 'dialog count needs the operator (the native alert is on the screen)' : undefined,
		});
		// Unreadable JSON: Default as a whole, one dialog.
		logMark = appLogLines().length;
		writeTheme('forest', 'not json');
		const unreadableDialog = await dialogsSince(logMark, 'forest');
		const unreadable = await waitThemeChanged('unreadable forest.json');
		await browser.pause(400);
		const unreadableDoc = await token('--doc-size');
		const unreadablePass =
			unreadableDoc === defaultToken('doc-size', 'light') &&
			accentLight(await token('--color-focus-ring')) === accentLight(defaultToken('color-focus-ring', 'light')) &&
			(unreadable.warnings as string[]).length >= 1 &&
			oneDialog(unreadableDialog);
		report(REPORT, {
			gate: 4,
			item: 'unreadable JSON → Default whole, one dialog',
			doc_size: unreadableDoc,
			warnings: unreadable.warnings,
			dialogs: unreadableDialog.dialogs,
			dialogs_matched: unreadableDialog.matched,
			dialogs_where: unreadableDialog.where,
			pass: unreadablePass,
		});
		// Back to a valid forest, then a missing file.
		writeTheme('forest', JSON.stringify(FOREST, null, 2));
		await waitThemeChanged('forest valid again');
		logMark = appLogLines().length;
		writeSettings((await readSettings()).replace(/"appearance\.theme":\s*"[^"]*"/, '"appearance.theme": "nope"'));
		const missingDialog = await dialogsSince(logMark, 'nope');
		const missing = await waitThemeChanged('appearance.theme = nope');
		await browser.pause(400);
		const missingPass = missing.name === 'default' && (missing.warnings as string[]).some((w) => /not found/i.test(w)) && oneDialog(missingDialog);
		report(REPORT, {
			gate: 4,
			item: 'appearance.theme names a missing file → Default, one dialog (not found)',
			payload_name: missing.name,
			warnings: missing.warnings,
			dialogs: missingDialog.dialogs,
			dialogs_matched: missingDialog.matched,
			dialogs_where: missingDialog.where,
			pass: missingPass,
		});
		writeSettings((await readSettings()).replace(/"appearance\.theme":\s*"[^"]*"/, '"appearance.theme": "forest"'));
		await waitThemeChanged('forest once more');
		expect(applyPass && docSize18 === '18px' && brokenPass && unreadablePass && missingPass).toBe(true);
	});

	it('gate 4b: Light / Dark / System flip the look, System follows the OS, Shiki flips, the HTML iframe stays white, the choice is stored', async () => {
		await openDoc(FIX.md, PARA);
		await waitFor(`${BODY} pre code span[style]`, 'Shiki spans');
		const surface = { light: colorKey(defaultToken('color-bg-surface', 'light')), dark: colorKey(defaultToken('color-bg-surface', 'dark')) };
		const shikiColor = () => browser.execute(() => getComputedStyle(document.querySelector('article.viewer .markdown-body pre code span[style]')!).color);
		await setMode('light');
		const lightSurface = colorKey(await token('--color-bg-surface'));
		const lightShiki = await shikiColor();
		await setMode('dark');
		const darkSurface = colorKey(await token('--color-bg-surface'));
		await browser.waitUntil(async () => (await shikiColor()) !== lightShiki, { timeout: 8_000, timeoutMsg: 'Shiki was not redrawn for dark' }).catch(() => undefined);
		const darkShiki = await shikiColor();
		const stored = await browser.execute(() => localStorage.getItem('vellis.theme'));
		const modesPass = lightSurface === surface.light && darkSurface === surface.dark && darkShiki !== lightShiki && stored === 'dark';
		report(REPORT, {
			gate: 4,
			item: 'Light / Dark: data-theme, --color-bg-surface, Shiki colour, localStorage vellis.theme',
			light_surface: lightSurface,
			dark_surface: darkSurface,
			shiki_light: lightShiki,
			shiki_dark: darkShiki,
			stored,
			pass: modesPass,
		});
		// The HTML iframe keeps its white paper in dark.
		await openDoc(FIX.html, 'iframe.html-viewer');
		const iframeBg = await browser.execute(() => getComputedStyle(document.querySelector('iframe.html-viewer')!).backgroundColor);
		const iframePass = colorKey(iframeBg) === '255,255,255,1';
		report(REPORT, { gate: 4, item: 'HTML iframe keeps a white background in dark (判断 (o))', background: iframeBg, pass: iframePass });
		await openDoc(FIX.pdf, '.pdf-viewer');
		report(REPORT, { gate: 4, item: 'PDF / video / Mermaid do not follow the theme', note: 'the PDF frame and the video are native surfaces (not readable from the page); Mermaid has no fixture — left to the eye' });
		// System: no attribute, follows the OS appearance (the operator flips it).
		await setMode('system');
		const sysStored = await browser.execute(() => localStorage.getItem('vellis.theme'));
		const osBefore = await effectiveMode();
		const flipped = await operator('os-appearance', { set: osBefore === 'dark' ? 'light' : 'dark' });
		let osPass: boolean | null = null;
		let osAfter: string | null = null;
		let osSurface: string | null = null;
		if (flipped) {
			await browser.waitUntil(async () => (await effectiveMode()) !== osBefore, { timeout: 10_000, timeoutMsg: 'the OS appearance change did not reach the window' }).catch(() => undefined);
			osAfter = await effectiveMode();
			osSurface = colorKey(await token('--color-bg-surface'));
			osPass = osAfter !== osBefore && osSurface === surface[osAfter as 'light' | 'dark'] && (await rootAttr('data-theme')) === null;
			await operator('os-appearance', { set: 'restore' });
			await browser.waitUntil(async () => (await effectiveMode()) === osBefore, { timeout: 10_000, timeoutMsg: 'the OS appearance was not put back' }).catch(() => undefined);
		}
		report(REPORT, {
			gate: 4,
			item: 'System follows the OS appearance at once',
			stored: sysStored,
			os_before: osBefore,
			os_after: osAfter,
			surface_after: osSurface,
			pass: osPass,
			note: osPass === null ? 'needs the operator (osascript sets the OS appearance and puts it back)' : undefined,
		});
		await setMode('light');
		report(REPORT, { gate: 4, item: 'the mode reaches another window / survives a restart', note: 'another window: gate 5 (screenshot of the new window); restart: VELLIS_GATE_VARIANT=restart' });
		expect(modesPass && iframePass && sysStored === 'system' && osPass !== false).toBe(true);
	});

	it('gate 4c: Export Default Theme… writes my-theme.json in a new window, then my-theme-2.json, and still after the list was rebuilt', async function () {
		if (!OPERATOR) {
			report(REPORT, { gate: 4, item: 'Export Default Theme…', note: 'skipped: the item is a native submenu entry (Rust-only, no event); needs the operator (AX press)' });
			this.skip();
		}
		const exported = (n: string) => path.join(themesDir, n);
		const version = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
		const windowsBefore = (await operator('windows'))!.count as number;
		await operator('press-submenu', { menu: 'View', submenu: 'Appearance', item: 'Export Default Theme…' });
		await browser.waitUntil(() => fs.existsSync(exported('my-theme.json')), { timeout: 15_000, timeoutMsg: 'my-theme.json was not written' });
		await browser.pause(2_000);
		const first = JSON.parse(fs.readFileSync(exported('my-theme.json'), 'utf8')) as DefaultTheme & { meta: { name: string; description: string } };
		const windowsAfter = (await operator('windows'))!.count as number;
		const firstPass =
			first.meta.name === 'My Theme' &&
			first.meta.description === `Exported from Vellis ${version}` &&
			JSON.stringify(first.light) === JSON.stringify(defaultTheme.light) &&
			JSON.stringify(first.dark) === JSON.stringify(defaultTheme.dark) &&
			JSON.stringify(first.common) === JSON.stringify(defaultTheme.common) &&
			windowsAfter === windowsBefore + 1;
		report(REPORT, {
			gate: 4,
			item: 'Export Default Theme… → my-theme.json (Default, My Theme, Exported from Vellis <版>) and one new window',
			meta: first.meta,
			windows_before: windowsBefore,
			windows_after: windowsAfter,
			pass: firstPass,
		});
		const firstBytes = fs.readFileSync(exported('my-theme.json'));
		await operator('press-submenu', { menu: 'View', submenu: 'Appearance', item: 'Export Default Theme…' });
		await browser.waitUntil(() => fs.existsSync(exported('my-theme-2.json')), { timeout: 15_000, timeoutMsg: 'my-theme-2.json was not written' });
		await browser.pause(1_500);
		const secondPass = fs.readFileSync(exported('my-theme.json')).equals(firstBytes);
		report(REPORT, { gate: 4, item: 'a second Export writes my-theme-2.json and leaves my-theme.json as it was', pass: secondPass });
		// Rebuild the list (forest.json goes), then Export must still be there and work (reviewer P2-2).
		await clearEventRecord();
		const removeMark = appLogLines().length;
		fs.rmSync(exported('forest.json'), { force: true });
		// The chosen theme is gone: Rust warns (not found) with one dialog, which
		// must be dismissed before the AX presses and gate 5's real keys (reviewer P2-4).
		const removeDialog = await dialogsSince(removeMark, 'forest');
		const removed = await waitThemeChanged('forest.json removed while chosen → Default');
		report(REPORT, {
			gate: 4,
			item: 'removing the chosen forest.json → Default with one dialog (not found)',
			payload_name: removed.name,
			warnings: removed.warnings,
			dialogs: removeDialog.dialogs,
			dialogs_matched: removeDialog.matched,
			dialogs_where: removeDialog.where,
			pass: removed.name === 'default' && oneDialog(removeDialog),
		});
		await browser.pause(1_000);
		const items = (await operator('menu-items', { menu: 'View', submenu: 'Appearance' }))!.items as { title: string; separator?: boolean }[];
		const titles = items.map((i) => (i.separator ? '---' : i.title));
		const last = items[items.length - 1];
		const tailPass = last?.title === 'Export Default Theme…' && items[items.length - 2]?.separator === true && !titles.includes('forest');
		report(REPORT, { gate: 4, item: 'after the list was rebuilt: forest gone, separator + Export Default Theme… still last', items: titles, pass: tailPass });
		await operator('press-submenu', { menu: 'View', submenu: 'Appearance', item: 'Export Default Theme…' });
		await browser.waitUntil(() => fs.existsSync(exported('my-theme-3.json')), { timeout: 15_000, timeoutMsg: 'my-theme-3.json was not written after the rebuild' });
		report(REPORT, { gate: 4, item: 'Export still works after the rebuild (my-theme-3.json)', pass: true });
		// my-theme*.json are themes of their own now: the list shows them.
		const items2 = (await operator('menu-items', { menu: 'View', submenu: 'Appearance' }))!.items as { title: string }[];
		report(REPORT, { gate: 4, item: 'exported files are listed as themes', items: items2.map((i) => i.title), pass: items2.some((i) => i.title === 'my-theme') });
		// Put forest back for the restart phase.
		writeTheme('forest', JSON.stringify(FOREST, null, 2));
		await waitThemeChanged('forest back');
		await operator('close-extra-windows');
		expect(firstPass && secondPass && tailPass).toBe(true);
	});

	it('gate 4d: the audio waveform is redrawn in the new colours when the mode changes (reviewer P2-1)', async () => {
		await setMode('light');
		await openDoc(FIX.wav, '.audio-viewer canvas.waveform-canvas');
		await browser.waitUntil(async () => ((await sampleWaveform())?.drawn ?? 0) > 0, { timeout: 20_000, timeoutMsg: 'the waveform was never drawn' });
		const muted = { light: colorKey(defaultToken('color-text-muted', 'light')), dark: colorKey(defaultToken('color-text-muted', 'dark')) };
		const light = (await sampleWaveform())!;
		await setMode('dark');
		await browser.waitUntil(async () => (await sampleWaveform())?.hash !== light.hash, { timeout: 8_000, timeoutMsg: 'the waveform was not redrawn for dark' }).catch(() => undefined);
		const dark = (await sampleWaveform())!;
		await setMode('light');
		// The canvas is drawn with anti-aliased edges: the dominant pixel's alpha
		// comes back a little under 1 (0.973 on the 2026-11-03 run), so the RGB
		// part is what is compared, with the alpha near opaque.
		const rgb = (k: string | null) => (k ? k.split(',').slice(0, 3).join(',') : null);
		const alpha = (k: string | null) => (k ? Number(k.split(',')[3] ?? '0') : 0);
		const pass =
			rgb(light.dominant) === rgb(muted.light) &&
			rgb(dark.dominant) === rgb(muted.dark) &&
			alpha(light.dominant) >= 0.9 &&
			alpha(dark.dominant) >= 0.9 &&
			light.hash !== dark.hash;
		report(REPORT, {
			gate: 4,
			item: 'waveform pixels: dominant colour = --color-text-muted of the mode (RGB; alpha ≥ 0.9), bitmap changes',
			light,
			dark,
			expected: muted,
			compared: { light_rgb: rgb(light.dominant), dark_rgb: rgb(dark.dominant), light_alpha: alpha(light.dominant), dark_alpha: alpha(dark.dominant) },
			pass,
		});
		expect(pass).toBe(true);
	});

	// ---------------------------------------------------------------- gate 5

	it('gate 5: the chrome stays in place across Command + T, fullscreen in and out, and a New Window looks the same', async function () {
		if (!OPERATOR) {
			report(REPORT, { gate: 5, item: 'tabs / fullscreen / New Window', note: 'skipped: real keys and AX through the operator' });
			this.skip();
		}
		await openDoc(FIX.md, PARA);
		await setMode('dark');
		const base = await measureChrome();
		report(REPORT, { gate: 5, item: 'baseline', measure: base });
		// Command + T (要件#62): a tab bar appears; the web area must not be hidden under it.
		// The key must reach the baseline window (the one this spec measures, the
		// driver's `base`), so only that window may be in front and the only
		// document window: the 2026-11-03 run sent Command + T to an Export
		// window left open, and measured the wrong DOM. When the driver could not
		// bring it to the front (`front: false`) or other windows remain, that is
		// the environment, reported as such and not judged as the product.
		let windowsNow = (await operator('windows'))!;
		if (((windowsNow.frames as WindowFrame[]) ?? []).length > 1) {
			// Whatever an earlier gate left open (the Export windows of 4c): closed here, not assumed.
			const closedFirst = await operator('close-extra-windows');
			report(REPORT, { gate: 5, item: 'extra windows closed before Command + T', answer: closedFirst });
			windowsNow = (await operator('windows'))!;
		}
		// Living windows only: `count` is the driver's Window-menu count (visible
		// windows + hidden tabs; a closed window's stale CG entry is not in it),
		// `frames` the visible windows' CG frames.
		const framesBefore = (windowsNow.frames as WindowFrame[]) ?? [];
		const livingBefore = windowsNow.count as number;
		const baseNumber = windowsNow.base as number | null;
		const first = baseNumber === null ? framesBefore[0] : framesBefore.find((f) => f.number === baseNumber);
		const onlyBaseline = livingBefore === 1 && framesBefore.length === 1 && first !== undefined;
		if (!onlyBaseline) {
			report(REPORT, { gate: 5, item: 'precondition: the baseline window is the only document window', base: baseNumber, living: livingBefore, titles: windowsNow.titles, source: windowsNow.source, frames: framesBefore, pass: false, environment: 'other windows / tabs are still open (close-extra-windows could not close them: see the operator log)' });
			throw new Error(`gate 5 precondition: ${livingBefore} living windows (${framesBefore.length} visible), expected only the baseline ${baseNumber}: ${JSON.stringify(windowsNow.titles)} ${JSON.stringify(framesBefore)}`);
		}
		const tabAnswer = (await operator('new-tab'))!;
		if (tabAnswer.front !== true || tabAnswer.sent !== true) {
			report(REPORT, { gate: 5, item: 'precondition: the baseline window is in front for Command + T', base: baseNumber, answer: tabAnswer, pass: false, environment: 'the driver could not bring the baseline window to the front (realinput front ok:false); the key was not sent' });
			throw new Error(`gate 5 precondition: the baseline window ${baseNumber} could not be brought to the front: ${JSON.stringify(tabAnswer)}`);
		}
		await browser.pause(2_500);
		const tabbed = await measureChrome();
		// The web area must be pushed down by the tab bar (≥ 20px shorter) while the
		// window's outer frame stays as it was (reviewer P2-1: the spike's overlay
		// left innerHeight alone and hid the top of the header).
		const tabJudge = chromeInPlace(tabbed, base, 20);
		// The baseline is the background tab now: the driver still reports its
		// frame by number (hidden: true) as long as the living count says a tab
		// is hidden behind the visible one.
		const framesAfter = (tabAnswer.frames as WindowFrame[]) ?? [];
		const firstAfter = first ? framesAfter.find((f) => f.number === first.number) : undefined;
		const frameSame = !!first && !!firstAfter && Math.abs(firstAfter.h - first.h) <= 2 && Math.abs(firstAfter.w - first.w) <= 2;
		if (!frameSame) tabJudge.why.push(`outer frame changed: ${JSON.stringify(first)} → ${JSON.stringify(firstAfter ?? null)}`);
		const tabPass = tabJudge.why.length === 0;
		report(REPORT, {
			gate: 5,
			item: 'after Command + T: tab bar pushes the web area down (innerHeight shrinks), outer frame unchanged, chrome in place',
			measure: tabbed,
			baseline_inner_height: base.innerHeight,
			base: baseNumber,
			front: tabAnswer.front,
			living_before: tabAnswer.windows_before,
			living_after: tabAnswer.windows,
			titles_after: tabAnswer.titles,
			frame_before: first ?? null,
			frame_after: firstAfter ?? null,
			pass: tabPass,
			why: tabJudge.why,
		});
		const closedTab = (await operator('close-extra-windows'))!;
		await browser.pause(1_500);
		// Fullscreen in, then out — again only with the baseline in front. The
		// operator sends Globe (fn) + F on the hid route (Control + Command + F
		// does nothing on macOS 27) and answers with the key, realinput's output
		// and the AXFullScreen attribute after the key (`fullscreen_after`).
		// Every answer is reported before the wait, and a wait that times out is
		// reported too (with the answer and the heights), so a key that went out
		// but did not toggle fullscreen leaves a record and not only a timeout.
		const innerHeight = async (): Promise<number> => browser.execute(() => window.innerHeight);
		const fullAnswer = (await operator('fullscreen'))!;
		if (fullAnswer.front !== true || fullAnswer.sent !== true) {
			const environment = fullAnswer.front !== true ? 'the driver could not bring the baseline window to the front; the key was not sent' : 'the driver refused to send the key (see realinput)';
			report(REPORT, { gate: 5, item: 'precondition: the baseline window is in front for fullscreen', base: baseNumber, after_close: closedTab, answer: fullAnswer, pass: false, environment });
			throw new Error(`gate 5 precondition: the baseline window ${baseNumber} could not be brought to the front for fullscreen: ${JSON.stringify(fullAnswer)}`);
		}
		report(REPORT, { gate: 5, item: 'fullscreen key sent (enter)', base: baseNumber, answer: fullAnswer, innerHeight_before: base.innerHeight, innerHeight_now: await innerHeight() });
		try {
			await browser.waitUntil(async () => (await innerHeight()) > base.innerHeight + 20, { timeout: 15_000, timeoutMsg: 'fullscreen did not enlarge the window' });
		} catch (e) {
			report(REPORT, { gate: 5, item: 'precondition: fullscreen did not enlarge the window', base: baseNumber, answer: fullAnswer, innerHeight_before: base.innerHeight, innerHeight_after: await innerHeight(), pass: false, environment: `the key was sent (${JSON.stringify(fullAnswer.key)}) but the window did not grow within 15 s; fullscreen_after=${JSON.stringify(fullAnswer.fullscreen_after)}` });
			throw e;
		}
		await browser.pause(1_500);
		const full = await measureChrome();
		const fullJudge = chromeInPlace(full, base);
		await shot('req56-gate5-fullscreen-dark');
		report(REPORT, { gate: 5, item: 'in fullscreen', measure: full, pass: fullJudge.ok, why: fullJudge.why });
		const leaveAnswer = (await operator('fullscreen'))!;
		if (leaveAnswer.sent !== true) {
			const environment = leaveAnswer.front !== true ? 'the driver could not bring the baseline window to the front; the key was not sent' : 'the driver refused to send the key (see realinput)';
			report(REPORT, { gate: 5, item: 'precondition: the baseline window is in front for leaving fullscreen', base: baseNumber, answer: leaveAnswer, pass: false, environment });
			throw new Error(`gate 5 precondition: the key to leave fullscreen was not sent: ${JSON.stringify(leaveAnswer)}`);
		}
		report(REPORT, { gate: 5, item: 'fullscreen key sent (leave)', base: baseNumber, answer: leaveAnswer, innerHeight_before: base.innerHeight, innerHeight_now: await innerHeight() });
		try {
			await browser.waitUntil(async () => Math.abs((await innerHeight()) - base.innerHeight) <= 2, { timeout: 15_000, timeoutMsg: 'leaving fullscreen did not restore the window' });
		} catch (e) {
			report(REPORT, { gate: 5, item: 'precondition: leaving fullscreen did not restore the window', base: baseNumber, answer: leaveAnswer, innerHeight_before: base.innerHeight, innerHeight_after: await innerHeight(), pass: false, environment: `the key was sent (${JSON.stringify(leaveAnswer.key)}) but the window did not come back within 15 s; fullscreen_after=${JSON.stringify(leaveAnswer.fullscreen_after)}` });
			throw e;
		}
		await browser.pause(1_500);
		const back = await measureChrome();
		const backJudge = chromeInPlace(back, base);
		report(REPORT, { gate: 5, item: 'back from fullscreen', measure: back, pass: backJudge.ok, why: backJudge.why });
		// Duplicate Window, then New Window (要件#56 gate 5: "New Window /
		// Duplicate Window で開いた窓も同じ見え方"): each is pressed by the
		// operator with the baseline in front, every on-screen window captured,
		// and the chrome pixels of the baseline's capture compared with the new
		// window's — the capture whose CG number is not the baseline's (not "the
		// last number": CG numbers are not in creation order).
		//   - Duplicate Window opens the same folder and document as the
		//     baseline: header (explorer heading row) / status bar / surface.
		//   - New Window opens empty (EmptyState — the folder is picked from
		//     Recent; product behaviour since before 要件#56): there is no
		//     explorer header to sample, so status bar / surface only, and the
		//     header is left in the report as `compared: false` with the reason.
		type Capture = { number: number; file: string; w: number; h: number };
		type Point = 'header' | 'status' | 'surface';
		const samplePoints = (c: Capture): Record<Point, [number, number, number]> => {
			const bmp = decodePng(c.file);
			const dpr = bmp.width / c.w;
			const titleBar = Math.round(28 * dpr);
			return {
				header: pixelAt(bmp, Math.round(40 * dpr), titleBar + Math.round(17 * dpr)),
				status: pixelAt(bmp, Math.round(40 * dpr), bmp.height - Math.round(12 * dpr)),
				surface: pixelAt(bmp, Math.round((c.w - 60) * dpr), titleBar + Math.round(60 * dpr)),
			};
		};
		const compareWindows = (captured: Record<string, unknown>, points: Point[], skipped: Partial<Record<Point, string>>) => {
			const files = (captured.files as Capture[] | undefined) ?? [];
			const captureBase = (captured.base as number | null | undefined) ?? baseNumber;
			const baseCapture = captureBase === null ? files[0] : files.find((f) => f.number === captureBase);
			const newCapture = files.find((f) => f !== baseCapture && f.number !== captureBase);
			const strips: Record<string, unknown>[] = [];
			let pass: boolean | null = null;
			let note: string | undefined;
			if (!baseCapture) note = `no capture of the baseline window ${captureBase}`;
			else if (!newCapture) note = `no capture of a window other than the baseline ${captureBase} (new_number=${JSON.stringify(captured.new_number)})`;
			else {
				const a = samplePoints(baseCapture);
				const n = samplePoints(newCapture);
				const distance: Partial<Record<Point, number>> = {};
				for (const p of points) distance[p] = pixelDistance(a[p], n[p]);
				const skippedOut: Record<string, unknown> = {};
				for (const [p, reason] of Object.entries(skipped)) skippedOut[p] = { compared: false, reason };
				pass = points.every((p) => distance[p]! <= 24);
				strips.push({ base_number: baseCapture.number, new_number: newCapture.number, first: a, new: n, distance, ...skippedOut });
			}
			return { files, strips, pass, note };
		};
		// Duplicate Window: the same folder and document, all three points.
		const dupCaptured = (await operator('duplicate-window-capture'))!;
		const dup = compareWindows(dupCaptured, ['header', 'status', 'surface'], {});
		report(REPORT, {
			gate: 5,
			item: 'Duplicate Window shows the same chrome colours (dark) — header / status bar / surface pixels',
			base: baseNumber,
			front: dupCaptured.front,
			pressed: dupCaptured.pressed,
			living_before: dupCaptured.windows_before,
			living_after: dupCaptured.windows_after,
			captures: dup.files,
			strips: dup.strips,
			pass: dup.pass,
			note: dup.note,
		});
		const closedDup = await operator('close-extra-windows');
		report(REPORT, { gate: 5, item: 'extra windows closed after Duplicate Window', answer: closedDup });
		await browser.pause(1_000);
		// New Window: empty (EmptyState), so the status bar and the surface only.
		const newCaptured = (await operator('new-window-capture'))!;
		const neu = compareWindows(newCaptured, ['status', 'surface'], { header: 'New Window opens empty (EmptyState) — no explorer header' });
		report(REPORT, {
			gate: 5,
			item: 'New Window shows the same chrome colours (dark) — status bar / surface pixels (no explorer in an empty window)',
			base: baseNumber,
			front: newCaptured.front,
			pressed: newCaptured.pressed,
			living_before: newCaptured.windows_before,
			living_after: newCaptured.windows_after,
			captures: neu.files,
			strips: neu.strips,
			pass: neu.pass,
			note: neu.note,
		});
		await operator('close-extra-windows');
		await setMode('light');
		report(REPORT, { gate: 5, item: 'the print window is unaffected', note: 'judged by req56-print.sh (gate 7: light / dark / zoomed prints are identical)' });
		expect(tabPass && fullJudge.ok && backJudge.ok && dup.pass !== false && neu.pass !== false).toBe(true);
	});

	// ---------------------------------------------------------------- gate 8

	it('gate 8: 起案時判断 req-56 (a)〜(r) and theme-architecture (a)〜(s) — judged here or covered by vitest / cargo', async () => {
		const req56: Record<string, string> = {
			a: 'judged-by: gate 4a/4b (Appearance submenu items read by AX; Light/Dark/System events) · covered-by: src-tauri/tests/acceptance_req56.rs',
			b: 'judged-by: gate 4b (data-theme light/dark, none for System) · covered-by: src/lib/ui-chrome.wiring.test.ts',
			c: 'judged-by: gate 4b (localStorage vellis.theme) · covered-by: src/lib/ui-chrome.wiring.test.ts',
			d: 'withdrawn (Overlay) — not applicable',
			e: 'withdrawn (Overlay) — not applicable',
			f: 'judged-by: gate 3 (paragraph 72ch, table/pre/img wider) · covered-by: src/lib/viewer-width.acceptance.test.ts',
			g: 'judged-by: gate 3 (menu_toggle_full_width → data-doc-measure="full") · covered-by: src-tauri/tests/acceptance_req56.rs (label Toggle Full Width)',
			h: 'judged-by: gate 3 (localStorage vellis.doc-measure) + restart phase · covered-by: src/lib/ui-chrome.wiring.test.ts',
			i: 'judged-by: gate 6 (svg.ui-icon <use href="#i-…">) · covered-by: src/lib/ui-invariants-stage2.acceptance.test.ts',
			j: 'judged-by: gate 2 (new palette computed everywhere) · covered-by: src/styles/design-tokens.acceptance.test.ts',
			k: 'judged-by: gate 2 findbar scene (no old #fef08a/#fb923c outside the tokens) · covered-by: src/components/Viewer.findcolor.wiring.test.ts',
			l: 'covered-by: src/styles/design-tokens.acceptance.test.ts (AC-56-4: --md-color-* derived, --color-emphasis)',
			m: 'judged-by: gate 4b (Shiki colour differs light/dark) · covered-by: src/styles/design-tokens.acceptance.test.ts (AC-56-6)',
			n: 'judged-by: gate 4b (Shiki redrawn on mode change) · covered-by: src/lib/theme-appearance.wiring.test.ts',
			o: 'judged-by: gate 4b (iframe stays white) · Mermaid: eye · covered-by: src/lib/ui-invariants.acceptance.test.ts',
			p: 'judged-by: req56-print.sh (gate 7) · covered-by: src/lib/print-theme.acceptance.test.ts (AC-56-22), AC-56-16',
			q: 'judged-by: eye (uppercase pane headers in the gallery) · covered-by: src/styles/design-tokens-stage2.acceptance.test.ts (--pane-header-* values)',
			r: 'judged-by: gate 2 emptystate scene; RootPicker: eye · covered-by: src/styles/design-tokens-stage2.acceptance.test.ts',
		};
		const arch: Record<string, string> = {
			a: 'judged-by: gate 4a (forest.json keys without "--") · covered-by: src-tauri/tests/acceptance_req56_theme.rs',
			b: 'judged-by: gate 4a (common doc-size + light/dark accent) · covered-by: acceptance_req56_theme.rs',
			c: 'judged-by: gate 4a (menu shows the stem "forest", payload name "forest") · covered-by: acceptance_req56_theme.rs',
			d: 'judged-by: gate 4a (menu Default → "default") · covered-by: acceptance_req56_theme.rs (reserved name)',
			e: 'judged-by: gate 4c (my-theme.json, -2, -3; meta) · covered-by: src-tauri/tests/acceptance_req56_export.rs',
			f: 'covered-by: acceptance_req56_theme.rs (no extends; unknown keys ignored)',
			g: 'judged-by: gate 4a ("12px" for a colour falls back) · covered-by: acceptance_req56_theme.rs (white list)',
			h: 'judged-by: gate 4a (one native dialog per resolve; startup: restart phase) · covered-by: acceptance_req56_theme.rs (one warnings entry)',
			i: 'judged-by: gate 4a (settings.json edited outside is picked up; forest.json save applied) · covered-by: acceptance_req56_stage2.rs (watcher)',
			j: 'judged-by: restart phase (theme present at first mount) · covered-by: src/lib/theme.wiring.test.ts (+layout.ts awaits get_theme)',
			k: 'judged-by: gate 4a (computed tokens follow #vellis-theme) · covered-by: src/lib/theme.wiring.test.ts (3 blocks, last <style>)',
			l: 'covered-by: src/styles/design-tokens.acceptance.test.ts (AC-56-18 generated theme.css)',
			m: 'covered-by: design-tokens.acceptance.test.ts (AC-56-18) + acceptance_req56_theme.rs (AC-56-19)',
			n: 'covered-by: acceptance_req56_theme.rs (version absent / 1 / 2)',
			o: 'judged-by: gate 4a (code.dark vitesse-dark accepted; payload code) · covered-by: src/lib/theme.wiring.test.ts (bundledThemes fallback)',
			p: 'judged-by: gate 4c (Export and the rebuilt list are in stage 2) · covered-by: acceptance_req56_export.rs',
			q: 'judged-by: gate 4a (key order files.exclude → search.exclude → appearance.theme kept) · covered-by: acceptance_req56_theme.rs (AC-56-21)',
			r: 'covered-by: acceptance_req56_theme.rs (alias names are not keys) + design-tokens.acceptance.test.ts (aliases via var())',
			s: 'covered-by: src-tauri/tests/acceptance_req65.rs (AC-65-2: default_settings_json has appearance.theme)',
		};
		for (const [k, v] of Object.entries(req56)) report(REPORT, { gate: 8, item: `req-56 (${k})`, how: v });
		for (const [k, v] of Object.entries(arch)) report(REPORT, { gate: 8, item: `theme-architecture (${k})`, how: v });
		// Leave the state the restart phase checks (full width, dark, forest), or put it back.
		if (KEEP_STATE) {
			await openDoc(FIX.md, PARA);
			if ((await rootAttr('data-doc-measure')) !== 'full') await emitMenu('menu_toggle_full_width');
			await setMode('dark');
			const settings = await readSettings();
			if (!/"appearance\.theme":\s*"forest"/.test(settings)) {
				writeSettings(settings.replace(/"appearance\.theme":\s*"[^"]*"/, '"appearance.theme": "forest"'));
				await waitThemeChanged('forest for the restart phase').catch(() => undefined);
			}
			// forest.json is left with light.color-accent broken ("12px"): the next
			// app must warn ONCE at startup (theme-architecture (h) "起動時にも出す",
			// reviewer P2-3). dark and doc-size are untouched, so the restart
			// phase's other expectations do not move. The dialog this write
			// raises now is dismissed here.
			const brokenMark = appLogLines().length;
			writeTheme('forest', JSON.stringify({ ...FOREST, light: { ...FOREST.light, 'color-accent': '12px' } }, null, 2));
			const brokenNow = await dialogsSince(brokenMark, 'color-accent');
			await waitThemeChanged('forest with a broken light accent, for the restart phase').catch(() => undefined);
			// localStorage was written by the mode / width handlers above; read it
			// back and give WebKit a moment before the app is quit (the restart
			// phase reads it from disk).
			await browser.pause(2_000);
			const stored = await browser.execute(() => ({ theme: localStorage.getItem('vellis.theme'), measure: localStorage.getItem('vellis.doc-measure') }));
			report(REPORT, {
				gate: 'state',
				item: 'left for the restart phase',
				doc_measure: await rootAttr('data-doc-measure'),
				data_theme: await rootAttr('data-theme'),
				stored,
				theme: 'forest (light.color-accent = "12px")',
				dialog_now: brokenNow.dialogs,
				dialog_now_matched: brokenNow.matched,
				pass: stored.theme === 'dark' && stored.measure === 'full',
			});
		}
		expect(true).toBe(true);
	});

	it('no page dialog (alert / confirm / prompt) was raised by any of the gates', async () => {
		const rec = await readGateRecord();
		report(REPORT, { gate: 'dialogs', page_dialogs: rec.dialogs, pass: rec.dialogs.length === 0 });
		expect(rec.dialogs).toEqual([]);
	});
});

// --- phase 2: the same home, a new app ---------------------------------------------

describe('Requirement #56 stage 2 — after a restart (VELLIS_GATE_VARIANT=restart)', function () {
	this.timeout(120_000);

	/** Dialogs the operator found (and dismissed) while the new app came up; null without the operator. */
	let startupDialogs: number | null = null;
	/** Of those, the ones whose texts said "color-accent" (null when the driver did not say). */
	let startupMatched: number | null = null;
	let startupWhere: unknown[] = [];

	before(async function () {
		if (!DEVICE || VARIANT !== 'restart') this.skip();
		fs.rmSync(OP_DIR, { recursive: true, force: true });
		// The startup warning (forest.json was left with a broken light accent)
		// comes before anything else. The driver dismisses it on its own as soon
		// as it sees the app and leaves the count in req56-startup-dialogs.json
		// (reviewer P3-6: the modal may hold the webview before wdio's session
		// exists, so this code may run late); that file is used when present,
		// else the operator is asked (reviewer P2-3).
		const startupFile = path.join(SHOTS_DIR, 'req56-startup-dialogs.json');
		if (OPERATOR) {
			await browser.waitUntil(() => fs.existsSync(startupFile), { timeout: 15_000, timeoutMsg: 'no req56-startup-dialogs.json' }).catch(() => undefined);
		}
		if (fs.existsSync(startupFile)) {
			const counted = JSON.parse(fs.readFileSync(startupFile, 'utf8')) as { dialogs: number; matched?: number; where?: unknown[]; texts?: unknown[] };
			startupDialogs = counted.dialogs;
			startupMatched = typeof counted.matched === 'number' ? counted.matched : null;
			startupWhere = counted.where ?? [];
			report(REPORT, { gate: 'restart', item: 'startup dialogs counted by the driver', file: startupFile, dialogs: startupDialogs, matched: startupMatched, where: startupWhere, texts: counted.texts ?? [] });
		} else {
			const answer = await operator('dialog', { expect: 'color-accent', wait_s: 10 });
			startupDialogs = answer ? (answer.dialogs as number) : null;
			startupMatched = answer && typeof answer.matched === 'number' ? (answer.matched as number) : null;
			startupWhere = answer && Array.isArray(answer.where) ? (answer.where as unknown[]) : [];
		}
		await waitForAppMounted();
		await installGateRecorder();
		await installEventRecorder(['theme_changed']);
	});

	after(async function () {
		if (!DEVICE || VARIANT !== 'restart') return;
		await emitMenu('menu_appearance_system');
		if ((await rootAttr('data-doc-measure')) === 'full') await emitMenu('menu_toggle_full_width');
		if (fs.existsSync(settingsPath)) writeSettings((await readSettings()).replace(/"appearance\.theme":\s*"[^"]*"/, '"appearance.theme": "default"'));
		await browser.pause(1_000);
		await removeEventRecorder();
		await restoreGateRecorder();
	});

	it('gate 3 / 4: full width, dark and the forest theme are there from the first paint of a new app', async () => {
		const measure = await rootAttr('data-doc-measure');
		const mode = await rootAttr('data-theme');
		const styleLast = await browser.execute(() => {
			const styles = Array.from(document.head.querySelectorAll('style'));
			const last = styles[styles.length - 1];
			return { id: last?.id ?? null, hasForest: (document.getElementById('vellis-theme')?.textContent ?? '').includes('#1f7a4d') };
		});
		const accent = await token('--color-accent');
		const docSize = await token('--doc-size');
		await waitForExplorerRow(uri(file(FIX.md)), { timeout: 30_000, nudgeDir: root, nudgePrefix: 'req56r' });
		await openDoc(FIX.md, PARA);
		const para = (await rectOf(PARA))!;
		const body = await contentWidth(BODY);
		const pass =
			measure === 'full' &&
			mode === 'dark' &&
			styleLast.id === 'vellis-theme' &&
			styleLast.hasForest &&
			colorKey(accent) === colorKey('#3fae78') &&
			docSize === '17px' &&
			Math.abs(para.width - body) <= 4;
		report(REPORT, {
			gate: 'restart',
			item: 'data-doc-measure=full, data-theme=dark, #vellis-theme last with forest, forest dark accent, 17px, paragraph full width',
			data_doc_measure: measure,
			data_theme: mode,
			last_style: styleLast,
			accent,
			doc_size: docSize,
			paragraph_px: para.width,
			body_content_px: body,
			pass,
		});
		// The broken light accent: Default's value in the light block, forest's ring kept.
		const lightAccent = await browser.execute(() => {
			const css = document.getElementById('vellis-theme')?.textContent ?? '';
			const lightBlock = css.split(':root[data-theme="dark"]')[0] ?? '';
			return /--color-accent:\s*([^;]+);/.exec(lightBlock)?.[1]?.trim() ?? null;
		});
		const laterDialogs = await operator('dialog', { expect: 'none after startup', wait_s: 3 });
		const startupPass =
			startupDialogs === null
				? null
				: startupDialogs === 1 && (startupMatched === null || startupMatched === 1) && (laterDialogs === null || (laterDialogs.dialogs as number) === 0);
		report(REPORT, {
			gate: 'restart',
			item: 'one theme warning dialog at startup (light.color-accent = "12px"), none later; the light accent is Default\'s',
			dialogs_at_startup: startupDialogs,
			dialogs_at_startup_matched: startupMatched,
			dialogs_at_startup_where: startupWhere,
			dialogs_later: laterDialogs ? laterDialogs.dialogs : null,
			light_accent_injected: lightAccent,
			pass: startupPass === null ? null : startupPass && colorKey(lightAccent ?? '') === colorKey(defaultToken('color-accent', 'light')),
			note: startupDialogs === null ? 'needs the operator' : undefined,
		});
		expect(pass).toBe(true);
	});
});
