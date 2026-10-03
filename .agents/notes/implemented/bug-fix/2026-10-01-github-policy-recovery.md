# Recover transient GitHub policy lookup failures

Status: implemented
Translation: current

[中文](2026-10-01-github-policy-recovery.zh.md)

## Abstract

The GitHub transport queries identity policy before any remote operation, including
public dependency downloads. A transient broker failure therefore interrupted Git,
UV and inherited hook subprocesses before credential selection. The shared runtime
now retries this read-only lookup once and reports safe failure categories. Personal,
owner-local and App precedence is unchanged; persistent outages still fail closed.

## Decision and evidence

This extends [per-command credentials](../architecture/2026-09-26-github-command-credentials.md).
Retry connection/timeouts, missing broker state and HTTP 500/502/503/504 once after
250 ms, passing the existing 10-second request timeout on each attempt. Each request reloads the
workspace broker state; both attempts retain the helper's original requester context.
Never retry authentication denial, revoked context, malformed successful policy,
credential selection or the actual Git/gh operation through this retry loop.
Only allowlisted error codes and HTTP status reach stderr; exception messages and
response bodies may contain secrets. No cached preference or anonymous-first path
is introduced because either could bypass a newly selected personal identity.

Synthetic fault injection with the generated transport and real Git/Make/UV showed
that a policy 503 blocks a public dependency, clearing injected config makes the
same dependency available, and a later child inheriting the original environment
fails again. Restoring the policy service lets the unchanged environment succeed.
The hook experiment used a shell child, not an actual agent Stop lifecycle.

Runtime tests cover restored personal/local/App priority, bounded and redacted
failures, and requester revocation between attempts. A native recursive submodule
clone gets a first-request 503 and a rotated broker token, proving recovery rereads
the workspace state and completes the checkout. These fixtures do not establish
why any particular deployed identity service failed. Persistent authorization or
service failures still require investigation with their now-visible error category.

Before/after fault injection also verified real Git and Make/UV recovery using the
same generated transport and public dependency. The old runtime failed the bounded
transient-failure scenarios; the patched runtime completed them. The generated gh
test verifies personal identity still wins after recovery, before executing a write.
After initializing the pinned ACP submodules, all 89 tests in the runtime, Git
transport, broker and gh suites pass. Existing gh transport limitations remain:
its abort timer ends at response headers and fetch exceptions become a null
response. Thus retries are bounded in count, not guaranteed end-to-end gh elapsed
time, and gh connection diagnostics can still report generic broker unavailability.
