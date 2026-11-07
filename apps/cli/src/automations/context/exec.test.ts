import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { processLayer } from '@lody/shared/node/process';
import { execAutomationCommand } from './exec';
import { evaluateAutomationProgram } from '../programs/codemode';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const setup = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lody-exec-'));
  roots.push(root);
  return root;
};
const run = (input: Parameters<typeof execAutomationCommand>[0], root: string) =>
  Effect.runPromise(
    Effect.provide(execAutomationCommand(input, root, { PATH: process.env.PATH }), processLayer({}))
  );

describe('automation command execution', () => {
  it('runs a real command through the CodeMode ctx.exec bridge', async () => {
    const root = setup();
    const program = `async ({ctx}) => { const result = await ctx.exec({command: ${JSON.stringify(process.execPath)}, args: ['-e', 'process.stdout.write(process.cwd()); process.exitCode = 7']}); return {resumeText: 'completed', payload: result}; }`;
    const result = await Effect.runPromise(
      evaluateAutomationProgram(
        program,
        { sessionId: 'session', workspaceId: 'workspace', now: 1 },
        () => Effect.fail(new Error('unexpected read')),
        false,
        (input) =>
          Effect.provide(
            execAutomationCommand(input, root, { PATH: process.env.PATH }),
            processLayer({})
          )
      )
    );
    expect(result).toMatchObject({
      resumeText: 'completed',
      payload: {
        exitCode: 7,
        stdout: await import('node:fs/promises').then((fs) => fs.realpath(root)),
      },
    });
  });
  it('passes arguments literally and returns nonzero exit and both streams', async () => {
    const root = setup();
    const result = await run(
      {
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(process.argv[1]); process.stderr.write("bad"); process.exitCode=7',
          '$(not-a-shell)',
        ],
      },
      root
    );
    expect(result).toEqual({ exitCode: 7, signal: null, stdout: '$(not-a-shell)', stderr: 'bad' });
  });
  it('rejects a cwd that escapes through a symlink', async () => {
    const root = setup();
    const outside = setup();
    mkdirSync(path.join(root, 'inside'));
    symlinkSync(outside, path.join(root, 'inside', 'link'), 'dir');
    await expect(run({ command: process.execPath, cwd: 'inside/link' }, root)).rejects.toThrow(
      'AUTOMATION_EXEC_INVALID_CWD'
    );
  });
  it.skipIf(process.platform === 'win32')(
    'releases descendants that outlive the command',
    async () => {
      const root = setup();
      const marker = path.join(root, 'released');
      const descendant = `process.on('SIGTERM', () => { require('node:fs').writeFileSync(process.argv[1], 'released'); process.exit(0); }); process.stdout.write('ready'); setInterval(() => {}, 1000)`;
      const parent = `const child = require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], { stdio: ['ignore', 'pipe', 'inherit'] }); child.stdout.once('data', () => process.exit(0));`;
      await run({ command: process.execPath, args: ['-e', parent, descendant, marker] }, root);
      expect(existsSync(marker)).toBe(true);
    }
  );
  it.skipIf(process.platform === 'win32')('joins process cleanup on cancellation', async () => {
    const root = setup();
    const readyPath = path.join(root, 'ready');
    const releasedPath = path.join(root, 'released');
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const watcher = watch(root, () => {
      if (existsSync(readyPath)) ready.resolve();
    });
    const script = `const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(process.argv[2], 'released'); process.exit(0); }); fs.writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)`;
    const operation = Effect.runPromise(
      Effect.provide(
        execAutomationCommand(
          { command: process.execPath, args: ['-e', script, readyPath, releasedPath] },
          root,
          { PATH: process.env.PATH }
        ),
        processLayer({})
      ),
      { signal: controller.signal }
    );
    try {
      await ready.promise;
      controller.abort();
      await expect(operation).rejects.toThrow();
      expect(existsSync(releasedPath)).toBe(true);
    } finally {
      watcher.close();
    }
  });
  it('fails instead of truncating excessive output', async () => {
    const root = setup();
    await expect(
      run(
        { command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(140000))'] },
        root
      )
    ).rejects.toThrow('AUTOMATION_EXEC_OUTPUT_TOO_LARGE');
  });
});
