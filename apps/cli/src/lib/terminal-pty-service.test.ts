import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TerminalExitEvent } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import { makeTerminalPtyService } from './terminal-pty-service';

const logger = {
  debug: () => {},
  trace: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

// A real PTY: the process-group semantics under test are the kernel's, not a model's.
describe.skipIf(process.platform === 'win32')('terminal PTY termination', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lody-terminal-pty-'));
    vi.stubEnv('LODY_DISABLE_SHELL_ENV', '1');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('ends a shell that ignores the hangup instead of leaking it', async () => {
    const shell = path.join(root, 'stubborn-shell');
    await writeFile(
      shell,
      "#!/bin/sh\ntrap '' HUP TERM\necho ready\nwhile read line; do :; done\n",
      { mode: 0o700 }
    );
    vi.stubEnv('SHELL', shell);
    const service = makeTerminalPtyService({ logger, resolveSessionWorkdir: async () => root });
    const ready = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<TerminalExitEvent>();
    let output = '';
    service.onEvent((event) => {
      if (event.type === 'data') {
        output += event.data;
        if (output.includes('ready')) ready.resolve();
      }
      if (event.type === 'exit') exited.resolve(event);
    });

    const { terminalId } = await service.open({
      sessionId: 'session-pty',
      cols: 80,
      rows: 24,
    });
    await ready.promise;
    service.close(terminalId);

    const exit = await exited.promise;
    expect(exit.terminalId).toBe(terminalId);
    // Neither the hangup nor SIGTERM ended it; the process layer's SIGKILL did.
    expect(exit.signal).toBe('9');
    expect(service.list('session-pty')).toEqual([]);
  });
});
