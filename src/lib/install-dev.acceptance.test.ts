/**
 * 要件#87 の受け入れテスト(docs/requirements/req-87.md)— AC-87-6 `scripts/install-dev.sh`
 *
 * 「`scripts/install-dev.sh [開発名]` が、開発用のリポジトリの最新の開発版(開発名を渡したらその開発名の最新)を
 *  `gh release download` で取り、署名と公証を確かめ、動いている Vellis を閉じて /Applications の Vellis を置き換える。
 *  入れる前と後の版の名前を出す。`--dry-run` で、取って確かめるところまで(置き換えない)」(契約6)
 *
 * ## 判定の仕方
 * - `bash -n` で構文を見る(実行の権限も見る=`scripts/install-dev.sh` で起動する)。
 * - `--dry-run` を**振る舞い**で確かめる: 一時フォルダに偽の命令を置き、PATH の先頭にして bash で起動する。
 *   - 偽の `gh`: `release list` / `release view` / `release download` の答えを、下の RELEASES に固定する
 *     (並びは本物の gh と同じ=作った日時の新しい順)。`--json`・`--jq`(本物の jq に渡す)・`--limit`・`--order`・
 *     `--exclude-pre-releases`・`--pattern`・`--dir`・`--output`・`--clobber` を解する。リポジトリの指定が無いとき
 *     (`--repo` / `-R` / `GH_REPO` のどれも無い=本物の gh は git の外で失敗する)と、開発用のリポジトリ以外を
 *     指したとき(本物は 404)は失敗する。`gh api` は偽にしていない(失敗する)。
 *     DMG の中身は、中のアプリが `--print-build-info` で出す JSON の文字列。
 *   - 偽の `diskutil image attach` / `hdiutil attach`: DMG の中身から `vellis.app`(`--print-build-info` に答える偽の
 *     実行ファイル)を一時フォルダの `…/Volumes/vellis` (か `--mountPoint` / `-mountpoint` の先)に作り、本物と同じ形
 *     (タブ区切りの 1 行=ノード・種別・マウント先。`-plist` なら plist)で答える。eject / detach は何もしない。
 *   - 偽の `codesign` / `spctl` / `xcrun`: 呼ばれた引数を記録し、`FAKE_CODESIGN_EXIT` / `FAKE_SPCTL_EXIT` /
 *     `FAKE_STAPLER_EXIT`(既定 0)で終わる。
 *   - 偽の `osascript` / `pkill` / `killall` / `open` / `sudo` / `pgrep`: 記録だけ(本物の Vellis を閉じない)。
 *   - `rm` / `cp` / `mv` / `ditto` / `rsync` / `ln` は本物へ渡す見張り: 引数に `/Applications` があれば記録して断る
 *     (VELLIS_INSTALL_DIR を見ない作りでも、本物の /Applications には届かない)。
 *   - 入れる先は `VELLIS_INSTALL_DIR` の一時フォルダ。そこに「入れる前」のアプリ(`vellis.app`・`--print-build-info`
 *     に答える偽の実行ファイル)を置き、走らせた前後で中身・時刻が変わらないことを見る。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする形)
 * - 置き場 `scripts/install-dev.sh`(実行の権限あり・`#!/usr/bin/env bash`。macOS の /bin/bash 3.2 で動く)。
 * - 呼び方 `scripts/install-dev.sh [--dry-run] [開発名]`(`--dry-run` は開発名より前)。
 * - 開発用のリポジトリ `firstfournotes/product-vellis` を、`gh` に `--repo` / `-R` か環境変数 `GH_REPO` で**明示**する
 *   (どのフォルダから走らせても同じ所を見る)。配布用のリポジトリ(firstfournotes/vellis)は見ない。
 * - 一覧は `gh release list`(か `gh release view`)、取得は `gh release download <タグ>` で行う(`gh api` は使わない)。
 * - 開発版 = タグが `dev/<開発名>/<n>` のプレリリース。開発名なし → 開発版の中でいちばん新しいもの
 *   (公開の版 `v x.y.z` は、それより新しくても選ばない)。開発名あり → その開発名(完全一致)の中でいちばん新しいもの
 *   (n の大小は数で比べる=10 は 9 より新しい。`req-7` は `req-74` に一致しない)。無ければ 0 以外で終わり、何も取らない。
 * - 署名と公証の確かめ: `codesign`(署名)と `spctl`(公証=Gatekeeper の評価)を、取った DMG かその中の `vellis.app` に
 *   対して呼ぶ。どちらかが 0 以外で終わったら、0 以外で終わる(先へ進まない)。判定は終了コードで行う(出力の字に頼らない)。
 * - 入れる先は `VELLIS_INSTALL_DIR`(既定 `/Applications`)の `vellis.app`。
 * - 入れる前の版の名前 = `"$VELLIS_INSTALL_DIR/vellis.app/Contents/MacOS/vellis" --print-build-info` の `buildName`
 *   (空か欄が無ければ `version` の x.y.z)。入っていなければ「無い」旨を出して先へ進む(0 で終わる)。
 *   入れた後(dry-run では入れるはずの)版の名前 = その開発版の名前(GitHub Release の名前=中のアプリの buildName)。
 *   両方を出力(stdout か stderr)に出す。
 * - `--dry-run`: 取って確かめるところまで。`VELLIS_INSTALL_DIR` の中に何も書かない・消さない。Vellis を閉じない
 *   (`osascript` / `pkill` / `killall` を呼ばない)・`sudo` / `open` を呼ばない。確かめが通れば 0 で終わる。
 *
 * ## 今の作りで赤になる理由
 * - `scripts/install-dev.sh` が無い(`bash -n` も起動も失敗する)。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const script = join(repoRoot, 'scripts', 'install-dev.sh');

const DEV_REPO = 'firstfournotes/product-vellis';
const PUBLIC_REPO = 'firstfournotes/vellis';
/** 1 回の起動の上限(偽の命令は node と bash なので数秒で済む)。 */
const RUN_LIMIT_MS = 60_000;

