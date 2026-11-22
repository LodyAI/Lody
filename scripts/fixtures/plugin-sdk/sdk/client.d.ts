import type { ComponentType, ReactNode } from "react";
import type { z } from "zod";
import type { PluginThemeSeedColors, PluginThemeTokens } from "./manifest";
import {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  MAX_PLUGIN_RPC_REQUEST_BYTES,
  lodyQueries,
  type AgentRoleSummary,
  type AnswerQuestionRequest,
  type AttachmentItem,
  type AttachmentSnapshot,
  type AttachmentSourceDescriptor,
  type CreateSessionRequest,
  type ElicitationOption,
  type ElicitationQuestion,
  type FilePreviewEntry,
  type LodyQueryDescriptor,
  type MachinePluginScope,
  type MachineRef,
  type MachineSummary,
  type MutationDescriptor,
  type PendingInteractionSummary,
  type PendingQuestionPrompt,
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
} from "./shared";

export {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  MAX_PLUGIN_RPC_REQUEST_BYTES,
  lodyQueries,
  type AgentRoleSummary,
  type AnswerQuestionRequest,
  type CreateSessionRequest,
  type ElicitationOption,
  type ElicitationQuestion,
  type FilePreviewEntry,
  type LodyQueryDescriptor,
  type MachinePluginScope,
  type MachineRef,
  type MachineSummary,
  type PendingInteractionSummary,
  type PendingQuestionPrompt,
  type PluginCallError,
  type PluginCallErrorCode,
  type PluginScope,
  type PluginThemeSeedColors,
  type PluginThemeTokens,
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

export type AvailabilityReason = "machine_offline" | "unknown" | "forbidden";

export type QueryResult<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T; readonly refresh: () => void }
  | {
      readonly status: "unavailable";
      readonly reason: AvailabilityReason;
      readonly refresh: () => void;
    }
  | {
      readonly status: "error";
      readonly message: string;
      readonly refresh: () => void;
    };

export interface MutationHandle<TInput, TOutput> {
  readonly mutate: (input: TInput) => Promise<TOutput>;
  readonly pending: boolean;
}

export type DraftItem =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "attachment"; readonly snapshot: AttachmentSnapshot };

export type ToolRenderProps<TInput, TOutput> = {
  readonly toolCallId: string;
  readonly input: TInput;
  readonly session: SessionRef;
  readonly project?: ProjectRef;
  readonly appendToDraft: (item: DraftItem) => void;
} & (
  | {
      readonly status: "running";
      readonly output?: undefined;
    }
  | {
      readonly status: "completed";
      readonly output: TOutput;
    }
);

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

export interface SidebarItemProps {
  readonly workspace: WorkspaceRef;
  readonly activeSession?: SessionRef;
}

export interface SessionRowSlotProps {
  readonly workspace: WorkspaceRef;
  readonly session: SessionSummary;
  readonly active: boolean;
}

/**
 * Paseo-style pure custom sidebar view body rendered between the sidebar header and footer.
 * Multiple plugins may contribute selectable sidebar views (`"Default"`, `"Agent Tree"`, `"T3 Cards"`)
 * without overwriting one another via a singleton `replace` or relying on toy host filter schemas.
 */
export interface SidebarViewProps {
  readonly workspace: WorkspaceRef;
  readonly activeSession?: SessionRef;
}

/**
 * Native sidebar navigation row primitive backed by `sidebarSurface` (`packages/components`),
 * ensuring `sidebar.headerItems` / `footerItems` and custom views match built-in row metrics.
 */
export interface SidebarRowProps {
  readonly icon?: ReactNode;
  readonly label: ReactNode;
  readonly trailing?: ReactNode;
  readonly selected?: boolean;
  readonly onClick?: () => void;
}

export declare const SidebarRow: ComponentType<SidebarRowProps>;

/**
 * Native session row primitive backed by `sidebarSurface` that automatically composes every
 * enabled `sidebar.sessionRow` decorator (`trailing` badges and `hoverCard` popovers), even
 * when rendered inside a plugin's custom `sidebar.views` tree.
 */
export interface SessionRowProps {
  readonly session: SessionSummary;
  readonly selected?: boolean;
  readonly indent?: number;
  readonly leading?: ReactNode;
  readonly onClick?: () => void;
}

export declare const SessionRow: ComponentType<SessionRowProps>;

