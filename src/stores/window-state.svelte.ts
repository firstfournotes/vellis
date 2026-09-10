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
import {
	canEnterEdit,
	contentHash,
	decideFileChanged,
	isDirty,
	type EditMode,
	type FileChangedDecision,
} from '../lib/document-edit';
import { detectFileType, type DisplayResult } from '../lib/file-type';
import { applyDirectoryChanged } from '../lib/tree-refresh';
import type { SourceIndex } from '../markdown/types';

export type DocumentPayload = {
	uri: string;
	content: string;
	modified: number | null;
};

export type Entry = {
	uri: string;
	name: string;
	kind: 'file' | 'dir' | 'symlink';
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

	renderedHtml = $state<string>('');
	sourceIndex = $state<SourceIndex | null>(null);
	renderedUri = $state<string | null>(null);
	renderedSrcdoc = $state<string | null>(null);
	renderedImageSrc = $state<string | null>(null);
	renderedModelSrc = $state<string | null>(null);
	renderedVideoSrc = $state<string | null>(null);
	renderedAudioSrc = $state<string | null>(null);
	renderedPdfSrc = $state<string | null>(null);

	// --- その場編集(要件#48) ------------------------------------------
	// 判断そのもの(入れるか・dirty か・届いた変更をどう扱うか)は
	// `$lib/document-edit` の純関数が持ち、ここは状態の置き場と遷移だけを持つ。

	/** 表示中の文書のモード。`view` が既定で、編集は明示操作でしか始まらない(契約③)。 */
	editMode = $state<EditMode>('view');

	/**
	 * 編集バッファ。`view` のときは null — 「編集していない」と「空文字を編集中」を
	 * 取り違えないため(空ファイルの編集は `''` を持つ)。
	 */
	editBuffer = $state<string | null>(null);

	/**
	 * 直近に保存した content のハッシュ(契約⑥)。自分の書き込みが `file_changed`
	 * として返ってきたことを見分けるためだけに持つ。
	 */
	lastSavedHash = $state<string | null>(null);

	/**
	 * 編集中に届いた、衝突する外部変更(契約⑥)。null = 衝突していない。
	 * 保持しているのは「読み直す」を選ばれたときに採用する版。
	 */
	externalChange = $state<{ content: string; modified: number | null } | null>(null);

	/** 編集バッファが保存済み content と違うか(契約④)。閲覧中は常に false。 */
	dirty = $derived(
		this.editBuffer !== null &&
			this.currentDocument !== null &&
			isDirty(this.editBuffer, this.currentDocument.content)
	);

	setDocument(doc: DocumentPayload) {
		// 別のファイルへ移るときは編集状態を持ち越さない(契約④)。同じ URI の
		// 内容更新(`file_changed` の apply)ではモードもバッファも畳まない —
		// あちらは `applyFileChanged` が扱いを決めた上で通ってくる。
		if (this.currentDocument?.uri !== doc.uri) this.resetEditState();
		this.currentDocument = doc;
	}

	/** 編集に関わる状態をまとめて初期化する(文書・root の切替と `endEdit` の共通部)。 */
	private resetEditState(): void {
		this.editMode = 'view';
		this.editBuffer = null;
		this.lastSavedHash = null;
		this.externalChange = null;
	}

	/**
	 * 編集モードへ入る(契約③)。入れたら true。
	 *
	 * 入れるかは種別と root が決める(`canEnterEdit`)。バッファは現在の content の
	 * 複製から始まるので、入った直後は dirty ではない = 開いただけ・触っただけで
	 * 「保存しますか」を聞かれることがない。
	 */
	beginEdit(): boolean {
		const doc = this.currentDocument;
		if (!doc) return false;
		if (!canEnterEdit(detectFileType(doc.uri), doc.uri)) return false;
		this.editMode = 'edit';
		this.editBuffer = doc.content;
		return true;
	}

	/** 編集中の内容を差し替える(contenteditable の `input` ごと)。 */
	updateBuffer(content: string): void {
		this.editBuffer = content;
	}

	/** 閲覧へ戻る(Esc / Done)。バッファと衝突表示は捨てる。 */
	endEdit(): void {
		this.editMode = 'view';
		this.editBuffer = null;
		this.externalChange = null;
	}

	/**
	 * 保存が済んだことを記帳する(契約⑤⑥)。呼ぶのは `saveDocument` の成功後だけ。
	 *
	 * content を保存済みの版として取り込むので dirty が消え、ハッシュを覚えることで
	 * この保存が起こす `file_changed` をエコーとして捨てられる。モードは `edit` の
	 * まま — 保存は編集の区切りであって終わりではない。衝突表示も畳む(上書き保存を
	 * 選んだ後の「外部で変更あり」は用済み)。
	 */
	markSaved(content: string): void {
		if (this.currentDocument) {
			this.currentDocument = { ...this.currentDocument, content };
		}
		this.lastSavedHash = contentHash(content);
		this.externalChange = null;
	}

	/**
	 * `file_changed` 1件を扱う(契約⑥)。決めるのは `decideFileChanged`(純関数)で、
	 * ここは決まった扱いを状態へ移すだけ。返り値は呼び出し側の記録・試験用。
	 *
	 * - `ignore-echo`: 何もしない。自分が書いた内容がそのまま返ってきただけ
	 * - `external-conflict`: 文書は動かさず、外部版を脇に置く(画面はバナーを出す)
	 * - `apply`: 従来どおり差し替える。編集中(未変更)なら失うものが無いので
	 *   バッファも外部版へ揃える — 揃えないと、触ってもいないのに dirty になる
	 */
	applyFileChanged(payload: DocumentPayload): FileChangedDecision {
		const decision = decideFileChanged({
			incomingContent: payload.content,
			lastSavedHash: this.lastSavedHash,
			mode: this.editMode,
			dirty: this.dirty,
		});
		if (decision === 'external-conflict') {
			this.externalChange = { content: payload.content, modified: payload.modified };
		} else if (decision === 'apply') {
			this.currentDocument = payload;
			if (this.editMode === 'edit') this.editBuffer = payload.content;
		}
		return decision;
	}

	/** 衝突表示の「読み直す」(契約⑥)。外部版を採用し、編集中の変更は捨てる。 */
	acceptExternalChange(): void {
		const external = this.externalChange;
		if (!external) return;
		if (this.currentDocument) {
			this.currentDocument = {
				...this.currentDocument,
				content: external.content,
				modified: external.modified,
			};
		}
		this.endEdit();
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
		// root が変われば編集は持ち越さない(要件#48 契約④)。文書が残る切替
		// (documentRetained)でも同じ — root の外へ出た編集を書き戻す先が無い。
		this.resetEditState();
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
