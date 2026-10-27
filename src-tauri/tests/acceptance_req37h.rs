//! 要件#37 追補h の受け入れテスト(Issue #624=backlog 254=CFR の判定で最終フレームの長さを
//! 数えるかどうかが、ctts / edit list の有無で分かれる)— Rust 層
//!
//! 受け入れ基準 AC-37-追h (a)〜(e)(docs/requirements/req-37.md「## 追補h」契約 1〜3)。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/video_frames.rs(`vellis_lib::video_frames`)。
//! // 公開 API(parse_frame_index / VideoFrameIndex のフィールド)は不変。
//! //
//! // 1. ctts も edit list も無い素材の CFR の判定(is_cfr)と公称の間隔(fps_num/fps_den の元)
//! //    は、ctts か edit list がある素材と同じく、提示順で隣り合うフレームの開始の間隔
//! //    (フレーム数 −1 個)から求める。最終フレームの長さ(最終サンプルの stts の delta)は
//! //    数えない(由谷の決定 2026-10-26「隣の間隔に揃える」)。
//! // 2. フレームが 1 枚だけの素材は、隣の間隔が無いので、その 1 枚の長さで求める
//! //    (ctts か edit list がある素材の今の扱いと同じ。結果は今と同じ)。
//! // 3. 不変: フレームの開始時刻(sample_times)・尺(duration)・ctts か edit list がある素材の
//! //    判定・許容(0.5%)・公称の間隔の選び方(いちばん多くのフレームが持つ間隔)。
//! ```
//!
//! フィクスチャはすべて本ファイル内でバイト列合成する(acceptance_req37_ctts.rs と同じ流儀)。
//! 契約外(本テストが判定しない): 同数の run が並んだときの公称の間隔の選び方(起案時判断 (a)・
//! 由谷の事後確認待ち)・許容 0.5% ちょうどの境界。

use vellis_lib::video_frames::{parse_frame_index, VideoFrameIndex};

// ---------------------------------------------------------------------------
// フィクスチャ合成ヘルパ
// ---------------------------------------------------------------------------

/// 32bit サイズの箱(size はヘッダ 8 バイトを含む)。
fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(payload.len() + 8);
    b.extend_from_slice(&(payload.len() as u32 + 8).to_be_bytes());
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

/// mvhd v0(timescale = elst の segment_duration の単位)。
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
    p.extend_from_slice(&0u32.to_be_bytes());
    p.extend_from_slice(&0u32.to_be_bytes());
    p.extend_from_slice(&timescale.to_be_bytes());
    p.extend_from_slice(&999_999u32.to_be_bytes()); // duration(ダミー)
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

