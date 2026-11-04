import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { acquireSorbetCredentialMutation } from './sorbet-credential-mutation';

describe('Sorbet credential mutation ownership', () => {
  it('keeps a later login out until logout cleanup completes, including across owners', async () => {
    const logout = await acquireSorbetCredentialMutation();
    await expect(acquireSorbetCredentialMutation()).rejects.toThrow('busy');
    let finishCleanup: (() => void) | undefined;
    let cleanupStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    logout.retain(
      {} as ChildProcess,
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
          cleanupStarted?.();
        })
    );
    logout.release();
    const login = acquireSorbetCredentialMutation();
    await started;
    await expect(acquireSorbetCredentialMutation()).rejects.toThrow('busy');
    finishCleanup?.();
    const loginLease = await login;
    await expect(acquireSorbetCredentialMutation()).rejects.toThrow('busy');
    loginLease.release();
    (await acquireSorbetCredentialMutation()).release();
  });

  it('does not start an aborted mutation and lets a later caller retry failed cleanup', async () => {
    const active = await acquireSorbetCredentialMutation();
    let succeeds = false;
    active.retain({} as ChildProcess, async () => {
      if (!succeeds) throw new Error('still alive');
    });
    active.release();
    await expect(acquireSorbetCredentialMutation()).rejects.toThrow('cleanup is unconfirmed');
    const signal = AbortSignal.abort();
    await expect(acquireSorbetCredentialMutation(signal)).rejects.toThrow();
    succeeds = true;
    (await acquireSorbetCredentialMutation()).release();
  });
});
