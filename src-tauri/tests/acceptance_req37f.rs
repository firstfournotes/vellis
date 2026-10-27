//! 要件#37 追補f の受け入れテスト(Issue #591=backlog 221=x265 既定の open-GOP の HEVC で、
//! 停止中に CRA の直前の RASL に止まれない)— Rust 層
//!
//! 受け入れ基準 AC-37-追f (a)〜(f)(docs/requirements/req-37.md「## 追補f」契約 1〜6)。
//!
//! 直し方は (g')=配るときの moov の書き換え: `handle_asset` が配る ISO BMFF の動画に
//! HEVC のトラック(stsd の sample entry が `hvc1` か `hev1`)があり、そのトラックに
//! 「leading を持つ同期サンプル」(open-GOP の CRA)があれば、それらを stss から外して
//! stps(partial sync)に入れた moov を配る。ファイルそのものは書き換えない。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: 新設 src-tauri/src/video_sync.rs(`vellis_lib::video_sync`・lib.rs に pub mod)。
//! // 箱の読み方は video_frames.rs の流儀(宣言サイズで読み飛ばす・兄弟の順序に依存しない・
//! // 壊れた入力で panic しない)。依存の追加なし。
//!
//! /// 判定(契約1): HEVC のトラックごとの「leading を持つ同期サンプル」の番号。
//! /// - `moov` は moov 箱(ヘッダ込み・`get_video_frame_index` が読む形そのもの)。
//! ///   先頭の箱が moov でなければ空
//! /// - 返すのは (tkhd の track_ID, 1 起点のサンプル番号の昇順の列)。
//! ///   **HEVC(hvc1 / hev1)のトラックで、leading を持つ同期サンプルが 1 つ以上あるものだけ**
//! ///   を moov の中の順に並べる(avc1 など HEVC 以外・closed-GOP の HEVC は載せない。
//! ///   = 空なら書き換えるものが無い)
//! /// - leading を持つ同期サンプル = 先頭のサンプル以外の同期サンプル(stss の番号)S で、
//! ///   復号順で S より後にあり、提示時刻(stts の累積 + ctts のオフセット。edit list は
//! ///   当てない。ctts が無ければオフセット 0)が S より前のサンプルが 1 つ以上あるもの
//! pub fn leading_sync_samples(moov: &[u8]) -> Vec<(u32, Vec<u32>)>;
//!
//! /// moov が mdat より前(faststart)か後ろか。前なら stco / co64 を差の分だけ直す(契約2)。
//! #[derive(Debug, Clone, Copy, PartialEq, Eq)]
//! pub enum MoovPosition { BeforeMdat, AfterMdat }
//!
//! /// 書き換え(契約1・2・4): 書き換えた moov 箱(ヘッダ込み)。書き換えないときは None。
//! /// - 該当する同期サンプルを HEVC の各トラックの stss から外し、stps に入れる
//! ///   (stps がすでにあればそこへ足す。番号の昇順・重複なし)。stps の stbl 内の位置は裁量
//! /// - stss が縮み stps が増えた差(delta。負にもなる)の分だけ、親の箱
//! ///   (stbl・minf・mdia・trak・moov)の大きさを改める
//! /// - `BeforeMdat` なら **すべてのトラック**の stco(co64 も)の値に delta を足す。
//! ///   `AfterMdat` なら変えない
//! /// - 以外の箱(mvhd・tkhd・mdhd・hdlr・stsd・stts・ctts・stsz・stsc …)はバイトまで不変
//! /// - None(今のまま配る): HEVC のトラックが無い・leading を持つ同期サンプルが無い
//! ///   (closed-GOP)・moov が読めない/壊れている(宣言サイズが収まらない・表が途中で
//! ///   切れている)・stco の値が delta を足して 32 ビットを超える
//! pub fn rewrite_moov_for_open_gop(moov: &[u8], position: MoovPosition) -> Option<Vec<u8>>;
//!
//! /// 書き換えた後のファイル(契約3)= 元のファイルの [offset, offset+original_len) を
//! /// `moov` で置き換えたもの、の見え方。Range の切り出しをファイルなしで組めるようにする。
//! pub struct MoovPatch {
//!     /// 元のファイルでの moov 箱の位置
//!     pub offset: u64,
//!     /// 元の moov 箱の長さ
//!     pub original_len: u64,
//!     /// 書き換えた moov 箱(ヘッダ込み)= rewrite_moov_for_open_gop の結果
//!     pub moov: Vec<u8>,
//! }
//!
//! /// 書き換えた後のファイルの範囲 [start, start+len) を成す部品(並び順どおりに連結すると
//! /// その範囲になる。長さ 0 の部品を含めてよい)。
//! #[derive(Debug, Clone, PartialEq, Eq)]
//! pub enum Piece {
//!     /// 元のファイルの [offset, offset+len)
//!     Original { offset: u64, len: u64 },
//!     /// 書き換えた moov(MoovPatch::moov)の [start, start+len)
//!     Moov { start: usize, len: usize },
//! }
//!
//! impl MoovPatch {
//!     /// 書き換えた後のファイルの大きさ(= original_total − original_len + moov.len())。
//!     /// Content-Length・Content-Range・416 の大きさはこれを使う
//!     pub fn patched_total(&self, original_total: u64) -> u64;
//!     /// 書き換えた後のファイルの [start, start+len)(start+len ≤ patched_total)の部品
//!     pub fn pieces(&self, start: u64, len: u64) -> Vec<Piece>;
//! }
//!
//! // 配線(契約1・3・4・5・6・AC (f)): src-tauri/src/commands/asset.rs の `handle_asset`。
//! // - 配るファイルが動画(mime_guess が video/…・先頭の箱が ftyp)なら、トップレベルの箱を
//! //   `get_video_frame_index` と同じ読み方で歩いて moov を見つけ(64 MiB の上限も同じ)、
//! //   rewrite_moov_for_open_gop が Some なら MoovPatch を通して配る:
//! //   `Range` の解釈(resolve_range)は patched_total に対して行い、`Content-Range` の全体の
//! //   大きさ・416 の大きさも patched_total。ボディは pieces から組む
//! // - fragmented(top level に moof / moov に mvex)は書き換えない
//! // - 書き換えないときは今までどおりのバイトを配る(closed-GOP の HEVC・H.264・動画でない
//! //   ファイル(.bin など mime が video でないもの)・壊れた moov …)
//! // - 書き換えた moov の覚え(契約5)は実装裁量(本テストは判定しない)
//! // - `get_video_frame_index` は元のファイルを読む(不変。書き換えた moov から読んでも
//! //   索引は同じ= AC (e))
//! ```
//!
//! フィクスチャはすべて本ファイル内でバイト列合成する(実動画のコミットなし)。
//! 契約外(本テストが判定しない): 64 MiB を超える moov・書き換えた moov の覚え(契約5)・
//! stps の stbl 内の位置・size==1(64 ビット)の moov。

