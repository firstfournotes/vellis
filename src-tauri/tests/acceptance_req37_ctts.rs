//! 要件#37 追補d の受け入れテスト(backlog 222・223・85=フレーム索引に ctts / elst を入れる)— Rust 層
//!
//! 受け入れ基準 AC-37-追d(docs/requirements/req-37.md「## 追補d」・判断 1〜8 は
//! 2026-10-02 に由谷が全件推奨案で確定)。
//!
//! ## 確定契約(implementer はこれに従う・判断 1〜8 の要約)
//!
//! ```ignore
//! // 実装先: src-tauri/src/video_frames.rs(`vellis_lib::video_frames`)。
//! // 公開 API(parse_frame_index / VideoFrameIndex のフィールド)は不変。
//! //
//! // 1. 時間の軸: sample_times は「提示時刻(ctts と edit list を当てた後)」を
//! //    提示順に並べたもの。edit list が無く ctts が正の素材では先頭が 0 ではない
//! //    (ffprobe の pts_time と一致)。
//! // 2. 添字=提示順の n 番目(ffmpeg の n)。同じ提示時刻のサンプルは復号順で
//! //    先のものを残して後のものを落とす(厳密な昇順)。
//! // 3. elst: 最初の media 編集(media_time = M ≥ 0)だけを使い、M を全サンプルから
//! //    引く。先頭の空編集(media_time = −1・segment_duration = D・mvhd の timescale)
//! //    は D を media の timescale に直したぶん後ろへずらす。複数の media 編集・
//! //    media_rate ≠ 1 は無視。
//! // 4. edit の開始より前(M を引いて負になる)のサンプルは索引から除く。
//! // 5. ctts version 1 の負のオフセットは符号付きで読む。edit を当てた後に負に
//! //    なったサンプルは 4 と同じく除く。
//! // 6. duration = 提示順に並べた最終フレームの終端
//! //    (max(提示時刻 + そのサンプルの stts の delta))。edit の segment_duration
//! //    (mvhd の timescale → media の timescale に直す)があればそれを上限にする。
//! // 7. is_cfr は提示順に並べた後の間隔で判定する(B フレームの無い CFR では不変)。
//! // 8. 壊れた ctts(サンプル数の合計が stts と合わない・途中で切れている)は
//! //    ctts を無視して stts だけの今の挙動に落ちる(fail-open・索引は None に
//! //    しない)。MAX_SAMPLES の上限は ctts のサンプル数にも掛ける。
//! // 9. ctts も edit list も無い素材の結果は従来どおり(stts の累積和・先頭 0)。
//! ```
//!
//! フィクスチャはすべて本ファイル内でバイト列合成する(実動画のコミットなし)。
//! 既存の `acceptance_req37.rs` は無改変で緑のまま(AC-37-追d (i))。
//!
//! ## 縁の扱い(2026-10-02 由谷が推奨案で確定・req-37.md 追補d (j)〜(m) と注記)
//!
//! ```ignore
//! // (j) 空編集の長さ D・segment_duration S を mvhd の timescale から media の
//! //     timescale に直すときは最も近い整数に丸める(ffmpeg の av_rescale と同じ)
//! // (k) segment_duration = 0 の media 編集は上限なし(末尾まで)
//! // (l) 先頭に空編集 D があるときの尺の上限は D + S(提示の時間軸の終わり)
//! // (m) 上限より後ろで始まるサンプルは索引から落とす。上限をまたぐ最後のフレームは
//! //     残し、尺を上限で切る
//! // 注記: edit list が無いのに ctts の負のオフセットで提示時刻が負になるサンプルは
//! //     除く(判断 5 = edit が無いときは当てる量が 0)
//! ```
//!
//! 本テストが踏まない縁(契約に無い・フィクスチャで避けた): 丸めの .5 ちょうどの値・
//! 上限ちょうどで始まるサンプル(境界の ≥ / >)・(e) でどちらを残したかは
//! `VideoFrameIndex` から観測できないので判定しない。

use vellis_lib::video_frames::{parse_frame_index, VideoFrameIndex};

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

/// mvhd v0(timescale を持つ=elst の segment_duration の単位)。
fn mvhd(timescale: u32) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    p.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    p.extend_from_slice(&timescale.to_be_bytes());
    p.extend_from_slice(&0u32.to_be_bytes()); // duration(採られない)
    p.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // rate 1.0
    p.extend_from_slice(&0x0100u16.to_be_bytes()); // volume 1.0
    p.extend_from_slice(&[0u8; 10]); // reserved
    p.extend_from_slice(&[0u8; 36]); // matrix
    p.extend_from_slice(&[0u8; 24]); // pre_defined
    p.extend_from_slice(&1u32.to_be_bytes()); // next_track_ID
    mp4_box(b"mvhd", &p)
}

/// mdhd v0。duration フィールドはダミー値(採られないこと)。
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

/// hdlr(handler_type でトラック種別を判定させる)。
fn hdlr(handler_type: &[u8; 4]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&[0u8; 4]); // pre_defined
    p.extend_from_slice(handler_type);
    p.extend_from_slice(&[0u8; 12]); // reserved
    p.extend_from_slice(b"Handler\0");
    mp4_box(b"hdlr", &p)
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

