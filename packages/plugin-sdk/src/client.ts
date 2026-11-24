import { createContext, createElement, useContext } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { z } from 'zod';
import type { PluginThemeSeedColors, PluginThemeTokens } from './manifest.js';
import {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  MAX_PLUGIN_RPC_REQUEST_BYTES,
  lodyCommands,
  lodyQueries,
  type AcpToolKind,
  type AgentProviderSummary,
  type AgentRoleSummary,
  type AttachmentItem,
  type AttachmentSnapshot,
  type AttachmentSourceDescriptor,
  type ClientHostEventMap,
  type ClientHostEventType,
  type CreateSessionRequest,
  type FilePreviewEntry,
  type InstalledPluginSummary,
  type InteractionOption,
  type InteractionOutcome,
  type LodyCommandDescriptor,
  type LodyQueryDescriptor,
  type MachineHostEventMap,
  type MachineHostEventType,
  type MachinePluginScope,
  type MachineRef,
  type MachineSummary,
  type MutationDescriptor,
  type ObservedToolCall,
  type ObservedToolLocation,
  type PendingInteractionSummary,
  type PluginCallError,
  type PluginCallErrorCode,
  type PluginScope,
  type ProjectRef,
  type ProjectSummary,
  type PullRequestSummary,
  type QueryDescriptor,
  type RawDocumentSnapshot,
  type RawSnapshotTarget,
  type ReadonlyJsonObject,
  type ReadonlyJsonPrimitive,
  type ReadonlyJsonValue,
  type RepositoryGitState,
  type RespondInteractionRequest,
  type ScheduleSummary,
  type ScopeTarget,
  type SendSessionMessageReceipt,
  type SendSessionMessageRequest,
  type SessionAutomationSummary,
  type SessionDetail,
  type SessionDiffSummary,
  type SessionRef,
  type SessionSummary,
  type SessionTurnRecord,
  type SessionTurnSummary,
  type SignedTurnOrigin,
  type SkillSummary,
  type SubagentRunDetail,
  type SubagentRunSummary,
  type ToolDescriptor,
  type TurnStopReason,
  type WorkspaceMemberSummary,
  type WorkspaceRef,
  type WorktreeEntry,
} from './index.js';

export {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  MAX_PLUGIN_RPC_REQUEST_BYTES,
  lodyCommands,
  lodyQueries,
  type AcpToolKind,
  type AgentProviderSummary,
  type AgentRoleSummary,
  type ClientHostEventMap,
  type ClientHostEventType,
  type CreateSessionRequest,
  type FilePreviewEntry,
  type InstalledPluginSummary,
  type InteractionOption,
  type InteractionOutcome,
  type LodyCommandDescriptor,
  type LodyQueryDescriptor,
  type MachineHostEventMap,
  type MachineHostEventType,
  type MachinePluginScope,
  type MachineRef,
  type MachineSummary,
  type ObservedToolCall,
  type ObservedToolLocation,
  type PendingInteractionSummary,
  type PluginCallError,
  type PluginCallErrorCode,
  type PluginScope,
  type PluginThemeSeedColors,
  type PluginThemeTokens,
  type ProjectRef,
  type ProjectSummary,
  type PullRequestSummary,
  type RawDocumentSnapshot,
  type RawSnapshotTarget,
  type ReadonlyJsonObject,
  type ReadonlyJsonPrimitive,
  type ReadonlyJsonValue,
  type RepositoryGitState,
  type RespondInteractionRequest,
  type ScheduleSummary,
  type SendSessionMessageReceipt,
  type SendSessionMessageRequest,
  type SessionAutomationSummary,
  type SessionDetail,
  type SessionDiffSummary,
  type SessionRef,
  type SessionSummary,
  type SessionTurnRecord,
  type SessionTurnSummary,
  type SignedTurnOrigin,
  type SkillSummary,
  type SubagentRunDetail,
  type SubagentRunSummary,
  type TurnStopReason,
  type WorkspaceMemberSummary,
  type WorkspaceRef,
  type WorktreeEntry,
};

