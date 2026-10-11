import type { ChildProcess } from 'node:child_process';
import { Effect } from 'effect';
import type { CliRuntimeState } from '@lody/shared/electron-ipc';
import {
  childProcessTree,
  hasExited,
  makeProcessRunnerLegacy,
  terminateChildTreeLegacy,
  type ProcessFacadeOptions,
} from '@lody/shared/node/process';
import { buildRetryDelay, FailureWindow, isAlreadyRunningOutcome } from './retry.js';
import type {
  CliRunResult,
  LaunchHandle,
  PreparedLaunch,
  SupervisorOptions,
  SupervisorHostIdentity,
  SupervisorPhase,
  SupervisorState,
  SupervisorStopOptions,
  SupervisorTermination,
} from './types.js';

function phaseFromRuntime(runtime: CliRuntimeState): SupervisorPhase {
  if (runtime.phase === 'fatal') return 'fatal';
  return runtime.connectivity === 'reconnecting' ? 'reconnecting' : runtime.phase;
}

const DEFAULT_PROBE_INTERVAL_MS = 1_000;
const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_PROBE_FAILURE_THRESHOLD = 3;
const DEFAULT_MIN_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 60_000;
const DEFAULT_FATAL_FAILURE_WINDOW_MS = 5 * 60_000;
const DEFAULT_FATAL_FAILURE_THRESHOLD = 10;
const DEFAULT_FATAL_OOM_WINDOW_MS = 30 * 60_000;
const DEFAULT_FATAL_OOM_THRESHOLD = 2;
const DEFAULT_HEALTHY_RUN_MS = 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 30_000;
const DEFAULT_FORCE_KILL_WAIT_MS = 5_000;

type ActiveRun = {
  generation: number;
  handle: LaunchHandle;
  settled: Promise<CliRunResult>;
};

function isChildProcessRunning(child: ChildProcess | null): boolean {
  return child !== null && !hasExited(child);
}

function runtimeMatchesHost(runtime: CliRuntimeState, host: SupervisorHostIdentity): boolean {
  if (host.mode === 'foreground') {
    return runtime.pid === host.pid && runtime.supervisor === undefined;
  }
  return (
    runtime.supervisor?.instanceId === host.instanceId &&
    runtime.supervisor.pid === host.pid &&
    runtime.supervisor.launchMode === host.mode
  );
}

function sameHostIdentity(left: SupervisorHostIdentity, right: SupervisorHostIdentity): boolean {
  return left.instanceId === right.instanceId && left.pid === right.pid && left.mode === right.mode;
}

export class CliSupervisor {
  private readonly prepareLaunch: SupervisorOptions['prepareLaunch'];
  private readonly decideExit: SupervisorOptions['decideExit'];
  private readonly onStateChange?: SupervisorOptions['onStateChange'];
  private readonly onTerminal?: SupervisorOptions['onTerminal'];
  private readonly ownership?: SupervisorOptions['ownership'];
  private readonly existingRuntimePolicy: 'attach' | 'reject';
  private readonly terminationGraceMs: number;
  private readonly forceKillWaitMs: number;
  private readonly fetchRuntimeState: SupervisorOptions['fetchRuntimeState'];
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly probeFailureThreshold: number;
  private readonly minRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly retryJitterFraction: number;
  private readonly retryRandom: () => number;
  private readonly healthyRunMs: number;
  private readonly failureWindow: FailureWindow;
  private readonly oomFailureWindow: FailureWindow;
  private readonly processOptions: ProcessFacadeOptions;

  private desiredState: 'running' | 'stopped' = 'stopped';
  private probeOnly = false;
  private generation = 0;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private prepareAbortController: AbortController | null = null;
  private exitActionAbortController: AbortController | null = null;
  private activeRun: ActiveRun | null = null;
  private externalRuntimeState: CliRuntimeState | null = null;
  private externalHostIdentity: SupervisorHostIdentity | null = null;
  private latestRuntimeState: CliRuntimeState | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private healthyRunTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollQueued = false;
  private probeFailureCount = 0;
  private probeUnavailable = false;
  private attempt = 0;
  private fatalReason: string | null = null;
  private ownershipHeld = false;
  private pendingRetryInMs: number | null = null;
  private lastExitCode: number | null | undefined;
  private lastExitAtMs: number | undefined;
  private lastStateMessage: string | undefined;

