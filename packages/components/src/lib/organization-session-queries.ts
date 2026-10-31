import { useSyncExternalStore } from 'react';
import type { AuthQueryAtom } from 'better-auth/client';
import type { LodyAuthClient } from './auth';

type OrganizationQuery<Data> = {
  data: Data | null;
  error: unknown;
  isPending: boolean;
  isRefetching: boolean;
  refetch: () => Promise<void>;
};

/** Keep Better Auth's transport and mutation signals, but own admission and
 * result publication for its two automatically mounted organization queries. */
export function withSessionGatedOrganizationQueries(
  client: LodyAuthClient,
  subscribeLogout: (listener: () => void) => () => void
): LodyAuthClient {
  // Better Auth's public store erases the type of its built-in session atom.
  const session: AuthQueryAtom<NonNullable<ReturnType<LodyAuthClient['useSession']>['data']>> =
    client.$store.atoms.session;
  const refetchSession = session.value.refetch;
  const readSession = () => {
    const { data, error, isPending, isRefetching } = session.get();
    const userId = data?.user?.id;
    const sessionId = data?.session?.id;
    const sessionUserId = data?.session?.userId;
    const key =
      typeof userId === 'string' &&
      userId.length > 0 &&
      typeof sessionId === 'string' &&
      sessionId.length > 0 &&
      typeof sessionUserId === 'string' &&
      sessionUserId.length > 0 &&
      sessionUserId === userId
        ? JSON.stringify([userId, sessionId])
        : null;
    return {
      key,
      accountId: key === null ? null : userId,
      checking: Boolean(isRefetching),
      ready: !isPending && !isRefetching && error === null,
    };
  };
  let loggedOut = false;
  let blockedOwner: string | null = null;
  let verifiedAnonymous = false;
  let expectedLoginAccountId: string | null = null;
  let logoutRevision = 0;
  let verifyAfterLogout = false;
  let observedLogoutCheck = false;
  let logoutObservers = 0;
  let stopLogout: (() => void) | undefined;
  let signOutPending = 0;

  function createQuery<Data>(
    fetcher: () => Promise<{ data: Data | null; error: unknown }>,
    signal: '$listOrg' | '$activeOrgSignal'
  ) {
    let owner: string | null = null;
    let admitted = false;
    let revision = 0;
    let loaded = false;
    let inFlight: Promise<void> | null = null;
    let refreshAfterPending = false;
    let cleanup: (() => void) | undefined;
    const listeners = new Set<() => void>();
    const empty = (): OrganizationQuery<Data> => ({
      data: null,
      error: null,
      isPending: false,
      isRefetching: false,
      refetch: async () => {},
    });
    let snapshot = empty();
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const synchronize = () => {
      const live = readSession();
      if (loggedOut) {
        if (verifyAfterLogout && live.checking) observedLogoutCheck = true;
        if (observedLogoutCheck && live.ready && live.key === null) verifiedAnonymous = true;
        // A session resolving for the first time after logout intent is still
        // the old login, not proof that another sign-in completed.
        if (live.key !== null && blockedOwner === null && !verifiedAnonymous)
          blockedOwner = live.key;
        if (
          signOutPending === 0 &&
          live.ready &&
          live.key !== null &&
          (expectedLoginAccountId === null || live.accountId === expectedLoginAccountId) &&
          (blockedOwner !== null ? live.key !== blockedOwner : verifiedAnonymous)
        )
          loggedOut = false;
      }
      const nextOwner = loggedOut ? null : live.key;
      const nextAdmitted = nextOwner !== null && live.ready;
      if (owner === nextOwner && admitted === nextAdmitted) return;
      const changedOwner = owner !== nextOwner;
      if (changedOwner || inFlight) loaded = false;
      owner = nextOwner;
      admitted = nextAdmitted;
      revision++;
      inFlight = null;
      refreshAfterPending = false;
      const expectedRevision = revision;
      // An ordinary same-account session check pauses requests without taking
      // the workspace away. An identity change or logout clears it immediately.
      snapshot = {
        ...(changedOwner ? empty() : snapshot),
        isPending: nextOwner !== null && (changedOwner || snapshot.data === null),
        isRefetching: false,
        refetch: () => run(expectedRevision),
      };
    };
    async function run(expectedRevision: number): Promise<void> {
      synchronize();
      if (!admitted || expectedRevision !== revision) return;
      if (inFlight) return inFlight;
      const requestRevision = revision;
      snapshot = {
        ...snapshot,
        error: null,
        isPending: snapshot.data === null,
        isRefetching: true,
      };
      notify();
      const currentRun = (async () => {
        try {
          const response = await fetcher();
          synchronize();
          if (requestRevision !== revision) return;
          loaded = true;
          const unauthorized =
            typeof response.error === 'object' &&
            response.error !== null &&
            'status' in response.error &&
            response.error.status === 401;
          snapshot = {
            ...snapshot,
            data: unauthorized ? null : response.error !== null ? snapshot.data : response.data,
            error: response.error,
            isPending: false,
            isRefetching: false,
          };
        } catch (error) {
          synchronize();
          if (requestRevision !== revision) return;
          loaded = true;
          snapshot = { ...snapshot, error, isPending: false, isRefetching: false };
        } finally {
          if (requestRevision === revision) {
            inFlight = null;
            notify();
            if (refreshAfterPending && listeners.size) {
              refreshAfterPending = false;
              void run(revision);
            }
          }
        }
      })();
      inFlight = currentRun;
      return currentRun;
    }
    const refresh = () => {
      synchronize();
      if (admitted && !loaded && !inFlight) void run(revision);
      notify();
    };
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        loaded = false;
        if (inFlight) refreshAfterPending = true;
        const stopSession = session.listen(refresh);
        const stopSignal = client.$store.atoms[signal].listen(() => {
          synchronize();
          loaded = false;
          if (inFlight) refreshAfterPending = true;
          else void run(revision);
        });
        if (logoutObservers++ === 0) stopLogout = subscribeLogout(retire);
        cleanup = () => {
          stopSession();
          stopSignal();
          if (--logoutObservers === 0) {
            stopLogout?.();
            stopLogout = undefined;
          }
        };
      }
      refresh();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          cleanup?.();
          cleanup = undefined;
        }
      };
    };
    const getSnapshot = () => {
      synchronize();
      return snapshot;
    };
    return {
      useQuery: () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
      refresh,
    };
  }

  const list = createQuery(
    () => client.organization.list({ fetchOptions: { disableSignal: true } }),
    '$listOrg'
  );
  const active = createQuery(
    () => client.organization.getFullOrganization({ fetchOptions: { disableSignal: true } }),
    '$activeOrgSignal'
  );
  function retire() {
    logoutRevision++;
    loggedOut = true;
    blockedOwner = readSession().key;
    verifiedAnonymous = false;
    expectedLoginAccountId = null;
    verifyAfterLogout = false;
    observedLogoutCheck = false;
    list.refresh();
    active.refresh();
  }
  const signOut = async (...args: Parameters<LodyAuthClient['signOut']>) => {
    signOutPending++;
    retire();
    const attempt = logoutRevision;
    try {
      return await client.signOut(...args);
    } finally {
      // Better Auth's cross-domain plugin writes an optimistic null at sign-out
      // start. Only a fresh server check may confirm absence. refetch cancels
      // the pre-logout session request, whose late response cannot reopen reads.
      signOutPending--;
      if (attempt === logoutRevision) verifyAfterLogout = true;
      // Follow the atom's checking -> settled transition: the SDK can replace
      // this request when its delayed sign-out signal arrives.
      void refetchSession().catch(() => {});
      list.refresh();
      active.refresh();
    }
  };
  const signInEmail = async (...args: Parameters<LodyAuthClient['signIn']['email']>) => {
    const attempt = logoutRevision;
    const ownerBeforeSignIn = blockedOwner;
    const response = await client.signIn.email(...args);
    if (!response.error && response.data?.user && attempt === logoutRevision && loggedOut) {
      // A successful explicit login can recover even if anonymous verification
      // failed. Cancel older session reads before admitting its resolved owner.
      blockedOwner = ownerBeforeSignIn;
      expectedLoginAccountId = response.data.user.id;
      verifiedAnonymous = true;
      void refetchSession().catch(() => {});
    }
    return response;
  };
  const signIn = new Proxy(client.signIn, {
    get(target, key, receiver): unknown {
      return key === 'email' ? signInEmail : Reflect.get(target, key, receiver);
    },
  });
  return new Proxy(client, {
    get(target, key, receiver): unknown {
      if (key === 'useListOrganizations') return list.useQuery;
      if (key === 'useActiveOrganization') return active.useQuery;
      if (key === 'signOut') return signOut;
      if (key === 'signIn') return signIn;
      return Reflect.get(target, key, receiver);
    },
  });
}
