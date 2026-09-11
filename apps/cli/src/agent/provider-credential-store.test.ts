import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLodyCodexCustomProviderEnv,
  LODY_CODEX_API_KEY_ENV,
  type AgentConfigMeta,
  type WorkspaceId,
} from '@lody/shared';
import {
  hydrateCodexProviderCredential,
  listCodexProviderCredentialConfigIds,
  reconcileCodexProviderCredential,
  stageCodexProviderCredential,
} from './provider-credential-store';

const workspaceId = 'workspace-test' as WorkspaceId;
let dataDir = '';
let previousDataDir: string | undefined;

async function seedCredential(agentConfig: AgentConfigMeta, apiKey: string): Promise<void> {
  const staged = await stageCodexProviderCredential(workspaceId, agentConfig, apiKey);
  await staged.finalize();
}

function config(baseUrl = 'https://relay.example.com/v1'): AgentConfigMeta {
  return {
    id: 'codex-test',
    machineId: 'machine-test',
    name: 'Codex',
    description: undefined,
    cliType: 'builtin',
    agentType: 'codex',
    env: buildLodyCodexCustomProviderEnv({}, { baseUrl }),
  } as AgentConfigMeta;
}

beforeEach(async () => {
  previousDataDir = process.env.LODY_DATA_DIR;
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'lody-provider-credential-'));
  process.env.LODY_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
  else process.env.LODY_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe('provider credential store', () => {
  it('injects only for the exact persisted launch environment', async () => {
    const original = config();
    await seedCredential(original, ' sk-local ');
    expect((await hydrateCodexProviderCredential(workspaceId, original)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'sk-local',
    });

    const changedEndpoint = config('https://attacker.example.com/v1');
    expect(
      (await hydrateCodexProviderCredential(workspaceId, changedEndpoint)).env[
        LODY_CODEX_API_KEY_ENV
      ]
    ).toBeUndefined();
    const changedProxy = {
      ...original,
      env: { ...original.env, HTTPS_PROXY: 'https://evil.test' },
    };
    expect(
      (await hydrateCodexProviderCredential(workspaceId, changedProxy)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();
    const changedRuntime = { ...original, agentType: 'custom-codex-wrapper' };
    expect(
      (await hydrateCodexProviderCredential(workspaceId, changedRuntime)).env[
        LODY_CODEX_API_KEY_ENV
      ]
    ).toBeUndefined();
  });

  it('persists only a digest of the launch binding', async () => {
    const original = {
      ...config(),
      env: { ...config().env, OTHER_SECRET: 'do-not-copy-this-secret' },
    };
    await seedCredential(original, 'sk-local');

    const credentialDirectory = path.join(dataDir, 'provider-credentials');
    const [credentialFile] = await readdir(credentialDirectory);
    if (!credentialFile) throw new Error('Expected a persisted credential file');
    const persisted = await readFile(path.join(credentialDirectory, credentialFile), 'utf8');
    const record = JSON.parse(persisted) as {
      v: number;
      workspaceId: string;
      configId: string;
      current: { binding: string };
    };

    expect(record).toMatchObject({ v: 2, workspaceId, configId: original.id });
    expect(record.current.binding).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted).not.toContain('do-not-copy-this-secret');
    expect(persisted).not.toContain('OTHER_SECRET');
  });

  it('enumerates credential config ids for startup orphan recovery', async () => {
    await seedCredential(config(), 'sk-local');
    await seedCredential({ ...config(), id: 'codex-other' }, 'sk-other');

    await expect(listCodexProviderCredentialConfigIds(workspaceId)).resolves.toEqual(
      expect.arrayContaining(['codex-test', 'codex-other'])
    );
    await expect(
      listCodexProviderCredentialConfigIds('different-workspace' as WorkspaceId)
    ).resolves.toEqual([]);
  });

  it('keeps both published and desired bindings usable through the commit window', async () => {
    const original = config();
    await seedCredential(original, 'old-key');
    const changed = config('https://new.example.com/v1');
    const staged = await stageCodexProviderCredential(workspaceId, changed, 'new-key', original);

    expect((await hydrateCodexProviderCredential(workspaceId, original)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'old-key',
    });
    expect((await hydrateCodexProviderCredential(workspaceId, changed)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'new-key',
    });

    await staged.finalize();

    expect(
      (await hydrateCodexProviderCredential(workspaceId, original)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();
    expect((await hydrateCodexProviderCredential(workspaceId, changed)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'new-key',
    });
  });

  it('restores the prior record when a staged commit loses its setup CAS', async () => {
    const original = config();
    await seedCredential(original, 'old-key');
    const changed = config('https://new.example.com/v1');
    const staged = await stageCodexProviderCredential(workspaceId, changed, 'new-key', original);
    await staged.rollback();

    expect((await hydrateCodexProviderCredential(workspaceId, original)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'old-key',
    });
    expect(
      (await hydrateCodexProviderCredential(workspaceId, changed)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();
  });

  it('recovers either side of a crash cut from authoritative Flock references', async () => {
    const original = config();
    const changed = config('https://new.example.com/v1');
    await seedCredential(original, 'old-key');
    await stageCodexProviderCredential(workspaceId, changed, 'new-key', original);

    await reconcileCodexProviderCredential(workspaceId, original.id, [changed]);
    expect((await hydrateCodexProviderCredential(workspaceId, changed)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'new-key',
    });
    expect(
      (await hydrateCodexProviderCredential(workspaceId, original)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();

    await seedCredential(original, 'old-key');
    await stageCodexProviderCredential(workspaceId, changed, 'new-key', original);
    await reconcileCodexProviderCredential(workspaceId, original.id, [original]);
    expect((await hydrateCodexProviderCredential(workspaceId, original)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'old-key',
    });
    expect(
      (await hydrateCodexProviderCredential(workspaceId, changed)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();
  });

  it('atomically replaces the active key for the same launch binding', async () => {
    const published = config('https://relay.example.com/v1');
    await seedCredential(published, 'old-key');
    await seedCredential(published, 'new-key');

    expect((await hydrateCodexProviderCredential(workspaceId, published)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'new-key',
    });
  });
});
