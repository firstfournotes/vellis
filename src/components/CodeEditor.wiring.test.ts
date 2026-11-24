/**
 * 要件#74 第1段の受け入れテスト(docs/requirements/req-74.md)— コードのファイルと plain text の面(CodeMirror 6)の配線
 * (AC-74-1・11・12・13・14 (2)・15・16 の面の分・17・20・29・30 (3)・31・32・38・39・41・42 の第1段の分。
 *  契約 3・5・10〜17・21。component プロジェクト・JSDOM に Viewer を載せる)
 *
 * `Viewer.svelte` に `fileEditor={true}` と `text` 種別の文書を渡し、CodeMirror の `EditorView` が出て、開いた時点から編集
 * できることと、共通の骨格(dirty・履歴・外部変更の取り込みと 3 方向マージ・削除の帯・保存の照合・改行コード・未保存の確認・
 * Reload File・検索・ズーム・印刷・コピー・貼り付け・配色・読み取り専用)を判定する。純関数の側は `src/editor/*.acceptance.test.ts`。
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 契約19「第1段の作り」1〜16。無いものは test-writer が固定)
 *
 * ```ts
 * // --- src/components/Viewer.svelte の $props に足す(既定は閉じた側=今の表示)
 * fileEditor?: boolean;   // = false。真で種別 text のとき {@html html} を出さず <CodeEditor> を出す。markdown / html は fileEditor によらず今のまま
 * codeTheme?: string;     // = 'github-light'。面の配色(Shiki の同梱テーマの名前)。ページは今の `codeTheme` を渡す
 *
 * // --- src/components/CodeEditor.svelte(新規)
 * // 根: <div class="code-editor" data-testid="code-editor" data-code-theme="<codeTheme>" [data-vellis-lang="<言語 id>"]>
 * //   - `data-vellis-lang` はコードのファイル(`languageForFile(uri)` が言語を返す)にだけ付く(今の `pre.vellis-plaintext` と同じ)
 * //   - 中に CodeMirror の EditorView(`.cm-editor`)。`EditorView.findFromDOM(根)` で取れる
 * //   - 行番号(`lineNumbers()`=`.cm-gutters`)はコードのファイルにだけ
 * //   - 読み取り専用(SSH root=canEnterEdit が偽)= `EditorView.editable.of(false)` と `EditorState.readOnly.of(true)` の両方
 * //     → `.cm-content[contenteditable="false"]`・打鍵・貼り付け・保存で何も変わらない
 * //   - キー割り当ては `CODE_KEYMAP`(`src/editor/code-keymap.ts`)。`EditorView.inputHandler` は使わない(括弧・引用符の補完を入れないため)
 * //   - 括弧の対応の強調= `bracketMatching()`(`.cm-matchingBracket`)。折り畳み(`.cm-foldGutter`)・補完・lint は無い
 * //   - ズーム: 根の inline style の `font-size` に倍率を掛ける(`zoom` 100 以外のとき。150 なら `1.5` か `150%` を含む値)。
 * //     面とその祖先に CSS の `zoom` / `transform` を付けない(fileEditor の面のとき `.markdown-body` の style:zoom も出さない)
 * //   - 幅と書体(AC-74-42・CSS のソース走査): plain text の面(`:not([data-vellis-lang])`)は `max-width: var(--doc-measure)`、
 * //     `:root[data-doc-measure="full"]` で `max-width: none`。コードの面は上限なし。書体は `var(--font-mono)`
 * //   - 印刷: window の `beforeprint` で、今の文字列を今の描画(Shiki の `<pre class="vellis-plaintext">`・色なしなら renderPlainText)に
 * //     した DOM を <div data-testid="code-editor-print"> に作り、`afterprint` で消す。`print.css` は触らない。
 * //     (刷る直前の描画が documentText から作られていること=文字列の一致を見る。色付けの有無・@media print の隠し方は見ない)
 * //   - 変換中: contentDOM の compositionstart〜compositionend を自前でも数える(`view.composing` は DOM の変化を見るまで真に
 * //     ならず、擬似イベントでは立たない)。変換中に届いた file_changed と FindBar の語の変更は confirm まで待ち、確定後に 1 回だけ当てる
 * //   - mount で `windowState.fileEditor = handle`、unmount(別の文書・閉じる)で `null` に戻す
 *
 * // --- src/editor/file-editor.ts(新規)
 * import type { DocumentPayload } from '../stores/window-state.svelte';
 * import type { FileChangedDecision } from '$lib/document-edit';
 * export interface FileEditorHandle {
 *   readonly uri: string;
 *   readonly readOnly: boolean;
 *   /** 文字列の比較(documentText !== 基準の版)。 *\/
 *   readonly dirty: boolean;
 *   /** 重なった外部変更(帯を出している間)。 *\/
 *   readonly conflict: boolean;
 *   text(): string;                       // documentText
 *   expectedHash(): string;               // contentHash(基準の版)=保存の照合に渡す
 *   markSaved(text: string): void;        // 基準の版 ← text・自己書き込みのハッシュを覚える・dirty を消す
 *   applyFileChanged(payload: DocumentPayload): FileChangedDecision;
 *   //   自己書き込みのエコー → 'ignore-echo'(取引なし)/ dirty でない・clean なマージ → 'apply' / 重なる → 'external-conflict'
 *   keepMyEdits(): void;                  // 文書を残し、基準の版を届いた内容へ(次の保存は上書き)
 *   useFileOnDisk(): void;                // 届いた内容を読み直す(dirty でなくなる)
 * }
 * export const MERGED_NOTICE = 'This file was changed on disk. The changes were merged.';
 * export const CONFLICT_MESSAGE = 'This file was changed on disk. It overlaps your edits.';
 * /** Rust の `save_document` が照合に失敗したときのエラーの接頭辞(契約14)。 *\/
 * export const SAVE_CONFLICT_PREFIX = 'The file was changed on disk';
 * /** Command + S / File ▸ Save / 削除の帯の Save / 未保存の確認の Save の共通の経路。 *\/
 * export async function saveFileEditor(handle: FileEditorHandle): Promise<void>;
 * //   readOnly → 何もしない(invoke しない)。dirty でなく externalRemoved でもない → 何もしない
 * //   invoke('save_document', { uri, content: handle.text(), expectedHash: handle.expectedHash() })
 * //     windowState.externalRemoved が立っていれば expectedHash を**渡さない**(鍵ごと省く)
 * //   成功 → handle.markSaved(content)・windowState.markSaved(content)
 * //   失敗が SAVE_CONFLICT_PREFIX で始まる → 重なりの帯(handle.conflict=true)・dirty のまま・例外を外へ出さない
 *
 * // --- src/stores/window-state.svelte.ts に足す(今の欄は残す)
 * fileEditor: FileEditorHandle | null;           // $state・既定 null
 * dirty: 今の dirty || (fileEditor?.dirty ?? false)   // 未保存の確認・削除の帯・Reload File が見る
 * beginEdit(): fileEditor が登録されていれば false を返して何もしない(Command + E・ダブルクリックで今の編集に入らない)
 * applyFileChanged(payload): fileEditor があり uri が同じなら fileEditor.applyFileChanged(payload) に委ねてその値を返す
 * applyReloadedText(doc) / setDocument(doc): 面は文書モデルを作り直す(履歴 0・dirty でない=(ak))
 *
 * // --- Viewer の帯と札(今の帯と同じ位置・同じ class `external-change`)
 * // <div class="external-change" data-testid="external-conflict-banner" role="alert"> CONFLICT_MESSAGE
 * //   <button data-testid="external-conflict-keep">Keep My Edits</button> <button data-testid="external-conflict-disk">Use the File on Disk</button>
 * // <div data-testid="external-merged-notice" role="status"> MERGED_NOTICE(数秒で消える=消え方は見ない)
 * // 削除の帯= 今の `external-removed-banner` / `external-removed-save` / `external-removed-close`(文言も今のまま。Save は saveFileEditor)
 * // 未保存の印((aj))= ツールバーに <span data-testid="unsaved-badge">Unsaved</span> を dirty の間だけ
 * // confirmDiscardEdits(`$lib/edit-guard`)の Save は、fileEditor があれば saveFileEditor を使う
 * ```
 *
 * ## 判断の記録(test-writer 2026-11-16)
 * - 打鍵は `view.dispatch`(userEvent `input.type`)で、キーは contentDOM への `keydown` で当てる。JSDOM は macOS でないので
 *   `Mod` は Ctrl(undo=Ctrl+Z・redo=Ctrl+Shift+Z)。undo / redo の `beforeinput`(historyUndo / historyRedo)も当てる
 * - JSDOM には `Range.getClientRects` / `getBoundingClientRect` が無いので、CodeMirror のために最小の polyfill を置く(座標は 0)
 * - 「数秒で消える」知らせ・配色の見た目・座標は判定しない(人間ゲート)。配色の切り替えは `data-code-theme` と「同じ EditorView の
 *   まま文書・選択・undo の段数が保たれる」で見る
 * - 印刷は `beforeprint` / `afterprint` を window に送って面の反応を見る(周回0 の 0-9 で経路が変わっても、この振る舞いは保つ)
 *
 * ## 修正前に赤になる理由
 * - `./CodeEditor.svelte`・`../editor/*`・`@codemirror/*` が無いので import で落ちる(全ケースが赤)。
 *   `fileEditor={false}` の「今のまま」のケースは Viewer が未知の prop を無視するので実装前から緑(閉じた側の固定)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EditorView } from '@codemirror/view';
import { undoDepth } from '@codemirror/commands';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { contentHash } from '$lib/document-edit';
import { findMatches, formatCount } from '$lib/find-in-document';
import { createFileReloader } from '$lib/reload-file';
import {
	CONFLICT_MESSAGE,
	MERGED_NOTICE,
	SAVE_CONFLICT_PREFIX,
	saveFileEditor,
	type FileEditorHandle,
} from '../editor/file-editor';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({
	mountMermaid: vi.fn(async () => undefined),
}));
vi.mock('$lib/events', () => {
	const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
	return {
		listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const cur = handlers.get(event) ?? [];
				const at = cur.indexOf(handler);
				if (at >= 0) cur.splice(at, 1);
			};
		},
		__eventHandlers: handlers,
	};
});

import { message } from '@tauri-apps/plugin-dialog';
import { invoke } from '$lib/ipc';
import { confirmDiscardEdits } from '$lib/edit-guard';
import * as eventsModule from '$lib/events';

const messageMock = vi.mocked(message);
const invokeMock = vi.mocked(invoke);
const alertMock = vi.fn((_message?: unknown) => {});
const menuHandlers = (
	eventsModule as unknown as { __eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>> }
).__eventHandlers;

const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURES = resolve(REPO_ROOT, 'fixtures/editing');
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), 'utf8');

// ---------------------------------------------------------------------------
// JSDOM の polyfill(CodeMirror の計測が落ちないように。座標は 0)
// ---------------------------------------------------------------------------

beforeAll(() => {
	const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
	const emptyRects = () => {
		const list: DOMRect[] = [];
		return Object.assign(list, { item: (_i: number) => null }) as unknown as DOMRectList;
	};
	const rangeProto = Range.prototype as unknown as Record<string, unknown>;
	if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = emptyRects;
	if (typeof rangeProto.getBoundingClientRect !== 'function') rangeProto.getBoundingClientRect = zeroRect;
	if (typeof (document as unknown as Record<string, unknown>).elementFromPoint !== 'function') {
		(document as unknown as Record<string, unknown>).elementFromPoint = () => null;
	}
});

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const TXT_URI = 'file:///Users/a/notes/memo.txt';
const TXT_CONTENT = 'first line\nsecond line\nthird line\n';
const TS_URI = 'file:///Users/a/src/app.ts';
const TS_CONTENT = fixture('indent-two-spaces.ts');
const RS_URI = 'file:///Users/a/src/main.rs';
const SETTINGS_URI = 'file:///Users/a/Library/Application Support/vellis/settings.json';
const SSH_URI = 'ssh://host/srv/app/main.rs';
const GRAPHQL_URI = 'file:///Users/a/src/query.graphql';
const MD_URI = 'file:///Users/a/notes/plan.md';
const MD = ['# Plan', '', 'Intro paragraph.', '', 'Tail paragraph.', ''].join('\n');

let renderedMd: { html: string; index: SourceIndex };

beforeAll(async () => {
	const result = await renderMarkdown(MD, MD_URI);
	renderedMd = { html: result.html, index: result.index };
});

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}

/** file-type.ts の renderPlainText と同形(ページが今も html prop に渡すもの)。 */
function plainTextHtml(content: string): string {
	const escaped = content.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
	);
	return `<pre class="vellis-plaintext">\n${escaped}</pre>`;
}

