/**
 * 要件#71 の受け入れテスト(docs/requirements/req-71.md)— フロントの純ロジック側
 * (unit プロジェクト)
 *
 * 「ファイルやフォルダを開けなかったときは利用者に知らせ、いま開いている文書の表示と
 * 変更追従を保つ」。コンポーネントの配線(ツリー・内部リンク・Find in Folder・goUp・
 * Shift + クリック)は src/components/open-failure.wiring.test.ts。ここは **`+page.svelte`
 * の中にあってマウントでは試せない 2 つの経路**(履歴選択画面のフォルダ選択=契約3 後半・
 * 起動処理の最初の文書=契約5)を、`$lib` に切り出した関数で判定し、`+page.svelte` が
 * その関数を使うことをソース走査で固定する(AC-55-24 / AC-64-18 の家風)。あわせて文言の
 * 値(契約2〜5・7)を固定する。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする名前・公開パス)
 *
 * ```ts
 * // --- src/lib/open-document.ts(既存ファイルに追加。openForDisplay / openCommandFor は不変)---
 * /** この窓で文書を開けなかったときの alert の文言。Recent Files の
 *  *  `recentFileOpenFailedMessage` と同じ値(契約2・5・7)。 *\/
 * export function openFileFailedMessage(err: unknown): string; // `Could not open the file: ${err}`
 *
 * export type OpenInitialDocumentDeps<Doc = DocumentPayload> = {
 *   open: (uri: string) => Promise<Doc>;          // +page は openForDisplay
 *   setDocument: (doc: Doc) => void;              // +page は windowState.setDocument
 *   onOpenFailed: (message: string) => void;      // +page は alert(整形済みの文言が渡る)
 * };
 * /** 起動処理の最初の文書(契約5)。initialPath が無ければ何もせず false。開けたら
 *  *  setDocument して true。開けなければ onOpenFailed(openFileFailedMessage(err)) を 1 回
 *  *  呼んで false。**決して reject しない**(起動処理を止めない)。 *\/
 * export async function openInitialDocument<Doc = DocumentPayload>(
 *   initialPath: string | null | undefined,
 *   deps: OpenInitialDocumentDeps<Doc>
 * ): Promise<boolean>;
 *
 * // --- src/lib/root-picker.ts(既存ファイルに追加。loadHistory / openHistoryEntry / toPickerEntries は不変)---
 * /** フォルダを開けなかったときの文言(契約3)。履歴から開けなかったときの既存の注記と同じ値。 *\/
 * export function openFolderFailedMessage(err: unknown): string; // `Could not open the folder: ${err}`
 *
 * export type PickFolderDeps<Root = unknown> = {
 *   confirmDiscard: () => Promise<boolean>;       // +page は confirmDiscardEdits
 *   pickFolder: () => Promise<string | null>;     // OS のフォルダダイアログ。選んだ**パス**(URI でない)・取消は null
 *   setRoot: (uri: string) => Promise<Root>;      // +page は invoke('set_root', { uri })
 * };
 * export type PickFolderOutcome<Root = unknown> =
 *   | { kind: 'applied'; root: Root }
 *   | { kind: 'cancelled' }
 *   | { kind: 'failed'; message: string };        // message = openFolderFailedMessage(err)
 * /** 履歴選択画面の「Select Folder…」(契約3)。confirm が false / 取消 → cancelled・
 *  *  setRoot(`file://${path}`) が成功 → applied・失敗 → failed(**reject しない**)。 *\/
 * export async function pickFolderAndSetRoot<Root = unknown>(deps: PickFolderDeps<Root>): Promise<PickFolderOutcome<Root>>;
 *
 * // --- src/routes/+page.svelte ---
 * //   - `pickFolderAndSetRoot` を `$lib/root-picker` から import して「Select Folder…」の受け口で呼び、
 * //     failed のときは `rootPicker.error` に message を入れる(選択画面は閉じない)。
 * //     `<RootPicker … error={rootPicker.error} … onPickFolder={…}>` は従来どおり
 * //   - 起動処理(onMount)は `await openInitialDocument(init.initial_path, { …, onOpenFailed })` を呼び、
 * //     開けなくても最後まで進む。従来の `windowState.setDocument(await openForDisplay(init.initial_path))`
 * //     は残さない
 * //   - **追補a(1)・AC-71-7(backlog 276)**: `onOpenFailed` は alert を呼ばず、文言を `let` の変数に
 * //     **控える**だけ(`onOpenFailed: (message) => { <変数> = message; }` の形。変数名は自由)。
 * //     alert(<変数>) は、`root_changed` / `file_changed` / `binary_file_changed` / `file_removed` /
 * //     `directory_changed` の 5 つの購読の登録と `startupSettled = true` の **あと** に 1 か所だけ置く
 * //     (alert は閉じるまで JS を止めるので、先に出すとその間に届いた変更を購読が無くて取りこぼす)。
 * //     文言は契約5 のまま(`openInitialDocument` が `openFileFailedMessage` で整形して渡す)
 * ```
 *
 * ## 判定しないもの
 * - 実際の起動で窓が残ること・Shift + クリック / Command + クリック / `vellis <開けないファイル>`
 *   の各入口 → 人間ゲート(req-71.md)
 * - `openFromHistory`(履歴から開けなかったときの注記)は既存どおりで不変(契約7・reviewer 照合)
 *
 * ## スタブの設計
 * - $lib/ipc: モジュールモック(open-document.ts / root-picker.ts が invoke を import するため)。
 *   本ファイルの関数はすべて deps 注入なので invoke は呼ばれない
 * - `$lib/open-document` / `$lib/root-picker` は **名前空間 import**: 未実装でもファイルの読み込みは
 *   失敗せず、該当ケースだけが赤になる(FindInFolder.wiring の家風)
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import * as openDocumentModule from './open-document';
import * as rootPickerModule from './root-picker';
import { recentFileOpenFailedMessage } from './recent-files';
import { openInNewWindowFailedMessage } from './open-in-new-window';

const invokeMock = vi.mocked(invoke);

/** CJK を含まない=英語の判定(要件#51 の走査と同じ考え方)。 */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

