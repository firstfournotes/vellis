//! Frame index of an MP4 / QuickTime movie (requirements.md #37 契約②).
//!
//! A frame-accurate viewer needs to know where every frame *starts*, not what
//! the nominal frame rate is: `fps × time` rounding drifts, and a variable-rate
//! movie has no single rate to multiply by. So this module reads the sample
//! table out of the container and hands the frontend the exact presentation
//! times, which it looks positions up in (`src/lib/video-frame.ts`).
//!
//! It is a deliberately small parser rather than a dependency (契約⑨: no new
//! crates). Only the boxes on the way to `stts` are understood — `moov` →
//! `trak` → `mdia` → (`mdhd`, `hdlr`, `minf` → `stbl` → `stts`) — and every
//! other box, known or not, is skipped by its declared size. That is what makes
//! it survive QuickTime dialects: an unexpected sibling is just another box to
//! step over, and the order of siblings never matters.
//!
//! Nothing here can fail loudly. Every malformed input answers `None`, and the
//! viewer degrades to a bar without frame numbers (契約⑦ fail-open) — a movie
//! that cannot be indexed must still play.

use serde::Serialize;

/// Upper bound on the number of frames one index may describe (~27 hours at
/// 60 fps).
///
/// `stts` run-lengths are `u32`, so a corrupt or hostile table can claim four
/// billion samples; the index materialises one `u64` per frame and then crosses
/// IPC as JSON, so an absurd table is refused rather than allocated for.
const MAX_SAMPLES: u64 = 6_000_000;

/// How far a sample duration may sit from the nominal one and still count as
/// constant rate, in permille (0.5 %).
///
/// The tolerance exists because encoders routinely give the last sample a
/// slightly different duration to land the total on a round number; treating
/// those movies as variable rate would drop the SMPTE readout (契約①) from
/// ordinary CFR material. The allowance is deliberately narrow — the fixtures
/// that must read as VFR vary by whole multiples.
const CFR_TOLERANCE_PERMILLE: u64 = 5;

/// The first video track's frame index, as the frontend receives it
/// (`VideoFrameIndexPayload` in `src/lib/video-frame.ts`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrameIndex {
    /// `mdhd` timescale — ticks per second for every other field here.
    pub timescale: u32,
    /// Presentation start of each frame in ticks, ascending. The position in
    /// this vector *is* the frame number (0-based, matching ffmpeg's `n`).
    pub sample_times: Vec<u64>,
    /// Presentation end of the last frame in ticks (the sum of all sample
    /// durations). The `mdhd` duration field is not used: it describes the
    /// media, which may include edits, and this has to agree with
    /// `sample_times` for the half-frame seek to land inside the last frame.
    pub duration: u64,
    /// Nominal frame rate as a fraction. Exact for constant-rate movies
    /// (`timescale / sample duration`); a representative value otherwise.
    pub fps_num: u32,
    /// Never zero — the frontend divides by it to derive the SMPTE frame base.
    pub fps_den: u32,
    /// Whether the sample durations are constant. Gates the SMPTE readout,
    /// which is undefined for variable-rate material (契約①).
    pub is_cfr: bool,
}

