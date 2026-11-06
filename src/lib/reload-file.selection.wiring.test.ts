/**
 * 要件#80 追補a の受け入れテスト(docs/requirements/req-80.md「追補a」)— ツリーの選択を保つ
 * AC-80-19 (1)〜(5)(契約 3 追補a)
 *
 * 「テキスト系の Reload File の当て方はツリーの選択(`windowState.selectedTreeUri`)を変えない。
 *  フォルダの行・開けない種類のファイルの行を選んでいたら、読み直しの後もその行のまま。
 *  行を押して開き直すとき・別の文書を開くとき(`setDocument`)は今のまま(要件#60 起案時判断 (a))」
 *
 * runes を含む `stores/window-state.svelte.ts` は svelte プラグインの効く component プロジェクト
 * (*.wiring.test.ts)でしかコンパイルできないため、ここに置く(close-window.wiring.test.ts と同じ家風)。
 * 実行列(`createFileReloader`)の純ロジックは reload-file.acceptance.test.ts(unit 側)。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする名前。作りの選択=2026-11-05 由谷)
 *
 * ```ts
 * // src/stores/window-state.svelte.ts の WindowState に足す
 * class WindowState {
 *   /** 同じ URI の文書の中身を差し替える(Reload File のテキスト系の当て方=契約 3 追補a)。
 *    *  `setDocument` と違い `selectedTreeUri` に触らない。編集状態は `setDocument` の
 *    *  同じ URI の扱いと同じ(畳まない)。 *\/
 *   applyReloadedText(doc: DocumentPayload): void;
 * }
 * // src/routes/+page.svelte の createFileReloader({...}) の applyText は
 * //   applyText: (doc) => windowState.applyReloadedText(doc)
 * // を通す(setDocument を通さない)。setDocument 自体は変えない(selectedTreeUri を null に戻す)
 * ```
 *
 * ## 判定するもの
 * - (1) `selectTreeItem('file:///r/d')` の後に同じ URI の文書で `applyReloadedText` →
 *   `currentDocument` は新しい中身・`selectedTreeUri` は `'file:///r/d'` のまま(`selectedUri` も)
 * - (2) `selectedTreeUri` が null のときは null のまま(`selectedUri` は文書の URI のまま)
 * - (3) 編集状態は畳まない(`setDocument` の同じ URI の扱いと同じ=editMode / editBuffer / lastSavedHash /
 *   externalChange / externalRemoved が、同じ列を `setDocument` で通したときと一致する)
 * - (4) `setDocument` はこれまでどおり `selectedTreeUri` を null に戻す(同じ URI でも・別の URI でも。
 *   要件#60 を退行させない=このケースは最初から緑の見込み)
 * - (5) `+page.svelte` の `createFileReloader(` の呼び出しの `applyText` が `windowState.applyReloadedText(`
 *   を通り、呼び出しの中に `setDocument(` が無い(ソース走査=Viewer.external-removed.wiring.test.ts の家風)
 *
 * ## 判定しないもの
 * - 実行列が `applyText` を呼ぶ条件(テキスト系だけ・stale なら呼ばない)→ reload-file.acceptance.test.ts
 * - 別の URI の文書で `applyReloadedText` を呼んだとき(実行列が `current() === uri` で守るので起きない。
 *   追補a の AC の範囲外=固定しない)
 * - 外の変更の自動追従(`applyFileChanged`)とバイナリの Reload File が選択を触らないこと(既存の作り。
 *   追補a は「それに揃える」であり、こちらは変えない)
 * - 実機でフォルダの行の見え方が残ること → 人間ゲート(事後確認 7 は由谷が実機で確認済み)
 *
 * ## 判断の記録(test-writer 2026-11-05)
 * - (3) の「`setDocument` の同じ URI の扱いと同じ」は、同じ編集の列(beginEdit → updateBuffer → 外部版を脇に置く)
 *   を 2 回組み、片方を `setDocument`・片方を `applyReloadedText` で当てて編集の 5 つの状態を突き合わせる。
 *   あわせて editMode が 'edit' のまま・editBuffer が編集中の中身のままであることを直に見る(空の一致にしない)
 * - (5) は `createFileReloader(` の引数全体を括弧の対応で切り出し、`applyText` の値だけを次のキーまでで切る
 *   (キーの並びが変わっても効く)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { windowState, type DocumentPayload, type Entry } from '../stores/window-state.svelte';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const ROOT = 'file:///r';
const DIR = 'file:///r/d';
const DOC_URI = 'file:///r/a.md';
const OTHER_URI = 'file:///r/b.md';

const ROOT_ENTRIES: Entry[] = [
	{ uri: DIR, name: 'd', kind: 'dir' },
	{ uri: DOC_URI, name: 'a.md', kind: 'file' },
	{ uri: OTHER_URI, name: 'b.md', kind: 'file' },
];

function doc(uri: string, content: string, modified: number | null = 1): DocumentPayload {
	return { uri, content, modified };
}

const OLD = doc(DOC_URI, '# old\n', 1);
const FRESH = doc(DOC_URI, '# fresh\n', 2);

/** 店を素の状態へ戻す(root を当てて文書を閉じる=既存の入口だけで戻す)。 */
function resetStore(): void {
	windowState.applyRoot(ROOT, ROOT_ENTRIES, false);
	windowState.clearDocument();
}

