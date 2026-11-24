/**
 * 要件#74 第3段 3-5 の続き — ファイルを落としても、窓の中身が切り替わらない(ページの側の守り)
 * (docs/requirements/req-74.md 状態節「2026-11-20 夜 再照合と実機の用意」の由谷の決定 20:20。component プロジェクト・JSDOM)
 *
 * ## なぜ要るか
 * Tauri の drag-drop の受け手を切る(`src-tauri/tests/acceptance_req74_drag_drop.rs`)と、ドラッグが WKWebView に届く
 * (3-5 の handleDrop が動く)。その代わり、ページがファイルのドロップの既定の動きを止めないと、WKWebView は落とした
 * ファイルへ移り、窓の中身がそのファイルに切り替わる。今の守りを読んだ結果(2026-11-20):
 * - Rust: 窓の作り(commands/window.rs・ipc/handler.rs・self_check/mod.rs)にも tauri::Builder にも `on_navigation` が無い
 * - JS: `dragover` / `drop` の受け手は ProseMirror の面(MarkdownEditor.svelte の handleDrop と prosemirror-view)だけ。
 *   `window` / `document` / `+page.svelte` には無い
 * - ProseMirror の面にファイルだけを落とすと、handleDrop は文字が無いので false を返し、prosemirror-view も切片が無いので
 *   何もせず戻る= どちらも `preventDefault()` しない(面の外は受け手そのものが無い)
 * よって、ページの側でファイルの `dragover` / `drop` の既定の動きを止める(面の外でも中でも)。
 *
 * ## 確定契約(implementer はこれに従う=test-writer が固定)
 *
 * ```ts
 * // --- src/lib/file-drop-guard.ts(新規)
 * /**
 *  * ファイルのドラッグ(`event.dataTransfer.types` に 'Files' を含む)の `dragover` と `drop` で `preventDefault()` する
 *  * (WKWebView が落としたファイルへ移らない)。ファイルでないドラッグ(文字・HTML・面の中の語の移動)には触れない。
 *  * `target` に受け手を付け、戻り値の関数で外す。`DragEvent` のコンストラクタに頼らない(`event.dataTransfer` を読む)。
 *  *\/
 * export function installFileDropGuard(target: Window): () => void;
 *
 * // --- src/routes/+page.svelte
 * // `import { installFileDropGuard } from '$lib/file-drop-guard'` し、`installFileDropGuard(window)` を呼ぶ(onMount の中で、
 * // 戻り値で外すのが家風。self-check の窓も同じページなので同じく守られる)
 * ```
 * - 受け手は capture で付ける(`target.addEventListener(type, …, true)` か `{ capture: true }`)。CodeMirror の面に落とした
 *   ファイルは、CodeMirror の既定(中身を FileReader で読んで文字で入れる= @codemirror/view の handlers.drop)より先に止める
 *   必要がある。CodeMirror は `defaultPrevented` を見て自分の受け手を止めるので、capture なら中身は入らない。bubble では
 *   中身が入り、下の 7 が赤になる(7・8 で実質 capture に決まる=2026-11-20 オーケストレーターの回答)。`dropEffect` を
 *   変えるかは実装の裁量(判定しない)
 * - 面の中のファイルのドロップは何もしない= 文字にしない・文書は変わらない(Markdown の面は今の handleDrop の作りのまま・
 *   CodeMirror の面も中身を入れない)
 *
 * ## 判定するもの
 * 1. ガードを付けると、面の外(ツールバー・body)へのファイルの `dragover` と `drop` は既定の動きが止まる
 *    (types が 'Files' だけのもの・'Files' と 'text/uri-list' のもの)
 * 2. ファイルでないドラッグ(text/plain・外の text/html・ProseMirror の切片)の `dragover` と `drop` には触れない(面の外)
 * 3. 外し関数を呼ぶと止めなくなる(受け手で守っていること)
 * 4. Markdown の面にファイルを落としても、文書は変わらず(文字にしない)、既定の動きは止まる
 * 5. ガードを付けても、面への外の文字のドロップは今のまま文字で入る(3-5 の handleDrop を妨げない)
 * 6. `+page.svelte` が `$lib/file-drop-guard` の `installFileDropGuard(window)` を呼ぶ(ソース走査)
 * 7. CodeEditor の面(plain text)と RawSourceEditor の面(Markdown の raw)にファイルを落としても、文書は変わらず
 *    (中身を入れない)、drop の既定の動きは止まる
 * 8. ガードを付けても、CodeMirror の面に外の文字(text/plain)を落とすと今のまま文字で入る(CodeMirror の文字のドロップを妨げない)
 *
 * ## 判定しないもの
 * - 本物の WKWebView が落としたファイルへ移らないこと → 実機(Finder からのドロップ=由谷が 1 回の行)
 *
 * ## 決定の記録(2026-11-20 オーケストレーターの回答)
 * - CodeMirror の面(コード・plain text・raw)にファイルを落としても、中身は入れない。根拠= 手順書の B.6(Finder からファイルを
 *   落とすのは「今のまま」= 何も起きない)と、由谷の決定「ファイルを落としたときに窓の中身がそのファイルに切り替わらない
 *   ことも守る」(2026-11-20 20:20)。よってガードは capture で付ける
 *
 * ## 赤になる理由(実装前)
 * `src/lib/file-drop-guard.ts` が無いので 1〜5・7・8 は「モジュールが無い」で赤(`import.meta.glob` で読むので、ファイル全体では
 * なくテストごとに赤)。6 は `+page.svelte` に `installFileDropGuard` が無いので赤。モジュールができても、4 は今の面だけでは
 * `defaultPrevented` が false(上の「なぜ要るか」)なので、ガードが要る。7 は今の CodeMirror がファイルの中身を入れるので
 * (bubble で付けたガードでも同じ)、capture のガードが要る。
 *
 * jsdom には DragEvent / DataTransfer が無いので、3-5 の既存のテスト(MarkdownEditor.wiring.test.ts「3-5: ドロップ」)と同じく
 * MouseEvent に `dataTransfer` を付ける。posAtCoords はレイアウトが無いので instance で差し替える。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { EditorView } from 'prosemirror-view';
import { EditorView as CMView } from '@codemirror/view';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { MarkdownEditorHandle } from '../editor/file-editor';
import { textSpots } from '../editor/markdown.testkit';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({
	mountMermaid: vi.fn(async () => undefined),
}));
vi.mock('$lib/events', () => ({
	listen: async () => () => {},
}));

const REPO_ROOT = resolve(__dirname, '../..');
const PAGE_PATH = resolve(REPO_ROOT, 'src/routes/+page.svelte');

// ---------------------------------------------------------------------------
// 契約のモジュール(まだ無いときはテストごとに赤にする)
// ---------------------------------------------------------------------------

type GuardModule = { installFileDropGuard?: (target: Window) => () => void };

const GUARD_MODULES = import.meta.glob<GuardModule>('../lib/file-drop-guard.ts');
const GUARD_KEY = '../lib/file-drop-guard.ts';

let disposers: Array<() => void> = [];

async function installGuard(): Promise<() => void> {
	const load = GUARD_MODULES[GUARD_KEY];
	expect(load, 'src/lib/file-drop-guard.ts があること(確定契約)').toBeDefined();
	const mod = await load!();
	expect(typeof mod.installFileDropGuard, 'installFileDropGuard を export すること').toBe('function');
	const dispose = mod.installFileDropGuard!(window);
	expect(typeof dispose, 'installFileDropGuard は外し関数を返すこと').toBe('function');
	disposers.push(dispose);
	return dispose;
}

// ---------------------------------------------------------------------------
// JSDOM の polyfill(ProseMirror の計測が落ちないように。MarkdownEditor.wiring.test.ts と同じ)
// ---------------------------------------------------------------------------

beforeAll(() => {
	const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
	const emptyRects = () => Object.assign([] as DOMRect[], { item: (_i: number) => null }) as unknown as DOMRectList;
	const rangeProto = Range.prototype as unknown as Record<string, unknown>;
	if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = emptyRects;
	if (typeof rangeProto.getBoundingClientRect !== 'function') rangeProto.getBoundingClientRect = zeroRect;
	if (typeof (document as unknown as Record<string, unknown>).elementFromPoint !== 'function') {
		(document as unknown as Record<string, unknown>).elementFromPoint = () => null;
	}
});

beforeEach(() => {
	windowState.clearDocument();
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	cleanup();
	windowState.clearDocument();
	document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// ドラッグの事象(jsdom に DragEvent が無いので MouseEvent に dataTransfer を付ける)
// ---------------------------------------------------------------------------

type Drag = {
	/** dataTransfer.types */
	types: string[];
	/** getData の中身(type → 文字) */
	data?: Record<string, string>;
	/** drop のときの dataTransfer.files(dragover のあいだは空=ブラウザと同じ) */
	files?: File[];
};

