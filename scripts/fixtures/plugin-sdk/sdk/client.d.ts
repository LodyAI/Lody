import type { ComponentType, ReactNode } from 'react';
import type { z } from 'zod';
import {
  hostQueries,
  type AttachmentItem,
  type AttachmentSnapshot,
  type AttachmentSourceDescriptor,
  type CreateSessionRequest,
  type HostQueryDescriptor,
  type MutationDescriptor,
  type PluginCallError,
  type PluginCallErrorCode,
  type PluginScope,
  type ProjectRef,
  type ProjectSummary,
  type PullRequestSummary,
  type QueryDescriptor,
  type ScopeTarget,
  type SessionRef,
  type SessionSummary,
  type ToolDescriptor,
  type WorkspaceRef,
  type WorktreeEntry,
} from './shared';

export {
  hostQueries,
  type CreateSessionRequest,
  type HostQueryDescriptor,
  type PluginCallError,
  type PluginCallErrorCode,
  type ProjectSummary,
  type PullRequestSummary,
  type SessionSummary,
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

export interface ToolRenderProps<TInput, TOutput> {
  readonly input: TInput;
  readonly output: TOutput;
  readonly session: SessionRef;
  readonly project?: ProjectRef;
  readonly appendToDraft: (item: DraftItem) => void;
}

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
}

export type RepositoryState = 'available' | 'none' | 'unavailable' | 'unknown';

export interface WorkspacePageProps {
  readonly workspace: WorkspaceRef;
  readonly params: Readonly<Record<string, string>>;
}

export interface ProjectPageProps {
  readonly workspace: WorkspaceRef;
  readonly project: ProjectRef;
  readonly repositoryState: RepositoryState;
  readonly params: Readonly<Record<string, string>>;
}

export interface InstallationSettingsProps {
  readonly workspace: WorkspaceRef;
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
}

export interface HostActions {
  readonly sessions: {
    open(session: SessionRef): void;
    create(project: ProjectRef, request: CreateSessionRequest): Promise<SessionRef>;
    requestArchive(session: SessionRef): Promise<void>;
  };
  readonly drafts: {
    open(
      project: ProjectRef,
      draft: {
        readonly prompt?: string;
        readonly roleId?: string;
        readonly skillIds?: readonly string[];
        readonly attachments?: readonly AttachmentSnapshot[];
      }
    ): void;
    append(session: SessionRef, item: DraftItem): void;
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
}

export declare function useQuery<
  S extends PluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  target: ScopeTarget<S>,
  query: QueryDescriptor<S, TInput, TOutput>,
  input: z.input<TInput>
): QueryResult<z.infer<TOutput>>;

export declare function useQuery<S extends PluginScope, TInput, TOutput>(
  target: ScopeTarget<S>,
  query: HostQueryDescriptor<S, TInput, TOutput>,
  input: TInput
): QueryResult<TOutput>;

export declare function useMutation<
  S extends PluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  target: ScopeTarget<S>,
  mutation: MutationDescriptor<S, TInput, TOutput>
): MutationHandle<z.input<TInput>, z.infer<TOutput>>;

export declare function useHost(): HostActions;

export type ClientPluginCleanup = () => void;

export interface ClientPluginDefinition {
  readonly kind: 'client-plugin';
  readonly register: (lody: ClientPluginRegistry) => void | ClientPluginCleanup;
}

export declare function defineClientPlugin(
  register: (lody: ClientPluginRegistry) => void | ClientPluginCleanup
): ClientPluginDefinition;
