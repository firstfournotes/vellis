/**
 * 要件#71 追補b の受け入れテスト(docs/requirements/req-71.md「## 追補b」・AC-71-9 / AC-71-10・
 * backlog 278・279)— フロントの純ロジック側(unit プロジェクト)
 *
 * 追補b(1)「root そのものを開けないときは、履歴選択画面で知らせる」(backlog 278)と
 * 追補b(2)「メニューの Open… で root は切り替わったのにファイルが開けないときは、画面も
 * 新しい root にしてから知らせる」(backlog 279)。
 *
 * `+page.svelte` はマウントで試せないので、`src/lib/open-failure.acceptance.test.ts`(契約3・5)と
 * 同じ家風で **判断を `$lib` の関数に切り出し**、関数を単体で判定し、`+page.svelte` がその関数を
 * 使って起動処理を最後まで進めることはソース走査で固定する。追補b(2) は `$lib/menu-open` の
 * `registerMenuOpenListeners` の挙動として判定する(配線側は `+page.svelte` の走査)。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
 *
 * ```ts
 * // --- src/lib/root-picker.ts(既存ファイルに追加。既存の export は不変)---
 * /** 起動処理の窓の初期化(`init_window`)に使う手段。+page は
 *  *  `initWindow: () => invoke<InitWindowResponse>('init_window')`。 *\/
 * export type InitWindowDeps<Init = unknown> = { initWindow: () => Promise<Init> };
 * export type InitWindowOutcome<Init = unknown> =
 *   | { kind: 'ready'; init: Init }                 // init = initWindow の解決値そのもの
 *   | { kind: 'failed'; message: string };          // message = openFolderFailedMessage(err)
 * /** 追補b(1)・AC-71-9: `init_window` が失敗(root が消えた・ssh に届かない)しても
 *  *  **決して reject しない**(同期 throw も含む)。失敗は `failed` と注記の文言で返り、
 *  *  +page はそれを履歴選択画面(`rootPicker.error`)に入れて起動処理を続ける。 *\/
 * export async function initWindowOrPicker<Init = unknown>(deps: InitWindowDeps<Init>): Promise<InitWindowOutcome<Init>>;
 *
 * // --- src/lib/menu-open.ts(registerMenuOpenListeners の挙動を追補b(2) で改める)---
 * //   file イベントで `set_root` が成功し、文書コマンド(`open_document` / `open_binary_document`)が
 * //   失敗したとき:
 * //     1. まず `onOpened({ root: <set_root の解決値>, document: null, docUri: <選んだファイルの URI> })` を 1 回
 * //        (画面を新しい root にする=裏側と同じにする)
 * //     2. そのあと `onError(<文書コマンドの reject 値>)` を 1 回(+page が `openFailedMessage` で
 * //        `Could not open: <理由>` にして alert)
 * //   `set_root` が失敗したときは従来どおり(onOpened は呼ばず onError だけ・文書コマンドは呼ばない)。
 * //   成功時も従来どおり(onOpened だけ・onError は呼ばない)。ハンドラの外へは投げない。
 * //   `openFileFromMenu()` を直接呼んだときの文書失敗の挙動は従来どおり契約外(本テストは判定しない)。
 *
 * // --- src/routes/+page.svelte ---
 * //   - `initWindowOrPicker` を `$lib/root-picker` から import し、起動処理(onMount)の先頭で
 * //     `const <outcome> = await initWindowOrPicker({ initWindow: () => invoke<InitWindowResponse>('init_window') })`
 * //     の形で呼ぶ(変数名・ジェネリクスは自由)。`await invoke<…>('init_window')` を直接書く形は残さない
 * //     (reject が onMount を止めて真っ白な窓になる経路そのもの)
 * //   - failed のとき: `rootPicker = { …, open: true, …, error: <outcome>.message }` の形で履歴選択画面を
 * //     出す(`entries` に履歴を入れるかは実装の自由)。`<RootPicker … error={rootPicker.error} …>` は従来どおり
 * //   - failed でも起動処理は止めない: `initWindowOrPicker(` の呼び出しから `startupSettled = true` までの
 * //     間に `return` を置かない。5 つの購読(`root_changed` / `file_changed` / `binary_file_changed` /
 * //     `file_removed` / `directory_changed`)と `startupSettled = true` はその呼び出しより後に残る
 * //   - メニュー(`registerMenuOpenListeners`)の配線は従来どおり: `onOpened` で `applyRoot(opened.root)`・
 * //     `document` があれば `setDocument`、`onError` で `alert(openFailedMessage(err))`。追補b(2) は
 * //     `$lib/menu-open` 側が `document: null` で onOpened を呼ぶことで画面の root が切り替わる
 * ```
 *
 * ## 判定しないもの(人間ゲート・reviewer 照合)
 * - 実アプリで root を消して(ssh を切って)起動したとき窓が真っ白にならないこと
 * - 失敗した root の履歴選択画面に履歴の一覧(entries)が並ぶこと(実装の自由)
 * - 前の文書が新しい root の **中** にあるとき(`document_retained = true`)の表示(req-71 の解釈点。
 *   本テストは `onOpened` に `document: null` が渡ることだけを固定し、`applyRoot` の既存の判断に委ねる)
 *
 * ## スタブの設計
 * - $lib/ipc / $lib/events / @tauri-apps/plugin-dialog: モジュールモック(menu-open.acceptance.test.ts と同じ)
 * - `$lib/root-picker` は **名前空間 import**: 未実装でもファイルの読み込みは失敗せず、該当ケースだけが
 *   赤になる(open-failure.acceptance.test.ts の家風)
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import * as rootPickerModule from './root-picker';
import { MENU_OPEN_FILE_EVENT, openFailedMessage, registerMenuOpenListeners } from './menu-open';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const dialogMock = openDialog as unknown as Mock<
	(options?: Record<string, unknown>) => Promise<string | string[] | null>
>;

/** CJK を含まない=英語の判定(要件#51 の走査と同じ考え方)。 */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

