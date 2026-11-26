/**
 * 要件#90 の受け入れテスト(docs/requirements/req-90.md)— 読み取り専用の描画(2 MiB 超・ssh)の配線(component プロジェクト・JSDOM)
 * AC-90-9(契約9: 読み取り専用の表示でも契約 1〜7 が同じに効く)・契約10(認めない書き方は今までどおりの引用)
 *
 * Markdown は開いた時点で ProseMirror の面だが、SSH root と閾値(2 MiB)を超えた文書は `render()` の HTML を `{@html}` で出す
 * 読み取り専用の描画(Viewer.svelte の `{:else}` の枝)。ここではその枝に同じ切り替えが効くことを見る。DOM の形の契約は
 * `MarkdownEditor.alerts.wiring.test.ts` のヘッダと同じ(枠の data-alert-kind / data-alert-state / hidden 属性 / data-alert-summary・
 * 印 .vellis-alert-marker と札 button[data-testid="alert-marker-label"][aria-label][data-label]・見出しのクリック・札のクリック)。
 * 読み取り専用なので契約8(カーソル)は無い。印刷はメインフレーム印刷= hidden 属性と、markdown.css の @media print の印の規則に任せる
 * (CSS は alert-visibility.acceptance.test.ts で見る。print.css は AC-56-16 が SHA-256 で固定しているので変えない)。
 *
 * ## 確定契約(implementer はこれに従う)
 * - Viewer は読み取り専用の描画の `.markdown-body` の中の `blockquote.markdown-alert` に、面と同じ属性(data-alert-kind・data-alert-state・
 *   hidden)と印を付ける。種類は class `markdown-alert-<kind>` から読む(要件15 の 5 種だけ=契約10)
 * - 設定の出どころは面と同じ `$lib/alert-visibility`(mount のとき currentAlertVisibility()・subscribeAlertVisibility で追う)
 * - `.markdown-alert-title` のクリックで collapsed ⇄ shown・札のクリックで組を shown(設定は変えない)
 * - 検索(Viewer の findMatches は容器の textContent)は隠した中身を数え、現在の一致が hidden / collapsed の枠の中ならその枠を shown にする
 * - 文書(windowState.currentDocument.content)は変えない・fileEditor は登録されない(読み取り専用のまま)
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - 読み取り専用の枝は ssh の URI で作る(canEnterEdit が偽)。閾値超えは 1 本だけ(2 MiB の文字列の描画は重い)
 * - 印刷の判定は CSS(markdown.css の @media print)に委ねる。読み取り専用の描画はメインフレームの印刷で、hidden 属性の枠は UA の既定で
 *   刷られず、印は markdown.css の @media print の規則で隠す(print.css は変えない=2026-11-26 オーケストレーターの判断)
 *
 * ## 修正前に赤になる理由
 * - `$lib/alert-visibility` が無く import で落ちる。あとは読み取り専用の描画に data-alert-state も印も無い
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { MARKDOWN_EDIT_LIMIT_BYTES } from '../editor/markdown-limits';
import {
	ALERT_VISIBILITY_STORAGE_KEY,
	ALL_ALERTS_SHOWN,
	MENU_ALERTS_HIDE_ALL_EVENT,
	MENU_ALERTS_TOGGLE_KIND_EVENT,
	alertSummary,
	applyAlertVisibility,
	currentAlertVisibility,
	registerAlertVisibilityListeners,
	serializeAlertVisibility,
	type AlertKind,
	type AlertVisibility,
} from '$lib/alert-visibility';

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

// ---------------------------------------------------------------------------
// フィクスチャ(MarkdownEditor.alerts.wiring.test.ts と同じ台本)と helper
// ---------------------------------------------------------------------------

const SSH_URI = 'ssh://host/srv/scripts/episode-12.md';
const BIG_URI = 'file:///Users/a/scripts/big.md';
const SCRIPT = [
	'# Episode 12 script',
	'',
	'Hello and welcome back to the channel.',
	'',
	'> [!NOTE]',
	'> Camera: slow zoom on the desk.',
	'',
	'> [!TIP]',
	'> Card: Episode 12 title card',
	'',
	'Today we talk about desk printers.',
	'',
	'> [!WARNING]',
	'> Needs a shoot: ask the maker about the model name.',
	'',
	'> [!NOTE]',
	'> Animation: fade in the channel logo.',
	'',
	'> [!WARNING]',
	'> Confirm the price with the maker.',
	'',
	'That is all for today. See you next time.',
	'',
].join('\n');
const KIND_ORDER: AlertKind[] = ['note', 'tip', 'warning', 'note', 'warning'];
/** 契約10: 認めない書き方(Obsidian の `-`・未知の種類・同じ行に本文)は普通の引用のまま。 */
const NOT_ALERTS = ['# Quotes', '', '> [!note]-', '> folded in Obsidian only', '', '> [!FOO]', '> unknown kind', '', '> [!NOTE] same line body', '', '> plain quote', ''].join('\n');