use std::path::Path;
use std::sync::Arc;

use vellis_lib::commands::asset::{handle_asset, resolve_range, RangeResolution};
use vellis_lib::commands::AppState;
use vellis_lib::fs::registry::FileProviderRegistry;
use vellis_lib::video_frames::parse_frame_index;
use vellis_lib::video_sync::{
    leading_sync_samples, rewrite_moov_for_open_gop, MoovPatch, MoovPosition, Piece,
};
use vellis_lib::watch::hub::DocumentCoordinator;
use vellis_lib::window::manager::WindowManager;

// ---------------------------------------------------------------------------
// 箱の合成ヘルパ(acceptance_req37_ctts.rs と同じ流儀)
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

/// stsd(sample entry 1 件。4CC がコーデックの判定材料。映像は VisualSampleEntry の形・
/// 音声は AudioSampleEntry の形で中身はダミー)。
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
const HEV1: [u8; 4] = *b"hev1";
const AVC1: [u8; 4] = *b"avc1";
const MP4A: [u8; 4] = *b"mp4a";

/// media timescale(ffmpeg が 30fps に書く 15360)。
const TS: u32 = 15360;
/// 1 フレーム = 512 ticks。
const F: u32 = 512;

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
    sample_size: u32,
    stsc: Vec<(u32, u32, u32)>,
    chunk_sizes: Vec<u32>,
    co64: bool,
    /// 指定すると mdat の実位置ではなくこの値を stco に書く(32 ビット溢れの試験用)。
    chunk_offsets_override: Option<Vec<u64>>,
}

impl TrackSpec {
    fn with_stps(mut self, stps: &[u32]) -> Self {
        self.stps = Some(stps.to_vec());
        self
    }

    fn with_co64(mut self) -> Self {
        self.co64 = true;
        self
    }

    fn with_chunk_offsets(mut self, offsets: &[u64]) -> Self {
        assert_eq!(offsets.len(), self.chunk_sizes.len());
        self.chunk_offsets_override = Some(offsets.to_vec());
        self
    }

    fn sample_count(&self) -> u32 {
        self.stts.iter().map(|(c, _)| c).sum()
    }

    /// trak > (tkhd, mdia > (mdhd, hdlr, minf > stbl > (stsd, stts, [ctts], [stss], [stps], stsc, stsz, stco|co64)))。
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

/// open-GOP の HEVC(x265 既定の形を 19 サンプル・GOP 6〜7 に縮めたもの)。
///
/// ```text
/// 復号順 d :  0   1   2   3   4   5   6 |  7    8    9   10  11  12 | 13   14   15   16  17  18
/// 種別     : IDR  P   B   B   P   B   B | CRA RASL RASL  P   B   B | CRA RASL RASL  P   B   B
/// 提示 p   :  0   3   1   2   6   4   5 |  9    7    8   12  10  11 | 15   13   14   18  16  17
/// ctts/F   :  1   3   0   0   3   0   0 |  3    0    0    3   0   0 |  3    0    0    3   0   0   (= p − d + 1)
/// PTS/F    :  1   4   2   3   7   5   6 | 10    8    9   13  11  12 | 16   14   15   19  17  18
/// ```
/// stss(1 起点)= 1・8・14。サンプル 8(CRA・PTS 10F)の後に復号される 9・10 の PTS(8F・9F)が
/// 前= leading を持つ。14 も同じ(15・16 が 14F・15F)。先頭の 1 は持たない。
/// → leading を持つ同期サンプル = [8, 14]。
/// チャンク: 7・6・6 サンプル(各 100 バイト)= 700・600・600 バイト。
fn hevc_open_gop(track_id: u32, codec: [u8; 4]) -> TrackSpec {
    TrackSpec {
        track_id,
        handler: *b"vide",
        codec,
        timescale: TS,
        stts: vec![(19, F)],
        ctts: Some(vec![
            (1, F),
            (1, 3 * F),
            (2, 0),
            (1, 3 * F),
            (2, 0),
            (1, 3 * F),
            (2, 0),
            (1, 3 * F),
            (2, 0),
            (1, 3 * F),
            (2, 0),
            (1, 3 * F),
            (2, 0),
        ]),
        stss: Some(vec![1, 8, 14]),
        stps: None,
        sample_size: 100,
        stsc: vec![(1, 7, 1), (2, 6, 1), (3, 6, 1)],
        chunk_sizes: vec![700, 600, 600],
        co64: false,
        chunk_offsets_override: None,
    }
}

/// leading を持つ同期サンプルの期待値(hevc_open_gop)。
const OPEN_GOP_LEADING_SYNC: &[u32] = &[8, 14];

/// closed-GOP の HEVC(同じ 19 サンプル・各 GOP の先頭が IDR で、IDR の後に復号される
/// サンプルはすべて IDR より後に提示される)。
///
/// ```text
/// 復号順 d :  0   1   2   3   4   5   6 |  7   8   9  10  11  12  13 | 14  15  16  17  18
/// 種別     : IDR  P   B   B   P   B   B | IDR  P   B   B   P   B   B | IDR  P   B   B   P
/// 提示 p   :  0   3   1   2   6   4   5 |  7  10   8   9  13  11  12 | 14  17  15  16  18
/// ctts/F   :  1   3   0   0   3   0   0 |  1   3   0   0   3   0   0 |  1   3   0   0   1
/// ```
/// stss = 1・8・15。leading を持つ同期サンプルは無い。
fn hevc_closed_gop(track_id: u32) -> TrackSpec {
    TrackSpec {
        ctts: Some(vec![
            (1, F),
            (1, 3 * F),
            (2, 0),
            (1, 3 * F),
            (2, 0),
            (1, F),
            (1, 3 * F),
            (2, 0),
            (1, 3 * F),
            (2, 0),
            (1, F),
            (1, 3 * F),
            (2, 0),
            (1, F),
        ]),
        stss: Some(vec![1, 8, 15]),
        ..hevc_open_gop(track_id, HVC1)
    }
}

/// closed-GOP の H.264(avc1・hevc_closed_gop と同じ並び)。leading を持つ同期サンプルは無い。
/// 要件37 追補g(2026-10-26・由谷承認・Issue #734)で H.264 の open-GOP も書き換えるようになった
/// ため、「H.264 だけ → 書き換えない」の素材をこれに差し替えた。
fn h264_closed_gop(track_id: u32) -> TrackSpec {
    TrackSpec {
        codec: AVC1,
        ..hevc_closed_gop(track_id)
    }
}

/// 先頭のサンプル(同期)の後に復号され提示が前のサンプルがあるが、先頭なので数えない素材。
///
/// ```text
/// 復号順 d :  0    1   2   3    4   5
/// 提示 p   :  2    0   1   5    3   4
/// ctts/F   :  3    0   0   3    0   0
/// PTS/F    :  3    1   2   6    4   5
/// ```
/// stss = 1・4。サンプル 1(PTS 3F)の後の 2・3 は PTS 1F・2F で前だが、先頭のサンプルなので
/// 入らない。サンプル 4(PTS 6F)の後の 5・6(4F・5F)で leading → [4]。
fn hevc_first_sample_has_leading(track_id: u32, codec: [u8; 4]) -> TrackSpec {
    TrackSpec {
        stts: vec![(6, F)],
        ctts: Some(vec![(1, 3 * F), (2, 0), (1, 3 * F), (2, 0)]),
        stss: Some(vec![1, 4]),
        stsc: vec![(1, 6, 1)],
        chunk_sizes: vec![600],
        ..hevc_open_gop(track_id, codec)
    }
}

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
        sample_size: 50,
        stsc: vec![(1, 4, 1)],
        chunk_sizes: vec![200, 200],
        co64: false,
        chunk_offsets_override: None,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Layout {
    /// ftyp・moov・(追加の箱)・mdat(faststart)。
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
    fn total(&self) -> u64 {
        self.bytes.len() as u64
    }

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

    fn patch_with(&self, moov: Vec<u8>) -> MoovPatch {
        MoovPatch {
            offset: self.moov_offset as u64,
            original_len: self.moov.len() as u64,
            moov,
        }
    }
}

/// `moov_extra` は moov の子として trak の後ろに足す箱(mvex など)。`top_extra` は moov と
/// mdat の間(MoovFirst)/ moov の後ろ(MoovLast)に置くトップレベルの箱(moof など)。
fn build_movie_with(
    layout: Layout,
    tracks: &[TrackSpec],
    moov_extra: &[Vec<u8>],
    top_extra: &[Vec<u8>],
) -> Movie {
    let ftyp = ftyp();
    let payload_len: usize = tracks
        .iter()
        .flat_map(|t| t.chunk_sizes.iter())
        .map(|s| *s as usize)
        .sum();
    let mdat = mp4_box(b"mdat", &patterned(payload_len));
    let extras: Vec<u8> = top_extra.concat();

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
        for e in moov_extra {
            children.push(e);
        }
        container(b"moov", &children)
    };

