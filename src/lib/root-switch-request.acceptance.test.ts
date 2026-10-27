/**
 * 要件#48 追補m の受け入れテスト(docs/requirements/req-48.md「追補m」= Issue #750)— フロント層
 * 「CLI の `vellis -r`(IPC の `SwitchRoot`)で root を切り替えるとき、画面からの切り替えと同じ
 *  確認(`confirmDiscardEdits`)を通し、確認が true を返してから切り替える。編集が無ければ今と同じ」
 *
 * 今は backend(`handle_switch_root`)が先に root・監視・窓のタイトル・タブのまとまりを切り替えてから
 * `root_changed` を窓へ送り、窓の `applyRoot` が編集を確認なしに捨てる。本ファイルは
 * 「切り替えの依頼」を窓が受けてから確認し、確認が通ったときだけ切り替えを backend に頼む
 * フロントの判断と、+page.svelte の配線を固定する。backend 側の順序と応答は
 * `src-tauri/tests/acceptance_req48m.rs`、確認ダイアログの実体(ask・保存)を通した場面は
 * `root-switch-request.wiring.test.ts`。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
 *
 * 差し込み口の形は「backend は判定だけ済ませて窓へ『切り替えの依頼』の事象を送り、窓が確認してから
 * 既存の切り替え(`handle_switch_root`)を command で呼ぶ」。画面からの切り替えが使う `set_root` を
 * 使い回さないのは、(1) `acceptance_req62.rs` が `handle_switch_root` の本体に `set_title(` と
 * `…tabbing_identifier(` があることを固定していて(AC-48-追m (f)= 既存テスト無改変)、`set_root` に
 * 寄せると `handle_switch_root` が消えるか死んだコードになる、(2) `set_root` は履歴に記録する
 * (`record_root`)が今の `vellis -r` は記録しないので、契約2「結果は今と同じ」から外れる、の 2 点。
 * 切り替えの実体は今の `handle_switch_root` のままなので、監視・タイトル・タブのまとまり・
 * `document_retained`・`root_changed` を受けた窓の反映は今と同じ(契約2・5)。
 *
 * ```ts
 * // --- src/lib/root-switch-request.ts(新規)---
 *
 * /** backend(ipc/handler.rs)が判定のあと前面の窓へ送る「切り替えの依頼」の事象名。 *\/
 * export const ROOT_SWITCH_REQUESTED_EVENT = 'root_switch_requested';
 * /** 依頼の payload。backend の `RootSwitchRequestPayload { root_uri }` と同じ綴り。 *\/
 * export type RootSwitchRequestPayload = { root_uri: string };
 *
 * /** 確認が通ったあと、切り替えの実体(backend の `handle_switch_root`)を頼む command 名。 *\/
 * export const SWITCH_ROOT_CONFIRMED_COMMAND = 'switch_root_confirmed';
 * /** `$lib/ipc` の `invoke(SWITCH_ROOT_CONFIRMED_COMMAND, { uri })`。解決値は使わない
 *  *  (結果は backend が `root_changed` で窓へ送り、既存の購読が `applyRoot` する)。失敗は reject のまま。 *\/
 * export function switchRootConfirmed(uri: string): Promise<void>;
 *
 * export type RootSwitchRequestDeps = {
 *   /** 編集の始末を聞く関門(+page は `confirmDiscardEdits`)。false なら何もしない。 *\/
 *   confirmDiscard: () => Promise<boolean>;
 *   /** 切り替えの実体を頼む(+page は `switchRootConfirmed`)。 *\/
 *   switchRoot: (uri: string) => Promise<unknown>;
 *   /** `switchRoot` の失敗の通知先。省略しても例外は外へ出さない。 *\/
 *   onError?: (err: unknown) => void;
 * };
 * export type RootSwitchRequestOutcome = 'switched' | 'cancelled' | 'failed';
 *
 * /** 依頼 1 件の判断: confirmDiscard → true なら switchRoot(payload.root_uri)。
 *  *  - confirmDiscard が false → 'cancelled'(switchRoot は呼ばない)
 *  *  - switchRoot が解決 → 'switched'
 *  *  - switchRoot が reject → onError(err) を 1 回呼んで 'failed'(reject しない)
 *  *  - confirmDiscard が reject(契約上は起きない=追補k)→ switchRoot は呼ばず、reject しない *\/
 * export function handleRootSwitchRequest(
 *   payload: RootSwitchRequestPayload,
 *   deps: RootSwitchRequestDeps,
 * ): Promise<RootSwitchRequestOutcome>;
 *
 * /** `$lib/events` の listen で ROOT_SWITCH_REQUESTED_EVENT を購読し、届くたびに
 *  *  handleRootSwitchRequest(e.payload, deps) を呼ぶ。登録したハンドラはその Promise を返す
 *  *  (menu-open と同じ=テストと配線側が完了を待てる)。戻り値は購読の解除。 *\/
 * export function registerRootSwitchRequestListener(deps: RootSwitchRequestDeps): Promise<() => void>;
 * ```
 *
 * ```ts
 * // --- src/routes/+page.svelte(配線=ソース走査)---
 * //   `$lib/root-switch-request` から import し、`registerRootSwitchRequestListener({ … })` を 1 回呼ぶ。
 * //   その引数に `confirmDiscard: confirmDiscardEdits` と `switchRoot: switchRootConfirmed`
 * //   (または `switchRootConfirmed(` / `invoke('switch_root_confirmed'` を含む関数)を渡す。
 * //   既存の `listen<RootPayload>('root_changed', …)` → `windowState.applyRoot(…)` は不変(契約5)。
 * //   `root_changed` の購読の中で確認を挟まない(確認は依頼の側で済んでいる)。
 * ```
 *
 * ## 判定するもの
 * - **AC-48-追m (a)** 確認が false → switchRoot を呼ばない('cancelled')
 * - **AC-48-追m (b)** 確認が true → switchRoot(root_uri) を **確認が解決してから** 1 回呼ぶ('switched')。
 *   確認が終わる前に切り替えを頼まない(保存を選んだときは保存の完了を待つ=関門の中で待つ)
 * - **AC-48-追m (c)** 編集が無い=関門が聞かずに true → そのまま切り替えを頼む(関門の中身は
 *   wiring 側で ask が呼ばれないことを判定)
 * - 依頼の事象名・command 名・payload の綴り(backend と一致)・`switchRootConfirmed` の invoke
 * - 購読の登録(`$lib/events` の listen・事象名・解除)と、届いた payload の素通し
 * - +page.svelte の配線(ソース走査)
 *
 * ## 判定しないもの
 * - backend の順序(判定→依頼→応答・先に切り替えない)→ acceptance_req48m.rs
 * - ダイアログの文言・保存の経路 → 既存の edit-guard のテストと wiring 側
 * - `onError` を +page が何に繋ぐか(Explorer の ↑ と同じ `alert(openFolderFailedMessage(err))` が
 *   自然)→ reviewer 照合
 *
 * ## 実装前の見立て(赤の理由)
 * - `./root-switch-request` が無いので import で全件赤。+page.svelte にも
 *   `registerRootSwitchRequestListener(` が無い(配線の走査も赤)。`root_changed` の不変の走査は
 *   実装前から通る内容(退行の守り)
 *
 * ## スタブの設計
 * - `$lib/events`: `listen` をモックし、登録されたハンドラを取り出して直接呼ぶ(menu-open と同じ家風)
 * - `$lib/ipc`: `invoke` をモック(`switchRootConfirmed` の観測)
 * - 関門・切り替えは vi.fn で注入。順序は「解決を保留した Promise」で判定する
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));

import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import {
	ROOT_SWITCH_REQUESTED_EVENT,
	SWITCH_ROOT_CONFIRMED_COMMAND,
	handleRootSwitchRequest,
	registerRootSwitchRequestListener,
	switchRootConfirmed,
	type RootSwitchRequestPayload,
} from './root-switch-request';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const NEW_ROOT = 'file:///Users/a/other';
const payload: RootSwitchRequestPayload = { root_uri: NEW_ROOT };

/** 解決を手で進められる Promise(順序の判定に使う)。 */
function deferred<T>() {
	let resolveFn!: (v: T) => void;
	let rejectFn!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolveFn = res;
		rejectFn = rej;
	});
	return { promise, resolve: resolveFn, reject: rejectFn };
}

