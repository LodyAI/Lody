// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PlatformProvider,
  PlatformSessionState,
  E2eeWorkspacePrepared,
  PlatformE2eeWorkspaces,
} from '@lody/platform';
import { usePlatform } from '@lody/platform/react';

const fixture = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  organization: {} as Record<string, unknown>,
  cloudClient: { query: async () => undefined, mutation: async () => undefined },
}));

vi.mock('jotai', () => ({ useAtomValue: () => false }));
vi.mock('@/atoms/local-probe', () => ({ localAgentEnabledAtom: 'local-agent' }));
vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => false }));
vi.mock('@/hooks/useStableSession', () => ({ useStableSession: () => fixture.session }));
vi.mock('@/hooks/useOrganization', () => ({ useOrganization: () => fixture.organization }));
vi.mock('@/providers/convex-provider', () => ({ useAuthSignOut: () => async () => {} }));
vi.mock('@/providers/cloud-platform-api', () => ({
  cloudPlatformApi: {},
  useCloudPlatformClient: () => fixture.cloudClient,
}));
vi.mock('@/providers/cloud-github-token-port', () => ({ cloudGitHubTokenPort: {} }));
vi.mock('@/lib/github-token-port', () => ({ installGitHubTokenPort: () => () => {} }));
vi.mock('@/lib/cloud-http-port', () => ({ installCloudHttpPort: () => () => {} }));

import { CloudPlatformProvider } from '@/providers/cloud-platform-provider';
import { createCloudE2eeWorkspaces } from '@/providers/cloud-e2ee-workspaces';

/** What better-auth hands back on a refetch: equal data in new objects. */
function refetch(workspaceName: string) {
  const user = { id: 'user-a', email: 'a@example.com', name: 'A', image: null };
  fixture.session = { data: { user }, isPending: false, isRetrying: false, isOptimistic: false };
  // `createOrganization` closes over the refetched `user`, so it is new too.
  fixture.organization = {
    organizations: [{ id: 'workspace-a', name: 'A', slug: 'a' }],
    activeOrganization: { id: 'workspace-a' },
    role: 'owner',
    error: null,
    activateOrganization: async () => {},
    refetchActiveOrganization: async () => {},
    refetchOrganizations: async () => {},
    updateOrganization: async () => null,
    createOrganization: async () => ({ id: 'workspace-new', name: workspaceName, slug: null }),
  };
}

describe('CloudPlatformProvider', () => {
  let container: HTMLDivElement;
  let root: Root;
  const seen: PlatformProvider[] = [];
  function Probe() {
    seen.push(usePlatform());
    return null;
  }
  const render = () =>
    act(() => root.render(createElement(CloudPlatformProvider, null, createElement(Probe))));

  beforeEach(() => {
    seen.length = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps one platform object across a session refetch and calls the latest actions', async () => {
    refetch('first');
    await render();
    const first = seen.at(-1)!;
    expect(first.identity.session.get()).toMatchObject({
      status: 'authenticated',
      user: { id: 'user-a' },
    });

    refetch('second');
    await render();

    // A consumer that owns resources per platform object (the Prompt Shortcut
    // runtime) must not be torn down by a refetch that changed nothing.
    expect(seen.at(-1)).toBe(first);
    await expect(first.workspaces.create({ name: 'x' })).resolves.toMatchObject({
      name: 'second',
      role: 'owner',
    });
  });
});

