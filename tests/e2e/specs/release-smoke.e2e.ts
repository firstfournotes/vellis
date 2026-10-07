import { browser, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Release smoke (backlog 300): the parts of RELEASE-CHECKLIST.md §3
 * ("DevTools を開いて確認" and "fixtures/sample.md の描画") that a machine can
 * judge, driven through the live Webview instead of a human with DevTools.
 *
 * Why this build stands in for the release build
 * ----------------------------------------------
 * `scripts/e2e.sh` builds with `pnpm tauri build --debug --no-bundle -f
 * webdriver`. For the three things the v0.1.2 regression hinged on this is
 * the same configuration as `pnpm tauri build`:
 *
 *  - Frontend: `beforeBuildCommand` (= `vite build`) produces the static
 *    SvelteKit export in `build/` and it is embedded as `frontendDist`
 *    (`src-tauri/tauri.conf.json`). `--debug` only switches the Cargo
 *    profile; the Tauri CLI still passes `tauri/custom-protocol`, which
 *    is exactly what `tauri::is_dev()` keys on
 *    (`is_dev() == !cfg!(feature = "custom-protocol")`, tauri 2.10.3).
 *  - CSP: `AppManager::csp()` picks `security.csp` whenever `!is_dev()`,
 *    so this binary injects the production `csp` string — not `devCsp`
 *    (which `tauri.conf.json` does not even define).
 *  - Custom protocols: `vellis-asset://` and the print scheme are
 *    registered in `lib.rs` unconditionally, and the page itself is served
 *    from the `tauri://localhost` custom protocol as in release.
 *
 * What differs: the Cargo profile (`debug_assertions` on), the
 * `tauri-plugin-webdriver` plugin (registered only under `webdriver` +
 * `debug_assertions`), and `RUST_LOG=info`. None of those touch the HTML,
 * the CSP string or the asset protocol. The `dev-features` Cargo feature is
 * off in both builds. If a future change makes any of these depend on the
 * profile, this spec stops being a faithful stand-in and §3 of the
 * checklist has to be done by hand again.
 *
 * How sample.md gets opened
 * -------------------------
 * tauri-webdriver v0.1.1 ignores `tauri:options.args`, and runtime-created
 * windows cannot be switched to (issue #22), so the document has to be
 * opened *inside the first window*, whose root is `fixtures/start-root`
 * (`VELLIS_E2E_INITIAL_ROOT`). The spec therefore copies the repo's
 * `fixtures/sample.md` + `fixtures/images/logo.png` into
 * `start-root/release-smoke/` in `before()`, lets the Explorer pick the new
 * folder up through `directory_changed` (requirement #18), expands it and
 * clicks `sample.md` — the same `handleFileClick` → `openForDisplay` path a
 * user takes. `after()` removes the folder again so the other specs still
 * see `start-root` = `[start-doc.md]`.
 *
 * Startup race (seen when this spec runs after the others in `e2e.sh`):
 * `init_window` lists the root and registers the backend watch before it
 * returns, but the frontend's `listen('directory_changed')` is registered
 * further down `onMount` (after `openInitialDocument` and other awaits). A
 * folder created in that gap produces an event nobody hears, and the
 * Explorer never shows it. So `before()` first waits for the initial
 * listing (`start-doc.md` in the DOM), copies the fixture, and — if the
 * folder still is not listed — touches and removes a nudge file in
 * `start-root`; every fs event makes the backend re-list the whole
 * directory, so the first nudge after the listener is up delivers the
 * complete listing. No fixed sleep.
 *
 * What is machine-judged (one `it` per checklist line)
 * ---------------------------------------------------
 *  1. CSP violations = 0 while sample.md renders (`securitypolicyviolation`
 *     recorder installed before the click). Violations raised during the
 *     *initial* page load — before any script of ours can listen — are out
 *     of reach; those stay on the DevTools line of the checklist.
 *  2. `logo.png` is drawn through `vellis-asset://` (src scheme, `complete`,
 *     `naturalWidth > 0`) and a `fetch` of the same URL answers 200.
 *  3. The only failed resource is §13's `<img src="x">`: a capture-phase
 *     `error` listener on `window` records every element whose load failed,
 *     and a `fetch` of that URL confirms it is a 404 (not some other error).
 *     `console.error` is wrapped too (original still called): nothing may
 *     be logged there after the recorder went in, other than a line that
 *     names the `x` URL. WKWebView's Resource Timing API carries neither
 *     status codes nor entries for failed custom-scheme loads, so it is not
 *     used.
 *  4. Headings / lists / blockquote nesting / tables (incl. alignment) /
 *     hr / bold / italic / strike / inline code are present in the DOM.
 *  5. Shiki colours TypeScript / Rust / Bash / JSON (≥ 2 distinct inline
 *     colours per block; the language-less block has none as a control).
 *  6. Task-list checkboxes exist, checked and unchecked.
 *  7. Clicking the first footnote reference brings its definition into the
 *     viewer's *visible* area — below the sticky, opaque toolbar
 *     (`header.viewer-toolbar`), not merely inside `article.viewer`'s box
 *     (requirement #73 contract 1).
 *  8. XSS: `alert` / `confirm` / `prompt` are stubbed before the click and
 *     never called; no `<script>`, `<iframe>`, `on*` attribute or
 *     `javascript:` href survives in the rendered DOM.
 *  9. Mermaid (§14b): two diagrams render as SVG, the invalid one shows the
 *     inline error UI, and the page continues after it.
 *
 * Out of scope: external links / mailto (would launch the OS browser),
 * `vellis --version` and the other CLI lines of §3.
 */

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const fixtureBase = path.join(__dirname, '..', 'fixtures');
const startRoot = path.join(fixtureBase, 'start-root');
const smokeDir = path.join(startRoot, 'release-smoke');
const sampleMd = path.join(smokeDir, 'sample.md');
const logoPng = path.join(smokeDir, 'images', 'logo.png');

// Same URI convention as the backend (`format!("file://{}", path)` — no
// percent-encoding) and as the `title` attribute of `.explorer-item`.
const smokeDirUri = `file://${smokeDir}`;
const sampleUri = `file://${sampleMd}`;

// `toAssetUri` (`src/lib/uri.ts`): `file:///abs` → `vellis-asset://local/abs`.
const expectedLogoSrc = `vellis-asset://local${smokeDir}/images/logo.png`;
// §13: DOMPurify-equivalent sanitising keeps `<img src="x">` minus `onerror`;
// `x` resolves relative to sample.md and is the one expected 404.
const expectedMissingSrc = `vellis-asset://local${smokeDir}/x`;

const BODY = 'article.viewer .markdown-body';

/** What the in-page recorder (`window.__vellisSmoke`) accumulates. */
interface SmokeRecord {
	csp: Array<{ directive: string; blockedURI: string; sourceFile: string; line: number }>;
	dialogs: Array<{ kind: 'alert' | 'confirm' | 'prompt'; message: string }>;
	resourceErrors: Array<{ tag: string; attr: string; resolved: string }>;
	scriptErrors: string[];
	rejections: string[];
	/** Every `console.error(...)` call since the recorder was installed, joined as text. */
	consoleErrors: string[];
}

async function waitForAppMounted(): Promise<void> {
	await browser.waitUntil(
		async () =>
			browser.execute(
				() =>
					location.href !== 'about:blank' &&
					document.body.childElementCount > 0,
			),
		{
			timeout: 30_000,
			timeoutMsg: 'webview never navigated past about:blank',
		},
	);
}

/**
 * Install the recorder *before* sample.md is opened. Idempotent: a second
 * call (e.g. a retried `before`) keeps the existing record.
 */
async function installRecorder(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as {
			__vellisSmoke?: SmokeRecord & { originals: Record<string, unknown> };
		};
		if (w.__vellisSmoke) return;
		const rec = {
			csp: [] as SmokeRecord['csp'],
			dialogs: [] as SmokeRecord['dialogs'],
			resourceErrors: [] as SmokeRecord['resourceErrors'],
			scriptErrors: [] as string[],
			rejections: [] as string[],
			consoleErrors: [] as string[],
			originals: {
				alert: window.alert,
				confirm: window.confirm,
				prompt: window.prompt,
				consoleError: console.error,
			} as Record<string, unknown>,
		};
		w.__vellisSmoke = rec;

		// DevTools "Console" line of the checklist: keep every console.error
		// (still forwarded to the real console so RUST_LOG / DevTools users
		// see it). Native WebKit console messages that are *not* produced by
		// a JS `console.error` call (e.g. the webview's own network-failure
		// line) cannot be intercepted from page script; those are covered by
		// the `error` / CSP listeners below instead.
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]) => {
			rec.consoleErrors.push(
				args
					.map((a) => {
						if (a instanceof Error) return `${a.name}: ${a.message}`;
						if (typeof a === 'string') return a;
						try {
							return JSON.stringify(a);
						} catch {
							return String(a);
						}
					})
					.join(' '),
			);
			originalConsoleError.apply(console, args);
		};

		// Capture at the window so violations raised on any element /
		// document are seen exactly once.
		window.addEventListener(
			'securitypolicyviolation',
			(ev) => {
				rec.csp.push({
					directive: ev.effectiveDirective || ev.violatedDirective,
					blockedURI: ev.blockedURI,
					sourceFile: ev.sourceFile,
					line: ev.lineNumber,
				});
			},
			true,
		);

		// Resource load failures (`<img>`, `<script>`, `<link>`, …) do not
		// bubble, but a capture-phase listener on `window` still sees them.
		// Script runtime errors arrive here too, with `target === window`.
		window.addEventListener(
			'error',
			(ev) => {
				const t = ev.target as unknown;
				if (t && t !== window && t instanceof Element) {
					const el = t as Element & { currentSrc?: string; src?: string; href?: string };
					rec.resourceErrors.push({
						tag: el.tagName.toLowerCase(),
						attr: el.getAttribute('src') ?? el.getAttribute('href') ?? '',
						resolved: el.currentSrc || el.src || el.href || '',
					});
				} else {
					rec.scriptErrors.push(String((ev as ErrorEvent).message ?? ev.type));
				}
			},
			true,
		);
		window.addEventListener('unhandledrejection', (ev) => {
			rec.rejections.push(String(ev.reason));
		});

		// Record instead of blocking: a native dialog would stall the spec.
		window.alert = (message?: unknown) => {
			rec.dialogs.push({ kind: 'alert', message: String(message) });
		};
		window.confirm = (message?: string) => {
			rec.dialogs.push({ kind: 'confirm', message: String(message) });
			return true;
		};
		window.prompt = (message?: string) => {
			rec.dialogs.push({ kind: 'prompt', message: String(message) });
			return null;
		};
	});
}

