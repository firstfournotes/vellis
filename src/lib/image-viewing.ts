/**
 * 画像・SVG 表示の判定と状態(requirements.md #16)。
 *
 * 「画像ファイル(png/jpg/jpeg/gif/webp/avif/bmp/ico)と SVG ファイルを開いたとき、
 *  レンダリング結果(画像)を表示する」のうち、DOM を持たない部分をここに集める。
 * `ImageViewer.svelte` は表示だけを持ち、「どの URI を `<img>` に載せるか」
 * 「ソース表示へ切り替えられるか」「既定はどちらか」はすべてこの純関数群が答える
 * (`menu-open.ts` の `planMenuOpen` と同じ家風)。
 *
 * 契約(2026-08-12 由谷決定=案 a′ × フロント完結。検討記録 docs/image-viewing.md §5〜§7):
 * - 表示は `<img src="vellis-asset:…">` の1経路のみ。inline 展開・`<object>` /
 *   `<embed>` / `<iframe>` は使わない — SVG を `<img>` に閉じ込めること自体が
 *   サンドボックス(secure static mode = スクリプト不実行・外部参照なし)であり、
 *   要件#8 の「スクリプトは実行しない」不変条件と一貫する
 * - ラスタ画像は `open_document`(UTF-8 テキスト読込)を通さない。通すと
 *   `FsError::InvalidUtf8` で失敗するため。代償として監視・削除追従・reload 復元
 *   (要件#10)の対象外になる。SVG は UTF-8 XML なので従来のテキスト経路のまま
 *   = ソース切替の素材も監視も無料で付いてくる
 * - 表示状態は2値が2つだけ(フィット⇄実寸・画像⇄ソース)。ズーム / パンは契約外
 */
import { detectFileType } from './file-type';
import { toAssetUri } from './uri';

/** 表示サイズ。`fit` = ウインドウに収める(原寸以上に拡大しない)・`actual` = 原寸。 */
export type ImageSizeMode = 'fit' | 'actual';

/** SVG の表示。`image` = 画像として描画・`source` = XML ソースをそのまま表示。 */
export type SvgViewMode = 'image' | 'source';

/** 既定はフィット(16px のアイコンが画面いっぱいに伸びない側)。 */
export const DEFAULT_SIZE_MODE: ImageSizeMode = 'fit';

/** 既定は画像表示。SVG も「開いたら画像が出る」— ソースはトグルの向こう側。 */
export const DEFAULT_SVG_VIEW_MODE: SvgViewMode = 'image';

/**
 * `<img src>` に載せる `vellis-asset:` URI。
 *
 * 変換そのものは Markdown 内の画像(rewrite-uri)・HTML の `<base>`(html-viewer)と
 * 同じ `toAssetUri` で、ssh リモートもそのまま通る(要件#16 ⑥)。呼ぶ側が
 * 「画像を出すためにこれを使う」と読めるように名前だけを与えている。
 */
export function toImageSrc(absoluteUri: string): string {
	return toAssetUri(absoluteUri);
}

/**
 * SVG か。分類を先に通すので、`.svg` のような拡張子として扱われない名前
 * (先頭のドットしかない = `detectFileType` は text)はここでも SVG にならない。
 */
function isSvg(nameOrUri: string): boolean {
	return detectFileType(nameOrUri) === 'image' && nameOrUri.toLowerCase().endsWith('.svg');
}

/**
 * `open_document` を通してよいか(= テキストとして読めるか)。
 *
 * 通さないのはラスタ画像だけ。SVG・Markdown・HTML・プレーンテキストは従来どおり
 * 読み、ラスタ画像は読まずに URI だけで表示する(要件#16 ⑦)。
 */
export function readsAsText(nameOrUri: string): boolean {
	return detectFileType(nameOrUri) !== 'image' || isSvg(nameOrUri);
}

/**
 * ソース表示へ切り替えられるか(要件#16 ③)。SVG だけが true —
 * ラスタ画像にソースは無く、画像以外にトグルという概念が無い。
 */
export function canToggleSource(nameOrUri: string): boolean {
	return isSvg(nameOrUri);
}

/** 実寸トグル1個ぶんの遷移。第3の状態は無い。 */
export function toggleSizeMode(mode: ImageSizeMode): ImageSizeMode {
	return mode === 'fit' ? 'actual' : 'fit';
}

/** ソース切替トグル1個ぶんの遷移。 */
export function toggleSvgViewMode(mode: SvgViewMode): SvgViewMode {
	return mode === 'image' ? 'source' : 'image';
}
