/**
 * 要件#70 追補c の受け入れテスト(docs/requirements/req-70.md「追補c(2026-10-20・Issue #666)」)
 * — Go to Path でフォルダを指したとき、その中で最初に開くファイルがリンク切れなら飛ばす
 *   (AC-70-追c (a)〜(c)。unit プロジェクト・`revealPath` の deps をモックで組む=
 *   go-to-path.acceptance.test.ts / go-to-broken-link.acceptance.test.ts と同じ家風)
 *
 * 今は、フォルダの一覧で先頭の「ファイルらしい行」がリンク切れだと `firstOpenableFile` がそれを選び、
 * `open` が `I/O error: …` で失敗して `+page.svelte` の alert が生のエラー文のまま出る
 * (追補b の reviewer P3)。追補b は「打った名前に当たった行」だけが対象だった。
 *
 * ## 契約(追補c)— implementer はこれに従う
 * 1. フォルダの一覧から最初に開くファイルを選ぶ `firstOpenableFile`(`src/lib/go-to-path.ts`・非公開)は、
 *    リンク切れ(`link.broken === true`)の行を飛ばす(ディレクトリと開けない種類=`binary` を飛ばすのと
 *    同じ扱い)。後ろに開けるファイルがあればそれを開く
 * 2. リンク切れしか無い(開けるファイルが無い)ときは、今の「開けるファイルが無い」と同じく展開と選択だけ。
 *    メッセージも alert も出さず、`notFound`・`brokenLink` も呼ばない
 * 3. 不変: 打った名前に当たった行のリンク切れ(追補b=`brokenLink`)・リンクだが切れていない行
 *    (`broken:false`)は今までどおり開く・ツリーの並び順・サブフォルダに降りない・root 外のフォルダ
 *    (新しい窓)・ssh(`broken:false`)。依存の追加なし
 *
 * ## 確定した API
 * 公開の入口は既存の `revealPath(input, deps: GoToDeps)` のまま(追加の export なし)。一覧の行は
 * `GoToEntry`(`link?: { target?: string; broken: boolean }`)。リンク切れの行の `kind` は Rust の
 * `fs/local.rs` と同じく `'symlink'`(追補b のテストと同じ扱い)。ssh のリンクは `kind: 'symlink'` に
 * `{ broken: false }`(`fs/ssh.rs`)。
 *
 * ## 判定(AC-70-追c)
 * - (a) フォルダの一覧が [リンク切れの `a.md`, 普通の `b.md`] なら `open` は `b.md` で1回。
 *   `notFound`・`brokenLink` は呼ばれない
 * - (b) 一覧がリンク切れの `.md` だけなら `open` は呼ばれず、`setExpandedDirs` とフォルダの
 *   `selectTreeItem` だけ。`notFound`・`brokenLink`・`confirmDiscard` は呼ばれない
 * - (c) `link: { broken: false }` の行は最初の開けるファイルとして選ばれる
 * - (d) 既存の Go to のテスト(`go-to-path.acceptance.test.ts`・`go-to-broken-link.acceptance.test.ts`
 *   ほか)は無改変で緑= test-runner のフルスイートが判定(本ファイルでは扱わない)
 *
 * ## 判断の記録(test-writer 2026-10-20)
 * - (a) の「飛ばす」はディレクトリ・binary と同列(契約 1)なので、[リンク切れ, dir, binary, リンク切れ,
 *   普通] の並びでも最後の普通の行を開くことを合わせて判定する
 * - (b) の「展開と選択だけ」は既存の AC-60-25(開けるファイルの無いフォルダ)と同じ観測=
 *   `setExpandedDirs` 1回(祖先とフォルダ自身を含む)・`selectTreeItem`(フォルダ)1回
 * - (c) には ssh 形(`kind: 'symlink'`・`broken: false`)も含める。`kind` で飛ばす実装(`symlink` を
 *   一律に飛ばす)を赤にするため
 * - 実装前に赤: (a) は `open` がリンク切れの `a.md` で呼ばれる・(b) は `open` が呼ばれる(契約違反そのもの)。
 *   (c) と「不変」の節は実装前から緑(退行防止)
 */
import { describe, expect, it, vi } from 'vitest';

import { revealPath } from './go-to-path';

/** root は file:///a/work(go-to-path.acceptance.test.ts と同じ前提)。 */
const ROOT = 'file:///a/work';
const OUTSIDE = 'file:///a/other';

