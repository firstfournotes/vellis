/**
 * 要件#72 の受け入れテスト(docs/requirements/req-72.md)— AC-72-5(記録スクリプト)
 *
 * `--self-check` が WebView の初期化スクリプトとして注入する記録スクリプトを、
 * Rust が埋め込むのと **同じファイル** から読んで jsdom の window で評価し、契約4 の
 * 各事象を起こすと記録に入ることを判定する。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする名前・形)
 *
 * - ファイル: `src-tauri/src/self_check/recorder.js`(単体の classic script。
 *   `import` / `export` を持たない。Rust 側は `include_str!("recorder.js")` で
 *   `vellis_lib::self_check::RECORDER_JS` にする=cargo の acceptance_req72 が同一性を見る)
 * - 評価すると `window.__vellisSelfCheck` が生え、`window.__vellisSelfCheck.snapshot()`
 *   がその時点の記録を **プレーンな JSON 値** で返す。キーは契約6 の記録部分と同じ
 *   snake_case で、ちょうどこの 7 つ:
 *     csp:             [{ directive, blocked_uri, source_file, line }]
 *     resource_errors: [{ tag, attr, resolved }]
 *     console_errors:  [string]
 *     script_errors:   [string]
 *     rejections:      [string]
 *     dialogs:         [{ kind: 'alert'|'confirm'|'prompt', message }]
 *     asset_images:    { loaded, failed }
 * - 拾い方(契約4):
 *     - `securitypolicyviolation` を window の capture 段で聞く
 *       (directive = effectiveDirective || violatedDirective, blocked_uri = blockedURI,
 *        source_file = sourceFile, line = lineNumber)
 *     - `error` を window の capture 段で聞き、`target` が要素なら resource_errors
 *       (tag = 小文字タグ名・attr = src または href 属性の生の値・resolved = currentSrc || src || href)、
 *       `target` が window なら script_errors(message の文字列)
 *     - `unhandledrejection` → rejections(String(reason))
 *     - `console.error` を包み、引数を文字列化して console_errors に積み、元の console.error も呼ぶ
 *     - `alert` / `confirm` / `prompt` を置き換えて dialogs に積む。ネイティブは呼ばない。
 *       confirm は true・prompt は null を返す
 *     - asset_images は snapshot() 時に `article.viewer .markdown-body` 配下の
 *       `img[src^="vellis-asset://"]` を数える: complete && naturalWidth > 0 → loaded、
 *       complete && naturalWidth === 0 → failed、complete でないものは数えない
 * - Tauri のグローバル(`__TAURI_INTERNALS__` など)が無くても評価できる(純粋な記録役)。
 *   Rust への受け渡し(IPC か何か)は別の仕組みに置く。記録の「最後の時刻」など
 *   契約5 の完了判定に使う補助があってもよいが、snapshot() のキーには足さない
 *
 * ## 判定しないもの
 * - 初期化スクリプトとして「ページのどのスクリプトより先に入る」こと(Tauri の
 *   initialization_script の性質。/verify = AC-72-8 の実 WebView で見る)
 */

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RECORDER_PATH = path.join(repoRoot, 'src-tauri', 'src', 'self_check', 'recorder.js');

const RECORD_KEYS = [
	'csp',
	'resource_errors',
	'console_errors',
	'script_errors',
	'rejections',
	'dialogs',
	'asset_images',
] as const;

interface Record {
	csp: Array<{ directive: string; blocked_uri: string; source_file: string; line: number }>;
	resource_errors: Array<{ tag: string; attr: string; resolved: string }>;
	console_errors: string[];
	script_errors: string[];
	rejections: string[];
	dialogs: Array<{ kind: 'alert' | 'confirm' | 'prompt'; message: string }>;
	asset_images: { loaded: number; failed: number };
}

type SelfCheckWindow = Window &
	typeof globalThis & {
		__vellisSelfCheck?: { snapshot: () => Record };
	};

// jsdom は devDependency だが型定義(@types/jsdom)は入っていないので、require で読んで
// 使う分だけ型を付ける(依存追加なし)。
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
	JSDOM: new (
		html: string,
		options: { runScripts: 'outside-only'; url: string },
	) => { window: SelfCheckWindow };
};

function readRecorder(): string {
	if (!existsSync(RECORDER_PATH)) {
		throw new Error(`記録スクリプトが無い: ${RECORDER_PATH}(要件72 契約4)`);
	}
	return readFileSync(RECORDER_PATH, 'utf8');
}

/**
 * 本番の DOM 骨格(`article.viewer .markdown-body`)を持つ空のページに、
 * ネイティブ(のつもり)の alert / confirm / prompt / console.error をスパイとして
 * 置いた **あとで** 記録スクリプトを評価する=初期化スクリプトと同じ順序。
 */
