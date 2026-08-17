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
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * ```ts
 * // Entry 相当(stores/window-state.svelte の Entry と同形。tree-refresh と同じく
 * // モジュール単体でテストできるよう自身が型を持つ — re-export でも可)
 * export type ContextMenuEntry = { uri: string; name: string; kind: 'file' | 'dir' | 'symlink' };
 *
 * // メニュー1項目。id は下記4値固定・label は表示文言そのもの・enabled=false が
 * // グレーアウト(項目は出すが実行不可=契約⑤)。追加フィールドは実装の自由。
 * export type ContextMenuItem = {
 *   id: 'reveal' | 'open' | 'open-with' | 'copy-path';
 *   label: string;
 *   enabled: boolean;
 * };
 *
 * // 右クリックされたアイテム → メニュー項目リスト(表示順そのまま)。
 * export function buildContextMenu(entry: ContextMenuEntry): ContextMenuItem[];
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
 *   | { command: 'pick-app'; path: string };  // 要件#21: アプリ選択ダイアログを開く計画
 * export function planContextAction(
 *   id: 'reveal' | 'open' | 'open-with' | 'copy-path',
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
 * 1. local ファイル → [reveal, open, open-with, copy-path] の4項目・この順・すべて enabled
 *    (要件#21① により open-with を「既定アプリで開く」の直後へ追加=要件側更新)。
 * 2. local フォルダ → [reveal, copy-path] の2項目(open / open-with を出さない=契約②・#21①)。
 * 3. ssh ファイル → 4項目とも出すが reveal / open / open-with は enabled=false・copy-path は true。
 * 4. ssh フォルダ → [reveal, copy-path] で reveal は enabled=false・copy-path は true。
 * 5. symlink はファイルと同じ扱い(4項目)に固定=実装裁量の確定(本テストの設計判断)。
 *    理由: フロントは symlink の指し先種別を知らないため、項目を落とすより
 *    「Finder で表示」「既定アプリで開く」を出して OS に委ねるのが安全側。
 * 6. ラベル文言は要件の表記どおり「Finder で表示」「既定アプリで開く」
 *    「アプリを選択して開く…」「パスをコピー」。
 * 7. 判別は URI スキームのみ(kind と組み合わせ、パス内容では分岐しない)。
 * 8. planContextAction('open-with', local ファイル) → { command: 'pick-app', path: OS パス }。
 *    ssh → null。planOpenWith は選択結果あり → open_path + with・キャンセル → null(要件#21)。
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
	buildContextMenu,
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
	test('local ファイル → reveal・open・open-with・copy-path の4項目・この順・すべて有効', () => {
		const items = buildContextMenu(localFile);
		expect(items.map((i) => i.id)).toEqual(['reveal', 'open', 'open-with', 'copy-path']);
		expect(items.every((i) => i.enabled)).toBe(true);
	});

	test('local フォルダ → reveal・copy-path の2項目(open は出さない)・すべて有効', () => {
		const items = buildContextMenu(localDir);
		expect(items.map((i) => i.id)).toEqual(['reveal', 'copy-path']);
		expect(items.every((i) => i.enabled)).toBe(true);
	});

	test('ラベル文言は要件の表記どおり(local ファイルの4項目)', () => {
		const labels = buildContextMenu(localFile).map((i) => i.label);
		expect(labels).toEqual([
			'Finder で表示',
			'既定アプリで開く',
			'アプリを選択して開く…',
			'パスをコピー',
		]);
	});

	test('symlink はファイルと同じ4項目に固定(実装裁量の確定=一貫性)', () => {
		const items = buildContextMenu(localSymlink);
		expect(items.map((i) => i.id)).toEqual(['reveal', 'open', 'open-with', 'copy-path']);
		expect(items.every((i) => i.enabled)).toBe(true);
	});
});

describe('buildContextMenu — ssh リモートは reveal / open をグレーアウト(契約⑤)', () => {
	test('ssh ファイル → 4項目とも出すが reveal / open / open-with は disabled・copy-path は有効', () => {
		const items = buildContextMenu(sshFile);
		expect(items.map((i) => i.id)).toEqual(['reveal', 'open', 'open-with', 'copy-path']);
		expect(items.map((i) => i.enabled)).toEqual([false, false, false, true]);
	});

	test('ssh フォルダ → reveal(disabled)+copy-path(有効)の2項目', () => {
		const items = buildContextMenu(sshDir);
		expect(items.map((i) => i.id)).toEqual(['reveal', 'copy-path']);
		expect(items.map((i) => i.enabled)).toEqual([false, true]);
	});

	test('ssh symlink もファイル同等(4項目・reveal / open / open-with disabled)=一貫性', () => {
		const items = buildContextMenu({ ...sshFile, kind: 'symlink' });
		expect(items.map((i) => i.id)).toEqual(['reveal', 'open', 'open-with', 'copy-path']);
		expect(items.map((i) => i.enabled)).toEqual([false, false, false, true]);
	});

	test('判別は URI スキーム(user なし・ポートなしの ssh URI でも disabled)', () => {
		const items = buildContextMenu({
			uri: 'ssh://host/srv/notes/plan.md',
			name: 'plan.md',
			kind: 'file',
		});
		expect(items.map((i) => i.enabled)).toEqual([false, false, false, true]);
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

	test('ラベルは「アプリを選択して開く…」・local ファイルは enabled', () => {
		const item = buildContextMenu(localFile).find((i) => i.id === 'open-with');
		expect(item).toMatchObject({ label: 'アプリを選択して開く…', enabled: true });
	});

	test('フォルダには出さない(local / ssh とも)', () => {
		expect(buildContextMenu(localDir).some((i) => i.id === 'open-with')).toBe(false);
		expect(buildContextMenu(sshDir).some((i) => i.id === 'open-with')).toBe(false);
	});

	test('ssh ファイルでは項目は出すが disabled(#19 の出し分け踏襲)', () => {
		const item = buildContextMenu(sshFile).find((i) => i.id === 'open-with');
		expect(item).toMatchObject({ label: 'アプリを選択して開く…', enabled: false });
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
