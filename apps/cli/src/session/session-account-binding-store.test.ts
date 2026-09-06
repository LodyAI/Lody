import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ACPSessionId, SessionMeta } from '@lody/shared';
import {
  getSessionAccountBinding,
  setSessionAccountBinding,
  resolveSessionAccountMeta,
  updateSessionAccountNativeId,
} from './session-account-binding-store';
const scope = { workspaceId: 'workspace', machineId: 'machine', sessionId: 'session' };
const managed = '00000000-0000-4000-8000-00000000000b';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'lody-binding-'));
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const meta = (patch: Partial<SessionMeta> = {}) =>
  ({ accountProfileId: 'system-default', acpSessionId: 'legacy-acp', ...patch }) as SessionMeta;
describe('machine-local session account authority', () => {
  it('preserves legacy default resume and rejects injected managed profiles', async () => {
    expect(await resolveSessionAccountMeta(scope, meta())).toMatchObject({
      accountProfileId: 'system-default',
      acpSessionId: 'legacy-acp',
    });
    await expect(
      resolveSessionAccountMeta(scope, meta({ accountProfileId: managed }))
    ).rejects.toThrow('local account binding is unavailable');
  });
  it('uses the local account and native session despite forged synced fields, isolated per scope', async () => {
    await setSessionAccountBinding(scope, {
      accountProfileId: managed,
      acpSessionId: 'local-acp' as ACPSessionId,
    });
    expect(
      await resolveSessionAccountMeta(
        scope,
        meta({
          acpSessionId: 'forged' as ACPSessionId,
          accountHandoff: {
            requestId: 'forged',
            sourceAccountProfileId: 'system-default',
            targetAccountProfileId: 'system-default',
          },
          accountTransitions: [
            {
              requestId: 'forged',
              fromAccountProfileId: 'system-default',
              toAccountProfileId: 'system-default',
              toAcpSessionId: 'forged' as ACPSessionId,
              continuation: false,
              committedAt: 1,
            },
          ],
        })
      )
    ).toMatchObject({
      accountProfileId: managed,
      acpSessionId: 'local-acp',
      accountTransitions: undefined,
      accountHandoff: undefined,
    });
    for (const key of ['workspaceId', 'machineId', 'sessionId'])
      expect(await getSessionAccountBinding({ ...scope, [key]: 'other' })).toBeNull();
  });
  it('fails closed on corruption and deletion and leaves no temporary files', async () => {
    await setSessionAccountBinding(scope, { accountProfileId: managed });
    const root = path.join(directory, '.lody', 'session-account-bindings');
    const files = await readdir(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
    const file = path.join(root, files[0]!);
    await writeFile(file, '{bad');
    await expect(resolveSessionAccountMeta(scope, meta())).rejects.toThrow();
    await rm(file);
    await expect(
      resolveSessionAccountMeta(scope, meta({ accountProfileId: managed }))
    ).rejects.toThrow('local account binding is unavailable');
  });
  it('retains the source pair through interrupted handoff and commits the next pair', async () => {
    await setSessionAccountBinding(scope, {
      accountProfileId: managed,
      acpSessionId: 'source' as ACPSessionId,
      accountHandoff: {
        requestId: 'op',
        sourceAccountProfileId: managed,
        sourceAcpSessionId: 'source' as ACPSessionId,
        targetAccountProfileId: 'system-default',
      },
    });
    expect(await resolveSessionAccountMeta(scope, meta())).toMatchObject({
      accountProfileId: managed,
      acpSessionId: 'source',
    });
    await setSessionAccountBinding(scope, {
      accountProfileId: 'system-default',
      acpSessionId: 'next' as ACPSessionId,
      accountHandoff: null,
    });
    expect(await getSessionAccountBinding(scope)).toMatchObject({
      accountProfileId: 'system-default',
      acpSessionId: 'next',
      accountHandoff: null,
    });
  });
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
it('preserves the prior binding when replacement fails and removes its temporary file', async () => {
  await setSessionAccountBinding(scope, {
    accountProfileId: managed,
    acpSessionId: 'source' as ACPSessionId,
  });
  vi.mocked(rename).mockRejectedValueOnce(new Error('rename failed'));
  await expect(
    setSessionAccountBinding(scope, {
      accountProfileId: 'system-default',
      acpSessionId: 'next' as ACPSessionId,
    })
  ).rejects.toThrow('rename failed');
  expect(await getSessionAccountBinding(scope)).toMatchObject({
    accountProfileId: managed,
    acpSessionId: 'source',
  });
  await expect(setSessionAccountBinding(scope, { accountProfileId: 'invalid' })).rejects.toThrow();
  expect(await getSessionAccountBinding(scope)).toMatchObject({
    accountProfileId: managed,
    acpSessionId: 'source',
  });
  expect(await readdir(path.join(directory, '.lody', 'session-account-bindings'))).toHaveLength(1);
});
it('updates the native session and pending continuation together without selecting a different account', async () => {
  await setSessionAccountBinding(scope, {
    accountProfileId: managed,
    acpSessionId: 'source' as ACPSessionId,
    accountContinuation: { acpSessionId: 'source' as ACPSessionId },
  });
  await updateSessionAccountNativeId(scope, 'replacement' as ACPSessionId);
  expect(await getSessionAccountBinding(scope)).toMatchObject({
    accountProfileId: managed,
    acpSessionId: 'replacement',
    accountContinuation: { acpSessionId: 'replacement' },
  });
});
