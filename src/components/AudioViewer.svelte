<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		DEFAULT_AUDIO_WAVEFORM_HEIGHT,
		audioAxisDuration,
		audioViewMode,
		audioWaveformNote,
		durationMismatch,
		loadAudioWaveformHeight,
		saveAudioWaveformHeight,
	} from '$lib/audio-viewing';
	import { formatMilliTime } from '$lib/video-frame';
	import {
		WAVEFORM_BUCKETS,
		analyzeWavWaveform,
		analyzeWaveform,
		decodeWaveformAudio,
		extractWaveformAudio,
		laneBoxes,
		peakRects,
		type WaveformPeaks,
		type WaveformResult,
	} from '$lib/audio-waveform';
	import { clampWaveformHeight, dragWaveformHeight } from '$lib/waveform-resize';
	import {
		followWaveformWindow,
		normalizeWheelDelta,
		scrollWaveformWindow,
		waveformMinWindowSeconds,
		waveformWindowIndicator,
		waveformWindowSeconds,
		waveformZoomHeadX,
		wheelZoomFactor,
		windowPeaks,
		windowPeaksFromCoarse,
		windowXToTime,
		zoomWaveformAtAnchor,
	} from '$lib/waveform-zoom';

	let {
		uri,
		src,
	}: {
		/** 表示中のファイルの絶対 URI(file: / ssh:)。再生可否の判定と表示名に使う。 */
		uri: string;
		/**
		 * `<audio>` に載せる `vellis-asset:` URI(`renderForDisplay` が組み立て、
		 * 変更のたび版数が付く=要件#22 の機構)。プレースホルダのときは使わない。
		 */
		src: string;
	} = $props();

	/** ←/→ の秒送り(契約⑩)。音声にフレームは無いのでコマ送りを秒送りへ置き換える。 */
	const COARSE_STEP_SECONDS = 5;
	/** Shift 併用の細かい秒送り(契約⑩)。 */
	const FINE_STEP_SECONDS = 1;

	let fileName = $derived(uri.slice(uri.lastIndexOf('/') + 1));
	let mode = $derived(audioViewMode(uri));

	let audio: HTMLAudioElement | undefined = $state();
	let pane: HTMLDivElement | undefined = $state();
	/** 中央寄せされる塊の実体。高さドラッグの自由余白を測るためだけに持つ。 */
	let stage: HTMLDivElement | undefined = $state();
	let controls: HTMLDivElement | undefined = $state();
	let waveformCanvas: HTMLCanvasElement | undefined = $state();

	// 再生の開始に失敗した(ファイル消滅・デコード不能)。無音のまま何も起きないより、
	// 再生できないことを文字で返す(VideoViewer の loadFailed と同じ整理)。
	let loadFailed = $state(false);
	let playing = $state(false);
	let audioMuted = $state(false);
	/** 表示の基準になる再生位置(秒)。rAF と `seeked` が書き込む(契約④)。 */
	let position = $state(0);
	/** `<audio>` が申告した総尺(秒)。undefined =まだ何も申告が無い。 */
	let mediaDuration = $state<number | undefined>(undefined);
	/** シークバーを掴んでいる間の位置(秒)。null =掴んでいない。 */
	let scrubbing = $state<number | null>(null);

	/** 解析結果。null =まだ解析していない(src が変わった直後・解析中)。 */
	let waveform = $state<WaveformResult | null>(null);
	let waveformAnalyzing = $state(false);
	/**
	 * どの `src` の波形を持っているか。版数付きの `src` が鍵なので、同じファイルを
	 * 聴いている間の解析は1回きり・ディスク上の実体が差し替われば作り直しになる。
	 * `$state` にしないのは、これが表示ではなく「済んだかどうか」の控えだから
	 * (解析の起動条件に自分が入ると回り続ける)。
	 */
	let analyzedSrc: string | null = null;
	/** 帯の実幅(px)。シークバーと同じ幅の器に置くので、これが横軸の長さになる。 */
	let waveformWidth = $state(0);
	/** シークバーの器の実幅(px)。窓指標の left/width をここへ写す。 */
	let seekWidth = $state(0);
	/** 波形の時間軸の倍率(要件#47 契約①②)。1 =全尺が帯幅に収まる状態。 */
	let waveformZoom = $state(1);
	/** 窓の開始時刻(秒)。倍率 1 のときは常に 0。 */
	let waveformWindowStart = $state(0);
	/**
	 * 波形帯の高さ(px・契約⑪)。既定 240px ―― 映像領域が無いぶんペインの縦を帯に回す。
	 * 初期値は既定高で、onMount で音声側の保存値(動画とは別キー)に差し替わる。
	 */
	let waveformHeight = $state(DEFAULT_AUDIO_WAVEFORM_HEIGHT);
	/** 帯の上端ハンドルを掴んでいるか。掴んでいる間だけ仕切りに色が付く。 */
	let resizingWaveform = $state(false);
	/** ドラッグ開始時のキャプチャ(要件#43 契約④と同形)。 */
	let dragStart: { height: number; y: number; freeSpace: number } | null = null;

	/**
	 * 横軸の尺(契約④(b))。第2引数が解析尺 ―― `<audio>` が尺を言えない(NaN/Infinity)
	 * ときの受け皿になる。判断そのものは純関数 `audioAxisDuration` の持ち場。
	 */
	let barDuration = $derived(
		audioAxisDuration(
			mediaDuration,
			waveform?.state === 'ready' ? (waveform.durationSeconds ?? null) : null,
		),
	);
	let barPosition = $derived(scrubbing ?? position);

	/** いま帯が映している窓の実尺(秒・要件#47 契約②)。倍率 1 なら全尺そのもの。 */
	let waveformSeconds = $derived(waveformWindowSeconds(waveformZoom, barDuration));
	/** この素材で許される窓の下限(秒)。生標本を捨てた素材では粗レベルの刻みが底になる。 */
	let waveformMinWindow = $derived(
		waveformMinWindowSeconds(
			waveform?.state === 'ready' && !waveform.samples,
			waveform?.state === 'ready' ? (waveform.sampleRate ?? 0) : 0,
		),
	);
	/** 再生ヘッドの x、または null =窓の外(要件#47 契約⑥=居ない場所には描かない)。 */
	let waveformHeadX = $derived(
		waveformZoomHeadX(barPosition, waveformWindowStart, waveformSeconds, waveformWidth),
	);
	/** シークバーへ重ねる窓指標(要件#47 契約③)。倍率 1 では null =出さない。 */
	let waveformIndicator = $derived(
		waveformWindowIndicator(waveformWindowStart, waveformSeconds, barDuration, seekWidth),
	);
	/** 帯に出す文言(解析中・縮退の理由)。null のときだけ波形そのものを出す(契約⑫)。 */
	let waveformNote = $derived(audioWaveformNote(waveform, waveformAnalyzing));
	/**
	 * ステレオのときだけ出す L/R ラベル(契約⑥)。縦位置はレーンの器と同じ値から取る。
	 * 1段(mono・縮退)では出さない ―― 段が1つならラベルは何も足さない。
	 */
	let waveformLaneLabels = $derived(
		waveform?.state === 'ready' && waveform.lanes.length === 2
			? laneBoxes(2, waveformHeight).map((box, index) => ({
					text: index === 0 ? 'L' : 'R',
					y: box.y,
				}))
			: [],
	);

	// 読み込み直しのたびに再生状態と波形と窓を捨てる。+page.svelte は AudioViewer を
	// `{#key}` で囲まないので同じインスタンスがファイル間で使い回される ―― 落とさないと、
	// 一度の読込失敗で再生できるファイルまでプレースホルダのままになり、再生中に別の
	// ファイルを開くと「再生中」の表示だけが残る。消音は素材ではなく人の設定なので残す。
	// 波形と窓も別物(窓は特定の素材の中の位置)なので捨てる。
	$effect(() => {
		void src;
		loadFailed = false;
		playing = false;
		position = 0;
		mediaDuration = undefined;
		scrubbing = null;
		waveform = null;
		waveformAnalyzing = false;
		analyzedSrc = null;
		waveformZoom = 1;
		waveformWindowStart = 0;
	});

	/**
	 * 波形の解析(契約⑤)。走るのは**この `src` をまだ解析していないとき**で、開閉の
	 * 条件は無い ―― 帯は常時表示なので、開いた時点が解析の起点になる。
	 *
	 * 追跡するのは `src` と表示形態の2つだけ。尺や `<audio>` の状態まで追うと、解析中に
	 * 尺が判った瞬間に effect が再実行され、自分が始めた解析を巻き添えで打ち切ってしまう
	 * (要件#41 実装備考の整理)。音声トラックの有無は `<audio>` からは判らないので
	 * `null`(=判らない)を渡し、判断は経路側に委ねる。
	 */
	$effect(() => {
		const key = src;
		const inline = mode === 'inline';
		if (!inline || analyzedSrc === key) return;

		const target = untrack(() => uri);
		analyzedSrc = key;
		waveform = null;
		waveformAnalyzing = true;

		let settled = false;
		let cancelled = false;

		void (async () => {
			const seconds = untrack(() => (barDuration > 0 ? barDuration : null));
			const result = await analyzeWaveform(target, {
				durationSeconds: seconds,
				hasAudioTrack: null,
				decode: decodeWaveformAudio,
				extract: extractWaveformAudio,
				// wav の専用経路(契約⑯)。無圧縮の 2時間ファイルは WebView に載せられない
				// ので、Rust が 8kHz の包絡まで落としたものを受け取る。
				analyzeWav: analyzeWavWaveform,
			});
			settled = true;
			if (cancelled) return;
			waveform = result;
			waveformAnalyzing = false;
		})();

		return () => {
			cancelled = true;
			// 結果が届く前に打ち切られたぶんは控えを戻す(次の実行がやり直せるように)。
			// `waveformAnalyzing` は降ろさない ―― 降ろすと「結果なし・解析中でもない」
			// 宙ぶらりんの帯が残り得る。
			if (!settled) analyzedSrc = null;
		};
	});

	/**
	 * 食い違いを記録済みの `src`。$state にしないのは、これが表示ではなく「言ったか
	 * どうか」の控えだから(同じ食い違いを再描画のたびに吐かない)。
	 */
	let mismatchLoggedSrc: string | null = null;

	/**
	 * 要素の申告尺と解析尺の食い違いを記録する(契約④(b))。
	 *
	 * **軸は動かさない** ―― 表示はあくまで要素側のタイムラインに乗せたまま、事実だけを
	 * 開発者コンソールへ残す。VBR の mp3 で数百ミリ秒ずれるのは正常で、大きく食い違う
	 * ときだけが調べる価値のある事象になる。
	 */
	$effect(() => {
		const key = src;
		const media = mediaDuration;
		const analyzed = waveform?.state === 'ready' ? (waveform.durationSeconds ?? null) : null;
		if (!durationMismatch(media, analyzed)) return;
		if (mismatchLoggedSrc === key) return;
		mismatchLoggedSrc = key;
		console.warn(
			`要素の申告尺(${media} 秒)と解析尺(${analyzed} 秒)が食い違っています: ${fileName}`,
		);
	});

	/**
	 * 帯の描画(契約⑥⑦)。波形・幅・高さ・倍率・窓が変わったときだけ描き直す ――
	 * 再生ヘッドは別の要素なので、毎フレーム canvas を描き直す必要がない。
	 *
	 * 高さと倍率と窓は**この effect の本体で読んで引数で渡す**。`drawWaveform` の中で
	 * モジュールスコープの値を読む形にすると Svelte の依存追跡から漏れ、変えても
	 * canvas が古いまま残る。
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
		// 解析中と縮退のときは消す ―― 前のファイルの波形が残ったまま「解析中」と
		// 出ていたら、どちらの音を見ているのか判らない。
		const lanes = result?.state === 'ready' ? windowLanes(result, zoom, start, seconds) : null;
		drawWaveform(canvas, lanes, width, height);
	});

	// 保存値の復元と、ウインドウ高の変化への追従(契約⑪)。clamp をモジュールの
	// トップで呼ばないのは、SSR / テストで window が居ないため。
	onMount(() => {
		waveformHeight = loadAudioWaveformHeight(window.innerHeight);
		const handleWindowResize = () => {
			// ウインドウが縮んだときは上限に収め直す。保存はしない ―― 保存値は
			// ユーザーが選んだ高さであって、ウインドウ都合の縮小ではない。
			waveformHeight = clampWaveformHeight(waveformHeight, window.innerHeight);
		};
		window.addEventListener('resize', handleWindowResize);
		return () => window.removeEventListener('resize', handleWindowResize);
	});

	/**
	 * いま描くべきレーンの包絡(要件#47 契約⑦⑨)。
	 *
	 * 等倍のときは解析済みの `lanes` をそのまま返す ―― 再バケット化を通しても同じ絵に
	 * なるが、通さないほうが速い。拡大時は生標本から窓を切り直し、生標本を持たない素材
	 * (保持上限超過)は粗レベルから作る(包絡はやや太るが、山を実際より小さく見せない
	 * 向きの誤差)。材料がどちらも無ければ等倍の絵へ倒す(fail-open)。
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
	 * エンベロープ帯を描く(契約⑥)。レーンの縦の器は `laneBoxes`・その中の矩形は
	 * `peakRects` が決め、ここは器の高さで矩形を作って `y` だけずらして塗る。
	 *
	 * 色はテーマ変数を CSS 側で canvas に載せ、その計算値を読む ―― canvas の中身は
	 * テーマの切り替えに自動では追従しないので、描き直しのたびに現在の色を引き直す。
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
				// 中央線として 1px 残す ―― 「音が無い区間」も形の一部。
				ctx.fillRect(rect.x, box.y + rect.y, Math.max(rect.w, 1), Math.max(rect.h, 1));
			}
			// L と R が地続きに見えると、上下どちらの山を見ているのか判らなくなる。
			if (i > 0) {
				ctx.fillStyle = dividerColor;
				ctx.fillRect(0, box.y, width, 1);
			}
		}
	}

	/** 倍率を変える(要件#47 契約④)。判定は `zoomWaveformAtAnchor` が全部持つ。 */
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

	/** ×2 / ÷2 ボタン。押した指はボタンの上にあるので、アンカーは帯の中央。 */
	function zoomWaveformBy(factor: number): void {
		applyWaveformZoom(waveformZoom * factor, waveformWidth / 2);
	}

	function resetWaveformZoom(): void {
		applyWaveformZoom(1, waveformWidth / 2);
	}

	/**
	 * 帯の上のホイール(要件#47 契約④)。
	 *
	 * - **Option+ホイール** = 倍率(アンカーはポインタの x ―― 摘まんだところが動かない)
	 * - **ctrl+ホイール** = 何もしない(`preventDefault` もせず macOS の画面拡大に譲る)
	 * - **Shift+ホイール / 横成分** = 窓の横送り
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

		// Shift+ホイールは環境によって横成分に載る場合と縦成分のままの場合がある。
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
	 * 再生位置に窓を追従させる(要件#47 契約⑥)。窓の中に居る間は動かさない ――
	 * 毎フレーム窓が流れると波形の形が読めない。外へ出た瞬間だけ送る。
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
	 * 波形クリックでシーク(契約⑧)。窓と倍率を通して x を時刻へ直し、`currentTime` へ
	 * 直行する ―― **フレーム索引(要件#37)の吸着は通さない**。音声にフレームという
	 * 単位は存在せず、吸着先が無いものへ寄せる意味がない。
	 */
	function onWaveformClick(event: MouseEvent & { currentTarget: HTMLCanvasElement }): void {
		const el = audio;
		if (!el || barDuration <= 0) return;

		const bounds = event.currentTarget.getBoundingClientRect();
		const next = windowXToTime(
			event.clientX - bounds.left,
			bounds.width,
			waveformWindowStart,
			waveformSeconds,
		);
		el.currentTime = next;
		// 停止中は rAF が回らないので、跳んだ位置を自分で表示へ返す。
		position = next;
		// クリックで窓の外へ跳んだときも窓が付いていく(追従規則は前後どちらも同じ)。
		followWaveform(next);
	}

	/**
	 * 帯の上端ハンドルのドラッグ(契約⑪)。作法は要件#42 の動画側と同じで、ポインタを
	 * 捕捉して window への購読を持たずに済ませる。範囲の規則は `waveform-resize.ts` の
	 * 純関数を流用し、既定値と保存キーだけが音声側の持ち物になる。
	 */
	function startWaveformResize(event: PointerEvent): void {
		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		// 塊(stage + controls)が pane に対して余らせている高さ=帯を伸ばせる余地。
		const block = (stage?.offsetHeight ?? 0) + (controls?.offsetHeight ?? 0);
		const freeSpace = Math.max(0, (pane?.clientHeight ?? 0) - block);
		dragStart = { height: waveformHeight, y: event.clientY, freeSpace };
		resizingWaveform = true;
		event.preventDefault(); // ドラッグ中のテキスト選択を抑止
	}

	function moveWaveformResize(event: PointerEvent): void {
		const start = dragStart;
		if (!resizingWaveform || !start) return;
		// d = 上向きの移動量。開始時キャプチャからの差分だけを渡す。
		const d = start.y - event.clientY;
		waveformHeight = dragWaveformHeight(start.height, d, start.freeSpace, window.innerHeight);
	}

	function endWaveformResize(event: PointerEvent): void {
		if (!resizingWaveform) return;
		resizingWaveform = false;
		dragStart = null;
		const handle = event.currentTarget as HTMLElement;
		if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
		// 保存はドラッグ確定時のみ(途中経過を保存値にしない)。
		saveAudioWaveformHeight(waveformHeight);
	}

	/**
	 * 再生ヘッドの駆動(契約④)。
	 *
	 * `requestVideoFrameCallback` は `HTMLAudioElement` に無いので、再生中は
	 * `requestAnimationFrame` で `currentTime` を読む。`timeupdate` は毎秒4回程度しか
	 * 鳴らず、波形の上を滑るヘッドとしてはカクつく。停止中は回さない(`seeked` の一発で足りる)。
	 */
	$effect(() => {
		const el = audio;
		if (!el || !playing) return;

		let cancelled = false;
		let handle = 0;
		const tick = () => {
			if (cancelled) return;
			position = el.currentTime;
			// 拡大中に再生が窓の外へ出たら窓を送る(要件#47 契約⑥)。
			followWaveform(position);
			handle = requestAnimationFrame(tick);
		};
		handle = requestAnimationFrame(tick);

		return () => {
			cancelled = true;
			cancelAnimationFrame(handle);
		};
	});

	function togglePlay(): void {
		const el = audio;
		if (!el) return;
		if (el.paused) {
			void el.play().catch((err) => console.warn(`play failed for ${uri}:`, err));
		} else {
			el.pause();
		}
	}

	function toggleMute(): void {
		const el = audio;
		if (!el) return;
		el.muted = !el.muted;
	}

	/** `delta` 秒ぶん送る/戻す(契約⑩)。尺が判っていればその内側へ収める。 */
	function seekBy(delta: number): void {
		const el = audio;
		if (!el) return;
		const limit = barDuration > 0 ? barDuration : Number.POSITIVE_INFINITY;
		const next = Math.min(Math.max(el.currentTime + delta, 0), limit);
		el.currentTime = next;
		// 停止中は rAF が回らないので、送った位置を自分で表示へ返す。
		position = next;
		followWaveform(next);
	}

	/** 掴んでいる間も音は追従させる(離すまで待つ理由が無い)。 */
	function onScrubInput(event: Event & { currentTarget: HTMLInputElement }): void {
		const value = Number(event.currentTarget.value);
		scrubbing = value;
		if (audio) audio.currentTime = value;
	}

	function onScrubCommit(event: Event & { currentTarget: HTMLInputElement }): void {
		const value = Number(event.currentTarget.value);
		scrubbing = null;
		position = value;
		if (audio) audio.currentTime = value;
		followWaveform(value);
	}

	/**
	 * Space / 矢印の割り当て(契約⑩)。効くのはこのペインにフォーカスがあるときだけで、
	 * Explorer のキー操作とは競合しない。中の `<button>` や `<input type="range">` に
	 * フォーカスが載っていてもキーはここまで上がってくるので、既定動作を潰してから
	 * 同じ操作へ流す(VideoViewer と同じ整理)。
	 */
	function onKeyDown(event: KeyboardEvent): void {
		if (event.metaKey || event.ctrlKey || event.altKey) return;

		if (event.key === ' ') {
			event.preventDefault();
			togglePlay();
			return;
		}
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;

		event.preventDefault();
		const step = event.shiftKey ? FINE_STEP_SECONDS : COARSE_STEP_SECONDS;
		seekBy(event.key === 'ArrowRight' ? step : -step);
	}
