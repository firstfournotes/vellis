/**
 * 要件#32 の受け入れテスト(requirements.md 要件32・backlog #71)
 * 「Markdown 表示の選択コピーは『見えている文字列』をそのままコピーする」
 * (要件#13 の「原文スライス・装飾は記法ごとコピー」仕様の置き換え)
 *
 * 要求する実装 surface(implementer はこれに合わせる):
 *   src/lib/copy-selection.ts
 *   export function planSelectionCopy(sel: Selection): string | null;
 *     - string = Viewer の oncopy が e.preventDefault() +
 *       clipboardData.setData('text/plain', 値) に使う「表示テキスト」
 *     - null   = ブラウザ既定のコピーに任せる(collapsed 等)
 *   シグネチャに SourceIndex / source を渡さないこと自体が契約①の一部:
 *   原文(Markdown 記法込み)スライスへの解決とノード単位フォールバックは
 *   コピー経路から撤廃(基盤 resolveSelectionToMarkdown はマーク用に残る=契約④)。
 *
 * Viewer.svelte 側の配線(handleCopy が本プランナーを通す・またはハンドラ撤去で
 * 既定コピーに任せる=実装裁量。いずれでも本プランナーは契約の機械判定面として
 * export を維持する)は reviewer 照合(要件#13 のときと同じ分担)。
 *
 * 契約(要件32 の①②に対応):
 * ① コピーされる値は DOM 選択範囲の表示テキストのみ(Selection の可視文字列)。
 *    collapsed(キャレット・選択なし)は null =ブラウザ既定へ。
 * ② 全ケースで「選択した文字列だけ」:
 *    - 装飾(**太字** 等)を含む/跨ぐ選択 → 記法マーカーなし(要件#13 ②の置換)
 *    - ブロック全選択でもブロックマーカー(## 等)は付かない(同上)
 *    - エスケープ(\*)・文字実体参照(&amp;)→ 可視文字列のみ・ブロック丸ごとに
 *      ならない(backlog #22 解消)
 *    - コードブロック(Shiki スパン分割)内の部分選択 → 選択したコード文字列のみ
 *      (フェンス ``` を含まない)
 *    - アラート内の部分選択 → 可視文字列のみ(backlog #27 解消)
 *    - 複数ブロック跨ぎ → 選択部分のみ・ブロック丸ごと拡張なし(backlog #20 解消)
 *
 * 赤/緑の設計(test-runner 向け): 実装前は './copy-selection' が存在しないため
 * 全件赤(未実装が理由)。実装後に旧仕様(resolveSelectionToMarkdown の原文
 * スライス)相当の値を返す実装では、装飾・エスケープ・実体参照・コード・
 * アラート・複数ブロックの各ケースが赤のまま=旧仕様への回帰を検知する。
 *
 * スコープ外(申し送り): 可視テキストを持たない非 collapsed 選択(画像のみ等)の
 * 取り扱い・複数ブロック跨ぎのブロック間区切り文字(改行/なし)は契約に規定なし
 * =複数ブロックのケースは区切りを空白類まで許容して判定する。
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { render } from '../markdown/renderer';
import { planSelectionCopy } from './copy-selection';

const baseUri = 'file:///home/user/notes/doc.md';

async function mount(source: string): Promise<{ root: HTMLDivElement }> {
	const result = await render(source, baseUri);
	const root = document.createElement('div');
	root.innerHTML = result.html;
	document.body.append(root);
	return { root };
}

beforeEach(() => {
	document.body.innerHTML = '';
});

/**
 * 要素内の可視文字列オフセットを (テキストノード, ノード内オフセット) に写像する。
 * Shiki のスパン分割・装飾・実体参照などでテキストノードが分かれていても、
 * ユーザーのドラッグ選択(文字単位の端点)を再現できる。
 */
function findTextPoint(root: Element, visibleOffset: number): { node: Text; offset: number } {
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let acc = 0;
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const t = n as Text;
		if (visibleOffset <= acc + t.data.length) {
			return { node: t, offset: visibleOffset - acc };
		}
		acc += t.data.length;
	}
	throw new Error(`visible offset ${visibleOffset} is out of range`);
}

