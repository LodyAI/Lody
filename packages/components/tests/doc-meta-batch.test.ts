import { describe, expect, it, vi } from 'vitest';
import type { LoroRepo } from 'loro-repo';

import { listDocMetaEntries } from '../src/lib/doc-meta-batch';

describe('listDocMetaEntries', () => {
  it('skips metadata rows without an active existence marker', async () => {
    const scan = vi.fn(async ({ prefix }: { prefix?: readonly unknown[] } = {}) => {
      if (prefix?.[0] === 'm') {
        return [
          { key: ['m', 'machine-active'], value: { id: 'machine-active' } },
          { key: ['m', 'machine-metadata-only'], value: { id: 'machine-metadata-only' } },
          { key: ['m', 'machine-deleted'], value: { id: 'machine-deleted' } },
          { key: ['m', 'machine-missing'], value: { id: 'machine-missing' } },
        ];
      }
      if (prefix?.[0] === 'e') {
        return [
          { key: ['e', 'machine-active'], value: true },
          { key: ['e', 'machine-deleted'], value: false },
          { key: ['e', 'machine-missing'] },
        ];
      }
      return [];
    });
    const repo = {
      getMeta: () => ({ scan }),
      listDoc: vi.fn(async () => []),
    } as unknown as LoroRepo;

    await expect(listDocMetaEntries(repo)).resolves.toEqual([
      {
        docId: 'machine-active',
        exists: true,
        meta: { id: 'machine-active' },
      },
    ]);
  });
});
