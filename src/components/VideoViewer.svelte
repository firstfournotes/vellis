<script lang="ts">
	import { untrack } from 'svelte';
	import { openPath } from '@tauri-apps/plugin-opener';
	import { planOpenVideoExternally, videoViewMode } from '$lib/video-viewing';
	import {
		LARGE_FRAME_STEP,
		barCapabilities,
		describePosition,
		formatMilliTime,
		frameKeyAction,
		frameNumberForMediaTime,
		initialSeekTime,
		loadFrameIndex,
		nearestFrame,
		seekTimeForFrame,
		stepFrame,
		type FrameIndex,
	} from '$lib/video-frame';
	import { segmentStartSeconds, type ProvenanceSegment } from '$lib/video-provenance';

	let {
		uri,
		src,
		provenanceOpen = false,
		onToggleProvenance,
		onPositionChange,
		onDurationChange,
	}: {
		/** 表示中のファイルの絶対 URI(file: / ssh:)。再生可否の判定と表示名に使う。 */
		uri: string;
		/**
		 * `<video>` に載せる `vellis-asset:` URI(`renderForDisplay` が組み立て、
		 * 変更のたび版数が付く=要件#22 の機構)。プレースホルダのときは使わない。
		 */
		src: string;
		/** 素材パネル(要件#40)が開いているか。ツールバーのトグルの見た目に出る。 */
		provenanceOpen?: boolean;
		onToggleProvenance?: () => void;
		/**
		 * 再生位置(秒)の持ち上げ(要件#40 契約⑪)。**渡されたときだけ呼ぶ** ――
		 * パネルが閉じているのに毎フレーム親を起こす理由がない。
		 */
		onPositionChange?: (sec: number) => void;
		/** 実尺(秒)の持ち上げ。null =まだ判らない(鮮度の尺判定を止める=契約⑩)。 */
		onDurationChange?: (sec: number | null) => void;
	} = $props();

	/** 長押しの初動までの待ち(ms)。押しっぱなしの意図が固まる程度に置く。 */
	const REPEAT_DELAY_MS = 400;
	/** 連射の間隔(ms)。フレーム送りが目で追える速さ。 */
	const REPEAT_INTERVAL_MS = 80;

	// 再生の開始に失敗した(コーデック未対応・ファイル消滅・ssh 切断)。黒画面のまま
	// 何も起きないより、表示できないことを文字で返す(ImageViewer の要件#16 ⑧と同じ整理)。
	let loadFailed = $state(false);

	let fileName = $derived(uri.slice(uri.lastIndexOf('/') + 1));
	let mode = $derived(videoViewMode(uri));
	/** 「既定アプリで開く」を出せるか。ssh は null =出さない(要件#19 の前例)。 */
	let externalPlan = $derived(planOpenVideoExternally(uri));

	let video: HTMLVideoElement | undefined = $state();
	let pane: HTMLDivElement | undefined = $state();

	/** フレーム索引。null =この動画からは取れなかった(縮退・要件#37 契約⑦)。 */
	let frameIndex = $state<FrameIndex | null>(null);
	let playing = $state(false);
	let audioMuted = $state(false);
	/** 表示の基準になる再生位置(秒)。rVFC の mediaTime が入る(契約③)。 */
	let position = $state(0);
	/** `<video>` が知っている総尺(秒)。0 =まだ判らない。 */
	let mediaDuration = $state(0);
	/** シークバーを掴んでいる間の位置(秒)。null =掴んでいない。 */
	let scrubbing = $state<number | null>(null);

	/**
	 * 直前のコマ送りで狙ったフレーム。
	 *
	 * 連射(長押し)は 80ms 間隔で歩数を積むが、シークの結果が rVFC で返るのはその後。
	 * 実位置を基準にすると届いていない歩数が消えて足踏みするので、送った先を控えて
	 * そこから次を数える。実位置が追いついたら捨てる。
	 */
	let requestedFrame: number | null = null;
	let repeatTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * 初期シーク(要件#39)をまだ当ててよいか。
	 *
	 * ユーザーが位置に触れた時点(再生・シーク・コマ送り)で降ろし、以降は割り込まない
	 * (契約⑤)。読み込み直しのたびに立て直す。
	 */
	let initialSeekPending = true;

	let capabilities = $derived(barCapabilities(frameIndex));
	/** 掴んでいる間は指の位置を、離していれば再生位置を映す。 */
	let barPosition = $derived(scrubbing ?? position);
	/** シークバーの範囲。索引があればそちらが正で、無い動画は `<video>` の申告に従う。 */
	let barDuration = $derived(frameIndex?.duration ?? mediaDuration);
	/**
	 * 3表記(契約①)。索引が無い動画でも時間だけは出す(契約⑦=フレーム系だけが落ちる)。
	 */
	let readout = $derived(
		frameIndex
			? describePosition(frameIndex, barPosition)
			: {
					frame: 0,
					frameText: '',
					timeText: formatMilliTime(barPosition),
					smpteText: null,
				},
	);

	// 読み込み直しが起きるたびに失敗状態と再生状態を落とす。ディスク上のファイルが
	// 直れば版数付きの新しい src が降ってくるので、もう一度再生を試みる。
	$effect(() => {
		void src;
		loadFailed = false;
		playing = false;
		position = 0;
		mediaDuration = 0;
		scrubbing = null;
		requestedFrame = null;
		initialSeekPending = true;
		stopRepeat();
	});

	// 連射タイマーはコンポーネントより長生きしうる(ボタンを押したまま別の文書へ
	// 移る)。破棄のときに必ず止める。
	$effect(() => stopRepeat);

	/**
	 * フレーム索引を取りに行く(契約②)。失敗は null =縮退で、再生そのものは止めない。
	 *
	 * 引くのは版数付きの `src` に反応させる — ディスク上のファイルが差し替われば
	 * サンプルテーブルも別物になる。
	 */
	$effect(() => {
		const target = uri;
		void src;
		if (mode !== 'inline') {
			frameIndex = null;
			return;
		}

		let cancelled = false;
		frameIndex = null;
		void loadFrameIndex(target).then((index) => {
			if (!cancelled) frameIndex = index;
		});
		return () => {
			cancelled = true;
		};
	});

	/**
	 * 先頭フレームを静止表示させる初期シーク(要件#39 契約①③)。
	 *
	 * 開いたばかりの `<video>` は最初のフレームを描かず黒いままなので、こちらから
	 * 先頭フレームの中へ跳ばせる。跳ばすだけで、再生状態には触れない — `play()` も
	 * `muted` も呼ばないので自動再生しない・音も出ない(契約②)。
	 *
	 * 索引の到着前後で二段構え: メタデータが揃った時点でまず縮退値を当てて黒を消し、
	 * 索引が届いたら精密値へ寄せ直す。どちらも frame 0 の内側なので見た目は動かず、
	 * 索引の来ない動画(webm)でも先頭フレームは出る。
	 */
	function applyInitialSeek(el: HTMLVideoElement): void {
		// ユーザーが触った後(再生中・シーク済み)には割り込まない(契約⑤)。
		if (!initialSeekPending || !el.paused) return;
		el.currentTime = initialSeekTime(frameIndex);
		// 精密値まで寄せたら役目は終わり。索引待ちの間は縮退値のまま次を待つ。
		if (frameIndex) initialSeekPending = false;
	}

	/**
	 * 索引が後から届いたときの寄せ直し。
	 *
	 * メタデータより先に索引が届いた場合はまだシークできない(`currentTime` への代入が
	 * 効かない)ので、そのときは何もせず `loadedmetadata` 側の一手に任せる — あちらも
	 * 同じ `applyInitialSeek` を通り、その時点の索引で精密値を当てる。
	 */
	$effect(() => {
		const el = video;
		if (!el || !frameIndex || el.readyState < el.HAVE_METADATA) return;
		applyInitialSeek(el);
	});

	/**
	 * 表示位置の駆動(契約③)。
	 *
	 * `requestVideoFrameCallback` は「いま画面に出ているフレームの提示時刻」を渡して
	 * くれる唯一の口で、これを提示時刻列へ表引きすると表示と実フレームが構造的に一致する
	 * (`currentTime` を fps 倍して丸める方式だと境界で1フレームずれる)。rVFC を持たない
	 * 環境では `timeupdate` に落とす — 精度は落ちるが再生とシークは動く(fail-open)。
	 */
	$effect(() => {
		const el = video;
		if (!el) return;

		if (typeof el.requestVideoFrameCallback !== 'function') {
			const onTimeUpdate = () => report(el.currentTime);
			el.addEventListener('timeupdate', onTimeUpdate);
			el.addEventListener('seeked', onTimeUpdate);
			return () => {
				el.removeEventListener('timeupdate', onTimeUpdate);
				el.removeEventListener('seeked', onTimeUpdate);
			};
		}

		let handle = 0;
		let cancelled = false;
		const onFrame = (_now: number, metadata: { mediaTime: number }) => {
			report(metadata.mediaTime);
			if (!cancelled) handle = el.requestVideoFrameCallback(onFrame);
		};
		handle = el.requestVideoFrameCallback(onFrame);

		return () => {
			cancelled = true;
			el.cancelVideoFrameCallback(handle);
		};
	});

	/**
	 * 素材パネルが開いた直後の一押し(要件#40 契約⑪)。
	 *
	 * 停止中は rVFC が鳴らないので、パネルを開いても次の再生まで位置が届かない。
	 * 受け口が付いた時点(=パネルが開いた時点)で現在位置を一度だけ上げる。
	 * `position` は追跡しない ―― 追跡すると閉じている間もこの effect が毎フレーム走り、
	 * 「閉時は上げない」の意味が無くなる。
	 */
	$effect(() => {
		const notify = onPositionChange;
		if (notify) notify(untrack(() => position));
	});

	/**
	 * 実尺の持ち上げ(要件#40 契約⑩の鮮度判定に使う)。索引があればそちらが正で、
	 * 無い動画は `<video>` の申告に従う(バーの範囲と同じ値)。
	 */
	$effect(() => {
		const seconds = barDuration;
		onDurationChange?.(seconds > 0 ? seconds : null);
	});

	/**
	 * 区間リストのクリックで区間の頭へ跳ぶ(要件#40 契約⑤)。呼ぶのは親(素材パネル)。
	 *
	 * 跳び先は `segmentStartSeconds` ―― 索引があれば要件#37 の吸着経路
	 * (`nearestFrame` → `seekTimeForFrame`)を通り、無ければ区間頭の秒そのまま。
	 * 控え(`requestedFrame`)と初期シークの扱いは `onScrubCommit` と同じ形。
	 */
	export function seekToSegmentStart(segment: ProvenanceSegment): void {
		const el = video;
		if (!el) return;

		initialSeekPending = false;
		const index = frameIndex;
		requestedFrame = index ? nearestFrame(index, segment.start.sec) : null;
		el.currentTime = segmentStartSeconds(segment, index);
	}

	/** 新しい提示時刻が届いた。狙ったフレームに実位置が追いついたら控えを捨てる。 */
	function report(mediaTime: number): void {
		position = mediaTime;
		onPositionChange?.(mediaTime);
		if (
			requestedFrame !== null &&
			frameIndex &&
			frameNumberForMediaTime(frameIndex, mediaTime) === requestedFrame
		) {
			requestedFrame = null;
		}
	}

	/**
	 * OS の既定アプリへ渡す(要件#19 / #21 と同じ opener 経路)。計画は純関数側が
	 * 持ち、ここは呼ぶだけ。失敗しても警告に留める — 既定アプリが応えないことはある。
	 */
	async function openExternally(): Promise<void> {
		if (!externalPlan) return;
		try {
			await openPath(externalPlan.path);
		} catch (err) {
			console.warn(`open_path failed for ${uri}:`, err);
		}
	}

	function togglePlay(): void {
		const el = video;
		if (!el) return;
		initialSeekPending = false;
		if (el.paused) {
			requestedFrame = null;
			void el.play().catch((err) => console.warn(`play failed for ${uri}:`, err));
		} else {
			el.pause();
		}
	}

	function toggleMute(): void {
		const el = video;
		if (!el) return;
		el.muted = !el.muted;
	}

	/**
	 * `frames` 枚ぶん送る/戻す(契約④)。
	 *
	 * 跳ぶ先はフレームの頭ちょうどではなく半フレーム内側(`seekTimeForFrame`)。
	 * 再生中のコマ送りは意味を持たないので、まず止める。
	 */
	function stepBy(frames: number): void {
		const el = video;
		const index = frameIndex;
		if (!el || !index) return;

		initialSeekPending = false;
		if (!el.paused) el.pause();
		const from = requestedFrame ?? frameNumberForMediaTime(index, position);
		const target = stepFrame(index, from, frames);
		requestedFrame = target;
		el.currentTime = seekTimeForFrame(index, target);
	}

	/** ±1 ボタンの長押し連射(契約④)。押した瞬間に1歩目を出す。 */
	function startRepeat(frames: number): void {
		stopRepeat();
		stepBy(frames);
		const tick = () => {
			stepBy(frames);
			repeatTimer = setTimeout(tick, REPEAT_INTERVAL_MS);
		};
		repeatTimer = setTimeout(tick, REPEAT_DELAY_MS);
	}

	function stopRepeat(): void {
		if (repeatTimer !== null) {
			clearTimeout(repeatTimer);
			repeatTimer = null;
		}
	}

	/** 掴んでいる間は粗いまま追従させる(フレーム境界へ揃えるのは離したとき)。 */
	function onScrubInput(event: Event & { currentTarget: HTMLInputElement }): void {
		const value = Number(event.currentTarget.value);
		scrubbing = value;
		requestedFrame = null;
		initialSeekPending = false;
		if (video) video.currentTime = value;
	}

	/** 離した位置を最寄りのフレーム境界へ吸着させる(契約⑤)。 */
	function onScrubCommit(event: Event & { currentTarget: HTMLInputElement }): void {
		const value = Number(event.currentTarget.value);
		scrubbing = null;
		initialSeekPending = false;

		const el = video;
		if (!el) return;
		const index = frameIndex;
		if (!index) {
			el.currentTime = value;
			return;
		}
		const frame = nearestFrame(index, value);
		requestedFrame = frame;
		el.currentTime = seekTimeForFrame(index, frame);
	}

	/**
	 * Space / 矢印の割り当て(契約④⑧)。効くのはこのペインにフォーカスがあるときだけで、
	 * Explorer のキー操作とは競合しない。
	 *
	 * 中の `<button>` や `<input type="range">` にフォーカスが載っていても、キーは
	 * ここまで上がってくる。既定動作(ボタンの発火・スライダーの移動)を潰してから
	 * 同じ操作へ流すので、フォーカス位置で挙動が変わらない。
	 */
	function onKeyDown(event: KeyboardEvent): void {
		if (event.metaKey || event.ctrlKey || event.altKey) return;

		const action = frameKeyAction(event.key, event.shiftKey, frameIndex);
		if (!action) return;

		event.preventDefault();
		if (action.kind === 'toggle-play') togglePlay();
		else stepBy(action.frames);
	}
</script>

<!--
	要件#28 / #37 / #39: 動画はアプリ内で再生する。デコードは WebKit に任せるが、操作は
	ネイティブの `controls` ではなく自作のバー(要件#37 契約⑤の仕様置き換え)。
	編集の下見に要るのはフレーム単位の位置決めで、ネイティブ UI では出せない。
	自動再生はしない — 開いた瞬間に音が鳴らないこと自体が契約。開いた直後に見えるのは
	先頭フレームの静止画で、これは再生ではなく初期シークで作る(要件#39)。マーク・部分選択コピーは
	動画に意味がないので置かない(ImageViewer / ModelViewer と同じ整理)。
-->
<article class="video-viewer">
	<header class="video-toolbar">
		<span class="video-name" title={uri}>{fileName}</span>
		{#if mode === 'inline' && onToggleProvenance}
			<!--
				素材パネルのトグル(要件#40 契約①⑨)。インライン再生する動画にだけ出し、
				**常時有効**にする ―― マップが無いことも壊れていることも、押した先の
				パネルが説明する(押せないボタンは理由を語らない)。
			-->
			<button
				type="button"
				class="toolbar-button"
				class:active={provenanceOpen}
				title="素材パネル(出所)を開閉"
				aria-pressed={provenanceOpen}
				onclick={onToggleProvenance}
			>
				素材
			</button>
		{/if}
	</header>

	<!--
		キーボード操作の受け口。フォーカスをここに集めることで、Space / 矢印が
		動画を見ているときだけ効く(契約⑧)。ModelViewer の操作面と同じ扱い。

		a11y 検査は `role="application"` を対話要素と見ないので、フォーカス可能に
		することとキーを受けることの両方を咎める。キーで操作する面である以上どちらも
		要るため、この2件だけ黙らせる。
	-->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="video-pane"
		bind:this={pane}
		role="application"
		aria-label="動画プレーヤー({fileName})。Space で再生/停止・←/→ でコマ送り・Shift+←/→ で {LARGE_FRAME_STEP} フレーム送り"
		tabindex="0"
		onkeydown={onKeyDown}
		onpointerdown={() => pane?.focus()}
	>
		<div class="video-stage">
			{#if mode === 'inline' && !loadFailed}
				<!--
					src が変われば(別ファイル・ディスク上の変更による版数更新)プレーヤーごと
					作り直す。前のファイルの再生位置や再生中の状態を持ち越さないため。作り直しの
					たびに `loadedmetadata` から初期シークもやり直される(要件#39 契約⑤)。

					`preload` は "metadata" のまま(要件#39 契約③の裁量)。初期シークが要る
					のは先頭フレームぶんの数バイトで、`vellis-asset:` は Range 対応(要件#27)
					だからシークが必要な範囲だけを取りに行ける — "auto" にして長尺の動画を
					丸ごと先読みさせる理由がない。
				-->
				{#key src}
					<!-- svelte-ignore a11y_media_has_caption -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<video
						class="video"
						bind:this={video}
						{src}
						preload="metadata"
						onclick={togglePlay}
						onloadedmetadata={(event) => applyInitialSeek(event.currentTarget)}
						onplay={() => (playing = true)}
						onpause={() => (playing = false)}
						onvolumechange={(event) => (audioMuted = event.currentTarget.muted)}
						ondurationchange={(event) => {
							const value = event.currentTarget.duration;
							mediaDuration = Number.isFinite(value) ? value : 0;
						}}
						onerror={() => (loadFailed = true)}
					></video>
				{/key}
			{:else}
				<div class="video-placeholder">
					<p class="video-message">
						{#if mode === 'remote'}
							リモート(ssh)の動画はアプリ内で再生できません({fileName})。
						{:else if loadFailed}
							この動画を再生できませんでした({fileName})。コーデックが未対応の可能性があります。
						{:else}
							この形式の動画はアプリ内で再生できません({fileName})。
						{/if}
					</p>
					{#if externalPlan}
						<button type="button" class="toolbar-button" onclick={openExternally}>
							既定アプリで開く
						</button>
					{/if}
				</div>
			{/if}
		</div>

		{#if mode === 'inline' && !loadFailed}
			<!--
				自作コントロールバー(契約⑤)。音量スライダー・フルスクリーン・PiP・
				AirPlay は置かない — 編集の下見に要るのは位置決めだけ。
			-->
			<div class="video-controls">
				<input
					class="video-seek"
					type="range"
					min="0"
					max={barDuration}
					step="0.001"
					value={barPosition}
					disabled={barDuration <= 0}
					aria-label="再生位置"
					oninput={onScrubInput}
					onchange={onScrubCommit}
				/>

				<div class="video-buttons">
					<button
						type="button"
						class="video-button"
						title={playing ? '停止(Space)' : '再生(Space)'}
						onclick={togglePlay}
					>
						{playing ? '停止' : '再生'}
					</button>

					{#if capabilities.frameStepping}
						<button
							type="button"
							class="video-button video-step"
							title="{LARGE_FRAME_STEP} フレーム戻す(Shift+←)"
							onclick={() => stepBy(-LARGE_FRAME_STEP)}
						>
							−{LARGE_FRAME_STEP}
						</button>
						<!--
							±1 は押しっぱなしで連射する(契約④)。連射は pointerdown 起点で
							回すので、クリック時の二重発火を避けるため onclick は置かない。
						-->
						<button
							type="button"
							class="video-button video-step"
							title="1 フレーム戻す(←・長押しで連続)"
							onpointerdown={() => startRepeat(-1)}
							onpointerup={stopRepeat}
							onpointerleave={stopRepeat}
							onpointercancel={stopRepeat}
						>
							−1
						</button>
						<button
							type="button"
							class="video-button video-step"
							title="1 フレーム送る(→・長押しで連続)"
							onpointerdown={() => startRepeat(1)}
							onpointerup={stopRepeat}
							onpointerleave={stopRepeat}
							onpointercancel={stopRepeat}
						>
							+1
						</button>
						<button
							type="button"
							class="video-button video-step"
							title="{LARGE_FRAME_STEP} フレーム送る(Shift+→)"
							onclick={() => stepBy(LARGE_FRAME_STEP)}
						>
							+{LARGE_FRAME_STEP}
						</button>
					{/if}

					<!--
						3表記(契約①)。カット位置の正本はフレーム番号で、時間と SMPTE は
						その換算。索引が取れなかった動画では時間だけが残る(契約⑦)。
					-->
					<span class="video-readout">
						<span class="video-time">{readout.timeText}</span>
						{#if capabilities.frameReadout}
							<span class="video-frame">{readout.frameText}</span>
						{/if}
						{#if capabilities.smpteReadout && readout.smpteText}
							<span class="video-smpte">{readout.smpteText}</span>
						{/if}
					</span>

					<button
						type="button"
						class="video-button video-mute"
						title={audioMuted ? '消音を解除' : '消音'}
						aria-pressed={audioMuted}
						onclick={toggleMute}
					>
						{audioMuted ? '消音中' : '消音'}
					</button>
				</div>
			</div>
		{/if}
	</div>
</article>

<style>
	.video-viewer {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow: hidden;
		background-color: var(--color-bg-primary);
	}

	.video-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
		padding: 6px 12px;
		background-color: var(--color-bg-primary);
		border-bottom: 1px solid var(--color-border);
	}

	.toolbar-button {
		font-size: 12px;
		padding: 4px 10px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background-color: var(--color-bg-secondary);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.toolbar-button:hover {
		background-color: var(--color-bg-hover);
	}

	/* 開いている間は押し込んで見せる(Viewer のマーク一覧トグルと同じ扱い)。 */
	.toolbar-button.active {
		background-color: var(--color-bg-tree-active);
		border-color: var(--color-border);
		color: var(--color-text-primary);
	}

	.video-name {
		flex: 1;
		min-width: 0;
		font-size: 12px;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* 再生面とバーをまとめた操作単位。フォーカスリングはこの枠に出す。 */
	.video-pane {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		outline-offset: -2px;
	}

	/*
	 * 再生面。背景はテーマの単色(要件#16 ⑤の画像と同じ考え)で、レターボックスの
	 * 帯もこの色になる。
	 */
	.video-stage {
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
		padding: 16px;
		background-color: var(--color-bg-primary);
	}

	/* 収まらない動画だけを縮める。小さい動画は原寸のまま(引き伸ばさない)。 */
	.video {
		margin: auto;
		max-width: 100%;
		max-height: 100%;
	}

	.video-placeholder {
		margin: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		text-align: center;
	}

	.video-message {
		margin: 0;
		font-size: 13px;
		color: var(--color-text-secondary);
	}

	.video-controls {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 12px 10px;
		border-top: 1px solid var(--color-border);
		background-color: var(--color-bg-primary);
	}

	.video-seek {
		width: 100%;
		margin: 0;
		accent-color: var(--color-text-secondary);
		cursor: pointer;
	}

	.video-seek:disabled {
		cursor: default;
	}

	.video-buttons {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.video-button {
		font-size: 12px;
		padding: 4px 10px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background-color: var(--color-bg-secondary);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.video-button:hover {
		background-color: var(--color-bg-hover);
	}

	/* 歩幅のボタンは数字が並ぶので、幅を揃えて押し間違いを減らす。 */
	.video-step {
		min-width: 44px;
		font-variant-numeric: tabular-nums;
	}

	/* 消音トグルは残りを右へ押しやる位置に置く。 */
	.video-mute {
		margin-left: auto;
	}

	/*
	 * 3表記。等幅の数字で桁を固定する — 再生中に数字の幅が変わると、読み取る前に
	 * 表示が動いて位置が判らなくなる。
	 */
	.video-readout {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin-left: 8px;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		color: var(--color-text-secondary);
	}

	/* 正本はフレーム番号(契約①)。3つのうちここだけを強く出す。 */
	.video-frame {
		color: var(--color-text-primary);
	}
</style>
