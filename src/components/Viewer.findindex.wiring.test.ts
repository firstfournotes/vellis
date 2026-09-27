/**
 * 要件#55 追補b(2026-09-25・docs/requirements/req-55.md「追補b」)— Viewer の
 * `findInitialIndex`(component プロジェクト)
 *
 * 「フォルダ横断検索の結果をクリックしたら、そのファイルの中の**その番目の一致**が
 * 現在の一致になる」。番目の数え方(`occurrenceIndex`)は unit 側・パネルが第 3 引数で
 * 渡す側は FindInFolder.wiring。ここは `Viewer.svelte` を JSDOM にマウントし、
 * `findRequest` が進んだときに `findInitialQuery` + `findInitialIndex` で開いた検索バーの
 * **現在の一致**が番目どおりか(`n of m` の表示と `data-vellis-find-current` の位置)を判定する。
 * 既存の Viewer.find.wiring.test.ts(要件#54)は書き換えず、その家風に倣って新設。
 *
 * ## 配線に求める契約(implementer はこれに従う)
 * - `Viewer.svelte` に prop `findInitialIndex?: number`(0 始まり・省略時 0)を足す。
 *   `findRequest` が進んだとき、`findInitialQuery` が空でなければその語にして `openFind()` し、
 *   一致が出揃った後で現在の一致を `findInitialIndex` に合わせる(`n of m` の n = index + 1)
 * - index が一致数以上なら**最後の一致**(先頭に戻さない)。index 0 なら先頭。負値は来ない前提
 * - Command + F(`menu_find` イベント)の経路では index は効かず先頭(prop に値が残っていても)
 * - 既存の意味論は不変: 語の打ち替えで先頭へ戻る(AC-54-5/6)・件数表示は `formatCount`
 *
 * ## JSDOM 上の注意(Viewer.find.wiring の家風)
 * - CSS.highlights が無いので `<mark data-vellis-find>` フォールバック=現在の一致は
 *   `mark[data-vellis-find-current]`。フィクスチャの 4 一致はどれも 1 テキストノード内なので
 *   mark は 4 個で、現在の mark の位置=番目
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import Viewer from './Viewer.svelte';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { render as renderMarkdown } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openUrl: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));
vi.mock('$lib/mermaid-mounter', () => ({
	mountMermaid: vi.fn(async () => undefined),
}));

// menu_find の到着を写すための $lib/events モック(Viewer.find.wiring と同型)。
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

import * as eventsModule from '$lib/events';

const menuHandlers = (
	eventsModule as unknown as {
		__eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>>;
	}
).__eventHandlers;

const MENU_FIND = 'menu_find';

// ---------------------------------------------------------------------------
// フィクスチャ('zebra' が 4 箇所=Viewer.find.wiring と同じ文書)
// ---------------------------------------------------------------------------

const MD_URI = 'file:///Users/a/notes/zebra.md';
const MD = ['# Zebra Title', '', 'Zebra crossing sees a **ZEBRA** daily.', '', '- zebra item', ''].join(
	'\n',
);
const TOTAL = 4;

let renderedMd: { html: string; index: SourceIndex };

beforeAll(async () => {
	const a = await renderMarkdown(MD, MD_URI);
	renderedMd = { html: a.html, index: a.index };
});

type FindProps = {
	findRequest?: number;
	findInitialQuery?: string;
	findInitialIndex?: number;
};

function propsOf(doc: DocumentPayload, find: FindProps) {
	return {
		document: doc,
		html: renderedMd.html,
		index: renderedMd.index,
		onRequestAddMark: vi.fn(),
		onToggleMarks: vi.fn(),
		marksOpen: false,
		...find,
	};
}

function mountMd(find: FindProps) {
	const doc: DocumentPayload = { uri: MD_URI, content: MD, modified: 1 };
	windowState.setDocument(doc);
	const utils = render(Viewer, { props: propsOf(doc, find) });
	return { doc, ...utils };
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await tick();
}

async function emitMenuFind() {
	await settle();
	const list = [...(menuHandlers.get(MENU_FIND) ?? [])];
	expect(list.length, "Viewer subscribes to 'menu_find'").toBeGreaterThan(0);
	for (const handler of list) handler({ payload: undefined });
	await settle();
}

function findBar(container: HTMLElement): HTMLElement | null {
	return container.querySelector('[data-testid="find-bar"]');
}

function findInput(container: HTMLElement): HTMLInputElement {
	const el = container.querySelector('[data-testid="find-input"]');
	expect(el, 'find-input exists').toBeTruthy();
	return el as HTMLInputElement;
}

function countText(container: HTMLElement): string {
	const el = container.querySelector('[data-testid="find-count"]');
	expect(el, 'find-count exists').toBeTruthy();
	return ((el as HTMLElement).textContent ?? '').trim();
}

function marks(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll('mark[data-vellis-find]')] as HTMLElement[];
}

/** 現在の一致(`data-vellis-find-current`)が全 mark の中で何番目か(0 始まり・無ければ -1)。 */
function currentMarkIndex(container: HTMLElement): number {
	const all = marks(container);
	const current = all.filter((m) => m.hasAttribute('data-vellis-find-current'));
	expect(current, 'exactly one current mark').toHaveLength(1);
	return all.indexOf(current[0]);
}

