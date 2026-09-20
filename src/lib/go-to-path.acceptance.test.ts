/**
 * 要件#60 の受け入れテスト(docs/requirements/req-60.md)— 純関数と解決・跳躍
 * 「パスを入力してファイル/フォルダへ移動する(Go to)。相対パスは今の窓で跳ぶ・
 *  root 外の絶対パスは新ウィンドウで開く・無ければ『無い』と出す」
 *
 * 契約(2026-09-18 登録・追補a/b/c/d=2026-09-20。丸番号は req-60.md「契約番号と本文の対応」):
 * - ② 入力の解釈=相対 / 絶対 / root と同じ scheme・authority の URI。`.` `..` と
 *   末尾 `/`・連続 `/`・前後空白の正規化。`..` で root を出た相対パスは絶対扱い。
 *   **`~`=home(追補c)**: 先頭が `~` で直後が `/` か終端のときだけ deps.homeDir()
 *   の値に置き換え、以降は絶対パスと同じ規則。`~user/…` は展開しない。homeDir が
 *   null/reject なら展開せず「無い」。ssh の root では homeDir を呼ばない。
 *   **先頭の `\~`** は `~` という文字そのものに置き換えて相対パス(それ以外の
 *   `\` は名前の一部)
 * - ③ root 配下判定=セグメント境界の前方一致。**照合は契約④と同じ二段構え=
 *   完全一致→大文字小文字無視(追補d)**。inside の URI は root 側の綴りで組む
 *   (相対セグメントは入力の綴りのまま)。配下=今の窓・外=新ウィンドウ。
 *   root 自身(`.`・`/`・root の絶対パス・root の URI・大文字小文字違いの root)
 *   と空入力は何もしない
 * - ④ 解決=root から1階層ずつ listDir で降りて照合(完全一致優先・次に大文字
 *   小文字無視)。root 外は親を1回だけ。得た一覧は setChildEntries で覚える。
 *   **ドット経路(追補c)**: 正規化後のセグメントに `.` 始まりが1つでもあれば
 *   降下せず listDir(目的地) 1回→成功=フォルダ(新ウィンドウ)/失敗=open を
 *   試してファイル(今の窓・root 外でも)/両方失敗=「無い」。binary は open
 *   せず「無い」。ファイルは confirmDiscard を通す
 * - ⑤ root 配下で一致=ファイルは開く・フォルダは展開して一覧順で最初の開ける
 *   ファイルを開く(無ければフォルダを選択)。祖先を展開・既存の展開は閉じない
 * - ⑤' root 外で一致=新ウィンドウ(`new_window` と同形の引数)。今の窓は不変
 * - ⑥ 一致しない=notFound(`File or folder not found`)。副作用ゼロ・例外なし
 * - ⑨ 流用と不変・依存追加ゼロ・Tauri command 追加ゼロ
 *
 * 判定範囲(本ファイル): AC-60-1〜15・AC-60-18・AC-60-20〜30
 * (13 は追補c で改訂・26〜29=追補c・30=追補d)。
 * バー UI(AC-60-16/17)は GoToBar.wiring.test.ts、メニュー(AC-60-19)は
 * src-tauri/tests/acceptance_req60.rs、+page.svelte の配線(バーの開閉・
 * イベント受信・失敗 alert)は reviewer 照合、実機の見た目・体感は人間ゲート
 * (acceptance/acceptance.md 要件#60 ①〜⑥)。
 *
 * ## 確定契約(公開 API・implementer はこれに従う=オーケストレーター指定 2026-09-20)
 *
 * ```ts
 * // --- 新規 src/lib/go-to-path.ts(純関数+コールバック注入。Tauri を import しない)---
 *
 * // 入力文字列を候補へ畳む(契約②③)。
 * //  - null                      … 空文字・空白のみ(何もしない)
 * //  - { kind: 'root' }          … root 自身(`.`・`/`・root の絶対パス・root の URI。
 * //                                大文字小文字違いも root 自身=追補d)
 * //  - { kind: 'inside', uri, segments }   … root 配下。segments は root からの相対。
 * //                                配下判定は完全一致→大文字小文字無視の二段構え
 * //                                (追補d)。uri は root 側の綴りで組む
 * //  - { kind: 'outside', uri, parentUri, name } … root 外の絶対パス(親を1回照合する材料)
 * //  - { kind: 'dotted', uri }   … 正規化後のセグメントに `.` 始まりを含むパス
 * //                                (追補c。root 配下か外かは問わない。listDir(uri)→
 * //                                open(uri) の順で当てる材料)
 * //  - { kind: 'unopenable' }    … 別 scheme / 別 authority の URI(そのプロバイダで開けない)
 * //
 * // `~` の展開は homeDir()(async)が要るため resolveGoToInput では固定しない。
 * // `~` の規則は revealPath の観測(AC-60-26/28)で固定する。先頭の `\~` は
 * // resolveGoToInput の段階で `~` の文字に置き換わる(AC-60-27)。
 * export function resolveGoToInput(input: string, rootUri: string):
 *   | null
 *   | { kind: 'root' }
 *   | { kind: 'inside'; uri: string; segments: string[] }
 *   | { kind: 'outside'; uri: string; parentUri: string; name: string }
 *   | { kind: 'dotted'; uri: string }
 *   | { kind: 'unopenable' };
 *
 * // 解決と跳躍(契約④⑤⑤'⑥)。deps はすべて注入(Tauri 無しで試せる形=契約の一部)。
 * // Entry は既存の list_dir の型({ uri, name, kind: 'dir' | 'file' | 'symlink' })。
 * export function revealPath(input: string, deps: {
 *   rootUri: string;
 *   listDir(uri: string): Promise<Entry[]>;
 *   open(uri: string): Promise<void>;
 *   newWindow(args: { path: string | null; root: string; expandedDirs: [] }): Promise<unknown>;
 *   setExpandedDirs(uris: string[]): void;
 *   getExpandedDirs(): string[];
 *   setChildEntries(uri: string, entries: Entry[]): void;
 *   selectTreeItem(uri: string): void;
 *   notFound(): void;
 *   confirmDiscard(): Promise<boolean>;
 *   detectFileType(name: string): string;
 *   onNewWindowFailed(err: unknown): void;
 *   // 追補c: `~` 展開に使う home の URI(`file:///Users/me` 形。末尾 `/` 付きでも
 *   // 同じに扱う)。取れなければ null。ssh の root では呼ばれない(AC-60-28)。
 *   homeDir(): Promise<string | null>;
 * }): Promise<unknown>;
 *
 * // 「無い」の文言(値固定・英語=要件#51。GoToBar の表示欄が使う)。
 * export const GO_TO_NOT_FOUND_MESSAGE = 'File or folder not found';
 * ```
 *
 * ## スタブの設計
 * - listDir はテスト内の疑似 FS(uri → Entry[] / Error)。duplicate-window /
 *   open-in-new-window のモックとは共有しない(要件#59 と同じ家風・自前で持つ)
 * - detectFileType は注入(.png / .zip / .bin → 'binary'・それ以外 'markdown')。
 *   実物 src/lib/file-type.ts の分類表は要件#19 のテストの持ち場
 *
 * ## 判断の記録(test-writer 2026-09-20)
 * - AC-60-15 の「1階層につき1回」は **listDir した全階層(root の一覧を含む)と
 *   1:1** と読む(「解決の途中で得た各階層の一覧」の字義どおり)。root の一覧を
 *   別の口(rootEntries)で覚える実装は deps に口が無いので採れない
 * - AC-60-21/22 の「今の窓は不変」には confirmDiscard を呼ばないことを含める
 *   (契約⑤'「今の窓が編集中でも聞かない」の明文)
 *
 * ## 判断の記録(test-writer 2026-09-20 追補c/d)
 * - resolveGoToInput の結果型に { kind: 'dotted', uri } を追加(オーケストレーター
 *   承認の範囲)。dotted は inside/outside を区別しない — revealPath の挙動が
 *   両者で同じ(ファイル=今の窓・フォルダ=新ウィンドウ)なので uri だけで足りる
 * - `~` の展開は revealPath の観測で固定し、resolveGoToInput('~/…') の返り値は
 *   固定しない(homeDir が async で純関数に載らないため。実装は revealPath 側で
 *   展開してから畳んでよい)
 * - ドット経路で confirmDiscard が false のときは notFound も呼ばない
 *   (キャンセルは「無い」ではない=契約⑤「キャンセルされたら跳ばない」の準用)
 * - homeDir が null/reject のときは listDir を呼ばず notFound 直行
 *   (契約②「展開せず『無い』」の字義。ssh の「`~` という名前として解決を試みる」
 *   =AC-60-28 とは違う経路)
 * - AC-60-30 の inside の uri は「root の綴り+入力の綴りの相対セグメント」
 *   (契約③の明文)。セグメント境界の判定は大文字小文字無視でも保つ
 *   (`/a/Workspace/x.md` は root `file:///a/work` の外)
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { GO_TO_NOT_FOUND_MESSAGE, resolveGoToInput, revealPath } from './go-to-path';

const REPO_ROOT = resolve(__dirname, '../..');

/** 以下すべてのテストで root は file:///a/work(req-60.md 受け入れ基準の前提)。 */
const ROOT = 'file:///a/work';

