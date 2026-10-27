/**
 * 音声波形タイムラインの判定と計算(requirements.md #41)。
 *
 * 「シークバーの直上に音声の min/max エンベロープ帯と再生ヘッドを表示し、波形を見ながら
 *  カット位置を探せるようにする」のうち、DOM を持たない部分をここに集める
 * (`video-frame.ts` / `video-provenance.ts` と同じ家風)。`VideoViewer.svelte` は帯の
 * 描画と配線だけを持ち、「どの経路で音を取るか」「取ってよいか」「取れなかったとき何と
 * 言うか」「クリックした位置はどの時刻か」はすべてこの純関数群が答える(契約⑦)。
 *
 * 設計の要は3つ。
 *
 * 1. **経路はコンテナで分かれる**(契約③)。mp4/webm は `decodeAudioData` が直接食える
 *    ので動画本体を `fetch` してそのまま渡し、mov(QuickTime)は食えない
 *    (2026-09-01 実機実測)ので Rust 側で音声トラックを無再エンコード抽出した
 *    バイト列を受け取る。**どちらの経路も出口は同じ decode** で、以降の mono 化と
 *    バケット化は共通
 * 2. **縮退の理由は事前判定で決める**(契約⑤)。音声トラックなしと非対応コンテナは
 *    `decodeAudioData` が同一の例外(`EncodingError`)を投げて区別できない(実測)ので、
 *    例外の中身は覗かない ―― 理由は「音声トラックの有無」と「抽出コマンドの応答」から
 *    先に決め、decode の失敗はまとめて `decode-failed` にする(webm だけは失敗したときに
 *    Tracks を読み、音声のトラックが無いと分かれば `no-audio`=要件#41 追補j)
 * 3. **どの段でも throw しない**(契約⑤ fail-open)。波形が出ないことと再生できないことは
 *    別で、帯だけが理由を出して再生は止めない(要件#37 契約⑦と同じ家風)
 *
 * decode(実体は `OfflineAudioContext(mono/8kHz)` の `decodeAudioData`)と mov 抽出
 * (実体は Tauri コマンドの invoke)は**注入引数**で受ける。どちらも WebView と Tauri が
 * 要る操作で、純関数の側に持ち込むとテストが実機なしでは書けなくなる。同じ理由で
 * `AudioBuffer` は Web Audio の型ではなく構造的型(`WaveformAudioBuffer`)で扱う ――
 * 実物もそのまま渡せて、テストはプレーンオブジェクトで足りる(契約⑦)。
 */
import { invoke } from './ipc';
import { toAssetUri } from './uri';
import { nearestFrame, seekTimeForFrame, type FrameIndex } from './video-frame';
// 要件#47 契約⑦。`waveform-zoom.ts` は逆にこちらの `extractPeaks` /
// `WAVEFORM_BUCKETS` を使うので2モジュールは相互参照になるが、**参照はどちらも
// 関数本体の中だけ**(モジュール評価時に相手の束縛を読まない)なので、
// どちらから先に読み込まれても TDZ に当たらない。
import {
	WAVEFORM_COARSE_STEP,
	WAVEFORM_MAX_RETAINED_SAMPLES,
	buildCoarsePeaks,
	windowPeaksFromCoarse,
} from './waveform-zoom';

// ---------------------------------------------------------------------------
// 定数(契約③④)
// ---------------------------------------------------------------------------

/**
 * 解析にかけてよいバイト数の上限(256MiB・要件#45 契約①)。
 *
 * 適用先は経路で異なる ―― extract 経路(mp4/mov)は**抽出後の音声バイト列**だけに当たる
 * (動画本体は Rust 側が範囲読みするだけで、フロントに来るのは音声だけ。1時間の AAC でも
 * 60MB 前後なので実質当たらない)・fetch 経路(webm のみ)は**動画ファイルの全量**に当たる
 * (波形のために動画を丸ごとメモリに載せるので、そこが効く上限)。
 *
 * 要件#41 では mp4 も fetch 経路だったため、13分・高ビットレートの mp4 が動画サイズで
 * `too-large` に落ちていた ―― 要件#45 はそれを「音声バイトだけを見る」に置き換える。
 */
export const WAVEFORM_MAX_SOURCE_BYTES = 256 * 1024 * 1024;

/**
 * fetch 経路(ファイル全量)の上限(512MiB・要件#50 契約⑬(b))。
 *
 * 抽出側と分けてあるのは、当たる対象の大きさが桁で違うから ―― 抽出側に来るのは音声
 * バイトだけだが、fetch 経路はファイルそのものを丸ごとメモリに載せる。2時間の音声を
 * 扱う要求(2026-09-10 由谷)に対し、mp3/m4a 320kbps の2時間=275MiB は旧 256MiB の門に
 * 引っかかっていた。512MiB なら約3時間43分まで届く。この引き上げは fetch 経路全体に
 * 効くので webm も同じ門を受ける(緩む方向のみ=要件#45 契約④のこの一点の明示改訂)。
 */
export const WAVEFORM_MAX_FETCH_BYTES = 512 * 1024 * 1024;

/**
 * エンベロープのバケット本数の既定値(契約②)。
 *
 * 帯の幅はせいぜい 1000px 前後なので、2000 本あれば1本あたり 0.5px 未満 ―― 表示より
 * 細かく刻んでおけば、幅が変わっても取り直さずに描き直せる。
 */
export const WAVEFORM_BUCKETS = 2000;

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/**
 * `AudioBuffer` の構造的型(契約⑦)。
 *
 * Web Audio の `AudioBuffer` と構造的に互換で、実物をそのまま渡せる。jsdom には実体が
 * 無いので、この形で受けることが「判定をテストできる」ことと同義になる。
 */
export type WaveformAudioBuffer = {
	numberOfChannels: number;
	length: number;
	sampleRate: number;
	getChannelData(channel: number): Float32Array;
};

/** バイト列 → 音声(実体は `OfflineAudioContext.decodeAudioData`)。 */
export type WaveformDecode = (bytes: ArrayBuffer) => Promise<WaveformAudioBuffer>;

/**
 * mov の音声抽出の応答(契約③改訂)。
 *
 * Rust コマンドの応答を配線側でこの形へ写す。`no-audio` と `unsupported-codec` が
 * 分かれているのが要点 ―― この2つは decode の例外からは区別できず、**抽出の側でしか
 * 判らない**(契約⑤)。`too-large` は表が上限を超えた音声トラック(要件#41 追補i:
 * 長尺の PCM mov を「音声トラックなし」と言わない)。
 */
