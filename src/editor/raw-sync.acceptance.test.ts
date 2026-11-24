/**
 * 要件#74 第2段 2-3(raw)— `src/editor/raw-sync.ts` の純関数の受け入れテスト(契約23・契約7・AC-74-6・AC-74-9 の純関数の分)。
 *
 * **仮の前提(2026-11-17・由谷の確認待ち=第2段の準備で出た判断)**: 2-1・2-2 の判断 1〜3・5・7・8 に加えて、
 * 判断 9=Raw Source のチェック印はフロントからのイベント `raw_source_state`(payload `{ label, raw }`)で前面の窓の値を Rust に
 * 知らせる(Tauri command は増やさない)・判断 10=別の文書を開いたら raw を引き継がない(raw は文書モデルの状態)。
 * 回答が推奨と違えば、このファイルの「判断 9・10 に依存」の印の付いたケースを書き直す(ほかは契約23 の本文だけに依る)。
 *
 * ## 対応する受け入れ基準
 * - AC-74-6  raw で直すものの往復: front matter・生 HTML のブロック・リンク参照定義・閉じていないフェンスを含む文書を
 *            rendered → raw → rendered と往復しても書き出しが byte 等価。raw でその中を直して戻すと、直した文字がそのまま
 *            (エスケープなし)書き出しに入り、他は byte 等価。編集面でこれらのノードに文字を打てない(atom)
 * - AC-74-9  raw の文字列が契約6の書き出しと一致する・raw で打って戻すと文書モデルが読み直され、カーソルがその位置のブロックにあり、
 *            Command + Z 1 回で raw での編集がまとめて戻る(ここでは取引と履歴の段で見る。面の側は RawSource.wiring.test.ts)
 * - 契約23   rendered → raw でカーソルと選択は原文の位置に写す(触っていないブロックでは正確・書き直したブロックではその先頭)。
 *            raw → rendered では raw の文字列が新しい原文になり、形が同じ前後のブロックは古い Node のまま付け直す
 *
 * ## 確定契約(implementer はこれに従う=推奨名は req-74.md 第2段の作り(案)9・10。無いものは test-writer が固定)
 *
 * ```ts
 * // --- src/editor/raw-sync.ts(新規・純関数+イベント名)
 * export const MENU_RAW_SOURCE_EVENT = 'menu_raw_source';      // lib.rs が View ▸ Raw Source で前面の窓へ送る(payload なし)
 * export const RAW_SOURCE_STATE_EVENT = 'raw_source_state';    // フロント → Rust。payload { label: string; raw: boolean }(判断 9)
 * export interface RawSourceState { label: string; raw: boolean }
 * export interface RawSnapshot { text: string; anchor: number; head: number }   // text=契約6 の書き出し・anchor/head=原文の文字の位置
 * /** 文書の位置 → 原文(serializeMarkdown(...).text)の文字の位置。1・2 段目のブロックの中は文字単位で正確、
 *  *  3 段目のブロックの中はそのブロックの先頭(segments[i].start)。文書の末尾は text.length。 *\/
 * export function pmToSource(model: MarkdownDocument, pos: number): number;
 * /** 原文の文字の位置 → 文書の位置。その位置を含む最上位ブロックの中(1・2 段目の run の中は正確)。 *\/
 * export function sourceToPm(model: MarkdownDocument, offset: number): number;
 * export function toRaw(model: MarkdownDocument): RawSnapshot;   // text は serializeMarkdown と byte 等価・anchor/head は model.state.selection を写す
 * /** raw の文字列を読み直す取引。文字列が変わっていれば replaceChangedBlocks と同じ差し替え(前後の形が同じ Node は同一のまま)で
 *  *  **履歴に 1 段**(addToHistory を false にしない)・changed=true。変わっていなければ選択だけの取引(addToHistory: false)・changed=false。
 *  *  選択は cursor(raw の文字の位置)を sourceToPm で写した位置。origin / generation は raw の文字列の新しい世代。 *\/
 * export function fromRaw(model: MarkdownDocument, raw: string, cursor: { anchor: number; head: number }):
 *   { tr: Transaction; origin: OriginTable; generation: Generation; changed: boolean };
 * /** 前面の窓の raw の状態を Rust に知らせる(判断 9): getCurrentWindow().emit(RAW_SOURCE_STATE_EVENT, { label: window.label, raw })。 *\/
 * export function announceRawSource(raw: boolean): Promise<void>;
 * ```
 *
 * ## 修正前に赤になる理由
 * - `src/editor/raw-sync.ts` が無いので import で落ちる。`fixtures/editing/markdown/raw-only.md` はこのテストと一緒に足した
 */
