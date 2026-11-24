import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	faceDirty,
	appendToFace,
	assertIpcInterceptionWorks,
	clickExplorerRow,
	contrastRatio,
	emitMenu,
	installGateRecorder,
	pointAtRegion,
	readGateRecord,
	report,
	restoreGateRecorder,
	restoreZoomStorage,
	shot,
	snapshotZoomStorage,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 要件74 第2段 2-5(2026-11-17・撤去)の後: a code file is a CodeMirror face from the moment it opens
 * (契約5: the colours come from Lezer, not Shiki; Shiki is kept for printing only = AC-74-39). Edit ▸ Edit
 * and the plain-text editor are gone. The gates below read the face (`[data-testid="code-editor"] .cm-content`,
 * tokens = `.cm-line span[class]`), the fences of fences.md are embedded CodeMirror faces too (2-4), and the
 * Shiki size limits of 契約6 no longer apply (recorded, not judged). Not run on a device since the rewrite.
 *
 * Requirement #69 human gates 1-4, driven on the webdriver build
 * (docs/requirements/req-69.md「人間ゲート」). Gate 5 (judgement) stays with a
 * human.
 *
 *  1. Each sample (.ts/.rs/.py/.json/.yaml/.sh) is coloured; the face's
 *     computed font-size / white-space / padding / background / line-height
 *     equal the plain (.txt) view of the same text (`tab-size` is the one
 *     property that follows the file's own indent — 要件74 契約5 — and is
 *     judged against the file, 2026-11-24); the per-character colours
 *     equal the same code in a Markdown fence.
 *  2. Double click (and the Edit menu event) enters the plain-text editor;
 *     `menu_save` saves; leaving edit mode brings the colours back with the
 *     saved text.
 *  3. Boundary files are opened and the time from the click to the rendered
 *     `<pre>` being in the DOM is measured in the WKWebView; whether the view
 *     fell back to plain is recorded. Numbers go to $VELLIS_GATE_SHOTS.
 *  4. Find gives the same count / ranges on the coloured view and on the .txt
 *     of the same text; viewer zoom scales the `<pre>` without re-rendering;
 *     the print rule (`@media print` `.markdown-body span` with
 *     `print-color-adjust: exact`) is present in the live stylesheet and, when
 *     its rules are applied to the screen, the token colours survive. Real
 *     paper / PDF output needs the native print dialog and stays with a human.
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const gateDir = path.join(startRoot, 'req69-gate');
const heavyDir = path.join(gateDir, 'heavy');
const REPORT = 'req69-report.jsonl';
const BODY = 'article.viewer .markdown-body';

const uri = (p: string) => `file://${p}`;

const samples: Record<string, { file: string; fence: string; lang: string; code: string }> = {
	ts: {
		file: 'sample.ts',
		fence: 'ts',
		lang: 'typescript',
		code: `import { readFile } from 'node:fs/promises';

/** A typed record. */
export interface Item {
	id: number;
	name: string;
	tags?: string[];
}

export async function load(path: string): Promise<Item[]> {
	const text = await readFile(path, 'utf8');
	const value = JSON.parse(text) as Item[];
	return value.filter((item) => item.id > 0 && item.name !== '');
}

const total = [1, 2, 3].reduce((a, b) => a + b, 0); // 6
export default { load, total, value: \`total=\${total}\` };
`,
	},
	rs: {
		file: 'sample.rs',
		fence: 'rust',
		lang: 'rust',
		code: `use std::collections::HashMap;

/// Count words.
pub fn count(text: &str) -> HashMap<&str, usize> {
    let mut value = HashMap::new();
    for word in text.split_whitespace() {
        *value.entry(word).or_insert(0) += 1;
    }
    value
}

#[derive(Debug, Clone)]
struct Point { x: f64, y: f64 }

fn main() {
    let p = Point { x: 1.0, y: -2.5 };
    println!("{:?} {}", p, count("a b a").len());
}
`,
	},
	py: {
		file: 'sample.py',
		fence: 'python',
		lang: 'python',
		code: `from dataclasses import dataclass


@dataclass
class Item:
    id: int
    name: str = "untitled"


def load(rows: list[dict]) -> list[Item]:
    """Build items, skipping the bad ones."""
    value = [Item(**r) for r in rows if r.get("id", 0) > 0]
    return sorted(value, key=lambda i: i.name)


if __name__ == "__main__":
    print(load([{"id": 1, "name": "b"}, {"id": 2}]))  # two items
`,
	},
	json: {
		file: 'sample.json',
		fence: 'json',
		lang: 'json',
		code: `{
  "name": "vellis",
  "version": "0.5.1",
  "private": true,
  "value": 42,
  "ratio": 0.75,
  "tags": ["viewer", "markdown", null],
  "nested": { "enabled": false, "items": [1, 2, 3] }
}
`,
	},
	yaml: {
		file: 'sample.yaml',
		fence: 'yaml',
		lang: 'yaml',
		code: `# CI settings
name: build
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: macos-latest
    env:
      value: 42
      enabled: true
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test && pnpm check
`,
	},
	sh: {
		file: 'sample.sh',
		fence: 'sh',
		lang: 'shellscript',
		code: `#!/usr/bin/env bash
set -euo pipefail

value="\${1:-default}"
for f in *.md; do
  if [[ -f "$f" ]]; then
    echo "found: $f ($value)" >&2
  fi
done
count=$(ls | wc -l)
exit 0
`,
	},
};