    // 1 回目: 位置の値は長さに影響しないので、ゼロ埋めで moov の長さだけ測る。
    let placeholder: Vec<Vec<u64>> = tracks
        .iter()
        .map(|t| vec![0u64; t.chunk_sizes.len()])
        .collect();
    let moov_len = moov_of(&placeholder).len();

    let mdat_payload = match layout {
        Layout::MoovFirst => ftyp.len() + moov_len + extras.len() + 8,
        Layout::MoovLast => ftyp.len() + 8,
    };
    let mut cursor = mdat_payload as u64;
    let chunk_offsets: Vec<Vec<u64>> = tracks
        .iter()
        .map(|t| {
            if let Some(o) = &t.chunk_offsets_override {
                return o.clone();
            }
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
            b.extend_from_slice(&extras);
            b.extend_from_slice(&mdat);
            (b, ftyp.len())
        }
        Layout::MoovLast => {
            let mut b = ftyp.clone();
            b.extend_from_slice(&mdat);
            let off = b.len();
            b.extend_from_slice(&moov);
            b.extend_from_slice(&extras);
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

fn build_movie(layout: Layout, tracks: &[TrackSpec]) -> Movie {
    build_movie_with(layout, tracks, &[], &[])
}

/// fragmented の体裁: moov に mvex(trex)、トップレベルに moof(mfhd)。
fn mvex(track_id: u32) -> Vec<u8> {
    let mut p = full_header(0);
    be32(&mut p, track_id);
    be32(&mut p, 1); // default_sample_description_index
    be32(&mut p, F); // default_sample_duration
    be32(&mut p, 100); // default_sample_size
    be32(&mut p, 0); // default_sample_flags
    let trex = mp4_box(b"trex", &p);
    container(b"mvex", &[&trex])
}

fn moof() -> Vec<u8> {
    let mut p = full_header(0);
    be32(&mut p, 1); // sequence_number
    let mfhd = mp4_box(b"mfhd", &p);
    container(b"moof", &[&mfhd])
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

/// moov の中の `index` 番目の trak。
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

/// 書き換えた moov の形(AC (b)): HEVC トラック `video` の stss / stps・親の大きさ・
/// 他の箱の不変・全トラックの stco の差。
fn assert_rewritten_moov(
    original: &[u8],
    rewritten: &[u8],
    video: usize,
    expected_stss: &[u32],
    expected_stps: &[u32],
    expected_delta: i64,
    expected_chunk_shift: i64,
) {
    let top = boxes_in(rewritten);
    assert_eq!(top.len(), 1, "結果は moov 箱 1 つ(ヘッダ込み)");
    assert_eq!(&top[0].0, b"moov", "結果の箱は moov");
    let delta = rewritten.len() as i64 - original.len() as i64;
    assert_eq!(delta, expected_delta, "moov の大きさの差");

    assert_eq!(
        first_child(rewritten, b"mvhd"),
        first_child(original, b"mvhd"),
        "mvhd は不変"
    );
    let traks_o = children(original, b"trak");
    let traks_n = children(rewritten, b"trak");
    assert_eq!(traks_o.len(), traks_n.len(), "trak の数は不変");

    for (i, (to, tn)) in traks_o.iter().zip(&traks_n).enumerate() {
        let is_video = i == video;
        let grow = if is_video { delta } else { 0 };
        let path_sizes = |t: &[u8]| -> Vec<usize> {
            let mdia = descend(t, &[b"mdia"]);
            let minf = descend(mdia, &[b"minf"]);
            let stbl = descend(minf, &[b"stbl"]);
            vec![t.len(), mdia.len(), minf.len(), stbl.len()]
        };
        let so = path_sizes(to);
        let sn = path_sizes(tn);
        for (name, (a, b)) in ["trak", "mdia", "minf", "stbl"].iter().zip(so.iter().zip(&sn)) {
            assert_eq!(
                *b as i64,
                *a as i64 + grow,
                "trak#{i} の {name} の大きさは差の分({grow})だけ改まる"
            );
        }
        assert_eq!(
            descend(to, &[b"tkhd"]),
            descend(tn, &[b"tkhd"]),
            "trak#{i} の tkhd は不変"
        );
        for kind in [b"mdhd", b"hdlr"] {
            assert_eq!(
                descend(to, &[b"mdia", kind]),
                descend(tn, &[b"mdia", kind]),
                "trak#{i} の {} は不変",
                fourcc(kind)
            );
        }
        let stbl_o = stbl_of(to);
        let stbl_n = stbl_of(tn);
        for kind in [b"stsd", b"stts", b"ctts", b"stsz", b"stsc"] {
            assert_eq!(
                first_child(stbl_o, kind),
                first_child(stbl_n, kind),
                "trak#{i} の {} は不変",
                fourcc(kind)
            );
        }
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
        if is_video {
            let stss = first_child(stbl_n, b"stss").expect("stss は残る");
            assert_eq!(table_u32(stss), expected_stss, "stss から該当の番号が消える");
            let stps = first_child(stbl_n, b"stps").expect("stps がある");
            assert_eq!(table_u32(stps), expected_stps, "stps に該当の番号が入る(昇順・重複なし)");
        } else {
            assert_eq!(
                first_child(stbl_o, b"stss"),
                first_child(stbl_n, b"stss"),
                "HEVC 以外の trak#{i} の stss は不変"
            );
            assert_eq!(
                first_child(stbl_o, b"stps"),
                first_child(stbl_n, b"stps"),
                "HEVC 以外の trak#{i} の stps は不変"
            );
        }
    }
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

// ---------------------------------------------------------------------------
// (a) 判定: leading を持つ同期サンプルの番号
// ---------------------------------------------------------------------------

/// AC-37-追f (a): open-GOP の HEVC(hvc1)で、leading を持つ同期サンプルの番号(1 起点)が
/// [8, 14]。先頭のサンプル(1)は入らない。moov の前後どちらの配置でも同じ。
#[test]
fn ac37f_a_open_gop_hevc_lists_sync_samples_with_leading() {
    for layout in [Layout::MoovLast, Layout::MoovFirst] {
        let movie = build_movie(layout, &[hevc_open_gop(1, HVC1)]);
        assert_eq!(
            leading_sync_samples(&movie.moov),
            vec![(1, OPEN_GOP_LEADING_SYNC.to_vec())],
            "{layout:?}: track 1 の CRA 8・14(stss 1・8・14 のうち、後に復号され前に提示されるサンプルを持つもの)"
        );
    }
}

/// AC-37-追f (a): closed-GOP(leading なし)は空。
#[test]
fn ac37f_a_closed_gop_hevc_has_no_leading_sync_samples() {
    let movie = build_movie(Layout::MoovLast, &[hevc_closed_gop(1)]);
    assert_eq!(
        leading_sync_samples(&movie.moov),
        Vec::<(u32, Vec<u32>)>::new(),
        "IDR だけの stss(1・8・15)には leading を持つ同期サンプルが無い"
    );
}

/// AC-37-追f (a): 先頭のサンプルは、後に復号され前に提示されるサンプルを持っていても入らない。
#[test]
fn ac37f_a_first_sample_is_never_listed() {
    let movie = build_movie(Layout::MoovLast, &[hevc_first_sample_has_leading(1, HVC1)]);
    assert_eq!(
        leading_sync_samples(&movie.moov),
        vec![(1, vec![4])],
        "サンプル 1(PTS 3F)の後の 2・3(1F・2F)は前だが先頭なので数えず、4 だけ"
    );
}

/// AC-37-追f (a): ctts が無い(B フレームなし)素材は提示順=復号順なので leading は無い。
#[test]
fn ac37f_a_material_without_ctts_has_no_leading() {
    let track = TrackSpec {
        ctts: None,
        ..hevc_open_gop(1, HVC1)
    };
    let movie = build_movie(Layout::MoovLast, &[track]);
    assert_eq!(leading_sync_samples(&movie.moov), Vec::<(u32, Vec<u32>)>::new());
}

/// AC-37-追f (a)・契約1: HEVC のトラックだけ。同じ並びの avc1 は載せない。hev1 は HEVC。
#[test]
fn ac37f_a_only_hevc_tracks_are_listed() {
    let avc_only = build_movie(Layout::MoovLast, &[hevc_open_gop(1, AVC1)]);
    assert_eq!(
        leading_sync_samples(&avc_only.moov),
        Vec::<(u32, Vec<u32>)>::new(),
        "avc1 のトラックは同じ並びでも対象外(H.264 の open-GOP は範囲外)"
    );

    let hev1 = build_movie(Layout::MoovLast, &[hevc_open_gop(1, HEV1)]);
    assert_eq!(
        leading_sync_samples(&hev1.moov),
        vec![(1, OPEN_GOP_LEADING_SYNC.to_vec())],
        "hev1 も HEVC"
    );

    let mixed = build_movie(
        Layout::MoovLast,
        &[
            hevc_open_gop(1, AVC1),
            audio_track(2),
            hevc_first_sample_has_leading(3, HEV1),
            hevc_open_gop(4, HVC1),
        ],
    );
    assert_eq!(
        leading_sync_samples(&mixed.moov),
        vec![(3, vec![4]), (4, OPEN_GOP_LEADING_SYNC.to_vec())],
        "avc1(1)と音声(2)は載せず、HEVC の 3・4 を moov の順に tkhd の track_ID で"
    );
}

/// AC-37-追f (a)・契約4: moov でないもの・空は空(panic しない)。
#[test]
fn ac37f_a_non_moov_input_is_empty() {
    assert_eq!(leading_sync_samples(&[]), Vec::<(u32, Vec<u32>)>::new());
    assert_eq!(
        leading_sync_samples(&mp4_box(b"free", &[0u8; 16])),
        Vec::<(u32, Vec<u32>)>::new()
    );
}

// ---------------------------------------------------------------------------
// (b) 書き換え: stss → stps・親の大きさ・stco
// ---------------------------------------------------------------------------

/// 新しい stps(2 件)を作るときの差: stss −8(2 件ぶん)・stps +24(ヘッダ 8+4+4、2 件 8)= +16。
const NEW_STPS_DELTA: i64 = 16;

/// AC-37-追f (b): moov が mdat の後ろ。stss から 8・14 が消えて stps に入り、親(stbl・minf・
/// mdia・trak・moov)が 16 バイト大きくなる。stco は変わらない。他の箱は不変。
#[test]
fn ac37f_b_rewrite_moves_cra_from_stss_to_stps_moov_after_mdat() {
    let movie = build_movie(Layout::MoovLast, &[hevc_open_gop(1, HVC1)]);
    let rewritten = rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat)
        .expect("open-GOP の HEVC は書き換える");
    assert_rewritten_moov(&movie.moov, &rewritten, 0, &[1], &[8, 14], NEW_STPS_DELTA, 0);
}

/// AC-37-追f (b): moov が mdat より前(faststart)。すべてのトラック(HEVC と音声)の stco の
/// 全部の値が差(16)の分だけ増える。
#[test]
fn ac37f_b_rewrite_shifts_every_tracks_chunk_offsets_when_moov_precedes_mdat() {
    let movie = build_movie(Layout::MoovFirst, &[hevc_open_gop(1, HVC1), audio_track(2)]);
    let rewritten = rewrite_moov_for_open_gop(&movie.moov, MoovPosition::BeforeMdat)
        .expect("open-GOP の HEVC は書き換える");
    assert_rewritten_moov(
        &movie.moov,
        &rewritten,
        0,
        &[1],
        &[8, 14],
        NEW_STPS_DELTA,
        NEW_STPS_DELTA,
    );
    // 書き換えた後のファイルで、動いた stco が元と同じ中身を指す。
    assert_chunks_point_to_same_bytes(&movie, &movie.patched_with(&rewritten));
}

/// AC-37-追f (b): 同じ moov でも AfterMdat と言われれば stco は動かさない(位置は呼び手が決める)。
#[test]
fn ac37f_b_chunk_offsets_are_untouched_when_told_moov_follows_mdat() {
    let movie = build_movie(Layout::MoovLast, &[hevc_open_gop(1, HVC1), audio_track(2)]);
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat).expect("書き換える");
    assert_rewritten_moov(&movie.moov, &rewritten, 0, &[1], &[8, 14], NEW_STPS_DELTA, 0);
    assert_chunks_point_to_same_bytes(&movie, &movie.patched_with(&rewritten));
}

/// AC-37-追f (b)・契約2: co64 も同じく差の分だけ増える。
#[test]
fn ac37f_b_co64_is_shifted_like_stco() {
    let movie = build_movie(
        Layout::MoovFirst,
        &[hevc_open_gop(1, HVC1).with_co64(), audio_track(2).with_co64()],
    );
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::BeforeMdat).expect("書き換える");
    assert_rewritten_moov(
        &movie.moov,
        &rewritten,
        0,
        &[1],
        &[8, 14],
        NEW_STPS_DELTA,
        NEW_STPS_DELTA,
    );
    assert_chunks_point_to_same_bytes(&movie, &movie.patched_with(&rewritten));
}

/// AC-37-追f (b)・契約1: stps がすでにあればそこへ足す(昇順)。移した分だけ stss が縮み
/// stps が伸びるので差は 0 → moov が mdat より前でも stco は動かない。
#[test]
fn ac37f_b_existing_stps_is_extended_in_ascending_order() {
    let movie = build_movie(
        Layout::MoovFirst,
        &[hevc_open_gop(1, HVC1).with_stps(&[5]), audio_track(2)],
    );
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::BeforeMdat).expect("書き換える");
    assert_rewritten_moov(&movie.moov, &rewritten, 0, &[1], &[5, 8, 14], 0, 0);
    assert_eq!(rewritten.len(), movie.moov.len(), "差 0 なので moov の長さは同じ");
}

/// AC-37-追f (b)・契約1: 既存の stps に同じ番号があれば重複させない。
/// stss −8・stps +4 で差は −4(moov が縮む)。
#[test]
fn ac37f_b_existing_stps_entry_is_not_duplicated() {
    let movie = build_movie(Layout::MoovLast, &[hevc_open_gop(1, HVC1).with_stps(&[8])]);
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat).expect("書き換える");
    assert_rewritten_moov(&movie.moov, &rewritten, 0, &[1], &[8, 14], -4, 0);
}

