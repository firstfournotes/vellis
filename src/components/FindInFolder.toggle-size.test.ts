/**
 * 要件#66 追補a(2026-10-11・backlog 324)の受け入れテスト AC-66-追a (d)= トグルの寸法。
 *
 * ## 判定するもの(契約(追補a)4= req-66.md)
 * `FindInFolder.svelte` の `<style>` で、3トグル(`class="find-in-folder-icon-button
 * find-in-folder-match-toggle"` の `<button>`)に**最後に効く** width / height / font-size が
 * 20px / 20px / 11px であること。歯車(`find-in-folder-icon-button
 * find-in-folder-use-exclude-settings`)の width / height=20px も同じ判定で保たれること。
 *
 * ## 判定の仕方(カスケードの手計算)
 * jsdom の `getComputedStyle` は `<style>` のカスケードを正しく計算しないので、`<style>` の
 * テキストから規則を拾い、要素の class の組に対して「どの規則が当たるか」を単純な
 * クラス・属性・要素名セレクタの一致で決め、CSS の優先順位で勝者を選ぶ:
 * - `!important` が最優先
 * - 次に詳細度(id / class+属性+擬似クラス / 要素名)
 * - 同じ詳細度なら**後に書かれた規則**が勝つ
 * 既定の状態(ホバーしていない・フォーカスしていない・`aria-pressed="false"`)で判定するので、
 * `:hover` / `:focus-visible` などの擬似クラスや `[aria-pressed='true']` の付いたセレクタは
 * 当たらない。そのかわり、そうした「状態のときだけ当たる規則」が width / height / font-size を
 * 持たないことも別に確かめる(状態で寸法が変わる作りにしない)。
 * 子孫結合子(空白 / `>`)のあるセレクタは、右端の compound を要素に、残りを祖先の class の
 * 集合(マークアップから取った)に当てる。
 *
 * ## 想定される赤(実装前)
 * `.find-in-folder-match-toggle { width/height: 20px; font-size: 11px }` が、同じ詳細度で後に
 * 書かれた `.find-in-folder-icon-button { 22px; 12px }` に負けている → トグルの勝者が
 * 22px / 22px / 12px になって赤。歯車(`.find-in-folder-use-exclude-settings` は後ろにある)と
 * 「状態の規則が寸法を持たない」は今も緑(不変の固定)。
 *
 * ## 判定しないもの
 * - 実寸(E2E `req66-find-in-folder-gate.e2e.ts` の人間ゲート 1 の測り)・押し込んだ見た目・
 *   並び・位置・文字(契約(追補a)4 の「不変」は既存の `FindInFolder.wiring.test.ts` と E2E が見る)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FIND_IN_FOLDER_PATH = resolve(__dirname, 'FindInFolder.svelte');

const ICON_BUTTON = 'find-in-folder-icon-button';
const MATCH_TOGGLE = 'find-in-folder-match-toggle';
const USE_EXCLUDE_SETTINGS = 'find-in-folder-use-exclude-settings';

/** 寸法として見る宣言。 */
const SIZE_PROPS = ['width', 'height', 'font-size'] as const;
type SizeProp = (typeof SIZE_PROPS)[number];

// ---------------------------------------------------------------------------
// 要素のモデル(マークアップから取る)
// ---------------------------------------------------------------------------

/** 既定の状態の要素。`attrs` は属性名 → 値(aria-pressed は初期値 "false")。 */
type Element = {
	tag: string;
	classes: ReadonlySet<string>;
	attrs: ReadonlyMap<string, string>;
	/** 祖先の class の和集合(子孫結合子の左側に当てる)。 */
	ancestorClasses: ReadonlySet<string>;
};

/** 3トグルの祖先(マークアップ: .find-in-folder > .find-in-folder-query > .find-in-folder-query-row > .find-in-folder-field-box.find-in-folder-query-box > .find-in-folder-match-toggles)。 */
const TOGGLE_ANCESTORS = new Set([
	'find-in-folder',
	'find-in-folder-query',
	'find-in-folder-query-row',
	'find-in-folder-field-box',
	'find-in-folder-query-box',
	'find-in-folder-match-toggles',
]);

