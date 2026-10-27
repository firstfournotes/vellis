//! 要件#41 追補i の受け入れテスト(docs/requirements/req-41.md「追補i」= Issue #468 / backlog 98)
//! — Rust 層(AC-41-追i (a)〜(c)。(d)=既存の要件#41・#45 のテストが無改変で緑、は test-runner の
//! フルスイートで見る。(e)=フロントの写しは `src/lib/audio-waveform.too-large.acceptance.test.ts`)
//!
//! 発端: `audio_extract.rs` は stsz のサンプルごとに `SampleRange` を作るので、割り付けの守り
//! `MAX_SAMPLES`(1600 万)を置いている。整数 PCM の mov は 1 フレーム= 1 サンプルなので 44.1kHz で
//! 約 6 分を超えるとこの上限に当たり、`parse_stsz` が None → 帯に「This video has no audio track」と
//! 事実と違う表示が出る。
//!
//! 判定範囲(req-41.md 追補i の契約 1〜3・受け入れ基準):
//! - (a) 大きさが一定の stsz(`sample_size != 0`)で、サンプル数が 1600 万を超える PCM の表から範囲を
//!   作ると、範囲の数はチャンクの数と同じで、各範囲の大きさは「そのチャンクのサンプル数 × 一定の
//!   大きさ」、合計はサンプル数 × 一定の大きさ(表だけを小さく作る= stsz の一様形は 20 バイト)
//! - 契約 1(訂正後): 一様 stsz で件数が `MAX_SAMPLES` **以下なら今のまま**(サンプルごとの範囲=
//!   既存の acceptance_req41.rs が固定している形)。AAC・ALAC で一様かつ上限超は `too-large`
//! - (b) 大きさが一定でない stsz(サンプルごとの表)でサンプル数が 1600 万を超えると `too-large`
//!   (`no-audio` ではない)
//! - (c) チャンクの数が `MAX_READ_RUNS`(20 万)を超えると `too-large`
//! - (f) 抜き出す音声のバイト数の合計が `MAX_AUDIO_BYTES`(256 MiB)を超えると `too-large`
//!   (`unreadable` ではない=契約 2 の補足)。ちょうど 256 MiB は通す。合計 0 は今のまま `unreadable`。
//!   `read_samples` は private・async・provider 依存で振る舞いの入口が無いので、判定を純関数
//!   `audio_bytes_refusal` に切り出して値で判定し、`read_samples` がそれを使うことはソース走査で見る
//! - 不変(契約 3): サンプルごとの表はそのまま(AAC の m4a 再梱包の材料)・壊れた表は読めない・
//!   音声トラックが無ければ `no-audio`
//! - 配線(ソース走査): コマンド `extract_waveform_audio` が理由付きの入口で計画を作り、理由を
//!   `refusal_reason` で文字列にして返す(`parse_audio_extraction` の `Option` から `no-audio` を
//!   作る旧経路を通らない)
//!
//! ## 確定契約(公開 API・implementer はこれに従う)
//!
//! ```ignore
//! // src-tauri/src/audio_extract.rs(既存)に追加・変更
//!
//! /// 1 計画が持てるサンプルごとの範囲の上限(既存の private const を pub に。値は不変)。
//! /// 追補i: **大きさが一定でない stsz(サンプルごとの表)にだけ効く**。一様形は上限を超えたら
//! /// チャンク単位にまとめるので、この上限には当たらない。
//! pub const MAX_SAMPLES: usize = 16_000_000;
//!
//! /// 1 回の抽出が出す読み出しの回数の上限(`commands/waveform.rs` の既存 const をここへ移して
//! /// pub に。値は不変。waveform.rs はこれを `use` する=定義は 1 箇所)。
//! /// 追補i: **チャンクの数に効く**(stco / co64 の件数)。
//! pub const MAX_READ_RUNS: usize = 200_000;
//!
//! /// 抽出計画が作れない理由(追補i 契約 2)。
//! #[derive(Clone, Copy, Debug, PartialEq, Eq)]
//! pub enum ExtractionRefusal {
//!     /// 音声トラックが無い・表が欠けている/辻褄が合わない(今の `None` と同じ範囲)。
//!     NoAudio,
//!     /// 音声トラックは在るが上限を超える: 大きさが一定でない stsz のサンプル数が
//!     /// `MAX_SAMPLES` を超える・チャンクの数が `MAX_READ_RUNS` を超える・AAC/ALAC で
//!     /// 一様 stsz の件数が `MAX_SAMPLES` を超える(m4a はサンプル表が要るのでまとめられない)。
//!     TooLarge,
//! }
//!
//! /// 理由付きの計画。`parse_audio_extraction(b) == plan_audio_extraction(b).ok()`
//! /// (既存の入口 `parse_audio_extraction(&[u8]) -> Option<AudioExtractionPlan>` は署名も意味も
//! /// 不変=既存テストはそのまま緑)。
//! /// - 一様 stsz・件数 ≤ MAX_SAMPLES: 今のまま(サンプルごとの範囲)
//! /// - 一様 stsz・件数 > MAX_SAMPLES: PCM はチャンクごとに 1 範囲 { offset: チャンクの先頭,
//! ///   size: そのチャンクのサンプル数 × 一定の大きさ }(最後のチャンクは残りのサンプル数)。
//! ///   AAC / ALAC は `Err(TooLarge)`。Unsupported は本ファイルでは判定しない
//! /// - サンプルごとの stsz: 宣言の件数(`sample_count`)が `MAX_SAMPLES` を超えたら
//! ///   `Err(TooLarge)`。**判定は表の中身を読む前**(今の `parse_stsz` と同じ順=割り付けの守り。
//! ///   ちょうど `MAX_SAMPLES` は超ではない)。超えなければ今までどおりサンプルごとの範囲
//! /// - チャンクの数(stco / co64 の件数)が `MAX_READ_RUNS` を超えたら `Err(TooLarge)`
//! ///   (ちょうど `MAX_READ_RUNS` は超ではない)
//! /// - 音声トラックなし・moov なし・表の欠落・辻褄割れ・壊れた入力は `Err(NoAudio)`
//! pub fn plan_audio_extraction(bytes: &[u8]) -> Result<AudioExtractionPlan, ExtractionRefusal>;
//!
//! // src-tauri/src/commands/waveform.rs(既存)に追加
//!
//! /// フロントへ返す理由の文字列(契約⑤の語彙): NoAudio → "no-audio"・TooLarge → "too-large"。
//! pub fn refusal_reason(refusal: ExtractionRefusal) -> &'static str;
//!
//! /// 1 回の抽出が組み立てる音声の合計バイト数の上限(既存の private const を pub に。値は不変=
//! /// 256 MiB・TS の `WAVEFORM_MAX_SOURCE_BYTES` と同値)。
//! pub const MAX_AUDIO_BYTES: u64 = 256 * 1024 * 1024;
//!
//! /// 抜き出す音声の合計バイト数 `total` から、読まずに断る理由(契約 2 の補足)。
//! /// - `total == 0` → `Some("unreadable")`(今のまま: 読むものが無い)
//! /// - `total > MAX_AUDIO_BYTES` → `Some("too-large")`
//! /// - それ以外(ちょうど `MAX_AUDIO_BYTES` を含む)→ `None`(読む)
//! pub fn audio_bytes_refusal(total: u64) -> Option<&'static str>;
//!
//! // `extract_waveform_audio` の本体(配線=ソース走査): `plan_audio_extraction(` で計画を作り、
//! // `Err(refusal)` を `refusal_reason(` で文字列にして返す。`parse_audio_extraction(` は呼ばない。
//! // `read_samples` の本体(配線=ソース走査): 合計バイト数の判定は `audio_bytes_refusal(` で行い、
//! // `Some(reason)` を `Err(reason.to_string())` で返す。`total > MAX_AUDIO_BYTES` の直書きは残さない。
//! ```
//!
//! ## 本ファイルが判定しないもの
//! - 一様 stsz で件数が**ちょうど** `MAX_SAMPLES` の形(サンプルごとに 1600 万の範囲=割り付けが
//!   大きいので試さない。「以下は今のまま」は小さな表=5 で固定する)
//! - Unsupported(AC-3 等)で一様かつ上限超(契約に無い=実装裁量)
//! - (e) フロント `invokeWaveformBytes` の写しは vitest(上記ファイル)が判定する
//!
//! ## 赤の源
//! `plan_audio_extraction` / `ExtractionRefusal` / `MAX_SAMPLES` / `MAX_READ_RUNS` の公開・
//! `commands::waveform::refusal_reason` が未定義なので本ファイルはコンパイルで赤。実装後も、今の
//! `parse_stsz` は一様形を `vec![uniform; count]` に展開して `count > MAX_SAMPLES` で None にするので
//! (a) は赤、(b)(c) と AAC/ALAC の一様・上限超は理由が無いので赤、配線の走査は旧経路のままなので赤。
//! (f) は `audio_bytes_refusal` / pub `MAX_AUDIO_BYTES` が未定義でコンパイル赤、`read_samples` の走査は
//! 今の `total > MAX_AUDIO_BYTES → UNREADABLE` の直書きのままなので赤。
//!
//! フィクスチャは acceptance_req41.rs / acceptance_req45.rs の作法でバイト列合成する(実動画の
//! コミットなし・大きなファイルは書かない: 1600 万超は一様形の stsz 20 バイト、またはサンプルごとの
//! 表を「宣言だけ」で表す)。

