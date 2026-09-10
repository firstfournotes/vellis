//! RIFF/WAVE の波形解析(requirements.md #50 契約⑯)。
//!
//! wav だけが専用の Rust 経路を持つのは、**無圧縮だから**でしかない ―― 2時間の
//! 44.1kHz ステレオは 1.27GB あり、WebView に載せて `decodeAudioData` に渡す道は
//! 端から無い。ここで 8kHz の包絡まで落としてから IPC に載せる。
//!
//! 設計の要は3つ。
//!
//! 1. **ファイルを丸ごと持たない**。`data` はコマンド側が数 MiB ずつ読んで
//!    [`WavDecimator::push`] に流す。間引きの状態(絶対フレーム位置・部分フレームの
//!    持ち越し)は塊の切れ目を越えて保たれるので、**塊サイズを変えても応答は
//!    1バイトも変わらない**(acceptance_req50.rs が固定する性質)
//! 2. **間引きはフレーム単位の絶対位置で決める**。1出力フレームあたり入力
//!    `sourceRate / 8000` フレーム(非整数可)。入力フレーム `k` の行き先は
//!    `floor(k × 8000 / sourceRate)` ―― 塊ごとに比を掛け直すと端数が積もって
//!    時刻がずれる
//! 3. **粗レベルは生標本から直接採る**。間引き後の標本を畳み直すのではないので
//!    包絡は広い側にあり、拡大表示が「あるはずの山」を痩せさせない
//!
//! 拒否の語彙は既存の波形経路と同じ("no-audio" / "unsupported-codec" /
//! "unreadable")。構造が読めないものは no-audio・読めたが v1 対象外(RF64/BW64・
//! A-law/µ-law/ADPCM・8bit・64bit float・未知 GUID)は unsupported-codec。

/// 解析レート(Hz)。既存の decode 経路(`WAVEFORM_SAMPLE_RATE`)と同じ。
const ANALYSIS_RATE: u32 = 8000;

/// 粗レベルの刻み(出力フレーム数)。フロントの `WAVEFORM_COARSE_STEP` と同じ値。
const COARSE_STEP: u32 = 512;

/// 保持してよい 8kHz 標本の総数(全レーン合計)。フロントの
/// `WAVEFORM_MAX_RETAINED_SAMPLES`(waveform-zoom.ts)と同じ値。
pub const WAV_WAVEFORM_MAX_RETAINED_SAMPLES: u64 = 67_108_864;

/// 拒否の語彙(契約⑤=帯がそのまま文言に写す)。
pub const NO_AUDIO: &str = "no-audio";
pub const UNSUPPORTED_CODEC: &str = "unsupported-codec";
pub const UNREADABLE: &str = "unreadable";

/// `KSDATAFORMAT_SUBTYPE_PCM` のディスク上バイト列。
const GUID_PCM: [u8; 16] = [
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
];

/// `KSDATAFORMAT_SUBTYPE_IEEE_FLOAT`。
const GUID_FLOAT: [u8; 16] = [
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
];

/// `fmt ` から読み取った音の形。
#[derive(Clone, Copy, Debug)]
pub struct WavFormat {
    pub channels: u16,
    pub sample_rate: u32,
    /// 格納幅(bit)。整数は 16/24/32・float は 32 のみ。
    pub bits: u16,
    pub float: bool,
}

impl WavFormat {
    /// 1フレーム(全チャンネル1標本ずつ)のバイト数。
    pub fn bytes_per_frame(&self) -> usize {
        self.channels as usize * (self.bits as usize / 8)
    }

    /// 帯に並べるレーン数。ステレオだけ 2 本で、それ以外は 1 本(追補d)。
    fn lanes(&self) -> usize {
        if self.channels == 2 {
            2
        } else {
            1
        }
    }
}

/// 先頭 12 バイトの検分。RF64/BW64 は**サイズではなくマジックで**弾く ――
/// 4GB 超のためのコンテナ拡張で、data の実サイズが別チャンクに居る。
pub fn check_riff_magic(head: &[u8]) -> Result<(), String> {
    if head.len() < 12 {
        return Err(NO_AUDIO.to_string());
    }
    if &head[0..4] == b"RF64" || &head[0..4] == b"BW64" {
        return Err(UNSUPPORTED_CODEC.to_string());
    }
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return Err(NO_AUDIO.to_string());
    }
    Ok(())
}

/// チャンクヘッダ(id + LE サイズ)。
pub fn chunk_header(bytes: &[u8]) -> Option<([u8; 4], u64)> {
    if bytes.len() < 8 {
        return None;
    }
    let id: [u8; 4] = bytes[0..4].try_into().ok()?;
    let size = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
    Some((id, u64::from(size)))
}

