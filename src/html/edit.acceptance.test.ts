/**
 * 要件#53 の受け入れテスト(docs/requirements/req-53.md)— HTML のレンダリング済み
 * 編集(テキストノード単位)の純関数(unit プロジェクト)
 *
 * 「閲覧専用(FR-02)撤廃の第3段」: html 種別の文書を、閲覧の iframe には触れず、
 * 編集のときだけ sanitize 済みの複製(編集面)をアプリの DOM に出して、値が変わった
 * テキストノードの**原文範囲だけ**を最小エスケープで書き戻す。判断は
 * `src/html/edit.ts` の純関数に集め(要件#49 の `src/markdown/edit.ts` と同じ分担)、
 * DOM も状態も持たない形で直接呼ぶ。JSDOM の要素を引数に渡すのは可。
 *
 * ## `src/html/edit.ts` に求める export(本テストが契約を決める)
 *
 * ```ts
 * /** 編集単位の要素に付く原文範囲の印。編集面の HTML に連番で付く。 *\/
 * // 属性名はリテラル 'data-vellis-hid'(契約②)
 *
 * /** 1テキストノードの原文範囲。offset は原文文字列の UTF-16 code unit
 *  *(0 起点・end は排他)で、`source.slice(start, end)` が**エンティティ込みの
 *  * 原文の綴り**(例: 'Hello &amp; world')になる。childIndex は編集面 DOM で
 *  * その要素の childNodes の何番目か。 *\/
 * export type TextNodeRange = { childIndex: number; start: number; end: number };
 *
 * /** hid(data-vellis-hid の値)→ その要素直下のテキストノードの原文範囲。 *\/
 * export type EditSurfaceIndex = Map<string, TextNodeRange[]>;
 *
 * export type EditSurface = {
 *   /** Shadow DOM に入れる HTML(<body> の中身。rehype-parse(位置付き)→
 *    *  rehype-sanitize → rehype-stringify。script / on* / iframe は落ち、
 *    *  <style> 要素・style 属性・class・id は残る。テキストノードを直下に持つ
 *    *  要素に data-vellis-hid が付く=契約②) *\/
 *   html: string;
 *   index: EditSurfaceIndex;
 *   /** <head> の <style> の中身(編集面へ移して効かせる=契約②)。 *\/
 *   styles: string[];
 * };
 *
 * /** 原文(現在の編集バッファ)から編集面を作る。docUri は相対 URL の
 *  * vellis-asset: 書き換え(契約②)に使う。 *\/
 * export function buildEditSurface(source: string, docUri: string): EditSurface;
 *
 * /** ダブルクリックの target から編集単位の葉ブロックを解決する(契約③)。
 *  * root=編集面のルート。葉ブロックが無ければテキストノードの親要素
 *  * (インライン要素も可)。ルート・ブロック要素を子に持つ要素・書き戻せる
 *  * hid を持たない要素(契約⑤)は null。 *\/
 * export function resolveLeafBlock(target: Element, root: Element): HTMLElement | null;
 *
 * /** 編集開始時に控えるブロックの形(要素の tagName 列と各要素直下の
 *  * テキストノード値=契約④)。中身は実装の裁量(テストは不透明に扱う)。 *\/
 * export type BlockShape = unknown;
 * export function snapshotBlock(el: Element): BlockShape;
 *
 * /** 確定(契約④⑦)。normalize() 後に before と形を比べ、同じなら値が変わった
 *  * テキストノードだけを原文範囲へ**後ろから**書き戻す(& → &amp;・< → &lt;・
 *  * > → &gt; の最小エスケープ。それ以外は生のまま)。形が変わっていたら拒否。
 *  * ok のとき index は書き戻した長さの差分で位置補正済みの索引。 *\/
 * export type CommitResult =
 *   | { ok: true; source: string; index: EditSurfaceIndex }
 *   | { ok: false; reason: 'structure-changed' };
 * export function commitBlock(args: {
 *   source: string;
 *   index: EditSurfaceIndex;
 *   block: Element;
 *   before: BlockShape;
 * }): CommitResult;
 *
 * /** 契約④の拒否通知の文言(用語集=本テストで値固定。人間ゲート④が妥当性を見る)。 *\/
 * export const STRUCTURE_CHANGED_MESSAGE: string;
 * ```
 *
 * ## 判定するもの(AC 番号は req-53.md の受け入れ基準)
 * - AC-53-1 編集面の生成(契約②)
 * - AC-53-2 sanitize で子が変わった要素は編集不可(契約⑤)
 * - AC-53-3 葉ブロックの解決(契約③)
 * - AC-53-4 テキストノードだけの差し替え(契約④⑦)
 * - AC-53-5 最小エスケープ(契約④)
 * - AC-53-6 複数ノード・後ろから(契約④)
 * - AC-53-7 構造変化の拒否(契約④・純関数面)
 * - AC-53-8 連続編集の位置補正(契約④)
 * - AC-53-11 閲覧側の不変(契約①⑧・値固定の部分)
 * - AC-53-13 依存の固定(契約⑧)
 * - AC-53-14 CRLF と改行
 *
 * ## 判定しないもの
 * - Viewer の配線(⌘E・ダブルクリック・確定/破棄の契機・Source ボタン・保存経路)
 *   → src/components/Viewer.htmledit.wiring.test.ts
 * - 編集面の見た目・文書 CSS の効き方・IME の実機挙動・git diff の実地確認
 *   → reviewer 照合+人間ゲート(acceptance/acceptance.md 要件#53 ①〜⑥)
 */
