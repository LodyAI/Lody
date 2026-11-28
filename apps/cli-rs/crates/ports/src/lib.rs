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
    EnginePort, EpochKeyMaterial, HistoryBlock, HistoryPort, HistoryTurnRecord,
    MAX_SCHEDULE_PROMPT_BYTES, MachineSignTurnRequest, MachineSignedTurnIntent, QueuedDraftItem,
    ScheduleDestination, ScheduleEditPatch, ScheduleMisfirePolicy, ScheduleOverlapPolicy,
    ScheduleProposalInput, ScheduleProposalOutcome, ScheduleRecord, ScheduleRepoPort,
    ScheduleRetryPolicy, SessionMetaSnapshot, SessionPullRequestLink, SessionRunStatus,
    TurnTerminalOutcome, UnavailableScheduleRepo, validate_schedule_identifier,
    validate_schedule_prompt, validate_schedule_rule, validate_schedule_title,
};
pub use error::{PortError, PortErrorKind, PortResult};
pub use execution::{
    AcpEventSink, AcpInboundEvent, AcpLauncherPort, AcpNativeActivity, AcpSessionArchiveMode,
    AcpSessionArchiveOutcome, AcpSessionPort, AcpSpawnSpec, ArtifactRegistryPort,
    AutomationHostOps, AutomationProgramContext, AutomationProgramEvaluation,
    AutomationSandboxPort, BranchListPage, BranchListQuery, BrowseDirectoryEntry,
    BrowseDirectoryPage, BrowseDirectoryQuery, BrowseEntryHints, BrowseRootsInfo,
    CheckoutBranchOutcome, CustomCommandSpec, DirectoryChildEntry, DirectoryListPage,
    FileSearchResult, InstalledArtifact, LocalProjectGitSummary, ManagedArtifactSource, McpEnvVar,
    McpHttpHeader, McpServerMount, McpServerTransport, PermissionDecision, PreparedProjectAdd,
    ProjectFileReadResult, ProjectSkillEntry, ProjectSkillGroupEntry, ProjectSkillsListing,
    PtyPort, ScannedFileEntry, ScannedFileIndex, SteerVerdict, TERMINAL_MAX_PER_SESSION,
    TerminalAttachReplay, TerminalEventSink, TerminalOpenOutcome, TerminalOpenSpec,
    TerminalOutboundEvent, TerminalSnapshot, UnavailableAutomationSandbox, UnavailablePtyPort,
    WorktreeLease, WorktreePort,
};
pub use identity::{
    AnchorSyncStatus, CapabilitySet, LocalProjectId, MAX_MACHINE_ID_LENGTH, MachineId,
    MachineIdentityPort, MachineIdentityRestoreOutcome, PlatformCapability, ProfileId, SessionId,
    StaticMachineIdentity, TurnId, UserId, VerifiedPrincipal, WorkspaceId, WorkspaceSecurityMode,
    parse_machine_id,
};
pub use storage::{
    AdmissionVerdict, AdmittedTurnInput, AutomationActivityCursor, AutomationActivityPage,
    AutomationEvidenceEntry, AutomationManagedRun, AutomationMatchResult,
    AutomationReadObservation, AutomationReceiptPatch, AutomationReceiptRecord,
    AutomationReceiptState, AutomationRegistrationInput, AutomationRunExit, AutomationRunInput,
    AutomationRunOutcome, AutomationStorePort, AutomationWaitCompletion, AutomationWaitRecord,
    AutomationWaitState, AutomationWorkspaceScope, DelegatedResultRecord, DiffCaptureScope,
    DiffFileEntry, DiffStorePort, InboxCategory, InboxStorePort, LocalProjectRecord,
    PrPollerRepoCooldown, PrPollerScopeBucket, PrPollerStorePort, ProjectStorePort,
    ScheduleCursorRecord, ScheduleLedgerPort, ScheduleLedgerRunRecord, ScheduleRunState,
    StorageLeaseMode, StorageLeasePort, SubmissionStage, TurnDiffCompression, TurnDiffEventInput,
    TurnDiffSummary, UnavailableAutomationStore, UnavailablePrPollerStore,
    UnavailableScheduleLedger,
};
