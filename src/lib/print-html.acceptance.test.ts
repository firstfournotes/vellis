/**
 * 要件#38 の受け入れテスト(requirements.md #38)— フロント層
 * 「HTML ビューア表示中も ⌘P(File > Print…)で表示中のレンダリング結果を
 *  印刷できる(現状は印刷不能= backlog #82 のバグ修正)」
 *
 * 契約(2026-08-30 登録・方式はプローブ実測で確定済み=案a′):
 * - ① 原因=印刷は menu.rs の Webview::print()(メインフレーム対象)+ print.css の
 *   設計で、HtmlViewer の sandbox iframe(srcdoc)の中身は印刷出力に展開されない
 * - ② 印刷内容=画面の HtmlViewer と同じ前処理済みスナップショット(buildSrcdoc
 *   相当=リンク退避・スクリプト不実行)。**要件#8 の安全対策を印刷経路でも全部
 *   維持**=生 HTML をスクリプト実行可能な文脈へ置かない
 * - ③ 方式(案a′)=印刷専用の可視 WebviewWindow に印刷文書を実 URL で正規ロードし、
 *   on_page_load Finished 待ち+猶予後に Webview::print()。about:blank +
 *   document.write は wry 0.54.4 が panic しアプリごとクラッシュするため禁止(実測)
 * - ④ markdown/text の印刷経路・print.css の既存設計は変更しない
 * - ⑤ ズーム(要件#36)は紙に持ち込まない= markdown と同じ倍率非依存
 * - ⑥ ssh リモート HTML も画面表示と同等の範囲で対象(URI スキームで分岐しない)
 * - ⑦ 依存追加なし
 * - ⑧ 機械判定=印刷用文書生成の純関数・経路選択の出し分け等(本ファイルと
 *   src-tauri/tests/acceptance_req38.rs)。実際の印刷出力は人間ゲート
 *
 * ## 契約④の解釈(本テスト群が固定する読み= reviewer はこれで照合する)
 * 「markdown/text の印刷経路を変更しない」は「**経路の終端が従来と同じ**=当該
 * (フォーカス)窓の Webview::print() に到達し、print.css の @media print が
 * そのまま適用される」の意味に読む。ディスパッチ層の差し替え(menu.rs の Print…
 * クリックが直接 print() する代わりに MENU_PRINT_EVENT をフォーカス窓へ emit_to
 * し、フロントが printRouteFor で判定して main-frame 経路では
 * invoke('print_current_window') → Rust が invoke 元の窓の Webview::print() を
 * 呼ぶ)は追加してよい。html 以外の**全** FileType が main-frame 経路に残ること
 * (現行挙動の維持)は printRouteFor の網羅テーブルで機械固定し、終端
 * (Webview::print() + print.css 適用)の不変は reviewer 照合+人間ゲート
 * (200% ズーム中の markdown 印刷が従来どおり等)。print.css そのものは変更
 * しない(本ファイル末尾のソース検査+既存 zoom.acceptance.test.ts の
 * @media print 検査が防衛線)。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * ```ts
 * // src/lib/print-html.ts(新規)
 *
 * // Rust メニュー(menu.rs)→ Webview の通知イベント名(ペイロードなし)。
 * // File > Print… のクリックでフォーカス中ウィンドウへ emit_to(menu_open_* と
 * // 同型=要件#33 の窓限定購読が受信側)。menu.rs 側の同名定数と同じリテラル
 * // (要件#34/#36 の両側リテラル固定の家風)。
 * export const MENU_PRINT_EVENT = 'menu_print';
 *
 * // 印刷文書へ挿入する CSP メタタグ(単一の <meta> タグ)。content に
 * // script-src 'none' を含むこと(追加ディレクティブは実装裁量)。印刷窓は
 * // sandbox iframe の外なので、要件#8 の「スクリプト不実行」はこの CSP
 * // (+ Rust 側 protocol 応答の CSP ヘッダ=二重化)が引き受ける(契約②)。
 * export const PRINT_CSP_META: string;
 *
 * // 画面の HtmlViewer と同じ前処理(buildSrcdoc・zoom は既定=100)へ
 * // PRINT_CSP_META を1箇所だけ挿入した、完全な印刷用 HTML 文書(純関数)。
 * // 差分は CSP メタの挿入のみ:
 * //   buildPrintDocument(c, u).replace(PRINT_CSP_META, '') === buildSrcdoc(c, u)
 * // が全入力で成立する(リンク退避・base 注入・エスケープ済みテキスト不改変など
 * // buildSrcdoc の安全性がバイト単位でそのまま乗る=契約②)。挿入位置は CSP が
 * // 実効になる位置(head がある文書では head 内・素片では本文より前)。
 * // zoom 引数は持たない(契約⑤=紙は倍率非依存)。印刷窓のウィンドウタイトル等は
 * // WebviewWindow 側の裁量であり文書には足さない(差分最小=契約②の忠実さ)。
 * export function buildPrintDocument(content: string, docUri: string): string;
 *
 * // 経路選択(純関数・FileType 網羅)。html だけが印刷窓経路、それ以外の全型は
 * // 従来どおりのメインフレーム印刷(契約④=現行挙動の維持)。入力は FileType
 * // のみ — URI を取らないので ssh/local で分岐できない(契約⑥を API の形で担保。
 * // menu-open.ts の planMenuOpen が現 root を取らないのと同じ手法)。
 * export type PrintRoute = 'print-window' | 'main-frame';
 * export function printRouteFor(type: FileType): PrintRoute;
 *
 * // メニューイベントの購読と実行列。listen($lib/events =要件#33 の窓限定購読)で
 * // MENU_PRINT_EVENT を1本購読し、発火ごとに printRouteFor(getFileType()) で分岐:
 * // - 'main-frame' → invoke('print_current_window')(引数なし。Rust 側は
 * //   invoke 元=フォーカス窓の Webview::print() を呼ぶ=従来の終端)
 * // - 'print-window' → getHtmlSource() → invoke('print_html',
 * //   { document: buildPrintDocument(content, docUri) })
 * // - getFileType / getHtmlSource は発火のたびに呼ぶ(押した時点の表示で決まる=
 * //   zoom.ts の isTarget と同じ理由)。getHtmlSource は html 経路のときだけ呼ぶ
 * // - 失敗(invoke の reject・getter の throw)は onError へ渡し、ハンドラの外へは
 * //   投げない。onError 省略時も落とさない(menu-open / duplicate-window の家風)
 * // - 返り値は購読を解除する関数
 * export type PrintHandlers = {
 *   getFileType: () => FileType;
 *   getHtmlSource: () => { content: string; docUri: string };
 *   onError?: (err: unknown) => void;
 * };
 * export function registerPrintListener(handlers: PrintHandlers): Promise<() => void>;
 * ```
 *
 * invoke は `$lib/ipc`・listen は `$lib/events` の薄いラッパを vi.mock する。
 * 実装側も同じ場所から import すること(menu-open / duplicate-window と同じ家風)。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - menu.rs: Print… のクリックが直接 window.print() する代わりに
 *   MENU_PRINT_EVENT をフォーカス窓へ emit_to すること(handle_menu_open_click と同型)
 * - Rust コマンド print_current_window(invoke 元の窓の Webview::print() =従来の
 *   終端)と print_html(PrintDocumentStore 登録 → 印刷窓生成 → 実 URL 正規ロード →
 *   on_page_load Finished 待ち+猶予 → Webview::print() → 窓クローズ)の配線。
 *   about:blank + document.write の禁止(wry panic =実測=アプリごとクラッシュ)
 * - 印刷窓にアプリ JS(SvelteKit バンドル)を載せないこと(カスタム protocol が
 *   one-shot 文書のみを配信する=契約②の推奨方向)
 * - +page.svelte: mount 時に registerPrintListener を購読し、getFileType /
 *   getHtmlSource が現在の表示(ビューア種別・表示中 HTML の生テキストと文書 URI)を
 *   返すこと。ssh リモート文書でも同じ材料が渡ること(契約⑥)
 * - print.css の @media print が従来どおりメインフレーム印刷に適用されること(契約④)
 *
 * ## 人間ゲート(acceptance/acceptance.md)
 * - 実機の印刷出力: HTML ビューアで ⌘P → 印刷シートに文書内容(白紙でない・
 *   複数ページ展開)・ズーム 200% 中でも紙は等倍(契約⑤)・markdown/text の印刷が
 *   従来どおり(契約④)・印刷窓の生成と後始末・ssh リモート HTML の印刷(契約⑥)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import type { FileType } from './file-type';
import { buildSrcdoc, zoomStyleTag } from './html-viewer';
import {
	MENU_PRINT_EVENT,
	PRINT_CSP_META,
	buildPrintDocument,
	printRouteFor,
	registerPrintListener,
	type PrintRoute,
} from './print-html';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

// ---------------------------------------------------------------------------
// フィクスチャ — 画面の HtmlViewer が受け取るのと同じ「生 HTML +文書 URI」
// ---------------------------------------------------------------------------

const DOC_URI = 'file:///Users/a/site/page.html';
const SSH_DOC_URI = 'ssh://dev@build-box/srv/www/index.html';

const HEADED_DOC =
	'<!doctype html><html><head><title>t</title></head>' +
	'<body><p id="req38-marker">body text</p>' +
	'<a href="https://example.com/x">link</a></body></html>';

const FRAGMENT_DOC = '<p id="req38-marker">fragment</p>';

/** script と「エスケープ済みソース表記」を併せ持つ文書(契約②の安全性判定用)。 */
const SCRIPTED_DOC =
	'<!doctype html><html><head><title>s</title></head>' +
	'<body><script>window.__REQ38_PWNED__ = true;</script>' +
	'<p>&lt;a href="https://escaped.invalid/"&gt;</p></body></html>';