type ViewerProps = {
	fileEditor?: boolean;
	codeTheme?: string;
	zoom?: number;
	editable?: boolean;
	aiTools?: boolean;
};

function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null, extra: ViewerProps) {
	return {
		document: d,
		html,
		index,
		onRequestAddMark: vi.fn(),
		onToggleMarks: vi.fn(),
		marksOpen: false,
		...extra,
	};
}

async function settle(rounds = 8) {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
	await tick();
}

/** 言語の遅延読み込みと CodeMirror の計測が落ち着くまで(マクロタスクを 1 つ挟む)。 */
async function settleLong() {
	await settle();
	await new Promise((r) => setTimeout(r, 0));
	await settle();
}

/** text の文書を windowState と Viewer に載せ、fileEditor=true で描く。 */
async function mountText(uri: string, content: string, extra: ViewerProps = {}) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const result = render(Viewer, { props: baseProps(d, plainTextHtml(content), null, { fileEditor: true, ...extra }) });
	await settleLong();
	return result;
}

function faceRoot(container: ParentNode): HTMLElement {
	const el = container.querySelector('[data-testid="code-editor"]');
	if (!el) throw new Error('面の根(data-testid="code-editor")が無い');
	return el as HTMLElement;
}

function viewOf(container: ParentNode): EditorView {
	const root = faceRoot(container);
	const cm = root.querySelector('.cm-editor') ?? root;
	const view = EditorView.findFromDOM(cm as HTMLElement);
	if (!view) throw new Error('EditorView.findFromDOM が EditorView を返さない');
	return view;
}

function handle(): FileEditorHandle {
	const h = windowState.fileEditor;
	if (!h) throw new Error('windowState.fileEditor が登録されていない');
	return h;
}

function text(): string {
	return handle().text();
}

/** 打鍵(1 文字の挿入)。 */
function type(view: EditorView, s: string, at?: number) {
	const from = at ?? view.state.selection.main.head;
	view.dispatch({ changes: { from, insert: s }, selection: { anchor: from + s.length }, userEvent: 'input.type' });
}

function cursor(view: EditorView, pos: number) {
	view.dispatch({ selection: { anchor: pos } });
}

function key(view: EditorView, k: string, init: KeyboardEventInit = {}) {
	view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
}

function beforeInput(view: EditorView, inputType: string) {
	view.contentDOM.dispatchEvent(new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }));
}

function composition(view: EditorView, kind: 'compositionstart' | 'compositionend') {
	view.contentDOM.dispatchEvent(new CompositionEvent(kind, { bubbles: true, data: '' }));
}

function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}

async function emitMenuFind() {
	await settle();
	const list = [...(menuHandlers.get('menu_find') ?? [])];
	expect(list.length, "Viewer が $lib/events の listen で 'menu_find' を購読していること").toBeGreaterThan(0);
	for (const h of list) h({ payload: undefined });
	await settle();
}

async function typeQuery(container: ParentNode, value: string) {
	const input = q(container, '[data-testid="find-input"]') as HTMLInputElement | null;
	expect(input, '検索バーの入力欄').toBeTruthy();
	await fireEvent.input(input!, { target: { value } });
	await settleLong();
}

function countText(container: ParentNode): string {
	return (q(container, '[data-testid="find-count"]')?.textContent ?? '').trim();
}

beforeEach(() => {
	vi.stubGlobal('alert', alertMock);
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
	messageMock.mockReset();
	alertMock.mockReset();
	menuHandlers.clear();
	windowState.clearDocument();
});

