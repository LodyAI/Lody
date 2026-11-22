import type { z } from "zod";
import {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  MAX_PLUGIN_RPC_REQUEST_BYTES,
  lodyQueries,
  type AttachmentItem,
  type AttachmentSnapshot,
  type AttachmentSourceDescriptor,
  type CreateSessionRequest,
  type LodyQueryDescriptor,
  type MachinePluginScope,
  type MachineRef,
  type MutationDescriptor,
  type PluginScope,
  type ProjectRef,
  type QueryDescriptor,
  type ScopeTarget,
  type SendSessionMessageReceipt,
  type SendSessionMessageRequest,
  type SessionDetail,
  type SessionRef,
  type ToolDescriptor,
  type WorkspaceRef,
} from "./shared";

export {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  MAX_PLUGIN_RPC_REQUEST_BYTES,
  lodyQueries,
  type CreateSessionRequest,
  type LodyQueryDescriptor,
  type MachinePluginScope,
  type MachineRef,
  type ProjectRef,
  type SendSessionMessageReceipt,
  type SendSessionMessageRequest,
  type SessionDetail,
  type SessionRef,
  type WorkspaceRef,
};

export interface MachineHostPort {
  read<S extends PluginScope, TInput, TOutput>(
    target: ScopeTarget<S>,
    query: LodyQueryDescriptor<S, TInput, TOutput>,
    ...[input]: [void] extends [TInput] ? [input?: TInput] : [input: TInput]
  ): Promise<TOutput>;
  readonly sessions: {
    /**
     * In E2EE workspaces, `create` and `send` succeed from `ToolExecutionContext` (signed as
     * `derivedFrom` the active human root Turn); calls from un-rooted `MachineContext` handlers
     * reject with `forbidden` because no member device signed the execution prompt.
     */
    create(
      target: MachineRef | ProjectRef,
      request: CreateSessionRequest,
    ): Promise<SessionRef>;
    send(
      session: SessionRef,
      request: SendSessionMessageRequest,
    ): Promise<SendSessionMessageReceipt>;
    requestStop(session: SessionRef): Promise<void>;
    requestArchive(session: SessionRef): Promise<void>;
  };
}

export interface MachineContext<
  S extends MachinePluginScope = MachinePluginScope,
> {
  readonly target: ScopeTarget<S>;
  readonly machine: MachineRef;
  readonly workspace: WorkspaceRef;
  /**
   * Workspace- and identity-generation-scoped plugin directory on this daemon.
   * Large per-call or per-session artifacts store files under `dataDir` keyed by immutable IDs.
   */
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  /** Unified programmatic Lody SDK handle on the daemon (matches `useLody()` on the client). */
  readonly lody: MachineHostPort;
  invalidate<QS extends MachinePluginScope>(
    descriptor: QueryDescriptor<QS, z.ZodType, z.ZodType>,
    target?: ScopeTarget<QS>,
  ): void;
}

export interface ToolExecutionContext {
  readonly toolCallId: string;
  readonly session: SessionRef;
  readonly project?: ProjectRef;
  readonly machine: MachineRef;
  readonly workspace: WorkspaceRef;
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  /** Unified programmatic Lody SDK handle on the daemon (matches `useLody()` on the client). */
  readonly lody: MachineHostPort;
  invalidate<QS extends MachinePluginScope>(
    descriptor: QueryDescriptor<QS, z.ZodType, z.ZodType>,
    target?: ScopeTarget<QS>,
  ): void;
}

export interface AttachmentContext {
  readonly session?: SessionRef;
  readonly project?: ProjectRef;
  readonly machine: MachineRef;
  readonly workspace: WorkspaceRef;
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}

export interface MachinePluginRegistry {
  query<
    S extends MachinePluginScope,
    TInput extends z.ZodType,
    TOutput extends z.ZodType,
  >(
    descriptor: QueryDescriptor<S, TInput, TOutput>,
    handler: (
      ctx: MachineContext<S>,
      input: z.output<TInput>,
    ) => Promise<z.input<TOutput>> | z.input<TOutput>,
  ): void;
  mutation<
    S extends MachinePluginScope,
    TInput extends z.ZodType,
    TOutput extends z.ZodType,
  >(
    descriptor: MutationDescriptor<S, TInput, TOutput>,
    handler: (
      ctx: MachineContext<S>,
      input: z.output<TInput>,
    ) => Promise<z.input<TOutput>> | z.input<TOutput>,
  ): void;
  tool<TInput extends z.ZodType, TOutput extends z.ZodType>(
    descriptor: ToolDescriptor<TInput, TOutput>,
    handler: (
      ctx: ToolExecutionContext,
      input: z.output<TInput>,
    ) => Promise<z.input<TOutput>> | z.input<TOutput>,
  ): void;
  attachmentSource<TMeta extends z.ZodType>(
    descriptor: AttachmentSourceDescriptor<TMeta>,
    handlers: {
      search(
        ctx: AttachmentContext,
        query: string,
      ): Promise<readonly AttachmentItem[]> | readonly AttachmentItem[];
      resolve(
        ctx: AttachmentContext,
        itemId: string,
      ):
        | Promise<AttachmentSnapshot<z.input<TMeta>>>
        | AttachmentSnapshot<z.input<TMeta>>;
    },
  ): void;
}

export type MachinePluginCleanup = () => void | Promise<void>;

export interface MachinePluginDefinition {
  readonly kind: "machine-plugin";
  readonly register: (
    machine: MachinePluginRegistry,
  ) => void | MachinePluginCleanup;
}

export declare function defineMachinePlugin(
  register: (machine: MachinePluginRegistry) => void | MachinePluginCleanup,
): MachinePluginDefinition;
