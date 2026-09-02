//! 要件#41 の受け入れテスト(requirements.md #41)— Rust 層
//!
//! 「動画ビューアに音声波形タイムラインを追加する」のうち、契約③改訂
//! (2026-09-01 実機プローブ)で決まった mov(QuickTime)経路=**音声トラックの
//! 無再エンコード抽出**の純関数部分を判定する:
//! - サンプル表走査(stsd/stsc/stsz/stco/co64 → サンプルのバイト範囲列+
//!   再梱包の材料= stsd 箱・timescale・stts)
//! - **m4a 再梱包**(AAC/ALAC のサンプル列+元 stsd → 最小 m4a バイト列)
//! - WAV ヘッダ包装(整数 PCM → format 1・float32 lpcm → format 3=IEEE float)+
//!   16bit BE→LE スワップ(twos 用)
//!
//! 背景(実測事実): webm(VP8/VP9+Opus)は decodeAudioData で復号できるため
//! fetch 経路のまま。mov は QuickTime コンテナを decodeAudioData が食えないため、
//! Rust 側で再梱包して ArrayBuffer をフロントに渡す。音声なしと非対応コンテナは
//! decode 例外では区別不能のため、出し分けの根拠はこの抽出結果が担う。
//! **ADTS 再構成は不採用**(AAC プライミングで波形が 23〜48ms 遅れ、ずれ量が
//! エンコーダ依存で補正不能=実測。m4a 再梱包ならサンプル単位で完全一致)。
//! 出力は「AAC/ALAC → 最小 m4a へ無再エンコード再梱包・PCM → WAV 包装」の2分岐。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/audio_extract.rs(`vellis_lib::audio_extract`)
//!
//! /// mdat 内の1サンプル(= AAC/ALAC の1フレーム/PCM の1ブロック)のバイト範囲
//! /// (ファイル先頭起点)。
//! #[derive(Debug, Clone, PartialEq, Eq)]
//! pub struct SampleRange {
//!     pub offset: u64,
//!     pub size: u32,
//! }
//!
//! /// stsd のサンプル記述 fourcc から判定した音声トラックのコーデック。
//! /// m4a 再梱包は stsd を丸ごと流用するため、esds の中身は読まなくてよい。
//! #[derive(Debug, Clone, PartialEq, Eq)]
//! pub enum AudioCodec {
//!     /// mp4a(→ m4a 再梱包)。
//!     Aac,
//!     /// alac(→ m4a 再梱包)。
//!     Alac,
//!     /// 非圧縮 PCM(→ WAV 包装)。sowt=16bit LE・twos=16bit BE(v0/v1 記述:
//!     /// rate は 16.16 固定小数の整数部・channels/bits も同記述から。float=false)。
//!     /// lpcm= **v2 サウンド記述**から読む: audioSampleRate(Float64 BE)・
//!     /// numAudioChannels・constBitsPerChannel・formatSpecificFlags
//!     /// (bit0=float・bit1=big-endian)。対応範囲=整数 16/24bit(LE/BE)と
//!     /// **float32(LE・インターリーブ→ WAV format 3)**。**BE float・
//!     /// 非インターリーブ等の lpcm 変形は Unsupported**(契約③(b)⑤=正本)。
//!     Pcm { sample_rate: u32, channels: u16, bits_per_sample: u16, big_endian: bool, float: bool },
//!     /// それ以外(AC-3 等・BE float 等の lpcm 変形=unsupported-codec 縮退の根拠)。
//!     Unsupported,
//! }
//!
//! /// 最初の音声トラック(hdlr == b"soun")の抽出計画+再梱包の材料。
//! #[derive(Debug, Clone, PartialEq, Eq)]
//! pub struct AudioExtractionPlan {
//!     pub codec: AudioCodec,
//!     pub ranges: Vec<SampleRange>,
//!     /// mdhd の timescale(m4a 再梱包の mdhd/stts 用)。
//!     pub timescale: u32,
//!     /// stts のランレングス列((sample_count, sample_delta))。箱が無ければ空
//!     /// (WAV 経路は使わない。m4a 経路の成立可否は remux_m4a 側で弾く)。
//!     pub stts: Vec<(u32, u32)>,
//!     /// 元 stsd 箱**まるごと**のバイト列(m4a 再梱包でそのまま埋める)。
//!     pub stsd: Vec<u8>,
//! }
//!
//! /// ファイル先頭からのバイト列 → 音声トラックの抽出計画。
//! /// - 箱歩きは video_frames.rs と同じ流儀: トップレベル走査で moov を見つけ
//! ///   (moov 後置可)、moov→trak→mdia→(hdlr/mdhd/minf→stbl)の必要な箱だけ
//! ///   読み、未知の箱は読み飛ばす。兄弟箱の順序に依存しない。mdhd と
//! ///   サウンドサンプル記述は version 1(QuickTime 方言)も受ける
//! /// - hdlr == b"soun" の最初のトラックを採る。音声トラックが無ければ None
//! ///   (=フロントの no-audio 縮退の根拠)
//! /// - ranges は stsc(first_chunk は 1 起点・最終エントリは残り全チャンクに適用)
//! ///   × stsz(sample_size != 0 の一様形と per-sample 形の両方)× stco(32bit)
//! ///   または co64(64bit)から組む。サンプル数= stsz の件数
//! /// - 解析不能(moov なし・表の欠落・stsz 0件・チャンク不足・壊れたサイズ)は
//! ///   すべて None。panic しない(fail-open)。コーデックが読めないだけなら
//! ///   None ではなく codec=Unsupported(音声トラック自体は在る)
//! /// - 範囲がファイル実体の外を指す壊れファイルの読み時の縮退はコマンド側
//! ///   (このテストの対象外= reviewer 照合)
//! pub fn parse_audio_extraction(bytes: &[u8]) -> Option<AudioExtractionPlan>;
//!
//! /// AAC/ALAC のサンプル列を最小 m4a(mp4 コンテナ)へ無再エンコード再梱包する。
//! /// - `stsd`: 元ファイルの stsd 箱まるごと(mp4a+esds / alac+cookie 入り)。
//! ///   出力の stbl に**そのまま**埋める(中身は解釈しない=コーデック非依存)
//! /// - `samples`: 各サンプルのバイト列(呼び出し側が SampleRange で切り出したもの)
//! /// - `timescale`: 元トラックの mdhd timescale
//! /// - `stts`: 元トラックの stts ランレングス。総 sample_count が samples.len() と
//! ///   一致しない・samples が空 → None(それ以外で panic しない)
//! /// 出力: ftyp(先頭)+ moov(音声1トラック: hdlr=soun・mdhd に timescale・
//! /// stbl に stsd/stts/stsc/stsz/stco)+ mdat(サンプルバイトの連結)。
//! /// 新しい stco/co64 は**詰め直した mdat 内のオフセット**(出力ファイル先頭起点)
//! /// を指し、表を辿ると各サンプルが元のバイト列のまま読み戻せる。stsz は一様形
//! /// でも per-sample 形でもよい。箱はすべて 32bit サイズで足りる(256MiB 上限内)。
//! /// 実際に decodeAudioData が食うかは実機=人間ゲート(構造の整合をここで固定)。
//! pub fn remux_m4a(
//!     stsd: &[u8], samples: &[&[u8]], timescale: u32, stts: &[(u32, u32)],
//! ) -> Option<Vec<u8>>;
//!
//! /// 16bit BE PCM(twos)を LE へスワップする(WAV は LE)。奇数長は None。
//! pub fn pcm16_be_to_le(data: &[u8]) -> Option<Vec<u8>>;
//!
//! /// PCM(整数・リトルエンディアン)を WAV に包む(44バイトの RIFF/WAVE/fmt/data
//! /// ヘッダ+データ。fmt は PCM=1・byte_rate と block_align はパラメタから計算)。
//! pub fn wrap_wav(pcm: &[u8], channels: u16, sample_rate: u32, bits_per_sample: u16) -> Vec<u8>;
//!
//! /// float32 PCM(リトルエンディアン)を WAV に包む(fmt の format=3=IEEE float・
//! /// bits=32。ヘッダ構成は wrap_wav と同じ 44 バイト)。float32 lpcm の包装先。
//! pub fn wrap_wav_float32(pcm: &[u8], channels: u16, sample_rate: u32) -> Vec<u8>;
//! ```
//!
//! コマンド(契約③改訂=Rust 追加は mov 抽出コマンド1本。例: `extract_waveform_audio`)
//! の Tauri 配線・応答形(256MiB 級のバイト列は `tauri::ipc::Response` 等の raw 経路)・
//! ファイル読み・フロント(WaveformExtract)への写しは reviewer 照合(本テストの判定
//! 対象外)。TS 側の経路判定・上限・縮退分岐は src/lib/audio-waveform.acceptance.test.ts
//! が判定する。PCM の v1 対応範囲(契約③(b)= requirements.md 45行目が正本)=
//! sowt・twos の 16bit(v0/v1 記述)+ lpcm(v2 記述)の**整数 16/24bit(LE/BE)と
//! float32(LE・インターリーブ→ WAV format 3)**。**BE float・非インターリーブ等の
//! lpcm 変形は Unsupported(縮退)**。
//!
//! フィクスチャはすべて本ファイル内でバイト列合成する(実動画のコミットなし=
//! acceptance_req37.rs の作法)。実 mov(AAC/ALAC/PCM)で decodeAudioData が
//! 波形を返すことは人間ゲート。

