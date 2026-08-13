/**
 * 要件#15 の受け入れテスト(requirements.md 要件15・GitHub Issue 24)
 * 「GitHub スタイルのアラート記法(`> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` /
 * `[!WARNING]` / `[!CAUTION]`)をアラートとして描画する」
 *
 * 対象: `render()`(src/markdown/renderer.ts)の全パイプライン出力。
 * rehype-sanitize(vellisSchema) を通った最終 HTML/DOM で判定する
 * (=④のスキーマ許可の検証を兼ねる)。
 *
 * 契約(要件15 の①〜⑥に対応):
 *
 * ① blockquote 先頭行の [!TYPE] マーカー(5種)を検出し、マーカー行を本文から
 *    除去・タイプ名のタイトル(class=markdown-alert-title・ラベルは
 *    Note/Tip/Important/Warning/Caution の正規形)を blockquote の先頭に付与・
 *    blockquote に GitHub 互換クラス markdown-alert markdown-alert-〈type〉 を
 *    付与する。本文(複数行・複数段落・インライン装飾)は保持される。
 *
 * ② コンテナは blockquote 要素のまま。data-vellis-node-id /
 *    data-vellis-node-type が維持され、その nodeId が render() の返す
 *    SourceIndex(byId)から引ける(=マーク機能との整合)。
 *
 * ③ 5種以外のマーカー([!FOO] 等)・マーカー同一行に本文が続く形・
 *    先頭行以外のマーカー・マーカーなしの通常引用は従来どおり不変
 *    (アラート化されず、生テキストが保持される)。
 *
 * ④ サニタイズスキーマはアラート用クラスの許可のみ追加。アラートクラスは
 *    サニタイズ後も生き残り、逆に blockquote / p 上の無関係なクラス
 *    (raw HTML 由来)は従来どおり通らない。
 *    ※参照実装(旧 d49d765)は blockquote/p に className を無制限許可して
 *      いたが、契約④の「アラート用クラスの許可のみ」に合わせて本テストは
 *      値制限(markdown-alert* のみ通る)を固定する=参照実装からの意図的な
 *      逸脱(test-writer 申し送り 2026-08-12)。
 *
 * ⑤ タイプ別配色(markdown.css)は見た目=人間ゲート(acceptance/acceptance.md)。
 *    本テストでは扱わない。
 *
 * ⑥ マーカーの細部は参照実装の挙動(GitHub 準拠)を固定:
 *    - 大文字小文字は不問([!note] も変換・タイトルは正規形 Note)
 *    - マーカーは blockquote 先頭段落の先頭行を単独で占める場合のみ有効
 *      (同一行に本文が続く場合・2行目以降は変換しない)
 *
 * 赤/緑の設計(test-runner 向け): ①・②の変換系は現行実装(アラート
 * プラグイン未搭載)では「blockquote.markdown-alert が存在しない」を理由に
 * 赤になるのが正しい。③・④は現行でも緑(不変・悪化防止のガード)。
 *
 * スコープ外(このテストは扱わない): renderer.ts への組み込み位置・
 * 依存追加なしの確認(⑥前段)は reviewer 照合。入れ子 blockquote 内の
 * マーカー・マーカー行末の連続空白(ハードブレーク)等のエッジは契約に
 * 規定なし=申し送り。
 */
import { describe, expect, test } from 'vitest';
import { render } from './renderer';

const baseUri = 'file:///home/user/notes/doc.md';

async function mount(source: string): Promise<{
	html: string;
	index: Awaited<ReturnType<typeof render>>['index'];
	root: HTMLDivElement;
}> {
	const result = await render(source, baseUri);
	const root = document.createElement('div');
	root.innerHTML = result.html;
	return { html: result.html, index: result.index, root };
}

/** セレクタで要素を取得。無ければ理由付きで落とす(未実装時の赤の入口)。 */
function q(scope: ParentNode, selector: string): Element {
	const el = scope.querySelector(selector);
	if (!el) throw new Error(`要素が見つからない: ${selector}`);
	return el;
}

/** [マーカー表記, クラス接尾辞, タイトルラベル] */
const TYPES = [
	['NOTE', 'note', 'Note'],
	['TIP', 'tip', 'Tip'],
	['IMPORTANT', 'important', 'Important'],
	['WARNING', 'warning', 'Warning'],
	['CAUTION', 'caution', 'Caution'],
] as const;

describe('要件15① 5種のマーカーをアラートとして描画する', () => {
	for (const [marker, type, label] of TYPES) {
		test(`[!${marker}] → blockquote.markdown-alert.markdown-alert-${type}・タイトル ${label}・マーカー除去`, async () => {
			const { root } = await mount(`> [!${marker}]\n> body text\n`);

			// GitHub 互換クラスが blockquote に付く
			const bq = q(root, `blockquote.markdown-alert.markdown-alert-${type}`);

			// タイトルが先頭要素として付く(ラベルはタイプ名の正規形)
			const title = bq.firstElementChild;
			if (!title) throw new Error('blockquote に子要素がない');
			expect(title.classList.contains('markdown-alert-title')).toBe(true);
			expect(title.textContent).toBe(label);

			// マーカーの生テキストが本文に残らない
			expect(root.textContent).not.toContain(`[!${marker}]`);

			// 本文は保持される
			expect(bq.textContent).toContain('body text');
		});
	}

	test('小文字マーカー [!note] も変換される(タイトルは正規形 Note)', async () => {
		const { root } = await mount('> [!note]\n> lower body\n');
		const bq = q(root, 'blockquote.markdown-alert.markdown-alert-note');
		expect(q(bq, '.markdown-alert-title').textContent).toBe('Note');
		expect(root.textContent).not.toContain('[!note]');
		expect(bq.textContent).toContain('lower body');
	});
});