const v = (shown: Partial<Record<AlertKind, boolean>>): AlertVisibility =>
	({ note: true, tip: true, important: true, warning: true, caution: true, ...shown }) as AlertVisibility;

function doc(uri: string, content: string): DocumentPayload {
	return { uri, content, modified: 1 };
}
function baseProps(d: DocumentPayload, html: string, index: SourceIndex | null) {
	return { document: d, html, index, onRequestAddMark: vi.fn(), onToggleMarks: vi.fn(), marksOpen: false, fileEditor: true };
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
/** 読み取り専用の描画: ssh の URI(canEnterEdit が偽)で Viewer に載せる。 */
async function mountReadOnly(content = SCRIPT, uri = SSH_URI) {
	const d = doc(uri, content);
	windowState.setDocument(d);
	const r = await renderMarkdown(content, uri);
	const result = render(Viewer, { props: baseProps(d, r.html, r.index) });
	await settleLong();
	return result;
}

const BODY = 'article.viewer .markdown-body';
const ALERT = 'blockquote.markdown-alert';
const MARKER = '.vellis-alert-marker';
const LABEL = '[data-testid="alert-marker-label"]';
const TITLE = '.markdown-alert-title';

function q(container: ParentNode, selector: string): HTMLElement | null {
	return container.querySelector(selector);
}
function qa(container: ParentNode, selector: string): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(selector)];
}
function body(container: ParentNode): HTMLElement {
	const el = q(container, BODY);
	if (!el) throw new Error('.markdown-body が無い');
	return el;
}
function alerts(root: ParentNode): HTMLElement[] {
	return qa(root, ALERT);
}
function states(root: ParentNode): (string | null)[] {
	return alerts(root).map((el) => el.getAttribute('data-alert-state'));
}
function markers(root: ParentNode): HTMLElement[] {
	return qa(root, MARKER);
}
function labelOf(marker: Element): HTMLButtonElement {
	const b = marker.querySelector<HTMLButtonElement>(LABEL);
	if (!b) throw new Error('印の札(button)が無い');
	return b;
}
function groupOf(marker: Element): HTMLElement[] {
	const out: HTMLElement[] = [];
	let el = marker.nextElementSibling as HTMLElement | null;
	while (el && el.matches(`${ALERT}[data-alert-state="hidden"]`)) {
		out.push(el);
		el = el.nextElementSibling as HTMLElement | null;
	}
	return out;
}
function titleOf(alert: Element): HTMLElement {
	const t = alert.querySelector<HTMLElement>(TITLE);
	if (!t) throw new Error('枠の見出しが無い');
	return t;
}
function bodyTextOf(alert: Element): string {
	const title = alert.querySelector(TITLE)?.textContent ?? '';
	const all = alert.textContent ?? '';
	return all.startsWith(title) ? all.slice(title.length) : all.replace(title, '');
}
async function userClick(el: Element) {
	await fireEvent.mouseDown(el, { button: 0, buttons: 1 });
	await fireEvent.mouseUp(el, { button: 0 });
	await fireEvent.click(el, { button: 0 });
	await settleLong();
}
async function emitMenu(event: string, payload: unknown = undefined) {
	await settle();
	const list = [...(menuHandlers.get(event) ?? [])];
	expect(list.length, `'${event}' が購読されていること`).toBeGreaterThan(0);
	for (const h of list) h({ payload });
	await settleLong();
}
async function apply(next: AlertVisibility) {
	applyAlertVisibility(next);
	await settleLong();
}
async function typeQuery(container: ParentNode, value: string) {
	const input = q(container, '[data-testid="find-input"]') as HTMLInputElement | null;
	expect(input, '検索バーの入力欄').toBeTruthy();
	await fireEvent.input(input!, { target: { value } });
	await settleLong();
	await new Promise((r) => setTimeout(r, 200));
	await settle();
}
function countText(container: ParentNode): string {
	return (q(container, '[data-testid="find-count"]')?.textContent ?? '').trim();
}
/** 読み取り専用のまま・文書は変わらない。 */
function expectReadOnly(content = SCRIPT) {
	expect(windowState.fileEditor, '読み取り専用の描画では面の handle は無い').toBeNull();
	expect(windowState.currentDocument?.content).toBe(content);
	expect(windowState.dirty).toBe(false);
	expect(windowState.editBlocked).toBe(true);
}

