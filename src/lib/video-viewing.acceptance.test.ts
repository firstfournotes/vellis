/**
 * 要件#28 の受け入れテスト(requirements.md #28)
 * 「動画ファイル(mp4/mov/webm)を開いたらアプリ内でインライン再生できる。
 *  非対応コンテナ(mkv/avi)はプレースホルダから「既定アプリで開く」へ誘導する」
 *
 * 本ファイルの判定範囲: ①`video` 分類(契約①)②表示形態の一点判定=純関数 VM
 * (インライン可否・プレースホルダ種別・「既定アプリで開く」計画)③`<video src>` の
 * asset URI 変換 ④開く経路(要件#22 基盤の再利用=契約④)⑤`renderForDisplay` の
 * 表示ディスパッチ ⑥版数クエリによるキャッシュ破りの再利用 ⑦CSP の media-src(契約③)。
 *
 * ## 確定契約(implementer はこれに従う)
 *
 * 1. `detectFileType`(src/lib/file-type.ts): `FileType` に `'video'` を追加し、
 *    拡張子 mp4 / mov / webm / mkv / avi の5種(大文字小文字不問・最終セグメントの
 *    最後の拡張子)を `'video'` と判定する。5種は BINARY_EXTENSIONS から移動する。
 *    音声(mp3/wav/flac/m4a/ogg)は binary のまま(契約⑦=別要件)。
 *    既存分類(markdown/html/image/model3d/binary/text)は不変。
 * 2. `src/lib/video-viewing.ts`(新規・純関数 VM。image-viewing.ts の家風=DOM なし・
 *    判定を一点集約):
 *    - `videoViewMode(uri: string): VideoViewMode`
 *      `type VideoViewMode = 'inline' | 'unsupported-container' | 'remote'`
 *      インライン再生=拡張子∈{mp4,mov,webm} かつローカル(file スキーム)。
 *      mkv/avi ローカル=`'unsupported-container'`(非対応コンテナのプレースホルダ)。
 *      ssh リモートは拡張子によらず `'remote'`(契約⑥=従来どおりプレースホルダ。
 *      判別は URI スキームのみ)
 *    - `toVideoSrc(absoluteUri: string): string`
 *      `<video src>` に載せる `vellis-asset:` URI(= `toAssetUri`。toImageSrc と同じ流儀)
 *    - `planOpenVideoExternally(uri: string): { command: 'open_path'; path: string } | null`
 *      プレースホルダの「既定アプリで開く」実行計画(契約⑤=要件#19 の opener 再利用。
 *      path は context-menu.ts の pathForReveal と同じ URI→OS パス変換)。
 *      ssh は null=導線を出さない(要件#19 の disabled 前例踏襲)
 * 3. `readsAsText`(src/lib/image-viewing.ts): video は5拡張子すべて false —
 *    現行ロジックは video で true を返し open_document のテキスト読み経路へ
 *    誤流入するため(契約①後段)。
 * 4. `openCommandFor` / `openForDisplay`(src/lib/open-document.ts): video は
 *    `open_binary_document` を1回 invoke し解決値をそのまま返す(契約④=要件#22 の
 *    watch-only セッション。変更反映・削除追従が付随)。
 * 5. `restoreSnapshot`(src/lib/reload-state.ts): docUri が video なら
 *    `set_root` → `open_binary_document`(`open_document` は呼ばない)。
 *    要件#10 の reload 復元に動画も乗る(契約④付随)。
 * 6. `renderForDisplay`(src/lib/file-type.ts): video は本文を HTML に載せず、
 *    `DisplayResult.videoSrc`(= `toAssetUri(uri)`)を返す(model3d の modelSrc が
 *    雛形)。mkv/avi/ssh も video 分類なので videoSrc 経路に乗り、プレースホルダの
 *    出し分けは VM(videoViewMode)の持ち場。`videoSrc` の存在が VideoViewer.svelte
 *    を選ぶ合図(`srcdoc`→HtmlViewer・`imageSrc`→ImageViewer・`modelSrc`→ModelViewer
 *    と同じ流儀)。
 * 7. 変更追従のキャッシュ破りは要件#22 の `imageSrcWithVersion`(src/lib/image-watch.ts)
 *    をそのまま動画の src にも使う(binaryVersion の版数クエリ。別名は要らない)。
 * 8. CSP(src-tauri/tauri.conf.json): `media-src` ディレクティブを新設し
 *    `vellis-asset:` を許可する(契約③)。既存の img-src / connect-src の
 *    `vellis-asset:` は維持(既存表示の回帰ガード)。
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - VideoViewer.svelte: `<video src>` の表示・自動再生なし=クリック再生(契約②)・
 *   プレースホルダ UI と「既定アプリで開く」ボタンの配線。操作 UI は当初の
 *   ネイティブ `controls` から要件#37 契約⑤により自作コントロールバーへ全面置き換え
 *   (2026-08-30 再スコープ=要件#37 契約⑩の承認範囲。本ファイルのアサーションは不変。
 *   フレーム表示・コマ送りの受け入れは video-frame.acceptance.test.ts と
 *   src-tauri/tests/acceptance_req37.rs)
 * - +page.svelte の videoSrc 分岐・binary_file_changed / file_removed の listen が
 *   動画にも効くこと・版数リセット
 *
 * ## 人間ゲート候補(機械判定不能 → acceptance/acceptance.md)
 * - 実再生・シーク・mkv 誘導の見た目・AV1 の機種差(M3 未満は再生不可)・ProRes 可否
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import { pathForReveal } from './context-menu';
import { detectFileType, renderForDisplay } from './file-type';
import { imageSrcWithVersion } from './image-watch';
import { readsAsText } from './image-viewing';
import { openCommandFor, openForDisplay } from './open-document';
import { restoreSnapshot } from './reload-state';
import { toAssetUri } from './uri';
import { planOpenVideoExternally, toVideoSrc, videoViewMode } from './video-viewing';

const invokeMock = vi.mocked(invoke);

const ROOT = 'file:///Users/a/work';
const MP4 = `${ROOT}/movies/clip.mp4`;
const SSH_MP4 = 'ssh://alice@host:22/remote/clip.mp4';
const SSH_MKV = 'ssh://alice@host:22/remote/clip.mkv';

/** インライン再生対象(契約①前段)。 */
const INLINE_EXTENSIONS = ['mp4', 'mov', 'webm'] as const;
/** 非対応コンテナ=プレースホルダ対象(契約⑤)。 */
const UNSUPPORTED_EXTENSIONS = ['mkv', 'avi'] as const;
/** video 分類の全5拡張子(契約①=BINARY_EXTENSIONS から移動)。 */
const VIDEO_EXTENSIONS = [...INLINE_EXTENSIONS, ...UNSUPPORTED_EXTENSIONS];

