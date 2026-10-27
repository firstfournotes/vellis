/**
 * 要件#10 追補a の受け入れテスト(docs/requirements/req-10.md「追補a」= Issue #382)
 * 「reload の復元で root は戻せたが文書を開き直せなかったとき、起動時の最初の文書を
 *  開けなかったときと同じ知らせ(alert・`Could not open the file: <理由>`)を 1 回出す」
 *
 * 既存の `reload-state.acceptance.test.ts` は無改変(AC-10-追a (d))。本ファイルは知らせの
 * 口だけを足して判定する。復元の順序・失敗の粒度(root は戻したまま文書だけ閉じる)・
 * `{ ok: false }` への全体フォールバックは既存テストの判定のまま(追補a 3)。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * 知らせの口は、起動時の最初の文書の既存の作法(`openInitialDocument` の
 * `OpenInitialDocumentDeps.onOpenFailed`= src/lib/open-failure.acceptance.test.ts)に揃え、
 * **注入**で表す。戻り値の形(`RestoreResult`)は変えない。
 *
 * ```ts
 * // --- src/lib/reload-state.ts(既存ファイルに追加。他の公開 API は不変)---
 * /** `restoreSnapshot` が文書を開き直せなかったときに知らせる手段(+page は控えて alert)。 *\/
 * export type RestoreSnapshotDeps = {
 *   /** 文書コマンドが失敗したとき。整形済みの文言(`openFileFailedMessage(err)`)が渡る。 *\/
 *   onOpenFailed: (message: string) => void;
 * };
 * export async function restoreSnapshot<Root = unknown, Doc = unknown>(
 *   snapshot: ReloadSnapshot,
 *   deps?: RestoreSnapshotDeps,            // 省略可=既存の 1 引数の呼び出しとテストはそのまま
 * ): Promise<RestoreResult<Root, Doc>>;
 * ```
 *
 * - `set_root` 成功 → 文書コマンド(`openCommandFor(docUri)`= `open_document` /
 *   `open_binary_document`)が reject → `deps.onOpenFailed(openFileFailedMessage(err))` を
 *   **1 回**呼び、従来どおり `{ ok: true, root, document: null }` に解決する(reject しない)。
 *   `err` は reject の値そのまま(Rust のエラー文の素通し=要件#51)
 * - 文書コマンドが成功したとき・`docUri === null` のとき → `onOpenFailed` は呼ばない
 * - `set_root` が reject → 従来どおり `{ ok: false }`・文書コマンドは呼ばない・`onOpenFailed`
 *   も呼ばない(追補a 2: root ごと戻せなかったときは何も出さない)
 * - `deps` 省略時は知らせずに従来どおり動く(既存テストの前提)
 *
 * ```ts
 * // --- src/routes/+page.svelte(起動処理)---
 * //   `await restoreSnapshot<…>(snapshot, { onOpenFailed: (message) => { <変数> = message; } })` の形で
 * //   知らせの口を渡す。alert は呼び出しの中では呼ばず、起動時の最初の文書と同じく **文言を
 * //   `let` の変数に控え**、5 つの購読の登録と `startupSettled = true` の後に `alert(<変数>)` を
 * //   1 か所だけ置く(AC-71-7 と同じ理由: alert は閉じるまで JS を止めるので、購読より先に
 * //   出すとその間の変更を取りこぼす)。起動時の最初の文書と同じ変数(`startupOpenFailure`)を
 * //   使い回してよい — 復元の経路では openInitialDocument は呼ばれないので 2 回にはならない
 * ```
 *
 * ## 判定しないもの
 * - 実機で alert が 1 回出ること(文書を消して reload)→ 人間ゲート(req-10.md)
 * - `clearSnapshot` の呼び方・履歴選択画面の抑止(追補a 3 の不変)→ 既存テスト・reviewer 照合
 *
 * ## スタブの設計
 * - $lib/ipc: モジュールモック(既存の reload-state テストと同じ家風)。`set_root` と
 *   文書コマンドを順に解決/拒否させる
 * - `onOpenFailed` は vi.fn で受け、呼ばれた回数と文言を判定する
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import { restoreSnapshot } from './reload-state';
import { openFileFailedMessage } from './open-document';
import { recentFileOpenFailedMessage } from './recent-files';

const invokeMock = vi.mocked(invoke);

/** CJK を含まない=英語の判定(要件#51 の走査と同じ考え方)。 */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

