/**
 * 要件#48 の受け入れテスト(requirements.md #48)— 純関数 VM と保存経路(TS 側)
 *
 * 「閲覧専用(FR-02)撤廃の第1段」: プレーンテキストのその場編集+保存と、
 * markdown/html 種別のソース編集モード。本ファイルは unit プロジェクト
 * (svelte プラグインなし)なので、runes を含む WindowState 本体の状態遷移は
 * Viewer.edit.wiring.test.ts(component プロジェクト)側で判定する。
 *
 * ## 判定するもの(契約番号は requirements.md #48 の①〜⑨)
 * 1. `canEnterEdit`(契約①②): text/markdown/html だけが編集に入れる。
 *    ssh root(uri が ssh:// 始まり)は種別を問わず不可(SSH 書き込みは初版
 *    Unsupported=読み取り専用のまま)
 * 2. `isDirty`(契約④): 編集バッファ≠保存済み content の byte 等価判定。
 *    BOM/CRLF を正規化しない(正規化すると保存時に原文が壊れる)
 * 3. `contentHash` / `decideFileChanged`(契約⑥): 自己書き込みエコー抑止と
 *    外部変更衝突の3分岐(ignore-echo / external-conflict / apply)
 * 4. `bufferFromPre`(契約②): `renderPlainText` の `<pre class="vellis-plaintext">`
 *    マークアップ(file-type.ts — `<pre>` 直後に意図的な `\n` を入れて改行始まり
 *    ソースを守る)から textContent で原文がラウンドトリップすること。
 *    境界4ケース=改行始まり・末尾改行なし・CRLF・BOM 付き
 * 5. `saveDocument`(契約⑤): invoke('save_document', { uri, content }) を呼び、
 *    **成功後のみ** windowState.markSaved(content)(失敗時は dirty のまま)。
 *    invoke は `$lib/ipc` の薄いラッパ経由(既存の家風・vi.mock で判定)
 * 6. 設計文書の改訂(契約⑧): FR-02「閲覧専用」の文言撤去・architecture §10.1 の
 *    「FileProvider への書き込み系メソッド」禁止の撤去・README「it has no editor」
 *    の撤去。残す禁止=「ファイル削除・リネーム・移動」は残ること
 *
 * ## 判定しないもの
 * - WindowState の編集状態遷移・Viewer の contenteditable 配線
 *   → Viewer.edit.wiring.test.ts
 * - Rust 側(FileProvider::write_text / atomic write / SSH Unsupported)
 *   → src-tauri/tests/acceptance_req48.rs
 * - ⌘S / File > Save メニュー・閉窓確認・IME 中の安定・衝突表示の見え方
 *   → 人間ゲート(acceptance/acceptance.md)+ reviewer 照合
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
// save-document.ts は成功後に windowState.markSaved を呼ぶ契約。runes を含む
// ストア本体は unit プロジェクトではコンパイルできない(svelte プラグイン非適用)
// ためモジュールモックで差し替え、「呼ばれたこと」だけを判定する(遷移の実体は wiring 側)。
vi.mock('../stores/window-state.svelte', () => ({
	windowState: { markSaved: vi.fn() },
}));

import { invoke } from '$lib/ipc';
import {
	bufferFromPre,
	canEnterEdit,
	contentHash,
	decideFileChanged,
	isDirty,
	type EditableKind,
	type EditMode,
	type FileChangedDecision,
} from './document-edit';
import { saveDocument } from './save-document';
import { windowState } from '../stores/window-state.svelte';
import type { FileType } from './file-type';

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// canEnterEdit — 編集に入れる種別と root(契約①②)
// ---------------------------------------------------------------------------

describe('canEnterEdit — text/markdown/html のみ・SSH は不可(契約①②)', () => {
	const LOCAL = 'file:///Users/a/notes/memo.txt';

	test.each<EditableKind>(['text', 'markdown', 'html'])(
		'ローカルの %s は編集に入れる',
		(kind) => {
			expect(canEnterEdit(kind, LOCAL)).toBe(true);
		}
	);

	test.each<FileType>(['image', 'model3d', 'video', 'pdf', 'binary'])(
		'%s は編集に入れない(contenteditable 経路の対象外)',
		(kind) => {
			expect(canEnterEdit(kind, LOCAL)).toBe(false);
		}
	);

	test('ssh root は text でも編集に入れない(SSH 書き込みは初版 Unsupported)', () => {
		expect(canEnterEdit('text', 'ssh://user@host/notes/memo.txt')).toBe(false);
	});

	test('ssh root は markdown のソース編集にも入れない', () => {
		expect(canEnterEdit('markdown', 'ssh://host/docs/plan.md')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isDirty — byte 等価・正規化なし(契約④)
// ---------------------------------------------------------------------------

describe('isDirty — 編集バッファ≠保存済み content(契約④)', () => {
	test('同一内容は dirty ではない', () => {
		expect(isDirty('hello\n', 'hello\n')).toBe(false);
	});

	test('1文字でも違えば dirty', () => {
		expect(isDirty('hello!', 'hello')).toBe(true);
	});

	test('CRLF と LF を同一視しない(正規化すると保存時に原文の改行が壊れる)', () => {
		expect(isDirty('a\r\nb', 'a\nb')).toBe(true);
	});

	test('BOM の有無を同一視しない', () => {
		expect(isDirty('﻿abc', 'abc')).toBe(true);
	});

	test('空文字どうしは dirty ではない', () => {
		expect(isDirty('', '')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// contentHash — エコー抑止用の同値判定(契約⑥)
// ---------------------------------------------------------------------------

describe('contentHash — 同一 content→同一値・異なれば異なる(契約⑥)', () => {
	test('同じ内容は常に同じハッシュ', () => {
		const c = '# title\n\nbody\r\nCRLF もそのまま\n';
		expect(contentHash(c)).toBe(contentHash(c));
	});

	test('異なる内容は異なるハッシュ(エコー判定が偽陽性にならない代表ケース)', () => {
		const pairs: Array<[string, string]> = [
			['a', 'b'],
			['hello', 'hello '],
			['﻿abc', 'abc'],
			['a\r\nb', 'a\nb'],
			['', '\n'],
		];
		for (const [x, y] of pairs) {
			expect(contentHash(x)).not.toBe(contentHash(y));
		}
	});

	test('ハッシュは文字列(lastSavedHash として WindowState に保持できる形)', () => {
		expect(typeof contentHash('x')).toBe('string');
	});
});

// ---------------------------------------------------------------------------
// decideFileChanged — file_changed の3分岐(契約⑥)
// ---------------------------------------------------------------------------

describe('decideFileChanged — エコー抑止と外部変更の分岐(契約⑥)', () => {
	const SAVED = '# saved content\n';

	test('保存直後のエコー(ハッシュ一致)は ignore-echo — 編集中', () => {
		const d: FileChangedDecision = decideFileChanged({
			incomingContent: SAVED,
			lastSavedHash: contentHash(SAVED),
			mode: 'edit',
			dirty: false,
		});
		expect(d).toBe('ignore-echo');
	});

	test('エコーは mode を問わず ignore-echo — 閲覧中でも setDocument へ流さない', () => {
		const d = decideFileChanged({
			incomingContent: SAVED,
			lastSavedHash: contentHash(SAVED),
			mode: 'view',
			dirty: false,
		});
		expect(d).toBe('ignore-echo');
	});

	test('エコーは dirty(保存後にさらに編集)でも ignore-echo — 編集 DOM を破棄しない', () => {
		const d = decideFileChanged({
			incomingContent: SAVED,
			lastSavedHash: contentHash(SAVED),
			mode: 'edit',
			dirty: true,
		});
		expect(d).toBe('ignore-echo');
	});

	test('編集中+dirty に不一致の外部変更 → external-conflict(再レンダーしない)', () => {
		const d = decideFileChanged({
			incomingContent: '# rewritten outside\n',
			lastSavedHash: contentHash(SAVED),
			mode: 'edit',
			dirty: true,
		});
		expect(d).toBe('external-conflict');
	});

	test('閲覧中の外部変更 → apply(従来どおり外部版で更新)', () => {
		const d = decideFileChanged({
			incomingContent: '# rewritten outside\n',
			lastSavedHash: contentHash(SAVED),
			mode: 'view',
			dirty: false,
		});
		expect(d).toBe('apply');
	});

	test('編集中でも未変更(dirty=false)なら apply — 失うものがないので外部版に追従', () => {
		const d = decideFileChanged({
			incomingContent: '# rewritten outside\n',
			lastSavedHash: contentHash(SAVED),
			mode: 'edit',
			dirty: false,
		});
		expect(d).toBe('apply');
	});

	test('一度も保存していない(lastSavedHash=null)閲覧中は apply', () => {
		const d = decideFileChanged({
			incomingContent: '# anything\n',
			lastSavedHash: null,
			mode: 'view',
			dirty: false,
		});
		expect(d).toBe('apply');
	});

	test('lastSavedHash=null でも編集中+dirty なら external-conflict', () => {
		const d = decideFileChanged({
			incomingContent: '# anything\n',
			lastSavedHash: null,
			mode: 'edit',
			dirty: true,
		});
		expect(d).toBe('external-conflict');
	});
});

// ---------------------------------------------------------------------------
// bufferFromPre — renderPlainText マークアップとのラウンドトリップ(契約②)
// ---------------------------------------------------------------------------

/**
 * file-type.ts の escapeHtml と同じ写像(テスト側フィクスチャとして再定義)。
 *
 * 追補b(2026-09-05): CR は `&#13;` に退避する。HTML パーサは仕様
 * (HTML §13.2.3.5)で入力ストリームの CR / CRLF を LF に正規化するため、
 * `innerHTML` の生の `\r` は DOM に残らない。一方、文字参照はトークナイザの
 * 正規化対象外なので `&#13;` は U+000D のまま textContent に現れる。製品側の
 * 編集 `<pre>` は `el.textContent = content` で流し込むので CR は元々保持される
 * =この退避はフィクスチャを DOM の実態に合わせるためだけの措置で、
 * byte 等価の判定は弱めない。
 */
