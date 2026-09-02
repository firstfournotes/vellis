//! 要件#45 の受け入れテスト(requirements.md #45)— Rust 層
//!
//! 「音声波形をファイルサイズに関わらず表示する」(波形v2)のうち、契約①=
//! **mp4 も Rust 抽出経路(extract_waveform_audio)へ寄せる**の Rust 側根拠を固定する:
//! `audio_extract.rs` の ISO BMFF パーサ(mov/mp4 共用)が **mp4 ブランドの
//! フィクスチャ**でも音声トラックの抽出計画を返し、切り出したサンプル列が
//! m4a 再梱包で読み戻せること。
//!
//! 注: パーサは要件#41 時点からコンテナ非依存(mov/mp4 共用)の実装なので、
//! 本ファイルは実装前から緑になり得る(mp4 対応の**回帰固定**が目的)。
//! 本要件の赤の主体は TS 側=経路選択・上限判定の適用先・too-long 撤廃・
//! 解析中状態(src/lib/audio-waveform.acceptance.test.ts の #45 追記分)。
//!
//! フィクスチャはすべて本ファイル内でバイト列合成する(実動画のコミットなし=
//! acceptance_req37.rs / acceptance_req41.rs の作法)。ftyp は mp4 ブランド
//! (mp42/isom)で組み、mov 方言(QT v1 等)は req41 側が固定済み。
//! コマンド(extract_waveform_audio)の mp4 URI 受け入れ・フロント配線は
//! reviewer 照合。13分実ファイルで波形が出る体感は人間ゲート。

use vellis_lib::audio_extract::{parse_audio_extraction, remux_m4a, AudioCodec, SampleRange};

// ---------------------------------------------------------------------------
// フィクスチャ合成ヘルパ(ISO BMFF の箱を最小構成で組む・req41 の家風)
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

/// stsd 内のサウンドサンプル記述(2ch・16bit・44100Hz の 16.16 固定小数・v0)。
fn sound_entry(fourcc: &[u8; 4], children: &[&[u8]]) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(&[0u8; 6]); // reserved
    p.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    p.extend_from_slice(&0u16.to_be_bytes()); // version
    p.extend_from_slice(&0u16.to_be_bytes()); // revision
    p.extend_from_slice(&[0u8; 4]); // vendor
    p.extend_from_slice(&2u16.to_be_bytes()); // channelcount
    p.extend_from_slice(&16u16.to_be_bytes()); // samplesize
    p.extend_from_slice(&0u16.to_be_bytes()); // compression_id
    p.extend_from_slice(&0u16.to_be_bytes()); // packet_size
    p.extend_from_slice(&(44100u32 << 16).to_be_bytes()); // samplerate 16.16
    for c in children {
        p.extend_from_slice(c);
    }
    mp4_box(fourcc, &p)
}

fn stsd(entry: &[u8]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&1u32.to_be_bytes()); // entry_count 1
    p.extend_from_slice(entry);
    mp4_box(b"stsd", &p)
}

/// mp4a+esds の標準サンプル記述(AAC フィクスチャの共通部品)。
fn mp4a_entry() -> Vec<u8> {
    sound_entry(b"mp4a", &[&mp4_box(b"esds", &esds_payload())])
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

fn stco(offsets: &[u32]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&(offsets.len() as u32).to_be_bytes());
    for o in offsets {
        p.extend_from_slice(&o.to_be_bytes());
    }
    mp4_box(b"stco", &p)
}

/// trak > mdia > (mdhd, hdlr=soun, minf > stbl > (stsd, tables…))。
fn audio_trak(entry: &[u8], tables: &[&[u8]]) -> Vec<u8> {
    let stsd_b = stsd(entry);
    let mut children: Vec<&[u8]> = vec![&stsd_b];
    children.extend_from_slice(tables);
    let stbl = container(b"stbl", &children);
    let minf = container(b"minf", &[&stbl]);
    let mdia = container(b"mdia", &[&mdhd(44100), &hdlr(b"soun"), &minf]);
    container(b"trak", &[&tkhd_dummy(), &mdia])
}

/// 音声パーサが読み飛ばすべき映像トラック(表は持たない最小形)。
fn video_trak_dummy() -> Vec<u8> {
    let stbl = container(b"stbl", &[&stsd_dummy()]);
    let minf = container(b"minf", &[&stbl]);
    let mdia = container(b"mdia", &[&mdhd(30000), &hdlr(b"vide"), &minf]);
    container(b"trak", &[&tkhd_dummy(), &mdia])
}

/// **mp4 ブランド**の ftyp(major=mp42・compatible=mp42/isom)。req41 の mov 側と
/// 対になる「これは mp4 ファイルである」の宣言部。パーサはブランドに依存しない
/// (コンテナ共用)ことを、mp4 側からも固定する。
fn ftyp_mp4() -> Vec<u8> {
    mp4_box(b"ftyp", b"mp42\x00\x00\x00\x00mp42isom")
}

fn mdat(len: usize) -> Vec<u8> {
    mp4_box(b"mdat", &vec![0xEEu8; len])
}

