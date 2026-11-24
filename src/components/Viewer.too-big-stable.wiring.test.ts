/**
 * 要件#74 /code-review 不具合 A — 保存すると Markdown の編集面が入れ替わる(2026-11-22)。
 *
 * 今の `Viewer.svelte` は `markdownTooBig = markdownFile && canEnterEdit('markdown', uri) && markdownTooLarge(document.content)` を
 * `$derived` で持ち、面を `{#key \`${document.uri}\n${markdownTooBig}\`}` で作り直す。`document.content` は保存(`markSaved`)や
 * 外部変更の取り込み(`applyFileChanged`)で更新されるので、2 MiB(`src/editor/markdown-limits.ts`)をまたぐと判定が変わり、
 * 編集中の面が消えて「大きすぎる」読み取り専用の描画になる(逆もある)。
 *
 * ## 直し方(オーケストレーターの決定)
 * 閾値の判定は **URI ごとに 1 回**(その URI を開いたときの content で)だけ行い、同じ URI の間は content が変わっても変えない。
 * URI が変われば判定し直す。
 *
 * ## 対応する受け入れ基準(req-74.md に記帳)
 * - AC-74-A1 2 MiB 未満で開いた Markdown の面は、同じ uri で content が 2 MiB 超に変わっても残る(同じ DOM 要素・同じ handle)。
 *   「大きすぎる」知らせは出ない・`editBlocked` も立たない
 * - AC-74-A2 2 MiB 超で開いた Markdown は、同じ uri で content が小さくなっても「大きすぎる」知らせのまま(面は出ない)
 * - AC-74-A3 別の uri に変われば、その content で判定し直す(小 → 大 の uri: 知らせ・大 → 小 の uri: 面)
 *
 * ## 確定契約(implementer はこれに従う)
 * - 判定の入力は「その uri を**開いたとき**の content」。+page は `document={windowState.currentDocument}` で渡すので、
 *   `markSaved` / `applyFileChanged` / 描き直し(rerender)で content だけが変わっても `markdownTooBig` は変わらない
 * - 面の `{#key}` は uri が同じなら変わらない(ProseMirror の `.ProseMirror` 要素・`windowState.fileEditor` の handle が同一)
 * - 判定の持ち方(uri を鍵にした記憶・`$derived.by` で前の uri と比べる など)は implementer に任せる
 *
 * ## 判断の記録(test-writer・2026-11-22)
 * - content の差し替えは +page と同じ経路で起こす: 保存= `windowState.markSaved(content)` → 描き直し、外部変更= `windowState.applyFileChanged`
 *   → 描き直し。`setDocument` は同じ uri だと面の handle に `reset(2 MiB)` を掛けて ProseMirror の読み直しになり、テストが重くなるので使わない
 * - 2 MiB 超の content の `html` は小さな代用(`<h1>Big</h1><p>…</p>`)。Viewer の判定は `document.content` だけを見るので十分
 *
 * ## 修正前に赤になる理由
 * - A1: content が 2 MiB 超になると `markdownTooBig` が真になり、`{#key}` が変わって面が消え `markdown-too-large-notice` が出る
 * - A2: content が小さくなると `markdownTooBig` が偽になり、知らせが消えて面が出る
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { MARKDOWN_EDIT_LIMIT_BYTES, markdownTooLarge } from '../editor/markdown-limits';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({ mountMermaid: vi.fn(async () => undefined) }));
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
vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = { label: 'main', emit: vi.fn(async () => undefined), onFocusChanged: vi.fn(async () => () => {}), listen: vi.fn(async () => () => {}) };
	return { ...actual, getCurrentWindow: () => fake };
});
import * as eventsModule from '$lib/events';

const menuHandlers = (eventsModule as unknown as { __eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>> }).__eventHandlers;

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

const MD_URI = 'file:///Users/a/notes/plan.md';
const MD_B_URI = 'file:///Users/a/notes/other.md';
const SMALL = '# Plan\n\nIntro paragraph with **bold** word.\n\nSecond paragraph here.\n';
/** 2 MiB をはっきり超える(ASCII だけなので byte 数=文字数)。 */
const BIG = '# Big\n\n' + 'a'.repeat(MARKDOWN_EDIT_LIMIT_BYTES + 64) + '\n';
const BIG_HTML = '<h1>Big</h1><p>(large body)</p>';

