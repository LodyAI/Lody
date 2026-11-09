import {
  AgentProviderOperationParams,
  AgentProviderOperationResult,
  AgentProviderOperationProgress,
  AgentProviderDetailParams,
  AgentProviderDetail,
  AgentProviderProbeParams,
  AgentProviderProbeResult,
  AgentProviderAuthParams,
  AgentProviderAuthState,
} from './provider-details.ts';
import { z } from 'zod/v4';
import {
  CatalogEvent,
  Empty,
  EnsureSessionParams,
  Grant,
  HelloParams,
  HelloResult,
} from './core.ts';
import { ProbeSchemaParams, ProbeSchemaReport } from './debug.ts';
import { GitHubMentionsParams, GitHubMentionsResult } from './github.ts';
import { MentionCatalog, MentionCatalogParams } from './mentions.ts';
import {
  IosSimulatorControlParams,
  IosSimulatorControlResult,
  SessionPreviewParams,
  SessionPreviewResult,
} from './preview.ts';
import {
  CreationOptions,
  CreationOptionsParams,
  LocalProjectsParams,
  LocalProjectsResult,
  ProjectGroupsParams,
  ProjectGroupsResult,
} from './projects.ts';
import {
  ScheduleCommandParams,
  ScheduleCommandResult,
  ScheduleDetail,
  ScheduleDetailParams,
  SchedulesParams,
  SchedulesResult,
} from './schedules.ts';
import {
  OpenSessionParams,
  ReleaseReserveParams,
  RestoreSessionsParams,
  SetActiveParams,
  StartParams,
} from './lifecycle.ts';
import {
  AgentProvidersParams,
  AgentProvidersResult,
  AgentRoleSnapshot,
  AgentRolesParams,
  RemoteSettingsParams,
  RemoteSettingsResult,
} from './settings.ts';
import {
  PublishedSharesParams,
  PublishedSharesResult,
  SessionSharingParams,
  SessionSharingResult,
  ShareProgressEvent,
  ShareRequestParams,
  ShareRequestResult,
} from './sharing.ts';
import {
  SessionCacheEvent,
  SessionEvent,
  SessionSubscriptionsEvent,
  SessionTraceEvent,
} from './session-events.ts';
import {
  PromptShortcutsParams,
  PromptShortcutsResult,
  ShortcutCloudParams,
  ShortcutCloudResult,
} from './shortcuts.ts';
import {
  DiagnosticEvent,
  MachinePresence,
  SyncErrorEvent,
  SyncedEvent,
} from './sync.ts';
import {
  DirectoryListing,
  DiffResult,
  FileContent,
  FileDiffParams,
  ListDirParams,
  ReadFileParams,
  TurnDiffParams,
  WorkspaceChanges,
  WorkspaceChangesParams,
} from './files.ts';
import { ItemDetail, ItemDetailParams } from './item-detail.ts';
import {
  ArchiveSessionParams,
  SetTabClosedParams,
  CheckTurnQuotaParams,
  CheckTurnQuotaResult,
  ControlTurnParams,
  ControlTurnResult,
  CreateSessionParams,
  CreateTabParams,
  ForkSessionParams,
  ForkSessionResult,
  CreateSessionResult,
  DeleteSessionParams,
  DeleteSessionResult,
  EditSessionParams,
  EditSessionResult,
  MarkSessionReadParams,
  PinSessionParams,
  RenameSessionParams,
  SetSessionOwnerParams,
  SessionWorkspacePathParams,
  SessionWorkspacePathResult,
  ConversationMarkdownParams,
  ConversationMarkdownResult,
  RespondPermissionParams,
  RespondPermissionResult,
  SendTurnParams,
  SendTurnResult,
} from './sessions.ts';

export type { Grant } from './core.ts';
export type {
  CheckTurnQuotaResult,
  ControlTurnResult,
  CreateSessionResult,
  EditSessionResult,
  SendTurnResult,
} from './sessions.ts';
export type { CreationOptions } from './projects.ts';
export type { SessionRuntimeEvent, SessionTrace } from './session-events.ts';
export type { ShareRequestParams } from './sharing.ts';
export type { ShortcutCloudParams } from './shortcuts.ts';

