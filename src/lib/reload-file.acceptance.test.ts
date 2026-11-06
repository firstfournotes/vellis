/**
 * 要件#80 の受け入れテスト(docs/requirements/req-80.md)— フロント側(unit 層)
 * AC-80-6〜10・14・16(契約 1〜3・5・6・8・10・11・14・15)
 *
 * 「開いているファイルを読み直す Reload File を、View メニューと右クリックメニュー(文書の本文・Explorer の
 * ファイルの行)から実行できるようにし、ツリーも一緒に読み直す。フォルダの行とツリーの空白の右クリックには
 * Reload Folder を置く」のうち、Tauri に触れない純ロジックと配線のソース走査を判定する。
 * Explorer の項目列(AC-80-11・15)は context-menu.acceptance.test.ts、マウントしての配線(AC-80-12・13・17)は
 * src/components/ContextMenu.reload.wiring.test.ts、Rust 層(AC-80-1〜5)は src-tauri/tests/acceptance_req80.rs。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする名前・パス。新規 `src/lib/reload-file.ts`)
 *
 * ```ts
 * // 定数(Rust の menu.rs と同綴り=AC-80-5 が突き合わせる・ラベルは 3 つの入口へ配る=契約 1・14)
 * export const MENU_RELOAD_FILE_EVENT = 'menu_reload_file';
 * export const RELOAD_FILE_LABEL = 'Reload File';
 * export const RELOAD_FOLDER_LABEL = 'Reload Folder';   // context-menu.ts の LABELS['reload-folder'] と同じ値
 *
 * // 失敗の文言(理由は Rust のエラー文をそのまま挟む=要件#51 の素通し・契約 6・15)
 * export function reloadFileFailedMessage(err: unknown): string;    // `Could not reload the file: ${err}`
 * export function reloadFolderFailedMessage(err: unknown): string;  // `Could not reload the folder: ${err}`
 *
 * // Reload File の実行列(契約 3・5・6・10・11)。依存はすべて注入=ページが windowState / invoke / alert を渡す
 * export type ReloadOutcome =
 *   | 'no-document'  // 文書の無い窓(q)
 *   | 'not-open'     // target が今の文書でない(契約 9 の安全網)
 *   | 'busy'         // 読み直しの最中(契約 11)
 *   | 'cancelled'    // 未保存の確認で取り消し(契約 5)
 *   | 'failed'       // open が失敗(契約 6)
 *   | 'stale'        // 読んでいる間に外部変更が当たった / 文書が替わった(契約 11)
 *   | 'reloaded';
 * export type FileReloaderDeps<Doc> = {
 *   current: () => string | null;               // 今の文書の URI(windowState.currentDocument?.uri ?? null)
 *   confirm: () => Promise<boolean>;             // confirmDiscardEdits(契約 5)
 *   open: (uri: string) => Promise<Doc>;         // openForDisplay(open_document / open_binary_document)
 *   applyText: (doc: Doc) => void;               // テキスト系: windowState.setDocument(doc)
 *   bumpBinary: (uri: string) => void;           // バイナリ系: binaryVersion を 1 つ進める
 *   notify: (message: string) => void;           // alert
 *   changeStamp: () => number;                   // 今の文書に外部変更が当たった回数(file_changed / binary_file_changed の購読が進める)
 *   refreshTree: () => Promise<void>;            // 要件#65 の reloadTree(windowState.root, windowState.expandedDirs, io)
 * };
 * export function createFileReloader<Doc>(deps: FileReloaderDeps<Doc>): {
 *   reload: (target?: string | null) => Promise<ReloadOutcome>;   // target 省略 / null = 今の文書
 * };
 * //  手順: current() が null → 'no-document'。target があり current() と文字列で違う → 'not-open'。最中 → 'busy'。
 * //  confirm() が false → 'cancelled'(open も refreshTree も呼ばない)。true → open(uri) と refreshTree() を同時に
 * //  始め、両方が終わってから終わる(最中もそれまで)。open が reject → notify(reloadFileFailedMessage(err)) で 'failed'
 * //  (refreshTree は呼ばれている・reload は reject しない)。open が解決しても、その間に changeStamp() が進んだか
 * //  current() が変わったら当てずに 'stale'。それ以外はテキスト(readsAsText)なら applyText(doc)、バイナリなら
 * //  bumpBinary(uri) で 'reloaded'。refreshTree の失敗(reject・同期の throw)は黙って飲み、結果はファイルの側のまま。
 * //  テキストかバイナリかは $lib/image-viewing の readsAsText(= open_document / open_binary_document の選び方)と同じ規則。
 *
 * // Reload Folder の実行列(契約 11・15)。Explorer.svelte が 1 つ作る
 * export type FolderReloadOutcome = 'no-root' | 'busy' | 'expanded' | 'failed' | 'reloaded';
 * export type FolderReloaderDeps<E> = {
 *   root: () => string;                                   // windowState.root('' = 無い)
 *   expandedDirs: () => readonly string[];                // windowState.expandedDirs(変更しない)
 *   isExpanded: (uri: string) => boolean;                 // windowState.isExpanded
 *   expand: (uri: string) => void;                        // windowState.toggleExpanded(畳んであるときだけ呼ぶ)
 *   listDir: (uri: string) => Promise<E[]>;               // invoke('list_dir', { uri })
 *   apply: (uri: string, entries: E[]) => void;           // windowState.applyDirectoryEvent
 *   notify: (message: string) => void;                    // alert
 * };
 * export function createFolderReloader<E>(deps: FolderReloaderDeps<E>): {
 *   reload: (target: string | null) => Promise<FolderReloadOutcome>;   // null = 空白(root と展開中のすべて)
 * };
 * //  範囲: target がフォルダ → そのフォルダと、expandedDirs のうちその子孫(URI の階層で見る。`/r/a` に対する `/r/ab` は
 * //  含まない・途中が畳んであっても含む=(y))。null → root → expandedDirs の順。root が '' で null → 'no-root'。
 * //  target が畳んであれば expand(target) だけで 'expanded'(listDir は展開の $effect に任せる=(w))。
 * //  一覧はまとめて取りに行き、当てるのは読む順。1 つでも失敗したら、読めたものは当て・読めなかったものは当てず、
 * //  読む順で最初の失敗の理由で notify(reloadFolderFailedMessage(err)) を 1 回・'failed'(reject しない)。
 * //  一覧を待っている間の reload は、どの target でも何もせず 'busy'(expand も呼ばない)。
 *
 * // メニューの購読(契約 2)。+page.svelte が onMount で呼ぶ(他の register*Listener と同じ家風)
 * export function registerReloadFileListener(run: () => Promise<unknown> | unknown): Promise<() => void>;
 * //  $lib/events の listen(MENU_RELOAD_FILE_EVENT, …) を 1 回。イベント 1 回で run を 1 回。run の reject は外へ出さない。
 *
 * // 本文の右クリックの判定(契約 8・純関数)
 * export type ViewerContextMenuMode = 'app' | 'default';
 * export function viewerContextMenuMode(input: {
 *   hasDocument: boolean;      // 文書を表示している
 *   selectionText: string;     // window.getSelection()?.toString() ?? ''
 *   targetEditable: boolean;   // contenteditable の中・input・textarea
 *   targetInModel: boolean;    // 3D の描画面(ModelViewer)の上
 *   menuAvailable: boolean;    // ContextMenu.svelte が窓にある(= Explorer が出ている・Find in Folder のパネルでない)(s)
 * }): ViewerContextMenuMode;
 *
 * // --- src/lib/context-menu.ts に足す(項目列は context-menu.acceptance.test.ts が固定)
 * export function buildViewerMenu(): ContextMenuItem[];   // [{ id: 'reload-file', label: 'Reload File', enabled: true }]
 * ```
 *
 * ## 配線(AC-80-14・ソース走査。深い配線は reviewer 照合)
 * - `src/routes/+page.svelte`: `$lib/reload-file` から import し、`createFileReloader(` と `registerReloadFileListener(` が
 *   それぞれ 1 回。`createFileReloader(` の呼び出しの中に `reloadTree(`(ツリー分=要件#65 の関数)。`.viewer-main` の
 *   要素に `oncontextmenu`。`viewerContextMenuMode(` の呼び出しに `showFindInFolder`。`<Explorer` に `onReloadFile`
 * - `src/components/Explorer.svelte`: `createFolderReloader(` が 1 回。`<ContextMenu` に `onReloadFolder` と `onReloadFile`
 * - `src/components/ExplorerItem.svelte`: `contextMenu.openAt(` の呼び出しが `currentDocument` の字面を渡す
 *
 * ## 判断の記録(test-writer 2026-11-04)
 * - 「同時に始める」「両方が終わってから終わる」は、解決を手で握る Promise(deferred)で判定する。open を止めたまま
 *   refreshTree が呼ばれていること・逆・reload の Promise が両方の解決まで settle しないことを見る
 * - 「読む順で最初の失敗」は、後ろのフォルダを先に失敗させて(即 reject)、前のフォルダを後から失敗させる(deferred)。
 *   settle 順で選ぶ実装だと後ろの理由になり赤になる
 * - 種類の判定は本テストが readsAsText を直接呼ばず、URI の列挙(.md .rs .svg .html / .png .mp4 .wav .stl .pdf)で固定する
 *   =open に渡る command(openCommandFor)と食い違えば、テキストに bumpBinary が来て赤になる
 *
 * 人間ゲート(ネイティブのメニューの効き・確認ダイアログ・実際の外部変更・ssh・体感)はここでは判定しない。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/events', () => ({ listen: vi.fn() }));

import { listen } from '$lib/events';
import { buildViewerMenu } from './context-menu';
import {
	MENU_RELOAD_FILE_EVENT,
	RELOAD_FILE_LABEL,
	RELOAD_FOLDER_LABEL,
	createFileReloader,
	createFolderReloader,
	registerReloadFileListener,
	reloadFileFailedMessage,
	reloadFolderFailedMessage,
	viewerContextMenuMode,
} from './reload-file';

const listenMock = vi.mocked(listen);

const SRC_ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(SRC_ROOT, rel), 'utf-8');

/** 日本語(CJK)の検知(要件#35 / #51 と同じ定義)。 */
const CJK_PATTERN = /[　-〿぀-ヿ一-鿿＀-￯]/;

