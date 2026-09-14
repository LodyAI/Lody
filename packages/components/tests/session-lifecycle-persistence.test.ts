import { describe, expect, it } from 'vitest';
import {
  createIndexedDbSessionLifecycleAdmissionStore,
  getSessionLifecycleIndexedDbName,
} from '../src/lib/session-lifecycle-persistence';

describe('IndexedDB Session lifecycle persistence boundary', () => {
  it('uses one workspace-wide database name rather than a renderer cache namespace', () => {
    expect(getSessionLifecycleIndexedDbName('workspace-a')).toBe(
      'lody-session-lifecycle-v1:workspace-a'
    );
  });

  it('fails closed when browser durability is unavailable', async () => {
    await expect(
      createIndexedDbSessionLifecycleAdmissionStore({
        workspaceId: 'workspace-a',
        indexedDB: undefined,
      })
    ).rejects.toThrow(/IndexedDB is unavailable/);
  });
});
