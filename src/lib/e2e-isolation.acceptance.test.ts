/**
 * backlog 335 の受け入れテスト — ssh でない E2E が利用者の本物の HOME に書き込まない
 * (unit プロジェクト・`scripts/e2e.sh` と `scripts/e2e-launch.sh` を固定する)
 *
 * ## 背景(backlog.md 335)
 * ssh でない E2E(`scripts/e2e.sh`)では、webdriver ビルドのアプリ(`src-tauri/target/debug/vellis`)が
 * 利用者の本物の HOME で動き、本番と同じ identifier `com.tetsuo.vellis` の
 * `~/Library/Application Support/com.tetsuo.vellis/recent-files.json`・`history.json` に試験のファイルと
 * フォルダを書き込む(Recent Files は上限 100 件なので利用者の項目を押し出して消す)。
 * ssh モード(`--ssh`)は `scripts/e2e-launch.sh` が `scripts/e2e-sshd.sh exec` 経由でアプリにだけ偽の
 * HOME / CFFIXED_USER_HOME を渡し、`scripts/e2e.sh` が `XDG_CONFIG_HOME` を wdio とアプリの両方に
 * export するので起きない。
 *
 * ## 契約(implementer はこれに従う)
 * 1. `scripts/e2e.sh`(ssh でないとき): 実行ごとの一時フォルダ `$xdg_dir`(`XDG_RUNTIME_DIR` にしている
 *    mktemp -d)の下にアプリ用の家 `"$xdg_dir/home"` を作り(mkdir -p)、`VELLIS_E2E_APP_HOME` として
 *    export する。あわせて `XDG_CONFIG_HOME="$VELLIS_E2E_APP_HOME/.config"` を export する(wdio にも渡る=
 *    `tests/e2e/specs/req66-find-in-folder-gate.e2e.ts` の settings.json の読み先とアプリの読み先がそろう)。
 *    これらの export は `tauri-webdriver --port …` を起動する行より前に置く。ssh モードの扱いは今のまま。
 *    後始末は今の `rm -rf "$xdg_dir"` で家ごと消える。
 * 2. `scripts/e2e-launch.sh`(ssh でないとき): 引数ありで呼ばれた場合(spec が2本目の `vellis <path>` を
 *    起こす経路)も、引数なしの場合(tauri-webdriver の起動の経路=`VELLIS_E2E_INITIAL_ROOT` を渡す)も、
 *    バイナリを `HOME` と `CFFIXED_USER_HOME` を `$VELLIS_E2E_APP_HOME` にした環境で exec する。
 *    `VELLIS_E2E_APP_HOME` が未設定か空なら、stderr に理由を出して終了コード 1 で終わり、バイナリを
 *    起動しない(本物の HOME に決して戻らない)。ssh モードの経路は今のまま。
 *
 * ## 判定の仕方
 * - `scripts/e2e-launch.sh` は**振る舞い**で確かめる: `VELLIS_E2E_BIN` に、このテストが一時フォルダに置く
 *   偽のバイナリ(自分の `$HOME`・`$CFFIXED_USER_HOME`・引数をファイルに書き出すだけのシェルスクリプト)を
 *   渡して bash で起動し、書き出しを読む。子プロセスの環境は明示的に組み立て(`VELLIS_E2E_SSH_MODE` は
 *   含めない)、`HOME` / `CFFIXED_USER_HOME` には**囮の値**を入れる。期待値に、テストを走らせる人の本物の
 *   HOME は使わない。
 * - `scripts/e2e.sh` は起動できない(アプリのビルドを伴う)ので**ソース走査**で確かめる: コメント行を除き、
 *   変数名・値の形・行の順序だけで判定する(書式には寄せない)。
 *
 * ## 修正前に赤になる理由
 * - 今の `scripts/e2e-launch.sh` は ssh でないとき `exec "$binary" …` で**環境をそのまま**渡すので、
 *   偽のバイナリが見る `HOME` は囮の値のまま(= `VELLIS_E2E_APP_HOME` ではない)。また
 *   `VELLIS_E2E_APP_HOME` が無くても終了コード 0 でバイナリを起動してしまう(書き出しのファイルができる)。
 * - 今の `scripts/e2e.sh` には `VELLIS_E2E_APP_HOME` の行がなく、`XDG_CONFIG_HOME` の export は ssh モードの
 *   `$VELLIS_E2E_SSH_HOME/.config` だけ。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const launchScript = join(repoRoot, 'scripts', 'e2e-launch.sh');
const e2eScript = join(repoRoot, 'scripts', 'e2e.sh');

// ───────────────────────── scripts/e2e-launch.sh(振る舞い)─────────────────────────

/** 偽のバイナリが書き出す内容(1行1項目)。 */
interface FakeLaunch {
	home: string | undefined;
	cffixedUserHome: string | undefined;
	args: string[];
}