// 未実装なら実行時に undefined(該当ケースが「関数でない」で赤になる。`pnpm check` も
// 実装までは赤=FindInFolder.wiring の `findInFolderModule.resetSearchScope` と同じ家風)。
const openFileFailedMessage = openDocumentModule.openFileFailedMessage;
const openInitialDocument = openDocumentModule.openInitialDocument;
const openFolderFailedMessage = rootPickerModule.openFolderFailedMessage;
const pickFolderAndSetRoot = rootPickerModule.pickFolderAndSetRoot;

function mustBeFunction<T>(fn: T, name: string): NonNullable<T> {
	if (typeof fn !== 'function') throw new Error(`${name} must be exported (要件#71)`);
	return fn as NonNullable<T>;
}

const OPEN_REASON = 'invalid UTF-8: file:///Users/x/notes/sjis.txt';
const FOLDER_REASON = 'I/O error: No path was found (os error 2): file:///Users/x/gone';

beforeEach(() => {
	invokeMock.mockReset();
});

// ---------------------------------------------------------------------------
// 文言(契約2〜5・7)— 値固定・既存の文言関数と一致・英語
// ---------------------------------------------------------------------------

describe('要件#71 文言: 既存の値と同じ文字列を 1 か所の関数で持つ(契約2〜5・7)', () => {
	test('openFileFailedMessage は `Could not open the file: <err>`(Recent Files の文言と同じ値)', () => {
		const fn = mustBeFunction(openFileFailedMessage, 'openFileFailedMessage ($lib/open-document)');
		expect(fn(OPEN_REASON)).toBe(`Could not open the file: ${OPEN_REASON}`);
		expect(fn(new Error('boom'))).toBe('Could not open the file: Error: boom');
		for (const err of [OPEN_REASON, new Error('boom'), 'x']) {
			expect(fn(err)).toBe(recentFileOpenFailedMessage(err));
		}
		expect(fn('x')).not.toMatch(CJK);
	});

	test('openFolderFailedMessage は `Could not open the folder: <err>`(履歴から開けなかったときの注記と同じ値)', () => {
		const fn = mustBeFunction(openFolderFailedMessage, 'openFolderFailedMessage ($lib/root-picker)');
		expect(fn(FOLDER_REASON)).toBe(`Could not open the folder: ${FOLDER_REASON}`);
		expect(fn(new Error('boom'))).toBe('Could not open the folder: Error: boom');
		expect(fn('x')).not.toMatch(CJK);
	});

	test('既存の文言は不変(契約7): Recent Files・新しい窓', () => {
		expect(recentFileOpenFailedMessage('r')).toBe('Could not open the file: r');
		expect(openInNewWindowFailedMessage('r')).toBe('Could not open a new window: r');
	});
});

// ---------------------------------------------------------------------------
// AC-71-3(後半)— 履歴選択画面のフォルダ選択で set_root が失敗(契約3・6)
// ---------------------------------------------------------------------------

