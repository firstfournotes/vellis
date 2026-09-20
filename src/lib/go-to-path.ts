/**
 * パスを名指しして跳ぶ(requirements.md #60「Go to Path」)。
 *
 * ⇧⌘G で出る入力バーに打たれた1行を、**候補 URI へ畳む純関数**(`resolveGoToInput`)と、
 * **その候補まで降りて跳ぶ実行列**(`revealPath`)の2つに分けて持つ。降りる手段
 * (`list_dir`)も開く手段も新しい窓も**すべて引数で受け取る**ので、このモジュールは
 * Tauri にもストアにも触らない —— 配線は `+page.svelte` の持ち場(受け入れ基準の
 * 「テストできる形」の条件でもある=req-60.md 受け入れ基準の前提)。
 *
 * 契約(2026-09-18 登録・追補a/b/c/d=2026-09-20。丸番号は req-60.md「契約番号と本文の対応」):
 * - ② 入力の解釈=相対 / 絶対 / root と同じ scheme・authority の URI。`.` `..`・
 *   末尾 `/`・連続 `/`・前後空白の正規化。**`~` は home に展開する(追補c)** ——
 *   展開に要る `homeDir()` が async なので、畳む前の一手として `revealPath` が行う
 *   (純関数 `resolveGoToInput` には載らない)。先頭の `\~` は「`~` という名前」
 * - ③ root 配下判定=**セグメント境界の前方一致**(`file:///a/work` の下に
 *   `file:///a/workspace` は入らない)。`normalizeExpandedDirs` と同じ規則だが、
 *   `reload-state.ts` は改変しないので自前に持つ。**照合は契約④と同じ二段構え=
 *   完全一致→大文字小文字無視(追補d)**。配下=今の窓・外=新ウィンドウ
 * - ④ 解決=root から1階層ずつ `listDir` で降りて名前を照合(完全一致優先・次に
 *   大文字小文字無視)。得た一覧は `setChildEntries` で覚える。root 外は親を1回だけ。
 *   **ドット経路(追補c)**=`.` 始まりのセグメントを含むパスは降下せず、目的地を
 *   1回 `listDir` して当てる(ツリーに行が出ない=要件#31)
 * - ⑤ root 配下で一致=ファイルは開く・フォルダは展開して一覧順で最初の開ける
 *   ファイルを開く(無ければフォルダの行を選択)。祖先は展開し、既存の展開は閉じない
 * - ⑤' root 外で一致=新ウィンドウ(`new_window` と同形の引数)。今の窓は不変で、
 *   編集中でも始末を聞かない(今の窓の文書が動かないため)
 * - ⑥ 一致しない・`listDir` が失敗した・別 host / 別 scheme = `notFound` 1回。
 *   副作用はゼロで、例外は外へ出さない
 * - ⑨ 依存追加ゼロ・Tauri command 追加ゼロ(存在確認は祖先の `listDir` 走査が兼ねる)
 */

/** 「無い」の文言(値固定・英語=要件#51)。入力バーの表示欄が出す(契約⑥)。 */
export const GO_TO_NOT_FOUND_MESSAGE = 'File or folder not found';

/**
 * Go メニュー「Go to Path…」(⇧⌘G)のクリックで Rust から届くイベント名
 * (契約①・追補c で File メニューから移した)。`src-tauri/src/menu.rs` の
 * `MENU_GO_TO_EVENT` と同じリテラルで、両側のテストが同じ値を固定する
 * (要件#34/#54 の家風)。
 */
export const MENU_GO_TO_EVENT = 'menu_go_to';

/** `list_dir` が返すエントリ(既存の形。ストアを import しないため構造だけ持つ)。 */
export type GoToEntry = {
	uri: string;
	name: string;
	kind: 'dir' | 'file' | 'symlink';
};

/**
 * 入力を畳んだ結果(契約②③)。
 *
 * - `null` … 空文字・空白のみ(何もしない・メッセージも出さない)
 * - `root` … root 自身(`.`・`/`・root の絶対パス・root の URI)。root の行は
 *   ツリーに無いので展開も選択もしない
 * - `inside` … root 配下。`segments` は root からの相対で、1階層ずつ降りる材料
 * - `outside` … root 外の絶対パス。親を1回照合して新ウィンドウへ渡す材料
 * - `dotted` … `.` 始まりのセグメントを含むパス(追補c)。ツリーに行が出ない
 *   (要件#31)ので降下では届かず、目的地を1回 `listDir` して当てる材料。root
 *   配下か外かは問わない —— どちらでも挙動が同じ(ファイル=今の窓・フォルダ=
 *   新ウィンドウ)なので `uri` だけで足りる
 * - `unopenable` … 別 scheme / 別 authority(そのプロバイダで開けない=契約⑥の「無い」)
 */
