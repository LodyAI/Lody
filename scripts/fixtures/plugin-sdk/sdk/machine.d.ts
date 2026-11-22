import type { z } from 'zod';
import {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  MAX_PLUGIN_RPC_REQUEST_BYTES,
  hostQueries,
  type AttachmentItem,
  type AttachmentSnapshot,
  type AttachmentSourceDescriptor,
  type BusinessKeyScope,
  type CreateSessionRequest,
  type HostQueryDescriptor,
  type MachinePluginScope,
  type MachineRef,
  type MutationDescriptor,
  type ObservationDescriptor,
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
} from './shared';

export {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  MAX_PLUGIN_RPC_REQUEST_BYTES,
  hostQueries,
  type BusinessKeyScope,
  type CreateSessionRequest,
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
    query: HostQueryDescriptor<S, TInput, TOutput>,
    input: TInput
  ): Promise<TOutput>;
  readonly sessions: {
    /**
     * In E2EE workspaces, `create` and `send` succeed from `ToolExecutionContext` (signed as
     * `derivedFrom` the active human root Turn); calls from un-rooted `MachineContext` handlers
     * reject with `forbidden` because no member device signed the execution prompt.
     */
    create(target: MachineRef | ProjectRef, request: CreateSessionRequest): Promise<SessionRef>;
    send(
      session: SessionRef,
      request: SendSessionMessageRequest
    ): Promise<SendSessionMessageReceipt>;
    requestStop(session: SessionRef): Promise<void>;
    requestArchive(session: SessionRef): Promise<void>;
  };
}

export type InvalidatableDescriptor<S extends MachinePluginScope = MachinePluginScope> =
  | QueryDescriptor<S, z.ZodType, z.ZodType>
  | ObservationDescriptor<S, z.ZodType, z.ZodType>;

export interface MachineContext<S extends MachinePluginScope = MachinePluginScope> {
  readonly target: ScopeTarget<S>;
  readonly machine: MachineRef;
  readonly workspace: WorkspaceRef;
  /** Workspace- and identity-generation-scoped plugin directory on this daemon. */
  readonly dataDir: string;
  /** Host-managed per-Session directory reaped on Session deletion; present when `S` is `'session'`. */
  readonly sessionDataDir: S extends 'session' ? string : undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly host: MachineHostPort;
  invalidate<QS extends MachinePluginScope>(
    descriptor: InvalidatableDescriptor<QS>,
    target?: ScopeTarget<QS>
  ): void;
}

export interface ToolExecutionContext {
  readonly toolCallId: string;
  readonly session: SessionRef;
  readonly project?: ProjectRef;
  readonly machine: MachineRef;
  readonly workspace: WorkspaceRef;
  readonly dataDir: string;
  /** Host-managed per-Session directory reaped on Session deletion and isolated across forks. */
  readonly sessionDataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly host: MachineHostPort;
  invalidate<QS extends MachinePluginScope>(
    descriptor: InvalidatableDescriptor<QS>,
    target?: ScopeTarget<QS>
  ): void;
}

export interface AttachmentContext {
  readonly session?: SessionRef;
  readonly project?: ProjectRef;
  readonly machine: MachineRef;
  readonly workspace: WorkspaceRef;
  readonly dataDir: string;
  readonly sessionDataDir?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}

export interface ObservationReadResult<TValue> {
  readonly value: TValue;
  readonly observedAt: number;
  /** Optional source revision/fingerprint re-verified by the host before dispatching a matched wait. */
  readonly revision?: string;
}

export interface MachinePluginRegistry {
  query<S extends MachinePluginScope, TInput extends z.ZodType, TOutput extends z.ZodType>(
    descriptor: QueryDescriptor<S, TInput, TOutput>,
    handler: (
      ctx: MachineContext<S>,
      input: z.infer<TInput>
    ) => Promise<z.input<TOutput>> | z.input<TOutput>
  ): void;

  mutation<S extends MachinePluginScope, TInput extends z.ZodType, TOutput extends z.ZodType>(
    descriptor: MutationDescriptor<S, TInput, TOutput>,
    handler: (
      ctx: MachineContext<S>,
      input: z.infer<TInput>
    ) => Promise<z.input<TOutput>> | z.input<TOutput>
  ): void;

  tool<TInput extends z.ZodType, TOutput extends z.ZodType>(
    descriptor: ToolDescriptor<TInput, TOutput>,
    execute: (
      ctx: ToolExecutionContext,
      input: z.infer<TInput>
    ) => Promise<z.input<TOutput>> | z.input<TOutput>
  ): void;

  attachmentSource<TMeta extends z.ZodType>(
    descriptor: AttachmentSourceDescriptor<TMeta>,
    handlers: {
      search(ctx: AttachmentContext, query: string): Promise<readonly AttachmentItem[]>;
      resolve(ctx: AttachmentContext, itemId: string): Promise<AttachmentSnapshot<z.input<TMeta>>>;
    }
  ): void;

  observation<S extends MachinePluginScope, TInput extends z.ZodType, TOutput extends z.ZodType>(
    descriptor: ObservationDescriptor<S, TInput, TOutput>,
    read: (
      ctx: MachineContext<S>,
      input: z.infer<TInput>
    ) => Promise<ObservationReadResult<z.input<TOutput>>>
  ): void;
}

export type MachinePluginCleanup = () => void | Promise<void>;

export interface MachinePluginDefinition {
  readonly kind: 'machine-plugin';
  readonly register: (machine: MachinePluginRegistry) => void | MachinePluginCleanup;
}

export declare function defineMachinePlugin(
  register: (machine: MachinePluginRegistry) => void | MachinePluginCleanup
): MachinePluginDefinition;
