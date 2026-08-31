//! `get_video_frame_index` command — frame index of the movie being viewed
//! (requirements.md #37 契約②⑨).
//!
//! The one piece of information the frame-accurate control bar cannot get from
//! the WebView: where every frame starts. `video_frames` knows how to read that
//! out of the container; this command's job is only to put the right bytes in
//! front of it.
//!
//! "The right bytes" is not the file. Movies are routinely gigabytes and the
//! sample table lives in one box, so the read walks the top-level boxes by their
//! headers — sixteen bytes at a time — and pulls in only `moov` when it finds
//! it, whether that is before or after `mdat`. Going through `read_range`
//! (要件#27) rather than `read_bytes` also side-steps the whole-file size cap,
//! which every real video would trip.
//!
//! Nothing here is fatal to playback: a movie whose index cannot be produced
//! answers `null` and the viewer keeps its bar without the frame readouts
//! (契約⑦ fail-open).

use crate::fs::uri::Uri;
use crate::video_frames::{parse_frame_index, VideoFrameIndex};

use super::AppState;

/// Bytes of a box header — enough for the 64-bit `largesize` form.
const BOX_HEADER_LEN: u64 = 16;

/// Largest `moov` box this command will pull into memory (64 MiB).
///
/// A sample table costs eight bytes per run, so an hour of constant-rate video
/// is a few hundred bytes and even a pathological per-frame table stays far
/// under this. The cap is here because the size is read out of the file: a
/// corrupt header must not turn into a multi-gigabyte allocation.
const MAX_MOOV_BYTES: u64 = 64 * 1024 * 1024;

/// Frame index of the first video track, or `null` when the movie has none that
/// can be read (webm, audio-only, a container this parser does not understand).
#[tauri::command]
pub async fn get_video_frame_index(
    uri: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<VideoFrameIndex>, String> {
    let parsed = Uri::parse(&uri).map_err(|e| e.to_string())?;
    let provider = state
        .fs_registry
        .resolve(&parsed)
        .map_err(|e| e.to_string())?;

    // Without a size there is no way to bound the walk, and it is not a regular
    // file anyway.
    let total = match provider.stat(&parsed).await.map_err(|e| e.to_string())?.size {
        Some(total) => total,
        None => return Ok(None),
    };

    let mut pos: u64 = 0;
    while pos < total {
        let header = provider
            .read_range(&parsed, pos, BOX_HEADER_LEN)
            .await
            .map_err(|e| e.to_string())?;

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
                .read_range(&parsed, pos, size)
                .await
                .map_err(|e| e.to_string())?;
            // The box is handed over whole, header included — the parser starts
            // its walk at the top level either way.
            return Ok(parse_frame_index(&moov));
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