function boot() {
	const dom = new JSDOM(
		'<!doctype html><html><body><article class="viewer"><div class="markdown-body"></div></article></body></html>',
		{ runScripts: 'outside-only', url: 'tauri://localhost/' },
	);
	const w = dom.window;
	const natives = {
		alert: vi.fn(),
		confirm: vi.fn(() => false),
		prompt: vi.fn(() => 'typed by native'),
		consoleError: vi.fn(),
	};
	w.alert = natives.alert as unknown as typeof w.alert;
	w.confirm = natives.confirm as unknown as typeof w.confirm;
	w.prompt = natives.prompt as unknown as typeof w.prompt;
	w.console.error = natives.consoleError as unknown as typeof console.error;

	w.eval(readRecorder());

	const api = w.__vellisSelfCheck;
	if (!api || typeof api.snapshot !== 'function') {
		throw new Error('記録スクリプトは window.__vellisSelfCheck.snapshot() を用意する');
	}
	const body = w.document.querySelector('article.viewer .markdown-body') as HTMLElement;
	return { w, natives, body, snapshot: () => api.snapshot() };
}

function emptyRecord(): Record {
	return {
		csp: [],
		resource_errors: [],
		console_errors: [],
		script_errors: [],
		rejections: [],
		dialogs: [],
		asset_images: { loaded: 0, failed: 0 },
	};
}