interface BuildInfoJson {
	version: string;
	buildNumber: string;
	buildTime: string;
	buildName?: string;
	channel: string;
	flags: Record<string, boolean>;
}

interface FakeRelease {
	tagName: string;
	name: string;
	isPrerelease: boolean;
	isDraft: boolean;
	isLatest: boolean;
	isImmutable: boolean;
	createdAt: string;
	publishedAt: string;
	asset: string;
	/** DMG の中のアプリが `--print-build-info` で出す JSON。 */
	buildInfo: BuildInfoJson;
}

function devRelease(tag: string, name: string, createdAt: string, buildTime: string, run: number): FakeRelease {
	return {
		tagName: tag,
		name,
		isPrerelease: true,
		isDraft: false,
		isLatest: false,
		isImmutable: false,
		createdAt,
		publishedAt: createdAt,
		asset: 'vellis_0.6.0_aarch64.dmg',
		buildInfo: {
			version: '0.6.0',
			buildNumber: `${run} 1a2b3c4`,
			buildTime,
			buildName: name,
			channel: 'preview',
			flags: {},
		},
	};
}

function publicRelease(version: string, createdAt: string, isLatest: boolean): FakeRelease {
	return {
		tagName: `v${version}`,
		name: `Vellis v${version}`,
		isPrerelease: false,
		isDraft: false,
		isLatest,
		isImmutable: false,
		createdAt,
		publishedAt: createdAt,
		asset: `vellis_${version}_aarch64.dmg`,
		buildInfo: {
			version,
			buildNumber: '19000000000 9f8e7d6',
			buildTime: '2026-11-21 12:00 JST',
			buildName: '',
			channel: 'release',
			flags: {},
		},
	};
}

/** 開発用のリポジトリのリリース(作った日時の新しい順=gh の既定の並び)。 */
const RELEASES: FakeRelease[] = [
	// 公開の版がいちばん新しい(開発版の選び方で拾ってはいけない)
	publicRelease('0.6.1', '2026-11-21T03:00:00Z', true),
	devRelease('dev/req-80/2', 'dev-req-80 #2（2026-11-21 11:00 JST）', '2026-11-21T02:00:00Z', '2026-11-21 11:00 JST', 20002),
	devRelease('dev/req-74/10', 'dev-req-74 #10（2026-11-21 10:00 JST）', '2026-11-21T01:00:00Z', '2026-11-21 10:00 JST', 20010),
	devRelease('dev/req-74/9', 'dev-req-74 #9（2026-11-20 18:00 JST）', '2026-11-20T09:00:00Z', '2026-11-20 18:00 JST', 20009),
	devRelease('dev/req-80/1', 'dev-req-80 #1（2026-11-19 12:00 JST）', '2026-11-19T03:00:00Z', '2026-11-19 12:00 JST', 20001),
	devRelease('dev/req-7/5', 'dev-req-7 #5（2026-11-18 08:00 JST）', '2026-11-17T23:00:00Z', '2026-11-18 08:00 JST', 20005),
	publicRelease('0.6.0', '2026-11-10T00:00:00Z', false),
];

const byTag = (tag: string) => {
	const r = RELEASES.find((x) => x.tagName === tag);
	if (!r) throw new Error(`fixture: no release ${tag}`);
	return r;
};