let offListeners: (() => void) | null = null;

beforeEach(async () => {
	windowState.clearDocument();
	windowState.fileEditor = null;
	windowState.editBlocked = false;
	menuHandlers.clear();
	localStorage.clear();
	applyAlertVisibility(ALL_ALERTS_SHOWN);
	Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
	offListeners = await registerAlertVisibilityListeners();
});
afterEach(() => {
	offListeners?.();
	offListeners = null;
	cleanup();
	windowState.clearDocument();
	applyAlertVisibility(ALL_ALERTS_SHOWN);
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC-90-9 — 読み取り専用の表示(契約9)
// ---------------------------------------------------------------------------

describe('AC-90-9 契約9(ssh): 読み取り専用の描画でも枠に data-alert-kind / data-alert-state が付き、既定は全部 shown', () => {
	it('ssh の Markdown は面ではなく今の描画で、5 つの枠が shown・印は無い・contenteditable は無い', async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		expect(q(container, '.ProseMirror'), '面は作らない').toBeNull();
		expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(0);
		const list = alerts(root);
		expect(list).toHaveLength(5);
		expect(list.map((el) => el.getAttribute('data-alert-kind'))).toEqual(KIND_ORDER);
		expect(states(root)).toEqual(['shown', 'shown', 'shown', 'shown', 'shown']);
		expect(markers(root)).toHaveLength(0);
		expectReadOnly();
	});
});

describe('AC-90-9 契約9(ssh)・契約2: 種類を隠すと印になり、続けて隠れたものはまとまり、札で開く', () => {
	it('NOTE を隠す(メニュー)→ NOTE の 2 枠が hidden(hidden 属性・中身は DOM に残る)・印 2 つ(NOTE 1)', async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		await emitMenu(MENU_ALERTS_TOGGLE_KIND_EVENT, 'note');
		expect(states(root)).toEqual(['hidden', 'shown', 'shown', 'hidden', 'shown']);
		const [n1, , , n2] = alerts(root);
		expect(n1!.hidden).toBe(true);
		expect(n2!.hidden).toBe(true);
		expect(n1!.textContent).toContain('Camera: slow zoom on the desk.');
		const ms = markers(root);
		expect(ms).toHaveLength(2);
		for (const m of ms) {
			expect(m.getAttribute('data-testid')).toBe('alert-marker');
			expect(m.getAttribute('data-alert-counts')).toBe('note:1');
			expect(labelOf(m).getAttribute('aria-label')).toBe('NOTE 1');
			expect(labelOf(m).getAttribute('data-label')).toBe('NOTE 1');
			expect((labelOf(m).textContent ?? '').trim()).toBe('');
		}
		expect(groupOf(ms[0]!)).toEqual([n1]);
		expect(groupOf(ms[1]!)).toEqual([n2]);
		expectReadOnly();
	});

	it('NOTE と WARNING を隠す → 続く 3 枠が 1 つの印「WARNING 2 · NOTE 1」。全部隠す → 2 つの印', async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		await apply(v({ note: false, warning: false }));
		expect(states(root)).toEqual(['hidden', 'shown', 'hidden', 'hidden', 'hidden']);
		const ms = markers(root);
		expect(ms.map((m) => labelOf(m).getAttribute('aria-label'))).toEqual(['NOTE 1', 'WARNING 2 · NOTE 1']);
		expect(ms.map((m) => m.getAttribute('data-alert-counts'))).toEqual(['note:1', 'warning:2,note:1']);
		expect(groupOf(ms[1]!)).toEqual(alerts(root).slice(2));
		await emitMenu(MENU_ALERTS_HIDE_ALL_EVENT);
		expect(states(root)).toEqual(['hidden', 'hidden', 'hidden', 'hidden', 'hidden']);
		expect(markers(root).map((m) => labelOf(m).getAttribute('aria-label'))).toEqual(['NOTE 1 · TIP 1', 'WARNING 2 · NOTE 1']);
		expectReadOnly();
	});

	it('札を押すと、その印の枠だけが shown になり印が消える。設定(localStorage・currentAlertVisibility)は変わらない', async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		await apply(v({ note: false, warning: false }));
		const saved = localStorage.getItem(ALERT_VISIBILITY_STORAGE_KEY);
		await userClick(labelOf(markers(root)[1]!));
		expect(states(root)).toEqual(['hidden', 'shown', 'shown', 'shown', 'shown']);
		expect(markers(root)).toHaveLength(1);
		expect(currentAlertVisibility()).toEqual(v({ note: false, warning: false }));
		expect(localStorage.getItem(ALERT_VISIBILITY_STORAGE_KEY)).toBe(saved);
		expectReadOnly();
	});
});

