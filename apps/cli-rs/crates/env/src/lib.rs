#![forbid(unsafe_code)]
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

pub mod keys {
    pub const HOME: &str = "HOME";
    pub const USERPROFILE: &str = "USERPROFILE";
    pub const SHELL: &str = "SHELL";
    pub const COMSPEC: &str = "ComSpec";
    pub const COLORTERM: &str = "COLORTERM";
    pub const TERM: &str = "TERM";
    pub const FORCE_COLOR: &str = "FORCE_COLOR";
    pub const LODY_DATA_DIR: &str = "LODY_DATA_DIR";
    pub const LODY_LOCKS_DIR: &str = "LODY_LOCKS_DIR";
    pub const LODY_PLATFORM: &str = "LODY_PLATFORM";
    pub const LODY_RUNTIME_BASE_URL: &str = "LODY_RUNTIME_BASE_URL";
    pub const LODY_LOG_LEVEL: &str = "LODY_LOG_LEVEL";
    pub const LODY_LOG_TRACE: &str = "LODY_LOG_TRACE";
    pub const LODY_SESSION_ID: &str = "LODY_SESSION_ID";
    pub const LODY_WORKSPACE_SESSION_ID: &str = "LODY_WORKSPACE_SESSION_ID";
    pub const HTTPS_PROXY: &str = "HTTPS_PROXY";
    pub const HTTPS_PROXY_LOWER: &str = "https_proxy";
    pub const HTTP_PROXY: &str = "HTTP_PROXY";
    pub const HTTP_PROXY_LOWER: &str = "http_proxy";
    pub const NO_PROXY: &str = "NO_PROXY";
    pub const NO_PROXY_LOWER: &str = "no_proxy";
    pub const NO_COLOR: &str = "NO_COLOR";
    pub const LODY_CONFORMANCE_BIN: &str = "LODY_CONFORMANCE_BIN";
    pub const LODY_CONFORMANCE_BASELINE_BIN: &str = "LODY_CONFORMANCE_BASELINE_BIN";
    pub const LODY_CONFORMANCE_CANDIDATE_BIN: &str = "LODY_CONFORMANCE_CANDIDATE_BIN";
}

pub const LOOPBACK_NO_PROXY_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

const TERMINAL_ENV_BLOCKLIST: [&str; 12] = [
    "ELECTRON_RUN_AS_NODE",
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
    pub locks_dir_override: Option<PathBuf>,
    pub runtime_base_url_override: Option<String>,
    pub log_level: Option<String>,
    pub log_trace: bool,
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

        let data_dir = match trimmed(keys::LODY_DATA_DIR) {
            Some(explicit) => PathBuf::from(explicit),
            None => match &home_dir {
                Some(home) => home.join(platform.data_directory_name()),
                None => PathBuf::from(platform.data_directory_name()),
            },
        };

        let locks_dir_override = trimmed(keys::LODY_LOCKS_DIR).map(PathBuf::from);
        let runtime_base_url_override = trimmed(keys::LODY_RUNTIME_BASE_URL);
        let log_level = trimmed(keys::LODY_LOG_LEVEL);
        let log_trace = trimmed(keys::LODY_LOG_TRACE)
            .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
        let https_proxy = trimmed(keys::HTTPS_PROXY)
            .or_else(|| trimmed(keys::HTTPS_PROXY_LOWER))
            .or_else(|| trimmed(keys::HTTP_PROXY))
            .or_else(|| trimmed(keys::HTTP_PROXY_LOWER));

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
            keys::SHELL,
            keys::COMSPEC,
            keys::COLORTERM,
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
            locks_dir_override,
            runtime_base_url_override,
            log_level,
            log_trace,
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

    pub fn agent_spawn_env(&self) -> BTreeMap<String, String> {
        let mut env = self.inherited_env.clone();
        apply_loopback_no_proxy(&mut env);
        env
    }

    pub fn sanitized_terminal_env(&self, session_id: &str) -> BTreeMap<String, String> {
        let mut env = self.inherited_env.clone();
        for blocked in TERMINAL_ENV_BLOCKLIST {
            env.remove(blocked);
        }
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
