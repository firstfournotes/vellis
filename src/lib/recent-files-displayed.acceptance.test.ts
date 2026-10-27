/**
 * 要件#64 追補f の受け入れテスト(docs/requirements/req-64.md 追補f・Issue #717)— フロントの純関数と command
 * 「開けなかったファイルを Recent Files に載せない」
 *
 * バイナリの経路(画像・PDF・動画・音声・3D)は Rust の `open_in_window` では記録せず、ビューアが
 * 最初に表示できた時点でフロントが command `record_displayed_file` で記録を頼む(契約1・2)。
 * `+page.svelte` はその窓でその文書を開くたびに**高々 1 回**呼ぶ(契約4)。「1 回だけ」の判定は
 * ここで固定する純関数 `shouldRecordDisplayedOnce` に置く(AC-64-追f (e) の「可能なら純関数にして表で」)。
 *
 * 判定範囲(本ファイル= unit プロジェクト):
 * - AC-64-追f(e) 純関数の表: 初めて表示できた → 真/同じ文書の版の更新・再描画(既に記録した URI)→ 偽/
 *   表示できる前に別の文書へ移った(表示した URI ≠ 今の文書)→ 偽/文書が無い → 偽/別の文書を
 *   経て戻ってきた(記録済みの URI が別物)→ 真。比較は文字列の完全一致
 * - AC-64-追f(e) command: `recordDisplayedFile(uri)` は `invoke('record_displayed_file', { uri })` を 1 回・
 *   失敗しても reject しない(best-effort= 表示の成功の経路から alert を出さない。`loadRecentFiles` と同じ)
 * - command 名の文字列は `$lib/recent-files` だけが持つ(`+page.svelte` 等は定数と関数を通す=
 *   `LIST_RECENT_FILES_COMMAND` と同じ整理)
 * 配線(5 つのビューアの `onDisplayed`・`+page.svelte`・区画の読み直し)は
 * src/components/recent-files-displayed.wiring.test.ts と src/components/ModelViewer.displayed.wiring.test.ts、
 * Rust 側は src-tauri/tests/acceptance_req64f.rs。
 *
 * ## 確定契約(公開 API・implementer はこれに従う=test-writer 決定 2026-10-25)
 *
 * ```ts
 * // --- src/lib/recent-files.ts に追加(既存の export は無改変)---
 * /** Tauri command 名(追補f 契約2)。invoke の第 1 引数。 * /
 * export const RECORD_DISPLAYED_FILE_COMMAND = 'record_displayed_file';
 *
 * // 「1 回開くごとに 1 回だけ」の判定(契約4)。+page.svelte は
 * //   `let displayedRecordedUri: string | null`(この文書で既に記録を頼んだ URI。
 * //   `windowState.currentDocument?.uri` が変わったら null に戻す)
 * // を持ち、ビューアの `onDisplayed` が来たら
 * //   shouldRecordDisplayedOnce(displayedRecordedUri, displayedUri, windowState.currentDocument?.uri ?? null)
 * // が真のときだけ `displayedRecordedUri = displayedUri` → `await recordDisplayedFile(displayedUri)` →
 * // `recentFilesSection?.refresh()`(契約5)。
 * //   真 ⇔ displayedUri === currentUri && displayedUri !== recordedUri
 * export function shouldRecordDisplayedOnce(
 *   recordedUri: string | null,   // この文書で既に記録を頼んだ URI(無ければ null)
 *   displayedUri: string,         // ビューアが表示できた文書の URI(ビューアに渡した uri)
 *   currentUri: string | null     // いま開いている文書の URI(無ければ null)
 * ): boolean;
 *
 * // 記録を頼む(契約2)。`invoke(RECORD_DISPLAYED_FILE_COMMAND, { uri })`。失敗は飲んで resolve
 * // (記録の失敗で表示を妨げない・alert も出さない)。
 * export async function recordDisplayedFile(uri: string): Promise<void>;
 *
 * // --- src/components/RecentFiles.svelte に追加(`reveal()` と同じ bind:this 経由の export)---
 * // 一覧を読み直す合図(契約5・10)。開いているときだけ読む(閉じていれば何もしない=開いたときに読む)。
 * export function refresh(): void;   // async でもよい
 * ```
 *
 * ## 実装前の見立て
 * - `RECORD_DISPLAYED_FILE_COMMAND`・`shouldRecordDisplayedOnce`・`recordDisplayedFile` が無いので
 *   import で赤(型検査 `pnpm check` も赤)。command 名の走査は、今はどこにも無いので
 *   「recent-files.ts に 1 回」の判定で赤
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import {
	CLEAR_RECENT_FILES_COMMAND,
	LIST_RECENT_FILES_COMMAND,
	RECORD_DISPLAYED_FILE_COMMAND,
	recordDisplayedFile,
	shouldRecordDisplayedOnce,
} from '$lib/recent-files';

const invokeMock = vi.mocked(invoke);

const A = 'file:///Users/x/notes/img/photo.png';
const B = 'file:///Users/x/notes/docs/plan.pdf';

beforeEach(() => {
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
});

describe('AC-64-追f(e) command 名', () => {
	it('RECORD_DISPLAYED_FILE_COMMAND は record_displayed_file(list / clear と別物)', () => {
		expect(RECORD_DISPLAYED_FILE_COMMAND).toBe('record_displayed_file');
		expect(RECORD_DISPLAYED_FILE_COMMAND).not.toBe(LIST_RECENT_FILES_COMMAND);
		expect(RECORD_DISPLAYED_FILE_COMMAND).not.toBe(CLEAR_RECENT_FILES_COMMAND);
	});

	it('command 名の文字列を持つのは src/lib/recent-files.ts だけ(+page.svelte やビューアは定数と関数を通す)', () => {
		const root = resolve(__dirname, '..');
		const holders: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) {
					walk(path);
					continue;
				}
				if (!/\.(ts|svelte)$/.test(name) || /\.(test|spec)\.ts$/.test(name)) continue;
				if (readFileSync(path, 'utf-8').includes("'record_displayed_file'")) {
					holders.push(path.slice(root.length + 1));
				}
			}
		};
		walk(root);
		expect(holders).toEqual(['lib/recent-files.ts']);
	});
});

describe('AC-64-追f(e) shouldRecordDisplayedOnce の表(契約4=1 回開くごとに高々 1 回)', () => {
	it('初めて表示できた(まだ記録していない・今の文書と同じ)→ 真', () => {
		expect(shouldRecordDisplayedOnce(null, A, A)).toBe(true);
	});

	it('同じ文書の版の更新・再描画(既に記録した URI)→ 偽(外部変更の反映では記録しない=契約1)', () => {
		expect(shouldRecordDisplayedOnce(A, A, A)).toBe(false);
	});

	it('表示できる前に別の文書へ移った(表示した URI ≠ 今の文書)→ 偽', () => {
		expect(shouldRecordDisplayedOnce(null, A, B)).toBe(false);
		expect(shouldRecordDisplayedOnce(B, A, B)).toBe(false);
	});

	it('今の文書が無い → 偽', () => {
		expect(shouldRecordDisplayedOnce(null, A, null)).toBe(false);
		expect(shouldRecordDisplayedOnce(A, A, null)).toBe(false);
	});

	it('別の文書を経て戻ってきた(記録済みの URI が別物)→ 真(開くたびに 1 回)', () => {
		expect(shouldRecordDisplayedOnce(B, A, A)).toBe(true);
	});

	it('比較は文字列の完全一致(版の付いた src・大文字小文字・末尾の差は別物)', () => {
		expect(shouldRecordDisplayedOnce(null, A, `${A}?v=1`)).toBe(false);
		expect(shouldRecordDisplayedOnce(`${A}?v=1`, A, A)).toBe(true);
		expect(shouldRecordDisplayedOnce(null, A, A.replace('photo', 'Photo'))).toBe(false);
		expect(shouldRecordDisplayedOnce(null, A, `${A}/`)).toBe(false);
	});

	it('純関数(同じ入力で同じ答え・invoke に触れない)', () => {
		for (let i = 0; i < 3; i++) {
			expect(shouldRecordDisplayedOnce(null, A, A)).toBe(true);
			expect(shouldRecordDisplayedOnce(A, A, A)).toBe(false);
		}
		expect(invokeMock).not.toHaveBeenCalled();
	});
});

/**
 * 改訂 f-2 の 3(2026-10-25・由谷の事後確認): 設計どおりのプレースホルダ(mkv・avi・ssh の PDF・動画・音声)でも
 * ビューアが `onDisplayed` を呼ぶようになったが、契約4(1 回開くごとに高々 1 回)はそのまま当てる。
 * `+page.svelte` の控え(記録を頼んだ URI)の遷移を、ビューアが呼ぶ順に表で追う。
 */