import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	buildEditSurface,
	commitBlock,
	resolveLeafBlock,
	snapshotBlock,
	STRUCTURE_CHANGED_MESSAGE,
	type EditSurface,
} from './edit';
import { buildSrcdoc, SANDBOX_ATTRIBUTE } from '$lib/html-viewer';
import { vellisSchema } from '../markdown/sanitize-schema';

const DOC_URI = 'file:///Users/a/site/page.html';
const HID = 'data-vellis-hid';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** 編集面を作り、その HTML を JSDOM に載せてルート要素を返す。 */
function mountSurface(source: string): { surface: EditSurface; root: HTMLElement } {
	const surface = buildEditSurface(source, DOC_URI);
	const root = document.createElement('div');
	root.innerHTML = surface.html;
	return { surface, root };
}

function q(scope: ParentNode, selector: string): HTMLElement {
	const el = scope.querySelector(selector);
	if (!el) throw new Error('要素が見つからない: ' + selector);
	return el as HTMLElement;
}

/** 要素の childNodes[i] がテキストノードであることを確かめて返す。 */
function textNodeAt(el: Element, i: number): Text {
	const node = el.childNodes[i];
	expect(node, i + ' 番目の子ノードがあること').toBeTruthy();
	expect(node.nodeType, i + ' 番目の子がテキストノードであること').toBe(3);
	return node as Text;
}

/** hid の索引エントリを childIndex 昇順で返す。 */
function rangesOf(surface: EditSurface, el: Element) {
	const hid = el.getAttribute(HID);
	expect(hid, '要素に ' + HID + ' が付いていること').toBeTruthy();
	const ranges = surface.index.get(hid as string);
	expect(ranges, '索引に hid ' + hid + ' があること').toBeTruthy();
	return [...(ranges as { childIndex: number; start: number; end: number }[])].sort(
		(a, b) => a.childIndex - b.childIndex,
	);
}

/** commit が ok であることを確かめて中身を返す。 */
function expectOk(result: ReturnType<typeof commitBlock>) {
	if (!result.ok) throw new Error('確定が拒否された: ' + result.reason);
	return result;
}

// ---------------------------------------------------------------------------
// AC-53-1 — 編集面の生成(契約②)
// ---------------------------------------------------------------------------

const SURFACE_SRC = [
	'<!doctype html>',
	'<html>',
	'<head>',
	'<title>Doc</title>',
	'<style>p { color: rgb(1, 2, 3); }</style>',
	'</head>',
	'<body>',
	'<p id="a" class="x" style="margin-top: 4px">Hello &amp; world</p>',
	'<p id="plain" onclick="steal()">plain</p>',
	'<script>alert(1)</script>',
	'<iframe src="https://evil.example/"></iframe>',
	'</body>',
	'</html>',
	'',
].join('\n');

