/**
 * HTML ビューア表示中の印刷(requirements.md #38)。
 *
 * 「HTML ビューア表示中も ⌘P(File > Print…)で表示中のレンダリング結果を
 *  印刷できる」— backlog #82 のバグ修正。
 *
 * 印刷は元々 menu.rs の `Webview::print()`(メインフレーム対象)+ `print.css` の
 * 「`.markdown-body` だけを紙へ」設計で、HtmlViewer の中身は sandbox iframe
 * (srcdoc)にあるため印刷出力に展開されず、HTML を開いて ⌘P を押すと白紙が出て
 * いた。直し方は「iframe を紙に載せる」ではなく **印刷専用のウィンドウを1枚**
 * (Rust 側 `print_html`)で、画面と同じ前処理済みスナップショットをそこへ実 URL で
 * 読ませてから印刷する(方式=案a′。プローブ実測で確定、requirements.md #38)。
 *
 * 契約(2026-08-30 登録):
 * - ② 印刷内容=画面の HtmlViewer と同じ前処理済みスナップショット
 *   (`buildSrcdoc` そのもの)。要件#8 の安全対策は印刷経路でも全部維持する —
 *   印刷窓は sandbox iframe の外なので、スクリプトを止めるのは文書に差す
 *   [`PRINT_CSP_META`] と、Rust 側 protocol 応答の CSP ヘッダの二重化になる
 * - ④ markdown / text の印刷経路は変えない。メニューのクリックが直接
 *   `Webview::print()` を呼ぶ代わりにこのモジュールを経由するようになるだけで、
 *   終端は従来どおり当該窓の `Webview::print()`(= `print_current_window`)で、
 *   `print.css` の `@media print` もそのまま効く
 * - ⑤ ズーム(要件#36)は紙に持ち込まない=印刷文書は常に等倍
 *   ([`buildPrintDocument`] が zoom 引数を持たないのがその形)
 * - ⑥ ssh リモートの HTML も同じ経路([`printRouteFor`] が URI を見ない)
 *
 * Rust 側(`src-tauri/src/menu.rs`)はメニュー項目とアクセラレータを持ち、
 * クリックでフォーカス中のウィンドウへ [`MENU_PRINT_EVENT`] を emit するだけ。
 * 何を印刷するのか(表示中のビューア種別と、表示中の HTML の生テキスト)を
 * 知っているのは窓そのものなので、判定するのも組み立てるのもこちら側にある
 * (menu-open.ts / duplicate-window.ts / zoom.ts と同じ分担)。
 */
import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import type { FileType } from './file-type';
import { buildSrcdoc, injectionOffset } from './html-viewer';

/**
 * Rust のメニュー項目 → Webview の通知イベント名(ペイロードなし)。
 * `src-tauri/src/menu.rs` の同名定数と同じリテラル。
 */
export const MENU_PRINT_EVENT = 'menu_print';

/**
 * 印刷文書に差す CSP(要件#8 の安全対策を印刷経路でも維持する=契約②)。
 *
 * 画面の HtmlViewer では sandbox(`allow-scripts` なし)と、srcdoc がアプリ窓から
 * 継承する CSP がスクリプトを二重に止めている。印刷窓にはそのどちらも無い —
 * 文書はそれ自身がメインフレームなので、止めるのは文書自身の CSP と、Rust 側
 * protocol 応答の CSP ヘッダ(`src-tauri/src/print.rs` の `PRINT_CSP`)になる。
 * 値は両者で同じものを書く。
 *
 * `script-src 'none'` と `object-src 'none'` だけを指定して `default-src` は
 * 置かない: 画像・スタイル・フォントは `<base>` 経由で `vellis-asset:` から
 * 画面と同じように読ませたいので、絞るのは「実行されるもの」だけに留める。
 */
export const PRINT_CSP_META =
	'<meta http-equiv="Content-Security-Policy" ' +
	'content="script-src \'none\'; object-src \'none\'">';