export type AvailabilityReason = 'machine_offline' | 'unknown' | 'forbidden';

export type QueryResult<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T; readonly refresh: () => void }
  | {
      readonly status: 'unavailable';
      readonly reason: AvailabilityReason;
      readonly refresh: () => void;
    }
  | {
      readonly status: 'error';
      readonly message: string;
      readonly refresh: () => void;
    };

export interface MutationHandle<TInput, TOutput> {
  readonly mutate: (input: TInput) => Promise<TOutput>;
  readonly pending: boolean;
}

export interface HostCapabilities {
  readonly platform: 'desktop' | 'web' | 'mobile';
  readonly formFactor: 'wide' | 'compact';
  /**
   * Structural shell containers mounted by the current client host, named 1:1 after their
   * `ClientPluginRegistry` namespaces. Inline session/composer contributions (`tools`,
   * `messages`, `composer`, `sidebar.sessionRow`) and `manifest.config` are Core invariants
   * on every host.
   */
  readonly containers: {
    readonly sidebarViews: boolean;
    readonly sessionPanels: boolean;
    readonly screens: boolean;
    readonly projectPages: boolean;
  };
}

export type DraftItem =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'attachment'; readonly snapshot: AttachmentSnapshot };

export type ToolRenderProps<TInput, TOutput> = {
  readonly toolCallId: string;
  readonly input: TInput;
  readonly session: SessionRef;
  readonly project?: ProjectRef;
  readonly appendToDraft: (item: DraftItem) => void;
} & (
  | {
      readonly status: 'running';
      readonly output?: undefined;
    }
  | {
      readonly status: 'completed';
      readonly output: TOutput;
    }
);

/**
 * Declarative + predicate matcher allowing plugins to render built-in, ACP (Codex, Claude,
 * Antigravity, custom ACP), and MCP tool calls with deterministic priority and raw fallback.
 */
export interface ToolCallMatcher {
  readonly toolNames?: readonly string[];
  readonly mcpServer?: string;
  readonly acpKinds?: readonly AcpToolKind[];
  readonly commandPattern?: string;
  readonly when?: (call: ObservedToolCall) => boolean;
}

export interface MatchedToolRenderProps {
  readonly call: ObservedToolCall;
  readonly session: SessionRef;
  readonly project?: ProjectRef;
  readonly appendToDraft: (item: DraftItem) => void;
  /** Switches this tool row back to Lody's native raw terminal/tool detail sheet. */
  readonly showRawOutput: () => void;
}

export interface MessageBlockRenderProps {
  /** Owning assistant Turn ID, stable from Turn creation through completion. */
  readonly turnId: string;
  /**
   * Deterministic fenced-block identity (`<turnId>:block:<ordinal>`) preserved across streaming
   * chunks and `streaming: true -> false` closure so mounted React state is never reset mid-stream.
   */
  readonly blockId: string;
  readonly language: string;
  readonly code: string;
  readonly meta?: string;
  readonly streaming: boolean;
  readonly session: SessionRef;
  readonly project?: ProjectRef;
  readonly appendToDraft: (item: DraftItem) => void;
}

export interface ComposerActionProps {
  readonly session: SessionRef;
  readonly project?: ProjectRef;
  readonly appendToDraft: (item: DraftItem) => void;
}

export interface SessionPanelProps {
  readonly session: SessionRef;
  readonly project?: ProjectRef;
  readonly params: Readonly<Record<string, string>>;
}

export interface ScreenProps {
  readonly workspace: WorkspaceRef;
  readonly activeSession?: SessionRef;
  readonly params: Readonly<Record<string, string>>;
}

export interface ProjectPageProps {
  readonly workspace: WorkspaceRef;
  readonly project: ProjectRef;
  readonly params: Readonly<Record<string, string>>;
}

export interface InstallationSettingsProps {
  readonly workspace: WorkspaceRef;
  readonly machine: MachineRef;
  readonly pluginId: string;
  readonly version: string;
}

export interface SidebarItemProps {
  readonly workspace: WorkspaceRef;
  readonly activeSession?: SessionRef;
}

