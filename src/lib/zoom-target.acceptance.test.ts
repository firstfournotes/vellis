/**
 * 要件#63 の受け入れテスト(docs/requirements/req-63.md)— フロント層(判別・振り分け・保存)
 * 「エクスプローラー(ツリー)の文字も拡大縮小できる。操作はボディ側と同じ(Command + Plus /
 * Minus / 0)で、どちらを拡大するかは自動で判別する。タブで分けたときはタブごと」
 *
 * 本ファイルの持ち場(unit プロジェクト):
 * - AC-63-1  判別の真理値表 `resolveZoomTarget`(契約3)
 * - AC-63-2  最後の領域の更新 `nextPointerRegion`(契約3)
 * - AC-63-3  領域の目印 `regionOf`(契約3・JSDOM で要素を組む)
 * - AC-63-4  振り分け `routeZoomCommand`(契約3・4)
 * - AC-63-5  倍率の値の共用(契約5)= 段の歩行+ `zoom-target.ts` のソース走査
 * - AC-63-6  保存キーの分離 `EXPLORER_ZOOM_STORAGE_KEY`(契約6)
 * - AC-63-7  保存と読み込み `saveExplorerZoom` / `loadExplorerZoom`(契約6)
 * - AC-63-8  保存の独立(本文のキーとツリーのキーが互いを書かない・契約6)
 * - AC-63-10 本文側の目印= `+page.svelte` の `.viewer-stack` に `data-zoom-region="viewer"`(ソース走査)
 * - AC-63-11 窓どうしで同期しない= 4 ファイルのコード行に `storage` イベントの購読が無い(ソース走査)
 * - AC-63-13 の後半= `print.css` の `@media print` で `.explorer` が `display: none`(本要件で新たに固定)
 *
 * 別ファイルの持ち場:
 * - AC-63-9  `Explorer.svelte` のマウント → `src/components/Explorer.zoom.wiring.test.ts`
 * - AC-63-12 View メニューの項目列と `MENU_ZOOM_` 定数 → `src-tauri/tests/acceptance_req63.rs`
 * - AC-63-13 前半・AC-63-14(既存テストが無改変で緑)→ reviewer 照合(テストは書かない)
 *
 * 人間ゲート 1〜7 に送った範囲(本ファイルでは判定しない): ポインタの実際の出入りで対象が
 * 切り替わる手応え・メニューをマウスで押したときの対象・CSS `zoom` の見た目と当たり判定・
 * タブごとの独立・50% / 300% での崩れ・再起動と新しい窓での保持。
 *
 * ## 確定契約(公開 API・implementer はこれに従う=本テストが前提にする名前と型)
 *
 * ```ts
 * // src/lib/zoom-target.ts(新規)。倍率の定数と純関数は './zoom' から import して共用する
 * // (置き場を zoom.ts に足して zoom-target.ts から再 export する形も可。その場合も
 * // 本ファイルの import パス './zoom-target' で解決すること)。
 * export type ZoomRegion = 'explorer' | 'viewer';
 *
 * /** hit が null(どちらでもない・窓の外)なら prev を保つ。それ以外は hit。 *\/
 * export function nextPointerRegion(prev: ZoomRegion | null, hit: ZoomRegion | null): ZoomRegion | null;
 *
 * /** region === 'explorer' && explorerShown のときだけ 'explorer'。それ以外は 'viewer'。 *\/
 * export function resolveZoomTarget(input: { region: ZoomRegion | null; explorerShown: boolean }): ZoomRegion;
 *
 * /** element から closest('[data-zoom-region]') をたどる。値が explorer / viewer 以外・見つからない・null は null。 *\/
 * export function regionOf(element: Element | null): ZoomRegion | null;
 *
 * export type ZoomRouteInput = {
 *   command: ZoomCommand;            // './zoom' の 'in' | 'out' | 'reset'
 *   target: ZoomRegion;              // resolveZoomTarget の結果
 *   viewerZoomable: boolean;         // 要件#36 契約①⑧の判定(isZoomTarget)。explorer には効かない
 *   viewerLevel: number;
 *   explorerLevel: number;
 * };
 * export type ZoomRouteResult = {
 *   viewerLevel: number;
 *   explorerLevel: number;
 *   changed: ZoomRegion | null;      // 変わった側。null なら保存も通知もしない
 * };
 * export function routeZoomCommand(input: ZoomRouteInput): ZoomRouteResult;
 *   // 変わった側の値は applyZoomCommand(command, 元の値)(./zoom の既存 export)と一致する。
 *   // 返り値はちょうど { viewerLevel, explorerLevel, changed } の 3 キー(toEqual で固定)。
 *
 * export const EXPLORER_ZOOM_STORAGE_KEY = 'vellis.explorer-zoom';
 * export function saveExplorerZoom(level: number): void;   // saveZoom と同じ規則(非有限は書かない)
 * export function loadExplorerZoom(): number;              // loadZoom と同じ規則(未保存・解釈不能→100・有限数は normalizeZoom)
 * ```
 *
 * ソース走査が前提にする形:
 * - `src/lib/zoom-target.ts` のコード行(コメント除く)に `from './zoom'` または `from '$lib/zoom'`
 *   があり、数値リテラル 50 / 300 / 10 / 100 が現れない
 * - `src/routes/+page.svelte` の `class="viewer-stack"` を持つ開始タグに `data-zoom-region="viewer"`
 * - `zoom.ts` / `zoom-target.ts` / `+page.svelte` / `Explorer.svelte` のコード行に
 *   `addEventListener('storage'` / `addEventListener("storage"` / `onstorage` が無い
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PANE_WIDTH_STORAGE_KEY } from './pane-resize';
import {
	DEFAULT_ZOOM,
	MAX_ZOOM,
	MIN_ZOOM,
	ZOOM_STEP,
	ZOOM_STORAGE_KEY,
	applyZoomCommand,
	loadZoom,
	normalizeZoom,
	saveZoom,
	type ZoomCommand,
} from './zoom';
import {
	EXPLORER_ZOOM_STORAGE_KEY,
	loadExplorerZoom,
	nextPointerRegion,
	regionOf,
	resolveZoomTarget,
	routeZoomCommand,
	saveExplorerZoom,
	type ZoomRegion,
} from './zoom-target';

const REGIONS: readonly (ZoomRegion | null)[] = ['explorer', 'viewer', null];
const COMMANDS: readonly ZoomCommand[] = ['in', 'out', 'reset'];

beforeEach(() => {
	localStorage.clear();
});

// ---------------------------------------------------------------------------
// AC-63-1 — resolveZoomTarget の真理値表(契約3)
// ---------------------------------------------------------------------------

describe('AC-63-1: resolveZoomTarget truth table (contract 3)', () => {
	test('all 6 combinations of region x explorerShown', () => {
		const table: [ZoomRegion | null, boolean, ZoomRegion][] = [
			['explorer', true, 'explorer'],
			['explorer', false, 'viewer'],
			['viewer', true, 'viewer'],
			['viewer', false, 'viewer'],
			[null, true, 'viewer'],
			[null, false, 'viewer'],
		];
		const actual = table.map(([region, explorerShown]) => [
			region,
			explorerShown,
			resolveZoomTarget({ region, explorerShown }),
		]);
		expect(actual).toEqual(table);
	});

	test('only explorer + shown yields explorer (exactly one of the 6 rows)', () => {
		let explorerRows = 0;
		for (const region of REGIONS) {
			for (const explorerShown of [true, false]) {
				if (resolveZoomTarget({ region, explorerShown }) === 'explorer') explorerRows += 1;
			}
		}
		expect(explorerRows).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC-63-2 — nextPointerRegion(契約3)
// ---------------------------------------------------------------------------

describe('AC-63-2: nextPointerRegion keeps prev on null hit, otherwise takes hit (contract 3)', () => {
	test('all 9 combinations of prev x hit', () => {
		const rows: { prev: ZoomRegion | null; hit: ZoomRegion | null; next: ZoomRegion | null }[] = [];
		for (const prev of REGIONS) {
			for (const hit of REGIONS) {
				rows.push({ prev, hit, next: nextPointerRegion(prev, hit) });
			}
		}
		const expected = rows.map(({ prev, hit }) => ({ prev, hit, next: hit === null ? prev : hit }));
		expect(rows).toEqual(expected);
	});

	test('a sequence of pointer moves: enter explorer, leave the window, enter viewer, hit a divider', () => {
		let region: ZoomRegion | null = null;
		region = nextPointerRegion(region, 'explorer');
		expect(region).toBe('explorer');
		region = nextPointerRegion(region, null); // window left (menu bar)
		expect(region).toBe('explorer');
		region = nextPointerRegion(region, 'viewer');
		expect(region).toBe('viewer');
		region = nextPointerRegion(region, null); // pane divider / status bar
		expect(region).toBe('viewer');
	});
});

// ---------------------------------------------------------------------------
// AC-63-3 — regionOf(契約3・JSDOM で要素を組む)
// ---------------------------------------------------------------------------

/** `data-zoom-region` を付けた祖先の下に孫要素を組み、その孫を返す。 */
function descendantUnder(regionValue: string | null): HTMLElement {
	const root = document.createElement('div');
	if (regionValue !== null) root.setAttribute('data-zoom-region', regionValue);
	const middle = document.createElement('section');
	const leaf = document.createElement('span');
	middle.appendChild(leaf);
	root.appendChild(middle);
	document.body.appendChild(root);
	return leaf;
}

