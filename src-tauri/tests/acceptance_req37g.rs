//! 要件#37 追補g の受け入れテスト(Issue #734=x264 の open-GOP の H.264 で、停止中のシークが
//! 2 つ目以降の GOP で I しか出ない)— Rust 層
//!
//! 受け入れ基準 AC-37-追g (a)〜(e)(docs/requirements/req-37.md「## 追補g」契約 1〜6)。
//!
//! 直し方は fs: 追補f の書き換え(`rewrite_moov_for_open_gop`)の門を H.264(stsd の sample
//! entry が `avc1` か `avc3`)にも広げ、H.264 のトラックは次の規則で書き換える。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/video_sync.rs(追補f と同じ)。公開の面は追補f のまま
//! // (leading_sync_samples / MoovPosition / rewrite_moov_for_open_gop / MoovPatch / Piece)。
//! // 書き換えの入口は rewrite_moov_for_open_gop の 1 つ。`leading_sync_samples` は HEVC だけを
//! // 返すまま(追補f の契約・acceptance_req37f.rs の ac37f_a_only_hevc_tracks_are_listed)。
//! //
//! // 契約2 leading の枚数 L(S): H.264 のトラックの同期サンプル S(先頭のサンプル以外の stss の
//! //   番号)ごとに、復号順で S より後かつ次の同期サンプル(元の stss の次の番号。無ければ末尾
//! //   まで)より前にあり、提示時刻(stts と ctts から。edit list は当てない)が S より前の
//! //   サンプルの数。
//! // 契約3 fs:
//! //   - L(S)=0 → 変えない(stss に残す)
//! //   - L(S)=1 → stss から外して stps に入れ、その 1 枚の leading の sdtp の
//! //     sample_is_depended_on(2 ビット= 1 バイトの bit3..2)を 2 にする(= 0x08)
//! //   - L(S)≥2 → stss から外すだけ(stps に入れない・その leading の sdtp は変えない)
//! //   - stps がすでにあればそこへ足す(昇順・重複なし)。入れるものが無く元から stps も無ければ
//! //     stps を作らない(空の stps を書かない)
//! //   - sdtp: 印を付けるサンプルがあるときだけ触る。無ければ作る(FullBox v0・1 サンプル
//! //     1 バイト・印のサンプル以外は 0)。あれば印のサンプルの 2 ビットだけを 2 にし、ほかの
//! //     ビット(is_leading・sample_depends_on・sample_has_redundancy)とほかのサンプルは元のまま
//! // 契約4 書き換えない(H.264 のトラック単位。変えるトラックが 1 つも無ければ moov ごと None):
//! //   L(S)≥1 の S が無い(closed-GOP・全 IDR)・既存の sdtp がサンプル数より短い・
//! //   書き換えた後の stss が空になる
//! // 契約1・5・6: HEVC のトラックは追補f の規則もバイトも今のまま(sdtp を足さない)。
//! //   親の大きさの差(sdtp の増えた分も入る)・BeforeMdat の stco/co64・Range・覚えは追補f の
//! //   まま。`get_video_frame_index` は stss・stps・sdtp を読まないので索引は元と同じ。
//! ```
//!
//! フィクスチャはすべて本ファイル内でバイト列合成する(実動画のコミットなし)。
//! 契約外(本テストが判定しない): 作った stps・sdtp の stbl 内の位置・書き換えた moov の覚え・
//! `avc2`/`avc4` の扱い・leading の後のサンプルが leading を参照する素材。

use std::path::Path;
use std::sync::Arc;

use vellis_lib::commands::asset::handle_asset;
use vellis_lib::commands::AppState;
use vellis_lib::fs::registry::FileProviderRegistry;
use vellis_lib::video_frames::parse_frame_index;
use vellis_lib::video_sync::{leading_sync_samples, rewrite_moov_for_open_gop, MoovPosition};
use vellis_lib::watch::hub::DocumentCoordinator;
use vellis_lib::window::manager::WindowManager;

// ---------------------------------------------------------------------------
// 箱の合成ヘルパ(acceptance_req37f.rs と同じ流儀・sdtp を足した)
// ---------------------------------------------------------------------------

fn be32(p: &mut Vec<u8>, v: u32) {
    p.extend_from_slice(&v.to_be_bytes());
}

fn be64(p: &mut Vec<u8>, v: u64) {
    p.extend_from_slice(&v.to_be_bytes());
}

/// 32bit サイズの箱(size はヘッダ 8 バイトを含む)。
fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(payload.len() + 8);
    be32(&mut b, payload.len() as u32 + 8);
    b.extend_from_slice(kind);
    b.extend_from_slice(payload);
    b
}

fn container(kind: &[u8; 4], children: &[&[u8]]) -> Vec<u8> {
    let payload: Vec<u8> = children.iter().flat_map(|c| c.iter().copied()).collect();
    mp4_box(kind, &payload)
}

fn full_header(version: u8) -> Vec<u8> {
    vec![version, 0, 0, 0]
}

fn ftyp() -> Vec<u8> {
    mp4_box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2mp41")
}

fn mvhd(timescale: u32) -> Vec<u8> {
    let mut p = full_header(0);
    be32(&mut p, 0); // creation_time
    be32(&mut p, 0); // modification_time
    be32(&mut p, timescale);
    be32(&mut p, 0); // duration
    be32(&mut p, 0x0001_0000); // rate 1.0
    p.extend_from_slice(&0x0100u16.to_be_bytes()); // volume
    p.extend_from_slice(&[0u8; 10]); // reserved
    p.extend_from_slice(&[0u8; 36]); // matrix
    p.extend_from_slice(&[0u8; 24]); // pre_defined
    be32(&mut p, 4); // next_track_ID
    mp4_box(b"mvhd", &p)
}

/// tkhd v0(track_ID を持つ)。
fn tkhd(track_id: u32) -> Vec<u8> {
    let mut p = full_header(0);
    be32(&mut p, 0); // creation_time
    be32(&mut p, 0); // modification_time
    be32(&mut p, track_id);
    be32(&mut p, 0); // reserved
    be32(&mut p, 0); // duration
    p.extend_from_slice(&[0u8; 8]); // reserved
    p.extend_from_slice(&[0u8; 2]); // layer
    p.extend_from_slice(&[0u8; 2]); // alternate_group
    p.extend_from_slice(&[0u8; 2]); // volume
    p.extend_from_slice(&[0u8; 2]); // reserved
    p.extend_from_slice(&[0u8; 36]); // matrix
    be32(&mut p, 640 << 16); // width
    be32(&mut p, 360 << 16); // height
    mp4_box(b"tkhd", &p)
}

fn mdhd(timescale: u32) -> Vec<u8> {
    let mut p = full_header(0);
    be32(&mut p, 0);
    be32(&mut p, 0);
    be32(&mut p, timescale);
    be32(&mut p, 0); // duration(採られない)
    p.extend_from_slice(&0x55c4u16.to_be_bytes()); // language "und"
    p.extend_from_slice(&0u16.to_be_bytes());
    mp4_box(b"mdhd", &p)
}

fn hdlr(handler_type: &[u8; 4]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&[0u8; 4]);
    p.extend_from_slice(handler_type);
    p.extend_from_slice(&[0u8; 12]);
    p.extend_from_slice(b"Handler\0");
    mp4_box(b"hdlr", &p)
}

/// stsd(sample entry 1 件。4CC がコーデックの判定材料)。
fn stsd(codec: &[u8; 4], handler: &[u8; 4]) -> Vec<u8> {
    let mut entry = Vec::new();
    entry.extend_from_slice(&[0u8; 6]); // reserved
    entry.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    if handler == b"soun" {
        entry.extend_from_slice(&[0u8; 8]); // reserved
        entry.extend_from_slice(&2u16.to_be_bytes()); // channelcount
        entry.extend_from_slice(&16u16.to_be_bytes()); // samplesize
        entry.extend_from_slice(&[0u8; 4]); // pre_defined + reserved
        be32(&mut entry, 48000 << 16); // samplerate
    } else {
        entry.extend_from_slice(&[0u8; 16]); // pre_defined / reserved
        entry.extend_from_slice(&640u16.to_be_bytes()); // width
        entry.extend_from_slice(&360u16.to_be_bytes()); // height
        be32(&mut entry, 0x0048_0000); // horizresolution
        be32(&mut entry, 0x0048_0000); // vertresolution
        be32(&mut entry, 0); // reserved
        entry.extend_from_slice(&1u16.to_be_bytes()); // frame_count
        entry.extend_from_slice(&[0u8; 32]); // compressorname
        entry.extend_from_slice(&0x0018u16.to_be_bytes()); // depth
        entry.extend_from_slice(&0xFFFFu16.to_be_bytes()); // pre_defined
    }
    let mut p = full_header(0);
    be32(&mut p, 1); // entry_count
    p.extend_from_slice(&mp4_box(codec, &entry));
    mp4_box(b"stsd", &p)
}

