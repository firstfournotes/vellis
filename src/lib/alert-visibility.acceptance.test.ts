/**
 * 要件#90 の受け入れテスト(docs/requirements/req-90.md)— 表示の設定の純モデルと永続化(unit 層)
 * AC-90-1(トグルの規則・フロントの定数)・AC-90-2(印のまとめ方と札の文言の純関数)・AC-90-3(畳んだ形の要約の純関数)・
 * AC-90-7(アプリ全体で覚える・全部の窓に効く=localStorage と storage イベント・Rust への知らせ)
 *
 * 「GitHub Alerts の枠を、画面の操作で隠す・出す・折り畳む」のうち、DOM を持たない部分を判定する。
 * 面の配線(ProseMirror)は `src/components/MarkdownEditor.alerts.wiring.test.ts`、読み取り専用の描画は
 * `src/components/Viewer.alerts-readonly.wiring.test.ts`、Rust のメニューは `src-tauri/tests/acceptance_req90.rs`、
 * 実機は `tests/e2e/specs/req90-gate.e2e.ts`。
 *
 * ## 確定契約(implementer はこれに従う。新規 `src/lib/alert-visibility.ts`。コード行に CJK を書かない=AC-51-1)
 *
 * ```ts
 * // --- 種類と設定の形(契約1・7。true = 出す)
 * export const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;   // 要件15 の 5 種・この順
 * export type AlertKind = (typeof ALERT_KINDS)[number];
 * export type AlertVisibility = Readonly<Record<AlertKind, boolean>>;
 * export const ALL_ALERTS_SHOWN: AlertVisibility;                      // 既定=全部出す
 * export function isAlertKind(value: unknown): value is AlertKind;
 * export function alertKindLabel(kind: AlertKind): string;              // 札の種類名=大文字 'NOTE' / 'TIP' / 'IMPORTANT' / 'WARNING' / 'CAUTION'
 * export function isHidden(v: AlertVisibility, kind: AlertKind): boolean;
 * export function anyShown(v: AlertVisibility): boolean;
 * export function allHidden(v: AlertVisibility): boolean;
 * export function showAll(): AlertVisibility;
 * export function hideAll(): AlertVisibility;
 * export function toggleAll(v: AlertVisibility): AlertVisibility;      // どれか 1 種類でも出ていれば hideAll、全部隠れていれば showAll(契約1)
 * export function toggleKind(v: AlertVisibility, kind: AlertKind): AlertVisibility;   // その種類だけ反転(ほかは不変・入力は変えない)
 *
 * // --- 保存の形(契約7。localStorage のキーと値= JSON `{"note":true,…}` の 5 キー)
 * export const ALERT_VISIBILITY_STORAGE_KEY = 'vellis.alerts';
 * export function serializeAlertVisibility(v: AlertVisibility): string;       // JSON.stringify で 5 キー(ALERT_KINDS の順)
 * export function parseAlertVisibility(raw: string | null): AlertVisibility;  // null・壊れた JSON・配列・非オブジェクト → 全部出す。
 *                                                                              // キーが無い・boolean でない種類は true(出す)。余分なキーは捨てる
 *
 * // --- イベント名(src-tauri/src/menu.rs の同名 pub const と同綴り)
 * export const MENU_ALERTS_SHOW_ALL_EVENT = 'menu_alerts_show_all';       // Rust → 前面の窓(payload なし)
 * export const MENU_ALERTS_HIDE_ALL_EVENT = 'menu_alerts_hide_all';       // Rust → 前面の窓(payload なし)
 * export const MENU_ALERTS_TOGGLE_KIND_EVENT = 'menu_alerts_toggle_kind'; // Rust → 前面の窓(payload = 種類の文字列 'note' など)
 * export const ALERTS_STATE_EVENT = 'alerts_state';                       // 窓 → Rust { label, visibility }(チェック印と Show All / Hide All の有効)
 *
 * // --- 印(契約2)の純関数
 * export const ALERT_MARKER_CLASS = 'vellis-alert-marker';
 * export interface HiddenAlertGroup { start: number; end: number; counts: ReadonlyArray<readonly [AlertKind, number]> }
 * //   kinds[i] = 最上位ブロック i のアラートの種類(アラートでないブロックは null)。隠す種類の枠が続く区間(間に null も
 * //   出ている枠も無い)を 1 つの印にまとめる。[start, end) はブロックの番号。counts は**その区間で最初に現れた順**(文書の順)
 * export function groupHiddenAlerts(kinds: ReadonlyArray<AlertKind | null>, v: AlertVisibility): HiddenAlertGroup[];
 * export function markerLabel(counts: HiddenAlertGroup['counts']): string;    // 'NOTE 2' / 'NOTE 1 · WARNING 1'(区切りは ' · ' = U+00B7)
 * export function markerCounts(counts: HiddenAlertGroup['counts']): string;   // 'note:2' / 'note:1,warning:1'(data-alert-counts の値)
 *
 * // --- 畳んだ形(契約3)の要約
 * export const ALERT_SUMMARY_MAX_CHARS = 60;
 * export function alertSummary(bodyText: string): string;   // 空白(改行を含む)を 1 つの空白に潰して trim。60 字を超えるなら語の境目で切って '…' を足す
 *                                                            // (結果は 61 字以内)。空なら ''
 *
 * // --- 覚える・配る(契約7)
 * export function currentAlertVisibility(): AlertVisibility;         // 今の値(読み込む前は ALL_ALERTS_SHOWN)
 * export function loadAlertVisibility(): AlertVisibility;            // localStorage を読んで今の値にして返す(保存はし直さない)
 * export function applyAlertVisibility(next: AlertVisibility): void; // 今の値にして localStorage に書き、購読者に知らせ、announceAlertVisibility を呼ぶ
 * export function subscribeAlertVisibility(fn: (v: AlertVisibility) => void): () => void;   // 値が変わるたび。戻り値で解除
 * export async function announceAlertVisibility(v: AlertVisibility): Promise<void>;        // getCurrentWindow().emit(ALERTS_STATE_EVENT, { label, visibility: v })。Tauri の外では何もしない
 * export async function registerAlertVisibilityListeners(): Promise<() => void>;
 * //   $lib/events の listen で 3 つのイベントを購読し、受けたら applyAlertVisibility(showAll / hideAll / toggleKind)。
 * //   toggleKind の payload が 5 種でなければ何もしない。window の 'storage' イベント(key = ALERT_VISIBILITY_STORAGE_KEY)で
 * //   今の値を newValue に合わせて購読者に知らせる(他の窓の選択に追従。保存はし直さなくてよい)。登録の直後に 1 回
 * //   announceAlertVisibility(現在値)(起動時のチェック印)。戻り値は全部を解除する関数
 * ```
 *
 * - `src/routes/+page.svelte` は `$lib/alert-visibility` を import し、`loadAlertVisibility(` と `registerAlertVisibilityListeners(` を呼ぶ
 *   (ui-chrome と同じ家風。窓に面が無くても設定の受け手がいる)
 * - 印の見た目を置く Markdown の CSS(`src/styles/markdown.css`)の `@media print` に、本文の中の `.vellis-alert-marker` を `display: none` に
 *   する規則がある(契約6=印は刷らない)。`src/styles/print.css` は変えない(AC-56-16 の ui-invariants と CodeEditor.wiring が SHA-256 で固定)
 * - `src/styles/markdown.css` に `[data-alert-state="collapsed"]` を使う規則がある(契約3=畳んだ形の見た目。見た目そのものは機械では見ない)
 *
 * ## 判断の記録(test-writer 2026-11-26)
 * - 覚える場所は localStorage(キー `vellis.alerts`)。設定ファイル(settings.json)ではなく、View ▸ Toggle Full Width・
 *   Show Formatting Toolbar と同じ「窓の見た目の好み=アプリ全体で 1 値」の流儀に合わせた。他の窓は `storage` イベントで追従
 *   (契約7「切り替えるとすべての窓に効く」)
 * - 札の種類名は大文字(要件の例「NOTE 2」どおり)。複数の種類の順は文書で最初に現れた順(要件の例「NOTE 1 · WARNING 1」は
 *   どちらとも読めるが、読み手が開いたときに見える順と同じにした)。区切りは要件の例のまま ' · '
 * - 「最初の数語」は文字数(60)で切る。語数で切ると長い語・CJK で見た目の長さがそろわないため
 * - 全部の切り替え(Option + Command + A)は Rust 側で「Show All Alerts(全部隠れているときだけ有効)/ Hide All Alerts
 *   (どれか出ているときだけ有効)」の 2 項目に同じアクセラレータを付けて実現する(acceptance_req90.rs)。フロントの
 *   `toggleAll` は同じ規則の純モデル(読み取り専用の描画や将来のボタンが使う)
 *
 * ## 修正前に赤になる理由
 * - `src/lib/alert-visibility.ts` が無い(import で落ちる)・`menu.rs` に定数が無い・`+page.svelte` に呼び出しが無い・CSS の規則が無い
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Handler = (e: { payload: unknown }) => void;

const { registry, unlistenCalls, emitted } = vi.hoisted(() => ({
	registry: new Map<string, Handler[]>(),
	unlistenCalls: [] as string[],
	emitted: [] as Array<{ event: string; payload: unknown }>,
}));

vi.mock('$lib/events', () => ({
	listen: async (event: string, handler: Handler) => {
		const list = registry.get(event) ?? [];
		list.push(handler);
		registry.set(event, list);
		return () => {
			unlistenCalls.push(event);
			const cur = registry.get(event) ?? [];
			const at = cur.indexOf(handler);
			if (at >= 0) cur.splice(at, 1);
		};
	},
}));

vi.mock('@tauri-apps/api/window', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const fake = {
		label: 'main',
		emit: async (event: string, payload?: unknown) => {
			emitted.push({ event, payload });
		},
		onFocusChanged: async () => () => {},
		listen: async () => () => {},
	};
	return { ...actual, getCurrentWindow: () => fake };
});

import {
	ALERT_KINDS,
	ALERT_MARKER_CLASS,
	ALERT_SUMMARY_MAX_CHARS,
	ALERT_VISIBILITY_STORAGE_KEY,
	ALERTS_STATE_EVENT,
	ALL_ALERTS_SHOWN,
	MENU_ALERTS_HIDE_ALL_EVENT,
	MENU_ALERTS_SHOW_ALL_EVENT,
	MENU_ALERTS_TOGGLE_KIND_EVENT,
	alertKindLabel,
	alertSummary,
	allHidden,
	announceAlertVisibility,
	anyShown,
	applyAlertVisibility,
	currentAlertVisibility,
	groupHiddenAlerts,
	hideAll,
	isAlertKind,
	isHidden,
	loadAlertVisibility,
	markerCounts,
	markerLabel,
	parseAlertVisibility,
	registerAlertVisibilityListeners,
	serializeAlertVisibility,
	showAll,
	subscribeAlertVisibility,
	toggleAll,
	toggleKind,
	type AlertVisibility,
} from './alert-visibility';

const REPO_ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');
const menuRs = () => read('src-tauri/src/menu.rs');

function rustConst(name: string): string | undefined {
	return menuRs().match(new RegExp(`pub const ${name}: &str = "([^"]+)";`))?.[1];
}

/** 日本語(CJK)の検知(要件#35 / #51 と同じ定義)。 */
const CJK_PATTERN = /[　-〿぀-ヿ一-鿿＀-￯]/;

