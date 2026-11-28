/**
 * raw(View ▸ Raw Source)と編集面(rendered)の行き来(要件#74 契約23・契約7・第2段の作り(案)の項目 9)。
 *
 * - rendered → raw: 文書モデルを契約6 の規則で書き出した文字列を raw に出す。選択は原文の文字の位置に写す
 *   (1・2 段目のブロックの中は文字単位で正確、3 段目のブロックの中はそのブロックの先頭)
 * - raw → rendered: raw の文字列を読み直し、差分を含むブロックだけを置き換える(前後の形が同じ Node は同一のまま=
 *   周回0 の 0-18)。raw での編集は履歴に 1 段(Command + Z でまとめて戻る)。raw の文字列が新しい原文になる
 * - 前面の窓の raw の状態を Rust に知らせる(View ▸ Raw Source のチェック印=判断 9)
 */
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection, type Selection, type Transaction } from 'prosemirror-state';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { parseMarkdownDocument, type Generation, type OriginEntry, type Run } from './from-mdast';
import { replaceChangedBlocks, type MarkdownDocument } from './markdown-document';
import { serializeMarkdown, type OriginTable } from './to-markdown';

/** lib.rs が View ▸ Raw Source で前面の窓へ送る(payload なし)。 */
export const MENU_RAW_SOURCE_EVENT = 'menu_raw_source';
/** フロント → Rust。payload { label, raw }(判断 9)。 */
export const RAW_SOURCE_STATE_EVENT = 'raw_source_state';

export interface RawSourceState {
	label: string;
	raw: boolean;
}

export interface RawSnapshot {
	/** 契約6 の書き出し */
	text: string;
	/** 原文の文字の位置 */
	anchor: number;
	head: number;
}

// ---------------------------------------------------------------------------
// 文書の位置 ⇄ 原文の位置
// ---------------------------------------------------------------------------

/** ブロックの中の文字の連なり(読み込みの runs と同じ切り方)の文書の位置。code fence は中身が空でも 1 つ。 */
function runSpans(block: PMNode, blockStart: number): Array<{ from: number; to: number }> {
	const spans: Array<{ from: number; to: number }> = [];
	const visit = (node: PMNode, pos: number) => {
		if (node.isTextblock) {
			const contentStart = pos + 1;
			if (node.type.spec.code) {
				spans.push({ from: contentStart, to: contentStart + node.content.size });
				return;
			}
			// ProseMirror は隣り合う同じ mark の text を 1 つにまとめるので、text の子 1 つ=run 1 つ
			node.forEach((child, offset) => {
				const at = contentStart + offset;
				if (child.isText) spans.push({ from: at, to: at + child.nodeSize });
			});
			return;
		}
		node.forEach((child, offset) => visit(child, pos + 1 + offset));
	};
	visit(block, blockStart);
	return spans;
}

/** run の中の文字の数(PM の中の文字)→ 原文の文字の数(code fence の \r\n は 2 文字)。 */
function runOffsetToSource(run: Run, offset: number): number {
	if (!run.eol || run.eol.length === 1) return offset;
	const lines = run.value.slice(0, offset).split('\n').length - 1;
	return offset + lines * (run.eol.length - 1);
}

function runOffsetFromSource(run: Run, sourceOffset: number): number {
	if (!run.eol || run.eol.length === 1) return sourceOffset;
	let source = 0;
	let i = 0;
	for (; i < run.value.length && source < sourceOffset; i++) source += run.value[i] === '\n' ? run.eol.length : 1;
	return i;
}

/** 最上位ブロックの番号と、その先頭の文書の位置。 */
function blockAt(doc: PMNode, pos: number): { index: number; start: number } {
	let start = 0;
	for (let i = 0; i < doc.childCount; i++) {
		const size = doc.child(i).nodeSize;
		if (pos < start + size || i === doc.childCount - 1) return { index: i, start };
		start += size;
	}
	return { index: 0, start: 0 };
}

function blockStartOf(doc: PMNode, index: number): number {
	let start = 0;
	for (let i = 0; i < index; i++) start += doc.child(i).nodeSize;
	return start;
}

/** 文書の位置 → 原文の位置(`entries` は `text` を読んだ結果で、文書の最上位ブロックと 1 対 1)。 */
function posToOffset(doc: PMNode, entries: OriginEntry[], pos: number, fallbackStart: number): number {
	const { index, start } = blockAt(doc, pos);
	const entry = entries[index];
	if (!entry) return fallbackStart;
	const spans = runSpans(doc.child(index), start);
	if (spans.length !== entry.runs.length) return entry.start;
	for (let k = 0; k < spans.length; k++) {
		const span = spans[k]!;
		// 隣り合う run の境目は後ろの run の先頭として写す
		if (pos === span.to && spans[k + 1]?.from === pos) continue;
		if (pos >= span.from && pos <= span.to) {
			const run = entry.runs[k]!;
			if (run.end <= run.start && run.value.length > 0) return entry.start;
			return Math.min(run.end, run.start + runOffsetToSource(run, pos - span.from));
		}
		if (pos < span.from) return k === 0 ? entry.start : entry.runs[k - 1]!.end;
	}
	const last = entry.runs[entry.runs.length - 1];
	return last ? last.end : entry.start;
}

