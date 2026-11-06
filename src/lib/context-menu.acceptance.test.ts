/**
 * 要件#19 の受け入れテスト(requirements.md #19)
 * 「ファイルツリー(左ペイン)のアイテムを右クリックするとコンテキストメニューが
 *  表示され、『Finder で表示』『既定アプリで開く』『パスをコピー』ができる」
 *
 * 契約(2026-08-17 由谷決定=Q1 参照系3項目・Q2 自前 Svelte・Q3 グレーアウト・
 * Q4 フォルダは既定アプリなし)のうち本ファイルの持ち場:
 * - ② 項目の出し分け: ファイル=「Finder で表示」+「既定アプリで開く」+「パスをコピー」・
 *   フォルダ=「Finder で表示」+「パスをコピー」(既定アプリなし)
 * - ③ 実行手段= tauri-plugin-opener の reveal_item_in_dir / open_path。
 *   capability(src-tauri/capabilities/default.json)に allow-reveal-item-in-dir・
 *   allow-open-path を追加(既存 opener:allow-open-url の url scope は変更しない)
 * - ④ 「パスをコピー」= ローカルは OS パス・ssh は URI 文字列
 * - ⑤ ssh リモート: メニューは出すが「Finder で表示」「既定アプリで開く」は
 *   disabled・「パスをコピー」は有効(判別= URI スキーム)
 * - ① のうち「ウィンドウ端でのはみ出し防止」の座標クランプ(純計算)
 *
 * 判定範囲(本ファイル): 純ロジック VM のみ。実装先 `src/lib/context-menu.ts`(新規)。
 * contextmenu イベント配線・開閉(外側クリック/Esc/別アイテム右クリック)・
 * invoke/clipboard の実呼び出しは reviewer 照合、実機の見た目は人間ゲート(末尾参照)。
 *
 * ## 要件#21 追補(requirements.md #21・2026-08-17 由谷決定)
 * 「アプリを選択して開く…」(Finder の「このアプリケーションで開く」相当)を
 * **ファイルのみ**に追加する — 「既定アプリで開く」の直後・フォルダには出さない・
 * ssh は disabled(#19 の出し分け踏襲=#21①)。クリックで .app 選択ダイアログ →
 * 選択した .app を openPath(path, with) へ(#21②)。capability の allow-open-path
 * scope は { path: "**", app: true } へ(#21③)。キャンセル=無変化(#21④)。
 * 本要件により #19 のファイル項目構成(3項目固定)ケースは 4項目へ**要件側更新**
 * (承認済み=#21⑦)。追加分の確定契約は下記に統合してある。
 *
 * ## 要件#34 追補(requirements.md #34・2026-08-29 由谷決定)
 * 「ウィンドウを複製」(Duplicate Window)をアイテムメニューの**末尾**に追加する —
 * ファイル/フォルダ(symlink 含む)の全種に出し、**ssh でも常に enabled**
 * (アイテムに依存しない窓操作のため=契約#34③)。末尾の区切り線は VM の項目では
 * なく描画側の持ち場(reviewer 照合)。ツリーの空白部分の右クリックには同項目
 * 1つだけのメニューを出す(buildTreePaneMenu)。クリック時の複製実行列
 * (スナップショット → new_window)は duplicate-window.acceptance.test.ts の持ち場。
 * 本要件により #19/#21 の項目数固定(ファイル4項目・フォルダ2項目)は
 * ファイル5項目・フォルダ3項目へ**要件側更新**(承認済み=#34⑩)。
 *
 * ## 要件#35 追補(requirements.md #35・2026-08-30 由谷決定)
 * ラベル5件の表示文言を英語へ置換(契約#35①の推奨文言=macOS 標準用語)—
 * "Reveal in Finder"・"Open with Default App"・"Open With…"・"Copy Path"・
 * "Duplicate Window"。本要件により本ファイルの日本語ラベル固定は英語へ
 * **要件側更新**(承認済み=#35⑥)。id・項目の出し分け・順序・enabled の判定は
 * 不変(英語化は label のみ)。要件#19/#21/#34 の契約文中の日本語ラベル表記は
 * #35⑤ により英語表記へ読み替える(過去の記述は書き換えない=本追補が正)。
 * メニュー体験全体の英語化の台帳は menu-language.acceptance.test.ts(要件#35)。
 *
 * ## 要件#59 追補(docs/requirements/req-59.md・2026-09-18 由谷指示)
 * 「Open in New Window」をアイテムメニューの **Open With… の直後・Copy Path の
 * 直前**に追加する(id は 'open-in-new-window'・フォルダでは reveal の直後)。
 * 本要件により #19/#21/#34 の項目数固定(ファイル/symlink 5項目・フォルダ3項目)は
 * ファイル/symlink 6項目・フォルダ4項目へ**要件側更新**(承認済み=#59⑦)。
 * 更新するのは**項目数・順序・ラベル列挙だけ**(AC-59-1/2 の台帳を兼ねる)。
 * 既存項目の enabled の出し分け・planContextAction の対応・pathForCopy /
 * pathForReveal / clampMenuPosition / capability の各テストは無改変(AC-59-3)。
 * 新項目の enabled の出し分け(親の取れないファイルは disabled=契約#59②)・
 * 計画・実行列は open-in-new-window.acceptance.test.ts の持ち場。
 * 空白部メニュー(buildTreePaneMenu)は不変=duplicate-window 1項目のまま(契約#59⑧)。
 *
 * ## 要件#62 追補(docs/requirements/req-62.md・2026-09-23 登録・契約3・12)
 * 「Open in New Tab」をアイテムメニューの **Open With… の直後・Open in New Window の
 * 直前**に追加する(id は 'open-in-new-tab'・ラベル 'Open in New Tab'・ファイルと symlink
 * だけ・**フォルダには出さない**・ssh でも enabled=アプリの中で完結する=契約#59⑥と同じ理由)。
 * 本要件により #19/#21/#34/#59 の項目数固定(ファイル/symlink 6項目)は
 * ファイル/symlink 7項目へ**要件側更新**(承認済み=契約12)。フォルダは4項目のまま。
 * 更新するのは**ファイル・symlink の項目数・順序・ラベル・ssh の enabled の列挙だけ**。
 * 既存項目の enabled の出し分け・planContextAction の既存の対応・pathForCopy /
 * pathForReveal / clampMenuPosition / capability の各テストは無改変。
 * `planContextAction('open-in-new-tab', file)` → `{ command: 'new-tab', path: <その URI> }`
 * (AC-62-12)は本ファイル末尾の「要件#62」describe に足す。実行列(planNewTab →
 * invoke('new_tab'))は new-tab.acceptance.test.ts の持ち場。
 * 下の「意味論」1・3・5・6 の「6項目」は本追補により7項目と読み替える(過去の記述は
 * 書き換えない=本追補が正)。
 *
 * ## 要件#80 追補(docs/requirements/req-80.md・2026-11-04 由谷決定・契約 9・12・14)
 * 「Reload File」(id 'reload-file')をファイル・symlink の行の **Open in New Window の直後・
 * Copy Path の直前**に足す。有効なのはその行の URI が今の窓で開いている文書の URI と
 * **文字列で一致する**ときだけ(`buildContextMenu(entry, openDocUri?)` の第2引数。省略・null は
 * 「開いていない」=出したまま無効)。ssh でも有効(アプリの中で完結する)。
 * 「Reload Folder」(id 'reload-folder')をフォルダの行の **Open in New Window の直後**に足す
 * (常に有効・ssh でも)。ツリーの空白(buildTreePaneMenu)は **Reload Folder・Duplicate Window** の
 * 2項目(Duplicate Window は末尾のまま=要件#34)。
 * 本要件により #19/#21/#34/#59/#62 の項目数固定(ファイル/symlink 7項目・フォルダ4項目・空白1項目)は
 * ファイル/symlink 8項目・フォルダ5項目・空白2項目へ**要件側更新**(承認済み=契約12。更新は項目数・
 * 順序・ラベル・enabled の列挙だけ。ファイルの「すべて有効」は第2引数に entry.uri を渡す形で保つ)。
 * `planContextAction('reload-file', entry)` → `{ command: 'reload-file', uri: entry.uri }`・
 * `planContextAction('reload-folder', dir)` → `{ command: 'reload-folder', uri: dir.uri }`(どちらも
 * リモート判定より手前=ssh でも null にしない)。本文のメニュー `buildViewerMenu()` と判定の純関数は
 * reload-file.acceptance.test.ts の持ち場。新規の判定は本ファイル末尾の「要件#80」describe に足す。
 *
 * ## 要件#83 追補(docs/requirements/req-83.md・2026-11-05 由谷決定・契約 7・14【(e)(ab)(ae) 決定】)
 * 「Pin to Bookmarks」(id 'pin-to-bookmarks')をファイル・symlink の行の **Copy Path の直後・Duplicate Window の
 * 直前**(9 項目)と、フォルダの行の **Copy Path の直後**(6 項目)に足す。常に有効(ssh でも=アプリの中で完結する)。
 * 済み(`buildContextMenu(entry, openDocUri, pinned)` の第3引数が true)なら同じ位置が 'unpin-from-bookmarks' /
 * 'Unpin from Bookmarks'。第3引数の省略= false。ツリーの空白(buildTreePaneMenu)には置かない。本文のメニューは
 * `buildViewerMenu(pinned?)` で Reload File の後に Pin / Unpin(2 項目)。
 * `planContextAction('pin-to-bookmarks', entry)` → `{ command: 'pin-bookmark', uri: entry.uri, kind: 'file' | 'folder' }`
 * (dir= 'folder'・file / symlink= 'file')・`planContextAction('unpin-from-bookmarks', entry)` → `{ command: 'unpin-bookmark', uri: entry.uri }`
 * (どちらもリモート判定より手前=ssh でも null にしない)。
 * Dashboard のメニュー(契約 14): `buildBookmarkTileMenu(index, count)`・`buildRecentFolderMenu(pinned)`・
 * `buildAddBookmarkMenu()`。項目の区切り線は `separatorBefore?: boolean`(省略= false)で示す(描画側が線を引く)。
 * 本要件により #19/#21/#34/#59/#62/#80 の項目数固定(ファイル/symlink 8項目・フォルダ5項目)はファイル/symlink 9項目・
 * フォルダ6項目へ**要件側更新**(承認済み=契約 17 承認 3。更新は項目数・順序・ラベル・enabled の列挙だけ)。
 * 新規の判定は本ファイル末尾の「要件#83」describe(AC-83-22・23)に足す。
 *
 * ```ts
 * export type ContextMenuItem = { id: ContextMenuItemId; label: string; enabled: boolean; separatorBefore?: boolean };
 * export function buildContextMenu(entry: ContextMenuEntry, openDocUri?: string | null, pinned?: boolean): ContextMenuItem[];
 * export function buildViewerMenu(pinned?: boolean): ContextMenuItem[];
 * export function buildBookmarkTileMenu(index: number, count: number): ContextMenuItem[];
 * //   dashboard-open 'Open'・dashboard-open-in-new-window 'Open in New Window'・move-up 'Move Up'(separatorBefore)・
 * //   move-down 'Move Down'・unpin-from-bookmarks 'Unpin from Bookmarks'(separatorBefore)。index 0 → move-up 無効・
 * //   末尾 → move-down 無効
 * export function buildRecentFolderMenu(pinned: boolean): ContextMenuItem[];
 * //   dashboard-open・dashboard-open-in-new-window・pin-to-bookmarks(済みなら unpin-from-bookmarks・separatorBefore)・
 * //   remove-from-recent-folders 'Remove from Recent Folders'(separatorBefore)
 * export function buildAddBookmarkMenu(): ContextMenuItem[];
 * //   add-folder-bookmark 'Add Folder…'・add-file-bookmark 'Add File…'
 * ```
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * ```ts
 * // Entry 相当(stores/window-state.svelte の Entry と同形。tree-refresh と同じく
 * // モジュール単体でテストできるよう自身が型を持つ — re-export でも可)
 * export type ContextMenuEntry = { uri: string; name: string; kind: 'file' | 'dir' | 'symlink' };
 *
 * // メニュー1項目。id は下記5値固定・label は表示文言そのもの・enabled=false が
 * // グレーアウト(項目は出すが実行不可=契約⑤)。追加フィールドは実装の自由。
 * export type ContextMenuItem = {
 *   id: 'reveal' | 'open' | 'open-with' | 'copy-path' | 'duplicate-window';
 *   label: string;
 *   enabled: boolean;
 * };
 *
 * // 右クリックされたアイテム → メニュー項目リスト(表示順そのまま)。
 * export function buildContextMenu(entry: ContextMenuEntry): ContextMenuItem[];
 *
 * // 要件#34: ツリー空白部の右クリック用メニュー(duplicate-window 1項目のみ・enabled)。
 * export function buildTreePaneMenu(): ContextMenuItem[];
 *
 * // URI → 実行・コピーに使う値の変換。
 * // - pathForCopy: file:// → OS パス(パーセントエンコードは復号)・ssh:// → URI 文字列のまま
 * // - pathForReveal: file:// → OS パス(reveal_item_in_dir / open_path へ渡す形)。
 * //   ssh:// は呼ばれない前提だが、例外を投げず文字列を返すこと(安全側)
 * export function pathForCopy(uri: string): string;
 * export function pathForReveal(uri: string): string;
 *
 * // 項目実行の計画(純関数)。クリック配線はこの結果に従って
 * // revealItemInDir / openPath / clipboard 書き込みを呼ぶ(呼び出し自体は reviewer 照合)。
 * // disabled な組(ssh の reveal/open)は null =何もしない(グレーアウトの安全網)。
 * export type ContextAction =
 *   | { command: 'reveal_item_in_dir'; path: string }
 *   | { command: 'open_path'; path: string }
 *   | { command: 'copy'; text: string }
 *   | { command: 'pick-app'; path: string }   // 要件#21: アプリ選択ダイアログを開く計画
 *   | { command: 'duplicate-window' };        // 要件#34: ウィンドウ複製の起動(entry 非依存)
 * export function planContextAction(
 *   id: 'reveal' | 'open' | 'open-with' | 'copy-path' | 'duplicate-window',
 *   entry: ContextMenuEntry
 * ): ContextAction | null;
 *
 * // 要件#21 第2段: ダイアログの選択結果 → 実行計画(純関数)。
 * // - appPath = 選択された .app の絶対パス。null / undefined(キャンセル)→ null
 * //   =無変化(契約#21④)
 * // - ssh エントリは appPath があっても null(グレーアウトの安全網)
 * // - with = openPath(path, openWith) の第2引数へ渡す .app 絶対パス(`open -a` 相当)
 * export function planOpenWith(
 *   entry: ContextMenuEntry,
 *   appPath: string | null | undefined
 * ): { command: 'open_path'; path: string; with: string } | null;
 *
 * // はみ出し防止: メニューの左上座標をビューポート内へクランプする純計算。
 * // 収まる場合はそのまま・右/下にはみ出す場合は収まる位置へ引き戻す・負にはしない。
 * export function clampMenuPosition(
 *   pos: { x: number; y: number },
 *   size: { width: number; height: number },
 *   viewport: { width: number; height: number }
 * ): { x: number; y: number };
 * ```
 *
 * 意味論(本テストが固定する判定):
 * 1. local ファイル → [reveal, open, open-with, open-in-new-window, copy-path,
 *    duplicate-window] の6項目・この順・すべて enabled(要件#21① で open-with を
 *    「既定アプリで開く」の直後へ、要件#34③ で duplicate-window を末尾へ、
 *    要件#59① で open-in-new-window を Open With… の直後へ追加=いずれも
 *    承認済みの要件側更新)。
 * 2. local フォルダ → [reveal, open-in-new-window, copy-path, duplicate-window] の
 *    4項目(open / open-with を出さない=契約②・#21①)。
 * 3. ssh ファイル → 6項目とも出すが reveal / open / open-with は enabled=false・
 *    open-in-new-window / copy-path / duplicate-window は true(#59⑥)。
 * 4. ssh フォルダ → [reveal, open-in-new-window, copy-path, duplicate-window] で
 *    reveal は enabled=false・open-in-new-window / copy-path / duplicate-window は true。
 * 5. symlink はファイルと同じ扱い(6項目)に固定=実装裁量の確定(本テストの設計判断)。
 *    理由: フロントは symlink の指し先種別を知らないため、項目を落とすより
 *    「Finder で表示」「既定アプリで開く」を出して OS に委ねるのが安全側。
 * 6. ラベル文言は "Reveal in Finder"・"Open with Default App"・"Open With…"・
 *    "Open in New Window"・"Copy Path"・"Duplicate Window"(要件#35 で日本語表記から
 *    英語へ・要件#59 で1件追加=要件側更新)。
 * 7. 判別は URI スキームのみ(kind と組み合わせ、パス内容では分岐しない)。
 * 8. planContextAction('open-with', local ファイル) → { command: 'pick-app', path: OS パス }。
 *    ssh → null。planOpenWith は選択結果あり → open_path + with・キャンセル → null(要件#21)。
 * 9. duplicate-window は全種・ssh でも enabled(要件#34③)。
 *    planContextAction('duplicate-window', entry) は entry 非依存に
 *    { command: 'duplicate-window' } を返し、ssh でも null にしない(disabled になる組が
 *    存在しないため既存の null 家風の対象外)。buildTreePaneMenu は同項目1つだけを返す。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - ExplorerItem の contextmenu イベント → メニュー表示(div 絶対配置・theme.css の
 *   CSS 変数で見た目統一・直書き色なし)
 * - 外側クリック / Esc / 別アイテムの右クリックで閉じる・クリック後に閉じる
 * - planContextAction の結果に従う実呼び出し:
 *   reveal → @tauri-apps/plugin-opener の revealItemInDir(path)・
 *   open → openPath(path)・copy → clipboard 書き込み(navigator.clipboard 等)
 * - pick-app → @tauri-apps/plugin-dialog(既存依存)の open ダイアログ呼び出し
 *   (defaultPath=/Applications・filter=app 拡張子=要件#21②)と、その戻り値を
 *   planOpenWith へ渡して openPath(path, with) を呼ぶ配線。起動失敗は warn 止まり(#21④)
 * - Rust 変更なし(フロント+ capability のみ)=契約⑦・#21⑥
 * - 要件#34: 末尾の区切り線の描画・ツリー空白部の contextmenu イベント →
 *   buildTreePaneMenu の表示・{ command: 'duplicate-window' } → 複製実行列
 *   (duplicate-window.ts の plan → invoke('new_window'))への合流。
 *   Rust 側の受け皿は acceptance_req34.rs 参照
 *
 * ## 人間ゲート(acceptance/acceptance.md)
 * - 実機での右クリック表示・Finder 起動・既定アプリ起動・コピー結果・
 *   グレーアウトの見た目・はみ出し防止の実挙動
 * - 実機でのアプリ選択ダイアログ表示 → 選択アプリでの起動(要件#21)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
	buildAddBookmarkMenu,
	buildBookmarkTileMenu,
	buildContextMenu,
	buildRecentFolderMenu,
	buildTreePaneMenu,
	buildViewerMenu,
	clampMenuPosition,
	pathForCopy,
	pathForReveal,
	planContextAction,
	planOpenWith,
	type ContextMenuEntry,
} from './context-menu';

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
const localSymlink: ContextMenuEntry = {
	uri: 'file:///Users/x/notes/link',
	name: 'link',
	kind: 'symlink',
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

// ---------------------------------------------------------------------------
// buildContextMenu — 項目構成の出し分け(契約②⑤)
// ---------------------------------------------------------------------------

describe('buildContextMenu — local アイテムの項目構成', () => {
	// 要件#80 契約12(2026-11-04 承認の要件側更新): open-in-new-window の直後に reload-file が増えて
	// 7項目→8項目。「すべて有効」は第2引数に entry.uri(=その行を開いている)を渡す形で保つ。
	// 要件#83 契約 7(2026-11-05 承認 3 の要件側更新): copy-path の直後に pin-to-bookmarks が増えて 8項目→9項目。
	// 第3引数(済みか)の省略= false= Pin to Bookmarks(常に有効)。
	test('local ファイル → reveal・open・open-with・open-in-new-tab・open-in-new-window・reload-file・copy-path・pin-to-bookmarks・duplicate-window の9項目・この順・すべて有効', () => {
		const items = buildContextMenu(localFile, localFile.uri);
		expect(items.map((i) => i.id)).toEqual([
			'reveal',
			'open',
			'open-with',
			'open-in-new-tab',
			'open-in-new-window',
			'reload-file',
			'copy-path',
			'pin-to-bookmarks',
			'duplicate-window',
		]);
		expect(items.every((i) => i.enabled)).toBe(true);
	});

	// 要件#80 契約12: open-in-new-window の直後に reload-folder が増えて 4項目→5項目。
	// 要件#83 契約 7(承認 3): copy-path の直後に pin-to-bookmarks が増えて 5項目→6項目。
	test('local フォルダ → reveal・open-in-new-window・reload-folder・copy-path・pin-to-bookmarks・duplicate-window の6項目(open は出さない)・すべて有効', () => {
		const items = buildContextMenu(localDir);
		expect(items.map((i) => i.id)).toEqual([
			'reveal',
			'open-in-new-window',
			'reload-folder',
			'copy-path',
			'pin-to-bookmarks',
			'duplicate-window',
		]);
		expect(items.every((i) => i.enabled)).toBe(true);
	});

	test('ラベル文言は英語の推奨文言(要件#35①・#59①・#62・#80・#83=local ファイルの9項目)', () => {
		const labels = buildContextMenu(localFile).map((i) => i.label);
		expect(labels).toEqual([
			'Reveal in Finder',
			'Open with Default App',
			'Open With…',
			'Open in New Tab',
			'Open in New Window',
			'Reload File',
			'Copy Path',
			'Pin to Bookmarks',
			'Duplicate Window',
		]);
	});

	test('symlink はファイルと同じ9項目に固定(実装裁量の確定=一貫性)', () => {
		const items = buildContextMenu(localSymlink, localSymlink.uri);
		expect(items.map((i) => i.id)).toEqual([
			'reveal',
			'open',
			'open-with',
			'open-in-new-tab',
			'open-in-new-window',
			'reload-file',
			'copy-path',
			'pin-to-bookmarks',
			'duplicate-window',
		]);
		expect(items.every((i) => i.enabled)).toBe(true);
	});
});

describe('buildContextMenu — ssh リモートは reveal / open をグレーアウト(契約⑤)', () => {
	// 要件#80 契約12(2026-11-04 承認の要件側更新): reload-file(6番目)が増えて 8項目。開いている URI を
	// 渡さない呼び方なので reload-file は false(ssh だからではなく「開いていない」から=要件#80 の describe が対にする)。
	// 要件#83 契約 7(2026-11-05 承認 3): copy-path の直後に pin-to-bookmarks(ssh でも有効=アプリの中で完結する)が増えて 9項目。
	test('ssh ファイル → 9項目とも出すが reveal / open / open-with は disabled・open-in-new-tab / open-in-new-window / copy-path / pin-to-bookmarks / duplicate-window は有効(reload-file は開いていないので disabled)', () => {
		const items = buildContextMenu(sshFile);
		expect(items.map((i) => i.id)).toEqual([
			'reveal',
			'open',
			'open-with',
			'open-in-new-tab',
			'open-in-new-window',
			'reload-file',
			'copy-path',
			'pin-to-bookmarks',
			'duplicate-window',
		]);
		expect(items.map((i) => i.enabled)).toEqual([false, false, false, true, true, false, true, true, true]);
	});

	// 要件#80 契約12: reload-folder(3番目・ssh でも有効)が増えて 5項目。要件#83 契約 7(承認 3): pin-to-bookmarks が増えて 6項目。
	test('ssh フォルダ → reveal(disabled)+open-in-new-window・reload-folder・copy-path・pin-to-bookmarks・duplicate-window(有効)の6項目', () => {
		const items = buildContextMenu(sshDir);
		expect(items.map((i) => i.id)).toEqual([
			'reveal',
			'open-in-new-window',
			'reload-folder',
			'copy-path',
			'pin-to-bookmarks',
			'duplicate-window',
		]);
		expect(items.map((i) => i.enabled)).toEqual([false, true, true, true, true, true]);
	});

	test('ssh symlink もファイル同等(9項目・reveal / open / open-with disabled)=一貫性', () => {
		const items = buildContextMenu({ ...sshFile, kind: 'symlink' });
		expect(items.map((i) => i.id)).toEqual([
			'reveal',
			'open',
			'open-with',
			'open-in-new-tab',
			'open-in-new-window',
			'reload-file',
			'copy-path',
			'pin-to-bookmarks',
			'duplicate-window',
		]);
		expect(items.map((i) => i.enabled)).toEqual([false, false, false, true, true, false, true, true, true]);
	});

	test('判別は URI スキーム(user なし・ポートなしの ssh URI でも disabled)', () => {
		const items = buildContextMenu({
			uri: 'ssh://host/srv/notes/plan.md',
			name: 'plan.md',
			kind: 'file',
		});
		expect(items.map((i) => i.enabled)).toEqual([false, false, false, true, true, false, true, true, true]);
	});
});

// ---------------------------------------------------------------------------
// pathForCopy / pathForReveal — URI → パス変換(契約③④)
// ---------------------------------------------------------------------------

describe('pathForCopy — ローカルは OS パス・ssh は URI 文字列(契約④)', () => {
	test('file:// URI → OS 絶対パス', () => {
		expect(pathForCopy('file:///Users/x/a.md')).toBe('/Users/x/a.md');
	});

	test('パーセントエンコードされた空白を復号する', () => {
		expect(pathForCopy('file:///Users/x/My%20Docs/read%20me.md')).toBe(
			'/Users/x/My Docs/read me.md'
		);
	});

	test('パーセントエンコードされた日本語を復号する', () => {
		expect(pathForCopy('file:///Users/x/%E8%B3%87%E6%96%99/%E3%83%A1%E3%83%A2.md')).toBe(
			'/Users/x/資料/メモ.md'
		);
	});

	test('backend の生文字列(エンコードなしの空白)はそのまま OS パスになる', () => {
		// backend は percent-encode しない生 URI を返す(menu-open / tree-refresh と同じ前提)。
		expect(pathForCopy('file:///Users/x/My Docs/read me.md')).toBe(
			'/Users/x/My Docs/read me.md'
		);
	});

	test('ssh URI はそのまま文字列で返す(復号・変形しない)', () => {
		expect(pathForCopy('ssh://alice@host:22/srv/notes/plan.md')).toBe(
			'ssh://alice@host:22/srv/notes/plan.md'
		);
	});
});

describe('pathForReveal — 実行(reveal_item_in_dir / open_path)へ渡す OS パス', () => {
	test('file:// URI → OS 絶対パス(pathForCopy のローカル系と同じ変換)', () => {
		expect(pathForReveal('file:///Users/x/notes/plan.md')).toBe('/Users/x/notes/plan.md');
	});

	test('パーセントエンコード(空白)を復号したパスを返す', () => {
		expect(pathForReveal('file:///Users/x/My%20Docs')).toBe('/Users/x/My Docs');
	});

	test('ssh URI でも例外を投げず文字列を返す(呼ばれない前提の安全網)', () => {
		expect(() => pathForReveal('ssh://alice@host:22/srv/notes')).not.toThrow();
		expect(typeof pathForReveal('ssh://alice@host:22/srv/notes')).toBe('string');
	});
});

// ---------------------------------------------------------------------------
// planContextAction — 項目 → 実行計画(契約③④の対応固定)
// ---------------------------------------------------------------------------

describe('planContextAction — 各項目が使う手段の固定(契約③)', () => {
	test("reveal → opener の reveal_item_in_dir に OS パス", () => {
		expect(planContextAction('reveal', localFile)).toEqual({
			command: 'reveal_item_in_dir',
			path: '/Users/x/notes/plan.md',
		});
	});

	test("open → opener の open_path に OS パス", () => {
		expect(planContextAction('open', localFile)).toEqual({
			command: 'open_path',
			path: '/Users/x/notes/plan.md',
		});
	});

	test('copy-path(local)→ clipboard へ OS パス', () => {
		expect(planContextAction('copy-path', localFile)).toEqual({
			command: 'copy',
			text: '/Users/x/notes/plan.md',
		});
	});

	test('copy-path(ssh)→ clipboard へ URI 文字列そのまま(契約④)', () => {
		expect(planContextAction('copy-path', sshFile)).toEqual({
			command: 'copy',
			text: 'ssh://alice@host:22/srv/notes/plan.md',
		});
	});

	test('ssh の reveal / open は null =実行しない(グレーアウトの安全網)', () => {
		expect(planContextAction('reveal', sshFile)).toBeNull();
		expect(planContextAction('open', sshDir)).toBeNull();
	});

	test('フォルダの reveal もファイルと同じく reveal_item_in_dir(Finder で表示)', () => {
		expect(planContextAction('reveal', localDir)).toEqual({
			command: 'reveal_item_in_dir',
			path: '/Users/x/notes',
		});
	});
});

// ---------------------------------------------------------------------------
// 要件#21 — 「アプリを選択して開く…」(出し分けの詳細・ダイアログ計画・第2段)
// ---------------------------------------------------------------------------

describe('要件#21: buildContextMenu — 「アプリを選択して開く…」の出し分け(契約#21①)', () => {
	test('local ファイルでは「既定アプリで開く」の直後に置かれる', () => {
		const items = buildContextMenu(localFile);
		const openIdx = items.findIndex((i) => i.id === 'open');
		expect(openIdx).toBeGreaterThanOrEqual(0);
		expect(items[openIdx + 1]?.id).toBe('open-with');
	});

	test('ラベルは "Open With…"(要件#35)・local ファイルは enabled', () => {
		const item = buildContextMenu(localFile).find((i) => i.id === 'open-with');
		expect(item).toMatchObject({ label: 'Open With…', enabled: true });
	});

	test('フォルダには出さない(local / ssh とも)', () => {
		expect(buildContextMenu(localDir).some((i) => i.id === 'open-with')).toBe(false);
		expect(buildContextMenu(sshDir).some((i) => i.id === 'open-with')).toBe(false);
	});

	test('ssh ファイルでは項目は出すが disabled(#19 の出し分け踏襲)', () => {
		const item = buildContextMenu(sshFile).find((i) => i.id === 'open-with');
		expect(item).toMatchObject({ label: 'Open With…', enabled: false });
	});
});

describe('要件#21: planContextAction(open-with)— アプリ選択ダイアログの計画', () => {
	test('local ファイル → pick-app 計画(開く対象の OS パス)', () => {
		expect(planContextAction('open-with', localFile)).toEqual({
			command: 'pick-app',
			path: '/Users/x/notes/plan.md',
		});
	});

	test('パーセントエンコードされたパスは復号した OS パスで計画する', () => {
		expect(
			planContextAction('open-with', {
				uri: 'file:///Users/x/My%20Docs/read%20me.md',
				name: 'read me.md',
				kind: 'file',
			})
		).toEqual({ command: 'pick-app', path: '/Users/x/My Docs/read me.md' });
	});

	test('ssh ファイル → null =実行しない(disabled の安全網)', () => {
		expect(planContextAction('open-with', sshFile)).toBeNull();
	});
});

describe('要件#21: planOpenWith — 選択結果 → open_path(path, with)(契約#21②④)', () => {
	test('選択した .app の絶対パス → open_path + with', () => {
		expect(planOpenWith(localFile, '/Applications/TextEdit.app')).toEqual({
			command: 'open_path',
			path: '/Users/x/notes/plan.md',
			with: '/Applications/TextEdit.app',
		});
	});

	test('キャンセル(null / undefined)→ null =無変化(契約#21④)', () => {
		expect(planOpenWith(localFile, null)).toBeNull();
		expect(planOpenWith(localFile, undefined)).toBeNull();
	});

	test('ssh エントリは appPath があっても null(グレーアウトの安全網)', () => {
		expect(planOpenWith(sshFile, '/Applications/TextEdit.app')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 要件#34 — 「ウィンドウを複製」(末尾追加・常に enabled・空白部メニュー・実行計画)
// ---------------------------------------------------------------------------

describe('要件#34: buildContextMenu — "Duplicate Window" は末尾・全種・ssh でも有効(契約#34③)', () => {
	test('local ファイルでは末尾に置かれ、ラベルは "Duplicate Window"(要件#35)・enabled', () => {
		const items = buildContextMenu(localFile);
		expect(items[items.length - 1]).toMatchObject({
			id: 'duplicate-window',
			label: 'Duplicate Window',
			enabled: true,
		});
	});

	test('local フォルダでも末尾に enabled で出る(アイテム非依存の窓操作)', () => {
		const items = buildContextMenu(localDir);
		expect(items[items.length - 1]).toMatchObject({
			id: 'duplicate-window',
			label: 'Duplicate Window',
			enabled: true,
		});
	});

	test('ssh ファイル/フォルダでも enabled(グレーアウトしない=他項目と違う出し分け)', () => {
		const fromFile = buildContextMenu(sshFile).find((i) => i.id === 'duplicate-window');
		const fromDir = buildContextMenu(sshDir).find((i) => i.id === 'duplicate-window');
		expect(fromFile).toMatchObject({ label: 'Duplicate Window', enabled: true });
		expect(fromDir).toMatchObject({ label: 'Duplicate Window', enabled: true });
	});
});

describe('要件#34: buildTreePaneMenu — ツリー空白部の右クリック(契約#34③)', () => {
	// 要件#80 契約12・14(2026-11-04 承認の要件側更新): 先頭に reload-folder が増えて 1項目→2項目。
	// Duplicate Window が末尾・有効・ラベルどおりであることは保つ(要件#34 の「末尾」)。
	test('duplicate-window は末尾(2項目のうち最後)・ラベル "Duplicate Window"(要件#35)・enabled', () => {
		const items = buildTreePaneMenu();
		expect(items).toHaveLength(2);
		expect(items[items.length - 1]).toMatchObject({
			id: 'duplicate-window',
			label: 'Duplicate Window',
			enabled: true,
		});
	});
});

describe('要件#34: planContextAction(duplicate-window)— entry 非依存の窓操作', () => {
	test("local ファイル → { command: 'duplicate-window' }(パス等の entry 情報を持たない)", () => {
		expect(planContextAction('duplicate-window', localFile)).toEqual({
			command: 'duplicate-window',
		});
	});

	test('local フォルダでも同じ計画(entry 非依存)', () => {
		expect(planContextAction('duplicate-window', localDir)).toEqual({
			command: 'duplicate-window',
		});
	});

	test('ssh エントリでも null にしない(ssh でも有効=契約#34③。既存の remote null 家風の対象外)', () => {
		expect(planContextAction('duplicate-window', sshFile)).toEqual({
			command: 'duplicate-window',
		});
		expect(planContextAction('duplicate-window', sshDir)).toEqual({
			command: 'duplicate-window',
		});
	});
});

// ---------------------------------------------------------------------------
// 要件#62 — 「Open in New Tab」(位置・出し分け・計画=AC-62-12・契約3・12)
// ---------------------------------------------------------------------------

describe('要件#62 AC-62-12: buildContextMenu — "Open in New Tab" はファイル・symlink にちょうど1つ・Open With… の直後・Open in New Window の直前', () => {
	const newTabIndex = (entry: ContextMenuEntry) =>
		buildContextMenu(entry).findIndex((i) => i.id === 'open-in-new-tab');

	test('local ファイル: open-with の直後・open-in-new-window の直前に1つ・ラベル "Open in New Tab"・enabled', () => {
		const items = buildContextMenu(localFile);
		const idx = items.findIndex((i) => i.id === 'open-in-new-tab');
		expect(items.filter((i) => i.id === 'open-in-new-tab')).toHaveLength(1);
		expect(items[idx - 1]?.id).toBe('open-with');
		expect(items[idx + 1]?.id).toBe('open-in-new-window');
		expect(items[idx]).toEqual({ id: 'open-in-new-tab', label: 'Open in New Tab', enabled: true });
	});

	test('symlink もファイルと同じ位置に1つ', () => {
		const items = buildContextMenu(localSymlink);
		const idx = items.findIndex((i) => i.id === 'open-in-new-tab');
		expect(items.filter((i) => i.id === 'open-in-new-tab')).toHaveLength(1);
		expect(items[idx - 1]?.id).toBe('open-with');
		expect(items[idx + 1]?.id).toBe('open-in-new-window');
	});

	// 要件#80 契約12(2026-11-04 承認の要件側更新): フォルダは reload-folder が増えて 4項目→5項目。
	// 要件#83 契約 7(2026-11-05 承認 3): pin-to-bookmarks が増えて 5項目→6項目。
	// open-in-new-tab がフォルダに無いことの assert はそのまま。
	test('フォルダには出さない(local / ssh とも6項目のまま)', () => {
		expect(newTabIndex(localDir)).toBe(-1);
		expect(newTabIndex(sshDir)).toBe(-1);
		expect(buildContextMenu(localDir)).toHaveLength(6);
		expect(buildContextMenu(sshDir)).toHaveLength(6);
	});

	test('ssh のファイル / symlink でも enabled: true(アプリの中で完結する=契約#59⑥と同じ理由)', () => {
		const fromFile = buildContextMenu(sshFile).find((i) => i.id === 'open-in-new-tab');
		const fromSymlink = buildContextMenu({ ...sshFile, kind: 'symlink' }).find(
			(i) => i.id === 'open-in-new-tab'
		);
		expect(fromFile).toEqual({ id: 'open-in-new-tab', label: 'Open in New Tab', enabled: true });
		expect(fromSymlink).toEqual({ id: 'open-in-new-tab', label: 'Open in New Tab', enabled: true });
	});

	test('空白部メニュー(buildTreePaneMenu)には出ない(不変)', () => {
		expect(buildTreePaneMenu().some((i) => i.id === 'open-in-new-tab')).toBe(false);
	});
});

describe("要件#62 AC-62-12: planContextAction('open-in-new-tab', file) → { command: 'new-tab', path: <その URI> }", () => {
	test('local ファイル → URI のまま(正規化しない)', () => {
		expect(planContextAction('open-in-new-tab', localFile)).toEqual({
			command: 'new-tab',
			path: 'file:///Users/x/notes/plan.md',
		});
	});

	test('symlink もファイルと同じ計画', () => {
		expect(planContextAction('open-in-new-tab', localSymlink)).toEqual({
			command: 'new-tab',
			path: 'file:///Users/x/notes/link',
		});
	});

	test('パーセントエンコードされたファイルも URI のまま(復号しない=new_tab へは URI で渡す)', () => {
		expect(
			planContextAction('open-in-new-tab', {
				uri: 'file:///Users/x/My%20Docs/read%20me.md',
				name: 'read me.md',
				kind: 'file',
			})
		).toEqual({ command: 'new-tab', path: 'file:///Users/x/My%20Docs/read%20me.md' });
	});

	test('ssh ファイルでも null にしない(ssh でも有効=enabled と対になる)', () => {
		expect(planContextAction('open-in-new-tab', sshFile)).toEqual({
			command: 'new-tab',
			path: 'ssh://alice@host:22/srv/notes/plan.md',
		});
	});
});

// ---------------------------------------------------------------------------
// 要件#80 — 「Reload File」(ファイルの行・AC-80-11・契約 9)【(h) 決定】
// ---------------------------------------------------------------------------

describe('要件#80 AC-80-11: buildContextMenu(entry, openDocUri) — ファイル・symlink の行の "Reload File"(契約 9)', () => {
	// 要件#83 契約 7(2026-11-05 承認 3 の要件側更新): copy-path の直後に pin-to-bookmarks(常に有効)が増えて 9つ。
	const FILE_IDS = [
		'reveal',
		'open',
		'open-with',
		'open-in-new-tab',
		'open-in-new-window',
		'reload-file',
		'copy-path',
		'pin-to-bookmarks',
		'duplicate-window',
	];
	const reloadFile = (entry: ContextMenuEntry, openDocUri?: string | null) =>
		buildContextMenu(entry, openDocUri).find((i) => i.id === 'reload-file');

	test('1. local のファイルで開いている(第2引数が entry.uri)→ 9つ・この順・すべて有効', () => {
		const items = buildContextMenu(localFile, localFile.uri);
		expect(items.map((i) => i.id)).toEqual(FILE_IDS);
		expect(items.map((i) => i.enabled)).toEqual([true, true, true, true, true, true, true, true, true]);
	});

	test('2. 第2引数が別の URI・省略・null → 同じ9つで、reload-file だけが無効(ほかの有効/無効は今と同じ)', () => {
		for (const openDocUri of ['file:///Users/x/notes/other.md', undefined, null] as const) {
			const items = buildContextMenu(localFile, openDocUri);
			expect(items.map((i) => i.id), String(openDocUri)).toEqual(FILE_IDS);
			expect(items.map((i) => i.enabled), String(openDocUri)).toEqual([
				true,
				true,
				true,
				true,
				true,
				false,
				true,
				true,
				true,
			]);
		}
	});

	test('3. ssh のファイルで開いている → [false, false, false, true, true, true, true, true, true]。開いていない → reload-file だけ false', () => {
		expect(buildContextMenu(sshFile, sshFile.uri).map((i) => i.enabled)).toEqual([
			false,
			false,
			false,
			true,
			true,
			true,
			true,
			true,
			true,
		]);
		expect(buildContextMenu(sshFile, 'ssh://alice@host:22/srv/notes/other.md').map((i) => i.enabled)).toEqual([
			false,
			false,
			false,
			true,
			true,
			false,
			true,
			true,
			true,
		]);
		expect(buildContextMenu(sshFile).map((i) => i.enabled)).toEqual([false, false, false, true, true, false, true, true, true]);
	});

	test('4. シンボリックリンクはファイルと同じ(local・ssh とも)', () => {
		const sshSymlink: ContextMenuEntry = { ...sshFile, kind: 'symlink' };
		expect(buildContextMenu(localSymlink, localSymlink.uri).map((i) => i.id)).toEqual(FILE_IDS);
		expect(buildContextMenu(localSymlink, localSymlink.uri).every((i) => i.enabled)).toBe(true);
		expect(reloadFile(localSymlink)).toMatchObject({ enabled: false });
		expect(buildContextMenu(sshSymlink, sshSymlink.uri).map((i) => i.id)).toEqual(FILE_IDS);
		expect(buildContextMenu(sshSymlink, sshSymlink.uri).map((i) => i.enabled)).toEqual([
			false,
			false,
			false,
			true,
			true,
			true,
			true,
			true,
			true,
		]);
		expect(reloadFile(sshSymlink)).toMatchObject({ enabled: false });
	});

	test('5. ファイル・symlink の行に reload-folder は無い。フォルダの行(第2引数がそのフォルダの URI でも)と buildTreePaneMenu() に reload-file は無い', () => {
		for (const entry of [localFile, localSymlink, sshFile, { ...sshFile, kind: 'symlink' as const }]) {
			expect(buildContextMenu(entry, entry.uri).some((i) => i.id === 'reload-folder'), entry.uri).toBe(false);
		}
		for (const dir of [localDir, sshDir]) {
			expect(buildContextMenu(dir, dir.uri).some((i) => i.id === 'reload-file'), dir.uri).toBe(false);
			expect(buildContextMenu(dir).some((i) => i.id === 'reload-file'), dir.uri).toBe(false);
		}
		expect(buildTreePaneMenu().some((i) => i.id === 'reload-file')).toBe(false);
	});

	test('6. 比べ方は文字列の一致(file:///r/a%20b.md の行に file:///r/a b.md を渡すと無効。同じ字面なら有効)', () => {
		const encoded: ContextMenuEntry = { uri: 'file:///r/a%20b.md', name: 'a b.md', kind: 'file' };
		expect(reloadFile(encoded, 'file:///r/a b.md')).toMatchObject({ id: 'reload-file', enabled: false });
		expect(reloadFile(encoded, 'file:///r/a%20b.md')).toMatchObject({ id: 'reload-file', enabled: true });
	});

	test("7. ラベルは 'Reload File'。planContextAction('reload-file', entry) は { command: 'reload-file', uri: entry.uri }(local・ssh とも null にしない)", () => {
		expect(reloadFile(localFile, localFile.uri)).toEqual({ id: 'reload-file', label: 'Reload File', enabled: true });
		expect(reloadFile(sshFile)).toEqual({ id: 'reload-file', label: 'Reload File', enabled: false });
		expect(planContextAction('reload-file', localFile)).toEqual({
			command: 'reload-file',
			uri: 'file:///Users/x/notes/plan.md',
		});
		expect(planContextAction('reload-file', localSymlink)).toEqual({
			command: 'reload-file',
			uri: 'file:///Users/x/notes/link',
		});
		expect(planContextAction('reload-file', sshFile)).toEqual({
			command: 'reload-file',
			uri: 'ssh://alice@host:22/srv/notes/plan.md',
		});
	});
});

// ---------------------------------------------------------------------------
// 要件#80 — 「Reload Folder」(フォルダの行・空白・AC-80-15・契約 14)【(i)(m)(n)(p)(v) 決定】
// ---------------------------------------------------------------------------

describe('要件#80 AC-80-15: buildContextMenu(dir) / buildTreePaneMenu() — "Reload Folder"(契約 14)', () => {
	// 要件#83 契約 7(2026-11-05 承認 3 の要件側更新): copy-path の直後に pin-to-bookmarks(常に有効)が増えて 6つ。
	const DIR_IDS = ['reveal', 'open-in-new-window', 'reload-folder', 'copy-path', 'pin-to-bookmarks', 'duplicate-window'];

	test('1. local のフォルダ → 6つ・この順・すべて有効', () => {
		const items = buildContextMenu(localDir);
		expect(items.map((i) => i.id)).toEqual(DIR_IDS);
		expect(items.map((i) => i.enabled)).toEqual([true, true, true, true, true, true]);
	});

	test('2. ssh のフォルダ → 同じ6つで、enabled が [false, true, true, true, true, true]', () => {
		const items = buildContextMenu(sshDir);
		expect(items.map((i) => i.id)).toEqual(DIR_IDS);
		expect(items.map((i) => i.enabled)).toEqual([false, true, true, true, true, true]);
	});

	test('3. フォルダの行は第2引数(開いている文書の URI)に左右されない(そのフォルダの URI・別の URI・省略・null で同じ)', () => {
		const variants = [localDir.uri, 'file:///Users/x/notes/plan.md', undefined, null] as const;
		const local = variants.map((v) => buildContextMenu(localDir, v));
		const ssh = variants.map((v) => buildContextMenu(sshDir, v));
		for (const items of local) {
			expect(items.map((i) => i.id)).toEqual(DIR_IDS);
			expect(items.map((i) => i.enabled)).toEqual([true, true, true, true, true, true]);
		}
		for (const items of ssh) {
			expect(items.map((i) => i.id)).toEqual(DIR_IDS);
			expect(items.map((i) => i.enabled)).toEqual([false, true, true, true, true, true]);
		}
	});

	test("4. ラベルは 'Reload Folder'。planContextAction('reload-folder', dir) は { command: 'reload-folder', uri: dir.uri }(local・ssh とも null にしない)", () => {
		expect(buildContextMenu(localDir).find((i) => i.id === 'reload-folder')).toEqual({
			id: 'reload-folder',
			label: 'Reload Folder',
			enabled: true,
		});
		expect(buildContextMenu(sshDir).find((i) => i.id === 'reload-folder')).toEqual({
			id: 'reload-folder',
			label: 'Reload Folder',
			enabled: true,
		});
		expect(planContextAction('reload-folder', localDir)).toEqual({
			command: 'reload-folder',
			uri: 'file:///Users/x/notes',
		});
		expect(planContextAction('reload-folder', sshDir)).toEqual({
			command: 'reload-folder',
			uri: 'ssh://alice@host:22/srv/notes',
		});
	});

	test('5. buildTreePaneMenu() → [reload-folder "Reload Folder" 有効, duplicate-window "Duplicate Window" 有効](この順)', () => {
		expect(buildTreePaneMenu()).toEqual([
			{ id: 'reload-folder', label: 'Reload Folder', enabled: true },
			{ id: 'duplicate-window', label: 'Duplicate Window', enabled: true },
		]);
	});

	test('6. 全種(local / ssh × file / dir / symlink・空白)のラベルに CJK が無い', () => {
		const cjk = /[　-〿぀-ヿ一-鿿＀-￯]/;
		const entries: ContextMenuEntry[] = [
			localFile,
			localDir,
			localSymlink,
			sshFile,
			sshDir,
			{ ...sshFile, kind: 'symlink' },
		];
		const labels = [
			...entries.flatMap((e) => buildContextMenu(e, e.uri).map((i) => i.label)),
			...buildTreePaneMenu().map((i) => i.label),
		];
		expect(labels).toContain('Reload File');
		expect(labels).toContain('Reload Folder');
		for (const label of labels) expect(label).not.toMatch(cjk);
	});
});

// ---------------------------------------------------------------------------
// clampMenuPosition — ウィンドウ端でのはみ出し防止(契約①の純計算部分)
// ---------------------------------------------------------------------------

describe('clampMenuPosition — はみ出し防止のクランプ', () => {
	const size = { width: 200, height: 90 };
	const viewport = { width: 800, height: 600 };

	test('収まる位置はそのまま', () => {
		expect(clampMenuPosition({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 100, y: 100 });
	});

	test('右端ではみ出す → 右端に収まる位置へ引き戻す', () => {
		const pos = clampMenuPosition({ x: 700, y: 100 }, size, viewport);
		expect(pos.x + size.width).toBeLessThanOrEqual(viewport.width);
		expect(pos.y).toBe(100);
	});

	test('下端ではみ出す → 下端に収まる位置へ引き戻す', () => {
		const pos = clampMenuPosition({ x: 100, y: 580 }, size, viewport);
		expect(pos.y + size.height).toBeLessThanOrEqual(viewport.height);
		expect(pos.x).toBe(100);
	});

	test('右下角(両方はみ出す)でも収まり、座標は負にならない', () => {
		const pos = clampMenuPosition({ x: 790, y: 590 }, size, viewport);
		expect(pos.x + size.width).toBeLessThanOrEqual(viewport.width);
		expect(pos.y + size.height).toBeLessThanOrEqual(viewport.height);
		expect(pos.x).toBeGreaterThanOrEqual(0);
		expect(pos.y).toBeGreaterThanOrEqual(0);
	});
});

// ---------------------------------------------------------------------------
// capability — opener の permission 追加(契約③のソース検査)
// ---------------------------------------------------------------------------

describe('capability(src-tauri/capabilities/default.json)— opener permission', () => {
	const capabilityPath = resolve(__dirname, '../../src-tauri/capabilities/default.json');
	const capability = JSON.parse(readFileSync(capabilityPath, 'utf-8')) as {
		permissions: Array<string | { identifier: string; allow?: unknown[] }>;
	};
	const identifiers = capability.permissions.map((p) =>
		typeof p === 'string' ? p : p.identifier
	);

	test('opener:allow-reveal-item-in-dir が追加されている', () => {
		expect(identifiers).toContain('opener:allow-reveal-item-in-dir');
	});

	test('opener:allow-open-path が追加されている', () => {
		expect(identifiers).toContain('opener:allow-open-path');
	});

	test('opener:allow-open-path の scope は path:"**" かつ app:true(要件#21③)', () => {
		const openPath = capability.permissions.find(
			(p) => typeof p !== 'string' && p.identifier === 'opener:allow-open-path'
		);
		expect(openPath).toBeDefined();
		const allow = (openPath as { allow?: Array<{ path?: string; app?: boolean }> }).allow;
		expect(allow).toEqual([{ path: '**', app: true }]);
	});

	test('既存 opener:allow-open-url の url scope は変更しない(https/http/mailto/tel)', () => {
		const openUrl = capability.permissions.find(
			(p) => typeof p !== 'string' && p.identifier === 'opener:allow-open-url'
		);
		expect(openUrl).toBeDefined();
		const urls = (openUrl as { allow?: Array<{ url?: string }> }).allow?.map((a) => a.url);
		expect(urls).toEqual(['https://*', 'http://*', 'mailto:*', 'tel:*']);
	});
});

// ---------------------------------------------------------------------------
// 要件#83 — 「Pin to Bookmarks」(Explorer の行・本文=AC-83-22・契約 7)【(e) 決定・(ab) 決定】
// ---------------------------------------------------------------------------

describe('要件#83 AC-83-22: buildContextMenu(entry, openDocUri, pinned) / buildViewerMenu(pinned) — Pin / Unpin(契約 7)', () => {
	const FILE_IDS = [
		'reveal',
		'open',
		'open-with',
		'open-in-new-tab',
		'open-in-new-window',
		'reload-file',
		'copy-path',
		'pin-to-bookmarks',
		'duplicate-window',
	];
	const FILE_IDS_PINNED = FILE_IDS.map((id) => (id === 'pin-to-bookmarks' ? 'unpin-from-bookmarks' : id));
	const DIR_IDS = ['reveal', 'open-in-new-window', 'reload-folder', 'copy-path', 'pin-to-bookmarks', 'duplicate-window'];
	const DIR_IDS_PINNED = DIR_IDS.map((id) => (id === 'pin-to-bookmarks' ? 'unpin-from-bookmarks' : id));
	const pinItem = (items: ReturnType<typeof buildContextMenu>) =>
		items.find((i) => i.id === 'pin-to-bookmarks' || i.id === 'unpin-from-bookmarks');

	test('1. local のファイル buildContextMenu(entry, entry.uri, false) → 9 つ・すべて有効。true → 同じ位置が unpin-from-bookmarks。省略= false', () => {
		const items = buildContextMenu(localFile, localFile.uri, false);
		expect(items.map((i) => i.id)).toEqual(FILE_IDS);
		expect(items.every((i) => i.enabled)).toBe(true);
		expect(items[7]).toMatchObject({ id: 'pin-to-bookmarks', label: 'Pin to Bookmarks', enabled: true });

		const pinned = buildContextMenu(localFile, localFile.uri, true);
		expect(pinned.map((i) => i.id)).toEqual(FILE_IDS_PINNED);
		expect(pinned.every((i) => i.enabled)).toBe(true);
		expect(pinned[7]).toMatchObject({ id: 'unpin-from-bookmarks', label: 'Unpin from Bookmarks', enabled: true });

		expect(buildContextMenu(localFile, localFile.uri).map((i) => i.id)).toEqual(FILE_IDS);
		expect(buildContextMenu(localFile).map((i) => i.id)).toEqual(FILE_IDS);
		expect(buildContextMenu(localFile, null, undefined).map((i) => i.id)).toEqual(FILE_IDS);
	});

	test('2. local のフォルダ → 6 つ・すべて有効。true → unpin-from-bookmarks', () => {
		const items = buildContextMenu(localDir, null, false);
		expect(items.map((i) => i.id)).toEqual(DIR_IDS);
		expect(items.every((i) => i.enabled)).toBe(true);
		expect(items[4]).toMatchObject({ id: 'pin-to-bookmarks', label: 'Pin to Bookmarks', enabled: true });

		const pinned = buildContextMenu(localDir, null, true);
		expect(pinned.map((i) => i.id)).toEqual(DIR_IDS_PINNED);
		expect(pinned.every((i) => i.enabled)).toBe(true);
		expect(pinned[4]).toMatchObject({ id: 'unpin-from-bookmarks', label: 'Unpin from Bookmarks', enabled: true });
		expect(buildContextMenu(localDir).map((i) => i.id)).toEqual(DIR_IDS);
	});

	test('3. ssh のファイル・フォルダ・シンボリックリンクでも Pin / Unpin は有効(位置も同じ)', () => {
		const sshSymlink: ContextMenuEntry = { ...sshFile, kind: 'symlink' };
		for (const entry of [sshFile, sshSymlink, localSymlink]) {
			const items = buildContextMenu(entry, entry.uri, false);
			expect(items.map((i) => i.id), entry.uri).toEqual(FILE_IDS);
			expect(pinItem(items), entry.uri).toMatchObject({ id: 'pin-to-bookmarks', label: 'Pin to Bookmarks', enabled: true });
			const pinned = buildContextMenu(entry, entry.uri, true);
			expect(pinned.map((i) => i.id), entry.uri).toEqual(FILE_IDS_PINNED);
			expect(pinItem(pinned), entry.uri).toMatchObject({ id: 'unpin-from-bookmarks', label: 'Unpin from Bookmarks', enabled: true });
		}
		expect(buildContextMenu(sshDir, null, false).map((i) => i.id)).toEqual(DIR_IDS);
		expect(pinItem(buildContextMenu(sshDir, null, false))).toMatchObject({ id: 'pin-to-bookmarks', label: 'Pin to Bookmarks', enabled: true });
		expect(buildContextMenu(sshDir, null, true).map((i) => i.id)).toEqual(DIR_IDS_PINNED);
		expect(pinItem(buildContextMenu(sshDir, null, true))).toMatchObject({ id: 'unpin-from-bookmarks', label: 'Unpin from Bookmarks', enabled: true });
		// ssh の reveal / open / open-with の無効は今のまま(第3引数に左右されない)。
		expect(buildContextMenu(sshFile, sshFile.uri, true).map((i) => i.enabled)).toEqual([false, false, false, true, true, true, true, true, true]);
	});

	test('4. buildTreePaneMenu() は今の 2 つのまま(Pin が無い)', () => {
		expect(buildTreePaneMenu()).toEqual([
			{ id: 'reload-folder', label: 'Reload Folder', enabled: true },
			{ id: 'duplicate-window', label: 'Duplicate Window', enabled: true },
		]);
		expect(buildTreePaneMenu().some((i) => i.id === 'pin-to-bookmarks' || i.id === 'unpin-from-bookmarks')).toBe(false);
	});

	test("5. buildViewerMenu(false) → [reload-file, pin-to-bookmarks]。true → 2 つ目が unpin-from-bookmarks。省略= false", () => {
		expect(buildViewerMenu(false)).toHaveLength(2);
		expect(buildViewerMenu(false)).toMatchObject([
			{ id: 'reload-file', label: 'Reload File', enabled: true },
			{ id: 'pin-to-bookmarks', label: 'Pin to Bookmarks', enabled: true },
		]);
		expect(buildViewerMenu(true)).toHaveLength(2);
		expect(buildViewerMenu(true)).toMatchObject([
			{ id: 'reload-file', label: 'Reload File', enabled: true },
			{ id: 'unpin-from-bookmarks', label: 'Unpin from Bookmarks', enabled: true },
		]);
		expect(buildViewerMenu()).toEqual(buildViewerMenu(false));
		// 区切り線の印は付けない(今の規則=Duplicate Window の前だけ)。
		for (const item of [...buildViewerMenu(false), ...buildContextMenu(localFile, localFile.uri, true)]) {
			expect(item.separatorBefore ?? false, item.id).toBe(false);
		}
	});

	test("6. planContextAction('pin-to-bookmarks', file) → { command: 'pin-bookmark', uri, kind: 'file' }・フォルダ → 'folder'・symlink → 'file'・unpin → { command: 'unpin-bookmark', uri }。ssh でも null にしない", () => {
		expect(planContextAction('pin-to-bookmarks', localFile)).toEqual({ command: 'pin-bookmark', uri: localFile.uri, kind: 'file' });
		expect(planContextAction('pin-to-bookmarks', localDir)).toEqual({ command: 'pin-bookmark', uri: localDir.uri, kind: 'folder' });
		expect(planContextAction('pin-to-bookmarks', localSymlink)).toEqual({ command: 'pin-bookmark', uri: localSymlink.uri, kind: 'file' });
		expect(planContextAction('pin-to-bookmarks', sshFile)).toEqual({ command: 'pin-bookmark', uri: sshFile.uri, kind: 'file' });
		expect(planContextAction('pin-to-bookmarks', sshDir)).toEqual({ command: 'pin-bookmark', uri: sshDir.uri, kind: 'folder' });
		expect(planContextAction('pin-to-bookmarks', { ...sshFile, kind: 'symlink' })).toEqual({ command: 'pin-bookmark', uri: sshFile.uri, kind: 'file' });
		expect(planContextAction('unpin-from-bookmarks', localFile)).toEqual({ command: 'unpin-bookmark', uri: localFile.uri });
		expect(planContextAction('unpin-from-bookmarks', localDir)).toEqual({ command: 'unpin-bookmark', uri: localDir.uri });
		expect(planContextAction('unpin-from-bookmarks', sshFile)).toEqual({ command: 'unpin-bookmark', uri: sshFile.uri });
		expect(planContextAction('unpin-from-bookmarks', sshDir)).toEqual({ command: 'unpin-bookmark', uri: sshDir.uri });
		// URI は変形しない(符号化も復号もしない)。
		const encoded: ContextMenuEntry = { uri: 'file:///r/a%20b.md', name: 'a b.md', kind: 'file' };
		expect(planContextAction('pin-to-bookmarks', encoded)).toEqual({ command: 'pin-bookmark', uri: 'file:///r/a%20b.md', kind: 'file' });
	});

	test('7. ラベルは英語(CJK なし)・既存の項目の相対の並びは変わらない(Duplicate Window は末尾のまま)', () => {
		const cjk = /[　-〿぀-ヿ一-鿿＀-￯]/;
		const entries: ContextMenuEntry[] = [localFile, localDir, localSymlink, sshFile, sshDir, { ...sshFile, kind: 'symlink' }];
		for (const e of entries) {
			for (const pinned of [false, true]) {
				const items = buildContextMenu(e, e.uri, pinned);
				for (const item of items) expect(item.label).not.toMatch(cjk);
				expect(items[items.length - 1]!.id).toBe('duplicate-window');
				const copyIdx = items.findIndex((i) => i.id === 'copy-path');
				expect(items[copyIdx + 1]!.id).toBe(pinned ? 'unpin-from-bookmarks' : 'pin-to-bookmarks');
				expect(items[copyIdx + 2]!.id).toBe('duplicate-window');
			}
		}
		for (const item of [...buildViewerMenu(false), ...buildViewerMenu(true)]) expect(item.label).not.toMatch(cjk);
	});
});

// ---------------------------------------------------------------------------
// 要件#83 — Dashboard の右クリック(AC-83-23・契約 14)【(f)(n) 決定・(ae) 決定】
// ---------------------------------------------------------------------------

describe('要件#83 AC-83-23: buildBookmarkTileMenu / buildRecentFolderMenu / buildAddBookmarkMenu(契約 14)', () => {
	const TILE_IDS = ['dashboard-open', 'dashboard-open-in-new-window', 'move-up', 'move-down', 'unpin-from-bookmarks'];
	const TILE_LABELS = ['Open', 'Open in New Window', 'Move Up', 'Move Down', 'Unpin from Bookmarks'];

	test('タイル: id・ラベル・move-up と unpin-from-bookmarks の前に区切りの印', () => {
		const items = buildBookmarkTileMenu(1, 3);
		expect(items.map((i) => i.id)).toEqual(TILE_IDS);
		expect(items.map((i) => i.label)).toEqual(TILE_LABELS);
		expect(items.map((i) => i.separatorBefore ?? false)).toEqual([false, false, true, false, true]);
		expect(items.map((i) => i.enabled)).toEqual([true, true, true, true, true]);
	});

	test('タイル: index 0 → move-up 無効・末尾 → move-down 無効・1 件 → 両方無効(ほかは有効)', () => {
		expect(buildBookmarkTileMenu(0, 3).map((i) => i.enabled)).toEqual([true, true, false, true, true]);
		expect(buildBookmarkTileMenu(2, 3).map((i) => i.enabled)).toEqual([true, true, true, false, true]);
		expect(buildBookmarkTileMenu(0, 1).map((i) => i.enabled)).toEqual([true, true, false, false, true]);
		expect(buildBookmarkTileMenu(0, 3).map((i) => i.id)).toEqual(TILE_IDS);
	});

	test('Recent Folders の行: Open・Open in New Window / Pin to Bookmarks(済みなら Unpin) / Remove from Recent Folders', () => {
		const fresh = buildRecentFolderMenu(false);
		expect(fresh.map((i) => i.id)).toEqual(['dashboard-open', 'dashboard-open-in-new-window', 'pin-to-bookmarks', 'remove-from-recent-folders']);
		expect(fresh.map((i) => i.label)).toEqual(['Open', 'Open in New Window', 'Pin to Bookmarks', 'Remove from Recent Folders']);
		expect(fresh.map((i) => i.separatorBefore ?? false)).toEqual([false, false, true, true]);
		expect(fresh.every((i) => i.enabled)).toBe(true);

		const pinned = buildRecentFolderMenu(true);
		expect(pinned.map((i) => i.id)).toEqual(['dashboard-open', 'dashboard-open-in-new-window', 'unpin-from-bookmarks', 'remove-from-recent-folders']);
		expect(pinned.map((i) => i.label)).toEqual(['Open', 'Open in New Window', 'Unpin from Bookmarks', 'Remove from Recent Folders']);
		expect(pinned.map((i) => i.separatorBefore ?? false)).toEqual([false, false, true, true]);
		expect(pinned.every((i) => i.enabled)).toBe(true);
	});

	test("Add Bookmark…: add-folder-bookmark 'Add Folder…'・add-file-bookmark 'Add File…'(区切りなし・有効)", () => {
		expect(buildAddBookmarkMenu()).toHaveLength(2);
		expect(buildAddBookmarkMenu()).toMatchObject([
			{ id: 'add-folder-bookmark', label: 'Add Folder…', enabled: true },
			{ id: 'add-file-bookmark', label: 'Add File…', enabled: true },
		]);
	});

	test('Dashboard のメニューのラベルに CJK が無い・既存のメニューに区切りの印は無い(今の線の規則のまま)', () => {
		const cjk = /[　-〿぀-ヿ一-鿿＀-￯]/;
		const all = [...buildBookmarkTileMenu(0, 2), ...buildRecentFolderMenu(false), ...buildRecentFolderMenu(true), ...buildAddBookmarkMenu()];
		for (const item of all) expect(item.label).not.toMatch(cjk);
		for (const item of [...buildContextMenu(localFile, localFile.uri), ...buildContextMenu(localDir), ...buildTreePaneMenu()]) {
			expect(item.separatorBefore ?? false, item.id).toBe(false);
		}
	});
});
