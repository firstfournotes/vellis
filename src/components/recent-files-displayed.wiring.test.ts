/**
 * 要件#64 追補f の受け入れテスト(docs/requirements/req-64.md 追補f・Issue #717)— フロントの配線
 * (component プロジェクト。ImageViewer・PdfViewer・VideoViewer・AudioViewer・RecentFiles を JSDOM に
 * 単体マウントし、`+page.svelte` はソース走査する)
 *
 * 「開けなかったファイルを Recent Files に載せない」。バイナリの経路は Rust の `open_in_window` では
 * 記録せず、ビューアが**最初に表示できた時点**でフロントが `record_displayed_file` で記録を頼む。
 *
 * **改訂 f-2(2026-10-25・由谷の事後確認=「#717(b)は今まで通り載せて」)**: 起案時判断 (b)「設計どおりの
 * プレースホルダでは呼ばない」は覆った。設計どおりのプレースホルダ(VideoViewer の `remote`・
 * `unsupported-container`、PdfViewer の `remote`、AudioViewer の `remote`)を**出した時点も「表示できた」に入れて
 * `onDisplayed` を呼ぶ**(f-2 の 1)。エラーの表示(`loadFailed`・壊れた PDF・`<img>` の error)と PDF の検査中
 * (`Loading…`)では今までどおり呼ばない(f-2 の 2)。f-1 で「プレースホルダでは呼ばない」を固定していた
 * 4 ケース(Pdf ssh・Video mkv・Video ssh・Audio ssh)は、この改訂で「1 回呼ぶ」に改めた(f-2 の 5=要件側の更新)。
 *
 * 判定範囲(AC 番号は req-64.md 追補f の受け入れ基準):
 * - AC-64-追f(d)(f-2 で改訂)4 つのビューア(3D は ModelViewer.displayed.wiring.test.ts)が省略できる `onDisplayed` を持ち、
 *   契約3 の成功の時点で 1 回呼び、f-2 の 1 のプレースホルダの経路でも 1 回呼び、f-2 の 2 の経路では呼ばない:
 *   - ImageViewer: `<img>` の `load` → 呼ぶ/`error`(壊れた・権限なし・ssh 切断=エラーの表示)→ 呼ばない
 *   - PdfViewer: 先頭の検査(`%PDF-`)が通って `load` が ready → 呼ぶ/検査に落ちた(壊れた PDF)→ 呼ばない/
 *     検査中(`Loading…`)→ まだ呼ばない/ssh のプレースホルダ → **出した時点で 1 回呼ぶ**(検査はしない)。
 *     ssh の URI が別の ssh の URI に変わればまた呼ぶ(「URI が変わった時点」)
 *   - VideoViewer: `<video>` の `loadedmetadata` → 呼ぶ/`error`(コーデック非対応=エラーの表示)→ 呼ばない/
 *     mkv・avi のプレースホルダ → **出した時点で 1 回呼ぶ** / ssh のプレースホルダ → **出した時点で 1 回呼ぶ**。
 *     プレースホルダから別の URI へ移れば、プレースホルダなら出した時点で・inline なら `loadedmetadata` で、また呼ぶ
 *   - AudioViewer: `<audio>` の `loadedmetadata` → 呼ぶ/`error` → 呼ばない/ssh のプレースホルダ → **出した時点で 1 回呼ぶ**。
 *     別の ssh の URI に変わればまた呼ぶ
 * - AC-64-追f(e) `+page.svelte`(ソース走査): 5 つのビューアの全部に `onDisplayed=` を渡す・
 *   `$lib/recent-files` の `shouldRecordDisplayedOnce` と `recordDisplayedFile` を使う(command 名の文字列を
 *   直に持たない)・`await recordDisplayedFile(…)` の後に区画の `refresh(` を呼ぶ(契約5)・
 *   (f-2 の 3)判定の控え(第 1 引数)を記録を頼む前に表示した URI で更新し、今の文書の URI が変わったら
 *   null に戻す=版の更新でプレースホルダのビューアが作り直されてまた `onDisplayed` が来ても 2 回目は頼まない
 * - AC-64-追f(e) `RecentFiles.svelte` の `refresh()`: 開いているときは `list_recent_files` を読み直す・
 *   閉じているときは読まない(契約10)
 *
 * ## 確定契約(implementer はこれに従う=test-writer 決定 2026-10-25・f-2 で改訂)
 * - 5 つのビューア(`ImageViewer` / `PdfViewer` / `VideoViewer` / `AudioViewer` / `ModelViewer`)の props に
 *   省略できる `onDisplayed?: () => void` を足す。呼ぶ時点(契約3・f-2 の 1):
 *   - ImageViewer: `<img class="image">` の `onload`(`loadFailed` の経路では呼ばない)
 *   - PdfViewer: `readableAsPdf` が真で `load = 'ready'` にした時点、**および `mode === 'remote'` のプレースホルダを
 *     出した時点**(`error`・`checking` では呼ばない)
 *   - VideoViewer: `<video class="video">` の `onloadedmetadata`、**および `mode` が `'remote'` /
 *     `'unsupported-container'` のプレースホルダを出した時点**(`loadFailed` のエラーの表示では呼ばない)
 *   - AudioViewer: `<audio>` の `onloadedmetadata`、**および `mode === 'remote'` のプレースホルダを出した時点**
 *     (`loadFailed` では呼ばない)
 *   - ModelViewer: `load = { kind: 'ready' }` の時点(→ ModelViewer.displayed.wiring.test.ts)
 *   「プレースホルダを出した時点」= そのビューアがその URI で作られた・URI が変わった時点(`uri`(または版数付き
 *   `src`)を読む effect の中で、mode がプレースホルダなら呼ぶ、が最短。`loadFailed` の枝と混ぜない)。
 *   ビューアは「1 回開くごとに 1 回」を数えない(版の更新で要素が作り直されれば、また呼んでよい)。
 *   絞るのは `+page.svelte`
 * - `+page.svelte`: `$lib/recent-files` から `shouldRecordDisplayedOnce`・`recordDisplayedFile` を import。
 *   `let displayedRecordedUri: string | null = null`(`windowState.currentDocument?.uri` が変わったら null)。
 *   各ビューアに `onDisplayed={() => void handleDisplayed(<そのビューアに渡した uri>)}` を渡し、
 *   `handleDisplayed(uri)` は `shouldRecordDisplayedOnce(displayedRecordedUri, uri, windowState.currentDocument?.uri ?? null)`
 *   が真のときだけ `displayedRecordedUri = uri` → `await recordDisplayedFile(uri)` → `recentFilesSection?.refresh()`。
 *   command 名の文字列 `'record_displayed_file'` は `+page.svelte` に書かない(`$lib/recent-files` の定数)
 * - `RecentFiles.svelte`: `export function refresh(): void`(`reveal()` と同じ bind:this 経由)。開いているときは
 *   `loadRecentFiles(rootUri)` を 1 回読み直す(`reloadNonce += 1` で足りる)。閉じているときは読まない
 *
 * ## 判定しないもの
 * - Rust の `record_displayed_file`(呼んだ窓のセッションと同じ URI のときだけ記録)→ src-tauri/tests/acceptance_req64f.rs
 * - 純関数 `shouldRecordDisplayedOnce` の表・`recordDisplayedFile` の invoke → src/lib/recent-files-displayed.acceptance.test.ts
 * - 実機で壊れた PNG・PDF・256 MB 超の STL を開いて載らないこと → 人間ゲート(機械で駆動できる)
 *
 * ## スタブの設計(各ビューアの既存 wiring テストの家風)
 * - $lib/ipc: モジュールモック(既定 null。RecentFiles のケースだけ `list_recent_files` の鏡を入れる)
 * - $lib/edit-guard / plugin-opener / plugin-dialog: import を成立させるだけ
 * - ResizeObserver: 即発火版(Video / Audio の bind:clientWidth 用)・clientWidth: 320・getContext: null 返しの spy・
 *   requestAnimationFrame: 積むだけ・HTMLMediaElement.play / pause: spy(jsdom は not implemented)
 * - fetch: 既定は失敗(波形解析の縮退)。PdfViewer のケースだけ先頭 1KiB の偽 Response を返す
 * - `<img>` / `<video>` / `<audio>` は JSDOM ではメディアを読まないので、`load` / `loadedmetadata` / `error` を
 *   テストから dispatch して「表示できた」「失敗した」を作る
 *
 * ## 実装前の見立て
 * - f-1: 「呼ぶ」側(各ビューアの成功のケース)は `onDisplayed` が props に無いので赤。「呼ばない」側は固定(緑)。
 *   `+page.svelte` の走査は import も `onDisplayed=` も無いので赤。`refresh()` は export が無いので赤
 * - f-2: 今の実装は 3 つのビューアとも `onloadedmetadata` / `load = 'ready'` でだけ呼ぶ(PdfViewer は
 *   `mode !== 'inline'` で effect を抜ける)ので、プレースホルダで「1 回呼ぶ」に改めた 4 ケースと、足した
 *   avi・URI の変更・プレースホルダ → inline の遷移のケースは赤。「呼ばない」側(エラー・検査中)と `+page.svelte` に
 *   足した控えの更新・戻しの走査は今の実装で緑(退行防止)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/edit-guard', () => ({ confirmDiscardEdits: vi.fn(async () => true) }));
vi.mock('@tauri-apps/plugin-opener', () => ({
	revealItemInDir: vi.fn(async () => undefined),
	openPath: vi.fn(async () => undefined),
	openUrl: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
	open: vi.fn(async () => null),
	ask: vi.fn(async () => false),
}));

import { invoke } from '$lib/ipc';
import ImageViewer from './ImageViewer.svelte';
import PdfViewer from './PdfViewer.svelte';
import VideoViewer from './VideoViewer.svelte';
import AudioViewer from './AudioViewer.svelte';
import RecentFiles from './RecentFiles.svelte';
import { windowState } from '../stores/window-state.svelte';
import { saveSectionExpanded } from '$lib/recent-files-section';

const invokeMock = vi.mocked(invoke);

const REPO_ROOT = resolve(__dirname, '../..');
const PAGE_SVELTE = resolve(REPO_ROOT, 'src/routes/+page.svelte');
const RECENT_FILES_SVELTE = resolve(REPO_ROOT, 'src/components/RecentFiles.svelte');

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const IMG = {
	uri: 'file:///Users/a/img/photo.png',
	src: 'vellis-asset://local/Users/a/img/photo.png',
};
const PDF = {
	uri: 'file:///Users/a/docs/plan.pdf',
	src: 'vellis-asset://local/Users/a/docs/plan.pdf',
};
const PDF_REMOTE = {
	uri: 'ssh://alice@host:22/remote/plan.pdf',
	src: 'vellis-asset://ssh/alice@host:22/remote/plan.pdf',
};
/** 別の ssh の PDF(プレースホルダのまま URI が変わる=f-2 の 1「URI が変わった時点」)。 */
const PDF_REMOTE_2 = {
	uri: 'ssh://alice@host:22/remote/spec.pdf',
	src: 'vellis-asset://ssh/alice@host:22/remote/spec.pdf',
};
const MP4 = {
	uri: 'file:///Users/a/movies/clip.mp4',
	src: 'vellis-asset://local/Users/a/movies/clip.mp4',
};
const MKV = {
	uri: 'file:///Users/a/movies/clip.mkv',
	src: 'vellis-asset://local/Users/a/movies/clip.mkv',
};
/** avi も `unsupported-container`(f-2 の 1 が名指しする 2 つめ)。 */
const AVI = {
	uri: 'file:///Users/a/movies/old.avi',
	src: 'vellis-asset://local/Users/a/movies/old.avi',
};
const MP4_REMOTE = {
	uri: 'ssh://alice@host:22/remote/clip.mp4',
	src: 'vellis-asset://ssh/alice@host:22/remote/clip.mp4',
};
/** 別の ssh の動画(mode が `remote` のまま URI だけ変わる=f-2 の 1「URI が変わった時点」)。 */
const MP4_REMOTE_2 = {
	uri: 'ssh://alice@host:22/remote/clip2.mp4',
	src: 'vellis-asset://ssh/alice@host:22/remote/clip2.mp4',
};
const WAV = {
	uri: 'file:///Users/a/music/take.wav',
	src: 'vellis-asset://local/Users/a/music/take.wav',
};
const WAV_REMOTE = {
	uri: 'ssh://alice@host:22/remote/take.wav',
	src: 'vellis-asset://ssh/alice@host:22/remote/take.wav',
};
/** 別の ssh の音声(プレースホルダのまま URI が変わる)。 */
const WAV_REMOTE_2 = {
	uri: 'ssh://alice@host:22/remote/take2.wav',
	src: 'vellis-asset://ssh/alice@host:22/remote/take2.wav',
};