describe('cloud E2EE creation ownership', () => {
  const original: E2eeWorkspacePrepared = {
    accountId: 'user-a',
    requestId: 'request-a',
    name: 'Encrypted',
    slug: 'encrypted',
    genesisRecordHex: '01',
    genesisHashHex: 'ab'.repeat(32),
  };
  const request = {
    accountId: original.accountId,
    name: original.name,
    slug: original.slug,
    requestId: original.requestId,
    genesisRecordHex: original.genesisRecordHex,
    developerMode: true as const,
  };
  const receipt = {
    workspaceId: 'workspace-encrypted',
    name: original.name,
    slug: original.slug,
    contentMode: 'e2ee' as const,
    contentModeVersion: 1 as const,
    cryptoOrgId: original.genesisHashHex,
    genesisHash: original.genesisHashHex,
    activation: 'control-only' as const,
  };
  const authenticated = (): PlatformSessionState => ({
    status: 'authenticated',
    user: { id: 'user-a' },
  });
  const remote: Pick<PlatformE2eeWorkspaces, 'create' | 'describe' | 'history'> = {
    create: async () => ({ ...receipt }),
    describe: async () => ({ ...receipt }),
    history: async () => ({
      workspaceId: receipt.workspaceId,
      genesisHash: receipt.genesisHash,
      checkpoint: { headHash: 'cd'.repeat(32), length: 1 },
      startIndex: 0,
      recordsHex: [original.genesisRecordHex],
      nextCursor: null,
    }),
  };

  it('does not offer native creation on an unsupported host or accept unprepared bytes', async () => {
    const port = createCloudE2eeWorkspaces({
      session: authenticated,
      remote,
      refreshWorkspaces: async () => {},
    });
    expect(port.prepareCreation).toBeUndefined();
    await expect(port.create(request)).rejects.toThrow('e2ee_preparation_required');
    await expect(port.describe({ workspaceId: receipt.workspaceId })).resolves.toEqual(receipt);
  });

  it('preserves explicit legacy admission without inventing a plaintext descriptor', async () => {
    const legacy = { workspaceId: 'legacy-workspace', admission: 'legacy-unclassified' as const };
    const port = createCloudE2eeWorkspaces({
      session: authenticated,
      remote: { ...remote, describe: async () => legacy },
      refreshWorkspaces: async () => {},
    });
    await expect(port.describe({ workspaceId: legacy.workspaceId })).resolves.toEqual(legacy);
    await expect(port.describe({ workspaceId: 'different' })).rejects.toThrow(
      'e2ee_workspace_mode_unavailable'
    );
  });

  it('rejects incomplete or contradictory remote mode receipts', async () => {
    const invalid = [
      { ...receipt, genesisHash: 'invalid' },
      { ...receipt, cryptoOrgId: 'cd'.repeat(32) },
      { ...receipt, activation: 'enabled' },
      {
        workspaceId: receipt.workspaceId,
        contentMode: 'plaintext',
        contentModeVersion: 1,
        genesisHash: receipt.genesisHash,
      },
      {
        workspaceId: receipt.workspaceId,
        admission: 'legacy-unclassified',
        contentMode: 'plaintext',
      },
    ];
    for (const value of invalid) {
      const port = createCloudE2eeWorkspaces({
        session: authenticated,
        remote: {
          ...remote,
          describe: async () => value as Awaited<ReturnType<PlatformE2eeWorkspaces['describe']>>,
        },
        refreshWorkspaces: async () => {},
      });
      await expect(port.describe({ workspaceId: receipt.workspaceId })).rejects.toThrow(
        'e2ee_workspace_mode_unavailable'
      );
    }
  });

  it('retains the original after an uncertain committed result and rejects changing its intent', async () => {
    let committed: typeof receipt | undefined;
    const port = createCloudE2eeWorkspaces({
      session: authenticated,
      prepareCreation: async () => ({ ...original }),
      remote: {
        ...remote,
        create: async () => {
          if (!committed) {
            committed = { ...receipt };
            throw new Error('reply lost');
          }
          return committed;
        },
      },
      refreshWorkspaces: async () => {},
    });
    const result = await port.prepareCreation!(original);
    (result as { genesisRecordHex: string }).genesisRecordHex = 'ff';
    await expect(port.create(request)).rejects.toThrow('reply lost');
    expect(committed).toEqual(receipt);
    await expect(port.create({ ...request, name: 'Different' })).rejects.toThrow(
      'e2ee_preparation_required'
    );
    await expect(port.create(request)).resolves.toEqual(committed);
  });

  it('does not publish preparation that settles after account ownership changes', async () => {
    let settle!: (value: E2eeWorkspacePrepared) => void;
    const pending = new Promise<E2eeWorkspacePrepared>((resolve) => {
      settle = resolve;
    });
    let session = authenticated();
    const port = createCloudE2eeWorkspaces({
      session: () => session,
      remote,
      prepareCreation: () => pending,
      refreshWorkspaces: async () => {},
    });
    const operation = port.prepareCreation!(original);
    session = { status: 'authenticated', user: { id: 'user-b' } };
    settle(original);
    await expect(operation).rejects.toThrow('e2ee_account_changed');
    await expect(port.create(request)).rejects.toThrow('e2ee_preparation_required');
    session = authenticated();
    await expect(port.create(request)).rejects.toThrow('e2ee_preparation_required');
  });

  it('rejects substituted cloud receipts and cross-workspace history', async () => {
    const port = createCloudE2eeWorkspaces({
      session: authenticated,
      prepareCreation: async () => ({ ...original }),
      refreshWorkspaces: async () => {},
      remote: { ...remote, create: async () => ({ ...receipt, genesisHash: 'ff'.repeat(32) }) },
    });
    await port.prepareCreation!(original);
    await expect(port.create(request)).rejects.toThrow('e2ee_creation_receipt_mismatch');
    await expect(port.history({ workspaceId: 'different' })).rejects.toThrow(
      'e2ee_history_scope_mismatch'
    );
  });
});
