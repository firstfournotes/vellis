/**
 * 要件#49 追補e の受け入れテスト(docs/requirements/req-49.md「追補e」・
 * backlog 264・265・266・267)— 緩いタスク項目の印・印の直後の改行・取り消し線(unit)
 *
 * src/markdown/edit.acceptance.test.ts(AC-49-1〜31)は書き換えず、追補e 用に新設。
 * 家風は同じ: 本番パイプライン(`render`)の HTML を JSDOM に載せ、`SourceIndex` の
 * `NodeMeta` を引いて `serializeBlock` / `replaceRange` を直接呼ぶ(`originSlice` も
 * Viewer の `commitBlockEdit` と同じく `index.sliceOf(meta.id)` を渡す)。
 *
 * ## 判定する契約と、実装に求める観測可能な振る舞い
 *
 * 契約⑥(未編集ブロック=byte 等価・編集ブロック=意味等価)に加えて、追補e(3) の
 * 「何も変えずに確定すると byte 等価」を求める。
 *
 * - **AC-49-32(追補e(1)(3)・backlog 264)**: 緩いタスクリスト(項目の間に空行)で
 *   本文が `**bold**` / `*em*` / `` `code` `` / `[link](./a.md)` で始まる項目(印は
 *   `[ ]` / `[x]` / `[X]`)の段落を、(a) 何も変えずに確定すると原文は byte 等価、
 *   (b) 末尾に文字を足して確定すると印は元の綴りのまま本文の変更だけが入る、
 *   (c) 確定後に再レンダーしてもタスク項目の数とチェックの状態が変わらない。
 *   本文が印に似た文字で始まる `- [ ] [x] foo`・1項目に2段落ある緩い項目・素の
 *   文字で始まる項目(AC-49-29 の範囲)でも同じ。
 *   (実測 2026-10-04・実装前: `- [ ] **bold** rest` の段落を無変更で確定すると
 *   `- **bold** rest`=印が消える)。`- [ ] [x] foo` だけは byte 等価を求めず意味等価
 *   (2026-10-04 オーケストレーター判断・由谷の事後確認: 本文先頭の `[` が `\[` になるのは既存の書き出しの性質)
 * - **AC-49-33(追補e(2)(3)・backlog 265・266)**: 印の直後で改行して次の行に本文を
 *   書いたタスク項目(`- [ ]\n  nl x`)を、密・緩い・番号付き(`1. [x]\n   nl x`)・
 *   CRLF の原文のそれぞれで、(a) 何も変えずに確定すると byte 等価(`\r` 単独の行末が
 *   残らない・字下げが落ちない)、(b) 本文を直して確定すると印・改行・字下げは元の
 *   ままで本文の変更だけが入る、(c) 再レンダーしてもタスク項目のまま。
 *   (実測 2026-10-04・実装前: 密=`- nl x`・緩い=`- [ ]\nnl x`・CRLF 緩い=
 *   `- [ ]\rnl x`・番号付き=`1. nl x`)
 * - **AC-49-34(追補e(4)・backlog 267)**: 取り消し線を含む段落・密/緩いリスト項目・
 *   表セル・見出しを、(a) 何も変えずに確定すると byte 等価、(b) 文字を足して確定
 *   すると例外を出さずに原文へ入り、取り消し線は `~~…~~` のまま、(c) 再レンダー
 *   しても取り消し線の範囲と中身が同じ。原文が `~del~`(1本)のときは確定後に
 *   `~~del~~`(表示は同じ=意味等価)。取り消し線の中の強調・リンクの入れ子も保つ。
 *   依存(`mdast-util-gfm-strikethrough`)は足さない。
 *   (実測 2026-10-04・実装前: `serializeBlock` が
 *   ``Cannot handle unknown node `delete` `` を投げる)
 *
 * ## 判定しないもの
 * - 2段落ある緩い項目の **li そのもの**を掴んだ確定(段落の結合は追補e の範囲外)
 * - チェックボックスのオン・オフの切り替え(ブロック編集の対象外・原文のまま)
 * - Viewer の配線(ダブルクリック→確定→editBuffer / dirty)
 *   → Viewer.blockedit-tasklist-strike.wiring.test.ts
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from './renderer';
import { replaceRange, resolveEditTarget, serializeBlock } from './edit';
import type { NodeMeta, SourceIndex } from './types';

const baseUri = 'file:///home/user/notes/doc.md';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

interface Mounted {
	html: string;
	index: SourceIndex;
	root: HTMLDivElement;
}

/** 本番パイプライン(`render`)の出力を JSDOM に載せる(edit.acceptance.test.ts の家風)。 */
async function mount(source: string): Promise<Mounted> {
	const result = await render(source, baseUri);
	const root = document.createElement('div');
	root.innerHTML = result.html;
	return { html: result.html, index: result.index, root };
}

function q(scope: ParentNode, selector: string): HTMLElement {
	const el = scope.querySelector(selector);
	if (!el) throw new Error(`要素が見つからない: ${selector}`);
	return el as HTMLElement;
}