fn stts(entries: &[(u32, u32)]) -> Vec<u8> {
    let mut p = full_header(0);
    be32(&mut p, entries.len() as u32);
    for (count, delta) in entries {
        be32(&mut p, *count);
        be32(&mut p, *delta);
    }
    mp4_box(b"stts", &p)
}

fn ctts_v0(entries: &[(u32, u32)]) -> Vec<u8> {
    let mut p = full_header(0);
    be32(&mut p, entries.len() as u32);
    for (count, offset) in entries {
        be32(&mut p, *count);
        be32(&mut p, *offset);
    }
    mp4_box(b"ctts", &p)
}

/// stss / stps(version 0・entry_count・u32 のサンプル番号列)。
fn u32_table(kind: &[u8; 4], entries: &[u32]) -> Vec<u8> {
    let mut p = full_header(0);
    be32(&mut p, entries.len() as u32);
    for e in entries {
        be32(&mut p, *e);
    }
    mp4_box(kind, &p)
}

/// sdtp(FullBox v0・1 サンプル 1 バイト。`samples` は version/flags の後ろのバイト列)。
fn sdtp(samples: &[u8]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(samples);
    mp4_box(b"sdtp", &p)
}

fn stsc(entries: &[(u32, u32, u32)]) -> Vec<u8> {
    let mut p = full_header(0);
    be32(&mut p, entries.len() as u32);
    for (first_chunk, samples_per_chunk, sdi) in entries {
        be32(&mut p, *first_chunk);
        be32(&mut p, *samples_per_chunk);
        be32(&mut p, *sdi);
    }
    mp4_box(b"stsc", &p)
}

/// stsz(固定サイズ・表なし)。
fn stsz(sample_size: u32, sample_count: u32) -> Vec<u8> {
    let mut p = full_header(0);
    be32(&mut p, sample_size);
    be32(&mut p, sample_count);
    mp4_box(b"stsz", &p)
}

fn stco(offsets: &[u64]) -> Vec<u8> {
    let mut p = full_header(0);
    be32(&mut p, offsets.len() as u32);
    for o in offsets {
        be32(&mut p, u32::try_from(*o).expect("フィクスチャの stco は 32 ビットに収まる"));
    }
    mp4_box(b"stco", &p)
}

fn co64(offsets: &[u64]) -> Vec<u8> {
    let mut p = full_header(0);
    be32(&mut p, offsets.len() as u32);
    for o in offsets {
        be64(&mut p, *o);
    }
    mp4_box(b"co64", &p)
}

/// 位置から中身が一意に決まるパターン(スライスの取り違えを検出できる)。
fn patterned(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i.wrapping_mul(31) % 251) as u8).collect()
}

// ---------------------------------------------------------------------------
// トラックと動画の合成
// ---------------------------------------------------------------------------

const HVC1: [u8; 4] = *b"hvc1";
const AVC1: [u8; 4] = *b"avc1";
const AVC3: [u8; 4] = *b"avc3";
const MP4A: [u8; 4] = *b"mp4a";

/// media timescale(ffmpeg が 30fps に書く 15360)。
const TS: u32 = 15360;
/// 1 フレーム = 512 ticks。
const F: u32 = 512;

/// sdtp の sample_is_depended_on = 2(他から参照されない)の印(bit3..2 = 10)。
const NOT_DEPENDED_ON: u8 = 0x08;
/// sample_is_depended_on の 2 ビットのマスク。
const DEPENDED_ON_MASK: u8 = 0x0C;

#[derive(Clone)]
struct TrackSpec {
    track_id: u32,
    handler: [u8; 4],
    codec: [u8; 4],
    timescale: u32,
    stts: Vec<(u32, u32)>,
    ctts: Option<Vec<(u32, u32)>>,
    stss: Option<Vec<u32>>,
    stps: Option<Vec<u32>>,
    /// 既存の sdtp(version/flags の後ろのバイト列)。
    sdtp: Option<Vec<u8>>,
    sample_size: u32,
    stsc: Vec<(u32, u32, u32)>,
    chunk_sizes: Vec<u32>,
    co64: bool,
}

impl TrackSpec {
    fn with_codec(mut self, codec: [u8; 4]) -> Self {
        self.codec = codec;
        self
    }

    fn with_stss(mut self, stss: &[u32]) -> Self {
        self.stss = Some(stss.to_vec());
        self
    }

    fn with_stps(mut self, stps: &[u32]) -> Self {
        self.stps = Some(stps.to_vec());
        self
    }

    fn with_sdtp(mut self, samples: &[u8]) -> Self {
        self.sdtp = Some(samples.to_vec());
        self
    }

    fn with_co64(mut self) -> Self {
        self.co64 = true;
        self
    }

    fn sample_count(&self) -> u32 {
        self.stts.iter().map(|(c, _)| c).sum()
    }

    /// trak > (tkhd, mdia > (mdhd, hdlr, minf > stbl > (stsd, stts, [ctts], [stss], [stps], [sdtp], stsc, stsz, stco|co64)))。
    fn trak(&self, chunk_offsets: &[u64]) -> Vec<u8> {
        let mut stbl: Vec<Vec<u8>> = vec![stsd(&self.codec, &self.handler), stts(&self.stts)];
        if let Some(c) = &self.ctts {
            stbl.push(ctts_v0(c));
        }
        if let Some(s) = &self.stss {
            stbl.push(u32_table(b"stss", s));
        }
        if let Some(s) = &self.stps {
            stbl.push(u32_table(b"stps", s));
        }
        if let Some(s) = &self.sdtp {
            stbl.push(sdtp(s));
        }
        stbl.push(stsc(&self.stsc));
        stbl.push(stsz(self.sample_size, self.sample_count()));
        stbl.push(if self.co64 {
            co64(chunk_offsets)
        } else {
            stco(chunk_offsets)
        });
        let refs: Vec<&[u8]> = stbl.iter().map(|b| b.as_slice()).collect();
        let stbl = container(b"stbl", &refs);
        let minf = container(b"minf", &[&stbl]);
        let mdhd = mdhd(self.timescale);
        let hdlr = hdlr(&self.handler);
        let mdia = container(b"mdia", &[&mdhd, &hdlr, &minf]);
        let tkhd = tkhd(self.track_id);
        container(b"trak", &[&tkhd, &mdia])
    }
}

/// 復号順の提示スロット列 `presentation`(d 番目のサンプルが提示順で何番目か)から
/// ctts v0 のラン(offset = (p − d + delay)·F)を組む。
fn ctts_from_presentation(presentation: &[u32], delay: u32) -> Vec<(u32, u32)> {
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for (d, p) in presentation.iter().enumerate() {
        let offset = (*p as i64 - d as i64 + i64::from(delay)) * i64::from(F);
        let offset = u32::try_from(offset).expect("ctts v0 のオフセットは非負");
        match runs.last_mut() {
            Some((count, o)) if *o == offset => *count += 1,
            _ => runs.push((1, offset)),
        }
    }
    runs
}

/// 映像トラックの骨(サンプル数 `n`・1 チャンク `per_chunk` サンプル・各 100 バイト)。
fn video_track(track_id: u32, codec: [u8; 4], presentation: &[u32], delay: u32, per_chunk: u32) -> TrackSpec {
    let n = presentation.len() as u32;
    assert_eq!(n % per_chunk, 0, "フィクスチャの前提: チャンクが割り切れる");
    let chunks = n / per_chunk;
    TrackSpec {
        track_id,
        handler: *b"vide",
        codec,
        timescale: TS,
        stts: vec![(n, F)],
        ctts: Some(ctts_from_presentation(presentation, delay)),
        stss: None,
        stps: None,
        sdtp: None,
        sample_size: 100,
        stsc: (1..=chunks).map(|c| (c, per_chunk, 1)).collect(),
        chunk_sizes: vec![per_chunk * 100; chunks as usize],
        co64: false,
    }
}

