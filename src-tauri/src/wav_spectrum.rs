//! The audio of a wav file for the spectrum band (requirements.md #91 contract 3).
//!
//! The waveform reads wav in Rust and sends only its 8 kHz envelope (requirement #50: a 2-hour 44.1 kHz stereo wav
//! is 1.27 GB and is never put into the WebView). The spectrum needs the audio up to 16 kHz, so this module turns
//! the `data` chunk into a 16-bit PCM WAV at 32 kHz (two lanes for stereo, one for anything else, 3+ channels
//! averaged like the waveform) that the frontend decodes with the same `decodeAudioData` as the other routes.
//! A 2-hour stereo file becomes about 0.9 GB (the founder: memory is not a concern on the Mac).
//!
//! Sources above 32 kHz are resampled with a Kaiser-windowed sinc low-pass (pass band to about 14 kHz, stop band
//! from about 17 kHz, about 60 dB), so content between 16 kHz and the source's Nyquist frequency does not fold back
//! into the band that is drawn. Sources at 32 kHz or below keep their rate (the decoder resamples them up; there is
//! nothing above their Nyquist frequency to show). Like the waveform's decimator, the state crosses chunk
//! boundaries, so the output does not depend on how the `data` chunk is read.

use crate::wav_waveform::{WavFormat, UNSUPPORTED_CODEC};

/// The rate the spectrum analyses at (`SPECTRUM_SAMPLE_RATE` in `src/lib/audio-spectrum.ts`).
pub const SPECTRUM_RATE: u32 = 32_000;

/// The refusal for an output a WAV header cannot describe (a `data` chunk over 4 GiB).
pub const TOO_LARGE: &str = "too-large";
const UNREADABLE: &str = "unreadable";

/// Centre of the low-pass transition (Hz).
const CUTOFF_HZ: f64 = 15_500.0;
/// Width of the transition band (Hz).
const TRANSITION_HZ: f64 = 2_500.0;
/// Stop-band attenuation the Kaiser window is designed for (dB).
const ATTENUATION_DB: f64 = 60.0;
/// The highest source rate the resampler takes (Hz). Above it the kernel would grow past any real recording's
/// needs (its taps scale with the rate), so such a file is refused before the table is built.
pub const MAX_SOURCE_RATE: u32 = 384_000;
/// The most kernel phases kept in the table; finer phases are rounded to the nearest of these.
const MAX_PHASES: u64 = 1024;
/// The buffered input is trimmed once this many consumed frames have piled up at its front.
const TRIM_FRAMES: usize = 1 << 16;

/// The lanes the spectrum draws: two for stereo, one otherwise (the waveform's rule).
fn lane_count(format: &WavFormat) -> usize {
    if format.channels == 2 {
        2
    } else {
        1
    }
}

/// Channel `c` of one frame, normalised to [-1, 1] (the formats `parse_fmt` accepts).
fn sample_at(format: &WavFormat, frame: &[u8], c: usize) -> f32 {
    let width = format.bits as usize / 8;
    let at = c * width;
    let Some(bytes) = frame.get(at..at + width) else {
        return 0.0;
    };
    match (format.float, format.bits) {
        (true, 32) => {
            let v = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            if v.is_finite() {
                v
            } else {
                0.0
            }
        }
        (false, 16) => f32::from(i16::from_le_bytes([bytes[0], bytes[1]])) / 32_768.0,
        (false, 24) => (i32::from_le_bytes([0, bytes[0], bytes[1], bytes[2]]) >> 8) as f32 / 8_388_608.0,
        (false, 32) => i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 2_147_483_648.0,
        _ => 0.0,
    }
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// The zeroth-order modified Bessel function of the first kind (series; enough terms for the Kaiser window).
fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half = x / 2.0;
    for k in 1..64 {
        term *= half / k as f64;
        let add = term * term;
        sum += add;
        if add < sum * 1e-16 {
            break;
        }
    }
    sum
}

/// The polyphase kernel table of the low-pass for `in_rate` → `out_rate`.
struct Kernel {
    /// Taps on each side of the output instant (in input samples); a phase has `2 * half` taps.
    half: usize,
    /// Output frames per `down` input frames (the reduced ratio).
    up: u64,
    down: u64,
    /// Phases in the table (`up`, or MAX_PHASES when `up` is larger).
    phases: u64,
    /// `phases` rows of `2 * half` taps, each row summing to 1.
    table: Vec<f32>,
}

