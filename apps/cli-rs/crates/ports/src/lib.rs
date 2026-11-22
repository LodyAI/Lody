#![forbid(unsafe_code)]

pub mod backend;
pub mod data_plane;
pub mod error;
pub mod execution;
pub mod identity;
pub mod storage;

pub use backend::{
    AuthMethodDescriptor, BackendNetworkPolicy, BackendPort, BackendProfile, BlobTransferPort,
    BlobUploadRequest, ControlPlanePort, E2eeControlPort, EntitlementPort, EntitlementStatus,
    IceServerConfig, IrohRelaySet, MachineAccessCheck, MachineAccessDecision, NegotiatedUploadPlan,
    PullRequestAssociation, ScmProviderKind, ScmProviderPort, ScmRepoCredential, StreamsSyncToken,
    TunnelProviderPort, WellKnownDiscoveryDocument,
};
pub use data_plane::{
    EnginePort, EpochKeyMaterial, HistoryBlock, HistoryPort, HistoryTurnRecord, QueuedDraftItem,
    SessionMetaSnapshot, SessionRunStatus, TurnTerminalOutcome,
};
pub use error::{PortError, PortErrorKind, PortResult};
pub use execution::{
    AcpEventSink, AcpInboundEvent, AcpLauncherPort, AcpSessionPort, AcpSpawnSpec,
    ArtifactRegistryPort, CustomCommandSpec, InstalledArtifact, ManagedArtifactSource,
    McpServerMount, PermissionDecision, PtyPort, PtySpawnSpec, SteerVerdict, WorktreeLease,
    WorktreePort,
};
pub use identity::{
    CapabilitySet, LocalProjectId, MachineId, PlatformCapability, ProfileId, SessionId, TurnId,
    UserId, VerifiedPrincipal, WorkspaceId, WorkspaceSecurityMode,
};
pub use storage::{
    AdmissionVerdict, AdmittedTurnInput, AutomationProgramRecord, AutomationStorePort,
    DiffFileEntry, DiffStorePort, InboxCategory, InboxStorePort, LocalProjectRecord,
    ProjectStorePort, ScheduleRecord, ScheduleStorePort, StorageLeaseMode, StorageLeasePort,
    SubmissionStage, TurnDiffSummary,
};
