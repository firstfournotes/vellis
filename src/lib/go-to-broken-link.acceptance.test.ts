/**
 * 要件#70 追補b の受け入れテスト(docs/requirements/req-70.md「追補b(2026-10-06・backlog 305)」)
 * — Go to Path でリンク切れを指したとき(AC-70-追b (a)〜(f)。unit プロジェクト・
 * `revealPath` の deps をモックで組む=go-to-path.acceptance.test.ts と同じ家風)
 *
 * 今は、リンク切れを指すと `open` が `I/O error: No path was found. …` で失敗し、
 * `+page.svelte` の `alert("Could not go to the path: …")` が生のエラー文のまま出る。
 * 由谷の決定(2026-10-06): alert を出さず、Go to バーの表示欄にリンク切れと分かる文言を出す。
 *
 * ## 契約(追補b)— implementer はこれに従う
 * 1. Go to が辿る一覧(`listDir`)の中で、打った名前に当たった行が**リンク切れ**
 *    (`link.broken === true`)なら、その時点で止めて `brokenLink()` を1回呼ぶ。root 配下
 *    (途中のセグメントでも最後のセグメントでも)・root 外(親の一覧で当たった行)の両方。
 *    `open`・`newWindow`・`confirmDiscard` を呼ばず、展開・選択(`setExpandedDirs` /
 *    `selectTreeItem`)も変えない(`setChildEntries` は降りる途中で覚えたぶんはそのまま=判定しない)
 * 2. 文言 `GO_TO_BROKEN_LINK_MESSAGE` = `Broken symbolic link`(値固定・英語=要件51)
 * 3. `GoToDeps` に `brokenLink(): void` を足す(**省略可**。省略されたときは `notFound()` を呼ぶ)
 * 4. 不変: リンク切れでない行(`broken:false` を含む)の扱い・「無い」の文言・ドット経路・ssh
 *
 * `listDir` が返す行には `link: { target?: string; broken: boolean }` が付く(Rust の `Entry` と同じ形)。
 * リンク切れの行の `kind` は Rust の `fs/local.rs` と同じく `'symlink'`(辿る `metadata` が失敗した行)。
 *
 * ## 判定(AC-70-追b)
 * - (a) root 配下のリンク切れのファイル(最後のセグメント)→ `brokenLink` 1回・`open`・`newWindow`・
 *   `confirmDiscard`・`notFound`・`setExpandedDirs`・`selectTreeItem` は呼ばれない
 * - (b) 途中のセグメントがリンク切れでも同じ
 * - (c) root 外のリンク切れ(親の一覧で `link.broken`)でも同じ
 * - (d) `brokenLink` を省いた deps では `notFound` が1回
 * - (e) リンクだが切れていない行(`broken:false`)は今までどおり開く
 * - (f) `GO_TO_BROKEN_LINK_MESSAGE === 'Broken symbolic link'`
 * - (g)(h) は `src/components/GoToBar.brokenlink.wiring.test.ts`
 *
 * ## 判断の記録(test-writer 2026-10-06)
 * - (b) の「その時点で止めて」は、リンク切れの行より先(その行の URI)を `listDir` しないことで判定する
 * - 名前の照合は既存の契約④のまま(完全一致→大文字小文字無視)なので、大文字小文字違いで
 *   当たったリンク切れの行も「当たった行」として (a) に含める
 */
import { describe, expect, it, vi } from 'vitest';

import * as goToPath from './go-to-path';
import { revealPath } from './go-to-path';

/** root は file:///a/work(go-to-path.acceptance.test.ts と同じ前提)。 */
const ROOT = 'file:///a/work';
const OUTSIDE = 'file:///a/other';

type Link = { target?: string; broken: boolean };
type Row = { uri: string; name: string; kind: 'dir' | 'file' | 'symlink'; link?: Link };

const d = (parent: string, name: string, link?: Link): Row => ({
	uri: `${parent}/${name}`,
	name,
	kind: 'dir',
	...(link ? { link } : {}),
});
const f = (parent: string, name: string, link?: Link): Row => ({
	uri: `${parent}/${name}`,
	name,
	kind: 'file',
	...(link ? { link } : {}),
});
/** リンク切れの行(Rust は辿れないので kind=symlink・link.broken=true)。 */
const broken = (parent: string, name: string, target: string): Row => ({
	uri: `${parent}/${name}`,
	name,
	kind: 'symlink',
	link: { target, broken: true },
});