export type WaveformExtraction =
	| { state: 'ok'; bytes: ArrayBuffer }
	| { state: 'no-audio' }
	| { state: 'too-large' }
	| { state: 'unsupported-codec' }
	| { state: 'unreadable' };

/** 動画 URI → mov の抽出結果(実体は Tauri コマンドの invoke)。 */
export type WaveformExtract = (videoUri: string) => Promise<WaveformExtraction>;

/**
 * wav の解析応答(要件#50 契約⑯)。
 *
 * `WaveformExtraction` と同型に見えるが、`ok` が運ぶのは**音声バイトではなく解析結果**
 * ―― wav は無圧縮で、2時間の 44.1kHz ステレオは 1.27GB ある。Rust 側で 8kHz の包絡まで
 * 落としたものが raw バイトで届く。縮退の語彙は抽出経路と同じ。
 */
export type WavWaveformAnalysis = WaveformExtraction;

/** wav の URI → 解析結果(実体は Tauri コマンドの invoke)。 */
export type WaveformAnalyzeWav = (uri: string) => Promise<WavWaveformAnalysis>;

/** バケットごとの最小値・最大値(同じ長さ)。 */
export type WaveformPeaks = { mins: Float32Array; maxs: Float32Array };

/** 帯に描く矩形1本(canvas 座標)。 */
export type PeakRect = { x: number; y: number; w: number; h: number };

/**
 * 取得経路の事前判定(契約①③④⑤)。
 *
 * skip の理由は「音声トラックが無い」だけ ―― 実尺上限による `too-long` は要件#45 契約②で
 * 撤廃した(解析中インジケータを出す前提で待ち時間を許容する=2026-09-02 由谷決定)。
 */
export type WaveformPlan =
	| { route: 'fetch' }
	| { route: 'extract' }
	/**
	 * wav 専用の Rust 経路(要件#50 契約⑤⑯)。**サイズにも尺にも依らず常に**ここへ寄せる
	 * ―― サイズで分けると閾値をまたいだ瞬間に波形の細かさが変わる(要件#45 が mp4 を
	 * 抽出経路へ寄せたのと同じ判断)。
	 */
	| { route: 'wav' }
	| { route: 'skip'; reason: 'no-audio' };

/** fetch 経路の取得結果。 */
export type WaveformSource =
	| { state: 'ok'; bytes: ArrayBuffer }
	| { state: 'too-large' }
	| { state: 'unreadable' };

/**
 * 解析の結果。`ready` 以外はすべて縮退で、帯に理由を出して再生は止めない(契約⑤)。
 *
 * `lanes` は上から並べるレーンの列(追補d)。ステレオは `[L, R]` の2本・それ以外は
 * 1本で、構成は `waveformLanes` が決める。
 *
 * 要件#47 契約⑦で3つ増えた ―― `samples`(レーンと 1:1 のデコード済み標本)・
 * `coarse`(レーンごとの粗レベル)・`sampleRate`。窓の再バケット化(拡大表示)は
 * この3つだけを材料にする。`samples` が `null` なのは保持上限を超えた素材で、
 * そのときは粗レベルから描いて上限倍率を下げる(縮退=fail-open)。
 *
 * **省略可にしてある**のは、`{ state: 'ready', lanes }` だけを組み立てる既存の
 * 呼び出し(テストのリテラル)を壊さないため。`analyzeWaveform` の戻り値では常に埋まる。
 */
export type WaveformResult =
	| {
			state: 'ready';
			lanes: WaveformPeaks[];
			samples?: Float32Array[] | null;
			coarse?: WaveformPeaks[];
			sampleRate?: number;
			/**
			 * 解析尺(秒・要件#50 契約④(a))= `decoded.length / decoded.sampleRate`。
			 *
			 * **保持量の縮退(`samples: null`)とは独立に必ず埋まる** ―― `samples` は
			 * レーンの配列であってその `length` はレーン数なので、尺はここでしか判らない。
			 * `<audio>` が尺を言えないとき(NaN / Infinity)の横軸の受け皿になる(契約④(b))。
			 */
			durationSeconds?: number;
	  }
	| { state: 'no-audio' }
	| { state: 'too-large' }
	| { state: 'unreadable' }
	| { state: 'unsupported-codec' }
	| { state: 'decode-failed' };

// ---------------------------------------------------------------------------
// 帯の文言(要件#45 契約③)
// ---------------------------------------------------------------------------

/** 解析中インジケータの文言(要件#45 契約③・文言は実装裁量)。 */
const WAVEFORM_ANALYZING_NOTE = 'Analyzing audio…';

/** 縮退の理由を帯に出す文言(契約⑤)。どの理由でも再生は止まらない。 */
const WAVEFORM_DEGRADED_NOTES: Record<Exclude<WaveformResult['state'], 'ready'>, string> = {
	'no-audio': 'This video has no audio track',
	'too-large': 'The file is too large to build a waveform',
	unreadable: 'Could not read the audio',
	'unsupported-codec': 'Waveforms are not available for this audio codec',
	'decode-failed': 'Could not decode the audio',
};

/**
 * 帯に出す文言(要件#45 契約③)。`null` のときだけ波形そのものを描く。
 *
 * **波形が無いのに文言も無い状態を作らない**のが要点 ―― 解析前(`result` が `null`)も
 * 解析中と同じ扱いにすることで、帯は常に「波形」か「理由」のどちらかになる。無地の帯は
 * 「音が無い」のか「壊れている」のか「まだなのか」を語らず、実機で実際に起きた見え方
 * (2026-09-01 の bind:this 欠落)がまさにこれだった。
 *
 * 要件#45 で mp4 も抽出+decode を通るようになり、長尺では待ち時間が目に見えるので、
 * この「解析中」表示は縮退表示のついでではなく機能そのもの(2026-09-02 由谷指示)。
 * `VideoViewer` の帯はこの関数だけを見る ―― 文言の判定は DOM を要らない純関数に閉じる。
 */