/** 入れる前に入っている開発版(dev-req-74 #9)。 */
const INSTALLED_PREVIEW: BuildInfoJson = byTag('dev/req-74/9').buildInfo;
const INSTALLED_PREVIEW_NAME = 'dev-req-74 #9（2026-11-20 18:00 JST）';
/** 入れる前に入っている公開の版(buildName の欄が無い=要件87 より前のビルド)。 */
const INSTALLED_OLD_RELEASE: BuildInfoJson = {
	version: '0.5.2',
	buildNumber: '18000000000 0a0b0c0',
	buildTime: '2026-10-05 10:00 JST',
	channel: 'release',
	flags: {},
};

// ───────────────────────── 偽の命令 ─────────────────────────

interface Sandbox {
	dir: string;
	bin: string;
	apps: string;
	home: string;
	tmp: string;
	ghLog: string;
	callLog: string;
	applicationsLog: string;
	appLog: string;
}

function write(path: string, body: string, mode = 0o644) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
	chmodSync(path, mode);
}

/** `--print-build-info` に `Contents/Resources/build-info.json` で答える偽のアプリ実行ファイル。 */
function fakeAppBinary(appLog: string): string {
	return `#!/bin/bash
here="$(cd "$(dirname "$0")/.." && pwd)"
if [ "\${1:-}" = "--print-build-info" ]; then
	cat "$here/Resources/build-info.json"
	echo
	exit 0
fi
printf '%s\\t%s\\n' "$here" "$*" >> ${JSON.stringify(appLog)}
exit 0
`;
}

