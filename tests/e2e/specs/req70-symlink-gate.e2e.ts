import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assertIpcInterceptionWorks,
	clearIpcLog,
	clickExplorerRow,
	contrastRatio,
	emitMenu,
	installGateRecorder,
	parseColor,
	pointAtRegion,
	readGateRecord,
	report,
	restoreGateRecorder,
	restoreZoomStorage,
	setIpcBlock,
	shot,
	snapshotZoomStorage,
	waitForAppMounted,
	waitForExplorerRow,
	zoomedShot,
} from '../gate-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Requirement #70 human gates 1-4, driven on the webdriver build
 * (docs/requirements/req-70.md「人間ゲート」). Gate 5 (ssh) and 6 (judgement)
 * stay with a human.
 *
 * The fixture folder `start-root/req70-gate/` holds one row of every kind the
 * gate names: a link to a file, to a folder, a broken link, a link to an
 * ancestor, links that point outside the root (folder and file), plus plain
 * rows as the control. `zz-deep/` pads 80 files in front of two more links so
 * Go to Path has to scroll the tree to reach them.
 *
 * What a machine cannot judge here: whether the native tooltip is *readable*
 * (only the `title` text is checked) and whether the look is acceptable (see
 * the screenshots in $VELLIS_GATE_SHOTS). Hover is not a real pointer hover —
 * WebDriver's synthetic events do not set `:hover` — so the hover background
 * is applied with the same token through a temporary class.
 */

const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const gateDir = path.join(startRoot, 'req70-gate');
const outsideDir = path.join(fixtureBase, 'req70-outside');
const deepDir = path.join(gateDir, 'zz-deep');
const REPORT = 'req70-report.jsonl';

const uri = (p: string) => `file://${p}`;

/** name → readlink string, for every link in the fixture. */
const links: Record<string, { target: string; kind: 'file' | 'dir' | 'broken' }> = {
	'link-file.md': { target: 'a-plain.md', kind: 'file' },
	'link-dir': { target: 'a-plain-dir', kind: 'dir' },
	'link-broken.md': { target: 'missing-target.md', kind: 'broken' },
	'link-ancestor': { target: '..', kind: 'dir' },
	'link-outside-dir': { target: outsideDir, kind: 'dir' },
	'link-outside-file.md': { target: path.join(outsideDir, 'outside.md'), kind: 'file' },
};
const plainRows = ['a-plain.md', 'a-plain-dir', 'zz-deep'];

function buildFixture(): void {
	fs.rmSync(gateDir, { recursive: true, force: true });
	fs.rmSync(outsideDir, { recursive: true, force: true });
	fs.mkdirSync(path.join(gateDir, 'a-plain-dir'), { recursive: true });
	fs.mkdirSync(outsideDir, { recursive: true });
	fs.mkdirSync(deepDir, { recursive: true });
	fs.writeFileSync(path.join(gateDir, 'a-plain.md'), '# Plain file\n\nThe link target.\n');
	fs.writeFileSync(path.join(gateDir, 'a-plain-dir', 'inner.md'), '# Inner\n');
	fs.writeFileSync(path.join(outsideDir, 'outside.md'), '# Outside the root\n');
	for (const [name, l] of Object.entries(links)) fs.symlinkSync(l.target, path.join(gateDir, name));
	for (let i = 0; i < 80; i++) {
		fs.writeFileSync(path.join(deepDir, `f-${String(i).padStart(3, '0')}.md`), `# filler ${i}\n`);
	}
	fs.symlinkSync('../a-plain.md', path.join(deepDir, 'zz-link-file.md'));
	fs.symlinkSync('../a-plain-dir', path.join(deepDir, 'zz-link-dir'));
}