// backend の URI 表現に合わせた生文字列(既存の reload-state テストと同じ前提)
const ROOT = 'file:///Users/a/work';
const DOC = `${ROOT}/notes/plan.md`;
const PHOTO = `${ROOT}/notes/photo.png`; // ラスタ画像=open_binary_document の経路(要件#22)
const NOTES = `${ROOT}/notes`;

const rootPayload = { root_uri: ROOT, entries: [], document_retained: false };
const docPayload = { uri: DOC, content: '# plan', modified: null };

// Rust のエラー文をそのまま挟む(要件#51 の素通し)。
const GONE = 'I/O error: No such file or directory (os error 2): file:///Users/a/work/notes/plan.md';

/** 知らせの口(`RestoreSnapshotDeps` の形)。呼ばれた回数と文言を判定する。 */
function deps() {
	return { onOpenFailed: vi.fn<(message: string) => void>(() => {}) };
}

beforeEach(() => {
	sessionStorage.clear();
	invokeMock.mockReset();
});

// ---------------------------------------------------------------------------
// AC-10-追a (a) — 文書コマンドの失敗は知らせの口へ 1 回・root は戻ったまま・文書は無し
// ---------------------------------------------------------------------------

describe('AC-10-追a (a): restoreSnapshot — open_document が失敗すると onOpenFailed を 1 回呼び、root は戻ったまま文書は開かない', () => {
	const snapWithDoc = { rootUri: ROOT, docUri: DOC, expandedDirs: [NOTES] };

	test('open_document が reject(文字列の理由)→ onOpenFailed("Could not open the file: <理由>")が 1 回', async () => {
		invokeMock.mockResolvedValueOnce(rootPayload).mockRejectedValueOnce(GONE);
		const d = deps();

		const res = await restoreSnapshot(snapWithDoc, d);

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root', 'open_document']);
		expect(d.onOpenFailed).toHaveBeenCalledTimes(1);
		expect(d.onOpenFailed).toHaveBeenCalledWith(`Could not open the file: ${GONE}`);
		// 起動時の最初の文書・Recent Files と同じ文言関数の値(要件#71 契約7 と同じ揃え方)。
		expect(d.onOpenFailed).toHaveBeenCalledWith(openFileFailedMessage(GONE));
		expect(d.onOpenFailed).toHaveBeenCalledWith(recentFileOpenFailedMessage(GONE));
		expect(d.onOpenFailed.mock.calls[0]?.[0]).not.toMatch(CJK);

		// 失敗の粒度は不変(追補a 3): root は戻ったまま・文書だけ閉じた状態・reject しない。
		expect(res).toMatchObject({ ok: true, document: null });
		if (res.ok) expect(res.root).toEqual(rootPayload);
	});

	test('open_document が reject(Error)→ 理由は `${err}` の素通し(Error: …)', async () => {
		invokeMock.mockResolvedValueOnce(rootPayload).mockRejectedValueOnce(new Error('no such file'));
		const d = deps();

		await expect(restoreSnapshot(snapWithDoc, d)).resolves.toMatchObject({ ok: true, document: null });

		expect(d.onOpenFailed).toHaveBeenCalledTimes(1);
		expect(d.onOpenFailed).toHaveBeenCalledWith('Could not open the file: Error: no such file');
	});

	test('ラスタ画像(open_binary_document)が reject しても同じ知らせ(文書コマンドの失敗は 1 本の経路)', async () => {
		invokeMock.mockResolvedValueOnce(rootPayload).mockRejectedValueOnce(GONE);
		const d = deps();

		const res = await restoreSnapshot({ rootUri: ROOT, docUri: PHOTO, expandedDirs: [] }, d);

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root', 'open_binary_document']);
		expect(d.onOpenFailed).toHaveBeenCalledTimes(1);
		expect(d.onOpenFailed).toHaveBeenCalledWith(`Could not open the file: ${GONE}`);
		expect(res).toMatchObject({ ok: true, document: null });
	});

	test('onOpenFailed の知らせは文書コマンドの失敗のあと(set_root の前には呼ばれない)', async () => {
		const order: string[] = [];
		invokeMock.mockImplementation(async (cmd: string) => {
			order.push(cmd);
			if (cmd === 'set_root') return rootPayload;
			throw GONE;
		});
		const d = deps();
		d.onOpenFailed.mockImplementation(() => {
			order.push('onOpenFailed');
		});

		await restoreSnapshot(snapWithDoc, d);

		expect(order).toEqual(['set_root', 'open_document', 'onOpenFailed']);
	});
});