use vellis_lib::audio_extract::{
    parse_audio_extraction, pcm16_be_to_le, remux_m4a, wrap_wav, wrap_wav_float32, AudioCodec,
    SampleRange,
};

// ---------------------------------------------------------------------------
// フィクスチャ合成ヘルパ(ISO BMFF / QuickTime の箱を最小構成で組む)
// ---------------------------------------------------------------------------

/// 32bit サイズの箱(size はヘッダ8バイトを含む)。
fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(payload.len() + 8);
    b.extend_from_slice(&(payload.len() as u32 + 8).to_be_bytes());
    b.extend_from_slice(kind);
    b.extend_from_slice(payload);
    b
}

/// 子箱を連結して入れるコンテナ箱。
fn container(kind: &[u8; 4], children: &[&[u8]]) -> Vec<u8> {
    let payload: Vec<u8> = children.iter().flat_map(|c| c.iter().copied()).collect();
    mp4_box(kind, &payload)
}

/// full box のペイロード先頭(version + flags)。
fn full_header(version: u8) -> Vec<u8> {
    vec![version, 0, 0, 0]
}

/// mdhd v0(timescale の供給源)。
fn mdhd(timescale: u32) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    p.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    p.extend_from_slice(&timescale.to_be_bytes());
    p.extend_from_slice(&999_999u32.to_be_bytes()); // duration(ダミー)
    p.extend_from_slice(&0x55c4u16.to_be_bytes()); // language "und"
    p.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    mp4_box(b"mdhd", &p)
}

/// mdhd v1(creation/modification/duration が 64bit の QuickTime 方言)。
fn mdhd_v1(timescale: u32) -> Vec<u8> {
    let mut p = full_header(1);
    p.extend_from_slice(&0u64.to_be_bytes());
    p.extend_from_slice(&0u64.to_be_bytes());
    p.extend_from_slice(&timescale.to_be_bytes());
    p.extend_from_slice(&999_999u64.to_be_bytes());
    p.extend_from_slice(&0x55c4u16.to_be_bytes());
    p.extend_from_slice(&0u16.to_be_bytes());
    mp4_box(b"mdhd", &p)
}

/// hdlr(handler_type でトラック種別を判定させる)。
fn hdlr(handler_type: &[u8; 4]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&[0u8; 4]); // pre_defined
    p.extend_from_slice(handler_type);
    p.extend_from_slice(&[0u8; 12]); // reserved
    p.extend_from_slice(b"Handler\0");
    mp4_box(b"hdlr", &p)
}

fn tkhd_dummy() -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&[0u8; 80]);
    mp4_box(b"tkhd", &p)
}

fn stsd_dummy() -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&0u32.to_be_bytes()); // entry_count 0
    mp4_box(b"stsd", &p)
}

fn mvhd_dummy() -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&[0u8; 96]);
    mp4_box(b"mvhd", &p)
}