/** fire-and-forget なハンドラ実装でも完了を待てるように1マクロタスク挟む(menu-open と同じ)。 */
const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
	// 既定: 購読は成功し no-op の unlisten・invoke は解決(必要なテストで上書き)。
	listenMock.mockResolvedValue(() => {});
	invokeMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 定数 — イベント名(Rust 側 menu.rs と同リテラル)と CSP メタタグの形
// ---------------------------------------------------------------------------

describe('定数 — menu_print イベント名と PRINT_CSP_META', () => {
	test("イベント名は 'menu_print'(menu_open_* と同じ snake_case・Rust 側と同値)", () => {
		expect(MENU_PRINT_EVENT).toBe('menu_print');
	});

	test("PRINT_CSP_META は単一の <meta http-equiv> タグで script-src 'none' を含む(契約②)", () => {
		expect(PRINT_CSP_META.length).toBeGreaterThan(0);
		// 単一タグ(タグの入れ子・複数タグを持ち込まない=挿入差分を最小に保つ)
		expect(PRINT_CSP_META).toMatch(/^<meta\b[^>]*>$/i);
		expect((PRINT_CSP_META.match(/</g) ?? []).length).toBe(1);
		expect(PRINT_CSP_META).toMatch(/http-equiv\s*=\s*["']?Content-Security-Policy["']?/i);
		expect(PRINT_CSP_META).toContain("script-src 'none'");
	});
});

// ---------------------------------------------------------------------------
// buildPrintDocument — 画面と同じスナップショット+ CSP のみ(契約②⑤⑥)
// ---------------------------------------------------------------------------

describe('buildPrintDocument — buildSrcdoc との差分は PRINT_CSP_META の1挿入のみ(契約②)', () => {
	test('CSP メタを除去すると buildSrcdoc(zoom 既定)とバイト一致する(headed / fragment / scripted / ssh)', () => {
		const cases: Array<[string, string]> = [
			[HEADED_DOC, DOC_URI],
			[FRAGMENT_DOC, DOC_URI],
			[SCRIPTED_DOC, DOC_URI],
			[HEADED_DOC, SSH_DOC_URI],
		];
		for (const [content, uri] of cases) {
			const printDoc = buildPrintDocument(content, uri);
			expect(
				printDoc.split(PRINT_CSP_META).length - 1,
				`CSP メタはちょうど1回挿入される(uri=${uri})`,
			).toBe(1);
			expect(
				printDoc.replace(PRINT_CSP_META, ''),
				`CSP メタ以外は画面の srcdoc とバイト一致(uri=${uri})`,
			).toBe(buildSrcdoc(content, uri));
		}
	});

	test('head がある文書では CSP メタは head 内に入る(meta CSP が実効になる位置)', () => {
		const printDoc = buildPrintDocument(HEADED_DOC, DOC_URI);
		const cspAt = printDoc.indexOf(PRINT_CSP_META);
		expect(cspAt).toBeGreaterThan(printDoc.search(/<head\b/i));
		expect(cspAt).toBeLessThan(printDoc.indexOf('</head>'));
	});

	test('head の無い素片では CSP メタは本文より前に入る(パーサが head へ持ち上げる位置)', () => {
		const printDoc = buildPrintDocument(FRAGMENT_DOC, DOC_URI);
		const cspAt = printDoc.indexOf(PRINT_CSP_META);
		const bodyAt = printDoc.indexOf('<p id="req38-marker"');
		expect(cspAt).toBeGreaterThanOrEqual(0);
		expect(bodyAt).toBeGreaterThan(0);
		expect(cspAt).toBeLessThan(bodyAt);
	});

	test('リンク退避が印刷文書にも乗る(要件#8 追補: href → data-vellis-href・値は保持)', () => {
		const printDoc = buildPrintDocument(HEADED_DOC, DOC_URI);
		expect(printDoc).toContain('data-vellis-href="https://example.com/x"');
		expect(printDoc).not.toContain('<a href=');
	});

	test('base 注入が乗る(相対リソースが vellis-asset へ解決される=画面と同等)', () => {
		expect(buildPrintDocument(HEADED_DOC, DOC_URI)).toContain(
			'<base href="vellis-asset://local/Users/a/site/page.html">',
		);
	});

	test('ssh リモート文書も同じ形= base は vellis-asset://ssh へ(契約⑥・スキームで分岐しない)', () => {
		expect(buildPrintDocument(HEADED_DOC, SSH_DOC_URI)).toContain(
			'<base href="vellis-asset://ssh/dev@build-box/srv/www/index.html">',
		);
	});

	test('エスケープ済みテキストは不改変(&lt;a href=…&gt; はソース表記のまま)', () => {
		expect(buildPrintDocument(SCRIPTED_DOC, DOC_URI)).toContain(
			'&lt;a href="https://escaped.invalid/"&gt;',
		);
	});

	test('script は除去せず CSP で遮断する設計= script 本文は残り、CSP メタがその前にある(契約②)', () => {
		const printDoc = buildPrintDocument(SCRIPTED_DOC, DOC_URI);
		expect(printDoc).toContain('window.__REQ38_PWNED__ = true;');
		expect(printDoc.indexOf(PRINT_CSP_META)).toBeLessThan(printDoc.indexOf('<script'));
	});

	test('ズームは紙に持ち込まない= zoom スタイルを一切含まない(契約⑤・zoom 引数も持たない)', () => {
		const printDoc = buildPrintDocument(HEADED_DOC, DOC_URI);
		expect(printDoc).not.toContain(zoomStyleTag(200));
		expect(printDoc).not.toContain(zoomStyleTag(50));
	});

	test('決定的(同じ入力なら同じ文書。乱数・時刻に依存しない)', () => {
		expect(buildPrintDocument(HEADED_DOC, DOC_URI)).toBe(buildPrintDocument(HEADED_DOC, DOC_URI));
	});
});

// ---------------------------------------------------------------------------
// printRouteFor — 経路選択の出し分け(契約④・FileType 網羅)
// ---------------------------------------------------------------------------

describe('printRouteFor — html だけ印刷窓・他は従来のメインフレーム印刷', () => {
	test('FileType 全種の経路(型で全網羅を強制=分類が増えたら要件側で判断)', () => {
		// FileType に分類が追加されるとこのレコードが型エラーになる — その分類を
		// どちらの経路に載せるかは契約④に照らして要件側で決める(勝手に既定しない)。
		const table: Record<FileType, PrintRoute> = {
			markdown: 'main-frame',
			text: 'main-frame',
			html: 'print-window',
			image: 'main-frame',
			model3d: 'main-frame',
			video: 'main-frame',
			pdf: 'main-frame',
			binary: 'main-frame',
		};
		const actual = Object.fromEntries(
			(Object.keys(table) as FileType[]).map((t) => [t, printRouteFor(t)]),
		);
		expect(actual).toEqual(table);
	});
});

// ---------------------------------------------------------------------------
// registerPrintListener — menu_print の購読と実行列(配線契約)
// ---------------------------------------------------------------------------

describe('registerPrintListener — 発火 → 経路判定 → invoke', () => {
	const HTML_VIEW = { content: HEADED_DOC, docUri: DOC_URI };

	/** 登録済みハンドラを取り出す(登録順には依存しない)。 */
	const handlerFor = () => listenMock.mock.calls.find((c) => c[0] === MENU_PRINT_EVENT)?.[1];

	test('$lib/events の listen で MENU_PRINT_EVENT を1回だけ購読する(要件#33 の窓限定が前提)', async () => {
		await registerPrintListener({ getFileType: () => 'html', getHtmlSource: () => HTML_VIEW });

		expect(listenMock.mock.calls.map((c) => c[0])).toEqual([MENU_PRINT_EVENT]);
	});

	test('購読しただけでは getter も invoke も呼ばない(印刷は発火時)', async () => {
		const getFileType = vi.fn((): FileType => 'html');
		const getHtmlSource = vi.fn(() => HTML_VIEW);
		await registerPrintListener({ getFileType, getHtmlSource });

		expect(getFileType).not.toHaveBeenCalled();
		expect(getHtmlSource).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalled();
	});

	test("html 表示中の発火 → invoke('print_html', { document: buildPrintDocument(...) })", async () => {
		const getHtmlSource = vi.fn(() => HTML_VIEW);
		await registerPrintListener({ getFileType: () => 'html', getHtmlSource });

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(getHtmlSource).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('print_html');
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({
			document: buildPrintDocument(HEADED_DOC, DOC_URI),
		});
	});

	test("markdown 表示中の発火 → invoke('print_current_window')・getHtmlSource は呼ばない(契約④)", async () => {
		const getHtmlSource = vi.fn(() => HTML_VIEW);
		await registerPrintListener({ getFileType: () => 'markdown', getHtmlSource });

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('print_current_window');
		expect(getHtmlSource).not.toHaveBeenCalled();
	});

	test('html 以外の全型がメインフレーム印刷に残る(現行挙動の維持=契約④)', async () => {
		let current: FileType = 'markdown';
		await registerPrintListener({ getFileType: () => current, getHtmlSource: () => HTML_VIEW });

		const nonHtml: FileType[] = ['markdown', 'text', 'image', 'model3d', 'video', 'pdf', 'binary'];
		for (const type of nonHtml) {
			current = type;
			await handlerFor()?.({ payload: undefined });
			await flushAsync(); // fire-and-forget 実装でも次の発火前に実行列を終える
		}

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(
			nonHtml.map(() => 'print_current_window'),
		);
	});

	test('ssh リモート HTML も html 経路(URI で分岐しない=契約⑥)', async () => {
		await registerPrintListener({
			getFileType: () => 'html',
			getHtmlSource: () => ({ content: HEADED_DOC, docUri: SSH_DOC_URI }),
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock.mock.calls[0]?.[0]).toBe('print_html');
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({
			document: buildPrintDocument(HEADED_DOC, SSH_DOC_URI),
		});
	});

	test('発火のたびに getFileType を読み直す(押した時点の表示で経路が決まる)', async () => {
		let current: FileType = 'markdown';
		await registerPrintListener({ getFileType: () => current, getHtmlSource: () => HTML_VIEW });

		await handlerFor()?.({ payload: undefined });
		await flushAsync(); // fire-and-forget 実装でも読み直し前に1回目を終える
		current = 'html';
		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['print_current_window', 'print_html']);
	});

	test('invoke の失敗は onError へ渡し、ハンドラの外へは投げない', async () => {
		const err = new Error('print failed');
		invokeMock.mockRejectedValue(err);
		const onError = vi.fn();
		await registerPrintListener({
			getFileType: () => 'markdown',
			getHtmlSource: () => HTML_VIEW,
			onError,
		});

		await handlerFor()?.({ payload: undefined });
		await flushAsync();

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(err);
	});

	test('onError 省略時も落とさない(unhandled rejection にしない=menu-open の家風)', async () => {
		invokeMock.mockRejectedValue(new Error('print failed'));
		await registerPrintListener({ getFileType: () => 'html', getHtmlSource: () => HTML_VIEW });

		// ハンドラ呼び出しが reject しないこと自体が判定(投げればテストが落ちる)。
		await handlerFor()?.({ payload: undefined });
		await flushAsync();
	});

	test('返り値の解除関数で購読を解除する', async () => {
		const unlisten = vi.fn();
		listenMock.mockResolvedValue(unlisten);
		const off = await registerPrintListener({
			getFileType: () => 'html',
			getHtmlSource: () => HTML_VIEW,
		});

		off();

		expect(unlisten).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// print.css — 既存設計の維持(契約④・ソース検査=防衛線)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../..');

describe('print.css — 既存のメインフレーム印刷設計はそのまま(契約④)', () => {
	test('@media print と .markdown-body の設計が残っている(詳細は zoom.acceptance.test.ts が固定)', () => {
		const css = readFileSync(resolve(REPO_ROOT, 'src/styles/print.css'), 'utf8');
		expect(css).toContain('@media print');
		expect(css).toContain('.markdown-body');
	});
});
