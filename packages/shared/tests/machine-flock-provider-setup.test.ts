import { describe, expect, it } from 'vitest';
import {
  CodexAuthProfileSchema,
  encodeCodexProfileConfig,
  CODEX_PROFILE_LEGACY_LAUNCH_GUARD,
} from '../src/codex-auth-profile';
import type { AgentConfigId, MachineId } from '../src/ids';
import {
  getMachineFlockProviderSetups,
  machineFlockKeys,
  parseMachineFlockRow,
  serializeMachineFlockKey,
  type MachineFlockRowMap,
  type ProviderSetupTask,
} from '../src/machine-flock';

const setupId = 'setup-1' as AgentConfigId;
const machineId = 'machine-1' as MachineId;

const setup: ProviderSetupTask = {
  v: 1,
  id: setupId,
  machineId,
  config: {
    id: setupId,
    machineId,
    name: 'Codex',
    description: undefined,
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
    prompt: '',
  },
  status: 'queued',
  attempt: 1,
  createdAt: 10,
  updatedAt: 10,
};

describe('machine flock provider setup rows', () => {
  it('retains nonsecret managed identity and strips only its exact legacy executable guard', () => {
    const config = {
      ...setup.config,
      codexAuth: {
        mode: 'api-key' as const,
        profileId: 'b15bb9a7-d3a5-4438-9f5b-d953dfdc046c',
        baseUrl: 'https://relay.example.invalid/v1/',
      },
    };
    const persisted = encodeCodexProfileConfig(config);
    expect(persisted.runtimeOverrides?.codexPath).toBe(CODEX_PROFILE_LEGACY_LAUNCH_GUARD);
    const parsed = parseMachineFlockRow(machineFlockKeys.providerSetup(setup.id), {
      ...setup,
      config: persisted,
    });
    expect(parsed?.value).toMatchObject({
      config: { codexAuth: { ...config.codexAuth, baseUrl: 'https://relay.example.invalid/v1' } },
    });
    if (!parsed) throw new Error('Managed setup did not parse');
    expect((parsed.value as ProviderSetupTask).config.runtimeOverrides).toBeUndefined();
    expect(
      parseMachineFlockRow(machineFlockKeys.providerSetup(setup.id), {
        ...setup,
        config: { ...persisted, runtimeOverrides: { codexPath: '/tmp/foreign' } },
      })
    ).toBeUndefined();
    expect(
      parseMachineFlockRow(machineFlockKeys.providerSetup(setup.id), {
        ...setup,
        config: { ...persisted, env: { openai_api_key: 'synthetic-secret' } },
      })
    ).toBeUndefined();
  });

  it('rejects unsafe endpoint and credential fields as structured validation errors', () => {
    const profile = { mode: 'api-key', profileId: 'b15bb9a7-d3a5-4438-9f5b-d953dfdc046c' };
    for (const baseUrl of [
      'bad',
      'http://remote.example/v1',
      'https://user:secret@relay.example/v1',
      'https://relay.example/v1?token=secret',
    ]) {
      expect(CodexAuthProfileSchema.safeParse({ ...profile, baseUrl }).success).toBe(false);
    }
    expect(
      CodexAuthProfileSchema.safeParse({ ...profile, baseUrl: 'http://127.0.0.1:1234/v1' }).success
    ).toBe(true);
    expect(
      CodexAuthProfileSchema.safeParse({
        ...profile,
        baseUrl: 'https://relay.example/v1',
        apiKey: 'synthetic',
      }).success
    ).toBe(false);
  });
  it('parses and indexes a valid durable setup', () => {
    const row = parseMachineFlockRow(machineFlockKeys.providerSetup(setupId), setup);
    expect(row).toEqual({ key: ['providerSetup', setupId], value: setup });

    const rows = {
      [serializeMachineFlockKey(machineFlockKeys.providerSetup(setupId))]: row!,
    } as MachineFlockRowMap;
    expect(getMachineFlockProviderSetups(rows)).toEqual({ [setupId]: setup });
  });

  it('rejects a setup whose key and future config identity do not match', () => {
    expect(
      parseMachineFlockRow(machineFlockKeys.providerSetup('other' as AgentConfigId), setup)
    ).toBeUndefined();
    expect(
      parseMachineFlockRow(machineFlockKeys.providerSetup(setupId), {
        ...setup,
        config: { ...setup.config, machineId: 'other-machine' },
      })
    ).toBeUndefined();
    expect(
      parseMachineFlockRow(machineFlockKeys.providerSetup(setupId), {
        ...setup,
        config: { ...setup.config, cliType: 'registry', agentType: 'cursor' },
      })
    ).toBeUndefined();
    expect(
      parseMachineFlockRow(machineFlockKeys.providerSetup(setupId), {
        ...setup,
        config: {
          ...setup.config,
          runtimeOverrides: { codexPath: '/tmp/untrusted-codex' },
        },
      })
    ).toBeUndefined();
  });

  it('rejects secrets-shaped transient auth fields instead of preserving them', () => {
    const parsed = parseMachineFlockRow(machineFlockKeys.providerSetup(setupId), {
      ...setup,
      authorizationUrl: 'https://provider.example/secret',
      userCode: 'ABCD-EFGH',
    });
    expect(parsed?.value).toEqual(setup);
    expect(parsed?.value).not.toHaveProperty('authorizationUrl');
    expect(parsed?.value).not.toHaveProperty('userCode');
  });
});
