/**
 * Window-local state using Svelte 5 Runes.
 *
 * Each Tauri window loads its own module instance, so there is no
 * cross-window state sharing (aligned with architecture.md §4.3).
 *
 * Watch registration/unregistration is entirely managed by the Rust
 * backend's DocumentSession (RAII). The frontend only swaps
 * `currentDocument` — the old watch is released automatically on the
 * Main side.
 *
 * `renderedHtml` / `sourceIndex` / `renderedSrcdoc` hold the latest render
 * output keyed by `renderedUri`. The page component performs the render call;
 * the Viewer is a passive presenter (rendering-engine.md §3.1).
 */
import { contentHash, type FileChangedDecision } from '../lib/document-edit';
import { type DisplayResult } from '../lib/file-type';
import { applyDirectoryChanged } from '../lib/tree-refresh';
import type { SourceIndex } from '../markdown/types';
import type { FileEditorHandle } from '../editor/file-editor';

export type DocumentPayload = {
	uri: string;
	content: string;
	modified: number | null;
};

/**
 * `file_removed` 1件の扱い(要件#48 追補g)。
 * - `keep`: 表示中の文書で dirty → 文書・バッファ・モードを保ち、印を立てる
 * - `close`: 表示中の文書で dirty でない → 従来どおり閉じる
 * - `ignore`: 表示中の文書ではない(文書が無いときも)
 */
export type FileRemovedDecision = 'keep' | 'close' | 'ignore';

export type Entry = {
	uri: string;
	name: string;
	kind: 'file' | 'dir' | 'symlink';
	/**
	 * 一覧の行がシンボリックリンクのときだけ付く(要件#70 契約1・3)。`kind` は
	 * リンク先の種別のまま(要件#31)。`target` は readlink の文字列そのまま
	 * (ssh では無い)、`broken` は辿れなかったリンク。
	 */
	link?: { target?: string; broken: boolean };
};

class WindowState {
	root = $state<string>('');
	entries = $state<Entry[]>([]);
	currentDocument = $state<DocumentPayload | null>(null);
	fontSize = $state(16);
	version = $state('');

	/**
	 * 展開中のディレクトリ URI(要件#10)。
	 *
	 * 以前は `ExplorerItem` 個別の `$state` に閉じていたが、reload スナップショット
	 * (`$lib/reload-state`)に載せるにはツリーの外から読み書きできる必要があるため
	 * ウインドウ状態へ外部化した。ツリーはこの集合を見て開き、復元は集合を差し替える
	 * だけで済む。Set ではなく配列なのは、`$state` の深い追跡が配列には効くため。
	 */
	expandedDirs = $state<string[]>([]);

	/**
	 * 展開して取得済みのサブディレクトリ → その直下一覧(要件#18)。
	 *
	 * 以前は `ExplorerItem` 個別の `$state` に閉じていたが、`directory_changed` が
	 * 届いたときに「どのノードの子を差し替えるか」をツリーの外から決める必要が
	 * あるためウインドウ状態へ出した。ツリーはここを映すだけ。
	 */
	childEntries = $state<Record<string, Entry[]>>({});

	/**
	 * ツリーで選ばれている項目(要件#60 起案時判断 (a))。null =選択は文書に従う。
	 *
	 * Explorer の選択はこれまで「開いている文書の URI」だけを映していたので、
	 * **フォルダは構造上選択され得なかった**。Go to がフォルダ(と、開けない種類の
	 * ファイル)を指したときに「そこが選択されたものに変わる」には、文書とは別の
	 * 選択が要る。**文書を開けば消える**(`setDocument` / `clearDocument`)ので、
	 * 従来の見え方は変わらない。
	 */
	selectedTreeUri = $state<string | null>(null);

	/**
	 * Explorer が `active` を付ける URI(要件#60)。ツリー選択があればそれ、
	 * 無ければ開いている文書 —— 選択の在り処が2つに割れても、映す先は1つに保つ。
	 */
	selectedUri = $derived<string | undefined>(
		this.selectedTreeUri ?? this.currentDocument?.uri
	);