/// ctts version 0((sample_count, sample_offset) のランレングス列・offset は符号なし)。
fn ctts_v0(entries: &[(u32, u32)]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (count, offset) in entries {
        p.extend_from_slice(&count.to_be_bytes());
        p.extend_from_slice(&offset.to_be_bytes());
    }
    mp4_box(b"ctts", &p)
}

/// ctts version 1((sample_count, sample_offset) のランレングス列・offset は符号付き)。
fn ctts_v1(entries: &[(u32, i32)]) -> Vec<u8> {
    let mut p = full_header(1);
    p.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (count, offset) in entries {
        p.extend_from_slice(&count.to_be_bytes());
        p.extend_from_slice(&offset.to_be_bytes());
    }
    mp4_box(b"ctts", &p)
}

/// 途中で切れた ctts(entry_count の宣言より実体のエントリが少ない。箱のサイズ自体は
/// 実体と整合しているので、箱の走査は壊れず ctts の中身だけが読めない)。
fn ctts_v0_truncated(declared_count: u32, present: &[(u32, u32)]) -> Vec<u8> {
    assert!(
        (present.len() as u32) < declared_count,
        "フィクスチャの前提: 宣言数 > 実体数"
    );
    let mut p = full_header(0);
    p.extend_from_slice(&declared_count.to_be_bytes());
    for (count, offset) in present {
        p.extend_from_slice(&count.to_be_bytes());
        p.extend_from_slice(&offset.to_be_bytes());
    }
    mp4_box(b"ctts", &p)
}

/// edts > elst version 0。entries は (segment_duration [mvhd timescale], media_time
/// [media timescale・−1 = 空編集])。media_rate は 1.0 固定。
fn edts_elst_v0(entries: &[(u32, i32)]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (segment_duration, media_time) in entries {
        p.extend_from_slice(&segment_duration.to_be_bytes());
        p.extend_from_slice(&media_time.to_be_bytes());
        p.extend_from_slice(&1i16.to_be_bytes()); // media_rate_integer
        p.extend_from_slice(&0i16.to_be_bytes()); // media_rate_fraction
    }
    container(b"edts", &[&mp4_box(b"elst", &p)])
}

/// 読み飛ばし対象のダミー箱。
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

fn ftyp() -> Vec<u8> {
    mp4_box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2mp41")
}

fn mdat(len: usize) -> Vec<u8> {
    mp4_box(b"mdat", &vec![0xEEu8; len])
}

/// 映像トラック: trak > (tkhd, [edts], mdia > (mdhd, hdlr=vide, minf > stbl > (stsd, stts, [ctts])))。
/// `stbl_extra` は stts の後ろに置く箱(ctts など)。`stbl_before_stts` は stts の前に置く箱。
struct VideoTrack<'a> {
    timescale: u32,
    stts: &'a [(u32, u32)],
    ctts: Option<Vec<u8>>,
    ctts_before_stts: bool,
    edts: Option<Vec<u8>>,
}

impl<'a> VideoTrack<'a> {
    fn new(timescale: u32, stts: &'a [(u32, u32)]) -> Self {
        VideoTrack {
            timescale,
            stts,
            ctts: None,
            ctts_before_stts: false,
            edts: None,
        }
    }

    fn with_ctts(mut self, ctts: Vec<u8>) -> Self {
        self.ctts = Some(ctts);
        self
    }

    fn with_ctts_before_stts(mut self, ctts: Vec<u8>) -> Self {
        self.ctts = Some(ctts);
        self.ctts_before_stts = true;
        self
    }

    fn with_edts(mut self, edts: Vec<u8>) -> Self {
        self.edts = Some(edts);
        self
    }

    fn build(&self) -> Vec<u8> {
        let stsd = stsd_dummy();
        let stts = stts(self.stts);
        let mut stbl_children: Vec<&[u8]> = vec![&stsd];
        if let Some(ctts) = &self.ctts {
            if self.ctts_before_stts {
                stbl_children.push(ctts);
                stbl_children.push(&stts);
            } else {
                stbl_children.push(&stts);
                stbl_children.push(ctts);
            }
        } else {
            stbl_children.push(&stts);
        }
        let stbl = container(b"stbl", &stbl_children);
        let minf = container(b"minf", &[&stbl]);
        let mdhd = mdhd(self.timescale);
        let hdlr = hdlr(b"vide");
        let mdia = container(b"mdia", &[&mdhd, &hdlr, &minf]);

        let tkhd = tkhd_dummy();
        let mut trak_children: Vec<&[u8]> = vec![&tkhd];
        if let Some(edts) = &self.edts {
            trak_children.push(edts);
        }
        trak_children.push(&mdia);
        container(b"trak", &trak_children)
    }
}

/// ftyp + moov(mvhd(timescale) + trak)+ mdat の素直な並び。
fn build_movie(mvhd_timescale: u32, trak: &[u8]) -> Vec<u8> {
    let mvhd = mvhd(mvhd_timescale);
    let moov = container(b"moov", &[&mvhd, trak]);
    let mut file = ftyp();
    file.extend_from_slice(&moov);
    file.extend_from_slice(&mdat(32));
    file
}