impl Kernel {
    fn new(in_rate: u32, out_rate: u32) -> Self {
        let g = gcd(u64::from(in_rate), u64::from(out_rate));
        let up = u64::from(out_rate) / g;
        let down = u64::from(in_rate) / g;
        let phases = up.min(MAX_PHASES);

        let fs = f64::from(in_rate);
        let beta = 0.1102 * (ATTENUATION_DB - 8.7);
        let taps = (ATTENUATION_DB - 8.0) / (2.285 * 2.0 * std::f64::consts::PI * TRANSITION_HZ / fs);
        let half = ((taps / 2.0).ceil() as usize).max(2);
        let fc = CUTOFF_HZ / fs;
        let i0_beta = bessel_i0(beta);

        let width = 2 * half;
        let mut table = vec![0f32; phases as usize * width];
        for p in 0..phases as usize {
            let frac = p as f64 / phases as f64;
            let row = &mut table[p * width..(p + 1) * width];
            let mut sum = 0.0f64;
            let mut values = vec![0f64; width];
            for (i, value) in values.iter_mut().enumerate() {
                let d = (i as f64 - half as f64 + 1.0) - frac;
                let x = d / half as f64;
                if x.abs() >= 1.0 {
                    continue;
                }
                let arg = 2.0 * fc * d;
                let sinc = if arg.abs() < 1e-12 {
                    1.0
                } else {
                    (std::f64::consts::PI * arg).sin() / (std::f64::consts::PI * arg)
                };
                let window = bessel_i0(beta * (1.0 - x * x).sqrt()) / i0_beta;
                *value = 2.0 * fc * sinc * window;
                sum += *value;
            }
            for (slot, value) in row.iter_mut().zip(values.iter()) {
                *slot = if sum != 0.0 { (value / sum) as f32 } else { 0.0 };
            }
        }
        Self {
            half,
            up,
            down,
            phases,
            table,
        }
    }

    /// The first input frame and the kernel row of output frame `j`.
    fn locate(&self, j: u64) -> (i64, usize) {
        let pos = u128::from(j) * u128::from(self.down);
        let mut base = (pos / u128::from(self.up)) as i64;
        let phase = (pos % u128::from(self.up)) as u64;
        let mut row = if self.phases == self.up {
            phase
        } else {
            (phase * self.phases + self.up / 2) / self.up
        };
        if row >= self.phases {
            row = 0;
            base += 1;
        }
        (base - self.half as i64 + 1, row as usize)
    }
}

/// Turns the `data` chunk of a wav into a 16-bit PCM WAV for the spectrum (a chunk-boundary-free state machine).
pub struct SpectrumWav {
    format: WavFormat,
    lanes: usize,
    out_rate: u32,
    kernel: Option<Kernel>,
    frames_total: u64,
    frames_in: u64,
    frames_out: u64,
    next_out: u64,
    partial: Vec<u8>,
    /// Buffered input per lane; `buffer_start` is the absolute input frame of index 0 (negative = leading silence).
    buffer: Vec<Vec<f32>>,
    buffer_start: i64,
    out: Vec<u8>,
}

impl SpectrumWav {
    /// `frames_total` complete frames will be pushed (the caller rounds a truncated file down to what exists).
    pub fn new(format: WavFormat, frames_total: u64) -> Result<Self, String> {
        if format.sample_rate == 0 || format.channels == 0 {
            return Err(UNREADABLE.to_string());
        }
        if format.sample_rate > MAX_SOURCE_RATE {
            return Err(UNSUPPORTED_CODEC.to_string());
        }
        let lanes = lane_count(&format);
        let resample = format.sample_rate > SPECTRUM_RATE;
        let out_rate = if resample { SPECTRUM_RATE } else { format.sample_rate };
        let frames_out = if resample {
            (u128::from(frames_total) * u128::from(SPECTRUM_RATE)).div_ceil(u128::from(format.sample_rate)) as u64
        } else {
            frames_total
        };
        let data_bytes = u128::from(frames_out) * lanes as u128 * 2;
        if data_bytes + 36 > u128::from(u32::MAX) {
            return Err(TOO_LARGE.to_string());
        }
        let kernel = resample.then(|| Kernel::new(format.sample_rate, SPECTRUM_RATE));
        let lead = kernel.as_ref().map_or(0, |k| k.half);

        let mut out = Vec::with_capacity(44 + data_bytes as usize);
        write_header(&mut out, lanes as u16, out_rate, data_bytes as u32);
        Ok(Self {
            format,
            lanes,
            out_rate,
            kernel,
            frames_total,
            frames_in: 0,
            frames_out,
            next_out: 0,
            partial: Vec::with_capacity(format.bytes_per_frame()),
            buffer: vec![vec![0.0; lead]; lanes],
            buffer_start: -(lead as i64),
            out,
        })
    }

    /// The output rate (32 kHz, or the source's own rate when it is 32 kHz or lower).
    pub fn out_rate(&self) -> u32 {
        self.out_rate
    }

