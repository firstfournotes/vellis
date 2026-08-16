/**
 * `directory_changed` をエクスプローラのツリーへ適用する純関数(要件#18)。
 *
 * root 直下も展開中サブディレクトリも、backend からは同じ
 * `directory_changed { root_uri, entries }` で届く(監視の登録先が違うだけ)。
 * どちらの一覧なのかを決めて当該ノードの子だけ差し替えるのがここの仕事で、
 * 監視の登録・解除と画面への反映は呼び出し側(`+page.svelte`)が持つ。
 *
 * ツリーを丸ごと入れ替えないのは、展開状態(要件#10)と取得済みの子を残すため。
 * 消えたディレクトリだけは、再一覧に載っていないことを根拠に配下ごと落とす。
 */

/** `stores/window-state.svelte` の `Entry` と同形(モジュール単体で試せるよう再定義)。 */
export type TreeEntry = { uri: string; name: string; kind: 'file' | 'dir' | 'symlink' };

/**
 * 画面が映すツリーの正規化ビュー。`rootEntries` は root 直下
 * (`windowState.entries`)、`childEntries` は展開で取得済みのサブディレクトリ →
 * その直下一覧、`expandedDirs` は展開中集合(要件#10)。
 */
export type ExplorerTree = {
	rootUri: string;
	rootEntries: TreeEntry[];
	childEntries: Record<string, TreeEntry[]>;
	expandedDirs: string[];
};

/** `child` が `parent` の直下(1階層だけ下)か。URI はセグメント境界で見る。 */
function isDirectChild(parent: string, child: string): boolean {
	if (!child.startsWith(`${parent}/`)) return false;
	return !child.slice(parent.length + 1).includes('/');
}

/** `uri` が `ancestor` 自身か、その配下か。 */
function isSelfOrDescendant(ancestor: string, uri: string): boolean {
	return uri === ancestor || uri.startsWith(`${ancestor}/`);
}

/**
 * `directory_changed` 1件をツリーへ適用する(`event.uri` = ペイロードの `root_uri`)。
 *
 * - `event.uri` が root なら `rootEntries` を全差し替え(従来の挙動)。
 * - 追跡中(展開中 or 取得済み)のサブディレクトリなら、その子リストだけ差し替える。
 *   展開直後で未取得のディレクトリにも採用する — 購読は展開に紐付くので、
 *   `list_dir` の応答より監視イベントが先着しても取りこぼさない。
 * - どちらでもない URI は無視する。
 *
 * 差し替えたディレクトリの直下として追跡していた URI が、新しい一覧に
 * ディレクトリとして無くなっていたら、その URI と配下を追跡から外す
 * (=そのノードごとツリーから消える)。URI 比較は backend の canonical 表記の
 * 完全一致で、末尾スラッシュ等の正規化はしない。
 */
export function applyDirectoryChanged(
	tree: ExplorerTree,
	event: { uri: string; entries: TreeEntry[] }
): ExplorerTree {
	const isRoot = event.uri === tree.rootUri;
	const isTrackedDir =
		tree.expandedDirs.includes(event.uri) ||
		Object.prototype.hasOwnProperty.call(tree.childEntries, event.uri);

	const next: ExplorerTree = {
		rootUri: tree.rootUri,
		rootEntries: tree.rootEntries,
		childEntries: { ...tree.childEntries },
		expandedDirs: [...tree.expandedDirs]
	};
	if (!isRoot && !isTrackedDir) return next;

	const entries = [...event.entries];
	if (isRoot) next.rootEntries = entries;
	else next.childEntries[event.uri] = entries;

	// 再一覧に「ディレクトリとして」載っているものだけが子を持てる。同名の
	// ファイルへ置き換わった場合も、ディレクトリとしては消えたものとして扱う。
	const survivingDirs = new Set(
		entries.filter((e) => e.kind === 'dir').map((e) => e.uri)
	);
	const tracked = new Set([...next.expandedDirs, ...Object.keys(next.childEntries)]);
	const removed = [...tracked].filter(
		(uri) => isDirectChild(event.uri, uri) && !survivingDirs.has(uri)
	);
	if (removed.length === 0) return next;

	const isRemoved = (uri: string) => removed.some((r) => isSelfOrDescendant(r, uri));
	next.expandedDirs = next.expandedDirs.filter((uri) => !isRemoved(uri));
	next.childEntries = Object.fromEntries(
		Object.entries(next.childEntries).filter(([uri]) => !isRemoved(uri))
	);
	return next;
}
