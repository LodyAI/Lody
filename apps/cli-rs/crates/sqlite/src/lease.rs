use fd_lock::RwLock;
use lody_ports::{PortError, PortErrorKind, PortResult, StorageLeaseMode, StorageLeasePort};
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

struct HeldFdLock {
    release_tx: Option<mpsc::Sender<()>>,
    holder_thread: Option<JoinHandle<()>>,
}

impl HeldFdLock {
    fn try_acquire(lock_path: &Path) -> PortResult<Option<Self>> {
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
        }
        let path_owned = lock_path.to_path_buf();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<bool, String>>(1);
        let (release_tx, release_rx) = mpsc::channel::<()>();

        let handle = thread::spawn(move || {
            let file = match OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .truncate(false)
                .open(&path_owned)
            {
                Ok(f) => f,
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                    return;
                }
            };
            let mut lock = RwLock::new(file);
            match lock.try_write() {
                Ok(_guard) => {
                    if ready_tx.send(Ok(true)).is_ok() {
                        let _ = release_rx.recv();
                    }
                }
                Err(err) if err.kind() == ErrorKind::WouldBlock => {
                    let _ = ready_tx.send(Ok(false));
                }
                Err(err) => {
                    let _ = ready_tx.send(Err(err.to_string()));
                }
            }
        });

        match ready_rx.recv() {
            Ok(Ok(true)) => Ok(Some(Self {
                release_tx: Some(release_tx),
                holder_thread: Some(handle),
            })),
            Ok(Ok(false)) => {
                let _ = handle.join();
                Ok(None)
            }
            Ok(Err(msg)) => {
                let _ = handle.join();
                Err(PortError::new(PortErrorKind::Unavailable, msg))
            }
            Err(e) => {
                let _ = handle.join();
                Err(PortError::new(PortErrorKind::Internal, e.to_string()))
            }
        }
    }

    fn is_currently_locked(lock_path: &Path) -> bool {
        let Ok(file) = File::options().read(true).write(true).open(lock_path) else {
            return false;
        };
        let mut lock = RwLock::new(file);
        match lock.try_write() {
            Ok(guard) => {
                drop(guard);
                false
            }
            Err(err) => err.kind() == ErrorKind::WouldBlock,
        }
    }
}

impl Drop for HeldFdLock {
    fn drop(&mut self) {
        let _ = self.release_tx.take();
        if let Some(handle) = self.holder_thread.take() {
            let _ = handle.join();
        }
    }
}

pub struct FileStorageLease {
    mode: StorageLeaseMode,
    yield_signal_path: PathBuf,
    _online_host_guard: Option<HeldFdLock>,
    _storage_guard: HeldFdLock,
}

impl FileStorageLease {
    pub fn acquire(
        locks_dir: &Path,
        mode: StorageLeaseMode,
        wait_timeout: Duration,
    ) -> PortResult<Self> {
        fs::create_dir_all(locks_dir)
            .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;

        let online_lock_path = locks_dir.join("online-host.lock");
        let storage_lock_path = locks_dir.join("storage.lock");
        let yield_signal_path = locks_dir.join("storage-yield.signal");
        let deadline = Instant::now() + wait_timeout;

        match mode {
            StorageLeaseMode::OnlineHost => {
                let Some(online_guard) = HeldFdLock::try_acquire(&online_lock_path)? else {
                    return Err(PortError::new(
                        PortErrorKind::Conflict,
                        "an online lody daemon already holds the host lease",
                    ));
                };

                let _ = fs::write(&yield_signal_path, std::process::id().to_string());

                loop {
                    if let Some(storage_guard) = HeldFdLock::try_acquire(&storage_lock_path)? {
                        let _ = fs::remove_file(&yield_signal_path);
                        return Ok(Self {
                            mode,
                            yield_signal_path,
                            _online_host_guard: Some(online_guard),
                            _storage_guard: storage_guard,
                        });
                    }
                    if Instant::now() >= deadline {
                        let _ = fs::remove_file(&yield_signal_path);
                        return Err(PortError::new(
                            PortErrorKind::Timeout,
                            "timed out waiting for storage-only holder to yield storage lease",
                        ));
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            }
            StorageLeaseMode::StorageOnly => loop {
                if yield_signal_path.exists() || HeldFdLock::is_currently_locked(&online_lock_path)
                {
                    return Err(PortError::new(
                        PortErrorKind::Conflict,
                        "online lody daemon owns or requested the storage lease",
                    ));
                }
                if let Some(storage_guard) = HeldFdLock::try_acquire(&storage_lock_path)? {
                    if yield_signal_path.exists()
                        || HeldFdLock::is_currently_locked(&online_lock_path)
                    {
                        drop(storage_guard);
                        return Err(PortError::new(
                            PortErrorKind::Conflict,
                            "online lody daemon claimed the storage lease during handoff",
                        ));
                    }
                    return Ok(Self {
                        mode,
                        yield_signal_path,
                        _online_host_guard: None,
                        _storage_guard: storage_guard,
                    });
                }
                if Instant::now() >= deadline {
                    return Err(PortError::new(
                        PortErrorKind::Timeout,
                        "timed out waiting for local storage lease",
                    ));
                }
                thread::sleep(Duration::from_millis(10));
            },
        }
    }
}

impl StorageLeasePort for FileStorageLease {
    fn mode(&self) -> StorageLeaseMode {
        self.mode
    }

    fn yield_requested(&self) -> bool {
        self.mode == StorageLeaseMode::StorageOnly && self.yield_signal_path.exists()
    }
}
