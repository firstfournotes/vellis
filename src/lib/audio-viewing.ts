/**
 * 音声表示の判定(requirements.md #50)。
 *
 * 「音声ファイル(wav / mp3 / m4a)をアプリ内で再生でき、プレーヤー画面に音声の波形を
 *  表示する」のうち、DOM を持たない部分をここに集める。`AudioViewer.svelte` は表示だけを
 * 持ち、「再生できるのか・プレースホルダなのか」「`<audio>` に何を載せるか」
 * 「横軸にどの尺を使うか」はこの純関数群が答える(`video-viewing.ts` と同じ家風)。
 *
 * 契約(2026-09-10 由谷承認。検討記録 docs/audio-playback.md):
 * - 再生は `<audio src="vellis-asset:…">` の1経路のみ。デコードは WebKit に任せる
 * - 対象拡張子(wav / mp3 / m4a)はすべて再生できる前提なので、`videoViewMode` の
 *   `unsupported-container` にあたる枝を持たない=2値(契約②)
 * - ssh リモートは再生対象外。判別は URI スキームのみで、パスの中身では分岐しない
 */
import { toAssetUri } from './uri';
import type { WaveformResult } from './audio-waveform';
import { clampWaveformHeight } from './waveform-resize';

/**
 * 表示形態。`inline` = アプリ内で再生・`remote` = ssh のプレースホルダ(導線なし。
 * 要件#19 で ssh の「既定アプリで開く」が disabled なのと同じ理由)。
 */
export type AudioViewMode = 'inline' | 'remote';

/** ssh リモートか(判別は URI スキームのみ=契約②)。 */
function isRemote(uri: string): boolean {
	return /^ssh:/i.test(uri);
}

/**
 * この音声をどう見せるか。呼ぶのは `detectFileType` が `audio` と答えた URI だけ
 * (= `DisplayResult.audioSrc` が付いている文書)。
 */
export function audioViewMode(uri: string): AudioViewMode {
	return isRemote(uri) ? 'remote' : 'inline';
}

/**
 * `<audio src>` に載せる `vellis-asset:` URI。
 *
 * 変換そのものは画像・動画と同じ `toAssetUri`。要件#27 でこのプロトコルが Range/206 に
 * 対応したので、長尺でも全量を読み込まずに再生が始まる。
 */
export function toAudioSrc(absoluteUri: string): string {
	return toAssetUri(absoluteUri);
}

/**
 * 横軸(シークバーと波形帯)に使う尺(秒)を決める(契約④(b))。
 *
 * `<audio>` の申告が有限かつ 0 超ならそれを採る —— VBR で不正確でも要素側を優先する。
 * `currentTime` はその要素のタイムラインの上にあり、シークバーと波形が同じ(たとえ
 * 不正確な)軸に乗っていることのほうが、クリックした山と着地がずれないという意味で
 * 重要だから。解析尺は要素が尺を言えないとき(ストリーミング中の Infinity・
 * メタデータ未着の NaN)の受け皿で、どちらも無ければ 0(=バーは無効)。
 */
export function audioAxisDuration(
	mediaDuration: number | undefined,
	analyzedDuration: number | null | undefined,
): number {
	if (mediaDuration !== undefined && Number.isFinite(mediaDuration) && mediaDuration > 0) {
		return mediaDuration;
	}
	if (
		analyzedDuration !== null &&
		analyzedDuration !== undefined &&
		Number.isFinite(analyzedDuration) &&
		analyzedDuration > 0
	) {
		return analyzedDuration;
	}
	return 0;
}

/**
 * 要素の申告尺と解析尺が食い違っているか(契約④(b) の記録判定)。
 *
 * 記録するだけで**軸は動かさない**(`audioAxisDuration` は要素側を優先したまま)――
 * 表示の軸を後から差し替えると、再生ヘッドとシークバーが別の尺に乗る瞬間ができる。
 * ここが答えるのは「開発者が知るべき食い違いか」だけ。
 *
 * 閾値は「大きい側の 1%」**または**「1 秒」を**超える**とき(ちょうどは食い違いに
 * しない)。長尺では 1 秒の絶対差が効き(2時間で 1% は 72 秒=VBR のずれを見逃す)、
 * 短尺では相対差が効く。比べる材料が片方でも欠ければ false(fail-open)。
 */
export function durationMismatch(
	mediaDuration: number | undefined,
	analyzedDuration: number | null | undefined,
): boolean {
	if (mediaDuration === undefined || !Number.isFinite(mediaDuration) || mediaDuration <= 0) {
		return false;
	}
	if (
		analyzedDuration === null ||
		analyzedDuration === undefined ||
		!Number.isFinite(analyzedDuration) ||
		analyzedDuration <= 0
	) {
		return false;
	}
	const diff = Math.abs(mediaDuration - analyzedDuration);
	const larger = Math.max(mediaDuration, analyzedDuration);
	return diff > larger / 100 || diff > 1;
}

