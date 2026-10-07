/**
 * 要件#38 追補g の受け入れテスト(docs/requirements/req-38.md 追補g・backlog 307)— フロント層
 *
 * 「PDF を表示している窓で Command + P(File > Print…)を押すと、PDF ファイルそのものの
 *  全ページが macOS の印刷ダイアログ(その窓のシート)に載る」
 * (2026-10-06 由谷の決定=PDF そのものを印刷する。従来は契約④の 'main-frame' 経路で
 *  iframe の画面に見えている範囲=先頭の約 1/5 だけが紙に出ていた)
 *
 * 契約(追補g)のうちフロントの持ち場:
 * - 2. `PrintRoute` に `'pdf'` を足し、`printRouteFor('pdf') === 'pdf'`。ほかの型の経路は
 *   不変(html=`'print-window'`・それ以外=`'main-frame'`)。`registerPrintListener` は
 *   `'pdf'` 経路で新しい Tauri command `print_pdf` を `{ uri }`(表示中の文書の URI)で
 *   invoke する。URI は `PrintHandlers` の新しい省略可の `getDocumentUri(): string` で
 *   受け取る(省略されていたら `onError` に渡して印刷しない)
 * - 3. の後半: ssh の PDF も同じ経路(URI はそのまま渡す)
 *
 * 本ファイルの持ち場= AC-38-追g の (a)(c)。Rust 側 (b) は
 * `src-tauri/tests/acceptance_req38g.rs`。既存の経路表(print-html.acceptance.test.ts)の
 * pdf 行と、AC-60-20 の command 一覧(go-to-path.acceptance.test.ts)への `print_pdf` は
 * 要件側の更新として test-writer が書き換え済み(2026-10-06 由谷の決定)。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * ```ts
 * // src/lib/print-html.ts(既存モジュールを更新)
 *
 * // 経路に 'pdf' を足す(追補g)。
 * export type PrintRoute = 'print-window' | 'main-frame' | 'pdf';
 * // html → 'print-window'・pdf → 'pdf'・それ以外の全型 → 'main-frame'(純関数・URI を取らない)
 * export function printRouteFor(type: FileType): PrintRoute;
 *
 * export type PrintHandlers = {
 *   getFileType: () => FileType;
 *   getHtmlSource: () => { content: string; docUri: string };
 *   // 追補g で追加。表示中の文書の URI(local の file:// も ssh:// もそのまま)。
 *   // 'pdf' 経路のときだけ、発火のたびに呼ぶ。省略時に 'pdf' 経路へ来たら
 *   // invoke せず onError に渡す(エラーの値は実装裁量)。
 *   getDocumentUri?: () => string;
 *   canPrint?: () => boolean;
 *   onError?: (err: unknown) => void;
 * };
 *
 * // 'pdf' 経路の発火: invoke('print_pdf', { uri: getDocumentUri() }) を1回。
 * //   print_current_window・print_html は呼ばない。getHtmlSource も呼ばない。
 * //   canPrint=false なら何もしない(追補f の止めが先)。invoke の reject・getter の
 * //   throw は onError へ(ハンドラの外へは投げない=従来の家風)。
 * export function registerPrintListener(handlers: PrintHandlers): Promise<() => void>;
 * ```
 *
 * ## reviewer 照合に委ねる配線
 * - +page.svelte の `getDocumentUri` が表示中の文書(windowState.currentDocument)の
 *   URI を返すこと((c) は「渡していること」だけをソース走査で固定する)
 * - `print_pdf` の失敗が既存の `printFailedMessage` で知らされること(既存の onError の配線)
 *
 * ## 人間ゲート
 * - (e) 実機: 複数ページの PDF を開いて Command + P で印刷のシートが出て、ページ数が PDF と同じ
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import type { FileType } from './file-type';
import {
	MENU_PRINT_EVENT,
	buildPrintDocument,
	printRouteFor,
	registerPrintListener,
	type PrintRoute,
} from './print-html';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const PDF_URI = 'file:///Users/a/papers/long%20report.pdf';
const SSH_PDF_URI = 'ssh://dev@build-box/srv/docs/manual.pdf';
const HTML_VIEW = { content: '<p>doc</p>', docUri: 'file:///Users/a/site/page.html' };

/** fire-and-forget なハンドラ実装でも完了を待てるように1マクロタスク挟む(print-html と同じ)。 */
const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

/** 登録済みハンドラを取り出す(登録順には依存しない)。 */
const handlerFor = () => listenMock.mock.calls.find((c) => c[0] === MENU_PRINT_EVENT)?.[1];

/** 発火してから実行列を終える。 */
const fire = async () => {
	await handlerFor()?.({ payload: undefined });
	await flushAsync();
};

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
	listenMock.mockResolvedValue(() => {});
	invokeMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// (a) printRouteFor — pdf だけが新しい 'pdf' 経路・ほかは不変(契約 2)
// ---------------------------------------------------------------------------