/// x264 の open-GOP の H.264(keyint 10 前後・bframes・b-pyramid の形を 36 サンプルに縮めた
/// もの)。復号順 d → 提示順 p。I の直後に復号される leading B が I より前に提示される。
///
/// ```text
/// 復号順 d : 0   1  2  3  4  5  6  7  8  9 | 10  11  12 13 14 15 16 17 18 19 20 | 21  22  23  24 25 26 27 28 29 | 30 31 32 33 34 35
/// 種別     : IDR P  B  B  P  B  B  P  B  B |  I   B   P  B  B  P  B  B  P  B  B |  I   B   B   P  B  B  P  B  B |  I  P  B  B  P  B
/// 提示 p   : 0   3  1  2  6  4  5  9  7  8 | 11  10  14 12 13 17 15 16 20 18 19 | 23  21  22  26 24 25 29 27 28 | 30 33 31 32 35 34
/// ctts/F   = p − d + 1(すべて ≥ 0)
/// ```
/// stss(1 起点)= 1・11・22・31。
/// - S=11(d=10・p=11): 次の同期 22 までに p<11 は d=11(p=10)の 1 枚 → L=1
/// - S=22(d=21・p=23): d=22(p=21)・d=23(p=22)の 2 枚 → L=2
/// - S=31(d=30・p=30): 後のサンプルはすべて p>30 → L=0
/// - 1 は先頭なので対象外
/// チャンク: 12 サンプル × 3(各 1200 バイト)。
const H264_OPEN_GOP_PRESENTATION: [u32; 36] = [
    0, 3, 1, 2, 6, 4, 5, 9, 7, 8, //
    11, 10, 14, 12, 13, 17, 15, 16, 20, 18, 19, //
    23, 21, 22, 26, 24, 25, 29, 27, 28, //
    30, 33, 31, 32, 35, 34,
];
const H264_OPEN_GOP_STSS: [u32; 4] = [1, 11, 22, 31];
/// fs の結果: L=1 の 11 は stss → stps・L=2 の 22 は stss から外れるだけ・L=0 の 31 は残る。
const H264_FS_STSS: [u32; 2] = [1, 31];
const H264_FS_STPS: [u32; 1] = [11];
/// 印を付ける leading(1 起点)= サンプル 12(d=11・p=10)。
const H264_FS_MARKED: u32 = 12;
const H264_SAMPLES: usize = 36;

fn h264_open_gop(track_id: u32) -> TrackSpec {
    video_track(track_id, AVC1, &H264_OPEN_GOP_PRESENTATION, 1, 12).with_stss(&H264_OPEN_GOP_STSS)
}

/// fs で新しく作る stps(1 件)と sdtp(36 サンプル)の差:
/// stss −8(2 件ぶん)・stps +20(ヘッダ 8+4+4、1 件 4)・sdtp +48(ヘッダ 8+4、36 バイト)= +60。
const H264_FS_DELTA: i64 = 60;

/// 作られる sdtp の中身: 印のサンプル以外は 0。
fn expected_new_sdtp() -> Vec<u8> {
    let mut s = vec![0u8; H264_SAMPLES];
    s[(H264_FS_MARKED - 1) as usize] = NOT_DEPENDED_ON;
    s
}

/// 「次の同期サンプルより後の早い提示は数えない」を切り分ける素材(10 サンプル)。
///
/// ```text
/// 復号順 d : 0   1  2 | 3  4  5  6 | 7  8  9
/// 種別     : IDR P  B | I  B  P  B | I  B  B
/// 提示 p   : 0   2  1 | 5  3  7  6 | 9  4  8
/// ctts/F   = p − d + 4(すべて ≥ 0)
/// ```
/// stss = 1・4・8。
/// - S=4(d=3・p=5): 次の同期 8 までに p<5 は d=4(p=3)だけ → L=1(末尾まで数えると
///   d=8(p=4)も入って L=2 になり、stps に入らなくなる=その誤りを検出する)
/// - S=8(d=7・p=9): d=8(p=4)・d=9(p=8)→ L=2
/// 期待: stss [1]・stps [4]・sdtp はサンプル 5(d=4)だけ印。
const UNTIL_NEXT_SYNC_PRESENTATION: [u32; 10] = [0, 2, 1, 5, 3, 7, 6, 9, 4, 8];

fn h264_leading_until_next_sync(track_id: u32) -> TrackSpec {
    video_track(track_id, AVC1, &UNTIL_NEXT_SYNC_PRESENTATION, 4, 10).with_stss(&[1, 4, 8])
}

/// 先頭のサンプルが「後に復号され前に提示されるサンプル」を持つが対象外、4 は L=2 の素材
/// (追補f の hevc_first_sample_has_leading と同じ並びの avc1)。
///
/// ```text
/// 復号順 d : 0  1  2 | 3  4  5
/// 提示 p   : 2  0  1 | 5  3  4
/// ctts/F   = p − d + 1
/// ```
/// stss = 1・4。先頭の 1 は数えない(数えると L=2 で stss から外れ、stss が空 → None になる)。
/// 4 は L=2 → stss から外れるだけ。入れるものが無く元から stps も無いので stps を作らない・
/// 印が無いので sdtp も作らない。
fn h264_first_sample_has_leading(track_id: u32) -> TrackSpec {
    video_track(track_id, AVC1, &[2, 0, 1, 5, 3, 4], 1, 6).with_stss(&[1, 4])
}

/// closed-GOP の H.264(各 GOP の先頭が IDR・IDR の後に復号されるサンプルはすべて後に提示)。
///
/// ```text
/// 復号順 d : 0   1  2  3  4  5  6 | 7   8  9  10 11 12 13 | 14  15 16 17 18
/// 提示 p   : 0   3  1  2  6  4  5 | 7  10  8   9 13 11 12 | 14  17 15 16 18
/// ```
/// stss = 1・8・15。L はすべて 0。
fn h264_closed_gop(track_id: u32) -> TrackSpec {
    let p = [0, 3, 1, 2, 6, 4, 5, 7, 10, 8, 9, 13, 11, 12, 14, 17, 15, 16, 18];
    let mut t = video_track(track_id, AVC1, &p, 1, 19).with_stss(&[1, 8, 15]);
    // 追補f の hevc_closed_gop と同じチャンク割り(7・6・6)。
    t.stsc = vec![(1, 7, 1), (2, 6, 1), (3, 6, 1)];
    t.chunk_sizes = vec![700, 600, 600];
    t
}

/// open-GOP の HEVC(追補f の hevc_open_gop と同じ 19 サンプル)。追補f の規則で
/// stss [1]・stps [8, 14]・sdtp なし・差 +16。
fn hevc_open_gop(track_id: u32) -> TrackSpec {
    let p = [0, 3, 1, 2, 6, 4, 5, 9, 7, 8, 12, 10, 11, 15, 13, 14, 18, 16, 17];
    let mut t = video_track(track_id, HVC1, &p, 1, 19).with_stss(&[1, 8, 14]);
    t.stsc = vec![(1, 7, 1), (2, 6, 1), (3, 6, 1)];
    t.chunk_sizes = vec![700, 600, 600];
    t
}
const HEVC_F_DELTA: i64 = 16;

