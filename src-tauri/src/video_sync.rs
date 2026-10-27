//! Sync-sample tables of open-GOP HEVC and H.264, rewritten for serving
//! (requirements.md #37 追補f, Issue #591; 追補g, Issue #734).
//!
//! An accurate seek in AVFoundation — and so in WKWebView — starts decoding at
//! the nearest full sync sample (`stss`) before the target. In open-GOP
//! material a few pictures decoded after a sync sample are shown before it
//! (leading pictures), and they refer to the GOP before.
//!
//! - HEVC (追補f): x265's default output writes every CRA to `stss`, and a CRA
//!   that decoding starts at cannot output its RASL pictures. A paused seek to
//!   one of them completes without a new picture: the frame number moves on,
//!   the screen keeps the previous frame. Listing those CRAs in `stps` (partial
//!   sync) instead makes the seek start one GOP earlier, from where the RASL
//!   pictures decode (300/300 frames in AVFoundation and in WKWebView).
//! - H.264 (追補g): with x264's `open-gop`, VideoToolbox fails on the leading
//!   B-frames of a non-IDR I it starts decoding at, and AVFoundation drops the
//!   whole request: past the first GOP only the I frames ever show, paused or
//!   playing from there. The rewrite ("fs") moves an I with one leading frame
//!   to `stps` and marks that frame in `sdtp` as one no other sample depends
//!   on, which a seek does not decode unless it is the target; an I with more
//!   leading frames leaves `stss` altogether, so a seek into its GOP decodes
//!   from an earlier sync sample (every frame of every x264 setting tried, in
//!   AVFoundation and in WKWebView). An empty `stps` hides the video track
//!   from AVFoundation, so none is ever written.
//!
//! The file is never written. `commands::asset` serves the movie with the
//! `moov` this module returns in place of the original one ([`MoovPatch`]).
//!
//! Boxes are read the way `video_frames` reads them — by declared size, in any
//! sibling order, never panicking on malformed input — but more strictly along
//! the path that is rebuilt: every box of `moov`, `trak`, `mdia`, `minf` and
//! `stbl` has to fit its parent exactly, or nothing is rewritten. Anything this
//! module cannot vouch for is served as it is (契約4 fail-open).

use crate::video_frames::{next_box, parse_ctts, parse_stts, read_u32, read_u64, MAX_SAMPLES};

/// Sample entries that make a track HEVC.
const HEVC_SAMPLE_ENTRIES: [&[u8; 4]; 2] = [b"hvc1", b"hev1"];

/// Sample entries that make a track H.264 (x264 and ffmpeg write neither
/// `avc2` nor `avc4`, 追補g 起案時判断 (a)).
const H264_SAMPLE_ENTRIES: [&[u8; 4]; 2] = [b"avc1", b"avc3"];

/// sample_is_depended_on, bits 3..2 of a sample's `sdtp` byte …
const SDTP_IS_DEPENDED_ON: u8 = 0b0000_1100;
/// … set to 2: no other sample depends on this one.
const SDTP_NOT_DEPENDED_ON: u8 = 0b0000_1000;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/// The sync samples of each HEVC track that have leading samples, as
/// `(track_ID, 1-based sample numbers ascending)`, in `moov` order.
///
/// A sync sample (other than the first sample) has leading samples when some
/// sample decoded after it is presented before it — presentation times from
/// `stts` and `ctts`, without the edit list. Only HEVC tracks that have at
/// least one are listed — H.264 tracks never are (追補g counts their leading
/// samples differently, see [`rewrite_moov_for_open_gop`]). An empty answer is
/// also what a `moov` that cannot be read gives, or data that does not start
/// with one.
pub fn leading_sync_samples(moov: &[u8]) -> Vec<(u32, Vec<u32>)> {
    let Some(movie) = Movie::parse(moov) else {
        return Vec::new();
    };
    movie
        .traks
        .into_iter()
        .filter_map(|trak| {
            let edit = trak.edit.filter(|edit| edit.codec == Codec::Hevc)?;
            Some((trak.track_id, edit.leading))
        })
        .collect()
}

