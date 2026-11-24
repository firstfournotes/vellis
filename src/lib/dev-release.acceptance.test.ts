/**
 * 要件#87 の受け入れテスト(docs/requirements/req-87.md)— AC-87-4・AC-87-5・AC-87-7(と AC-87-3 の CI 側)
 *
 * - AC-87-4: About に版の名前が出る。About は macOS の標準の About Vellis(`src-tauri/src/menu.rs` の
 *   `AboutMetadataBuilder`)なので、その組み立てを文字で見る(フロントに About の画面は無い)。
 * - AC-87-5: `.github/workflows/dev-release.yml` の静的な検査(契約5)。
 * - AC-87-3(CI 側): 開発版のビルドは dev-features も webdriver も入れない(`tauri build` の行)。
 * - AC-87-7: `RELEASE-CHECKLIST.md`・`AGENTS.md`・`CLAUDE.md` に開発版の流れがある(契約7)。
 *
 * YAML / Markdown のパーサは入れない(依存追加なし)。テキストを読んで、手順の**構造**を文字で固定する
 * (`self-check-release-wiring.acceptance.test.ts` と同じ家風)。
 *
 * ## 確定契約(implementer はこれに従う=本テストが前提にする形)
 *
 * menu.rs(AC-87-4):
 * - `pub fn build` の頭から About の `AboutMetadataBuilder::new()` … `.build()` までの間で `env!("VELLIS_BUILD_NAME")`
 *   (option_env! でもよい)を読み、その値(そのまま、か `build_name` を名に含む変数、か `pub fn build` の中の
 *   `let <名> = …` でそれを使って作った局所の変数)を、macOS の About の
 *   画面に**出る**欄= `.version(`・`.short_version(`・`.credits(`・`.copyright(` のどれかの引数に入れる。
 *   `.comments(` は macOS の About には出ない(muda 0.17 の macOS の実装は name・version・short_version・
 *   copyright・icon・credits だけを渡す)ので、そこだけに入れても About に出たことにならない。
 * - 短いコミットの番号(`VELLIS_BUILD_NUMBER`)も、画面に出る欄のどれかに今のまま残す(契約2)。
 *
 * dev-release.yml(AC-87-5・AC-87-3):
 * - 置き場 `.github/workflows/dev-release.yml`。`on:` に `workflow_dispatch`(ブランチを選んで回す)。
 * - 公開は `gh release create … --prerelease` だけ(プレリリースでない作り方をしない)。`--title` は版の名前
 *   (`build_name` / `BUILD_NAME` / `buildName` を名に含む変数か式)。DMG を添える(引数に dmg の字)。
 * - `VELLIS_PUBLISH_TOKEN`・`firstfournotes/vellis`・`publish-snapshot` の字がファイルのどこにも出てこない
 *   (コメントにも書かない=配布用のリポジトリへの同期はしない)。
 * - 次のタグ: 既にあるタグが見える状態で(`git ls-remote` / `fetch-depth: 0` / `fetch-tags: true` /
 *   `git fetch … --tags` / `gh release list` / `gh api` / `matching-refs` のどれか)、`dev/<開発名の変数>/` の
 *   タグを並べ(`sort` / `max`)、いちばん大きい番号に `+ 1` する。
 * - 署名と公証: release.yml と同じ secrets の名前(`secrets.APPLE_*`)を全部使い、`xcrun notarytool submit` と
 *   `xcrun stapler staple` がある。
 * - ビルド: `tauri build` の行があり、どの `tauri build` の行にも `dev-features` / `webdriver` が無い
 *   (`--features … dev-features` はファイルのどこにも無い)。
 * - preview の確かめ: `gh release create` より前に、`--print-build-info` か `VELLIS_DEV_FEATURES_PRESENT` を見る
 *   `- name:` の段(1 つでも分けてもよい)があり、それらの段で `--print-build-info` の `preview`(channel)・`buildName`
 *   と名前の形(`dev-…`)・`VELLIS_DEV_FEATURES_PRESENT` を `nm` で見る。逃がさない(`continue-on-error`・
 *   `|| true`・`|| :`・`set +e` を書かない)。
 * - タグの push を条件にしない(`github.ref_type == 'tag'` を書かない=workflow_dispatch でブランチから回すので、
 *   書くと確かめも公開も飛ばされる)。
 *
 * 手順の文書(AC-87-7):
 * - 3 つの文書それぞれで、ある見出しの節(## 以下・下位の見出しを含む・コードの囲みの中の # は見出しにしない)に
 *   「開発版」と、流れの要点=「聞かず(聞かない)」・「OK」・「main」・「公開」がそろう。
 * - RELEASE-CHECKLIST.md には `dev-release.yml` と `install-dev.sh` の名前も出る。
 *
 * ## 今の作りで赤になる理由
 * - menu.rs の About は `VELLIS_BUILD_NAME` を読まない(版の名前が無い)。
 * - `.github/workflows/dev-release.yml` が無い。
 * - 3 つの文書のどれにも「開発版」の字が無い。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), 'utf8');

// ───────────────────────── AC-87-4: About ─────────────────────────

/** `.<field>(` の引数(括弧の対応を数えて切り出す)。 */
function callArgs(text: string, field: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`\\.${field}\\(`, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		let depth = 1;
		let i = m.index + m[0].length;
		const start = i;
		for (; i < text.length && depth > 0; i++) {
			if (text[i] === '(') depth++;
			else if (text[i] === ')') depth--;
		}
		out.push(text.slice(start, i - 1));
	}
	return out;
}