/// AC-37-追f (b): HEVC のトラックが複数あれば、それぞれの stss / stps を直す。
#[test]
fn ac37f_b_every_hevc_track_is_rewritten() {
    let movie = build_movie(
        Layout::MoovLast,
        &[hevc_open_gop(1, HVC1), hevc_first_sample_has_leading(2, HEV1)],
    );
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat).expect("書き換える");
    let t0 = stbl_of(trak_of(&rewritten, 0));
    assert_eq!(table_u32(first_child(t0, b"stss").unwrap()), vec![1]);
    assert_eq!(table_u32(first_child(t0, b"stps").unwrap()), vec![8, 14]);
    let t1 = stbl_of(trak_of(&rewritten, 1));
    assert_eq!(table_u32(first_child(t1, b"stss").unwrap()), vec![1]);
    assert_eq!(table_u32(first_child(t1, b"stps").unwrap()), vec![4]);
    assert_eq!(
        rewritten.len() as i64 - movie.moov.len() as i64,
        32,
        "差 = track 1 の +16(stss −8・stps +24)と track 2 の +16(stss −4・stps +20)"
    );
}

// ---------------------------------------------------------------------------
// (c) 書き換えないとき(純関数)
// ---------------------------------------------------------------------------

/// AC-37-追f (c): H.264(avc1)の closed-GOP のトラックだけ → None。
/// 要件37 追補g(2026-10-26・由谷承認・Issue #734)で H.264 の open-GOP も書き換えるようになったため、素材を closed-GOP に差し替えた。
#[test]
fn ac37f_c_h264_closed_gop_only_is_not_rewritten() {
    let movie = build_movie(Layout::MoovLast, &[h264_closed_gop(1), audio_track(2)]);
    assert_eq!(rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat), None);
    assert_eq!(rewrite_moov_for_open_gop(&movie.moov, MoovPosition::BeforeMdat), None);
}

