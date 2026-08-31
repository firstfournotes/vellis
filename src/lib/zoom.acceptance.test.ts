/**
 * 要件#36 の受け入れテスト(requirements.md #36)— フロント層
 * 「テキスト系ビューアの表示を拡大縮小できるズーム機能(⌘+ / ⌘− / ⌘0)」
 *
 * 契約(2026-08-30 由谷決定=Q2〜Q4・コードレビュー15件反映の改稿):
 * - ① 対象= FileType(markdown・text・html)のビューア本体のみ。本文中の画像・
 *   表・コードブロック・mermaid 図も一体で拡大縮小。対象外=SVG ソース表示・
 *   DiffView・指示ダイアログのプレビュー・画像/動画/PDF/3D の専用ビューア・
 *   Explorer 等の UI
 * - ③ 倍率=下限50%・上限300%・10%刻み・既定100%・Actual Size で 100% へ
 *   リセット(実装裁量ではなく契約値=acceptance で固定してよい)
 * - ④ 永続化=グローバル設定1値(localStorage・全窓共有=窓ごとの独立状態では
 *   ない。last-writer-wins は仕様)・新規窓と再起動に適用・他窓への即時反映の
 *   要否は実装裁量
 * - ⑤ 実装=フロント自前(zoom または transform 系)
 * - ⑥ HtmlViewer= buildSrcdoc へのズーム反映+ srcdoc 再生成で適用
 * - ⑦ 印刷= print.css にズーム無効化(リセット)を追加(現行 10pt 系の維持)
 * - ⑧ メニュー3項目は常時有効・非対象ビューアでは no-op。Actual Size は
 *   倍率リセット専用(ImageViewer の「実寸表示」トグルとは別概念)
 *
 * 判定範囲(本ファイル): 倍率の状態遷移純関数・保存/復元の純関数・対象ビューア
 * 判定・buildSrcdoc へのズーム反映・print.css のズーム無効化(ソース検査)。
 * Rust 層(メニュー定数・アクセラレータの parse 妥当性)は
 * `src-tauri/tests/acceptance_req36.rs` が判定する。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * ### src/lib/zoom.ts(新規)
 * 1. 定数(exported const・単位=パーセントの整数):
 *    - `MIN_ZOOM = 50` / `MAX_ZOOM = 300` / `ZOOM_STEP = 10` / `DEFAULT_ZOOM = 100`
 *    - `ZOOM_STORAGE_KEY = 'vellis.viewer-zoom'`(pane-resize の
 *      'vellis.explorer-width' と同じ家風。全窓・再起動・将来バージョン間で
 *      同じ値を読むため固定=契約④のグローバル1値)
 *    - `MENU_ZOOM_IN_EVENT = 'menu_zoom_in'` /
 *      `MENU_ZOOM_OUT_EVENT = 'menu_zoom_out'` /
 *      `MENU_ZOOM_RESET_EVENT = 'menu_zoom_reset'`
 *      — Rust 側 menu.rs の同名定数と同じリテラル(要件#34 の両側リテラル固定の
 *      家風)。Actual Size のイベントが *_reset なのは倍率リセット専用の意味論
 *      (契約⑧)を名前に出すため
 * 2. `normalizeZoom(level: number): number` — ZOOM_STEP の倍数へ四捨五入してから
 *    [MIN_ZOOM, MAX_ZOOM] へ clamp(10%刻み=契約③を保存値の吸収にも使う)。
 *    呼び出し側は有限数を渡すこと(非数値の吸収は loadZoom の責務=
 *    clampPaneWidth と同じ分担)。ちょうど中間(125 等)の丸め方向は契約外
 * 3. `zoomIn(level: number): number` / `zoomOut(level: number): number` —
 *    ±ZOOM_STEP して [MIN_ZOOM, MAX_ZOOM] で頭打ち(境界では no-op)。
 *    入力には正規化済み(10 の倍数・範囲内)の値が渡る前提でよい
 *    (off-ladder 入力の挙動は契約外)
 * 4. `isZoomTarget(type: FileType): boolean` — markdown / text / html のみ true
 *    (契約①)。image / model3d / video / pdf / binary は false(非対象=メニューは
 *    常時有効のまま no-op =契約⑧)。FileType の粒度より細かい対象外
 *    (SVG ソース表示・DiffView・指示ダイアログのプレビュー)は配線側= reviewer 照合
 * 5. `saveZoom(level: number): void` / `loadZoom(): number` —
 *    保存は数値文字列(`Number(...)` だけで読める表現=pane-resize の家風)。
 *    非有限は書かない。読込は欠損・解釈不能(非数値・非有限)→ DEFAULT_ZOOM、
 *    解釈可能な有限数は既定に落とさず normalizeZoom で吸収(保存値の意図を残す)
 * 6. Actual Size(menu_zoom_reset)= DEFAULT_ZOOM の適用。専用関数は要求しない
 *    (定数がリセット値の契約。適用の配線は reviewer 照合)
 *
 * ### src/lib/html-viewer.ts(拡張)
 * 7. `zoomStyleTag(zoom: number): string`(exported)— srcdoc に注入するズーム
 *    スタイル1本。zoom=100(既定)は ''(注入なし=後方互換の要)。100 以外は
 *    単一の `<style>…</style>` タグ(中身の CSS は zoom / transform 系の実装裁量=
 *    契約⑤。ただし倍率が違えば文字列も違うこと=倍率が反映されていること)
 * 8. `buildSrcdoc(content: string, docUri: string, zoom?: number): string` —
 *    第3引数省略時と zoom=100 は従来出力とバイト一致(後方互換。既存
 *    html-viewer.acceptance.test.ts は2引数呼びのまま無傷=書き換えない)。
 *    100 以外は zoomStyleTag(zoom) を head 相当(本文より前)へ注入し、base 注入・
 *    リンク退避など従来の変形はすべて維持する。zoom には正規化済みの値が渡る
 *    前提(off-ladder 値の挙動は契約外)
 *
 * ### src/styles/print.css(追記)
 * 9. `@media print` 内にズーム無効化のリセット宣言を置く(契約⑦)。
 *    `zoom: normal | 1 | 100%` または `transform: none`(`!important` 可)の
 *    いずれかが存在すること。現行 10pt 系(font-size: 10pt)は維持
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - メニューイベント(menu_zoom_*)の窓限定購読(要件#33)と zoom 状態の適用:
 *   markdown / text の本文コンテナへの適用(画像・表・コード・mermaid の一体
 *   拡大=契約①)・HtmlViewer の srcdoc 再生成(契約⑥)・非対象ビューアで
 *   no-op(契約⑧)・起動時 loadZoom / 変更時 saveZoom の配線(契約④)
 * - 他窓への即時反映の要否(契約④=実装裁量)
 * - print.css のリセット宣言が実際の適用先セレクタに効くこと(契約⑦)
 *
 * ## 人間ゲート(acceptance/acceptance.md)
 * - 見た目・操作感・物理 ⌘+(US 配列では Cmd+Shift+=)の実機発火・
 *   200% 時の ⌘P 印刷が従来どおり・HtmlViewer への実機適用
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { FileType } from './file-type';
import { buildSrcdoc, zoomStyleTag } from './html-viewer';
import {
	DEFAULT_ZOOM,
	MAX_ZOOM,
	MENU_ZOOM_IN_EVENT,
	MENU_ZOOM_OUT_EVENT,
	MENU_ZOOM_RESET_EVENT,
	MIN_ZOOM,
	ZOOM_STEP,
	ZOOM_STORAGE_KEY,
	isZoomTarget,
	loadZoom,
	normalizeZoom,
	saveZoom,
	zoomIn,
	zoomOut,
} from './zoom';

beforeEach(() => {
	localStorage.clear();
});

// ---------------------------------------------------------------------------
// 定数 — 契約値(③)・保存キー(④)・イベント名(②)
// ---------------------------------------------------------------------------

describe('定数 — 契約③の倍率値と保存キー・イベント名', () => {
	test('下限50・上限300・10%刻み・既定100(契約③=実装裁量ではなく契約値)', () => {
		expect(MIN_ZOOM).toBe(50);
		expect(MAX_ZOOM).toBe(300);
		expect(ZOOM_STEP).toBe(10);
		expect(DEFAULT_ZOOM).toBe(100);
	});

	test("保存キーは 'vellis.viewer-zoom' に固定(グローバル1値=全窓・再起動間の互換)", () => {
		expect(ZOOM_STORAGE_KEY).toBe('vellis.viewer-zoom');
	});

	test('イベント名は menu_zoom_in / menu_zoom_out / menu_zoom_reset(Rust 側と同リテラル)', () => {
		expect(MENU_ZOOM_IN_EVENT).toBe('menu_zoom_in');
		expect(MENU_ZOOM_OUT_EVENT).toBe('menu_zoom_out');
		expect(MENU_ZOOM_RESET_EVENT).toBe('menu_zoom_reset');
	});
});

// ---------------------------------------------------------------------------
// zoomIn / zoomOut — 状態遷移(10%ステップと境界の頭打ち)
// ---------------------------------------------------------------------------

describe('zoomIn / zoomOut — 10%ステップと 50〜300 の clamp', () => {
	test('zoomIn は +10%(100→110・50→60・290→300)', () => {
		expect(zoomIn(100)).toBe(110);
		expect(zoomIn(50)).toBe(60);
		expect(zoomIn(290)).toBe(300);
	});

	test('上限300では zoomIn は no-op(頭打ち)', () => {
		expect(zoomIn(300)).toBe(300);
	});

	test('zoomOut は −10%(100→90・60→50・300→290)', () => {
		expect(zoomOut(100)).toBe(90);
		expect(zoomOut(60)).toBe(50);
		expect(zoomOut(300)).toBe(290);
	});

	test('下限50では zoomOut は no-op(頭打ち)', () => {
		expect(zoomOut(50)).toBe(50);
	});

	test('50 から zoomIn を繰り返すと 10%刻みでちょうど 300 に到達する(全段の歩行)', () => {
		const ladder = [50];
		let level = 50;
		for (let i = 0; i < 100 && level < 300; i += 1) {
			level = zoomIn(level);
			ladder.push(level);
		}
		const expected = Array.from({ length: 26 }, (_, i) => 50 + i * 10); // 50,60,…,300
		expect(ladder).toEqual(expected);
	});

	test('300 から zoomOut を繰り返すと 10%刻みでちょうど 50 に到達する(逆方向の歩行)', () => {
		const ladder = [300];
		let level = 300;
		for (let i = 0; i < 100 && level > 50; i += 1) {
			level = zoomOut(level);
			ladder.push(level);
		}
		const expected = Array.from({ length: 26 }, (_, i) => 300 - i * 10); // 300,290,…,50
		expect(ladder).toEqual(expected);
	});
});

// ---------------------------------------------------------------------------
// normalizeZoom — 10%刻みへの丸めと clamp(保存値の吸収にも使う正規化)
// ---------------------------------------------------------------------------

describe('normalizeZoom — 10 の倍数へ丸めて 50〜300 へ clamp', () => {
	test('刻み上の範囲内はそのまま返す(境界値=50・300 を含む)', () => {
		expect(normalizeZoom(50)).toBe(50);
		expect(normalizeZoom(100)).toBe(100);
		expect(normalizeZoom(150)).toBe(150);
		expect(normalizeZoom(300)).toBe(300);
	});

	test('刻み外は最寄りの 10 の倍数へ丸める(123→120・47→50・156→160)', () => {
		expect(normalizeZoom(123)).toBe(120);
		expect(normalizeZoom(47)).toBe(50);
		expect(normalizeZoom(156)).toBe(160);
	});

	test('範囲外は境界へ clamp(9999→300・320→300・0→50・-20→50)', () => {
		expect(normalizeZoom(9999)).toBe(300);
		expect(normalizeZoom(320)).toBe(300);
		expect(normalizeZoom(0)).toBe(50);
		expect(normalizeZoom(-20)).toBe(50);
	});

	test('丸めと clamp の合成(44 → 刻み40 → 下限50)', () => {
		expect(normalizeZoom(44)).toBe(50);
	});

	test('返り値は常に 10 の倍数かつ 50〜300 の範囲内(代表サンプル)', () => {
		for (const input of [-500, 3, 49, 51, 77, 111, 249, 299, 301, 12345]) {
			const out = normalizeZoom(input);
			expect(out % ZOOM_STEP, `normalizeZoom(${input}) は刻み上`).toBe(0);
			expect(out, `normalizeZoom(${input}) は下限以上`).toBeGreaterThanOrEqual(MIN_ZOOM);
			expect(out, `normalizeZoom(${input}) は上限以下`).toBeLessThanOrEqual(MAX_ZOOM);
		}
	});
});

// ---------------------------------------------------------------------------
// isZoomTarget — 対象ビューア判定(契約①⑧)
// ---------------------------------------------------------------------------

describe('isZoomTarget — テキスト系(markdown/text/html)のみ対象', () => {
	test('FileType 全種の対象/非対象(契約①。型で全網羅を強制=分類が増えたら要件側で判断)', () => {
		// FileType に分類が追加されるとこのレコードが型エラーになる — その分類を
		// ズーム対象に含めるかは契約①に照らして要件側で決める(勝手に既定しない)。
		const table: Record<FileType, boolean> = {
			markdown: true,
			text: true,
			html: true,
			image: false,
			model3d: false,
			video: false,
			pdf: false,
			binary: false,
		};
		const actual = Object.fromEntries(
			(Object.keys(table) as FileType[]).map((t) => [t, isZoomTarget(t)]),
		);
		expect(actual).toEqual(table);
	});
});

// ---------------------------------------------------------------------------
// saveZoom / loadZoom — グローバル1値の永続化(契約④)
// ---------------------------------------------------------------------------

describe('saveZoom / loadZoom — localStorage のグローバル1値', () => {
	test('固定キーへ数値文字列として保存される(別ウインドウが Number(...) で読める表現)', () => {
		saveZoom(150);
		const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
		expect(raw).not.toBeNull();
		expect(Number(raw)).toBe(150);
	});

	test('save→load の往復で同じ倍率が返る', () => {
		saveZoom(150);
		expect(loadZoom()).toBe(150);
	});

	test('上書き保存は最後の値が勝つ(グローバル1値= last-writer-wins は仕様=契約④)', () => {
		saveZoom(150);
		saveZoom(80);
		expect(loadZoom()).toBe(80);
	});

	test('未保存(初回起動)は既定100を返す', () => {
		expect(loadZoom()).toBe(DEFAULT_ZOOM);
	});

	test('解釈不能な保存値(非数値・非有限)は既定100へフォールバックする', () => {
		const cases = ['garbage', '', ' ', 'NaN', 'Infinity', '-Infinity', '{"zoom":200}'];
		const results = Object.fromEntries(
			cases.map((raw) => {
				localStorage.setItem(ZOOM_STORAGE_KEY, raw);
				return [raw === '' ? '(空文字)' : raw, loadZoom()];
			}),
		);
		expect(results).toEqual(
			Object.fromEntries(
				cases.map((raw) => [raw === '' ? '(空文字)' : raw, DEFAULT_ZOOM]),
			),
		);
	});

	test('解釈可能な有限数は既定に落とさず normalizeZoom で吸収する(範囲外・刻み外)', () => {
		localStorage.setItem(ZOOM_STORAGE_KEY, '9999');
		expect(loadZoom()).toBe(300);
		localStorage.setItem(ZOOM_STORAGE_KEY, '-20');
		expect(loadZoom()).toBe(50);
		localStorage.setItem(ZOOM_STORAGE_KEY, '123');
		expect(loadZoom()).toBe(120);
	});

	test('NaN の保存を試みても次回読込は既定100(不正値を持ち込まない)', () => {
		saveZoom(Number.NaN);
		expect(loadZoom()).toBe(DEFAULT_ZOOM);
	});

	test('モジュール再読込(=再起動・新規ウインドウ相当)後も保存値が適用される(契約④)', async () => {
		saveZoom(150);
		vi.resetModules();
		const fresh = await import('./zoom');
		expect(fresh.loadZoom()).toBe(150);
	});
});

// ---------------------------------------------------------------------------
// buildSrcdoc へのズーム反映 — HtmlViewer(契約⑥)と後方互換
// ---------------------------------------------------------------------------

const DOC_URI = 'file:///Users/a/site/page.html';
const HEADED_DOC =
	'<!doctype html><html><head><title>t</title></head>' +
	'<body><p id="req36-marker">body text</p></body></html>';
const FRAGMENT_DOC = '<p id="req36-marker">fragment</p>';

describe('zoomStyleTag — srcdoc に注入するズームスタイル', () => {
	test('100%(既定)は空文字=何も注入しない(後方互換の要)', () => {
		expect(zoomStyleTag(DEFAULT_ZOOM)).toBe('');
	});

	test('100% 以外は単一の <style>…</style> タグ(拡大・縮小の両側)', () => {
		for (const zoom of [200, 50]) {
			const tag = zoomStyleTag(zoom);
			expect(tag.startsWith('<style'), `zoomStyleTag(${zoom}) は <style で始まる`).toBe(true);
			expect(tag.endsWith('</style>'), `zoomStyleTag(${zoom}) は </style> で終わる`).toBe(true);
			expect((tag.match(/<style/gi) ?? []).length, `zoomStyleTag(${zoom}) は1本のタグ`).toBe(1);
		}
	});

	test('倍率が違えばスタイルも違う(倍率がスタイルに反映されている)', () => {
		expect(zoomStyleTag(200)).not.toBe(zoomStyleTag(300));
		expect(zoomStyleTag(200)).not.toBe(zoomStyleTag(50));
	});

	test('決定的(同じ倍率なら同じ文字列。乱数・時刻に依存しない)', () => {
		expect(zoomStyleTag(200)).toBe(zoomStyleTag(200));
	});
});

describe('buildSrcdoc — ズーム反映(契約⑥)と後方互換', () => {
	test('第3引数省略と zoom=100 は従来出力とバイト一致(既存 acceptance は無傷)', () => {
		expect(buildSrcdoc(HEADED_DOC, DOC_URI, DEFAULT_ZOOM)).toBe(buildSrcdoc(HEADED_DOC, DOC_URI));
		expect(buildSrcdoc(FRAGMENT_DOC, DOC_URI, DEFAULT_ZOOM)).toBe(
			buildSrcdoc(FRAGMENT_DOC, DOC_URI),
		);
	});

	test('100% 以外では zoomStyleTag が注入され、base 注入と本文は従来どおり保たれる', () => {
		const srcdoc = buildSrcdoc(HEADED_DOC, DOC_URI, 200);
		expect(srcdoc).toContain(zoomStyleTag(200));
		expect(srcdoc).toMatch(/<base\b/i); // 従来の base 注入は維持
		expect(srcdoc).toContain('body text'); // 本文は失われない
	});

	test('注入位置は head 相当=本文より前(srcdoc 再生成でビューポートごと効く位置)', () => {
		const srcdoc = buildSrcdoc(HEADED_DOC, DOC_URI, 200);
		const styleAt = srcdoc.indexOf(zoomStyleTag(200));
		const bodyAt = srcdoc.indexOf('<p id="req36-marker"');
		expect(styleAt).toBeGreaterThanOrEqual(0);
		expect(bodyAt).toBeGreaterThan(0);
		expect(styleAt, 'ズームスタイルは本文より前に注入する').toBeLessThan(bodyAt);
	});

	test('head の無い素片(fragment)でも本文より前に注入される', () => {
		const srcdoc = buildSrcdoc(FRAGMENT_DOC, DOC_URI, 200);
		const styleAt = srcdoc.indexOf(zoomStyleTag(200));
		const bodyAt = srcdoc.indexOf('<p id="req36-marker"');
		expect(styleAt).toBeGreaterThanOrEqual(0);
		expect(styleAt).toBeLessThan(bodyAt);
	});

	test('倍率が違えば srcdoc も違う(200 ≠ 300 ≠ 100=倍率が出力に反映される)', () => {
		const at100 = buildSrcdoc(HEADED_DOC, DOC_URI, 100);
		const at200 = buildSrcdoc(HEADED_DOC, DOC_URI, 200);
		const at300 = buildSrcdoc(HEADED_DOC, DOC_URI, 300);
		expect(at200).not.toBe(at100);
		expect(at300).not.toBe(at100);
		expect(at200).not.toBe(at300);
	});

	test('縮小側(50%)も同じ経路で注入される', () => {
		const srcdoc = buildSrcdoc(HEADED_DOC, DOC_URI, 50);
		expect(srcdoc).toContain(zoomStyleTag(50));
		expect(srcdoc).not.toBe(buildSrcdoc(HEADED_DOC, DOC_URI, 100));
	});
});

// ---------------------------------------------------------------------------
// print.css — ズーム無効化のリセット宣言(契約⑦・ソース検査)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../..');
const PRINT_CSS_PATH = resolve(REPO_ROOT, 'src/styles/print.css');

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** `@media print { … }` スコープの中身だけを(ネストした括弧ごと)連結して返す。 */
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

