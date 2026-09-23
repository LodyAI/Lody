# Streams token refresh

Status: draft
Translation: current

[中文](streams-token-refresh.zh.md)

When multiple streams receive an unauthorized response for the same workspace
JWT, they should reuse one refresh in their token provider. A response for an old
JWT must not invalidate its replacement. The transport supplies `previousToken`;
legacy callbacks without it use their last returned token as a best-effort fallback.
Every hop between a transport and the provider, including a Worker message boundary,
carries its reason and rejected-token fields, and each transport holds one callback for the provider's
lifetime: a callback rebuilt per invocation has no last token to fall back on and
would return the rejected JWT unchanged.

A provider belongs to one endpoint and workspace. It resolves the current login
before returning cached state. Credential changes invalidate memory and pending
publication; old requests must reject rather than return a previous user's token.
Persistent storage is encrypted with the issuing credential and partitioned by
endpoint/workspace. It is an optimization, not an XSS or revocation boundary.

A refresh may include optional `rejectedToken` in the existing token request.
Older servers may ignore it; supporting servers should only invalidate a matching
cached version and enforce their own authorization and refresh rate bounds. A refresh
whose body was already sent cannot carry a later rejection, so it may neither clear the
rejection nor persist a JWT still marked as rejected. If the rejection is known before
persistence starts and the response contains that JWT, one further request carries
the rejection and every joined caller shares it. A rejection arriving during encryption
prevents persistence but can require another transport retry. The persistence
gate re-reads the marker synchronously before writing, because encryption is async
and an unauthorized invalidation does not change the credential generation. Only
the most recently rejected token is tracked.
Transient errors remain retryable by the transport. Credential 401/403 failures
remain suppressed until the credential changes or manual invalidation occurs.

Implementation: `packages/shared/src/loro-streams-auth.ts`; regression coverage:
`packages/shared/tests/loro-streams-auth.test.ts`. No cross-tab coordination is promised.
