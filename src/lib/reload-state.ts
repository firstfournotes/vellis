/**
 * reload をまたぐ状態スナップショット(requirements.md #10)。
 *
 * 「reload 後も現在の root・開いているファイル・ツリー展開状態を維持する
 *  (ウインドウを閉じる/アプリ再起動でリセット)」の判定ロジックを一箇所に集める。
 * 保存・復元・フォールバック判定はすべてここを通り、`+page.svelte` は
 * 「いつ呼ぶか」と結果の反映だけを持つ。
 *
 * 契約(2026-08-08 由谷決定=案Y・調査記録 docs/reload-state.md §4):
 * - `{ rootUri, docUri, expandedDirs }` を状態変更のたび sessionStorage へ保存し、
 *   mount 時にスナップショットがあれば起動時引数の代わりに復元する
 *   (`set_root` → `open_document` → 保存ディレクトリの展開。Rust 変更なし)
 * - スナップショットがあれば履歴選択画面(要件#4)は表示しない
 * - 復元失敗(対象消滅等)は起動時引数の挙動へフォールバック
 * - スクロール位置とマーク一覧開閉はスコープ外
 *
 * 置き場が sessionStorage であること自体が寿命の契約: reload は跨ぎ、ウインドウを
 * 閉じる/アプリを再起動すると消え、ウインドウごとに独立した browsing context を持つ。
 * localStorage へは書かない(書くと「アプリ再起動でリセット」が壊れる)。
 *
 * 状態はモジュール内に保持しない。唯一の在り処は sessionStorage であり、
 * `loadSnapshot` は呼ばれるたびにそこを読む(pane-resize と同じ家風)。
 */
import { invoke } from '$lib/ipc';
import { openCommandFor } from '$lib/open-document';

/**
 * 保存キー。同一ウインドウの reload 前後(開発中はビルドをまたぐこともある)で
 * 同じ値を読むため固定文字列とする。
 */
export const RELOAD_STATE_STORAGE_KEY = 'vellis.reload-state';

/** 保存・復元されるスナップショット。この3フィールドだけが reload を跨ぐ。 */
export type ReloadSnapshot = {
	/** 現在の root URI。空なら復元先が無いので破棄される。 */
	rootUri: string;
	/** 開いている文書の URI。開いていなければ null。 */
	docUri: string | null;
	/** 展開中のディレクトリ URI(正規化済み・初出順)。 */
	expandedDirs: string[];
};

/** `saveSnapshot` の入力。展開集合は配線側が Set で持つ想定なので Iterable で受ける。 */
export type ReloadSnapshotInput = {
	rootUri: string;
	docUri: string | null;
	expandedDirs: Iterable<string>;
};

/**
 * `restoreSnapshot` の結果。
 *
 * `ok: false` は「まだ何も変わっていない」=起動時引数の挙動へ全体フォールバックできる、
 * の意味。root だけ復元できた場合は `ok: true` + `document: null`(部分フォールバック)。
 */
export type RestoreResult<Root = unknown, Doc = unknown> =
	| { ok: true; root: Root; document: Doc | null }
	| { ok: false };

/**
 * sessionStorage への参照。Tauri の WebView 以外(SSR 相当・ストレージが無効な
 * コンテキスト)でも例外で落とさないための保険。
 */
function storage(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

/** 末尾スラッシュを落とす。URI の比較は「区切りを含めない形」で揃える。 */
function stripTrailingSlashes(uri: string): string {
	return uri.replace(/\/+$/, '');
}

/**
 * 展開集合を保存できる形に整える。
 *
 * - 重複を除去し、初出順を維持する(見た目の並びに意味はないが、往復で安定させる)
 * - `rootUri` 自身は除く(root 直下は常に表示されるので展開の対象ではない)
 * - root 配下でないものは除く。root が変わった後の残骸を持ち回らないため
 * - 「配下」はセグメント境界での前方一致で判定する。`file:///a/work` の下に
 *   `file:///a/workspace` は入らない(単純な `startsWith` では入ってしまう)
 * - 親が集合に無い孫ディレクトリは残す。スナップショットは見たままの記録であり、
 *   親子関係の刈り込みはしない(復元側は親から順に開くので実害がない)
 *
 * 返す URI も末尾スラッシュを落とした形にそろえる — 復元側は `list_dir` が返す
 * エントリ URI と照合するため、表現が揺れていると一致しない。
 */
export function normalizeExpandedDirs(rootUri: string, dirs: Iterable<string>): string[] {
	const base = stripTrailingSlashes(rootUri);
	if (base === '') return [];
	const prefix = `${base}/`;

	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const dir of dirs) {
		const uri = stripTrailingSlashes(dir);
		if (uri === base || !uri.startsWith(prefix)) continue;
		if (seen.has(uri)) continue;
		seen.add(uri);
		normalized.push(uri);
	}
	return normalized;
}