const MD_FILE = () => new File(['# Other\n'], 'other.md', { type: 'text/markdown' });

/** Finder からファイルを 1 つ落とす形(types は 'Files' だけ)。 */
const FILE_ONLY = (): Drag => ({ types: ['Files'], files: [MD_FILE()] });
/** ファイルと、その file:// の URL を載せる形。 */
const FILE_WITH_URI = (): Drag => ({
	types: ['text/uri-list', 'Files'],
	data: { 'text/uri-list': 'file:///Users/a/notes/other.md' },
	files: [MD_FILE()],
});
/** 外のアプリの文字。 */
const PLAIN_TEXT = (): Drag => ({ types: ['text/plain'], data: { 'text/plain': 'dropped words' } });
/** 外の HTML(Safari の型)。 */
const OUTER_HTML = (): Drag => ({
	types: ['text/html', 'text/plain'],
	data: { 'text/html': '<b>bold</b> <a href="https://x.example">link</a>', 'text/plain': 'bold link' },
});
/** 同じ面の中の語の移動(ProseMirror の切片)。 */
const PM_SLICE = (): Drag => ({
	types: ['text/html', 'text/plain'],
	data: { 'text/html': '<p data-pm-slice="1 1 []">abc</p>', 'text/plain': 'abc' },
});

