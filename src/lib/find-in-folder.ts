/**
 * フォルダ横断検索(要件#55)の画面を持たない部分。
 *
 * 走査そのものは Rust の Tauri command `search_in_folder`(`src-tauri/src/search/`)。
 * ここは結果のグループ化(契約⑥)・世代番号によるキャンセル(契約⑧)・状態表示の
 * 文言・root 未選択のガード(契約①)だけを純関数で持つ。配線(invoke・パネル)は
 * `src/components/FindInFolder.svelte` と `src/routes/+page.svelte` の持ち場で、
 * このファイルは Tauri にもストレージにも触れない。
 */

import { findMatches } from './find-in-document';

/** Edit メニュー「Find in Folder…」(⌘⇧F)のイベント名。menu.rs の MENU_FIND_IN_FOLDER_EVENT と同綴り。 */
export const MENU_FIND_IN_FOLDER_EVENT = 'menu_find_in_folder';

/** Tauri command 名(契約⑤)。invoke の第 1 引数。 */
export const SEARCH_IN_FOLDER_COMMAND = 'search_in_folder';

/** 続きのページを取る Tauri command 名(追補a)。 */
export const SEARCH_IN_FOLDER_PAGE_COMMAND = 'search_in_folder_page';

/** パネルを開いたときにその窓の検索状態(保持中の結果と最新世代)を捨てる Tauri command 名(追補e)。 */
export const SEARCH_IN_FOLDER_RESET_COMMAND = 'search_in_folder_reset';

/** 走査の途中の一致を運ぶ Tauri イベント名(Rust の `search::SEARCH_PROGRESS_EVENT` と同綴り=追補d)。 */
export const SEARCH_PROGRESS_EVENT = 'search_progress';

/** 走査の終わりを知らせる Tauri イベント名(Rust の `search::SEARCH_DONE_EVENT` と同綴り=追補d)。 */
export const SEARCH_DONE_EVENT = 'search_done';

/** 1 ページの件数(Rust の `PAGE_SIZE` と同値=追補a)。 */
export const FIND_IN_FOLDER_PAGE_SIZE = 200;

/** 結果一覧の末尾のボタンの文言(残り件数つき・英語=要件#51・追補a)。 */
export const FIND_IN_FOLDER_SHOW_MORE = (remaining: number): string =>
	`Show more (${remaining} remaining)`;

/** 0 件の文言(英語=要件#51)。 */
export const FIND_IN_FOLDER_NO_RESULTS = 'No results';

/** 検索中の文言。 */
export const FIND_IN_FOLDER_SEARCHING = 'Searching…';

/**
 * Rust の SearchHit と同形。path は root からの相対・line は 1 始まり。
 * `ordinal` はそのファイルの先頭からの語の出現の通し番号(1 始まり=追補a)。無い応答もある。
 */
export type SearchHit = { path: string; line: number; text: string; ordinal?: number };

/**
 * command の戻り。generation は投げた世代がそのまま返る。`total` / `files` は全件の値、
 * `hits` は先頭 1 ページ(追補a)。
 */
export type SearchResponse = { generation: number; total: number; files: number; hits: SearchHit[] };

/**
 * `search_progress` の payload(追補d)。`hits` は走査順の 1 バッチ・`filesScanned` は
 * ここまでに読み終えたテキストファイル数。
 */
export type SearchProgressPayload = { generation: number; hits: SearchHit[]; filesScanned: number };

/** `search_done` の payload(追補d)。`total` / `files` は全件の値。 */
export type SearchDonePayload = { generation: number; total: number; files: number };

/** `search_in_folder_page` の戻り(追補a)。世代が違えば hits は空。 */
export type SearchPageResponse = { generation: number; hits: SearchHit[] };

/** ファイルごとのまとまり(契約⑥)。 */
export type FileGroup = { path: string; count: number; hits: { line: number; text: string }[] };

/**
 * 平坦な一致一覧をファイルごとにまとめる(契約⑥)。グループの順=path の初出順・
 * グループ内の順=入力順。同じ path が離れて現れても 1 グループに合流する。
 * 入力は変更しない。
 */
export function groupHits(hits: SearchHit[]): FileGroup[] {
	const groups: FileGroup[] = [];
	const byPath = new Map<string, FileGroup>();
	for (const hit of hits) {
		let group = byPath.get(hit.path);
		if (!group) {
			group = { path: hit.path, count: 0, hits: [] };
			byPath.set(hit.path, group);
			groups.push(group);
		}
		group.hits.push({ line: hit.line, text: hit.text });
		group.count += 1;
	}
	return groups;
}

/**
 * 世代番号(契約⑧)。`next()` で 1 つ進めた番号を invoke に渡し、戻ってきた世代が
 * `current` と違えば捨てる。最初の `next()` は 1 を返す(0 = まだ何も投げていない)。
 */