/// 名目 fps(有理数)を比で比べる。
fn fps_ratio(idx: &VideoFrameIndex) -> f64 {
    idx.fps_num as f64 / idx.fps_den as f64
}

fn assert_strictly_ascending(idx: &VideoFrameIndex) {
    assert!(
        idx.sample_times.windows(2).all(|w| w[0] < w[1]),
        "提示時刻列は厳密な昇順であること: {:?}",
        idx.sample_times
    );
}

// ---------------------------------------------------------------------------
// 共通フィクスチャ: B フレームの典型の並び(timescale 1000・25fps・10 フレーム)
// ---------------------------------------------------------------------------

/// media timescale(ticks/秒)。
const TS: u32 = 1000;
/// 1 フレームの長さ(ticks)= 25fps。
const FRAME: u32 = 40;

/// 復号順 I P B B P B B P B B の 10 サンプル。stts は全サンプル delta 40。
///
/// ```text
/// 復号順 d :   0    1    2    3    4    5    6    7    8    9
/// 種別     :   I    P    B    B    P    B    B    P    B    B
/// DTS      :   0   40   80  120  160  200  240  280  320  360   (stts 累積・先頭 0)
/// PTS      :  80  200  120  160  320  240  280  440  360  400
/// ctts     :  80  160   40   40  160   40   40  160   40   40   (= PTS − DTS・全部 ≥ 0 → v0)
/// ```
/// 提示順に並べると I(80) B(120) B(160) P(200) B(240) B(280) P(320) B(360) B(400) P(440)
/// = 80 から 40 刻みで 10 個(先頭は 0 ではなく 80 = 2 フレームぶんの復号遅延)。
const BFRAME_STTS: &[(u32, u32)] = &[(10, FRAME)];
const BFRAME_CTTS_V0: &[(u32, u32)] = &[
    (1, 80),
    (1, 160),
    (2, 40),
    (1, 160),
    (2, 40),
    (1, 160),
    (2, 40),
];

/// B フレーム典型の提示時刻列(提示順)= 80, 120, …, 440。
fn bframe_presentation_times() -> Vec<u64> {
    (0..10u64).map(|n| 80 + n * u64::from(FRAME)).collect()
}

/// stts だけの従来どおりの提示時刻列(復号順の累積和・先頭 0)= 0, 40, …, 360。
fn stts_only_times() -> Vec<u64> {
    (0..10u64).map(|n| n * u64::from(FRAME)).collect()
}

fn bframe_track() -> VideoTrack<'static> {
    VideoTrack::new(TS, BFRAME_STTS).with_ctts(ctts_v0(BFRAME_CTTS_V0))
}

// ---------------------------------------------------------------------------
// (a) ctts v0・edit list なし: 提示時刻を提示順に並べる・先頭は 0 ではない
// ---------------------------------------------------------------------------

/// AC-37-追d (a): 復号順 I P B B … の ctts(version 0)を持ち edit list の無い素材で、
/// sample_times が提示時刻を提示順に並べたものになる。先頭は 0 ではなく先頭フレームの
/// 提示時刻(ctts のぶん= 80)。フレーム数は変わらず(10)・厳密な昇順。
#[test]
fn ac37d_a_ctts_v0_orders_frames_by_presentation_time_with_nonzero_first_time() {
    let file = build_movie(TS, &bframe_track().build());
    let idx = parse_frame_index(&file).expect("ctts 付きの B フレーム素材が解析できること");

    assert_eq!(idx.timescale, TS);
    assert_eq!(
        idx.sample_times.len(),
        10,
        "フレーム数は stts のサンプル数のまま(並べ替えで増減しない)"
    );
    assert_ne!(
        idx.sample_times[0], 0,
        "edit list が無く ctts が正の素材では先頭フレームの時刻は 0 ではない(判断 1)"
    );
    assert_eq!(
        idx.sample_times,
        bframe_presentation_times(),
        "提示時刻(DTS + ctts)を提示順に並べたもの: 80, 120, …, 440"
    );
    assert_strictly_ascending(&idx);
}

// ---------------------------------------------------------------------------
// (b) 最初の media 編集(media_time = M ≥ 0): M を引く・M より前のサンプルは除く
// ---------------------------------------------------------------------------

/// AC-37-追d (b): media 編集 M = 40 がある素材では全サンプルの提示時刻から 40 を引く。
///
/// 提示時刻 80, 120, …, 440 − 40 = 40, 80, …, 400(どれも負にならないので 10 件のまま)。
/// duration = max(提示時刻 + delta) = 400 + 40 = 440。segment_duration は 600(mvhd
/// timescale = media timescale = 1000)で非拘束。
#[test]
fn ac37d_b_media_edit_subtracts_media_time_from_every_sample() {
    let trak = bframe_track().with_edts(edts_elst_v0(&[(600, 40)])).build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file).expect("media 編集付きの素材が解析できること");

    let expected: Vec<u64> = bframe_presentation_times().iter().map(|t| t - 40).collect();
    assert_eq!(idx.sample_times, expected, "提示時刻 − M(M = 40)");
    assert_eq!(idx.sample_times.len(), 10);
    assert_eq!(idx.duration, 400 + u64::from(FRAME), "最終フレームの終端 = 400 + 40");
    assert_strictly_ascending(&idx);
}

