//! `extract_waveform_audio` command — the audio of a QuickTime movie, in a
//! wrapper the WebView can decode (requirements.md #41 契約③).
//!
//! Only `.mov` needs this. `decodeAudioData` demuxes MP4 and WebM by itself, so
//! those go straight from `fetch` to the decoder; QuickTime it refuses whatever
//! is inside (measured 2026-09-01), and this command is the way around it:
//! `audio_extract` plans the extraction, this reads the bytes the plan points
//! at, and the re-wrapped audio goes back as **raw bytes**
//! (`tauri::ipc::Response`). Serialising 100 MB of audio as a JSON array of
//! numbers is not a slower version of that — it is unusable.
//!
//! Reading follows `commands::video`: walk the top-level boxes by their headers
//! and pull in only `moov`, then read the sample ranges — not the file. Audio is
//! a small fraction of a movie, and the samples of one track sit contiguously
//! inside each chunk, so the reads are one per chunk rather than one per sample.
//!
//! The degradations are the vocabulary the waveform band speaks (契約⑤): a
//! rejection carrying `no-audio` or `unsupported-codec` is a *fact about the
//! movie* that the frontend prints, and anything else is `unreadable`. Those two
//! cannot be recovered from a decode failure — an audio-less movie and an
//! undecodable one throw the same `EncodingError` — which is exactly why they
//! are decided here, before the bytes ever reach the decoder.

use crate::audio_extract::{
    normalize_sound_description, parse_audio_extraction, pcm16_be_to_le, remux_m4a, with_edit_list,
    wrap_wav, wrap_wav_float32, AudioCodec, SampleRange,
};
use crate::fs::provider::FileProvider;
use crate::fs::uri::Uri;

use super::AppState;

/// Bytes of a box header — enough for the 64-bit `largesize` form.
const BOX_HEADER_LEN: u64 = 16;

/// Largest `moov` box this command will pull into memory (64 MiB), same bound
/// and same reason as `commands::video`: the size comes out of the file, so a
/// corrupt header must not turn into a multi-gigabyte allocation.
const MAX_MOOV_BYTES: u64 = 64 * 1024 * 1024;

/// Largest audio payload this command will assemble (256 MiB), mirroring
/// `WAVEFORM_MAX_SOURCE_BYTES` in `src/lib/audio-waveform.ts` (契約④).
///
/// The frontend checks the same ceiling on what it receives; this one exists so
/// that a movie claiming an absurd audio track is refused before the bytes are
/// read rather than after.
const MAX_AUDIO_BYTES: u64 = 256 * 1024 * 1024;

/// Largest number of separate reads one extraction may issue.
///
/// Samples are read per contiguous run — normally one run per chunk, so a few
/// hundred to a few thousand for a real movie. A file that interleaves every
/// single sample would turn into one read per sample, and at that point the
/// extraction is not worth the seeks.
const MAX_READ_RUNS: usize = 200_000;

/// Rejection reasons the frontend maps onto `WaveformExtraction` (契約⑤).
/// Anything else it sees becomes `unreadable`.
const NO_AUDIO: &str = "no-audio";
const UNSUPPORTED_CODEC: &str = "unsupported-codec";
const UNREADABLE: &str = "unreadable";

