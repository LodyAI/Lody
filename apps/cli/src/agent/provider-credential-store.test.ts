import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLodyCodexCustomProviderEnv,
  LODY_CODEX_API_KEY_ENV,
  withLodyCodexCredentialRevision,
  type AgentConfigMeta,
  type WorkspaceId,
} from '@lody/shared';
import {
  hydrateProviderCredential,
  listProviderCredentialConfigIds,
  reconcileProviderCredential,
  stageProviderCredential,
} from './provider-credential-store';

const workspaceId = 'workspace-test' as WorkspaceId;
let dataDir = '';
let previousDataDir: string | undefined;

async function seedCredential(agentConfig: AgentConfigMeta, apiKey: string): Promise<void> {
  const staged = await stageProviderCredential(workspaceId, agentConfig, apiKey);
  await staged.finalize();
}

function config(
  baseUrl = 'https://relay.example.com/v1',
  credentialRevision?: string
): AgentConfigMeta {
  const env = buildLodyCodexCustomProviderEnv({}, { baseUrl });
  return {
    id: 'codex-test',
    machineId: 'machine-test',
    name: 'Codex',
    description: undefined,
    cliType: 'builtin',
    agentType: 'codex',
    env: credentialRevision ? withLodyCodexCredentialRevision(env, credentialRevision) : env,
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
  it('leaves configs without a credential adapter unchanged', async () => {
    const unsupported = {
      ...config(),
      agentType: 'claude',
      env: {},
    };

    expect(await hydrateProviderCredential(workspaceId, unsupported)).toBe(unsupported);
    await expect(stageProviderCredential(workspaceId, unsupported, 'secret')).rejects.toThrow(
      /Unsupported machine-local provider credential/
    );
  });

  it('injects only for the exact persisted launch environment', async () => {
    const original = config();
    await seedCredential(original, ' sk-local ');
    expect((await hydrateProviderCredential(workspaceId, original)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'sk-local',
    });

    const changedEndpoint = config('https://attacker.example.com/v1');
    expect(
      (await hydrateProviderCredential(workspaceId, changedEndpoint)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();
    const changedProxy = {
      ...original,
      env: { ...original.env, HTTPS_PROXY: 'https://evil.test' },
    };
    expect(
      (await hydrateProviderCredential(workspaceId, changedProxy)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();
    const changedRuntime = { ...original, agentType: 'custom-codex-wrapper' };
    expect(
      (await hydrateProviderCredential(workspaceId, changedRuntime)).env[LODY_CODEX_API_KEY_ENV]
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

    await expect(listProviderCredentialConfigIds(workspaceId)).resolves.toEqual(
      expect.arrayContaining(['codex-test', 'codex-other'])
    );
    await expect(
      listProviderCredentialConfigIds('different-workspace' as WorkspaceId)
    ).resolves.toEqual([]);
  });

  it('keeps both published and desired bindings usable through the commit window', async () => {
    const original = config();
    await seedCredential(original, 'old-key');
    const changed = config('https://new.example.com/v1');
    const staged = await stageProviderCredential(workspaceId, changed, 'new-key', original);

    expect((await hydrateProviderCredential(workspaceId, original)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'old-key',
    });
    expect((await hydrateProviderCredential(workspaceId, changed)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'new-key',
    });

    await staged.finalize();

    expect(
      (await hydrateProviderCredential(workspaceId, original)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();
    expect((await hydrateProviderCredential(workspaceId, changed)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'new-key',
    });
  });

  it('restores the prior record when a staged commit loses its setup CAS', async () => {
    const original = config();
    await seedCredential(original, 'old-key');
    const changed = config('https://new.example.com/v1');
    const staged = await stageProviderCredential(workspaceId, changed, 'new-key', original);
    await staged.rollback();

    expect((await hydrateProviderCredential(workspaceId, original)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'old-key',
    });
    expect(
      (await hydrateProviderCredential(workspaceId, changed)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();
  });

  it('recovers either side of a crash cut from authoritative Flock references', async () => {
    const original = config();
    const changed = config('https://new.example.com/v1');
    await seedCredential(original, 'old-key');
    await stageProviderCredential(workspaceId, changed, 'new-key', original);

    await reconcileProviderCredential(workspaceId, original.id, [changed]);
    expect((await hydrateProviderCredential(workspaceId, changed)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'new-key',
    });
    expect(
      (await hydrateProviderCredential(workspaceId, original)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();

    await seedCredential(original, 'old-key');
    await stageProviderCredential(workspaceId, changed, 'new-key', original);
    await reconcileProviderCredential(workspaceId, original.id, [original]);
    expect((await hydrateProviderCredential(workspaceId, original)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'old-key',
    });
    expect(
      (await hydrateProviderCredential(workspaceId, changed)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();
  });

  it('keeps the published key when same-endpoint rotation crashes before Flock commit', async () => {
    const published = config('https://relay.example.com/v1', 'revision-1');
    const desired = config('https://relay.example.com/v1', 'revision-2');
    await seedCredential(published, 'old-key');
    await stageProviderCredential(workspaceId, desired, 'new-key', published);

    // The pending setup still carries the published generation; only Flock commit
    // publishes the desired generation. Startup therefore restores the old key.
    await reconcileProviderCredential(workspaceId, published.id, [published, published]);
    expect((await hydrateProviderCredential(workspaceId, published)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'old-key',
    });
    expect(
      (await hydrateProviderCredential(workspaceId, desired)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();

    // Cancelling the pending setup leaves the same published generation authoritative.
    await reconcileProviderCredential(workspaceId, published.id, [published]);

    expect((await hydrateProviderCredential(workspaceId, published)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'old-key',
    });
    expect(
      (await hydrateProviderCredential(workspaceId, desired)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();
  });

  it('uses the rotated key when Flock committed before credential finalize', async () => {
    const published = config('https://relay.example.com/v1', 'revision-1');
    const desired = config('https://relay.example.com/v1', 'revision-2');
    await seedCredential(published, 'old-key');
    await stageProviderCredential(workspaceId, desired, 'new-key', published);

    await reconcileProviderCredential(workspaceId, published.id, [desired]);

    expect((await hydrateProviderCredential(workspaceId, desired)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'new-key',
    });
    expect(
      (await hydrateProviderCredential(workspaceId, published)).env[LODY_CODEX_API_KEY_ENV]
    ).toBeUndefined();
  });

  it('rejects a key rotation whose caller did not advance credential identity', async () => {
    const published = config();
    await seedCredential(published, 'old-key');

    await expect(
      stageProviderCredential(workspaceId, published, 'new-key', published)
    ).rejects.toThrow(/fresh credential revision/);
    expect((await hydrateProviderCredential(workspaceId, published)).env).toMatchObject({
      [LODY_CODEX_API_KEY_ENV]: 'old-key',
    });
  });
});
