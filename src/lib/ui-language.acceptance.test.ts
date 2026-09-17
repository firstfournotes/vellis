/**
 * 要件#51 の受け入れテスト(正本 docs/requirements/req-51.md)— unit 層
 * 「UI 文言の全英語化」: src/ の UI 文言をすべて英語にする(契約①)。
 * i18n 機構は導入しない=英語固定への置換のみ・依存追加ゼロ(契約④)。
 * 挙動不変=変わるのは文言の値だけ(契約⑩)。
 *
 * 本ファイルの持ち場:
 * - AC-51-1 全面走査で CJK ゼロ(契約①⑥(a)): src/(*.test.ts と __fixtures__ を
 *   除く .svelte / .ts 全ファイル)のコメントを落とした行に日本語(CJK)が無い
 * - AC-51-2 走査規則の自己検証(契約⑥(b)): codeLines の規則そのものを検証
 * - AC-51-5 未保存確認ダイアログ(edit-guard)の文言の値固定と2段の役割分担
 * - AC-51-6 波形の縮退文言テーブル(各6件=解析中1+縮退5)の値固定・二重定義のまま
 * - AC-51-7 素材パネル(ProvenancePanel)の失敗9種・警告2種・区分テーブルの値固定
 * - AC-51-9 Rust 側の不変(acceptance_req35.rs の走査が居ることの存在確認。
 *   緑判定そのものは cargo test の持ち場)
 * - AC-51-10 依存不変(package.json の dependencies / devDependencies のキー固定)
 *
 * AC-51-3 / AC-51-4(AudioViewer / VideoViewer のアクセシブル名の値固定)は
 * component プロジェクトの src/components/ui-language.wiring.test.ts の持ち場。
 * AC-51-8(既存3ファイルの要件側更新=契約⑦)の実体は AudioViewer.wiring.test.ts
 * 20箇所・VideoViewer.wiring.test.ts 7箇所・mermaid-mounter.test.ts 2箇所の
 * 英語化済みクエリが緑になること(フルスイート)。本ファイルは「更新済みで
 * 日本語クエリへ戻っていない」ことだけを走査で足す。
 *
 * ## 走査規則(契約⑥(b)。AC-51-2 が固定する)
 * - 行内の最初の `//` 以降を落とす
 * - ブロックコメント(スラッシュ+アスタリスクの対)と `<!-- ... -->` は複数行に跨って落とす(閉じの後のコードは残す)
 * - **文字列リテラル・正規表現リテラルの追跡はしない**。文字列中の `//` `/*` も
 *   切り落とされるが、これは検知を緩める方向にしか働かない(コメント外の日本語を
 *   誤検知しない)。文字列追跡をしないのは意図的 ―― 起案時のプロトタイプで
 *   文字列状態を追う実装は file-type.ts の正規表現リテラル /[&<>"']/g の引用符で
 *   状態機械が壊れ、日本語コメント22行を誤検知した(2026-09-11 実測)。正しく
 *   扱うには字句解析器=依存追加(契約④違反)になる。要件#35 AC-35-8 と同じ根拠
 *
 * ## 文言の設計判断(契約⑨=本テスト作成の周回で確定)
 * 用語は macOS 標準(#35 の Reveal in Finder / Copy Path の家風)。ボタンは
 * Title Case・本文は sentence case。gate で由谷が文言 NG とした場合は要件側で
 * 文言を確定してから acceptance を更新する(事前承認済みの脱出口)。
 *
 * ## 人間ゲート(acceptance/acceptance.md 要件#51 ①〜⑦)
 * 実機で日本語が見えないこと・英語文言の妥当性・読み上げの自然さ・レイアウト。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';

// edit-guard は plugin-dialog / save-document / window-state ストアを巻き込むので
// モジュールモックで切る(document-edit.acceptance.test.ts と同じ家風)。
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));
vi.mock('$lib/save-document', () => ({ saveDocument: vi.fn() }));
vi.mock('../stores/window-state.svelte', () => ({ windowState: {} }));

import { ask } from '@tauri-apps/plugin-dialog';
import {
	UNSAVED_TITLE,
	UNSAVED_PROCEED_MESSAGE,
	UNSAVED_SAVE_MESSAGE,
	askUnsavedChoice,
} from './edit-guard';
import { waveformBandNote } from './audio-waveform';
import { audioWaveformNote } from './audio-viewing';
import type { WaveformResult } from './audio-waveform';

const askMock = ask as unknown as Mock<(message: string, options?: Record<string, unknown>) => Promise<boolean>>;

const SRC_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(__dirname, '../..');

/**
 * 日本語(CJK)の検知(要件#35 と同じ定義): CJK 記号・句読点(U+3000–303F)・
 * かな(U+3040–30FF)・CJK 統合漢字(U+4E00–9FFF)・全角形(U+FF00–FFEF)。
 * 「〜」(U+301C)は U+3000–303F に含まれる=置換対象。
 * "…"(U+2026)・"→"(U+2192)・"⚠"(U+26A0)は英語 UI でも使う記号なので対象外。
 */
