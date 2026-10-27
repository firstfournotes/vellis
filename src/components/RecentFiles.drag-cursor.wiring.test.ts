/**
 * 要件#64 追補g の受け入れテスト(docs/requirements/req-64.md「追補g(2026-10-25・Issue #589)」)
 * — Recent Files の高さのドラッグ中は窓全体に ns-resize のカーソル
 * (component プロジェクト・`RecentFiles.svelte` を JSDOM に単体マウントする=RecentFiles.sash.wiring.test.ts
 * と同じ家風。`+page.svelte` の配線はソース走査)
 *
 * 発見: ドラッグ中のカーソルは `.recent-files.dragging` で区画の中だけに当てているので、区画を最大まで
 * 広げたあとも上へ引き続けてポインタがツリーの上に出ると、カーソルがツリーのものに戻る。要件#9 の幅の
 * 仕切りは `.app.resizing-pane` で窓全体に当てている。
 *
 * ## 配線に求める契約(追補g 1〜3。implementer はこれに従う)
 * - `RecentFiles.svelte` は省略できる prop **`onDragChange?: (dragging: boolean) => void`** を持ち、
 *   高さのドラッグが始まったとき(`dragging` が偽 → 真=3px 以上動いた最初の pointermove)に `true` で
 *   1 回、終わったとき(真 → 偽=離す・取り消す=今の `endPress` の経路すべて)に `false` で 1 回呼ぶ。
 *   押しただけ(pointerdown)・3px 未満で離したクリック・閉じているときのドラッグでは呼ばない
 * - `+page.svelte` は `<RecentFiles … onDragChange={…}>` で受けて `.app` に `class:resizing-recent-files`
 *   を付け外しし、`<style>` に `.app.resizing-recent-files`(とその子孫)へ `cursor: ns-resize` と
 *   `user-select: none` を当てる規則を書く(`.app.resizing-pane` と同じ形)
 * - 不変: 区画の中の `.recent-files.dragging` の規則・高さの計算と保存(離した時点だけ)・クリックと
 *   ドラッグの見分け(3px)・要件9 の幅の仕切り
 *
 * ## 判定(AC-64-追g)
 * - (a) 描画して、つかみ所(`recent-files-sash`)または見出し行(`recent-files-header`)で 3px 以上動かすと
 *   `onDragChange(true)` が 1 回、離すと `onDragChange(false)` が 1 回。動かさずに離した(0px・2px)クリック
 *   では呼ばれない。pointercancel でも `false` で 1 回。閉じているときは呼ばれない。省略しても落ちない。
 *   ドラッグの最中に区画が消えた(unmount)ら `onDestroy` で `false` が 1 回来る(起案時判断 (b)・
 *   2026-10-25 reviewer P3-1 で追加)。ドラッグしていないときの unmount では呼ばれない
 * - (b) `+page.svelte`(ソース走査): `<RecentFiles` に `onDragChange`・`.app` に `class:resizing-recent-files`・
 *   `<style>` に `.app.resizing-recent-files` の `cursor: ns-resize`(と `user-select: none`=契約 2)。
 *   加えて **子孫の規則**: `.app.resizing-recent-files` の後に子孫の結合子(空白)と `*`(`:global(*)` か ` *`)
 *   を持つセレクタがあり、その規則に `cursor: ns-resize` がある(ツリーの行の `cursor: pointer` に勝つのは
 *   この規則=契約 2「(とその子孫)」・2026-10-25 reviewer P2-1 で追加)
 * - (c) 既存の要件64 のテストは無改変で緑(このファイルは足すだけ)
 * - 不変の守り: `RecentFiles.svelte` の `.recent-files.dragging` に `cursor: ns-resize` が残る
 *
 * ## 判断の記録(test-writer 2026-10-25)
 * - `user-select: none` は契約 2 の明文なので (b) に含める(起案時判断 (a)=由谷の事後確認待ち。別の
 *   it にして切り分けられるようにした)
 * - `.app.resizing-recent-files` の規則は、セレクタにその字句を含むもの(`.app.resizing-recent-files *`
 *   のような子孫の列挙も可)のどれかが宣言していればよい。`.app` の開きタグは `class="app"` を持つ `<div`
 *   として探し、その属性に `class:resizing-recent-files` を求める(束縛する変数名は implementer 裁量)
 * - 「省略しても落ちない」は、prop 無しでドラッグ(高さが変わり保存される)が今までどおり動くことで判定
 *
 * ## スタブの設計(RecentFiles.sash.wiring.test.ts と同じ)
 * - $lib/ipc / $lib/edit-guard / tauri plugin-opener / plugin-dialog はモジュールモック
 * - JSDOM は pointer capture を持たないので Element.prototype に no-op を足す。ポインタ操作は
 *   `pointerdown → (pointermove) → pointerup → click` の列で送る
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/edit-guard', () => ({ confirmDiscardEdits: vi.fn(async () => true) }));
vi.mock('@tauri-apps/plugin-opener', () => ({
	revealItemInDir: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
	openUrl: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
	open: vi.fn(async () => null),
	ask: vi.fn(async () => false),
}));

import { invoke } from '$lib/ipc';
import RecentFiles from './RecentFiles.svelte';
import { windowState } from '../stores/window-state.svelte';
import {
	SECTION_HEIGHT_STORAGE_KEY,
	saveSectionExpanded,
	saveSectionHeight,
} from '$lib/recent-files-section';

const invokeMock = vi.mocked(invoke);

const ROOT = 'file:///Users/x/notes';
const MD = `${ROOT}/docs/spec/a.md`;
/** 左ペインの高さ(px)。高さの上限= 600 − 100 = 500。 */
const PANE = 600;
/** 開始時の高さ(px)。 */
const START_HEIGHT = 200;