</script>

<!--
	要件#50: 音声はアプリ内で再生する。デコードは WebKit に任せるが、操作はネイティブの
	`controls` ではなく自前のバー ―― 2周目で足す波形帯とシークバーの横軸を一致させるには
	バーの幅と目盛りを自分で持つ必要がある。自動再生はしない(開いた瞬間に音が鳴らない
	こと自体が契約)。
-->
<article class="audio-viewer">
	<header class="audio-toolbar">
		<span class="audio-name" title={uri}>{fileName}</span>
	</header>

	<!--
		キーボード操作の受け口。フォーカスをここに集めることで、Space / 矢印が音声を
		聴いているときだけ効く(契約⑩)。a11y 検査は `role="application"` を対話要素と
		見ないので、フォーカス可能にすることとキーを受けることの両方を咎める。キーで
		操作する面である以上どちらも要るため、この2件だけ黙らせる(VideoViewer と同形)。
	-->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="audio-pane"
		bind:this={pane}
		role="application"
		aria-label="音声プレーヤー({fileName})。Space で再生/停止・←/→ で {COARSE_STEP_SECONDS} 秒送り・Shift+←/→ で {FINE_STEP_SECONDS} 秒送り"
		tabindex="0"
		onkeydown={onKeyDown}
	>
		<!--
			映像領域が無いぶん、波形帯が主役として入る器(契約⑨)。動画では帯が
			シークバーの直上の細い添え物だったが、ここでは帯そのものが画面の中身になる。
		-->
		<div class="audio-stage" bind:this={stage}>
			{#if mode === 'inline' && !loadFailed}
				<!--
					帯の上端の仕切り(契約⑪)。ドラッグ専用のハンドルで、既定高へ戻す手段
					(ダブルクリック等)は設けない ―― 要件#42 の動画側と同じ整理。
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
					帯の上のホイールで拡大縮小と横送り(契約⑦)。キーボード操作は設けない
					―― ⌘+/− は要件#36 のビューアズームと衝突する。代わりの手は下の3ボタン。

					`wheel` はここでしか受けないので、a11y 検査の「対話要素でない要素の
					イベント」だけ黙らせる(クリックでシークする経路は canvas 側が持つ)。
				-->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div
					class="audio-waveform"
					style="height: {waveformHeight}px"
					bind:clientWidth={waveformWidth}
					onwheel={onWaveformWheel}
				>
					<!--
						`bind:this` は描画 effect の生命線 ―― これが無いと canvas は永遠に
						undefined で、解析は成功しているのに帯だけが無地になる(2026-09-01 の
						動画側の実機不具合)。AudioViewer.wiring.test.ts が `getContext('2d')` の
						呼び出しでこの結線を見張っている。
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
							ステレオの L/R ラベル(契約⑥)。レーンの器は laneBoxes が決めるので、
							ラベルの縦位置も同じ値から取る(canvas の中に焼き込まないのは、
							テーマ色と文字の描画を DOM に任せるため)。
						-->
						{#each waveformLaneLabels as label (label.text)}
							<span class="waveform-lane-label" style="top: {label.y}px">{label.text}</span>
						{/each}
						<!--
							再生ヘッドは窓の中に居るときだけ(契約⑦)。窓の外を端へ clamp して
							描くと、居ない場所にヘッドが立つ。
						-->
						{#if waveformHeadX !== null}
							<div class="waveform-head" style="transform: translateX({waveformHeadX}px)"></div>
						{/if}
					{/if}
				</div>
			{/if}
		</div>

		{#if mode === 'inline' && !loadFailed}
			<!--
				src が変われば(別ファイル・ディスク上の変更による版数更新)プレーヤーごと
				作り直す。前のファイルの再生位置や再生中の状態を持ち越さないため。
				`preload` は "metadata" ―― 尺だけ判れば軸は立ち、`vellis-asset:` は Range
				対応(要件#27)なので2時間の素材を丸ごと先読みさせる理由がない。
			-->
			{#key src}
				<audio
					bind:this={audio}
					{src}
					preload="metadata"
					muted={audioMuted}
					onplay={() => (playing = true)}
					onpause={() => (playing = false)}
					onseeked={() => (position = audio?.currentTime ?? 0)}
					onvolumechange={() => (audioMuted = audio?.muted ?? false)}
					ondurationchange={() => (mediaDuration = audio?.duration)}
					onerror={() => (loadFailed = true)}
				></audio>
			{/key}

			<div class="audio-controls" bind:this={controls}>
				<!--
					シークバーは**全尺のまま据え置き**(要件#47 契約③=案B)。拡大しても
					バーの目盛りは動かず、帯だけが窓を映す ―― 両方が一緒に伸び縮みすると
					「全体のどこを見ているか」を語るものが無くなる。その役目をこの器に
					重ねた窓指標が持つ。
				-->
				<div class="audio-seek-track" bind:clientWidth={seekWidth}>
					<input
						class="audio-seek"
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
							窓指標。`pointer-events: none` でつまみの操作を妨げない。倍率 1 では
							null =出さないので、枠が見えていること自体が「拡大中」の合図になる。
						-->
						<div
							class="seek-window-indicator"
							style="left: {waveformIndicator.left}px; width: {waveformIndicator.width}px"
						></div>
					{/if}
				</div>

				<div class="audio-buttons">
					<button
						type="button"
						class="audio-button"
						title={playing ? '停止(Space)' : '再生(Space)'}
						onclick={togglePlay}
					>
						{playing ? '停止' : '再生'}
					</button>

					<span class="audio-readout">
						<span class="audio-time">{formatMilliTime(barPosition)}</span>
					</span>

					<!--
						波形の時間軸ズーム(契約⑦)。キーボードは割り当てないので、この3つが
						マウスだけで拡大縮小できる唯一の手(帯上の Option+ホイールと並ぶ)。
						表示は記号だけにして、読み上げ用の名前は aria-label が持つ ―― 動画側と
						同じ語にしてあるのは、同じ操作を別の名前で呼ばないため。
					-->
					<span class="audio-zoom-group">
						<button
							type="button"
							class="audio-button audio-zoom"
							title="波形を拡大(×2)"
							aria-label="波形を拡大"
							onclick={() => zoomWaveformBy(2)}
						>
							＋
						</button>
						<button
							type="button"
							class="audio-button audio-zoom"
							title="波形を縮小(÷2)"
							aria-label="波形を縮小"
							onclick={() => zoomWaveformBy(0.5)}
						>
							−
						</button>
						<button
							type="button"
							class="audio-button audio-zoom"
							title="波形を等倍に戻す"
							aria-label="波形を等倍に戻す"
							onclick={resetWaveformZoom}
						>
							等倍
						</button>
					</span>

					<button
						type="button"
						class="audio-button audio-mute"
						title={audioMuted ? '消音を解除' : '消音'}
						aria-pressed={audioMuted}
						onclick={toggleMute}
					>
						{audioMuted ? '消音中' : '消音'}
					</button>
				</div>
			</div>
		{:else}
			<div class="audio-placeholder">
				<p class="audio-message">
					{#if mode === 'remote'}
						リモート(ssh)の音声はアプリ内で再生できません({fileName})。
					{:else}
						この音声を再生できませんでした({fileName})。
					{/if}
				</p>
			</div>
		{/if}
	</div>
</article>

<style>
	.audio-viewer {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow: hidden;
		background-color: var(--color-bg-primary);
	}

	.audio-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
		padding: 6px 12px;
		background-color: var(--color-bg-primary);
		border-bottom: 1px solid var(--color-border);
	}

	.audio-name {
		flex: 1;
		min-width: 0;
		font-size: 12px;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/*
	 * 波形帯と操作部をまとめた操作単位。フォーカスリングはこの枠に出す。
	 * 塊は縦中央へ置く(VideoViewer の `.video-pane` と同じ扱い=要件#43 契約①)。
	 */
	.audio-pane {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		justify-content: center;
		overflow: hidden;
		outline-offset: -2px;
	}

	/* 波形帯の器。中身の高さで立ち、収まらないときだけ縮む。 */
	.audio-stage {
		flex: 0 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
		justify-content: center;
		overflow: hidden;
		padding: 0 12px;
	}

	/*
	 * 帯の上端の掴みしろ(契約⑪)。見た目の線は帯の border が持ち、この要素は
	 * 掴みやすさのための当たり判定。掴んでいる間だけ色が付く。
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

	/*
	 * 波形帯。`color` は canvas の塗り色をテーマから拾うための置き場で、文字には
	 * 使わない(描画側が getComputedStyle で読む)。
	 */
	.audio-waveform {
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
	 * L/R ラベル(契約⑥)。波形の上に小さく重ねるので、地の色を敷いて読めるようにする。
	 * クリックはラベルを素通りして帯へ届く(帯全域でシークできる)。
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

	/* 縮退の理由と解析中の表示。波形の代わりに帯の中央へ出す(契約⑫)。 */
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

	.audio-controls {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 12px 10px;
		border-top: 1px solid var(--color-border);
		background-color: var(--color-bg-primary);
	}

	/* シークバーの器(契約⑦)。窓指標を重ねるための位置基準。 */
	.audio-seek-track {
		position: relative;
		width: 100%;
	}

	/*
	 * 窓指標。バーの上に薄い枠を重ねるだけで、つまみの操作は `pointer-events: none` で
	 * 素通りさせる。目立たせすぎるとバーそのものが読めなくなり、薄すぎると拡大中か
	 * どうかが判らない。
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

	.audio-seek {
		display: block;
		width: 100%;
		margin: 0;
		accent-color: var(--color-text-secondary);
		cursor: pointer;
	}

	.audio-seek:disabled {
		cursor: default;
	}

	.audio-buttons {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.audio-button {
		font-size: 12px;
		padding: 4px 10px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background-color: var(--color-bg-secondary);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.audio-button:hover {
		background-color: var(--color-bg-hover);
	}

	/*
	 * 波形ズームの3ボタン(契約⑦)。ひと組に見えるよう間を詰めて置く ―― 横軸の縮尺で
	 * あって位置ではないので、塊として分かれて見えるほうが押し間違えない。
	 */
	.audio-zoom-group {
		display: flex;
		align-items: center;
		gap: 2px;
		margin-left: 8px;
	}

	.audio-zoom {
		min-width: 32px;
	}

	/* 消音トグルは残りを右へ押しやる位置に置く。 */
	.audio-mute {
		margin-left: auto;
	}

	/*
	 * 時刻表示。等幅の数字で桁を固定する — 再生中に数字の幅が変わると、読み取る前に
	 * 表示が動いて位置が判らなくなる。
	 */
	.audio-readout {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin-left: 8px;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		color: var(--color-text-secondary);
	}

	.audio-placeholder {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		text-align: center;
	}

	.audio-message {
		margin: 0;
		font-size: 13px;
		color: var(--color-text-secondary);
	}
</style>