export function waveformBandNote(result: WaveformResult | null, analyzing: boolean): string | null {
	if (result === null || analyzing) {
		// 解析済みの波形を持ったまま次の解析が走っている間は、出来ている波形を描き続ける
		// (帯が点滅しない)。
		if (result?.state === 'ready') return null;
		return WAVEFORM_ANALYZING_NOTE;
	}
	if (result.state === 'ready') return null;
	return WAVEFORM_DEGRADED_NOTES[result.state];
}

// ---------------------------------------------------------------------------
// 経路の事前判定(契約①③④⑤)
// ---------------------------------------------------------------------------

/** URI の末尾セグメント(クエリ・フラグメントは落とす)。 */
function lastSegment(uri: string): string {
	const withoutQuery = uri.split(/[?#]/)[0];
	return withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
}

/**
 * ISO BMFF コンテナ(mov / mp4)か ―― **末尾セグメントの拡張子**だけで見る。
 *
 * `audio_extract.rs` のパーサは QuickTime と MP4 の box 構造を共用で読むので、抽出経路に
 * 乗せられるのはこの2つ(要件#45 契約①④)。webm(Matroska)はパーサの対象外なので
 * 従来どおり fetch 経路に残す。
 *
 * パス途中のドット(`file:///a.mp4/clip.webm`)に引っ張られないよう、判定はファイル名に
 * 限る。パーセントエンコードされた名前はデコードしない ―― 拡張子は ASCII なので、
 * デコードしなくても末尾は読める。
 */
function isIsoBmffUri(videoUri: string): boolean {
	return lastExtension(videoUri) === 'mov' || lastExtension(videoUri) === 'mp4';
}

/** 末尾セグメントの最後の拡張子(小文字・無ければ空文字)。 */
function lastExtension(uri: string): string {
	const name = lastSegment(uri);
	const dot = name.lastIndexOf('.');
	if (dot < 0) return '';
	return name.slice(dot + 1).toLowerCase();
}

/**
 * RIFF/WAVE か ―― ISO BMFF と同じく**末尾セグメントの拡張子**だけで見る(要件#50 契約⑤)。
 *
 * パス途中の `.wav`(`file:///a.wav/clip.mp3`)に引っ張られないのは同じ理由。
 */
function isWavUri(uri: string): boolean {
	return lastExtension(uri) === 'wav';
}

/**
 * どの経路で音を取るか、そもそも取ってよいか(契約①③④⑤)。
 *
 * 判定順が意味を持つ:
 *
 * 1. **音声トラックなしが最優先**。音が無いなら経路の話は始まらない
 * 2. 次にコンテナ。`.mov` / `.mp4` が Rust 抽出経路で、それ以外は fetch へ倒す ――
 *    対象の絞り(mp4/mov/webm・ローカルのインライン再生のみ=契約①)は配線側の仕事で、
 *    ここで未知の拡張子を弾くと「対象なのに拡張子が違う」動画まで巻き添えになる
 *
 * 実尺は**もう見ない**(要件#45 契約②)。`durationSeconds` を引数に残してあるのは
 * シグネチャの互換のためで、長尺は解析中インジケータを出して待たせる。
 */
export function waveformPlan(
	videoUri: string,
	durationSeconds: number | null,
	hasAudioTrack: boolean | null,
): WaveformPlan {
	if (hasAudioTrack === false) return { route: 'skip', reason: 'no-audio' };
	if (isIsoBmffUri(videoUri)) return { route: 'extract' };
	// wav はファイル全量を WebView に載せられない(2時間 1.27GB)ので、fetch より先に
	// 専用経路へ分ける(要件#50 契約⑤⑬(c)=どちらの門も当てない)。
	if (isWavUri(videoUri)) return { route: 'wav' };
	return { route: 'fetch' };
}

// ---------------------------------------------------------------------------
// fetch 経路の取得(契約③④)
// ---------------------------------------------------------------------------

/**
 * 動画本体を取ってくる ―― **fetch 経路唯一の IO**(契約③)。
 *
 * 取りに行くのはサイドカーではなく動画そのもので、経路は要件#40 と同じ asset プロトコル
 * (`open_document` 系は窓の DocumentSession を差し替えてしまうので使わない)。
 *
 * 上限は**二重に**見る(契約④・要件#40 の 8MiB キャップと同型)。`content-length` の
 * 申告で落とせるものは本文を読む前に落とし、申告が無い/嘘のときは実測で落とす ――
 * 上限超のファイルの本文を読み始めてしまったら、上限がある意味が無い。門は fetch 側の
 * `WAVEFORM_MAX_FETCH_BYTES`(要件#50 契約⑬(b) で抽出側と分離)。
 *
 * **throw しない**(契約⑤ fail-open)。404 は「無い」ではなく `unreadable` ―― 再生中の
 * 動画の実体が読めないのは異常事態で、サイドカーの不在(要件#40)とは層が違う。
 */
export async function loadWaveformSource(videoUri: string): Promise<WaveformSource> {
	let response: Response;
	try {
		response = await fetch(toAssetUri(videoUri));
	} catch {
		return { state: 'unreadable' };
	}

	if (!response.ok) return { state: 'unreadable' };

	// ヘッダ無しは `Number(null)` = 0 で素通りし、実測側の判定に委ねる。
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > WAVEFORM_MAX_FETCH_BYTES) {
		return { state: 'too-large' };
	}

	try {
		const bytes = await response.arrayBuffer();
		if (bytes.byteLength > WAVEFORM_MAX_FETCH_BYTES) return { state: 'too-large' };
		return { state: 'ok', bytes };
	} catch {
		return { state: 'unreadable' };
	}
}

// ---------------------------------------------------------------------------
// 波形の材料(契約②③)
// ---------------------------------------------------------------------------

/**
 * 全チャンネルを標本ごとの平均で mono 化する(契約③)。
 *
 * 波形はカット位置を探すための輪郭であって音場ではないので、L/R を別々に描いても
 * 読み取れる情報は増えない。入力(= `AudioBuffer` の内部バッファ)は書き換えない。
 */
export function mixToMono(channels: Float32Array[]): Float32Array {
	if (channels.length === 0) return new Float32Array(0);
	if (channels.length === 1) return channels[0].slice();

	const length = channels[0].length;
	const mono = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		let sum = 0;
		for (const channel of channels) {
			// チャンネル長が揃わない壊れ入力でも NaN を作らない(範囲外は無音扱い)。
			sum += i < channel.length ? channel[i] : 0;
		}
		mono[i] = sum / channels.length;
	}
	return mono;
}

