/**
 * 要件#48 追補h(2026-10-12・backlog 339)の受け入れテスト AC-48-追h (c)=
 * `decideFileChanged`(契約⑥ の改訂=契約(追補h)3)— 編集と同じ中身の外部変更は衝突にしない。
 *
 * unit プロジェクト(svelte プラグインなし)なので純関数だけを判定する。store 側
 * (`applyFileChanged` が `editBuffer` を渡す・dirty が消える・帯が出ない)は
 * `src/components/Viewer.external-removed-h.wiring.test.ts` の (d)(f)。
 *
 * ## 判定するもの(契約(追補h)3・5= req-48.md)
 * - `FileChangedInput` に任意の `editBuffer?: string | null` が増える(型でも判定。
 *   実装前は `pnpm check` の型エラー=想定どおりの赤)
 * - 編集中・dirty・届いた中身 = `editBuffer`(byte 等価)→ `apply`
 * - 届いた中身 ≠ `editBuffer` → 今までどおり `external-conflict`
 *   (CRLF / BOM の違いも「違う」= `isDirty` と同じく正規化しない)
 * - `editBuffer` を省く / null → 今までどおり `external-conflict`
 * - 保存ハッシュと一致 → 今までどおり `ignore-echo`(同じ中身の判定より先)
 * - 閲覧中・編集中で未変更の `apply` は `editBuffer` を渡しても変わらない
 *
 * ## 想定される赤(実装前)
 * 「= `editBuffer` → apply」の各件(LF・CRLF・BOM・lastSavedHash=null・保存後に別内容で
 * 作り直し)が `external-conflict` のまま=赤。`editBuffer` を渡す件は実装前は型エラー
 * にもなる(`pnpm check`)。「≠ なら external-conflict」「省けば今までどおり」
 * 「ignore-echo が先」「閲覧中 / 未変更の apply」は否定・不変の固定で実装前から緑。
 */
import { describe, expect, test } from 'vitest';
import {
	contentHash,
	decideFileChanged,
	type FileChangedDecision,
	type FileChangedInput,
} from './document-edit';

const SAVED = '# saved content\n';
const BUFFER = '# saved content\nmy edit\n';

// ---------------------------------------------------------------------------
// 型: FileChangedInput に editBuffer?: string | null が増える(契約(追補h)3)
// ---------------------------------------------------------------------------