  private state: SupervisorState = {
    phase: 'stopped',
    desiredState: 'stopped',
    updatedAtMs: Date.now(),
  };

  constructor(options: SupervisorOptions) {
    this.prepareLaunch = options.prepareLaunch;
    this.decideExit = options.decideExit;
    this.onStateChange = options.onStateChange;
    this.onTerminal = options.onTerminal;
    this.ownership = options.ownership;
    this.existingRuntimePolicy = options.existingRuntimePolicy ?? 'reject';
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.forceKillWaitMs = options.forceKillWaitMs ?? DEFAULT_FORCE_KILL_WAIT_MS;
    this.fetchRuntimeState = options.fetchRuntimeState;
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.probeFailureThreshold = options.probeFailureThreshold ?? DEFAULT_PROBE_FAILURE_THRESHOLD;
    this.minRetryMs = options.minRetryMs ?? DEFAULT_MIN_RETRY_MS;
    this.maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    this.retryJitterFraction = options.retryJitterFraction ?? 0;
    this.retryRandom = options.retryRandom ?? Math.random;
    this.healthyRunMs = options.healthyRunMs ?? DEFAULT_HEALTHY_RUN_MS;
    this.failureWindow = new FailureWindow(
      options.fatalFailureWindowMs ?? DEFAULT_FATAL_FAILURE_WINDOW_MS,
      options.fatalFailureThreshold ?? DEFAULT_FATAL_FAILURE_THRESHOLD
    );
    this.oomFailureWindow = new FailureWindow(
      options.fatalOomWindowMs ?? DEFAULT_FATAL_OOM_WINDOW_MS,
      options.fatalOomThreshold ?? DEFAULT_FATAL_OOM_THRESHOLD
    );
    this.processOptions = options.processOptions ?? {};
  }

  getState(): SupervisorState {
    return this.state;
  }

  getActiveChild(): ChildProcess | null {
    return this.activeRun?.handle.child ?? null;
  }

  getLatestRuntimeState(): CliRuntimeState | null {
    return this.latestRuntimeState;
  }

  start(): Promise<void> {
    // An explicit start is a new intent: it always clears a fatal verdict.
    // Only a redundant start of an already-healthy supervisor is a no-op.
    if (this.desiredState === 'running' && !this.fatalReason) return this.lifecycleQueue;

    this.desiredState = 'running';
    const generation = this.beginGeneration();
    this.resetForExplicitStart();
    this.lastStateMessage = 'Starting CLI service';
    this.startPolling();
    this.publishState();
    return this.enqueueLifecycle(async () => await this.reconcile(generation));
  }

  /**
   * Observe an externally managed runtime without acquiring ownership or
   * launching a process. Electron uses this while CLI autostart is disabled so
   * renderer local-machine routing can still discover a manually started CLI.
   */
  startProbing(): void {
    if (this.desiredState === 'running') return;
    this.probeOnly = true;
    this.startPolling();
    this.queuePoll();
  }

  stop(options: SupervisorStopOptions = {}): Promise<void> {
    this.probeOnly = false;
    this.desiredState = 'stopped';
    this.beginGeneration();
    this.clearRetryTimer();
    this.clearHealthyRunTimer();
    this.stopPolling();
    this.fatalReason = null;
    this.pendingRetryInMs = null;
    this.lastStateMessage = 'Stopping CLI service';
    this.publishState();

    return this.enqueueLifecycle(async () => {
      await this.terminateActiveRun(
        'CLI stop requested',
        options.terminationGraceMs ?? this.terminationGraceMs
      );
      this.externalRuntimeState = null;
      this.externalHostIdentity = null;
      await this.releaseOwnership();
      this.latestRuntimeState = null;
      this.probeFailureCount = 0;
      this.probeUnavailable = false;
      this.lastStateMessage = 'CLI stopped';
      this.failureWindow.reset();
      this.oomFailureWindow.reset();
      this.attempt = 0;
      this.publishState();
    });
  }