// ---------------------------------------------------------------------------
// AC-10-追a (b) — 文書も開けたとき・スナップショットに文書が無いときは知らせない
// ---------------------------------------------------------------------------

describe('AC-10-追a (b): 文書も開けた・文書が無い → onOpenFailed は呼ばれない', () => {
	test('set_root → open_document の両方が成功 → 知らせない・両方の解決値を返す', async () => {
		invokeMock.mockResolvedValueOnce(rootPayload).mockResolvedValueOnce(docPayload);
		const d = deps();

		const res = await restoreSnapshot({ rootUri: ROOT, docUri: DOC, expandedDirs: [NOTES] }, d);

		expect(d.onOpenFailed).not.toHaveBeenCalled();
		expect(res).toMatchObject({ ok: true });
		if (res.ok) {
			expect(res.root).toEqual(rootPayload);
			expect(res.document).toEqual(docPayload);
		}
	});

	test('docUri=null(文書を開いていなかった)→ 文書コマンドを呼ばず・知らせない', async () => {
		invokeMock.mockResolvedValueOnce(rootPayload);
		const d = deps();

		const res = await restoreSnapshot({ rootUri: ROOT, docUri: null, expandedDirs: [] }, d);

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root']);
		expect(d.onOpenFailed).not.toHaveBeenCalled();
		expect(res).toMatchObject({ ok: true, document: null });
	});
});

// ---------------------------------------------------------------------------
// AC-10-追a (c) — root の復元が失敗したときは知らせない(全体フォールバックは従来どおり)
// ---------------------------------------------------------------------------

