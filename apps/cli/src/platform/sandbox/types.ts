import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { Data, type Effect } from 'effect';

import type { SpawnFailed, TerminationFailed } from '../process/errors';
import type { ManagedProcess, ProcessExit } from '../process/managed-process';
import type { TerminationPolicy } from '../process/process-tree';

export interface SessionSandboxLimits {
  memoryMaxBytes?: number;
  memoryHighBytes?: number;
  cpuMax?: string;
  pidsMax?: number;
}

export interface MachineCapacitySnapshot {
  totalMemoryBytes: number;
  totalCpuCount: number;
}

export interface SessionResourceLimitViolation {
  kind: 'memory' | 'pids';
  message: string;
}

export type SessionResourceAccounting =
  | {
      kind: 'cgroup-v2';
      memoryBytes: number;
      cpuTimeMicros: number;
      processCount: number;
      memoryLimitBytes: number | null;
      cpuLimitCores: number | null;
      pidsLimit: number | null;
    }
  | {
      kind: 'process-tree';
      rootPids: number[];
      memoryLimitBytes: number | null;
      cpuLimitCores: number | null;
      pidsLimit: number | null;
    }
  | {
      kind: 'unavailable';
      reason: string;
    };

/** Reading or writing a sandbox control file failed. */
export class SandboxIoError extends Data.TaggedError('SandboxIoError')<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The host cannot provide this sandbox; the caller falls back to another. */
export class SandboxUnavailable extends Data.TaggedError('SandboxUnavailable')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const GRACEFUL_TERMINATION: TerminationPolicy = { graceMs: 5_000, killWaitMs: 5_000 };
export const FORCED_TERMINATION: TerminationPolicy = { graceMs: 0, killWaitMs: 5_000 };

export const terminationPolicy = (force: boolean): TerminationPolicy =>
  force ? FORCED_TERMINATION : GRACEFUL_TERMINATION;

export interface ContainerSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly onSpawned?: (child: ChildProcess) => void;
}

export interface ContainedProcess extends ManagedProcess {
  /** Whether this exit was the sandbox enforcing a limit; `null` otherwise. */
  readonly inspectExit: (exit: ProcessExit) => Effect.Effect<SessionResourceLimitViolation | null>;
}

/**
 * Every process a Session starts lives in one container. Closing the scope
 * the container was built in interrupts its background work; `cleanup`
 * releases what it holds on the host.
 */
export interface ProcessContainer {
  readonly enabled: boolean;
  readonly description: string;
  readonly spawn: (spec: ContainerSpawnSpec) => Effect.Effect<ContainedProcess, SpawnFailed>;
  /** Terminate every tracked process tree; fails if any could not be proven gone. */
  readonly terminateAll: (policy: TerminationPolicy) => Effect.Effect<void, TerminationFailed>;
  readonly applyLimits: (limits: SessionSandboxLimits) => Effect.Effect<void, SandboxIoError>;
  readonly readAccounting: Effect.Effect<SessionResourceAccounting, SandboxIoError>;
  readonly cleanup: Effect.Effect<void>;
}