function infoPlist(version: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>vellis</string>
	<key>CFBundleIdentifier</key><string>com.tetsuo.vellis</string>
	<key>CFBundleName</key><string>vellis</string>
	<key>CFBundleShortVersionString</key><string>${version}</string>
	<key>CFBundleVersion</key><string>${version}</string>
</dict>
</plist>
`;
}

/** `<root>/vellis.app` に偽のアプリを置く。 */
function placeApp(root: string, info: BuildInfoJson, appLog: string) {
	const app = join(root, 'vellis.app', 'Contents');
	write(join(app, 'MacOS', 'vellis'), fakeAppBinary(appLog), 0o755);
	write(join(app, 'Resources', 'build-info.json'), JSON.stringify(info));
	write(join(app, 'Resources', 'marker.txt'), `installed ${info.buildName || info.version}\n`);
	write(join(app, 'Info.plist'), infoPlist(info.version));
}

/** 偽の gh(node)。 */
function fakeGh(sb: Sandbox): string {
	return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const LOG = ${JSON.stringify(sb.ghLog)};
const DEV_REPO = ${JSON.stringify(DEV_REPO)};
const RELEASES = ${JSON.stringify(RELEASES)};
const FIELDS = ['createdAt', 'isDraft', 'isImmutable', 'isLatest', 'isPrerelease', 'name', 'publishedAt', 'tagName'];

const argv = process.argv.slice(2);
const record = { argv, ghRepoEnv: process.env.GH_REPO || null, cwd: process.cwd() };
const log = (extra) => fs.appendFileSync(LOG, JSON.stringify({ ...record, ...extra }) + '\\n');
const fail = (msg) => { log({ error: msg }); process.stderr.write(msg + '\\n'); process.exit(1); };

let repo = process.env.GH_REPO || null;
const rest = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '-R' || a === '--repo') { repo = argv[++i]; continue; }
	if (a.startsWith('--repo=')) { repo = a.slice('--repo='.length); continue; }
	if (a.startsWith('-R') && a.length > 2) { repo = a.slice(2); continue; }
	rest.push(a);
}
const norm = (r) => String(r).replace(/^https?:\\/\\//, '').replace(/^github\\.com\\//, '').replace(/\\.git$/, '').replace(/\\/$/, '');
record.repo = repo === null ? null : norm(repo);

const [group, sub, ...args] = rest;
if (group === 'auth') { log({}); process.exit(0); }
if (group !== 'release' || !['list', 'ls', 'view', 'download'].includes(sub)) {
	fail('fake gh: "' + rest.join(' ') + '" is not faked (契約: gh release list / view / download)');
}
if (record.repo === null) {
	fail('failed to determine base repo: not a git repository (fake gh: 契約= --repo ' + DEV_REPO + ' か GH_REPO)');
}
if (record.repo !== DEV_REPO) fail('HTTP 404: Not Found (fake gh: ' + record.repo + ' is not the development repository)');

const VALUE = { list: ['--json', '-q', '--jq', '-L', '--limit', '-O', '--order', '-t', '--template'],
	ls: ['--json', '-q', '--jq', '-L', '--limit', '-O', '--order', '-t', '--template'],
	view: ['--json', '-q', '--jq', '-t', '--template'],
	download: ['-p', '--pattern', '-D', '--dir', '-O', '--output', '-A', '--archive'] }[sub];
const LONG = { '-q': '--jq', '-L': '--limit', '-t': '--template', '-p': '--pattern', '-D': '--dir', '-A': '--archive' };
const opts = {}; const pos = [];
for (let i = 0; i < args.length; i++) {
	let a = args[i]; let v;
	const eq = a.startsWith('--') ? a.indexOf('=') : -1;
	if (eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
	else if (VALUE.includes(a)) { v = args[++i]; }
	else if (a.startsWith('-') && a.length > 1) { v = true; }
	else { pos.push(a); continue; }
	if (a === '-O') a = sub === 'download' ? '--output' : '--order';
	a = LONG[a] || a;
	if (a === '--pattern') { (opts[a] = opts[a] || []).push(v); } else { opts[a] = v; }
}
const on = (k) => opts[k] === true || opts[k] === 'true';

function emit(data) {
	if (opts['--template'] !== undefined) fail('fake gh: --template is not faked');
	if (opts['--json'] === undefined || opts['--json'] === true) {
		if (opts['--jq'] !== undefined) fail('cannot use \`--jq\` without specifying \`--json\`');
		return false;
	}
	const fields = String(opts['--json']).split(',').map((s) => s.trim()).filter(Boolean);
	for (const f of fields) if (!FIELDS.includes(f)) fail('Unknown JSON field: "' + f + '"');
	const pick = (r) => Object.fromEntries(fields.map((f) => [f, r[f]]));
	const out = Array.isArray(data) ? data.map(pick) : pick(data);
	const json = JSON.stringify(out);
	if (opts['--jq'] !== undefined) {
		const jq = spawnSync('jq', ['-r', String(opts['--jq'])], { input: json, encoding: 'utf8' });
		if (jq.error) fail('fake gh: jq is not available: ' + jq.error.message);
		process.stdout.write(jq.stdout);
		if (jq.status !== 0) fail(jq.stderr || 'jq failed');
	} else {
		process.stdout.write(JSON.stringify(out, null, 2) + '\\n');
	}
	return true;
}
const kind = (r) => (r.isDraft ? 'Draft' : r.isPrerelease ? 'Pre-release' : r.isLatest ? 'Latest' : '');
const latest = () => RELEASES.find((r) => r.isLatest);
const find = (tag) => RELEASES.find((r) => r.tagName === tag);

if (sub === 'list' || sub === 'ls') {
	let rows = RELEASES.filter((r) => !(on('--exclude-pre-releases') && r.isPrerelease)).filter((r) => !(on('--exclude-drafts') && r.isDraft));
	if (opts['--order'] === 'asc') rows = [...rows].reverse();
	rows = rows.slice(0, opts['--limit'] !== undefined ? Number(opts['--limit']) : 30);
	log({ listed: rows.map((r) => r.tagName) });
	if (!emit(rows)) process.stdout.write(rows.map((r) => [r.name, kind(r), r.tagName, r.publishedAt].join('\\t')).join('\\n') + '\\n');
	process.exit(0);
}

if (sub === 'view') {
	const r = pos[0] ? find(pos[0]) : latest();
	if (!r) fail('release not found');
	log({ viewed: r.tagName });
	if (!emit(r)) process.stdout.write('title:\\t' + r.name + '\\ntag:\\t' + r.tagName + '\\nprerelease:\\t' + r.isPrerelease + '\\npublished:\\t' + r.publishedAt + '\\nasset:\\t' + r.asset + '\\n');
	process.exit(0);
}

// download
if (!pos[0] && opts['--pattern'] === undefined && opts['--archive'] === undefined) {
	fail('the \`--pattern\` or \`--archive\` flag is required when downloading the latest release');
}
if (opts['--archive'] !== undefined) fail('fake gh: --archive is not faked');
const r = pos[0] ? find(pos[0]) : latest();
if (!r) fail('release not found');
const toRe = (g) => new RegExp('^' + String(g).replace(/[.+^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '.*').replace(/\\?/g, '.') + '$');
const pats = opts['--pattern'] || [];
if (pats.length && !pats.some((p) => toRe(p).test(r.asset))) fail('no assets match the file pattern');
let file;
if (opts['--output'] !== undefined && opts['--output'] !== true) {
	if (opts['--output'] === '-') fail('fake gh: --output - is not faked');
	file = path.resolve(String(opts['--output']));
} else {
	file = path.resolve(opts['--dir'] && opts['--dir'] !== true ? String(opts['--dir']) : '.', r.asset);
}
if (fs.existsSync(file)) {
	if (on('--skip-existing')) { log({ downloaded: r.tagName, file, skipped: true }); process.exit(0); }
	if (!on('--clobber')) fail('"' + file + '" already exists (use \`--clobber\` to overwrite file or \`--skip-existing\` to skip file)');
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(r.buildInfo));
log({ downloaded: r.tagName, file });
process.exit(0);
`;
}

