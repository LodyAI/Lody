import type { PlatformCapability } from './capabilities';

export type CloudOperationKind = 'query' | 'mutation' | 'action';

/**
 * Public, backend-neutral identity for one cloud operation.
 *
 * The open UI owns these descriptors and their DTOs; a cloud implementation
 * resolves `name` to its private backend. Keeping the backend reference out of
 * the descriptor is what lets the local build compile without importing the
 * cloud implementation.
 */
export interface CloudOperation<Kind extends CloudOperationKind, Args, Result> {
  readonly kind: Kind;
  readonly name: string;
  readonly capability: PlatformCapability;
  readonly access: 'authenticated' | 'public';
  /** Type-only invariance markers; never present at runtime. */
  readonly __args?: (args: Args) => Args;
  readonly __result?: (result: Result) => Result;
}

export type CloudQuery<Args, Result> = CloudOperation<'query', Args, Result>;
export type CloudMutation<Args, Result> = CloudOperation<'mutation', Args, Result>;
export type CloudAction<Args, Result> = CloudOperation<'action', Args, Result>;

function defineCloudOperation<Kind extends CloudOperationKind, Args, Result>(
  kind: Kind,
  capability: PlatformCapability,
  name: string,
  access: 'authenticated' | 'public' = 'authenticated'
): CloudOperation<Kind, Args, Result> {
  if (!/^[a-zA-Z][\w/.-]*:[a-zA-Z][\w.-]*$/.test(name)) {
    throw new Error(`Invalid cloud operation name: ${JSON.stringify(name)}`);
  }
  return Object.freeze({ kind, capability, name, access });
}

export function defineCloudQuery<Args, Result>(
  capability: PlatformCapability,
  name: string
): CloudQuery<Args, Result> {
  return defineCloudOperation('query', capability, name);
}

/** A cloud query that is intentionally callable before the user signs in. */
export function definePublicCloudQuery<Args, Result>(
  capability: PlatformCapability,
  name: string
): CloudQuery<Args, Result> {
  return defineCloudOperation('query', capability, name, 'public');
}

export function defineCloudMutation<Args, Result>(
  capability: PlatformCapability,
  name: string
): CloudMutation<Args, Result> {
  return defineCloudOperation('mutation', capability, name);
}

export function defineCloudAction<Args, Result>(
  capability: PlatformCapability,
  name: string
): CloudAction<Args, Result> {
  return defineCloudOperation('action', capability, name);
}

export type CloudMutationFunction<Args, Result> = (args: Args) => Promise<Result>;
export type CloudActionFunction<Args, Result> = (args: Args) => Promise<Result>;
export type OptionalCloudArgsOrSkip<Args> =
  Record<string, never> extends Args ? [args?: Args | 'skip'] : [args: Args | 'skip'];

/**
 * React-facing cloud API adapter. Hook ownership stays in the cloud
 * implementation so the open platform package never imports a cloud SDK.
 */
export interface CloudApi {
  /** Authenticated optional metadata: failures remain local to the consumer. */
  useOptionalAuthenticatedQuery?<Args, Result>(
    operation: CloudQuery<Args, Result>,
    args: Args | 'skip'
  ): {
    data: Result | undefined;
    error: Error | null;
    retry: () => void;
  };
  useQuery<Args, Result>(
    operation: CloudQuery<Args, Result>,
    args: Args | 'skip'
  ): Result | undefined;
  useMutation<Args, Result>(
    operation: CloudMutation<Args, Result>
  ): CloudMutationFunction<Args, Result>;
  useAction<Args, Result>(operation: CloudAction<Args, Result>): CloudActionFunction<Args, Result>;
}

export class CloudCapabilityUnavailableError extends Error {
  readonly capability: PlatformCapability;

  constructor(capability: PlatformCapability) {
    super(`Cloud capability ${JSON.stringify(capability)} is not available on this platform`);
    this.name = 'CloudCapabilityUnavailableError';
    this.capability = capability;
  }
}