/**
 * 印刷用の完全な HTML 文書(純関数)。
 *
 * 画面の srcdoc(`buildSrcdoc`)に [`PRINT_CSP_META`] を1つ差しただけのもので、
 * それ以外はバイト単位で同一 — リンク退避も `<base>` 注入もエスケープ済み
 * テキストの不改変も、画面の安全性がそのまま紙に乗る(契約②)。差分を CSP の
 * 1挿入に限るために、ウィンドウタイトルのような印刷窓の都合は文書に足さない
 * (タイトルは `WebviewWindowBuilder` 側が持つ)。
 *
 * 倍率は取らない(契約⑤)。`buildSrcdoc` を既定の等倍で呼ぶので、画面が 200%
 * でも紙は等倍 — markdown / text の印刷が `print.css` で倍率非依存なのと同じ。
 *
 * 挿入位置は `buildSrcdoc` が `<base>` を差したのと同じ場所(`injectionOffset`)。
 * `<head>` のある文書では head 内、素片では本文より前になり、どちらでも CSP が
 * 実効になる(パーサが素片の `<meta>` を head へ持ち上げる)。
 */
export function buildPrintDocument(content: string, docUri: string): string {
	const srcdoc = buildSrcdoc(content, docUri);
	const at = injectionOffset(srcdoc);
	return srcdoc.slice(0, at) + PRINT_CSP_META + srcdoc.slice(at);
}

/**
 * ⌘P の行き先。`print-window` = 印刷専用ウィンドウ(HTML 用の新経路)、
 * `main-frame` = 当該窓のメインフレーム印刷(従来の経路)。
 */
export type PrintRoute = 'print-window' | 'main-frame';

/**
 * 表示中のビューア種別から印刷経路を選ぶ(純関数)。
 *
 * 印刷窓へ回すのは html だけで、他の型は1つ残らず従来のメインフレーム印刷に
 * 残る(契約④)。入力は `FileType` だけ — URI を取らないので、ssh リモートの
 * HTML もローカルの HTML と同じ経路になる(契約⑥)。
 */
export function printRouteFor(type: FileType): PrintRoute {
	return type === 'html' ? 'print-window' : 'main-frame';
}

/**
 * 印刷に失敗したことを伝える文言(要件#35 ③。エラー内容はそのまま挟む)。
 * 黙って何も起きないと「⌘P が効かない」= 直したはずのバグと見分けが付かない。
 */
export function printFailedMessage(err: unknown): string {
	return `Could not print: ${err}`;
}

/** メニュー起点の印刷を受け取る配線側のハンドラ。 */
export type PrintHandlers = {
	/**
	 * いま表示しているビューアの種別。発火のたびに呼ばれる — 経路は「押した
	 * 時点の表示」で決まるのであって、購読した時点の表示ではない(zoom.ts の
	 * `isTarget` と同じ理由)。
	 */
	getFileType: () => FileType;
	/**
	 * 表示中の HTML の生テキストと文書 URI。html 経路のときだけ呼ばれる。
	 */
	getHtmlSource: () => { content: string; docUri: string };
	/** 失敗の通知先。省略可 — 省略しても例外は外へ出さない。 */
	onError?: (err: unknown) => void;
};

/**
 * [`MENU_PRINT_EVENT`] を購読し、経路判定と印刷の実行列を引き受ける。
 * 返り値は購読の解除関数。
 *
 * 購読は `$lib/events` 経由=現在のウィンドウ限定(要件#33)。Rust 側は
 * フォーカス中の窓へ `emit_to` するので、他の窓が同時に印刷を始めることはない。
 *
 * 失敗は `onError` に渡し、イベントハンドラの外へは投げない(menu-open と同じ
 * 家風)。メニュー起点の失敗が unhandled rejection になると、ユーザーには
 * 「押しても何も起きない」としか見えないため。
 */
export async function registerPrintListener(handlers: PrintHandlers): Promise<() => void> {
	const run = async (): Promise<void> => {
		try {
			if (printRouteFor(handlers.getFileType()) === 'main-frame') {
				// 従来の終端。Rust 側は invoke 元=この窓の `Webview::print()` を
				// 呼ぶだけで、紙の体裁は `print.css` が決める(契約④)。
				await invoke('print_current_window');
			} else {
				const { content, docUri } = handlers.getHtmlSource();
				await invoke('print_html', { document: buildPrintDocument(content, docUri) });
			}
		} catch (err) {
			handlers.onError?.(err);
		}
	};

	const unlisten = await listen<unknown>(MENU_PRINT_EVENT, () => run());
	return () => unlisten();
}
