#![forbid(unsafe_code)]

use lody_acp::{ManagedArtifactInstaller, StdioAcpLauncher};
use lody_app::ApplicationService;
use lody_engine::{FlockProjectStore, RepoEngineClient, RoostHistoryStore};
use lody_entry::{
    DispatchPlan, ensure_machine_id, execute_offline_oneshot, parse_cli_args, probe_live_daemon,
    serve_local_daemon, start_daemon_detached, stop_running_daemon, try_execute_via_live_daemon,
};
use lody_env::HostEnv;
use lody_ports::{BackendPort, ManagedArtifactSource, PortResult, StorageLeaseMode};
use lody_runtime::{DaemonDependencies, DaemonRuntime};
use lody_sqlite::{SqliteDataLayout, SqliteStore};
use lody_worktree::{GitWorktreeManager, LocalTurnDiffStore};
use std::path::PathBuf;
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

fn resolve_effective_data_dir(host_env: &HostEnv) -> (PathBuf, Option<Arc<dyn BackendPort>>) {
    let backend = load_backend_profile(&host_env.data_dir);
    let effective = match &backend {
        Some(b) => b.profile().isolated_data_dir(&host_env.data_dir),
        None => host_env.data_dir.clone(),
    };
    (effective, backend)
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

fn compose_runtime(
    host_env: &HostEnv,
    effective_data_dir: PathBuf,
    backend: Option<Arc<dyn BackendPort>>,
    lease_mode: StorageLeaseMode,
) -> PortResult<DaemonRuntime> {
    let machine_id = ensure_machine_id(&effective_data_dir).map_err(|e| {
        lody_ports::PortError::new(lody_ports::PortErrorKind::Unavailable, e.to_string())
    })?;
    let artifact_source = resolve_artifact_source(host_env, backend.as_ref());
    let repos_root = effective_data_dir.join("repos");
    let sqlite = Arc::new(SqliteStore::open(SqliteDataLayout::with_machine_id(
        effective_data_dir,
        machine_id,
    ))?);
    Ok(DaemonRuntime::new(DaemonDependencies {
        storage_lease_mode: lease_mode,
        engine: Arc::new(RepoEngineClient::new(None)),
        history: Arc::new(RoostHistoryStore),
        inbox: sqlite as Arc<dyn lody_ports::InboxStorePort>,
        projects: Arc::new(FlockProjectStore),
        diff_store: Arc::new(LocalTurnDiffStore),
        artifacts: Arc::new(ManagedArtifactInstaller::new(artifact_source)),
        acp: Arc::new(StdioAcpLauncher::default()),
        worktree: Arc::new(GitWorktreeManager::new(repos_root)),
        backend,
    }))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let plan = match parse_cli_args(&args) {
        Ok(p) => p,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::from(2);
        }
    };

    if plan == DispatchPlan::PrintVersion {
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
    let (effective_data_dir, backend) = resolve_effective_data_dir(&host_env);

    match plan {
        DispatchPlan::PrintVersion => ExitCode::SUCCESS,
        DispatchPlan::StartDaemonBackground => match start_daemon_detached(&effective_data_dir) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("{err}");
                ExitCode::FAILURE
            }
        },
        DispatchPlan::StopDaemon => match stop_running_daemon(&effective_data_dir) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("{err}");
                ExitCode::FAILURE
            }
        },
        DispatchPlan::RunDaemonForeground => {
            if probe_live_daemon(&effective_data_dir).is_some() {
                eprintln!("a live lody daemon already owns {:?}", effective_data_dir);
                return ExitCode::FAILURE;
            }
            let tokio_rt = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(err) => {
                    eprintln!("{err}");
                    return ExitCode::FAILURE;
                }
            };
            tokio_rt.block_on(async move {
                let runtime = match compose_runtime(
                    &host_env,
                    effective_data_dir.clone(),
                    backend,
                    StorageLeaseMode::OnlineHost,
                ) {
                    Ok(rt) => Arc::new(rt),
                    Err(err) => {
                        eprintln!("{err}");
                        return ExitCode::FAILURE;
                    }
                };
                let home_dir = host_env
                    .home_dir
                    .clone()
                    .unwrap_or_else(|| effective_data_dir.clone());
                let svc = Arc::clone(&runtime) as Arc<dyn ApplicationService>;
                let res = serve_local_daemon(
                    &effective_data_dir,
                    &home_dir,
                    env!("CARGO_PKG_VERSION"),
                    svc,
                )
                .await;
                match res {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(err) => {
                        eprintln!("{err}");
                        ExitCode::FAILURE
                    }
                }
            })
        }
        DispatchPlan::OneShot(action) => {
            if let Some(live_result) = try_execute_via_live_daemon(&effective_data_dir, &action) {
                return match live_result {
                    Ok(out) => {
                        println!("{out}");
                        ExitCode::SUCCESS
                    }
                    Err(err) => {
                        eprintln!("{err}");
                        ExitCode::FAILURE
                    }
                };
            }
            let runtime = match compose_runtime(
                &host_env,
                effective_data_dir,
                backend,
                StorageLeaseMode::StorageOnly,
            ) {
                Ok(rt) => rt,
                Err(err) => {
                    eprintln!("{err}");
                    return ExitCode::FAILURE;
                }
            };
            match execute_offline_oneshot(&runtime, action) {
                Ok(out) => {
                    println!("{out}");
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