/** 歯車の祖先(.find-in-folder > .find-in-folder-query > .find-in-folder-details > .find-in-folder-field > .find-in-folder-field-box)。 */
const GEAR_ANCESTORS = new Set([
	'find-in-folder',
	'find-in-folder-query',
	'find-in-folder-details',
	'find-in-folder-field',
	'find-in-folder-field-box',
]);

const TOGGLE: Element = {
	tag: 'button',
	classes: new Set([ICON_BUTTON, MATCH_TOGGLE]),
	attrs: new Map([
		['type', 'button'],
		['aria-pressed', 'false'],
	]),
	ancestorClasses: TOGGLE_ANCESTORS,
};

const GEAR: Element = {
	tag: 'button',
	classes: new Set([ICON_BUTTON, USE_EXCLUDE_SETTINGS]),
	attrs: new Map([
		['type', 'button'],
		['aria-pressed', 'true'], // 既定 ON(要件#65 契約13)
	]),
	ancestorClasses: GEAR_ANCESTORS,
};

// ---------------------------------------------------------------------------
// CSS の整形(Explorer.symlink-contrast.wiring.test.ts と同じ作法)
// ---------------------------------------------------------------------------

type Decl = { prop: string; value: string; important: boolean };
type Rule = { order: number; selector: string; declarations: Decl[] };

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** セレクタリストを、括弧の中のカンマでは切らずに1つずつへ分ける。 */
function splitSelectorList(selector: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of selector) {
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			out.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0);
}

/**
 * 規則を書かれた順に並べる。セレクタリストは1セレクタ1規則へ展開する(順序は同じ)。
 * `@media` などの入れ子は、内側の規則だけを拾う(条件は見ない=常に当たる扱い)。
 */
function rulesOf(css: string): Rule[] {
	const rules: Rule[] = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let order = 0;
	for (let r = re.exec(css); r !== null; r = re.exec(css)) {
		const selectorText = r[1].trim();
		if (selectorText.startsWith('@')) continue;
		const declarations = r[2]
			.split(';')
			.map((d) => d.trim())
			.filter((d) => d.length > 0 && d.includes(':'))
			.map((d) => {
				const idx = d.indexOf(':');
				const raw = d.slice(idx + 1).trim();
				const important = /!important$/i.test(raw);
				return {
					prop: d.slice(0, idx).trim().toLowerCase(),
					value: raw.replace(/!important$/i, '').replace(/\s+/g, '').toLowerCase(),
					important,
				};
			});
		for (const selector of splitSelectorList(selectorText)) {
			rules.push({ order: order++, selector, declarations });
		}
	}
	return rules;
}

function findInFolderSource(): string {
	return readFileSync(FIND_IN_FOLDER_PATH, 'utf8');
}

function findInFolderRules(): Rule[] {
	const m = findInFolderSource().match(/<style[^>]*>([\s\S]*?)<\/style>/);
	expect(m, 'FindInFolder.svelte has a <style> block').not.toBeNull();
	return rulesOf(stripCssComments(m![1]));
}

// ---------------------------------------------------------------------------
// セレクタの一致と詳細度
// ---------------------------------------------------------------------------

type Compound = {
	tag: string | null;
	classes: string[];
	/** 属性セレクタ: `[name]` は値 null・`[name='v']` / `[name="v"]` / `[name=v]` は値あり。 */
	attrs: { name: string; value: string | null }[];
	pseudos: string[];
	ids: string[];
};

/** `button.a.b[aria-pressed='true']:hover` のような compound を分解する。 */
function parseCompound(text: string): Compound {
	const c: Compound = { tag: null, classes: [], attrs: [], pseudos: [], ids: [] };
	const re = /([a-zA-Z][\w-]*|\*)|\.([\w-]+)|#([\w-]+)|\[\s*([\w-]+)\s*(?:=\s*(?:'([^']*)'|"([^"]*)"|([^\]\s]+)))?\s*\]|::?([\w-]+)(\([^)]*\))?/g;
	let consumed = 0;
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		expect(m.index, `unparsed selector text in "${text}"`).toBe(consumed);
		consumed = m.index + m[0].length;
		if (m[1] !== undefined) c.tag = m[1] === '*' ? null : m[1].toLowerCase();
		else if (m[2] !== undefined) c.classes.push(m[2]);
		else if (m[3] !== undefined) c.ids.push(m[3]);
		else if (m[4] !== undefined) c.attrs.push({ name: m[4].toLowerCase(), value: m[5] ?? m[6] ?? m[7] ?? null });
		else if (m[8] !== undefined) c.pseudos.push(m[8].toLowerCase());
	}
	expect(consumed, `unparsed selector text in "${text}"`).toBe(text.length);
	return c;
}

