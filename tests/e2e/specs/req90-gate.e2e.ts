import { browser } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
	clickExplorerRow,
	emitEvent,
	emitMenu,
	installGateRecorder,
	mdFaceText,
	readCapturedIpc,
	report,
	restoreGateRecorder,
	setIpcCapture,
	SHOTS_DIR,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

/**
 * Requirement #90 (GitHub Alerts: hide / show / fold from the screen) — AC-90-10, the device gate against the
 * live webview of a webdriver build on a real screen (docs/requirements/req-90.md 契約 1〜10).
 *
 * Webdriver only where possible, no operator. The native menu is read and pressed by AX: `axtool menudetail`
 * (View has an "Alerts" submenu) and, when `VELLIS_GATE_SUBMENU` points at a build of
 * scripts/gate-device/submenu.swift, `submenu items / press <pid> View Alerts <item>` for the submenu's items
 * (the same way req56 drives View ▸ Appearance). Without it the gate emits the same events the menu items emit
 * (`menu_alerts_toggle_kind` with the kind as payload, `menu_alerts_show_all`, `menu_alerts_hide_all`) and notes
 * the skipped AX judgement. Option + Command + A is pressed as a real key only when `VELLIS_GATE_REALINPUT` is set
 * (realinput.swift, Accessibility-trusted); otherwise the toggle rule is judged through the enabled state of
 * Show All / Hide All (AX) and by pressing the enabled one.
 *
 * Fixture (run-gate-spec.sh `req90`): script.md — a YouTube-script-like document: dialogue paragraphs and
 * NOTE / TIP / WARNING alerts (the same text as the jsdom wiring tests). Top-level blocks:
 * 0 heading / 1 dialogue / 2 NOTE / 3 TIP / 4 dialogue / 5 WARNING / 6 NOTE / 7 WARNING / 8 dialogue.
 *
 * What the gate judges (one JSON line per judgement in `$VELLIS_GATE_SHOTS/req90-report.jsonl`):
 *  - (1) View ▸ Alerts exists in the menu bar (AX); its items are Show All Alerts / Hide All Alerts / ─ / Note / Tip /
 *        Important / Warning / Caution; at the start Show All is disabled and Hide All enabled (契約1)
 *  - (2) hiding NOTE → the two NOTE alerts are not displayed (computed display none), two markers "NOTE 1" are on
 *        screen (a thin line: the marker is visible and low); hiding WARNING too → one marker "WARNING 2 · NOTE 1"
 *        for the three consecutive alerts (契約2); the dialogue is still visible
 *  - (3) clicking the marker's label reveals just those alerts; the setting (localStorage `vellis.alerts`) is unchanged
 *  - (4) clicking TIP's title folds it (data-alert-state collapsed, data-alert-summary, lower than before); again unfolds (契約3)
 *  - (5) the toggle rule: with some kinds shown, Hide All Alerts is the enabled item (Option + Command + A hides all);
 *        with all hidden, Show All Alerts is the enabled one (the key shows all) (契約1)
 *  - (6) print: `beforeprint` renders the print document without the hidden alerts and without markers, the folded
 *        alert folded (契約6). The real print panel is not opened (webdriver only)
 *  - (7) nothing is written: the file's bytes are unchanged, no Unsaved badge, no save_document (契約4);
 *        Raw Source shows all five alerts (契約8)
 *  - (8) persistence: localStorage holds the setting; `restart` (VELLIS_GATE_VARIANT, same home) opens the file and
 *        finds NOTE hidden without any action, TIP not folded (契約7)
 *  - the last `it` fails when any judgement failed, so the wdio exit status is the verdict
 *
 * Build and run:
 *   pnpm tauri build --debug --no-bundle -f webdriver
 *   cp src-tauri/target/debug/vellis <out>/vellis-gate90
 *   xcrun swiftc -O scripts/gate-device/axtool.swift -o <out>/axtool
 *   xcrun swiftc -O scripts/gate-device/submenu.swift -o <out>/submenu        # optional, for the AX submenu judgements
 *   export VELLIS_GATE_BIN=<out>/vellis-gate90 VELLIS_GATE_AXTOOL=<out>/axtool VELLIS_GATE_OUT=<out> VELLIS_GATE_SUBMENU=<out>/submenu
 *   VELLIS_GATE_HOME=<tmp> scripts/gate-device/run-gate-spec.sh req90 main
 *   VELLIS_GATE_HOME=<tmp> scripts/gate-device/run-gate-spec.sh req90 restart
 * Runs only under that script (VELLIS_GATE_DEVICE=1); self-skipping otherwise.
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const VARIANT = process.env.VELLIS_GATE_VARIANT ?? 'main';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const REPORT = 'req90-report.jsonl';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const submenuTool = process.env.VELLIS_GATE_SUBMENU ?? '';
const realinput = process.env.VELLIS_GATE_REALINPUT ?? '';
const bin = process.env.VELLIS_GATE_BIN ?? '';

const fileOf = (rel: string) => path.join(root, rel);
const uriOf = (rel: string) => `file://${fileOf(rel).split(path.sep).join('/')}`;
const FIXTURE = 'script.md';

const BODY = 'article.viewer .markdown-body';
const PM = `${BODY} [data-testid="markdown-editor"] .ProseMirror`;
const ALERT = `${PM} blockquote.markdown-alert`;
const MARKER = `${PM} .vellis-alert-marker`;
const RAW_SOURCE = `${BODY} [data-testid="markdown-editor"] [data-testid="raw-source-editor"]`;
const BADGE = 'article.viewer [data-testid="unsaved-badge"]';
const PRINT = '[data-testid="markdown-editor-print"]';
const STORAGE_KEY = 'vellis.alerts';
const ALERTS_ITEMS = ['Show All Alerts', 'Hide All Alerts', '', 'Note', 'Tip', 'Important', 'Warning', 'Caution'];

// --- judgement ---------------------------------------------------------------------------------

const fails: string[] = [];
function judge(gate: string, item: string, pass: boolean, extra: Record<string, unknown> = {}): boolean {
	report(REPORT, { gate, item, pass, variant: VARIANT, ...extra });
	if (!pass) fails.push(`${gate}: ${item}`);
	return pass;
}
function fact(gate: string, item: string, extra: Record<string, unknown> = {}): void {
	report(REPORT, { gate, item, variant: VARIANT, ...extra });
}
function skipped(gate: string, item: string, why: string): void {
	report(REPORT, { gate, item, variant: VARIANT, note: `skipped: ${why}` });
}

// --- AX (the native menu) ------------------------------------------------------------------------

function appPid(): number | null {
	if (!axtool || !bin) return null;
	try {
		const env = { ...process.env, AXTOOL_EXPECT_EXE: bin };
		const first = execFileSync(axtool, ['pids-of-exe', bin], { encoding: 'utf8', env, timeout: 30_000 }).trim().split('\n')[0];
		return first ? (JSON.parse(first) as { pid: number }).pid : null;
	} catch {
		return null;
	}
}
interface MenuItemFacts {
	title: string;
	enabled: boolean;
	separator?: boolean;
	submenu?: boolean;
}
function viewMenuDetail(pid: number): MenuItemFacts[] | null {
	try {
		const env = { ...process.env, AXTOOL_EXPECT_EXE: bin };
		const out = execFileSync(axtool, ['menudetail', String(pid), 'View'], { encoding: 'utf8', env, timeout: 30_000 });
		return out
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as MenuItemFacts);
	} catch {
		return null;
	}
}
function alertsItems(pid: number): MenuItemFacts[] | null {
	if (!submenuTool) return null;
	try {
		const env = { ...process.env, AXTOOL_EXPECT_EXE: bin };
		const out = execFileSync(submenuTool, ['items', String(pid), 'View', 'Alerts'], { encoding: 'utf8', env, timeout: 30_000 });
		return out
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as MenuItemFacts);
	} catch {
		return null;
	}
}
function pressAlertsItem(pid: number, item: string): { pressed: boolean; detail: string } {
	if (!submenuTool) return { pressed: false, detail: 'VELLIS_GATE_SUBMENU not set' };
	try {
		const env = { ...process.env, AXTOOL_EXPECT_EXE: bin };
		const out = execFileSync(submenuTool, ['press', String(pid), 'View', 'Alerts', item], { encoding: 'utf8', env, timeout: 30_000 }).trim();
		return { pressed: true, detail: out };
	} catch (e) {
		const err = e as { stderr?: string; message?: string };
		return { pressed: false, detail: err.stderr?.trim() || err.message || String(e) };
	}
}
/** Option + Command + A as a real key (keycode 0 = A on the US layout), only with realinput. */
function pressOptionCommandA(pid: number): { pressed: boolean; detail: string } {
	if (!realinput) return { pressed: false, detail: 'VELLIS_GATE_REALINPUT not set' };
	try {
		const env = { ...process.env, AXTOOL_EXPECT_EXE: bin, REALINPUT_EXPECT_EXE: bin };
		const trusted = execFileSync(realinput, ['trusted'], { encoding: 'utf8', env, timeout: 30_000 });
		if (!trusted.includes('"trusted":true')) return { pressed: false, detail: 'realinput is not Accessibility-trusted' };
		const out = execFileSync(realinput, ['key', String(pid), '0', 'cmd', 'opt'], { encoding: 'utf8', env, timeout: 30_000 }).trim();
		return { pressed: true, detail: out };
	} catch (e) {
		const err = e as { stderr?: string; message?: string };
		return { pressed: false, detail: err.stderr?.trim() || err.message || String(e) };
	}
}

