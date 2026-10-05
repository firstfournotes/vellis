//! 要件#41 追補f(backlog 235=AAC の波形が約 44ms 早く描かれる)の受け入れテスト
//! **AC-41-追f** — Rust 層(docs/requirements/req-41.md「追補f」節が正本)。
//!
//! 背景(2026-10-01 夜の実測): WebKit(AudioToolbox)は AAC の m4a に elst と
//! roll 群(`sgpd` / `sbgp` の grouping_type `roll`)が**両方ある**と elst の
//! media_time だけを削る(正しい)。elst があって roll 群が**無い**と、デコーダの
//! 既定の遅延(LC=2112)を削ったうえで elst のぶんもさらに削る=二重に削る。
//! `remux_m4a` は stbl を stsd・stts・stsc・stsz・stco だけで組み直すので、元の
//! ファイルにある roll 群が落ちて二重に削られていた。
//!
//! ## 契約(追補f・implementer はこれに従う)
//!
//! 抜き出した m4a のコーデックが **AAC(stsd の entry が `mp4a`)** のとき、
//! `remux_m4a` の出力の **stbl** に AAC の roll 群を**合成して**付ける
//! (元ファイルの箱を写すのではない):
//!
//! ```ignore
//! // sgpd(SampleGroupDescriptionBox・ISO/IEC 14496-12)
//! //   FullBox version 1 / flags 0
//! //   grouping_type   = b"roll"
//! //   default_length  = 2            (v1 のみ)
//! //   entry_count     = 1
//! //   entry[0]        = AudioRollRecoveryEntry { roll_distance: i16 = -1 }
//! // sbgp(SampleToGroupBox)
//! //   FullBox version 0 / flags 0    (v1 の grouping_type_parameter は持たない)
//! //   grouping_type   = b"roll"
//! //   entry_count     = 1
//! //   entry[0]        = { sample_count: u32 = 出力のサンプル総数,
//! //                       group_description_index: u32 = 1 }
//! ```
//!
//! - **追補b(elst を残す)は不変**。`with_edit_list` を通した後も roll 群と elst の
//!   両方がある
//! - **AAC 以外(ALAC)には足さない**。PCM の wav 経路は stbl を持たないので対象外
//! - 箱順(`ftyp` + `mdat` + `moov`)・サンプルバイト不変・stsd 丸ごと・stts/stsc/
//!   stsz/stco の整合(= AC-41-8 の検査)は roll 群を足した後も成り立つ
//!
//! ## 受け入れ基準 AC-41-追f
//!
//! - (a) AAC(`mp4a`)の stsd を持つ素材を `remux_m4a` に通すと、出力の stbl に
//!   上の `sgpd` と `sbgp` がある(フィールドを1つずつ検査)
//! - (b) ALAC(`alac`)の stsd では `sgpd`・`sbgp` が無い
//! - (c) edit_start(elst)を持つ AAC の素材では roll 群と elst の両方がある
//! - (d) 既存の AC-41-8 と同じ整合(stsd・stts・stsc・stsz・stco・サンプルバイト
//!   不変・箱順 ftyp+mdat+moov)が roll 群を足した後も成り立つ
//!
//! フィクスチャはすべて本ファイル内でバイト列合成する(acceptance_req41.rs の作法。
//! ヘルパは同ファイルから必要分を写した=統合テストは別クレートのため共有不可)。
//! 修正ビルドの抽出 m4a を WebKit で decode してずれが 0 になることは実機=人間ゲート。

use vellis_lib::audio_extract::{
    normalize_sound_description, parse_audio_extraction, remux_m4a, with_edit_list, AudioCodec,
};

// ---------------------------------------------------------------------------
// フィクスチャ合成ヘルパ(acceptance_req41.rs と同じ最小構成)
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

fn mvhd_dummy() -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&[0u8; 96]);
    mp4_box(b"mvhd", &p)
}

/// AAC-LC・44.1kHz・2ch の AudioSpecificConfig(0x12 0x10)を含む esds ペイロード
/// (ES_Descriptor 0x03 > DecoderConfig 0x04 > DecSpecificInfo 0x05)。
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

/// stsd 内のサウンドサンプル記述 v0(2ch・16bit・44100Hz の 16.16 固定小数)。
fn sound_entry(fourcc: &[u8; 4], children: &[&[u8]]) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(&[0u8; 6]); // reserved
    p.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    p.extend_from_slice(&0u16.to_be_bytes()); // version 0
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

