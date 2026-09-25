# Direct Quick Tunnel preview

Status: proposed
Translation: current

[中文](2026-09-21-quick-tunnel-preview.zh.md)

PR: [#890](https://github.com/LodyAI/Lody/pull/890)

## Abstract

The custom preview gateway multiplexes HTTP and HMR through a product-owned
WebSocket protocol, while the local proxy depends on that transport's helpers.
The replacement puts endpoint authentication and lifecycle in the CLI and uses
cloudflared for remote transport, sharing a standard proxy with independent local
viewing. Share links are bearer capabilities, and Browser restores expired
one-hour-idle endpoints explicitly. Work is in progress; real iframe/WS credential
behavior and real-network performance remain acceptance gates, not assumed benefits.

## Decisions and progress

PR review identified a mixed-version regression: adding `previewControlNonce`
to `machine/status` makes older strict clients reject otherwise valid status
responses. They return `invalid_result`, not the timeout originally described
in the review. Keep that general response unchanged and fetch the nonce through
`machine/preview-control`, gated by the shared `previewControl: 1` capability.
Missing support requires an upgrade; local control and signed-proof validation
remain unchanged. This preserves the general protocol, not the old Preview transport.

No thin Worker, compatibility reader, old-domain mapping, or automatic fallback is
retained in the target architecture. See the [draft contract](../../../../specs/quick-tunnel-preview.md).
The transport-independent helpers now live in `preview-http.ts`. The local proxy's
global unlock was removed: every request needs a capability, even after a successful
navigation. Separate listeners/tokens and explicit external-origin binding form the
new remote ingress boundary. The CLI service now creates Quick Tunnels exclusively;
the old custom tunnel client is deleted, with forwarding tests moved to their owner.

`QuickTunnelSession` owns acquisition, the remote proxy, cloudflared, readiness and
one-hour idle expiry. Cancellation/exit invalidates access and waits for cleanup.
The service serializes lifecycle publication, cancels in-flight creation before
revoke, and checks the Session initiator for revoke as well as create. Rejected
requests do not overwrite live state. Machine slots are in the single lease-owned
Worker's memory; the PID/disk registry and legacy metadata reader are removed.
Connection state now uses endpoint identity and explicit closure reasons. Machine
RPC status queries/heartbeats route through the target's local or remote plane;
observations cannot renew, and renewal must name the current endpoint. Browser
Enter/Share/restore no longer opens a confirmation dialog. It displays localized
state, preserves logical navigation on expiry, and explicitly replaces the endpoint
on restore. Stale status responses cannot overwrite a completed control operation.

WS forwarding now waits for upstream acceptance, preserves its selected protocol,
and applies backpressure without an unbounded startup queue. Revocation closes
owned sockets and aborts requests. Preserve the reasons behind the earlier
[Fetch Metadata decision](../../implemented/bug-fix/2026-09-20-preview-fetch-metadata.md)
and [optional annotation decision](../../implemented/bug-fix/2026-09-15-preview-optional-annotation.md).

`cloudflared-native.ts` owns a fixed-release child, an isolated explicit config,
bounded address allocation, cancellation, and confirmed-exit cleanup. The actual
2026.9.1 JSON flag is `--output json`; a native smoke caught an incorrect flag
before integration. Public readiness retries only transient network/DNS or
Cloudflare gateway-unavailable responses within 20 seconds. Proxy markers, not
annotation markers or process liveness, prove successful forwarding. Probes are
identified separately from renewing activity.

The binary helper uses the existing profile runtime cache, file lock, HTTP proxy
transport and public R2 channel. The manifest pins upstream bytes for six platform
entries (Windows ARM64 deliberately uses the official x64 binary under OS emulation;
that platform still needs runtime validation). The private mirror script supports
unchanged raw cloudflared assets and refuses mismatching immutable objects.

All 65 Preview tests and CLI typechecking passed, including deterministic idle,
late-creation cancellation, failure cleanup, and independent local viewing. Mirror
`--runtime cloudflared --skip-upload` downloaded and verified every platform entry;
no object was uploaded. A native macOS ARM64 binary was installed and started with
the isolated config, allocated real Quick URLs, then was stopped and removed.
Public round trips still timed out, both directly and with configured HTTP
transport. The opt-in `tests/e2e/quick-tunnel.e2e.test.ts` reproduced a 20-second
readiness timeout with `--protocol auto`; resources were cleaned up. The failing
network segment remains undetermined; address allocation is not an end-to-end pass.
Run with `LODY_E2E=1 LODY_QUICK_TUNNEL_E2E=1`; the additional explicit
`LODY_QUICK_TUNNEL_E2E_USE_UPSTREAM=1` tests pinned upstream bytes before channel
publication, not the production artifact route. Only synthetic services are exposed.
The smoke's HTTP/WS/revoke assertions remain unexecuted past failed readiness.

The Browser controller's 24 tests cover foreground renewal, hidden observation,
local-view independence, exact-page restore and late-response fencing. Related
surface/URL/routing tests pass (18), as does the new client/server status round trip.
Component/shared/CLI/RPC typechecks pass. Dedicated Storybook states were inspected
in Chinese and English, including narrow layouts, expiry and disabled offline
recovery. This is not full-product or real-tunnel validation.

Security audit found that workspace RPC cannot authenticate a self-reported user
id. Remote create/revoke/status now require an app-authenticated two-minute proof,
bound to the exact command, user, workspace/machine/session, current runtime nonce
and one-use request id. CLI verification checks machine/project access; project
identity comes from CLI-resolved Session metadata. Concurrent duplicates execute
at most once, and a new nonce rejects retained requests after restart without a
persistent grant/replay table. Login tokens never enter workspace RPC; local
control requires no cloud proof. Tests cover these boundaries, HTTP mint/verify,
malformed-request redaction and local independence. This control-only service is
separate from CLI-owned viewer capabilities and does not restore a data gateway.

The old shared wire protocol and Preview domain/build parameters are removed;
Cloud CSP allows Quick origins while the public desktop retains local-only frames.
This replaces the configuration need recorded by the historical
[gateway environment fix](../../implemented/bug-fix/2026-09-17-preview-gateway-env-pass-through.md).
Status reads now verify active public routes within five seconds. They share
in-flight probes, do not renew or retry, and fail/clean up only their own endpoint.
Forwarded application 4xx/5xx remain healthy transport responses. Deterministic
tests cover failure despite a live child, unchanged local access, explicit restore,
concurrent observations, cancellation and late results after replacement; the
26 lifecycle/service/round-trip tests and CLI typecheck pass.

Loopback probes and forwarding now share `preview-target-transport.ts`: bind the
selected literal address while preserving the approved Host/TLS identity. Each
endpoint owns its direct Undici pool and WS lookup, so global proxy configuration
cannot redirect target traffic. Real local HTTP/WS tests cover IPv4-only and
IPv6-only localhost servers with a rejecting global dispatcher. Closing releases
the pool as well as sockets. The seven surface tests now cover exact Quick origin
and iframe-source checks, including stale-origin rejection after restoration.

Readiness failures retain their cause and the last sanitized connector error.
An earlier native smoke failed its 20-second public deadline, reporting an
internal DNS resolver timeout; independent DNS/SRV and TCP 7844 checks succeeded.
A Quick-domain TLS request through the configured CONNECT proxy also failed.
These observations do not isolate a sole root cause, and user network settings
were not changed.
A subsequent isolated synthetic-server probe registered one QUIC edge connection,
but a five-second curl request timed out and no HTTP request reached the fixture.
The child exited at the test deadline. Edge registration in that sample does not
establish public HTTP/WS readiness. Repository-wide checks passed after the
loopback and annotation changes; documentation checks report no errors.

A later real-network smoke now passes with the production QuickTunnelSession:
HTTP/query forwarding, anonymous 403, binary WS/subprotocol, health check, revocation
closing WS and continued direct local access. It explicitly downloads the pinned
official upstream artifact, not the unpublished product runtime channel. Owned
test resources were cleaned up. This one sample establishes public transport on
the tested network, not cross-region reliability, performance or full client E2E.

An explicit public-tunnel browser fixture now combines the production session and
frame with a fresh synthetic Vite project, separate from the loopback-only fixture.
Runtime artifacts and TLS keys are outside the project's filesystem allowlist;
optional local artifact input still uses production integrity/install checks.
It has not yet passed browser assertions: five attempts failed the unchanged
20-second readiness gate, while one reached readiness but exposed a fixture proxy
bypass issue. Playwright appends `<-loopback>` after user bypass rules; putting it
first allows the later explicit loopback exclusions to win. An independent HTTPS
check passes direct/proxied modes after this fixture fix, but the public rerun
again failed readiness. Do not promote these results into real iframe/HMR proof.
The owned test resources were cleaned up; no product timeout or network config changed.

Real HTTP tests additionally cover gzip/br HTML and JSON decoding, injected lengths,
HEAD/304 bodylessness, and binary upload limits. A streaming-limit regression exposed
an origin leak: releasing the reader lock does not cancel an unfinished response.
The failure path now cancels the body before releasing its lock. The test gates
overflow on the viewer receiving the first chunk, then awaits both viewer failure
and origin close without sleeps; it failed before the fix and passes after it.
All 78 Preview tests and CLI typechecking pass. The full repository check also
passes after this fix, including 2,864 CLI tests (four skipped).

Native ownership testing exposed a gap: after SIGKILL of its parent, pinned
macOS ARM64 cloudflared was reparented to PID 1 and still served metrics (200).
The isolated fixture child was then terminated. The existing Supervisor kills
the Worker, not this grandchild. The adopted fix adds a lifecycle-only IPC child
per tunnel, owning the native process and temporary config. Normal IPC stop keeps
cleanup errors reportable; parent disconnect also cleans up, without polling,
restart policy or dev-server ownership. All three CLI build compositions emit its
standalone worker entry. This costs one Node process per live tunnel, avoiding a
shared watchdog/registry and cross-session cleanup policy. Real POSIX process tests
cover CLI SIGKILL during creation
and active use, normal stop, native crash, absent artifacts and cleanup failure.
A checksum-verified macOS ARM64 2026.9.1 audit using the production worker also
confirms native/owner exit and config removal after parent SIGKILL during creation,
while the independent local HTTP server remains reachable. Other OS execution and
force-killing the lifecycle owner itself are not established by this result.
The current 87 Preview tests also cover creation cancellation and the Node owner's
Electron-mode/secret-environment boundary. Public/Cloud production builds pass
under the 2 GB heap limit; the development build and its native ownership audit
also pass. This does not establish packaged Electron or other OS runtime acceptance.
The full repository check and documentation checks pass after the lifecycle change;
the final added environment test is also covered by the focused 87-test Preview run.

Distribution now bundles collected upstream/dependency notices through a static
JSON import and installs their full text atomically beside cloudflared. Cache
reuse checks that text; incomplete caches or mismatched bundled release metadata
fail explicitly instead of silently repairing. This avoids another asset-copy
pipeline. A cross-platform audit corrected the initial single-toolchain assumption:
Darwin artifacts use Go 1.26.2, Linux and Windows use 1.26.8, and Windows enables
CGO. The generator now accepts all Go source roots, rejects conflicting copies,
and merges 100 notice files; Windows notices were recollected with CGO enabled.
Five generator tests and eight install/cache tests pass. All five distinct artifact
checksums and compiled module versions/checksums/replacements match the pinned
manifest and source graph; each compiled module has matching collected source
license bytes, including replacement forks. All main-module revisions are dirty
and differ from the source tag; native linkage and non-Go-source warnings remain
release-review work. Dependency agreement is not source-build provenance.
See [distribution maintenance](../../../../apps/cli/src/preview/README.md).
Isolated installs of the five verified official artifacts cover all six manifest
platform entries: executable and completion checksums match, all 100 notice
sections match exactly, and cache reuse needs no download. The temporary install
directory was cleaned up. This tests cross-platform installation on macOS, not
native execution on the other platforms. The CLI production build with all 100
notices passed under a 2 GB heap, including published-bundle import validation;
70 Preview tests and five generator tests pass. The repository-wide check was rerun
after the multi-toolchain correction and passed; documentation checks have no errors.

A loopback-only HTTPS/CONNECT fixture now runs the actual proxy and production
frame factory in Chromium 145.0.7632.6 under the hosted CSP/credentialless COEP.
It passes page/assets/API, text and binary WS/subprotocol, partitioned secure
HttpOnly cookie storage, tokenless deep navigation, anonymous HTTP/WS rejection,
credential stripping and local access after revoke. Completion uses browser and
socket events, not sleeps. Real Vite 7.3.1 module HMR also passes without reloading
the document: only the filesystem event is injected, with the actual Vite client,
module graph and WS/module requests. Canonicalize the fixture root with realpath
to avoid macOS temporary-directory symlinks interfering with module resolution.
React 19.2.0 with the existing SWC plugin also passes Fast Refresh with component
state, document identity and query preserved. An anonymous viewer can use the
full Share URL to interact, then remove the initial URL capability and reload
using its own cookie. An opt-in independent fixture install also passes Vue 3.5.43
template HMR/state retention and Next 16.3.5 Webpack/Turbopack server-rendered query,
interaction, Fast Refresh/state retention and deep-link reload. Vite changes are
injected; Next uses its real watcher with DOM/HMR completion signals, not sleeps.
Controlled Next Suspense data gates additionally prove origin shell delivery and
proxied client RSC fallback before data completion, followed by resolved content.
Proxied initial HTML renders correctly once finite SSR completes, but the HTML
annotation path awaits EOF: it does not preserve progressive initial HTML paint.
This also applies to local Managed Preview, not direct origin browsing. Wait for
hydration before testing Next Link; an early click is a document navigation, not
an RSC test. These results do not establish real Cloudflare streaming,
full Browser UI or native-client E2E.

Next initially rejected the unmodified external Origin. Adding a dev-origin
allowlist proved the cause but is not the shipped fix: it would require new
configuration for changing Quick addresses. Shared HTTP/WS forwarding now maps
only the exact bound viewer Origin to the approved local Origin, consistently
with Host/Referer. Foreign, opaque and missing origins remain unchanged; real
upstream HTTP/WS rejection tests cover other Quick hosts and suffix lookalikes.
Next then passes with no allowlist configuration. Capability authentication still
precedes forwarding; this does not grant access based on Origin.
Mobile frontend and Electron production-mode bundles also compile; Electron's
deployment origins were synthetic, so that build is not backend integration.

## Ablation-based cleanup (2026-09-23)

The baseline passed 87 Preview tests. Each retained simplification was applied
separately and reran the whole Preview suite; no production fallback was added.

| Ablation | Evidence and decision |
| --- | --- |
| Remove both manual header aggregation helpers | Retained: Fetch `Headers` already combines names. The proxy still removes application cookies and emits one capability cookie; duplicate-header/cookie boundary assertions pass. This is not a converter for arbitrary raw headers. |
| Remove asynchronous in-memory slot wrappers, unused timestamp and returned key | Retained: reservation/release still mutate synchronously. Added a cross-workspace test proving the machine limit and slot reuse after revoke and failed download. |
| Remove hand-initialized/no-op Promise resolver fields | Rejected and restored: all 88 unit tests passed, but the CLI build/typecheck failed with TS2550 because its configured library excludes `Promise.withResolvers`. Do not widen global compiler configuration for this cleanup. |
| Remove in-flight health-check coalescing | Rejected and restored: the concurrent-health test starts a duplicate probe and observes an inactive endpoint instead of an active one. |

After restoring both rejected ablations, all 88 Preview tests pass. The multi-owner
fixture now closes its own child promise rather than the last-created child.
These results establish the local regression boundary, not real-network performance
or additional Windows/packaged-Electron acceptance.

## Test pruning (2026-09-23)

Test pruning keeps behavioral boundaries rather than a line-count quota: helper
header/injection checks give way to real HTTP/WS coverage, duplicate successful
RPC/UI setups fold into lifecycle transitions, and copy-only assertions are removed.
Auth, origin/source checks, process cleanup, delayed-timer expiry and split-log
parsing remain; independent review rejected deleting the latter two as redundant.
Stories remain available for every presentation state. This is test-only cleanup,
not a change to product behavior or an expansion of live-network acceptance.

## Storybook state coverage (2026-09-23)

Browser presentation now has one owner, `SessionBrowserPanelView`, consumed by the
production controller and 38 state stories; 12 controller stories exercise real
navigation handlers against synthetic RPC data. This avoids copying product UI or
requiring a live tunnel for visual review. The extraction keeps controller state,
authorization and endpoint lifetime unchanged. The two permanent rows below the
address bar are gone: one compact status control uses distinct local, connected,
creating/checking, expired/closed and failed/unavailable icons plus an accessible
name, and opens a popover with the local/remote relation, diagnostics, essential
facts and applicable recovery/stop-sharing actions. Coverage includes local/remote
sharing, creation/checking, every distinct closed/failed presentation, restore and
its unavailable reasons, open popovers, page loading, annotation toolbar state,
history, diagnostics, public-browser unavailability, narrow layout, dark mode and
Chinese.

The real Managed Preview surface displays inert fixture HTML for active-page stories.
That verifies presentation, not remote credentials, native Electron content, annotation
messaging or Cloudflare connectivity. The original 31 controller/surface tests pass.
All 50 stories passed the browser sweep, which captures each story and checks completion,
browser errors, open status popovers and recovery controls; popover play helpers
activate the address-bar trigger with a real Enter key, while controller stories
separately cover real keyboard Enter in the address field. The static Storybook build
passed with an 8 GB Node heap (4 GB exhausted the heap). Resolved font-package directories are explicitly
allowed by Storybook's dev server for embedded pnpm installs; the private repo is not
added to its filesystem allowlist.

Deployed control integration, artifact publication, actual iframe/WS credentials,
real-network health behavior and broad acceptance checks remain required. This record stays proposed until implementation and
evidence cover the full contract.