/// AAC-LC・44.1kHz・2ch の AudioSpecificConfig(0x12 0x10)を含む esds ペイロード。
/// 再梱包は stsd を丸ごと流用するため中身は解釈されないが、実ファイルに忠実な
/// 形で持たせる(ES_Descriptor 0x03 > DecoderConfig 0x04 > DecSpecificInfo 0x05)。
fn esds_payload() -> Vec<u8> {
    let asc: &[u8] = &[0x12, 0x10];
    let dsi_len = asc.len() as u8;
    let dcd_len = 13 + 2 + dsi_len;
    let es_len = 3 + 2 + dcd_len;
    let mut p = full_header(0);
    p.push(0x03);
    p.push(es_len);
    p.extend_from_slice(&1u16.to_be_bytes()); // ES_ID
    p.push(0); // フラグなし
    p.push(0x04);
    p.push(dcd_len);
    p.push(0x40); // objectTypeIndication = MPEG-4 Audio
    p.push(0x15); // streamType=audio(5)<<2 | reserved 1
    p.extend_from_slice(&[0, 0, 0]); // bufferSizeDB
    p.extend_from_slice(&0u32.to_be_bytes()); // maxBitrate
    p.extend_from_slice(&0u32.to_be_bytes()); // avgBitrate
    p.push(0x05);
    p.push(dsi_len);
    p.extend_from_slice(asc);
    p
}

/// stsd 内のサウンドサンプル記述(2ch・16bit・44100Hz の 16.16 固定小数)。
/// version 1(QuickTime 方言)は samplerate の後に 16 バイトの追補が付く。
fn sound_entry(fourcc: &[u8; 4], version: u16, children: &[&[u8]]) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(&[0u8; 6]); // reserved
    p.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    p.extend_from_slice(&version.to_be_bytes());
    p.extend_from_slice(&0u16.to_be_bytes()); // revision
    p.extend_from_slice(&[0u8; 4]); // vendor
    p.extend_from_slice(&2u16.to_be_bytes()); // channelcount
    p.extend_from_slice(&16u16.to_be_bytes()); // samplesize
    p.extend_from_slice(&0u16.to_be_bytes()); // compression_id
    p.extend_from_slice(&0u16.to_be_bytes()); // packet_size
    p.extend_from_slice(&(44100u32 << 16).to_be_bytes()); // samplerate 16.16
    if version == 1 {
        p.extend_from_slice(&[0u8; 16]); // QT v1 の samples/packet 等の追補
    }
    for c in children {
        p.extend_from_slice(c);
    }
    mp4_box(fourcc, &p)
}

/// formatSpecificFlags のビット(CoreAudio LPCM フラグ)。
const LPCM_FLAG_FLOAT: u32 = 0x1;
const LPCM_FLAG_BIG_ENDIAN: u32 = 0x2;
const LPCM_FLAG_SIGNED: u32 = 0x4;
const LPCM_FLAG_PACKED: u32 = 0x8;

/// lpcm の **v2 サウンド記述**(QuickTime)。rate は Float64 BE・channels/bits は
/// 32bit 幅・formatSpecificFlags で float/エンディアンを示す。
fn lpcm_entry_v2(sample_rate: f64, channels: u32, bits: u32, flags: u32) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(&[0u8; 6]); // reserved
    p.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    p.extend_from_slice(&2u16.to_be_bytes()); // version = 2
    p.extend_from_slice(&0u16.to_be_bytes()); // revision
    p.extend_from_slice(&[0u8; 4]); // vendor
    p.extend_from_slice(&3u16.to_be_bytes()); // always3
    p.extend_from_slice(&16u16.to_be_bytes()); // always16
    p.extend_from_slice(&0xFFFEu16.to_be_bytes()); // alwaysMinus2
    p.extend_from_slice(&0u16.to_be_bytes()); // always0
    p.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // always65536
    p.extend_from_slice(&72u32.to_be_bytes()); // sizeOfStructOnly
    p.extend_from_slice(&sample_rate.to_be_bytes()); // audioSampleRate(Float64)
    p.extend_from_slice(&channels.to_be_bytes()); // numAudioChannels
    p.extend_from_slice(&0x7F00_0000u32.to_be_bytes()); // always7F000000
    p.extend_from_slice(&bits.to_be_bytes()); // constBitsPerChannel
    p.extend_from_slice(&flags.to_be_bytes()); // formatSpecificFlags
    p.extend_from_slice(&(channels * bits / 8).to_be_bytes()); // constBytesPerAudioPacket
    p.extend_from_slice(&1u32.to_be_bytes()); // constLPCMFramesPerAudioPacket
    mp4_box(b"lpcm", &p)
}

fn stsd(entry: &[u8]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&1u32.to_be_bytes()); // entry_count 1
    p.extend_from_slice(entry);
    mp4_box(b"stsd", &p)
}

/// mp4a+esds の標準サンプル記述(AAC フィクスチャの共通部品)。
fn mp4a_entry() -> Vec<u8> {
    sound_entry(b"mp4a", 0, &[&mp4_box(b"esds", &esds_payload())])
}

/// stts((sample_count, sample_delta) のランレングス列)。
fn stts(entries: &[(u32, u32)]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (count, delta) in entries {
        p.extend_from_slice(&count.to_be_bytes());
        p.extend_from_slice(&delta.to_be_bytes());
    }
    mp4_box(b"stts", &p)
}

/// stsc((first_chunk, samples_per_chunk) 列・sample_description_index は 1 固定)。
fn stsc(entries: &[(u32, u32)]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (first, per) in entries {
        p.extend_from_slice(&first.to_be_bytes());
        p.extend_from_slice(&per.to_be_bytes());
        p.extend_from_slice(&1u32.to_be_bytes());
    }
    mp4_box(b"stsc", &p)
}

/// stsz(per-sample のサイズ列)。
fn stsz_sizes(sizes: &[u32]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&0u32.to_be_bytes()); // sample_size 0 = per-sample
    p.extend_from_slice(&(sizes.len() as u32).to_be_bytes());
    for s in sizes {
        p.extend_from_slice(&s.to_be_bytes());
    }
    mp4_box(b"stsz", &p)
}

/// stsz(一様サイズ形= sample_size != 0)。
fn stsz_uniform(size: u32, count: u32) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&size.to_be_bytes());
    p.extend_from_slice(&count.to_be_bytes());
    mp4_box(b"stsz", &p)
}

fn stco(offsets: &[u32]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&(offsets.len() as u32).to_be_bytes());
    for o in offsets {
        p.extend_from_slice(&o.to_be_bytes());
    }
    mp4_box(b"stco", &p)
}