beforeEach(() => {
	invokeMock.mockReset();
});

/** 名前→判定結果のレコードにして、失敗時にどの名前が外れたか見えるようにする */
function classify(names: string[]): Record<string, string> {
	return Object.fromEntries(names.map((n) => [n, detectFileType(n)]));
}

function expectAll(
	names: string[],
	expected: 'markdown' | 'html' | 'text' | 'binary' | 'image' | 'model3d' | 'video',
) {
	expect(classify(names)).toEqual(Object.fromEntries(names.map((n) => [n, expected])));
}

function invokedCommands(): string[] {
	return invokeMock.mock.calls.map((c) => c[0] as string);
}

// ---------------------------------------------------------------------------
// detectFileType — video 分類(要件#28 契約①)
// ---------------------------------------------------------------------------

describe('detectFileType — 動画5拡張子を video と判定する(要件#28 契約①)', () => {
	test('ベース名の mp4 / mov / webm / mkv / avi は video', () => {
		expectAll(
			VIDEO_EXTENSIONS.map((ext) => `clip.${ext}`),
			'video',
		);
	});

	test('大文字小文字を問わない', () => {
		expectAll(['CLIP.MP4', 'Movie.MOV', 'a.WebM', 'a.MKV', 'a.Avi'], 'video');
	});

	test('パス・file:// URI・ssh:// URI でも最終セグメントの拡張子で判定する(ssh も分類は video=プレースホルダ判定は VM の持ち場)', () => {
		expect(detectFileType('/tmp/screen.mov')).toBe('video');
		expect(detectFileType(MP4)).toBe('video');
		expect(detectFileType(SSH_MKV)).toBe('video');
	});

	test('最後の拡張子だけで判定する(既存の境界規則の継承)', () => {
		expect(detectFileType('clip.mp4.txt')).toBe('text');
		expect(detectFileType('notes.txt.mp4')).toBe('video');
		expect(detectFileType('backup.mkv.gz')).toBe('binary');
	});

	test('ディレクトリ名中の .mp4 を拡張子と誤認しない', () => {
		expect(detectFileType('file:///home/user.mp4/Makefile')).toBe('text');
	});

	test('音声ファイルは binary のまま(契約⑦=別要件に切り出し)', () => {
		expectAll(['song.mp3', 'take.wav', 'album.flac', 'voice.m4a', 'loop.ogg'], 'binary');
	});

	test('動画以外の既存 binary は不変(tiff / heic / zip / dmg)', () => {
		expectAll(['scan.tiff', 'scan.tif', 'iphone.heic', 'a.zip', 'disk.dmg'], 'binary');
	});

	test('既存分類は不変(markdown / html / image / model3d / text)', () => {
		expect(detectFileType('README.md')).toBe('markdown');
		expect(detectFileType('page.html')).toBe('html');
		expect(detectFileType('icon.svg')).toBe('image');
		expect(detectFileType('photo.png')).toBe('image');
		expect(detectFileType('part.stl')).toBe('model3d');
		expect(detectFileType('notes.txt')).toBe('text');
		expect(detectFileType('data.xyz')).toBe('text'); // 未知拡張子のフォールバックも不変
		expect(detectFileType('Makefile')).toBe('text');
	});
});