export type GoToTarget =
	| { kind: 'root' }
	| { kind: 'inside'; uri: string; segments: string[] }
	| { kind: 'outside'; uri: string; parentUri: string; name: string }
	| { kind: 'dotted'; uri: string }
	| { kind: 'unopenable' };

/** `revealPath` が要る手段一式。すべて注入(Tauri 無しで試せる形=契約の一部)。 */
export type GoToDeps = {
	/** 今の窓の root URI。ここは一切変えない(契約⑤'「root は変えない」)。 */
	rootUri: string;
	/** 1階層の一覧(既存の `list_dir`)。reject は契約⑥の「無い」に落ちる。 */
	listDir(uri: string): Promise<GoToEntry[]>;
	/** 文書を開く(既存の `openForDisplay`)。ツリーのクリックと同じ経路。 */
	open(uri: string): Promise<void>;
	/** 新しい窓(既存の `new_window` と同形の引数=要件#34/#59)。 */
	newWindow(args: { path: string | null; root: string; expandedDirs: [] }): Promise<unknown>;
	/** 展開集合の差し替え(`windowState.setExpandedDirs`)。 */
	setExpandedDirs(uris: string[]): void;
	/** 現在の展開集合(既存の枝を閉じないため=契約⑤)。 */
	getExpandedDirs(): string[];
	/** 降りながら得た一覧を覚える(`windowState.setChildEntries`=契約④)。 */
	setChildEntries(uri: string, entries: GoToEntry[]): void;
	/** ツリー選択(フォルダ・開けない種類のファイル=起案時判断 (a))。 */
	selectTreeItem(uri: string): void;
	/** 「無い」(契約⑥)。バーの表示欄に `GO_TO_NOT_FOUND_MESSAGE` を出す。 */
	notFound(): void;
	/** 編集の始末(既存の `confirmDiscardEdits`)。false なら跳ばない。 */
	confirmDiscard(): Promise<boolean>;
	/** 種別判定(既存の `detectFileType`)。`binary` は開けない種類。 */
	detectFileType(name: string): string;
	/** 新しい窓を開けなかったこと(要件#59 と同じ失敗通知)。例外は外へ出さない。 */
	onNewWindowFailed(err: unknown): void;
	/**
	 * `~` の展開に使う home の URI(`file:///Users/me` 形。末尾 `/` 付きでも同じに
	 * 扱う)。取れなければ `null`(契約②「展開せず『無い』」)。**ssh の root では
	 * 呼ばない** —— `homeDir()` は local の home で、リモートの home を返す口が
	 * `FileProvider` に無い(追補c (t))。
	 */
	homeDir(): Promise<string | null>;
};

/** 末尾の `/` を落とす。URI の比較は「区切りを含めない形」で揃える(契約②)。 */
function stripTrailingSlashes(uri: string): string {
	return uri.replace(/\/+$/, '');
}

/** `scheme://authority/path` の3つ組。root と入力を同じ土俵に載せるために使う。 */
type ParsedUri = { scheme: string; authority: string; path: string };

const URI_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?$/;

function parseUri(uri: string): ParsedUri | null {
	const m = URI_PATTERN.exec(uri);
	if (!m) return null;
	return { scheme: m[1] ?? '', authority: m[2] ?? '', path: m[3] ?? '/' };
}

/**
 * パスをセグメント列へ畳む(契約②)。空セグメント(連続する `/`・末尾の `/`)と
 * `.` は捨て、`..` は1つ上へ畳む。ファイルシステムのルートより上へは畳まない。
 */
function normalizeSegments(path: string): string[] {
	const out: string[] = [];
	for (const segment of path.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			out.pop();
			continue;
		}
		out.push(segment);
	}
	return out;
}

/**
 * `prefix` が `segments` の**セグメント境界での**前方一致か(契約③)。
 *
 * 照合は契約④と同じ二段構え —— **まず完全一致、外れたら大文字小文字を無視**
 * (追補d)。macOS の `canonicalize` は綴りの大小を直さないので、`vellis /users/…`
 * と小文字で開いた root に `/Users/…` を打つと完全一致だけでは外れ、root 配下の
 * 絶対パスが新ウィンドウになってしまう(2026-09-20 由谷実機報告=backlog 182)。
 * セグメント境界は大小無視でも保つので、`/a/Workspace` は `/a/work` の外のまま。
 */
