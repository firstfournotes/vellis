/**
 * backlog 139 の受け入れテスト(その1・capability のソース検査)。
 *
 * 「ウインドウの閉じるボタンが無反応」(v0.1.35 出荷済みの回帰)の根因は、
 * 要件#48 契約④で `+page.svelte` に `onCloseRequested` を登録したこと。
 * Tauri 2 の JS API は「JS リスナがあると OS の閉じる動作を止めて JS に委ね、
 * ハンドラが preventDefault しなければ自分で `destroy()` を呼ぶ」実装なので、
 * capability に `core:window:allow-destroy` が無いと **dirty かどうかに関係なく
 * 全窓が閉じない**(非 dirty =Tauri の JS が呼ぶ destroy が権限エラー・
 * dirty =確認後の `appWindow.destroy()` が権限エラー)。
 *
 * ## 判定するもの
 * - `src-tauri/capabilities/default.json` の permissions に
 *   `core:window:allow-destroy` が含まれること(閉窓の実行権限)
 * - 既存の permission(core:default・opener 3種・dialog:default・
 *   window-state:default)が消えていないこと(修正が置換でなく追加であること)
 *
 * 作法は context-menu.acceptance.test.ts の capability 検査(要件#19 AC-19-8・
 * 要件#21③)に倣う=JSON を読んで identifier を突き合わせるソース検査。
 *
 * ## 判定しないもの
 * - 実際に窓が閉じること(実機確認=人間ゲート。tauri-webdriver の E2E は
 *   周回では回さない規約)
 * - `onCloseRequested` ハンドラの分岐 → close-window.wiring.test.ts(その2)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('capability(src-tauri/capabilities/default.json)— 閉窓の destroy 権限(backlog 139・要件#48 契約④)', () => {
	const capabilityPath = resolve(__dirname, '../../src-tauri/capabilities/default.json');
	const capability = JSON.parse(readFileSync(capabilityPath, 'utf-8')) as {
		permissions: Array<string | { identifier: string; allow?: unknown[] }>;
	};
	const identifiers = capability.permissions.map((p) =>
		typeof p === 'string' ? p : p.identifier
	);

	test('core:window:allow-destroy が含まれる(JS 側の destroy() 呼び出しに要る権限)', () => {
		expect(identifiers).toContain('core:window:allow-destroy');
	});

	test('既存の permission が消えていない(追加であって置換ではない)', () => {
		expect(identifiers).toContain('core:default');
		expect(identifiers).toContain('opener:allow-open-url');
		expect(identifiers).toContain('opener:allow-reveal-item-in-dir');
		expect(identifiers).toContain('opener:allow-open-path');
		expect(identifiers).toContain('dialog:default');
		expect(identifiers).toContain('window-state:default');
	});
});