// ---------------------------------------------------------------------------
// videoViewMode — インライン可否とプレースホルダ種別の一点判定(契約②⑤⑥)
// ---------------------------------------------------------------------------

describe('videoViewMode — インライン可否とプレースホルダ種別(要件#28 契約②⑤⑥)', () => {
	test('ローカルの mp4 / mov / webm はインライン再生(inline)', () => {
		for (const ext of INLINE_EXTENSIONS) {
			expect(videoViewMode(`${ROOT}/movies/clip.${ext}`), `.${ext}`).toBe('inline');
		}
	});

	test('ローカルの mkv / avi は非対応コンテナのプレースホルダ(unsupported-container)', () => {
		for (const ext of UNSUPPORTED_EXTENSIONS) {
			expect(videoViewMode(`${ROOT}/movies/clip.${ext}`), `.${ext}`).toBe(
				'unsupported-container',
			);
		}
	});

	test('ssh リモートは全5拡張子とも remote(契約⑥=インライン対象外・従来どおりプレースホルダ)', () => {
		for (const ext of VIDEO_EXTENSIONS) {
			expect(videoViewMode(`ssh://alice@host:22/remote/clip.${ext}`), `.${ext}`).toBe('remote');
		}
	});

	test('リモート判別は URI スキームのみ(パス中の "ssh" では分岐しない)', () => {
		expect(videoViewMode(`${ROOT}/ssh/clip.mp4`)).toBe('inline');
	});
});

// ---------------------------------------------------------------------------
// toVideoSrc — <video src> 用の vellis-asset: URI(契約②)
// ---------------------------------------------------------------------------

describe('toVideoSrc — <video src> 用の vellis-asset: URI 構築(要件#28 契約②)', () => {
	test('ローカル絶対 URI を vellis-asset://local/… へ変換する(toAssetUri と同値)', () => {
		expect(toVideoSrc(MP4)).toBe('vellis-asset://local/Users/a/work/movies/clip.mp4');
		expect(toVideoSrc(MP4)).toBe(toAssetUri(MP4));
	});
});

// ---------------------------------------------------------------------------
// planOpenVideoExternally — 「既定アプリで開く」計画(契約⑤=要件#19 再利用)
// ---------------------------------------------------------------------------

