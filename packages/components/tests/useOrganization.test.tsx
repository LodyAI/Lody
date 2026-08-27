// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore, type Store } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-bootstrap', () => ({
  readAuthBootstrapSnapshot: () => null,
  readBootstrappedCurrentUser: () => null,
  readStoredAuthToken: () => null,
}));

const organizationMocks = vi.hoisted(() => ({
  authClient: null as unknown,
  refetchActiveOrganization: vi.fn(),
  refetchOrganizations: vi.fn(),
  setActive: vi.fn(),
  deleteOrganization: vi.fn(),
  leaveOrganization: vi.fn(),
}));

vi.mock('../src/providers/convex-provider', () => ({
  useAuthClient: () => organizationMocks.authClient,
}));

vi.mock('../src/lib/app-platform', () => ({
  isLocalAppPlatform: () => false,
}));

const { StableSessionContext } = await import('../src/hooks/useStableSession');
const { useOrganization } = await import('../src/hooks/useOrganization');
const { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } =
  await import('../src/atoms/workspace-context');
type OrganizationState = ReturnType<typeof useOrganization>;
let latestOrganizationState: OrganizationState | null = null;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type TestOrganization = {
  id: string;
  slug: string;
  name: string;
  logo: null;
  members: Array<{ userId: string; role: string }>;
};