// ---------------------------------------------------------------------------
// 帯の高さ(契約⑪)
// ---------------------------------------------------------------------------

/**
 * 音声ビューアの波形帯の既定高(px・契約⑪)。
 *
 * 動画の 84px より高いのは、音声ビューアには映像領域が無く、帯が主役だから ――
 * ペインの縦をそのぶん帯に回せる。上下限の規則(最小 40・ウインドウ高の 40%)は
 * 動画と同じ `clampWaveformHeight` を流用する。
 */
export const DEFAULT_AUDIO_WAVEFORM_HEIGHT = 240;

/**
 * 保存キー(契約⑪)。**動画の `vellis.waveform-height` とは別**にする ―― 映像の下の
 * 細い帯の好みと、帯が主役の音声ビューアの好みは別物で、片方を変えたらもう片方も
 * 変わるのは意図しない。
 */
export const AUDIO_WAVEFORM_HEIGHT_STORAGE_KEY = 'vellis.audio-waveform-height';

/** localStorage への参照(ストレージ不可の環境でも落とさない=waveform-resize と同じ保険)。 */
function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** 音声側の保存済み高さを、現在のウインドウ高基準で clamp して返す(契約⑪)。 */
export function loadAudioWaveformHeight(windowHeight: number): number {
	let raw: string | null = null;
	try {
		raw = storage()?.getItem(AUDIO_WAVEFORM_HEIGHT_STORAGE_KEY) ?? null;
	} catch {
		raw = null;
	}
	// Number('') === 0 なので、空(空白のみ含む)は数値化する前に弾く。
	const parsed = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
	const height = Number.isFinite(parsed) ? parsed : DEFAULT_AUDIO_WAVEFORM_HEIGHT;
	return clampWaveformHeight(height, windowHeight);
}

/** 音声側の高さを保存する(契約⑪)。非有限値は書かない=保存領域を壊さない。 */
export function saveAudioWaveformHeight(height: number): void {
	if (!Number.isFinite(height)) return;
	try {
		storage()?.setItem(AUDIO_WAVEFORM_HEIGHT_STORAGE_KEY, String(height));
	} catch {
		// 保存に失敗しても表示中の高さは有効(次回が既定に戻るだけ)。
	}
}

// ---------------------------------------------------------------------------
// 帯の文言(契約⑫)
// ---------------------------------------------------------------------------

/** 解析中インジケータの文言(契約⑫。動画側と同じ役割で、語は音声ビューア用)。 */
const AUDIO_WAVEFORM_ANALYZING_NOTE = '音声を解析中…';

/**
 * 音声ビューア用の縮退文言(契約⑫)。
 *
 * 動画側の表(`audio-waveform.ts` の `WAVEFORM_DEGRADED_NOTES`)をそのまま使うと
 * 「この動画に音声トラックはありません」が音声ファイルに対して出る ―― 音声ファイルを
 * 開いている人にとってそれは端的に嘘なので、語だけを言い換えた表を別に持つ。
 *
 * `Record<Exclude<WaveformResult['state'], 'ready'>, string>` の型は動画側と同じに保つ
 * ―― 状態が増えたときに「文言を足し忘れた」を型が咎める側であり続ける。
 */
const AUDIO_WAVEFORM_DEGRADED_NOTES: Record<Exclude<WaveformResult['state'], 'ready'>, string> = {
	'no-audio': 'このファイルから音声を読み取れませんでした',
	'too-large': 'ファイルが大きすぎて波形を作れません',
	unreadable: 'この音声を読み取れませんでした',
	'unsupported-codec': 'この音声コーデックの波形は出せません',
	'decode-failed': 'この音声をデコードできませんでした',
};

/**
 * 帯に出す文言(契約⑫)。`null` のときだけ波形そのものを描く。
 *
 * 出し分けの規則は動画側の `waveformBandNote` と同じ ―― 解析前も解析中と同じ扱いに
 * することで、帯は常に「波形」か「理由」のどちらかになる(無地の帯を作らない)。
 * 既に波形を持ったまま次の解析が走っている間は、出来ている波形を描き続ける。
 */
export function audioWaveformNote(result: WaveformResult | null, analyzing: boolean): string | null {
	if (result === null || analyzing) {
		if (result?.state === 'ready') return null;
		return AUDIO_WAVEFORM_ANALYZING_NOTE;
	}
	if (result.state === 'ready') return null;
	return AUDIO_WAVEFORM_DEGRADED_NOTES[result.state];
}
