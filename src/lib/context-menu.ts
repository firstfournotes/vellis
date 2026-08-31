/**
 * ファイルツリーのコンテキストメニュー(要件#19)。
 *
 * ここは純ロジックだけを持つ — 項目の出し分け・URI からパスへの変換・
 * 項目を押したときの実行計画・メニュー座標のクランプ。実際の表示と
 * opener / clipboard の呼び出しは ContextMenu.svelte と ExplorerItem.svelte 側。
 */

/**
 * ツリーのアイテム。`stores/window-state.svelte` の Entry と同形だが、
 * このモジュールを単体でテストできるよう自分で型を持つ(tree-refresh と同じ家風)。
 */
export type ContextMenuEntry = { uri: string; name: string; kind: 'file' | 'dir' | 'symlink' };

export type ContextMenuItemId =
	| 'reveal'
	| 'open'
	| 'open-with'
	| 'copy-path'
	/** ウィンドウの複製(要件#34)。アイテムではなく窓に効く唯一の項目。 */
	| 'duplicate-window';

export type ContextMenuItem = {
	id: ContextMenuItemId;
	label: string;
	enabled: boolean;
};

export type ContextAction =
	| { command: 'reveal_item_in_dir'; path: string }
	| { command: 'open_path'; path: string }
	| { command: 'copy'; text: string }
	/** アプリ選択ダイアログを開く計画(要件#21)。開く対象の OS パスを持つ。 */
	| { command: 'pick-app'; path: string }
	/**
	 * ウィンドウ複製の起動(要件#34)。右クリックしたアイテムは関係しない
	 * (複製するのは窓の中身)ので、パスも URI も持たない。
	 */
	| { command: 'duplicate-window' };

/** ダイアログで選んだ .app で開く計画(要件#21 第2段)。 */
export type OpenWithAction = { command: 'open_path'; path: string; with: string };

/** ラベルは英語固定(要件#35 ①=macOS 標準用語。i18n 機構は持たない)。 */
const LABELS: Record<ContextMenuItemId, string> = {
	reveal: 'Reveal in Finder',
	open: 'Open with Default App',
	'open-with': 'Open With…',
	'copy-path': 'Copy Path',
	'duplicate-window': 'Duplicate Window'
};

/** ssh リモートか(判別は URI スキームのみ・パス内容では分岐しない=契約⑤)。 */
function isRemote(uri: string): boolean {
	return /^ssh:/i.test(uri);
}

/**
 * symlink はファイル扱いにする。フロントは指し先の種別を知らないため、
 * 項目を落とすより OS に委ねるほうが安全側(受け入れテストの確定判断)。
 */
function isDirEntry(entry: ContextMenuEntry): boolean {
	return entry.kind === 'dir';
}

/**
 * 右クリックされたアイテムからメニュー項目を組む。
 *
 * - ファイル/symlink = Reveal in Finder・Open with Default App・Open With…・Copy Path
 * - フォルダ = 既定アプリ系を出さない(Finder 表示と重複するため=契約②・#21①)
 * - ssh リモートは項目を出したまま Finder / 既定アプリ / アプリ選択を disabled(契約⑤)
 * - 末尾のウィンドウ複製(要件#34)だけは種別にもリモートにも左右されない。
 *   アイテムではなく窓に効く操作なので、無効になる状況が無い(契約#34③)。
 *   区切り線を挟むかは描画側の持ち場で、項目の並びには現れない
 */
export function buildContextMenu(entry: ContextMenuEntry): ContextMenuItem[] {
	const local = !isRemote(entry.uri);
	const ids: ContextMenuItemId[] = isDirEntry(entry)
		? ['reveal', 'copy-path', 'duplicate-window']
		: ['reveal', 'open', 'open-with', 'copy-path', 'duplicate-window'];
	return ids.map((id) => ({
		id,
		label: LABELS[id],
		enabled: id === 'copy-path' || id === 'duplicate-window' ? true : local
	}));
}

/**
 * ツリーの空白部分(アイテムの無いところ)を右クリックしたときのメニュー(要件#34③)。
 *
 * アイテムを指していないので、出せるのはアイテムに依存しない項目だけ —
 * 今のところウィンドウの複製1つ。
 */
export function buildTreePaneMenu(): ContextMenuItem[] {
	return [{ id: 'duplicate-window', label: LABELS['duplicate-window'], enabled: true }];
}

/**
 * file:// URI を OS の絶対パスへ。パーセントエンコードは復号する。
 * backend はエンコードしない生 URI も返すため(menu-open / tree-refresh と同じ前提)、
 * URL で解釈できなかったときはプレフィックスを剥がすだけに留める。
 */
function fileUriToPath(uri: string): string {
	try {
		const u = new URL(uri);
		return decodeURIComponent(u.pathname);
	} catch {
		return uri.replace(/^file:\/\//i, '');
	}
}

/** クリップボードへ載せる値: ローカル= OS パス・ssh = URI 文字列のまま(契約④)。 */
export function pathForCopy(uri: string): string {
	return isRemote(uri) ? uri : fileUriToPath(uri);
}

/**
 * reveal_item_in_dir / open_path に渡す OS パス。ssh は呼ばれない前提だが、
 * 例外を投げず文字列を返す(グレーアウトが破れたときの安全網)。
 */
export function pathForReveal(uri: string): string {
	return isRemote(uri) ? uri : fileUriToPath(uri);
}

/**
 * 項目を押したときにやることを決める。disabled な組(ssh の reveal / open)は
 * null =何もしない。
 *
 * ウィンドウの複製(要件#34)は entry を読まずに返す — 複製するのは窓の中身で、
 * 右クリックしたアイテムは「どこで押したか」でしかない。ssh でも null にしないのは
 * disabled になる組が存在しないため(null は「グレーアウトの安全網」であって、
 * 有効な項目の受け皿ではない)。リモート判定より手前に置くのはそのため。
 */
export function planContextAction(
	id: ContextMenuItemId,
	entry: ContextMenuEntry
): ContextAction | null {
	if (id === 'duplicate-window') return { command: 'duplicate-window' };
	if (id === 'copy-path') return { command: 'copy', text: pathForCopy(entry.uri) };
	if (isRemote(entry.uri)) return null;
	const path = pathForReveal(entry.uri);
	if (id === 'reveal') return { command: 'reveal_item_in_dir', path };
	if (id === 'open-with') return { command: 'pick-app', path };
	return { command: 'open_path', path };
}

/**
 * アプリ選択ダイアログの結果から実行計画を作る(要件#21②④)。
 * キャンセル(null / undefined)は null =無変化。ssh は選ばれていても実行しない。
 */
export function planOpenWith(
	entry: ContextMenuEntry,
	appPath: string | null | undefined
): OpenWithAction | null {
	if (!appPath) return null;
	if (isRemote(entry.uri)) return null;
	return { command: 'open_path', path: pathForReveal(entry.uri), with: appPath };
}

/**
 * メニュー左上の座標をビューポート内へ引き戻す(契約①のはみ出し防止)。
 * 収まるならそのまま・はみ出す分だけ戻す・負にはしない。
 */
export function clampMenuPosition(
	pos: { x: number; y: number },
	size: { width: number; height: number },
	viewport: { width: number; height: number }
): { x: number; y: number } {
	return {
		x: Math.max(0, Math.min(pos.x, viewport.width - size.width)),
		y: Math.max(0, Math.min(pos.y, viewport.height - size.height))
	};
}