function startsWithSegments(segments: string[], prefix: string[]): boolean {
	if (segments.length < prefix.length) return false;
	if (prefix.every((s, i) => segments[i] === s)) return true;
	return prefix.every((s, i) => (segments[i] as string).toLowerCase() === s.toLowerCase());
}

/**
 * 正規化後のセグメントに `.` 始まりが1つでもあるか(契約④・追補c)。`.` と `..`
 * は `normalizeSegments` で消えているので、ここに残るのは `.claude` `.env` のような
 * **名前**だけ。1つでもあればツリーには載せられない(要件#31)ので降下を諦める。
 */
function hasDotSegment(segments: string[]): boolean {
	return segments.some((segment) => segment.startsWith('.'));
}

/**
 * 入力文字列を候補へ畳む(契約②③)。
 *
 * 相対パスが既定の読みで、絶対パスと URI は root と同じ scheme・authority のときだけ
 * 受ける。畳んだ結果が root の内か外かだけが `inside` / `outside` を決めるので、
 * 相対で書いたか絶対で書いたかは効かない(挙動表 9/10=追補b (p)(q))。
 */
export function resolveGoToInput(input: string, rootUri: string): GoToTarget | null {
	const trimmed = input.trim();
	if (trimmed === '') return null;

	// 先頭の `\~` は「`~` という名前」の脱出記法(追補c (s))。`~` の文字そのものに
	// 置き換えて以降は普通の相対パスとして読む。先頭以外の `\` は名前の一部なので
	// 触らない(Windows パスは対象外=`\` を区切りと読む必要が無い)。
	const text = trimmed.startsWith('\\~') ? trimmed.slice(1) : trimmed;

	const base = stripTrailingSlashes(rootUri);
	const root = parseUri(base);
	// root が URI として読めない(= root 未確定)ときは跳ぶ先が無い。
	if (!root) return null;

	let absolutePath: string;
	const parsed = parseUri(text);
	if (parsed) {
		// URI 形は scheme と authority が root と一致するときだけ受ける(契約②)。
		// 違う host の ssh / root が ssh のときの file は、そのプロバイダで開けない。
		if (
			parsed.scheme.toLowerCase() !== root.scheme.toLowerCase() ||
			parsed.authority !== root.authority
		) {
			return { kind: 'unopenable' };
		}
		absolutePath = parsed.path;
	} else if (text.startsWith('/')) {
		// root と同じ scheme・authority の絶対パスとして読む(契約②)。
		absolutePath = text;
	} else {
		absolutePath = `${root.path}/${text}`;
	}

	const segments = normalizeSegments(absolutePath);
	const rootSegments = normalizeSegments(root.path);

	// `/` だけ(と、畳んでファイルシステムのルートに行き着いた入力)は root 自身と
	// 同じ扱い=何もしない(契約③・追補a (l))。
	if (segments.length === 0) return { kind: 'root' };

	if (startsWithSegments(segments, rootSegments)) {
		const relative = segments.slice(rootSegments.length);
		// root 自身(大文字小文字違いの綴りも含む=追補d)。root の行はツリーに
		// 無いので展開も選択もしない。
		if (relative.length === 0) return { kind: 'root' };
		// 配下と判定したときの URI は **root 側の綴り** で組む(契約③・追補d)。
		// 相対セグメントは入力の綴りのままで、契約④の照合が吸収する。
		const uri = `${base}/${relative.join('/')}`;
		if (hasDotSegment(relative)) return { kind: 'dotted', uri };
		return { kind: 'inside', uri, segments: relative };
	}

	const authorityBase = `${root.scheme}://${root.authority}`;
	const uri = `${authorityBase}/${segments.join('/')}`;
	if (hasDotSegment(segments)) return { kind: 'dotted', uri };
	const name = segments[segments.length - 1] as string;
	const parentSegments = segments.slice(0, -1);
	return {
		kind: 'outside',
		uri,
		parentUri: `${authorityBase}/${parentSegments.join('/')}`,
		name,
	};
}

/**
 * 一覧から名前を照合する(契約④)。**完全一致を優先し、無ければ大文字小文字を
 * 無視した一致**を一覧の先頭から採る —— APFS は既定で区別せず、ssh 先の Linux は
 * 区別するので、片方だけでは片方で間違う(起案時判断 (d))。
 */
function matchEntry(entries: GoToEntry[], name: string): GoToEntry | null {
	for (const entry of entries) {
		if (entry.name === name) return entry;
	}
	const lowered = name.toLowerCase();
	for (const entry of entries) {
		if (entry.name.toLowerCase() === lowered) return entry;
	}
	return null;
}