const PM = '[data-testid="markdown-editor"] .ProseMirror[contenteditable="true"]';
const NOTICE = '[data-testid="markdown-too-large-notice"]';

function doc(uri: string, content: string, modified = 1): DocumentPayload {
	return { uri, content, modified };
}
type Props = { document: DocumentPayload; html: string; index: SourceIndex | null; onRequestAddMark: () => void; onToggleMarks: () => void; marksOpen: boolean };
async function propsFor(d: DocumentPayload): Promise<Props> {
	let html = BIG_HTML;
	let index: SourceIndex | null = null;
	if (!markdownTooLarge(d.content)) {
		const r = await renderMarkdown(d.content, d.uri);
		html = r.html;
		index = r.index;
	}
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false };
}
async function settle(rounds = 8) {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
	await tick();
}
async function settleLong() {
	await settle();
	await new Promise((r) => setTimeout(r, 0));
	await settle();
}
/** +page と同じ: store に置いてから Viewer に渡す。 */
async function mount(d: DocumentPayload) {
	windowState.setDocument(d);
	const props = await propsFor(d);
	const result = render(Viewer, { props });
	await settleLong();
	return { ...result, props };
}
/** 保存の経路: `markSaved` → +page が `windowState.currentDocument` を渡し直す(描き直し)。 */
async function saveAs(rerender: (p: Partial<Props>) => Promise<void>, props: Props, content: string) {
	windowState.markSaved(content);
	const d = windowState.currentDocument!;
	expect(d.content).toBe(content);
	await rerender({ ...props, document: d });
	await settleLong();
	return d;
}
/** 外部変更の取り込み(面が無い文書): `applyFileChanged` → 描き直し。 */
async function externalChange(rerender: (p: Partial<Props>) => Promise<void>, props: Props, d: DocumentPayload) {
	const decision = windowState.applyFileChanged(d);
	expect(decision).toBe('apply');
	await rerender({ ...(await propsFor(d)), onRequestAddMark: props.onRequestAddMark, onToggleMarks: props.onToggleMarks });
	await settleLong();
}
/** 別の文書を開く: `setDocument` → 描き直し。 */
async function openAnother(rerender: (p: Partial<Props>) => Promise<void>, d: DocumentPayload) {
	windowState.setDocument(d);
	await rerender(await propsFor(d));
	await settleLong();
}
function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}