describe('AC-87-4: About Vellis に版の名前が出る(menu.rs の AboutMetadataBuilder)', () => {
	const menu = read('src-tauri', 'src', 'menu.rs');
	const fnStart = menu.indexOf('pub fn build<');
	const chainStart = menu.indexOf('AboutMetadataBuilder::new()', fnStart);
	const chainEnd = menu.indexOf('.build()', chainStart);
	if (fnStart < 0 || chainStart < 0 || chainEnd < 0) {
		throw new Error('menu.rs の `pub fn build` の中に AboutMetadataBuilder::new() … .build() がある前提が崩れた');
	}
	/** `pub fn build` の頭から About の `.build()` まで(局所の変数の定義を含む)。 */
	const head = menu.slice(fnStart, chainEnd);
	/** About の組み立ての鎖。 */
	const chain = menu.slice(chainStart, chainEnd);
	/** macOS の About の画面に出る欄の引数(muda 0.17: version・short_version・credits・copyright)。 */
	const visibleArgs = ['version', 'short_version', 'credits', 'copyright'].flatMap((f) => callArgs(chain, f));
	const visible = visibleArgs.join('\n');

	/**
	 * 画面に出る欄の引数が `re` に当たるか。引数そのものか、引数に出てくる局所の変数の定義
	 * (`pub fn build` の中の `let <名> = …` から、次の `let` か About の組み立ての頭まで)が当たればよい。
	 */
	const visibleMentions = (re: RegExp) =>
		visibleArgs.some((arg) => {
			if (re.test(arg)) return true;
			return (arg.match(/\b[a-z_][a-z0-9_]*\b/g) ?? []).some((id) => {
				const def = new RegExp(`\\blet\\s+(?:mut\\s+)?${id}\\b[\\s\\S]*?(?=\\blet\\s|AboutMetadataBuilder::new\\(\\))`).exec(
					head,
				);
				return def !== null && re.test(def[0]);
			});
		});

	it('reads the baked build name (VELLIS_BUILD_NAME) where the About metadata is built', () => {
		expect(head).toMatch(/(option_)?env!\(\s*"VELLIS_BUILD_NAME"\s*\)/);
	});

	it('puts the build name into a field the macOS About panel shows (not only .comments)', () => {
		expect(visibleMentions(/VELLIS_BUILD_NAME|build_?name/i), `画面に出る欄の引数: ${visible}`).toBe(true);
	});

	it('keeps the short commit (VELLIS_BUILD_NUMBER) in a field the About panel shows', () => {
		expect(visibleMentions(/VELLIS_BUILD_NUMBER/), `画面に出る欄の引数: ${visible}`).toBe(true);
	});
});

// ───────────────────────── AC-87-5(と AC-87-3 の CI 側): dev-release.yml ─────────────────────────

const WORKFLOW = path.join(repoRoot, '.github', 'workflows', 'dev-release.yml');

/** ファイルそのまま(コメントを含む)。無ければ理由付きで落とす。 */
function workflowText(): string {
	if (!existsSync(WORKFLOW)) {
		throw new Error('.github/workflows/dev-release.yml が無い(契約5)');
	}
	return readFileSync(WORKFLOW, 'utf8');
}