/** 編集に関わる 5 つの状態の写し(突き合わせ用)。 */
function editSnapshot() {
	return {
		editMode: windowState.editMode,
		editBuffer: windowState.editBuffer,
		lastSavedHash: windowState.lastSavedHash,
		externalChange: windowState.externalChange,
		externalRemoved: windowState.externalRemoved,
	};
}

/**
 * 同じ URI の文書を開いて編集中にする列(両方の当て方で同じに組む)。
 * beginEdit → updateBuffer(dirty)→ markSaved(lastSavedHash を持つ)→ 外部版を脇に置く(externalChange)。
 */
function enterEditingState(): void {
	windowState.setDocument(OLD);
	expect(windowState.beginEdit(), 'a.md は編集に入れる').toBe(true);
	windowState.updateBuffer('# edited\n');
	windowState.markSaved('# saved\n');
	windowState.updateBuffer('# edited again\n');
	expect(windowState.applyFileChanged(doc(DOC_URI, '# from outside\n', 3))).toBe('external-conflict');
	expect(windowState.editMode).toBe('edit');
	expect(windowState.dirty).toBe(true);
	expect(windowState.externalChange).not.toBeNull();
}

beforeEach(() => {
	resetStore();
});

afterEach(() => {
	resetStore();
});

// ---------------------------------------------------------------------------
// AC-80-19 (1)(2) — 選択を保つ
// ---------------------------------------------------------------------------

describe("AC-80-19 (1): selectTreeItem('file:///r/d') の後に同じ URI の文書で applyReloadedText → 中身は新しく・選択はフォルダの行のまま", () => {
	it('currentDocument は新しい中身(content・modified)になる', () => {
		windowState.setDocument(OLD);
		windowState.selectTreeItem(DIR);

		windowState.applyReloadedText(FRESH);

		expect(windowState.currentDocument).toEqual(FRESH);
		expect(windowState.currentDocument?.content).toBe('# fresh\n');
		expect(windowState.currentDocument?.modified).toBe(2);
	});

	it("selectedTreeUri は 'file:///r/d' のまま・selectedUri(Explorer が active を付ける先)もそのまま", () => {
		windowState.setDocument(OLD);
		windowState.selectTreeItem(DIR);
		expect(windowState.selectedUri).toBe(DIR);

		windowState.applyReloadedText(FRESH);

		expect(windowState.selectedTreeUri).toBe(DIR);
		expect(windowState.selectedUri).toBe(DIR);
	});

	it('開けない種類のファイルの行(要件#60 契約⑤)を選んでいても同じ=その行のまま', () => {
		const UNOPENABLE = 'file:///r/archive.zip';
		windowState.setDocument(OLD);
		windowState.selectTreeItem(UNOPENABLE);

		windowState.applyReloadedText(FRESH);

		expect(windowState.currentDocument).toEqual(FRESH);
		expect(windowState.selectedTreeUri).toBe(UNOPENABLE);
	});

	it('2 回続けて読み直しても選択は残る(1 回目で消えて 2 回目だけ残る、ではない)', () => {
		windowState.setDocument(OLD);
		windowState.selectTreeItem(DIR);

		windowState.applyReloadedText(FRESH);
		windowState.applyReloadedText(doc(DOC_URI, '# fresher\n', 3));

		expect(windowState.currentDocument?.content).toBe('# fresher\n');
		expect(windowState.selectedTreeUri).toBe(DIR);
	});
});

