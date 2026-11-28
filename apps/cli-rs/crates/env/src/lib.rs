#![forbid(unsafe_code)]
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

pub mod keys {
    pub const HOME: &str = "HOME";
    pub const USERPROFILE: &str = "USERPROFILE";
    pub const USER: &str = "USER";
    pub const USERNAME: &str = "USERNAME";
    pub const XDG_STATE_HOME: &str = "XDG_STATE_HOME";
    pub const LOCALAPPDATA: &str = "LOCALAPPDATA";
    pub const SHELL: &str = "SHELL";
    pub const COMSPEC: &str = "ComSpec";
    pub const COLORTERM: &str = "COLORTERM";
    pub const TERM: &str = "TERM";
    pub const FORCE_COLOR: &str = "FORCE_COLOR";
    pub const NO_COLOR: &str = "NO_COLOR";
    pub const ELECTRON_RUN_AS_NODE: &str = "ELECTRON_RUN_AS_NODE";
    pub const LODY_DATA_DIR: &str = "LODY_DATA_DIR";
    pub const LODY_LOCKS_DIR: &str = "LODY_LOCKS_DIR";
    pub const LODY_PLATFORM: &str = "LODY_PLATFORM";
    pub const LODY_RUNTIME_BASE_URL: &str = "LODY_RUNTIME_BASE_URL";
    pub const LODY_LOG_LEVEL: &str = "LODY_LOG_LEVEL";
    pub const LODY_LOG_TRACE: &str = "LODY_LOG_TRACE";
    pub const LODY_SESSION_ID: &str = "LODY_SESSION_ID";
    pub const LODY_WORKSPACE_SESSION_ID: &str = "LODY_WORKSPACE_SESSION_ID";
    pub const LODY_AUTH_URL: &str = "LODY_AUTH_URL";
    pub const LODY_AUTH_SITE_URL: &str = "LODY_AUTH_SITE_URL";
    pub const LODY_SERVER_URL: &str = "LODY_SERVER_URL";
    pub const LODY_MCP_HTTP_DISABLED: &str = "LODY_MCP_HTTP_DISABLED";
    pub const LODY_MCP_SOCKET_PATH: &str = "LODY_MCP_SOCKET_PATH";
    pub const LODY_MCP_SESSION_ID: &str = "LODY_MCP_SESSION_ID";
    pub const LODY_MCP_WORKSPACE_ID: &str = "LODY_MCP_WORKSPACE_ID";
    pub const LODY_MCP_MACHINE_ID: &str = "LODY_MCP_MACHINE_ID";
    pub const LODY_MCP_WORKDIR: &str = "LODY_MCP_WORKDIR";
    pub const LODY_MAX_CONCURRENT_ACP_SESSION_STARTS: &str =
        "LODY_MAX_CONCURRENT_ACP_SESSION_STARTS";
    pub const HTTPS_PROXY: &str = "HTTPS_PROXY";
    pub const HTTPS_PROXY_LOWER: &str = "https_proxy";
    pub const HTTP_PROXY: &str = "HTTP_PROXY";
    pub const HTTP_PROXY_LOWER: &str = "http_proxy";
    pub const ALL_PROXY: &str = "ALL_PROXY";
    pub const ALL_PROXY_LOWER: &str = "all_proxy";
    pub const NO_PROXY: &str = "NO_PROXY";
    pub const NO_PROXY_LOWER: &str = "no_proxy";
    pub const LODY_CONFORMANCE_BIN: &str = "LODY_CONFORMANCE_BIN";
    pub const LODY_CONFORMANCE_BASELINE_BIN: &str = "LODY_CONFORMANCE_BASELINE_BIN";
    pub const LODY_CONFORMANCE_CANDIDATE_BIN: &str = "LODY_CONFORMANCE_CANDIDATE_BIN";
}

pub const LOOPBACK_NO_PROXY_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];
pub const DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS: usize = 2;

const CHILD_CREDENTIAL_AND_BOOTSTRAP_BLOCKLIST: [&str; 12] = [
    keys::ELECTRON_RUN_AS_NODE,
    "LODY_CLI_TOKEN",
    "LODY_AGENT_SESSION_ID",
    "LODY_ELECTRON_BOOTSTRAP",
    "LODY_ELECTRON_SESSION_TOKEN",
    "LODY_GIT_CRED_BROKER_STATE_FILE",
    "LODY_GIT_CRED_BROKER_TOKEN",
    "LODY_GIT_CRED_BROKER_URL",
    "LODY_GIT_CRED_CONTEXT_TOKEN",
    "LODY_MANAGED_GH_TOKEN_SHA256",
    "GH_TOKEN",
    "GITHUB_TOKEN",
];