/// The first audio track of `uri`, re-wrapped for `decodeAudioData`.
///
/// AAC and ALAC come back as a minimal `m4a` carrying the original sample table
/// (so the decoded audio lines up with the movie sample for sample); PCM comes
/// back as a WAV. The response is raw bytes — the frontend receives an
/// `ArrayBuffer` and hands it to the decoder unchanged.
#[tauri::command]
pub async fn extract_waveform_audio(
    uri: String,
    state: tauri::State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let parsed = Uri::parse(&uri).map_err(|_| UNREADABLE.to_string())?;
    let provider = state
        .fs_registry
        .resolve(&parsed)
        .map_err(|_| UNREADABLE.to_string())?;

    let moov = read_moov(provider.as_ref(), &parsed)
        .await?
        .ok_or_else(|| UNREADABLE.to_string())?;
    // No plan means no audio track, or a sample table too broken to point at
    // one. The two cannot be told apart from here, and "no audio" is the far
    // more common of them — the band says so rather than inventing a fault.
    let plan = parse_audio_extraction(&moov).ok_or_else(|| NO_AUDIO.to_string())?;

    if plan.codec == AudioCodec::Unsupported {
        return Err(UNSUPPORTED_CODEC.to_string());
    }

    let audio = read_samples(provider.as_ref(), &parsed, &plan.ranges).await?;
    let bytes = match plan.codec {
        AudioCodec::Aac | AudioCodec::Alac => {
            let sizes: Vec<usize> = plan.ranges.iter().map(|r| r.size as usize).collect();
            let samples = slice_samples(&audio, &sizes).ok_or_else(|| UNREADABLE.to_string())?;
            // QuickTime spells the sample description differently to MP4, and
            // AudioToolbox will not open an `M4A ` file that uses QuickTime's
            // spelling — so the description is restated before it is embedded
            // (measured 2026-09-01; see `normalize_sound_description`). A movie
            // whose description cannot be restated still gets its original one:
            // ffmpeg-made files are readable either way.
            let stsd = normalize_sound_description(&plan.stsd).unwrap_or_else(|| plan.stsd.clone());
            let m4a = remux_m4a(&stsd, &samples, plan.timescale, &plan.stts)
                .ok_or_else(|| UNREADABLE.to_string())?;
            // Put the encoder priming back behind an edit list, so the waveform
            // sits where the sound does. Failing that, the file still plays a
            // few tens of milliseconds early — better than no waveform.
            if plan.edit_start > 0 {
                with_edit_list(&m4a, plan.edit_start).unwrap_or(m4a)
            } else {
                m4a
            }
        }
        AudioCodec::Pcm {
            sample_rate,
            channels,
            bits_per_sample,
            big_endian,
            float,
        } => {
            if float {
                // Classification only admits little-endian float32, so the
                // samples are already in WAV's byte order.
                wrap_wav_float32(&audio, channels, sample_rate)
            } else {
                let pcm = if big_endian {
                    to_little_endian(&audio, bits_per_sample)
                        .ok_or_else(|| UNREADABLE.to_string())?
                } else {
                    audio
                };
                wrap_wav(&pcm, channels, sample_rate, bits_per_sample)
            }
        }
        AudioCodec::Unsupported => return Err(UNSUPPORTED_CODEC.to_string()),
    };

    Ok(tauri::ipc::Response::new(bytes))
}

/// The `moov` box of the movie, or `None` when the file has none that can be
/// located.
async fn read_moov(
    provider: &dyn FileProvider,
    uri: &Uri,
) -> Result<Option<Vec<u8>>, String> {
    let total = match provider
        .stat(uri)
        .await
        .map_err(|_| UNREADABLE.to_string())?
        .size
    {
        Some(total) => total,
        // Without a size there is no way to bound the walk, and it is not a
        // regular file anyway.
        None => return Ok(None),
    };

    let mut pos: u64 = 0;
    while pos < total {
        let header = provider
            .read_range(uri, pos, BOX_HEADER_LEN)
            .await
            .map_err(|_| UNREADABLE.to_string())?;

        let (kind, size) = match top_level_box(&header, total - pos) {
            Some(found) => found,
            // A header that does not make sense ends the walk: whatever comes
            // after it cannot be located.
            None => return Ok(None),
        };

        if &kind == b"moov" {
            if size > MAX_MOOV_BYTES {
                return Ok(None);
            }
            let moov = provider
                .read_range(uri, pos, size)
                .await
                .map_err(|_| UNREADABLE.to_string())?;
            // Handed over whole, header included — the parser starts its walk at
            // the top level either way.
            return Ok(Some(moov));
        }

        // `size` is at least the header length, so the walk always advances.
        pos += size;
    }

    Ok(None)
}

