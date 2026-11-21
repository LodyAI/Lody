import os from 'node:os';

const MIB = 1024 * 1024;
const DEFAULT_OUTPUT_TAIL_BYTES = 64 * 1024;
const WORKER_HEAP_FRACTION = 0.2;
const MIN_WORKER_HEAP_MIB = 768;
const MAX_WORKER_HEAP_MIB = 4096;
const MIN_WORKER_HEAP_OVERRIDE_MIB = 256;
const MAX_WORKER_HEAP_OVERRIDE_MIB = 65536;

/** Operator override of the Worker's V8 old-space limit, in MiB. */
export const WORKER_MAX_OLD_SPACE_ENV = 'LODY_WORKER_MAX_OLD_SPACE_MB';

const V8_OOM_PATTERNS = [
  /JavaScript heap out of memory/i,
  /Reached heap limit/i,
  /Ineffective mark-compacts near heap limit/i,
  /Allocation failed - process out of memory/i,
];

export function calculateWorkerMaxOldSpaceMiB(totalMemoryBytes: number = os.totalmem()): number {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) return MIN_WORKER_HEAP_MIB;
  const proportionalMiB = Math.floor((totalMemoryBytes * WORKER_HEAP_FRACTION) / MIB);
  return Math.max(MIN_WORKER_HEAP_MIB, Math.min(MAX_WORKER_HEAP_MIB, proportionalMiB));
}

/** A whole number of MiB in the supported range, or `undefined` when it is not one. */
export function parseWorkerMaxOldSpaceOverride(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const mib = Number(value.trim());
  return mib >= MIN_WORKER_HEAP_OVERRIDE_MIB && mib <= MAX_WORKER_HEAP_OVERRIDE_MIB
    ? mib
    : undefined;
}

/**
 * The Worker heap limit: a valid operator override, otherwise the machine-relative
 * budget. Memory-billed hosts set the override; a 32 GB VM otherwise grants 4 GiB.
 */
export function resolveWorkerMaxOldSpaceMiB(
  env: Record<string, string | undefined>,
  totalMemoryBytes: number = os.totalmem()
): number {
  return (
    parseWorkerMaxOldSpaceOverride(env[WORKER_MAX_OLD_SPACE_ENV]) ??
    calculateWorkerMaxOldSpaceMiB(totalMemoryBytes)
  );
}

export function appendOutputTail(
  current: string,
  chunk: string | Buffer,
  maxBytes: number = DEFAULT_OUTPUT_TAIL_BYTES
): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  const currentBuffer = Buffer.from(current);
  const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const combined = Buffer.concat([currentBuffer, chunkBuffer]);
  if (combined.length <= maxBytes) return combined.toString();
  return combined.subarray(combined.length - maxBytes).toString();
}

export type ProcessExitSnapshot = {
  stdout?: string;
  stderr?: string;
  terminationKind?: string;
};

export function isV8OutOfMemoryExit(result: ProcessExitSnapshot): boolean {
  if (result.terminationKind === 'v8_oom') return true;
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  return V8_OOM_PATTERNS.some((pattern) => pattern.test(output));
}