describe('要件15① マーカー行の除去と本文保持', () => {
	test('複数行の本文(同一段落)が保持される', async () => {
		const { root } = await mount('> [!WARNING]\n> line one\n> line two\n');
		const bq = q(root, 'blockquote.markdown-alert.markdown-alert-warning');
		expect(root.textContent).not.toContain('[!WARNING]');
		expect(bq.textContent).toContain('line one');
		expect(bq.textContent).toContain('line two');
	});

	test('マーカー単独行+複数段落の本文が保持される', async () => {
		const { root } = await mount(
			'> [!TIP]\n>\n> first paragraph\n>\n> second paragraph\n',
		);
		const bq = q(root, 'blockquote.markdown-alert.markdown-alert-tip');
		expect(q(bq, '.markdown-alert-title').textContent).toBe('Tip');
		expect(root.textContent).not.toContain('[!TIP]');

		// 本文の2段落がタイトルとは別に残る
		const bodyParas = bq.querySelectorAll('p:not(.markdown-alert-title)');
		expect(bodyParas.length).toBe(2);
		expect(bodyParas[0].textContent).toBe('first paragraph');
		expect(bodyParas[1].textContent).toBe('second paragraph');
	});

	test('本文のインライン装飾(強調)が保持される', async () => {
		const { root } = await mount('> [!NOTE]\n> keep **bold** text\n');
		const bq = q(root, 'blockquote.markdown-alert.markdown-alert-note');
		expect(q(bq, 'strong').textContent).toBe('bold');
		expect(bq.textContent).toContain('keep bold text');
	});

	test('本文なしのマーカー単独 blockquote はタイトルのみのアラートになる', async () => {
		const { root } = await mount('> [!NOTE]\n');
		const bq = q(root, 'blockquote.markdown-alert.markdown-alert-note');
		expect(q(bq, '.markdown-alert-title').textContent).toBe('Note');
		expect(root.textContent).not.toContain('[!NOTE]');
	});
});

describe('要件15② コンテナは blockquote のまま・ソースマップ整合', () => {
	test('アラート blockquote が data-vellis 属性を維持し SourceIndex から引ける', async () => {
		const { root, index } = await mount('> [!NOTE]\n> body\n');
		const bq = q(root, 'blockquote.markdown-alert');

		expect(bq.tagName).toBe('BLOCKQUOTE');
		expect(bq.getAttribute('data-vellis-node-type')).toBe('blockquote');

		const id = bq.getAttribute('data-vellis-node-id');
		if (!id) throw new Error('data-vellis-node-id がアラート blockquote にない');
		expect(id).toMatch(/^n_\d{4}$/);

		// マーク機能は nodeId → SourceIndex でソース範囲を引く(整合の要)
		const meta = index.byId.get(id);
		expect(meta?.type).toBe('blockquote');
	});
});

describe('要件15③ 非アラートは従来どおり不変', () => {
	test('通常の引用はアラート化されない(クラスなし・本文不変)', async () => {
		const { root } = await mount('> just a quote\n');
		const bq = q(root, 'blockquote');
		expect(root.querySelector('.markdown-alert')).toBeNull();
		expect(root.querySelector('.markdown-alert-title')).toBeNull();
		expect(bq.textContent).toContain('just a quote');
		// ソースマップ属性の従来動作も維持(回帰ガード)
		expect(bq.getAttribute('data-vellis-node-type')).toBe('blockquote');
	});

	test('未知マーカー [!FOO] は変換されず生テキストのまま', async () => {
		const { root } = await mount('> [!FOO]\n> body\n');
		expect(root.querySelector('.markdown-alert')).toBeNull();
		expect(root.textContent).toContain('[!FOO]');
		expect(root.textContent).toContain('body');
	});

	test('マーカーと同一行に本文が続く場合は変換しない(GitHub 準拠)', async () => {
		const { root } = await mount('> [!NOTE] same line text\n');
		expect(root.querySelector('.markdown-alert')).toBeNull();
		expect(root.textContent).toContain('[!NOTE] same line text');
	});

	test('先頭行以外のマーカーは変換しない', async () => {
		const { root } = await mount('> intro line\n> [!NOTE]\n');
		expect(root.querySelector('.markdown-alert')).toBeNull();
		expect(root.textContent).toContain('[!NOTE]');
		expect(root.textContent).toContain('intro line');
	});
});

describe('要件15④ サニタイズスキーマはアラート用クラスの許可のみ追加', () => {
	// アラートクラスが生き残ること(許可の正側)は①・②が render() 全
	// パイプライン(rehype-sanitize 含む)経由で検証済み。ここでは
	// 「のみ」の側=無関係なクラスが従来どおり通らないことを固定する。

	test('raw HTML blockquote の無関係なクラスは通らない', async () => {
		const { html, root } = await mount(
			'<blockquote class="vellis-evil-class">raw quote</blockquote>\n',
		);
		expect(html).not.toContain('vellis-evil-class');
		expect(q(root, 'blockquote').textContent).toContain('raw quote');
	});

	test('raw HTML p の無関係なクラスは通らない', async () => {
		const { html, root } = await mount(
			'<p class="vellis-evil-class">raw para</p>\n',
		);
		expect(html).not.toContain('vellis-evil-class');
		expect(root.textContent).toContain('raw para');
	});
});