/**
 * min/max バケット化(契約②③)。
 *
 * バケット `i` の範囲は半開区間 `[floor(i×N/n), floor((i+1)×N/n))`。この境界の取り方だと
 * **どの標本もちょうど1つのバケットに属す**ので、全体の min/max がエンベロープに保存される
 * ―― 「1サンプルだけのクリック音」が間引きで消えないことが、カット位置探しでは効く。
 *
 * 非有限の標本(NaN / ±Infinity)は 0 として扱う。壊れたデコード結果を1つ混ぜられただけで
 * 帯全体が潰れる(Infinity が最大値になる)のを避けるための防御で、値の clamp は
 * ここではしない ―― 描画の都合は `peakRects` の側の仕事。
 */
export function extractPeaks(samples: Float32Array, buckets: number): WaveformPeaks {
	const total = samples.length;
	const n = buckets >= 1 ? Math.min(Math.floor(buckets), total) : 0;

	const mins = new Float32Array(n);
	const maxs = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const from = Math.floor((i * total) / n);
		const to = Math.floor(((i + 1) * total) / n);
		let mn = 0;
		let mx = 0;
		for (let j = from; j < to; j++) {
			const v = Number.isFinite(samples[j]) ? samples[j] : 0;
			if (j === from) {
				mn = v;
				mx = v;
			} else {
				if (v < mn) mn = v;
				if (v > mx) mx = v;
			}
		}
		mins[i] = mn;
		maxs[i] = mx;
	}
	return { mins, maxs };
}

/**
 * デコード結果からエンベロープを作る(契約⑦の入口)。
 *
 * `mixToMono` → `extractPeaks` を繋ぐだけ。構造的型で受けるので、実 `AudioBuffer` も
 * テストのプレーンオブジェクトも同じ経路を通る。
 */
export function peaksFromAudioBuffer(
	buffer: WaveformAudioBuffer,
	buckets: number = WAVEFORM_BUCKETS,
): WaveformPeaks {
	const channels: Float32Array[] = [];
	for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
	return extractPeaks(mixToMono(channels), buckets);
}

/**
 * 帯に並べるレーンへの分解(追補d)。
 *
 * ステレオを平均してしまうと、片チャンネルにだけ入っている音(ナレーションが L、
 * 環境音が R といった素材)が埋もれて、カット位置探しで見たいものが消える。そこで
 * **2ch は平均せず L(上)と R(下)を別のレーンにする**。
 *
 * 1ch はそのまま1本。3ch 以上(5.1 等)は v1 では全チャンネル平均の1本へ縮退する
 * ―― レーンを増やすほど1本が薄くなり、56px の帯では形が読めなくなるため。
 * 0ch は描くものが無いので空。入力は書き換えない。
 */
export function waveformLanes(
	buffer: WaveformAudioBuffer,
	buckets: number = WAVEFORM_BUCKETS,
): WaveformPeaks[] {
	const channels = buffer.numberOfChannels;
	if (channels < 1) return [];
	if (channels === 2) {
		return [
			extractPeaks(buffer.getChannelData(0), buckets),
			extractPeaks(buffer.getChannelData(1), buckets),
		];
	}
	if (channels === 1) return [extractPeaks(buffer.getChannelData(0), buckets)];
	return [peaksFromAudioBuffer(buffer, buckets)];
}

/**
 * レーンに対応する標本列(要件#47 契約⑦)。
 *
 * **`waveformLanes` と同じ分け方**をするのが唯一の約束 ―― レーンと標本が 1:1 で
 * 対応していないと、拡大時に「上の段の絵が下の段の音」になる。分岐が2箇所に散る形に
 * なるが、`waveformLanes` は既存の判定(バケット化まで済ませて返す)で、こちらは
 * 生の標本を返す ―― 戻り値の型が違うので統合するとかえって読めなくなる。
 *
 * 2ch までは `AudioBuffer` の内部バッファを**そのまま参照**する(写しを作らない)。
 * 10 分の動画で1レーン 38MB あり、二重に持つ理由がない。呼び出し側は読むだけ。
 */
function laneSamples(buffer: WaveformAudioBuffer): Float32Array[] {
	const channels = buffer.numberOfChannels;
	if (channels < 1) return [];
	if (channels === 2) return [buffer.getChannelData(0), buffer.getChannelData(1)];
	if (channels === 1) return [buffer.getChannelData(0)];

	const all: Float32Array[] = [];
	for (let c = 0; c < channels; c++) all.push(buffer.getChannelData(c));
	return [mixToMono(all)];
}

/**
 * レーンの縦配置(追補d)。帯の総高を**隙間なく等分割**する。
 *
 * 実数のまま等分割する(`y = height×i/n`)ので、レーン数や奇数高でも上端 0・下端が
 * ちょうど総高になり、**帯の総高はレーンが増えても変わらない**(契約②の「シークバー
 * 直上の帯」の高さを保つ)。区切り線を引くかどうかは描画側の裁量で、この分割自体は
 * 線のぶんを差し引かない ―― 引くと総和が総高に届かなくなる。
 */
export function laneBoxes(laneCount: number, height: number): { y: number; h: number }[] {
	const n = Math.floor(laneCount);
	if (n < 1) return [];

	const boxes: { y: number; h: number }[] = [];
	for (let i = 0; i < n; i++) {
		boxes.push({ y: (height * i) / n, h: height / n });
	}
	return boxes;
}

// ---------------------------------------------------------------------------
// 描画幾何と横軸(契約②)
// ---------------------------------------------------------------------------

/** 振幅を [-1, 1] へ収める。`decodeAudioData` の出力は 1 を超え得る(mono 化の後でも)。 */
function clampAmplitude(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(-1, value));
}

/**
 * エンベロープ帯の矩形列(契約②)。
 *
 * 横はバケットの等分割で、`x = width×i/n` と `w = width/n` の組にすると先頭が 0・
 * 末尾の右端がちょうど `width` になる(累積加算だと端が丸め誤差ぶんずれる)。
 * 縦は振幅の線形写像 ―― 中央線が 0 で、上が正。無音は中央線上の高さ 0 の線になる。
 */
