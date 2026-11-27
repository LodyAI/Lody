import { setGlobalMemoryBudget } from 'loro-crdt';

const MIB = 1024 * 1024;
export const LORO_WASM_HARD_LIMIT_BYTES = 512 * MIB;

export function configureLoroWasmBudget(): void {
  setGlobalMemoryBudget({
    maxHeapBytes: LORO_WASM_HARD_LIMIT_BYTES,
    maxWasmLinearBytes: LORO_WASM_HARD_LIMIT_BYTES,
    highWatermarkBytes: 200 * MIB,
    targetWatermarkBytes: 160 * MIB,
  });
}