/** Toggle one kind: through the menu bar when the submenu tool is there, else by the event the item emits. */
async function toggleKind(pid: number | null, kind: 'note' | 'tip' | 'important' | 'warning' | 'caution'): Promise<string> {
	const title = kind[0]!.toUpperCase() + kind.slice(1);
	if (pid !== null && submenuTool) {
		const r = pressAlertsItem(pid, title);
		if (r.pressed) {
			await browser.pause(500);
			return `ax:${r.detail}`;
		}
	}
	await emitEvent('menu_alerts_toggle_kind', kind);
	await browser.pause(500);
	return 'event';
}
async function pressAll(pid: number | null, which: 'Show All Alerts' | 'Hide All Alerts'): Promise<string> {
	if (pid !== null && submenuTool) {
		const r = pressAlertsItem(pid, which);
		if (r.pressed) {
			await browser.pause(500);
			return `ax:${r.detail}`;
		}
	}
	await emitMenu(which === 'Show All Alerts' ? 'menu_alerts_show_all' : 'menu_alerts_hide_all');
	await browser.pause(500);
	return 'event';
}

// --- the page ----------------------------------------------------------------------------------

interface AlertFacts {
	kind: string | null;
	state: string | null;
	hiddenAttr: boolean;
	display: string;
	height: number;
	summary: string | null;
	titleText: string;
}
async function alertFacts(): Promise<AlertFacts[]> {
	return browser.execute(
		(sel) =>
			Array.from(document.querySelectorAll<HTMLElement>(sel)).map((el) => {
				const r = el.getBoundingClientRect();
				return {
					kind: el.getAttribute('data-alert-kind'),
					state: el.getAttribute('data-alert-state'),
					hiddenAttr: el.hidden,
					display: getComputedStyle(el).display,
					height: Math.round(r.height),
					summary: el.getAttribute('data-alert-summary'),
					titleText: el.querySelector('.markdown-alert-title')?.textContent ?? '',
				};
			}),
		ALERT,
	);
}
interface MarkerFacts {
	counts: string | null;
	label: string | null;
	labelText: string;
	height: number;
	width: number;
	display: string;
	labelVisible: boolean;
	group: string[];
}
async function markerFacts(): Promise<MarkerFacts[]> {
	return browser.execute(
		(sel) =>
			Array.from(document.querySelectorAll<HTMLElement>(sel)).map((m) => {
				const r = m.getBoundingClientRect();
				const label = m.querySelector<HTMLElement>('[data-testid="alert-marker-label"]');
				const lr = label?.getBoundingClientRect();
				const group: string[] = [];
				let el = m.nextElementSibling as HTMLElement | null;
				while (el && el.matches('blockquote.markdown-alert[data-alert-state="hidden"]')) {
					group.push(el.getAttribute('data-alert-kind') ?? '?');
					el = el.nextElementSibling as HTMLElement | null;
				}
				return {
					counts: m.getAttribute('data-alert-counts'),
					label: label?.getAttribute('aria-label') ?? null,
					labelText: (label?.textContent ?? '').trim(),
					height: Math.round(r.height),
					width: Math.round(r.width),
					display: getComputedStyle(m).display,
					labelVisible: !!lr && lr.width > 0 && lr.height > 0,
					group,
				};
			}),
		MARKER,
	);
}
async function states(): Promise<(string | null)[]> {
	return (await alertFacts()).map((a) => a.state);
}
async function clickMarkerLabel(index: number): Promise<boolean> {
	return browser.execute(
		(sel, i) => {
			const m = document.querySelectorAll<HTMLElement>(sel)[i];
			const label = m?.querySelector<HTMLElement>('[data-testid="alert-marker-label"]');
			if (!label) return false;
			for (const type of ['mousedown', 'mouseup', 'click']) {
				label.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'mousedown' ? 1 : 0 }));
			}
			return true;
		},
		MARKER,
		index,
	);
}
async function clickTitle(index: number): Promise<boolean> {
	return browser.execute(
		(sel, i) => {
			const alert = document.querySelectorAll<HTMLElement>(sel)[i];
			const title = alert?.querySelector<HTMLElement>('.markdown-alert-title');
			if (!title) return false;
			for (const type of ['mousedown', 'mouseup', 'click']) {
				title.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'mousedown' ? 1 : 0 }));
			}
			return true;
		},
		ALERT,
		index,
	);
}
/** The lines of the Raw Source face (CodeMirror inside `[data-testid="raw-source-editor"]`); null when it is not up. */
async function rawSourceLines(): Promise<string[] | null> {
	return browser.execute((sel) => {
		const root = document.querySelector(sel);
		if (!root) return null;
		return Array.from(root.querySelectorAll<HTMLElement>('.cm-line')).map((l) => l.textContent ?? '');
	}, RAW_SOURCE);
}
async function storedSetting(): Promise<string | null> {
	return browser.execute((k) => localStorage.getItem(k), STORAGE_KEY);
}
async function exists(sel: string): Promise<boolean> {
	return browser.execute((s) => document.querySelector(s) !== null, sel);
}
async function dialogueVisible(): Promise<boolean> {
	return browser.execute((sel) => {
		const ps = Array.from(document.querySelectorAll<HTMLElement>(`${sel} > p`));
		const p = ps.find((x) => (x.textContent ?? '').includes('Today we talk about desk printers.'));
		if (!p) return false;
		const r = p.getBoundingClientRect();
		return getComputedStyle(p).display !== 'none' && r.height > 0;
	}, PM);
}
async function shot(name: string): Promise<string> {
	const file = path.join(SHOTS_DIR, `${name}.png`);
	fs.mkdirSync(SHOTS_DIR, { recursive: true });
	await browser.saveScreenshot(file);
	return file;
}
async function openScript(): Promise<void> {
	await clickExplorerRow(uriOf(FIXTURE));
	await browser.waitUntil(async () => ((await mdFaceText()) ?? '').includes('Episode 12 script'), { timeout: 20_000, timeoutMsg: `open ${FIXTURE}` });
	await browser.waitUntil(async () => (await alertFacts()).length === 5, { timeout: 10_000, timeoutMsg: 'five alerts in the face' });
	await browser.pause(600);
}

