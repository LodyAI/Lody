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
  listPendingE2eeWorkspacesByArchive,
  savePendingE2eeWorkspace,
  setPendingE2eeWorkspaceArchived,
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
vi.mock('@posthog/react', () => ({ usePostHog: () => null }));
const platform = vi.hoisted(() => ({
  e2eeWorkspaces: {
    prepareCreation: async (input: { requestId: string; name: string; slug: string }) => ({
      ...input,
      genesisRecordHex: 'aa',
      genesisHashHex: 'bb'.repeat(32),
    }),
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
    deleteOrganization: async (id: string) => {
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
const rowButton = (requestId: string, label: string) =>
  [
    ...container!.querySelectorAll<HTMLButtonElement>(`[data-request-id="${requestId}"] button`),
  ].find((item) => item.textContent?.includes(label));
const typeInto = (id: string, value: string) =>
  act(async () => {
    const field = input(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const byArchive = (accountId = 'account') =>
  listPendingE2eeWorkspacesByArchive(localStorage, accountId);

describe('create workspace route with a saved encrypted request', () => {
  it('lets a user set a saved request aside and create a regular workspace with the toggle off', async () => {
    savePendingE2eeWorkspace(localStorage, pending);
    await render();
    expect(input('workspace-name').disabled).toBe(true);
    expect(input('workspace-name').value).toBe('Saved');
    await click('e2ee.create.setAside');
    expect(input('workspace-name').disabled).toBe(false);
    await click('organization.createWorkspace');
    expect(fixture.createOrganization).toHaveBeenCalledWith('Saved', 'saved');
    expect(fixture.create).not.toHaveBeenCalled();
    // Set aside, not discarded: it can still be resumed later.
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([pending]);
  });

  it('removes a request the server refused as not enabled and unlocks regular creation', async () => {
    savePendingE2eeWorkspace(localStorage, pending);
    fixture.create = vi.fn(async () => {
      throw Object.assign(new Error('not enabled'), {
        data: { code: 'e2ee_creation_not_enabled' },
      });
    });
    await render();
    await click('e2ee.create.resume');
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toContain('e2ee.create.notEnabled');
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([]);
    expect(input('workspace-name').disabled).toBe(false);
    await click('organization.createWorkspace');
    expect(fixture.createOrganization).toHaveBeenCalledWith('Saved', 'saved');
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it('removes an unreserved old identity intent and shows requestRemoved without locking the form', async () => {
    savePendingE2eeWorkspace(localStorage, pending);
    fixture.create = async () => {
      throw Object.assign(new Error('old account identity'), {
        data: { code: 'e2ee_account_identity_conflict' },
      });
    };
    await render();
    await click('e2ee.create.resume');
    expect(container!.textContent).toContain('e2ee.create.requestRemoved');
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([]);
    expect(input('workspace-name').disabled).toBe(false);
    expect(button('e2ee.create.resume')).toBeUndefined();
  });

  it('keeps an unknown outcome saved and locked for an exact retry', async () => {
    savePendingE2eeWorkspace(localStorage, pending);
    fixture.create = vi.fn(async () => {
      throw new Error('reply lost');
    });
    await render();
    await click('e2ee.create.resume');
    expect(container!.textContent).toContain('e2ee.create.failed');
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([pending]);
    expect(input('workspace-name').disabled).toBe(true);
    expect(button('e2ee.create.resume')).toBeDefined();
  });

  it('resumes a healthy request beside malformed and mismatched intents without changing their bytes', async () => {
    fixture.creationEnabled = true;
    const damaged = 'lody-e2ee-pending-creation:account:broken';
    const alias = 'lody-e2ee-pending-creation:account:alias';
    const malformed = '{broken';
    const mismatched = JSON.stringify({ ...pending, name: 'Conflicting alias' });
    localStorage.setItem(damaged, malformed);
    localStorage.setItem(alias, mismatched);
    savePendingE2eeWorkspace(localStorage, pending);
    await render();
    expect(input('workspace-name').value).toBe('Saved');
    await click('e2ee.create.resume');
    expect(container!.textContent).toContain('e2ee.create.failed');
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([pending]);
    expect(localStorage.getItem(damaged)).toBe(malformed);
    expect(localStorage.getItem(alias)).toBe(mismatched);
    const fresh = { ...pending, requestId: 'fresh', slug: 'fresh' };
    savePendingE2eeWorkspace(localStorage, fresh);
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([fresh, pending]);
  });

  it.each([false, true])(
    'isolates an unreadable saved request while new creation remains available (%s)',
    async (enabled) => {
      fixture.creationEnabled = enabled;
      localStorage.setItem('lody-e2ee-pending-creation:account:broken', '{broken');
      await render();
      expect(container!.textContent?.includes('e2ee.')).toBe(enabled);
      const type = (id: string, value: string) =>
        act(async () => {
          const field = input(id);
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
            field,
            value
          );
          field.dispatchEvent(new Event('input', { bubbles: true }));
        });
      await type('workspace-name', 'Plain');
      await type('workspace-slug', 'plain');
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

describe('archiving saved encrypted creation requests', () => {
  const second = { accountId: 'account', requestId: 'request-2', name: 'Second', slug: 'second' };
  const createdRequestIds = () =>
    vi.mocked(fixture.create).mock.calls.map(([request]) => request.requestId);

  it('archives the selected request, starts an independent intent, and restores the original after reopening', async () => {
    fixture.creationEnabled = true;
    savePendingE2eeWorkspace(localStorage, pending);
    savePendingE2eeWorkspace(localStorage, second);
    fixture.create = vi.fn(async () => {
      throw new Error('reply lost');
    });
    await render();
    expect(input('workspace-name').value).toBe('Saved');
    await act(async () => rowButton('request-1', 'e2ee.create.archiveRequest')!.click());
    expect(byArchive()).toEqual({ active: [second], archived: [pending] });
    expect(input('workspace-name').disabled).toBe(false);
    expect(input('workspace-name').value).toBe('');
    expect(container!.querySelector('[data-request-id="request-1"]')).toBeNull();

    await typeInto('workspace-name', 'Fresh');
    await typeInto('workspace-slug', 'fresh');
    await click('organization.createWorkspace');
    const [fresh] = createdRequestIds();
    expect(fresh).not.toBe('request-1');
    expect(fresh).not.toBe('request-2');
    // Neither saved original was rewritten by the new intent.
    expect(byArchive().archived).toEqual([pending]);
    expect(byArchive().active).toContainEqual(second);

    // Reopen: the archived request is never resumed automatically.
    act(() => root?.unmount());
    container?.remove();
    await render();
    expect(input('workspace-name').value).not.toBe('Saved');
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-testid="e2ee-creation-archived-toggle"]')!
        .click();
    });
    await act(async () => rowButton('request-1', 'e2ee.create.restoreRequest')!.click());
    expect(byArchive().archived).toEqual([]);
    await act(async () => rowButton('request-1', 'Saved · saved')!.click());
    expect(input('workspace-name').value).toBe('Saved');
    await click('e2ee.create.resume');
    // The restored request retries the same request ID, name and slug.
    expect(vi.mocked(fixture.create).mock.calls.at(-1)![0]).toMatchObject({
      requestId: 'request-1',
      name: 'Saved',
      slug: 'saved',
      genesisRecordHex: 'aa',
    });
  });

  it('keeps an in-flight request selected when another window archives it, then leaves it archived on a late failure', async () => {
    fixture.creationEnabled = true;
    savePendingE2eeWorkspace(localStorage, pending);
    let fail!: (error: unknown) => void;
    fixture.create = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        })
    );
    await render();
    await click('e2ee.create.resume');
    expect(rowButton('request-1', 'e2ee.create.archiveRequest')!.disabled).toBe(true);
    setPendingE2eeWorkspaceArchived(localStorage, pending, true);
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'lody-e2ee-pending-creation-archived:account:request-1',
        })
      );
    });
    // The submitting form is not moved away from its own in-flight intent.
    expect(input('workspace-name').value).toBe('Saved');
    await act(async () => fail(new Error('reply lost')));
    expect(container!.textContent).toContain('e2ee.create.failed');
    expect(byArchive()).toEqual({ active: [], archived: [pending] });
    expect(input('workspace-name').disabled).toBe(false);
    expect(input('workspace-name').value).toBe('');
    expect(button('e2ee.create.resume')).toBeUndefined();
  });

  it('ignores a late result from the previous account after an account switch', async () => {
    fixture.creationEnabled = true;
    savePendingE2eeWorkspace(localStorage, pending);
    const otherAccount = { ...second, accountId: 'account-B' };
    savePendingE2eeWorkspace(localStorage, otherAccount);
    setPendingE2eeWorkspaceArchived(localStorage, otherAccount, true);
    let fail!: (error: unknown) => void;
    fixture.create = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        })
    );
    await render();
    await click('e2ee.create.resume');
    stable.session = { status: 'authenticated', user: { id: 'account-B' } };
    const Component = (Route as unknown as { options: { component: () => JSX.Element } }).options
      .component;
    await act(async () => root!.render(<Component />));
    // Account B sees only its own archive and starts free.
    expect(container!.querySelector('[data-request-id="request-1"]')).toBeNull();
    expect(input('workspace-name').value).toBe('');
    await act(async () => fail(new Error('reply lost')));
    expect(container!.textContent).not.toContain('e2ee.create.failed');
    expect(input('workspace-name').value).toBe('');
    expect(byArchive('account')).toEqual({ active: [pending], archived: [] });
    expect(byArchive('account-B')).toEqual({ active: [], archived: [otherAccount] });
  });

  it('shows a storage failure and keeps the request when the archive cannot be saved', async () => {
    fixture.creationEnabled = true;
    savePendingE2eeWorkspace(localStorage, pending);
    await render();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    try {
      await act(async () => rowButton('request-1', 'e2ee.create.archiveRequest')!.click());
    } finally {
      setItem.mockRestore();
    }
    expect(container!.textContent).toContain('e2ee.create.archiveFailed');
    expect(byArchive()).toEqual({ active: [pending], archived: [] });
    expect(input('workspace-name').value).toBe('Saved');
    expect(input('workspace-name').disabled).toBe(true);
  });
});