const CJK_PATTERN = /[　-〿぀-ヿ一-鿿＀-￯]/;

type CodeLine = { line: number; text: string };

/**
 * コメントを落としたコード行(契約⑥(b)の行ベース規則)。
 * 規則そのものは AC-51-2 が検証する。文字列追跡はしない(冒頭 doc 参照)。
 */
function codeLines(source: string): CodeLine[] {
	const out: CodeLine[] = [];
	/** いま開いている複数行コメントの閉じ記号(null =コメント外)。 */
	let closing: '*/' | '-->' | null = null;
	const lines = source.split('\n');
	for (let i = 0; i < lines.length; i++) {
		let rest = lines[i]!;
		let code = '';
		while (rest.length > 0) {
			if (closing !== null) {
				const close = rest.indexOf(closing);
				if (close === -1) {
					rest = '';
					break;
				}
				rest = rest.slice(close + closing.length);
				closing = null;
				continue;
			}
			const openers = [
				{ at: rest.indexOf('//'), kind: 'line' as const },
				{ at: rest.indexOf('/*'), kind: 'block' as const },
				{ at: rest.indexOf('<!--'), kind: 'html' as const },
			]
				.filter((o) => o.at !== -1)
				.sort((a, b) => a.at - b.at);
			if (openers.length === 0) {
				code += rest;
				break;
			}
			const first = openers[0]!;
			code += rest.slice(0, first.at);
			if (first.kind === 'line') break;
			closing = first.kind === 'block' ? '*/' : '-->';
			rest = rest.slice(first.at + (first.kind === 'block' ? 2 : 4));
		}
		out.push({ line: i + 1, text: code });
	}
	return out;
}

/** 走査対象: src/ の .svelte / .ts 全ファイル(*.test.ts と __fixtures__ を除く)。 */
function scanTargets(): string[] {
	const entries = readdirSync(SRC_ROOT, { recursive: true, encoding: 'utf-8' });
	return entries
		.map((p) => p.split(sep).join('/'))
		.filter((p) => (p.endsWith('.svelte') || p.endsWith('.ts')) && !p.endsWith('.test.ts') && !p.endsWith('.spec.ts') && !p.includes('__fixtures__'))
		.sort();
}

// ---------------------------------------------------------------------------
// AC-51-1 — 全面走査で CJK ゼロ(契約①⑥(a))
// ---------------------------------------------------------------------------