export function peakRects(peaks: WaveformPeaks, width: number, height: number): PeakRect[] {
	const n = Math.min(peaks.mins.length, peaks.maxs.length);
	const rects: PeakRect[] = [];
	for (let i = 0; i < n; i++) {
		const max = clampAmplitude(peaks.maxs[i]);
		const min = clampAmplitude(peaks.mins[i]);
		rects.push({
			x: (width * i) / n,
			w: width / n,
			y: ((1 - max) * height) / 2,
			// min > max の壊れ入力(上下が入れ替わった帯)は高さ 0 に潰す。
			h: Math.max(0, ((max - min) * height) / 2),
		});
	}
	return rects;
}

/**
 * 再生位置 → 帯の x(契約②)。
 *
 * 横軸はシークバーと同一(0〜`barDuration` を幅いっぱいに割り付ける)。尺・幅・秒の
 * どれかが壊れていれば 0 ―― 再生ヘッドが NaN の位置へ飛んで描画ごと壊れるより、
 * 左端に居るほうがまだ読める(fail-open)。
 */
export function positionToX(seconds: number, durationSeconds: number, width: number): number {
	if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds)) return 0;
	if (!(width > 0) || !Number.isFinite(width)) return 0;
	if (!Number.isFinite(seconds)) return 0;

	const clamped = Math.min(Math.max(seconds, 0), durationSeconds);
	return (clamped / durationSeconds) * width;
}

/**
 * 帯の x → 時刻(契約②)。`positionToX` の逆で、往復すると元の値へ戻る。
 *
 * クリック位置と再生ヘッドが同じ軸に乗っていることが波形の用途そのもの ―― 見えている
 * 山を押したら、その山の時刻へ跳ぶ。
 */
export function xToSeconds(x: number, width: number, durationSeconds: number): number {
	if (!(width > 0) || !Number.isFinite(width)) return 0;
	if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds)) return 0;
	if (!Number.isFinite(x)) return 0;

	const clamped = Math.min(Math.max(x, 0), width);
	return (clamped / width) * durationSeconds;
}

/**
 * 波形クリックのシーク先(秒・契約⑥)。
 *
 * 時刻へ直したあとは**要件#37 の吸着経路をそのまま通す**(`nearestFrame` →
 * `seekTimeForFrame`)。シークバーを離したときと同じ経路なので、同じ位置を押せば同じ
 * フレームに着く ―― 波形とバーで着地が変わったら、どちらを信じるか判らなくなる。
 * 索引の取れない動画(webm・解析不能)は時刻そのまま(fail-open)。
 */
export function waveformSeekTime(
	x: number,
	width: number,
	durationSeconds: number,
	index: FrameIndex | null,
): number {
	const t = xToSeconds(x, width, durationSeconds);
	if (!index) return t;
	return seekTimeForFrame(index, nearestFrame(index, t));
}

// ---------------------------------------------------------------------------
// 注入される実装(契約③の実体。純関数ではないのでテストは注入側で行う)
// ---------------------------------------------------------------------------

/**
 * 解析に使うサンプリング周波数(Hz)。
 *
 * 波形の見た目に要るのは包絡だけなので、44.1kHz を素で持つ意味がない。8kHz へ落とすと
 * デコード後のメモリが 5.5 分の1(10分の動画で約 38MB)になり、ピーク包絡の相関は
 * 0.988 ―― 表示は正規化前提なので差は見えない(2026-09-01 実測)。
 */
const WAVEFORM_SAMPLE_RATE = 8000;

/**
 * バイト列を音声へ(契約③の decode の実体)。
 *
 * `OfflineAudioContext` を使うのは**再生系に触れないため** ―― `AudioContext` を作ると
 * 出力デバイスを掴む。既存 `<video>` の音声出力経路(`createMediaElementSource` を
 * 使わないこと)にも触れないので、再生の挙動は解析の有無で変わらない(契約③⑧)。
 */
export async function decodeWaveformAudio(bytes: ArrayBuffer): Promise<WaveformAudioBuffer> {
	const context = new OfflineAudioContext(1, 1, WAVEFORM_SAMPLE_RATE);
	return await context.decodeAudioData(bytes);
}

/**
 * raw バイトを返す Rust コマンドの応答を `WaveformExtraction` へ写す(契約③改訂・⑯共通)。
 *
 * 応答は raw バイト(`tauri::ipc::Response`)で、フロントには `ArrayBuffer` として届く
 * ―― 256MiB 級のバイト列を JSON の数値配列にすると実用にならない。縮退の理由は
 * 拒否のメッセージが運び、**知らない理由はすべて `unreadable`** に倒す(fail-open)。
 * 抽出(mov)と解析(wav)で写し方が同じなので、受け取りはここ1箇所に閉じる。
 */
async function invokeWaveformBytes(
	command: string,
	args: Record<string, string>,
): Promise<WaveformExtraction> {
	let raw: ArrayBuffer | ArrayBufferView;
	try {
		raw = await invoke<ArrayBuffer | ArrayBufferView>(command, args);
	} catch (err) {
		const reason = String(err ?? '');
		if (reason.includes('no-audio')) return { state: 'no-audio' };
		if (reason.includes('too-large')) return { state: 'too-large' };
		if (reason.includes('unsupported-codec')) return { state: 'unsupported-codec' };
		return { state: 'unreadable' };
	}

	// 素の `ArrayBuffer` で来るのが Tauri 2 の raw 応答だが、view で包まれて届いても
	// 落とさない(バイト列の受け取り方を1箇所に閉じる)。
	if (raw instanceof ArrayBuffer) return { state: 'ok', bytes: raw };
	if (ArrayBuffer.isView(raw)) {
		const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
		return { state: 'ok', bytes: bytes as ArrayBuffer };
	}
	return { state: 'unreadable' };
}

/** mov の音声抽出(契約③改訂の配線)。 */
export async function extractWaveformAudio(videoUri: string): Promise<WaveformExtraction> {
	return await invokeWaveformBytes('extract_waveform_audio', { uri: videoUri });
}

/** wav の解析(要件#50 契約⑯の配線)。写し方は抽出経路と同じ。 */
export async function analyzeWavWaveform(uri: string): Promise<WavWaveformAnalysis> {
	return await invokeWaveformBytes('analyze_wav_waveform', { uri });
}