/// Whether the `moov` precedes the media data (faststart) or follows it. Only
/// a `moov` ahead of the data moves the chunks when it changes size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoovPosition {
    BeforeMdat,
    AfterMdat,
}

/// The `moov` box (header included) with the sync tables of its open-GOP
/// HEVC and H.264 tracks rewritten, or `None` when it is to be served as it
/// is.
///
/// - HEVC (追補f): the sync samples of [`leading_sync_samples`] leave the
///   track's `stss` and join its `stps`, which is created right after `stss`
///   when the track has none (ascending, no duplicates).
/// - H.264 (追補g, "fs"): for every sync sample S but sample 1, L(S) counts
///   the samples decoded after S and before the next sync sample of the
///   original `stss` that are presented before S (`stts` and `ctts`, without
///   the edit list). With L(S) = 0, S stays. With L(S) = 1, S moves from
///   `stss` to `stps` as above, and its one leading sample gets
///   sample_is_depended_on 2 in `sdtp`: only those two bits of the track's
///   `sdtp` change, or one is created right after `stss` (version 0, one byte
///   per sample, zero but the marks). With L(S) ≥ 2, S only leaves `stss`.
///   Neither `stps` nor `sdtp` is created with nothing to put in it. The track
///   is left as it is when no S has leading samples, when its `sdtp` is
///   shorter than its samples, when its `stss` would end up empty, or when
///   one of its tables cannot be read.
/// - The containers on the way (`stbl`, `minf`, `mdia`, `trak`, `moov`) change
///   size by the difference; with [`MoovPosition::BeforeMdat`] every track's
///   `stco` / `co64` entries move by it too, since the data behind the `moov`
///   does.
/// - Every other box is copied byte for byte.
/// - `None`: no track to rewrite (closed-GOP, all-IDR, another codec, …), a
///   `moov` that cannot be read (a box that does not fit its parent, a table
///   of an HEVC track cut short), a fragmented movie (`mvex`), or a chunk
///   offset that would no longer fit 32 bits.
pub fn rewrite_moov_for_open_gop(moov: &[u8], position: MoovPosition) -> Option<Vec<u8>> {
    let movie = Movie::parse(moov)?;
    // Fragments carry their own sample tables, which this does not touch.
    if movie.children.iter().any(|child| &child.kind == b"mvex") {
        return None;
    }
    let edits: Vec<&SyncEdit> = movie.traks.iter().filter_map(|t| t.edit.as_ref()).collect();
    if edits.is_empty() {
        return None;
    }
    let delta: i64 = edits.iter().map(|edit| edit.delta).sum();
    let shift = match position {
        MoovPosition::BeforeMdat => delta,
        MoovPosition::AfterMdat => 0,
    };

    let mut payload = Vec::with_capacity(movie.moov.bytes.len() + 64);
    let mut traks = movie.traks.iter();
    for child in &movie.children {
        if &child.kind == b"trak" {
            let trak = traks.next()?;
            payload.extend(rewrite_trak(child, trak.edit.as_ref(), shift)?);
        } else {
            payload.extend_from_slice(child.bytes);
        }
    }
    with_payload(&movie.moov, payload)
}

/// The served file: the original with `[offset, offset + original_len)`
/// replaced by `moov` (契約3). Ranges are cut from this view without the
/// patched file ever existing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoovPatch {
    /// Where the `moov` box sits in the original file.
    pub offset: u64,
    /// Length of the original `moov` box.
    pub original_len: u64,
    /// The rewritten `moov` box, header included
    /// ([`rewrite_moov_for_open_gop`]).
    pub moov: Vec<u8>,
}

/// One part of a range of the served file; joined in order they make the
/// range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    /// Bytes `[offset, offset + len)` of the original file.
    Original { offset: u64, len: u64 },
    /// Bytes `[start, start + len)` of [`MoovPatch::moov`].
    Moov { start: usize, len: usize },
}