function dragEvent(type: 'dragover' | 'drop', drag: Drag): MouseEvent {
	const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
	const files = type === 'drop' ? (drag.files ?? []) : [];
	Object.defineProperty(ev, 'dataTransfer', {
		value: {
			types: drag.types,
			files,
			items: [],
			// 'Text' は text/plain の別名(ブラウザと同じ。CodeMirror は getData("Text") で読む)
			getData: (t: string) => drag.data?.[t === 'Text' || t === 'text' ? 'text/plain' : t] ?? '',
			setData: () => {},
			clearData: () => {},
			dropEffect: 'none',
			effectAllowed: 'all',
		},
	});
	return ev;
}

/** `target` に dragover と drop を送り、それぞれ既定の動きが止まったかを返す。 */
function dragOnto(target: Element, drag: Drag): { dragover: boolean; drop: boolean } {
	const over = dragEvent('dragover', drag);
	target.dispatchEvent(over);
	const drop = dragEvent('drop', drag);
	target.dispatchEvent(drop);
	return { dragover: over.defaultPrevented, drop: drop.defaultPrevented };
}

// ---------------------------------------------------------------------------
// Markdown の面(MarkdownEditor.wiring.test.ts の mountMd と同じ載せ方)
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/plan.md';
const FACE = 'article.viewer .markdown-body [data-testid="markdown-editor"]';
const PM = `${FACE} .ProseMirror`;

