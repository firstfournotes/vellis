/**
 * 要件#18 の受け入れテスト(requirements.md #18)— フロント層
 * 「ファイルツリーが展開中のサブディレクトリでもファイル/フォルダの追加・削除を
 *  自動反映する(現状は root 直下のみ自動反映され、サブディレクトリは reload が必要)」
 *
 * 契約(2026-08-16 由谷決定)のうち本ファイルの持ち場:
 * - ③ イベント受信時は該当ディレクトリのみ再一覧化し、当該ノードの子リストを更新
 *   (ペイロードの uri で対象ノードを特定)
 * - ④ 展開状態(expandedDirs=要件#10)は更新後も維持=受け入れ基準。
 *   監視中のサブディレクトリ自体が削除された場合は当該ノードごとツリーから除去。
 *   スクロール位置は対象外
 * - root 直下の既存挙動(directory_changed で entries 全差し替え)は不変
 *
 * 監視ライフサイクル(展開で subscribe・折りたたみ/root 切替/クローズで解除)は
 * Rust 側 src-tauri/tests/acceptance_req18.rs が判定する。イベントは既存
 * `directory_changed { root_uri, entries }` の流用で確定(同ファイルの設計判断)。
 *
 * 判定範囲(本ファイル): ツリー更新の純ロジックのみ。実装先 `src/lib/tree-refresh.ts`(新規)。
 * 実機での追加/削除の反映目視は人間ゲート・画面配線は reviewer 照合(末尾参照)。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * ```ts
 * // Entry 相当(stores/window-state.svelte の Entry と同形。モジュール単体で
 * // テストできるよう tree-refresh.ts 自身が型を持つ — re-export でも可)
 * export type TreeEntry = { uri: string; name: string; kind: 'file' | 'dir' | 'symlink' };
 *
 * // 画面が映すツリーの正規化ビュー。rootEntries=root 直下(windowState.entries 相当)、
 * // childEntries=展開で取得済みのサブディレクトリ → その直下一覧、
 * // expandedDirs=展開中集合(windowState.expandedDirs 相当=要件#10)。
 * export type ExplorerTree = {
 *   rootUri: string;
 *   rootEntries: TreeEntry[];
 *   childEntries: Record<string, TreeEntry[]>;
 *   expandedDirs: string[];
 * };
 *
 * // directory_changed 1件をツリーへ適用する純関数(event.uri = ペイロード root_uri)。
 * export function applyDirectoryChanged(
 *   tree: ExplorerTree,
 *   event: { uri: string; entries: TreeEntry[] }
 * ): ExplorerTree;
 * ```
 *
 * 適用規則(本テストが固定する意味論):
 * 1. event.uri === rootUri → rootEntries を event.entries へ全差し替え(既存挙動)。
 * 2. event.uri が expandedDirs か childEntries に載っている → childEntries[event.uri]
 *    だけを event.entries へ差し替え(他キー・rootEntries・expandedDirs は不変)。
 *    展開済みで未取得(childEntries にキーなし)でも採用する — 購読は展開に紐付くため。
 * 3. 1・2 の適用時、event.uri 直下として追跡中の URI(expandedDirs / childEntries の
 *    キーのうち親が event.uri のもの)が event.entries に dir として存在しなくなって
 *    いたら、その URI と配下(セグメント境界の前方一致)を expandedDirs と
 *    childEntries から除去する=「当該ノードごとツリーから除去」の状態面。
 *    描画上の消滅は親一覧の差し替えで従う。
 * 4. どれでもない URI のイベントは無視(同値のツリーを返す)。
 * 5. 純関数: 入力 tree / event を破壊しない。
 * 6. URI 比較は backend の canonical 表記(Uri.raw)の完全一致(既存 +page.svelte の
 *    directory_changed ハンドラと同じ前提)。末尾スラッシュ等の正規化はスコープ外。
 *
 * 折りたたみ済みで childEntries にだけ残るキーの更新は規則2で許容される(監視解除後は
 * イベント自体が届かない前提なので、通常は起きない)。除去に伴う監視解除の発火は
 * 配線側の持ち場(reviewer 照合)。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - ExplorerItem の子リスト($state children)の外部化 or 本純関数の結果を映す配線
 *   (形は実装裁量。expandedDirs=windowState 維持は要件#10 の既存契約)
 * - 展開(loadChildren)で subscribe・折りたたみで unsubscribe を backend へ届ける配線
 * - root 切替・ウィンドウクローズでサブディレクトリ監視が解除される配線(Rust 側 clear/Drop)
 * - ノード除去(規則3)時に当該ディレクトリの監視も解除されること
 * - ssh リモート root では登録しないこと(契約⑤=対象外)・file_removed→clearDocument 不変
 */