describe('AC-63-3: regionOf walks closest([data-zoom-region]) (contract 3)', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	test("descendant of data-zoom-region=\"explorer\" -> 'explorer'", () => {
		expect(regionOf(descendantUnder('explorer'))).toBe('explorer');
	});

	test("descendant of data-zoom-region=\"viewer\" -> 'viewer'", () => {
		expect(regionOf(descendantUnder('viewer'))).toBe('viewer');
	});

	test('element with no marked ancestor -> null', () => {
		expect(regionOf(descendantUnder(null))).toBe(null);
	});

	test('only an ancestor with another value ("other") -> null', () => {
		expect(regionOf(descendantUnder('other'))).toBe(null);
		expect(regionOf(descendantUnder(''))).toBe(null);
	});

	test('null -> null', () => {
		expect(regionOf(null)).toBe(null);
	});

	test('the marked element itself counts (closest includes the element)', () => {
		const aside = document.createElement('aside');
		aside.setAttribute('data-zoom-region', 'explorer');
		document.body.appendChild(aside);
		expect(regionOf(aside)).toBe('explorer');
	});

	test('does not read the attribute case-insensitively or with surrounding spaces', () => {
		expect(regionOf(descendantUnder('Explorer'))).toBe(null);
		expect(regionOf(descendantUnder(' viewer '))).toBe(null);
	});
});