    /// More of the `data` chunk; the chunk boundaries are arbitrary (not frame boundaries).
    pub fn push(&mut self, bytes: &[u8]) {
        let per_frame = self.format.bytes_per_frame();
        if per_frame == 0 {
            return;
        }
        let mut input = bytes;
        if !self.partial.is_empty() {
            let take = (per_frame - self.partial.len()).min(input.len());
            self.partial.extend_from_slice(&input[..take]);
            input = &input[take..];
            if self.partial.len() == per_frame {
                let frame = std::mem::take(&mut self.partial);
                self.push_frame(&frame);
                self.partial = frame;
                self.partial.clear();
            }
        }
        let full = input.len() / per_frame;
        for i in 0..full {
            self.push_frame(&input[i * per_frame..(i + 1) * per_frame]);
        }
        self.partial.extend_from_slice(&input[full * per_frame..]);
        self.emit(false);
    }

    fn push_frame(&mut self, frame: &[u8]) {
        if self.frames_in >= self.frames_total {
            return;
        }
        let channels = self.format.channels as usize;
        if self.lanes == 2 {
            let l = sample_at(&self.format, frame, 0);
            let r = sample_at(&self.format, frame, 1);
            self.buffer[0].push(l);
            self.buffer[1].push(r);
        } else if channels == 1 {
            let v = sample_at(&self.format, frame, 0);
            self.buffer[0].push(v);
        } else {
            let mut sum = 0.0f64;
            for c in 0..channels {
                sum += f64::from(sample_at(&self.format, frame, c));
            }
            self.buffer[0].push((sum / channels as f64) as f32);
        }
        self.frames_in += 1;
    }

    /// Write every output frame whose input is complete (all of them when `finished`).
    fn emit(&mut self, finished: bool) {
        let available_end = self.buffer_start + self.buffer[0].len() as i64;
        match &self.kernel {
            None => {
                let start = (self.next_out as i64 - self.buffer_start) as usize;
                let end = self.buffer[0].len();
                for i in start..end {
                    for lane in 0..self.lanes {
                        let v = self.buffer[lane][i];
                        self.out.extend_from_slice(&quantize(v).to_le_bytes());
                    }
                }
                self.next_out = self.frames_in;
                for lane in &mut self.buffer {
                    lane.clear();
                }
                self.buffer_start = self.frames_in as i64;
            }
            Some(kernel) => {
                let width = 2 * kernel.half;
                while self.next_out < self.frames_out {
                    let (first, row) = kernel.locate(self.next_out);
                    let end = first + width as i64;
                    if end > available_end && !finished {
                        break;
                    }
                    let taps = &kernel.table[row * width..(row + 1) * width];
                    for lane in 0..self.lanes {
                        let samples = &self.buffer[lane];
                        let at = first - self.buffer_start;
                        let v = if at >= 0 && (at as usize) + width <= samples.len() {
                            dot(&samples[at as usize..at as usize + width], taps)
                        } else {
                            // The tail: what lies past the last input frame is silence.
                            let mut acc = 0.0f32;
                            for (i, tap) in taps.iter().enumerate() {
                                let idx = at + i as i64;
                                if idx >= 0 && (idx as usize) < samples.len() {
                                    acc += samples[idx as usize] * tap;
                                }
                            }
                            acc
                        };
                        self.out.extend_from_slice(&quantize(v).to_le_bytes());
                    }
                    self.next_out += 1;
                }
                // Drop the input no later output frame needs.
                if self.next_out < self.frames_out {
                    let (first, _) = kernel.locate(self.next_out);
                    let consumed = (first - self.buffer_start).max(0) as usize;
                    if consumed >= TRIM_FRAMES {
                        for lane in &mut self.buffer {
                            lane.drain(..consumed.min(lane.len()));
                        }
                        self.buffer_start += consumed as i64;
                    }
                }
            }
        }
    }

    /// The WAV bytes (header + 16-bit little-endian PCM, lanes interleaved).
    pub fn finish(mut self) -> Vec<u8> {
        self.emit(true);
        // A file shorter than it said: pad the declared frames with silence so the header stays true.
        let expected = 44 + self.frames_out as usize * self.lanes * 2;
        self.out.resize(expected, 0);
        self.out
    }
}

fn dot(samples: &[f32], taps: &[f32]) -> f32 {
    samples.iter().zip(taps.iter()).map(|(s, t)| s * t).sum()
}

fn quantize(v: f32) -> i16 {
    (v.clamp(-1.0, 1.0) * 32_767.0).round() as i16
}

fn write_header(out: &mut Vec<u8>, channels: u16, rate: u32, data_bytes: u32) {
    let block_align = channels * 2;
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * u32::from(block_align)).to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_bytes.to_le_bytes());
}