/** マイクロタスクを数回回す(保留中の Promise 連鎖が進むだけ進む)。 */
async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
	listenMock.mockResolvedValue(() => {});
});

// ---------------------------------------------------------------------------
// 綴り(backend と一致)
// ---------------------------------------------------------------------------

describe('AC-48-追m: 依頼の事象名・command 名(backend の ipc/handler.rs / lib.rs と同じ綴り)', () => {
	test("ROOT_SWITCH_REQUESTED_EVENT は 'root_switch_requested'", () => {
		expect(ROOT_SWITCH_REQUESTED_EVENT).toBe('root_switch_requested');
	});

	test("SWITCH_ROOT_CONFIRMED_COMMAND は 'switch_root_confirmed'", () => {
		expect(SWITCH_ROOT_CONFIRMED_COMMAND).toBe('switch_root_confirmed');
	});

	test('switchRootConfirmed(uri) は $lib/ipc の invoke(SWITCH_ROOT_CONFIRMED_COMMAND, { uri }) を 1 回呼ぶ', async () => {
		invokeMock.mockResolvedValueOnce(null);
		await switchRootConfirmed(NEW_ROOT);
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledWith('switch_root_confirmed', { uri: NEW_ROOT });
	});

	test('switchRootConfirmed は invoke の失敗をそのまま reject する(握りつぶさない)', async () => {
		invokeMock.mockRejectedValueOnce('folder vanished');
		await expect(switchRootConfirmed(NEW_ROOT)).rejects.toBe('folder vanished');
	});
});