impl MoovPatch {
    /// Size of the served file — what `Content-Length`, `Content-Range` and a
    /// `416` report.
    pub fn patched_total(&self, original_total: u64) -> u64 {
        original_total
            .saturating_sub(self.original_len)
            .saturating_add(self.moov.len() as u64)
    }

    /// The pieces of the served file's `[start, start + len)`, for a range
    /// within [`Self::patched_total`]. Empty pieces are left out.
    pub fn pieces(&self, start: u64, len: u64) -> Vec<Piece> {
        let end = start.saturating_add(len);
        let moov_start = self.offset;
        let moov_end = moov_start.saturating_add(self.moov.len() as u64);
        let mut pieces = Vec::with_capacity(3);

        // Ahead of the `moov`: the original, at the same place.
        let before_end = end.min(moov_start);
        if start < before_end {
            pieces.push(Piece::Original {
                offset: start,
                len: before_end - start,
            });
        }
        // The `moov`: the rewritten one.
        let (from, to) = (start.max(moov_start), end.min(moov_end));
        if from < to {
            pieces.push(Piece::Moov {
                start: (from - moov_start) as usize,
                len: (to - from) as usize,
            });
        }
        // Behind the `moov`: the original, moved by the difference in size.
        let from = start.max(moov_end);
        if from < end {
            pieces.push(Piece::Original {
                offset: from - moov_end + self.offset + self.original_len,
                len: end - from,
            });
        }
        pieces
    }
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

/// A box inside its parent's payload.
#[derive(Clone, Copy)]
struct Child<'a> {
    kind: [u8; 4],
    /// The whole box, header included.
    bytes: &'a [u8],
    /// 8, or 16 for the 64-bit size form.
    header_len: usize,
}

impl<'a> Child<'a> {
    fn payload(&self) -> &'a [u8] {
        &self.bytes[self.header_len..]
    }
}

/// The first box of `data`.
fn first_box(data: &[u8]) -> Option<Child<'_>> {
    let mut pos = 0;
    let (kind, payload) = next_box(data, &mut pos)?;
    Some(Child {
        kind: kind.try_into().ok()?,
        bytes: &data[..pos],
        header_len: pos - payload.len(),
    })
}

/// Every box of `data`, or `None` unless they fill it exactly — what lets a
/// container be rebuilt from its children.
fn children(data: &[u8]) -> Option<Vec<Child<'_>>> {
    let mut boxes = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        let start = pos;
        let (kind, payload) = next_box(data, &mut pos)?;
        boxes.push(Child {
            kind: kind.try_into().ok()?,
            bytes: &data[start..pos],
            header_len: pos - start - payload.len(),
        });
    }
    Some(boxes)
}

fn find<'a>(boxes: &[Child<'a>], kind: &[u8; 4]) -> Option<Child<'a>> {
    boxes.iter().find(|child| &child.kind == kind).copied()
}

/// `b` with `payload` behind its own header, the size field updated in the
/// form it was written in. A size of zero ("to the end of the parent") stays:
/// the box is still the last one.
fn with_payload(b: &Child, payload: Vec<u8>) -> Option<Vec<u8>> {
    let total = b.header_len + payload.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&b.bytes[..b.header_len]);
    match read_u32(b.bytes, 0)? {
        0 => {}
        1 => out[8..16].copy_from_slice(&(total as u64).to_be_bytes()),
        _ => out[0..4].copy_from_slice(&u32::try_from(total).ok()?.to_be_bytes()),
    }
    out.extend(payload);
    Some(out)
}

/// `parent` rebuilt with its first child of `kind` replaced by what `rewrite`
/// makes of it (copied as it is when there is none).
fn replace_first(
    parent: &Child,
    kind: &[u8; 4],
    rewrite: impl FnOnce(&Child) -> Option<Vec<u8>>,
) -> Option<Vec<u8>> {
    let mut rewrite = Some(rewrite);
    let mut payload = Vec::with_capacity(parent.bytes.len() + 64);
    for child in children(parent.payload())? {
        match rewrite.take_if(|_| &child.kind == kind) {
            Some(rewrite) => payload.extend(rewrite(&child)?),
            None => payload.extend_from_slice(child.bytes),
        }
    }
    with_payload(parent, payload)
}

