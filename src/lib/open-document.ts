/**
 * 文書を開く一手(requirements.md #16 ⑦・#22)。
 *
 * これまで「開く」は `invoke('open_document')` 一本だったが、ラスタ画像は
 * UTF-8 テキストとして読めない(`FsError::InvalidUtf8`)ため、読まずに URI だけで
 * 表示する経路が要る。どの経路になるかは `readsAsText` が一箇所で決め、
 * 呼ぶ側(ツリークリック・起動時引数・メニュー Open…)は結果を画面へ移すだけにする。
 *
 * ラスタ画像も文書セッションは張る(要件#22): `open_binary_document` は
 * 読まない監視だけを張るコマンドで、これを通ることで変更の自動反映・削除時の
 * 自動クローズ・reload 復元(要件#10)がテキスト文書と同じ機構に乗る。
 * SVG はテキスト経路のままなのでどれも従来どおり効く。
 */
import { invoke } from '$lib/ipc';
import { readsAsText } from '$lib/image-viewing';
import type { DocumentPayload } from '../stores/window-state.svelte';

/**
 * 開く URI に対応する文書コマンド。テキストとして読めるものは `open_document`、
 * ラスタ画像は読まない監視だけを張る `open_binary_document`(要件#22)。
 */
export function openCommandFor(uri: string): 'open_document' | 'open_binary_document' {
	return readsAsText(uri) ? 'open_document' : 'open_binary_document';
}

/** URI を表示用に開く。どちらの経路でも文書セッションが張られる。 */
export async function openForDisplay(uri: string): Promise<DocumentPayload> {
	return await invoke<DocumentPayload>(openCommandFor(uri), { uri });
}

/**
 * この窓で文書を開けなかったときの alert の文言(要件#71 契約2・5)。理由は Rust の
 * エラー文をそのまま挟む(要件#51 の素通し)。値は Recent Files の
 * `recentFileOpenFailedMessage` と同じ(契約7)。
 */
export function openFileFailedMessage(err: unknown): string {
	return `Could not open the file: ${err}`;
}

/** `openInitialDocument` が使う手段(+page は openForDisplay / windowState.setDocument / alert)。 */
export type OpenInitialDocumentDeps<Doc = DocumentPayload> = {
	open: (uri: string) => Promise<Doc>;
	setDocument: (doc: Doc) => void;
	/** 開けなかったとき。整形済みの文言(`openFileFailedMessage`)が渡る。 */
	onOpenFailed: (message: string) => void;
};

/**
 * 起動処理の最初の文書(要件#71 契約5)。`initialPath` が無ければ何もせず `false`。
 * 開けたら `setDocument` して `true`。開けなければ `onOpenFailed` で 1 回知らせて `false`。
 *
 * **決して reject しない**: 起動処理はこのあと変更通知の購読と起動の完了へ進むので、
 * 最初の文書が開けなくても窓はツリーを見せたまま生きている(新しい窓・新しいタブ・
 * `vellis <開けないファイル>` の経路)。
 */
export async function openInitialDocument<Doc = DocumentPayload>(
	initialPath: string | null | undefined,
	deps: OpenInitialDocumentDeps<Doc>
): Promise<boolean> {
	if (!initialPath) return false;
	let doc: Doc;
	try {
		doc = await deps.open(initialPath);
	} catch (err) {
		deps.onOpenFailed(openFileFailedMessage(err));
		return false;
	}
	deps.setDocument(doc);
	return true;
}
