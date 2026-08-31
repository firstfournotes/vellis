//! 要件#37 の受け入れテスト(requirements.md #37)— Rust 層
//!
//! 「動画ビューア(要件#28)をフレーム精度の編集下見に使えるようにする」のうち、
//! フレーム情報源=契約②「MP4/MOV のサンプルテーブル(mdhd timescale+stts)から
//! fps 判定と全フレームの提示時刻列を返す **自前ミニパーサ**(moov 系列の必要な箱のみ
//! 読み・未知の箱は読み飛ばし=MOV 方言耐性・依存追加なし)」を判定する。
//!
//! ## 確定契約(implementer はこれに従う)
//!
//! ```ignore
//! // 実装先: src-tauri/src/video_frames.rs(`vellis_lib::video_frames`)
//!
//! /// MP4/MOV の映像トラックのフレーム索引。フロントの
//! /// VideoFrameIndexPayload(src/lib/video-frame.ts)と serde camelCase で対応する。
//! #[derive(Debug, Clone, PartialEq, serde::Serialize)]
//! #[serde(rename_all = "camelCase")]
//! pub struct VideoFrameIndex {
//!     /// mdhd の timescale(ticks/秒)
//!     pub timescale: u32,
//!     /// 各フレームの提示開始時刻(ticks・昇順)。index =フレーム番号(0起点)。
//!     /// stts の継続時間の累積和(先頭は 0)。ctts/elst の反映は「提示順の
//!     /// 正確化に必要なら」の実装裁量(本テストのフィクスチャは stts のみ)
//!     pub sample_times: Vec<u64>,
//!     /// 全フレームの提示終了時刻(ticks =stts 継続時間の総和)。
//!     /// mdhd の duration フィールドは採らない(sample_times と自己整合させる)
//!     pub duration: u64,
//!     /// 名目 fps の有理数。CFR なら厳密値(= timescale / 共通デルタ)・
//!     /// VFR は代表値(実装裁量。ただし fps_den != 0=0除算を作らない)
//!     pub fps_num: u32,
//!     pub fps_den: u32,
//!     /// CFR 判定(SMPTE 表示の可否=契約①。許容誤差は実装裁量のため、
//!     /// 本テストは全デルタ一致の明白な CFR と大きく揺れる明白な VFR のみ固定する)
//!     pub is_cfr: bool,
//! }
//!
//! /// ファイル先頭からのバイト列 → 映像トラックのフレーム索引。
//! /// - トップレベルの箱列を走査して moov を見つける(moov 後置=mdat 先行も可。
//! ///   size==1 の 64bit 拡張サイズの箱も読み飛ばせること)
//! /// - moov→trak→mdia→(mdhd/hdlr/minf→stbl→stts)の必要な箱だけ読み、
//! ///   未知の箱・不要な箱(mvhd/tkhd/stsd/free/udta …)は読み飛ばす。
//! ///   兄弟箱の順序に依存しない(hdlr が mdhd より先の方言も可)
//! /// - hdlr の handler_type == b"vide" のトラックを採る(最初の映像トラック)。
//! ///   映像トラックが無い(音声のみ等)は None
//! /// - 解析不能(moov なし・stts なし・フレーム0件・timescale 0・壊れたサイズ・
//! ///   途中で切れたデータ)はすべて None。panic しない(契約⑦ fail-open =
//! ///   パース失敗で再生自体を止めない。縮退の出し分けはフロント側)
//! /// - Some を返すなら sample_times は1件以上かつ昇順
//! pub fn parse_frame_index(bytes: &[u8]) -> Option<VideoFrameIndex>;
//! ```
//!
//! コマンド(契約②⑨=Rust 追加はメタデータコマンド1本): `get_video_frame_index`
//! (引数 uri・応答 VideoFrameIndex | null 相当)。フロントは reject / null とも
//! 縮退へ倒すため、読み込み失敗を Err にするか Ok(None) にするかは実装裁量。
//! Tauri 配線・登録・ファイル読み経路は reviewer 照合(本テストの判定対象外)。
//! capability/CSP 変更なし・依存追加なし(契約⑨)。
//!
//! フィクスチャはすべて本ファイル内でバイト列合成する(実動画のコミットなし)。
//! 実素材でのコマ送り精度・VFR 素材の挙動は人間ゲート(acceptance/acceptance.md)。

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