/** 既存の展開集合に祖先を足す(重複は除き、既に開いている枝は閉じない=契約⑤)。 */
function mergeExpanded(existing: string[], added: string[]): string[] {
	const merged = [...existing];
	for (const uri of added) {
		if (!merged.includes(uri)) merged.push(uri);
	}
	return merged;
}

/**
 * 一覧の中で「ツリーの並び順で最初に来る開けるファイル」(挙動表 2・追補b (n))。
 * サブフォルダには降りない —— 降りると「どこまで潜るか」の規則が要る。
 */
function firstOpenableFile(entries: GoToEntry[], deps: GoToDeps): GoToEntry | null {
	for (const entry of entries) {
		if (entry.kind === 'dir') continue;
		if (deps.detectFileType(entry.name) === 'binary') continue;
		return entry;
	}
	return null;
}

/**
 * root 配下の解決と跳躍(契約④⑤)。root から1階層ずつ降り、降りながら得た一覧を
 * `setChildEntries` で覚える —— これをしないと展開直後のツリーに行がまだ無く、
 * スクロール先を掴めない。
 */
async function revealInside(
	target: { uri: string; segments: string[] },
	deps: GoToDeps
): Promise<unknown> {
	const base = stripTrailingSlashes(deps.rootUri);
	let dirUri = base;
	const ancestors: string[] = [];
	let match: GoToEntry | null = null;

	for (let i = 0; i < target.segments.length; i++) {
		let entries: GoToEntry[];
		try {
			entries = await deps.listDir(dirUri);
		} catch {
			// 権限・消えた・ssh の切断。エラーダイアログは出さず「無い」(契約⑥)。
			deps.notFound();
			return;
		}
		deps.setChildEntries(dirUri, entries);

		const found = matchEntry(entries, target.segments[i] as string);
		if (!found) {
			deps.notFound();
			return;
		}
		if (i === target.segments.length - 1) {
			match = found;
			break;
		}
		// 途中のセグメントがディレクトリでなければそこで止める(`a.md/b.md`=契約④)。
		if (found.kind !== 'dir') {
			deps.notFound();
			return;
		}
		ancestors.push(found.uri);
		dirUri = found.uri;
	}
	if (!match) return;

	if (match.kind === 'dir') {
		// 目的地がフォルダのときは、そのフォルダ自身も1回一覧する(挙動表 2/3)。
		let children: GoToEntry[];
		try {
			children = await deps.listDir(match.uri);
		} catch {
			deps.notFound();
			return;
		}
		deps.setChildEntries(match.uri, children);

		const expanded = mergeExpanded(deps.getExpandedDirs(), [...ancestors, match.uri]);
		const first = firstOpenableFile(children, deps);
		if (!first) {
			// 空・サブフォルダだけ・開けない種類だけ=展開と選択だけ(メッセージ無し)。
			deps.setExpandedDirs(expanded);
			deps.selectTreeItem(match.uri);
			return;
		}
		// 編集中なら先に始末を聞く。キャンセルなら展開だけ行ってファイルは開かない。
		if (!(await deps.confirmDiscard())) {
			deps.setExpandedDirs(expanded);
			deps.selectTreeItem(match.uri);
			return;
		}
		deps.setExpandedDirs(expanded);
		return await deps.open(first.uri);
	}

	// ファイル(挙動表 1)。展開の対象は祖先だけで、ファイル自身は入らない。
	if (deps.detectFileType(match.name) === 'binary') {
		// 開けない種類はツリーのクリック(`handleFileClick`)と同じ規則で開かない。
		deps.setExpandedDirs(mergeExpanded(deps.getExpandedDirs(), ancestors));
		deps.selectTreeItem(match.uri);
		return;
	}
	if (!(await deps.confirmDiscard())) return;
	deps.setExpandedDirs(mergeExpanded(deps.getExpandedDirs(), ancestors));
	return await deps.open(match.uri);
}

/**
 * root 外の解決と新ウィンドウ(契約⑤'・追補a/b)。**親を1回だけ一覧する** ——
 * 降りる先がツリーに無く、展開集合に入れるものも無いので、存在確認と種別判定に
 * 必要な最小の1回で足りる(追補a (j))。今の窓は root も文書もツリーも動かない。
 */