// ---------------------------------------------------------------------------
// Reading the movie
// ---------------------------------------------------------------------------

/// A `moov` read far enough to know what to rewrite.
struct Movie<'a> {
    moov: Child<'a>,
    children: Vec<Child<'a>>,
    /// One per `trak` child, in order.
    traks: Vec<TrakInfo>,
}

struct TrakInfo {
    /// `tkhd` track_ID (0 when it cannot be read).
    track_id: u32,
    /// What changes in this track; `None` for every track but an HEVC or H.264
    /// one with leading sync samples.
    edit: Option<SyncEdit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Codec {
    Hevc,
    H264,
}

/// The replacement sync tables of one track.
struct SyncEdit {
    codec: Codec,
    /// The sync samples that leave `stss`, ascending.
    leading: Vec<u32>,
    /// The new `stss` box.
    stss: Vec<u8>,
    stps: Table,
    sdtp: Table,
    /// Bytes the track's `stbl` grows by (negative when it shrinks).
    delta: i64,
}

/// What becomes of an optional table of `stbl` (`stps`, `sdtp`).
enum Table {
    /// Left as it is — or left out, when the track has none.
    Keep,
    /// This box in place of the track's first one.
    Replace(Vec<u8>),
    /// This box added right after `stss`; the track has none.
    Add(Vec<u8>),
}

impl Table {
    /// `new` in place of `existing`, or added when there is none.
    fn put(new: Vec<u8>, existing: Option<Child>) -> Self {
        match existing {
            Some(_) => Self::Replace(new),
            None => Self::Add(new),
        }
    }

    /// Bytes this makes `stbl` grow by, `existing` being the box it replaces.
    fn growth(&self, existing: Option<Child>) -> i64 {
        match self {
            Self::Keep => 0,
            Self::Replace(b) => b.len() as i64 - existing.map_or(0, |e| e.bytes.len()) as i64,
            Self::Add(b) => b.len() as i64,
        }
    }

    fn replacement(&self) -> Option<&[u8]> {
        match self {
            Self::Replace(b) => Some(b),
            _ => None,
        }
    }

    fn addition(&self) -> &[u8] {
        match self {
            Self::Add(b) => b,
            _ => &[],
        }
    }
}

impl<'a> Movie<'a> {
    /// `None` when `data` does not start with a `moov` that can be read.
    fn parse(data: &'a [u8]) -> Option<Self> {
        let moov = first_box(data).filter(|b| &b.kind == b"moov")?;
        let children = children(moov.payload())?;
        let traks = children
            .iter()
            .filter(|child| &child.kind == b"trak")
            .map(parse_trak)
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            moov,
            children,
            traks,
        })
    }
}

fn parse_trak(trak: &Child) -> Option<TrakInfo> {
    let mut level = children(trak.payload())?;
    let track_id = find(&level, b"tkhd")
        .and_then(|tkhd| tkhd_track_id(tkhd.payload()))
        .unwrap_or(0);
    for kind in [b"mdia", b"minf", b"stbl"] {
        let Some(next) = find(&level, kind) else {
            // No sample table, nothing to rewrite.
            return Some(TrakInfo {
                track_id,
                edit: None,
            });
        };
        level = children(next.payload())?;
    }
    Some(TrakInfo {
        track_id,
        edit: sync_edit(&level)?,
    })
}

/// `tkhd` track_ID; version 1 widens the two timestamps ahead of it.
fn tkhd_track_id(payload: &[u8]) -> Option<u32> {
    match *payload.first()? {
        0 => read_u32(payload, 4 + 4 + 4),
        1 => read_u32(payload, 4 + 8 + 8),
        _ => None,
    }
}