export interface ClientPluginRegistry {
  readonly tools: {
    render<TInput extends z.ZodType, TOutput extends z.ZodType>(
      tool: ToolDescriptor<TInput, TOutput>,
      Component: ComponentType<
        ToolRenderProps<z.infer<TInput>, z.infer<TOutput>>
      >,
    ): void;
  };
  readonly composer: {
    readonly attachments: {
      add<TMeta extends z.ZodType>(
        source: AttachmentSourceDescriptor<TMeta>,
        options?: { readonly renderItem?: (item: AttachmentItem) => ReactNode },
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
    /** Registers a full main-area canvas/workspace screen (e.g. Swarm Hub or PR Review Center). */
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
  /**
   * Three orthogonal sidebar extension layers:
   * 1. `sessionRow.decorate`: Composable row-level badges & interactive hover popovers (e.g.
   *    answering `ask_user_question` on hover without switching threads) across native and `<SessionRow />` views.
   * 2. `headerItems` / `footerItems`: Native `<SidebarRow />` navigation entries opening `screens` or popovers.
   * 3. `views.add`: Selectable full custom sidebar body between header and footer (e.g. Swarm tree or card layout).
   */
  readonly sidebar: {
    readonly sessionRow: {
      decorate(spec: {
        readonly id: string;
        readonly trailing?: ComponentType<SessionRowSlotProps>;
        readonly hoverCard?: ComponentType<SessionRowSlotProps>;
      }): void;
    };
    readonly headerItems: {
      add(spec: {
        readonly id: string;
        readonly Component: ComponentType<SidebarItemProps>;
      }): void;
    };
    readonly footerItems: {
      add(spec: {
        readonly id: string;
        readonly Component: ComponentType<SidebarItemProps>;
      }): void;
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
              readonly binding: "project";
              readonly Component: ComponentType<ProjectPageProps>;
            }
          | {
              readonly id: string;
              readonly title: string;
              readonly binding: "installation";
              readonly Component: ComponentType<InstallationSettingsProps>;
            },
      ): void;
    };
  };
  /**
   * Stable SemVer theme contract: derives root CSS custom properties (`vscode-theme-dom.ts`)
   * for colors, typography, radius, and density across app chrome, diffs, Monaco, Shiki, and terminal.
   */
  readonly themes: {
    add(spec: {
      readonly id: string;
      readonly label: string;
      readonly appearance: "dark" | "light";
      readonly seed: PluginThemeSeedColors;
      readonly tokens?: PluginThemeTokens;
    }): void;
  };
  /**
   * Host-managed custom CSS snippets (Obsidian-style escape hatch) for local opt-in customization.
   * Tracked per plugin installation so disablement/HMR removes `<style>` cleanly and `lody --safe-mode`
   * bypasses all injected stylesheets. Documented CSS variables (`--*`) are SemVer-stable; internal
   * React DOM hierarchy is not frozen.
   */
  readonly styles: {
    add(spec: { readonly id: string; readonly css: string }): void;
  };
}

/**
 * Programmatic Lody Client SDK handle exposed inside client plugins via `useLody()`.
 */
export interface LodyClient {
  read<S extends PluginScope, TInput, TOutput>(
    target: ScopeTarget<S>,
    query: LodyQueryDescriptor<S, TInput, TOutput>,
    ...[input]: [void] extends [TInput] ? [input?: TInput] : [input: TInput]
  ): Promise<TOutput>;
  readonly sessions: {
    open(session: SessionRef): void;
    create(
      target: MachineRef | ProjectRef,
      request: CreateSessionRequest,
    ): Promise<SessionRef>;
    send(
      session: SessionRef,
      request: SendSessionMessageRequest,
    ): Promise<SendSessionMessageReceipt>;
    /**
     * Submits user answers to a pending `ask_user_question` elicitation without switching the
     * active Session, authoring the response through `WorkspaceWriter.respondSessionPermission`
     * (non-Guest authorized in E2EE workspaces). Tool `permission` prompts remain strictly owned
     * by Lody's trusted kernel UI and are rejected here.
     */
    answerQuestion(
      session: SessionRef,
      request: AnswerQuestionRequest,
    ): Promise<void>;
    requestStop(session: SessionRef): Promise<void>;
    requestArchive(session: SessionRef): Promise<void>;
  };
  readonly drafts: {
    open(
      target: MachineRef | ProjectRef,
      draft: {
        readonly prompt?: string;
        readonly roleId?: string;
        readonly skillIds?: readonly string[];
        readonly attachments?: readonly AttachmentSnapshot[];
      },
    ): void;
    append(session: SessionRef, item: DraftItem): void;
  };
  readonly panels: {
    /** Opens a companion Session side panel registered by this plugin and passes URL-safe params. */
    openSession(
      session: SessionRef,
      panelId: string,
      params?: Readonly<Record<string, string>>,
    ): void;
  };
  readonly screens: {
    open(
      workspace: WorkspaceRef,
      screenId: string,
      params?: Readonly<Record<string, string>>,
    ): void;
  };
  readonly pages: {
    openProject(
      project: ProjectRef,
      pageId: string,
      params?: Readonly<Record<string, string>>,
    ): void;
  };
  readonly themes: {
    /** Switches the local client's active theme to a built-in or plugin-contributed theme ID. */
    activate(themeId: string): void;
  };
}

/**
 * Subscribes to Lody's built-in raw reactive stores (shared Loro/Flock rooms & presence) or
 * authenticated host network / `MachineRpc` adapters (`lodyQueries.*`).
 */
export declare function useLodyQuery<S extends PluginScope, TInput, TOutput>(
  target: ScopeTarget<S>,
  query: LodyQueryDescriptor<S, TInput, TOutput>,
  ...[input]: [void] extends [TInput] ? [input?: TInput] : [input: TInput]
): QueryResult<TOutput>;

/**
 * Subscribes to a plugin-defined `QueryDescriptor` routed to the target machine's plugin process.
 */
export declare function useQuery<
  S extends MachinePluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  target: ScopeTarget<S>,
  query: QueryDescriptor<S, TInput, TOutput>,
  input: z.input<TInput>,
): QueryResult<z.infer<TOutput>>;

export declare function useMutation<
  S extends MachinePluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  target: ScopeTarget<S>,
  mutation: MutationDescriptor<S, TInput, TOutput>,
): MutationHandle<z.input<TInput>, z.infer<TOutput>>;

export declare function useLody(): LodyClient;

export type ClientPluginCleanup = () => void | Promise<void>;

export interface ClientPluginDefinition {
  readonly kind: "client-plugin";
  readonly register: (lody: ClientPluginRegistry) => void | ClientPluginCleanup;
}

export declare function defineClientPlugin(
  register: (lody: ClientPluginRegistry) => void | ClientPluginCleanup,
): ClientPluginDefinition;