describe('permanently deleting saved encrypted creation requests', () => {
  const hash = 'bb'.repeat(32);
  const confirmDelete = async (requestId: string) => {
    await act(async () => rowButton(requestId, 'e2ee.create.deleteRequest')!.click());
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="e2ee-creation-delete-confirm"]')!
        .click();
    });
  };

  it('deletes an archived request and the workspace it already created on the server', async () => {
    fixture.creationEnabled = true;
    savePendingE2eeWorkspace(localStorage, pending);
    setPendingE2eeWorkspaceArchived(localStorage, pending, true);
    // The request was reserved although this device never saw the result.
    fixture.serverWorkspaces.add('workspace-1');
    fixture.create = vi.fn(async (request) => ({
      workspaceId: 'workspace-1',
      name: request.name,
      slug: request.slug,
      contentMode: 'e2ee' as const,
      contentModeVersion: 1 as const,
      genesisHash: hash,
      cryptoOrgId: hash,
      activation: 'control-only' as const,
    }));
    await render();
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-testid="e2ee-creation-archived-toggle"]')!
        .click();
    });
    await confirmDelete('request-1');
    expect(fixture.serverWorkspaces.size).toBe(0);
    expect(byArchive()).toEqual({ active: [], archived: [] });
    expect(container!.querySelector('[data-request-id="request-1"]')).toBeNull();
    expect(container!.textContent).not.toContain('e2ee.create.delete');
  });

  it('deletes the selected request, frees the form, and keeps it when the result is unknown', async () => {
    fixture.creationEnabled = true;
    const second = { accountId: 'account', requestId: 'request-2', name: 'Second', slug: 'second' };
    savePendingE2eeWorkspace(localStorage, pending);
    savePendingE2eeWorkspace(localStorage, second);
    fixture.create = vi.fn(async (request) => {
      if (request.requestId === 'request-2') throw new Error('reply lost');
      // Never reserved: the server refuses a new reservation at the allowance limit.
      throw Object.assign(new Error('limit'), { data: { code: 'free_workspace_limit_reached' } });
    });
    await render();
    expect(input('workspace-name').value).toBe('Saved');
    await confirmDelete('request-2');
    expect(container!.textContent).toContain('e2ee.create.deleteFailed');
    expect(byArchive().active).toEqual([pending, second]);
    await confirmDelete('request-1');
    expect(byArchive()).toEqual({ active: [second], archived: [] });
    expect(input('workspace-name').disabled).toBe(false);
    expect(input('workspace-name').value).toBe('');
  });
});
