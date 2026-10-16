import { useAction, useConvex, useMutation } from 'convex/react';
import { useMemo } from 'react';
import { makeFunctionReference, type FunctionReference } from 'convex/server';
import type { CloudAction, CloudApi, CloudMutation, CloudQuery } from '@lody/platform';
import {
  usePublicConvexQuery,
  useRecoverableConvexQuery,
} from '@/hooks/use-recoverable-convex-query';

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

/**
 * The only React/Convex adapter in the open tree. Operation descriptors carry
 * public DTO types and stable names; generated Convex references stay private
 * to this cloud assembly and can move to `platform-cloud` unchanged in Phase 1.
 */
export const cloudPlatformApi: CloudApi = {
  useQuery: <Args, Result>(operation: CloudQuery<Args, Result>, args: Args | 'skip') =>
    useCloudPlatformQuery(operation, args),
  useMutation: <Args, Result>(operation: CloudMutation<Args, Result>) =>
    useMutation(mutationReference(operation)) as (args: Args) => Promise<Result>,
  useAction: <Args, Result>(operation: CloudAction<Args, Result>) =>
    useAction(actionReference(operation)) as (args: Args) => Promise<Result>,
};

/** Imperative operations for the app-owned workspace control lifecycle. Callers
 * still supply the same public descriptors as reactive UI, never private APIs.
 */
export function useCloudPlatformClient() {
  const client = useConvex();
  return useMemo(
    () => ({
      query: <Args, Result>(operation: CloudQuery<Args, Result>, args: Args): Promise<Result> =>
        client.query(queryReference(operation), args as never) as Promise<Result>,
      mutation: <Args, Result>(
        operation: CloudMutation<Args, Result>,
        args: Args
      ): Promise<Result> =>
        client.mutation(mutationReference(operation), args as never) as Promise<Result>,
    }),
    [client]
  );
}