/** 要素の可視文字列から target を探し、その範囲をドラッグ選択として再現する。 */
function selectVisible(root: Element, target: string): Selection {
	const full = root.textContent ?? '';
	const at = full.indexOf(target);
	if (at < 0) throw new Error(`target ${JSON.stringify(target)} not found in visible text`);
	const start = findTextPoint(root, at);
	const end = findTextPoint(root, at + target.length);
	const sel = window.getSelection();
	if (!sel) throw new Error('no selection');
	sel.removeAllRanges();
	const range = document.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset);
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

describe('要件32-① プレーンテキストの部分選択は選択した可視文字列のみ', () => {
	test('段落中の部分選択 → その文字列のみ(段落全体に広がらない)', async () => {
		const { root } = await mount('The 3D CAD viewer is here.\n');
		const p = root.querySelector('p[data-vellis-node-id]')!;

		const sel = selectVisible(p, '3D CAD');
		expect(sel.toString()).toBe('3D CAD'); // 選択再現の前提確認

		expect(planSelectionCopy(sel)).toBe('3D CAD');
	});

	test('逆方向ドラッグ(anchor が focus より後)でも選択した可視文字列のみ', async () => {
		const { root } = await mount('The 3D CAD viewer is here.\n');
		const textNode = textChild(root.querySelector('p[data-vellis-node-id]')!);
		const start = textNode.data.indexOf('3D CAD');
		expect(start).toBeGreaterThanOrEqual(0);

		const sel = window.getSelection()!;
		sel.removeAllRanges();
		// 右→左ドラッグの再現: anchor=選択末尾・focus=選択先頭
		sel.setBaseAndExtent(textNode, start + '3D CAD'.length, textNode, start);
		expect(sel.toString()).toBe('3D CAD');

		expect(planSelectionCopy(sel)).toBe('3D CAD');
	});
});

describe('要件32-② 装飾を含む/跨ぐ選択は記法マーカーなしの可視文字列(要件#13 ②の置換)', () => {
	const src = 'before **bold** after.\n';

	test('装飾ノード全体の選択 → 可視文字列のみ(** は付かない)', async () => {
		const { root } = await mount(src);
		const strong = root.querySelector('strong[data-vellis-node-id]')!;

		const sel = window.getSelection()!;
		sel.removeAllRanges();
		const range = document.createRange();
		range.selectNodeContents(strong);
		sel.addRange(range);
		expect(sel.toString()).toBe('bold');

		// 要件#13 では '**bold**'。要件#32 で可視文字列 'bold' に置き換え。
		expect(planSelectionCopy(sel)).toBe('bold');
	});

	test('プレーン先頭〜装飾ノード全体を覆う選択 → 記法マーカーなし', async () => {
		const { root } = await mount(src);
		const p = root.querySelector('p[data-vellis-node-id]')!;

		const sel = selectVisible(p, 'before bold');
		expect(sel.toString()).toBe('before bold');

		// 要件#13 では 'before **bold**'。要件#32 で 'before bold' に置き換え。
		expect(planSelectionCopy(sel)).toBe('before bold');
	});

	test('装飾ノードをまたぎ両端がプレーンテキストの選択 → 記法マーカーなし', async () => {
		const { root } = await mount(src);
		const p = root.querySelector('p[data-vellis-node-id]')!;

		// 表示 'ore bold af'(要件#13 では 'ore **bold** af' だった)
		const sel = selectVisible(p, 'ore bold af');
		expect(sel.toString()).toBe('ore bold af');

		expect(planSelectionCopy(sel)).toBe('ore bold af');
	});

	test('ブロック全体の選択でもブロックマーカーは付かない(見出しの ## なし)', async () => {
		const { root } = await mount('## Section title\n');
		const h2 = root.querySelector('h2[data-vellis-node-id]')!;

		const sel = selectVisible(h2, 'Section title');
		expect(sel.toString()).toBe('Section title');

		// 要件#13 ではブロック全選択=ソース全体('## Section title')。置き換え。
		expect(planSelectionCopy(sel)).toBe('Section title');
	});
});