/// HEVC when one of the `stsd` sample entries is, else H.264 when one of them
/// is.
fn codec(stsd: &[u8]) -> Option<Codec> {
    let count = read_u32(stsd, 4)?;
    let entries = &stsd[8..];
    let mut pos = 0;
    let mut found = None;
    for (kind, _) in (0..count).map_while(|_| next_box(entries, &mut pos)) {
        if HEVC_SAMPLE_ENTRIES.iter().any(|hevc| kind == *hevc) {
            return Some(Codec::Hevc);
        }
        if H264_SAMPLE_ENTRIES.iter().any(|h264| kind == *h264) {
            found = Some(Codec::H264);
        }
    }
    found
}

/// `stss` / `stps`: version and flags, then sample numbers.
struct SampleNumbers {
    version_flags: [u8; 4],
    numbers: Vec<u32>,
}

impl SampleNumbers {
    /// `None` when the table is cut short of its declared count.
    fn parse(payload: &[u8]) -> Option<Self> {
        let version_flags = payload.get(0..4)?.try_into().ok()?;
        let count = read_u32(payload, 4)? as usize;
        let table = &payload[8..];
        if table.len() / 4 < count {
            return None;
        }
        let numbers = (0..count)
            .map(|i| read_u32(table, i * 4))
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            version_flags,
            numbers,
        })
    }

    /// An empty table, version 0.
    fn empty() -> Self {
        Self {
            version_flags: [0; 4],
            numbers: Vec::new(),
        }
    }

    /// These numbers but `removed` (ascending), in their order.
    fn without(&self, removed: &[u32]) -> Self {
        Self {
            version_flags: self.version_flags,
            numbers: self
                .numbers
                .iter()
                .copied()
                .filter(|n| removed.binary_search(n).is_err())
                .collect(),
        }
    }

    /// These numbers and `added`, ascending, without duplicates.
    fn with(mut self, added: &[u32]) -> Self {
        self.numbers.extend_from_slice(added);
        self.numbers.sort_unstable();
        self.numbers.dedup();
        self
    }

    fn to_box(&self, kind: &[u8; 4]) -> Option<Vec<u8>> {
        let size = u32::try_from(8 + 4 + 4 + 4 * self.numbers.len()).ok()?;
        let mut b = Vec::with_capacity(size as usize);
        b.extend_from_slice(&size.to_be_bytes());
        b.extend_from_slice(kind);
        b.extend_from_slice(&self.version_flags);
        b.extend_from_slice(&(self.numbers.len() as u32).to_be_bytes());
        for n in &self.numbers {
            b.extend_from_slice(&n.to_be_bytes());
        }
        Some(b)
    }
}

/// The sync table change of a track whose `stbl` holds `stbl`. The outer
/// `None` is a table that cannot be read (the movie is then served as it is);
/// the inner one is a track with nothing to change.
fn sync_edit(stbl: &[Child]) -> Option<Option<SyncEdit>> {
    match find(stbl, b"stsd").and_then(|stsd| codec(stsd.payload())) {
        Some(Codec::Hevc) => hevc_edit(stbl),
        // 追補g is decided track by track: an H.264 track that cannot be read
        // is left as it is, and takes no other track's rewrite down with it.
        Some(Codec::H264) => Some(h264_edit(stbl)),
        None => Some(None),
    }
}

/// The tables a track's sync samples are judged by.
struct SyncSource<'a> {
    stss_box: Child<'a>,
    stss: SampleNumbers,
    stps_box: Option<Child<'a>>,
    stps: Option<SampleNumbers>,
    stts: Vec<(u32, u32)>,
    /// Covers every sample of `stts`, or is empty.
    ctts: Vec<(u32, i32)>,
    /// Number of samples, at most [`MAX_SAMPLES`].
    samples: u64,
}