/** 結合子(空白 / `>` / `+` / `~`)で compound に分ける。右端が要素そのものに当たる側。 */
function splitCompounds(selector: string): string[] {
	return selector
		.replace(/\s*([>+~])\s*/g, ' $1 ')
		.split(/\s+/)
		.filter((s) => s.length > 0 && !/^[>+~]$/.test(s));
}

/**
 * 「状態のときだけ当たる」部分を持つか= 擬似クラス(`:hover` / `:focus-visible` …)か
 * `aria-pressed` の属性セレクタ(ON / OFF のどちらの値でも状態の規則と見る。寸法は
 * 押した状態に依らないのが契約)。
 */
function isStateful(c: Compound): boolean {
	return c.pseudos.length > 0 || c.attrs.some((a) => a.name === 'aria-pressed');
}

/** 既定の状態の要素にこの compound が当たるか(擬似クラスがあれば当たらない)。 */
function compoundMatchesElement(c: Compound, el: Element): boolean {
	if (isStateful(c)) return false;
	if (c.ids.length > 0) return false;
	if (c.tag !== null && c.tag !== el.tag) return false;
	if (!c.classes.every((cls) => el.classes.has(cls))) return false;
	return c.attrs.every((a) => {
		const actual = el.attrs.get(a.name);
		if (actual === undefined) return false;
		return a.value === null || a.value === actual;
	});
}

/** 祖先側の compound: class は祖先の和集合に含まれていればよい(擬似クラス・属性は当たらない扱い)。 */
function compoundMatchesAncestors(c: Compound, el: Element): boolean {
	if (isStateful(c) || c.ids.length > 0 || c.attrs.length > 0) return false;
	if (c.tag !== null) return false;
	return c.classes.every((cls) => el.ancestorClasses.has(cls));
}

/**
 * 状態を無視すれば当たるか(擬似クラスと `[aria-pressed='true']` などの属性値を外して判定)。
 * 「状態のときだけ当たる規則」を拾うのに使う。
 */
function compoundMatchesIgnoringState(c: Compound, el: Element): boolean {
	if (c.ids.length > 0) return false;
	if (c.tag !== null && c.tag !== el.tag) return false;
	if (!c.classes.every((cls) => el.classes.has(cls))) return false;
	return c.attrs.every((a) => {
		const actual = el.attrs.get(a.name);
		if (actual === undefined) return false;
		// aria-pressed は値を問わない(ON / OFF どちらも状態)。ほかの属性は値で当たる。
		return a.name === 'aria-pressed' || a.value === null || a.value === actual;
	});
}

type Specificity = [number, number, number];

function specificityOf(compounds: Compound[]): Specificity {
	const s: Specificity = [0, 0, 0];
	for (const c of compounds) {
		s[0] += c.ids.length;
		s[1] += c.classes.length + c.attrs.length + c.pseudos.filter((p) => p !== 'where').length;
		s[2] += c.tag !== null ? 1 : 0;
	}
	return s;
}

function compareSpecificity(a: Specificity, b: Specificity): number {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
}

type Matched = { rule: Rule; specificity: Specificity };

/** 既定の状態の要素に当たる規則(セレクタ単位)。 */
function rulesMatching(rules: Rule[], el: Element): Matched[] {
	const out: Matched[] = [];
	for (const rule of rules) {
		const parts = splitCompounds(rule.selector).map(parseCompound);
		if (parts.length === 0) continue;
		const subject = parts[parts.length - 1];
		const ancestors = parts.slice(0, -1);
		if (!compoundMatchesElement(subject, el)) continue;
		if (!ancestors.every((a) => compoundMatchesAncestors(a, el))) continue;
		out.push({ rule, specificity: specificityOf(parts) });
	}
	return out;
}