interface Sandbox {
	dir: string;
	/** 偽のバイナリ(実行権限つき)。 */
	fakeBin: string;
	/** 偽のバイナリの書き出し先。起動されなければ作られない。 */
	outFile: string;
	/** 契約1で e2e.sh が作る家に相当する、テスト側の一時フォルダ。 */
	appHome: string;
	/** 本物の HOME の代わりに子プロセスへ入れる囮。これが偽のバイナリに届いたら漏れ。 */
	decoyHome: string;
	decoyCffixedHome: string;
}

let sandbox: Sandbox;

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), 'vellis-e2e-isolation-'));
	const fakeBin = join(dir, 'fake-vellis.sh');
	const outFile = join(dir, 'launch.out');
	const appHome = join(dir, 'app-home');
	const decoyHome = join(dir, 'decoy-real-home');
	const decoyCffixedHome = join(dir, 'decoy-cffixed-home');
	mkdirSync(appHome);
	mkdirSync(decoyHome);
	// 自分の環境と引数を書き出すだけ。`${VAR+set}` で「未設定」と「空」を区別する。
	writeFileSync(
		fakeBin,
		[
			'#!/bin/sh',
			'out="$VELLIS_E2E_TEST_OUT"',
			'{',
			'  if [ "${HOME+set}" = set ]; then printf "HOME=%s\\n" "$HOME"; else printf "HOME-unset\\n"; fi',
			'  if [ "${CFFIXED_USER_HOME+set}" = set ]; then printf "CFFIXED_USER_HOME=%s\\n" "$CFFIXED_USER_HOME"; else printf "CFFIXED_USER_HOME-unset\\n"; fi',
			'  for a in "$@"; do printf "ARG=%s\\n" "$a"; done',
			'} > "$out"',
			'',
		].join('\n'),
		{ mode: 0o755 },
	);
	sandbox = { dir, fakeBin, outFile, appHome, decoyHome, decoyCffixedHome };
});

afterEach(() => {
	rmSync(sandbox.dir, { recursive: true, force: true });
});

/**
 * 子プロセスの環境を明示的に組み立てる。`VELLIS_E2E_SSH_MODE` は入れない(ssh でない経路)。
 * `overrides` に `undefined` を入れた名前はその変数を**未設定**にする。
 */
function buildEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		// `#!/usr/bin/env bash` と偽のバイナリの `sh` を探すためだけに PATH を渡す。
		PATH: process.env.PATH ?? '/usr/bin:/bin',
		HOME: sandbox.decoyHome,
		CFFIXED_USER_HOME: sandbox.decoyCffixedHome,
		VELLIS_E2E_BIN: sandbox.fakeBin,
		VELLIS_E2E_TEST_OUT: sandbox.outFile,
		VELLIS_E2E_APP_HOME: sandbox.appHome,
	};
	for (const [name, value] of Object.entries(overrides)) {
		if (value === undefined) delete env[name];
		else env[name] = value;
	}
	return env;
}

function runLaunch(args: string[], env: NodeJS.ProcessEnv) {
	const result = spawnSync('bash', [launchScript, ...args], {
		env,
		cwd: sandbox.dir,
		encoding: 'utf8',
		timeout: 10_000,
	});
	if (result.error) throw result.error;
	return result;
}

function readFakeLaunch(): FakeLaunch {
	const lines = readFileSync(sandbox.outFile, 'utf8').split('\n').filter(Boolean);
	const launch: FakeLaunch = { home: undefined, cffixedUserHome: undefined, args: [] };
	for (const line of lines) {
		if (line.startsWith('HOME=')) launch.home = line.slice('HOME='.length);
		else if (line.startsWith('CFFIXED_USER_HOME=')) launch.cffixedUserHome = line.slice('CFFIXED_USER_HOME='.length);
		else if (line.startsWith('ARG=')) launch.args.push(line.slice('ARG='.length));
	}
	return launch;
}

