import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
	assertIpcInterceptionWorks,
	installGateRecorder,
	report,
	waitForAppMounted,
	waitForExplorerRow,
} from '../gate-helpers';

/**
 * Requirement #19 追補a human gate (Issue #418), driven on a real screen
 * (docs/requirements/req-19.md「追補a」): with the root under a folder whose
 * name starts with "." (`<home>/.claude/…`), the tree's context menu ▸
 * "Open with Default App" reaches the real opener (`plugin:opener|open_path`,
 * path scope `"**"` with `requireLiteralLeadingDot: false`) and the file opens
 * in its default app. The control root has no "." component.
 *
 * Unlike the other gate specs this one lets the command through on purpose —
 * the gate is about the opener's scope, so only the real call proves it. To
 * keep that harmless (tasks/lessons.md 2026-10-01) it opens a PNG only after
 * LaunchServices confirms the default app is Preview, finds Preview's window
 * by its AXDocument, closes that window alone, and quits Preview again when
 * it was not running before.
 *
 * Device-only: run through `scripts/gate-device/run-gate-spec.sh req19a dot`
 * and `… req19a plain` (VELLIS_GATE_DEVICE=1); skipped everywhere else.
 */

const DEVICE = process.env.VELLIS_GATE_DEVICE === '1';
const root = process.env.VELLIS_E2E_INITIAL_ROOT ?? '';
const variant = process.env.VELLIS_GATE_VARIANT ?? '';
const axtool = process.env.VELLIS_GATE_AXTOOL ?? '';
const REPORT = 'req19a-report.jsonl';
const PREVIEW_ID = 'com.apple.Preview';
const PREVIEW_EXE = '/System/Applications/Preview.app/Contents/MacOS/Preview';
const MENU_LABEL = 'Open with Default App';

const file = path.join(root, `sample-${variant}.png`);
const fileUri = `file://${file}`;

function ax(args: string[], expectExe = ''): Record<string, unknown>[] {
	const out = execFileSync(axtool, args, { encoding: 'utf8', env: { ...process.env, AXTOOL_EXPECT_EXE: expectExe } });
	return out
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const previewPids = () => ax(['running', PREVIEW_ID]).map((r) => r.pid as number);

/** Preview windows (pid-pinned AX) whose document is `file`. */
function previewWindowsFor(target: string): { pid: number; title: string; document: string }[] {
	const hits: { pid: number; title: string; document: string }[] = [];
	for (const pid of previewPids()) {
		for (const w of ax(['axwins', String(pid)], PREVIEW_EXE)) {
			const doc = String(w.document ?? '');
			if (doc && decodeURIComponent(new URL(doc).pathname) === target) {
				hits.push({ pid, title: String(w.title), document: doc });
			}
		}
	}
	return hits;
}

/** Record the opener command's request and outcome, and console.warn, without changing them. */
async function installOpenerSpy(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as { __openerLog?: unknown[]; __warnLog?: string[] };
		if (w.__openerLog) return;
		const log: Record<string, unknown>[] = [];
		const warns: string[] = [];
		w.__openerLog = log;
		w.__warnLog = warns;
		const warn = console.warn;
		console.warn = (...a: unknown[]) => {
			warns.push(a.map(String).join(' '));
			warn.apply(console, a);
		};
		const previous = window.fetch;
		window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
			const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
			const prefix = 'ipc://localhost/';
			const cmd = url.startsWith(prefix) ? decodeURIComponent(url.slice(prefix.length).split('?')[0] ?? '') : '';
			if (!cmd.startsWith('plugin:opener|')) return previous.call(this, input, init);
			const entry: Record<string, unknown> = { cmd, args: typeof init?.body === 'string' ? init.body : null, done: false };
			log.push(entry);
			return previous.call(this, input, init).then(async (res) => {
				entry.status = res.status;
				entry.tauriResponse = res.headers.get('Tauri-Response');
				entry.body = await res.clone().text();
				entry.done = true;
				return res;
			});
		} as typeof window.fetch;
	});
}

