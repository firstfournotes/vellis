//! Requirement #91 (docs/requirements/req-91.md) — the wav source of the spectrum (contract 3 / 9 / 10; the judgement
//! record "wav gets its own seam, the Rust side brings it down to 32 kHz / 16 bit").
//!
//! `extract_waveform_audio` answers a `.wav` URI with a 16-bit PCM WAV at 32 kHz built by `vellis_lib::wav_spectrum::SpectrumWav`
//! from the file's `data` chunk (read in pieces). This file drives `SpectrumWav` directly with synthesised wav data (the
//! command around it only resolves the URI and reads ranges — the same split as acceptance_req50.rs for the waveform) and
//! fixes what the implementer verified by hand:
//!  - the level of a 1 kHz tone is kept (48 kHz and 44.1 kHz sources), a 10 kHz tone too (still inside the pass band)
//!  - a 20 kHz tone of a 48 kHz source does not fold back below 16 kHz (no false peak at 12 kHz; the output is near silence)
//!  - the output does not depend on how the `data` chunk is cut into pushes
//!  - stereo keeps L / R apart; three or more channels are averaged into one lane
//!  - a source at or below 32 kHz keeps its own rate (and its samples, within a 16-bit rounding step)
//!  - a file shorter than the filter (a few frames) and a file shorter than it declared come back whole
//!  - the WAV header is right (RIFF / WAVE / fmt PCM / channels / rate / byte rate / block align / 16 bit / data size)
//!  - the waveform's own wav route (`analyze_wav_bytes`, 8 kHz envelope) is untouched — contract 9
//!  - a source whose output a WAV header cannot describe is refused with "too-large"; a broken format with "unreadable"
//!
//! Public surface used (all `pub` today): `wav_spectrum::{SpectrumWav::{new, push, finish, out_rate}, SPECTRUM_RATE, TOO_LARGE}`,
//! `wav_waveform::{parse_fmt, WavFormat, analyze_wav_bytes, WAV_WAVEFORM_MAX_RETAINED_SAMPLES}`.
//!
//! Tones are measured with Goertzel's algorithm over the middle of the output (the filter's edges are left out), so no
//! dependency is needed. Red before the implementation: `vellis_lib::wav_spectrum` does not exist (compile error).

use vellis_lib::wav_spectrum::{SpectrumWav, SPECTRUM_RATE, TOO_LARGE};
use vellis_lib::wav_waveform::{analyze_wav_bytes, parse_fmt, WavFormat, WAV_WAVEFORM_MAX_RETAINED_SAMPLES};

// ---------------------------------------------------------------------------
// fixtures — minimal RIFF pieces (the house style of acceptance_req50.rs)
// ---------------------------------------------------------------------------

fn fmt_payload(channels: u16, rate: u32, bits: u16) -> Vec<u8> {
    let block_align = channels * (bits / 8);
    let mut p = Vec::with_capacity(16);
    p.extend_from_slice(&1u16.to_le_bytes());
    p.extend_from_slice(&channels.to_le_bytes());
    p.extend_from_slice(&rate.to_le_bytes());
    p.extend_from_slice(&(rate * u32::from(block_align)).to_le_bytes());
    p.extend_from_slice(&block_align.to_le_bytes());
    p.extend_from_slice(&bits.to_le_bytes());
    p
}

fn format(channels: u16, rate: u32) -> WavFormat {
    parse_fmt(&fmt_payload(channels, rate, 16)).expect("a plain 16-bit PCM fmt parses")
}

fn chunk(id: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut c = Vec::with_capacity(8 + payload.len() + 1);
    c.extend_from_slice(id);
    c.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    c.extend_from_slice(payload);
    if payload.len() % 2 == 1 {
        c.push(0);
    }
    c
}

/// A whole wav file (RIFF / WAVE / fmt / data) for the waveform's route.
fn wav_file(channels: u16, rate: u32, data: &[u8]) -> Vec<u8> {
    let mut body: Vec<u8> = b"WAVE".to_vec();
    body.extend_from_slice(&chunk(b"fmt ", &fmt_payload(channels, rate, 16)));
    body.extend_from_slice(&chunk(b"data", data));
    let mut file = Vec::with_capacity(8 + body.len());
    file.extend_from_slice(b"RIFF");
    file.extend_from_slice(&(body.len() as u32).to_le_bytes());
    file.extend_from_slice(&body);
    file
}

