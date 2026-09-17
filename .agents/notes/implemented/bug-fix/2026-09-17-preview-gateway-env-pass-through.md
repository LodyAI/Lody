# Pass an explicit preview gateway URL into the embedded CLI

Status: implemented
Translation: current

[中文](2026-09-17-preview-gateway-env-pass-through.zh.md)

## Abstract

The Electron cloud build previously forwarded only `VITE_SERVER_URL` as
`LODY_SERVER_URL` to its embedded CLI. The CLI already supports a separate
`LODY_PREVIEW_GATEWAY_URL`, but Electron never supplied it, so staging tunnel
creation fell back to the staging server origin while the Worker accepted
control requests only on its configured staging control origin. The result was a
421 `preview_control_origin_mismatch`. Electron now always sets
`LODY_PREVIEW_GATEWAY_URL` from `VITE_PREVIEW_GATEWAY_URL` (an empty bundled
value falls back to `LODY_SERVER_URL` in the CLI). Always writing the key also
prevents an inherited shell value from redirecting authenticated tunnel
requests. This preserves production behavior and gives staging an out-of-band
control origin without changing the Worker security boundary.

## Cause and decision

The preview gateway deliberately accepts control requests only on the
environment's `PUBLIC_PREVIEW_CONTROL_ORIGIN`. Production happens to use the
same origin for its server and preview control plane, while staging uses
different origins. The CLI composition already had `previewGatewayUrl` as an
optional, explicit port defaulting to `LODY_SERVER_URL`, and `start.ts` read
`process.env.LODY_PREVIEW_GATEWAY_URL`. Standalone CLI bundles could inline that
value, but the Electron composition ran the CLI with a fixed runtime environment
that listed only auth and server URLs. As long as staging's `LODY_SERVER_URL`
was the Worker's public `workers.dev` origin, every Electron tunnel create went
to an origin the Worker rejects by design.

Changing the Worker to accept `workers.dev` would have weakened the control/viewer
origin separation and created a second staging behavior that production does not
share. Instead, Electron now forwards the same explicit capability the CLI
already exposes. Setting the key even when the bundled value is empty is
deliberate: the CLI then falls back to `LODY_SERVER_URL`, and a user's login-shell
`LODY_PREVIEW_GATEWAY_URL` cannot override the composition's control origin.
The production fallback remains intentional, and local OSS composition returns
before any cloud environment assignment. Composition roots are responsible for
setting the variable when server and control origins differ.

## Verification

The public change is one runtime-environment assignment plus its Vite type
declaration in `apps/electron/src/main/services/cli-service.ts` and
`apps/electron/src/main/env.d.ts`. Type checking and the affected
private-composition checks cover that the new `VITE_*` define and runtime
assignment compile together. A packaged staging Electron build was not produced
in this change, so the end-to-end tunnel handshake remains to be exercised after
the private composition sets the staging control origin in
`LODY_PREVIEW_GATEWAY_URL`.

## Integration

- [Lody PR #793](https://github.com/LodyAI/Lody/pull/793)
- Opened with the private preview-gateway configuration change.
