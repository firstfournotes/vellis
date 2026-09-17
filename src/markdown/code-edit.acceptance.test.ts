/**
 * 要件#52 の受け入れテスト(docs/requirements/req-52.md)— code fence の中身の
 * その場編集・純関数側(unit プロジェクト)
 *
 * 要件#49 が契約③で編集不可にしていた code fence のうち、**トップレベルの fence
 * だけ**を「素テキストで中身を編集し、確定時にフェンス行を残して中身だけ差し替える」
 * 編集へ置き換える。判断は `src/markdown/edit.ts` の純関数に集める(#49 と同じ分担)。
 * Viewer の配線側は src/components/Viewer.codeedit.wiring.test.ts。
 *
 * 追補a(6)(7)=2026-09-14 Codex review 反映: AC-52-11(インデント付きトップレベル fence)
 * と AC-52-12(閉じフェンス衝突)の describe を末尾に追加(既存ケースは無改変)。
 *
 * ## `src/markdown/edit.ts` に求める追加 export(本テストが契約を決める)
 *
 * ```ts
 * // EditTarget に種別を1つ足す(既存の block / source は現状のまま=契約⑦)。
 * // `el` は data-vellis-node-id を持つ Shiki 出力の <pre>(契約④で属性が付く)、
 * // `meta` はその id の NodeMeta(type === 'code')。
 * export type EditTarget =
 *   | { kind: 'block'; el: HTMLElement; meta: NodeMeta }
 *   | { kind: 'code'; el: HTMLElement; meta: NodeMeta }
 *   | { kind: 'source' };
 *
 * /** 原文スライスをフェンス3分割したもの。 *\/
 * export interface CodeFenceParts {
 *   /** 開始フェンス行(改行を含まない)。例: '```json' / '~~~yaml' *\/
 *   open: string;
 *   /** 中身 = スライスを行分割し最初と最後の行を除いた行を '\n' で連結したもの
 *    *(= 編集に出す素テキスト)。空フェンスは ''。 *\/
 *   body: string;
 *   /** 終了フェンス行(改行を含まない)。例: '```' *\/
 *   close: string;
 * }
 *
 * /** `index.sliceOf(meta.id)` のスライスをフェンス3分割する。フェンスで始まらない
 *  *(= インデント式コードブロックなど)なら null。 *\/
 * export function splitCodeFence(slice: string): CodeFenceParts | null;
 *
 * /** 確定用の差し替え文字列を組み立てる: 開始フェンス行 + 中身 + 終了フェンス行。
 *  * 中身の末尾は**改行1つ**に揃える(0個なら足し、2個以上なら1つへ)。中身が
 *  * 空(改行だけを含む場合も)なら改行なしで `open + '\n' + close`。 *\/
 * export function assembleCodeFence(open: string, body: string, close: string): string;
 * ```
 *
 * `resolveEditTarget` の**署名は不変**(引数・既存の返り値はそのまま)。code を返す
 * 条件(契約①③): `NodeMeta.type === 'code'` かつ `parentBlockId === null` かつ
 * 原文スライスがフェンス(``` / ~~~)で始まり、`extra.lang !== 'mermaid'`。
 *
 * ## 判定するもの(契約番号は req-52.md の①〜⑦)
 * - AC-52-1(契約①③): 対象の判定 — トップレベルの ``` / ~~~(言語あり/なし)は
 *   code。リスト内・引用内・インデント式・mermaid は source(従来どおり誘導)
 * - AC-52-2 のうち素テキストの定義(契約①): `splitCodeFence` が原文スライスから
 *   開始行・中身・終了行を正しく切り出す(素テキスト=原文スライスの中身。DOM の
 *   textContent ではない)
 * - AC-52-3(契約②⑥): `assembleCodeFence` + `replaceRange` で中身だけが差し替わり、
 *   フェンス行とブロックの外側は byte 等価で残る
 * - AC-52-4(契約②): 末尾改行の規約 — 0個/2個で確定しても中身の末尾は改行1つ。
 *   空にすると ```json\n```(改行なし)
 * - AC-52-7(契約④): `render()` の HTML で code fence の `<pre>` が
 *   data-vellis-node-id / data-source-start / data-source-end /
 *   data-vellis-node-type="code" を持ち、id が `index.byId` の code メタと一致する
 *   (2026-09-14 起案時の実測では**どれも付いていない**= backlog 171。本要件で付ける)
 * - AC-52-10(契約⑦): `edit.ts` 既存 export の署名不変(コンパイル時判定=pnpm check)・
 *   package.json の依存に変更なし。selection.ts / source-index.ts の無改変は
 *   edit.acceptance.test.ts(#49)の SHA-256 固定が引き続き判定する
 *
 * ## 判定しないもの
 * - ダブルクリック→contenteditable→確定/破棄/Enter/Tab/貼り付け/⌘S の配線
 *   → Viewer.codeedit.wiring.test.ts
 * - 編集中の見た目・IME・確定後に色が消える見え方 → 人間ゲート
 *   (acceptance/acceptance.md 要件#52 ①〜④)
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from './renderer';
import {
	assembleCodeFence,
	replaceRange,
	resolveEditTarget,
	serializeBlock,
	splitCodeFence,
	type EditTarget,
} from './edit';
import type { NodeMeta, SourceIndex, SourcePosition } from './types';

const baseUri = 'file:///home/user/notes/doc.md';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

/** 対象(トップレベル fence 3種)と対象外(リスト内・引用内・インデント式・mermaid)。 */
const DOC = [
	'Intro paragraph.',
	'',
	'```json',
	'{',
	'  "a": 1',
	'}',
	'```',
	'',
	'```',
	'no lang line',
	'```',
	'',
	'~~~yaml',
	'key: value',
	'~~~',
	'',
	'- list item',
	'',
	'  ```javascript',
	'  const y = 2;',
	'  ```',
	'',
	'> quoted',
	'>',
	'> ```python',
	'> x = 1',
	'> ```',
	'',
	'    indented code',
	'',
	'```mermaid',
	'graph TD;',
	'  A-->B;',
	'```',
	'',
].join('\n');

