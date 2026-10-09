import { createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMachineRoomId,
  type MachineId,
  type MachineMeta,
  type MachineFlockScanRow,
  type WorkspaceId,
} from '@lody/shared';
import {
  receiveMagpieImportAtom,
  importMagpieProvidersAtom,
  pendingMagpieImportAtom,
} from '../src/atoms/magpie-import';
import { localProbeResultAtom, localCliStartingAtom } from '../src/atoms/local-probe';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import { getAllAgentConfigAtom, getAllProviderSetupsAtom } from '../src/atoms/agents';

const machineId = 'local-machine' as MachineId;
const gateway = 'http://127.0.0.1:3425';
const link = `lody://provider/import?v=1&data=${Buffer.from(
  JSON.stringify({
    kind: 'custom',
    id: 'magpie',
    name: 'Magpie',
    auth: { method: 'apiKey', apiKey: 'magpie-lody' },
    endpoints: [
      {
        protocol: 'anthropic-messages',
        baseUrl: gateway,
        targets: ['claude-code'],
        modelsUrl: `${gateway}/v1/models`,
      },
      {
        protocol: 'openai-responses',
        baseUrl: `${gateway}/v1`,
        targets: ['codex'],
        modelsUrl: `${gateway}/v1/models`,
      },
      {
        protocol: 'openai-chat',
        baseUrl: `${gateway}/v1`,
        targets: ['pi', 'dsh'],
        modelsUrl: `${gateway}/v1/models`,
      },
    ],
  })
).toString('base64url')}`;
function fixture() {
  vi.stubGlobal('window', { __LODY_ELECTRON__: true });
  const store = createStore();
  const workspaceId = 'magpie-workspace' as WorkspaceId;
  const rows = new Map<string, MachineFlockScanRow>();
  const writtenMachines = new Set<string>();
  let failDsh = false;
  const runtime = {
    workspaceId,
    workspaceSlug: 'magpie-workspace',
    repo: { openFlockDoc: async () => ({ flock: { scan: () => rows.values() } }) },
    writer: {
      flockRowPut: async (docId: string, key: readonly string[], value: unknown) => {
        if (failDsh && key[0] === 'agentConfig') throw new Error('Synthetic disk failure');
        writtenMachines.add(docId);
        rows.set(JSON.stringify(key), { key, value } as MachineFlockScanRow);
      },
    },
  } as unknown as WorkspaceRuntime;
  store.set(runtimeAtom, runtime);
  store.set(currentWorkspaceIdAtom, workspaceId);
  store.set(currentWorkspaceSlugAtom, 'magpie-workspace');
  store.set(localProbeResultAtom, { ok: true, machineId });
  store.set(localCliStartingAtom, false);
  store.set(machineMetaCacheAtom, {
    [getMachineRoomId(machineId)]: {
      id: machineId,
      name: 'Local',
      protocolCapabilities: { magpieImport: 1, providerSetup: 1, builtinPi: 1 },
    } as MachineMeta,
  });
  return {
    store,
    rows,
    writtenMachines,
    setFailDsh: (fail: boolean) => {
      failDsh = fail;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('confirmed local Magpie import', () => {
  it('stages without writes and persists only checked providers on the local machine', async () => {
    const { store, rows, writtenMachines } = fixture();
    store.set(receiveMagpieImportAtom, link);
    expect(rows.size).toBe(0);
    await store.set(importMagpieProvidersAtom, {
      requestId: store.get(pendingMagpieImportAtom)!.id,
      targets: ['codex', 'dsh'],
    });
    expect(store.get(getAllProviderSetupsAtom).map((s) => s.config.name)).toEqual(['Codex-magpie']);
    expect(store.get(getAllAgentConfigAtom).map((c) => c.name)).toEqual(['DSH-magpie']);
    expect([...writtenMachines]).toEqual(['magpie-workspace:mf:local-machine']);
    expect(store.get(pendingMagpieImportAtom)).toBeNull();
  });
  it('rejects confirmation for a replaced request without writing', async () => {
    const { store, rows } = fixture();
    store.set(receiveMagpieImportAtom, link);
    const requestId = store.get(pendingMagpieImportAtom)!.id;
    store.set(receiveMagpieImportAtom, link);
    await expect(
      store.set(importMagpieProvidersAtom, { requestId, targets: ['codex'] })
    ).rejects.toThrow();
    expect(rows.size).toBe(0);
    expect(store.get(pendingMagpieImportAtom)?.id).not.toBe(requestId);
  });
  it('preserves successful partial writes and makes retry/reopening idempotent', async () => {
    const f = fixture();
    f.store.set(receiveMagpieImportAtom, link);
    f.setFailDsh(true);
    await expect(
      f.store.set(importMagpieProvidersAtom, {
        requestId: f.store.get(pendingMagpieImportAtom)!.id,
        targets: ['claude', 'dsh'],
      })
    ).rejects.toThrow('disk failure');
    const first = f.store.get(getAllProviderSetupsAtom)[0];
    expect(first?.config.name).toBe('Claude-magpie');
    expect(f.store.get(pendingMagpieImportAtom)).not.toBeNull();
    f.setFailDsh(false);
    await f.store.set(importMagpieProvidersAtom, {
      requestId: f.store.get(pendingMagpieImportAtom)!.id,
      targets: ['claude', 'dsh'],
    });
    f.store.set(receiveMagpieImportAtom, link);
    await f.store.set(importMagpieProvidersAtom, {
      requestId: f.store.get(pendingMagpieImportAtom)!.id,
      targets: ['claude', 'dsh'],
    });
    expect(f.store.get(getAllProviderSetupsAtom).map((s) => s.id)).toEqual([first?.id]);
    expect(f.store.get(getAllAgentConfigAtom)).toHaveLength(1);
    expect(f.rows.size).toBe(2);
  });
  it('refuses a missing local machine or unsupported daemon without writing', async () => {
    const f = fixture();
    f.store.set(receiveMagpieImportAtom, link);
    f.store.set(localProbeResultAtom, null);
    await expect(
      f.store.set(importMagpieProvidersAtom, {
        requestId: f.store.get(pendingMagpieImportAtom)!.id,
        targets: ['pi'],
      })
    ).rejects.toThrow();
    f.store.set(localProbeResultAtom, { ok: true, machineId });
    f.store.set(machineMetaCacheAtom, {});
    await expect(
      f.store.set(importMagpieProvidersAtom, {
        requestId: f.store.get(pendingMagpieImportAtom)!.id,
        targets: ['pi'],
      })
    ).rejects.toThrow();
    expect(f.rows.size).toBe(0);
  });
  it('rejects unoffered/duplicate selections and Pi without its host capability', async () => {
    const f = fixture();
    f.store.set(receiveMagpieImportAtom, link);
    await expect(
      f.store.set(importMagpieProvidersAtom, {
        requestId: f.store.get(pendingMagpieImportAtom)!.id,
        targets: ['claude', 'claude'],
      })
    ).rejects.toThrow();
    await expect(
      f.store.set(importMagpieProvidersAtom, {
        requestId: f.store.get(pendingMagpieImportAtom)!.id,
        targets: [],
      })
    ).rejects.toThrow();
    f.store.set(machineMetaCacheAtom, {
      [getMachineRoomId(machineId)]: {
        id: machineId,
        protocolCapabilities: { magpieImport: 1, providerSetup: 1 },
      } as MachineMeta,
    });
    await expect(
      f.store.set(importMagpieProvidersAtom, {
        requestId: f.store.get(pendingMagpieImportAtom)!.id,
        targets: ['pi'],
      })
    ).rejects.toThrow('does not support Pi');
    expect(f.rows.size).toBe(0);
  });
});