type Entry = { uri: string; name: string; kind: 'dir' | 'file' | 'symlink' };

const d = (parent: string, name: string): Entry => ({ uri: `${parent}/${name}`, name, kind: 'dir' });
const f = (parent: string, name: string): Entry => ({
	uri: `${parent}/${name}`,
	name,
	kind: 'file',
});

/**
 * 既定の疑似 FS。root 配下に a/b(sub・z.md・c.md)と docs、root 外に
 * /a/other(sub2・pic.png・x.md)を置く。`list` の順(ディレクトリ優先)を模す。
 * AC-60-8 のとおり root/a/b のファイルは名前昇順ではなく一覧順の判定ができる並び
 * (z.md が c.md より先)にしてある。
 */
function defaultFs(): Record<string, Entry[] | Error> {
	return {
		'file:///a': [d('file:///a', 'other'), d('file:///a', 'work')],
		'file:///a/other': [
			d('file:///a/other', 'sub2'),
			f('file:///a/other', 'pic.png'),
			f('file:///a/other', 'x.md'),
		],
		[ROOT]: [d(ROOT, 'a'), d(ROOT, 'docs'), f(ROOT, 'README.md')],
		[`${ROOT}/a`]: [d(`${ROOT}/a`, 'b'), f(`${ROOT}/a`, 'c.md'), f(`${ROOT}/a`, 'pic.png')],
		[`${ROOT}/a/b`]: [d(`${ROOT}/a/b`, 'sub'), f(`${ROOT}/a/b`, 'z.md'), f(`${ROOT}/a/b`, 'c.md')],
		[`${ROOT}/docs`]: [f(`${ROOT}/docs`, 'req-60.md'), f(`${ROOT}/docs`, 'x.md')],
	};
}

/** revealPath へ注入する deps 一式(すべて観測台)。 */
function makeDeps(
	fs: Record<string, Entry[] | Error> = defaultFs(),
	opts: { expanded?: string[]; rootUri?: string } = {}
) {
	const listDir = vi.fn(async (uri: string): Promise<Entry[]> => {
		const v = fs[uri];
		if (v === undefined) throw new Error(`not a directory: ${uri}`);
		if (v instanceof Error) throw v;
		return v;
	});
	return {
		rootUri: opts.rootUri ?? ROOT,
		listDir,
		open: vi.fn(async () => {}),
		newWindow: vi.fn(async (): Promise<unknown> => 'vellis-2'),
		setExpandedDirs: vi.fn((_uris: string[]) => {}),
		getExpandedDirs: vi.fn((): string[] => opts.expanded ?? []),
		setChildEntries: vi.fn((_uri: string, _entries: Entry[]) => {}),
		selectTreeItem: vi.fn((_uri: string) => {}),
		notFound: vi.fn(() => {}),
		confirmDiscard: vi.fn(async () => true),
		detectFileType: vi.fn((name: string) =>
			/\.(png|zip|bin)$/i.test(name) ? 'binary' : 'markdown'
		),
		onNewWindowFailed: vi.fn((_err: unknown) => {}),
		// 追補c: `~` 展開の home(URI 形)。テストごとに mockResolvedValue で差し替える。
		homeDir: vi.fn(async (): Promise<string | null> => 'file:///Users/me'),
	};
}

/**
 * `~` 展開のテスト用 FS(AC-60-26)。defaultFs に home(file:///Users/me)配下を
 * 足したもの。root(file:///a/work)の外にあるので既存テストへの影響は無い。
 */
function homeFs(): Record<string, Entry[] | Error> {
	const fs = defaultFs();
	fs['file:///Users'] = [d('file:///Users', 'me')];
	fs['file:///Users/me'] = [d('file:///Users/me', 'docs'), f('file:///Users/me', 'x.md')];
	fs['file:///Users/me/docs'] = [f('file:///Users/me/docs', 'x.md')];
	return fs;
}

/** listDir が呼ばれた uri の列。 */
const listedUris = (deps: ReturnType<typeof makeDeps>) =>
	deps.listDir.mock.calls.map((c) => c[0]);