function fencedMarkdown(): string {
	let md = '# Fences\n\n';
	for (const s of Object.values(samples)) md += `\`\`\`${s.fence}\n${s.code}\`\`\`\n\n`;
	return md;
}

/** Heavy fixtures for gate 3, named after what they probe. */
function heavyFixtures(): Record<string, string> {
	const out: Record<string, string> = {};
	const tsLine = (i: number) =>
		`export const value_${i} = { id: ${i}, name: "item-${i}", tags: ["a", "b"], ok: true };\n`;
	const toLength = (n: number) => {
		let s = '';
		for (let i = 0; s.length < n - 200; i++) s += tsLine(i);
		const pad = n - s.length - '// \n'.length;
		return `${s}// ${'x'.repeat(pad)}\n`;
	};
	out['ts-262144-chars.ts'] = toLength(262_144);
	out['ts-393216-chars.ts'] = toLength(393_216);
	out['ts-524288-chars.ts'] = toLength(524_288);
	out['ts-524289-chars.ts'] = toLength(524_289);
	out['ts-524288-chars.txt'] = out['ts-524288-chars.ts'];
	let l = '';
	for (let i = 0; i < 10_000; i++) l += `const a${i} = ${i};\n`;
	out['ts-10000-lines.ts'] = l;
	out['ts-10001-lines.ts'] = `${l}const a10000 = 10000;\n`;
	let sql = '';
	for (let i = 0; sql.length < 515_000; i++) {
		sql += `INSERT INTO users (id, name, email, created_at, score) VALUES (${i}, 'user ${i}', 'user${i}@example.com', '2026-10-06 12:00:00', ${i * 1.5});\n`;
	}
	out['sql-insert-statements.sql'] = sql;
	let multi = 'INSERT INTO events (id, kind, payload, at) VALUES\n';
	for (let i = 0; i < 9_990; i++) multi += `(${i}, 'click', '{"x": ${i}, "y": ${i * 2}}', '2026-10-06T12:00:00Z'),\n`;
	multi += `(9990, 'end', '{}', '2026-10-06T12:00:00Z');\n`;
	out['sql-insert-multirow.sql'] = multi;
	const longLine = (n: number) => {
		const head = `const s${n} = "`;
		return `${head}${'y'.repeat(n - head.length - 2)}";`;
	};
	out['ts-long-lines.ts'] = [
		'const before = 1;',
		longLine(1_999),
		longLine(2_000),
		longLine(5_000),
		'const after = 2;',
		'',
	].join('\n');
	return out;
}

/** The CodeMirror face of the open code file (要件74 2-5). */
const FACE = 'article.viewer [data-testid="code-editor"]';
const FACE_CONTENT = `${FACE} .cm-content`;

/**
 * Wait until the viewer shows a *new* face (not one marked by `markCurrentPre`) whose first
 * rendered line is the file's first line (CodeMirror renders the viewport only, so the whole
 * text cannot be compared for the heavy files).
 */
async function waitForFace(text: string, timeout = 30_000): Promise<void> {
	const first = text.split('\n').find((l) => l.trim().length > 0) ?? '';
	await browser.waitUntil(
		async () =>
			browser.execute(
				(sel, line) => {
					const content = document.querySelector(`${sel}:not([data-gate-old])`);
					if (!content) return false;
					const lines = Array.from(content.querySelectorAll('.cm-line')).map((l) => l.textContent ?? '');
					return lines.length > 0 && lines.find((l) => l.trim().length > 0) === line;
				},
				FACE_CONTENT,
				first,
			),
		{ timeout, timeoutMsg: `viewer never showed a new face starting with ${JSON.stringify(first.slice(0, 60))}` },
	);
}

async function markCurrentPre(): Promise<void> {
	await browser.execute((body, sel) => {
		document.querySelectorAll(`${body} pre, ${sel}`).forEach((p) => p.setAttribute('data-gate-old', '1'));
	}, BODY, FACE_CONTENT);
}

async function openFile(p: string, text: string): Promise<void> {
	const first = text.split('\n').find((l) => l.trim().length > 0) ?? '';
	const showing = await browser.execute(
		(sel, u, line) => {
			const content = document.querySelector(sel);
			const lines = content ? Array.from(content.querySelectorAll('.cm-line')).map((l) => l.textContent ?? '') : [];
			return document.querySelector<HTMLElement>('.explorer-item.active')?.title === u && lines.find((l) => l.trim().length > 0) === line;
		},
		FACE_CONTENT,
		uri(p),
		first,
	);
	if (showing) return;
	await markCurrentPre();
	await clickExplorerRow(uri(p));
	await waitForFace(text);
}

const STYLE_PROPS = [
	'font-size',
	'font-family',
	'line-height',
	'white-space',
	'padding-top',
	'padding-right',
	'padding-bottom',
	'padding-left',
	'margin-top',
	'margin-bottom',
	'background-color',
	'border-radius',
	'tab-size',
	'overflow-wrap',
	'word-break',
];

