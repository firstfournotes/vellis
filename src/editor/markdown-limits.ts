/**
 * Markdown の編集面の大きさの閾値(要件#74 契約18・判断 8・第2段の作り(案)の項目 21)。
 *
 * 超えた文書は今の描画(読み取り専用)で開き、知らせを出す(raw には入れる)。UTF-8 の byte で数える(根拠=周回0 の 0-17)。
 */

/** 2 MiB。ちょうどは編集面。 */
export const MARKDOWN_EDIT_LIMIT_BYTES = 2 * 1024 * 1024;

/** UTF-8 の byte 数が閾値を超えるか。 */
export function markdownTooLarge(content: string): boolean {
	// 1 文字は UTF-8 で 1〜3 byte(サロゲート対は 2 文字で 4 byte)なので、文字数で決まる範囲は数えない。
	if (content.length * 3 <= MARKDOWN_EDIT_LIMIT_BYTES) return false;
	if (content.length > MARKDOWN_EDIT_LIMIT_BYTES) return true;
	return new TextEncoder().encode(content).length > MARKDOWN_EDIT_LIMIT_BYTES;
}
