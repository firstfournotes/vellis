//! 要件#50 の受け入れテスト(requirements.md #50)— Rust 層(3周目=契約⑯)
//!
//! 「音声ファイル(wav / mp3 / m4a)の再生と波形表示」のうち、**wav の Rust 経路**
//! (契約⑬(c) の実体=契約⑯)の純関数部分を判定する:
//! - RIFF/WAVE のチャンク走査(`fmt `/`data` の位置決め・未知チャンクの読み飛ばし・
//!   奇数長チャンクの 1 バイトパディング)
//! - `fmt ` の解釈(wFormatTag 1 / 3 / 0xFFFE=EXTENSIBLE・EXTENSIBLE は SubFormat
//!   GUID **16 バイト全体**の照合・16/24/32int/32float のビット深度)
//! - 8kHz への間引き(**フレーム単位** `sourceRate / 8000`・各チャンネル別の
//!   絶対値最大・ファイル先頭からの**絶対フレーム位置**=読み取りチャンク境界を
//!   またいでも時刻がずれない)
//! - 粗レベル(coarse)の包含性・保持上限超過で `samples` が落ちて coarse だけ返る
//! - 解析尺(`fmt`+`data` から厳密)・RF64/BW64 マジックの拒否・壊れ入力の拒否
//! - root 外拒否の照合純関数(`ensure_within_root`)が wav パスにも効くこと
//!
//! ## 判定しないもの(reviewer 照合・人間ゲート)
//! - `analyze_wav_waveform` コマンド本体の配線(URI 解決・`FileProvider::read_range`
//!   での塊読み・`tauri::ipc::Response` 化・ssh:// を `unreadable` にすること)は
//!   AppState を要するためここでは判定できない(req41/45 と同じ分担)。root 照合は
//!   既存 `extract_waveform_audio` と同じく**行わない**(追補d(2)=読み取り経路は
//!   `vellis-asset` と同様に窓の root 配下からしか到達しない前提)
//! - 2時間実ファイルの体感・メモリ挙動は人間ゲート
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/wav_waveform.rs(`vellis_lib::wav_waveform`・契約⑮=
//! // 既存 audio_extract.rs / commands/waveform.rs / video_frames.rs は触らない)
//!
//! /// 保持してよい 8kHz 標本の総数(全レーン合計)。フロントの
//! /// `WAVEFORM_MAX_RETAINED_SAMPLES`(waveform-zoom.ts)と同じ値。
//! pub const WAV_WAVEFORM_MAX_RETAINED_SAMPLES: u64 = 67_108_864;
//!
//! /// wav バイト列を解析して IPC 応答の raw バイト列を作る純関数コア。
//! ///
//! /// `file` は RIFF/WAVE の全体。`read_chunk_len`(≧1)は data チャンクを読む
//! /// 塊の最大バイト数で、コマンド側は数 MiB を渡し、テストは小さな値で
//! /// チャンク境界跨ぎを起こす ―― **間引きの状態(絶対フレーム位置・部分
//! /// フレームの持ち越し)は塊の切れ目を越えて保たれなければならない**。
//! /// `max_retained_samples` はコマンド側では上記定数(テストの注入 seam)。
//! ///
//! /// Ok = 応答レイアウト(下記)の Vec<u8>。Err = 既存の拒否語彙そのもの
//! /// ("no-audio" / "unsupported-codec" / "unreadable")。
//! pub fn analyze_wav_bytes(
//!     file: &[u8],
//!     read_chunk_len: usize,
//!     max_retained_samples: u64,
//! ) -> Result<Vec<u8>, String>;
//! ```
//!
//! ## 応答レイアウト(契約⑯(a)。**全て little-endian**・TS 側受け口
//! (audio-viewing.acceptance.test.ts の3周目セクション)と同一の正本)
//!
//! ```text
//! offset  size  内容
//!  0      u32   channels(ソースのチャンネル数。レーン数は channels==2 なら 2、
//!               それ以外は 1 =追補d の既存規則)
//!  4      u32   sampleRate = 8000(解析レート)
//!  8      u32   frames(レーン1本あたりの出力標本数)
//! 12      u32   coarseStep = 512(粗レベル刻み=WAVEFORM_COARSE_STEP)
//! 16      u32   coarseLen = ceil(frames / 512)(レーン1本あたりの粗レベル要素数)
//! 20      u32   hasSamples(1 = samples 部あり・0 = coarse のみ)
//! 24      f64   durationSeconds(解析尺。fmt+data のサイズから厳密=
//!               「data の完全フレーム数」を f64 にして sourceRate で割った値。
//!               本テストは同じ式で f64 の同値比較をする)
//! 32      f32×  [hasSamples=1 のとき] レーン順に frames 個ずつの 8kHz 標本
//! 続き    f32×  レーン順に「mins が coarseLen 個 → maxs が coarseLen 個」
//! ```
//!
//! ## 語彙の割り当て(§3.5.3 の拒否規則の本テストによる固定)
//! - RIFF/WAVE として構造が読めない(マジック不一致・`fmt `/`data` 欠落・
//!   channels=0・sampleRate=0・data が 0 フレーム)→ **"no-audio"**
//!   (フロント文言「このファイルから音声を読み取れませんでした」に対応)
//! - 形式は読めたが v1 対象外(RF64/BW64 マジック・wFormatTag 2/6/7・8bit・
//!   64bit float・未知 GUID・wValidBitsPerSample ≠ wBitsPerSample)→
//!   **"unsupported-codec"**
//! - IO 失敗(コマンド層)→ "unreadable"(純関数コアの入力はバイト列なので
//!   ここでは発生させない)
//! - data の宣言サイズがファイル末尾を超える(切り詰められたファイル)→
//!   **実在するバイトだけを解析する fail-open**(尺も実在分から。端数の
//!   部分フレームは捨てる)
//!
//! フィクスチャはすべて本ファイル内でバイト列合成する(実ファイルのコミット
//! なし=req37/41/45 の作法)。2時間の実体は不要 ―― 間引き比・境界・保持上限は
//! 小さなパラメータで機械判定する。

use vellis_lib::fs::local::ensure_within_root;
use vellis_lib::wav_waveform::{analyze_wav_bytes, WAV_WAVEFORM_MAX_RETAINED_SAMPLES};

// ---------------------------------------------------------------------------
// フィクスチャ合成ヘルパ(RIFF の箱を最小構成で組む)
// ---------------------------------------------------------------------------

/// RIFF チャンク(id + size(LE) + payload)。**奇数長は 1 バイトのパディング**を
/// 足す(宣言サイズは奇数のまま=RIFF の規則)。
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

/// `RIFF`(size)`WAVE` + チャンク列。
fn riff_wave(chunks: &[Vec<u8>]) -> Vec<u8> {
    let mut body: Vec<u8> = b"WAVE".to_vec();
    for c in chunks {
        body.extend_from_slice(c);
    }
    let mut file = Vec::with_capacity(8 + body.len());
    file.extend_from_slice(b"RIFF");
    file.extend_from_slice(&(body.len() as u32).to_le_bytes());
    file.extend_from_slice(&body);
    file
}

/// 基本形 `fmt `(16 バイトペイロード)。
fn fmt_payload(tag: u16, channels: u16, rate: u32, bits: u16) -> Vec<u8> {
    let block_align = channels * (bits / 8);
    let byte_rate = rate * u32::from(block_align);
    let mut p = Vec::with_capacity(16);
    p.extend_from_slice(&tag.to_le_bytes());
    p.extend_from_slice(&channels.to_le_bytes());
    p.extend_from_slice(&rate.to_le_bytes());
    p.extend_from_slice(&byte_rate.to_le_bytes());
    p.extend_from_slice(&block_align.to_le_bytes());
    p.extend_from_slice(&bits.to_le_bytes());
    p
}

fn fmt_chunk(tag: u16, channels: u16, rate: u32, bits: u16) -> Vec<u8> {
    chunk(b"fmt ", &fmt_payload(tag, channels, rate, bits))
}

/// `KSDATAFORMAT_SUBTYPE_PCM` = 00000001-0000-0010-8000-00AA00389B71 のディスク上
/// バイト列(Data1..3 は LE・Data4 はそのまま)。
const GUID_PCM: [u8; 16] = [
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
];

/// `KSDATAFORMAT_SUBTYPE_IEEE_FLOAT` = 00000003-0000-0010-8000-00AA00389B71。
const GUID_FLOAT: [u8; 16] = [
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
];

/// EXTENSIBLE(0xFFFE)の `fmt `(40 バイトペイロード=cbSize 22)。
fn fmt_extensible(channels: u16, rate: u32, bits: u16, valid_bits: u16, guid: &[u8; 16]) -> Vec<u8> {
    let mut p = fmt_payload(0xFFFE, channels, rate, bits);
    p.extend_from_slice(&22u16.to_le_bytes()); // cbSize
    p.extend_from_slice(&valid_bits.to_le_bytes()); // wValidBitsPerSample
    p.extend_from_slice(&0u32.to_le_bytes()); // dwChannelMask
    p.extend_from_slice(guid); // SubFormat
    chunk(b"fmt ", &p)
}

/// 16bit 整数 PCM のインターリーブ標本列 → バイト列。
fn pcm16(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

/// 24bit 整数 PCM(下位 3 バイト LE)。値は ±2^23 の範囲で渡す。
fn pcm24(samples: &[i32]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|s| {
            let b = s.to_le_bytes();
            [b[0], b[1], b[2]]
        })
        .collect()
}

/// 32bit 整数 PCM。
fn pcm32(samples: &[i32]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

/// 32bit IEEE float PCM。
fn pcmf32(samples: &[f32]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

/// 標準形の wav(fmt → data)。
fn wav(fmt: Vec<u8>, data: &[u8]) -> Vec<u8> {
    riff_wave(&[fmt, chunk(b"data", data)])
}

fn wav_pcm16(channels: u16, rate: u32, interleaved: &[i16]) -> Vec<u8> {
    wav(fmt_chunk(1, channels, rate, 16), &pcm16(interleaved))
}

/// 決定的な擬似乱数標本列(LCG)。フィクスチャに実ファイルを持ち込まないための種。
fn lcg_samples(n: usize, seed: u32) -> Vec<i16> {
    let mut x = seed;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        out.push(((x >> 16) as u16) as i16);
    }
    out
}

// ---------------------------------------------------------------------------
// 応答の読み取り(レイアウト契約の実行仕様=このテストが正本)
// ---------------------------------------------------------------------------

/// 応答レイアウトを読み戻した形。
struct WavAnalysis {
    channels: u32,
    frames: u32,
    coarse_len: u32,
    has_samples: bool,
    duration_seconds: f64,
    /// レーンごとの 8kHz 標本(has_samples=0 のときは空)。
    samples: Vec<Vec<f32>>,
    /// レーンごとの (mins, maxs)。
    coarse: Vec<(Vec<f32>, Vec<f32>)>,
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

fn f32_seq(bytes: &[u8], at: usize, n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| f32::from_le_bytes(bytes[at + i * 4..at + i * 4 + 4].try_into().unwrap()))
        .collect()
}

/// 応答バイト列を読み戻す。固定不変条件(sampleRate=8000・coarseStep=512・
/// coarseLen=ceil(frames/512)・全長の一致)はここで全ケース共通に判定する。
fn read_analysis(bytes: &[u8]) -> WavAnalysis {
    assert!(bytes.len() >= 32, "応答は 32 バイトの固定長ヘッダを持つこと");
    let channels = u32_at(bytes, 0);
    let sample_rate = u32_at(bytes, 4);
    let frames = u32_at(bytes, 8);
    let coarse_step = u32_at(bytes, 12);
    let coarse_len = u32_at(bytes, 16);
    let has_samples = match u32_at(bytes, 20) {
        0 => false,
        1 => true,
        other => panic!("hasSamples は 0/1 のはず: {other}"),
    };
    let duration_seconds = f64::from_le_bytes(bytes[24..32].try_into().unwrap());

    assert_eq!(sample_rate, 8000, "解析レートは 8000(既存経路と同じ)");
    assert_eq!(coarse_step, 512, "粗レベル刻みは WAVEFORM_COARSE_STEP=512");
    assert_eq!(
        u64::from(coarse_len),
        u64::from(frames).div_ceil(512),
        "coarseLen = ceil(frames / 512)"
    );

    let lanes = if channels == 2 { 2usize } else { 1usize };
    let sample_bytes = if has_samples {
        lanes * frames as usize * 4
    } else {
        0
    };
    let expected_len = 32 + sample_bytes + lanes * coarse_len as usize * 8;
    assert_eq!(
        bytes.len(),
        expected_len,
        "応答長=ヘッダ+samples+coarse(channels={channels} frames={frames})"
    );

    let mut at = 32;
    let mut samples = Vec::new();
    if has_samples {
        for _ in 0..lanes {
            samples.push(f32_seq(bytes, at, frames as usize));
            at += frames as usize * 4;
        }
    }
    let mut coarse = Vec::new();
    for _ in 0..lanes {
        let mins = f32_seq(bytes, at, coarse_len as usize);
        at += coarse_len as usize * 4;
        let maxs = f32_seq(bytes, at, coarse_len as usize);
        at += coarse_len as usize * 4;
        coarse.push((mins, maxs));
    }
    WavAnalysis {
        channels,
        frames,
        coarse_len,
        has_samples,
        duration_seconds,
        samples,
        coarse,
    }
}

/// 塊サイズ=ファイル全長・保持上限=本番定数、の標準呼び出し。
fn analyze(file: &[u8]) -> Result<WavAnalysis, String> {
    analyze_wav_bytes(file, file.len().max(1), WAV_WAVEFORM_MAX_RETAINED_SAMPLES)
        .map(|bytes| read_analysis(&bytes))
}

fn analyze_ok(file: &[u8]) -> WavAnalysis {
    analyze(file).expect("解析できる wav のはず")
}

/// 正規化の許容差。整数 PCM のフルスケール規約(2^(bits-1) か 2^(bits-1)-1)は
/// 実装裁量に残す ―― どちらでも 1e-3 未満の差で、包絡の見た目には出ない。
const TOL: f32 = 1e-3;

fn assert_approx(actual: f32, expected: f32, note: &str) {
    assert!(
        (actual - expected).abs() < TOL,
        "{note}: got {actual}, want ≈{expected}"
    );
}

// ---------------------------------------------------------------------------
// fmt / data の位置決めとチャンク走査(契約⑯(c))
// ---------------------------------------------------------------------------

/// 8kHz mono 16bit(間引き比 1)は標本がそのまま出る=レイアウトと正規化の基準形。
#[test]
fn pcm16_mono_8khz_passthrough_layout_and_values() {
    let file = wav_pcm16(1, 8000, &[8192, -24576, 16384, 0]);
    let a = analyze_ok(&file);

    assert_eq!(a.channels, 1);
    assert_eq!(a.frames, 4, "比 1(8kHz→8kHz)は入力フレーム数のまま");
    assert!(a.has_samples);
    assert_eq!(a.samples.len(), 1, "mono は 1 レーン");
    assert_eq!(a.coarse.len(), 1);
    assert_eq!(a.coarse_len, 1);
    assert_eq!(a.duration_seconds, 4.0 / 8000.0, "解析尺= data フレーム数 / rate");

    let lane = &a.samples[0];
    assert_approx(lane[0], 0.25, "16bit 8192");
    assert_approx(lane[1], -0.75, "16bit -24576");
    assert_approx(lane[2], 0.5, "16bit 16384");
    assert_eq!(lane[3], 0.0, "無音標本は 0 のまま");
}

/// `fmt `/`data` が先頭に居ない・間に未知チャンク(奇数長含む)が挟まる wav でも
/// 位置決めできる ―― 未知チャンクは宣言サイズ+奇数長パディングで読み飛ばす。
/// 応答は標準形とバイト単位で一致する(パディングを忘れると data がずれて壊れる)。
#[test]
fn fmt_and_data_are_located_past_unknown_and_odd_sized_chunks() {
    let samples: Vec<i16> = lcg_samples(64, 7);
    let canonical = wav_pcm16(1, 8000, &samples);

    let cluttered = riff_wave(&[
        chunk(b"JUNK", &[0xAA; 5]),  // 奇数長 → 1 バイトパディング
        fmt_chunk(1, 1, 8000, 16),
        chunk(b"LIST", b"INFOabc"),  // 奇数長(7)の未知チャンク
        chunk(b"fact", &4u32.to_le_bytes()),
        chunk(b"data", &pcm16(&samples)),
        chunk(b"id3 ", &[0u8; 6]),   // data の後ろの残骸は無視される
    ]);

    let canonical_bytes = analyze_wav_bytes(&canonical, canonical.len(), WAV_WAVEFORM_MAX_RETAINED_SAMPLES)
        .expect("標準形");
    let cluttered_bytes = analyze_wav_bytes(&cluttered, cluttered.len(), WAV_WAVEFORM_MAX_RETAINED_SAMPLES)
        .expect("未知チャンク入りでも解析できること");
    assert_eq!(
        cluttered_bytes, canonical_bytes,
        "未知チャンクの有無で応答が変わらない(位置決めとパディングの正しさ)"
    );
}

/// cbSize=0 付きの 18 バイト `fmt `(整数 PCM の一般形)も受理する。
#[test]
fn fmt_with_trailing_cbsize_zero_is_accepted() {
    let mut p = fmt_payload(1, 1, 8000, 16);
    p.extend_from_slice(&0u16.to_le_bytes()); // cbSize = 0
    let file = riff_wave(&[chunk(b"fmt ", &p), chunk(b"data", &pcm16(&[16384, -16384]))]);

    let a = analyze_ok(&file);
    assert_eq!(a.frames, 2);
    assert_approx(a.samples[0][0], 0.5, "cbSize=0 でも PCM として読む");
}

// ---------------------------------------------------------------------------
// EXTENSIBLE の GUID 全体照合(契約⑯(c)・レビュー P4)
// ---------------------------------------------------------------------------

/// EXTENSIBLE + PCM GUID(16 バイト全体一致)は整数 PCM として受理する。
#[test]
fn extensible_pcm_guid_full_match_is_accepted() {
    let file = wav(
        fmt_extensible(1, 8000, 24, 24, &GUID_PCM),
        &pcm24(&[4_194_304, -6_291_456]), // 0.5, -0.75
    );
    let a = analyze_ok(&file);
    assert_eq!(a.frames, 2);
    assert_approx(a.samples[0][0], 0.5, "EXTENSIBLE 24bit PCM");
    assert_approx(a.samples[0][1], -0.75, "EXTENSIBLE 24bit PCM 負値");
}

/// EXTENSIBLE + IEEE float GUID は 32bit float として受理する。
#[test]
fn extensible_ieee_float_guid_is_accepted() {
    let file = wav(
        fmt_extensible(1, 8000, 32, 32, &GUID_FLOAT),
        &pcmf32(&[0.25, -1.0]),
    );
    let a = analyze_ok(&file);
    assert_eq!(a.frames, 2);
    assert_approx(a.samples[0][0], 0.25, "EXTENSIBLE float32");
    assert_approx(a.samples[0][1], -1.0, "EXTENSIBLE float32 負値");
}

/// **先頭 2 バイトだけ PCM GUID と一致する未知 GUID は拒否**(レビュー P4 の核心。
/// 先頭 2 バイト判別だと PCM と誤認し、拒否すべき入力から偽の波形を作ってしまう)。
#[test]
fn extensible_unknown_guid_with_matching_first_two_bytes_is_rejected() {
    let mut guid = GUID_PCM;
    for b in guid.iter_mut().skip(2) {
        *b = 0xDE; // 先頭 2 バイト(0x01, 0x00)だけ残して残り 14 バイトを壊す
    }
    let file = wav(fmt_extensible(1, 8000, 16, 16, &guid), &pcm16(&[16384]));
    assert_eq!(
        analyze(&file).err().as_deref(),
        Some("unsupported-codec"),
        "GUID は 16 バイト全体で照合すること"
    );
}

/// 全く別の未知 GUID も拒否(受理は PCM / IEEE float の 2 つだけ)。
#[test]
fn extensible_wholly_unknown_guid_is_rejected() {
    let file = wav(fmt_extensible(1, 8000, 16, 16, &[0xAB; 16]), &pcm16(&[16384]));
    assert_eq!(analyze(&file).err().as_deref(), Some("unsupported-codec"));
}

/// wValidBitsPerSample と wBitsPerSample が食い違う記述は拒否(契約⑯(c)=
/// 判断は格納幅 wBitsPerSample で行い、食い違いは unsupported-codec)。
#[test]
fn extensible_valid_bits_mismatch_is_rejected() {
    let file = wav(
        fmt_extensible(1, 8000, 16, 12, &GUID_PCM),
        &pcm16(&[16384, -16384]),
    );
    assert_eq!(analyze(&file).err().as_deref(), Some("unsupported-codec"));
}

// ---------------------------------------------------------------------------
// ビット深度と間引き(契約⑯(b)(c))
// ---------------------------------------------------------------------------

/// 16 / 24 / 32int / 32float の全深度で、比 2(16kHz→8kHz)の間引きが
/// **各出力フレームの範囲内の絶対値最大の標本(符号つき)**を採ること。
/// 入力 [0.25, -0.75, 0.5, 0.125] → 出力 [-0.75, 0.5]。
#[test]
fn bit_depths_16_24_32int_32float_decimate_by_signed_abs_max() {
    let cases: Vec<(&str, Vec<u8>)> = vec![
        (
            "16bit",
            wav(fmt_chunk(1, 1, 16000, 16), &pcm16(&[8192, -24576, 16384, 4096])),
        ),
        (
            "24bit",
            wav(
                fmt_chunk(1, 1, 16000, 24),
                &pcm24(&[2_097_152, -6_291_456, 4_194_304, 1_048_576]),
            ),
        ),
        (
            "32bit int",
            wav(
                fmt_chunk(1, 1, 16000, 32),
                &pcm32(&[536_870_912, -1_610_612_736, 1_073_741_824, 268_435_456]),
            ),
        ),
        (
            "32bit float",
            wav(fmt_chunk(3, 1, 16000, 32), &pcmf32(&[0.25, -0.75, 0.5, 0.125])),
        ),
    ];

    for (name, file) in cases {
        let a = analyze_ok(&file);
        assert_eq!(a.frames, 2, "{name}: 4 フレーム ÷ 比 2 = 2");
        assert_eq!(a.duration_seconds, 4.0 / 16000.0, "{name}: 解析尺はソースレート基準");
        let lane = &a.samples[0];
        assert_approx(lane[0], -0.75, name); // 絶対値最大は -0.75(平均 -0.25 ではない)
        assert_approx(lane[1], 0.5, name);
    }
}

/// 対象外の形式はすべて unsupported-codec 縮退(契約⑯(c) の v1 対象外)。
#[test]
fn unsupported_format_tags_and_depths_are_rejected() {
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("A-law(tag 6)", wav(fmt_chunk(6, 1, 8000, 8), &[0x55; 8])),
        ("µ-law(tag 7)", wav(fmt_chunk(7, 1, 8000, 8), &[0x7F; 8])),
        ("ADPCM(tag 2)", wav(fmt_chunk(2, 1, 8000, 4), &[0x00; 8])),
        ("8bit PCM", wav(fmt_chunk(1, 1, 8000, 8), &[128u8, 255, 0, 128])),
        (
            "64bit float",
            wav(
                fmt_chunk(3, 1, 8000, 64),
                &0.5f64.to_le_bytes().repeat(2),
            ),
        ),
    ];
    for (name, file) in cases {
        assert_eq!(
            analyze(&file).err().as_deref(),
            Some("unsupported-codec"),
            "{name}"
        );
    }
}

// ---------------------------------------------------------------------------
// 既知時刻のインパルス(契約⑯(b)・レビュー P3=非整数比とチャンク境界跨ぎ)
// ---------------------------------------------------------------------------

/// 44.1kHz ステレオ(比 5.5125=非整数)・読み取り塊 1001 バイト(フレーム境界とも
/// 標本境界とも揃わない)で、L/R の既知時刻インパルスが**正しい出力フレーム**
/// (`floor(k × 8000 / sourceRate)`=ファイル先頭からの絶対フレーム位置)に立つこと。
#[test]
fn impulse_times_survive_noninteger_ratio_and_chunk_boundaries() {
    const N: usize = 44_100; // ちょうど 1 秒
    let mut interleaved = vec![0i16; N * 2];
    interleaved[12_345 * 2] = 16_384; // L: フレーム 12345 に +0.5
    interleaved[33_333 * 2 + 1] = -24_576; // R: フレーム 33333 に -0.75
    let file = wav_pcm16(2, 44_100, &interleaved);

    let bytes = analyze_wav_bytes(&file, 1001, WAV_WAVEFORM_MAX_RETAINED_SAMPLES)
        .expect("44.1kHz ステレオが解析できること");
    let a = read_analysis(&bytes);

    assert_eq!(a.channels, 2);
    assert_eq!(a.samples.len(), 2, "ステレオは L/R の 2 レーン");
    assert_eq!(a.frames, 8000, "ceil(44100 × 8000 / 44100) = 8000");
    assert_eq!(a.duration_seconds, 1.0, "解析尺は fmt+data から厳密に 1 秒");

    // floor(12345 × 8000 / 44100) = 2239・floor(33333 × 8000 / 44100) = 6046。
    let (l, r) = (&a.samples[0], &a.samples[1]);
    assert_approx(l[2239], 0.5, "L インパルスの着地フレーム");
    assert_approx(r[6046], -0.75, "R インパルスの着地フレーム");
    // チャンネルは混ざらない(各チャンネル別々に採る)。
    assert_eq!(l[6046], 0.0, "R のインパルスは L レーンに漏れない");
    assert_eq!(r[2239], 0.0, "L のインパルスは R レーンに漏れない");
    // 位置が半フレームでもずれていれば隣が立つ ―― 隣接フレームは無音のまま。
    for idx in [2238usize, 2240] {
        assert_eq!(l[idx], 0.0, "L インパルスが隣接フレーム {idx} にずれない");
    }
    for idx in [6045usize, 6047] {
        assert_eq!(r[idx], 0.0, "R インパルスが隣接フレーム {idx} にずれない");
    }
}

/// 出力標本数は `ceil(入力フレーム数 × 8000 / sourceRate)`(半開区間のバケット割り
/// と同じ読み)―― 非整数比でも端数フレームを失わない。
#[test]
fn output_frame_count_is_ceil_over_the_ratio() {
    let cases = [
        (44_100u32, 22_050usize, 4000u32),
        (44_100, 22_051, 4001),
        (48_000, 6, 1),
        (8_000, 5, 5),
    ];
    for (rate, n, want) in cases {
        let a = analyze_ok(&wav_pcm16(1, rate, &vec![1000i16; n]));
        assert_eq!(a.frames, want, "rate={rate} frames={n}");
    }
}

/// 同じファイルを塊サイズ 997 と全長一括で解析した応答が**バイト単位で一致**する
/// ―― 間引きの絶対フレーム位置・部分フレームの持ち越しが塊の切れ目に依存しない。
#[test]
fn chunked_and_whole_reads_yield_identical_responses() {
    let samples = lcg_samples(13_000, 42);
    let file = wav_pcm16(1, 44_100, &samples);

    let whole = analyze_wav_bytes(&file, file.len(), WAV_WAVEFORM_MAX_RETAINED_SAMPLES)
        .expect("全長一括");
    let chunked = analyze_wav_bytes(&file, 997, WAV_WAVEFORM_MAX_RETAINED_SAMPLES)
        .expect("塊読み(997 バイト=標本境界と揃わない)");
    assert_eq!(chunked, whole, "塊サイズで応答が変わらないこと");
}

// ---------------------------------------------------------------------------
// 粗レベルの包含性(契約⑯(b)・要件#47 契約⑦の性質の維持)
// ---------------------------------------------------------------------------

/// 粗レベルは生標本から直接採るので、**間引き後の標本の包絡を包含する**
/// (min は同じか小さい・max は同じか大きい)―― 山を実際より小さく見せない。
#[test]
fn coarse_envelope_contains_decimated_samples() {
    const FRAMES: usize = 3072; // 出力 1536 フレーム → 粗レベル 3 要素
    let mut interleaved = Vec::with_capacity(FRAMES * 2);
    let l = lcg_samples(FRAMES, 1);
    let r = lcg_samples(FRAMES, 2);
    for i in 0..FRAMES {
        interleaved.push(l[i]);
        interleaved.push(r[i]);
    }
    let a = analyze_ok(&wav_pcm16(2, 16_000, &interleaved));

    assert_eq!(a.frames, 1536);
    assert_eq!(a.coarse_len, 3);
    for (lane, (mins, maxs)) in a.samples.iter().zip(a.coarse.iter()) {
        for j in 0..a.coarse_len as usize {
            let from = j * 512;
            let to = ((j + 1) * 512).min(lane.len());
            let seg = &lane[from..to];
            let seg_min = seg.iter().copied().fold(f32::INFINITY, f32::min);
            let seg_max = seg.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            assert!(
                mins[j] <= seg_min + 1e-6,
                "coarse[{j}].min={} は間引き標本の min={seg_min} 以下のはず",
                mins[j]
            );
            assert!(
                maxs[j] >= seg_max - 1e-6,
                "coarse[{j}].max={} は間引き標本の max={seg_max} 以上のはず",
                maxs[j]
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 保持上限(契約⑯(a)・⑬(d))
// ---------------------------------------------------------------------------

/// 保持上限の定数はフロントの `WAVEFORM_MAX_RETAINED_SAMPLES`(waveform-zoom.ts=
/// 256MiB ÷ 4)と同じ値で公開されること。
#[test]
fn retained_samples_constant_matches_frontend() {
    assert_eq!(WAV_WAVEFORM_MAX_RETAINED_SAMPLES, 67_108_864);
}

/// 総標本数(全レーン合計)が上限を**超える**と `samples` が落ちて coarse だけ返る。
/// ちょうど上限は保持する。上限は注入 seam(実サイズ 256MiB を作らないため)。
#[test]
fn samples_are_dropped_when_retained_total_exceeds_the_limit() {
    let interleaved: Vec<i16> = lcg_samples(40, 9); // ステレオ 20 フレーム=総標本 40
    let file = wav_pcm16(2, 8000, &interleaved);

    let kept = read_analysis(
        &analyze_wav_bytes(&file, file.len(), 40).expect("ちょうど上限は保持"),
    );
    assert!(kept.has_samples, "総標本 40 ≦ 上限 40 → samples を保持");
    assert_eq!(kept.samples.len(), 2);
    assert_eq!(kept.frames, 20);

    let dropped = read_analysis(
        &analyze_wav_bytes(&file, file.len(), 39).expect("上限超でも解析は成功する"),
    );
    assert!(!dropped.has_samples, "総標本 40 > 上限 39 → coarse のみ");
    assert!(dropped.samples.is_empty(), "samples 部は応答に載らない");
    assert_eq!(dropped.coarse.len(), 2, "coarse は落とさない(帯は描ける)");
    assert_eq!(dropped.frames, 20, "出力標本数の申告は縮退と独立");
    assert_eq!(
        dropped.duration_seconds,
        20.0 / 8000.0,
        "解析尺は縮退と独立に必ず載る(契約④(a)と同じ意味)"
    );
}

// ---------------------------------------------------------------------------
// RF64 / BW64 と壊れ入力の拒否(契約⑯(c)・レビュー P5)
// ---------------------------------------------------------------------------

/// RF64 / BW64 は**サイズではなく先頭マジック**で v1 対象外と判定する。
#[test]
fn rf64_and_bw64_magic_are_rejected_as_unsupported() {
    for magic in [b"RF64", b"BW64"] {
        let mut file = wav_pcm16(1, 8000, &[16384, -16384]);
        file[0..4].copy_from_slice(magic);
        assert_eq!(
            analyze(&file).err().as_deref(),
            Some("unsupported-codec"),
            "{} はコンテナ形式で拒否(v1.1 候補=backlog)",
            String::from_utf8_lossy(magic)
        );
    }
}

/// RIFF/WAVE として構造が読めない入力は no-audio 縮退(フロント文言
/// 「このファイルから音声を読み取れませんでした」の根拠)。
#[test]
fn broken_headers_are_rejected_as_no_audio() {
    let no_fmt = riff_wave(&[chunk(b"data", &pcm16(&[1, 2]))]);
    let no_data = riff_wave(&[fmt_chunk(1, 1, 8000, 16)]);
    let zero_channels = wav(fmt_chunk(1, 0, 8000, 16), &pcm16(&[1, 2]));
    let zero_rate = wav(fmt_chunk(1, 1, 0, 16), &pcm16(&[1, 2]));
    let empty_data = wav(fmt_chunk(1, 1, 8000, 16), &[]);
    let mut not_wave = wav_pcm16(1, 8000, &[1, 2]);
    not_wave[8..12].copy_from_slice(b"AVI ");

    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("マジック不一致", b"ABCD\x00\x00\x00\x00WAVE".to_vec()),
        ("短すぎるファイル", b"RI".to_vec()),
        ("空ファイル", Vec::new()),
        ("RIFF だが WAVE でない", not_wave),
        ("fmt 欠落", no_fmt),
        ("data 欠落", no_data),
        ("channels=0", zero_channels),
        ("sampleRate=0", zero_rate),
        ("data が 0 フレーム", empty_data),
    ];
    for (name, file) in cases {
        assert_eq!(analyze(&file).err().as_deref(), Some("no-audio"), "{name}");
    }
}

/// data の宣言サイズがファイル末尾を超える(切り詰め)は fail-open ――
/// 実在するバイトだけを解析し、尺も実在分から出す。端数の部分フレームは捨てる。
#[test]
fn truncated_data_chunk_fails_open_to_available_frames() {
    // 20 フレーム(40 バイト)の完全な wav を組んでから末尾を切り落とす ――
    // RIFF/data の宣言サイズは元のまま残り、実体だけが 10 フレーム+1 バイト
    // (部分フレーム)になる=実際の切り詰められたファイルの形。
    let mut file = wav_pcm16(1, 8000, &lcg_samples(20, 5));
    file.truncate(file.len() - 19); // data 40 バイトのうち 21 バイトだけ残す

    let a = analyze_ok(&file);
    assert_eq!(a.frames, 10, "実在する完全なフレームだけを解析する");
    assert_eq!(a.duration_seconds, 10.0 / 8000.0, "尺も実在分から");
}

// ---------------------------------------------------------------------------
// nBlockAlign の照合(要件#50 追補e(3)=2026-09-10 由谷決定 (a)「尊重せず拒否」)
// ---------------------------------------------------------------------------
//
// fmt の nBlockAlign が channels × bits/8 と一致しない wav は、パディング付き
// フレームを誤ったストライドで復号して帯が嘘をつき得る ―― 値を尊重して復号する
// のではなく `unsupported-codec` で拒否する。`nAvgBytesPerSec` は読まない。

/// block_align を明示指定できる基本形 `fmt `(16 バイトペイロード・追補e(3))。
/// 既定形 `fmt_payload` は整合値を計算するので、不一致のフィクスチャはこちらで
/// 組む(既存ビルダの挙動は変えない=追補e の規約)。byte_rate は block_align に
/// 追随させる ―― 判定対象を nBlockAlign の1点に絞るため。
fn fmt_chunk_with_block_align(
    tag: u16,
    channels: u16,
    rate: u32,
    bits: u16,
    block_align: u16,
) -> Vec<u8> {
    let byte_rate = rate * u32::from(block_align);
    let mut p = Vec::with_capacity(16);
    p.extend_from_slice(&tag.to_le_bytes());
    p.extend_from_slice(&channels.to_le_bytes());
    p.extend_from_slice(&rate.to_le_bytes());
    p.extend_from_slice(&byte_rate.to_le_bytes());
    p.extend_from_slice(&block_align.to_le_bytes());
    p.extend_from_slice(&bits.to_le_bytes());
    chunk(b"fmt ", &p)
}

/// nBlockAlign ≠ channels × bits/8 → unsupported-codec(追補e(3))。
#[test]
fn mismatched_block_align_is_rejected_as_unsupported() {
    let cases: Vec<(&str, Vec<u8>)> = vec![
        (
            "mono 24bit・block_align=4(正= 3)",
            wav(
                fmt_chunk_with_block_align(1, 1, 8000, 24, 4),
                &pcm24(&[4_194_304, -6_291_456]),
            ),
        ),
        (
            "stereo 16bit・block_align=2(正= 4)",
            wav(
                fmt_chunk_with_block_align(1, 2, 8000, 16, 2),
                &pcm16(&[16384, -16384, 0, 0]),
            ),
        ),
    ];
    for (name, file) in cases {
        assert_eq!(
            analyze(&file).err().as_deref(),
            Some("unsupported-codec"),
            "{name}"
        );
    }
}

/// nBlockAlign が一致するものは従来どおり解析される ―― 明示指定の整合値で組んだ
/// 応答が既定ビルダの応答とバイト単位で一致する(追補e(3) の非回帰側)。
#[test]
fn matching_block_align_is_parsed_as_before() {
    let samples = [8192i16, -24576, 16384, 0];
    let canonical = wav_pcm16(1, 8000, &samples);
    let explicit = wav(fmt_chunk_with_block_align(1, 1, 8000, 16, 2), &pcm16(&samples));

    let canonical_bytes =
        analyze_wav_bytes(&canonical, canonical.len(), WAV_WAVEFORM_MAX_RETAINED_SAMPLES)
            .expect("既定ビルダ(整合値)");
    let explicit_bytes =
        analyze_wav_bytes(&explicit, explicit.len(), WAV_WAVEFORM_MAX_RETAINED_SAMPLES)
            .expect("block_align 明示(整合値)は従来どおり解析できること");
    assert_eq!(
        explicit_bytes, canonical_bytes,
        "整合する block_align の明示は応答を変えない"
    );
}

// ---------------------------------------------------------------------------
// root 外拒否の照合純関数(要件#48 追補a の型を wav パスにも当てる)
// ---------------------------------------------------------------------------
//
// コマンド `analyze_wav_waveform` は root 照合を**行わない**(追補d(2)=読み取り
// 経路は `vellis-asset` と同様に窓の root 配下からしか到達しない前提。ssh:// は
// `unreadable`)。ここでは照合純関数 `ensure_within_root` が wav パスでも既存の
// 型どおり働くことを**性質確認として**固定する(コマンド配線の判定ではない)。

#[test]
fn ensure_within_root_accepts_wav_under_root() {
    let root = tempfile::TempDir::new().unwrap();
    let target = root.path().join("music").join("take.wav");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, b"RIFF").unwrap();

    let resolved = ensure_within_root(root.path(), &target)
        .expect("root 配下の wav は受理されること");
    assert_eq!(resolved, std::fs::canonicalize(&target).unwrap());
}

#[test]
fn ensure_within_root_rejects_wav_outside_root() {
    let root = tempfile::TempDir::new().unwrap();
    let other = tempfile::TempDir::new().unwrap();
    let outside = other.path().join("outside.wav");
    std::fs::write(&outside, b"RIFF").unwrap();

    ensure_within_root(root.path(), &outside)
        .expect_err("root 外の wav は拒否されること(要件#48 追補a の型)");
}
