import { identityPluginVault, eraseIdentityPluginCustody } from './identity-plugin-vault';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { resolveProjectConfig, machineConfig } from './plugin-machine-config';
import type { PluginManifest } from '@lody/shared/plugins/manifest-schema';
it('hydrates private values only from the workspace-specific credential entry', async () => {
  const store = new Map<string, string>();
  const vault = {
    read: async (k: string) => store.get(k),
    write: async (k: string, v: string) => {
      store.set(k, v);
    },
  };
  const manifest: PluginManifest = {
    id: 'demo',
    title: 'Demo',
    version: '1.0.0',
    sdk: '^1.0.0',
    config: {
      credential: { type: 'secret', label: 'Credential', required: true },
      theme: { type: 'string', scope: 'client', label: 'Theme' },
    },
  };
  const config = machineConfig(manifest, 'a', 'm', vault);
  await expect(config.resolve({ credential: 'spoofed' })).rejects.toThrow('Missing required');
  expect(await config.configured({ credential: 'spoofed' })).toEqual([]);
  await config.set('credential', 'test-value');
  expect(await config.configured({ theme: 'dark' })).toEqual(['credential', 'theme']);
  expect(await config.resolve({ theme: 'dark' })).toEqual({ credential: 'test-value' });
  await expect(machineConfig(manifest, 'b', 'm', vault).resolve()).rejects.toThrow(
    'Missing required'
  );
});

it('keeps encrypted configuration in identity custody, not an unscoped plugin credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-config-identity-'));
  const keys = new Map<string, string>();
  const os = {
    remove: async (key: string) => keys.delete(key),
    read: async (k: string) => keys.get(k),
    write: async (k: string, v: string) => {
      keys.set(k, v);
    },
  };
  try {
    const roots = ['ledger-a/device-a', 'ledger-b/device-a', 'ledger-a/device-b'].map((p) =>
      join(dir, p, 'plugins')
    );
    for (const [index, root] of roots.entries())
      await identityPluginVault(root, os).write(
        'same workspace and plugin',
        `synthetic-secret-${index}`
      );
    for (const [index, root] of roots.entries()) {
      expect(await identityPluginVault(root, os).read('same workspace and plugin')).toBe(
        `synthetic-secret-${index}`
      );
      const files = await readdir(join(root, 'settings'));
      expect(
        (await readFile(join(root, 'settings', files[0]!))).includes(
          Buffer.from('synthetic-secret')
        )
      ).toBe(false);
    }
    const legacyKey = JSON.stringify(['workspace', 'machine', 'plugin', 'credential']);
    keys.set(legacyKey, 'synthetic-plaintext');
    const originalKeys = new Set(keys.keys());
    await expect(
      eraseIdentityPluginCustody(roots[0]!, {
        remove: async () => {
          throw Error('vault locked');
        },
      })
    ).rejects.toThrow('vault locked');
    expect(await identityPluginVault(roots[0]!, os).read('same workspace and plugin')).toBe(
      'synthetic-secret-0'
    );
    await eraseIdentityPluginCustody(roots[0]!, os);
    await eraseIdentityPluginCustody(roots[0]!, os);
    originalKeys.delete(JSON.stringify(['encrypted-plugin-config', roots[0]]));
    expect(new Set(keys.keys())).toEqual(originalKeys);
    expect(keys.get(legacyKey)).toBe('synthetic-plaintext');
    expect(
      await identityPluginVault(roots[0]!, os).read('same workspace and plugin')
    ).toBeUndefined();
    expect(await identityPluginVault(roots[2]!, os).read('same workspace and plugin')).toBe(
      'synthetic-secret-2'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not hydrate project values into the process-wide context', async () => {
  const manifest: PluginManifest = {
    id: 'sample',
    sdk: '1.x',
    version: '1.0.0',
    title: 'Sample',
    config: { name: { type: 'string', label: 'Name', scope: 'project', required: true } },
  };
  expect(await machineConfig(manifest, 'w', 'm').resolve({ name: 'workspace' })).toEqual({});
  expect(() => resolveProjectConfig(manifest, undefined)).toThrow('required project');
  expect(resolveProjectConfig(manifest, { name: 'project', token: 'wrong' })).toEqual({
    name: 'project',
  });
});
