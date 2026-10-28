import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CloudApi } from '@lody/cloud-api';
import type { WorkspaceId } from '@lody/shared';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createCapabilitySet,
  defineCloudAction,
  defineCloudMutation,
  defineCloudQuery,
  createLocalCloudPort,
  createLocalPlatformProvider,
  createStaticStore,
  createStore,
  isLocalUserId,
  isLocalWorkspaceId,
  LOCAL_PLATFORM_CAPABILITIES,
  PLATFORM_CAPABILITIES,
  type PlatformSessionState,
  type E2eeMachineSharingRequests,
  type E2eeMachineSharingReplies,
  type E2eeMachineSharingHeadState,
  type E2eeMachineSharingRemovedHead,
  type E2eeMachineSharingDisplayReader,
  DEFAULT_RUNTIME_ARTIFACTS_BASE_URL,
  resolveRuntimeArtifactsBaseUrl,
  resolvePlatformKind,
} from '../src/index';

it('keeps machine sharing tombstones and account display outside execution credentials', () => {
  expectTypeOf<
    E2eeMachineSharingRequests['commit']['expectedHead']
  >().toEqualTypeOf<E2eeMachineSharingHeadState | null>();
  expectTypeOf<E2eeMachineSharingRequests['commit']>().toMatchTypeOf<{ credential: string }>();
  expectTypeOf<
    E2eeMachineSharingReplies['readHead']
  >().toEqualTypeOf<E2eeMachineSharingHeadState | null>();
  expectTypeOf<
    Extract<E2eeMachineSharingReplies['readRequest'], { status: 'removed' }>
  >().toEqualTypeOf<E2eeMachineSharingRemovedHead>();
  expectTypeOf<Extract<keyof E2eeMachineSharingRemovedHead, 'frameHex'>>().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<keyof E2eeMachineSharingRequests['latestForMember'], 'credential' | 'cliToken'>
  >().toEqualTypeOf<never>();
  expectTypeOf<Parameters<E2eeMachineSharingDisplayReader['latestForMember']>[0]>().toEqualTypeOf<
    E2eeMachineSharingRequests['latestForMember']
  >();
  expectTypeOf<
    CloudApi['e2eeMachineSharing']['latestForMember']['_type']
  >().toEqualTypeOf<'query'>();
  expectTypeOf<CloudApi['e2eeMachineSharing']['readHead']['_type']>().toEqualTypeOf<'action'>();
});

describe('resolvePlatformKind', () => {
  it('defaults to local when unset or blank', () => {
    expect(resolvePlatformKind(undefined)).toBe('local');
    expect(resolvePlatformKind(null)).toBe('local');
    expect(resolvePlatformKind('')).toBe('local');
    expect(resolvePlatformKind('  ')).toBe('local');
  });

  it('parses explicit kinds and trims whitespace', () => {
    expect(resolvePlatformKind('local')).toBe('local');
    expect(resolvePlatformKind(' cloud ')).toBe('cloud');
  });

  it('throws on unrecognized values instead of silently running cloud', () => {
    expect(() => resolvePlatformKind('offline')).toThrow(/Unrecognized/);
  });
});

describe('capabilities', () => {
  it('local set is empty; cloud set covers every capability', () => {
    expect(LOCAL_PLATFORM_CAPABILITIES.list()).toEqual([]);
    for (const capability of PLATFORM_CAPABILITIES) {
      expect(LOCAL_PLATFORM_CAPABILITIES.has(capability)).toBe(false);
      expect(CLOUD_PLATFORM_CAPABILITIES.has(capability)).toBe(true);
    }
  });

  it('createCapabilitySet deduplicates and answers membership', () => {
    const set = createCapabilitySet(['billing', 'billing', 'cloudSync']);
    expect(set.list()).toEqual(['billing', 'cloudSync']);
    expect(set.has('billing')).toBe(true);
    expect(set.has('teamSharing')).toBe(false);
  });
});

describe('cloud operation descriptors', () => {
  it('carry only a validated backend-neutral operation identity', () => {
    expect(defineCloudQuery<{ workspaceId: string }, string>('billing', 'billing:getPlan')).toEqual(
      {
        kind: 'query',
        capability: 'billing',
        name: 'billing:getPlan',
        access: 'authenticated',
      }
    );
    expect(
      defineCloudMutation<{ enabled: boolean }, null>('githubIntegration', 'github:setEnabled')
    ).toEqual({
      kind: 'mutation',
      capability: 'githubIntegration',
      name: 'github:setEnabled',
      access: 'authenticated',
    });
    expect(
      defineCloudAction<Record<string, never>, string>('billing', 'billing:createCheckout')
    ).toEqual({
      kind: 'action',
      capability: 'billing',
      name: 'billing:createCheckout',
      access: 'authenticated',
    });
  });

  it('rejects malformed names at assembly instead of deferring the error to a request', () => {
    expect(() => defineCloudQuery('billing', 'missingFunctionSeparator')).toThrow(
      /Invalid cloud operation/
    );
  });
});

