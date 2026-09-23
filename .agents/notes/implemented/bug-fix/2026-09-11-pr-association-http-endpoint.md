# Route PR association through the HTTP action endpoint

Status: implemented
Translation: current

[中文](2026-09-11-pr-association-http-endpoint.zh.md)

## Abstract

Cloud CLI PR association sent `/api/action` requests to the public Convex RPC
endpoint, which cannot invoke the internal association function. This produces
`Could not find public function for 'github:associatePullRequestForCli'`.
The request now uses the existing `authSiteUrl`, reaching the HTTP action proxy
and preserving explicitly configured site URLs as well as derived defaults.

## Decision

`cloud-cli-port.ts` owns endpoint selection. Use its existing site URL for PR
association, consistent with other HTTP action consumers. The request payload,
token checks, and response handling do not change. Making the backend function
public is unnecessary; the intended HTTP proxy already supports this operation.

## Verification limits

An isolated runtime check executed the transpiled cloud port with unrelated
services stubbed and intercepted fetch requests. Both the derived Convex site URL
and an explicitly configured site URL received the expected POST and association
payload. Changed-file formatting passed. Full checks are blocked in this checkout
by missing nested ACP modules; document checks report links to those modules.

This change does not include a live association against a hosted deployment.
Review the endpoint selection separately from the unchanged association payload
and backend authorization.
