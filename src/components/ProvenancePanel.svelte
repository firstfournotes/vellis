<script lang="ts">
	/**
	 * 素材パネル(出所パネル・要件#40)。
	 *
	 * 動画の隣のサイドカー `<動画ファイル名>.map.json`(`vedit-map` v1)を読み、再生位置に
	 * 同期して「いま見ている部分がどの素材のどの範囲から来たか」を出す右サイドバー
	 * (MarkList と同型の置き方。配色はテーマ変数=契約②)。
	 *
	 * 判定は一切持たない ―― 表引き・逆写像・整形・導線の計画・警告はすべて
	 * `$lib/video-provenance` の純関数が答え、ここは描画と実行だけを持つ(契約⑪。
	 * `VideoViewer` と `video-frame.ts` の関係と同じ家風)。
	 *
	 * 縮退はパネルの中で説明する(契約⑨ fail-open)。マップが無い・壊れている・新しすぎる
	 * のいずれでも再生は止めず、ボタンも生きたまま。**マップは読むだけで書き込まない**。
	 */
	import { revealItemInDir } from '@tauri-apps/plugin-opener';
	import {
		describeSegment,
		formatMapFrame,
		formatMapTime,
		overlaysAt,
		parseProvenanceMap,
		planCopyInputPath,
		planRevealInput,
		provenanceWarnings,
		segmentIndexAt,
		sidecarUriFor,
		type ProvenanceLoad,
		type ProvenanceSegment,
		type ProvenanceWarning,
	} from '$lib/video-provenance';

	let {
		videoUri,
		load,
		position,
		actualDurationSec,
		onSeekSegment,
		onClose,
	}: {
		/** 表示中の動画の絶対 URI(版数クエリの付かない素の URI)。 */
		videoUri: string;
		/** サイドカーの取得結果。null =まだ読んでいる途中。 */
		load: ProvenanceLoad | null;
		/** 再生位置(秒)。VideoViewer から持ち上がってくる(契約⑪)。 */
		position: number;
		/** 動画の実尺(秒)。判らなければ null =鮮度の尺判定をしない(契約⑩)。 */
		actualDurationSec: number | null;
		/** 区間をクリックした。吸着とシークの実行は VideoViewer 側(契約⑤)。 */
		onSeekSegment: (segment: ProvenanceSegment) => void;
		onClose: () => void;
	} = $props();

	/** 素材の相対パスの基準になるマップ自身の URI。 */
	let mapUri = $derived(sidecarUriFor(videoUri));

	// 検証は取得したテキストが変わったときだけ走る(再生位置では走らない)。
	let parsed = $derived(load?.state === 'ok' ? parseProvenanceMap(load.text) : null);
	let map = $derived(parsed?.ok ? parsed.map : null);

	/**
	 * 直前の区間の添字。連続再生では隣接判定だけで済ませるための控えで、**結果は変わらない**
	 * (誤った控えでも `segmentIndexAt` は素引きと同じ答えを返す=契約⑪)。
	 */
	let indexHint = 0;
	let currentIndex = $derived.by(() => {
		const current = map;
		if (!current) return 0;
		const found = segmentIndexAt(current.segments, position, indexHint);
		indexHint = found;
		return found;
	});

	let card = $derived(map ? describeSegment(map, currentIndex, position) : null);
	let overlays = $derived(map ? overlaysAt(map.overlays, position) : []);
	let warnings = $derived(map ? provenanceWarnings(map, videoUri, actualDurationSec) : []);

	/** 探しに行ったサイドカーの名前(不在のときの案内に使う)。 */
	let sidecarName = $derived(mapUri.slice(mapUri.lastIndexOf('/') + 1));

	/** 縮退8段の説明文(§4.5)。null =マップが読めている。 */
	let notice = $derived.by((): string | null => {
		if (!load) return '出所マップを読み込んでいます…';
		if (load.state === 'absent') {
			return `この動画には出所マップがありません(${sidecarName} を探しました)。tool-video-editor の vedit map で作れます。`;
		}
		if (load.state === 'unreadable') return '出所マップを読み込めませんでした。';
		if (load.state === 'too-large') return '出所マップが大きすぎるため読みませんでした(上限 8MB)。';
		if (!parsed || parsed.ok) return null;
		if (parsed.error === 'invalid-json') return '出所マップが JSON として壊れています。';
		if (parsed.error === 'not-vedit-map') return 'これは出所マップ(vedit-map)ではない別の形式のファイルです。';
		if (parsed.error === 'unsupported-version') {
			return '新しい形式の出所マップです。このバージョンの Vellis では読めません。';
		}
		if (parsed.error === 'malformed') return '出所マップの形が違います(必須の項目か型が不正です)。';
		return '出所マップの辻褄が合いません(区間が出力の全体を隙間なく覆っていません)。';
	});

	const WARNING_TEXT: Record<ProvenanceWarning, string> = {
		'video-name-mismatch':
			'マップが指す動画名と開いている動画名が違います。別の動画のマップかもしれません。',
		'duration-mismatch':
			'マップの尺と動画の実尺が 0.05 秒を超えてずれています。動画を作り直した後のマップかもしれません。',
	};

	const ROLE_TEXT: Record<'out' | 'in', string> = {
		out: '消えていく側',
		in: '現れる側',
	};

	const OVERLAY_KIND_TEXT: Record<'image' | 'video' | 'text', string> = {
		image: '画像',
		video: '動画',
		text: 'テキスト',
	};

	/**
	 * 素材を Finder で表示する(契約⑦)。計画は純関数側が持ち、ここは呼ぶだけ。
	 * 失敗しても警告に留める ―― 素材が動かされていることはある。
	 */
	async function revealInput(inputPath: string): Promise<void> {
		const plan = planRevealInput(mapUri, inputPath);
		try {
			await revealItemInDir(plan.path);
		} catch (err) {
			console.warn(`reveal_item_in_dir failed for ${plan.path}:`, err);
		}
	}

	/** 素材のパスをクリップボードへ(契約⑦。ContextMenu の「パスをコピー」と同じ値)。 */
	async function copyInputPath(inputPath: string): Promise<void> {
		const plan = planCopyInputPath(mapUri, inputPath);
		try {
			await navigator.clipboard.writeText(plan.text);
		} catch (err) {
			console.warn(`copy path failed for ${plan.text}:`, err);
		}
	}

	/**
	 * 合成素材(プレースホルダー入力)の説明。バッジの title と、非活性にした導線の
	 * 理由表示を兼ねる ―― 押せないボタンは、なぜ押せないかを言わないと故障に見える。
	 */
	const SYNTHETIC_TITLE =
		'合成素材(vedit のプレースホルダー入力)。実ファイルがまだ無いので、Finder で表示・パスをコピーは使えません。';

	/** 素材の素性を title に集める(主=入力キー・副=ファイル名なので、原文はここ)。 */
	function sourceTitle(path: string | null, scenarioPath: string | null): string {
		// path が null =合成素材(spec.md:669 の読み手契約)。出すべきパスがそもそも無い。
		if (path === null) return SYNTHETIC_TITLE;
		return `マップからの相対パス: ${path}\nシナリオの記述: ${scenarioPath ?? '(記述なし)'}`;
	}