describe('AC-53-1 — 編集面の生成(契約②)', () => {
	test('script・on* 属性・iframe は出力に無い', () => {
		const { surface } = mountSurface(SURFACE_SRC);
		expect(surface.html).not.toContain('<script');
		expect(surface.html).not.toContain('alert(1)');
		expect(surface.html.toLowerCase()).not.toContain('onclick');
		expect(surface.html).not.toContain('<iframe');
	});

	test('style 属性・class・id は残る(文書の見た目を保つ=契約②のスキーマ拡張)', () => {
		const { root } = mountSurface(SURFACE_SRC);
		const a = q(root, '#a');
		expect(a.getAttribute('class')).toBe('x');
		expect(a.getAttribute('style')).toContain('margin-top');
	});

	test('<head> の <style> は編集面へ移る(styles に中身が入る)', () => {
		const { surface } = mountSurface(SURFACE_SRC);
		expect(surface.styles.join('\n')).toContain('rgb(1, 2, 3)');
	});

	test('テキストノードを持つ要素に data-vellis-hid が付く', () => {
		const { root } = mountSurface(SURFACE_SRC);
		expect(q(root, '#a').hasAttribute(HID)).toBe(true);
		expect(q(root, '#plain').hasAttribute(HID)).toBe(true);
	});

	test('索引の範囲を原文からスライスするとエンティティ込みの原文の綴りになる', () => {
		const { surface, root } = mountSurface(SURFACE_SRC);
		const a = q(root, '#a');
		const ranges = rangesOf(surface, a);
		expect(ranges).toHaveLength(1);
		expect(SURFACE_SRC.slice(ranges[0].start, ranges[0].end)).toBe('Hello &amp; world');
		// DOM 側の値はデコード済み(索引が原文の綴りへ戻す唯一の橋)。
		expect(textNodeAt(a, ranges[0].childIndex).nodeValue).toBe('Hello & world');

		const plain = q(root, '#plain');
		const plainRanges = rangesOf(surface, plain);
		expect(plainRanges).toHaveLength(1);
		expect(SURFACE_SRC.slice(plainRanges[0].start, plainRanges[0].end)).toBe('plain');
	});
});

// ---------------------------------------------------------------------------
// AC-53-2 — sanitize で子が変わった要素は編集不可(契約⑤)
// ---------------------------------------------------------------------------

const SANITIZED_SRC = [
	'<body>',
	'<p id="s">a<script>x</script>b</p>',
	'<p id="b">a<b>x</b>b</p>',
	'</body>',
	'',
].join('\n');

describe('AC-53-2 — sanitize で子が変わった要素は編集不可(契約⑤)', () => {
	test('<p>a<script>x</script>b</p> の p には hid が付かない(原文範囲と1対1に戻せない)', () => {
		const { surface, root } = mountSurface(SANITIZED_SRC);
		const s = q(root, '#s');
		expect(s.hasAttribute(HID)).toBe(false);
		// 索引のどのエントリからも #s のテキストは引けない(hid が無いので鍵も無い)。
		expect(surface.html).toContain('id="s"');
	});

	test('hid の無いブロックはダブルクリックしても編集に入らない(resolveLeafBlock が null)', () => {
		const { root } = mountSurface(SANITIZED_SRC);
		expect(resolveLeafBlock(q(root, '#s'), root)).toBe(null);
	});

	test('<p>a<b>x</b>b</p> には hid が付き、2つのテキストノードが正しい範囲を持つ', () => {
		const { surface, root } = mountSurface(SANITIZED_SRC);
		const b = q(root, '#b');
		expect(b.hasAttribute(HID)).toBe(true);
		const ranges = rangesOf(surface, b);
		expect(ranges).toHaveLength(2);
		expect(ranges[0].childIndex).toBe(0);
		expect(ranges[1].childIndex).toBe(2);
		expect(SANITIZED_SRC.slice(ranges[0].start, ranges[0].end)).toBe('a');
		expect(SANITIZED_SRC.slice(ranges[1].start, ranges[1].end)).toBe('b');
		// 中の <b> も直下にテキストを持つので hid が付く。
		const inner = q(root, '#b b');
		const innerRanges = rangesOf(surface, inner);
		expect(SANITIZED_SRC.slice(innerRanges[0].start, innerRanges[0].end)).toBe('x');
	});
});

// ---------------------------------------------------------------------------
// AC-53-3 — 葉ブロックの解決(契約③)
// ---------------------------------------------------------------------------