/** コメントの行(頭が #)を除いた本文。 */
function workflowCode(): string {
	return workflowText()
		.split('\n')
		.filter((l) => !/^\s*#/.test(l))
		.join('\n');
}

/** 行末の `\` で続く行を 1 行につないだ本文。 */
function logicalLines(code: string): string[] {
	return code.replace(/\\\n\s*/g, ' ').split('\n');
}

/** `- name:` ごとの段(名前と本文と、本文の頭の位置)。 */
function steps(code: string): Array<{ name: string; body: string; at: number }> {
	const out: Array<{ name: string; body: string; at: number }> = [];
	const re = /^\s*-\s+name:\s*(.*)$/gm;
	const marks: Array<{ name: string; at: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(code)) !== null) marks.push({ name: m[1].trim().replace(/^["']|["']$/g, ''), at: m.index });
	marks.forEach((mk, i) => {
		const end = i + 1 < marks.length ? marks[i + 1].at : code.length;
		out.push({ name: mk.name, body: code.slice(mk.at, end), at: mk.at });
	});
	return out;
}

describe('AC-87-5: .github/workflows/dev-release.yml', () => {
	it('exists and runs from workflow_dispatch (pick a branch and run)', () => {
		const code = workflowCode();
		const on = /^["']?on["']?:(.*)$/m.exec(code);
		expect(on, 'トップレベルの on: がある').not.toBeNull();
		const onStart = on!.index;
		const next = code.slice(onStart + on![0].length).search(/^\S/m);
		const block = next < 0 ? code.slice(onStart) : code.slice(onStart, onStart + on![0].length + next);
		expect(block, `on: の中身: ${block}`).toMatch(/\bworkflow_dispatch\b/);
	});

	it('publishes only GitHub pre-releases, titled with the build name, with the DMG attached', () => {
		const creates = logicalLines(workflowCode()).filter((l) => /\bgh\s+release\s+create\b/.test(l));
		expect(creates.length, 'gh release create がある').toBeGreaterThan(0);
		for (const line of creates) {
			expect(line, 'プレリリースとして作る').toMatch(/--prerelease(?!=false)\b/);
			expect(line, '名前=版の名前(build_name / BUILD_NAME / buildName)').toMatch(
				/--title(?:\s+|=)(?:"[^"\n]*build_?name[^"\n]*"|'[^'\n]*build_?name[^'\n]*'|\S*build_?name\S*)/i,
			);
			expect(line, 'DMG を添える').toMatch(/dmg/i);
		}
	});

	it('never mentions VELLIS_PUBLISH_TOKEN, the public repository, or the public snapshot sync', () => {
		const text = workflowText();
		expect(text).not.toContain('VELLIS_PUBLISH_TOKEN');
		expect(text).not.toContain('firstfournotes/vellis');
		expect(text).not.toContain('publish-snapshot');
	});

	it('decides the next tag as the largest dev/<name>/<n> plus one, with the existing tags visible', () => {
		const code = workflowCode();
		expect(code, 'dev/<開発名の変数>/ のタグを扱う').toMatch(
			/dev\/(\$\{\{\s*[\w.-]+\s*\}\}|\$\{?[A-Za-z_]\w*\}?)\//,
		);
		expect(code, 'いちばん大きい番号を取る(sort / max)').toMatch(/\bsort\b|\bmax\b|Math\.max/);
		expect(code, '+ 1 する').toMatch(/\+\s*1\b|\+=\s*1\b/);
		expect(code, '既にあるタグが見える(checkout は既定でタグを取らない)').toMatch(
			/git\s+ls-remote|fetch-depth:\s*0\b|fetch-tags:\s*true|git\s+fetch\b[^\n]*--tags|matching-refs|gh\s+release\s+list|gh\s+api\b/,
		);
	});

	it('signs and notarizes with the same secrets as release.yml', () => {
		const code = workflowCode();
		const release = read('.github', 'workflows', 'release.yml');
		const names = [...new Set([...release.matchAll(/secrets\.(APPLE_[A-Z_]+)/g)].map((m) => m[1]))];
		expect(names.length, 'release.yml の APPLE_* の secrets').toBeGreaterThanOrEqual(6);
		for (const name of names) {
			expect(code, `secrets.${name}`).toMatch(new RegExp(`secrets\\.${name}\\b`));
		}
		expect(code, '公証に出す').toMatch(/xcrun\s+notarytool\s+submit\b/);
		expect(code, 'DMG に公証の印を付ける').toMatch(/xcrun\s+stapler\s+staple\b/);
	});

	it('AC-87-3: builds the preview without dev-features or webdriver', () => {
		const lines = logicalLines(workflowCode());
		const builds = lines.filter((l) => /\btauri\s+build\b/.test(l));
		expect(builds.length, 'tauri build の行がある').toBeGreaterThan(0);
		for (const line of builds) {
			expect(line, 'dev-features を入れない').not.toMatch(/dev-features/);
			expect(line, 'webdriver を入れない').not.toMatch(/webdriver/);
		}
		expect(workflowCode()).not.toMatch(/--features[=\s]+["']?[\w,-]*dev-features/);
	});

	it('checks the preview build before publishing: channel=preview, buildName and its shape, no dev-features sentinel', () => {
		const code = workflowCode();
		const all = steps(code);
		const publishAt = code.search(/\bgh\s+release\s+create\b/);
		expect(publishAt, 'gh release create がある').toBeGreaterThan(-1);
		// 確かめの段 = 公開より前で、--print-build-info か dev-features の印を見る段(1 つでも、分けてもよい)
		const checks = all.filter(
			(s) => s.at < publishAt && (s.body.includes('--print-build-info') || s.body.includes('VELLIS_DEV_FEATURES_PRESENT')),
		);
		expect(
			checks.length,
			`公開より前に --print-build-info / VELLIS_DEV_FEATURES_PRESENT を見る段がある: ${JSON.stringify(all.map((s) => s.name))}`,
		).toBeGreaterThan(0);
		const body = checks.map((s) => s.body).join('\n');
		expect(body, '--print-build-info を読む').toContain('--print-build-info');
		expect(body, 'channel が preview か見る').toMatch(/\bpreview\b/);
		expect(body, 'buildName を見る').toContain('buildName');
		expect(body, '名前の形(dev-…)を見る').toMatch(/dev-(?!features)/);
		expect(body, 'dev-features の印が無いことを nm で見る').toContain('VELLIS_DEV_FEATURES_PRESENT');
		expect(body).toMatch(/\bnm\b/);
		// 逃がさない
		for (const s of checks) {
			expect(s.body, s.name).not.toMatch(/continue-on-error/);
			expect(s.body, s.name).not.toMatch(/\|\|\s*true/);
			expect(s.body, s.name).not.toMatch(/\|\|\s*:/);
			expect(s.body, s.name).not.toMatch(/set\s+\+e/);
		}
	});

	it('is not gated on a tag push (it runs from workflow_dispatch on a branch)', () => {
		expect(workflowCode()).not.toMatch(/ref_type\s*==\s*['"]tag['"]/);
	});
});

// ───────────────────────── AC-87-7: 手順の文書 ─────────────────────────

/** 見出しの節(## 以下。下位の見出しを含む)。コードの囲みの中の # は見出しにしない。 */
function sections(md: string): string[] {
	const lines = md.split('\n');
	const heads: Array<{ line: number; level: number }> = [];
	let fence = false;
	lines.forEach((l, i) => {
		if (/^\s*(```|~~~)/.test(l)) fence = !fence;
		const h = !fence && /^(#{1,6})\s/.exec(l);
		if (h) heads.push({ line: i, level: h[1].length });
	});
	return heads
		.filter((h) => h.level >= 2)
		.map((h) => {
			const next = heads.find((o) => o.line > h.line && o.level <= h.level);
			return lines.slice(h.line, next ? next.line : lines.length).join('\n');
		});
}

const FLOW: Array<[string, RegExp]> = [
	['開発版', /開発版/],
	['聞かずに(達成したら聞かずに開発版・そのあと公開まで聞かずに)', /聞かず|聞かない/],
	['OK(由谷の OK で)', /\bOK\b|ＯＫ/],
	['main(main にマージ)', /\bmain\b/],
	['公開(公開のリリース)', /公開/],
];

describe('AC-87-7: 手順の文書に開発版の流れがある', () => {
	for (const file of ['RELEASE-CHECKLIST.md', 'AGENTS.md', 'CLAUDE.md']) {
		it(`${file}: a section tells the flow (開発版 without asking → OK → main → 公開のリリース)`, () => {
			const md = read(file);
			expect(md, `${file} に「開発版」がある`).toContain('開発版');
			const hit = sections(md).find((s) => FLOW.every(([, re]) => re.test(s)));
			const near = sections(md).filter((s) => s.includes('開発版'));
			const missing = near.map((s) => FLOW.filter(([, re]) => !re.test(s)).map(([w]) => w));
			expect(hit, `${file}: 「開発版」のある節に足りない要点: ${JSON.stringify(missing)}`).toBeDefined();
		});
	}

	it('RELEASE-CHECKLIST.md names the workflow and the install script', () => {
		const md = read('RELEASE-CHECKLIST.md');
		expect(md).toContain('dev-release.yml');
		expect(md).toContain('install-dev.sh');
	});
});