/// 音声トラック(mp4a・8 サンプル・2 チャンク)。stss なし。
fn audio_track(track_id: u32) -> TrackSpec {
    TrackSpec {
        track_id,
        handler: *b"soun",
        codec: MP4A,
        timescale: 48000,
        stts: vec![(8, 1024)],
        ctts: None,
        stss: None,
        stps: None,
        sdtp: None,
        sample_size: 50,
        stsc: vec![(1, 4, 1)],
        chunk_sizes: vec![200, 200],
        co64: false,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Layout {
    /// ftyp・moov・mdat(faststart)。
    MoovFirst,
    /// ftyp・mdat・moov(ffmpeg の既定)。
    MoovLast,
}

struct Movie {
    bytes: Vec<u8>,
    moov_offset: usize,
    /// moov 箱(ヘッダ込み)= handle_asset / get_video_frame_index が読む形。
    moov: Vec<u8>,
    /// トラックごとのチャンクの元のファイル上の位置(stco に書いた値)。
    chunk_offsets: Vec<Vec<u64>>,
}

impl Movie {
    fn moov_end(&self) -> usize {
        self.moov_offset + self.moov.len()
    }

    /// 元のファイルの moov を `moov` で置き換えた後のファイル。
    fn patched_with(&self, moov: &[u8]) -> Vec<u8> {
        let mut out = self.bytes[..self.moov_offset].to_vec();
        out.extend_from_slice(moov);
        out.extend_from_slice(&self.bytes[self.moov_end()..]);
        out
    }
}

fn build_movie(layout: Layout, tracks: &[TrackSpec]) -> Movie {
    let ftyp = ftyp();
    let payload_len: usize = tracks
        .iter()
        .flat_map(|t| t.chunk_sizes.iter())
        .map(|s| *s as usize)
        .sum();
    let mdat = mp4_box(b"mdat", &patterned(payload_len));

    let mvhd_box = mvhd(1000);
    let moov_of = |offsets: &[Vec<u64>]| -> Vec<u8> {
        let traks: Vec<Vec<u8>> = tracks
            .iter()
            .zip(offsets)
            .map(|(t, o)| t.trak(o))
            .collect();
        let mut children: Vec<&[u8]> = vec![mvhd_box.as_slice()];
        for t in &traks {
            children.push(t);
        }
        container(b"moov", &children)
    };

    let placeholder: Vec<Vec<u64>> = tracks
        .iter()
        .map(|t| vec![0u64; t.chunk_sizes.len()])
        .collect();
    let moov_len = moov_of(&placeholder).len();

    let mdat_payload = match layout {
        Layout::MoovFirst => ftyp.len() + moov_len + 8,
        Layout::MoovLast => ftyp.len() + 8,
    };
    let mut cursor = mdat_payload as u64;
    let chunk_offsets: Vec<Vec<u64>> = tracks
        .iter()
        .map(|t| {
            t.chunk_sizes
                .iter()
                .map(|s| {
                    let o = cursor;
                    cursor += u64::from(*s);
                    o
                })
                .collect()
        })
        .collect();

    let moov = moov_of(&chunk_offsets);
    assert_eq!(moov.len(), moov_len, "位置の値で moov の長さは変わらない");

    let (bytes, moov_offset) = match layout {
        Layout::MoovFirst => {
            let mut b = ftyp.clone();
            b.extend_from_slice(&moov);
            b.extend_from_slice(&mdat);
            (b, ftyp.len())
        }
        Layout::MoovLast => {
            let mut b = ftyp.clone();
            b.extend_from_slice(&mdat);
            let off = b.len();
            b.extend_from_slice(&moov);
            (b, off)
        }
    };
    Movie {
        bytes,
        moov_offset,
        moov,
        chunk_offsets,
    }
}

// ---------------------------------------------------------------------------
// 箱の読み取りヘルパ(書き換えた結果を検分する側)
// ---------------------------------------------------------------------------

fn rd32(data: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(data[at..at + 4].try_into().unwrap())
}

fn rd64(data: &[u8], at: usize) -> u64 {
    u64::from_be_bytes(data[at..at + 8].try_into().unwrap())
}

fn fourcc(kind: &[u8]) -> String {
    String::from_utf8_lossy(kind).into_owned()
}

fn kind_of(b: &[u8]) -> [u8; 4] {
    b[4..8].try_into().unwrap()
}

fn payload(b: &[u8]) -> &[u8] {
    &b[8..]
}

/// `data` に並ぶ箱を (kind, 箱全体) で返す。サイズが収まらなければ panic(壊れた出力の検出)。
fn boxes_in(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        assert!(pos + 8 <= data.len(), "箱のヘッダが途中で切れている(pos {pos})");
        let size = rd32(data, pos) as usize;
        let kind: [u8; 4] = data[pos + 4..pos + 8].try_into().unwrap();
        assert!(
            size >= 8 && pos + size <= data.len(),
            "箱 {} のサイズ {} が親に収まらない(pos {pos}・親 {})",
            fourcc(&kind),
            size,
            data.len()
        );
        out.push((kind, &data[pos..pos + size]));
        pos += size;
    }
    out
}

fn children<'a>(container_box: &'a [u8], kind: &[u8; 4]) -> Vec<&'a [u8]> {
    boxes_in(payload(container_box))
        .into_iter()
        .filter(|(k, _)| k == kind)
        .map(|(_, b)| b)
        .collect()
}

fn first_child<'a>(container_box: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    children(container_box, kind).into_iter().next()
}

/// `root`(箱)から `path` の順に最初の子を降りる。無ければ panic。
fn descend<'a>(root: &'a [u8], path: &[&[u8; 4]]) -> &'a [u8] {
    let mut cur = root;
    for kind in path {
        cur = first_child(cur, kind)
            .unwrap_or_else(|| panic!("箱 {} が {} の中に無い", fourcc(*kind), fourcc(&kind_of(cur))));
    }
    cur
}

/// stss / stps の中身(version 0・entry_count が箱の大きさと合うこと)。
fn table_u32(b: &[u8]) -> Vec<u32> {
    let p = payload(b);
    assert_eq!(p[0], 0, "{} は version 0", fourcc(&kind_of(b)));
    let count = rd32(p, 4) as usize;
    assert_eq!(
        p.len(),
        8 + 4 * count,
        "{} の entry_count {} と箱の大きさ {} が合う",
        fourcc(&kind_of(b)),
        count,
        b.len()
    );
    (0..count).map(|i| rd32(p, 8 + 4 * i)).collect()
}

/// sdtp の中身(version 0・flags 0 のあとの 1 サンプル 1 バイト)。
fn sdtp_samples(b: &[u8]) -> Vec<u8> {
    let p = payload(b);
    assert_eq!(&p[..4], &[0, 0, 0, 0], "sdtp は version 0・flags 0");
    p[4..].to_vec()
}

/// stbl の stco(u32)か co64(u64)の値。
fn chunk_offsets_of(stbl: &[u8]) -> Vec<u64> {
    if let Some(stco) = first_child(stbl, b"stco") {
        return table_u32(stco).into_iter().map(u64::from).collect();
    }
    let co64 = first_child(stbl, b"co64").expect("stco も co64 も無い");
    let p = payload(co64);
    let count = rd32(p, 4) as usize;
    assert_eq!(p.len(), 8 + 8 * count, "co64 の entry_count と箱の大きさが合う");
    (0..count).map(|i| rd64(p, 8 + 8 * i)).collect()
}

fn trak_of<'a>(moov: &'a [u8], index: usize) -> &'a [u8] {
    children(moov, b"trak")[index]
}

fn stbl_of(trak: &[u8]) -> &[u8] {
    descend(trak, &[b"mdia", b"minf", b"stbl"])
}

/// 最初の moov 箱の位置(ファイル全体の中)。
fn find_moov(file: &[u8]) -> (usize, &[u8]) {
    let mut pos = 0;
    for (kind, b) in boxes_in(file) {
        if &kind == b"moov" {
            return (pos, b);
        }
        pos += b.len();
    }
    panic!("moov が無い");
}

/// 同期の表(stss・stps・sdtp)以外の stbl の子(kind・箱全体)。stco/co64 も除く。
fn stbl_other_children(stbl: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
    boxes_in(payload(stbl))
        .into_iter()
        .filter(|(k, _)| !matches!(k, b"stss" | b"stps" | b"sdtp" | b"stco" | b"co64"))
        .map(|(k, b)| (k, b.to_vec()))
        .collect()
}

/// 書き換えた 1 トラックに期待する同期の表。`None` はその箱が無いこと。
struct SyncTables<'a> {
    stss: &'a [u32],
    stps: Option<&'a [u32]>,
    /// version/flags の後ろのバイト列。
    sdtp: Option<&'a [u8]>,
}