/** 偽の diskutil / hdiutil(bash)。DMG の中身(JSON)から vellis.app を作る。 */
function fakeMounter(sb: Sandbox, tool: 'diskutil' | 'hdiutil'): string {
	const defaultMount = join(sb.dir, 'Volumes', 'vellis');
	const appBody = fakeAppBinary(sb.appLog);
	return `#!/bin/bash
printf '${tool}\\t%s\\n' "$*" >> ${JSON.stringify(sb.callLog)}
attach=0
if [ "${tool}" = diskutil ]; then
	[ "\${1:-}" = image ] && [ "\${2:-}" = attach ] && { attach=1; shift 2; }
else
	[ "\${1:-}" = attach ] && { attach=1; shift 1; }
fi
[ "$attach" = 1 ] || exit 0
mp=""; dmg=""; plist=0
while [ $# -gt 0 ]; do
	case "$1" in
		--mountPoint|--mountpoint|-mountPoint|-mountpoint) mp="$2"; shift 2 ;;
		-mountroot|--mountroot) mp="$2/vellis"; shift 2 ;;
		-shadow|--shadow|-owners|--mountOptions|-drivekey|-section) shift 2 ;;
		-plist) plist=1; shift ;;
		-*) shift ;;
		*) dmg="$1"; shift ;;
	esac
done
[ -f "$dmg" ] || { echo "${tool}: attach failed - No such file or directory: $dmg" >&2; exit 1; }
[ -n "$mp" ] || mp=${JSON.stringify(defaultMount)}
mkdir -p "$mp/vellis.app/Contents/MacOS" "$mp/vellis.app/Contents/Resources"
cat "$dmg" > "$mp/vellis.app/Contents/Resources/build-info.json"
cat > "$mp/vellis.app/Contents/MacOS/vellis" <<'FAKE_APP_EOF'
${appBody}FAKE_APP_EOF
chmod 755 "$mp/vellis.app/Contents/MacOS/vellis"
ver="$(sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "$dmg")"
cat > "$mp/vellis.app/Contents/Info.plist" <<PLIST_EOF
${infoPlist('$ver')}PLIST_EOF
if [ "$plist" = 1 ]; then
	cat <<PLIST_OUT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>system-entities</key><array>
<dict><key>content-hint</key><string>GUID_partition_scheme</string><key>dev-entry</key><string>/dev/disk99</string></dict>
<dict><key>content-hint</key><string>Apple_HFS</string><key>dev-entry</key><string>/dev/disk99s1</string><key>mount-point</key><string>$mp</string></dict>
</array></dict></plist>
PLIST_OUT
else
	printf '/dev/disk99\\tGUID_partition_scheme\\t\\n/dev/disk99s1\\tApple_HFS\\t%s\\n' "$mp"
fi
exit 0
`;
}

/** 記録して `$<VAR>`(既定 0)で終わる偽の命令。 */
function fakeRecorder(sb: Sandbox, name: string, exitVar?: string, body = ''): string {
	const code = exitVar ? `\${${exitVar}:-0}` : '0';
	return `#!/bin/bash
printf '${name}\\t%s\\n' "$*" >> ${JSON.stringify(sb.callLog)}
code=${code}
last="\${@: -1}"
${body}
exit "$code"
`;
}

/** 本物へ渡す見張り。`/Applications` を引数に持つ呼び出しは記録して断る。 */
function guard(sb: Sandbox, name: string, real: string): string {
	return `#!/bin/bash
for a in "$@"; do
	case "$a" in
		/Applications|/Applications/*)
			printf '${name}\\t%s\\n' "$*" >> ${JSON.stringify(sb.applicationsLog)}
			echo "fake ${name}: refusing to touch $a in a test" >&2
			exit 1 ;;
	esac
done
exec ${real} "$@"
`;
}