beforeEach(() => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	windowState.externalRemoved = false;
	menuHandlers.clear();
	vi.stubGlobal('alert', vi.fn());
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AC-74-A1: 2 MiB 未満で開いた Markdown の面は、同じ uri で content が 2 MiB 超になっても残る', () => {
	it('前提: BIG は閾値超え・SMALL は閾値内', () => {
		expect(markdownTooLarge(BIG)).toBe(true);
		expect(markdownTooLarge(SMALL)).toBe(false);
	});

	it('保存(markSaved → 描き直し)で content が 2 MiB 超になっても、面(同じ DOM 要素・同じ handle)が残り、知らせは出ない', async () => {
		const { container, rerender, props } = await mount(doc(MD_URI, SMALL));
		const pmBefore = q(container, PM);
		expect(pmBefore, '開いた時点で ProseMirror の面').not.toBeNull();
		expect(q(container, NOTICE)).toBeNull();
		const handleBefore = windowState.fileEditor;
		expect(handleBefore?.kind).toBe('markdown');

		await saveAs(rerender, props, BIG);

		const pmAfter = q(container, PM);
		expect(pmAfter, '面は残る(読み取り専用の描画に替わらない)').not.toBeNull();
		expect(q(container, NOTICE), '「大きすぎる」知らせは出ない').toBeNull();
		expect(pmAfter, '面は作り直されていない(同じ DOM 要素)').toBe(pmBefore);
		expect(windowState.fileEditor, '面の handle も同じ').toBe(handleBefore);
		expect(windowState.editBlocked, '読み取り専用の印は立たない').toBe(false);
	});

	it('面のある文書の外部変更(applyFileChanged は面に委ねる)の後も、描き直しで面が入れ替わらない', async () => {
		const { container, rerender, props } = await mount(doc(MD_URI, SMALL));
		const pmBefore = q(container, PM);
		expect(pmBefore).not.toBeNull();
		// 面がある文書の file_changed は面が取り込む(契約12)。ここでは store の文書だけ 2 MiB 超に差し替わった状況を +page と同じ描き直しで渡す。
		const d = doc(MD_URI, BIG, 2);
		await rerender({ ...props, document: d });
		await settleLong();
		expect(q(container, PM), '面は残る').toBe(pmBefore);
		expect(q(container, NOTICE)).toBeNull();
	});
});

describe('AC-74-A2: 2 MiB 超で開いた Markdown は、同じ uri で content が小さくなっても知らせのまま', () => {
	it('外部変更(applyFileChanged → 描き直し)で content が閾値内になっても、知らせが出たまま・面は出ない', async () => {
		const { container, rerender, props } = await mount(doc(MD_URI, BIG));
		expect(q(container, NOTICE), '開いた時点で知らせ').not.toBeNull();
		expect(q(container, PM), '面は無い').toBeNull();
		expect(windowState.editBlocked).toBe(true);

		await externalChange(rerender, props, doc(MD_URI, SMALL, 2));

		expect(q(container, NOTICE), '知らせのまま(同じ uri の間は判定を変えない)').not.toBeNull();
		expect(q(container, PM), '面は出ない').toBeNull();
		expect(windowState.editBlocked).toBe(true);
	});
});

describe('AC-74-A3: 別の uri に変われば、その content で判定し直す', () => {
	it('閾値内の uri → 閾値超えの別の uri: 面が消えて知らせが出る', async () => {
		const { container, rerender } = await mount(doc(MD_URI, SMALL));
		expect(q(container, PM)).not.toBeNull();

		await openAnother(rerender, doc(MD_B_URI, BIG));

		expect(q(container, NOTICE), '新しい uri は閾値超え=知らせ').not.toBeNull();
		expect(q(container, PM), '面は無い').toBeNull();
		expect(windowState.editBlocked).toBe(true);
	});

	it('閾値超えの uri → 閾値内の別の uri: 知らせが消えて面が出る', async () => {
		const { container, rerender } = await mount(doc(MD_URI, BIG));
		expect(q(container, NOTICE)).not.toBeNull();

		await openAnother(rerender, doc(MD_B_URI, SMALL));

		expect(q(container, NOTICE), '新しい uri は閾値内=知らせは無い').toBeNull();
		expect(q(container, PM), '面が出る').not.toBeNull();
		expect(windowState.fileEditor?.kind).toBe('markdown');
		expect(windowState.editBlocked).toBe(false);
	});

	it('閾値超え(A)→ 閾値内(B)→ 閾値超えに育った A に戻る: 開き直しの content で判定し直す(知らせ)', async () => {
		const { container, rerender } = await mount(doc(MD_URI, BIG));
		await openAnother(rerender, doc(MD_B_URI, SMALL));
		expect(q(container, PM)).not.toBeNull();
		await openAnother(rerender, doc(MD_URI, BIG, 3));
		expect(q(container, NOTICE), 'uri が変わったので A は開き直しの content(閾値超え)で判定').not.toBeNull();
		expect(q(container, PM)).toBeNull();
	});
});