import { describe, expect, test } from 'vitest';
import { undo, undoDepth } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';

import { createMarkdownDocument, markdownText, withState, type MarkdownDocument } from './markdown-document';
import { serializeMarkdown } from './to-markdown';
import { markdownSchema } from './markdown-schema';
import { FORMAT_COMMANDS } from './commands';
import {
	MENU_RAW_SOURCE_EVENT,
	RAW_SOURCE_STATE_EVENT,
	fromRaw,
	pmToSource,
	sourceToPm,
	toRaw,
} from './raw-sync';
import { blockNames, blockPos, fixture, textSpots, variants, MD_FILES } from './markdown.testkit';

const URI = 'file:///Users/a/notes/raw.md';
const MD = ['# Plan', '', 'Intro paragraph with **bold** word.', '', 'Second paragraph here.', '', '- item one', '- item two', '', 'Tail paragraph.', ''].join('\n');
const RAW_ONLY = fixture('raw-only.md');

function model(src: string): MarkdownDocument {
	return createMarkdownDocument(src, { uri: URI, readOnly: false });
}
function select(m: MarkdownDocument, anchor: number, head = anchor): MarkdownDocument {
	return withState(m, m.state.apply(m.state.tr.setSelection(TextSelection.create(m.state.doc, anchor, head))));
}
function serialized(m: MarkdownDocument) {
	return serializeMarkdown(m.state.doc, m.origin, m.generation);
}
/** fromRaw の結果を当てた新しいモデル。 */
function applyRaw(m: MarkdownDocument, raw: string, cursor: { anchor: number; head: number }) {
	const r = fromRaw(m, raw, cursor);
	const next: MarkdownDocument = { ...withState(m, m.state.apply(r.tr)), origin: r.origin, generation: r.generation };
	return { r, next };
}
function nodeOf(doc: PMNode, pos: number): { index: number; node: PMNode } {
	const $pos = doc.resolve(Math.min(pos, doc.content.size));
	const index = $pos.index(0);
	return { index, node: doc.child(Math.min(index, doc.childCount - 1)) };
}

describe('イベント名(契約23・判断 9)', () => {
	test('MENU_RAW_SOURCE_EVENT と RAW_SOURCE_STATE_EVENT(Rust の menu.rs と同じ綴り=acceptance_req74_menu.rs が突き合わせる)', () => {
		expect(MENU_RAW_SOURCE_EVENT).toBe('menu_raw_source');
		expect(RAW_SOURCE_STATE_EVENT).toBe('raw_source_state'); // 判断 9 に依存
	});
});

describe('AC-74-9・契約23: toRaw の文字列は契約6 の書き出しと byte 等価', () => {
	for (const name of [...MD_FILES, 'raw-only.md']) {
		for (const [label, src] of variants(name, fixture(name))) {
			test(label, () => {
				const m = model(src);
				const snap = toRaw(m);
				expect(snap.text).toBe(serialized(m).text);
				expect(snap.text).toBe(src);
			});
		}
	}

	test('触った後(Bold を付けた=3 段目のブロックがある)でも serializeMarkdown と同じ', () => {
		let m = model(MD);
		const spot = textSpots(m.state.doc, 2)[0]!;
		m = select(m, spot.pos, spot.pos + 6);
		let applied = m.state;
		FORMAT_COMMANDS['format-bold'](m.state, (tr) => (applied = m.state.apply(tr)));
		m = withState(m, applied);
		expect(toRaw(m).text).toBe(serialized(m).text);
		expect(toRaw(m).text).toContain('**Second** paragraph here.');
	});
});

