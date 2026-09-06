import { afterEach, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { SessionId, WorkspaceId } from '@lody/shared';
import { Session } from '../session/session';
import { createStartShutdownController } from './start-shutdown';
import type { Logger } from '../utils/logger';
import type { SessionProcessHandle } from '../session/session-sandbox';

afterEach(() => vi.useRealTimers());

it('runs the Session process phase before outer exit when terminal disposal hangs', async () => {
  vi.useFakeTimers();
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
    close: async () => {},
  };
  const session = new Session(
    {
      workspaceId: 'workspace' as WorkspaceId,
      sessionId: 'session' as SessionId,
      userId: 'user',
      machineId: 'machine',
      agentCliType: 'builtin',
      agentType: 'codex',
      userName: 'test',
      userEmail: 'test@example.com',
    },
    logger,
    process.cwd()
  );
  session.acpSessionId = 'acp' as never;
  const dispose = vi
    .spyOn(session.terminalManager, 'disposeAll')
    .mockImplementation(() => new Promise(() => {}));
  const child = new EventEmitter() as ChildProcess;
  child.exitCode = null;
  child.signalCode = null;
  const terminate = vi.fn(async () => {
    child.signalCode = 'SIGKILL';
  });
  const handle: SessionProcessHandle = {
    child,
    terminate,
    inspectExit: async () => null,
    onExit: () => () => {},
    onClose: () => () => {},
    onError: () => () => {},
  };
  // @ts-expect-error - synthetic owned process fixture
  session.agentProcess = handle;
  const exit = vi.fn();
  const controller = createStartShutdownController({
    signals: [],
    logger,
    shutdown: () => session.terminate(false),
    forceShutdown: () => session.terminate(true),
    flushTelemetry: async () => {},
    exit,
  });
  const result = controller.shutdown('SIGTERM');
  await vi.advanceTimersByTimeAsync(14_999);
  expect(terminate).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(terminate).toHaveBeenCalledWith(true);
  expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5_000);
  await result;
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(143);
  // Failed terminal cleanup remains truthfully retryable despite root termination.
  // @ts-expect-error - retained cleanup state
  expect(session.status).toBe('stopping');
});
