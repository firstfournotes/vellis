//! `open_document` / `open_binary_document` / `save_document` commands — open
//! a document in the calling window, or write one back. The binary variant
//! watches without reading (要件#22); the write is the whole of the app's
//! authority to modify a file (要件#48).

use tauri::{Manager, Window};

use crate::annotation::snapshot::snapshot_store_dir;
use crate::annotation::SnapshotManager;
use crate::features;
use crate::fs::local::{ensure_within_root, LocalProvider};
use crate::fs::uri::Uri;
use crate::recent_files;
use crate::session::document::{DocumentPayload, DocumentSession};
use crate::settings::{announce_changed, is_settings_file};
use crate::watch::hub::WindowId;

use super::AppState;

/// Open a document: drop any existing session, create a new one (subscribe-first),
/// read content, and return a `DocumentPayload`.
#[tauri::command]
pub async fn open_document(
    uri: String,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<DocumentPayload, String> {
    open_in_window(uri, window, state, false).await
}

/// Open a raster image as a watch-only document (要件#22): same session
/// swap and subscribe-first ordering as `open_document`, but the file is
/// never read — the payload's content is empty and the bytes reach the
/// `<img>` through `vellis-asset:`.
#[tauri::command]
pub async fn open_binary_document(
    uri: String,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<DocumentPayload, String> {
    open_in_window(uri, window, state, true).await
}

/// Write `content` back to `uri` (要件#48 契約①⑤) — the app's only write to a
/// user file, and the only one it will ever have (delete / rename / move stay
/// out by design, `docs/architecture.md` §10.1).
///
/// Four gates, in this order, and none of them is skippable:
///
/// 1. **Scheme** — `ssh://` is refused here, before a provider is even
///    resolved. SSH roots are read-only in this first cut (追補a).
/// 2. **Root containment** — the target must resolve inside the root *this
///    window* currently shows. The root is the window's, not a global one:
///    two windows on different folders must not be able to write into each
///    other's tree. `LocalProvider` holds no root of its own, so this check
///    lives here (追補a) and is a pure function
///    (`fs::local::ensure_within_root`) so it can be judged on its own.
/// 3. **Snapshot** — a copy under `<root>/.vellis/snapshots/` *before* the
///    write, which is what makes the edit undoable through the existing
///    revert (契約⑤). Without the current AI integration (`ai_marks`) the
///    copy goes under the app's data directory instead, so the folder you
///    opened gets no `.vellis/` (requirements.md #74 (ag)). A failure here aborts the save: the safety net is the
///    reason FR-02 (viewer-only) could be withdrawn at all, so a save without
///    one is not a save this command is willing to perform.
/// 4. **Write** — `LocalProvider::write_text_within_root`, tmp+rename,
///    bytes verbatim, to the path step 2 resolved — a symlink's target, never
///    the link itself (追補d) — with the root step 2 judged against, so the
///    provider checks the target against it once more just before the rename
///    (追補j(2)).
///
/// The write makes the file watcher fire `file_changed` right back at the
/// window that saved. The frontend recognises its own bytes by hash and drops
/// that echo (契約⑥), which is what keeps the caret from being thrown away by
/// a re-render half a second after every save.
///
/// When the file written is the user's `settings.json` (requirements.md #65
/// 契約7・8), it is read back, every window is told to re-list its tree
/// (`settings_changed`), and what is wrong with it — if anything — is shown
/// once, in English.
///
/// The editor is a regular feature (requirements.md #74 契約21): there is no
/// flag gate in front of the command any more.
///
/// With `expected_hash` (requirements.md #74 契約14) the file on disk is
/// compared with the version the editor started from right after the root
/// check and before the snapshot: when it changed, nothing is written or
/// copied and the error starts with [`SAVE_CONFLICT_PREFIX`]. Without it the
/// save writes as before (the current editing's `saveDocument(uri, content)`).
#[tauri::command]
pub async fn save_document(
    uri: String,
    content: String,
    expected_hash: Option<String>,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let parsed_uri = Uri::parse(&uri).map_err(|e| e.to_string())?;
    if parsed_uri.scheme != "file" {
        return Err(format!(
            "saving is not supported for {} roots: {}",
            parsed_uri.scheme, uri
        ));
    }

    // The window's own root, as last set by `init_window` / `set_root`.
    let root_uri = {
        let wm = state.window_manager.lock().await;
        wm.get(&label)
            .and_then(|win_state| win_state.root_uri.clone())
            .ok_or_else(|| format!("window '{}' has no root to save into", label))?
    };
    if root_uri.scheme != "file" {
        return Err(format!(
            "saving is not supported under {} roots",
            root_uri.scheme
        ));
    }

    let resolved = ensure_within_root(&root_uri.path, &parsed_uri.path).map_err(|e| e.to_string())?;

    // Optimistic lock (requirements.md #74 契約14): before anything is copied
    // or written, the file must still be the version the editor started from.
    if expected_hash.is_some() {
        let disk = tokio::fs::read_to_string(&resolved)
            .await
            .map_err(|e| format!("{SAVE_CONFLICT_PREFIX}: {e}"))?;
        check_expected_hash(&disk, expected_hash.as_deref())?;
    }

    // Snapshot the pre-edit file before writing. With the current AI
    // integration (`ai_marks`) it goes under `<root>/.vellis/snapshots/` as
    // before, reusing the store cache and the root-relative path form the
    // annotation commands already speak. Without it (the release build) the
    // folder you opened gets nothing new (requirements.md #74 (ag)・AC-74-44):
    // the snapshot goes under the app's data directory, one store per root,
    // and `store_for` (which makes `<root>/.vellis/`) is not called. No mark
    // ids: this snapshot belongs to a manual save, not to a round of AI
    // instructions.
    let now = chrono::Utc::now();
    if features::is_enabled(features::AI_MARKS) {
        let store = super::annotation::store_for(state.inner(), &root_uri.raw)?;
        let canonical_root = store.vellis_dir().parent().ok_or_else(|| {
            format!(
                "annotation store has no parent root: {}",
                store.vellis_dir().display()
            )
        })?;
        let relative = relative_to_root(&resolved, canonical_root)?;
        SnapshotManager::new(store.vellis_dir())
            .take_snapshot(&[relative], &[], now)
            .map_err(|e| format!("could not snapshot before saving: {}", e))?;
    } else {
        let app_data = window
            .app_handle()
            .path()
            .app_data_dir()
            .map_err(|e| format!("could not snapshot before saving: no app data folder: {}", e))?;
        let canonical_root = std::fs::canonicalize(&root_uri.path)
            .map_err(|e| format!("could not snapshot before saving: {}", e))?;
        let relative = relative_to_root(&resolved, &canonical_root)?;
        let store_dir = snapshot_store_dir(&app_data, &canonical_root);
        SnapshotManager::at(&store_dir, canonical_root.clone())
            .take_snapshot(&[relative], &[], now)
            .map_err(|e| format!("could not snapshot before saving: {}", e))?;
    }

    // Write to the path the root check resolved, not the one the window
    // opened (追補d(3)): for a symlink that is its target, so the check and
    // the write judge the same file and a link re-pointed in between cannot
    // send the bytes outside the root. The write also gets the root that
    // check used: just before its rename, the provider makes sure the target
    // has not become a link and is still under that root (追補j(2)). The
    // root-aware write is `LocalProvider`'s own (the `FileProvider` fn set is
    // fixed, AC-55-18); both scheme gates above leave only `file://` here.
    let write_uri = parsed_uri.with_path(&resolved);
    LocalProvider::new()
        .write_text_within_root(&write_uri.raw, &content, &root_uri.path)
        .await
        .map_err(|e| e.to_string())?;

    if is_settings_file(&resolved) {
        announce_settings_saved(&window, &resolved);
    }
    Ok(())
}

/// The result of Save As… (requirements.md #89 契約4): the `file://` URI of
/// the file written, in the form the frontend can open as it is, and whether
/// it lies inside the root this window shows (then the window opens it in the
/// current tab; otherwise it switches the root to the file's folder first).
/// The keys are snake_case, as the frontend's `SaveAsResult` spells them.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SaveAsResult {
    pub uri: String,
    pub within_root: bool,
}

/// Write `content` to `path` for File ▸ Save As… (requirements.md #89 契約3・5・7).
///
/// Unlike `save_document` there is neither a root containment nor a save
/// check: the user picked the place in the system's save dialog (which has
/// already asked before replacing an existing file), so any folder will do
/// and an existing file is overwritten. The write itself is the same as a
/// save's — `LocalProvider::write_text`, tmp (`.<name>.vellis-tmp`) + rename,
/// bytes verbatim, no temp file left behind on a failure.
///
/// `path` must be absolute and name a file in an existing folder: a relative
/// path, a directory or a missing folder is refused before anything is
/// created (no folder is made on the way). `root` (the window's root, if any)
/// only decides `within_root`; when the file is inside it, `uri` is spelled
/// from that root so it matches the rows the Explorer lists.
pub async fn write_save_as(
    root: Option<&std::path::Path>,
    path: &std::path::Path,
    content: &str,
) -> Result<SaveAsResult, String> {
    use crate::fs::provider::FileProvider;

    if !path.is_absolute() {
        return Err(format!("Save As needs an absolute path: {}", path.display()));
    }
    if path.is_dir() {
        return Err(format!("{} is a folder, not a file", path.display()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", path.display()))?;
    if !parent.is_dir() {
        return Err(format!("the folder {} does not exist", parent.display()));
    }

    let uri = format!("file://{}", path.display());
    LocalProvider::new()
        .write_text(&uri, content)
        .await
        .map_err(|e| e.to_string())?;

    let inside = root.and_then(|root| {
        let canonical_root = std::fs::canonicalize(root).ok()?;
        let resolved = ensure_within_root(root, path).ok()?;
        let relative = resolved.strip_prefix(&canonical_root).ok()?.to_path_buf();
        Some(root.join(relative))
    });
    Ok(match inside {
        Some(spelled) => SaveAsResult {
            uri: format!("file://{}", spelled.display()),
            within_root: true,
        },
        None => SaveAsResult {
            uri,
            within_root: false,
        },
    })
}

/// File ▸ Save As… (requirements.md #89 契約3・7): write `content` to `path`
/// (the absolute path the save dialog returned) through [`write_save_as`].
///
/// No `expected_hash`: the write goes to a place the user just chose, so
/// there is no version to compare with (契約3), and choosing the current file
/// itself overwrites it (契約7). When the target already exists inside this
/// window's root, the same pre-write snapshot as `save_document` is taken
/// first, so the replaced file can be got back through the revert. A target
/// outside the root has no snapshot store and is written without one. Only
/// `file://` roots count as a root here (an `ssh://` root's path is remote).
#[tauri::command]
pub async fn save_document_as(
    path: String,
    content: String,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<SaveAsResult, String> {
    let label = window.label().to_string();
    let target = std::path::PathBuf::from(&path);
    let root_uri = {
        let wm = state.window_manager.lock().await;
        wm.get(&label)
            .and_then(|win_state| win_state.root_uri.clone())
            .filter(|root| root.scheme == "file")
    };

    if let Some(root_uri) = &root_uri {
        if target.is_file() {
            if let Ok(resolved) = ensure_within_root(&root_uri.path, &target) {
                snapshot_before_save_as(&window, state.inner(), root_uri, &resolved)?;
            }
        }
    }

    let result = write_save_as(root_uri.as_ref().map(|r| r.path.as_path()), &target, &content).await?;
    if let Ok(resolved) = std::fs::canonicalize(&target) {
        if is_settings_file(&resolved) {
            announce_settings_saved(&window, &resolved);
        }
    }
    Ok(result)
}

/// The pre-write snapshot of `save_document`, for a Save As… that replaces a
/// file inside the root (requirements.md #89): the same two stores — under
/// `<root>/.vellis/snapshots/` with the current AI integration (`ai_marks`),
/// under the app's data directory otherwise (requirements.md #74 (ag)). A
/// failure aborts the write, as it does for a save.
fn snapshot_before_save_as(
    window: &Window,
    state: &AppState,
    root_uri: &Uri,
    resolved: &std::path::Path,
) -> Result<(), String> {
    let now = chrono::Utc::now();
    if features::is_enabled(features::AI_MARKS) {
        let store = super::annotation::store_for(state, &root_uri.raw)?;
        let canonical_root = store.vellis_dir().parent().ok_or_else(|| {
            format!(
                "annotation store has no parent root: {}",
                store.vellis_dir().display()
            )
        })?;
        let relative = relative_to_root(resolved, canonical_root)?;
        SnapshotManager::new(store.vellis_dir())
            .take_snapshot(&[relative], &[], now)
            .map_err(|e| format!("could not snapshot before saving: {}", e))?;
    } else {
        let app_data = window
            .app_handle()
            .path()
            .app_data_dir()
            .map_err(|e| format!("could not snapshot before saving: no app data folder: {}", e))?;
        let canonical_root = std::fs::canonicalize(&root_uri.path)
            .map_err(|e| format!("could not snapshot before saving: {}", e))?;
        let relative = relative_to_root(resolved, &canonical_root)?;
        let store_dir = snapshot_store_dir(&app_data, &canonical_root);
        SnapshotManager::at(&store_dir, canonical_root.clone())
            .take_snapshot(&[relative], &[], now)
            .map_err(|e| format!("could not snapshot before saving: {}", e))?;
    }
    Ok(())
}

/// `resolved` as a path relative to `canonical_root` (the form
/// `SnapshotManager::take_snapshot` wants).
fn relative_to_root(resolved: &std::path::Path, canonical_root: &std::path::Path) -> Result<String, String> {
    resolved
        .strip_prefix(canonical_root)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| {
            format!(
                "{} is outside the project root {}",
                resolved.display(),
                canonical_root.display()
            )
        })
}

/// The start of the error `save_document` returns when the file on disk is no
/// longer the version the editor started from (requirements.md #74 契約14).
/// The frontend's `SAVE_CONFLICT_PREFIX` (`src/editor/file-editor.ts`) is the
/// same text.
pub const SAVE_CONFLICT_PREFIX: &str = "The file was changed on disk";

/// The same short hash as the frontend's `contentHash` (`src/lib/document-edit.ts`):
/// FNV-1a and djb2, 32 bits each, over the UTF-16 code units, joined with the
/// UTF-16 length as `{len}-{fnv}-{djb}` in lowercase base 36.
pub fn content_hash(content: &str) -> String {
    let mut fnv: u32 = 0x811c_9dc5;
    let mut djb: u32 = 5381;
    let mut len: u64 = 0;
    for unit in content.encode_utf16() {
        let code = u32::from(unit);
        fnv = (fnv ^ code).wrapping_mul(0x0100_0193);
        djb = djb.wrapping_mul(33).wrapping_add(code);
        len += 1;
    }
    format!("{}-{}-{}", base36(len), base36(u64::from(fnv)), base36(u64::from(djb)))
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base-36 digits are ASCII")
}

/// The optimistic lock of `save_document` as a pure function: `None` writes
/// as before; `Some(hash)` passes only when it is the hash of `disk`.
pub fn check_expected_hash(disk: &str, expected: Option<&str>) -> Result<(), String> {
    match expected {
        None => Ok(()),
        Some(hash) if hash == content_hash(disk) => Ok(()),
        Some(_) => Err(format!(
            "{SAVE_CONFLICT_PREFIX} since it was opened. Nothing was written."
        )),
    }
}

/// After a save of `settings.json` (requirements.md #65 契約7・8): validate the
/// file, tell every window to re-list its tree, and show the warnings once.
/// The work is `settings::announce_changed`, shared with the theme watcher,
/// which announces a save made in another app (requirements.md #84 契約8).
fn announce_settings_saved(window: &Window, path: &std::path::Path) {
    announce_changed(window.app_handle(), path);
}

async fn open_in_window(
    uri: String,
    window: Window,
    state: tauri::State<'_, AppState>,
    binary: bool,
) -> Result<DocumentPayload, String> {
    let label = window.label().to_string();
    let parsed_uri = Uri::parse(&uri).map_err(|e| e.to_string())?;
    let window_id = WindowId(label.clone());

    // 要件#71 契約1: 前の文書のセッションには先に触らない。新しい文書を開けたときだけ
    // 下で差し替える — 開けなければ前のセッション(監視の購読)がそのまま残り、
    // 表示中の文書の変更追従も続く。
    //
    // Open new session: subscribe-first, then read (binary: no read at all).
    let app_handle = window.app_handle().clone();
    let opened = if binary {
        DocumentSession::open_binary(
            window_id,
            parsed_uri.clone(),
            &state.fs_registry,
            &state.coordinator,
            &app_handle,
        )
        .await
    } else {
        DocumentSession::open(
            window_id,
            parsed_uri.clone(),
            &state.fs_registry,
            &state.coordinator,
            &app_handle,
        )
        .await
    };
    let (session, payload) = match opened {
        Ok(opened) => opened,
        Err(e) => {
            // 要件#64 契約8: 「見つからない」で開けなかったファイルは Recent Files から
            // 除く(権限・ssh の切断など一時的かもしれない失敗では除かない)。
            //
            // 開いたときのエラーの種類では判定しない: 開くのは監視の登録が先で、返るエラーは
            // どの段(監視の登録・読み取り)で落ちたかやプロバイダで形が変わる(ローカルの
            // 消えたファイルは、要件#71 追補d から監視の登録の `FsError::NotFound` として
            // 返る)。そこで失敗したときだけ同じ URI をそのプロバイダで 1 回 stat し、その
            // 失敗が「見つからない」かで決める(ローカルも ssh も同じ経路)。
            //
            // 要件#64 追補e: ssh の stat の `NotFound` は、macOS の sftp-server が返す
            // 一時的な汎用の `Failure` の写しでもありうる(`sftp_to_fs`)。そこで ssh のときは
            // 親フォルダを一覧し、一覧が取れて名前が無いときだけ除く(ローカルは stat だけ)。
            // best-effort=除去も stat・一覧の失敗もログして飲み、元のエラーをそのまま返す。
            match state.fs_registry.resolve(&parsed_uri) {
                Ok(provider) => {
                    let stat = provider.stat(&parsed_uri).await;
                    let parent_listing = if recent_files::needs_parent_listing(&parsed_uri, &stat) {
                        match parsed_uri.parent() {
                            Some(parent) => Some(provider.list(&parent).await),
                            None => None,
                        }
                    } else {
                        None
                    };
                    if recent_files::should_forget_on_open_error_with_listing(
                        &parsed_uri,
                        &stat,
                        parent_listing.as_ref(),
                    ) {
                        recent_files::forget_file(&app_handle, &uri);
                    } else if let Err(stat_err) = &stat {
                        tracing::debug!("recent files: kept '{}' (stat failed: {})", uri, stat_err);
                    }
                }
                Err(resolve_err) => {
                    tracing::debug!("recent files: kept '{}' ({})", uri, resolve_err);
                }
            }
            return Err(e.to_string());
        }
    };

    // Swap the new session in (要件#71 契約1). The session it replaces is dropped
    // after the manager lock is released — dropping it unsubscribes (RAII), and a
    // reopen of the same document settles back to a single subscription.
    let previous = {
        let mut wm = state.window_manager.lock().await;
        wm.replace_session(&label, session)
    };
    drop(previous);

    // 要件#64 契約1・2: 開けたファイルを Recent Files に記録する。開く経路(ツリー・
    // Go to・検索結果・リンク・起動時引数・新しいタブ/窓)はすべてここに集まるので、
    // 記録はこの 1 か所だけ。best-effort=記録の失敗は文書を開くのを妨げない。
    //
    // 要件#64 追補f 契約1: ここで記録するのはテキストの経路だけ。バイナリの経路の成功は
    // 「監視を張れた」でしかなく、大きすぎ・壊れている・権限なしはビューアが表示を試して
    // 初めて分かる。そこでバイナリは、ビューアが最初に表示できた時点でフロントが
    // `record_displayed_file` で記録を頼む。
    if !binary {
        recent_files::record_file(&app_handle, &uri);
    }

    Ok(payload)
}

#[cfg(test)]
mod tests {
    use crate::session::document::DocumentPayload;

    #[test]
    fn document_payload_serializes() {
        let payload = DocumentPayload {
            uri: "file:///tmp/doc.md".into(),
            content: "# Hello".into(),
            modified: Some(1700000000000),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("# Hello"));
        assert!(json.contains("modified"));
    }
}