  restart(): Promise<void> {
    if (this.externalRuntimeState && !this.activeRun) {
      return Promise.reject(
        new Error(
          `Cannot restart CLI process ${this.externalRuntimeState.pid}: it is owned by another host`
        )
      );
    }

    this.desiredState = 'running';
    const generation = this.beginGeneration();
    this.resetForExplicitStart();
    this.lastStateMessage = 'Restarting CLI service';
    this.startPolling();
    this.publishState();

    return this.enqueueLifecycle(async () => {
      await this.terminateActiveRun('CLI restart requested', this.terminationGraceMs);
      await this.reconcile(generation);
    });
  }

  private beginGeneration(): number {
    this.generation += 1;
    this.prepareAbortController?.abort();
    this.prepareAbortController = null;
    this.exitActionAbortController?.abort();
    this.exitActionAbortController = null;
    return this.generation;
  }

  private resetForExplicitStart(): void {
    this.probeOnly = false;
    this.fatalReason = null;
    this.clearRetryTimer();
    this.clearHealthyRunTimer();
    this.failureWindow.reset();
    this.oomFailureWindow.reset();
    this.attempt = 0;
    this.pendingRetryInMs = null;
    this.probeFailureCount = 0;
    this.probeUnavailable = false;
    this.latestRuntimeState = null;
    this.externalRuntimeState = null;
    this.externalHostIdentity = null;
  }

  private enqueueLifecycle(task: () => Promise<void>): Promise<void> {
    const run = this.lifecycleQueue.then(task, task);
    this.lifecycleQueue = run.catch(() => {});
    return run;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.desiredState === 'running';
  }

  private async reconcile(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || this.activeRun || this.externalRuntimeState) return;
    if (this.fatalReason) return;

    if (this.ownership && !this.ownershipHeld) {
      const ownershipAbortController = new AbortController();
      this.prepareAbortController = ownershipAbortController;
      let ownership;
      try {
        ownership = await this.ownership.acquire(ownershipAbortController.signal);
      } catch (error) {
        if (this.prepareAbortController === ownershipAbortController) {
          this.prepareAbortController = null;
        }
        if (ownershipAbortController.signal.aborted || !this.isCurrent(generation)) return;
        this.scheduleRetry(
          generation,
          `Local CLI host ownership failed: ${this.formatError(error)}`,
          true
        );
        return;
      }
      if (this.prepareAbortController === ownershipAbortController) {
        this.prepareAbortController = null;
      }
      if (ownershipAbortController.signal.aborted || !this.isCurrent(generation)) {
        if (ownership.status === 'acquired') await this.ownership.release();
        return;
      }
      if (ownership.status === 'occupied') {
        const runtime = await this.fetchRuntimeState({ timeoutMs: this.probeTimeoutMs });
        if (!this.isCurrent(generation)) return;
        if (
          runtime &&
          ownership.owner &&
          runtimeMatchesHost(runtime, ownership.owner) &&
          this.existingRuntimePolicy === 'attach'
        ) {
          this.observeExternalRuntime(runtime, ownership.owner);
          return;
        }
        const description = ownership.description ?? 'Another local CLI host owns the runtime';
        if (this.existingRuntimePolicy === 'reject') {
          this.markFatal(description);
        } else {
          this.scheduleRetry(
            generation,
            runtime
              ? `${description}, but its runtime identity does not match the Host lease`
              : description,
            false
          );
        }
        return;
      }
      this.ownershipHeld = true;
    }

    const existingRuntime = await this.fetchRuntimeState({ timeoutMs: this.probeTimeoutMs });
    if (!this.isCurrent(generation)) return;
    if (existingRuntime) {
      if (this.ownershipHeld) {
        // An unowned/draining runtime blocks the launch but is not fatal:
        // supervised workers self-terminate on IPC disconnect and orphans
        // eventually exit, so keep observing and never signal the PID.
        this.scheduleRetry(
          generation,
          existingRuntime.supervisor
            ? `Waiting for supervised CLI runtime ${existingRuntime.pid} to drain`
            : `CLI runtime ${existingRuntime.pid} is running without Local Host ownership; waiting for it to exit`,
          false
        );
        return;
      }
      this.observeExternalRuntime(existingRuntime);
      return;
    }

