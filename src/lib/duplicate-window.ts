/**
 * ウィンドウの複製(requirements.md #34)。
 *
 * 「開いているウィンドウと同じ内容の新規ウィンドウを開く」のフロント側の
 * 持ち場を一箇所に集める。起動導線は2つ — File メニューの Duplicate Window
 * (CmdOrCtrl+Shift+N)とツリーの右クリック(アイテムメニュー末尾・空白部)—
 * だが、どちらも下の1本の列を通る: 現在の状態を集める → 新窓の引数を計画する
 * → `new_window` を呼ぶ。
 *
 * 契約(2026-08-29 由谷決定):
 * - ①「同じ内容」= `{rootUri, docUri, expandedDirs}` の3点セット。reload をまたぐ
 *   スナップショット(要件#10)と同じ範囲で、スクロール位置・マーク一覧の開閉は
 *   対象外・ペイン幅は全窓共有(要件#9)なので複製の対象にならない
 * - ④ root 未設定(履歴選択画面)の窓の複製=履歴選択画面をもう1枚。項目を
 *   グレーアウトはしない — 引数なしで `new_window` を呼べば New Window と同じ状態になる
 *
 * Rust 側(`src-tauri/src/menu.rs`)はメニュー項目とアクセラレータを持ち、
 * クリックでフォーカス中のウィンドウへ下のイベントを emit するだけ。複製の中身を
 * 知っているのは窓そのものなので、集めるのも呼ぶのもこちら側にある
 * (menu-open.ts と同じ分担)。新窓側の復元(root → 文書 → 展開)は
 * `init_window` の応答を使う既存の初期化経路が担う。
 */
import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import { normalizeExpandedDirs } from '$lib/reload-state';

/** Rust のメニュー項目 → Webview の通知イベント名(ペイロードなし)。 */
export const MENU_DUPLICATE_WINDOW_EVENT = 'menu_duplicate_window';

/**
 * 複製元の現在状態(契約①の3点セット)。
 *
 * `rootUri` は未設定(履歴選択画面・`init_window` 前)のとき null または空文字。
 * 展開集合は配線側が配列で持つが、Set で渡されても困らないよう Iterable で受ける
 * (reload-state の `ReloadSnapshotInput` と同じ形)。
 */
export type DuplicateSnapshot = {
	rootUri: string | null;
	docUri: string | null;
	expandedDirs: Iterable<string>;
};

/** `new_window` に渡す引数。Rust 側は verbatim に登録する(要件#34 の Rust 契約)。 */
export type DuplicateWindowArgs = {
	path: string | null;
	root: string | null;
	expandedDirs: string[];
};

/**
 * スナップショット → `new_window` の引数(純関数)。
 *
 * root が無ければ何も引き継がない: 履歴選択画面の窓には複製すべき中身が無いので、
 * 引数なし= New Window と同じ状態にする(契約④)。文書と展開は root があって
 * はじめて意味を持つので、root が無いときは持っていても捨てる。
 *
 * 展開集合の整形(重複除去・初出順・root 配下のみ)は reload-state と同じ規則を
 * 使う — 同じ3点セットの整形を2通り持たないため。Rust 側は何も足さず何も引かない
 * ので、整形の持ち場はここだけになる。
 */
export function planDuplicateWindow(snapshot: DuplicateSnapshot): DuplicateWindowArgs {
	const root = snapshot.rootUri;
	if (root === null || root === '') return { path: null, root: null, expandedDirs: [] };
	return {
		path: snapshot.docUri,
		root,
		expandedDirs: normalizeExpandedDirs(root, snapshot.expandedDirs),
	};
}

/**
 * スナップショットの内容で新しいウィンドウを開く。解決値は新窓のラベル。
 *
 * メニュー起点(下の購読)とツリーの右クリック起点が共有する唯一の実行列。
 * `set_root` はここでは呼ばない — root を開くのも履歴に残すのも新窓側の
 * `init_window` の仕事で、複製元が代わりに触ると現在の窓の状態が動いてしまう。
 */
export async function duplicateWindow<Label = string>(
	snapshot: DuplicateSnapshot,
): Promise<Label> {
	return await invoke<Label>('new_window', planDuplicateWindow(snapshot));
}

/**
 * 複製に失敗したことを伝える文言(要件#35 ③。エラー内容はそのまま挟む)。
 * メニュー起点・右クリック起点のどちらも +page.svelte の合流点でこれを使う。
 */
export function duplicateWindowFailedMessage(err: unknown): string {
	return `Could not duplicate window: ${err}`;
}

/** メニュー起点の複製を受け取る配線側のハンドラ。 */
export type DuplicateWindowHandlers = {
	/**
	 * 複製する内容を集める。発火のたびに呼ばれる — 複製は「押した時点の内容」で
	 * あって、購読した時点の内容ではない。
	 */
	getSnapshot: () => DuplicateSnapshot;
	/** 新窓が開けたときだけ呼ばれる(引数は新窓のラベル)。 */
	onOpened: (opened: unknown) => void;
	/** 失敗の通知先。省略可 — 省略しても例外は外へ出さない。 */
	onError?: (err: unknown) => void;
};

/**
 * メニューイベントを購読し、複製の実行列を引き受ける。返り値は購読の解除関数。
 *
 * 失敗は `onError` に渡し、イベントハンドラの外へは投げない(menu-open と同じ家風)。
 * メニュー起点の失敗が unhandled rejection になると、ユーザーには「押しても何も
 * 起きない」としか見えないため。
 */
export async function registerDuplicateWindowListener(
	handlers: DuplicateWindowHandlers,
): Promise<() => void> {
	const run = async (): Promise<void> => {
		try {
			handlers.onOpened(await duplicateWindow(handlers.getSnapshot()));
		} catch (err) {
			handlers.onError?.(err);
		}
	};

	const unlisten = await listen<unknown>(MENU_DUPLICATE_WINDOW_EVENT, () => run());
	return () => unlisten();
}