const JSON_BODY = '{\n  "a": 1\n}';
const JSON_FENCE = '```json\n' + JSON_BODY + '\n```';

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

/** `text` を含む code メタを index から引く。 */
function codeMetaContaining(index: SourceIndex, text: string): NodeMeta {
	for (const meta of index.byId.values()) {
		if (meta.type !== 'code') continue;
		if (index.sliceOf(meta.id).includes(text)) return meta;
	}
	throw new Error(`code メタが見つからない: ${text}`);
}

/**
 * `text` を含む `<pre>` を DOM から引く。id ではなく中身で引くのは、契約④の実装前は
 * Shiki 出力の `<pre>` に data-vellis-node-id が無いため(その欠落自体が AC-52-7)。
 */
function preContaining(root: ParentNode, text: string): HTMLElement {
	const pre = [...root.querySelectorAll('pre')].find((el) =>
		(el.textContent ?? '').includes(text),
	);
	if (!pre) throw new Error(`pre が見つからない: ${text}`);
	return pre as HTMLElement;
}

/** EditTarget が code 種別であることを判定して返す。 */
function expectCode(target: EditTarget): { el: HTMLElement; meta: NodeMeta } {
	expect(target.kind, 'トップレベル code fence は code 種別になる(契約①)').toBe('code');
	if (target.kind !== 'code') throw new Error('code 種別ではない');
	return target;
}

function expectFenceParts(slice: string): { open: string; body: string; close: string } {
	const parts = splitCodeFence(slice);
	expect(parts, `フェンス3分割できる: ${JSON.stringify(slice)}`).not.toBeNull();
	if (!parts) throw new Error('splitCodeFence が null');
	return parts;
}

// ---------------------------------------------------------------------------
// AC-52-1 — 対象の判定(契約①③)
// ---------------------------------------------------------------------------