type Link = { target?: string; broken: boolean };
type Row = { uri: string; name: string; kind: 'dir' | 'file' | 'symlink'; link?: Link };

const d = (parent: string, name: string): Row => ({ uri: `${parent}/${name}`, name, kind: 'dir' });
const f = (parent: string, name: string, link?: Link): Row => ({
	uri: `${parent}/${name}`,
	name,
	kind: 'file',
	...(link ? { link } : {}),
});
/** リンク切れの行(Rust の local は辿れないので kind=symlink・link.broken=true)。 */
const broken = (parent: string, name: string, target: string): Row => ({
	uri: `${parent}/${name}`,
	name,
	kind: 'symlink',
	link: { target, broken: true },
});
/** ssh の一覧のリンクの行(`fs/ssh.rs`= kind=symlink・{ broken: false }・target 無し)。 */
const sshLink = (parent: string, name: string): Row => ({
	uri: `${parent}/${name}`,
	name,
	kind: 'symlink',
	link: { broken: false },
});

/**
 * 疑似 FS(root 直下のフォルダごとに一覧の形を変える)。
 * - `docs`    = [リンク切れ a.md, 普通 b.md]                       … (a)
 * - `mixed`   = [リンク切れ a.md, dir sub, binary pic.png, リンク切れ c.md, 普通 d.md] … (a) 同列
 * - `dead`    = [リンク切れ x.md]                                   … (b)
 * - `deadmix` = [リンク切れ x.md, リンク切れ y.md, dir sub, binary pic.png] … (b) 開けるものが無い
 * - `linked`  = [辿れるリンク ok.md(broken:false), 普通 z.md]      … (c)
 * - `remote`  = [ssh 形のリンク r.md(symlink・broken:false), 普通 z.md] … (c)
 * - `later`   = [普通 z.md, リンク切れ a.md]                         … 並び順(不変)
 * リンク切れの先は一覧できない(未登録= listDir が reject)。
 */
function folderFs(): Record<string, Row[]> {
	const docs = `${ROOT}/docs`;
	const mixed = `${ROOT}/mixed`;
	const dead = `${ROOT}/dead`;
	const deadmix = `${ROOT}/deadmix`;
	const linked = `${ROOT}/linked`;
	const remote = `${ROOT}/remote`;
	const later = `${ROOT}/later`;
	return {
		'file:///a': [d('file:///a', 'other'), d('file:///a', 'work')],
		[ROOT]: [
			d(ROOT, 'docs'),
			d(ROOT, 'mixed'),
			d(ROOT, 'dead'),
			d(ROOT, 'deadmix'),
			d(ROOT, 'linked'),
			d(ROOT, 'remote'),
			d(ROOT, 'later'),
			f(ROOT, 'README.md'),
		],
		[docs]: [broken(docs, 'a.md', 'missing.md'), f(docs, 'b.md')],
		[mixed]: [
			broken(mixed, 'a.md', 'missing.md'),
			d(mixed, 'sub'),
			f(mixed, 'pic.png'),
			broken(mixed, 'c.md', '../nowhere.md'),
			f(mixed, 'd.md'),
		],
		[`${mixed}/sub`]: [f(`${mixed}/sub`, 'inner.md')],
		[dead]: [broken(dead, 'x.md', 'gone.md')],
		[deadmix]: [
			broken(deadmix, 'x.md', 'gone.md'),
			broken(deadmix, 'y.md', 'gone-too.md'),
			d(deadmix, 'sub'),
			f(deadmix, 'pic.png'),
		],
		[`${deadmix}/sub`]: [f(`${deadmix}/sub`, 'inner.md')],
		[linked]: [f(linked, 'ok.md', { target: 'z.md', broken: false }), f(linked, 'z.md')],
		[remote]: [sshLink(remote, 'r.md'), f(remote, 'z.md')],
		[later]: [f(later, 'z.md'), broken(later, 'a.md', 'missing.md')],
	};
}

