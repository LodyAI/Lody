import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MachineAcpAuthenticationForm } from '@lody/shared';
import { describe, expect, it } from 'vitest';

import type { Logger } from '@/utils/logger';
import { AcpAuthenticationManager } from './acp-authentication';

const fixturePath = fileURLToPath(
  new URL('./fixtures/custom-acp-auth-validation.mjs', import.meta.url)
);

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Custom ACP authentication real process', () => {
  it('keeps the machine-wide slot across manager replacement until the child exits', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'lody-acp-auth-fence-'));
    const marker = path.join(scratchDir, 'terminated');
    const first = new AcpAuthenticationManager(createSilentLogger(), {
      resolveLoginShellEnv: async () => ({}),
    });
    const reopened = new AcpAuthenticationManager(createSilentLogger(), {
      resolveLoginShellEnv: async () => ({}),
    });
    const ready = createDeferred<void>();
    const input = {
      cliType: 'custom' as const,
      agentType: 'real-process-reopen-fence',
      customAcp: { command: process.execPath, args: [fixturePath, marker] },
    };
    try {
      const original = first.authenticate({
        ...input,
        requestId: 'original',
        onProgress: (event) => {
          if (event.status === 'auth-methods') ready.resolve();
        },
      });
      await ready.promise;
      expect(first.cancel('original').disposition).toBe('cancelled');
      await expect(
        reopened.authenticate({ ...input, requestId: 'overlap' })
      ).resolves.toMatchObject({
        success: false,
        disposition: 'error',
      });
      await original;
      await expect(readFile(marker, 'utf8')).resolves.toBe('terminated');
      const nextReady = createDeferred<void>();
      const next = reopened.authenticate({
        ...input,
        requestId: 'after-exit',
        onProgress: (event) => {
          if (event.status === 'auth-methods') nextReady.resolve();
        },
      });
      await nextReady.promise;
      expect(reopened.cancel('after-exit').disposition).toBe('cancelled');
      await next;
    } finally {
      first.cancel('original');
      reopened.cancel('after-exit');
      await rm(scratchDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('keeps method selection and a versioned secret form on one process through cleanup', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'lody-acp-auth-'));
    const shutdownMarkerPath = path.join(scratchDir, 'terminated');
    const previousTerm = process.env.TERM;
    process.env.TERM = 'xterm-256color';
    try {
      const methods = createDeferred<string>();
      const authorizationUrls: string[] = [];
      const form = createDeferred<{
        interactionId: string;
        form: MachineAcpAuthenticationForm;
      }>();
      const manager = new AcpAuthenticationManager(createSilentLogger(), {
        resolveLoginShellEnv: async () => ({}),
      });
      const authentication = manager.authenticate({
        requestId: 'real-process-validation',
        cliType: 'custom',
        agentType: 'real-process-validation',
        customAcp: {
          command: process.execPath,
          args: [fixturePath, shutdownMarkerPath],
        },
        onProgress: (event) => {
          if (event.status === 'auth-methods') {
            expect(
              manager.submitAuthenticationInput(
                'real-process-validation',
                event.interactionId,
                JSON.stringify({ action: 'accept', methodId: 'manual' })
              )
            ).toEqual({ success: true, disposition: 'input-accepted' });
            methods.resolve('manual');
          }
          if (event.status === 'input-required') {
            form.resolve({ interactionId: event.interactionId, form: event.form });
          }
          if (event.status === 'authorization') {
            authorizationUrls.push(event.authorizationUrl);
          }
        },
      });

      await expect(methods.promise).resolves.toBe('manual');
      const interaction = await form.promise;
      expect(interaction.form.fields).toEqual([
        {
          id: 'code',
          type: 'secret',
          label: 'Manual code',
          required: true,
        },
        {
          id: 'account',
          type: 'select',
          label: 'Account',
          required: true,
          options: [
            { value: 'personal', label: 'personal' },
            { value: 'work', label: 'work' },
          ],
        },
      ]);
      expect(
        manager.submitAuthenticationInput(
          'real-process-validation',
          interaction.interactionId,
          JSON.stringify({
            action: 'accept',
            content: { code: 'validation-secret', account: 'work' },
          })
        )
      ).toEqual({ success: true, disposition: 'input-accepted' });
      await expect(authentication).resolves.toEqual({
        success: true,
        disposition: 'authenticated',
      });
      expect(authorizationUrls).toContain(
        'https://provider.example.test/oauth/authorize?client_id=validation'
      );
      await expect(readFile(shutdownMarkerPath, 'utf8')).resolves.toBe('terminated');
    } finally {
      if (previousTerm === undefined) delete process.env.TERM;
      else process.env.TERM = previousTerm;
      await rm(scratchDir, { recursive: true, force: true });
    }
  }, 15_000);
});