/// 次のチャンクまでの前進量(宣言サイズ+奇数長の 1 バイトパディング)。
pub fn chunk_advance(size: u64) -> u64 {
    8 + size + (size & 1)
}

/// `fmt ` ペイロードの解釈。
///
/// EXTENSIBLE(0xFFFE)は **SubFormat GUID 16 バイト全体**で照合する ―― 先頭 2 バイト
/// だけを見ると、PCM と同じ 0x0001 で始まる別の SubFormat を PCM と誤認して、拒否
/// すべき入力から偽の波形を作ってしまう。
pub fn parse_fmt(payload: &[u8]) -> Result<WavFormat, String> {
    if payload.len() < 16 {
        return Err(NO_AUDIO.to_string());
    }
    let tag = u16::from_le_bytes([payload[0], payload[1]]);
    let channels = u16::from_le_bytes([payload[2], payload[3]]);
    let sample_rate = u32::from_le_bytes(payload[4..8].try_into().unwrap_or([0; 4]));
    let block_align = u16::from_le_bytes([payload[12], payload[13]]);
    let bits = u16::from_le_bytes([payload[14], payload[15]]);

    // 構造として音になっていない ―― 形式の話より前に落とす。
    if channels == 0 || sample_rate == 0 {
        return Err(NO_AUDIO.to_string());
    }

    let float = match tag {
        1 => false,
        3 => true,
        0xFFFE => {
            // cbSize=22 の拡張部(wValidBitsPerSample + dwChannelMask + SubFormat)が
            // 無ければ GUID を確かめられない=受理できない。
            if payload.len() < 40 {
                return Err(UNSUPPORTED_CODEC.to_string());
            }
            let valid_bits = u16::from_le_bytes([payload[18], payload[19]]);
            if valid_bits != bits {
                return Err(UNSUPPORTED_CODEC.to_string());
            }
            match &payload[24..40] {
                g if g == GUID_PCM => false,
                g if g == GUID_FLOAT => true,
                _ => return Err(UNSUPPORTED_CODEC.to_string()),
            }
        }
        _ => return Err(UNSUPPORTED_CODEC.to_string()),
    };

    let supported = if float {
        bits == 32
    } else {
        matches!(bits, 16 | 24 | 32)
    };
    if !supported {
        return Err(UNSUPPORTED_CODEC.to_string());
    }

    // フレームの実寸(nBlockAlign)が格納幅から算まる寸法と食い違う入力は受けない ――
    // パディング付きフレームを詰まったストライドで復号すると、拒否ではなく「嘘の波形」が
    // 出る。尊重して読み替えるのではなく落とす(2026-09-10 由谷決定)。
    if u32::from(block_align) != u32::from(channels) * u32::from(bits) / 8 {
        return Err(UNSUPPORTED_CODEC.to_string());
    }

    Ok(WavFormat {
        channels,
        sample_rate,
        bits,
        float,
    })
}

/// 間引きと粗レベルの積み上げ(塊読みの状態機械)。
///
/// `push` に流すのは `data` の中身だけ。**塊の境界は状態に現れない** ―― 部分
/// フレームは持ち越し、出力フレームの割り当てはファイル先頭からの絶対フレーム
/// 位置だけで決まる。
pub struct WavDecimator {
    format: WavFormat,
    lanes: usize,
    frames_total: u64,
    frames_out: u32,
    coarse_len: usize,
    duration_seconds: f64,
    /// 生標本を保持するか(全レーン合計が上限以下のときだけ真)。
    retain: bool,
    /// フレームに満たない持ち越しバイト。
    partial: Vec<u8>,
    /// 次に処理する入力フレームの絶対位置。
    abs_frame: u64,
    /// いま積んでいる出力フレームの番号。
    cur_bucket: u64,
    /// 出力フレームごとの符号つき絶対値最大(レーン別)。
    acc: Vec<f32>,
    acc_seen: bool,
    samples: Vec<Vec<f32>>,
    coarse_min: Vec<Vec<f32>>,
    coarse_max: Vec<Vec<f32>>,
    /// 粗レベル要素に1標本でも入ったか(min/max の初期化に要る)。
    coarse_seen: Vec<bool>,
}

