// @vitest-environment jsdom

import { act } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createHashHistory,
  Outlet,
  RouterProvider,
  type AnyRouter,
} from '@tanstack/react-router';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformE2eeWorkspaces } from '@lody/platform';
import {
  listPendingE2eeWorkspaces,
  readE2eeGenesisPin,
  savePendingE2eeWorkspace,
} from '../src/lib/e2ee-workspace-storage';
import { writePreferredWorkspaceSlug } from '../src/lib/workspace';

const fixture = vi.hoisted(() => ({
  redirect: undefined as string | undefined,
  allowExisting: undefined as boolean | undefined,
  mobile: false,
  signedOut: 0,
  router: undefined as AnyRouter | undefined,
  organizations: [] as Array<{ id: string; name: string; slug: string; contentMode?: 'e2ee' }>,
  activeOrganization: null as {
    id: string;
    name: string;
    slug: string;
    contentMode?: 'e2ee';
  } | null,
  creationEnabled: false,
  cancelPreparation: false,
  convexAuthenticated: true,
  referralLead: false,
  referralListeners: new Set<() => void>(),
  createOrganization: undefined as unknown as (name: string, slug: string) => Promise<unknown>,
  create: undefined as unknown as PlatformE2eeWorkspaces['create'],
  // Synthetic server workspaces that count against the account's allowance.
  serverWorkspaces: new Set<string>(),
}));

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  createFileRoute: () => (options: unknown) => ({
    options,
    useSearch: () => ({ redirect: fixture.redirect, allowExisting: fixture.allowExisting }),
  }),
  useNavigate: () => fixture.router?.navigate ?? (async () => {}),
  Navigate: () => null,
}));
// Stable references: the page's effects depend on them.
const stable = vi.hoisted(() => ({
  translation: { t: (key: string) => key, i18n: { language: 'en' } },
  session: { status: 'authenticated', user: { id: 'account' } },
  availability: { canCreateFree: true },
  pricing: { monthlyAmountCents: 1000, yearlyAmountCents: 9600, yearlyOfferKey: null },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => stable.translation,
}));
vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jotai')>()),
  useAtomValue: () => fixture.creationEnabled,
}));
vi.mock('@/lib/posthog-context', () => ({ usePostHog: () => null }));
const platform = vi.hoisted(() => ({
  e2eeWorkspaces: {
    prepareCreation: async (input: { requestId: string; name: string; slug: string }) => {
      if (fixture.cancelPreparation) throw new Error('e2ee_creation_cancelled');
      return { ...input, genesisRecordHex: 'aa', genesisHashHex: 'bb'.repeat(32) };
    },
    create: (request: Parameters<PlatformE2eeWorkspaces['create']>[0]) => fixture.create(request),
    describe: async () => {
      throw new Error('unused');
    },
    history: async () => {
      throw new Error('unused');
    },
  },
}));
const unusedAction = vi.hoisted(() => async () => {
  throw new Error('unused');
});
vi.mock('@lody/platform/react', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    usePlatformSession: () => stable.session,
    usePlatform: () => platform,
    useCloudQuery: (operation: { name: string }, args: unknown) => {
      const hasLead = useSyncExternalStore(
        (listener) => {
          fixture.referralListeners.add(listener);
          return () => {
            fixture.referralListeners.delete(listener);
          };
        },
        () => fixture.referralLead
      );
      if (operation.name === 'referrals:getCheckoutOffer') {
        return args === 'skip' ? undefined : { discount: hasLead, sendCode: false, bound: false };
      }
      return operation.name === 'billing:getMyNewWorkspacePricing'
        ? stable.pricing
        : stable.availability;
    },
    useCloudMutation: () => async () => {
      fixture.referralLead = false;
      for (const listener of fixture.referralListeners) listener();
    },
    useCloudAction: () => unusedAction,
  };
});
vi.mock('@/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({
    isAuthenticated: fixture.convexAuthenticated,
    isLoading: !fixture.convexAuthenticated,
    authSessionId: fixture.convexAuthenticated ? 'session-1' : null,
    confirmedUnauthenticated: false,
    isRecovering: false,
    claimAutomaticCommand: () => true,
    requestAuthRecovery: () => {},
  }),
}));
vi.mock('@/hooks/useStableSession', () => ({
  useStableSession: () => ({
    data: { user: { id: 'account' } },
    isPending: false,
    isRetrying: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({
    createOrganization: (name: string, slug: string) => fixture.createOrganization(name, slug),
    deleteOrganization: async (id: string, options?: { isEncrypted?: boolean }) => {
      if (!options?.isEncrypted) throw new Error('encrypted workspace requires encrypted deletion');
      if (!fixture.serverWorkspaces.delete(id)) throw new Error('no such workspace');
    },
    organizations: fixture.organizations,
    loading: false,
    activeOrganization: fixture.activeOrganization,
  }),
}));
vi.mock('@/hooks/useWorkspaceSlugField', async () => {
  const { useCallback, useState } = await import('react');
  return {
    useWorkspaceSlugField: () => {
      const [slug, setSlug] = useState('');
      const resetSlug = useCallback(() => setSlug(''), []);
      return {
        slug,
        setSlug,
        resetSlug,
        canReset: false,
        isChecking: false,
        isAvailable: true,
        error: null,
      };
    },
  };
});
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => fixture.mobile }));
vi.mock('../src/providers/convex-provider', () => ({
  useAuthSignOut: () => async () => {
    fixture.signedOut += 1;
  },
}));
vi.mock('@/lib/native-platform', () => ({ isNativeAppShell: () => false }));
vi.mock('@/lib/electron', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/electron')>()),
  isElectronRenderer: () => false,
}));
vi.mock('@/lib/native-browser', () => ({ openExternalUrl: async () => false }));

