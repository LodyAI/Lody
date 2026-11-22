#![forbid(unsafe_code)]
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

pub mod keys {
    pub const HOME: &str = "HOME";
    pub const USERPROFILE: &str = "USERPROFILE";
    pub const LODY_DATA_DIR: &str = "LODY_DATA_DIR";
    pub const LODY_LOCKS_DIR: &str = "LODY_LOCKS_DIR";
    pub const LODY_PLATFORM: &str = "LODY_PLATFORM";
    pub const LODY_RUNTIME_BASE_URL: &str = "LODY_RUNTIME_BASE_URL";
    pub const LODY_LOG_LEVEL: &str = "LODY_LOG_LEVEL";
    pub const LODY_LOG_TRACE: &str = "LODY_LOG_TRACE";
    pub const HTTPS_PROXY: &str = "HTTPS_PROXY";
    pub const HTTP_PROXY: &str = "HTTP_PROXY";
    pub const NO_PROXY: &str = "NO_PROXY";
    pub const NO_COLOR: &str = "NO_COLOR";
    pub const LODY_CONFORMANCE_BIN: &str = "LODY_CONFORMANCE_BIN";
    pub const LODY_CONFORMANCE_BASELINE_BIN: &str = "LODY_CONFORMANCE_BASELINE_BIN";
    pub const LODY_CONFORMANCE_CANDIDATE_BIN: &str = "LODY_CONFORMANCE_CANDIDATE_BIN";
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
}

impl HostEnv {
    pub fn from_process() -> Result<Self, String> {
        Self::from_lookup(|key| std::env::var(key).ok())
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
        let https_proxy = trimmed(keys::HTTPS_PROXY).or_else(|| trimmed(keys::HTTP_PROXY));
        let no_proxy = trimmed(keys::NO_PROXY)
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default();

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
        })
    }

    pub fn locks_dir(&self, effective_data_dir: &Path) -> PathBuf {
        self.locks_dir_override
            .clone()
            .unwrap_or_else(|| effective_data_dir.join("locks"))
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