/// Type and total size of the box whose header is at the start of `header`.
///
/// `remaining` is how much file is left from that box onwards, and is both the
/// meaning of a declared size of zero ("to the end") and the bound every other
/// size is checked against.
fn top_level_box(header: &[u8], remaining: u64) -> Option<([u8; 4], u64)> {
    let size32 = u32::from_be_bytes(header.get(0..4)?.try_into().ok()?);
    let kind: [u8; 4] = header.get(4..8)?.try_into().ok()?;

    let (header_len, size) = match size32 {
        1 => (16, u64::from_be_bytes(header.get(8..16)?.try_into().ok()?)),
        0 => (8, remaining),
        n => (8, u64::from(n)),
    };

    if size < header_len || size > remaining {
        return None;
    }
    Some((kind, size))
}

/// The sample bytes of the track, concatenated in sample order.
///
/// Consecutive samples inside a chunk are contiguous in the file, so the ranges
/// are merged into runs and each run is read once — an hour of AAC is a few
/// thousand reads rather than a few hundred thousand.
async fn read_samples(
    provider: &dyn FileProvider,
    uri: &Uri,
    ranges: &[SampleRange],
) -> Result<Vec<u8>, String> {
    let total: u64 = ranges.iter().map(|r| u64::from(r.size)).sum();
    if total == 0 || total > MAX_AUDIO_BYTES {
        return Err(UNREADABLE.to_string());
    }

    let runs = contiguous_runs(ranges);
    if runs.len() > MAX_READ_RUNS {
        return Err(UNREADABLE.to_string());
    }

    let mut audio = Vec::with_capacity(total as usize);
    for (offset, len) in runs {
        let chunk = provider
            .read_range(uri, offset, len)
            .await
            .map_err(|_| UNREADABLE.to_string())?;
        // A short read means the table points past the end of the file: the
        // movie is not laid out the way it says it is, and the samples after
        // this point would be silently misaligned.
        if chunk.len() as u64 != len {
            return Err(UNREADABLE.to_string());
        }
        audio.extend_from_slice(&chunk);
    }
    Ok(audio)
}

/// Merge ranges that touch into `(offset, len)` reads.
fn contiguous_runs(ranges: &[SampleRange]) -> Vec<(u64, u64)> {
    let mut runs: Vec<(u64, u64)> = Vec::new();
    for range in ranges {
        let size = u64::from(range.size);
        match runs.last_mut() {
            Some((offset, len)) if *offset + *len == range.offset => *len += size,
            _ => runs.push((range.offset, size)),
        }
    }
    runs
}

/// Cut the concatenated audio back into per-sample slices for the re-wrap.
fn slice_samples<'a>(audio: &'a [u8], sizes: &[usize]) -> Option<Vec<&'a [u8]>> {
    let mut samples = Vec::with_capacity(sizes.len());
    let mut at = 0usize;
    for size in sizes {
        let end = at.checked_add(*size)?;
        samples.push(audio.get(at..end)?);
        at = end;
    }
    Some(samples)
}

/// Big-endian integer PCM into WAV's little-endian order.
///
/// 16-bit is the common case (`twos`); 24-bit only turns up in `lpcm` tracks
/// that declare the big-endian flag. Anything else was refused at
/// classification.
fn to_little_endian(pcm: &[u8], bits_per_sample: u16) -> Option<Vec<u8>> {
    match bits_per_sample {
        16 => pcm16_be_to_le(pcm),
        24 => {
            if pcm.len() % 3 != 0 {
                return None;
            }
            let mut out = Vec::with_capacity(pcm.len());
            for sample in pcm.chunks_exact(3) {
                out.push(sample[2]);
                out.push(sample[1]);
                out.push(sample[0]);
            }
            Some(out)
        }
        _ => None,
    }
}