export interface SessionRowSlotProps {
  readonly workspace: WorkspaceRef;
  readonly session: SessionSummary;
  readonly active: boolean;
}

export interface SidebarViewProps {
  readonly workspace: WorkspaceRef;
  readonly activeSession?: SessionRef;
}

export interface SidebarRowProps {
  readonly icon?: ReactNode;
  readonly label: ReactNode;
  readonly trailing?: ReactNode;
  readonly selected?: boolean;
  readonly onClick?: () => void;
}

export const SidebarRow: ComponentType<SidebarRowProps> = (props) =>
  createElement(useBindings().SidebarRow, props);

export interface SessionRowProps {
  readonly session: SessionSummary;
  readonly selected?: boolean;
  readonly indent?: number;
  readonly leading?: ReactNode;
  readonly onClick?: () => void;
}

export const SessionRow: ComponentType<SessionRowProps> = (props) =>
  createElement(useBindings().SessionRow, props);

export interface PluginConfigHandle<
  TConfig extends Readonly<Record<string, ReadonlyJsonPrimitive>> = Readonly<
    Record<string, ReadonlyJsonPrimitive>
  >,
> {
  readonly values: TConfig;
  set<K extends keyof TConfig>(key: K, value: TConfig[K]): Promise<void>;
}

export interface ClientPluginRegistry {
  /** Aborts automatically when this client plugin instance disables or hot-reloads. */
  readonly signal: AbortSignal;
  /**
   * Subscribes to canonical host lifecycle & UI interaction events without DOM scraping or polling.
   * Subscriptions are automatically torn down when the plugin disables or hot-reloads.
   */
  readonly events: {
    on<K extends ClientHostEventType>(
      type: K,
      handler: (event: ClientHostEventMap[K]) => void | Promise<void>
    ): () => void;
  };
  readonly config: {
    get<
      TConfig extends Readonly<Record<string, ReadonlyJsonPrimitive>> = Readonly<
        Record<string, ReadonlyJsonPrimitive>
      >,
    >(): TConfig;
  };
  readonly assets: {
    url(relativePath: string): string;
  };
  readonly tools: {
    render<TInput extends z.ZodType, TOutput extends z.ZodType>(
      tool: ToolDescriptor<TInput, TOutput>,
      Component: ComponentType<ToolRenderProps<z.infer<TInput>, z.infer<TOutput>>>
    ): void;
    /**
     * Universal tool renderer matching built-in, ACP, or MCP tool calls.
     * In `"replace"` mode, Lody always provides a host-owned `"View Raw Output"` toggle and
     * `SurfaceErrorBoundary` fallback so ground-truth output can never be hidden or lost.
     */
    matchRender(spec: {
      readonly id: string;
      readonly match: ToolCallMatcher;
      readonly priority?: number;
      readonly mode?: 'replace' | 'enhance';
      readonly Component: ComponentType<MatchedToolRenderProps>;
    }): void;
  };
  readonly messages: {
    /**
     * Renders structured assistant fenced code blocks / custom artifacts inline with stable
     * `blockId` mount identity across streaming updates, paired with a host-owned
     * `"View Raw Markdown"` toggle and `SurfaceErrorBoundary` isolation.
     */
    renderBlock(spec: {
      readonly id: string;
      readonly languages: readonly string[];
      readonly priority?: number;
      readonly Component: ComponentType<MessageBlockRenderProps>;
    }): void;
  };
  readonly composer: {
    readonly attachments: {
      add<TMeta extends z.ZodType>(
        source: AttachmentSourceDescriptor<TMeta>,
        options?: { readonly renderItem?: (item: AttachmentItem) => ReactNode }
      ): void;
    };
    readonly actions: {
      add(spec: {
        readonly id: string;
        readonly title: string;
        readonly Component: ComponentType<ComposerActionProps>;
      }): void;
    };
  };
  readonly session: {
    readonly panels: {
      add(spec: {
        readonly id: string;
        readonly title: string;
        readonly Component: ComponentType<SessionPanelProps>;
      }): void;
    };
  };
  readonly screens: {
    add(spec: {
      readonly id: string;
      readonly title: string;
      readonly Component: ComponentType<ScreenProps>;
    }): void;
  };
  readonly project: {
    readonly pages: {
      add(spec: {
        readonly id: string;
        readonly title: string;
        readonly Component: ComponentType<ProjectPageProps>;
      }): void;
    };
  };
  readonly sidebar: {
    readonly sessionRow: {
      decorate(spec: {
        readonly id: string;
        readonly trailing?: ComponentType<SessionRowSlotProps>;
        readonly hoverCard?: ComponentType<SessionRowSlotProps>;
      }): void;
    };
    readonly headerItems: {
      add(spec: { readonly id: string; readonly Component: ComponentType<SidebarItemProps> }): void;
    };
    readonly footerItems: {
      add(spec: { readonly id: string; readonly Component: ComponentType<SidebarItemProps> }): void;
    };
    readonly views: {
      add(spec: {
        readonly id: string;
        readonly title: string;
        readonly Component: ComponentType<SidebarViewProps>;
      }): void;
    };
  };
  readonly settings: {
    readonly pages: {
      add(
        spec:
          | {
              readonly id: string;
              readonly title: string;
              readonly binding: 'project';
              readonly Component: ComponentType<ProjectPageProps>;
            }
          | {
              readonly id: string;
              readonly title: string;
              readonly binding: 'installation';
              readonly Component: ComponentType<InstallationSettingsProps>;
            }
      ): void;
    };
  };
  readonly themes: {
    add(spec: {
      readonly id: string;
      readonly label: string;
      readonly appearance: 'dark' | 'light';
      readonly seed: PluginThemeSeedColors;
      readonly tokens?: PluginThemeTokens;
    }): void;
  };
  readonly styles: {
    add(spec: { readonly id: string; readonly css: string }): void;
  };
}