fn co64(offsets: &[u64]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&(offsets.len() as u32).to_be_bytes());
    for o in offsets {
        p.extend_from_slice(&o.to_be_bytes());
    }
    mp4_box(b"co64", &p)
}

/// trak > mdia > (mdhd, hdlr=soun, minf > stbl > (stsd, tables…))。
fn audio_trak(entry: &[u8], tables: &[&[u8]]) -> Vec<u8> {
    audio_trak_with_mdhd(&mdhd(44100), entry, tables)
}

fn audio_trak_with_mdhd(mdhd_b: &[u8], entry: &[u8], tables: &[&[u8]]) -> Vec<u8> {
    let stsd_b = stsd(entry);
    let mut children: Vec<&[u8]> = vec![&stsd_b];
    children.extend_from_slice(tables);
    let stbl = container(b"stbl", &children);
    let minf = container(b"minf", &[&stbl]);
    let mdia = container(b"mdia", &[mdhd_b, &hdlr(b"soun"), &minf]);
    container(b"trak", &[&tkhd_dummy(), &mdia])
}

/// 音声パーサが読み飛ばすべき映像トラック(表は持たない最小形)。
fn video_trak_dummy() -> Vec<u8> {
    let stbl = container(b"stbl", &[&stsd_dummy()]);
    let minf = container(b"minf", &[&stbl]);
    let mdia = container(b"mdia", &[&mdhd(30000), &hdlr(b"vide"), &minf]);
    container(b"trak", &[&tkhd_dummy(), &mdia])
}

fn ftyp() -> Vec<u8> {
    mp4_box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2mp41")
}

fn mdat(len: usize) -> Vec<u8> {
    mp4_box(b"mdat", &vec![0xEEu8; len])
}

/// ftyp + moov(mvhd + トラック列)+ mdat の素直な並び。
fn build_movie(traks: &[Vec<u8>]) -> Vec<u8> {
    let mvhd = mvhd_dummy();
    let mut children: Vec<&[u8]> = vec![&mvhd];
    for t in traks {
        children.push(t);
    }
    let moov = container(b"moov", &children);
    let mut file = ftyp();
    file.extend_from_slice(&moov);
    file.extend_from_slice(&mdat(1024));
    file
}

fn r(offset: u64, size: u32) -> SampleRange {
    SampleRange { offset, size }
}

/// AAC(mp4a+esds)・per-sample stsz・stsc 2エントリ・stco の標準フィクスチャ。
/// 期待 ranges: チャンク1(@100)=2サンプル・チャンク2(@300)=2サンプル・
/// チャンク3(@500)=3サンプル(最終エントリが残り全チャンクに適用)。
fn aac_movie() -> Vec<u8> {
    build_movie(&[
        video_trak_dummy(),
        audio_trak(
            &mp4a_entry(),
            &[
                &stts(&[(7, 1024)]),
                &stsc(&[(1, 2), (3, 3)]),
                &stsz_sizes(&[10, 20, 30, 40, 50, 60, 70]),
                &stco(&[100, 300, 500]),
            ],
        ),
    ])
}

fn expected_aac_ranges() -> Vec<SampleRange> {
    vec![
        r(100, 10),
        r(110, 20),
        r(300, 30),
        r(330, 40),
        r(500, 50),
        r(550, 60),
        r(610, 70),
    ]
}

// ---------------------------------------------------------------------------
// 出力 m4a の読み戻しヘルパ(remux_m4a の検証本体)
// ---------------------------------------------------------------------------

/// 兄弟箱列から最初の kind を探し、(箱全体, ペイロード) を返す。
/// 契約=出力は 32bit サイズ箱のみなので largesize は扱わない。
fn find_box<'a>(mut data: &'a [u8], kind: &[u8; 4]) -> Option<(&'a [u8], &'a [u8])> {
    while data.len() >= 8 {
        let size = u32::from_be_bytes(data[0..4].try_into().unwrap()) as usize;
        if size < 8 || size > data.len() {
            return None;
        }
        if &data[4..8] == kind {
            return Some((&data[..size], &data[8..size]));
        }
        data = &data[size..];
    }
    None
}