/**
 * wav の raw 応答を `WaveformResult` へ読み解く(要件#50 契約⑯(a))。
 *
 * レイアウトは Rust 側(`wav_waveform.rs`)と同一の正本で、全て little-endian:
 * `channels` / `sampleRate` / `frames` / `coarseStep` / `coarseLen` / `hasSamples` の
 * u32 6本 + `durationSeconds` の f64 + (hasSamples なら)レーン順の標本 +
 * レーン順の「mins → maxs」。
 *
 * 要点は2つ。
 *
 * - **粗レベルは再計算しない**。Rust は生標本から直接採っているので包絡が広い側に
 *   あり、間引き後の標本から作り直すとその広さを失う(拡大時に山が痩せる)
 * - **壊れた raw は `unreadable`**(throw しない)。ヘッダの申告と実長が合わない
 *   応答は、そこから先を読んでも意味のある値にならない
 */
function readWavAnalysis(bytes: ArrayBuffer, buckets: number): WaveformResult {
	if (bytes.byteLength < 32) return { state: 'unreadable' };
	const header = new DataView(bytes);
	const channels = header.getUint32(0, true);
	const sampleRate = header.getUint32(4, true);
	const frames = header.getUint32(8, true);
	const coarseLen = header.getUint32(16, true);
	const hasSamples = header.getUint32(20, true) === 1;
	const durationSeconds = header.getFloat64(24, true);

	// レーン数の規則は `waveformLanes` と同じ(ステレオだけ2本)。
	const laneCount = channels === 2 ? 2 : 1;
	const sampleBytes = hasSamples ? laneCount * frames * 4 : 0;
	if (bytes.byteLength !== 32 + sampleBytes + laneCount * coarseLen * 8) {
		return { state: 'unreadable' };
	}

	// 標本は**写さずに view で持つ**(2時間の素材で 230MB あり、二重に持つ理由がない)。
	// Rust が little-endian で書き、対象プラットフォームも little-endian なので、
	// Float32Array を被せるだけでそのまま読める。
	let at = 32;
	const samples: Float32Array[] = [];
	if (hasSamples) {
		for (let lane = 0; lane < laneCount; lane++) {
			samples.push(new Float32Array(bytes, at, frames));
			at += frames * 4;
		}
	}
	const coarse: WaveformPeaks[] = [];
	for (let lane = 0; lane < laneCount; lane++) {
		const mins = new Float32Array(bytes, at, coarseLen);
		at += coarseLen * 4;
		const maxs = new Float32Array(bytes, at, coarseLen);
		at += coarseLen * 4;
		coarse.push({ mins, maxs });
	}

	// 生標本を捨てた素材(長尺)でも帯は描けなければならないので、そのときは
	// 粗レベルから全尺の窓を合成する(要件#47 契約⑦の縮退経路と同じ道具)。
	const windowSeconds = sampleRate > 0 ? (coarseLen * WAVEFORM_COARSE_STEP) / sampleRate : 0;
	const lanes = hasSamples
		? samples.map((lane) => extractPeaks(lane, buckets))
		: coarse.map((lane) => windowPeaksFromCoarse(lane, sampleRate, 0, windowSeconds, buckets));

	return {
		state: 'ready',
		lanes,
		samples: hasSamples ? samples : null,
		coarse,
		sampleRate,
		durationSeconds,
	};
}

// ---------------------------------------------------------------------------
// webm の Tracks の読み取り(要件#41 追補j)
// ---------------------------------------------------------------------------

/** EBML の要素 ID(マーカー付きのまま=ファイルに並ぶ形の数値)。 */
const EBML_ID_HEADER = 0x1a45dfa3;
const EBML_ID_SEGMENT = 0x18538067;
const EBML_ID_TRACKS = 0x1654ae6b;
const EBML_ID_TRACK_ENTRY = 0xae;
const EBML_ID_TRACK_TYPE = 0x83;
const EBML_ID_CLUSTER = 0x1f43b675;

/** Matroska の TrackType の値。 */
const TRACK_TYPE_VIDEO = 1;
const TRACK_TYPE_AUDIO = 2;

/**
 * decode の前に写しておく本文の先頭の長さ(1MiB・要件#41 追補j 契約5・起案時判断 (f))。
 *
 * `decodeAudioData` は仕様上、渡したバイト列を切り離す(detach)ので、decode が失敗した
 * 後に本文を読むと中身が無いことがある。Tracks はふつう先頭の数 KB にあるので、
 * これだけ写しておけば足りる(写しより後ろにあれば分からない=`decode-failed`)。
 */
const WEBM_TRACKS_PROBE_BYTES = 1024 * 1024;

/**
 * 本文の先頭(最大 `WEBM_TRACKS_PROBE_BYTES`)の写し。先頭が EBML の印(`1A 45 DF A3`)で
 * なければ写さずに null(起案時判断 (c)(f))。throw しない(契約⑤ fail-open)。
 */
function ebmlHeadCopy(bytes: ArrayBuffer): ArrayBuffer | null {
	try {
		if (bytes.byteLength < 4) return null;
		const mark = new Uint8Array(bytes, 0, 4);
		if (mark[0] !== 0x1a || mark[1] !== 0x45 || mark[2] !== 0xdf || mark[3] !== 0xa3) return null;
		return bytes.slice(0, Math.min(bytes.byteLength, WEBM_TRACKS_PROBE_BYTES));
	} catch {
		return null;
	}
}

/** webm の TrackEntry を種類ごとに数えた結果。 */
export type WebmTrackKinds = { audio: number; video: number; other: number };

/**
 * 要素の頭(ID とサイズ)。`size` が null なのはサイズ未知(値のビットが全部 1)。
 * `start` は本体の先頭の位置。
 */
type EbmlHeader = { id: number; size: number | null; start: number };

/**
 * `at` から要素の頭を読む。読めない(ID・サイズの VINT の幅が不正・途中で切れた)なら null。
 *
 * ID はマーカーを付けたまま数値にする(幅 1〜4)。サイズは幅 1〜8 で、値のビットが全部 1 の
 * ものは「未知」。8 バイト幅の値は 2^53 を超えて丸まりうるが、そこまで大きい申告は
 * どのみち本文に収まらないので、収まるかどうかの判定は変わらない。
 */