impl WavDecimator {
    /// `frames_total` は解析対象の完全フレーム数(切り詰めは呼び出し側で実在分に
    /// 丸めてから渡す)。`max_retained_samples` はテストの注入 seam。
    pub fn new(
        format: WavFormat,
        frames_total: u64,
        max_retained_samples: u64,
    ) -> Result<Self, String> {
        let lanes = format.lanes();
        // 出力標本数 = ceil(入力フレーム数 × 8000 / sourceRate)。端数のフレームを
        // 落とさない(半開区間のバケット割りと同じ読み)。
        let frames_out = (u128::from(frames_total) * u128::from(ANALYSIS_RATE))
            .div_ceil(u128::from(format.sample_rate));
        let frames_out = u32::try_from(frames_out).map_err(|_| UNREADABLE.to_string())?;
        let coarse_len = frames_out.div_ceil(COARSE_STEP) as usize;
        let retain = u64::from(frames_out) * lanes as u64 <= max_retained_samples;

        Ok(Self {
            format,
            lanes,
            frames_total,
            frames_out,
            coarse_len,
            duration_seconds: frames_total as f64 / f64::from(format.sample_rate),
            retain,
            partial: Vec::with_capacity(format.bytes_per_frame()),
            abs_frame: 0,
            cur_bucket: 0,
            acc: vec![0.0; lanes],
            acc_seen: false,
            samples: if retain {
                (0..lanes)
                    .map(|_| Vec::with_capacity(frames_out as usize))
                    .collect()
            } else {
                Vec::new()
            },
            coarse_min: (0..lanes).map(|_| vec![0.0; coarse_len]).collect(),
            coarse_max: (0..lanes).map(|_| vec![0.0; coarse_len]).collect(),
            coarse_seen: vec![false; coarse_len],
        })
    }

