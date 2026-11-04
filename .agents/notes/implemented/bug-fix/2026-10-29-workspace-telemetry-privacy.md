# Workspace telemetry privacy

Status: implemented
Translation: current

[中文](2026-10-29-workspace-telemetry-privacy.zh.md)

## Abstract

Text masking does not remove replay DOM attributes. Encrypted and unknown workspace
scopes therefore disable replay and reduce automatic exceptions to a fixed error
vocabulary. Confirmed ordinary scopes retain recording and ordinary exception
behavior. Local diagnostics remain available for explicit user submission.

## Decision and constraints

`CloudPlatformProvider` authorizes only an authenticated account, route target,
workspace ID and matching verified `plaintext` descriptor. A provisional runtime,
`legacy-unclassified` admission or workspace listing cannot authorize recording.
Listings can veto it. Live render snapshots and synchronous store subscriptions
close the effect-update window; router navigation closes the gate before a new
scope commits. A failed activation may restore only its own unchanged transition.
The gate never delays content/runtime operations.

The locked `posthog-js@1.396.6` SDK's stop operation flushes buffers and may drain
async compression. Its remote-disable `onRemoteConfig` path instead discards them
and invalidates compression work. Removing `$session_recording_remote_config`
also prevents an already-loading recorder script from starting with a disabled
but truthy config. Incoming config is held while restricted and restored only
for the current confirmed ordinary scope. Private method names are minified in
the distribution and must not be called by source name.

Capture-time `before_send` alone misses the request and retry queues. The narrow
`_send_request` adapter, preserved in this distribution's types and bundle,
rechecks the live scope and event generation for batches, retries and unload.
Sensitive requests use synchronous SDK encoding: native gzip otherwise serializes
before yielding, allowing an encoded body to outlive a scope change. Already
sent requests cannot be recalled. SDK upgrades must run the real browser suite;
missing recorder controls leave recording disabled.

Deferred exceptions are redacted before queuing in an unknown scope, so delayed
initialization cannot restore their originals. Main and daemon processes always
use fixed diagnostics because they serve multiple workspaces. Pre-React beacons
use fixed error types. [Expected auth exceptions](2026-10-09-posthog-auth-error-filter.md)
are still filtered before this policy. The supported replay `blockSelector` hides
images and elements with `alt`, `title` or `aria-label` as additional protection;
this SDK does not expose replay attribute masking.

## Evidence and limits

`pnpm --filter @lody/components test:posthog-browser` bundles actual product options
and uses the locked SDK, fresh Chromium/WebKit contexts and loopback ingestion.
It covers unknown/ordinary scopes, buffered switches, recovery, attribute blocking
delayed recorder scripts and held native gzip across Web, desktop and native-shell
tags. Real HTTP 500 responses exercise the SDK retry queue across pause/resume. The
`--negative-control` variant removes the guard/masking and must fail. Node SDK
receiver tests cover main/CLI redaction and local hard-disable; provider tests
cover account, target and mode mismatch. This is local synthetic evidence, not
installed mobile/desktop or production-deployment acceptance. Older clients need
an operator-owned remote recording disable until updated; client code cannot
retroactively protect them.