/** revealPath へ注入する deps 一式(すべて観測台)。`brokenLink` を含む。 */
function makeDeps(fs: Record<string, Row[]> = folderFs()) {
	const listDir = vi.fn(async (uri: string): Promise<Row[]> => {
		const v = fs[uri];
		if (v === undefined) throw new Error(`not a directory: ${uri}`);
		return v;
	});
	return {
		rootUri: ROOT,
		listDir,
		open: vi.fn(async (_uri: string) => {}),
		newWindow: vi.fn(async (_args: unknown): Promise<unknown> => 'vellis-2'),
		setExpandedDirs: vi.fn((_uris: string[]) => {}),
		getExpandedDirs: vi.fn((): string[] => []),
		setChildEntries: vi.fn((_uri: string, _entries: unknown) => {}),
		selectTreeItem: vi.fn((_uri: string) => {}),
		notFound: vi.fn(() => {}),
		brokenLink: vi.fn(() => {}),
		confirmDiscard: vi.fn(async () => true),
		detectFileType: vi.fn((name: string) => (/\.(png|zip|bin)$/i.test(name) ? 'binary' : 'markdown')),
		onNewWindowFailed: vi.fn((_err: unknown) => {}),
		homeDir: vi.fn(async (): Promise<string | null> => 'file:///Users/me'),
	};
}

type Deps = ReturnType<typeof makeDeps>;

/** `brokenLink` を省いた deps(既存の呼び出し元と同じ形)。 */
function makeDepsWithoutBrokenLink(fs: Record<string, Row[]> = folderFs()) {
	const { brokenLink: _omitted, ...rest } = makeDeps(fs);
	return rest;
}

/** listDir に渡された URI の並び。 */
function listedUris(deps: Pick<Deps, 'listDir'>): string[] {
	return deps.listDir.mock.calls.map((c) => c[0]);
}

/** 「メッセージを出さない」の観測(契約 1・2)。 */
function expectNoMessage(deps: Omit<Deps, 'brokenLink'> & { brokenLink?: Deps['brokenLink'] }) {
	expect(deps.notFound, 'notFound is not called').not.toHaveBeenCalled();
	if (deps.brokenLink) expect(deps.brokenLink, 'brokenLink is not called').not.toHaveBeenCalled();
	expect(deps.onNewWindowFailed).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// (a) 一覧の先頭がリンク切れ → 飛ばして次の開けるファイルを開く
// ---------------------------------------------------------------------------

describe('AC-70-追c (a): フォルダの一覧が [リンク切れ a.md, 普通 b.md] → open は b.md で1回', () => {
	it('docs → open(docs/b.md) 1回・a.md では呼ばれない・notFound / brokenLink は無し', async () => {
		const deps = makeDeps();

		await revealPath('docs', deps);

		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/docs/b.md`);
		expect(deps.open).not.toHaveBeenCalledWith(`${ROOT}/docs/a.md`);
		expectNoMessage(deps);
	});

	it('docs → 今までどおり展開(docs を含む)と confirmDiscard 1回を経て開く(フォルダの経路は不変)', async () => {
		const deps = makeDeps();

		await revealPath('docs', deps);

		expect(deps.confirmDiscard).toHaveBeenCalledTimes(1);
		expect(deps.setExpandedDirs).toHaveBeenCalledTimes(1);
		expect(deps.setExpandedDirs.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([`${ROOT}/docs`]));
		expect(deps.selectTreeItem).not.toHaveBeenCalled();
	});

	it('mixed(一覧=[リンク切れ, dir, binary, リンク切れ, 普通 d.md])→ dir / binary と同列に飛ばして d.md を開く', async () => {
		const deps = makeDeps();

		await revealPath('mixed', deps);

		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/mixed/d.md`);
		expectNoMessage(deps);
	});

	it('open がリンク切れの URI で失敗する環境でも例外を外へ出さない(リンク切れには open を呼ばないため)', async () => {
		const deps = makeDeps();
		// 実機と同じく、リンク切れを open すると I/O エラーになる(呼ばれないことが契約)。
		deps.open.mockImplementation(async (uri: string) => {
			if (uri === `${ROOT}/docs/a.md`) throw new Error('I/O error: No path was found.');
		});

		await expect(revealPath('docs', deps)).resolves.toBeUndefined();
		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/docs/b.md`);
	});

	it('サブフォルダには降りない(mixed/sub は listDir されない=不変)', async () => {
		const deps = makeDeps();

		await revealPath('mixed', deps);

		expect(listedUris(deps)).toEqual([ROOT, `${ROOT}/mixed`]);
		expect(listedUris(deps)).not.toContain(`${ROOT}/mixed/sub`);
	});
});

// ---------------------------------------------------------------------------
// (b) リンク切れしか無い → 展開と選択だけ(メッセージ無し)
// ---------------------------------------------------------------------------

describe('AC-70-追c (b): 一覧がリンク切れの .md だけ → open は呼ばれず、展開とフォルダの選択だけ', () => {
	it.each([
		['dead', '[リンク切れ x.md]'],
		['deadmix', '[リンク切れ x.md, リンク切れ y.md, dir sub, binary pic.png]'],
	])('%s(一覧=%s)→ setExpandedDirs 1回・selectTreeItem(フォルダ)1回・open / notFound / brokenLink / confirmDiscard は無し', async (folder) => {
		const deps = makeDeps();

		await revealPath(folder, deps);

		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.confirmDiscard).not.toHaveBeenCalled();
		expect(deps.setExpandedDirs).toHaveBeenCalledTimes(1);
		expect(deps.setExpandedDirs.mock.calls[0]?.[0]).toEqual(
			expect.arrayContaining([`${ROOT}/${folder}`])
		);
		expect(deps.selectTreeItem).toHaveBeenCalledTimes(1);
		expect(deps.selectTreeItem).toHaveBeenCalledWith(`${ROOT}/${folder}`);
		expectNoMessage(deps);
		expect(deps.newWindow).not.toHaveBeenCalled();
	});

	it('brokenLink を省いた deps でも notFound は呼ばれない(「無い」ではない)', async () => {
		const deps = makeDepsWithoutBrokenLink();

		await revealPath('dead', deps);

		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
		expect(deps.selectTreeItem).toHaveBeenCalledTimes(1);
		expect(deps.selectTreeItem).toHaveBeenCalledWith(`${ROOT}/dead`);
	});

	it('open がリンク切れの URI で失敗する環境でも例外を外へ出さない(open を呼ばないため)', async () => {
		const deps = makeDeps();
		deps.open.mockRejectedValue(new Error('I/O error: No path was found.'));

		await expect(revealPath('dead', deps)).resolves.toBeUndefined();
		expect(deps.open).not.toHaveBeenCalled();
		expectNoMessage(deps);
	});

	it('サブフォルダには降りない(deadmix/sub は listDir されない=不変)', async () => {
		const deps = makeDeps();

		await revealPath('deadmix', deps);

		expect(listedUris(deps)).toEqual([ROOT, `${ROOT}/deadmix`]);
	});
});

// ---------------------------------------------------------------------------
// (c) 切れていないリンク(broken:false)は最初の開けるファイルとして選ばれる
// ---------------------------------------------------------------------------

describe('AC-70-追c (c): link: { broken: false } の行は最初の開けるファイルとして選ばれる', () => {
	it('linked(一覧=[辿れるリンク ok.md, 普通 z.md])→ open は ok.md(リンクの URI)で1回', async () => {
		const deps = makeDeps();

		await revealPath('linked', deps);

		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/linked/ok.md`);
		expectNoMessage(deps);
	});

	it('remote(ssh 形= kind symlink・broken:false の r.md が先頭)→ open は r.md で1回(kind では飛ばさない)', async () => {
		const deps = makeDeps();

		await revealPath('remote', deps);

		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/remote/r.md`);
		expectNoMessage(deps);
	});

	it('later(一覧=[普通 z.md, リンク切れ a.md])→ 並び順の最初の開けるファイル z.md を開く(並び順は不変)', async () => {
		const deps = makeDeps();

		await revealPath('later', deps);

		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/later/z.md`);
		expectNoMessage(deps);
	});
});

