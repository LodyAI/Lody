#![forbid(unsafe_code)]

pub mod backend;
pub mod data_plane;
pub mod error;
pub mod execution;
pub mod identity;
pub mod storage;

pub use backend::{
    AuthMethodDescriptor, BackendNetworkPolicy, BackendPort, BackendProfile, BlobTransferPort,
    BlobUploadRequest, CANONICAL_LODY_CLOUD_ORIGIN, ControlPlanePort, E2eeControlPort,
    EntitlementPort, EntitlementStatus, IceServerConfig, IrohRelaySet, MachineAccessCheck,
    MachineAccessDecision, NegotiatedUploadPlan, PullRequestAssociation, ScmProviderKind,
    ScmProviderPort, ScmRepoCredential, StreamsSyncToken, TunnelProviderPort,
    WellKnownDiscoveryDocument, derive_recovery_service_locator,
};
pub use data_plane::{
    EnginePort, EpochKeyMaterial, HistoryBlock, HistoryPort, HistoryTurnRecord, QueuedDraftItem,
    SessionMetaSnapshot, SessionRunStatus, TurnTerminalOutcome,
};
pub use error::{PortError, PortErrorKind, PortResult};
pub use execution::{
    AcpEventSink, AcpInboundEvent, AcpLauncherPort, AcpNativeActivity, AcpSessionArchiveMode,
    AcpSessionArchiveOutcome, AcpSessionPort, AcpSpawnSpec, ArtifactRegistryPort, BranchListPage,
    BranchListQuery, CustomCommandSpec, FileSearchResult, InstalledArtifact,
    LocalProjectGitSummary, ManagedArtifactSource, McpHttpHeader, McpServerMount,
    PermissionDecision, PtyPort, ScannedFileEntry, ScannedFileIndex, SteerVerdict,
    TERMINAL_MAX_PER_SESSION, TerminalAttachReplay, TerminalEventSink, TerminalOpenOutcome,
    TerminalOpenSpec, TerminalOutboundEvent, TerminalSnapshot, UnavailablePtyPort, WorktreeLease,
    WorktreePort,
};
pub use identity::{
    AnchorSyncStatus, CapabilitySet, LocalProjectId, MAX_MACHINE_ID_LENGTH, MachineId,
    MachineIdentityPort, MachineIdentityRestoreOutcome, PlatformCapability, ProfileId, SessionId,
    StaticMachineIdentity, TurnId, UserId, VerifiedPrincipal, WorkspaceId, WorkspaceSecurityMode,
    parse_machine_id,
};
pub use storage::{
    AdmissionVerdict, AdmittedTurnInput, AutomationProgramRecord, AutomationStorePort,
    DelegatedResultRecord, DiffCaptureScope, DiffFileEntry, DiffStorePort, InboxCategory,
    InboxStorePort, LocalProjectRecord, MAX_SCHEDULE_PROMPT_BYTES, ProjectStorePort,
    ScheduleEditPatch, ScheduleProposalOutcome, ScheduleRecord, ScheduleStorePort,
    StorageLeaseMode, StorageLeasePort, SubmissionStage, TurnDiffCompression, TurnDiffEventInput,
    TurnDiffSummary, UnavailableScheduleStore,
};