describe("printRouteFor — pdf は 'pdf' 経路(追補g 契約 2)", () => {
	test("printRouteFor('pdf') === 'pdf'", () => {
		expect(printRouteFor('pdf')).toBe('pdf');
	});

	test("ほかの型は不変: html は 'print-window'・それ以外は 'main-frame'(FileType 全網羅)", () => {
		const table: Record<FileType, PrintRoute> = {
			markdown: 'main-frame',
			text: 'main-frame',
			html: 'print-window',
			image: 'main-frame',
			model3d: 'main-frame',
			video: 'main-frame',
			audio: 'main-frame',
			pdf: 'pdf',
			binary: 'main-frame',
		};
		const actual = Object.fromEntries(
			(Object.keys(table) as FileType[]).map((t) => [t, printRouteFor(t)]),
		);
		expect(actual).toEqual(table);
	});
});

// ---------------------------------------------------------------------------
// (a) registerPrintListener — pdf 表示中の発火は print_pdf を { uri } で1回
// ---------------------------------------------------------------------------

describe('registerPrintListener — pdf 経路(追補g 契約 2)', () => {
	test("pdf 表示中の発火 → invoke('print_pdf', { uri }) を1回だけ・print_current_window / print_html は呼ばない", async () => {
		const getHtmlSource = vi.fn(() => HTML_VIEW);
		await registerPrintListener({
			getFileType: () => 'pdf',
			getHtmlSource,
			getDocumentUri: () => PDF_URI,
		});

		await fire();

		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0]?.[0]).toBe('print_pdf');
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ uri: PDF_URI });
		const names = invokeMock.mock.calls.map((c) => c[0]);
		expect(names).not.toContain('print_current_window');
		expect(names).not.toContain('print_html');
		expect(getHtmlSource).not.toHaveBeenCalled();
	});

	test('ssh の URI もそのまま渡す(URI で分岐しない・書き換えない)', async () => {
		await registerPrintListener({
			getFileType: () => 'pdf',
			getHtmlSource: () => HTML_VIEW,
			getDocumentUri: () => SSH_PDF_URI,
		});

		await fire();

		expect(invokeMock.mock.calls.map((c) => [c[0], c[1]])).toEqual([
			['print_pdf', { uri: SSH_PDF_URI }],
		]);
	});

	test('購読しただけでは getDocumentUri も invoke も呼ばない(印刷は発火時)', async () => {
		const getDocumentUri = vi.fn(() => PDF_URI);
		await registerPrintListener({
			getFileType: () => 'pdf',
			getHtmlSource: () => HTML_VIEW,
			getDocumentUri,
		});

		expect(getDocumentUri).not.toHaveBeenCalled();
		expect(invokeMock).not.toHaveBeenCalled();
	});

	test('発火のたびに getDocumentUri を読み直す(押した時点の文書の URI)', async () => {
		let uri = PDF_URI;
		await registerPrintListener({
			getFileType: () => 'pdf',
			getHtmlSource: () => HTML_VIEW,
			getDocumentUri: () => uri,
		});

		await fire();
		uri = SSH_PDF_URI;
		await fire();

		expect(invokeMock.mock.calls.map((c) => [c[0], c[1]])).toEqual([
			['print_pdf', { uri: PDF_URI }],
			['print_pdf', { uri: SSH_PDF_URI }],
		]);
	});

	test('getDocumentUri を渡していなければ invoke せず onError に渡す', async () => {
		const onError = vi.fn();
		await registerPrintListener({
			getFileType: () => 'pdf',
			getHtmlSource: () => HTML_VIEW,
			onError,
		});

		await fire();

		expect(invokeMock).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledTimes(1);
	});

	test('getDocumentUri も onError も無くても落とさない(invoke もしない)', async () => {
		await registerPrintListener({ getFileType: () => 'pdf', getHtmlSource: () => HTML_VIEW });

		// ハンドラ呼び出しが reject しないこと自体が判定(投げればテストが落ちる)。
		await fire();

		expect(invokeMock).not.toHaveBeenCalled();
	});

	test('canPrint=false なら何もしない(print_pdf を呼ばない・getDocumentUri も onError も呼ばない)', async () => {
		const getDocumentUri = vi.fn(() => PDF_URI);
		const onError = vi.fn();
		await registerPrintListener({
			getFileType: () => 'pdf',
			getHtmlSource: () => HTML_VIEW,
			getDocumentUri,
			canPrint: () => false,
			onError,
		});

		await fire();

		expect(invokeMock).not.toHaveBeenCalled();
		expect(getDocumentUri).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});

	test('canPrint=true なら print_pdf を呼ぶ', async () => {
		await registerPrintListener({
			getFileType: () => 'pdf',
			getHtmlSource: () => HTML_VIEW,
			getDocumentUri: () => PDF_URI,
			canPrint: () => true,
		});

		await fire();

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['print_pdf']);
	});

	test('invoke(print_pdf)の失敗は onError へ渡し、ハンドラの外へは投げない', async () => {
		const err = 'cannot open the PDF';
		invokeMock.mockRejectedValue(err);
		const onError = vi.fn();
		await registerPrintListener({
			getFileType: () => 'pdf',
			getHtmlSource: () => HTML_VIEW,
			getDocumentUri: () => PDF_URI,
			onError,
		});

		await fire();

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['print_pdf']);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(err);
	});

	test('invoke(print_pdf)の失敗は onError 省略時も落とさない', async () => {
		invokeMock.mockRejectedValue(new Error('print failed'));
		await registerPrintListener({
			getFileType: () => 'pdf',
			getHtmlSource: () => HTML_VIEW,
			getDocumentUri: () => PDF_URI,
		});

		// ハンドラ呼び出しが reject しないこと自体が判定(投げればテストが落ちる)。
		await fire();

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['print_pdf']);
	});

	test('getDocumentUri の throw も onError へ(invoke しない)', async () => {
		const err = new Error('no document');
		const onError = vi.fn();
		await registerPrintListener({
			getFileType: () => 'pdf',
			getHtmlSource: () => HTML_VIEW,
			getDocumentUri: () => {
				throw err;
			},
			onError,
		});

		await fire();

		expect(invokeMock).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(err);
	});
});

