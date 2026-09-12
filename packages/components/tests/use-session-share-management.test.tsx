// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionShareManagement } from '@lody/cloud-api';
import type { WorkspaceId } from '@lody/shared';

const cloud = vi.hoisted(() => ({
  state: undefined as SessionShareManagement | undefined,
  enabled: true,
  mutation: vi.fn(),
  verification: vi.fn().mockResolvedValue({ retryAt: 60_000 }),
  queryArgs: undefined as unknown,
}));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: (_op: unknown, args: unknown) => {
    cloud.queryArgs = args;
    return args === 'skip' ? undefined : cloud.state;
  },
  useCloudMutation: (op: { name: string }) => (args: unknown) =>
    op.name === 'sessionSharing:requestVerification'
      ? cloud.verification(args)
      : cloud.mutation(op.name, args),
}));
vi.mock('../src/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: () => ({ workspaceId: 'workspace', enabled: cloud.enabled }),
}));
vi.mock('../src/atoms', async () => ({
  userAtom: (await import('jotai')).atom<{ id: string } | null>({ id: 'alice' }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('@lody/shared/session-sharing', async (original) => ({
  ...(await original<object>()),
  createSessionShareSecret: () => 'a'.repeat(64),
  hashSessionShareSecret: async () => 'b'.repeat(64),
}));
import { userAtom } from '../src/atoms';
import { useSessionShareManagement } from '../src/hooks/use-session-share-management';
import {
  readSessionShareSecret,
  saveSessionShareSecret,
  sessionShareSecretKey,
} from '../src/lib/session-share-secrets';
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const entry = {
  title: 'Root',
  shareId: 'share',
  rootSessionId: 'root',
  authorUserId: 'alice',
  status: 'active' as const,
  scopeVersion: 1,
  credentialVersion: 1,
  sessionIds: ['root'],
  readableSessionIds: ['root'],
  validUntil: 200,
  canManage: true,
  canRevoke: true,
};
const key = sessionShareSecretKey('alice', 'workspace', 'share');
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('share management client lifecycle', () => {
  let root: Root | null;
  let container: HTMLDivElement;
  let store: ReturnType<typeof createStore>;
  let control: ReturnType<typeof useSessionShareManagement>;
  function Harness() {
    control = useSessionShareManagement('workspace' as WorkspaceId, 'root', ['root', 'child']);
    return null;
  }
  const render = () =>
    act(async () =>
      root?.render(
        <Provider store={store}>
          <Harness />
        </Provider>
      )
    );
  beforeEach(() => {
    cloud.verification.mockClear();
    vi.stubEnv('VITE_SESSION_SHARE_ORIGIN', 'https://share-staging.example.test');
    vi.useFakeTimers();
    vi.setSystemTime(100);
    localStorage.clear();
    store = createStore();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    cloud.state = {
      root: null,
      sources: [],
      candidates: [{ sessionId: 'root', title: 'Root', available: true, validUntil: 200 }],
    };
    cloud.enabled = true;
    cloud.mutation.mockReset();
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('copies the configured share origin with the locally stored secret only in the fragment', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    cloud.state = { ...cloud.state!, root: entry, sources: [entry] };
    saveSessionShareSecret(localStorage, key, { credentialVersion: 1, secret: 'a'.repeat(64) });
    await render();
    await act(async () => {
      control.onCopy(entry);
    });
    expect(writeText).toHaveBeenCalledWith(
      `https://share-staging.example.test/s/share#access=v1.${'a'.repeat(64)}`
    );
  });

  it('persists only the successful credential and submits no raw secret; double clicks do not issue twice', async () => {
    const started = deferred<void>();
    const result = deferred<typeof entry>();
    cloud.mutation.mockImplementation(() => {
      started.resolve();
      return result.promise;
    });
    await render();
    await act(async () => {
      control.onCreate();
      control.onCreate();
      await started.promise;
    });
    expect(control!.busy).toBe(true);
    expect(localStorage.getItem(key)).toBeNull();
    expect(cloud.mutation).toHaveBeenCalledExactlyOnceWith('sessionSharing:create', {
      workspaceId: 'workspace',
      rootSessionId: 'root',
      sessionIds: ['root'],
      credentialHash: 'b'.repeat(64),
    });
    await act(async () => {
      cloud.state = { ...cloud.state!, root: entry, sources: [entry] };
      result.resolve(entry);
      await result.promise;
    });
    expect(readSessionShareSecret(localStorage, key, 1)).toBe('a'.repeat(64));
    expect(control!.copyableShareIds).toEqual(['share']);
  });

  it('does not retain a failed create credential or echo a provider error containing it', async () => {
    cloud.mutation.mockRejectedValue(new Error('a'.repeat(64)));
    await render();
    await act(async () => {
      control.onCreate();
    });
    expect(localStorage.getItem(key)).toBeNull();
    expect(control!.error).toBe(
      'Could not update sharing. Check the current settings and try again.'
    );
  });

  it('keeps an edited selection while a concurrent reset forces a reload, and rejects the old local secret', async () => {
    cloud.state = { ...cloud.state!, root: entry, sources: [entry] };
    saveSessionShareSecret(localStorage, key, { credentialVersion: 1, secret: 'a'.repeat(64) });
    await render();
    await act(async () => {
      control.onSelect(['root', 'child']);
    });
    cloud.state = {
      ...cloud.state,
      root: { ...entry, credentialVersion: 2 },
      sources: [{ ...entry, credentialVersion: 2 }],
    };
    await render();
    expect(control!.conflict).toBe(true);
    expect(control!.selected).toEqual(['root', 'child']);
    expect(control!.copyableShareIds).toEqual([]);
    await act(async () => {
      control.onSave();
    });
    expect(cloud.mutation).not.toHaveBeenCalled();
    await act(async () => {
      control.onReload();
    });
    expect(control!.selected).toEqual(['root']);
  });

  it('does not write credentials back after an account switch during creation', async () => {
    const started = deferred<void>();
    const result = deferred<typeof entry>();
    cloud.mutation.mockImplementation(() => {
      started.resolve();
      return result.promise;
    });
    await render();
    await act(async () => {
      control.onCreate();
      await started.promise;
    });
    await act(async () => {
      store.set(userAtom, null);
    });
    await act(async () => {
      result.resolve(entry);
      await result.promise;
    });
    expect(localStorage.getItem(key)).toBeNull();
    expect(cloud.queryArgs).toBe('skip');
  });

  it('updates the lease clock without a query change and skips queries when the workspace scope is unresolved', async () => {
    await render();
    await act(async () => {
      vi.advanceTimersByTime(101);
    });
    expect(control!.now).toBe(201);
    // The expired lease timer is gone; one discovery retry remains.
    expect(vi.getTimerCount()).toBe(1);
    cloud.enabled = false;
    await render();
    expect(cloud.queryArgs).toBe('skip');
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      control.onCreate();
    });
    expect(cloud.mutation).not.toHaveBeenCalled();
  });
  it('requests verified sources only while mounted in the authenticated workspace', async () => {
    await render();
    expect(cloud.verification).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      sessionIds: ['root', 'child'],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(cloud.verification).toHaveBeenCalledTimes(2);
    await act(async () => {
      root?.unmount();
      root = null;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(cloud.verification).toHaveBeenCalledTimes(2);
  });
});