/// 64bit 拡張サイズの箱(size==1・largesize はヘッダ16バイトを含む)。
fn wide_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(payload.len() + 16);
    b.extend_from_slice(&1u32.to_be_bytes());
    b.extend_from_slice(kind);
    b.extend_from_slice(&(payload.len() as u64 + 16).to_be_bytes());
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

/// mdhd v0。duration フィールドはダミー値(契約=採らない。stts 総和が正)。
fn mdhd(timescale: u32) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    p.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    p.extend_from_slice(&timescale.to_be_bytes());
    p.extend_from_slice(&999_999u32.to_be_bytes()); // duration(ダミー=採られないこと)
    p.extend_from_slice(&0x55c4u16.to_be_bytes()); // language "und"
    p.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    mp4_box(b"mdhd", &p)
}

/// mdhd v1(creation/modification/duration が 64bit)。
fn mdhd_v1(timescale: u32) -> Vec<u8> {
    let mut p = full_header(1);
    p.extend_from_slice(&0u64.to_be_bytes()); // creation_time
    p.extend_from_slice(&0u64.to_be_bytes()); // modification_time
    p.extend_from_slice(&timescale.to_be_bytes());
    p.extend_from_slice(&999_999u64.to_be_bytes()); // duration(ダミー)
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

fn mvhd_dummy() -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&[0u8; 96]);
    mp4_box(b"mvhd", &p)
}

/// trak > mdia > (mdhd, hdlr, minf > stbl > (stsd, stts)) の最小トラック。
fn media_trak(handler: &[u8; 4], timescale: u32, entries: &[(u32, u32)]) -> Vec<u8> {
    let stbl = container(b"stbl", &[&stsd_dummy(), &stts(entries)]);
    let minf = container(b"minf", &[&stbl]);
    let mdia = container(b"mdia", &[&mdhd(timescale), &hdlr(handler), &minf]);
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
    file.extend_from_slice(&mdat(32));
    file
}

/// 名目 fps(有理数)を比で比べる。
fn fps_ratio(idx: &VideoFrameIndex) -> f64 {
    idx.fps_num as f64 / idx.fps_den as f64
}

// ---------------------------------------------------------------------------
// 正常系 — CFR の timescale・提示時刻列・fps 判定(契約②)
// ---------------------------------------------------------------------------

/// NTSC(29.97fps): timescale 30000・全デルタ 1001。提示時刻列は stts の累積和
/// (0起点)・duration は総和。mdhd の duration ダミー値は採られない。
#[test]
fn cfr_mp4_yields_timescale_presentation_times_and_fps() {
    let file = build_movie(&[media_trak(b"vide", 30000, &[(90, 1001)])]);
    let idx = parse_frame_index(&file).expect("最小 CFR MP4 が解析できること");

    assert_eq!(idx.timescale, 30000);
    assert_eq!(
        idx.sample_times.len(),
        90,
        "フレーム数=stts の sample_count"
    );
    assert_eq!(idx.sample_times[0], 0, "先頭フレームの提示開始は 0(0起点)");
    assert_eq!(idx.sample_times[1], 1001);
    assert_eq!(idx.sample_times[89], 89 * 1001);
    assert!(
        idx.sample_times.windows(2).all(|w| w[0] < w[1]),
        "提示時刻列は昇順"
    );
    assert_eq!(
        idx.duration,
        90 * 1001,
        "duration は stts 総和(mdhd の duration フィールドではない)"
    );
    assert!(idx.is_cfr, "全デルタ一致は CFR");
    assert!(
        (fps_ratio(&idx) - 30000.0 / 1001.0).abs() < 1e-9,
        "fps は timescale/デルタの有理数(29.97…)。得られた比: {}",
        fps_ratio(&idx)
    );
}

