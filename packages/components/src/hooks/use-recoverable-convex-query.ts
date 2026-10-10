import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import * as ConvexReact from 'convex/react';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { ConvexError, convexToJson, type Value } from 'convex/values';
import { isConvexUnauthenticatedError } from '@lody/shared';
import { useAuthenticatedConvex } from './use-authenticated-convex';

type QuerySnapshot = {
  authSessionId: string | null;
  queryKey: string;
  value: unknown;
};

const QUERY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const QUERY_HEALTHY_RESET_MS = 30_000;

// Structured application/permission errors need their own handling. An opaque
// server failure may be transient, but the client cannot infer its cause.
function isRetryableQueryError(error: Error): boolean {
  return (
    !(error instanceof ConvexError) &&
    /^\[CONVEX Q\([^\n]+\)\](?: \[Request ID: [^\]]+\])? Server Error(?:\n|$)/.test(error.message)
  );
}

type QuerySource = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => unknown;
  canRetainSnapshot: () => boolean;
  retain: () => () => void;
};

const querySources = new WeakMap<ConvexReact.ConvexReactClient, Map<string, QuerySource>>();
const getSkippedSnapshot = () => undefined;
const subscribeSkipped = () => () => {};

/** One watch and retry budget per client/session/query, shared by all consumers.
 * Dropping just one hook's subscription cannot retry a query that other hooks
 * still watch: Convex deduplicates those subscriptions and retains the error. */
function getQuerySource(
  client: ConvexReact.ConvexReactClient,
  key: string,
  query: FunctionReference<'query'>,
  args: Record<string, Value>
): QuerySource {
  let sources = querySources.get(client);
  if (!sources) {
    sources = new Map();
    querySources.set(client, sources);
  }
  const existing = sources.get(key);
  if (existing) return existing;

  const registry = sources;
  const listeners = new Set<() => void>();
  let result: unknown;
  // Preserve useQuery's synchronous cache hit on the first render. Errors are
  // classified after subscribing, where retry scheduling is safe.
  try {
    result = client.watchQuery(query, args).localQueryResult();
  } catch {
    result = undefined;
  }
  let unsubscribe: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let healthyTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let pendingRetryDelay: number | undefined;
  let generation = 0;
  let owners = 0;
  let serverFailure = false;
  let awaitingFreshResult = false;

  function publish(value: unknown) {
    if (Object.is(result, value)) return;
    result = value;
    for (const listener of listeners) listener();
  }

  function stopWatch() {
    generation += 1;
    unsubscribe?.();
    unsubscribe = undefined;
  }

  function scheduleRetry() {
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      pendingRetryDelay = undefined;
      startWatch(true);
    }, pendingRetryDelay);
  }

  function startWatch(waitForUpdate: boolean) {
    awaitingFreshResult = waitForUpdate;
    const watchGeneration = ++generation;
    const watch = client.watchQuery(query, args);
    const read = () => {
      if (watchGeneration !== generation) return;
      let value: unknown;
      try {
        value = watch.localQueryResult();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        value = error;
      }
      if (value !== undefined) awaitingFreshResult = false;

      if (value === undefined || value instanceof Error) {
        clearTimeout(healthyTimer);
        healthyTimer = undefined;
      }
      if (value instanceof Error) {
        if (isRetryableQueryError(value) && attempts < QUERY_RETRY_DELAYS_MS.length) {
          serverFailure = true;
          pendingRetryDelay = QUERY_RETRY_DELAYS_MS[attempts++];
          stopWatch();
          // Do not reuse stale authorization rows after a server failure.
          publish(undefined);
          scheduleRetry();
          return;
        }
      } else if (value !== undefined && attempts > 0 && healthyTimer === undefined) {
        healthyTimer = setTimeout(() => {
          healthyTimer = undefined;
          attempts = 0;
        }, QUERY_HEALTHY_RESET_MS);
      }
      if (value !== undefined && !(value instanceof Error)) serverFailure = false;
      publish(value);
    };
    unsubscribe = watch.onUpdate(read);
    // After a retry, the SDK can still hold the previous failed result until
    // the server acknowledges removal. Only a fresh update settles the retry.
    if (!waitForUpdate) read();
  }

  const source: QuerySource = {
    getSnapshot: () => result,
    canRetainSnapshot: () => !serverFailure,
    retain: () => {
      owners += 1;
      registry.set(key, source);
      return () => {
        owners -= 1;
        releaseIfUnused();
      };
    },
    subscribe: (listener) => {
      registry.set(key, source);
      listeners.add(listener);
      if (listeners.size === 1) {
        if (pendingRetryDelay !== undefined) scheduleRetry();
        else startWatch(awaitingFreshResult);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stopWatch();
        clearTimeout(retryTimer);
        clearTimeout(healthyTimer);
        retryTimer = healthyTimer = undefined;
        // Keep Strict Mode's immediate re-subscription on the same source.
        releaseIfUnused();
      };
    },
  };
  function releaseIfUnused() {
    queueMicrotask(() => {
      if (owners === 0 && listeners.size === 0 && registry.get(key) === source) {
        registry.delete(key);
      }
    });
  }
  registry.set(key, source);
  return source;
}

