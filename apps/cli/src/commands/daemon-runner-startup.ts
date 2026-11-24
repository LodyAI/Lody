import type { CliRunResult, SupervisorState } from '@lody/cli-supervisor';
import { EXIT_CODE_RETRYABLE_STARTUP } from '@/lib/machine-lifecycle';

const MAX_STARTUP_ERROR_CHARS = 2_000;

/**
 * The watchdog owning the Host lease is not enough to call a daemon ready.
 * The supervised worker must publish the CLI's local-ready boundary first.
 */
export function isDaemonWorkerReady(state: SupervisorState): boolean {
  return state.runtime?.startupStage === 'ready' && state.runtime.phase !== 'fatal';
}

/** A temporary startup dependency failure keeps the launch handshake pending. */
export function isRetryableDaemonWorkerStartupExit(result: CliRunResult): boolean {
  return result.code === EXIT_CODE_RETRYABLE_STARTUP;
}

/** Keep the foreground launch error useful while staying below the handshake limit. */
export function describeDaemonWorkerStartupFailure(result: CliRunResult): string {
  const output = (result.stderr.trim() || result.stdout.trim()).split('\0').join('');
  if (output) {
    return output.length <= MAX_STARTUP_ERROR_CHARS
      ? output
      : `…${output.slice(-MAX_STARTUP_ERROR_CHARS)}`;
  }

  if (result.signal) {
    return `CLI worker exited from signal ${result.signal} before becoming ready`;
  }
  return `CLI worker exited with code ${result.code ?? 'unknown'} before becoming ready`;
}

/** A versioned candidate (including rollback) cannot own an unbounded startup. */
export function startManagedWorkerReadinessDeadline(options: {
  timeoutMs: number;
  shutdownGraceMs: number;
  requestShutdown: () => void | Promise<void>;
  terminate: () => Promise<void>;
  onExpired: () => void;
  onTerminationFailure: (error: unknown) => void;
}): { readonly expired: boolean; clear: () => void } {
  let expired = false;
  let cleared = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const readyTimer = setTimeout(() => {
    if (cleared) return;
    expired = true;
    options.onExpired();
    // Arm escalation before requesting IPC shutdown: the callback itself may hang.
    forceTimer = setTimeout(() => {
      if (cleared) return;
      void options.terminate().catch(options.onTerminationFailure);
    }, options.shutdownGraceMs);
    forceTimer.unref?.();
    try {
      void Promise.resolve(options.requestShutdown()).catch(() => {});
    } catch {
      /* Exact owned-tree escalation is already armed. */
    }
  }, options.timeoutMs);
  readyTimer.unref?.();
  return {
    get expired() {
      return expired;
    },
    clear() {
      cleared = true;
      clearTimeout(readyTimer);
      if (forceTimer) clearTimeout(forceTimer);
    },
  };
}