export interface LodyClient {
  read<S extends PluginScope, TInput, TOutput>(
    target: ScopeTarget<S>,
    query: LodyQueryDescriptor<S, TInput, TOutput>,
    ...[input]: [void] extends [TInput] ? [input?: TInput] : [input: TInput]
  ): Promise<TOutput>;
  /**
   * Executes a typed command from Lody's shared `lodyCommands` registry with the exact same
   * authorization, StatusView planning, and E2EE signing rules as first-party UI actions.
   */
  execute<S extends PluginScope, TInput, TOutput>(
    target: ScopeTarget<S>,
    command: LodyCommandDescriptor<S, TInput, TOutput>,
    ...[input]: [void] extends [TInput] ? [input?: TInput] : [input: TInput]
  ): Promise<TOutput>;
  /**
   * Reads a detached, deeply frozen raw document/state-tree snapshot for power panels needing
   * upstream workspace or transcript fields beyond fixed `lodyQueries` summaries.
   */
  readSnapshot(target: RawSnapshotTarget): Promise<RawDocumentSnapshot>;
  readonly assets: {
    url(relativePath: string): string;
  };
  readonly sessions: {
    open(session: SessionRef): void;
    create(target: MachineRef | ProjectRef, request: CreateSessionRequest): Promise<SessionRef>;
    send(
      session: SessionRef,
      request: SendSessionMessageRequest
    ): Promise<SendSessionMessageReceipt>;
    /**
     * Resolves a pending ACP permission or elicitation interaction via `respondPermission`.
     */
    respondInteraction(session: SessionRef, request: RespondInteractionRequest): Promise<void>;
    requestStop(session: SessionRef): Promise<void>;
    requestArchive(session: SessionRef): Promise<void>;
  };
  readonly drafts: {
    open(
      target: MachineRef | ProjectRef,
      draft: {
        readonly prompt?: string;
        readonly roleId?: string;
        readonly providerId?: string;
        readonly skillIds?: readonly string[];
        readonly attachments?: readonly AttachmentSnapshot[];
      }
    ): void;
    append(session: SessionRef, item: DraftItem): void;
  };
  readonly panels: {
    openSession(
      session: SessionRef,
      panelId: string,
      params?: Readonly<Record<string, string>>
    ): void;
  };
  readonly screens: {
    open(
      workspace: WorkspaceRef,
      screenId: string,
      params?: Readonly<Record<string, string>>
    ): void;
  };
  readonly pages: {
    openProject(
      project: ProjectRef,
      pageId: string,
      params?: Readonly<Record<string, string>>
    ): void;
  };
  readonly themes: {
    activate(themeId: string): void;
  };
}

