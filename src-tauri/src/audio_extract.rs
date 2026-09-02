//! Audio track extraction from a QuickTime movie (requirements.md #41 契約③).
//!
//! `decodeAudioData` cannot demux QuickTime (measured 2026-09-01: every `.mov`
//! fails, whatever the audio codec inside), while it happily decodes MP4 and
//! WebM. So the waveform for a `.mov` is fed from here instead: the audio track
//! is lifted out of the container **without re-encoding** and handed to the
//! frontend in a wrapper the WebView does understand — a minimal `m4a` for
//! AAC/ALAC, a WAV for the PCM flavours.
//!
//! Re-wrapping rather than re-framing is the whole point. Raw ADTS decodes too,
//! but AAC encoder priming (1024 samples from ffmpeg, 2112 from Apple's
//! AudioToolbox) cannot be trimmed without an edit list, so the waveform lands
//! 23–48 ms late by an amount that depends on who encoded the file. Copying the
//! samples into an `m4a` keeps the sample table, and the decoded audio matches
//! the original sample for sample (measured, correlation 1.00000).
//!
//! The box walk follows `video_frames.rs`: only the boxes on the way to the
//! sample table are understood — `moov` → `trak` → `mdia` → (`mdhd`, `hdlr`,
//! `minf` → `stbl` → …) — and everything else is stepped over by its declared
//! size, so sibling order and QuickTime's dialects do not matter. Nothing here
//! panics or fails loudly: a movie that cannot be read answers `None`, and the
//! waveform band degrades to a sentence while playback continues
//! (契約⑤ fail-open).
//!
//! No new crates (契約③): the parser, the re-wrapper and the WAV header are all
//! a few hundred lines of byte pushing.

/// Largest number of audio samples one plan may describe.
///
/// The sample count comes out of the file, so a corrupt `stsz` can claim four
/// billion samples; one `SampleRange` per sample is materialised, so an absurd
/// table has to be refused rather than allocated for. Compressed audio never
/// comes close (AAC is ~47 frames a second, so an hour is under 200k), but
/// uncompressed PCM has one sample *per frame* — 44.1 kHz runs through this cap
/// in about six minutes, and a longer PCM movie degrades to "no audio" rather
/// than eating a gigabyte of ranges. That trade is deliberate: PCM in a movie
/// is rare, and the alternative is an unbounded allocation driven by file
/// contents.
const MAX_SAMPLES: usize = 16_000_000;

/// `formatSpecificFlags` bits of a QuickTime `lpcm` sound description
/// (CoreAudio's `AudioStreamBasicDescription` flags).
const LPCM_FLAG_FLOAT: u32 = 0x1;
const LPCM_FLAG_BIG_ENDIAN: u32 = 0x2;
const LPCM_FLAG_NON_INTERLEAVED: u32 = 0x20;

/// One sample of the audio track — a compressed frame (AAC/ALAC) or a block of
/// PCM — as a byte range from the start of the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SampleRange {
    pub offset: u64,
    pub size: u32,
}

/// What the `stsd` sample description says the audio is.
///
/// The `m4a` route re-uses the `stsd` box wholesale, so nothing inside it (the
/// `esds` for AAC, the magic cookie for ALAC) needs to be understood here — the
/// four-character code is enough to pick a route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioCodec {
    /// `mp4a` — re-wrapped into an `m4a`.
    Aac,
    /// `alac` — re-wrapped into an `m4a`.
    Alac,
    /// Uncompressed PCM — wrapped in a WAV header.
    ///
    /// `sowt` / `twos` carry 16-bit samples and take their endianness from the
    /// four-character code itself; `lpcm` describes itself in a version 2 sound
    /// description (`formatSpecificFlags`: bit 0 float, bit 1 big-endian).
    /// Supported: integer 16/24-bit either way round, and interleaved
    /// little-endian float32 (契約③(b)).
    Pcm {
        sample_rate: u32,
        channels: u16,
        bits_per_sample: u16,
        big_endian: bool,
        float: bool,
    },
    /// A track that exists but cannot be extracted (AC-3, big-endian float,
    /// non-interleaved PCM, anything unknown). Distinct from "no audio track":
    /// the band says "unsupported codec" rather than "no audio" (契約⑤).
    Unsupported,
}

/// Everything needed to lift the first audio track out of the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioExtractionPlan {
    pub codec: AudioCodec,
    /// Sample byte ranges in file order.
    pub ranges: Vec<SampleRange>,
    /// `mdhd` timescale, for the rebuilt `mdhd` / `stts`. Zero when the track
    /// has no readable `mdhd` — harmless for the WAV route, and `remux_m4a`
    /// refuses it.
    pub timescale: u32,
    /// `stts` run-lengths, carried through the re-wrap unchanged so the sample
    /// timing survives. Empty when the box is absent (the WAV route never
    /// looks at it).
    pub stts: Vec<(u32, u32)>,
    /// The original `stsd` box, header included, for the re-wrap to embed.
    pub stsd: Vec<u8>,
    /// Where the track's edit list says the media actually starts, in media
    /// time — the encoder priming an AAC track carries in front of its first
    /// real sample (1024 samples from ffmpeg, 2112 from Apple's AudioToolbox).
    ///
    /// Zero when the track has no edit list or does not trim (ALAC and PCM
    /// never do). Carrying it matters: the samples themselves contain the
    /// priming, so a re-wrap that drops the edit list plays it — and the
    /// waveform sits 23–48 ms late, which is the flaw that ruled out raw ADTS
    /// in the first place (契約③). `with_edit_list` puts it back.
    pub edit_start: u64,
}

