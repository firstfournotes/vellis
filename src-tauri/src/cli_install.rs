//! Shared logic for installing the `vellis` CLI symlink into `~/.local/bin`.
//!
//! Used by both the `--install-cli` command-line flag (see `main.rs`) and the
//! "Install 'vellis' Command in PATH" menu item (see `menu.rs`).

use std::path::PathBuf;

/// Outcome of a successful CLI install.
pub struct InstallCliResult {
    /// The location of the newly-created symlink (e.g. `~/.local/bin/vellis`).
    pub target_path: PathBuf,
    /// The binary the symlink points at (the canonicalized `current_exe()`).
    pub source_path: PathBuf,
    /// `true` when the target's parent directory is already on `PATH`.
    pub target_dir_on_path: bool,
}

/// Create a `vellis` symlink in `~/.local/bin` pointing at the currently
/// running binary.
pub fn install_cli() -> Result<InstallCliResult, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let home = std::env::var_os("HOME").ok_or("HOME not set")?;
    let target_dir = PathBuf::from(&home).join(".local").join("bin");
    let target = target_dir.join("vellis");

    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    if target.exists() || target.is_symlink() {
        std::fs::remove_file(&target).map_err(|e| e.to_string())?;
    }

    std::os::unix::fs::symlink(&exe, &target).map_err(|e| e.to_string())?;

    let path_env = std::env::var("PATH").unwrap_or_default();
    let target_dir_str = target_dir.to_string_lossy();
    let target_dir_on_path = path_env.split(':').any(|p| p == target_dir_str);

    Ok(InstallCliResult {
        target_path: target,
        source_path: exe,
        target_dir_on_path,
    })
}
