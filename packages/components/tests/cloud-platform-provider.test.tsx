// @vitest-environment jsdom

import { getDefaultStore } from 'jotai';
import type { WorkspaceId } from '@lody/shared';
import { userAtom, currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
import { postHogPrivacy, setTelemetryRouteTarget } from '@/lib/posthog-privacy';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type {
  PlatformProvider,
  PlatformSessionState,
  E2eeWorkspacePrepared,
  E2eeWorkspacePrepareInput,
  E2eeWorkspaceRuntime,
  PlatformE2eeWorkspaces,
} from '@lody/platform';
import { usePlatform, usePlatformSession } from '@lody/platform/react';

const fixture = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  organization: {} as Record<string, unknown>,
  electron: false,
  usePreload: false,
  invoke: async (_channel: string, ..._args: unknown[]): Promise<unknown> => {
    throw new Error('unexpected IPC invocation');
  },
  native: undefined as
    | {
        e2ee: E2eeWorkspaceRuntime & {
          prepareCreation: (input: E2eeWorkspacePrepareInput) => Promise<E2eeWorkspacePrepared>;
        };
      }
    | undefined,
  cloudClient: {
    query: async (_reference: FunctionReference<'query'>, _args: unknown): Promise<unknown> => {
      throw new Error('unexpected query');
    },
    mutation: async (
      _reference: FunctionReference<'mutation'>,
      _args: unknown
    ): Promise<unknown> => {
      throw new Error('unexpected mutation');
    },
    action: async (_reference: FunctionReference<'action'>, _args: unknown): Promise<unknown> => {
      throw new Error('unexpected action');
    },
  },
}));

vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jotai')>()),
  useAtomValue: () => false,
}));
vi.mock('@/atoms', async () => {
  const { atom } = await import('jotai');
  return {
    userAtom: atom(null),
    currentWorkspaceIdAtom: atom(null),
    currentWorkspaceSlugAtom: atom(null),
  };
});
vi.mock('@/atoms/runtime', () => ({ activeWorkspaceRuntimeAtom: 'runtime' }));
vi.mock('@/atoms/local-probe', () => ({ localAgentEnabledAtom: 'local-agent' }));
vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => fixture.electron }));
vi.mock('@/lib/electron-ipc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/electron-ipc-client')>();
  return {
    ...actual,
    getIpcServices: () => (fixture.usePreload ? actual.getIpcServices() : fixture.native),
  };
});
// Match preload's app-local Electron dependency; keep the real bridge and policy.
vi.mock('../../../apps/electron/node_modules/electron', () => ({
  ipcRenderer: {
    on: () => {},
    invoke: (channel: string, ...args: unknown[]) => fixture.invoke(channel, ...args),
  },
}));
vi.mock('@/hooks/useStableSession', () => ({ useStableSession: () => fixture.session }));
vi.mock('@/hooks/useOrganization', () => ({ useOrganization: () => fixture.organization }));
vi.mock('@/providers/convex-provider', () => ({ useAuthSignOut: () => async () => {} }));
vi.mock('convex/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('convex/react')>()),
  useConvex: () => fixture.cloudClient,
}));
vi.mock('@/hooks/use-recoverable-convex-query', () => ({
  usePublicConvexQuery: () => undefined,
  useRecoverableConvexQuery: () => undefined,
}));
vi.mock('@/providers/cloud-github-token-port', () => ({ cloudGitHubTokenPort: {} }));
vi.mock('@/lib/github-token-port', () => ({ installGitHubTokenPort: () => () => {} }));
vi.mock('@/lib/cloud-http-port', () => ({ installCloudHttpPort: () => () => {} }));

import { ipcBridge } from '../../../apps/electron/src/preload/ipc-bridge';
import { createDesktopE2eeContent } from '@/providers/desktop-e2ee-content';
import { initI18n } from '@/i18n';
import { MachineSharingController } from '@/components/settings/e2ee/machine-sharing-settings';
import { CloudPlatformProvider as CloudProvider } from '@/providers/cloud-platform-provider';
import { AuthenticatedConvexContext } from '@/hooks/use-authenticated-convex';
import { createCloudE2eeWorkspaces } from '@/providers/cloud-e2ee-workspaces';
import { useE2eeAccountId } from '@/lib/e2ee-account';
import { readAuthBootstrapSnapshot, writeStoredAuthToken } from '@/lib/auth-bootstrap';