import { Route } from '../src/routes/workspace/create';
import { E2eeActionTimeoutError } from '../src/providers/cloud-e2ee-workspaces';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const pending = { accountId: 'account', requestId: 'request-1', name: 'Saved', slug: 'saved' };
let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  localStorage.clear();
  stable.session = { status: 'authenticated', user: { id: 'account' } };
  fixture.redirect = undefined;
  fixture.allowExisting = undefined;
  fixture.mobile = false;
  fixture.signedOut = 0;
  fixture.router = undefined;
  fixture.organizations = [];
  fixture.activeOrganization = null;
  fixture.creationEnabled = false;
  fixture.cancelPreparation = false;
  fixture.convexAuthenticated = true;
  fixture.referralLead = false;
  fixture.serverWorkspaces = new Set();
  stable.availability.canCreateFree = true;
  fixture.createOrganization = vi.fn(async (name: string, slug: string) => ({
    id: 'w',
    name,
    slug,
  }));
  fixture.create = vi.fn(async () => {
    throw new Error('unused');
  });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

async function render() {
  const Component = (Route as unknown as { options: { component: () => JSX.Element } }).options
    .component;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Component />));
}
const input = (id: string) => container!.querySelector<HTMLInputElement>(`#${id}`)!;
const button = (label: string) =>
  [...container!.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
const click = (label: string) => act(async () => button(label)!.click());
const typeInto = (id: string, value: string) =>
  act(async () => {
    const field = input(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('create workspace route encrypted creation (zero draft UI + silent reconciliation)', () => {
  const hash = 'bb'.repeat(32);

  it('preserves pending intent on create timeout, unlocks the form, and reuses the same requestId on retry', async () => {
    fixture.creationEnabled = true;
    const seenRequestIds: string[] = [];
    const navigate = vi.fn(async () => {});
    fixture.router = { navigate } as unknown as AnyRouter;
    fixture.create = vi.fn(async (request) => {
      seenRequestIds.push(request.requestId);
      if (seenRequestIds.length === 1) throw new E2eeActionTimeoutError('create', 30_000);
      return {
        workspaceId: 'ws-claimed',
        name: request.name,
        slug: request.slug,
        contentMode: 'e2ee' as const,
        contentModeVersion: 1 as const,
        genesisHash: hash,
        cryptoOrgId: hash,
        activation: 'control-only' as const,
      };
    });
    await render();
    await typeInto('workspace-name', 'Private');
    await typeInto('workspace-slug', 'private');
    await act(async () =>
      container!.querySelector<HTMLButtonElement>('[data-testid="e2ee-workspace-create"]')!.click()
    );
    await click('organization.createWorkspace');
    expect(container!.textContent).toContain('e2ee.create.timeout');
    expect(input('workspace-name').disabled).toBe(false);
    const savedAfterTimeout = listPendingE2eeWorkspaces(localStorage, 'account');
    expect(savedAfterTimeout).toHaveLength(1);
    expect(savedAfterTimeout[0]).toMatchObject({
      accountId: 'account',
      name: 'Private',
      slug: 'private',
    });

    // Retrying submits the exact same requestId so an already-committed workspace is claimed cleanly.
    await click('organization.createWorkspace');
    expect(seenRequestIds).toEqual([
      savedAfterTimeout[0]!.requestId,
      savedAfterTimeout[0]!.requestId,
    ]);
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([]);
    expect(navigate).toHaveBeenCalledWith({
      to: '/workspace/e2ee/$workspaceId',
      params: { workspaceId: 'ws-claimed' },
      replace: true,
    });
  });

  it('returns to the editable form and discards pending intent when device confirmation is cancelled', async () => {
    fixture.creationEnabled = true;
    fixture.cancelPreparation = true;
    await render();
    await typeInto('workspace-name', 'Private');
    await typeInto('workspace-slug', 'private');
    await act(async () =>
      container!.querySelector<HTMLButtonElement>('[data-testid="e2ee-workspace-create"]')!.click()
    );
    await click('organization.createWorkspace');
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([]);
    expect(input('workspace-name').disabled).toBe(false);
    expect(input('workspace-name').value).toBe('Private');
    expect(container!.textContent).not.toContain('e2ee.create.failed');
    expect(container!.querySelector('[data-testid="e2ee-creation-requests"]')).toBeNull();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.createOrganization).not.toHaveBeenCalled();
  });

  it('discards pending intent immediately on server refusal and keeps the form editable', async () => {
    fixture.creationEnabled = true;
    fixture.create = vi.fn(async () => {
      throw Object.assign(new Error('not enabled'), {
        data: { code: 'e2ee_creation_not_enabled' },
      });
    });
    await render();
    await typeInto('workspace-name', 'Private');
    await typeInto('workspace-slug', 'private');
    await act(async () =>
      container!.querySelector<HTMLButtonElement>('[data-testid="e2ee-workspace-create"]')!.click()
    );
    await click('organization.createWorkspace');
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toContain('e2ee.create.notEnabled');
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([]);
    expect(input('workspace-name').disabled).toBe(false);
    expect(button('e2ee.create.resume')).toBeUndefined();
    expect(container!.querySelector('[data-testid="e2ee-creation-requests"]')).toBeNull();
  });

  it('preserves pending intent on transient/network failure so later reconciliation can claim it', async () => {
    fixture.creationEnabled = true;
    fixture.create = vi.fn(async () => {
      throw new Error('reply lost');
    });
    await render();
    await typeInto('workspace-name', 'Private');
    await typeInto('workspace-slug', 'private');
    await act(async () =>
      container!.querySelector<HTMLButtonElement>('[data-testid="e2ee-workspace-create"]')!.click()
    );
    await click('organization.createWorkspace');
    expect(container!.textContent).toContain('e2ee.create.failed');
    const saved = listPendingE2eeWorkspaces(localStorage, 'account');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ accountId: 'account', name: 'Private', slug: 'private' });
    expect(input('workspace-name').disabled).toBe(false);
    expect(input('workspace-name').value).toBe('Private');
    expect(button('e2ee.create.resume')).toBeUndefined();
    expect(container!.querySelector('[data-testid="e2ee-creation-requests"]')).toBeNull();
  });

  it('silently reconciles a leftover pending request on mount and enters the committed workspace', async () => {
    savePendingE2eeWorkspace(localStorage, pending);
    const navigate = vi.fn(async () => {});
    fixture.router = { navigate } as unknown as AnyRouter;
    fixture.create = vi.fn(async (request) => ({
      workspaceId: 'ws-reconciled',
      name: request.name,
      slug: request.slug,
      contentMode: 'e2ee' as const,
      contentModeVersion: 1 as const,
      genesisHash: hash,
      cryptoOrgId: hash,
      activation: 'control-only' as const,
    }));
    await render();
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: pending.requestId,
        name: pending.name,
        slug: pending.slug,
      })
    );
    expect(readE2eeGenesisPin(localStorage, 'account', 'ws-reconciled')).toBe(hash);
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([]);
    expect(navigate).toHaveBeenCalledWith({
      to: '/workspace/e2ee/$workspaceId',
      params: { workspaceId: 'ws-reconciled' },
      replace: true,
    });
  });

  it('waits for Convex auth readiness before silently reconciling a leftover pending request', async () => {
    savePendingE2eeWorkspace(localStorage, pending);
    fixture.convexAuthenticated = false;
    const navigate = vi.fn(async () => {});
    fixture.router = { navigate } as unknown as AnyRouter;
    fixture.create = vi.fn(async (request) => ({
      workspaceId: 'ws-reconciled-after-auth',
      name: request.name,
      slug: request.slug,
      contentMode: 'e2ee' as const,
      contentModeVersion: 1 as const,
      genesisHash: hash,
      cryptoOrgId: hash,
      activation: 'control-only' as const,
    }));
    const Component = (Route as unknown as { options: { component: () => JSX.Element } }).options
      .component;
    await render();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([pending]);
    expect(navigate).not.toHaveBeenCalled();

    fixture.convexAuthenticated = true;
    await act(async () => root!.render(<Component />));
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([]);
    expect(navigate).toHaveBeenCalledWith({
      to: '/workspace/e2ee/$workspaceId',
      params: { workspaceId: 'ws-reconciled-after-auth' },
      replace: true,
    });
  });

  it('preserves a leftover pending request on mount when reconciliation hits a transient error without showing errors or draft UI', async () => {
    savePendingE2eeWorkspace(localStorage, pending);
    fixture.create = vi.fn(async () => {
      throw new Error('server unreachable');
    });
    await render();
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([pending]);
    expect(container!.textContent).not.toContain('e2ee.create.failed');
    expect(container!.querySelector('[data-testid="e2ee-creation-requests"]')).toBeNull();
    expect(input('workspace-name').disabled).toBe(false);
    expect(input('workspace-name').value).toBe('');
  });

  it.each([false, true])(
    'isolates an unreadable saved request while new creation remains available (%s)',
    async (enabled) => {
      fixture.creationEnabled = enabled;
      localStorage.setItem('lody-e2ee-pending-creation:account:broken', '{broken');
      await render();
      expect(container!.textContent?.includes('e2ee.')).toBe(enabled);
      await typeInto('workspace-name', 'Plain');
      await typeInto('workspace-slug', 'plain');
      expect(button('organization.createWorkspace')!.disabled).toBe(false);
      await click('organization.createWorkspace');
      expect(fixture.createOrganization).toHaveBeenCalledWith('Plain', 'plain');
      expect(localStorage.getItem('lody-e2ee-pending-creation:account:broken')).toBe('{broken');
    }
  );
});