// --- the gates ---------------------------------------------------------------------------------

async function gateMenu(pid: number | null): Promise<void> {
	if (pid === null) {
		skipped('1', 'View ▸ Alerts by AX', 'no app pid (axtool / VELLIS_GATE_BIN)');
		return;
	}
	const view = viewMenuDetail(pid);
	const alertsEntry = view?.find((i) => i.title === 'Alerts');
	judge('1', 'View holds an "Alerts" submenu (AX menudetail)', !!alertsEntry && alertsEntry.submenu === true, { view: view?.map((i) => i.title) });
	const items = alertsItems(pid);
	if (!items) {
		skipped('1', 'the items of View ▸ Alerts', submenuTool ? 'submenu tool failed' : 'VELLIS_GATE_SUBMENU not set');
		return;
	}
	judge('1', 'View ▸ Alerts = Show All Alerts / Hide All Alerts / ─ / Note / Tip / Important / Warning / Caution', JSON.stringify(items.map((i) => i.title)) === JSON.stringify(ALERTS_ITEMS), { items });
	const showAll = items.find((i) => i.title === 'Show All Alerts');
	const hideAll = items.find((i) => i.title === 'Hide All Alerts');
	judge('1', 'with everything shown, Show All Alerts is disabled and Hide All Alerts is enabled (the key hides all)', showAll?.enabled === false && hideAll?.enabled === true, { showAll, hideAll });
}