/**
 * 要件74 契約5: the face's `tab-size` is the indent unit detected from the file (a tab = 4 columns, N spaces
 * = N; `src/editor/text-document.ts` `detectIndentUnit` → `EditorState.tabSize`), so it is not a fixed value
 * shared with the plain face any more. This mirrors that detection (tab lines vs space lines; the most
 * frequent change of indent width, the smaller on a tie; `\t` when undecidable or when spaces never indent).
 */
function expectedTabSize(code: string): string {
	const MAX_SPACE_UNIT = 8;
	let tabLines = 0;
	let spaceLines = 0;
	const steps = new Map<number, number>();
	let previous = 0;
	for (const line of code.split(/\r\n?|\n/)) {
		if (line.trim().length === 0) continue;
		const lead = /^[ \t]*/.exec(line)![0];
		if (lead.startsWith('\t')) {
			tabLines++;
			continue;
		}
		const width = lead.length;
		if (width > 0) spaceLines++;
		const step = Math.abs(width - previous);
		if (step > 0 && step <= MAX_SPACE_UNIT && (width > 0 || previous > 0)) steps.set(step, (steps.get(step) ?? 0) + 1);
		previous = width;
	}
	if (spaceLines === 0 || tabLines >= spaceLines) return '4';
	let best = 0;
	let bestCount = 0;
	for (const [step, count] of steps) {
		if (count > bestCount || (count === bestCount && step < best)) {
			best = step;
			bestCount = count;
		}
	}
	return best > 0 ? String(best) : '4';
}

/** `style` without `tab-size` (compared face to face) and `tab-size` on its own (compared with the file's indent). */
function splitTabSize(style: Record<string, string>): { rest: Record<string, string>; tabSize: string } {
	const { 'tab-size': tabSize, ...rest } = style;
	return { rest, tabSize: tabSize ?? '' };
}

/** The face's style (`.cm-content`), its language, and the Lezer token colours (`.cm-line span[class]`, computed). */
async function preStyle(): Promise<{ pre: Record<string, string>; code: Record<string, string> | null; height: number; width: number; lang: string | null; colours: number; spans: number }> {
	return browser.execute(
		(face, sel, props) => {
			const content = document.querySelector<HTMLElement>(sel)!;
			const pick = (el: Element) => {
				const cs = getComputedStyle(el);
				return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
			};
			const base = getComputedStyle(content).color;
			const colours = new Set<string>();
			let spans = 0;
			for (const sp of content.querySelectorAll<HTMLElement>('.cm-line span[class]')) {
				const c = getComputedStyle(sp).color;
				if (c && c !== base) {
					colours.add(c);
					spans++;
				}
			}
			const r = content.getBoundingClientRect();
			return {
				pre: pick(content),
				code: null,
				height: r.height,
				width: r.width,
				lang: document.querySelector(face)?.getAttribute('data-vellis-lang') ?? null,
				colours: colours.size,
				spans,
			};
		},
		FACE,
		FACE_CONTENT,
		STYLE_PROPS,
	);
}

/**
 * Wait until fences.md is the document on screen and the fence holding
 * `marker` is coloured: the body's `<h1>` reads "Fences" (fences.md's own
 * heading; a code file has none) and a `<pre>` that is not the code file's
 * own holds `marker` with at least one coloured span. The code file's `<pre>`
 * is tagged by `markCurrentPre` before the click: it holds the same text, so a
 * bare "some `<pre>` has the marker" wait is satisfied by it while the view is
 * still switching, and the measurement that follows can land on the moment
 * neither document is in the DOM (Issue #768, `fenceChars 0`).
 */
async function waitForFence(marker: string, fence: string): Promise<void> {
	await browser.waitUntil(
		async () =>
			browser.execute(
				(body, m) => {
					if ((document.querySelector(`${body} h1`)?.textContent ?? '') !== 'Fences') return false;
					// 要件74 2-4: a fence is an embedded CodeMirror (`pre[data-lang] .cm-content`); the colours are Lezer classes.
					const content = Array.from(document.querySelectorAll<HTMLElement>(`${body} pre[data-lang] .cm-content:not([data-gate-old])`)).find((c) =>
						(c.textContent ?? '').includes(m),
					);
					return !!content && content.querySelector('.cm-line span[class]') !== null;
				},
				BODY,
				marker,
			),
		{ timeout: 15_000, timeoutMsg: `fence for ${fence} not rendered as an embedded face in fences.md` },
	);
}

/**
 * Per non-whitespace character: [char, colour] for the `<pre>` that contains
 * `marker` (the file view's `<pre>` when `marker` is null). With a marker, a
 * `<pre>` tagged by `markCurrentPre` (the previous document's) is skipped.
 */
