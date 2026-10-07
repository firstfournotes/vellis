/**
 * 要件#72 の受け入れテスト(docs/requirements/req-72.md)— AC-72-6(判定スクリプト・契約9)
 *
 * `scripts/self-check-judge.mjs <report.json> [--allow <allowlist.json>]` を
 * child_process で node から起動し、終了コードと理由の出力を判定する。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする形)
 *
 * - Node 標準モジュールのみ(依存追加なし)。`node scripts/self-check-judge.mjs` で動く
 * - 終了コード: 合格 0 / 不合格 1 / 報告が読めない 2
 *     - 2 = report.json が無い・JSON でない・`self_check` が 1 でない
 * - 合格 = `status === "done"` かつ `csp` `script_errors` `rejections` `dialogs` が空 かつ
 *   `resource_errors` と `console_errors` の全要素が許可リストに当たる かつ
 *   `asset_images.failed <= max_failed` かつ `asset_images.loaded >= min_loaded`。
 *   `--allow` 無しは「何も許可しない」(max_failed = 0・min_loaded = 0)
 * - 不合格の理由は **標準出力に 1 件 1 行**(不合格のときの標準出力はその理由行だけ。
 *   理由の行には問題の区分=契約6 のキー名(status / csp / resource_errors / console_errors /
 *   script_errors / rejections / dialogs / asset_images)を含める)。
 *   2 のときは理由を標準エラーに出す。合格のときの出力は問わない
 * - 許可リスト `fixtures/self-check-allow.json` の形(本テストが同梱するフィクスチャ):
 *     {
 *       "self_check_allow": 1,
 *       "resource_errors": [ { "tag": "img", "resolved_suffix": "/fixtures/x" } ],
 *       "console_errors":  [ { "contains": "/fixtures/x" } ],
 *       "asset_images":    { "max_failed": 1, "min_loaded": 1 }
 *     }
 *   resource_errors の 1 件は、許可要素の **書かれた項目がすべて一致** したら許可
 *   (`tag` = 等しい・`attr` = 等しい・`resolved` = 等しい・`resolved_suffix` = 末尾一致)。
 *   console_errors の 1 件は、どれかの `contains` を部分文字列として含めば許可。
 *   `_` で始まるキー(`_comment` / `_why`)は注記なので無視する
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JUDGE = path.join(repoRoot, 'scripts', 'self-check-judge.mjs');
const ALLOW = path.join(repoRoot, 'fixtures', 'self-check-allow.json');

const SAMPLE_DIR = '/Users/someone/repo/fixtures';
const X_URL = `vellis-asset://local${SAMPLE_DIR}/x`;

interface Report {
	self_check: number;
	version: string;
	channel: string;
	file: string;
	status: 'done' | 'timeout';
	elapsed_ms: number;
	csp: Array<{ directive: string; blocked_uri: string; source_file: string; line: number }>;
	resource_errors: Array<{ tag: string; attr: string; resolved: string }>;
	console_errors: string[];
	script_errors: string[];
	rejections: string[];
	dialogs: Array<{ kind: string; message: string }>;
	asset_images: { loaded: number; failed: number };
}

/** sample.md を release ビルドで点検したときの、想定内(§13 の x だけ)の報告。 */
function sampleReport(over: Partial<Report> = {}): Report {
	return {
		self_check: 1,
		version: '0.5.1',
		channel: 'release',
		file: `${SAMPLE_DIR}/sample.md`,
		status: 'done',
		elapsed_ms: 2345,
		csp: [],
		resource_errors: [{ tag: 'img', attr: X_URL, resolved: X_URL }],
		console_errors: [],
		script_errors: [],
		rejections: [],
		dialogs: [],
		asset_images: { loaded: 1, failed: 1 },
		...over,
	};
}

/** 何も起きなかった報告(許可リスト無しで合格するはずのもの)。 */
function cleanReport(over: Partial<Report> = {}): Report {
	return sampleReport({
		resource_errors: [],
		asset_images: { loaded: 2, failed: 0 },
		...over,
	});
}

let counter = 0;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'vellis-self-check-judge-'));
function writeReport(content: string | Report): string {
	const p = path.join(tmp, `report-${counter++}.json`);
	writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
	return p;
}

