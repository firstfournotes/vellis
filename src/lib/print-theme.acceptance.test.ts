/**
 * 要件#56 の受け入れテスト(docs/requirements/req-56.md)— ダークのまま印刷の固定(AC-56-22 の配線側)
 *
 * 契約 7 第1段の追加 (2)・判断 (p): 紙は常に Default のライト。`theme.css` の `@media print { :root:root:root {…} }`
 * がトークンをライトの値に戻し(CSS 側= `src/styles/design-tokens-stage2.acceptance.test.ts`)、Shiki のコードの色は
 * CSS では戻せないので、メインフレーム印刷(Markdown / text)の直前にライトの名前で描き直してから刷り、
 * 印刷が終わったら元の名前に戻す。第1段の reviewer が「固定するテストが無い(変異 M7 が緑のまま)」と
 * 指摘したものを本ファイルで固定する= **第1段で実装済み(緑)の固定**。
 *
 * 判定するもの:
 * - `src/lib/print-html.ts` の `PrintHandlers.beforeMainFramePrint` が、メインフレーム印刷(markdown / text)のときだけ
 *   `invoke('print_current_window')` の**前に** await され、HTML(印刷窓)と PDF では呼ばれない。準備が失敗しても印刷は
 *   止めない(例外を飲む)
 * - `src/routes/+page.svelte` が `registerPrintListener(` に `beforeMainFramePrint` を渡し、その関数が Shiki を
 *   ライトの名前(`$lib/theme` の `DEFAULT_CODE_THEMES.light` = `themes/default.json` の `code.light`)で描き直す。
 *   `afterprint` か `matchMedia('print')` の変化で元の名前に戻す配線がある(ソース検査型=関数名と呼び出しの存在)
 *
 * 判定しないもの(人間ゲート 7): 刷り上がりがライトであること・戻ったあとの画面の色。
 *
 * 判定方式: `$lib/ipc` の invoke と `$lib/events` の listen を vi.mock(print-html.acceptance と同じ)。
 * +page.svelte はテキストとして読む。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import { DEFAULT_CODE_THEMES } from './theme';
import { MENU_PRINT_EVENT, registerPrintListener, type PrintHandlers } from './print-html';
import type { FileType } from './file-type';

const REPO_ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

type Handler = (e: { payload: unknown }) => void;
let printHandler: Handler | null = null;

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
	printHandler = null;
	listenMock.mockImplementation(async (event: string, handler: Handler) => {
		if (event === MENU_PRINT_EVENT) printHandler = handler;
		return () => {};
	});
	invokeMock.mockResolvedValue(undefined);
});

async function firePrint(): Promise<void> {
	expect(printHandler, 'MENU_PRINT_EVENT が listen されていること').not.toBeNull();
	printHandler!({ payload: null });
	// run() の中の await を流す
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));
}

function handlersFor(type: FileType, extra: Partial<PrintHandlers> = {}): PrintHandlers {
	return {
		getFileType: () => type,
		getHtmlSource: () => ({ content: '<p>x</p>', docUri: 'file:///a/x.html' }),
		getDocumentUri: () => 'file:///a/x.pdf',
		...extra,
	};
}

/** `start` の位置にある呼び出しの、対応する閉じ括弧までのテキスト。 */
function balancedCall(src: string, start: number): string {
	const open = src.indexOf('(', start);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '(' || c === '[' || c === '{') depth += 1;
		else if (c === ')' || c === ']' || c === '}') {
			depth -= 1;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced call at ${start}`);
}

/** `function <name>(` / `const <name> = (…) =>` / `async function <name>(` の本体(最初の `{` から対応する `}`)。 */
function functionBody(src: string, name: string): string | null {
	const re = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let)\\s+${name}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*)`);
	const m = re.exec(src);
	if (!m) return null;
	const open = src.indexOf('{', m.index + m[0].length - 1);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth += 1;
		else if (c === '}') {
			depth -= 1;
			if (depth === 0) return src.slice(open, i + 1);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// print-html.ts — beforeMainFramePrint の順序と範囲
// ---------------------------------------------------------------------------

describe('AC-56-22 print-html.ts: beforeMainFramePrint はメインフレーム印刷の前にだけ await される', () => {
	for (const type of ['markdown', 'text'] as const) {
		test(`${type}: beforeMainFramePrint が invoke('print_current_window') より前に完了する`, async () => {
			const order: string[] = [];
			const beforeMainFramePrint = vi.fn(async () => {
				await new Promise((r) => setTimeout(r, 0));
				order.push('before');
			});
			invokeMock.mockImplementation(async (cmd: string) => {
				order.push(cmd);
				return undefined;
			});
			await registerPrintListener(handlersFor(type, { beforeMainFramePrint }));
			await firePrint();
			expect(beforeMainFramePrint).toHaveBeenCalledTimes(1);
			expect(order).toEqual(['before', 'print_current_window']);
		});
	}

	for (const type of ['html', 'pdf'] as const) {
		test(`${type}: beforeMainFramePrint は呼ばれない(印刷窓 / PDF の経路は画面の Shiki を刷らない)`, async () => {
			const beforeMainFramePrint = vi.fn(async () => {});
			await registerPrintListener(handlersFor(type, { beforeMainFramePrint }));
			await firePrint();
			expect(beforeMainFramePrint).not.toHaveBeenCalled();
			expect(invokeMock).toHaveBeenCalledTimes(1);
			expect(invokeMock.mock.calls[0][0]).toBe(type === 'html' ? 'print_html' : 'print_pdf');
		});
	}

	test('準備が失敗(reject)しても印刷は止めない(print_current_window は呼ばれ、onError にも渡さない)', async () => {
		const onError = vi.fn();
		await registerPrintListener(
			handlersFor('markdown', { beforeMainFramePrint: async () => Promise.reject(new Error('no shiki')), onError }),
		);
		await firePrint();
		expect(invokeMock).toHaveBeenCalledWith('print_current_window');
		expect(onError).not.toHaveBeenCalled();
	});

	test('beforeMainFramePrint を省略しても従来どおり print_current_window を呼ぶ', async () => {
		await registerPrintListener(handlersFor('markdown'));
		await firePrint();
		expect(invokeMock).toHaveBeenCalledWith('print_current_window');
	});
});

// ---------------------------------------------------------------------------
// +page.svelte — 配線(ソース検査)
// ---------------------------------------------------------------------------

describe('AC-56-22 +page.svelte: beforeMainFramePrint を渡し、Shiki をライトで描き直し、印刷後に戻す', () => {
	const page = () => read('src/routes/+page.svelte');

	test('registerPrintListener( の引数に beforeMainFramePrint がある', () => {
		const src = page();
		const at = src.indexOf('registerPrintListener(');
		expect(at, '+page.svelte が registerPrintListener( を呼ぶこと').toBeGreaterThanOrEqual(0);
		expect(balancedCall(src, at)).toMatch(/\bbeforeMainFramePrint\s*[:,}]/);
	});

	test('渡した関数が定義されていて、DEFAULT_CODE_THEMES.light(= themes/default.json の code.light)で描き直す経路を持つ', () => {
		const src = page();
		const call = balancedCall(src, src.indexOf('registerPrintListener('));
		const m = call.match(/\bbeforeMainFramePrint\s*:\s*([A-Za-z_$][\w$]*)/) ?? call.match(/\b(beforeMainFramePrint)\s*[,}]/);
		expect(m, 'beforeMainFramePrint: <関数名> か同名の省略記法').not.toBeNull();
		const name = m![1];
		const body = functionBody(src, name);
		expect(body, `${name} の定義が +page.svelte にあること`).not.toBeNull();
		expect(src).toMatch(/from\s+['"]\$lib\/theme['"]/);
		expect(src).toContain('DEFAULT_CODE_THEMES.light');
		const json = JSON.parse(read('themes/default.json')) as { code: { light: string } };
		expect(DEFAULT_CODE_THEMES.light).toBe(json.code.light);
		expect(DEFAULT_CODE_THEMES.light).toBe('github-light');
	});

	test("印刷が終わったら元に戻す配線: 'afterprint' か matchMedia('print') の変化を見る", () => {
		const src = page();
		const afterprint = /addEventListener\(\s*['"]afterprint['"]/.test(src);
		const mediaPrint = /matchMedia\(\s*['"]print['"]\s*\)/.test(src);
		expect(afterprint || mediaPrint, "afterprint か matchMedia('print') のどちらか").toBe(true);
	});
});
