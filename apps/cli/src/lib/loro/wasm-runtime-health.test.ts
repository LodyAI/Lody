import { EventEmitter } from 'node:events';
import { LoroDoc } from 'loro-crdt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import {
  installWasmFaultMonitor,
  readLoroWasmHeapBytes,
  reportIfWasmFault,
  resetWasmRuntimeHealthForTests,
  resolveLoroWasmMemory,
  startWasmHeapMonitor,
  WASM32_MEMORY_LIMIT_BYTES,
  type WasmFault,
} from './wasm-runtime-health';

const LORO_OOM_REPORT =
  'loro-crdt: out of WASM memory: allocation of 46059818 bytes failed\n\nStack:\n\nError: ...';

function createTestLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(() => logger),
    close: vi.fn(async () => {}),
  };
  return logger;
}

function monitorHarness() {
  const printed: unknown[][] = [];
  const fakeConsole = { error: (...args: unknown[]) => void printed.push(args) };
  const fakeProcess = new EventEmitter();
  const faults: WasmFault[] = [];
  const uninstall = installWasmFaultMonitor((fault) => faults.push(fault), {
    console: fakeConsole,
    process: fakeProcess as unknown as NodeJS.Process,
  });
  return { fakeConsole, fakeProcess, faults, printed, uninstall };
}

afterEach(() => {
  resetWasmRuntimeHealthForTests();
});

describe('WebAssembly fault monitor', () => {
  it("latches Loro's out-of-memory report once and keeps printing it", () => {
    const { fakeConsole, faults, printed } = monitorHarness();

    fakeConsole.error('[loro-repo] unrelated diagnostic');
    expect(faults).toEqual([]);

    fakeConsole.error(LORO_OOM_REPORT);
    fakeConsole.error(new WebAssembly.RuntimeError('unreachable'));

    expect(faults).toHaveLength(1);
    expect(faults[0]?.source).toBe('console');
    expect(faults[0]?.detail).toContain('out of WASM memory');
    expect(printed).toHaveLength(3);
  });

  it('latches a trap that is only rejected, or only reported from a catch site', () => {
    const rejected = monitorHarness();
    rejected.fakeProcess.emit('unhandledRejection', new Error('plain failure'));
    expect(rejected.faults).toEqual([]);
    rejected.fakeProcess.emit(
      'unhandledRejection',
      new Error('export failed', { cause: new WebAssembly.RuntimeError('unreachable') })
    );
    expect(rejected.faults.map((fault) => fault.source)).toEqual(['unhandledRejection']);
    rejected.uninstall();
    resetWasmRuntimeHealthForTests();

    const reported = monitorHarness();
    expect(reportIfWasmFault(new Error('cannot recursively acquire mutex'))).toBe(true);
    expect(reportIfWasmFault(new Error('network down'))).toBe(false);
    expect(reported.faults.map((fault) => fault.source)).toEqual(['reported']);
  });

  it('delivers a fault recorded before installation', async () => {
    reportIfWasmFault(new WebAssembly.RuntimeError('memory access out of bounds'));
    const { faults } = monitorHarness();
    await Promise.resolve();
    expect(faults.map((fault) => fault.detail)).toEqual(['memory access out of bounds']);
  });

  it('restores console.error and stops listening after uninstall', () => {
    const { fakeConsole, fakeProcess, faults, uninstall } = monitorHarness();
    const wrapped = fakeConsole.error;
    uninstall();
    expect(fakeConsole.error).not.toBe(wrapped);
    fakeConsole.error(LORO_OOM_REPORT);
    fakeProcess.emit('unhandledRejection', new WebAssembly.RuntimeError('unreachable'));
    expect(faults).toEqual([]);
  });
});

describe('Loro WebAssembly heap', () => {
  it("reads the live instance's memory, which grows with document data", async () => {
    expect(readLoroWasmHeapBytes()).toBeNull();
    await resolveLoroWasmMemory();
    const before = readLoroWasmHeapBytes();
    expect(before).toBeGreaterThan(0);

    const doc = new LoroDoc();
    doc.getText('t').insert(0, 'x'.repeat(8 * 1024 * 1024));
    doc.commit();

    expect(readLoroWasmHeapBytes()).toBeGreaterThan(before ?? 0);
    doc.free();
  });

  it('warns once per threshold as the heap nears the 4 GiB limit', () => {
    const logger = createTestLogger();
    let bytes: number | null = 1024 * 1024 * 1024;
    const monitor = startWasmHeapMonitor(logger, () => bytes, {
      setInterval: () => ({}),
      clearInterval: () => {},
    });
    expect(logger.warn).not.toHaveBeenCalled();

    bytes = WASM32_MEMORY_LIMIT_BYTES * 0.8;
    monitor.sample();
    monitor.sample();
    bytes = WASM32_MEMORY_LIMIT_BYTES * 0.95;
    monitor.sample();
    bytes = null;
    monitor.sample();

    const warnings = vi.mocked(logger.warn).mock.calls.map(([message]) => String(message));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('80% of its 4 GiB limit');
    expect(warnings[1]).toContain('95% of its 4 GiB limit');
    expect(vi.mocked(logger.debug)).toHaveBeenCalledTimes(4);
  });
});