const v = (shown: Partial<Record<(typeof ALERT_KINDS)[number], boolean>>): AlertVisibility =>
	({ note: true, tip: true, important: true, warning: true, caution: true, ...shown }) as AlertVisibility;

async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise<void>((r) => setTimeout(r, 0));
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fire(event: string, payload: unknown = null): void {
	const handlers = registry.get(event) ?? [];
	expect(handlers.length, `${event} が listen されていること`).toBeGreaterThan(0);
	for (const h of handlers) h({ payload });
}

beforeEach(() => {
	registry.clear();
	unlistenCalls.length = 0;
	emitted.length = 0;
	localStorage.clear();
	applyAlertVisibility(ALL_ALERTS_SHOWN);
	localStorage.clear();
	emitted.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC-90-1 — 定数と種類(契約1)
// ---------------------------------------------------------------------------

describe('AC-90-1 定数(契約1・7): 5 種の順・保存キー・イベント名は menu.rs と同綴り・CJK なし', () => {
	test('ALERT_KINDS は要件15 の 5 種をこの順で持つ', () => {
		expect([...ALERT_KINDS]).toEqual(['note', 'tip', 'important', 'warning', 'caution']);
	});

	test('isAlertKind は 5 種だけ真(大文字・空・別の値・非文字列は偽)', () => {
		for (const k of ALERT_KINDS) expect(isAlertKind(k)).toBe(true);
		for (const bad of ['NOTE', 'Note', '', 'info', 'foo', null, undefined, 1, {}]) expect(isAlertKind(bad)).toBe(false);
	});

	test("札の種類名は大文字('NOTE' …)", () => {
		expect(ALERT_KINDS.map((k) => alertKindLabel(k))).toEqual(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']);
	});

	test("保存キーは 'vellis.alerts'・印の class は 'vellis-alert-marker'・要約は 60 字", () => {
		expect(ALERT_VISIBILITY_STORAGE_KEY).toBe('vellis.alerts');
		expect(ALERT_MARKER_CLASS).toBe('vellis-alert-marker');
		expect(ALERT_SUMMARY_MAX_CHARS).toBe(60);
	});

	test('4 つのイベント名は値固定で、menu.rs の同名 pub const と同じ', () => {
		expect(MENU_ALERTS_SHOW_ALL_EVENT).toBe('menu_alerts_show_all');
		expect(MENU_ALERTS_HIDE_ALL_EVENT).toBe('menu_alerts_hide_all');
		expect(MENU_ALERTS_TOGGLE_KIND_EVENT).toBe('menu_alerts_toggle_kind');
		expect(ALERTS_STATE_EVENT).toBe('alerts_state');
		expect(rustConst('MENU_ALERTS_SHOW_ALL_EVENT')).toBe(MENU_ALERTS_SHOW_ALL_EVENT);
		expect(rustConst('MENU_ALERTS_HIDE_ALL_EVENT')).toBe(MENU_ALERTS_HIDE_ALL_EVENT);
		expect(rustConst('MENU_ALERTS_TOGGLE_KIND_EVENT')).toBe(MENU_ALERTS_TOGGLE_KIND_EVENT);
		expect(rustConst('ALERTS_STATE_EVENT')).toBe(ALERTS_STATE_EVENT);
	});

	test('文言・キー・class に CJK を含まない(要件#51)', () => {
		for (const s of [
			ALERT_VISIBILITY_STORAGE_KEY,
			ALERT_MARKER_CLASS,
			MENU_ALERTS_SHOW_ALL_EVENT,
			MENU_ALERTS_HIDE_ALL_EVENT,
			MENU_ALERTS_TOGGLE_KIND_EVENT,
			ALERTS_STATE_EVENT,
			...ALERT_KINDS.map((k) => alertKindLabel(k)),
			markerLabel([['note', 2]]),
		]) {
			expect(s).not.toMatch(CJK_PATTERN);
		}
	});
});

// ---------------------------------------------------------------------------
// AC-90-1 — 全部の切り替えの規則・種類ごと(契約1)
// ---------------------------------------------------------------------------

describe('AC-90-1 toggleAll(契約1): どれか 1 種類でも出ていれば全部を隠し、全部が隠れていれば全部を出す', () => {
	test('既定(全部出す)→ 全部隠す', () => {
		expect(toggleAll(ALL_ALERTS_SHOWN)).toEqual(v({ note: false, tip: false, important: false, warning: false, caution: false }));
	});

	test('1 種類だけ出ている → 全部隠す(出ているものを隠すだけではない)', () => {
		const only = v({ note: false, tip: false, important: false, caution: false }); // warning だけ出ている
		expect(toggleAll(only)).toEqual(hideAll());
	});

	test('全部隠れている → 全部出す', () => {
		expect(toggleAll(hideAll())).toEqual(showAll());
		expect(showAll()).toEqual(ALL_ALERTS_SHOWN);
	});

	test('anyShown / allHidden / isHidden', () => {
		expect(anyShown(ALL_ALERTS_SHOWN)).toBe(true);
		expect(allHidden(ALL_ALERTS_SHOWN)).toBe(false);
		expect(anyShown(hideAll())).toBe(false);
		expect(allHidden(hideAll())).toBe(true);
		const one = v({ tip: false });
		expect(anyShown(one)).toBe(true);
		expect(allHidden(one)).toBe(false);
		expect(isHidden(one, 'tip')).toBe(true);
		expect(isHidden(one, 'note')).toBe(false);
	});

	test('toggleKind はその種類だけ反転し、入力を変えない(2 回で元)', () => {
		const base = ALL_ALERTS_SHOWN;
		const next = toggleKind(base, 'warning');
		expect(next).toEqual(v({ warning: false }));
		expect(base).toEqual(ALL_ALERTS_SHOWN);
		expect(toggleKind(next, 'warning')).toEqual(ALL_ALERTS_SHOWN);
		expect(toggleKind(toggleKind(next, 'note'), 'caution')).toEqual(v({ warning: false, note: false, caution: false }));
	});
});

// ---------------------------------------------------------------------------
// AC-90-7 — 保存の形(契約7)
// ---------------------------------------------------------------------------

describe('AC-90-7 serialize / parse(契約7): JSON の 5 キー・壊れた値は全部出す', () => {
	test('round trip: 5 キーの JSON で、ALERT_KINDS の順', () => {
		const value = v({ note: false, caution: false });
		const raw = serializeAlertVisibility(value);
		expect(JSON.parse(raw)).toEqual({ note: false, tip: true, important: true, warning: true, caution: false });
		expect(Object.keys(JSON.parse(raw))).toEqual([...ALERT_KINDS]);
		expect(parseAlertVisibility(raw)).toEqual(value);
	});

	test('null・壊れた JSON・配列・文字列・数値 → 全部出す', () => {
		for (const raw of [null, '', '{', '[]', '"x"', '1', 'null', '[1,2]']) {
			expect(parseAlertVisibility(raw), `raw=${JSON.stringify(raw)}`).toEqual(ALL_ALERTS_SHOWN);
		}
	});

	test('キーが無い・boolean でない種類は出す。余分なキーは捨てる', () => {
		const parsed = parseAlertVisibility('{"note":false,"tip":"no","foo":false,"warning":0}');
		expect(parsed).toEqual(v({ note: false }));
		expect(Object.keys(parsed).sort()).toEqual([...ALERT_KINDS].sort());
	});
});

// ---------------------------------------------------------------------------
// AC-90-2 — 印のまとめ方と札の文言(契約2)
// ---------------------------------------------------------------------------

describe('AC-90-2 groupHiddenAlerts(契約2): 続けて隠れた枠(間に地の文が無い)を 1 つの印に', () => {
	// 台本のような並び: 見出し / 地の文 / NOTE / TIP / 地の文 / WARNING / NOTE / WARNING / 地の文
	const KINDS = [null, null, 'note', 'tip', null, 'warning', 'note', 'warning', null] as const;

	test('何も隠していなければ印は無い', () => {
		expect(groupHiddenAlerts(KINDS, ALL_ALERTS_SHOWN)).toEqual([]);
	});

	test('NOTE だけ隠す: 間に出ている TIP があるので 2 つの印(NOTE 1 ずつ)', () => {
		expect(groupHiddenAlerts(KINDS, v({ note: false }))).toEqual([
			{ start: 2, end: 3, counts: [['note', 1]] },
			{ start: 6, end: 7, counts: [['note', 1]] },
		]);
	});

	test('NOTE と WARNING を隠す: 5〜7 は続いているので 1 つの印(文書で最初に現れた順= WARNING 2 · NOTE 1)', () => {
		expect(groupHiddenAlerts(KINDS, v({ note: false, warning: false }))).toEqual([
			{ start: 2, end: 3, counts: [['note', 1]] },
			{ start: 5, end: 8, counts: [['warning', 2], ['note', 1]] },
		]);
	});

	test('全部隠す: 2〜3 と 5〜7 の 2 つの印(間の地の文で切れる)', () => {
		expect(groupHiddenAlerts(KINDS, hideAll())).toEqual([
			{ start: 2, end: 4, counts: [['note', 1], ['tip', 1]] },
			{ start: 5, end: 8, counts: [['warning', 2], ['note', 1]] },
		]);
	});

	test('文書の先頭・末尾の枠も印になる。アラートの無い文書は空', () => {
		expect(groupHiddenAlerts(['tip', null, 'tip'], v({ tip: false }))).toEqual([
			{ start: 0, end: 1, counts: [['tip', 1]] },
			{ start: 2, end: 3, counts: [['tip', 1]] },
		]);
		expect(groupHiddenAlerts([null, null], hideAll())).toEqual([]);
		expect(groupHiddenAlerts([], hideAll())).toEqual([]);
	});

	test("markerLabel: 'NOTE 2' / 'NOTE 1 · WARNING 1'(区切りは ' · ')・markerCounts: 'note:2' / 'note:1,warning:1'", () => {
		expect(markerLabel([['note', 2]])).toBe('NOTE 2');
		expect(markerLabel([['note', 1], ['warning', 1]])).toBe('NOTE 1 · WARNING 1');
		expect(markerLabel([['warning', 2], ['note', 1]])).toBe('WARNING 2 · NOTE 1');
		expect(markerCounts([['note', 2]])).toBe('note:2');
		expect(markerCounts([['note', 1], ['warning', 1]])).toBe('note:1,warning:1');
	});
});

// ---------------------------------------------------------------------------
// AC-90-3 — 畳んだ形の要約(契約3)
// ---------------------------------------------------------------------------

describe('AC-90-3 alertSummary(契約3): 中身の最初の数語を 1 行で', () => {
	test('短い本文はそのまま(前後の空白は落とす)', () => {
		expect(alertSummary('  Camera: slow zoom on the desk.  ')).toBe('Camera: slow zoom on the desk.');
	});

	test('改行・連続する空白は 1 つの空白に(1 行で出す)', () => {
		expect(alertSummary('Camera: slow zoom\non the desk.\n\nSecond   paragraph.')).toBe('Camera: slow zoom on the desk. Second paragraph.');
	});

	test('60 字を超えるなら語の境目で切って … を足す(61 字以内・語の途中で切らない)', () => {
		const words = Array.from({ length: 30 }, (_, i) => `word${i}`); // 'word0 word1 …' = 190 字ほど
		const text = words.join(' ');
		const out = alertSummary(text);
		expect(out.endsWith('…')).toBe(true);
		expect(out.length).toBeLessThanOrEqual(ALERT_SUMMARY_MAX_CHARS + 1);
		const head = out.slice(0, -1);
		expect(head.length).toBeGreaterThan(0);
		expect(text.startsWith(head)).toBe(true);
		// 語の境目: 切った直後の原文の文字は空白(語の途中ではない)
		expect(text[head.trimEnd().length]).toBe(' ');
	});

	test('ちょうど 60 字は切らない・空は空', () => {
		const exact = 'a'.repeat(60);
		expect(alertSummary(exact)).toBe(exact);
		expect(alertSummary('')).toBe('');
		expect(alertSummary('   \n  ')).toBe('');
	});
});

// ---------------------------------------------------------------------------
// AC-90-7 — 覚える・配る(契約7)
// ---------------------------------------------------------------------------

describe('AC-90-7 覚える(契約7): applyAlertVisibility は localStorage に書き、購読者に知らせ、Rust に知らせる', () => {
	test('既定は全部出す(読み込む前)', () => {
		expect(currentAlertVisibility()).toEqual(ALL_ALERTS_SHOWN);
	});

	test('apply → current・localStorage(JSON)・購読者・alerts_state の emit({ label, visibility })', async () => {
		const seen: AlertVisibility[] = [];
		const off = subscribeAlertVisibility((x) => seen.push(x));
		const next = v({ note: false });
		applyAlertVisibility(next);
		await flush();
		expect(currentAlertVisibility()).toEqual(next);
		expect(parseAlertVisibility(localStorage.getItem(ALERT_VISIBILITY_STORAGE_KEY))).toEqual(next);
		expect(seen).toEqual([next]);
		const state = emitted.filter((e) => e.event === ALERTS_STATE_EVENT);
		expect(state.length).toBeGreaterThanOrEqual(1);
		expect(state.at(-1)!.payload).toEqual({ label: 'main', visibility: next });
		off();
		applyAlertVisibility(ALL_ALERTS_SHOWN);
		expect(seen, '解除の後は知らされない').toHaveLength(1);
	});

	test('loadAlertVisibility は localStorage の値を今の値にして返す(保存はし直さない・壊れていれば全部出す)', () => {
		localStorage.setItem(ALERT_VISIBILITY_STORAGE_KEY, serializeAlertVisibility(v({ warning: false, tip: false })));
		const setSpy = vi.spyOn(Storage.prototype, 'setItem');
		expect(loadAlertVisibility()).toEqual(v({ warning: false, tip: false }));
		expect(currentAlertVisibility()).toEqual(v({ warning: false, tip: false }));
		expect(setSpy).not.toHaveBeenCalled();
		localStorage.setItem(ALERT_VISIBILITY_STORAGE_KEY, '{broken');
		expect(loadAlertVisibility()).toEqual(ALL_ALERTS_SHOWN);
	});

	test('announceAlertVisibility は alerts_state に { label, visibility } を送る', async () => {
		await announceAlertVisibility(hideAll());
		expect(emitted.at(-1)).toEqual({ event: ALERTS_STATE_EVENT, payload: { label: 'main', visibility: hideAll() } });
	});
});

describe('AC-90-7・AC-90-1 registerAlertVisibilityListeners(契約1・7): メニューの 3 イベントと他の窓の storage に追従', () => {
	test('3 つのイベントを $lib/events の listen で購読し、登録の直後に現在値を alerts_state で知らせる', async () => {
		const off = await registerAlertVisibilityListeners();
		for (const ev of [MENU_ALERTS_SHOW_ALL_EVENT, MENU_ALERTS_HIDE_ALL_EVENT, MENU_ALERTS_TOGGLE_KIND_EVENT]) {
			expect(registry.get(ev)?.length ?? 0, `${ev} を購読`).toBeGreaterThan(0);
		}
		await flush();
		const state = emitted.filter((e) => e.event === ALERTS_STATE_EVENT);
		expect(state.length, '起動時のチェック印のために現在値を 1 回知らせる').toBeGreaterThanOrEqual(1);
		expect(state.at(-1)!.payload).toEqual({ label: 'main', visibility: ALL_ALERTS_SHOWN });
		off();
	});

	test('hide_all → 全部隠す・show_all → 全部出す(localStorage と購読者も)', async () => {
		const seen: AlertVisibility[] = [];
		const unsub = subscribeAlertVisibility((x) => seen.push(x));
		const off = await registerAlertVisibilityListeners();
		fire(MENU_ALERTS_HIDE_ALL_EVENT);
		await flush();
		expect(currentAlertVisibility()).toEqual(hideAll());
		expect(parseAlertVisibility(localStorage.getItem(ALERT_VISIBILITY_STORAGE_KEY))).toEqual(hideAll());
		fire(MENU_ALERTS_SHOW_ALL_EVENT);
		await flush();
		expect(currentAlertVisibility()).toEqual(ALL_ALERTS_SHOWN);
		expect(seen).toEqual([hideAll(), ALL_ALERTS_SHOWN]);
		off();
		unsub();
	});

	test("toggle_kind の payload 'warning' → warning だけ反転。もう一度で戻る。5 種でない payload は何もしない", async () => {
		const off = await registerAlertVisibilityListeners();
		fire(MENU_ALERTS_TOGGLE_KIND_EVENT, 'warning');
		await flush();
		expect(currentAlertVisibility()).toEqual(v({ warning: false }));
		fire(MENU_ALERTS_TOGGLE_KIND_EVENT, 'note');
		await flush();
		expect(currentAlertVisibility()).toEqual(v({ warning: false, note: false }));
		fire(MENU_ALERTS_TOGGLE_KIND_EVENT, 'warning');
		await flush();
		expect(currentAlertVisibility()).toEqual(v({ note: false }));
		const before = localStorage.getItem(ALERT_VISIBILITY_STORAGE_KEY);
		const emittedBefore = emitted.length;
		for (const bad of ['NOTE', 'foo', '', null, undefined, 3, { kind: 'note' }]) fire(MENU_ALERTS_TOGGLE_KIND_EVENT, bad);
		await flush();
		expect(currentAlertVisibility()).toEqual(v({ note: false }));
		expect(localStorage.getItem(ALERT_VISIBILITY_STORAGE_KEY)).toBe(before);
		expect(emitted.length, '不正な payload では知らせ直さない').toBe(emittedBefore);
		off();
	});

	test("他の窓の選択(storage イベント・key = 'vellis.alerts')に追従し、購読者に知らせる。別の key は無視", async () => {
		const seen: AlertVisibility[] = [];
		const unsub = subscribeAlertVisibility((x) => seen.push(x));
		const off = await registerAlertVisibilityListeners();
		window.dispatchEvent(
			new StorageEvent('storage', { key: ALERT_VISIBILITY_STORAGE_KEY, newValue: serializeAlertVisibility(v({ tip: false })) }),
		);
		await flush();
		expect(currentAlertVisibility()).toEqual(v({ tip: false }));
		expect(seen).toEqual([v({ tip: false })]);
		window.dispatchEvent(new StorageEvent('storage', { key: 'vellis.theme', newValue: 'dark' }));
		await flush();
		expect(currentAlertVisibility()).toEqual(v({ tip: false }));
		expect(seen).toHaveLength(1);
		// 消された(newValue null)→ 既定の全部出す
		window.dispatchEvent(new StorageEvent('storage', { key: ALERT_VISIBILITY_STORAGE_KEY, newValue: null }));
		await flush();
		expect(currentAlertVisibility()).toEqual(ALL_ALERTS_SHOWN);
		off();
		unsub();
	});

	test('戻り値で全部を解除する(listen の unlisten 3 回・storage にも追従しない)', async () => {
		const off = await registerAlertVisibilityListeners();
		off();
		expect(unlistenCalls.sort()).toEqual([MENU_ALERTS_HIDE_ALL_EVENT, MENU_ALERTS_SHOW_ALL_EVENT, MENU_ALERTS_TOGGLE_KIND_EVENT].sort());
		window.dispatchEvent(
			new StorageEvent('storage', { key: ALERT_VISIBILITY_STORAGE_KEY, newValue: serializeAlertVisibility(hideAll()) }),
		);
		await flush();
		expect(currentAlertVisibility()).toEqual(ALL_ALERTS_SHOWN);
	});
});

// ---------------------------------------------------------------------------
// 配線のソース走査(+page.svelte)と CSS(契約3・6)
// ---------------------------------------------------------------------------

describe('AC-90-7(ソース走査): +page.svelte が $lib/alert-visibility を読み込み・購読する', () => {
	test("import … from '$lib/alert-visibility' があり、loadAlertVisibility( と registerAlertVisibilityListeners( を呼ぶ", () => {
		const src = read('src/routes/+page.svelte');
		expect(src).toMatch(/from\s*'\$lib\/alert-visibility'/);
		expect(src).toContain('loadAlertVisibility(');
		expect(src).toContain('registerAlertVisibilityListeners(');
	});
});

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** `@media print { … }` の中身だけを連結して返す(print-transient-ui.acceptance.test.ts と同じ作り)。 */
function printMediaContents(css: string): string {
	const out: string[] = [];
	const re = /@media\s+print\s*\{/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(css)) !== null) {
		let depth = 1;
		let i = m.index + m[0].length;
		const start = i;
		for (; i < css.length && depth > 0; i++) {
			if (css[i] === '{') depth++;
			else if (css[i] === '}') depth--;
		}
		out.push(css.slice(start, i - 1));
	}
	return out.join('\n');
}

/** セレクタ → 宣言 の組(ネストしない規則だけ)。 */
function rulesOf(cssScope: string): Array<{ selector: string; declarations: string }> {
	const rules: Array<{ selector: string; declarations: string }> = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cssScope)) !== null) {
		const selector = m[1]!.trim();
		if (selector.startsWith('@')) continue;
		rules.push({ selector, declarations: m[2]! });
	}
	return rules;
}