/// AC-37-追f (c): closed-GOP の HEVC → None(契約6: バイトまで今と同じ)。
#[test]
fn ac37f_c_closed_gop_is_not_rewritten() {
    let movie = build_movie(Layout::MoovLast, &[hevc_closed_gop(1), audio_track(2)]);
    assert_eq!(rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat), None);
    assert_eq!(rewrite_moov_for_open_gop(&movie.moov, MoovPosition::BeforeMdat), None);
}

/// AC-37-追f (c): 壊れた moov → None(panic しない)。
/// - moov の宣言サイズがバッファより大きい(途中で切れている)
/// - 子(trak)の宣言サイズが moov に収まらない
/// - stss の entry_count が箱の大きさより多い(表が途中で切れている)
/// - 先頭が moov でない・空
#[test]
fn ac37f_c_broken_moov_is_not_rewritten() {
    let movie = build_movie(Layout::MoovLast, &[hevc_open_gop(1, HVC1)]);
    assert!(
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat).is_some(),
        "前提: 壊す前は書き換える"
    );

    let truncated = &movie.moov[..movie.moov.len() - 10];
    assert_eq!(
        rewrite_moov_for_open_gop(truncated, MoovPosition::AfterMdat),
        None,
        "宣言サイズがバッファより大きい moov"
    );

    let mut bad_child = movie.moov.clone();
    let trak_at = 8 + mvhd(1000).len();
    assert_eq!(&bad_child[trak_at + 4..trak_at + 8], b"trak");
    bad_child[trak_at..trak_at + 4].copy_from_slice(&0xFFFF_FF00u32.to_be_bytes());
    assert_eq!(
        rewrite_moov_for_open_gop(&bad_child, MoovPosition::AfterMdat),
        None,
        "trak の宣言サイズが moov に収まらない"
    );

    let mut bad_stss = movie.moov.clone();
    let stss = descend(&movie.moov, &[b"trak", b"mdia", b"minf", b"stbl", b"stss"]);
    let stss_at = stss.as_ptr() as usize - movie.moov.as_ptr() as usize;
    assert_eq!(&bad_stss[stss_at + 4..stss_at + 8], b"stss");
    // entry_count を 3 → 1000 に(箱の大きさはそのまま)。
    bad_stss[stss_at + 12..stss_at + 16].copy_from_slice(&1000u32.to_be_bytes());
    assert_eq!(
        rewrite_moov_for_open_gop(&bad_stss, MoovPosition::AfterMdat),
        None,
        "stss の表が途中で切れている"
    );

    assert_eq!(rewrite_moov_for_open_gop(&[], MoovPosition::AfterMdat), None, "空");
    assert_eq!(
        rewrite_moov_for_open_gop(&mp4_box(b"free", &[0u8; 16]), MoovPosition::AfterMdat),
        None,
        "moov でない箱"
    );
}