export function useLodyQuery<S extends PluginScope, TInput, TOutput>(
  target: ScopeTarget<S>,
  query: LodyQueryDescriptor<S, TInput, TOutput>,
  ...args: [void] extends [TInput] ? [input?: TInput] : [input: TInput]
): QueryResult<TOutput> {
  return useBindings().useLodyQuery(target, query, ...args);
}

export function useLodyCommand<S extends PluginScope, TInput, TOutput>(
  target: ScopeTarget<S>,
  command: LodyCommandDescriptor<S, TInput, TOutput>
): MutationHandle<TInput, TOutput> {
  return useBindings().useLodyCommand(target, command);
}

/**
 * Reactive subscription to a detached, read-only raw document/state-tree snapshot with optional
 * selector projection so custom Workspace / Agent dashboards re-render only on relevant changes.
 */
export function useLodySnapshot<TSelected = RawDocumentSnapshot>(
  target: RawSnapshotTarget,
  selector?: (snapshot: RawDocumentSnapshot) => TSelected,
  isEqual?: (prev: TSelected, next: TSelected) => boolean
): QueryResult<TSelected> {
  return useBindings().useLodySnapshot(target, selector, isEqual);
}

export function usePluginConfig<
  TConfig extends Readonly<Record<string, ReadonlyJsonPrimitive>> = Readonly<
    Record<string, ReadonlyJsonPrimitive>
  >,
>(): PluginConfigHandle<TConfig> {
  return useBindings().usePluginConfig();
}

export function useHostCapabilities(): HostCapabilities {
  return useBindings().useHostCapabilities();
}

export function useQuery<
  S extends MachinePluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  target: ScopeTarget<S>,
  query: QueryDescriptor<S, TInput, TOutput>,
  input: z.input<TInput>
): QueryResult<z.infer<TOutput>> {
  return useBindings().useQuery(target, query, input);
}

export function useMutation<
  S extends MachinePluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  target: ScopeTarget<S>,
  mutation: MutationDescriptor<S, TInput, TOutput>
): MutationHandle<z.input<TInput>, z.infer<TOutput>> {
  return useBindings().useMutation(target, mutation);
}

export function useLody(): LodyClient {
  return useBindings().useLody();
}

export type ClientPluginCleanup = () => void | Promise<void>;

export interface ClientPluginDefinition {
  readonly kind: 'client-plugin';
  readonly register: (lody: ClientPluginRegistry) => void | ClientPluginCleanup;
}

export function defineClientPlugin(
  register: (lody: ClientPluginRegistry) => void | ClientPluginCleanup
): ClientPluginDefinition {
  return { kind: 'client-plugin', register };
}

export interface ClientHostBindings {
  SidebarRow: ComponentType<SidebarRowProps>;
  SessionRow: ComponentType<SessionRowProps>;
  useLodyQuery: typeof useLodyQuery;
  useLodyCommand: typeof useLodyCommand;
  useLodySnapshot: typeof useLodySnapshot;
  usePluginConfig: typeof usePluginConfig;
  useHostCapabilities: typeof useHostCapabilities;
  useQuery: typeof useQuery;
  useMutation: typeof useMutation;
  useLody: typeof useLody;
}
const bindings = createContext<ClientHostBindings | null>(null);
export const ClientHostProvider = bindings.Provider;
function useBindings(): ClientHostBindings {
  const host = useContext(bindings);
  if (!host) throw new Error('Plugin rendered outside ClientHostProvider');
  return host;
}