const LEAF_SRC = [
	'<body>',
	'<p id="p1">Hello <b id="b1">bold</b></p>',
	'<div id="wrap"><p id="p2">x</p><p id="p3">y</p></div>',
	'<ul><li id="li1">item</li></ul>',
	'<table><tbody><tr><td id="td1">cell</td></tr></tbody></table>',
	'<pre id="pre1">code text</pre>',
	'<h2 id="h2x">Head</h2>',
	'<span id="sp1">inline only</span>',
	'</body>',
	'',
].join('\n');

describe('AC-53-3 — 葉ブロックの解決(契約③)', () => {
	test('インライン要素(b)の上なら、それを含む葉ブロック(p)へ繰り上げる', () => {
		const { root } = mountSurface(LEAF_SRC);
		expect(resolveLeafBlock(q(root, '#b1'), root)).toBe(q(root, '#p1'));
	});

	test('入れ子では内側の p が編集単位・ブロックを子に持つ div は不可', () => {
		const { root } = mountSurface(LEAF_SRC);
		expect(resolveLeafBlock(q(root, '#p2'), root)).toBe(q(root, '#p2'));
		expect(resolveLeafBlock(q(root, '#wrap'), root)).toBe(null);
	});

	test('li・td・pre・h2 も編集単位になる', () => {
		const { root } = mountSurface(LEAF_SRC);
		for (const id of ['#li1', '#td1', '#pre1', '#h2x']) {
			expect(resolveLeafBlock(q(root, id), root), id + ' が自分自身に解決されること').toBe(
				q(root, id),
			);
		}
	});

	test('葉ブロックが無ければテキストノードの親要素(span 等のインライン)も可', () => {
		const { root } = mountSurface(LEAF_SRC);
		expect(resolveLeafBlock(q(root, '#sp1'), root)).toBe(q(root, '#sp1'));
	});

	test('編集面のルートは編集単位にならない', () => {
		const { root } = mountSurface(LEAF_SRC);
		expect(resolveLeafBlock(root, root)).toBe(null);
	});
});

// ---------------------------------------------------------------------------
// AC-53-4〜7 — 確定と差し替え(契約④⑦)
// ---------------------------------------------------------------------------

const BLOCK_SRC = [
	'<!doctype html>',
	'<html>',
	'<head><title>t</title></head>',
	'<body>',
	'<!-- keep me -->',
	'<p id="a" class="x">Hello <b>bold</b> &amp; world</p>',
	'<p id="tail">tail</p>',
	'</body>',
	'</html>',
	'',
].join('\n');

/** #a を掴んで snapshot まで済ませた状態を作る。 */
function grabBlockA(source: string = BLOCK_SRC) {
	const { surface, root } = mountSurface(source);
	const a = q(root, '#a');
	const before = snapshotBlock(a);
	return { surface, root, a, before };
}

describe('AC-53-4 — テキストノードだけの差し替え(契約④⑦)', () => {
	test('Hello → Hi の確定で、その範囲以外(doctype・コメント・属性・<b>・&amp;)は byte 等価', () => {
		const { surface, a, before } = grabBlockA();
		textNodeAt(a, 0).nodeValue = 'Hi ';

		const result = expectOk(
			commitBlock({ source: BLOCK_SRC, index: surface.index, block: a, before }),
		);

		expect(result.source).toBe(BLOCK_SRC.replace('Hello <b>', 'Hi <b>'));
	});

	test('何も変えずに確定しても原文は byte 等価のまま', () => {
		const { surface, a, before } = grabBlockA();

		const result = expectOk(
			commitBlock({ source: BLOCK_SRC, index: surface.index, block: a, before }),
		);

		expect(result.source).toBe(BLOCK_SRC);
	});
});

