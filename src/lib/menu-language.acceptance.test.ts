/**
 * 要件#35 の受け入れテスト(requirements.md #35)— フロント層
 * 「右クリックメニュー(ファイルツリーのコンテキストメニュー)とウィンドウ上部の
 *  メニューバーの表示、およびメニュー起点の体験一式(ダイアログ題・エラー通知)を
 *  全部英語にする」
 *
 * 契約(2026-08-30 由谷決定=Q1 メニュー体験一式)のうち本ファイルの持ち場:
 * - ① コンテキストメニューのラベル5件の英語化(推奨文言の値固定)
 *   "Reveal in Finder"・"Open with Default App"・"Open With…"・"Copy Path"・
 *   "Duplicate Window"(macOS 標準用語)
 * - ③ メニュー起点の体験一式の英語化:
 *   - ダイアログ題(menu-open.ts の DIALOG_OPTIONS の「ファイルを開く」
 *     「フォルダを選択」と、同文言が重複する履歴選択画面側のフォルダ選択
 *     =+page.svelte の pickFolderAndSetRoot)
 *   - メニュー/右クリック起点のエラー alert 文言(「開けませんでした」
 *     「ウィンドウを複製できませんでした」=+page.svelte)
 * - 機械判定の「対象箇所に日本語(CJK)が残らないこと」と
 *   「項目の出し分け/順序の不変」
 * - ⑦ i18n 機構は導入しない=英語固定への置換のみ・依存追加なし
 *
 * menu.rs 側(② メニューバーは既に全英語=変更なしの確認・③ CLI インストール
 * 結果ダイアログ本文)は src-tauri/tests/acceptance_req35.rs の持ち場。
 * ラベル固定の日→英の置き換えは context-menu.acceptance.test.ts でも実施済み
 * (契約⑥の要件側更新)— 本ファイルは要件#35 の台帳として同じ値をまとめて固定し、
 * CJK 不在と順序不変を足す。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * 1. `src/lib/context-menu.ts` — LABELS の5値を上記英語へ置換。
 *    id・構成・順序・enabled の出し分けは一切変えない(英語化は label のみ)。
 * 2. `src/lib/menu-open.ts` — 追加 export(値は本テストが固定):
 *    ```ts
 *    export const OPEN_FILE_DIALOG_TITLE = 'Open File';
 *    export const SELECT_FOLDER_DIALOG_TITLE = 'Select Folder';
 *    ```
 *    DIALOG_OPTIONS の title はこの定数を使う(ダイアログへ渡る title を
 *    本テストがモック捕捉で判定するので、リテラル直書きでも値が一致すれば通るが、
 *    +page.svelte との文言重複を1定数に集める=lessons「同じ判定は純関数で共有」
 *    の家風に合わせること)。+page.svelte の pickFolderAndSetRoot も
 *    SELECT_FOLDER_DIALOG_TITLE を import して使う(実配線は reviewer 照合・
 *    本テストはソース走査で識別子の存在と日本語題の不在まで判定)。
 *    ※要件#11 acceptance(menu-open.acceptance.test.ts)の「タイトル・フィルタ等は
 *    実装の自由」のうちタイトルは本要件の値固定で置き換わる(要件#35 契約③。
 *    directory / multiple の判定は従来どおり要件#11 側が持つ)。
 * 3. `src/lib/menu-open.ts` — メニュー起点の失敗 alert の文言(純関数):
 *    ```ts
 *    export function openFailedMessage(err: unknown): string; // `Could not open: ${err}`
 *    ```
 *    +page.svelte の registerMenuOpenListeners の onError がこれを alert に使う。
 * 4. `src/lib/duplicate-window.ts` — 複製失敗 alert の文言(純関数):
 *    ```ts
 *    export function duplicateWindowFailedMessage(err: unknown): string;
 *    // `Could not duplicate window: ${err}`
 *    ```
 *    +page.svelte の reportDuplicateFailure(メニュー起点・右クリック起点の合流点)
 *    がこれを alert に使う。
 *
 * ## 文言の設計判断(本テストの確定)
 * ダイアログ題・alert の英語文言は要件に推奨がないため本テストで確定する —
 * 「ファイルを開く」→ "Open File"・「フォルダを選択」→ "Select Folder"・
 * 「開けませんでした: 」→ "Could not open: "・
 * 「ウィンドウを複製できませんでした: 」→ "Could not duplicate window: "。
 * gate で由谷が文言 NG とした場合は要件側で文言を確定してから acceptance を
 * 更新する(契約①の脱出口=要件#24 と同じ運用・事前承認済み)。
 *
 * ## スコープ外(契約④=日本語のまま残ってよい)
 * RootPicker・UpdateBanner・各ビューアのプレースホルダ・+page.svelte の
 * 履歴選択画面エラー(「フォルダを開けませんでした」)・マーク追加失敗 alert・
 * ペイン仕切りの aria-label / title 等。ソース走査はこれらを誤検知しない形で
 * 対象文言だけを見る。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - +page.svelte が openFailedMessage / duplicateWindowFailedMessage /
 *   SELECT_FOLDER_DIALOG_TITLE を実際の alert / ダイアログ呼び出しに使うこと
 *   (本テストはソース走査での識別子の存在確認まで)
 * - メニューバー(menu.rs)の項目ラベルが変更なしであること(契約②。
 *   ソース走査は acceptance_req35.rs)
 *
 * ## 人間ゲート(acceptance/acceptance.md)
 * - 実機の見た目・英語文言の妥当性(契約①の脱出口)・実機で日本語が見える
 *   メニュー項目があれば由谷指摘で追補(契約②)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { buildContextMenu, buildTreePaneMenu, type ContextMenuEntry } from './context-menu';
import {
	OPEN_FILE_DIALOG_TITLE,
	SELECT_FOLDER_DIALOG_TITLE,
	openFailedMessage,
	openFileFromMenu,
	openFolderFromMenu,
} from './menu-open';
import { duplicateWindowFailedMessage } from './duplicate-window';

const dialogMock = openDialog as unknown as Mock<
	(options?: Record<string, unknown>) => Promise<string | string[] | null>
>;

/**
 * 日本語(CJK)の検知: CJK 記号・句読点(U+3000–303F)・かな(U+3040–30FF)・
 * CJK 統合漢字(U+4E00–9FFF)・全角形(U+FF00–FFEF)。
 * "…"(U+2026)や "→"(U+2192)は英語 UI でも使う記号なので対象外。
 */
