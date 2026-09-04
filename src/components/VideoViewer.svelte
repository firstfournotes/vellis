<script lang="ts">
	import { onMount, untrack } from 'svelte';
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
	import {
		WAVEFORM_BUCKETS,
		analyzeWaveform,
		decodeWaveformAudio,
		extractWaveformAudio,
		laneBoxes,
		peakRects,
		waveformBandNote,
		type WaveformPeaks,
		type WaveformResult,
	} from '$lib/audio-waveform';
	import {
		DEFAULT_WAVEFORM_HEIGHT,
		clampWaveformHeight,
		dragWaveformHeight,
		loadWaveformHeight,
		saveWaveformHeight,
	} from '$lib/waveform-resize';
	import {
		followWaveformWindow,
		normalizeWheelDelta,
		scrollWaveformWindow,
		waveformMinWindowSeconds,
		waveformWindowIndicator,
		waveformWindowSeconds,
		waveformZoomHeadX,
		waveformZoomSeekTime,
		wheelZoomFactor,
		windowPeaks,
		windowPeaksFromCoarse,
		windowXToTime,
		zoomWaveformAtAnchor,
	} from '$lib/waveform-zoom';

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

	/**
	 * 波形帯の高さ(px・要件#41 契約②/要件#42)。
	 *
	 * 山の形が読めて、かつバーと合わせても再生面を圧迫しない高さ。振幅は上下対称に
	 * 描くので、片側の実効は半分になる。既定は 84px(要件#42 = 旧 56px の 1.5 倍)で、
	 * 帯の上端をドラッグして変えられる。範囲と保存の判定は `$lib/waveform-resize` の
	 * 純関数が唯一の持ち場で、ここは「いつ呼ぶか」だけを持つ(要件#9 の幅と同じ整理)。
	 * 初期値は既定高 — onMount で保存値に差し替わる。
	 */
	let waveformHeight = $state(DEFAULT_WAVEFORM_HEIGHT);
	/** 帯の上端ハンドルを掴んでいるか。掴んでいる間だけ仕切りに色が付く。 */
	let resizingWaveform = $state(false);

	// 再生の開始に失敗した(コーデック未対応・ファイル消滅・ssh 切断)。黒画面のまま
	// 何も起きないより、表示できないことを文字で返す(ImageViewer の要件#16 ⑧と同じ整理)。
	let loadFailed = $state(false);

	let fileName = $derived(uri.slice(uri.lastIndexOf('/') + 1));
	let mode = $derived(videoViewMode(uri));
	/** 「既定アプリで開く」を出せるか。ssh は null =出さない(要件#19 の前例)。 */
	let externalPlan = $derived(planOpenVideoExternally(uri));

	let video: HTMLVideoElement | undefined = $state();
	let pane: HTMLDivElement | undefined = $state();
	/**
	 * 中央寄せされる塊(要件#43 契約①)の実体。ドラッグ開始時の自由余白
	 * (pane の高さ − 塊の高さ)を測るためだけに持つ。
	 */
	let stage: HTMLDivElement | undefined = $state();
	let controls: HTMLDivElement | undefined = $state();

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

	/** 解析結果。null =まだ解析していない(src が変わった直後・解析中)。 */
	let waveform = $state<WaveformResult | null>(null);
	let waveformAnalyzing = $state(false);
	/**
	 * どの `src` の波形を持っているか(要件#44 契約③のキャッシュ)。
	 *
	 * 版数付きの `src` が鍵なので、同じ動画を見ている間の解析は1回きり・ディスク上の
	 * ファイルが差し替われば作り直しになる。`$state` にしないのは、これが表示ではなく
	 * 「済んだかどうか」の控えだから(解析の起動条件に自分が入ると回り続ける)。
	 */
	let analyzedSrc: string | null = null;
	let waveformCanvas: HTMLCanvasElement | undefined = $state();
	/** 帯の実幅(px)。シークバーと同じ幅の器に置くので、これが横軸の長さになる。 */
	let waveformWidth = $state(0);
	/**
	 * シークバーの器の実幅(px・要件#47 契約③)。窓指標の left/width をここへ写す。
	 * 帯の幅とは別に測る ―― 見た目は同じ幅でも、指標はバー側の座標に乗るものだから。
	 */
	let seekWidth = $state(0);
	/**
	 * 波形の時間軸の倍率(要件#47 契約①②)。1 =全尺が帯幅に収まる状態。
	 *
	 * `windowStart` と対で「いま帯が映している窓」を表す。**`localStorage` には保存
	 * しない** ―― 帯の高さ(要件#42)と違い、窓は特定のファイルの中の位置であって
	 * 好みの設定ではない。`src` が変われば等倍・先頭へ戻る(契約①)。
	 */
	let waveformZoom = $state(1);
	/** 窓の開始時刻(秒)。倍率 1 のときは常に 0。 */
	let waveformWindowStart = $state(0);
	/**
	 * ドラッグ開始時のキャプチャ(要件#43 契約④)。以後の高さは
	 * この3値と移動量だけから `dragWaveformHeight` が決める ―― 中央寄せの下では
	 * 帯の下端が動く(伸びた分の半分だけ下がる)ので、下端やその時々の高さを
	 * 基準にすると指と上端の対応が崩れる。
	 */
	let dragStart: { height: number; y: number; freeSpace: number } | null = null;

	let capabilities = $derived(barCapabilities(frameIndex));
	/** 掴んでいる間は指の位置を、離していれば再生位置を映す。 */
	let barPosition = $derived(scrubbing ?? position);
	/** シークバーの範囲。索引があればそちらが正で、無い動画は `<video>` の申告に従う。 */
	let barDuration = $derived(frameIndex?.duration ?? mediaDuration);
	/**
	 * いま帯が映している窓の実尺(秒・要件#47 契約②)。倍率 1 なら全尺そのもので、
	 * このとき横軸はシークバーと一致する(要件#41 契約②の改訂=「倍率 1 のとき一致」)。
	 */
	let waveformSeconds = $derived(waveformWindowSeconds(waveformZoom, barDuration));
	/**
	 * この素材で許される窓の下限(秒・要件#47 契約②⑦)。生標本を捨てた素材
	 * (保持上限超過)では粗レベルの刻みが底になり、上限倍率がそのぶん下がる。
	 */
	let waveformMinWindow = $derived(
		waveformMinWindowSeconds(
			waveform?.state === 'ready' && !waveform.samples,
			waveform?.state === 'ready' ? (waveform.sampleRate ?? 0) : 0,
		),
	);
	/**
	 * 再生ヘッドの x、または `null` =窓の外(要件#47 契約⑥)。
	 *
	 * 窓の外を端へ clamp すると居ない場所にヘッドが立つので、そのときは描かない。
	 * 倍率 1 では窓 = 全尺なので、従来どおり `barDuration` の線形写像になる。
	 */
	let waveformHeadX = $derived(
		waveformZoomHeadX(barPosition, waveformWindowStart, waveformSeconds, waveformWidth),
	);
	/**
	 * シークバーへ重ねる窓指標(要件#47 契約③・案B)。シークバーは全尺のまま据え置き、
	 * 「全体のどこを見ているか」だけをこの枠が語る。倍率 1 では `null` =出さない。
	 */
	let waveformIndicator = $derived(
		waveformWindowIndicator(waveformWindowStart, waveformSeconds, barDuration, seekWidth),
	);
	/**
	 * 帯に出す文言(解析中・縮退の理由)。null のときだけ波形そのものを出す。
	 *
	 * 判定は `waveformBandNote`(要件#45 契約③)に委ねる ―― 文言と出し分けは DOM の要らない
	 * 純関数側に置き、ここは状態を渡すだけにする。
	 */
	let waveformNote = $derived(waveformBandNote(waveform, waveformAnalyzing));
	/**
	 * ステレオのときだけ出す L/R ラベル(追補d)。縦位置はレーンの器と同じ値から取る。
	 * 1段(mono・縮退)と縮退表示のときは出さない ―― 段が1つならラベルは何も足さない。
	 */
	let waveformLaneLabels = $derived(
		waveform?.state === 'ready' && waveform.lanes.length === 2
			? laneBoxes(2, waveformHeight).map((box, index) => ({
					text: index === 0 ? 'L' : 'R',
					y: box.y,
				}))
			: [],
	);

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
		// 別ファイル(または版数の変わった同じファイル)の波形は別物。控えごと捨てる
		// (要件#44 契約③)。捨てた直後に次の effect が解析し直す。
		waveform = null;
		waveformAnalyzing = false;
		analyzedSrc = null;
		// 窓は特定の素材の中の位置なので、素材が変われば意味を失う(要件#47 契約①)。
		// 等倍・先頭へ戻す ―― 前の動画の 40 倍の窓を次の動画に当てても、そこに何がある
		// かは誰にも判らない。
		waveformZoom = 1;
		waveformWindowStart = 0;
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
	 * 波形の解析(要件#44 契約②③)。
	 *
	 * 走るのは**この `src` をまだ解析していないとき**で、開閉の条件は無い ―― 波形は
	 * 常時表示(契約①)なので、動画を開いた時点が解析の起点になる。追跡するのは
	 * `src` と再生形式の2つだけ:尺や `<video>` の状態まで追うと、解析中に尺が判った
	 * 瞬間に effect が再実行され、自分が始めた解析を巻き添えで打ち切ってしまう
	 * (要件#41 実装備考の整理)。
	 *
	 * 音声トラックの事前判定にはメタデータが要るが、その到達を**依存には入れない** ――
	 * 依存に入れると上と同じ自己打ち切りが起きる。代わりに effect 内の非同期フローで
	 * `loadedmetadata` を待ち、届いてから `detectAudioTrack` を引く(契約②)。
	 *
	 * 途中で打ち切られたら控えを戻す(次の実行が解析をやり直せるように)。
	 */
	$effect(() => {
		const key = src;
		const inline = mode === 'inline';
		if (!inline || analyzedSrc === key) return;

		const target = untrack(() => uri);
		const el = untrack(() => video);

		analyzedSrc = key;
		waveform = null;
		waveformAnalyzing = true;

		let settled = false;
		let cancelled = false;
		/** メタデータ待ちを途中で解く手。待っていないときは undefined。 */
		let abortWait: (() => void) | undefined;

		void (async () => {
			await waitForMetadata(el, (abort) => (abortWait = abort));
			abortWait = undefined;
			if (cancelled) return;

			// await をまたいだ読みは依存にならない(追跡は effect の同期実行の間だけ)。
			// untrack はその意図を明示するためのもの。
			const seconds = untrack(() => (barDuration > 0 ? barDuration : null));
			const result = await analyzeWaveform(target, {
				durationSeconds: seconds,
				hasAudioTrack: detectAudioTrack(el),
				decode: decodeWaveformAudio,
				extract: extractWaveformAudio,
			});
			settled = true;
			if (cancelled) return;
			waveform = result;
			waveformAnalyzing = false;
		})();

		return () => {
			cancelled = true;
			abortWait?.();
			// 結果が届く前に打ち切られたぶんは控えを戻す ―― 次の実行が解析を
			// やり直せるように。**`waveformAnalyzing` は降ろさない**:
			// 降ろすと「結果なし・解析中でもない」という宙ぶらりんの帯が残り得る
			// (契約⑤の「帯は必ず何かを語る」を状態機械の側でも守る)。
			if (!settled) analyzedSrc = null;
		};
	});

	/**
	 * 帯の描画(契約②)。波形が変わったときと幅・高さが変わったときだけ描き直す ――
	 * 再生ヘッドは別の要素なので、毎フレーム canvas を描き直す必要がない。
	 *
	 * 高さ(要件#42)は**この effect の本体で読んで引数で渡す**。`drawWaveform` の中で
	 * モジュールスコープの値を読む形にすると Svelte の依存追跡から漏れ、ドラッグで
	 * 高さを変えても canvas が古い高さのまま残る。倍率と窓(要件#47)も同じ理由で
	 * ここで読む ―― canvas の実寸は据え置きのまま中身だけを描き替えるので(契約⑨)、
	 * この effect が走り直すことが「拡大が画面に出る」唯一の経路になる。
	 */
	$effect(() => {
		const canvas = waveformCanvas;
		const result = waveform;
		const width = waveformWidth;
		const height = waveformHeight;
		const zoom = waveformZoom;
		const start = waveformWindowStart;
		const seconds = waveformSeconds;
		if (!canvas || width <= 0) return;
		// 解析中と縮退のときは消す ―― 前の動画の波形が残ったまま「解析中」と
		// 出ていたら、どちらの音を見ているのか判らない。
		const lanes = result?.state === 'ready' ? windowLanes(result, zoom, start, seconds) : null;
		drawWaveform(canvas, lanes, width, height);
	});

	/**
	 * 帯の上端ハンドルのドラッグ(要件#42)。作法は要件#9 の `.pane-divider` と同じで、
	 * ポインタを捕捉して window への購読を持たずに済ませる。
	 */
	function startWaveformResize(event: PointerEvent): void {
		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		// 塊(stage + controls)が pane に対して余らせている高さ。中央寄せなので
		// この余白は上下へ半分ずつ配られており、帯を伸ばせる「ただの余地」がこれだけある。
		const block = (stage?.offsetHeight ?? 0) + (controls?.offsetHeight ?? 0);
		const freeSpace = Math.max(0, (pane?.clientHeight ?? 0) - block);
		dragStart = { height: waveformHeight, y: event.clientY, freeSpace };
		resizingWaveform = true;
		event.preventDefault(); // ドラッグ中のテキスト選択を抑止
	}

	function moveWaveformResize(event: PointerEvent): void {
		const start = dragStart;
		if (!resizingWaveform || !start) return;
		// d = 上向きの移動量。開始時キャプチャからの差分だけを渡す(契約④)。
		const d = start.y - event.clientY;
		waveformHeight = dragWaveformHeight(start.height, d, start.freeSpace, window.innerHeight);
	}

	function endWaveformResize(event: PointerEvent): void {
		if (!resizingWaveform) return;
		resizingWaveform = false;
		dragStart = null;
		const handle = event.currentTarget as HTMLElement;
		if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
		// 保存はドラッグ確定時のみ(要件#9 と同じ理由 ―― 途中経過を保存値にしない)。
		saveWaveformHeight(waveformHeight);
	}

	// 保存値の復元と、ウインドウ高の変化への追従(要件#42)。起動ごと(= 新規
	// ウインドウごと)にこの onMount が走るので、再起動にも新規ウインドウにも同じ
	// 保存値が効く。clamp をモジュールのトップで呼ばないのは、SSR / テストで
	// window が居ないため。
	onMount(() => {
		waveformHeight = loadWaveformHeight(window.innerHeight);
		const handleWindowResize = () => {
			// ウインドウが縮んだときは上限40%に収め直す。保存はしない ――
			// 保存値はユーザーが選んだ高さであって、ウインドウ都合の縮小ではない。
			waveformHeight = clampWaveformHeight(waveformHeight, window.innerHeight);
		};
		window.addEventListener('resize', handleWindowResize);
		return () => window.removeEventListener('resize', handleWindowResize);
	});

	/**
	 * この動画に音声があるか(契約⑤の事前判定)。
	 *
	 * **判らないときは `null`** ―― `audioTracks` はメタデータが届く前は空なので、
	 * 早すぎる問い合わせを「音声なし」と読むと、音のある動画の波形が出なくなる。
	 * `audioTracks` を持たない環境も同じ扱いで、その先の解析に判断を委ねる。
	 */
	/**
	 * メタデータの到達を待つ(要件#44 契約②)。
	 *
	 * 解析 effect の依存に `<video>` の状態を入れない代わりに、非同期フローの側で
	 * 一度だけ待つ。**待ちは必ず解ける**ようにしてある ―― 既に届いていれば即座に、
	 * 読み込みに失敗すれば `error` で。要素そのものが居ないときも待たない
	 * (その先の `detectAudioTrack` が null =「判らない」を返し、解析の分岐に委ねる)。
	 *
	 * `onAbort` には「待ちを外から解く手」を預ける ―― effect が打ち切られたときに
	 * 購読を残さないため。
	 */
	function waitForMetadata(
		el: HTMLVideoElement | undefined,
		onAbort: (abort: () => void) => void,
	): Promise<void> {
		if (!el || el.readyState >= el.HAVE_METADATA) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const done = () => {
				el.removeEventListener('loadedmetadata', done);
				el.removeEventListener('error', done);
				resolve();
			};
			el.addEventListener('loadedmetadata', done);
			el.addEventListener('error', done);
			onAbort(done);
		});
	}

	function detectAudioTrack(el: HTMLVideoElement | undefined): boolean | null {
		if (!el || el.readyState < el.HAVE_METADATA) return null;
		const tracks = (el as HTMLVideoElement & { audioTracks?: { length: number } }).audioTracks;
		// 空(length 0)は「音声なし」の証拠にならない ―― WebKit は audioTracks の充填が
		// loadedmetadata より遅れることがあり、この時点の 0 を false と読むと音のある動画が
		// 全部 no-audio 縮退になる(2026-09-02 実機=backlog 102)。真の no-audio 判定は
		// 抽出コマンドの応答(mov/mp4 は Rust パーサ)に委ねる ―― 契約⑤の fail-open と同じ読み。
		if (tracks && typeof tracks.length === 'number' && tracks.length > 0) return true;
		return null;
	}

	/**
	 * いま描くべきレーンの包絡(要件#47 契約⑦⑨)。
	 *
	 * **等倍のときは解析済みの `lanes` をそのまま返す** ―― 再バケット化を通しても同じ絵に
	 * なる(`windowPeaks` の等価性契約)が、通さないほうが速く、「拡大機能を足しても
	 * 等倍の帯は一切変わらない」が構造で判る。
	 *
	 * 拡大時は生標本から窓を切り直す。生標本を持たない素材(保持上限超過=契約⑦の縮退)は
	 * 粗レベルから作る ―― 包絡はやや太る(生由来を包含する)が、**山を実際より小さく
	 * 見せない**向きの誤差なので、カット位置を探す用途では嘘にならない。材料がどちらも
	 * 無ければ等倍の絵へ倒す(fail-open=帯が空白になるより古い倍率の絵のほうがまだ読める)。
	 */
	function windowLanes(
		result: WaveformResult & { state: 'ready' },
		zoom: number,
		start: number,
		seconds: number,
	): WaveformPeaks[] {
		if (zoom <= 1 || !(seconds > 0)) return result.lanes;

		const rate = result.sampleRate ?? 0;
		if (!(rate > 0)) return result.lanes;

		const samples = result.samples;
		if (samples) {
			return samples.map((lane) => windowPeaks(lane, rate, start, seconds, WAVEFORM_BUCKETS));
		}
		const coarse = result.coarse;
		if (coarse) {
			return coarse.map((lane) =>
				windowPeaksFromCoarse(lane, rate, start, seconds, WAVEFORM_BUCKETS),
			);
		}
		return result.lanes;
	}

	/**
	 * 倍率を変える(要件#47 契約④)。判定は `zoomWaveformAtAnchor` が全部持ち、ここは
	 * 「どこを固定点にするか」だけを決める。
	 *
	 * ボタン(×2 / ÷2 / 等倍)のアンカーは**帯の中央** ―― 押した指はボタンの上にあって
	 * 帯の上にないので、いま真ん中に見えているものが真ん中に残るのが素直。ホイールの
	 * アンカーはポインタ位置(呼び出し側が渡す)。
	 */
	function applyWaveformZoom(nextZoom: number, anchorX: number): void {
		const next = zoomWaveformAtAnchor(
			waveformZoom,
			waveformWindowStart,
			nextZoom,
			anchorX,
			waveformWidth,
			barDuration,
			waveformMinWindow,
		);
		waveformZoom = next.zoom;
		waveformWindowStart = next.windowStart;
	}

	/** ×2 / ÷2 / 等倍ボタン(契約④)。倍率の上下限と窓の解き直しは純関数側の仕事。 */
	function zoomWaveformBy(factor: number): void {
		applyWaveformZoom(waveformZoom * factor, waveformWidth / 2);
	}

	function resetWaveformZoom(): void {
		applyWaveformZoom(1, waveformWidth / 2);
	}

	/**
	 * 帯の上のホイール(要件#47 契約④)。
	 *
	 * - **Option+ホイール** = 倍率(追補a=2026-09-03 由谷指示。ctrl+ホイールは macOS の
	 *   画面拡大に取られるため使わない)。アンカーはポインタの x ―― 摘まんだところが
	 *   動かないのが体感の要
	 * - **ctrl+ホイール** = 何もしない(`preventDefault` もせず OS の画面拡大に譲る)。
	 *   トラックパッドのピンチは WebKit では ctrl+wheel として届くため v1 では拾わない(v2 候補)
	 * - **Shift+ホイール / 横成分** = 窓の横送り
	 *
	 * 幅は `bind:clientWidth` で測った帯幅を使う。`getBoundingClientRect().width` は
	 * ここでは使えない ―― x の起点(`rect.left`)だけをそこから取る。
	 *
	 * `preventDefault` は扱った操作にだけ掛ける(Option+ホイールは倍率変更そのもの、
	 * 横成分は履歴の戻る/進むを止める)。ctrl+ホイールと素の縦回しには触らない。
	 */
	function onWaveformWheel(event: WheelEvent & { currentTarget: HTMLElement }): void {
		if (barDuration <= 0) return;
		if (event.ctrlKey) return;

		if (event.altKey) {
			event.preventDefault();
			const delta = normalizeWheelDelta(event.deltaY, event.deltaMode);
			const bounds = event.currentTarget.getBoundingClientRect();
			applyWaveformZoom(waveformZoom * wheelZoomFactor(delta), event.clientX - bounds.left);
			return;
		}

		// Shift+ホイールは環境によって横成分に載る場合と縦成分のままの場合がある
		// (WebKit は前者・そうでない環境もある)ので、両方を横送りとして読む。
		const raw = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
		if (raw === 0) return;

		event.preventDefault();
		waveformWindowStart = scrollWaveformWindow(
			waveformWindowStart,
			waveformSeconds,
			barDuration,
			normalizeWheelDelta(raw, event.deltaMode),
			waveformWidth,
		);
	}

	/**
	 * 再生位置に窓を追従させる(要件#47 契約⑥)。
	 *
	 * 窓の中に居る間は動かさない ―― 毎フレーム窓が流れると波形の形が読めない。外へ
	 * 出た瞬間だけ送る。等倍のときは窓の概念が無いので何もしない。追従のオン/オフ UI は
	 * v1 では設けない(契約⑥)。
	 */
	function followWaveform(seconds: number): void {
		if (waveformZoom <= 1) return;
		waveformWindowStart = followWaveformWindow(
			seconds,
			waveformWindowStart,
			waveformSeconds,
			barDuration,
		);
	}

	/**
	 * エンベロープ帯を描く(契約②・追補d)。
	 *
	 * レーンの縦の器は `laneBoxes`・その中の矩形は `peakRects` が決め、ここは器の
	 * 高さで矩形を作って `y` だけずらして塗る ―― レーンが1本でも2本でも同じ道を
	 * 通り、帯の総高は変わらない。
	 *
	 * 色はテーマ変数を CSS 側で canvas に載せ、その計算値を読む(`color` が波形・
	 * `--color-border` が区切り線)―― canvas の中身はテーマの切り替えに自動では
	 * 追従しないので、描き直しのたびに現在の色を引き直す。
	 */
	function drawWaveform(
		canvas: HTMLCanvasElement,
		lanes: WaveformPeaks[] | null,
		width: number,
		height: number,
	): void {
		const ratio = window.devicePixelRatio || 1;
		canvas.width = Math.max(1, Math.round(width * ratio));
		canvas.height = Math.max(1, Math.round(height * ratio));

		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, width, height);
		if (!lanes || lanes.length === 0) return;

		const style = getComputedStyle(canvas);
		const waveColor = style.color;
		const dividerColor = style.getPropertyValue('--color-border').trim() || waveColor;

		const boxes = laneBoxes(lanes.length, height);
		for (let i = 0; i < boxes.length; i++) {
			const box = boxes[i];
			ctx.fillStyle = waveColor;
			for (const rect of peakRects(lanes[i], width, box.h)) {
				// バケットが画素より細かいときでも隙間を作らない。無音(高さ0)も
				// 中央線として1px 残す — 「音が無い区間」も形の一部。
				ctx.fillRect(rect.x, box.y + rect.y, Math.max(rect.w, 1), Math.max(rect.h, 1));
			}
			// レーンの境目に細い線を1本。L と R が地続きに見えると、上下 どちらの
			// 山を見ているのか判らなくなる。
			if (i > 0) {
				ctx.fillStyle = dividerColor;
				ctx.fillRect(0, box.y, width, 1);
			}
		}
	}

	/**
	 * 波形クリックでシーク(要件#41 契約⑥・要件#47 契約⑤)。
	 *
	 * 跳び先は `waveformZoomSeekTime` ―― 窓と倍率を通して時刻を出したあとは要件#37 の
	 * 吸着経路(`nearestFrame` → `seekTimeForFrame`)なので、拡大していてもシークバーを
	 * 離したときと同じフレームに着く。**等倍では従来の `waveformSeekTime` と完全に一致
	 * する**(窓 = 全尺のときの等式契約)ので、拡大機能を足しても等倍の着地は動かない。
	 * 映像が一緒に動くのは `currentTime` 代入の既存経路のまま(追加実装なし)。
	 *
	 * 控え(`requestedFrame`)と初期シークの扱いは `onScrubCommit` と同じ形。
	 */
	function onWaveformClick(event: MouseEvent & { currentTarget: HTMLCanvasElement }): void {
		const el = video;
		if (!el || barDuration <= 0) return;

		const bounds = event.currentTarget.getBoundingClientRect();
		const x = event.clientX - bounds.left;
		const start = waveformWindowStart;
		const seconds = waveformSeconds;

		initialSeekPending = false;
		const index = frameIndex;
		requestedFrame = index
			? nearestFrame(index, windowXToTime(x, bounds.width, start, seconds))
			: null;
		el.currentTime = waveformZoomSeekTime(x, bounds.width, start, seconds, index);
		// クリックで窓の外へ跳んだときも窓が付いていく(契約⑥の追従規則は前後どちらも同じ)。
		followWaveform(el.currentTime);
	}

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
		// 拡大中に再生が窓の外へ出たら窓を送る(要件#47 契約⑥)。
		followWaveform(mediaTime);
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
		<!--
			波形のトグルは要件#44 で廃止 ―― 帯は常時表示で、音が無いことも読めない
			ことも帯そのものが言う(押して初めて出るものではない)。
		-->
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
		<div class="video-stage" bind:this={stage}>
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
			<div class="video-controls" bind:this={controls}>
				<!--
					エンベロープ帯(要件#41 契約②)。シークバーと同じ器(`.video-controls`
					の内側)に同じ幅で置くので、横軸は自然に一致する。再生ヘッドは canvas
					の外の要素で、位置だけを `translateX` で動かす ―― 波形そのものは
					位置が変わるたびに描き直す必要がない。

					要件#44 で**常時表示** ―― 帯もハンドルも条件なしで置く。中身が
					まだ無い間は「解析中」の文言が入るので、無地の帯にはならない。
				-->
				<!--
					帯の上端の仕切り(要件#42)。ドラッグ専用のハンドルで、既定高へ戻す
					手段(ダブルクリック等)は設けない ―― 要件#9 の `.pane-divider` と
					同じ整理を、縦向きに写したもの。
				-->
				<div
					class="waveform-divider"
					class:dragging={resizingWaveform}
					role="separator"
					aria-orientation="horizontal"
					aria-label="波形の高さを変更"
					title="ドラッグで波形の高さを変更"
					onpointerdown={startWaveformResize}
					onpointermove={moveWaveformResize}
					onpointerup={endWaveformResize}
					onpointercancel={endWaveformResize}
				></div>
				<!--
					帯の上のホイールで拡大縮小と横送り(要件#47 契約④)。キーボード操作は
					**設けない** ―― ⌘+/− は要件#36 のビューアズームと衝突し、ネイティブ
					メニューのアクセラレータは WebView へ届かない(2026-09-03 由谷決定)。
					拡大縮小の代わりの手は下の3ボタン。

					`wheel` はここでしか受けないので、a11y 検査の「対話要素でない要素の
					イベント」だけ黙らせる(帯そのものはクリックでシークできる面で、
					その経路は canvas 側が持つ)。
				-->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div
					class="video-waveform"
					style="height: {waveformHeight}px"
					bind:clientWidth={waveformWidth}
					onwheel={onWaveformWheel}
				>
					<!--
						`bind:this` は描画 effect の生命線 ―― これが無いと canvas は
						永遠に undefined で、解析は成功しているのに帯だけが無地になる
						(2026-09-01 実機不具合)。VideoViewer.wiring.test.ts が
						`getContext('2d')` の呼び出しでこの結線を見張っている。
					-->
					<canvas
						class="waveform-canvas"
						bind:this={waveformCanvas}
						aria-label="音声波形(クリックでその位置へシーク)"
						onclick={onWaveformClick}
					></canvas>
					{#if waveformNote}
						<span class="waveform-note">{waveformNote}</span>
					{:else}
						<!--
							ステレオの L/R ラベル(追補d)。レーンの器は laneBoxes が
							決めるので、ラベルの縦位置も同じ値から取る(canvas の中に
							焼き込まないのは、テーマ色と文字の描画を DOM に任せるため)。
						-->
						{#each waveformLaneLabels as label (label.text)}
							<span class="waveform-lane-label" style="top: {label.y}px">{label.text}</span>
						{/each}
						<!--
							再生ヘッドは窓の中に居るときだけ(要件#47 契約⑥)。窓の外を端へ
							clamp して描くと、居ない場所にヘッドが立つ ―― 拡大中は窓の外が
							大半なので、その嘘は読み手を確実に迷わせる。
						-->
						{#if waveformHeadX !== null}
							<div class="waveform-head" style="transform: translateX({waveformHeadX}px)"></div>
						{/if}
					{/if}
				</div>

				<!--
					シークバーは**全尺のまま据え置き**(要件#47 契約③=案B)。拡大しても
					バーの目盛りは動かず、帯だけが窓を映す ―― 両方が一緒に伸び縮みすると
					「全体のどこを見ているか」を語るものが無くなる。その役目をこの器に
					重ねた窓指標が持つ。
				-->
				<div class="video-seek-track" bind:clientWidth={seekWidth}>
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
					{#if waveformIndicator}
						<!--
							窓指標。`pointer-events: none` でつまみの操作を妨げない(契約③)。
							倍率 1 では `waveformWindowIndicator` が null =出さないので、
							枠が見えていること自体が「拡大中」の合図になる。
						-->
						<div
							class="seek-window-indicator"
							style="left: {waveformIndicator.left}px; width: {waveformIndicator.width}px"
						></div>
					{/if}
				</div>

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

					<!--
						波形の時間軸ズーム(要件#47 契約④)。キーボードは割り当てないので、
						**この3つがマウスだけで拡大縮小できる唯一の手**(帯上の Option+ホイールと
						並ぶ)。押した指はボタンの上にあって帯の上にないので、アンカーは帯の中央
						―― いま真ん中に見えているものが真ん中に残る。
						表示は記号だけにして、読み上げ用の名前は aria-label が持つ。
					-->
					<span class="video-zoom-group">
						<button
							type="button"
							class="video-button video-zoom"
							title="波形を拡大(×2)"
							aria-label="波形を拡大"
							onclick={() => zoomWaveformBy(2)}
						>
							＋
						</button>
						<button
							type="button"
							class="video-button video-zoom"
							title="波形を縮小(÷2)"
							aria-label="波形を縮小"
							onclick={() => zoomWaveformBy(0.5)}
						>
							−
						</button>
						<button
							type="button"
							class="video-button video-zoom"
							title="波形を等倍に戻す"
							aria-label="波形を等倍に戻す"
							onclick={resetWaveformZoom}
						>
							等倍
						</button>
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

	/*
	 * 再生面とバーをまとめた操作単位。フォーカスリングはこの枠に出す。
	 *
	 * `justify-content: center`(要件#43 契約①)で映像と操作部を**ひと塊**として
	 * 縦中央へ置く ―― 余った高さは塊の上下へ均等に配られ、波形帯は画面最下部ではなく
	 * 映像のすぐ下に見える。
	 */
	.video-pane {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		justify-content: center;
		overflow: hidden;
		outline-offset: -2px;
	}

	/*
	 * 再生面。背景はテーマの単色(要件#16 ⑤の画像と同じ考え)で、レターボックスの
	 * 帯もこの色になる。
	 *
	 * `flex: 0 1 auto`(要件#43 契約②)―― 中身の高さで立ち、pane に収まらないときだけ
	 * 縮む。`flex: 1` で pane を埋めていた頃と違い、塊が pane より低ければそのぶんが
	 * 中央寄せの余白になる。
	 */
	.video-stage {
		flex: 0 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		padding: 16px;
		background-color: var(--color-bg-primary);
	}

	/*
	 * 収まらない動画だけを縮める。小さい動画は原寸のまま(引き伸ばさない)。
	 *
	 * 縮退は %高さではなく flex-shrink で表す(要件#43 契約②)―― ウインドウが低いとき
	 * 縮むのは映像だけで、操作部(固定高)は削られない。`min-height: 0` が無いと flex は
	 * 中身の最小寸法より下に縮めず、塊が pane からはみ出す。
	 */
	.video {
		flex: 0 1 auto;
		min-height: 0;
		max-width: 100%;
	}

	.video-placeholder {
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

	/*
	 * 波形帯。シークバーの直上・同じ幅(要件#41 契約②)。`color` は canvas の塗り色を
	 * テーマから拾うための置き場で、文字には使わない(描画側が getComputedStyle で読む)。
	 */
	/*
	 * 帯の上端の掴みしろ(要件#42)。見た目の線は帯の border-top が持ち、この要素は
	 * 掴みやすさのための当たり判定。掴んでいる間だけ色が付く(`.pane-divider` と同形)。
	 */
	.waveform-divider {
		flex-shrink: 0;
		height: 6px;
		margin-bottom: -2px; /* 帯の枠線をまたいで置き、線の見た目を動かさない */
		cursor: row-resize;
		background-color: transparent;
		touch-action: none; /* ドラッグがスクロールに取られないように */
	}

	.waveform-divider:hover,
	.waveform-divider.dragging {
		background-color: var(--color-border);
	}

	.video-waveform {
		position: relative;
		width: 100%;
		flex-shrink: 0;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background-color: var(--color-bg-secondary);
		color: var(--color-text-secondary);
	}

	.waveform-canvas {
		display: block;
		width: 100%;
		height: 100%;
		cursor: pointer;
	}

	/* 再生ヘッド。左端を基準に translateX だけで動かす(再描画を伴わない)。 */
	.waveform-head {
		position: absolute;
		top: 0;
		left: 0;
		width: 1px;
		height: 100%;
		background-color: var(--color-text-primary);
		pointer-events: none;
	}

	/*
	 * L/R ラベル(追補d)。波形の上に小さく重ねるので、地の色を敷いて読めるようにする。
	 * クリックはラベルを素通りして帯へ届く(帯全域でシークできる=契約⑥)。
	 */
	.waveform-lane-label {
		position: absolute;
		left: 3px;
		padding: 1px 3px;
		border-radius: 2px;
		font-size: 10px;
		line-height: 1.2;
		color: var(--color-text-secondary);
		background-color: var(--color-bg-secondary);
		pointer-events: none;
	}

	/* 縮退の理由と解析中の表示。波形の代わりに帯の中央へ出す(契約⑤)。 */
	.waveform-note {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		color: var(--color-text-secondary);
		pointer-events: none;
	}

	/*
	 * シークバーの器(要件#47 契約③)。窓指標を重ねるための位置基準で、幅は
	 * `bind:clientWidth` で測って指標の px 座標に使う。
	 */
	.video-seek-track {
		position: relative;
		width: 100%;
	}

	.video-seek {
		display: block;
		width: 100%;
		margin: 0;
		accent-color: var(--color-text-secondary);
		cursor: pointer;
	}

	.video-seek:disabled {
		cursor: default;
	}

	/*
	 * 窓指標(要件#47 契約③)。バーの上に薄い枠を重ねるだけで、つまみの操作は
	 * `pointer-events: none` で素通りさせる。色はテーマ変数から取る ―― 目立たせすぎると
	 * バーそのものが読めなくなり、薄すぎると拡大中かどうかが判らない。
	 */
	.seek-window-indicator {
		position: absolute;
		top: 0;
		bottom: 0;
		box-sizing: border-box;
		border: 1px solid var(--color-text-secondary);
		border-radius: 3px;
		background-color: var(--color-bg-hover);
		opacity: 0.5;
		pointer-events: none;
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

	/*
	 * 波形ズームの3ボタン(要件#47 契約④)。ひと組に見えるよう間を詰めて置く ――
	 * コマ送りの歩幅ボタンとは役割が違う(横軸の縮尺であって位置ではない)ので、
	 * 塊として分かれて見えるほうが押し間違えない。
	 */
	.video-zoom-group {
		display: flex;
		align-items: center;
		gap: 2px;
		margin-left: 8px;
	}

	.video-zoom {
		min-width: 32px;
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