function escapeHtml(source: string): string {
	const ESCAPES: Record<string, string> = {
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
		'\r': '&#13;',
	};
	return source.replace(/[&<>"'\r]/g, (c) => ESCAPES[c]);
}

/** renderPlainText(file-type.ts)と同形のマークアップから `<pre>` 要素を作る。 */
function preFromContent(content: string): HTMLElement {
	const host = document.createElement('div');
	// `<pre>` 直後の `\n` は renderPlainText が意図的に入れているもの
	// (HTML パーサが1つ食うので、改行始まりのソースが textContent で守られる)。
	host.innerHTML = `<pre class="vellis-plaintext">\n${escapeHtml(content)}</pre>`;
	const pre = host.querySelector('pre');
	if (!pre) throw new Error('fixture: <pre> not found');
	return pre;
}

describe('bufferFromPre — textContent ラウンドトリップ(契約②の境界4ケース)', () => {
	test('改行で始まるソースが byte 等価で戻る', () => {
		const content = '\nfirst line was empty\nsecond\n';
		expect(bufferFromPre(preFromContent(content))).toBe(content);
	});

	test('末尾改行なしのソースが byte 等価で戻る', () => {
		const content = 'no trailing newline';
		expect(bufferFromPre(preFromContent(content))).toBe(content);
	});

	test('CRLF 改行のソースが byte 等価で戻る(LF へ潰さない)', () => {
		const content = 'line1\r\nline2\r\n';
		expect(bufferFromPre(preFromContent(content))).toBe(content);
	});

	test('BOM 付き UTF-8 のソースが byte 等価で戻る', () => {
		const content = '﻿# bom heading\nbody\n';
		expect(bufferFromPre(preFromContent(content))).toBe(content);
	});

	test('HTML 特殊文字(& < > " \')が escape/unescape 対称で戻る', () => {
		const content = 'if (a < b && c > "d") { s = \'&amp;\'; }\n';
		expect(bufferFromPre(preFromContent(content))).toBe(content);
	});
});

// ---------------------------------------------------------------------------
// saveDocument — 保存経路(契約⑤の TS 側)
// ---------------------------------------------------------------------------

describe('saveDocument — invoke("save_document") と markSaved(契約⑤)', () => {
	const URI = 'file:///Users/a/notes/memo.txt';
	const CONTENT = 'edited body\n';

	test('save_document を { uri, content } で1回呼ぶ', async () => {
		invokeMock.mockResolvedValue(undefined);

		await saveDocument(URI, CONTENT);

		expect(invokeMock.mock.calls).toEqual([
			['save_document', { uri: URI, content: CONTENT }],
		]);
	});

	test('成功後に windowState.markSaved(content) を呼ぶ(dirty 解消と lastSavedHash 更新の入口)', async () => {
		invokeMock.mockResolvedValue(undefined);

		await saveDocument(URI, CONTENT);

		expect(vi.mocked(windowState.markSaved).mock.calls).toEqual([[CONTENT]]);
	});

	test('invoke 失敗時は reject を伝播し markSaved を呼ばない(dirty のまま=保存できていない)', async () => {
		invokeMock.mockRejectedValue(new Error('disk full'));

		await expect(saveDocument(URI, CONTENT)).rejects.toThrow('disk full');
		expect(windowState.markSaved).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 設計文書の改訂 — FR-02 撤廃の同周回反映(契約⑧)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../..');

function readDoc(rel: string): string {
	const path = resolve(REPO_ROOT, rel);
	expect(existsSync(path), `${rel} が存在すること`).toBe(true);
	return readFileSync(path, 'utf8');
}

describe('設計文書の改訂 — FR-02 撤廃の反映(契約⑧)', () => {
	test('docs/requirements.md: FR-02 の「閲覧専用とし、本文編集機能を提供しないこと」は撤去済み', () => {
		expect(readDoc('docs/requirements.md')).not.toContain(
			'閲覧専用とし、本文編集機能を提供しないこと'
		);
	});

	test('docs/architecture.md §10.1: 「FileProvider への書き込み系メソッド」は禁止事項から撤去済み', () => {
		expect(readDoc('docs/architecture.md')).not.toContain(
			'FileProvider への書き込み系メソッド'
		);
	});

	test('docs/architecture.md: 「ファイル削除・リネーム・移動」の禁止は残る(撤廃は編集・保存のみ)', () => {
		expect(readDoc('docs/architecture.md')).toContain('ファイル削除・リネーム・移動');
	});

	test('README.md: 「it has no editor」は撤去済み', () => {
		expect(readDoc('README.md')).not.toContain('it has no editor');
	});
});

// EditMode 型は VM の公開契約(view/edit の2値)。型レベルの参照で pnpm check に載せる。
const _modeCheck: EditMode[] = ['view', 'edit'];
void _modeCheck;
