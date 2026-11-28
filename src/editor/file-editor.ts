/**
 * コードのファイルと plain text の面(`CodeEditor.svelte`)を窓の状態・保存の経路につなぐ口
 * (要件#74 契約12〜16・契約19 の「第1段の作り」5〜7)。
 *
 * 面は mount で `windowState.fileEditor` に自分の handle を置き、unmount で外す。未保存の確認・
 * 削除の帯・Reload File・Command + S はこの handle を通して新しい面の dirty と文書を扱う。
 */
import type { EditorView } from 'prosemirror-view';
import type { MarkdownDocument } from './markdown-document';
import type { FileChangedDecision } from '$lib/document-edit';
import { invoke } from '$lib/ipc';
import { windowState, type DocumentPayload } from '../stores/window-state.svelte';
import { merge3 } from './merge';

export interface FileEditorHandle {
	/** 面の種類(コードと plain text=CodeMirror・Markdown=ProseMirror)。 */
	readonly kind?: 'text' | 'markdown';
	readonly uri: string;
	readonly readOnly: boolean;
	/** 文字列の比較(documentText !== 基準の版)。 */
	readonly dirty: boolean;
	/** 重なった外部変更(帯を出している間)。 */
	readonly conflict: boolean;
	/** 重ならずに取り込んだ知らせ(数秒で消える)。出していなければ null。 */
	readonly notice: string | null;
	/** documentText。 */
	text(): string;
	/** contentHash(基準の版)=保存の照合に渡す。 */
	expectedHash(): string;
	/** 基準の版 ← text・自己書き込みのハッシュを覚える・dirty を消す。 */
	markSaved(text: string): void;
	/** 自己書き込みのエコー → 'ignore-echo'(取引なし)/ dirty でない・clean なマージ → 'apply' / 重なる → 'external-conflict'。 */
	applyFileChanged(payload: DocumentPayload): FileChangedDecision;
	/** 文書を残し、基準の版を届いた内容へ(次の保存は上書き)。 */
	keepMyEdits(): void;
	/** 届いた内容を読み直す(dirty でなくなる)。 */
	useFileOnDisk(): void;
	/** 保存の照合が衝突を返した(ディスクが基準の版と違う)。重なりの帯を出す。 */
	showSaveConflict(): void;
	/** 文書モデルを作り直す(Reload File・同じ URI の開き直し。履歴 0・dirty でない)。 */
	reset(content: string): void;
	/** File ▸ Print… の前に、刷る描画(今の文字列を Shiki の `<pre>` にしたもの)を作っておく。 */
	preparePrint(): Promise<void>;
	/**
	 * 第3段 3-3: 今の語の現在の一致を replacement に替え、替えた文字の終わり以降の最初の一致を現在に。語が空・一致なしなら false。
	 * CodeMirror の面(コード・plain text・raw)だけが持つ(Markdown の rendered・読み取り専用では undefined)。
	 */
	replaceCurrent?(replacement: string): boolean;
	/** 第3段 3-3: 今の語の全部を取引 1 つで替える。返り値は替えた数。 */
	replaceAll?(replacement: string): number;
	/**
	 * 第4段 4-2・4-1: 面の中身(文字列・選択・基準の版)が変わるたびに進む数(読むと反応する)。書式のツールバーの押下と、
	 * 開いている差分の画面の作り直しが追う。
	 */
	readonly version?: number;
	/** 第4段 4-1: 基準の版(Save が照合する中身=未保存の差分の左側)。面は必ず持つ(テストの代役の handle は持たなくてよい)。 */
	baseText?(): string;
	/** 第4段 4-1: 重なりの帯の相手(届いた内容)。保存の照合の衝突から来たときはディスクを読み直して返す。衝突でなければ null。 */
	conflictText?(): Promise<string | null>;
	/**
	 * 要件#89 契約11: マージの Apply。`merged` を面に取引 1 つで入れる(履歴に積む=Command + Z 1 回で前の文字列に戻る。
	 * 外部変更の取り込みとは違い履歴に残す)。基準の版を `disk`(マージに使ったディスクの版)にし、重なりを下ろす。
	 * dirty は文字列の比較のまま。次の Command + S は contentHash(disk) で照合する。面は必ず持つ(テストの代役の handle は持たなくてよい)。
	 */
	applyMerge?(merged: string, disk: string): void;
}

