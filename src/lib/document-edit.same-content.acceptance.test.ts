/**
 * 要件#48 追補h (c) — 同じ中身の外部変更は衝突にしない。
 *
 * 要件74 第2段 2-5(2026-11-17 仮・契約21・契約13・棚卸し 4「一部を書き直し(decideFileChanged の mode)」=承認済み (r)(as)):
 * 今の編集の撤去で `decideFileChanged`(`mode`・`editBuffer` を見る純関数)は document-edit.ts から消え、同じ判断は新しい面の handle の
 * `applyFileChanged(payload)`(要件74 契約12・13)が持つ。ここでは (1) 純関数が消えていること、(2) 同じ判断が面の側にあることの
 * ソース走査(CodeEditor / MarkdownEditor の applyFileChanged が「届いた内容が今の文字列と同じなら apply」と「自己書き込みのエコー」を
 * 判断する)を固定する。振る舞いそのものは `CodeEditor.wiring.test.ts`(AC-74-12・13・契約13)と `MarkdownEditor.wiring.test.ts` の
 * 外部変更のケースが見る。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as documentEdit from './document-edit';

const REPO_ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

describe('要件74 2-5: decideFileChanged(mode・editBuffer)は document-edit.ts から消える', () => {
	test('export されていない', () => {
		expect('decideFileChanged' in documentEdit).toBe(false);
		expect('bufferFromPre' in documentEdit).toBe(false);
	});
	test('document-edit.ts に editBuffer / mode の判断が残っていない', () => {
		const src = read('src/lib/document-edit.ts');
		expect(src).not.toMatch(/\beditBuffer\b/);
		expect(src).not.toMatch(/\bEditMode\b/);
	});
});

describe('追補h (c) の判断は面の handle(applyFileChanged)にある(ソース走査)', () => {
	for (const rel of ['src/components/CodeEditor.svelte', 'src/components/MarkdownEditor.svelte']) {
		test(`${rel}: applyFileChanged が自己書き込みのエコー('ignore-echo')と同じ中身('apply')を判断する`, () => {
			const src = read(rel);
			const at = src.indexOf('applyFileChanged(');
			expect(at, 'the handle has applyFileChanged').toBeGreaterThanOrEqual(0);
			const body = src.slice(at, at + 2500);
			expect(body).toContain("'ignore-echo'");
			expect(body).toContain("'apply'");
			expect(body).toContain("'external-conflict'");
			expect(body).toMatch(/contentHash\(/);
		});
	}
	test('window-state の applyFileChanged は面があれば handle に委ね、自前で editBuffer を比べない', () => {
		const src = read('src/stores/window-state.svelte.ts');
		const at = src.indexOf('applyFileChanged(payload');
		expect(at).toBeGreaterThanOrEqual(0);
		const body = src.slice(at, at + 1200);
		expect(body).toContain('fileEditor');
		expect(body).toContain('.applyFileChanged(payload)');
		expect(body).not.toMatch(/\beditBuffer\b/);
		expect(body).not.toContain('decideFileChanged(');
	});
});