async function revealOutside(
	target: { uri: string; parentUri: string; name: string },
	deps: GoToDeps
): Promise<unknown> {
	let entries: GoToEntry[];
	try {
		entries = await deps.listDir(target.parentUri);
	} catch {
		deps.notFound();
		return;
	}
	const found = matchEntry(entries, target.name);
	if (!found) {
		deps.notFound();
		return;
	}

	const args =
		found.kind === 'dir'
			? // フォルダ=そのフォルダを root にした窓(挙動表 7)。
				{ path: null, root: found.uri, expandedDirs: [] as [] }
			: // ファイル=親フォルダを root にして、そのファイルを開いた窓(挙動表 5)。
				// 開けない種類は `path: null`(ツリーに載せるだけ=追補b (s))。
				{
					path: deps.detectFileType(found.name) === 'binary' ? null : found.uri,
					root: target.parentUri,
					expandedDirs: [] as [],
				};

	try {
		return await deps.newWindow(args);
	} catch (err) {
		// 窓が開かない失敗には OS 側の手応えが無いので伝える(要件#59 と同じ扱い)。
		deps.onNewWindowFailed(err);
		return;
	}
}

/**
 * ドット経路の解決と跳躍(契約④⑤・追補c)。`.` 始まりのセグメントを含むパスは
 * 一覧に出てこない(要件#31)ので、**目的地そのものを1回 `listDir` して当てる**
 * —— 通れば**フォルダ**(今の窓のツリーには載せられないので新ウィンドウ)、
 * 通らなければ**ファイル**として今の窓で開く(root 外でも今の窓=追補c (u))。
 * どちらも失敗すれば契約⑥の「無い」。
 */
async function revealDotted(uri: string, deps: GoToDeps): Promise<unknown> {
	try {
		await deps.listDir(uri);
	} catch {
		// フォルダではない。ファイルとして開いてみる(この試し自体が存在確認)。
		const name = uri.slice(uri.lastIndexOf('/') + 1);
		// 開けない種類はツリーにも載せられないので「無い」と同じ表示にする。
		if (deps.detectFileType(name) === 'binary') {
			deps.notFound();
			return;
		}
		// 編集中なら先に始末を聞く。キャンセルは「無い」ではないので何も出さない。
		if (!(await deps.confirmDiscard())) return;
		try {
			return await deps.open(uri);
		} catch {
			deps.notFound();
			return;
		}
	}
	// フォルダ=そのフォルダを root にした新ウィンドウ(ツリーには出せない)。
	try {
		return await deps.newWindow({ path: null, root: uri, expandedDirs: [] });
	} catch (err) {
		deps.onNewWindowFailed(err);
		return;
	}
}

/** 先頭が `~` で、その直後が `/` か終端か(契約②・追補c)。`~user/…` は含まない。 */
function startsWithHomeTilde(text: string): boolean {
	return text === '~' || text.startsWith('~/');
}

/** root が local(`file`)か。ssh の root では `~` を展開しない(追補c (t))。 */
function isFileRoot(rootUri: string): boolean {
	const root = parseUri(stripTrailingSlashes(rootUri));
	return root !== null && root.scheme.toLowerCase() === 'file';
}

/**
 * 打たれた1行の解決と跳躍(契約④⑤⑤'⑥)。
 *
 * 先に **`~` を home へ展開する**(契約②・追補c)—— `homeDir()` が async で純関数
 * `resolveGoToInput` に載らないため、畳む前の一手としてここで行う。展開後は
 * ただの絶対パスなので、以降の規則(root 配下なら今の窓・外なら新ウィンドウ)は
 * そのまま効く。home が取れなければ `listDir` を呼ばずに「無い」(契約②)。
 *
 * 空入力と root 自身は**何も起こさない**(メッセージも出さない=契約③⑥)。
 * 一致しなければ `notFound` を1回呼ぶだけで、root も文書もツリーも動かさない。
 */
export async function revealPath(input: string, deps: GoToDeps): Promise<unknown> {
	let text = input.trim();
	if (startsWithHomeTilde(text) && isFileRoot(deps.rootUri)) {
		let home: string | null;
		try {
			home = await deps.homeDir();
		} catch {
			home = null;
		}
		if (home === null || home.trim() === '') {
			deps.notFound();
			return;
		}
		// `~` のぶんだけを home に差し替える(末尾の `/` は落として接ぐ)。
		text = stripTrailingSlashes(home.trim()) + text.slice(1);
	}

	const target = resolveGoToInput(text, deps.rootUri);
	if (target === null) return;
	if (target.kind === 'root') return;
	if (target.kind === 'unopenable') {
		deps.notFound();
		return;
	}
	if (target.kind === 'dotted') return await revealDotted(target.uri, deps);
	if (target.kind === 'outside') return await revealOutside(target, deps);
	return await revealInside(target, deps);
}
