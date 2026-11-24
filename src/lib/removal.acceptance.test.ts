/**
 * 要件#74 第2段 2-5(撤去)— フロント側の受け入れ基準(AC-74-23 第2段の分・AC-74-25・AC-74-46 のフロントの分・契約21)。
 *
 * **仮の前提(2026-11-17・由谷の確認待ち)**: 2-1〜2-4 の判断に加えて、決定 (ae)=配布版に新しい編集を出す時点は第2段の完了(撤去と同時に
 * フラグを外して通常の機能に)・(af)・(ag)(先行の周回で済み)・(ah)=Settings… / Export Default Theme… は Vellis の窓・(ad)=Edit ▸ Edit を外す。
 * HTML は要件79 が入るまで読むだけ(2026-11-16 の決定)。
 *
 * ## 対応する受け入れ基準
 * - AC-74-23(第2段の分・第3段 3-1 の分): `dependencies` の増えた名前が第1段と第2段(と第3段 3-1 の 2 つ)の一覧の和と一致し、撤去の後は `hast-util-to-mdast` が無い(他で使っていない)。
 *   `devDependencies` は増えない
 * - AC-74-25: `src/markdown/edit.ts` が無い。`Viewer.svelte` に閲覧の DOM へ `contenteditable` を付ける経路が無い(`html-edit-surface` も無い)。
 *   `src/html/edit.ts` の `buildEditSurface` は残る
 * - AC-74-46(フロント): `EDITOR_INLINE_FLAG`・`EDITOR_FILE_FLAG` が無い。`src/lib/editor-flags.ts` が無い。Viewer / +page に `fileEditor` の prop・判定が無い
 * - 契約21: HTML は読むだけ(Viewer に HTML の編集面=`htmlEditing` / `html-edit-surface` が無く、`HtmlViewer` の iframe で描く)
 *
 * ## 確定契約(implementer はこれに従う)
 * - 消すもの=項目 27 の一覧(`src/markdown/edit.ts`・`src/lib/editor-flags.ts`・Viewer の `fileEditor` / `editable` の prop・`editMode` ほか・
 *   `document-edit.ts` の `bufferFromPre` / `decideFileChanged` / `shouldSaveOnCommand` / `MENU_EDIT_EVENT`・`legacy-features.ts` の `edit`)
 * - 残すもの=`src/html/edit.ts`(無改変=AC-54-14 の SHA-256 の固定はそのまま)・`external-removed-banner`・`contentHash` / `isDirty` / `canEnterEdit`・
 *   `confirmDiscardEdits`・`HtmlViewer.svelte` / `html-viewer.ts`(AC-56-14)
 * - `package.json`: `hast-util-to-mdast` を `dependencies` から外す(ほかの依存の増減なし)。`devDependencies` は無改変
 *
 * ## 修正前に赤になる理由
 * - `src/markdown/edit.ts`・`src/lib/editor-flags.ts` があり、`package.json` に `hast-util-to-mdast` があり、Viewer に `contenteditable` の経路と
 *   `fileEditor` の prop が残っている
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');
const exists = (rel: string) => existsSync(resolve(REPO_ROOT, rel));

/** 行コメント・ブロックコメント・HTML コメントを落とす(文字列の中の `//` は URL 以外に無い前提)。 */
function stripComments(src: string): string {
	return src
		.replace(/<style[\s\S]*?<\/style>/g, '') // <style> の規則(print-edit-marks の AC-38-追l (c) の印の規則)は見ない
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.map((line) => {
			for (let i = 0; i + 1 < line.length; i++) {
				if (line[i] === '/' && line[i + 1] === '/' && (i === 0 || line[i - 1] !== ':')) return line.slice(0, i);
			}
			return line;
		})
		.join('\n');
}