fn pcm16(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

/// `frames` samples of a sine of `hz` with amplitude `amp` (0..1) at `rate`, as 16-bit PCM values.
fn sine(hz: f64, amp: f64, rate: u32, frames: usize) -> Vec<i16> {
    (0..frames)
        .map(|n| (amp * (2.0 * std::f64::consts::PI * hz * n as f64 / f64::from(rate)).sin() * 32_767.0).round() as i16)
        .collect()
}

fn interleave(lanes: &[Vec<i16>]) -> Vec<i16> {
    let frames = lanes[0].len();
    let mut out = Vec::with_capacity(frames * lanes.len());
    for i in 0..frames {
        for lane in lanes {
            out.push(lane[i]);
        }
    }
    out
}

/// Run `SpectrumWav` over `data` (interleaved 16-bit PCM) pushed in pieces of `chunk_len` bytes.
fn convert(channels: u16, rate: u32, data: &[u8], chunk_len: usize) -> Vec<u8> {
    let f = format(channels, rate);
    let frames = (data.len() / f.bytes_per_frame()) as u64;
    let mut wav = SpectrumWav::new(f, frames).expect("SpectrumWav::new");
    for piece in data.chunks(chunk_len.max(1)) {
        wav.push(piece);
    }
    wav.finish()
}

// ---------------------------------------------------------------------------
// reading the output
// ---------------------------------------------------------------------------

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

struct Header {
    channels: u16,
    rate: u32,
    byte_rate: u32,
    block_align: u16,
    bits: u16,
    data_bytes: u32,
}

/// The canonical 44-byte header the module writes (fmt of 16 bytes, then data).
fn header(out: &[u8]) -> Header {
    assert!(out.len() >= 44, "a WAV needs the 44-byte header (got {} bytes)", out.len());
    assert_eq!(&out[0..4], b"RIFF");
    assert_eq!(&out[8..12], b"WAVE");
    assert_eq!(&out[12..16], b"fmt ");
    assert_eq!(u32_at(out, 16), 16, "fmt payload of 16 bytes");
    assert_eq!(u16_at(out, 20), 1, "PCM");
    assert_eq!(&out[36..40], b"data");
    Header {
        channels: u16_at(out, 22),
        rate: u32_at(out, 24),
        byte_rate: u32_at(out, 28),
        block_align: u16_at(out, 32),
        bits: u16_at(out, 34),
        data_bytes: u32_at(out, 40),
    }
}

/// The 16-bit samples of lane `lane` (0 = L) of the output, as -1..1.
fn lane_samples(out: &[u8], lane: usize) -> Vec<f64> {
    let h = header(out);
    let lanes = h.channels as usize;
    out[44..]
        .chunks_exact(2)
        .skip(lane)
        .step_by(lanes)
        .map(|b| f64::from(i16::from_le_bytes([b[0], b[1]])) / 32_768.0)
        .collect()
}

/// The amplitude (0..1) of the sine at `hz` in `samples` (Goertzel over the window), edges left out.
fn tone_amplitude(samples: &[f64], rate: u32, hz: f64) -> f64 {
    let margin = 400.min(samples.len() / 8);
    let window = &samples[margin..samples.len() - margin];
    let m = window.len() as f64;
    let w = 2.0 * std::f64::consts::PI * hz / f64::from(rate);
    let (mut re, mut im) = (0.0f64, 0.0f64);
    for (n, s) in window.iter().enumerate() {
        let t = w * n as f64;
        re += s * t.cos();
        im -= s * t.sin();
    }
    2.0 * (re * re + im * im).sqrt() / m
}

fn rms(samples: &[f64]) -> f64 {
    let margin = 400.min(samples.len() / 8);
    let window = &samples[margin..samples.len() - margin];
    (window.iter().map(|s| s * s).sum::<f64>() / window.len() as f64).sqrt()
}

fn ceil_div(a: u64, b: u64) -> u64 {
    a.div_ceil(b)
}

// ---------------------------------------------------------------------------
// the header (contract 3: 32 kHz / 16 bit / the lanes)
// ---------------------------------------------------------------------------

/// 1. A 48 kHz stereo source becomes a 32 kHz, 16-bit, 2-channel WAV whose header describes exactly the data written.
#[test]
fn header_describes_a_32khz_16bit_wav_with_two_lanes_for_stereo() {
    const FRAMES: usize = 48_000;
    let data = pcm16(&interleave(&[sine(1000.0, 0.5, 48_000, FRAMES), sine(5000.0, 0.5, 48_000, FRAMES)]));
    let out = convert(2, 48_000, &data, data.len());
    let h = header(&out);
    assert_eq!(h.channels, 2);
    assert_eq!(h.rate, SPECTRUM_RATE);
    assert_eq!(h.rate, 32_000);
    assert_eq!(h.bits, 16);
    assert_eq!(h.block_align, 4);
    assert_eq!(h.byte_rate, 32_000 * 4);
    let frames_out = ceil_div(FRAMES as u64 * 32_000, 48_000);
    assert_eq!(u64::from(h.data_bytes), frames_out * 4, "data size = ceil(frames * 32000 / rate) frames of 4 bytes");
    assert_eq!(out.len() as u64, 44 + u64::from(h.data_bytes), "the file is header + data, nothing else");
    assert_eq!(u32_at(&out, 4), 36 + h.data_bytes, "the RIFF size is 36 + data");
}

/// 2. Mono stays one lane; six channels (5.1) become one averaged lane.
#[test]
fn header_has_one_lane_for_mono_and_for_three_or_more_channels() {
    let mono = convert(1, 48_000, &pcm16(&sine(1000.0, 0.5, 48_000, 9_600)), 4096);
    assert_eq!(header(&mono).channels, 1);
    assert_eq!(header(&mono).block_align, 2);
    let six = interleave(&(0..6).map(|_| sine(1000.0, 0.1, 48_000, 9_600)).collect::<Vec<_>>());
    let out = convert(6, 48_000, &pcm16(&six), 4096);
    assert_eq!(header(&out).channels, 1);
    assert_eq!(header(&out).rate, 32_000);
}

// ---------------------------------------------------------------------------
// the level and the band (contract 3: what is drawn up to 16 kHz is the source's)
// ---------------------------------------------------------------------------

/// 3. A 1 kHz tone at -6 dBFS keeps its level through 48 kHz → 32 kHz and 44.1 kHz → 32 kHz (within 3 %).
#[test]
fn a_1khz_tone_keeps_its_level_after_resampling() {
    for rate in [48_000u32, 44_100] {
        let frames = rate as usize; // one second
        let input = sine(1000.0, 0.5, rate, frames);
        let out = convert(1, rate, &pcm16(&input), 8192);
        let lane = lane_samples(&out, 0);
        let got = tone_amplitude(&lane, 32_000, 1000.0);
        assert!((got - 0.5).abs() <= 0.015, "{rate} Hz source: the 1 kHz tone reads {got:.4}, expected 0.5 ± 0.015");
        // The input's own measurement is the reference: the ratio is 1 within 3 %.
        let reference = tone_amplitude(&input.iter().map(|s| f64::from(*s) / 32_768.0).collect::<Vec<_>>(), rate, 1000.0);
        assert!((got / reference - 1.0).abs() <= 0.03, "{rate} Hz: ratio {:.4}", got / reference);
    }
}

/// 4. A 10 kHz tone (inside the pass band of the low-pass) keeps its level too (within 5 %).
#[test]
fn a_10khz_tone_inside_the_band_keeps_its_level() {
    let out = convert(1, 48_000, &pcm16(&sine(10_000.0, 0.5, 48_000, 48_000)), 8192);
    let got = tone_amplitude(&lane_samples(&out, 0), 32_000, 10_000.0);
    assert!((got - 0.5).abs() <= 0.025, "the 10 kHz tone reads {got:.4}, expected 0.5 ± 0.025");
}

/// 5. A 20 kHz tone of a 48 kHz source (above the 16 kHz the band draws) does not fold back to 12 kHz: the alias is at
///    least 40 dB under the tone and the output is near silence (the low-pass removes it, about 60 dB).
#[test]
fn a_20khz_tone_does_not_alias_below_16khz() {
    let out = convert(1, 48_000, &pcm16(&sine(20_000.0, 0.5, 48_000, 48_000)), 8192);
    let lane = lane_samples(&out, 0);
    let alias = tone_amplitude(&lane, 32_000, 12_000.0);
    assert!(alias < 0.5 * 0.01, "a 20 kHz tone must not appear at 12 kHz after resampling (read {alias:.5}, limit 0.005 = -40 dB)");
    assert!(rms(&lane) < 0.005, "the output of a 20 kHz-only source is near silence (rms {:.5})", rms(&lane));
}

/// 6. The 20 kHz tone and a 1 kHz tone together: the 1 kHz level is kept, no alias of the 20 kHz tone shows at 12 kHz.
#[test]
fn a_mixture_keeps_the_in_band_tone_and_drops_the_out_of_band_one() {
    let a = sine(1000.0, 0.4, 48_000, 48_000);
    let b = sine(20_000.0, 0.4, 48_000, 48_000);
    let mixed: Vec<i16> = a.iter().zip(b.iter()).map(|(x, y)| x + y).collect();
    let out = convert(1, 48_000, &pcm16(&mixed), 8192);
    let lane = lane_samples(&out, 0);
    let kept = tone_amplitude(&lane, 32_000, 1000.0);
    let alias = tone_amplitude(&lane, 32_000, 12_000.0);
    assert!((kept - 0.4).abs() <= 0.02, "1 kHz kept: {kept:.4}");
    assert!(alias < 0.004, "no alias at 12 kHz: {alias:.5}");
}

// ---------------------------------------------------------------------------
// chunk boundaries (contract 3: the command reads the data chunk in pieces)
// ---------------------------------------------------------------------------

/// 7. The output is byte-identical whether the data arrives whole, in 997-byte pieces (not frame-aligned), in 1-byte pieces
///    or in large pieces — for stereo 48 kHz and for a 44.1 kHz source (a 320 : 441 ratio).
#[test]
fn the_output_does_not_depend_on_how_the_data_is_cut() {
    for (channels, rate) in [(2u16, 48_000u32), (1, 44_100), (1, 16_000)] {
        let frames = 20_000;
        let lanes: Vec<Vec<i16>> = (0..channels).map(|c| sine(700.0 * f64::from(c + 1), 0.4, rate, frames)).collect();
        let data = pcm16(&interleave(&lanes));
        let whole = convert(channels, rate, &data, data.len());
        for chunk_len in [1usize, 3, 997, 4096, 65_537] {
            let pieces = convert(channels, rate, &data, chunk_len);
            assert_eq!(pieces, whole, "{channels} ch {rate} Hz: pushing in pieces of {chunk_len} bytes changes the output");
        }
    }
}

// ---------------------------------------------------------------------------
// the lanes (contract 5: L / R apart; the waveform's rule for 3+ channels)
// ---------------------------------------------------------------------------

/// 8. Stereo with a tone in L only: the L lane carries it, the R lane is silent (no mixing between lanes).
#[test]
fn stereo_keeps_l_and_r_apart() {
    let data = pcm16(&interleave(&[sine(1000.0, 0.5, 48_000, 48_000), vec![0i16; 48_000]]));
    let out = convert(2, 48_000, &data, 8192);
    assert_eq!(header(&out).channels, 2);
    let l = lane_samples(&out, 0);
    let r = lane_samples(&out, 1);
    assert!((tone_amplitude(&l, 32_000, 1000.0) - 0.5).abs() <= 0.015, "L keeps the tone");
    assert!(rms(&r) < 1e-4, "R stays silent (rms {:.6})", rms(&r));
    // And the other way round.
    let data = pcm16(&interleave(&[vec![0i16; 48_000], sine(5000.0, 0.5, 48_000, 48_000)]));
    let out = convert(2, 48_000, &data, 8192);
    assert!(rms(&lane_samples(&out, 0)) < 1e-4, "L stays silent");
    assert!((tone_amplitude(&lane_samples(&out, 1), 32_000, 5000.0) - 0.5).abs() <= 0.015, "R keeps the tone");
}

/// 9. Three channels with the tone in one of them are averaged: one lane at a third of the level.
#[test]
fn three_or_more_channels_are_averaged_into_one_lane() {
    let data = pcm16(&interleave(&[sine(1000.0, 0.6, 48_000, 48_000), vec![0i16; 48_000], vec![0i16; 48_000]]));
    let out = convert(3, 48_000, &data, 8192);
    assert_eq!(header(&out).channels, 1);
    let got = tone_amplitude(&lane_samples(&out, 0), 32_000, 1000.0);
    assert!((got - 0.2).abs() <= 0.01, "the average of (0.6, 0, 0) is 0.2: read {got:.4}");
}

// ---------------------------------------------------------------------------
// sources at or below 32 kHz (the decoder resamples up; nothing above their Nyquist to show)
// ---------------------------------------------------------------------------

/// 10. A 16 kHz source keeps its rate and its samples (within one 16-bit step); a 32 kHz source is not resampled either.
#[test]
fn sources_at_or_below_32khz_keep_their_rate_and_samples() {
    for rate in [16_000u32, 32_000, 8_000] {
        let input = sine(440.0, 0.9, rate, 5_000);
        let out = convert(1, rate, &pcm16(&input), 1000);
        let h = header(&out);
        assert_eq!(h.rate, rate, "a {rate} Hz source keeps its rate");
        assert_eq!(u64::from(h.data_bytes), input.len() as u64 * 2, "the same number of frames");
        let got: Vec<i16> = out[44..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        for (i, (a, b)) in input.iter().zip(got.iter()).enumerate() {
            assert!((i32::from(*a) - i32::from(*b)).abs() <= 1, "sample {i}: {a} became {b}");
        }
    }
    let f = format(1, 16_000);
    assert_eq!(SpectrumWav::new(f, 10).expect("new").out_rate(), 16_000);
    assert_eq!(SpectrumWav::new(format(1, 48_000), 10).expect("new").out_rate(), 32_000);
    assert_eq!(SpectrumWav::new(format(2, 44_100), 10).expect("new").out_rate(), 32_000);
}

// ---------------------------------------------------------------------------
// short and truncated files (contract 10: fail-open, nothing breaks)
// ---------------------------------------------------------------------------

/// 11. A file of a few frames (far shorter than the filter) comes back as a whole WAV of the right size.
#[test]
fn a_file_shorter_than_the_filter_comes_back_whole() {
    for frames in [1usize, 2, 7, 100] {
        let input = sine(1000.0, 0.5, 48_000, frames);
        let out = convert(1, 48_000, &pcm16(&input), 3);
        let h = header(&out);
        let frames_out = ceil_div(frames as u64 * 32_000, 48_000);
        assert_eq!(u64::from(h.data_bytes), frames_out * 2, "{frames} frames in → {frames_out} frames out");
        assert_eq!(out.len() as u64, 44 + frames_out * 2);
        for b in &out[44..] {
            let _ = b; // every byte is there (no panic, no short read)
        }
    }
}

/// 12. A file that declared more frames than it holds: the output has the declared size (the header stays true), the
///     missing tail is silence.
#[test]
fn a_truncated_file_is_padded_to_its_declared_frames() {
    let f = format(1, 48_000);
    let declared = 3_000u64;
    let present = 1_500usize;
    let mut wav = SpectrumWav::new(f, declared).expect("new");
    wav.push(&pcm16(&sine(1000.0, 0.5, 48_000, present)));
    let out = wav.finish();
    let frames_out = ceil_div(declared * 32_000, 48_000);
    assert_eq!(out.len() as u64, 44 + frames_out * 2);
    assert_eq!(u64::from(header(&out).data_bytes), frames_out * 2);
    let lane = lane_samples(&out, 0);
    let tail = &lane[lane.len() - 200..];
    assert!(tail.iter().all(|s| s.abs() < 1e-3), "the padded tail is silence");
}

/// 13. Frames beyond the declared total are ignored (the caller rounds a file down to what exists).
#[test]
fn frames_beyond_the_declared_total_are_ignored() {
    let f = format(1, 48_000);
    let mut wav = SpectrumWav::new(f, 1_000).expect("new");
    wav.push(&pcm16(&sine(1000.0, 0.5, 48_000, 5_000)));
    let out = wav.finish();
    assert_eq!(out.len() as u64, 44 + ceil_div(1_000 * 32_000, 48_000) * 2);
}

// ---------------------------------------------------------------------------
// refusals (contract 10)
// ---------------------------------------------------------------------------

/// 14. An output over 4 GiB cannot be described by a WAV header → "too-large" before any allocation; a format with no
///     rate or no channels → "unreadable".
#[test]
fn impossible_outputs_and_broken_formats_are_refused() {
    let err = SpectrumWav::new(format(2, 48_000), 1u64 << 31).err().expect("refused");
    assert_eq!(err, TOO_LARGE);
    assert_eq!(TOO_LARGE, "too-large");
    let mut broken = format(1, 48_000);
    broken.sample_rate = 0;
    assert_eq!(SpectrumWav::new(broken, 10).err().expect("refused"), "unreadable");
    let mut no_channels = format(1, 48_000);
    no_channels.channels = 0;
    assert_eq!(SpectrumWav::new(no_channels, 10).err().expect("refused"), "unreadable");
}

// ---------------------------------------------------------------------------
// contract 9 — the waveform's wav route is untouched
// ---------------------------------------------------------------------------

/// 15. `analyze_wav_bytes` (requirement 50's raw layout: u32 channels / sampleRate / frames / coarseStep / coarseLen /
///     hasSamples, f64 duration) still answers the 8 kHz envelope with the same frame rule, independently of the spectrum's
///     32 kHz conversion of the same bytes.
#[test]
fn the_waveform_route_still_returns_the_8khz_envelope() {
    const FRAMES: usize = 48_000;
    let data = pcm16(&interleave(&[sine(1000.0, 0.5, 48_000, FRAMES), sine(5000.0, 0.5, 48_000, FRAMES)]));
    let file = wav_file(2, 48_000, &data);
    let before = analyze_wav_bytes(&file, file.len(), WAV_WAVEFORM_MAX_RETAINED_SAMPLES).expect("waveform analysis");
    let spectrum = convert(2, 48_000, &data, 4096);
    let after = analyze_wav_bytes(&file, 997, WAV_WAVEFORM_MAX_RETAINED_SAMPLES).expect("waveform analysis again");
    assert_eq!(before, after, "the waveform's answer is the same, whole or in pieces, with the spectrum's conversion in between");
    assert_eq!(u32_at(&before, 0), 2, "channels");
    assert_eq!(u32_at(&before, 4), 8_000, "the waveform stays at 8 kHz (contract 9)");
    assert_eq!(u64::from(u32_at(&before, 8)), ceil_div(FRAMES as u64 * 8_000, 48_000), "the waveform's frame rule");
    assert_eq!(header(&spectrum).rate, 32_000, "the spectrum's WAV is a different stream at 32 kHz");
    assert_ne!(before.len(), spectrum.len());
}

// ---------------------------------------------------------------------------
// P2-1 (reviewer, 2026-11-27) — an absurd sample rate must not size the kernel table
// ---------------------------------------------------------------------------

/// 16. A `fmt ` chunk can claim any `sample_rate`; with 0xFFFFFFFF the resampler's kernel table would be about 25 GB.
///     Rates above 384 kHz (no real recorder goes higher; 384 kHz is the top DXD / "hi-res" rate) are refused as
///     "unsupported-codec" right away — no table, no allocation. 384 kHz and 192 kHz are accepted and resampled.
#[test]
fn sample_rates_above_384khz_are_refused_without_allocating() {
    for rate in [0xFFFF_FFFFu32, 768_000, 384_001] {
        let mut f = format(1, 48_000);
        f.sample_rate = rate;
        let started = std::time::Instant::now();
        let err = SpectrumWav::new(f, 48_000).err().unwrap_or_else(|| panic!("a {rate} Hz source must be refused"));
        assert_eq!(err, "unsupported-codec", "{rate} Hz: the refusal is the unsupported-format reason");
        assert!(started.elapsed() < std::time::Duration::from_secs(1), "{rate} Hz: refused at once, before any table is built");
    }
    for rate in [384_000u32, 192_000] {
        let input = sine(1000.0, 0.5, rate, rate as usize / 10);
        let out = convert(1, rate, &pcm16(&input), 8192);
        let h = header(&out);
        assert_eq!(h.rate, 32_000, "{rate} Hz is accepted and brought down to 32 kHz");
        let got = tone_amplitude(&lane_samples(&out, 0), 32_000, 1000.0);
        assert!((got - 0.5).abs() <= 0.02, "{rate} Hz: the 1 kHz tone reads {got:.4}");
    }
}