async function readRecord(): Promise<SmokeRecord> {
	return browser.execute(() => {
		const r = (window as unknown as { __vellisSmoke?: SmokeRecord }).__vellisSmoke;
		if (!r) throw new Error('smoke recorder is not installed');
		return {
			csp: r.csp,
			dialogs: r.dialogs,
			resourceErrors: r.resourceErrors,
			scriptErrors: r.scriptErrors,
			rejections: r.rejections,
			consoleErrors: r.consoleErrors,
		};
	});
}

async function restoreRecorder(): Promise<void> {
	await browser.execute(() => {
		const w = window as unknown as {
			__vellisSmoke?: { originals: Record<string, unknown> };
		};
		const o = w.__vellisSmoke?.originals;
		if (!o) return;
		window.alert = o.alert as typeof window.alert;
		window.confirm = o.confirm as typeof window.confirm;
		window.prompt = o.prompt as typeof window.prompt;
		console.error = o.consoleError as typeof console.error;
	});
}

async function explorerNames(): Promise<string[]> {
	return browser.$$('.explorer-item .name').map((el) => el.getText());
}

async function explorerHasRow(uri: string): Promise<boolean> {
	return browser.execute(
		(u) =>
			Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).some(
				(row) => row.title === u,
			),
		uri,
	);
}