/** 契約の名前(追補g 1・2)。 */
const PROP_NAME = 'onDragChange';
const APP_CLASS = 'resizing-recent-files';

// JSDOM は pointer capture を実装していない。
const elementProto = Element.prototype as unknown as Record<string, unknown>;
if (typeof elementProto.setPointerCapture !== 'function') {
	elementProto.setPointerCapture = () => {};
	elementProto.releasePointerCapture = () => {};
	elementProto.hasPointerCapture = () => false;
}

let recent: string[] = [];

function installInvoke() {
	recent = [];
	invokeMock.mockImplementation(async (cmd: string) => {
		if (cmd === 'list_recent_files') return [...recent];
		if (cmd === 'clear_recent_files') {
			recent = [];
			return null;
		}
		return null;
	});
}

const listCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'list_recent_files');

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

/** 区画をマウントする。`onDragChange` を渡さなければ prop を省く(省略できることの判定)。 */
function mountSection(onDragChange?: (dragging: boolean) => void) {
	const props: Record<string, unknown> = {
		rootUri: ROOT,
		currentUri: null,
		paneHeight: PANE,
		onOpened: vi.fn(),
	};
	// 追補g で足す prop(実装前の型には無い)。
	if (onDragChange) props[PROP_NAME] = onDragChange;
	return render(RecentFiles, { props: props as never });
}

const section = () => screen.getByTestId('recent-files') as HTMLElement;
const header = () => screen.getByTestId('recent-files-header') as HTMLElement;
const sash = () => screen.getByTestId('recent-files-sash') as HTMLElement;
const rows = () => screen.queryAllByTestId('recent-files-row') as HTMLElement[];
const expanded = () => header().getAttribute('aria-expanded');
const heightOf = () => Number.parseFloat(section().style.height);

async function loaded(count: number) {
	await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(1));
	await waitFor(() => expect(rows()).toHaveLength(count));
	await settle();
}

type PointerType = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';

/** ポインタイベントを 1 つ送る(JSDOM 29 は PointerEvent を持つ。無い環境では MouseEvent)。 */
function pointer(el: Element, type: PointerType, clientY: number) {
	const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
	const init: Record<string, unknown> = {
		bubbles: true,
		cancelable: true,
		composed: true,
		clientX: 20,
		clientY,
		button: 0,
		buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true,
	};
	el.dispatchEvent(new Ctor(type, init as MouseEventInit));
}

/** 押して(必要なら動かして)離し、ブラウザと同じく click も送る。 */
async function press(el: Element, fromY: number, toY: number = fromY) {
	pointer(el, 'pointerdown', fromY);
	await tick();
	if (toY !== fromY) {
		pointer(el, 'pointermove', toY);
		await tick();
	}
	pointer(el, 'pointerup', toY);
	await tick();
	await fireEvent.click(el, { clientX: 20, clientY: toY });
	await settle();
}

/** `onDragChange` に渡った値の列。 */
const calls = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => c[0]);