describe('要件32-② エスケープ・文字実体参照を含む選択は可視文字列のみ(backlog #22 解消)', () => {
	test('バックスラッシュエスケープ(\\*)の段落の部分選択 → 表示どおりの文字列のみ', async () => {
		const { root } = await mount('An \\*escaped\\* literal here.\n');
		const p = root.querySelector('p[data-vellis-node-id]')!;

		// 表示は 'An *escaped* literal here.'(バックスラッシュは表示されない)
		const sel = selectVisible(p, '*escaped*');
		expect(sel.toString()).toBe('*escaped*');

		// 旧実装はナローイング不能→ブロック丸ごとフォールバックだった。
		// 要件#32 では選択した可視文字列のみ(\ は含まれない)。
		expect(planSelectionCopy(sel)).toBe('*escaped*');
	});

	test('文字実体参照(&amp;)の段落の部分選択 → 解決後の表示文字列のみ', async () => {
		const { root } = await mount('Tom &amp; Jerry cartoon classic.\n');
		const p = root.querySelector('p[data-vellis-node-id]')!;

		// 表示は 'Tom & Jerry cartoon classic.'(実体参照は '&' に解決される)
		const sel = selectVisible(p, 'Tom & Jerry');
		expect(sel.toString()).toBe('Tom & Jerry');

		expect(planSelectionCopy(sel)).toBe('Tom & Jerry');
	});
});

describe('要件32-② コードブロック(Shiki)内の部分選択は選択したコード文字列のみ', () => {
	test('ハイライトスパンをまたぐ部分選択 → 選択部分のみ(フェンスもブロック全体も付かない)', async () => {
		const { root } = await mount('```typescript\nconst total = price * quantity;\n```\n');
		const pre = root.querySelector('pre')!;

		const sel = selectVisible(pre, 'price * quantity');
		expect(sel.toString()).toBe('price * quantity');

		const copied = planSelectionCopy(sel);
		expect(copied).toBe('price * quantity');
	});
});

describe('要件32-② アラート内の部分選択は可視文字列のみ(backlog #27 解消)', () => {
	test('アラート本文の装飾をまたぐ部分選択 → 選択部分のみ(タイトル・マーカーなし)', async () => {
		const { root } = await mount('> [!NOTE]\n> The alert body keeps **bold** text.\n');
		const body = root.querySelector(
			'blockquote.markdown-alert p:not(.markdown-alert-title)',
		)!;
		expect(body.textContent).toBe('The alert body keeps bold text.');

		const sel = selectVisible(body, 'body keeps bold');
		expect(sel.toString()).toBe('body keeps bold');

		expect(planSelectionCopy(sel)).toBe('body keeps bold');
	});
});

describe('要件32-② 複数ブロック跨ぎの選択は選択部分のみ(backlog #20 解消)', () => {
	test('段落1の途中〜段落2の途中の選択 → 両ブロックの選択部分のみ・ブロック丸ごと拡張なし', async () => {
		const { root } = await mount('Alpha beta gamma.\n\nDelta epsilon zeta.\n');
		const paragraphs = root.querySelectorAll('p[data-vellis-node-id]');
		expect(paragraphs.length).toBe(2);

		const firstText = textChild(paragraphs[0]); // 'Alpha beta gamma.'
		const secondText = textChild(paragraphs[1]); // 'Delta epsilon zeta.'

		const sel = window.getSelection()!;
		sel.removeAllRanges();
		const range = document.createRange();
		range.setStart(firstText, 'Alpha '.length);
		range.setEnd(secondText, 'Delta epsilon'.length);
		sel.addRange(range);

		const copied = planSelectionCopy(sel);
		expect(copied).not.toBeNull();
		// 選択部分のみ。ブロック間の区切りは空白類(改行/なし)まで許容(申し送り参照)。
		expect(copied).toMatch(/^beta gamma\.\s*Delta epsilon$/);
		// ブロック丸ごとへ拡張しない(旧実装は両段落のソース全体になっていた)
		expect(copied).not.toContain('Alpha');
		expect(copied).not.toContain('zeta');
	});
});

describe('要件32-① collapsed 選択はブラウザ既定へ(null)', () => {
	test('選択なし(range なし)→ null', async () => {
		await mount('The 3D CAD viewer is here.\n');
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		expect(sel.isCollapsed).toBe(true);

		expect(planSelectionCopy(sel)).toBeNull();
	});

	test('キャレット(collapsed な range)→ null', async () => {
		const { root } = await mount('The 3D CAD viewer is here.\n');
		const textNode = textChild(root.querySelector('p[data-vellis-node-id]')!);

		const sel = window.getSelection()!;
		sel.removeAllRanges();
		const range = document.createRange();
		range.setStart(textNode, 3);
		range.collapse(true);
		sel.addRange(range);
		expect(sel.isCollapsed).toBe(true);

		expect(planSelectionCopy(sel)).toBeNull();
	});
});
