//! File lock for single-instance enforcement.
//!
//! Only the Main Process acquires the lock. CLI processes never touch it.

use std::fs::{File, OpenOptions};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

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
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(path)?;

        let fd = file.as_raw_fd();
        let ret = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };

        if ret == -1 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
                // Another process holds the lock.
                return Ok(None);
            }
            return Err(err);
        }

        Ok(Some(FileLock {
            _file: file,
            path: path.to_path_buf(),
        }))
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
