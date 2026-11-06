/**
 * 開いているファイルとツリーを読み直す(要件#80)。
 *
 * - **Reload File**(契約 1・3・5・6・10・11)= 押した窓が開いている文書を、開いたときと同じ
 *   command(`open_document` / `open_binary_document`)でもう一度開く。Rust は新しい文書
 *   セッションを張ってから差し替えるので、中身の読み直しと同時に監視も張り直される。
 *   あわせてツリー(root と展開中のフォルダ)も要件#65 の `reloadTree` で読み直す。
 *   入口は View ▸ Reload File(Command + R)・本文の右クリック・Explorer のファイルの行の
 *   右クリックの 3 つで、どれもページが 1 つ作る `createFileReloader` の `reload` を呼ぶ
 * - **Reload Folder**(契約 14・15)= ツリーの一覧だけを読み直す。入口はフォルダの行と
 *   ツリーの空白の右クリックで、Explorer が 1 つ作る `createFolderReloader` の `reload` を呼ぶ
 *
 * どちらの実行列も依存をすべて注入で受け取り、このファイルは Tauri の command に触れない
 * (`windowState` / `invoke` / `alert` を渡すのはページと Explorer の持ち場)。触れるのは
 * メニューの購読(`$lib/events` の listen)だけ。
 */
import { listen } from '$lib/events';
import { readsAsText } from '$lib/image-viewing';

/** View ▸ Reload File が前面の窓へ送るイベント名。Rust の `menu::MENU_RELOAD_FILE_EVENT` と同綴り。 */
export const MENU_RELOAD_FILE_EVENT = 'menu_reload_file';

/**
 * 項目名(要件#51=英語)。View メニュー(Rust の `menu.rs` と同じ字面)・本文の右クリック・
 * Explorer のファイルの行の 3 か所が同じ名前を使う(契約 1)。「…」は付けない。
 */
export const RELOAD_FILE_LABEL = 'Reload File';

/** フォルダの行とツリーの空白の項目名(契約 14)。`context-menu.ts` の右クリックの項目が使う。 */
export const RELOAD_FOLDER_LABEL = 'Reload Folder';

/**
 * 失敗の理由。Rust のエラーは文字列で届くのでそのまま挟む(要件#51 の素通し)。
 * Error で届いたときは `Error: ` を付けずに本文だけを挟む。
 */
function reasonOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Reload File でファイルを読めなかったときの alert(契約 6)。 */
export function reloadFileFailedMessage(err: unknown): string {
	return `Could not reload the file: ${reasonOf(err)}`;
}

/** Reload Folder で一覧を読めなかったときの alert(契約 15)。何件失敗しても 1 回だけ出す。 */
export function reloadFolderFailedMessage(err: unknown): string {
	return `Could not reload the folder: ${reasonOf(err)}`;
}

// ---------------------------------------------------------------------------
// Reload File の実行列(契約 3・5・6・10・11)
// ---------------------------------------------------------------------------

export type ReloadOutcome =
	/** 文書の無い窓((q))。ファイルもツリーも読まない */
	| 'no-document'
	/** 押した行が今の文書でない(契約 9 の安全網)。何もしない */
	| 'not-open'
	/** 読み直しの最中(契約 11)。重ねて読まない */
	| 'busy'
	/** 未保存の確認で取り消した(契約 5)。ファイルもツリーも読まない */
	| 'cancelled'
	/** ファイルを開けなかった(契約 6)。知らせて表示はそのまま */
	| 'failed'
	/** 読んでいる間に外部変更が当たった・文書が替わった(契約 11)。結果を当てない */
	| 'stale'
	| 'reloaded';

export type FileReloaderDeps<Doc> = {
	/** 今の文書の URI(無ければ null)。 */
	current: () => string | null;
	/** 未保存の編集の確認(要件#48 の `confirmDiscardEdits`=契約 5)。 */
	confirm: () => Promise<boolean>;
	/** 開いたときと同じ command で開く(`openForDisplay`)。 */
	open: (uri: string) => Promise<Doc>;
	/** テキスト系の結果を当てる(`windowState.applyReloadedText`=ツリーの選択を変えない当て方=要件#80 追補a)。 */
	applyText: (doc: Doc) => void;
	/** バイナリ系の表示の版数を 1 つ進める(`binary_file_changed` が届いたときと同じ)。 */
	bumpBinary: (uri: string) => void;
	/** 失敗の知らせ(alert)。 */
	notify: (message: string) => void;
	/** 今の文書に外部変更が当たった回数(`file_changed` の apply・`binary_file_changed` で進む)。 */
	changeStamp: () => number;
	/** ツリーの読み直し(要件#65 の `reloadTree`)。失敗は黙って飲む(契約 10)。 */
	refreshTree: () => Promise<void>;
};

/** 失敗(reject も同期の throw も)を外へ出さずに待つ。 */
async function settleQuietly(run: () => Promise<unknown>): Promise<void> {
	try {
		await run();
	} catch {
		// ツリーの失敗は黙って前の一覧を残す(契約 10 の (o))。
	}
}

