import type { ChildProcess } from 'node:child_process';

import type { Duration, Layer } from 'effect';
import * as processLayer from '@lody/shared/node/process';
import {
  nodeProcessLive,
  type CommandSpec,
  type CommandText,
  type NodeProcess,
  type NodeProcessApi,
  type ProcessHandle,
  type ProcessRunner,
  type SpawnSpec,
  type TerminationPolicy,
} from '@lody/shared/node/process';

import { getLogger, type Logger as LodyLogger } from '@/utils/logger';

import { lodyLoggerLayer } from './logger';

/*
 * TEMPORARY: the CLI's door to the shared process layer's Promise facades
 * (`@lody/shared/node/process`), adding only the CLI logger. Each caller is an
 * upper layer that will become an Effect itself; see
 * `.agents/docs/cli-effect-ts.md#temporary-promise-facades`.
 */

export type { CommandText, ProcessHandle };
export type PlatformRunner = ProcessRunner;

export interface PlatformFacadeOptions {
  readonly logger?: LodyLogger;
  /** Owner label the process layer's log lines start with, e.g. `[session-id]`. */
  readonly logPrefix?: string;
  readonly nodeProcess?: NodeProcessApi;
}

// Without a caller's logger the daemon's root logger still records process
// diagnostics, such as a tree that survived termination. Exported for shared
// helpers that run commands themselves (the login-shell probe).
export const toShared = (
  options: PlatformFacadeOptions = {}
): processLayer.ProcessFacadeOptions => ({
  nodeProcess: options.nodeProcess,
  loggerLayer: lodyLoggerLayer(options.logger ?? getLogger(), options.logPrefix),
});

export const platformLayer = (options: PlatformFacadeOptions): Layer.Layer<NodeProcess> =>
  processLayer.processLayer(toShared(options));

export const makePlatformRunner = (options: PlatformFacadeOptions): PlatformRunner =>
  processLayer.makeProcessRunner(toShared(options));

export const runPromiseSquashed = processLayer.runPromiseSquashed;

/** Facade options that swap only the spawn function, for callers with a spawn test seam. */
export const withSpawn = (
  spawnImpl: NodeProcessApi['spawn'] | undefined,
  options: Omit<PlatformFacadeOptions, 'nodeProcess'> = {}
): PlatformFacadeOptions =>
  spawnImpl ? { ...options, nodeProcess: { ...nodeProcessLive, spawn: spawnImpl } } : options;

export const runCommandText = (
  spec: CommandSpec & { readonly check: 'exit-0' | 'none' },
  options: PlatformFacadeOptions = {}
): Promise<CommandText> => processLayer.runCommandText(spec, toShared(options));

export const runCommandTextSync = (
  spec: CommandSpec & {
    readonly timeout: Duration.Input;
    readonly check: 'exit-0' | 'none';
  },
  options: PlatformFacadeOptions = {}
): CommandText => processLayer.runCommandTextSync(spec, toShared(options));

export const startProcess = (spec: SpawnSpec, options: PlatformFacadeOptions = {}): ProcessHandle =>
  processLayer.startProcess(spec, toShared(options));

export const terminateChildTree = (
  child: ChildProcess,
  policy: TerminationPolicy & { readonly processGroup: boolean },
  options: PlatformFacadeOptions = {}
): Promise<void> => processLayer.terminateChildTree(child, policy, toShared(options));

export const isPidAliveSync = (pid: number, options: PlatformFacadeOptions = {}): boolean =>
  processLayer.isPidAliveSync(pid, toShared(options));