async function settle(rounds = 8) {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
	await tick();
}
async function settleLong() {
	await settle();
	await new Promise((r) => setTimeout(r, 0));
	await settle();
}

async function mountMd(content: string) {
	const d: DocumentPayload = { uri: MD_URI, content, modified: 1 };
	windowState.setDocument(d);
	const r = await renderMarkdown(content, MD_URI);
	const result = render(Viewer, {
		props: {
			document: d,
			html: r.html,
			index: r.index,
			onRequestAddMark: vi.fn(),
			onToggleMarks: vi.fn(),
			marksOpen: false,
		},
	});
	await settleLong();
	return result;
}

function handle(): MarkdownEditorHandle {
	const h = windowState.fileEditor as MarkdownEditorHandle | null;
	if (!h) throw new Error('windowState.fileEditor が登録されていない');
	if (h.kind !== 'markdown') throw new Error(`handle.kind が markdown でない: ${String(h.kind)}`);
	return h;
}
function view(): EditorView {
	return handle().view;
}

/**
 * ProseMirror の面の `pos` に落とし、drop の既定の動きが止まったかを返す(posAtCoords はレイアウトが無いので instance で
 * 差し替える)。面の dragover は prosemirror-view が常に止めるうえ、dropcursor が印を置くのにレイアウト(offsetParent)が
 * 要るので送らない(3-5 の既存のテストと同じく drop だけ)。
 */
function dropOnFace(v: EditorView, pos: number, drag: Drag): boolean {
	(v as unknown as { posAtCoords: () => { pos: number; inside: number } | null }).posAtCoords = () => ({ pos, inside: -1 });
	const drop = dragEvent('drop', drag);
	v.dom.dispatchEvent(drop);
	return drop.defaultPrevented;
}

// ---------------------------------------------------------------------------
// 1〜3 — 面の外(ページ全体の守り)
// ---------------------------------------------------------------------------

describe('ファイルを落としても窓の中身が切り替わらない — ページの守り(installFileDropGuard)', () => {
	function outside(): { toolbar: Element; body: Element } {
		const app = document.body.appendChild(document.createElement('div'));
		app.className = 'app';
		const viewer = app.appendChild(document.createElement('article'));
		viewer.className = 'viewer';
		const toolbar = viewer.appendChild(document.createElement('header'));
		toolbar.className = 'viewer-toolbar';
		return { toolbar, body: document.body };
	}

	it.each([
		['types が Files だけ(Finder から 1 つ)', FILE_ONLY],
		['Files と text/uri-list(file:// の URL つき)', FILE_WITH_URI],
	])('面の外(ツールバー・body)へのファイルの dragover と drop は既定の動きが止まる: %s', async (_name, make) => {
		const { toolbar, body } = outside();
		// 前提: ガードが無ければ誰も止めない(今の作り)
		expect(dragOnto(toolbar, make()), '前提: ガードを付ける前は止まらない').toEqual({ dragover: false, drop: false });
		await installGuard();
		expect(dragOnto(toolbar, make()), 'ツールバーへのファイルのドラッグ').toEqual({ dragover: true, drop: true });
		expect(dragOnto(body, make()), 'body へのファイルのドラッグ').toEqual({ dragover: true, drop: true });
	});

	it.each([
		['外のアプリの文字(text/plain)', PLAIN_TEXT],
		['外の HTML(text/html と text/plain)', OUTER_HTML],
		['面の中の語の移動(ProseMirror の切片)', PM_SLICE],
	])('ファイルでないドラッグの dragover と drop には触れない(面の外): %s', async (_name, make) => {
		const { toolbar } = outside();
		await installGuard();
		expect(dragOnto(toolbar, make())).toEqual({ dragover: false, drop: false });
	});

	it('外し関数を呼ぶと、ファイルのドラッグを止めなくなる', async () => {
		const { toolbar } = outside();
		const dispose = await installGuard();
		expect(dragOnto(toolbar, FILE_ONLY())).toEqual({ dragover: true, drop: true });
		dispose();
		disposers = disposers.filter((d) => d !== dispose);
		expect(dragOnto(toolbar, FILE_ONLY())).toEqual({ dragover: false, drop: false });
	});
});