/// alac+magic cookie のサンプル記述(ALAC フィクスチャ)。
fn alac_entry() -> Vec<u8> {
    sound_entry(b"alac", &[&mp4_box(b"alac", &[0u8; 24])])
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

/// edts > elst v0(1 エントリ: segment_duration・media_time=プライミング・rate 1.0)。
/// 元ファイルが持つ「先頭 media_time 分を削る」編集リスト= edit_start の供給源。
fn edts(segment_duration: u32, media_time: u32) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&1u32.to_be_bytes()); // entry_count
    p.extend_from_slice(&segment_duration.to_be_bytes());
    p.extend_from_slice(&media_time.to_be_bytes());
    p.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // media_rate 1.0
    container(b"edts", &[&mp4_box(b"elst", &p)])
}

fn ftyp() -> Vec<u8> {
    mp4_box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2mp41")
}

// ---------------------------------------------------------------------------
// 読み戻しヘルパ(find_box・roll 群の検査・AC-41-8 と同じ整合検査)
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

/// 兄弟箱列の kind をファイル順に列挙する(箱順の検査用)。
fn box_kinds(mut data: &[u8]) -> Vec<[u8; 4]> {
    let mut kinds = Vec::new();
    while data.len() >= 8 {
        let size = u32::from_be_bytes(data[0..4].try_into().unwrap()) as usize;
        if size < 8 || size > data.len() {
            break;
        }
        kinds.push(data[4..8].try_into().unwrap());
        data = &data[size..];
    }
    kinds
}

/// 兄弟箱列の中で kind が何個あるか。
fn count_boxes(data: &[u8], kind: &[u8; 4]) -> usize {
    box_kinds(data).iter().filter(|k| *k == kind).count()
}

fn u32_at(p: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(p[at..at + 4].try_into().unwrap())
}

/// 出力 m4a から moov > trak > mdia > minf > stbl のペイロードを取り出す。
fn stbl_of(out: &[u8]) -> &[u8] {
    let (_, moov) = find_box(out, b"moov").expect("moov があること");
    let (_, trak) = find_box(moov, b"trak").expect("trak があること");
    let (_, mdia) = find_box(trak, b"mdia").expect("mdia があること");
    let (_, minf) = find_box(mdia, b"minf").expect("minf があること");
    let (_, stbl) = find_box(minf, b"stbl").expect("stbl があること");
    stbl
}

/// 出力 m4a から moov > trak のペイロードを取り出す(edts の検査用)。
fn trak_of(out: &[u8]) -> &[u8] {
    let (_, moov) = find_box(out, b"moov").expect("moov があること");
    let (_, trak) = find_box(moov, b"trak").expect("trak があること");
    trak
}

/// 契約の roll 群を stbl からフィールド1つずつ検査する(AC-41-追f (a) の本体)。
///
/// sgpd v1: version(1) flags(3) grouping_type(4) default_length(4) entry_count(4)
///          roll_distance(i16=2) = ペイロード 18 バイト
/// sbgp v0: version(1) flags(3) grouping_type(4) entry_count(4)
///          sample_count(4) group_description_index(4) = ペイロード 20 バイト
fn assert_aac_roll_group(stbl: &[u8], expected_sample_count: u32) {
    // --- sgpd ---
    assert_eq!(count_boxes(stbl, b"sgpd"), 1, "stbl の sgpd は1個");
    let (_, sgpd) = find_box(stbl, b"sgpd").expect("stbl に sgpd があること");
    assert_eq!(sgpd.len(), 18, "sgpd v1・roll 1件のペイロードは 18 バイト");
    assert_eq!(sgpd[0], 1, "sgpd の version は 1(default_length を持つ形)");
    assert_eq!(&sgpd[1..4], &[0, 0, 0], "sgpd の flags は 0");
    assert_eq!(&sgpd[4..8], b"roll", "sgpd の grouping_type は roll");
    assert_eq!(u32_at(sgpd, 8), 2, "sgpd の default_length は 2(roll_distance=i16)");
    assert_eq!(u32_at(sgpd, 12), 1, "sgpd の entry_count は 1");
    let roll_distance = i16::from_be_bytes(sgpd[16..18].try_into().unwrap());
    assert_eq!(roll_distance, -1, "sgpd の entry[0].roll_distance は −1");

    // --- sbgp ---
    assert_eq!(count_boxes(stbl, b"sbgp"), 1, "stbl の sbgp は1個");
    let (_, sbgp) = find_box(stbl, b"sbgp").expect("stbl に sbgp があること");
    assert_eq!(sbgp.len(), 20, "sbgp v0・1件のペイロードは 20 バイト");
    assert_eq!(
        sbgp[0], 0,
        "sbgp の version は 0(grouping_type_parameter を持たない形)"
    );
    assert_eq!(&sbgp[1..4], &[0, 0, 0], "sbgp の flags は 0");
    assert_eq!(&sbgp[4..8], b"roll", "sbgp の grouping_type は roll");
    assert_eq!(u32_at(sbgp, 8), 1, "sbgp の entry_count は 1");
    assert_eq!(
        u32_at(sbgp, 12),
        expected_sample_count,
        "sbgp の entry[0].sample_count は出力のサンプル総数"
    );
    assert_eq!(
        u32_at(sbgp, 16),
        1,
        "sbgp の entry[0].group_description_index は 1(sgpd の entry[0] を指す)"
    );
}