    const abortController = new AbortController();
    this.prepareAbortController = abortController;
    this.lastStateMessage = 'Preparing CLI process';
    this.publishState();

    let prepared: PreparedLaunch;
    try {
      prepared = await this.abortable(
        this.prepareLaunch(abortController.signal),
        abortController.signal,
        'CLI launch preparation canceled'
      );
    } catch (error) {
      if (this.prepareAbortController === abortController) this.prepareAbortController = null;
      if (abortController.signal.aborted || !this.isCurrent(generation)) return;
      this.scheduleRetry(generation, `Launch preparation failed: ${this.formatError(error)}`, true);
      return;
    }

    if (this.prepareAbortController === abortController) this.prepareAbortController = null;
    if (abortController.signal.aborted || !this.isCurrent(generation)) return;

    let handle: LaunchHandle;
    try {
      // spawn() is deliberately synchronous: no process can appear after the
      // generation check above and before ownership is recorded below.
      handle = prepared.spawn();
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.scheduleRetry(generation, `CLI spawn failed: ${this.formatError(error)}`, true);
      return;
    }

    const reportedResult = handle.result.catch((error: unknown) => ({
      code: null,
      stdout: '',
      stderr: this.formatError(error),
    }));
    const settled = reportedResult.then(async (result) => {
      await this.waitForChildExit(handle.child);
      return result;
    });
    const run = { generation, handle, settled } satisfies ActiveRun;
    this.activeRun = run;
    this.latestRuntimeState = null;
    this.externalRuntimeState = null;
    this.probeFailureCount = 0;
    this.probeUnavailable = false;
    this.lastStateMessage = `CLI process spawned${handle.child.pid ? ` (PID ${handle.child.pid})` : ''}`;
    this.startHealthyRunTimer(run);
    this.publishState();