describe('scripts/e2e-launch.sh — ssh でないときアプリにだけ一時の家を渡す(backlog 335 契約2)', () => {
	test('引数なし(tauri-webdriver の経路): VELLIS_E2E_INITIAL_ROOT を引数に、HOME と CFFIXED_USER_HOME を VELLIS_E2E_APP_HOME にして起動する', () => {
		const result = runLaunch([], buildEnv({ VELLIS_E2E_INITIAL_ROOT: '/some/root' }));

		expect(result.status, `stderr: ${result.stderr}`).toBe(0);
		expect(existsSync(sandbox.outFile), '偽のバイナリが起動されていない').toBe(true);
		const launch = readFakeLaunch();
		expect(launch.args).toEqual(['/some/root']);
		expect(launch.home).toBe(sandbox.appHome);
		expect(launch.cffixedUserHome).toBe(sandbox.appHome);
		// 囮(本物の HOME の代わり)が漏れていない
		expect(launch.home).not.toBe(sandbox.decoyHome);
		expect(launch.cffixedUserHome).not.toBe(sandbox.decoyCffixedHome);
	});

	test('引数あり(spec が2本目の vellis <path> を起こす経路): 引数はそのまま、同じ家で起動する', () => {
		const result = runLaunch(
			['/other/doc.md', '--second-flag'],
			buildEnv({ VELLIS_E2E_INITIAL_ROOT: '/some/root' }),
		);

		expect(result.status, `stderr: ${result.stderr}`).toBe(0);
		expect(existsSync(sandbox.outFile), '偽のバイナリが起動されていない').toBe(true);
		const launch = readFakeLaunch();
		expect(launch.args).toEqual(['/other/doc.md', '--second-flag']);
		expect(launch.home).toBe(sandbox.appHome);
		expect(launch.cffixedUserHome).toBe(sandbox.appHome);
		expect(launch.home).not.toBe(sandbox.decoyHome);
	});

	test.each([
		{ label: '未設定・引数なし', appHome: undefined, args: [] as string[] },
		{ label: '空・引数なし', appHome: '', args: [] as string[] },
		{ label: '未設定・引数あり', appHome: undefined, args: ['/other/doc.md'] },
		{ label: '空・引数あり', appHome: '', args: ['/other/doc.md'] },
	])('VELLIS_E2E_APP_HOME が$label: 終了コード 1・stderr に理由・バイナリを起動しない', ({ appHome, args }) => {
		const result = runLaunch(
			args,
			buildEnv({ VELLIS_E2E_INITIAL_ROOT: '/some/root', VELLIS_E2E_APP_HOME: appHome }),
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/VELLIS_E2E_APP_HOME/);
		// 本物の HOME(ここでは囮)に戻ってバイナリを起動してはいけない=書き出しのファイルができない
		expect(existsSync(sandbox.outFile), '偽のバイナリが起動された(本物の HOME に戻っている)').toBe(false);
	});
});

// ───────────────────────── scripts/e2e.sh(ソース走査)─────────────────────────

/** 1始まりの行番号つきの、コメント行を空にしたソース。 */
interface SourceLine {
	n: number;
	text: string;
}