describe('AC-90-9 契約9(ssh)・(A): Show All / Hide All は札で開いた・畳んだを全部捨てる(判断 i は種類ごとのチェックだけ)', () => {
	it('NOTE と WARNING を隠し、2 つ目の印の札で開き、TIP を畳んでから Hide All → 5 枠とも hidden・印は全部の組', async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		await apply(v({ note: false, warning: false }));
		await userClick(labelOf(markers(root)[1]!));
		await userClick(titleOf(alerts(root)[1]!));
		expect(states(root)).toEqual(['hidden', 'collapsed', 'shown', 'shown', 'shown']);
		await emitMenu(MENU_ALERTS_HIDE_ALL_EVENT);
		expect(states(root), '札で開いた枠も hidden に戻る').toEqual(['hidden', 'hidden', 'hidden', 'hidden', 'hidden']);
		expect(markers(root).map((m) => labelOf(m).getAttribute('aria-label'))).toEqual(['NOTE 1 · TIP 1', 'WARNING 2 · NOTE 1']);
		expectReadOnly();
	});

	it('NOTE を隠し、TIP を畳み、札で開いてから Show All → 5 枠とも shown(畳みも捨てる)・印無し', async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		await apply(v({ note: false }));
		await userClick(titleOf(alerts(root)[1]!));
		await userClick(labelOf(markers(root)[0]!));
		expect(states(root)).toEqual(['shown', 'collapsed', 'shown', 'hidden', 'shown']);
		await emitMenu('menu_alerts_show_all');
		expect(states(root)).toEqual(['shown', 'shown', 'shown', 'shown', 'shown']);
		expect(alerts(root)[1]!.hasAttribute('data-alert-summary')).toBe(false);
		expect(markers(root)).toHaveLength(0);
		expectReadOnly();
	});
});