	renderedHtml = $state<string>('');
	sourceIndex = $state<SourceIndex | null>(null);
	renderedUri = $state<string | null>(null);
	renderedSrcdoc = $state<string | null>(null);
	renderedImageSrc = $state<string | null>(null);
	renderedModelSrc = $state<string | null>(null);
	renderedVideoSrc = $state<string | null>(null);
	renderedAudioSrc = $state<string | null>(null);
	renderedPdfSrc = $state<string | null>(null);

	// --- 編集(要件#48 → 要件#74 の面) -----------------------------------
	// 編集の中身(バッファ・dirty・外部変更の取り込み)は面の handle(`fileEditor`)の持ち場。
	// ここは handle の置き場と、文書に付く印(削除・保存のハッシュ)だけを持つ。

	/**
	 * 直近に保存した content のハッシュ(契約⑥)。自分の書き込みが `file_changed`
	 * として返ってきたことを見分けるためだけに持つ。
	 */
	lastSavedHash = $state<string | null>(null);

	/**
	 * 編集中(dirty)の文書のファイルが外部で削除された印(要件#48 追補g)。
	 * 立っている間は Viewer が帯で知らせる。消えるのは保存の成功(`markSaved`)・
	 * 同じ文書の `file_changed`・文書や root の切替(`resetEditState`)・Close。
	 */
	externalRemoved = $state(false);

	/**
	 * 要件#74: コードのファイルと plain text の新しい面(`CodeEditor.svelte`)の handle。面が mount で
	 * 置き、unmount で外す。置かれている間は、dirty・外部変更・保存がこの面を見る。
	 * handle は面の中の状態を getter で見せる物なので、深い追跡はしない(`$state.raw`)。
	 */
	fileEditor = $state.raw<FileEditorHandle | null>(null);

	/**
	 * 要件#74 第2段の作り(案)の項目 1 (a)(b): 新しい編集のもとで Markdown を読み取り専用の今の描画(SSH root・閾値超え)で
	 * 出している間は真。Viewer が立てて下ろす(面の無い読み取り専用の描画の印)。
	 */
	editBlocked = $state(false);

	/**
	 * 未保存の編集があるか(契約④)= 面の handle の dirty(要件#74 契約21: 今の編集のバッファは無い)。
	 * 未保存の確認・削除の帯・Reload File が見る。
	 */
	get dirty(): boolean {
		return this.fileEditor?.dirty ?? false;
	}

	setDocument(doc: DocumentPayload) {
		// 別のファイルへ移るときは編集状態を持ち越さない(契約④)。
		if (this.currentDocument?.uri !== doc.uri) {
			this.resetEditState();
			// 要件#74: 別の文書の面は外す(新しい文書の面が mount で置き直す)。
			this.fileEditor = null;
		} else if (this.fileEditor && !this.fileEditor.dirty) {
			// 要件#74: 同じ文書の開き直しは文書モデルを作り直す(未保存の編集があれば畳まない)。
			this.fileEditor.reset(doc.content);
		}
		// 文書を開けば選択はその行についてくる(要件#60 起案時判断 (a))。
		this.selectedTreeUri = null;
		this.currentDocument = doc;
	}

	/**
	 * 同じ URI の文書の中身を差し替える(Reload File のテキスト系の当て方=要件#80 契約 3 追補a)。
	 * `setDocument` の同じ URI の扱いと同じだが、**ツリーの選択には触らない** —— フォルダの行・
	 * 開けない種類のファイルの行を選んでいたら、読み直しの後もその行のまま(外の変更の自動追従・
	 * バイナリの Reload File と同じ扱い)。編集状態は畳まない。
	 */
	applyReloadedText(doc: DocumentPayload): void {
		// 実行列が今の文書の URI でだけ呼ぶので通らないが、別の文書へ編集状態を持ち越さない(契約④)。
		if (this.currentDocument?.uri !== doc.uri) this.resetEditState();
		// 要件#74 (ak)・AC-80-19 (3): 面は `setDocument` の同じ URI の扱いと同じ=未保存の編集が無ければ文書モデルを
		// 作り直し、あれば畳まない。未保存の確認(Don't Save)の後の作り直しは Reload File の流れ(+page.svelte)が持つ。
		if (this.fileEditor && this.fileEditor.uri === doc.uri && !this.fileEditor.dirty) this.fileEditor.reset(doc.content);
		this.currentDocument = doc;
	}

