# Login-shell environment lifecycle

Status: draft
Translation: current

[中文](login-shell-environment-lifecycle.zh.md)

A GUI or daemon launch inherits a short PATH. Before starting user tools, Lody
probes the user's interactive login shell so tools installed by their profile are
available. A broken profile must not silently hide failed process cleanup behind
an apparently successful environment fallback.

## Probe ownership and outcomes

A finite native probe receives host selection/environment and process services.
Each candidate command has a Scope. Local cancellation reaches that command and
returns after its cleanup completes; unresolved cleanup reports failure and
retains the process recovery owner. Expected absence is separate from failure:
Windows, exhausted absent/unsupported candidates or a shell that completes without
probe output may return no environment. Only completed nonzero exits or an absent
executable allow trying the next existing candidate. Other startup, stream,
output-limit, execution-timeout and release failures must remain observable with
their complete failure and recovery ownership.

All candidate command waits share the original default 15-second Clock deadline;
a fallback does not receive a fresh budget. The existing bounded process-release
wait is additional to that execution deadline. Keep candidate order, profile argv,
multiline values, output limit and restoration of probe-only variables. Pure output
parsing remains an ordinary function. No new process backend is introduced.

## Compatibility caches

The remaining CLI/Electron caches are explicitly Legacy and use one probe kernel.
The CLI preserves its three-second local wait ceiling: pending probe work can
outlive an early empty overlay and later provide the real environment. Early probe
failure rejects; late failure is retained and reported, later async readers reject
with that failure, and later sync readers throw it. It must not become a successful
empty cache entry. Opt-out still returns the existing empty/absent overlay.
Electron retains failure in its existing cached Promise.

These caches have not yet migrated their background lifecycle. Native cache
ownership belongs to the application runtime/root Scope; a local wait ceiling does
not prove cancellation, completed cleanup or daemon shutdown joining. Remove the
probe Legacy facade after both application owners receive the native service.

## Evidence

Implementation: packages/shared/src/node/login-shell-env.ts and CLI/Electron cache
consumers. Decision: [native probe migration](../.agents/notes/implemented/architecture/2026-10-10-effect-login-shell-probe.md).
Behavior suites use injected clocks/signals and actual temporary profile exports.
The draft records changed failure behavior; checks and translations are not approval.