function readEbmlHeader(bytes: Uint8Array, at: number, end: number): EbmlHeader | null {
	if (at >= end) return null;
	const idFirst = bytes[at];
	const idWidth = Math.clz32(idFirst) - 23;
	if (idFirst === 0 || idWidth > 4 || at + idWidth > end) return null;
	let id = 0;
	for (let i = 0; i < idWidth; i++) id = id * 256 + bytes[at + i];

	const sizeAt = at + idWidth;
	if (sizeAt >= end) return null;
	const sizeFirst = bytes[sizeAt];
	if (sizeFirst === 0) return null;
	const sizeWidth = Math.clz32(sizeFirst) - 23;
	if (sizeAt + sizeWidth > end) return null;
	const mask = 0xff >> sizeWidth;
	let size = sizeFirst & mask;
	let unknown = size === mask;
	for (let i = 1; i < sizeWidth; i++) {
		const b = bytes[sizeAt + i];
		size = size * 256 + b;
		if (b !== 0xff) unknown = false;
	}
	return { id, size: unknown ? null : size, start: sizeAt + sizeWidth };
}

/**
 * 本体が `end` までに収まる要素の終わりの位置。サイズ未知・はみ出しは null(壊れている)。
 * 申告サイズは位置の計算にしか使わない(配列を作らない)。
 */
function ebmlElementEnd(header: EbmlHeader, end: number): number | null {
	if (header.size === null) return null;
	const elementEnd = header.start + header.size;
	return elementEnd <= end ? elementEnd : null;
}

/** TrackEntry の中の TrackType の値。持たなければ null・壊れていれば undefined。 */
function readTrackType(bytes: Uint8Array, start: number, end: number): number | null | undefined {
	let at = start;
	while (at < end) {
		const header = readEbmlHeader(bytes, at, end);
		if (!header) return undefined;
		const elementEnd = ebmlElementEnd(header, end);
		if (elementEnd === null) return undefined;
		if (header.id === EBML_ID_TRACK_TYPE) {
			// 符号なし整数(big-endian)。8 バイトを超える整数は EBML に無い。
			if (elementEnd - header.start > 8) return undefined;
			let value = 0;
			for (let i = header.start; i < elementEnd; i++) value = value * 256 + bytes[i];
			return value;
		}
		at = elementEnd;
	}
	return null;
}

/** Tracks の本体の TrackEntry を数える。壊れている・TrackEntry が 0 なら null。 */
function countTrackEntries(bytes: Uint8Array, start: number, end: number): WebmTrackKinds | null {
	const kinds: WebmTrackKinds = { audio: 0, video: 0, other: 0 };
	let at = start;
	while (at < end) {
		const header = readEbmlHeader(bytes, at, end);
		if (!header) return null;
		const elementEnd = ebmlElementEnd(header, end);
		if (elementEnd === null) return null;
		if (header.id === EBML_ID_TRACK_ENTRY) {
			const type = readTrackType(bytes, header.start, elementEnd);
			if (type === undefined) return null;
			// TrackType を持たない TrackEntry は音声と言えないので「その他」に数える
			// (起案時判断 (d)。Matroska では必須で既定値が無い)。
			if (type === TRACK_TYPE_AUDIO) kinds.audio += 1;
			else if (type === TRACK_TYPE_VIDEO) kinds.video += 1;
			else kinds.other += 1;
		}
		at = elementEnd;
	}
	return kinds.audio + kinds.video + kinds.other > 0 ? kinds : null;
}

/** Segment の本体から Tracks を探して数える。Cluster が先に来たら探すのをやめる。 */
function tracksInSegment(bytes: Uint8Array, start: number, end: number): WebmTrackKinds | null {
	let at = start;
	while (at < end) {
		const header = readEbmlHeader(bytes, at, end);
		if (!header) return null;
		// Tracks より前に Cluster が来たら、その先は探さない(起案時判断 (b))。
		// サイズ未知の Cluster は終わりが分からず、読み進めると本文の全量を舐めることになる。
		if (header.id === EBML_ID_CLUSTER) return null;
		const elementEnd = ebmlElementEnd(header, end);
		if (elementEnd === null) return null;
		if (header.id === EBML_ID_TRACKS) return countTrackEntries(bytes, header.start, elementEnd);
		at = elementEnd;
	}
	return null;
}

/**
 * webm(Matroska/EBML)の TrackEntry を種類ごとに数える(要件#41 追補j 契約1・2)。
 *
 * WebKit は音声の無い webm の復号を拒否し、その例外は復号の失敗と区別できないので、
 * decode が失敗したときに素材そのものの申告(Tracks)を読んで音声の有無を確かめる。
 * 読むのは必要な分だけ(EBML ヘッダ → Segment → Tracks → TrackEntry → TrackType)。
 *
 * - EBML でない・Tracks が見つからない・壊れている・TrackEntry が 0 なら null(=分からない)
 * - サイズ未知の Segment は本文の終わりまでを中身として順に読む(MediaRecorder の形)。
 *   申告が本文を超える Segment も手元にある分を読む(先頭だけの写しを渡せるように)
 * - `Uint8Array` は byteOffset 付きの view のまま読む(`bytes.buffer` を素で読まない)
 * - **throw しない**(契約⑤ fail-open)。申告サイズは位置の計算にしか使わず、それを
 *   信じて配列を作らない。detach された `ArrayBuffer`(`decodeAudioData` が手放した後)
 *   のように view を作れない入力も null
 */
