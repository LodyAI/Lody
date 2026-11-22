#![forbid(unsafe_code)]

use lody_acp::{ManagedArtifactInstaller, StdioAcpLauncher};
use lody_engine::{RepoEngineClient, RoostHistoryStore};
use lody_entry::{EntryMode, parse_entry_mode, run_local_status};
use lody_env::HostEnv;
use lody_ports::{BackendPort, ManagedArtifactSource, StorageLeaseMode};
use lody_runtime::{DaemonDependencies, DaemonRuntime};
use lody_sqlite::{SqliteDataLayout, SqliteInboxStore};
use lody_worktree::{GitWorktreeManager, LocalTurnDiffStore};
use std::process::ExitCode;
use std::sync::Arc;

const PUBLIC_RUNTIME_ARTIFACTS_URL: &str = "https://artifacts.lody.ai";

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

fn resolve_artifact_source(
    host_env: &HostEnv,
    backend: Option<&Arc<dyn BackendPort>>,
) -> ManagedArtifactSource {
    if let Some(override_url) = &host_env.runtime_base_url_override {
        return ManagedArtifactSource::Mirror {
            base_url: override_url.clone(),
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

fn compose_runtime(host_env: &HostEnv, lease_mode: StorageLeaseMode) -> DaemonRuntime {
    let backend = load_backend_profile(&host_env.data_dir);
    let effective_data_dir = match &backend {
        Some(b) => b.profile().isolated_data_dir(&host_env.data_dir),
        None => host_env.data_dir.clone(),
    };
    let artifact_source = resolve_artifact_source(host_env, backend.as_ref());
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

    if mode == EntryMode::Version {
        println!("lody {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    let host_env = match HostEnv::from_process() {
        Ok(env) => env,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::from(2);
        }
    };

    let lease_mode = match mode {
        EntryMode::Daemon | EntryMode::DaemonRunner => StorageLeaseMode::OnlineHost,
        EntryMode::Status | EntryMode::McpStdio | EntryMode::Version => {
            StorageLeaseMode::StorageOnly
        }
    };
    let runtime = compose_runtime(&host_env, lease_mode);
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