describe('AC-53-5 — 最小エスケープ(契約④)', () => {
	test('< & > は &lt; &amp; &gt; で書き戻る', () => {
		const { surface, a, before } = grabBlockA();
		textNodeAt(a, 0).nodeValue = 'new < & > value';

		const result = expectOk(
			commitBlock({ source: BLOCK_SRC, index: surface.index, block: a, before }),
		);

		expect(result.source).toBe(BLOCK_SRC.replace('Hello ', 'new &lt; &amp; &gt; value'));
	});

	test('U+00A0 と非 ASCII はそのまま(&nbsp; には戻さない)', () => {
		const { surface, a, before } = grabBlockA();
		textNodeAt(a, 0).nodeValue = 'x\u00A0日本語 ';

		const result = expectOk(
			commitBlock({ source: BLOCK_SRC, index: surface.index, block: a, before }),
		);

		expect(result.source).toBe(BLOCK_SRC.replace('Hello ', 'x\u00A0日本語 '));
		expect(result.source).not.toContain('&nbsp;');
	});
});

describe('AC-53-6 — 複数ノード・後ろから(契約④)', () => {
	test('1ブロック内の2つのテキストノードを同時に変えても両方が正しい範囲に入る', () => {
		const { surface, a, before } = grabBlockA();
		// 前を長く・後ろを別の長さに変える=前の増分で後ろの範囲がずれない書き戻し順の判定。
		textNodeAt(a, 0).nodeValue = 'Hi there ';
		textNodeAt(a, 2).nodeValue = ' + universe';

		const result = expectOk(
			commitBlock({ source: BLOCK_SRC, index: surface.index, block: a, before }),
		);

		expect(result.source).toBe(
			BLOCK_SRC.replace('Hello <b>bold</b> &amp; world', 'Hi there <b>bold</b> + universe'),
		);
	});
});

describe('AC-53-7 — 構造変化の拒否(契約④・純関数面)', () => {
	test('要素(<b>)を消した確定は拒否される', () => {
		const { surface, a, before } = grabBlockA();
		a.removeChild(q(a, 'b'));

		const result = commitBlock({ source: BLOCK_SRC, index: surface.index, block: a, before });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('structure-changed');
	});

	test('新しい要素(<span>)を入れた確定は拒否される', () => {
		const { surface, a, before } = grabBlockA();
		const span = document.createElement('span');
		span.textContent = 'sneaked';
		a.appendChild(span);

		const result = commitBlock({ source: BLOCK_SRC, index: surface.index, block: a, before });

		expect(result.ok).toBe(false);
	});

	test('<br> を入れた確定は拒否される', () => {
		const { surface, a, before } = grabBlockA();
		a.insertBefore(document.createElement('br'), a.childNodes[2]);

		const result = commitBlock({ source: BLOCK_SRC, index: surface.index, block: a, before });

		expect(result.ok).toBe(false);
	});

	test('拒否通知の文言(用語集=値固定。妥当性は人間ゲート④)', () => {
		expect(STRUCTURE_CHANGED_MESSAGE).toBe('Structure changed — use Source to edit tags');
	});
});

// ---------------------------------------------------------------------------
// AC-53-8 — 連続編集の位置補正(契約④)
// ---------------------------------------------------------------------------

const TWO_SRC = [
	'<body>',
	'<p id="first">alpha</p>',
	'<p id="second">omega</p>',
	'</body>',
	'',
].join('\n');

describe('AC-53-8 — 連続編集の位置補正(契約④)', () => {
	test('前のブロックで長さを変えたあと、後ろのブロック・同じブロックの2回目も正しい範囲が差し替わる', () => {
		const { surface, root } = mountSurface(TWO_SRC);

		// 1回目: 前のブロックを伸ばす。
		const first = q(root, '#first');
		const before1 = snapshotBlock(first);
		textNodeAt(first, 0).nodeValue = 'alpha stretched longer';
		const r1 = expectOk(
			commitBlock({ source: TWO_SRC, index: surface.index, block: first, before: before1 }),
		);
		const src1 = TWO_SRC.replace('alpha', 'alpha stretched longer');
		expect(r1.source).toBe(src1);

		// 2回目: 後ろのブロック。位置補正済みの索引で正しい範囲へ入ること。
		const second = q(root, '#second');
		const before2 = snapshotBlock(second);
		textNodeAt(second, 0).nodeValue = 'OMEGA!';
		const r2 = expectOk(
			commitBlock({ source: r1.source, index: r1.index, block: second, before: before2 }),
		);
		const src2 = src1.replace('omega', 'OMEGA!');
		expect(r2.source).toBe(src2);

		// 3回目: 同じブロック(#first)の2回目=縮める編集も正しい範囲へ入ること。
		const before3 = snapshotBlock(first);
		textNodeAt(first, 0).nodeValue = 'a';
		const r3 = expectOk(
			commitBlock({ source: r2.source, index: r2.index, block: first, before: before3 }),
		);
		expect(r3.source).toBe(src2.replace('alpha stretched longer', 'a'));
	});
});

