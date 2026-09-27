/**
 * 利用者設定(要件#65)のフロント側。
 *
 * 除外の設定を読むのも、当てる(glob の照合)のも Rust の 1 か所だけ(契約7)。
 * フロントが持つのは「Vellis で設定ファイルを保存した」知らせ(`settings_changed`)を
 * 受けて、ツリーを読み直す手順だけ。読み直しは既存の `list_dir` と、監視の
 * `directory_changed` と同じ当て方(`applyDirectoryEvent`)を通すので、展開状態は保つ。
 * 配線(listen・invoke)は `+page.svelte` の持ち場で、このファイルは Tauri に触れない。
 */

/** 設定の保存を全窓へ知らせるイベント名。Rust の `settings::SETTINGS_CHANGED_EVENT` と同綴り。 */
export const SETTINGS_CHANGED_EVENT = 'settings_changed';

/**
 * ツリーの読み直しに要る入出力。`listDir` は一覧を取る(`list_dir` command)・
 * `apply` はその一覧をツリーへ当てる(`applyDirectoryEvent`)。
 */
export type TreeReloadIo<E> = {
	listDir: (uri: string) => Promise<E[]>;
	apply: (uri: string, entries: E[]) => void;
};

/** 一覧を取る。失敗(reject も同期の throw も)は null にして外へ出さない。 */
function fetchListing<E>(io: TreeReloadIo<E>, uri: string): Promise<E[] | null> {
	try {
		return io.listDir(uri).then(
			(entries) => entries,
			() => null
		);
	} catch {
		return Promise.resolve(null);
	}
}

/**
 * root と展開中のフォルダを読み直してツリーへ当てる(契約7)。
 *
 * - root が空(未選択)なら何もしない
 * - 一覧は root → 展開中のフォルダの順にまとめて取りに行き(ssh でも待ちを重ねない)、
 *   当てるのも同じ順(root を先に当てるので、除外で消えたフォルダは `apply` 側で
 *   追跡から外れ、その後に届いた一覧は無視される)
 * - 1 つが失敗しても他は当てる。例外は外へ出さない
 * - `expandedDirs` は変更しない(呼び出し時点の写しで回る)
 */
export async function reloadTree<E>(
	rootUri: string,
	expandedDirs: readonly string[],
	io: TreeReloadIo<E>
): Promise<void> {
	if (rootUri === '') return;
	const uris = [rootUri, ...expandedDirs];
	const listings = uris.map((uri) => fetchListing(io, uri));
	for (let i = 0; i < uris.length; i++) {
		const entries = await listings[i];
		if (entries === null) continue;
		try {
			io.apply(uris[i], entries);
		} catch {
			// 当てられなかった一覧は捨てる(残りは当てる)。
		}
	}
}
