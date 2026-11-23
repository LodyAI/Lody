import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TerminalExitEvent } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import { scheduleRequesterSessionId } from './schedules/schedule-command-client';
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

  it('keeps human terminal Session context without inheriting Agent restrictions', async () => {
    const shell = path.join(root, 'human-shell');
    await writeFile(
      shell,
      '#!/bin/sh\nprintf \'LODY_ENV={"LODY_SESSION_ID":"%s","LODY_AGENT_SESSION_ID":"%s"}\\n\' "$LODY_SESSION_ID" "$LODY_AGENT_SESSION_ID"\n',
      { mode: 0o700 }
    );
    vi.stubEnv('SHELL', shell);
    vi.stubEnv('LODY_AGENT_SESSION_ID', 'daemon-agent-session');
    const service = makeTerminalPtyService({ logger, resolveSessionWorkdir: async () => root });
    const observed = Promise.withResolvers<NodeJS.ProcessEnv>();
    const exited = Promise.withResolvers<void>();
    let output = '';
    service.onEvent((event) => {
      if (event.type === 'exit') exited.resolve();
      if (event.type !== 'data') return;
      output += event.data;
      const line = output
        .split(/\r?\n/)
        .find((line) => line.startsWith('LODY_ENV=') && line.endsWith('}'));
      if (line) observed.resolve(JSON.parse(line.slice('LODY_ENV='.length)));
    });
    try {
      await service.open({ sessionId: 'human-session', cols: 80, rows: 24 });
      const env = await observed.promise;
      await exited.promise;
      expect(env).toEqual({ LODY_SESSION_ID: 'human-session', LODY_AGENT_SESSION_ID: '' });
      expect(scheduleRequesterSessionId(undefined, env)).toBeUndefined();
    } finally {
      service.closeAll();
    }
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
    // The hangup did not end it; the process layer's SIGKILL did.
    expect(exit.signal).toBe('9');
    expect(service.list('session-pty')).toEqual([]);
  });
});