describe('AC-52-1 resolveEditTarget — トップレベル fence は code・対象外は source(契約①③)', () => {
	test('トップレベルの ```(言語あり)の <pre> は code。meta と el が index に対応する', async () => {
		const m = await mount(DOC);
		const pre = preContaining(m.root, '"a": 1');
		const meta = codeMetaContaining(m.index, '"a": 1');

		const target = expectCode(resolveEditTarget(pre, m.index));

		expect(target.meta.id).toBe(meta.id);
		expect(target.meta.type).toBe('code');
		// el は data-vellis-node-id を持つ <pre> 自身(契約④の属性が前提)。
		expect(target.el.tagName.toLowerCase()).toBe('pre');
		expect(target.el.getAttribute('data-vellis-node-id')).toBe(meta.id);
	});

	test('Shiki の <span>(fence の中の子要素)から始めても同じ code に繰り上がる', async () => {
		const m = await mount(DOC);
		const pre = preContaining(m.root, '"a": 1');
		const inner = pre.querySelector('span') ?? pre.querySelector('code') ?? pre;
		const meta = codeMetaContaining(m.index, '"a": 1');

		const target = expectCode(resolveEditTarget(inner, m.index));

		expect(target.meta.id).toBe(meta.id);
	});

	test('トップレベルの ```(言語なし)も code(extra.lang は無い)', async () => {
		const m = await mount(DOC);
		const pre = preContaining(m.root, 'no lang line');

		const target = expectCode(resolveEditTarget(pre, m.index));

		expect(target.meta.extra?.lang).toBeUndefined();
	});

	test('トップレベルの ~~~ fence も code', async () => {
		const m = await mount(DOC);
		const pre = preContaining(m.root, 'key: value');
		const meta = codeMetaContaining(m.index, 'key: value');

		const target = expectCode(resolveEditTarget(pre, m.index));

		expect(target.meta.id).toBe(meta.id);
	});

	test('リスト項目の中の fence は source(従来どおり誘導=契約③)', async () => {
		const m = await mount(DOC);
		const pre = preContaining(m.root, 'const y = 2;');

		expect(resolveEditTarget(pre, m.index).kind).toBe('source');
	});

	test('引用の中の fence は source(契約③)', async () => {
		const m = await mount(DOC);
		const pre = preContaining(m.root, 'x = 1');

		expect(resolveEditTarget(pre, m.index).kind).toBe('source');
	});

	test('インデント式コードブロックは source(スライスがフェンスで始まらない=契約③)', async () => {
		const m = await mount(DOC);
		const pre = preContaining(m.root, 'indented code');

		expect(resolveEditTarget(pre, m.index).kind).toBe('source');
	});

	test('mermaid は source(契約③)', async () => {
		const m = await mount(DOC);
		const div = m.root.querySelector('.vellis-mermaid');
		expect(div).not.toBeNull();

		expect(resolveEditTarget(div as Element, m.index).kind).toBe('source');
	});
});

// ---------------------------------------------------------------------------
// AC-52-2(素テキストの定義)— splitCodeFence(契約①)
// ---------------------------------------------------------------------------

describe('AC-52-2 splitCodeFence — 素テキスト=原文スライスの中身(契約①)', () => {
	test('``` fence(言語あり)を開始行・中身・終了行に分ける', () => {
		expect(splitCodeFence(JSON_FENCE)).toEqual({
			open: '```json',
			body: JSON_BODY,
			close: '```',
		});
	});

	test('~~~ fence も分けられる', () => {
		expect(splitCodeFence('~~~yaml\nkey: value\n~~~')).toEqual({
			open: '~~~yaml',
			body: 'key: value',
			close: '~~~',
		});
	});

	test('言語なし・中身が複数行(空行を含む)', () => {
		expect(splitCodeFence('```\nabc\n\ndef\n```')).toEqual({
			open: '```',
			body: 'abc\n\ndef',
			close: '```',
		});
	});

	test('空フェンスは body が空文字列', () => {
		expect(splitCodeFence('```json\n```')).toEqual({ open: '```json', body: '', close: '```' });
	});

	test('4連バッククォートの fence(中身に ``` を含む)も外側で分ける', () => {
		expect(splitCodeFence('````md\n```\ninner\n```\n````')).toEqual({
			open: '````md',
			body: '```\ninner\n```',
			close: '````',
		});
	});

	test('フェンスで始まらないスライスは null(インデント式・段落)', () => {
		expect(splitCodeFence('    indented code')).toBeNull();
		expect(splitCodeFence('plain paragraph')).toBeNull();
	});

	test('index.sliceOf の実スライスと突き合わせても同じ3分割になる', async () => {
		const m = await mount(DOC);
		const meta = codeMetaContaining(m.index, '"a": 1');
		const slice = m.index.sliceOf(meta.id);

		expect(slice).toBe(JSON_FENCE);
		expect(splitCodeFence(slice)).toEqual({ open: '```json', body: JSON_BODY, close: '```' });
	});
});