/// 出力 m4a を箱歩きで読み戻し、再梱包の整合を検証する。
/// 観点: 先頭 ftyp・moov/mdat の存在・hdlr=soun・mdhd timescale・stsd 丸ごと一致・
/// stts ランレングス一致・stsz 整合・stsc×stco/co64 の表を辿った読み戻しが
/// 元サンプルと一致・mdat がサンプル連結と一致。
fn assert_valid_m4a(
    out: &[u8],
    stsd_in: &[u8],
    samples: &[&[u8]],
    timescale: u32,
    stts_in: &[(u32, u32)],
) {
    assert!(out.len() >= 8, "出力が短すぎる");
    assert_eq!(&out[4..8], b"ftyp", "先頭の箱は ftyp");
    let (_, moov) = find_box(out, b"moov").expect("moov があること");
    let (_, mdat_p) = find_box(out, b"mdat").expect("mdat があること");

    let concat: Vec<u8> = samples.iter().flat_map(|s| s.iter().copied()).collect();
    assert_eq!(mdat_p, &concat[..], "mdat はサンプルバイトの連結と一致");

    let (_, trak) = find_box(moov, b"trak").expect("trak があること");
    let (_, mdia) = find_box(trak, b"mdia").expect("mdia があること");
    let (_, hdlr_p) = find_box(mdia, b"hdlr").expect("hdlr があること");
    assert_eq!(&hdlr_p[8..12], b"soun", "handler_type は soun");

    let (_, mdhd_p) = find_box(mdia, b"mdhd").expect("mdhd があること");
    let ts = if mdhd_p[0] == 1 {
        u32::from_be_bytes(mdhd_p[20..24].try_into().unwrap())
    } else {
        u32::from_be_bytes(mdhd_p[12..16].try_into().unwrap())
    };
    assert_eq!(ts, timescale, "mdhd の timescale は元トラックの値");

    let (_, minf) = find_box(mdia, b"minf").expect("minf があること");
    let (_, stbl) = find_box(minf, b"stbl").expect("stbl があること");

    let (stsd_full, _) = find_box(stbl, b"stsd").expect("stsd があること");
    assert_eq!(stsd_full, stsd_in, "stsd は元の箱まるごとそのまま");

    let (_, stts_p) = find_box(stbl, b"stts").expect("stts があること");
    let n = u32::from_be_bytes(stts_p[4..8].try_into().unwrap()) as usize;
    let runs: Vec<(u32, u32)> = (0..n)
        .map(|i| {
            let at = 8 + i * 8;
            (
                u32::from_be_bytes(stts_p[at..at + 4].try_into().unwrap()),
                u32::from_be_bytes(stts_p[at + 4..at + 8].try_into().unwrap()),
            )
        })
        .collect();
    assert_eq!(runs, stts_in, "stts は元のランレングスをそのまま");

    // stsz は一様形・per-sample 形のどちらでもよい(実サイズ列に正規化して比較)。
    let (_, stsz_p) = find_box(stbl, b"stsz").expect("stsz があること");
    let uniform = u32::from_be_bytes(stsz_p[4..8].try_into().unwrap());
    let count = u32::from_be_bytes(stsz_p[8..12].try_into().unwrap()) as usize;
    assert_eq!(count, samples.len(), "stsz のサンプル数");
    let sizes: Vec<u32> = if uniform != 0 {
        vec![uniform; count]
    } else {
        (0..count)
            .map(|i| u32::from_be_bytes(stsz_p[12 + i * 4..16 + i * 4].try_into().unwrap()))
            .collect()
    };
    let expected_sizes: Vec<u32> = samples.iter().map(|s| s.len() as u32).collect();
    assert_eq!(sizes, expected_sizes, "stsz はサンプル長と一致");

    // stsc × stco/co64 を辿り、出力ファイル自身から各サンプルを読み戻して照合する
    // (チャンクの切り方は実装裁量。表がバイト位置と辻褄が合うことだけを固定)。
    let (_, stsc_p) = find_box(stbl, b"stsc").expect("stsc があること");
    let sn = u32::from_be_bytes(stsc_p[4..8].try_into().unwrap()) as usize;
    let stsc_runs: Vec<(u32, u32)> = (0..sn)
        .map(|i| {
            let at = 8 + i * 12;
            (
                u32::from_be_bytes(stsc_p[at..at + 4].try_into().unwrap()),
                u32::from_be_bytes(stsc_p[at + 4..at + 8].try_into().unwrap()),
            )
        })
        .collect();
    let offsets: Vec<u64> = if let Some((_, p)) = find_box(stbl, b"stco") {
        let n = u32::from_be_bytes(p[4..8].try_into().unwrap()) as usize;
        (0..n)
            .map(|i| u32::from_be_bytes(p[8 + i * 4..12 + i * 4].try_into().unwrap()) as u64)
            .collect()
    } else if let Some((_, p)) = find_box(stbl, b"co64") {
        let n = u32::from_be_bytes(p[4..8].try_into().unwrap()) as usize;
        (0..n)
            .map(|i| u64::from_be_bytes(p[8 + i * 8..16 + i * 8].try_into().unwrap()))
            .collect()
    } else {
        panic!("stco / co64 のどちらかがあること");
    };

    let mut sample_idx = 0usize;
    'chunks: for (ci, &chunk_off) in offsets.iter().enumerate() {
        let chunk_no = (ci + 1) as u32;
        let per = stsc_runs
            .iter()
            .take_while(|(first, _)| *first <= chunk_no)
            .last()
            .map(|(_, per)| *per)
            .unwrap_or(0);
        let mut at = chunk_off as usize;
        for _ in 0..per {
            if sample_idx >= sizes.len() {
                break 'chunks;
            }
            let size = sizes[sample_idx] as usize;
            assert!(at + size <= out.len(), "表が出力ファイルの外を指している");
            assert_eq!(
                &out[at..at + size],
                samples[sample_idx],
                "サンプル {sample_idx} が表の指す位置から元のバイト列のまま読み戻せること"
            );
            at += size;
            sample_idx += 1;
        }
    }
    assert_eq!(sample_idx, samples.len(), "表の指すサンプル数が揃うこと");
}

// ---------------------------------------------------------------------------
// サンプル表走査 — 正常系(stsd/stsc/stsz/stco/co64 → 範囲列+再梱包材料)
// ---------------------------------------------------------------------------

/// mp4a トラックから分類・範囲列・再梱包材料(timescale/stts/stsd 丸ごと)を得る。
/// 映像トラックが先に居ても hdlr=soun のトラックを採る。stsc の最終エントリは
/// 残り全チャンクに適用。
#[test]
fn aac_plan_yields_codec_tables_and_ranges() {
    let plan = parse_audio_extraction(&aac_movie()).expect("最小 AAC MP4 が解析できること");

    assert_eq!(plan.codec, AudioCodec::Aac, "mp4a は Aac(m4a 再梱包経路)");
    assert_eq!(plan.ranges, expected_aac_ranges());
    assert_eq!(plan.timescale, 44100, "timescale は mdhd から");
    assert_eq!(plan.stts, vec![(7, 1024)], "stts ランレングスをそのまま持ち帰る");
    assert_eq!(plan.stsd, stsd(&mp4a_entry()), "stsd は箱まるごと(再梱包で流用)");
}

/// 一様サイズの stsz(sample_size != 0)でも範囲列を組める。
#[test]
fn uniform_stsz_yields_equal_sized_ranges() {
    let file = build_movie(&[audio_trak(
        &mp4a_entry(),
        &[&stts(&[(5, 1024)]), &stsc(&[(1, 5)]), &stsz_uniform(4, 5), &stco(&[64])],
    )]);
    let plan = parse_audio_extraction(&file).expect("一様 stsz が解析できること");

    assert_eq!(
        plan.ranges,
        vec![r(64, 4), r(68, 4), r(72, 4), r(76, 4), r(80, 4)]
    );
}

/// co64(64bit チャンクオフセット)を読める(4GiB 超のオフセット)。
#[test]
fn co64_reads_64bit_chunk_offsets() {
    let base: u64 = 0x1_0000_0010; // u32 に収まらないオフセット
    let file = build_movie(&[audio_trak(
        &mp4a_entry(),
        &[&stts(&[(3, 1024)]), &stsc(&[(1, 3)]), &stsz_uniform(4, 3), &co64(&[base])],
    )]);
    let plan = parse_audio_extraction(&file).expect("co64 が解析できること");

    assert_eq!(plan.ranges, vec![r(base, 4), r(base + 4, 4), r(base + 8, 4)]);
}