export type CallSpec = {
  params: z.ZodType;
  result: z.ZodType;
  timeoutMs: number;
};

export const runtimeCalls = {
  hello: { params: HelloParams, result: HelloResult, timeoutMs: 10_000 },
  ensureSession: {
    params: EnsureSessionParams,
    result: Empty,
    timeoutMs: 45_000,
  },
  start: { params: StartParams, result: Empty, timeoutMs: 10_000 },
  restoreSessions: {
    params: RestoreSessionsParams,
    result: Empty,
    timeoutMs: 10_000,
  },
  setActive: { params: SetActiveParams, result: Empty, timeoutMs: 10_000 },
  openSession: {
    params: OpenSessionParams,
    result: Empty,
    timeoutMs: 10_000,
  },
  closeSession: { params: Empty, result: Empty, timeoutMs: 10_000 },
  releaseReserve: {
    params: ReleaseReserveParams,
    result: Empty,
    timeoutMs: 10_000,
  },
  ping: { params: Empty, result: Empty, timeoutMs: 5_000 },
  promptShortcuts: {
    params: PromptShortcutsParams,
    result: PromptShortcutsResult,
    timeoutMs: 130_000,
  },
  remoteSettings: {
    params: RemoteSettingsParams,
    result: RemoteSettingsResult,
    timeoutMs: 45_000,
  },
  agentProviderOperation: {
    params: AgentProviderOperationParams,
    result: AgentProviderOperationResult,
    timeoutMs: 350000,
  },
  agentProviderDetail: {
    params: AgentProviderDetailParams,
    result: AgentProviderDetail,
    timeoutMs: 45000,
  },
  agentProviderProbe: {
    params: AgentProviderProbeParams,
    result: AgentProviderProbeResult,
    timeoutMs: 135000,
  },
  agentProviderAuth: {
    params: AgentProviderAuthParams,
    result: AgentProviderAuthState,
    timeoutMs: 60000,
  },
  agentProviders: {
    params: AgentProvidersParams,
    result: AgentProvidersResult,
    timeoutMs: 135_000,
  },
  agentRoles: {
    params: AgentRolesParams,
    result: AgentRoleSnapshot,
    timeoutMs: 45_000,
  },
  publishedShares: {
    params: PublishedSharesParams,
    result: PublishedSharesResult,
    timeoutMs: 70_000,
  },
  mentionCatalog: {
    params: MentionCatalogParams,
    result: MentionCatalog,
    timeoutMs: 45_000,
  },
  creationOptions: {
    params: CreationOptionsParams,
    result: CreationOptions,
    timeoutMs: 45_000,
  },
  projectGroups: {
    params: ProjectGroupsParams,
    result: ProjectGroupsResult,
    timeoutMs: 45_000,
  },
  schedules: {
    params: SchedulesParams,
    result: SchedulesResult,
    timeoutMs: 45_000,
  },
  scheduleDetail: {
    params: ScheduleDetailParams,
    result: ScheduleDetail,
    timeoutMs: 45_000,
  },
  scheduleCommand: {
    params: ScheduleCommandParams,
    result: ScheduleCommandResult,
    timeoutMs: 70_000,
  },
  localProjects: {
    params: LocalProjectsParams,
    result: LocalProjectsResult,
    timeoutMs: 130_000,
  },
  sessionSharing: {
    params: SessionSharingParams,
    result: SessionSharingResult,
    timeoutMs: 130_000,
  },
  sessionPreview: {
    params: SessionPreviewParams,
    result: SessionPreviewResult,
    timeoutMs: 330_000,
  },
  iosSimulatorControl: {
    params: IosSimulatorControlParams,
    result: IosSimulatorControlResult,
    timeoutMs: 100_000,
  },
  itemDetail: {
    params: ItemDetailParams,
    result: ItemDetail,
    timeoutMs: 45_000,
  },
  turnDiff: { params: TurnDiffParams, result: DiffResult, timeoutMs: 45_000 },
  fileDiff: { params: FileDiffParams, result: DiffResult, timeoutMs: 45_000 },
  workspaceChanges: {
    params: WorkspaceChangesParams,
    result: WorkspaceChanges,
    timeoutMs: 45_000,
  },
  readFile: { params: ReadFileParams, result: FileContent, timeoutMs: 45_000 },
  listDir: {
    params: ListDirParams,
    result: DirectoryListing,
    timeoutMs: 45_000,
  },
  createTab: {
    params: CreateTabParams,
    result: CreateSessionResult,
    timeoutMs: 45_000,
  },
  createSession: {
    params: CreateSessionParams,
    result: CreateSessionResult,
    timeoutMs: 45_000,
  },
  deleteSession: {
    params: DeleteSessionParams,
    result: DeleteSessionResult,
    timeoutMs: 45_000,
  },
  archiveSession: {
    params: ArchiveSessionParams,
    result: Empty,
    timeoutMs: 45_000,
  },
  setTabClosed: {
    params: SetTabClosedParams,
    result: Empty,
    timeoutMs: 45_000,
  },
  pinSession: { params: PinSessionParams, result: Empty, timeoutMs: 45_000 },
  markSessionRead: {
    params: MarkSessionReadParams,
    result: Empty,
    timeoutMs: 45_000,
  },
  renameSession: {
    params: RenameSessionParams,
    result: Empty,
    timeoutMs: 45_000,
  },
  setSessionOwner: {
    params: SetSessionOwnerParams,
    result: Empty,
    timeoutMs: 45_000,
  },
  sessionWorkspacePath: {
    params: SessionWorkspacePathParams,
    result: SessionWorkspacePathResult,
    timeoutMs: 15_000,
  },
  conversationMarkdown: {
    params: ConversationMarkdownParams,
    result: ConversationMarkdownResult,
    timeoutMs: 15_000,
  },
  checkTurnQuota: {
    params: CheckTurnQuotaParams,
    result: CheckTurnQuotaResult,
    timeoutMs: 45_000,
  },
  sendTurn: {
    params: SendTurnParams,
    result: SendTurnResult,
    timeoutMs: 45_000,
  },
  forkSession: {
    params: ForkSessionParams,
    result: ForkSessionResult,
    timeoutMs: 130_000,
  },
  editSession: {
    params: EditSessionParams,
    result: EditSessionResult,
    timeoutMs: 130_000,
  },
  controlTurn: {
    params: ControlTurnParams,
    result: ControlTurnResult,
    timeoutMs: 45_000,
  },
  respondPermission: {
    params: RespondPermissionParams,
    result: RespondPermissionResult,
    timeoutMs: 45_000,
  },
  probeSchema: {
    params: ProbeSchemaParams,
    result: ProbeSchemaReport,
    timeoutMs: 45_000,
  },
} satisfies Record<string, CallSpec>;

