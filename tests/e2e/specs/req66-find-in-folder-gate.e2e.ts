import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertIpcInterceptionWorks,
	clearCapturedIpc,
	emitMenu,
	installGateRecorder,
	readCapturedIpc,
	readGateRecord,
	report,
	restoreGateRecorder,
	setIpcCapture,
	shot,
	waitForAppMounted,
	waitForExplorerRow,
	zoomedShot,
	type CapturedIpc,
} from '../gate-helpers';
import { activeExcludePatterns } from '../settings-excludes';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Requirement #66 human gates 2-4, driven on the webdriver build
 * (docs/requirements/req-66.md「人間ゲート」), plus the screenshots and the
 * behaviour records a human needs for gates 1 and 5.
 *
 *  2. All toggles OFF gives the same results as before #66. The "before"
 *     rule (requirement #55 契約④: per line, case-insensitive substring,
 *     `ordinal` = 1 + occurrences in the lines above, path order then line
 *     order, text files = everything not in the non-text extension list) is
 *     re-implemented here in Node as an independent oracle and compared with
 *     what the panel got back from `search_in_folder` (captured at the fetch
 *     layer: path / line / text / ordinal, total, files) and with the rows
 *     the panel shows, over a copy of this repository's `docs/` (103 Markdown
 *     files, Japanese and English) plus small crafted samples.
 *  3. Each toggle, the 8 combinations (AC-66-6 table), pressing a toggle
 *     re-searches at once without typing, the state survives Close + reopen,
 *     is in no web storage, and a fresh page (= a fresh module instance, the
 *     same as a new window; webdriver cannot enter a second window) starts
 *     OFF. ssh roots stay with a human (no reachable ssh target on this
 *     machine without touching ~/.ssh).
 *  4. Clicking a result opens the file and the clicked match is the current
 *     match of the in-document find (#54): the find input holds the word
 *     (`matched` for .*), `n of m` has n = ordinal, and the current
 *     highlight's range sits on the clicked line at the clicked occurrence.
 *  1/5. Screenshots (OFF / each ON / all ON / broken expression) and the
 *     records for `^$`, broken expressions, ab on symbol-edged words and
 *     Japanese, and the absence of shortcuts go to $VELLIS_GATE_SHOTS and
 *     `req66-report.jsonl` there.
 */

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const gateDir = path.join(startRoot, 'req66-gate');
const corpusDir = path.join(gateDir, 'corpus');
// `0-samples` sorts before `corpus`, so the samples' hits are in the first page of every search.
const samplesDir = path.join(gateDir, '0-samples');
const REPORT = 'req66-report.jsonl';
const BODY = 'article.viewer .markdown-body';
const SEARCH = 'search_in_folder';
const PAGE = 'search_in_folder_page';
const INVALID = 'Invalid regular expression';

const uri = (p: string) => `file://${p}`;
const rel = (p: string) => path.relative(startRoot, p).split(path.sep).join('/');

// --- fixtures -------------------------------------------------------------

const samples: Record<string, string> = {
	'case.txt': 'foo\nFoo\nx FOO Foo\n',
	'word.txt': 'concat\ncat\nCat\n(cat)\ncat-x\na cat.\ncat_\ncats\ncafés\ncafé au lait\nv2\nv 2\n',
	'edge.txt': ' -x\n-x\na-x\nb -xy\n',
	'ja.txt': '「テスト」\nテスト\ntest テスト end\nこれはテストです\nテスト結果\n',
	'dates.txt': 'released 2026-10-08\nno date here\n2025-01-02 and 2025-03-04\nv1.2.3\n',
	'combo.txt': 'Foo. bar\nfoo. bar\nFood bar\nxFoo. bar\nFOOx\n',
	'empty-lines.txt': 'abc\n\nxyz\n\nbab\n',
	'crlf.txt': 'foo\r\nbar\r\n',
	'regex-jump.txt': 'food fooo\nx foo\nfooo\n',
	'fold.txt': 'foo1\nFOO2\n',
	'dots.txt': 'foo.bar\nfooxbar\n',
	'jump.md': '# Foo heading\n\nfoo text Foo\n\n- list foo\n',
};

function buildFixture(): void {
	fs.rmSync(gateDir, { recursive: true, force: true });
	fs.mkdirSync(samplesDir, { recursive: true });
	fs.cpSync(path.join(repoRoot, 'docs'), corpusDir, { recursive: true });
	for (const [name, text] of Object.entries(samples)) fs.writeFileSync(path.join(samplesDir, name), text);
}

// --- the "before #66" oracle (requirement #55 contract ④, re-implemented) ---

/** Mirror of `search::NON_TEXT_EXTENSIONS` (src-tauri/src/search/mod.rs) = file-type.ts non-text sets. */
const NON_TEXT_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg',
	'stl', '3mf', 'obj', 'ply',
	'mp4', 'mov', 'webm', 'mkv', 'avi',
	'wav', 'mp3', 'm4a',
	'pdf',
	'tiff', 'tif', 'heic', 'zip', 'gz', 'bz2', 'xz', '7z', 'rar', 'tar', 'doc', 'docx', 'xls',
	'xlsx', 'ppt', 'pptx', 'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'class', 'jar', 'pyc',
	'woff', 'woff2', 'ttf', 'otf', 'eot', 'flac', 'ogg', 'sqlite', 'db', 'dmg', 'iso',
]);

function isTextFileName(name: string): boolean {
	const dot = name.lastIndexOf('.');
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
	return !NON_TEXT_EXTENSIONS.has(ext);
}

/**
 * The settings file the app under test reads (`settings::default_settings_path`):
 * `$XDG_CONFIG_HOME/vellis/settings.json` or `~/.config/vellis/settings.json`.
 * Read only, and read the way the app reads it (`settings::parse_settings`,
 * mirrored by `tests/e2e/settings-excludes.ts`: a missing file = the defaults;
 * a present key replaces its default entirely), so the oracle applies the same
 * "any folder / name" excludes. The defaults live in that module, not here.
 */
