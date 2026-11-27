#![forbid(unsafe_code)]

use lody_acp::{ManagedArtifactInstaller, PortablePtyManager, StdioAcpLauncher};
use lody_app::ApplicationService;
use lody_engine::{EngineScheduleRepo, FlockProjectStore, RepoEngineClient, RoostHistoryStore};
use lody_entry::{
    DispatchPlan, McpRequestContext, OneShotAction, execute_offline_oneshot,
    format_restore_machine_id_error, format_restore_machine_id_output, parse_cli_args,
    probe_live_daemon, run_mcp_stdio_bridge, serve_local_daemon, start_daemon_detached,
    stop_running_daemon, try_execute_via_live_daemon,
};
use lody_env::{HostEnv, McpStdioEnv};
use lody_ports::{
    BackendPort, MachineIdentityPort, ManagedArtifactSource, McpEnvVar, McpServerMount,
    McpServerTransport, PortErrorKind, PortResult, ScheduleLedgerPort, ScheduleRepoPort, SessionId,
    StorageLeaseMode, StorageLeasePort, WorkspaceId,
};
use lody_runtime::{DaemonDependencies, DaemonRuntime};
use lody_sqlite::{
    FileStorageLease, LocalMachineIdentityStore, MachineIdentityConfig, SqliteDataLayout,
    SqliteScheduleLedgerStore, SqliteStore,
};
use lody_worktree::{GitWorktreeManager, LocalTurnDiffStore};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

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

fn build_identity_store(
    host_env: &HostEnv,
    effective_data_dir: &std::path::Path,
    has_isolated_backend_profile: bool,
) -> Arc<LocalMachineIdentityStore> {
    Arc::new(LocalMachineIdentityStore::new(MachineIdentityConfig {
        data_dir: effective_data_dir.to_path_buf(),
        is_default_data_dir: host_env.is_default_data_dir && !has_isolated_backend_profile,
        namespace: host_env.platform.namespace().to_string(),
        user_identity: host_env.user_identity.clone(),
        state_anchor_dir: host_env.state_anchor_dir.clone(),
        platform: HostEnv::os_platform_tag(),
    }))
}

