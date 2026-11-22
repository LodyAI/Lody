import type { ComponentType, ReactNode } from 'react';
import type { z } from 'zod';
import {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  MAX_PLUGIN_RPC_REQUEST_BYTES,
  hostQueries,
  lodyQueries,
  type AgentRoleSummary,
  type AttachmentItem,
  type AttachmentSnapshot,
  type AttachmentSourceDescriptor,
  type BusinessKeyScope,
  type CreateSessionRequest,
  type FilePreviewEntry,
  type HostQueryDescriptor,
  type LodyQueryDescriptor,
  type MachinePluginScope,
  type MachineRef,
  type MachineSummary,
  type MutationDescriptor,
  type PluginCallError,
  type PluginCallErrorCode,
  type PluginScope,
  type ProjectRef,
  type ProjectSummary,
  type PullRequestSummary,
  type QueryDescriptor,
  type RepositoryGitState,
  type ScheduleSummary,
  type ScopeTarget,
  type SendSessionMessageReceipt,
  type SendSessionMessageRequest,
  type SessionDetail,
  type SessionDiffSummary,
  type SessionRef,
  type SessionSummary,
  type SessionTurnSummary,
  type SkillSummary,
  type ToolDescriptor,
  type WorkspaceMemberSummary,
  type WorkspaceRef,
  type WorktreeEntry,
} from './shared';