describe('契約23: pmToSource / sourceToPm(触っていないブロックでは文字単位で正確・書き直したブロックではその先頭)', () => {
	test('触っていない文書: mark の無い run の各文字が原文の同じ文字に写る(全ブロック)', () => {
		const m = model(MD);
		for (let b = 0; b < m.state.doc.childCount; b++) {
			for (const spot of textSpots(m.state.doc, b)) {
				if (spot.marks.length > 0 || spot.inCode) continue;
				const off = pmToSource(m, spot.pos);
				expect(MD.slice(off, off + spot.text.length), `block ${b} "${spot.text}"`).toBe(spot.text);
				// 途中の文字も 1 対 1
				const mid = Math.floor(spot.text.length / 2);
				expect(pmToSource(m, spot.pos + mid)).toBe(off + mid);
				expect(sourceToPm(m, off + mid)).toBe(spot.pos + mid);
			}
		}
	});

	test('選択(anchor / head)を写す: toRaw の anchor / head は選択の両端の原文の位置', () => {
		const spot = textSpots(model(MD).state.doc, 2)[0]!; // 'Second paragraph here.'
		const m = select(model(MD), spot.pos + 2, spot.pos + 9);
		const snap = toRaw(m);
		const base = MD.indexOf('Second paragraph here.');
		expect(snap.anchor).toBe(base + 2);
		expect(snap.head).toBe(base + 9);
	});

	test('2 段目(文字を打っただけ)のブロックの中も正確', () => {
		let m = model(MD);
		const spot = textSpots(m.state.doc, 2)[0]!;
		m = withState(m, m.state.apply(m.state.tr.insertText('XY', spot.pos + 6)));
		const text = toRaw(m).text;
		expect(text).toContain('SecondXY paragraph here.');
		const off = pmToSource(m, spot.pos + 6 + 2 + 3); // 'SecondXY pa|ragraph'
		expect(text.slice(off, off + 7)).toBe('ragraph');
		expect(sourceToPm(m, off)).toBe(spot.pos + 6 + 2 + 3);
	});

	test('3 段目(Bold を付けた)のブロックの中はそのブロックの先頭(segments[i].start)', () => {
		let m = model(MD);
		const spot = textSpots(m.state.doc, 2)[0]!;
		m = select(m, spot.pos, spot.pos + 6);
		let applied = m.state;
		FORMAT_COMMANDS['format-bold'](m.state, (tr) => (applied = m.state.apply(tr)));
		m = withState(m, applied);
		const { segments } = serialized(m);
		expect(segments[2]!.stage).toBe(3);
		const inside = textSpots(m.state.doc, 2).find((s) => s.text.includes('paragraph'))!;
		expect(pmToSource(m, inside.pos + 3)).toBe(segments[2]!.start);
		// 後ろのブロック(触っていない)はずれずに正確
		const tail = textSpots(m.state.doc, 4)[0]!;
		const text = toRaw(m).text;
		expect(text.slice(pmToSource(m, tail.pos), pmToSource(m, tail.pos) + tail.text.length)).toBe(tail.text);
	});

	test('sourceToPm: 記号の上(`# ` の `#`・`- ` の `-`・空行)はその位置を含むブロックの中か境目', () => {
		const m = model(MD);
		const doc = m.state.doc;
		const heading = sourceToPm(m, 0); // '#'
		expect(heading).toBeGreaterThanOrEqual(blockPos(doc, 0));
		expect(heading).toBeLessThanOrEqual(blockPos(doc, 0) + doc.child(0).nodeSize);
		const bullet = sourceToPm(m, MD.indexOf('- item two'));
		expect(nodeOf(doc, bullet).node.type.name).toBe('bullet_list');
		expect(sourceToPm(m, MD.length)).toBeLessThanOrEqual(doc.content.size);
		expect(sourceToPm(m, 0)).toBeGreaterThanOrEqual(0);
	});
});