/// AC-37-追d (b): media 編集 M = 160 の素材では、M より前に来るサンプル(負になるもの)
/// を索引から除く(判断 4・ffmpeg の既定と同じ)。
///
/// 提示時刻 80, 120, 160, 200, …, 440 − 160 = −80, −40, 0, 40, …, 280 → 負の 2 件を除き
/// 0, 40, …, 280 の 8 件。duration = 280 + 40 = 320。segment_duration 600 は非拘束。
#[test]
fn ac37d_b_samples_before_media_time_are_dropped() {
    let trak = bframe_track().with_edts(edts_elst_v0(&[(600, 160)])).build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file).expect("先頭を切り落とす media 編集でも解析できること");

    let expected: Vec<u64> = (0..8u64).map(|n| n * u64::from(FRAME)).collect();
    assert_eq!(
        idx.sample_times, expected,
        "M = 160 より前の 2 サンプル(−80・−40)が除かれ、0 から 8 件"
    );
    assert_eq!(idx.sample_times.len(), 8);
    assert_eq!(idx.duration, 280 + u64::from(FRAME));
    assert_strictly_ascending(&idx);
}

/// AC-37-追d (b): edit list は ctts の無い素材にも効く(判断 3 は ctts の有無に依らない)。
///
/// stts だけ(DTS = PTS = 0, 40, …, 360)に media 編集 M = 40 → −40(除く), 0, 40, …, 320
/// の 9 件。duration = 320 + 40 = 360。
#[test]
fn ac37d_b_media_edit_applies_to_material_without_ctts() {
    let trak = VideoTrack::new(TS, BFRAME_STTS)
        .with_edts(edts_elst_v0(&[(600, 40)]))
        .build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file).expect("ctts 無し・elst 有りの素材が解析できること");

    let expected: Vec<u64> = (0..9u64).map(|n| n * u64::from(FRAME)).collect();
    assert_eq!(idx.sample_times, expected, "先頭の 1 サンプルが除かれ、0 から 9 件");
    assert_eq!(idx.duration, 320 + u64::from(FRAME));
}

// ---------------------------------------------------------------------------
// (c) 先頭の空編集(media_time = −1・segment_duration = D・mvhd の timescale)
// ---------------------------------------------------------------------------

/// AC-37-追d (c): 空編集 D(mvhd timescale)に続く media 編集 M がある素材では、D を
/// media の timescale に直したぶん後ろへずらす。
///
/// mvhd timescale = 600・media timescale = 1000。空編集 D = 60(mvhd ticks)= 0.1 秒
/// = 100(media ticks・割り切れる)。media 編集 M = 80(= 先頭フレームの提示時刻・
/// ffmpeg が B フレーム素材に書く典型)。
/// 提示時刻 80, 120, …, 440 − 80 + 100 = 100, 140, …, 460(10 件)。
/// duration = 460 + 40 = 500。media 編集の segment_duration = 600(mvhd ticks)= 1000
/// (media ticks)は S とも D + S とも読んでも非拘束。
#[test]
fn ac37d_c_leading_empty_edit_shifts_times_later_by_its_length_in_media_ticks() {
    let trak = bframe_track()
        .with_edts(edts_elst_v0(&[(60, -1), (600, 80)]))
        .build();
    let file = build_movie(600, &trak);
    let idx = parse_frame_index(&file).expect("空編集 + media 編集の素材が解析できること");

    let expected: Vec<u64> = bframe_presentation_times()
        .iter()
        .map(|t| t - 80 + 100)
        .collect();
    assert_eq!(
        idx.sample_times, expected,
        "提示時刻 − M(80)+ D(60 mvhd ticks = 100 media ticks)= 100, 140, …, 460"
    );
    assert_eq!(idx.sample_times.len(), 10);
    assert_eq!(idx.timescale, TS, "索引の timescale は mdhd のまま(mvhd の 600 ではない)");
    assert_eq!(idx.duration, 460 + u64::from(FRAME));
    assert_strictly_ascending(&idx);
}

// ---------------------------------------------------------------------------
// (d) ctts version 1 の負のオフセットを符号付きで読む
// ---------------------------------------------------------------------------

/// 復号順 I P B B の 4 サンプル(stts 全 delta 40)。version 1 の符号付きオフセット。
///
/// ```text
/// 復号順 d :   0    1    2    3
/// 種別     :   I    P    B    B
/// DTS      :   0   40   80  120
/// ctts(v1) :  20  100  −20  −20
/// PTS      :  20  140   60  100
/// ```
/// 提示順 = 20, 60, 100, 140(等間隔 40 = CFR 25fps)。duration = 140 + 40 = 180。
/// 符号なしで読むと −20 → 4 294 967 276 となり並びが壊れる。
const NEG_CTTS_STTS: &[(u32, u32)] = &[(4, FRAME)];
const NEG_CTTS_V1: &[(u32, i32)] = &[(1, 20), (1, 100), (2, -20)];

