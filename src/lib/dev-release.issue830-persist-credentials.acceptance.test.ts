/**
 * Issue #830 — dev-release.yml の checkout が認証情報を残すので、install・テストの手順から書き込みできるトークンが見える(unit プロジェクト)。
 *
 * `actions/checkout` は既定 `persist-credentials: true` で `github.token` を `.git/config` に書き、後の全手順に残す。ワークフローの
 * `permissions: contents: write` と合わせると `pnpm install`(postinstall)・`pnpm test`・`cargo test` の間も書き込みできるトークンが使える。
 * 冒頭のコメント「GH_TOKEN は公開の 2 手順だけ」が成り立たない。
 *
 * YAML のパーサは入れない(依存追加なし)。`dev-release.acceptance.test.ts`(AC-87-5)と同じく、テキストを読んで手順の**構造**を文字で固定する。
 *
 * ## 固定する形(直った後)
 * - `.github/workflows/dev-release.yml` の **すべての** `uses: actions/checkout@…` の段に `with: persist-credentials: false` がある
 * - job の env(`steps:` より前)にトークン(`GH_TOKEN` / `GITHUB_TOKEN`)を置かない。install・check・test・build の段(`pnpm install` / `pnpm test` /
 *   `cargo test` / `tauri build` を走らせる段)にはトークンの env が無い
 * - リモートに git で触る段(`git push` / `git ls-remote` / `git fetch` / `git pull`)は、checkout の認証が無くても通るように、その段自身の env に
 *   トークン(`GH_TOKEN` か `GITHUB_TOKEN`)を持ち、そのトークンで git の認証を立てる(`gh auth setup-git`・`x-access-token:` の URL・
 *   `http.<url>.extraheader`・`credential.helper` のどれか)。git を使わない形(`gh api` で ref を作る・`gh release list` で番号を取る)でもよい
 * - release.yml も同じ(checkout の全段に `persist-credentials: false`)。release.yml はリモートへ `git push` せず(公開リポジトリへの同期は
 *   `x-access-token` の URL を明示)、`gh` は GH_TOKEN の env で動くので、ほかの形は変わらない
 *
 * ## 判断の記録(test-writer 2026-11-28)
 * - Issue は「release.yml も同じ形か確かめる」としている。release.yml も `contents: write` のまま `pnpm install` を走らせるので同じ漏れがあり、
 *   checkout の `persist-credentials: false` だけで足りる(git push が無い)と読めたため、release.yml の checkout も固定した。範囲を広げたくなければ
 *   「release.yml」の describe を捨てる(オーケストレーターの判断)
 * - トークンの名前は `GH_TOKEN` / `GITHUB_TOKEN` の 2 つで見る(gh CLI が読む名前)。`${{ secrets.* }}` の別名は見ない
 * - 「段」は `- name:` か `- uses:` で始まる項目。段の本文は次の段の頭まで(コメントの行は除く)
 *
 * ## 修正前に赤になる理由
 * - dev-release.yml の `- uses: actions/checkout@v7` に `with:` が無い(persist-credentials が既定の true)。
 *   「Push the dev tag」の段は `git push origin …` を checkout の認証に頼っていて、トークンで認証を立てる字が無い
 * - release.yml の 3 つの checkout にも `persist-credentials: false` が無い
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function workflowCode(name: string): string {
	const file = path.join(repoRoot, '.github', 'workflows', name);
	if (!existsSync(file)) throw new Error(`${file} が無い`);
	return readFileSync(file, 'utf8')
		.split('\n')
		.filter((l) => !/^\s*#/.test(l))
		.join('\n');
}

interface Step {
	/** `- name:` の値か、名前が無ければ `- uses:` の値。 */
	label: string;
	body: string;
	at: number;
}