// ---------------------------------------------------------------------------
// AC-52-4 — 末尾改行の規約(契約②)
// ---------------------------------------------------------------------------

describe('AC-52-4 assembleCodeFence — 中身の末尾は改行1つ(契約②)', () => {
	test('末尾改行なしの中身には改行を足す', () => {
		expect(assembleCodeFence('```json', 'x', '```')).toBe('```json\nx\n```');
	});

	test('末尾改行1つはそのまま', () => {
		expect(assembleCodeFence('```json', 'x\n', '```')).toBe('```json\nx\n```');
	});

	test('末尾改行2つ以上は1つに揃える', () => {
		expect(assembleCodeFence('```json', 'x\n\n', '```')).toBe('```json\nx\n```');
		expect(assembleCodeFence('```json', 'x\n\n\n', '```')).toBe('```json\nx\n```');
	});

	test('空の中身は改行なし(```json\\n```)', () => {
		expect(assembleCodeFence('```json', '', '```')).toBe('```json\n```');
	});

	test('改行だけの中身も空と同じ', () => {
		expect(assembleCodeFence('```json', '\n\n', '```')).toBe('```json\n```');
	});

	test('複数行の中身と ~~~ フェンス', () => {
		expect(assembleCodeFence('~~~yaml', 'a: 1\nb: 2', '~~~')).toBe('~~~yaml\na: 1\nb: 2\n~~~');
	});
});

// ---------------------------------------------------------------------------
// AC-52-3 — 中身だけの差し替え(契約②⑥)
// ---------------------------------------------------------------------------

describe('AC-52-3 split → assemble → replaceRange — フェンス行と外側は byte 等価(契約②⑥)', () => {
	test('中身を書き換えても開始/終了フェンス行とブロックの外側は 1 byte も動かない', async () => {
		const m = await mount(DOC);
		const meta = codeMetaContaining(m.index, '"a": 1');
		const parts = expectFenceParts(m.index.sliceOf(meta.id));
		const newBody = '{\n  "a": 2,\n  "b": [1, 2]\n}';

		const replacement = assembleCodeFence(parts.open, newBody, parts.close);
		const out = replaceRange(DOC, meta.position, replacement);

		expect(out).toBe(DOC.replace(JSON_BODY, newBody));
		// フェンス行が残っていることを明示的にも判定する。
		expect(out).toContain('```json\n' + newBody + '\n```');
	});

	test('空にすると ```json\\n``` になり、外側は byte 等価', async () => {
		const m = await mount(DOC);
		const meta = codeMetaContaining(m.index, '"a": 1');
		const parts = expectFenceParts(m.index.sliceOf(meta.id));

		const out = replaceRange(DOC, meta.position, assembleCodeFence(parts.open, '', parts.close));

		expect(out).toBe(DOC.replace(JSON_FENCE, '```json\n```'));
	});
});

// ---------------------------------------------------------------------------
// AC-52-7 — Shiki 出力の <pre> に source-map 属性(契約④)
// ---------------------------------------------------------------------------