describe('stores', () => {
  it('createStore notifies subscribers only on actual change', () => {
    const store = createStore(1);
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    store.set(1);
    expect(notified).toBe(0);
    store.set(2);
    expect(notified).toBe(1);
    expect(store.get()).toBe(2);
    unsubscribe();
    store.set(3);
    expect(notified).toBe(1);
  });
});

describe('local id namespaces', () => {
  it('recognizes local prefixes and rejects cloud-shaped ids', () => {
    expect(isLocalWorkspaceId('lw_abc123')).toBe(true);
    expect(isLocalWorkspaceId('j57abcdefgh')).toBe(false);
    expect(isLocalUserId('local:abc')).toBe(true);
    expect(isLocalUserId('user_123')).toBe(false);
  });
});

describe('createLocalPlatformProvider', () => {
  const user = { id: 'local:u1', name: 'Local User' };
  const workspace = { id: 'lw_w1', name: 'Local', slug: null, role: 'owner' };

  it('resolves its injected identity with no capabilities and local sync mode', async () => {
    const session = createStore<PlatformSessionState>({ status: 'loading' });
    const provider = createLocalPlatformProvider({
      session,
      workspaces: createStaticStore({
        status: 'ready',
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
      } as const),
    });
    expect(provider.kind).toBe('local');
    expect(provider.sync.mode).toBe('local');
    expect(provider.capabilities.list()).toEqual([]);
    expect(provider.cloudApi).toBeNull();
    expect(provider.identity.session.get()).toEqual({ status: 'loading' });
    session.set({ status: 'authenticated', user });
    expect(provider.identity.session.get()).toEqual({ status: 'authenticated', user });
    expect(provider.workspaces.create).toBeUndefined();
    await expect(provider.workspaces.setActive(workspace.id)).resolves.toBeUndefined();
    await expect(provider.workspaces.setActive('lw_other')).rejects.toThrow(/single implicit/);
  });
});

describe('createLocalCloudPort', () => {
  const identity = { userId: 'local:u1' };
  const workspaces = [{ id: 'lw_w1', name: 'Local', slug: null, role: 'owner' }];

  it('allows only the owner and disables every optional port', async () => {
    const port = createLocalCloudPort({ identity, workspaces });
    expect(port.kind).toBe('local');
    expect(port.streamsTokens).toBeNull();
    expect(port.notifications).toBeNull();
    expect(port.usage).toBeNull();
    expect(port.billing).toBeNull();
    expect(port.githubTokens).toBeNull();
    expect(port.bugReports).toBeNull();
    expect(port.prAssociation).toBeNull();
    expect(port.attachmentUpload).toBeNull();
    expect(port.remotePreview).toBeNull();
    expect(port.runtimeArtifacts.baseUrl).toBe(DEFAULT_RUNTIME_ARTIFACTS_BASE_URL);

    await expect(
      port.access.verifyMachineAccess({
        workspaceId: 'lw_w1' as WorkspaceId,
        requesterUserId: 'local:u1',
      })
    ).resolves.toEqual({ allowed: true });
    await expect(
      port.access.verifyMachineAccess({
        workspaceId: 'lw_w1' as WorkspaceId,
        requesterUserId: 'cloud-user',
      })
    ).resolves.toEqual({ allowed: false, reason: 'requester_not_member' });

    const seen: unknown[] = [];
    const unsubscribe = port.access.watchWorkspaceAccess(
      (snapshot) => seen.push(snapshot),
      (error) => {
        throw error;
      }
    );
    expect(seen).toEqual([{ status: 'authorized', userId: identity.userId, workspaces }]);
    unsubscribe();
  });
});

describe('runtime artifact channel assembly', () => {
  it('uses the public R2-backed artifact channel by default', () => {
    expect(resolveRuntimeArtifactsBaseUrl()).toBe(DEFAULT_RUNTIME_ARTIFACTS_BASE_URL);
  });

  it('allows an explicit operator mirror to override the public channel', () => {
    expect(resolveRuntimeArtifactsBaseUrl('https://artifacts.example.test/')).toBe(
      'https://artifacts.example.test'
    );
  });

  it('rejects an invalid operator mirror at process assembly', () => {
    expect(() => resolveRuntimeArtifactsBaseUrl('not a URL')).toThrow(
      /Invalid runtime artifacts base URL/
    );
  });
});
