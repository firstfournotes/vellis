import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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
 * Requirement #69 human gates 1-4, driven on the webdriver build
 * (docs/requirements/req-69.md「人間ゲート」). Gate 5 (judgement) stays with a
 * human.
 *
 *  1. Each sample (.ts/.rs/.py/.json/.yaml/.sh) is coloured; the `<pre>`'s
 *     computed font-size / white-space / padding / background / line-height
 *     equal the plain (.txt) view of the same text; the per-character colours
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

/**
 * Wait until the viewer shows a *new* `<pre>` (not one marked by
 * `markCurrentPre`) whose text has `len` characters. Two files of the same
 * length (sample.ts and its .txt twin) would otherwise satisfy the wait with
 * the previous document's `<pre>`.
 */
async function waitForPre(len: number, timeout = 30_000): Promise<void> {
	await browser.waitUntil(
		async () =>
			browser.execute(
				(body, n) =>
					(document.querySelector(`${body} pre.vellis-plaintext:not([data-gate-old])`)?.textContent ?? '')
						.length === n,
				BODY,
				len,
			),
		{ timeout, timeoutMsg: `viewer never showed a new <pre> of ${len} chars` },
	);
}

async function markCurrentPre(): Promise<void> {
	await browser.execute((body) => {
		document.querySelectorAll(`${body} pre`).forEach((p) => p.setAttribute('data-gate-old', '1'));
	}, BODY);
}

