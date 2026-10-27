/**
 * 要件#72 追補b の受け入れテスト(docs/requirements/req-72.md「## 追補b」・backlog 340)
 * — AC-72-追b (a)(b)(テストの一時フォルダの後始末をソース走査で固定する・unit プロジェクト)
 *
 * ## 背景(backlog.md 340)
 * `src/lib/self-check-judge.acceptance.test.ts`(AC-72-6)がファイルの頭で `mkdtempSync` した
 * `$TMPDIR/vellis-self-check-judge-*` を消さないので、vitest を回すたびに1つ残っていた。
 *
 * ## 契約(追補b)
 * 1. 後始末: `self-check-judge.acceptance.test.ts` は、作った一時フォルダをファイルのテストがすべて
 *    終わったあと(`afterAll`)に中身ごと消す(`rmSync(tmp, { recursive: true, force: true })`)
 * 2. 再発の防止: `src/` の下のテスト(`*.test.ts`)で `mkdtemp` / `mkdtempSync` を呼ぶファイルは、
 *    同じファイルの中で `rmSync` か `rm`(`node:fs` / `node:fs/promises`)を呼ぶ
 *
 * ## 判定の仕方(ソース走査)
 * - (a) `self-check-judge.acceptance.test.ts` のソースに `afterAll(` があり、そのコールバックの中で
 *   一時フォルダの変数 `tmp` を `rmSync(tmp` で消している
 * - (b) `src/` の下の `*.test.ts`(wiring を含む)を再帰で集め、`mkdtemp` を含むファイルはすべて
 *   `rmSync(` か `rm(` を含む。走査対象が 1 件以上あること・本ファイル自身は除外する
 *   (本ファイルは判定のために `mkdtemp` という文字列を持つので、自分に当たらないようにする)
 * - (c) 実測(フルスイート前後で `$TMPDIR/vellis-self-check-judge-*` が増えない)は test-runner の仕事
 *
 * ## 修正前に赤になる理由
 * - 追補b の前の `self-check-judge.acceptance.test.ts` には `afterAll` も `rmSync` も無い
 *   ((a) が落ち、(b) は同ファイルを違反として挙げる)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), '..', '..');
const srcRoot = join(repoRoot, 'src');
const judgeTest = join(srcRoot, 'lib', 'self-check-judge.acceptance.test.ts');

/** `dir` の下の `*.test.ts` を再帰で集める(絶対パス)。 */
function collectTestFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue;
			out.push(...collectTestFiles(full));
		} else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
			out.push(full);
		}
	}
	return out;
}

describe('AC-72-追b: テストの一時フォルダの後始末(契約1・2)', () => {
	it('(a) self-check-judge.acceptance.test.ts has afterAll that rmSync-s the tmp folder', () => {
		const src = readFileSync(judgeTest, 'utf8');
		const afterAllCalls = [...src.matchAll(/afterAll\s*\(/g)];
		expect(afterAllCalls.length, 'afterAll が無い(契約1)').toBeGreaterThanOrEqual(1);

		// afterAll( から始まる範囲のどれかに `rmSync(tmp` があること(次の afterAll/describe/it/function までを一区切りに見る)
		const cleansInAfterAll = afterAllCalls.some((m) => {
			const start = m.index ?? 0;
			const rest = src.slice(start + m[0].length);
			const nextTopLevel = rest.search(/\n(?:describe|it|test|function|const|let)\b/);
			const body = nextTopLevel === -1 ? rest : rest.slice(0, nextTopLevel);
			return /rmSync\s*\(\s*tmp\b/.test(body);
		});
		expect(cleansInAfterAll, 'afterAll の中で rmSync(tmp, …) を呼んでいない(契約1)').toBe(true);
	});

	it('(b) every src/**/*.test.ts that calls mkdtemp also calls rmSync( or rm(', () => {
		const files = collectTestFiles(srcRoot).filter((f) => f !== thisFile);
		expect(files.length, 'src/ の下に *.test.ts が見つからない').toBeGreaterThan(0);
		expect(files, '走査対象に self-check-judge.acceptance.test.ts が含まれる').toContain(judgeTest);

		const usingMkdtemp = files.filter((f) => readFileSync(f, 'utf8').includes('mkdtemp'));
		expect(usingMkdtemp.length, 'mkdtemp を使うテストが 1 件も無い(走査が空回りしている)').toBeGreaterThan(0);

		const violators = usingMkdtemp.filter((f) => {
			const src = readFileSync(f, 'utf8');
			return !/\brmSync\s*\(/.test(src) && !/\brm\s*\(/.test(src);
		});
		expect(
			violators.map((f) => relative(repoRoot, f)),
			`mkdtemp を呼ぶのに rmSync( / rm( で消していないテスト(契約2): ${violators
				.map((f) => relative(repoRoot, f))
				.join(', ')}`,
		).toEqual([]);
	});
});
