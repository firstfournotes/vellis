/**
 * 要件#13 の受け入れテスト(requirements.md 要件13・GitHub Issue 26)
 * 「部分選択のコピーは選択した範囲だけをコピーする(選択を含む行・段落全体に広がらない)」
 *
 * 対象: Viewer の oncopy 経路の核 `resolveSelectionToMarkdown`(src/markdown/selection.ts)
 * とマークアンカー構築 `buildAnchor`。Viewer.svelte 側の配線(handleCopy が
 * result.markdown を text/plain へ載せる)は現行のまま=reviewer 照合。
 *
 * 契約(要件13 の①〜④に対応):
 *
 * ① 同一ブロック内の部分選択 → コピー結果は選択範囲に対応するソース断片のみ。
 *    囲みブロック(段落)全体へ拡大しない。先頭接触・末尾接触・逆方向ドラッグ
 *    (focus が anchor より前)も同様。ブロック全体の選択は従来どおりブロックの
 *    ソース全体でよい。
 *
 * ② コピー内容は従来どおり Markdown ソース断片(Phase B=copy-original-markdown.md
 *    §B-3 の踏襲)。装飾ノード全体を覆う選択はその装飾記法(** 等)ごとコピー。
 *    装飾要素の内部だけの部分選択はその部分の文字列のみ。
 *
 * ③ 端点の文字単位ナローイングが確実にできない場合(エスケープ・文字実体参照で
 *    表示テキストとソースの対応が取れない場合)は現行のノード単位スライスへ
 *    フォールバック(null・例外にしない=現状より悪化しない)。
 *    ※フォールバックせず正確にナローイングできる実装も契約適合とみなし、
 *      期待値は「正確なソース断片 または ノード単位スライス」の二値で判定する。
 *
 * ④ buildAnchor のノード単位フィールド(nodeId/nodeType/startLine/endLine/
 *    startOffset/endOffset/contextBefore/contextAfter/headingPath)は現行維持=
 *    ノード粒度のまま(マーク位置決めの契約は変えない)。selectedText は
 *    sel.toString() のまま。selectedMarkdown が選択範囲へ狭まるのは許容
 *    (=狭窄値/ノード単位値の二値で判定)。
 *
 * 赤/緑の設計(test-runner 向け): ①の部分選択系と②の部分選択系は、現行実装
 * (端点を [data-vellis-node-id] 祖先ノードの source range へ丸める)では赤に
 * なるのが正しい。①の全選択・②の装飾全体・③・④・回帰系は現行でも緑
 * (悪化防止・現行維持のガード)。
 *
 * スコープ外(このテストは扱わない): Viewer.svelte の oncopy 配線(reviewer 照合)・
 * 複数ブロックにまたがる部分選択の端点ナローイング(契約①は「同一ブロック内」
 * のみを規定)・装飾ノードの途中までしか覆わない選択(例: 「before **bo」相当)の
 * マーカー取り扱い(契約に規定なし=申し送り)。
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { render } from './renderer';
import { buildAnchor, resolveSelectionToMarkdown } from './selection';

const baseUri = 'file:///home/user/notes/doc.md';

async function mount(source: string): Promise<{
	source: string;
	index: Awaited<ReturnType<typeof render>>['index'];
	root: HTMLDivElement;
}> {
	const result = await render(source, baseUri);
	const root = document.createElement('div');
	root.innerHTML = result.html;
	document.body.append(root);
	return { source, index: result.index, root };
}

beforeEach(() => {
	document.body.innerHTML = '';
});

/** 文字単位の端点を持つ選択を作る(ユーザーのドラッグ選択の再現)。 */
function selectRange(
	startNode: Node,
	startOffset: number,
	endNode: Node,
	endOffset: number,
): Selection {
	const sel = window.getSelection();
	if (!sel) throw new Error('no selection');
	sel.removeAllRanges();
	const range = document.createRange();
	range.setStart(startNode, startOffset);
	range.setEnd(endNode, endOffset);
	sel.addRange(range);
	return sel;
}

/** 要素の最初の子がテキストノードであることを検査して返す(前提の早期失敗)。 */
function textChild(el: Element): Text {
	const child = el.firstChild;
	if (!child || child.nodeType !== Node.TEXT_NODE) {
		throw new Error(`expected first child of <${el.tagName}> to be a text node`);
	}
	return child as Text;
}

function nodeIdOf(el: Element): string {
	const id = el.getAttribute('data-vellis-node-id');
	if (!id) throw new Error('element has no data-vellis-node-id');
	return id;
}