	/** ツリーの選択を移す(要件#60 契約⑤。フォルダ・開けない種類のファイル)。 */
	selectTreeItem(uri: string): void {
		this.selectedTreeUri = uri;
	}

	/** 文書に付く編集の印をまとめて初期化する(文書・root の切替)。 */
	private resetEditState(): void {
		this.lastSavedHash = null;
		this.externalRemoved = false;
	}

	/**
	 * 保存が済んだことを記帳する(契約⑤⑥)。呼ぶのは `saveDocument` の成功後だけ。
	 *
	 * content を保存済みの版として取り込むので dirty が消え、ハッシュを覚えることで
	 * この保存が起こす `file_changed` をエコーとして捨てられる。
	 */
	markSaved(content: string): void {
		if (this.currentDocument) {
			this.currentDocument = { ...this.currentDocument, content };
		}
		this.lastSavedHash = contentHash(content);
		// 要件#48 追補g: 同じパスに書き直したので、削除の印も用済み。
		this.externalRemoved = false;
	}

	/**
	 * `file_changed` 1件を扱う(契約⑥)。返り値は呼び出し側の記録・試験用。
	 *
	 * 面の文書は面が取り込む(要件#74 契約12・13=差分の取引・3 方向マージ・重なりの帯)。
	 * 面の無い文書(画像・html・SSH など)は従来どおり差し替える(自分の保存のエコーは捨てる)。面の handle には
	 * 触らない(別の uri の知らせが面を外さない)。
	 */
	applyFileChanged(payload: DocumentPayload): FileChangedDecision {
		// 要件#48 追補g: 削除の印が立った文書の `file_changed` =作り直された。印を下ろす。
		if (this.currentDocument?.uri === payload.uri) this.externalRemoved = false;
		if (this.fileEditor && this.fileEditor.uri === payload.uri) {
			return this.fileEditor.applyFileChanged(payload);
		}
		if (this.lastSavedHash !== null && contentHash(payload.content) === this.lastSavedHash) return 'ignore-echo';
		this.currentDocument = payload;
		return 'apply';
	}

	/**
	 * `file_removed` 1件を扱う(要件#48 追補g)。返り値は呼び出し側の記録・試験用。
	 *
	 * 表示中の文書の面が dirty なら閉じない — 削除して作り直す書き方のツールが書き換えた
	 * だけでも、未保存の編集が黙って消えるため。文書と面を保って印を立てる(Viewer が帯で
	 * 知らせ、保存すれば同じパスに書き直す)。dirty でなければ従来どおり閉じる(画像などの
	 * バイナリは dirty にならないので常にこちら=要件#22 ②)。
	 */
	applyFileRemoved(uri: string): FileRemovedDecision {
		if (this.currentDocument?.uri !== uri) return 'ignore';
		if (this.dirty) {
			this.externalRemoved = true;
			return 'keep';
		}
		this.clearDocument();
		return 'close';
	}

	/**
	 * root 切替の唯一の入口(OS のフォルダ選択・履歴・親へ移動・`root_changed`)。
	 *
	 * 展開状態は root ごとにしか意味を持たないので、ここで捨てる。呼び出し側が
	 * 個別に消し忘れる余地を残さないため、root と entries の差し替えと同じ場所に置く。
	 * reload からの復元だけは、この呼び出しの直後に `setExpandedDirs` で戻す。
	 */
	applyRoot(rootUri: string, entries: Entry[], documentRetained: boolean): void {
		this.root = rootUri;
		this.entries = entries;
		this.expandedDirs = [];
		this.childEntries = {};
		// 選択も root ごとにしか意味を持たない(要件#60)。
		this.selectedTreeUri = null;
		// root が変われば編集は持ち越さない(要件#48 契約④)。文書が残る切替
		// (documentRetained)でも同じ — root の外へ出た編集を書き戻す先が無い。
		this.resetEditState();
		// 要件#74: 文書が残る切替でも、新しい面の未保存の編集は持ち越さない(保存済みの版に戻す)。
		if (documentRetained && this.fileEditor?.dirty && this.currentDocument) {
			this.fileEditor.reset(this.currentDocument.content);
		}
		if (!documentRetained) this.clearDocument();
	}