describe('AC-74-9・契約23: fromRaw(raw → rendered)', () => {
	test('変わっていなければ選択だけの取引(addToHistory: false・docChanged でない・changed=false)', () => {
		const m = model(MD);
		const base = MD.indexOf('Second paragraph here.');
		const { r, next } = applyRaw(m, MD, { anchor: base + 7, head: base + 7 });
		expect(r.changed).toBe(false);
		expect(r.tr.docChanged).toBe(false);
		expect(r.tr.getMeta('addToHistory')).toBe(false);
		expect(undoDepth(next.state)).toBe(undoDepth(m.state));
		const spot = textSpots(next.state.doc, 2)[0]!;
		expect(next.state.selection.from).toBe(spot.pos + 7);
		expect(markdownText(next)).toBe(MD);
	});

	test('raw で 2 つのブロックを直して戻す: 書き出しが raw と byte 等価・触っていない Node は同一・履歴に 1 段・undo でまとめて戻る', () => {
		const m = model(MD);
		const raw = MD.replace('- item two', '- item 2').replace('Tail paragraph.', 'Tail ZZ paragraph.');
		const cursor = raw.indexOf('ZZ') + 2;
		const { r, next } = applyRaw(m, raw, { anchor: cursor, head: cursor });
		expect(r.changed).toBe(true);
		expect(r.tr.docChanged).toBe(true);
		expect(r.tr.getMeta('addToHistory')).not.toBe(false);
		expect(markdownText(next)).toBe(raw);
		expect(toRaw(next).text).toBe(raw);
		// 触っていない前後(見出し・最初の段落)は同じ Node
		expect(next.state.doc.child(0)).toBe(m.state.doc.child(0));
		expect(next.state.doc.child(1)).toBe(m.state.doc.child(1));
		expect(next.state.doc.child(2)).toBe(m.state.doc.child(2));
		// カーソルは直した文字の位置のブロック(Tail)の中
		expect(nodeOf(next.state.doc, next.state.selection.from).index).toBe(4);
		const tail = textSpots(next.state.doc, 4)[0]!;
		expect(next.state.selection.from).toBe(tail.pos + 'Tail ZZ'.length);
		// 履歴に 1 段・undo で 2 つのブロックの直しがまとめて戻る
		expect(undoDepth(next.state)).toBe(undoDepth(m.state) + 1);
		let undone = next.state;
		expect(undo(next.state, (tr) => (undone = next.state.apply(tr)))).toBe(true);
		expect(undone.doc.eq(m.state.doc)).toBe(true);
		expect(undoDepth(undone)).toBe(undoDepth(m.state));
	});

	test('raw で足したブロック・消したブロック(数が変わる)でも書き出しは raw と等価で、前後の Node は同一', () => {
		const m = model(MD);
		const added = MD.replace('Second paragraph here.\n', 'Second paragraph here.\n\nInserted one.\n\n> quoted\n');
		const a = applyRaw(m, added, { anchor: added.indexOf('Inserted'), head: added.indexOf('Inserted') });
		expect(markdownText(a.next)).toBe(added);
		expect(a.next.state.doc.child(0)).toBe(m.state.doc.child(0));
		expect(a.next.state.doc.child(a.next.state.doc.childCount - 1)).toBe(m.state.doc.child(m.state.doc.childCount - 1));
		expect(nodeOf(a.next.state.doc, a.next.state.selection.from).node.textContent).toBe('Inserted one.');
		const removed = MD.replace('Second paragraph here.\n\n', '');
		const d = applyRaw(m, removed, { anchor: 0, head: 0 });
		expect(markdownText(d.next)).toBe(removed);
		expect(d.next.state.doc.childCount).toBe(m.state.doc.childCount - 1);
	});

	test('続けて raw → rendered → raw と往復しても byte 等価(2 回目の raw も同じ文字列)', () => {
		let m = model(MD);
		const raw1 = MD.replace('item one', 'item uno');
		m = applyRaw(m, raw1, { anchor: 0, head: 0 }).next;
		expect(toRaw(m).text).toBe(raw1);
		const raw2 = raw1.replace('# Plan', '# Plan B');
		m = applyRaw(m, raw2, { anchor: 3, head: 3 }).next;
		expect(toRaw(m).text).toBe(raw2);
		expect(undoDepth(m.state)).toBe(2);
	});

	for (const [label, src] of variants('raw-only.md', RAW_ONLY)) {
		test(`改行と BOM を保つ: ${label} を raw で 1 文字直して戻す`, () => {
			const m = model(src);
			const raw = src.replace('最後の段落。', '最後の段落!');
			const { next } = applyRaw(m, raw, { anchor: 0, head: 0 });
			expect(markdownText(next)).toBe(raw);
		});
	}
});