describe('planOpenVideoExternally — プレースホルダの「既定アプリで開く」計画(要件#28 契約⑤)', () => {
	test('ローカルの mkv / avi は open_path 計画(要件#19 の opener 再利用・OS パス変換は pathForReveal と同値)', () => {
		for (const ext of UNSUPPORTED_EXTENSIONS) {
			const uri = `${ROOT}/movies/clip.${ext}`;
			expect(planOpenVideoExternally(uri), `.${ext}`).toEqual({
				command: 'open_path',
				path: `/Users/a/work/movies/clip.${ext}`,
			});
			expect(planOpenVideoExternally(uri)?.path, `.${ext}`).toBe(pathForReveal(uri));
		}
	});

	test('パーセントエンコードされたパスは復号した OS パスを渡す', () => {
		expect(planOpenVideoExternally('file:///movies/My%20Video.avi')).toEqual({
			command: 'open_path',
			path: '/movies/My Video.avi',
		});
	});

	test('ssh リモートは null=導線を出さない(要件#19 の disabled 前例踏襲)', () => {
		expect(planOpenVideoExternally(SSH_MKV)).toBeNull();
		expect(planOpenVideoExternally(SSH_MP4)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// readsAsText — video はテキスト読込を通さない(契約①後段)
// ---------------------------------------------------------------------------

describe('readsAsText — video は open_document のテキスト読み経路へ流さない(要件#28 契約①)', () => {
	test('5拡張子すべて false(ローカル・ssh とも)', () => {
		for (const ext of VIDEO_EXTENSIONS) {
			expect(readsAsText(`clip.${ext}`), `.${ext}`).toBe(false);
			expect(readsAsText(`${ROOT}/movies/clip.${ext}`), `file .${ext}`).toBe(false);
			expect(readsAsText(`ssh://alice@host:22/remote/clip.${ext}`), `ssh .${ext}`).toBe(false);
		}
	});

	test('既存の判定は不変(md/html/txt/svg=true・ラスタ/model3d=false)', () => {
		expect(readsAsText('README.md')).toBe(true);
		expect(readsAsText('report.html')).toBe(true);
		expect(readsAsText('notes.txt')).toBe(true);
		expect(readsAsText('icon.svg')).toBe(true);
		expect(readsAsText('photo.png')).toBe(false);
		expect(readsAsText('part.stl')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 経路選択 — video は open_binary_document(契約④=要件#22 基盤の再利用)
// ---------------------------------------------------------------------------

describe('経路選択 — video は watch-only セッションを張る(要件#28 契約④)', () => {
	test('openCommandFor: 5拡張子すべて open_binary_document', () => {
		for (const ext of VIDEO_EXTENSIONS) {
			expect(openCommandFor(`${ROOT}/movies/clip.${ext}`), `.${ext}`).toBe(
				'open_binary_document',
			);
		}
	});

	test('openCommandFor: 既存の振り分けは不変', () => {
		expect(openCommandFor(`${ROOT}/notes/plan.md`)).toBe('open_document');
		expect(openCommandFor(`${ROOT}/pics/diagram.svg`)).toBe('open_document');
		expect(openCommandFor(`${ROOT}/pics/photo.png`)).toBe('open_binary_document');
		expect(openCommandFor(`${ROOT}/models/part.stl`)).toBe('open_binary_document');
	});

	test('openForDisplay: 動画は open_binary_document を1回呼び、解決値をそのまま返す', async () => {
		const payload = { uri: MP4, content: '', modified: null };
		invokeMock.mockResolvedValue(payload);

		const res = await openForDisplay(MP4);

		expect(invokeMock.mock.calls).toEqual([['open_binary_document', { uri: MP4 }]]);
		expect(res).toBe(payload);
	});

	test('openForDisplay: invoke 失敗(ファイル消滅等)は reject を伝播する', async () => {
		const err = 'watch failed: no such file';
		invokeMock.mockRejectedValue(err);

		await expect(openForDisplay(MP4)).rejects.toBe(err);
	});
});

// ---------------------------------------------------------------------------
// restoreSnapshot — video の docUri も reload 復元に乗る(契約④付随)
// ---------------------------------------------------------------------------

describe('restoreSnapshot — video docUri の reload 復元(要件#28 契約④)', () => {
	const rootPayload = { root_uri: ROOT, entries: [], document_retained: false };
	const videoPayload = { uri: MP4, content: '', modified: null };
	const snapshot = { rootUri: ROOT, docUri: MP4, expandedDirs: [] };

	test('set_root → open_binary_document の順で呼び、document に解決値を返す', async () => {
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === 'set_root') return rootPayload;
			if (cmd === 'open_binary_document') return videoPayload;
			throw new Error(`unexpected command: ${cmd}`);
		});

		const res = await restoreSnapshot(snapshot);

		expect(invokedCommands()).toEqual(['set_root', 'open_binary_document']);
		expect(invokeMock.mock.calls[1]?.[1]).toEqual({ uri: MP4 });
		expect(res).toEqual({ ok: true, root: rootPayload, document: videoPayload });
	});

	test('open_document は呼ばない(テキスト読みで必ず失敗する経路を通さない)', async () => {
		invokeMock.mockResolvedValue(rootPayload);

		await restoreSnapshot(snapshot);

		expect(invokedCommands()).not.toContain('open_document');
	});
});

// ---------------------------------------------------------------------------
// 版数クエリ — imageSrcWithVersion を動画にもそのまま使う(要件#22 機構の再利用)
// ---------------------------------------------------------------------------

describe('版数クエリ — 動画の src にも要件#22 のキャッシュ破りがそのまま効く', () => {
	const SRC = 'vellis-asset://local/Users/a/work/movies/clip.mp4';

	test('版数0(初期表示)は素の URI のまま', () => {
		expect(imageSrcWithVersion(SRC, 0)).toBe(SRC);
	});

	test('版数1以上はクエリ(?)で別 URI・同じ版数は同じ src(決定的)', () => {
		const bumped = imageSrcWithVersion(SRC, 1);
		expect(bumped).not.toBe(SRC);
		expect(bumped.startsWith(`${SRC}?`)).toBe(true);
		expect(imageSrcWithVersion(SRC, 2)).not.toBe(bumped);
		expect(imageSrcWithVersion(SRC, 1)).toBe(bumped);
	});
});

// ---------------------------------------------------------------------------
// renderForDisplay — video は videoSrc で VideoViewer を選ぶ(契約②)
// ---------------------------------------------------------------------------

describe('renderForDisplay — video の表示ディスパッチ(要件#28 契約②)', () => {
	test('ローカル5拡張子すべて: videoSrc = vellis-asset URI・html は空・index は null', async () => {
		for (const ext of VIDEO_EXTENSIONS) {
			const uri = `${ROOT}/movies/clip.${ext}`;
			const res = await renderForDisplay(uri, '');
			expect(res.videoSrc, uri).toBe(toAssetUri(uri));
			expect(res.html, uri).toBe('');
			expect(res.index, uri).toBeNull();
			// 他のビューアの合図と排他(videoSrc の存在だけが VideoViewer を選ぶ)
			expect(res.srcdoc, uri).toBeUndefined();
			expect(res.imageSrc, uri).toBeUndefined();
			expect(res.modelSrc, uri).toBeUndefined();
		}
	});

	test('ssh 動画も videoSrc 経路に乗る(プレースホルダの出し分けは videoViewMode の持ち場)', async () => {
		const res = await renderForDisplay(SSH_MP4, '');
		expect(res.videoSrc).toBe(toAssetUri(SSH_MP4));
		expect(res.html).toBe('');
		expect(res.index).toBeNull();
	});

	test('video 以外に videoSrc は付かない(既存経路の不変)', async () => {
		const image = await renderForDisplay(`${ROOT}/pics/photo.png`, '');
		expect(image.videoSrc).toBeUndefined();
		expect(image.imageSrc).toBe(toAssetUri(`${ROOT}/pics/photo.png`));

		const model = await renderForDisplay(`${ROOT}/models/part.stl`, '');
		expect(model.videoSrc).toBeUndefined();
		expect(model.modelSrc).toBe(toAssetUri(`${ROOT}/models/part.stl`));

		const text = await renderForDisplay(`${ROOT}/notes/memo.txt`, 'hello');
		expect(text.videoSrc).toBeUndefined();
		expect(text.html).toContain('hello');

		const audio = await renderForDisplay(`${ROOT}/music/song.mp3`, '');
		expect(audio.videoSrc).toBeUndefined(); // 音声は binary プレースホルダのまま(契約⑦)
	});
});

// ---------------------------------------------------------------------------
// CSP — media-src に vellis-asset: を許可(契約③)
// ---------------------------------------------------------------------------

describe('CSP — media-src の新設(要件#28 契約③)', () => {
	const confPath = resolve(__dirname, '../../src-tauri/tauri.conf.json');
	const conf = JSON.parse(readFileSync(confPath, 'utf-8')) as {
		app: { security: { csp: string } };
	};

	/** ディレクティブ名 → ソースリスト。無ければ null。 */
	function cspDirective(name: string): string[] | null {
		for (const part of conf.app.security.csp.split(';')) {
			const tokens = part.trim().split(/\s+/);
			if (tokens[0] === name) return tokens.slice(1);
		}
		return null;
	}

	test('media-src ディレクティブが存在し vellis-asset: を含む(<video src> がブロックされない)', () => {
		const mediaSrc = cspDirective('media-src');
		expect(mediaSrc, 'media-src ディレクティブが新設されていること').not.toBeNull();
		expect(mediaSrc).toContain('vellis-asset:');
	});

	test('既存の img-src / connect-src の vellis-asset: は維持(画像・3D・HTML 表示の回帰ガード)', () => {
		expect(cspDirective('img-src')).toContain('vellis-asset:');
		expect(cspDirective('connect-src')).toContain('vellis-asset:');
	});
});