/// AC-37-追d (d): ctts version 1 の負のオフセットを符号付きで読む。
#[test]
fn ac37d_d_ctts_v1_negative_offsets_are_read_as_signed() {
    let trak = VideoTrack::new(TS, NEG_CTTS_STTS)
        .with_ctts(ctts_v1(NEG_CTTS_V1))
        .build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file).expect("ctts v1 の素材が解析できること");

    assert_eq!(
        idx.sample_times,
        vec![20, 60, 100, 140],
        "DTS + 符号付きオフセットを提示順に並べたもの"
    );
    assert_eq!(idx.duration, 140 + u64::from(FRAME));
    assert!(idx.is_cfr, "提示順の間隔が全部 40 なので CFR");
    assert!((fps_ratio(&idx) - 25.0).abs() < 1e-9, "fps = 1000 / 40");
    assert_strictly_ascending(&idx);
}

/// AC-37-追d (d): edit を当てた後に負になったサンプルは除く(判断 5 → 4 と同じ)。
///
/// 上の提示時刻 20, 140, 60, 100 に media 編集 M = 60 → −40(除く), 80, 0, 40
/// → 提示順 0, 40, 80 の 3 件。duration = 80 + 40 = 120。segment_duration 600 は非拘束。
#[test]
fn ac37d_d_samples_negative_after_edit_are_dropped() {
    let trak = VideoTrack::new(TS, NEG_CTTS_STTS)
        .with_ctts(ctts_v1(NEG_CTTS_V1))
        .with_edts(edts_elst_v0(&[(600, 60)]))
        .build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file).expect("ctts v1 + media 編集の素材が解析できること");

    assert_eq!(
        idx.sample_times,
        vec![0, 40, 80],
        "M = 60 を引いて負になった I フレーム(20 − 60 = −40)が除かれる"
    );
    assert_eq!(idx.sample_times.len(), 3);
    assert_eq!(idx.duration, 80 + u64::from(FRAME));
    assert_strictly_ascending(&idx);
}

// ---------------------------------------------------------------------------
// (e) 同じ提示時刻に並ぶサンプルは 1 つに畳む(厳密な昇順を保つ)
// ---------------------------------------------------------------------------

/// AC-37-追d (e): 同じ提示時刻のサンプルは復号順で先のものを残して後のものを落とす。
///
/// ```text
/// 復号順 d :   0    1    2
/// DTS      :   0   40   80      (stts 全 delta 40)
/// ctts(v0) :  40    0    0
/// PTS      :  40   40   80      ← d=0 と d=1 が同じ 40
/// ```
/// 提示順 = 40, 80 の 2 件(重複を 1 つに)。duration = 80 + 40 = 120(どちらを残しても同じ)。
#[test]
fn ac37d_e_equal_presentation_times_collapse_to_one_frame() {
    let trak = VideoTrack::new(TS, &[(3, FRAME)])
        .with_ctts(ctts_v0(&[(1, 40), (2, 0)]))
        .build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file).expect("提示時刻が重なる素材でも解析できること");

    assert_eq!(
        idx.sample_times,
        vec![40, 80],
        "同じ提示時刻 40 のサンプルは 1 つだけ残る"
    );
    assert_eq!(idx.sample_times.len(), 2);
    assert_strictly_ascending(&idx);
    assert_eq!(idx.duration, 80 + u64::from(FRAME));
}

// ---------------------------------------------------------------------------
// (f) 尺 = 提示順の最終フレームの終端・edit の segment_duration を上限に
// ---------------------------------------------------------------------------

/// AC-37-追d (f): duration は提示順に並べた最終フレームの終端
/// = max(提示時刻 + そのサンプルの stts の delta)。
///
/// B フレーム典型: 最終提示フレームは P(440・delta 40)→ 480。stts の総和(400)ではない。
#[test]
fn ac37d_f_duration_is_end_of_last_presented_frame() {
    let file = build_movie(TS, &bframe_track().build());
    let idx = parse_frame_index(&file).expect("解析できること");

    assert_eq!(
        idx.duration,
        440 + u64::from(FRAME),
        "max(提示時刻 + delta) = 440 + 40 = 480(stts 総和 400 ではない)"
    );
    assert_eq!(
        idx.duration,
        *idx.sample_times.last().unwrap() + u64::from(FRAME),
        "最終フレームの終端と自己整合する"
    );
}

/// AC-37-追d (f): edit の segment_duration があればそれを尺の上限にする。
///
/// mvhd timescale = 600。media 編集 M = 80・segment_duration S = 228(mvhd ticks)
/// = 0.38 秒 = 380(media ticks・割り切れる)。提示時刻 80, …, 440 − 80 = 0, 40, …, 360
/// (10 件・どれも 380 以下なので索引は変わらない)。最終フレームの終端は 360 + 40 = 400
/// だが、S = 380 が上限 → duration = 380。
#[test]
fn ac37d_f_edit_segment_duration_caps_duration() {
    let trak = bframe_track().with_edts(edts_elst_v0(&[(228, 80)])).build();
    let file = build_movie(600, &trak);
    let idx = parse_frame_index(&file).expect("segment_duration 付きの素材が解析できること");

    assert_eq!(
        idx.sample_times,
        stts_only_times(),
        "提示時刻 − M(80)= 0, 40, …, 360"
    );
    assert_eq!(
        idx.duration, 380,
        "min(最終フレームの終端 400, segment_duration 228 mvhd ticks = 380 media ticks) = 380"
    );
    assert!(
        idx.sample_times.iter().all(|t| *t < idx.duration),
        "全サンプルの提示時刻は duration より前(上限がサンプルを跨がないフィクスチャ)"
    );
}