async function charColours(marker: string | null): Promise<Array<[string, string]>> {
	const pairs: string[][] = await browser.execute(
		(body, face, m) => {
			const contents = Array.from(document.querySelectorAll<HTMLElement>(m === null ? face : `${body} pre[data-lang] .cm-content`));
			const content =
				m === null ? contents[0] : contents.find((c) => !c.hasAttribute('data-gate-old') && (c.textContent ?? '').includes(m));
			if (!content) return [];
			const base = getComputedStyle(content).color;
			const out: string[][] = [];
			const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const el = n.parentElement;
				const c = el ? getComputedStyle(el).color : '';
				const colour = c === base ? '' : c;
				for (const ch of n.textContent ?? '') if (!/\s/.test(ch)) out.push([ch, colour]);
			}
			return out;
		},
		BODY,
		FACE_CONTENT,
		marker,
	);
	return pairs.map(([ch, colour]) => [ch ?? '', colour ?? '']);
}

interface Timing {
	file: string;
	chars: number;
	lines: number;
	domMs?: number;
	paintMs?: number;
	frameStalled?: boolean;
	maxTimerGapMs?: number;
	lang?: string | null;
	colouredSpans?: number;
	timeout?: boolean;
	visibility?: string;
}

/**
 * Click the row and time it, inside the page: t0 = just before the click;
 * DOM = the MutationObserver callback that first sees the new `<pre>` with the
 * full text; paint = the next animation frame after that (if none comes within
 * 2 s, paintMs is left out and frameStalled is recorded). A 10 ms interval
 * records the longest gap between its ticks — how long the page could not run
 * anything (≈ the freeze a user would feel).
 */
async function timeOpen(p: string, text: string): Promise<Timing> {
	await waitForExplorerRow(uri(p), { timeout: 15_000 });
	const res = await browser.executeAsync<Omit<Timing, 'file' | 'chars' | 'lines'>, [string, string, string]>(
		(body, target, firstLine, done) => {
			const host = document.querySelector(body);
			host?.querySelector('pre')?.setAttribute('data-gate-old', '1');
			host?.querySelector('.cm-content')?.setAttribute('data-gate-old', '1');
			const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find(
				(r) => r.title === target,
			);
			if (!host || !row) {
				done({ timeout: true });
				return;
			}
			let last = performance.now();
			let maxGap = 0;
			const timer = setInterval(() => {
				const now = performance.now();
				maxGap = Math.max(maxGap, now - last);
				last = now;
			}, 10);
			let finished = false;
			const finish = (r: Omit<Timing, 'file' | 'chars' | 'lines'>) => {
				if (finished) return;
				finished = true;
				clearInterval(timer);
				obs.disconnect();
				done(r);
			};
			const t0 = performance.now();
			const check = () => {
				// 要件74 2-5: the face renders the viewport only — the first non-empty line is the mark of "shown".
				const pre = host.querySelector<HTMLElement>('.cm-content:not([data-gate-old])');
				if (!pre) return;
				const lines = Array.from(pre.querySelectorAll('.cm-line')).map((l) => l.textContent ?? '');
				if ((lines.find((l) => l.trim().length > 0) ?? '') !== firstLine) return;
				const dom = performance.now() - t0;
				const record = (paint: { paintMs: number } | { frameStalled: true }) => ({
					domMs: Math.round(dom),
					...paint,
					maxTimerGapMs: Math.round(Math.max(maxGap, performance.now() - last)),
					lang: pre.closest('[data-testid="code-editor"]')?.getAttribute('data-vellis-lang') ?? null,
					colouredSpans: pre.querySelectorAll('.cm-line span[class]').length,
					visibility: document.visibilityState,
				});
				// WKWebView runs no animation frames while the display is asleep, so
				// give up on paint after 2 s and record that instead (req 69 追補a, #745).
				const stall = setTimeout(() => finish(record({ frameStalled: true })), 2_000);
				requestAnimationFrame(() => {
					clearTimeout(stall);
					finish(record({ paintMs: Math.round(performance.now() - t0) }));
				});
			};
			const obs = new MutationObserver(check);
			obs.observe(host, { childList: true, subtree: true });
			setTimeout(() => finish({ timeout: true }), 90_000);
			row.click();
		},
		BODY,
		uri(p),
		text.split('\n').find((l) => l.trim().length > 0) ?? '',
	);
	return {
		file: path.basename(p),
		chars: text.length,
		lines: text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length,
		...res,
	};
}

async function find(query: string): Promise<{ count: string; highlights: number; current: number; marks: number }> {
	await emitMenu('menu_find');
	await browser.waitUntil(
		async () => browser.execute(() => !!document.querySelector('[data-testid="find-input"]')),
		{ timeout: 5_000, timeoutMsg: 'find bar did not open on menu_find' },
	);
	await browser.execute((q) => {
		const input = document.querySelector<HTMLInputElement>('[data-testid="find-input"]')!;
		input.value = q;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}, query);
	await browser.pause(600);
	return browser.execute((body) => {
		const h = (globalThis as unknown as { CSS: { highlights?: Map<string, { size: number }> } }).CSS.highlights;
		return {
			count: document.querySelector('[data-testid="find-count"]')?.textContent ?? '',
			highlights: h?.get('vellis-find')?.size ?? -1,
			current: h?.get('vellis-find-current')?.size ?? -1,
			marks: document.querySelectorAll(`${body} mark`).length,
		};
	}, BODY);
}

async function closeFind(): Promise<void> {
	await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="find-close"]')?.click());
	await browser.pause(200);
}

