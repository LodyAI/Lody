#![forbid(unsafe_code)]

use lody_acp::{ManagedArtifactInstaller, StdioAcpLauncher};
use lody_engine::{RepoEngineClient, RoostHistoryStore};
use lody_entry::{EntryMode, parse_entry_mode, run_local_status};
use lody_ports::{BackendPort, ManagedArtifactSource, StorageLeaseMode};
use lody_runtime::{DaemonDependencies, DaemonRuntime};
use lody_sqlite::{SqliteDataLayout, SqliteInboxStore};
use lody_worktree::{GitWorktreeManager, LocalTurnDiffStore};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

const PUBLIC_RUNTIME_ARTIFACTS_URL: &str = "https://artifacts.lody.ai";

fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("LODY_DATA_DIR")
        && !dir.trim().is_empty()
    {
        return PathBuf::from(dir);
    }
    std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".lody"))
        .unwrap_or_else(|_| PathBuf::from(".lody"))
}

#[cfg(feature = "connected")]
fn load_backend_profile(base_data_dir: &std::path::Path) -> Option<Arc<dyn BackendPort>> {
    let profile_path = base_data_dir.join("backend-profile.json");
    let raw = std::fs::read_to_string(profile_path).ok()?;
    let profile: lody_ports::BackendProfile = serde_json::from_str(&raw).ok()?;
    Some(Arc::new(lody_backend::ConnectedBackend::new(profile)))
}

#[cfg(not(feature = "connected"))]
fn load_backend_profile(_base_data_dir: &std::path::Path) -> Option<Arc<dyn BackendPort>> {
    None
}

fn resolve_artifact_source(backend: Option<&Arc<dyn BackendPort>>) -> ManagedArtifactSource {
    if let Ok(override_url) = std::env::var("LODY_RUNTIME_BASE_URL")
        && !override_url.trim().is_empty()
    {
        return ManagedArtifactSource::Mirror {
            base_url: override_url.trim().to_string(),
        };
    }
    if let Some(b) = backend
        && let Some(mirror) = &b.profile().discovery.artifact_mirror_url
    {
        return ManagedArtifactSource::Mirror {
            base_url: mirror.clone(),
        };
    }
    ManagedArtifactSource::PublicDefault {
        base_url: PUBLIC_RUNTIME_ARTIFACTS_URL.to_string(),
    }
}

fn compose_runtime(base_data_dir: PathBuf, lease_mode: StorageLeaseMode) -> DaemonRuntime {
    let backend = load_backend_profile(&base_data_dir);
    let effective_data_dir = match &backend {
        Some(b) => b.profile().isolated_data_dir(&base_data_dir),
        None => base_data_dir,
    };
    let artifact_source = resolve_artifact_source(backend.as_ref());
    let layout = SqliteDataLayout::new(effective_data_dir);
    DaemonRuntime::new(DaemonDependencies {
        storage_lease_mode: lease_mode,
        engine: Arc::new(RepoEngineClient::new(None)),
        history: Arc::new(RoostHistoryStore),
        inbox: Arc::new(SqliteInboxStore::new(layout)),
        diff_store: Arc::new(LocalTurnDiffStore),
        artifacts: Arc::new(ManagedArtifactInstaller::new(artifact_source)),
        acp: Arc::new(StdioAcpLauncher::default()),
        worktree: Arc::new(GitWorktreeManager),
        backend,
    })
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = match parse_entry_mode(&args) {
        Ok(mode) => mode,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::from(2);
        }
    };

    match mode {
        EntryMode::Version => {
            println!("lody {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        EntryMode::Daemon | EntryMode::DaemonRunner => {
            let runtime = compose_runtime(default_data_dir(), StorageLeaseMode::OnlineHost);
            match run_local_status(&runtime) {
                Ok(resp) => {
                    println!("{resp:?}");
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    eprintln!("{err}");
                    ExitCode::FAILURE
                }
            }
        }
        EntryMode::Status | EntryMode::McpStdio => {
            let runtime = compose_runtime(default_data_dir(), StorageLeaseMode::StorageOnly);
            match run_local_status(&runtime) {
                Ok(resp) => {
                    println!("{resp:?}");
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    eprintln!("{err}");
                    ExitCode::FAILURE
                }
            }
        }
    }
}
