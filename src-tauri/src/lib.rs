pub mod annotation;
pub mod audio_extract;
pub mod channel;
pub mod cli;
pub mod features;
pub mod cli_fix;
pub mod cli_install;
pub mod commands;
pub mod errors;
pub mod exclude;
pub mod fs;
pub mod history;
pub mod ipc;
pub mod menu;
pub mod print;
pub mod recent_files;
pub mod search;
pub mod self_check;
pub mod session;
pub mod settings;
pub mod spacemouse;
pub mod update_check;
pub mod video_frames;
pub mod wav_waveform;
pub mod watch;
pub mod window;

/// Window title derivation, also reachable as `vellis_lib::window_title`
/// (requirements.md #17).
pub use window::title as window_title;

use std::sync::Arc;

use tauri::{Listener, Manager};
use tokio::sync::Mutex;
use tracing;

use commands::annotation::{
    add_mark, diff_against_snapshot, generate_inbox, list_marks, list_snapshots,
    rebind_marks_for_file, remove_mark, revert_to_snapshot, update_mark,
};
use commands::app::init_window;
use commands::asset::handle_asset;
use commands::build_info::get_build_info;
use commands::dir_watch::{subscribe_dir, unsubscribe_dir};
use commands::document::{open_binary_document, open_document, save_document};
use commands::history::list_history;
use commands::list::list_dir;
use commands::print::{print_current_window, print_html, print_pdf, set_print_available};
use commands::recent_files::{clear_recent_files, list_recent_files};
use commands::root::set_root;
use commands::search::{search_in_folder, search_in_folder_page, search_in_folder_reset, SearchResults};
use commands::video::get_video_frame_index;
use commands::wav_waveform::analyze_wav_waveform;
use commands::waveform::extract_waveform_audio;
use commands::window::{new_tab, new_window, set_tab_title};
use commands::AppState;
use fs::registry::FileProviderRegistry;
use ipc::handler::spawn_command_handler;
use ipc::lock::FileLock;
use ipc::server::{default_lock_path, default_socket_path, IpcServer};
use print::{handle_print_protocol, PrintAvailability, PrintDocumentStore, PRINT_SCHEME};
use self_check::{SelfCheckSession, StartupPlan};
use watch::hub::DocumentCoordinator;
use window::manager::{WindowArgs, WindowManager};
use window::open_with::PendingOpens;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with_args(WindowArgs::default())
}

/// Start the Tauri app with initial arguments for the first window.
pub fn run_with_args(initial_args: WindowArgs) {
    run_app(initial_args, StartupPlan::normal(), None, None)
}

/// Start the Tauri app as the Main Process, keeping `lock` — the
/// single-instance lock the CLI took before starting Tauri
/// ([`ipc::launch::launch`]) — for the app's whole life (要件#3 追補b 契約1).
/// `setup` does not take the lock again.
pub fn run_as_main(initial_args: WindowArgs, lock: FileLock) {
    run_app(initial_args, StartupPlan::normal(), None, Some(lock))
}