fn stts(entries: &[(u32, u32)]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (count, delta) in entries {
        p.extend_from_slice(&count.to_be_bytes());
        p.extend_from_slice(&delta.to_be_bytes());
    }
    mp4_box(b"stts", &p)
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

/// ctts の無い映像トラック(trak > (tkhd, [edts], mdia > (mdhd, hdlr=vide, minf > stbl >
/// (stsd, stts))))を持つ ftyp + moov(mvhd + trak)+ mdat の素直な並び。
fn movie(timescale: u32, stts_entries: &[(u32, u32)], edts: Option<Vec<u8>>) -> Vec<u8> {
    let stsd = stsd_dummy();
    let stts = stts(stts_entries);
    let stbl = container(b"stbl", &[&stsd, &stts]);
    let minf = container(b"minf", &[&stbl]);
    let mdhd = mdhd(timescale);
    let hdlr = hdlr(b"vide");
    let mdia = container(b"mdia", &[&mdhd, &hdlr, &minf]);
    let tkhd = tkhd_dummy();
    let mut trak_children: Vec<&[u8]> = vec![&tkhd];
    if let Some(edts) = &edts {
        trak_children.push(edts);
    }
    trak_children.push(&mdia);
    let trak = container(b"trak", &trak_children);

    // mvhd の timescale は media と同じにして、elst の換算で丸めが起きないようにする。
    let mvhd = mvhd(timescale);
    let moov = container(b"moov", &[&mvhd, &trak]);
    let mut file = ftyp();
    file.extend_from_slice(&moov);
    file.extend_from_slice(&mdat(32));
    file
}

/// ctts も edit list も無い素材。
fn plain(timescale: u32, stts_entries: &[(u32, u32)]) -> Vec<u8> {
    movie(timescale, stts_entries, None)
}

/// 同じ stts に、素直な 1 本の media 編集(media_time 0・segment_duration = stts の総和)を
/// 足した素材。mvhd と media の timescale が同じなので、尺・提示時刻は edit list 無しと同じ。
fn with_plain_edit(timescale: u32, stts_entries: &[(u32, u32)]) -> Vec<u8> {
    let total: u32 = stts_entries.iter().map(|(c, d)| c * d).sum();
    movie(timescale, stts_entries, Some(edts_elst_v0(&[(total, 0)])))
}

/// stts の累積和(先頭 0)と総和=ctts も edit list も無い素材の従来どおりの提示時刻と尺。
fn cumulative(stts_entries: &[(u32, u32)]) -> (Vec<u64>, u64) {
    let mut times = Vec::new();
    let mut clock = 0u64;
    for (count, delta) in stts_entries {
        for _ in 0..*count {
            times.push(clock);
            clock += u64::from(*delta);
        }
    }
    (times, clock)
}

/// 名目 fps(有理数)を比で比べる。
fn fps_ratio(idx: &VideoFrameIndex) -> f64 {
    idx.fps_num as f64 / idx.fps_den as f64
}

/// (is_cfr, fps_num, fps_den)。
fn rate(idx: &VideoFrameIndex) -> (bool, u32, u32) {
    (idx.is_cfr, idx.fps_num, idx.fps_den)
}

/// media timescale(30fps = 1000 ticks)。
const TS: u32 = 30000;
const FRAME: u32 = 1000;

/// (a) の素材: 9 フレームは 1000・最終フレームだけ 1500(50% 違う)。
const LAST_FRAME_LONGER: &[(u32, u32)] = &[(9, FRAME), (1, 1500)];

// ---------------------------------------------------------------------------
// (a) 最終サンプルの長さだけが違う素材は CFR
// ---------------------------------------------------------------------------

/// AC-37-追h (a)・契約1: ctts も edit list も無く、最終サンプルの長さだけが 0.5% を超えて
/// 違う素材は CFR になり、fps は残りの隣の間隔(1000)から 30000/1000 = 30 と求まる。
/// 最終サンプルが長い(1500)・極端に長い(100000)・短い(1)のどれでも同じ。
#[test]
fn ac37h_a_material_whose_last_sample_alone_differs_is_cfr() {
    for (name, last) in [("1.5 倍", 1500u32), ("100 倍", 100_000), ("1 tick", 1)] {
        let idx = parse_frame_index(&plain(TS, &[(9, FRAME), (1, last)]))
            .expect("最終サンプルだけ違う素材が解析できること");
        assert_eq!(idx.sample_times.len(), 10, "{name}: 10 フレーム");
        assert!(
            idx.is_cfr,
            "{name}: 最終フレームの長さ({last})は CFR の判定に数えない → CFR"
        );
        assert!(
            (fps_ratio(&idx) - 30.0).abs() < 1e-9,
            "{name}: fps = timescale / 隣の間隔 = 30000 / 1000 = 30。得られた比: {}",
            fps_ratio(&idx)
        );
    }
}

/// AC-37-追h (a)・契約1: フレームが 2 枚で最終サンプルだけ違う素材(隣の間隔が 1 つだけ)も
/// CFR で、fps はその 1 つの間隔から求まる。
#[test]
fn ac37h_a_two_frames_use_the_single_neighbouring_interval() {
    let idx = parse_frame_index(&plain(TS, &[(1, FRAME), (1, 3000)])).expect("解析できること");
    assert_eq!(idx.sample_times, vec![0, 1000]);
    assert!(idx.is_cfr, "隣の間隔は 1000 の 1 つだけ → CFR(最終サンプルの 3000 は数えない)");
    assert!(
        (fps_ratio(&idx) - 30.0).abs() < 1e-9,
        "fps = 30000 / 1000 = 30。得られた比: {}",
        fps_ratio(&idx)
    );
}

// ---------------------------------------------------------------------------
// (b) 同じ stts で edit list の有無が is_cfr・fps を分けない
// ---------------------------------------------------------------------------

/// AC-37-追h (b)・契約1: 同じ stts(最終サンプルだけ違う)で、素直な 1 本の edit list が有る
/// 素材と無い素材の is_cfr・fps_num/fps_den が同じ(どちらも CFR 30fps)。提示時刻と尺も同じ。
#[test]
fn ac37h_b_edit_list_presence_does_not_change_is_cfr_or_fps() {
    let without = parse_frame_index(&plain(TS, LAST_FRAME_LONGER)).expect("edit list 無し");
    let with = parse_frame_index(&with_plain_edit(TS, LAST_FRAME_LONGER)).expect("edit list 有り");

    assert_eq!(
        rate(&without),
        rate(&with),
        "同じ stts なら edit list の有無で is_cfr・fps_num/fps_den は変わらない"
    );
    assert!(with.is_cfr, "前提: edit list 有り(追補d の縁5)は最終フレームを数えないので CFR");
    assert!(without.is_cfr, "edit list 無しも CFR");
    assert!((fps_ratio(&without) - 30.0).abs() < 1e-9);
    assert_eq!(without.sample_times, with.sample_times, "提示時刻も同じ");
    assert_eq!(without.duration, with.duration, "尺も同じ");
}

/// AC-37-追h (b)・契約3: 途中の間隔が揺れる素材でも、edit list の有無で判定は分かれない
/// (どちらも VFR)。
#[test]
fn ac37h_b_edit_list_presence_does_not_change_vfr_either() {
    let varied: &[(u32, u32)] = &[(4, FRAME), (1, 2000), (5, FRAME)];
    let without = parse_frame_index(&plain(TS, varied)).expect("edit list 無し");
    let with = parse_frame_index(&with_plain_edit(TS, varied)).expect("edit list 有り");
    assert_eq!(rate(&without), rate(&with));
    assert!(!without.is_cfr);
    assert!(!with.is_cfr);
}

// ---------------------------------------------------------------------------
// (c) 途中の間隔が違えば VFR のまま
// ---------------------------------------------------------------------------

/// AC-37-追h (c)・契約3: 途中の 1 フレームが 0.5% を超えて違う(2 倍)素材は、ctts も edit list
/// も無くても VFR のまま(許容は 0.5% のまま・隣の間隔に 2000 が入る)。fps_den != 0。
#[test]
fn ac37h_c_material_with_a_differing_middle_interval_stays_vfr() {
    let idx = parse_frame_index(&plain(TS, &[(4, FRAME), (1, 2000), (5, FRAME)]))
        .expect("解析できること");
    assert_eq!(idx.sample_times.len(), 10);
    assert!(!idx.is_cfr, "途中の間隔 2000 は隣の間隔に入るので VFR のまま");
    assert_ne!(idx.fps_den, 0);

    // 最後から 2 番目(= 最終の隣の間隔)が違う素材も VFR(数えないのは最終フレームの長さだけ)。
    let idx = parse_frame_index(&plain(TS, &[(8, FRAME), (1, 2000), (1, FRAME)]))
        .expect("解析できること");
    assert!(
        !idx.is_cfr,
        "最終フレームの開始までの間隔(9 番目=2000)は数えるので VFR"
    );

    // 明白な VFR(既存の acceptance_req37.rs の素材)は VFR のまま。
    let idx = parse_frame_index(&plain(1000, &[(1, 500), (1, 100), (1, 1400), (1, 250)]))
        .expect("解析できること");
    assert!(!idx.is_cfr, "500・100・1400 の隣の間隔は CFR ではない");
    assert_ne!(idx.fps_den, 0);
}

/// AC-37-追h (c)・契約3: 許容 0.5% の中の揺れ(1000 に対して 1004 = 0.4%)は CFR のまま。
#[test]
fn ac37h_c_tolerance_stays_half_a_percent() {
    let idx = parse_frame_index(&plain(TS, &[(4, FRAME), (1, 1004), (5, FRAME)]))
        .expect("解析できること");
    assert!(idx.is_cfr, "0.4% の揺れは許容の中 → CFR");
    assert!((fps_ratio(&idx) - 30.0).abs() < 1e-9, "公称の間隔はいちばん多い 1000");

    let idx = parse_frame_index(&plain(TS, &[(4, FRAME), (1, 1010), (5, FRAME)]))
        .expect("解析できること");
    assert!(!idx.is_cfr, "1.0% の揺れは許容の外 → VFR");
}

// ---------------------------------------------------------------------------
// (d) フレームが 1 枚の素材は今と同じ
// ---------------------------------------------------------------------------

/// AC-37-追h (d)・契約2: フレームが 1 枚(ctts も elst も無い)の素材は、その 1 枚の長さで
/// 求める=今と同じ: is_cfr = true・fps = timescale / その長さ(既約)。edit list 有りと同じ。
///
/// 今の値(実装 build_index / decode_timeline を読んで確かめた): timescale 1000・stts [(1, 40)]
/// → intervals [(1, 40)]・nominal 40 → is_cfr true・fps_num 25・fps_den 1(gcd 40 で約分)。
/// timescale 30000・stts [(1, 1001)] → fps_num 30000・fps_den 1001(gcd 1)。
#[test]
fn ac37h_d_single_frame_material_is_judged_by_its_own_length_as_today() {
    for (timescale, delta, want) in [(1000u32, 40u32, (true, 25u32, 1u32)), (30000, 1001, (true, 30000, 1001))] {
        let idx = parse_frame_index(&plain(timescale, &[(1, delta)])).expect("1 枚の素材が解析できること");
        assert_eq!(idx.sample_times, vec![0], "1 枚・先頭 0");
        assert_eq!(idx.duration, u64::from(delta), "尺はその 1 枚の長さ");
        assert_eq!(
            rate(&idx),
            want,
            "timescale {timescale}・長さ {delta}: 1 枚の長さで (is_cfr, fps_num, fps_den) を求める(今と同じ)"
        );

        let with = parse_frame_index(&with_plain_edit(timescale, &[(1, delta)]))
            .expect("edit list 有りの 1 枚の素材が解析できること");
        assert_eq!(rate(&with), want, "edit list 有りの 1 枚(今の扱い)と同じ");
        assert_eq!(with.sample_times, idx.sample_times);
        assert_eq!(with.duration, idx.duration);
    }
}

// ---------------------------------------------------------------------------
// (e) sample_times・duration は今と同じ
// ---------------------------------------------------------------------------

/// AC-37-追h (e)・契約3: ctts も edit list も無い素材の提示時刻(stts の累積和・先頭 0)と尺
/// (総和=最終フレームの終端)は今と同じ。(a)〜(d) の素材すべてで。
#[test]
fn ac37h_e_sample_times_and_duration_are_unchanged() {
    let cases: Vec<(&str, u32, &[(u32, u32)])> = vec![
        ("最終だけ長い", TS, LAST_FRAME_LONGER),
        ("最終だけ短い", TS, &[(9, FRAME), (1, 1)]),
        ("2 枚", TS, &[(1, FRAME), (1, 3000)]),
        ("途中が違う", TS, &[(4, FRAME), (1, 2000), (5, FRAME)]),
        ("明白な VFR", 1000, &[(1, 500), (1, 100), (1, 1400), (1, 250)]),
        ("1 枚", 1000, &[(1, 40)]),
        ("一定", TS, &[(10, FRAME)]),
    ];
    for (name, timescale, entries) in cases {
        let idx = parse_frame_index(&plain(timescale, entries)).expect("解析できること");
        let (times, total) = cumulative(entries);
        assert_eq!(idx.sample_times, times, "{name}: 提示時刻は stts の累積和(先頭 0)");
        assert_eq!(idx.duration, total, "{name}: 尺は stts の総和(最終フレームの終端)");
        assert_eq!(idx.timescale, timescale, "{name}: timescale");
    }

    // 一定の素材は CFR のまま 30fps(回帰)。
    let idx = parse_frame_index(&plain(TS, &[(10, FRAME)])).expect("解析できること");
    assert_eq!(rate(&idx), (true, 30, 1));
}