async function gateHideKinds(pid: number | null): Promise<void> {
	const before = await alertFacts();
	judge('2', 'five alerts, all shown, no marker at the start', before.length === 5 && before.every((a) => a.state === 'shown' && a.display !== 'none') && (await markerFacts()).length === 0, { before });
	const how = await toggleKind(pid, 'note');
	await browser.waitUntil(async () => (await states())[0] === 'hidden', { timeout: 5_000 }).catch(() => undefined);
	const after = await alertFacts();
	const ms = await markerFacts();
	judge('2', 'hiding NOTE: the two NOTE alerts are hidden (data-alert-state, hidden attribute, computed display none)', JSON.stringify(after.map((a) => a.state)) === JSON.stringify(['hidden', 'shown', 'shown', 'hidden', 'shown']) && after[0]!.hiddenAttr && after[3]!.hiddenAttr && after[0]!.display === 'none' && after[3]!.display === 'none', { how, after });
	judge('2', 'two markers "NOTE 1", each before its NOTE, visible as a thin line (1〜40 px high) with a visible label and no text of its own', ms.length === 2 && ms.every((m) => m.label === 'NOTE 1' && m.counts === 'note:1' && m.labelText === '' && m.display !== 'none' && m.height >= 1 && m.height <= 40 && m.width > 0 && m.labelVisible && m.group.length === 1 && m.group[0] === 'note'), { markers: ms });
	judge('2', 'the dialogue stays visible', await dialogueVisible(), {});
	fact('2', 'screenshot with NOTE hidden', { file: await shot('req90-2-note-hidden') });
	const how2 = await toggleKind(pid, 'warning');
	await browser.waitUntil(async () => (await states())[2] === 'hidden', { timeout: 5_000 }).catch(() => undefined);
	const ms2 = await markerFacts();
	judge('2', 'hiding WARNING too: blocks 5〜7 are consecutive → one marker "WARNING 2 · NOTE 1" for the three, the first NOTE keeps its own', ms2.length === 2 && ms2[0]!.label === 'NOTE 1' && ms2[1]!.label === 'WARNING 2 · NOTE 1' && ms2[1]!.counts === 'warning:2,note:1' && JSON.stringify(ms2[1]!.group) === JSON.stringify(['warning', 'note', 'warning']), { how: how2, markers: ms2 });
	fact('2', 'screenshot with NOTE and WARNING hidden', { file: await shot('req90-2-note-warning-hidden') });
}

