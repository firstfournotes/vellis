/**
 * 要件#10 の受け入れテスト(requirements.md #10)
 * 「reload 後も現在の root・開いているファイル・ツリー展開状態を維持する
 *  (ウインドウを閉じる/アプリ再起動でリセット)」
 *
 * 契約(2026-08-08 由谷決定=案Y・調査記録 docs/reload-state.md):
 * - sessionStorage スナップショット {rootUri, docUri, expandedDirs} を状態変更時に保存し、
 *   mount 時にスナップショットがあれば起動時引数の代わりに復元する
 *   (set_root → open_document → 保存ディレクトリの展開。既存コマンド再利用・Rust 変更なし)
 * - スナップショットがあれば履歴選択画面(要件#4)は表示しない
 * - 復元失敗(対象消滅等)は起動時引数の挙動へフォールバック
 * - スクロール位置とマーク一覧開閉はスコープ外
 * - 寿命は sessionStorage どおり(reload は跨ぐ・ウインドウクローズ/アプリ再起動で消える・
 *   ウインドウごとに独立)
 *
 * 判定範囲(本ファイル): 機械判定できる純ロジック。実装先 `src/lib/reload-state.ts`(新規)。
 * 実 reload の目視確認は人間ゲート・画面配線は reviewer 照合(末尾参照)。
 *
 * ## 確定契約(公開 API・implementer はこれに従う)
 *
 * スナップショットの形(保存 JSON・loadSnapshot の返り値):
 *   `{ rootUri: string; docUri: string | null; expandedDirs: string[] }`
 *   (型名は ReloadSnapshot を推奨。本テストは構造のみ判定し、型名には依存しない)
 *
 * 1. `RELOAD_STATE_STORAGE_KEY = 'vellis.reload-state'`(exported const)
 *    - キー名の固定は本テストの設計判断(pane-resize の 'vellis.explorer-width' と同じ家風)。
 *      同一ウインドウの reload 前後(開発中はビルドをまたぐこともある)で同じ値を読むため固定
 * 2. `saveSnapshot(snapshot: { rootUri: string; docUri: string | null;
 *     expandedDirs: Iterable<string> }): void`
 *    - sessionStorage の RELOAD_STATE_STORAGE_KEY へ JSON で保存する(表現も契約:
 *      JSON.parse で rootUri / docUri / expandedDirs の3フィールドが読めること。
 *      保存 JSON への追加フィールドの併存は実装の自由)
 *    - localStorage には書かない(書くと「アプリ再起動でリセット・ウインドウごとに独立」の
 *      寿命契約が壊れる。sessionStorage の選択こそが寿命契約の機械判定点)
 *    - expandedDirs は入力 Iterable(配線側が Set で持つ想定・配列も可)を配列にして保存。
 *      保存時に normalizeExpandedDirs 相当の正規化(重複除去・root 外除外・root 自身除外・
 *      初出順維持)を通す
 *    - docUri は root 配下かのチェックをしない(開けるかどうかは open_document の成否が正)
 * 3. `loadSnapshot(): ReloadSnapshot | null`
 *    - 保存なし・壊れた JSON・object でない JSON・欠損フィールド・型不一致・
 *      rootUri が空文字 → null(=スナップショット全体を破棄。呼び出し側は起動時引数の
 *      挙動へフォールバックする)。部分救済はしない=本テストの設計判断
 *      (書き手は saveSnapshot だけなので、形が崩れている=破損とみなして安全側へ落とす)
 *    - 未知の追加フィールドは無視する(前方互換)。返り値は上記3フィールドのみ
 *    - expandedDirs は返す前にも正規化する(旧版・手書きの保存値への防御)
 * 4. `clearSnapshot(): void` — キーごと削除する。未保存時に呼んでも例外にしない
 * 5. `normalizeExpandedDirs(rootUri: string, dirs: Iterable<string>): string[]`
 *    - 重複除去(初出順を維持)・rootUri 自身を除外・root 配下でないものを除外
 *    - 「配下」= セグメント境界での前方一致(root 'file:///a/b' に対し 'file:///a/bc/…' は
 *      配下ではない)。root の末尾スラッシュは無視して比較する
 *    - 孫ディレクトリは親が dirs に無くても維持する(スナップショットは見たままを保存し、
 *      親子関係の刈り込みはしない)=本テストの設計判断
 * 6. `shouldShowRootPicker(needsRootSelection: boolean,
 *     snapshot: ReloadSnapshot | null, rootRestored: boolean): boolean`
 *    - snapshot が null → needsRootSelection をそのまま返す(従来=要件#4 の挙動)
 *    - snapshot があり rootRestored=true(復元成功)→ false
 *      (契約「スナップショットがあれば履歴選択画面は表示しない」の本体)
 *    - snapshot があり rootRestored=false(復元失敗)→ needsRootSelection をそのまま返す。
 *      スナップショットの存在だけでは抑止しない=本テストの設計判断: 復元失敗時は契約
 *      「起動時引数の挙動へフォールバック」が優先(引数なし起動なら履歴選択画面が出る。
 *      存在だけで抑止すると root 消滅時に選択手段のない空 root へ取り残される)
 * 7. `restoreSnapshot(snapshot): Promise<{ ok: true; root: unknown; document: unknown | null }
 *     | { ok: false }>`
 *    - invoke('set_root', { uri: rootUri }) → docUri が非 null なら
 *      invoke('open_document', { uri: docUri }) の順に呼ぶ(既存コマンド再利用)。
 *      invoke は `$lib/ipc` の薄いラッパを vi.mock する。実装側も invoke は `$lib/ipc` から
 *      import すること(root-picker と同じ家風)
 *    - ツリー展開はこの関数では行わない(呼ぶのは上記2コマンドのみ。展開は配線側の持ち場:
 *      normalizeExpandedDirs 済みの集合を外部化された展開状態へ渡す=reviewer 照合)
 *    - docUri が null なら open_document は呼ばず { ok: true, document: null }
 *    - set_root 失敗 → { ok: false } に解決する(reject しない)。open_document は呼ばない。
 *      まだ何も変わっていないので起動時引数の挙動へ全体フォールバックできる
 *    - open_document 失敗(root は在るがファイル消滅)→ { ok: true, root: <set_root の解決値>,
 *      document: null } = root は復元したまま文書だけ諦める=本テストの設計判断
 *      (既存の file_removed → clearDocument と同じ最終状態。root まで起動時値へ巻き戻すと
 *      set_root 済みの backend と食い違う)
 *
 * ## reviewer 照合に委ねる配線(本テストの判定対象外)
 * - +page.svelte: mount 時に loadSnapshot → あれば起動時引数の代わりに restoreSnapshot、
 *   null / ok:false なら従来の起動時引数フロー(initial_path を開く・needs_root_selection
 *   なら履歴選択画面)。履歴選択画面の表示判定に shouldShowRootPicker を使うこと
 * - 状態変更時の saveSnapshot 呼び出し(root / currentDocument / 展開状態の変化を $effect で)
 * - Explorer / ExplorerItem の展開状態の外部化と、スナップショットからの展開復元
 *   (既存 list_dir の再利用)
 * - スクロール位置・マーク一覧開閉(showMarks / markFilter)をスナップショットに含めないこと
 *
 * テスト環境の前提: Node 25 の組み込み Web Storage は vitest.config.ts の
 * test.execArgv('--no-experimental-webstorage')で無効化済み。jsdom の
 * sessionStorage / localStorage がそのまま使える(tasks/lessons.md 参照)。
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

import { invoke } from '$lib/ipc';
import {
	RELOAD_STATE_STORAGE_KEY,
	clearSnapshot,
	loadSnapshot,
	normalizeExpandedDirs,
	restoreSnapshot,
	saveSnapshot,
	shouldShowRootPicker,
} from './reload-state';

const invokeMock = vi.mocked(invoke);

// backend の URI 表現に合わせた生文字列(percent-encode なし。root-picker と同じ前提)
const ROOT = 'file:///Users/a/work';
const DOC = `${ROOT}/notes/plan.md`;
const NOTES = `${ROOT}/notes`;
const DOCS = `${ROOT}/docs`;
const DEEP = `${ROOT}/notes/archive`; // 孫(親 NOTES が無くても維持されるべき)
const SIBLING = 'file:///Users/a/other'; // root の兄弟(root 外)
const PARENT = 'file:///Users/a'; // root の親(root 外)

beforeEach(() => {
	sessionStorage.clear();
	localStorage.clear();
	invokeMock.mockReset();
});

// ---------------------------------------------------------------------------
// 定数と保存先 — キー設計と「寿命は sessionStorage どおり」の機械判定点
// ---------------------------------------------------------------------------

describe('定数と保存先 — キーは固定・置き場は sessionStorage', () => {
	test("保存キーは 'vellis.reload-state' に固定", () => {
		expect(RELOAD_STATE_STORAGE_KEY).toBe('vellis.reload-state');
	});

	test('saveSnapshot は sessionStorage の固定キーへ JSON で3フィールドを書く', () => {
		saveSnapshot({ rootUri: ROOT, docUri: DOC, expandedDirs: [NOTES] });
		const raw = sessionStorage.getItem(RELOAD_STATE_STORAGE_KEY);
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw ?? 'null')).toMatchObject({
			rootUri: ROOT,
			docUri: DOC,
			expandedDirs: [NOTES],
		});
	});

	test('localStorage には一切書かない(アプリ再起動でリセット・ウインドウ独立の寿命契約)', () => {
		saveSnapshot({ rootUri: ROOT, docUri: DOC, expandedDirs: [NOTES] });
		expect(localStorage.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// saveSnapshot / loadSnapshot — 往復・スキーマ・保存時の正規化
// ---------------------------------------------------------------------------

describe('saveSnapshot / loadSnapshot — 往復と保存時の正規化', () => {
	test('save→load の往復で同じスナップショットが返る(返り値は3フィールドのみ)', () => {
		saveSnapshot({ rootUri: ROOT, docUri: DOC, expandedDirs: [NOTES, DOCS] });
		expect(loadSnapshot()).toEqual({
			rootUri: ROOT,
			docUri: DOC,
			expandedDirs: [NOTES, DOCS],
		});
	});

	test('docUri=null(文書を開いていない状態)も往復できる', () => {
		saveSnapshot({ rootUri: ROOT, docUri: null, expandedDirs: [] });
		expect(loadSnapshot()).toEqual({ rootUri: ROOT, docUri: null, expandedDirs: [] });
	});

	test('expandedDirs は Set でも渡せて、配列(挿入順)として保存・読込される', () => {
		saveSnapshot({ rootUri: ROOT, docUri: null, expandedDirs: new Set([NOTES, DOCS]) });
		expect(loadSnapshot()?.expandedDirs).toEqual([NOTES, DOCS]);
	});

	test('保存時に expandedDirs が正規化される(重複・root 外・root 自身を除去)', () => {
		saveSnapshot({
			rootUri: ROOT,
			docUri: null,
			expandedDirs: [NOTES, NOTES, SIBLING, ROOT, DOCS],
		});
		expect(loadSnapshot()?.expandedDirs).toEqual([NOTES, DOCS]);
	});

	test('docUri は root 外でもそのまま保持する(開けるかは open_document の成否が正)', () => {
		const outsideDoc = 'file:///Users/a/other/readme.md';
		saveSnapshot({ rootUri: ROOT, docUri: outsideDoc, expandedDirs: [] });
		expect(loadSnapshot()?.docUri).toBe(outsideDoc);
	});

	test('上書き保存は最後の状態が勝つ(状態変更のたびに保存する前提)', () => {
		saveSnapshot({ rootUri: ROOT, docUri: DOC, expandedDirs: [NOTES] });
		saveSnapshot({ rootUri: SIBLING, docUri: null, expandedDirs: [] });
		expect(loadSnapshot()).toEqual({ rootUri: SIBLING, docUri: null, expandedDirs: [] });
	});

	test('モジュール再読込(=reload 相当)後も同じスナップショットが読める', async () => {
		saveSnapshot({ rootUri: ROOT, docUri: DOC, expandedDirs: [NOTES] });
		vi.resetModules();
		const fresh = await import('./reload-state');
		expect(fresh.loadSnapshot()).toEqual({
			rootUri: ROOT,
			docUri: DOC,
			expandedDirs: [NOTES],
		});
	});
});

// ---------------------------------------------------------------------------
// loadSnapshot — 不正値の破棄(=起動時引数へのフォールバック判定)
// ---------------------------------------------------------------------------

describe('loadSnapshot — 不正値は破棄して null(起動時引数へのフォールバック判定)', () => {
	test('未保存(初回起動・新規ウインドウ・アプリ再起動後)は null', () => {
		expect(loadSnapshot()).toBeNull();
	});

	test('壊れた JSON は破棄して null(例外を漏らさない)', () => {
		sessionStorage.setItem(RELOAD_STATE_STORAGE_KEY, '{broken');
		expect(loadSnapshot()).toBeNull();
	});

	test('JSON として読めても object でないものは null', () => {
		const cases = ['42', '"snapshot"', 'null', 'true', '[]'];
		for (const raw of cases) {
			sessionStorage.setItem(RELOAD_STATE_STORAGE_KEY, raw);
			expect(loadSnapshot(), `raw=${raw}`).toBeNull();
		}
	});

	test('欠損フィールド(rootUri / docUri / expandedDirs のいずれか無し)は null', () => {
		const cases: Record<string, unknown>[] = [
			{}, // 全欠損
			{ docUri: null, expandedDirs: [] }, // rootUri 欠損
			{ rootUri: ROOT, expandedDirs: [] }, // docUri 欠損(null とは区別して破棄)
			{ rootUri: ROOT, docUri: null }, // expandedDirs 欠損
		];
		for (const obj of cases) {
			sessionStorage.setItem(RELOAD_STATE_STORAGE_KEY, JSON.stringify(obj));
			expect(loadSnapshot(), `obj=${JSON.stringify(obj)}`).toBeNull();
		}
	});

	test('型不一致(数値の rootUri / docUri・非配列や非文字列要素の expandedDirs)は null', () => {
		const cases: Record<string, unknown>[] = [
			{ rootUri: 42, docUri: null, expandedDirs: [] },
			{ rootUri: ROOT, docUri: 42, expandedDirs: [] },
			{ rootUri: ROOT, docUri: null, expandedDirs: NOTES }, // 文字列(非配列)
			{ rootUri: ROOT, docUri: null, expandedDirs: [NOTES, 42] }, // 非文字列要素
			{ rootUri: ROOT, docUri: null, expandedDirs: { 0: NOTES } }, // object(非配列)
		];
		for (const obj of cases) {
			sessionStorage.setItem(RELOAD_STATE_STORAGE_KEY, JSON.stringify(obj));
			expect(loadSnapshot(), `obj=${JSON.stringify(obj)}`).toBeNull();
		}
	});

	test('rootUri が空文字のスナップショットは null(復元先が無い=破棄)', () => {
		sessionStorage.setItem(
			RELOAD_STATE_STORAGE_KEY,
			JSON.stringify({ rootUri: '', docUri: null, expandedDirs: [] }),
		);
		expect(loadSnapshot()).toBeNull();
	});

	test('未知の追加フィールドは無視して読める(前方互換)', () => {
		sessionStorage.setItem(
			RELOAD_STATE_STORAGE_KEY,
			JSON.stringify({
				rootUri: ROOT,
				docUri: DOC,
				expandedDirs: [NOTES],
				version: 2,
				scrollTop: 100, // スコープ外の状態が紛れても3フィールドだけ返す
			}),
		);
		expect(loadSnapshot()).toEqual({ rootUri: ROOT, docUri: DOC, expandedDirs: [NOTES] });
	});

	test('読込側でも expandedDirs を正規化する(旧版・手書きの保存値への防御)', () => {
		sessionStorage.setItem(
			RELOAD_STATE_STORAGE_KEY,
			JSON.stringify({
				rootUri: ROOT,
				docUri: null,
				expandedDirs: [NOTES, NOTES, SIBLING, ROOT],
			}),
		);
		expect(loadSnapshot()?.expandedDirs).toEqual([NOTES]);

		// 全要素が root 外でもスナップショット自体は有効(root と文書の復元は進める)
		sessionStorage.setItem(
			RELOAD_STATE_STORAGE_KEY,
			JSON.stringify({ rootUri: ROOT, docUri: DOC, expandedDirs: [SIBLING, PARENT] }),
		);
		expect(loadSnapshot()).toEqual({ rootUri: ROOT, docUri: DOC, expandedDirs: [] });
	});
});

// ---------------------------------------------------------------------------
// normalizeExpandedDirs — 展開集合の正規化(境界値)
// ---------------------------------------------------------------------------

describe('normalizeExpandedDirs — 重複・root 外・境界の扱い', () => {
	test('重複を除去し、初出順を維持する', () => {
		expect(normalizeExpandedDirs(ROOT, [NOTES, DOCS, NOTES, DOCS])).toEqual([NOTES, DOCS]);
	});

	test('root 自身は展開集合に含めない(root 直下は常に表示されるため)', () => {
		expect(normalizeExpandedDirs(ROOT, [ROOT, NOTES])).toEqual([NOTES]);
	});

	test('孫ディレクトリは親が集合に無くても維持する(親子関係の刈り込みはしない)', () => {
		expect(normalizeExpandedDirs(ROOT, [DEEP])).toEqual([DEEP]);
	});

	test('root 外(兄弟・親・別スキーム)は除外する', () => {
		expect(
			normalizeExpandedDirs(ROOT, [SIBLING, PARENT, NOTES, 'https://example.com/notes']),
		).toEqual([NOTES]);
	});

	test("配下判定はセグメント境界で行う('file:///a/work' の下に 'file:///a/workspace' は入らない)", () => {
		expect(
			normalizeExpandedDirs(ROOT, [`${ROOT}space/sub`, `${ROOT}-2/sub`, NOTES]),
		).toEqual([NOTES]);
	});

	test('root の末尾スラッシュは無視して比較する', () => {
		expect(normalizeExpandedDirs(`${ROOT}/`, [NOTES, ROOT])).toEqual([NOTES]);
	});

	test('ssh:// の root でも同じ規則で判定する(URI ベースで透過)', () => {
		const sshRoot = 'ssh://alice@host/notes';
		expect(
			normalizeExpandedDirs(sshRoot, [
				'ssh://alice@host/notes/work', // 配下 → 維持
				'ssh://alice@host/repo', // 同ホスト別パス → 除外
				'ssh://other@host2/notes/work', // 別ホスト → 除外
			]),
		).toEqual(['ssh://alice@host/notes/work']);
	});

	test('空の入力は空配列(展開なしの状態も正常なスナップショット)', () => {
		expect(normalizeExpandedDirs(ROOT, [])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// clearSnapshot — 明示的な破棄
// ---------------------------------------------------------------------------

describe('clearSnapshot — スナップショットの破棄', () => {
	test('save→clear でキーごと消え、load は null に戻る', () => {
		saveSnapshot({ rootUri: ROOT, docUri: DOC, expandedDirs: [NOTES] });
		clearSnapshot();
		expect(sessionStorage.getItem(RELOAD_STATE_STORAGE_KEY)).toBeNull();
		expect(loadSnapshot()).toBeNull();
	});

	test('未保存のまま clear しても例外にしない', () => {
		expect(() => clearSnapshot()).not.toThrow();
		expect(loadSnapshot()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// shouldShowRootPicker — 履歴選択画面(要件#4)との合成
// ---------------------------------------------------------------------------

describe('shouldShowRootPicker — スナップショットと needs_root_selection の合成', () => {
	const snap = { rootUri: ROOT, docUri: null, expandedDirs: [] };

	test('スナップショットなし → needs_root_selection をそのまま返す(従来=要件#4)', () => {
		expect(shouldShowRootPicker(true, null, false)).toBe(true);
		expect(shouldShowRootPicker(false, null, false)).toBe(false);
	});

	test('スナップショットあり・復元成功 → 表示しない(引数なし起動の reload でも出さない)', () => {
		expect(shouldShowRootPicker(true, snap, true)).toBe(false);
		expect(shouldShowRootPicker(false, snap, true)).toBe(false);
	});

	test('スナップショットあり・復元失敗 → 起動時引数の挙動へフォールバック(存在だけでは抑止しない)', () => {
		expect(shouldShowRootPicker(true, snap, false)).toBe(true);
		expect(shouldShowRootPicker(false, snap, false)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// restoreSnapshot — 既存コマンド再利用の復元と失敗時フォールバック
// ---------------------------------------------------------------------------

describe('restoreSnapshot — set_root → open_document と失敗時フォールバック', () => {
	const snapWithDoc = { rootUri: ROOT, docUri: DOC, expandedDirs: [NOTES] };
	const rootPayload = { root_uri: ROOT, entries: [], document_retained: false };
	const docPayload = { uri: DOC, content: '# plan', modified: null };

	test('set_root → open_document の順に既存コマンドを呼び、両方の解決値を返す', async () => {
		invokeMock.mockResolvedValueOnce(rootPayload).mockResolvedValueOnce(docPayload);

		const res = await restoreSnapshot(snapWithDoc);

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root', 'open_document']);
		expect(invokeMock.mock.calls[0]?.[1]).toEqual({ uri: ROOT });
		expect(invokeMock.mock.calls[1]?.[1]).toEqual({ uri: DOC });
		expect(res).toMatchObject({ ok: true });
		if (res.ok) {
			expect(res.root).toEqual(rootPayload);
			expect(res.document).toEqual(docPayload);
		}
	});

	test('docUri=null なら open_document は呼ばず document:null で成功する', async () => {
		invokeMock.mockResolvedValueOnce(rootPayload);

		const res = await restoreSnapshot({ rootUri: ROOT, docUri: null, expandedDirs: [] });

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root']);
		expect(res).toMatchObject({ ok: true, document: null });
		if (res.ok) expect(res.root).toEqual(rootPayload);
	});

	test('set_root 失敗(root 消滅等)→ {ok:false} に解決し、open_document は呼ばない', async () => {
		invokeMock.mockRejectedValueOnce(new Error('no such directory'));

		// reject せず fallback 判定として解決する(起動時引数の挙動へ全体フォールバック)
		await expect(restoreSnapshot(snapWithDoc)).resolves.toMatchObject({ ok: false });
		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root']);
	});

	test('open_document 失敗(ファイル消滅)→ root は復元したまま document:null(部分フォールバック)', async () => {
		invokeMock
			.mockResolvedValueOnce(rootPayload)
			.mockRejectedValueOnce(new Error('no such file'));

		const res = await restoreSnapshot(snapWithDoc);

		expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(['set_root', 'open_document']);
		expect(res).toMatchObject({ ok: true, document: null });
		if (res.ok) expect(res.root).toEqual(rootPayload);
	});
});