describe('AC-64-追f(e) f-2 の 3: プレースホルダにも契約4 をそのまま当てる(表)', () => {
	const MKV = 'file:///Users/x/notes/movies/clip.mkv';
	const SSH_PDF = 'ssh://alice@host:22/remote/plan.pdf';
	const SSH_WAV = 'ssh://alice@host:22/remote/take.wav';

	it('mkv を開く → プレースホルダを出した時点で頼む → 版の更新でビューアが作り直されてまた呼んでも頼まない', () => {
		let recorded: string | null = null;
		// 1 回目(開いた直後にプレースホルダが出た)。
		expect(shouldRecordDisplayedOnce(recorded, MKV, MKV)).toBe(true);
		recorded = MKV;
		// binary_file_changed の版の更新 → ビューアが作り直されてもう一度 onDisplayed → 偽。
		expect(shouldRecordDisplayedOnce(recorded, MKV, MKV)).toBe(false);
		expect(shouldRecordDisplayedOnce(recorded, MKV, MKV)).toBe(false);
	});

	it('ssh の PDF・音声も同じ(開くたびに 1 回・別の文書を経て戻れば、また 1 回)', () => {
		let recorded: string | null = null;
		expect(shouldRecordDisplayedOnce(recorded, SSH_PDF, SSH_PDF)).toBe(true);
		recorded = SSH_PDF;
		expect(shouldRecordDisplayedOnce(recorded, SSH_PDF, SSH_PDF)).toBe(false);

		// 別の文書(ssh の音声)へ移る: 今の文書が変わった時点で控えは null に戻る(+page の effect)。
		recorded = null;
		expect(shouldRecordDisplayedOnce(recorded, SSH_WAV, SSH_WAV)).toBe(true);
		recorded = SSH_WAV;
		expect(shouldRecordDisplayedOnce(recorded, SSH_WAV, SSH_WAV)).toBe(false);

		// 元の PDF へ戻る: 控えは null → また 1 回。
		recorded = null;
		expect(shouldRecordDisplayedOnce(recorded, SSH_PDF, SSH_PDF)).toBe(true);
	});

	it('プレースホルダを出す前に別の文書へ移っていたら頼まない(遅れて来た onDisplayed)', () => {
		expect(shouldRecordDisplayedOnce(null, MKV, SSH_PDF)).toBe(false);
		expect(shouldRecordDisplayedOnce(SSH_PDF, MKV, SSH_PDF)).toBe(false);
	});
});

describe('AC-64-追f(e) recordDisplayedFile(契約2)', () => {
	it("invoke('record_displayed_file', { uri }) を 1 回呼び、resolve する", async () => {
		await expect(recordDisplayedFile(A)).resolves.toBeUndefined();
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock).toHaveBeenCalledWith(RECORD_DISPLAYED_FILE_COMMAND, { uri: A });
	});

	it('command が失敗しても reject しない(best-effort=表示の成功の経路から alert を出さない)', async () => {
		invokeMock.mockRejectedValueOnce('config dir unavailable');
		await expect(recordDisplayedFile(A)).resolves.toBeUndefined();
		expect(invokeMock).toHaveBeenCalledTimes(1);
	});

	it('引数は uri だけ(root や label は Rust が呼んだ窓から引く)', async () => {
		await recordDisplayedFile(B);
		const [, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
		expect(Object.keys(args)).toEqual(['uri']);
		expect(args.uri).toBe(B);
	});
});
