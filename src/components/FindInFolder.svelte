<script lang="ts">
	/**
	 * フォルダ横断検索のパネル(要件#55 契約①⑥⑦⑧)。左ペインで Explorer と入れ替わる。
	 *
	 * 持つのは**入力欄・状態表示・結果一覧・Close**だけ。走査は Rust の
	 * `search_in_folder`、グループ化・世代番号・状態の文言は `$lib/find-in-folder` の
	 * 純関数で、ここは「いつ投げるか」「どの応答を採るか」「クリックで何を開くか」を持つ。
	 *
	 * - 入力のたびに世代を 1 つ進め(=それまでの検索を捨てる)、少し待ってから投げる。
	 *   戻ってきた世代が現在と違えば捨てる(契約⑧)
	 * - 結果の行のクリックは Explorer と同じ「この窓で開く」経路(編集の破棄を聞く →
	 *   `openForDisplay` → `setDocument`)の後で `onOpen(uri, query, index)`。跳び先は +page が
	 *   同じ語で要件#54 の検索を起動し、index 番目の一致を現在にする(契約⑦・追補b)。
	 *   パネルは閉じない
	 * - 同じ文書の行をクリックしたときは開き直さず `onOpen` だけ(追補b-2=再描画で番目が
	 *   先頭に戻るのを避ける。編集中でも文書は動かないので確認も出さない)
	 * - 応答は先頭 1 ページだけ運ぶ(追補a)。状態表示は応答の `total` / `files`、一覧は取り込んだ分。
	 *   残りがあれば一覧の末尾の「Show more」で `search_in_folder_page` から次のページを足す
	 * - 追補d: 走査中の一致は `search_progress` で届いた分から末尾に追記する(表示は
	 *   `FIND_IN_FOLDER_PAGE_SIZE` 行で止めて以降は数えるだけ)。`search_done` で状態表示を確定。
	 *   invoke の応答は `total` / `files` と Show more の起点。progress と応答の両方に載る行は
	 *   path + line で 1 回だけ出す。応答の後に届いた同世代の progress / done は捨てる
	 * - 要件#65 契約13: 検索欄の下に files to include / files to exclude の 2 欄と、exclude の
	 *   右端に歯車(Use Exclude Settings)。検索欄の右の `…`(Toggle Search Details)で 2 欄を
	 *   隠す/出す。欄はカンマ区切りの文字列のまま持ち、投げるときに `splitPatterns` で配列に
	 *   して `search_in_folder` へ渡す(照合は Rust)。欄・歯車を変えたら、語が入っていれば
	 *   検索欄の入力と同じ経路(世代を進めて debounce)で探し直す。値は `$lib/find-in-folder`
	 *   のモジュールの変数に覚える(窓の生存中だけ=パネルを閉じて開き直しても残る)
	 * - ウインドウ単位・揮発(ストレージに書かない)。文言は英語(要件#51)
	 * - 要件#63 の領域の目印は付けない(ポインタがパネル上なら直前の領域を保つ=契約⑨)
	 */
	import { onDestroy, onMount, untrack } from 'svelte';
	import { invoke } from '$lib/ipc';
	import { listen } from '$lib/events';
	import { confirmDiscardEdits } from '$lib/edit-guard';
	import { openForDisplay } from '$lib/open-document';
	import {
		FIND_IN_FOLDER_PAGE_SIZE,
		FIND_IN_FOLDER_SHOW_MORE,
		SEARCH_IN_FOLDER_COMMAND,
		SEARCH_IN_FOLDER_PAGE_COMMAND,
		SEARCH_IN_FOLDER_RESET_COMMAND,
		SEARCH_DONE_EVENT,
		SEARCH_PROGRESS_EVENT,
		SearchSession,
		formatFolderStatus,
		getSearchScope,
		matchIndex,
		setSearchScope,
		splitPatterns,
		type SearchDonePayload,
		type SearchHit,
		type SearchPageResponse,
		type SearchProgressPayload,
		type SearchResponse,
	} from '$lib/find-in-folder';
	import { windowState } from '../stores/window-state.svelte';

	let {
		rootUri,
		onOpen,
		onClose,
	}: {
		/** 探す root の URI(末尾 `/` 無し)。 */
		rootUri: string;
		/**
		 * 結果の文書を開いた**後**に呼ぶ。+page が同じ語で要件#54 の検索を起動し、
		 * `index` 番目(0 始まり・そのファイル内の一致の通し番号=追補b)を現在にする。
		 */
		onOpen: (uri: string, query: string, index: number) => void;
		/** パネルを閉じて Explorer へ戻る。 */
		onClose: () => void;
	} = $props();

	/** ラベルと欄を結ぶ id の接頭辞(窓に 1 枚でも、id は部品ごとに一意にしておく)。 */
	const uid = $props.id();

	/** 打ち止めてから投げるまでの待ち(ms)。1 打鍵ごとの全走査を避ける。 */
	const DEBOUNCE_MS = 150;

	/** 失敗したときの状態表示(英語=要件#51)。 */
	const SEARCH_FAILED = 'Search failed';

	const session = new SearchSession();

	/**
	 * マウント時に投げる `search_in_folder_reset` の完了(追補e)。世代は 1 から振り直すので、
	 * Rust 側に残る前回の最新世代を捨て終わるまで検索を投げない。失敗しても resolve する
	 * (黙って続行)。マウント前は待つものが無いので解決済み。
	 */
	let resetDone: Promise<void> = Promise.resolve();

	/**
	 * 表示用のファイルごとのまとまり。`groupHits` と同じ規則(path の初出順・入力順)だが、
	 * 行は `SearchHit` のまま持つ(クリックで `ordinal` を使う=追補a)。
	 */
	type HitGroup = { path: string; count: number; hits: SearchHit[] };

	/**
	 * `prev` の末尾に `hits` を足した新しい一覧を返す(入力は変更しない)。触れていない
	 * グループは同じオブジェクトのまま残すので、Show more のたびに描画し直すのは
	 * 伸びたグループと新しいグループだけ。
	 */
	function appendGroups(prev: HitGroup[], hits: SearchHit[]): HitGroup[] {
		const next = prev.slice();
		const indexByPath = new Map<string, number>();
		next.forEach((g, i) => indexByPath.set(g.path, i));
		const copied = new Set<number>();
		for (const hit of hits) {
			let at = indexByPath.get(hit.path);
			if (at === undefined) {
				at = next.length;
				indexByPath.set(hit.path, at);
				copied.add(at);
				next.push({ path: hit.path, count: 0, hits: [] });
			} else if (!copied.has(at)) {
				copied.add(at);
				next[at] = { ...next[at], hits: next[at].hits.slice() };
			}
			next[at].hits.push(hit);
			next[at].count += 1;
		}
		return next;
	}

	let query = $state('');

	/**
	 * 検索パネルの欄(要件#65 契約13)。マウント時に覚えている値から始め、変えるたびに
	 * `setSearchScope` へ書き戻す(窓の生存中だけ覚える)。
	 */
	const savedScope = getSearchScope();
	let include = $state(savedScope.include);
	let exclude = $state(savedScope.exclude);
	let useExcludeSettings = $state(savedScope.useExcludeSettings);
	let detailsOpen = $state(savedScope.detailsOpen);

	/** `search_in_folder` へ渡す欄の値(投げる時点の写し)。 */
	type SearchScopeArgs = { include: string[]; exclude: string[]; useExcludeSettings: boolean };

	/** いま表示している結果を出した語(クリックで #54 へ渡すのはこちら)。 */
	let resultsQuery = $state('');
	/** 結果は差し替えるだけなので深い proxy にしない(数千件でも軽く保つ)。 */
	let groups = $state.raw<HitGroup[]>([]);
	/** 取り込んだ結果(平坦)。クリックした行の番目を数えるのに使う(追補b)。 */
	let shownHits = $state.raw<SearchHit[]>([]);
	/** 全件の件数と一致ファイル数(応答の値=追補a)。 */
	let total = $state(0);
	let files = $state(0);
	/** 応答を受け取った世代(Show more はこの世代のページを取る)。 */
	let resultsGeneration = 0;
	/** いま一覧に出している行の世代(progress か応答で最初に行を出した世代=追補d)。 */
	let shownGeneration = 0;
	/** 出した行の path + line(progress と応答の重複を 1 回にする=追補d)。 */
	let shownKeys = new Set<string>();
	/** 走査中に progress で受け取った一致の件数と path(表示の上限を超えた分も数える)。 */
	let streamedTotal = 0;
	let streamedPaths = new Set<string>();
	/** 現在世代で投げた語(progress で出した行のクリックに使う)。 */
	let pendingQuery = '';
	/** 応答を受け取ったか(Show more は応答の後にだけ出す)。 */
	let responded = $state(false);
	/** ページ取り込みの札。結果を差し替えるたびに進め、古い札の応答は捨てる。 */
	let pageToken = 0;
	let loadingMore = false;
	let searching = $state(false);
	let failed = $state(false);

	let status = $derived(
		failed && query !== ''
			? SEARCH_FAILED
			: formatFolderStatus({ query, searching, total, files })
	);
	/** まだ取り込んでいない件数。探し直している間は古い結果の続きを出さない。 */
	let remaining = $derived(
		searching || !responded ? 0 : Math.max(0, total - shownHits.length)
	);

	let inputEl: HTMLInputElement | undefined = $state();
	let timer: ReturnType<typeof setTimeout> | undefined;

	function clearResults() {
		resetRows(0);
		total = 0;
		files = 0;
		resultsGeneration = 0;
		responded = false;
		resultsQuery = '';
	}

	/** 一覧を空にして `generation` の行を出し始める(前の世代の行とページは捨てる)。 */
	function resetRows(generation: number) {
		groups = [];
		shownHits = [];
		shownKeys = new Set();
		streamedTotal = 0;
		streamedPaths = new Set();
		shownGeneration = generation;
		pageToken += 1;
		loadingMore = false;
	}

	function keyOf(hit: SearchHit): string {
		return `${hit.path}\n${hit.line}`;
	}

	/** まだ出していない行だけを末尾に足す(`limit` を超えない)。 */
	function appendRows(hits: SearchHit[], limit = Infinity) {
		const added: SearchHit[] = [];
		for (const hit of hits) {
			if (shownHits.length + added.length >= limit) break;
			const key = keyOf(hit);
			if (shownKeys.has(key)) continue;
			shownKeys.add(key);
			added.push(hit);
		}
		if (added.length === 0) return;
		groups = appendGroups(groups, added);
		shownHits = shownHits.concat(added);
	}

	/** 現在世代で、まだ応答が来ていない走査のイベントか。 */
	function isLiveEvent(generation: number): boolean {
		return session.isCurrent(generation) && resultsGeneration !== generation;
	}

	function handleProgress(payload: SearchProgressPayload) {
		if (!isLiveEvent(payload.generation)) return;
		if (shownGeneration !== payload.generation) {
			resetRows(payload.generation);
			resultsQuery = pendingQuery;
		}
		streamedTotal += payload.hits.length;
		for (const hit of payload.hits) streamedPaths.add(hit.path);
		appendRows(payload.hits, FIND_IN_FOLDER_PAGE_SIZE);
		total = streamedTotal;
		files = streamedPaths.size;
	}

	function handleDone(payload: SearchDonePayload) {
		if (!isLiveEvent(payload.generation)) return;
		if (shownGeneration !== payload.generation) {
			resetRows(payload.generation);
			resultsQuery = pendingQuery;
		}
		total = payload.total;
		files = payload.files;
		searching = false;
	}

	async function run(generation: number, root: string, value: string, scope: SearchScopeArgs) {
		await resetDone;
		// reset を待つ間に語が変わった(または閉じた)なら、この世代は投げない。
		if (!session.isCurrent(generation)) return;
		try {
			const response = await invoke<SearchResponse>(SEARCH_IN_FOLDER_COMMAND, {
				root,
				query: value,
				generation,
				include: scope.include,
				exclude: scope.exclude,
				useExcludeSettings: scope.useExcludeSettings,
			});
			if (session.accept(response.generation, response) === null) return;
			if (shownGeneration !== response.generation) resetRows(response.generation);
			appendRows(response.hits);
			responded = true;
			total = response.total;
			files = response.files;
			resultsGeneration = response.generation;
			resultsQuery = value;
			searching = false;
		} catch {
			// 失敗は状態表示に留める(例外を外へ出さない)。古い世代の失敗は黙って捨てる。
			if (!session.isCurrent(generation)) return;
			clearResults();
			searching = false;
			failed = true;
		}
	}

	/** 次のページを取り込んで末尾に足す(追補a)。古い世代・古い札の応答は捨てる。 */
	async function showMore() {
		const generation = resultsGeneration;
		if (loadingMore || !session.isCurrent(generation)) return;
		const offset = shownHits.length;
		const token = ++pageToken;
		loadingMore = true;
		try {
			const response = await invoke<SearchPageResponse>(SEARCH_IN_FOLDER_PAGE_COMMAND, {
				generation,
				offset,
				limit: FIND_IN_FOLDER_PAGE_SIZE,
			});
			if (token !== pageToken || !session.isCurrent(response.generation)) return;
			if (response.generation !== resultsGeneration || shownHits.length !== offset) return;
			appendRows(response.hits);
		} catch {
			// 取れなかったページは足さない(取り込んだ分はそのまま・例外を外へ出さない)。
		} finally {
			if (token === pageToken) loadingMore = false;
		}
	}

	/** 語が変わった(または root が変わった)ので、それまでの検索を捨てて投げ直す。 */
	function schedule(value: string) {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		const generation = session.next();
		pageToken += 1;
		loadingMore = false;
		failed = false;
		pendingQuery = value;
		if (value === '') {
			searching = false;
			clearResults();
			return;
		}
		searching = true;
		// Counts restart with the new generation; the previous rows stay until its first rows arrive.
		total = 0;
		files = 0;
		responded = false;
		const root = rootUri;
		const scope: SearchScopeArgs = {
			include: splitPatterns(include),
			exclude: splitPatterns(exclude),
			useExcludeSettings,
		};
		timer = setTimeout(() => {
			timer = undefined;
			void run(generation, root, value, scope);
		}, DEBOUNCE_MS);
	}

	function handleInput(e: Event) {
		query = (e.currentTarget as HTMLInputElement).value;
		schedule(query);
	}

	/** 欄か歯車が変わった(契約13)。語が入っていれば探し直す。空なら何もしない。 */
	function rescope() {
		if (query !== '') schedule(query);
	}

	function handleIncludeInput(e: Event) {
		include = (e.currentTarget as HTMLInputElement).value;
		setSearchScope({ include });
		rescope();
	}

	function handleExcludeInput(e: Event) {
		exclude = (e.currentTarget as HTMLInputElement).value;
		setSearchScope({ exclude });
		rescope();
	}

	function toggleUseExcludeSettings() {
		useExcludeSettings = !useExcludeSettings;
		setSearchScope({ useExcludeSettings });
		rescope();
	}

	/** 2 欄を隠す/出す。隠しても値は効き続けるので探し直さない。 */
	function toggleDetails() {
		detailsOpen = !detailsOpen;
		setSearchScope({ detailsOpen });
	}

	// root が差し替わったら(同じ窓で別のフォルダを開いた)、今の語で探し直す。
	let seenRoot: string | null = null;
	$effect(() => {
		const root = rootUri;
		untrack(() => {
			if (seenRoot !== null && root !== seenRoot && query !== '') schedule(query);
			seenRoot = root;
		});
	});

	function uriOf(path: string): string {
		return rootUri.endsWith('/') ? `${rootUri}${path}` : `${rootUri}/${path}`;
	}

	async function openHit(hit: SearchHit) {
		const uri = uriOf(hit.path);
		const value = resultsQuery;
		// 番目は ordinal から(無ければ表示中の結果と、それを出した語で数える=追補a/b)。
		const index = matchIndex(shownHits, hit, value);
		// 追補b-2: いま開いている文書なら開き直さない(再描画で番目が先頭に戻るのを避ける)。
		if (windowState.currentDocument?.uri === uri) {
			onOpen(uri, value, index);
			return;
		}
		try {
			// 要件#48 契約④: この窓で別のファイルを開くと編集は消える(Explorer と同じ)。
			if (!(await confirmDiscardEdits())) return;
			windowState.setDocument(await openForDisplay(uri));
		} catch {
			// 開けなかった(消えた・読めない)。パネルはそのまま残す。
			return;
		}
		onOpen(uri, value, index);
	}

	let destroyed = false;
	let unlisteners: (() => void)[] = [];

	/** 購読する。破棄の後に購読が済んだら、その場で外す。 */
	function subscribe<T>(event: string, handler: (payload: T) => void) {
		listen<T>(event, (e) => handler(e.payload))
			.then((unlisten) => {
				if (destroyed) unlisten();
				else unlisteners.push(unlisten);
			})
			.catch(() => {
				// Outside Tauri (or the listener failed): the invoke response still carries the results.
			});
	}

	onMount(() => {
		resetDone = invoke(SEARCH_IN_FOLDER_RESET_COMMAND).then(
			() => undefined,
			() => undefined,
		);
		inputEl?.focus();
		subscribe<SearchProgressPayload>(SEARCH_PROGRESS_EVENT, handleProgress);
		subscribe<SearchDonePayload>(SEARCH_DONE_EVENT, handleDone);
	});

	onDestroy(() => {
		destroyed = true;
		for (const unlisten of unlisteners) unlisten();
		unlisteners = [];
		if (timer !== undefined) clearTimeout(timer);
		// 閉じた後に届いた応答を採らない。
		session.next();
	});
