/**
 * 要件#71 追補c の受け入れテスト(docs/requirements/req-71.md「## 追補c」・AC-71-11・backlog 290)
 * — フロントの純ロジック側(unit プロジェクト)
 *
 * 追補c(1)「`init_window` が失敗しても、空の状態の画面に版番号を出す」。追補b(1) の経路
 * (`windowInit.kind === 'failed'`)では `windowState.version` が設定されず、履歴選択画面から root を
 * 選び直したあとの空の状態の画面(`EmptyState.svelte` の `v{windowState.version}`)に版番号が出ない。
 * 失敗の分岐でも `get_build_info` の `version`(`$lib/buildInfo` の `getBuildInfo()`=キャッシュ付き・
 * `init_window` の `version` と同じ `CARGO_PKG_VERSION`)から入れる。
 *
 * `+page.svelte` はマウントで試せないので、`open-failure-root.acceptance.test.ts`(AC-71-9)と同じ家風で
 * **判断を `$lib/root-picker` の関数に切り出し**、関数を単体で判定し(AC-71-11(a))、`+page.svelte` が
 * 失敗の分岐でその関数の結果を `windowState.version` に入れることはソース走査で固定する(AC-71-11(b))。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
 *
 * ```ts
 * // --- src/lib/root-picker.ts(既存ファイルに追加。既存の export は不変)---
 * /** 追補c(1)・AC-71-11(a): `getInfo()` の `version` を返す。`getInfo` が reject しても
 *  *  例外を外へ出さず `''` を返す(版番号が出ないだけ=従来どおり。Unhandled Promise Rejection を
 *  *  出さない)。+page は `getInfo` に `$lib/buildInfo` の `getBuildInfo` を渡す。 *\/
 * export async function versionAfterFailedInit(getInfo: () => Promise<{ version: string }>): Promise<string>;
 *
 * // --- src/routes/+page.svelte ---
 * //   - `getBuildInfo` を `$lib/buildInfo` から、`versionAfterFailedInit` を `$lib/root-picker` から import
 * //   - `if (<outcome>.kind === 'failed') { … }` の分岐の **中** で
 * //     `windowState.version = await versionAfterFailedInit(getBuildInfo)` とする
 * //     (履歴選択画面を出す `rootPicker = { …, open: true, …, error: <outcome>.message }` の代入のあと・
 * //     購読(`listen('root_changed')` ほか)の登録より前)
 * //   - 不変: 成功の分岐の `windowState.version = init.version`
 * ```
 *
 * ## 判定しないもの(人間ゲート・reviewer 照合)
 * - 実アプリで root を消して起動 → 履歴から選び直したあとの空の状態の画面に `v0.x.y` が出ること
 * - 履歴選択画面の注記・ステータスバーの版番号・`EmptyState.svelte` が従来どおりであること(既存テスト)
 *
 * ## スタブの設計
 * - $lib/ipc: モジュールモック(root-picker と buildInfo が import する invoke)
 * - `$lib/root-picker` は **名前空間 import**: 未実装でもファイルの読み込みは失敗せず、該当ケースだけが
 *   赤になる(open-failure-root.acceptance.test.ts の家風)
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import * as rootPickerModule from './root-picker';
import { getBuildInfo, type BuildInfo } from './buildInfo';

const invokeMock = vi.mocked(invoke);

// 未実装なら実行時に undefined(該当ケースが「関数でない」で赤になる。`pnpm check` も
// 実装までは赤=open-failure-root.acceptance.test.ts と同じ家風)。
const versionAfterFailedInit = rootPickerModule.versionAfterFailedInit;

function mustBeFunction<T>(fn: T, name: string): NonNullable<T> {
	if (typeof fn !== 'function') throw new Error(`${name} must be exported (要件#71 追補c)`);
	return fn as NonNullable<T>;
}

const INFO: BuildInfo = {
	version: '0.5.2',
	buildNumber: '123',
	buildTime: '2026-10-07T00:00:00Z',
	channel: 'release',
	flags: {},
};

beforeEach(() => {
	invokeMock.mockReset();
});

// ---------------------------------------------------------------------------
// AC-71-11(a) — versionAfterFailedInit: getInfo の version を返す・reject しても '' を返して reject しない
// ---------------------------------------------------------------------------

describe('AC-71-11(a): versionAfterFailedInit — getInfo の version を返し、reject しても "" を返して reject しない', () => {
	test('getInfo が { version: "0.5.2", … } を返す → "0.5.2"(getInfo は 1 回)', async () => {
		const fn = mustBeFunction(versionAfterFailedInit, 'versionAfterFailedInit ($lib/root-picker)');
		const getInfo = vi.fn<() => Promise<BuildInfo>>(async () => INFO);

		await expect(fn(getInfo)).resolves.toBe('0.5.2');
		expect(getInfo).toHaveBeenCalledTimes(1);
	});

	test('version 以外の項目は見ない({ version } だけでも同じ)', async () => {
		const fn = mustBeFunction(versionAfterFailedInit, 'versionAfterFailedInit ($lib/root-picker)');

		await expect(fn(async () => ({ version: '1.2.3' }))).resolves.toBe('1.2.3');
	});

	test('getInfo が reject(文字列の理由)→ ""(reject しない)', async () => {
		const fn = mustBeFunction(versionAfterFailedInit, 'versionAfterFailedInit ($lib/root-picker)');
		const getInfo = vi.fn<() => Promise<BuildInfo>>(async () =>
			Promise.reject('I/O error: get_build_info unavailable'),
		);

		// ここで reject が漏れたらテスト自体が失敗する=「reject しない」の判定を兼ねる。
		await expect(fn(getInfo)).resolves.toBe('');
		expect(getInfo).toHaveBeenCalledTimes(1);
	});

	test('getInfo が reject(Error)→ ""(reject しない)', async () => {
		const fn = mustBeFunction(versionAfterFailedInit, 'versionAfterFailedInit ($lib/root-picker)');

		await expect(fn(async () => Promise.reject(new Error('boom')))).resolves.toBe('');
	});

	test('deps 注入なので invoke は呼ばれない(+page が getInfo に getBuildInfo を渡す)', async () => {
		const fn = mustBeFunction(versionAfterFailedInit, 'versionAfterFailedInit ($lib/root-picker)');

		await fn(async () => INFO);
		await fn(async () => Promise.reject('x'));

		expect(invokeMock).not.toHaveBeenCalled();
	});

	test('$lib/buildInfo の getBuildInfo をそのまま渡せる: get_build_info の version が返る', async () => {
		const fn = mustBeFunction(versionAfterFailedInit, 'versionAfterFailedInit ($lib/root-picker)');
		// getBuildInfo はモジュール内でキャッシュするので、本ファイルで実物を呼ぶのはこの 1 回だけ。
		invokeMock.mockImplementation(async (cmd: string) => {
			if (cmd === 'get_build_info') return INFO;
			throw new Error(`unexpected command: ${cmd}`);
		});

		await expect(fn(getBuildInfo)).resolves.toBe('0.5.2');
		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['get_build_info']);
	});
});

// ---------------------------------------------------------------------------
// AC-71-11(b)(ソース走査)— +page.svelte の failed の分岐で versionAfterFailedInit(getBuildInfo) の結果を
// windowState.version に代入し、getBuildInfo を $lib/buildInfo から import している
// ---------------------------------------------------------------------------

describe('AC-71-11(b)(ソース走査): +page.svelte の failed の分岐は windowState.version = await versionAfterFailedInit(getBuildInfo)', () => {
	const page = () => readFileSync(resolve(__dirname, '../routes/+page.svelte'), 'utf-8');

	/** `start` から最初の `open` に対応する閉じ括弧までの全体(呼び出し・ブロック・オブジェクトリテラルに共用)。 */
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

	/** `const <outcome> = await initWindowOrPicker(` の変数名(AC-71-9 の走査と同じ形)。無ければ null。 */
	function outcomeVar(src: string): string | null {
		const m = /(?:const|let)\s+(\w+)\s*=\s*await\s+initWindowOrPicker(?:<[^(]*?>)?\(/.exec(src);
		return m ? m[1] : null;
	}

	/** `if (<outcome>.kind === 'failed') { … }` の位置と本体(`{ … }`)。無ければ null。 */
	function failedBranch(src: string): { at: number; body: string } | null {
		const varName = outcomeVar(src);
		if (!varName) return null;
		const re = new RegExp(`\\bif\\s*\\(\\s*${varName}\\.kind\\s*===\\s*'failed'\\s*\\)\\s*\\{`);
		const m = re.exec(src);
		if (!m) return null;
		return { at: m.index, body: balancedFrom(src, m.index, '{') };
	}

	const ASSIGN_RE = /\bwindowState\.version\s*=\s*await\s+versionAfterFailedInit\(\s*getBuildInfo\s*\)/;

	test('getBuildInfo を $lib/buildInfo から、versionAfterFailedInit を $lib/root-picker から import している', () => {
		const src = page();
		expect(src, 'import { getBuildInfo } from \'$lib/buildInfo\' (backlog 290)').toMatch(
			/import\s*\{[^}]*\bgetBuildInfo\b[^}]*\}\s*from\s*'\$lib\/buildInfo'/,
		);
		expect(src, 'import { versionAfterFailedInit } from \'$lib/root-picker\' (backlog 290)').toMatch(
			/import\s*\{[^}]*\bversionAfterFailedInit\b[^}]*\}\s*from\s*'\$lib\/root-picker'/,
		);
	});

	test('failed の分岐の中で windowState.version = await versionAfterFailedInit(getBuildInfo) とする', () => {
		const src = page();
		const branch = failedBranch(src);
		expect(branch, 'the startup must keep `if (<outcome>.kind === \'failed\') { … }` (AC-71-9)').not.toBeNull();
		const { body } = branch!;

		expect(body, 'the failed branch must set windowState.version from versionAfterFailedInit(getBuildInfo) (backlog 290)').toMatch(
			ASSIGN_RE,
		);
		// 分岐の中で 1 回だけ(二重に IPC を待たない)。
		expect(body.match(new RegExp(ASSIGN_RE.source, 'g'))?.length).toBe(1);
	});

	test('代入は履歴選択画面を出す rootPicker = { …, open: true, …, error: <outcome>.message } のあと・購読の登録より前', () => {
		const src = page();
		const varName = outcomeVar(src);
		expect(varName, 'see AC-71-9').not.toBeNull();
		const branch = failedBranch(src);
		expect(branch, 'see the previous case').not.toBeNull();
		const { at, body } = branch!;

		// 分岐の中の rootPicker = { … }(open: true・error: <outcome>.message)の位置
		const pickerRe = /\brootPicker\s*=\s*\{/g;
		let pickerAt = -1;
		for (let m = pickerRe.exec(body); m; m = pickerRe.exec(body)) {
			const lit = balancedFrom(body, m.index, '{');
			if (/\bopen:\s*true\b/.test(lit) && new RegExp(`\\berror:\\s*${varName}\\.message\\b`).test(lit)) {
				pickerAt = m.index;
				break;
			}
		}
		expect(pickerAt, 'the failed branch must still open the picker with the note (AC-71-9)').toBeGreaterThan(-1);

		const assignAt = body.search(ASSIGN_RE);
		expect(assignAt, 'see the previous case').toBeGreaterThan(-1);
		expect(assignAt, 'the version is set after the picker is shown').toBeGreaterThan(pickerAt);

		// 購読の登録(listen('root_changed') ほか)は分岐より後に残る(= 代入はその前)。
		const absoluteAssignAt = at + assignAt;
		for (const event of ['root_changed', 'file_changed', 'binary_file_changed', 'file_removed', 'directory_changed']) {
			const m = new RegExp(`\\blisten(?:<[^(]*?>)?\\(\\s*'${event}'`).exec(src);
			expect(m, `listen('${event}') must still be registered`).not.toBeNull();
			expect(m!.index, `listen('${event}') must come after the version assignment`).toBeGreaterThan(absoluteAssignAt);
		}
	});

	test('不変: 成功の分岐の windowState.version = init.version は残る', () => {
		const src = page();
		expect(src).toMatch(/\bwindowState\.version\s*=\s*init\.version\b/);
	});
});