type Decl = { prop: string; value: string };

function declarationsOf(css: string): Decl[] {
	const out: Decl[] = [];
	const re = /([-\w]+)\s*:\s*([^{};]+)(?=[;}])/g;
	for (let m = re.exec(css); m !== null; m = re.exec(css)) {
		out.push({ prop: m[1], value: m[2].trim() });
	}
	return out;
}

function printDecls(): Decl[] {
	const css = stripCssComments(readFileSync(PRINT_CSS_PATH, 'utf8'));
	const contents = printMediaContents(css);
	expect(contents.length, '@media print スコープがあること').toBeGreaterThan(0);
	return declarationsOf(contents);
}

describe('print.css — 印刷はズームに依存しない(契約⑦)', () => {
	test('@media print 内にズーム無効化のリセット宣言がある(zoom: normal/1/100% または transform: none)', () => {
		const decls = printDecls();
		const zoomReset = decls.some(
			(d) =>
				d.prop.toLowerCase() === 'zoom' &&
				/^(normal|1|100%)(\s*!important)?$/i.test(d.value),
		);
		const transformReset = decls.some(
			(d) =>
				d.prop.toLowerCase() === 'transform' && /^none(\s*!important)?$/i.test(d.value),
		);
		expect(
			zoomReset || transformReset,
			'@media print にズームのリセット宣言(zoom: normal|1|100% か transform: none)があること',
		).toBe(true);
	});

	test('現行 10pt 系は維持される(契約⑦=印刷出力は画面倍率に依存しない基準の側)', () => {
		const tenPt = printDecls().some(
			(d) => d.prop.toLowerCase() === 'font-size' && /^10pt(\s*!important)?$/i.test(d.value),
		);
		expect(tenPt, '@media print の font-size: 10pt が残っていること').toBe(true);
	});
});
