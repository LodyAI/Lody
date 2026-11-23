import { PromptShortcutSync as ActualShortcutSync } from '../../shared/src/prompt-shortcuts/sync';
import { getShortcutBodyStreamId } from '../../shared/src/prompt-shortcuts/access';
import { LoroDoc } from 'loro-crdt';
import type { LoroRepo } from 'loro-repo';
import {
  ShortcutTokenAttempts,
  ShortcutTokenAttemptError,
} from '../src/lib/shortcut-token-attempt';
import { isConvexUnauthenticatedError } from '@lody/shared';
import type { ShortcutTokenReply, ShortcutTokenRequest } from '@lody/cloud-api';
// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptShortcutRuntime } from '@lody/shared/prompt-shortcuts';

const fixture = vi.hoisted(() => {
  const session = { status: 'authenticated', user: { id: 'user-a' } };
  const makePlatform = () => ({
    capabilities: new Set(['cloudAccount']),
    identity: { session: { get: () => session } },
  });
  return {
    session,
    auth: {
      authSessionId: 'session-a' as string | null,
      confirmedUnauthenticated: false,
      requestAuthRecovery: vi.fn(),
    },
    makePlatform,
    platform: makePlatform(),
    workspaceId: 'workspace-a',
    status: 'allowed' as 'allowed' | 'pending' | 'blocked',
    directory: [],
    createRepo: vi.fn(),
    openStore: vi.fn(),
    closeStore: vi.fn(),
    records: [] as unknown[],
  };
});

vi.mock('@/hooks/use-authenticated-convex', () => ({
  useOptionalAuthenticatedConvex: () => fixture.auth,
}));

vi.mock('jotai', async (original) => ({
  ...(await original<typeof import('jotai')>()),
  useAtomValue: () => ({ workspaceId: fixture.workspaceId }),
}));
vi.mock('@/hooks/use-workspace-feature', () => ({
  useLegacyWorkspaceQueryStatus: () => fixture.status,
  useLegacyWorkspaceQueriesEnabled: () => fixture.status === 'allowed',
  useAssertLegacyWorkspaceAccess: () => () => {
    if (fixture.status !== 'allowed') throw new Error('legacy admission pending');
  },
}));
vi.mock('@/atoms/runtime', () => ({ activeWorkspaceRuntimeAtom: 'workspace' }));
vi.mock('@/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: ({ enabled }: { enabled: boolean }) => ({
    enabled,
    workspaceId: fixture.workspaceId,
  }),
}));
vi.mock('@lody/platform/react', () => ({
  usePlatform: () => fixture.platform,
  usePlatformSession: () => fixture.session,
  useCloudMutation: () => vi.fn(),
  useCloudAction: () => vi.fn(),
  useCloudQuery: () => fixture.directory,
}));
vi.mock('@/lib/cloud-api-operations', () => ({ cloudOperations: { promptShortcuts: {} } }));
vi.mock('loro-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('loro-repo')>();
  return { ...actual, LoroRepo: { create: fixture.createRepo } };
});
vi.mock('loro-repo/storage/indexeddb', () => ({ IndexedDBStorageAdaptor: class {} }));
vi.mock('@lody/shared/prompt-shortcuts', async () => {
  const { PromptShortcutRuntime: ActualRuntime } =
    await import('../../shared/src/prompt-shortcuts/runtime');
  return {
    PromptShortcutRuntime: ActualRuntime,
    LocalShortcutStore: { open: fixture.openStore },
    PromptShortcutSync: class {
      async dispose() {}
    },
    shortcutByteLength: (value: string) => value.length,
  };
});