// ---------------------------------------------------------------------------
// AC-53-14 — CRLF と改行
// ---------------------------------------------------------------------------

const CRLF_SRC =
	'<html>\r\n<head><title>t</title></head>\r\n<body>\r\n<p id="a">line</p>\r\n' +
	'<pre id="pre1">one\r\ntwo</pre>\r\n</body>\r\n</html>\r\n';

describe('AC-53-14 — CRLF と改行', () => {
	test('CRLF 文書の未編集部分は CRLF のまま byte 等価', () => {
		const { surface, root } = mountSurface(CRLF_SRC);
		const a = q(root, '#a');
		const before = snapshotBlock(a);
		textNodeAt(a, 0).nodeValue = 'edited';

		const result = expectOk(
			commitBlock({ source: CRLF_SRC, index: surface.index, block: a, before }),
		);

		expect(result.source).toBe(CRLF_SRC.replace('line', 'edited'));
		expect(result.source).toContain('one\r\ntwo');
	});

	test('索引の範囲は CRLF 込みの原文の綴りを指す(DOM 側は LF に正規化されている)', () => {
		const { surface, root } = mountSurface(CRLF_SRC);
		const pre = q(root, '#pre1');
		const ranges = rangesOf(surface, pre);
		expect(ranges).toHaveLength(1);
		expect(CRLF_SRC.slice(ranges[0].start, ranges[0].end)).toBe('one\r\ntwo');
		expect(textNodeAt(pre, ranges[0].childIndex).nodeValue).toBe('one\ntwo');
	});

	test('値が変わったノードの改行は LF で書き戻る(要件#52 backlog 172 と同型・申し送り)', () => {
		const { surface, root } = mountSurface(CRLF_SRC);
		const pre = q(root, '#pre1');
		const before = snapshotBlock(pre);
		textNodeAt(pre, 0).nodeValue = 'one\ntwo\nthree';

		const result = expectOk(
			commitBlock({ source: CRLF_SRC, index: surface.index, block: pre, before }),
		);

		expect(result.source).toBe(CRLF_SRC.replace('one\r\ntwo', 'one\ntwo\nthree'));
	});
});

// ---------------------------------------------------------------------------
// AC-53-11 — 閲覧側の不変(契約①⑧・値固定の部分)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../..');

function readRepoFile(rel: string): string {
	const path = resolve(REPO_ROOT, rel);
	expect(existsSync(path), rel + ' が存在すること').toBe(true);
	return readFileSync(path, 'utf8');
}

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