const ROOT = 'file:///Users/x/notes';
const PNG_UNDER_ROOT = `${ROOT}/img/photo.png`;

/**
 * observe された要素を microtask で1回だけ通知する即発火 ResizeObserver。
 * Svelte 5 の bind:clientWidth はこの通知を受けて要素の実プロパティを読む。
 */
class ImmediateResizeObserver {
	#callback: (entries: { target: Element }[], observer: unknown) => void;
	constructor(callback: (entries: { target: Element }[], observer: unknown) => void) {
		this.#callback = callback;
	}
	observe(target: Element): void {
		queueMicrotask(() => this.#callback([{ target }], this));
	}
	unobserve(): void {}
	disconnect(): void {}
}

function bytesOf(source: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(source);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 積み残しの非同期(microtask 連鎖ごと)を流しきる。「まだ呼ばれていない」側の判定に使うので 2 周。 */
async function flushTasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
}

/** PdfViewer の先頭 1KiB の検査に答える fetch(本文の先頭を `head` にする)。 */
function stubPdfFetch(head: string): ReturnType<typeof vi.fn> {
	const spy = vi.fn(async () => ({
		ok: true,
		status: 206,
		arrayBuffer: async () => bytesOf(head),
	}));
	vi.stubGlobal('fetch', spy);
	return spy;
}

/** 先頭の検査が終わらない fetch(応答が来ない)= PdfViewer を `checking`(Loading…)に留める。 */
function stubPendingPdfFetch(): ReturnType<typeof vi.fn> {
	const spy = vi.fn(() => new Promise<never>(() => {}));
	vi.stubGlobal('fetch', spy);
	return spy;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(null);
	vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
	fetchSpy = vi.fn(async () => {
		throw new TypeError('Failed to fetch');
	});
	vi.stubGlobal('fetch', fetchSpy);
	vi.stubGlobal(
		'requestAnimationFrame',
		vi.fn(() => 1),
	);
	vi.stubGlobal('cancelAnimationFrame', vi.fn());
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
	vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
		(async () => undefined) as HTMLMediaElement['play'],
	);
	vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
		(() => undefined) as HTMLMediaElement['pause'],
	);
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get: () => 320,
	});
	windowState.applyRoot(ROOT, [], false);
	try {
		localStorage.clear();
		sessionStorage.clear();
	} catch {
		// storage が無い環境は無視
	}
});

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// AC-64-追f(d) — ImageViewer
// ---------------------------------------------------------------------------