describe('AC-52-7 render — code fence の <pre> が source-map 属性を持つ(契約④)', () => {
	test('言語ありの fence: id / start / end / type が index の code メタと一致する', async () => {
		const m = await mount(DOC);
		const meta = codeMetaContaining(m.index, '"a": 1');
		const pre = preContaining(m.root, '"a": 1');

		expect(pre.getAttribute('data-vellis-node-id')).toBe(meta.id);
		expect(pre.getAttribute('data-source-start')).toBe(String(meta.position.startOffset));
		expect(pre.getAttribute('data-source-end')).toBe(String(meta.position.endOffset));
		expect(pre.getAttribute('data-vellis-node-type')).toBe('code');
	});

	test('言語なしの fence と ~~~ fence の <pre> にも付く', async () => {
		const m = await mount(DOC);
		for (const text of ['no lang line', 'key: value']) {
			const meta = codeMetaContaining(m.index, text);
			const pre = preContaining(m.root, text);
			expect(pre.getAttribute('data-vellis-node-id'), text).toBe(meta.id);
			expect(pre.getAttribute('data-vellis-node-type'), text).toBe('code');
		}
	});

	test('mermaid のプレースホルダ div は従来どおり id を持つ(退行しない)', async () => {
		const m = await mount(DOC);
		const div = m.root.querySelector('.vellis-mermaid');
		const meta = codeMetaContaining(m.index, 'graph TD;');

		expect(div?.getAttribute('data-vellis-node-id')).toBe(meta.id);
	});
});

// ---------------------------------------------------------------------------
// AC-52-10 — 不変(契約⑦)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../..');

const DUMMY_POSITION: SourcePosition = {
	startLine: 1,
	startColumn: 1,
	startOffset: 0,
	endLine: 1,
	endColumn: 2,
	endOffset: 1,
};

const DUMMY_META: NodeMeta = {
	id: 'n_0000',
	type: 'paragraph',
	position: DUMMY_POSITION,
	parentBlockId: null,
	headingPath: [],
};

/** 要件#52 着手時点(package.json @ main 5bf62ba)の runtime 依存。 */
const RUNTIME_DEPS_AT_REQ52 = [
	'@shikijs/rehype',
	'@tauri-apps/api',
	'@tauri-apps/plugin-dialog',
	'@tauri-apps/plugin-opener',
	'hast-util-to-mdast',
	'mdast-util-to-markdown',
	'mdast-util-to-string',
	'mermaid',
	'rehype-raw',
	'rehype-sanitize',
	'rehype-stringify',
	'remark-gfm',
	'remark-parse',
	'remark-rehype',
	'three',
	'unified',
	'unist-util-visit',
	// 追補b(2026-09-15・要件#53 契約⑧による改訂)= 要件#53 が rehype-parse 1件を追加。
	'rehype-parse',
];

/** 要件#52 着手時点の dev 依存。 */
const DEV_DEPS_AT_REQ52 = [
	'@sveltejs/adapter-static',
	'@sveltejs/kit',
	'@sveltejs/vite-plugin-svelte',
	'@tauri-apps/cli',
	'@testing-library/svelte',
	'@testing-library/user-event',
	'@types/hast',
	'@types/mdast',
	'@types/node',
	'@types/three',
	'@wdio/cli',
	'@wdio/globals',
	'@wdio/local-runner',
	'@wdio/mocha-framework',
	'@wdio/spec-reporter',
	'expect-webdriverio',
	'happy-dom',
	'jsdom',
	'shiki',
	'svelte',
	'svelte-check',
	'tsx',
	'typescript',
	'vite',
	'vitest',
	'webdriverio',
];