// ---------------------------------------------------------------------------
// AC-63-4 — routeZoomCommand(契約3・4)
// ---------------------------------------------------------------------------

type RouteInput = Parameters<typeof routeZoomCommand>[0];

function route(input: RouteInput) {
	return routeZoomCommand(input);
}

describe('AC-63-4: routeZoomCommand moves only the target side (contracts 3, 4)', () => {
	test('target explorer changes explorerLevel only, whether or not the viewer is zoomable', () => {
		for (const viewerZoomable of [true, false]) {
			for (const command of COMMANDS) {
				const input: RouteInput = {
					command,
					target: 'explorer',
					viewerZoomable,
					viewerLevel: 200,
					explorerLevel: 150,
				};
				expect(route(input), `command=${command} viewerZoomable=${viewerZoomable}`).toEqual({
					viewerLevel: 200,
					explorerLevel: applyZoomCommand(command, 150),
					changed: 'explorer',
				});
			}
		}
	});

	test('target viewer with viewerZoomable=true changes viewerLevel only', () => {
		for (const command of COMMANDS) {
			const input: RouteInput = {
				command,
				target: 'viewer',
				viewerZoomable: true,
				viewerLevel: 200,
				explorerLevel: 150,
			};
			expect(route(input), `command=${command}`).toEqual({
				viewerLevel: applyZoomCommand(command, 200),
				explorerLevel: 150,
				changed: 'viewer',
			});
		}
	});

	test('target viewer with viewerZoomable=false changes nothing and does not fall back to explorer', () => {
		for (const command of COMMANDS) {
			const input: RouteInput = {
				command,
				target: 'viewer',
				viewerZoomable: false,
				viewerLevel: 200,
				explorerLevel: 150,
			};
			expect(route(input), `command=${command}`).toEqual({
				viewerLevel: 200,
				explorerLevel: 150,
				changed: null,
			});
		}
	});

	test('reset resets only the target side (explorer 150 / viewer 200)', () => {
		expect(
			route({ command: 'reset', target: 'explorer', viewerZoomable: true, viewerLevel: 200, explorerLevel: 150 }),
		).toEqual({ viewerLevel: 200, explorerLevel: DEFAULT_ZOOM, changed: 'explorer' });
		expect(
			route({ command: 'reset', target: 'viewer', viewerZoomable: true, viewerLevel: 200, explorerLevel: 150 }),
		).toEqual({ viewerLevel: DEFAULT_ZOOM, explorerLevel: 150, changed: 'viewer' });
	});

	test('at the bounds (300 in / 50 out / 100 reset) changed is null and both levels stay', () => {
		const bounds: [ZoomCommand, number][] = [
			['in', MAX_ZOOM],
			['out', MIN_ZOOM],
			['reset', DEFAULT_ZOOM],
		];
		for (const [command, level] of bounds) {
			expect(
				route({ command, target: 'explorer', viewerZoomable: true, viewerLevel: 120, explorerLevel: level }),
				`explorer ${command} at ${level}`,
			).toEqual({ viewerLevel: 120, explorerLevel: level, changed: null });
			expect(
				route({ command, target: 'viewer', viewerZoomable: true, viewerLevel: level, explorerLevel: 120 }),
				`viewer ${command} at ${level}`,
			).toEqual({ viewerLevel: level, explorerLevel: 120, changed: null });
		}
	});

	test('the changed value equals applyZoomCommand(command, previous) across the whole ladder', () => {
		for (let level = MIN_ZOOM; level <= MAX_ZOOM; level += ZOOM_STEP) {
			for (const command of COMMANDS) {
				const expected = applyZoomCommand(command, level);
				const ex = route({ command, target: 'explorer', viewerZoomable: false, viewerLevel: 70, explorerLevel: level });
				expect(ex.explorerLevel, `explorer ${command} from ${level}`).toBe(expected);
				expect(ex.viewerLevel).toBe(70);
				expect(ex.changed).toBe(expected === level ? null : 'explorer');
				const vw = route({ command, target: 'viewer', viewerZoomable: true, viewerLevel: level, explorerLevel: 70 });
				expect(vw.viewerLevel, `viewer ${command} from ${level}`).toBe(expected);
				expect(vw.explorerLevel).toBe(70);
				expect(vw.changed).toBe(expected === level ? null : 'viewer');
			}
		}
	});

	test('pure: the input object is not mutated', () => {
		const input: RouteInput = { command: 'in', target: 'explorer', viewerZoomable: true, viewerLevel: 100, explorerLevel: 100 };
		const snapshot = { ...input };
		route(input);
		expect(input).toEqual(snapshot);
	});
});