// ---------------------------------------------------------------------------
// 4・5 — Markdown の面の中
// ---------------------------------------------------------------------------

describe('ファイルを落としても窓の中身が切り替わらない — Markdown の面の中(3-5 の handleDrop のまま)', () => {
	it('面にファイルを落としても、文書は変わらず(文字にしない)、drop の既定の動きは止まる', async () => {
		const { container } = await mountMd('abcdef\n');
		expect(container.querySelector(PM), '前提: ProseMirror の面がある').not.toBeNull();
		const v = view();
		const before = handle().text();
		const spot = textSpots(v.state.doc, 0)[0]!;
		await installGuard();
		const prevented = dropOnFace(v, spot.pos + 3, FILE_ONLY());
		await settleLong();
		expect(prevented, '面の中のファイルの drop も既定の動きが止まる(WKWebView がファイルへ移らない)').toBe(true);
		expect(handle().text(), '文書は変わらない(ファイルは文字にしない)').toBe(before);
		expect(v.state.doc.child(0).textContent).toBe('abcdef');
	});

	it('ガードを付けても、面への外の文字のドロップは今のまま文字で入る(handleDrop を妨げない)', async () => {
		await mountMd('abcdef\n');
		const v = view();
		const spot = textSpots(v.state.doc, 0)[0]!;
		await installGuard();
		const prevented = dropOnFace(v, spot.pos + 3, OUTER_HTML());
		await settleLong();
		expect(prevented, 'handleDrop が受けて既定の動きを止める(3-5)').toBe(true);
		expect(v.state.doc.child(0).textContent).toBe('abcbold linkdef');
		v.state.doc.child(0).forEach((n) => expect(n.marks).toHaveLength(0));
		expect(handle().text()).toBe('abcbold linkdef\n');
	});
});

// ---------------------------------------------------------------------------
// 6 — +page.svelte の配線(ソース走査)
// ---------------------------------------------------------------------------

describe('ファイルを落としても窓の中身が切り替わらない — +page.svelte が守りを付ける', () => {
	it("+page.svelte の <script> が '$lib/file-drop-guard' の installFileDropGuard を import し、installFileDropGuard(window) を呼ぶ", () => {
		const page = readFileSync(PAGE_PATH, 'utf8');
		const script = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
		expect(script.length, '前提: +page.svelte に <script> がある').toBeGreaterThan(0);
		const code = script.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
		expect(code, "import { installFileDropGuard } from '$lib/file-drop-guard'").toMatch(
			/import\s*\{[^}]*\binstallFileDropGuard\b[^}]*\}\s*from\s*['"]\$lib\/file-drop-guard(?:\.ts)?['"]/,
		);
		expect(code, 'installFileDropGuard(window) を呼ぶ').toMatch(/\binstallFileDropGuard\(\s*window\s*\)/);
	});
});

// ---------------------------------------------------------------------------
// 7・8 — CodeMirror の面(CodeEditor・RawSourceEditor)。中身を入れない(2026-11-20 オーケストレーターの回答)
// ---------------------------------------------------------------------------

