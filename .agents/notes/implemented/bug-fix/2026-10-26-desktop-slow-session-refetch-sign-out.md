# Slow session refetch no longer signs out the desktop

Status: implemented
Translation: current

[中文](2026-10-26-desktop-slow-session-refetch-sign-out.zh.md)

## Abstract

After an update or restart behind a macOS proxy, the desktop app signed the
person out and required a fresh browser login. The first session checks timed
out, and the retry took longer than the retry backoff and the bootstrap grace
period. The Electron session store clears `error` while it refetches, so the
stable-session hook read that state as a settled "no user" answer and confirmed
sign-out, which revoked the durable cookie. The hook now treats a refetch that
has not resolved a user as pending, so only a definitive server answer signs out.
The main process also keeps a session reply that arrives after the timeout, and it
authorizes organization and Convex calls with the stored cookie while verification
is unreachable. Together, these let a slow startup recover without signing out.

## Cause

`useStableSessionInternal` read `isPending` from `authClient.useSession()` but
ignored `isRefetching`. The sequence looked like this:

- The startup `getSession` failed with the main-process 5-second network timeout,
  and no cached main-process session existed yet.
- Retries advanced `retryCount` to its limit while one refetch was still in flight.
- `shouldConfirmUnauthenticated` then saw a local token, no user, no pending check,
  no retry and no error. Once the 2-second bootstrap grace expired, or straight
  away when no snapshot existed, the root invalidation path called sign-out.

Main-process `signOut` revokes the Better Auth cookie. That is why the person had
to log in again through the browser instead of waiting for the network to recover.

## Decision

The hook treats `isRefetching && !user` as pending. A refetch for a session that
already has a user does not change behavior. The alternative, keeping `error` set
during the refetch in the Electron query store, was rejected. It would change what
every `useSession` consumer sees mid-refetch, while the bug sits in one
interpreter of that state. Better Auth's web `useSession` exposes the same field.

## Main-process recovery

- **Late replies.** `withSessionNetworkTimeout` bounds how long the caller waits,
  but the request keeps running. A reply that resolves a session after the timeout
  now fills the cached session, as long as the auth generation is unchanged (no
  sign-out or login since) and no answer was committed after the request started.
  A session-answer revision tracks that second condition. An empty cache is not
  enough to check it, because a definitive rejection empties the cache without
  changing the auth generation. Without the revision, a stale success could restore
  an identity the server had just rejected. The renderer's retry is then served
  from cache instead of timing out again. A late rejection is ignored; the next
  real check decides.
- **Token fallback.** `getSessionToken` used to let a verification timeout reject
  `listOrganizations`, `getActiveOrganization` and `convexToken`. A transport
  failure is no verdict on the credential, so it now returns the durable cookie
  token, else the supplied bearer, without a second network check. The server still
  authenticates every call, and a stale token yields an ordinary 401 on that call,
  never sign-out.

## Verification and limits

`tests/use-stable-session.test.tsx` replays the timed-out first check followed by
a long in-flight refetch. `tests/electron-auth-session-recovery.test.ts` covers a
late reply being kept, a late reply being discarded after sign-out or after a
definitive rejection, and the cookie fallback for tokens. The new tests fail against the previous code. The underlying
network delay behind a proxy is not addressed, and no real macOS proxy run was
performed.