// ---------------------------------------------------------------------------
// AC-63-5 — 倍率の値の共用(契約5)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../..');
const SRC = (rel: string) => resolve(REPO_ROOT, rel);

// コード行だけを残す(行コメント・ブロックコメント・HTML コメントを落とす)。
function codeOnly(source: string): string {
	let out = '';
	let closing: '*/' | '-->' | null = null;
	for (const line of source.split('\n')) {
		let rest = line;
		let code = '';
		while (rest.length > 0) {
			if (closing !== null) {
				const close = rest.indexOf(closing);
				if (close === -1) {
					rest = '';
					break;
				}
				rest = rest.slice(close + closing.length);
				closing = null;
				continue;
			}
			const openers = [
				{ at: rest.indexOf('//'), kind: 'line' as const },
				{ at: rest.indexOf('/*'), kind: 'block' as const },
				{ at: rest.indexOf('<!--'), kind: 'html' as const },
			]
				.filter((o) => o.at !== -1)
				.sort((a, b) => a.at - b.at);
			if (openers.length === 0) {
				code += rest;
				break;
			}
			const first = openers[0]!;
			// `://` (URL in a string) is not a line comment.
			if (first.kind === 'line' && first.at > 0 && rest[first.at - 1] === ':') {
				code += rest.slice(0, first.at + 2);
				rest = rest.slice(first.at + 2);
				continue;
			}
			code += rest.slice(0, first.at);
			if (first.kind === 'line') {
				rest = '';
				break;
			}
			closing = first.kind === 'block' ? '*/' : '-->';
			rest = rest.slice(first.at + (first.kind === 'block' ? 2 : 4));
		}
		out += code + '\n';
	}
	return out;
}

