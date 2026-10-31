/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLodyAuthClient, signOutWithoutRedirect } from '../src/lib/auth';

// Workspace navigation storage is unrelated to the auth transport boundary.
vi.mock('../src/lib/workspace', () => ({ clearPreferredWorkspaceSlug: () => {} }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function session(account: string) {
  return {
    user: {
      id: account,
      name: account,
      email: `${account}@example.test`,
      emailVerified: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    session: {
      id: `session-${account}`,
      userId: account,
      token: `token-${account}`,
      expiresAt: new Date('2099-01-01'),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  };
}
function organization(account: string) {
  return {
    id: `org-${account}`,
    name: account,
    slug: account,
    createdAt: new Date(0),
    members: [],
    invitations: [],
  };
}
function abortableResponse(promise: Promise<Response>, signal?: AbortSignal | null) {
  if (!signal) return promise;
  return new Promise<Response>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

describe('real Better Auth organization hook admission', () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: ReturnType<typeof createLodyAuthClient>;
  let currentSession: ReturnType<typeof session> | null;
  let pendingSession: Promise<Response> | undefined;
  let pendingSignOut: Promise<Response> | undefined;
  let pendingOrganizations: Map<string, Promise<Response>>;
  let requests: string[];
  let list: ReturnType<typeof client.useListOrganizations>;
  let active: ReturnType<typeof client.useActiveOrganization>;

  function Consumer() {
    list = client.useListOrganizations();
    active = client.useActiveOrganization();
    return <div>{JSON.stringify([list.data, active.data])}</div>;
  }
  const organizationRequests = () => requests.filter((path) => path.includes('/organization/'));
  const mount = async () => {
    await act(async () => {
      root.render(
        <>
          <Consumer />
          <Consumer />
        </>
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  const refreshSession = async () => {
    await act(async () => {
      await client.$store.atoms.session.get().refetch();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    currentSession = null;
    pendingSession = undefined;
    pendingSignOut = undefined;
    pendingOrganizations = new Map();
    requests = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        'https://auth.example.test'
      ).pathname;
      requests.push(path);
      if (path.endsWith('/get-session'))
        return pendingSession
          ? abortableResponse(pendingSession, init?.signal)
          : json(currentSession);
      if (path.endsWith('/sign-in/email'))
        return new Response(
          JSON.stringify({
            user: currentSession?.user,
            token: currentSession?.session.token,
            redirect: false,
          }),
          {
            headers: {
              'content-type': 'application/json',
              'set-better-auth-cookie': 'better-auth.session_token=synthetic-session; Path=/',
            },
          }
        );
      if (path.endsWith('/sign-out')) {
        if (pendingSignOut) return pendingSignOut;
        currentSession = null;
        return json({ success: true });
      }
      if (path.includes('/organization/')) {
        const pending = pendingOrganizations.get(path);
        if (pending) return pending;
        if (!currentSession)
          return new Response(JSON.stringify({ code: 'UNAUTHORIZED' }), { status: 401 });
        const org = organization(currentSession.user.id);
        return json(path.endsWith('/list') ? [org] : org);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    client = createLodyAuthClient({ disableDefaultFetchPlugins: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends zero organization requests during anonymous mount and pending login, then loads after authentication', async () => {
    await mount();
    expect(organizationRequests()).toEqual([]);
    expect(list.data).toBeNull();
    expect(active.data).toBeNull();
    const waiting = deferred<Response>();
    pendingSession = waiting.promise;
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = client.$store.atoms.session.get().refetch();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(organizationRequests()).toEqual([]);
    currentSession = session('alice');
    pendingSession = undefined;
    await act(async () => {
      waiting.resolve(json(currentSession));
      await refresh;
    });
    expect(organizationRequests().sort()).toEqual([
      '/api/auth/organization/get-full-organization',
      '/api/auth/organization/list',
    ]);
    expect(list.data?.[0]?.id).toBe('org-alice');
    expect(active.data?.id).toBe('org-alice');
  });

  it('clears at logout intent, rejects retained refetches and ignores responses arriving after logout', async () => {
    currentSession = session('alice');
    await mount();
    const lateList = deferred<Response>();
    const lateActive = deferred<Response>();
    pendingOrganizations.set('/api/auth/organization/list', lateList.promise);
    pendingOrganizations.set('/api/auth/organization/get-full-organization', lateActive.promise);
    let refetch!: Promise<unknown>;
    await act(async () => {
      refetch = Promise.all([list.refetch(), active.refetch()]);
    });
    await act(async () => {
      await signOutWithoutRedirect(client);
    });
    expect(list.data).toBeNull();
    expect(active.data).toBeNull();
    const before = [...organizationRequests()];
    await act(async () => {
      await Promise.all([list.refetch(), active.refetch()]);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(organizationRequests()).toEqual(before);
    await act(async () => {
      lateList.resolve(json([organization('alice')]));
      lateActive.resolve(json(organization('alice')));
      await refetch;
    });
    expect(list.data).toBeNull();
    expect(active.data).toBeNull();
  });

  it('loads the new account without joining old requests and rejects late old successes and errors', async () => {
    currentSession = session('alice');
    await mount();
    const lateList = deferred<Response>();
    const lateActive = deferred<Response>();
    pendingOrganizations.set('/api/auth/organization/list', lateList.promise);
    pendingOrganizations.set('/api/auth/organization/get-full-organization', lateActive.promise);
    let oldRefresh!: Promise<unknown>;
    await act(async () => {
      oldRefresh = Promise.all([list.refetch(), active.refetch()]);
    });
    pendingOrganizations.clear();
    currentSession = session('bob');
    await refreshSession();
    expect(list.data?.[0]?.id).toBe('org-bob');
    expect(active.data?.id).toBe('org-bob');
    await act(async () => {
      lateList.resolve(json([organization('alice')]));
      lateActive.resolve(new Response(JSON.stringify({ code: 'UNAUTHORIZED' }), { status: 401 }));
      await oldRefresh;
    });
    expect(list.data?.[0]?.id).toBe('org-bob');
    expect(active.data?.id).toBe('org-bob');
    expect(active.error).toBeNull();
  });

  it('holds logout even when its old session was still unknown at logout intent, then admits a new login', async () => {
    const oldSession = deferred<Response>();
    const signOutResponse = deferred<Response>();
    pendingSession = oldSession.promise;
    pendingSignOut = signOutResponse.promise;
    await mount();
    let logout!: ReturnType<typeof signOutWithoutRedirect>;
    await act(async () => {
      logout = signOutWithoutRedirect(client);
    });
    await act(async () => {
      oldSession.resolve(json(session('alice')));
    });
    expect(organizationRequests()).toEqual([]);
    expect(list.data).toBeNull();
    expect(active.data).toBeNull();
    pendingSession = undefined;
    await act(async () => {
      signOutResponse.resolve(json({ success: true }));
      await logout;
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(organizationRequests()).toEqual([]);
    currentSession = session('bob');
    await refreshSession();
    expect(list.data?.[0]?.id).toBe('org-bob');
    expect(active.data?.id).toBe('org-bob');
  });

  it('does not reopen when sign-out finishes before the pre-logout session response', async () => {
    currentSession = session('alice');
    await mount();
    const before = [...organizationRequests()];
    const oldSession = deferred<Response>();
    pendingSession = oldSession.promise;
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = client.$store.atoms.session.get().refetch();
    });
    pendingSession = undefined;
    await act(async () => {
      await client.signOut();
    });
    await act(async () => {
      oldSession.resolve(json(session('alice')));
      await refresh;
    });
    expect(organizationRequests()).toEqual(before);
    expect(list.data).toBeNull();
    expect(active.data).toBeNull();
    currentSession = session('bob');
    await refreshSession();
    expect(active.data?.id).toBe('org-bob');
  });

  it('keeps a new logout intent closed while the next account is still signing in', async () => {
    currentSession = session('alice');
    await mount();
    await act(async () => {
      await client.signOut();
      await vi.advanceTimersByTimeAsync(10);
    });
    const before = [...organizationRequests()];
    const nextSession = deferred<Response>();
    pendingSession = nextSession.promise;
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = client.$store.atoms.session.get().refetch();
    });
    const logoutResponse = deferred<Response>();
    pendingSignOut = logoutResponse.promise;
    let logout!: ReturnType<typeof client.signOut>;
    await act(async () => {
      logout = client.signOut();
    });
    await act(async () => {
      nextSession.resolve(json(session('bob')));
      await refresh;
    });
    expect(organizationRequests()).toEqual(before);
    pendingSession = undefined;
    currentSession = session('bob');
    await act(async () => {
      logoutResponse.resolve(new Response(JSON.stringify({ code: 'FAILED' }), { status: 503 }));
      await logout;
    });
    expect(organizationRequests()).toEqual(before);
    expect(list.data).toBeNull();
    expect(active.data).toBeNull();
  });

  it('refreshes again after remount when an obsolete organization read is still pending', async () => {
    currentSession = session('alice');
    await mount();
    const oldList = deferred<Response>();
    const oldActive = deferred<Response>();
    pendingOrganizations.set('/api/auth/organization/list', oldList.promise);
    pendingOrganizations.set('/api/auth/organization/get-full-organization', oldActive.promise);
    let oldRefresh!: Promise<unknown>;
    await act(async () => {
      oldRefresh = Promise.all([list.refetch(), active.refetch()]);
    });
    await act(async () => {
      root.render(null);
    });
    pendingOrganizations.set(
      '/api/auth/organization/list',
      Promise.resolve(json([organization('new')]))
    );
    pendingOrganizations.set(
      '/api/auth/organization/get-full-organization',
      Promise.resolve(json(organization('new')))
    );
    await mount();
    await act(async () => {
      oldList.resolve(json([organization('old')]));
      oldActive.resolve(json(organization('old')));
      await oldRefresh;
    });
    expect(list.data?.[0]?.id).toBe('org-new');
    expect(active.data?.id).toBe('org-new');
  });

  it('does not let a retained session error bypass logout', async () => {
    currentSession = session('alice');
    await mount();
    pendingSession = Promise.resolve(
      new Response(JSON.stringify({ code: 'UNAVAILABLE' }), { status: 503 })
    );
    await refreshSession();
    expect(client.$store.atoms.session.get().data?.user.id).toBe('alice');
    expect(client.$store.atoms.session.get().error?.status).toBe(503);
    const before = [...organizationRequests()];
    const oldSession = deferred<Response>();
    pendingSession = oldSession.promise;
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = client.$store.atoms.session.get().refetch();
    });
    pendingSession = undefined;
    await act(async () => {
      await client.signOut();
      oldSession.resolve(json(session('alice')));
      await refresh;
    });
    expect(organizationRequests()).toEqual(before);
    expect(active.data).toBeNull();
  });

  it('recovers a new explicit login when anonymous verification failed with the old owner unknown', async () => {
    const oldSession = deferred<Response>();
    pendingSession = oldSession.promise;
    await mount();
    pendingSession = Promise.resolve(
      new Response(JSON.stringify({ code: 'UNAVAILABLE' }), { status: 503 })
    );
    await act(async () => {
      await client.signOut();
    });
    expect(organizationRequests()).toEqual([]);
    pendingSession = undefined;
    currentSession = session('bob');
    await act(async () => {
      await client.signIn.email({ email: 'bob@example.test', password: 'synthetic-password' });
    });
    expect(list.data?.[0]?.id).toBe('org-bob');
    expect(active.data?.id).toBe('org-bob');
  });

  it('follows a logout verification replaced by the SDK delayed signal', async () => {
    const oldSession = deferred<Response>();
    pendingSession = oldSession.promise;
    await mount();
    const verification = deferred<Response>();
    pendingSession = verification.promise;
    await act(async () => {
      await client.signOut();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(organizationRequests()).toEqual([]);
    await act(async () => {
      verification.resolve(json(null));
    });
    pendingSession = undefined;
    currentSession = session('bob');
    await refreshSession();
    expect(list.data?.[0]?.id).toBe('org-bob');
    expect(active.data?.id).toBe('org-bob');
  });

  it('keeps existing data visible when a session check interrupts an organization refetch', async () => {
    currentSession = session('alice');
    await mount();
    const oldList = deferred<Response>();
    const oldActive = deferred<Response>();
    pendingOrganizations.set('/api/auth/organization/list', oldList.promise);
    pendingOrganizations.set('/api/auth/organization/get-full-organization', oldActive.promise);
    let oldRefresh!: Promise<unknown>;
    await act(async () => {
      oldRefresh = Promise.all([list.refetch(), active.refetch()]);
    });
    const checking = deferred<Response>();
    pendingSession = checking.promise;
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = client.$store.atoms.session.get().refetch();
    });
    expect(list.data?.[0]?.id).toBe('org-alice');
    expect(active.data?.id).toBe('org-alice');
    expect(list.isPending).toBe(false);
    expect(active.isPending).toBe(false);
    pendingOrganizations.clear();
    await act(async () => {
      checking.resolve(json(currentSession));
      await refresh;
    });
    await act(async () => {
      oldList.resolve(json([organization('stale')]));
      oldActive.resolve(json(organization('stale')));
      await oldRefresh;
    });
    expect(list.data?.[0]?.id).toBe('org-alice');
    expect(active.data?.id).toBe('org-alice');
  });

  it('pauses requests during same-account verification without clearing the workspace or reloading it', async () => {
    currentSession = session('alice');
    await mount();
    const before = [...organizationRequests()];
    const checking = deferred<Response>();
    pendingSession = checking.promise;
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = client.$store.atoms.session.get().refetch();
    });
    await act(async () => {
      await Promise.all([list.refetch(), active.refetch()]);
    });
    expect(organizationRequests()).toEqual(before);
    expect(list.data?.[0]?.id).toBe('org-alice');
    expect(active.data?.id).toBe('org-alice');
    expect(list.isPending).toBe(false);
    await act(async () => {
      checking.resolve(json(currentSession));
      await refresh;
    });
    expect(organizationRequests()).toEqual(before);
    expect(active.data?.id).toBe('org-alice');
  });

  it('fences the credential-switch window while a new session is being verified', async () => {
    currentSession = session('alice');
    await mount();
    const before = [...organizationRequests()];
    const checking = deferred<Response>();
    pendingSession = checking.promise;
    currentSession = session('bob');
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = client.$store.atoms.session.get().refetch();
    });
    await act(async () => {
      await Promise.all([list.refetch(), active.refetch()]);
    });
    expect(organizationRequests()).toEqual(before);
    expect(active.data?.id).toBe('org-alice');
    await act(async () => {
      checking.resolve(json(currentSession));
      await refresh;
    });
    expect(list.data?.[0]?.id).toBe('org-bob');
    expect(active.data?.id).toBe('org-bob');
  });

  it('refreshes after remount and preserves ordinary Better Auth mutation invalidation', async () => {
    currentSession = session('alice');
    await mount();
    await act(async () => {
      root.render(null);
    });
    pendingOrganizations.set(
      '/api/auth/organization/list',
      Promise.resolve(json([organization('renamed')]))
    );
    pendingOrganizations.set(
      '/api/auth/organization/get-full-organization',
      Promise.resolve(json(organization('renamed')))
    );
    await act(async () => {
      client.$store.notify('$listOrg');
      client.$store.notify('$activeOrgSignal');
    });
    await mount();
    expect(list.data?.[0]?.id).toBe('org-renamed');
    expect(active.data?.id).toBe('org-renamed');
    expect(organizationRequests()).toHaveLength(4);
    pendingOrganizations.clear();
    await act(async () => {
      await client.organization.create({ name: 'New workspace', slug: 'new-workspace' });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(list.data?.[0]?.id).toBe('org-alice');
    expect(active.data?.id).toBe('org-alice');
  });

  it('refuses mismatched account/session identity', async () => {
    currentSession = session('alice');
    currentSession.session.userId = 'bob';
    await mount();
    expect(organizationRequests()).toEqual([]);
    expect(list.data).toBeNull();
    expect(active.data).toBeNull();
  });
});