use vellis_lib::audio_extract::{
    parse_audio_extraction, plan_audio_extraction, AudioCodec, ExtractionRefusal, SampleRange,
    MAX_READ_RUNS, MAX_SAMPLES,
};
use vellis_lib::commands::waveform::{audio_bytes_refusal, refusal_reason, MAX_AUDIO_BYTES};

// ---------------------------------------------------------------------------
// フィクスチャ合成ヘルパ(ISO BMFF / QuickTime の箱を最小構成で組む・req41 の家風)
// ---------------------------------------------------------------------------

/// 32bit サイズの箱(size はヘッダ 8 バイトを含む)。
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

/// stsd 内のサウンドサンプル記述(v0・2ch・16bit・44100Hz の 16.16 固定小数)。
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

/// mp4a+esds の標準サンプル記述(AAC)。
fn mp4a_entry() -> Vec<u8> {
    sound_entry(b"mp4a", &[&mp4_box(b"esds", &esds_payload())])
}

/// alac+magic cookie のサンプル記述(ALAC)。
fn alac_entry() -> Vec<u8> {
    sound_entry(b"alac", &[&mp4_box(b"alac", &[0u8; 24])])
}

/// sowt(16bit LE PCM・2ch)= 1 サンプル 4 バイトの整数 PCM(backlog 98 の当事者)。
fn sowt_entry() -> Vec<u8> {
    sound_entry(b"sowt", &[])
}