function CloudPlatformProvider({ children }: { children?: ReactNode }) {
  return (
    <AuthenticatedConvexContext.Provider
      value={{
        authSessionId: 'session-a',
        isAuthenticated: true,
        isLoading: false,
        isRecovering: false,
        confirmedUnauthenticated: false,
        claimAutomaticCommand: () => true,
        requestAuthRecovery: () => {},
      }}
    >
      <CloudProvider>{children}</CloudProvider>
    </AuthenticatedConvexContext.Provider>
  );
}

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
    fixture.electron = false;
    fixture.usePreload = false;
    fixture.invoke = async () => {
      throw new Error('unexpected IPC invocation');
    };
    delete window.ipc;
    fixture.native = undefined;
    fixture.cloudClient.query = async () => {
      throw new Error('unexpected query');
    };
    fixture.cloudClient.action = async () => {
      throw new Error('unexpected action');
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    delete window.ipc;
  });

  it('authorizes telemetry only for the matched, confirmed plaintext scope and closes on switches', () => {
    refetch('Plain');
    const store = getDefaultStore();
    const user = { id: 'user-a', email: 'a@example.com', name: 'A', image: null };
    store.set(userAtom, user);
    store.set(currentWorkspaceSlugAtom, 'a');
    store.set(currentWorkspaceIdAtom, 'workspace-a' as WorkspaceId);
    store.set(workspaceContentModeAtom, {
      accountId: user.id,
      workspaceSlug: 'a',
      workspaceId: 'workspace-a',
      descriptor: null,
    });
    setTelemetryRouteTarget('a', true);
    render();
    expect(postHogPrivacy.isAllowed()).toBe(false);
    act(() =>
      store.set(workspaceContentModeAtom, {
        accountId: user.id,
        workspaceSlug: 'a',
        workspaceId: 'workspace-a',
        descriptor: { workspaceId: 'workspace-a', contentMode: 'plaintext', contentModeVersion: 1 },
      })
    );
    expect(postHogPrivacy.isAllowed()).toBe(true);
    setTelemetryRouteTarget('b', false);
    expect(postHogPrivacy.isAllowed()).toBe(false);
    // A late old-scope answer cannot authorize the pending route.
    act(() =>
      store.set(workspaceContentModeAtom, {
        accountId: user.id,
        workspaceSlug: 'a',
        workspaceId: 'workspace-a',
        descriptor: { workspaceId: 'workspace-a', contentMode: 'plaintext', contentModeVersion: 1 },
      })
    );
    expect(postHogPrivacy.isAllowed()).toBe(false);
    setTelemetryRouteTarget('a', true);
    expect(postHogPrivacy.isAllowed()).toBe(true);
    fixture.organization = {
      ...fixture.organization,
      activeOrganization: { id: 'workspace-a', contentMode: 'e2ee' },
    };
    render();
    expect(postHogPrivacy.isAllowed()).toBe(false);
    refetch('Plain');
    render();
    expect(postHogPrivacy.isAllowed()).toBe(true);
    fixture.session = { ...fixture.session, isRetrying: true };
    render();
    expect(postHogPrivacy.isAllowed()).toBe(false);
    refetch('Plain');
    render();
    expect(postHogPrivacy.isAllowed()).toBe(true);
    act(() => store.set(userAtom, { ...user, id: 'user-b' }));
    expect(postHogPrivacy.isAllowed()).toBe(false);
  });

  it('keeps telemetry closed without authenticated context even with retained plaintext state', () => {
    refetch('Plain');
    const store = getDefaultStore();
    const user = { id: 'user-a', email: 'a@example.com', name: 'A', image: null };
    store.set(userAtom, user);
    store.set(currentWorkspaceSlugAtom, 'a');
    store.set(currentWorkspaceIdAtom, 'workspace-a' as WorkspaceId);
    store.set(workspaceContentModeAtom, {
      accountId: user.id,
      workspaceSlug: 'a',
      workspaceId: 'workspace-a',
      descriptor: { workspaceId: 'workspace-a', contentMode: 'plaintext', contentModeVersion: 1 },
    });
    setTelemetryRouteTarget('a', true);
    act(() => root.render(createElement(CloudProvider, null, createElement(Probe))));
    expect(seen.at(-1)!.identity.session.get()).toMatchObject({ status: 'authenticated' });
    expect(seen.at(-1)!.workspaces.state.get()).toEqual({ status: 'loading' });
    expect(postHogPrivacy.isAllowed()).toBe(false);
  });

  it.each(['owner', 'admin'])(
    'keeps encrypted email admission running for an authenticated %s',
    async (role) => {
      fixture.electron = true;
      fixture.usePreload = true;
      window.ipc = ipcBridge;
      refetch('Encrypted');
      fixture.organization.organizations = [
        { id: 'workspace-a', name: 'Encrypted', contentMode: 'e2ee', role },
      ];
      const completed = Promise.withResolvers<void>();
      const approvals: unknown[][] = [];
      fixture.invoke = async (channel, ...args) => {
        if (channel === 'e2ee.open') return { readerOwner: 'inbox-reader' };
        if (channel === 'e2ee.refresh') return undefined;
        if (channel === 'e2ee.status') return { deviceKind: 'personal', memberRole: role };
        if (channel === 'e2ee.memberJoinRequests')
          return { items: [{ requestId: 'email-request', source: 'email' }] };
        if (channel === 'e2ee.approveMemberJoin') {
          approvals.push(args);
          return undefined;
        }
        if (channel === 'e2ee.close') {
          completed.resolve();
          return undefined;
        }
        throw new Error(`unexpected IPC invocation: ${channel}`);
      };
      await render();
      await completed.promise;
      expect(approvals).toEqual([['workspace-a', 'email-request', 'automatic']]);
      expect(seen.at(-1)!.workspaces.state.get()).toMatchObject({
        status: 'ready',
        workspaces: [{ id: 'workspace-a', contentMode: 'e2ee' }],
      });
    }
  );

  it('routes encrypted dispatch and ACK verification through the production provider, IPC proxy and preload', async () => {
    fixture.electron = true;
    fixture.usePreload = true;
    window.ipc = ipcBridge;
    refetch('Encrypted');
    const input = {
      sessionId: 'session-a',
      userTurnId: 'turn-a',
      userId: 'user-a',
      timestamp: new Date(1000).toISOString(),
      inputConfig: { prompt: 'synthetic input' },
    };
    const original = {
      targetMachineId: 'machine-a',
      requesterDevice: '11'.repeat(32),
      requestId: '22'.repeat(16),
      frameHex: '33'.repeat(143),
      expiresAt: 901000,
    };
    const ack = {
      type: 'session/dispatch-turn_response',
      sessionId: input.sessionId,
      userTurnId: input.userTurnId,
      accepted: true,
      disposition: 'accepted',
    };
    const retained: unknown[][] = [];
    fixture.invoke = async (channel, ...args) => {
      // The mock is below the real preload allowlist, at ipcRenderer.invoke.
      // Returning a value requires the exact production route and arguments.
      if (channel === 'e2ee.prepareDispatch') {
        expect(args).toEqual(['workspace-a', 'machine-a', input]);
        retained.push(args);
        return original;
      }
      if (channel === 'e2ee.acceptDispatchResponse') {
        expect(retained).toEqual([['workspace-a', 'machine-a', input]]);
        expect(args).toEqual(['workspace-a', 'machine-a', input, '44'.repeat(143)]);
        return ack;
      }
      throw new Error(`unexpected IPC invocation: ${channel}`);
    };
    await render();
    const runtime = seen.at(-1)!.e2eeWorkspaces!.runtime!;
    const access = createDesktopE2eeContent({
      runtime,
      workspaceId: 'workspace-a',
      genesisHash: 'aa'.repeat(32),
      epoch: 0,
      authToken: () => 'synthetic-account-token',
    });
    try {
      expect(await access.e2ee.prepareDispatch!('machine-a', input)).toEqual(original);
      expect(
        await access.e2ee.acceptDispatchResponse!('machine-a', input, '44'.repeat(143))
      ).toEqual(ack);
    } finally {
      await access.close();
    }
  });

  it('routes sharing reads and pending reconciliation through the real preload and provider', async () => {
    fixture.electron = true;
    fixture.usePreload = true;
    window.ipc = ipcBridge;
    refetch('Encrypted');
    const view = {
      generation: '55'.repeat(32),
      machineId: 'machine-a',
      ownerMembershipId: '11'.repeat(16),
      head: { revision: 2, digest: '22'.repeat(32) },
      sharedWithTeam: true,
      projects: ['project-a'],
    };
    const rid = '33'.repeat(16);
    const change = { kind: 'project', localProjectId: 'project-a', sharedWithTeam: true } as const;
    let pending = true;
    fixture.invoke = async (channel, ...args) => {
      if (channel === 'e2ee.readMachineSharing') {
        expect(args).toEqual(['workspace-a', 'machine-a']);
        return view;
      }
      if (channel === 'e2ee.updateMachineSharing') {
        expect(args).toEqual(['workspace-a', 'machine-a', view.generation, rid, change]);
        const result = { status: pending ? 'pending' : 'saved', requestId: rid };
        pending = false;
        return result;
      }
      throw new Error(`unexpected IPC invocation: ${channel}`);
    };
    await render();
    const runtime = seen.at(-1)!.e2eeWorkspaces!.runtime!;
    expect(await runtime.readMachineSharing!('workspace-a', 'machine-a')).toEqual(view);
    expect(
      await runtime.updateMachineSharing!('workspace-a', 'machine-a', view.generation, rid, change)
    ).toEqual({ status: 'pending', requestId: rid });
    expect(
      await runtime.updateMachineSharing!('workspace-a', 'machine-a', view.generation, rid, change)
    ).toEqual({ status: 'saved', requestId: rid });
  });

  const policyView = (): import('@lody/platform').E2eeMachineSharingView => ({
    machineId: 'machine-a',
    ownerMembershipId: '11'.repeat(16),
    generation: '22'.repeat(32),
    head: { revision: 1, digest: '33'.repeat(32) },
    sharedWithTeam: false,
    projects: [],
    signer: '44'.repeat(32),
    canManage: true,
    needsResign: false,
  });
  function SharingSurface({
    machineId = 'machine-a',
    other = () => {},
  }: {
    machineId?: string;
    other?: () => void;
  }) {
    return createElement(
      'div',
      null,
      createElement('button', { onClick: other }, 'Other setting'),
      createElement(MachineSharingController, {
        key: machineId,
        accountId: 'user-a',
        workspaceId: 'workspace-a',
        machineId,
        runtime: usePlatform().e2eeWorkspaces?.runtime,
        projects: [{ id: 'project-a', name: 'Lody', rootPath: '~/Projects/Lody' }],
      })
    );
  }
  const sharingButton = (label: string) => {
    const button = [...container.querySelectorAll<HTMLElement>('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label
    );
    if (!button) throw new Error(`missing sharing button: ${label}`);
    return button;
  };
  const clickSharing = (label: string) =>
    act(async () => {
      sharingButton(label).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  const renderSharing = async (props: Parameters<typeof SharingSurface>[0] = {}) => {
    fixture.electron = true;
    fixture.usePreload = true;
    window.ipc = ipcBridge;
    refetch('Encrypted');
    await initI18n('en');
    await act(async () =>
      root.render(createElement(CloudPlatformProvider, null, createElement(SharingSurface, props)))
    );
  };

  it.each(['pending', 'lost-reply'] as const)(
    'recovers a %s sharing change after remount through real provider and preload with the same request identity',
    async (mode) => {
      let view = policyView();
      const writes: unknown[][] = [];
      fixture.invoke = async (channel, ...args) => {
        if (channel === 'e2ee.readMachineSharing') return view;
        if (channel !== 'e2ee.updateMachineSharing') throw new Error(channel);
        writes.push(args);
        const change = args[4] as import('@lody/platform').E2eeMachineSharingChange;
        expect(args.slice(0, 3)).toEqual(['workspace-a', 'machine-a', view.generation]);
        expect(args[3]).toMatch(/^[0-9a-f]{32}$/);
        if (writes.length === 1) {
          view = { ...view, pendingRequest: { requestId: String(args[3]), change } };
          if (mode === 'lost-reply') throw new Error('synthetic lost reply');
          return { status: 'pending', requestId: args[3] };
        }
        view = {
          ...view,
          sharedWithTeam: true,
          projects: ['project-a'],
          head: { revision: 2, digest: '55'.repeat(32) },
          pendingRequest: undefined,
        };
        return { status: 'saved', requestId: args[3] };
      };
      await renderSharing();
      await clickSharing('Share Lody with the team');
      expect(container.textContent).toContain('Retry change');
      await act(async () => root.render(null));
      await renderSharing();
      expect(container.textContent).toContain('result is not confirmed');
      await clickSharing('Retry change');
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
      expect(container.textContent).toContain('v2');
      expect(
        container
          .querySelector('[aria-label="Share with the whole team"]')
          ?.getAttribute('aria-checked')
      ).toBe('true');
    }
  );

  it('refreshes a terminal conflict and submits a fresh explicit intent while retaining the requested switch', async () => {
    let view = policyView();
    const writes: unknown[][] = [];
    fixture.invoke = async (channel, ...args) => {
      if (channel === 'e2ee.readMachineSharing') return view;
      writes.push(args);
      if (writes.length === 1) {
        view = { ...view, head: { revision: 8, digest: '88'.repeat(32) } };
        return { status: 'conflict', head: null, requestId: args[3] };
      }
      view = { ...view, sharedWithTeam: true, head: { revision: 9, digest: '99'.repeat(32) } };
      return { status: 'saved', requestId: args[3] };
    };
    await renderSharing();
    await clickSharing('Share with the whole team');
    expect(container.textContent).toContain('Another policy was saved');
    await clickSharing('Retry change');
    expect(writes[1]?.[3]).not.toBe(writes[0]?.[3]);
    expect(writes[1]?.[4]).toEqual(writes[0]?.[4]);
    expect(container.textContent).toContain('v9');
  });

  it('re-signs a revoked issuer policy without dropping undisplayed project choices', async () => {
    let view = {
      ...policyView(),
      needsResign: true,
      sharedWithTeam: true,
      projects: ['project-a', 'retained-project'],
    };
    fixture.invoke = async (channel, ...args) => {
      if (channel === 'e2ee.readMachineSharing') return view;
      expect(args.slice(0, 3)).toEqual(['workspace-a', 'machine-a', view.generation]);
      expect(args[4]).toEqual({ kind: 'machine', sharedWithTeam: true });
      view = {
        ...view,
        needsResign: false,
        head: { revision: 2, digest: '55'.repeat(32) },
        signer: '66'.repeat(32),
      };
      return { status: 'saved', requestId: args[3] };
    };
    await renderSharing();
    expect(container.textContent).toContain('Re-sign required');
    await clickSharing('Re-sign with this device');
    expect(container.textContent).toContain('v2');
    expect(container.textContent).toContain('666666666666');
    expect(container.textContent).toContain('retained-project');
    expect(
      container
        .querySelector('[aria-label="Share Lody with the team"]')
        ?.getAttribute('aria-checked')
    ).toBe('true');
  });

  it.each(['withdrawn', 'readmitted', 'pending'] as const)(
    'rechecks a stale re-sign surface before writing when the latest policy is %s',
    async (latest) => {
      let view: import('@lody/platform').E2eeMachineSharingView = {
        ...policyView(),
        needsResign: true,
        sharedWithTeam: true,
      };
      const writes: unknown[][] = [];
      fixture.invoke = async (channel, ...args) => {
        if (channel === 'e2ee.readMachineSharing') return view;
        writes.push(args);
        view = {
          ...view,
          pendingRequest: undefined,
          needsResign: false,
          sharedWithTeam: false,
          head: { revision: 3, digest: '88'.repeat(32) },
        };
        return { status: 'saved', requestId: args[3] };
      };
      await renderSharing();
      const pendingChange = { kind: 'machine', sharedWithTeam: false } as const;
      const pendingId = '99'.repeat(16);
      view =
        latest === 'readmitted'
          ? { ...policyView(), generation: '77'.repeat(32), head: null }
          : latest === 'withdrawn'
            ? { ...policyView(), head: { revision: 2, digest: '88'.repeat(32) } }
            : { ...view, pendingRequest: { requestId: pendingId, change: pendingChange } };
      await clickSharing('Re-sign with this device');
      expect(writes).toHaveLength(0);
      if (latest === 'pending') {
        expect(container.textContent).toContain('Retry change');
        await clickSharing('Retry change');
        expect(writes).toEqual([
          ['workspace-a', 'machine-a', view.generation, pendingId, pendingChange],
        ]);
        expect(container.textContent).toContain('v3');
      } else {
        expect(container.textContent).not.toContain('Re-sign with this device');
        expect(
          container
            .querySelector('[aria-label="Share with the whole team"]')
            ?.getAttribute('aria-checked')
        ).toBe('false');
      }
    }
  );

  it.each(['en', 'zh_CN'] as const)(
    'shows native non-owner refusal as read-only friendly text (%s)',
    async (language) => {
      fixture.invoke = async (channel) => {
        if (channel !== 'e2ee.readMachineSharing')
          throw new Error('read-only UI attempted a write');
        return { ...policyView(), canManage: false, deniedReason: 'e2ee_machine_not_shared' };
      };
      await renderSharing();
      await act(async () => {
        await initI18n(language);
      });
      expect(container.querySelectorAll('[role=switch]')).toHaveLength(0);
      expect(container.textContent).toContain(language === 'en' ? 'Read only' : '只读');
      expect(container.textContent).toContain(language === 'en' ? 'Ask its owner' : '联系所有者');
      expect(container.textContent).not.toContain('e2ee_machine_not_');
    }
  );

  it('keeps unrelated settings usable while a write is unresolved and reports a safe ownership refusal', async () => {
    let reject!: (error: Error) => void;
    const waiting = new Promise((_, fail) => {
      reject = fail;
    });
    let other = 0;
    fixture.invoke = async (channel) =>
      channel === 'e2ee.readMachineSharing' ? policyView() : waiting;
    await renderSharing({
      other: () => {
        other++;
      },
    });
    await clickSharing('Share with the whole team');
    await clickSharing('Other setting');
    expect(other).toBe(1);
    await act(async () => {
      reject(new Error('e2ee_machine_not_owned'));
    });
    expect(container.textContent).toContain('Only a current personal device');
    expect(container.textContent).not.toContain('e2ee_machine_not_owned');
  });

  it('discards a pending old-generation intent when the machine rejoins', async () => {
    let view = policyView();
    const writes: unknown[][] = [];
    fixture.invoke = async (channel, ...args) => {
      if (channel === 'e2ee.readMachineSharing') return view;
      writes.push(args);
      view = {
        ...view,
        pendingRequest: {
          requestId: String(args[3]),
          change: args[4] as import('@lody/platform').E2eeMachineSharingChange,
        },
      };
      return { status: 'pending', requestId: args[3] };
    };
    await renderSharing();
    await clickSharing('Share with the whole team');
    view = { ...policyView(), generation: '77'.repeat(32) };
    await clickSharing('Refresh policy');
    expect(container.textContent).toContain('machine has rejoined');
    expect(container.textContent).not.toContain('Retry change');
    expect(writes).toHaveLength(1);
    await clickSharing('Share with the whole team');
    expect(writes[1]?.[2]).toBe(view.generation);
    expect(writes[1]?.[3]).not.toBe(writes[0]?.[3]);
  });

  it('fences a delayed read when the selected machine changes', async () => {
    let finish!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      finish = resolve;
    });
    fixture.invoke = async (_channel, ...args) =>
      args[1] === 'machine-a'
        ? first
        : {
            ...policyView(),
            machineId: 'machine-b',
            head: { revision: 7, digest: '77'.repeat(32) },
          };
    await renderSharing();
    await renderSharing({ machineId: 'machine-b' });
    expect(container.textContent).toContain('v7');
    await act(async () => {
      finish({ ...policyView(), head: { revision: 99, digest: '99'.repeat(32) } });
    });
    expect(container.textContent).toContain('v7');
    expect(container.textContent).not.toContain('v99');
  });

  it('routes encrypted feature preparation and response verification through the production provider, IPC proxy and preload', async () => {
    fixture.electron = true;
    fixture.usePreload = true;
    window.ipc = ipcBridge;
    refetch('Encrypted');
    const input = {
      requestId: '55'.repeat(16),
      request: {
        workspaceId: 'workspace-a',
        machineId: 'machine-a',
        method: 'machine/status' as const,
        params: {},
      },
    };
    const original = {
      targetMachineId: 'machine-a',
      requesterDevice: '11'.repeat(32),
      requestId: '22'.repeat(16),
      frameHex: '33'.repeat(143),
      expiresAt: 901000,
    };
    const ack = {
      ok: false as const,
      code: 'e2ee_query_failed',
      error: 'synthetic complete outcome',
    };
    const retained: unknown[][] = [];
    fixture.invoke = async (channel, ...args) => {
      // The mock is below the real preload allowlist, at ipcRenderer.invoke.
      // Returning a value requires the exact production route and arguments.
      if (channel === 'e2ee.prepareFeatureRpc') {
        expect(args).toEqual(['workspace-a', input]);
        retained.push(args);
        return original;
      }
      if (channel === 'e2ee.acceptFeatureRpcResponse') {
        expect(retained).toEqual([['workspace-a', input]]);
        expect(args).toEqual(['workspace-a', input, '44'.repeat(143)]);
        return ack;
      }
      if (channel === 'e2ee.contentStreamsToken') {
        expect(args).toEqual(['workspace-a', undefined, undefined, true]);
        return {
          token: 'synthetic-rpc-only',
          bucketId: 'synthetic-encrypted-content',
          gatewayBaseUrl: 'https://streams.example.test',
          expiresIn: 900,
          expiresAt: Date.now() + 900000,
        };
      }
      throw new Error(`unexpected IPC invocation: ${channel}`);
    };
    await render();
    const runtime = seen.at(-1)!.e2eeWorkspaces!.runtime!;
    const access = createDesktopE2eeContent({
      runtime,
      workspaceId: 'workspace-a',
      genesisHash: 'aa'.repeat(32),
      epoch: 0,
      authToken: () => 'synthetic-account-token',
    });
    try {
      expect(await access.e2ee.prepareFeatureRpc!(input)).toEqual(original);
      expect(await access.e2ee.acceptFeatureRpcResponse!(input, '44'.repeat(143))).toEqual(ack);
      const rpcToken = access.e2ee.createRpcTokenProvider(new AbortController().signal);
      try {
        expect(await rpcToken.getToken()).toBe('synthetic-rpc-only');
      } finally {
        await rpcToken.close();
      }
    } finally {
      await access.close();
    }
  });

  it('keeps ordinary access unauthenticated while E2EE opens with an expired snapshot and retained bearer after network retries fail', async () => {
    fixture.electron = true;
    refetch('Encrypted');
    writeStoredAuthToken('synthetic-retained-bearer');
    localStorage.setItem(
      'lody:auth-bootstrap',
      JSON.stringify({
        user: { id: 'user-a', name: 'A', email: 'a@example.com', image: null },
        updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      })
    );
    expect(readAuthBootstrapSnapshot()).toBeNull();
    // Actual useStableSession terminal output after retryable failures exhaust:
    // the old bootstrap is gone, but this is not a confirmed session rejection.
    fixture.session = {
      data: undefined,
      isPending: false,
      isRetrying: false,
      isOptimistic: false,
      error: new Error('synthetic network unavailable'),
      confirmedUnauthenticated: false,
    };
    const acceptedBearers: string[] = [];
    const unused = async (): Promise<never> => {
      throw new Error('unexpected native operation');
    };
    fixture.native = {
      e2ee: {
        account: async (options) => {
          if (options?.token !== 'synthetic-retained-bearer') return null;
          acceptedBearers.push(options.token);
          return { userId: 'user-a', source: 'offline' };
        },
        prepareCreation: unused,
        recordCreated: unused,
        open: unused,
        close: async () => {},
        status: unused,
        ledgerView: unused,
        ingestLedgerRecords: unused,
      },
    };
    function LocalAccount() {
      const accountId = useE2eeAccountId();
      const session = usePlatformSession();
      const ordinaryAccount = useE2eeAccountId(false);
      return createElement('output', null, `${session.status}:${accountId}:${ordinaryAccount}`);
    }
    await act(async () => {
      root.render(createElement(CloudPlatformProvider, null, createElement(LocalAccount)));
    });
    expect(container.textContent).toBe('unauthenticated:user-a:null');
    expect(acceptedBearers.length).toBeGreaterThan(0);

    // A real rejection immediately retires the E2EE identity too. The retained
    // bearer here deliberately remains, so it cannot disguise confirmed logout.
    fixture.session = {
      ...fixture.session,
      error: Object.assign(new Error('synthetic session rejected'), { status: 401 }),
      confirmedUnauthenticated: true,
    };
    const beforeLogout = acceptedBearers.length;
    await act(async () => {
      root.render(createElement(CloudPlatformProvider, null, createElement(LocalAccount)));
    });
    expect(container.textContent).toBe('unauthenticated:null:null');
    expect(acceptedBearers.length).toBe(beforeLogout);
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

  it('uses actions for creation and fixed-checkpoint history while keeping mode lookup a query', async () => {
    refetch('Encrypted');
    const prepared: E2eeWorkspacePrepared = {
      accountId: 'user-a',
      requestId: 'request-a',
      name: 'Encrypted',
      slug: 'encrypted',
      genesisRecordHex: '01',
      genesisHashHex: 'ab'.repeat(32),
    };
    const receipt = {
      workspaceId: 'workspace-encrypted',
      name: prepared.name,
      slug: prepared.slug,
      contentMode: 'e2ee' as const,
      contentModeVersion: 1 as const,
      cryptoOrgId: prepared.genesisHashHex,
      genesisHash: prepared.genesisHashHex,
      activation: 'control-only' as const,
    };
    const createRequest = {
      accountId: prepared.accountId,
      requestId: prepared.requestId,
      name: prepared.name,
      slug: prepared.slug,
      genesisRecordHex: prepared.genesisRecordHex,
      developerMode: true as const,
    };
    const historyRequest = {
      workspaceId: receipt.workspaceId,
      cursor: 'page-two',
      checkpoint: { headHash: 'cd'.repeat(32), length: 2 },
    };
    const historyPage = {
      workspaceId: receipt.workspaceId,
      genesisHash: receipt.genesisHash,
      checkpoint: { ...historyRequest.checkpoint },
      startIndex: 1,
      recordsHex: ['02'],
      position: 'p1:workspace-encrypted:2:offset:0',
      nextCursor: null,
    };
    fixture.electron = true;
    const bindings: Array<{ workspaceId: string; genesisHash: string; requestId?: string }> = [];
    const unused = async (): Promise<never> => {
      throw new Error('unused runtime method');
    };
    fixture.native = {
      e2ee: {
        prepareCreation: async () => ({ ...prepared }),
        recordCreated: async (binding) => {
          bindings.push({ ...binding });
        },
        open: unused,
        close: async () => {},
        status: unused,
        ledgerView: unused,
        ingestLedgerRecords: unused,
      },
    };
    fixture.cloudClient.query = async (reference, args) => {
      expect(args).toEqual({ workspaceId: receipt.workspaceId });
      if (getFunctionName(reference) === 'e2eeWorkspaces:memberProfiles')
        return {
          workspaceId: receipt.workspaceId,
          profiles: [{ cryptoUserId: '03'.repeat(32), name: 'Teammate', image: null }],
        };
      expect(getFunctionName(reference)).toBe('e2eeWorkspaces:describe');
      return receipt;
    };
    fixture.cloudClient.action = async (reference, args) => {
      switch (getFunctionName(reference)) {
        case 'e2eeWorkspaces:create':
          expect(args).toEqual(createRequest);
          return receipt;
        case 'e2eeWorkspaces:history':
          expect(args).toEqual(historyRequest);
          return historyPage;
        default:
          throw new Error('unexpected action');
      }
    };
    await render();
    const port = seen.at(-1)!.e2eeWorkspaces!;
    await expect(port.prepareCreation!(prepared)).resolves.toEqual(prepared);
    await expect(port.create(createRequest)).resolves.toEqual(receipt);
    expect(bindings).toEqual([
      {
        workspaceId: receipt.workspaceId,
        genesisHash: prepared.genesisHashHex,
        requestId: prepared.requestId,
      },
    ]);
    await expect(port.describe({ workspaceId: receipt.workspaceId })).resolves.toEqual(receipt);
    await expect(port.history(historyRequest)).resolves.toEqual(historyPage);
    await expect(port.memberProfiles!({ workspaceId: receipt.workspaceId })).resolves.toEqual({
      workspaceId: receipt.workspaceId,
      profiles: [{ cryptoUserId: '03'.repeat(32), name: 'Teammate', image: null }],
    });

    fixture.cloudClient.action = async () => {
      throw new Error('history temporarily unavailable');
    };
    await expect(port.history(historyRequest)).rejects.toThrow('history temporarily unavailable');
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
    // A newer activation or mode version still fails closed, but asks for an update.
    for (const value of [
      { ...receipt, activation: 'enabled' },
      { ...receipt, contentModeVersion: 2 },
    ]) {
      const port = createCloudE2eeWorkspaces({
        session: authenticated,
        remote: {
          ...remote,
          describe: async () => value as Awaited<ReturnType<PlatformE2eeWorkspaces['describe']>>,
        },
        refreshWorkspaces: async () => {},
      });
      await expect(port.describe({ workspaceId: receipt.workspaceId })).rejects.toThrow(
        'e2ee_client_upgrade_required'
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

  it('returns a committed creation when only the workspace list refresh fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const port = createCloudE2eeWorkspaces({
        session: authenticated,
        prepareCreation: async () => ({ ...original }),
        remote,
        refreshWorkspaces: async () => {
          throw new Error('listing unavailable');
        },
      });
      await port.prepareCreation!(original);
      await expect(port.create(request)).resolves.toEqual(receipt);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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

describe('cloud E2EE display directory ownership', () => {
  it('binds replies to the live account and strips fields outside the display contract', async () => {
    let session: PlatformSessionState = { status: 'authenticated', user: { id: 'account-a' } };
    const pending = Promise.withResolvers<{
      workspaceId: string;
      profiles: {
        cryptoUserId: string;
        name: string | null;
        image: string | null;
        role?: string;
      }[];
    }>();
    const remote = {
      create: async () => {
        throw new Error('unused');
      },
      describe: async () => {
        throw new Error('unused');
      },
      history: async () => {
        throw new Error('unused');
      },
      memberProfiles: () => pending.promise,
    };
    const port = createCloudE2eeWorkspaces({
      session: () => session,
      remote,
      refreshWorkspaces: async () => {},
    });
    const stale = port.memberProfiles!({ workspaceId: 'workspace' });
    session = { status: 'authenticated', user: { id: 'account-b' } };
    pending.resolve({
      workspaceId: 'workspace',
      profiles: [{ cryptoUserId: '03'.repeat(32), name: 'A', image: null, role: 'owner' }],
    });
    await expect(stale).rejects.toThrow('e2ee_account_changed');
    await expect(port.memberProfiles!({ workspaceId: 'workspace' })).resolves.toEqual({
      workspaceId: 'workspace',
      profiles: [{ cryptoUserId: '03'.repeat(32), name: 'A', image: null }],
    });
    await expect(port.memberProfiles!({ workspaceId: 'another-workspace' })).rejects.toThrow(
      'e2ee_profiles_scope_mismatch'
    );
    session = { status: 'unauthenticated' };
    await expect(port.memberProfiles!({ workspaceId: 'workspace' })).rejects.toThrow(
      'e2ee_account_unavailable'
    );
  });
});