/** 要素の `data-vellis-node-id` から NodeMeta を引く。 */
function metaOf(el: Element, index: SourceIndex): NodeMeta {
	const id = el.getAttribute('data-vellis-node-id');
	if (!id) throw new Error('data-vellis-node-id が無い');
	const meta = index.byId.get(id);
	if (!meta) throw new Error(`index に無い id: ${id}`);
	return meta;
}

/** 原文スライスが `slice` に一致するブロック(type 指定)を DOM と index から引く。 */
function blockBySlice(
	m: Mounted,
	type: string,
	slice: string,
): { el: HTMLElement; meta: NodeMeta } {
	for (const meta of m.index.byId.values()) {
		if (meta.type !== type) continue;
		if (m.index.sliceOf(meta.id) !== slice) continue;
		return { el: q(m.root, `[data-vellis-node-id="${meta.id}"]`), meta };
	}
	throw new Error(`${type} ブロック "${slice}" が index に無い`);
}

/**
 * 緩いタスク項目の段落を、画面の文言(`text` を含む)から引く。
 * 段落の原文範囲が印 `[ ] ` を含むか否か(mdast の都合)に判定を依存させないため、
 * スライスではなく DOM で探す。
 */
function taskParagraphByText(m: Mounted, text: string): { el: HTMLElement; meta: NodeMeta } {
	const el = [...m.root.querySelectorAll<HTMLElement>('li.task-list-item > p')].find((p) =>
		(p.textContent ?? '').includes(text),
	);
	if (!el) throw new Error(`タスク項目の段落 "${text}" が無い`);
	const meta = metaOf(el, m.index);
	expect(meta.type).toBe('paragraph');
	return { el, meta };
}

/** 文書順の最初のタスク項目(密=li / 緩い=li > p)。 */
function firstTaskBlock(m: Mounted, loose: boolean): { el: HTMLElement; meta: NodeMeta } {
	const el = q(m.root, loose ? 'li.task-list-item > p' : 'li.task-list-item');
	const meta = metaOf(el, m.index);
	expect(meta.type).toBe(loose ? 'paragraph' : 'listItem');
	return { el, meta };
}

/** ブロック末尾のテキストノードに `suffix` を足す(利用者が末尾に文字を打った形)。 */
function appendText(el: HTMLElement, suffix: string): void {
	const last = [...el.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE) as
		Text | undefined;
	if (!last) throw new Error('末尾のテキストノードが無い');
	last.data = last.data + suffix;
}

/**
 * 編集の1周: DOM を直した後のブロックを逆シリアライズして原文へ差し戻す。
 * `originSlice` は Viewer の `commitBlockEdit` と同じく初回レンダーのスライス。
 */
function commit(m: Mounted, source: string, el: HTMLElement, meta: NodeMeta): string {
	return replaceRange(
		source,
		meta.position,
		serializeBlock(el, meta, source, baseUri, m.index.sliceOf(meta.id)),
	);
}

/** `md` の中の `from`(1箇所)だけを `to` に替えた期待原文。 */
function replacedOnce(md: string, from: string, to: string): string {
	const at = md.indexOf(from);
	if (at < 0 || md.indexOf(from, at + 1) >= 0) {
		throw new Error(`期待原文の組み立てで "${from}" が一意でない`);
	}
	return md.slice(0, at) + to + md.slice(at + from.length);
}

/** 意味等価の比較用に、レンダー HTML から位置依存の属性を落とす。 */
function normalizeHtml(html: string): string {
	return html.replace(
		/ data-(?:vellis-node-id|source-start|source-end|source-start-line|source-end-line)="[^"]*"/g,
		'',
	);
}

/** 2つの Markdown が同じ HTML にレンダーされるか(契約⑥「意味等価」の機械判定)。 */
async function expectSameRender(actual: string, expected: string): Promise<void> {
	const [a, e] = await Promise.all([render(actual, baseUri), render(expected, baseUri)]);
	expect(normalizeHtml(a.html)).toBe(normalizeHtml(e.html));
}

/** 文書順のチェックボックスの状態。 */
function checkedStates(root: ParentNode): boolean[] {
	return [...root.querySelectorAll('li input[type="checkbox"]')].map((input) =>
		input.hasAttribute('checked'),
	);
}

/** 文書順の `li.task-list-item` の表示文字列(前後の空白は除く・改行は1空白に)。 */
function taskTexts(root: ParentNode): string[] {
	return [...root.querySelectorAll('li.task-list-item')].map((li) =>
		(li.textContent ?? '').replace(/\s+/g, ' ').trim(),
	);
}

/** 原文中のタスクの印の数(二重・消失の検知)。 */
function countMarks(md: string): number {
	return (md.match(/\[[ xX]\]/g) ?? []).length;
}

// ===========================================================================
// AC-49-32 — 緩いタスク項目の印は本文の書き出しに関わらず残る(追補e(1)(3))
// ===========================================================================

/**
 * 緩いタスクリスト。本文がインライン装飾で始まる項目(印3種 × 装飾4種のうち7組)・
 * 印に似た文字で始まる項目・2段落の項目・素の文字で始まる項目(AC-49-29 の回帰)。
 */