/** 契約20 (am)・(D): 第1段と第2段で足した依存の和。 */
const STAGE1_DEPS = ['@codemirror/commands', '@codemirror/language', '@codemirror/language-data', '@codemirror/state', '@codemirror/view', '@lezer/highlight'];
const STAGE2_DEPS = [
	'prosemirror-commands',
	'prosemirror-history',
	'prosemirror-keymap',
	'prosemirror-model',
	'prosemirror-schema-list',
	'prosemirror-state',
	'prosemirror-tables',
	'prosemirror-transform',
	'prosemirror-view',
];
/** 第3段(2026-11-17 昼 由谷の決定 3-18)。3-1=入力規則と gap cursor・3-5=dropcursor。 */
const STAGE3_DEPS = ['prosemirror-dropcursor', 'prosemirror-gapcursor', 'prosemirror-inputrules'];
/** 2026-11-16 の main(要件74 の前)の dependencies。 */
const BASE_DEPS = [
	'@shikijs/rehype',
	'@tauri-apps/api',
	'@tauri-apps/plugin-dialog',
	'@tauri-apps/plugin-opener',
	'hast-util-to-mdast',
	'mdast-util-to-markdown',
	'mdast-util-to-string',
	'mermaid',
	'rehype-parse',
	'rehype-raw',
	'rehype-sanitize',
	'rehype-stringify',
	'remark-gfm',
	'remark-parse',
	'remark-rehype',
	'three',
	'unified',
	'unist-util-visit',
];

describe('AC-74-23(第2段の分)・契約20: 依存', () => {
	const pkg = () => JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

	test('dependencies = 2026-11-16 の一覧 − hast-util-to-mdast + 第1段・第2段・第3段(3-1 の分)の和', () => {
		const expected = [...BASE_DEPS.filter((d) => d !== 'hast-util-to-mdast'), ...STAGE1_DEPS, ...STAGE2_DEPS, ...STAGE3_DEPS].sort();
		expect(Object.keys(pkg().dependencies).sort()).toEqual(expected);
	});
	test('hast-util-to-mdast は dependencies にも devDependencies にも無く、src/ のどこからも import されない', () => {
		expect('hast-util-to-mdast' in pkg().dependencies).toBe(false);
		expect('hast-util-to-mdast' in pkg().devDependencies).toBe(false);
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(resolve(REPO_ROOT, dir), { withFileTypes: true })) {
				const rel = `${dir}/${entry.name}`;
				if (entry.isDirectory()) walk(rel);
				else if (/\.(ts|svelte|js)$/.test(entry.name)) files.push(rel);
			}
		};
		walk('src');
		const users = files.filter((f) => !f.endsWith('.test.ts') && read(f).includes('hast-util-to-mdast'));
		expect(users, 'no source file imports hast-util-to-mdast').toEqual([]);
	});
	test('devDependencies は増えていない(要件56 の AC-56-11 の一覧がそのまま緑=ここでは mdast 系の devDependency が増えていないことだけ)', () => {
		const dev = Object.keys(pkg().devDependencies);
		expect(dev.filter((d) => d.startsWith('hast-util-') || d.startsWith('mdast-util-'))).toEqual([]);
	});
});