describe('AC-74-6・契約7: raw で直すもの(front matter・生 HTML・参照定義・閉じていないフェンス)', () => {
	test('フィクスチャは front_matter・html_block・definition・code_block(mermaid と閉じていない fence)を持ち、どれも atom か打てない塊', () => {
		const m = model(RAW_ONLY);
		const names = blockNames(m.state.doc);
		for (const n of ['front_matter', 'html_block', 'definition', 'code_block']) expect(names, n).toContain(n);
		for (const n of ['front_matter', 'html_block', 'definition', 'html_inline']) {
			const type = markdownSchema.nodes[n]!;
			expect(type.spec.atom === true || type.isLeaf, `${n} は atom`).toBe(true);
			expect(type.isTextblock, `${n} に文字を打てない`).toBe(false);
		}
		// 中に insertText できない(位置がブロックの中に無い=resolve した親が textblock でない)
		const doc = m.state.doc;
		doc.forEach((node, offset) => {
			if (!['front_matter', 'html_block', 'definition'].includes(node.type.name)) return;
			const $inside = doc.resolve(offset + 1);
			expect($inside.parent.isTextblock, `${node.type.name} の中`).toBe(false);
		});
	});

	for (const [label, src] of variants('raw-only.md', RAW_ONLY)) {
		test(`往復で byte 等価: ${label}`, () => {
			const m = model(src);
			const snap = toRaw(m);
			expect(snap.text).toBe(src);
			const { r, next } = applyRaw(m, snap.text, { anchor: snap.anchor, head: snap.head });
			expect(r.changed).toBe(false);
			expect(markdownText(next)).toBe(src);
			expect(toRaw(next).text).toBe(src);
		});
	}

	const edits: Array<[string, string, string]> = [
		['front matter の値', 'draft: true', 'draft: false'],
		['生 HTML のブロックの中の文字', '生 HTML のブロック', '生 HTML の <em>塊</em>'],
		['生 HTML のブロックの属性', 'data-kind="raw"', 'data-kind="edited"'],
		['生 HTML のコメント', 'コメントも原文のまま', 'コメントを直した'],
		['インラインの生 HTML', '<span class="x">生 HTML のインライン</span>', '<span class="y">生 HTML の *インライン*</span>'],
		['参照定義の URL', 'https://example.com/one', 'https://example.com/uno?q=a&b=c'],
		['参照定義のタイトル', "'タイトル'", '"題"'],
		['mermaid の中身', 'B -->|yes| C[CodeMirror]', 'B -->|yes| C[CodeMirror 6 <raw>]'],
		['閉じていないフェンスの中', 'const unclosed = true;', 'const unclosed = `still ${open}`;'],
		['壊れた記法を足す(閉じない強調と `*`)', '最後の段落。', '最後の段落 **閉じない *記号 。'],
	];
	for (const [label, from, to] of edits) {
		test(`raw で直して戻す: ${label} — 直した文字がそのまま(エスケープなし)入り、他は byte 等価`, () => {
			expect(RAW_ONLY).toContain(from);
			const m = model(RAW_ONLY);
			const raw = RAW_ONLY.replace(from, to);
			const at = raw.indexOf(to);
			const { r, next } = applyRaw(m, raw, { anchor: at, head: at + to.length });
			expect(r.changed).toBe(true);
			const out = markdownText(next);
			expect(out).toBe(raw);
			expect(out).toContain(to);
			// 直した範囲の外は原文のまま(前後が byte 等価)
			expect(out.slice(0, at)).toBe(RAW_ONLY.slice(0, RAW_ONLY.indexOf(from)));
			expect(out.slice(at + to.length)).toBe(RAW_ONLY.slice(RAW_ONLY.indexOf(from) + from.length));
			// もう一度 raw に出しても同じ
			expect(toRaw(next).text).toBe(raw);
			expect(undoDepth(next.state)).toBe(1);
		});
	}

	test('raw で front matter を丸ごと消す・足す', () => {
		const m = model(RAW_ONLY);
		const without = RAW_ONLY.replace(/^---[\s\S]*?---\n\n/, '');
		expect(without.startsWith('# raw')).toBe(true);
		const a = applyRaw(m, without, { anchor: 0, head: 0 });
		expect(markdownText(a.next)).toBe(without);
		expect(blockNames(a.next.state.doc)).not.toContain('front_matter');
		const b = applyRaw(a.next, RAW_ONLY, { anchor: 0, head: 0 });
		expect(markdownText(b.next)).toBe(RAW_ONLY);
		expect(blockNames(b.next.state.doc)[0]).toBe('front_matter');
	});
});