async function openFile(p: string, len: number): Promise<void> {
	const showing = await browser.execute(
		(body, u, n) =>
			document.querySelector<HTMLElement>('.explorer-item.active')?.title === u &&
			(document.querySelector(`${body} pre.vellis-plaintext:not([contenteditable])`)?.textContent ?? '').length === n,
		BODY,
		uri(p),
		len,
	);
	if (showing) return;
	await markCurrentPre();
	await clickExplorerRow(uri(p));
	await waitForPre(len);
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

async function preStyle(): Promise<{ pre: Record<string, string>; code: Record<string, string> | null; height: number; width: number; lang: string | null; colours: number; spans: number }> {
	return browser.execute(
		(body, props) => {
			const pre = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext`)!;
			const code = pre.querySelector('code');
			const pick = (el: Element) => {
				const cs = getComputedStyle(el);
				return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
			};
			const colours = new Set<string>();
			let spans = 0;
			for (const s of pre.querySelectorAll<HTMLElement>('span[style]')) {
				if (s.style.color) {
					colours.add(s.style.color);
					spans++;
				}
			}
			const r = pre.getBoundingClientRect();
			return {
				pre: pick(pre),
				code: code ? pick(code) : null,
				height: r.height,
				width: r.width,
				lang: pre.getAttribute('data-vellis-lang'),
				colours: colours.size,
				spans,
			};
		},
		BODY,
		STYLE_PROPS,
	);
}

/**
 * Per non-whitespace character: [char, colour] for the `<pre>` that contains
 * `marker` (the file view's `<pre>` when `marker` is null).
 */
async function charColours(marker: string | null): Promise<Array<[string, string]>> {
	const pairs: string[][] = await browser.execute(
		(body, m) => {
			const pres = Array.from(document.querySelectorAll<HTMLElement>(`${body} pre`));
			const pre = m === null ? pres[0] : pres.find((p) => (p.textContent ?? '').includes(m));
			if (!pre) return [];
			const out: string[][] = [];
			const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				let el: HTMLElement | null = n.parentElement;
				let colour = '';
				while (el && el !== pre) {
					if (el.style?.color) {
						colour = el.style.color;
						break;
					}
					el = el.parentElement;
				}
				for (const ch of n.textContent ?? '') if (!/\s/.test(ch)) out.push([ch, colour]);
			}
			return out;
		},
		BODY,
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
	maxTimerGapMs?: number;
	lang?: string | null;
	colouredSpans?: number;
	timeout?: boolean;
	visibility?: string;
}

/**
 * Click the row and time it, inside the page: t0 = just before the click;
 * DOM = the MutationObserver callback that first sees the new `<pre>` with the
 * full text; paint = the next animation frame after that. A 10 ms interval
 * records the longest gap between its ticks — how long the page could not run
 * anything (≈ the freeze a user would feel).
 */
async function timeOpen(p: string, text: string): Promise<Timing> {
	await waitForExplorerRow(uri(p), { timeout: 15_000 });
	const res = await browser.executeAsync<Omit<Timing, 'file' | 'chars' | 'lines'>, [string, string, number]>(
		(body, target, len, done) => {
			const host = document.querySelector(body);
			host?.querySelector('pre')?.setAttribute('data-gate-old', '1');
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
				const pre = host.querySelector<HTMLElement>('pre.vellis-plaintext:not([data-gate-old])');
				if (!pre || (pre.textContent ?? '').length !== len) return;
				const dom = performance.now() - t0;
				requestAnimationFrame(() => {
					const paint = performance.now() - t0;
					finish({
						domMs: Math.round(dom),
						paintMs: Math.round(paint),
						maxTimerGapMs: Math.round(Math.max(maxGap, performance.now() - last)),
						lang: pre.getAttribute('data-vellis-lang'),
						colouredSpans: pre.querySelectorAll('span[style*="color"]').length,
						visibility: document.visibilityState,
					});
				});
			};
			const obs = new MutationObserver(check);
			obs.observe(host, { childList: true, subtree: true });
			setTimeout(() => finish({ timeout: true }), 90_000);
			row.click();
		},
		BODY,
		uri(p),
		text.length,
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

	it('gate 1: the plain .txt view of the sample is the baseline (no colour)', async () => {
		await openFile(path.join(gateDir, 'sample-ts-as.txt'), samples.ts!.code.length);
		const plain = await preStyle();
		expect(plain.lang).toBeNull();
		expect(plain.spans).toBe(0);
		report(REPORT, { gate: '69-1-plain', style: plain });
		await shot('req69-gate1-plain-txt');
	});

	for (const [key, s] of Object.entries(samples)) {
		it(`gate 1: ${s.file} is coloured, styled like the plain view, and coloured like the \`\`\`${s.fence} fence`, async () => {
			await openFile(path.join(gateDir, 'sample-ts-as.txt'), samples.ts!.code.length);
			const plain = await preStyle();
			await openFile(path.join(gateDir, s.file), s.code.length);
			const coloured = await preStyle();
			expect(coloured.lang).toBe(s.lang);
			expect(coloured.colours).toBeGreaterThanOrEqual(2);
			expect(coloured.pre).toEqual(plain.pre);
			const fileColours = await charColours(null);
			await shot(`req69-gate1-${key}`);

			await clickExplorerRow(uri(path.join(gateDir, 'fences.md')));
			const marker = s.code.split('\n').find((l) => l.trim().length > 12)!.trim();
			await browser.waitUntil(
				async () => (await charColours(marker)).length > 0,
				{ timeout: 15_000, timeoutMsg: `fence for ${s.fence} not rendered` },
			);
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
				sameStyleAsPlain: JSON.stringify(coloured.pre) === JSON.stringify(plain.pre),
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

	it('gate 2: double click enters the plain-text editor; menu_save + Done Editing brings the colours back', async () => {
		const file = path.join(gateDir, 'sample.ts');
		const original = samples.ts!.code;
		await openFile(file, original.length);
		await browser.execute((body) => {
			const span = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext span[style*="color"]`)!;
			span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
		}, BODY);
		await browser.waitUntil(
			async () => browser.execute((body) => !!document.querySelector(`${body} pre.vellis-plaintext[contenteditable="true"]`), BODY),
			{ timeout: 5_000, timeoutMsg: 'double click did not enter the editor' },
		);
		const editor = await browser.execute((body) => {
			const pre = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext[contenteditable="true"]`)!;
			return { children: pre.childElementCount, text: pre.textContent ?? '', lang: pre.getAttribute('data-vellis-lang') };
		}, BODY);
		expect(editor.children).toBe(0);
		expect(editor.text).toBe(original);
		expect(editor.lang).toBeNull();
		await shot('req69-gate2-editing-plain');

		const added = 'export const added = 42; // saved by the gate check\n';
		await browser.execute(
			(body, extra) => {
				const pre = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext[contenteditable="true"]`)!;
				pre.textContent = (pre.textContent ?? '') + extra;
				pre.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: extra }));
			},
			BODY,
			added,
		);
		await emitMenu('menu_save');
		await browser.waitUntil(async () => fs.readFileSync(file, 'utf8') === original + added, {
			timeout: 10_000,
			timeoutMsg: `menu_save did not write the file (now: ${JSON.stringify(fs.readFileSync(file, 'utf8').slice(-80))})`,
		});
		await markCurrentPre();
		await browser.execute(() => document.querySelector<HTMLButtonElement>('[data-testid="edit-done"]')?.click());
		await waitForPre((original + added).length);
		const after = await preStyle();
		expect(after.lang).toBe('typescript');
		expect(after.colours).toBeGreaterThanOrEqual(2);
		const lastLineColoured = await browser.execute((body) => {
			const lines = Array.from(document.querySelectorAll<HTMLElement>(`${body} pre.vellis-plaintext .line`));
			const line = lines.find((l) => (l.textContent ?? '').includes('added = 42'));
			return line ? line.querySelectorAll('span[style*="color"]').length : -1;
		}, BODY);
		expect(lastLineColoured).toBeGreaterThan(1);
		report(REPORT, { gate: '69-2-dblclick', editorChildren: editor.children, savedOnDisk: true, colouredAfter: after.colours, addedLineSpans: lastLineColoured, dialogs: (await readGateRecord()).dialogs });
		await shot('req69-gate2-after-save-coloured');

		// The Edit menu event (Command + E) goes in and out the same way.
		await emitMenu('menu_edit');
		await browser.waitUntil(
			async () => browser.execute((body) => !!document.querySelector(`${body} pre.vellis-plaintext[contenteditable="true"]`), BODY),
			{ timeout: 5_000, timeoutMsg: 'menu_edit did not enter the editor' },
		);
		await emitMenu('menu_edit');
		await browser.waitUntil(
			async () => browser.execute((body) => !!document.querySelector(`${body} pre.vellis-plaintext[data-vellis-lang]`), BODY),
			{ timeout: 5_000, timeoutMsg: 'second menu_edit did not return to the coloured view' },
		);
		expect((await readGateRecord()).dialogs).toEqual([]);
	});

	it('gate 3: boundary files — time to display in WKWebView and whether the view fell back to plain', async () => {
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
				await openFile(path.join(gateDir, 'sample.json'), samples.json!.code.length);
				const t = await timeOpen(path.join(heavyDir, name), heavy[name]!);
				if (pass === 1) timings.push(t);
				report(REPORT, { gate: '69-3', pass, ...t });
				if (pass === 1 && !t.timeout) await shot(`req69-gate3-${name.replace(/\W+/g, '-')}`);
			}
		}
		const by = Object.fromEntries(timings.map((t) => [t.file, t]));
		for (const t of timings) expect(t.timeout).toBeUndefined();
		// The hard limits (contract 6 (1)(2)) are deterministic.
		expect(by['ts-524289-chars.ts']!.lang).toBeNull();
		expect(by['ts-10001-lines.ts']!.lang).toBeNull();
		expect(by['ts-10000-lines.ts']!.lang === 'typescript' || by['ts-10000-lines.ts']!.lang === null).toBe(true);

		// Lines of 2,000 characters or more stay uncoloured; shorter ones are coloured.
		const perLine = await browser.execute((body) => {
			const pre = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext`)!;
			return {
				lang: pre.getAttribute('data-vellis-lang'),
				lines: Array.from(pre.querySelectorAll<HTMLElement>('.line')).map((l) => {
					const colours = new Set<string>();
					for (const s of l.querySelectorAll<HTMLElement>('span[style]')) if (s.style.color) colours.add(s.style.color);
					return { length: (l.textContent ?? '').length, colours: colours.size };
				}),
			};
		}, BODY);
		report(REPORT, { gate: '69-3-long-lines', ...perLine });
		expect(perLine.lang).toBe('typescript');
		const of = (n: number) => perLine.lines.find((l) => l.length === n)!;
		expect(of(1_999).colours).toBeGreaterThanOrEqual(2);
		expect(of(2_000).colours).toBeLessThanOrEqual(1);
		expect(of(5_000).colours).toBeLessThanOrEqual(1);
	});

	it('gate 4: find gives the same counts on the coloured view and on the plain .txt', async () => {
		const queries = ['value', '= ', 'item.id > 0', "'node:fs/promises'"];
		const results: Record<string, { coloured: unknown; plain: unknown }> = {};
		for (const q of queries) {
			await openFile(path.join(gateDir, 'sample.ts'), samples.ts!.code.length + 'export const added = 42; // saved by the gate check\n'.length);
			const coloured = await find(q);
			if (q === 'value') await shot('req69-gate4-find-coloured');
			await closeFind();
			await openFile(path.join(gateDir, 'sample-ts-as.txt'), samples.ts!.code.length);
			const plain = await find(q);
			if (q === 'value') await shot('req69-gate4-find-plain');
			await closeFind();
			results[q] = { coloured, plain };
		}
		// The .ts gained one line in gate 2; none of the queries occur in it, except
		// '= ' which is counted separately below.
		for (const q of queries.filter((x) => x !== '= ')) {
			const r = results[q]!;
			expect((r.coloured as { highlights: number }).highlights).toBe((r.plain as { highlights: number }).highlights);
			expect((r.coloured as { count: string }).count).toBe((r.plain as { count: string }).count);
		}
		const eq = results['= ']!;
		expect((eq.coloured as { highlights: number }).highlights).toBe((eq.plain as { highlights: number }).highlights + 1);

		// Legibility: each token colour against the find highlight colours.
		const hl = await browser.execute(() => {
			const out: Record<string, string> = {};
			for (const sheet of Array.from(document.styleSheets)) {
				let rules: CSSRuleList;
				try {
					rules = sheet.cssRules;
				} catch {
					continue;
				}
				for (const r of Array.from(rules)) {
					const m = /::highlight\((vellis-find(?:-current)?)\)\s*\{[^}]*background-color:\s*([^;}]+)/.exec(r.cssText);
					if (m) out[m[1]!] = m[2]!.trim();
				}
			}
			return out;
		});
		await openFile(path.join(gateDir, 'sample.ts'), samples.ts!.code.length + 'export const added = 42; // saved by the gate check\n'.length);
		const tokenColours = await browser.execute((body) => {
			const set = new Set<string>();
			for (const s of document.querySelectorAll<HTMLElement>(`${body} pre.vellis-plaintext span[style]`)) {
				if (s.style.color) set.add(getComputedStyle(s).color);
			}
			return Array.from(set);
		}, BODY);
		const legibility = Object.fromEntries(
			Object.entries(hl).map(([name, bg]) => [
				name,
				Object.fromEntries(tokenColours.map((c) => [c, contrastRatio(c, bg)])),
			]),
		);
		report(REPORT, { gate: '69-4-find', results, highlightColours: hl, contrastTokenVsHighlight: legibility });
	});

	it('gate 4: viewer zoom scales the coloured <pre> without re-rendering it', async () => {
		const len = samples.ts!.code.length + 'export const added = 42; // saved by the gate check\n'.length;
		await openFile(path.join(gateDir, 'sample.ts'), len);
		await pointAtRegion('.viewer-stack');
		await emitMenu('menu_zoom_reset');
		await browser.pause(200);
		const before = await browser.execute((body) => {
			const pre = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext`)! as HTMLElement & { __gate?: number };
			pre.__gate = 1;
			const r = pre.getBoundingClientRect();
			return { h: r.height, w: r.width, spans: pre.querySelectorAll('span[style]').length };
		}, BODY);
		await emitMenu('menu_zoom_in');
		await emitMenu('menu_zoom_in');
		await browser.pause(300);
		const after = await browser.execute((body) => {
			const pre = document.querySelector<HTMLElement>(`${body} pre.vellis-plaintext`)! as HTMLElement & { __gate?: number };
			const r = pre.getBoundingClientRect();
			return {
				h: r.height,
				w: r.width,
				spans: pre.querySelectorAll('span[style]').length,
				sameElement: pre.__gate === 1,
				zoom: document.querySelector<HTMLElement>(body)!.style.zoom,
				lang: pre.getAttribute('data-vellis-lang'),
			};
		}, BODY);
		await shot('req69-gate4-zoom-120pct');
		await emitMenu('menu_zoom_reset');
		report(REPORT, { gate: '69-4-zoom', before, after, heightRatio: after.h / before.h });
		expect(after.zoom).toBe('120%');
		expect(after.sameElement).toBe(true);
		expect(after.spans).toBe(before.spans);
		expect(after.lang).toBe('typescript');
		expect(Math.abs(after.h / before.h - 1.2)).toBeLessThan(0.05);
	});

	it('gate 4: the print rule keeps token colours (stylesheet check + rules applied on screen)', async () => {
		const len = samples.ts!.code.length + 'export const added = 42; // saved by the gate check\n'.length;
		await openFile(path.join(gateDir, 'sample.ts'), len);
		const res = await browser.execute((body) => {
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
			const spans = Array.from(document.querySelectorAll<HTMLElement>(`${body} pre.vellis-plaintext span[style]`)).filter((s) => s.style.color);
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
			};
		}, BODY);
		await shot('req69-gate4-print-rules-applied-on-screen');
		await browser.execute(() => document.getElementById('gate-print-sim')?.remove());
		report(REPORT, { gate: '69-4-print', ...res });
		expect(res.spanRule).not.toBeNull();
		expect(res.colourSame).toBe(true);
		expect(res.adjust).toBe('exact');
	});
});
