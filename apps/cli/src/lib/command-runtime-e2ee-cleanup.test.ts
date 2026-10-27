import { describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({
  closes: 0,
  closeFailure: undefined as Error | undefined,
}));

vi.mock('@/utils/const', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/const')>()),
  LODY_AUTH_URL: 'https://synthetic.invalid',
  LODY_AUTH_SITE_URL: 'https://synthetic.invalid',
}));
vi.mock('@/lib/cloud-cli-port', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cloud-cli-port')>()),
  createCloudE2eePort: () => ({}),
  createCloudStreamsTokenPort: () => ({}),
  createCloudBillingPort: () => ({}),
}));
vi.mock('./e2ee/workspace-legacy', () => ({
  openCliE2eeWorkspaceLegacy: async () => ({
    tokens: {},
    close: async () => {
      opened.closes += 1;
      if (opened.closeFailure) throw opened.closeFailure;
    },
  }),
}));
vi.mock('@/lib/loro/doc', () => ({
  LoroDocumentManager: {
    create: async () => {
      throw new Error('synthetic manager creation failure');
    },
  },
}));

import { withWorkspaceManager } from './command-runtime';

const auth = {
  userId: 'synthetic-user',
  token: 'synthetic-token',
  machineId: 'synthetic-machine',
} as Parameters<typeof withWorkspaceManager>[0];
const encrypted = {
  id: 'synthetic-encrypted-workspace',
  name: 'Encrypted',
  slug: null,
  role: 'owner',
  contentMode: 'e2ee',
  genesisHash: 'ab'.repeat(32),
} as Parameters<typeof withWorkspaceManager>[1];

describe('one-shot encrypted workspace manager creation', () => {
  it('closes the opened encrypted workspace and keeps the original error', async () => {
    opened.closes = 0;
    opened.closeFailure = undefined;
    const callback = vi.fn(async () => 'unreachable');

    await expect(withWorkspaceManager(auth, encrypted, 'test', callback)).rejects.toThrow(
      'synthetic manager creation failure'
    );
    expect(callback).not.toHaveBeenCalled();
    expect(opened.closes).toBe(1);
  });

  it('does not replace the creation error when closing also fails', async () => {
    opened.closes = 0;
    opened.closeFailure = new Error('synthetic close failure');

    await expect(withWorkspaceManager(auth, encrypted, 'test', async () => 1)).rejects.toThrow(
      'synthetic manager creation failure'
    );
    expect(opened.closes).toBe(1);
  });
});
