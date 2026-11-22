#![forbid(unsafe_code)]

use lody_ports::{
    AcpLauncherPort, AcpSessionPort, AcpSpawnSpec, ArtifactRegistryPort, InstalledArtifact,
    ManagedArtifactSource, PortError, PortErrorKind, PortResult,
};

pub struct ManagedArtifactInstaller {
    source: ManagedArtifactSource,
}

impl ManagedArtifactInstaller {
    pub fn new(source: ManagedArtifactSource) -> Self {
        Self { source }
    }
}

impl ArtifactRegistryPort for ManagedArtifactInstaller {
    fn source(&self) -> &ManagedArtifactSource {
        &self.source
    }

    fn ensure_installed(&self, artifact_id: &str, _version: &str) -> PortResult<InstalledArtifact> {
        if matches!(self.source, ManagedArtifactSource::Disabled) {
            return Err(PortError::capability_unavailable("managedRuntimeArtifacts"));
        }
        Err(PortError::new(
            PortErrorKind::Unavailable,
            format!("managed artifact installer not yet wired for '{artifact_id}'"),
        ))
    }
}

pub struct StdioAcpLauncher {
    max_concurrent_starts: usize,
}

impl StdioAcpLauncher {
    pub fn new(max_concurrent_starts: usize) -> Self {
        Self {
            max_concurrent_starts: max_concurrent_starts.max(1),
        }
    }
}

impl Default for StdioAcpLauncher {
    fn default() -> Self {
        Self::new(4)
    }
}

impl AcpLauncherPort for StdioAcpLauncher {
    fn max_concurrent_starts(&self) -> usize {
        self.max_concurrent_starts
    }

    fn launch_session(&self, spec: &AcpSpawnSpec) -> PortResult<Box<dyn AcpSessionPort>> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            format!("acp stdio launcher not yet wired for '{}'", spec.adapter_id),
        ))
    }
}
