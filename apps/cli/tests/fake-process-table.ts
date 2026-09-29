import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import type { NodeProcessApi } from '../src/platform/process/node-process';

type FakeProcess = {
  pid: number;
  pgid: number;
  alive: boolean;
  ignores: Set<NodeJS.Signals>;
  child?: FakeChildProcess;
};

export type DeliveredSignal = { target: number; signal: NodeJS.Signals };

/**
 * A spawned child as the process layer sees it: lifecycle events, stdio, and
 * the exit fields Node sets before emitting `exit`.
 */
export class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();

  constructor(
    readonly pid: number | undefined,
    private readonly table: FakeProcessTable
  ) {
    super();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.pid === undefined) return false;
    try {
      this.table.kill(this.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

const missingProcess = (): Error & { code: string } =>
  Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });

/**
 * An in-memory OS process table with POSIX process-group semantics. Signals
 * reach every live member of a group, members may ignore SIGTERM, and a group
 * outlives its leader for as long as any member lives, which is exactly the
 * orphaned-descendant case the process layer must handle.
 */
export class FakeProcessTable {
  readonly delivered: DeliveredSignal[] = [];
  readonly spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  private readonly processes = new Map<number, FakeProcess>();
  private nextPid = 1000;
  private readonly spawnQueue: Array<{ ignores?: NodeJS.Signals[]; failWith?: Error }> = [];

  readonly api: NodeProcessApi;

  constructor(readonly platform: NodeJS.Platform = 'linux') {
    this.api = {
      platform,
      spawn: (command, args, options) => this.spawn(command, args, options),
      kill: (target, signal) => this.kill(target, signal),
    };
  }

  private spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    this.spawned.push({ command, args, options });
    if (command === 'taskkill') {
      return this.runTaskkill(args);
    }
    const shape = this.spawnQueue.shift() ?? {};
    if (shape.failWith) {
      const child = new FakeChildProcess(undefined, this);
      const error = shape.failWith;
      queueMicrotask(() => child.emit('error', error));
      return child.asChildProcess();
    }
    const pid = this.nextPid++;
    const child = new FakeChildProcess(pid, this);
    this.processes.set(pid, {
      pid,
      // A Windows tree is rooted at its first process whether or not it is detached.
      pgid: options.detached || this.platform === 'win32' ? pid : 1,
      alive: true,
      ignores: new Set(shape.ignores ?? []),
      child,
    });
    return child.asChildProcess();
  }

  /** When set, `taskkill` never finishes, like a wedged Windows service call. */
  taskkillHangs = false;

  /**
   * `taskkill /PID <root> /T [/F]` over the tree rooted at `<root>`. Without
   * `/F` a member that ignores SIGTERM makes it fail (a console process that
   * can only be terminated forcefully); an unknown root exits with 128.
   */
  private runTaskkill(args: readonly string[]): ChildProcess {
    const child = new FakeChildProcess(this.nextPid++, this);
    if (this.taskkillHangs) return child.asChildProcess();
    const root = Number(args[args.indexOf('/PID') + 1]);
    const force = args.includes('/F');
    const members = Array.from(this.processes.values()).filter((p) => p.alive && p.pgid === root);
    let code = 0;
    if (members.length === 0) {
      code = 128;
    } else {
      const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
      this.delivered.push({ target: root, signal });
      for (const member of members) {
        if (member.ignores.has(signal)) code = 1;
        else this.terminate(member, signal, null);
      }
    }
    queueMicrotask(() => child.emit('close', code, null));
    return child.asChildProcess();
  }

  /** Shape the next `spawn`: a leader that ignores signals, or an async spawn error. */
  queueSpawn(options: { ignores?: NodeJS.Signals[]; failWith?: Error }): void {
    this.spawnQueue.push(options);
  }

  /** A descendant in the leader's group, like a tool process under an ACP agent. */
  addDescendant(leaderPid: number, options: { ignores?: NodeJS.Signals[] } = {}): number {
    const leader = this.processes.get(leaderPid);
    if (!leader) throw new Error(`No process ${leaderPid}`);
    const pid = this.nextPid++;
    this.processes.set(pid, {
      pid,
      pgid: leader.pgid,
      alive: true,
      ignores: new Set(options.ignores ?? []),
    });
    return pid;
  }

  /** The leader exits on its own, leaving the rest of its group running. */
  exitOnItsOwn(pid: number, code = 0): void {
    const process = this.processes.get(pid);
    if (!process?.alive) return;
    this.terminate(process, null, code);
  }

  isAlive(pid: number): boolean {
    return this.processes.get(pid)?.alive === true;
  }

  kill(target: number, signal: NodeJS.Signals | 0): void {
    const members =
      target < 0
        ? Array.from(this.processes.values()).filter((p) => p.alive && p.pgid === -target)
        : [this.processes.get(target)].filter((p): p is FakeProcess => p?.alive === true);
    if (members.length === 0) throw missingProcess();
    if (signal === 0) return;
    this.delivered.push({ target, signal });
    for (const member of members) {
      if (!member.ignores.has(signal)) {
        this.terminate(member, signal, null);
      }
    }
  }

  private terminate(process: FakeProcess, signal: NodeJS.Signals | null, code: number | null) {
    process.alive = false;
    const child = process.child;
    if (!child) return;
    child.exitCode = code;
    child.signalCode = signal;
    queueMicrotask(() => {
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
    });
  }
}
