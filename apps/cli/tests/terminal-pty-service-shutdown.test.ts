import { beforeEach, expect, it, vi } from 'vitest';
import { makeTerminalPtyService } from '../src/lib/terminal-pty-service';
import { LodyFleet } from '../src/lib/lody-fleet';
import type { Logger } from '../src/utils/logger';

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:module', async (original) => {
  const actual = await original<typeof import('node:module')>();
  return {
    createRequire: (...args: Parameters<typeof actual.createRequire>) => {
      const require = actual.createRequire(...args);
      return Object.assign(
        (id: string) => (id === '@lydell/node-pty' ? native : require(id)),
        require
      );
    },
  };
});
const logger: Logger = {
  info() {},
  warn() {},
  error() {},
  success() {},
  debug() {},
  setLevel() {},
  child: () => logger,
  close: async () => {},
};
const params = { sessionId: 'session-1', cols: 80, rows: 24 };
beforeEach(() => {
  native.spawn.mockReset();
});

it('forced fleet cleanup closes existing PTYs while a workdir read hangs and prevents its late spawn', async () => {
  const kill = vi.fn();
  native.spawn.mockReturnValue({ kill, onData() {}, onExit() {} });
  let resolveWorkdir: (cwd: string) => void = () => {};
  const pendingWorkdir = new Promise<string>((resolve) => {
    resolveWorkdir = resolve;
  });
  const resolveSessionWorkdir = vi
    .fn()
    .mockResolvedValueOnce(process.cwd())
    .mockReturnValue(pendingWorkdir);
  const service = makeTerminalPtyService({ logger, resolveSessionWorkdir });
  await service.open(params);
  const pending = service.open(params);
  const settled = vi.fn();
  void pending.then(settled, settled);
  const rejected = expect(pending).rejects.toThrow('terminal_service_stopping');
  const fleet: LodyFleet = Object.assign(Object.create(LodyFleet.prototype), {
    runtimes: new Map(),
    terminalPtyService: service,
  });
  await fleet.forceTerminateSessions();
  expect(settled).not.toHaveBeenCalled();
  expect(kill).toHaveBeenCalledOnce();
  expect(native.spawn).toHaveBeenCalledOnce();
  await expect(service.open(params)).rejects.toThrow('terminal_service_stopping');
  expect(resolveSessionWorkdir).toHaveBeenCalledTimes(2);
  resolveWorkdir(process.cwd());
  await rejected;
  expect(native.spawn).toHaveBeenCalledOnce();
});

it('attempts every PTY kill and retains failed ownership for a retry', async () => {
  const firstKill = vi.fn().mockImplementationOnce(() => {
    throw new Error('kill refused');
  });
  const secondKill = vi.fn();
  native.spawn
    .mockReturnValueOnce({ kill: firstKill, onData() {}, onExit() {} })
    .mockReturnValueOnce({ kill: secondKill, onData() {}, onExit() {} });
  const service = makeTerminalPtyService({
    logger,
    resolveSessionWorkdir: async () => process.cwd(),
  });
  await service.open(params);
  await service.open(params);
  expect(() => service.closeAll()).toThrow('Terminal PTY cleanup failed');
  expect(secondKill).toHaveBeenCalledOnce();
  expect(service.list(params.sessionId)).toHaveLength(2);
  service.closeAll();
  expect(firstKill).toHaveBeenCalledTimes(2);
});

it('retains a failed session-close kill for fleet retry and releases only on observed exit', async () => {
  const kill = vi.fn().mockImplementationOnce(() => {
    throw new Error('session close refused');
  });
  let exit: (event: { exitCode: number }) => void = () => {};
  native.spawn.mockReturnValue({
    kill,
    onData() {},
    onExit: (listener: typeof exit) => {
      exit = listener;
    },
  });
  const service = makeTerminalPtyService({
    logger,
    resolveSessionWorkdir: async () => process.cwd(),
  });
  const opened = await service.open(params);
  expect(() => service.closeSession(params.sessionId)).not.toThrow();
  expect(service.list(params.sessionId).map((terminal) => terminal.terminalId)).toEqual([
    opened.terminalId,
  ]);
  service.closeAll();
  expect(kill).toHaveBeenCalledTimes(2);
  expect(service.list(params.sessionId)).toHaveLength(1);
  exit({ exitCode: 0 });
  expect(service.list(params.sessionId)).toHaveLength(0);
});