beforeEach(() => {
	installInvoke();
	windowState.applyRoot(ROOT, [], false);
	Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
	vi.stubGlobal('alert', vi.fn());
	try {
		localStorage.clear();
		sessionStorage.clear();
	} catch {
		// storage が無い環境は無視
	}
	saveSectionHeight(START_HEIGHT);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-64-追g (a) — ドラッグの始まりと終わりを onDragChange で知らせる(契約 追補g 1)
// ---------------------------------------------------------------------------

describe('AC-64-追g (a): つかみ所のドラッグで onDragChange(true) → 離して onDragChange(false) が各 1 回(契約 追補g 1)', () => {
	it('pointerdown だけでは呼ばれず、3px 以上動かすと true で 1 回、続けて動かしても増えず、離すと false で 1 回', async () => {
		const onDragChange = vi.fn();
		recent = [MD];
		mountSection(onDragChange);
		await loaded(1);
		const before = heightOf();

		const el = sash();
		pointer(el, 'pointerdown', 300);
		await tick();
		expect(calls(onDragChange), 'pressing alone is not a drag yet').toEqual([]);

		pointer(el, 'pointermove', 260);
		await tick();
		expect(calls(onDragChange), 'the first move of 3px or more starts the drag').toEqual([true]);
		expect(heightOf(), 'the height still follows the pointer (unchanged)').toBe(before + 40);

		pointer(el, 'pointermove', 250);
		await tick();
		expect(calls(onDragChange), 'further moves do not repeat the notification').toEqual([true]);

		pointer(el, 'pointerup', 250);
		await tick();
		await fireEvent.click(el, { clientX: 20, clientY: 250 });
		await settle();
		expect(calls(onDragChange), 'releasing ends the drag exactly once').toEqual([true, false]);
		expect(onDragChange).toHaveBeenCalledTimes(2);

		expect(heightOf()).toBe(before + 50);
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY), 'still saved on release').toBe(String(before + 50));
		expect(expanded()).toBe('true');
	});

	it('見出し行のドラッグ(pointerdown → pointermove → pointerup → click)でも true / false が各 1 回・開閉は変わらない', async () => {
		const onDragChange = vi.fn();
		recent = [MD];
		mountSection(onDragChange);
		await loaded(1);
		const before = heightOf();

		await press(header(), 300, 260);

		expect(calls(onDragChange)).toEqual([true, false]);
		expect(heightOf()).toBe(before + 40);
		expect(expanded(), 'the click after a drag does not toggle (unchanged)').toBe('true');
	});

	it('pointercancel(取り消し)でも false で 1 回=endPress のすべての経路(つかみ所・見出し行)', async () => {
		const onDragChange = vi.fn();
		recent = [MD];
		mountSection(onDragChange);
		await loaded(1);

		const el = sash();
		pointer(el, 'pointerdown', 300);
		await tick();
		pointer(el, 'pointermove', 260);
		await tick();
		expect(calls(onDragChange)).toEqual([true]);
		pointer(el, 'pointercancel', 260);
		await tick();
		await settle();
		expect(calls(onDragChange), 'cancel on the sash ends the drag').toEqual([true, false]);

		onDragChange.mockClear();
		const h = header();
		pointer(h, 'pointerdown', 300);
		await tick();
		pointer(h, 'pointermove', 340);
		await tick();
		expect(calls(onDragChange)).toEqual([true]);
		pointer(h, 'pointercancel', 340);
		await tick();
		await settle();
		expect(calls(onDragChange), 'cancel on the header ends the drag').toEqual([true, false]);
	});

	it('2 回続けてドラッグすると、それぞれ true / false が 1 回ずつ(状態が残らない)', async () => {
		const onDragChange = vi.fn();
		recent = [MD];
		mountSection(onDragChange);
		await loaded(1);

		await press(sash(), 300, 280);
		await press(sash(), 300, 320);

		expect(calls(onDragChange)).toEqual([true, false, true, false]);
	});

	it('ドラッグの最中に区画が消えた(unmount)ら false が 1 回来る=onDestroy(起案時判断 (b))。ドラッグしていないときの unmount では呼ばれない', async () => {
		// ドラッグ中に消える(押したまま検索パネルを出す・root が変わる)— 離すが届かないので onDestroy で戻す。
		const during = vi.fn();
		recent = [MD];
		const dragged = mountSection(during);
		await loaded(1);
		const el = sash();
		pointer(el, 'pointerdown', 300);
		await tick();
		pointer(el, 'pointermove', 260);
		await tick();
		expect(calls(during)).toEqual([true]);

		dragged.unmount();
		await settle();
		expect(calls(during), 'unmounting mid-drag ends the drag exactly once').toEqual([true, false]);
		expect(during).toHaveBeenCalledTimes(2);

		// 押しただけ(3px 未満・ドラッグが始まっていない)で消えても呼ばれない。
		const pressedOnly = vi.fn();
		const pressed = mountSection(pressedOnly);
		await loaded(1);
		pointer(sash(), 'pointerdown', 300);
		await tick();
		pressed.unmount();
		await settle();
		expect(pressedOnly, 'a mere press is not a drag — nothing to end').not.toHaveBeenCalled();

		// 何もしていないときに消えても呼ばれない。
		const idle = vi.fn();
		const untouched = mountSection(idle);
		await loaded(1);
		untouched.unmount();
		await settle();
		expect(idle, 'an idle section unmounting never notifies').not.toHaveBeenCalled();
	});
});