describe('AC-53-11 — 閲覧側の不変(契約①⑧)', () => {
	test('SANDBOX_ATTRIBUTE は空文字列(最も厳しい sandbox)のまま', () => {
		expect(SANDBOX_ATTRIBUTE).toBe('');
	});

	test('buildSrcdoc の出力は本要件の前後で同一(2026-09-15 着手時点の実測値で固定)', () => {
		const doc =
			'<!doctype html>\n<html>\n<head>\n<title>T</title>\n</head>\n<body>\n' +
			'<p>Hello <a href="./x.html">link</a></p>\n</body>\n</html>\n';
		expect(buildSrcdoc(doc, DOC_URI)).toBe(
			'<!doctype html>\n<html>\n<head><base href="vellis-asset://local/Users/a/site/page.html">' +
				'<style>[data-vellis-href],[data-vellis-xlink-href]{color:#0000ee;color:-webkit-link;' +
				'text-decoration:underline;cursor:pointer}</style>\n<title>T</title>\n</head>\n<body>\n' +
				'<p>Hello <a data-vellis-href="./x.html">link</a></p>\n</body>\n</html>\n',
		);
		expect(buildSrcdoc('<p>bare fragment</p>', DOC_URI)).toBe(
			'<base href="vellis-asset://local/Users/a/site/page.html"><p>bare fragment</p>',
		);
	});

	// 契約⑧「HtmlViewer.svelte・html-viewer.ts・src/markdown/edit.ts は無改変」を
	// 内容の SHA-256 で固定する(要件#49 AC-49-11 と同じ型)。値は要件#53 着手時点
	// (loop/req-53 c56a544)の内容。後続要件が正当に変える場合は要件側で決めてから
	// 固定値を更新する(実装の周回で書き換えない)。
	test('src/lib/html-viewer.ts は無改変(SHA-256 固定)', () => {
		expect(sha256(readRepoFile('src/lib/html-viewer.ts'))).toBe(
			'087755abba702a70ec8d78b7182b3661aa6071c71945fa347fc4a813c792809e',
		);
	});

	test('src/components/HtmlViewer.svelte は無改変(SHA-256 固定)', () => {
		expect(sha256(readRepoFile('src/components/HtmlViewer.svelte'))).toBe(
			'7e33f1e2c5430e87f19ed91a12797d0756136f76f1249405312d2216577483d1',
		);
	});

	test('src/markdown/edit.ts は無改変(SHA-256 固定)', () => {
		expect(sha256(readRepoFile('src/markdown/edit.ts'))).toBe(
			'c778520df7a00e1fa0b070a9e13f32ba8188fc0df55c8230a95af2f4b523473b',
		);
	});

	test('tauri.conf.json の CSP は不変(値固定)', () => {
		const conf = JSON.parse(readRepoFile('src-tauri/tauri.conf.json')) as {
			app: { security: { csp: string } };
		};
		expect(conf.app.security.csp).toBe(
			"default-src 'self' tauri: customprotocol: asset:; script-src 'self' 'wasm-unsafe-eval'; " +
				"style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: vellis-asset: asset: " +
				'http://asset.localhost tauri: customprotocol:; font-src \'self\' data:; ' +
				"media-src 'self' vellis-asset: asset: http://asset.localhost; frame-src 'self' vellis-asset:; " +
				"connect-src 'self' ipc: http://ipc.localhost vellis-asset: asset: http://asset.localhost " +
				"tauri: customprotocol:; object-src 'none'; base-uri 'self' vellis-asset:; frame-ancestors 'none'",
		);
	});

	test('capability(src-tauri/capabilities/default.json)は無改変(SHA-256 固定)', () => {
		expect(sha256(readRepoFile('src-tauri/capabilities/default.json'))).toBe(
			'faed09590bb5f8a89b1bf7d4ba6fa96b74767250d794edb4f50cd32dbe45bbff',
		);
	});
});

// ---------------------------------------------------------------------------
// AC-53-13 — 依存の固定(契約⑧)
// ---------------------------------------------------------------------------

describe('AC-53-13 — 依存の固定(契約⑧)', () => {
	test('package.json の dependencies は要件#53 の追加が rehype-parse のみ(全 18 件を値固定)', () => {
		const pkg = JSON.parse(readRepoFile('package.json')) as {
			dependencies: Record<string, string>;
		};
		expect(Object.keys(pkg.dependencies).sort()).toEqual([
			'@shikijs/rehype',
			'@tauri-apps/api',
			'@tauri-apps/plugin-dialog',
			'@tauri-apps/plugin-opener',
			'hast-util-to-mdast',
			'mdast-util-to-markdown',
			'mdast-util-to-string',
			'mermaid',
			'rehype-parse', // ← 本要件の唯一の追加(c56a544 で追加済み)
			'rehype-raw',
			'rehype-sanitize',
			'rehype-stringify',
			'remark-gfm',
			'remark-parse',
			'remark-rehype',
			'three',
			'unified',
			'unist-util-visit',
		]);
	});

	test('src/html/edit.ts は契約②のパイプライン(rehype-parse / rehype-sanitize)を使う', () => {
		const src = readRepoFile('src/html/edit.ts');
		expect(src).toMatch(/from ['"]rehype-parse['"]|from ['"]hast-util-from-html['"]/);
		expect(src).toMatch(/rehype-sanitize/);
	});

	test('既存の vellisSchema は無改変(値固定=JSON 化した SHA-256。拡張は新しいスキーマ定数を足す形)', () => {
		expect(sha256(JSON.stringify(vellisSchema))).toBe(
			'e6d3aed96a88d5f873e5be1bf9954124c5c32366fcef9003b73aae05c7fcb45a',
		);
	});
});
