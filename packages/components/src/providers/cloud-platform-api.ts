import { useAction, useConvex, useMutation } from 'convex/react';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { ConvexError } from 'convex/values';
import { isConvexUnauthenticatedError } from '@lody/shared';
import { useOptionalAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { makeFunctionReference, type FunctionReference } from 'convex/server';
import type { CloudAction, CloudApi, CloudMutation, CloudQuery } from '@lody/platform';
import {
  useOptionalRecoverableConvexQuery,
  usePublicConvexQuery,
  useRecoverableConvexQuery,
} from '@/hooks/use-recoverable-convex-query';
import { markPersistentWorkspaceSenderCloudApi } from '@/lib/workspace-sender-identity';

function queryReference<Args, Result>(
  operation: CloudQuery<Args, Result>
): FunctionReference<'query'> {
  return makeFunctionReference<'query'>(operation.name);
}

function mutationReference<Args, Result>(
  operation: CloudMutation<Args, Result>
): FunctionReference<'mutation'> {
  return makeFunctionReference<'mutation'>(operation.name);
}

function actionReference<Args, Result>(
  operation: CloudAction<Args, Result>
): FunctionReference<'action'> {
  return makeFunctionReference<'action'>(operation.name);
}

function useCloudPlatformQuery<Args, Result>(
  operation: CloudQuery<Args, Result>,
  args: Args | 'skip'
): Result | undefined {
  const reference = queryReference(operation);
  const publicResult = usePublicConvexQuery(
    reference,
    operation.access === 'public' ? (args as Parameters<typeof usePublicConvexQuery>[1]) : 'skip'
  );
  const authenticatedResult = useRecoverableConvexQuery(
    reference,
    operation.access === 'authenticated'
      ? (args as Parameters<typeof useRecoverableConvexQuery>[1])
      : 'skip'
  );
  return (operation.access === 'public' ? publicResult : authenticatedResult) as Result | undefined;
}

/** Keep imperative owners stable across recovery, just like mounted query hooks. */
function useCloudAuthGate() {
  const auth = useOptionalAuthenticatedConvex();
  const live = useRef(auth);
  live.current = auth;
  // A userless refetch is not a new login. Bind work created in that gap to
  // the last session, so it cannot be adopted by a different account.
  const session = useRef(auth?.authSessionId ?? null);
  if (auth?.authSessionId) session.current = auth.authSessionId;
  const gate = useMemo(() => {
    const listeners = new Set<() => void>();
    let rejected = false;
    let mounted = true;
    const unavailable = () => new ConvexError({ kind: 'lody.auth', code: 'unauthenticated' });
    return {
      active: () => mounted,
      ready: () =>
        mounted &&
        !!live.current?.isAuthenticated &&
        !live.current.confirmedUnauthenticated &&
        !rejected,
      terminal: () => !!live.current?.confirmedUnauthenticated,
      session: () => session.current,
      assert(access: 'public' | 'authenticated') {
        if (access === 'authenticated' && !this.ready()) throw unavailable();
      },
      failed(error: unknown) {
        if (
          !mounted ||
          live.current?.confirmedUnauthenticated ||
          !isConvexUnauthenticatedError(error) ||
          rejected
        )
          return;
        rejected = true;
        for (const listener of listeners) listener();
        live.current?.requestAuthRecovery();
      },
      mount(value: boolean) {
        mounted = value;
        for (const listener of listeners) listener();
      },
      update() {
        rejected = false;
        for (const listener of listeners) listener();
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  }, []);
  useLayoutEffect(() => {
    gate.mount(true);
    return () => gate.mount(false);
  }, [gate]);
  useLayoutEffect(() => {
    gate.update();
  }, [gate, auth?.authSessionId, auth?.isAuthenticated, auth?.confirmedUnauthenticated]);
  return gate;
}

function useCloudCommand<Args, Result>(
  operation: CloudMutation<Args, Result> | CloudAction<Args, Result>,
  run: (args: Args) => Promise<Result>
) {
  const gate = useCloudAuthGate();
  return useCallback(
    async (args: Args): Promise<Result> => {
      gate.assert(operation.access);
      const session = gate.session();
      try {
        return await run(args);
      } catch (error) {
        if (operation.access === 'authenticated' && session === gate.session()) gate.failed(error);
        throw error;
      }
    },
    [gate, operation.access, run]
  );
}

/**
 * The only React/Convex adapter in the open tree. Operation descriptors carry
 * public DTO types and stable names; generated Convex references stay private
 * to this cloud assembly and can move to `platform-cloud` unchanged in Phase 1.
 */
export const cloudPlatformApi: CloudApi = {
  useOptionalAuthenticatedQuery: <Args, Result>(
    operation: CloudQuery<Args, Result>,
    args: Args | 'skip'
  ) => {
    if (operation.access !== 'authenticated')
      throw new Error('Optional metadata requires an authenticated query');
    return useOptionalRecoverableConvexQuery(queryReference(operation), args as never) as {
      data: Result | undefined;
      error: Error | null;
      retry: () => void;
    };
  },
  useQuery: <Args, Result>(operation: CloudQuery<Args, Result>, args: Args | 'skip') =>
    useCloudPlatformQuery(operation, args),
  useMutation: <Args, Result>(operation: CloudMutation<Args, Result>) =>
    useCloudCommand(
      operation,
      useMutation(mutationReference(operation)) as (args: Args) => Promise<Result>
    ),
  useAction: <Args, Result>(operation: CloudAction<Args, Result>) =>
    useCloudCommand(
      operation,
      useAction(actionReference(operation)) as (args: Args) => Promise<Result>
    ),
};

markPersistentWorkspaceSenderCloudApi(cloudPlatformApi);

/** Imperative operations for the app-owned workspace control lifecycle. Callers
 * still supply the same public descriptors as reactive UI, never private APIs.
 */
export function useCloudPlatformClient() {
  const client = useConvex();
  const gate = useCloudAuthGate();
  return useMemo(() => {
    const run = async <Result>(
      access: 'public' | 'authenticated',
      execute: () => Promise<Result>
    ) => {
      gate.assert(access);
      const session = gate.session();
      try {
        return await execute();
      } catch (error) {
        if (access === 'authenticated' && session === gate.session()) gate.failed(error);
        throw error;
      }
    };
    const subscribe = <Args, Result>(
      operation: CloudQuery<Args, Result>,
      args: Args,
      changed: (value: Result) => void,
      failed: (error: unknown) => void
    ) => {
      let session = gate.session();
      let unsubscribe: (() => void) | undefined;
      let disposed = false;
      let retired = false;
      let attached = false;
      const stop = () => {
        unsubscribe?.();
        unsubscribe = undefined;
      };
      const reconcile = () => {
        if (disposed) return;
        if (!gate.active()) {
          stop();
          return;
        }
        if (operation.access === 'authenticated') {
          retired ||=
            gate.terminal() ||
            (session !== null && gate.session() !== null && session !== gate.session());
          if (retired || !gate.ready()) {
            stop();
            return;
          }
          session ??= gate.session();
        }
        if (unsubscribe) return;
        const query = client.watchQuery(queryReference(operation), args as never);
        const emit = (cached = false) => {
          if (
            disposed ||
            (operation.access === 'authenticated' && (!gate.ready() || session !== gate.session()))
          )
            return;
          try {
            const value = query.localQueryResult();
            if (value !== undefined) changed(value as Result);
          } catch (error) {
            // A resumed watch can still hold its pre-refresh error until the
            // SDK receives the server's next result. Do not reject the new JWT
            // from that old cache entry.
            if (cached && attached && isConvexUnauthenticatedError(error)) return;
            if (operation.access === 'authenticated') gate.failed(error);
            failed(error);
          }
        };
        unsubscribe = query.onUpdate(() => emit());
        emit(true);
        attached = true;
      };
      const unlisten = gate.subscribe(reconcile);
      reconcile();
      return () => {
        disposed = true;
        unlisten();
        stop();
      };
    };
    return {
      subscribeValue: subscribe,
      subscribe: <Args, Result>(
        operation: CloudQuery<Args, Result>,
        args: Args,
        changed: () => void
      ) => subscribe(operation, args, changed, changed),
      query: <Args, Result>(operation: CloudQuery<Args, Result>, args: Args): Promise<Result> =>
        run(
          operation.access,
          () => client.query(queryReference(operation), args as never) as Promise<Result>
        ),
      mutation: <Args, Result>(
        operation: CloudMutation<Args, Result>,
        args: Args
      ): Promise<Result> =>
        run(
          operation.access,
          () => client.mutation(mutationReference(operation), args as never) as Promise<Result>
        ),
      action: <Args, Result>(operation: CloudAction<Args, Result>, args: Args): Promise<Result> =>
        run(
          operation.access,
          () => client.action(actionReference(operation), args as never) as Promise<Result>
        ),
    };
  }, [client, gate]);
}

/** Optional catalog failures remain data, so unrelated workspace surfaces can continue. */
export function useOptionalCloudPlatformQuery<Args, Result>(
  operation: CloudQuery<Args, Result>,
  args: Args | 'skip'
): { data: Result | undefined; error: Error | null } {
  return useOptionalRecoverableConvexQuery(
    queryReference(operation),
    args as Parameters<typeof useOptionalRecoverableConvexQuery>[1]
  ) as { data: Result | undefined; error: Error | null };
}