/**
 * Reload File の実行列。ページが 1 つ作り、3 つの入口が同じ `reload` を呼ぶ。
 *
 * `reload(target)` の `target` は Explorer の行の URI(省略・null=今の文書)。
 *
 * 1. 文書が無ければ何もしない(`'no-document'`)。`target` が今の文書と文字列で違えば何もしない
 *    (`'not-open'`)。最中なら何もしない(`'busy'`)— 印は最初の await より前に立てるので、
 *    同期の連打でも読むのは 1 回
 * 2. 未保存の確認を通す。取り消したら何もしない(`'cancelled'`)。確認の間に文書が替わったら、
 *    もう押した文書ではないので読まない(`'stale'`)
 * 3. ファイルの読み直しとツリーの読み直しを同時に始め、両方が終わってから終わる(【(t) 決定】)。
 *    ファイルの結果は届いた時点で当てる:
 *    - 開けなければ 1 回知らせる(`'failed'`)
 *    - 読んでいる間に外部変更が当たった・文書が替わったら当てない(`'stale'`)
 *    - テキスト系(`readsAsText`= `open_document` の選び方と同じ規則)は届いた内容で描き直し、
 *      バイナリ系は表示の版数を 1 つ進める(`'reloaded'`)
 *    ツリーの成否は結果に出さない(失敗は黙って飲む)
 */
export function createFileReloader<Doc>(deps: FileReloaderDeps<Doc>): {
	reload: (target?: string | null) => Promise<ReloadOutcome>;
} {
	let busy = false;

	async function reloadFile(uri: string): Promise<ReloadOutcome> {
		// この時点より前に当たった外部変更は、これから読む版より古い。
		const stamp = deps.changeStamp();
		let doc: Doc;
		try {
			doc = await deps.open(uri);
		} catch (err) {
			deps.notify(reloadFileFailedMessage(err));
			return 'failed';
		}
		if (deps.changeStamp() !== stamp || deps.current() !== uri) return 'stale';
		if (readsAsText(uri)) deps.applyText(doc);
		else deps.bumpBinary(uri);
		return 'reloaded';
	}

	async function run(uri: string): Promise<ReloadOutcome> {
		if (!(await deps.confirm())) return 'cancelled';
		if (deps.current() !== uri) return 'stale';
		const [outcome] = await Promise.all([reloadFile(uri), settleQuietly(deps.refreshTree)]);
		return outcome;
	}

	async function reload(target?: string | null): Promise<ReloadOutcome> {
		const uri = deps.current();
		if (uri === null) return 'no-document';
		if (target != null && target !== uri) return 'not-open';
		if (busy) return 'busy';
		busy = true;
		try {
			return await run(uri);
		} catch (err) {
			// 確認そのものが失敗したときなど。外へは出さない(Unhandled Rejection にしない)。
			console.warn(`reload of ${uri} failed:`, err);
			return 'failed';
		} finally {
			busy = false;
		}
	}

	return { reload };
}

// ---------------------------------------------------------------------------
// Reload Folder の実行列(契約 11・15)
// ---------------------------------------------------------------------------

export type FolderReloadOutcome =
	/** 空白から押したが root が無い */
	| 'no-root'
	/** 一覧を待っている最中(契約 11)。何もしない */
	| 'busy'
	/** 畳んであるフォルダを開いただけ(読むのは展開の $effect=【(w) 決定】) */
	| 'expanded'
	/** 1 つ以上の一覧を読めなかった(読めたものは当てた) */
	| 'failed'
	| 'reloaded';

export type FolderReloaderDeps<E> = {
	/** 今の root('' = 無い)。 */
	root: () => string;
	/** 展開中のフォルダ(変更しない)。 */
	expandedDirs: () => readonly string[];
	isExpanded: (uri: string) => boolean;
	/** 畳んであるフォルダを開く(`windowState.toggleExpanded`)。 */
	expand: (uri: string) => void;
	/** 一覧を取る(`list_dir`)。 */
	listDir: (uri: string) => Promise<E[]>;
	/** 一覧をツリーへ当てる(`applyDirectoryEvent`=監視の `directory_changed` と同じ当て方)。 */
	apply: (uri: string, entries: E[]) => void;
	/** 失敗の知らせ(alert)。 */
	notify: (message: string) => void;
};

type Listing<E> = { ok: true; entries: E[] } | { ok: false; error: unknown };

/**
 * 一覧を取る。失敗(reject も同期の throw も)は理由ごと値にして外へ出さない。
 * 作った時点で受け手を付けるので、後ろの一覧の reject が待つ前に Unhandled Rejection にならない。
 */
function fetchListing<E>(listDir: (uri: string) => Promise<E[]>, uri: string): Promise<Listing<E>> {
	try {
		return listDir(uri).then(
			(entries): Listing<E> => ({ ok: true, entries }),
			(error: unknown): Listing<E> => ({ ok: false, error })
		);
	} catch (error) {
		return Promise.resolve({ ok: false, error });
	}
}