describe('create workspace with an account referral from another device', () => {
  it('previews and dismisses the saved offer without a browser referral code', async () => {
    stable.availability.canCreateFree = false;
    fixture.referralLead = true;
    await render();
    expect(localStorage.getItem('lody:referral')).toBeNull();
    expect(container!.textContent).toContain('referral.offerTitle');
    await click('referral.remove');
    expect(fixture.referralLead).toBe(false);
    expect(container!.textContent).not.toContain('referral.offerTitle');
  });
});

// The mobile app cannot sell a workspace, so the limit replaces the whole form,
// including its way back; the message itself must not become a dead end.
describe('mobile workspace limit', () => {
  beforeEach(() => {
    fixture.mobile = true;
    fixture.allowExisting = true;
    stable.availability.canCreateFree = false;
  });

  it('returns an account with workspaces to its previous workspace', async () => {
    fixture.organizations = [{ id: 'w-team', name: 'Team', slug: 'team' }];
    const navigate = vi.fn(async () => {});
    fixture.router = { navigate } as unknown as AnyRouter;
    await render();
    expect(container!.textContent).toContain('organization.mobileWorkspaceLimitReachedTitle');
    await click('organization.backToPreviousWorkspace');
    expect(navigate).toHaveBeenCalledWith({
      to: '/$workspaceName/chat',
      params: { workspaceName: 'team' },
      replace: true,
    });
  });

  // useOrganization merges encrypted workspaces into the list and prefers the
  // selected one as active; returning there loops back to its control page.
  const vault = { id: 'w-vault', name: 'Vault', slug: 'vault', contentMode: 'e2ee' as const };

  it('never returns to the selected encrypted workspace', async () => {
    fixture.organizations = [vault];
    fixture.activeOrganization = vault;
    writePreferredWorkspaceSlug('vault');
    const navigate = vi.fn(async () => {});
    fixture.router = { navigate } as unknown as AnyRouter;
    await render();
    expect(container!.textContent).toContain('organization.mobileWorkspaceLimitReachedTitle');
    expect(button('organization.backToPreviousWorkspace')).toBeUndefined();
    expect(button('organization.signOut')).toBeDefined();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns to an ordinary workspace while an encrypted one is selected', async () => {
    fixture.organizations = [vault, { id: 'w-team', name: 'Team', slug: 'team' }];
    fixture.activeOrganization = vault;
    writePreferredWorkspaceSlug('vault');
    const navigate = vi.fn(async () => {});
    fixture.router = { navigate } as unknown as AnyRouter;
    await render();
    await click('organization.backToPreviousWorkspace');
    expect(navigate).toHaveBeenCalledWith({
      to: '/$workspaceName/chat',
      params: { workspaceName: 'team' },
      replace: true,
    });
  });

  it('still offers the account a way out when it has no workspace to return to', async () => {
    await render();
    expect(container!.textContent).toContain('organization.mobileWorkspaceLimitReachedTitle');
    expect(button('organization.backToPreviousWorkspace')).toBeUndefined();
    await click('organization.signOut');
    expect(fixture.signedOut).toBe(1);
  });
});

it('follows an in-app post-creation redirect through the desktop hash router', async () => {
  fixture.redirect = '/alpha/chat?from=create';
  fixture.organizations = [{ id: 'workspace-a', name: 'Alpha', slug: 'alpha' }];
  const pathname = window.location.pathname;
  window.location.hash = '#/workspace/create';
  const rootRoute = createRootRoute({ component: Outlet });
  const Component = (Route as unknown as { options: { component: () => JSX.Element } }).options
    .component;
  const router = createRouter({
    history: createHashHistory(),
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/workspace/create',
        component: Component,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/alpha/chat',
        component: () => <div>Workspace chat</div>,
      }),
    ]),
  });
  fixture.router = router;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    await router.load();
    root!.render(<RouterProvider router={router} />);
  });
  expect(window.location.pathname).toBe(pathname);
  expect(window.location.hash).toBe('#/alpha/chat?from=create');
  expect(container.textContent).toBe('Workspace chat');
  router.history.destroy();
  window.location.hash = '';
});