interface RowInfo {
	uri: string;
	name: string;
	classes: string[];
	rowTitle: string;
	iconTitle: string | null;
	nameTitle: string | null;
	iconText: string;
	badge: null | {
		viewBox: string | null;
		ariaHidden: string | null;
		hasTitleChild: boolean;
		rect: { x: number; y: number; width: number; height: number };
		insideIcon: boolean;
		insideRow: boolean;
		color: string;
		stroke: string;
		bgFill: string;
		bgStroke: string;
	};
	rowRect: { x: number; y: number; width: number; height: number };
	nameColor: string;
	nameWeight: string;
	fontSize: string;
}

async function rowInfo(u: string): Promise<RowInfo | null> {
	return browser.execute((target) => {
		const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find(
			(r) => r.title === target,
		);
		if (!row) return null;
		const icon = row.querySelector<HTMLElement>('.icon');
		const name = row.querySelector<HTMLElement>('.name');
		const badge = row.querySelector<SVGSVGElement>('.link-badge');
		const r = row.getBoundingClientRect();
		const box = (b: DOMRect) => ({ x: b.x, y: b.y, width: b.width, height: b.height });
		let badgeInfo = null;
		if (badge && icon) {
			const b = badge.getBoundingClientRect();
			const i = icon.getBoundingClientRect();
			const bg = badge.querySelector<SVGElement>('.link-badge-bg');
			const path = badge.querySelector<SVGElement>('path');
			const eps = 0.5;
			badgeInfo = {
				viewBox: badge.getAttribute('viewBox'),
				ariaHidden: badge.getAttribute('aria-hidden'),
				hasTitleChild: badge.querySelector('title') !== null,
				rect: box(b),
				insideIcon:
					b.left >= i.left - eps && b.right <= i.right + eps && b.top >= i.top - eps && b.bottom <= i.bottom + eps,
				insideRow: b.left >= r.left - eps && b.right <= r.right + eps && b.top >= r.top - eps && b.bottom <= r.bottom + eps,
				color: getComputedStyle(badge).color,
				stroke: path ? getComputedStyle(path).stroke : '',
				bgFill: bg ? getComputedStyle(bg).fill : '',
				bgStroke: bg ? getComputedStyle(bg).stroke : '',
			};
		}
		return {
			uri: target,
			name: name?.textContent ?? '',
			classes: Array.from(row.classList),
			rowTitle: row.title,
			iconTitle: icon?.getAttribute('title') ?? null,
			nameTitle: name?.getAttribute('title') ?? null,
			iconText: icon?.firstChild?.textContent ?? '',
			badge: badgeInfo,
			rowRect: box(r),
			nameColor: name ? getComputedStyle(name).color : '',
			nameWeight: name ? getComputedStyle(name).fontWeight : '',
			fontSize: getComputedStyle(row).fontSize,
		};
	}, u);
}

/** The opaque background actually painted behind `el` (first non-transparent ancestor). */
async function effectiveBackground(u: string): Promise<string> {
	return browser.execute((target) => {
		let el: Element | null = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find(
			(r) => r.title === target,
		) ?? null;
		while (el) {
			const c = getComputedStyle(el).backgroundColor;
			if (c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c)) return c;
			el = el.parentElement;
		}
		return 'rgb(255, 255, 255)';
	}, u);
}

async function treeRect(): Promise<{ x: number; y: number; width: number; height: number }> {
	return browser.execute(() => {
		const r = document.querySelector('aside.explorer')!.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	});
}

async function rowVisibleInTree(u: string): Promise<{ present: boolean; visible: boolean; top?: number; listTop?: number; listBottom?: number }> {
	return browser.execute((target) => {
		const list = document.querySelector('nav.explorer-list');
		const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find(
			(r) => r.title === target,
		);
		if (!list || !row) return { present: false, visible: false };
		const l = list.getBoundingClientRect();
		const r = row.getBoundingClientRect();
		return {
			present: true,
			visible: r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5,
			top: r.top,
			listTop: l.top,
			listBottom: l.bottom,
		};
	}, u);
}