afterEach(() => {
	cleanup();
	windowState.clearDocument();
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// AC-74-29 — コードと plain text の面(契約5・契約3)
// ---------------------------------------------------------------------------

describe('AC-74-29: fileEditor が真で text 種別のとき、開いた直後から CodeMirror の面', () => {
	it('CodeMirror の EditorView が出て、pre.vellis-plaintext と contenteditable の <pre> が無い', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		expect(view.state.doc.toString().length).toBeGreaterThan(0);
		expect(q(container, 'pre.vellis-plaintext'), '表示に Shiki / plain の <pre> を使わない').toBeNull();
		expect(q(container, 'pre[contenteditable]'), '今の編集の <pre contenteditable> が無い').toBeNull();
		expect(q(container, '.cm-content[contenteditable="true"]'), '面は開いた時点から編集できる').not.toBeNull();
		expect(windowState.dirty, '開いただけでは dirty でない').toBe(false);
	});

	it('documentText が CodeMirror の文書の文字列と一致する(LF の文書)', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		expect(text()).toBe(TXT_CONTENT);
		expect(view.state.doc.toString()).toBe(TXT_CONTENT);
	});

	it('windowState.fileEditor に面の handle が登録され、uri と readOnly が合う', async () => {
		await mountText(TS_URI, TS_CONTENT);
		const h = handle();
		expect(h.uri).toBe(TS_URI);
		expect(h.readOnly).toBe(false);
		expect(h.dirty).toBe(false);
		expect(h.conflict).toBe(false);
		expect(h.expectedHash()).toBe(contentHash(TS_CONTENT));
	});

	it('コードのファイル(.ts)には行番号の gutter があり data-vellis-lang が付く', async () => {
		const { container } = await mountText(TS_URI, TS_CONTENT);
		expect(q(container, '.cm-gutters'), '行番号').not.toBeNull();
		expect(faceRoot(container).getAttribute('data-vellis-lang')).toBe('typescript');
	});

	it('plain text(.txt・.log=言語が分からない)には gutter が無く data-vellis-lang も無い', async () => {
		const txt = await mountText(TXT_URI, TXT_CONTENT);
		expect(q(txt.container, '.cm-gutters')).toBeNull();
		expect(faceRoot(txt.container).hasAttribute('data-vellis-lang')).toBe(false);
		cleanup();
		windowState.clearDocument();
		const log = await mountText('file:///Users/a/app.log', 'started\nstopped\n');
		expect(q(log.container, '.cm-gutters')).toBeNull();
		expect(faceRoot(log.container).hasAttribute('data-vellis-lang')).toBe(false);
	});

	it('settings.json を開いた窓でも同じ面になり、言語(json)が分かるので gutter がある(由谷 2026-11-16・第1段の作り 15)', async () => {
		const { container } = await mountText(SETTINGS_URI, fixture('settings.json'));
		viewOf(container);
		expect(q(container, 'pre.vellis-plaintext')).toBeNull();
		expect(text()).toBe(fixture('settings.json'));
		expect(q(container, '.cm-gutters'), '言語が分かる設定ファイルには行番号を出す').not.toBeNull();
		expect(faceRoot(container).getAttribute('data-vellis-lang')).toBe('json');
	});

	it('文法の無い言語(.graphql)でも面が出て打てる', async () => {
		const { container } = await mountText(GRAPHQL_URI, fixture('query.graphql'));
		const view = viewOf(container);
		type(view, 'Z', 0);
		expect(text()).toBe('Z' + fixture('query.graphql'));
		expect(handle().dirty).toBe(true);
	});

	it('Enter で改行が入り、前の行の字下げが引き継がれる(構文による字下げはしない)', async () => {
		const { container } = await mountText(TS_URI, TS_CONTENT);
		const view = viewOf(container);
		// 2 行目 `  if (a > b) {` の行末。
		const line2 = view.state.doc.line(2);
		cursor(view, line2.to);
		key(view, 'Enter');
		await settle();
		const out = text();
		const lines = out.split('\n');
		expect(lines[1]).toBe('  if (a > b) {');
		expect(lines[2], '新しい行は前の行と同じ字下げ(2 つの空白)だけ=構文で深くしない').toBe('  ');
		expect(lines[3]).toBe('    return a + b;');
	});

	it('Tab で detectIndentUnit の単位(2 つの空白)が入り、Shift + Tab で戻る', async () => {
		const { container } = await mountText(TS_URI, TS_CONTENT);
		const view = viewOf(container);
		const line5 = view.state.doc.line(5); // `  return b + a;`
		cursor(view, line5.from);
		key(view, 'Tab');
		await settle();
		expect(text().split('\n')[4]).toBe('    return b + a;');
		key(view, 'Tab', { shiftKey: true });
		await settle();
		expect(text().split('\n')[4]).toBe('  return b + a;');
		key(view, 'Tab', { shiftKey: true });
		await settle();
		expect(text().split('\n')[4]).toBe('return b + a;');
	});

	it('タブで字下げしたファイル(.go)では Tab がタブ文字を入れる', async () => {
		const { container } = await mountText('file:///Users/a/src/main.go', fixture('indent-tabs.go'));
		const view = viewOf(container);
		const line = view.state.doc.line(7); // `\t\tfmt.Println(i)`
		cursor(view, line.from);
		key(view, 'Tab');
		await settle();
		expect(text().split('\n')[6]).toBe('\t\t\tfmt.Println(i)');
	});

	it('複数行を選んで Tab / Shift + Tab を押すとまとめて 1 段動く', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		view.dispatch({ selection: { anchor: view.state.doc.line(1).from, head: view.state.doc.line(2).to } });
		key(view, 'Tab');
		await settle();
		expect(text()).toBe('\tfirst line\n\tsecond line\nthird line\n');
		key(view, 'Tab', { shiftKey: true });
		await settle();
		expect(text()).toBe(TXT_CONTENT);
	});

	it('`(` を打つと `(` だけが入る(括弧の自動補完なし)。面は EditorView.inputHandler を使わない', async () => {
		const { container } = await mountText(TS_URI, TS_CONTENT);
		const view = viewOf(container);
		type(view, '(', TS_CONTENT.length);
		expect(text()).toBe(TS_CONTENT + '(');
		expect(view.state.facet(EditorView.inputHandler), 'inputHandler(closeBrackets などの入口)が無い').toHaveLength(0);
		expect(q(container, '.cm-foldGutter'), '折り畳みなし').toBeNull();
		expect(q(container, '.cm-tooltip-autocomplete'), '補完の候補なし').toBeNull();
	});

	it('括弧の対応の強調がある(カーソルを括弧の隣に置くと .cm-matchingBracket)', async () => {
		const { container } = await mountText(TXT_URI, 'call(arg)\n');
		const view = viewOf(container);
		cursor(view, 4); // `(` の直前
		await settleLong();
		expect(container.querySelectorAll('.cm-matchingBracket').length).toBeGreaterThanOrEqual(1);
	});

	it('ダブルクリックで今の編集に入らない(撤去の後は store に beginEdit も editMode も無い)', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		await fireEvent.dblClick(q(container, '.markdown-body')!);
		await settle();
		expect(q(container, 'pre[contenteditable]')).toBeNull();
		expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(1);
		expect('beginEdit' in windowState, 'beginEdit は撤去').toBe(false);
		expect('editMode' in windowState, 'editMode は撤去').toBe(false);
		expect(windowState.dirty).toBe(false);
	});

	// 要件74 第2段 2-5(2026-11-17 仮・契約21・AC-74-24 → AC-74-46): フラグ `editor_file` と Viewer の prop `fileEditor` は撤去。
	// 「偽なら今のまま」の 2 件は「prop を渡さなくても(渡しても)常に新しい面」に書き直した(書き直しは test-writer 自身の第1段のテスト)。
	it('prop を渡さなくても CodeMirror の面(今の表示の pre.vellis-plaintext は無い)', async () => {
		const d = doc(TXT_URI, TXT_CONTENT);
		windowState.setDocument(d);
		const { container } = render(Viewer, { props: baseProps(d, plainTextHtml(TXT_CONTENT), null, {}) });
		await settleLong();
		expect(q(container, 'pre.vellis-plaintext')).toBeNull();
		expect(q(container, '.cm-editor')).not.toBeNull();
		expect(windowState.fileEditor).not.toBeNull();
	});

	it('fileEditor: false を渡しても(未知の prop)面は出る=フラグの出し分けは無い', async () => {
		const d = doc(TXT_URI, TXT_CONTENT);
		windowState.setDocument(d);
		const { container } = render(Viewer, { props: baseProps(d, plainTextHtml(TXT_CONTENT), null, { fileEditor: false }) });
		await settleLong();
		expect(q(container, '.cm-editor')).not.toBeNull();
		expect(q(container, 'pre.vellis-plaintext')).toBeNull();
	});

	// 第1段では「Markdown は fileEditor が真でも今のまま」だったが、第2段 2-2(仮・2026-11-17)で Markdown も新しい面
	// (ProseMirror=MarkdownEditor.wiring.test.ts)になる。ここは「CodeMirror の面は出ない」だけを見る。
	it('Markdown は fileEditor が真でも CodeMirror の面を出さない(Markdown の面は ProseMirror=第2段)', async () => {
		const d = doc(MD_URI, MD);
		windowState.setDocument(d);
		const { container } = render(Viewer, { props: baseProps(d, renderedMd.html, renderedMd.index, { fileEditor: true }) });
		await settle();
		expect(q(container, '.cm-editor')).toBeNull();
		expect(q(container, '[data-testid="code-editor"]')).toBeNull();
		expect(q(container, '.markdown-body h1')?.textContent).toContain('Plan');
	});
});

// ---------------------------------------------------------------------------
// AC-74-39 — Shiki の残り場所・AC-74-31 印刷(契約17)
// ---------------------------------------------------------------------------

describe('AC-74-39 / AC-74-31: 表示に Shiki を使わず、印刷の直前だけ今の描画を作る', () => {
	it('面の中に Shiki の出力(pre[data-vellis-lang] / span.line)が無い', async () => {
		const { container } = await mountText(TS_URI, TS_CONTENT);
		expect(q(container, 'pre.vellis-plaintext')).toBeNull();
		expect(q(container, 'pre[data-vellis-lang]')).toBeNull();
		expect(q(container, '[data-testid="code-editor-print"]'), '印刷の描画は刷る直前まで作らない').toBeNull();
	});

	it('beforeprint で今の文字列(未保存の編集を含む)を今の描画にした pre.vellis-plaintext が出て、afterprint で消える', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'EDIT ', 0);
		const edited = text();
		expect(edited).toBe('EDIT ' + TXT_CONTENT);
		window.dispatchEvent(new Event('beforeprint'));
		await settleLong();
		const printRoot = q(container, '[data-testid="code-editor-print"]');
		expect(printRoot, '刷る直前の描画の置き場').not.toBeNull();
		const pre = printRoot!.querySelector('pre.vellis-plaintext');
		expect(pre, '今の描画(pre.vellis-plaintext)').not.toBeNull();
		expect(pre!.textContent).toBe(edited);
		window.dispatchEvent(new Event('afterprint'));
		await settleLong();
		expect(q(container, '[data-testid="code-editor-print"]')).toBeNull();
		expect(text(), '面の文書は印刷で変わらない').toBe(edited);
	});

	it('src/styles/print.css は無改変(SHA-256・AC-56-16 と同じ値)', () => {
		const css = readFileSync(resolve(REPO_ROOT, 'src/styles/print.css'), 'utf8');
		expect(createHash('sha256').update(css).digest('hex')).toBe(
			'c966daeb86dd45fc5f090de6b1201cc8108b07200ec5842d5752f994abe72088',
		);
	});
});

// ---------------------------------------------------------------------------
// AC-74-31 — 検索・ズーム(契約17)
// ---------------------------------------------------------------------------

describe('AC-74-31: FindBar の件数は findMatches(documentText, 語) と一致し、Prev / Next で選択が一致へ移る', () => {
	const LINES = 3000;
	const big = Array.from({ length: LINES }, (_, i) =>
		i === 0 || i === 1500 || i === LINES - 1 ? `line ${i} has a Needle here` : `line ${i} plain`,
	).join('\n');

	it('件数(見えている範囲の外を含む)', async () => {
		const { container } = await mountText('file:///Users/a/big.log', big + '\n');
		await emitMenuFind();
		await typeQuery(container, 'needle');
		const matches = findMatches(big + '\n', 'needle');
		expect(matches).toHaveLength(3);
		expect(countText(container)).toBe(formatCount(0, matches.length, 'needle'));
	});

	it('Next で選択が次の一致へ移り、Prev で戻る(両端で循環)', async () => {
		const { container } = await mountText('file:///Users/a/big.log', big + '\n');
		const view = viewOf(container);
		await emitMenuFind();
		await typeQuery(container, 'needle');
		const matches = findMatches(big + '\n', 'needle');
		expect(view.state.selection.main.from).toBe(matches[0]!.start);
		expect(view.state.selection.main.to).toBe(matches[0]!.end);
		const input = q(container, '[data-testid="find-input"]')!;
		await fireEvent.keyDown(input, { key: 'Enter' });
		await settleLong();
		expect(countText(container)).toBe(formatCount(1, 3, 'needle'));
		expect(view.state.selection.main.from).toBe(matches[1]!.start);
		await fireEvent.keyDown(input, { key: 'Enter' });
		await settleLong();
		expect(view.state.selection.main.from).toBe(matches[2]!.start);
		await fireEvent.keyDown(input, { key: 'Enter' });
		await settleLong();
		expect(view.state.selection.main.from, '最後の次は先頭').toBe(matches[0]!.start);
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
		await settleLong();
		expect(view.state.selection.main.from, 'Prev で最後へ').toBe(matches[2]!.start);
	});

	it('大文字小文字を区別しない(要件54 の規則)', async () => {
		const { container } = await mountText(TXT_URI, 'Alpha alpha ALPHA\n');
		await emitMenuFind();
		await typeQuery(container, 'alpha');
		expect(countText(container)).toBe('1 of 3');
	});

	it('検索バーを開いても dirty にならない・文書が変わらない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		await emitMenuFind();
		await typeQuery(container, 'line');
		expect(text()).toBe(TXT_CONTENT);
		expect(handle().dirty).toBe(false);
		expect(windowState.dirty).toBe(false);
	});
});

