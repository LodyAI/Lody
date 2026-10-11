import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentConfigMeta } from '@lody/shared';
import { CodexProfileStore } from './codex-profile-store';
import { codexProfileConfig } from './codex-profile-runtime';
import type { CodexCredentialVault } from './codex-credential-vault';
import {
  registerCodexProfileProcess,
  reconcileCodexProfileProcesses,
} from './codex-profile-process-usage';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'lody-codex-profile-test-'));
  directories.push(root);
  const secrets = new Map<string, string>();
  const vault: CodexCredentialVault = {
    get: async (id) => secrets.get(id),
    set: async (id, value) => {
      secrets.set(id, value);
    },
    delete: async (id) => {
      secrets.delete(id);
    },
  };
  const store = new CodexProfileStore(root, vault);
  const config = {
    id: randomUUID(),
    machineId: 'machine-fixture',
    name: 'Work',
    description: undefined,
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
    codexAuth: {
      mode: 'api-key',
      profileId: randomUUID(),
      baseUrl: 'https://relay.example.invalid/v1',
    },
  } as AgentConfigMeta;
  const resolved = await store.resolve('workspace-fixture', config, true);
  if (!resolved) throw new Error('Fixture profile missing');
  return { root, store, config, resolved, secrets, vault };
}

describe('Codex profile ownership and generation publication', () => {
  it('uses isolated Codex default storage for new and unfinished ChatGPT profiles', async () => {
    const { root, store, config } = await fixture();
    const chatgpt = {
      ...config,
      id: randomUUID() as AgentConfigMeta['id'],
      codexAuth: { mode: 'chatgpt' as const, profileId: randomUUID() },
    };
    const pending = await store.resolve('workspace-fixture', chatgpt, true);
    if (!pending) throw new Error('Missing ChatGPT profile');
    expect(pending.authStore).toBe('codex-default');
    expect(codexProfileConfig(pending)).not.toHaveProperty('cli_auth_credentials_store');

    const recordPath = path.join(root, pending.profile.profileId, 'profile.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    delete record.authStore;
    await writeFile(recordPath, JSON.stringify(record));
    const upgradedPending = await store.resolve('workspace-fixture', chatgpt, true);
    expect(upgradedPending?.authStore).toBe('codex-default');
    if (!upgradedPending) throw new Error('Missing upgraded ChatGPT profile');
    await store.markChatgptReady(upgradedPending);
    expect((await store.resolve('workspace-fixture', chatgpt))?.authStore).toBe('codex-default');
  });

  it('keeps old ready ChatGPT profiles on their existing keyring through removal', async () => {
    const { root, vault, config } = await fixture();
    const chatgpt = {
      ...config,
      id: randomUUID() as AgentConfigMeta['id'],
      codexAuth: { mode: 'chatgpt' as const, profileId: randomUUID() },
    };
    let cleanupAttempts = 0;
    const store = new CodexProfileStore(root, vault, async (profile) => {
      expect(profile.authStore).toBe('keyring');
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw new Error('Credential store temporarily unavailable');
    });
    const pending = await store.resolve('workspace-fixture', chatgpt, true);
    if (!pending) throw new Error('Missing ChatGPT profile');
    const recordPath = path.join(root, pending.profile.profileId, 'profile.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    delete record.authStore;
    await writeFile(recordPath, JSON.stringify({ ...record, state: 'ready' }));

    const legacy = await store.resolve('workspace-fixture', chatgpt);
    if (!legacy) throw new Error('Missing legacy ChatGPT profile');
    expect(legacy.authStore).toBe('keyring');
    expect(codexProfileConfig(legacy)).toHaveProperty('cli_auth_credentials_store', 'keyring');
    expect(
      (await store.list('workspace-fixture')).find(
        (profile) => profile.profile.profileId === legacy.profile.profileId
      )?.authStore
    ).toBe('keyring');
    await expect(store.remove(legacy)).rejects.toThrow('temporarily unavailable');
    const removed = (await store.list('workspace-fixture')).find(
      (profile) => profile.profile.profileId === legacy.profile.profileId
    );
    expect(removed?.authStore).toBe('keyring');
    if (!removed) throw new Error('Missing removed ChatGPT profile');
    await store.remove(removed);
    expect(cleanupAttempts).toBe(2);
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({
      state: 'removed',
      authStore: 'keyring',
      credentialsRemoved: true,
    });
  });

  it('rejects a new profile identity for an already bound provider, including concurrent binds', async () => {
    const { store, config } = await fixture();
    await expect(
      store.resolve(
        'workspace-fixture',
        { ...config, codexAuth: { mode: 'chatgpt', profileId: randomUUID() } },
        true
      )
    ).rejects.toThrow();
    const newId = randomUUID() as AgentConfigMeta['id'];
    const attempts = await Promise.allSettled(
      [0, 1].map(() =>
        store.resolve(
          'workspace-fixture',
          { ...config, id: newId, codexAuth: { mode: 'chatgpt', profileId: randomUUID() } },
          true
        )
      )
    );
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('never marks an unavailable vault ready or leaves a candidate active', async () => {
    const { root, vault, config, resolved } = await fixture();
    const locked = new CodexProfileStore(root, {
      ...vault,
      set: async () => {
        throw new Error('Vault locked');
      },
    });
    await expect(
      locked.withApiKeyCandidate(resolved, 'synthetic-key', async () => {})
    ).rejects.toThrow('Vault locked');
    expect(await locked.isReady(resolved)).toBe(false);
    await expect(locked.resolve('workspace-fixture', config)).rejects.toThrow('Authenticate');
  });

  it('permits simultaneous uses and isolates each native exit proof', async () => {
    const { resolved, store } = await fixture();
    await store.withApiKeyCandidate(resolved, 'synthetic-key', async () => {});
    const [first, second] = await Promise.all([
      registerCodexProfileProcess(resolved),
      registerCodexProfileProcess(resolved),
    ]);
    first.recordNativePid(process.pid);
    second.recordNativePid(process.pid);
    expect(first.token).not.toBe(second.token);
    await first();
    const proof = (token: string) =>
      path.join(resolved.home, '..', 'processes', `${token}.native.json`);
    await writeFile(proof(first.token), JSON.stringify({ nativeExited: true }));
    await first();
    await writeFile(proof(first.token), JSON.stringify({ nativeExited: true }));
    expect(await reconcileCodexProfileProcesses(resolved)).toBe(false);
    expect(JSON.parse(await readFile(proof(second.token), 'utf8'))).toEqual({
      nativePid: process.pid,
      nativeExited: false,
    });
    await writeFile(proof(second.token), JSON.stringify({ nativeExited: true }));
    await second();
    expect(await reconcileCodexProfileProcesses(resolved)).toBe(true);
  });

  it('reclaims exited children and pre-spawn failures; unknown uses do not block another start', async () => {
    const { resolved } = await fixture();
    const first = await registerCodexProfileProcess(resolved, { directNative: true });
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    first.recordNativePid(child.pid);
    await once(child, 'exit');
    expect(await reconcileCodexProfileProcesses(resolved)).toBe(true);
    const next = await registerCodexProfileProcess(resolved, { directNative: true });
    expect(await reconcileCodexProfileProcesses(resolved)).toBe(false);
    const parallel = await registerCodexProfileProcess(resolved, { directNative: true });
    await parallel.abandonBeforeSpawn();
    expect(await reconcileCodexProfileProcesses(resolved)).toBe(false);
    await next.abandonBeforeSpawn();
    const retry = await registerCodexProfileProcess(resolved, { directNative: true });
    await retry();
    expect(await reconcileCodexProfileProcesses(resolved)).toBe(true);
  });

  it('defers deletion while a native writer lives, then reconciles its exit and cleans credentials once', async () => {
    const { root, vault, config } = await fixture();
    let cleanups = 0;
    const store = new CodexProfileStore(root, vault, async () => {
      cleanups++;
    });
    const profile = await store.resolve(
      'workspace-fixture',
      {
        ...config,
        id: randomUUID() as AgentConfigMeta['id'],
        codexAuth: { mode: 'chatgpt', profileId: randomUUID() },
      },
      true
    );
    if (!profile) throw new Error('Missing test profile');
    await store.markChatgptReady(profile);
    const first = await registerCodexProfileProcess(profile);
    const second = await registerCodexProfileProcess(profile);
    first.recordNativePid(process.pid);
    second.recordNativePid(process.pid);
    expect(await store.remove(profile)).toBe(false);
    expect(cleanups).toBe(0);
    await expect(store.markChatgptReady(profile)).rejects.toThrow('was removed');
    await expect(registerCodexProfileProcess(profile)).rejects.toThrow('was removed');
    const proof = (token: string) =>
      path.join(profile.home, '..', 'processes', `${token}.native.json`);
    await writeFile(proof(first.token), JSON.stringify({ nativeExited: true }));
    expect(await store.remove(profile)).toBe(false);
    expect(cleanups).toBe(0);
    await writeFile(proof(second.token), JSON.stringify({ nativeExited: true }));
    expect(await store.remove(profile)).toBe(true);
    expect(cleanups).toBe(1);
    await store.remove(profile);
    expect(cleanups).toBe(1);
    const metadata = JSON.parse(
      await readFile(path.join(profile.home, '..', 'profile.json'), 'utf8')
    );
    expect(metadata).toMatchObject({ state: 'removed', credentialsRemoved: true });
  });
  it('publishes a verified generation without persisting its secret, and reloads it after restart', async () => {
    const { root, store, config, resolved, vault } = await fixture();
    await expect(store.resolve('workspace-fixture', config)).rejects.toThrow('Authenticate');
    await store.withApiKeyCandidate(resolved, 'synthetic-first', async (key) =>
      expect(key).toBe('synthetic-first')
    );
    const restarted = new CodexProfileStore(root, vault);
    const ready = await restarted.resolve('workspace-fixture', config);
    expect(ready).toEqual(resolved);
    expect(await restarted.apiKey(resolved)).toBe('synthetic-first');
    const metadata = await readFile(
      path.join(root, resolved.profile.profileId, 'profile.json'),
      'utf8'
    );
    expect(metadata).not.toContain('synthetic-first');
    expect(JSON.stringify(config)).not.toContain('synthetic-first');
  });

  it('keeps the committed key when a replacement fails or is cancelled before commit', async () => {
    const { store, resolved, secrets } = await fixture();
    await store.withApiKeyCandidate(resolved, 'synthetic-first', async () => {});
    await expect(
      store.withApiKeyCandidate(resolved, 'synthetic-bad', async () => {
        throw new Error('Rejected');
      })
    ).rejects.toThrow('Rejected');
    const controller = new AbortController();
    await expect(
      store.withApiKeyCandidate(
        resolved,
        'synthetic-cancelled',
        async () => controller.abort(),
        controller.signal
      )
    ).rejects.toThrow();
    expect(await store.apiKey(resolved)).toBe('synthetic-first');
    expect([...secrets.values()]).toEqual(['synthetic-first']);
  });

  it.each([
    { stage: 'save', ready: false },
    { stage: 'save', ready: true },
    { stage: 'verification', ready: false },
    { stage: 'verification', ready: true },
    { stage: 'cancellation', ready: false },
    { stage: 'cancellation', ready: true },
  ])(
    'preserves $stage failure and retries cleanup after restart (ready=$ready)',
    async ({ stage, ready }) => {
      const { root, vault, resolved, config, secrets } = await fixture();
      const originalError = new Error(`Synthetic ${stage} failure`);
      const cleanupError = new Error('Synthetic credential deletion failure');
      let failSave = false;
      let failCleanup = false;
      const failingVault: CodexCredentialVault = {
        ...vault,
        set: async (id, value) => {
          await vault.set(id, value);
          // A failed write may have stored the credential before returning an error.
          if (failSave) throw originalError;
        },
        delete: async (id) => {
          if (failCleanup) throw cleanupError;
          await vault.delete(id);
        },
      };
      const store = new CodexProfileStore(root, failingVault);
      if (ready) await store.withApiKeyCandidate(resolved, 'synthetic-old', async () => {});
      const recordPath = path.join(root, resolved.profile.profileId, 'profile.json');
      const before = JSON.parse(await readFile(recordPath, 'utf8'));
      const controller = new AbortController();
      failSave = stage === 'save';
      failCleanup = true;

      await expect(
        store.withApiKeyCandidate(
          resolved,
          'synthetic-candidate',
          async () => {
            if (stage === 'cancellation') controller.abort(originalError);
            else throw originalError;
          },
          controller.signal
        )
      ).rejects.toBe(originalError);

      const retained = JSON.parse(await readFile(recordPath, 'utf8'));
      expect(retained.state).toBe(before.state);
      expect(retained.activeGeneration).toBe(before.activeGeneration);
      expect(retained.generations).toHaveLength(before.generations.length + 1);
      expect([...secrets.values()]).toEqual(
        ready ? ['synthetic-old', 'synthetic-candidate'] : ['synthetic-candidate']
      );

      const restarted = new CodexProfileStore(root, failingVault);
      expect(await restarted.resolve('workspace-fixture', config, true)).toEqual(resolved);
      expect(await restarted.isReady(resolved)).toBe(ready);
      if (ready) expect(await restarted.apiKey(resolved)).toBe('synthetic-old');
      else await expect(restarted.apiKey(resolved)).rejects.toThrow('Authenticate');
      await expect(restarted.reconcileGenerations(resolved)).rejects.toBe(cleanupError);
      expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual(retained);

      failCleanup = false;
      failSave = false;
      await restarted.reconcileGenerations(resolved);
      expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual(before);
      expect([...secrets.values()]).toEqual(ready ? ['synthetic-old'] : []);
      await restarted.withApiKeyCandidate(resolved, 'synthetic-retry', async () => {});
      expect(await restarted.apiKey(resolved)).toBe('synthetic-retry');
    }
  );

  it('reconciles an already deleted candidate after restart without changing the active key', async () => {
    const { root, store, resolved, vault, secrets } = await fixture();
    await store.withApiKeyCandidate(resolved, 'synthetic-old', async () => {});
    const recordPath = path.join(root, resolved.profile.profileId, 'profile.json');
    const before = JSON.parse(await readFile(recordPath, 'utf8'));
    const originalError = new Error('Synthetic verification failure');
    await expect(
      store.withApiKeyCandidate(resolved, 'synthetic-candidate', async () => {
        throw originalError;
      })
    ).rejects.toBe(originalError);
    expect([...secrets.values()]).toEqual(['synthetic-old']);
    const retained = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(retained.activeGeneration).toBe(before.activeGeneration);
    expect(retained.generations).toHaveLength(before.generations.length + 1);
    const restarted = new CodexProfileStore(root, vault);
    await restarted.reconcileGenerations(resolved);
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual(before);
    expect(await restarted.apiKey(resolved)).toBe('synthetic-old');
  });

  it('rejects endpoint, owner, and runtime rewrites without retrieving the saved key', async () => {
    const { store, config, resolved } = await fixture();
    await store.withApiKeyCandidate(resolved, 'synthetic-first', async () => {});
    await expect(store.resolve('another-workspace', config, true)).rejects.toThrow(
      'different provider'
    );
    await expect(
      store.resolve('workspace-fixture', {
        ...config,
        codexAuth: {
          mode: 'api-key',
          profileId: resolved.profile.profileId,
          baseUrl: 'https://other.example.invalid',
        },
      })
    ).rejects.toThrow('different provider');
    await expect(
      store.resolve('workspace-fixture', { ...config, env: { codex_home: '/tmp/foreign' } })
    ).rejects.toThrow('cannot override');
    await expect(
      store.resolve('workspace-fixture', {
        ...config,
        runtimeOverrides: { codexPath: '/tmp/foreign' },
      })
    ).rejects.toThrow('managed Codex');
    expect(await store.apiKey(resolved)).toBe('synthetic-first');
  });

  it('keeps profile homes separate and rejects symlinked homes', async () => {
    const { root, store, config, resolved } = await fixture();
    const other = await store.resolve(
      'workspace-fixture',
      {
        ...config,
        id: randomUUID() as AgentConfigMeta['id'],
        codexAuth: { mode: 'chatgpt', profileId: randomUUID() },
      },
      true
    );
    expect(other?.home).not.toBe(resolved.home);
    await rm(resolved.home, { recursive: true });
    await symlink(root, resolved.home);
    await expect(store.resolve('workspace-fixture', config, true)).rejects.toThrow(
      'Invalid Codex account home'
    );
  });

  it('removes all owned generations while retaining history and rejecting resurrection', async () => {
    const { store, config, resolved, secrets } = await fixture();
    await store.withApiKeyCandidate(resolved, 'synthetic-first', async () => {});
    await store.withApiKeyCandidate(resolved, 'synthetic-second', async () => {});
    await store.remove(resolved);
    expect(secrets.size).toBe(0);
    await expect(store.resolve('workspace-fixture', config, true)).rejects.toThrow('was removed');
    await expect(store.apiKey(resolved)).rejects.toThrow('was removed');
    expect((await store.list('workspace-fixture'))[0]?.home).toBe(resolved.home);
  });
});