</script>

<div class="find-in-folder" data-testid="find-in-folder" role="search">
	<div class="find-in-folder-header">
		<span class="find-in-folder-title">Find in Folder</span>
		<button
			type="button"
			class="find-in-folder-close"
			data-testid="find-in-folder-close"
			title="Back to the Explorer"
			onclick={onClose}
		>
			Close
		</button>
	</div>
	<div class="find-in-folder-query">
		<div class="find-in-folder-query-row">
			<input
				type="text"
				class="find-in-folder-input"
				data-testid="find-in-folder-input"
				aria-label="Find in folder"
				placeholder="Find in folder"
				spellcheck="false"
				autocomplete="off"
				value={query}
				bind:this={inputEl}
				oninput={handleInput}
			/>
			<button
				type="button"
				class="find-in-folder-icon-button find-in-folder-toggle-details"
				data-testid="find-in-folder-toggle-details"
				aria-expanded={detailsOpen}
				aria-label="Toggle Search Details"
				title="Toggle Search Details"
				onclick={toggleDetails}
			>
				…
			</button>
		</div>
		<!-- 要件#65 契約13: 隠したときは DOM から外す(値は覚えていて、次の検索でも渡る)。 -->
		{#if detailsOpen}
			<div class="find-in-folder-details">
				<div class="find-in-folder-field">
					<label class="find-in-folder-field-label" for="{uid}-include">files to include</label>
					<input
						type="text"
						id="{uid}-include"
						class="find-in-folder-input"
						data-testid="find-in-folder-include"
						placeholder="e.g. docs/**, *.md"
						spellcheck="false"
						autocomplete="off"
						value={include}
						oninput={handleIncludeInput}
					/>
				</div>
				<div class="find-in-folder-field">
					<label class="find-in-folder-field-label" for="{uid}-exclude">files to exclude</label>
					<div class="find-in-folder-field-box">
						<input
							type="text"
							id="{uid}-exclude"
							class="find-in-folder-input find-in-folder-input--with-toggle"
							data-testid="find-in-folder-exclude"
							placeholder="e.g. **/*.log, drafts/**"
							spellcheck="false"
							autocomplete="off"
							value={exclude}
							oninput={handleExcludeInput}
						/>
						<button
							type="button"
							class="find-in-folder-icon-button find-in-folder-use-exclude-settings"
							data-testid="find-in-folder-use-exclude-settings"
							aria-pressed={useExcludeSettings}
							aria-label="Use Exclude Settings"
							title="Use Exclude Settings"
							onclick={toggleUseExcludeSettings}
						>
							<svg
								aria-hidden="true"
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.8"
								stroke-linejoin="round"
								><path
									d="M10.58 5.15L10.88 2.57L13.12 2.57L13.42 5.15A7 7 0 0 1 15.84 6.15L17.88 4.54L19.46 6.12L17.85 8.16A7 7 0 0 1 18.85 10.58L21.43 10.88L21.43 13.12L18.85 13.42A7 7 0 0 1 17.85 15.84L19.46 17.88L17.88 19.46L15.84 17.85A7 7 0 0 1 13.42 18.85L13.12 21.43L10.88 21.43L10.58 18.85A7 7 0 0 1 8.16 17.85L6.12 19.46L4.54 17.88L6.15 15.84A7 7 0 0 1 5.15 13.42L2.57 13.12L2.57 10.88L5.15 10.58A7 7 0 0 1 6.15 8.16L4.54 6.12L6.12 4.54L8.16 6.15A7 7 0 0 1 10.58 5.15Z"
								/><circle cx="12" cy="12" r="3" /></svg
							>
						</button>
					</div>
				</div>
			</div>
		{/if}
		<div class="find-in-folder-status" data-testid="find-in-folder-status" role="status">
			{status}
		</div>
	</div>
	<div class="find-in-folder-results" data-testid="find-in-folder-results">
		{#each groups as group (group.path)}
			<div class="find-in-folder-group" data-testid="find-in-folder-group" data-path={group.path}>
				<div class="find-in-folder-group-header" title={group.path}>
					<span class="find-in-folder-group-path" data-testid="find-in-folder-group-path"
						>{group.path}</span
					>
					<span class="find-in-folder-group-count" data-testid="find-in-folder-group-count"
						>{group.count}</span
					>
				</div>
				{#each group.hits as hit}
					<button
						type="button"
						class="find-in-folder-hit"
						data-testid="find-in-folder-hit"
						data-path={group.path}
						data-line={hit.line}
						onclick={() => void openHit(hit)}
					>
						<span class="find-in-folder-hit-line" data-testid="find-in-folder-hit-line"
							>{hit.line}</span
						>
						<span class="find-in-folder-hit-text" data-testid="find-in-folder-hit-text"
							>{hit.text}</span
						>
					</button>
				{/each}
			</div>
		{/each}
		{#if remaining > 0}
			<button
				type="button"
				class="find-in-folder-show-more"
				data-testid="find-in-folder-show-more"
				onclick={() => void showMore()}
			>
				{FIND_IN_FOLDER_SHOW_MORE(remaining)}
			</button>
		{/if}
	</div>
</div>

<style>
	.find-in-folder {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		overflow: hidden;
		font-size: 13px;
	}

	/* 見出し行は Explorer の `.explorer-header` と同じ見た目に揃える(文字は theme.css のトークン=要件#64 追補b)。 */
	.find-in-folder-header {
		padding: 6px 8px 6px 12px;
		font-size: var(--pane-header-font-size);
		font-weight: var(--pane-header-font-weight);
		text-transform: uppercase;
		letter-spacing: var(--pane-header-letter-spacing);
		color: var(--color-text-secondary);
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.find-in-folder-close {
		font-size: 11px;
		text-transform: none;
		letter-spacing: normal;
		font-weight: 400;
		padding: 2px 8px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.find-in-folder-close:hover {
		background-color: var(--color-bg-hover);
	}

	.find-in-folder-query {
		flex-shrink: 0;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		border-bottom: 1px solid var(--color-border);
	}

	.find-in-folder-input {
		width: 100%;
		box-sizing: border-box;
		font-size: 12px;
		padding: 4px 8px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background-color: var(--color-bg-primary);
		color: var(--color-text-primary);
	}

	.find-in-folder-input:focus {
		outline: 2px solid #93c5fd;
		outline-offset: -1px;
	}

	/* 検索欄と `…` を 1 行に並べる(Cursor の検索ビューと同じ置き方)。 */
	.find-in-folder-query-row {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.find-in-folder-query-row .find-in-folder-input {
		flex: 1;
		min-width: 0;
	}

	/* 要件#65 契約13: files to include / files to exclude。ラベルは小さく、欄は検索欄と同じ。 */
	.find-in-folder-details {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.find-in-folder-field {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.find-in-folder-field-label {
		font-size: 11px;
		color: var(--color-text-secondary);
	}

	/* 歯車を欄の右端の内側に重ねる。文字が歯車の下に潜らないよう右を空ける。 */
	.find-in-folder-field-box {
		position: relative;
	}

	.find-in-folder-input--with-toggle {
		padding-right: 28px;
	}

	.find-in-folder-icon-button {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 4px;
		background: transparent;
		color: var(--color-text-secondary);
		font: inherit;
		font-size: 12px;
		line-height: 1;
		cursor: pointer;
	}

	.find-in-folder-icon-button:hover {
		background-color: var(--color-bg-hover);
		color: var(--color-text-hover);
	}

	.find-in-folder-icon-button:focus-visible {
		outline: 2px solid #93c5fd;
		outline-offset: -1px;
	}

	.find-in-folder-use-exclude-settings {
		position: absolute;
		top: 50%;
		right: 3px;
		width: 20px;
		height: 20px;
		transform: translateY(-50%);
	}

	/* ON(既定)は押し込んだ見た目。OFF は素の歯車に戻る(Cursor のトグルと同じ)。 */
	.find-in-folder-use-exclude-settings[aria-pressed='true'] {
		background-color: var(--color-bg-tree-active);
		border-color: var(--color-border);
		color: var(--color-text-primary);
	}

	.find-in-folder-status {
		min-height: 1.2em;
		font-size: 11px;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.find-in-folder-results {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 4px 0;
	}

	.find-in-folder-group + .find-in-folder-group {
		margin-top: 4px;
	}

	.find-in-folder-group-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 8px 3px 12px;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.find-in-folder-group-path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.find-in-folder-group-count {
		flex-shrink: 0;
		font-size: 11px;
		font-weight: 400;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.find-in-folder-hit {
		display: flex;
		align-items: baseline;
		gap: 8px;
		width: 100%;
		padding: 2px 8px 2px 20px;
		border: none;
		background: transparent;
		color: var(--color-text-secondary);
		font: inherit;
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}

	.find-in-folder-hit:hover {
		background-color: var(--color-bg-tree-hover);
		color: var(--color-text-hover);
	}

	.find-in-folder-hit-line {
		flex-shrink: 0;
		min-width: 2.5em;
		text-align: right;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.find-in-folder-show-more {
		display: block;
		margin: 6px 8px 4px 20px;
		padding: 2px 8px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: transparent;
		color: var(--color-text-secondary);
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}

	.find-in-folder-show-more:hover {
		background-color: var(--color-bg-hover);
	}

	/* 長い行は表示側で切り詰める(契約⑥)。 */
	.find-in-folder-hit-text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: pre;
	}
</style>