fn compose_runtime(
    host_env: &HostEnv,
    effective_data_dir: PathBuf,
    backend: Option<Arc<dyn BackendPort>>,
    lease_mode: StorageLeaseMode,
) -> PortResult<DaemonRuntime> {
    let locks_dir = host_env.locks_dir(&effective_data_dir);
    let wait_timeout = match lease_mode {
        StorageLeaseMode::OnlineHost => Duration::from_secs(10),
        StorageLeaseMode::StorageOnly => Duration::from_secs(5),
    };
    let storage_lease = Arc::new(FileStorageLease::acquire(
        &locks_dir,
        lease_mode,
        wait_timeout,
    )?) as Arc<dyn StorageLeasePort>;

    let identity_store = build_identity_store(host_env, &effective_data_dir, backend.is_some());
    let machine_id = identity_store.get_or_create_machine_id()?;

    let artifact_source = resolve_artifact_source(host_env, backend.as_ref());
    let repos_root = effective_data_dir.join("repos");
    let runtimes_root = effective_data_dir.join("runtimes");
    let default_cwd = host_env
        .home_dir
        .clone()
        .unwrap_or_else(|| effective_data_dir.clone());
    let shell_command = host_env.shell_command();
    let current_exe = std::env::current_exe().ok();
    let exe_for_mcp = current_exe.clone();
    let env_for_agents = host_env.clone();
    let env_for_terminals = host_env.clone();
    let env_for_mcp_stdio = host_env.clone();
    let data_dir_for_mcp = effective_data_dir.clone();

    let diff_store = Arc::new(LocalTurnDiffStore::new(&effective_data_dir));
    let layout = SqliteDataLayout::with_machine_id(&effective_data_dir, machine_id.0.clone());
    let schedule_ledger = Arc::new(SqliteScheduleLedgerStore::open(&layout.schedules_db())?)
        as Arc<dyn ScheduleLedgerPort>;
    let sqlite = Arc::new(SqliteStore::open(layout)?);

    let mut runtime = DaemonRuntime::new(DaemonDependencies {
        machine_id,
        identity: identity_store as Arc<dyn MachineIdentityPort>,
        default_cwd,
        shell_command,
        agent_env_builder: Arc::new(move |cmd| {
            env_for_agents.agent_spawn_env(cmd, current_exe.as_deref())
        }),
        terminal_env_builder: Arc::new(move |sid| env_for_terminals.sanitized_terminal_env(sid)),
        storage_lease_mode: lease_mode,
        storage_lease: Some(storage_lease),
        engine: Arc::new(RepoEngineClient::new(None)),
        history: Arc::new(RoostHistoryStore),
        inbox: sqlite as Arc<dyn lody_ports::InboxStorePort>,
        projects: Arc::new(FlockProjectStore),
        schedule_repo: Arc::new(EngineScheduleRepo) as Arc<dyn ScheduleRepoPort>,
        schedule_ledger,
        diff_store,
        artifacts: Arc::new(
            ManagedArtifactInstaller::with_install_root(artifact_source, runtimes_root)
                .with_proxy_url(host_env.https_proxy.clone()),
        ),
        acp: Arc::new(StdioAcpLauncher::new(host_env.max_concurrent_acp_starts)),
        pty: Arc::new(PortablePtyManager::new()),
        worktree: Arc::new(GitWorktreeManager::new(repos_root)),
        backend,
    });

    if let Some(exe) = exe_for_mcp {
        runtime = runtime.with_mcp_stdio_mount_builder(Arc::new(move |sid, ws, mid, cwd| {
            let env_map = env_for_mcp_stdio.mcp_stdio_spawn_env(
                &data_dir_for_mcp,
                &sid.0,
                &ws.0,
                &mid.0,
                cwd,
                None,
            );
            let env_vec: Vec<McpEnvVar> = env_map
                .into_iter()
                .map(|(name, value)| McpEnvVar { name, value })
                .collect();
            Some(McpServerMount {
                name: "lody".to_string(),
                transport: McpServerTransport::Stdio {
                    command: exe.clone(),
                    args: vec!["mcp-stdio".to_string()],
                    env: env_vec,
                },
            })
        }));
    }

    Ok(runtime)
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
                    host_env.platform.namespace(),
                    env!("CARGO_PKG_VERSION"),
                    !host_env.mcp_http_disabled,
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
        DispatchPlan::OneShot(OneShotAction::MachineRestoreId { machine_id, json }) => {
            let active_host_pid = probe_live_daemon(&effective_data_dir).map(|m| m.pid);
            let identity_store =
                build_identity_store(&host_env, &effective_data_dir, backend.is_some());
            match identity_store.restore_local_machine_id(&machine_id, active_host_pid) {
                Ok(outcome) => match format_restore_machine_id_output(&outcome, json) {
                    Ok(rendered) => {
                        println!("{rendered}");
                        ExitCode::SUCCESS
                    }
                    Err(err) => {
                        eprintln!("{err}");
                        ExitCode::FAILURE
                    }
                },
                Err(err) => {
                    let rendered = format_restore_machine_id_error(&err.message, json);
                    if json {
                        println!("{rendered}");
                    } else {
                        eprintln!("{rendered}");
                    }
                    ExitCode::FAILURE
                }
            }
        }
        DispatchPlan::OneShot(OneShotAction::McpStdio) => {
            let mcp_env = match McpStdioEnv::from_process() {
                Ok(env) => env,
                Err(err) => {
                    eprintln!("{err}");
                    return ExitCode::from(2);
                }
            };
            let ctx = McpRequestContext {
                session_id: SessionId(mcp_env.session_id),
                workspace_id: WorkspaceId(mcp_env.workspace_id),
                machine_id: mcp_env.machine_id,
                workdir: mcp_env.workdir,
            };
            match run_mcp_stdio_bridge(
                &effective_data_dir,
                mcp_env.socket_path_override.as_deref(),
                &ctx,
            ) {
                Ok(()) => ExitCode::SUCCESS,
                Err(err) => {
                    eprintln!("{err}");
                    ExitCode::FAILURE
                }
            }
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
                effective_data_dir.clone(),
                backend,
                StorageLeaseMode::StorageOnly,
            ) {
                Ok(rt) => rt,
                Err(err) if err.kind == PortErrorKind::Conflict => {
                    if let Some(live_result) =
                        try_execute_via_live_daemon(&effective_data_dir, &action)
                    {
                        return match live_result {
                            Ok(out) => {
                                println!("{out}");
                                ExitCode::SUCCESS
                            }
                            Err(e) => {
                                eprintln!("{e}");
                                ExitCode::FAILURE
                            }
                        };
                    }
                    eprintln!("{err}");
                    return ExitCode::FAILURE;
                }
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