/// 書き換えた moov の形(AC (b)): `expects` のトラックは同期の表が期待どおりで、それ以外の
/// 箱(tkhd・mdhd・hdlr・stsd・stts・ctts・stsc・stsz …)はバイトまで不変、親(stbl・minf・mdia・
/// trak)はそのトラックの差の分だけ改まる。`expects` に無いトラックは stco/co64 の移動以外
/// 不変。moov の差は `expected_delta`、全トラックのチャンク位置は `expected_chunk_shift` 動く。
fn assert_rewritten_moov(
    original: &[u8],
    rewritten: &[u8],
    expects: &[(usize, SyncTables)],
    expected_delta: i64,
    expected_chunk_shift: i64,
) {
    let top = boxes_in(rewritten);
    assert_eq!(top.len(), 1, "結果は moov 箱 1 つ(ヘッダ込み)");
    assert_eq!(&top[0].0, b"moov", "結果の箱は moov");
    let delta = rewritten.len() as i64 - original.len() as i64;
    assert_eq!(delta, expected_delta, "moov の大きさの差");

    assert_eq!(first_child(rewritten, b"mvhd"), first_child(original, b"mvhd"), "mvhd は不変");
    let traks_o = children(original, b"trak");
    let traks_n = children(rewritten, b"trak");
    assert_eq!(traks_o.len(), traks_n.len(), "trak の数は不変");

    let mut grow_total = 0i64;
    for (i, (to, tn)) in traks_o.iter().zip(&traks_n).enumerate() {
        let expect = expects.iter().find(|(idx, _)| *idx == i).map(|(_, e)| e);
        let stbl_o = stbl_of(to);
        let stbl_n = stbl_of(tn);
        let grow = stbl_n.len() as i64 - stbl_o.len() as i64;
        grow_total += grow;
        if expect.is_none() {
            assert_eq!(grow, 0, "書き換えないトラック#{i} の stbl の大きさは不変");
        }
        let path_sizes = |t: &[u8]| -> Vec<usize> {
            let mdia = descend(t, &[b"mdia"]);
            let minf = descend(mdia, &[b"minf"]);
            vec![t.len(), mdia.len(), minf.len()]
        };
        for (name, (a, b)) in ["trak", "mdia", "minf"]
            .iter()
            .zip(path_sizes(to).iter().zip(&path_sizes(tn)))
        {
            assert_eq!(
                *b as i64,
                *a as i64 + grow,
                "trak#{i} の {name} の大きさは stbl の差の分({grow})だけ改まる"
            );
        }
        assert_eq!(descend(to, &[b"tkhd"]), descend(tn, &[b"tkhd"]), "trak#{i} の tkhd は不変");
        for kind in [b"mdhd", b"hdlr"] {
            assert_eq!(
                descend(to, &[b"mdia", kind]),
                descend(tn, &[b"mdia", kind]),
                "trak#{i} の {} は不変",
                fourcc(kind)
            );
        }
        assert_eq!(
            stbl_other_children(stbl_o),
            stbl_other_children(stbl_n),
            "trak#{i} の stss・stps・sdtp・stco 以外の stbl の子はバイトまで不変(順序も)"
        );
        let co_o = chunk_offsets_of(stbl_o);
        let co_n = chunk_offsets_of(stbl_n);
        let expected: Vec<u64> = co_o
            .iter()
            .map(|o| (*o as i64 + expected_chunk_shift) as u64)
            .collect();
        assert_eq!(
            co_n, expected,
            "trak#{i} のチャンク位置は差の分({expected_chunk_shift})だけ動く(元 {co_o:?})"
        );
        match expect {
            Some(e) => {
                let stss = first_child(stbl_n, b"stss").expect("stss は残る");
                assert_eq!(table_u32(stss), e.stss, "trak#{i} の stss");
                match (e.stps, first_child(stbl_n, b"stps")) {
                    (Some(want), Some(got)) => {
                        assert_eq!(table_u32(got), want, "trak#{i} の stps(昇順・重複なし)")
                    }
                    (None, None) => {}
                    (Some(want), None) => panic!("trak#{i} に stps {want:?} が無い"),
                    (None, Some(got)) => {
                        panic!("trak#{i} に stps を作らない(入れるものが無い)が {:?} がある", table_u32(got))
                    }
                }
                match (e.sdtp, first_child(stbl_n, b"sdtp")) {
                    (Some(want), Some(got)) => {
                        assert_eq!(sdtp_samples(got), want, "trak#{i} の sdtp(1 サンプル 1 バイト)")
                    }
                    (None, None) => {}
                    (Some(_), None) => panic!("trak#{i} に sdtp が無い"),
                    (None, Some(got)) => {
                        panic!("trak#{i} に sdtp を作らない(印が無い)が {:?} がある", sdtp_samples(got))
                    }
                }
            }
            None => {
                for kind in [b"stss", b"stps", b"sdtp"] {
                    assert_eq!(
                        first_child(stbl_o, kind),
                        first_child(stbl_n, kind),
                        "書き換えないトラック#{i} の {} は不変",
                        fourcc(kind)
                    );
                }
            }
        }
    }
    assert_eq!(grow_total, delta, "各トラックの差の合計が moov の差");
}

/// 書き換えた後のファイルの中の moov のチャンク位置が、元のファイルと同じ中身を指していること。
fn assert_chunks_point_to_same_bytes(movie: &Movie, patched: &[u8]) {
    let (_, moov) = find_moov(patched);
    for (t, original_offsets) in children(moov, b"trak").iter().zip(&movie.chunk_offsets) {
        let offsets = chunk_offsets_of(stbl_of(t));
        assert_eq!(offsets.len(), original_offsets.len());
        for (new, old) in offsets.iter().zip(original_offsets) {
            let (new, old) = (*new as usize, *old as usize);
            assert_eq!(
                &patched[new..new + 8],
                &movie.bytes[old..old + 8],
                "チャンク位置 {new}(元 {old})は元と同じ中身を指す"
            );
        }
    }
}

/// 追補f の規則の HEVC(hevc_open_gop)の期待(sdtp なし)。
const HEVC_EXPECT: SyncTables<'static> = SyncTables {
    stss: &[1],
    stps: Some(&[8, 14]),
    sdtp: None,
};

// ---------------------------------------------------------------------------
// (a)(b) 判定と書き換え: L=0・1・2 以上の分類と fs
// ---------------------------------------------------------------------------

/// AC-37-追g (a)(b)・契約2・3: x264 の open-GOP の H.264(avc1・avc3)。
/// L=1 の 11 は stss から外れて stps に入り、その leading(サンプル 12)の sdtp に印。
/// L=2 の 22 は stss から外れるだけ(stps に入らない・印なし)。L=0 の 31 は stss に残る。
/// 先頭の 1 は対象外。sdtp は無かったので作る(36 バイト・印以外 0)。差は +60。
/// moov が後ろ(AfterMdat)なので stco は動かない。
#[test]
fn ac37g_a_b_h264_open_gop_is_rewritten_by_fs() {
    for codec in [AVC1, AVC3] {
        let movie = build_movie(Layout::MoovLast, &[h264_open_gop(1).with_codec(codec), audio_track(2)]);
        let rewritten = rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat)
            .unwrap_or_else(|| panic!("{}: open-GOP の H.264 は書き換える", fourcc(&codec)));
        assert_rewritten_moov(
            &movie.moov,
            &rewritten,
            &[(
                0,
                SyncTables {
                    stss: &H264_FS_STSS,
                    stps: Some(&H264_FS_STPS),
                    sdtp: Some(&expected_new_sdtp()),
                },
            )],
            H264_FS_DELTA,
            0,
        );
    }
}

/// AC-37-追g (a)・契約2: leading は次の同期サンプルの前までで数える。復号順で次の同期サンプル
/// の後にあるサンプルは、提示が S より早くても S の leading にしない(→ S=4 は L=1 のまま
/// stps に入る)。
#[test]
fn ac37g_a_leading_is_counted_only_until_the_next_sync_sample() {
    let movie = build_movie(Layout::MoovLast, &[h264_leading_until_next_sync(1)]);
    let rewritten = rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat)
        .expect("L=1 の同期サンプルがあるので書き換える");
    let mut sdtp = vec![0u8; 10];
    sdtp[4] = NOT_DEPENDED_ON; // サンプル 5(d=4)
    // stss −8(2 件)・stps +20(1 件)・sdtp +22(10 バイト)= +34
    assert_rewritten_moov(
        &movie.moov,
        &rewritten,
        &[(
            0,
            SyncTables {
                stss: &[1],
                stps: Some(&[4]),
                sdtp: Some(&sdtp),
            },
        )],
        34,
        0,
    );
}