import {
  PromptShortcutProvider,
  usePromptShortcuts,
} from '../src/providers/prompt-shortcut-provider';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('PromptShortcutProvider lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: PromptShortcutRuntime | null;
  let rendered: (PromptShortcutRuntime | null)[];

  function Consumer() {
    const shortcuts = usePromptShortcuts();
    current = shortcuts.runtime;
    rendered.push(current);
    return createElement('p', null, shortcuts.loading ? 'loading' : current?.workspaceId);
  }

  async function render(enabled = true) {
    await act(async () => {
      root.render(
        <StrictMode>
          <PromptShortcutProvider enabled={enabled}>
            <Consumer />
          </PromptShortcutProvider>
        </StrictMode>
      );
    });
    // The provider defers its loro/streams stack behind dynamic imports, which
    // settle on the event loop rather than inside act's microtask drain.
    await act(async () => {
      await vi.dynamicImportSettled();
    });
  }

  beforeEach(() => {
    fixture.workspaceId = 'workspace-a';
    fixture.auth.authSessionId = 'session-a';
    fixture.auth.confirmedUnauthenticated = false;
    fixture.status = 'allowed';
    fixture.platform = fixture.makePlatform();
    fixture.records = [];
    fixture.closeStore.mockReset().mockResolvedValue(undefined);
    fixture.createRepo.mockReset().mockImplementation(async () => ({ destroy: async () => {} }));
    fixture.openStore.mockReset().mockImplementation(async (identity) => ({
      ...identity,
      discovery: () => ({ directory: [], entries: [] }),
      list: () => fixture.records,
      applyRemoteDeletions: async () => {},
      cacheDiscovery: async () => {},
      dispose: () => fixture.closeStore(),
    }));
    current = null;
    rendered = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['readiness', 'workspace'] as const)(
    'never resurrects a disposed runtime after %s returns to the same scope',
    async (transition) => {
      await render();
      const first = current!;
      expect(container.textContent).toBe('workspace-a');

      if (transition === 'workspace') fixture.workspaceId = 'workspace-b';
      await render(transition !== 'readiness');
      expect(() => first.setDirectory([])).toThrow('Shortcut runtime disposed');

      const opening = deferred();
      fixture.createRepo.mockImplementationOnce(async () => {
        await opening.promise;
        return { destroy: async () => {} };
      });
      fixture.workspaceId = 'workspace-a';
      rendered = [];
      await render();
      expect(current).toBeNull();
      expect(container.textContent).toBe('loading');
      expect(rendered).not.toContain(first);
      await act(async () => window.dispatchEvent(new Event('online')));

      await act(async () => opening.resolve());
      expect(current).not.toBeNull();
      expect(current).not.toBe(first);
      expect(container.textContent).toBe('workspace-a');
      await expect(current!.setDirectory([])).resolves.toBeUndefined();
    }
  );

  it('retires the previous auth-session runtime even when the same account signs in again', async () => {
    await render();
    const first = current!;
    fixture.auth.authSessionId = null;
    await render();
    expect(current).toBe(first);
    fixture.auth.authSessionId = 'session-b';
    rendered = [];
    await render();
    expect(rendered).not.toContain(first);
    expect(current).not.toBe(first);
    expect(() => first.setDirectory([])).toThrow('Shortcut runtime disposed');
    fixture.auth.confirmedUnauthenticated = true;
    await render();
    expect(current).toBeNull();
  });

  it('keeps the old runtime hidden until its durable close finishes', async () => {
    await render();
    const first = current!;
    const closing = deferred();
    fixture.closeStore.mockImplementationOnce(() => closing.promise);
    await render(false);
    rendered = [];
    await render();
    expect(current).toBeNull();
    expect(rendered).not.toContain(first);
    expect(container.textContent).toBe('loading');

    await act(async () => closing.resolve());
    expect(current).not.toBeNull();
    expect(current).not.toBe(first);
    expect(container.textContent).toBe('workspace-a');
  });
  it('retires cloud shortcuts while admission is pending or encrypted and reopens after ordinary admission', async () => {
    fixture.status = 'allowed';
    await render();
    expect(container.textContent).toBe('workspace-a');
    fixture.status = 'pending';
    await render();
    expect(current).toBeNull();
    expect(container.textContent).toBe('loading');
    fixture.status = 'blocked';
    await render();
    expect(current).toBeNull();
    fixture.status = 'allowed';
    await render();
    expect(current).not.toBeNull();
  });

  it('keeps the local shortcut store available without cloud admission', async () => {
    fixture.platform.capabilities.clear();
    fixture.status = 'pending';
    await render();
    expect(current?.workspaceId).toBe('workspace-a');
    expect(container.textContent).toBe('workspace-a');
  });
});