import { describe, expect, test } from 'vitest';

import { applyDirectoryChanged, type ExplorerTree, type TreeEntry } from './tree-refresh';

// backend の URI 表現に合わせた生文字列(percent-encode なし。reload-state と同じ前提)
const ROOT = 'file:///Users/a/work';
const SUB = `${ROOT}/notes`;
const INNER = `${SUB}/archive`; // SUB の子(孫ディレクトリ)
const DOCS = `${ROOT}/docs`;
const DOCS2 = `${ROOT}/docs2`; // DOCS とセグメント境界だけ違う兄弟

const dir = (uri: string): TreeEntry => ({
	uri,
	name: uri.slice(uri.lastIndexOf('/') + 1),
	kind: 'dir'
});
const file = (uri: string): TreeEntry => ({
	uri,
	name: uri.slice(uri.lastIndexOf('/') + 1),
	kind: 'file'
});

/** SUB(展開・取得済み)と DOCS(未展開)を持つ標準ツリー。 */
function baseTree(): ExplorerTree {
	return {
		rootUri: ROOT,
		rootEntries: [dir(SUB), dir(DOCS), file(`${ROOT}/readme.md`)],
		childEntries: {
			[SUB]: [file(`${SUB}/plan.md`), dir(INNER)]
		},
		expandedDirs: [SUB]
	};
}

describe('サブディレクトリのイベント — 該当ノードの子リストだけ更新(規則2)', () => {
	test('展開中サブディレクトリの directory_changed で childEntries[uri] だけ差し替わる', () => {
		const tree = baseTree();
		const relisted = [file(`${SUB}/plan.md`), file(`${SUB}/new.md`), dir(INNER)];
		const next = applyDirectoryChanged(tree, { uri: SUB, entries: relisted });

		expect(next.childEntries[SUB]).toEqual(relisted);
		expect(next.rootEntries).toEqual(tree.rootEntries);
		expect(next.rootUri).toBe(ROOT);
	});

	test('削除の再一覧も同じ経路で映る(消えたファイルが子リストから消える)', () => {
		const tree = baseTree();
		const next = applyDirectoryChanged(tree, { uri: SUB, entries: [dir(INNER)] });
		expect(next.childEntries[SUB]).toEqual([dir(INNER)]);
	});

	test('展開状態(expandedDirs)は更新後も維持される=受け入れ基準④', () => {
		const tree = baseTree();
		const next = applyDirectoryChanged(tree, {
			uri: SUB,
			entries: [file(`${SUB}/new.md`), dir(INNER)]
		});
		expect(next.expandedDirs).toEqual([SUB]);
	});

	test('他の取得済みサブディレクトリの子リストは巻き込まれない', () => {
		const tree = baseTree();
		tree.childEntries[DOCS] = [file(`${DOCS}/spec.md`)];
		tree.expandedDirs = [SUB, DOCS];

		const next = applyDirectoryChanged(tree, { uri: SUB, entries: [] });
		expect(next.childEntries[DOCS]).toEqual([file(`${DOCS}/spec.md`)]);
		expect(next.expandedDirs).toEqual([SUB, DOCS]);
	});

	test('展開済みで未取得のディレクトリへのイベントも子リストとして採用される', () => {
		// 展開直後、list_dir の返る前に監視イベントが先着しても取りこぼさない。
		const tree = baseTree();
		tree.expandedDirs = [SUB, DOCS]; // DOCS は childEntries にキーなし
		const next = applyDirectoryChanged(tree, {
			uri: DOCS,
			entries: [file(`${DOCS}/spec.md`)]
		});
		expect(next.childEntries[DOCS]).toEqual([file(`${DOCS}/spec.md`)]);
	});
});