/** 状態(擬似クラス・属性値)のときだけ当たる規則= 既定では当たらないが、状態を無視すれば当たる。 */
function statefulRulesFor(rules: Rule[], el: Element): Rule[] {
	const out: Rule[] = [];
	const defaultMatched = new Set(rulesMatching(rules, el).map((m) => m.rule.order));
	for (const rule of rules) {
		if (defaultMatched.has(rule.order)) continue;
		const parts = splitCompounds(rule.selector).map(parseCompound);
		if (parts.length === 0) continue;
		const subject = parts[parts.length - 1];
		if (!compoundMatchesIgnoringState(subject, el)) continue;
		out.push(rule);
	}
	return out;
}

/**
 * プロパティ1つの勝者(カスケード): `!important` > 詳細度 > 後に書かれた順。
 * 宣言が無ければ null。
 */
function winningValue(rules: Rule[], el: Element, prop: SizeProp): { value: string; selector: string } | null {
	let best: { value: string; selector: string; important: boolean; specificity: Specificity; order: number } | null =
		null;
	for (const { rule, specificity } of rulesMatching(rules, el)) {
		// 同じ規則の中で同じプロパティが複数あれば後ろが勝つ。
		for (const d of rule.declarations) {
			if (d.prop !== prop) continue;
			const candidate = { value: d.value, selector: rule.selector, important: d.important, specificity, order: rule.order };
			if (best === null) {
				best = candidate;
				continue;
			}
			if (candidate.important !== best.important) {
				if (candidate.important) best = candidate;
				continue;
			}
			const cmp = compareSpecificity(candidate.specificity, best.specificity);
			if (cmp > 0 || (cmp === 0 && candidate.order >= best.order)) best = candidate;
		}
	}
	return best === null ? null : { value: best.value, selector: best.selector };
}

function describeWinner(rules: Rule[], el: Element, prop: SizeProp): string {
	const w = winningValue(rules, el, prop);
	return w === null ? `${prop}: (no declaration)` : `${prop}: ${w.value} from "${w.selector}"`;
}

// ---------------------------------------------------------------------------
// マークアップ側の前提(テストが空回りしないための固定)
// ---------------------------------------------------------------------------

/** `class="…"` の値から class の集合を返す。 */
function classAttrSets(source: string): Set<string>[] {
	const out: Set<string>[] = [];
	const re = /\bclass="([^"]*)"/g;
	for (let m = re.exec(source); m !== null; m = re.exec(source)) {
		out.push(new Set(m[1].split(/\s+/).filter((s) => s.length > 0)));
	}
	return out;
}