/**
 * A retained snapshot may only be reused for the same Better Auth session and the
 * same query. Check the snapshot itself first: `snapshot?.authSessionId` is
 * `undefined` when there is no snapshot, which would wrongly compare equal to an
 * absent `authSessionId` and then dereference null.
 */
function matchesSnapshot(
  snapshot: QuerySnapshot | null,
  authSessionId: string | null,
  queryKey: string
): snapshot is QuerySnapshot {
  return (
    snapshot !== null && snapshot.authSessionId === authSessionId && snapshot.queryKey === queryKey
  );
}

/**
 * Recover auth expiry through the central supervisor and retry opaque server
 * failures before they reach a render boundary. Other failures still throw.
 */
export function useRecoverableConvexQuery<Query extends FunctionReference<'query'>>(
  query: Query,
  ...args: ConvexReact.OptionalRestArgsOrSkip<Query>
): Query['_returnType'] | undefined {
  const { authSessionId, confirmedUnauthenticated, isAuthenticated, requestAuthRecovery } =
    useAuthenticatedConvex();
  const client = ConvexReact.useConvex();
  const callerSkipped = args[0] === 'skip';
  const skip = callerSkipped || !isAuthenticated;
  const argsObject = (args[0] === undefined || callerSkipped ? {} : args[0]) as Record<
    string,
    Value
  >;
  const queryName = getFunctionName(query);
  const serializedArgs = JSON.stringify(convexToJson(argsObject));
  const queryKey = `${queryName}:${serializedArgs}`;
  const source = useMemo(
    () => getQuerySource(client, JSON.stringify([authSessionId, queryKey]), query, argsObject),
    // Match Convex's useQuery semantics: semantic argument equality owns the subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, authSessionId, queryKey]
  );
  const result = useSyncExternalStore(
    skip ? subscribeSkipped : source.subscribe,
    skip ? getSkippedSnapshot : source.getSnapshot,
    getSkippedSnapshot
  ) as Query['_returnType'] | Error | undefined;
  useEffect(() => source.retain(), [source]);
  const snapshotRef = useRef<QuerySnapshot | null>(null);
  const authError = isConvexUnauthenticatedError(result) ? result : null;

  useEffect(() => {
    if (!authError || confirmedUnauthenticated) return;
    requestAuthRecovery();
  }, [authError, confirmedUnauthenticated, requestAuthRecovery]);

  useEffect(() => {
    if (skip || result === undefined || result instanceof Error) return;
    snapshotRef.current = {
      authSessionId,
      queryKey,
      value: result,
    };
  }, [authSessionId, queryKey, queryName, result, skip]);

  if (result instanceof Error) {
    if (!authError) throw result;
    const snapshot = snapshotRef.current;
    return source.canRetainSnapshot() && matchesSnapshot(snapshot, authSessionId, queryKey)
      ? (snapshot.value as Query['_returnType'])
      : undefined;
  }

  // Retain the last committed value whenever the subscription is transiently
  // skipped by a lost/refreshing auth state (offline blips, token refresh,
  // recovery). Without this, `skip` flapping true drops the query to
  // `undefined` and the sidebar churns — the private icon flickers and
  // teammates' rows flash out and back. We only fall through to `undefined`
  // when the caller explicitly skipped or the user is confirmed logged out
  // (where retaining stale team data would be wrong). The snapshot's
  // `authSessionId` + `queryKey` guard keeps this scoped to the same user and
  // query, so switching account/workspace never reuses a stale value.
  if (skip && !callerSkipped && !confirmedUnauthenticated) {
    const snapshot = snapshotRef.current;
    if (source.canRetainSnapshot() && matchesSnapshot(snapshot, authSessionId, queryKey)) {
      return snapshot.value as Query['_returnType'];
    }
  }

  return result;
}

/** Public queries must run before authentication, so they cannot use the
 * authenticated query gate above. Keep the direct Convex hook isolated here. */
export function usePublicConvexQuery<Query extends FunctionReference<'query'>>(
  query: Query,
  ...args: ConvexReact.OptionalRestArgsOrSkip<Query>
): Query['_returnType'] | undefined {
  return ConvexReact.useQuery(query, ...args);
}
