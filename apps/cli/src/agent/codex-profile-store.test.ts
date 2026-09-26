import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentConfigMeta } from '@lody/shared';
import { CodexProfileStore } from './codex-profile-store';
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
