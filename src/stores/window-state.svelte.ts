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
import type { DisplayResult } from '../lib/file-type';
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

	setDocument(doc: DocumentPayload) {
		this.currentDocument = doc;
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
		this.currentDocument = null;
		this.renderedHtml = '';
		this.sourceIndex = null;
		this.renderedUri = null;
		this.renderedSrcdoc = null;
		this.renderedImageSrc = null;
	}

	// `index` is null for non-Markdown bodies (plain text / binary / html /
	// image), which carry no source map (要件#2). `srcdoc` is non-null only for
	// HTML, where it holds the sandboxed iframe body instead of `html` (要件#8);
	// `imageSrc` likewise only for images, where it holds the `<img>` asset URI
	// (要件#16). At most one of the two is set — they pick the viewer.
	setRenderResult(uri: string, result: DisplayResult): void {
		// Drop stale results: the active document may have changed while the
		// async render was in flight.
		if (this.currentDocument?.uri !== uri) return;
		this.renderedHtml = result.html;
		this.sourceIndex = result.index;
		this.renderedSrcdoc = result.srcdoc ?? null;
		this.renderedImageSrc = result.imageSrc ?? null;
		this.renderedUri = uri;
	}
}

export const windowState = new WindowState();