/** `uri` が `ancestor` の子孫か(URI の階層で見る。`/r/a` に対する `/r/ab` は含まない)。 */
function isDescendant(ancestor: string, uri: string): boolean {
	const prefix = ancestor.endsWith('/') ? ancestor : `${ancestor}/`;
	return uri !== ancestor && uri.startsWith(prefix);
}

/**
 * Reload Folder の実行列。Explorer が 1 つ作り、フォルダの行(その URI)と空白(null)から呼ぶ。
 *
 * - 範囲: フォルダの行=そのフォルダと、展開中のフォルダのうちその子孫(途中が畳んであっても
 *   含む=【(y) 決定】)。空白= root と展開中のすべて(Reload File のツリー分と同じ)
 * - 畳んであるフォルダの行は開くだけ(読むのは展開の $effect=【(w) 決定】。二重に読まない)
 * - 一覧はまとめて取りに行き、当てるのは読む順。1 つでも読めなければ、読めたものは当て、
 *   読めなかったものは前の一覧を残し、読む順で最初の失敗の理由で 1 回知らせる(【(x) 決定】)
 * - 一覧を待っている間の Reload Folder は、どの行・空白から押しても何もしない(【(u) 決定】)
 * - 文書には触れない。監視も張り直さない(【(z) 決定】)
 */
export function createFolderReloader<E>(deps: FolderReloaderDeps<E>): {
	reload: (target: string | null) => Promise<FolderReloadOutcome>;
} {
	let busy = false;

	function scopeOf(target: string | null): string[] {
		const expanded = deps.expandedDirs();
		if (target === null) return [deps.root(), ...expanded];
		return [target, ...expanded.filter((uri) => isDescendant(target, uri))];
	}

	async function reloadListings(uris: string[]): Promise<FolderReloadOutcome> {
		const listings = uris.map((uri) => fetchListing(deps.listDir, uri));
		let firstError: { error: unknown } | null = null;
		for (let i = 0; i < uris.length; i++) {
			const listing = await listings[i];
			if (!listing.ok) {
				firstError ??= { error: listing.error };
				continue;
			}
			try {
				deps.apply(uris[i], listing.entries);
			} catch (err) {
				console.warn(`could not apply the listing of ${uris[i]}:`, err);
			}
		}
		if (firstError === null) return 'reloaded';
		deps.notify(reloadFolderFailedMessage(firstError.error));
		return 'failed';
	}

	async function reload(target: string | null): Promise<FolderReloadOutcome> {
		if (busy) return 'busy';
		if (target === null && deps.root() === '') return 'no-root';
		if (target !== null && !deps.isExpanded(target)) {
			deps.expand(target);
			return 'expanded';
		}
		busy = true;
		try {
			return await reloadListings(scopeOf(target));
		} finally {
			busy = false;
		}
	}

	return { reload };
}

// ---------------------------------------------------------------------------
// メニューの購読(契約 2)
// ---------------------------------------------------------------------------

/**
 * View ▸ Reload File(`menu_reload_file`)を購読する。イベント 1 回で `run` を 1 回呼ぶ。
 * `run` の失敗(reject も同期の throw も)は外へ出さない。返り値で購読を解く。
 */
export async function registerReloadFileListener(
	run: () => Promise<unknown> | unknown
): Promise<() => void> {
	const unlisten = await listen<unknown>(MENU_RELOAD_FILE_EVENT, () => {
		void (async () => {
			try {
				await run();
			} catch (err) {
				console.warn('reload file from the menu failed:', err);
			}
		})();
	});
	return () => unlisten();
}

// ---------------------------------------------------------------------------
// 本文の右クリックの判定(契約 8)
// ---------------------------------------------------------------------------

export type ViewerContextMenuMode = 'app' | 'default';

/**
 * 本文(閲覧面)の右クリックで自前のメニュー(Reload File)を出すか。5 つの条件が
 * すべて揃うときだけ `'app'`。それ以外は `'default'`= イベントに触らず、今の既定の
 * メニュー(選択中の Copy・Look Up、編集の面の Paste など)を残す。
 */
export function viewerContextMenuMode(input: {
	/** 文書を表示している(空の状態の画面・履歴選択画面では出さない)。 */
	hasDocument: boolean;
	/** 選択している文字列(空白だけでも「選んでいる」)。 */
	selectionText: string;
	/** 右クリックした場所が編集の面(contenteditable の中・input・textarea)。 */
	targetEditable: boolean;
	/** 右クリックした場所が 3D の描画面(右ドラッグ=パン)。 */
	targetInModel: boolean;
	/** メニューを描く部品が窓にある(Find in Folder のパネルの間は無い=【(s) 決定】)。 */
	menuAvailable: boolean;
}): ViewerContextMenuMode {
	return input.hasDocument &&
		input.selectionText === '' &&
		!input.targetEditable &&
		!input.targetInModel &&
		input.menuAvailable
		? 'app'
		: 'default';
}