/**
 * スナップショットを保存する。
 *
 * 表現も契約: `{ rootUri, docUri, expandedDirs }` の3フィールドを持つ JSON。
 * `docUri` が root 配下かは見ない — 開けるかどうかは `open_document` の成否が正。
 *
 * root が空(= init_window 前の初期状態)のときは書かない。復元先の無い
 * スナップショットで、直前の正常な値を潰さないため。
 */
export function saveSnapshot(snapshot: ReloadSnapshotInput): void {
	if (snapshot.rootUri === '') return;
	const payload: ReloadSnapshot = {
		rootUri: snapshot.rootUri,
		docUri: snapshot.docUri,
		expandedDirs: normalizeExpandedDirs(snapshot.rootUri, snapshot.expandedDirs),
	};
	try {
		storage()?.setItem(RELOAD_STATE_STORAGE_KEY, JSON.stringify(payload));
	} catch {
		// 保存に失敗しても表示中の状態は有効。次の reload が起動時引数の挙動に
		// 戻るだけなので黙って諦める。
	}
}

/**
 * 保存済みスナップショットを読む。読めなければ null(=起動時引数の挙動へ)。
 *
 * 形が崩れていたら部分救済はせず全体を破棄する。書き手は `saveSnapshot` だけなので、
 * 崩れている=破損とみなして安全側に落とす。未知の追加フィールドは無視する(前方互換)。
 * 展開集合は読込時にも正規化する(旧版・手書きの保存値への防御)。
 */
export function loadSnapshot(): ReloadSnapshot | null {
	let raw: string | null = null;
	try {
		raw = storage()?.getItem(RELOAD_STATE_STORAGE_KEY) ?? null;
	} catch {
		return null;
	}
	if (raw === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

	const { rootUri, docUri, expandedDirs } = parsed as Record<string, unknown>;
	if (typeof rootUri !== 'string' || rootUri === '') return null;
	if (docUri !== null && typeof docUri !== 'string') return null; // 欠損(undefined)もここで落ちる
	if (!Array.isArray(expandedDirs) || !expandedDirs.every((d) => typeof d === 'string')) {
		return null;
	}

	return {
		rootUri,
		docUri,
		expandedDirs: normalizeExpandedDirs(rootUri, expandedDirs as string[]),
	};
}

/** スナップショットを捨てる。未保存でも例外にしない。 */
export function clearSnapshot(): void {
	try {
		storage()?.removeItem(RELOAD_STATE_STORAGE_KEY);
	} catch {
		// 消せなくても次の保存で上書きされる。
	}
}

/**
 * 履歴選択画面(要件#4)を出すかどうか。
 *
 * - スナップショットなし → 従来どおり `needs_root_selection` に従う
 * - スナップショットあり・復元成功 → 出さない(契約の本体。引数なし起動の reload でも
 *   選択済みの root に戻るので、画面をもう一度出す理由がない)
 * - スナップショットあり・復元失敗 → 従来どおり。存在するだけでは抑止しない —
 *   復元先が消えているときに抑止すると、選択手段のないまま空の root に取り残される
 */
export function shouldShowRootPicker(
	needsRootSelection: boolean,
	snapshot: ReloadSnapshot | null,
	rootRestored: boolean,
): boolean {
	if (snapshot !== null && rootRestored) return false;
	return needsRootSelection;
}

/**
 * スナップショットから root と文書を復元する。既存コマンドの再利用のみで、
 * Rust 側には何も足さない。
 *
 * `set_root` → (docUri があれば)文書コマンドの順に呼ぶ。ラスタ画像は
 * `open_binary_document`(要件#22。`open_document` は InvalidUtf8 で必ず失敗する)、
 * それ以外は従来どおり `open_document` — 選ぶのは `openCommandFor`。ツリーの展開は
 * ここではやらない — 展開は配線側(Explorer の展開状態)の持ち場。
 *
 * 失敗は reject させず、呼び出し側がフォールバックを選べる形で解決する:
 * - `set_root` 失敗(root が消えた等) → `{ ok: false }`。`open_document` は呼ばない。
 *   まだ何も変わっていないので起動時引数の挙動へ丸ごと戻せる
 * - 文書コマンド失敗(root は在るがファイルが消えた) → root は復元したまま
 *   `document: null`。既存の `file_removed` → `clearDocument` と同じ最終状態で、
 *   `set_root` 済みの backend とも食い違わない
 */
export async function restoreSnapshot<Root = unknown, Doc = unknown>(
	snapshot: ReloadSnapshot,
): Promise<RestoreResult<Root, Doc>> {
	let root: Root;
	try {
		root = await invoke<Root>('set_root', { uri: snapshot.rootUri });
	} catch {
		return { ok: false };
	}

	if (snapshot.docUri === null) return { ok: true, root, document: null };

	const command = openCommandFor(snapshot.docUri);
	try {
		return { ok: true, root, document: await invoke<Doc>(command, { uri: snapshot.docUri }) };
	} catch {
		return { ok: true, root, document: null };
	}
}