// ---------------------------------------------------------------------------
// 判断(handleRootSwitchRequest)
// ---------------------------------------------------------------------------

describe('AC-48-追m (a): 確認が false なら切り替えを頼まない', () => {
	test("confirmDiscard → false: switchRoot は呼ばれず 'cancelled'", async () => {
		const confirmDiscard = vi.fn(async () => false);
		const switchRoot = vi.fn(async () => undefined);
		const onError = vi.fn();

		await expect(
			handleRootSwitchRequest(payload, { confirmDiscard, switchRoot, onError })
		).resolves.toBe('cancelled');

		expect(confirmDiscard).toHaveBeenCalledTimes(1);
		expect(switchRoot).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});

	test('confirmDiscard が reject しても(契約上は起きない)switchRoot は呼ばず、reject しない', async () => {
		const confirmDiscard = vi.fn(async (): Promise<boolean> => {
			throw new Error('guard broke');
		});
		const switchRoot = vi.fn(async () => undefined);

		await expect(
			handleRootSwitchRequest(payload, { confirmDiscard, switchRoot })
		).resolves.toBeDefined();

		expect(switchRoot).not.toHaveBeenCalled();
	});
});

describe('AC-48-追m (b)(c): 確認が true になってから切り替えを頼む', () => {
	test("confirmDiscard → true: switchRoot(root_uri) を 1 回呼び 'switched'", async () => {
		const confirmDiscard = vi.fn(async () => true);
		const switchRoot = vi.fn(async () => undefined);

		await expect(
			handleRootSwitchRequest(payload, { confirmDiscard, switchRoot })
		).resolves.toBe('switched');

		expect(switchRoot).toHaveBeenCalledTimes(1);
		expect(switchRoot).toHaveBeenCalledWith(NEW_ROOT);
	});

	test('確認が解決するまで switchRoot を呼ばない(保存を選んだときは保存の完了を関門が待つ)', async () => {
		const gate = deferred<boolean>();
		const confirmDiscard = vi.fn(() => gate.promise);
		const switchRoot = vi.fn(async () => undefined);

		const outcome = handleRootSwitchRequest(payload, { confirmDiscard, switchRoot });
		await flush();
		expect(switchRoot).not.toHaveBeenCalled();

		gate.resolve(true);
		await expect(outcome).resolves.toBe('switched');
		expect(switchRoot).toHaveBeenCalledTimes(1);
		expect(switchRoot).toHaveBeenCalledWith(NEW_ROOT);
	});

	test('確認を待っている間に false が返れば、そのまま何も頼まない', async () => {
		const gate = deferred<boolean>();
		const confirmDiscard = vi.fn(() => gate.promise);
		const switchRoot = vi.fn(async () => undefined);

		const outcome = handleRootSwitchRequest(payload, { confirmDiscard, switchRoot });
		await flush();
		gate.resolve(false);

		await expect(outcome).resolves.toBe('cancelled');
		expect(switchRoot).not.toHaveBeenCalled();
	});

	test("switchRoot が reject → onError(err) を 1 回呼んで 'failed'(reject しない)", async () => {
		const confirmDiscard = vi.fn(async () => true);
		const switchRoot = vi.fn(async () => {
			throw 'LIST_ERROR: gone';
		});
		const onError = vi.fn();

		await expect(
			handleRootSwitchRequest(payload, { confirmDiscard, switchRoot, onError })
		).resolves.toBe('failed');

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith('LIST_ERROR: gone');
	});

	test('switchRoot が reject しても onError を省いていれば外へ投げない', async () => {
		const confirmDiscard = vi.fn(async () => true);
		const switchRoot = vi.fn(async () => {
			throw new Error('gone');
		});

		await expect(
			handleRootSwitchRequest(payload, { confirmDiscard, switchRoot })
		).resolves.toBe('failed');
	});
});