function createOrganization(id: string, slug: string, name: string): TestOrganization {
  return {
    id,
    slug,
    name,
    logo: null,
    members: [{ userId: 'user-1', role: 'owner' }],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function OrganizationProbe({ targetSlug }: { targetSlug: string }) {
  latestOrganizationState = useOrganization({ targetSlug });
  return null;
}

function TestApp({
  targetSlug,
  renderVersion,
  store,
}: {
  targetSlug: string;
  renderVersion: number;
  store: Store;
}) {
  void renderVersion;

  return createElement(
    Provider,
    { store },
    createElement(
      StableSessionContext.Provider,
      {
        value: {
          data: { user: { id: 'user-1' } },
          rawData: { user: { id: 'user-1' } },
          bootstrapSnapshot: null,
          hasLocalToken: false,
          hasRawUser: true,
          isOptimistic: false,
          isPending: false,
          isRetrying: false,
          error: null,
          confirmedUnauthenticated: false,
        },
      },
      createElement(OrganizationProbe, { targetSlug }),
      createElement(OrganizationProbe, { targetSlug })
    )
  );
}

describe('useOrganization setActive dedupe', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let activeOrganization: TestOrganization;
  let store: Store;
  let listVersion = 0;

  beforeEach(() => {
    latestOrganizationState = null;
    listVersion = 0;
    activeOrganization = createOrganization('workspace-old', 'old-workspace', 'Old Workspace');
    store = createStore();
    organizationMocks.refetchActiveOrganization.mockReset();
    organizationMocks.refetchOrganizations.mockReset();
    organizationMocks.setActive.mockReset();
    organizationMocks.deleteOrganization.mockReset();
    organizationMocks.leaveOrganization.mockReset();
    organizationMocks.setActive.mockResolvedValue({
      data: createOrganization('workspace-target', 'target-workspace', 'Target Workspace'),
      error: null,
    });
    organizationMocks.authClient = {
      useListOrganizations: () => ({
        data: [
          createOrganization(
            'workspace-target',
            'target-workspace',
            `Target Workspace ${listVersion}`
          ),
          createOrganization('workspace-old', 'old-workspace', `Old Workspace ${listVersion}`),
          createOrganization('workspace-new', 'workspace-new', `New Workspace ${listVersion}`),
        ],
        isPending: false,
        error: null,
        refetch: organizationMocks.refetchOrganizations,
      }),
      useActiveOrganization: () => ({
        data: activeOrganization,
        isPending: false,
        error: null,
        refetch: organizationMocks.refetchActiveOrganization,
      }),
      organization: {
        setActive: organizationMocks.setActive,
        delete: organizationMocks.deleteOrganization,
        leave: organizationMocks.leaveOrganization,
      },
    };
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.clearAllMocks();
  });

  async function render(targetSlug: string, renderVersion: number): Promise<void> {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }

    await act(async () => {
      root?.render(createElement(TestApp, { targetSlug, renderVersion, store }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('sends one setActive request for duplicate target workspace switchers', async () => {
    await render('target-workspace', 0);

    expect(organizationMocks.setActive).toHaveBeenCalledTimes(1);
    expect(organizationMocks.setActive).toHaveBeenCalledWith({
      organizationId: 'workspace-target',
    });

    listVersion += 1;
    await render('target-workspace', 1);

    expect(organizationMocks.setActive).toHaveBeenCalledTimes(1);

    activeOrganization = createOrganization(
      'workspace-target',
      'target-workspace',
      'Target Workspace'
    );
    listVersion += 1;
    await render('target-workspace', 2);

    expect(organizationMocks.setActive).toHaveBeenCalledTimes(1);
  });

  it('publishes the fallback after delete success when no newer writer intervenes', async () => {
    organizationMocks.deleteOrganization.mockResolvedValueOnce({
      data: { id: 'workspace-old' },
      error: null,
    });
    await render('old-workspace', 0);

    await act(async () => {
      await latestOrganizationState!.deleteOrganization('workspace-old');
    });

    expect(store.get(currentWorkspaceSlugAtom)).toBe('target-workspace');
    expect(store.get(currentWorkspaceIdAtom)).toBe('workspace-target');
  });

  it('rolls back after leave failure when no newer writer intervenes', async () => {
    organizationMocks.leaveOrganization.mockResolvedValueOnce({
      data: null,
      error: { message: 'leave failed' },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await render('old-workspace', 0);

    await act(async () => {
      await latestOrganizationState!.leaveOrganization('workspace-old').catch(() => undefined);
    });

    expect(store.get(currentWorkspaceSlugAtom)).toBe('old-workspace');
    expect(store.get(currentWorkspaceIdAtom)).toBe('workspace-old');
  });

  it('does not switch Better Auth or replace identity when delete resolves after navigation', async () => {
    const deferredDelete = createDeferred<{ data: { id: string } | null; error: null }>();
    organizationMocks.deleteOrganization.mockReturnValueOnce(deferredDelete.promise);
    await render('old-workspace', 0);

    let mutation!: Promise<unknown>;
    await act(async () => {
      mutation = latestOrganizationState!.deleteOrganization('workspace-old');
      await Promise.resolve();
    });
    activeOrganization = createOrganization('workspace-new', 'workspace-new', 'New Workspace');
    await render('workspace-new', 1);
    deferredDelete.resolve({ data: { id: 'workspace-old' }, error: null });
    await act(async () => {
      await mutation;
    });

    expect(store.get(currentWorkspaceSlugAtom)).toBe('workspace-new');
    expect(store.get(currentWorkspaceIdAtom)).toBe('workspace-new');
    expect(organizationMocks.setActive).not.toHaveBeenCalledWith({
      organizationId: 'workspace-target',
    });
  });

  it('restores the newer Better Auth target when navigation overtakes an in-flight fallback', async () => {
    const deferredFallback = createDeferred<{
      data: TestOrganization;
      error: null;
    }>();
    organizationMocks.deleteOrganization.mockResolvedValueOnce({
      data: { id: 'workspace-old' },
      error: null,
    });
    await render('old-workspace', 0);

    // Ensure the module-level setActive dedupe does not retain the fallback id
    // from an earlier test.
    await act(async () => {
      await latestOrganizationState!.activateOrganization('workspace-reset');
    });
    organizationMocks.setActive.mockClear();

    let authWorkspaceId = 'workspace-old';
    organizationMocks.setActive.mockImplementation(
      async ({ organizationId }: { organizationId: string }) => {
        if (organizationId === 'workspace-target') {
          const response = await deferredFallback.promise;
          authWorkspaceId = organizationId;
          return response;
        }
        authWorkspaceId = organizationId;
        return {
          data: createOrganization(organizationId, organizationId, organizationId),
          error: null,
        };
      }
    );

    let mutation!: Promise<unknown>;
    await act(async () => {
      mutation = latestOrganizationState!.deleteOrganization('workspace-old');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(organizationMocks.setActive).toHaveBeenCalledWith({
      organizationId: 'workspace-target',
    });

    activeOrganization = createOrganization('workspace-new', 'workspace-new', 'New Workspace');
    await render('workspace-new', 1);
    deferredFallback.resolve({
      data: createOrganization('workspace-target', 'target-workspace', 'Target Workspace'),
      error: null,
    });
    await act(async () => {
      await mutation;
    });

    expect(organizationMocks.setActive).toHaveBeenLastCalledWith({
      organizationId: 'workspace-new',
    });
    expect(authWorkspaceId).toBe('workspace-new');
    expect(store.get(currentWorkspaceSlugAtom)).toBe('workspace-new');
    expect(store.get(currentWorkspaceIdAtom)).toBe('workspace-new');
  });

  it('keeps a newer navigation identity when leave failure publishes a late rollback', async () => {
    const deferredLeave = createDeferred<{
      data: null;
      error: { message: string };
    }>();
    organizationMocks.leaveOrganization.mockReturnValueOnce(deferredLeave.promise);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await render('old-workspace', 0);

    let mutation!: Promise<unknown>;
    await act(async () => {
      mutation = latestOrganizationState!.leaveOrganization('workspace-old');
      await Promise.resolve();
    });
    activeOrganization = createOrganization('workspace-new', 'workspace-new', 'New Workspace');
    await render('workspace-new', 1);
    deferredLeave.resolve({ data: null, error: { message: 'leave failed' } });
    await act(async () => {
      await mutation.catch(() => undefined);
    });

    expect(store.get(currentWorkspaceSlugAtom)).toBe('workspace-new');
    expect(store.get(currentWorkspaceIdAtom)).toBe('workspace-new');
  });

  it('rejects an awaited activation when Better Auth refuses the switch', async () => {
    organizationMocks.setActive.mockResolvedValueOnce({
      data: null,
      error: { message: 'membership changed' },
    });
    await render('old-workspace', 0);

    await expect(
      latestOrganizationState?.activateOrganization('workspace-rejected')
    ).rejects.toThrow('membership changed');
  });
});
