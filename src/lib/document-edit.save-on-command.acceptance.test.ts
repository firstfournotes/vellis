/**
 * 要件#48 追補i (a)(b) — Command + S の保存の可否。
 *
 * 要件74 第2段 2-5(2026-11-17 仮・契約21・契約14・棚卸し 4「一部を書き直し(shouldSaveOnCommand の mode)」=承認済み (r)(as)):
 * 今の編集の撤去で `shouldSaveOnCommand(mode, dirty, removed)` は document-edit.ts から消え、同じ判断は `saveFileEditor(handle)`
 * (要件74 契約14=readOnly なら何もしない・dirty でも externalRemoved でもなければ何もしない・removed なら expectedHash を省く)が持つ。
 * ここでは (1) 純関数が消えていること、(2) ページの `saveCurrentEdits` が `saveFileEditor(windowState.fileEditor)` を呼び、
 * `shouldSaveOnCommand` も `windowState.editMode` も見ないことを固定する。真理値表そのものは `CodeEditor.wiring.test.ts` の
 * 保存のケース(AC-74-16・契約14)が見る。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as documentEdit from './document-edit';

const REPO_ROOT = resolve(__dirname, '../..');
const page = () => readFileSync(resolve(REPO_ROOT, 'src/routes/+page.svelte'), 'utf8');

function fnBody(src: string, name: string): string {
	const at = src.indexOf(`function ${name}(`);
	expect(at, `+page.svelte defines ${name}`).toBeGreaterThanOrEqual(0);
	const open = src.indexOf('{', at);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	throw new Error('unbalanced');
}

describe('要件74 2-5: shouldSaveOnCommand は document-edit.ts から消える', () => {
	test('export されていない', () => {
		expect('shouldSaveOnCommand' in documentEdit).toBe(false);
	});
});

describe('契約14: +page.svelte の saveCurrentEdits は saveFileEditor(windowState.fileEditor) に任せる', () => {
	test('本体が saveFileEditor( を呼び、shouldSaveOnCommand( と windowState.editMode・editBuffer を見ない', () => {
		const src = page();
		const body = fnBody(src, 'saveCurrentEdits');
		expect(body).toContain('saveFileEditor(');
		expect(body).toContain('windowState.fileEditor');
		expect(body).not.toContain('shouldSaveOnCommand(');
		expect(body).not.toMatch(/windowState\.editMode|windowState\.editBuffer|saveDocument\(/);
	});
	test("shouldSaveOnCommand を import していない・saveFileEditor を '../editor/file-editor' から import している", () => {
		const src = page();
		expect(src).not.toMatch(/\bshouldSaveOnCommand\b/);
		expect(src).toMatch(/import\s*\{[^}]*\bsaveFileEditor\b[^}]*\}\s*from\s*'\.\.\/editor\/file-editor'/);
	});
	test('MENU_SAVE_EVENT の受け手はフラグを見ずに saveCurrentEdits( を呼ぶ(契約21=門なし)', () => {
		const src = page();
		const at = src.indexOf('listen(MENU_SAVE_EVENT');
		expect(at).toBeGreaterThanOrEqual(0);
		const handler = src.slice(at, src.indexOf('saveCurrentEdits(', at) + 'saveCurrentEdits('.length);
		expect(handler).not.toMatch(/legacy\.edit|fileEditor\b.*return|EDITOR_FILE_FLAG|editor_file/);
	});
});