// ---------------------------------------------------------------------------
// (g) CFR の判定は提示順に並べた後の間隔で行う
// ---------------------------------------------------------------------------

/// AC-37-追d (g): B フレームの入った CFR の素材は CFR のまま・fps も同じ(25fps)。
#[test]
fn ac37d_g_bframe_cfr_material_stays_cfr_with_same_fps() {
    let file = build_movie(TS, &bframe_track().build());
    let idx = parse_frame_index(&file).expect("解析できること");

    assert!(idx.is_cfr, "提示順の間隔が全部 40 なので CFR のまま");
    assert!(
        (fps_ratio(&idx) - 25.0).abs() < 1e-9,
        "fps = timescale / 提示間隔 = 1000 / 40 = 25。得られた比: {}",
        fps_ratio(&idx)
    );
    assert_ne!(idx.fps_den, 0);
}

/// AC-37-追d (g): 復号順の stts delta は一定でも、提示順に並べた間隔が揺れる素材は VFR。
///
/// ```text
/// 復号順 d :   0    1    2    3
/// DTS      :   0   40   80  120      (stts 全 delta 40 = 復号順だけ見ると CFR)
/// ctts(v0) :  80  160   20   40
/// PTS      :  80  200  100  160
/// ```
/// 提示順 = 80, 100, 160, 200 → 間隔 20, 60, 40(明白な VFR)→ is_cfr = false。
/// fps の代表値は実装裁量だが fps_den != 0。
#[test]
fn ac37d_g_cfr_is_judged_on_presentation_intervals_uniform_decode_deltas_can_be_vfr() {
    let trak = VideoTrack::new(TS, &[(4, FRAME)])
        .with_ctts(ctts_v0(&[(1, 80), (1, 160), (1, 20), (1, 40)]))
        .build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file).expect("解析できること");

    assert_eq!(idx.sample_times, vec![80, 100, 160, 200]);
    assert!(
        !idx.is_cfr,
        "提示順の間隔 20, 60, 40 は CFR ではない(復号順の delta が一定でも)"
    );
    assert_ne!(idx.fps_den, 0);
}

/// AC-37-追d (g): 復号順の stts delta が揺れていても、提示順に並べた間隔が一定なら CFR。
///
/// ```text
/// 復号順 d :   0    1    2    3
/// stts     :  30   20   40   40      (復号順だけ見ると VFR)
/// DTS      :   0   30   50   90
/// ctts(v0) :  80  170   70   70
/// PTS      :  80  200  120  160
/// ```
/// 提示順 = 80, 120, 160, 200 → 間隔 40, 40, 40 → is_cfr = true・fps = 1000 / 40 = 25。
#[test]
fn ac37d_g_cfr_is_judged_on_presentation_intervals_irregular_decode_deltas_can_be_cfr() {
    let trak = VideoTrack::new(TS, &[(1, 30), (1, 20), (2, 40)])
        .with_ctts(ctts_v0(&[(1, 80), (1, 170), (2, 70)]))
        .build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file).expect("解析できること");

    assert_eq!(idx.sample_times, vec![80, 120, 160, 200]);
    assert!(
        idx.is_cfr,
        "提示順の間隔が全部 40 なので CFR(復号順の delta が揺れていても)"
    );
    assert!(
        (fps_ratio(&idx) - 25.0).abs() < 1e-9,
        "fps = 1000 / 40 = 25。得られた比: {}",
        fps_ratio(&idx)
    );
}

// ---------------------------------------------------------------------------
// (h) 壊れた ctts は無視して stts だけの今の挙動に落ちる(fail-open)
// ---------------------------------------------------------------------------

/// stts だけの従来どおりの結果(0, 40, …, 360・duration 400・CFR 25fps)であること。
fn assert_stts_only_result(idx: &VideoFrameIndex) {
    assert_eq!(
        idx.sample_times,
        stts_only_times(),
        "ctts を無視した stts の累積和(先頭 0)"
    );
    assert_eq!(idx.duration, 10 * u64::from(FRAME), "stts の総和 = 400");
    assert!(idx.is_cfr);
    assert!((fps_ratio(idx) - 25.0).abs() < 1e-9);
}

/// AC-37-追d (h): ctts のサンプル数の合計(12)が stts(10)と合わない素材は、ctts を
/// 無視して stts だけの挙動に落ちる(索引は None にならない)。
#[test]
fn ac37d_h_ctts_sample_count_mismatch_falls_back_to_stts_only() {
    let trak = VideoTrack::new(TS, BFRAME_STTS)
        .with_ctts(ctts_v0(&[(12, 80)]))
        .build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file)
        .expect("サンプル数の合わない ctts でも索引は None にならない(fail-open)");
    assert_stts_only_result(&idx);
}