describe('AC-52-10 不変(契約⑦)', () => {
	// selection.ts / source-index.ts の無改変は edit.acceptance.test.ts(#49)の
	// SHA-256 固定が引き続き判定する(フルスイート緑=AC-52-10 の一部)。

	test('edit.ts 既存 export の署名が不変(型はコンパイル時=pnpm check で判定)', () => {
		// 代入できること自体が判定(署名が変わればここが型エラーになる)。
		const resolveSig: (target: Element, index: SourceIndex | null) => EditTarget =
			resolveEditTarget;
		const serializeSig: (
			el: Element,
			meta: NodeMeta,
			source: string,
			baseUri?: string,
			originSlice?: string,
		) => string = serializeBlock;
		const replaceSig: (
			source: string,
			position: SourcePosition,
			replacement: string,
		) => string = replaceRange;
		// EditTarget の既存2種別が残っていること(種別の追加は可=契約⑦)。
		const blockTarget: EditTarget = {
			kind: 'block',
			el: document.createElement('p'),
			meta: DUMMY_META,
		};
		const sourceTarget: EditTarget = { kind: 'source' };

		expect(resolveSig).toBe(resolveEditTarget);
		expect(serializeSig).toBe(serializeBlock);
		expect(replaceSig).toBe(replaceRange);
		expect(blockTarget.kind).toBe('block');
		expect(sourceTarget.kind).toBe('source');
	});

	test('package.json の依存に変更なし(runtime / dev とも)', () => {
		const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		expect(Object.keys(pkg.dependencies).sort()).toEqual([...RUNTIME_DEPS_AT_REQ52].sort());
		expect(Object.keys(pkg.devDependencies).sort()).toEqual([...DEV_DEPS_AT_REQ52].sort());
	});
});

// ---------------------------------------------------------------------------
// AC-52-11 — インデント付きトップレベル fence(追補a(6)=2026-09-14 Codex review 反映)
// ---------------------------------------------------------------------------

/**
 * 追補a(6): 開始フェンス行の行頭が 1〜3 スペースの fence も対象(code 種別)。
 * 素テキストは CommonMark と同じ規則で中身の各行の先頭から最大 n スペース
 * (n = 開始フェンスのインデント幅 = `meta.position.startColumn - 1`)を除いたもの。
 * 確定時は空行を除く各行の先頭に n スペースを付け直す。開始・終了フェンス行は
 * 原文のまま。4 スペース以上はインデント式コードブロックで fence ではない=source。
 *
 * API は後方互換の省略可能引数で拡張する(本テストが契約を決める):
 * `splitCodeFence(slice, indent = 0)` が body をインデント除去済みで返し、
 * `assembleCodeFence(open, body, close, indent = 0)` が再インデントを行う。
 */

/** インデント 1〜3 スペースの fence(対象)と 4 スペース(インデント式=対象外)。 */
const INDENT_DOC = [
	'Intro paragraph.',
	'',
	' ```javascript',
	' a = 1',
	' ```',
	'',
	'  ```json',
	'  {',
	'    "a": 1',
	'  }',
	'  ```',
	'',
	'   ```python',
	'   b = 2',
	'   ```',
	'',
	'    indented code line',
	'',
	'  ```',
	'  two',
	' one',
	'zero',
	'  ```',
	'',
	'  ```yaml',
	'  k: v',
	'```',
	'',
	'Tail paragraph.',
	'',
].join('\n');

/** json fence の原文スライス(位置はフェンス記号から。中身の行はインデント込み)。 */
const INDENT_JSON_SLICE = '```json\n  {\n    "a": 1\n  }\n  ```';
/** その素テキスト(各行の先頭から最大2スペースを除いたもの)。 */
const INDENT_JSON_BODY = '{\n  "a": 1\n}';
/** 原文の中で fence の中身が占める行(再インデント済みの姿)。 */
const INDENT_JSON_BODY_RAW = '  {\n    "a": 1\n  }';