/// 整数 fps(25fps: timescale 25000・デルタ 1000)。
#[test]
fn integer_fps_is_exact() {
    let file = build_movie(&[media_trak(b"vide", 25000, &[(50, 1000)])]);
    let idx = parse_frame_index(&file).expect("整数 fps の MP4 が解析できること");

    assert!(idx.is_cfr);
    assert!((fps_ratio(&idx) - 25.0).abs() < 1e-9);
    assert_eq!(idx.sample_times[49], 49 * 1000);
    assert_eq!(idx.duration, 50 * 1000);
}

/// stts が複数エントリに分かれていても、デルタが全部同じなら CFR。
#[test]
fn cfr_holds_across_multiple_stts_entries_with_same_delta() {
    let file = build_movie(&[media_trak(b"vide", 30000, &[(30, 1001), (60, 1001)])]);
    let idx = parse_frame_index(&file).expect("複数エントリの stts が解析できること");

    assert_eq!(idx.sample_times.len(), 90);
    assert_eq!(idx.sample_times[89], 89 * 1001);
    assert!(idx.is_cfr);
}

/// VFR: デルタが大きく揺れる列。提示時刻列は正確な累積和のまま・is_cfr=false
/// (SMPTE 非表示の根拠=契約①)。fps 代表値は実装裁量だが 0除算は作らない。
#[test]
fn vfr_keeps_exact_times_and_clears_is_cfr() {
    let file = build_movie(&[media_trak(
        b"vide",
        1000,
        &[(1, 500), (1, 100), (1, 1400), (1, 250)],
    )]);
    let idx = parse_frame_index(&file).expect("VFR でも解析はできること(fail-open)");

    assert_eq!(idx.sample_times, vec![0, 500, 600, 2000]);
    assert_eq!(idx.duration, 2250);
    assert!(!idx.is_cfr, "明白な VFR は is_cfr=false");
    assert_ne!(idx.fps_den, 0);
}

// ---------------------------------------------------------------------------
// MOV 方言耐性 — 未知の箱・並び・moov 後置・64bit サイズ(契約②)
// ---------------------------------------------------------------------------

/// 各階層に未知の箱(wxyz)や free が混ざっていても読み飛ばして解析する。
#[test]
fn unknown_boxes_are_skipped_at_every_level() {
    let junk = mp4_box(b"wxyz", &[0xAA; 24]);
    let free = mp4_box(b"free", &[0; 8]);

    let stbl = container(
        b"stbl",
        &[&junk, &stsd_dummy(), &stts(&[(90, 1001)]), &free],
    );
    let minf = container(b"minf", &[&free, &stbl]);
    let mdia = container(
        b"mdia",
        &[&junk, &mdhd(30000), &free, &hdlr(b"vide"), &minf, &junk],
    );
    let trak = container(b"trak", &[&junk, &tkhd_dummy(), &mdia]);
    let moov = container(b"moov", &[&free, &mvhd_dummy(), &junk, &trak, &junk]);

    let mut file = ftyp();
    file.extend_from_slice(&junk);
    file.extend_from_slice(&moov);
    file.extend_from_slice(&free);
    file.extend_from_slice(&mdat(32));

    let idx = parse_frame_index(&file).expect("未知の箱混在でも解析できること");
    assert_eq!(idx.timescale, 30000);
    assert_eq!(idx.sample_times.len(), 90);
}

/// mdia 内で hdlr が mdhd より先に来る方言(兄弟箱の順序に依存しない)。
#[test]
fn hdlr_before_mdhd_dialect_is_accepted() {
    let stbl = container(b"stbl", &[&stsd_dummy(), &stts(&[(10, 1001)])]);
    let minf = container(b"minf", &[&stbl]);
    let mdia = container(b"mdia", &[&hdlr(b"vide"), &mdhd(30000), &minf]);
    let trak = container(b"trak", &[&tkhd_dummy(), &mdia]);
    let moov = container(b"moov", &[&mvhd_dummy(), &trak]);

    let mut file = ftyp();
    file.extend_from_slice(&moov);

    let idx = parse_frame_index(&file).expect("hdlr 先行の並びでも解析できること");
    assert_eq!(idx.sample_times.len(), 10);
}