/**
 * 疑似 FS。root 配下に
 * - `gone.md`(リンク切れのファイル)・`deaddir`(リンク切れ=フォルダを指していた)
 * - `ok-link.md`(辿れるファイルのリンク)・`dirlink`(辿れるフォルダのリンク)
 * - `a/stale.md`(2階層目のリンク切れ)
 * root 外 /a/other に `gone-out.md`(リンク切れ)・`ok-out.md`(辿れるリンク)・`x.md`。
 * リンク切れの先(`deaddir` の中身)は一覧できない(未登録=listDir が reject)。
 */
function brokenFs(): Record<string, Row[] | Error> {
	return {
		'file:///a': [d('file:///a', 'other'), d('file:///a', 'work')],
		[ROOT]: [
			d(ROOT, 'a'),
			d(ROOT, 'dirlink', { target: 'a', broken: false }),
			broken(ROOT, 'deaddir', 'removed-dir'),
			broken(ROOT, 'gone.md', 'missing.md'),
			f(ROOT, 'ok-link.md', { target: 'README.md', broken: false }),
			f(ROOT, 'README.md'),
		],
		[`${ROOT}/a`]: [f(`${ROOT}/a`, 'c.md'), broken(`${ROOT}/a`, 'stale.md', '../nowhere.md')],
		[`${ROOT}/dirlink`]: [f(`${ROOT}/dirlink`, 'inner.md')],
		[OUTSIDE]: [
			broken(OUTSIDE, 'gone-out.md', '/nowhere/x.md'),
			f(OUTSIDE, 'ok-out.md', { target: 'x.md', broken: false }),
			f(OUTSIDE, 'x.md'),
		],
	};
}

