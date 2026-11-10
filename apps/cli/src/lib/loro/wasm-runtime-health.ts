import * as loro from 'loro-crdt';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

/**
 * Process-wide health of the WebAssembly runtimes the daemon depends on, chiefly
 * Loro's single 32-bit instance.
 *
 * A trap (`WebAssembly.RuntimeError`) aborts Rust code mid-operation: locks stay
 * held and invariants stay broken, so every later call on the affected documents
 * traps again (`cannot recursively acquire mutex`, `unreachable`). Loro reports an
 * allocation failure through `console.error` just before it traps. Most callers
 * catch and log these errors, so the daemon used to keep running on a poisoned
 * instance until an unguarded timer finally threw.
 *
 * This module only records the first fault and notifies the process boundary
 * (`commands/start.ts`), which owns the orderly shutdown and exit.
 */

/** Printed by loro-crdt's allocation-failure handler immediately before the trap. */
const LORO_OUT_OF_MEMORY_MARKER = 'loro-crdt: out of WASM memory';
/** Rust panic text when a lock left held by an earlier trap is acquired again. */
const POISONED_LOCK_MARKER = 'cannot recursively acquire mutex';
const MAX_CAUSE_DEPTH = 4;

export type WasmFaultSource = 'console' | 'unhandledRejection' | 'reported';

export interface WasmFault {
  source: WasmFaultSource;
  detail: string;
}

const mentionsWasmFault = (text: string): boolean =>
  text.includes(LORO_OUT_OF_MEMORY_MARKER) || text.includes(POISONED_LOCK_MARKER);

/** Whether `error` (or its cause chain) is a WebAssembly trap or Loro's out-of-memory report. */
export function isWasmFault(error: unknown, depth = 0): boolean {
  if (error instanceof WebAssembly.RuntimeError) return true;
  if (typeof error === 'string') return mentionsWasmFault(error);
  if (!(error instanceof Error) || depth >= MAX_CAUSE_DEPTH) return false;
  if (mentionsWasmFault(error.message)) return true;
  if (error instanceof AggregateError && error.errors.some((e) => isWasmFault(e, depth + 1))) {
    return true;
  }
  return isWasmFault(error.cause, depth + 1);
}

type FaultListener = (fault: WasmFault) => void;

let firstFault: WasmFault | null = null;
let listener: FaultListener | null = null;

const latch = (fault: WasmFault): void => {
  if (firstFault) return;
  firstFault = fault;
  listener?.(fault);
};

/**
 * Record `error` if it is a WebAssembly fault. Safe to call from any catch site;
 * it never throws and never exits. Returns whether the error was a fault.
 */
export function reportIfWasmFault(error: unknown): boolean {
  if (!isWasmFault(error)) return false;
  latch({ source: 'reported', detail: formatErrorMessage(error) });
  return true;
}

export interface WasmFaultMonitorDeps {
  console: Pick<Console, 'error'>;
  process: Pick<NodeJS.Process, 'on' | 'off'>;
}

/**
 * Observe WebAssembly faults process-wide and call `onFault` once, for the first
 * one. A fault recorded before installation is delivered on installation.
 * Returns an uninstaller.
 */
export function installWasmFaultMonitor(
  onFault: FaultListener,
  deps: WasmFaultMonitorDeps = { console, process }
): () => void {
  const originalError = deps.console.error;
  const wrappedError = (...args: unknown[]) => {
    originalError.apply(deps.console, args);
    if (args.some((arg) => isWasmFault(arg))) {
      latch({ source: 'console', detail: args.map(String).join(' ').slice(0, 500) });
    }
  };
  deps.console.error = wrappedError;
  // Observe only. The telemetry handler keeps owning the exit code for rejections.
  const onRejection = (reason: unknown) => {
    if (isWasmFault(reason)) {
      latch({ source: 'unhandledRejection', detail: formatErrorMessage(reason) });
    }
  };
  deps.process.on('unhandledRejection', onRejection);
  listener = onFault;
  const pending = firstFault;
  if (pending) queueMicrotask(() => onFault(pending));

  return () => {
    if (listener === onFault) listener = null;
    if (deps.console.error === wrappedError) deps.console.error = originalError;
    deps.process.off('unhandledRejection', onRejection);
  };
}

