//! Frame index of an MP4 / QuickTime movie (requirements.md #37 契約②).
//!
//! A frame-accurate viewer needs to know where every frame *starts*, not what
//! the nominal frame rate is: `fps × time` rounding drifts, and a variable-rate
//! movie has no single rate to multiply by. So this module reads the sample
//! table out of the container and hands the frontend the exact presentation
//! times, which it looks positions up in (`src/lib/video-frame.ts`).
//!
//! It is a deliberately small parser rather than a dependency (契約⑨: no new
//! crates). Only the boxes that decide when a frame is shown are understood —
//! `moov` → (`mvhd`, `trak` → (`edts` → `elst`, `mdia` → (`mdhd`, `hdlr`,
//! `minf` → `stbl` → (`stts`, `ctts`)))) — and every other box, known or not,
//! is skipped by its declared size. That is what makes it survive QuickTime
//! dialects: an unexpected sibling is just another box to step over, and the
//! order of siblings never matters.
//!
//! The times are the ones the player reports (req-37 追補d): decode times from
//! `stts`, moved by the composition offsets in `ctts`, then by the first edit
//! of the edit list, and sorted into presentation order. A movie with B-frames
//! therefore does not start at zero unless its edit list says so, exactly as
//! ffprobe's `pts_time` does not.
//!
//! Nothing here can fail loudly. Every malformed input answers `None`, and the
//! viewer degrades to a bar without frame numbers (契約⑦ fail-open) — a movie
//! that cannot be indexed must still play. The optional tables are softer
//! still: a `ctts` or `elst` that cannot be read is ignored, and the index
//! falls back to what `stts` alone says.

use serde::Serialize;

/// Upper bound on the number of frames one index may describe (~27 hours at
/// 60 fps).
///
/// `stts` run-lengths are `u32`, so a corrupt or hostile table can claim four
/// billion samples; the index materialises one `u64` per frame and then crosses
/// IPC as JSON, so an absurd table is refused rather than allocated for. The
/// same bound applies to `ctts`, both to its entry count and to the samples it
/// claims.
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
    /// Presentation start of each frame in ticks, strictly ascending. The
    /// position in this vector *is* the frame number (0-based, in presentation
    /// order, matching ffmpeg's `n`). Frames the edit list cuts away — before
    /// the edit starts or after it ends — are not in it. Without `ctts` and an
    /// edit list this is the running sum of the `stts` durations, from 0.
    pub sample_times: Vec<u64>,
    /// Presentation end of the movie in ticks: the latest end of any indexed
    /// frame (its start plus its `stts` duration), cut at the end of the edit
    /// when the edit list gives one. The `mdhd` duration field is not used: it
    /// describes the media before edits, and this has to agree with
    /// `sample_times` for the half-frame seek to land inside the last frame.
    pub duration: u64,
    /// Nominal frame rate as a fraction. Exact for constant-rate movies
    /// (`timescale / frame interval`); a representative value otherwise.
    pub fps_num: u32,
    /// Never zero — the frontend divides by it to derive the SMPTE frame base.
    pub fps_den: u32,
    /// Whether the frames are evenly spaced in presentation order. Gates the
    /// SMPTE readout, which is undefined for variable-rate material (契約①).
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
    // The movie timescale is the unit of the edit list's durations. `mvhd`
    // normally leads, but nothing requires it to, so it is looked up first.
    let mut movie_timescale = None;
    let mut pos = 0;
    while let Some((kind, payload)) = next_box(moov, &mut pos) {
        if kind == b"mvhd" {
            movie_timescale = header_timescale(payload);
            break;
        }
    }

    let mut pos = 0;
    while let Some((kind, payload)) = next_box(moov, &mut pos) {
        if kind == b"trak" {
            if let Some(index) = parse_trak(payload, movie_timescale) {
                return Some(index);
            }
        }
    }
    None
}

fn parse_trak(trak: &[u8], movie_timescale: Option<u32>) -> Option<VideoFrameIndex> {
    let mut mdia = None;
    let mut edits = None;

    let mut pos = 0;
    while let Some((kind, payload)) = next_box(trak, &mut pos) {
        match kind {
            b"mdia" if mdia.is_none() => mdia = Some(payload),
            // The edit list is the track's sibling of `mdia`, not part of it.
            b"edts" if edits.is_none() => edits = Some(parse_edts(payload)),
            _ => {}
        }
    }

    parse_mdia(mdia?, edits.flatten(), movie_timescale)
}

