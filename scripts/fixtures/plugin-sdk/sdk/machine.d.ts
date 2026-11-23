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
  type MachineHostEventMap,
  type MachineHostEventType,
  type MachinePluginScope,
  type MachineRef,
  type MutationDescriptor,
  type PluginScope,
  type ProjectRef,
  type QueryDescriptor,
  type RawDocumentSnapshot,
  type RawSnapshotTarget,
  type ReadonlyJsonPrimitive,
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
  type MachineHostEventMap,
  type MachineHostEventType,
  type MachinePluginScope,
  type MachineRef,
  type ProjectRef,
  type RawDocumentSnapshot,
  type RawSnapshotTarget,
  type ReadonlyJsonPrimitive,
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
  readSnapshot(target: RawSnapshotTarget): Promise<RawDocumentSnapshot>;
  readonly sessions: {
    /**
     * In E2EE workspaces, `create` and `send` succeed from `ToolExecutionContext` and from
     * `MachineEventContext` rooted in a verified `userTurnId` or human-signed workflow activation
     * on this machine; un-rooted `MachineContext` queries/mutations reject with `forbidden`.
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
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config: Readonly<Record<string, ReadonlyJsonPrimitive | undefined>>;
  readonly signal: AbortSignal;
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
  readonly config: Readonly<Record<string, ReadonlyJsonPrimitive | undefined>>;
  readonly signal: AbortSignal;
  readonly lody: MachineHostPort;
  invalidate<QS extends MachinePluginScope>(
    descriptor: QueryDescriptor<QS, z.ZodType, z.ZodType>,
    target?: ScopeTarget<QS>,
  ): void;
}

export interface MachineEventContext<
  K extends MachineHostEventType = MachineHostEventType,
> {
  readonly eventType: K;
  readonly workspace: WorkspaceRef;
  readonly machine: MachineRef;
  readonly session?: SessionRef;
  readonly project?: ProjectRef;
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config: Readonly<Record<string, ReadonlyJsonPrimitive | undefined>>;
  readonly signal: AbortSignal;
  readonly lody: MachineHostPort;
  invalidate<QS extends MachinePluginScope>(
    descriptor: QueryDescriptor<QS, z.ZodType, z.ZodType>,
    target?: ScopeTarget<QS>,
  ): void;
}

/**
 * Context passed to `machine.onStart` when the plugin subprocess enters `Running` (including after
 * a daemon restart or `reload`), enabling workflow plugins to reconcile durable `ctx.dataDir`
 * progress journals against live `lodyQueries.sessions` and resume unfinished steps idempotently.
 */
export interface MachineStartupContext {
  readonly workspace: WorkspaceRef;
  readonly machine: MachineRef;
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config: Readonly<Record<string, ReadonlyJsonPrimitive | undefined>>;
  readonly signal: AbortSignal;
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
  readonly config: Readonly<Record<string, ReadonlyJsonPrimitive | undefined>>;
  readonly signal: AbortSignal;
}

export interface MachinePluginRegistry {
  /**
   * Invoked once per subprocess generation immediately after `ready` (including after daemon restart),
   * allowing workflow plugins to recover durable task state from `ctx.dataDir` without polling.
   */
  onStart(handler: (ctx: MachineStartupContext) => void | Promise<void>): void;
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
  /**
   * Subscribes to daemon-side Session/Turn/Tool lifecycle events so workflow plugins (e.g. Sorbet
   * Super Assistant or CI/review orchestrators) can react without polling.
   */
  readonly events: {
    on<K extends MachineHostEventType>(
      type: K,
      handler: (
        ctx: MachineEventContext<K>,
        event: MachineHostEventMap[K],
      ) => void | Promise<void>,
    ): void;
  };
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