// ---------------------------------------------------------------------------
// 購読(registerRootSwitchRequestListener)
// ---------------------------------------------------------------------------

describe('AC-48-追m: 依頼の購読(registerRootSwitchRequestListener)', () => {
	test('$lib/events の listen で ROOT_SWITCH_REQUESTED_EVENT を 1 回購読し、解除を返す', async () => {
		const unlisten = vi.fn();
		listenMock.mockResolvedValueOnce(unlisten);

		const dispose = await registerRootSwitchRequestListener({
			confirmDiscard: vi.fn(async () => true),
			switchRoot: vi.fn(async () => undefined),
		});

		expect(listenMock).toHaveBeenCalledTimes(1);
		expect(listenMock.mock.calls[0][0]).toBe('root_switch_requested');
		expect(unlisten).not.toHaveBeenCalled();
		dispose();
		expect(unlisten).toHaveBeenCalledTimes(1);
	});

	test('届いた payload の root_uri をそのまま判断に渡す(確認 → switchRoot(root_uri))', async () => {
		const confirmDiscard = vi.fn(async () => true);
		const switchRoot = vi.fn(async () => undefined);
		await registerRootSwitchRequestListener({ confirmDiscard, switchRoot });

		const handler = listenMock.mock.calls[0][1] as (e: { payload: RootSwitchRequestPayload }) => unknown;
		await handler({ payload });

		expect(confirmDiscard).toHaveBeenCalledTimes(1);
		expect(switchRoot).toHaveBeenCalledTimes(1);
		expect(switchRoot).toHaveBeenCalledWith(NEW_ROOT);
	});

	test('届いても確認が false なら switchRoot は呼ばれない', async () => {
		const confirmDiscard = vi.fn(async () => false);
		const switchRoot = vi.fn(async () => undefined);
		await registerRootSwitchRequestListener({ confirmDiscard, switchRoot });

		const handler = listenMock.mock.calls[0][1] as (e: { payload: RootSwitchRequestPayload }) => unknown;
		await handler({ payload });

		expect(switchRoot).not.toHaveBeenCalled();
	});

	test('switchRoot の失敗は onError に渡り、ハンドラから外へ出ない', async () => {
		const onError = vi.fn();
		await registerRootSwitchRequestListener({
			confirmDiscard: vi.fn(async () => true),
			switchRoot: vi.fn(async () => {
				throw new Error('gone');
			}),
			onError,
		});

		const handler = listenMock.mock.calls[0][1] as (e: { payload: RootSwitchRequestPayload }) => unknown;
		// 登録したハンドラは handleRootSwitchRequest の Promise を返す(契約)= 'failed' に解決し、reject しない
		await expect(Promise.resolve(handler({ payload }))).resolves.toBe('failed');
		expect(onError).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// +page.svelte の配線(ソース走査= update-banner-ready.acceptance.test.ts の作法)
// ---------------------------------------------------------------------------

const PAGE_PATH = resolve(__dirname, '../routes/+page.svelte');

/** `<script ...>…</script>` の中身(最初のブロック=`lang="ts"` のもの)。 */
function scriptOf(source: string): string {
	const m = source.match(/<script[^>]*>([\s\S]*?)<\/script>/);
	expect(m, '+page.svelte に <script> ブロックがある').not.toBeNull();
	return m![1];
}

/** コメントを空白に落とす(文字列リテラルは残す)。文字数と改行の位置を保つ。 */
function stripComments(code: string): string {
	let out = '';
	let i = 0;
	const blank = (c: string) => (c === '\n' ? '\n' : ' ');
	while (i < code.length) {
		const ch = code[i];
		const next = code[i + 1];
		if (ch === '/' && next === '/') {
			while (i < code.length && code[i] !== '\n') {
				out += ' ';
				i++;
			}
			continue;
		}
		if (ch === '/' && next === '*') {
			const end = code.indexOf('*/', i + 2);
			const stop = end < 0 ? code.length : end + 2;
			for (; i < stop; i++) out += blank(code[i]);
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			const quote = ch;
			out += quote;
			i++;
			while (i < code.length && code[i] !== quote) {
				if (code[i] === '\\') {
					out += code[i];
					i++;
					if (i >= code.length) break;
				}
				out += code[i];
				i++;
			}
			out += quote;
			i++;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** `open`(`(`)から対応する `)` までの呼び出し全体。 */
function balancedCall(code: string, open: number): string {
	expect(code[open]).toBe('(');
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		const c = code[i];
		if (c === '(' || c === '{' || c === '[') depth++;
		else if (c === ')' || c === '}' || c === ']') {
			depth--;
			if (depth === 0) return code.slice(open, i + 1);
		}
	}
	throw new Error(`unbalanced call at ${open}`);
}

/** `name(` / `name<T>(` の呼び出しをすべて(引数部分の全文)取り出す。 */
function callsOf(code: string, name: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`(?<![\\w$.])${name}\\s*(?:<[^()]*>)?\\s*\\(`, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(code)) !== null) {
		const open = m.index + m[0].length - 1;
		out.push(balancedCall(code, open));
	}
	return out;
}

function pageScript(): string {
	return stripComments(scriptOf(readFileSync(PAGE_PATH, 'utf-8')));
}

describe('AC-48-追m: +page.svelte の配線(ソース走査)', () => {
	test('$lib/root-switch-request から registerRootSwitchRequestListener と switchRootConfirmed を import している', () => {
		const script = pageScript();
		const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]\$lib\/root-switch-request['"]/;
		const m = script.match(importRe);
		expect(m, "+page.svelte must import from '$lib/root-switch-request'").not.toBeNull();
		const names = m![1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]);
		expect(names).toContain('registerRootSwitchRequestListener');
		expect(names).toContain('switchRootConfirmed');
	});

	test('registerRootSwitchRequestListener を 1 回呼び、confirmDiscard: confirmDiscardEdits を渡す', () => {
		const script = pageScript();
		const calls = callsOf(script, 'registerRootSwitchRequestListener');
		expect(calls, 'exactly one registerRootSwitchRequestListener(...) in +page.svelte').toHaveLength(1);
		const compact = calls[0].replace(/\s+/g, '');
		expect(compact).toContain('confirmDiscard:confirmDiscardEdits');
	});

	test('同じ呼び出しで switchRoot に switchRootConfirmed(または switch_root_confirmed の invoke)を渡す', () => {
		const script = pageScript();
		const call = callsOf(script, 'registerRootSwitchRequestListener')[0];
		expect(call).toBeDefined();
		const compact = call.replace(/\s+/g, '');
		const direct = compact.includes('switchRoot:switchRootConfirmed');
		const wrapped = /switchRoot:[^,}]*switchRootConfirmed\(/.test(compact);
		const viaInvoke = /switchRoot:[^}]*invoke[^}]*['"]switch_root_confirmed['"]/.test(compact);
		expect(
			direct || wrapped || viaInvoke,
			'switchRoot must reach the switch_root_confirmed command'
		).toBe(true);
	});

	test("不変(契約5): listen<RootPayload>('root_changed', …) の購読は残り、その中で windowState.applyRoot を呼ぶ", () => {
		const script = pageScript();
		const listens = callsOf(script, 'listen').filter((c) => /^\(\s*['"]root_changed['"]/.test(c));
		expect(listens, "exactly one listen('root_changed', …) in +page.svelte").toHaveLength(1);
		expect(listens[0]).toContain('windowState.applyRoot(');
		// 確認は依頼の側で済んでいる — 反映の購読に関門を挟まない(今と同じ反映)
		expect(listens[0]).not.toContain('confirmDiscardEdits');
	});
});