function makeSandbox(): Sandbox {
	const dir = mkdtempSync(join(tmpdir(), 'vellis-install-dev-'));
	const sb: Sandbox = {
		dir,
		bin: join(dir, 'bin'),
		apps: join(dir, 'Applications-under-test'),
		home: join(dir, 'home'),
		tmp: join(dir, 'tmp'),
		ghLog: join(dir, 'log', 'gh.jsonl'),
		callLog: join(dir, 'log', 'calls.tsv'),
		applicationsLog: join(dir, 'log', 'applications.tsv'),
		appLog: join(dir, 'log', 'app.tsv'),
	};
	for (const d of [sb.bin, sb.apps, sb.home, sb.tmp, dirname(sb.ghLog)]) mkdirSync(d, { recursive: true });
	for (const f of [sb.ghLog, sb.callLog, sb.applicationsLog, sb.appLog]) writeFileSync(f, '');

	write(join(sb.bin, 'gh'), fakeGh(sb), 0o755);
	write(join(sb.bin, 'diskutil'), fakeMounter(sb, 'diskutil'), 0o755);
	write(join(sb.bin, 'hdiutil'), fakeMounter(sb, 'hdiutil'), 0o755);
	write(
		join(sb.bin, 'codesign'),
		fakeRecorder(
			sb,
			'codesign',
			'FAKE_CODESIGN_EXIT',
			`case " $* " in *" -d"*|*" --display"*) echo "Authority=Developer ID Application: Example (TEAMID0000)" >&2; echo "TeamIdentifier=TEAMID0000" >&2 ;; esac
[ "$code" = 0 ] || echo "$last: invalid signature (code or signature have been modified)" >&2`,
		),
		0o755,
	);
	write(
		join(sb.bin, 'spctl'),
		fakeRecorder(
			sb,
			'spctl',
			'FAKE_SPCTL_EXIT',
			`if [ "$code" = 0 ]; then echo "$last: accepted" >&2; echo "source=Notarized Developer ID" >&2; else echo "$last: rejected" >&2; echo "source=Unnotarized Developer ID" >&2; fi`,
		),
		0o755,
	);
	write(
		join(sb.bin, 'xcrun'),
		fakeRecorder(
			sb,
			'xcrun',
			undefined,
			`if [ "\${1:-}" = stapler ]; then code="\${FAKE_STAPLER_EXIT:-0}"; [ "$code" = 0 ] && echo "The validate action worked!"; fi`,
		),
		0o755,
	);
	for (const name of ['osascript', 'pkill', 'killall', 'open']) write(join(sb.bin, name), fakeRecorder(sb, name), 0o755);
	write(join(sb.bin, 'sudo'), fakeRecorder(sb, 'sudo', undefined, 'code=1; echo "fake sudo: refused in a test" >&2'), 0o755);
	write(join(sb.bin, 'pgrep'), fakeRecorder(sb, 'pgrep', undefined, 'code=1'), 0o755);
	for (const [name, real] of [
		['rm', '/bin/rm'],
		['cp', '/bin/cp'],
		['mv', '/bin/mv'],
		['ln', '/bin/ln'],
		['ditto', '/usr/bin/ditto'],
		['rsync', '/usr/bin/rsync'],
	] as const) {
		write(join(sb.bin, name), guard(sb, name, real), 0o755);
	}
	return sb;
}

// ───────────────────────── 走らせる ─────────────────────────

interface GhRecord {
	argv: string[];
	repo: string | null;
	ghRepoEnv: string | null;
	error?: string;
	listed?: string[];
	viewed?: string;
	downloaded?: string;
	file?: string;
}

interface Run {
	status: number | null;
	output: string;
	gh: GhRecord[];
	calls: Array<{ cmd: string; args: string }>;
	applications: string;
}

let sb: Sandbox;

beforeEach(() => {
	sb = makeSandbox();
});

afterEach(() => {
	rmSync(sb.dir, { recursive: true, force: true });
});

function runInstall(args: string[], extraEnv: Record<string, string> = {}): Run {
	if (!existsSync(script)) {
		throw new Error(`scripts/install-dev.sh が無い(契約6): ${script}`);
	}
	const result = spawnSync('bash', [script, ...args], {
		cwd: sb.dir,
		env: {
			PATH: [sb.bin, dirname(process.execPath), '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
			HOME: sb.home,
			TMPDIR: sb.tmp,
			LANG: 'en_US.UTF-8',
			LC_ALL: 'en_US.UTF-8',
			VELLIS_INSTALL_DIR: sb.apps,
			...extraEnv,
		},
		input: '',
		encoding: 'utf8',
		timeout: RUN_LIMIT_MS,
	});
	const gh = readFileSync(sb.ghLog, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as GhRecord);
	const calls = readFileSync(sb.callLog, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => {
			const tab = l.indexOf('\t');
			return { cmd: l.slice(0, tab), args: l.slice(tab + 1) };
		});
	return {
		status: result.status,
		output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
		gh,
		calls,
		applications: readFileSync(sb.applicationsLog, 'utf8'),
	};
}

/** 入れる先の木の写し(相対パス → 種別・大きさ・時刻・権限・中身のハッシュ)。 */
function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const p = join(dir, name);
			const st = lstatSync(p);
			const rel = p.slice(root.length);
			if (st.isDirectory()) {
				out[rel] = `dir ${st.mode.toString(8)} ${st.mtimeMs}`;
				walk(p);
			} else {
				const hash = st.isFile() ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'link';
				out[rel] = `file ${st.mode.toString(8)} ${st.size} ${st.mtimeMs} ${hash}`;
			}
		}
	};
	walk(root);
	return out;
}

