/**
 * 動画表示の判定(requirements.md #28)。
 *
 * 「動画ファイル(mp4/mov/webm)を開いたらアプリ内でインライン再生できる。
 *  非対応コンテナ(mkv/avi)はプレースホルダから「既定アプリで開く」へ誘導する」
 * のうち、DOM を持たない部分をここに集める。`VideoViewer.svelte` は表示だけを持ち、
 * 「再生できるのか・プレースホルダなのか」「`<video>` に何を載せるか」
 * 「導線を押したら何をするか」はすべてこの純関数群が答える(`image-viewing.ts` と同じ家風)。
 *
 * 契約(2026-08-22 由谷決定=案C ハイブリッド。検討記録 docs/video-viewing.md §5〜§7):
 * - 再生は `<video controls src="vellis-asset:…">` の1経路のみ。デコードは WebKit に
 *   任せ、変換もサムネイル生成もしない(依存を増やさない)
 * - WebKit がデコードできるのは mp4 / mov / webm の3コンテナだけ。mkv / avi は
 *   黙って無音の黒画面になるより、初めから再生を試みずに OS の既定アプリへ渡す
 * - ssh リモートは拡張子によらず再生対象外(Q4)。判別は URI スキームのみで、
 *   パスの中身では分岐しない(`context-menu.ts` の `isRemote` と同じ規則)
 */
import { pathForReveal } from './context-menu';
import { toAssetUri } from './uri';

/**
 * 表示形態。`inline` = アプリ内で再生・`unsupported-container` = デコードできない
 * コンテナのプレースホルダ(既定アプリへの導線あり)・`remote` = ssh のプレースホルダ
 * (導線なし。要件#19 で ssh の「既定アプリで開く」が disabled なのと同じ理由)。
 */
export type VideoViewMode = 'inline' | 'unsupported-container' | 'remote';

/**
 * WebKit がそのままデコードするコンテナ。ここに無い動画は再生を試みない。
 *
 * コーデックの可否(AV1 は M3 未満で再生不可・ProRes は機種差)まではここでは
 * 判らない — 拡張子で判るのはコンテナまでで、中身の判定は再生してみるしかない。
 */
const INLINE_EXTENSIONS = ['mp4', 'mov', 'webm'];

/** ssh リモートか(判別は URI スキームのみ=契約⑥)。 */
function isRemote(uri: string): boolean {
	return /^ssh:/i.test(uri);
}

/** インライン再生できるコンテナか(`isSvg` と同じく末尾の拡張子だけを見る)。 */
function hasInlineContainer(uri: string): boolean {
	const lower = uri.toLowerCase();
	return INLINE_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
}

/**
 * この動画をどう見せるか。呼ぶのは `detectFileType` が `video` と答えた URI だけ
 * (= `DisplayResult.videoSrc` が付いている文書)。
 */
export function videoViewMode(uri: string): VideoViewMode {
	if (isRemote(uri)) return 'remote';
	return hasInlineContainer(uri) ? 'inline' : 'unsupported-container';
}

/**
 * `<video src>` に載せる `vellis-asset:` URI。
 *
 * 変換そのものは画像(`toImageSrc`)・3D モデルと同じ `toAssetUri`。要件#27 で
 * このプロトコルが Range/206 に対応したので、`<video>` はシークのたびに必要な
 * 範囲だけを取りに行ける(全量を読み込まずに再生が始まる)。
 */
export function toVideoSrc(absoluteUri: string): string {
	return toAssetUri(absoluteUri);
}

/**
 * プレースホルダの「既定アプリで開く」を押したときの実行計画(要件#19 の opener 再利用)。
 *
 * OS パスへの変換はコンテキストメニューと同じ `pathForReveal` — 同じファイルを
 * 右クリックから開いても、プレースホルダから開いても同じパスが渡る。
 * ssh は null =導線そのものを出さない(要件#19 で ssh の項目を disabled にしたのと同じ)。
 */
export function planOpenVideoExternally(
	uri: string,
): { command: 'open_path'; path: string } | null {
	if (isRemote(uri)) return null;
	return { command: 'open_path', path: pathForReveal(uri) };
}
