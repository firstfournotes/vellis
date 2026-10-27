//! Shared logic for installing the `vellis` CLI symlink into `~/.local/bin`.
//!
//! Used by both the `--install-cli` command-line flag (see `main.rs`) and the
//! "Install 'vellis' Command in PATH" menu item (see `menu.rs`).

use std::path::{Path, PathBuf};

/// Outcome of a successful CLI install.
pub struct InstallCliResult {
    /// The location of the newly-created symlink (e.g. `~/.local/bin/vellis`).
    pub target_path: PathBuf,
    /// The binary the symlink points at (the canonicalized `current_exe()`).
    pub source_path: PathBuf,
    /// `true` when the target's parent directory is already on `PATH`.
    pub target_dir_on_path: bool,
}

/// Error returned when the app runs from a macOS App Translocation location.
const TRANSLOCATED_ERROR: &str = "Vellis is running from a temporary location (macOS App Translocation), so the vellis command was not installed.\nMove Vellis.app to the Applications folder, then launch it from there and try again.";

/// `true` when `path` lies under a macOS App Translocation directory, i.e. a
/// temporary, read-only location that disappears once the app quits.
pub fn is_translocated(path: &Path) -> bool {
    path.to_string_lossy().contains("/AppTranslocation/")
}

/// Error returned when the app runs from a read-only volume (e.g. the DMG).
const READ_ONLY_VOLUME_ERROR: &str = "Vellis is running from a read-only volume (such as the disk image), so the vellis command was not installed.\nMove Vellis.app to the Applications folder, then launch it from there and try again.";

/// `true` when `path` lies on a read-only mount (`MNT_RDONLY`), such as a
/// mounted disk image. `false` when `statfs` fails (e.g. the path is missing).
#[cfg(target_os = "macos")]
pub fn is_on_read_only_volume(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `c_path` is a valid NUL-terminated path and `stat` is a valid
    // out-pointer for the whole call.
    if unsafe { libc::statfs(c_path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return false;
    }
    // SAFETY: `statfs` returned 0, so it filled in `stat`.
    let stat = unsafe { stat.assume_init() };
    stat.f_flags & libc::MNT_RDONLY as u32 != 0
}

/// `true` when `path` lies on a read-only mount (`ST_RDONLY`, via POSIX
/// `statvfs`). `false` when `statvfs` fails (e.g. the path is missing).
#[cfg(not(target_os = "macos"))]
pub fn is_on_read_only_volume(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `c_path` is a valid NUL-terminated path and `stat` is a valid
    // out-pointer for the whole call.
    if unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return false;
    }
    // SAFETY: `statvfs` returned 0, so it filled in `stat`.
    let stat = unsafe { stat.assume_init() };
    stat.f_flag & libc::ST_RDONLY != 0
}

/// Create a `vellis` symlink in `~/.local/bin` pointing at the currently
/// running binary.
pub fn install_cli() -> Result<InstallCliResult, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let home = std::env::var_os("HOME").ok_or("HOME not set")?;
    let path_env = std::env::var("PATH").unwrap_or_default();
    install_cli_for(&exe, Path::new(&home), &path_env)
}

/// Create a `vellis` symlink in `home/.local/bin` pointing at `exe`, judging
/// whether that directory is on `path_env`. Refuses (writing nothing) when
/// `exe` is in an App Translocation location or on a read-only volume, since
/// the link would break.
pub fn install_cli_for(
    exe: &Path,
    home: &Path,
    path_env: &str,
) -> Result<InstallCliResult, String> {
    if is_translocated(exe) {
        return Err(TRANSLOCATED_ERROR.to_string());
    }
    if is_on_read_only_volume(exe) {
        return Err(READ_ONLY_VOLUME_ERROR.to_string());
    }

    let target_dir = home.join(".local").join("bin");
    let target = target_dir.join("vellis");

    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    if target.exists() || target.is_symlink() {
        std::fs::remove_file(&target).map_err(|e| e.to_string())?;
    }

    std::os::unix::fs::symlink(exe, &target).map_err(|e| e.to_string())?;

    let target_dir_str = target_dir.to_string_lossy();
    let target_dir_on_path = path_env.split(':').any(|p| p == target_dir_str);

    Ok(InstallCliResult {
        target_path: target,
        source_path: exe.to_path_buf(),
        target_dir_on_path,
    })
}