describe('AC-66-追a (d) 前提: マークアップの 3トグルと歯車が判定に使う class を持つ', () => {
	it('class に find-in-folder-icon-button と find-in-folder-match-toggle を両方持つ要素がちょうど 3 つ', () => {
		const markup = findInFolderSource().replace(/<style[^>]*>[\s\S]*?<\/style>/, '');
		const toggles = classAttrSets(markup).filter((s) => s.has(ICON_BUTTON) && s.has(MATCH_TOGGLE));
		expect(toggles).toHaveLength(3);
	});

	it('class に find-in-folder-icon-button と find-in-folder-use-exclude-settings を両方持つ要素がちょうど 1 つ', () => {
		const markup = findInFolderSource().replace(/<style[^>]*>[\s\S]*?<\/style>/, '');
		const gears = classAttrSets(markup).filter((s) => s.has(ICON_BUTTON) && s.has(USE_EXCLUDE_SETTINGS));
		expect(gears).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// AC-66-追a (d): 3トグルに最後に効く寸法= 20px 角・文字 11px
// ---------------------------------------------------------------------------

describe('AC-66-追a (d): 3トグル(icon-button + match-toggle)に最後に効く width / height / font-size', () => {
	it('width の勝者が 20px(同じ詳細度なら後に書かれた規則が勝つ・詳細度が高い規則が勝つ)', () => {
		const rules = findInFolderRules();
		expect(winningValue(rules, TOGGLE, 'width')?.value, describeWinner(rules, TOGGLE, 'width')).toBe('20px');
	});

	it('height の勝者が 20px', () => {
		const rules = findInFolderRules();
		expect(winningValue(rules, TOGGLE, 'height')?.value, describeWinner(rules, TOGGLE, 'height')).toBe('20px');
	});

	it('font-size の勝者が 11px', () => {
		const rules = findInFolderRules();
		expect(winningValue(rules, TOGGLE, 'font-size')?.value, describeWinner(rules, TOGGLE, 'font-size')).toBe(
			'11px'
		);
	});

	it('状態のときだけ当たる規則(:hover / :focus-visible / [aria-pressed="true"] など)は width / height / font-size を持たない', () => {
		const rules = findInFolderRules();
		const offenders = statefulRulesFor(rules, TOGGLE)
			.filter((r) => r.declarations.some((d) => (SIZE_PROPS as readonly string[]).includes(d.prop)))
			.map((r) => r.selector);
		expect(offenders).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AC-66-追a (d) 後段: 歯車の 20px 角は同じ判定で保たれる(契約(追補a)5 の不変)
// ---------------------------------------------------------------------------

describe('AC-66-追a (d): 歯車(icon-button + use-exclude-settings)の 20px 角が同じ判定で保たれる', () => {
	it('width の勝者が 20px', () => {
		const rules = findInFolderRules();
		expect(winningValue(rules, GEAR, 'width')?.value, describeWinner(rules, GEAR, 'width')).toBe('20px');
	});

	it('height の勝者が 20px', () => {
		const rules = findInFolderRules();
		expect(winningValue(rules, GEAR, 'height')?.value, describeWinner(rules, GEAR, 'height')).toBe('20px');
	});

	it('状態のときだけ当たる規則は width / height / font-size を持たない', () => {
		const rules = findInFolderRules();
		const offenders = statefulRulesFor(rules, GEAR)
			.filter((r) => r.declarations.some((d) => (SIZE_PROPS as readonly string[]).includes(d.prop)))
			.map((r) => r.selector);
		expect(offenders).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 判定器の自己検査(カスケードの手計算が意図どおりに働くことの固定)
// ---------------------------------------------------------------------------

describe('AC-66-追a (d) 判定器: カスケードの手計算', () => {
	const el: Element = {
		tag: 'button',
		classes: new Set(['a', 'b']),
		attrs: new Map([['aria-pressed', 'false']]),
		ancestorClasses: new Set(['wrap']),
	};

	it('同じ詳細度なら後に書かれた規則が勝つ', () => {
		const rules = rulesOf('.b { width: 20px; } .a { width: 22px; }');
		expect(winningValue(rules, el, 'width')?.value).toBe('22px');
	});

	it('詳細度が高い規則は前に書かれていても勝つ', () => {
		const rules = rulesOf('.a.b { width: 20px; } .a { width: 22px; }');
		expect(winningValue(rules, el, 'width')?.value).toBe('20px');
	});

	it('祖先付きのセレクタは祖先の class が合えば当たり、詳細度に祖先の分も数える', () => {
		const rules = rulesOf('.wrap .b { width: 20px; } .a { width: 22px; }');
		expect(winningValue(rules, el, 'width')?.value).toBe('20px');
		const miss = rulesOf('.other .b { width: 20px; } .a { width: 22px; }');
		expect(winningValue(miss, el, 'width')?.value).toBe('22px');
	});

	it(':hover と [aria-pressed=…] の規則は既定の状態では当たらず、状態の規則として拾われる(type 属性は値で当たる)', () => {
		const rules = rulesOf(
			".a { width: 22px; } .b:hover { width: 30px; } .b[aria-pressed='true'] { width: 31px; } .b[aria-pressed='false'] { width: 32px; } .b[type='button'] { width: 20px; } .b[type='submit'] { width: 33px; }"
		);
		const typed: Element = { ...el, attrs: new Map([...el.attrs, ['type', 'button']]) };
		expect(winningValue(rules, typed, 'width')?.value).toBe('20px');
		expect(statefulRulesFor(rules, typed).map((r) => r.selector)).toEqual([
			'.b:hover',
			".b[aria-pressed='true']",
			".b[aria-pressed='false']",
		]);
	});

	it('!important は詳細度と順序に関係なく勝つ', () => {
		const rules = rulesOf('.b { width: 20px !important; } .a.b { width: 22px; }');
		expect(winningValue(rules, el, 'width')?.value).toBe('20px');
	});

	it('セレクタリスト(カンマ)は 1 セレクタずつに展開される', () => {
		const rules = rulesOf('.x, .b { width: 20px; }');
		expect(winningValue(rules, el, 'width')?.value).toBe('20px');
	});
});