/// AC-37-追g (a)(b)・契約2・3: 先頭のサンプルは対象外(数えると stss が空になり None になる)。
/// L=2 の 4 は stss から外れるだけ。入れるものが無く元から stps も無いので stps を作らない。
/// 印を付けるサンプルが無いので sdtp も作らない。差は stss −4。
#[test]
fn ac37g_a_b_first_sample_is_not_a_candidate_and_l2_only_creates_no_stps_nor_sdtp() {
    let movie = build_movie(Layout::MoovLast, &[h264_first_sample_has_leading(1), audio_track(2)]);
    let rewritten = rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat)
        .expect("L=2 の同期サンプルがある(stss から外す)ので書き換える");
    assert_rewritten_moov(
        &movie.moov,
        &rewritten,
        &[(
            0,
            SyncTables {
                stss: &[1],
                stps: None,
                sdtp: None,
            },
        )],
        -4,
        0,
    );
}

/// AC-37-追g (b)・契約3: 既存の stps に足す(昇順)・同じ番号は重複させない。
#[test]
fn ac37g_b_existing_stps_is_extended_in_order_without_duplicates() {
    // 元の stps [20] → [11, 20](昇順)。stss −8・stps +4・sdtp +48 = +44。
    let movie = build_movie(Layout::MoovLast, &[h264_open_gop(1).with_stps(&[20])]);
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat).expect("書き換える");
    assert_rewritten_moov(
        &movie.moov,
        &rewritten,
        &[(
            0,
            SyncTables {
                stss: &H264_FS_STSS,
                stps: Some(&[11, 20]),
                sdtp: Some(&expected_new_sdtp()),
            },
        )],
        44,
        0,
    );

    // 元の stps [11] → [11](重複なし)。stss −8・stps ±0・sdtp +48 = +40。
    let movie = build_movie(Layout::MoovLast, &[h264_open_gop(1).with_stps(&[11])]);
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat).expect("書き換える");
    assert_rewritten_moov(
        &movie.moov,
        &rewritten,
        &[(
            0,
            SyncTables {
                stss: &H264_FS_STSS,
                stps: Some(&[11]),
                sdtp: Some(&expected_new_sdtp()),
            },
        )],
        40,
        0,
    );
}

/// AC-37-追g (b)・契約3: 既存の sdtp は、印のサンプルの sample_is_depended_on の 2 ビットだけ
/// 2 になり、そのサンプルのほかのビット(is_leading・sample_depends_on・has_redundancy)と
/// ほかのサンプル(L=2 の I の leading 23・24 を含む)は元のまま。sdtp の大きさは変わらない
/// ので差は stss −8・stps +20 = +12。
#[test]
fn ac37g_b_existing_sdtp_changes_only_the_two_bits_of_the_marked_sample() {
    // 全ビットを使うパターン(サンプルごとに違う値)。印のサンプル 12 は 0x97
    // (is_leading 2・depends_on 1・is_depended_on 1・redundancy 3)。
    let original_sdtp: Vec<u8> = (0..H264_SAMPLES)
        .map(|i| if i == (H264_FS_MARKED - 1) as usize { 0x97 } else { (i as u8).wrapping_mul(37) ^ 0x5A })
        .collect();
    let movie = build_movie(Layout::MoovLast, &[h264_open_gop(1).with_sdtp(&original_sdtp)]);
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat).expect("書き換える");
    let mut expected_sdtp = original_sdtp.clone();
    let at = (H264_FS_MARKED - 1) as usize;
    expected_sdtp[at] = (original_sdtp[at] & !DEPENDED_ON_MASK) | NOT_DEPENDED_ON;
    assert_eq!(expected_sdtp[at], 0x9B, "0x97 の bit3..2 だけ 10 に → 0x9B");
    assert_rewritten_moov(
        &movie.moov,
        &rewritten,
        &[(
            0,
            SyncTables {
                stss: &H264_FS_STSS,
                stps: Some(&H264_FS_STPS),
                sdtp: Some(&expected_sdtp),
            },
        )],
        12,
        0,
    );
}

/// AC-37-追g (b)・契約1: HEVC と H.264 の混在。HEVC は追補f の規則(stss [1]・stps [8, 14]・
/// sdtp を足さない・+16)、H.264 は fs(+60)。音声は不変。moov が前(BeforeMdat)なので
/// 全トラックの stco が差 76 の分だけ動き、動いた先は元と同じ中身を指す。
#[test]
fn ac37g_b_hevc_and_h264_tracks_follow_their_own_rules_and_chunk_offsets_shift_by_both() {
    let movie = build_movie(
        Layout::MoovFirst,
        &[hevc_open_gop(1), h264_open_gop(2), audio_track(3)],
    );
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::BeforeMdat).expect("書き換える");
    let delta = HEVC_F_DELTA + H264_FS_DELTA;
    assert_rewritten_moov(
        &movie.moov,
        &rewritten,
        &[
            (0, HEVC_EXPECT),
            (
                1,
                SyncTables {
                    stss: &H264_FS_STSS,
                    stps: Some(&H264_FS_STPS),
                    sdtp: Some(&expected_new_sdtp()),
                },
            ),
        ],
        delta,
        delta,
    );
    assert_chunks_point_to_same_bytes(&movie, &movie.patched_with(&rewritten));

    // 追補f の判定の関数は HEVC だけを返すまま(H.264 の 2 は載せない)。
    assert_eq!(
        leading_sync_samples(&movie.moov),
        vec![(1, vec![8, 14])],
        "leading_sync_samples は追補f の契約のまま HEVC のトラックだけ"
    );
}

/// AC-37-追g (b)・契約5: H.264 だけの moov が mdat より前(faststart)なら stco(co64 も)が
/// sdtp の増えた分を含む差(+60)だけ動く。同じ moov でも AfterMdat なら動かさない。
#[test]
fn ac37g_b_moov_before_mdat_shifts_chunk_offsets_by_the_delta_including_sdtp() {
    for co64 in [false, true] {
        let mut tracks = vec![h264_open_gop(1), audio_track(2)];
        if co64 {
            tracks = tracks.into_iter().map(TrackSpec::with_co64).collect();
        }
        let movie = build_movie(Layout::MoovFirst, &tracks);
        let sdtp = expected_new_sdtp();
        let expect = || {
            [(
                0,
                SyncTables {
                    stss: &H264_FS_STSS,
                    stps: Some(&H264_FS_STPS),
                    sdtp: Some(&sdtp),
                },
            )]
        };
        let before = rewrite_moov_for_open_gop(&movie.moov, MoovPosition::BeforeMdat)
            .expect("書き換える");
        assert_rewritten_moov(&movie.moov, &before, &expect(), H264_FS_DELTA, H264_FS_DELTA);
        assert_chunks_point_to_same_bytes(&movie, &movie.patched_with(&before));

        let after = rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat)
            .expect("書き換える");
        assert_rewritten_moov(&movie.moov, &after, &expect(), H264_FS_DELTA, 0);
    }
}

// ---------------------------------------------------------------------------
// (c) 書き換えないとき(H.264 のトラック単位)
// ---------------------------------------------------------------------------

/// AC-37-追g (c)・契約4: H.264 の closed-GOP(L≥1 の S が無い)→ None(avc1・avc3 とも)。
#[test]
fn ac37g_c_h264_closed_gop_is_not_rewritten() {
    for codec in [AVC1, AVC3] {
        let movie = build_movie(Layout::MoovLast, &[h264_closed_gop(1).with_codec(codec), audio_track(2)]);
        assert_eq!(
            rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat),
            None,
            "{}: closed-GOP", fourcc(&codec)
        );
        assert_eq!(rewrite_moov_for_open_gop(&movie.moov, MoovPosition::BeforeMdat), None);
    }
}