describe('AC-64-追g (a): 動かさずに離した(クリック)・閉じているときは呼ばれない(契約 追補g 1・3px の見分けは不変)', () => {
	it('つかみ所: 0px・2px で離して click まで届いても呼ばれない', async () => {
		const onDragChange = vi.fn();
		recent = [MD];
		mountSection(onDragChange);
		await loaded(1);
		const before = heightOf();

		await press(sash(), 300);
		await press(sash(), 300, 298);

		expect(onDragChange).not.toHaveBeenCalled();
		expect(heightOf()).toBe(before);
		expect(expanded()).toBe('true');
	});

	it('見出し行: クリック(0px)は開閉だけで呼ばれない・2px の押しでも呼ばれない', async () => {
		const onDragChange = vi.fn();
		recent = [MD];
		mountSection(onDragChange);
		await loaded(1);

		await press(header(), 300);
		expect(expanded(), 'a plain click toggles (unchanged)').toBe('false');
		expect(onDragChange).not.toHaveBeenCalled();

		await press(header(), 300);
		expect(expanded()).toBe('true');
		await waitFor(() => expect(rows()).toHaveLength(1));
		expect(onDragChange).not.toHaveBeenCalled();

		await press(header(), 300, 302);
		expect(onDragChange, 'a 2px press is a click, not a drag').not.toHaveBeenCalled();
	});

	it('閉じているときの見出し行のドラッグ(3px 以上)ではドラッグが始まらないので呼ばれない', async () => {
		saveSectionExpanded(false);
		const onDragChange = vi.fn();
		recent = [MD];
		mountSection(onDragChange);
		await settle();
		expect(expanded()).toBe('false');

		await press(header(), 300, 240);

		expect(onDragChange).not.toHaveBeenCalled();
		expect(expanded(), 'a drag on a collapsed section neither resizes nor toggles (unchanged)').toBe('false');
	});
});

describe('AC-64-追g (a): onDragChange を省略しても落ちない(省略できる prop)', () => {
	it('prop 無しでつかみ所をドラッグしても例外なく高さが変わり、離した時点で保存される', async () => {
		recent = [MD];
		mountSection();
		await loaded(1);
		const before = heightOf();

		await press(sash(), 300, 260);

		expect(heightOf()).toBe(before + 40);
		expect(localStorage.getItem(SECTION_HEIGHT_STORAGE_KEY)).toBe(String(before + 40));
		expect(expanded()).toBe('true');
	});
});

// ---------------------------------------------------------------------------
// AC-64-追g (b) — +page.svelte の配線(ソース走査)
// ---------------------------------------------------------------------------

const PAGE_PATH = resolve(__dirname, '../routes/+page.svelte');
const pageSource = () => readFileSync(PAGE_PATH, 'utf-8');

type Rule = { selectors: string[]; declarations: string };

/** `<style>…</style>` の中の `selector { declarations }` を順に拾う(コメントは落とす)。 */
function styleRules(source: string, what: string): Rule[] {
	const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source);
	expect(m, `${what} has a <style> block`).toBeTruthy();
	const css = (m as RegExpExecArray)[1].replace(/\/\*[\s\S]*?\*\//g, '');
	const out: Rule[] = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let hit: RegExpExecArray | null;
	while ((hit = re.exec(css)) !== null) {
		out.push({
			selectors: hit[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0),
			declarations: hit[2],
		});
	}
	return out;
}

const declares = (declarations: string, property: string, value: string) =>
	new RegExp(`(^|;|\\s)${property}\\s*:\\s*${value}\\s*(!important)?\\s*(;|$)`, 'm').test(declarations);

/** セレクタに `.app.resizing-recent-files` を含む規則(子孫の列挙 `… *` も含む)。 */
const appResizingRules = (rules: Rule[]) =>
	rules.filter((r) => r.selectors.some((s) => s.includes(`.app.${APP_CLASS}`)));