const downloads = (run: Run) => run.gh.filter((r) => r.downloaded !== undefined).map((r) => r.downloaded);

function explain(run: Run): string {
	return `exit=${run.status}\n--- output ---\n${run.output}\n--- gh ---\n${run.gh.map((r) => JSON.stringify(r)).join('\n')}\n--- calls ---\n${run.calls.map((c) => `${c.cmd} ${c.args}`).join('\n')}`;
}

// ───────────────────────── AC-87-6 ─────────────────────────

describe('AC-87-6: scripts/install-dev.sh — 構文', () => {
	it('exists, is executable, and passes bash -n', () => {
		expect(existsSync(script), 'scripts/install-dev.sh がある').toBe(true);
		expect(statSync(script).mode & 0o111, '実行の権限がある(scripts/install-dev.sh で起動する)').not.toBe(0);
		const r = spawnSync('bash', ['-n', script], {
			encoding: 'utf8',
			env: { PATH: '/usr/bin:/bin' },
		});
		expect(r.status, `bash -n: ${r.stderr}`).toBe(0);
	});
});

describe('AC-87-6: scripts/install-dev.sh --dry-run(偽の gh で)', () => {
	it(
		'picks the newest development release when no name is given (never a public v x.y.z), and prints the names before and after',
		() => {
			placeApp(sb.apps, INSTALLED_PREVIEW, sb.appLog);
			const run = runInstall(['--dry-run']);
			expect(run.status, explain(run)).toBe(0);
			expect(downloads(run), explain(run)).toEqual(['dev/req-80/2']);
			// 入れる前(いま入っている版)と後(入れるはずの版)の名前
			expect(run.output, explain(run)).toContain(INSTALLED_PREVIEW_NAME);
			expect(run.output, explain(run)).toContain(byTag('dev/req-80/2').name);
		},
		RUN_LIMIT_MS,
	);

	it(
		'picks the newest release of the given development name (10 is newer than 9; another name is not taken)',
		() => {
			placeApp(sb.apps, INSTALLED_PREVIEW, sb.appLog);
			const run = runInstall(['--dry-run', 'req-74']);
			expect(run.status, explain(run)).toBe(0);
			expect(downloads(run), explain(run)).toEqual(['dev/req-74/10']);
			expect(run.output, explain(run)).toContain(INSTALLED_PREVIEW_NAME);
			expect(run.output, explain(run)).toContain(byTag('dev/req-74/10').name);
		},
		RUN_LIMIT_MS,
	);

	it(
		'matches the development name exactly (req-7 does not pick req-74)',
		() => {
			placeApp(sb.apps, INSTALLED_PREVIEW, sb.appLog);
			const run = runInstall(['--dry-run', 'req-7']);
			expect(run.status, explain(run)).toBe(0);
			expect(downloads(run), explain(run)).toEqual(['dev/req-7/5']);
			expect(run.output, explain(run)).toContain(byTag('dev/req-7/5').name);
		},
		RUN_LIMIT_MS,
	);

	it(
		'fails without downloading anything when the development name has no release',
		() => {
			placeApp(sb.apps, INSTALLED_PREVIEW, sb.appLog);
			const before = snapshot(sb.apps);
			const run = runInstall(['--dry-run', 'req-99']);
			expect(run.status, explain(run)).not.toBe(0);
			expect(downloads(run), explain(run)).toEqual([]);
			expect(snapshot(sb.apps)).toEqual(before);
		},
		RUN_LIMIT_MS,
	);

	it(
		'asks the development repository only (explicit --repo / GH_REPO), never the public one',
		() => {
			placeApp(sb.apps, INSTALLED_PREVIEW, sb.appLog);
			const run = runInstall(['--dry-run', 'req-74']);
			expect(run.status, explain(run)).toBe(0);
			const releaseCalls = run.gh.filter((r) => r.argv.includes('release'));
			expect(releaseCalls.length, explain(run)).toBeGreaterThan(0);
			for (const r of releaseCalls) {
				expect(r.repo, `gh ${r.argv.join(' ')}`).toBe(DEV_REPO);
			}
			expect(JSON.stringify(run.gh)).not.toContain(`"${PUBLIC_REPO}"`);
		},
		RUN_LIMIT_MS,
	);

	it(
		'verifies the signature (codesign) and the notarization (spctl) of the downloaded DMG or the app in it',
		() => {
			placeApp(sb.apps, INSTALLED_PREVIEW, sb.appLog);
			const run = runInstall(['--dry-run', 'req-74']);
			expect(run.status, explain(run)).toBe(0);
			const target = /\.dmg\b|vellis\.app/i;
			const codesign = run.calls.filter((c) => c.cmd === 'codesign');
			const spctl = run.calls.filter((c) => c.cmd === 'spctl');
			expect(codesign.some((c) => target.test(c.args)), `codesign on the DMG / vellis.app\n${explain(run)}`).toBe(true);
			expect(spctl.some((c) => target.test(c.args)), `spctl on the DMG / vellis.app\n${explain(run)}`).toBe(true);
			expect(
				spctl.some((c) => /(^|\s)(-a\w*|--assess)\b/.test(c.args)),
				`spctl assesses (-a / --assess)\n${explain(run)}`,
			).toBe(true);
		},
		RUN_LIMIT_MS,
	);

	it(
		'stops with a non-zero exit when codesign rejects the signature',
		() => {
			placeApp(sb.apps, INSTALLED_PREVIEW, sb.appLog);
			const before = snapshot(sb.apps);
			const run = runInstall(['--dry-run', 'req-74'], { FAKE_CODESIGN_EXIT: '1' });
			expect(run.status, explain(run)).not.toBe(0);
			expect(run.calls.some((c) => c.cmd === 'codesign'), explain(run)).toBe(true);
			expect(snapshot(sb.apps)).toEqual(before);
		},
		RUN_LIMIT_MS,
	);

	it(
		'stops with a non-zero exit when spctl rejects the notarization',
		() => {
			placeApp(sb.apps, INSTALLED_PREVIEW, sb.appLog);
			const before = snapshot(sb.apps);
			const run = runInstall(['--dry-run', 'req-74'], { FAKE_SPCTL_EXIT: '3' });
			expect(run.status, explain(run)).not.toBe(0);
			expect(run.calls.some((c) => c.cmd === 'spctl'), explain(run)).toBe(true);
			expect(snapshot(sb.apps)).toEqual(before);
		},
		RUN_LIMIT_MS,
	);

	it(
		'does not replace anything: the install dir is untouched, /Applications is not touched, Vellis is not quit',
		() => {
			placeApp(sb.apps, INSTALLED_PREVIEW, sb.appLog);
			const before = snapshot(sb.apps);
			const run = runInstall(['--dry-run']);
			expect(run.status, explain(run)).toBe(0);
			expect(snapshot(sb.apps), '入れる先(VELLIS_INSTALL_DIR)の中身・時刻がそのまま').toEqual(before);
			expect(run.applications, '本物の /Applications に触れない').toBe('');
			for (const cmd of ['osascript', 'pkill', 'killall', 'sudo', 'open']) {
				expect(
					run.calls.filter((c) => c.cmd === cmd),
					`--dry-run は ${cmd} を呼ばない(Vellis を閉じない・置き換えない)`,
				).toEqual([]);
			}
		},
		RUN_LIMIT_MS,
	);

	it(
		'names an installed release build by its version when it has no buildName',
		() => {
			placeApp(sb.apps, INSTALLED_OLD_RELEASE, sb.appLog);
			const run = runInstall(['--dry-run', 'req-74']);
			expect(run.status, explain(run)).toBe(0);
			expect(run.output, explain(run)).toContain(INSTALLED_OLD_RELEASE.version);
			expect(run.output, explain(run)).toContain(byTag('dev/req-74/10').name);
		},
		RUN_LIMIT_MS,
	);

	it(
		'still runs (exit 0) and names the release to install when Vellis is not installed yet',
		() => {
			const run = runInstall(['--dry-run', 'req-74']);
			expect(run.status, explain(run)).toBe(0);
			expect(downloads(run), explain(run)).toEqual(['dev/req-74/10']);
			expect(run.output, explain(run)).toContain(byTag('dev/req-74/10').name);
			expect(readdirSync(sb.apps), '入れる先に何も作らない').toEqual([]);
		},
		RUN_LIMIT_MS,
	);
});