/**
 * Wait until the Explorer lists the row whose `title` is `uri`. With
 * `nudgeDir`, each miss touches and removes a throw-away file in that
 * directory so the backend re-lists it and emits a fresh
 * `directory_changed` — this is what closes the startup gap described in
 * the header comment. The nudge file never survives a loop iteration.
 */
async function waitForExplorerRow(
	uri: string,
	opts: { timeout: number; nudgeDir?: string },
): Promise<void> {
	const deadline = Date.now() + opts.timeout;
	let attempt = 0;
	for (;;) {
		if (await explorerHasRow(uri)) return;
		if (Date.now() >= deadline) {
			throw new Error(
				`explorer never listed ${uri} (visible rows: ${JSON.stringify(await explorerNames())})`,
			);
		}
		if (opts.nudgeDir) {
			const nudge = path.join(opts.nudgeDir, `release-smoke-nudge-${attempt++}.tmp`);
			fs.writeFileSync(nudge, '');
			fs.rmSync(nudge, { force: true });
		}
		await browser.pause(1_000);
	}
}

/**
 * Click the Explorer row whose `title` is `uri` via `HTMLElement.click()`.
 * Pointer actions are not something tauri-plugin-webdriver is relied on for
 * anywhere else in this suite; `click()` dispatches a real `MouseEvent`
 * (no modifier keys → "open in this window") to the Svelte handler.
 */