describe('AC-90-9 契約9(ssh)・契約3: 見出しで畳む・開く', () => {
	it('TIP の見出しを押す → collapsed・data-alert-summary = alertSummary(本文)・中身は DOM に残る。もう一度で shown', async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		const tip = alerts(root)[1]!;
		const text = bodyTextOf(tip);
		await userClick(titleOf(tip));
		expect(tip.getAttribute('data-alert-state')).toBe('collapsed');
		expect(tip.getAttribute('data-alert-summary')).toBe(alertSummary(text));
		expect(tip.getAttribute('data-alert-summary')?.startsWith('Card: Episode 12')).toBe(true);
		expect(tip.hidden).toBe(false);
		expect(tip.textContent).toContain('Card: Episode 12 title card');
		expect(states(root)).toEqual(['shown', 'collapsed', 'shown', 'shown', 'shown']);
		await userClick(titleOf(tip));
		expect(tip.getAttribute('data-alert-state')).toBe('shown');
		expect(tip.hasAttribute('data-alert-summary')).toBe(false);
		expectReadOnly();
	});
});

// ---------------------------------------------------------------------------
// reviewer 差し戻し(2026-11-26)F4・F5 — 見出しの選択の抑止は読み取り専用の描画に当てない・見出しは操作子
// ---------------------------------------------------------------------------

describe('AC-90-9 契約9(ssh)・F4(回帰): 出ている枠の見出しに user-select: none が当たらない(コピーに見出しが入る今までの振る舞い)', () => {
	it('markdown.css の user-select: none の規則は、読み取り専用の描画の shown の見出し(article.viewer > div.markdown-body > blockquote.markdown-alert[data-alert-state="shown"] > p.markdown-alert-title)に当たらない', () => {
		const css = readFileSync(resolve(__dirname, '../styles/markdown.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
		const rules: Array<{ selector: string; declarations: string }> = [];
		const re = /([^{}]+)\{([^{}]*)\}/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(css)) !== null) {
			const selector = m[1]!.trim();
			if (selector.startsWith('@')) continue;
			rules.push({ selector, declarations: m[2]! });
		}
		const noSelect = rules.filter((r) => /(^|[^-])user-select\s*:\s*none/i.test(r.declarations));
		document.body.innerHTML = '';
		const article = document.createElement('article');
		article.className = 'viewer';
		const bodyEl = document.createElement('div');
		bodyEl.className = 'markdown-body';
		const alert = document.createElement('blockquote');
		alert.className = 'markdown-alert markdown-alert-tip';
		alert.setAttribute('data-alert-kind', 'tip');
		alert.setAttribute('data-alert-state', 'shown');
		const title = document.createElement('p');
		title.className = 'markdown-alert-title';
		title.textContent = 'Tip';
		alert.append(title);
		bodyEl.append(alert);
		article.append(bodyEl);
		document.body.append(article);
		const hits = noSelect.filter((r) =>
			r.selector
				.split(/,(?![^(]*\))/)
				.map((s) => s.trim())
				.some((s) => {
					try {
						return title.matches(s);
					} catch {
						throw new Error(`jsdom が解釈できないセレクタ: ${s}`);
					}
				}),
		);
		expect(hits.map((r) => r.selector), '読み取り専用の shown の見出しを選べなくする規則は無い(面の .ProseMirror か畳める操作子に限る)').toEqual([]);
		document.body.innerHTML = '';
	});

	it('出ている枠の見出しの字は選べる(範囲選択に入る): Range で見出しを選ぶと getSelection の文字に見出しが入る', async () => {
		const { container } = await mountReadOnly();
		const t = titleOf(alerts(body(container))[1]!);
		const range = document.createRange();
		range.selectNodeContents(t);
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		sel.addRange(range);
		expect(sel.toString()).toContain(t.textContent ?? '');
		sel.removeAllRanges();
	});
});