/// ftyp(mp4 ブランド)+ moov(mvhd + トラック列)+ mdat の典型 mp4 並び
/// (moov 前置= faststart 形)。
fn build_mp4(traks: &[Vec<u8>]) -> Vec<u8> {
    let mvhd = mvhd_dummy();
    let mut children: Vec<&[u8]> = vec![&mvhd];
    for t in traks {
        children.push(t);
    }
    let moov = container(b"moov", &children);
    let mut file = ftyp_mp4();
    file.extend_from_slice(&moov);
    file.extend_from_slice(&mdat(1024));
    file
}

fn r(offset: u64, size: u32) -> SampleRange {
    SampleRange { offset, size }
}

/// AAC(mp4a+esds)音声トラック入りの標準 mp4 フィクスチャ。
/// 期待 ranges: チャンク1(@100)=2サンプル・チャンク2(@300)=2サンプル。
fn aac_mp4() -> Vec<u8> {
    build_mp4(&[
        video_trak_dummy(),
        audio_trak(
            &mp4a_entry(),
            &[
                &stts(&[(4, 1024)]),
                &stsc(&[(1, 2)]),
                &stsz_sizes(&[10, 20, 30, 40]),
                &stco(&[100, 300]),
            ],
        ),
    ])
}

// ---------------------------------------------------------------------------
// mp4 の音声抽出(契約①= mp4 も Rust 抽出経路)
// ---------------------------------------------------------------------------

/// mp4 ブランドの AAC トラックから抽出計画(分類・範囲列・再梱包材料)が得られる。
/// 映像トラックが先に居ても hdlr=soun のトラックを採る(mov と同じ規則)。
#[test]
fn mp4_brand_aac_track_yields_extraction_plan() {
    let plan = parse_audio_extraction(&aac_mp4()).expect("mp4 ブランドでも解析できること");

    assert_eq!(plan.codec, AudioCodec::Aac, "mp4a は Aac(m4a 再梱包経路)");
    assert_eq!(
        plan.ranges,
        vec![r(100, 10), r(110, 20), r(300, 30), r(330, 40)]
    );
    assert_eq!(plan.timescale, 44100, "timescale は mdhd から");
    assert_eq!(plan.stts, vec![(4, 1024)], "stts ランレングスをそのまま持ち帰る");
    assert_eq!(plan.stsd, stsd(&mp4a_entry()), "stsd は箱まるごと(再梱包で流用)");
}

/// 音声トラックの無い mp4 は None =フロントの no-audio 縮退の根拠(契約⑤の
/// 出し分けが mp4 の extract 経路でも成り立つこと)。
#[test]
fn mp4_without_audio_track_returns_none() {
    let file = build_mp4(&[video_trak_dummy()]);
    assert_eq!(parse_audio_extraction(&file), None);
}

/// mp4 の未対応音声コーデック(AC-3 等)は Unsupported(None ではない)=
/// フロントの unsupported-codec 縮退の根拠(契約⑤)。
#[test]
fn mp4_unsupported_codec_is_classified_not_none() {
    let file = build_mp4(&[audio_trak(
        &sound_entry(b"ac-3", &[]),
        &[&stsc(&[(1, 2)]), &stsz_sizes(&[8, 8]), &stco(&[100])],
    )]);
    let plan = parse_audio_extraction(&file).expect("未対応コーデックでも Some(縮退の判別用)");

    assert_eq!(plan.codec, AudioCodec::Unsupported);
    assert_eq!(plan.ranges, vec![r(100, 8), r(108, 8)]);
}

/// mp4 → 抽出計画 → サンプル切り出し → m4a 再梱包 → 同じパーサで読み戻し、の
/// 全経路(extract_waveform_audio が mp4 に対して行う純関数部分の連結)。
/// 出力 m4a の表を辿ると、元 mp4 から切り出したサンプルバイトがそのまま戻ること。
#[test]
fn mp4_samples_remux_and_read_back_roundtrip() {
    let file = aac_mp4();
    let plan = parse_audio_extraction(&file).expect("mp4 が解析できること");

    let samples: Vec<&[u8]> = plan
        .ranges
        .iter()
        .map(|range| {
            let from = range.offset as usize;
            &file[from..from + range.size as usize]
        })
        .collect();

    let out = remux_m4a(&plan.stsd, &samples, plan.timescale, &plan.stts)
        .expect("mp4 由来のサンプル列が再梱包できること");

    // 出力を同じ ISO BMFF パーサで読み戻す(構造の自己整合=契約①の共用パーサ)。
    let reread = parse_audio_extraction(&out).expect("再梱包した m4a を読み戻せること");
    assert_eq!(reread.codec, AudioCodec::Aac);
    assert_eq!(reread.stsd, plan.stsd, "stsd は丸ごと維持");
    assert_eq!(reread.stts, plan.stts, "stts ランレングス維持");
    assert_eq!(reread.timescale, plan.timescale);
    assert_eq!(reread.ranges.len(), samples.len(), "サンプル数維持");

    let read_back: Vec<&[u8]> = reread
        .ranges
        .iter()
        .map(|range| {
            let from = range.offset as usize;
            &out[from..from + range.size as usize]
        })
        .collect();
    assert_eq!(read_back, samples, "表の指す位置から元のバイト列のまま読み戻せること");
}