// ---------------------------------------------------------------------------
// (a) ほかの型は不変 — getDocumentUri を渡しても従来の経路のまま
// ---------------------------------------------------------------------------

describe('registerPrintListener — pdf 以外の経路は不変(追補g 契約 2・5)', () => {
	test('markdown → print_current_window(getDocumentUri を渡していても print_pdf にしない)', async () => {
		const getDocumentUri = vi.fn(() => 'file:///Users/a/notes/today.md');
		await registerPrintListener({
			getFileType: () => 'markdown',
			getHtmlSource: () => HTML_VIEW,
			getDocumentUri,
		});

		await fire();

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['print_current_window']);
	});

	test('html → print_html(文書は buildPrintDocument のまま・print_pdf にしない)', async () => {
		await registerPrintListener({
			getFileType: () => 'html',
			getHtmlSource: () => HTML_VIEW,
			getDocumentUri: () => HTML_VIEW.docUri,
		});

		await fire();

		expect(invokeMock.mock.calls.map((c) => [c[0], c[1]])).toEqual([
			['print_html', { document: buildPrintDocument(HTML_VIEW.content, HTML_VIEW.docUri) }],
		]);
	});

	test('pdf 以外の全型は print_pdf を一度も呼ばない(html は print_html・他は print_current_window)', async () => {
		let current: FileType = 'markdown';
		await registerPrintListener({
			getFileType: () => current,
			getHtmlSource: () => HTML_VIEW,
			getDocumentUri: () => PDF_URI,
		});

		const others: FileType[] = ['markdown', 'text', 'html', 'image', 'model3d', 'video', 'audio', 'binary'];
		for (const type of others) {
			current = type;
			await fire();
		}

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(
			others.map((t) => (t === 'html' ? 'print_html' : 'print_current_window')),
		);
	});

	test('表示が pdf ⇄ markdown と切り替わっても押した時点の型で経路が決まる', async () => {
		let current: FileType = 'pdf';
		await registerPrintListener({
			getFileType: () => current,
			getHtmlSource: () => HTML_VIEW,
			getDocumentUri: () => PDF_URI,
		});

		await fire();
		current = 'markdown';
		await fire();
		current = 'pdf';
		await fire();

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual([
			'print_pdf',
			'print_current_window',
			'print_pdf',
		]);
	});
});

// ---------------------------------------------------------------------------
// (c) +page.svelte の配線 — registerPrintListener に getDocumentUri を渡す(ソース走査)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../..');

/** `from` 以降で最初に現れる `{` から、対応する `}` までを切り出す。 */
function balancedBlock(code: string, from: number): string {
	const open = code.indexOf('{', from);
	if (open < 0) throw new Error('block must open');
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === '{') depth++;
		else if (code[i] === '}') {
			depth--;
			if (depth === 0) return code.slice(open, i + 1);
		}
	}
	throw new Error('block must close');
}

describe('+page.svelte — registerPrintListener に getDocumentUri を渡す(AC-38-追g (c))', () => {
	test('registerPrintListener({ … }) の引数に getDocumentUri がある', () => {
		const page = readFileSync(resolve(REPO_ROOT, 'src/routes/+page.svelte'), 'utf8');
		const calls = [...page.matchAll(/registerPrintListener\s*\(\s*\{/g)];
		expect(calls.length, '+page.svelte は registerPrintListener を呼ぶ').toBeGreaterThan(0);
		const args = calls.map((m) => balancedBlock(page, m.index ?? 0));
		expect(
			args.some((a) => /\bgetDocumentUri\b/.test(a)),
			`registerPrintListener の引数に getDocumentUri を渡す: ${args.join('\n---\n')}`,
		).toBe(true);
	});
});