/// AC-37-追d (h): 途中で切れた ctts(entry_count = 7 の宣言に対し実体 3 件)の素材は、
/// ctts を無視して stts だけの挙動に落ちる。ctts を stts の前に置き、ctts の失敗で
/// stbl の走査ごと捨てないことも併せて確かめる。
#[test]
fn ac37d_h_truncated_ctts_falls_back_to_stts_only() {
    let truncated = ctts_v0_truncated(7, &[(1, 80), (1, 160), (2, 40)]);
    let trak = VideoTrack::new(TS, BFRAME_STTS)
        .with_ctts_before_stts(truncated)
        .build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file)
        .expect("途中で切れた ctts でも索引は None にならない(fail-open)");
    assert_stts_only_result(&idx);
}

/// AC-37-追d (h): ctts のサンプル数にも MAX_SAMPLES の上限を掛ける。
///
/// sample_count = u32::MAX(約 43 億・上限 6 000 000 を遥かに超える)を宣言する ctts は、
/// 展開も確保もせずに捨てて stts だけの挙動に落ちる(巨大確保で落ちれば本テストごと赤)。
#[test]
fn ac37d_h_ctts_sample_count_beyond_max_samples_is_refused_without_allocation() {
    let trak = VideoTrack::new(TS, BFRAME_STTS)
        .with_ctts(ctts_v0(&[(u32::MAX, 40)]))
        .build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file)
        .expect("上限を超える ctts でも索引は None にならない(fail-open)");
    assert_stts_only_result(&idx);
}

// ---------------------------------------------------------------------------
// (i) ctts も edit list も無い素材の結果は変わらない
// ---------------------------------------------------------------------------

/// AC-37-追d (i): ctts も edit list も無い最小の素材では、従来どおり stts の累積和
/// (先頭 0)・duration = 総和・CFR 25fps(既存の acceptance_req37.rs が担う範囲の確認)。
#[test]
fn ac37d_i_material_without_ctts_or_edit_list_is_unchanged() {
    let file = build_movie(TS, &VideoTrack::new(TS, BFRAME_STTS).build());
    let idx = parse_frame_index(&file).expect("最小の素材が解析できること");

    assert_eq!(idx.sample_times[0], 0, "ctts も edit list も無ければ先頭は 0");
    assert_stts_only_result(&idx);
}

// ---------------------------------------------------------------------------
// (j) mvhd timescale → media timescale の換算は最も近い整数に丸める
// ---------------------------------------------------------------------------

/// AC-37-追d (j): 空編集 D の換算で割り切れないときは最も近い整数に丸める。
///
/// mvhd timescale = 600・media timescale = 1000。空編集 D = 1(mvhd ticks)
/// = 1 × 1000 / 600 = 1.666…(media ticks)→ 最も近い整数 2(切り捨てなら 1)。
/// media 編集 M = 80 → 提示時刻 80, …, 440 − 80 + 2 = 2, 42, …, 362(10 件)。
/// duration = 362 + 40 = 402。上限 D + S = 2 + 1000(S = 600 mvhd ticks)は非拘束。
#[test]
fn ac37d_j_empty_edit_length_is_rounded_to_nearest_media_tick() {
    let trak = bframe_track()
        .with_edts(edts_elst_v0(&[(1, -1), (600, 80)]))
        .build();
    let file = build_movie(600, &trak);
    let idx = parse_frame_index(&file).expect("割り切れない空編集でも解析できること");

    let expected: Vec<u64> = bframe_presentation_times()
        .iter()
        .map(|t| t - 80 + 2)
        .collect();
    assert_eq!(
        idx.sample_times, expected,
        "D = 1 mvhd tick = 1.666… media ticks → 2(最も近い整数)ぶん後ろへ"
    );
    assert_eq!(idx.duration, 362 + u64::from(FRAME));
}

/// AC-37-追d (j): segment_duration S の換算で割り切れないときも最も近い整数に丸める。
///
/// mvhd timescale = 600。media 編集 M = 80・S = 229(mvhd ticks)= 229 × 1000 / 600
/// = 381.666…(media ticks)→ 382(切り捨てなら 381)。提示時刻 − 80 = 0, …, 360
/// (どれも 382 より手前なので 10 件のまま)。最終フレームの終端 400 > 382 → duration = 382。
#[test]
fn ac37d_j_segment_duration_is_rounded_to_nearest_media_tick() {
    let trak = bframe_track().with_edts(edts_elst_v0(&[(229, 80)])).build();
    let file = build_movie(600, &trak);
    let idx = parse_frame_index(&file).expect("割り切れない segment_duration でも解析できること");

    assert_eq!(idx.sample_times, stts_only_times());
    assert_eq!(
        idx.duration, 382,
        "S = 229 mvhd ticks = 381.666… media ticks → 382(最も近い整数)が上限"
    );
}

// ---------------------------------------------------------------------------
// (k) segment_duration = 0 の media 編集は上限なし(末尾まで)
// ---------------------------------------------------------------------------