export function webmTrackKinds(bytes: ArrayBuffer | Uint8Array): WebmTrackKinds | null {
	try {
		const view = ArrayBuffer.isView(bytes)
			? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
			: new Uint8Array(bytes);
		const end = view.length;

		const ebml = readEbmlHeader(view, 0, end);
		if (!ebml || ebml.id !== EBML_ID_HEADER) return null;
		let at = ebmlElementEnd(ebml, end);
		if (at === null) return null;

		// EBML ヘッダの後の最初の Segment を読む(手前の Void などは飛ばす)。
		while (at < end) {
			const header = readEbmlHeader(view, at, end);
			if (!header) return null;
			if (header.id === EBML_ID_SEGMENT) {
				// Segment の申告が手元の本文を超えるときも、手元にある分を読む ―― 渡されるのは
				// decode の前に写した先頭(最大 `WEBM_TRACKS_PROBE_BYTES`)で、ふつうの webm の
				// Segment はその何倍もある(要件#41 追補j 契約5)。Tracks そのものは収まって
				// いなければ壊れている扱いのまま。
				const segmentEnd = header.size === null ? end : Math.min(header.start + header.size, end);
				return tracksInSegment(view, header.start, segmentEnd);
			}
			const elementEnd = ebmlElementEnd(header, end);
			if (elementEnd === null) return null;
			at = elementEnd;
		}
		return null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// 解析の統合(契約①③④⑤)
// ---------------------------------------------------------------------------

/**
 * 波形を作る ―― 経路選択・取得・decode・バケット化の統合(契約①③④⑤)。
 *
 * **throw しない**。どの段で転んでも状態として返り、帯がその理由を出す。
 *
 * decode の失敗をひとまとめに `decode-failed` へ落とすのは手抜きではなく事実の反映で、
 * 音声トラックなしと非対応コンテナは `decodeAudioData` が同一の `EncodingError` を
 * 投げて区別できない(2026-09-01 実測)。**例外の中身から理由を推定しない** ――
 * 理由は事前判定(`hasAudioTrack` と抽出コマンドの応答)だけが決める(契約⑤)。
 * ただし fetch 経路(webm)で decode が失敗したときだけは、素材の Tracks の申告
 * (`webmTrackKinds`)で音声の有無を確かめ、音声が無いと分かれば `no-audio` にする
 * (要件#41 追補j)。これも例外の中身ではなく素材の中身で決める。
 *
 * 上限も経路で当たる場所が違う(要件#45 契約①)。extract 経路(mp4/mov)は抽出後の音声
 * バイト列に当たる ―― 無圧縮 PCM でも実質届かないが、Rust から渡された長さを信じない
 * ための境界として置く。fetch 経路(webm のみ)は動画ファイルの全量に当たる(現状維持)。
 */
export async function analyzeWaveform(
	videoUri: string,
	input: {
		durationSeconds: number | null;
		hasAudioTrack: boolean | null;
		decode: WaveformDecode;
		extract: WaveformExtract;
		/**
		 * wav の解析(要件#50 契約⑯)。**省略可** ―― 注入が無ければ wav は
		 * `unreadable` へ縮退する(fetch へ倒すと 1.27GB を WebView に載せることになり、
		 * 専用経路へ寄せた意味が消える)。
		 */
		analyzeWav?: WaveformAnalyzeWav;
		buckets?: number;
		/**
		 * 生標本を保持してよい総数(要件#47 契約⑦)。既定は
		 * `WAVEFORM_MAX_RETAINED_SAMPLES`。テストの注入 seam(`buckets` と同型)で、
		 * 実サイズ 256MiB を作らずに縮退の規則だけを判定できるようにしてある。
		 */
		maxRetainedSamples?: number;
	},
): Promise<WaveformResult> {
	const plan = waveformPlan(videoUri, input.durationSeconds, input.hasAudioTrack);
	if (plan.route === 'skip') return { state: plan.reason };
	// wav の受け口(要件#50 契約⑤(ii)⑯)。Rust が 8kHz の包絡まで落として返すので、
	// この経路では fetch も decode も通らない ―― 通せば 1.27GB を WebView に載せる
	// ことになり、専用経路へ寄せた意味が消える(seam 未注入・失敗は fail-open)。
	if (plan.route === 'wav') {
		if (!input.analyzeWav) return { state: 'unreadable' };
		let analysis: WavWaveformAnalysis;
		try {
			analysis = await input.analyzeWav(videoUri);
		} catch {
			return { state: 'unreadable' };
		}
		if (analysis.state !== 'ok') return { state: analysis.state };
		return readWavAnalysis(analysis.bytes, input.buckets ?? WAVEFORM_BUCKETS);
	}

	let bytes: ArrayBuffer;
	if (plan.route === 'extract') {
		let extraction: WaveformExtraction;
		try {
			extraction = await input.extract(videoUri);
		} catch {
			// IPC が落ちた・コマンドが無い。原因は判らないので「読めなかった」に倒す。
			return { state: 'unreadable' };
		}
		if (extraction.state !== 'ok') return { state: extraction.state };
		if (extraction.bytes.byteLength > WAVEFORM_MAX_SOURCE_BYTES) return { state: 'too-large' };
		bytes = extraction.bytes;
	} else {
		const source = await loadWaveformSource(videoUri);
		if (source.state !== 'ok') return { state: source.state };
		bytes = source.bytes;
	}

	// fetch 経路で本文が EBML なら、decode に渡す前に先頭を写しておく(要件#41 追補j 契約5)。
	// decode が本文を切り離しても、失敗したときにこの写しから Tracks を読める。decode には
	// 元の本文をそのまま渡す。
	const ebmlHead = plan.route === 'fetch' ? ebmlHeadCopy(bytes) : null;

	let decoded: WaveformAudioBuffer;
	try {
		decoded = await input.decode(bytes);
	} catch {
		// fetch 経路(webm)は、音声が無いことと復号の失敗が同じ例外になる。失敗したときだけ
		// Tracks を読み、TrackEntry があってどれも音声でないと分かれば「音声なし」
		// (要件#41 追補j 契約1)。`hasAudioTrack` の申告によらず Tracks を優先する(起案時判断 (e))。
		if (ebmlHead) {
			const kinds = webmTrackKinds(ebmlHead);
			if (kinds !== null && kinds.audio === 0) return { state: 'no-audio' };
		}
		return { state: 'decode-failed' };
	}

	// 空のデコード結果(0ch・0サンプル)は音が無いのと同じ ―― 描くものが無い。
	if (!decoded || decoded.numberOfChannels < 1 || decoded.length < 1) {
		return { state: 'no-audio' };
	}
	// 解析尺は**保持量の判定より前**に出す(要件#50 契約④(a))―― 縮退の分岐の中に
	// 置くと、長尺(samples を捨てる素材)でだけ尺が欠ける。
	const durationSeconds = decoded.sampleRate > 0 ? decoded.length / decoded.sampleRate : 0;
	// 拡大表示の材料(要件#47 契約⑦)。粗レベルは**常に**作る ―― 生標本を捨てた
	// 素材でも帯そのものは描けなければならない(縮退で失うのは深い倍率だけ)。
	const samples = laneSamples(decoded);
	const coarse = samples.map(buildCoarsePeaks);
	const retained = samples.reduce((sum, lane) => sum + lane.length, 0);
	const limit = input.maxRetainedSamples ?? WAVEFORM_MAX_RETAINED_SAMPLES;

	return {
		state: 'ready',
		lanes: waveformLanes(decoded, input.buckets ?? WAVEFORM_BUCKETS),
		samples: retained > limit ? null : samples,
		coarse,
		sampleRate: decoded.sampleRate,
		durationSeconds,
	};
}