/// The three facts a track has to supply, collected in one pass so that the
/// order the writer chose for them does not matter.
fn parse_mdia(
    mdia: &[u8],
    edits: Option<EditList>,
    movie_timescale: Option<u32>,
) -> Option<VideoFrameIndex> {
    let mut timescale = None;
    let mut is_video = false;
    let mut table = None;

    let mut pos = 0;
    while let Some((kind, payload)) = next_box(mdia, &mut pos) {
        match kind {
            b"mdhd" => timescale = header_timescale(payload),
            b"hdlr" => is_video = handler_type(payload) == Some(*b"vide"),
            b"minf" => table = sample_table(payload),
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
    let edit = edits.and_then(|edits| edits.in_media_ticks(movie_timescale?, timescale));
    build_index(timescale, &table?, edit)
}

/// `mvhd` / `mdhd` timescale. The two headers agree up to this field; version
/// 1 widens the two timestamps ahead of it to 64 bits.
fn header_timescale(payload: &[u8]) -> Option<u32> {
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

// ---------------------------------------------------------------------------
// Edit list
// ---------------------------------------------------------------------------

/// The part of `edts` → `elst` the index honours, in the units the file
/// writes it in.
///
/// Only the first edit that plays media is used, together with the empty edits
/// that delay it; later edits and the media rate are ignored. This mirrors what
/// matters for ordinary files (an encoder trimming its B-frame delay, a track
/// starting after the movie does), not edit lists in general.
#[derive(Debug, Clone, Copy)]
struct EditList {
    /// Total length of the empty edits ahead of the first media edit, in
    /// movie ticks.
    delay: u64,
    /// Where the first media edit starts in the media, in media ticks.
    media_time: u64,
    /// How long the first media edit plays, in movie ticks. Zero means "to
    /// the end of the media".
    segment_duration: u64,
}

/// The first media edit, or `None` when the list has none or cannot be read
/// that far — either way the track plays unedited.
fn parse_edts(edts: &[u8]) -> Option<EditList> {
    let mut pos = 0;
    while let Some((kind, payload)) = next_box(edts, &mut pos) {
        if kind != b"elst" {
            continue;
        }
        let version = *payload.first()?;
        let count = read_u32(payload, 4)? as usize;
        let mut delay = 0u64;
        // The declared count is not trusted: the reads stop at the end of the
        // payload the file actually carries.
        for i in 0..count {
            let (segment_duration, media_time) = match version {
                0 => {
                    let at = 8 + i * 12;
                    let media_time = read_u32(payload, at + 4)? as i32;
                    (u64::from(read_u32(payload, at)?), i64::from(media_time))
                }
                1 => {
                    let at = 8 + i * 20;
                    (read_u64(payload, at)?, read_u64(payload, at + 8)? as i64)
                }
                _ => return None,
            };
            // A negative media time (−1) is an empty edit: nothing is shown
            // for its length, which pushes the media that follows later.
            if media_time < 0 {
                delay = delay.saturating_add(segment_duration);
                continue;
            }
            return Some(EditList {
                delay,
                media_time: media_time as u64,
                segment_duration,
            });
        }
        return None;
    }
    None
}

/// An edit list resolved to media ticks — what is subtracted from and added
/// to every sample's time, and where the presentation stops.
#[derive(Debug, Clone, Copy, Default)]
struct Edit {
    /// The empty edits' length, rescaled to media ticks.
    delay: u64,
    /// Media time the first media edit starts at.
    media_time: u64,
    /// End of the presentation (`delay` plus the media edit's length), or
    /// `None` when the edit runs to the end of the media.
    end: Option<u64>,
}

impl EditList {
    /// Resolve the movie-tick durations against the two timescales. A movie
    /// timescale of zero leaves them meaningless, and the edit list is then
    /// ignored rather than guessed at.
    fn in_media_ticks(self, movie_timescale: u32, media_timescale: u32) -> Option<Edit> {
        if movie_timescale == 0 {
            return None;
        }
        let delay = rescale(self.delay, movie_timescale, media_timescale);
        let end = (self.segment_duration > 0).then(|| {
            delay.saturating_add(rescale(
                self.segment_duration,
                movie_timescale,
                media_timescale,
            ))
        });
        Some(Edit {
            delay,
            media_time: self.media_time,
            end,
        })
    }
}

/// `value × to / from`, rounded to the nearest integer with halves going away
/// from zero (ffmpeg's `av_rescale`, which is how ffprobe arrives at the
/// times this index has to agree with). `from` must not be zero.
fn rescale(value: u64, from: u32, to: u32) -> u64 {
    let from = u128::from(from);
    let scaled = (u128::from(value) * u128::from(to) * 2 + from) / (2 * from);
    u64::try_from(scaled).unwrap_or(u64::MAX)
}

// ---------------------------------------------------------------------------
// Sample tables
// ---------------------------------------------------------------------------

/// The `stbl` tables the index is built from, as run-length entries.
struct SampleTable {
    /// `stts`: `(sample_count, sample_delta)` — decode-time durations.
    stts: Vec<(u32, u32)>,
    /// `ctts`: `(sample_count, sample_offset)` — presentation minus decode
    /// time. `None` when absent or unreadable; the samples are then shown at
    /// their decode times.
    ctts: Option<Vec<(u32, i32)>>,
}

/// `minf` → `stbl` → (`stts`, `ctts`).
fn sample_table(minf: &[u8]) -> Option<SampleTable> {
    let mut pos = 0;
    while let Some((kind, payload)) = next_box(minf, &mut pos) {
        if kind == b"stbl" {
            let mut stts = None;
            let mut ctts = None;
            let mut inner = 0;
            while let Some((kind, payload)) = next_box(payload, &mut inner) {
                match kind {
                    b"stts" if stts.is_none() => stts = Some(parse_stts(payload)),
                    // A broken `ctts` is dropped here and only here: it must
                    // not take the `stts` next to it down with it.
                    b"ctts" if ctts.is_none() => ctts = Some(parse_ctts(payload)),
                    _ => {}
                }
            }
            if let Some(stts) = stts {
                return Some(SampleTable {
                    stts: stts?,
                    ctts: ctts.flatten(),
                });
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

/// `ctts` entries, or `None` for a table that is truncated or claims more
/// than `MAX_SAMPLES`. Whether it covers exactly the samples of `stts` is
/// checked once both are known (`build_index`).
fn parse_ctts(payload: &[u8]) -> Option<Vec<(u32, i32)>> {
    if *payload.first()? > 1 {
        return None;
    }
    let declared = read_u32(payload, 4)?;
    if u64::from(declared) > MAX_SAMPLES {
        return None;
    }
    let mut entries = Vec::new();
    let mut samples = 0u64;
    for i in 0..declared as usize {
        let at = 8 + i * 8;
        let count = read_u32(payload, at)?;
        // Version 0 declares the offset unsigned, but encoders write negative
        // ones there too; reading both versions as signed is what ffmpeg does.
        let offset = read_u32(payload, at + 4)? as i32;
        samples += u64::from(count);
        if samples > MAX_SAMPLES {
            return None;
        }
        entries.push((count, offset));
    }
    Some(entries)
}

// ---------------------------------------------------------------------------
// Sample table → index
// ---------------------------------------------------------------------------

/// Frame starts, the presentation end, and the frame intervals as
/// `(count, length)` runs — the raw material of the rate.
type Timeline = (Vec<u64>, u64, Vec<(u64, u64)>);

fn build_index(timescale: u32, table: &SampleTable, edit: Option<Edit>) -> Option<VideoFrameIndex> {
    let total_samples: u64 = table.stts.iter().map(|(count, _)| u64::from(*count)).sum();
    if total_samples == 0 || total_samples > MAX_SAMPLES {
        return None;
    }

    // Offsets that do not line up one-to-one with the samples cannot be
    // assigned to them; the movie is indexed as if it had none.
    let ctts = table.ctts.as_deref().filter(|runs| {
        runs.iter().map(|(count, _)| u64::from(*count)).sum::<u64>() == total_samples
    });

    let (sample_times, duration, intervals) = match (ctts, edit) {
        (None, None) => decode_timeline(&table.stts, total_samples),
        (ctts, edit) => {
            presentation_timeline(&table.stts, ctts.unwrap_or(&[]), edit.unwrap_or_default())?
        }
    };
    let frames = sample_times.len() as u64;

    // Nominal interval: the one carrying the most frames. The runs are
    // run-length encoded, so the longest run is the rate the movie runs at;
    // scanning for it is linear, which matters for a movie that really is
    // variable and changes interval at every frame.
    let mut nominal = 0u64;
    let mut widest = 0u64;
    for (count, length) in &intervals {
        if *count > widest {
            widest = *count;
            nominal = *length;
        }
    }

    let is_cfr = nominal > 0
        && intervals.iter().all(|(count, length)| {
            *count == 0 || length.abs_diff(nominal) * 1000 <= nominal * CFR_TOLERANCE_PERMILLE
        });

    // A rate is still owed even when the table is nonsense (all-zero
    // durations): the frontend divides by `fps_den`, so it must not be zero.
    let den = if nominal > 0 {
        nominal
    } else {
        (duration / frames).max(1)
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

/// A movie with neither composition offsets nor an edit list is shown in
/// decode order from zero: the frames start at the running sum of the `stts`
/// durations, and those durations are the intervals.
fn decode_timeline(stts: &[(u32, u32)], total_samples: u64) -> Timeline {
    let mut sample_times = Vec::with_capacity(total_samples as usize);
    let mut clock: u64 = 0;
    for (count, delta) in stts {
        for _ in 0..*count {
            sample_times.push(clock);
            clock = clock.saturating_add(u64::from(*delta));
        }
    }
    let intervals = stts
        .iter()
        .map(|(count, delta)| (u64::from(*count), u64::from(*delta)))
        .collect();
    (sample_times, clock, intervals)
}

/// Every sample's presentation time — decode time plus its `ctts` offset,
/// minus where the edit starts in the media, plus the empty edits ahead of it
/// — in presentation order.
///
/// A sample that lands before zero, or at or after the end of the edit, is
/// never shown and is left out; one that starts inside the edit but runs past
/// its end is kept, and the duration is cut at the edit's end instead. Two
/// samples at the same time cannot both be a frame of a strictly ascending
/// index, so the earlier one in decode order is kept. `None` if the edit
/// leaves nothing to show.
fn presentation_timeline(stts: &[(u32, u32)], ctts: &[(u32, i32)], edit: Edit) -> Option<Timeline> {
    let shift = i128::from(edit.delay) - i128::from(edit.media_time);
    let mut offsets = ctts
        .iter()
        .flat_map(|(count, offset)| std::iter::repeat_n(*offset, *count as usize));

    // `(start, end)` per shown sample, in decode order until sorted below.
    let mut frames: Vec<(u64, u64)> = Vec::new();
    let mut decode_time: u64 = 0;
    for (count, delta) in stts {
        for _ in 0..*count {
            let offset = offsets.next().unwrap_or(0);
            let time = i128::from(decode_time) + i128::from(offset) + shift;
            decode_time = decode_time.saturating_add(u64::from(*delta));
            let Ok(start) = u64::try_from(time.min(i128::from(u64::MAX))) else {
                continue; // before zero
            };
            if edit.end.is_some_and(|end| start >= end) {
                continue;
            }
            frames.push((start, start.saturating_add(u64::from(*delta))));
        }
    }

    // Stable, so samples sharing a time stay in decode order and the dedup
    // keeps the first of them.
    frames.sort_by_key(|(start, _)| *start);
    frames.dedup_by_key(|(start, _)| *start);

    let last_end = frames.iter().map(|(_, end)| *end).max()?;
    let duration = edit.end.map_or(last_end, |end| last_end.min(end));
    let sample_times: Vec<u64> = frames.into_iter().map(|(start, _)| start).collect();

    // The rate is read off the gaps between consecutive frames. A lone frame
    // has none, so its own length stands in.
    let mut intervals: Vec<(u64, u64)> = Vec::new();
    for gap in sample_times.windows(2).map(|w| w[1] - w[0]) {
        match intervals.last_mut() {
            Some((count, length)) if *length == gap => *count += 1,
            _ => intervals.push((1, gap)),
        }
    }
    if intervals.is_empty() {
        intervals.push((1, duration - sample_times[0]));
    }

    Some((sample_times, duration, intervals))
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let rest = a % b;
        a = b;
        b = rest;
    }
    a
}
