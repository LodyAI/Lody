import type { ChildProcess, SpawnOptions } from 'node:child_process';

import spawn from 'cross-spawn';
import { Context, Layer } from 'effect';

/**
 * The only door from the process layer to the operating system.
 *
 * Everything above it describes process work as Effects; this service performs
 * it. Tests replace it with an in-memory process table, so no test needs a real
 * child, a real signal, or the host platform.
 */
export interface NodeProcessApi {
  readonly platform: NodeJS.Platform;
  /** Synchronous like `child_process.spawn`: async failures arrive as `error`. */
  readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** `process.kill` semantics: throws `ESRCH` when no process matches. */
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void;
}

export class NodeProcess extends Context.Tag('lody/NodeProcess')<NodeProcess, NodeProcessApi>() {}

export const nodeProcessLive: NodeProcessApi = {
  platform: process.platform,
  spawn: (command, args, options) => spawn(command, [...args], options),
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
};

export const NodeProcessLive = Layer.succeed(NodeProcess, nodeProcessLive);

export const errnoCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};