/// AC-37-追g (c)・契約4: 既存の sdtp がサンプル数(36)より短い(35)H.264 のトラックは変えない。
/// ほかに変えるトラックが無ければ None。HEVC の open-GOP と混在なら HEVC だけ書き換え、
/// その H.264 の trak はバイトまで元のまま。
#[test]
fn ac37g_c_h264_track_with_short_sdtp_is_left_alone() {
    let short = h264_open_gop(1).with_sdtp(&vec![0u8; H264_SAMPLES - 1]);
    let alone = build_movie(Layout::MoovLast, &[short.clone(), audio_track(2)]);
    assert_eq!(
        rewrite_moov_for_open_gop(&alone.moov, MoovPosition::AfterMdat),
        None,
        "短い sdtp の H.264 だけ → None"
    );

    let mut short2 = short;
    short2.track_id = 2;
    let mixed = build_movie(Layout::MoovLast, &[hevc_open_gop(1), short2]);
    let rewritten = rewrite_moov_for_open_gop(&mixed.moov, MoovPosition::AfterMdat)
        .expect("HEVC の open-GOP は書き換える");
    assert_rewritten_moov(&mixed.moov, &rewritten, &[(0, HEVC_EXPECT)], HEVC_F_DELTA, 0);
    assert_eq!(
        trak_of(&rewritten, 1),
        trak_of(&mixed.moov, 1),
        "短い sdtp の H.264 の trak はバイトまで元のまま"
    );
}

/// AC-37-追g (c)・契約4: 書き換えた後の stss が空になる H.264(stss に先頭のサンプルが無く、
/// すべての同期サンプルが L≥1)のトラックは変えない。ほかに変えるトラックが無ければ None。
/// HEVC と混在なら HEVC だけ書き換える。
#[test]
fn ac37g_c_h264_track_whose_stss_would_become_empty_is_left_alone() {
    // stss [11, 22]: 11 は L=1・22 は L=2 → 両方外れて空になる。
    let emptied = h264_open_gop(1).with_stss(&[11, 22]);
    let alone = build_movie(Layout::MoovLast, &[emptied.clone()]);
    assert_eq!(
        rewrite_moov_for_open_gop(&alone.moov, MoovPosition::AfterMdat),
        None,
        "stss が空になる H.264 だけ → None"
    );
    assert_eq!(rewrite_moov_for_open_gop(&alone.moov, MoovPosition::BeforeMdat), None);

    let mut emptied2 = emptied;
    emptied2.track_id = 2;
    let mixed = build_movie(Layout::MoovLast, &[hevc_open_gop(1), emptied2]);
    let rewritten = rewrite_moov_for_open_gop(&mixed.moov, MoovPosition::AfterMdat)
        .expect("HEVC の open-GOP は書き換える");
    assert_rewritten_moov(&mixed.moov, &rewritten, &[(0, HEVC_EXPECT)], HEVC_F_DELTA, 0);
    assert_eq!(
        trak_of(&rewritten, 1),
        trak_of(&mixed.moov, 1),
        "stss が空になる H.264 の trak はバイトまで元のまま"
    );
}

// ---------------------------------------------------------------------------
// (d) 配線と Range: handle_asset が H.264 の open-GOP を書き換えた moov で配る
// ---------------------------------------------------------------------------

/// handle_asset を通すための最小 AppState(acceptance_req37f.rs と同じ)。
fn test_state() -> AppState {
    let registry = Arc::new(FileProviderRegistry::new());
    AppState {
        fs_registry: registry.clone(),
        coordinator: Arc::new(DocumentCoordinator::new(registry)),
        window_manager: Arc::new(tokio::sync::Mutex::new(WindowManager::new())),
        annotation_stores: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    }
}

fn asset_request(path: &Path, range: Option<&str>) -> http::Request<Vec<u8>> {
    let url = format!("vellis-asset://local{}", path.to_str().unwrap());
    let mut builder = http::Request::builder().uri(url);
    if let Some(r) = range {
        builder = builder.header("Range", r);
    }
    builder.body(Vec::new()).unwrap()
}

fn header_str<'a>(resp: &'a http::Response<Vec<u8>>, name: &str) -> Option<&'a str> {
    resp.headers().get(name).and_then(|v| v.to_str().ok())
}

/// `name` のファイルを書いて配らせる。
async fn serve(dir: &Path, name: &str, bytes: &[u8], range: Option<&str>) -> http::Response<Vec<u8>> {
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    handle_asset(&test_state(), asset_request(&path, range)).await
}

/// 200/206 の共通の形: Accept-Ranges・ACAO・(あれば)Content-Length がボディと合う。
fn assert_body_response(resp: &http::Response<Vec<u8>>, status: u16, ctx: &str) {
    assert_eq!(resp.status().as_u16(), status, "{ctx}: 状態");
    assert_eq!(header_str(resp, "Accept-Ranges"), Some("bytes"), "{ctx}: Accept-Ranges");
    assert_eq!(header_str(resp, "Access-Control-Allow-Origin"), Some("*"), "{ctx}: ACAO");
    if let Some(cl) = header_str(resp, "Content-Length") {
        assert_eq!(
            cl.parse::<usize>().ok(),
            Some(resp.body().len()),
            "{ctx}: Content-Length は書き換えた後のボディの大きさ"
        );
    }
}

/// 配られたファイルの最初の trak の stss / stps / sdtp。
fn served_sync_tables(file: &[u8]) -> (Vec<u32>, Option<Vec<u32>>, Option<Vec<u8>>) {
    let (_, moov) = find_moov(file);
    let stbl = stbl_of(trak_of(moov, 0));
    (
        table_u32(first_child(stbl, b"stss").expect("stss")),
        first_child(stbl, b"stps").map(table_u32),
        first_child(stbl, b"sdtp").map(sdtp_samples),
    )
}

/// AC-37-追g (d): H.264 の open-GOP の .mp4(moov が末尾)を Range なしで配ると、ボディは
/// 書き換えた後のファイル(ftyp・mdat は元のまま・moov は fs の形)で、純関数の結果と一致する。
/// Content-Length は書き換えた後の大きさ(元 + 60)。元のファイルは書き換えない。
#[tokio::test]
async fn ac37g_d_handle_asset_serves_rewritten_moov_for_h264_open_gop_mp4() {
    let dir = tempfile::tempdir().unwrap();
    let movie = build_movie(Layout::MoovLast, &[h264_open_gop(1), audio_track(2)]);
    let resp = serve(dir.path(), "x264-open-gop.mp4", &movie.bytes, None).await;
    assert_body_response(&resp, 200, "H.264 open-GOP .mp4");
    assert!(
        header_str(&resp, "Content-Type").is_some_and(|m| m.starts_with("video/")),
        "Content-Type は動画のまま: {:?}",
        header_str(&resp, "Content-Type")
    );
    let body = resp.body();
    assert_eq!(
        body.len() as i64,
        movie.bytes.len() as i64 + H264_FS_DELTA,
        "ボディは書き換えた後の大きさ(元 + 60)"
    );
    // 200 の Content-Length は追補f と同じく任意(Tauri がボディから決める)。あれば書き換えた後の大きさ。
    if let Some(cl) = header_str(&resp, "Content-Length") {
        assert_eq!(
            cl.parse::<i64>().ok(),
            Some(movie.bytes.len() as i64 + H264_FS_DELTA),
            "Content-Length があれば書き換えた後の大きさ(元 + 60)"
        );
    }
    assert_eq!(&body[..movie.moov_offset], &movie.bytes[..movie.moov_offset], "moov の前は元のまま");
    let (stss, stps, sdtp) = served_sync_tables(body);
    assert_eq!(stss, H264_FS_STSS.to_vec(), "配った moov の stss は [1, 31]");
    assert_eq!(stps, Some(H264_FS_STPS.to_vec()), "配った moov の stps は [11]");
    assert_eq!(sdtp, Some(expected_new_sdtp()), "配った moov の sdtp はサンプル 12 だけ印");
    let rewritten = rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat)
        .expect("純関数も書き換える");
    assert_eq!(body, &movie.patched_with(&rewritten), "ボディ = 元の前 + 書き換えた moov");

    assert_eq!(std::fs::read(dir.path().join("x264-open-gop.mp4")).unwrap(), movie.bytes);
}