/// AC-37-追d (k): segment_duration = 0 の media 編集は尺に上限を掛けない。
///
/// media 編集 M = 40・S = 0 → 提示時刻 80, …, 440 − 40 = 40, …, 400(10 件)。
/// duration = 最終フレームの終端 400 + 40 = 440(上限 0 で切らない)。
#[test]
fn ac37d_k_zero_segment_duration_means_no_cap() {
    let trak = bframe_track().with_edts(edts_elst_v0(&[(0, 40)])).build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file).expect("segment_duration = 0 の素材が解析できること");

    let expected: Vec<u64> = bframe_presentation_times().iter().map(|t| t - 40).collect();
    assert_eq!(idx.sample_times, expected, "M = 40 を引いた 10 件がそのまま残る");
    assert_eq!(
        idx.duration,
        400 + u64::from(FRAME),
        "segment_duration = 0 は「末尾まで」= 最終フレームの終端 440"
    );
}

// ---------------------------------------------------------------------------
// (l) 先頭に空編集 D があるときの尺の上限は D + S
// ---------------------------------------------------------------------------

/// AC-37-追d (l): 空編集 D に続く media 編集 S の上限は提示の時間軸の終わり D + S。
///
/// mvhd timescale = 600。空編集 D = 60(= 100 media ticks)・media 編集 M = 80・
/// S = 228(= 380 media ticks)。提示時刻 80, …, 440 − 80 + 100 = 100, 140, …, 460。
/// 上限 = D + S = 100 + 380 = 480。460 で始まる最終フレーム(460–500)は上限をまたぐ
/// ので残り(10 件のまま)、duration = 480(上限が S = 380 なら 380 になり、
/// 380 以降の 3 件が落ちる=そうならないこと)。
#[test]
fn ac37d_l_cap_after_leading_empty_edit_is_d_plus_s() {
    let trak = bframe_track()
        .with_edts(edts_elst_v0(&[(60, -1), (228, 80)]))
        .build();
    let file = build_movie(600, &trak);
    let idx = parse_frame_index(&file).expect("空編集 + 上限付き media 編集が解析できること");

    let expected: Vec<u64> = bframe_presentation_times()
        .iter()
        .map(|t| t - 80 + 100)
        .collect();
    assert_eq!(
        idx.sample_times, expected,
        "上限 D + S = 480 より手前で始まる 10 件すべてが残る(100, …, 460)"
    );
    assert_eq!(idx.duration, 480, "上限 = D(100)+ S(380)= 480 で切る");
}

// ---------------------------------------------------------------------------
// (m) 上限より後ろで始まるサンプルは落とし、またぐ最後のフレームは残して尺を上限で切る
// ---------------------------------------------------------------------------

/// AC-37-追d (m): S が最終フレームの提示時刻より手前に来る素材。
///
/// mvhd timescale = media timescale = 1000。media 編集 M = 80・S = 300。
/// 提示時刻 − 80 = 0, 40, …, 280, 320, 360。320・360 は上限 300 より後ろで始まるので
/// 落とす。280 で始まるフレーム(280–320)は上限をまたぐので残す → 0, …, 280 の 8 件。
/// duration = 300(最後のフレームの終端 320 ではなく上限で切る)。
#[test]
fn ac37d_m_samples_starting_after_cap_are_dropped_and_straddling_frame_is_kept() {
    let trak = bframe_track().with_edts(edts_elst_v0(&[(300, 80)])).build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file).expect("上限がサンプルを跨ぐ素材が解析できること");

    let expected: Vec<u64> = (0..8u64).map(|n| n * u64::from(FRAME)).collect();
    assert_eq!(
        idx.sample_times, expected,
        "上限 300 より後ろで始まる 320・360 を落とし、またぐ 280 は残す"
    );
    assert_eq!(idx.sample_times.len(), 8);
    assert_eq!(idx.duration, 300, "尺は上限 300 で切る(またぐフレームの終端 320 ではない)");
    assert!(
        idx.sample_times.iter().all(|t| *t < idx.duration),
        "残るサンプルはすべて尺より手前で始まる"
    );
}

// ---------------------------------------------------------------------------
// 注記: edit list が無くても提示時刻が負になるサンプルは除く
// ---------------------------------------------------------------------------

/// 追補d 注記: edit list が無いのに ctts の負のオフセットで提示時刻が負になるサンプルは
/// 除く(判断 5・edit が無いときは当てる量 0)。
///
/// ```text
/// 復号順 d :   0    1     2    3
/// DTS      :   0   40    80  120      (stts 全 delta 40)
/// ctts(v1) :  20  100  −100  −20
/// PTS      :  20  140   −20  100
/// ```
/// −20 のサンプルを除き、提示順 = 20, 100, 140 の 3 件。duration = 140 + 40 = 180。
#[test]
fn ac37d_note_negative_presentation_time_without_edit_list_is_dropped() {
    let trak = VideoTrack::new(TS, NEG_CTTS_STTS)
        .with_ctts(ctts_v1(&[(1, 20), (1, 100), (1, -100), (1, -20)]))
        .build();
    let file = build_movie(TS, &trak);
    let idx = parse_frame_index(&file).expect("負の提示時刻を含む素材でも解析できること");

    assert_eq!(
        idx.sample_times,
        vec![20, 100, 140],
        "提示時刻が負になった d=2(80 − 100 = −20)を除く"
    );
    assert_eq!(idx.sample_times.len(), 3);
    assert_eq!(idx.duration, 140 + u64::from(FRAME));
    assert_strictly_ascending(&idx);
}
