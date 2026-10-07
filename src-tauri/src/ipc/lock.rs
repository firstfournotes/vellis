//! File lock for single-instance enforcement.
//!
//! Only the Main Process acquires the lock. CLI processes never touch it.

use std::fs::{File, OpenOptions};
use std::os::unix::fs::MetadataExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

/// How many times `try_acquire_opened` reopens the path when the locked file
/// is no longer the one at the path (追補c 契約2). Past this, another holder
/// is assumed.
const MAX_REOPEN_ATTEMPTS: usize = 8;

/// An exclusive file lock using `flock(2)`.
///
/// The lock is released automatically when this value is dropped (file closed).
pub struct FileLock {
    _file: File,
    path: PathBuf,
}

impl FileLock {
    /// Try to acquire an exclusive lock on the given path.
    ///
    /// Returns `Ok(Some(lock))` if the lock was acquired, `Ok(None)` if
    /// another process holds the lock, or `Err` on I/O failure.
    pub fn try_acquire(path: &Path) -> Result<Option<Self>, std::io::Error> {
        Self::try_acquire_opened(path, open_lock_file(path)?)
    }

    /// Try to acquire the lock at `path` starting from an already opened
    /// `file` (追補c 契約2).
    ///
    /// The lock counts only if the locked file is the one now at `path`
    /// (same device and inode). A holder's `Drop` removes the file before
    /// closing it, so `file` may refer to a removed file; then the lock on it
    /// is released without touching `path` and `path` is reopened.
    pub fn try_acquire_opened(path: &Path, file: File) -> Result<Option<Self>, std::io::Error> {
        let mut file = file;
        let mut reopened = 0;
        loop {
            if !flock_exclusive_nonblocking(&file)? {
                // Another holder has the lock.
                return Ok(None);
            }
            if is_file_at_path(&file, path)? {
                return Ok(Some(FileLock {
                    _file: file,
                    path: path.to_path_buf(),
                }));
            }
            // Locked a file that is no longer at the path. Close it (releasing
            // the lock) without removing anything: the file at the path, if
            // any, belongs to someone else.
            drop(file);
            if reopened == MAX_REOPEN_ATTEMPTS {
                return Ok(None);
            }
            reopened += 1;
            file = open_lock_file(path)?;
        }
    }
}

fn open_lock_file(path: &Path) -> Result<File, std::io::Error> {
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(path)
}

/// `flock(LOCK_EX | LOCK_NB)`: `Ok(true)` if taken, `Ok(false)` if another
/// holder has it.
fn flock_exclusive_nonblocking(file: &File) -> Result<bool, std::io::Error> {
    let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if ret == -1 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
            return Ok(false);
        }
        return Err(err);
    }
    Ok(true)
}

/// Whether `file` is the file now at `path` (same device and inode).
fn is_file_at_path(file: &File, path: &Path) -> Result<bool, std::io::Error> {
    let opened = file.metadata()?;
    match std::fs::metadata(path) {
        Ok(at_path) => Ok(opened.dev() == at_path.dev() && opened.ino() == at_path.ino()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        // The lock is automatically released when the file descriptor is closed.
        // We also clean up the lock file.
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn acquire_lock_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("test.lock");

        let lock = FileLock::try_acquire(&lock_path).unwrap();
        assert!(lock.is_some());
    }

    #[test]
    fn lock_file_cleaned_up_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("cleanup.lock");

        {
            let _lock = FileLock::try_acquire(&lock_path).unwrap().unwrap();
            assert!(lock_path.exists());
        }
        assert!(!lock_path.exists());
    }

    #[test]
    fn concurrent_lock_via_subprocess() {
        // flock(2) locks are per-fd, but within the same process multiple
        // open() calls to the same file may share the lock on some systems.
        // Use a child process to verify true exclusion.
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("concurrent.lock");

        let _lock = FileLock::try_acquire(&lock_path).unwrap().unwrap();

        // Spawn a child that tries to flock the same file.
        let output = Command::new("sh")
            .arg("-c")
            .arg(format!(
                "exec 9>\"{}\" && flock -n 9 && echo ACQUIRED || echo BLOCKED",
                lock_path.display()
            ))
            .output()
            .expect("failed to run sh");

        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.trim() == "BLOCKED",
            "child should be blocked, got: {}",
            stdout.trim()
        );
    }
}