describe('AC-90-9 契約9(ssh)・F5: 見出しは操作子 — role=button・aria-expanded・tabindex・Enter / Space・左ボタン以外とドラッグ選択では畳まない', () => {
	it('出ている枠の見出しは role="button"・aria-expanded="true"・tabindex="0"。畳むと aria-expanded="false"', async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		for (const el of alerts(root)) {
			const t = titleOf(el);
			expect(t.getAttribute('role')).toBe('button');
			expect(t.getAttribute('aria-expanded')).toBe('true');
			expect(t.getAttribute('tabindex')).toBe('0');
		}
		await userClick(titleOf(alerts(root)[1]!));
		expect(alerts(root)[1]!.getAttribute('data-alert-state')).toBe('collapsed');
		expect(titleOf(alerts(root)[1]!).getAttribute('aria-expanded')).toBe('false');
		expectReadOnly();
	});

	it('見出しで Enter → 畳む。Space → 開く', async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		await fireEvent.keyDown(titleOf(alerts(root)[1]!), { key: 'Enter' });
		await settleLong();
		expect(alerts(root)[1]!.getAttribute('data-alert-state')).toBe('collapsed');
		await fireEvent.keyDown(titleOf(alerts(root)[1]!), { key: ' ' });
		await settleLong();
		expect(alerts(root)[1]!.getAttribute('data-alert-state')).toBe('shown');
		expectReadOnly();
	});

	it('右ボタンのクリックと、見出しの字のドラッグ選択(click の時点で選択が空でない)では畳まない', async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		const t = titleOf(alerts(root)[1]!);
		await fireEvent.mouseDown(t, { button: 2, buttons: 2 });
		await fireEvent.mouseUp(t, { button: 2 });
		await fireEvent.click(t, { button: 2 });
		await settleLong();
		expect(alerts(root)[1]!.getAttribute('data-alert-state')).toBe('shown');
		await fireEvent.mouseDown(t, { button: 0, buttons: 1 });
		const range = document.createRange();
		range.selectNodeContents(t);
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		sel.addRange(range);
		await fireEvent.mouseUp(t, { button: 0 });
		await fireEvent.click(t, { button: 0 });
		await settleLong();
		expect(alerts(root)[1]!.getAttribute('data-alert-state'), 'ドラッグ選択では畳まない').toBe('shown');
		sel.removeAllRanges();
	});
});

describe('AC-90-9 契約9(ssh)・契約5: 検索は隠した・畳んだ枠の中も数え、その一致へ移ると開く', () => {
	it("'camera'(隠した NOTE[0] の中だけ)→ 1 of 1・NOTE[0] が shown に(NOTE[1] は hidden のまま)", async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		await apply(v({ note: false }));
		await emitMenu('menu_find');
		await typeQuery(container, 'camera');
		expect(countText(container)).toBe('1 of 1');
		expect(states(root)).toEqual(['shown', 'shown', 'shown', 'hidden', 'shown']);
		expect(markers(root)).toHaveLength(1);
		expect(currentAlertVisibility()).toEqual(v({ note: false }));
	});

	it("'channel' → 1 of 2 では NOTE[1] は hidden のまま。Next で 2 of 2 → NOTE[1] が shown", async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		await apply(v({ note: false }));
		await emitMenu('menu_find');
		await typeQuery(container, 'channel');
		expect(countText(container)).toBe('1 of 2');
		expect(states(root)).toEqual(['hidden', 'shown', 'shown', 'hidden', 'shown']);
		await fireEvent.keyDown(q(container, '[data-testid="find-input"]')!, { key: 'Enter' });
		await settleLong();
		expect(countText(container)).toBe('2 of 2');
		expect(states(root)).toEqual(['hidden', 'shown', 'shown', 'shown', 'shown']);
	});

	it("畳んだ TIP の中の 'card' → 数えられ、現在の一致がその中なので TIP が shown に", async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		await userClick(titleOf(alerts(root)[1]!));
		await emitMenu('menu_find');
		await typeQuery(container, 'card');
		expect(countText(container)).toBe('1 of 2');
		expect(alerts(root)[1]!.getAttribute('data-alert-state')).toBe('shown');
	});
});