async function gateRevealByLabel(): Promise<void> {
	const settingBefore = await storedSetting();
	const ok = await clickMarkerLabel(1);
	await browser.pause(500);
	const after = await alertFacts();
	const ms = await markerFacts();
	judge('3', 'clicking the label of the second marker reveals its three alerts; the first marker stays', ok && JSON.stringify(after.map((a) => a.state)) === JSON.stringify(['hidden', 'shown', 'shown', 'shown', 'shown']) && after.slice(2).every((a) => a.display !== 'none') && ms.length === 1 && ms[0]!.label === 'NOTE 1', { after, markers: ms });
	judge('3', 'the setting (localStorage vellis.alerts) is unchanged by the reveal', (await storedSetting()) === settingBefore && settingBefore !== null && (JSON.parse(settingBefore!) as { note: boolean; warning: boolean }).note === false, { setting: settingBefore });
	fact('3', 'screenshot after the reveal', { file: await shot('req90-3-revealed') });
}

async function gateFold(): Promise<void> {
	const before = (await alertFacts())[1]!;
	const ok = await clickTitle(1);
	await browser.pause(500);
	const folded = (await alertFacts())[1]!;
	judge('4', 'clicking TIP’s title folds it: data-alert-state collapsed, data-alert-summary with the first words, still displayed but lower than before', ok && folded.state === 'collapsed' && (folded.summary ?? '').startsWith('Card: Episode 12') && folded.display !== 'none' && folded.height > 0 && folded.height < before.height, { before, folded });
	fact('4', 'screenshot with TIP folded', { file: await shot('req90-4-folded') });
	await clickTitle(1);
	await browser.pause(500);
	const again = (await alertFacts())[1]!;
	judge('4', 'clicking the title again unfolds it (shown, no summary, the height is back)', again.state === 'shown' && again.summary === null && again.height >= before.height - 2, { again });
	// fold it again for the print gate
	await clickTitle(1);
	await browser.pause(300);
}