// ---------------------------------------------------------------------------
// 道具 — 解決を手で握る Promise・非同期を流しきる
// ---------------------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** マイクロタスクとマクロタスクを 1 巡ずつ流す(await の連鎖を抜けさせる)。 */
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise<void>((r) => setTimeout(r, 0));
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Promise が settle したかを外から見る。 */
function track<T>(p: Promise<T>) {
	const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
	void p.then(
		(v) => {
			state.settled = true;
			state.value = v;
		},
		(e) => {
			state.settled = true;
			state.error = e;
		}
	);
	return state;
}

// ---------------------------------------------------------------------------
// Reload File の依存(注入する偽物)
// ---------------------------------------------------------------------------

type Doc = { uri: string; content: string; modified: number | null };

const TEXT_URIS = ['file:///r/a.md', 'file:///r/main.rs', 'file:///r/pic.svg', 'file:///r/page.html'];
const BINARY_URIS = [
	'file:///r/photo.png',
	'file:///r/clip.mp4',
	'file:///r/song.wav',
	'file:///r/model.stl',
	'file:///r/paper.pdf',
];

function makeFileDeps(initialUri: string | null = 'file:///r/a.md') {
	let currentUri = initialUri;
	let stamp = 0;
	const deps = {
		current: vi.fn((): string | null => currentUri),
		confirm: vi.fn(async (): Promise<boolean> => true),
		open: vi.fn(async (uri: string): Promise<Doc> => ({ uri, content: `fresh ${uri}`, modified: 1 })),
		applyText: vi.fn((_doc: Doc) => {}),
		bumpBinary: vi.fn((_uri: string) => {}),
		notify: vi.fn((_message: string) => {}),
		changeStamp: vi.fn((): number => stamp),
		refreshTree: vi.fn(async (): Promise<void> => {}),
	};
	return {
		deps,
		setCurrent(uri: string | null) {
			currentUri = uri;
		},
		bumpStamp() {
			stamp += 1;
		},
	};
}

/** 何も呼ばれていない(文書の無い窓・not-open・busy・cancelled の判定に使う)。 */
function expectUntouched(deps: ReturnType<typeof makeFileDeps>['deps'], except: Array<keyof typeof deps> = []) {
	for (const name of ['confirm', 'open', 'refreshTree', 'applyText', 'bumpBinary', 'notify'] as const) {
		if (except.includes(name)) continue;
		expect(deps[name], `${name} must not be called`).not.toHaveBeenCalled();
	}
}

// ---------------------------------------------------------------------------
// AC-80-6 — Reload File の手順(契約 3・5・6・10)
// ---------------------------------------------------------------------------