    /// `data` の続きを流し込む。塊の切れ目は任意(フレーム境界でなくてよい)。
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
        // 端数は次の塊の先頭と繋ぐ(部分フレームは捨てない)。
        self.partial.extend_from_slice(&input[full * per_frame..]);
    }

    /// 1フレームぶんを積む。
    fn push_frame(&mut self, frame: &[u8]) {
        // 宣言サイズより実体が長い壊れ入力でも、申告したフレーム数を超えて積まない。
        if self.abs_frame >= self.frames_total {
            return;
        }

        let mut values = [0.0f32; 2];
        let channels = self.format.channels as usize;
        if self.lanes == 2 {
            values[0] = self.sample_at(frame, 0);
            values[1] = self.sample_at(frame, 1);
        } else if channels == 1 {
            values[0] = self.sample_at(frame, 0);
        } else {
            // 3ch 以上は全チャンネル平均の 1 レーンへ縮退(追補d=レーンを増やすほど
            // 1本が薄くなり、帯の高さでは形が読めなくなる)。
            let mut sum = 0.0f64;
            for c in 0..channels {
                sum += f64::from(self.sample_at(frame, c));
            }
            values[0] = (sum / channels as f64) as f32;
        }

        let bucket = self.abs_frame * u64::from(ANALYSIS_RATE) / u64::from(self.format.sample_rate);
        if bucket != self.cur_bucket {
            self.flush_bucket();
            self.cur_bucket = bucket;
        }

        for (lane, &v) in values.iter().take(self.lanes).enumerate() {
            if !self.acc_seen || v.abs() > self.acc[lane].abs() {
                self.acc[lane] = v;
            }
        }
        self.acc_seen = true;

        // 粗レベルは**生標本から直接**採る(間引き後の畳み直しではない)。
        let coarse_index = (bucket / u64::from(COARSE_STEP)) as usize;
        if coarse_index < self.coarse_len {
            let seen = self.coarse_seen[coarse_index];
            for (lane, &v) in values.iter().take(self.lanes).enumerate() {
                if !seen {
                    self.coarse_min[lane][coarse_index] = v;
                    self.coarse_max[lane][coarse_index] = v;
                } else {
                    if v < self.coarse_min[lane][coarse_index] {
                        self.coarse_min[lane][coarse_index] = v;
                    }
                    if v > self.coarse_max[lane][coarse_index] {
                        self.coarse_max[lane][coarse_index] = v;
                    }
                }
            }
            self.coarse_seen[coarse_index] = true;
        }

        self.abs_frame += 1;
    }

    /// チャンネル `c` の標本を [-1, 1] へ正規化して読む。
    fn sample_at(&self, frame: &[u8], c: usize) -> f32 {
        let width = self.format.bits as usize / 8;
        let at = c * width;
        let bytes = match frame.get(at..at + width) {
            Some(bytes) => bytes,
            None => return 0.0,
        };
        match (self.format.float, self.format.bits) {
            (true, 32) => {
                let v = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                if v.is_finite() {
                    v
                } else {
                    0.0
                }
            }
            (false, 16) => f32::from(i16::from_le_bytes([bytes[0], bytes[1]])) / 32_768.0,
            (false, 24) => {
                // 下位 3 バイト LE を符号拡張する。
                let raw = i32::from_le_bytes([0, bytes[0], bytes[1], bytes[2]]) >> 8;
                raw as f32 / 8_388_608.0
            }
            (false, 32) => {
                let raw = i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                raw as f32 / 2_147_483_648.0
            }
            _ => 0.0,
        }
    }

    /// 積み終えた出力フレームを標本列へ落とす(入力の無い出力フレームは無音)。
    fn flush_bucket(&mut self) {
        if self.retain {
            for lane in 0..self.lanes {
                let value = if self.acc_seen { self.acc[lane] } else { 0.0 };
                let out = &mut self.samples[lane];
                while (out.len() as u64) < self.cur_bucket {
                    out.push(0.0);
                }
                out.push(value);
            }
        }
        self.acc_seen = false;
    }

    /// 応答バイト列(レイアウトは acceptance_req50.rs のヘッダ doc が正本)。
    pub fn finish(mut self) -> Vec<u8> {
        if self.acc_seen {
            self.flush_bucket();
        }
        if self.retain {
            for out in &mut self.samples {
                out.resize(self.frames_out as usize, 0.0);
            }
        }

        let sample_bytes = if self.retain {
            self.lanes * self.frames_out as usize * 4
        } else {
            0
        };
        let mut bytes = Vec::with_capacity(32 + sample_bytes + self.lanes * self.coarse_len * 8);
        bytes.extend_from_slice(&u32::from(self.format.channels).to_le_bytes());
        bytes.extend_from_slice(&ANALYSIS_RATE.to_le_bytes());
        bytes.extend_from_slice(&self.frames_out.to_le_bytes());
        bytes.extend_from_slice(&COARSE_STEP.to_le_bytes());
        bytes.extend_from_slice(&(self.coarse_len as u32).to_le_bytes());
        bytes.extend_from_slice(&u32::from(self.retain).to_le_bytes());
        bytes.extend_from_slice(&self.duration_seconds.to_le_bytes());

        if self.retain {
            for out in &self.samples {
                for v in out {
                    bytes.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
        for lane in 0..self.lanes {
            for v in &self.coarse_min[lane] {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            for v in &self.coarse_max[lane] {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
        }
        bytes
    }
}

/// `fmt ` と `data` の位置決め(未知チャンクの読み飛ばし・奇数長パディング)。
///
/// 返すのは `(fmt ペイロード, data 開始位置, data 宣言サイズ)`。
fn locate_chunks(file: &[u8]) -> Result<(&[u8], usize, u64), String> {
    let mut at = 12usize;
    let mut fmt: Option<&[u8]> = None;
    let mut data: Option<(usize, u64)> = None;

    while at + 8 <= file.len() {
        let (id, size) = match chunk_header(&file[at..]) {
            Some(header) => header,
            None => break,
        };
        let payload_start = at + 8;
        if &id == b"fmt " && fmt.is_none() {
            let end = payload_start.saturating_add(size as usize).min(file.len());
            fmt = Some(&file[payload_start.min(file.len())..end]);
        } else if &id == b"data" && data.is_none() {
            data = Some((payload_start, size));
        }
        if fmt.is_some() && data.is_some() {
            break;
        }
        at = match at.checked_add(chunk_advance(size) as usize) {
            Some(next) => next,
            None => break,
        };
    }

    match (fmt, data) {
        (Some(fmt), Some((start, size))) => Ok((fmt, start, size)),
        _ => Err(NO_AUDIO.to_string()),
    }
}

/// 解析対象の完全フレーム数(切り詰めファイルは実在分へ fail-open)。
pub fn usable_frames(format: &WavFormat, declared: u64, available: u64) -> u64 {
    let per_frame = format.bytes_per_frame() as u64;
    if per_frame == 0 {
        return 0;
    }
    declared.min(available) / per_frame
}

/// wav バイト列を解析して IPC 応答の raw バイト列を作る純関数コア。
///
/// `read_chunk_len`(≧1)は `data` を読む塊の最大バイト数で、コマンド側は数 MiB を
/// 渡し、テストは小さな値でチャンク境界跨ぎを起こす ―― **応答は塊サイズに依らない**。
pub fn analyze_wav_bytes(
    file: &[u8],
    read_chunk_len: usize,
    max_retained_samples: u64,
) -> Result<Vec<u8>, String> {
    check_riff_magic(file)?;
    let (fmt_payload, data_start, declared) = locate_chunks(file)?;
    let format = parse_fmt(fmt_payload)?;

    let available = (file.len() - data_start.min(file.len())) as u64;
    let frames = usable_frames(&format, declared, available);
    if frames == 0 {
        return Err(NO_AUDIO.to_string());
    }

    let mut decimator = WavDecimator::new(format, frames, max_retained_samples)?;
    let end = data_start + (frames as usize) * format.bytes_per_frame();
    for chunk in file[data_start..end].chunks(read_chunk_len.max(1)) {
        decimator.push(chunk);
    }
    Ok(decimator.finish())
}