/// moov 後置(ftyp + mdat + moov)。ストリーミング向けでない書き出しの標準形。
#[test]
fn moov_after_mdat_is_found() {
    let trak = media_trak(b"vide", 30000, &[(10, 1001)]);
    let moov = container(b"moov", &[&mvhd_dummy(), &trak]);

    let mut file = ftyp();
    file.extend_from_slice(&mdat(1024));
    file.extend_from_slice(&moov);

    let idx = parse_frame_index(&file).expect("moov 後置でも解析できること");
    assert_eq!(idx.sample_times.len(), 10);
}

/// 64bit 拡張サイズ(size==1+largesize)の mdat を読み飛ばして moov に届く。
#[test]
fn large_size_mdat_is_skipped() {
    let trak = media_trak(b"vide", 30000, &[(10, 1001)]);
    let moov = container(b"moov", &[&mvhd_dummy(), &trak]);

    let mut file = ftyp();
    file.extend_from_slice(&wide_box(b"mdat", &[0xEE; 64]));
    file.extend_from_slice(&moov);

    let idx = parse_frame_index(&file).expect("64bit サイズの箱を読み飛ばせること");
    assert_eq!(idx.sample_times.len(), 10);
}

/// ftyp なしで moov から始まる並びも解析する(古い QuickTime 系の方言)。
#[test]
fn missing_ftyp_still_parses() {
    let trak = media_trak(b"vide", 30000, &[(10, 1001)]);
    let file = container(b"moov", &[&mvhd_dummy(), &trak]);

    let idx = parse_frame_index(&file).expect("ftyp なしでも解析できること");
    assert_eq!(idx.sample_times.len(), 10);
}

// ---------------------------------------------------------------------------
// トラック選択 — 映像トラック(hdlr=vide)を採る(契約②⑦)
// ---------------------------------------------------------------------------

/// 音声のみ(hdlr=soun)は None =映像トラックなしの縮退(契約⑦)。
#[test]
fn audio_only_movie_returns_none() {
    let file = build_movie(&[media_trak(b"soun", 44100, &[(100, 1024)])]);
    assert_eq!(parse_frame_index(&file), None);
}

/// 音声トラックが先にあっても映像トラックの情報を返す。
#[test]
fn video_track_is_selected_among_audio_tracks() {
    let file = build_movie(&[
        media_trak(b"soun", 44100, &[(100, 1024)]),
        media_trak(b"vide", 30000, &[(10, 1001)]),
    ]);
    let idx = parse_frame_index(&file).expect("音声先行でも映像トラックを採ること");

    assert_eq!(idx.timescale, 30000, "音声の timescale(44100)ではない");
    assert_eq!(idx.sample_times.len(), 10);
    assert_eq!(idx.sample_times[9], 9 * 1001);
}

// ---------------------------------------------------------------------------
// 縮退 — 解析不能はすべて None・panic しない(契約⑦ fail-open)
// ---------------------------------------------------------------------------

/// 動画ですらないバイト列・空入力は None。
#[test]
fn garbage_and_empty_input_return_none() {
    assert_eq!(parse_frame_index(b"this is not a movie at all"), None);
    assert_eq!(parse_frame_index(&[]), None);
    assert_eq!(parse_frame_index(&ftyp()), None, "moov が無ければ None");
}