const LOOSE_DECOR_MD = [
	'# Tasks',
	'',
	'- [ ] **bold** rest',
	'',
	'- [x] **bold** done',
	'',
	'- [X] **bold** upper',
	'',
	'- [ ] *em* rest',
	'',
	'- [x] `code` rest',
	'',
	'- [X] [link](./a.md) rest',
	'',
	'- [ ] [x] foo',
	'',
	'- [x] **two** first',
	'',
	'  second para',
	'',
	'- [ ] plain',
	'',
	'Tail.',
	'',
].join('\n');

/** 文書順のチェック状態。 */
const LOOSE_DECOR_CHECKED = [false, true, true, false, true, true, false, true, false];

/** 装飾で始まる項目(段落の原文範囲が印を含む形)。 */
const DECOR_CASES: Array<[item: string, text: string, checked: boolean]> = [
	['- [ ] **bold** rest', 'bold rest', false],
	['- [x] **bold** done', 'bold done', true],
	['- [X] **bold** upper', 'bold upper', true],
	['- [ ] *em* rest', 'em rest', false],
	['- [x] `code` rest', 'code rest', true],
	['- [X] [link](./a.md) rest', 'link rest', true],
];

describe('AC-49-32 — レンダー結果の DOM では緩いタスクリストの段落の先頭にチェックボックスが来る(前提の確認)', () => {
	test('9 項目すべてが task-list-item で、チェック状態は原文どおり', async () => {
		const m = await mount(LOOSE_DECOR_MD);
		expect(m.root.querySelectorAll('li.task-list-item')).toHaveLength(9);
		expect(checkedStates(m.root)).toEqual(LOOSE_DECOR_CHECKED);
		for (const [, text] of DECOR_CASES) {
			const { el } = taskParagraphByText(m, text);
			expect(el.firstElementChild?.matches('input[type="checkbox"]')).toBe(true);
		}
	});

	test('`- [ ] [x] foo` の本文は `[x] foo` の文字で、チェックボックスは1つ', async () => {
		const m = await mount(LOOSE_DECOR_MD);
		const { el } = taskParagraphByText(m, '[x] foo');
		expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
		expect((el.textContent ?? '').trim()).toBe('[x] foo');
	});
});