describe('AC-80-19 (2): selectedTreeUri が null(選択は文書に従う)なら null のまま', () => {
	it('null のまま・selectedUri は文書の URI のまま・中身は新しくなる', () => {
		windowState.setDocument(OLD);
		expect(windowState.selectedTreeUri).toBeNull();
		expect(windowState.selectedUri).toBe(DOC_URI);

		windowState.applyReloadedText(FRESH);

		expect(windowState.selectedTreeUri).toBeNull();
		expect(windowState.selectedUri).toBe(DOC_URI);
		expect(windowState.currentDocument).toEqual(FRESH);
	});
});

// ---------------------------------------------------------------------------
// AC-80-19 (3) — 編集状態は畳まない(setDocument の同じ URI の扱いと同じ)
// ---------------------------------------------------------------------------

describe('AC-80-19 (3): 編集状態は畳まない(setDocument の同じ URI の扱いと同じ)', () => {
	it('編集中(dirty・外部版を脇に置いた状態)に同じ URI で applyReloadedText → editMode は edit のまま・editBuffer は編集中の中身のまま', () => {
		enterEditingState();
		windowState.selectTreeItem(DIR);

		windowState.applyReloadedText(FRESH);

		expect(windowState.editMode).toBe('edit');
		expect(windowState.editBuffer).toBe('# edited again\n');
		expect(windowState.currentDocument).toEqual(FRESH);
		expect(windowState.selectedTreeUri).toBe(DIR);
	});

	it('編集の 5 つの状態(editMode / editBuffer / lastSavedHash / externalChange / externalRemoved)が、同じ列を setDocument で当てたときと一致する', () => {
		enterEditingState();
		windowState.setDocument(FRESH);
		const viaSetDocument = editSnapshot();
		resetStore();

		enterEditingState();
		windowState.applyReloadedText(FRESH);
		const viaReloadedText = editSnapshot();

		expect(viaReloadedText).toEqual(viaSetDocument);
		// 突き合わせが空の一致(両方とも畳んだ)になっていないことを直に見る。
		expect(viaReloadedText.editMode).toBe('edit');
		expect(viaReloadedText.editBuffer).toBe('# edited again\n');
		expect(viaReloadedText.lastSavedHash).not.toBeNull();
		expect(viaReloadedText.externalChange).not.toBeNull();
	});

	it('閲覧中(view)に当てても view のまま・editBuffer は null のまま', () => {
		windowState.setDocument(OLD);
		windowState.selectTreeItem(DIR);

		windowState.applyReloadedText(FRESH);

		expect(windowState.editMode).toBe('view');
		expect(windowState.editBuffer).toBeNull();
		expect(windowState.dirty).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-80-19 (4) — setDocument はこれまでどおり選択を null に戻す(要件#60 を退行させない)
// ---------------------------------------------------------------------------

describe('AC-80-19 (4): setDocument はこれまでどおり selectedTreeUri を null に戻す(要件#60 起案時判断 (a))', () => {
	it('同じ URI の文書で setDocument(行を押して開き直す)→ null', () => {
		windowState.setDocument(OLD);
		windowState.selectTreeItem(DIR);

		windowState.setDocument(FRESH);

		expect(windowState.selectedTreeUri).toBeNull();
		expect(windowState.selectedUri).toBe(DOC_URI);
		expect(windowState.currentDocument).toEqual(FRESH);
	});

	it('別の文書で setDocument(別の文書を開く)→ null・selectedUri はその文書', () => {
		windowState.setDocument(OLD);
		windowState.selectTreeItem(DIR);

		windowState.setDocument(doc(OTHER_URI, '# b\n'));

		expect(windowState.selectedTreeUri).toBeNull();
		expect(windowState.selectedUri).toBe(OTHER_URI);
	});

	it('applyReloadedText で残した選択も、その後の setDocument で null に戻る(残り続けない)', () => {
		windowState.setDocument(OLD);
		windowState.selectTreeItem(DIR);
		windowState.applyReloadedText(FRESH);
		expect(windowState.selectedTreeUri).toBe(DIR);

		windowState.setDocument(doc(OTHER_URI, '# b\n'));

		expect(windowState.selectedTreeUri).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC-80-19 (5) — +page.svelte の配線(ソース走査)
// ---------------------------------------------------------------------------

const PAGE_PATH = resolve(__dirname, '../routes/+page.svelte');
const STORE_PATH = resolve(__dirname, '../stores/window-state.svelte.ts');

/** コメント(行・ブロック)を落とす(コメントの中の語を数えない)。 */
function stripJsComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** `open`(`(` の位置)から対応する `)` までの中身。 */
function parenBody(src: string, open: number, what: string): string {
	expect(open, `${what}: opening paren`).toBeGreaterThanOrEqual(0);
	expect(src[open], `${what}: opening paren`).toBe('(');
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '(') depth++;
		else if (src[i] === ')') {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	throw new Error(`${what}: unbalanced parens`);
}

/** `createFileReloader(` の呼び出しの引数全体(+page.svelte に 1 回=AC-80-14 が固定)。 */
function fileReloaderCall(): string {
	const src = stripJsComments(readFileSync(PAGE_PATH, 'utf8'));
	const at = src.indexOf('createFileReloader(');
	expect(at, 'createFileReloader( in +page.svelte').toBeGreaterThanOrEqual(0);
	return parenBody(src, at + 'createFileReloader'.length, 'createFileReloader(…)');
}

/**
 * オブジェクトリテラルの `key:` の値の字面(次のキー `,\n<空白><識別子>:` か末尾まで)。
 * キーの並びが変わっても、その値だけを切り出せる。
 */
function propertyValue(objectBody: string, key: string): string {
	const m = new RegExp(`\\b${key}\\s*:`).exec(objectBody);
	expect(m, `${key}: in createFileReloader({…})`).not.toBeNull();
	const start = (m as RegExpExecArray).index + (m as RegExpExecArray)[0].length;
	const rest = objectBody.slice(start);
	const next = /,\s*\n\s*[A-Za-z_$][\w$]*\s*:/.exec(rest);
	return next ? rest.slice(0, next.index) : rest;
}

describe('AC-80-19 (5): +page.svelte の Reload File の applyText が windowState.applyReloadedText を通る(ソース走査)', () => {
	it('createFileReloader({…}) の applyText の値に windowState.applyReloadedText( がある', () => {
		const applyText = propertyValue(fileReloaderCall(), 'applyText');
		expect(applyText).toContain('windowState.applyReloadedText(');
	});

	it('createFileReloader({…}) の呼び出しの中に setDocument( が無い(読み直しの当て方は setDocument を通さない)', () => {
		expect(fileReloaderCall()).not.toContain('setDocument(');
	});

	it('window-state.svelte.ts に applyReloadedText( のメソッドがあり、本体は selectedTreeUri に触らない', () => {
		const src = stripJsComments(readFileSync(STORE_PATH, 'utf8'));
		const at = src.search(/\bapplyReloadedText\s*\(/);
		expect(at, 'applyReloadedText( in window-state.svelte.ts').toBeGreaterThanOrEqual(0);
		const open = src.indexOf('{', src.indexOf(')', at));
		expect(open, 'applyReloadedText body').toBeGreaterThanOrEqual(0);
		let depth = 0;
		let body = '';
		for (let i = open; i < src.length; i++) {
			if (src[i] === '{') depth++;
			else if (src[i] === '}') {
				depth--;
				if (depth === 0) {
					body = src.slice(open + 1, i);
					break;
				}
			}
		}
		expect(body, 'applyReloadedText body').not.toBe('');
		expect(body).not.toMatch(/\bselectedTreeUri\s*=/);
	});
});
