/**
 * 表示中のラスタ画像の変更追従(requirements.md #22 ①)。
 *
 * ラスタ画像の表示は `<img src="vellis-asset:…">` の1経路(要件#16)なので、
 * ディスク上の変更(`binary_file_changed`。イベント契約は
 * src-tauri/tests/acceptance_req22.rs)を受けても src の文字列が同じままでは
 * WebView のキャッシュに当たって再取得されない。版数をクエリで乗せて
 * キャッシュキーを変えるのがここの仕事で、版数を進める配線は `+page.svelte`。
 *
 * フラグメント(#)ではなくクエリ(?)なのは契約: フラグメントはリクエスト URL に
 * 含まれないため、キャッシュキーが変わらない。
 */

/** 版数クエリのパラメータ名。画像の内容とは無関係なので短くしてある。 */
const VERSION_PARAM = 'v';

/**
 * `<img src>` に載せる URI に版数を付ける。
 *
 * 版数0(初期表示)は素の URI のまま返す — 一度も変更されていない画像の src を
 * 要件#16 の形から動かさない。1以上は版数ごとに異なる決定的な URI を返すので、
 * 再レンダーで src が揺れて無駄な再取得をすることもない。
 */
export function imageSrcWithVersion(src: string, version: number): string {
	if (version <= 0) return src;
	const separator = src.includes('?') ? '&' : '?';
	return `${src}${separator}${VERSION_PARAM}=${version}`;
}