impl<'a> SyncSource<'a> {
    /// The outer `None` is a table that cannot be read; the inner one a track
    /// without `stss`, where every sample is a sync sample and there is none
    /// to tell apart.
    fn read(stbl: &[Child<'a>]) -> Option<Option<Self>> {
        let Some(stss_box) = find(stbl, b"stss") else {
            return Some(None);
        };
        let stss = SampleNumbers::parse(stss_box.payload())?;
        let stps_box = find(stbl, b"stps");
        let stps = match stps_box {
            Some(b) => Some(SampleNumbers::parse(b.payload())?),
            None => None,
        };
        let stts = parse_stts(find(stbl, b"stts")?.payload())?;
        let ctts = match find(stbl, b"ctts") {
            Some(b) => Some(parse_ctts(b.payload())?),
            None => None,
        };

        let samples: u64 = stts.iter().map(|(count, _)| u64::from(*count)).sum();
        if samples > MAX_SAMPLES {
            return None;
        }
        // Offsets that do not line up with the samples cannot say which sample
        // is shown when.
        if ctts.as_ref().is_some_and(|ctts| {
            ctts.iter().map(|(count, _)| u64::from(*count)).sum::<u64>() != samples
        }) {
            return None;
        }
        Some(Some(Self {
            stss_box,
            stss,
            stps_box,
            stps,
            stts,
            ctts: ctts.unwrap_or_default(),
            samples,
        }))
    }
}

/// 追補f: the HEVC sync samples with leading samples move from `stss` to
/// `stps`.
fn hevc_edit(stbl: &[Child]) -> Option<Option<SyncEdit>> {
    let Some(source) = SyncSource::read(stbl)? else {
        return Some(None);
    };
    let leading = with_leading(&source.stts, &source.ctts, &source.stss.numbers);
    if leading.is_empty() {
        return Some(None);
    }

    let stss = source.stss.without(&leading).to_box(b"stss")?;
    let partial = source
        .stps
        .unwrap_or_else(SampleNumbers::empty)
        .with(&leading);
    let stps = Table::put(partial.to_box(b"stps")?, source.stps_box);
    let delta =
        stss.len() as i64 - source.stss_box.bytes.len() as i64 + stps.growth(source.stps_box);
    Some(Some(SyncEdit {
        codec: Codec::Hevc,
        leading,
        stss,
        stps,
        sdtp: Table::Keep,
        delta,
    }))
}

/// 追補g "fs" for an H.264 track (契約2〜4), or `None` to leave it as it is.
fn h264_edit(stbl: &[Child]) -> Option<SyncEdit> {
    let source = SyncSource::read(stbl)??;
    let samples = source.samples as usize;
    let sdtp_box = find(stbl, b"sdtp");
    // A table short of the samples cannot be trusted to say what it says of
    // them (version and flags, then one byte per sample).
    if sdtp_box.is_some_and(|b| b.payload().len() < 4 + samples) {
        return None;
    }
    let found = leading_counts(&source.stts, &source.ctts, &source.stss.numbers);
    if found.is_empty() {
        return None;
    }

    let leading: Vec<u32> = found.iter().map(|l| l.sync).collect();
    let kept = source.stss.without(&leading);
    if kept.numbers.is_empty() {
        return None;
    }
    let single: Vec<&Leading> = found.iter().filter(|l| l.count == 1).collect();
    let stps = if single.is_empty() {
        // Not even an empty one: AVFoundation loses the track to it.
        Table::Keep
    } else {
        let partial: Vec<u32> = single.iter().map(|l| l.sync).collect();
        let partial = source
            .stps
            .unwrap_or_else(SampleNumbers::empty)
            .with(&partial);
        Table::put(partial.to_box(b"stps")?, source.stps_box)
    };
    let sdtp = if single.is_empty() {
        Table::Keep
    } else {
        let marked: Vec<u32> = single.iter().map(|l| l.first).collect();
        Table::put(marked_sdtp(sdtp_box, samples, &marked)?, sdtp_box)
    };

    let stss = kept.to_box(b"stss")?;
    let delta = stss.len() as i64 - source.stss_box.bytes.len() as i64
        + stps.growth(source.stps_box)
        + sdtp.growth(sdtp_box);
    Some(SyncEdit {
        codec: Codec::H264,
        leading,
        stss,
        stps,
        sdtp,
        delta,
    })
}

/// `sdtp` with the `marked` samples (1-based) depended on by no other: the
/// track's own with only those two bits changed (any bytes past the samples
/// kept), or a new one — version 0, one byte per sample, zero but the marks.
fn marked_sdtp(existing: Option<Child>, samples: usize, marked: &[u32]) -> Option<Vec<u8>> {
    let (mut b, first) = match existing {
        Some(sdtp) => (sdtp.bytes.to_vec(), sdtp.header_len + 4),
        None => {
            let size = u32::try_from(8 + 4 + samples).ok()?;
            let mut b = Vec::with_capacity(size as usize);
            b.extend_from_slice(&size.to_be_bytes());
            b.extend_from_slice(b"sdtp");
            b.resize(size as usize, 0);
            (b, 8 + 4)
        }
    };
    for n in marked {
        let byte = b.get_mut(first + (*n as usize).checked_sub(1)?)?;
        *byte = (*byte & !SDTP_IS_DEPENDED_ON) | SDTP_NOT_DEPENDED_ON;
    }
    Some(b)
}

/// The sync samples (other than sample 1) that some later-decoded sample is
/// presented before, ascending.
///
/// Walks the samples backwards in decode order, carrying the earliest
/// presentation time seen so far — that is, the earliest of the samples decoded
/// after the current one. `ctts` covers every sample of `stts` or is empty.
fn with_leading(stts: &[(u32, u32)], ctts: &[(u32, i32)], stss: &[u32]) -> Vec<u32> {
    let mut syncs = stss.to_vec();
    syncs.sort_unstable();
    syncs.dedup();
    let mut syncs = syncs.into_iter().rev().peekable();

    let mut offsets = ctts
        .iter()
        .rev()
        .flat_map(|(count, offset)| std::iter::repeat_n(*offset, *count as usize));
    let mut decode_end: i128 = stts
        .iter()
        .map(|(count, delta)| i128::from(*count) * i128::from(*delta))
        .sum();
    let mut number: u64 = stts.iter().map(|(count, _)| u64::from(*count)).sum();
    let mut earliest_after: Option<i128> = None;
    let mut leading = Vec::new();

    for (count, delta) in stts.iter().rev() {
        for _ in 0..*count {
            decode_end -= i128::from(*delta);
            let shown = decode_end + i128::from(offsets.next().unwrap_or(0));
            while syncs.next_if(|s| u64::from(*s) > number).is_some() {}
            if syncs.peek().is_some_and(|s| u64::from(*s) == number)
                && number != 1
                && earliest_after.is_some_and(|t| t < shown)
            {
                leading.push(number as u32);
            }
            earliest_after = Some(earliest_after.map_or(shown, |t| t.min(shown)));
            number -= 1;
        }
    }
    leading.reverse();
    leading
}

/// An H.264 sync sample with leading samples (追補g 契約2).
struct Leading {
    /// The sync sample S, 1-based.
    sync: u32,
    /// L(S), at least 1.
    count: u32,
    /// The first of them in decode order, 1-based.
    first: u32,
}

/// The sync samples (other than sample 1) that some sample decoded after them
/// and before the next sync sample is presented before, ascending, with how
/// many such samples each has.
///
/// Unlike [`with_leading`], an early presentation behind the next sync sample
/// belongs to that one, not to this. Walks the samples forwards in decode
/// order: a sync sample closes the count of the one before and opens its own.
/// `ctts` covers every sample of `stts` or is empty.
fn leading_counts(stts: &[(u32, u32)], ctts: &[(u32, i32)], stss: &[u32]) -> Vec<Leading> {
    let mut syncs = stss.to_vec();
    syncs.sort_unstable();
    syncs.dedup();
    let mut syncs = syncs.into_iter().peekable();

    let mut offsets = ctts
        .iter()
        .flat_map(|(count, offset)| std::iter::repeat_n(*offset, *count as usize));
    let mut decode_time: i128 = 0;
    let mut number: u64 = 0;
    // The sync sample being counted for, and when it is shown.
    let mut open: Option<(Leading, i128)> = None;
    let mut found = Vec::new();

    for (count, delta) in stts {
        for _ in 0..*count {
            number += 1;
            let shown = decode_time + i128::from(offsets.next().unwrap_or(0));
            decode_time += i128::from(*delta);
            while syncs.next_if(|s| u64::from(*s) < number).is_some() {}
            if syncs.next_if(|s| u64::from(*s) == number).is_some() {
                found.extend(open.take().map(|(l, _)| l).filter(|l| l.count > 0));
                if number != 1 {
                    let sync = Leading {
                        sync: number as u32,
                        count: 0,
                        first: 0,
                    };
                    open = Some((sync, shown));
                }
            } else if let Some((leading, _)) = open.as_mut().filter(|(_, at)| shown < *at) {
                if leading.count == 0 {
                    leading.first = number as u32;
                }
                leading.count += 1;
            }
        }
    }
    found.extend(open.map(|(l, _)| l).filter(|l| l.count > 0));
    found
}

// ---------------------------------------------------------------------------
// Rebuilding the movie
// ---------------------------------------------------------------------------

/// A `trak` with its sync tables replaced by `edit` and its chunk offsets moved
/// by `shift`.
fn rewrite_trak(trak: &Child, edit: Option<&SyncEdit>, shift: i64) -> Option<Vec<u8>> {
    if edit.is_none() && shift == 0 {
        return Some(trak.bytes.to_vec());
    }
    replace_first(trak, b"mdia", |mdia| {
        replace_first(mdia, b"minf", |minf| {
            replace_first(minf, b"stbl", |stbl| rewrite_stbl(stbl, edit, shift))
        })
    })
}

fn rewrite_stbl(stbl: &Child, edit: Option<&SyncEdit>, shift: i64) -> Option<Vec<u8>> {
    let mut payload = Vec::with_capacity(stbl.bytes.len() + 64);
    // Only the first `stss` / `stps` / `sdtp` were read, so only they are
    // replaced.
    let mut stss = edit;
    let mut stps = edit.and_then(|edit| edit.stps.replacement());
    let mut sdtp = edit.and_then(|edit| edit.sdtp.replacement());
    for child in children(stbl.payload())? {
        match &child.kind {
            b"stss" if stss.is_some() => {
                let edit = stss.take()?;
                payload.extend_from_slice(&edit.stss);
                payload.extend_from_slice(edit.stps.addition());
                payload.extend_from_slice(edit.sdtp.addition());
            }
            b"stps" if stps.is_some() => payload.extend_from_slice(stps.take()?),
            b"sdtp" if sdtp.is_some() => payload.extend_from_slice(sdtp.take()?),
            b"stco" if shift != 0 => payload.extend(shift_chunk_offsets(&child, 4, shift)?),
            b"co64" if shift != 0 => payload.extend(shift_chunk_offsets(&child, 8, shift)?),
            _ => payload.extend_from_slice(child.bytes),
        }
    }
    with_payload(stbl, payload)
}

/// `stco` (`width` 4) or `co64` (8) with every entry moved by `shift`; `None`
/// when the table is cut short or an entry leaves its width.
fn shift_chunk_offsets(table: &Child, width: usize, shift: i64) -> Option<Vec<u8>> {
    let mut out = table.bytes.to_vec();
    let count = read_u32(&out, table.header_len + 4)? as usize;
    let first = table.header_len + 8;
    if (out.len() - first) / width < count {
        return None;
    }
    for at in (0..count).map(|i| first + i * width) {
        if width == 4 {
            let moved = u32::try_from(i64::from(read_u32(&out, at)?) + shift).ok()?;
            out[at..at + 4].copy_from_slice(&moved.to_be_bytes());
        } else {
            let moved = read_u64(&out, at)?.checked_add_signed(shift)?;
            out[at..at + 8].copy_from_slice(&moved.to_be_bytes());
        }
    }
    Some(out)
}
