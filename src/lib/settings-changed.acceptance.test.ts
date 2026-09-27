/**
 * 要件#65 の受け入れテスト(docs/requirements/req-65.md)— フロント側(unit 層)
 * AC-65-12「保存後の読み直し」のフロント面:
 * - フロントのイベント名定数が Rust の `settings::SETTINGS_CHANGED_EVENT` と同じ値 `settings_changed`
 * - `+page.svelte` がそのイベントを `listen` して、ツリーを読み直す関数 `reloadTree` を呼ぶ
 *   (root と展開中のフォルダを `list_dir` で読み直し、`applyDirectoryEvent` で当てる=展開状態は保つ)
 * - フロントに除外の照合(glob)の実装が無い(照合は Rust の 1 か所だけ=契約7)
 *
 * ## 配線に求める契約(implementer はこれに従う=本テストが前提にする名前・パス)
 * - 新規 `src/lib/settings.ts`(`$lib/settings`):
 *   - `export const SETTINGS_CHANGED_EVENT = 'settings_changed'`(Rust の `settings.rs` と同綴り)
 *   - `export type TreeReloadIo<E> = { listDir: (uri: string) => Promise<E[]>; apply: (uri: string, entries: E[]) => void }`
 *   - `export async function reloadTree<E>(rootUri: string, expandedDirs: readonly string[], io: TreeReloadIo<E>): Promise<void>`
 *     = root が空文字(未選択)なら何もしない。そうでなければ root → 展開中フォルダの順に `io.listDir(uri)` を呼び、
 *     戻った一覧を `io.apply(uri, entries)` で当てる(root は `apply(root, entries)`)。1 つの `listDir` が reject
 *     しても他は当て、例外を外へ出さない(resolve する)。`expandedDirs` は変更しない
 * - `+page.svelte`: `import { SETTINGS_CHANGED_EVENT, reloadTree } from '$lib/settings'` し、
 *   他のイベントと同じく `$lib/events` の `listen(SETTINGS_CHANGED_EVENT, …)` で購読、ハンドラの中で
 *   `reloadTree(windowState.root, windowState.expandedDirs, { listDir: (uri) => invoke('list_dir', { uri }),
 *   apply: (uri, entries) => windowState.applyDirectoryEvent(uri, entries) })` を呼ぶ
 *   (`'list_dir'` と `applyDirectoryEvent` の字面は +page.svelte か settings.ts のどちらかにあればよい)
 * - フロントは glob を実装しない: src/ の非テストコードに名前に `glob` を含む関数定義が無く、
 *   設定キー `files.exclude` / `search.exclude` の文字列リテラルも無い(キーは Rust の持ち物)
 *
 * 通しの体験(保存したら開いている全窓のツリーが変わる)は人間ゲート 4〜6。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { SETTINGS_CHANGED_EVENT, reloadTree } from './settings';

const SRC_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(__dirname, '../..');

const page = () => readFileSync(resolve(SRC_ROOT, 'routes/+page.svelte'), 'utf-8');
const settingsRs = () => readFileSync(resolve(REPO_ROOT, 'src-tauri/src/settings.rs'), 'utf-8');

/** `start` の位置にある `(` に対応する閉じ括弧までの呼び出し全体。 */
function balancedCall(src: string, start: number): string {
	const open = src.indexOf('(', start);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '(' || c === '[' || c === '{') depth += 1;
		else if (c === ')' || c === ']' || c === '}') {
			depth -= 1;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced call at ${start}`);
}

/** src/ 配下の非テストの .ts / .svelte(テスト・フィクスチャ・型定義は除く)。 */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir, { withFileTypes: true })) {
		const full = resolve(dir, name.name);
		if (name.isDirectory()) {
			if (name.name === '__fixtures__' || name.name === 'node_modules') continue;
			out.push(...sourceFiles(full));
			continue;
		}
		if (!/\.(ts|svelte)$/.test(name.name)) continue;
		if (/\.(test|spec)\.ts$/.test(name.name) || name.name.endsWith('.d.ts')) continue;
		out.push(full);
	}
	return out;
}

type FakeEntry = { uri: string; name: string; kind: 'file' | 'dir' | 'symlink' };

function fakeIo(listings: Record<string, FakeEntry[] | Error>) {
	const listed: string[] = [];
	const applied: { uri: string; entries: FakeEntry[] }[] = [];
	const io = {
		listDir: vi.fn(async (uri: string) => {
			listed.push(uri);
			const result = listings[uri];
			if (result instanceof Error) throw result;
			return result ?? [];
		}),
		apply: vi.fn((uri: string, entries: FakeEntry[]) => {
			applied.push({ uri, entries });
		}),
	};
	return { io, listed, applied };
}

const ROOT = 'file:///Users/x/notes';
const A = `${ROOT}/a`;
const B = `${ROOT}/b`;
const entriesOf = (uri: string): FakeEntry[] => [{ uri: `${uri}/x.md`, name: 'x.md', kind: 'file' }];

// ---------------------------------------------------------------------------
// AC-65-12 — イベント名(Rust と同じ値)
// ---------------------------------------------------------------------------

describe('AC-65-12: SETTINGS_CHANGED_EVENT は Rust の settings.rs と同じ値(契約7)', () => {
	test('値は settings_changed', () => {
		expect(SETTINGS_CHANGED_EVENT).toBe('settings_changed');
	});

	test('Rust 側の宣言と同綴り(src-tauri/src/settings.rs の pub const)', () => {
		const rs = settingsRs();
		const m = rs.match(/pub const SETTINGS_CHANGED_EVENT: &str = "([^"]+)";/);
		expect(m, 'settings.rs must declare SETTINGS_CHANGED_EVENT').toBeTruthy();
		expect(m?.[1]).toBe(SETTINGS_CHANGED_EVENT);
	});
});

// ---------------------------------------------------------------------------
// AC-65-12 — reloadTree(root と展開中のフォルダを読み直す・展開状態は保つ)
// ---------------------------------------------------------------------------

describe('AC-65-12: reloadTree は root と展開中のフォルダを list_dir で読み直して当てる(契約7)', () => {
	test('root → 展開中フォルダの順に listDir し、それぞれの一覧を apply(uri, entries) で当てる', async () => {
		const { io, listed, applied } = fakeIo({ [ROOT]: entriesOf(ROOT), [A]: entriesOf(A), [B]: entriesOf(B) });
		const expanded = [A, B];

		await reloadTree(ROOT, expanded, io);

		expect(listed).toEqual([ROOT, A, B]);
		expect(applied).toEqual([
			{ uri: ROOT, entries: entriesOf(ROOT) },
			{ uri: A, entries: entriesOf(A) },
			{ uri: B, entries: entriesOf(B) },
		]);
		expect(expanded, 'expandedDirs is not mutated').toEqual([A, B]);
	});

	test('展開が無ければ root だけ読み直す', async () => {
		const { io, listed, applied } = fakeIo({ [ROOT]: entriesOf(ROOT) });

		await reloadTree(ROOT, [], io);

		expect(listed).toEqual([ROOT]);
		expect(applied).toEqual([{ uri: ROOT, entries: entriesOf(ROOT) }]);
	});

	test('root が空(未選択)なら何もしない', async () => {
		const { io, listed, applied } = fakeIo({});

		await reloadTree('', [A], io);

		expect(listed).toEqual([]);
		expect(applied).toEqual([]);
	});

	test('1 つの listDir が失敗しても他は当て、例外を外へ出さない', async () => {
		const { io, listed, applied } = fakeIo({
			[ROOT]: entriesOf(ROOT),
			[A]: new Error('gone'),
			[B]: entriesOf(B),
		});

		await expect(reloadTree(ROOT, [A, B], io)).resolves.toBeUndefined();

		expect(listed).toEqual([ROOT, A, B]);
		expect(applied).toEqual([
			{ uri: ROOT, entries: entriesOf(ROOT) },
			{ uri: B, entries: entriesOf(B) },
		]);
	});
});

// ---------------------------------------------------------------------------
// AC-65-12 — +page.svelte の配線(ソース走査)
// ---------------------------------------------------------------------------

describe('AC-65-12(ソース走査): +page.svelte が settings_changed を listen して reloadTree を呼ぶ(契約7)', () => {
	test('SETTINGS_CHANGED_EVENT と reloadTree を $lib/settings から import する', () => {
		const src = page();
		expect(src).toMatch(/import\s*\{[^}]*SETTINGS_CHANGED_EVENT[^}]*\}\s*from\s*'\$lib\/settings'/);
		expect(src).toMatch(/import\s*\{[^}]*\breloadTree\b[^}]*\}\s*from\s*'\$lib\/settings'/);
	});

	test('listen(SETTINGS_CHANGED_EVENT, …) の中で reloadTree(…) を呼ぶ(イベント名のインライン綴りは無い)', () => {
		const src = page();
		const m = /listen(?:<[^>]*>)?\(\s*SETTINGS_CHANGED_EVENT\s*,/.exec(src);
		expect(m, '+page.svelte must listen(SETTINGS_CHANGED_EVENT, …)').toBeTruthy();
		const call = balancedCall(src, m!.index);
		expect(call).toMatch(/\breloadTree\(/);
		expect(src).not.toMatch(/['"]settings_changed['"]/);
	});

	test('読み直しは list_dir と applyDirectoryEvent(展開状態を保つ経路)で行う', () => {
		const combined = page() + '\n' + readFileSync(resolve(SRC_ROOT, 'lib/settings.ts'), 'utf-8');
		expect(combined).toMatch(/['"]list_dir['"]/);
		expect(combined).toMatch(/applyDirectoryEvent/);
	});
});

// ---------------------------------------------------------------------------
// AC-65-12 — フロントに glob の実装が無い(照合は Rust の 1 か所)
// ---------------------------------------------------------------------------

describe('AC-65-12: フロントに除外の照合(glob)の実装が無い(契約7)', () => {
	test('src/ の非テストコードに名前に glob を含む関数定義が無い', () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(SRC_ROOT)) {
			const src = readFileSync(file, 'utf-8');
			if (/\bfunction\s+\w*glob\w*\s*\(/i.test(src) || /\b(?:const|let|var)\s+\w*glob\w*\s*=\s*(?:async\s*)?(?:\(|function\b)/i.test(src)) {
				offenders.push(file.slice(SRC_ROOT.length + 1));
			}
		}
		expect(offenders).toEqual([]);
	});

	test('設定キー files.exclude / search.exclude の文字列リテラルがフロントに無い(キーは Rust の持ち物)', () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(SRC_ROOT)) {
			const src = readFileSync(file, 'utf-8');
			if (/['"`](?:files|search)\.exclude['"`]/.test(src)) offenders.push(file.slice(SRC_ROOT.length + 1));
		}
		expect(offenders).toEqual([]);
	});

	test('検索パネルとその純関数は文字列を渡すだけ(照合のための RegExp を組み立てない)', () => {
		for (const rel of ['components/FindInFolder.svelte', 'lib/find-in-folder.ts', 'lib/settings.ts']) {
			const src = readFileSync(resolve(SRC_ROOT, rel), 'utf-8');
			expect(src, rel).not.toMatch(/new RegExp\(/);
		}
	});
});