	/** 取得した子一覧を覚える(`ExplorerItem` の `list_dir` 応答)。 */
	setChildEntries(uri: string, entries: Entry[]): void {
		this.childEntries = { ...this.childEntries, [uri]: entries };
	}

	/**
	 * `directory_changed` 1件をツリーへ反映する(要件#18)。root 直下も展開中
	 * サブディレクトリも同じ入口を通る。どこを差し替えるか・消えたノードを
	 * どう落とすかの判定は `$lib/tree-refresh` の純関数が持つ。
	 */
	applyDirectoryEvent(uri: string, entries: Entry[]): void {
		const next = applyDirectoryChanged(
			{
				rootUri: this.root,
				rootEntries: this.entries,
				childEntries: this.childEntries,
				expandedDirs: this.expandedDirs
			},
			{ uri, entries }
		);
		this.entries = next.rootEntries;
		this.childEntries = next.childEntries;
		this.expandedDirs = next.expandedDirs;
	}

	isExpanded(uri: string): boolean {
		return this.expandedDirs.includes(uri);
	}

	/** ツリーのディレクトリを開閉する。子の読み込みは `ExplorerItem` の持ち場。 */
	toggleExpanded(uri: string): void {
		this.expandedDirs = this.isExpanded(uri)
			? this.expandedDirs.filter((u) => u !== uri)
			: [...this.expandedDirs, uri];
	}

	/** 展開集合をまるごと差し替える(reload スナップショットからの復元)。 */
	setExpandedDirs(dirs: Iterable<string>): void {
		this.expandedDirs = [...dirs];
	}

	clearDocument() {
		// 表示を閉じる=編集も終わる(要件#48 契約④)。
		this.resetEditState();
		this.fileEditor = null;
		this.editBlocked = false;
		this.selectedTreeUri = null;
		this.currentDocument = null;
		this.renderedHtml = '';
		this.sourceIndex = null;
		this.renderedUri = null;
		this.renderedSrcdoc = null;
		this.renderedImageSrc = null;
		this.renderedModelSrc = null;
		this.renderedVideoSrc = null;
		this.renderedAudioSrc = null;
		this.renderedPdfSrc = null;
	}

	// `index` is null for non-Markdown bodies (plain text / binary / html /
	// image), which carry no source map (要件#2). `srcdoc` is non-null only for
	// HTML, where it holds the sandboxed iframe body instead of `html` (要件#8);
	// `imageSrc` likewise only for images, where it holds the `<img>` asset URI
	// (要件#16), `modelSrc` only for 3D models, where it holds the asset URI
	// `ModelViewer` fetches the mesh from (要件#23), `videoSrc` only for videos,
	// where it holds the `<video>` asset URI (要件#28), `audioSrc` only for audio,
	// where it holds the `<audio>` asset URI (要件#50), and `pdfSrc` only for PDFs,
	// where it holds the `<iframe>` asset URI (要件#29). At most one of the six is
	// set — they pick the viewer.
	setRenderResult(uri: string, result: DisplayResult): void {
		// Drop stale results: the active document may have changed while the
		// async render was in flight.
		if (this.currentDocument?.uri !== uri) return;
		this.renderedHtml = result.html;
		this.sourceIndex = result.index;
		this.renderedSrcdoc = result.srcdoc ?? null;
		this.renderedImageSrc = result.imageSrc ?? null;
		this.renderedModelSrc = result.modelSrc ?? null;
		this.renderedVideoSrc = result.videoSrc ?? null;
		this.renderedAudioSrc = result.audioSrc ?? null;
		this.renderedPdfSrc = result.pdfSrc ?? null;
		this.renderedUri = uri;
	}
}

export const windowState = new WindowState();