describe('AC-52-11 インデント付きトップレベル fence(追補a(6))', () => {
	test('1〜3スペースの fence は code、4スペース(インデント式)は source(契約①③)', async () => {
		const m = await mount(INDENT_DOC);
		for (const text of ['a = 1', '"a": 1', 'b = 2']) {
			const target = resolveEditTarget(preContaining(m.root, text), m.index);
			expect(target.kind, `${text}(1〜3スペース)は code`).toBe('code');
		}
		expect(
			resolveEditTarget(preContaining(m.root, 'indented code line'), m.index).kind,
			'4スペースはインデント式コードブロック=source',
		).toBe('source');
	});

	test('インデント幅は startColumn - 1 で得られ、スライスはフェンス記号から始まる', async () => {
		const m = await mount(INDENT_DOC);
		const meta = codeMetaContaining(m.index, '"a": 1');

		expect(meta.position.startColumn - 1).toBe(2);
		expect(m.index.sliceOf(meta.id)).toBe(INDENT_JSON_SLICE);
	});

	test('splitCodeFence(slice, 2): 素テキストは各行の先頭から最大2スペースを除いたもの', () => {
		expect(splitCodeFence(INDENT_JSON_SLICE, 2)).toEqual({
			open: '```json',
			body: INDENT_JSON_BODY,
			close: '  ```',
		});
	});

	test('n 未満のインデントの行は除ける分だけ除く(CommonMark と同じ規則)', () => {
		expect(splitCodeFence('```\n  two\n one\nzero\n  ```', 2)).toEqual({
			open: '```',
			body: 'two\none\nzero',
			close: '  ```',
		});
	});

	test('assembleCodeFence(..., 2): 空行を除く各行の先頭に2スペースを付け直す。フェンス行はそのまま', () => {
		expect(assembleCodeFence('```json', '{\n\n  "b": 2\n}', '  ```', 2)).toBe(
			'```json\n  {\n\n    "b": 2\n  }\n  ```',
		);
	});

	test('split → assemble の往復(無編集)は byte 等価(契約⑥)', async () => {
		const m = await mount(INDENT_DOC);
		// 中身の行がすべて n 以上インデントされた fence は、無編集の確定で原文へ戻る。
		// (n 未満の行を含む fence は CommonMark の除去が非可逆なので対象外。)
		for (const text of ['a = 1', '"a": 1', 'b = 2', 'k: v']) {
			const meta = codeMetaContaining(m.index, text);
			const indent = meta.position.startColumn - 1;
			const parts = splitCodeFence(m.index.sliceOf(meta.id), indent);
			expect(parts, text).not.toBeNull();
			if (!parts) continue;

			const out = replaceRange(
				INDENT_DOC,
				meta.position,
				assembleCodeFence(parts.open, parts.body, parts.close, indent),
			);
			expect(out, text).toBe(INDENT_DOC);
		}
	});

	test('中身を編集して確定: 再インデントされ、フェンス行と外側は byte 等価(契約②⑥)', async () => {
		const m = await mount(INDENT_DOC);
		const meta = codeMetaContaining(m.index, '"a": 1');
		const parts = splitCodeFence(m.index.sliceOf(meta.id), 2);
		expect(parts).not.toBeNull();
		if (!parts) throw new Error('splitCodeFence が null');
		const newBody = '{\n  "a": 2,\n  "b": [1, 2]\n}';

		const out = replaceRange(
			INDENT_DOC,
			meta.position,
			assembleCodeFence(parts.open, newBody, parts.close, 2),
		);

		expect(out).toBe(
			INDENT_DOC.replace(INDENT_JSON_BODY_RAW, '  {\n    "a": 2,\n    "b": [1, 2]\n  }'),
		);
		// 開始フェンス行(行頭のインデント込み)と終了フェンス行が原文のまま残る。
		expect(out).toContain('\n  ```json\n');
		expect(out).toContain('\n  ```\n\n   ```python');
	});

	test('終了フェンスのインデントが開始と違っても終了行は原文のまま(書き直さない)', async () => {
		const m = await mount(INDENT_DOC);
		const meta = codeMetaContaining(m.index, 'k: v');
		const slice = m.index.sliceOf(meta.id);
		expect(slice).toBe('```yaml\n  k: v\n```');

		expect(splitCodeFence(slice, 2)).toEqual({ open: '```yaml', body: 'k: v', close: '```' });

		const out = replaceRange(
			INDENT_DOC,
			meta.position,
			assembleCodeFence('```yaml', 'k: v2', '```', 2),
		);
		expect(out).toBe(INDENT_DOC.replace('  k: v\n```', '  k: v2\n```'));
	});
});

// ---------------------------------------------------------------------------
// AC-52-12 — 閉じフェンス衝突(追補a(7)=2026-09-14 Codex review 反映)
// ---------------------------------------------------------------------------