/** Markdown の編集面(ProseMirror)の handle(要件#74 第2段)。 */
export interface MarkdownEditorHandle extends FileEditorHandle {
	readonly kind: 'markdown';
	readonly view: EditorView;
	/** raw(原文の CodeMirror)の面を出しているか(契約23)。 */
	readonly raw: boolean;
	/** rendered ⇄ raw。変換中なら確定の後に 1 回だけ切り替える。 */
	toggleRaw(): void;
	/** 今の文書モデル(state・origin・generation・base)。書き出しの段を外から見る口。 */
	model(): MarkdownDocument;
	/** Link… でリンクの外だった: 面の上に URL の入力欄を出す(選択が空で単語の上でもなければ何もしない)。 */
	openLinkInput?(): void;
	/** Image…: ファイルを選ぶダイアログを出し、文書からの相対パスの画像を入れる。 */
	chooseImage?(): void;
}

export const MERGED_NOTICE = 'This file was changed on disk. The changes were merged.';
export const CONFLICT_MESSAGE = 'This file was changed on disk. It overlaps your edits.';
/** Rust の `save_document` が照合に失敗したときのエラーの接頭辞(契約14)。 */
export const SAVE_CONFLICT_PREFIX = 'The file was changed on disk';

/** 届いた内容 `incoming` の当て方(契約12・13)。面(CodeMirror・ProseMirror・raw)に依らない純関数。 */
export type ExternalChangePlan =
	/** 今の文書と同じ: 文書は触らず、基準の版だけを進める。 */
	| { kind: 'same' }
	/** 未編集: 文書を届いた内容に置き換える。 */
	| { kind: 'replace'; text: string }
	/** 編集中で重ならない: 3 方向マージの結果に置き換えて知らせる。 */
	| { kind: 'merged'; text: string }
	/** 編集中で重なる: 文書は触らず、帯で選ばせる。 */
	| { kind: 'conflict' };

export function planExternalChange(o: { base: string; current: string; incoming: string; dirty: boolean }): ExternalChangePlan {
	if (o.incoming === o.current) return { kind: 'same' };
	if (!o.dirty) return { kind: 'replace', text: o.incoming };
	const merged = merge3(o.base, o.current, o.incoming);
	return merged.kind === 'clean' ? { kind: 'merged', text: merged.text } : { kind: 'conflict' };
}

/** ディスクの今の中身。読めなければ知らせて null。 */
export async function readDiskText(uri: string): Promise<string | null> {
	try {
		const doc = await invoke<DocumentPayload>('open_document', { uri });
		return doc.content;
	} catch (err) {
		alert(`Could not read the file: ${err}`);
		return null;
	}
}

/**
 * 衝突の相手の版に `apply` を当てる。`theirs` は重なった外部変更の中身。保存の照合の衝突から来たとき(null)は
 * ディスクの今の版を読み直す(読めなければ何もしない)。
 */
export function withDiskVersion(uri: string, theirs: string | null, apply: (disk: string) => void): void {
	if (theirs !== null) apply(theirs);
	else
		void readDiskText(uri).then((read) => {
			if (read !== null) apply(read);
		});
}

/** 窓の文書(currentDocument)を基準の版にそろえる(page の再描画・Copy の元)。別の文書を開いていれば何もしない。 */
export function syncWindowDocument(uri: string, next: string, modified?: number | null): void {
	const doc = windowState.currentDocument;
	if (!doc || doc.uri !== uri) return;
	windowState.currentDocument = { ...doc, content: next, modified: modified ?? doc.modified };
}

/**
 * Command + S / File ▸ Save / 削除の帯の Save / 未保存の確認の Save の共通の経路(契約14)。
 *
 * 読み取り専用・変更なし(削除の印も無い)なら何もしない。削除の印が立っていればディスクに版が無いので
 * 照合しない(`expectedHash` を鍵ごと省く)。成功したら面と窓の両方に保存済みを記帳する。照合の失敗は
 * 重なりの帯にし(dirty のまま)、ほかの失敗は知らせる。どちらも例外を外へ出さない。
 */
export async function saveFileEditor(handle: FileEditorHandle): Promise<void> {
	if (handle.readOnly) return;
	const removed = windowState.externalRemoved;
	if (!handle.dirty && !removed) return;
	const content = handle.text();
	const args: Record<string, string> = removed
		? { uri: handle.uri, content }
		: { uri: handle.uri, content, expectedHash: handle.expectedHash() };
	try {
		await invoke<void>('save_document', args);
	} catch (err) {
		if (String(err).startsWith(SAVE_CONFLICT_PREFIX)) {
			handle.showSaveConflict();
			return;
		}
		alert(`Could not save: ${err}`);
		return;
	}
	handle.markSaved(content);
	windowState.markSaved(content);
}