/// PCM の分類: sowt(16bit LE)と twos(16bit BE)を endian フラグ付きで返す。
/// stts の無いトラック(WAV 経路は使わない)は stts が空で通る。
#[test]
fn pcm_variants_sowt_and_twos_are_classified() {
    for (fourcc, big_endian) in [(b"sowt", false), (b"twos", true)] {
        let file = build_movie(&[audio_trak(
            &sound_entry(fourcc, 0, &[]),
            &[&stsc(&[(1, 2)]), &stsz_uniform(4, 2), &stco(&[100])],
        )]);
        let plan = parse_audio_extraction(&file).expect("PCM トラックが解析できること");

        assert_eq!(
            plan.codec,
            AudioCodec::Pcm {
                sample_rate: 44100,
                channels: 2,
                bits_per_sample: 16,
                big_endian,
                float: false,
            },
            "fourcc={:?}",
            std::str::from_utf8(fourcc).unwrap()
        );
        assert_eq!(plan.ranges, vec![r(100, 4), r(104, 4)]);
        assert!(plan.stts.is_empty(), "stts 無しは空(None にしない)");
    }
}

/// lpcm(v2 サウンド記述)の分類: audioSampleRate(Float64)・numAudioChannels・
/// constBitsPerChannel・formatSpecificFlags から読む。**整数 16/24bit(LE/BE)と
/// float32(LE)は Pcm・BE float は Unsupported**(契約③(b)⑤=正本)。
#[test]
fn lpcm_v2_descriptions_are_classified() {
    let cases: [(f64, u32, u32, u32, AudioCodec); 5] = [
        (
            48000.0,
            2,
            16,
            LPCM_FLAG_SIGNED | LPCM_FLAG_PACKED,
            AudioCodec::Pcm {
                sample_rate: 48000,
                channels: 2,
                bits_per_sample: 16,
                big_endian: false,
                float: false,
            },
        ),
        (
            48000.0,
            2,
            16,
            LPCM_FLAG_BIG_ENDIAN | LPCM_FLAG_SIGNED | LPCM_FLAG_PACKED,
            AudioCodec::Pcm {
                sample_rate: 48000,
                channels: 2,
                bits_per_sample: 16,
                big_endian: true,
                float: false,
            },
        ),
        (
            44100.0,
            1,
            24,
            LPCM_FLAG_SIGNED | LPCM_FLAG_PACKED,
            AudioCodec::Pcm {
                sample_rate: 44100,
                channels: 1,
                bits_per_sample: 24,
                big_endian: false,
                float: false,
            },
        ),
        // float32(LE・インターリーブ)は WAV(IEEE float)包装対象 → Pcm。
        (
            44100.0,
            1,
            32,
            LPCM_FLAG_FLOAT | LPCM_FLAG_PACKED,
            AudioCodec::Pcm {
                sample_rate: 44100,
                channels: 1,
                bits_per_sample: 32,
                big_endian: false,
                float: true,
            },
        ),
        // BE float は lpcm 変形=音声トラックは在るが縮退 → Unsupported。
        (
            44100.0,
            1,
            32,
            LPCM_FLAG_FLOAT | LPCM_FLAG_BIG_ENDIAN | LPCM_FLAG_PACKED,
            AudioCodec::Unsupported,
        ),
    ];

    for (rate, channels, bits, flags, expected) in cases {
        let file = build_movie(&[audio_trak(
            &lpcm_entry_v2(rate, channels, bits, flags),
            &[&stsc(&[(1, 2)]), &stsz_uniform(4, 2), &stco(&[100])],
        )]);
        let plan = parse_audio_extraction(&file).expect("lpcm v2 記述が解析できること");

        assert_eq!(plan.codec, expected, "rate={rate} bits={bits} flags={flags:#x}");
        assert_eq!(plan.ranges, vec![r(100, 4), r(104, 4)]);
    }
}

/// alac は Alac(m4a 再梱包経路)。stsd(alac+magic cookie)を丸ごと持ち帰る。
#[test]
fn alac_is_classified_for_m4a_route() {
    let entry = sound_entry(b"alac", 0, &[&mp4_box(b"alac", &[0u8; 24])]);
    let file = build_movie(&[audio_trak(
        &entry,
        &[&stts(&[(2, 4096)]), &stsc(&[(1, 2)]), &stsz_sizes(&[9, 11]), &stco(&[100])],
    )]);
    let plan = parse_audio_extraction(&file).expect("ALAC トラックが解析できること");

    assert_eq!(plan.codec, AudioCodec::Alac);
    assert_eq!(plan.ranges, vec![r(100, 9), r(109, 11)]);
    assert_eq!(plan.stsd, stsd(&entry));
}

/// AAC/ALAC/PCM 以外(AC-3 等)は Unsupported(音声トラックは在る=None ではない。
/// フロントの unsupported-codec 縮退の根拠)。範囲列は同じ規則で組む。
#[test]
fn unsupported_codecs_are_classified_not_none() {
    for fourcc in [b"ac-3", b"xxxx"] {
        let file = build_movie(&[audio_trak(
            &sound_entry(fourcc, 0, &[]),
            &[&stsc(&[(1, 2)]), &stsz_uniform(8, 2), &stco(&[100])],
        )]);
        let plan =
            parse_audio_extraction(&file).expect("未対応コーデックでも Some(縮退の判別用)");

        assert_eq!(plan.codec, AudioCodec::Unsupported);
        assert_eq!(plan.ranges, vec![r(100, 8), r(108, 8)]);
    }
}

// ---------------------------------------------------------------------------
// サンプル表走査 — MOV 方言耐性
// ---------------------------------------------------------------------------

/// QuickTime の version 1 方言(サウンド記述 v1 の 16 バイト追補+mdhd v1)でも
/// 分類と timescale 読みが通る。
#[test]
fn quicktime_v1_dialects_are_accepted() {
    let entry = sound_entry(b"mp4a", 1, &[&mp4_box(b"esds", &esds_payload())]);
    let file = build_movie(&[audio_trak_with_mdhd(
        &mdhd_v1(48000),
        &entry,
        &[&stts(&[(1, 1024)]), &stsc(&[(1, 1)]), &stsz_uniform(4, 1), &stco(&[100])],
    )]);
    let plan = parse_audio_extraction(&file).expect("QT v1 方言が解析できること");

    assert_eq!(plan.codec, AudioCodec::Aac);
    assert_eq!(plan.timescale, 48000, "mdhd v1 でも timescale を読む");
    assert_eq!(plan.stsd, stsd(&entry), "v1 記述でも stsd は丸ごと");
}

