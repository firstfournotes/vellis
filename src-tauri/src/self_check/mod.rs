//! `vellis --self-check <file>` — the shipped app checks itself
//! (requirements.md #72, contract in `docs/requirements/req-72.md`).
//!
//! The app renders `<file>` through the same route as a user opening it (the
//! production frontend, the CSP, `vellis-asset://`) in a window nobody sees,
//! records what went wrong while it rendered and prints one JSON line:
//!
//! - [`RECORDER_JS`] goes in as the first initialization script, so it sees
//!   the page's first load. It only records (`window.__vellisSelfCheck`).
//! - [`REPORTER_JS`] follows it: it decides when rendering has finished
//!   (契約5) and hands the record to Rust as the Tauri event [`REPORT_EVENT`].
//! - Rust owns the clock: after [`TIMEOUT_MS`] it asks the page for what it
//!   has so far and prints it as `"status":"timeout"`.
//!
//! The launch has no side effects (契約8): [`StartupPlan::self_check`] turns
//! off the single-instance lock / IPC server, the update check, SpaceMouse,
//! window-state, the Dock icon and the visible window, and [`active_plan`]
//! lets the writers deep inside the commands (root history, Recent Files,
//! `.vellis/`) see that they must not write.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::window::manager::WindowArgs;

/// The recorder (契約4). One file, embedded as-is — the vitest acceptance
/// test evaluates the same file in jsdom.
pub const RECORDER_JS: &str = include_str!("recorder.js");

/// Completion detection and hand-over to Rust (契約5). Only injected for a
/// self-check launch, after [`RECORDER_JS`].
pub const REPORTER_JS: &str = include_str!("reporter.js");

/// Exit code when the check could not be run at all (契約7).
pub const EXIT_NOT_RUNNABLE: i32 = 6;

/// Rendering that has not finished by then is reported as `timeout` (契約5).
pub const TIMEOUT_MS: u64 = 30_000;

/// Rendering is finished once nothing new was recorded for this long (契約5).
pub const QUIET_MS: u64 = 500;

/// The Tauri event the reporter emits with `{status, snapshot}`.
pub const REPORT_EVENT: &str = "vellis-self-check:report";

/// `self_check` field of the report — bumped whenever the keys change (契約6).
pub const REPORT_FORMAT: u32 = 1;

/// How long to wait for the page's answer after asking it for a timeout
/// report, before printing a timeout with what Rust already has.
const TIMEOUT_GRACE_MS: u64 = 3_000;

/// How often the reporter looks at the page (milliseconds).
const POLL_MS: u64 = 100;

/// Resolve `<file>` to an absolute path (relative paths from the current
/// directory). A missing path or one that is not a file is an `Err` with a
/// one-line reason (契約7).
pub fn resolve_target(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("cannot read the current directory: {e}"))?
            .join(path)
    };
    let meta = std::fs::metadata(&absolute)
        .map_err(|e| format!("{}: {}", absolute.display(), e))?;
    if !meta.is_file() {
        return Err(format!("{}: not a file", absolute.display()));
    }
    Ok(absolute.canonicalize().unwrap_or(absolute))
}

/// `"done"` / `"timeout"` (契約5・6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelfCheckStatus {
    Done,
    Timeout,
}

/// One `securitypolicyviolation`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CspViolation {
    pub directive: String,
    pub blocked_uri: String,
    pub source_file: String,
    pub line: u64,
}

/// One element that failed to load.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResourceError {
    pub tag: String,
    pub attr: String,
    pub resolved: String,
}

/// One `alert` / `confirm` / `prompt` call.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DialogCall {
    pub kind: String,
    pub message: String,
}

/// `vellis-asset://` images in the body that loaded / did not.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssetImages {
    pub loaded: u64,
    pub failed: u64,
}

/// What `window.__vellisSelfCheck.snapshot()` returns (snake_case JSON).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RecorderSnapshot {
    pub csp: Vec<CspViolation>,
    pub resource_errors: Vec<ResourceError>,
    pub console_errors: Vec<String>,
    pub script_errors: Vec<String>,
    pub rejections: Vec<String>,
    pub dialogs: Vec<DialogCall>,
    pub asset_images: AssetImages,
}

/// The report printed on stdout (契約6). These 13 keys are all of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SelfCheckReport {
    pub self_check: u32,
    pub version: String,
    pub channel: String,
    pub file: String,
    pub status: SelfCheckStatus,
    pub elapsed_ms: u64,
    pub csp: Vec<CspViolation>,
    pub resource_errors: Vec<ResourceError>,
    pub console_errors: Vec<String>,
    pub script_errors: Vec<String>,
    pub rejections: Vec<String>,
    pub dialogs: Vec<DialogCall>,
    pub asset_images: AssetImages,
}