export {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  MAX_PLUGIN_RPC_REQUEST_BYTES,
  hostQueries,
  lodyQueries,
  type AgentRoleSummary,
  type BusinessKeyScope,
  type CreateSessionRequest,
  type FilePreviewEntry,
  type HostQueryDescriptor,
  type LodyQueryDescriptor,
  type MachinePluginScope,
  type MachineRef,
  type MachineSummary,
  type PluginCallError,
  type PluginCallErrorCode,
  type PluginScope,
  type ProjectRef,
  type ProjectSummary,
  type PullRequestSummary,
  type RepositoryGitState,
  type ScheduleSummary,
  type SendSessionMessageReceipt,
  type SendSessionMessageRequest,
  type SessionDetail,
  type SessionDiffSummary,
  type SessionRef,
  type SessionSummary,
  type SessionTurnSummary,
  type SkillSummary,
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
  | { readonly status: 'error'; readonly message: string; readonly refresh: () => void };

export interface MutationHandle<TInput, TOutput> {
  readonly mutate: (input: TInput) => Promise<TOutput>;
  readonly pending: boolean;
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

export interface ResultRenderProps<TContent> {
  readonly content: TContent;
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

export interface WorkspacePageProps {
  readonly workspace: WorkspaceRef;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Surface props carry only capability references and URL params; raw repository/session/catalog
 * data is pulled reactively via `useLodyQuery` / `useQuery` rather than stuffed into props.
 */
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

export interface SidebarFilterSpec {
  readonly id: string;
  readonly label: string;
  readonly defaultValue: boolean;
}

export interface SidebarViewProps {
  readonly workspace: WorkspaceRef;
  readonly activeSession?: SessionRef;
  readonly taskScope?: 'mine' | 'all';
  readonly filters: Readonly<Record<string, boolean>>;
}

export interface SidebarReplaceProps {
  readonly workspace: WorkspaceRef;
  readonly activeSession?: SessionRef;
}

export interface ShellOverlayProps {
  readonly workspace: WorkspaceRef;
  readonly activeSession?: SessionRef;
}

export interface StatusBarItemProps {
  readonly workspace: WorkspaceRef;
  readonly activeSession?: SessionRef;
}

export interface ClientPluginRegistry {
  readonly tools: {
    render<TInput extends z.ZodType, TOutput extends z.ZodType>(
      tool: ToolDescriptor<TInput, TOutput>,
      Component: ComponentType<ToolRenderProps<z.infer<TInput>, z.infer<TOutput>>>
    ): void;
  };
  readonly results: {
    add<TSchema extends z.ZodType>(spec: {
      readonly id: string;
      readonly title: string;
      readonly mimeType: string;
      readonly schema: TSchema;
      readonly Component: ComponentType<ResultRenderProps<z.infer<TSchema>>>;
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
  readonly project: {
    readonly pages: {
      add(spec: {
        readonly id: string;
        readonly title: string;
        readonly Component: ComponentType<ProjectPageProps>;
      }): void;
    };
  };
  readonly workspace: {
    readonly pages: {
      add(spec: {
        readonly id: string;
        readonly title: string;
        readonly Component: ComponentType<WorkspacePageProps>;
      }): void;
    };
  };
  readonly sidebar: {
    readonly views: {
      add(spec: {
        readonly id: string;
        readonly title: string;
        readonly taskScope?: boolean;
        readonly filters?: readonly SidebarFilterSpec[];
        readonly Component: ComponentType<SidebarViewProps>;
      }): void;
    };
    /**
     * Replaces the default sidebar body with a custom plugin-rendered sidebar (e.g. a multi-Agent
     * Swarm hierarchy or Role-lane board built on `useLodyQuery(workspace, lodyQueries.sessions)`),
     * while the host retains a minimal switcher + `--safe-mode` escape hatch.
     */
    replace(spec: {
      readonly id: string;
      readonly title: string;
      readonly Component: ComponentType<SidebarReplaceProps>;
    }): void;
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
  /**
   * Local client appearance & shell extensions (`styles`, `shell.overlays`, `shell.statusBar`, `commands`).
   * Active for the opting-in local user/profile without auto-propagating to other collaborators' clients;
   * cleanly disposed on plugin disablement/HMR and bypassed via `lody --safe-mode`.
   */
  readonly styles: {
    add(spec: { readonly id: string; readonly css: string }): void;
  };
  readonly shell: {
    readonly overlays: {
      add(spec: {
        readonly id: string;
        readonly Component: ComponentType<ShellOverlayProps>;
      }): void;
    };
    readonly statusBar: {
      add(spec: {
        readonly id: string;
        readonly align?: 'left' | 'right';
        readonly Component: ComponentType<StatusBarItemProps>;
      }): void;
    };
  };
  readonly commands: {
    add(spec: {
      readonly id: string;
      readonly title: string;
      readonly defaultShortcut?: string;
      readonly run: (ctx: {
        readonly workspace: WorkspaceRef;
        readonly activeSession?: SessionRef;
        readonly host: HostActions;
      }) => void | Promise<void>;
    }): void;
  };
}

export interface HostActions {
  readonly sessions: {
    open(session: SessionRef): void;
    create(target: MachineRef | ProjectRef, request: CreateSessionRequest): Promise<SessionRef>;
    send(
      session: SessionRef,
      request: SendSessionMessageRequest
    ): Promise<SendSessionMessageReceipt>;
    requestStop(session: SessionRef): Promise<void>;
    requestArchive(session: SessionRef): Promise<void>;
  };
  readonly drafts: {
    open(
      target: MachineRef | ProjectRef,
      draft: {
        readonly prompt?: string;
        readonly roleId?: string;
        readonly pluginRoleId?: string;
        readonly skillIds?: readonly string[];
        readonly attachments?: readonly AttachmentSnapshot[];
      }
    ): void;
    append(session: SessionRef, item: DraftItem): void;
  };
  readonly panels: {
    /** Opens a companion Session side panel registered by this plugin and passes URL-safe params. */
    openSession(
      session: SessionRef,
      panelId: string,
      params?: Readonly<Record<string, string>>
    ): void;
  };
  readonly pages: {
    openProject(
      project: ProjectRef,
      pageId: string,
      params?: Readonly<Record<string, string>>
    ): void;
    openWorkspace(
      workspace: WorkspaceRef,
      pageId: string,
      params?: Readonly<Record<string, string>>
    ): void;
  };
  readonly themes: {
    /** Switches the client's active theme to a built-in or plugin-contributed theme ID. */
    activate(themeId: string): void;
  };
}

/**
 * Subscribes to Lody's built-in raw reactive stores (shared Loro/Flock rooms & presence) or
 * authenticated host network / `MachineRpc` adapters (`lodyQueries.*`).
 */
export declare function useLodyQuery<S extends PluginScope, TOutput>(
  target: ScopeTarget<S>,
  query: LodyQueryDescriptor<S, void, TOutput>
): QueryResult<TOutput>;

export declare function useLodyQuery<S extends PluginScope, TInput, TOutput>(
  target: ScopeTarget<S>,
  query: LodyQueryDescriptor<S, TInput | void, TOutput>,
  input?: TInput
): QueryResult<TOutput>;

export declare function useLodyQuery<S extends PluginScope, TInput, TOutput>(
  target: ScopeTarget<S>,
  query: LodyQueryDescriptor<S, TInput, TOutput>,
  input: TInput
): QueryResult<TOutput>;

export declare function useQuery<
  S extends MachinePluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  target: ScopeTarget<S>,
  query: QueryDescriptor<S, TInput, TOutput>,
  input: z.input<TInput>
): QueryResult<z.infer<TOutput>>;

export declare function useQuery<S extends PluginScope, TInput, TOutput>(
  target: ScopeTarget<S>,
  query: LodyQueryDescriptor<S, TInput, TOutput>,
  input: TInput
): QueryResult<TOutput>;

export declare function useMutation<
  S extends MachinePluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  target: ScopeTarget<S>,
  mutation: MutationDescriptor<S, TInput, TOutput>
): MutationHandle<z.input<TInput>, z.infer<TOutput>>;

export declare function usePluginSettings<
  TValues extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
>(
  target?: ProjectRef | MachineRef
): {
  readonly values: TValues;
  readonly update: (patch: Partial<TValues>) => Promise<void>;
};

export declare function useHost(): HostActions;

export type ClientPluginCleanup = () => void;

export interface ClientPluginDefinition {
  readonly kind: 'client-plugin';
  readonly register: (lody: ClientPluginRegistry) => void | ClientPluginCleanup;
}

export declare function defineClientPlugin(
  register: (lody: ClientPluginRegistry) => void | ClientPluginCleanup
): ClientPluginDefinition;