/// sowt 2ch 16bit の 1 サンプルのバイト数= stsz の一定の大きさ。
const SAMPLE_BYTES: u32 = 4;

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

/// stsz(サンプルごとのサイズ列・sample_size = 0)。
fn stsz_sizes(sizes: &[u32]) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&0u32.to_be_bytes()); // sample_size 0 = per-sample
    p.extend_from_slice(&(sizes.len() as u32).to_be_bytes());
    for s in sizes {
        p.extend_from_slice(&s.to_be_bytes());
    }
    mp4_box(b"stsz", &p)
}

/// stsz(一様サイズ形= sample_size != 0。件数によらず 20 バイト)。
fn stsz_uniform(size: u32, count: u32) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&size.to_be_bytes());
    p.extend_from_slice(&count.to_be_bytes());
    mp4_box(b"stsz", &p)
}

/// stsz(サンプルごとの形で **件数だけ宣言し、表の中身は持たない**)。上限の判定は宣言の件数で
/// 表を読む前に行う(契約)ので、1600 万超の表を実際に作らずに (b) を試せる。上限以下なら
/// 読みに行って欠けている= 壊れた表(NoAudio)になる。
fn stsz_per_sample_declared(count: u32) -> Vec<u8> {
    let mut p = full_header(0);
    p.extend_from_slice(&0u32.to_be_bytes()); // sample_size 0 = per-sample
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

fn ftyp() -> Vec<u8> {
    mp4_box(b"ftyp", b"qt  \x00\x00\x02\x00qt  ")
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

/// 映像トラック+ `entry` の音声トラック(stsc / stsz / stco を差し替えて組む)。
fn movie_with(entry: &[u8], stsc_runs: &[(u32, u32)], stsz_box: &[u8], offsets: &[u32]) -> Vec<u8> {
    build_movie(&[
        video_trak_dummy(),
        audio_trak(entry, &[&stsc(stsc_runs), stsz_box, &stco(offsets)]),
    ])
}

/// 映像トラック+ sowt PCM の音声トラック。
fn pcm_movie(stsc_runs: &[(u32, u32)], stsz_box: &[u8], offsets: &[u32]) -> Vec<u8> {
    movie_with(&sowt_entry(), stsc_runs, stsz_box, offsets)
}

fn r(offset: u64, size: u32) -> SampleRange {
    SampleRange { offset, size }
}

/// 範囲列の大きさの合計(バイト)。
fn total_bytes(ranges: &[SampleRange]) -> u64 {
    ranges.iter().map(|r| u64::from(r.size)).sum()
}

/// チャンクのバイト数の列から、`base` 起点で詰めて並べたチャンクの先頭オフセット列。
fn chunk_offsets(base: u32, chunk_bytes: &[u32]) -> Vec<u32> {
    let mut at = base;
    chunk_bytes
        .iter()
        .map(|&bytes| {
            let here = at;
            at += bytes;
            here
        })
        .collect()
}

/// AAC(mp4a+esds)・サンプルごとの stsz・stsc 2 エントリ・stco の標準フィクスチャ
/// (acceptance_req41.rs の `aac_movie` と同じ表)。
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

fn sowt_codec() -> AudioCodec {
    AudioCodec::Pcm {
        sample_rate: 44100,
        channels: 2,
        bits_per_sample: 16,
        big_endian: false,
        float: false,
    }
}

// ---------------------------------------------------------------------------
// 上限の値(契約: 値は不変・公開される)
// ---------------------------------------------------------------------------

/// 1. `MAX_SAMPLES` は 1600 万・`MAX_READ_RUNS` は 20 万のまま(追補i は適用先を変えるだけ)。
#[test]
fn caps_keep_their_values() {
    assert_eq!(MAX_SAMPLES, 16_000_000, "MAX_SAMPLES must stay at 16 million");
    assert_eq!(MAX_READ_RUNS, 200_000, "MAX_READ_RUNS must stay at 200 thousand");
}

// ---------------------------------------------------------------------------
// AC-41-追i (a) — 一様 stsz・1600 万超の PCM の表 → チャンクごとに 1 範囲
// ---------------------------------------------------------------------------

/// 2. sowt(1 サンプル 4 バイト)・一様 stsz 1700 万サンプル・100 万サンプル/チャンク × 17 チャンク:
///    範囲は 17(=チャンクの数)、各範囲はそのチャンクの先頭から 400 万バイト、合計は
///    1700 万 × 4。旧の入口 `parse_audio_extraction` も Some(backlog 98 の「音声トラックなし」が消える)。
#[test]
fn uniform_pcm_over_the_sample_cap_yields_one_range_per_chunk() {
    let count: u32 = 17_000_000;
    assert!(count as usize > MAX_SAMPLES, "precondition: the table is past the sample cap");
    let per_chunk: u32 = 1_000_000;
    let chunk_bytes = per_chunk * SAMPLE_BYTES;
    let offsets = chunk_offsets(4096, &[chunk_bytes; 17]);
    let file = pcm_movie(&[(1, per_chunk)], &stsz_uniform(SAMPLE_BYTES, count), &offsets);

    let plan = plan_audio_extraction(&file)
        .expect("a uniform PCM table past the sample cap must still yield a plan");

    assert_eq!(plan.codec, sowt_codec(), "the fixture is integer PCM");
    assert_eq!(
        plan.ranges.len(),
        offsets.len(),
        "one range per chunk, not one per sample: {:?}",
        plan.ranges.iter().take(3).collect::<Vec<_>>()
    );
    for (i, (range, &offset)) in plan.ranges.iter().zip(&offsets).enumerate() {
        assert_eq!(range.offset, u64::from(offset), "range {i} must start at its chunk");
        assert_eq!(
            range.size, chunk_bytes,
            "range {i} must cover the chunk's samples × the uniform size"
        );
    }
    assert_eq!(
        total_bytes(&plan.ranges),
        u64::from(count) * u64::from(SAMPLE_BYTES),
        "the ranges must add up to sample count × uniform size"
    );
    assert!(
        parse_audio_extraction(&file).is_some(),
        "the Option entry must agree: a long PCM movie is not \"no audio\""
    );
}

/// 3. 最後のチャンクが短い(1650 万サンプル・100 万/チャンク → 17 番目は 50 万): 各範囲の大きさは
///    「そのチャンクのサンプル数 × 一定の大きさ」なので最後だけ 200 万バイト。合計は 1650 万 × 4。
#[test]
fn uniform_pcm_short_last_chunk_is_sized_by_its_own_sample_count() {
    let count: u32 = 16_500_000;
    assert!(count as usize > MAX_SAMPLES, "precondition: the table is past the sample cap");
    let per_chunk: u32 = 1_000_000;
    let chunk_bytes = per_chunk * SAMPLE_BYTES;
    let offsets = chunk_offsets(4096, &[chunk_bytes; 17]);
    let file = pcm_movie(&[(1, per_chunk)], &stsz_uniform(SAMPLE_BYTES, count), &offsets);

    let plan = plan_audio_extraction(&file).expect("a uniform PCM table with a short last chunk must plan");

    assert_eq!(plan.ranges.len(), 17, "one range per chunk");
    for (i, range) in plan.ranges.iter().take(16).enumerate() {
        assert_eq!(range.size, chunk_bytes, "full chunk {i} must be 1,000,000 × 4 bytes");
    }
    assert_eq!(
        plan.ranges[16],
        r(u64::from(offsets[16]), 500_000 * SAMPLE_BYTES),
        "the last chunk holds the remaining 500,000 samples"
    );
    assert_eq!(total_bytes(&plan.ranges), u64::from(count) * u64::from(SAMPLE_BYTES));
}

/// 4. stsc のランレングスごとにチャンクのサンプル数が変わる(1〜2 番目 100 万・3〜9 番目 200 万・
///    10 番目以降 50 万 → 11 チャンクで 1700 万): 範囲の大きさがランごとに変わり、合計は 1700 万 × 4。
#[test]
fn uniform_pcm_follows_the_stsc_runs_chunk_by_chunk() {
    let runs = [(1u32, 1_000_000u32), (3, 2_000_000), (10, 500_000)];
    let samples_per_chunk: Vec<u32> = [1_000_000, 1_000_000]
        .into_iter()
        .chain(std::iter::repeat(2_000_000).take(7))
        .chain([500_000, 500_000])
        .collect();
    let count: u32 = samples_per_chunk.iter().sum();
    assert_eq!(count, 17_000_000);
    assert!(count as usize > MAX_SAMPLES, "precondition: the table is past the sample cap");
    let chunk_bytes: Vec<u32> = samples_per_chunk.iter().map(|n| n * SAMPLE_BYTES).collect();
    let offsets = chunk_offsets(4096, &chunk_bytes);
    let file = pcm_movie(&runs, &stsz_uniform(SAMPLE_BYTES, count), &offsets);

    let plan = plan_audio_extraction(&file).expect("a uniform PCM table with stsc runs must plan");

    let expected: Vec<SampleRange> = offsets
        .iter()
        .zip(&chunk_bytes)
        .map(|(&offset, &bytes)| r(u64::from(offset), bytes))
        .collect();
    assert_eq!(plan.ranges, expected, "one range per chunk, sized by that chunk's run");
    assert_eq!(total_bytes(&plan.ranges), u64::from(count) * u64::from(SAMPLE_BYTES));
}

// ---------------------------------------------------------------------------
// 契約 1(訂正後)— 上限以下の一様 stsz は今のまま・AAC/ALAC の一様・上限超は too-large
// ---------------------------------------------------------------------------

/// 5. 一様 stsz で件数が上限以下(5 サンプル・3 + 2 の 2 チャンク)はサンプルごとの範囲のまま
///    (既存 acceptance_req41.rs が固定する形。新旧の入口が一致)。
#[test]
fn uniform_pcm_within_the_sample_cap_stays_one_range_per_sample() {
    let file = pcm_movie(&[(1, 3)], &stsz_uniform(SAMPLE_BYTES, 5), &[100, 200]);

    let plan = plan_audio_extraction(&file).expect("a small uniform PCM table must plan");

    assert_eq!(
        plan.ranges,
        vec![r(100, 4), r(104, 4), r(108, 4), r(200, 4), r(204, 4)],
        "within the cap a uniform table is still one range per sample (unchanged)"
    );
    assert_eq!(Some(plan), parse_audio_extraction(&file), "the Option entry must agree");
}

/// 6. AAC・ALAC で一様 stsz かつ件数が上限超(実在しない形): m4a 再梱包はサンプル表が要るので
///    チャンク単位にまとめられず、`Err(TooLarge)`(no-audio ではない)。
#[test]
fn uniform_stsz_over_the_sample_cap_is_too_large_for_aac_and_alac() {
    let count: u32 = 17_000_000;
    assert!(count as usize > MAX_SAMPLES, "precondition: the table is past the sample cap");
    let per_chunk: u32 = 1_000_000;
    let offsets = chunk_offsets(4096, &[per_chunk * SAMPLE_BYTES; 17]);
    for (name, entry) in [("mp4a", mp4a_entry()), ("alac", alac_entry())] {
        let file = movie_with(
            &entry,
            &[(1, per_chunk)],
            &stsz_uniform(SAMPLE_BYTES, count),
            &offsets,
        );

        let result = plan_audio_extraction(&file);
        assert_eq!(
            result,
            Err(ExtractionRefusal::TooLarge),
            "{name}: a uniform table past the cap cannot be re-wrapped sample for sample, so it is too large"
        );
        assert_eq!(refusal_reason(result.unwrap_err()), "too-large", "{name}");
    }
}

// ---------------------------------------------------------------------------
// AC-41-追i (b) — サンプルごとの stsz・1600 万超 → too-large(no-audio ではない)
// ---------------------------------------------------------------------------

/// 7. サンプルごとの stsz が 1600 万 + 1 件を宣言: `Err(TooLarge)`、理由の文字列は "too-large"
///    (PCM でも AAC でも)。表の中身は読まずに判定するので、宣言だけの 20 バイトの stsz で試せる。
#[test]
fn per_sample_stsz_over_the_sample_cap_is_too_large_not_no_audio() {
    let declared = (MAX_SAMPLES + 1) as u32;
    let offsets = chunk_offsets(4096, &[SAMPLE_BYTES * 1_000_000; 17]);
    for (name, entry) in [("sowt", sowt_entry()), ("mp4a", mp4a_entry())] {
        let file = build_movie(&[
            video_trak_dummy(),
            audio_trak(
                &entry,
                &[
                    &stts(&[(declared, 1)]),
                    &stsc(&[(1, 1_000_000)]),
                    &stsz_per_sample_declared(declared),
                    &stco(&offsets),
                ],
            ),
        ]);

        let result = plan_audio_extraction(&file);
        assert_eq!(
            result,
            Err(ExtractionRefusal::TooLarge),
            "{name}: a per-sample table past the cap is too large, not no-audio"
        );
        let reason = refusal_reason(result.unwrap_err());
        assert_eq!(reason, "too-large", "{name}: the frontend's reason is too-large");
        assert_ne!(reason, "no-audio", "{name}: it must not read as no audio");
    }
}

/// 8. ちょうど 1600 万件は「超」ではない: 上限では弾かれず表を読みに行き、中身が欠けているので
///    壊れた表= `Err(NoAudio)`(契約 3「数が合わなければ読めない」のまま)。
#[test]
fn per_sample_stsz_at_the_sample_cap_is_not_refused_as_too_large() {
    let declared = MAX_SAMPLES as u32;
    let offsets = chunk_offsets(4096, &[SAMPLE_BYTES * 1_000_000; 16]);
    let file = pcm_movie(&[(1, 1_000_000)], &stsz_per_sample_declared(declared), &offsets);

    let result = plan_audio_extraction(&file);
    assert_ne!(
        result,
        Err(ExtractionRefusal::TooLarge),
        "exactly MAX_SAMPLES entries is within the cap"
    );
    assert_eq!(
        result,
        Err(ExtractionRefusal::NoAudio),
        "a table that declares entries it does not carry is a broken table"
    );
}

// ---------------------------------------------------------------------------
// AC-41-追i (c) — チャンクの数が MAX_READ_RUNS を超える → too-large
// ---------------------------------------------------------------------------

/// 9. 20 万 + 1 チャンク(1 サンプル/チャンク): 一様 stsz でもサンプルごとの stsz でも `Err(TooLarge)`、
///    理由は "too-large"。サンプル数(20 万 + 1)は 1600 万の内側なので、効いているのはチャンクの守り。
#[test]
fn more_chunks_than_max_read_runs_is_too_large() {
    let chunks = (MAX_READ_RUNS + 1) as u32;
    assert!((chunks as usize) < MAX_SAMPLES, "precondition: only the chunk cap is exceeded");
    let offsets: Vec<u32> = (0..chunks).map(|i| 4096 + i * SAMPLE_BYTES).collect();

    let uniform = pcm_movie(&[(1, 1)], &stsz_uniform(SAMPLE_BYTES, chunks), &offsets);
    let result = plan_audio_extraction(&uniform);
    assert_eq!(
        result,
        Err(ExtractionRefusal::TooLarge),
        "uniform stsz: more chunks than MAX_READ_RUNS is too large"
    );
    assert_eq!(refusal_reason(result.unwrap_err()), "too-large");

    let sizes = vec![SAMPLE_BYTES; chunks as usize];
    let per_sample = pcm_movie(&[(1, 1)], &stsz_sizes(&sizes), &offsets);
    let result = plan_audio_extraction(&per_sample);
    assert_eq!(
        result,
        Err(ExtractionRefusal::TooLarge),
        "per-sample stsz: more chunks than MAX_READ_RUNS is too large"
    );
    assert_eq!(refusal_reason(result.unwrap_err()), "too-large");
}

/// 10. ちょうど 20 万チャンクは「超」ではない: 計画が返り、範囲は 20 万(1 サンプル/チャンクなので
///     一様形でもサンプルごとでも 1 チャンク= 1 範囲)、各範囲はそのチャンクの先頭、合計は 20 万 × 4。
#[test]
fn exactly_max_read_runs_chunks_is_accepted() {
    let chunks = MAX_READ_RUNS as u32;
    let offsets: Vec<u32> = (0..chunks).map(|i| 4096 + i * SAMPLE_BYTES).collect();
    let file = pcm_movie(&[(1, 1)], &stsz_uniform(SAMPLE_BYTES, chunks), &offsets);

    let plan = plan_audio_extraction(&file).expect("exactly MAX_READ_RUNS chunks is within the cap");

    assert_eq!(plan.ranges.len(), MAX_READ_RUNS, "one range per chunk");
    for (range, &offset) in plan.ranges.iter().zip(&offsets) {
        assert_eq!(range.offset, u64::from(offset));
        assert_eq!(range.size, SAMPLE_BYTES);
    }
    assert_eq!(total_bytes(&plan.ranges), u64::from(chunks) * u64::from(SAMPLE_BYTES));
}

// ---------------------------------------------------------------------------
// 理由の語彙(契約 2・契約⑤)
// ---------------------------------------------------------------------------

/// 11. `refusal_reason`: NoAudio → "no-audio"・TooLarge → "too-large"(フロントの既存の理由の綴り)。
#[test]
fn refusal_reasons_are_the_frontend_vocabulary() {
    assert_eq!(refusal_reason(ExtractionRefusal::NoAudio), "no-audio");
    assert_eq!(refusal_reason(ExtractionRefusal::TooLarge), "too-large");
    assert_ne!(
        refusal_reason(ExtractionRefusal::NoAudio),
        refusal_reason(ExtractionRefusal::TooLarge),
        "the two refusals must be told apart by the band"
    );
}

// ---------------------------------------------------------------------------
// 不変(契約 3)— 理由付きの入口は旧の入口と同じ計画を返す・サンプル表はそのまま・無ければ no-audio
// ---------------------------------------------------------------------------

/// 12. `plan_audio_extraction(b).ok() == parse_audio_extraction(b)`: AAC のサンプルごとの表は
///     サンプルごとの範囲のまま(m4a 再梱包の材料)、映像のみ・moov なし・空・ごみは `Err(NoAudio)`。
#[test]
fn reasoned_entry_agrees_with_the_option_entry_and_keeps_sample_tables() {
    let aac = aac_movie();
    let plan = plan_audio_extraction(&aac).expect("the AAC fixture must plan");
    assert_eq!(plan.codec, AudioCodec::Aac);
    assert_eq!(
        plan.ranges,
        expected_aac_ranges(),
        "a per-sample table within the cap stays one range per sample (the m4a route needs it)"
    );
    assert_eq!(
        Some(plan),
        parse_audio_extraction(&aac),
        "the Option entry must return the same plan"
    );

    let video_only = build_movie(&[video_trak_dummy()]);
    assert_eq!(
        plan_audio_extraction(&video_only),
        Err(ExtractionRefusal::NoAudio),
        "no audio track is NoAudio"
    );
    assert_eq!(parse_audio_extraction(&video_only), None);

    for (name, bytes) in [
        ("garbage", b"this is not a movie at all".to_vec()),
        ("empty", Vec::new()),
        ("ftyp only", ftyp()),
    ] {
        assert_eq!(
            plan_audio_extraction(&bytes),
            Err(ExtractionRefusal::NoAudio),
            "{name}: unreadable input is NoAudio, as before"
        );
        assert_eq!(parse_audio_extraction(&bytes), None, "{name}");
    }
    assert_eq!(
        refusal_reason(plan_audio_extraction(&video_only).unwrap_err()),
        "no-audio",
        "the band still says no audio for a movie without an audio track"
    );
}

// ---------------------------------------------------------------------------
// AC-41-追i (f) — 抜き出す音声の合計が MAX_AUDIO_BYTES を超える → too-large(unreadable ではない)
// ---------------------------------------------------------------------------

/// 13. `MAX_AUDIO_BYTES` は 256 MiB のまま(TS の `WAVEFORM_MAX_SOURCE_BYTES` と同値・値は不変)。
#[test]
fn max_audio_bytes_keeps_its_value() {
    assert_eq!(MAX_AUDIO_BYTES, 256 * 1024 * 1024, "MAX_AUDIO_BYTES must stay at 256 MiB");
}

/// 14. 合計が 256 MiB を超える(+1 バイト・2 倍・u64::MAX)→ "too-large"。"unreadable" ではなく、
///     `refusal_reason(TooLarge)` と同じ綴り(フロントは (e) で `too-large` に写す)。
#[test]
fn audio_bytes_over_the_cap_are_too_large_not_unreadable() {
    for total in [MAX_AUDIO_BYTES + 1, MAX_AUDIO_BYTES * 2, u64::MAX] {
        let refusal = audio_bytes_refusal(total);
        assert_eq!(refusal, Some("too-large"), "total={total}: past the cap is too large");
        assert_ne!(refusal, Some("unreadable"), "total={total}: it must not read as unreadable");
        assert_eq!(
            refusal,
            Some(refusal_reason(ExtractionRefusal::TooLarge)),
            "total={total}: the same word the plan uses for its caps"
        );
    }
}

/// 15. 境界: ちょうど 256 MiB は通す(`None`)。その内側(1 バイト・256 MiB − 1)も通す。
#[test]
fn audio_bytes_at_or_below_the_cap_are_read() {
    assert_eq!(
        audio_bytes_refusal(MAX_AUDIO_BYTES),
        None,
        "exactly MAX_AUDIO_BYTES is within the cap (only more than that is refused)"
    );
    for total in [1, 44, MAX_AUDIO_BYTES - 1] {
        assert_eq!(audio_bytes_refusal(total), None, "total={total}: within the cap is read");
    }
}

/// 16. 合計 0 は今のまま "unreadable"(読むものが無い=大きすぎるのではない)。
#[test]
fn zero_audio_bytes_stay_unreadable() {
    assert_eq!(audio_bytes_refusal(0), Some("unreadable"), "nothing to read stays unreadable");
    assert_ne!(audio_bytes_refusal(0), Some("too-large"));
}

// ---------------------------------------------------------------------------
// ソース走査の道具(acceptance_req12a.rs / acceptance_req62a.rs と同じ流儀)
// ---------------------------------------------------------------------------

/// 行ごとに `//` 以降(コメント)を落としたコード部分を連結して返す。`://` は落とさない。
fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|line| {
            let bytes = line.as_bytes();
            let mut i = 0;
            while i + 1 < bytes.len() {
                if bytes[i] == b'/' && bytes[i + 1] == b'/' && (i == 0 || bytes[i - 1] != b':') {
                    return &line[..i];
                }
                i += 1;
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn waveform_rs_code() -> String {
    strip_line_comments(include_str!("../src/commands/waveform.rs"))
}

fn audio_extract_rs_code() -> String {
    strip_line_comments(include_str!("../src/audio_extract.rs"))
}

/// `open` の位置の開き括弧に対応する閉じ括弧の位置(`(`/`[`/`{` を同じ深さで数える)。
fn matching_close(code: &str, open: usize) -> usize {
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    return open + i;
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced bracket starting at byte {open}");
}

/// `fn <name>(` で始まる関数の本体(最初の `{` から対応する `}` まで)。
fn fn_body<'a>(code: &'a str, name: &str) -> &'a str {
    let needle = format!("fn {name}(");
    let start = code
        .find(&needle)
        .unwrap_or_else(|| panic!("source must define `{needle}...`"));
    let open = code[start..].find('{').expect("fn must have a body") + start;
    let close = matching_close(code, open);
    &code[open..=close]
}

// ---------------------------------------------------------------------------
// 配線(ソース走査)— コマンドが理由付きの入口を使い、理由を文字列にして返す
// ---------------------------------------------------------------------------

/// 17. `extract_waveform_audio` の本体は `plan_audio_extraction(` で計画を作り、`refusal_reason(` で
///     理由を返す。`parse_audio_extraction(` の Option から `no-audio` を作る旧経路は通らない
///     (通ると TooLarge が no-audio に潰れる)。
#[test]
fn command_plans_with_the_reasoned_entry_and_reports_its_reason() {
    let code = waveform_rs_code();
    let body = fn_body(&code, "extract_waveform_audio");
    assert!(
        body.contains("plan_audio_extraction("),
        "extract_waveform_audio must plan with audio_extract::plan_audio_extraction: {body}"
    );
    assert!(
        body.contains("refusal_reason("),
        "extract_waveform_audio must turn the refusal into the frontend's reason with refusal_reason: {body}"
    );
    assert!(
        !body.contains("parse_audio_extraction("),
        "extract_waveform_audio must not go through the Option entry (it cannot say too-large): {body}"
    );
}

/// 18. 上限の定義は 1 箇所: `commands/waveform.rs` は `MAX_READ_RUNS` / `MAX_SAMPLES` を自前で
///     定義しない(`audio_extract.rs` の pub const を使う。値の固定は 1 で見る)。
#[test]
fn the_caps_are_defined_once_in_audio_extract() {
    let waveform = waveform_rs_code();
    assert!(
        !waveform.contains("const MAX_READ_RUNS"),
        "commands/waveform.rs must not keep its own MAX_READ_RUNS (it moved to audio_extract.rs)"
    );
    assert!(
        !waveform.contains("const MAX_SAMPLES"),
        "commands/waveform.rs must not define MAX_SAMPLES"
    );
    let extract = audio_extract_rs_code();
    assert!(
        extract.contains("pub const MAX_READ_RUNS"),
        "audio_extract.rs must own MAX_READ_RUNS as a pub const"
    );
    assert!(
        extract.contains("pub const MAX_SAMPLES"),
        "audio_extract.rs must expose MAX_SAMPLES as a pub const"
    );
}

/// 19. (f) の配線: `read_samples` の本体は合計バイト数の判定を `audio_bytes_refusal(` で行い
///     (`total > MAX_AUDIO_BYTES` の直書きを残さない)、`MAX_AUDIO_BYTES` は pub const のまま
///     `commands/waveform.rs` に 1 つ。
#[test]
fn read_samples_refuses_the_audio_size_with_the_pure_function() {
    let code = waveform_rs_code();
    let body = fn_body(&code, "read_samples");
    assert!(
        body.contains("audio_bytes_refusal("),
        "read_samples must decide the audio size with audio_bytes_refusal: {body}"
    );
    let flat: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    assert!(
        !flat.contains(">MAX_AUDIO_BYTES"),
        "read_samples must not keep its own `total > MAX_AUDIO_BYTES` check (it would still say unreadable): {body}"
    );
    assert!(
        code.contains("pub const MAX_AUDIO_BYTES"),
        "commands/waveform.rs must expose MAX_AUDIO_BYTES as a pub const"
    );
    assert_eq!(
        code.matches("const MAX_AUDIO_BYTES").count(),
        1,
        "MAX_AUDIO_BYTES must be defined once"
    );
}
