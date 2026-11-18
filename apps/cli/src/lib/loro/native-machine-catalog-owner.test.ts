import { RendererFlockRoomGroupMigrationMainLegacy } from '../../../../electron/src/main/services/renderer-flock-room-group-migration';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import { getMachineFlockDocId, type MachineId, type WorkspaceId } from '@lody/shared';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import { NativeRepoMigrationJournal } from './native-repo-migration';
import {
  NativeRoomMigrationAdmission,
  createNativeRoomMigrationCoordinatorLegacy,
} from './native-repo-room-migration';
import {
  NativeLocalMachineCatalogLegacy,
  readLocalMachineCatalogOwner,
  openNativeLocalMachineCatalogLegacy,
  readSelectedLocalMachineCatalogId,
} from './native-machine-catalog-owner';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((close) => close())
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length) throw new AggregateError(failures);
});
async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'local-mf-owner-'));
  cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
  const root = resolve(import.meta.dirname, '../../..');
  const output = join(root, '.test-build', `mf-owner-${dataRoot.split('/').at(-1)}`);
  await mkdir(output, { recursive: true });
  cleanups.push(() => rm(output, { recursive: true, force: true }));
  await build({
    entryPoints: {
      'native-repo-independent-host': join(
        import.meta.dirname,
        'native-repo-independent-host-entry.ts'
      ),
      'native-repo-independent-engine': join(
        import.meta.dirname,
        'native-repo-independent-engine-entry.ts'
      ),
    },
    outdir: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    banner: {
      js: "import { createRequire as __fixtureRequire } from 'node:module'; const require = __fixtureRequire(import.meta.url);",
    },
    plugins: [
      {
        name: 'sdk',
        setup(builder) {
          builder.onResolve({ filter: /^@loro-dev\/loro-repo-engine$/ }, () => ({
            path: createRequire(join(root, 'package.json')).resolve('@loro-dev/loro-repo-engine'),
            external: true,
          }));
          builder.onResolve({ filter: /^@lody\/shared\/node\// }, (args) => ({
            path: resolve(
              root,
              '../../packages/shared/src/node',
              `${args.path.split('/').at(-1)}.ts`
            ),
          }));
        },
      },
    ],
  });
  const options = {
    dataRoot,
    accountId: 'local:synthetic',
    workspaceId: 'lw_synthetic' as WorkspaceId,
    machineId: 'synthetic-machine' as MachineId,
  };
  const selected = resolveLocalIndependentRepo({ platform: 'local', ...options });
  await mkdir(selected.directory, { recursive: true });
  const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
  const launch = {
    executable: process.execPath,
    entry: join(output, 'native-repo-independent-host.js'),
  };
  const main = new IndependentNativeRepoHostLegacy({
    dataDir: selected.dataDir,
    binding: selected.binding,
    ...launch,
    requiredSdkArtifactId: proof?.artifactId,
  });
  cleanups.push(() => main.close());
  const client = await main.client();
  const journal = new NativeRepoMigrationJournal(join(selected.directory, 'routes.sqlite3'));
  cleanups.push(async () => journal.close());
  const binding = JSON.stringify([options.accountId, options.workspaceId]);
  const room = {
    kind: 'flock' as const,
    id: getMachineFlockDocId(options.workspaceId, options.machineId),
  };
  const migrate = async () => {
    const legacy = new Flock();
    legacy.put(
      ['agentConfig', 'synthetic-agent'],
      {
        id: 'synthetic-agent',
        machineId: options.machineId,
        name: 'Original',
        cliType: 'builtin',
        agentType: 'claude',
        env: { TOKEN: 'SYNTHETIC_PRIVATE' },
        future: { retained: true },
      },
      1
    );
    await createNativeRoomMigrationCoordinatorLegacy({
      binding,
      namespace: options.workspaceId,
      targetGeneration: 'engine-0.1.0-v1',
      directory: selected.directory,
      dataDir: selected.dataDir,
      journal,
      client,
      admission: new NativeRoomMigrationAdmission(journal, binding),
      freezeExternalOwners: async () => {},
    }).migrate([
      { room, sources: [{ sourceId: 'legacy', snapshot: async () => legacy.exportFile() }] },
    ]);
  };
  const owner = () => {
    const value = new NativeLocalMachineCatalogLegacy({
      ...options,
      launch,
      requiredSdkArtifactId: proof?.artifactId ?? 'unverified-artifact',
    });
    cleanups.push(() => value.close());
    return value;
  };
  return { options, selected, main, client, room, migrate, owner, proof };
}