describe('AC-90-9 契約9(ssh)・契約7: 設定はアプリ全体で、他の窓の切り替えにも追い、開き直すと畳んだのは戻る', () => {
	it('他の窓が WARNING を隠した(storage イベント)→ この窓の描画も hidden に', async () => {
		const { container } = await mountReadOnly();
		const root = body(container);
		window.dispatchEvent(
			new StorageEvent('storage', { key: ALERT_VISIBILITY_STORAGE_KEY, newValue: serializeAlertVisibility(v({ warning: false })) }),
		);
		await settleLong();
		expect(states(root)).toEqual(['shown', 'shown', 'hidden', 'shown', 'hidden']);
		expectReadOnly();
	});

	it('TIP を畳んで別の文書を開いて戻る → TIP は shown(畳んだのは覚えない)', async () => {
		const r = await mountReadOnly();
		await userClick(titleOf(alerts(body(r.container))[1]!));
		expect(states(body(r.container))[1]).toBe('collapsed');
		const other = doc('ssh://host/srv/scripts/other.md', '# Other\n\nAnother.\n');
		windowState.setDocument(other);
		const ho = await renderMarkdown(other.content, other.uri);
		await r.rerender(baseProps(other, ho.html, ho.index));
		await settleLong();
		const back = doc(SSH_URI, SCRIPT);
		windowState.setDocument(back);
		const hb = await renderMarkdown(SCRIPT, SSH_URI);
		await r.rerender(baseProps(back, hb.html, hb.index));
		await settleLong();
		expect(states(body(r.container))).toEqual(['shown', 'shown', 'shown', 'shown', 'shown']);
	});
});

describe('AC-90-9 契約9(2 MiB 超): 閾値を超えた Markdown の今の描画にも同じ切り替えが効く', () => {
	it('知らせつきの今の描画で、NOTE を隠すと hidden と印', async () => {
		const big = `${SCRIPT}\n${'a'.repeat(MARKDOWN_EDIT_LIMIT_BYTES)}\n`;
		const { container } = await mountReadOnly(big, BIG_URI);
		expect(q(container, '[data-testid="markdown-too-large-notice"]'), '閾値超えの知らせ').not.toBeNull();
		expect(windowState.fileEditor).toBeNull();
		const root = body(container);
		expect(alerts(root)).toHaveLength(5);
		expect(states(root)).toEqual(['shown', 'shown', 'shown', 'shown', 'shown']);
		await apply(v({ note: false }));
		expect(states(root)).toEqual(['hidden', 'shown', 'shown', 'hidden', 'shown']);
		expect(markers(root)).toHaveLength(2);
		expect(windowState.currentDocument?.content).toBe(big);
	});
});

// ---------------------------------------------------------------------------
// 契約10 — 認めない書き方は今までどおりの引用
// ---------------------------------------------------------------------------

describe('契約10: 要件15 が認めない書き方(`> [!note]-`・`[!FOO]`・同じ行に本文・普通の引用)はアラートにならず、隠す対象にもならない', () => {
	it('ssh の描画: blockquote は 4 つとも markdown-alert でなく、全部隠しても hidden にならず印も出ず、文字は見えたまま', async () => {
		const { container } = await mountReadOnly(NOT_ALERTS, 'ssh://host/srv/quotes.md');
		const root = body(container);
		const quotes = qa(root, 'blockquote');
		expect(quotes).toHaveLength(4);
		for (const bq of quotes) {
			expect(bq.classList.contains('markdown-alert')).toBe(false);
			expect(bq.hasAttribute('data-alert-state')).toBe(false);
		}
		expect(root.textContent).toContain('[!note]-');
		expect(root.textContent).toContain('[!FOO]');
		expect(root.textContent).toContain('[!NOTE] same line body');
		await emitMenu(MENU_ALERTS_HIDE_ALL_EVENT);
		expect(markers(root)).toHaveLength(0);
		for (const bq of qa(root, 'blockquote')) {
			expect(bq.hidden).toBe(false);
			expect(bq.hasAttribute('data-alert-state')).toBe(false);
		}
		expectReadOnly(NOT_ALERTS);
	});
});