declare const __LODY_BUNDLED_LORO_WASM__: boolean;

/**
 * Loro's WebAssembly memory. The CJS `nodejs` entry (dev builds and tests)
 * exposes its instance as `__wasm`. The production bundle uses the `bundler`
 * entry, which does not, so the build flag imports the shared wasm module itself:
 * vite-plugin-wasm instantiates it once, so this is the same memory.
 */
let resolvedMemory: WebAssembly.Memory | null = null;

export async function resolveLoroWasmMemory(): Promise<WebAssembly.Memory | null> {
  if (resolvedMemory) return resolvedMemory;
  const direct = (loro as unknown as { __wasm?: { memory?: unknown } }).__wasm?.memory;
  if (direct instanceof WebAssembly.Memory) {
    resolvedMemory = direct;
  } else if (typeof __LODY_BUNDLED_LORO_WASM__ !== 'undefined' && __LODY_BUNDLED_LORO_WASM__) {
    const { memory } = await import('loro-crdt/bundler/loro_wasm_bg.wasm');
    if (memory instanceof WebAssembly.Memory) resolvedMemory = memory;
  }
  return resolvedMemory;
}

/**
 * Current size of Loro's WebAssembly memory, or `null` until
 * {@link resolveLoroWasmMemory} has found it. WebAssembly memory never shrinks,
 * so this is the high-water mark of everything Loro has held at once.
 */
export function readLoroWasmHeapBytes(): number | null {
  return resolvedMemory?.buffer.byteLength ?? null;
}

/** 32-bit WebAssembly memory cannot grow past 4 GiB. */
export const WASM32_MEMORY_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
/** Fractions of the 4 GiB limit that each leave one warning per process. */
const HEAP_WARNING_THRESHOLDS = [0.75, 0.9] as const;
export const WASM_HEAP_LOG_INTERVAL_MS = 10 * 60 * 1000;

export interface WasmHeapMonitorDeps {
  setInterval: (callback: () => void, ms: number) => { unref?: () => unknown };
  clearInterval: (timer: { unref?: () => unknown }) => void;
}

const defaultHeapMonitorDeps: WasmHeapMonitorDeps = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

const toMiB = (bytes: number): number => Math.round(bytes / 1024 / 1024);

/**
 * Log Loro's WebAssembly heap size periodically, and warn once per threshold as
 * it nears the 4 GiB limit. The heap never shrinks, so its size is the high-water
 * mark of live document data.
 */
export function startWasmHeapMonitor(
  logger: Logger,
  readHeapBytes: () => number | null = readLoroWasmHeapBytes,
  deps: WasmHeapMonitorDeps = defaultHeapMonitorDeps,
  intervalMs = WASM_HEAP_LOG_INTERVAL_MS
): { sample: () => void; stop: () => void } {
  let warned = 0;
  const sample = () => {
    const bytes = readHeapBytes();
    if (bytes === null) return;
    const fraction = bytes / WASM32_MEMORY_LIMIT_BYTES;
    logger.debug(
      `[wasm-heap] loro=${toMiB(bytes)}MiB of ${toMiB(WASM32_MEMORY_LIMIT_BYTES)}MiB (${Math.round(fraction * 100)}%)`
    );
    for (const threshold of HEAP_WARNING_THRESHOLDS.slice(warned)) {
      if (fraction < threshold) break;
      warned += 1;
      logger.warn(
        `[wasm-heap] Loro WebAssembly heap reached ${toMiB(bytes)}MiB, ${Math.round(fraction * 100)}% of its 4 GiB limit`
      );
    }
  };
  const timer = deps.setInterval(sample, intervalMs);
  timer.unref?.();
  sample();
  return { sample, stop: () => deps.clearInterval(timer) };
}

/** Test-only: forget a latched fault so each case starts healthy. */
export function resetWasmRuntimeHealthForTests(): void {
  firstFault = null;
  listener = null;
  resolvedMemory = null;
}
