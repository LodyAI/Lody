import type { z } from 'zod';
import {
  hostQueries,
  type AttachmentItem,
  type AttachmentSnapshot,
  type AttachmentSourceDescriptor,
  type CreateSessionRequest,
  type HostQueryDescriptor,
  type MutationDescriptor,
  type ObservationDescriptor,
  type PluginScope,
  type ProjectRef,
  type QueryDescriptor,
  type ScopeTarget,
  type SessionRef,
  type ToolDescriptor,
  type WorkspaceRef,
} from './shared';

export { hostQueries };

export interface MachineHostPort {
  read<S extends PluginScope, TInput, TOutput>(
    target: ScopeTarget<S>,
    query: HostQueryDescriptor<S, TInput, TOutput>,
    input: TInput
  ): Promise<TOutput>;
  readonly sessions: {
    create(project: ProjectRef, request: CreateSessionRequest): Promise<SessionRef>;
  };
}

export interface MachineContext<S extends PluginScope = PluginScope> {
  readonly target: ScopeTarget<S>;
  readonly workspace: WorkspaceRef;
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly host: MachineHostPort;
  invalidate<QS extends PluginScope>(
    query: QueryDescriptor<QS, z.ZodType, z.ZodType>,
    target?: ScopeTarget<QS>
  ): void;
}

export interface ToolExecutionContext {
  readonly session: SessionRef;
  readonly project?: ProjectRef;
  readonly workspace: WorkspaceRef;
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly host: MachineHostPort;
  invalidate<QS extends PluginScope>(
    query: QueryDescriptor<QS, z.ZodType, z.ZodType>,
    target?: ScopeTarget<QS>
  ): void;
}

export interface AttachmentContext {
  readonly session?: SessionRef;
  readonly project?: ProjectRef;
  readonly workspace: WorkspaceRef;
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}

export interface MachinePluginRegistry {
  query<S extends PluginScope, TInput extends z.ZodType, TOutput extends z.ZodType>(
    descriptor: QueryDescriptor<S, TInput, TOutput>,
    handler: (
      ctx: MachineContext<S>,
      input: z.infer<TInput>
    ) => Promise<z.input<TOutput>> | z.input<TOutput>
  ): void;

  mutation<S extends PluginScope, TInput extends z.ZodType, TOutput extends z.ZodType>(
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

  observation<S extends PluginScope, TInput extends z.ZodType, TOutput extends z.ZodType>(
    descriptor: ObservationDescriptor<S, TInput, TOutput>,
    read: (
      ctx: MachineContext<S>,
      input: z.infer<TInput>
    ) => Promise<{ readonly value: z.input<TOutput>; readonly observedAt: number }>
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