/** `- name:` / `- uses:` で始まる段。本文は次の段の頭まで。 */
function steps(code: string): Step[] {
	const re = /^(\s*)-\s+(name|uses):\s*(.*)$/gm;
	const marks: Array<{ label: string; at: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(code)) !== null) marks.push({ label: m[3]!.trim().replace(/^["']|["']$/g, ''), at: m.index });
	return marks.map((mk, i) => {
		const end = i + 1 < marks.length ? marks[i + 1]!.at : code.length;
		return { label: mk.label, body: code.slice(mk.at, end), at: mk.at };
	});
}

const CHECKOUT = /\buses:\s*["']?actions\/checkout@/;
const PERSIST_OFF = /persist-credentials:\s*["']?false["']?\s*$/m;
const TOKEN_ENV = /^\s*(GH_TOKEN|GITHUB_TOKEN)\s*:/m;
/** リモートに git で触る命令(ローカルだけの `git tag` は含めない)。 */
const GIT_REMOTE = /\bgit\s+(?:-c\s+\S+\s+)*(?:push|ls-remote|fetch|pull)\b/;
/** そのトークンで git の認証を立てる形。 */
const GIT_AUTH_FROM_TOKEN = /gh\s+auth\s+setup-git|x-access-token:|extraheader|credential\.helper/;
/** 公開の手順でない(依存を入れる・検査する・組む)段。 */
const BUILD_OR_TEST = /\bpnpm\s+install\b|\bpnpm\s+test\b|\bpnpm\s+check\b|\bcargo\s+test\b|\btauri\s+build\b/;

function checkoutSteps(code: string): Step[] {
	const found = steps(code).filter((s) => CHECKOUT.test(s.body));
	expect(found.length, 'actions/checkout の段がある').toBeGreaterThan(0);
	return found;
}

describe('Issue #830: dev-release.yml の checkout は認証情報を残さない', () => {
	const code = workflowCode('dev-release.yml');

	it('every actions/checkout step sets persist-credentials: false', () => {
		for (const s of checkoutSteps(code)) {
			expect(s.body, `checkout の段(${s.label}): ${s.body}`).toMatch(PERSIST_OFF);
		}
	});

	it('no token is in the job env, nor in the install / check / test / build steps', () => {
		const head = code.slice(0, code.search(/^\s*steps:\s*$/m));
		expect(head, 'job(と workflow)の env にトークンを置かない').not.toMatch(TOKEN_ENV);
		const working = steps(code).filter((s) => BUILD_OR_TEST.test(s.body));
		expect(working.length, 'install / test / build の段がある').toBeGreaterThan(0);
		for (const s of working) {
			expect(s.body, `${s.label} にトークンの env が無い`).not.toMatch(TOKEN_ENV);
		}
	});

	it('steps that reach the remote with git carry their own token and set up git auth from it', () => {
		const remote = steps(code).filter((s) => GIT_REMOTE.test(s.body));
		for (const s of remote) {
			expect(s.body, `${s.label}: リモートに git で触る段は自分の env にトークンを持つ`).toMatch(TOKEN_ENV);
			expect(s.body, `${s.label}: checkout の認証に頼らず、トークンで git の認証を立てる`).toMatch(GIT_AUTH_FROM_TOKEN);
		}
	});

	it('still pushes the tag and publishes only in token-bearing steps (the tag reaches the remote one way or another)', () => {
		const all = steps(code);
		const pushes = all.filter((s) => /\bgit\s+push\b/.test(s.body) || /gh\s+api\b[^\n]*git\/refs/.test(s.body));
		expect(pushes.length, 'タグをリモートへ送る段(git push か gh api …/git/refs)がある').toBeGreaterThan(0);
		for (const s of pushes) expect(s.body, `${s.label} はトークンを持つ`).toMatch(TOKEN_ENV);
		const releases = all.filter((s) => /\bgh\s+release\s+create\b/.test(s.body));
		expect(releases.length).toBeGreaterThan(0);
		for (const s of releases) expect(s.body, `${s.label} はトークンを持つ`).toMatch(TOKEN_ENV);
	});
});

describe('Issue #830(release.yml も同じ形): checkout は認証情報を残さない', () => {
	const code = workflowCode('release.yml');

	it('every actions/checkout step sets persist-credentials: false', () => {
		for (const s of checkoutSteps(code)) {
			expect(s.body, `checkout の段(${s.label}): ${s.body}`).toMatch(PERSIST_OFF);
		}
	});

	it('no remote git command relies on the checkout credentials', () => {
		const remote = steps(code).filter((s) => GIT_REMOTE.test(s.body));
		for (const s of remote) {
			expect(s.body, `${s.label}: トークンで git の認証を立てる`).toMatch(GIT_AUTH_FROM_TOKEN);
		}
	});
});