function readSettingsExcludes(): { file: string | null; patterns: string[]; unsupported: string[] } {
	const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
	const file = path.join(base, 'vellis', 'settings.json');
	const out = { file: fs.existsSync(file) ? file : null, patterns: [] as string[], unsupported: [] as string[] };
	const text = out.file ? fs.readFileSync(out.file, 'utf8') : null;
	for (const p of activeExcludePatterns(text)) {
		// Only the <two stars>/<segment> form is modelled (segment may use `*`); anything else is reported.
		if (/^\*\*\/[^/]+$/.test(p)) out.patterns.push(p.slice(3));
		else out.unsupported.push(p);
	}
	return out;
}

function segmentMatches(glob: string, name: string): boolean {
	const re = new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
	return re.test(name);
}

interface OracleHit {
	path: string;
	line: number;
	text: string;
	ordinal: number;
}

function countOccurrences(hay: string, needle: string): number {
	if (needle === '') return 0;
	let n = 0;
	let from = 0;
	for (;;) {
		const at = hay.indexOf(needle, from);
		if (at < 0) return n;
		n++;
		from = at + needle.length;
	}
}

const byCodePoint = (a: string, b: string) => {
	const x = Array.from(a).map((c) => c.codePointAt(0)!);
	const y = Array.from(b).map((c) => c.codePointAt(0)!);
	for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
	return x.length - y.length;
};

/** Case-insensitive substring per line, depth-first in name order, like the pre-#66 scan. */
function oracleSearch(root: string, query: string, excludeSegments: string[]): OracleHit[] {
	const hits: OracleHit[] = [];
	const needle = query.toLowerCase();
	const walk = (dir: string, relDir: string) => {
		const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name));
		for (const e of entries) {
			if (e.isSymbolicLink()) continue;
			if (e.name.endsWith('.vellis-tmp')) continue;
			if (excludeSegments.some((g) => segmentMatches(g, e.name))) continue;
			const relPath = relDir ? `${relDir}/${e.name}` : e.name;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				walk(full, relPath);
				continue;
			}
			if (!e.isFile() || !isTextFileName(e.name)) continue;
			const bytes = fs.readFileSync(full);
			if (bytes.includes(0)) continue;
			let content: string;
			try {
				content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
			} catch {
				continue;
			}
			let seen = 0;
			content.split('\n').forEach((raw, i) => {
				const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
				const count = countOccurrences(line.toLowerCase(), needle);
				if (count > 0) {
					hits.push({ path: relPath, line: i + 1, text: line, ordinal: seen + 1 });
					seen += count;
				}
			});
		}
	};
	walk(root, '');
	return hits;
}

// --- driving the panel ------------------------------------------------------

async function openPanel(): Promise<void> {
	const open = await browser.execute(() => !!document.querySelector('[data-testid="find-in-folder-input"]'));
	if (open) return;
	await emitMenu('menu_find_in_folder');
	await browser.waitUntil(
		async () => browser.execute(() => !!document.querySelector('[data-testid="find-in-folder-input"]')),
		{ timeout: 10_000, timeoutMsg: 'Find in Folder panel did not open on menu_find_in_folder' },
	);
}

async function closePanel(): Promise<void> {
	await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="find-in-folder-close"]')?.click());
	await browser.waitUntil(
		async () => browser.execute(() => !document.querySelector('[data-testid="find-in-folder"]')),
		{ timeout: 5_000, timeoutMsg: 'panel did not close' },
	);
}

interface Toggles {
	matchCase: boolean;
	wholeWord: boolean;
	useRegex: boolean;
}

const TOGGLE_IDS: Record<keyof Toggles, string> = {
	matchCase: 'find-in-folder-match-case',
	wholeWord: 'find-in-folder-whole-word',
	useRegex: 'find-in-folder-use-regex',
};

async function readToggles(): Promise<Toggles> {
	return browser.execute((ids) => {
		const pressed = (id: string) =>
			document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-pressed') === 'true';
		return { matchCase: pressed(ids.matchCase), wholeWord: pressed(ids.wholeWord), useRegex: pressed(ids.useRegex) };
	}, TOGGLE_IDS);
}

async function status(): Promise<string> {
	return browser.execute(
		() => document.querySelector('[data-testid="find-in-folder-status"]')?.textContent?.trim() ?? '',
	);
}

async function searchCalls(): Promise<number> {
	return (await readCapturedIpc()).filter((c) => c.cmd === SEARCH).length;
}

/** Wait until one more `search_in_folder` was sent after `before`, answered, and the status settled. */
async function waitSettled(before: number, timeout = 60_000): Promise<CapturedIpc> {
	let last: CapturedIpc | undefined;
	await browser.waitUntil(
		async () => {
			const calls = (await readCapturedIpc()).filter((c) => c.cmd === SEARCH);
			if (calls.length <= before) return false;
			last = calls[calls.length - 1]!;
			if (last.body === null) return false;
			const s = await status();
			return s !== '' && !s.startsWith('Searching');
		},
		{ timeout, timeoutMsg: `search did not settle (status "${await status()}")` },
	);
	return last!;
}

/** Click one toggle; with a word in the box it re-searches (契約9), so wait for that. */
async function clickToggle(key: keyof Toggles): Promise<{ ms: number; call: CapturedIpc | null }> {
	const hasQuery = await browser.execute(
		() => (document.querySelector<HTMLInputElement>('[data-testid="find-in-folder-input"]')?.value ?? '') !== '',
	);
	const before = await searchCalls();
	const t0 = Date.now();
	await browser.execute((id) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click(), TOGGLE_IDS[key]);
	if (!hasQuery) {
		await browser.pause(400);
		return { ms: Date.now() - t0, call: null };
	}
	const call = await waitSettled(before);
	return { ms: Date.now() - t0, call };
}

async function setToggles(want: Toggles): Promise<void> {
	for (const key of Object.keys(TOGGLE_IDS) as (keyof Toggles)[]) {
		if ((await readToggles())[key] !== want[key]) await clickToggle(key);
	}
}

interface UiRow {
	path: string;
	line: number;
	text: string;
}

async function uiRows(): Promise<UiRow[]> {
	return browser.execute(() =>
		Array.from(document.querySelectorAll<HTMLElement>('[data-testid="find-in-folder-hit"]')).map((b) => ({
			path: b.dataset.path ?? '',
			line: Number(b.dataset.line),
			text: b.querySelector('[data-testid="find-in-folder-hit-text"]')?.textContent ?? '',
		})),
	);
}