async function gateToggleAll(pid: number | null): Promise<void> {
	// state here: NOTE hidden (one marker), WARNING hidden by setting but revealed by the label, TIP folded
	const items = pid !== null ? alertsItems(pid) : null;
	if (items) {
		const showAll = items.find((i) => i.title === 'Show All Alerts');
		const hideAll = items.find((i) => i.title === 'Hide All Alerts');
		judge('5', 'with some kinds shown (TIP, IMPORTANT, CAUTION), Hide All Alerts is the enabled item and Show All Alerts is disabled', showAll?.enabled === false && hideAll?.enabled === true, { showAll, hideAll });
	} else {
		skipped('5', 'enabled state of Show All / Hide All by AX', submenuTool ? 'submenu tool failed' : 'VELLIS_GATE_SUBMENU not set');
	}
	let how = 'event';
	const key = pid !== null ? pressOptionCommandA(pid) : { pressed: false, detail: 'no pid' };
	if (key.pressed) {
		how = `realinput:${key.detail}`;
		await browser.pause(600);
	} else {
		fact('5', 'Option + Command + A as a real key was not sent', { reason: key.detail });
		how = await pressAll(pid, 'Hide All Alerts');
	}
	await browser.waitUntil(async () => (await states()).every((s) => s === 'hidden'), { timeout: 5_000 }).catch(() => undefined);
	const hidden = await alertFacts();
	const ms = await markerFacts();
	judge('5', 'Option + Command + A (or the enabled Hide All Alerts) with some kinds shown → all five hidden, markers "NOTE 1 · TIP 1" and "WARNING 2 · NOTE 1"', hidden.every((a) => a.state === 'hidden' && a.display === 'none') && ms.map((m) => m.label).join('|') === 'NOTE 1 · TIP 1|WARNING 2 · NOTE 1', { how, hidden, markers: ms });
	const setting = await storedSetting();
	judge('5', 'the setting now hides all five kinds', setting !== null && Object.values(JSON.parse(setting!) as Record<string, boolean>).every((x) => x === false), { setting });
	const items2 = pid !== null ? alertsItems(pid) : null;
	if (items2) {
		const showAll = items2.find((i) => i.title === 'Show All Alerts');
		const hideAll = items2.find((i) => i.title === 'Hide All Alerts');
		judge('5', 'with everything hidden, Show All Alerts is the enabled item and Hide All Alerts is disabled (the key now shows all)', showAll?.enabled === true && hideAll?.enabled === false, { showAll, hideAll });
	}
	fact('5', 'screenshot with everything hidden', { file: await shot('req90-5-all-hidden') });
	let how2 = 'event';
	const key2 = pid !== null ? pressOptionCommandA(pid) : { pressed: false, detail: 'no pid' };
	if (key2.pressed) {
		how2 = `realinput:${key2.detail}`;
		await browser.pause(600);
	} else {
		how2 = await pressAll(pid, 'Show All Alerts');
	}
	await browser.waitUntil(async () => (await states()).every((s) => s === 'shown'), { timeout: 5_000 }).catch(() => undefined);
	const shown = await alertFacts();
	judge('5', 'Option + Command + A (or the enabled Show All Alerts) with everything hidden → all five shown, no marker', shown.every((a) => a.state === 'shown' && a.display !== 'none') && (await markerFacts()).length === 0, { how: how2, shown });
}