async function clickExplorerRow(uri: string): Promise<void> {
	await waitForExplorerRow(uri, { timeout: 15_000 });
	const clicked = await browser.execute((u) => {
		const row = Array.from(document.querySelectorAll<HTMLElement>('.explorer-item')).find(
			(r) => r.title === u,
		);
		if (!row) return false;
		row.click();
		return true;
	}, uri);
	expect(clicked).toBe(true);
}

/**
 * `waitUntil` whose failure message is computed *after* the timeout, so the
 * error carries the live state (recorder contents, geometry, counts).
 * `timeoutMsg` itself only takes a string.
 */
async function waitOrExplain(
	condition: () => Promise<boolean>,
	timeout: number,
	explain: () => Promise<string>,
): Promise<void> {
	try {
		await browser.waitUntil(condition, { timeout, timeoutMsg: 'condition not met' });
	} catch {
		throw new Error(await explain());
	}
}

async function countInBody(selector: string): Promise<number> {
	return browser.execute(
		(body, sel) => document.querySelectorAll(`${body} ${sel}`).length,
		BODY,
		selector,
	);
}

/** Text of every element matching `selector` inside the rendered body. */
async function textsInBody(selector: string): Promise<string[]> {
	return browser.execute(
		(body, sel) =>
			Array.from(document.querySelectorAll(`${body} ${sel}`)).map(
				(el) => (el.textContent ?? '').trim(),
			),
		BODY,
		selector,
	);
}

async function fetchStatus(url: string): Promise<{ status: number; type: string } | { error: string }> {
	return browser.executeAsync<{ status: number; type: string } | { error: string }, [string]>(
		(u, done) => {
			fetch(u)
				.then((r) => done({ status: r.status, type: r.headers.get('content-type') ?? '' }))
				.catch((e) => done({ error: String(e) }));
		},
		url,
	);
}