describe('AC-71-3: pickFolderAndSetRoot — set_root の失敗は failed(注記の文言)で返り、reject しない(契約3・6)', () => {
	type Root = { root_uri: string; entries: unknown[]; document_retained: boolean };
	type Deps = {
		confirmDiscard: () => Promise<boolean>;
		pickFolder: () => Promise<string | null>;
		setRoot: (uri: string) => Promise<Root>;
	};
	const ROOT: Root = { root_uri: 'file:///Users/x/gone', entries: [], document_retained: false };

	function deps(overrides: Partial<Deps> = {}) {
		const base = {
			confirmDiscard: vi.fn<() => Promise<boolean>>(async () => true),
			pickFolder: vi.fn<() => Promise<string | null>>(async () => '/Users/x/gone'),
			setRoot: vi.fn<(uri: string) => Promise<Root>>(async () => ROOT),
		};
		if (overrides.confirmDiscard) base.confirmDiscard.mockImplementation(overrides.confirmDiscard);
		if (overrides.pickFolder) base.pickFolder.mockImplementation(overrides.pickFolder);
		if (overrides.setRoot) base.setRoot.mockImplementation(overrides.setRoot);
		return base;
	}

	test('setRoot が reject → { kind: "failed", message: "Could not open the folder: <理由>" }・reject しない', async () => {
		const fn = mustBeFunction(pickFolderAndSetRoot, 'pickFolderAndSetRoot ($lib/root-picker)');
		const d = deps({ setRoot: vi.fn(async () => Promise.reject(FOLDER_REASON)) });

		const outcome = await fn(d);

		expect(outcome).toEqual({ kind: 'failed', message: `Could not open the folder: ${FOLDER_REASON}` });
		expect(d.setRoot).toHaveBeenCalledTimes(1);
		expect(d.setRoot).toHaveBeenCalledWith('file:///Users/x/gone');
		expect((outcome as { message: string }).message).not.toMatch(CJK);
	});

	test('setRoot が成功 → { kind: "applied", root } に解決値がそのまま入る', async () => {
		const fn = mustBeFunction(pickFolderAndSetRoot, 'pickFolderAndSetRoot ($lib/root-picker)');
		const root = { root_uri: 'file:///Users/x/gone', entries: [], document_retained: false };
		const d = deps({ setRoot: vi.fn(async () => root) });

		await expect(fn(d)).resolves.toEqual({ kind: 'applied', root });
		expect(d.confirmDiscard).toHaveBeenCalledTimes(1);
		expect(d.pickFolder).toHaveBeenCalledTimes(1);
	});

	test('ダイアログの取消(null)→ cancelled・setRoot は呼ばない', async () => {
		const fn = mustBeFunction(pickFolderAndSetRoot, 'pickFolderAndSetRoot ($lib/root-picker)');
		const d = deps({ pickFolder: vi.fn(async () => null) });

		await expect(fn(d)).resolves.toEqual({ kind: 'cancelled' });
		expect(d.setRoot).not.toHaveBeenCalled();
	});

	test('編集の始末で続けない(confirm=false)→ cancelled・ダイアログも setRoot も呼ばない', async () => {
		const fn = mustBeFunction(pickFolderAndSetRoot, 'pickFolderAndSetRoot ($lib/root-picker)');
		const d = deps({ confirmDiscard: vi.fn(async () => false) });

		await expect(fn(d)).resolves.toEqual({ kind: 'cancelled' });
		expect(d.pickFolder).not.toHaveBeenCalled();
		expect(d.setRoot).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-71-5 — 起動処理の最初の文書が開けない(契約5・6)
// ---------------------------------------------------------------------------

describe('AC-71-5: openInitialDocument — 開けなければ知らせて false・reject しない(契約5・6)', () => {
	const PAYLOAD = { uri: 'file:///Users/x/notes/a.md', content: '# A\n', modified: 1 };

	type Doc = typeof PAYLOAD;
	type Deps = {
		open: (uri: string) => Promise<Doc>;
		setDocument: (doc: Doc) => void;
		onOpenFailed: (message: string) => void;
	};

	function deps(overrides: Partial<Deps> = {}) {
		const base = {
			open: vi.fn<(uri: string) => Promise<Doc>>(async () => PAYLOAD),
			setDocument: vi.fn<(doc: Doc) => void>(() => {}),
			onOpenFailed: vi.fn<(message: string) => void>(() => {}),
		};
		if (overrides.open) base.open.mockImplementation(overrides.open);
		if (overrides.setDocument) base.setDocument.mockImplementation(overrides.setDocument);
		if (overrides.onOpenFailed) base.onOpenFailed.mockImplementation(overrides.onOpenFailed);
		return base;
	}

	test('open が reject → onOpenFailed("Could not open the file: <理由>")が 1 回・setDocument は呼ばない・false に解決(reject しない)', async () => {
		const fn = mustBeFunction(openInitialDocument, 'openInitialDocument ($lib/open-document)');
		const d = deps({ open: vi.fn(async () => Promise.reject(OPEN_REASON)) });

		await expect(fn('file:///Users/x/notes/sjis.txt', d)).resolves.toBe(false);

		expect(d.open).toHaveBeenCalledTimes(1);
		expect(d.open).toHaveBeenCalledWith('file:///Users/x/notes/sjis.txt');
		expect(d.setDocument).not.toHaveBeenCalled();
		expect(d.onOpenFailed).toHaveBeenCalledTimes(1);
		expect(d.onOpenFailed).toHaveBeenCalledWith(`Could not open the file: ${OPEN_REASON}`);
		expect(d.onOpenFailed).toHaveBeenCalledWith(recentFileOpenFailedMessage(OPEN_REASON));
	});

	test('open が成功 → setDocument(解決値)が 1 回・onOpenFailed は呼ばない・true', async () => {
		const fn = mustBeFunction(openInitialDocument, 'openInitialDocument ($lib/open-document)');
		const d = deps();

		await expect(fn(PAYLOAD.uri, d)).resolves.toBe(true);

		expect(d.open).toHaveBeenCalledWith(PAYLOAD.uri);
		expect(d.setDocument).toHaveBeenCalledTimes(1);
		expect(d.setDocument).toHaveBeenCalledWith(PAYLOAD);
		expect(d.onOpenFailed).not.toHaveBeenCalled();
	});

	test('initialPath が無い(null / undefined / 空文字)→ 何もせず false', async () => {
		const fn = mustBeFunction(openInitialDocument, 'openInitialDocument ($lib/open-document)');
		for (const initialPath of [null, undefined, '']) {
			const d = deps();
			await expect(fn(initialPath, d)).resolves.toBe(false);
			expect(d.open).not.toHaveBeenCalled();
			expect(d.setDocument).not.toHaveBeenCalled();
			expect(d.onOpenFailed).not.toHaveBeenCalled();
		}
	});
});

// ---------------------------------------------------------------------------
// ソース走査 — +page.svelte が切り出した関数を使い、起動処理が最後まで進む形になっている
// ---------------------------------------------------------------------------

describe('AC-71-3 / AC-71-5(ソース走査): +page.svelte が pickFolderAndSetRoot / openInitialDocument を使い、起動処理の購読と完了はその後に来る', () => {
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

	test('契約3: pickFolderAndSetRoot を $lib/root-picker から import して呼び、<RootPicker> には error と onPickFolder を渡したまま', () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*\bpickFolderAndSetRoot\b[^}]*\}\s*from\s*'\$lib\/root-picker'/);
		// import 文の外に呼び出しがある。
		const importEnd = src.indexOf("'$lib/root-picker'");
		expect(src.indexOf('pickFolderAndSetRoot(', importEnd)).toBeGreaterThan(-1);
		expect(src).toMatch(/<RootPicker[\s\S]*?error=\{rootPicker\.error\}[\s\S]*?\/>/);
		expect(src).toMatch(/<RootPicker[\s\S]*?onPickFolder=/);
	});

	// -----------------------------------------------------------------------
	// 追補a(1)・AC-71-7(backlog 276)による改訂(2026-10-05・由谷「書き換えてよい」)
	//
	// 旧・契約5 の走査は「`await openInitialDocument(` の引数に `alert` がある」「購読と
	// `startupSettled = true` はその呼び出しより後」だった。alert は閉じるまで JS を止めるので、
	// 購読の登録より先に出すと、その間に届いた `directory_changed` を取りこぼす(ツリーが古いまま)。
	// 改訂後は **alert を呼ぶのは最後の購読の登録と `startupSettled = true` より後** を固定する。
	// `openInitialDocument` を使うこと・文言が `Could not open the file:`(契約5)であることは残す
	// (文言は上の AC-71-5 のケースで `openInitialDocument` → `onOpenFailed` に渡る値として判定済み)。
	// -----------------------------------------------------------------------

	/** 起動処理の購読 5 件(`await listen<…>('<event>', …)`)の位置。無ければ -1。 */
	const STARTUP_EVENTS = ['root_changed', 'file_changed', 'binary_file_changed', 'file_removed', 'directory_changed'] as const;
	function listenAt(src: string, event: string): number {
		const m = new RegExp(`\\blisten(?:<[^(]*?>)?\\(\\s*'${event}'`).exec(src);
		return m ? m.index : -1;
	}

	/**
	 * `onOpenFailed` が文言を控える変数の名前(追補a(1) の契約)。
	 * 受け付ける形: `onOpenFailed: (message) => { startupOpenFailure = message; }` /
	 * `onOpenFailed: (message) => (startupOpenFailure = message)` / `onOpenFailed: (message) => { startupOpenFailure = message }`
	 * (引数名・変数名は自由・型注釈は任意)。alert を直接呼ぶ旧形は null。
	 */
	function deferredMessageVar(call: string): string | null {
		const m = /onOpenFailed:\s*\(\s*(\w+)(?:\s*:\s*string)?\s*\)\s*=>\s*(?:\{|\()?\s*(\w+)\s*=\s*\1\b/.exec(call);
		return m ? m[2] : null;
	}

	test('契約5(追補a(1) で改訂): openInitialDocument を $lib/open-document から import し、起動処理で await して initial_path を渡す。onOpenFailed は alert を呼ばず文言を控える', () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*\bopenInitialDocument\b[^}]*\}\s*from\s*'\$lib\/open-document'/);
		const callAt = src.indexOf('await openInitialDocument(');
		expect(callAt, 'the startup must await openInitialDocument(…)').toBeGreaterThan(-1);
		const call = balancedCall(src, callAt);
		expect(call).toContain('init.initial_path');
		expect(call).toMatch(/\bonOpenFailed\b/);
		// 追補a(1): 呼び出しの中(onOpenFailed を含む)では alert を呼ばない=文言を控えるだけ。
		expect(call, 'onOpenFailed must not alert inside openInitialDocument(…) (backlog 276)').not.toMatch(/\balert\s*\(/);
		const varName = deferredMessageVar(call);
		expect(varName, 'onOpenFailed must store the message into a variable: (message) => { <var> = message; }').not.toBeNull();
		// 控える先はコンポーネントのローカル変数(let)。
		expect(src).toMatch(new RegExp(`\\blet\\s+${varName}\\b`));
		// 従来の「開けなければそこで止まる」形は残さない。
		expect(src).not.toContain('setDocument(await openForDisplay(init.initial_path))');
	});

	test('AC-71-7(追補a(1)): 控えた文言の alert は、5 つの購読の登録と startupSettled = true の後に 1 か所だけ(購読は openInitialDocument の後に残る)', () => {
		const src = page();
		const callAt = src.indexOf('await openInitialDocument(');
		expect(callAt).toBeGreaterThan(-1);
		const varName = deferredMessageVar(balancedCall(src, callAt));
		expect(varName, 'onOpenFailed must store the message into a variable (see the previous case)').not.toBeNull();

		// 購読 5 件はどれも残り、openInitialDocument の後に登録される(旧・契約5 の順序は保つ)。
		let lastListenAt = -1;
		for (const event of STARTUP_EVENTS) {
			const at = listenAt(src, event);
			expect(at, `listen('${event}') must still be registered`).toBeGreaterThan(-1);
			expect(at, `listen('${event}') must come after openInitialDocument`).toBeGreaterThan(callAt);
			lastListenAt = Math.max(lastListenAt, at);
		}
		const settledAt = src.indexOf('startupSettled = true');
		expect(settledAt, 'startupSettled = true must remain').toBeGreaterThan(callAt);

		// alert(<控えた変数>) は 1 か所だけで、最後の購読の登録と startupSettled = true の両方より後。
		const alertRe = new RegExp(`\\balert\\(\\s*${varName}\\s*!?\\s*\\)`, 'g');
		const alerts = [...src.matchAll(alertRe)].map((m) => m.index ?? -1);
		expect(alerts, `exactly one alert(${varName}) is expected`).toHaveLength(1);
		const alertAt = alerts[0];
		expect(alertAt, 'the deferred alert must come after the last startup listen (directory_changed etc.)').toBeGreaterThan(lastListenAt);
		expect(alertAt, 'the deferred alert must come after startupSettled = true').toBeGreaterThan(settledAt);
		// 控えた文言以外の alert を起動処理の失敗で出さない(旧形 `onOpenFailed: (m) => alert(m)` の残留を禁じる)。
		expect(src.slice(callAt, balancedCall(src, callAt).length + callAt)).not.toMatch(/\balert\s*\(/);
	});
});