describe('AC-74-31: ズームは面の文字の大きさに掛け、面とその祖先に CSS の zoom / transform を付けない', () => {
	it('zoom=150 のとき', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT, { zoom: 150 });
		const root = faceRoot(container);
		expect(root.style.fontSize, '面の根の font-size に倍率').toMatch(/1\.5|150%/);
		for (let el: HTMLElement | null = root; el; el = el.parentElement) {
			const style = (el as HTMLElement).style;
			expect(style.zoom ?? '', `${el.className} に zoom が無い`).toBe('');
			expect(style.transform ?? '', `${el.className} に transform が無い`).toBe('');
		}
	});

	it('zoom=100(既定)のとき面の根に倍率の font-size は不要で、どこにも zoom が無い', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		for (let el: HTMLElement | null = faceRoot(container); el; el = el.parentElement) {
			expect((el as HTMLElement).style.zoom ?? '').toBe('');
		}
	});
});

// ---------------------------------------------------------------------------
// AC-74-42 — 幅と書体(CSS のソース走査)
// ---------------------------------------------------------------------------

describe('AC-74-42: CodeEditor.svelte の CSS(契約4)', () => {
	const css = () => readFileSync(resolve(REPO_ROOT, 'src/components/CodeEditor.svelte'), 'utf8');

	it('plain text の面は max-width: var(--doc-measure) で、:root[data-doc-measure="full"] で none', () => {
		const src = css();
		expect(src).toMatch(/:not\(\[data-vellis-lang\]\)[^{]*\{[^}]*max-width:\s*var\(--doc-measure\)/s);
		expect(src).toMatch(/:root\[data-doc-measure="full"\][^{]*:not\(\[data-vellis-lang\]\)[^{]*\{[^}]*max-width:\s*none/s);
	});

	it('書体は var(--font-mono)', () => {
		expect(css()).toMatch(/font-family:\s*var\(--font-mono\)/);
	});

	it('コードの面(data-vellis-lang あり)に max-width の上限を書かない', () => {
		const src = css();
		expect(src).not.toMatch(/\[data-vellis-lang\](?!\))[^{]*\{[^}]*max-width:\s*var\(--doc-measure\)/s);
	});
});

// ---------------------------------------------------------------------------
// AC-74-32 / AC-74-20 — 改行コード・コピーと貼り付け(契約15・17)
// ---------------------------------------------------------------------------

describe('AC-74-32: 面で打っても触っていない改行コードが残り、新しい改行は dominant', () => {
	it('CRLF の文書で 1 文字打つと、打った箇所以外の \\r\\n が残る', async () => {
		const crlf = fixture('crlf.txt');
		const { container } = await mountText('file:///Users/a/crlf.txt', crlf);
		const view = viewOf(container);
		type(view, 'Z', view.state.doc.line(2).from + 2);
		const out = text();
		expect(out.match(/\r\n/g)!.length).toBe(crlf.match(/\r\n/g)!.length);
		expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
		expect(out).toBe(crlf.replace('beta', 'beZta'));
	});

	it('CRLF の文書で Enter を押すと \\r\\n が入る', async () => {
		const crlf = fixture('crlf.txt');
		const { container } = await mountText('file:///Users/a/crlf.txt', crlf);
		const view = viewOf(container);
		cursor(view, view.state.doc.line(1).to);
		key(view, 'Enter');
		await settle();
		expect(text()).toBe('alpha\r\n\r\n' + crlf.slice('alpha\r\n'.length));
		expect(text().replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
	});

	it('LF の文書で Enter を押すと \\n、CR だけの文書で \\r', async () => {
		const lf = await mountText(TXT_URI, TXT_CONTENT);
		let view = viewOf(lf.container);
		cursor(view, view.state.doc.line(1).to);
		key(view, 'Enter');
		await settle();
		expect(text()).toBe('first line\n\nsecond line\nthird line\n');
		cleanup();
		windowState.clearDocument();
		const cr = fixture('cr.txt');
		const crMount = await mountText('file:///Users/a/cr.txt', cr);
		view = viewOf(crMount.container);
		cursor(view, view.state.doc.line(1).to);
		key(view, 'Enter');
		await settle();
		expect(text()).toBe('alpha\r' + cr.slice('alpha'.length));
		expect(text()).not.toContain('\n');
	});

	it('混在の文書で触っていない行の改行コードが保たれ、Enter は dominant(CRLF)', async () => {
		const mixed = fixture('mixed.txt'); // CRLF 4・LF 1・CR 1
		const { container } = await mountText('file:///Users/a/mixed.txt', mixed);
		const view = viewOf(container);
		cursor(view, view.state.doc.line(2).to); // `two` の行末(この行は LF)
		key(view, 'Enter');
		await settle();
		expect(text()).toBe('one\r\ntwo\r\n\nthree\r\nfour\r\nfive\rsix\r\n');
	});

	it('BOM 付きの文書で BOM が保たれる', async () => {
		const bom = fixture('bom-crlf.txt');
		const { container } = await mountText('file:///Users/a/bom.txt', bom);
		const view = viewOf(container);
		type(view, 'X', view.state.doc.line(2).from);
		expect(text().startsWith('﻿')).toBe(true);
		expect(text()).toBe('﻿title\r\nXbody line\r\n');
	});
});

describe('AC-74-20: コピーは選んだ文字列そのもの、貼り付けは文字列のまま(改行は文書の改行コード)', () => {
	function clipboard(initial: Record<string, string> = {}) {
		const data = new Map(Object.entries(initial));
		return {
			data,
			api: {
				setData: (type: string, value: string) => void data.set(type, value),
				getData: (type: string) => data.get(type) ?? '',
				clearData: () => data.clear(),
				types: [...data.keys()],
			},
		};
	}

	it('CRLF の文書で 2 行をまたいで選んでコピーすると text/plain に \\r\\n が入る', async () => {
		const crlf = fixture('crlf.txt');
		const { container } = await mountText('file:///Users/a/crlf.txt', crlf);
		const view = viewOf(container);
		view.dispatch({ selection: { anchor: view.state.doc.line(1).from, head: view.state.doc.line(2).to } });
		const clip = clipboard();
		await fireEvent.copy(view.contentDOM, { clipboardData: clip.api });
		await settle();
		expect(clip.data.get('text/plain')).toBe('alpha\r\nbeta gamma');
		expect(text(), 'コピーで文書は変わらない').toBe(crlf);
	});

	it('LF の文書で選んでコピーすると見えている文字列そのもの', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		view.dispatch({ selection: { anchor: 6, head: 17 } }); // `line\nsecond`
		const clip = clipboard();
		await fireEvent.copy(view.contentDOM, { clipboardData: clip.api });
		await settle();
		expect(clip.data.get('text/plain')).toBe('line\nsecond');
	});

	it('CRLF の文書に LF の 3 行を貼ると \\r\\n で入る', async () => {
		const crlf = fixture('crlf.txt');
		const { container } = await mountText('file:///Users/a/crlf.txt', crlf);
		const view = viewOf(container);
		cursor(view, view.state.doc.line(1).to);
		const clip = clipboard({ 'text/plain': 'p1\np2\np3' });
		await fireEvent.paste(view.contentDOM, { clipboardData: clip.api });
		await settleLong();
		const out = text();
		expect(out.startsWith('alphap1\r\np2\r\np3\r\nbeta')).toBe(true);
		expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
		expect(out.endsWith(crlf.slice('alpha'.length))).toBe(true);
	});

	it('LF の文書に貼ると \\n のまま・記号も文字のまま入る', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		cursor(view, 0);
		const clip = clipboard({ 'text/plain': '**x**\n<b>y</b>\n' });
		await fireEvent.paste(view.contentDOM, { clipboardData: clip.api });
		await settleLong();
		expect(text()).toBe('**x**\n<b>y</b>\n' + TXT_CONTENT);
	});
});

// ---------------------------------------------------------------------------
// AC-74-1 / 契約3 — dirty・未保存の印・編集せずに Command + S
// ---------------------------------------------------------------------------

describe('AC-74-1 / 契約3: dirty は文字列の比較・未保存の印((aj))・編集せずに保存しても save_document は呼ばれない', () => {
	it('開いた直後は dirty でなく、Unsaved の札が無く、saveFileEditor は invoke しない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		expect(windowState.dirty).toBe(false);
		expect(q(container, '[data-testid="unsaved-badge"]')).toBeNull();
		await saveFileEditor(handle());
		expect(invokeMock).not.toHaveBeenCalled();
	});

	it('打つと dirty になり Unsaved の札が出る。打ったものを消すと dirty でなくなり札が消える', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		await settle();
		expect(handle().dirty).toBe(true);
		expect(windowState.dirty, 'windowState.dirty が新しい面の dirty を返す').toBe(true);
		const badge = q(container, '[data-testid="unsaved-badge"]');
		expect(badge).not.toBeNull();
		expect(badge!.textContent?.trim()).toBe('Unsaved');
		view.dispatch({ changes: { from: 0, to: 1 }, userEvent: 'delete.backward' });
		await settle();
		expect(handle().dirty).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(q(container, '[data-testid="unsaved-badge"]')).toBeNull();
	});

	it('スクロール・選択・クリックでは dirty にならない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		view.dispatch({ selection: { anchor: 3, head: 10 } });
		await fireEvent.click(view.contentDOM);
		view.scrollDOM.dispatchEvent(new Event('scroll'));
		await settle();
		expect(handle().dirty).toBe(false);
		expect(text()).toBe(TXT_CONTENT);
	});

	it('削除の印が立っているとき(dirty でなくても)保存へ渡る文字列は原文と一致し、expectedHash は渡さない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		await settle();
		expect(windowState.applyFileRemoved(TXT_URI)).toBe('keep');
		view.dispatch({ changes: { from: 0, to: 1 } }); // 原文に戻す(dirty でない・印は残る)
		await settle();
		expect(handle().dirty).toBe(false);
		expect(windowState.externalRemoved).toBe(true);
		await saveFileEditor(handle());
		expect(invokeMock.mock.calls).toEqual([['save_document', { uri: TXT_URI, content: TXT_CONTENT }]]);
	});
});

