# Streams token refresh

Status: draft
Translation: current

[中文](streams-token-refresh.zh.md)

When multiple streams receive an unauthorized response for the same workspace
JWT, they should reuse one refresh in their token provider. A response for an old
JWT must not invalidate its replacement. The transport supplies `previousToken`;
legacy callbacks without it use their last returned token as a best-effort fallback.

A provider belongs to one endpoint and workspace. It resolves the current login
before returning cached state. Credential changes invalidate memory and pending
publication; old requests must reject rather than return a previous user's token.
Persistent storage is encrypted with the issuing credential and partitioned by
endpoint/workspace. It is an optimization, not an XSS or revocation boundary.

A refresh may include optional `rejectedToken` in the existing token request.
Older servers may ignore it; supporting servers should only invalidate a matching
cached version and enforce their own authorization and refresh rate bounds.
Transient errors remain retryable by the transport. Credential 401/403 failures
remain suppressed until the credential changes or manual invalidation occurs.

Implementation: `packages/shared/src/loro-streams-auth.ts`; regression coverage:
`packages/shared/tests/loro-streams-auth.test.ts`. No cross-tab coordination is promised.