function readScriptWithoutComments(path: string): SourceLine[] {
	return readFileSync(path, 'utf8')
		.split('\n')
		.map((raw, i) => ({ n: i + 1, text: /^\s*#/.test(raw) ? '' : raw }));
}

function findLine(lines: SourceLine[], pattern: RegExp): SourceLine | undefined {
	return lines.find((l) => pattern.test(l.text));
}

/** シェルの変数参照 `$name` / `${name}`(前後に引用符があってもよい)。 */
function ref(name: string): string {
	return `\\$(?:\\{${name}\\}|${name}\\b)`;
}

describe('scripts/e2e.sh — ssh でない経路でアプリの家を $xdg_dir の下に用意する(backlog 335 契約1)', () => {
	const lines = readScriptWithoutComments(e2eScript);

	// 実行ごとの一時フォルダ(今の XDG_RUNTIME_DIR)。家はこの下に作るので、まずこの行を見つける。
	const xdgDirLine = findLine(lines, /(^|\s)xdg_dir=.*mktemp/);
	// tauri-webdriver の起動行(export はこれより前でないとアプリに届かない)。
	const proxyLine = findLine(lines, /tauri-webdriver\s+.*--port\b/);

	// VELLIS_E2E_APP_HOME の代入(`export VAR=…` でも `VAR=…` でもよい)。値は `$xdg_dir/…` の形。
	const appHomeAssign = findLine(lines, new RegExp(`(^|\\s|export\\s+)VELLIS_E2E_APP_HOME=`));
	const appHomeExport = findLine(lines, /(^|\s)export\s+VELLIS_E2E_APP_HOME\b/);
	// XDG_CONFIG_HOME の export(値は `$VELLIS_E2E_APP_HOME/.config`)。ssh モードの
	// `$VELLIS_E2E_SSH_HOME/.config` とは別の行。
	const xdgConfigExport = findLine(
		lines,
		new RegExp(`(^|\\s)export\\s+XDG_CONFIG_HOME=["']?${ref('VELLIS_E2E_APP_HOME')}/\\.config["']?\\s*$`),
	);

	test('前提: xdg_dir の mktemp と tauri-webdriver --port の行がある(既存の構造)', () => {
		expect(xdgDirLine, 'xdg_dir=$(mktemp -d …) の行').toBeDefined();
		expect(proxyLine, 'tauri-webdriver --port … の行').toBeDefined();
	});

	test('VELLIS_E2E_APP_HOME が $xdg_dir の下のパスとして代入され、export される', () => {
		expect(appHomeAssign, 'VELLIS_E2E_APP_HOME=… の行がない').toBeDefined();
		const value = appHomeAssign!.text.replace(/^.*VELLIS_E2E_APP_HOME=/, '');
		expect(value, `値が $xdg_dir の下のパスではない: ${value}`).toMatch(
			new RegExp(`^["']?${ref('xdg_dir')}/[^\\s"']+["']?\\s*(#.*)?$`),
		);
		expect(appHomeExport, 'export VELLIS_E2E_APP_HOME の行がない').toBeDefined();
		// xdg_dir が決まったあとで代入している
		expect(appHomeAssign!.n).toBeGreaterThan(xdgDirLine!.n);
	});

	test('アプリの家を mkdir -p で作る', () => {
		const mkdir = findLine(
			lines,
			new RegExp(`(^|\\s)mkdir\\s+-p\\s+.*(${ref('VELLIS_E2E_APP_HOME')}|${ref('xdg_dir')}/)`),
		);
		expect(mkdir, 'mkdir -p "$VELLIS_E2E_APP_HOME"(または "$xdg_dir/…")の行がない').toBeDefined();
		expect(mkdir!.n).toBeGreaterThan(xdgDirLine!.n);
		expect(mkdir!.n).toBeLessThan(proxyLine!.n);
	});

	test('XDG_CONFIG_HOME が $VELLIS_E2E_APP_HOME/.config として export される(wdio とアプリで同じ読み先)', () => {
		expect(xdgConfigExport, 'export XDG_CONFIG_HOME="$VELLIS_E2E_APP_HOME/.config" の行がない').toBeDefined();
		expect(xdgConfigExport!.n).toBeGreaterThan(appHomeAssign!.n);
	});

	test('これらの export は tauri-webdriver を起動する行より前にある', () => {
		expect(appHomeAssign!.n).toBeLessThan(proxyLine!.n);
		expect(appHomeExport!.n).toBeLessThan(proxyLine!.n);
		expect(xdgConfigExport!.n).toBeLessThan(proxyLine!.n);
	});

	test('ssh モードの扱いは今のまま(VELLIS_E2E_SSH_MODE=1 と $VELLIS_E2E_SSH_HOME/.config の export が残る)', () => {
		expect(findLine(lines, /(^|\s)export\s+VELLIS_E2E_SSH_MODE=1\b/)).toBeDefined();
		expect(
			findLine(lines, new RegExp(`(^|\\s)export\\s+XDG_CONFIG_HOME=["']?${ref('VELLIS_E2E_SSH_HOME')}/\\.config`)),
		).toBeDefined();
	});

	test('後始末: 家を含む $xdg_dir を rm -rf で消す', () => {
		expect(findLine(lines, new RegExp(`(^|\\s)rm\\s+-rf\\s+["']?${ref('xdg_dir')}["']?`))).toBeDefined();
	});
});