/**
 * 追補a(7): 確定時に中身の行のうち「行頭 0〜3 スペース + 開始フェンスと同じ
 * フェンス文字が開始フェンス長以上連続 + 残りが空白のみ」の行があれば、開始・終了
 * フェンスのフェンス文字列を**中身の最長候補 + 1** の長さに伸ばす(info string 保持)。
 * 衝突が無ければフェンス行は byte 等価。~~~ fence 内の ``` は衝突ではない。
 * 候補の長さが開始フェンス長未満なら不変。衝突の解決は `assembleCodeFence`(確定時)
 * のみで、素テキスト化(`splitCodeFence`)には影響しない。
 */
describe('AC-52-12 閉じフェンス衝突はフェンスを長くして保存(追補a(7))', () => {
	test('中身に ``` だけの行 → 開始 ````json・終了 ```` に伸びる(info string 保持・中身 verbatim)', () => {
		expect(assembleCodeFence('```json', 'a\n```\nb', '```')).toBe('````json\na\n```\nb\n````');
	});

	test('候補が複数なら最長 + 1(中身に ```(3)と `````(5)→ フェンスは 6)', () => {
		expect(assembleCodeFence('```json', '```\n`````', '```')).toBe(
			'``````json\n```\n`````\n``````',
		);
	});

	test('行頭 0〜3 スペース・末尾空白だけの行も候補(CommonMark の閉じフェンスと同じ見方)', () => {
		expect(assembleCodeFence('```', '   ```', '```')).toBe('````\n   ```\n````');
		expect(assembleCodeFence('```', '``` ', '```')).toBe('````\n``` \n````');
	});

	test('行頭 4 スペースの ``` 行は衝突ではない(閉じフェンスになり得ない=コード)', () => {
		expect(assembleCodeFence('```json', '    ```', '```')).toBe('```json\n    ```\n```');
	});

	test('フェンス文字の後に空白以外が続く行(```js)は衝突ではない', () => {
		expect(assembleCodeFence('```json', '```js', '```')).toBe('```json\n```js\n```');
	});

	test('~~~ fence 内の ``` は衝突ではない(フェンス文字が違う)', () => {
		expect(assembleCodeFence('~~~yaml', '```', '~~~')).toBe('~~~yaml\n```\n~~~');
	});

	test('```` fence 内の ```(開始フェンス長未満)は不変', () => {
		expect(assembleCodeFence('````md', '```\ninner\n```', '````')).toBe(
			'````md\n```\ninner\n```\n````',
		);
	});

	test('衝突の解決は確定時のみ — splitCodeFence(素テキスト化)には影響しない', () => {
		// 伸ばして保存した結果をもう一度3分割すると、中身の ``` はそのまま素テキストに入る。
		expect(splitCodeFence('````json\na\n```\nb\n````')).toEqual({
			open: '````json',
			body: 'a\n```\nb',
			close: '````',
		});
	});

	test('伸ばして保存した文書を render() し直すと code ブロックは1つ・中身 verbatim・後続段落が無傷', async () => {
		const doc = 'Intro paragraph.\n\n```json\nold\n```\n\nTail paragraph.\n';
		const m0 = await mount(doc);
		const meta = codeMetaContaining(m0.index, 'old');
		const parts = expectFenceParts(m0.index.sliceOf(meta.id));
		const newBody = 'a\n```\nb';

		const out = replaceRange(doc, meta.position, assembleCodeFence(parts.open, newBody, parts.close));
		expect(out).toBe('Intro paragraph.\n\n````json\na\n```\nb\n````\n\nTail paragraph.\n');

		const m1 = await mount(out);
		const codeMetas = [...m1.index.byId.values()].filter((cm) => cm.type === 'code');
		expect(codeMetas, '再パースで code ブロックは1つのまま').toHaveLength(1);
		expect(m1.index.sliceOf(codeMetas[0].id)).toBe('````json\na\n```\nb\n````');
		const pre = preContaining(m1.root, '```');
		expect([newBody, newBody + '\n'], 'code の text が中身と一致').toContain(pre.textContent);
		const tail = [...m1.root.querySelectorAll('p')].find(
			(p) => p.textContent === 'Tail paragraph.',
		);
		expect(tail, '後続の段落が無傷').toBeDefined();
	});
});
