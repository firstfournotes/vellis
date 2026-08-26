/**
 * PDF 表示の判定(requirements.md #29)。
 *
 * 「PDF ファイルを開いたらアプリ内でインライン表示する(初版ローカル限定・
 *  ssh はプレースホルダ)」のうち、DOM を持たない部分をここに集める。
 * `PdfViewer.svelte` は表示だけを持ち、「インラインで出せるのか・プレースホルダなのか」
 * 「導線を押したら何をするか」はこの純関数群が答える(`video-viewing.ts` と同じ家風)。
 *
 * 契約(2026-08-26 由谷決定 Q1〜Q8=docs/pdf-viewing.md §7):
 * - 描画は WKWebView のネイティブ PDF ビューアに任せる(案A。実機プローブで
 *   iframe / embed / object / 直ロードのすべてが表示可と確認済み)。採ったのは
 *   `<iframe src="vellis-asset:…">` で、CSP の緩和が `frame-src` の追加だけで済み
 *   `object-src 'none'`(要件#8 以来の封鎖)を維持できる
 * - ライブラリは足さない(PDF.js 同梱=案B はプローブが通ったので不要になった)
 * - ssh リモートは初版の対象外(Q2)。判別は URI スキームのみで、パスの中身では
 *   分岐しない(`video-viewing.ts` の `isRemote` と同じ規則・backlog #60 の O(n²) を
 *   顕在化させない)
 */
import { pathForReveal } from './context-menu';

/**
 * 表示形態。`inline` = アプリ内で表示・`remote` = ssh のプレースホルダ(導線なし。
 * 要件#19 で ssh の「既定アプリで開く」が disabled なのと同じ理由)。
 *
 * 動画の `unsupported-container` に当たる状態は無い — PDF は拡張子と中身が1対1で、
 * 開けるかどうかは実際に読んでみるまで判らない(壊れた・暗号化された PDF の
 * フォールバックは `PdfViewer` 側の読み込み結果が決める=契約⑥)。
 */
export type PdfViewMode = 'inline' | 'remote';

/** ssh リモートか(判別は URI スキームのみ=契約⑤)。 */
function isRemote(uri: string): boolean {
	return /^ssh:/i.test(uri);
}

/**
 * この PDF をどう見せるか。呼ぶのは `detectFileType` が `pdf` と答えた URI だけ
 * (= `DisplayResult.pdfSrc` が付いている文書)。
 */
export function pdfViewMode(uri: string): PdfViewMode {
	return isRemote(uri) ? 'remote' : 'inline';
}

/**
 * プレースホルダの「既定アプリで開く」を押したときの実行計画(要件#19 の opener 再利用)。
 *
 * OS パスへの変換はコンテキストメニューと同じ `pathForReveal` — 同じファイルを
 * 右クリックから開いても、プレースホルダから開いても同じパスが渡る。
 * ssh は null =導線そのものを出さない(要件#19 で ssh の項目を disabled にしたのと同じ)。
 */
export function planOpenPdfExternally(uri: string): { command: 'open_path'; path: string } | null {
	if (isRemote(uri)) return null;
	return { command: 'open_path', path: pathForReveal(uri) };
}