describe('Shortcut token attempt ownership', () => {
  const request: ShortcutTokenRequest = {
    workspaceId: 'ws',
    target: { kind: 'body', bodyDocId: 'body-a' },
    write: false,
  };
  const failure: ShortcutTokenReply = {
    ok: false,
    failure: { kind: 'retryable', code: 'exchange_unavailable', phase: 'exchange' },
  };
  const success: ShortcutTokenReply = {
    ok: true,
    grant: {
      token: 'synthetic-jwt',
      expiresIn: 900,
      gatewayBaseUrl: 'https://gateway.test',
      streamId: 'shortcut-body:body-a',
    },
  };
  function owner(attempt: (request: ShortcutTokenRequest) => Promise<ShortcutTokenReply>) {
    const reports: unknown[] = [];
    let recoveries = 0;
    const instance = new ShortcutTokenAttempts({
      attempt,
      legacy: async () => {
        if (!success.ok) throw new Error('fixture');
        return success.grant;
      },
      report: (value) => {
        reports.push(value);
      },
      authRejected: () => {
        recoveries++;
      },
      active: () => true,
    });
    return { instance, reports, recoveries: () => recoveries };
  }
  it('100 attempts retain one diagnostic and local count, success resets only that operation, and distinct faults remain visible', async () => {
    let reply = failure;
    const a = owner(async () => reply);
    for (let i = 0; i < 100; i++)
      await expect(a.instance.grant(request)).rejects.toBeInstanceOf(ShortcutTokenAttemptError);
    expect(a.reports).toEqual([failure.ok ? undefined : failure.failure]);
    expect(a.instance.counts()).toEqual([100]);
    await expect(
      a.instance.grant({ ...request, target: { kind: 'body', bodyDocId: 'body-b' } })
    ).rejects.toThrow();
    expect(a.reports).toHaveLength(2);
    reply = { ok: false, failure: { kind: 'fatal', code: 'exchange_invalid', phase: 'exchange' } };
    await expect(a.instance.grant(request)).rejects.toThrow();
    expect(a.reports).toHaveLength(3);
    reply = success;
    await expect(a.instance.grant(request)).resolves.toMatchObject({ token: 'synthetic-jwt' });
    reply = failure;
    await expect(a.instance.grant(request)).rejects.toThrow();
    expect(a.reports).toHaveLength(4);
    const b = owner(async () => failure);
    await expect(b.instance.grant(request)).rejects.toThrow();
    expect(b.reports).toHaveLength(1);
    a.instance.dispose();
    b.instance.dispose();
  });
  it('handled auth refusals keep the supervisor contract and do not generate diagnostics or replay', async () => {
    let calls = 0;
    const a = owner(async () => {
      calls++;
      return {
        ok: false,
        failure: { kind: 'denied', code: 'unauthenticated', phase: 'authorize' },
      };
    });
    for (let i = 0; i < 100; i++) {
      try {
        await a.instance.grant(request);
        throw new Error('unexpected success');
      } catch (error) {
        expect(isConvexUnauthenticatedError(error)).toBe(true);
      }
    }
    expect(calls).toBe(100);
    expect(a.reports).toEqual([]);
    expect(a.recoveries()).toBe(1);
    a.instance.dispose();
  });
  it('retirement fences late errors and late success cannot clear a newer completed failure', async () => {
    let release!: (reply: ShortcutTokenReply) => void;
    const a = owner(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = a.instance.grant(request);
    const rejected = expect(pending).rejects.toThrow();
    a.instance.dispose();
    release(failure);
    await rejected;
    expect(a.reports).toEqual([]);
    expect(a.instance.counts()).toEqual([]);
    let first!: (reply: ShortcutTokenReply) => void;
    let calls = 0;
    const b = owner(() =>
      ++calls === 1
        ? new Promise((resolve) => {
            first = resolve;
          })
        : Promise.resolve(failure)
    );
    const stale = b.instance.grant(request);
    await expect(b.instance.grant(request)).rejects.toThrow();
    first(success);
    await stale;
    await expect(b.instance.grant(request)).rejects.toThrow();
    expect(b.reports).toHaveLength(1);
    expect(b.instance.counts()).toEqual([2]);
    b.instance.dispose();
  });
  it('real Streams auth refresh retains the handled failure identity instead of creating another reportable error', async () => {
    const doc = new LoroDoc();
    let now = 0;
    let grants = 0;
    const failure = new ShortcutTokenAttemptError({
      kind: 'retryable',
      code: 'exchange_unavailable',
      phase: 'exchange',
    });
    const sync = new ActualShortcutSync({
      content: { mode: 'plaintext' },
      now: () => now,
      repo: {
        acquireDoc: async () => ({ doc, release: async () => {} }),
        persistDocNow: async () => {},
      } as unknown as LoroRepo,
      grant: async () => {
        if (++grants > 1) throw failure;
        return {
          token: 'synthetic',
          expiresIn: 900,
          gatewayBaseUrl: 'https://gateway.test',
          streamId: getShortcutBodyStreamId('body-a'),
        };
      },
    });
    const lease = await sync.acquire({ kind: 'body', bodyDocId: 'body-a' }, false);
    now = 900_000;
    try {
      await expect(lease.sync()).rejects.toBe(failure);
    } finally {
      await lease.release();
      await sync.dispose();
      doc.free();
    }
  });

  it('only an explicit missing V2 endpoint negotiates legacy; unknown platform failures retain their identity', async () => {
    let attempts = 0;
    let legacy = 0;
    const a = new ShortcutTokenAttempts({
      attempt: async () => {
        attempts++;
        throw new Error('Could not find public function for promptShortcuts:getStreamTokenV2');
      },
      legacy: async () => {
        legacy++;
        if (!success.ok) throw new Error('fixture');
        return success.grant;
      },
      active: () => true,
      authRejected: () => {},
      report: () => {
        throw new Error('unexpected report');
      },
    });
    await a.grant(request);
    await a.grant(request);
    expect(attempts).toBe(1);
    expect(legacy).toBe(2);
    a.dispose();
    const fault = new Error('synthetic platform failure');
    const b = owner(async () => {
      throw fault;
    });
    await expect(b.instance.grant(request)).rejects.toBe(fault);
    expect(b.reports).toEqual([]);
    b.instance.dispose();
  });
});
