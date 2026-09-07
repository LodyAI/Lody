import { ACP_STARTUP_QUEUE_WAIT_TIMEOUT_MS } from '@lody/shared/acp-startup-budget';

import type { Logger } from '@/utils/logger';

/**
 * Process-wide cap on ACP spawn + initialize + newSession/loadSession.
 *
 * Each Codex session starts a lody.exe ACP adapter, a Codex app-server, and a
 * lody.exe MCP subprocess. Unbounded concurrent restores contend on `~/.codex`
 * and starve already-running sessions; a Lody restart then appears to "fix"
 * every frozen session because it serializes the next restore wave.
 */
export const DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS = 2;
export const ACP_SESSION_START_GATE_ENV = 'LODY_MAX_CONCURRENT_ACP_SESSION_STARTS';

export type AcpSessionStartGateOptions = {
  maxConcurrent?: number;
  waitTimeoutMs?: number;
};

export type AcpSessionStartSlotOptions = {
  label: string;
  logger?: Logger;
  abortSignal?: AbortSignal;
  /** Overrides the gate's default queue deadline for one acquisition. */
  waitTimeoutMs?: number;
};

/**
 * A start that never reached the front of the queue.
 *
 * The wait is bounded so that it stays inside the machine's own startup budget:
 * a queued start emits no progress frame, so an unbounded queue is silence the
 * client eventually gives up on — and a client timeout carries no reason, while
 * this does.
 */
export class AcpSessionStartQueueTimeoutError extends Error {
  readonly waitedMs: number;

  constructor(label: string, waitedMs: number, inUse: number, maxConcurrent: number) {
    super(
      `[${label}] Timed out after ${waitedMs}ms waiting for an ACP session-start slot ` +
        `(${inUse}/${maxConcurrent} in use). The machine is busy starting other agents.`
    );
    this.name = 'AcpSessionStartQueueTimeoutError';
    this.waitedMs = waitedMs;
  }
}

type QueuedAcquire = {
  grant(): void;
  abort(error: unknown): void;
};

export const resolveAcpSessionStartLimit = (explicit?: number): number => {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.max(1, Math.floor(explicit));
  }
  const raw = process.env[ACP_SESSION_START_GATE_ENV]?.trim();
  if (!raw) {
    return DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS;
  }
  return Math.floor(parsed);
};

export class AcpSessionStartGate {
  private available: number;
  private readonly waiters: QueuedAcquire[] = [];
  readonly maxConcurrent: number;
  readonly waitTimeoutMs: number;

  constructor(options?: AcpSessionStartGateOptions) {
    this.maxConcurrent = resolveAcpSessionStartLimit(options?.maxConcurrent);
    this.available = this.maxConcurrent;
    this.waitTimeoutMs = options?.waitTimeoutMs ?? ACP_STARTUP_QUEUE_WAIT_TIMEOUT_MS;
  }

  get inUse(): number {
    return this.maxConcurrent - this.available;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async run<T>(options: AcpSessionStartSlotOptions, fn: () => Promise<T>): Promise<T> {
    await this.acquire(options);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(options: AcpSessionStartSlotOptions): Promise<void> {
    options.abortSignal?.throwIfAborted();
    if (this.available > 0) {
      this.available -= 1;
      return;
    }

    options.logger?.debug(
      `[${options.label}] Waiting for ACP session-start slot (inUse=${this.inUse} queued=${this.queued + 1} max=${this.maxConcurrent})`
    );

    const waitTimeoutMs = options.waitTimeoutMs ?? this.waitTimeoutMs;
    const waitStartedAtMs = Date.now();

    await new Promise<void>((resolve, reject) => {
      let waiter: QueuedAcquire;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const dequeue = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
      };
      const onAbort = (): void => {
        dequeue();
        waiter.abort(new DOMException('ACP session start was cancelled', 'AbortError'));
      };
      const onTimeout = (): void => {
        dequeue();
        waiter.abort(
          new AcpSessionStartQueueTimeoutError(
            options.label,
            Date.now() - waitStartedAtMs,
            this.inUse,
            this.maxConcurrent
          )
        );
      };
      waiter = {
        grant: () => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          options.abortSignal?.removeEventListener('abort', onAbort);
          resolve();
        },
        abort: (error) => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          options.abortSignal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      this.waiters.push(waiter);
      if (waitTimeoutMs > 0 && Number.isFinite(waitTimeoutMs)) {
        timeoutId = setTimeout(onTimeout, waitTimeoutMs);
        // The daemon must still exit while a start is queued behind a stuck one.
        timeoutId.unref?.();
      }
      options.abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (options.abortSignal?.aborted) {
        onAbort();
      }
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.grant();
      return;
    }
    this.available = Math.min(this.maxConcurrent, this.available + 1);
  }
}

let defaultGate: AcpSessionStartGate | undefined;

export const getAcpSessionStartGate = (): AcpSessionStartGate => {
  defaultGate ??= new AcpSessionStartGate();
  return defaultGate;
};

export const withAcpSessionStartSlot = <T>(
  options: AcpSessionStartSlotOptions,
  fn: () => Promise<T>
): Promise<T> => getAcpSessionStartGate().run(options, fn);

export const __test__ = {
  resetDefaultGate(): void {
    defaultGate = undefined;
  },
  setDefaultGate(gate: AcpSessionStartGate): void {
    defaultGate = gate;
  },
};