/// AC-37-追f (c)・契約2・4: stco の値が差を足して 32 ビットを超えるなら書き換えない。
/// 後ろ(足さない)なら溢れないので書き換える。
#[test]
fn ac37f_c_chunk_offset_overflowing_32_bits_is_not_rewritten() {
    let near_max = [0xFFFF_FFF0u64, 0xFFFF_FFF4, 0xFFFF_FFF8];
    let movie = build_movie(
        Layout::MoovFirst,
        &[hevc_open_gop(1, HVC1).with_chunk_offsets(&near_max)],
    );
    assert_eq!(
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::BeforeMdat),
        None,
        "0xFFFF_FFF0 + 16 は u32 に収まらない → 書き換えない(元のまま配る)"
    );
    let rewritten = rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat)
        .expect("stco を動かさないなら溢れないので書き換える");
    assert_rewritten_moov(&movie.moov, &rewritten, 0, &[1], &[8, 14], NEW_STPS_DELTA, 0);
}

// ---------------------------------------------------------------------------
// (d) Range: 書き換えた後のファイルからの切り出し(ファイルなし)
// ---------------------------------------------------------------------------

/// MoovPatch::pieces を連結して書き換えた後の [start, start+len) を組む。
fn assemble(patch: &MoovPatch, original: &[u8], start: u64, len: u64) -> Vec<u8> {
    let mut out = Vec::new();
    for piece in patch.pieces(start, len) {
        match piece {
            Piece::Original { offset, len } => {
                let (o, l) = (offset as usize, len as usize);
                assert!(o + l <= original.len(), "元のファイルの外を読まない({o}+{l})");
                out.extend_from_slice(&original[o..o + l]);
            }
            Piece::Moov { start, len } => {
                assert!(start + len <= patch.moov.len(), "書き換えた moov の外を読まない");
                out.extend_from_slice(&patch.moov[start..start + len]);
            }
        }
    }
    out
}

/// 書き換えた後のファイル `expected` に対して、いくつかの範囲が pieces から正しく組めること。
fn assert_ranges_assemble(movie: &Movie, patch: &MoovPatch, expected: &[u8]) {
    let total = expected.len() as u64;
    assert_eq!(
        patch.patched_total(movie.total()),
        total,
        "patched_total = 元の大きさ − 元の moov + 書き換えた moov"
    );
    let moov_start = patch.offset;
    let moov_end = moov_start + patch.moov.len() as u64;
    let cases: Vec<(&str, u64, u64)> = vec![
        ("全体", 0, total),
        ("moov の前だけ", 0, moov_start.min(total)),
        ("moov の前から moov をまたぐ", moov_start.saturating_sub(5), 10.min(total - moov_start.saturating_sub(5))),
        ("moov の中", moov_start + 3, 20),
        ("moov の先頭 1 バイト", moov_start, 1),
        ("moov の最後 1 バイト", moov_end - 1, 1),
        ("moov の後ろへまたぐ", moov_end - 8, 16.min(total - (moov_end - 8))),
        ("moov の後ろだけ", moov_end.min(total), total - moov_end.min(total)),
        ("末尾 16 バイト", total - 16, 16),
        ("末尾 1 バイト", total - 1, 1),
        ("長さ 0", moov_start, 0),
    ];
    for (name, start, len) in cases {
        let got = assemble(patch, &movie.bytes, start, len);
        assert_eq!(
            got,
            &expected[start as usize..(start + len) as usize],
            "{name}: [{start}, {start}+{len}) が書き換えた後のバイト列と一致"
        );
    }
}

/// AC-37-追f (d): moov が末尾(ffmpeg 既定)。書き換えた後のファイル(前=元・moov=書き換え)
/// から各範囲が切り出せ、全体の大きさが書き換えた後の大きさ。
#[test]
fn ac37f_d_ranges_are_cut_from_patched_file_moov_last() {
    let movie = build_movie(Layout::MoovLast, &[hevc_open_gop(1, HVC1), audio_track(2)]);
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat).expect("書き換える");
    let expected = movie.patched_with(&rewritten);
    assert_eq!(expected.len() as i64, movie.bytes.len() as i64 + NEW_STPS_DELTA);
    let patch = movie.patch_with(rewritten);
    assert_ranges_assemble(&movie, &patch, &expected);
}