export const hostCalls = {
  grant: { params: Empty, result: Grant, timeoutMs: 30_000 },
  shortcutCloud: {
    params: ShortcutCloudParams,
    result: ShortcutCloudResult,
    timeoutMs: 20_000,
  },
  githubMentions: {
    params: GitHubMentionsParams,
    result: GitHubMentionsResult,
    timeoutMs: 35_000,
  },
  shareRequest: {
    params: ShareRequestParams,
    result: ShareRequestResult,
    timeoutMs: 65_000,
  },
} satisfies Record<string, CallSpec>;

export const runtimeEvents = {
  agentProviderAuthChanged: AgentProviderAuthState,
  agentProviderOperationProgress: AgentProviderOperationProgress,
  agentProvidersChanged: z
    .object({ machineId: z.string() })
    .meta({ id: 'AgentProvidersChangedEvent' }),
  catalog: CatalogEvent,
  shareProgress: ShareProgressEvent,
  creationOptionsChanged: Empty,
  machinePresence: MachinePresence,
  synced: SyncedEvent,
  syncError: SyncErrorEvent,
  sessionSubscriptions: SessionSubscriptionsEvent,
  session: SessionEvent,
  sessionCache: SessionCacheEvent,
  sessionTrace: SessionTraceEvent,
  diagnostic: DiagnosticEvent,
} satisfies Record<string, z.ZodType>;