/// Start the Tauri app following `plan` (requirements.md #72 契約8).
///
/// The ordinary launch passes [`StartupPlan::normal`] and no self-check
/// session; `vellis --self-check` ([`self_check::run`]) passes
/// [`StartupPlan::self_check`] and its session, and then the window the
/// config would create is replaced by one nobody sees, carrying the
/// recorder as its first initialization script.
///
/// `main_lock` is the single-instance lock already taken by the CLI
/// ([`run_as_main`]); with `None`, `setup` tries to take it itself.
pub(crate) fn run_app(
    initial_args: WindowArgs,
    plan: StartupPlan,
    self_check_session: Option<SelfCheckSession>,
    main_lock: Option<FileLock>,
) {
    // The writers deep inside the commands (root history, Recent Files,
    // `.vellis/`) read the plan from here.
    self_check::install_plan(plan);

    // Initialise the tracing subscriber so `tracing::warn!` / `info!` /
    // `error!` calls actually surface on stderr. Default filter level is
    // `warn` so users only see security-relevant events (known_hosts
    // mismatch, TOFU first-time persistence, etc.) without info/debug
    // noise; set `RUST_LOG=info` (or finer) for diagnostics. `try_init`
    // is used so re-entrant calls (tests, embedded scenarios) do not
    // panic on a duplicate init.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr)
        .try_init();

    let registry = Arc::new(FileProviderRegistry::new());
    let coordinator = Arc::new(DocumentCoordinator::new(Arc::clone(&registry)));
    let window_manager = Arc::new(Mutex::new(WindowManager::new()));

    let app_state = AppState {
        fs_registry: registry,
        coordinator,
        window_manager: window_manager.clone(),
        annotation_stores: Arc::new(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )),
    };

    // Base builder. The `webdriver` feature pulls in
    // `tauri-plugin-webdriver`, which embeds a W3C WebDriver server in
    // the running app so external clients can drive the Webview during
    // E2E tests. The `debug_assertions` gate is a defence-in-depth: even
    // if someone passes `--release --features webdriver` the plugin is
    // not registered.  See `docs/implementation.md` §10 (E2E).
    // Labels of the windows built as tabs (requirements.md #62 追補a). The
    // window-state plugin's filter reads the set and `new_tab` writes to it
    // through managed state, so both hold the same `Arc`.
    let tab_window_labels = window::tab::TabWindowLabels::default();
    let tab_labels_for_filter = tab_window_labels.clone();

    let builder = tauri::Builder::default()
        .manage(app_state)
        .manage(tab_window_labels)
        // フォルダ横断検索の結果の保持(要件#55 追補a・窓ラベル×世代)。
        .manage(SearchResults::default())
        // 印刷文書のストア(要件#38)は AppState とは別に管理する。protocol
        // ハンドラとコマンドの2箇所からしか触らないうえ、窓・監視・注釈と違って
        // アプリの状態ではなく「いま印刷しようとしている1文書」の置き場なので。
        .manage(PrintDocumentStore::new())
        // 窓ごとの「印刷できる文書を開いているか」(要件#38 追補f)。
        // set_print_available が書き、窓の前面化と破棄が読む・捨てる。
        .manage(PrintAvailability::new())
        // Finder の Open With で渡されたファイル(要件#68)。起動の途中では
        // `setup` より前に届くので、Builder の段階で置き場を用意しておく。
        .manage(PendingOpens::default());

    #[cfg(all(feature = "webdriver", debug_assertions))]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    // A tab is neither restored nor saved: restoring would move it — and
    // its whole tab group — to where a window of the same label sat in an
    // earlier launch (requirements.md #62 追補a). The self-check launch does
    // without the plugin altogether: it neither restores nor saves (要件#72 契約8).
    let builder = if plan.window_state {
        builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(move |label| !tab_labels_for_filter.contains(label))
                .build(),
        )
    } else {
        builder
    };

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // --- SpaceMouse focus tracking (要件#25) ---
        // The 3Dconnexion driver deactivates our client as soon as another
        // application comes to the front, so coming back needs an explicit
        // re-activation — without this the device goes dead after the first
        // focus round trip. Deactivating on blur is also what lets other 3D
        // apps keep using the device while Vellis is running (backlog #58).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                if let Some(spacemouse) = window
                    .app_handle()
                    .try_state::<spacemouse::SpaceMouseHandle>()
                {
                    spacemouse.set_window_focus(window.label(), *focused);
                }
                // File > Print… follows the frontmost window: greyed out on the
                // history picker and the empty state (要件#38 追補f).
                if *focused {
                    menu::sync_print_item(window.app_handle(), window.label());
                }
            }
            // A closed window's folder-search results are dropped (要件#55 追補a).
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(results) = window.app_handle().try_state::<SearchResults>() {
                    results.0.lock().map(|mut store| store.forget(window.label())).ok();
                }
                // ...and so is what it reported about printing (要件#38 追補f).
                if let Some(print) = window.app_handle().try_state::<PrintAvailability>() {
                    print.forget(window.label());
                }
            }
        })
        .register_asynchronous_uri_scheme_protocol(
            "vellis-asset",
            move |ctx, req, responder| {
                let state = ctx.app_handle().state::<AppState>();
                let state_ref = state.inner().clone();
                tauri::async_runtime::spawn(async move {
                    let response = handle_asset(&state_ref, req).await;
                    responder.respond(response);
                });
            },
        )
        // 印刷窓が読む one-shot 文書(要件#38)。読み出しはメモリ上の
        // HashMap から1件取り出すだけなので同期ハンドラで足りる。
        .register_uri_scheme_protocol(PRINT_SCHEME, |ctx, req| {
            let store = ctx.app_handle().state::<PrintDocumentStore>();
            handle_print_protocol(&store, &req.uri().to_string())
        });

    // `invoke_handler` can only be called once per Builder — so the
    // `webdriver`-only test helpers (issue #22) need to be inlined into
    // the same list. The `cfg`-gated branches duplicate the production
    // command list to keep the test surface out of release builds. If
    // you add a new production command, update **both** branches.
    #[cfg(feature = "webdriver")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        init_window,
        open_document,
        open_binary_document,
        save_document,
        set_root,
        new_window,
        new_tab,
        set_tab_title,
        search_in_folder,
        search_in_folder_page,
        search_in_folder_reset,
        list_dir,
        subscribe_dir,
        unsubscribe_dir,
        add_mark,
        list_marks,
        update_mark,
        remove_mark,
        generate_inbox,
        rebind_marks_for_file,
        list_snapshots,
        diff_against_snapshot,
        revert_to_snapshot,
        get_build_info,
        list_history,
        list_recent_files,
        clear_recent_files,
        get_video_frame_index,
        extract_waveform_audio,
        analyze_wav_waveform,
        print_current_window,
        print_html,
        set_print_available,
        print_pdf,
        commands::test_helpers::__test_list_windows,
    ]);
    #[cfg(not(feature = "webdriver"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        init_window,
        open_document,
        open_binary_document,
        save_document,
        set_root,
        new_window,
        new_tab,
        set_tab_title,
        search_in_folder,
        search_in_folder_page,
        search_in_folder_reset,
        list_dir,
        subscribe_dir,
        unsubscribe_dir,
        add_mark,
        list_marks,
        update_mark,
        remove_mark,
        generate_inbox,
        rebind_marks_for_file,
        list_snapshots,
        diff_against_snapshot,
        revert_to_snapshot,
        get_build_info,
        list_history,
        list_recent_files,
        clear_recent_files,
        get_video_frame_index,
        extract_waveform_audio,
        analyze_wav_waveform,
        print_current_window,
        print_html,
        set_print_available,
        print_pdf,
    ]);

    // `vellis --self-check` builds its own window in `setup` (below), so the
    // one the config describes is not created; its settings are the
    // starting point of the self-check window.
    let mut context = tauri::generate_context!();
    let self_check_window = if self_check_session.is_some() {
        let windows = &mut context.config_mut().app.windows;
        let first = windows.first().cloned();
        for window in windows.iter_mut() {
            window.create = false;
        }
        first
    } else {
        None
    };
    let is_self_check = self_check_session.is_some();

    let built = builder
        .setup(move |app| {
            // --- Native menu bar ---
            let menu = menu::build(app.handle())?;
            #[cfg(target_os = "macos")]
            let window_menu_owner = menu.clone();
            app.set_menu(menu)?;
            // Ordering matters: only after `set_menu` has run muda's
            // `init_for_nsapp` may the Window submenu be handed to NSApp
            // (requirements.md #17).
            #[cfg(target_os = "macos")]
            menu::attach_windows_menu_to_nsapp(&window_menu_owner);
            app.on_menu_event(|app_handle, event| match event.id().as_ref() {
                id if id == menu::CHECK_FOR_UPDATES_ITEM_ID => {
                    menu::handle_check_for_updates_click(app_handle);
                }
                id if id == menu::INSTALL_CLI_ITEM_ID => {
                    menu::handle_install_cli_click(app_handle);
                }
                id if id == menu::TOGGLE_DEVTOOLS_ITEM_ID => {
                    menu::handle_toggle_devtools_click(app_handle);
                }
                id if id == menu::PRINT_ITEM_ID => {
                    menu::handle_print_click(app_handle);
                }
                id if id == menu::NEW_WINDOW_ITEM_ID => {
                    menu::handle_new_window_click(app_handle);
                }
                id if id == menu::NEW_TAB_ITEM_ID => {
                    // 新しいタブの root と展開は窓の側にしかないので、Duplicate
                    // Window と同じくフォーカス中の窓へ投げて任せる(要件#62 契約3)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_NEW_TAB_EVENT);
                }
                id if id == menu::PREVIOUS_TAB_ITEM_ID => {
                    // どのタブが隣かは AppKit が知っている。前面の NSWindow に
                    // selectPreviousTab: を送るだけ(要件#62 契約7)。
                    menu::handle_select_tab_click(
                        app_handle,
                        window::tab::TabDirection::Previous,
                    );
                }
                id if id == menu::NEXT_TAB_ITEM_ID => {
                    menu::handle_select_tab_click(app_handle, window::tab::TabDirection::Next);
                }
                id if id == menu::SHOW_TAB_BAR_ITEM_ID => {
                    // AppKit's own tab items, which it never adds to a menu
                    // built in code (requirements.md #62 追補b).
                    menu::handle_tab_menu_click(app_handle, window::tab::TabMenuAction::ShowTabBar);
                }
                id if id == menu::SHOW_ALL_TABS_ITEM_ID => {
                    menu::handle_tab_menu_click(
                        app_handle,
                        window::tab::TabMenuAction::ShowAllTabs,
                    );
                }
                id if id == menu::MOVE_TAB_TO_NEW_WINDOW_ITEM_ID => {
                    menu::handle_tab_menu_click(
                        app_handle,
                        window::tab::TabMenuAction::MoveTabToNewWindow,
                    );
                }
                id if id == menu::MERGE_ALL_WINDOWS_ITEM_ID => {
                    menu::handle_tab_menu_click(
                        app_handle,
                        window::tab::TabMenuAction::MergeAllWindows,
                    );
                }
                id if id == menu::DUPLICATE_WINDOW_ITEM_ID => {
                    // 複製の中身(root・文書・展開)は窓しか知らないので、
                    // Open 系と同じくフォーカス中の窓へ投げて任せる(要件#34)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_DUPLICATE_WINDOW_EVENT);
                }
                id if id == menu::ZOOM_IN_ITEM_ID => {
                    // 倍率も対象ビューアの判定もフロント側にしかないので、
                    // Open 系と同じくフォーカス中の窓へ投げて任せる(要件#36)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_ZOOM_IN_EVENT);
                }
                id if id == menu::ZOOM_OUT_ITEM_ID => {
                    menu::handle_menu_open_click(app_handle, menu::MENU_ZOOM_OUT_EVENT);
                }
                id if id == menu::ACTUAL_SIZE_ITEM_ID => {
                    menu::handle_menu_open_click(app_handle, menu::MENU_ZOOM_RESET_EVENT);
                }
                id if id == menu::OPEN_FILE_ITEM_ID => {
                    menu::handle_menu_open_click(app_handle, menu::MENU_OPEN_FILE_EVENT);
                }
                id if id == menu::OPEN_FOLDER_ITEM_ID => {
                    menu::handle_menu_open_click(app_handle, menu::MENU_OPEN_FOLDER_EVENT);
                }
                id if id == menu::GO_TO_ITEM_ID => {
                    // 今の root も展開も、打たれたパスの解決も窓の側にしかないので、
                    // Open 系と同じくフォーカス中の窓へ投げて任せる(要件#60 契約①)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_GO_TO_EVENT);
                }
                id if id == menu::RECENT_FILES_ITEM_ID => {
                    // 区画は窓の Explorer の下にあり、出せるか(root・履歴選択画面)も
                    // どの行へフォーカスするかも窓の側にしかないので、Go to Path… と
                    // 同じくフォーカス中の窓へ投げて任せる(要件#64 契約5)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_RECENT_FILES_EVENT);
                }
                id if id == menu::EDIT_ITEM_ID => {
                    // 編集に入れる文書かも、いま編集中かも窓の側にしかないので、
                    // Open 系と同じくフォーカス中の窓へ投げて任せる(要件#48 追補b)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_EDIT_EVENT);
                }
                id if id == menu::FIND_ITEM_ID => {
                    // 何が表示されていて探せる文字があるかは窓の側にしかないので、
                    // Open 系と同じくフォーカス中の窓へ投げて任せる(要件#54 契約①)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_FIND_EVENT);
                }
                id if id == menu::FIND_IN_FOLDER_ITEM_ID => {
                    // 開いている root も検索パネルも窓の側にしかないので、Find… と
                    // 同じくフォーカス中の窓へ投げて任せる(要件#55 契約①)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_FIND_IN_FOLDER_EVENT);
                }
                id if id == menu::SAVE_ITEM_ID => {
                    // 編集中かどうかも保存する中身も窓の側にしかないので、
                    // Open 系と同じくフォーカス中の窓へ投げて任せる(要件#48)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_SAVE_EVENT);
                }
                id if id == menu::SETTINGS_ITEM_ID => {
                    // 設定ファイルの置き場も既定値も Rust が知っているので、窓へは投げず
                    // Rust の中で「無ければ書き出して新しい窓で開く」まで済ませる(要件#65 契約6)。
                    menu::handle_settings_click(app_handle);
                }
                _ => {}
            });

            // --- IPC Server: single-instance lock + socket server ---
            // Not for `--self-check` (要件#72 契約2・8): it must leave a running
            // Vellis — and the next one to start — exactly as they are.
            let lock_path = default_lock_path();
            // The lock and the server go together: the lock is what makes this
            // process the one that answers on the socket.
            let single_instance = plan.single_instance_lock && plan.ipc_server;
            // `vellis` from the CLI took the lock before starting Tauri
            // (要件#3 追補b 契約1) and it is kept as is — never taken again.
            let lock = match (single_instance, main_lock) {
                (true, Some(lock)) => Ok(Some(lock)),
                (true, None) => FileLock::try_acquire(&lock_path),
                (false, _) => Ok(None),
            };
            match lock {
                Ok(Some(lock)) => {
                    // We are the Main Process. Start the IPC server.
                    let socket_path = default_socket_path();
                    let app_handle_for_ipc = app.handle().clone();
                    let ipc_result = tauri::async_runtime::block_on(async move {
                        let (server, cmd_rx) = IpcServer::start(&socket_path)?;
                        spawn_command_handler(app_handle_for_ipc, cmd_rx);
                        Ok::<_, std::io::Error>((server, socket_path))
                    });
                    match ipc_result {
                        Ok((server, socket_path)) => {
                            // Keep the lock and server alive for the app lifetime
                            // by storing them in a managed state.
                            app.manage(IpcResources {
                                _lock: lock,
                                _server: server,
                            });

                            tracing::info!(
                                "IPC server started on {}",
                                socket_path.display()
                            );
                        }
                        Err(e) => {
                            tracing::error!("Failed to start IPC server: {}", e);
                            // Continue without IPC — the app still works as a
                            // standalone window.
                        }
                    }
                }
                Ok(None) if !single_instance => {}
                Ok(None) => {
                    // Another instance holds the lock. Only reachable when the
                    // app was started through `run` / `run_with_args` directly:
                    // the `vellis` binary (main.rs) takes the lock before Tauri
                    // starts (`ipc::launch`, 要件#3 追補b) and hands it in via
                    // `run_as_main`. Here we just log and continue.
                    tracing::warn!(
                        "Another Vellis instance holds the lock at {}",
                        lock_path.display()
                    );
                }
                Err(e) => {
                    // The lock file cannot be opened. The `vellis` binary has
                    // already warned on stderr and started us alone through
                    // `run_with_args` (要件#3 追補b 契約7): continue without the
                    // lock and without the IPC server.
                    tracing::warn!(
                        "Cannot take the single-instance lock at {}: {}; running without it (no IPC server)",
                        lock_path.display(),
                        e
                    );
                }
            }

            // --- Update notification (要件#14) ---
            // One task for the whole process (single instance = one Rust
            // process behind every window). It is a no-op on the dev
            // channel, and every failure inside it is a log line only.
            if plan.update_check {
                update_check::spawn_poller(app.handle().clone());
            }

            // --- SpaceMouse (要件#24 / #25) ---
            // One input source for the process; it emits `spacemouse_input`
            // to every window and the 3D viewer picks it up while it is on
            // screen. The source is decided once here: the 3DconnexionClient
            // framework when 3DxWare is installed (it seizes the device, so
            // raw HID reads nothing), otherwise the raw HID reader. No device
            // (the common case) is not an error. The handle is kept in
            // managed state so dropping it on shutdown stops the reader
            // thread / unregisters the SDK client.
            //
            // A `webdriver` build never starts an input source (backlog 190 /
            // 要件#25 追補b): the app under test would register with 3DxWare as
            // "Vellis" in take-over mode (or read the raw HID device), and a
            // force-quit leaves that registration behind, so the user's own
            // Vellis stops receiving the device. The verification app must not
            // seize the user's real hardware. It still manages the disabled
            // handle, so the focus handler above finds the state and does
            // nothing. Gated on the feature alone (no `debug_assertions`).
            //
            // `--self-check` never registers either (要件#72 契約8).
            if plan.spacemouse {
                #[cfg(not(feature = "webdriver"))]
                app.manage(spacemouse::start(app.handle().clone()));
                #[cfg(feature = "webdriver")]
                app.manage(spacemouse::SpaceMouseHandle::Disabled);
            } else {
                app.manage(spacemouse::SpaceMouseHandle::Disabled);
            }

            if let Some(session) = self_check_session.as_ref() {
                // `--self-check` (要件#72): register the window first, then
                // build it — hidden, with the recorder — and wire the report.
                tauri::async_runtime::block_on(async {
                    let mut wm = window_manager.lock().await;
                    wm.register_window(
                        self_check::SELF_CHECK_WINDOW_LABEL.into(),
                        initial_args.clone(),
                    );
                });
                let Some(config) = self_check_window.as_ref() else {
                    self_check::not_runnable("tauri.conf.json describes no window");
                };
                if let Err(e) = self_check::build_window(app.handle(), config, &plan) {
                    self_check::not_runnable(&format!(
                        "cannot create the window for {}: {e}",
                        session.file().display()
                    ));
                }
                session.start(app.handle());
            } else {
                // Register the default window created by tauri.conf.json with the
                // CLI-derived initial arguments. Files Finder's Open With handed
                // over before this point (要件#68) go to it when it has nothing
                // to show, and to new windows otherwise.
                let opened = app.state::<PendingOpens>().take_at_setup();
                let (initial_args_clone, to_new_windows) =
                    window::open_with::plan_initial_open(initial_args.clone(), opened);
                let wm_clone = window_manager.clone();
                tauri::async_runtime::spawn(async move {
                    let mut wm = wm_clone.lock().await;
                    wm.register_window("main".into(), initial_args_clone);
                });
                open_in_new_windows(app.handle(), to_new_windows);
            }

            // Hook into window creation events for tracking.
            let wm_for_events = app.state::<AppState>().window_manager.clone();
            app.listen("tauri://window-created", move |_event| {
                // New windows created via `new_window` command are already
                // registered in WindowManager before the window is built,
                // so this hook is a no-op for now.
                let _ = &wm_for_events;
            });

            // Hook into window destroy events to unregister and potentially exit.
            let wm_for_destroy = app.state::<AppState>().window_manager.clone();
            let app_handle_for_destroy = app.handle().clone();
            app.listen("tauri://destroyed", move |event| {
                let wm = wm_for_destroy.clone();
                let app_handle = app_handle_for_destroy.clone();
                // Extract window label from the event payload if possible.
                // The event payload for window destruction contains the label.
                if let Some(label) = extract_window_label_from_event(&event) {
                    tauri::async_runtime::spawn(async move {
                        let mut manager = wm.lock().await;
                        manager.unregister_window(&label);
                        tracing::debug!(
                            "Window '{}' destroyed, {} remaining",
                            label,
                            manager.window_count()
                        );
                        // Exit the application when all windows are closed.
                        if manager.window_count() == 0 {
                            tracing::info!("All windows closed — exiting");
                            app_handle.exit(0);
                        }
                    });
                }
            });

            Ok(())
        })
        .build(context);

    if is_self_check {
        let mut app = match built {
            Ok(app) => app,
            Err(e) => self_check::not_runnable(&format!("cannot start the app: {e}")),
        };
        // No Dock icon and no focus taken (要件#72 契約3・(g)). The event loop
        // activates the app as it finishes launching, which would pull the
        // keyboard focus away from whatever the user is typing into — so the
        // launch happens as Prohibited (cannot be activated, no Dock icon) and
        // `setup` turns it into Accessory (no Dock icon) once that is past.
        #[cfg(target_os = "macos")]
        if !plan.dock_icon {
            app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
        }
        app.run(|_, _| {});
    } else {
        built
            .expect("error while running tauri application")
            .run(|app_handle, event| {
                // Finder's Open With, a drop on the Dock icon, `open -a`
                // (要件#68). Before `setup` the files are kept for the initial
                // window; after it each one opens in a new window.
                #[cfg(target_os = "macos")]
                if let tauri::RunEvent::Opened { urls } = event {
                    let uris = window::open_with::opened_file_uris(&urls);
                    let to_open = app_handle.state::<PendingOpens>().receive(uris);
                    open_in_new_windows(app_handle, to_open);
                }
                #[cfg(not(target_os = "macos"))]
                let _ = (app_handle, event);
            });
    }
}

/// Open each URI in a new window, in order, the way `vellis <path>` does
/// against a running Vellis (要件#68 契約4・5): one task awaits the CLI's
/// `OpenPath` for each, so the windows appear in the order the files came.
fn open_in_new_windows(app: &tauri::AppHandle, uris: Vec<String>) {
    if uris.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for uri in uris {
            let request = ipc::protocol::Request::OpenPath {
                uri,
                new_window: true,
            };
            ipc::handler::dispatch_command(&app, request).await;
        }
    });
}

/// Resources kept alive for the lifetime of the application.
///
/// Dropping `IpcResources` releases the file lock and stops the IPC server.
struct IpcResources {
    _lock: FileLock,
    _server: IpcServer,
}

/// Attempt to extract a window label from a Tauri event.
fn extract_window_label_from_event(event: &tauri::Event) -> Option<String> {
    // Tauri 2.x event payloads for window events contain the window label
    // as a JSON string in the payload.
    let payload = event.payload();
    serde_json::from_str::<String>(payload).ok()
}