function judge(reportPath: string, allow?: string) {
	if (!existsSync(JUDGE)) {
		throw new Error(`判定スクリプトが無い: ${JUDGE}(要件72 契約9)`);
	}
	const args = [JUDGE, reportPath];
	if (allow) args.push('--allow', allow);
	const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: repoRoot });
	if (r.error) throw r.error;
	return {
		code: r.status,
		stdout: r.stdout ?? '',
		stderr: r.stderr ?? '',
		lines: (r.stdout ?? '').split('\n').filter((l) => l.trim().length > 0),
	};
}

describe('AC-72-6: scripts/self-check-judge.mjs(契約9)', () => {
	it('allowlist fixture exists and names the §13 case', () => {
		expect(existsSync(ALLOW)).toBe(true);
	});

	it('passes the sample.md report (only the §13 <img src="x">) with fixtures/self-check-allow.json → exit 0', () => {
		const r = judge(writeReport(sampleReport()), ALLOW);
		expect(r.code, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
	});

	it('passes when console.error also mentions the §13 x URL (allowed by contains) → exit 0', () => {
		const r = judge(
			writeReport(
				sampleReport({
					console_errors: [`Failed to load resource: the server responded with a status of 404 (${X_URL})`],
				}),
			),
			ALLOW,
		);
		expect(r.code, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
	});

	it('passes a clean report without --allow → exit 0', () => {
		const r = judge(writeReport(cleanReport()));
		expect(r.code, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
	});

	it('fails the sample.md report without --allow (the x failure is not allowed) → exit 1, one reason line', () => {
		const r = judge(writeReport(sampleReport()));
		expect(r.code).toBe(1);
		expect(r.lines.length).toBeGreaterThanOrEqual(1);
		expect(r.stdout).toMatch(/resource_errors|asset_images/);
	});

	it('fails on a CSP violation → exit 1, reason names csp', () => {
		const r = judge(
			writeReport(
				sampleReport({
					csp: [
						{
							directive: 'img-src',
							blocked_uri: 'https://example.com/a.png',
							source_file: '',
							line: 0,
						},
					],
				}),
			),
			ALLOW,
		);
		expect(r.code).toBe(1);
		expect(r.lines).toHaveLength(1);
		expect(r.lines[0]).toContain('csp');
	});

	it('fails on a resource error outside the allowlist → exit 1, reason names resource_errors', () => {
		const other = `vellis-asset://local${SAMPLE_DIR}/images/missing.png`;
		const r = judge(
			writeReport(
				sampleReport({
					resource_errors: [
						{ tag: 'img', attr: X_URL, resolved: X_URL },
						{ tag: 'img', attr: other, resolved: other },
					],
					asset_images: { loaded: 1, failed: 1 },
				}),
			),
			ALLOW,
		);
		expect(r.code).toBe(1);
		expect(r.lines).toHaveLength(1);
		expect(r.lines[0]).toContain('resource_errors');
		expect(r.lines[0]).toContain('missing.png');
	});

	it('fails when the allowed suffix matches but the tag does not (all written fields must match) → exit 1', () => {
		const r = judge(
			writeReport(
				sampleReport({
					resource_errors: [{ tag: 'script', attr: X_URL, resolved: X_URL }],
				}),
			),
			ALLOW,
		);
		expect(r.code).toBe(1);
		expect(r.stdout).toContain('resource_errors');
	});

	it('fails on a console.error outside the allowlist → exit 1, reason names console_errors', () => {
		const r = judge(
			writeReport(sampleReport({ console_errors: ['Something else went wrong'] })),
			ALLOW,
		);
		expect(r.code).toBe(1);
		expect(r.lines).toHaveLength(1);
		expect(r.lines[0]).toContain('console_errors');
	});

	it('fails on a dialog → exit 1, reason names dialogs', () => {
		const r = judge(
			writeReport(sampleReport({ dialogs: [{ kind: 'alert', message: 'XSS via onerror' }] })),
			ALLOW,
		);
		expect(r.code).toBe(1);
		expect(r.lines).toHaveLength(1);
		expect(r.lines[0]).toContain('dialogs');
	});

	it('fails on a script error → exit 1, reason names script_errors', () => {
		const r = judge(writeReport(sampleReport({ script_errors: ['Uncaught TypeError: boom'] })), ALLOW);
		expect(r.code).toBe(1);
		expect(r.lines).toHaveLength(1);
		expect(r.lines[0]).toContain('script_errors');
	});

	it('fails on an unhandled rejection → exit 1, reason names rejections', () => {
		const r = judge(writeReport(sampleReport({ rejections: ['Error: nope'] })), ALLOW);
		expect(r.code).toBe(1);
		expect(r.lines).toHaveLength(1);
		expect(r.lines[0]).toContain('rejections');
	});

	it('fails on status timeout → exit 1, reason names status', () => {
		const r = judge(writeReport(sampleReport({ status: 'timeout', elapsed_ms: 30000 })), ALLOW);
		expect(r.code).toBe(1);
		expect(r.lines).toHaveLength(1);
		expect(r.lines[0]).toMatch(/status|timeout/);
	});

	it('fails when logo.png did not load (asset_images.loaded < min_loaded) → exit 1, reason names asset_images', () => {
		const r = judge(
			writeReport(sampleReport({ asset_images: { loaded: 0, failed: 1 } })),
			ALLOW,
		);
		expect(r.code).toBe(1);
		expect(r.lines).toHaveLength(1);
		expect(r.lines[0]).toContain('asset_images');
	});

	it('fails when more images failed than allowed (asset_images.failed > max_failed) → exit 1', () => {
		const r = judge(
			writeReport(sampleReport({ asset_images: { loaded: 1, failed: 2 } })),
			ALLOW,
		);
		expect(r.code).toBe(1);
		expect(r.lines).toHaveLength(1);
		expect(r.lines[0]).toContain('asset_images');
	});

	it('fails a clean report without --allow when any image failed (nothing is allowed) → exit 1', () => {
		const r = judge(writeReport(cleanReport({ asset_images: { loaded: 1, failed: 1 } })));
		expect(r.code).toBe(1);
		expect(r.stdout).toContain('asset_images');
	});

	it('prints one line per reason when several things are wrong', () => {
		const r = judge(
			writeReport(
				sampleReport({
					csp: [{ directive: 'img-src', blocked_uri: 'https://x', source_file: '', line: 0 }],
					dialogs: [{ kind: 'prompt', message: 'p' }],
					status: 'timeout',
				}),
			),
			ALLOW,
		);
		expect(r.code).toBe(1);
		expect(r.lines.length).toBeGreaterThanOrEqual(3);
		expect(r.lines.some((l) => l.includes('csp'))).toBe(true);
		expect(r.lines.some((l) => l.includes('dialogs'))).toBe(true);
		expect(r.lines.some((l) => /status|timeout/.test(l))).toBe(true);
	});

	it('exits 2 when the report is not JSON', () => {
		const r = judge(writeReport('vellis --self-check: not a report\n'), ALLOW);
		expect(r.code).toBe(2);
		expect(r.stderr.trim().length).toBeGreaterThan(0);
	});

	it('exits 2 when self_check is not 1', () => {
		const r = judge(writeReport({ ...sampleReport(), self_check: 2 }), ALLOW);
		expect(r.code).toBe(2);
		expect(r.stderr.trim().length).toBeGreaterThan(0);

		const missing = judge(writeReport(JSON.stringify({ version: '0.5.1', status: 'done' })), ALLOW);
		expect(missing.code).toBe(2);
	});

	it('exits 2 when the report file does not exist', () => {
		const r = judge(path.join(tmp, 'does-not-exist.json'), ALLOW);
		expect(r.code).toBe(2);
		expect(r.stderr.trim().length).toBeGreaterThan(0);
	});

	it('uses only Node built-ins (no package imports)', () => {
		const src = readFileSync(JUDGE, 'utf8');
		const specifiers = [...src.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)].map(
			(m) => m[1],
		);
		expect(specifiers.length).toBeGreaterThan(0);
		for (const s of specifiers) {
			expect(s, `依存追加なし: ${s}`).toMatch(/^node:|^(fs|path|process|url|os|util)$/);
		}
	});
});
