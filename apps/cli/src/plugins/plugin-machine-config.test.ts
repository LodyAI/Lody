import { expect, it } from 'vitest';
import { machineConfig } from './plugin-machine-config';
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
  await config.set('credential', 'test-value');
  expect(await config.resolve({ theme: 'dark' })).toEqual({ credential: 'test-value' });
  await expect(machineConfig(manifest, 'b', 'm', vault).resolve()).rejects.toThrow(
    'Missing required'
  );
});