/// 各階層の未知の箱を読み飛ばし・moov 後置(mdat 先行)でも解析する。
#[test]
fn junk_boxes_and_trailing_moov_are_accepted() {
    let junk = mp4_box(b"wxyz", &[0xAA; 24]);
    let free = mp4_box(b"free", &[0; 8]);

    let entry = mp4a_entry();
    let stbl = container(
        b"stbl",
        &[
            &junk,
            &stsd(&entry),
            &free,
            &stts(&[(7, 1024)]),
            &stsc(&[(1, 2), (3, 3)]),
            &stsz_sizes(&[10, 20, 30, 40, 50, 60, 70]),
            &junk,
            &stco(&[100, 300, 500]),
        ],
    );
    let minf = container(b"minf", &[&free, &stbl]);
    let mdia = container(b"mdia", &[&junk, &hdlr(b"soun"), &mdhd(44100), &minf]);
    let trak = container(b"trak", &[&junk, &tkhd_dummy(), &mdia]);
    let moov = container(
        b"moov",
        &[&free, &mvhd_dummy(), &video_trak_dummy(), &trak, &junk],
    );

    let mut file = ftyp();
    file.extend_from_slice(&mdat(2048));
    file.extend_from_slice(&moov);

    let plan = parse_audio_extraction(&file).expect("未知の箱混在・moov 後置でも解析できること");
    assert_eq!(plan.ranges, expected_aac_ranges());
    assert_eq!(plan.codec, AudioCodec::Aac);
}

// ---------------------------------------------------------------------------
// サンプル表走査 — 縮退(None・panic しない)
// ---------------------------------------------------------------------------

/// 映像のみ(音声トラックなし)は None =フロントの no-audio 縮退の根拠。
#[test]
fn video_only_movie_returns_none() {
    let file = build_movie(&[video_trak_dummy()]);
    assert_eq!(parse_audio_extraction(&file), None);
}

/// 動画ですらないバイト列・空入力・moov なしは None。panic しない。
#[test]
fn garbage_and_empty_input_return_none() {
    assert_eq!(parse_audio_extraction(b"this is not a movie at all"), None);
    assert_eq!(parse_audio_extraction(&[]), None);
    assert_eq!(parse_audio_extraction(&ftyp()), None, "moov が無ければ None");

    // 壊れたサイズ(ヘッダ未満の宣言)でも panic・無限ループしない。
    let mut bogus = 3u32.to_be_bytes().to_vec();
    bogus.extend_from_slice(b"wxyz");
    bogus.extend_from_slice(&[0; 16]);
    assert_eq!(parse_audio_extraction(&bogus), None);
}

/// 表の欠落・辻褄割れは None: stsz 0件・stco/co64 なし・stsc なし・チャンク不足。
#[test]
fn missing_or_inconsistent_tables_return_none() {
    let entry = mp4a_entry();

    // stsz 0件(サンプル0件では抽出が成り立たない)
    let file = build_movie(&[audio_trak(
        &entry,
        &[&stsc(&[(1, 1)]), &stsz_sizes(&[]), &stco(&[100])],
    )]);
    assert_eq!(parse_audio_extraction(&file), None, "stsz 0件は None");

    // stco も co64 も無い
    let file = build_movie(&[audio_trak(&entry, &[&stsc(&[(1, 1)]), &stsz_uniform(4, 1)])]);
    assert_eq!(
        parse_audio_extraction(&file),
        None,
        "チャンクオフセット表なしは None"
    );

    // stsc が無い
    let file = build_movie(&[audio_trak(&entry, &[&stsz_uniform(4, 1), &stco(&[100])])]);
    assert_eq!(parse_audio_extraction(&file), None, "stsc なしは None");

    // stsz 5サンプル・2サンプル/チャンクなのに stco が1チャンクしかない
    let file = build_movie(&[audio_trak(
        &entry,
        &[&stsc(&[(1, 2)]), &stsz_uniform(4, 5), &stco(&[100])],
    )]);
    assert_eq!(parse_audio_extraction(&file), None, "チャンク不足は None");
}

// ---------------------------------------------------------------------------
// m4a 再梱包 — AAC/ALAC サンプル列+元 stsd → 最小 m4a(読み戻しで検証)
// ---------------------------------------------------------------------------

/// 基本形: 3サンプルを再梱包し、読み戻しで全観点(先頭 ftyp・moov/mdat・
/// hdlr=soun・mdhd timescale・stsd 丸ごと・stts/stsz/stsc/stco の整合・
/// mdat =サンプル連結)を検証する。
#[test]
fn remux_m4a_rebuilds_minimal_m4a() {
    let stsd_in = stsd(&mp4a_entry());
    let s0 = vec![0xA1u8; 5];
    let s1 = vec![0xB2u8; 3];
    let s2 = vec![0xC3u8; 7];
    let samples: Vec<&[u8]> = vec![&s0, &s1, &s2];
    let stts_in = [(3u32, 1024u32)];

    let out = remux_m4a(&stsd_in, &samples, 44100, &stts_in).expect("再梱包できること");
    assert_valid_m4a(&out, &stsd_in, &samples, 44100, &stts_in);
}

/// stts の複数ラン(末尾フレームだけ短い等)はそのまま持ち越す
/// (サンプル単位で完全一致= ADTS 不採用の決め手を構造で担保)。
#[test]
fn remux_m4a_passes_through_multi_run_stts() {
    let stsd_in = stsd(&mp4a_entry());
    let s0 = vec![0x11u8; 4];
    let s1 = vec![0x22u8; 6];
    let s2 = vec![0x33u8; 2];
    let samples: Vec<&[u8]> = vec![&s0, &s1, &s2];
    let stts_in = [(2u32, 1024u32), (1u32, 960u32)];

    let out = remux_m4a(&stsd_in, &samples, 48000, &stts_in).expect("再梱包できること");
    assert_valid_m4a(&out, &stsd_in, &samples, 48000, &stts_in);
}