// ---------------------------------------------------------------------------
// AC-74-11 — undo / redo(契約11)
// ---------------------------------------------------------------------------

describe('AC-74-11: undo / redo', () => {
	it('打鍵して undo を繰り返すと documentText が原文に戻る(Ctrl+Z=JSDOM の Mod)', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'a', 0);
		await new Promise((r) => setTimeout(r, 600)); // 履歴の区切り(newGroupDelay)を越える
		type(view, 'b', 1);
		expect(text()).toBe('ab' + TXT_CONTENT);
		expect(undoDepth(view.state)).toBeGreaterThanOrEqual(1);
		for (let i = 0; i < 5 && undoDepth(view.state) > 0; i++) {
			key(view, 'z', { ctrlKey: true });
			await settle();
		}
		expect(text()).toBe(TXT_CONTENT);
		expect(handle().dirty).toBe(false);
	});

	it('beforeinput の historyUndo / historyRedo で undo / redo が走る(Edit ▸ Undo / Redo の経路)', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'q', 0);
		expect(text()).toBe('q' + TXT_CONTENT);
		beforeInput(view, 'historyUndo');
		await settle();
		expect(text()).toBe(TXT_CONTENT);
		beforeInput(view, 'historyRedo');
		await settle();
		expect(text()).toBe('q' + TXT_CONTENT);
	});

	it('Ctrl+Shift+Z で redo', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'q', 0);
		key(view, 'z', { ctrlKey: true });
		await settle();
		expect(text()).toBe(TXT_CONTENT);
		key(view, 'z', { ctrlKey: true, shiftKey: true });
		await settle();
		expect(text()).toBe('q' + TXT_CONTENT);
	});

	it('外部変更の取り込み(未編集)は履歴に積まず、undo の段数が変わらない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		const before = undoDepth(view.state);
		const incoming = TXT_CONTENT + 'from disk\n';
		expect(handle().applyFileChanged(doc(TXT_URI, incoming))).toBe('apply');
		await settle();
		expect(text()).toBe(incoming);
		expect(undoDepth(view.state)).toBe(before);
		key(view, 'z', { ctrlKey: true });
		await settle();
		expect(text(), '届いた内容は undo で戻らない').toBe(incoming);
	});

	it('編集中の重ならない外部変更(マージ)の後に undo しても、届いた内容の部分は残る', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'MINE ', 0); // 1 行目を触る
		const depth = undoDepth(view.state);
		const incoming = TXT_CONTENT.replace('third line', 'THIRD LINE'); // 3 行目を外で変える
		expect(handle().applyFileChanged(doc(TXT_URI, incoming))).toBe('apply');
		await settle();
		expect(text()).toBe('MINE first line\nsecond line\nTHIRD LINE\n');
		expect(undoDepth(view.state), '取り込みは履歴に積まない').toBe(depth);
		key(view, 'z', { ctrlKey: true });
		await settle();
		expect(text()).toBe('first line\nsecond line\nTHIRD LINE\n');
	});
});

// ---------------------------------------------------------------------------
// AC-74-13 — 外部変更=未編集(契約12)
// ---------------------------------------------------------------------------

describe('AC-74-13: dirty でない面に file_changed が届く', () => {
	it('windowState.applyFileChanged が面に届き、documentText が届いた内容になり、dirty でなく、帯も知らせも出ない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const incoming = 'zero line\n' + TXT_CONTENT;
		expect(windowState.applyFileChanged(doc(TXT_URI, incoming))).toBe('apply');
		await settle();
		expect(text()).toBe(incoming);
		expect(handle().dirty).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(handle().expectedHash(), '基準の版が届いた内容へ進む').toBe(contentHash(incoming));
		expect(q(container, '[data-testid="external-change-banner"]')).toBeNull();
		expect(q(container, '[data-testid="external-conflict-banner"]')).toBeNull();
		expect(q(container, '[data-testid="external-merged-notice"]')).toBeNull();
	});

	it('届いた変更より後ろにあったカーソルは差分の長さだけずれ、前にあったカーソルは同じ位置', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		const line3 = view.state.doc.line(3).from;
		cursor(view, line3);
		handle().applyFileChanged(doc(TXT_URI, 'zero line\n' + TXT_CONTENT));
		await settle();
		expect(view.state.selection.main.head).toBe(line3 + 'zero line\n'.length);
		cursor(view, 2);
		handle().applyFileChanged(doc(TXT_URI, 'zero line\n' + TXT_CONTENT.replace('third line', 'third line and more')));
		await settle();
		expect(view.state.selection.main.head).toBe(2);
	});

	it('自分の保存のエコー(自己書き込みのハッシュと同じ内容)では何も起きない(取引が 1 つも走らない)', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		const saved = text();
		await saveFileEditor(handle());
		expect(invokeMock).toHaveBeenCalledWith('save_document', {
			uri: TXT_URI,
			content: saved,
			expectedHash: contentHash(TXT_CONTENT),
		});
		expect(handle().dirty).toBe(false);
		const stateBefore = view.state;
		let transactions = 0;
		const stop = () => transactions++;
		const original = view.dispatch.bind(view);
		(view as unknown as { dispatch: typeof view.dispatch }).dispatch = ((...args: unknown[]) => {
			stop();
			return (original as (...a: unknown[]) => void)(...args);
		}) as typeof view.dispatch;
		expect(windowState.applyFileChanged(doc(TXT_URI, saved))).toBe('ignore-echo');
		await settle();
		expect(transactions).toBe(0);
		expect(view.state).toBe(stateBefore);
		expect(text()).toBe(saved);
	});
});

// ---------------------------------------------------------------------------
// AC-74-14 (2) — 3方向マージの配線(契約13)
// ---------------------------------------------------------------------------