interface IpcHit {
	path: string;
	line: number;
	text: string;
	ordinal: number;
	matched?: string;
}

interface SearchOutcome {
	status: string;
	total: number;
	files: number;
	/** Every hit the panel received for the settled generation (first page + Show more pages). */
	hits: IpcHit[];
	/** `search_in_folder` reject value, when it was rejected. */
	error: unknown;
	args: Record<string, unknown>;
	rows: UiRow[];
}

/**
 * Type `query` into the box, wait for the search to settle, and (when
 * `showAll`) press Show more until every hit is listed (otherwise the first
 * page = 200 hits, enough for the `0-samples` files which scan first). Hits are read from
 * the captured IPC responses (which carry `ordinal` / `matched`), rows from
 * the DOM.
 */
async function search(query: string, showAll = false): Promise<SearchOutcome> {
	const before = await searchCalls();
	await browser.execute((q) => {
		const input = document.querySelector<HTMLInputElement>('[data-testid="find-in-folder-input"]')!;
		input.value = q;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}, query);
	if (query === '') {
		// An empty word sends nothing (契約2): the panel just clears.
		await browser.pause(400);
		return { status: await status(), total: 0, files: 0, hits: [], error: null, args: {}, rows: await uiRows() };
	}
	const call = await waitSettled(before);
	const args = call.args as Record<string, unknown>;
	if (!call.ok) {
		return { status: await status(), total: 0, files: 0, hits: [], error: call.body, args, rows: await uiRows() };
	}
	const body = call.body as { generation: number; total: number; files: number; hits: IpcHit[] };
	const hits = [...body.hits];
	if (showAll) {
		for (;;) {
			// Count the pages before the click: the click issues the page request synchronously.
			const pagesBefore = (await readCapturedIpc()).filter((c) => c.cmd === PAGE).length;
			const more = await browser.execute(() => {
				const b = document.querySelector<HTMLButtonElement>('[data-testid="find-in-folder-show-more"]');
				if (!b) return false;
				b.click();
				return true;
			});
			if (!more) break;
			try {
				await browser.waitUntil(
					async () => {
						const pages = (await readCapturedIpc()).filter((c) => c.cmd === PAGE);
						return pages.length > pagesBefore && pages[pages.length - 1]!.body !== null;
					},
					{ timeout: 15_000 },
				);
			} catch (e) {
				const rec = await readGateRecord();
				const pages = (await readCapturedIpc()).filter((c) => c.cmd === PAGE);
				throw new Error(
					`Show more page did not arrive for "${query}" (pagesBefore=${pagesBefore}, pages=${pages.length}, last=${JSON.stringify(pages[pages.length - 1] ?? null).slice(0, 300)}, ipcTail=${JSON.stringify(rec.ipc.slice(-8))}): ${String(e)}`,
				);
			}
			const pages = (await readCapturedIpc()).filter((c) => c.cmd === PAGE);
			const page = pages[pages.length - 1]!.body as { generation: number; hits: IpcHit[] };
			if (page.generation !== body.generation || page.hits.length === 0) break;
			hits.push(...page.hits);
			await browser.pause(100);
		}
	}
	return { status: await status(), total: body.total, files: body.files, hits, error: null, args, rows: await uiRows() };
}

function inSamples(hits: { path: string; line: number }[]): string[] {
	return hits.filter((h) => h.path.startsWith('req66-gate/0-samples/')).map((h) => `${path.basename(h.path)}:${h.line}`);
}

async function queryRowRect(): Promise<{ x: number; y: number; width: number; height: number }> {
	return browser.execute(() => {
		const r = document.querySelector('.find-in-folder')!.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 140) };
	});
}

interface FindState {
	open: boolean;
	input: string;
	count: string;
	currentText: string | null;
	/** Character offset of the current highlight's start within the body text. */
	currentOffset: number | null;
	/** The text line (split on \n) of the body that contains the current highlight. */
	currentLine: string | null;
	highlights: number;
	bodyText: string;
}

async function findState(): Promise<FindState> {
	return browser.execute((body) => {
		const container = document.querySelector<HTMLElement>(body);
		const input = document.querySelector<HTMLInputElement>('[data-testid="find-input"]');
		const h = (globalThis as unknown as { CSS: { highlights?: Map<string, Iterable<Range>> } }).CSS.highlights;
		const current = h?.get('vellis-find-current');
		const all = h?.get('vellis-find');
		let currentText: string | null = null;
		let currentOffset: number | null = null;
		let currentLine: string | null = null;
		const text = container?.textContent ?? '';
		if (current && container) {
			for (const r of current) {
				currentText = r.toString();
				const pre = document.createRange();
				pre.selectNodeContents(container);
				pre.setEnd(r.startContainer, r.startOffset);
				currentOffset = pre.toString().length;
				const lineStart = text.lastIndexOf('\n', currentOffset - 1) + 1;
				const lineEnd = text.indexOf('\n', currentOffset);
				currentLine = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
				break;
			}
		}
		return {
			open: !!input,
			input: input?.value ?? '',
			count: document.querySelector('[data-testid="find-count"]')?.textContent ?? '',
			currentText,
			currentOffset,
			currentLine,
			highlights: all ? Array.from(all).length : -1,
			bodyText: text,
		};
	}, BODY);
}

/** Click the result row for `file:line` and wait until the find bar shows `word` as match `n`. */
async function clickHit(file: string, line: number, word: string, n: number): Promise<FindState> {
	const ok = await browser.execute(
		(p, l) => {
			const b = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="find-in-folder-hit"]')).find(
				(x) => x.dataset.path === p && Number(x.dataset.line) === l,
			);
			if (!b) return false;
			b.click();
			return true;
		},
		rel(path.join(samplesDir, file)),
		line,
	);
	if (!ok) throw new Error(`no result row for ${file}:${line}`);
	await browser.waitUntil(
		async () => {
			const s = await findState();
			return s.open && s.input.toLowerCase() === word.toLowerCase() && s.count.startsWith(`${n} of `) && s.currentText !== null;
		},
		{ timeout: 15_000, timeoutMsg: `find bar did not show "${word}" as match ${n} after clicking ${file}:${line} (now: ${JSON.stringify(await findState())})` },
	);
	// The 番目合わせ effect runs after the ranges exist; give it a frame.
	await browser.pause(300);
	return findState();
}