describe('AC-80-6: createFileReloader — 文書なし・テキスト・バイナリ・取り消し・失敗・target・ツリーの失敗(契約 3・5・6・10)', () => {
	test("1. 文書の無い窓 → confirm / open / refreshTree / notify を呼ばず 'no-document'((q))", async () => {
		const { deps } = makeFileDeps(null);
		const { reload } = createFileReloader(deps);

		await expect(reload()).resolves.toBe('no-document');

		expectUntouched(deps);
	});

	test.each(TEXT_URIS)(
		"2. テキスト %s → confirm 1 回の後に open(同じ URI)1 回と refreshTree 1 回 → applyText(open の結果)1 回・bumpBinary 0 回 → 'reloaded'",
		async (uri) => {
			const { deps } = makeFileDeps(uri);
			const { reload } = createFileReloader(deps);

			await expect(reload()).resolves.toBe('reloaded');

			expect(deps.confirm).toHaveBeenCalledTimes(1);
			expect(deps.open).toHaveBeenCalledTimes(1);
			expect(deps.open).toHaveBeenCalledWith(uri);
			expect(deps.refreshTree).toHaveBeenCalledTimes(1);
			expect(deps.applyText).toHaveBeenCalledTimes(1);
			expect(deps.applyText.mock.calls[0]?.[0]).toEqual({ uri, content: `fresh ${uri}`, modified: 1 });
			expect(deps.bumpBinary).not.toHaveBeenCalled();
			expect(deps.notify).not.toHaveBeenCalled();
			// 読むのは確認の後(契約 5)。
			const confirmAt = deps.confirm.mock.invocationCallOrder[0];
			expect(deps.open.mock.invocationCallOrder[0]).toBeGreaterThan(confirmAt);
			expect(deps.refreshTree.mock.invocationCallOrder[0]).toBeGreaterThan(confirmAt);
		}
	);

	test.each(BINARY_URIS)(
		"3. バイナリ %s → confirm 1 回 → open 1 回と refreshTree 1 回 → bumpBinary(同じ URI)1 回・applyText 0 回 → 'reloaded'",
		async (uri) => {
			const { deps } = makeFileDeps(uri);
			const { reload } = createFileReloader(deps);

			await expect(reload()).resolves.toBe('reloaded');

			expect(deps.confirm).toHaveBeenCalledTimes(1);
			expect(deps.open).toHaveBeenCalledTimes(1);
			expect(deps.open).toHaveBeenCalledWith(uri);
			expect(deps.refreshTree).toHaveBeenCalledTimes(1);
			expect(deps.bumpBinary).toHaveBeenCalledTimes(1);
			expect(deps.bumpBinary).toHaveBeenCalledWith(uri);
			expect(deps.applyText).not.toHaveBeenCalled();
			expect(deps.notify).not.toHaveBeenCalled();
		}
	);

	test("4. confirm が false → open 0 回・refreshTree 0 回・applyText / bumpBinary / notify 0 回・'cancelled'【(t) 決定】", async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		deps.confirm.mockResolvedValueOnce(false);
		const { reload } = createFileReloader(deps);

		await expect(reload()).resolves.toBe('cancelled');

		expect(deps.confirm).toHaveBeenCalledTimes(1);
		expectUntouched(deps, ['confirm']);
	});

	test("5. open が文字列で reject → notify 1 回 'Could not reload the file: <理由>'・applyText / bumpBinary 0 回・refreshTree 1 回・reload は reject せず 'failed'", async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		deps.open.mockRejectedValueOnce('No such file or directory (os error 2)');
		const { reload } = createFileReloader(deps);

		await expect(reload()).resolves.toBe('failed');

		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledWith('Could not reload the file: No such file or directory (os error 2)');
		expect(deps.applyText).not.toHaveBeenCalled();
		expect(deps.bumpBinary).not.toHaveBeenCalled();
		expect(deps.refreshTree, 'the tree is still refreshed when the file fails ((t))').toHaveBeenCalledTimes(1);
	});

	test('5b. バイナリでも open の失敗は同じ(notify 1 回・bumpBinary 0 回・refreshTree 1 回)', async () => {
		const { deps } = makeFileDeps('file:///r/photo.png');
		deps.open.mockRejectedValueOnce('Permission denied (os error 13)');
		const { reload } = createFileReloader(deps);

		await expect(reload()).resolves.toBe('failed');

		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledWith('Could not reload the file: Permission denied (os error 13)');
		expect(deps.bumpBinary).not.toHaveBeenCalled();
		expect(deps.applyText).not.toHaveBeenCalled();
		expect(deps.refreshTree).toHaveBeenCalledTimes(1);
	});

	test("6. target が今の文書と違う → 何も呼ばず(refreshTree も)'not-open'(契約 9 の安全網)", async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		const { reload } = createFileReloader(deps);

		await expect(reload('file:///r/b.md')).resolves.toBe('not-open');

		expectUntouched(deps);
	});

	test("6b. target が今の文書と同じ(テキスト)→ 2 と同じ 'reloaded'", async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		const { reload } = createFileReloader(deps);

		await expect(reload('file:///r/a.md')).resolves.toBe('reloaded');

		expect(deps.confirm).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith('file:///r/a.md');
		expect(deps.refreshTree).toHaveBeenCalledTimes(1);
		expect(deps.applyText).toHaveBeenCalledTimes(1);
		expect(deps.bumpBinary).not.toHaveBeenCalled();
	});

	test("6c. target が今の文書と同じ(バイナリ)→ 3 と同じ 'reloaded'", async () => {
		const { deps } = makeFileDeps('file:///r/clip.mp4');
		const { reload } = createFileReloader(deps);

		await expect(reload('file:///r/clip.mp4')).resolves.toBe('reloaded');

		expect(deps.open).toHaveBeenCalledWith('file:///r/clip.mp4');
		expect(deps.bumpBinary).toHaveBeenCalledWith('file:///r/clip.mp4');
		expect(deps.applyText).not.toHaveBeenCalled();
	});

	test("6d. target の比べ方は文字列の一致(パーセントエンコードの違いは一致しない)→ 'not-open'", async () => {
		const { deps } = makeFileDeps('file:///r/a%20b.md');
		const { reload } = createFileReloader(deps);

		await expect(reload('file:///r/a b.md')).resolves.toBe('not-open');

		expectUntouched(deps);
	});

	test("6e. target が null は「今の文書」(省略と同じ)→ 'reloaded'", async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		const { reload } = createFileReloader(deps);

		await expect(reload(null)).resolves.toBe('reloaded');

		expect(deps.open).toHaveBeenCalledWith('file:///r/a.md');
	});

	test("7. refreshTree が reject しても notify は呼ばれず、reload は reject せず、結果はファイルの側のまま 'reloaded'((o))", async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		deps.refreshTree.mockRejectedValueOnce(new Error('tree gone'));
		const { reload } = createFileReloader(deps);

		await expect(reload()).resolves.toBe('reloaded');

		expect(deps.notify).not.toHaveBeenCalled();
		expect(deps.applyText).toHaveBeenCalledTimes(1);
	});

	test('7b. refreshTree が同期で throw しても同じ(notify 0 回・reject しない・reloaded)', async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		deps.refreshTree.mockImplementationOnce(() => {
			throw new Error('sync tree failure');
		});
		const { reload } = createFileReloader(deps);

		await expect(reload()).resolves.toBe('reloaded');

		expect(deps.notify).not.toHaveBeenCalled();
		expect(deps.applyText).toHaveBeenCalledTimes(1);
	});

	test("7c. refreshTree が失敗し、open も失敗 → notify は open の分の 1 回だけ・'failed'", async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		deps.refreshTree.mockRejectedValueOnce(new Error('tree gone'));
		deps.open.mockRejectedValueOnce('No such file or directory (os error 2)');
		const { reload } = createFileReloader(deps);

		await expect(reload()).resolves.toBe('failed');

		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledWith('Could not reload the file: No such file or directory (os error 2)');
	});
});

// ---------------------------------------------------------------------------
// AC-80-7 — 重ねない・古い結果で上書きしない(契約 10・11)【(t) 決定】
// ---------------------------------------------------------------------------