describe('Requirement #70 human gates 1-4 (symlink rows in the Explorer)', () => {
	let savedZoom: Record<string, string | null> = {};

	before(async () => {
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		savedZoom = await snapshotZoomStorage();
		await browser.waitUntil(
			async () => browser.execute(() => document.querySelectorAll('.explorer-item').length > 0),
			{ timeout: 30_000, timeoutMsg: 'explorer never showed the initial listing' },
		);
		buildFixture();
		await waitForExplorerRow(uri(gateDir), { timeout: 30_000, nudgeDir: startRoot, nudgePrefix: 'req70' });
		await clickExplorerRow(uri(gateDir));
		for (const name of [...Object.keys(links), ...plainRows]) {
			await waitForExplorerRow(uri(path.join(gateDir, name)), { timeout: 15_000 });
		}
	});

	after(async () => {
		// Put the tree back to the zoom it had (the router saved ours to storage).
		await pointAtRegion('aside.explorer');
		await emitMenu('menu_zoom_reset');
		await restoreZoomStorage(savedZoom);
		await setIpcBlock([]);
		await restoreGateRecorder();
		fs.rmSync(gateDir, { recursive: true, force: true });
		fs.rmSync(outsideDir, { recursive: true, force: true });
		for (const name of fs.readdirSync(startRoot)) {
			if (name.startsWith('req70-nudge-')) fs.rmSync(path.join(startRoot, name), { force: true });
		}
	});

	it('gate 1: every kind of link carries the badge; plain rows keep today’s DOM', async () => {
		const rows: Record<string, RowInfo> = {};
		for (const name of [...Object.keys(links), ...plainRows]) {
			const info = await rowInfo(uri(path.join(gateDir, name)));
			expect(info).not.toBeNull();
			rows[name] = info!;
		}
		const FOLDER = '\u{1F4C1}';
		const DOC = '\u{1F4C4}';
		for (const [name, l] of Object.entries(links)) {
			const r = rows[name]!;
			expect(r.classes).toContain('is-link');
			expect(r.badge).not.toBeNull();
			expect(r.badge!.viewBox).toBe('0 0 10 10');
			expect(r.badge!.ariaHidden).toBe('true');
			expect(r.badge!.hasTitleChild).toBe(false);
			// Inside the icon box, so the row's `overflow: hidden` cannot clip it.
			expect(r.badge!.insideIcon).toBe(true);
			expect(r.badge!.insideRow).toBe(true);
			expect(r.badge!.rect.width).toBeGreaterThan(0);
			expect(r.iconText).toBe(l.kind === 'dir' ? FOLDER : DOC);
			expect(r.name).toBe(name);
			if (l.kind === 'broken') expect(r.classes).toContain('is-broken-link');
			else expect(r.classes).not.toContain('is-broken-link');
		}
		for (const name of plainRows) {
			const r = rows[name]!;
			expect(r.classes).not.toContain('is-link');
			expect(r.classes).not.toContain('is-broken-link');
			expect(r.badge).toBeNull();
			expect(r.iconTitle).toBeNull();
			expect(r.nameTitle).toBeNull();
		}
		// Row height / font are the same for link rows and plain rows.
		const heights = new Set(Object.values(rows).map((r) => Math.round(r.rowRect.height * 10) / 10));
		expect(heights.size).toBe(1);
		expect(rows['link-file.md']!.nameWeight).toBe(rows['a-plain.md']!.nameWeight);
		expect(rows['link-dir']!.nameWeight).toBe(rows['a-plain-dir']!.nameWeight);

		report(REPORT, {
			gate: '70-1',
			rows: Object.fromEntries(
				Object.entries(rows).map(([n, r]) => [
					n,
					{ classes: r.classes, icon: r.iconText, badge: r.badge?.rect ?? null, height: r.rowRect.height },
				]),
			),
		});
		await shot('req70-gate1-tree-100pct');
		const t = await treeRect();
		const first = rows['a-plain-dir']!.rowRect;
		const last = Object.values(rows).reduce((m, r) => Math.max(m, r.rowRect.y + r.rowRect.height), 0);
		await zoomedShot(
			'req70-gate1-tree-100pct-crop-x4',
			{ x: t.x, y: first.y - 30, width: Math.min(t.width, 260), height: last - first.y + 40 },
			4,
		);
	});

	it('gate 2: .icon/.name carry the two-line link tooltip; the row title stays the URI', async () => {
		for (const [name, l] of Object.entries(links)) {
			const u = uri(path.join(gateDir, name));
			const r = (await rowInfo(u))!;
			const label = l.kind === 'broken' ? 'Broken symbolic link' : 'Symbolic link';
			const expected = `${u}\n${label} → ${l.target}`;
			expect(r.rowTitle).toBe(u);
			expect(r.iconTitle).toBe(expected);
			expect(r.nameTitle).toBe(expected);
		}
		report(REPORT, {
			gate: '70-2-tooltip',
			sample: (await rowInfo(uri(path.join(gateDir, 'link-outside-file.md'))))!.nameTitle,
		});
	});

	// Go to a file opens it and selects its row; Go to a folder that has files
	// expands it and opens its first file (requirement #60 behaviour table 2),
	// so for the folder link the selected row is `zz-link-dir/inner.md`.
	for (const [target, selects] of [
		['zz-link-file.md', 'zz-link-file.md'],
		['zz-link-dir', 'zz-link-dir/inner.md'],
	] as const) {
		it(`gate 2: Go to Path reaches the link row ${target} and brings it into view`, async () => {
			const targetPath = path.join(deepDir, target);
			const targetUri = uri(targetPath);
			const selectedUri = uri(path.join(deepDir, selects));
			// Start from a tree scrolled to the top with zz-deep collapsed, so the
			// row is not even rendered before the jump.
			await browser.execute((deep) => {
				const rows = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item'));
				const row = rows.find((r) => r.title === deep);
				if (row && rows.some((r) => r.title.startsWith(`${deep}/`))) row.click();
				document.querySelector('nav.explorer-list')?.scrollTo(0, 0);
			}, uri(deepDir));
			await browser.waitUntil(async () => !(await rowVisibleInTree(targetUri)).present, {
				timeout: 5_000,
				timeoutMsg: 'zz-deep did not collapse before the jump',
			});
			await emitMenu('menu_go_to');
			await browser.waitUntil(
				async () => browser.execute(() => !!document.querySelector('[data-testid="go-to-input"]')),
				{ timeout: 5_000, timeoutMsg: 'Go to bar did not open on menu_go_to' },
			);
			await browser.execute((p) => {
				const input = document.querySelector<HTMLInputElement>('[data-testid="go-to-input"]')!;
				input.value = p;
				input.dispatchEvent(new Event('input', { bubbles: true }));
				document.querySelector<HTMLButtonElement>('[data-testid="go-to-go"]')!.click();
			}, targetPath);
			await browser.waitUntil(
				async () =>
					(await rowVisibleInTree(targetUri)).visible &&
					((await rowInfo(selectedUri))?.classes ?? []).includes('active'),
				{ timeout: 10_000, timeoutMsg: `${target} was not brought into the visible tree / ${selects} not selected` },
			);
			const v = await rowVisibleInTree(targetUri);
			const r = (await rowInfo(targetUri))!;
			const bar = await browser.execute(() => !!document.querySelector('[data-testid="go-to-bar"]'));
			expect(r.classes).toContain('is-link');
			expect(bar).toBe(false);
			report(REPORT, { gate: '70-2-goto', target, selected: selects, visible: v, classes: r.classes });
			await shot(`req70-gate2-goto-${target.replace(/\W+/g, '-')}`);
		});
	}

	it('gate 3: the broken link’s name is muted and its badge is secondary (追補a); clicking it (plain / Command / Shift) does nothing', async () => {
		const brokenUri = uri(path.join(gateDir, 'link-broken.md'));
		const linkUri = uri(path.join(gateDir, 'link-file.md'));
		const broken = (await rowInfo(brokenUri))!;
		const normal = (await rowInfo(linkUri))!;
		// Token values are `#rrggbb` in theme.css while computed colours come back
		// as `rgb(...)`; compare through parseColor (as gate 4 does for contrast).
		const tokens = await browser.execute(() => {
			const cs = getComputedStyle(document.documentElement);
			return {
				muted: cs.getPropertyValue('--color-text-muted').trim(),
				secondary: cs.getPropertyValue('--color-text-secondary').trim(),
			};
		});
		// Requirement #70 契約6 + 追補a: the name stays --color-text-muted, the badge
		// is drawn in --color-text-secondary (WCAG 1.4.11), and both differ from
		// the name colour of a normal link.
		expect(parseColor(broken.nameColor)).toEqual(parseColor(tokens.muted));
		expect(parseColor(broken.badge!.color)).toEqual(parseColor(tokens.secondary));
		expect(broken.nameColor).not.toBe(normal.nameColor);
		expect(broken.badge!.color).not.toBe(normal.nameColor);
		report(REPORT, {
			gate: '70-3-colour',
			mutedToken: tokens.muted,
			secondaryToken: tokens.secondary,
			brokenName: broken.nameColor,
			brokenBadge: broken.badge!.color,
			linkName: normal.nameColor,
			linkBadge: normal.badge!.color,
		});

		// Show a document first, so "nothing happened" has something to keep.
		await clickExplorerRow(uri(path.join(gateDir, 'a-plain.md')));
		await browser.waitUntil(
			async () =>
				browser.execute(() => (document.querySelector('article.viewer .markdown-body h1')?.textContent ?? '') === 'Plain file'),
			{ timeout: 10_000, timeoutMsg: 'a-plain.md did not open' },
		);
		const before = await browser.execute(() => ({
			body: document.querySelector('article.viewer .markdown-body')?.innerHTML ?? '',
			active: document.querySelector<HTMLElement>('.explorer-item.active')?.title ?? null,
		}));
		// Anything that would open a window/tab or a document is stopped at the
		// IPC layer even if the guard were missing, so a regression cannot open
		// a window on the user's screen.
		await setIpcBlock(['open_document', 'open_binary_document', 'new_tab', 'new_window']);
		await clearIpcLog();
		for (const mods of [{}, { metaKey: true }, { shiftKey: true }]) {
			await clickExplorerRow(brokenUri, mods);
		}
		await browser.pause(1_500);
		const rec = await readGateRecord();
		const after = await browser.execute(() => ({
			body: document.querySelector('article.viewer .markdown-body')?.innerHTML ?? '',
			active: document.querySelector<HTMLElement>('.explorer-item.active')?.title ?? null,
		}));
		await setIpcBlock([]);
		const opening = rec.ipc.filter((c) =>
			['open_document', 'open_binary_document', 'new_tab', 'new_window', 'unsubscribe_file', 'subscribe_file'].includes(c),
		);
		report(REPORT, { gate: '70-3-click', ipcAfterClicks: rec.ipc, dialogs: rec.dialogs, sameBody: before.body === after.body, activeBefore: before.active, activeAfter: after.active });
		expect(opening).toEqual([]);
		expect(rec.dialogs).toEqual([]);
		expect(after.body).toBe(before.body);
		expect(after.active).toBe(before.active);
		await shot('req70-gate3-broken-after-clicks');
	});

	it('gate 4: tree zoom scales the badge; badge contrast on plain / hover / selected rows', async () => {
		const linkUri = uri(path.join(gateDir, 'link-file.md'));
		const brokenUri = uri(path.join(gateDir, 'link-broken.md'));
		// Collapse zz-deep (Go to expanded it) so all link rows fit on screen.
		await browser.execute((deep) => {
			const rows = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item'));
			const row = rows.find((r) => r.title === deep);
			if (row && rows.some((r) => r.title.startsWith(`${deep}/`))) row.click();
			document.querySelector('nav.explorer-list')?.scrollTo(0, 0);
		}, uri(deepDir));
		await browser.pause(300);
		await pointAtRegion('aside.explorer');
		await emitMenu('menu_zoom_reset');
		await browser.pause(200);
		const base = (await rowInfo(linkUri))!;
		const sizes: Record<string, { badge: number; row: number; insideIcon: boolean }> = {};
		const levelOf = () =>
			browser.execute(() => (document.querySelector<HTMLElement>('nav.explorer-list')?.style.zoom || '100%'));
		const measure = async (label: string) => {
			const r = (await rowInfo(linkUri))!;
			sizes[label] = {
				badge: r.badge!.rect.width,
				row: r.rowRect.height,
				insideIcon: r.badge!.insideIcon,
			};
		};
		await measure('100%');
		for (let i = 0; i < 10; i++) await emitMenu('menu_zoom_in');
		await browser.pause(200);
		const zIn = await levelOf();
		await measure(zIn);
		await shot(`req70-gate4-tree-zoom-${zIn.replace('%', 'pct')}`);
		// The file links sit lower in the tree; bring them into view for a second shot.
		await browser.execute((target) => {
			Array.from(document.querySelectorAll<HTMLElement>('.explorer-item'))
				.find((r) => r.title === target)
				?.scrollIntoView({ block: 'center' });
		}, linkUri);
		await shot(`req70-gate4-tree-zoom-${zIn.replace('%', 'pct')}-file-links`);
		await emitMenu('menu_zoom_reset');
		for (let i = 0; i < 10; i++) await emitMenu('menu_zoom_out');
		await browser.pause(200);
		const zOut = await levelOf();
		await measure(zOut);
		await shot(`req70-gate4-tree-zoom-${zOut.replace('%', 'pct')}`);
		await emitMenu('menu_zoom_reset');
		await browser.pause(200);

		const ratioIn = sizes[zIn]!.badge / sizes['100%']!.badge;
		const ratioOut = sizes[zOut]!.badge / sizes['100%']!.badge;
		report(REPORT, { gate: '70-4-zoom', levels: [zIn, zOut], sizes, ratioIn, ratioOut, baseBadge: base.badge!.rect });
		expect(Math.abs(ratioIn - parseInt(zIn, 10) / 100)).toBeLessThan(0.05);
		expect(Math.abs(ratioOut - parseInt(zOut, 10) / 100)).toBeLessThan(0.05);
		for (const s of Object.values(sizes)) expect(s.insideIcon).toBe(true);

		// Contrast. The badge draws the arrow (stroke = currentColor) on its own
		// rounded square (fill = --color-bg-primary, outline = currentColor), so
		// two pairs matter: arrow vs. the square, and the square's outline vs.
		// the row background it sits on (plain / hover / selected).
		const contrasts: Record<string, Record<string, number | string>> = {};
		const record = async (state: string, u: string) => {
			const r = (await rowInfo(u))!;
			const bg = await effectiveBackground(u);
			contrasts[`${state} ${u.endsWith('link-broken.md') ? 'broken' : 'link'}`] = {
				rowBackground: bg,
				arrow: r.badge!.stroke,
				badgeFill: r.badge!.bgFill,
				arrowVsBadgeFill: contrastRatio(r.badge!.stroke, r.badge!.bgFill),
				outlineVsRow: contrastRatio(r.badge!.bgStroke, bg),
				badgeFillVsRow: contrastRatio(r.badge!.bgFill, bg),
				nameVsRow: contrastRatio(r.nameColor, bg),
			};
		};
		// plain
		await record('plain', linkUri);
		await record('plain', brokenUri);
		// hover (same token as `.explorer-item:hover`, applied through a class)
		await browser.execute(() => {
			const s = document.createElement('style');
			s.id = 'gate-hover-sim';
			s.textContent = '.explorer-item.gate-hover{background-color:var(--color-bg-tree-hover)}';
			document.head.appendChild(s);
		});
		for (const u of [linkUri, brokenUri]) {
			await browser.execute((target) => {
				Array.from(document.querySelectorAll<HTMLElement>('.explorer-item'))
					.find((r) => r.title === target)
					?.classList.add('gate-hover');
			}, u);
			await record('hover', u);
		}
		const tr = await treeRect();
		await zoomedShot('req70-gate4-hover-sim-crop-x4', { x: tr.x, y: (await rowInfo(linkUri))!.rowRect.y - 60, width: Math.min(tr.width, 260), height: 200 }, 4);
		await browser.execute(() => {
			document.querySelectorAll('.gate-hover').forEach((el) => el.classList.remove('gate-hover'));
			document.getElementById('gate-hover-sim')?.remove();
		});
		// selected: clicking the file link opens it and selects the row
		await clickExplorerRow(linkUri);
		await browser.waitUntil(
			async () => ((await rowInfo(linkUri))?.classes ?? []).includes('active'),
			{ timeout: 10_000, timeoutMsg: 'link-file.md did not become the selected row' },
		);
		await record('selected', linkUri);
		const selectedRow = (await rowInfo(linkUri))!;
		expect(selectedRow.nameWeight).toBe('600');
		await zoomedShot('req70-gate4-selected-crop-x4', { x: tr.x, y: (await rowInfo(linkUri))!.rowRect.y - 60, width: Math.min(tr.width, 260), height: 200 }, 4);
		// A broken link cannot be selected by clicking; select it through Go to.
		await emitMenu('menu_go_to');
		await browser.waitUntil(
			async () => browser.execute(() => !!document.querySelector('[data-testid="go-to-input"]')),
			{ timeout: 5_000 },
		);
		await browser.execute((p) => {
			const input = document.querySelector<HTMLInputElement>('[data-testid="go-to-input"]')!;
			input.value = p;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector<HTMLButtonElement>('[data-testid="go-to-go"]')!.click();
		}, path.join(gateDir, 'link-broken.md'));
		await browser.pause(1_000);
		const brokenSel = (await rowInfo(brokenUri))!;
		if (brokenSel.classes.includes('active')) {
			await record('selected', brokenUri);
		} else {
			// Neither a click nor Go to selects a broken link (Go to reports that the
			// path is not found), so its "selected" contrast is taken with the same
			// tokens as `.explorer-item.active`, applied through a class.
			await browser.execute((target) => {
				const s = document.createElement('style');
				s.id = 'gate-active-sim';
				s.textContent =
					'.explorer-item.gate-active{background-color:var(--color-bg-tree-active);font-weight:600}';
				document.head.appendChild(s);
				Array.from(document.querySelectorAll<HTMLElement>('.explorer-item'))
					.find((r) => r.title === target)
					?.classList.add('gate-active');
			}, brokenUri);
			await record('selected(simulated)', brokenUri);
			await zoomedShot('req70-gate4-selected-broken-sim-crop-x4', { x: tr.x, y: (await rowInfo(brokenUri))!.rowRect.y - 60, width: Math.min(tr.width, 260), height: 200 }, 4);
			await browser.execute(() => {
				document.querySelectorAll('.gate-active').forEach((el) => el.classList.remove('gate-active'));
				document.getElementById('gate-active-sim')?.remove();
			});
		}
		report(REPORT, { gate: '70-4-goto-broken', classes: brokenSel.classes, record: await readGateRecord().then((r) => r.dialogs) });
		await browser.execute(() => {
			if (document.querySelector('[data-testid="go-to-close"]')) {
				document.querySelector<HTMLButtonElement>('[data-testid="go-to-close"]')!.click();
			}
		});
		report(REPORT, { gate: '70-4-contrast', contrasts });
		// The arrow must stay legible on its own square in every state.
		for (const c of Object.values(contrasts)) expect(Number(c.arrowVsBadgeFill)).toBeGreaterThanOrEqual(3);
	});
});