/** 1-based index of the case-insensitive occurrence of `word` that starts at `offset` in `text`. */
function occurrenceAt(text: string, word: string, offset: number): number {
	const hay = text.toLowerCase();
	const needle = word.toLowerCase();
	let n = 0;
	let from = 0;
	for (;;) {
		const at = hay.indexOf(needle, from);
		if (at < 0 || at > offset) return -1;
		n++;
		if (at === offset) return n;
		from = at + needle.length;
	}
}

// --- the spec ------------------------------------------------------------------

describe('Requirement #66 human gates 2-4 (Aa / ab / .* in Find in Folder) + records for 1 and 5', () => {
	const settings = readSettingsExcludes();

	before(async () => {
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await setIpcCapture([SEARCH, PAGE]);
		await browser.setTimeout({ script: 120_000 });
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		buildFixture();
		await waitForExplorerRow(uri(gateDir), { timeout: 30_000, nudgeDir: startRoot, nudgePrefix: 'req66' });
		report(REPORT, {
			gate: '66-setup',
			corpusFiles: fs.readdirSync(corpusDir, { recursive: true }).length,
			settingsFile: settings.file,
			excludeSegments: settings.patterns,
			unsupportedPatterns: settings.unsupported,
			startRootEntries: fs.readdirSync(startRoot),
		});
	});

	after(async () => {
		await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="find-close"]')?.click());
		await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="find-in-folder-close"]')?.click());
		await setIpcCapture([]);
		await restoreGateRecorder();
		fs.rmSync(gateDir, { recursive: true, force: true });
		for (const name of fs.readdirSync(startRoot)) {
			if (name.startsWith('req66-nudge-')) fs.rmSync(path.join(startRoot, name), { force: true });
		}
	});

	it('gate 1: the three toggles sit inside the right end of the search box, OFF by default, with Cursor’s tooltips (screenshots)', async () => {
		await openPanel();
		const info = await browser.execute((ids) => {
			const box = (el: Element | null) => {
				const r = el!.getBoundingClientRect();
				return { x: r.x, y: r.y, width: r.width, height: r.height };
			};
			const input = document.querySelector('[data-testid="find-in-folder-input"]')!;
			const row = document.querySelector('.find-in-folder-query-row')!;
			const order = Array.from(row.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid'));
			const toggles = [ids.matchCase, ids.wholeWord, ids.useRegex].map((id) => {
				const b = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
				const cs = getComputedStyle(b);
				return {
					id,
					tag: b.tagName,
					type: b.getAttribute('type'),
					text: b.textContent?.trim(),
					title: b.title,
					ariaLabel: b.getAttribute('aria-label'),
					pressed: b.getAttribute('aria-pressed'),
					rect: box(b),
					fontSize: cs.fontSize,
					color: cs.color,
					background: cs.backgroundColor,
					border: cs.borderColor,
				};
			});
			const gear = document.querySelector<HTMLElement>('[data-testid="find-in-folder-use-exclude-settings"]');
			return {
				input: box(input),
				inputPaddingRight: getComputedStyle(input).paddingRight,
				order,
				toggles,
				gear: gear ? box(gear) : null,
				details: document.querySelector<HTMLElement>('[data-testid="find-in-folder-toggle-details"]')!.getAttribute('aria-expanded'),
			};
		}, TOGGLE_IDS);
		report(REPORT, { gate: '66-1-layout', ...info });
		expect(info.order).toEqual([
			'find-in-folder-input',
			'find-in-folder-match-case',
			'find-in-folder-whole-word',
			'find-in-folder-use-regex',
			'find-in-folder-toggle-details',
		]);
		for (const t of info.toggles) {
			expect(t.tag).toBe('BUTTON');
			expect(t.pressed).toBe('false');
			// inside the input's box, hugging its right end
			expect(t.rect.x).toBeGreaterThanOrEqual(info.input.x);
			expect(t.rect.x + t.rect.width).toBeLessThanOrEqual(info.input.x + info.input.width + 0.5);
			expect(t.rect.y).toBeGreaterThanOrEqual(info.input.y - 0.5);
			expect(t.rect.y + t.rect.height).toBeLessThanOrEqual(info.input.y + info.input.height + 0.5);
			// 契約1 says "about the gear's 20px"; the actual box is recorded (see sizeVsGear below).
			expect(Math.round(t.rect.width)).toBeGreaterThanOrEqual(20);
			expect(Math.round(t.rect.width)).toBeLessThanOrEqual(22);
			expect(Math.round(t.rect.height)).toBeGreaterThanOrEqual(20);
			expect(Math.round(t.rect.height)).toBeLessThanOrEqual(22);
		}
		report(REPORT, {
			gate: '66-1-size-vs-gear',
			toggle: info.toggles.map((t) => [t.id, t.rect.width, t.rect.height, t.fontSize]),
			gear: info.gear,
			note: 'the .find-in-folder-match-toggle 20px/11px rule is declared after .find-in-folder-icon-button 22px/12px (same specificity) and takes effect (req-66 追補a 契約4)',
		});
		expect(info.toggles.map((t) => t.text)).toEqual(['Aa', 'ab', '.*']);
		expect(info.toggles.map((t) => t.title)).toEqual(['Match Case', 'Match Whole Word', 'Use Regular Expression']);
		expect(info.toggles.map((t) => t.ariaLabel)).toEqual(['Match Case', 'Match Whole Word', 'Use Regular Expression']);
		const last = info.toggles[2]!;
		expect(info.input.x + info.input.width - (last.rect.x + last.rect.width)).toBeLessThan(8);
		if (info.gear) expect(Math.abs(info.gear.width - last.rect.width)).toBeLessThanOrEqual(2);

		await search('cat');
		await shot('req66-gate1-panel-all-off');
		const r = await queryRowRect();
		await zoomedShot('req66-gate1-toggles-off-crop-x4', r, 4);
		const onStyles: Record<string, unknown> = {};
		for (const key of ['matchCase', 'wholeWord', 'useRegex'] as const) {
			await clickToggle(key);
			onStyles[key] = await browser.execute((id) => {
				const b = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
				const cs = getComputedStyle(b);
				return { pressed: b.getAttribute('aria-pressed'), color: cs.color, background: cs.backgroundColor, border: cs.borderColor };
			}, TOGGLE_IDS[key]);
			await zoomedShot(`req66-gate1-${key}-on-crop-x4`, r, 4);
			await clickToggle(key);
		}
		await setToggles({ matchCase: true, wholeWord: true, useRegex: true });
		await zoomedShot('req66-gate1-all-on-crop-x4', r, 4);
		await shot('req66-gate1-panel-all-on');
		report(REPORT, { gate: '66-1-pressed-look', onStyles, allOn: await readToggles() });
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
		// No dark palette exists in the app (theme.css holds one palette, no prefers-color-scheme), so only the light look is shot.
		report(REPORT, { gate: '66-1-theme', note: 'single light palette (src/styles/theme.css); no dark variant to shoot' });
	});

	const gate2Queries = ['vellis', 'Markdown', 'search_in_folder', 'a.c', '(', '由谷', 'ssh', 'テスト', 'FOO', '要件'];
	const gate2Summary: Record<string, unknown>[] = [];
	for (const q of gate2Queries) {
		it(`gate 2: all toggles OFF = the pre-#66 rule for ${JSON.stringify(q)} (independent oracle over a copy of docs/ + samples)`, async () => {
			await openPanel();
			await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
			const MAX_FULL = 1500;
			const expected = oracleSearch(startRoot, q, settings.patterns);
			const expectedFiles = new Set(expected.map((h) => h.path)).size;
			const full = expected.length <= MAX_FULL;
			const got = await search(q, full);
			expect(got.error).toBeNull();
			expect(got.args).toMatchObject({ query: q, matchCase: false, wholeWord: false, useRegex: false });
			const strip = (h: IpcHit | OracleHit) => ({ path: h.path, line: h.line, text: h.text, ordinal: h.ordinal });
			const gotHits = got.hits.map(strip);
			const wantHits = (full ? expected : expected.slice(0, gotHits.length)).map(strip);
			const sameOrder = JSON.stringify(gotHits) === JSON.stringify(wantHits);
			const firstDiff = gotHits.findIndex((h, i) => JSON.stringify(h) !== JSON.stringify(wantHits[i]));
			// Objects come back from the webview with alphabetised keys, so compare rows by a key string.
			const rowKey = (r: UiRow) => `${r.path}\u0000${r.line}\u0000${r.text}`;
			const rowsWant = (full ? expected : expected.slice(0, got.rows.length)).map(rowKey);
			const rowsGot = got.rows.map(rowKey);
			const rowsSame = rowsGot.length === rowsWant.length && rowsGot.every((r, i) => r === rowsWant[i]);
			const firstRowDiff = rowsGot.findIndex((r, i) => r !== rowsWant[i]);
			// The rows are built from the same hits; compare them to the hits too so a DOM-only difference is isolated.
			const rowsHits = gotHits.slice(0, got.rows.length).map(rowKey);
			const rowsVsHits = rowsGot.length === rowsHits.length && rowsGot.every((r, i) => r === rowsHits[i]);
			const anyMatched = got.hits.some((h) => 'matched' in h);
			const entry = {
				query: q,
				status: got.status,
				oracleTotal: expected.length,
				oracleFiles: expectedFiles,
				uiTotal: got.total,
				uiFiles: got.files,
				comparedHits: gotHits.length,
				fullList: full,
				sameOrderAndOrdinal: sameOrder,
				firstDiff: firstDiff < 0 ? null : { i: firstDiff, got: gotHits[firstDiff], want: wantHits[firstDiff] },
				rowsSame,
				rowsVsHits,
				firstRowDiff: firstRowDiff < 0 ? null : { i: firstRowDiff, row: got.rows[firstRowDiff], want: rowsWant[firstRowDiff], hit: gotHits[firstRowDiff] },
				rowsShown: got.rows.length,
				matchedKeyPresent: anyMatched,
			};
			gate2Summary.push(entry);
			report(REPORT, { gate: '66-2', ...entry });
			expect(got.total).toBe(expected.length);
			expect(got.files).toBe(expectedFiles);
			expect(got.status).toBe(
				expected.length === 0
					? 'No results'
					: `${expected.length} result${expected.length === 1 ? '' : 's'} in ${expectedFiles} file${expectedFiles === 1 ? '' : 's'}`,
			);
			expect(sameOrder).toBe(true);
			expect(anyMatched).toBe(false);
			if (q === 'vellis') await shot('req66-gate2-all-off-vellis');
			expect(rowsSame).toBe(true);
		});
	}

	it('gate 2: summary', () => {
		report(REPORT, { gate: '66-2-summary', queries: gate2Summary.map((s) => `${s.query}=${s.uiTotal}/${s.uiFiles}`) });
		expect(gate2Summary.length).toBe(gate2Queries.length);
	});

	it('gate 3: Aa / ab / .* each change the hits as the contract says (samples)', async () => {
		await openPanel();
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
		const records: Record<string, unknown> = {};

		// Aa
		let r = await search('Foo');
		records.caseOff = inSamples(r.hits.filter((h) => h.path.endsWith('case.txt')));
		await clickToggle('matchCase');
		r = await search('Foo');
		records.caseOn = inSamples(r.hits.filter((h) => h.path.endsWith('case.txt')));
		expect(records.caseOff).toEqual(['case.txt:1', 'case.txt:2', 'case.txt:3']);
		expect(records.caseOn).toEqual(['case.txt:2', 'case.txt:3']);
		expect(r.hits.filter((h) => h.path.endsWith('case.txt')).map((h) => h.ordinal)).toEqual([2, 4]);
		await clickToggle('matchCase');

		// ab (incl. `_` as a word char, Unicode, `v 2`)
		r = await search('cat');
		records.wordOff = inSamples(r.hits.filter((h) => h.path.endsWith('word.txt')));
		await clickToggle('wholeWord');
		r = await search('cat');
		records.wordOn = inSamples(r.hits.filter((h) => h.path.endsWith('word.txt')));
		expect(records.wordOff).toEqual(['word.txt:1', 'word.txt:2', 'word.txt:3', 'word.txt:4', 'word.txt:5', 'word.txt:6', 'word.txt:7', 'word.txt:8']);
		expect(records.wordOn).toEqual(['word.txt:2', 'word.txt:3', 'word.txt:4', 'word.txt:5', 'word.txt:6']);
		expect(r.hits.filter((h) => h.path.endsWith('word.txt')).map((h) => h.ordinal)).toEqual([2, 3, 4, 5, 6]);
		r = await search('café');
		records.cafeWordOn = inSamples(r.hits.filter((h) => h.path.endsWith('word.txt')));
		expect(records.cafeWordOn).toEqual(['word.txt:10']);
		r = await search('v');
		records.vWordOn = inSamples(r.hits.filter((h) => h.path.endsWith('word.txt')));
		expect(records.vWordOn).toEqual(['word.txt:12']);
		await clickToggle('matchCase');
		r = await search('cat');
		records.wordOnCaseOn = inSamples(r.hits.filter((h) => h.path.endsWith('word.txt')));
		expect(records.wordOnCaseOn).toEqual(['word.txt:2', 'word.txt:4', 'word.txt:5', 'word.txt:6']);
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });

		// .* (incl. `matched`, case folding, CRLF `$`)
		r = await search('\\d{4}-\\d{2}');
		records.regexOffLiteral = { status: r.status, samples: inSamples(r.hits) };
		expect(r.hits.filter((h) => h.path.endsWith('dates.txt'))).toEqual([]);
		await clickToggle('useRegex');
		r = await search('\\d{4}-\\d{2}');
		const dates = r.hits.filter((h) => h.path.endsWith('dates.txt'));
		records.regexOn = { status: r.status, dates: dates.map((h) => [h.line, h.matched, h.ordinal]) };
		expect(dates.map((h) => [h.line, h.matched, h.ordinal])).toEqual([[1, '2026-10', 1], [3, '2025-01', 1]]);
		r = await search('FOO\\d');
		records.regexFoldOff = inSamples(r.hits.filter((h) => h.path.endsWith('fold.txt')));
		expect(records.regexFoldOff).toEqual(['fold.txt:1', 'fold.txt:2']);
		await clickToggle('matchCase');
		r = await search('FOO\\d');
		records.regexFoldOn = inSamples(r.hits.filter((h) => h.path.endsWith('fold.txt')));
		expect(records.regexFoldOn).toEqual(['fold.txt:2']);
		await clickToggle('matchCase');
		r = await search('foo$');
		const crlf = r.hits.filter((h) => h.path.endsWith('crlf.txt'));
		records.crlfDollar = crlf.map((h) => [h.line, JSON.stringify(h.text), h.matched]);
		expect(crlf.map((h) => [h.line, h.text, h.matched])).toEqual([[1, 'foo', 'foo']]);
		await clickToggle('wholeWord');
		r = await search('fo+');
		const fo = r.hits.filter((h) => h.path.endsWith('regex-jump.txt'));
		records.regexWholeWord = fo.map((h) => [h.line, h.matched, h.ordinal]);
		// `food fooo`: ab rejects `foo` inside food and takes `fooo` (ordinal 1 for J=fooo); `x foo` → J=foo,
		// 2 occurrences above → 3; `fooo` → J=fooo, 1 above → 2 (契約6 counts the handed-over word).
		expect(fo.map((h) => [h.line, h.matched, h.ordinal])).toEqual([[1, 'fooo', 1], [2, 'foo', 3], [3, 'fooo', 2]]);
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
		report(REPORT, { gate: '66-3-toggles', ...records });
	});

	it('gate 3: the 8 combinations on `Foo.` give the AC-66-6 table', async () => {
		await openPanel();
		const table: Record<string, number[]> = {};
		const want: Record<string, number[]> = {
			'off-off-off': [1, 2, 4],
			'on-off-off': [1, 4],
			'off-on-off': [1, 2],
			'on-on-off': [1],
			'off-off-on': [1, 2, 3, 4, 5],
			'on-off-on': [1, 3, 4],
			'off-on-on': [1, 2, 3, 5],
			'on-on-on': [1, 3],
		};
		for (const useRegex of [false, true]) {
			for (const wholeWord of [false, true]) {
				for (const matchCase of [false, true]) {
					await setToggles({ matchCase, wholeWord, useRegex });
					const r = await search('Foo.');
					const key = `${matchCase ? 'on' : 'off'}-${wholeWord ? 'on' : 'off'}-${useRegex ? 'on' : 'off'}`;
					table[key] = r.hits.filter((h) => h.path.endsWith('combo.txt')).map((h) => h.line);
					expect(r.args).toMatchObject({ matchCase, wholeWord, useRegex });
				}
			}
		}
		report(REPORT, { gate: '66-3-combinations', table });
		expect(table).toEqual(want);
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
	});

	it('gate 3: pressing a toggle re-searches at once; the state survives Close + reopen and is in no web storage', async () => {
		await openPanel();
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
		const base = await search('cat');
		const beforeStatus = base.status;
		const t = await clickToggle('wholeWord');
		expect(t.call).not.toBeNull();
		expect(t.call!.args).toMatchObject({ query: 'cat', wholeWord: true });
		const afterStatus = await status();
		const typedAgain = await browser.execute(
			() => document.querySelector<HTMLInputElement>('[data-testid="find-in-folder-input"]')?.value,
		);
		expect(typedAgain).toBe('cat');
		expect(afterStatus).not.toBe(beforeStatus);
		report(REPORT, { gate: '66-3-rescope', beforeStatus, afterStatus, msUntilSettled: t.ms, generation: (t.call!.args as { generation: number }).generation });

		// Empty box: a press changes the state but sends nothing.
		await search('');
		const calls0 = await searchCalls();
		const empty = await clickToggle('matchCase');
		expect(empty.call).toBeNull();
		expect(await searchCalls()).toBe(calls0);
		expect(await readToggles()).toEqual({ matchCase: true, wholeWord: true, useRegex: false });
		const later = await search('cat');
		expect(later.args).toMatchObject({ matchCase: true, wholeWord: true, useRegex: false });

		// Close + reopen keeps Aa and ab, and the next search carries them.
		await setToggles({ matchCase: true, wholeWord: false, useRegex: true });
		await closePanel();
		await openPanel();
		const kept = await readToggles();
		expect(kept).toEqual({ matchCase: true, wholeWord: false, useRegex: true });
		const again = await search('fo+');
		expect(again.args).toMatchObject({ matchCase: true, wholeWord: false, useRegex: true });
		const storage = await browser.execute(() => {
			const dump = (s: Storage) => {
				const out: Record<string, string | null> = {};
				try {
					for (let i = 0; i < s.length; i++) {
						const k = s.key(i)!;
						out[k] = s.getItem(k);
					}
				} catch {
					// unavailable
				}
				return out;
			};
			return { local: dump(localStorage), session: dump(sessionStorage) };
		});
		const flat = JSON.stringify(storage).toLowerCase();
		report(REPORT, { gate: '66-3-persist', kept, storageKeys: { local: Object.keys(storage.local), session: Object.keys(storage.session) } });
		expect(flat.includes('matchcase') || flat.includes('wholeword') || flat.includes('useregex')).toBe(false);
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
	});

	it('gate 4: clicking a result makes the clicked match the current match of the in-document find (Aa / ab / .*)', async () => {
		await openPanel();
		const records: Record<string, unknown> = {};
		const check = (s: FindState, word: string, ordinal: number, line: string) => {
			expect(s.input.toLowerCase()).toBe(word.toLowerCase());
			const m = /^(\d+) of (\d+)$/.exec(s.count);
			expect(m).not.toBeNull();
			expect(Number(m![1])).toBe(ordinal);
			expect(s.currentText!.toLowerCase()).toBe(word.toLowerCase());
			expect(s.currentLine).toBe(line);
			expect(occurrenceAt(s.bodyText, word, s.currentOffset!)).toBe(ordinal);
			return { input: s.input, count: s.count, currentText: s.currentText, currentLine: s.currentLine, offset: s.currentOffset, totalHighlights: s.highlights };
		};

		// Aa ON, `Foo`: line 3 of case.txt = ordinal 4 (foo / Foo / FOO / Foo), m = 4 since #54 ignores case.
		await setToggles({ matchCase: true, wholeWord: false, useRegex: false });
		let r = await search('Foo');
		const caseHit = r.hits.find((h) => h.path.endsWith('case.txt') && h.line === 3)!;
		let s = await clickHit('case.txt', 3, 'Foo', caseHit.ordinal);
		records.matchCase = { hitOrdinal: caseHit.ordinal, ...check(s, 'Foo', caseHit.ordinal, 'x FOO Foo') };
		expect(s.count).toBe('4 of 4');
		await shot('req66-gate4-click-matchcase');
		// Clicking line 2 of the same document jumps without reopening (追補b-2).
		s = await clickHit('case.txt', 2, 'Foo', 2);
		records.matchCaseSameDoc = check(s, 'Foo', 2, 'Foo');

		// ab ON, `cat`: line 2 of word.txt = ordinal 2 (concat counts), m = 8.
		await setToggles({ matchCase: false, wholeWord: true, useRegex: false });
		r = await search('cat');
		const wordHit = r.hits.find((h) => h.path.endsWith('word.txt') && h.line === 2)!;
		s = await clickHit('word.txt', 2, 'cat', wordHit.ordinal);
		records.wholeWord = { hitOrdinal: wordHit.ordinal, ...check(s, 'cat', wordHit.ordinal, 'cat') };
		expect(s.count).toBe('2 of 8');
		await shot('req66-gate4-click-wholeword');

		// .* ON, `fo+`: line 2 of regex-jump.txt → the matched text `foo` is handed over, ordinal 3 of 4.
		await setToggles({ matchCase: false, wholeWord: false, useRegex: true });
		r = await search('fo+');
		const reHit = r.hits.find((h) => h.path.endsWith('regex-jump.txt') && h.line === 2)!;
		expect(reHit.matched).toBe('foo');
		s = await clickHit('regex-jump.txt', 2, 'foo', reHit.ordinal);
		records.regex = { hitOrdinal: reHit.ordinal, matched: reHit.matched, ...check(s, 'foo', reHit.ordinal, 'x foo') };
		expect(s.count).toBe('3 of 4');
		await shot('req66-gate4-click-regex');
		// `\d{4}-\d{2}` on dates.txt line 3 → `2025-01`.
		r = await search('\\d{4}-\\d{2}');
		const dateHit = r.hits.find((h) => h.path.endsWith('dates.txt') && h.line === 3)!;
		s = await clickHit('dates.txt', 3, dateHit.matched!, dateHit.ordinal);
		records.regexDate = { matched: dateHit.matched, hitOrdinal: dateHit.ordinal, ...check(s, dateHit.matched!, dateHit.ordinal, '2025-01-02 and 2025-03-04') };

		// A Markdown file: the rendered text drops the `#`, the ordinal still lands (recorded for gate 5).
		await setToggles({ matchCase: true, wholeWord: false, useRegex: false });
		r = await search('Foo');
		const mdHit = r.hits.find((h) => h.path.endsWith('jump.md') && h.line === 3)!;
		s = await clickHit('jump.md', 3, 'Foo', mdHit.ordinal);
		records.markdown = { hitOrdinal: mdHit.ordinal, input: s.input, count: s.count, currentText: s.currentText, currentLine: s.currentLine, offset: s.currentOffset, note: 'rendered text; headings lose `#`, so the ordinal may drift on other files (req-66 契約6)' };
		expect(Number(/^(\d+) of/.exec(s.count)?.[1])).toBe(mdHit.ordinal);
		expect(s.currentText).toBe('Foo');
		report(REPORT, { gate: '66-4', ...records, dialogs: (await readGateRecord()).dialogs });
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
		await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="find-close"]')?.click());
	});

	const gate5: Record<string, unknown> = {};

	it('gate 5 records: zero-length matches are not matches (`^$` cannot find empty lines)', async () => {
		await openPanel();
		const records = gate5;

		// Zero-length matches are not matches: `^$` cannot find empty lines.
		await setToggles({ matchCase: false, wholeWord: false, useRegex: true });
		let empties = 0;
		for (const f of fs.readdirSync(samplesDir)) {
			const t = fs.readFileSync(path.join(samplesDir, f), 'utf8');
			empties += t.split('\n').filter((l) => l.replace(/\r$/, '') === '').length;
		}
		const zero: Record<string, unknown> = {};
		for (const q of ['^$', '^', '$', '\\b']) {
			const r = await search(q);
			zero[q] = { status: r.status, total: r.total };
			expect(r.status).toBe('No results');
		}
		let r = await search('a*');
		zero['a*'] = { status: r.status, samples: inSamples(r.hits.filter((h) => h.path.endsWith('empty-lines.txt'))) };
		expect(zero['a*']).toMatchObject({ samples: ['empty-lines.txt:1', 'empty-lines.txt:5'] });
		r = await search('x?');
		zero['x?'] = inSamples(r.hits.filter((h) => h.path.endsWith('empty-lines.txt')));
		expect(zero['x?']).toEqual(['empty-lines.txt:3']);
		records.zeroLength = { emptyLinesInSamples: empties, ...zero };
		await shot('req66-gate5-caret-dollar-no-results');
	});

	it('gate 5 records: broken expressions show `Invalid regular expression` and `(` is a literal with .* OFF', async () => {
		await openPanel();
		const records = gate5;
		await setToggles({ matchCase: false, wholeWord: false, useRegex: true });
		// Broken expressions: the fixed message, aria-invalid, red border, no rows; the IPC reject value.
		const broken: Record<string, unknown> = {};
		let r: SearchOutcome;
		for (const q of ['(', '[a-', 'a{2,1}', '\\', '(?<x']) {
			r = await search(q);
			const ui = await browser.execute(() => {
				const input = document.querySelector<HTMLInputElement>('[data-testid="find-in-folder-input"]')!;
				return { ariaInvalid: input.getAttribute('aria-invalid'), border: getComputedStyle(input).borderColor, rows: document.querySelectorAll('[data-testid="find-in-folder-hit"]').length };
			});
			broken[q] = { status: r.status, reject: r.error, ...ui };
			expect(r.status).toBe(INVALID);
			expect(r.error).toBe(INVALID);
			expect(ui.ariaInvalid).toBe('true');
			expect(ui.rows).toBe(0);
			if (q === '(') {
				await shot('req66-gate1-invalid-regex');
				await zoomedShot('req66-gate1-invalid-regex-crop-x4', await queryRowRect(), 4);
			}
		}
		// Fixing the word clears it; `(` with .* OFF is a literal.
		r = await search('cat');
		const cleared = await browser.execute(() => document.querySelector('[data-testid="find-in-folder-input"]')!.getAttribute('aria-invalid'));
		expect(cleared).toBeNull();
		expect(r.status).not.toBe(INVALID);
		await clickToggle('useRegex');
		r = await search('(');
		const literal = { status: r.status, samples: inSamples(r.hits.filter((h) => h.path.endsWith('word.txt'))) };
		expect(literal.samples).toEqual(['word.txt:4']);
		records.broken = { ...broken, clearedAriaInvalid: cleared, literalParenWithRegexOff: literal };
	});

	it('gate 5 records: ab on symbol-edged words and Japanese; no keyboard shortcuts', async () => {
		await openPanel();
		const records = gate5;
		// ab with symbol-edged words: one-sided boundaries (ripgrep -w), not `\b`.
		await setToggles({ matchCase: false, wholeWord: true, useRegex: false });
		let r = await search('-x');
		const edge = inSamples(r.hits.filter((h) => h.path.endsWith('edge.txt')));
		expect(edge).toEqual(['edge.txt:1', 'edge.txt:2']);
		r = await search('foo.bar');
		const dots = inSamples(r.hits.filter((h) => h.path.endsWith('dots.txt')));
		expect(dots).toEqual(['dots.txt:1']);
		records.wholeWordEdges = { '-x': edge, 'foo.bar (dot stays literal with .* OFF)': dots };

		// Japanese: kana / kanji are word characters, so ab only matches at punctuation / space / line ends.
		r = await search('テスト');
		const jaOn = inSamples(r.hits.filter((h) => h.path.endsWith('ja.txt')));
		await clickToggle('wholeWord');
		r = await search('テスト');
		const jaOff = inSamples(r.hits.filter((h) => h.path.endsWith('ja.txt')));
		expect(jaOn).toEqual(['ja.txt:1', 'ja.txt:2', 'ja.txt:3']);
		expect(jaOff).toEqual(['ja.txt:1', 'ja.txt:2', 'ja.txt:3', 'ja.txt:4', 'ja.txt:5']);
		records.japanese = { wholeWordOn: jaOn, wholeWordOff: jaOff };

		// No keyboard shortcuts: Option + Command + C / W / R do not flip the toggles or send a search.
		await setToggles({ matchCase: false, wholeWord: false, useRegex: false });
		await search('cat');
		const calls = await searchCalls();
		await browser.execute(() => {
			const input = document.querySelector<HTMLInputElement>('[data-testid="find-in-folder-input"]')!;
			for (const [key, code] of [['c', 'KeyC'], ['w', 'KeyW'], ['r', 'KeyR']] as const) {
				for (const target of [input, document.body]) {
					target.dispatchEvent(new KeyboardEvent('keydown', { key, code, altKey: true, metaKey: true, bubbles: true, cancelable: true }));
					target.dispatchEvent(new KeyboardEvent('keyup', { key, code, altKey: true, metaKey: true, bubbles: true, cancelable: true }));
				}
			}
		});
		await browser.pause(600);
		const afterKeys = await readToggles();
		expect(afterKeys).toEqual({ matchCase: false, wholeWord: false, useRegex: false });
		expect(await searchCalls()).toBe(calls);
		records.shortcuts = { afterOptionCommandCWR: afterKeys, extraSearches: (await searchCalls()) - calls };

		report(REPORT, { gate: '66-5', ...records });
	});

	it('gate 3 (last): a fresh page = a fresh module instance (same as a new window) starts with all toggles OFF', async () => {
		await openPanel();
		await setToggles({ matchCase: true, wholeWord: true, useRegex: true });
		expect(await readToggles()).toEqual({ matchCase: true, wholeWord: true, useRegex: true });
		await browser.execute(() => location.reload());
		await browser.pause(1_000);
		await waitForAppMounted();
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer did not come back after reload' },
		);
		await installGateRecorder();
		await setIpcCapture([SEARCH, PAGE]);
		await openPanel();
		const fresh = await readToggles();
		report(REPORT, { gate: '66-3-fresh-page', toggles: fresh, note: 'location.reload() = new JS module instance, same as a new window (webdriver cannot enter a second window)' });
		expect(fresh).toEqual({ matchCase: false, wholeWord: false, useRegex: false });
	});
});
