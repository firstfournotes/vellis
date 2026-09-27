/**
 * 新しいタブ(requirements.md #62)。
 *
 * タブの実体は macOS 標準のウィンドウタブで、1タブ=既存の Vellis ウィンドウ1枚
 * (契約1)。新しいタブは Rust の `new_tab` command 1本で開く — `create_window` で
 * 窓を作り、呼んだ窓の NSWindow のタブバーへ今のタブの右隣に加える(契約4)。
 *
 * 入口は3つ — File ▸ New Tab(Command + T)・ツリーの Command + クリック・
 * 右クリックの Open in New Tab(契約3)— だが、どれも下の1本の列を通る:
 * 今の窓の状態を集める → 計画する(純関数)→ `new_tab` を呼ぶ。
 *
 * 新しいタブの中身(契約4)= 今の窓と同じ root・指定したファイル(Command + T では
 * 無し)・今の窓の展開。展開を引き継ぐのは、同じ root のタブでツリーを掘り直させない
 * ため(起案時判断 (d))。整形は複製(要件#34)と同じ `normalizeExpandedDirs`。
 *
 * 失敗の catch と alert は呼ぶ側の合流点(+page.svelte・Explorer.svelte)。
 * ここは reject をそのまま伝える(duplicate-window / open-in-new-window と同じ分担)。
 */
import { invoke } from '$lib/ipc';
import { listen } from '$lib/events';
import { normalizeExpandedDirs } from '$lib/reload-state';

/** Rust のメニュー項目(menu.rs の MENU_NEW_TAB_EVENT)→ Webview の通知イベント名。 */
export const MENU_NEW_TAB_EVENT = 'menu_new_tab';

/**
 * 今の窓の状態(複製の DuplicateSnapshot と同じ3点セットの形)。
 * `rootUri` は未設定(履歴選択画面・`init_window` 前)のとき null または空文字。
 */
export type NewTabSnapshot = {
	rootUri: string | null;
	docUri: string | null;
	expandedDirs: Iterable<string>;
};

/** `new_tab` に渡す引数。Rust 側は verbatim に登録する(要件#34 の Rust 契約と同じ)。 */
export type NewTabArgs = { root: string; path: string | null; expandedDirs: string[] };

/**
 * スナップショット → `new_tab` の引数(純関数)。
 *
 * root が無ければ null =何もしない。履歴選択画面の窓には並べる root が無い(契約3)。
 * 複製と違って「引数なしの窓」に落とさないのは、タブは今の窓の root に並べるもので、
 * root の無いタブは誰とも合流しない(=ただの新しい窓になる)ため。
 */
export function planNewTab(snapshot: NewTabSnapshot): NewTabArgs | null {
	const root = snapshot.rootUri;
	if (root === null || root === '') return null;
	return {
		root,
		path: snapshot.docUri,
		expandedDirs: normalizeExpandedDirs(root, snapshot.expandedDirs)
	};
}

/**
 * 計画したタブを開く。解決値は新しいタブ(=窓)のラベル。
 *
 * `new_window` と `set_root` は呼ばない — タブに加えるのは Rust の `new_tab` の仕事で、
 * root を開くのも履歴に残すのも新しいタブ側の `init_window` の仕事。今のタブは
 * 何も動かないので、未保存の編集があっても確認は挟まない。
 */
export async function openNewTab<Label = string>(plan: NewTabArgs): Promise<Label> {
	return await invoke<Label>('new_tab', {
		path: plan.path,
		root: plan.root,
		expandedDirs: plan.expandedDirs
	});
}

/**
 * 新しいタブを開けなかったことを伝える文言(要件#35 ③・要件#51=英語)。
 * `console.warn` に留めないのは、タブが開かない失敗には手応えが一切無いため
 * (要件#34 / #59 と同じ判断)。
 */
export function newTabFailedMessage(err: unknown): string {
	return `Could not open a new tab: ${err}`;
}

/** メニュー起点の新しいタブを受け取る配線側のハンドラ。 */
export type NewTabHandlers = {
	/** 今の窓の状態を集める。発火のたびに呼ばれる(押した時点の root・展開)。 */
	getSnapshot: () => NewTabSnapshot;
	/** タブが開けたときだけ呼ばれる(引数は新しいタブのラベル)。 */
	onOpened: (opened: unknown) => void;
	/** 失敗の通知先。省略可 — 省略しても例外は外へ出さない。 */
	onError?: (err: unknown) => void;
};

/**
 * File ▸ New Tab のイベントを購読し、実行列を引き受ける。返り値は購読の解除関数。
 *
 * Command + T は空のタブ=文書は引き継がない(契約4)。root の無い窓では何もしない。
 * 失敗は `onError` に渡し、イベントハンドラの外へは投げない
 * (registerDuplicateWindowListener と同じ家風)。
 */
export async function registerNewTabListener(handlers: NewTabHandlers): Promise<() => void> {
	const run = async (): Promise<void> => {
		try {
			const plan = planNewTab({ ...handlers.getSnapshot(), docUri: null });
			if (plan === null) return;
			handlers.onOpened(await openNewTab(plan));
		} catch (err) {
			handlers.onError?.(err);
		}
	};

	const unlisten = await listen<unknown>(MENU_NEW_TAB_EVENT, () => run());
	return () => unlisten();
}