describe('AC-72-5: 記録スクリプト recorder.js(契約4・契約6 の記録キー)', () => {
	it('is a single classic script file (no import/export) that Rust can embed as-is', () => {
		const src = readRecorder();
		expect(src.trim().length).toBeGreaterThan(0);
		expect(src).not.toMatch(/^\s*(import|export)\s/m);
	});

	it('installs window.__vellisSelfCheck.snapshot() and starts with an empty record of exactly the contract-6 keys', () => {
		const { snapshot } = boot();
		const rec = snapshot();
		expect(Object.keys(rec).sort()).toEqual([...RECORD_KEYS].sort());
		expect(rec).toEqual(emptyRecord());
		expect(Object.keys(rec.asset_images).sort()).toEqual(['failed', 'loaded']);
	});

	it('snapshot() is plain JSON (what Rust deserialises into RecorderSnapshot)', () => {
		const { snapshot } = boot();
		const rec = snapshot();
		expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
	});

	it('records securitypolicyviolation with directive / blocked_uri / source_file / line', () => {
		const { w, snapshot } = boot();
		// jsdom has no SecurityPolicyViolationEvent; a generic Event carrying the
		// same fields is what the listener reads. Dispatched on the document (as
		// WebKit does) — the window-level capture listener must still see it.
		const ev = new w.Event('securitypolicyviolation', { bubbles: true });
		Object.assign(ev, {
			effectiveDirective: 'img-src',
			violatedDirective: 'img-src',
			blockedURI: 'https://example.com/a.png',
			sourceFile: 'tauri://localhost/_app/x.js',
			lineNumber: 12,
		});
		w.document.dispatchEvent(ev);

		expect(snapshot().csp).toEqual([
			{
				directive: 'img-src',
				blocked_uri: 'https://example.com/a.png',
				source_file: 'tauri://localhost/_app/x.js',
				line: 12,
			},
		]);
		// 他の区分には漏れない
		expect(snapshot().script_errors).toEqual([]);
		expect(snapshot().resource_errors).toEqual([]);
	});

	it('records a resource load failure (capture-phase error whose target is an element) with tag / attr / resolved', () => {
		const { w, body, snapshot } = boot();
		const img = w.document.createElement('img');
		img.setAttribute('src', './images/missing.png');
		body.appendChild(img);
		// `error` does not bubble; only a capture listener on window sees it.
		img.dispatchEvent(new w.Event('error'));

		const link = w.document.createElement('link');
		link.setAttribute('rel', 'stylesheet');
		link.setAttribute('href', 'https://example.com/x.css');
		w.document.head.appendChild(link);
		link.dispatchEvent(new w.Event('error'));

		const rec = snapshot();
		expect(rec.resource_errors).toEqual([
			{ tag: 'img', attr: './images/missing.png', resolved: img.src },
			{ tag: 'link', attr: 'https://example.com/x.css', resolved: link.href },
		]);
		expect(rec.resource_errors[0].resolved).toBe('tauri://localhost/images/missing.png');
		// 要素の失敗はスクリプトの例外ではない
		expect(rec.script_errors).toEqual([]);
	});

	it('records console.error calls as text and still calls the original console.error', () => {
		const { w, natives, snapshot } = boot();
		const err = w.eval('new TypeError("bad thing")') as Error;
		w.eval('console.error("boom", {a: 1}); console.error(42)');
		w.console.error(err);

		const lines = snapshot().console_errors;
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain('boom');
		expect(lines[0]).toContain('"a":1');
		expect(lines[1]).toContain('42');
		expect(lines[2]).toContain('TypeError');
		expect(lines[2]).toContain('bad thing');
		for (const line of lines) expect(typeof line).toBe('string');

		expect(natives.consoleError).toHaveBeenCalledTimes(3);
		expect(natives.consoleError.mock.calls[0][0]).toBe('boom');
		expect(natives.consoleError.mock.calls[0][1]).toEqual({ a: 1 });
		expect(natives.consoleError.mock.calls[2][0]).toBe(err);
	});

	it('records uncaught exceptions (error whose target is window) in script_errors', () => {
		const { w, snapshot } = boot();
		w.dispatchEvent(
			new w.ErrorEvent('error', {
				message: 'Uncaught TypeError: boom',
				filename: 'tauri://localhost/_app/x.js',
				lineno: 3,
			}),
		);
		const rec = snapshot();
		expect(rec.script_errors).toHaveLength(1);
		expect(rec.script_errors[0]).toContain('Uncaught TypeError: boom');
		expect(rec.resource_errors).toEqual([]);
	});

	it('records unhandledrejection in rejections', () => {
		const { w, snapshot } = boot();
		const promise = Promise.resolve();
		w.dispatchEvent(
			new w.PromiseRejectionEvent('unhandledrejection', {
				promise,
				reason: new w.Error('nope'),
			}),
		);
		const plain = new w.Event('unhandledrejection');
		Object.assign(plain, { reason: 'plain reason' });
		w.dispatchEvent(plain);

		const rec = snapshot();
		expect(rec.rejections).toHaveLength(2);
		expect(rec.rejections[0]).toContain('nope');
		expect(rec.rejections[1]).toContain('plain reason');
	});

	it('records alert / confirm / prompt (kind + message), never calls the natives, confirm → true, prompt → null', () => {
		const { w, natives, snapshot } = boot();
		const results = w.eval(
			'[window.alert("XSS via onerror"), window.confirm("sure?"), window.prompt("name?", "dflt"), alert("bare")]',
		) as unknown[];

		expect(results[0]).toBeUndefined();
		expect(results[1]).toBe(true);
		expect(results[2]).toBeNull();

		expect(snapshot().dialogs).toEqual([
			{ kind: 'alert', message: 'XSS via onerror' },
			{ kind: 'confirm', message: 'sure?' },
			{ kind: 'prompt', message: 'name?' },
			{ kind: 'alert', message: 'bare' },
		]);
		expect(natives.alert).not.toHaveBeenCalled();
		expect(natives.confirm).not.toHaveBeenCalled();
		expect(natives.prompt).not.toHaveBeenCalled();
	});

	it('counts vellis-asset:// images inside article.viewer .markdown-body: loaded (complete && naturalWidth > 0) and failed', () => {
		const { w, body, snapshot } = boot();

		const mk = (src: string, complete: boolean, naturalWidth: number, parent: HTMLElement) => {
			const img = w.document.createElement('img');
			img.setAttribute('src', src);
			Object.defineProperty(img, 'complete', { value: complete });
			Object.defineProperty(img, 'naturalWidth', { value: naturalWidth });
			parent.appendChild(img);
			return img;
		};

		mk('vellis-asset://local/repo/fixtures/images/logo.png', true, 128, body); // loaded
		mk('vellis-asset://local/repo/fixtures/x', true, 0, body); // failed (§13)
		mk('vellis-asset://local/repo/fixtures/pending.png', false, 0, body); // undecided: not counted
		mk('https://example.com/ext.png', true, 10, body); // not vellis-asset: not counted
		mk('data:image/png;base64,AAAA', true, 1, body); // not vellis-asset: not counted
		mk('vellis-asset://local/repo/outside.png', true, 10, w.document.body); // outside the body: not counted

		expect(snapshot().asset_images).toEqual({ loaded: 1, failed: 1 });
	});

	it('accumulates everything into one record whose keys match contract 6', () => {
		const { w, body, snapshot } = boot();
		w.eval('alert("x")');
		w.eval('console.error("e")');
		const img = w.document.createElement('img');
		img.setAttribute('src', 'vellis-asset://local/repo/fixtures/x');
		Object.defineProperty(img, 'complete', { value: true });
		Object.defineProperty(img, 'naturalWidth', { value: 0 });
		body.appendChild(img);
		img.dispatchEvent(new w.Event('error'));

		const rec = snapshot();
		expect(Object.keys(rec).sort()).toEqual([...RECORD_KEYS].sort());
		expect(rec.dialogs).toHaveLength(1);
		expect(rec.console_errors).toHaveLength(1);
		expect(rec.resource_errors).toEqual([
			{
				tag: 'img',
				attr: 'vellis-asset://local/repo/fixtures/x',
				resolved: 'vellis-asset://local/repo/fixtures/x',
			},
		]);
		expect(rec.asset_images).toEqual({ loaded: 0, failed: 1 });
		expect(rec.csp).toEqual([]);
		expect(rec.script_errors).toEqual([]);
		expect(rec.rejections).toEqual([]);
	});
});