async function waitForCount(container: HTMLElement, expected: string) {
	await waitFor(() => {
		expect(findBar(container), 'find bar is open').toBeTruthy();
		expect(countText(container)).toBe(expected);
	});
	await settle();
}

async function typeQuery(container: HTMLElement, value: string) {
	await fireEvent.input(findInput(container), { target: { value } });
	await settle();
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	menuHandlers.clear();
});

// ---------------------------------------------------------------------------
// AC-55-21 — findInitialIndex で現在の一致が決まる
// ---------------------------------------------------------------------------

describe('要件#55 追補b・AC-55-21: Viewer の findInitialIndex — findRequest で開いた検索の現在の一致がその番目になる', () => {
	it('findInitialQuery=zebra・findInitialIndex=2 で開くと 3 of 4 で、3 番目の一致が現在', async () => {
		const { container } = mountMd({ findRequest: 1, findInitialQuery: 'zebra', findInitialIndex: 2 });

		await waitForCount(container, `3 of ${TOTAL}`);

		expect(findInput(container).value).toBe('zebra');
		expect(marks(container)).toHaveLength(TOTAL);
		expect(currentMarkIndex(container)).toBe(2);
	});

	it('findInitialIndex=1 なら 2 of 4(番目=index + 1)', async () => {
		const { container } = mountMd({ findRequest: 1, findInitialQuery: 'zebra', findInitialIndex: 1 });

		await waitForCount(container, `2 of ${TOTAL}`);
		expect(currentMarkIndex(container)).toBe(1);
	});

	it('一致数を超える index(99)は最後の一致(4 of 4)— 先頭へ戻さない', async () => {
		const { container } = mountMd({ findRequest: 1, findInitialQuery: 'zebra', findInitialIndex: 99 });

		await waitForCount(container, `${TOTAL} of ${TOTAL}`);
		expect(currentMarkIndex(container)).toBe(TOTAL - 1);
	});

	it('index 0 なら先頭(1 of 4)・省略時も先頭', async () => {
		const zero = mountMd({ findRequest: 1, findInitialQuery: 'zebra', findInitialIndex: 0 });
		await waitForCount(zero.container, `1 of ${TOTAL}`);
		expect(currentMarkIndex(zero.container)).toBe(0);
		zero.unmount();

		const omitted = mountMd({ findRequest: 1, findInitialQuery: 'zebra' });
		await waitForCount(omitted.container, `1 of ${TOTAL}`);
		expect(currentMarkIndex(omitted.container)).toBe(0);
	});

	it('語が無い文書では No results のまま(index があってもエラーにならない)', async () => {
		const { container } = mountMd({ findRequest: 1, findInitialQuery: 'omega', findInitialIndex: 2 });

		await waitForCount(container, 'No results');
		expect(marks(container)).toHaveLength(0);
	});

	it('findRequest が再び進むと、そのときの findInitialIndex に合わせ直す(2 度目のクリック)', async () => {
		const { container, doc, rerender } = mountMd({
			findRequest: 1,
			findInitialQuery: 'zebra',
			findInitialIndex: 3,
		});
		await waitForCount(container, `${TOTAL} of ${TOTAL}`);

		await rerender(propsOf(doc, { findRequest: 2, findInitialQuery: 'zebra', findInitialIndex: 1 }));
		await waitForCount(container, `2 of ${TOTAL}`);
		expect(currentMarkIndex(container)).toBe(1);
	});

	it('番目で開いた後に語を打ち替えると従来どおり先頭へ戻る(AC-54-5/6 の意味論は不変)', async () => {
		const { container } = mountMd({ findRequest: 1, findInitialQuery: 'zebra', findInitialIndex: 2 });
		await waitForCount(container, `3 of ${TOTAL}`);

		await typeQuery(container, 'zebr');
		await waitForCount(container, `1 of ${TOTAL}`);
		expect(currentMarkIndex(container)).toBe(0);
	});

	it('Command + F(menu_find)の経路では index が効かず先頭(prop に 2 が残っていても 1 of 4)', async () => {
		const { container } = mountMd({ findRequest: 0, findInitialQuery: '', findInitialIndex: 2 });

		await emitMenuFind();
		expect(findBar(container)).toBeTruthy();
		await typeQuery(container, 'zebra');

		await waitForCount(container, `1 of ${TOTAL}`);
		expect(currentMarkIndex(container)).toBe(0);
	});
});