pub fn merge_loopback_no_proxy(upper: Option<&str>, lower: Option<&str>) -> String {
    let mut entries: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for raw in [upper, lower].into_iter().flatten() {
        for part in raw.split(',') {
            let entry = part.trim();
            if entry.is_empty() {
                continue;
            }
            if entry == "*" {
                return "*".to_string();
            }
            let key = entry.to_ascii_lowercase();
            if seen.insert(key) {
                entries.push(entry.to_string());
            }
        }
    }

    for host in LOOPBACK_NO_PROXY_HOSTS {
        if seen.insert(host.to_string()) {
            entries.push(host.to_string());
        }
    }

    entries.join(",")
}

pub fn apply_loopback_no_proxy(env: &mut BTreeMap<String, String>) {
    let merged = merge_loopback_no_proxy(
        env.get(keys::NO_PROXY).map(String::as_str),
        env.get(keys::NO_PROXY_LOWER).map(String::as_str),
    );
    env.insert(keys::NO_PROXY.to_string(), merged.clone());
    env.insert(keys::NO_PROXY_LOWER.to_string(), merged);
}

fn paths_match_executable(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallationPlatform {
    Local,
    Cloud,
}

impl InstallationPlatform {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim).filter(|s| !s.is_empty()) {
            None | Some("local") => Ok(Self::Local),
            Some("cloud") => Ok(Self::Cloud),
            Some(other) => Err(format!(
                "invalid {} value '{other}': expected 'local' or 'cloud'",
                keys::LODY_PLATFORM
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Cloud => "cloud",
        }
    }

    pub fn namespace(self) -> &'static str {
        match self {
            Self::Local => "lody-oss",
            Self::Cloud => "lody",
        }
    }

    pub fn data_directory_name(self) -> &'static str {
        match self {
            Self::Local => ".lody-oss",
            Self::Cloud => ".lody",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostEnv {
    pub platform: InstallationPlatform,
    pub home_dir: Option<PathBuf>,
    pub data_dir: PathBuf,
    pub is_default_data_dir: bool,
    pub state_anchor_dir: Option<PathBuf>,
    pub user_identity: String,
    pub locks_dir_override: Option<PathBuf>,
    pub runtime_base_url_override: Option<String>,
    pub log_level: Option<String>,
    pub log_trace: bool,
    pub mcp_http_disabled: bool,
    pub max_concurrent_acp_starts: usize,
    pub electron_run_as_node: Option<String>,
    pub auth_url: Option<String>,
    pub auth_site_url: Option<String>,
    pub server_url: Option<String>,
    pub https_proxy: Option<String>,
    pub no_proxy: Vec<String>,
    inherited_env: BTreeMap<String, String>,
}

impl HostEnv {
    pub fn from_process() -> Result<Self, String> {
        let inherited: BTreeMap<String, String> = std::env::vars().collect();
        let mut env = Self::from_lookup(|key| inherited.get(key).cloned())?;
        env.inherited_env = inherited;
        Ok(env)
    }

    pub fn from_lookup<F>(lookup: F) -> Result<Self, String>
    where
        F: Fn(&str) -> Option<String>,
    {
        let trimmed = |key: &str| {
            lookup(key)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };

        let platform = InstallationPlatform::parse(trimmed(keys::LODY_PLATFORM).as_deref())?;
        let home_dir = trimmed(keys::HOME)
            .or_else(|| trimmed(keys::USERPROFILE))
            .map(PathBuf::from);

        let explicit_data_dir = trimmed(keys::LODY_DATA_DIR);
        let is_default_data_dir = explicit_data_dir.is_none();
        let data_dir = match explicit_data_dir {
            Some(explicit) => PathBuf::from(explicit),
            None => match &home_dir {
                Some(home) => home.join(platform.data_directory_name()),
                None => PathBuf::from(platform.data_directory_name()),
            },
        };

        let state_anchor_dir = if cfg!(windows) {
            trimmed(keys::LOCALAPPDATA)
                .map(PathBuf::from)
                .or_else(|| home_dir.as_ref().map(|h| h.join("AppData").join("Local")))
                .map(|base| base.join(platform.namespace()))
        } else {
            trimmed(keys::XDG_STATE_HOME)
                .map(PathBuf::from)
                .or_else(|| home_dir.as_ref().map(|h| h.join(".local").join("state")))
                .map(|base| base.join(platform.namespace()))
        };

        let user_identity = trimmed(keys::USER)
            .or_else(|| trimmed(keys::USERNAME))
            .or_else(|| home_dir.as_ref().map(|h| h.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "local".to_string())
            .trim()
            .to_ascii_lowercase();

        let locks_dir_override = trimmed(keys::LODY_LOCKS_DIR).map(PathBuf::from);
        let runtime_base_url_override = trimmed(keys::LODY_RUNTIME_BASE_URL);
        let log_level = trimmed(keys::LODY_LOG_LEVEL);
        let log_trace = trimmed(keys::LODY_LOG_TRACE)
            .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
        let mcp_http_disabled = trimmed(keys::LODY_MCP_HTTP_DISABLED)
            .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
        let max_concurrent_acp_starts = trimmed(keys::LODY_MAX_CONCURRENT_ACP_SESSION_STARTS)
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|&n| n >= 1)
            .unwrap_or(DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS);
        let electron_run_as_node = trimmed(keys::ELECTRON_RUN_AS_NODE);
        let (auth_url, auth_site_url, server_url) = match platform {
            InstallationPlatform::Local => (None, None, None),
            InstallationPlatform::Cloud => (
                trimmed(keys::LODY_AUTH_URL),
                trimmed(keys::LODY_AUTH_SITE_URL),
                trimmed(keys::LODY_SERVER_URL),
            ),
        };

        let https_proxy = trimmed(keys::HTTPS_PROXY)
            .or_else(|| trimmed(keys::HTTPS_PROXY_LOWER))
            .or_else(|| trimmed(keys::HTTP_PROXY))
            .or_else(|| trimmed(keys::HTTP_PROXY_LOWER))
            .or_else(|| trimmed(keys::ALL_PROXY))
            .or_else(|| trimmed(keys::ALL_PROXY_LOWER));

        let merged_no_proxy = merge_loopback_no_proxy(
            trimmed(keys::NO_PROXY).as_deref(),
            trimmed(keys::NO_PROXY_LOWER).as_deref(),
        );
        let no_proxy = merged_no_proxy
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .collect();

        let mut inherited_env = BTreeMap::new();
        for key in [
            keys::HOME,
            keys::USERPROFILE,
            keys::USER,
            keys::USERNAME,
            keys::SHELL,
            keys::COMSPEC,
            keys::COLORTERM,
            keys::ELECTRON_RUN_AS_NODE,
            keys::HTTPS_PROXY,
            keys::HTTPS_PROXY_LOWER,
            keys::HTTP_PROXY,
            keys::HTTP_PROXY_LOWER,
            keys::ALL_PROXY,
            keys::ALL_PROXY_LOWER,
            keys::NO_PROXY,
            keys::NO_PROXY_LOWER,
        ] {
            if let Some(val) = lookup(key) {
                inherited_env.insert(key.to_string(), val);
            }
        }

        Ok(Self {
            platform,
            home_dir,
            data_dir,
            is_default_data_dir,
            state_anchor_dir,
            user_identity,
            locks_dir_override,
            runtime_base_url_override,
            log_level,
            log_trace,
            mcp_http_disabled,
            max_concurrent_acp_starts,
            electron_run_as_node,
            auth_url,
            auth_site_url,
            server_url,
            https_proxy,
            no_proxy,
            inherited_env,
        })
    }

    pub fn locks_dir(&self, effective_data_dir: &Path) -> PathBuf {
        self.locks_dir_override
            .clone()
            .unwrap_or_else(|| effective_data_dir.join("locks"))
    }

    pub fn os_platform_tag() -> &'static str {
        if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(target_os = "windows") {
            "win32"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            "other"
        }
    }

    pub fn shell_command(&self) -> (String, Vec<String>) {
        if cfg!(windows) {
            let program = self
                .inherited_env
                .get(keys::COMSPEC)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("powershell.exe")
                .to_string();
            (program, Vec::new())
        } else {
            let program = self
                .inherited_env
                .get(keys::SHELL)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("/bin/sh")
                .to_string();
            (program, vec!["-l".to_string()])
        }
    }

    pub fn agent_spawn_env(
        &self,
        command: &Path,
        current_exe: Option<&Path>,
    ) -> BTreeMap<String, String> {
        let mut env = self.inherited_env.clone();
        for blocked in CHILD_CREDENTIAL_AND_BOOTSTRAP_BLOCKLIST {
            env.remove(blocked);
        }
        if let (Some(exe), Some(flag)) = (current_exe, &self.electron_run_as_node)
            && paths_match_executable(command, exe)
        {
            env.insert(keys::ELECTRON_RUN_AS_NODE.to_string(), flag.clone());
        }
        apply_loopback_no_proxy(&mut env);
        env
    }

    pub fn automation_command_env(&self) -> BTreeMap<String, String> {
        let mut env = self.inherited_env.clone();
        for blocked in CHILD_CREDENTIAL_AND_BOOTSTRAP_BLOCKLIST {
            env.remove(blocked);
        }
        apply_loopback_no_proxy(&mut env);
        env
    }

    pub fn sanitized_terminal_env(&self, session_id: &str) -> BTreeMap<String, String> {
        let mut env = self.inherited_env.clone();
        for blocked in CHILD_CREDENTIAL_AND_BOOTSTRAP_BLOCKLIST {
            env.remove(blocked);
        }
        apply_loopback_no_proxy(&mut env);
        env.insert(keys::TERM.to_string(), "xterm-256color".to_string());
        let colorterm = env
            .get(keys::COLORTERM)
            .filter(|s| !s.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| "truecolor".to_string());
        env.insert(keys::COLORTERM.to_string(), colorterm);
        env.insert(keys::FORCE_COLOR.to_string(), "1".to_string());
        env.insert(keys::LODY_SESSION_ID.to_string(), session_id.to_string());
        env.insert(
            keys::LODY_WORKSPACE_SESSION_ID.to_string(),
            session_id.to_string(),
        );
        env
    }

    pub fn mcp_stdio_spawn_env(
        &self,
        effective_data_dir: &Path,
        session_id: &str,
        workspace_id: &str,
        machine_id: &str,
        workdir: &Path,
        socket_path_override: Option<&Path>,
    ) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        for key in [
            keys::HOME,
            keys::USERPROFILE,
            keys::XDG_STATE_HOME,
            keys::LOCALAPPDATA,
        ] {
            if let Some(val) = self.inherited_env.get(key).filter(|s| !s.trim().is_empty()) {
                env.insert(key.to_string(), val.clone());
            }
        }
        if let Some(flag) = &self.electron_run_as_node {
            env.insert(keys::ELECTRON_RUN_AS_NODE.to_string(), flag.clone());
        }
        env.insert(
            keys::LODY_PLATFORM.to_string(),
            self.platform.as_str().to_string(),
        );
        env.insert(
            keys::LODY_DATA_DIR.to_string(),
            effective_data_dir.to_string_lossy().into_owned(),
        );
        if self.platform == InstallationPlatform::Cloud {
            if let Some(url) = &self.auth_url {
                env.insert(keys::LODY_AUTH_URL.to_string(), url.clone());
            }
            if let Some(url) = &self.auth_site_url {
                env.insert(keys::LODY_AUTH_SITE_URL.to_string(), url.clone());
            }
            if let Some(url) = &self.server_url {
                env.insert(keys::LODY_SERVER_URL.to_string(), url.clone());
            }
        }
        if let Some(sock) = socket_path_override {
            env.insert(
                keys::LODY_MCP_SOCKET_PATH.to_string(),
                sock.to_string_lossy().into_owned(),
            );
        }
        env.insert(
            keys::LODY_MCP_SESSION_ID.to_string(),
            session_id.to_string(),
        );
        env.insert(
            keys::LODY_MCP_WORKSPACE_ID.to_string(),
            workspace_id.to_string(),
        );
        env.insert(
            keys::LODY_MCP_MACHINE_ID.to_string(),
            machine_id.to_string(),
        );
        env.insert(
            keys::LODY_MCP_WORKDIR.to_string(),
            workdir.to_string_lossy().into_owned(),
        );
        apply_loopback_no_proxy(&mut env);
        env
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpStdioEnv {
    pub session_id: String,
    pub workspace_id: String,
    pub machine_id: String,
    pub workdir: String,
    pub socket_path_override: Option<PathBuf>,
}

impl McpStdioEnv {
    pub fn from_process() -> Result<Self, String> {
        let fallback_workdir = std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
        Self::from_lookup(|key| std::env::var(key).ok(), fallback_workdir.as_deref())
    }

    pub fn from_lookup<F>(lookup: F, fallback_workdir: Option<&str>) -> Result<Self, String>
    where
        F: Fn(&str) -> Option<String>,
    {
        let trimmed = |key: &str| {
            lookup(key)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty() && !v.contains('\0'))
        };

        let session_id = trimmed(keys::LODY_MCP_SESSION_ID)
            .or_else(|| trimmed(keys::LODY_SESSION_ID))
            .ok_or_else(|| format!("missing {}", keys::LODY_MCP_SESSION_ID))?;
        let workspace_id = trimmed(keys::LODY_MCP_WORKSPACE_ID)
            .ok_or_else(|| format!("missing {}", keys::LODY_MCP_WORKSPACE_ID))?;
        let machine_id = trimmed(keys::LODY_MCP_MACHINE_ID)
            .ok_or_else(|| format!("missing {}", keys::LODY_MCP_MACHINE_ID))?;
        let workdir = trimmed(keys::LODY_MCP_WORKDIR)
            .or_else(|| {
                fallback_workdir
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && !s.contains('\0'))
                    .map(ToOwned::to_owned)
            })
            .ok_or_else(|| format!("missing {}", keys::LODY_MCP_WORKDIR))?;
        let socket_path_override = trimmed(keys::LODY_MCP_SOCKET_PATH).map(PathBuf::from);

        Ok(Self {
            session_id,
            workspace_id,
            machine_id,
            workdir,
            socket_path_override,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConformanceEnv {
    pub single_bin: Option<String>,
    pub baseline_bin: Option<String>,
    pub candidate_bin: Option<String>,
}

impl ConformanceEnv {
    pub fn from_process() -> Self {
        let trimmed = |key: &str| {
            std::env::var(key)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        Self {
            single_bin: trimmed(keys::LODY_CONFORMANCE_BIN),
            baseline_bin: trimmed(keys::LODY_CONFORMANCE_BASELINE_BIN),
            candidate_bin: trimmed(keys::LODY_CONFORMANCE_CANDIDATE_BIN),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_stdio_env_clears_cloud_endpoints_in_local_mode_and_omits_credentials() {
        let mut raw = BTreeMap::new();
        raw.insert(keys::LODY_PLATFORM.to_string(), "local".to_string());
        raw.insert(keys::HOME.to_string(), "/Users/alice".to_string());
        raw.insert(
            keys::LODY_SERVER_URL.to_string(),
            "https://api.lody.ai".to_string(),
        );
        raw.insert(
            keys::LODY_AUTH_URL.to_string(),
            "https://auth.lody.ai".to_string(),
        );
        raw.insert("GH_TOKEN".to_string(), "ghp_secret".to_string());
        raw.insert("LODY_CLI_TOKEN".to_string(), "cli_secret".to_string());

        let host_env = HostEnv::from_lookup(|k| raw.get(k).cloned()).unwrap();
        let child_env = host_env.mcp_stdio_spawn_env(
            Path::new("/Users/alice/.lody-oss"),
            "sess-1",
            "local",
            "machine-1",
            Path::new("/Users/alice/repo"),
            Some(Path::new("/tmp/custom-control.sock")),
        );

        assert_eq!(
            child_env.get(keys::LODY_PLATFORM).map(String::as_str),
            Some("local")
        );
        assert!(!child_env.contains_key(keys::LODY_SERVER_URL));
        assert!(!child_env.contains_key(keys::LODY_AUTH_URL));
        assert!(!child_env.contains_key("GH_TOKEN"));
        assert!(!child_env.contains_key("LODY_CLI_TOKEN"));
        assert_eq!(
            child_env
                .get(keys::LODY_MCP_SOCKET_PATH)
                .map(String::as_str),
            Some("/tmp/custom-control.sock")
        );

        let parsed = McpStdioEnv::from_lookup(|k| child_env.get(k).cloned(), None).unwrap();
        assert_eq!(parsed.session_id, "sess-1");
        assert_eq!(parsed.workspace_id, "local");
        assert_eq!(parsed.machine_id, "machine-1");
        assert_eq!(parsed.workdir, "/Users/alice/repo");
        assert_eq!(
            parsed.socket_path_override,
            Some(PathBuf::from("/tmp/custom-control.sock"))
        );
    }
}