function readCode(rel: string): string {
	return codeOnly(readFileSync(SRC(rel), 'utf8'));
}

describe('AC-63-5: the explorer ladder is the one from zoom.ts (contract 5)', () => {
	test('repeated explorer zoom-in from 50 lands exactly on 300 in 10% steps, then stops', () => {
		const ladder = [MIN_ZOOM];
		let level = MIN_ZOOM;
		for (let i = 0; i < 100; i += 1) {
			const r = route({ command: 'in', target: 'explorer', viewerZoomable: false, viewerLevel: 100, explorerLevel: level });
			if (r.changed === null) break;
			level = r.explorerLevel;
			ladder.push(level);
		}
		expect(ladder).toEqual(Array.from({ length: 26 }, (_, i) => 50 + i * 10));
		expect(level).toBe(MAX_ZOOM);
	});

	test('repeated explorer zoom-out from 300 lands exactly on 50 in 10% steps, then stops', () => {
		const ladder = [MAX_ZOOM];
		let level = MAX_ZOOM;
		for (let i = 0; i < 100; i += 1) {
			const r = route({ command: 'out', target: 'explorer', viewerZoomable: false, viewerLevel: 100, explorerLevel: level });
			if (r.changed === null) break;
			level = r.explorerLevel;
			ladder.push(level);
		}
		expect(ladder).toEqual(Array.from({ length: 26 }, (_, i) => 300 - i * 10));
		expect(level).toBe(MIN_ZOOM);
	});

	test('zoom-target.ts imports from zoom.ts and defines no zoom numeric literal of its own (source scan)', () => {
		const code = readCode('src/lib/zoom-target.ts');
		expect(code.trim().length, 'zoom-target.ts must have code').toBeGreaterThan(0);
		expect(
			/from\s+['"](\.\/zoom|\$lib\/zoom)['"]/.test(code),
			"zoom-target.ts must import from './zoom' (or '$lib/zoom')",
		).toBe(true);
		const literals = code.match(/(?<![\w.$-])(50|300|10|100)(?![\w.%])/g) ?? [];
		expect(literals, 'zoom-target.ts must not define 50 / 300 / 10 / 100 itself').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-63-6 — 保存キーの分離(契約6)
// ---------------------------------------------------------------------------

describe('AC-63-6: the explorer zoom storage key is separate (contract 6)', () => {
	test("EXPLORER_ZOOM_STORAGE_KEY === 'vellis.explorer-zoom'", () => {
		expect(EXPLORER_ZOOM_STORAGE_KEY).toBe('vellis.explorer-zoom');
	});

	test('differs from the viewer zoom key and the pane width key', () => {
		expect(ZOOM_STORAGE_KEY).toBe('vellis.viewer-zoom');
		expect(PANE_WIDTH_STORAGE_KEY).toBe('vellis.explorer-width');
		expect(EXPLORER_ZOOM_STORAGE_KEY).not.toBe(ZOOM_STORAGE_KEY);
		expect(EXPLORER_ZOOM_STORAGE_KEY).not.toBe(PANE_WIDTH_STORAGE_KEY);
	});
});

// ---------------------------------------------------------------------------
// AC-63-7 — saveExplorerZoom / loadExplorerZoom(契約6)
// ---------------------------------------------------------------------------

describe('AC-63-7: saveExplorerZoom / loadExplorerZoom (contract 6)', () => {
	test('stores a numeric string under the explorer key', () => {
		saveExplorerZoom(150);
		const raw = localStorage.getItem(EXPLORER_ZOOM_STORAGE_KEY);
		expect(raw).not.toBeNull();
		expect(Number(raw)).toBe(150);
	});

	test('save -> load round trip', () => {
		saveExplorerZoom(150);
		expect(loadExplorerZoom()).toBe(150);
	});

	test('overwrite keeps the last value (last-writer-wins)', () => {
		saveExplorerZoom(150);
		saveExplorerZoom(80);
		expect(loadExplorerZoom()).toBe(80);
	});

	test('unsaved -> 100', () => {
		expect(loadExplorerZoom()).toBe(DEFAULT_ZOOM);
	});

	test('non-numeric and empty stored values -> 100', () => {
		for (const raw of ['garbage', '', ' ', 'NaN', 'Infinity', '-Infinity', '{"zoom":200}']) {
			localStorage.setItem(EXPLORER_ZOOM_STORAGE_KEY, raw);
			expect(loadExplorerZoom(), `raw=${JSON.stringify(raw)}`).toBe(DEFAULT_ZOOM);
		}
	});

	test('finite values off the ladder are absorbed with normalizeZoom (320->300, 47->50, 123->120)', () => {
		for (const [raw, expected] of [
			['320', 300],
			['47', 50],
			['123', 120],
		] as const) {
			localStorage.setItem(EXPLORER_ZOOM_STORAGE_KEY, raw);
			expect(loadExplorerZoom(), `raw=${raw}`).toBe(expected);
			expect(expected).toBe(normalizeZoom(Number(raw)));
		}
	});

	test('non-finite values are not written (previous value survives)', () => {
		saveExplorerZoom(150);
		saveExplorerZoom(Number.NaN);
		expect(loadExplorerZoom()).toBe(150);
		saveExplorerZoom(Number.POSITIVE_INFINITY);
		expect(loadExplorerZoom()).toBe(150);
		expect(localStorage.getItem(EXPLORER_ZOOM_STORAGE_KEY)).toBe('150');
	});

	test('NaN on an empty store leaves it empty (-> 100)', () => {
		saveExplorerZoom(Number.NaN);
		expect(localStorage.getItem(EXPLORER_ZOOM_STORAGE_KEY)).toBeNull();
		expect(loadExplorerZoom()).toBe(DEFAULT_ZOOM);
	});

	test('a fresh module instance (new window / restart) reads the saved value', async () => {
		saveExplorerZoom(150);
		vi.resetModules();
		const fresh = await import('./zoom-target');
		expect(fresh.loadExplorerZoom()).toBe(150);
	});
});

// ---------------------------------------------------------------------------
// AC-63-8 — 保存の独立(契約6)
// ---------------------------------------------------------------------------

describe('AC-63-8: explorer and viewer zoom storage do not touch each other (contract 6)', () => {
	test('saveExplorerZoom(150) leaves the viewer key unsaved', () => {
		saveExplorerZoom(150);
		expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBeNull();
		expect(loadZoom()).toBe(DEFAULT_ZOOM);
	});

	test('saveExplorerZoom(150) leaves an existing viewer value untouched', () => {
		saveZoom(200);
		saveExplorerZoom(150);
		expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('200');
	});

	test('saveZoom(200) leaves the explorer key unsaved', () => {
		saveZoom(200);
		expect(localStorage.getItem(EXPLORER_ZOOM_STORAGE_KEY)).toBeNull();
		expect(loadExplorerZoom()).toBe(DEFAULT_ZOOM);
	});

	test('saveZoom(200) leaves an existing explorer value untouched', () => {
		saveExplorerZoom(150);
		saveZoom(200);
		expect(localStorage.getItem(EXPLORER_ZOOM_STORAGE_KEY)).toBe('150');
	});

	test('after saving both, each loader returns its own value', () => {
		saveExplorerZoom(150);
		saveZoom(200);
		expect(loadZoom()).toBe(200);
		expect(loadExplorerZoom()).toBe(150);
		expect(localStorage.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// AC-63-10 — 本文側の目印(契約3・ソース走査)
// ---------------------------------------------------------------------------

describe('AC-63-10: +page.svelte marks .viewer-stack with data-zoom-region="viewer" (contract 3)', () => {
	test('every start tag carrying class="viewer-stack" also carries data-zoom-region="viewer"', () => {
		const code = readCode('src/routes/+page.svelte');
		const tags = code.match(/<[a-zA-Z][^<>]*\bclass="viewer-stack"[^<>]*>/g) ?? [];
		expect(tags.length, '+page.svelte must keep an element with class="viewer-stack"').toBeGreaterThan(0);
		for (const tag of tags) {
			expect(tag, 'the .viewer-stack tag must carry data-zoom-region="viewer"').toMatch(
				/\bdata-zoom-region="viewer"/,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// AC-63-11 — 窓どうしで同期しない(契約7・ソース走査)
// ---------------------------------------------------------------------------

describe('AC-63-11: no storage-event subscription (contract 7)', () => {
	const FILES = [
		'src/lib/zoom.ts',
		'src/lib/zoom-target.ts',
		'src/routes/+page.svelte',
		'src/components/Explorer.svelte',
	];

	test.each(FILES)('%s has no addEventListener("storage") / onstorage on a code line', (rel) => {
		const code = readCode(rel);
		expect(code.trim().length, `${rel} must exist and have code`).toBeGreaterThan(0);
		expect(code).not.toMatch(/addEventListener\(\s*['"`]storage['"`]/);
		expect(code).not.toMatch(/\bonstorage\b/);
	});
});

// ---------------------------------------------------------------------------
// AC-63-13(後半)— print.css の @media print で .explorer が display: none(契約10)
// ---------------------------------------------------------------------------

/** `@media print { ... }` の中身だけ(ネスト対応)。zoom.acceptance.test.ts と同じ流儀。 */
function printMediaContents(css: string): string {
	let out = '';
	let i = 0;
	while (i < css.length) {
		const m = css.slice(i).match(/@media[^{]*\bprint\b[^{]*\{/);
		if (!m || m.index === undefined) break;
		let depth = 1;
		let j = i + m.index + m[0].length;
		const start = j;
		while (j < css.length && depth > 0) {
			if (css[j] === '{') depth += 1;
			else if (css[j] === '}') depth -= 1;
			j += 1;
		}
		out += css.slice(start, j);
		i = j;
	}
	return out;
}

describe('AC-63-13: print.css keeps .explorer hidden in @media print (contract 10)', () => {
	test('a rule whose selector list includes .explorer declares display: none', () => {
		const css = readFileSync(SRC('src/styles/print.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
		const contents = printMediaContents(css);
		expect(contents.length, '@media print scope must exist').toBeGreaterThan(0);
		const rules = [...contents.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
			selectors: m[1]!.split(',').map((s) => s.trim()),
			body: m[2]!,
		}));
		const explorerRules = rules.filter((r) => r.selectors.includes('.explorer'));
		expect(explorerRules.length, '@media print must have a rule selecting .explorer').toBeGreaterThan(0);
		const hidden = explorerRules.some((r) => /(^|;)\s*display\s*:\s*none(\s*!important)?\s*(;|$)/.test(r.body));
		expect(hidden, '.explorer must be display: none in @media print').toBe(true);
	});
});
