import type { PlatformCapability } from './capabilities';

export type CloudOperationKind = 'query' | 'mutation' | 'action';

export type CloudOperationDecodeResult<Result> =
  | { ok: true; data: Result }
  | { ok: false; error: Error };

export type CloudOperationDecoder<Result> = (raw: unknown) => CloudOperationDecodeResult<Result>;

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
  /** Optional runtime boundary decoder enforced at the cloud adapter seam. */
  readonly decode?: CloudOperationDecoder<Result>;
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
  access: 'authenticated' | 'public' = 'authenticated',
  decode?: CloudOperationDecoder<Result>
): CloudOperation<Kind, Args, Result> {
  if (!/^[a-zA-Z][\w/.-]*:[a-zA-Z][\w.-]*$/.test(name)) {
    throw new Error(`Invalid cloud operation name: ${JSON.stringify(name)}`);
  }
  return Object.freeze(decode ? { kind, capability, name, access, decode } : { kind, capability, name, access });
}

export function defineCloudQuery<Args, Result>(
  capability: PlatformCapability,
  name: string,
  decode?: CloudOperationDecoder<Result>
): CloudQuery<Args, Result> {
  return defineCloudOperation('query', capability, name, 'authenticated', decode);
}

/** A cloud query that is intentionally callable before the user signs in. */
export function definePublicCloudQuery<Args, Result>(
  capability: PlatformCapability,
  name: string,
  decode?: CloudOperationDecoder<Result>
): CloudQuery<Args, Result> {
  return defineCloudOperation('query', capability, name, 'public', decode);
}

export function defineCloudMutation<Args, Result>(
  capability: PlatformCapability,
  name: string,
  decode?: CloudOperationDecoder<Result>
): CloudMutation<Args, Result> {
  return defineCloudOperation('mutation', capability, name, 'authenticated', decode);
}

export function defineCloudAction<Args, Result>(
  capability: PlatformCapability,
  name: string,
  decode?: CloudOperationDecoder<Result>
): CloudAction<Args, Result> {
  return defineCloudOperation('action', capability, name, 'authenticated', decode);
}

export type CloudMutationFunction<Args, Result> = (args: Args) => Promise<Result>;
export type CloudActionFunction<Args, Result> = (args: Args) => Promise<Result>;
export type OptionalCloudArgsOrSkip<Args> =
  Record<string, never> extends Args ? [args?: Args | 'skip'] : [args: Args | 'skip'];

export type CloudQueryState<Result> = {
  data: Result | undefined;
  error: Error | null;
  retry: () => void;
};

/**
 * React-facing cloud API adapter. Hook ownership stays in the cloud
 * implementation so the open platform package never imports a cloud SDK.
 */
export interface CloudApi {
  /** Non-throwing cloud query state: backend failures remain data instead of crashing render. */
  useQueryState?<Args, Result>(
    operation: CloudQuery<Args, Result>,
    args: Args | 'skip'
  ): CloudQueryState<Result>;
  /** Authenticated optional metadata: failures remain local to the consumer. */
  useOptionalAuthenticatedQuery?<Args, Result>(
    operation: CloudQuery<Args, Result>,
    args: Args | 'skip'
  ): CloudQueryState<Result>;
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