/// Index the first video track of a movie, or `None` if there is nothing to
/// index.
///
/// `bytes` may be the whole file or just the `moov` box — the walk starts at
/// the top level either way, and the command only ever reads the box it needs
/// (`commands::video`).
pub fn parse_frame_index(bytes: &[u8]) -> Option<VideoFrameIndex> {
    let mut pos = 0;
    while let Some((kind, payload)) = next_box(bytes, &mut pos) {
        if kind == b"moov" {
            // Return on the first `moov`: whatever follows it — padding,
            // garbage, a truncated tail — cannot take the index away again.
            return parse_moov(payload);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Box walking
// ---------------------------------------------------------------------------

/// Read the box at `pos`, yielding its four-character type and its payload,
/// and advance `pos` past it.
///
/// `None` means "stop reading here", and covers both the honest end of the
/// data and a header that cannot be trusted: a size that does not cover its own
/// header, or a box that claims to run past the end of the buffer. Callers make
/// no distinction — whatever was parsed before this point stands.
fn next_box<'a>(data: &'a [u8], pos: &mut usize) -> Option<(&'a [u8], &'a [u8])> {
    let start = *pos;
    let size32 = read_u32(data, start)?;
    let kind = data.get(start + 4..start + 8)?;

    let (header_len, total) = match size32 {
        // `size == 1`: the real size is a 64-bit value behind the type.
        1 => (16usize, read_u64(data, start + 8)?),
        // `size == 0`: the box runs to the end of the data.
        0 => (8usize, (data.len() - start) as u64),
        n => (8usize, u64::from(n)),
    };

    let total = usize::try_from(total).ok()?;
    if total < header_len {
        return None;
    }
    let end = start.checked_add(total)?;
    if end > data.len() {
        return None;
    }

    // `total >= header_len >= 8`, so the position always moves forward.
    *pos = end;
    Some((kind, &data[start + header_len..end]))
}

fn read_u32(data: &[u8], at: usize) -> Option<u32> {
    let raw: [u8; 4] = data.get(at..at + 4)?.try_into().ok()?;
    Some(u32::from_be_bytes(raw))
}

fn read_u64(data: &[u8], at: usize) -> Option<u64> {
    let raw: [u8; 8] = data.get(at..at + 8)?.try_into().ok()?;
    Some(u64::from_be_bytes(raw))
}

// ---------------------------------------------------------------------------
// moov → trak → mdia
// ---------------------------------------------------------------------------

/// First track that yields a usable video index.
fn parse_moov(moov: &[u8]) -> Option<VideoFrameIndex> {
    let mut pos = 0;
    while let Some((kind, payload)) = next_box(moov, &mut pos) {
        if kind == b"trak" {
            if let Some(index) = parse_trak(payload) {
                return Some(index);
            }
        }
    }
    None
}

fn parse_trak(trak: &[u8]) -> Option<VideoFrameIndex> {
    let mut pos = 0;
    while let Some((kind, payload)) = next_box(trak, &mut pos) {
        if kind == b"mdia" {
            return parse_mdia(payload);
        }
    }
    None
}

/// The three facts a track has to supply, collected in one pass so that the
/// order the writer chose for them does not matter.
fn parse_mdia(mdia: &[u8]) -> Option<VideoFrameIndex> {
    let mut timescale = None;
    let mut is_video = false;
    let mut entries = None;

    let mut pos = 0;
    while let Some((kind, payload)) = next_box(mdia, &mut pos) {
        match kind {
            b"mdhd" => timescale = mdhd_timescale(payload),
            b"hdlr" => is_video = handler_type(payload) == Some(*b"vide"),
            b"minf" => entries = time_to_sample(payload),
            _ => {}
        }
    }

    if !is_video {
        return None;
    }
    let timescale = timescale?;
    if timescale == 0 {
        return None;
    }
    build_index(timescale, &entries?)
}

/// `mdhd` timescale. Version 1 widens the two timestamps ahead of it to 64 bits.
fn mdhd_timescale(payload: &[u8]) -> Option<u32> {
    match *payload.first()? {
        0 => read_u32(payload, 4 + 4 + 4),
        1 => read_u32(payload, 4 + 8 + 8),
        _ => None,
    }
}

/// `hdlr` handler type — `vide` for a video track.
fn handler_type(payload: &[u8]) -> Option<[u8; 4]> {
    // version/flags (4) + pre_defined (4), then the four-character type.
    payload.get(8..12)?.try_into().ok()
}

/// `minf` → `stbl` → `stts`, as `(sample_count, sample_delta)` runs.
fn time_to_sample(minf: &[u8]) -> Option<Vec<(u32, u32)>> {
    let mut pos = 0;
    while let Some((kind, payload)) = next_box(minf, &mut pos) {
        if kind == b"stbl" {
            let mut inner = 0;
            while let Some((kind, payload)) = next_box(payload, &mut inner) {
                if kind == b"stts" {
                    return parse_stts(payload);
                }
            }
        }
    }
    None
}

fn parse_stts(payload: &[u8]) -> Option<Vec<(u32, u32)>> {
    let declared = read_u32(payload, 4)? as usize;
    // No `with_capacity`: the declared count is attacker-controlled, while the
    // reads below stop at the end of the payload the file actually carries.
    let mut entries = Vec::new();
    for i in 0..declared {
        let at = 8 + i * 8;
        entries.push((read_u32(payload, at)?, read_u32(payload, at + 4)?));
    }
    Some(entries)
}

// ---------------------------------------------------------------------------
// Sample table → index
// ---------------------------------------------------------------------------

fn build_index(timescale: u32, entries: &[(u32, u32)]) -> Option<VideoFrameIndex> {
    let total_samples: u64 = entries.iter().map(|(count, _)| u64::from(*count)).sum();
    if total_samples == 0 || total_samples > MAX_SAMPLES {
        return None;
    }

    let mut sample_times = Vec::with_capacity(total_samples as usize);
    let mut clock: u64 = 0;
    for (count, delta) in entries {
        for _ in 0..*count {
            sample_times.push(clock);
            clock = clock.saturating_add(u64::from(*delta));
        }
    }
    let duration = clock;

    // Nominal sample duration: the one carrying the most frames. `stts` is
    // run-length encoded, so the longest run is the rate the movie runs at;
    // scanning for it is linear, which matters for a table that really is
    // variable and has an entry per frame.
    let mut nominal = 0u64;
    let mut widest = 0u64;
    for (count, delta) in entries {
        if u64::from(*count) > widest {
            widest = u64::from(*count);
            nominal = u64::from(*delta);
        }
    }

    let is_cfr = nominal > 0
        && entries.iter().all(|(count, delta)| {
            *count == 0
                || u64::from(*delta).abs_diff(nominal) * 1000 <= nominal * CFR_TOLERANCE_PERMILLE
        });

    // A rate is still owed even when the table is nonsense (all-zero
    // durations): the frontend divides by `fps_den`, so it must not be zero.
    let den = if nominal > 0 {
        nominal
    } else {
        (duration / total_samples).max(1)
    };
    let divisor = gcd(u64::from(timescale), den).max(1);

    Some(VideoFrameIndex {
        timescale,
        sample_times,
        duration,
        fps_num: (u64::from(timescale) / divisor) as u32,
        fps_den: (den / divisor) as u32,
        is_cfr,
    })
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let rest = a % b;
        a = b;
        b = rest;
    }
    a
}
