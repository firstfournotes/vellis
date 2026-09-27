//! `search_in_folder` / `search_in_folder_page` commands — フォルダ横断検索(要件#55 契約⑤⑧・追補a)。
//!
//! 走査の本体は [`crate::search::search_in_folder_streaming`]。ここは URI の解釈と
//! provider の取り出し(`list_dir` と同じ方法)、世代番号の往復、進捗イベントの送信、
//! 結果の保持だけを持つ薄い層。世代番号はフロントが毎回進めて渡し、戻ってきた世代が
//! 現在と違えば捨てる。
//!
//! 追補a: 走査は全件行い、その窓の結果を [`SearchResults`](managed state の
//! `Mutex<ResultStore>`)に世代つきで保持して、初回は先頭 `PAGE_SIZE` 件だけ返す。
//! 続きは `search_in_folder_page` で切り出す。窓ラベルは窓のハンドルの `.label()` から取る。
//!
//! 追補d: 走査の開始時に `begin` で窓の最新世代を記録し、見つかった一致をバッチごとに
//! `search_progress` でその窓へ送る。バッチの区切りで自分の世代が最新でなくなっていたら
//! 走査を打ち切り、空の応答を返す(イベントも送らない=契約⑧の中断なしを撤回)。
//! 走査が終わったら `search_done` を送る。
//!
//! 要件#65: 検索のたびに設定ファイルを読み(`load_settings`=次の検索から効く)、検索パネルの
//! 欄(`include` / `exclude` / `use_exclude_settings`)と合わせた [`SearchScope`] で走査する。

use std::sync::Mutex;

use serde::Serialize;
use tauri::Emitter;

use crate::fs::uri::Uri;
use crate::search::{
    ResultStore, SearchControl, SearchDoneEvent, SearchFilter, SearchHit, SearchProgress,
    SearchProgressEvent, SearchScope, SEARCH_DONE_EVENT, SEARCH_PROGRESS_EVENT,
};
use crate::settings::load_settings;

pub use crate::search::SearchResponse;

use super::AppState;

/// 検索結果の保持(窓ラベル×世代)。`AppState` とは別の managed state として載せる。
#[derive(Default)]
pub struct SearchResults(pub Mutex<ResultStore>);

/// `search_in_folder_page` の戻り。世代が違えば `hits` は空。
#[derive(Clone, Debug, Serialize)]
pub struct PageResponse {
    pub generation: u64,
    pub hits: Vec<SearchHit>,
}

/// `include` / `exclude` は検索パネルの欄を割った glob の並び・`use_exclude_settings` は歯車
/// (要件#65 契約13。フロントからは `useExcludeSettings`)。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn search_in_folder(
    root: String,
    query: String,
    generation: u64,
    include: Vec<String>,
    exclude: Vec<String>,
    use_exclude_settings: bool,
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    results: tauri::State<'_, SearchResults>,
) -> Result<SearchResponse, String> {
    let root_uri = Uri::parse(&root).map_err(|e| e.to_string())?;
    let provider = state.fs_registry.resolve(&root_uri).map_err(|e| e.to_string())?;
    let scope = SearchScope::new(
        load_settings().settings,
        SearchFilter { include, exclude, use_exclude_settings },
    );
    let label = window.label().to_string();
    results.0.lock().map_err(|e| e.to_string())?.begin(&label, generation);

    // All hits in scan order, kept for `ResultStore::store` (Show more pages from it).
    let mut all: Vec<SearchHit> = Vec::new();
    let mut sink = |progress: SearchProgress| {
        // Short lock: only the generation check. The scan never calls the sink with a lock held.
        let current = results.0.lock().map(|s| s.is_current(&label, generation)).unwrap_or(false);
        if !current {
            return SearchControl::Stop;
        }
        all.extend(progress.hits.iter().cloned());
        let event = SearchProgressEvent {
            generation,
            hits: progress.hits,
            files_scanned: progress.files_scanned,
        };
        if let Err(e) = window.emit_to(window.label(), SEARCH_PROGRESS_EVENT, event) {
            tracing::warn!("search_progress emit failed: {e}");
        }
        SearchControl::Continue
    };
    // Polled between files and directories, so a stale scan with no hits to flush stops too.
    let cancel = || !results.0.lock().map(|s| s.is_current(&label, generation)).unwrap_or(true);
    let summary = scope
        .search_in_folder_streaming(provider.as_ref(), &root_uri, &query, &mut sink, &cancel)
        .await
        .map_err(|e| e.to_string())?;

    if summary.stopped {
        return Ok(SearchResponse { generation, total: 0, files: 0, hits: Vec::new() });
    }
    let response = {
        let mut store = results.0.lock().map_err(|e| e.to_string())?;
        store.store(&label, generation, all)
    };
    let done = SearchDoneEvent { generation, total: summary.total, files: summary.files };
    if let Err(e) = window.emit_to(window.label(), SEARCH_DONE_EVENT, done) {
        tracing::warn!("search_done emit failed: {e}");
    }
    Ok(response)
}

#[tauri::command]
pub fn search_in_folder_page(
    generation: u64,
    offset: usize,
    limit: usize,
    window: tauri::Window,
    results: tauri::State<'_, SearchResults>,
) -> Result<PageResponse, String> {
    let store = results.0.lock().map_err(|e| e.to_string())?;
    let hits = store.page(window.label(), generation, offset, limit);
    Ok(PageResponse { generation, hits })
}