</script>

<aside class="provenance-panel" aria-label="素材">
	<header>
		<h2>素材</h2>
		<button type="button" class="ghost" onclick={onClose} aria-label="閉じる">×</button>
	</header>

	{#if warnings.length > 0}
		<!--
			鮮度の警告(契約⑩)。マップは動画バイナリを読まずに生成できるので、作り直しの
			検出はここまでが限界 ―― 出すだけで、パネルは動き続ける。
		-->
		<div class="warnings" role="status">
			{#each warnings as warning (warning)}
				<p class="warning">{WARNING_TEXT[warning]}</p>
			{/each}
		</div>
	{/if}

	{#if notice}
		<p class="notice">{notice}</p>
	{:else if map && card}
		<div class="panel-body">
			<section class="block block-current">
				<h3>現在位置</h3>
				<!--
					区間種別(契約⑥a)。transition は2素材が同時に映っているので、2枚カードの
					前に「重なり中」であることを明示する(Q23)。
				-->
				<p class="kind" class:overlap={card.overlapping}>
					{#if card.overlapping}
						重なり中(両方が映っています){card.transitionType ? ` — ${card.transitionType}` : ''}
					{:else}
						クリップ区間(1素材)
					{/if}
				</p>
				{#each card.sources as source, i (i)}
					<article class="source">
						<div class="source-head">
							{#if source.role}
								<span class="role">{ROLE_TEXT[source.role]}</span>
							{/if}
							<span class="input-key" title={sourceTitle(source.path, source.scenarioPath)}>
								{source.inputKey}
							</span>
							{#if source.path === null}
								<span class="synthetic" title={SYNTHETIC_TITLE}>プレースホルダー</span>
							{/if}
							<span class="file-name" title={sourceTitle(source.path, source.scenarioPath)}>
								{source.fileName}
							</span>
						</div>
						<dl>
							<dt>素材の現在位置</dt>
							<dd>
								<span class="mono">{source.inputTimeText}</span>
								{#if source.inputFrame !== null}
									<span class="mono ref-frame" title="再生位置から求めた参考値です(±1 フレームずれることがあります)">
										{formatMapFrame(source.inputFrame)}(参考)
									</span>
								{/if}
							</dd>
							<dt>使用範囲</dt>
							<dd>
								<span class="mono">{source.fromText} {source.fromFrameText}</span>
								〜
								<span class="mono">{source.toText} {source.toFrameText}</span>
							</dd>
							<dt>クリップ</dt>
							<dd>
								{source.clip}
								<span class="muted">({source.mode}{source.speedText ? ` ${source.speedText}` : ''})</span>
							</dd>
						</dl>
						<div class="actions">
							<button
								type="button"
								disabled={source.path === null}
								title={source.path === null ? SYNTHETIC_TITLE : undefined}
								onclick={() => {
									if (source.path !== null) void revealInput(source.path);
								}}
							>
								Finder で表示
							</button>
							<button
								type="button"
								disabled={source.path === null}
								title={source.path === null ? SYNTHETIC_TITLE : undefined}
								onclick={() => {
									if (source.path !== null) void copyInputPath(source.path);
								}}
							>
								パスをコピー
							</button>
						</div>
					</article>
				{/each}
			</section>

			<section class="block block-segments">
				<h3>全区間({map.segments.length})</h3>
				<ul class="segments">
					{#each map.segments as segment, i (i)}
						<li>
							<button
								type="button"
								class="segment"
								class:current={i === currentIndex}
								aria-current={i === currentIndex ? 'true' : undefined}
								title="この区間の頭へ移動"
								onclick={() => onSeekSegment(segment)}
							>
								<span class="mono seg-time">{formatMapTime(segment.start.sec)}</span>
								<span class="seg-inputs">
									{segment.sources.map((source) => source.input).join(' → ')}
								</span>
								{#if segment.kind === 'transition'}
									<span class="seg-kind">重なり{segment.type ? `(${segment.type})` : ''}</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			</section>

			{#if map.overlays.length > 0}
				<!--
					オーバーレイはタイムラインを分割しない別レイヤなので、区間リストとは別枠に置く
					(契約⑥c)。出すのは使用区間の列挙まで ―― loop の折り返しの逆写像は v1 が
					持たないので出さない。
				-->
				<section class="block block-overlays">
					<h3>オーバーレイ</h3>
					{#if overlays.length === 0}
						<p class="muted small">いまの位置には掛かっていません。</p>
					{:else}
						<ul class="overlays">
							{#each overlays as overlay (overlay.index)}
								<li>
									<div class="overlay-head">
										<span class="role">{OVERLAY_KIND_TEXT[overlay.kind]}</span>
										<span class="file-name" title={overlay.scenarioPath ?? ''}>
											{overlay.path
												? overlay.path.slice(overlay.path.lastIndexOf('/') + 1)
												: (overlay.text ?? '')}
										</span>
									</div>
									<p class="small mono">
										{formatMapTime(overlay.start.sec)} 〜 {formatMapTime(overlay.end.sec)}
									</p>
									{#if overlay.extract}
										<p class="small muted">
											使用区間:
											{#each overlay.extract as range, i (i)}
												<span class="mono"
													>{formatMapTime(range.from.sec)}〜{formatMapTime(range.to.sec)}</span
												>{i + 1 < overlay.extract.length ? ' / ' : ''}
											{/each}
										</p>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/if}
		</div>
	{/if}
</aside>

<style>
	/*
	 * 置き方=動画ペインの下に敷く横帯(契約②追補1・Q31)。右サイドバーだと動画の
	 * 表示幅が削られるため、幅は動画ペインいっぱい・高さは中身なりで上限つき。
	 * 上限に達しても帯は伸びず、中の段だけが縦に流れる。配色はテーマ変数から取る。
	 */
	.provenance-panel {
		flex: 0 0 auto;
		max-height: 40vh;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background-color: var(--color-bg-secondary);
		border-top: 1px solid var(--color-border);
		overflow: hidden;
	}

	/*
	 * 帯の中は横並び(現在位置・全区間・オーバーレイ)。縦に積むと帯が高くなって
	 * 動画を圧すので、余っている幅の方を使う。狭すぎるときだけ横に流す。
	 */
	.panel-body {
		flex: 0 1 auto;
		min-height: 0;
		display: flex;
		align-items: stretch;
		overflow-x: auto;
	}

	header {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		background-color: var(--color-bg-primary);
		border-bottom: 1px solid var(--color-border);
		z-index: 1;
	}

	h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	h3 {
		margin: 0 0 6px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		color: var(--color-text-secondary);
	}

	.ghost {
		border: 1px solid transparent;
		border-radius: 4px;
		background-color: transparent;
		font-size: 16px;
		padding: 0 8px;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.ghost:hover {
		background-color: var(--color-bg-hover);
		color: var(--color-text-hover);
	}

	.notice {
		margin: 0;
		padding: 16px 12px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--color-text-secondary);
	}

	.warnings {
		flex-shrink: 0;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border);
	}

	.warning {
		margin: 0;
		font-size: 11px;
		line-height: 1.5;
		color: var(--color-text-danger);
	}

	/*
	 * 段。仕切りは段と段の間にだけ引く(帯の右端に線を残さない)。溢れは段ごとに
	 * 縦へ流すので、区間が何十本あっても帯の高さは変わらない。
	 */
	.block {
		min-width: 180px;
		padding: 10px 12px;
		overflow-y: auto;
	}

	.block + .block {
		border-left: 1px solid var(--color-border);
	}

	/* 現在位置は中身が濃いので広めに取る(transition では2枚のカードが入る)。 */
	.block-current {
		flex: 3 1 320px;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		align-content: start;
		gap: 6px 8px;
	}

	/* 見出しと区間種別は段の全幅。下の余白は grid の gap が持つ。 */
	.block-current > h3,
	.block-current > .kind {
		grid-column: 1 / -1;
		margin-bottom: 0;
	}

	.block-segments {
		flex: 2 1 260px;
	}

	.block-overlays {
		flex: 2 1 240px;
	}

	.kind {
		margin: 0 0 6px;
		font-size: 11px;
		color: var(--color-text-secondary);
	}

	/* 重なりは見落とすと出所を1素材と読み違えるので、種別の中でここだけ強く出す。 */
	.kind.overlap {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.source {
		padding: 8px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background-color: var(--color-bg-primary);
	}

	.source-head {
		display: flex;
		align-items: baseline;
		gap: 6px;
		font-size: 12px;
		color: var(--color-text-primary);
	}

	.role {
		flex-shrink: 0;
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 3px;
		background-color: var(--color-bg-hover);
		color: var(--color-text-secondary);
	}

	.input-key {
		font-weight: 600;
	}

	/* 合成素材の印。.role と同じ寸法で、破線と弱い色で「実体が無い」ことを示す。 */
	.synthetic {
		flex-shrink: 0;
		font-size: 10px;
		padding: 1px 6px;
		border: 1px dashed var(--color-border);
		border-radius: 3px;
		color: var(--color-text-muted);
	}

	.file-name {
		flex: 1;
		min-width: 0;
		font-size: 11px;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 8px;
		margin: 6px 0 0;
		font-size: 11px;
	}

	dt {
		color: var(--color-text-secondary);
	}

	dd {
		margin: 0;
		color: var(--color-text-primary);
	}

	/* 数字は等幅で桁を固定する(再生中に幅が動くと読み取る前に位置が変わる)。 */
	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-variant-numeric: tabular-nums;
	}

	/* 参考値であることを弱い色で示す(±1 フレームあり得る=Q29)。 */
	.ref-frame {
		color: var(--color-text-muted);
	}

	.muted {
		color: var(--color-text-secondary);
	}

	.small {
		font-size: 11px;
	}

	.actions {
		display: flex;
		gap: 6px;
		margin-top: 8px;
	}

	.actions button {
		font-size: 11px;
		padding: 2px 8px;
		border: 1px solid var(--color-border);
		border-radius: 3px;
		background-color: var(--color-bg-secondary);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.actions button:hover {
		background-color: var(--color-bg-hover);
	}

	/* 実ファイルの無い素材(合成素材)では導線を押せるように見せない。 */
	.actions button:disabled,
	.actions button:disabled:hover {
		background-color: var(--color-bg-primary);
		color: var(--color-text-muted);
		cursor: default;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.segment {
		display: flex;
		align-items: baseline;
		gap: 8px;
		width: 100%;
		padding: 4px 6px;
		border: 1px solid transparent;
		border-radius: 3px;
		background-color: transparent;
		font-size: 11px;
		color: var(--color-text-primary);
		text-align: left;
		cursor: pointer;
	}

	.segment:hover {
		background-color: var(--color-bg-hover);
	}

	/* 現在の区間。再生に合わせて動くので、色だけでなく縁でも判るようにする。 */
	.segment.current {
		background-color: var(--color-bg-tree-active);
		border-color: var(--color-border);
	}

	.seg-time {
		flex-shrink: 0;
		color: var(--color-text-secondary);
	}

	.seg-inputs {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.seg-kind {
		flex-shrink: 0;
		color: var(--color-text-secondary);
	}

	.overlays li {
		padding: 4px 0;
	}

	.overlays li + li {
		border-top: 1px solid var(--color-border);
	}

	.overlay-head {
		display: flex;
		align-items: baseline;
		gap: 6px;
	}

	.overlays p {
		margin: 2px 0 0;
	}
</style>