// ---------------------------------------------------------------------------
// 不変(契約 3)— 追補b の経路と root 外のフォルダは今のまま
// ---------------------------------------------------------------------------

describe('AC-70-追c 不変(契約 3): 打った名前に当たった行のリンク切れ・root 外のフォルダは今のまま', () => {
	it('docs/a.md(当たった行がリンク切れ)→ 追補b のとおり brokenLink 1回・open は無し', async () => {
		const deps = makeDeps();

		await revealPath('docs/a.md', deps);

		expect(deps.brokenLink).toHaveBeenCalledTimes(1);
		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
		expect(deps.setExpandedDirs).not.toHaveBeenCalled();
		expect(deps.selectTreeItem).not.toHaveBeenCalled();
	});

	it('/a/other(root 外のフォルダ)→ 新しい窓(path: null・root=そのフォルダ)・中身は一覧しない', async () => {
		const deps = makeDeps();

		await revealPath('/a/other', deps);

		expect(deps.newWindow).toHaveBeenCalledTimes(1);
		expect(deps.newWindow).toHaveBeenCalledWith({ path: null, root: OUTSIDE, expandedDirs: [] });
		expect(listedUris(deps)).toEqual(['file:///a']);
		expect(deps.open).not.toHaveBeenCalled();
		expectNoMessage(deps);
	});
});