export class SearchSession {
	#current = 0;

	get current(): number {
		return this.#current;
	}

	next(): number {
		this.#current += 1;
		return this.#current;
	}

	isCurrent(generation: number): boolean {
		return this.#current > 0 && generation === this.#current;
	}

	/** 現在世代の結果だけを返し、古い世代は null。 */
	accept<T>(generation: number, result: T): T | null {
		return this.isCurrent(generation) ? result : null;
	}
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * 状態表示(契約⑥)。query が空なら ''、検索中は `Searching…`(届いた一致があれば
 * `Searching… ${total} result(s) in ${files} file(s) so far`=追補d)、0 件は `No results`、
 * それ以外は `${total} result(s) in ${files} file(s)`。
 */
export function formatFolderStatus(s: {
	query: string;
	searching: boolean;
	total: number;
	files: number;
}): string {
	if (s.query === '') return '';
	const counts = `${plural(s.total, 'result')} in ${plural(s.files, 'file')}`;
	if (s.searching) {
		return s.total > 0 ? `${FIND_IN_FOLDER_SEARCHING} ${counts} so far` : FIND_IN_FOLDER_SEARCHING;
	}
	if (s.total === 0) return FIND_IN_FOLDER_NO_RESULTS;
	return counts;
}

/** 契約①: root が開かれていて、履歴選択画面でないときだけパネルを出す。 */
export function shouldShowFindInFolder(
	rootUri: string | null | undefined,
	rootPickerOpen: boolean
): boolean {
	return !!rootUri && !rootPickerOpen;
}

/**
 * 結果の行 `clicked` が、そのファイルの中で何番目の一致か(0 始まり・要件#55 追補b)。
 * 同じ `path` で `clicked.line` より前の行の `text` に含まれる `query` の出現数の合計。
 * 数え方は要件#54 の `findMatches`(大小無視・重ならない出現)と同じなので、
 * Viewer の現在の一致の番目とそのまま対応する。クリック行自身・他の path・後ろの行は
 * 数えない。配列順には依らない。`query` が空なら 0。入力は変更しない。
 */
export function occurrenceIndex(hits: SearchHit[], clicked: SearchHit, query: string): number {
	if (query === '') return 0;
	let count = 0;
	for (const hit of hits) {
		if (hit.path !== clicked.path || hit.line >= clicked.line) continue;
		count += findMatches(hit.text, query).length;
	}
	return count;
}

/**
 * 結果の行 `clicked` を開くときの番目(0 始まり・追補a)。`clicked.ordinal` があれば
 * `ordinal - 1`(ページ分けで手元に無い行があっても正確)、無ければ `occurrenceIndex`。
 * 入力は変更しない。
 */
export function matchIndex(hits: SearchHit[], clicked: SearchHit, query: string): number {
	if (typeof clicked.ordinal === 'number') return Math.max(0, clicked.ordinal - 1);
	return occurrenceIndex(hits, clicked, query);
}

/**
 * 検索パネルの欄(要件#65 契約13)。files to include / files to exclude の中身(glob を
 * カンマ区切りで書いたそのままの文字列)・歯車(Use Exclude Settings)の ON/OFF・
 * 2 欄を出しているか(Toggle Search Details)。
 */
export type SearchScopeFields = {
	include: string;
	exclude: string;
	useExcludeSettings: boolean;
	detailsOpen: boolean;
};

const DEFAULT_SEARCH_SCOPE: SearchScopeFields = {
	include: '',
	exclude: '',
	useExcludeSettings: true,
	detailsOpen: true,
};

/**
 * 欄の現在値。窓の生存中だけ覚える(契約13): モジュールの変数なので、パネルを閉じて
 * 開き直しても残り、窓(=この webview)を閉じれば消える。設定ファイルにもブラウザの
 * 保存領域にも書かない。
 */
let searchScope: SearchScopeFields = { ...DEFAULT_SEARCH_SCOPE };

/** 欄の現在値(写し)。 */
export function getSearchScope(): SearchScopeFields {
	return { ...searchScope };
}

/** 欄の値を部分的に書き換える(渡したキーだけ)。 */
export function setSearchScope(patch: Partial<SearchScopeFields>): void {
	searchScope = { ...searchScope, ...patch };
}

/** 欄を既定(空・歯車 ON・2 欄を出す)に戻す。 */
export function resetSearchScope(): void {
	searchScope = { ...DEFAULT_SEARCH_SCOPE };
}

/**
 * 欄の文字列をパターンの配列にする(契約13)。カンマで割って前後の空白を落とし、
 * 空の要素(空白だけを含む)は捨てる。パターンの中身は見ない(照合は Rust)。
 */
export function splitPatterns(text: string): string[] {
	return text
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part !== '');
}