const CJK_PATTERN = /[　-ヿ一-鿿＀-￯]/;

const localFile: ContextMenuEntry = {
	uri: 'file:///Users/x/notes/plan.md',
	name: 'plan.md',
	kind: 'file',
};
const localDir: ContextMenuEntry = {
	uri: 'file:///Users/x/notes',
	name: 'notes',
	kind: 'dir',
};
const sshFile: ContextMenuEntry = {
	uri: 'ssh://alice@host:22/srv/notes/plan.md',
	name: 'plan.md',
	kind: 'file',
};
const sshDir: ContextMenuEntry = {
	uri: 'ssh://alice@host:22/srv/notes',
	name: 'notes',
	kind: 'dir',
};

beforeEach(() => {
	dialogMock.mockReset();
});

// ---------------------------------------------------------------------------
// 契約① — コンテキストメニューのラベル5件(推奨文言の値固定)
// ---------------------------------------------------------------------------

describe('契約①: コンテキストメニューのラベルは英語の推奨文言(値固定)', () => {
	test('5項目の id → label 対応が推奨文言に一致する(local ファイル)', () => {
		const labelById = Object.fromEntries(
			buildContextMenu(localFile).map((i) => [i.id, i.label])
		);
		expect(labelById).toEqual({
			reveal: 'Reveal in Finder',
			open: 'Open with Default App',
			'open-with': 'Open With…',
			'copy-path': 'Copy Path',
			'duplicate-window': 'Duplicate Window',
		});
	});

	test('フォルダも同じ対応表(reveal / copy-path / duplicate-window の3件)', () => {
		expect(buildContextMenu(localDir).map((i) => i.label)).toEqual([
			'Reveal in Finder',
			'Copy Path',
			'Duplicate Window',
		]);
	});

	test('ツリー空白部メニューのラベルも "Duplicate Window"', () => {
		expect(buildTreePaneMenu().map((i) => i.label)).toEqual(['Duplicate Window']);
	});
});

describe('契約①+機械判定: ラベルに日本語(CJK)が残らない・出し分け/順序は不変', () => {
	test('全種(local/ssh × file/dir/symlink・空白部)のラベルに CJK が無い', () => {
		const entries = [localFile, localDir, { ...localFile, kind: 'symlink' as const }, sshFile, sshDir];
		const labels = [
			...entries.flatMap((e) => buildContextMenu(e).map((i) => i.label)),
			...buildTreePaneMenu().map((i) => i.label),
		];
		for (const label of labels) {
			expect(label).not.toMatch(CJK_PATTERN);
		}
	});

	test('項目の出し分け・順序は従来どおり(ファイル5項目・フォルダ3項目=英語化は label のみ)', () => {
		expect(buildContextMenu(localFile).map((i) => i.id)).toEqual([
			'reveal',
			'open',
			'open-with',
			'copy-path',
			'duplicate-window',
		]);
		expect(buildContextMenu(localDir).map((i) => i.id)).toEqual([
			'reveal',
			'copy-path',
			'duplicate-window',
		]);
		// ssh の enabled 出し分けも不変(context-menu.acceptance.test.ts が本判定を
		// 持つが、「英語化で出し分けが動かない」ことを要件#35 の台帳にも固定する)。
		expect(buildContextMenu(sshFile).map((i) => i.enabled)).toEqual([
			false,
			false,
			false,
			true,
			true,
		]);
	});
});