describe('AC-74-14 (2): dirty の面に外部変更が届く', () => {
	it('重ならなければマージ結果になり、dirty のまま、external-merged-notice が出て、undo の段数が変わらない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'MINE ', 0);
		const depth = undoDepth(view.state);
		const incoming = TXT_CONTENT.replace('third line', 'THEIRS');
		expect(windowState.applyFileChanged(doc(TXT_URI, incoming))).toBe('apply');
		await settle();
		expect(text()).toBe('MINE first line\nsecond line\nTHEIRS\n');
		expect(handle().dirty).toBe(true);
		expect(windowState.dirty).toBe(true);
		expect(undoDepth(view.state)).toBe(depth);
		const notice = q(container, '[data-testid="external-merged-notice"]');
		expect(notice).not.toBeNull();
		expect(notice!.textContent?.trim()).toBe(MERGED_NOTICE);
		expect(notice!.getAttribute('role')).toBe('status');
		expect(q(container, '[data-testid="external-conflict-banner"]')).toBeNull();
		expect(handle().expectedHash(), '基準の版は届いた内容へ').toBe(contentHash(incoming));
	});

	it('重なると帯が出て、選ぶまで documentText は変わらない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'MINE ', 0);
		const mine = text();
		const incoming = TXT_CONTENT.replace('first line', 'THEIRS first line');
		expect(windowState.applyFileChanged(doc(TXT_URI, incoming))).toBe('external-conflict');
		await settle();
		expect(text()).toBe(mine);
		expect(handle().conflict).toBe(true);
		const banner = q(container, '[data-testid="external-conflict-banner"]');
		expect(banner).not.toBeNull();
		expect(banner!.classList.contains('external-change'), '今の帯と同じ class').toBe(true);
		expect(banner!.getAttribute('role')).toBe('alert');
		expect(banner!.textContent).toContain(CONFLICT_MESSAGE);
		const keep = q(container, '[data-testid="external-conflict-keep"]');
		const disk = q(container, '[data-testid="external-conflict-disk"]');
		expect(keep?.textContent?.trim()).toBe('Keep My Edits');
		expect(disk?.textContent?.trim()).toBe('Use the File on Disk');
		expect(q(container, '[data-testid="external-change-banner"]'), '今の帯(Overwrite / Reload)は出さない').toBeNull();
	});

	it('Keep My Edits: 文書が残り、基準の版が届いた内容になる(次の保存の expectedHash が届いた内容のハッシュ)', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'MINE ', 0);
		const mine = text();
		const incoming = TXT_CONTENT.replace('first line', 'THEIRS first line');
		windowState.applyFileChanged(doc(TXT_URI, incoming));
		await settle();
		await fireEvent.click(q(container, '[data-testid="external-conflict-keep"]')!);
		await settle();
		expect(text()).toBe(mine);
		expect(handle().dirty).toBe(true);
		expect(handle().conflict).toBe(false);
		expect(q(container, '[data-testid="external-conflict-banner"]')).toBeNull();
		expect(handle().expectedHash()).toBe(contentHash(incoming));
		await saveFileEditor(handle());
		expect(invokeMock).toHaveBeenCalledWith('save_document', {
			uri: TXT_URI,
			content: mine,
			expectedHash: contentHash(incoming),
		});
	});

	it('Use the File on Disk: documentText が届いた内容になり dirty でない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'MINE ', 0);
		const incoming = TXT_CONTENT.replace('first line', 'THEIRS first line');
		windowState.applyFileChanged(doc(TXT_URI, incoming));
		await settle();
		await fireEvent.click(q(container, '[data-testid="external-conflict-disk"]')!);
		await settle();
		expect(text()).toBe(incoming);
		expect(handle().dirty).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(handle().conflict).toBe(false);
		expect(q(container, '[data-testid="external-conflict-banner"]')).toBeNull();
		expect(handle().expectedHash()).toBe(contentHash(incoming));
	});

	it('別の uri の file_changed は面に届かない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		windowState.applyFileChanged(doc('file:///Users/a/notes/other.txt', 'other\n'));
		await settle();
		expect(text()).toBe('x' + TXT_CONTENT);
		expect(q(container, '[data-testid="external-conflict-banner"]')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-74-12 — IME(契約10)
// ---------------------------------------------------------------------------

describe('AC-74-12: 変換中に届いた file_changed と FindBar の語の変更は compositionend の後に 1 回だけ当たる', () => {
	it('file_changed', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		composition(view, 'compositionstart');
		await settle();
		const incoming = TXT_CONTENT + 'from disk\n';
		windowState.applyFileChanged(doc(TXT_URI, incoming));
		await settle();
		expect(text(), '変換中は当たらない').toBe(TXT_CONTENT);
		const depth = undoDepth(view.state);
		composition(view, 'compositionend');
		await settleLong();
		expect(text(), '確定後に当たる').toBe(incoming);
		expect(undoDepth(view.state), '取り込みは履歴に積まない').toBe(depth);
		expect(handle().dirty).toBe(false);
	});

	it('FindBar の語の変更', async () => {
		const { container } = await mountText(TXT_URI, 'alpha beta alpha\n');
		const view = viewOf(container);
		await emitMenuFind();
		composition(view, 'compositionstart');
		await settle();
		await typeQuery(container, 'alpha');
		expect(countText(container), '変換中は件数(色)を張り替えない').toBe('');
		composition(view, 'compositionend');
		await settleLong();
		expect(countText(container)).toBe('1 of 2');
	});
});

// ---------------------------------------------------------------------------
// AC-74-15 — 外部での削除(契約13・要件48 追補g・h)
// ---------------------------------------------------------------------------

describe('AC-74-15: dirty の面に file_removed が届く', () => {
	const REMOVED_MESSAGE = 'This file was deleted outside the app. Your edits have not been saved.';

	it('文書が残り、external-removed-banner が追補g の文言で出る。Save で同じ URI に今の文字列(expectedHash なし)', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		const mine = text();
		expect(windowState.applyFileRemoved(TXT_URI)).toBe('keep');
		await settle();
		expect(text()).toBe(mine);
		expect(q(container, '.cm-editor')).not.toBeNull();
		const banner = q(container, '[data-testid="external-removed-banner"]');
		expect(banner).not.toBeNull();
		expect(banner!.textContent).toContain(REMOVED_MESSAGE);
		await fireEvent.click(q(container, '[data-testid="external-removed-save"]')!);
		await settleLong();
		expect(invokeMock.mock.calls).toEqual([['save_document', { uri: TXT_URI, content: mine }]]);
		expect(handle().dirty).toBe(false);
		expect(windowState.externalRemoved).toBe(false);
		expect(q(container, '[data-testid="external-removed-banner"]')).toBeNull();
	});

	it('Close で文書が閉じ、save_document は呼ばれない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		windowState.applyFileRemoved(TXT_URI);
		await settle();
		await fireEvent.click(q(container, '[data-testid="external-removed-close"]')!);
		await settle();
		expect(windowState.currentDocument).toBeNull();
		expect(windowState.fileEditor).toBeNull();
		expect(invokeMock).not.toHaveBeenCalled();
	});

	it('dirty でなければ従来どおり閉じる(追補h の印は今のまま)', async () => {
		await mountText(TXT_URI, TXT_CONTENT);
		expect(windowState.applyFileRemoved(TXT_URI)).toBe('close');
		await settle();
		expect(windowState.currentDocument).toBeNull();
		expect(windowState.fileEditor).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-74-16(面の分)— 保存の照合(契約14)
// ---------------------------------------------------------------------------

describe('AC-74-16(面の分): saveFileEditor', () => {
	it('expectedHash=contentHash(基準の版) を渡し、成功したら dirty でなく、続けて保存しても呼ばれない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		const mine = text();
		await saveFileEditor(handle());
		expect(invokeMock.mock.calls).toEqual([
			['save_document', { uri: TXT_URI, content: mine, expectedHash: contentHash(TXT_CONTENT) }],
		]);
		expect(handle().dirty).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(handle().expectedHash(), '基準の版が保存した内容へ進む').toBe(contentHash(mine));
		expect(windowState.lastSavedHash, '自己書き込みのハッシュ(エコー抑止)').toBe(contentHash(mine));
		invokeMock.mockClear();
		await saveFileEditor(handle());
		expect(invokeMock).not.toHaveBeenCalled();
	});

	it('衝突のエラー(接頭辞 SAVE_CONFLICT_PREFIX)なら書かずに重なりの帯を出し、dirty のまま・例外を外へ出さない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		const mine = text();
		invokeMock.mockRejectedValueOnce(`${SAVE_CONFLICT_PREFIX}: expected 3-7aigaz-3772q3`);
		await expect(saveFileEditor(handle())).resolves.toBeUndefined();
		await settle();
		expect(handle().dirty).toBe(true);
		expect(text()).toBe(mine);
		expect(handle().conflict).toBe(true);
		expect(q(container, '[data-testid="external-conflict-banner"]')).not.toBeNull();
		expect(handle().expectedHash(), '失敗では基準の版を進めない').toBe(contentHash(TXT_CONTENT));
	});

	it('その他の失敗は alert で知らせ、dirty のまま', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		invokeMock.mockRejectedValueOnce('disk full');
		await saveFileEditor(handle());
		await settle();
		expect(handle().dirty).toBe(true);
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(String(alertMock.mock.calls[0]![0])).toContain('disk full');
		expect(q(container, '[data-testid="external-conflict-banner"]')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-74-17 / AC-74-41 — 未保存の確認・Esc・Reload File(契約16・要件80)
// ---------------------------------------------------------------------------

describe('AC-74-17: 未保存の確認は新しい面の dirty を見る', () => {
	it('dirty の面で confirmDiscardEdits を通すと Save / Don\'t Save / Cancel の 1 枚が出る。Cancel なら何も変わらない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		messageMock.mockResolvedValueOnce('Cancel');
		expect(await confirmDiscardEdits()).toBe(false);
		expect(messageMock).toHaveBeenCalledTimes(1);
		expect(text()).toBe('x' + TXT_CONTENT);
		expect(handle().dirty).toBe(true);
		expect(invokeMock).not.toHaveBeenCalled();
	});

	it('Save を選ぶと saveFileEditor の経路で保存(expectedHash つき)してから進む', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		const mine = text();
		messageMock.mockResolvedValueOnce('Save');
		expect(await confirmDiscardEdits()).toBe(true);
		expect(invokeMock.mock.calls).toEqual([
			['save_document', { uri: TXT_URI, content: mine, expectedHash: contentHash(TXT_CONTENT) }],
		]);
		expect(handle().dirty).toBe(false);
	});

	it('打って戻した(documentText が base と同じ)ときは dirty でなく確認も出ない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		view.dispatch({ changes: { from: 0, to: 1 } });
		await settle();
		expect(windowState.dirty).toBe(false);
		expect(await confirmDiscardEdits()).toBe(true);
		expect(messageMock).not.toHaveBeenCalled();
	});

	it('Esc では確認が出ず、面から出ない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		key(view, 'Escape');
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await settle();
		expect(messageMock).not.toHaveBeenCalled();
		expect(q(container, '.cm-editor')).not.toBeNull();
		expect(text()).toBe('x' + TXT_CONTENT);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
	});
});

describe('AC-74-41: Reload File(要件80 の実行列が新しい面の dirty と文書モデルを扱う)', () => {
	function reloader(disk: () => string, open = vi.fn(async (uri: string) => doc(uri, disk()))) {
		const reload = createFileReloader<DocumentPayload>({
			current: () => windowState.currentDocument?.uri ?? null,
			confirm: confirmDiscardEdits,
			open,
			// +page.svelte の applyText と同じ経路: store に当て(dirty でなければ store が作り直す)、確認(Don't Save)の後に残っている
			// dirty の面はここで読み直した中身で作り直す(要件74 (ak)・AC-80-19 (3)=store は dirty の面を畳まない)。
			applyText: (d) => {
				windowState.applyReloadedText(d);
				const face = windowState.fileEditor;
				if (face && face.uri === d.uri && face.dirty) face.reset(d.content);
			},
			bumpBinary: vi.fn(),
			notify: (m) => alertMock(m),
			changeStamp: () => 0,
			refreshTree: async () => {},
		});
		return { reload, open };
	}

	it('dirty なら確認を通り、Cancel なら open_document を呼ばない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		const { reload, open } = reloader(() => TXT_CONTENT);
		messageMock.mockResolvedValueOnce('Cancel');
		expect(await reload.reload()).toBe('cancelled');
		expect(open).not.toHaveBeenCalled();
		expect(text()).toBe('x' + TXT_CONTENT);
	});

	it("Don't Save なら読み直し、documentText がディスクの内容・dirty でない・undo の段数 0。倍率は変わらない", async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT, { zoom: 150 });
		let view = viewOf(container);
		type(view, 'x', 0);
		const disk = TXT_CONTENT + 'reloaded\n';
		const { reload, open } = reloader(() => disk);
		messageMock.mockResolvedValueOnce("Don't Save");
		expect(await reload.reload()).toBe('reloaded');
		expect(open).toHaveBeenCalledWith(TXT_URI);
		await settleLong();
		view = viewOf(container);
		expect(text()).toBe(disk);
		expect(handle().dirty).toBe(false);
		expect(windowState.dirty).toBe(false);
		expect(undoDepth(view.state), '(ak) 推奨=履歴を残さない').toBe(0);
		expect(faceRoot(container).style.fontSize).toMatch(/1\.5|150%/);
		expect(windowState.fileEditor?.uri).toBe(TXT_URI);
	});

	it('dirty でなければ確認なしで読み直す', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const disk = 'new content\n';
		const { reload } = reloader(() => disk);
		expect(await reload.reload()).toBe('reloaded');
		await settleLong();
		expect(messageMock).not.toHaveBeenCalled();
		expect(text()).toBe(disk);
		expect(viewOf(container).state.doc.toString()).toBe(disk);
	});
});

