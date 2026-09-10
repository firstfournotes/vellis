//! `analyze_wav_waveform` command — the 8kHz envelope of a wav file
//! (requirements.md #50 契約⑯).
//!
//! `extract_waveform_audio`(mov)と違って**バイト列は返さない** ―― wav は無圧縮で、
//! 2時間の 44.1kHz ステレオは 1.27GB ある。丸ごと WebView に渡す道が無いので、
//! ここで 8kHz の包絡まで落としてから `tauri::ipc::Response` に載せる(応答の
//! レイアウトは `wav_waveform` のモジュール doc と acceptance_req50.rs が正本)。
//!
//! 読み方も違う。`fmt `/`data` の位置決めはチャンクヘッダを 8 バイトずつ辿るだけ・
//! `data` は数 MiB ずつ読んで解析器へ流す ―― ファイルの大きさに関わらず、常駐する
//! のは応答そのものだけになる。
//!
//! ssh は対象外(要件#19 の前例どおり再生自体がプレースホルダ)。root 照合をここで
//! 行わないのは追補d(2) の判断で、既存の `vellis-asset:` 経路と同じ扱いにする。

use crate::fs::provider::FileProvider;
use crate::fs::uri::Uri;
use crate::wav_waveform::{
    check_riff_magic, chunk_advance, chunk_header, parse_fmt, usable_frames, WavDecimator,
    WavFormat, NO_AUDIO, UNREADABLE, WAV_WAVEFORM_MAX_RETAINED_SAMPLES,
};

use super::AppState;

/// `data` を読む塊の大きさ(4 MiB)。解析器は塊の切れ目に依存しないので、これは
/// 「一度に常駐するバイト数」を決めるだけの値。
const READ_CHUNK_LEN: u64 = 4 * 1024 * 1024;

/// `fmt ` として読み込む上限。宣言サイズはファイル由来なので、壊れた値がそのまま
/// 巨大な確保にならないよう頭を押さえる(EXTENSIBLE でも 40 バイト)。
const MAX_FMT_BYTES: u64 = 4096;

/// チャンク走査の打ち切り。まともな wav の最上位チャンクは数個で、これを超えるのは
/// ヘッダが壊れて前進が止まらない形だけ。
const MAX_CHUNKS: usize = 4096;

/// wav の 8kHz 包絡(レーンごとの標本と粗レベル)。
#[tauri::command]
pub async fn analyze_wav_waveform(
    uri: String,
    state: tauri::State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let parsed = Uri::parse(&uri).map_err(|_| UNREADABLE.to_string())?;
    if parsed.scheme != "file" {
        return Err(UNREADABLE.to_string());
    }
    let provider = state
        .fs_registry
        .resolve(&parsed)
        .map_err(|_| UNREADABLE.to_string())?;
    let provider = provider.as_ref();

    let total = provider
        .stat(&parsed)
        .await
        .map_err(|_| UNREADABLE.to_string())?
        .size
        .ok_or_else(|| NO_AUDIO.to_string())?;

    let head = read_exact_at(provider, &parsed, 0, 12).await?;
    check_riff_magic(&head)?;

    let (format, data_start, declared) = locate(provider, &parsed, total).await?;
    let frames = usable_frames(&format, declared, total.saturating_sub(data_start));
    if frames == 0 {
        return Err(NO_AUDIO.to_string());
    }

    let mut decimator = WavDecimator::new(format, frames, WAV_WAVEFORM_MAX_RETAINED_SAMPLES)?;
    let mut remaining = frames * format.bytes_per_frame() as u64;
    let mut at = data_start;
    while remaining > 0 {
        let want = remaining.min(READ_CHUNK_LEN);
        let chunk = provider
            .read_range(&parsed, at, want)
            .await
            .map_err(|_| UNREADABLE.to_string())?;
        // 短い読みは実体がそこで尽きたということ ―― 読めたぶんまでで打ち切る
        // (切り詰めファイルの fail-open と同じ扱い)。
        if chunk.is_empty() {
            break;
        }
        let read = chunk.len() as u64;
        decimator.push(&chunk);
        at += read;
        remaining -= read.min(remaining);
    }

    Ok(tauri::ipc::Response::new(decimator.finish()))
}

/// `fmt ` と `data` をチャンクヘッダだけ辿って見つける。
async fn locate(
    provider: &dyn FileProvider,
    uri: &Uri,
    total: u64,
) -> Result<(WavFormat, u64, u64), String> {
    let mut at = 12u64;
    let mut format: Option<WavFormat> = None;
    let mut data: Option<(u64, u64)> = None;

    for _ in 0..MAX_CHUNKS {
        if at + 8 > total {
            break;
        }
        let header = read_exact_at(provider, uri, at, 8).await?;
        let (id, size) = match chunk_header(&header) {
            Some(header) => header,
            None => break,
        };
        let payload_start = at + 8;
        if &id == b"fmt " && format.is_none() {
            let payload = provider
                .read_range(uri, payload_start, size.min(MAX_FMT_BYTES))
                .await
                .map_err(|_| UNREADABLE.to_string())?;
            format = Some(parse_fmt(&payload)?);
        } else if &id == b"data" && data.is_none() {
            data = Some((payload_start, size));
        }
        if format.is_some() && data.is_some() {
            break;
        }
        at = match at.checked_add(chunk_advance(size)) {
            Some(next) => next,
            None => break,
        };
    }

    match (format, data) {
        (Some(format), Some((start, size))) => Ok((format, start, size)),
        _ => Err(NO_AUDIO.to_string()),
    }
}

/// `len` バイトきっちり読む(足りなければ構造が読めない=no-audio)。
async fn read_exact_at(
    provider: &dyn FileProvider,
    uri: &Uri,
    at: u64,
    len: u64,
) -> Result<Vec<u8>, String> {
    let bytes = provider
        .read_range(uri, at, len)
        .await
        .map_err(|_| UNREADABLE.to_string())?;
    if (bytes.len() as u64) < len {
        return Err(NO_AUDIO.to_string());
    }
    Ok(bytes)
}