/// AC-37-追f (d): moov が先頭(faststart)。moov の後ろ(mdat)は元のまま、位置だけ 16 ずれる。
#[test]
fn ac37f_d_ranges_are_cut_from_patched_file_moov_first() {
    let movie = build_movie(Layout::MoovFirst, &[hevc_open_gop(1, HVC1), audio_track(2)]);
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::BeforeMdat).expect("書き換える");
    let expected = movie.patched_with(&rewritten);
    let patch = movie.patch_with(rewritten);
    assert_ranges_assemble(&movie, &patch, &expected);
    assert_chunks_point_to_same_bytes(&movie, &expected);
}

/// AC-37-追f (d)・契約3: Range ヘッダの解釈(resolve_range)は書き換えた後の大きさに対して
/// 行う。`bytes=0-`・末尾・元の大きさから先(書き換え後なら充足可能)・範囲外(416)。
#[test]
fn ac37f_d_range_header_is_resolved_against_patched_total() {
    let movie = build_movie(Layout::MoovLast, &[hevc_open_gop(1, HVC1)]);
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat).expect("書き換える");
    let expected = movie.patched_with(&rewritten);
    let patch = movie.patch_with(rewritten);
    let original_total = movie.total();
    let total = patch.patched_total(original_total);
    assert_eq!(total, original_total + NEW_STPS_DELTA as u64);

    let cut = |header: &str| -> (u64, u64, Vec<u8>) {
        match resolve_range(header, total) {
            RangeResolution::Partial { start, end } => {
                (start, end, assemble(&patch, &movie.bytes, start, end - start + 1))
            }
            other => panic!("{header}: 充足可能なはず: {other:?}"),
        }
    };

    let (s, e, body) = cut("bytes=0-");
    assert_eq!((s, e), (0, total - 1), "小さいファイルなので 1 チャンクに収まる");
    assert_eq!(body, expected, "bytes=0- は書き換えた後の全体");

    let (s, e, body) = cut("bytes=-16");
    assert_eq!((s, e), (total - 16, total - 1));
    assert_eq!(body, &expected[(total - 16) as usize..], "末尾 16 バイトは書き換えた moov の末尾");

    let (s, e, body) = cut(&format!("bytes={}-", original_total));
    assert_eq!(
        (s, e),
        (original_total, total - 1),
        "元の大きさから先は、書き換えた後では充足可能(416 にしない)"
    );
    assert_eq!(body, &expected[original_total as usize..]);

    let straddle_start = patch.offset - 4;
    let (s, e, body) = cut(&format!("bytes={}-{}", straddle_start, straddle_start + 15));
    assert_eq!((s, e), (straddle_start, straddle_start + 15));
    assert_eq!(body, &expected[s as usize..=e as usize], "mdat の末尾と moov の先頭をまたぐ");

    assert_eq!(
        resolve_range(&format!("bytes={}-", total), total),
        RangeResolution::Unsatisfiable,
        "書き換えた後の大きさ以上から始まる範囲は 416(大きさは書き換えた後のもの)"
    );
}

// ---------------------------------------------------------------------------
// (e) 書き換えた moov から読んでもフレーム索引は同じ
// ---------------------------------------------------------------------------

/// AC-37-追f (e): 書き換えた後の moov を get_video_frame_index と同じ読み方
/// (parse_frame_index)で読んでも、フレーム索引(提示時刻)は元と同じ。
#[test]
fn ac37f_e_frame_index_is_unchanged_by_the_rewrite() {
    for (layout, position) in [
        (Layout::MoovLast, MoovPosition::AfterMdat),
        (Layout::MoovFirst, MoovPosition::BeforeMdat),
    ] {
        let movie = build_movie(layout, &[hevc_open_gop(1, HVC1), audio_track(2)]);
        let rewritten = rewrite_moov_for_open_gop(&movie.moov, position).expect("書き換える");
        let before = parse_frame_index(&movie.moov).expect("元の moov から索引が作れる");
        assert_eq!(before.sample_times.len(), 19, "前提: 19 フレーム");
        assert_eq!(before.sample_times[0], u64::from(F), "前提: 先頭の提示時刻は ctts のぶん");
        let after = parse_frame_index(&rewritten).expect("書き換えた moov からも索引が作れる");
        assert_eq!(after, before, "{layout:?}: 索引(提示時刻・尺・fps・CFR)は元と同じ");
        let from_file = parse_frame_index(&movie.patched_with(&rewritten)).expect("ファイル全体からも");
        assert_eq!(from_file, before);
    }
}

// ---------------------------------------------------------------------------
// (f) 配線: handle_asset が動画のときこの書き換えを通る
// ---------------------------------------------------------------------------

/// handle_asset を通すための最小 AppState(実プロバイダ・実ファイル。acceptance_req27.rs と同じ)。
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

/// 配られたファイルの HEVC トラック(最初の trak)の stss / stps。
fn served_sync_tables(file: &[u8]) -> (Vec<u32>, Option<Vec<u32>>) {
    let (_, moov) = find_moov(file);
    let stbl = stbl_of(trak_of(moov, 0));
    (
        table_u32(first_child(stbl, b"stss").expect("stss")),
        first_child(stbl, b"stps").map(table_u32),
    )
}

/// AC-37-追f (f): open-GOP の HEVC の .mp4(moov が末尾)を Range なしで配ると、ボディは
/// 書き換えた後のファイル(ftyp・mdat は元のまま・moov の stss=[1]・stps=[8,14])。
/// 純関数 rewrite_moov_for_open_gop の結果と一致する。
#[tokio::test]
async fn ac37f_f_handle_asset_serves_rewritten_moov_for_open_gop_hevc() {
    let dir = tempfile::tempdir().unwrap();
    let movie = build_movie(Layout::MoovLast, &[hevc_open_gop(1, HVC1), audio_track(2)]);
    let resp = serve(dir.path(), "open-gop.mp4", &movie.bytes, None).await;
    assert_body_response(&resp, 200, "open-GOP .mp4");
    assert!(
        header_str(&resp, "Content-Type").is_some_and(|m| m.starts_with("video/")),
        "Content-Type は動画のまま: {:?}",
        header_str(&resp, "Content-Type")
    );
    let body = resp.body();
    assert_eq!(
        body.len() as i64,
        movie.bytes.len() as i64 + NEW_STPS_DELTA,
        "ボディは書き換えた後の大きさ(元 + 16)"
    );
    assert_eq!(&body[..movie.moov_offset], &movie.bytes[..movie.moov_offset], "moov の前は元のまま");
    let (stss, stps) = served_sync_tables(body);
    assert_eq!(stss, vec![1], "配った moov の stss から CRA が消えている");
    assert_eq!(stps, Some(vec![8, 14]), "配った moov の stps に CRA が入っている");
    let rewritten = rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat)
        .expect("純関数も書き換える");
    assert_eq!(body, &movie.patched_with(&rewritten), "ボディ = 元の前 + 書き換えた moov");

    // 元のファイルは書き換えない。
    assert_eq!(std::fs::read(dir.path().join("open-gop.mp4")).unwrap(), movie.bytes);
}