/// 出力 m4a を箱歩きで読み戻し、再梱包の整合を検証する(acceptance_req41.rs の
/// AC-41-8 `assert_valid_m4a` と同じ観点+**箱順 ftyp+mdat+moov** を明示)。
/// 観点: 箱順・hdlr=soun・mdhd timescale・stsd 丸ごと一致・stts ランレングス一致・
/// stsz 整合・stsc×stco の表を辿った読み戻しが元サンプルと一致・mdat がサンプル
/// 連結と一致。
fn assert_valid_m4a(
    out: &[u8],
    stsd_in: &[u8],
    samples: &[&[u8]],
    timescale: u32,
    stts_in: &[(u32, u32)],
) {
    assert!(out.len() >= 8, "出力が短すぎる");
    assert_eq!(
        box_kinds(out),
        vec![*b"ftyp", *b"mdat", *b"moov"],
        "トップレベルの箱順は ftyp + mdat + moov(追補b が前提にする形)"
    );
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
        u32_at(mdhd_p, 20)
    } else {
        u32_at(mdhd_p, 12)
    };
    assert_eq!(ts, timescale, "mdhd の timescale は元トラックの値");

    let (_, minf) = find_box(mdia, b"minf").expect("minf があること");
    let (_, stbl) = find_box(minf, b"stbl").expect("stbl があること");

    let (stsd_full, _) = find_box(stbl, b"stsd").expect("stsd があること");
    assert_eq!(stsd_full, stsd_in, "stsd は元の箱まるごとそのまま");

    let (_, stts_p) = find_box(stbl, b"stts").expect("stts があること");
    let n = u32_at(stts_p, 4) as usize;
    let runs: Vec<(u32, u32)> = (0..n)
        .map(|i| {
            let at = 8 + i * 8;
            (u32_at(stts_p, at), u32_at(stts_p, at + 4))
        })
        .collect();
    assert_eq!(runs, stts_in, "stts は元のランレングスをそのまま");

    // stsz は一様形・per-sample 形のどちらでもよい(実サイズ列に正規化して比較)。
    let (_, stsz_p) = find_box(stbl, b"stsz").expect("stsz があること");
    let uniform = u32_at(stsz_p, 4);
    let count = u32_at(stsz_p, 8) as usize;
    assert_eq!(count, samples.len(), "stsz のサンプル数");
    let sizes: Vec<u32> = if uniform != 0 {
        vec![uniform; count]
    } else {
        (0..count).map(|i| u32_at(stsz_p, 12 + i * 4)).collect()
    };
    let expected_sizes: Vec<u32> = samples.iter().map(|s| s.len() as u32).collect();
    assert_eq!(sizes, expected_sizes, "stsz はサンプル長と一致");

    // stsc × stco/co64 を辿り、出力ファイル自身から各サンプルを読み戻して照合する
    // (チャンクの切り方は実装裁量。表がバイト位置と辻褄が合うことだけを固定)。
    let (_, stsc_p) = find_box(stbl, b"stsc").expect("stsc があること");
    let sn = u32_at(stsc_p, 4) as usize;
    let stsc_runs: Vec<(u32, u32)> = (0..sn)
        .map(|i| {
            let at = 8 + i * 12;
            (u32_at(stsc_p, at), u32_at(stsc_p, at + 4))
        })
        .collect();
    let offsets: Vec<u64> = if let Some((_, p)) = find_box(stbl, b"stco") {
        let n = u32_at(p, 4) as usize;
        (0..n).map(|i| u32_at(p, 8 + i * 4) as u64).collect()
    } else if let Some((_, p)) = find_box(stbl, b"co64") {
        let n = u32_at(p, 4) as usize;
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
// AC-41-追f (a): AAC の stsd → 出力の stbl に sgpd(roll)と sbgp(roll)がある
// ---------------------------------------------------------------------------

/// mp4a+esds の stsd で `remux_m4a` を通すと、stbl に契約どおりの sgpd(v1・roll・
/// default_length 2・1件・roll_distance −1)と sbgp(v0・roll・1件・sample_count=
/// サンプル総数・group_description_index 1)がある。フィールドを1つずつ検査。
#[test]
fn ac41_f_a_aac_remux_adds_roll_sample_group() {
    let stsd_in = stsd(&mp4a_entry());
    let s0 = vec![0xA1u8; 5];
    let s1 = vec![0xB2u8; 3];
    let s2 = vec![0xC3u8; 7];
    let s3 = vec![0xD4u8; 4];
    let samples: Vec<&[u8]> = vec![&s0, &s1, &s2, &s3];
    let stts_in = [(4u32, 1024u32)];

    let out = remux_m4a(&stsd_in, &samples, 48000, &stts_in).expect("再梱包できること");
    assert_aac_roll_group(stbl_of(&out), 4);
}

/// sbgp の sample_count は stts のラン構成に関わらず**出力のサンプル総数**
/// (= samples.len())に追随する(複数ラン・7サンプル)。
#[test]
fn ac41_f_a_sbgp_sample_count_follows_total_samples() {
    let stsd_in = stsd(&mp4a_entry());
    let bodies: Vec<Vec<u8>> = (0..7u8).map(|i| vec![0x10 + i; 3 + i as usize]).collect();
    let samples: Vec<&[u8]> = bodies.iter().map(|b| b.as_slice()).collect();
    let stts_in = [(5u32, 1024u32), (2u32, 960u32)];

    let out = remux_m4a(&stsd_in, &samples, 44100, &stts_in).expect("再梱包できること");
    assert_aac_roll_group(stbl_of(&out), 7);
}

// ---------------------------------------------------------------------------
// AC-41-追f (b): ALAC の stsd には足さない
// ---------------------------------------------------------------------------

/// alac+magic cookie の stsd で `remux_m4a` を通しても、stbl に sgpd・sbgp は無い
/// (roll 群は AAC のデコーダ遅延の話であり、ALAC には付けない)。再梱包の整合は従来どおり。
#[test]
fn ac41_f_b_alac_remux_has_no_roll_sample_group() {
    let stsd_in = stsd(&alac_entry());
    let s0 = vec![0x5Au8; 9];
    let s1 = vec![0xA5u8; 11];
    let samples: Vec<&[u8]> = vec![&s0, &s1];
    let stts_in = [(2u32, 4096u32)];

    let out = remux_m4a(&stsd_in, &samples, 44100, &stts_in).expect("ALAC も再梱包できること");
    let stbl = stbl_of(&out);
    assert_eq!(count_boxes(stbl, b"sgpd"), 0, "ALAC の stbl に sgpd は無い");
    assert_eq!(count_boxes(stbl, b"sbgp"), 0, "ALAC の stbl に sbgp は無い");
    assert_valid_m4a(&out, &stsd_in, &samples, 44100, &stts_in);
}

// ---------------------------------------------------------------------------
// AC-41-追f (c): edit_start(elst)を持つ AAC の素材 → roll 群と elst の両方
// ---------------------------------------------------------------------------

/// 元ファイル(edts > elst で先頭 2112 を削る AAC)を、コマンドと同じ経路
/// (parse_audio_extraction → normalize_sound_description → remux_m4a →
/// with_edit_list)で通す。出力の trak に edts > elst(media_time=2112)があり、
/// **かつ** stbl に roll 群がある(追補b は不変・両方が揃って WebKit が二重に削らない)。
/// 表の整合(stco が mdat のサンプルを正しく指す)も崩れない。
#[test]
fn ac41_f_c_aac_with_edit_list_keeps_both_roll_group_and_elst() {
    const PRIMING: u32 = 2112;
    const TIMESCALE: u32 = 48000;
    let bodies: Vec<Vec<u8>> = (0..5u8).map(|i| vec![0xE0 + i; 4 + i as usize]).collect();
    let sizes: Vec<u32> = bodies.iter().map(|b| b.len() as u32).collect();
    let media: Vec<u8> = bodies.iter().flat_map(|b| b.iter().copied()).collect();
    let duration = 5 * 1024;

    // ftyp + mdat + moov(moov 後置)。サンプルは mdat 先頭から連続=チャンク1つ。
    let ftyp_b = ftyp();
    let chunk_offset = (ftyp_b.len() + 8) as u32;
    let stbl = container(
        b"stbl",
        &[
            &stsd(&mp4a_entry()),
            &stts(&[(5, 1024)]),
            &stsc(&[(1, 5)]),
            &stsz_sizes(&sizes),
            &stco(&[chunk_offset]),
        ],
    );
    let minf = container(b"minf", &[&stbl]);
    let mdia = container(b"mdia", &[&mdhd(TIMESCALE), &hdlr(b"soun"), &minf]);
    let trak = container(
        b"trak",
        &[&tkhd_dummy(), &edts(duration - PRIMING, PRIMING), &mdia],
    );
    let moov = container(b"moov", &[&mvhd_dummy(), &trak]);
    let mut file = ftyp_b;
    file.extend_from_slice(&mp4_box(b"mdat", &media));
    file.extend_from_slice(&moov);

    let plan = parse_audio_extraction(&file).expect("elst 付き AAC が解析できること");
    assert_eq!(plan.codec, AudioCodec::Aac);
    assert_eq!(plan.edit_start, u64::from(PRIMING), "elst の media_time が edit_start");

    let samples: Vec<&[u8]> = plan
        .ranges
        .iter()
        .map(|r| &file[r.offset as usize..r.offset as usize + r.size as usize])
        .collect();
    let expected: Vec<&[u8]> = bodies.iter().map(|b| b.as_slice()).collect();
    assert_eq!(samples, expected, "素材から切り出したサンプルが元のバイト列");

    let stsd_used = normalize_sound_description(&plan.stsd).unwrap_or_else(|| plan.stsd.clone());
    let m4a = remux_m4a(&stsd_used, &samples, plan.timescale, &plan.stts)
        .expect("再梱包できること");
    let out = with_edit_list(&m4a, plan.edit_start).expect("elst を付けられること");

    // elst(追補b)が残っている。
    let trak_out = trak_of(&out);
    let (_, edts_p) = find_box(trak_out, b"edts").expect("出力の trak に edts があること");
    let (_, elst_p) = find_box(edts_p, b"elst").expect("edts に elst があること");
    assert_eq!(elst_p[0], 0, "elst は version 0");
    assert_eq!(u32_at(elst_p, 4), 1, "elst は 1 エントリ");
    assert_eq!(
        u32_at(elst_p, 12),
        PRIMING,
        "elst の media_time は素材の edit_start(2112)"
    );

    // roll 群(追補f)も同じ出力にある。
    assert_aac_roll_group(stbl_of(&out), 5);

    // 表の整合は崩れない(moov が伸びても mdat が前にあるので stco はそのまま)。
    assert_valid_m4a(&out, &stsd_used, &samples, TIMESCALE, &[(5, 1024)]);
}

// ---------------------------------------------------------------------------
// AC-41-追f (d): roll 群を足した後も AC-41-8 と同じ整合が成り立つ
// ---------------------------------------------------------------------------

/// AAC の再梱包で、stsd 丸ごと・stts・stsc・stsz・stco の整合・サンプルバイト
/// 不変・箱順 ftyp+mdat+moov が成り立つ(= AC-41-8 の検査)。stco のオフセットが
/// mdat のサンプルを正しく指すことは表を辿った読み戻しで固定。出力を同じ
/// ISO BMFF パーサで読み戻しても、stbl に増えた sgpd・sbgp に躓かない。
#[test]
fn ac41_f_d_aac_remux_integrity_holds_with_roll_group() {
    let stsd_in = stsd(&mp4a_entry());
    let s0 = vec![0x11u8; 4];
    let s1 = vec![0x22u8; 6];
    let s2 = vec![0x33u8; 2];
    let samples: Vec<&[u8]> = vec![&s0, &s1, &s2];
    let stts_in = [(2u32, 1024u32), (1u32, 960u32)];

    let out = remux_m4a(&stsd_in, &samples, 48000, &stts_in).expect("再梱包できること");
    assert_valid_m4a(&out, &stsd_in, &samples, 48000, &stts_in);

    let reread = parse_audio_extraction(&out).expect("再梱包した m4a を同じパーサで読み戻せること");
    assert_eq!(reread.codec, AudioCodec::Aac);
    assert_eq!(reread.stsd, stsd_in, "読み戻した stsd は丸ごと一致");
    assert_eq!(reread.stts, stts_in.to_vec(), "読み戻した stts は一致");
    let read_back: Vec<&[u8]> = reread
        .ranges
        .iter()
        .map(|r| &out[r.offset as usize..r.offset as usize + r.size as usize])
        .collect();
    assert_eq!(read_back, samples, "読み戻した範囲列が元のサンプルバイトを指す");
}
