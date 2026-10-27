/**
 * 要件#72 追補c(docs/requirements/req-72.md・Issue #673)の受け入れテスト — AC-72-追c (b)
 *
 * `scripts/release-gate-dmg.sh`(由谷が手元で使う RELEASE-CHECKLIST §6 の機械確認)の DMG のマウントと
 * 取り外しが、macOS が deprecated と警告する `hdiutil attach` / `hdiutil detach` ではなく、
 * `diskutil image attach`(読み取り専用 `--readOnly`)と `diskutil eject` で行われることを、
 * スクリプトのテキストを読んで固定する(`self-check-release-wiring.acceptance.test.ts` と同じ作法=
 * shell のパーサは入れない・依存追加なし・DMG のマウントはしない=シェルは実行しない)。
 *
 * ## 契約(追補c 2・implementer はこれに従う=本テストが前提にする形)
 * - マウント(`attach_ro`)は `diskutil image attach … --readOnly …` で行う(`--readOnly` は同じ命令行にある。
 *   `\` の行継続は 1 行として見る)。`hdiutil attach` は使わない
 * - 取り外し(`detach_mnt`)は `diskutil eject` で行う。`hdiutil detach` は使わない。外せなかったときの案内の
 *   文言にも `hdiutil` は残さない
 * - 成否にかかわらず外す仕組み(`trap cleanup EXIT` → `detach_mnt`)は今のまま
 * - `hdiutil` はコマンド行(コメントでない行)に 1 つも出てこない。先頭のコメント(背景の説明)は対象外
 *
 * AC-72-追c (a)(release.yml の自己点検のステップ)は `self-check-release-wiring.acceptance.test.ts` の
 * 追補a のケース(追補c で 3 つの確かめを書き換え、hdiutil が出てこない確かめを 1 つ足した)が受け持つ。(c)(タグの CI と同じ手順で deprecated の
 * 警告が出ないこと)は CI の実行で確かめる(人間ゲート)。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sh = readFileSync(path.join(repoRoot, 'scripts', 'release-gate-dmg.sh'), 'utf8');

/**
 * コマンド行だけを返す: `\` の行継続をつないだうえで、空行と `#` で始まるコメント行(shebang を含む)を除く。
 * 行の途中の `#` は見ない(文字列の中の `#` を誤ってコメント扱いしないため)。
 */
function commandLines(src: string): string[] {
	return src
		.replace(/\\\n/g, ' ')
		.split('\n')
		.filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
}

describe('AC-72-追c (b): scripts/release-gate-dmg.sh は hdiutil を使わず diskutil でマウント・取り外しする', () => {
	const lines = commandLines(sh);

	it('mounts the DMG with `diskutil image attach --readOnly` (read-only) instead of `hdiutil attach -readonly`', () => {
		const attachLines = lines.filter((l) => /\bdiskutil\s+image\s+attach\b/.test(l));
		expect(attachLines, 'diskutil image attach でマウントする行がある').not.toEqual([]);
		expect(
			attachLines.some((l) => /\s--readOnly(\s|$)/.test(l)),
			`diskutil image attach の命令行に --readOnly がある: ${JSON.stringify(attachLines)}`,
		).toBe(true);
		expect(sh, 'hdiutil attach は使わない').not.toMatch(/\bhdiutil\s+attach\b/);
	});

	it('ejects the mount with `diskutil eject` instead of `hdiutil detach`, still from the EXIT trap', () => {
		expect(lines.some((l) => /\bdiskutil\s+eject\b/.test(l)), 'diskutil eject で外す行がある').toBe(true);
		expect(sh, 'hdiutil detach は使わない').not.toMatch(/\bhdiutil\s+detach\b/);
		// 成否にかかわらず外す仕組みは今のまま(trap cleanup EXIT → detach_mnt)
		expect(sh).toMatch(/^\s*trap\s+cleanup\s+EXIT\s*$/m);
		expect(sh).toMatch(/^\s*cleanup\(\)\s*\{\s*\n\s*detach_mnt\b/m);
	});

	it('has no `hdiutil` left on any command line (comments excluded)', () => {
		const offenders = lines.filter((l) => /\bhdiutil\b/.test(l));
		expect(offenders, 'コマンド行(案内の文言を含む)に hdiutil が残っていない').toEqual([]);
	});

	it('keeps the attach helper storing the mount point in $mnt and checking vellis.app inside it (unchanged shape)', () => {
		const start = sh.indexOf('attach_ro() {');
		expect(start, 'attach_ro 関数がある').toBeGreaterThan(-1);
		const body = sh.slice(start, sh.indexOf('\n}', start));
		expect(body).toMatch(/\bmnt=/);
		expect(body).toContain('"$mnt/vellis.app"');
		expect(body).toMatch(/\bdiskutil\s+image\s+attach\b/);
	});
});