// ---------------------------------------------------------------------------
// AC-74-38(第1段の分)— 読み取り専用(契約3・4)
// ---------------------------------------------------------------------------

describe('AC-74-38: SSH root のコードと plain text は同じ面が editable=false', () => {
	it('.cm-content が contenteditable="false" で、キー・貼り付け・保存で文書も save_document も変わらない', async () => {
		const content = fixture('sample.rs');
		const { container } = await mountText(SSH_URI, content);
		const view = viewOf(container);
		expect(handle().readOnly).toBe(true);
		expect(q(container, '.cm-content[contenteditable="false"]')).not.toBeNull();
		expect(q(container, '.cm-content[contenteditable="true"]')).toBeNull();
		expect(view.state.readOnly).toBe(true);
		cursor(view, 0);
		key(view, 'Enter');
		key(view, 'Tab');
		key(view, 'a');
		await fireEvent.paste(view.contentDOM, {
			clipboardData: { getData: () => 'pasted', setData: () => {}, clearData: () => {}, types: ['text/plain'] },
		});
		await settleLong();
		expect(text()).toBe(content);
		expect(handle().dirty).toBe(false);
		await saveFileEditor(handle());
		expect(invokeMock).not.toHaveBeenCalled();
		expect(q(container, '.cm-gutters'), 'コードのファイルなので行番号はある').not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-74-30 (3) — 配色の切り替え(契約5)
// ---------------------------------------------------------------------------

describe('AC-74-30 (3): codeTheme が変わると、同じ EditorView のまま文書・選択・undo の段数を保って配色が変わる', () => {
	it('github-light → github-dark', async () => {
		const d = doc(TS_URI, TS_CONTENT);
		windowState.setDocument(d);
		const props = baseProps(d, plainTextHtml(TS_CONTENT), null, { fileEditor: true, codeTheme: 'github-light' });
		const { container, rerender } = render(Viewer, { props });
		await settleLong();
		const view = viewOf(container);
		expect(faceRoot(container).getAttribute('data-code-theme')).toBe('github-light');
		type(view, 'x', 0);
		cursor(view, 5);
		const depth = undoDepth(view.state);
		const textBefore = text();
		await rerender({ ...props, codeTheme: 'github-dark' });
		await settleLong();
		expect(faceRoot(container).getAttribute('data-code-theme')).toBe('github-dark');
		const after = viewOf(container);
		expect(after, 'EditorView を作り直さない').toBe(view);
		expect(text()).toBe(textBefore);
		expect(after.state.selection.main.head).toBe(5);
		expect(undoDepth(after.state)).toBe(depth);
		expect(handle().dirty).toBe(true);
	});

	it('codeTheme を渡さない既定は github-light', async () => {
		const { container } = await mountText(TS_URI, TS_CONTENT);
		expect(faceRoot(container).getAttribute('data-code-theme')).toBe('github-light');
	});
});

// ---------------------------------------------------------------------------
// 契約2 — 文書を閉じる・別の文書へ移ると handle が外れる
// ---------------------------------------------------------------------------

describe('契約2: 面が消えると windowState.fileEditor が null に戻る', () => {
	it('clearDocument で null', async () => {
		await mountText(TXT_URI, TXT_CONTENT);
		expect(windowState.fileEditor).not.toBeNull();
		windowState.clearDocument();
		await settleLong();
		expect(windowState.fileEditor).toBeNull();
	});

	it('別の text 文書へ移ると新しい handle(uri が替わり dirty でない・履歴 0)', async () => {
		const d1 = doc(TXT_URI, TXT_CONTENT);
		windowState.setDocument(d1);
		const props = baseProps(d1, plainTextHtml(TXT_CONTENT), null, { fileEditor: true });
		const { container, rerender } = render(Viewer, { props });
		await settleLong();
		type(viewOf(container), 'x', 0);
		const d2 = doc(RS_URI, fixture('sample.rs'));
		windowState.setDocument(d2);
		await rerender({ ...props, document: d2, html: plainTextHtml(d2.content) });
		await settleLong();
		expect(handle().uri).toBe(RS_URI);
		expect(handle().dirty).toBe(false);
		expect(text()).toBe(d2.content);
		expect(undoDepth(viewOf(container).state)).toBe(0);
		expect(faceRoot(container).getAttribute('data-vellis-lang')).toBe('rust');
	});
});

// ---------------------------------------------------------------------------
// 変異の生き残りを締める(2026-11-16・test-runner の変異テスト M8・M10・M11・M14・M15・M28)
// ---------------------------------------------------------------------------

describe('AC-74-13 / 32(M8): 混在の文書への外部変更で、少数派の改行が主たる改行に化けない', () => {
	it('dirty でない面に、文字だけ変えた混在の内容が届く → documentText が届いた内容と byte 等価', async () => {
		const mixed = fixture('mixed.txt'); // dominant=CRLF・LF と CR が少数派
		await mountText('file:///Users/a/mixed.txt', mixed);
		const incoming = mixed.replace('two\n', 'TWO\n').replace('five\r', 'FIVE\r');
		expect(windowState.applyFileChanged(doc('file:///Users/a/mixed.txt', incoming))).toBe('apply');
		await settle();
		expect(text()).toBe(incoming);
		expect(handle().dirty).toBe(false);
	});

	it('dirty の面に重ならない混在の内容が届く(マージ)→ 少数派の改行がそのまま残る', async () => {
		const mixed = fixture('mixed.txt');
		const { container } = await mountText('file:///Users/a/mixed.txt', mixed);
		const view = viewOf(container);
		type(view, 'MINE ', 0); // 1 行目を触る
		const incoming = mixed.replace('four\r\n', 'FOUR\r\n'); // 4 行目を外で変える
		expect(windowState.applyFileChanged(doc('file:///Users/a/mixed.txt', incoming))).toBe('apply');
		await settle();
		expect(text()).toBe('MINE one\r\ntwo\nthree\r\nFOUR\r\nfive\rsix\r\n');
	});

	it('Reload File で読み直した混在の内容も byte 等価', async () => {
		const mixed = fixture('mixed.txt');
		await mountText('file:///Users/a/mixed.txt', mixed);
		const disk = mixed.replace('six\r\n', 'SIX\r\n');
		windowState.applyReloadedText(doc('file:///Users/a/mixed.txt', disk));
		await settleLong();
		expect(text()).toBe(disk);
	});
});

describe('AC-74-14 (2)(M10): 基準の版と同じ内容の file_changed が続けて届いても、マージと知らせを繰り返さない', () => {
	it('dirty の面に同じ全文が 5 回届く → 2 回目以降は ignore-echo で、取引が走らず、知らせは 1 つ', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'MINE ', 0);
		const incoming = TXT_CONTENT.replace('third line', 'THEIRS');
		expect(windowState.applyFileChanged(doc(TXT_URI, incoming))).toBe('apply');
		await settle();
		const merged = text();
		expect(merged).toBe('MINE first line\nsecond line\nTHEIRS\n');
		const stateAfterMerge = view.state;
		const depth = undoDepth(view.state);
		for (let i = 0; i < 4; i++) {
			expect(windowState.applyFileChanged(doc(TXT_URI, incoming)), `${i + 2} 回目`).toBe('ignore-echo');
			await settle();
		}
		expect(view.state, '取引が 1 つも走らない').toBe(stateAfterMerge);
		expect(text()).toBe(merged);
		expect(undoDepth(view.state)).toBe(depth);
		expect(handle().dirty).toBe(true);
		expect(container.querySelectorAll('[data-testid="external-merged-notice"]')).toHaveLength(1);
		expect(handle().expectedHash()).toBe(contentHash(incoming));
	});

	it('dirty でない面に基準の版と同じ内容が届く → ignore-echo・取引なし', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		const before = view.state;
		expect(windowState.applyFileChanged(doc(TXT_URI, TXT_CONTENT))).toBe('ignore-echo');
		await settle();
		expect(view.state).toBe(before);
		expect(text()).toBe(TXT_CONTENT);
	});

	it('削除+作成で元のまま戻った内容(基準の版と同じ)が dirty 中に届く → 編集はそのまま・帯も知らせも出ない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		expect(windowState.applyFileChanged(doc(TXT_URI, TXT_CONTENT))).toBe('ignore-echo');
		await settle();
		expect(text()).toBe('x' + TXT_CONTENT);
		expect(q(container, '[data-testid="external-merged-notice"]')).toBeNull();
		expect(q(container, '[data-testid="external-conflict-banner"]')).toBeNull();
	});
});

