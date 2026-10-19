import { toShared } from '@/platform/process-options';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { startProcessLegacy, type ProcessHandleLegacy } from '@lody/shared/node/process';

import {
  parseWorkspaceWatchChildMessage,
  type WorkspaceWatchParentMessage,
} from './workspace-watch-protocol';

export type WorkspaceWatchDirtyReason = 'event' | 'coverage' | 'broker-gap' | 'watch-error';

export type WorkspaceWatchSubscription = {
  readonly canonicalRoot: string;
  release: () => void;
};

export interface WorkspaceWatchCoordinatorApi {
  subscribe(options: {
    workspaceId: string;
    ownerSessionId: string;
    workspaceRoot: string;
    onDirty: (reason: WorkspaceWatchDirtyReason) => void;
  }): Promise<WorkspaceWatchSubscription | null>;
  recordCoalescedRefresh?(): void;
}

export type WorkspaceWatchCoordinatorSnapshot = Readonly<{
  generation: number;
  pid: number | null;
  phase: 'off' | 'stopped' | 'starting' | 'ready' | 'cooldown';
  restartReason: string | null;
  restartCount: number;
  desiredRootCount: number;
  subscriberCount: number;
  actualWatcherCount: number;
  revision: number;
  reconciliationLatencyMs: number;
  dirtyEventCount: number;
  coalescedRefreshCount: number;
  watchErrorsByCode: Readonly<Record<string, number>>;
  cooldownCount: number;
  recycleCount: number;
  childRssBytes: number;
  childUptimeMs: number;
}>;

type RootState = {
  subscribers: Set<string>;
  consecutiveFailures: number;
  cooldownUntilMs: number | null;
  recycledForResourceError: boolean;
};

type ChildLike = Pick<ChildProcess, 'connected' | 'exitCode' | 'pid' | 'send' | 'on'>;

/** A launched watch worker: its IPC channel plus whole-tree termination. */
export type WorkspaceWatchChild = {
  readonly child: ChildLike;
  readonly terminate: ProcessHandleLegacy['terminate'];
};

export type WorkspaceWatchCoordinatorOptions = {
  mode?: 'broker' | 'off';
  childLauncher?: (generation: number) => WorkspaceWatchChild;
  realpath?: (value: string) => Promise<string>;
  restartDelayMs?: (attempt: number) => number;
  noRootLingerMs?: number;
  cooldownMs?: number;
  gracefulShutdownMs?: number;
  sigtermWaitMs?: number;
  sigkillWaitMs?: number;
  maxReconfigurations?: number;
  maxChildAgeMs?: number;
  maxRssBytes?: number;
  now?: () => number;
};

const MINIMAL_ENV_NAMES = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  // The packaged Electron CLI runs through Lody Helper as a Node runtime.
  // Dropping this flag turns the watch worker spawn into a second GUI app launch.
  'ELECTRON_RUN_AS_NODE',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
] as const;

export function buildWorkspaceWatchWorkerEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of MINIMAL_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export class WorkspaceWatchCoordinator implements WorkspaceWatchCoordinatorApi {
  private readonly subscriptions = new Map<
    string,
    { root: string; onDirty: (reason: WorkspaceWatchDirtyReason) => void }
  >();
  private readonly roots = new Map<string, RootState>();
  private worker: WorkspaceWatchChild | null = null;
  private generation = 0;
  private revision = 0;
  private restartCount = 0;
  private restartReason: string | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private phase: 'off' | 'stopped' | 'starting' | 'ready' | 'cooldown' = 'stopped';
  private actualWatcherCount = 0;
  private dirtyEventCount = 0;
  private coalescedRefreshCount = 0;
  private readonly watchErrorsByCode = new Map<string, number>();
  private cooldownCount = 0;
  private recycleCount = 0;
  private childRssBytes = 0;
  private childUptimeMs = 0;
  private lastRevisionSentAtMs = 0;
  private lastReconciliationLatencyMs = 0;

  constructor(
    private readonly logger: Logger,
    private readonly options: WorkspaceWatchCoordinatorOptions = {}
  ) {
    if ((options.mode ?? readWorkspaceWatchMode()) === 'off') this.phase = 'off';
  }

  async subscribe(options: {
    workspaceId: string;
    ownerSessionId: string;
    workspaceRoot: string;
    onDirty: (reason: WorkspaceWatchDirtyReason) => void;
  }): Promise<WorkspaceWatchSubscription | null> {
    if (this.disposed || this.phase === 'off') return null;
    let canonicalRoot: string;
    try {
      canonicalRoot = await (this.options.realpath ?? realpath)(
        path.resolve(options.workspaceRoot)
      );
    } catch (error) {
      this.logger.debug(`[code-collab-watch] root canonicalization failed: ${errorCode(error)}`);
      return null;
    }
    if (this.disposed) return null;
    const key = `${options.workspaceId}:${options.ownerSessionId}`;
    const previous = this.subscriptions.get(key);
    if (previous?.root === canonicalRoot) {
      this.subscriptions.set(key, { root: canonicalRoot, onDirty: options.onDirty });
      return this.makeHandle(key, canonicalRoot);
    }
    if (previous) this.removeSubscriber(key, previous.root);
    this.subscriptions.set(key, { root: canonicalRoot, onDirty: options.onDirty });
    const state = this.roots.get(canonicalRoot) ?? {
      subscribers: new Set<string>(),
      consecutiveFailures: 0,
      cooldownUntilMs: null,
      recycledForResourceError: false,
    };
    state.subscribers.add(key);
    this.roots.set(canonicalRoot, state);
    this.cancelLinger();
    this.reconcile('subscribe');
    return this.makeHandle(key, canonicalRoot);
  }

  recordCoalescedRefresh(): void {
    this.coalescedRefreshCount += 1;
  }

  getSnapshot(): WorkspaceWatchCoordinatorSnapshot {
    return {
      generation: this.generation,
      pid: this.worker?.child.pid ?? null,
      phase: this.phase,
      restartReason: this.restartReason,
      restartCount: this.restartCount,
      desiredRootCount: this.roots.size,
      subscriberCount: this.subscriptions.size,
      actualWatcherCount: this.actualWatcherCount,
      revision: this.revision,
      reconciliationLatencyMs: this.lastReconciliationLatencyMs,
      dirtyEventCount: this.dirtyEventCount,
      coalescedRefreshCount: this.coalescedRefreshCount,
      watchErrorsByCode: Object.fromEntries(this.watchErrorsByCode),
      cooldownCount: this.cooldownCount,
      recycleCount: this.recycleCount,
      childRssBytes: this.childRssBytes,
      childUptimeMs: this.childUptimeMs,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.subscriptions.clear();
    this.roots.clear();
    await this.stopChild();
    this.phase = 'stopped';
  }

  private makeHandle(key: string, root: string): WorkspaceWatchSubscription {
    let released = false;
    return {
      canonicalRoot: root,
      release: () => {
        if (released) return;
        released = true;
        if (this.subscriptions.get(key)?.root !== root) return;
        this.subscriptions.delete(key);
        this.removeSubscriber(key, root);
        this.reconcile('release');
      },
    };
  }

  private removeSubscriber(key: string, root: string): void {
    const state = this.roots.get(root);
    state?.subscribers.delete(key);
    if (state?.subscribers.size === 0) this.roots.delete(root);
  }

  private reconcile(reason: string): void {
    if (this.disposed || this.phase === 'off') return;
    if (this.roots.size === 0) {
      if (!this.worker || this.lingerTimer) return;
      this.sendDesiredRoots();
      this.lingerTimer = setTimeout(() => {
        this.lingerTimer = null;
        void this.stopChild();
      }, this.options.noRootLingerMs ?? 30_000);
      this.lingerTimer.unref?.();
      return;
    }
    if (!this.worker) {
      this.startChild(reason);
      return;
    }
    this.sendDesiredRoots();
  }

  private startChild(reason: string): void {
    if (this.disposed || this.worker || this.restartTimer || this.roots.size === 0) return;
    this.generation += 1;
    this.phase = 'starting';
    try {
      const worker = (this.options.childLauncher ?? launchWorkspaceWatchChild)(this.generation);
      this.worker = worker;
      const { child } = worker;
      const generation = this.generation;
      child.on('message', (raw: unknown) => this.handleMessage(worker, generation, raw));
      child.on('error', (error: Error) => {
        this.logger.warn(`[code-collab-watch] child error code=${errorCode(error)}`);
      });
      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.worker !== worker || generation !== this.generation) return;
        this.worker = null;
        this.actualWatcherCount = 0;
        if (this.disposed) return;
        this.markAllDirty('broker-gap');
        this.scheduleRestart(`exit:${code ?? signal ?? 'unknown'}`);
      });
      this.logger.info(
        `[code-collab-watch] started generation=${generation} pid=${child.pid ?? 'unknown'} reason=${reason}`
      );
      this.sendDesiredRoots();
    } catch (error) {
      this.logger.warn(`[code-collab-watch] spawn failed code=${errorCode(error)}`);
      this.worker = null;
      if (errorCode(error) === 'WATCH_WORKER_MISSING') {
        this.phase = 'off';
        return;
      }
      this.scheduleRestart('spawn-failed');
    }
  }

  private sendDesiredRoots(): void {
    const child = this.worker?.child;
    if (!child?.connected) return;
    const now = this.now();
    const roots = Array.from(this.roots, ([root, state]) =>
      state.cooldownUntilMs !== null && state.cooldownUntilMs > now ? null : root
    ).filter((root): root is string => root !== null);
    this.revision += 1;
    this.lastRevisionSentAtMs = now;
    const message: WorkspaceWatchParentMessage = {
      type: 'code-collab-watch/replace-roots',
      generation: this.generation,
      revision: this.revision,
      roots,
    };
    child.send?.(message, (error) => {
      if (error) this.logger.debug(`[code-collab-watch] IPC send failed code=${errorCode(error)}`);
    });
  }

  private handleMessage(worker: WorkspaceWatchChild, generation: number, raw: unknown): void {
    if (worker !== this.worker || generation !== this.generation) return;
    const message = parseWorkspaceWatchChildMessage(raw);
    if (!message || message.generation !== generation) return;
    if (message.type === 'code-collab-watch/dirty') {
      this.markRootDirty(message.root, 'event');
      return;
    }
    if (message.type === 'code-collab-watch/ready') {
      if (message.revision !== this.revision) return;
      this.phase = 'ready';
      this.lastReconciliationLatencyMs = this.now() - this.lastRevisionSentAtMs;
      this.actualWatcherCount = message.watchedRoots.length;
      for (const root of message.watchedRoots) {
        const state = this.roots.get(root);
        if (state) {
          state.consecutiveFailures = 0;
          state.recycledForResourceError = false;
          this.markRootDirty(root, 'coverage');
        }
      }
      return;
    }
    if (message.type === 'code-collab-watch/error') {
      this.handleRootError(message.root, message.code);
      return;
    }
    this.actualWatcherCount = message.watcherCount;
    this.childRssBytes = message.rssBytes;
    this.childUptimeMs = message.uptimeMs;
    if (
      message.reconfigurationCount >= (this.options.maxReconfigurations ?? 512) ||
      message.uptimeMs >= (this.options.maxChildAgeMs ?? 24 * 60 * 60_000) ||
      message.rssBytes >= (this.options.maxRssBytes ?? 256 * 1024 * 1024)
    ) {
      void this.recycle('budget');
    }
  }

  private handleRootError(root: string, code: string): void {
    const state = this.roots.get(root);
    if (!state) return;
    state.consecutiveFailures += 1;
    const stableCode = stableErrorCode(code);
    this.watchErrorsByCode.set(stableCode, (this.watchErrorsByCode.get(stableCode) ?? 0) + 1);
    this.markRootDirty(root, 'watch-error');
    this.logger.warn(`[code-collab-watch] root watch failed code=${stableCode}`);
    if (code === 'EMFILE' && !state.recycledForResourceError) {
      state.recycledForResourceError = true;
      void this.recycle('native-resource');
      return;
    }
    state.cooldownUntilMs = this.now() + (this.options.cooldownMs ?? 5 * 60_000);
    this.cooldownCount += 1;
    this.phase = 'cooldown';
    this.scheduleCooldownReconcile();
    this.sendDesiredRoots();
  }

  private async recycle(reason: string): Promise<void> {
    if (!this.worker || this.disposed) return;
    this.recycleCount += 1;
    this.markAllDirty('broker-gap');
    await this.stopChild();
    this.scheduleRestart(`recycle:${reason}`);
  }

  private scheduleRestart(reason: string): void {
    if (this.disposed || this.roots.size === 0 || this.restartTimer) return;
    this.restartCount += 1;
    this.restartReason = reason;
    const delay = (this.options.restartDelayMs ?? defaultRestartDelay)(this.restartCount);
    this.logger.warn(`[code-collab-watch] restart scheduled reason=${reason} delayMs=${delay}`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startChild(reason);
    }, delay);
    this.restartTimer.unref?.();
  }

  private scheduleCooldownReconcile(): void {
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    const cooldowns = Array.from(this.roots.values(), (state) => state.cooldownUntilMs).filter(
      (value): value is number => value !== null
    );
    if (cooldowns.length === 0) return;
    const delay = Math.max(0, Math.min(...cooldowns) - this.now());
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      const now = this.now();
      for (const state of this.roots.values()) {
        if (state.cooldownUntilMs !== null && state.cooldownUntilMs <= now) {
          state.cooldownUntilMs = null;
        }
      }
      this.reconcile('cooldown-expired');
    }, delay);
    this.cooldownTimer.unref?.();
  }

  private markRootDirty(root: string, reason: WorkspaceWatchDirtyReason): void {
    const state = this.roots.get(root);
    if (!state) return;
    this.dirtyEventCount += 1;
    for (const key of state.subscribers) this.subscriptions.get(key)?.onDirty(reason);
  }

  private markAllDirty(reason: WorkspaceWatchDirtyReason): void {
    for (const root of this.roots.keys()) this.markRootDirty(root, reason);
  }

  private async stopChild(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    const { child } = worker;
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    if (child.connected) {
      child.send?.({ type: 'code-collab-watch/shutdown', generation: this.generation });
    }
    if (await waitFor(exited, this.options.gracefulShutdownMs ?? 1_000)) return;
    try {
      await worker.terminate({
        graceMs: this.options.sigtermWaitMs ?? 2_000,
        killWaitMs: this.options.sigkillWaitMs ?? 5_000,
      });
    } catch (error) {
      this.logger.warn(
        `[code-collab-watch] worker pid=${child.pid ?? 'unknown'} did not stop: ${formatErrorMessage(error)}`
      );
    }
  }

  private cancelLinger(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
  }

  private clearTimers(): void {
    for (const timer of [this.restartTimer, this.lingerTimer, this.cooldownTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.restartTimer = null;
    this.lingerTimer = null;
    this.cooldownTimer = null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function launchWorkspaceWatchChild(_generation: number): WorkspaceWatchChild {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const productionEntry = path.join(moduleDirectory, 'code-collab-watch-worker.js');
  const env = buildWorkspaceWatchWorkerEnvironment();
  if (existsSync(productionEntry)) {
    return startProcessLegacy(
      {
        command: process.execPath,
        args: [productionEntry],
        options: {
          env,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
        },
        processGroup: false,
      },
      toShared()
    );
  }
  throw Object.assign(new Error('Code Collab watch worker bundle is missing'), {
    code: 'WATCH_WORKER_MISSING',
  });
}

function readWorkspaceWatchMode(): 'broker' | 'off' {
  return process.env.LODY_CODE_COLLAB_WATCH_MODE === 'off' ? 'off' : 'broker';
}

function defaultRestartDelay(attempt: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(5, Math.max(0, attempt - 1)));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) return String(error.code);
  return error instanceof Error ? error.name : 'UNKNOWN';
}

function stableErrorCode(code: string): string {
  return /^[A-Z0-9_]+$/.test(code) ? code : 'UNKNOWN';
}

async function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}
