import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ACPSessionId, SessionHistoryInput, SessionMeta } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  getSessionAccountBinding,
  setSessionAccountBinding,
  resolveSessionAccountMeta,
  updateSessionAccountNativeId,
  clearSessionAccountBinding,
  beginSessionAccountEdit,
  commitSessionAccountEdit,
  rollbackSessionAccountEdit,
  abandonSessionAccountEdit,
  hashSessionAccountEditHistory,
} from './session-account-binding-store';
const scope = { workspaceId: 'workspace', machineId: 'machine', sessionId: 'session' };
const managed = '00000000-0000-4000-8000-00000000000b';
const meta = (patch: Partial<SessionMeta> = {}) =>
  ({ accountProfileId: 'system-default', acpSessionId: 'legacy-acp', ...patch }) as SessionMeta;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'lody-binding-'));
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  vi.stubEnv('LODY_PLATFORM', undefined);
  vi.stubEnv('LODY_DATA_DIR', undefined);
});

describe('durable account edit journal', () => {
  const sourceHistory = [
    {
      id: 'old-turn',
      role: 'user',
      timestamp: 1,
      items: [{ type: 'text', text: 'old' }],
      fileDiff: [],
    },
  ] as SessionHistoryInput[];
  const targetHistory = [
    {
      id: 'new-turn',
      role: 'user',
      timestamp: 2,
      items: [{ type: 'text', text: 'replacement' }],
      fileDiff: [],
    },
  ] as SessionHistoryInput[];
  const sourceMeta = meta({
    accountProfileId: managed,
    acpSessionId: 'source-native' as ACPSessionId,
    latestUserMsgId: 'old-turn',
    status: { type: 'idle' },
  });
  const targetMeta = {
    acpSessionId: 'target-native' as ACPSessionId,
    latestUserMsgId: 'new-turn',
    status: { type: 'idle' as const },
  };
  async function stage() {
    await setSessionAccountBinding(scope, {
      accountProfileId: managed,
      acpSessionId: sourceMeta.acpSessionId,
    });
    await beginSessionAccountEdit(scope, {
      operationId: 'edit',
      sourceMeta,
      targetMeta,
      sourceHistory,
      targetHistory,
    });
  }
  it('blocks all ordinary consumers and competing writers until the active edit commits', async () => {
    await stage();
    const readHistory = vi.fn(async () => targetHistory);
    await expect(getSessionAccountBinding(scope)).rejects.toThrow('recovery is required');
    await expect(
      setSessionAccountBinding(scope, { accountProfileId: 'system-default' })
    ).rejects.toThrow('recovery is required');
    await expect(updateSessionAccountNativeId(scope, 'injected' as ACPSessionId)).rejects.toThrow(
      'recovery is required'
    );
    await expect(clearSessionAccountBinding(scope)).rejects.toThrow('recovery is required');
    await expect(
      resolveSessionAccountMeta(scope, sourceMeta, {
        readHistory,
        writeMeta: async () => {},
        persist: async () => {},
      })
    ).rejects.toThrow('recovery is required');
    expect(readHistory).not.toHaveBeenCalled();
    await expect(commitSessionAccountEdit(scope, 'wrong')).rejects.toThrow('no longer active');
    await commitSessionAccountEdit(scope, 'edit');
    expect(await getSessionAccountBinding(scope)).toMatchObject({
      accountProfileId: managed,
      acpSessionId: 'target-native',
    });
  });
  it.each(['source', 'target'] as const)(
    'recovers the %s checkpoint and repairs inconsistent metadata before exposing its binding',
    async (checkpoint) => {
      await stage();
      abandonSessionAccountEdit(scope, 'edit');
      const history = checkpoint === 'source' ? sourceHistory : targetHistory;
      const expectedMeta = checkpoint === 'source' ? sourceMeta : targetMeta;
      const order: string[] = [];
      const writeMeta = vi.fn(async () => {
        order.push('meta');
      });
      const recovered = await resolveSessionAccountMeta(
        scope,
        meta({ acpSessionId: 'forged' as ACPSessionId, accountProfileId: 'system-default' }),
        {
          readHistory: async () => history,
          writeMeta,
          persist: async () => {
            order.push('persist');
          },
        }
      );
      expect(recovered).toMatchObject({
        accountProfileId: managed,
        acpSessionId: expectedMeta.acpSessionId,
        latestUserMsgId: expectedMeta.latestUserMsgId,
      });
      expect(writeMeta).toHaveBeenCalledWith(
        expect.objectContaining({
          acpSessionId: expectedMeta.acpSessionId,
          processingUserMsgId: undefined,
        })
      );
      expect(order).toEqual(['meta', 'persist']);
      expect(await getSessionAccountBinding(scope)).toMatchObject({
        accountProfileId: managed,
        acpSessionId: expectedMeta.acpSessionId,
      });
    }
  );
  it('retains the journal when repair persistence fails and safely retries', async () => {
    await stage();
    abandonSessionAccountEdit(scope, 'edit');
    const recovery = {
      readHistory: async () => targetHistory,
      writeMeta: vi.fn(async () => {}),
      persist: vi.fn(async () => {}),
    };
    recovery.persist.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(resolveSessionAccountMeta(scope, sourceMeta, recovery)).rejects.toThrow(
      'disk unavailable'
    );
    await expect(getSessionAccountBinding(scope)).rejects.toThrow('recovery is required');
    expect(await resolveSessionAccountMeta(scope, sourceMeta, recovery)).toMatchObject({
      acpSessionId: 'target-native',
    });
  });
  it('rejects divergent history without trusting the synced native id or overwriting history', async () => {
    await stage();
    abandonSessionAccountEdit(scope, 'edit');
    const writeMeta = vi.fn(async () => {});
    await expect(
      resolveSessionAccountMeta(scope, meta({ acpSessionId: 'target-native' as ACPSessionId }), {
        readHistory: async () => [],
        writeMeta,
        persist: async () => {},
      })
    ).rejects.toThrow('cannot match');
    expect(writeMeta).not.toHaveBeenCalled();
    await expect(getSessionAccountBinding(scope)).rejects.toThrow('recovery is required');
  });
  it('detects a history change during metadata repair and retains the journal', async () => {
    await stage();
    abandonSessionAccountEdit(scope, 'edit');
    const readHistory = vi
      .fn()
      .mockResolvedValueOnce(sourceHistory)
      .mockResolvedValueOnce(targetHistory);
    await expect(
      resolveSessionAccountMeta(scope, sourceMeta, {
        readHistory,
        writeMeta: async () => {},
        persist: async () => {},
      })
    ).rejects.toThrow('changed during');
    await expect(getSessionAccountBinding(scope)).rejects.toThrow('recovery is required');
  });
  it('keeps the journal authoritative when atomic promotion fails', async () => {
    await stage();
    vi.mocked(rename).mockRejectedValueOnce(new Error('promotion failed'));
    await expect(commitSessionAccountEdit(scope, 'edit')).rejects.toThrow('promotion failed');
    await expect(getSessionAccountBinding(scope)).rejects.toThrow('recovery is required');
    await rollbackSessionAccountEdit(scope, 'edit');
    expect(await getSessionAccountBinding(scope)).toMatchObject({ acpSessionId: 'source-native' });
    expect(await readdir(path.join(getLodyDataDir(), 'session-account-bindings'))).toHaveLength(1);
  });
  it('does not stage against a changed local native identity', async () => {
    await setSessionAccountBinding(scope, {
      accountProfileId: managed,
      acpSessionId: 'different' as ACPSessionId,
    });
    await expect(
      beginSessionAccountEdit(scope, {
        operationId: 'edit',
        sourceMeta,
        targetMeta,
        sourceHistory,
        targetHistory,
      })
    ).rejects.toThrow('binding changed');
    expect(await getSessionAccountBinding(scope)).toMatchObject({ acpSessionId: 'different' });
  });
  it('does not roll history back when final rename succeeds but directory sync fails', async () => {
    await stage();
    const { open: actualOpen } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.stubGlobal(
      'process',
      new Proxy(process, {
        get: (target, key) => (key === 'platform' ? 'linux' : Reflect.get(target, key)),
      })
    );
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[0] === path.join(getLodyDataDir(), 'session-account-bindings'))
        throw new Error('directory sync unavailable');
      return await actualOpen(...args);
    });
    await commitSessionAccountEdit(scope, 'edit');
    expect(await getSessionAccountBinding(scope)).toMatchObject({ acpSessionId: 'target-native' });
  });
  it('hashes content stably across read markers, container ids and object key ordering', () => {
    const entry = sourceHistory[0];
    if (!entry) throw new Error('Expected a source history entry');
    const original = [{ ...entry, read: false, $cid: 'old-container' }];
    const reopened = [
      {
        ...entry,
        items: [{ text: 'old', type: 'text' }],
        read: true,
        $cid: 'new-container',
      },
    ] as SessionHistoryInput[];
    expect(hashSessionAccountEditHistory(original)).toBe(hashSessionAccountEditHistory(reopened));
    expect(hashSessionAccountEditHistory(original)).not.toBe(
      hashSessionAccountEditHistory(targetHistory)
    );
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
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
    const root = path.join(getLodyDataDir(), 'session-account-bindings');
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
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
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
  expect(await readdir(path.join(getLodyDataDir(), 'session-account-bindings'))).toHaveLength(1);
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

describe('installation data-root isolation', () => {
  it('keeps default OSS and cloud bindings separate for the same identity scope', async () => {
    const localRoot = getLodyDataDir('local', directory);
    const cloudRoot = getLodyDataDir('cloud', directory);
    expect(localRoot).not.toBe(cloudRoot);
    expect(getLodyDataDir()).toBe(localRoot);
    await setSessionAccountBinding(scope, {
      accountProfileId: managed,
      acpSessionId: 'oss-native' as ACPSessionId,
    });
    expect(await readdir(path.join(localRoot, 'session-account-bindings'))).toHaveLength(1);

    vi.stubEnv('LODY_PLATFORM', 'cloud');
    expect(getLodyDataDir()).toBe(cloudRoot);
    expect(await getSessionAccountBinding(scope)).toBeNull();
    await expect(
      resolveSessionAccountMeta(scope, meta({ accountProfileId: managed }))
    ).rejects.toThrow('local account binding is unavailable');
    await setSessionAccountBinding(scope, {
      accountProfileId: 'system-default',
      acpSessionId: 'cloud-native' as ACPSessionId,
    });
    expect(await readdir(path.join(cloudRoot, 'session-account-bindings'))).toHaveLength(1);

    vi.stubEnv('LODY_PLATFORM', 'local');
    expect(await getSessionAccountBinding(scope)).toMatchObject({
      accountProfileId: managed,
      acpSessionId: 'oss-native',
    });
    await clearSessionAccountBinding(scope);
    expect(await getSessionAccountBinding(scope)).toBeNull();
    vi.stubEnv('LODY_PLATFORM', 'cloud');
    expect(await getSessionAccountBinding(scope)).toMatchObject({
      accountProfileId: 'system-default',
      acpSessionId: 'cloud-native',
    });
  });

  it('uses only the explicit data root for reads, native-id updates and deletion', async () => {
    const defaultRoot = getLodyDataDir();
    const firstRoot = path.join(directory, 'installation-a');
    const secondRoot = path.join(directory, 'installation-b');
    vi.stubEnv('LODY_DATA_DIR', firstRoot);
    expect(getLodyDataDir()).toBe(firstRoot);
    await setSessionAccountBinding(scope, {
      accountProfileId: managed,
      acpSessionId: 'first-native' as ACPSessionId,
    });
    expect(await readdir(path.join(getLodyDataDir(), 'session-account-bindings'))).toHaveLength(1);

    vi.stubEnv('LODY_DATA_DIR', secondRoot);
    expect(await getSessionAccountBinding(scope)).toBeNull();
    await setSessionAccountBinding(scope, {
      accountProfileId: 'system-default',
      acpSessionId: 'second-native' as ACPSessionId,
    });
    await updateSessionAccountNativeId(scope, 'second-replacement' as ACPSessionId);
    expect(await getSessionAccountBinding(scope)).toMatchObject({
      accountProfileId: 'system-default',
      acpSessionId: 'second-replacement',
    });
    await clearSessionAccountBinding(scope);
    expect(await getSessionAccountBinding(scope)).toBeNull();

    vi.stubEnv('LODY_DATA_DIR', firstRoot);
    expect(await getSessionAccountBinding(scope)).toMatchObject({
      accountProfileId: managed,
      acpSessionId: 'first-native',
    });
    vi.stubEnv('LODY_DATA_DIR', undefined);
    expect(getLodyDataDir()).toBe(defaultRoot);
    expect(await getSessionAccountBinding(scope)).toBeNull();
    await expect(readdir(defaultRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not import a cloud binding into an explicit local installation', async () => {
    vi.stubEnv('LODY_PLATFORM', 'cloud');
    await setSessionAccountBinding(scope, { accountProfileId: managed });
    vi.stubEnv('LODY_PLATFORM', 'local');
    vi.stubEnv('LODY_DATA_DIR', path.join(directory, 'isolated-oss'));
    await expect(
      resolveSessionAccountMeta(scope, meta({ accountProfileId: managed }))
    ).rejects.toThrow('local account binding is unavailable');
    expect(await resolveSessionAccountMeta(scope, meta())).toMatchObject({
      accountProfileId: 'system-default',
      acpSessionId: 'legacy-acp',
    });
    await expect(readdir(getLodyDataDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