describe("AC-80-7 (1): 読み直しの最中の reload は何もせず 'busy'(契約 11)", () => {
	test("open が未解決のうちの 2 回目 → confirm も open も refreshTree も呼ばず 'busy'。open が解決したら 1 回目は 'reloaded'", async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		const opening = deferred<Doc>();
		deps.open.mockReturnValueOnce(opening.promise);
		const { reload } = createFileReloader(deps);

		const first = track(reload());
		await flush();
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(first.settled).toBe(false);

		await expect(reload()).resolves.toBe('busy');
		expect(deps.confirm).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.refreshTree).toHaveBeenCalledTimes(1);

		opening.resolve({ uri: 'file:///r/a.md', content: 'fresh', modified: 2 });
		await flush();
		expect(first.settled).toBe(true);
		expect(first.value).toBe('reloaded');
	});

	test("open が解決しても refreshTree が未解決なら 'busy'。両方が終わった後の reload は普通に動く", async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		const treeLoading = deferred<void>();
		deps.refreshTree.mockReturnValueOnce(treeLoading.promise);
		const { reload } = createFileReloader(deps);

		const first = track(reload());
		await flush();
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(first.settled, 'the reload waits for the tree too ((t))').toBe(false);

		await expect(reload()).resolves.toBe('busy');
		expect(deps.confirm).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledTimes(1);

		treeLoading.resolve();
		await flush();
		expect(first.settled).toBe(true);
		expect(first.value).toBe('reloaded');

		await expect(reload()).resolves.toBe('reloaded');
		expect(deps.confirm).toHaveBeenCalledTimes(2);
		expect(deps.open).toHaveBeenCalledTimes(2);
		expect(deps.refreshTree).toHaveBeenCalledTimes(2);
	});

	test("確認(confirm)の間も最中=2 回目は 'busy'", async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		const asking = deferred<boolean>();
		deps.confirm.mockReturnValueOnce(asking.promise);
		const { reload } = createFileReloader(deps);

		const first = track(reload());
		await flush();
		expect(deps.confirm).toHaveBeenCalledTimes(1);

		await expect(reload()).resolves.toBe('busy');
		expect(deps.confirm).toHaveBeenCalledTimes(1);
		expect(deps.open).not.toHaveBeenCalled();

		asking.resolve(true);
		await flush();
		expect(first.value).toBe('reloaded');
	});

	test('失敗で終わった後の reload も普通に動く', async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		deps.open.mockRejectedValueOnce('boom');
		const { reload } = createFileReloader(deps);

		await expect(reload()).resolves.toBe('failed');
		await expect(reload()).resolves.toBe('reloaded');

		expect(deps.open).toHaveBeenCalledTimes(2);
		expect(deps.applyText).toHaveBeenCalledTimes(1);
	});

	test('連打(同期に 3 回)しても読むのは 1 回', async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		const opening = deferred<Doc>();
		deps.open.mockReturnValueOnce(opening.promise);
		const { reload } = createFileReloader(deps);

		const results = [reload(), reload(), reload()];
		await flush();
		opening.resolve({ uri: 'file:///r/a.md', content: 'fresh', modified: 2 });

		await expect(Promise.all(results)).resolves.toEqual(['reloaded', 'busy', 'busy']);
		expect(deps.confirm).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.refreshTree).toHaveBeenCalledTimes(1);
	});
});

describe('AC-80-7 (2): open と refreshTree は confirm の後に同時に始まり、reload は両方が終わるまで終わらない【(t) 決定】', () => {
	test('confirm が未解決の間は open も refreshTree も呼ばれず、解決した直後に両方が呼ばれる', async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		const asking = deferred<boolean>();
		deps.confirm.mockReturnValueOnce(asking.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();
		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.refreshTree).not.toHaveBeenCalled();

		asking.resolve(true);
		await flush();
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.refreshTree).toHaveBeenCalledTimes(1);
		expect(result.value).toBe('reloaded');
	});

	test('open を未解決のまま止めても refreshTree は呼ばれている(ファイルを待たない)。reload は open の解決まで終わらない', async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		const opening = deferred<Doc>();
		deps.open.mockReturnValueOnce(opening.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();
		expect(deps.refreshTree, 'refreshTree does not wait for open').toHaveBeenCalledTimes(1);
		expect(result.settled).toBe(false);

		opening.resolve({ uri: 'file:///r/a.md', content: 'fresh', modified: 2 });
		await flush();
		expect(result.settled).toBe(true);
		expect(result.value).toBe('reloaded');
	});

	test('refreshTree を未解決のまま止めても open は呼ばれている(ツリーを待たない)。reload は refreshTree の解決まで終わらない', async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		const treeLoading = deferred<void>();
		deps.refreshTree.mockReturnValueOnce(treeLoading.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();
		expect(deps.open, 'open does not wait for refreshTree').toHaveBeenCalledTimes(1);
		expect(result.settled, 'the reload is not over until the tree is').toBe(false);

		treeLoading.resolve();
		await flush();
		expect(result.settled).toBe(true);
		expect(result.value).toBe('reloaded');
	});
});