// 未実装なら実行時に undefined(該当ケースが「関数でない」で赤になる。`pnpm check` も
// 実装までは赤=open-failure.acceptance.test.ts と同じ家風)。
const initWindowOrPicker = rootPickerModule.initWindowOrPicker;
const openFolderFailedMessage = rootPickerModule.openFolderFailedMessage;

function mustBeFunction<T>(fn: T, name: string): NonNullable<T> {
	if (typeof fn !== 'function') throw new Error(`${name} must be exported (要件#71 追補b)`);
	return fn as NonNullable<T>;
}

/** fire-and-forget なハンドラ実装でも完了を待てるように1マクロタスク挟む(menu-open と同じ)。 */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ROOT_REASON = 'I/O error: No path was found (os error 2): file:///Users/x/gone';
const DOC_REASON = 'invalid UTF-8: file:///Users/a/docs/sjis.txt';

beforeEach(() => {
	invokeMock.mockReset();
	dialogMock.mockReset();
	listenMock.mockReset();
	listenMock.mockResolvedValue(() => {});
});

// ---------------------------------------------------------------------------
// AC-71-9 — initWindowOrPicker: init_window の失敗は failed(注記の文言)で返り、reject しない
// ---------------------------------------------------------------------------

describe('AC-71-9: initWindowOrPicker — init_window の失敗は failed(`Could not open the folder: <理由>`)で返り、reject しない', () => {
	type Init = {
		window_id: string;
		root_uri: string;
		entries: unknown[];
		initial_path: string | null;
		version: string;
		needs_root_selection: boolean;
		show_marks: boolean;
		show_changed: boolean;
		expanded_dirs: string[];
	};
	const INIT: Init = {
		window_id: 'w1',
		root_uri: 'file:///Users/x/notes',
		entries: [],
		initial_path: null,
		version: '0.5.1',
		needs_root_selection: false,
		show_marks: false,
		show_changed: false,
		expanded_dirs: [],
	};

	test('initWindow が reject(文字列の理由)→ { kind: "failed", message: "Could not open the folder: <理由>" }・reject しない', async () => {
		const fn = mustBeFunction(initWindowOrPicker, 'initWindowOrPicker ($lib/root-picker)');
		const initWindow = vi.fn<() => Promise<Init>>(async () => Promise.reject(ROOT_REASON));

		const outcome = await fn({ initWindow });

		expect(outcome).toEqual({ kind: 'failed', message: `Could not open the folder: ${ROOT_REASON}` });
		expect(initWindow).toHaveBeenCalledTimes(1);
		expect((outcome as { message: string }).message).not.toMatch(CJK);
	});

	test('文言は openFolderFailedMessage と同じ値(履歴から開けなかったときの注記と同じ=追補b(1))', async () => {
		const fn = mustBeFunction(initWindowOrPicker, 'initWindowOrPicker ($lib/root-picker)');
		const message = mustBeFunction(openFolderFailedMessage, 'openFolderFailedMessage ($lib/root-picker)');
		for (const err of [ROOT_REASON, new Error('ssh: connect to host nas port 22: No route to host'), 'x']) {
			const outcome = await fn({ initWindow: async () => Promise.reject(err) });
			expect(outcome).toEqual({ kind: 'failed', message: message(err) });
		}
		const withError = await fn({ initWindow: async () => Promise.reject(new Error('boom')) });
		expect(withError).toEqual({ kind: 'failed', message: 'Could not open the folder: Error: boom' });
	});

	test('initWindow が同期的に throw しても failed に収める(起動処理を止める経路を残さない)', async () => {
		const fn = mustBeFunction(initWindowOrPicker, 'initWindowOrPicker ($lib/root-picker)');
		const initWindow = (): Promise<Init> => {
			throw new Error('sync boom');
		};

		await expect(fn({ initWindow })).resolves.toEqual({
			kind: 'failed',
			message: 'Could not open the folder: Error: sync boom',
		});
	});

	test('initWindow が成功 → { kind: "ready", init } に解決値がそのまま入る', async () => {
		const fn = mustBeFunction(initWindowOrPicker, 'initWindowOrPicker ($lib/root-picker)');
		const initWindow = vi.fn<() => Promise<Init>>(async () => INIT);

		const outcome = await fn({ initWindow });

		expect(outcome).toEqual({ kind: 'ready', init: INIT });
		expect((outcome as { init: Init }).init).toBe(INIT);
		expect(initWindow).toHaveBeenCalledTimes(1);
	});

	test('deps 注入なので invoke は呼ばれない(+page が initWindow に invoke を包んで渡す)', async () => {
		const fn = mustBeFunction(initWindowOrPicker, 'initWindowOrPicker ($lib/root-picker)');
		await fn({ initWindow: async () => INIT });
		await fn({ initWindow: async () => Promise.reject(ROOT_REASON) });
		expect(invokeMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-71-9(ソース走査)— +page.svelte が initWindowOrPicker を使い、失敗を履歴選択画面に出し、
// 購読の登録と起動の完了まで進む形になっている
// ---------------------------------------------------------------------------

describe('AC-71-9(ソース走査): +page.svelte の起動処理は initWindowOrPicker を使い、失敗を rootPicker.error に入れ、購読と startupSettled まで進む', () => {
	const page = () => readFileSync(resolve(__dirname, '../routes/+page.svelte'), 'utf-8');

	/** `start` から最初の `open` に対応する閉じ括弧までの全体(呼び出し・オブジェクトリテラルに共用)。 */
	function balancedFrom(code: string, start: number, open: '(' | '{'): string {
		const at = code.indexOf(open, start);
		if (at === -1) throw new Error(`"${open}" expected after ${start}`);
		let depth = 0;
		for (let i = at; i < code.length; i++) {
			const c = code[i];
			if (c === '(' || c === '{' || c === '[') depth++;
			else if (c === ')' || c === '}' || c === ']') {
				depth--;
				if (depth === 0) return code.slice(start, i + 1);
			}
		}
		throw new Error(`unbalanced block starting at ${start}`);
	}

	const STARTUP_EVENTS = ['root_changed', 'file_changed', 'binary_file_changed', 'file_removed', 'directory_changed'] as const;
	function listenAt(src: string, event: string): number {
		const m = new RegExp(`\\blisten(?:<[^(]*?>)?\\(\\s*'${event}'`).exec(src);
		return m ? m.index : -1;
	}

	/** `const <outcome> = await initWindowOrPicker(` の位置と変数名。無ければ null。 */
	function initCall(src: string): { at: number; varName: string; call: string } | null {
		const m = /(?:const|let)\s+(\w+)\s*=\s*await\s+initWindowOrPicker(?:<[^(]*?>)?\(/.exec(src);
		if (!m) return null;
		const at = m.index;
		const callStart = src.indexOf('initWindowOrPicker', at);
		return { at, varName: m[1], call: balancedFrom(src, callStart, '(') };
	}

	test('initWindowOrPicker を $lib/root-picker から import し、起動処理で await して initWindow に init_window の invoke を渡す。直接の await invoke(init_window) は残さない', () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*\binitWindowOrPicker\b[^}]*\}\s*from\s*'\$lib\/root-picker'/);
		const found = initCall(src);
		expect(found, 'the startup must do `const <outcome> = await initWindowOrPicker({ initWindow: … })`').not.toBeNull();
		const { call } = found!;
		expect(call).toMatch(/\binitWindow\b/);
		expect(call).toContain("'init_window'");
		// 従来の「reject がそのまま onMount を止める」形は残さない(真っ白な窓の経路)。
		expect(src, 'a bare `await invoke(…\'init_window\')` must not remain (backlog 278)').not.toMatch(
			/await\s+invoke(?:<[^(]*?>)?\(\s*'init_window'/,
		);
	});

	test('failed のとき rootPicker = { …, open: true, …, error: <outcome>.message } で履歴選択画面を出す。<RootPicker> には error を渡したまま', () => {
		const src = page();
		const found = initCall(src);
		expect(found, 'see the previous case').not.toBeNull();
		const { varName } = found!;

		// ページ内の rootPicker = { … } のうち、open: true と error: <outcome>.message を両方含むものが 1 つ以上
		//(既存の needs_root_selection の literal は error: null なので一致しない)。
		const literals: string[] = [];
		const re = /\brootPicker\s*=\s*\{/g;
		for (let m = re.exec(src); m; m = re.exec(src)) {
			literals.push(balancedFrom(src, m.index, '{'));
		}
		const errorRe = new RegExp(`\\berror:\\s*${varName}\\.message\\b`);
		const failedLiteral = literals.find((lit) => /\bopen:\s*true\b/.test(lit) && errorRe.test(lit));
		expect(
			failedLiteral,
			`expected a \`rootPicker = { …, open: true, …, error: ${varName}.message }\` after initWindowOrPicker (backlog 278)`,
		).toBeDefined();

		expect(src).toMatch(/<RootPicker[\s\S]*?error=\{rootPicker\.error\}[\s\S]*?\/>/);
	});

	test('failed でも起動処理は止めない: 呼び出しから startupSettled = true の間に return が無く、5 つの購読と startupSettled はその後に残る', () => {
		const src = page();
		const found = initCall(src);
		expect(found, 'see the first case').not.toBeNull();
		const { at } = found!;

		const settledAt = src.indexOf('startupSettled = true');
		expect(settledAt, 'startupSettled = true must remain after initWindowOrPicker').toBeGreaterThan(at);
		const between = src.slice(at, settledAt);
		expect(between, 'no `return` between initWindowOrPicker(…) and startupSettled = true (the startup must run to completion)').not.toMatch(
			/\breturn\b/,
		);

		for (const event of STARTUP_EVENTS) {
			const listenPos = listenAt(src, event);
			expect(listenPos, `listen('${event}') must still be registered`).toBeGreaterThan(-1);
			expect(listenPos, `listen('${event}') must come after initWindowOrPicker`).toBeGreaterThan(at);
		}
	});
});

// ---------------------------------------------------------------------------
// AC-71-10 — registerMenuOpenListeners: set_root 成功・文書コマンド失敗 → onOpened(document:null) → onError
// ---------------------------------------------------------------------------

describe('AC-71-10: registerMenuOpenListeners — set_root が成功し文書が開けないとき、onOpened(root・document:null)のあとに onError を 1 回', () => {
	const FILE_PATH = '/Users/a/docs/sjis.txt';
	const FILE_URI = 'file:///Users/a/docs/sjis.txt';
	const PNG_PATH = '/Users/a/docs/photo.png';
	const PNG_URI = 'file:///Users/a/docs/photo.png';
	const PARENT_URI = 'file:///Users/a/docs';
	const rootPayload = { root_uri: PARENT_URI, entries: [{ name: 'sjis.txt' }], document_retained: false };
	const docPayload = { uri: 'file:///Users/a/docs/plan.md', content: '# plan', modified: null };

	const handlerFor = (event: string) => listenMock.mock.calls.find((c) => c[0] === event)?.[1];

	/** `set_root` は成功・文書コマンドは `reason` で reject する invoke。 */
	function installInvoke(reason: unknown) {
		invokeMock.mockImplementation(async (cmd: string) => {
			if (cmd === 'set_root') return rootPayload;
			if (cmd === 'open_document' || cmd === 'open_binary_document') throw reason;
			throw new Error(`unexpected command: ${cmd}`);
		});
	}

	test('open_document が reject → onOpened({ root, document: null, docUri })が 1 回、そのあと onError(理由)が 1 回。ハンドラ外へ投げない', async () => {
		const onOpened = vi.fn();
		const onError = vi.fn();
		await registerMenuOpenListeners({ onOpened, onError });
		dialogMock.mockResolvedValueOnce(FILE_PATH);
		installInvoke(DOC_REASON);

		// ここで reject が漏れたらテスト自体が失敗する=「外へ投げない」の判定を兼ねる。
		await handlerFor(MENU_OPEN_FILE_EVENT)?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root', 'open_document']);
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ uri: PARENT_URI });
		expect(invokeMock.mock.calls[1]?.[1]).toEqual({ uri: FILE_URI });

		expect(onOpened, 'the root switch must reach the screen (backlog 279)').toHaveBeenCalledTimes(1);
		expect(onOpened.mock.calls[0]?.[0]).toEqual({ root: rootPayload, document: null, docUri: FILE_URI });

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[0]).toBe(DOC_REASON);
		// 画面を新しい root にしてから知らせる(alert は閉じるまで JS を止めるので順序が効く)。
		expect(onOpened.mock.invocationCallOrder[0]).toBeLessThan(onError.mock.invocationCallOrder[0]!);
	});

	test('ラスタ画像(open_binary_document)が reject でも同じ: onOpened(document:null)→ onError', async () => {
		const onOpened = vi.fn();
		const onError = vi.fn();
		await registerMenuOpenListeners({ onOpened, onError });
		dialogMock.mockResolvedValueOnce(PNG_PATH);
		const failure = new Error('permission denied');
		installInvoke(failure);

		await handlerFor(MENU_OPEN_FILE_EVENT)?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root', 'open_binary_document']);
		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(onOpened.mock.calls[0]?.[0]).toEqual({ root: rootPayload, document: null, docUri: PNG_URI });
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[0]).toBe(failure);
		expect(onOpened.mock.invocationCallOrder[0]).toBeLessThan(onError.mock.invocationCallOrder[0]!);
	});

	test('onError 省略時も文書の失敗で落ちず、onOpened(document:null)は呼ばれる', async () => {
		const onOpened = vi.fn();
		await registerMenuOpenListeners({ onOpened });
		dialogMock.mockResolvedValueOnce(FILE_PATH);
		installInvoke(DOC_REASON);

		await handlerFor(MENU_OPEN_FILE_EVENT)?.({ payload: undefined });
		await flushAsync();

		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(onOpened.mock.calls[0]?.[0]).toMatchObject({ root: rootPayload, document: null });
	});

	test('知らせる文言は既存の `Could not open: <理由>`(openFailedMessage・英語)', () => {
		expect(openFailedMessage(DOC_REASON)).toBe(`Could not open: ${DOC_REASON}`);
		expect(openFailedMessage(new Error('boom'))).toBe('Could not open: Error: boom');
		expect(openFailedMessage('x')).not.toMatch(CJK);
	});

	test('set_root が失敗 → 従来どおり: onOpened は呼ばず onError が 1 回・文書コマンドは呼ばない', async () => {
		const onOpened = vi.fn();
		const onError = vi.fn();
		await registerMenuOpenListeners({ onOpened, onError });
		dialogMock.mockResolvedValueOnce(FILE_PATH);
		invokeMock.mockRejectedValueOnce(ROOT_REASON);

		await handlerFor(MENU_OPEN_FILE_EVENT)?.({ payload: undefined });
		await flushAsync();

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root']);
		expect(onOpened).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[0]).toBe(ROOT_REASON);
	});

	test('両方成功 → 従来どおり: onOpened(root・document)が 1 回・onError は呼ばない', async () => {
		const onOpened = vi.fn();
		const onError = vi.fn();
		await registerMenuOpenListeners({ onOpened, onError });
		dialogMock.mockResolvedValueOnce('/Users/a/docs/plan.md');
		invokeMock.mockResolvedValueOnce(rootPayload).mockResolvedValueOnce(docPayload);

		await handlerFor(MENU_OPEN_FILE_EVENT)?.({ payload: undefined });
		await flushAsync();

		expect(onOpened).toHaveBeenCalledTimes(1);
		expect(onOpened.mock.calls[0]?.[0]).toEqual({
			root: rootPayload,
			document: docPayload,
			docUri: 'file:///Users/a/docs/plan.md',
		});
		expect(onError).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-71-10(ソース走査)— +page.svelte のメニュー配線: onOpened で root を画面へ・document があれば
// setDocument・onError で alert(openFailedMessage(err))。document:null の onOpened で root だけが切り替わる
// ---------------------------------------------------------------------------

describe('AC-71-10(ソース走査): +page.svelte の registerMenuOpenListeners は onOpened で applyRoot・document があれば setDocument・onError で alert(openFailedMessage)', () => {
	const page = () => readFileSync(resolve(__dirname, '../routes/+page.svelte'), 'utf-8');

	function balancedCall(code: string, start: number): string {
		const open = code.indexOf('(', start);
		if (open === -1) throw new Error('call must have "("');
		let depth = 0;
		for (let i = open; i < code.length; i++) {
			const c = code[i];
			if (c === '(' || c === '{' || c === '[') depth++;
			else if (c === ')' || c === '}' || c === ']') {
				depth--;
				if (depth === 0) return code.slice(start, i + 1);
			}
		}
		throw new Error(`unbalanced call starting at ${start}`);
	}

	test('onOpened は applyRoot(opened.root) を呼び、document は truthy のときだけ setDocument。onError は alert(openFailedMessage(err))', () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*\bregisterMenuOpenListeners\b[^}]*\}\s*from\s*'\$lib\/menu-open'/);
		expect(src).toMatch(/import\s*\{[^}]*\bopenFailedMessage\b[^}]*\}\s*from\s*'\$lib\/menu-open'/);
		const callAt = src.indexOf('registerMenuOpenListeners<');
		const at = callAt === -1 ? src.indexOf('registerMenuOpenListeners(') : callAt;
		expect(at, 'the page must register the menu listeners').toBeGreaterThan(-1);
		const call = balancedCall(src, at);
		expect(call).toMatch(/\bonOpened\b/);
		expect(call).toMatch(/\bapplyRoot\(\s*opened\.root\s*\)/);
		// document が null(folder・追補b(2) の文書失敗)のときは setDocument しない。
		expect(call).toMatch(/if\s*\(\s*opened\.document\s*\)\s*windowState\.setDocument\(\s*opened\.document\s*\)/);
		expect(call).toMatch(/\bonError\b/);
		expect(call).toMatch(/alert\(\s*openFailedMessage\(\s*err\s*\)\s*\)/);
	});
});