describe('Release smoke: RELEASE-CHECKLIST §3 on the webdriver build (backlog 300)', () => {
	before(async () => {
		await waitForAppMounted();
		// Recorder first: everything sample.md does (CSP, dialogs, failed
		// loads) must be observed from the very first byte of its render.
		await installRecorder();

		// Initial listing done (= `init_window` returned, so the backend watch
		// on start-root is registered too). Only then add the fixture.
		await browser.waitUntil(async () => (await explorerNames()).includes('start-doc.md'), {
			timeout: 30_000,
			timeoutMsg: 'explorer never showed the initial start-root listing (start-doc.md)',
		});

		fs.mkdirSync(path.join(smokeDir, 'images'), { recursive: true });
		fs.copyFileSync(path.join(repoRoot, 'fixtures', 'sample.md'), sampleMd);
		fs.copyFileSync(path.join(repoRoot, 'fixtures', 'images', 'logo.png'), logoPng);

		// The frontend's `directory_changed` listener may still be a few
		// awaits away; nudge until the folder is listed (see header comment).
		await waitForExplorerRow(smokeDirUri, { timeout: 30_000, nudgeDir: startRoot });
	});

	after(async () => {
		await restoreRecorder();
		fs.rmSync(smokeDir, { recursive: true, force: true });
		// Nudge files are removed as soon as they are written; sweep anyway so
		// a crash mid-nudge cannot leak into the other specs' listing checks.
		for (const name of fs.readdirSync(startRoot)) {
			if (name.startsWith('release-smoke-nudge-')) {
				fs.rmSync(path.join(startRoot, name), { force: true });
			}
		}
	});

	it('opens fixtures/sample.md in the first window via the Explorer', async () => {
		// The root directory is watched (#18): the new folder shows up on its
		// own. Expand it, then click the file.
		await clickExplorerRow(smokeDirUri);
		await clickExplorerRow(sampleUri);

		await waitOrExplain(
			async () =>
				(await textsInBody('h1')).some((t) => t.includes('Vellis Markdown テストファイル')),
			30_000,
			async () => `sample.md did not render; recorder=${JSON.stringify(await readRecord())}`,
		);
	});

	it('draws logo.png through vellis-asset:// (img complete, naturalWidth > 0, fetch 200)', async () => {
		const state = () =>
			browser.execute((body) => {
				const img = document.querySelector<HTMLImageElement>(`${body} img[alt="Vellis Logo"]`);
				if (!img) return null;
				return {
					src: img.getAttribute('src') ?? '',
					complete: img.complete,
					naturalWidth: img.naturalWidth,
				};
			}, BODY);

		await browser.waitUntil(async () => (await state())?.complete === true, {
			timeout: 15_000,
			timeoutMsg: 'logo.png never finished loading',
		});
		const img = await state();
		expect(img).not.toBeNull();
		expect(img?.src).toBe(expectedLogoSrc);
		expect(img?.src.startsWith('vellis-asset://')).toBe(true);
		expect(img?.naturalWidth).toBeGreaterThan(0);

		// Network tab line of the checklist: the asset answers 200 image/png.
		const res = await fetchStatus(expectedLogoSrc);
		expect(res).toEqual(expect.objectContaining({ status: 200 }));
		expect((res as { type: string }).type).toMatch(/^image\/png/);
	});

	it('renders Mermaid (§14b): two SVG diagrams, one inline error, page intact after it', async () => {
		await waitOrExplain(
			async () => (await countInBody('.vellis-mermaid-rendered')) === 3,
			30_000,
			async () =>
				`expected 3 mounted mermaid blocks, saw ${await countInBody('.vellis-mermaid-rendered')} of ${await countInBody('.vellis-mermaid')} placeholders; recorder=${JSON.stringify(await readRecord())}`,
		);
		const svgBlocks = await countInBody('.vellis-mermaid:not(.vellis-mermaid-error) > svg');
		const errorBlocks = await countInBody('.vellis-mermaid.vellis-mermaid-error details');
		expect(svgBlocks).toBe(2);
		expect(errorBlocks).toBe(1);
		// The invalid diagram must not break what follows it.
		expect((await textsInBody('h2')).some((t) => t.startsWith('15. '))).toBe(true);
	});

	it('raises no CSP violation while rendering sample.md', async () => {
		// Runs after the image and Mermaid waits above, so late loads
		// (Mermaid's lazily imported chunk, its inline <style>) are covered.
		const rec = await readRecord();
		expect(rec.csp).toEqual([]);
	});

	it("fails to load exactly one resource — §13's <img src=\"x\"> — and it is a 404", async () => {
		// The 404 for `x` arrives asynchronously after the DOM is in place;
		// give it a moment so an empty list is a real "nothing failed".
		await waitOrExplain(
			async () => (await readRecord()).resourceErrors.length >= 1,
			10_000,
			async () =>
				`no resource load failure was recorded at all — expected the §13 <img src="x"> 404 (${expectedMissingSrc}); recorder=${JSON.stringify(await readRecord())}`,
		);
		const rec = await readRecord();
		expect(rec.resourceErrors.map((e) => e.resolved)).toEqual([expectedMissingSrc]);
		expect(rec.resourceErrors[0]?.tag).toBe('img');
		expect(rec.scriptErrors).toEqual([]);
		expect(rec.rejections).toEqual([]);
		// "Console 404 / fetch 失敗なし": nothing may have reached console.error
		// since the recorder went in, except a line about §13's `x` itself.
		expect(rec.consoleErrors.filter((line) => !line.includes(expectedMissingSrc))).toEqual([]);

		// "404 / fetch 失敗なし (x の 1 件は想定内)": prove the one failure
		// really is a 404 from the asset protocol, not a CSP block or a
		// handler crash.
		const res = await fetchStatus(expectedMissingSrc);
		expect(res).toEqual(expect.objectContaining({ status: 404 }));
	});

	it('renders headings, lists, blockquotes, tables, hr and inline decorations', async () => {
		for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
			expect(await countInBody(tag)).toBeGreaterThanOrEqual(1);
		}
		expect(await countInBody('ul > li')).toBeGreaterThan(0);
		expect(await countInBody('ul ul ul > li')).toBeGreaterThan(0); // B-2-a
		expect(await countInBody('ol > li')).toBeGreaterThan(0);
		expect(await countInBody('ol ol > li')).toBeGreaterThan(0); // Sub 2.1
		expect(await countInBody('blockquote blockquote')).toBeGreaterThan(0);
		expect(await countInBody('table')).toBeGreaterThanOrEqual(2);
		expect(await countInBody('th[align="center"]')).toBeGreaterThan(0);
		expect(await countInBody('th[align="right"]')).toBeGreaterThan(0);
		expect(await countInBody('hr')).toBeGreaterThan(0);

		expect(await textsInBody('strong')).toContain('太字');
		expect(await textsInBody('em')).toContain('斜体');
		expect(await textsInBody('del')).toContain('打ち消し線');
		expect(await textsInBody(':not(pre) > code')).toContain('インラインコード');
	});

	it('applies Shiki highlighting to the TypeScript / Rust / Bash / JSON blocks', async () => {
		// Shiki output after sanitising: `<pre style=…><code><span><span
		// style="color:#…">`. Identify each fence by a marker from its source
		// and count the distinct inline colours inside it.
		const markers: Record<string, string> = {
			typescript: 'async function fetchChildren',
			rust: 'pub async fn install_cli',
			bash: 'vellis --install-cli',
			json: "default-src 'self'; script-src 'self'",
			plain: 'これは言語指定のないコードブロック',
		};
		const colours = await browser.execute(
			(body, m) => {
				const pres = Array.from(document.querySelectorAll<HTMLElement>(`${body} pre`));
				const out: Record<string, number | null> = {};
				for (const [lang, marker] of Object.entries(m)) {
					const pre = pres.find((p) => (p.textContent ?? '').includes(marker));
					if (!pre) {
						out[lang] = null;
						continue;
					}
					const set = new Set<string>();
					for (const span of pre.querySelectorAll<HTMLElement>('span[style]')) {
						if (span.style.color) set.add(span.style.color);
					}
					out[lang] = set.size;
				}
				return out;
			},
			BODY,
			markers,
		);
		for (const lang of ['typescript', 'rust', 'bash', 'json']) {
			expect(colours[lang]).not.toBeNull();
			expect(colours[lang] ?? 0).toBeGreaterThanOrEqual(2);
		}
		// Control: the language-less fence carries no colour spans, so the
		// counts above cannot come from something other than highlighting.
		expect(colours.plain).toBe(0);
	});

	it('shows task-list checkboxes, both checked and unchecked', async () => {
		expect(await countInBody('li.task-list-item > input[type="checkbox"]')).toBeGreaterThanOrEqual(4);
		expect(await countInBody('li.task-list-item > input[type="checkbox"]:checked')).toBeGreaterThanOrEqual(2);
		expect(
			await countInBody('li.task-list-item > input[type="checkbox"]:not(:checked)'),
		).toBeGreaterThanOrEqual(2);
	});

	it('does not fire the §13 XSS attempts and leaves no script / handler attribute / javascript: href', async () => {
		const rec = await readRecord();
		expect(rec.dialogs).toEqual([]);

		expect(await countInBody('script')).toBe(0);
		expect(await countInBody('iframe')).toBe(0);

		const leftovers = await browser.execute((body) => {
			const found: string[] = [];
			const root = document.querySelector(body);
			if (!root) return ['<body not found>'];
			for (const el of root.querySelectorAll('*')) {
				for (const attr of Array.from(el.attributes)) {
					if (/^on/i.test(attr.name)) found.push(`${el.tagName.toLowerCase()}[${attr.name}]`);
					if (
						(attr.name === 'href' || attr.name === 'src') &&
						/^\s*javascript:/i.test(attr.value)
					) {
						found.push(`${el.tagName.toLowerCase()}[${attr.name}=${attr.value}]`);
					}
				}
			}
			return found;
		}, BODY);
		expect(leftovers).toEqual([]);

		// The sanitiser removed the handler, not the element: that leftover
		// `<img src="x">` is what the single 404 above comes from.
		expect(await countInBody(`img[src="${expectedMissingSrc}"]`)).toBe(1);
	});

	it('jumps to the footnote definition when the [^1] reference is clicked', async () => {
		// Geometry relative to the scroll container (`article.viewer`). The
		// toolbar (`header.viewer-toolbar`) is sticky, opaque and on top, so
		// the visible box starts at the toolbar's *bottom* edge, not at the
		// viewer's top — a destination tucked behind the toolbar is not
		// reached (requirement #73 contract 1). The definition counts as
		// reached when its top edge lies between that line and the viewer's
		// bottom edge.
		const geometry = () =>
			browser.execute((body) => {
				const viewer = document.querySelector('article.viewer');
				const toolbar = viewer?.querySelector('header.viewer-toolbar') ?? null;
				const ref = document.querySelector<HTMLAnchorElement>(`${body} sup a[data-footnote-ref]`);
				const def = Array.from(
					document.querySelectorAll<HTMLElement>(`${body} section[data-footnotes] li`),
				).find((li) => (li.textContent ?? '').includes('複数の CLI 起動'));
				if (!viewer || !ref || !def) {
					return { ok: false as const, viewer: !!viewer, ref: !!ref, def: !!def };
				}
				const v = viewer.getBoundingClientRect();
				const visibleTop = toolbar ? toolbar.getBoundingClientRect().bottom : v.top;
				const d = def.getBoundingClientRect();
				return {
					ok: true as const,
					href: ref.getAttribute('href') ?? '',
					defTop: d.top,
					viewerTop: v.top,
					toolbarBottom: toolbar ? toolbar.getBoundingClientRect().bottom : null,
					visibleTop,
					viewerBottom: v.bottom,
					scrollTop: viewer.scrollTop,
					visible: d.top >= visibleTop && d.top < v.bottom,
				};
			}, BODY);

		const before = await geometry();
		expect(before.ok).toBe(true);
		if (!before.ok) return;
		expect(before.href.startsWith('#')).toBe(true);
		// Precondition for the assertion to mean anything: the definition sits
		// below the fold before the click.
		expect(before.visible).toBe(false);

		await browser.execute((body) => {
			document.querySelector<HTMLAnchorElement>(`${body} sup a[data-footnote-ref]`)?.click();
		}, BODY);

		await waitOrExplain(
			async () => {
				const g = await geometry();
				return g.ok && g.visible;
			},
			5_000,
			async () =>
				`footnote definition did not come into view after clicking ${before.href}: ${JSON.stringify(await geometry())}`,
		);
	});

	it('jumps back to the [^1] reference when the footnote back-link is clicked', async () => {
		// Requirement #73 contract 2. Runs after the previous `it`, so the
		// viewer is scrolled to the footnotes. The reference sits in §11, in
		// the middle of the document, so this destination is not pinned by
		// the scroll range's end the way the definition is: it has to be
		// placed below the sticky toolbar by the scroll code itself.
		const geometry = () =>
			browser.execute((body) => {
				const viewer = document.querySelector('article.viewer');
				const toolbar = viewer?.querySelector('header.viewer-toolbar') ?? null;
				const def = Array.from(
					document.querySelectorAll<HTMLElement>(`${body} section[data-footnotes] li`),
				).find((li) => (li.textContent ?? '').includes('複数の CLI 起動'));
				const backref = def?.querySelector<HTMLAnchorElement>('a[data-footnote-backref]') ?? null;
				// The first reference in the body is `[^1]`, the one this
				// back-link returns to.
				const ref = document.querySelector<HTMLAnchorElement>(`${body} sup a[data-footnote-ref]`);
				if (!viewer || !def || !backref || !ref) {
					return {
						ok: false as const,
						viewer: !!viewer,
						def: !!def,
						backref: !!backref,
						ref: !!ref,
					};
				}
				const v = viewer.getBoundingClientRect();
				const toolbarBottom = toolbar ? toolbar.getBoundingClientRect().bottom : null;
				const visibleTop = toolbarBottom ?? v.top;
				const r = ref.getBoundingClientRect();
				return {
					ok: true as const,
					backrefHref: backref.getAttribute('href') ?? '',
					refTop: r.top,
					toolbarBottom,
					visibleTop,
					viewerTop: v.top,
					viewerBottom: v.bottom,
					scrollTop: viewer.scrollTop,
					visible: r.top >= visibleTop && r.top < v.bottom,
				};
			}, BODY);

		const before = await geometry();
		expect(before.ok).toBe(true);
		if (!before.ok) return;
		expect(before.backrefHref.startsWith('#')).toBe(true);
		// Precondition: the reference is out of view while the footnotes are
		// shown, otherwise the assertion below would prove nothing.
		expect(before.visible).toBe(false);

		await browser.execute((body) => {
			const def = Array.from(
				document.querySelectorAll<HTMLElement>(`${body} section[data-footnotes] li`),
			).find((li) => (li.textContent ?? '').includes('複数の CLI 起動'));
			def?.querySelector<HTMLAnchorElement>('a[data-footnote-backref]')?.click();
		}, BODY);

		await waitOrExplain(
			async () => {
				const g = await geometry();
				return g.ok && g.visible;
			},
			5_000,
			async () =>
				`footnote reference did not come into the visible area (below the toolbar) after clicking ${before.backrefHref}: ${JSON.stringify(await geometry())}`,
		);
	});
});