impl SelfCheckReport {
    pub fn new(
        file: &Path,
        status: SelfCheckStatus,
        elapsed_ms: u64,
        snapshot: RecorderSnapshot,
    ) -> Self {
        Self {
            self_check: REPORT_FORMAT,
            version: env!("CARGO_PKG_VERSION").to_string(),
            channel: crate::features::current_channel().as_str().to_string(),
            file: file.to_string_lossy().into_owned(),
            status,
            elapsed_ms,
            csp: snapshot.csp,
            resource_errors: snapshot.resource_errors,
            console_errors: snapshot.console_errors,
            script_errors: snapshot.script_errors,
            rejections: snapshot.rejections,
            dialogs: snapshot.dialogs,
            asset_images: snapshot.asset_images,
        }
    }
}

/// What a launch starts and writes (契約8 + 契約3/(g)). `true` = do it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupPlan {
    /// `FileLock::try_acquire`
    pub single_instance_lock: bool,
    /// `IpcServer::start` / `spawn_command_handler`
    pub ipc_server: bool,
    /// `history::record_root`
    pub root_history: bool,
    /// `recent_files::record_file` / `forget_file`
    pub recent_files: bool,
    /// `.vellis/` (marks, snapshots, inbox)
    pub vellis_dir_writes: bool,
    /// `spacemouse::start` (3DxWare / HID)
    pub spacemouse: bool,
    /// `update_check::spawn_poller`
    pub update_check: bool,
    /// `tauri_plugin_window_state` (save and restore)
    pub window_state: bool,
    /// Regular activation policy (Dock icon) rather than Accessory
    pub dock_icon: bool,
    /// The window is shown on screen
    pub visible_window: bool,
}

impl StartupPlan {
    /// The ordinary launch: everything on.
    pub fn normal() -> Self {
        Self {
            single_instance_lock: true,
            ipc_server: true,
            root_history: true,
            recent_files: true,
            vellis_dir_writes: true,
            spacemouse: true,
            update_check: true,
            window_state: true,
            dock_icon: true,
            visible_window: true,
        }
    }

    /// `--self-check`: none of it.
    pub fn self_check() -> Self {
        Self {
            single_instance_lock: false,
            ipc_server: false,
            root_history: false,
            recent_files: false,
            vellis_dir_writes: false,
            spacemouse: false,
            update_check: false,
            window_state: false,
            dock_icon: false,
            visible_window: false,
        }
    }
}

static ACTIVE_PLAN: OnceLock<StartupPlan> = OnceLock::new();

/// Fix the plan of this process. The first call wins (one launch per process).
pub(crate) fn install_plan(plan: StartupPlan) {
    let _ = ACTIVE_PLAN.set(plan);
}

/// The plan this process was launched with — [`StartupPlan::normal`] unless
/// the self-check launch installed its own. Read by the writers that live
/// inside commands (root history, Recent Files, `.vellis/`).
pub fn active_plan() -> StartupPlan {
    ACTIVE_PLAN.get().copied().unwrap_or_else(StartupPlan::normal)
}

/// Run the self-check of `file` (already resolved by [`resolve_target`]) and
/// exit the process: 0 once the report is printed, [`EXIT_NOT_RUNNABLE`]
/// when the window or WebView could not be made.
pub fn run(file: PathBuf) -> ! {
    let uri = format!("file://{}", file.display());
    let session = SelfCheckSession::new(file);
    crate::run_app(
        WindowArgs::for_open_target(&uri),
        StartupPlan::self_check(),
        Some(session.clone()),
        None,
    );
    // The event loop returned without the report having been printed.
    if !session.printed.load(Ordering::SeqCst) {
        not_runnable("the app stopped before the check finished");
    }
    std::process::exit(0)
}

/// Print the one-line reason on stderr and exit with [`EXIT_NOT_RUNNABLE`].
pub fn not_runnable(reason: &str) -> ! {
    eprintln!("vellis --self-check: {}", reason.replace('\n', " "));
    std::process::exit(EXIT_NOT_RUNNABLE)
}

/// The state of one self-check run, shared by the event listener and the
/// timeout thread.
#[derive(Clone)]
pub struct SelfCheckSession {
    file: PathBuf,
    started: Instant,
    printed: Arc<AtomicBool>,
    /// Serialises "print the report" so only one line ever goes out.
    print_lock: Arc<Mutex<()>>,
}

/// What the reporter emits.
#[derive(Debug, Deserialize)]
struct ReportPayload {
    status: SelfCheckStatus,
    snapshot: RecorderSnapshot,
}