/// AC-37-追f (f): moov が先頭(faststart)の .mov(video/quicktime)。stco が差の分だけ動き、
/// 動いた先が元と同じ中身を指す。moov と mdat をまたぐ Range は書き換えた後の位置で切り出され、
/// Content-Range の全体は書き換えた後の大きさ。
#[tokio::test]
async fn ac37f_f_handle_asset_moov_first_quicktime_shifts_chunk_offsets_and_ranges() {
    let dir = tempfile::tempdir().unwrap();
    let movie = build_movie(Layout::MoovFirst, &[hevc_open_gop(1, HVC1), audio_track(2)]);

    let whole = serve(dir.path(), "faststart.mov", &movie.bytes, None).await;
    assert_body_response(&whole, 200, "faststart .mov");
    let patched = whole.body().clone();
    let total = patched.len() as u64;
    assert_eq!(total as i64, movie.bytes.len() as i64 + NEW_STPS_DELTA);
    let (stss, stps) = served_sync_tables(&patched);
    assert_eq!(stss, vec![1]);
    assert_eq!(stps, Some(vec![8, 14]));
    assert_chunks_point_to_same_bytes(&movie, &patched);
    let (moov_at, moov) = find_moov(&patched);
    assert_eq!(moov_at, movie.moov_offset);
    assert_eq!(moov.len() as i64, movie.moov.len() as i64 + NEW_STPS_DELTA);
    assert_eq!(
        &patched[moov_at + moov.len()..],
        &movie.bytes[movie.moov_end()..],
        "moov の後ろ(mdat)は元のまま"
    );

    let moov_end = (moov_at + moov.len()) as u64;
    let (s, e) = (moov_end - 8, moov_end + 7);
    let part = serve(
        dir.path(),
        "faststart.mov",
        &movie.bytes,
        Some(&format!("bytes={s}-{e}")),
    )
    .await;
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

    let probe = serve(dir.path(), "faststart.mov", &movie.bytes, Some("bytes=0-0")).await;
    assert_body_response(&probe, 206, "bytes=0-0 の大きさの問い合わせ");
    assert_eq!(
        header_str(&probe, "Content-Range"),
        Some(format!("bytes 0-0/{total}").as_str())
    );
}

/// AC-37-追f (f)・契約3: 末尾・元の大きさから先・範囲外の Range。416 の大きさも書き換えた後。
#[tokio::test]
async fn ac37f_f_handle_asset_range_sizes_follow_patched_total() {
    let dir = tempfile::tempdir().unwrap();
    let movie = build_movie(Layout::MoovLast, &[hevc_open_gop(1, HVC1)]);
    let rewritten =
        rewrite_moov_for_open_gop(&movie.moov, MoovPosition::AfterMdat).expect("書き換える");
    let expected = movie.patched_with(&rewritten);
    let total = expected.len() as u64;
    let original_total = movie.total();

    let tail = serve(dir.path(), "clip.mp4", &movie.bytes, Some("bytes=-8")).await;
    assert_body_response(&tail, 206, "bytes=-8");
    assert_eq!(
        header_str(&tail, "Content-Range"),
        Some(format!("bytes {}-{}/{}", total - 8, total - 1, total).as_str())
    );
    assert_eq!(tail.body(), &expected[(total - 8) as usize..], "末尾は書き換えた moov の末尾");

    let beyond_original = serve(
        dir.path(),
        "clip.mp4",
        &movie.bytes,
        Some(&format!("bytes={}-", original_total)),
    )
    .await;
    assert_body_response(&beyond_original, 206, "元の大きさから先(書き換え後は充足可能)");
    assert_eq!(
        header_str(&beyond_original, "Content-Range"),
        Some(format!("bytes {}-{}/{}", original_total, total - 1, total).as_str())
    );
    assert_eq!(beyond_original.body(), &expected[original_total as usize..]);

    let open = serve(dir.path(), "clip.mp4", &movie.bytes, Some("bytes=0-")).await;
    assert_body_response(&open, 206, "bytes=0-");
    assert_eq!(
        header_str(&open, "Content-Range"),
        Some(format!("bytes 0-{}/{}", total - 1, total).as_str())
    );
    assert_eq!(open.body(), &expected);

    let unsat = serve(
        dir.path(),
        "clip.mp4",
        &movie.bytes,
        Some(&format!("bytes={}-", total)),
    )
    .await;
    assert_eq!(unsat.status().as_u16(), 416);
    assert_eq!(
        header_str(&unsat, "Content-Range"),
        Some(format!("bytes */{}", total).as_str()),
        "416 の大きさも書き換えた後の大きさ"
    );
}

/// AC-37-追f (c)(f)・契約4・6: 書き換えないときは今までどおり元のバイトをそのまま配る。
/// closed-GOP の HEVC・closed-GOP の H.264 だけ・fragmented(moov に mvex・top level に moof)・
/// 壊れたファイル(.mp4 だが ftyp で始まらない)・動画でない拡張子(.bin)に入った同じ中身。
#[tokio::test]
async fn ac37f_f_handle_asset_serves_original_bytes_when_not_rewriting() {
    let dir = tempfile::tempdir().unwrap();
    let open_gop = build_movie(Layout::MoovLast, &[hevc_open_gop(1, HVC1)]);
    let fragmented = build_movie_with(
        Layout::MoovFirst,
        &[hevc_open_gop(1, HVC1)],
        &[mvex(1)],
        &[moof()],
    );
    let garbage: Vec<u8> = patterned(600);
    let cases: Vec<(&str, Vec<u8>)> = vec![
        (
            "closed-gop.mp4",
            build_movie(Layout::MoovLast, &[hevc_closed_gop(1), audio_track(2)]).bytes,
        ),
        (
            "closed-gop-faststart.mp4",
            build_movie(Layout::MoovFirst, &[hevc_closed_gop(1), audio_track(2)]).bytes,
        ),
        (
            // 要件37 追補g(2026-10-26・由谷承認・Issue #734)で H.264 の open-GOP も書き換えるようになったため、素材を closed-GOP に差し替えた。
            "h264-closed-gop.mp4",
            build_movie(Layout::MoovLast, &[h264_closed_gop(1), audio_track(2)]).bytes,
        ),
        ("fragmented.mp4", fragmented.bytes),
        ("garbage.mp4", garbage),
        ("not-a-video.bin", open_gop.bytes.clone()),
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