describe('AC-74-20(M11): 空の選択の Command + C / X は何もしない(CodeMirror 既定の行ごとのコピーを止める)', () => {
	function clipboard() {
		const data = new Map<string, string>();
		return {
			data,
			api: {
				setData: (type: string, value: string) => void data.set(type, value),
				getData: (type: string) => data.get(type) ?? '',
				clearData: () => data.clear(),
				types: [] as string[],
			},
		};
	}

	it('カーソルだけでコピー → text/plain を書かない(行がコピーされない)', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		cursor(view, 3);
		// jsdom では CodeMirror の既定の copy / cut は面に focus が無いと何もしない(=実装がどうでも通ってしまう)ので、
		// 焦点を当ててから送る(reviewer 2026-11-16 の変異 M11b の当て直し)。
		view.focus();
		const clip = clipboard();
		await fireEvent.copy(view.contentDOM, { clipboardData: clip.api });
		await settle();
		expect(clip.data.has('text/plain'), '何も書かない').toBe(false);
		expect(text()).toBe(TXT_CONTENT);
	});

	it('カーソルだけで切り取り → 文書が変わらず text/plain も書かない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		cursor(view, 3);
		view.focus(); // 上のコピーと同じ理由(focus 無しでは既定の cut も空振りする)。
		const clip = clipboard();
		await fireEvent.cut(view.contentDOM, { clipboardData: clip.api });
		await settleLong();
		expect(clip.data.has('text/plain')).toBe(false);
		expect(text(), '行が消えない').toBe(TXT_CONTENT);
		expect(handle().dirty).toBe(false);
	});

	it('選択があれば切り取りで選んだ文字列だけが消え、text/plain に入る', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		view.dispatch({ selection: { anchor: 0, head: 5 } }); // `first`
		const clip = clipboard();
		await fireEvent.cut(view.contentDOM, { clipboardData: clip.api });
		await settleLong();
		expect(clip.data.get('text/plain')).toBe('first');
		expect(text()).toBe(' line\nsecond line\nthird line\n');
	});
});

describe('AC-74-17(M14): 未保存の確認で Save を選び、保存が照合の衝突で失敗したら操作を続行しない', () => {
	it('衝突 → confirmDiscardEdits が false・dirty のまま・重なりの帯・文書は開いたまま', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		messageMock.mockResolvedValueOnce('Save');
		invokeMock.mockRejectedValueOnce(`${SAVE_CONFLICT_PREFIX}: expected 3-7aigaz-3772q3`);
		expect(await confirmDiscardEdits()).toBe(false);
		await settle();
		expect(handle().dirty).toBe(true);
		expect(text()).toBe('x' + TXT_CONTENT);
		expect(windowState.currentDocument?.uri).toBe(TXT_URI);
		expect(q(container, '[data-testid="external-conflict-banner"]')).not.toBeNull();
		expect(q(container, '.cm-editor')).not.toBeNull();
	});

	it('ほかの失敗(disk full)→ false・dirty のまま・alert で知らせる', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		messageMock.mockResolvedValueOnce('Save');
		invokeMock.mockRejectedValueOnce('disk full');
		expect(await confirmDiscardEdits()).toBe(false);
		expect(handle().dirty).toBe(true);
		expect(alertMock).toHaveBeenCalledTimes(1);
		expect(q(container, '.cm-editor')).not.toBeNull();
	});

	it('Reload File の実行列でも、Save の失敗なら open_document を呼ばない', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		type(view, 'x', 0);
		const open = vi.fn(async (uri: string) => doc(uri, TXT_CONTENT));
		const reload = createFileReloader<DocumentPayload>({
			current: () => windowState.currentDocument?.uri ?? null,
			confirm: confirmDiscardEdits,
			open,
			applyText: (d) => windowState.applyReloadedText(d),
			bumpBinary: vi.fn(),
			notify: (m) => alertMock(m),
			changeStamp: () => 0,
			refreshTree: async () => {},
		});
		messageMock.mockResolvedValueOnce('Save');
		invokeMock.mockRejectedValueOnce(`${SAVE_CONFLICT_PREFIX}: expected x`);
		expect(await reload.reload()).toBe('cancelled');
		expect(open).not.toHaveBeenCalled();
		expect(text()).toBe('x' + TXT_CONTENT);
	});
});

describe('AC-74-12(M15・M28): 変換中の検索の数え直しと、変換中の blur', () => {
	const WORDS = 'needle one\nneedle two\nneedle three\n';

	it('変換中の打鍵の後は件数(色)を張り直さず、確定後に 1 回数え直す', async () => {
		const { container } = await mountText(TXT_URI, WORDS);
		const view = viewOf(container);
		await emitMenuFind();
		await typeQuery(container, 'needle');
		expect(countText(container)).toBe('1 of 3');
		composition(view, 'compositionstart');
		await settle();
		// 変換中の打鍵(擬似)で一致が 1 つ増える。
		type(view, 'needle ', WORDS.length);
		await new Promise((r) => setTimeout(r, 300)); // 間をおいた数え直し(150ms)を越える
		await settle();
		expect(countText(container), '変換中は張り直さない').toBe('1 of 3');
		composition(view, 'compositionend');
		await new Promise((r) => setTimeout(r, 300));
		await settleLong();
		expect(countText(container), '確定後に 1 回流す(契約10)').toBe('1 of 4');
	});

	it('変換中に blur すると変換中の印が下り、待たせていた外部変更が当たる(WebKit の compositionend 抜け)', async () => {
		const { container } = await mountText(TXT_URI, TXT_CONTENT);
		const view = viewOf(container);
		composition(view, 'compositionstart');
		await settle();
		const incoming = TXT_CONTENT + 'from disk\n';
		windowState.applyFileChanged(doc(TXT_URI, incoming));
		await settle();
		expect(text(), '変換中は当たらない').toBe(TXT_CONTENT);
		view.contentDOM.dispatchEvent(new FocusEvent('blur'));
		await settleLong();
		expect(text(), 'blur で確定扱い→当たる').toBe(incoming);
		expect(handle().dirty).toBe(false);
		// その後の file_changed は変換中扱いにならずすぐ当たる。
		const again = incoming + 'more\n';
		windowState.applyFileChanged(doc(TXT_URI, again));
		await settle();
		expect(text()).toBe(again);
	});

	it('変換中に blur した後の FindBar の語の変更もすぐ当たる', async () => {
		const { container } = await mountText(TXT_URI, WORDS);
		const view = viewOf(container);
		await emitMenuFind();
		composition(view, 'compositionstart');
		await settle();
		view.contentDOM.dispatchEvent(new FocusEvent('blur'));
		await settleLong();
		await typeQuery(container, 'needle');
		expect(countText(container)).toBe('1 of 3');
	});
});

// ---------------------------------------------------------------------------
// 要件74 第3段 3-3 — 行の移動(Option + 上下)とコメント(Command + /)はコードの面・plain text の面で効く(AC-74-56 (7) の面の分・3-13)。
// 契約は src/editor/code-keymap.acceptance.test.ts の AC-74-56 の節。jsdom の Mod=Control。
// ---------------------------------------------------------------------------

describe('3-3: コードの面の Option + 上下と Command + /(AC-74-56)', () => {
	async function waitForLanguage(view: EditorView) {
		for (let i = 0; i < 100; i++) {
			if (view.state.languageDataAt<unknown>('commentTokens', 0).length > 0) return;
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error('言語(commentTokens)が読み込まれない');
	}

	it('.ts: 2 行目で Option + 上 → 1 行目と入れ替わり dirty。先頭で上は不変。Control + Z で戻る', async () => {
		const src = 'const a = 1;\nconst b = 2;\n';
		const { container } = await mountText('file:///Users/a/src/main.ts', src);
		const view = viewOf(container);
		cursor(view, view.state.doc.line(2).from + 3);
		key(view, 'ArrowUp', { altKey: true });
		await settle();
		expect(text()).toBe('const b = 2;\nconst a = 1;\n');
		expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1);
		expect(handle().dirty).toBe(true);
		key(view, 'ArrowUp', { altKey: true });
		await settle();
		expect(text(), '先頭の行で上は何もしない').toBe('const b = 2;\nconst a = 1;\n');
		key(view, 'z', { ctrlKey: true });
		await settle();
		expect(text()).toBe(src);
		expect(handle().dirty).toBe(false);
	});

	it('plain text(.txt)でも Option + 下で行が入れ替わる(CRLF は主たる改行のまま)', async () => {
		const { container } = await mountText(TXT_URI, 'alpha\r\nbeta\r\ngamma\r\n');
		const view = viewOf(container);
		cursor(view, 0);
		key(view, 'ArrowDown', { altKey: true });
		await settle();
		expect(text()).toBe('beta\r\nalpha\r\ngamma\r\n');
	});

	it('.ts: Command + / で // が付き、もう 1 回で byte 等価。plain text では何も起きない', async () => {
		const src = 'const a = 1;\nconst b = 2;\n';
		const { container } = await mountText('file:///Users/a/src/main.ts', src);
		const view = viewOf(container);
		await waitForLanguage(view);
		cursor(view, 2);
		key(view, '/', { ctrlKey: true });
		await settle();
		expect(text()).toBe('// const a = 1;\nconst b = 2;\n');
		key(view, '/', { ctrlKey: true });
		await settle();
		expect(text()).toBe(src);
		expect(handle().dirty).toBe(false);

		cleanup();
		windowState.clearDocument();
		windowState.fileEditor = null;
		const plain = await mountText(TXT_URI, 'hello\n');
		const pv = viewOf(plain.container);
		cursor(pv, 1);
		key(pv, '/', { ctrlKey: true });
		await settle();
		expect(text()).toBe('hello\n');
	});

	it('読み取り専用(SSH)の面では Option + 上下も Command + / も何も起きない', async () => {
		const { container } = await mountText(SSH_URI, 'a\nb\n');
		const view = viewOf(container);
		cursor(view, 2);
		key(view, 'ArrowUp', { altKey: true });
		key(view, '/', { ctrlKey: true });
		await settle();
		expect(view.state.doc.toString()).toBe('a\nb\n');
	});
});