describe('AC-64-追f(d) ImageViewer の onDisplayed(契約3= <img> の load)', () => {
	it('<img> の load で onDisplayed を 1 回呼ぶ(マウントだけでは呼ばない)', async () => {
		const onDisplayed = vi.fn();
		render(ImageViewer, { props: { ...IMG, onDisplayed } });
		const img = document.querySelector('img.image');
		expect(img).not.toBeNull();
		await flushTasks();
		expect(onDisplayed).not.toHaveBeenCalled();

		await fireEvent(img as HTMLImageElement, new Event('load'));
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	it('<img> の error(壊れた・権限なし・ssh 切断)ではプレースホルダを出して呼ばない', async () => {
		const onDisplayed = vi.fn();
		render(ImageViewer, { props: { ...IMG, onDisplayed } });
		const img = document.querySelector('img.image') as HTMLImageElement;
		await fireEvent(img, new Event('error'));
		await flushTasks();

		expect(document.querySelector('.image-error')?.textContent).toContain('Could not display the image');
		expect(document.querySelector('img.image')).toBeNull();
		expect(onDisplayed).not.toHaveBeenCalled();
	});

	it('onDisplayed を省略しても load で落ちない(省略できる callback)', async () => {
		render(ImageViewer, { props: { ...IMG } });
		const img = document.querySelector('img.image') as HTMLImageElement;
		await fireEvent(img, new Event('load'));
		await flushTasks();
		expect(document.querySelector('img.image')).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-64-追f(d) — PdfViewer
// ---------------------------------------------------------------------------

describe('AC-64-追f(d) PdfViewer の onDisplayed(契約3= 先頭の検査が通って ready)', () => {
	it('先頭が %PDF- で ready になると onDisplayed を 1 回呼ぶ', async () => {
		stubPdfFetch('%PDF-1.7\n%âãÏÓ\n1 0 obj\n');
		const onDisplayed = vi.fn();
		render(PdfViewer, { props: { ...PDF, onDisplayed } });

		await waitFor(() => expect(document.querySelector('iframe.pdf-frame')).not.toBeNull());
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	it('先頭の検査に落ちた(壊れた PDF)ではプレースホルダを出して呼ばない', async () => {
		stubPdfFetch('this is not a pdf at all');
		const onDisplayed = vi.fn();
		render(PdfViewer, { props: { ...PDF, onDisplayed } });

		await waitFor(() =>
			expect(document.querySelector('.pdf-message')?.textContent).toContain('Could not display this PDF'),
		);
		await flushTasks();
		expect(document.querySelector('iframe.pdf-frame')).toBeNull();
		expect(onDisplayed).not.toHaveBeenCalled();
	});

	it('検査中(Loading…)ではまだ呼ばない(f-2 の 2)', async () => {
		stubPendingPdfFetch();
		const onDisplayed = vi.fn();
		render(PdfViewer, { props: { ...PDF, onDisplayed } });
		await flushTasks();

		expect(document.querySelector('.pdf-message')?.textContent).toContain('Loading…');
		expect(document.querySelector('iframe.pdf-frame')).toBeNull();
		expect(onDisplayed).not.toHaveBeenCalled();
	});

	// f-1 では「ssh のプレースホルダでは検査もせず呼ばない(起案時判断 (b))」。f-2 の 1 で「出した時点で 1 回呼ぶ」に改めた。
	it('ssh のプレースホルダを出した時点で 1 回呼ぶ(検査はしない)(f-2 の 1= 今までどおり載せる)', async () => {
		const spy = stubPdfFetch('%PDF-1.7\n');
		const onDisplayed = vi.fn();
		render(PdfViewer, { props: { ...PDF_REMOTE, onDisplayed } });
		await flushTasks();

		expect(document.querySelector('.pdf-message')?.textContent).toContain('Remote (ssh) PDFs');
		expect(document.querySelector('iframe.pdf-frame')).toBeNull();
		expect(spy).not.toHaveBeenCalled();
		expect(onDisplayed).toHaveBeenCalledTimes(1);

		// 再描画だけでは増えない(呼ぶのは「出した時点」)。
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	it('ssh のプレースホルダのまま別の URI に変わると、また 1 回呼ぶ(f-2 の 1「URI が変わった時点」)', async () => {
		stubPdfFetch('%PDF-1.7\n');
		const onDisplayed = vi.fn();
		const { rerender } = render(PdfViewer, { props: { ...PDF_REMOTE, onDisplayed } });
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(1);

		await rerender({ ...PDF_REMOTE_2, onDisplayed });
		await flushTasks();
		expect(document.querySelector('.pdf-message')?.textContent).toContain('spec.pdf');
		expect(onDisplayed).toHaveBeenCalledTimes(2);
	});

	it('壊れた PDF(エラーの表示)から ssh へ移ると、プレースホルダを出した時点で初めて呼ぶ(エラーの枝と区別する)', async () => {
		stubPdfFetch('this is not a pdf at all');
		const onDisplayed = vi.fn();
		const { rerender } = render(PdfViewer, { props: { ...PDF, onDisplayed } });
		await waitFor(() =>
			expect(document.querySelector('.pdf-message')?.textContent).toContain('Could not display this PDF'),
		);
		await flushTasks();
		expect(onDisplayed).not.toHaveBeenCalled();

		await rerender({ ...PDF_REMOTE, onDisplayed });
		await flushTasks();
		expect(document.querySelector('.pdf-message')?.textContent).toContain('Remote (ssh) PDFs');
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	it('onDisplayed を省略しても ssh のプレースホルダで落ちない(省略できる callback)', async () => {
		stubPdfFetch('%PDF-1.7\n');
		render(PdfViewer, { props: { ...PDF_REMOTE } });
		await flushTasks();
		expect(document.querySelector('.pdf-message')?.textContent).toContain('Remote (ssh) PDFs');
	});
});

// ---------------------------------------------------------------------------
// AC-64-追f(d) — VideoViewer
// ---------------------------------------------------------------------------

describe('AC-64-追f(d) VideoViewer の onDisplayed(契約3= <video> の loadedmetadata)', () => {
	it('<video> の loadedmetadata で onDisplayed を 1 回呼ぶ(マウントだけでは呼ばない)', async () => {
		const onDisplayed = vi.fn();
		render(VideoViewer, { props: { ...MP4, onDisplayed } });
		const video = document.querySelector('video.video');
		expect(video).not.toBeNull();
		await flushTasks();
		expect(onDisplayed).not.toHaveBeenCalled();

		await fireEvent(video as HTMLVideoElement, new Event('loadedmetadata'));
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	it('<video> の error(コーデック非対応)ではプレースホルダを出して呼ばない', async () => {
		const onDisplayed = vi.fn();
		render(VideoViewer, { props: { ...MP4, onDisplayed } });
		const video = document.querySelector('video.video') as HTMLVideoElement;
		await fireEvent(video, new Event('error'));
		await flushTasks();

		expect(document.querySelector('.video-message')?.textContent).toContain('Could not play this video');
		expect(onDisplayed).not.toHaveBeenCalled();
	});

	// f-1 では「mkv(設計どおりのプレースホルダ)では <video> を出さず呼ばない(起案時判断 (b))」。f-2 の 1 で「出した時点で 1 回呼ぶ」に改めた。
	it('mkv(unsupported-container のプレースホルダ)を出した時点で 1 回呼ぶ(f-2 の 1= 今までどおり載せる)', async () => {
		const onDisplayed = vi.fn();
		render(VideoViewer, { props: { ...MKV, onDisplayed } });
		await flushTasks();

		expect(document.querySelector('video')).toBeNull();
		expect(document.querySelector('.video-message')?.textContent).toContain(
			'This video format cannot be played',
		);
		expect(onDisplayed).toHaveBeenCalledTimes(1);

		// 再描画だけでは増えない(呼ぶのは「出した時点」)。
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	it('avi(unsupported-container のプレースホルダ)も出した時点で 1 回呼ぶ(f-2 の 1)', async () => {
		const onDisplayed = vi.fn();
		render(VideoViewer, { props: { ...AVI, onDisplayed } });
		await flushTasks();

		expect(document.querySelector('video')).toBeNull();
		expect(document.querySelector('.video-message')?.textContent).toContain(
			'This video format cannot be played',
		);
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	// f-1 では「ssh のプレースホルダでは呼ばない(起案時判断 (b))」。f-2 の 1 で「出した時点で 1 回呼ぶ」に改めた。
	it('ssh のプレースホルダを出した時点で 1 回呼ぶ(f-2 の 1= 今までどおり載せる)', async () => {
		const onDisplayed = vi.fn();
		render(VideoViewer, { props: { ...MP4_REMOTE, onDisplayed } });
		await flushTasks();

		expect(document.querySelector('video')).toBeNull();
		expect(document.querySelector('.video-message')?.textContent).toContain('Remote (ssh) videos');
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	it('プレースホルダのまま別の URI に変わる(mkv → ssh)と、また 1 回呼ぶ(f-2 の 1「URI が変わった時点」)', async () => {
		const onDisplayed = vi.fn();
		const { rerender } = render(VideoViewer, { props: { ...MKV, onDisplayed } });
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(1);

		await rerender({ ...MP4_REMOTE, onDisplayed });
		await flushTasks();
		expect(document.querySelector('.video-message')?.textContent).toContain('Remote (ssh) videos');
		expect(onDisplayed).toHaveBeenCalledTimes(2);
	});

	// mode が変わらない URI の変更。`mode` は $derived なので、同じ値のままでは effect の再実行の
	// きっかけにならない=実装は uri そのものを追う必要がある(+page は VideoViewer を {#key} で囲まない)。
	it('ssh のプレースホルダのまま別の ssh の URI に変わる(mode は remote のまま)と、また 1 回呼ぶ(f-2 の 1「URI が変わった時点」)', async () => {
		const onDisplayed = vi.fn();
		const { rerender } = render(VideoViewer, { props: { ...MP4_REMOTE, onDisplayed } });
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(1);

		await rerender({ ...MP4_REMOTE_2, onDisplayed });
		await flushTasks();
		expect(document.querySelector('.video-message')?.textContent).toContain('clip2.mp4');
		expect(onDisplayed).toHaveBeenCalledTimes(2);
	});

	it('unsupported-container のプレースホルダのまま別の URI に変わる(mkv → avi・mode は同じ)と、また 1 回呼ぶ(f-2 の 1「URI が変わった時点」)', async () => {
		const onDisplayed = vi.fn();
		const { rerender } = render(VideoViewer, { props: { ...MKV, onDisplayed } });
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(1);

		await rerender({ ...AVI, onDisplayed });
		await flushTasks();
		expect(document.querySelector('.video-message')?.textContent).toContain('old.avi');
		expect(onDisplayed).toHaveBeenCalledTimes(2);
	});

	it('プレースホルダ(mkv)から inline(mp4)へ移ると、loadedmetadata が来るまでは呼ばない(inline は契約3 の元の定義のまま)', async () => {
		const onDisplayed = vi.fn();
		const { rerender } = render(VideoViewer, { props: { ...MKV, onDisplayed } });
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(1);

		await rerender({ ...MP4, onDisplayed });
		await flushTasks();
		const video = document.querySelector('video.video');
		expect(video).not.toBeNull();
		expect(onDisplayed).toHaveBeenCalledTimes(1);

		await fireEvent(video as HTMLVideoElement, new Event('loadedmetadata'));
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(2);
	});

	it('再生の失敗(loadFailed のエラーの表示)から mkv へ移ると、プレースホルダを出した時点で初めて呼ぶ(エラーの枝と区別する)', async () => {
		const onDisplayed = vi.fn();
		const { rerender } = render(VideoViewer, { props: { ...MP4, onDisplayed } });
		const video = document.querySelector('video.video') as HTMLVideoElement;
		await fireEvent(video, new Event('error'));
		await flushTasks();
		expect(document.querySelector('.video-message')?.textContent).toContain('Could not play this video');
		expect(onDisplayed).not.toHaveBeenCalled();

		await rerender({ ...MKV, onDisplayed });
		await flushTasks();
		expect(document.querySelector('.video-message')?.textContent).toContain(
			'This video format cannot be played',
		);
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	it('onDisplayed を省略しても mkv のプレースホルダで落ちない(省略できる callback)', async () => {
		render(VideoViewer, { props: { ...MKV } });
		await flushTasks();
		expect(document.querySelector('.video-message')?.textContent).toContain(
			'This video format cannot be played',
		);
	});
});

// ---------------------------------------------------------------------------
// AC-64-追f(d) — AudioViewer
// ---------------------------------------------------------------------------

describe('AC-64-追f(d) AudioViewer の onDisplayed(契約3= <audio> の loadedmetadata)', () => {
	it('<audio> の loadedmetadata で onDisplayed を 1 回呼ぶ(マウントだけでは呼ばない)', async () => {
		const onDisplayed = vi.fn();
		render(AudioViewer, { props: { ...WAV, onDisplayed } });
		const audio = document.querySelector('audio');
		expect(audio).not.toBeNull();
		await flushTasks();
		expect(onDisplayed).not.toHaveBeenCalled();

		await fireEvent(audio as HTMLAudioElement, new Event('loadedmetadata'));
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	it('<audio> の error ではプレースホルダを出して呼ばない', async () => {
		const onDisplayed = vi.fn();
		render(AudioViewer, { props: { ...WAV, onDisplayed } });
		const audio = document.querySelector('audio') as HTMLAudioElement;
		await fireEvent(audio, new Event('error'));
		await flushTasks();

		expect(document.querySelector('.audio-message')?.textContent).toContain('Could not play this audio');
		expect(onDisplayed).not.toHaveBeenCalled();
	});

	// f-1 では「ssh のプレースホルダでは呼ばない(起案時判断 (b))」。f-2 の 1 で「出した時点で 1 回呼ぶ」に改めた。
	it('ssh のプレースホルダを出した時点で 1 回呼ぶ(f-2 の 1= 今までどおり載せる)', async () => {
		const onDisplayed = vi.fn();
		render(AudioViewer, { props: { ...WAV_REMOTE, onDisplayed } });
		await flushTasks();

		expect(document.querySelector('audio')).toBeNull();
		expect(document.querySelector('.audio-message')?.textContent).toContain('Remote (ssh) audio');
		expect(onDisplayed).toHaveBeenCalledTimes(1);

		// 再描画だけでは増えない(呼ぶのは「出した時点」)。
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	it('ssh のプレースホルダのまま別の URI に変わると、また 1 回呼ぶ(f-2 の 1「URI が変わった時点」。+page は AudioViewer を {#key} で囲まない)', async () => {
		const onDisplayed = vi.fn();
		const { rerender } = render(AudioViewer, { props: { ...WAV_REMOTE, onDisplayed } });
		await flushTasks();
		expect(onDisplayed).toHaveBeenCalledTimes(1);

		await rerender({ ...WAV_REMOTE_2, onDisplayed });
		await flushTasks();
		expect(document.querySelector('.audio-message')?.textContent).toContain('take2.wav');
		expect(onDisplayed).toHaveBeenCalledTimes(2);
	});

	it('読み込みの失敗(loadFailed のエラーの表示)から ssh へ移ると、プレースホルダを出した時点で初めて呼ぶ(エラーの枝と区別する)', async () => {
		const onDisplayed = vi.fn();
		const { rerender } = render(AudioViewer, { props: { ...WAV, onDisplayed } });
		const audio = document.querySelector('audio') as HTMLAudioElement;
		await fireEvent(audio, new Event('error'));
		await flushTasks();
		expect(document.querySelector('.audio-message')?.textContent).toContain('Could not play this audio');
		expect(onDisplayed).not.toHaveBeenCalled();

		await rerender({ ...WAV_REMOTE, onDisplayed });
		await flushTasks();
		expect(document.querySelector('.audio-message')?.textContent).toContain('Remote (ssh) audio');
		expect(onDisplayed).toHaveBeenCalledTimes(1);
	});

	it('onDisplayed を省略しても ssh のプレースホルダで落ちない(省略できる callback)', async () => {
		render(AudioViewer, { props: { ...WAV_REMOTE } });
		await flushTasks();
		expect(document.querySelector('.audio-message')?.textContent).toContain('Remote (ssh) audio');
	});
});

// ---------------------------------------------------------------------------
// AC-64-追f(e) — RecentFiles.refresh()(契約5・10)
// ---------------------------------------------------------------------------

/** invoke のモックが `list_recent_files` に返す一覧(Rust の recent-files.json の鏡)。 */
let recent: string[] = [];
const listCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'list_recent_files');

function installRecentFilesInvoke() {
	recent = [];
	invokeMock.mockImplementation(async (cmd: string) => {
		if (cmd === 'list_recent_files') return [...recent];
		return null;
	});
}

function mountSection() {
	return render(RecentFiles, {
		props: { rootUri: ROOT, currentUri: null, paneHeight: 600, onOpened: vi.fn() },
	});
}

describe('AC-64-追f(e) RecentFiles.refresh()= 記録のあとの読み直しの合図(契約5)', () => {
	it('開いているとき refresh() で list_recent_files を読み直し、載った行が出る', async () => {
		installRecentFilesInvoke();
		const { component } = mountSection();
		await waitFor(() => expect(listCalls()).toHaveLength(1));
		expect(screen.queryAllByTestId('recent-files-row')).toHaveLength(0);

		// Rust 側で record_displayed_file が終わった(= 一覧に載った)あとの合図。
		recent = [PNG_UNDER_ROOT];
		await component.refresh();
		await flushTasks();

		await waitFor(() => expect(listCalls()).toHaveLength(2));
		await waitFor(() => expect(screen.queryAllByTestId('recent-files-row')).toHaveLength(1));
		expect(screen.getAllByTestId('recent-files-row')[0].getAttribute('data-uri')).toBe(PNG_UNDER_ROOT);
	});

	it('閉じているとき refresh() は読まない(契約10= 閉じている間は読まない)', async () => {
		installRecentFilesInvoke();
		saveSectionExpanded(false);
		const { component } = mountSection();
		await flushTasks();
		expect(screen.getByTestId('recent-files-header').getAttribute('aria-expanded')).toBe('false');
		expect(listCalls()).toHaveLength(0);

		recent = [PNG_UNDER_ROOT];
		await component.refresh();
		await flushTasks();
		expect(listCalls()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC-64-追f(e) — +page.svelte のソース走査(契約4・5)
// ---------------------------------------------------------------------------

/** `<Name` で始まるタグの本文(`{…}` の中の `>` を飛ばして、タグを閉じる `>` まで)。 */
function tagText(src: string, tagStart: number): string {
	let depth = 0;
	for (let i = tagStart; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth += 1;
		else if (c === '}') depth -= 1;
		else if (c === '>' && depth === 0) return src.slice(tagStart, i + 1);
	}
	throw new Error(`unterminated tag at ${tagStart}`);
}

/** `<Name` のタグを全部(`<NameX` のような別名は除く)。 */
function tagsOf(src: string, name: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`<${name.replace('.', '\\.')}(?=[\\s/>])`, 'g');
	for (const m of src.matchAll(re)) out.push(tagText(src, m.index ?? 0));
	return out;
}

describe('AC-64-追f(e) +page.svelte の配線(ソース走査・契約4・5)', () => {
	const page = readFileSync(PAGE_SVELTE, 'utf-8');
	const recentFilesSvelte = readFileSync(RECENT_FILES_SVELTE, 'utf-8');

	it('5 つのビューアの全部に onDisplayed を渡す(Image・Pdf・Video・Audio・Model)', () => {
		const viewers: Record<string, string[]> = {
			ImageViewer: tagsOf(page, 'ImageViewer'),
			PdfViewer: tagsOf(page, 'PdfViewer'),
			VideoViewer: tagsOf(page, 'VideoViewer'),
			AudioViewer: tagsOf(page, 'AudioViewer'),
			// 3D は動的 import(`{#await import('../components/ModelViewer.svelte') then module}` の
			// `<module.default …>`)。静的 import に変えた場合も `<ModelViewer …>` で拾う。
			ModelViewer: [...tagsOf(page, 'module.default'), ...tagsOf(page, 'ModelViewer')],
		};
		for (const [name, tags] of Object.entries(viewers)) {
			expect(tags.length, `${name} must be rendered by +page.svelte`).toBeGreaterThanOrEqual(1);
			for (const tag of tags) {
				expect(tag, `${name} must receive onDisplayed: ${tag}`).toMatch(/\bonDisplayed=/);
			}
		}
		expect(page).toContain("import('../components/ModelViewer.svelte')");
	});

	it('$lib/recent-files の shouldRecordDisplayedOnce と recordDisplayedFile を使う(command 名の文字列は持たない)', () => {
		const imports = [...page.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\$lib\/recent-files'/g)]
			.map((m) => m[1] ?? '')
			.join(',');
		expect(imports).toMatch(/\bshouldRecordDisplayedOnce\b/);
		expect(imports).toMatch(/\brecordDisplayedFile\b/);
		expect(page).toMatch(/\bshouldRecordDisplayedOnce\(/);
		expect(page).toMatch(/\bawait recordDisplayedFile\(/);
		expect(page).not.toContain("'record_displayed_file'");
		expect(page).not.toContain('"record_displayed_file"');
	});

	it('判定 → 記録 → 区画の refresh の順(契約4・5)。記録は判定の後、refresh は記録の await の後', () => {
		const judgeAt = page.indexOf('shouldRecordDisplayedOnce(');
		const recordAt = page.indexOf('await recordDisplayedFile(');
		expect(judgeAt).toBeGreaterThan(-1);
		expect(recordAt).toBeGreaterThan(judgeAt);
		// 記録の呼び出しから、その関数の閉じ(1 段インデントの `}`)まで。
		const fnEnd = page.indexOf('\n\t}', recordAt);
		expect(fnEnd).toBeGreaterThan(recordAt);
		const afterRecord = page.slice(recordAt, fnEnd);
		expect(afterRecord, 'the section must be told to reload after the record finishes').toMatch(
			/\.refresh\(/,
		);
		// refresh は記録より前に出さない(先に読むと、まだ載っていない)。
		const beforeRecord = page.slice(judgeAt, recordAt);
		expect(beforeRecord).not.toMatch(/\.refresh\(/);
	});

	it('RecentFiles.svelte が refresh() を export する(reveal() と同じ bind:this 経由)', () => {
		expect(recentFilesSvelte).toMatch(/export\s+(async\s+)?function\s+refresh\s*\(/);
		expect(recentFilesSvelte).toMatch(/export\s+(async\s+)?function\s+reveal\s*\(/);
	});

	// --- f-2 の 3: 契約4 をプレースホルダにもそのまま当てる(版の更新で作り直されても 2 回目は頼まない)---
	// 純関数 `shouldRecordDisplayedOnce(記録済み, 表示した URI, 今の文書)` の表は acceptance 側で固定済み。
	// ここでは `+page.svelte` がその表に正しい材料を渡し続けることを見る= (1) 判定の控えを、記録を頼む前に表示した URI で
	// 更新する(更新しないと、版の更新でプレースホルダのビューアが作り直されてまた `onDisplayed` が来たとき 2 回目を頼む)
	// (2) 控えは今の文書の URI が変わったときに null へ戻す(戻さないと、別の文書を経て戻ってきたときに頼めない。
	// reviewer の P3 ②=バイナリ → テキスト → 同じバイナリ、で先頭へ戻らない変異を殺す)

	it('f-2 の 3: 判定の控え(第 1 引数)は、記録を頼む前に表示した URI(第 2 引数)で更新し、同じ URI を記録に渡す', () => {
		const [recorded, displayed] = judgeArgs(page);
		expect(recorded, 'the first argument must be a plain variable (the remembered URI)').toMatch(IDENT);
		expect(displayed, 'the second argument must be a plain variable (the displayed URI)').toMatch(IDENT);
		expect(recorded).not.toBe(displayed);

		const judgeAt = page.indexOf('shouldRecordDisplayedOnce(');
		const recordAt = page.indexOf('await recordDisplayedFile(');
		const between = page.slice(judgeAt, recordAt);
		expect(between, 'the remembered URI must be updated before the record is requested').toMatch(
			new RegExp(`\\b${recorded}\\s*=\\s*${displayed}\\s*;`),
		);
		expect(page.slice(recordAt, recordAt + 120)).toMatch(
			new RegExp(`await recordDisplayedFile\\(\\s*${displayed}\\s*\\)`),
		);
	});

	it('f-2 の 3: 控えは今の文書の URI が変わったら null に戻す(開くたびに高々 1 回。版の更新では URI が変わらないので戻らない)', () => {
		const [recorded] = judgeArgs(page);
		const resetting = effectBlocks(page).filter((body) =>
			new RegExp(`\\b${recorded}\\s*=\\s*null\\b`).test(body),
		);
		expect(resetting.length, `an $effect must reset ${recorded} to null`).toBeGreaterThanOrEqual(1);

		// その effect が今の文書の URI を読む: 直に `windowState.currentDocument` を読むか、
		// `$derived(windowState.currentDocument?.uri …)` の変数を通す(版数 `binaryVersion` には依存しない)。
		const derivedOfCurrentUri = [
			...page.matchAll(/let\s+([A-Za-z_$][\w$]*)\s*=\s*\$derived\(\s*windowState\.currentDocument\?\.uri[^)]*\)/g),
		].map((m) => m[1]);
		const readsCurrentUri = resetting.some(
			(body) =>
				/windowState\.currentDocument/.test(body) ||
				derivedOfCurrentUri.some((name) => new RegExp(`\\b${name}\\b`).test(body)),
		);
		expect(readsCurrentUri, 'the resetting $effect must depend on the current document URI').toBe(true);
		for (const body of resetting) {
			expect(body, 'the reset must not be tied to the binary version (a version bump is not a new open)').not.toMatch(
				/\bbinaryVersion\b/,
			);
		}
	});
});

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** `shouldRecordDisplayedOnce(…)` の実引数を、最上位のカンマで切って返す(空白は落とす)。 */
function judgeArgs(src: string): string[] {
	const name = 'shouldRecordDisplayedOnce';
	const at = src.indexOf(`${name}(`);
	if (at < 0) throw new Error(`${name}( not found in +page.svelte`);
	const open = at + name.length;
	let depth = 0;
	let end = -1;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '(') depth += 1;
		else if (c === ')') {
			depth -= 1;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end < 0) throw new Error(`unterminated ${name}( at ${at}`);
	const inner = src.slice(open + 1, end);
	const args: string[] = [];
	let current = '';
	depth = 0;
	for (const c of inner) {
		if (c === '(' || c === '[' || c === '{') depth += 1;
		else if (c === ')' || c === ']' || c === '}') depth -= 1;
		if (c === ',' && depth === 0) {
			args.push(current.trim());
			current = '';
		} else current += c;
	}
	args.push(current.trim());
	return args;
}

/** `$effect(` ごとの本文(最初の `{` から対応する `}` まで)。 */
function effectBlocks(src: string): string[] {
	const out: string[] = [];
	let from = 0;
	for (;;) {
		const at = src.indexOf('$effect(', from);
		if (at < 0) break;
		const open = src.indexOf('{', at);
		if (open < 0) break;
		let depth = 0;
		let end = -1;
		for (let i = open; i < src.length; i++) {
			const c = src[i];
			if (c === '{') depth += 1;
			else if (c === '}') {
				depth -= 1;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end < 0) break;
		out.push(src.slice(open, end + 1));
		from = end + 1;
	}
	return out;
}