describe('AC-48-追h (c): FileChangedInput — editBuffer は任意で string | null', () => {
	test('editBuffer: string を持つ入力が FileChangedInput に代入できる(実装前は型エラー)', () => {
		const input: FileChangedInput = {
			incomingContent: BUFFER,
			lastSavedHash: null,
			mode: 'edit',
			dirty: true,
			editBuffer: BUFFER,
		};
		expect(input.editBuffer).toBe(BUFFER);
	});

	test('editBuffer: null も受け付ける', () => {
		const input: FileChangedInput = {
			incomingContent: BUFFER,
			lastSavedHash: null,
			mode: 'edit',
			dirty: true,
			editBuffer: null,
		};
		expect(input.editBuffer).toBe(null);
	});

	test('editBuffer を省いた入力も今までどおり FileChangedInput(任意)', () => {
		const input: FileChangedInput = {
			incomingContent: BUFFER,
			lastSavedHash: null,
			mode: 'edit',
			dirty: true,
		};
		expect('editBuffer' in input).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 編集中・dirty・届いた中身 = editBuffer → apply(契約(追補h)3)
// ---------------------------------------------------------------------------

describe('AC-48-追h (c): 編集中・dirty でも届いた中身が editBuffer と byte 等価なら apply', () => {
	test('一度も保存していない(lastSavedHash=null)編集中・dirty・同じ中身 → apply', () => {
		const d: FileChangedDecision = decideFileChanged({
			incomingContent: BUFFER,
			lastSavedHash: null,
			mode: 'edit',
			dirty: true,
			editBuffer: BUFFER,
		});
		expect(d).toBe('apply');
	});

	test('保存済み(ハッシュは保存時の内容)の後に編集し、編集と同じ中身が届く → apply', () => {
		const d = decideFileChanged({
			incomingContent: BUFFER,
			lastSavedHash: contentHash(SAVED),
			mode: 'edit',
			dirty: true,
			editBuffer: BUFFER,
		});
		expect(d).toBe('apply');
	});

	test('CRLF を含むバッファと CRLF のまま同じ中身が届く → apply(byte 等価)', () => {
		const crlf = 'line one\r\nline two\r\n';
		const d = decideFileChanged({
			incomingContent: crlf,
			lastSavedHash: contentHash('line one\r\n'),
			mode: 'edit',
			dirty: true,
			editBuffer: crlf,
		});
		expect(d).toBe('apply');
	});

	test('BOM 付きのバッファと BOM 付きのまま同じ中身が届く → apply(byte 等価)', () => {
		const bom = '﻿# title\nbody\n';
		const d = decideFileChanged({
			incomingContent: bom,
			lastSavedHash: null,
			mode: 'edit',
			dirty: true,
			editBuffer: bom,
		});
		expect(d).toBe('apply');
	});

	test('空のバッファ(全部消した)と空の中身が届く → apply', () => {
		const d = decideFileChanged({
			incomingContent: '',
			lastSavedHash: contentHash(SAVED),
			mode: 'edit',
			dirty: true,
			editBuffer: '',
		});
		expect(d).toBe('apply');
	});
});

// ---------------------------------------------------------------------------
// 届いた中身 ≠ editBuffer → 今までどおり external-conflict(契約(追補h)5=不変)
// ---------------------------------------------------------------------------

describe('AC-48-追h (c): 届いた中身が editBuffer と違えば今までどおり external-conflict', () => {
	test('別の中身 → external-conflict', () => {
		const d = decideFileChanged({
			incomingContent: '# rewritten outside\n',
			lastSavedHash: contentHash(SAVED),
			mode: 'edit',
			dirty: true,
			editBuffer: BUFFER,
		});
		expect(d).toBe('external-conflict');
	});

	test('改行コードだけ違う(LF のバッファに CRLF が届く)→ external-conflict(正規化しない)', () => {
		const d = decideFileChanged({
			incomingContent: '# saved content\r\nmy edit\r\n',
			lastSavedHash: null,
			mode: 'edit',
			dirty: true,
			editBuffer: BUFFER,
		});
		expect(d).toBe('external-conflict');
	});

	test('BOM の有無だけ違う → external-conflict(正規化しない)', () => {
		const d = decideFileChanged({
			incomingContent: '﻿' + BUFFER,
			lastSavedHash: null,
			mode: 'edit',
			dirty: true,
			editBuffer: BUFFER,
		});
		expect(d).toBe('external-conflict');
	});

	test('末尾の改行の有無だけ違う → external-conflict', () => {
		const d = decideFileChanged({
			incomingContent: BUFFER.replace(/\n$/, ''),
			lastSavedHash: null,
			mode: 'edit',
			dirty: true,
			editBuffer: BUFFER,
		});
		expect(d).toBe('external-conflict');
	});

	test('届いた中身が保存済み content と同じ(編集前の版に戻された)でもバッファと違えば external-conflict', () => {
		const d = decideFileChanged({
			incomingContent: SAVED,
			lastSavedHash: null,
			mode: 'edit',
			dirty: true,
			editBuffer: BUFFER,
		});
		expect(d).toBe('external-conflict');
	});
});

// ---------------------------------------------------------------------------
// editBuffer を省く / null → 今までどおり(契約(追補h)3「省いたときは今までどおり」)
// ---------------------------------------------------------------------------

describe('AC-48-追h (c): editBuffer を省けば今までどおり', () => {
	test('省略: 編集中・dirty なら中身を問わず external-conflict', () => {
		const d = decideFileChanged({
			incomingContent: BUFFER,
			lastSavedHash: null,
			mode: 'edit',
			dirty: true,
		});
		expect(d).toBe('external-conflict');
	});

	test('null: 編集中・dirty なら external-conflict(バッファ無し=比べるものが無い)', () => {
		const d = decideFileChanged({
			incomingContent: BUFFER,
			lastSavedHash: null,
			mode: 'edit',
			dirty: true,
			editBuffer: null,
		});
		expect(d).toBe('external-conflict');
	});

	test('省略: 閲覧中は apply', () => {
		const d = decideFileChanged({
			incomingContent: '# rewritten outside\n',
			lastSavedHash: contentHash(SAVED),
			mode: 'view',
			dirty: false,
		});
		expect(d).toBe('apply');
	});
});

// ---------------------------------------------------------------------------
// 保存ハッシュ一致 → 今までどおり ignore-echo(契約(追補h)5=不変・同じ中身の判定より先)
// ---------------------------------------------------------------------------

describe('AC-48-追h (c): 保存ハッシュと一致すれば今までどおり ignore-echo', () => {
	test('editBuffer とも一致するエコー(保存直後・未変更)→ ignore-echo(apply ではない)', () => {
		const d = decideFileChanged({
			incomingContent: SAVED,
			lastSavedHash: contentHash(SAVED),
			mode: 'edit',
			dirty: false,
			editBuffer: SAVED,
		});
		expect(d).toBe('ignore-echo');
	});

	test('保存後にさらに編集(dirty)し、保存した内容のエコーが届く → ignore-echo', () => {
		const d = decideFileChanged({
			incomingContent: SAVED,
			lastSavedHash: contentHash(SAVED),
			mode: 'edit',
			dirty: true,
			editBuffer: BUFFER,
		});
		expect(d).toBe('ignore-echo');
	});

	test('閲覧中のエコーも editBuffer(null)を渡して ignore-echo', () => {
		const d = decideFileChanged({
			incomingContent: SAVED,
			lastSavedHash: contentHash(SAVED),
			mode: 'view',
			dirty: false,
			editBuffer: null,
		});
		expect(d).toBe('ignore-echo');
	});
});

// ---------------------------------------------------------------------------
// 閲覧中・編集中で未変更の apply は editBuffer を渡しても変わらない(不変)
// ---------------------------------------------------------------------------

describe('AC-48-追h (c): 閲覧中・編集中で未変更の apply は変わらない', () => {
	test('閲覧中に別の中身(editBuffer=null)→ apply', () => {
		const d = decideFileChanged({
			incomingContent: '# rewritten outside\n',
			lastSavedHash: contentHash(SAVED),
			mode: 'view',
			dirty: false,
			editBuffer: null,
		});
		expect(d).toBe('apply');
	});

	test('編集中で未変更(dirty=false)に別の中身(editBuffer=保存済み content)→ apply', () => {
		const d = decideFileChanged({
			incomingContent: '# rewritten outside\n',
			lastSavedHash: contentHash(SAVED),
			mode: 'edit',
			dirty: false,
			editBuffer: SAVED,
		});
		expect(d).toBe('apply');
	});
});
