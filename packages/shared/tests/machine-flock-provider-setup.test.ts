import { describe, expect, it } from 'vitest';
import type { AgentConfigId, MachineId } from '../src/ids';
import { buildLodyCodexCustomProviderEnv } from '../src/codex-provider-config';
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

  it('rejects a setup config containing the one-shot Codex credential', () => {
    expect(
      parseMachineFlockRow(machineFlockKeys.providerSetup(setupId), {
        ...setup,
        config: {
          ...setup.config,
          env: { LODY_CODEX_CUSTOM_ENDPOINT_API_KEY: 'sk-must-not-sync' },
        },
      })
    ).toBeUndefined();
  });

  it('does not guess that unrelated user-owned env values are protocol credentials', () => {
    const config = {
      ...setup.config,
      env: buildLodyCodexCustomProviderEnv(
        { CODEX_API_KEY: 'preserved-user-value', TOKENIZERS_PARALLELISM: 'false' },
        { baseUrl: 'https://relay.example.test/v1' }
      ),
    };
    expect(
      parseMachineFlockRow(machineFlockKeys.providerSetup(setupId), {
        ...setup,
        config,
        setupRevision: 'revision-1',
      })
    ).toBeDefined();
  });

  it('requires an exact setup revision for a custom Codex provider row', () => {
    const config = {
      ...setup.config,
      env: buildLodyCodexCustomProviderEnv(
        {},
        { baseUrl: 'https://relay.example.test/v1' }
      ),
    };
    expect(
      parseMachineFlockRow(machineFlockKeys.providerSetup(setupId), { ...setup, config })
    ).toBeUndefined();
    expect(
      parseMachineFlockRow(machineFlockKeys.providerSetup(setupId), {
        ...setup,
        config,
        setupRevision: 'revision-2',
      })
    ).toBeDefined();
  });
});
