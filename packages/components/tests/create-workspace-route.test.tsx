// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformE2eeWorkspaces } from '@lody/platform';
import {
  listPendingE2eeWorkspaces,
  savePendingE2eeWorkspace,
} from '../src/lib/e2ee-workspace-storage';

const fixture = vi.hoisted(() => ({
  creationEnabled: false,
  referralLead: false,
  referralListeners: new Set<() => void>(),
  createOrganization: undefined as unknown as (name: string, slug: string) => Promise<unknown>,
  create: undefined as unknown as PlatformE2eeWorkspaces['create'],
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options, useSearch: () => ({}) }),
  useNavigate: () => async () => {},
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
    organizations: [],
    loading: false,
    activeOrganization: null,
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
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/lib/native-platform', () => ({ isNativeAppShell: () => false }));
vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => false }));
vi.mock('@/lib/native-browser', () => ({ openExternalUrl: async () => false }));

import { Route } from '../src/routes/workspace/create';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const pending = { accountId: 'account', requestId: 'request-1', name: 'Saved', slug: 'saved' };
let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  localStorage.clear();
  fixture.creationEnabled = false;
  fixture.referralLead = false;
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
