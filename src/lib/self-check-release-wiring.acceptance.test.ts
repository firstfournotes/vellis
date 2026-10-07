/**
 * 要件#72 の受け入れテスト(docs/requirements/req-72.md)— AC-72-7(CI・§6 への配線)
 *
 * `.github/workflows/release.yml`(契約10)・`scripts/release-gate-dmg.sh`(契約11)・
 * `RELEASE-CHECKLIST.md` §6(契約11)のテキストを読んで判定する。YAML / shell の
 * パーサは入れない(依存追加なし)ので、手順の **構造** を文字列で固定する。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする形)
 *
 * release.yml(build:macos ジョブ):
 * - `- name: Release-channel smoke` の **後**、同じ build ジョブに自己点検のステップを足す
 *   (`- name:` に `self-check` を含める。例: `Self-check smoke (fixtures/sample.md)`)
 * - そのステップは `if: github.ref_type == 'tag'`(タグのときだけ)
 * - run の中で、生成した DMG(`src-tauri/target/release/bundle/dmg/` の `.dmg`)を
 *   `hdiutil attach -nobrowse -readonly -mountpoint <RUNNER_TEMP の下>` で読み取り専用にマウントし、
 *   その中の `vellis.app/Contents/MacOS/vellis` に `--self-check fixtures/sample.md` を実行し、
 *   JSON をログに出し(`tee` / `cat` / `echo`)、
 *   `node scripts/self-check-judge.mjs <report> --allow fixtures/self-check-allow.json` で判定する。
 *   マウントは成否にかかわらず外す(`trap` で `hdiutil detach`)(追補a・2026-10-07。
 *   `pnpm tauri build --bundles dmg` は DMG を作ったあと `bundle/macos/vellis.app` を消すので、
 *   `bundle/macos/` の .app を直接たたくと v0.5.2 のように No such file で落ちる)
 * - 逃がさない: そのステップに `continue-on-error` を書かない・run に `|| true` を書かない
 *
 * release-gate-dmg.sh:
 * - `== print-build-info` の後に、展開したアプリ `"$bin"` で `--self-check fixtures/sample.md`
 *   を実行し、`scripts/self-check-judge.mjs ... --allow fixtures/self-check-allow.json` の
 *   不合格を `fail="$fail self-check"`(語は self-check / self_check)に積む
 *
 * RELEASE-CHECKLIST.md §6(`## 6.` 〜 `## 7.`):
 * - 「DevTools でエラー無し【人】(要件72 の自己点検が入るまで)」の行を、
 *   `--self-check` の結果確認【機械】の行に置き換える(§6 に「DevTools」かつ【人】の行は残らない)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), 'utf8');

/** 追補a: 点検するのは DMG の中のアプリ(`bundle/macos/` の .app は DMG 生成後に消される)。 */
const DMG_DIR = 'bundle/dmg/';
const APP_BIN_IN_DMG = 'vellis.app/Contents/MacOS/vellis';
const JUDGE = 'scripts/self-check-judge.mjs';
const ALLOW = 'fixtures/self-check-allow.json';

