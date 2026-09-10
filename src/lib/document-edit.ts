/**
 * その場編集の純関数 VM(要件#48)。
 *
 * 「閲覧専用(FR-02)撤廃の第1段」を支える判断を、状態(`WindowState`)にも
 * DOM(`Viewer`)にも依存しない純関数へ集めた置き場。`image-viewing.ts` の
 * `svgViewMode` と同じ整理で、「いま何ができるか / 届いた変更をどう扱うか」を
 * ここが決め、呼ぶ側は結果を状態と画面へ移すだけにする。
 *
 * 4つの判断を持つ:
 * - `canEnterEdit` — 編集に入れる種別と root(契約①②)
 * - `isDirty` — 編集バッファと保存済み content の byte 等価(契約④)
 * - `contentHash` / `decideFileChanged` — 自己書き込みエコーの抑止と
 *   外部変更衝突の3分岐(契約⑥)
 * - `bufferFromPre` — `<pre contenteditable>` から原文を取り出す(契約②)
 */
import type { FileType } from './file-type';

/** 表示モードの2値。編集は明示操作でしか始まらない(契約③)。 */
export type EditMode = 'view' | 'edit';

/**
 * Edit メニュー「Edit」(⌘E)のクリックがフロントへ届くイベント名(契約③・追補b)。
 *
 * `menu.rs` の `MENU_EDIT_EVENT` と綴りを合わせること。閲覧⇄編集のトグルで、
 * 本文のダブルクリックと同じ「明示操作」の1つ。html 種別にとってはこれが唯一の
 * 入口でもある — 閲覧中の html は `HtmlViewer` の sandbox された iframe の中に
 * あり、本文のダブルクリックがアプリまで届かない。
 */
export const MENU_EDIT_EVENT = 'menu_edit';

/**
 * 編集に入れるファイル種別。text はその場編集、markdown / html は
 * 「ソース編集モード」= RAW をプレーンテキストとして編集する(契約②)。
 */
export type EditableKind = Extract<FileType, 'text' | 'markdown' | 'html'>;

const EDITABLE_KINDS: ReadonlySet<FileType> = new Set<FileType>(['text', 'markdown', 'html']);

/**
 * この文書を編集モードへ入れてよいか(契約①②)。
 *
 * 画像・3D・動画・PDF・バイナリは `<pre contenteditable>` 経路の対象外なので不可。
 * SSH root は種別を問わず不可 — 初版の `SshProvider::write_text` は Unsupported で、
 * 保存できない文書を編集させると必ず捨てる編集になる(SSH は読み取り専用のまま)。
 */
export function canEnterEdit(fileType: FileType, uri: string): boolean {
	if (!EDITABLE_KINDS.has(fileType)) return false;
	return !uri.startsWith('ssh://');
}

/**
 * 編集バッファが保存済み content と違うか(契約④)。
 *
 * **正規化しない**のが要点。CRLF を LF へ潰したり BOM を無視したりすると、
 * 「見た目は同じだから dirty ではない」と判断した後の保存で原文の改行や BOM が
 * 壊れる。保存されるのはバッファそのものなので、比較も byte のまま行う。
 */
export function isDirty(buffer: string, saved: string): boolean {
	return buffer !== saved;
}

/**
 * content の同値判定に使う短いハッシュ(契約⑥)。
 *
 * 依存追加なし(契約⑦)なので自前で持つ。FNV-1a と djb2 の 32bit を並走させ、
 * 文字数と合わせて連結する — 単独の 32bit より衝突しにくく、`lastSavedHash` として
 * `WindowState` に持てる短い文字列で済む。用途は「保存した内容がそのまま返って
 * きたか」の判定だけで、暗号学的な強度は要らない(改竄の検知ではない)。
 */
export function contentHash(content: string): string {
	let fnv = 0x811c9dc5;
	let djb = 5381;
	for (let i = 0; i < content.length; i += 1) {
		const code = content.charCodeAt(i);
		fnv = Math.imul(fnv ^ code, 0x01000193) >>> 0;
		djb = (Math.imul(djb, 33) + code) >>> 0;
	}
	return `${content.length.toString(36)}-${fnv.toString(36)}-${djb.toString(36)}`;
}

/** `file_changed` 1件をどう扱うか(契約⑥)。 */
export type FileChangedDecision =
	/** 通常どおり文書を差し替える。 */
	| 'apply'
	/** 自分の保存が返ってきただけ。何もしない(編集 DOM を再レンダーで壊さない)。 */
	| 'ignore-echo'
	/** 編集中の変更と衝突する外部変更。再レンダーせず利用者に選ばせる。 */
	| 'external-conflict';

export type FileChangedInput = {
	/** 届いた content。 */
	incomingContent: string;
	/** 直近の保存内容のハッシュ。一度も保存していなければ null。 */
	lastSavedHash: string | null;
	/** 現在の表示モード。 */
	mode: EditMode;
	/** 編集バッファが保存済み content と違うか。 */
	dirty: boolean;
};

/**
 * 届いた `file_changed` の扱いを決める(契約⑥)。
 *
 * 判定は3段:
 * 1. 保存した内容と同じものが返ってきた(=自己書き込みのエコー)→ `ignore-echo`。
 *    モードも dirty も見ない — 閲覧中でも `setDocument` を通せば本文が作り直され、
 *    編集中なら contenteditable の DOM ごと飛ぶ。どちらも「同じ内容で作り直す」
 *    無駄でしかない
 * 2. 編集中で、かつ失うものがある(dirty)→ `external-conflict`。再レンダーせず、
 *    上書き保存か外部版の読み直しかを選ばせる
 * 3. それ以外(閲覧中・編集中でも未変更)→ `apply`。従来どおり外部版に追従する
 */
export function decideFileChanged({
	incomingContent,
	lastSavedHash,
	mode,
	dirty,
}: FileChangedInput): FileChangedDecision {
	if (lastSavedHash !== null && contentHash(incomingContent) === lastSavedHash) {
		return 'ignore-echo';
	}
	if (mode === 'edit' && dirty) return 'external-conflict';
	return 'apply';
}

/**
 * `<pre contenteditable>` の現在の内容を原文として取り出す(契約②)。
 *
 * `textContent` をそのまま返す。`renderPlainText`(file-type.ts)が `<pre>` の
 * 直後に置く `\n` は HTML パーサが1つ食うので、改行始まりのソースもここで
 * byte 等価に戻ってくる。整形も trim もしない — 触れば原文が壊れる。
 */
export function bufferFromPre(pre: HTMLElement): string {
	return pre.textContent ?? '';
}