    void settled.then((result) => {
      void this.enqueueLifecycle(async () => await this.handleRunSettled(run, result));
    });
  }

  private async handleRunSettled(run: ActiveRun, result: CliRunResult): Promise<void> {
    if (this.activeRun !== run) return;

    this.activeRun = null;
    this.clearHealthyRunTimer();
    this.latestRuntimeState = null;
    this.lastExitCode = result.code;
    this.lastExitAtMs = Date.now();
    this.publishState();

    if (!this.isCurrent(run.generation)) return;

    if (isAlreadyRunningOutcome(result)) {
      if (this.ownershipHeld) {
        const runtime = await this.fetchRuntimeState({ timeoutMs: this.probeTimeoutMs });
        if (!this.isCurrent(run.generation)) return;
        // The data-plane ports are squatted by a draining worker or a foreign
        // process. Keep the Host lease and retry until they free up; killing
        // by PID is never authorized and fatal would not self-heal.
        this.scheduleRetry(
          run.generation,
          runtime?.supervisor
            ? `Waiting for supervised CLI runtime ${runtime.pid} to drain`
            : 'Owned CLI could not bind its endpoints; waiting for the conflicting process to exit',
          false
        );
        return;
      }
      await this.releaseOwnership();
      if (this.existingRuntimePolicy === 'reject') {
        this.markFatal('Another local CLI host is already running', result);
        return;
      }
      const runtime = await this.fetchRuntimeState({ timeoutMs: this.probeTimeoutMs });
      if (!this.isCurrent(run.generation)) return;
      if (runtime) {
        this.observeExternalRuntime(runtime);
      } else {
        this.scheduleRetry(
          run.generation,
          'Local CLI endpoint is occupied but its runtime state is unavailable',
          false
        );
      }
      return;
    }

    const actionAbortController = new AbortController();
    this.exitActionAbortController = actionAbortController;
    let decision;
    try {
      decision = await this.abortable(
        Promise.resolve(this.decideExit(result, actionAbortController.signal)),
        actionAbortController.signal,
        'CLI exit handling canceled'
      );
    } catch (error) {
      if (this.exitActionAbortController === actionAbortController) {
        this.exitActionAbortController = null;
      }
      if (actionAbortController.signal.aborted || !this.isCurrent(run.generation)) return;
      this.scheduleRetry(run.generation, `Exit handling failed: ${this.formatError(error)}`, true);
      return;
    }
    if (this.exitActionAbortController === actionAbortController) {
      this.exitActionAbortController = null;
    }
    if (actionAbortController.signal.aborted || !this.isCurrent(run.generation)) return;

    switch (decision.action) {
      case 'stop': {
        this.desiredState = 'stopped';
        this.beginGeneration();
        this.clearRetryTimer();
        this.stopPolling();
        await this.releaseOwnership();
        this.lastStateMessage = decision.message ?? 'CLI exited cleanly';
        this.publishState();
        this.notifyTerminal({ reason: 'clean_exit', result, message: decision.message });
        return;
      }
      case 'restart': {
        this.failureWindow.reset();
        this.attempt = 0;
        this.clearRetryTimer();
        this.lastStateMessage = decision.message ?? 'CLI requested restart';
        this.publishState();
        await this.reconcile(run.generation);
        return;
      }
      case 'retry': {
        this.scheduleRetry(
          run.generation,
          decision.message ?? this.describeUnexpectedExit(result),
          decision.countFailure,
          decision.failureClass
        );
        return;
      }
      case 'fatal': {
        this.markFatal(decision.message, result);
        return;
      }
    }
  }

  private observeExternalRuntime(
    runtime: CliRuntimeState,
    host: SupervisorHostIdentity | null = null
  ): void {
    if (this.existingRuntimePolicy === 'reject') {
      this.externalRuntimeState = runtime;
      this.latestRuntimeState = null;
      this.markFatal(`Another local CLI host is already running (PID ${runtime.pid})`);
      return;
    }

    this.externalRuntimeState = runtime;
    this.externalHostIdentity = host;
    this.latestRuntimeState = runtime;
    this.probeFailureCount = 0;
    this.probeUnavailable = false;
    this.clearRetryTimer();
    this.lastStateMessage = `Attached to existing CLI runtime (PID ${runtime.pid})`;
    this.publishState();
  }

  private scheduleRetry(
    generation: number,
    reason: string,
    countFailure: boolean,
    failureClass: 'ordinary' | 'v8_oom' = 'ordinary'
  ): void {
    if (!this.isCurrent(generation) || this.fatalReason) return;
    if (countFailure && this.recordFailure(reason, failureClass)) return;

    const delay = buildRetryDelay(this.attempt, this.minRetryMs, this.maxRetryMs, {
      jitterFraction: this.retryJitterFraction,
      random: this.retryRandom,
    });
    this.attempt += 1;
    this.clearRetryTimer();
    const timer = setTimeout(() => {
      if (this.retryTimer !== timer || !this.isCurrent(generation)) return;
      this.retryTimer = null;
      this.pendingRetryInMs = null;
      this.publishState();
      void this.enqueueLifecycle(async () => await this.reconcile(generation));
    }, delay);
    timer.unref?.();
    this.retryTimer = timer;
    this.pendingRetryInMs = delay;
    this.lastStateMessage = `${reason}; retrying in ${Math.round(delay / 1_000)}s`;
    this.publishState();
  }

  private recordFailure(reason: string, failureClass: 'ordinary' | 'v8_oom'): boolean {
    const window = failureClass === 'v8_oom' ? this.oomFailureWindow : this.failureWindow;
    if (!window.record()) return false;
    if (failureClass === 'v8_oom') {
      this.markFatal(
        `CLI exhausted its V8 heap ${window.recentCount} times within ${window.windowMinutes} minutes: ${reason}`
      );
      return true;
    }
    this.markFatal(
      `CLI failed ${this.failureWindow.recentCount} times within ${this.failureWindow.windowMinutes} minutes: ${reason}`
    );
    return true;
  }

  private startHealthyRunTimer(run: ActiveRun): void {
    this.clearHealthyRunTimer();
    const timer = setTimeout(() => {
      if (
        this.healthyRunTimer !== timer ||
        this.activeRun !== run ||
        !this.isCurrent(run.generation) ||
        !isChildProcessRunning(run.handle.child)
      ) {
        return;
      }
      this.healthyRunTimer = null;
      this.attempt = 0;
      this.failureWindow.reset();
      this.publishState();
    }, this.healthyRunMs);
    timer.unref?.();
    this.healthyRunTimer = timer;
  }

  private async terminateActiveRun(reason: string, graceMs: number): Promise<void> {
    const run = this.activeRun;
    if (!run) return;

    this.clearHealthyRunTimer();
    this.lastStateMessage = reason;
    this.publishState();
    const graceDelivered = this.requestGracefulShutdown(run);

    let result = await this.waitForRun(run, graceMs, graceDelivered);
    let killFailure: string | null = null;
    if (!result) {
      this.lastStateMessage = `${reason}; forcing CLI process to exit`;
      this.publishState();
      [result, killFailure] = await Promise.all([
        this.waitForRun(run, this.forceKillWaitMs),
        this.forceKill(run),
      ]);
    }

    if (result) {
      if (this.activeRun === run) this.activeRun = null;
      this.latestRuntimeState = null;
      this.lastExitCode = result.code;
      this.lastExitAtMs = Date.now();
    }
    if (!result || killFailure) {
      const message = `CLI process ${run.handle.child.pid ?? 'unknown'} did not exit after SIGKILL${
        killFailure ? `: ${killFailure}` : ''
      }`;
      this.fatalReason = message;
      this.lastStateMessage = message;
      this.publishState();
      throw new Error(message);
    }
  }

  /**
   * Ask the child to drain: the cross-platform shutdown channel first, SIGTERM
   * to its tree when there is none or it fails. Resolves false when no graceful
   * request could be delivered at all, so the caller escalates at once instead
   * of waiting out a grace period nothing is using.
   */
  private async requestGracefulShutdown(run: ActiveRun): Promise<boolean> {
    const { requestShutdown } = run.handle;
    if (requestShutdown) {
      try {
        await requestShutdown();
        return true;
      } catch {
        // Fall through to the OS signal fallback.
      }
    }
    return await this.signalTerminate(run);
  }

  private async signalTerminate(run: ActiveRun): Promise<boolean> {
    try {
      await makeProcessRunnerLegacy(this.processOptions)(
        Effect.flatMap(
          childProcessTree(run.handle.child, { processGroup: run.handle.processGroup ?? false }),
          (tree) => tree.signal('SIGTERM')
        )
      );
      return true;
    } catch {
      // Undeliverable SIGTERM: end the grace period; force-kill reports failure.
      return false;
    }
  }

  /**
   * SIGKILL the child's whole tree and wait, bounded, until it is gone.
   * Resolves with why the tree could not be proven gone, or null.
   */
  private async forceKill(run: ActiveRun): Promise<string | null> {
    try {
      await terminateChildTreeLegacy(
        run.handle.child,
        {
          graceMs: 0,
          killWaitMs: this.forceKillWaitMs,
          processGroup: run.handle.processGroup ?? false,
        },
        this.processOptions
      );
      return null;
    } catch (error) {
      return this.formatError(error);
    }
  }

  /**
   * The run's result within `timeoutMs`, or null. A `graceDelivered` that
   * resolves false ends the wait early. Every promise raced here settles, so
   * no reaction outlives the call (a shared never-settling promise would keep
   * each run's result alive for the life of the process).
   */
  private async waitForRun(
    run: ActiveRun,
    timeoutMs: number,
    graceDelivered?: Promise<boolean>
  ): Promise<CliRunResult | null> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run.settled,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), timeoutMs);
          timeout.unref?.();
          void graceDelivered?.then((delivered) => {
            if (!delivered) resolve(null);
          });
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async waitForChildExit(child: ChildProcess): Promise<void> {
    if (!isChildProcessRunning(child)) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        child.off('exit', finish);
        child.off('close', finish);
        resolve();
      };
      child.once('exit', finish);
      child.once('close', finish);
      if (!isChildProcessRunning(child)) finish();
    });
  }

  private async abortable<T>(
    operation: Promise<T>,
    signal: AbortSignal,
    message: string
  ): Promise<T> {
    if (signal.aborted) throw new DOMException(message, 'AbortError');
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(new DOMException(message, 'AbortError')));
      signal.addEventListener('abort', onAbort, { once: true });
      operation.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      );
      if (signal.aborted) onAbort();
    });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    const timer = setInterval(() => this.queuePoll(), this.probeIntervalMs);
    timer.unref?.();
    this.pollTimer = timer;
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollQueued = false;
  }

  private queuePoll(): void {
    if (this.pollQueued || (this.desiredState !== 'running' && !this.probeOnly)) return;
    this.pollQueued = true;
    const generation = this.generation;
    void this.enqueueLifecycle(async () => {
      try {
        await this.pollRuntimeState(generation);
      } finally {
        this.pollQueued = false;
      }
    });
  }

  private async pollRuntimeState(generation: number): Promise<void> {
    if (this.probeOnly && this.desiredState === 'stopped') {
      const owner = (await this.ownership?.inspect?.()) ?? null;
      if (!this.probeOnly || this.desiredState !== 'stopped') return;
      const runtime = await this.fetchRuntimeState({ timeoutMs: this.probeTimeoutMs });
      if (!this.probeOnly || this.desiredState !== 'stopped') return;

      if (runtime && owner && runtimeMatchesHost(runtime, owner)) {
        this.externalRuntimeState = runtime;
        this.externalHostIdentity = owner;
        this.latestRuntimeState = runtime;
        this.probeFailureCount = 0;
        this.probeUnavailable = false;
        this.lastStateMessage = `Observed external CLI runtime (PID ${runtime.pid})`;
      } else {
        this.probeFailureCount += 1;
        if (runtime) {
          this.lastStateMessage = owner
            ? `Observed runtime ${runtime.pid} does not match the Local Host lease`
            : `Observed runtime ${runtime.pid} without a Local Host lease`;
        }
        if (this.probeFailureCount >= this.probeFailureThreshold) {
          this.externalRuntimeState = null;
          this.externalHostIdentity = null;
          this.latestRuntimeState = null;
          this.probeUnavailable = true;
          if (!runtime) this.lastStateMessage = undefined;
        }
      }
      this.publishState();
      return;
    }

    if (!this.isCurrent(generation)) return;
    if (this.externalHostIdentity && this.ownership?.inspect) {
      const owner = await this.ownership.inspect();
      if (!this.isCurrent(generation)) return;
      if (!owner || !sameHostIdentity(owner, this.externalHostIdentity)) {
        this.externalRuntimeState = null;
        this.externalHostIdentity = null;
        this.latestRuntimeState = null;
        this.lastStateMessage = 'Attached Local Host ownership disappeared';
        this.publishState();
        await this.reconcile(generation);
        return;
      }
    }
    const runtime = await this.fetchRuntimeState({ timeoutMs: this.probeTimeoutMs });
    if (!this.isCurrent(generation)) return;

    const activePid = this.activeRun?.handle.child.pid;
    if (runtime) {
      if (this.externalRuntimeState && !this.activeRun) {
        if (this.externalHostIdentity && runtimeMatchesHost(runtime, this.externalHostIdentity)) {
          this.observeExternalRuntime(runtime, this.externalHostIdentity);
          return;
        }
        this.probeFailureCount += 1;
        this.latestRuntimeState = null;
        this.lastStateMessage = `Observed runtime ${runtime.pid} does not match the attached Host`;
        if (this.probeFailureCount >= this.probeFailureThreshold) {
          this.externalRuntimeState = null;
          this.externalHostIdentity = null;
          this.probeUnavailable = true;
          this.publishState();
          await this.reconcile(generation);
        } else {
          this.publishState();
        }
        return;
      }
      this.probeFailureCount = 0;
      this.probeUnavailable = false;
      if (activePid !== undefined && runtime.pid === activePid) {
        this.latestRuntimeState = runtime;
        this.externalRuntimeState = null;
        this.lastStateMessage = undefined;
      } else if (!this.activeRun) {
        if (this.ownershipHeld) {
          // Same blocked-not-fatal rule as reconcile: observe the unowned or
          // draining runtime and retry; it self-heals once the process exits.
          this.lastStateMessage = runtime.supervisor
            ? `Waiting for supervised CLI runtime ${runtime.pid} to drain`
            : `CLI runtime ${runtime.pid} is running without Local Host ownership; waiting for it to exit`;
          this.publishState();
          if (!this.retryTimer) this.scheduleRetry(generation, this.lastStateMessage, false);
        } else {
          this.observeExternalRuntime(runtime);
        }
        return;
      } else {
        this.latestRuntimeState = null;
        this.lastStateMessage = `Observed a different CLI runtime (PID ${runtime.pid})`;
      }
      this.publishState();
      return;
    }

    this.probeFailureCount += 1;
    if (this.probeFailureCount < this.probeFailureThreshold) return;

    this.latestRuntimeState = null;
    this.probeUnavailable = true;
    if (this.externalRuntimeState) {
      this.externalRuntimeState = null;
      this.externalHostIdentity = null;
      this.lastStateMessage = 'Attached CLI runtime disappeared';
      this.publishState();
      await this.reconcile(generation);
      return;
    }
    if (this.activeRun) {
      this.lastStateMessage = 'CLI runtime state is unavailable';
    }
    this.publishState();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.pendingRetryInMs = null;
  }

  private clearHealthyRunTimer(): void {
    if (this.healthyRunTimer) clearTimeout(this.healthyRunTimer);
    this.healthyRunTimer = null;
  }

  private async releaseOwnership(): Promise<void> {
    if (!this.ownershipHeld || !this.ownership) return;
    this.ownershipHeld = false;
    await this.ownership.release();
  }

  private markFatal(reason: string, result?: CliRunResult): void {
    if (this.fatalReason === reason) return;
    this.fatalReason = reason;
    this.clearRetryTimer();
    this.clearHealthyRunTimer();
    this.stopPolling();
    this.lastStateMessage = reason;
    this.publishState();
    this.notifyTerminal({ reason: 'fatal', result, message: reason });
  }

  private notifyTerminal(termination: SupervisorTermination): void {
    try {
      this.onTerminal?.(termination);
    } catch {
      // Observers cannot alter lifecycle control flow.
    }
  }

  private buildState(): SupervisorState {
    const runtime = this.latestRuntimeState;
    const childRunning = isChildProcessRunning(this.activeRun?.handle.child ?? null);
    let phase: SupervisorPhase;
    if (this.desiredState === 'stopped') {
      phase = childRunning ? 'stopping' : runtime ? phaseFromRuntime(runtime) : 'stopped';
    } else if (this.fatalReason) {
      phase = 'fatal';
    } else if (runtime) {
      phase = phaseFromRuntime(runtime);
    } else if (this.retryTimer) {
      phase = 'reconnecting';
    } else if (childRunning || this.prepareAbortController) {
      phase = this.probeUnavailable ? 'reconnecting' : 'starting';
    } else if (this.probeUnavailable) {
      phase = 'offline';
    } else {
      phase = 'starting';
    }

    return {
      phase,
      desiredState: this.desiredState,
      updatedAtMs: this.state.updatedAtMs,
      runtime: runtime ?? undefined,
      runtimeOwnership: runtime
        ? this.externalRuntimeState === runtime
          ? 'external'
          : 'owned'
        : undefined,
      message: this.fatalReason ?? this.lastStateMessage ?? runtime?.issues[0]?.message,
      retryAttempt: this.attempt > 0 ? this.attempt : undefined,
      retryInMs: this.pendingRetryInMs ?? undefined,
      lastExitCode: this.lastExitCode,
      lastExitAtMs: this.lastExitAtMs,
    };
  }

  private publishState(): void {
    const nextState = this.buildState();
    if (JSON.stringify(this.state) === JSON.stringify(nextState)) return;
    nextState.updatedAtMs = Date.now();
    this.state = nextState;
    try {
      this.onStateChange?.(nextState);
    } catch {
      // Observers cannot alter lifecycle control flow.
    }
  }

  private describeUnexpectedExit(result: CliRunResult): string {
    const detail = (result.stderr || result.stdout || 'unknown error')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    return `CLI exited with ${result.code === null ? 'a signal' : `code ${result.code}`}: ${detail}`;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