describe('persistent local whole-MF owner on the independent data host', () => {
  it('keeps default legacy, admits the verified native owner after migration, and retains private/unknown data across execution restart', async () => {
    const f = await fixture();
    expect(readLocalMachineCatalogOwner(f.options)).toBe('legacy');
    await f.migrate();
    expect(readLocalMachineCatalogOwner(f.options)).toBe('native');
    if (!f.proof) {
      await expect(
        openNativeLocalMachineCatalogLegacy({ ...f.options, encrypted: false, cloud: false })
      ).rejects.toThrow('verified compatible SDK');
      expect(f.client.connectionState).toBe('connected');
      expect(
        (await f.client.flockGet(f.options.workspaceId, f.room, ['agentConfig', 'synthetic-agent']))
          .value
      ).toMatchObject({ name: 'Original' });
      return;
    }
    const daemon = f.owner();
    await daemon.ready();
    const config = await daemon.execution.readAgentConfig('synthetic-agent' as never);
    expect(config?.env).toEqual({ TOKEN: 'SYNTHETIC_PRIVATE' });
    await daemon.execution.saveAgentConfig({ ...config!, name: 'Native edit' }, config);
    expect(
      (await f.client.flockGet(f.options.workspaceId, f.room, ['agentConfig', 'synthetic-agent']))
        .value
    ).toMatchObject({ name: 'Native edit', future: { retained: true } });
    const before = await f.main.leaseInfo();
    await daemon.close();
    expect(f.client.connectionState).toBe('connected');
    expect((await f.main.leaseInfo()).engineRunId).toBe(before.engineRunId);
    const restarted = f.owner();
    await restarted.ready();
    expect((await restarted.execution.readAgentConfig('synthetic-agent' as never))?.name).toBe(
      'Native edit'
    );
  });
  it('selects the same full room for one-shot commands and refuses a lost all-window witness', async () => {
    const f = await fixture();
    expect(readSelectedLocalMachineCatalogId(f.options)).toBeUndefined();
    await f.migrate();
    expect(() => readSelectedLocalMachineCatalogId(f.options)).toThrow('witness missing');
    await mkdir(join(f.options.dataRoot, 'native-repo'), { recursive: true });
    const main = new RendererFlockRoomGroupMigrationMainLegacy({
      group: {
        accountId: f.options.accountId,
        workspaceId: f.options.workspaceId,
        domain: 'machine',
        contentMode: 'plaintext',
        roomIds: [f.room.id],
      },
      databasePath: join(f.options.dataRoot, 'native-repo', 'renderer-flock-group-owners.sqlite3'),
      registeredWindowIds: () => [],
      send: () => {
        throw new Error('No renderer attached');
      },
      readCommittedOwner: async () => 'native',
    });
    try {
      await main.reconcileOwner();
      expect(readSelectedLocalMachineCatalogId(f.options)).toBe(f.options.machineId);
    } finally {
      main.close();
    }
  });
  it('refuses a published route with missing storage instead of creating an empty catalog', async () => {
    const f = await fixture();
    await f.migrate();
    await f.main.close();
    const file = join(
      f.selected.dataDir,
      'namespaces',
      `ns_${Buffer.from(f.options.workspaceId).toString('hex')}.sqlite3`
    );
    await rm(file);
    if (f.proof) {
      const owner = f.owner();
      await expect(owner.ready()).rejects.toThrow();
    } else
      await expect(
        openNativeLocalMachineCatalogLegacy({ ...f.options, encrypted: false, cloud: false })
      ).rejects.toThrow('verified compatible SDK');
    expect(existsSync(file)).toBe(false);
    expect(readLocalMachineCatalogOwner(f.options)).toBe('native');
  });
});