// ---------------------------------------------------------------------------
// 契約③ — ダイアログ題(menu-open の DIALOG_OPTIONS)
// ---------------------------------------------------------------------------

describe('契約③: ダイアログ題は英語(値固定=本テストの設計判断)', () => {
	test("定数の値固定: OPEN_FILE_DIALOG_TITLE = 'Open File'・SELECT_FOLDER_DIALOG_TITLE = 'Select Folder'", () => {
		expect(OPEN_FILE_DIALOG_TITLE).toBe('Open File');
		expect(SELECT_FOLDER_DIALOG_TITLE).toBe('Select Folder');
	});

	test('Open… のダイアログへ渡る title が定数と一致する(モック捕捉)', async () => {
		dialogMock.mockResolvedValueOnce(null); // キャンセル=オプション捕捉だけが目的

		await openFileFromMenu();

		const opts = dialogMock.mock.calls[0]?.[0] ?? {};
		expect(opts['title']).toBe(OPEN_FILE_DIALOG_TITLE);
	});

	test('Open Folder… のダイアログへ渡る title が定数と一致する(モック捕捉)', async () => {
		dialogMock.mockResolvedValueOnce(null);

		await openFolderFromMenu();

		const opts = dialogMock.mock.calls[0]?.[0] ?? {};
		expect(opts['title']).toBe(SELECT_FOLDER_DIALOG_TITLE);
	});

	test('ダイアログへ渡る文字列オプションのどこにも日本語(CJK)が無い', async () => {
		dialogMock.mockResolvedValue(null);

		await openFileFromMenu();
		await openFolderFromMenu();

		for (const call of dialogMock.mock.calls) {
			const values = Object.values(call[0] ?? {}).filter(
				(v): v is string => typeof v === 'string'
			);
			for (const value of values) {
				expect(value).not.toMatch(CJK_PATTERN);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 契約③ — メニュー/右クリック起点のエラー alert 文言(純関数の値固定)
// ---------------------------------------------------------------------------

describe('契約③: openFailedMessage — メニュー起点の失敗 alert 文言', () => {
	test("文字列エラー → 'Could not open: <err>'(値固定)", () => {
		expect(openFailedMessage('disk on fire')).toBe('Could not open: disk on fire');
	});

	test('Error でも接頭辞は固定で、エラー内容を本文に含む', () => {
		const message = openFailedMessage(new Error('boom'));
		expect(message.startsWith('Could not open: ')).toBe(true);
		expect(message).toContain('boom');
	});

	test('日本語(CJK)を含まない(エラー内容の素通し分は除く)', () => {
		expect(openFailedMessage('no such directory')).not.toMatch(CJK_PATTERN);
	});
});

describe('契約③: duplicateWindowFailedMessage — 複製失敗 alert 文言', () => {
	test("文字列エラー → 'Could not duplicate window: <err>'(値固定)", () => {
		expect(duplicateWindowFailedMessage('no window')).toBe(
			'Could not duplicate window: no window'
		);
	});

	test('Error でも接頭辞は固定で、エラー内容を本文に含む', () => {
		const message = duplicateWindowFailedMessage(new Error('boom'));
		expect(message.startsWith('Could not duplicate window: ')).toBe(true);
		expect(message).toContain('boom');
	});

	test('日本語(CJK)を含まない(エラー内容の素通し分は除く)', () => {
		expect(duplicateWindowFailedMessage('spawn failed')).not.toMatch(CJK_PATTERN);
	});
});

// ---------------------------------------------------------------------------
// 契約③ — +page.svelte の対象箇所に日本語が残らない(ソース走査)
// ---------------------------------------------------------------------------

describe('契約③: +page.svelte の対象文言に日本語が残らない(ソース走査)', () => {
	const pageSource = readFileSync(resolve(__dirname, '../routes/+page.svelte'), 'utf-8');

	test("フォルダ選択ダイアログ題の「フォルダを選択」が残らない(コメントにも残さない)", () => {
		expect(pageSource).not.toContain('フォルダを選択');
	});

	test('メニュー起点 alert の「開けませんでした」が残らない(スコープ外の「フォルダを開けませんでした」=履歴選択画面エラーは除外)', () => {
		// lookbehind でスコープ外(契約④=RootPicker 側のエラー文言)だけを除く。
		expect(pageSource).not.toMatch(/(?<!フォルダを)開けませんでした/u);
	});

	test('複製失敗 alert の「ウィンドウを複製できませんでした」が残らない', () => {
		expect(pageSource).not.toContain('ウィンドウを複製できませんでした');
	});

	test('値固定した文言が実配線に効く最低限の担保: 固定 API の識別子を参照している(深い配線は reviewer 照合)', () => {
		expect(pageSource).toContain('openFailedMessage');
		expect(pageSource).toContain('duplicateWindowFailedMessage');
		expect(pageSource).toContain('SELECT_FOLDER_DIALOG_TITLE');
	});
});