/// ALAC(stsd が alac+magic cookie)でも同じ再梱包経路が通る
/// (stsd は解釈せず丸ごと流用=コーデック非依存)。
#[test]
fn remux_m4a_accepts_alac_stsd() {
    let stsd_in = stsd(&sound_entry(b"alac", 0, &[&mp4_box(b"alac", &[0u8; 24])]));
    let s0 = vec![0x5Au8; 9];
    let s1 = vec![0xA5u8; 11];
    let samples: Vec<&[u8]> = vec![&s0, &s1];
    let stts_in = [(2u32, 4096u32)];

    let out = remux_m4a(&stsd_in, &samples, 44100, &stts_in).expect("ALAC も再梱包できること");
    assert_valid_m4a(&out, &stsd_in, &samples, 44100, &stts_in);
}

/// 辻褄割れは None: stts の総サンプル数と samples の件数の不一致・samples が空。
#[test]
fn remux_m4a_rejects_mismatch_and_empty() {
    let stsd_in = stsd(&mp4a_entry());
    let s0 = vec![0x11u8; 4];
    let s1 = vec![0x22u8; 4];
    let s2 = vec![0x33u8; 4];
    let samples: Vec<&[u8]> = vec![&s0, &s1, &s2];

    assert_eq!(
        remux_m4a(&stsd_in, &samples, 44100, &[(2, 1024)]),
        None,
        "stts 総数 2 ≠ サンプル 3 は None"
    );
    assert_eq!(
        remux_m4a(&stsd_in, &[], 44100, &[]),
        None,
        "サンプル0件の m4a は成立しない"
    );
}

// ---------------------------------------------------------------------------
// PCM — 16bit BE→LE スワップ(twos)と WAV ヘッダ包装
// ---------------------------------------------------------------------------

/// twos(16bit BE)の LE 化: 2バイトごとのスワップ。奇数長は None。
#[test]
fn pcm16_be_to_le_swaps_byte_pairs() {
    assert_eq!(
        pcm16_be_to_le(&[0x12, 0x34, 0xAB, 0xCD]),
        Some(vec![0x34, 0x12, 0xCD, 0xAB])
    );
    assert_eq!(pcm16_be_to_le(&[]), Some(vec![]), "空はそのまま空");
    assert_eq!(pcm16_be_to_le(&[0x12, 0x34, 0xAB]), None, "奇数長は不正");
}

/// 44 バイトヘッダの全バイト一致(4バイト PCM・2ch・8000Hz・16bit)。
#[test]
fn wav_header_all_bytes_exact() {
    let mut expected = Vec::new();
    expected.extend_from_slice(b"RIFF");
    expected.extend_from_slice(&40u32.to_le_bytes()); // 36 + data 4
    expected.extend_from_slice(b"WAVE");
    expected.extend_from_slice(b"fmt ");
    expected.extend_from_slice(&16u32.to_le_bytes()); // fmt チャンク長
    expected.extend_from_slice(&1u16.to_le_bytes()); // PCM
    expected.extend_from_slice(&2u16.to_le_bytes()); // channels
    expected.extend_from_slice(&8000u32.to_le_bytes()); // sample_rate
    expected.extend_from_slice(&32000u32.to_le_bytes()); // byte_rate = 8000×2×16/8
    expected.extend_from_slice(&4u16.to_le_bytes()); // block_align = 2×16/8
    expected.extend_from_slice(&16u16.to_le_bytes()); // bits_per_sample
    expected.extend_from_slice(b"data");
    expected.extend_from_slice(&4u32.to_le_bytes());
    expected.extend_from_slice(&[1, 2, 3, 4]);

    assert_eq!(wrap_wav(&[1, 2, 3, 4], 2, 8000, 16), expected);
}

/// 空の PCM でもヘッダは正しい(RIFF サイズ 36・data サイズ 0・全長 44)。
#[test]
fn wav_empty_pcm_has_valid_header() {
    let wav = wrap_wav(&[], 1, 8000, 16);
    assert_eq!(wav.len(), 44);
    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 36);
    assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 0);
}

/// float32 lpcm の包装先: fmt の format=3(IEEE float)・bits=32 の 44 バイト
/// ヘッダ全一致(8バイト= float32 ×2・1ch・8000Hz)。
#[test]
fn wav_float32_header_uses_ieee_float_format() {
    let pcm = [0u8; 8];
    let mut expected = Vec::new();
    expected.extend_from_slice(b"RIFF");
    expected.extend_from_slice(&44u32.to_le_bytes()); // 36 + data 8
    expected.extend_from_slice(b"WAVE");
    expected.extend_from_slice(b"fmt ");
    expected.extend_from_slice(&16u32.to_le_bytes());
    expected.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    expected.extend_from_slice(&1u16.to_le_bytes()); // channels
    expected.extend_from_slice(&8000u32.to_le_bytes()); // sample_rate
    expected.extend_from_slice(&32000u32.to_le_bytes()); // byte_rate = 8000×1×32/8
    expected.extend_from_slice(&4u16.to_le_bytes()); // block_align = 1×32/8
    expected.extend_from_slice(&32u16.to_le_bytes()); // bits_per_sample
    expected.extend_from_slice(b"data");
    expected.extend_from_slice(&8u32.to_le_bytes());
    expected.extend_from_slice(&pcm);

    assert_eq!(wrap_wav_float32(&pcm, 1, 8000), expected);
}

/// byte_rate と block_align はパラメタから計算する(1ch・44100Hz・16bit)。
#[test]
fn wav_byte_rate_and_block_align_follow_params() {
    let wav = wrap_wav(&[0, 0], 1, 44100, 16);
    assert_eq!(
        u32::from_le_bytes(wav[24..28].try_into().unwrap()),
        44100,
        "sample_rate"
    );
    assert_eq!(
        u32::from_le_bytes(wav[28..32].try_into().unwrap()),
        88200,
        "byte_rate = 44100×1×16/8"
    );
    assert_eq!(
        u16::from_le_bytes(wav[32..34].try_into().unwrap()),
        2,
        "block_align = 1×16/8"
    );
    assert_eq!(
        u32::from_le_bytes(wav[4..8].try_into().unwrap()),
        36 + 2,
        "RIFF サイズ = 36 + data 長"
    );
}