describe('ファイルを落としても窓の中身が切り替わらない — CodeMirror の面(ファイルの中身を入れない)', () => {
	const TXT_URI = 'file:///Users/a/notes/memo.txt';
	const CODE_CM = 'article.viewer .markdown-body [data-testid="code-editor"] .cm-editor';
	const RAW_CM = 'article.viewer .markdown-body [data-testid="raw-source-editor"] .cm-editor';
	const CONTENT = 'abcdef\n';

	/** plain text の文書を載せる(CodeEditor の面。RawSource.wiring.test.ts の mountText と同じ載せ方)。 */
	async function mountText(content: string) {
		const d: DocumentPayload = { uri: TXT_URI, content, modified: 1 };
		windowState.setDocument(d);
		const result = render(Viewer, {
			props: { document: d, html: '', index: null, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false },
		});
		await settleLong();
		return result;
	}

	function cmAt(container: ParentNode, selector: string): CMView {
		const el = container.querySelector(selector);
		if (!el) throw new Error(`CodeMirror の面(${selector})が無い`);
		const v = CMView.findFromDOM(el as HTMLElement);
		if (!v) throw new Error('EditorView.findFromDOM が null');
		return v;
	}

	/** CodeEditor の面か、Markdown を開いて View ▸ Raw Source で出した RawSourceEditor の面の CodeMirror。 */
	async function mountCodeMirror(which: 'code' | 'raw'): Promise<CMView> {
		if (which === 'code') {
			const { container } = await mountText(CONTENT);
			return cmAt(container, CODE_CM);
		}
		const { container } = await mountMd(CONTENT);
		handle().toggleRaw();
		await settleLong();
		return cmAt(container, RAW_CM);
	}

	/**
	 * CodeMirror の面の `pos` に落とし、drop の既定の動きが止まったかを返す(posAtCoords はレイアウトが無いので instance で
	 * 差し替える)。CodeMirror の受け手は `.cm-content` に付くので、そこへ送る。
	 */
	function dropOnCodeMirror(v: CMView, pos: number, drag: Drag): boolean {
		(v as unknown as { posAtCoords: () => number }).posAtCoords = () => pos;
		const drop = dragEvent('drop', drag);
		v.contentDOM.dispatchEvent(drop);
		return drop.defaultPrevented;
	}

	/** CodeMirror はファイルを FileReader で読んでから入れるので、読み終わりまで待つ。 */
	async function settleFiles() {
		await settleLong();
		await new Promise((r) => setTimeout(r, 50));
		await settleLong();
	}

	const FACES_CM: Array<[name: string, which: 'code' | 'raw']> = [
		['CodeEditor(plain text)', 'code'],
		['RawSourceEditor(Markdown の raw)', 'raw'],
	];

	it.each(FACES_CM)(
		'%s の面にファイルを落としても、文書は変わらず(中身を入れない)、drop の既定の動きは止まる',
		async (_name, which) => {
			const v = await mountCodeMirror(which);
			const before = v.state.doc.toString();
			expect(before, '前提: 面に文書が載っている').toContain('abcdef');
			expect(v.state.readOnly, '前提: 面は編集できる(読み取り専用なら CodeMirror は何もしない)').toBe(false);
			await installGuard();
			const prevented = dropOnCodeMirror(v, 3, FILE_ONLY());
			await settleFiles();
			expect(prevented, 'ファイルの drop は既定の動きが止まる(WKWebView がファイルへ移らない)').toBe(true);
			expect(v.state.doc.toString(), '文書は変わらない(ファイルの中身を入れない)').toBe(before);
		},
	);

	it.each(FACES_CM)(
		'%s の面に外の文字(text/plain)を落とすと、今のまま文字で入る(ガードが CodeMirror の文字のドロップを妨げない)',
		async (_name, which) => {
			const v = await mountCodeMirror(which);
			const before = v.state.doc.toString();
			expect(before.startsWith('abcdef'), `前提: 面に文書が載っている(${JSON.stringify(before)})`).toBe(true);
			await installGuard();
			const prevented = dropOnCodeMirror(v, 3, { types: ['text/plain'], data: { 'text/plain': 'XY' } });
			await settleLong();
			expect(prevented, 'CodeMirror が受けて既定の動きを止める').toBe(true);
			expect(v.state.doc.toString()).toBe(`${before.slice(0, 3)}XY${before.slice(3)}`);
		},
	);
});