describe('Requirement #69 human gates 1-4 (code files are highlighted)', () => {
	let savedZoom: Record<string, string | null> = {};
	const heavy = heavyFixtures();

	before(async () => {
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		savedZoom = await snapshotZoomStorage();
		await browser.setTimeout({ script: 120_000 });
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		fs.rmSync(gateDir, { recursive: true, force: true });
		fs.mkdirSync(heavyDir, { recursive: true });
		for (const s of Object.values(samples)) fs.writeFileSync(path.join(gateDir, s.file), s.code);
		fs.writeFileSync(path.join(gateDir, 'sample-ts-as.txt'), samples.ts!.code);
		fs.writeFileSync(path.join(gateDir, 'fences.md'), fencedMarkdown());
		for (const [name, text] of Object.entries(heavy)) fs.writeFileSync(path.join(heavyDir, name), text);
		await waitForExplorerRow(uri(gateDir), { timeout: 30_000, nudgeDir: startRoot, nudgePrefix: 'req69' });
		await clickExplorerRow(uri(gateDir));
		await waitForExplorerRow(uri(path.join(gateDir, 'sample.ts')), { timeout: 15_000 });
	});

	after(async () => {
		await pointAtRegion('.viewer-stack');
		await emitMenu('menu_zoom_reset');
		await restoreZoomStorage(savedZoom);
		await restoreGateRecorder();
		fs.rmSync(gateDir, { recursive: true, force: true });
		for (const name of fs.readdirSync(startRoot)) {
			if (name.startsWith('req69-nudge-')) fs.rmSync(path.join(startRoot, name), { force: true });
		}
	});

	it('gate 1: the plain .txt face of the sample is the baseline (no colour; 要件74 2-5: a CodeMirror face without a language)', async () => {
		await openFile(path.join(gateDir, 'sample-ts-as.txt'), samples.ts!.code);
		const plain = await preStyle();
		expect(plain.lang).toBeNull();
		expect(plain.spans).toBe(0);
		report(REPORT, { gate: '69-1-plain', style: plain });
		await shot('req69-gate1-plain-txt');
	});

	for (const [key, s] of Object.entries(samples)) {
		it(`gate 1: ${s.file} is coloured (Lezer), styled like the plain face (tab-size = the file's indent), and coloured like the \`\`\`${s.fence} fence (an embedded face = 2-4)`, async () => {
			await openFile(path.join(gateDir, 'sample-ts-as.txt'), samples.ts!.code);
			const plain = await preStyle();
			await openFile(path.join(gateDir, s.file), s.code);
			const coloured = await preStyle();
			expect(coloured.lang).toBe(s.lang);
			expect(coloured.colours).toBeGreaterThanOrEqual(2);
			// Font, line height, wrapping, padding, margin, background, radius: the same as the plain face (要件74 契約5
			// 「書体・文字の大きさ・行間・余白・折り返し・幅は今の <pre> と同じ」). `tab-size` follows each file's own
			// indent (契約5「Tab=字下げの単位(ファイルから検出)」), so it is judged against the file, not the plain face.
			const plainStyle = splitTabSize(plain.pre);
			const colouredStyle = splitTabSize(coloured.pre);
			expect(colouredStyle.rest).toEqual(plainStyle.rest);
			expect(colouredStyle.tabSize).toBe(expectedTabSize(s.code));
			expect(plainStyle.tabSize).toBe(expectedTabSize(samples.ts!.code));
			const fileColours = await charColours(null);
			await shot(`req69-gate1-${key}`);

			// Tag the code file's `<pre>` so neither the wait nor the measurement
			// can take it for the fence (Issue #768).
			await markCurrentPre();
			await clickExplorerRow(uri(path.join(gateDir, 'fences.md')));
			const marker = s.code.split('\n').find((l) => l.trim().length > 12)!.trim();
			await waitForFence(marker, s.fence);
			const fenceColours = await charColours(marker);
			const diffs = fileColours
				.map(([ch, c], i) => ({ i, ch, file: c, fence: fenceColours[i]?.[1], fenceCh: fenceColours[i]?.[0] }))
				.filter((d) => d.ch !== d.fenceCh || d.file !== d.fence);
			report(REPORT, {
				gate: '69-1',
				file: s.file,
				lang: coloured.lang,
				distinctColours: coloured.colours,
				colouredSpans: coloured.spans,
				sameStyleAsPlain: JSON.stringify(splitTabSize(coloured.pre).rest) === JSON.stringify(splitTabSize(plain.pre).rest),
				tabSize: { face: splitTabSize(coloured.pre).tabSize, fromFile: expectedTabSize(s.code), plainFace: splitTabSize(plain.pre).tabSize },
				heightColoured: coloured.height,
				heightPlainTs: key === 'ts' ? plain.height : undefined,
				chars: fileColours.length,
				fenceChars: fenceColours.length,
				colourMismatches: diffs.length,
				firstMismatches: diffs.slice(0, 5),
			});
			if (key === 'ts') expect(coloured.height).toBe(plain.height);
			expect(fenceColours.length).toBe(fileColours.length);
			expect(diffs).toEqual([]);
		});
	}

	it('gate 1: screenshot of the fences for side-by-side viewing', async () => {
		await clickExplorerRow(uri(path.join(gateDir, 'fences.md')));
		await browser.pause(500);
		await shot('req69-gate1-fences-md');
	});

	// 要件74 2-5: the face is the editor — a double-click enters nothing else; typing stays coloured; menu_save writes; no Edit ▸ Edit.
	it('gate 2: the face is the editor — a double-click changes nothing, typing stays coloured, menu_save writes the file, no Done Editing / menu_edit', async () => {
		const file = path.join(gateDir, 'sample.ts');
		const original = samples.ts!.code;
		await openFile(file, original);
		const before = await preStyle();
		await browser.execute((sel) => {
			const span = document.querySelector<HTMLElement>(`${sel} .cm-line span[class]`)!;
			span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
		}, FACE_CONTENT);
		await browser.pause(500);
		const afterDbl = await browser.execute((sel) => ({
			editables: Array.from(document.querySelectorAll('[contenteditable="true"]')).map((e) => e.className),
			done: document.querySelector('[data-testid="edit-done"]') !== null,
			plainPre: document.querySelector(`article.viewer pre.vellis-plaintext`) !== null,
			face: document.querySelector(sel) !== null,
		}), FACE_CONTENT);
		expect(afterDbl.face).toBe(true);
		expect(afterDbl.plainPre).toBe(false);
		expect(afterDbl.done).toBe(false);
		expect(afterDbl.editables.filter((c) => !c.includes('cm-content'))).toEqual([]);
		expect(await faceDirty()).toBe(false);
		await shot('req69-gate2-face-after-dblclick');

		const added = 'export const added = 42; // saved by the gate check\n';
		expect(await appendToFace(added)).toBe(true);
		await browser.waitUntil(async () => await faceDirty(), { timeout: 5_000, timeoutMsg: 'the appended text did not make the face dirty' });
		const whileDirty = await preStyle();
		expect(whileDirty.lang).toBe('typescript');
		expect(whileDirty.colours).toBeGreaterThanOrEqual(2);
		await emitMenu('menu_save');
		await browser.waitUntil(async () => fs.readFileSync(file, 'utf8') === original + added, {
			timeout: 10_000,
			timeoutMsg: `menu_save did not write the file (now: ${JSON.stringify(fs.readFileSync(file, 'utf8').slice(-80))})`,
		});
		await browser.waitUntil(async () => !(await faceDirty()), { timeout: 5_000, timeoutMsg: 'the unsaved badge did not go after the save' });
		const after = await preStyle();
		expect(after.lang).toBe('typescript');
		expect(after.colours).toBeGreaterThanOrEqual(2);
		const lastLineColoured = await browser.execute((sel) => {
			const lines = Array.from(document.querySelectorAll<HTMLElement>(`${sel} .cm-line`));
			const line = lines.find((l) => (l.textContent ?? '').includes('added = 42'));
			return line ? line.querySelectorAll('span[class]').length : -1;
		}, FACE_CONTENT);
		expect(lastLineColoured).toBeGreaterThan(1);
		report(REPORT, { gate: '69-2-face', before: before.colours, whileDirty: whileDirty.colours, savedOnDisk: true, colouredAfter: after.colours, addedLineSpans: lastLineColoured, dialogs: (await readGateRecord()).dialogs });
		await shot('req69-gate2-after-save-coloured');
		expect((await readGateRecord()).dialogs).toEqual([]);
	});

	it('gate 3: boundary files — time to display in WKWebView and whether the view fell back to plain', async function () {
		// Up to 2 s more per open when no frame comes (20 opens = 40 s), and the inner 90 s timeout should win over mocha's.
		this.timeout(150_000);
		await clickExplorerRow(uri(heavyDir));
		await waitForExplorerRow(uri(path.join(heavyDir, 'ts-10000-lines.ts')), { timeout: 15_000 });
		const order = [
			'ts-524288-chars.txt',
			'ts-262144-chars.ts',
			'ts-393216-chars.ts',
			'ts-524288-chars.ts',
			'ts-524289-chars.ts',
			'ts-10000-lines.ts',
			'ts-10001-lines.ts',
			'sql-insert-statements.sql',
			'sql-insert-multirow.sql',
			'ts-long-lines.ts',
		];
		// Two passes: the first includes loading a grammar the first time (sql),
		// the second shows how stable the numbers are.
		const timings: Timing[] = [];
		for (const pass of [1, 2]) {
			for (const name of order) {
				// A small file in between so every heavy file starts from the same state.
				await openFile(path.join(gateDir, 'sample.json'), samples.json!.code);
				const t = await timeOpen(path.join(heavyDir, name), heavy[name]!);
				if (pass === 1) timings.push(t);
				report(REPORT, { gate: '69-3', pass, ...t });
				if (pass === 1 && !t.timeout) await shot(`req69-gate3-${name.replace(/\W+/g, '-')}`);
			}
		}
		const by = Object.fromEntries(timings.map((t) => [t.file, t]));
		for (const t of timings) expect(t.timeout).toBeUndefined();
		// 要件74 2-5 / 契約5: the CodeMirror face has no size limit (the Shiki limits of 契約6 (1)(2) belonged to the
		// removed view); the language of the boundary files is recorded, not judged (AC-74-33 / 10 for the timing).
		report(REPORT, { gate: '69-3-langs', langs: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.lang ?? null])) });

		// 要件74 2-5: the per-line length limit of Shiki (契約6) is gone with the view; the colouring of the long lines is recorded.
		const perLine = await browser.execute((sel) => {
			const content = document.querySelector<HTMLElement>(sel)!;
			const base = getComputedStyle(content).color;
			return {
				lang: content.closest('[data-testid="code-editor"]')?.getAttribute('data-vellis-lang') ?? null,
				lines: Array.from(content.querySelectorAll<HTMLElement>('.cm-line')).map((l) => {
					const colours = new Set<string>();
					for (const sp of l.querySelectorAll<HTMLElement>('span[class]')) {
						const c = getComputedStyle(sp).color;
						if (c !== base) colours.add(c);
					}
					return { length: (l.textContent ?? '').length, colours: colours.size };
				}),
			};
		}, FACE_CONTENT);
		report(REPORT, { gate: '69-3-long-lines', ...perLine });
		expect(perLine.lang).toBe('typescript');
	});

	it('gate 4: find gives the same counts on the coloured view and on the plain .txt', async () => {
		const queries = ['value', '= ', 'item.id > 0', "'node:fs/promises'"];
		const results: Record<string, { coloured: unknown; plain: unknown }> = {};
		for (const q of queries) {
			await openFile(path.join(gateDir, 'sample.ts'), samples.ts!.code + 'export const added = 42; // saved by the gate check\n');
			const coloured = await find(q);
			if (q === 'value') await shot('req69-gate4-find-coloured');
			await closeFind();
			await openFile(path.join(gateDir, 'sample-ts-as.txt'), samples.ts!.code);
			const plain = await find(q);
			if (q === 'value') await shot('req69-gate4-find-plain');
			await closeFind();
			results[q] = { coloured, plain };
		}
		// The .ts gained one line in gate 2; none of the queries occur in it, except
		// '= ' which is counted separately below.
		// 要件74 2-5: both are CodeMirror faces whose count is the whole document (AC-74-31); `CSS.highlights` is not used
		// by the face (its highlights are decorations of the viewport), so the counts are compared, not the highlight sizes.
		const total = (c: string) => Number(/ of (\d+)$/.exec(c)?.[1] ?? -1);
		for (const q of queries.filter((x) => x !== '= ')) {
			const r = results[q]!;
			expect((r.coloured as { count: string }).count).toBe((r.plain as { count: string }).count);
		}
		const eq = results['= ']!;
		expect(total((eq.coloured as { count: string }).count)).toBe(total((eq.plain as { count: string }).count) + 1);

		// Legibility: each token colour against the find highlight colours.
		// 要件56 の見た目に合わせた(2026-11-06 由谷承認): the `::highlight()` rules
		// now say `background-color: var(--color-find-match)` instead of a literal
		// colour, so a `var(--name)` is resolved through the root's computed custom
		// properties (following nested var() references). A value that cannot be
		// resolved is kept as read, listed under `unresolved` in the report, and
		// left out of the contrast table rather than thrown on.
		const hl = await browser.execute(() => {
			const raw: Record<string, string> = {};
			for (const sheet of Array.from(document.styleSheets)) {
				let rules: CSSRuleList;
				try {
					rules = sheet.cssRules;
				} catch {
					continue;
				}
				for (const r of Array.from(rules)) {
					const m = /::highlight\((vellis-find(?:-current)?)\)\s*\{[^}]*background-color:\s*([^;}]+)/.exec(r.cssText);
					if (m) raw[m[1]!] = m[2]!.trim();
				}
			}
			const cs = getComputedStyle(document.documentElement);
			const resolve = (value: string): string => {
				let v = value;
				for (let i = 0; i < 8; i++) {
					const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/.exec(v);
					if (!m) return v;
					const next = cs.getPropertyValue(m[1]!).trim() || (m[2] ?? '').trim();
					if (!next) return v;
					v = next;
				}
				return v;
			};
			const resolved: Record<string, string> = {};
			for (const [name, value] of Object.entries(raw)) resolved[name] = resolve(value);
			return { raw, resolved };
		});
		await openFile(path.join(gateDir, 'sample.ts'), samples.ts!.code + 'export const added = 42; // saved by the gate check\n');
		const tokenColours = await browser.execute((sel) => {
			const set = new Set<string>();
			const content = document.querySelector<HTMLElement>(sel)!;
			const base = getComputedStyle(content).color;
			for (const s of content.querySelectorAll<HTMLElement>('.cm-line span[class]')) {
				const c = getComputedStyle(s).color;
				if (c !== base) set.add(c);
			}
			return Array.from(set);
		}, FACE_CONTENT);
		const unresolved: Record<string, string> = {};
		const legibility: Record<string, Record<string, number>> = {};
		for (const [name, bg] of Object.entries(hl.resolved)) {
			try {
				legibility[name] = Object.fromEntries(tokenColours.map((c) => [c, contrastRatio(c, bg)]));
			} catch {
				unresolved[name] = hl.raw[name] ?? bg;
			}
		}
		report(REPORT, {
			gate: '69-4-find',
			results,
			highlightColours: hl.resolved,
			highlightColoursRaw: hl.raw,
			unresolved,
			contrastTokenVsHighlight: legibility,
		});
	});

	// 要件74 2-5 / AC-74-31: the face is zoomed by its font-size, not by the body's CSS zoom; the EditorView is not re-created.
	it('gate 4: viewer zoom scales the face by font-size (no CSS zoom on the body), without re-creating it', async () => {
		const text = samples.ts!.code + 'export const added = 42; // saved by the gate check\n';
		await openFile(path.join(gateDir, 'sample.ts'), text);
		await pointAtRegion('.viewer-stack');
		await emitMenu('menu_zoom_reset');
		await browser.pause(200);
		const before = await browser.execute((face, sel) => {
			const content = document.querySelector<HTMLElement>(sel)! as HTMLElement & { __gate?: number };
			content.__gate = 1;
			const r = content.getBoundingClientRect();
			return { h: r.height, w: r.width, spans: content.querySelectorAll('.cm-line span[class]').length, fontSize: document.querySelector<HTMLElement>(face)!.style.fontSize };
		}, FACE, FACE_CONTENT);
		await emitMenu('menu_zoom_in');
		await emitMenu('menu_zoom_in');
		await browser.pause(300);
		const after = await browser.execute((face, sel, body) => {
			const content = document.querySelector<HTMLElement>(sel)! as HTMLElement & { __gate?: number };
			const r = content.getBoundingClientRect();
			return {
				h: r.height,
				w: r.width,
				spans: content.querySelectorAll('.cm-line span[class]').length,
				sameElement: content.__gate === 1,
				bodyZoom: document.querySelector<HTMLElement>(body)!.style.zoom,
				fontSize: document.querySelector<HTMLElement>(face)!.style.fontSize,
				lang: document.querySelector(face)?.getAttribute('data-vellis-lang') ?? null,
			};
		}, FACE, FACE_CONTENT, BODY);
		await shot('req69-gate4-zoom-120pct');
		await emitMenu('menu_zoom_reset');
		report(REPORT, { gate: '69-4-zoom', before, after, heightRatio: after.h / before.h });
		expect(after.bodyZoom).toBe('');
		expect(after.fontSize).toMatch(/120/);
		expect(after.sameElement).toBe(true);
		expect(after.spans).toBe(before.spans);
		expect(after.lang).toBe('typescript');
		expect(Math.abs(after.h / before.h - 1.2)).toBeLessThan(0.05);
	});

	// 要件74 2-5 / AC-74-39: Shiki is used for printing only — `beforeprint` builds `[data-testid="code-editor-print"] pre.vellis-plaintext`.
	it('gate 4: the print rule keeps token colours on the Shiki <pre> that beforeprint builds (stylesheet check + rules applied on screen)', async () => {
		const text = samples.ts!.code + 'export const added = 42; // saved by the gate check\n';
		await openFile(path.join(gateDir, 'sample.ts'), text);
		await browser.execute(() => window.dispatchEvent(new Event('beforeprint')));
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelector('[data-testid="code-editor-print"] pre.vellis-plaintext span[style*="color"]') !== null),
			{ timeout: 10_000, timeoutMsg: 'beforeprint did not build the Shiki <pre> with coloured spans' },
		);
		const res = await browser.execute(() => {
			const printRules: string[] = [];
			for (const sheet of Array.from(document.styleSheets)) {
				let rules: CSSRuleList;
				try {
					rules = sheet.cssRules;
				} catch {
					continue;
				}
				for (const r of Array.from(rules)) {
					if (r instanceof CSSMediaRule && /\bprint\b/.test(r.media.mediaText)) {
						for (const inner of Array.from(r.cssRules)) printRules.push(inner.cssText);
					}
				}
			}
			const spanRule = printRules.find((t) => /\.markdown-body span/.test(t) && /print-color-adjust:\s*exact/.test(t)) ?? null;
			const spans = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="code-editor-print"] pre.vellis-plaintext span[style]')).filter((s) => s.style.color);
			const colourBefore = spans.map((s) => getComputedStyle(s).color);
			const style = document.createElement('style');
			style.id = 'gate-print-sim';
			style.textContent = printRules.join('\n');
			document.head.appendChild(style);
			const cs = spans[0] ? getComputedStyle(spans[0]) : null;
			return {
				printRuleCount: printRules.length,
				spanRule,
				colourSame: spans.every((s, i) => getComputedStyle(s).color === colourBefore[i]),
				adjust: cs ? cs.getPropertyValue('print-color-adjust') || cs.getPropertyValue('-webkit-print-color-adjust') : null,
				explorerHidden: getComputedStyle(document.querySelector('aside.explorer')!).display === 'none',
				printSpans: spans.length,
			};
		});
		await shot('req69-gate4-print-rules-applied-on-screen');
		await browser.execute(() => {
			document.getElementById('gate-print-sim')?.remove();
			window.dispatchEvent(new Event('afterprint'));
		});
		report(REPORT, { gate: '69-4-print', ...res });
		expect(res.spanRule).not.toBeNull();
		expect(res.printSpans).toBeGreaterThan(0);
		expect(res.colourSame).toBe(true);
		expect(res.adjust).toBe('exact');
	});
});