describe('root 直下 — 既存挙動の維持', () => {
	test('root の directory_changed は rootEntries の全差し替え(従来どおり)', () => {
		const tree = baseTree();
		const relisted = [dir(SUB), file(`${ROOT}/added.md`)];
		const next = applyDirectoryChanged(tree, { uri: ROOT, entries: relisted });
		expect(next.rootEntries).toEqual(relisted);
	});

	test('root の更新後も、生き残ったサブディレクトリの展開と子リストは維持される', () => {
		const tree = baseTree();
		const next = applyDirectoryChanged(tree, {
			uri: ROOT,
			entries: [dir(SUB), dir(DOCS), file(`${ROOT}/added.md`)]
		});
		expect(next.expandedDirs).toEqual([SUB]);
		expect(next.childEntries[SUB]).toEqual(baseTree().childEntries[SUB]);
	});
});

describe('監視中サブディレクトリ自体の削除 — ノードごと除去(規則3)', () => {
	test('root の一覧から消えた展開中ディレクトリは expandedDirs と childEntries から除去される', () => {
		const tree = baseTree();
		// SUB が entries から消えた root の再一覧(削除された)
		const next = applyDirectoryChanged(tree, {
			uri: ROOT,
			entries: [dir(DOCS), file(`${ROOT}/readme.md`)]
		});
		expect(next.expandedDirs).not.toContain(SUB);
		expect(next.childEntries).not.toHaveProperty(SUB);
	});

	test('除去は配下へカスケードする(孫ディレクトリの展開・子リストも除去)', () => {
		const tree = baseTree();
		tree.expandedDirs = [SUB, INNER];
		tree.childEntries[INNER] = [file(`${INNER}/old.md`)];

		const next = applyDirectoryChanged(tree, { uri: ROOT, entries: [dir(DOCS)] });
		expect(next.expandedDirs).toEqual([]);
		expect(next.childEntries).toEqual({});
	});

	test('セグメント境界で判定する(docs の消滅で docs2 を巻き添えにしない)', () => {
		const tree = baseTree();
		tree.rootEntries = [dir(DOCS), dir(DOCS2)];
		tree.expandedDirs = [DOCS, DOCS2];
		tree.childEntries = {
			[DOCS]: [file(`${DOCS}/spec.md`)],
			[DOCS2]: [file(`${DOCS2}/memo.md`)]
		};

		const next = applyDirectoryChanged(tree, { uri: ROOT, entries: [dir(DOCS2)] });
		expect(next.expandedDirs).toEqual([DOCS2]);
		expect(next.childEntries).toEqual({ [DOCS2]: [file(`${DOCS2}/memo.md`)] });
	});

	test('root 以外の親のイベントでも同様に除去される(SUB の一覧から孫が消えた)', () => {
		const tree = baseTree();
		tree.expandedDirs = [SUB, INNER];
		tree.childEntries[INNER] = [file(`${INNER}/old.md`)];

		const next = applyDirectoryChanged(tree, {
			uri: SUB,
			entries: [file(`${SUB}/plan.md`)] // INNER が消えた再一覧
		});
		expect(next.childEntries[SUB]).toEqual([file(`${SUB}/plan.md`)]);
		expect(next.expandedDirs).toEqual([SUB]);
		expect(next.childEntries).not.toHaveProperty(INNER);
	});

	test('ファイルへの置き換わり(dir でなくなった)もノード除去として扱う', () => {
		// 同名エントリが残っていても kind が dir でなければ子は持てない。
		const tree = baseTree();
		const next = applyDirectoryChanged(tree, {
			uri: ROOT,
			entries: [file(SUB), dir(DOCS)]
		});
		expect(next.expandedDirs).not.toContain(SUB);
		expect(next.childEntries).not.toHaveProperty(SUB);
	});
});

describe('無関係なイベントと純関数性', () => {
	test('root でも追跡中でもない URI のイベントは無視される(同値のツリー)', () => {
		const tree = baseTree();
		const next = applyDirectoryChanged(tree, {
			uri: 'file:///Users/a/other',
			entries: [file('file:///Users/a/other/x.md')]
		});
		expect(next).toEqual(baseTree());
	});

	test('入力の tree と event を破壊しない(純関数)', () => {
		const tree = baseTree();
		const event = { uri: SUB, entries: [file(`${SUB}/new.md`)] };
		const treeSnapshot = JSON.parse(JSON.stringify(tree));
		const eventSnapshot = JSON.parse(JSON.stringify(event));

		applyDirectoryChanged(tree, event);

		expect(tree).toEqual(treeSnapshot);
		expect(event).toEqual(eventSnapshot);
	});
});
