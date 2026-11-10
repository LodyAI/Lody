import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '@/utils/const';
import type { MachineId, WorkspaceId } from '@lody/shared';
import {
  normalizeMachineUpgradeTargetVersion,
  resolveMachineLifecycleCapability,
  verifyMachineLifecycleRequest,
} from './machine-lifecycle';

describe('machine lifecycle helpers', () => {
  it('defaults upgrade target to latest', () => {
    expect(normalizeMachineUpgradeTargetVersion()).toBe('latest');
    expect(normalizeMachineUpgradeTargetVersion('  latest  ')).toBe('latest');
  });

  it('accepts exact semver-like upgrade targets', () => {
    expect(normalizeMachineUpgradeTargetVersion('1.2.3')).toBe('1.2.3');
    expect(normalizeMachineUpgradeTargetVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
  });

  it('rejects arbitrary npm package specs', () => {
    expect(() => normalizeMachineUpgradeTargetVersion('git+https://example.com/repo.git')).toThrow(
      /exact semver/
    );
    expect(() => normalizeMachineUpgradeTargetVersion('file:/tmp/lody.tgz')).toThrow(
      /exact semver/
    );
    expect(() => normalizeMachineUpgradeTargetVersion('next')).toThrow(/exact semver/);
  });

  it('legacy daemons require explicit migration instead of remote npm installation', () => {
    expect(resolveMachineLifecycleCapability('daemon')).toEqual({
      launchMode: 'daemon',
      canRemoteRestart: true,
      canRemoteUpgrade: false,
      reason: 'unsupported_install',
    });
  });

  it('disables remote lifecycle for Electron managed CLI', () => {
    expect(resolveMachineLifecycleCapability('electron')).toEqual({
      launchMode: 'electron',
      canRemoteRestart: false,
      canRemoteUpgrade: false,
      reason: 'electron',
    });
  });

  it('disables remote lifecycle for foreground lody start', () => {
    expect(resolveMachineLifecycleCapability(undefined)).toEqual({
      launchMode: 'foreground',
      canRemoteRestart: false,
      canRemoteUpgrade: false,
      reason: 'not_daemon',
    });
  });
});

describe('managed lifecycle capability', () => {
  it('requires a managed plaintext daemon with proven process containment', () => {
    expect(
      resolveMachineLifecycleCapability('daemon', { managed: true, platform: 'linux' })
        .canRemoteUpgrade
    ).toBe(true);
    expect(
      resolveMachineLifecycleCapability('daemon', { managed: true, encrypted: true })
        .canRemoteUpgrade
    ).toBe(false);
    expect(
      resolveMachineLifecycleCapability('daemon', { managed: true, platform: 'win32' })
        .canRemoteUpgrade
    ).toBe(false);
  });
});

// Installation safety: a successful shutdown receipt must include retained
// detached groups even when their original root has already exited.
// Exercise persisted daemon recovery with real files: a restarted worker must
// never open a runtime with an unconfirmed or half-published identity.
describe('daemon machine identity restore', () => {
  const intent = {
    workspaceId: 'workspace',
    sourceMachineId: 'new-machine',
    targetMachineId: 'old-machine',
    requesterUserId: 'user',
    requestId: '11111111-1111-4111-8111-111111111111',
  };
  const originalCredentials = {
    version: 3,
    token: 'synthetic-cli-token',
    user: { id: 'user', email: 'synthetic@example.invalid' },
    machine: { machineId: 'new-machine', machineName: 'Windows' },
  };
  async function fixture(run: (root: string) => Promise<void>) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-identity-restore-'));
    try {
      await fs.writeFile(path.join(root, 'credentials.json'), JSON.stringify(originalCredentials));
      await fs.writeFile(path.join(root, 'machine-id'), intent.sourceMachineId);
      await run(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  it('candidate startup refuses pending identity work before remote commits or local writes', async () => {
    const { prepareMachineIdentityRestore, applyPendingMachineIdentityRestore } =
      await import('./machine-identity-restore');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fixture(async (root) => {
      const fetchImpl: typeof fetch = async () => {
        throw new Error('candidate must not contact auth');
      };
      await applyPendingMachineIdentityRestore({ root, readOnly: true, fetchImpl });
      await prepareMachineIdentityRestore(intent, root);
      await expect(
        applyPendingMachineIdentityRestore({ root, readOnly: true, fetchImpl })
      ).rejects.toThrow('pending machine identity restore');
      expect(JSON.parse(await fs.readFile(path.join(root, 'credentials.json'), 'utf8'))).toEqual(
        originalCredentials
      );
      expect(await fs.readFile(path.join(root, 'machine-id'), 'utf8')).toBe(intent.sourceMachineId);
      expect(
        JSON.parse(await fs.readFile(path.join(root, 'machine-identity-restore.json'), 'utf8'))
      ).toEqual(intent);
      await expect(fs.access(path.join(root, 'identity-restore-backups'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });
  it.each([500, 503, 408, 429, 'network', 'timeout'] as const)(
    'retains the pending identity and uses non-crash retry for %s',
    async (failure) => {
      const {
        applyPendingMachineIdentityRestore,
        prepareMachineIdentityRestore,
        machineIdentityRestoreStartupExitCode,
      } = await import('./machine-identity-restore');
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fixture(async (root) => {
        await prepareMachineIdentityRestore(intent, root);
        const error = await applyPendingMachineIdentityRestore({
          root,
          siteUrl: 'https://cloud.example.invalid',
          fetchImpl: async () => {
            if (typeof failure === 'number') return new Response('', { status: failure });
            throw failure === 'timeout'
              ? new DOMException('timed out', 'TimeoutError')
              : new TypeError('network unavailable');
          },
        }).then(
          () => null,
          (error: unknown) => error
        );
        expect(error).toBeInstanceOf(Error);
        expect(machineIdentityRestoreStartupExitCode(error)).toBe(2);
        expect(await fs.readFile(path.join(root, 'machine-id'), 'utf8')).toBe('new-machine');
        expect(JSON.parse(await fs.readFile(path.join(root, 'credentials.json'), 'utf8'))).toEqual(
          originalCredentials
        );
        expect(
          JSON.parse(await fs.readFile(path.join(root, 'machine-identity-restore.json'), 'utf8'))
        ).toEqual(intent);
      });
    }
  );
  it.each([400, 401, 403, 404, 409])(
    'keeps a rejected %s restore intact and exits once without crash retries',
    async (status) => {
      const {
        applyPendingMachineIdentityRestore,
        prepareMachineIdentityRestore,
        machineIdentityRestoreStartupExitCode,
      } = await import('./machine-identity-restore');
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fixture(async (root) => {
        await prepareMachineIdentityRestore(intent, root);
        const error = await applyPendingMachineIdentityRestore({
          root,
          siteUrl: 'https://cloud.example.invalid',
          fetchImpl: async () => new Response('', { status }),
        }).then(
          () => null,
          (error: unknown) => error
        );
        expect(machineIdentityRestoreStartupExitCode(error)).toBe(44);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('retained');
        expect(await fs.readFile(path.join(root, 'machine-id'), 'utf8')).toBe('new-machine');
        expect(JSON.parse(await fs.readFile(path.join(root, 'credentials.json'), 'utf8'))).toEqual(
          originalCredentials
        );
        expect(
          JSON.parse(await fs.readFile(path.join(root, 'machine-identity-restore.json'), 'utf8'))
        ).toEqual(intent);
      });
    }
  );
  it('reconciles an interrupted two-file publication only after the same commit is reconfirmed', async () => {
    const { applyPendingMachineIdentityRestore, prepareMachineIdentityRestore } =
      await import('./machine-identity-restore');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fixture(async (root) => {
      await prepareMachineIdentityRestore(intent, root);
      const backup = path.join(root, 'identity-restore-backups', intent.requestId);
      await fs.mkdir(backup, { recursive: true });
      await fs.writeFile(
        path.join(backup, 'credentials.json'),
        JSON.stringify(originalCredentials)
      );
      await fs.writeFile(
        path.join(root, 'credentials.json'),
        JSON.stringify({
          ...originalCredentials,
          machine: { ...originalCredentials.machine, machineId: intent.targetMachineId },
        })
      );
      await expect(
        applyPendingMachineIdentityRestore({
          root,
          siteUrl: 'https://cloud.example.invalid',
          fetchImpl: async () => new Response('', { status: 503 }),
        })
      ).rejects.toThrow('retained');
      // Failed reconciliation never runs an old- or new-identity runtime.
      expect(await fs.readFile(path.join(root, 'machine-id'), 'utf8')).toBe(intent.sourceMachineId);
      await applyPendingMachineIdentityRestore({
        root,
        siteUrl: 'https://cloud.example.invalid',
        fetchImpl: async (_url, init) => {
          expect(JSON.parse(String(init?.body))).toEqual(intent);
          return Response.json({ requestId: intent.requestId, machineId: intent.targetMachineId });
        },
      });
      expect(await fs.readFile(path.join(root, 'machine-id'), 'utf8')).toBe(intent.targetMachineId);
      expect(
        JSON.parse(await fs.readFile(path.join(root, 'credentials.json'), 'utf8')).machine.machineId
      ).toBe(intent.targetMachineId);
      expect(JSON.parse(await fs.readFile(path.join(backup, 'credentials.json'), 'utf8'))).toEqual(
        originalCredentials
      );
      await expect(
        fs.readFile(path.join(root, 'machine-identity-restore.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
  it('changes both identity files after confirmation and retains the original credentials', async () => {
    const { prepareMachineIdentityRestore, applyPendingMachineIdentityRestore } =
      await import('./machine-identity-restore');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fixture(async (root) => {
      expect(await prepareMachineIdentityRestore(intent, root)).toBe(true);
      expect(await prepareMachineIdentityRestore(intent, root)).toBe(false);
      expect(JSON.parse(await fs.readFile(path.join(root, 'credentials.json'), 'utf8'))).toEqual(
        originalCredentials
      );
      await applyPendingMachineIdentityRestore({
        root,
        siteUrl: 'https://cloud.example.invalid',
        fetchImpl: async () =>
          Response.json({ requestId: intent.requestId, machineId: intent.targetMachineId }),
      });
      expect(
        JSON.parse(await fs.readFile(path.join(root, 'credentials.json'), 'utf8')).machine.machineId
      ).toBe('old-machine');
      expect(await fs.readFile(path.join(root, 'machine-id'), 'utf8')).toBe('old-machine');
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(root, 'identity-restore-backups', intent.requestId, 'credentials.json'),
            'utf8'
          )
        )
      ).toEqual(originalCredentials);
      // A subsequent ordinary boot must perform no restore I/O.
      await applyPendingMachineIdentityRestore({
        root,
        fetchImpl: async () => {
          throw new Error('unexpected request');
        },
      });
    });
  });
  it('retains old identity on an unknown commit, then retries the same operation', async () => {
    const { prepareMachineIdentityRestore, applyPendingMachineIdentityRestore } =
      await import('./machine-identity-restore');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fixture(async (root) => {
      await prepareMachineIdentityRestore(intent, root);
      await expect(
        applyPendingMachineIdentityRestore({
          root,
          siteUrl: 'https://cloud.example.invalid',
          fetchImpl: async () => {
            throw new Error('response lost');
          },
        })
      ).rejects.toThrow('temporarily unavailable');
      expect(await fs.readFile(path.join(root, 'machine-id'), 'utf8')).toBe('new-machine');
      expect(
        JSON.parse(await fs.readFile(path.join(root, 'machine-identity-restore.json'), 'utf8'))
      ).toEqual(intent);
      await applyPendingMachineIdentityRestore({
        root,
        siteUrl: 'https://cloud.example.invalid',
        fetchImpl: async (_url, init) => {
          expect(JSON.parse(String(init?.body))).toEqual(intent);
          return Response.json({ requestId: intent.requestId, machineId: intent.targetMachineId });
        },
      });
      expect(await fs.readFile(path.join(root, 'machine-id'), 'utf8')).toBe('old-machine');
    });
  });
  it('rejects a different account and mismatched confirmation without changing identity', async () => {
    const { prepareMachineIdentityRestore, applyPendingMachineIdentityRestore } =
      await import('./machine-identity-restore');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fixture(async (root) => {
      await expect(
        prepareMachineIdentityRestore({ ...intent, requesterUserId: 'other-user' }, root)
      ).rejects.toThrow('changed');
      await prepareMachineIdentityRestore(intent, root);
      await expect(
        applyPendingMachineIdentityRestore({
          root,
          siteUrl: 'https://cloud.example.invalid',
          fetchImpl: async () =>
            Response.json({ requestId: intent.requestId, machineId: 'different-machine' }),
        })
      ).rejects.toThrow('did not match');
      expect(JSON.parse(await fs.readFile(path.join(root, 'credentials.json'), 'utf8'))).toEqual(
        originalCredentials
      );
      expect(await fs.readFile(path.join(root, 'machine-id'), 'utf8')).toBe('new-machine');
    });
  });
});

it('publishes only one daemon-wide identity intent and cancels only its own unaccepted request', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { prepareMachineIdentityRestore, cancelPreparedMachineIdentityRestore } =
    await import('./machine-identity-restore');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-identity-admission-'));
  const base = {
    workspaceId: 'workspace',
    sourceMachineId: 'new-machine',
    targetMachineId: 'old-machine',
    requesterUserId: 'user',
    requestId: 'request-1',
  };
  try {
    await fs.writeFile(
      path.join(root, 'credentials.json'),
      JSON.stringify({
        version: 3,
        token: 'synthetic-token',
        user: { id: 'user' },
        machine: { machineId: 'new-machine', machineName: 'Windows' },
      })
    );
    const results = await Promise.allSettled([
      prepareMachineIdentityRestore(base, root),
      prepareMachineIdentityRestore(
        { ...base, requestId: 'request-2', targetMachineId: 'other-old-machine' },
        root
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const accepted = JSON.parse(
      await fs.readFile(path.join(root, 'machine-identity-restore.json'), 'utf8')
    );
    await expect(cancelPreparedMachineIdentityRestore('different-request', root)).rejects.toThrow(
      'Another restore'
    );
    expect(
      JSON.parse(await fs.readFile(path.join(root, 'machine-identity-restore.json'), 'utf8'))
    ).toEqual(accepted);
    await cancelPreparedMachineIdentityRestore(accepted.requestId, root);
    await expect(
      fs.readFile(path.join(root, 'machine-identity-restore.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      JSON.parse(await fs.readFile(path.join(root, 'credentials.json'), 'utf8')).machine.machineId
    ).toBe('new-machine');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('identity restore reservation verification', () => {
  const request = {
    token: 'synthetic-token',
    workspaceId: 'workspace' as WorkspaceId,
    machineId: 'new-machine' as MachineId,
    action: 'restart' as const,
    requesterUserId: 'user',
    requestId: 'request-1',
    requestToken: 'signed-proof',
  };
  beforeEach(() => {
    vi.stubEnv('LODY_AUTH_SITE_URL', 'https://cloud.example.invalid');
    loadEnv();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    loadEnv();
  });
  it.each([
    { valid: true, requesterUserId: 'user' },
    { valid: true, requesterUserId: 'user', requestId: 'request-1' },
    { valid: true, requesterUserId: 'user', restoreMachineId: 'old-machine' },
    {
      valid: true,
      requesterUserId: 'user',
      requestId: 'other-request',
      restoreMachineId: 'old-machine',
    },
    {
      valid: true,
      requesterUserId: 'user',
      requestId: 'request-1',
      restoreMachineId: 'other-machine',
    },
  ])('rejects a legacy or non-matching reservation response %j', async (body) => {
    expect(
      await verifyMachineLifecycleRequest({
        ...request,
        restoreMachineId: 'old-machine',
        fetchImpl: async () => Response.json(body),
      })
    ).toMatchObject({ ok: false });
  });
  it('accepts only an exact restored identity and operation echo', async () => {
    expect(
      await verifyMachineLifecycleRequest({
        ...request,
        restoreMachineId: 'old-machine',
        fetchImpl: async () =>
          Response.json({
            valid: true,
            requesterUserId: 'user',
            requestId: 'request-1',
            restoreMachineId: 'old-machine',
          }),
      })
    ).toEqual({ ok: true });
  });
  it.each(['restart', 'upgrade'] as const)(
    'preserves legacy verification for ordinary %s',
    async (action) => {
      expect(
        await verifyMachineLifecycleRequest({
          ...request,
          action,
          fetchImpl: async () => Response.json({ valid: true, requesterUserId: 'user' }),
        })
      ).toEqual({ ok: true });
    }
  );
});