/** build ジョブの steps を `- name:` 単位に切る(ジョブの範囲 = `  build:` 〜 `  e2e:`)。 */
function buildJobSteps(yml: string): Array<{ name: string; body: string }> {
	const start = yml.indexOf('\n  build:');
	const end = yml.indexOf('\n  e2e:');
	if (start < 0 || end < start) {
		throw new Error('release.yml に build ジョブと、その後ろの e2e ジョブがある前提が崩れた');
	}
	const job = yml.slice(start, end);
	const parts = job.split(/\n      - name: /).slice(1);
	return parts.map((p) => {
		const nl = p.indexOf('\n');
		return { name: p.slice(0, nl).trim().replace(/^["']|["']$/g, ''), body: p.slice(nl + 1) };
	});
}

describe('AC-72-7 (契約10): release.yml のタグ時の自己点検', () => {
	const yml = read('.github', 'workflows', 'release.yml');
	const steps = buildJobSteps(yml);
	const smokeIdx = steps.findIndex((s) => s.name === 'Release-channel smoke');
	const selfIdx = steps.findIndex((s) => /self[-_ ]?check/i.test(s.name));
	/** 自己点検のステップ(無ければ理由付きで落とす)。 */
	const selfCheckStep = () => {
		if (selfIdx < 0) {
			throw new Error(
				`release.yml の build ジョブに name に self-check を含むステップが無い(契約10)。steps=${JSON.stringify(steps.map((s) => s.name))}`,
			);
		}
		return steps[selfIdx];
	};

	it('has a self-check step in build:macos, after "Release-channel smoke"', () => {
		expect(smokeIdx, 'Release-channel smoke は既存のステップ').toBeGreaterThan(-1);
		expect(selfIdx, 'name に self-check を含むステップがある').toBeGreaterThan(-1);
		expect(selfIdx).toBeGreaterThan(smokeIdx);
	});

	it('runs only on a tag push (if: github.ref_type == \'tag\')', () => {
		const step = selfCheckStep();
		expect(step.body).toMatch(/^\s*if:\s*github\.ref_type\s*==\s*'tag'\s*$/m);
	});

	it('mounts the generated DMG read-only, checks fixtures/sample.md with the app inside it, and judges it with the allowlist (追補a)', () => {
		const step = selfCheckStep();
		// 追補a: 生成した DMG(bundle/dmg/ の .dmg)を読み取り専用でマウントする
		expect(step.body, 'DMG を hdiutil attach でマウントする').toMatch(/\bhdiutil\s+attach\b/);
		expect(step.body, '読み取り専用(-readonly)でマウントする').toContain('-readonly');
		expect(step.body, '点検の対象は bundle/dmg/ の DMG').toContain(DMG_DIR);
		// マウント先の vellis.app/Contents/MacOS/vellis に --self-check fixtures/sample.md を実行する
		expect(step.body, 'DMG の中の vellis.app/Contents/MacOS/vellis をたたく').toContain(APP_BIN_IN_DMG);
		expect(step.body).toMatch(/--self-check\s+"?(\S*\/)?fixtures\/sample\.md"?/);
		// bundle/macos/ の .app を直接たたかない(DMG 生成後に消される=v0.5.2 の失敗)
		expect(step.body).not.toContain('bundle/macos/vellis.app');
		// マウントは外す(成否にかかわらず=trap)
		expect(step.body, 'hdiutil detach で外す').toMatch(/\bhdiutil\s+detach\b/);
		expect(step.body, '成否にかかわらず外す(trap)').toMatch(/\btrap\b/);
		expect(step.body).toContain(JUDGE);
		expect(step.body).toContain(ALLOW);
		// 判定は node で動かす(Node 標準のみ)
		expect(step.body).toMatch(/node\s+(\S*\/)?scripts\/self-check-judge\.mjs/);
	});

	it('prints the JSON report into the CI log', () => {
		const step = selfCheckStep();
		expect(step.body).toMatch(/\b(tee|cat|echo)\b/);
	});

	it('does not soften the failure (no continue-on-error, no || true)', () => {
		const step = selfCheckStep();
		expect(step.body).not.toMatch(/continue-on-error/);
		expect(step.body).not.toMatch(/\|\|\s*true/);
		expect(step.body).not.toMatch(/\|\|\s*:/);
		expect(step.body).not.toMatch(/set\s+\+e/);
	});

	it('does not touch the other steps of the build job (smoke step unchanged)', () => {
		const smoke = steps[smokeIdx];
		expect(smoke.body).toContain('--print-build-info');
		expect(smoke.body).toContain('VELLIS_DEV_FEATURES_PRESENT');
	});
});

describe('AC-72-7 (契約11): scripts/release-gate-dmg.sh の自己点検', () => {
	const sh = read('scripts', 'release-gate-dmg.sh');

	it('runs --self-check fixtures/sample.md on the extracted app ("$bin") after print-build-info', () => {
		const pbi = sh.indexOf('== print-build-info');
		expect(pbi).toBeGreaterThan(-1);
		const selfCheck = sh.search(/"\$bin"\s+--self-check\s+"?[^"\s]*fixtures\/sample\.md"?/);
		expect(selfCheck, '"$bin" --self-check fixtures/sample.md を実行する').toBeGreaterThan(pbi);
	});

	it('judges the report with scripts/self-check-judge.mjs and the allowlist', () => {
		expect(sh).toContain(JUDGE);
		expect(sh).toContain(ALLOW);
	});

	it('pushes a failed judgement onto $fail (so the script ends with == NG and exit 1)', () => {
		expect(sh).toMatch(/fail="\$fail[^"\n]*self[-_]check[^"\n]*"/);
		// 既存の終端(NG 判定)は残っている
		expect(sh).toMatch(/if \[ -n "\$fail" \]; then/);
		expect(sh).toContain('echo "== NG:$fail"');
	});

	it('prints the JSON report for the human/Claude reading the output', () => {
		const block = sh.slice(sh.indexOf('--self-check'));
		expect(block).toMatch(/\becho\b|\bcat\b|\btee\b/);
	});
});

describe('AC-72-7 (契約11): RELEASE-CHECKLIST.md §6 の置き換え', () => {
	const md = read('RELEASE-CHECKLIST.md');
	const s6start = md.search(/^## 6\./m);
	const s7start = md.search(/^## 7\./m);
	const section6 = md.slice(s6start, s7start);

	it('has §6 and §7', () => {
		expect(s6start).toBeGreaterThan(-1);
		expect(s7start).toBeGreaterThan(s6start);
	});

	it('no longer leaves "DevTools でエラー無し" to a human in §6', () => {
		const lines = section6.split('\n');
		const humanDevtools = lines.filter((l) => l.includes('DevTools') && l.includes('【人】'));
		expect(humanDevtools).toEqual([]);
		expect(section6).not.toContain('要件72 の自己点検が入るまで');
	});

	it('§6 confirms the --self-check result by machine instead', () => {
		const lines = section6.split('\n');
		const machine = lines.filter((l) => /self-check/.test(l) && l.includes('【機械】'));
		expect(machine.length).toBeGreaterThanOrEqual(1);
		expect(section6).toContain('self-check-judge');
	});

	it('leaves §3 (release-smoke E2E = backlog 300) in place', () => {
		const s3 = md.slice(md.search(/^## 3\./m), md.search(/^## 4\./m));
		expect(s3).toContain('release-smoke.e2e.ts');
	});
});