/// AC-37-追g (d): moov が先頭(faststart)の .mov(video/quicktime)。stco が差(60)の分だけ
/// 動き、動いた先が元と同じ中身を指す。moov と mdat をまたぐ Range・末尾の Range は書き換えた
/// 後の位置で切り出され、Content-Range の全体と 416 の大きさは書き換えた後の大きさ。
#[tokio::test]
async fn ac37g_d_handle_asset_faststart_mov_ranges_and_416_follow_patched_total() {
    let dir = tempfile::tempdir().unwrap();
    let movie = build_movie(Layout::MoovFirst, &[h264_open_gop(1), audio_track(2)]);
    let name = "x264-open-gop-faststart.mov";

    let whole = serve(dir.path(), name, &movie.bytes, None).await;
    assert_body_response(&whole, 200, "faststart .mov");
    let patched = whole.body().clone();
    let total = patched.len() as u64;
    assert_eq!(total as i64, movie.bytes.len() as i64 + H264_FS_DELTA);
    let (stss, stps, sdtp) = served_sync_tables(&patched);
    assert_eq!(stss, H264_FS_STSS.to_vec());
    assert_eq!(stps, Some(H264_FS_STPS.to_vec()));
    assert_eq!(sdtp, Some(expected_new_sdtp()));
    assert_chunks_point_to_same_bytes(&movie, &patched);
    let (moov_at, moov) = find_moov(&patched);
    assert_eq!(moov_at, movie.moov_offset);
    assert_eq!(moov.len() as i64, movie.moov.len() as i64 + H264_FS_DELTA);
    assert_eq!(
        &patched[moov_at + moov.len()..],
        &movie.bytes[movie.moov_end()..],
        "moov の後ろ(mdat)は元のまま"
    );
    let rewritten = rewrite_moov_for_open_gop(&movie.moov, MoovPosition::BeforeMdat)
        .expect("純関数も書き換える");
    assert_eq!(patched, movie.patched_with(&rewritten), "ボディ = 純関数の結果で置き換えたファイル");

    // moov と mdat をまたぐ範囲。
    let moov_end = (moov_at + moov.len()) as u64;
    let (s, e) = (moov_end - 8, moov_end + 7);
    let part = serve(dir.path(), name, &movie.bytes, Some(&format!("bytes={s}-{e}"))).await;
    assert_body_response(&part, 206, "moov と mdat をまたぐ Range");
    assert_eq!(
        header_str(&part, "Content-Range"),
        Some(format!("bytes {s}-{e}/{total}").as_str()),
        "Content-Range の全体は書き換えた後の大きさ"
    );
    assert_eq!(
        part.body(),
        &patched[s as usize..=e as usize],
        "書き換えた後の位置で切り出す(書き換えた moov の末尾 8 + mdat の先頭 8)"
    );

    // 末尾。
    let tail = serve(dir.path(), name, &movie.bytes, Some("bytes=-8")).await;
    assert_body_response(&tail, 206, "bytes=-8");
    assert_eq!(
        header_str(&tail, "Content-Range"),
        Some(format!("bytes {}-{}/{}", total - 8, total - 1, total).as_str())
    );
    assert_eq!(tail.body(), &patched[(total - 8) as usize..], "末尾は mdat の末尾(元のまま)");

    // 元の大きさから先は、書き換えた後では充足可能。
    let original_total = movie.bytes.len() as u64;
    let beyond = serve(dir.path(), name, &movie.bytes, Some(&format!("bytes={original_total}-"))).await;
    assert_body_response(&beyond, 206, "元の大きさから先");
    assert_eq!(
        header_str(&beyond, "Content-Range"),
        Some(format!("bytes {}-{}/{}", original_total, total - 1, total).as_str())
    );
    assert_eq!(beyond.body(), &patched[original_total as usize..]);

    // 書き換えた後の大きさ以上から始まる範囲は 416(大きさも書き換えた後)。
    let unsat = serve(dir.path(), name, &movie.bytes, Some(&format!("bytes={total}-"))).await;
    assert_eq!(unsat.status().as_u16(), 416);
    assert_eq!(
        header_str(&unsat, "Content-Range"),
        Some(format!("bytes */{total}").as_str()),
        "416 の大きさも書き換えた後の大きさ"
    );
}

/// AC-37-追g (c)(d)・契約4・6: 書き換えない H.264(closed-GOP・短い sdtp・stss が空になる)は
/// 今までどおり元のバイトをそのまま配り、大きさも元のまま。
#[tokio::test]
async fn ac37g_c_d_handle_asset_serves_original_bytes_for_h264_it_does_not_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let cases: Vec<(&str, Vec<u8>)> = vec![
        (
            "h264-closed-gop.mp4",
            build_movie(Layout::MoovLast, &[h264_closed_gop(1), audio_track(2)]).bytes,
        ),
        (
            "h264-closed-gop-faststart.mov",
            build_movie(Layout::MoovFirst, &[h264_closed_gop(1), audio_track(2)]).bytes,
        ),
        (
            "h264-short-sdtp.mp4",
            build_movie(
                Layout::MoovLast,
                &[h264_open_gop(1).with_sdtp(&vec![0u8; H264_SAMPLES - 1])],
            )
            .bytes,
        ),
        (
            "h264-stss-would-be-empty.mp4",
            build_movie(Layout::MoovLast, &[h264_open_gop(1).with_stss(&[11, 22])]).bytes,
        ),
    ];
    for (name, bytes) in &cases {
        let resp = serve(dir.path(), name, bytes, None).await;
        assert_eq!(resp.status().as_u16(), 200, "{name}");
        assert_eq!(resp.body(), bytes, "{name}: 元のバイトをそのまま配る");
        let total = bytes.len() as u64;
        let tail = serve(dir.path(), name, bytes, Some("bytes=-8")).await;
        assert_eq!(tail.status().as_u16(), 206, "{name}");
        assert_eq!(
            header_str(&tail, "Content-Range"),
            Some(format!("bytes {}-{}/{}", total - 8, total - 1, total).as_str()),
            "{name}: 大きさも元のまま"
        );
        assert_eq!(tail.body(), &bytes[(total - 8) as usize..], "{name}");
    }
}

// ---------------------------------------------------------------------------
// (e) 書き換えた moov から作るフレーム索引は元と同じ
// ---------------------------------------------------------------------------

/// AC-37-追g (e)・契約6: 書き換えた後の moov を get_video_frame_index と同じ読み方
/// (parse_frame_index)で読んでも、フレーム索引(提示時刻・尺・fps・CFR)は元と同じ。
/// H.264 だけ・HEVC と混在・既存の sdtp あり、moov の前後どちらでも。
#[test]
fn ac37g_e_frame_index_is_unchanged_by_the_rewrite() {
    let cases: Vec<(&str, Vec<TrackSpec>)> = vec![
        ("H.264 だけ", vec![h264_open_gop(1), audio_track(2)]),
        ("HEVC と H.264", vec![hevc_open_gop(1), h264_open_gop(2), audio_track(3)]),
        ("H.264 と既存の sdtp", vec![h264_open_gop(1).with_sdtp(&[0u8; H264_SAMPLES])]),
    ];
    for (name, tracks) in &cases {
        for (layout, position) in [
            (Layout::MoovLast, MoovPosition::AfterMdat),
            (Layout::MoovFirst, MoovPosition::BeforeMdat),
        ] {
            let movie = build_movie(layout, tracks);
            let rewritten = rewrite_moov_for_open_gop(&movie.moov, position)
                .unwrap_or_else(|| panic!("{name}/{layout:?}: 書き換える"));
            let before = parse_frame_index(&movie.moov).expect("元の moov から索引が作れる");
            assert_eq!(before.sample_times[0], u64::from(F), "前提: 先頭の提示時刻は ctts のぶん");
            assert!(before.is_cfr, "前提: 合成の素材は CFR");
            let after = parse_frame_index(&rewritten).expect("書き換えた moov からも索引が作れる");
            assert_eq!(after, before, "{name}/{layout:?}: 索引(提示時刻・尺・fps・CFR)は元と同じ");
            let from_file = parse_frame_index(&movie.patched_with(&rewritten))
                .expect("ファイル全体からも");
            assert_eq!(from_file, before, "{name}/{layout:?}: ファイル全体から読んでも同じ");
        }
    }
}
