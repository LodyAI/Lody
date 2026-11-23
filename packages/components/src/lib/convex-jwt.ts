import { getAuthSessionIntentGeneration, type LodyAuthClient } from './auth';

type ConvexJwtRequests = {
  /** Auth key of the mounted Convex auth provider; it includes the auth restart generation. */
  activeAuthKey: string | undefined;
  /** Session identity of that key: logout intent and session, without the restart generation. */
  activeIdentity: string | undefined;
  pending: Map<string, Promise<string | null>>;
};

const REQUESTS = new WeakMap<object, ConvexJwtRequests>();

function requestsFor(authClient: LodyAuthClient): ConvexJwtRequests {
  let requests = REQUESTS.get(authClient);
  if (!requests) {
    requests = { activeAuthKey: undefined, activeIdentity: undefined, pending: new Map() };
    REQUESTS.set(authClient, requests);
  }
  return requests;
}

/**
 * Every Convex JWT request for one auth client goes through here, so the Convex
 * auth provider and out-of-band recovery (an `unauthorized` GitHub token action)
 * share one Better Auth request per session instead of each fetching its own.
 * Different auth keys never share a request.
 */
export function requestConvexJwt(
  authClient: LodyAuthClient,
  authKey: string
): Promise<string | null> {
  const { pending } = requestsFor(authClient);
  const existing = pending.get(authKey);
  if (existing) return existing;

  const request: Promise<string | null> = authClient.convex
    .token({ fetchOptions: { throw: false } })
    .then(({ data }) => data?.token ?? null)
    .finally(() => {
      if (pending.get(authKey) === request) pending.delete(authKey);
    });
  pending.set(authKey, request);
  return request;
}

/**
 * The mounted Convex auth provider publishes its session identity; the returned
 * release clears it only while no newer identity replaced it.
 */
export function activateConvexJwtAuthKey(
  authClient: LodyAuthClient,
  authKey: string,
  identity: string
): () => void {
  const requests = requestsFor(authClient);
  requests.activeAuthKey = authKey;
  requests.activeIdentity = identity;
  return () => {
    if (requests.activeAuthKey !== authKey) return;
    requests.activeAuthKey = undefined;
    requests.activeIdentity = undefined;
  };
}

/**
 * A fresh JWT for whichever session the provider currently authenticates.
 * Joins the provider's in-flight request; returns null on failure or when the
 * session or logout intent changed before the JWT arrived, so an old session's
 * JWT is never used. A Convex auth restart alone keeps the session, so its JWT
 * stays valid for this caller.
 */
export async function requestCurrentConvexJwt(authClient: LodyAuthClient): Promise<string | null> {
  const intent = getAuthSessionIntentGeneration(authClient);
  const requests = requestsFor(authClient);
  const currentIdentity = () => requests.activeIdentity ?? `detached:${intent}`;
  const identity = currentIdentity();
  let token: string | null;
  try {
    token = await requestConvexJwt(authClient, requests.activeAuthKey ?? `detached:${intent}`);
  } catch {
    return null;
  }
  if (getAuthSessionIntentGeneration(authClient) !== intent || currentIdentity() !== identity) {
    return null;
  }
  return token;
}