async function gatePrint(pid: number | null): Promise<void> {
	// NOTE hidden by setting, TIP folded, the rest shown
	await toggleKind(pid, 'note');
	await browser.waitUntil(async () => (await states())[0] === 'hidden', { timeout: 5_000 }).catch(() => undefined);
	// Show All / Hide All reset the per-alert fold (the wiring tests fix that); fold TIP only when it is not folded already.
	if ((await states())[1] !== 'collapsed') {
		await clickTitle(1);
		await browser.pause(400);
	}
	// Both NOTE alerts (blocks 2 and 6) are hidden by the setting; the fourth alert is the second NOTE.
	judge('6', 'before printing: both NOTE alerts hidden, TIP folded, both WARNING alerts shown', JSON.stringify(await states()) === JSON.stringify(['hidden', 'collapsed', 'shown', 'hidden', 'shown']), { states: await states() });
	const printed = await browser.executeAsync<
		{ found: boolean; notes: number; markers: number; tipState: string | null; tipSummary: string | null; warnings: number; hasDialogue: boolean; hasCamera: boolean },
		[string]
	>((sel, done) => {
		window.dispatchEvent(new Event('beforeprint'));
		const started = Date.now();
		const poll = () => {
			const el = document.querySelector<HTMLElement>(sel);
			if (el && el.childElementCount > 0) {
				const tip = el.querySelector<HTMLElement>('blockquote.markdown-alert-tip');
				done({
					found: true,
					notes: el.querySelectorAll('blockquote.markdown-alert-note').length,
					markers: el.querySelectorAll('.vellis-alert-marker').length,
					tipState: tip?.getAttribute('data-alert-state') ?? null,
					tipSummary: tip?.getAttribute('data-alert-summary') ?? null,
					warnings: el.querySelectorAll('blockquote.markdown-alert-warning').length,
					hasDialogue: (el.textContent ?? '').includes('Today we talk about desk printers.'),
					hasCamera: (el.textContent ?? '').includes('Camera: slow zoom'),
				});
				return;
			}
			if (Date.now() - started > 8_000) {
				done({ found: false, notes: -1, markers: -1, tipState: null, tipSummary: null, warnings: -1, hasDialogue: false, hasCamera: false });
				return;
			}
			setTimeout(poll, 100);
		};
		poll();
	}, PRINT);
	judge('6', 'the print document (beforeprint) has no NOTE alert, no marker, TIP folded (collapsed + summary), both WARNING alerts and the dialogue', printed.found && printed.notes === 0 && printed.markers === 0 && printed.tipState === 'collapsed' && (printed.tipSummary ?? '').startsWith('Card: Episode 12') && printed.warnings === 2 && printed.hasDialogue && !printed.hasCamera, { printed });
	await browser.execute(() => window.dispatchEvent(new Event('afterprint')));
	await browser.pause(300);
	judge('6', 'afterprint takes the print document away and the face is unchanged', !(await exists(PRINT)) && JSON.stringify(await states()) === JSON.stringify(['hidden', 'collapsed', 'shown', 'hidden', 'shown']), {});
}

async function gateNothingWritten(original: string): Promise<void> {
	const onDisk = fs.readFileSync(fileOf(FIXTURE), 'utf8');
	const saves = (await readCapturedIpc()).filter((c) => c.cmd === 'save_document');
	judge('7', 'nothing was written: the file’s bytes are the original, no Unsaved badge, no save_document', onDisk === original && !(await exists(BADGE)) && saves.length === 0, { saves: saves.length, bytes: onDisk.length });
	await emitMenu('menu_raw_source');
	// The Raw Source face is `[data-testid="raw-source-editor"]` (req74-gate's RAW), not the code-editor `faceText()` reads.
	await browser.waitUntil(async () => (await rawSourceLines()) !== null, { timeout: 8_000 }).catch(() => undefined);
	const raw = ((await rawSourceLines()) ?? []).join('\n');
	judge('7', 'Raw Source shows the whole source with all five alert markers', (raw.match(/> \[!(NOTE|TIP|WARNING)\]/g) ?? []).length === 5 && raw.includes('Camera: slow zoom on the desk.'), { markers: (raw.match(/> \[!(NOTE|TIP|WARNING)\]/g) ?? []).length, length: raw.length });
	await emitMenu('menu_raw_source');
	await browser.waitUntil(async () => (await alertFacts()).length === 5, { timeout: 8_000 }).catch(() => undefined);
	judge('7', 'back from Raw Source the NOTE alerts are still hidden (the setting holds) and the file is still untouched', (await states())[0] === 'hidden' && fs.readFileSync(fileOf(FIXTURE), 'utf8') === original, { states: await states() });
}