describe('AC-74-25・契約21: 今の編集のコードが無い', () => {
	test('src/markdown/edit.ts が無く、src/markdown/ の中に編集のテスト(edit*.acceptance / code-edit.acceptance)も無い', () => {
		expect(exists('src/markdown/edit.ts')).toBe(false);
		const files = readdirSync(resolve(REPO_ROOT, 'src/markdown'));
		expect(files.filter((f) => /^(edit.*|code-edit)\.acceptance\.test\.ts$/.test(f))).toEqual([]);
	});
	test('src/html/edit.ts の buildEditSurface は残る(要件54 の HTML の検索・要件79)', () => {
		const src = read('src/html/edit.ts');
		expect(src).toMatch(/export function buildEditSurface\(/);
	});
	test('Viewer.svelte: 閲覧の DOM へ contenteditable を付ける経路・html-edit-surface・今の編集の帯・editMode・fileEditor / editable の prop が無い', () => {
		const src = stripComments(read('src/components/Viewer.svelte'));
		// `[contenteditable="true"]` の属性セレクタ(キャレットの位置の読み取り)は「付ける経路」ではないので除く。
		expect(src).not.toMatch(/(?<!\[)contenteditable\s*=\s*["']?true|contenteditable=\{|setAttribute\(\s*['"]contenteditable['"]|\.contentEditable\s*=/);
		for (const needle of [
			'html-edit-surface',
			'htmlEditing',
			'edit-done',
			'edit-source',
			'external-change-banner',
			'external-overwrite',
			'external-reload',
			'editMode',
			'editBuffer',
			"from '../markdown/edit'",
			'bufferFromPre',
			'decideFileChanged',
			'MENU_EDIT_EVENT',
			'fileEditor = ',
			'fileEditor?:',
			'editable = ',
			'editable?:',
			'Done Editing',
		]) {
			expect(src, `Viewer.svelte must not contain ${JSON.stringify(needle)}`).not.toContain(needle);
		}
	});
	test('+page.svelte: MENU_EDIT_EVENT・toggleEditMode・EDITOR_FILE_FLAG・editor-flags・legacy.edit・fileEditor の判定が無い', () => {
		const src = stripComments(read('src/routes/+page.svelte'));
		for (const needle of ['MENU_EDIT_EVENT', 'toggleEditMode', 'EDITOR_FILE_FLAG', 'editor-flags', 'legacy.edit', 'fileEditor={', 'editable={', 'editMode']) {
			expect(src, needle).not.toContain(needle);
		}
	});
	test('window-state.svelte.ts: editMode / editBuffer / externalChange / beginEdit / endEdit / updateBuffer / acceptExternalChange が無く、dirty は面の handle を映す', () => {
		const src = stripComments(read('src/stores/window-state.svelte.ts'));
		for (const needle of ['editMode', 'editBuffer', 'externalChange', 'beginEdit(', 'endEdit(', 'updateBuffer(', 'acceptExternalChange(']) {
			expect(src, needle).not.toContain(needle);
		}
		const at = src.indexOf('get dirty()');
		expect(at, 'dirty is a getter').toBeGreaterThanOrEqual(0);
		expect(src.slice(at, at + 200)).toContain('fileEditor');
	});
	test('document-edit.ts: bufferFromPre / decideFileChanged / shouldSaveOnCommand / MENU_EDIT_EVENT / EditMode が無い', () => {
		const src = read('src/lib/document-edit.ts');
		for (const needle of ['bufferFromPre', 'decideFileChanged', 'shouldSaveOnCommand', 'MENU_EDIT_EVENT', 'EditMode']) {
			expect(src, needle).not.toContain(needle);
		}
	});
});

describe('AC-74-46(フロント)・契約21: フラグの撤去', () => {
	test('src/lib/editor-flags.ts が無く、EDITOR_FILE_FLAG / editor_file がフロントのどこにも無い', () => {
		expect(exists('src/lib/editor-flags.ts')).toBe(false);
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(resolve(REPO_ROOT, dir), { withFileTypes: true })) {
				const rel = `${dir}/${entry.name}`;
				if (entry.isDirectory()) walk(rel);
				else if (/\.(ts|svelte)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) files.push(rel);
			}
		};
		walk('src');
		const users = files.filter((f) => /EDITOR_FILE_FLAG|EDITOR_INLINE_FLAG|['"]editor_file['"]|['"]editor_inline['"]/.test(stripComments(read(f))));
		expect(users).toEqual([]);
	});
	test("legacy-features.ts は AI_MARKS_FLAG だけ(legacyUi は { ai })", () => {
		const src = stripComments(read('src/lib/legacy-features.ts'));
		expect(src).toContain("export const AI_MARKS_FLAG = 'ai_marks'");
		expect(src).not.toContain('EDITOR_INLINE_FLAG');
		expect(src).not.toMatch(/\bedit\s*:/);
	});
	test('Viewer.svelte に新しい面を出す条件としてのフラグ判定が無い(常に面)', () => {
		const src = stripComments(read('src/components/Viewer.svelte'));
		expect(src).not.toMatch(/\bfileEditor\s*&&/);
		expect(src).not.toContain('featureFlags.isEnabled');
	});
});

describe('契約21: HTML は要件79 が入るまで読むだけ', () => {
	test('Viewer.svelte に HTML の編集面(htmlEditing・html-edit-surface・Source ボタン)が無く、HtmlViewer(iframe)で描く', () => {
		const src = stripComments(read('src/components/Viewer.svelte'));
		expect(src).not.toContain('htmlEditing');
		expect(src).not.toContain('html-edit-surface');
		expect(src).not.toContain('edit-source');
	});
	test('+page.svelte は html を HtmlViewer に渡す経路を保つ(AC-56-14=HtmlViewer.svelte は無改変)', () => {
		const src = stripComments(read('src/routes/+page.svelte'));
		expect(src).toContain('<HtmlViewer');
	});
});

// ---------------------------------------------------------------------------
// reviewer の照合(2026-11-17・P2 の穴)— F1 Reload File の reset・F7 Command + S の配線
// ---------------------------------------------------------------------------

/** `open`(`(` / `{`)から対応する閉じ括弧までの中身(文字列・テンプレートの中は数えない)。 */
function balancedBody(src: string, open: number): string {
	const pairs: Record<string, string> = { '(': ')', '{': '}' };
	const close = pairs[src[open]!];
	let depth = 0;
	let quote: string | null = null;
	for (let i = open; i < src.length; i++) {
		const c = src[i]!;
		if (quote) {
			if (c === '\\') {
				i++;
				continue;
			}
			if (c === quote) quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			continue;
		}
		if (c === src[open]) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	throw new Error('unbalanced');
}
function fnBody(src: string, name: string): string {
	const at = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
	expect(at, `+page.svelte defines function ${name}(`).toBeGreaterThanOrEqual(0);
	return balancedBody(src, src.indexOf('{', src.indexOf(')', at)));
}

describe('F1・契約16・(ak)・AC-74-41: +page の Reload File の applyText は、確認(Don\'t Save)の後に dirty の面を読み直した中身で reset する', () => {
	test('createFileReloader({…}) の applyText の中で windowState.applyReloadedText( を呼び、fileEditor の dirty を見て reset( を呼ぶ', () => {
		const src = stripComments(read('src/routes/+page.svelte'));
		const at = src.indexOf('createFileReloader(');
		expect(at, '+page.svelte calls createFileReloader(').toBeGreaterThanOrEqual(0);
		const args = balancedBody(src, src.indexOf('(', at));
		const applyAt = args.indexOf('applyText');
		expect(applyAt, 'the deps have applyText').toBeGreaterThanOrEqual(0);
		// applyText の値= `(doc) => { … }` か `(doc) => expr`。次の `{` からの本体(無ければ行末まで)を読む。
		const brace = args.indexOf('{', applyAt);
		const body = brace >= 0 && brace - applyAt < 60 ? balancedBody(args, brace) : args.slice(applyAt, args.indexOf('\n', applyAt));
		expect(body).toContain('windowState.applyReloadedText(');
		expect(body).toMatch(/fileEditor/);
		expect(body).toMatch(/\.dirty\b/);
		expect(body).toMatch(/\.reset\(/);
		expect(body.indexOf('applyReloadedText('), 'store に当ててから面を reset する').toBeLessThan(body.indexOf('.reset('));
		expect(body).not.toContain('setDocument(');
		// 確認は createFileReloader の confirm(confirmDiscardEdits)が持つ(reset の前に Don't Save が出る)。
		expect(args).toMatch(/confirm:\s*confirmDiscardEdits/);
	});
	test('store の applyReloadedText は dirty の面を畳まない(dirty でなければ reset・あれば触らない=AC-80-19 (3))', () => {
		const src = stripComments(read('src/stores/window-state.svelte.ts'));
		const at = src.indexOf('applyReloadedText(doc');
		expect(at).toBeGreaterThanOrEqual(0);
		const body = balancedBody(src, src.indexOf('{', at));
		expect(body).toMatch(/!\s*this\.fileEditor\.dirty|!\s*this\.fileEditor\?\.dirty/);
		expect(body).toContain('.reset(');
	});
});

describe('F7・契約14・AC-74-40 の後継: Command + S の配線', () => {
	test('listen(MENU_SAVE_EVENT の受け手が saveCurrentEdits( を呼び、saveCurrentEdits の本文が saveFileEditor(windowState.fileEditor) を呼ぶ(門なし)', () => {
		const src = stripComments(read('src/routes/+page.svelte'));
		const at = src.indexOf('listen(MENU_SAVE_EVENT');
		expect(at, "listen(MENU_SAVE_EVENT, …) in +page.svelte").toBeGreaterThanOrEqual(0);
		const handler = balancedBody(src, src.indexOf('(', at));
		expect(handler).toContain('saveCurrentEdits(');
		expect(handler).not.toMatch(/legacy\.edit|editor_file|EDITOR_FILE_FLAG|is_enabled|featureFlags/);
		const body = fnBody(src, 'saveCurrentEdits');
		expect(body).toContain('saveFileEditor(');
		expect(body).toContain('windowState.fileEditor');
		expect(body).not.toMatch(/saveDocument\(|editBuffer|editMode|shouldSaveOnCommand/);
		expect(src).toMatch(/import\s*\{[^}]*\bsaveFileEditor\b[^}]*\}\s*from\s*'\.\.\/editor\/file-editor'/);
		expect(src).toMatch(/import\s*\{[^}]*\bMENU_SAVE_EVENT\b[^}]*\}\s*from\s*'\$lib\/save-document'/);
	});
});
