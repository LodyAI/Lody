import type { Layer } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import {
  nodeProcessLive,
  processLayer,
  type NodeProcess,
  type NodeProcessApi,
  type ProcessFacadeOptions,
} from '@lody/shared/node/process';
import { getLogger, type Logger as LodyLogger } from '@/utils/logger';
import { lodyLoggerLayer } from './logger';

// Composition only: no process execution and no Effect-to-Promise conversion.
export interface PlatformFacadeOptions {
  readonly logger?: LodyLogger;
  /** Owner label the process layer's log lines start with, e.g. `[session-id]`. */
  readonly logPrefix?: string;
  readonly nodeProcess?: NodeProcessApi;
  readonly signal?: AbortSignal;
}

// Without a caller's logger the daemon's root logger still records process
// diagnostics, such as a tree that survived termination. Exported for shared
// helpers that run commands themselves (the login-shell probe).
export const toShared = (options: PlatformFacadeOptions = {}): ProcessFacadeOptions => ({
  nodeProcess: options.nodeProcess,
  signal: options.signal,
  loggerLayer: lodyLoggerLayer(options.logger ?? getLogger(), options.logPrefix),
});

export const platformLayer = (
  options: PlatformFacadeOptions
): Layer.Layer<NodeProcess | ChildProcessSpawner.ChildProcessSpawner> =>
  processLayer(toShared(options));

/** Facade options that swap only the spawn function, for callers with a spawn test seam. */
export const withSpawn = (
  spawnImpl: NodeProcessApi['spawn'] | undefined,
  options: Omit<PlatformFacadeOptions, 'nodeProcess'> = {}
): PlatformFacadeOptions =>
  spawnImpl ? { ...options, nodeProcess: { ...nodeProcessLive, spawn: spawnImpl } } : options;