async function gateRestart(): Promise<void> {
	const setting = await storedSetting();
	judge('8', 'restart: localStorage still holds the setting from the first run (NOTE hidden, the rest shown)', setting !== null && JSON.stringify(JSON.parse(setting!)) === JSON.stringify({ note: false, tip: true, important: true, warning: true, caution: true }), { setting });
	const facts = await alertFacts();
	const ms = await markerFacts();
	judge('8', 'restart: the file opens with the NOTE alerts hidden and two "NOTE 1" markers, nothing else hidden, TIP not folded (the per-alert fold was not remembered)', JSON.stringify(facts.map((a) => a.state)) === JSON.stringify(['hidden', 'shown', 'shown', 'hidden', 'shown']) && facts[1]!.summary === null && ms.length === 2 && ms.every((m) => m.label === 'NOTE 1'), { facts, markers: ms });
	fact('8', 'screenshot after the restart', { file: await shot('req90-8-restart') });
}

// --- the run -----------------------------------------------------------------------------------

describe('Requirement #90 gate: hide / show / fold GitHub Alerts from View ▸ Alerts on a script-like document', function () {
	this.timeout(900_000);
	let original = '';
	let pid: number | null = null;
	before(async function () {
		if (!DEVICE) this.skip();
		await waitForAppMounted();
		await installGateRecorder();
		await setIpcCapture(['save_document']);
		await waitForExplorerRow(uriOf(FIXTURE), { timeout: 30_000 });
		original = fs.readFileSync(fileOf(FIXTURE), 'utf8');
		pid = appPid();
		fact('setup', 'the app is up with the fixture', { root, variant: VARIANT, pid, submenuTool: !!submenuTool, realinput: !!realinput });
	});
	afterEach(async function () {
		if (!DEVICE) return;
		if (this.currentTest?.state === 'failed') {
			report(REPORT, { gate: 'failed', variant: VARIANT, test: this.currentTest.title, error: String(this.currentTest.err ?? '') });
		}
	});
	after(async function () {
		if (!DEVICE) return;
		report(REPORT, { gate: 'teardown', variant: VARIANT, fails });
		await restoreGateRecorder().catch(() => undefined);
	});

	if (VARIANT === 'restart') {
		it('gate (8): the setting survived the restart and applies when the file is opened', async () => {
			await openScript();
			await gateRestart();
		});
	} else {
		it('gate (1): View ▸ Alerts in the menu bar (AX)', async () => {
			await openScript();
			await gateMenu(pid);
		});
		it('gate (2): hiding NOTE, then WARNING — markers, grouping, the dialogue stays', async () => {
			await gateHideKinds(pid);
		});
		it('gate (3): the marker’s label reveals just its alerts; the setting is unchanged', async () => {
			await gateRevealByLabel();
		});
		it('gate (4): the title folds and unfolds one alert', async () => {
			await gateFold();
		});
		it('gate (5): Option + Command + A — hide all when any is shown, show all when all are hidden', async () => {
			await gateToggleAll(pid);
		});
		it('gate (6): the print document omits hidden alerts and markers, folded stays folded', async () => {
			await gatePrint(pid);
		});
		it('gate (7): nothing written; Raw Source shows everything', async () => {
			await gateNothingWritten(original);
		});
		it('gate (8, first half): the setting is in localStorage for the restart run', async () => {
			const setting = await storedSetting();
			judge('8', 'localStorage vellis.alerts holds NOTE hidden and the other kinds shown at the end of the main run', setting !== null && JSON.stringify(JSON.parse(setting!)) === JSON.stringify({ note: false, tip: true, important: true, warning: true, caution: true }), { setting });
		});
	}
	it('verdict: every judgement passed', () => {
		fact('verdict', fails.length === 0 ? 'all judgements passed' : `${fails.length} judgement(s) failed`, { fails });
		if (fails.length > 0) throw new Error(`req90 gate: ${fails.length} judgement(s) failed:\n${fails.join('\n')}`);
	});
});