// 2026-11-26 オーケストレーターの判断: print.css は AC-56-16(ui-invariants)と CodeEditor.wiring が SHA-256 で「変えない」と固定している
// (#851 でも同じ理由で print.css を変えなかった)。印の印刷での非表示は、印の見た目を置く markdown.css の @media print に置く。
describe('AC-90-6(CSS): markdown.css の @media print が本文の中の印(.vellis-alert-marker)を隠す(print.css は変えない)。AC-90-3(CSS): 畳んだ形の規則がある', () => {
	test('markdown.css: @media print の display: none の規則のどれかが article.viewer > div.markdown-body > div.vellis-alert-marker に当たり、本文の段落と .markdown-body 自身には当たらない', () => {
		const css = stripCssComments(read('src/styles/markdown.css'));
		const hiding = rulesOf(printMediaContents(css)).filter((r) => /display\s*:\s*none/i.test(r.declarations));
		expect(hiding.length).toBeGreaterThan(0);
		document.body.innerHTML = '';
		const article = document.createElement('article');
		article.className = 'viewer';
		const body = document.createElement('div');
		body.className = 'markdown-body';
		const marker = document.createElement('div');
		marker.className = ALERT_MARKER_CLASS;
		marker.setAttribute('data-testid', 'alert-marker');
		const p = document.createElement('p');
		p.textContent = 'dialogue';
		body.append(marker, p);
		article.append(body);
		document.body.append(article);
		const matchesAny = (el: Element) =>
			hiding.some((r) =>
				r.selector
					.split(/,(?![^(]*\))/)
					.map((s) => s.trim())
					.some((s) => {
						try {
							return el.matches(s);
						} catch {
							throw new Error(`jsdom が解釈できないセレクタ: ${s}`);
						}
					}),
			);
		expect(matchesAny(marker), '印は紙に載らない').toBe(true);
		expect(matchesAny(p), '本文の段落は紙に載る').toBe(false);
		expect(matchesAny(body), '.markdown-body 自身は隠さない').toBe(false);
		document.body.innerHTML = '';
	});

	test('print.css は触らない(印の規則を print.css に足さない=AC-56-16 の固定を保つ)', () => {
		const css = stripCssComments(read('src/styles/print.css'));
		expect(css).not.toContain(ALERT_MARKER_CLASS);
		expect(css).not.toContain('data-alert-state');
	});

	test('markdown.css に [data-alert-state="collapsed"] を使う規則がある(畳んだ枠は見出しと最初の数語を 1 行で)', () => {
		const css = stripCssComments(read('src/styles/markdown.css'));
		expect(css).toContain('[data-alert-state="collapsed"]');
	});
});