describe('serializeBlock — 緩いタスク項目の本文が装飾で始まっても印は原文の綴りのまま(契約⑥・追補e(1)(3) / AC-49-32)', () => {
	test.each(DECOR_CASES)(
		'(a) %s: 段落を何も変えずに確定 → 原文は byte 等価',
		async (item, text) => {
			const m = await mount(LOOSE_DECOR_MD);
			const { el, meta } = taskParagraphByText(m, text);
			expect(resolveEditTarget(el, m.index).kind).toBe('block');
			expect(LOOSE_DECOR_MD).toContain(item);

			// 実測(2026-10-04・実装前): `- **bold** rest`(印が消える)。
			expect(commit(m, LOOSE_DECOR_MD, el, meta)).toBe(LOOSE_DECOR_MD);
		},
	);

	test.each(DECOR_CASES)(
		'(b) %s: 末尾に " edited" を足して確定 → 印は元の綴りのまま・本文の変更だけが入る・他は byte 等価',
		async (item, text) => {
			const m = await mount(LOOSE_DECOR_MD);
			const { el, meta } = taskParagraphByText(m, text);
			appendText(el, ' edited');

			const next = commit(m, LOOSE_DECOR_MD, el, meta);

			expect(next).toBe(replacedOnce(LOOSE_DECOR_MD, item, `${item} edited`));
			expect(countMarks(next)).toBe(countMarks(LOOSE_DECOR_MD));
			expect(next).not.toContain('\\[');
			// リンクの行き先は相対表記のまま(内部 URI が焼き付かない)。
			expect(next).not.toMatch(/file:\/\/|vellis-asset:\/\//);
		},
	);

	test.each(DECOR_CASES)(
		'(c) %s: 確定後の原文を再レンダーしても項目の数とチェックの状態が同じ',
		async (item, text, checked) => {
			const m = await mount(LOOSE_DECOR_MD);
			const { el, meta } = taskParagraphByText(m, text);
			appendText(el, ' edited');
			const next = commit(m, LOOSE_DECOR_MD, el, meta);

			const again = await mount(next);

			expect(again.root.querySelectorAll('li.task-list-item')).toHaveLength(9);
			expect(checkedStates(again.root)).toEqual(LOOSE_DECOR_CHECKED);
			const li = [...again.root.querySelectorAll('li.task-list-item')].find((n) =>
				(n.textContent ?? '').includes(`${text} edited`),
			);
			expect(li, `直した項目が再レンダーに無い: ${next}`).toBeDefined();
			expect(li?.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
			expect(li?.querySelector('input[type="checkbox"]')?.hasAttribute('checked')).toBe(checked);
			expect(li?.textContent).not.toContain('[');
			await expectSameRender(next, replacedOnce(LOOSE_DECOR_MD, item, `${item} edited`));
		},
	);
});

describe('serializeBlock — 本文が印に似た文字で始まる `- [ ] [x] foo` でも印を取り違えない(契約⑥・追補e(1)(3) / AC-49-32)', () => {
	const ITEM = '- [ ] [x] foo';

	test('(a) 段落を何も変えずに確定 → 印は `- [ ] ` の1つだけ・本文の `[x] foo` が残る・他の行は byte 等価・再レンダーが一致(意味等価)', async () => {
		const m = await mount(LOOSE_DECOR_MD);
		const { el, meta } = taskParagraphByText(m, '[x] foo');

		const next = commit(m, LOOSE_DECOR_MD, el, meta);

		// この形は byte 等価を求めない(2026-10-04 オーケストレーター判断・由谷の事後確認): 本文先頭の `[` が `\[` になるのは
		// 既存の書き出しの性質(トップレベルの段落 `[x] foo` でも同じ)。印の取り違えだけを見る。
		const lines = next.split('\n');
		const at = lines.findIndex((l) => l.endsWith('foo') && l.startsWith('- [ ] '));
		expect(at, `印 \`- [ ] \` で始まり foo で終わる行が無い: ${next}`).toBeGreaterThanOrEqual(0);
		const line = lines[at] as string;
		// 本文の `[x]` を印と取り違えて落とさない・印を二重にしない。
		expect(line).not.toMatch(/^- \[ \] \[ \]/);
		expect(line).not.toMatch(/^- \[x\]/);
		expect(line.replace(/\\\[/g, '[')).toBe(ITEM);
		expect(countMarks(next)).toBe(countMarks(LOOSE_DECOR_MD));
		// 他の行は byte 等価。
		expect([...lines.slice(0, at), ITEM, ...lines.slice(at + 1)].join('\n')).toBe(LOOSE_DECOR_MD);
		await expectSameRender(next, LOOSE_DECOR_MD);
		const again = await mount(next);
		expect(checkedStates(again.root)).toEqual(LOOSE_DECOR_CHECKED);
		expect(taskTexts(again.root)[6]).toBe('[x] foo');
	});

	test('(b) 末尾に " edited" を足して確定 → 行頭の印は `- [ ] ` の1つだけ・本文 `[x] foo edited` は意味等価・他の行は byte 等価', async () => {
		const m = await mount(LOOSE_DECOR_MD);
		const { el, meta } = taskParagraphByText(m, '[x] foo');
		appendText(el, ' edited');

		const next = commit(m, LOOSE_DECOR_MD, el, meta);

		const lines = next.split('\n');
		const at = lines.findIndex((l) => l.endsWith('foo edited'));
		expect(at, `直した行が無い: ${next}`).toBeGreaterThanOrEqual(0);
		const line = lines[at] as string;
		// 印は元の綴り `[ ]` が行頭に1つ。本文の `[x]` は印ではない(`- [x] ` にならない・
		// `- [ ] [ ] ` にならない)。
		expect(line.startsWith('- [ ] ')).toBe(true);
		expect(line).not.toMatch(/^- \[ \] \[ \]/);
		expect(line).not.toMatch(/^- \[x\]/);
		// 他の行は byte 等価。
		expect([...lines.slice(0, at), ITEM, ...lines.slice(at + 1)].join('\n')).toBe(LOOSE_DECOR_MD);
		await expectSameRender(next, replacedOnce(LOOSE_DECOR_MD, ITEM, `${ITEM} edited`));
	});

	test('(c) 確定後の原文を再レンダーしても項目の数とチェックの状態が同じで、本文に `[x] foo edited` が見える', async () => {
		const m = await mount(LOOSE_DECOR_MD);
		const { el, meta } = taskParagraphByText(m, '[x] foo');
		appendText(el, ' edited');
		const next = commit(m, LOOSE_DECOR_MD, el, meta);

		const again = await mount(next);

		expect(again.root.querySelectorAll('li.task-list-item')).toHaveLength(9);
		expect(checkedStates(again.root)).toEqual(LOOSE_DECOR_CHECKED);
		expect(taskTexts(again.root)[6]).toBe('[x] foo edited');
	});
});

describe('serializeBlock — 1項目に2段落ある緩い項目(契約⑥・追補e(1)(3) / AC-49-32)', () => {
	const ITEM_P1 = '- [x] **two** first';
	const ITEM_P2 = '  second para';

	test('(a) 1段落目(装飾始まり・印を持つ)を何も変えずに確定 → byte 等価', async () => {
		const m = await mount(LOOSE_DECOR_MD);
		const { el, meta } = taskParagraphByText(m, 'two first');

		// 実測(2026-10-04・実装前): `- **two** first`(印が消える)。
		expect(commit(m, LOOSE_DECOR_MD, el, meta)).toBe(LOOSE_DECOR_MD);
	});

	test('(b)(c) 1段落目の末尾に " edited" を足して確定 → 印は元のまま・2段落目は byte 等価・再レンダーで2段落のタスク項目のまま', async () => {
		const m = await mount(LOOSE_DECOR_MD);
		const { el, meta } = taskParagraphByText(m, 'two first');
		appendText(el, ' edited');

		const next = commit(m, LOOSE_DECOR_MD, el, meta);

		expect(next).toBe(replacedOnce(LOOSE_DECOR_MD, ITEM_P1, `${ITEM_P1} edited`));
		const again = await mount(next);
		expect(again.root.querySelectorAll('li.task-list-item')).toHaveLength(9);
		expect(checkedStates(again.root)).toEqual(LOOSE_DECOR_CHECKED);
		const li = [...again.root.querySelectorAll('li.task-list-item')][7];
		expect(li?.querySelectorAll(':scope > p')).toHaveLength(2);
		expect(li?.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
		expect(taskTexts(again.root)[7]).toBe('two first edited second para');
	});

	test('(a)(b) 2段落目(印を持たない)は何も変えずに確定で byte 等価・" edited" を足すと印も1段落目も byte 等価のまま(回帰ガード)', async () => {
		const m = await mount(LOOSE_DECOR_MD);
		const { el, meta } = taskParagraphByText(m, 'second para');
		expect(el.querySelector('input')).toBeNull();
		expect(commit(m, LOOSE_DECOR_MD, el, meta)).toBe(LOOSE_DECOR_MD);

		appendText(el, ' edited');
		const next = commit(m, LOOSE_DECOR_MD, el, meta);

		expect(next).toBe(replacedOnce(LOOSE_DECOR_MD, ITEM_P2, `${ITEM_P2} edited`));
		expect(countMarks(next)).toBe(countMarks(LOOSE_DECOR_MD));
		const again = await mount(next);
		expect(checkedStates(again.root)).toEqual(LOOSE_DECOR_CHECKED);
		expect(taskTexts(again.root)[7]).toBe('two first second para edited');
	});
});

describe('serializeBlock — 素の文字で始まる緩いタスク項目は引き続き保たれる(AC-49-29 の回帰 / AC-49-32)', () => {
	const ITEM = '- [ ] plain';

	test('(a) 何も変えずに確定 → byte 等価', async () => {
		const m = await mount(LOOSE_DECOR_MD);
		const { el, meta } = taskParagraphByText(m, 'plain');
		expect(commit(m, LOOSE_DECOR_MD, el, meta)).toBe(LOOSE_DECOR_MD);
	});

	test('(b)(c) " edited" を足して確定 → `- [ ] plain edited`・再レンダーで項目の数とチェック状態が同じ', async () => {
		const m = await mount(LOOSE_DECOR_MD);
		const { el, meta } = taskParagraphByText(m, 'plain');
		appendText(el, ' edited');

		const next = commit(m, LOOSE_DECOR_MD, el, meta);

		expect(next).toBe(replacedOnce(LOOSE_DECOR_MD, ITEM, `${ITEM} edited`));
		const again = await mount(next);
		expect(again.root.querySelectorAll('li.task-list-item')).toHaveLength(9);
		expect(checkedStates(again.root)).toEqual(LOOSE_DECOR_CHECKED);
		expect(taskTexts(again.root)[8]).toBe('plain edited');
	});
});

// ===========================================================================
// AC-49-33 — 印の直後の改行が残る(追補e(2)(3))
// ===========================================================================

interface NewlineCase {
	/** 見出し用。 */
	label: string;
	md: string;
	/** 緩いリストなら編集単位は `li > p`、密なら `li`。 */
	loose: boolean;
	/** 直す項目の原文(1つ目の項目)。 */
	item: string;
	/** 直した後の項目の原文。 */
	edited: string;
	/** 文書順のチェック状態(2項目)。 */
	checked: boolean[];
	/** 文書順の項目の表示文字列(編集前)。 */
	texts: string[];
}

const NEWLINE_CASES: NewlineCase[] = [
	{
		label: '密・LF `- [ ]\\n  nl x`',
		md: '- [ ]\n  nl x\n- [x] done\n',
		loose: false,
		item: '- [ ]\n  nl x',
		edited: '- [ ]\n  nl x edited',
		checked: [false, true],
		texts: ['nl x', 'done'],
	},
	{
		label: '緩い・LF `- [ ]\\n  nl x`',
		md: '- [ ]\n  nl x\n\n- [x] done\n',
		loose: true,
		item: '- [ ]\n  nl x',
		edited: '- [ ]\n  nl x edited',
		checked: [false, true],
		texts: ['nl x', 'done'],
	},
	{
		label: '番号付き・密・LF `1. [x]\\n   nl x`',
		md: '1. [x]\n   nl x\n2. [ ] b\n',
		loose: false,
		item: '1. [x]\n   nl x',
		edited: '1. [x]\n   nl x edited',
		checked: [true, false],
		texts: ['nl x', 'b'],
	},
	{
		label: '番号付き・緩い・LF `1. [x]\\n   nl x`',
		md: '1. [x]\n   nl x\n\n2. [ ] b\n',
		loose: true,
		item: '1. [x]\n   nl x',
		edited: '1. [x]\n   nl x edited',
		checked: [true, false],
		texts: ['nl x', 'b'],
	},
	{
		label: '密・CRLF `- [ ]\\r\\n  nl x`',
		md: '- [ ]\r\n  nl x\r\n- [x] done\r\n',
		loose: false,
		item: '- [ ]\r\n  nl x',
		edited: '- [ ]\r\n  nl x edited',
		checked: [false, true],
		texts: ['nl x', 'done'],
	},
	{
		label: '緩い・CRLF `- [ ]\\r\\n  nl x`',
		md: '- [ ]\r\n  nl x\r\n\r\n- [x] done\r\n',
		loose: true,
		item: '- [ ]\r\n  nl x',
		edited: '- [ ]\r\n  nl x edited',
		checked: [false, true],
		texts: ['nl x', 'done'],
	},
	{
		label: '緩い・LF・装飾始まり `- [ ]\\n  **x** y`(264 と 265 の重なり)',
		md: '- [ ]\n  **x** y\n\n- [x] done\n',
		loose: true,
		item: '- [ ]\n  **x** y',
		edited: '- [ ]\n  **x** y edited',
		checked: [false, true],
		texts: ['x y', 'done'],
	},
	{
		label: '緩い・CRLF・装飾始まり `- [ ]\\r\\n  **nl** x`(266 の実測の形)',
		md: '- [ ]\r\n  **nl** x\r\n\r\n- [x] done\r\n',
		loose: true,
		item: '- [ ]\r\n  **nl** x',
		edited: '- [ ]\r\n  **nl** x edited',
		checked: [false, true],
		texts: ['nl x', 'done'],
	},
];

/** `\r` が `\n` を伴わずに現れる箇所(CRLF の原文で行末が混在した証拠)。 */
const LONE_CR = /\r(?!\n)/;

describe('AC-49-33 — レンダー結果の DOM では印の直後で改行した項目もタスク項目になっている(前提の確認)', () => {
	test.each(NEWLINE_CASES)(
		'$label: 2項目とも task-list-item でチェック状態は原文どおり',
		async (c) => {
			const m = await mount(c.md);
			expect(m.root.querySelectorAll('li.task-list-item')).toHaveLength(2);
			expect(checkedStates(m.root)).toEqual(c.checked);
			expect(taskTexts(m.root)).toEqual(c.texts);
			expect(c.md).toContain(c.item);
		},
	);
});

describe('serializeBlock — 印の直後の改行・字下げ・行末は原文の綴りのまま(契約⑥・追補e(2)(3) / AC-49-33)', () => {
	test.each(NEWLINE_CASES)('(a) $label: 何も変えずに確定 → 原文は byte 等価', async (c) => {
		const m = await mount(c.md);
		const { el, meta } = firstTaskBlock(m, c.loose);
		expect(resolveEditTarget(el, m.index).kind).toBe('block');

		const next = commit(m, c.md, el, meta);

		// 実測(2026-10-04・実装前): 密=`- nl x`・緩い=`- [ ]\nnl x`・CRLF 緩い=`- [ ]\rnl x`。
		expect(next).not.toMatch(LONE_CR);
		expect(next).toBe(c.md);
	});

	test.each(NEWLINE_CASES)(
		'(b) $label: 本文の末尾に " edited" を足して確定 → 印・改行・字下げは元のままで本文の変更だけが入る',
		async (c) => {
			const m = await mount(c.md);
			const { el, meta } = firstTaskBlock(m, c.loose);
			appendText(el, ' edited');

			const next = commit(m, c.md, el, meta);

			expect(next).not.toMatch(LONE_CR);
			expect(next).toBe(replacedOnce(c.md, c.item, c.edited));
			expect(countMarks(next)).toBe(countMarks(c.md));
			expect(next).not.toContain('\\[');
		},
	);

	test.each(NEWLINE_CASES)(
		'(c) $label: 確定後の原文を再レンダーしてもタスク項目のまま(数・チェック状態・本文)',
		async (c) => {
			const m = await mount(c.md);
			const { el, meta } = firstTaskBlock(m, c.loose);
			appendText(el, ' edited');
			const next = commit(m, c.md, el, meta);

			const again = await mount(next);

			expect(again.root.querySelectorAll('li.task-list-item')).toHaveLength(2);
			expect(checkedStates(again.root)).toEqual(c.checked);
			expect(taskTexts(again.root)).toEqual([`${c.texts[0]} edited`, c.texts[1] as string]);
			expect(taskTexts(again.root)[0]).not.toContain('[');
			await expectSameRender(next, replacedOnce(c.md, c.item, c.edited));
		},
	);
});

describe('非退行 — CRLF の原文でも印の直後に本文が続く項目・素の段落は byte 等価のまま(AC-49-29 / AC-49-33)', () => {
	const CRLF_PLAIN_MD = '# T\r\n\r\nPara one\r\n\r\n- [ ] a\r\n- [x] b\r\n';

	test('`- [ ] a`(密・CRLF)を何も変えずに確定 → byte 等価、" edited" を足すと `- [ ] a edited` で行末は CRLF のまま', async () => {
		const m = await mount(CRLF_PLAIN_MD);
		const { el, meta } = blockBySlice(m, 'listItem', '- [ ] a');
		expect(commit(m, CRLF_PLAIN_MD, el, meta)).toBe(CRLF_PLAIN_MD);

		appendText(el, ' edited');
		const next = commit(m, CRLF_PLAIN_MD, el, meta);

		expect(next).toBe(replacedOnce(CRLF_PLAIN_MD, '- [ ] a', '- [ ] a edited'));
		expect(next).not.toMatch(LONE_CR);
	});

	test('段落 `Para one`(CRLF)を何も変えずに確定 → byte 等価', async () => {
		const m = await mount(CRLF_PLAIN_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', 'Para one');
		expect(commit(m, CRLF_PLAIN_MD, el, meta)).toBe(CRLF_PLAIN_MD);
	});
});

// ===========================================================================
// AC-49-34 — 取り消し線を含むブロックを確定できる(追補e(4))
// ===========================================================================

/**
 * 取り消し線を含むブロック5種(段落・密/緩いリスト項目・表セル・見出し)と、
 * 1本の `~del~`・入れ子(強調+相対リンク)の段落。密と緩いリストは段落で隔てて
 * 別のリストにする(空行で続けると全体が緩いリストになる)。
 */
const STRIKE_MD = [
	'# Title',
	'',
	'Para ~~del~~ x',
	'',
	'- item ~~a~~ b',
	'- other',
	'',
	'Between.',
	'',
	'- loose ~~c~~ d',
	'',
	'- loose2',
	'',
	'| A | B |',
	'| --- | --- |',
	'| ~~a1~~ | b1 |',
	'',
	'## Head ~~gone~~ here',
	'',
	'Single ~del~ x',
	'',
	'Nest ~~**b** [l](./a.md)~~ x',
	'',
	'Tail.',
	'',
].join('\n');

interface StrikeCase {
	label: string;
	type: string;
	/** `blockBySlice` で引く原文スライス。 */
	slice: string;
	/** 末尾に " more" を足したときの期待スライス。 */
	edited: string;
	/** その `del` の表示文字列。 */
	del: string;
}

const STRIKE_CASES: StrikeCase[] = [
	{
		label: '段落',
		type: 'paragraph',
		slice: 'Para ~~del~~ x',
		edited: 'Para ~~del~~ x more',
		del: 'del',
	},
	{
		label: '密なリスト項目',
		type: 'listItem',
		slice: '- item ~~a~~ b',
		edited: '- item ~~a~~ b more',
		del: 'a',
	},
	{
		label: '緩いリスト項目の段落',
		type: 'paragraph',
		slice: 'loose ~~c~~ d',
		edited: 'loose ~~c~~ d more',
		del: 'c',
	},
	{
		label: '表セル',
		type: 'tableCell',
		slice: '| ~~a1~~ ',
		edited: '| ~~a1~~ more ',
		del: 'a1',
	},
	{
		label: '見出し',
		type: 'heading',
		slice: '## Head ~~gone~~ here',
		edited: '## Head ~~gone~~ here more',
		del: 'gone',
	},
];

/** 文書順の `del` の表示文字列。 */
function delTexts(root: ParentNode): string[] {
	return [...root.querySelectorAll('del')].map((d) => d.textContent ?? '');
}

/** 文書順の `del` を含むブロックの種類(取り消し線の範囲が変わっていないか)。 */
function delHolders(root: ParentNode): string[] {
	return [...root.querySelectorAll('del')].map(
		(d) =>
			d
				.closest('[data-vellis-node-type]:not([data-vellis-node-type="delete"])')
				?.getAttribute('data-vellis-node-type') ?? '',
	);
}

/** ブロックの末尾にテキストを足す(末尾のテキストノードが無ければ新しく足す=表セル)。 */
function appendAtEnd(el: HTMLElement, text: string): void {
	const last = el.lastChild;
	if (last && last.nodeType === Node.TEXT_NODE) (last as Text).data += text;
	else el.appendChild(document.createTextNode(text));
}

describe('AC-49-34 — レンダー結果の DOM では取り消し線が `del` になっている(前提の確認)', () => {
	test('`~~…~~` も `~del~` も `del` で、入れ子の強調・リンクはその中', async () => {
		const m = await mount(STRIKE_MD);
		expect(delTexts(m.root)).toEqual(['del', 'a', 'c', 'a1', 'gone', 'del', 'b l']);
		// 密なリストは `<p>` を出さないので、`del` に一番近いブロックは li(STRIKE_CASES も listItem で引く)。
		expect(delHolders(m.root)).toEqual([
			'paragraph',
			'listItem',
			'paragraph',
			'tableCell',
			'heading',
			'paragraph',
			'paragraph',
		]);
		const nest = [...m.root.querySelectorAll('del')][6];
		expect(nest?.querySelector('strong')?.textContent).toBe('b');
		expect(nest?.querySelector('a')?.getAttribute('href')).toBe('file:///home/user/notes/a.md');
	});
});

describe('serializeBlock — 取り消し線を含むブロックは `~~…~~` のまま確定できる(契約②⑥・追補e(4) / AC-49-34)', () => {
	test.each(STRIKE_CASES)(
		'(a) $label: 何も変えずに確定 → 例外を出さず原文は byte 等価',
		async (c) => {
			const m = await mount(STRIKE_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);
			expect(resolveEditTarget(el, m.index).kind).toBe('block');

			// 実測(2026-10-04・実装前): ``Cannot handle unknown node `delete` `` を投げる。
			let next = '';
			expect(() => {
				next = commit(m, STRIKE_MD, el, meta);
			}).not.toThrow();
			expect(next).toBe(STRIKE_MD);
		},
	);

	test.each(STRIKE_CASES)(
		'(b) $label: 末尾に " more" を足して確定 → 例外を出さず原文へ入り、取り消し線は `~~…~~` のまま・他は byte 等価',
		async (c) => {
			const m = await mount(STRIKE_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);
			appendAtEnd(el, ' more');

			let next = '';
			expect(() => {
				next = commit(m, STRIKE_MD, el, meta);
			}).not.toThrow();

			expect(next).toBe(replacedOnce(STRIKE_MD, c.slice, c.edited));
			expect(next).toContain(`~~${c.del}~~`);
		},
	);

	test.each(STRIKE_CASES)(
		'(c) $label: 確定後の原文を再レンダーしても取り消し線の範囲と中身が同じ',
		async (c) => {
			const m = await mount(STRIKE_MD);
			const { el, meta } = blockBySlice(m, c.type, c.slice);
			appendAtEnd(el, ' more');
			const next = commit(m, STRIKE_MD, el, meta);

			const again = await mount(next);

			expect(delTexts(again.root)).toEqual(delTexts(m.root));
			expect(delHolders(again.root)).toEqual(delHolders(m.root));
			await expectSameRender(next, replacedOnce(STRIKE_MD, c.slice, c.edited));
		},
	);

	test('取り消し線の中の文字を直して確定 → `~~del more~~`(範囲が中の文字ごと保たれる)', async () => {
		const m = await mount(STRIKE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', 'Para ~~del~~ x');
		const del = q(el, 'del');
		del.textContent = 'del more';

		const next = commit(m, STRIKE_MD, el, meta);

		expect(next).toBe(replacedOnce(STRIKE_MD, 'Para ~~del~~ x', 'Para ~~del more~~ x'));
		const again = await mount(next);
		expect(delTexts(again.root)[0]).toBe('del more');
	});
});

describe('serializeBlock — 1本の `~del~` は確定後に `~~del~~` へ揃う(表示は同じ・追補e(4) / AC-49-34)', () => {
	const SINGLE = 'Single ~del~ x';

	test('何も変えずに確定 → `Single ~~del~~ x`(他は byte 等価・再レンダーは同じ)', async () => {
		const m = await mount(STRIKE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', SINGLE);

		let next = '';
		expect(() => {
			next = commit(m, STRIKE_MD, el, meta);
		}).not.toThrow();

		expect(next).toBe(replacedOnce(STRIKE_MD, SINGLE, 'Single ~~del~~ x'));
		await expectSameRender(next, STRIKE_MD);
		expect(delTexts((await mount(next)).root)).toEqual(delTexts(m.root));
	});

	test('末尾に " more" を足して確定 → `Single ~~del~~ x more`', async () => {
		const m = await mount(STRIKE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', SINGLE);
		appendAtEnd(el, ' more');

		const next = commit(m, STRIKE_MD, el, meta);

		expect(next).toBe(replacedOnce(STRIKE_MD, SINGLE, 'Single ~~del~~ x more'));
		expect(next).not.toContain('~del~ ');
	});
});

describe('serializeBlock — 取り消し線の中の強調・リンクの入れ子を保つ(追補e(4) / AC-49-34)', () => {
	const NEST = 'Nest ~~**b** [l](./a.md)~~ x';

	test('(a) 何も変えずに確定 → byte 等価(相対リンクの綴りも原文のまま)', async () => {
		const m = await mount(STRIKE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', NEST);

		let next = '';
		expect(() => {
			next = commit(m, STRIKE_MD, el, meta);
		}).not.toThrow();
		expect(next).toBe(STRIKE_MD);
	});

	test('(b)(c) 末尾に " more" を足して確定 → `~~**b** [l](./a.md)~~` のまま・内部 URI が混入しない・再レンダーで入れ子が同じ', async () => {
		const m = await mount(STRIKE_MD);
		const { el, meta } = blockBySlice(m, 'paragraph', NEST);
		appendAtEnd(el, ' more');

		const next = commit(m, STRIKE_MD, el, meta);

		expect(next).toBe(replacedOnce(STRIKE_MD, NEST, `${NEST} more`));
		expect(next).not.toMatch(/file:\/\/|vellis-asset:\/\//);
		const again = await mount(next);
		const nest = [...again.root.querySelectorAll('del')][6];
		expect(nest?.textContent).toBe('b l');
		expect(nest?.querySelector('strong')?.textContent).toBe('b');
		expect(nest?.querySelector('a')?.getAttribute('href')).toBe('file:///home/user/notes/a.md');
	});
});

describe('依存 — 取り消し線の書き戻しに `mdast-util-gfm-strikethrough` を足さない(追補e(4) / AC-49-34)', () => {
	const REPO_ROOT = resolve(__dirname, '../..');

	test('package.json の dependencies / devDependencies に `mdast-util-gfm-strikethrough` / `mdast-util-gfm` が無い', () => {
		const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const names = [
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.devDependencies ?? {}),
		];
		expect(names).not.toContain('mdast-util-gfm-strikethrough');
		expect(names).not.toContain('mdast-util-gfm');
	});

	test('src/markdown/edit.ts が `mdast-util-gfm` 系を import しない', () => {
		const src = readFileSync(resolve(REPO_ROOT, 'src/markdown/edit.ts'), 'utf8');
		expect(src).not.toMatch(/from\s+['"]mdast-util-gfm/);
		expect(src).not.toMatch(/import\s*\(\s*['"]mdast-util-gfm/);
	});
});