/** revealPath へ注入する deps 一式(すべて観測台)。`brokenLink` を含む。 */
function makeDeps(fs: Record<string, Row[] | Error> = brokenFs()) {
	const listDir = vi.fn(async (uri: string): Promise<Row[]> => {
		const v = fs[uri];
		if (v === undefined) throw new Error(`not a directory: ${uri}`);
		if (v instanceof Error) throw v;
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
function makeDepsWithoutBrokenLink(fs: Record<string, Row[] | Error> = brokenFs()) {
	const { brokenLink: _omitted, ...rest } = makeDeps(fs);
	return rest;
}

/** 「何も動かさない」の観測(契約(追補b)1)。brokenLink / notFound の回数は呼び出し側で見る。 */
function expectNothingMoved(deps: Omit<Deps, 'brokenLink'>) {
	expect(deps.open, 'open is not called').not.toHaveBeenCalled();
	expect(deps.newWindow, 'newWindow is not called').not.toHaveBeenCalled();
	expect(deps.confirmDiscard, 'confirmDiscard is not called').not.toHaveBeenCalled();
	expect(deps.setExpandedDirs, 'setExpandedDirs is not called').not.toHaveBeenCalled();
	expect(deps.selectTreeItem, 'selectTreeItem is not called').not.toHaveBeenCalled();
	expect(deps.onNewWindowFailed).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// (a) root 配下・最後のセグメントがリンク切れ
// ---------------------------------------------------------------------------

describe('AC-70-追b (a): root 配下のリンク切れのファイル(最後のセグメント)', () => {
	it.each([
		['gone.md', 'root 直下'],
		['a/stale.md', '2階層目'],
		['/a/work/gone.md', 'root 配下の絶対パス'],
		['GONE.md', '大文字小文字違いで当たった行(契約④の照合)'],
	])('%s(%s)→ brokenLink 1回・notFound / open / newWindow / confirmDiscard / 展開 / 選択は無し', async (input) => {
		const deps = makeDeps();

		await revealPath(input, deps);

		expect(deps.brokenLink).toHaveBeenCalledTimes(1);
		expect(deps.notFound).not.toHaveBeenCalled();
		expectNothingMoved(deps);
	});

	it('例外を外へ出さない(+page.svelte の alert に落ちない)', async () => {
		const deps = makeDeps();
		// open が呼ばれたら今の不具合と同じく失敗させる(呼ばれないことが契約)。
		deps.open.mockRejectedValue(new Error('I/O error: No path was found.'));

		await expect(revealPath('gone.md', deps)).resolves.toBeUndefined();
		expect(deps.brokenLink).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// (b) 途中のセグメントがリンク切れ
// ---------------------------------------------------------------------------

describe('AC-70-追b (b): 途中のセグメントがリンク切れ', () => {
	it('deaddir/x.md → brokenLink 1回・notFound は無し・何も動かさない', async () => {
		const deps = makeDeps();

		await revealPath('deaddir/x.md', deps);

		expect(deps.brokenLink).toHaveBeenCalledTimes(1);
		expect(deps.notFound).not.toHaveBeenCalled();
		expectNothingMoved(deps);
	});

	it('その時点で止める — リンク切れの行より先(deaddir)を listDir しない', async () => {
		const deps = makeDeps();

		await revealPath('deaddir/sub/x.md', deps);

		expect(deps.listDir.mock.calls.map((c) => c[0])).not.toContain(`${ROOT}/deaddir`);
		expect(deps.brokenLink).toHaveBeenCalledTimes(1);
		expect(deps.notFound).not.toHaveBeenCalled();
		expectNothingMoved(deps);
	});
});

// ---------------------------------------------------------------------------
// (c) root 外のリンク切れ
// ---------------------------------------------------------------------------

describe('AC-70-追b (c): root 外のリンク切れ(親の一覧で link.broken)', () => {
	it('/a/other/gone-out.md → brokenLink 1回・newWindow / notFound は無し・今の窓は不変', async () => {
		const deps = makeDeps();

		await revealPath('/a/other/gone-out.md', deps);

		expect(deps.brokenLink).toHaveBeenCalledTimes(1);
		expect(deps.notFound).not.toHaveBeenCalled();
		expectNothingMoved(deps);
	});

	it('URI 形(file:///a/other/gone-out.md)でも同じ', async () => {
		const deps = makeDeps();

		await revealPath('file:///a/other/gone-out.md', deps);

		expect(deps.brokenLink).toHaveBeenCalledTimes(1);
		expect(deps.notFound).not.toHaveBeenCalled();
		expectNothingMoved(deps);
	});
});

// ---------------------------------------------------------------------------
// (d) brokenLink を省いた deps では notFound
// ---------------------------------------------------------------------------

describe('AC-70-追b (d): brokenLink を省いた deps では notFound が1回(既存の呼び出し元との互換)', () => {
	it.each([
		['gone.md', 'root 配下・最後のセグメント'],
		['deaddir/x.md', 'root 配下・途中のセグメント'],
		['/a/other/gone-out.md', 'root 外'],
	])('%s(%s)→ notFound 1回・何も動かさない', async (input) => {
		const deps = makeDepsWithoutBrokenLink();

		await revealPath(input, deps);

		expect(deps.notFound).toHaveBeenCalledTimes(1);
		expectNothingMoved(deps);
	});
});

// ---------------------------------------------------------------------------
// (e) 切れていないリンク(broken:false)は今までどおり
// ---------------------------------------------------------------------------

describe('AC-70-追b (e): リンクだが切れていない行(broken:false)は今までどおり', () => {
	it('ok-link.md → open(リンクの URI)1回・brokenLink / notFound は無し', async () => {
		const deps = makeDeps();

		await revealPath('ok-link.md', deps);

		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/ok-link.md`);
		expect(deps.brokenLink).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
	});

	it('dirlink/inner.md(途中が辿れるフォルダのリンク)→ 降りて open・祖先 dirlink を展開', async () => {
		const deps = makeDeps();

		await revealPath('dirlink/inner.md', deps);

		expect(deps.open).toHaveBeenCalledTimes(1);
		expect(deps.open).toHaveBeenCalledWith(`${ROOT}/dirlink/inner.md`);
		const expanded = deps.setExpandedDirs.mock.calls.at(-1)?.[0] ?? [];
		expect(expanded).toContain(`${ROOT}/dirlink`);
		expect(deps.brokenLink).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
	});

	it('root 外の切れていないリンク(/a/other/ok-out.md)→ 新ウィンドウ1回・brokenLink / notFound は無し', async () => {
		const deps = makeDeps();

		await revealPath('/a/other/ok-out.md', deps);

		expect(deps.newWindow).toHaveBeenCalledTimes(1);
		expect(deps.newWindow).toHaveBeenCalledWith({
			path: `${OUTSIDE}/ok-out.md`,
			root: OUTSIDE,
			expandedDirs: [],
		});
		expect(deps.open).not.toHaveBeenCalled();
		expect(deps.brokenLink).not.toHaveBeenCalled();
		expect(deps.notFound).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// (f) 文言
// ---------------------------------------------------------------------------

describe('AC-70-追b (f): GO_TO_BROKEN_LINK_MESSAGE(値固定・英語=要件51)', () => {
	it("GO_TO_BROKEN_LINK_MESSAGE === 'Broken symbolic link'", () => {
		expect((goToPath as unknown as Record<string, unknown>).GO_TO_BROKEN_LINK_MESSAGE).toBe('Broken symbolic link');
	});

	it('「無い」の文言は今のまま(File or folder not found)', () => {
		expect(goToPath.GO_TO_NOT_FOUND_MESSAGE).toBe('File or folder not found');
	});
});