// ---------------------------------------------------------------------------
// Box walking
// ---------------------------------------------------------------------------

/// One box: its four-character type, its payload, and the whole box including
/// the header (the `stsd` is carried over verbatim, so the header matters).
struct Bx<'a> {
    kind: &'a [u8],
    payload: &'a [u8],
    whole: &'a [u8],
}

/// Read the box at `pos` and advance past it.
///
/// `None` means "stop reading here" and covers both the honest end of the data
/// and a header that cannot be trusted: a size that does not cover its own
/// header, or a box claiming to run past the end of the buffer. Whatever was
/// parsed before that point stands.
fn next_box<'a>(data: &'a [u8], pos: &mut usize) -> Option<Bx<'a>> {
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
    Some(Bx {
        kind,
        payload: &data[start + header_len..end],
        whole: &data[start..end],
    })
}

fn read_u16(data: &[u8], at: usize) -> Option<u16> {
    let raw: [u8; 2] = data.get(at..at + 2)?.try_into().ok()?;
    Some(u16::from_be_bytes(raw))
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
// moov → trak → mdia → stbl
// ---------------------------------------------------------------------------

/// Plan the extraction of the first audio track, or `None` when there is
/// nothing to extract.
///
/// `bytes` may be the whole file or just the `moov` box — the walk starts at the
/// top level either way, and the command only ever reads the box it needs
/// (`commands::waveform`). Sample offsets are file-absolute in both cases:
/// `stco` / `co64` are written that way.
///
/// `None` covers everything that makes the extraction impossible — no `moov`,
/// no audio track, a missing or self-contradictory sample table. A track whose
/// *codec* cannot be used is not one of those: it comes back with
/// `codec: Unsupported`, because "there is audio here that I cannot read" and
/// "there is no audio" are different sentences for the band to print (契約⑤).
pub fn parse_audio_extraction(bytes: &[u8]) -> Option<AudioExtractionPlan> {
    let mut pos = 0;
    while let Some(b) = next_box(bytes, &mut pos) {
        if b.kind == b"moov" {
            return parse_moov(b.payload);
        }
    }
    None
}

fn parse_moov(moov: &[u8]) -> Option<AudioExtractionPlan> {
    let mut pos = 0;
    while let Some(b) = next_box(moov, &mut pos) {
        if b.kind == b"trak" {
            if let Some(plan) = parse_trak(b.payload) {
                return Some(plan);
            }
        }
    }
    None
}

fn parse_trak(trak: &[u8]) -> Option<AudioExtractionPlan> {
    let mut plan = None;
    let mut edit_start = 0;

    let mut pos = 0;
    while let Some(b) = next_box(trak, &mut pos) {
        match b.kind {
            b"mdia" => plan = parse_mdia(b.payload),
            // The edit list is the track's sibling of `mdia`, not part of it.
            b"edts" => edit_start = edit_list_start(b.payload).unwrap_or(0),
            _ => {}
        }
    }

    let mut plan = plan?;
    plan.edit_start = edit_start;
    Some(plan)
}

/// Where the first real edit starts in media time, from `edts` → `elst`.
///
/// Only the first entry that plays media is read. An empty edit (`media_time`
/// of −1, which delays the track rather than trimming it) is skipped rather
/// than treated as a trim, and a track with nothing but empty edits reads as
/// no trim at all — this is a correction for encoder priming, not a general
/// implementation of edit lists.
fn edit_list_start(edts: &[u8]) -> Option<u64> {
    let mut pos = 0;
    while let Some(b) = next_box(edts, &mut pos) {
        if b.kind != b"elst" {
            continue;
        }
        let version = *b.payload.first()?;
        let count = read_u32(b.payload, 4)? as usize;
        for i in 0..count {
            let media_time = if version == 0 {
                let at = 8 + i * 12;
                i64::from(read_u32(b.payload, at + 4)? as i32)
            } else {
                let at = 8 + i * 20;
                read_u64(b.payload, at + 8)? as i64
            };
            if media_time >= 0 {
                return u64::try_from(media_time).ok();
            }
        }
        return Some(0);
    }
    None
}

/// The facts a track has to supply, collected in one pass so that the order the
/// writer chose for them does not matter.
fn parse_mdia(mdia: &[u8]) -> Option<AudioExtractionPlan> {
    let mut timescale = None;
    let mut is_audio = false;
    let mut tables = None;

    let mut pos = 0;
    while let Some(b) = next_box(mdia, &mut pos) {
        match b.kind {
            b"mdhd" => timescale = mdhd_timescale(b.payload),
            b"hdlr" => is_audio = handler_type(b.payload) == Some(*b"soun"),
            b"minf" => tables = sample_tables(b.payload),
            _ => {}
        }
    }

    if !is_audio {
        return None;
    }
    let tables = tables?;
    let ranges = build_ranges(&tables)?;

    Some(AudioExtractionPlan {
        codec: classify_stsd(&tables.stsd),
        ranges,
        // A missing `mdhd` is not fatal on its own: WAV wrapping never needs the
        // timescale, and the `m4a` route refuses a zero one anyway.
        timescale: timescale.unwrap_or(0),
        stts: tables.stts,
        stsd: tables.stsd,
        // Filled in by `parse_trak`, which can see the track's `edts`.
        edit_start: 0,
    })
}

/// `mdhd` timescale. Version 1 widens the two timestamps ahead of it to 64 bits.
fn mdhd_timescale(payload: &[u8]) -> Option<u32> {
    match *payload.first()? {
        0 => read_u32(payload, 4 + 4 + 4),
        1 => read_u32(payload, 4 + 8 + 8),
        _ => None,
    }
}

/// `hdlr` handler type — `soun` for an audio track.
fn handler_type(payload: &[u8]) -> Option<[u8; 4]> {
    // version/flags (4) + pre_defined (4), then the four-character type.
    payload.get(8..12)?.try_into().ok()
}

/// The `stbl` boxes this module reads.
struct SampleTables {
    /// The whole `stsd` box, header included.
    stsd: Vec<u8>,
    stts: Vec<(u32, u32)>,
    /// `(first_chunk, samples_per_chunk)` runs.
    stsc: Vec<(u32, u32)>,
    /// One entry per sample (the uniform form is expanded here).
    sizes: Vec<u32>,
    /// Chunk offsets from `stco` (32-bit) or `co64` (64-bit).
    offsets: Vec<u64>,
}

/// `minf` → `stbl` → the sample table.
///
/// `None` when a box the extraction depends on is missing: without the sample
/// sizes or the chunk offsets there is nothing to point at, and without the
/// `stsd` the codec is unknown.
fn sample_tables(minf: &[u8]) -> Option<SampleTables> {
    let mut pos = 0;
    while let Some(b) = next_box(minf, &mut pos) {
        if b.kind == b"stbl" {
            return parse_stbl(b.payload);
        }
    }
    None
}

fn parse_stbl(stbl: &[u8]) -> Option<SampleTables> {
    let mut stsd = None;
    let mut stts = Vec::new();
    let mut stsc = None;
    let mut sizes = None;
    let mut offsets = None;

    let mut pos = 0;
    while let Some(b) = next_box(stbl, &mut pos) {
        match b.kind {
            b"stsd" => stsd = Some(b.whole.to_vec()),
            b"stts" => stts = parse_runs(b.payload).unwrap_or_default(),
            b"stsc" => stsc = parse_stsc(b.payload),
            b"stsz" => sizes = parse_stsz(b.payload),
            b"stco" => offsets = parse_stco(b.payload),
            b"co64" => offsets = parse_co64(b.payload),
            _ => {}
        }
    }

    Some(SampleTables {
        stsd: stsd?,
        stts,
        stsc: stsc?,
        sizes: sizes?,
        offsets: offsets?,
    })
}

/// `(count, delta)` pairs — the shape of `stts`.
///
/// No `with_capacity`: the declared count is file-controlled, while the reads
/// below stop at the end of the payload the file actually carries.
fn parse_runs(payload: &[u8]) -> Option<Vec<(u32, u32)>> {
    let declared = read_u32(payload, 4)? as usize;
    let mut entries = Vec::new();
    for i in 0..declared {
        let at = 8 + i * 8;
        entries.push((read_u32(payload, at)?, read_u32(payload, at + 4)?));
    }
    Some(entries)
}

/// `stsc` — `(first_chunk, samples_per_chunk)`, dropping the sample description
/// index (this module only ever reads the first description).
fn parse_stsc(payload: &[u8]) -> Option<Vec<(u32, u32)>> {
    let declared = read_u32(payload, 4)? as usize;
    let mut entries = Vec::new();
    for i in 0..declared {
        let at = 8 + i * 12;
        entries.push((read_u32(payload, at)?, read_u32(payload, at + 4)?));
    }
    if entries.is_empty() {
        return None;
    }
    Some(entries)
}

/// `stsz` — either one size for every sample, or a size per sample.
fn parse_stsz(payload: &[u8]) -> Option<Vec<u32>> {
    let uniform = read_u32(payload, 4)?;
    let count = read_u32(payload, 8)? as usize;
    if count == 0 || count > MAX_SAMPLES {
        return None;
    }

    if uniform != 0 {
        return Some(vec![uniform; count]);
    }
    let mut sizes = Vec::new();
    for i in 0..count {
        sizes.push(read_u32(payload, 12 + i * 4)?);
    }
    Some(sizes)
}

fn parse_stco(payload: &[u8]) -> Option<Vec<u64>> {
    let declared = read_u32(payload, 4)? as usize;
    let mut offsets = Vec::new();
    for i in 0..declared {
        offsets.push(u64::from(read_u32(payload, 8 + i * 4)?));
    }
    Some(offsets)
}

fn parse_co64(payload: &[u8]) -> Option<Vec<u64>> {
    let declared = read_u32(payload, 4)? as usize;
    let mut offsets = Vec::new();
    for i in 0..declared {
        offsets.push(read_u64(payload, 8 + i * 8)?);
    }
    Some(offsets)
}

/// Sample sizes × chunk layout → one byte range per sample.
///
/// `stsc` is run-length over *chunks*: an entry applies from its `first_chunk`
/// until the next entry starts, and the last entry applies to every remaining
/// chunk. Within a chunk the samples are contiguous, so the offsets accumulate
/// from the chunk offset.
///
/// `None` when the tables contradict each other — most often too few chunks for
/// the samples the `stsz` promises, which means the file is not laid out the way
/// it says it is and no byte range can be trusted.
fn build_ranges(tables: &SampleTables) -> Option<Vec<SampleRange>> {
    let total = tables.sizes.len();
    let mut ranges = Vec::with_capacity(total);
    let mut sample = 0usize;

    for (index, &chunk_offset) in tables.offsets.iter().enumerate() {
        if sample >= total {
            break;
        }
        let chunk_no = u32::try_from(index).ok()?.checked_add(1)?;
        let per_chunk = tables
            .stsc
            .iter()
            .take_while(|(first, _)| *first <= chunk_no)
            .last()
            .map(|(_, per)| *per)?;

        let mut at = chunk_offset;
        for _ in 0..per_chunk {
            if sample >= total {
                break;
            }
            let size = tables.sizes[sample];
            ranges.push(SampleRange { offset: at, size });
            at = at.checked_add(u64::from(size))?;
            sample += 1;
        }
    }

    if sample != total {
        return None;
    }
    Some(ranges)
}

// ---------------------------------------------------------------------------
// stsd → codec
// ---------------------------------------------------------------------------

/// Classify the first sample description of the (whole) `stsd` box.
fn classify_stsd(stsd: &[u8]) -> AudioCodec {
    // Box header (8) + version/flags (4) + entry_count (4), then the entries.
    let payload = match stsd.get(8..) {
        Some(payload) => payload,
        None => return AudioCodec::Unsupported,
    };
    if read_u32(payload, 4).unwrap_or(0) == 0 {
        return AudioCodec::Unsupported;
    }

    let mut pos = 8;
    match next_box(payload, &mut pos) {
        Some(entry) => classify_entry(entry.kind, entry.payload),
        None => AudioCodec::Unsupported,
    }
}

fn classify_entry(kind: &[u8], body: &[u8]) -> AudioCodec {
    match kind {
        b"mp4a" => AudioCodec::Aac,
        b"alac" => AudioCodec::Alac,
        // `sowt` / `twos` *are* the endianness; the description does not repeat
        // it.
        b"sowt" => pcm_entry(body, Some(false)),
        b"twos" => pcm_entry(body, Some(true)),
        // `lpcm` describes itself in `formatSpecificFlags`.
        b"lpcm" => pcm_entry(body, None),
        _ => AudioCodec::Unsupported,
    }
}

/// Read a sound sample description and decide whether its PCM can be wrapped.
///
/// Version 0 and 1 keep the classic QuickTime fields (16-bit channel count and
/// sample size, a 16.16 fixed-point rate); version 2 replaces them with a
/// self-describing block (a `Float64` rate, 32-bit widths and the CoreAudio
/// format flags) and is what `lpcm` always uses.
fn pcm_entry(body: &[u8], endianness: Option<bool>) -> AudioCodec {
    let version = match read_u16(body, 8) {
        Some(version) => version,
        None => return AudioCodec::Unsupported,
    };

    if version >= 2 {
        let (rate, channels, bits, flags) = match (
            read_u64(body, 32),
            read_u32(body, 40),
            read_u32(body, 48),
            read_u32(body, 52),
        ) {
            (Some(rate), Some(channels), Some(bits), Some(flags)) => (rate, channels, bits, flags),
            _ => return AudioCodec::Unsupported,
        };
        if flags & LPCM_FLAG_NON_INTERLEAVED != 0 {
            // Planar PCM would have to be interleaved before it could be wrapped
            // — out of scope for v1 (契約③(b)).
            return AudioCodec::Unsupported;
        }
        // A `Float64` straight out of the file: NaN and the infinities have to
        // be shown the door before the cast.
        let rate = f64::from_bits(rate);
        if !rate.is_finite() || rate <= 0.0 || rate > f64::from(u32::MAX) {
            return AudioCodec::Unsupported;
        }
        return pcm_codec(
            rate.round() as u32,
            channels,
            bits,
            endianness.unwrap_or(flags & LPCM_FLAG_BIG_ENDIAN != 0),
            flags & LPCM_FLAG_FLOAT != 0,
        );
    }

    let (channels, bits, rate) = match (read_u16(body, 16), read_u16(body, 18), read_u32(body, 24)) {
        (Some(channels), Some(bits), Some(rate)) => (channels, bits, rate),
        _ => return AudioCodec::Unsupported,
    };
    pcm_codec(
        // The rate is 16.16 fixed point; the fractional part is never used in
        // practice (and cannot hold 48 kHz's neighbours anyway).
        rate >> 16,
        u32::from(channels),
        u32::from(bits),
        endianness.unwrap_or(false),
        false,
    )
}

/// The supported PCM shapes (契約③(b)): integer 16/24-bit either endianness,
/// and interleaved little-endian float32. Everything else is a track we can see
/// but not wrap.
fn pcm_codec(sample_rate: u32, channels: u32, bits: u32, big_endian: bool, float: bool) -> AudioCodec {
    let usable = if float {
        bits == 32 && !big_endian
    } else {
        bits == 16 || bits == 24
    };
    if !usable || sample_rate == 0 || channels == 0 || channels > u32::from(u16::MAX) {
        return AudioCodec::Unsupported;
    }
    AudioCodec::Pcm {
        sample_rate,
        channels: channels as u16,
        bits_per_sample: bits as u16,
        big_endian,
        float,
    }
}

// ---------------------------------------------------------------------------
// stsd → the MP4 spelling of the same sample description
// ---------------------------------------------------------------------------

/// Rewrite a QuickTime sound sample description into the MP4 form, or `None`
/// when it is not one this can restate.
///
/// QuickTime and MP4 spell the same AAC or ALAC track differently: a `.mov`
/// writes a version 1 sound description and buries the decoder configuration in
/// a `wave` box (`frma` + the codec's own box), while a `.m4a` writes a version
/// 0 description with the `esds` / `alac` box as a direct child. Both are legal
/// where they belong — but **AudioToolbox refuses the QuickTime spelling inside
/// an `M4A ` file**, so a verbatim copy of a `.mov`'s `stsd` produces a file
/// that ffmpeg reads happily and macOS will not open at all (measured
/// 2026-09-01 with `afinfo`, on AAC and ALAC alike). Since decoding here is
/// AudioToolbox's job by way of the WebView, the description has to be restated.
///
/// Nothing about the audio changes: the channel count, sample size and rate are
/// copied across and the codec configuration box is moved, not rewritten — the
/// samples are still the original bytes, described the same way in a different
/// dialect. `wave`'s other children (`frma`, `chan`, the terminator) are dropped
/// because the MP4 form does not carry them.
///
/// The caller decides whether to use the result: `remux_m4a` embeds whatever
/// `stsd` it is handed, verbatim (契約=acceptance_req41.rs).
pub fn normalize_sound_description(stsd: &[u8]) -> Option<Vec<u8>> {
    // Box header (8) + version/flags (4) + entry_count (4), then the entries.
    let payload = stsd.get(8..)?;
    if read_u32(payload, 4)? == 0 {
        return None;
    }
    let mut pos = 8;
    let entry = next_box(payload, &mut pos)?;
    let kind: [u8; 4] = entry.kind.try_into().ok()?;
    let body = entry.payload;

    // Only the two compressed codecs travel this route; PCM is wrapped as WAV
    // and never sees an `stsd` again.
    let config_kind: &[u8; 4] = match &kind {
        b"mp4a" => b"esds",
        b"alac" => b"alac",
        _ => return None,
    };

    let version = read_u16(body, 8)?;
    let channels = read_u16(body, 16)?;
    let sample_size = read_u16(body, 18)?;
    let sample_rate = read_u32(body, 24)?;
    // Version 1 adds four 32-bit fields (samples/bytes per packet and frame)
    // ahead of the children; version 2 replaces the layout wholesale and is not
    // used for compressed audio.
    let children_at = match version {
        0 => 28,
        1 => 28 + 16,
        _ => return None,
    };
    let config = find_codec_config(body.get(children_at..)?, config_kind)?;

    let mut rebuilt = vec![0u8; 6]; // reserved
    rebuilt.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    rebuilt.extend_from_slice(&0u16.to_be_bytes()); // version 0
    rebuilt.extend_from_slice(&0u16.to_be_bytes()); // revision
    rebuilt.extend_from_slice(&[0u8; 4]); // vendor
    rebuilt.extend_from_slice(&channels.to_be_bytes());
    rebuilt.extend_from_slice(&sample_size.to_be_bytes());
    rebuilt.extend_from_slice(&0u16.to_be_bytes()); // compression_id
    rebuilt.extend_from_slice(&0u16.to_be_bytes()); // packet_size
    rebuilt.extend_from_slice(&sample_rate.to_be_bytes()); // 16.16
    rebuilt.extend_from_slice(&config);

    let mut stsd_payload = vec![0u8; 4]; // version / flags
    stsd_payload.extend_from_slice(&1u32.to_be_bytes()); // entry_count
    stsd_payload.extend_from_slice(&mp4_box(&kind, &rebuilt));
    Some(mp4_box(b"stsd", &stsd_payload))
}

/// The codec configuration box among a sample description's children, looking
/// inside `wave` (where QuickTime keeps it) as well as beside it.
fn find_codec_config(children: &[u8], kind: &[u8; 4]) -> Option<Vec<u8>> {
    let mut pos = 0;
    let mut wave: Option<&[u8]> = None;
    while let Some(child) = next_box(children, &mut pos) {
        if child.kind == kind {
            return Some(child.whole.to_vec());
        }
        if child.kind == b"wave" {
            wave = Some(child.payload);
        }
    }

    let wave = wave?;
    let mut pos = 0;
    while let Some(child) = next_box(wave, &mut pos) {
        if child.kind == kind {
            return Some(child.whole.to_vec());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// m4a re-wrap (AAC / ALAC)
// ---------------------------------------------------------------------------

/// Re-wrap compressed samples into a minimal `m4a`, without touching a byte of
/// the audio itself.
///
/// The output is `ftyp` + `mdat` + `moov`: one audio track whose `stsd` is the
/// *original* box, embedded verbatim, so the decoder configuration (AAC's
/// `esds`, ALAC's magic cookie) travels with the samples and nothing here has to
/// understand either codec. The `stts` runs are carried over unchanged — that is
/// what makes the decoded audio line up sample for sample with the original,
/// which raw ADTS could not do (see the module comment).
///
/// All samples go into a single chunk, so the sample table is three short boxes
/// and `stco` holds one offset. Putting `mdat` *before* `moov` is what makes
/// that offset knowable in one pass — and it is also what lets `with_edit_list`
/// grow the `moov` afterwards without invalidating it. The movie is read from an
/// `ArrayBuffer` already in memory, so there is nothing to gain by putting the
/// index first.
///
/// `None` when the input cannot make a valid file: no samples, `stts` runs that
/// do not add up to them, no timescale to time them with, or more bytes than a
/// 32-bit box can address (the 256 MiB ceiling upstream keeps that out of
/// reach).
pub fn remux_m4a(
    stsd: &[u8],
    samples: &[&[u8]],
    timescale: u32,
    stts: &[(u32, u32)],
) -> Option<Vec<u8>> {
    if samples.is_empty() || timescale == 0 {
        return None;
    }
    let declared: u64 = stts.iter().map(|(count, _)| u64::from(*count)).sum();
    if declared != samples.len() as u64 {
        return None;
    }

    let media_bytes: u64 = samples.iter().map(|s| s.len() as u64).sum();
    let duration: u64 = stts
        .iter()
        .map(|(count, delta)| u64::from(*count) * u64::from(*delta))
        .sum();
    let duration = u32::try_from(duration).ok()?;
    let sample_count = u32::try_from(samples.len()).ok()?;
    let sizes: Vec<u32> = samples.iter().map(|s| s.len() as u32).collect();

    let ftyp = mp4_box(b"ftyp", b"M4A \x00\x00\x02\x00M4A mp42isom");
    // The samples start right after `ftyp` and `mdat`'s own header.
    let chunk_offset = u64::try_from(ftyp.len()).ok()? + 8;
    if chunk_offset.checked_add(media_bytes)? > u64::from(u32::MAX) {
        return None;
    }
    let moov = build_moov(
        stsd,
        timescale,
        duration,
        sample_count,
        stts,
        &sizes,
        chunk_offset as u32,
    )?;

    let mut out = Vec::with_capacity(ftyp.len() + moov.len() + 8 + media_bytes as usize);
    out.extend_from_slice(&ftyp);
    out.extend_from_slice(&((media_bytes as u32) + 8).to_be_bytes());
    out.extend_from_slice(b"mdat");
    for sample in samples {
        out.extend_from_slice(sample);
    }
    out.extend_from_slice(&moov);
    Some(out)
}

#[allow(clippy::too_many_arguments)]
fn build_moov(
    stsd: &[u8],
    timescale: u32,
    duration: u32,
    sample_count: u32,
    stts: &[(u32, u32)],
    sizes: &[u32],
    chunk_offset: u32,
) -> Option<Vec<u8>> {
    let stbl = container(
        b"stbl",
        &[
            stsd,
            &stts_box(stts),
            // One chunk holding every sample: chunk 1, `sample_count` samples,
            // sample description 1.
            &stsc_box(sample_count),
            &stsz_box(sizes),
            &stco_box(chunk_offset),
        ],
    );
    let minf = container(b"minf", &[&smhd_box(), &dinf_box(), &stbl]);
    let mdia = container(
        b"mdia",
        &[&mdhd_box(timescale, duration), &hdlr_box(), &minf],
    );
    let trak = container(b"trak", &[&tkhd_box(duration), &mdia]);
    Some(container(b"moov", &[&mvhd_box(timescale, duration), &trak]))
}

fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.extend_from_slice(&((payload.len() as u32) + 8).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

fn container(kind: &[u8; 4], children: &[&[u8]]) -> Vec<u8> {
    let mut payload = Vec::new();
    for child in children {
        payload.extend_from_slice(child);
    }
    mp4_box(kind, &payload)
}

/// The 3×3 unity transform every track that is not being rotated carries.
const UNITY_MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

fn push_matrix(payload: &mut Vec<u8>) {
    for value in UNITY_MATRIX {
        payload.extend_from_slice(&value.to_be_bytes());
    }
}

fn mvhd_box(timescale: u32, duration: u32) -> Vec<u8> {
    let mut p = vec![0u8; 4]; // version 0 / flags
    p.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    p.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    p.extend_from_slice(&timescale.to_be_bytes());
    p.extend_from_slice(&duration.to_be_bytes());
    p.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // rate 1.0
    p.extend_from_slice(&0x0100u16.to_be_bytes()); // volume 1.0
    p.extend_from_slice(&0u16.to_be_bytes()); // reserved
    p.extend_from_slice(&[0u8; 8]); // reserved
    push_matrix(&mut p);
    p.extend_from_slice(&[0u8; 24]); // pre_defined
    p.extend_from_slice(&2u32.to_be_bytes()); // next_track_ID
    mp4_box(b"mvhd", &p)
}

fn tkhd_box(duration: u32) -> Vec<u8> {
    // Flags 0x7 = enabled | in movie | in preview.
    let mut p = vec![0u8, 0, 0, 0x07];
    p.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    p.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    p.extend_from_slice(&1u32.to_be_bytes()); // track_ID
    p.extend_from_slice(&0u32.to_be_bytes()); // reserved
    p.extend_from_slice(&duration.to_be_bytes());
    p.extend_from_slice(&[0u8; 8]); // reserved
    p.extend_from_slice(&0u16.to_be_bytes()); // layer
    p.extend_from_slice(&0u16.to_be_bytes()); // alternate_group
    p.extend_from_slice(&0x0100u16.to_be_bytes()); // volume 1.0 (audio track)
    p.extend_from_slice(&0u16.to_be_bytes()); // reserved
    push_matrix(&mut p);
    p.extend_from_slice(&0u32.to_be_bytes()); // width
    p.extend_from_slice(&0u32.to_be_bytes()); // height
    mp4_box(b"tkhd", &p)
}

fn mdhd_box(timescale: u32, duration: u32) -> Vec<u8> {
    let mut p = vec![0u8; 4]; // version 0 / flags
    p.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    p.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    p.extend_from_slice(&timescale.to_be_bytes());
    p.extend_from_slice(&duration.to_be_bytes());
    p.extend_from_slice(&0x55c4u16.to_be_bytes()); // language "und"
    p.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    mp4_box(b"mdhd", &p)
}

fn hdlr_box() -> Vec<u8> {
    let mut p = vec![0u8; 4]; // version / flags
    p.extend_from_slice(&0u32.to_be_bytes()); // pre_defined
    p.extend_from_slice(b"soun");
    p.extend_from_slice(&[0u8; 12]); // reserved
    p.extend_from_slice(b"SoundHandler\0");
    mp4_box(b"hdlr", &p)
}

fn smhd_box() -> Vec<u8> {
    let mut p = vec![0u8; 4]; // version / flags
    p.extend_from_slice(&0u16.to_be_bytes()); // balance
    p.extend_from_slice(&0u16.to_be_bytes()); // reserved
    mp4_box(b"smhd", &p)
}

/// `dinf` → `dref` → one self-contained `url ` entry (flag 1 = the media lives
/// in this same file), which is what a self-contained movie always writes.
fn dinf_box() -> Vec<u8> {
    let url = mp4_box(b"url ", &[0u8, 0, 0, 0x01]);
    let mut dref_payload = vec![0u8; 4]; // version / flags
    dref_payload.extend_from_slice(&1u32.to_be_bytes()); // entry_count
    dref_payload.extend_from_slice(&url);
    container(b"dinf", &[&mp4_box(b"dref", &dref_payload)])
}

fn stts_box(runs: &[(u32, u32)]) -> Vec<u8> {
    let mut p = vec![0u8; 4]; // version / flags
    p.extend_from_slice(&(runs.len() as u32).to_be_bytes());
    for (count, delta) in runs {
        p.extend_from_slice(&count.to_be_bytes());
        p.extend_from_slice(&delta.to_be_bytes());
    }
    mp4_box(b"stts", &p)
}

fn stsc_box(sample_count: u32) -> Vec<u8> {
    let mut p = vec![0u8; 4]; // version / flags
    p.extend_from_slice(&1u32.to_be_bytes()); // entry_count
    p.extend_from_slice(&1u32.to_be_bytes()); // first_chunk
    p.extend_from_slice(&sample_count.to_be_bytes()); // samples_per_chunk
    p.extend_from_slice(&1u32.to_be_bytes()); // sample_description_index
    mp4_box(b"stsc", &p)
}

fn stsz_box(sizes: &[u32]) -> Vec<u8> {
    let mut p = vec![0u8; 4]; // version / flags
    p.extend_from_slice(&0u32.to_be_bytes()); // sample_size 0 = per-sample
    p.extend_from_slice(&(sizes.len() as u32).to_be_bytes());
    for size in sizes {
        p.extend_from_slice(&size.to_be_bytes());
    }
    mp4_box(b"stsz", &p)
}

fn stco_box(offset: u32) -> Vec<u8> {
    let mut p = vec![0u8; 4]; // version / flags
    p.extend_from_slice(&1u32.to_be_bytes()); // entry_count
    p.extend_from_slice(&offset.to_be_bytes());
    mp4_box(b"stco", &p)
}

/// Give a file from `remux_m4a` an edit list that skips the first `edit_start`
/// of media time, or `None` when it cannot be done.
///
/// This is how encoder priming stops being audible in the waveform. The samples
/// of an AAC track begin with silence the encoder added (`AudioExtractionPlan::
/// edit_start`, from the source movie's own edit list), and a decoder plays it
/// unless the file says where the real audio starts — leaving the waveform
/// 23–48 ms behind the picture by an encoder-dependent amount. Restating the
/// trim puts the two back on the same clock.
///
/// Only the shape `remux_m4a` writes is understood: `ftyp`, `mdat`, then `moov`
/// last. That order is the point — the `moov` grows by the edit list, and
/// nothing that grows sits in front of the samples, so `stco` still points where
/// it did. Callers treat `None` as "leave the file alone": an m4a a few
/// milliseconds late is worth far more than no waveform at all (fail-open).
pub fn with_edit_list(m4a: &[u8], edit_start: u64) -> Option<Vec<u8>> {
    // Media time is a signed 32-bit field in a version 0 edit list, and priming
    // is a few thousand samples — anything larger is not what this corrects.
    let media_time = u32::try_from(edit_start).ok()?;
    if media_time > i32::MAX as u32 {
        return None;
    }

    let mut pos = 0;
    let mut prefix_end = 0;
    let mut moov = None;
    while let Some(b) = next_box(m4a, &mut pos) {
        if b.kind == b"moov" {
            moov = Some(b.payload);
            break;
        }
        prefix_end = pos;
    }
    // `moov` last, and nothing after it: any other layout is not ours to edit.
    let moov = moov?;
    if pos != m4a.len() {
        return None;
    }

    let mut duration = None;
    let mut children: Vec<Vec<u8>> = Vec::new();
    let mut inner = 0;
    while let Some(b) = next_box(moov, &mut inner) {
        match b.kind {
            // version/flags (4) + creation (4) + modification (4) +
            // timescale (4), then the duration this track is presented for.
            b"mvhd" => {
                duration = read_u32(b.payload, 16);
                children.push(b.whole.to_vec());
            }
            b"trak" => children.push(trak_with_edit_list(b.payload, media_time, duration?)?),
            _ => children.push(b.whole.to_vec()),
        }
    }

    let refs: Vec<&[u8]> = children.iter().map(|c| c.as_slice()).collect();
    let mut out = Vec::with_capacity(m4a.len() + 40);
    out.extend_from_slice(m4a.get(..prefix_end)?);
    out.extend_from_slice(&container(b"moov", &refs));
    Some(out)
}

/// The same track with an `edts` between its `tkhd` and its `mdia` (the order
/// ISO BMFF gives them).
fn trak_with_edit_list(trak: &[u8], media_time: u32, duration: u32) -> Option<Vec<u8>> {
    // The segment plays what is left after the trim. `remux_m4a` gives the movie
    // the same timescale as the media, so the two durations are in one unit.
    let segment = duration.checked_sub(media_time)?;
    if segment == 0 {
        return None;
    }

    let mut elst = vec![0u8; 4]; // version 0 / flags
    elst.extend_from_slice(&1u32.to_be_bytes()); // entry_count
    elst.extend_from_slice(&segment.to_be_bytes());
    elst.extend_from_slice(&media_time.to_be_bytes());
    elst.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // media_rate 1.0
    let edts = container(b"edts", &[&mp4_box(b"elst", &elst)]);

    let mut children: Vec<Vec<u8>> = Vec::new();
    let mut inserted = false;
    let mut pos = 0;
    while let Some(b) = next_box(trak, &mut pos) {
        children.push(b.whole.to_vec());
        if b.kind == b"tkhd" {
            children.push(edts.clone());
            inserted = true;
        }
    }
    if !inserted {
        return None;
    }

    let refs: Vec<&[u8]> = children.iter().map(|c| c.as_slice()).collect();
    Some(container(b"trak", &refs))
}

// ---------------------------------------------------------------------------
// PCM → WAV
// ---------------------------------------------------------------------------

/// Swap 16-bit big-endian PCM (`twos`) into the little-endian order WAV wants.
///
/// `None` for an odd length — half a sample means the byte range is not what it
/// claims to be, and silently dropping the tail would shift every sample after
/// it.
pub fn pcm16_be_to_le(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(data.len());
    for pair in data.chunks_exact(2) {
        out.push(pair[1]);
        out.push(pair[0]);
    }
    Some(out)
}

/// Integer PCM (little-endian) in a 44-byte canonical WAV header.
pub fn wrap_wav(pcm: &[u8], channels: u16, sample_rate: u32, bits_per_sample: u16) -> Vec<u8> {
    wrap_wav_format(pcm, 1, channels, sample_rate, bits_per_sample)
}

/// Float32 PCM (little-endian) in a WAV header, tagged IEEE float (format 3) —
/// the wrapper for `lpcm` tracks whose samples are already floats.
pub fn wrap_wav_float32(pcm: &[u8], channels: u16, sample_rate: u32) -> Vec<u8> {
    wrap_wav_format(pcm, 3, channels, sample_rate, 32)
}

fn wrap_wav_format(
    pcm: &[u8],
    format: u16,
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
) -> Vec<u8> {
    let block_align = u32::from(channels) * (u32::from(bits_per_sample) / 8);
    let byte_rate = sample_rate.saturating_mul(block_align);
    let data_len = pcm.len() as u32;

    let mut out = Vec::with_capacity(pcm.len() + 44);
    out.extend_from_slice(b"RIFF");
    // Everything after this field: 36 bytes of header plus the samples.
    out.extend_from_slice(&(36u32.saturating_add(data_len)).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk length
    out.extend_from_slice(&format.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&(block_align as u16).to_le_bytes());
    out.extend_from_slice(&bits_per_sample.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}