describe('AC-10-追a (c): set_root の失敗 → {ok:false}・文書コマンドも onOpenFailed も呼ばない', () => {
	test('set_root が reject → 何も知らせず {ok:false} に解決する(起動時引数の挙動へ)', async () => {
		invokeMock.mockRejectedValueOnce('I/O error: No path was found (os error 2): file:///Users/a/work');
		const d = deps();

		await expect(
			restoreSnapshot({ rootUri: ROOT, docUri: DOC, expandedDirs: [NOTES] }, d),
		).resolves.toMatchObject({ ok: false });

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root']);
		expect(d.onOpenFailed).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 後方互換 — deps 省略時は従来どおり(既存テスト AC-10-追a (d) の前提を明示)
// ---------------------------------------------------------------------------

describe('deps 省略時は従来どおり(既存の 1 引数の呼び出しを壊さない)', () => {
	test('open_document が失敗しても reject せず {ok:true, document:null}', async () => {
		invokeMock.mockResolvedValueOnce(rootPayload).mockRejectedValueOnce(GONE);

		const res = await restoreSnapshot({ rootUri: ROOT, docUri: DOC, expandedDirs: [] });

		expect(res).toMatchObject({ ok: true, document: null });
		if (res.ok) expect(res.root).toEqual(rootPayload);
	});
});

// ---------------------------------------------------------------------------
// ソース走査 — +page.svelte が restoreSnapshot に知らせの口を渡し、控えた文言を alert に繋ぐ
// (AC-71-5 / AC-71-7 の走査と同じ家風)
// ---------------------------------------------------------------------------

describe('AC-10-追a(ソース走査): +page.svelte は restoreSnapshot に onOpenFailed を渡して文言を控え、購読の登録後に alert へ繋ぐ', () => {
	const page = () => readFileSync(resolve(__dirname, '../routes/+page.svelte'), 'utf-8');

	/** `start` から最初の `(` に対応する閉じ括弧までの呼び出し全体。 */
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

	/** 起動処理の購読 5 件(`await listen<…>('<event>', …)`)の位置。無ければ -1。 */
	const STARTUP_EVENTS = ['root_changed', 'file_changed', 'binary_file_changed', 'file_removed', 'directory_changed'] as const;
	function listenAt(src: string, event: string): number {
		const m = new RegExp(`\\blisten(?:<[^(]*?>)?\\(\\s*'${event}'`).exec(src);
		return m ? m.index : -1;
	}

	/**
	 * `onOpenFailed` が文言を控える変数の名前(AC-71-5 の走査と同じ受け付け形)。
	 * `onOpenFailed: (message) => { <var> = message; }` / `(message) => (<var> = message)`
	 * (引数名・変数名は自由・型注釈は任意)。alert を直接呼ぶ形は null。
	 */
	function deferredMessageVar(call: string): string | null {
		const m = /onOpenFailed:\s*\(\s*(\w+)(?:\s*:\s*string)?\s*\)\s*=>\s*(?:\{|\()?\s*(\w+)\s*=\s*\1\b/.exec(call);
		return m ? m[2] : null;
	}

	/** 起動処理の `await restoreSnapshot<…>(…)` / `await restoreSnapshot(…)` の位置(import 文の外)。 */
	function restoreCallAt(src: string): number {
		const m = /\bawait\s+restoreSnapshot\b/.exec(src);
		return m ? m.index : -1;
	}

	test('restoreSnapshot の呼び出しに onOpenFailed を渡し、alert は呼ばず文言を let の変数に控える', () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*\brestoreSnapshot\b[^}]*\}\s*from\s*'\$lib\/reload-state'/);
		const callAt = restoreCallAt(src);
		expect(callAt, 'the startup must await restoreSnapshot(…)').toBeGreaterThan(-1);
		const call = balancedCall(src, callAt);
		expect(call, 'restoreSnapshot(…) must receive onOpenFailed (要件#10 追補a)').toMatch(/\bonOpenFailed\b/);
		expect(call, 'onOpenFailed must not alert inside restoreSnapshot(…) (same as AC-71-7)').not.toMatch(/\balert\s*\(/);
		const varName = deferredMessageVar(call);
		expect(varName, 'onOpenFailed must store the message into a variable: (message) => { <var> = message; }').not.toBeNull();
		expect(src).toMatch(new RegExp(`\\blet\\s+${varName}\\b`));
	});

	test('控えた文言の alert は 1 か所だけで、restoreSnapshot・5 つの購読の登録・startupSettled = true の後に来る', () => {
		const src = page();
		const callAt = restoreCallAt(src);
		expect(callAt).toBeGreaterThan(-1);
		const varName = deferredMessageVar(balancedCall(src, callAt));
		expect(varName, 'onOpenFailed must store the message into a variable (see the previous case)').not.toBeNull();

		let lastListenAt = -1;
		for (const event of STARTUP_EVENTS) {
			const at = listenAt(src, event);
			expect(at, `listen('${event}') must still be registered`).toBeGreaterThan(-1);
			expect(at, `listen('${event}') must come after restoreSnapshot`).toBeGreaterThan(callAt);
			lastListenAt = Math.max(lastListenAt, at);
		}
		const settledAt = src.indexOf('startupSettled = true');
		expect(settledAt, 'startupSettled = true must remain and come after restoreSnapshot').toBeGreaterThan(callAt);

		const alertRe = new RegExp(`\\balert\\(\\s*${varName}\\s*!?\\s*\\)`, 'g');
		const alerts = [...src.matchAll(alertRe)].map((m) => m.index ?? -1);
		expect(alerts, `exactly one alert(${varName}) is expected`).toHaveLength(1);
		const alertAt = alerts[0];
		expect(alertAt, 'the deferred alert must come after the last startup listen').toBeGreaterThan(lastListenAt);
		expect(alertAt, 'the deferred alert must come after startupSettled = true').toBeGreaterThan(settledAt);
	});
});