describe('AC-51-1: src/ のコード行(コメント除く)に日本語(CJK)が無い', () => {
	test('走査対象が空でない(走査自体の生存確認=全部除外して緑、への退化を防ぐ)', () => {
		const targets = scanTargets();
		expect(targets.length).toBeGreaterThan(20);
		// 代表ファイルが対象に居ること(除外規則の書き間違いで消えていないこと)。
		expect(targets).toContain('components/AudioViewer.svelte');
		expect(targets).toContain('lib/edit-guard.ts');
		expect(targets).toContain('routes/+page.svelte');
		// テストとフィクスチャは対象外(契約②)。
		expect(targets.some((t) => t.endsWith('.test.ts'))).toBe(false);
		expect(targets.some((t) => t.includes('__fixtures__'))).toBe(false);
	});

	test('全ファイルのコード行に CJK が1件も無い(失敗時はファイル別に件数と行を列挙)', () => {
		const sections: string[] = [];
		let total = 0;
		for (const file of scanTargets()) {
			const source = readFileSync(resolve(SRC_ROOT, file), 'utf-8');
			const raw = source.split('\n');
			const hits = codeLines(source).filter((l) => CJK_PATTERN.test(l.text));
			if (hits.length === 0) continue;
			total += hits.length;
			const head = hits
				.slice(0, 5)
				.map((h) => `  L${h.line}: ${(raw[h.line - 1] ?? '').trim()}`);
			const more = hits.length > 5 ? [`  …ほか ${hits.length - 5} 行`] : [];
			sections.push([`src/${file}(${hits.length} 行)`, ...head, ...more].join('\n'));
		}
		const report =
			sections.length === 0
				? ''
				: `コード行(コメント除く)に日本語が残っている: ${sections.length} ファイル・計 ${total} 行\n${sections.join('\n')}`;
		expect(report).toBe('');
	});
});

// ---------------------------------------------------------------------------
// AC-51-2 — 走査規則の自己検証(契約⑥(b))
// ---------------------------------------------------------------------------

describe('AC-51-2: codeLines の規則(コメントは落とす・コードは落とさない)', () => {
	const joined = (source: string) => codeLines(source).map((l) => l.text).join('\n');

	test('行コメント: 最初の // 以降を落とす', () => {
		expect(joined('// 日本語コメント')).not.toMatch(CJK_PATTERN);
	});

	test('行コメント: コード部分は残す(code(); // 日本語)', () => {
		const result = joined("code(); // 日本語");
		expect(result).toContain('code();');
		expect(result).not.toMatch(CJK_PATTERN);
	});

	test('ブロックコメント /* */ は複数行に跨って落とし、閉じの後のコードは残す', () => {
		const result = joined('before(); /* 一行目\n二行目の日本語\n三行目 */ after();');
		expect(result).toContain('before();');
		expect(result).toContain('after();');
		expect(result).not.toMatch(CJK_PATTERN);
	});

	test('HTML コメント <!-- --> は複数行に跨って落とす(.svelte のマークアップ)', () => {
		const result = joined('<div>\n<!-- 説明の\n日本語 -->\n<span>ok</span>\n</div>');
		expect(result).toContain('<span>ok</span>');
		expect(result).not.toMatch(CJK_PATTERN);
	});

	test("文字列リテラルは落とさない(const s = '日本語'; は検知対象のまま)", () => {
		// 規則が「全部落とす」実装に退化していたらここが赤になる。
		expect(joined("const s = '日本語';")).toMatch(CJK_PATTERN);
	});

	test('コードだけの行はそのまま残る(空へ潰していない)', () => {
		expect(joined('const n = 1;')).toBe('const n = 1;');
	});
});

// ---------------------------------------------------------------------------
// AC-51-5 — 未保存確認ダイアログの文言(契約①)と2段の役割分担(契約⑩)
// ---------------------------------------------------------------------------