/** 原文の位置 → 文書の位置。 */
function offsetToPos(doc: PMNode, entries: OriginEntry[], offset: number): number {
	const index = entries.findIndex((e) => offset <= e.end);
	if (index < 0 || index >= doc.childCount) return doc.content.size;
	const entry = entries[index]!;
	const start = blockStartOf(doc, index);
	const block = doc.child(index);
	const inside = start + 1 <= start + block.nodeSize - 1 ? start + 1 : start;
	const spans = runSpans(block, start);
	if (spans.length !== entry.runs.length || spans.length === 0) return inside;
	let found = inside;
	for (let k = 0; k < spans.length; k++) {
		const run = entry.runs[k]!;
		const span = spans[k]!;
		if (offset < run.start) return k === 0 ? (offset < entry.start ? inside : span.from) : found;
		if (offset <= run.end) return Math.min(span.to, span.from + runOffsetFromSource(run, offset - run.start));
		found = span.to;
	}
	return found;
}

/** 書き出しとそれを読み直した結果(位置の写しに使う)。 */
function serializedWithEntries(model: MarkdownDocument) {
	const result = serializeMarkdown(model.state.doc, model.origin, model.generation);
	const parsed = parseMarkdownDocument(result.text);
	const usable = parsed.doc.childCount === model.state.doc.childCount;
	return { ...result, entries: usable ? parsed.entries : null };
}

/** 書き出し 1 回ぶんの上で、文書の位置 → 原文の文字の位置。3 段目のブロックの中はそのブロックの先頭。 */
function sourceOffsetOf(doc: PMNode, serialized: ReturnType<typeof serializedWithEntries>, pos: number): number {
	const { text, segments, entries } = serialized;
	if (pos >= doc.content.size) return text.length;
	const { index } = blockAt(doc, pos);
	const segment = segments[index];
	if (!segment) return text.length;
	if (segment.stage === 3 || !entries) return segment.start;
	return posToOffset(doc, entries, pos, segment.start);
}

/** 文書の位置 → 原文(serializeMarkdown(...).text)の文字の位置。3 段目のブロックの中はそのブロックの先頭。 */
export function pmToSource(model: MarkdownDocument, pos: number): number {
	return sourceOffsetOf(model.state.doc, serializedWithEntries(model), pos);
}

/** 原文の文字の位置 → 文書の位置(その位置を含む最上位ブロックの中。1・2 段目の run の中は正確)。 */
export function sourceToPm(model: MarkdownDocument, offset: number): number {
	const { entries } = serializedWithEntries(model);
	if (!entries) return Math.max(0, Math.min(offset, model.state.doc.content.size));
	return offsetToPos(model.state.doc, entries, offset);
}

/** rendered → raw: 書き出しと、選択を写した原文の位置。 */
export function toRaw(model: MarkdownDocument): RawSnapshot {
	const doc = model.state.doc;
	const serialized = serializedWithEntries(model);
	const { anchor, head } = model.state.selection;
	return {
		text: serialized.text,
		anchor: sourceOffsetOf(doc, serialized, anchor),
		head: sourceOffsetOf(doc, serialized, head),
	};
}

function selectionAt(doc: PMNode, anchor: number, head: number): Selection {
	const clamp = (p: number) => Math.max(0, Math.min(p, doc.content.size));
	const $anchor = doc.resolve(clamp(anchor));
	const $head = doc.resolve(clamp(head));
	return TextSelection.between($anchor, $head);
}

/**
 * raw → rendered: raw の文字列を読み直す取引。変わっていれば差分を含むブロックだけを置き換えて履歴に 1 段(changed=true)、
 * 変わっていなければ選択だけ(addToHistory: false・changed=false)。選択は raw の文字の位置を写した位置。
 */
export function fromRaw(
	model: MarkdownDocument,
	raw: string,
	cursor: { anchor: number; head: number },
): { tr: Transaction; origin: OriginTable; generation: Generation; changed: boolean } {
	const state = model.state;
	const current = serializeMarkdown(state.doc, model.origin, model.generation).text;
	if (raw === current) {
		const parsed = parseMarkdownDocument(raw);
		const entries = parsed.doc.childCount === state.doc.childCount ? parsed.entries : null;
		const tr = state.tr;
		if (entries) tr.setSelection(selectionAt(state.doc, offsetToPos(state.doc, entries, cursor.anchor), offsetToPos(state.doc, entries, cursor.head)));
		tr.setMeta('addToHistory', false);
		return { tr, origin: model.origin, generation: model.generation, changed: false };
	}
	const replaced = replaceChangedBlocks(state, raw, { addToHistory: true, keepOrigin: model.origin });
	const tr = replaced.tr ?? state.tr;
	const doc = tr.doc;
	tr.setSelection(selectionAt(doc, offsetToPos(doc, replaced.entries, cursor.anchor), offsetToPos(doc, replaced.entries, cursor.head)));
	return { tr, origin: replaced.origin, generation: replaced.generation, changed: true };
}

// ---------------------------------------------------------------------------
// 前面の窓の raw を Rust に知らせる(判断 9)
// ---------------------------------------------------------------------------

/** 前面の窓の raw の状態を Rust に知らせる(View ▸ Raw Source のチェック印)。Tauri の外では何もしない。 */
export async function announceRawSource(raw: boolean): Promise<void> {
	try {
		const win = getCurrentWindow();
		await win.emit(RAW_SOURCE_STATE_EVENT, { label: win.label, raw } satisfies RawSourceState);
	} catch {
		// Tauri の外(テストの jsdom など)
	}
}

/**
 * 窓が前面になったら、その窓の raw を知らせ直す(チェック印は前面の窓の値)。購読の解除を返す。
 * `raw()` はその時点の値を返す関数。
 */
export async function watchFocusForRawSource(raw: () => boolean): Promise<() => void> {
	try {
		const win = getCurrentWindow();
		return await win.onFocusChanged(({ payload: focused }) => {
			if (focused) void announceRawSource(raw());
		});
	} catch {
		return () => {};
	}
}