describe("AC-80-7 (3)(4): 読んでいる間に外部変更が当たった / 文書が替わったら当てずに 'stale'(契約 11)", () => {
	test("テキスト: open が解決する前に changeStamp が進む → applyText を呼ばず 'stale'。refreshTree は 1 回", async () => {
		const { deps, bumpStamp } = makeFileDeps('file:///r/a.md');
		const opening = deferred<Doc>();
		deps.open.mockReturnValueOnce(opening.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();
		expect(deps.open).toHaveBeenCalledTimes(1);

		bumpStamp(); // file_changed の apply が先に当たった
		opening.resolve({ uri: 'file:///r/a.md', content: 'older read', modified: 2 });
		await flush();

		expect(result.value).toBe('stale');
		expect(deps.applyText).not.toHaveBeenCalled();
		expect(deps.bumpBinary).not.toHaveBeenCalled();
		expect(deps.notify).not.toHaveBeenCalled();
		expect(deps.refreshTree).toHaveBeenCalledTimes(1);
	});

	test("バイナリ: open が解決する前に changeStamp が進む → bumpBinary を呼ばず 'stale'。refreshTree は 1 回", async () => {
		const { deps, bumpStamp } = makeFileDeps('file:///r/photo.png');
		const opening = deferred<Doc>();
		deps.open.mockReturnValueOnce(opening.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();

		bumpStamp(); // binary_file_changed が先に版数を進めた
		opening.resolve({ uri: 'file:///r/photo.png', content: '', modified: 2 });
		await flush();

		expect(result.value).toBe('stale');
		expect(deps.bumpBinary).not.toHaveBeenCalled();
		expect(deps.applyText).not.toHaveBeenCalled();
		expect(deps.refreshTree).toHaveBeenCalledTimes(1);
	});

	test('changeStamp が進まなければ当てる(stale の判定が常に真ではない)', async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		const opening = deferred<Doc>();
		deps.open.mockReturnValueOnce(opening.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();
		opening.resolve({ uri: 'file:///r/a.md', content: 'fresh', modified: 2 });
		await flush();

		expect(result.value).toBe('reloaded');
		expect(deps.applyText).toHaveBeenCalledTimes(1);
	});

	test("confirm の間に current() の URI が変わった → applyText / bumpBinary を呼ばず 'stale'", async () => {
		const { deps, setCurrent } = makeFileDeps('file:///r/a.md');
		const asking = deferred<boolean>();
		deps.confirm.mockReturnValueOnce(asking.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();
		setCurrent('file:///r/b.md');
		asking.resolve(true);
		await flush();

		expect(result.value).toBe('stale');
		expect(deps.applyText).not.toHaveBeenCalled();
		expect(deps.bumpBinary).not.toHaveBeenCalled();
		expect(deps.notify).not.toHaveBeenCalled();
	});

	// --- 追補a(契約 11 追補a=事後確認 2・reviewer P2-2。2026-11-05 要件側更新で承認された追加)---
	// 確認の間に文書が替わったら、古い URI で open すると Rust の文書セッションが古い文書に差し替わる。
	// 「当てない」だけでなく「open も refreshTree も呼ばない」を固定する(変異 M13=比較を消すと赤)。

	test("追補a: confirm の間に current() の URI が別の文書に変わった → open 0 回・refreshTree 0 回・applyText / bumpBinary 0 回で 'stale'(契約 11 追補a)", async () => {
		const { deps, setCurrent } = makeFileDeps('file:///r/a.md');
		const asking = deferred<boolean>();
		deps.confirm.mockReturnValueOnce(asking.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();
		expect(deps.confirm).toHaveBeenCalledTimes(1);
		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.refreshTree).not.toHaveBeenCalled();

		setCurrent('file:///r/b.md'); // 確認ダイアログの間に別の文書を開いた
		asking.resolve(true);
		await flush();

		expect(result.settled).toBe(true);
		expect(result.value).toBe('stale');
		expect(deps.open, 'open must not be called with the old URI').not.toHaveBeenCalled();
		expect(deps.refreshTree, 'refreshTree must not be called').not.toHaveBeenCalled();
		expect(deps.applyText).not.toHaveBeenCalled();
		expect(deps.bumpBinary).not.toHaveBeenCalled();
		expect(deps.notify).not.toHaveBeenCalled();
	});

	test("追補a: confirm の間に文書が閉じられた(current() が null)→ open 0 回・refreshTree 0 回で 'stale'(バイナリでも同じ)", async () => {
		const { deps, setCurrent } = makeFileDeps('file:///r/photo.png');
		const asking = deferred<boolean>();
		deps.confirm.mockReturnValueOnce(asking.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();

		setCurrent(null); // 確認ダイアログの間に文書を閉じた
		asking.resolve(true);
		await flush();

		expect(result.value).toBe('stale');
		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.refreshTree).not.toHaveBeenCalled();
		expect(deps.applyText).not.toHaveBeenCalled();
		expect(deps.bumpBinary).not.toHaveBeenCalled();
		expect(deps.notify).not.toHaveBeenCalled();
	});

	test("追補a: confirm の間に文書が変わらなければ open と refreshTree は 1 回ずつ(stale の判定が常に真ではない)", async () => {
		const { deps } = makeFileDeps('file:///r/a.md');
		const asking = deferred<boolean>();
		deps.confirm.mockReturnValueOnce(asking.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();
		asking.resolve(true);
		await flush();

		expect(result.value).toBe('reloaded');
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.refreshTree).toHaveBeenCalledTimes(1);
		expect(deps.applyText).toHaveBeenCalledTimes(1);
	});

	test("open の間に current() の URI が変わった → applyText / bumpBinary を呼ばず 'stale'(テキスト)", async () => {
		const { deps, setCurrent } = makeFileDeps('file:///r/a.md');
		const opening = deferred<Doc>();
		deps.open.mockReturnValueOnce(opening.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();
		setCurrent('file:///r/b.md');
		opening.resolve({ uri: 'file:///r/a.md', content: 'fresh', modified: 2 });
		await flush();

		expect(result.value).toBe('stale');
		expect(deps.applyText).not.toHaveBeenCalled();
		expect(deps.bumpBinary).not.toHaveBeenCalled();
	});

	test("open の間に current() の URI が変わった → bumpBinary を呼ばず 'stale'(バイナリ)", async () => {
		const { deps, setCurrent } = makeFileDeps('file:///r/model.stl');
		const opening = deferred<Doc>();
		deps.open.mockReturnValueOnce(opening.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();
		setCurrent(null);
		opening.resolve({ uri: 'file:///r/model.stl', content: '', modified: 2 });
		await flush();

		expect(result.value).toBe('stale');
		expect(deps.bumpBinary).not.toHaveBeenCalled();
		expect(deps.applyText).not.toHaveBeenCalled();
	});

	test("'stale' で終わった後の reload は普通に動く(最中が解ける)", async () => {
		const { deps, bumpStamp } = makeFileDeps('file:///r/a.md');
		const opening = deferred<Doc>();
		deps.open.mockReturnValueOnce(opening.promise);
		const { reload } = createFileReloader(deps);

		const result = track(reload());
		await flush();
		bumpStamp();
		opening.resolve({ uri: 'file:///r/a.md', content: 'x', modified: 2 });
		await flush();
		expect(result.value).toBe('stale');

		await expect(reload()).resolves.toBe('reloaded');
		expect(deps.applyText).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// AC-80-8 — 文言(契約 1・6・14・15)【(x) 決定】
// ---------------------------------------------------------------------------

describe('AC-80-8: 文言とラベルの値固定・CJK なし', () => {
	test("reloadFileFailedMessage('boom') === 'Could not reload the file: boom'", () => {
		expect(reloadFileFailedMessage('boom')).toBe('Could not reload the file: boom');
	});

	test("reloadFolderFailedMessage('boom') === 'Could not reload the folder: boom'", () => {
		expect(reloadFolderFailedMessage('boom')).toBe('Could not reload the folder: boom');
	});

	test('Error を渡しても接頭辞は同じで、内容を本文に含む', () => {
		const file = reloadFileFailedMessage(new Error('disk on fire'));
		expect(file.startsWith('Could not reload the file: ')).toBe(true);
		expect(file).toContain('disk on fire');
		const folder = reloadFolderFailedMessage(new Error('socket closed'));
		expect(folder.startsWith('Could not reload the folder: ')).toBe(true);
		expect(folder).toContain('socket closed');
	});

	test("RELOAD_FILE_LABEL === 'Reload File'・RELOAD_FOLDER_LABEL === 'Reload Folder'・MENU_RELOAD_FILE_EVENT === 'menu_reload_file'", () => {
		expect(RELOAD_FILE_LABEL).toBe('Reload File');
		expect(RELOAD_FOLDER_LABEL).toBe('Reload Folder');
		expect(MENU_RELOAD_FILE_EVENT).toBe('menu_reload_file');
	});

	test('どれも CJK を含まない(要件#51)', () => {
		for (const s of [
			RELOAD_FILE_LABEL,
			RELOAD_FOLDER_LABEL,
			MENU_RELOAD_FILE_EVENT,
			reloadFileFailedMessage('x'),
			reloadFolderFailedMessage('x'),
		]) {
			expect(s).not.toMatch(CJK_PATTERN);
		}
	});
});

// ---------------------------------------------------------------------------
// AC-80-9 — メニューの購読(契約 2)
// ---------------------------------------------------------------------------

describe('AC-80-9: registerReloadFileListener — menu_reload_file を 1 回購読し、イベント 1 回で run を 1 回', () => {
	const handlerFor = () => listenMock.mock.calls.find((c) => c[0] === MENU_RELOAD_FILE_EVENT)?.[1];

	beforeEach(() => {
		listenMock.mockReset();
		listenMock.mockResolvedValue(() => {});
	});

	test("$lib/events の listen を 'menu_reload_file' で 1 回だけ呼ぶ", async () => {
		await registerReloadFileListener(vi.fn());

		expect(listenMock).toHaveBeenCalledTimes(1);
		expect(listenMock.mock.calls[0]?.[0]).toBe('menu_reload_file');
	});

	test('イベント 1 回で run が 1 回(登録しただけでは呼ばれない)', async () => {
		const run = vi.fn(async () => 'reloaded');
		await registerReloadFileListener(run);
		expect(run).not.toHaveBeenCalled();

		const handler = handlerFor();
		expect(handler, 'a handler must be registered').toBeTypeOf('function');
		handler!({ payload: undefined });
		await flush();

		expect(run).toHaveBeenCalledTimes(1);

		handler!({ payload: undefined });
		await flush();
		expect(run).toHaveBeenCalledTimes(2);
	});

	test('run が reject しても外へ投げない(ハンドラの戻りは reject せず、Unhandled Rejection も出さない)', async () => {
		const run = vi.fn(async () => {
			throw new Error('reload exploded');
		});
		await registerReloadFileListener(run);
		const handler = handlerFor()!;

		let rejected = false;
		const returned: unknown = handler({ payload: undefined });
		await Promise.resolve(returned).catch(() => {
			rejected = true;
		});
		await flush();

		expect(rejected, 'the handler must not hand the rejection back to the event system').toBe(false);
		expect(run).toHaveBeenCalledTimes(1);
	});

	test('run が同期で throw しても外へ投げない', async () => {
		const run = vi.fn(() => {
			throw new Error('sync explosion');
		});
		await registerReloadFileListener(run);
		const handler = handlerFor()!;

		expect(() => handler({ payload: undefined })).not.toThrow();
		await flush();
		expect(run).toHaveBeenCalledTimes(1);
	});

	test('返り値で購読を解ける(listen の unlisten が 1 回呼ばれる)', async () => {
		const unlisten = vi.fn();
		listenMock.mockResolvedValue(unlisten);

		const dispose = await registerReloadFileListener(vi.fn());
		expect(unlisten).not.toHaveBeenCalled();
		dispose();

		expect(unlisten).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// AC-80-10 — 本文の右クリックの判定(契約 8)【(g)(s) 決定】
// ---------------------------------------------------------------------------

describe("AC-80-10: viewerContextMenuMode — 5 つの条件がすべて揃うときだけ 'app'", () => {
	const ok = {
		hasDocument: true,
		selectionText: '',
		targetEditable: false,
		targetInModel: false,
		menuAvailable: true,
	};

	test("文書あり・選択が空・編集の面でない・3D でない・メニューの部品がある → 'app'", () => {
		expect(viewerContextMenuMode(ok)).toBe('app');
	});

	test("文書なし → 'default'(空の状態の画面・履歴選択画面)", () => {
		expect(viewerContextMenuMode({ ...ok, hasDocument: false })).toBe('default');
	});

	test("文字を選んでいる → 'default'(既定の Copy・Look Up・Translate を残す)", () => {
		expect(viewerContextMenuMode({ ...ok, selectionText: 'some words' })).toBe('default');
	});

	test("空白だけの選択は『選んでいない』とはみなさない → 'default'(選択文字列が空でなければ既定)", () => {
		expect(viewerContextMenuMode({ ...ok, selectionText: ' ' })).toBe('default');
	});

	test("編集の面(contenteditable・input・textarea)の上 → 'default'(Paste・スペルの候補を残す)", () => {
		expect(viewerContextMenuMode({ ...ok, targetEditable: true })).toBe('default');
	});

	test("3D の描画面の上 → 'default'(右ドラッグ=パンのまま)", () => {
		expect(viewerContextMenuMode({ ...ok, targetInModel: true })).toBe('default');
	});

	test("メニューの部品が窓に無い(Find in Folder のパネルの間)→ 'default'【(s) 決定】", () => {
		expect(viewerContextMenuMode({ ...ok, menuAvailable: false })).toBe('default');
	});

	// 要件#83 契約 7(2026-11-05 承認 3 の要件側更新): Reload File の後に Pin to Bookmarks が増えて 2 項目(済みなら Unpin=
	// context-menu.acceptance.test.ts の AC-83-22 が持つ)。先頭が有効な Reload File であることは変わらない。
	test("buildViewerMenu() は Reload File(有効)と Pin to Bookmarks の 2 項目(等値=区切り線の印などの余分なプロパティは無い)", () => {
		expect(buildViewerMenu()).toEqual([
			{ id: 'reload-file', label: 'Reload File', enabled: true },
			{ id: 'pin-to-bookmarks', label: 'Pin to Bookmarks', enabled: true },
		]);
	});
});

// ---------------------------------------------------------------------------
// AC-80-14 — ページと Explorer の配線(契約 2・8・9・10・14・ソース走査)
// ---------------------------------------------------------------------------

/** `start` の位置から最初の `(` に対応する閉じ括弧までの呼び出し全体(settings-changed.acceptance.test.ts と同じ)。 */
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

/** `needle` を含む開始タグ全体(`<` から、`{}` の外・引用符の外の最初の `>` まで)。 */
function openingTagContaining(src: string, needle: RegExp): string | null {
	const m = needle.exec(src);
	if (!m) return null;
	const lt = src.lastIndexOf('<', m.index);
	if (lt < 0) return null;
	let depth = 0;
	let quote: string | null = null;
	for (let i = lt + 1; i < src.length; i++) {
		const c = src[i];
		if (quote) {
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') {
			quote = c;
			continue;
		}
		if (c === '{') depth += 1;
		else if (c === '}') depth -= 1;
		else if (c === '>' && depth === 0) return src.slice(lt, i + 1);
	}
	return null;
}

const count = (src: string, needle: string) => src.split(needle).length - 1;

describe('AC-80-14(ソース走査): +page.svelte が実行列を 1 つ作り、3 つの入口と本文の右クリックを配線する', () => {
	const page = () => read('routes/+page.svelte');

	test("$lib/reload-file から createFileReloader と registerReloadFileListener を import する", () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*\bcreateFileReloader\b[^}]*\}\s*from\s*'\$lib\/reload-file'/);
		expect(src).toMatch(/import\s*\{[^}]*\bregisterReloadFileListener\b[^}]*\}\s*from\s*'\$lib\/reload-file'/);
	});

	test('createFileReloader( と registerReloadFileListener( がそれぞれ 1 回(実行列は窓に 1 つ=3 つの入口が同じものを呼ぶ)', () => {
		const src = page();
		expect(count(src, 'createFileReloader(')).toBe(1);
		expect(count(src, 'registerReloadFileListener(')).toBe(1);
	});

	test('createFileReloader( の呼び出しの中に reloadTree( がある(ツリー分は要件#65 の関数=契約 10)', () => {
		const src = page();
		const at = src.indexOf('createFileReloader(');
		expect(at).toBeGreaterThanOrEqual(0);
		const call = balancedCall(src, at);
		expect(call).toMatch(/\breloadTree\(/);
	});

	test(".viewer-main の要素に oncontextmenu がある(契約 8 の範囲=閲覧面)", () => {
		const tag = openingTagContaining(page(), /class="viewer-main"/);
		expect(tag, 'a <div class="viewer-main"> must exist in +page.svelte').not.toBeNull();
		expect(tag).toMatch(/\boncontextmenu\b/);
	});

	test('viewerContextMenuMode( の呼び出しに showFindInFolder の字面がある(Explorer の有無=【(s) 決定】)', () => {
		const src = page();
		const at = src.indexOf('viewerContextMenuMode(');
		expect(at, '+page.svelte must call viewerContextMenuMode(').toBeGreaterThanOrEqual(0);
		const call = balancedCall(src, at);
		expect(call).toContain('showFindInFolder');
	});

	test('<Explorer に onReloadFile を渡している(Explorer のファイルの行=契約 9)', () => {
		const tag = openingTagContaining(page(), /<Explorer[\s>]/);
		expect(tag, 'a <Explorer ...> element must exist in +page.svelte').not.toBeNull();
		expect(tag).toMatch(/\bonReloadFile\b/);
	});
});

describe('AC-80-14(ソース走査): Explorer.svelte と ExplorerItem.svelte の配線(契約 9・14)', () => {
	test('Explorer.svelte に createFolderReloader( が 1 回あり、$lib/reload-file から import する', () => {
		const src = read('components/Explorer.svelte');
		expect(count(src, 'createFolderReloader(')).toBe(1);
		expect(src).toMatch(/import\s*\{[^}]*\bcreateFolderReloader\b[^}]*\}\s*from\s*'\$lib\/reload-file'/);
	});

	test('Explorer.svelte の <ContextMenu に onReloadFolder と onReloadFile を渡している', () => {
		const tag = openingTagContaining(read('components/Explorer.svelte'), /<ContextMenu[\s/>]/);
		expect(tag, 'a <ContextMenu ...> element must exist in Explorer.svelte').not.toBeNull();
		expect(tag).toMatch(/\bonReloadFolder\b/);
		expect(tag).toMatch(/\bonReloadFile\b/);
	});

	test('ExplorerItem.svelte の contextMenu.openAt( の呼び出しが開いている文書の URI(currentDocument)を渡す', () => {
		const src = read('components/ExplorerItem.svelte');
		const at = src.indexOf('contextMenu.openAt(');
		expect(at, 'ExplorerItem.svelte must call contextMenu.openAt(').toBeGreaterThanOrEqual(0);
		const call = balancedCall(src, at);
		expect(call).toContain('currentDocument');
	});
});

// ---------------------------------------------------------------------------
// AC-80-16 — Reload Folder の手順(契約 11・15)【(k)(l)(n)(o)(p)(u)(w)(x)(y) 決定】
// ---------------------------------------------------------------------------

type Entry = { uri: string; name: string; kind: 'file' | 'dir' | 'symlink' };

type Listing = Entry[] | Error | (() => Promise<Entry[]>);

function entriesOf(uri: string): Entry[] {
	return [{ uri: `${uri}/x.md`, name: `x-of-${uri.split('/').pop()}.md`, kind: 'file' }];
}

function makeFolderDeps(root: string, expanded: string[], listings: Record<string, Listing>) {
	const deps = {
		root: vi.fn((): string => root),
		expandedDirs: vi.fn((): readonly string[] => expanded),
		isExpanded: vi.fn((uri: string): boolean => expanded.includes(uri)),
		expand: vi.fn((_uri: string) => {}),
		listDir: vi.fn((uri: string): Promise<Entry[]> => {
			const listing = listings[uri];
			if (listing instanceof Error) throw listing;
			if (typeof listing === 'function') return listing();
			return Promise.resolve(listing ?? entriesOf(uri));
		}),
		apply: vi.fn((_uri: string, _entries: Entry[]) => {}),
		notify: vi.fn((_message: string) => {}),
	};
	return deps;
}

const listed = (deps: ReturnType<typeof makeFolderDeps>) => deps.listDir.mock.calls.map((c) => c[0]);
const applied = (deps: ReturnType<typeof makeFolderDeps>) =>
	deps.apply.mock.calls.map((c) => ({ uri: c[0], entries: c[1] }));

describe.each([
	['local', 'file:///r'],
	['ssh', 'ssh://u@h/r'],
])('AC-80-16 (%s): createFolderReloader — 範囲・順・畳んだ行・失敗・重ねない(契約 11・15)', (_label, base) => {
	const ROOT = base;
	const A = `${base}/a`;
	const AX = `${base}/a/x`;
	const AXY = `${base}/a/x/y`;
	const B = `${base}/b`;
	const AB = `${base}/ab`;
	const C = `${base}/c`;

	test("1. 展開中の a を押す → listDir は a・a/x・a/x/y の 3 回だけ(b・ab・root は読まない)・まとめて取りに行き、apply は読む順・expand と notify は 0 回・'reloaded'・expandedDirs は変えない", async () => {
		const expanded = [A, AX, B, AB, AXY];
		const before = [...expanded];
		const dA = deferred<Entry[]>();
		const dAX = deferred<Entry[]>();
		const dAXY = deferred<Entry[]>();
		const deps = makeFolderDeps(ROOT, expanded, {
			[A]: () => dA.promise,
			[AX]: () => dAX.promise,
			[AXY]: () => dAXY.promise,
		});
		const { reload } = createFolderReloader(deps);

		const result = track(reload(A));
		await flush();
		expect(listed(deps), 'all three listings are requested together').toEqual([A, AX, AXY]);
		expect(deps.apply).not.toHaveBeenCalled();

		// 後ろから解決しても、当てるのは読む順(a → a/x → a/x/y)。
		dAXY.resolve(entriesOf(AXY));
		await flush();
		dAX.resolve(entriesOf(AX));
		await flush();
		dA.resolve(entriesOf(A));
		await flush();

		expect(result.value).toBe('reloaded');
		expect(applied(deps)).toEqual([
			{ uri: A, entries: entriesOf(A) },
			{ uri: AX, entries: entriesOf(AX) },
			{ uri: AXY, entries: entriesOf(AXY) },
		]);
		expect(deps.expand).not.toHaveBeenCalled();
		expect(deps.notify).not.toHaveBeenCalled();
		expect(expanded, 'expandedDirs is not mutated').toEqual(before);
	});

	test('2. a/x が畳んであっても(expandedDirs が [a, a/x/y])、a を押すと a/x/y を読む【(y) 決定】', async () => {
		const deps = makeFolderDeps(ROOT, [A, AXY], {});
		const { reload } = createFolderReloader(deps);

		await expect(reload(A)).resolves.toBe('reloaded');

		expect(listed(deps)).toEqual([A, AXY]);
		expect(applied(deps)).toEqual([
			{ uri: A, entries: entriesOf(A) },
			{ uri: AXY, entries: entriesOf(AXY) },
		]);
	});

	test("3. target が null(空白)→ root → expandedDirs のすべての順に読んで当てる((p)=契約 10 と同じ範囲)・'reloaded'", async () => {
		const deps = makeFolderDeps(ROOT, [A, B], {});
		const { reload } = createFolderReloader(deps);

		await expect(reload(null)).resolves.toBe('reloaded');

		expect(listed(deps)).toEqual([ROOT, A, B]);
		expect(applied(deps)).toEqual([
			{ uri: ROOT, entries: entriesOf(ROOT) },
			{ uri: A, entries: entriesOf(A) },
			{ uri: B, entries: entriesOf(B) },
		]);
		expect(deps.expand).not.toHaveBeenCalled();
		expect(deps.notify).not.toHaveBeenCalled();
	});

	test("4. 畳んであるフォルダ(isExpanded が false)→ expand(その URI)1 回・listDir 0 回・notify 0 回・'expanded'【(w) 決定】", async () => {
		const deps = makeFolderDeps(ROOT, [A], {});
		const { reload } = createFolderReloader(deps);

		await expect(reload(C)).resolves.toBe('expanded');

		expect(deps.expand).toHaveBeenCalledTimes(1);
		expect(deps.expand).toHaveBeenCalledWith(C);
		expect(deps.listDir).not.toHaveBeenCalled();
		expect(deps.apply).not.toHaveBeenCalled();
		expect(deps.notify).not.toHaveBeenCalled();
	});

	test("5. listDir の 1 つが文字列で reject → ほかは当てる・reject したフォルダには apply しない・notify 1 回・reload は reject せず 'failed'", async () => {
		const deps = makeFolderDeps(ROOT, [A, AX, AXY], {
			[AX]: () => Promise.reject('Permission denied (os error 13)'),
		});
		const { reload } = createFolderReloader(deps);

		await expect(reload(A)).resolves.toBe('failed');

		expect(listed(deps)).toEqual([A, AX, AXY]);
		expect(applied(deps)).toEqual([
			{ uri: A, entries: entriesOf(A) },
			{ uri: AXY, entries: entriesOf(AXY) },
		]);
		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledWith('Could not reload the folder: Permission denied (os error 13)');
	});

	test('6. 2 つが reject → notify は 1 回だけで、理由は読む順で先のもの(settle した順ではない)【(x) 決定】', async () => {
		const laterFailure = deferred<Entry[]>();
		const deps = makeFolderDeps(ROOT, [A, AX, AXY], {
			[AX]: () => laterFailure.promise, // 読む順では先・settle は後
			[AXY]: () => Promise.reject('second in order, first to settle'), // 読む順では後・settle は先
		});
		const { reload } = createFolderReloader(deps);

		const result = track(reload(A));
		await flush();
		laterFailure.reject('first in order, last to settle');
		await flush();

		expect(result.value).toBe('failed');
		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledWith('Could not reload the folder: first in order, last to settle');
		expect(applied(deps)).toEqual([{ uri: A, entries: entriesOf(A) }]);
	});

	test('7. listDir が同期で throw しても 5 と同じ(ほかは当てる・notify 1 回・reject しない)', async () => {
		const deps = makeFolderDeps(ROOT, [A, AX, AXY], {
			[AX]: new Error('Permission denied (os error 13)'),
		});
		const { reload } = createFolderReloader(deps);

		await expect(reload(A)).resolves.toBe('failed');

		expect(applied(deps).map((a) => a.uri)).toEqual([A, AXY]);
		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify.mock.calls[0]?.[0]).toMatch(/^Could not reload the folder: /);
		expect(deps.notify.mock.calls[0]?.[0]).toContain('Permission denied (os error 13)');
	});

	test("8. root が空で target が null → 何も呼ばず 'no-root'", async () => {
		const deps = makeFolderDeps('', [A], {});
		const { reload } = createFolderReloader(deps);

		await expect(reload(null)).resolves.toBe('no-root');

		expect(deps.listDir).not.toHaveBeenCalled();
		expect(deps.apply).not.toHaveBeenCalled();
		expect(deps.expand).not.toHaveBeenCalled();
		expect(deps.notify).not.toHaveBeenCalled();
	});

	test("9. 1 回目の listDir が未解決のうちの reload(同じ・別の展開中・null・畳んだ別のフォルダ)→ listDir も expand も呼ばず 'busy'。終われば普通に動く【(u) 決定】", async () => {
		const dA = deferred<Entry[]>();
		const deps = makeFolderDeps(ROOT, [A, B], { [A]: () => dA.promise });
		const { reload } = createFolderReloader(deps);

		const first = track(reload(A));
		await flush();
		expect(listed(deps)).toEqual([A]);

		await expect(reload(A)).resolves.toBe('busy');
		await expect(reload(B)).resolves.toBe('busy');
		await expect(reload(null)).resolves.toBe('busy');
		await expect(reload(C)).resolves.toBe('busy');
		expect(listed(deps), 'no further listing while busy').toEqual([A]);
		expect(deps.expand).not.toHaveBeenCalled();
		expect(deps.notify).not.toHaveBeenCalled();

		dA.resolve(entriesOf(A));
		await flush();
		expect(first.value).toBe('reloaded');

		await expect(reload(null)).resolves.toBe('reloaded');
		expect(listed(deps)).toEqual([A, ROOT, A, B]);
	});

	test('9b. 失敗で終わった後も普通に動く(最中が解ける)', async () => {
		let attempts = 0;
		const deps = makeFolderDeps(ROOT, [A], {
			// 1 回目だけ失敗し、2 回目からは読める。
			[A]: () => (attempts++ === 0 ? Promise.reject('gone') : Promise.resolve(entriesOf(A))),
		});
		const { reload } = createFolderReloader(deps);

		await expect(reload(A)).resolves.toBe('failed');
		expect(deps.notify).toHaveBeenCalledTimes(1);

		await expect(reload(null)).resolves.toBe('reloaded');
		expect(listed(deps)).toEqual([A, ROOT, A]);
	});

	test("9c. 畳んだ行を開くだけ('expanded')は最中にならない(直後の reload が 'busy' にならない)", async () => {
		const deps = makeFolderDeps(ROOT, [A], {});
		const { reload } = createFolderReloader(deps);

		await expect(reload(C)).resolves.toBe('expanded');
		await expect(reload(A)).resolves.toBe('reloaded');

		expect(listed(deps)).toEqual([A]);
	});
});