describe('AC-51-5: edit-guard の未保存確認ダイアログは英語の固定値・2段の役割分担は不変', () => {
	beforeEach(() => {
		askMock.mockReset();
	});

	test('題と2段のメッセージの値固定', () => {
		expect(UNSAVED_TITLE).toBe('Unsaved Changes');
		expect(UNSAVED_PROCEED_MESSAGE).toBe(
			'Your edits have not been saved yet. Do you want to continue?',
		);
		expect(UNSAVED_SAVE_MESSAGE).toBe('Do you want to save your changes before continuing?');
	});

	test("1枚目(進む/やめる)のボタンは Continue / Cancel・題とメッセージが固定値で渡る", async () => {
		askMock.mockResolvedValueOnce(false);

		const choice = await askUnsavedChoice(true);

		expect(choice).toBe('cancel');
		expect(askMock).toHaveBeenCalledTimes(1);
		const [message, options] = askMock.mock.calls[0]!;
		expect(message).toBe(UNSAVED_PROCEED_MESSAGE);
		expect(options?.['title']).toBe(UNSAVED_TITLE);
		expect(options?.['okLabel']).toBe('Continue');
		expect(options?.['cancelLabel']).toBe('Cancel');
	});

	test("2枚目(保存/破棄)のボタンは Save / Don't Save(macOS 標準用語)", async () => {
		askMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

		const choice = await askUnsavedChoice(true);

		expect(choice).toBe('save');
		expect(askMock).toHaveBeenCalledTimes(2);
		const [message, options] = askMock.mock.calls[1]!;
		expect(message).toBe(UNSAVED_SAVE_MESSAGE);
		expect(options?.['title']).toBe(UNSAVED_TITLE);
		expect(options?.['okLabel']).toBe('Save');
		expect(options?.['cancelLabel']).toBe("Don't Save");
	});

	test('役割分担の不変: 2枚目で破棄を選ぶと discard・dirty でなければ何も聞かず discard', async () => {
		askMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		expect(await askUnsavedChoice(true)).toBe('discard');
		expect(askMock).toHaveBeenCalledTimes(2);

		askMock.mockClear();
		expect(await askUnsavedChoice(false)).toBe('discard');
		expect(askMock).not.toHaveBeenCalled();
	});

	test('ダイアログへ渡る文字列のどこにも日本語(CJK)が無い', async () => {
		askMock.mockResolvedValue(true);
		await askUnsavedChoice(true);
		for (const [message, options] of askMock.mock.calls) {
			expect(message).not.toMatch(CJK_PATTERN);
			for (const value of Object.values(options ?? {})) {
				if (typeof value === 'string') expect(value).not.toMatch(CJK_PATTERN);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// AC-51-6 — 波形の縮退文言テーブル(契約①⑧)
// ---------------------------------------------------------------------------

/** ready 以外の5状態(テーブルの鍵)。型が変われば型検査がここで咎める。 */
const DEGRADED_STATES: Exclude<WaveformResult['state'], 'ready'>[] = [
	'no-audio',
	'too-large',
	'unreadable',
	'unsupported-codec',
	'decode-failed',
];

describe('AC-51-6: 縮退文言テーブルは各6件(解析中1+縮退5)が英語・非空・相異なる・二重定義のまま', () => {
	// テーブルはモジュール私有なので公開関数(waveformBandNote / audioWaveformNote)
	// 越しに全状態の値を引く ―― 実 UI が受け取る値そのものを固定する。
	const videoNotes = new Map<string, string>([
		['analyzing', waveformBandNote(null, true) ?? ''],
		...DEGRADED_STATES.map(
			(state): [string, string] => [state, waveformBandNote({ state } as WaveformResult, false) ?? ''],
		),
	]);
	const audioNotes = new Map<string, string>([
		['analyzing', audioWaveformNote(null, true) ?? ''],
		...DEGRADED_STATES.map(
			(state): [string, string] => [state, audioWaveformNote({ state } as WaveformResult, false) ?? ''],
		),
	]);

	test('動画側(WAVEFORM_DEGRADED_NOTES+解析中)の6件の値固定', () => {
		expect(Object.fromEntries(videoNotes)).toEqual({
			analyzing: 'Analyzing audio…',
			'no-audio': 'This video has no audio track',
			'too-large': 'The file is too large to build a waveform',
			unreadable: 'Could not read the audio',
			'unsupported-codec': 'Waveforms are not available for this audio codec',
			'decode-failed': 'Could not decode the audio',
		});
	});

	test('音声側(AUDIO_WAVEFORM_DEGRADED_NOTES+解析中)の6件の値固定', () => {
		expect(Object.fromEntries(audioNotes)).toEqual({
			analyzing: 'Analyzing audio…',
			'no-audio': 'Could not read audio from this file',
			'too-large': 'The file is too large to build a waveform',
			unreadable: 'Could not read this audio',
			'unsupported-codec': 'Waveforms are not available for this audio codec',
			'decode-failed': 'Could not decode this audio',
		});
	});

	test('各6件が非空・CJK なし・テーブル内で互いに相異なる', () => {
		for (const notes of [videoNotes, audioNotes]) {
			const values = [...notes.values()];
			expect(values).toHaveLength(6);
			for (const value of values) {
				expect(value.length).toBeGreaterThan(0);
				expect(value).not.toMatch(CJK_PATTERN);
			}
			expect(new Set(values).size).toBe(6);
		}
	});

	test('二重定義の意味が生きている: no-audio の語は動画と音声で違う(契約⑧の理由)', () => {
		expect(videoNotes.get('no-audio')).not.toBe(audioNotes.get('no-audio'));
	});

	test('統合されていない(契約⑧): audio-viewing.ts は自前のテーブルを持ち、動画側を再輸出していない', () => {
		const source = readFileSync(resolve(SRC_ROOT, 'lib/audio-viewing.ts'), 'utf-8');
		// 自前定義が居る。
		expect(source).toMatch(/const AUDIO_WAVEFORM_DEGRADED_NOTES\b/);
		// 動画側のテーブルや文言関数を import / re-export していない
		// (型 WaveformResult の import と、コメント中の言及は従来どおり=判定対象外)。
		expect(source).not.toMatch(/import[^;]*\bWAVEFORM_DEGRADED_NOTES\b[^;]*from/);
		expect(source).not.toMatch(/import[^;]*\bwaveformBandNote\b[^;]*from/);
		expect(source).not.toMatch(/export\s*\{[^}]*\}\s*from\s*'\.\/audio-waveform'/);
	});
});

// ---------------------------------------------------------------------------
// AC-51-7 — 素材パネル(ProvenancePanel)の文言(契約①)
// ---------------------------------------------------------------------------

/**
 * 読み込み失敗9種(縮退の説明文)。absent だけ動的(探したサイドカー名を挟む)
 * なので前後の固定部で判定する。値の妥当性は人間ゲート。
 */
const PROVENANCE_NOTICES = [
	'Loading the provenance map…',
	'This video has no provenance map (looked for ',
	'Could not read the provenance map.',
	'The provenance map is too large to read (limit 8MB).',
	'The provenance map is not valid JSON.',
	'This file is not a provenance map (vedit-map).',
	'This provenance map uses a newer format. This version of Vellis cannot read it.',
	'The provenance map is malformed (a required field is missing or has the wrong type).',
	'The provenance map is inconsistent (segments do not cover the whole output without gaps).',
] as const;

const PROVENANCE_WARNINGS = [
	'The map refers to a different video name than the one that is open. It may belong to another video.',
	'The map duration differs from the actual video duration by more than 0.05 seconds. The map may be from before the video was rebuilt.',
] as const;

describe('AC-51-7: ProvenancePanel の失敗9種・警告2種・区分テーブルが英語(ソース走査で値固定)', () => {
	const source = readFileSync(resolve(SRC_ROOT, 'components/ProvenancePanel.svelte'), 'utf-8');

	test('読み込み失敗9種の英語文言がソースに居る(すべて相異なる)', () => {
		expect(new Set(PROVENANCE_NOTICES).size).toBe(9);
		for (const notice of PROVENANCE_NOTICES) {
			expect(source, `notice が見つからない: ${notice}`).toContain(notice);
		}
	});

	test('警告2種(WARNING_TEXT)の英語文言がソースに居る(相異なる)', () => {
		expect(new Set(PROVENANCE_WARNINGS).size).toBe(2);
		for (const warning of PROVENANCE_WARNINGS) {
			expect(source, `warning が見つからない: ${warning}`).toContain(warning);
		}
	});

	test('区分テーブル(ROLE_TEXT / OVERLAY_KIND_TEXT)の値固定', () => {
		// transition の2役(消えていく側/現れる側)。
		expect(source).toContain("'Fading out'");
		expect(source).toContain("'Fading in'");
		// オーバーレイの3種(画像/動画/テキスト)。
		expect(source).toContain("'Image'");
		expect(source).toContain("'Video'");
		expect(source).toContain("'Text'");
	});

	test('導線は #35 の家風と同じ語(Reveal in Finder / Copy Path)', () => {
		expect(source).toContain('Reveal in Finder');
		expect(source).toContain('Copy Path');
	});

	test('「〜」(U+301C)がコード行に無い(時刻範囲の区切りは英語表記へ)', () => {
		const hits = codeLines(source).filter((l) => l.text.includes('〜'));
		expect(hits.map((h) => h.line)).toEqual([]);
	});

	test('コード行(コメント除く)に CJK が無い(AC-51-1 の個別先行=失敗を早く読める形)', () => {
		const hits = codeLines(source).filter((l) => CJK_PATTERN.test(l.text));
		expect(hits.map((h) => `L${h.line}: ${h.text.trim()}`)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-51-8 — 既存3ファイルの要件側更新(契約⑦)が日本語クエリへ戻っていないこと
// ---------------------------------------------------------------------------

describe('AC-51-8: 契約⑦で更新した3ファイルのクエリ・部分一致が英語のまま(全件緑はフルスイートの持ち場)', () => {
	// テスト名・assert の補足メッセージの日本語は家風のまま残る(契約②)。
	// ここで見るのは UI 文言の値を固定している箇所 ―― アクセシブル名クエリと
	// UI 文言の部分一致 ―― だけ。
	const files = [
		'components/AudioViewer.wiring.test.ts',
		'components/VideoViewer.wiring.test.ts',
		'lib/mermaid-mounter.test.ts',
	];

	test('getByRole / queryByRole の name: に CJK が無い', () => {
		for (const file of files) {
			const source = readFileSync(resolve(SRC_ROOT, file), 'utf-8');
			for (const match of source.matchAll(/name:\s*'([^']*)'/g)) {
				expect(match[1], `${file} の name クエリが日本語のまま: ${match[0]}`).not.toMatch(
					CJK_PATTERN,
				);
			}
		}
	});

	test('mermaid-mounter.test.ts の失敗表示の部分一致が英語(レンダー失敗・空ブロック)', () => {
		const source = readFileSync(resolve(SRC_ROOT, 'lib/mermaid-mounter.test.ts'), 'utf-8');
		expect(source).toContain("'Failed to render'");
		expect(source).toContain("'empty'");
		expect(source).not.toContain('レンダーに失敗しました');
	});
});

// ---------------------------------------------------------------------------
// AC-51-9 — Rust 側の不変(契約③)
// ---------------------------------------------------------------------------

describe('AC-51-9: Rust 側は変更なし(menu.rs の CJK 走査が残っている=緑判定は cargo test)', () => {
	test('acceptance_req35.rs に menu.rs のソース走査が居る', () => {
		const source = readFileSync(
			resolve(REPO_ROOT, 'src-tauri/tests/acceptance_req35.rs'),
			'utf-8',
		);
		expect(source).toContain('fn menu_rs_code_lines_contain_no_cjk()');
		expect(source).toContain('include_str!("../src/menu.rs")');
	});
});

// ---------------------------------------------------------------------------
// AC-51-10 — 依存不変(契約④)。フルスイート緑と挙動不変(契約⑩)は test-runner の持ち場
// ---------------------------------------------------------------------------

/** 要件#51 登録時点の依存(要件#49/#52 の AC と同じ固定方式)。 */
const RUNTIME_DEPS_AT_REQ51 = [
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

const DEV_DEPS_AT_REQ51 = [
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

describe('AC-51-10: 依存追加ゼロ(契約④=i18n 機構を入れていない)', () => {
	test('package.json の依存キーが登録時点と同一(runtime / dev とも)', () => {
		const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		expect(Object.keys(pkg.dependencies).sort()).toEqual([...RUNTIME_DEPS_AT_REQ51].sort());
		expect(Object.keys(pkg.devDependencies).sort()).toEqual([...DEV_DEPS_AT_REQ51].sort());
	});
});