/** 「今の窓もダイアログも一切動かない」ことの共通断言(契約⑥の副作用ゼロ)。 */
function expectNoSideEffects(deps: ReturnType<typeof makeDeps>) {
	expect(deps.open).not.toHaveBeenCalled();
	expect(deps.newWindow).not.toHaveBeenCalled();
	expect(deps.setExpandedDirs).not.toHaveBeenCalled();
	expect(deps.selectTreeItem).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// AC-60-1 — 相対パスの正規化(契約②)
// ---------------------------------------------------------------------------

describe('AC-60-1: 相対パスの正規化 — 同じ入力は同じ候補 URI(契約②)', () => {
	const expected = {
		kind: 'inside',
		uri: `${ROOT}/docs/req-60.md`,
		segments: ['docs', 'req-60.md'],
	};

	test.each([
		['素の相対パス', 'docs/req-60.md'],
		['`./` 始まり(`.` セグメントは捨てる)', './docs/req-60.md'],
		['連続する `/` は1つに畳む', 'docs//req-60.md'],
		['前後の空白は落とす', '  docs/req-60.md  '],
	])('%s → 同じ候補', (_label, input) => {
		expect(resolveGoToInput(input, ROOT)).toEqual(expected);
	});

	test('末尾の `/` は落とす — `docs/` と `docs` は同じ候補(種別は実体が決める)', () => {
		const dir = { kind: 'inside', uri: `${ROOT}/docs`, segments: ['docs'] };
		expect(resolveGoToInput('docs', ROOT)).toEqual(dir);
		expect(resolveGoToInput('docs/', ROOT)).toEqual(dir);
	});

	test('空文字・空白のみは null(何もしない)', () => {
		expect(resolveGoToInput('', ROOT)).toBeNull();
		expect(resolveGoToInput('   ', ROOT)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-60-2 — `..` の畳み込み(契約②)
// ---------------------------------------------------------------------------

describe('AC-60-2: `..` セグメントは1つ上へ畳む(契約②)', () => {
	const expected = { kind: 'inside', uri: `${ROOT}/README.md`, segments: ['README.md'] };

	test('docs/../README.md → root 直下の README.md', () => {
		expect(resolveGoToInput('docs/../README.md', ROOT)).toEqual(expected);
	});

	test('docs/sub/../../README.md → 同じ(多段でも畳める)', () => {
		expect(resolveGoToInput('docs/sub/../../README.md', ROOT)).toEqual(expected);
	});
});

// ---------------------------------------------------------------------------
// AC-60-3 — 絶対パスと URI(契約②)
// ---------------------------------------------------------------------------

describe('AC-60-3: 絶対パスと URI は相対と同じ候補へ畳む(契約②)', () => {
	test('絶対パス・file URI・相対パスが同じ候補になる', () => {
		const byRelative = resolveGoToInput('docs/x.md', ROOT);
		expect(byRelative).toEqual({
			kind: 'inside',
			uri: `${ROOT}/docs/x.md`,
			segments: ['docs', 'x.md'],
		});
		expect(resolveGoToInput('/a/work/docs/x.md', ROOT)).toEqual(byRelative);
		expect(resolveGoToInput('file:///a/work/docs/x.md', ROOT)).toEqual(byRelative);
	});

	test('ssh root: 同じ scheme・authority の URI は通る(配下=inside)', () => {
		expect(resolveGoToInput('ssh://h/p/x.md', 'ssh://h/p')).toEqual({
			kind: 'inside',
			uri: 'ssh://h/p/x.md',
			segments: ['x.md'],
		});
	});

	test('ssh root: 絶対パスは同じ host の絶対パスとして読む(root 外=outside)', () => {
		expect(resolveGoToInput('/x/y.md', 'ssh://h/p')).toEqual({
			kind: 'outside',
			uri: 'ssh://h/x/y.md',
			parentUri: 'ssh://h/x',
			name: 'y.md',
		});
	});

	test('別 authority / 別 scheme の URI は「開けない」(unopenable)', () => {
		expect(resolveGoToInput('ssh://other/p/x.md', 'ssh://h/p')).toEqual({ kind: 'unopenable' });
		expect(resolveGoToInput('file:///a/x.md', 'ssh://h/p')).toEqual({ kind: 'unopenable' });
		// 逆向き: file root に ssh URI(そのプロバイダで開けない)
		expect(resolveGoToInput('ssh://h/x.md', ROOT)).toEqual({ kind: 'unopenable' });
	});
});

// ---------------------------------------------------------------------------
// AC-60-4 — root 配下判定はセグメント境界(契約③・追補b)
// ---------------------------------------------------------------------------

describe('AC-60-4: root 配下判定 — セグメント境界の前方一致・`..` 脱出は絶対扱い(契約③)', () => {
	test.each([
		['`..` で root を出た相対パス', '../outside.md', 'file:///a/outside.md', 'outside.md'],
		['多段の `..` 脱出', 'docs/../../x.md', 'file:///a/x.md', 'x.md'],
		['root 外の絶対パス', '/a/x.md', 'file:///a/x.md', 'x.md'],
		['root 外の file URI', 'file:///a/x.md', 'file:///a/x.md', 'x.md'],
		['絶対パスの中の `..` で root を出る', '/a/work/../x.md', 'file:///a/x.md', 'x.md'],
	])('%s → outside(%s)', (_label, input, uri, name) => {
		expect(resolveGoToInput(input, ROOT)).toEqual({
			kind: 'outside',
			uri,
			parentUri: 'file:///a',
			name,
		});
	});

	test('file:///a/workspace/x.md は root(file:///a/work)の配下では無い(素の startsWith の罠)', () => {
		expect(resolveGoToInput('file:///a/workspace/x.md', ROOT)).toEqual({
			kind: 'outside',
			uri: 'file:///a/workspace/x.md',
			parentUri: 'file:///a/workspace',
			name: 'x.md',
		});
	});

	test('/a/work/docs/x.md は配下(inside)', () => {
		expect(resolveGoToInput('/a/work/docs/x.md', ROOT)).toEqual({
			kind: 'inside',
			uri: `${ROOT}/docs/x.md`,
			segments: ['docs', 'x.md'],
		});
	});
});

// ---------------------------------------------------------------------------
// AC-60-5 — root 自身と空入力は何もしない(契約③⑥)
// ---------------------------------------------------------------------------

describe('AC-60-5: root 自身・空入力 — listDir も notFound も呼ばれない(契約③⑥)', () => {
	test.each([
		['`.`', '.'],
		['`/` だけ(ファイルシステムのルートではなく root 自身)', '/'],
		['root の絶対パスそのもの', '/a/work'],
		['root の URI そのもの', 'file:///a/work'],
		['空文字', ''],
		['空白のみ', '   '],
	])('%s → 何も起こさない', async (_label, input) => {
		const deps = makeDeps();
		await revealPath(input, deps);

		expect(deps.listDir).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
		expectNoSideEffects(deps);
	});
});

// ---------------------------------------------------------------------------
// AC-60-6 — 開けない URI は「無い」で副作用ゼロ(契約②⑥)
// ---------------------------------------------------------------------------

describe('AC-60-6: 別 host / 別 scheme の URI — notFound 1回・他は一切呼ばれない(契約②⑥)', () => {
	test.each([
		['別 scheme(file root に ssh URI)', 'ssh://h/x.md'],
		['別 authority 相当(file root に authority 付き file URI とは別物の scheme)', 'https://example.com/x.md'],
	])('%s → notFound のみ', async (_label, input) => {
		const deps = makeDeps();
		await revealPath(input, deps);

		expect(deps.notFound).toHaveBeenCalledTimes(1);
		expect(deps.listDir).not.toHaveBeenCalled();
		expectNoSideEffects(deps);
	});

	test('ssh root に別 host の ssh URI / file URI → notFound のみ', async () => {
		for (const input of ['ssh://other/p/x.md', 'file:///a/x.md']) {
			const deps = makeDeps({}, { rootUri: 'ssh://h/p' });
			await revealPath(input, deps);

			expect(deps.notFound).toHaveBeenCalledTimes(1);
			expect(deps.listDir).not.toHaveBeenCalled();
			expectNoSideEffects(deps);
		}
	});
});

// ---------------------------------------------------------------------------
// AC-60-7 — 段階的な解決(契約④)
// ---------------------------------------------------------------------------

describe('AC-60-7: a/b/c.md — listDir が root → root/a → root/a/b の順に3回だけ(契約④)', () => {
	test('呼び出し列が固定で、ファイルとして解決される', async () => {
		const deps = makeDeps();
		await revealPath('a/b/c.md', deps);

		expect(listedUris(deps)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/a/b`]);
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/a/b/c.md`);
		expect(deps.notFound).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-60-8 — フォルダは一覧順で最初の開けるファイルを開く(契約④⑤・追補b)
// ---------------------------------------------------------------------------

describe('AC-60-8: フォルダ a/b — 一覧順で最初のファイル z.md を開く・sub へ降りない(契約④⑤)', () => {
	test('listDir 3回(フォルダ自身を含む)・open は z.md(名前順の c.md ではない)', async () => {
		const deps = makeDeps();
		await revealPath('a/b', deps);

		// 一覧 [dir sub, file z.md, file c.md] の順で最初のファイル= z.md。
		expect(listedUris(deps)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/a/b`]);
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/a/b/z.md`);
		expect(deps.notFound).not.toHaveBeenCalled();
	});

	test('展開集合に root/a と root/a/b の両方が入る(フォルダ自身も展開=追補b)', async () => {
		const deps = makeDeps();
		await revealPath('a/b', deps);

		expect(deps.setExpandedDirs).toHaveBeenCalledTimes(1);
		expect(deps.setExpandedDirs.mock.calls[0]?.[0]).toEqual(
			expect.arrayContaining([`${ROOT}/a`, `${ROOT}/a/b`])
		);
	});

	test('サブフォルダ sub は listDir されない(降りない=追補b (n))', async () => {
		const deps = makeDeps();
		await revealPath('a/b', deps);

		expect(listedUris(deps)).not.toContain(`${ROOT}/a/b/sub`);
		expect(deps.listDir).toHaveBeenCalledTimes(3);
	});
});

// ---------------------------------------------------------------------------
// AC-60-9 — ファイルは開く・展開は祖先だけ(契約⑤)
// ---------------------------------------------------------------------------

describe('AC-60-9: ファイル a/b/c.md — open 1回・展開は祖先のみ・selectTreeItem 無し(契約⑤)', () => {
	test('open が root/a/b/c.md で1回', async () => {
		const deps = makeDeps();
		await revealPath('a/b/c.md', deps);

		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/a/b/c.md`);
	});

	test('展開集合に root/a と root/a/b が入り、ファイル自身は入らない', async () => {
		const deps = makeDeps();
		await revealPath('a/b/c.md', deps);

		const dirs = deps.setExpandedDirs.mock.calls[0]?.[0] as string[];
		expect(dirs).toEqual(expect.arrayContaining([`${ROOT}/a`, `${ROOT}/a/b`]));
		expect(dirs).not.toContain(`${ROOT}/a/b/c.md`);
	});

	test('selectTreeItem は呼ばれない(選択は開いた文書についてくる)', async () => {
		const deps = makeDeps();
		await revealPath('a/b/c.md', deps);

		expect(deps.selectTreeItem).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-60-10 — 既存の展開を閉じない(契約⑤)
// ---------------------------------------------------------------------------

describe('AC-60-10: 無関係な枝の展開が残る(契約⑤)', () => {
	test('展開済みの root/docs が、a/b/c.md へ跳んだ後の展開集合にも残る', async () => {
		const deps = makeDeps(defaultFs(), { expanded: [`${ROOT}/docs`] });
		await revealPath('a/b/c.md', deps);

		expect(deps.setExpandedDirs.mock.calls[0]?.[0]).toEqual(
			expect.arrayContaining([`${ROOT}/docs`, `${ROOT}/a`, `${ROOT}/a/b`])
		);
	});
});

// ---------------------------------------------------------------------------
// AC-60-11 — 照合: 完全一致優先・次に大文字小文字無視(契約④)
// ---------------------------------------------------------------------------

describe('AC-60-11: 大文字小文字 — 無視の一致で解決するが、完全一致が常に勝つ(契約④)', () => {
	test('一覧に Docs しか無いとき docs/x.md が Docs/x.md に解決する', async () => {
		const fs: Record<string, Entry[] | Error> = {
			[ROOT]: [d(ROOT, 'Docs')],
			[`${ROOT}/Docs`]: [f(`${ROOT}/Docs`, 'x.md')],
		};
		const deps = makeDeps(fs);
		await revealPath('docs/x.md', deps);

		expect(listedUris(deps)).toEqual([ROOT, `${ROOT}/Docs`]);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/Docs/x.md`);
		expect(deps.notFound).not.toHaveBeenCalled();
	});

	test('Docs と docs の両方があるとき docs のほうへ降りる(完全一致優先)', async () => {
		const fs: Record<string, Entry[] | Error> = {
			[ROOT]: [d(ROOT, 'Docs'), d(ROOT, 'docs')],
			[`${ROOT}/Docs`]: [f(`${ROOT}/Docs`, 'x.md')],
			[`${ROOT}/docs`]: [f(`${ROOT}/docs`, 'x.md')],
		};
		const deps = makeDeps(fs);
		await revealPath('docs/x.md', deps);

		expect(listedUris(deps)).toEqual([ROOT, `${ROOT}/docs`]);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/docs/x.md`);
	});
});

// ---------------------------------------------------------------------------
// AC-60-12 — 存在しない・途中が非ディレクトリ・listDir 失敗は「無い」(契約⑥)
// ---------------------------------------------------------------------------

describe('AC-60-12: root 配下の「無い」 — notFound 1回・副作用ゼロ・例外なし(契約⑥)', () => {
	test('a/zzz.md(存在しない)→ notFound のみ', async () => {
		const deps = makeDeps();
		await revealPath('a/zzz.md', deps);

		expect(deps.notFound).toHaveBeenCalledTimes(1);
		expectNoSideEffects(deps);
	});

	test('a/c.md/d.md(途中のセグメントがファイル)→ notFound のみ', async () => {
		const deps = makeDeps();
		await revealPath('a/c.md/d.md', deps);

		expect(deps.notFound).toHaveBeenCalledTimes(1);
		expectNoSideEffects(deps);
	});

	test('listDir が reject(権限・切断)→ notFound のみ・例外は外へ出ない', async () => {
		const fs = defaultFs();
		fs[`${ROOT}/a`] = new Error('permission denied');
		const deps = makeDeps(fs);

		await expect(revealPath('a/b/c.md', deps)).resolves.not.toThrow();
		expect(deps.notFound).toHaveBeenCalledTimes(1);
		expectNoSideEffects(deps);
	});
});

// ---------------------------------------------------------------------------
// AC-60-13 — ドット始まりはツリーを経由せずに開く(契約④・追補c)
// ---------------------------------------------------------------------------

describe('AC-60-13: ドット経路 — 降下せず listDir(目的地)→open。フォルダは新ウィンドウ(契約④・追補c)', () => {
	// 「list が `.` 始まりを返さない」前提の Rust 側の固定は既存
	// src-tauri/tests/acceptance_req31.rs::list_still_skips_hidden_entries_including_symlinks
	// が担う(要件#31。変えない)。だからこそ降下では届かず、listDir(目的地)→
	// open(目的地)の順で当てる(振る舞い「ドット始まりのパス」)。
	test('resolveGoToInput: `.` 始まりのセグメントを含むパスは dotted(root 配下でも外でも)', () => {
		expect(resolveGoToInput('.github/workflows/ci.yml', ROOT)).toEqual({
			kind: 'dotted',
			uri: `${ROOT}/.github/workflows/ci.yml`,
		});
		expect(resolveGoToInput('/a/other/.env', ROOT)).toEqual({
			kind: 'dotted',
			uri: 'file:///a/other/.env',
		});
		// 途中のセグメントが `.` 始まりでも対象(祖先が隠しフォルダ)。
		expect(resolveGoToInput('docs/.hidden/x.md', ROOT)).toEqual({
			kind: 'dotted',
			uri: `${ROOT}/docs/.hidden/x.md`,
		});
		// `.` `..` は正規化で消えるので dotted にならない(AC-60-1/2 の既存固定と整合)。
		expect(resolveGoToInput('./docs/req-60.md', ROOT)).toEqual({
			kind: 'inside',
			uri: `${ROOT}/docs/req-60.md`,
			segments: ['docs', 'req-60.md'],
		});
		// 別 scheme / 別 authority の門(契約②)はドット経路より先に閉まる。
		expect(resolveGoToInput('ssh://other/p/.env', 'ssh://h/p')).toEqual({ kind: 'unopenable' });
	});

	test('root 配下のファイル .github/workflows/ci.yml → listDir(目的地) 1回 reject → open 同 URI 1回', async () => {
		const uri = `${ROOT}/.github/workflows/ci.yml`;
		const deps = makeDeps(); // 疑似 FS に無い uri の listDir は reject する
		await revealPath('.github/workflows/ci.yml', deps);

		expect(listedUris(deps)).toEqual([uri]);
		expect(deps.listDir).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(uri);
		// ツリーは触らない(行が無い)・新ウィンドウも開かない・「無い」でもない。
		expect(deps.setExpandedDirs).not.toHaveBeenCalled();
		expect(deps.selectTreeItem).not.toHaveBeenCalled();
		expect(deps.newWindow).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
	});

	test('root 外のファイル /a/other/.env も今の窓で open(root 外の通常ファイル=新ウィンドウとは違う=追補c (u))', async () => {
		const deps = makeDeps();
		await revealPath('/a/other/.env', deps);

		expect(listedUris(deps)).toEqual(['file:///a/other/.env']);
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith('file:///a/other/.env');
		expect(deps.newWindow).not.toHaveBeenCalled();
		expect(deps.setExpandedDirs).not.toHaveBeenCalled();
		expect(deps.selectTreeItem).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
	});

	test('フォルダ .claude — listDir(目的地) が resolve → newWindow({ path: null, root, expandedDirs: [] })', async () => {
		const fs = defaultFs();
		fs[`${ROOT}/.claude`] = [f(`${ROOT}/.claude`, 'settings.json')];
		const deps = makeDeps(fs);
		await revealPath('.claude', deps);

		expect(listedUris(deps)).toEqual([`${ROOT}/.claude`]);
		expect(deps.newWindow).toHaveBeenCalledTimes(1);
		expect(deps.newWindow).toHaveBeenCalledWith({
			path: null,
			root: `${ROOT}/.claude`,
			expandedDirs: [],
		});
		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.setExpandedDirs).not.toHaveBeenCalled();
		expect(deps.selectTreeItem).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
	});

	test('listDir も open も失敗 → notFound 1回・副作用ゼロ・例外なし', async () => {
		const deps = makeDeps();
		deps.open.mockRejectedValueOnce(new Error('no such file'));

		await expect(revealPath('.nope/x.md', deps)).resolves.not.toThrow();
		expect(deps.listDir).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledTimes(1); // 試しはする(存在確認を兼ねる)
		expect(deps.notFound).toHaveBeenCalledTimes(1);
		expect(deps.newWindow).not.toHaveBeenCalled();
		expect(deps.setExpandedDirs).not.toHaveBeenCalled();
		expect(deps.selectTreeItem).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-60-14 — 開けない種類は開かない(契約⑤)
// ---------------------------------------------------------------------------

describe('AC-60-14: binary のファイル — open せず展開と selectTreeItem だけ(契約⑤)', () => {
	test('a/pic.png(detectFileType=binary)→ open 0回・選択と展開のみ', async () => {
		const deps = makeDeps();
		await revealPath('a/pic.png', deps);

		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.selectTreeItem).toHaveBeenCalledTimes(1);
		expect(deps.selectTreeItem).toHaveBeenCalledWith(`${ROOT}/a/pic.png`);
		expect(deps.setExpandedDirs).toHaveBeenCalledTimes(1);
		expect(deps.setExpandedDirs.mock.calls[0]?.[0]).toEqual(
			expect.arrayContaining([`${ROOT}/a`])
		);
		expect(deps.notFound).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-60-15 — 子一覧を覚える(契約④)
// ---------------------------------------------------------------------------

describe('AC-60-15: 降りながら得た一覧を setChildEntries で1階層につき1回渡す(契約④)', () => {
	test('a/b/c.md — listDir した3階層(root を含む)と1:1・同じ一覧', async () => {
		const fs = defaultFs();
		const deps = makeDeps(fs);
		await revealPath('a/b/c.md', deps);

		expect(deps.setChildEntries.mock.calls).toEqual([
			[ROOT, fs[ROOT]],
			[`${ROOT}/a`, fs[`${ROOT}/a`]],
			[`${ROOT}/a/b`, fs[`${ROOT}/a/b`]],
		]);
	});

	test('フォルダ a/b — 目的地フォルダ自身の一覧も含む', async () => {
		const fs = defaultFs();
		const deps = makeDeps(fs);
		await revealPath('a/b', deps);

		expect(deps.setChildEntries.mock.calls).toEqual([
			[ROOT, fs[ROOT]],
			[`${ROOT}/a`, fs[`${ROOT}/a`]],
			[`${ROOT}/a/b`, fs[`${ROOT}/a/b`]],
		]);
	});
});

// ---------------------------------------------------------------------------
// AC-60-18 — 決定性(契約④)
// ---------------------------------------------------------------------------

describe('AC-60-18: 決定性 — 同じ入力と一覧は同じ結果・順序が変わっても完全一致は不変(契約④)', () => {
	test('同じ入力を2回解決しても同じ呼び出しになる', async () => {
		const first = makeDeps();
		const second = makeDeps();
		await revealPath('a/b/c.md', first);
		await revealPath('a/b/c.md', second);

		expect(first.open.mock.calls).toEqual(second.open.mock.calls);
		expect(listedUris(first)).toEqual(listedUris(second));
	});

	test('一覧の順序を入れ替えても、完全一致があるかぎり同じ解決になる', async () => {
		const shuffled = defaultFs();
		shuffled[ROOT] = [f(ROOT, 'README.md'), d(ROOT, 'docs'), d(ROOT, 'a')];
		shuffled[`${ROOT}/a`] = [f(`${ROOT}/a`, 'pic.png'), f(`${ROOT}/a`, 'c.md'), d(`${ROOT}/a`, 'b')];

		const plain = makeDeps();
		const reordered = makeDeps(shuffled);
		await revealPath('a/b/c.md', plain);
		await revealPath('a/b/c.md', reordered);

		expect(reordered.open.mock.calls).toEqual(plain.open.mock.calls);
		expect(reordered.open).toHaveBeenCalledWith(`${ROOT}/a/b/c.md`);
	});
});

// ---------------------------------------------------------------------------
// AC-60-20 — 不変と依存(契約⑨)
// ---------------------------------------------------------------------------

describe('AC-60-20: 依存追加ゼロ・Tauri command 追加ゼロ・不変ファイル(契約⑨)', () => {
	test('notFound の文言は値固定(英語=要件#51)', () => {
		expect(GO_TO_NOT_FOUND_MESSAGE).toBe('File or folder not found');
	});

	test('package.json の依存キーが登録時点(2026-09-20)と同一', () => {
		const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		expect(Object.keys(pkg.dependencies).sort()).toEqual(
			[
				'@shikijs/rehype',
				'@tauri-apps/api',
				'@tauri-apps/plugin-dialog',
				'@tauri-apps/plugin-opener',
				'hast-util-to-mdast',
				'mdast-util-to-markdown',
				'mdast-util-to-string',
				'mermaid',
				'rehype-parse',
				'rehype-raw',
				'rehype-sanitize',
				'rehype-stringify',
				'remark-gfm',
				'remark-parse',
				'remark-rehype',
				'three',
				'unified',
				'unist-util-visit',
			].sort()
		);
		expect(Object.keys(pkg.devDependencies).sort()).toEqual(
			[
				'@sveltejs/adapter-static',
				'@sveltejs/kit',
				'@sveltejs/vite-plugin-svelte',
				'@tauri-apps/cli',
				'@testing-library/svelte',
				'@testing-library/user-event',
				'@types/hast',
				'@types/mdast',
				'@types/node',
				'@types/three',
				'@wdio/cli',
				'@wdio/globals',
				'@wdio/local-runner',
				'@wdio/mocha-framework',
				'@wdio/spec-reporter',
				'expect-webdriverio',
				'happy-dom',
				'jsdom',
				'shiki',
				'svelte',
				'svelte-check',
				'tsx',
				'typescript',
				'vite',
				'vitest',
				'webdriverio',
			].sort()
		);
	});

	test('Cargo.toml の [dependencies] のクレート集合が登録時点と同一', () => {
		const cargo = readFileSync(resolve(REPO_ROOT, 'src-tauri/Cargo.toml'), 'utf-8');
		const section = cargo.split(/^\[dependencies\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
		const crates = section
			.split('\n')
			.map((line) => /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1])
			.filter((name): name is string => !!name);
		expect([...crates].sort()).toEqual(
			[
				'tauri',
				'tauri-plugin-opener',
				'serde',
				'serde_json',
				'clap',
				'thiserror',
				'tokio',
				'async-trait',
				'notify',
				'libc',
				'tracing',
				'tracing-subscriber',
				'mime_guess',
				'http',
				'percent-encoding',
				'tauri-plugin-dialog',
				'reqwest',
				'russh',
				'russh-sftp',
				'bytes',
				'dirs',
				'ulid',
				'chrono',
				'strsim',
				'sha2',
				'similar',
				'hidapi',
				'toml',
				'tauri-plugin-webdriver',
				'tauri-plugin-window-state',
			].sort()
		);
	});

	test('Tauri command が増えていない — generate_handler! の一覧が登録時点と同一', () => {
		const libRs = readFileSync(resolve(REPO_ROOT, 'src-tauri/src/lib.rs'), 'utf-8');
		const blocks = [...libRs.matchAll(/generate_handler!\[([^\]]*)\]/g)].map((m) =>
			(m[1] ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
				.map((s) => s.split('::').pop() as string)
		);
		const production = [
			'init_window',
			'open_document',
			'open_binary_document',
			'save_document',
			'set_root',
			'new_window',
			'list_dir',
			'subscribe_dir',
			'unsubscribe_dir',
			'add_mark',
			'list_marks',
			'update_mark',
			'remove_mark',
			'generate_inbox',
			'rebind_marks_for_file',
			'list_snapshots',
			'diff_against_snapshot',
			'revert_to_snapshot',
			'get_build_info',
			'list_history',
			'get_video_frame_index',
			'extract_waveform_audio',
			'analyze_wav_waveform',
			'print_current_window',
			'print_html',
		];
		// webdriver ブランチはテストヘルパ1つだけ多い(lib.rs のコメントどおり)。
		expect(blocks).toHaveLength(2);
		for (const block of blocks) {
			expect(block.filter((name) => name !== '__test_list_windows')).toEqual(production);
		}
	});

	test('tauri.conf.json の CSP を値固定', () => {
		const conf = JSON.parse(
			readFileSync(resolve(REPO_ROOT, 'src-tauri/tauri.conf.json'), 'utf-8')
		) as { app: { security: { csp: string } } };
		expect(conf.app.security).toEqual({
			csp: "default-src 'self' tauri: customprotocol: asset:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: vellis-asset: asset: http://asset.localhost tauri: customprotocol:; font-src 'self' data:; media-src 'self' vellis-asset: asset: http://asset.localhost; frame-src 'self' vellis-asset:; connect-src 'self' ipc: http://ipc.localhost vellis-asset: asset: http://asset.localhost tauri: customprotocol:; object-src 'none'; base-uri 'self' vellis-asset:; frame-ancestors 'none'",
		});
	});

	test('capabilities/default.json の permission 一覧を値固定(追加・削除・並べ替え無し)', () => {
		const capability = JSON.parse(
			readFileSync(resolve(REPO_ROOT, 'src-tauri/capabilities/default.json'), 'utf-8')
		) as { permissions: Array<string | { identifier: string }> };
		const identifiers = capability.permissions.map((p) =>
			typeof p === 'string' ? p : p.identifier
		);
		expect(identifiers).toEqual([
			'core:default',
			'opener:allow-open-url',
			'opener:allow-reveal-item-in-dir',
			'opener:allow-open-path',
			'dialog:default',
			'window-state:default',
			'core:window:allow-destroy',
		]);
	});

	test('不変ファイルに go-to 系の文字列が混入していない(契約⑨のソース走査)', () => {
		const files: string[] = [
			resolve(REPO_ROOT, 'src/components/HtmlViewer.svelte'),
			resolve(REPO_ROOT, 'src/lib/html-viewer.ts'),
			resolve(REPO_ROOT, 'src-tauri/src/commands/window.rs'),
		];
		for (const dir of [
			resolve(REPO_ROOT, 'src/markdown'),
			resolve(REPO_ROOT, 'src/html'),
			resolve(REPO_ROOT, 'src-tauri/src/fs'),
			resolve(REPO_ROOT, 'src-tauri/src/window'),
		]) {
			for (const name of readdirSync(dir, { recursive: true }) as string[]) {
				const path = join(dir, name);
				if (statSync(path).isFile()) files.push(path);
			}
		}
		for (const path of files) {
			const content = readFileSync(path, 'utf-8');
			for (const token of ['go-to', 'go_to', 'goTo', 'GoTo', 'GO_TO']) {
				expect(content, `${path} に「${token}」が混入(契約⑨の不変対象)`).not.toContain(token);
			}
		}
	});

	test('要件#54 のテスト2本は無改変(登録時点 2026-09-20 の SHA-256 固定)', () => {
		// 「無改変で緑」の「緑」はフルスイートの実行(test-runner)が判定する。
		const hash = (rel: string) =>
			createHash('sha256').update(readFileSync(resolve(REPO_ROOT, rel))).digest('hex');
		expect(hash('src/components/Viewer.find.wiring.test.ts')).toBe(
			'7c94a6251ddd306a0b74ad6027dbf7bf0f08a75cf8c87a73bfc25f6793ba7775'
		);
		expect(hash('src/lib/find-in-document.acceptance.test.ts')).toBe(
			'9eb8051b72069fc03fbcd51a75e5cf4f597d7ae6338632a7149aa941f7c49bf3'
		);
	});
});

// ---------------------------------------------------------------------------
// AC-60-21 — root 外のファイルは新ウィンドウ(契約⑤'・追補b)
// ---------------------------------------------------------------------------

describe("AC-60-21: root 外のファイル — 親を1回 listDir・newWindow(root=親)・今の窓は不変(契約⑤')", () => {
	const expectedArgs = {
		path: 'file:///a/other/x.md',
		root: 'file:///a/other',
		expandedDirs: [],
	};

	test.each([
		['絶対パス', '/a/other/x.md'],
		['file URI', 'file:///a/other/x.md'],
		['絶対パスの中の `..`', '/a/other/../other/x.md'],
		['`..` で root を出た相対パス', '../other/x.md'],
	])('%s → listDir は親1回・newWindow 1回・他ゼロ', async (_label, input) => {
		const deps = makeDeps();
		await revealPath(input, deps);

		expect(listedUris(deps)).toEqual(['file:///a/other']);
		expect(deps.newWindow).toHaveBeenCalledTimes(1);
		expect(deps.newWindow).toHaveBeenCalledWith(expectedArgs);
		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.setExpandedDirs).not.toHaveBeenCalled();
		expect(deps.selectTreeItem).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
		// 今の窓の文書は動かないので編集の始末も聞かない(契約⑤')。
		expect(deps.confirmDiscard).not.toHaveBeenCalled();
	});

	test('開けない種類(binary)は path: null で新ウィンドウ(ツリーに載せるだけ=追補b (s))', async () => {
		const deps = makeDeps();
		await revealPath('/a/other/pic.png', deps);

		expect(deps.newWindow).toHaveBeenCalledTimes(1);
		expect(deps.newWindow).toHaveBeenCalledWith({
			path: null,
			root: 'file:///a/other',
			expandedDirs: [],
		});
		expect(deps.open).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-60-22 — root 外のフォルダは新ウィンドウ(契約⑤'・追補a)
// ---------------------------------------------------------------------------

describe("AC-60-22: root 外のフォルダ — newWindow(path: null, root=そのフォルダ)(契約⑤')", () => {
	test('/a/other → listDir は file:///a を1回・newWindow 1回・他ゼロ', async () => {
		const deps = makeDeps();
		await revealPath('/a/other', deps);

		expect(listedUris(deps)).toEqual(['file:///a']);
		expect(deps.newWindow).toHaveBeenCalledTimes(1);
		expect(deps.newWindow).toHaveBeenCalledWith({
			path: null,
			root: 'file:///a/other',
			expandedDirs: [],
		});
		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.setExpandedDirs).not.toHaveBeenCalled();
		expect(deps.selectTreeItem).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
		expect(deps.confirmDiscard).not.toHaveBeenCalled();
	});

	test('newWindow が reject しても例外は外へ出ず、失敗通知が1回(要件#59 と同じ扱い)', async () => {
		const deps = makeDeps();
		const failure = new Error('window creation failed');
		deps.newWindow.mockRejectedValueOnce(failure);

		await expect(revealPath('/a/other', deps)).resolves.not.toThrow();
		expect(deps.onNewWindowFailed).toHaveBeenCalledTimes(1);
		expect(deps.onNewWindowFailed).toHaveBeenCalledWith(failure);
		expect(deps.notFound).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-60-23 — root 外の不在・失敗は「無い」(契約⑤'⑥)
// ---------------------------------------------------------------------------

describe("AC-60-23: root 外の「無い」 — notFound 1回・副作用ゼロ・例外なし(契約⑤'⑥)", () => {
	test('/a/other/zzz.md(親の一覧に無い)→ notFound のみ', async () => {
		const deps = makeDeps();
		await revealPath('/a/other/zzz.md', deps);

		expect(deps.notFound).toHaveBeenCalledTimes(1);
		expectNoSideEffects(deps);
	});

	test('親の listDir が reject → notFound のみ・例外は外へ出ない', async () => {
		const fs = defaultFs();
		fs['file:///a/other'] = new Error('permission denied');
		const deps = makeDeps(fs);

		await expect(revealPath('/a/other/x.md', deps)).resolves.not.toThrow();
		expect(deps.notFound).toHaveBeenCalledTimes(1);
		expectNoSideEffects(deps);
	});
});

// ---------------------------------------------------------------------------
// AC-60-24 — root 配下の絶対パスは今の窓(契約③・追補b)
// ---------------------------------------------------------------------------

describe('AC-60-24: /a/work/a/b/c.md は a/b/c.md と同じ呼び出し列(契約③・挙動表 9)', () => {
	test('listDir 3回・open 1回が一致し、newWindow は呼ばれない', async () => {
		const byRelative = makeDeps();
		const byAbsolute = makeDeps();
		await revealPath('a/b/c.md', byRelative);
		await revealPath('/a/work/a/b/c.md', byAbsolute);

		expect(listedUris(byAbsolute)).toEqual(listedUris(byRelative));
		expect(listedUris(byAbsolute)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/a/b`]);
		expect(byAbsolute.open.mock.calls).toEqual(byRelative.open.mock.calls);
		expect(byAbsolute.open).toHaveBeenCalledWith(`${ROOT}/a/b/c.md`);
		expect(byAbsolute.newWindow).not.toHaveBeenCalled();
		expect(byRelative.newWindow).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-60-25 — 開けるファイルの無いフォルダは選択だけ(契約⑤・追補b)
// ---------------------------------------------------------------------------

describe('AC-60-25: 開けるファイルの無いフォルダ — 展開と選択だけ・メッセージ無し(契約⑤)', () => {
	test.each([
		['空のフォルダ', [] as Entry[]],
		['サブフォルダだけ', [d(`${ROOT}/a/b`, 'sub')]],
		['開けない種類(binary)だけ', [f(`${ROOT}/a/b`, 'pic.png')]],
	])('%s → selectTreeItem(root/a/b) 1回・open も notFound も無し', async (_label, listing) => {
		const fs = defaultFs();
		fs[`${ROOT}/a/b`] = listing;
		const deps = makeDeps(fs);
		await revealPath('a/b', deps);

		expect(deps.setExpandedDirs).toHaveBeenCalledTimes(1);
		expect(deps.setExpandedDirs.mock.calls[0]?.[0]).toEqual(
			expect.arrayContaining([`${ROOT}/a`, `${ROOT}/a/b`])
		);
		expect(deps.selectTreeItem).toHaveBeenCalledTimes(1);
		expect(deps.selectTreeItem).toHaveBeenCalledWith(`${ROOT}/a/b`);
		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-60-26 — `~` は home に展開する(契約②・追補c)
// ---------------------------------------------------------------------------

describe('AC-60-26: `~` の展開 — homeDir() の値に置き換えて以降は絶対パスの規則(契約②・追補c)', () => {
	test('~/docs/x.md(home が root 外)→ 新ウィンドウ(root=file:///Users/me/docs)', async () => {
		const deps = makeDeps(homeFs());
		await revealPath('~/docs/x.md', deps);

		expect(deps.homeDir).toHaveBeenCalled();
		expect(listedUris(deps)).toEqual(['file:///Users/me/docs']);
		expect(deps.newWindow).toHaveBeenCalledTimes(1);
		expect(deps.newWindow).toHaveBeenCalledWith({
			path: 'file:///Users/me/docs/x.md',
			root: 'file:///Users/me/docs',
			expandedDirs: [],
		});
		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
		// 今の窓は不変(契約⑤')。
		expect(deps.setExpandedDirs).not.toHaveBeenCalled();
		expect(deps.selectTreeItem).not.toHaveBeenCalled();
		expect(deps.confirmDiscard).not.toHaveBeenCalled();
	});

	test('~ 単独(home が root 外のフォルダ)→ 新ウィンドウ root=home・path: null', async () => {
		const deps = makeDeps(homeFs());
		await revealPath('~', deps);

		expect(listedUris(deps)).toEqual(['file:///Users']);
		expect(deps.newWindow).toHaveBeenCalledTimes(1);
		expect(deps.newWindow).toHaveBeenCalledWith({
			path: null,
			root: 'file:///Users/me',
			expandedDirs: [],
		});
		expect(deps.notFound).not.toHaveBeenCalled();
	});

	test('homeDir が末尾 `/` 付き(file:///Users/me/)でも同じ結果', async () => {
		const deps = makeDeps(homeFs());
		deps.homeDir.mockResolvedValue('file:///Users/me/');
		await revealPath('~/docs/x.md', deps);

		expect(deps.newWindow).toHaveBeenCalledTimes(1);
		expect(deps.newWindow).toHaveBeenCalledWith({
			path: 'file:///Users/me/docs/x.md',
			root: 'file:///Users/me/docs',
			expandedDirs: [],
		});
	});

	test('home が root 配下(root=home)なら相対扱い — 今の窓で降りて開く', async () => {
		const home = 'file:///Users/me';
		const deps = makeDeps(homeFs(), { rootUri: home });
		await revealPath('~/docs/x.md', deps);

		expect(listedUris(deps)).toEqual([home, `${home}/docs`]);
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${home}/docs/x.md`);
		expect(deps.newWindow).not.toHaveBeenCalled();
	});

	test('~ 単独が root 自身(root=home)なら何もしない(契約③)', async () => {
		const deps = makeDeps(homeFs(), { rootUri: 'file:///Users/me' });
		await revealPath('~', deps);

		expect(deps.listDir).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
		expectNoSideEffects(deps);
	});

	test('~user/x は展開しない — `~user` という名前の相対パス(homeDir は呼ばれない)', async () => {
		const deps = makeDeps();
		await revealPath('~user/x', deps);

		expect(deps.homeDir).not.toHaveBeenCalled();
		// root の一覧に `~user` は無いので「無い」。
		expect(listedUris(deps)).toEqual([ROOT]);
		expect(deps.notFound).toHaveBeenCalledTimes(1);
		expectNoSideEffects(deps);
	});

	test.each([
		['null を返す', (deps: ReturnType<typeof makeDeps>) => deps.homeDir.mockResolvedValue(null)],
		[
			'reject する',
			(deps: ReturnType<typeof makeDeps>) =>
				deps.homeDir.mockRejectedValue(new Error('no home')),
		],
	])('homeDir が %s → 展開せず notFound 1回(listDir は呼ばない)', async (_label, arm) => {
		const deps = makeDeps(homeFs());
		arm(deps);

		await expect(revealPath('~/x.md', deps)).resolves.not.toThrow();
		expect(deps.notFound).toHaveBeenCalledTimes(1);
		expect(deps.listDir).not.toHaveBeenCalled();
		expectNoSideEffects(deps);
	});
});

// ---------------------------------------------------------------------------
// AC-60-27 — 先頭の `\~` は `~` の文字そのもの(契約②・追補c)
// ---------------------------------------------------------------------------

describe('AC-60-27: `\\~` は文字どおり — root 直下の `~` フォルダ・homeDir は呼ばれない(契約②・追補c)', () => {
	test('resolveGoToInput: \\~/x.md → root 直下の `~` フォルダの x.md(inside)', () => {
		expect(resolveGoToInput('\\~/x.md', ROOT)).toEqual({
			kind: 'inside',
			uri: `${ROOT}/~/x.md`,
			segments: ['~', 'x.md'],
		});
	});

	test('resolveGoToInput: 先頭でない `\\` はそのまま名前の一部(a/\\~/x.md)', () => {
		expect(resolveGoToInput('a/\\~/x.md', ROOT)).toEqual({
			kind: 'inside',
			uri: `${ROOT}/a/\\~/x.md`,
			segments: ['a', '\\~', 'x.md'],
		});
	});

	test('revealPath: \\~/x.md は `~` フォルダを降りて開く。homeDir は呼ばれない', async () => {
		const fs: Record<string, Entry[] | Error> = {
			[ROOT]: [d(ROOT, '~')],
			[`${ROOT}/~`]: [f(`${ROOT}/~`, 'x.md')],
		};
		const deps = makeDeps(fs);
		await revealPath('\\~/x.md', deps);

		expect(deps.homeDir).not.toHaveBeenCalled();
		expect(listedUris(deps)).toEqual([ROOT, `${ROOT}/~`]);
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/~/x.md`);
		expect(deps.notFound).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-60-28 — ssh の root では `~` を展開しない(契約②・追補c)
// ---------------------------------------------------------------------------

describe('AC-60-28: ssh root — homeDir を呼ばず `~` という名前として解決を試みる(契約②・追補c (t))', () => {
	test('root=ssh://h/p で ~/x.md → homeDir 0回・root の一覧を1回見て notFound', async () => {
		const sshRoot = 'ssh://h/p';
		const fs: Record<string, Entry[] | Error> = {
			[sshRoot]: [d(sshRoot, 'docs')],
		};
		const deps = makeDeps(fs, { rootUri: sshRoot });
		await revealPath('~/x.md', deps);

		expect(deps.homeDir).not.toHaveBeenCalled();
		expect(listedUris(deps)).toEqual([sshRoot]);
		expect(deps.notFound).toHaveBeenCalledTimes(1);
		expectNoSideEffects(deps);
	});

	test('root=ssh://h/p に `~` という名前のフォルダが実在すれば普通に跳べる(展開ではなく照合)', async () => {
		const sshRoot = 'ssh://h/p';
		const fs: Record<string, Entry[] | Error> = {
			[sshRoot]: [d(sshRoot, '~')],
			[`${sshRoot}/~`]: [f(`${sshRoot}/~`, 'x.md')],
		};
		const deps = makeDeps(fs, { rootUri: sshRoot });
		await revealPath('~/x.md', deps);

		expect(deps.homeDir).not.toHaveBeenCalled();
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${sshRoot}/~/x.md`);
	});
});

// ---------------------------------------------------------------------------
// AC-60-29 — ドット経路の編集中ガードと binary(契約④⑤・追補c)
// ---------------------------------------------------------------------------

describe('AC-60-29: ドット経路のファイル — confirmDiscard false は開かない・binary は「無い」(契約④⑤・追補c)', () => {
	test('confirmDiscard が false → open は呼ばれない(notFound も出さない=キャンセルは「無い」ではない)', async () => {
		const deps = makeDeps();
		deps.confirmDiscard.mockResolvedValue(false);
		await revealPath('.claude/settings.json', deps);

		// ドット経路の probe(降下ではなく目的地を1回)を通っていること。
		expect(listedUris(deps)).toEqual([`${ROOT}/.claude/settings.json`]);
		expect(deps.confirmDiscard).toHaveBeenCalledTimes(1);
		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
		expect(deps.newWindow).not.toHaveBeenCalled();
		expect(deps.setExpandedDirs).not.toHaveBeenCalled();
		expect(deps.selectTreeItem).not.toHaveBeenCalled();
	});

	test('detectFileType が binary → open せず notFound 1回(振る舞い「ドット始まりのパス」)', async () => {
		const deps = makeDeps();
		await revealPath('.claude/logo.png', deps);

		// ドット経路の probe(降下ではなく目的地を1回)を通っていること。
		expect(listedUris(deps)).toEqual([`${ROOT}/.claude/logo.png`]);
		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.notFound).toHaveBeenCalledTimes(1);
		expect(deps.newWindow).not.toHaveBeenCalled();
		expect(deps.setExpandedDirs).not.toHaveBeenCalled();
		expect(deps.selectTreeItem).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// AC-60-30 — root 配下判定は完全一致→大文字小文字無視(契約③・追補d)
// ---------------------------------------------------------------------------

describe('AC-60-30: root 配下判定の大文字小文字 — 二段構え・inside は root の綴り(契約③・追補d)', () => {
	const LOWER_ROOT = 'file:///users/tetsuo/work';

	test('resolveGoToInput: 小文字 root に /Users/tetsuo/work/docs/x.md → inside(uri は root の綴り)', () => {
		expect(resolveGoToInput('/Users/tetsuo/work/docs/x.md', LOWER_ROOT)).toEqual({
			kind: 'inside',
			uri: `${LOWER_ROOT}/docs/x.md`,
			segments: ['docs', 'x.md'],
		});
	});

	test('revealPath: 小文字 root でも今の窓で降りる(AC-60-7 と同じ呼び出し列・newWindow 0回)', async () => {
		const fs: Record<string, Entry[] | Error> = {
			[LOWER_ROOT]: [d(LOWER_ROOT, 'docs')],
			[`${LOWER_ROOT}/docs`]: [f(`${LOWER_ROOT}/docs`, 'x.md')],
		};
		const deps = makeDeps(fs, { rootUri: LOWER_ROOT });
		await revealPath('/Users/tetsuo/work/docs/x.md', deps);

		expect(listedUris(deps)).toEqual([LOWER_ROOT, `${LOWER_ROOT}/docs`]);
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${LOWER_ROOT}/docs/x.md`);
		expect(deps.newWindow).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
	});

	test('大文字小文字違いの root 自身(/a/Work)は root 自身 — 何もしない', async () => {
		expect(resolveGoToInput('/a/Work', ROOT)).toEqual({ kind: 'root' });

		const deps = makeDeps();
		await revealPath('/a/Work', deps);
		expect(deps.listDir).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
		expectNoSideEffects(deps);
	});

	test('完全一致が優先 — /a/work/x.md と /a/WORK/x.md は同じ結果(inside・root の綴り)', () => {
		const exact = resolveGoToInput('/a/work/x.md', ROOT);
		expect(exact).toEqual({
			kind: 'inside',
			uri: `${ROOT}/x.md`,
			segments: ['x.md'],
		});
		expect(resolveGoToInput('/a/WORK/x.md', ROOT)).toEqual(exact);
	});

	test('root 外の判定は不変 — /a/other/x.md は outside のまま', () => {
		expect(resolveGoToInput('/a/other/x.md', ROOT)).toEqual({
			kind: 'outside',
			uri: 'file:///a/other/x.md',
			parentUri: 'file:///a/other',
			name: 'x.md',
		});
	});

	test('セグメント境界は大文字小文字無視でも保つ — /a/Workspace/x.md は root の外', () => {
		expect(resolveGoToInput('/a/Workspace/x.md', ROOT)).toEqual({
			kind: 'outside',
			uri: 'file:///a/Workspace/x.md',
			parentUri: 'file:///a/Workspace',
			name: 'x.md',
		});
	});
});