async function openerLog(): Promise<{ opener: Record<string, unknown>[]; warns: string[] }> {
	return browser.execute(() => {
		const w = window as unknown as { __openerLog: Record<string, unknown>[]; __warnLog: string[] };
		return { opener: JSON.parse(JSON.stringify(w.__openerLog)), warns: [...w.__warnLog] };
	});
}

describe('要件#19 追補a: Open with Default App under a "." folder reaches the real opener (device gate)', function () {
	before(async function () {
		if (!DEVICE) {
			this.skip();
			return;
		}
		await waitForAppMounted();
		await installGateRecorder();
		await assertIpcInterceptionWorks();
		await installOpenerSpy();
	});

	it(`${variant}: the file opens in Preview through the context menu`, async function () {
		this.timeout(90_000);
		const dotComponents = root.split('/').filter((c) => c.startsWith('.'));
		const defaultApp = ax(['defaultapp', file])[0];
		const previewBefore = previewPids();
		report(REPORT, { step: 'precheck', variant, root, file, dotComponents, defaultApp, previewRunningBefore: previewBefore });
		// Refuse to press anything when the default app is not Preview.
		expect(defaultApp.bundle).toBe(PREVIEW_ID);
		expect(previewWindowsFor(file)).toEqual([]);

		await waitForExplorerRow(fileUri, { timeout: 15_000 });
		await browser.execute((u) => {
			const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find((r) => r.title === u)!;
			const r = row.getBoundingClientRect();
			row.dispatchEvent(
				new MouseEvent('contextmenu', {
					bubbles: true,
					cancelable: true,
					button: 2,
					clientX: r.x + 20,
					clientY: r.y + r.height / 2,
				}),
			);
		}, fileUri);
		await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('.context-menu')), {
			timeout: 5_000,
			timeoutMsg: 'context menu did not open',
		});
		const items = await browser.execute(() =>
			Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu .context-menu-item')).map((b) => ({
				label: b.textContent?.trim() ?? '',
				disabled: b.disabled,
			})),
		);
		const clicked = await browser.execute((label) => {
			const b = Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu .context-menu-item')).find(
				(x) => x.textContent?.trim() === label,
			);
			if (!b || b.disabled) return false;
			b.click();
			return true;
		}, MENU_LABEL);
		expect(clicked).toBe(true);

		await browser.waitUntil(async () => (await openerLog()).opener.some((e) => e.done), {
			timeout: 10_000,
			timeoutMsg: 'the opener command never answered',
		});
		let windows: ReturnType<typeof previewWindowsFor> = [];
		const t0 = Date.now();
		while (Date.now() - t0 < 20_000) {
			windows = previewWindowsFor(file);
			if (windows.length > 0) break;
			await browser.pause(300);
		}
		const log = await openerLog();
		report(REPORT, {
			step: 'opened',
			variant,
			menuItems: items,
			opener: log.opener,
			consoleWarn: log.warns,
			previewWindows: windows,
			msToPreviewWindow: windows.length > 0 ? Date.now() - t0 : null,
		});

		// Tidy up whatever happens to the assertions below: close the window that
		// shows our file, and quit Preview if this spec started it.
		const closed = windows.map((w) => ax(['closedoc', String(w.pid), file], PREVIEW_EXE)[0]);
		let quit: unknown = null;
		if (previewBefore.length === 0) {
			await browser.pause(500);
			quit = previewPids().map((pid) => ax(['quit', String(pid)], PREVIEW_EXE)[0]);
			const t1 = Date.now();
			while (previewPids().length > 0 && Date.now() - t1 < 10_000) await browser.pause(300);
		}
		report(REPORT, {
			step: 'tidy',
			variant,
			closed,
			quitPreview: quit,
			previewRunningAfter: previewPids(),
			previewWindowsForFileAfter: previewWindowsFor(file),
		});

		const call = log.opener.find((e) => e.cmd === 'plugin:opener|open_path');
		expect(call).toBeDefined();
		expect(JSON.parse(String(call!.args)).path).toBe(file);
		expect(call!.tauriResponse).not.toBe('error');
		expect(log.warns.filter((w) => w.includes('open'))).toEqual([]);
		expect(windows.length).toBe(1);
	});
});