describe('要件13-① 同一ブロック内の部分選択は選択範囲のソース断片のみ', () => {
	test('段落中のプレーンテキストの一部だけの選択 → その文字列のみ(段落全体に広がらない)', async () => {
		const src = 'The 3D CAD viewer is here.\n';
		const { index, source, root } = await mount(src);

		const p = root.querySelector('p[data-vellis-node-id]')!;
		const textNode = textChild(p);
		const start = textNode.data.indexOf('3D CAD');
		expect(start).toBeGreaterThanOrEqual(0);

		const sel = selectRange(textNode, start, textNode, start + '3D CAD'.length);
		// 選択再現の前提確認(ここで落ちたらテスト側の組み立て不備)
		expect(sel.toString()).toBe('3D CAD');

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		expect(result!.markdown).toBe('3D CAD');
	});

	test('選択が段落先頭に接する部分選択 → 先頭からの選択部分のみ', async () => {
		const src = 'The 3D CAD viewer is here.\n';
		const { index, source, root } = await mount(src);

		const textNode = textChild(root.querySelector('p[data-vellis-node-id]')!);
		const sel = selectRange(textNode, 0, textNode, 'The 3D'.length);
		expect(sel.toString()).toBe('The 3D');

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		expect(result!.markdown).toBe('The 3D');
	});

	test('選択が段落末尾に接する部分選択 → 末尾までの選択部分のみ', async () => {
		const src = 'The 3D CAD viewer is here.\n';
		const { index, source, root } = await mount(src);

		const textNode = textChild(root.querySelector('p[data-vellis-node-id]')!);
		const start = textNode.data.indexOf('here.');
		expect(start).toBeGreaterThanOrEqual(0);
		const sel = selectRange(textNode, start, textNode, textNode.data.length);
		expect(sel.toString()).toBe('here.');

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		expect(result!.markdown).toBe('here.');
	});

	test('段落全体の選択 → 従来どおり段落ソース全体(狭めすぎない)', async () => {
		const src = 'The 3D CAD viewer is here.\n';
		const { index, source, root } = await mount(src);

		const p = root.querySelector('p[data-vellis-node-id]')!;
		const textNode = textChild(p);
		const sel = selectRange(textNode, 0, textNode, textNode.data.length);
		expect(sel.toString()).toBe('The 3D CAD viewer is here.');

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		expect(result!.markdown).toBe('The 3D CAD viewer is here.');
		expect(result!.markdown).toBe(index.sliceOf(nodeIdOf(p)));
	});

	test('逆方向ドラッグ(anchor が focus より後)の部分選択も選択部分のみ', async () => {
		const src = 'The 3D CAD viewer is here.\n';
		const { index, source, root } = await mount(src);

		const textNode = textChild(root.querySelector('p[data-vellis-node-id]')!);
		const start = textNode.data.indexOf('3D CAD');
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		// 右→左ドラッグの再現: anchor=選択末尾・focus=選択先頭
		sel.setBaseAndExtent(textNode, start + '3D CAD'.length, textNode, start);
		expect(sel.toString()).toBe('3D CAD');

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		expect(result!.markdown).toBe('3D CAD');
	});
});

describe('要件13-② コピー内容は Markdown ソース断片(装飾は記法ごと)', () => {
	const src = 'before **bold** after.\n';

	test('プレーン先頭〜装飾ノード全体を覆う選択 → 装飾記法(**)ごとコピー', async () => {
		const { index, source, root } = await mount(src);

		const p = root.querySelector('p[data-vellis-node-id]')!;
		const leadText = textChild(p); // 'before '
		const strong = p.querySelector('strong[data-vellis-node-id]')!;
		const strongText = textChild(strong); // 'bold'

		const sel = selectRange(leadText, 0, strongText, strongText.data.length);
		expect(sel.toString()).toBe('before bold');

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		expect(result!.markdown).toBe('before **bold**');
	});

	test('装飾ノードをまたぎ両端がプレーンテキストの部分選択 → 端点間のソース断片(記法込み)', async () => {
		const { index, source, root } = await mount(src);

		const p = root.querySelector('p[data-vellis-node-id]')!;
		const leadText = textChild(p); // 'before '
		const tailText = p.lastChild; // ' after.'
		expect(tailText?.nodeType).toBe(Node.TEXT_NODE);

		// 表示 'ore bold af' ⇔ ソース 'ore **bold** af'
		const sel = selectRange(leadText, 3, tailText as Text, 3);
		expect(sel.toString()).toBe('ore bold af');

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		expect(result!.markdown).toBe('ore **bold** af');
	});

	test('装飾要素の内部だけの部分選択 → その部分の文字列のみ(記法は付かない)', async () => {
		const { index, source, root } = await mount(src);

		const strongText = textChild(root.querySelector('strong[data-vellis-node-id]')!);
		const sel = selectRange(strongText, 1, strongText, 3);
		expect(sel.toString()).toBe('ol');

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		expect(result!.markdown).toBe('ol');
	});

	test('装飾要素全体の選択 → 従来どおり記法込み(回帰ガード)', async () => {
		const { index, source, root } = await mount(src);

		const strong = root.querySelector('strong[data-vellis-node-id]')!;
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		const range = document.createRange();
		range.selectNodeContents(strong);
		sel.addRange(range);

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		expect(result!.markdown).toBe('**bold**');
	});
});