impl SelfCheckSession {
    fn new(file: PathBuf) -> Self {
        Self {
            file,
            started: Instant::now(),
            printed: Arc::new(AtomicBool::new(false)),
            print_lock: Arc::new(Mutex::new(())),
        }
    }

    pub(crate) fn file(&self) -> &Path {
        &self.file
    }

    /// The scripts to inject, in order: recorder first, then the reporter
    /// with its settings.
    pub(crate) fn initialization_scripts() -> [String; 2] {
        let config = serde_json::json!({
            "quiet_ms": QUIET_MS,
            "poll_ms": POLL_MS,
            "event": REPORT_EVENT,
        });
        [
            RECORDER_JS.to_string(),
            format!("window.__vellisSelfCheckConfig = {config};\n{REPORTER_JS}"),
        ]
    }

    /// Print the report (once) and exit the app with 0.
    fn finish<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        status: SelfCheckStatus,
        snapshot: RecorderSnapshot,
    ) {
        use std::io::Write;

        let Ok(_guard) = self.print_lock.lock() else {
            return;
        };
        if self.printed.load(Ordering::SeqCst) {
            return;
        }
        let elapsed_ms = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let report = SelfCheckReport::new(&self.file, status, elapsed_ms, snapshot);
        let line = match serde_json::to_string(&report) {
            Ok(line) => line,
            Err(e) => not_runnable(&format!("cannot serialise the report: {e}")),
        };
        let mut out = std::io::stdout().lock();
        if writeln!(out, "{line}").and_then(|()| out.flush()).is_err() {
            std::process::exit(EXIT_NOT_RUNNABLE);
        }
        self.printed.store(true, Ordering::SeqCst);
        app.exit(0);
    }

    /// Wire the report path and the timeout. Called from `setup` once the
    /// self-check window exists.
    pub(crate) fn start<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) {
        use tauri::{Listener, Manager};

        let on_report = self.clone();
        let app_for_report = app.clone();
        app.listen_any(REPORT_EVENT, move |event| {
            match serde_json::from_str::<ReportPayload>(event.payload()) {
                Ok(payload) => on_report.finish(&app_for_report, payload.status, payload.snapshot),
                Err(e) => tracing::warn!("self-check: unreadable report from the page: {e}"),
            }
        });

        let on_timeout = self.clone();
        let app_for_timeout = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(TIMEOUT_MS));
            if on_timeout.printed.load(Ordering::SeqCst) {
                return;
            }
            // Ask the page for what it has recorded so far …
            if let Some(window) = app_for_timeout.get_webview_window(SELF_CHECK_WINDOW_LABEL) {
                let _ = window.eval(
                    "window.__vellisSelfCheckReport && window.__vellisSelfCheckReport('timeout')",
                );
            }
            std::thread::sleep(Duration::from_millis(TIMEOUT_GRACE_MS));
            // … and when the page cannot answer, report the timeout with nothing recorded.
            on_timeout.finish(
                &app_for_timeout,
                SelfCheckStatus::Timeout,
                RecorderSnapshot::default(),
            );
        });
    }
}

/// The self-check renders in the window the config would have created —
/// same label, so the capability and the `WindowManager` entry are the
/// ordinary ones.
pub(crate) const SELF_CHECK_WINDOW_LABEL: &str = "main";

/// Build the self-check window from the config's window: the same page,
/// size and capability as the window a user gets, plus the recorder and the
/// reporter as initialization scripts — and never put on screen (契約3・(g)).
///
/// The window stays ordered out (`visible: false`): it never appears in the
/// window list, takes no clicks and no focus. WKWebView keeps loading,
/// laying out and running the page in it (the page reports
/// `visibilityState: "hidden"`), and images and Mermaid complete. What a
/// hidden page does lose is its pace: after a while WebKit throttles its
/// timers and IPC, which would leave the 30-second timeout unanswered — so
/// the self-check window turns background throttling off
/// (`WKPreferences.inactiveSchedulingPolicy = none`, macOS 14+).
pub(crate) fn build_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    config: &tauri::utils::config::WindowConfig,
    plan: &StartupPlan,
) -> tauri::Result<()> {
    let mut config = config.clone();
    config.label = SELF_CHECK_WINDOW_LABEL.to_string();
    config.visible = plan.visible_window;
    config.focus = plan.visible_window;
    config.background_throttling = Some(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    for script in SelfCheckSession::initialization_scripts() {
        builder = builder.initialization_script(script);
    }
    builder.build()?;
    // The launch ran as Prohibited so it could not take the focus (lib.rs);
    // from here on the app is an Accessory one: still no Dock icon.
    #[cfg(target_os = "macos")]
    if !plan.dock_icon {
        app.set_activation_policy(tauri::ActivationPolicy::Accessory)?;
    }
    Ok(())
}
