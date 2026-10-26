// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createStaticStore,
  type PlatformProvider,
  type PlatformSessionState,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import { userAtom, currentWorkspaceIdAtom } from '../src/atoms';
import { setWorkspaceContextAtom } from '../src/atoms/workspace-context';
import {
  useSidebarWorkspaceNavigation,
  type SidebarWorkspaceChoice,
} from '../src/components/sidebar-workspaces';
import { cacheWorkspaceInfo } from '../src/lib/local-storage-cache';
import { retainWorkspaceModeProof, saveE2eeGenesisPin } from '../src/lib/e2ee-workspace-storage';
import { readAuthBootstrapSnapshot, writeStoredAuthToken } from '../src/lib/auth-bootstrap';
import { readPreferredWorkspaceSlug } from '../src/lib/workspace';

function remember(account: string, id: string, slug: string) {
  cacheWorkspaceInfo(slug, id, slug.toUpperCase());
  saveE2eeGenesisPin(localStorage, account, id, 'ab'.repeat(32));
  retainWorkspaceModeProof(localStorage, account, slug, {
    workspaceId: id,
    contentMode: 'e2ee',
    contentModeVersion: 1,
    genesisHash: 'ab'.repeat(32),
    cryptoOrgId: 'ab'.repeat(32),
    activation: 'control-only',
  });
}

describe('sidebar encrypted offline workspace navigation', () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: ReturnType<typeof createStore>;
  beforeEach(() => {
    localStorage.clear();
    store = createStore();
    store.set(userAtom, null as never);
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
  });

  async function render(input: {
    encrypted: boolean;
    organizations?: SidebarWorkspaceChoice[];
    session?: PlatformSessionState;
    nativeAccount?: string;
  }) {
    let navigated: string | null = null;
    let activated: string | null = null;
    const platform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      identity: {
        ...TEST_CLOUD_PLATFORM.identity,
        session: createStaticStore(input.session ?? { status: 'unauthenticated', uncertain: true }),
      },
      e2eeWorkspaces: {
        runtime: {
          account: async (options: { token?: string }) => {
            if (!input.encrypted) throw new Error('ordinary workspace used E2EE identity');
            return options?.token === 'synthetic-bearer'
              ? { userId: input.nativeAccount ?? 'account', source: 'offline' }
              : null;
          },
        },
      } as never,
    };
    function Probe() {
      const navigation = useSidebarWorkspaceNavigation({
        organizations: input.organizations,
        encryptedAccountId: input.encrypted ? 'account' : null,
        switchOrganization: async (id) => {
          if (input.organizations === undefined)
            throw new Error('offline selection contacted cloud');
          activated = id;
        },
        setContext: (context) => store.set(setWorkspaceContextAtom, context),
        close: () => {},
        navigate: (slug) => {
          navigated = slug;
        },
      });
      return createElement(
        'nav',
        null,
        ...navigation.workspaces.map((workspace) =>
          createElement(
            'button',
            { key: workspace.id, onClick: () => navigation.select(workspace.id) },
            workspace.slug
          )
        )
      );
    }
    await act(async () =>
      root.render(
        createElement(
          Provider,
          { store },
          createElement(PlatformContext.Provider, { value: platform }, createElement(Probe))
        )
      )
    );
    return { navigated: () => navigated, activated: () => activated };
  }

  it('selects both joined workspaces after an eight-day offline cold restart without activating cloud', async () => {
    writeStoredAuthToken('synthetic-bearer');
    localStorage.setItem(
      'lody:auth-bootstrap',
      JSON.stringify({
        user: { id: 'account', name: 'Synthetic', email: 'synthetic@example.test', image: null },
        updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      })
    );
    expect(readAuthBootstrapSnapshot()).toBeNull();
    remember('account', 'workspace-alpha', 'alpha');
    remember('account', 'workspace-beta', 'beta');
    remember('different-account', 'workspace-private', 'private');
    cacheWorkspaceInfo('ordinary', 'workspace-ordinary', 'Ordinary');
    const result = await render({ encrypted: true });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['alpha', 'beta']);
    await act(() => buttons[1]!.click());
    expect(result.navigated()).toBe('beta');
    expect(store.get(currentWorkspaceIdAtom)).toBe('workspace-beta');
    expect(readPreferredWorkspaceSlug()).toBe('beta');
    expect(result.activated()).toBeNull();
    await act(() => buttons[0]!.click());
    expect(result.navigated()).toBe('alpha');
    expect(store.get(currentWorkspaceIdAtom)).toBe('workspace-alpha');
    expect(result.activated()).toBeNull();
  });

  it('does not offer local hints after confirmed logout', async () => {
    writeStoredAuthToken('synthetic-bearer');
    remember('account', 'workspace-alpha', 'alpha');
    await render({ encrypted: true, session: { status: 'unauthenticated' } });
    expect(container.querySelector('button')).toBeNull();
  });

  it.each([false, true])(
    'keeps the ready organization list authoritative (encrypted=%s)',
    async (encrypted) => {
      writeStoredAuthToken('synthetic-bearer');
      remember('account', 'workspace-alpha', 'alpha');
      const result = await render({
        encrypted,
        organizations: [{ id: 'live-id', slug: 'live', name: 'Live' }],
      });
      expect(container.textContent).toBe('live');
      await act(() => container.querySelector('button')!.click());
      expect(result.navigated()).toBe('live');
      expect(result.activated()).toBe('live-id');
    }
  );

  it('does not borrow another native account or a definitive empty cloud list', async () => {
    writeStoredAuthToken('synthetic-bearer');
    remember('account', 'workspace-alpha', 'alpha');
    remember('different-account', 'workspace-private', 'private');
    await render({ encrypted: true, nativeAccount: 'different-account' });
    expect(container.querySelector('button')).toBeNull();
    await render({ encrypted: true, organizations: [] });
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps an ordinary offline selector empty and never opens E2EE identity', async () => {
    writeStoredAuthToken('synthetic-bearer');
    remember('account', 'workspace-alpha', 'alpha');
    await render({ encrypted: false });
    expect(container.querySelector('button')).toBeNull();
  });
});