describe('AC-64-追g (b): +page.svelte の配線(ソース走査)— onDragChange を受けて .app に resizing-recent-files を付け、窓全体に ns-resize(契約 追補g 2)', () => {
	it(`<RecentFiles …> に ${PROP_NAME} を渡す`, () => {
		const source = pageSource();
		const start = source.search(/<RecentFiles\b/);
		expect(start, '+page.svelte renders <RecentFiles').toBeGreaterThanOrEqual(0);
		const end = source.indexOf('/>', start);
		expect(end, '<RecentFiles … /> is self-closing').toBeGreaterThan(start);
		const attrs = source.slice(start, end);
		expect(
			new RegExp(`(^|\\s)${PROP_NAME}\\s*=|(^|\\s)\\{\\s*${PROP_NAME}\\s*\\}`).test(attrs),
			`<RecentFiles … ${PROP_NAME}={…} /> — the page listens to the drag`
		).toBe(true);
	});

	it(`.app の開きタグに class:${APP_CLASS} がある(.app.resizing-pane と同じ形)`, () => {
		const source = pageSource();
		const tag = /<div\s[^>]*\bclass="app"[^>]*>/.exec(source);
		expect(tag, '+page.svelte has <div class="app" …>').toBeTruthy();
		const open = (tag as RegExpExecArray)[0];
		expect(open, 'the existing class:resizing-pane stays (requirement 9)').toContain('class:resizing-pane');
		expect(open, `<div class="app" … class:${APP_CLASS}={…}>`).toMatch(
			new RegExp(`class:${APP_CLASS}\\s*=`)
		);
	});

	it(`<style> に .app.${APP_CLASS} へ cursor: ns-resize を当てる規則がある`, () => {
		const rules = styleRules(pageSource(), '+page.svelte');
		// パーサの自己点検: 既存の .app.resizing-pane の規則(col-resize)が拾えている。
		const pane = rules.filter((r) => r.selectors.some((s) => s.includes('.app.resizing-pane')));
		expect(pane.some((r) => declares(r.declarations, 'cursor', 'col-resize'))).toBe(true);

		const mine = appResizingRules(rules);
		expect(mine.length, `a rule targets .app.${APP_CLASS}`).toBeGreaterThan(0);
		expect(
			mine.some((r) => declares(r.declarations, 'cursor', 'ns-resize')),
			`one of the .app.${APP_CLASS} rules declares cursor: ns-resize`
		).toBe(true);
	});

	it(`<style> に .app.${APP_CLASS} の子孫(\` *\` か \` :global(*)\`)へ cursor: ns-resize を当てる規則がある(契約 追補g 2「とその子孫」)`, () => {
		// ツリーの行などは自分の `cursor: pointer` を持つ(継承より強い)ので、.app だけに当てても
		// ポインタがツリーの上に出た瞬間に戻る。勝つのは子孫を名指しするこの規則。
		const descendant = new RegExp(`\\.app\\.${APP_CLASS}\\s+(?::global\\(\\s*\\*\\s*\\)|\\*)$`);
		const rules = appResizingRules(styleRules(pageSource(), '+page.svelte')).filter((r) =>
			r.selectors.some((s) => descendant.test(s))
		);
		expect(
			rules.length,
			`a rule targets the descendants: \`.app.${APP_CLASS} *\` or \`.app.${APP_CLASS} :global(*)\``
		).toBeGreaterThan(0);
		expect(
			rules.some((r) => declares(r.declarations, 'cursor', 'ns-resize')),
			'the descendant rule declares cursor: ns-resize (it is what beats the rows\' cursor: pointer)'
		).toBe(true);
	});

	it(`<style> の .app.${APP_CLASS} に user-select: none もある(契約 追補g 2・起案時判断 (a))`, () => {
		const mine = appResizingRules(styleRules(pageSource(), '+page.svelte'));
		expect(
			mine.some((r) => declares(r.declarations, 'user-select', 'none')),
			`one of the .app.${APP_CLASS} rules declares user-select: none (as .app.resizing-pane does)`
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 不変の守り — 区画の中の .recent-files.dragging の規則は残る(契約 追補g 3)
// ---------------------------------------------------------------------------

describe('AC-64-追g(不変): RecentFiles.svelte の .recent-files.dragging に cursor: ns-resize が残る(契約 追補g 3)', () => {
	it('区画の中のドラッグ中の規則はそのまま', () => {
		const rules = styleRules(readFileSync(resolve(__dirname, 'RecentFiles.svelte'), 'utf-8'), 'RecentFiles.svelte');
		const dragging = rules.filter((r) => r.selectors.some((s) => s.includes('.recent-files.dragging')));
		expect(dragging.some((r) => declares(r.declarations, 'cursor', 'ns-resize'))).toBe(true);
	});
});