describe('要件13-③ ナローイング不能時はノード単位スライスへフォールバック(悪化しない)', () => {
	test('バックスラッシュエスケープを含む段落の部分選択 → null/例外にならず、正確な断片かノード単位スライス', async () => {
		const src = 'An \\*escaped\\* literal here.\n';
		const { index, source, root } = await mount(src);

		const p = root.querySelector('p[data-vellis-node-id]')!;
		const textNode = textChild(p);
		// 表示は 'An *escaped* literal here.'(バックスラッシュは表示されない)
		const start = textNode.data.indexOf('*escaped*');
		expect(start).toBeGreaterThanOrEqual(0);
		const sel = selectRange(textNode, start, textNode, start + '*escaped*'.length);
		expect(sel.toString()).toBe('*escaped*');

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		// 正確にナローイングできるなら '\*escaped\*'。できないならノード単位
		// スライス(段落ソース全体)へのフォールバック。どちらも契約適合。
		expect([index.sliceOf(nodeIdOf(p)), '\\*escaped\\*']).toContain(result!.markdown);
	});

	test('文字実体参照(&amp;)を含む段落の部分選択 → null/例外にならず、正確な断片かノード単位スライス', async () => {
		const src = 'Tom &amp; Jerry cartoon classic.\n';
		const { index, source, root } = await mount(src);

		const p = root.querySelector('p[data-vellis-node-id]')!;
		const textNode = textChild(p);
		// 表示は 'Tom & Jerry cartoon classic.'(実体参照は '&' に解決される)
		const sel = selectRange(textNode, 0, textNode, 'Tom & Jerry'.length);
		expect(sel.toString()).toBe('Tom & Jerry');

		const result = resolveSelectionToMarkdown(sel, index, source);
		expect(result).not.toBeNull();
		expect([index.sliceOf(nodeIdOf(p)), 'Tom &amp; Jerry']).toContain(result!.markdown);
	});
});

describe('要件13-④ buildAnchor のノード単位フィールドは現行維持', () => {
	test('部分選択でも nodeId/行/オフセット/コンテキストはノード粒度のまま(マーク位置決めの契約)', async () => {
		const src = '# Title\n\nThe 3D CAD viewer is here.\n\nOutro paragraph.\n';
		const { index, source, root } = await mount(src);

		const p = [...root.querySelectorAll('p[data-vellis-node-id]')].find((el) =>
			el.textContent?.includes('3D CAD'),
		)!;
		const pId = nodeIdOf(p);
		const pMeta = index.byId.get(pId)!;

		const textNode = textChild(p);
		const start = textNode.data.indexOf('3D CAD');
		const sel = selectRange(textNode, start, textNode, start + '3D CAD'.length);
		expect(sel.toString()).toBe('3D CAD');

		const anchor = buildAnchor(sel, index, source, 'sha256-req13');
		expect(anchor).not.toBeNull();

		// ノード単位フィールド=段落ノードの粒度(選択範囲へ狭まらない)
		expect(anchor!.nodeId).toBe(pId);
		expect(anchor!.nodeType).toBe('paragraph');
		expect(anchor!.startLine).toBe(pMeta.position.startLine);
		expect(anchor!.endLine).toBe(pMeta.position.endLine);
		expect(anchor!.startOffset).toBe(pMeta.position.startOffset);
		expect(anchor!.endOffset).toBe(pMeta.position.endOffset);
		expect(source.slice(anchor!.startOffset, anchor!.endOffset)).toBe(
			'The 3D CAD viewer is here.',
		);

		// コンテキスト行もノード粒度の行番号から導かれる(現行維持)
		const lines = source.split('\n');
		expect(anchor!.contextBefore).toBe(lines[pMeta.position.startLine - 2] ?? '');
		expect(anchor!.contextAfter).toBe(lines[pMeta.position.endLine] ?? '');

		expect(anchor!.headingPath).toEqual(['Title']);
		expect(anchor!.selectedText).toBe('3D CAD');
		expect(anchor!.fileHash).toBe('sha256-req13');

		// selectedMarkdown は選択範囲へ狭まるのは許容(①に忠実)・ノード単位値も可
		expect(['3D CAD', index.sliceOf(pId)]).toContain(anchor!.selectedMarkdown);
	});
});

describe('要件13-回帰 既存契約の維持', () => {
	test('collapsed selection は null(resolveSelectionToMarkdown / buildAnchor とも)', async () => {
		const { index, source } = await mount('The 3D CAD viewer is here.\n');
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		expect(resolveSelectionToMarkdown(sel, index, source)).toBeNull();
		expect(buildAnchor(sel, index, source, 'h')).toBeNull();
	});

	test('レンダー外([data-vellis-node-id] 祖先なし)の選択は null', async () => {
		const { index, source } = await mount('The 3D CAD viewer is here.\n');

		const isolated = document.createElement('div');
		isolated.innerHTML = '<span>plain outside text</span>';
		document.body.append(isolated);

		const span = isolated.querySelector('span')!;
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		const range = document.createRange();
		range.selectNodeContents(span);
		sel.addRange(range);

		expect(resolveSelectionToMarkdown(sel, index, source)).toBeNull();
	});
});