/// 映像トラックに stts が無い・stts が0件なら None(Some⇒1フレーム以上)。
#[test]
fn video_track_without_stts_or_with_empty_stts_returns_none() {
    // stts なし
    let stbl = container(b"stbl", &[&stsd_dummy()]);
    let minf = container(b"minf", &[&stbl]);
    let mdia = container(b"mdia", &[&mdhd(30000), &hdlr(b"vide"), &minf]);
    let trak = container(b"trak", &[&tkhd_dummy(), &mdia]);
    let file = build_movie(&[trak]);
    assert_eq!(parse_frame_index(&file), None, "stts なしは None");

    // stts 0件
    let file = build_movie(&[media_trak(b"vide", 30000, &[])]);
    assert_eq!(parse_frame_index(&file), None, "フレーム0件は None");
}

/// mdhd v1(64bit 時刻)でも timescale を正しく読む。
#[test]
fn mdhd_version1_timescale_is_read() {
    let stbl = container(b"stbl", &[&stsd_dummy(), &stts(&[(10, 1001)])]);
    let minf = container(b"minf", &[&stbl]);
    let mdia = container(b"mdia", &[&mdhd_v1(30000), &hdlr(b"vide"), &minf]);
    let trak = container(b"trak", &[&tkhd_dummy(), &mdia]);
    let file = build_movie(&[trak]);

    let idx = parse_frame_index(&file).expect("mdhd v1 が解析できること");
    assert_eq!(idx.timescale, 30000);
}

/// 壊れたサイズでも panic・無限ループせず、moov 取得済みなら後続の破損に負けない。
#[test]
fn corrupt_box_sizes_fail_open_without_panic() {
    // (a) サイズ 3(ヘッダ未満)の箱で始まる → None(進めないが panic もしない)
    let mut bogus = 3u32.to_be_bytes().to_vec();
    bogus.extend_from_slice(b"wxyz");
    bogus.extend_from_slice(&[0; 16]);
    assert_eq!(parse_frame_index(&bogus), None);

    // (b) moov がファイル末尾を越えるサイズを宣言(途中で切れたファイル)→ None
    let trak = media_trak(b"vide", 30000, &[(10, 1001)]);
    let moov = container(b"moov", &[&mvhd_dummy(), &trak]);
    let mut truncated = ftyp();
    truncated.extend_from_slice(&moov[..moov.len() / 2]);
    assert_eq!(parse_frame_index(&truncated), None);

    // (c) 完全な moov の後にサイズ超過のゴミ箱 → 取得済みの情報で Some(fail-open)
    let mut trailing = ftyp();
    trailing.extend_from_slice(&moov);
    trailing.extend_from_slice(&9999u32.to_be_bytes());
    trailing.extend_from_slice(b"junk");
    trailing.extend_from_slice(&[0; 8]); // 宣言より短い
    let idx = parse_frame_index(&trailing).expect("moov 取得後の破損は無害であること");
    assert_eq!(idx.sample_times.len(), 10);
}

// ---------------------------------------------------------------------------
// コマンド応答 — フロントの VideoFrameIndexPayload と一致する camelCase(契約②)
// ---------------------------------------------------------------------------

/// serde 直列化が camelCase 6キー(src/lib/video-frame.ts の
/// VideoFrameIndexPayload)と一致する=TS/Rust 境界の線形。
#[test]
fn payload_serializes_with_camel_case_keys_for_frontend() {
    let idx = VideoFrameIndex {
        timescale: 30000,
        sample_times: vec![0, 1001],
        duration: 2002,
        fps_num: 30000,
        fps_den: 1001,
        is_cfr: true,
    };
    let v = serde_json::to_value(&idx).expect("serialize");
    let obj = v.as_object().expect("JSON オブジェクトであること");

    let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "duration",
            "fpsDen",
            "fpsNum",
            "isCfr",
            "sampleTimes",
            "timescale"
        ]
    );
    assert_eq!(v["timescale"], serde_json::json!(30000));
    assert_eq!(v["sampleTimes"], serde_json::json!([0, 1001]));
    assert_eq!(v["duration"], serde_json::json!(2002));
    assert_eq!(v["fpsNum"], serde_json::json!(30000));
    assert_eq!(v["fpsDen"], serde_json::json!(1001));
    assert_eq!(v["isCfr"], serde_json::json!(true));
}
