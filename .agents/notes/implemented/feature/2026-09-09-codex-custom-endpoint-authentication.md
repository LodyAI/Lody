# Codex Base URL and API Key setup

Status: implemented
Translation: pending

## Abstract

Codex setup offers ChatGPT device login and a Base URL + API Key mode in onboarding and
Settings. The custom mode uses a generated Responses API provider while keeping its credential
on the execution host.

## Decision

Workspace state stores only non-secret provider metadata. The renderer passes the API key through
the existing encrypted ACP authentication-input exchange. The target CLI stores it under
`provider-credentials`, hardens POSIX directories/files to `0700`/`0600`, and binds each local
record to both an explicit credential revision and the complete launch-relevant configuration.
Windows inherits the ACL of Lody's per-user data directory. Capability probes and sessions inject
the key only on an exact revision and binding match.

The provider uses a Lody-owned environment key and a separate ownership marker. The marker records
the previous `model_provider` selector so switching back to ChatGPT is reversible without
copying an existing `CODEX_API_KEY` or reserved provider into Lody state. Invalid JSON and
namespace collisions fail rather than being normalized or overwritten.

The feature requires a negotiated `codexCustomEndpointCredentials` capability. A setup row names
the expected non-secret credential revision and starts in `awaiting-auth`. The explicit
credential-provisioning RPC waits for that exact row on the target daemon, so an asynchronous
Flock upload cannot race config lookup. It always elicits and replaces the submitted key, even
when the same endpoint already has a hydrated credential. Remote HTTP endpoints are rejected;
HTTPS and loopback HTTP are accepted.

## Failure and cleanup

A credential-changing edit is a replacement setup saga: the old AgentConfig remains published
while the new revision and key are staged and probed. The target daemon atomically publishes the
new config only after verification. A renderer crash at any earlier point leaves the old config
usable, and cancellation removes only the staged revision.

Switching to ChatGPT or deleting a provider writes a durable cleanup intent before changing the
config. The UI never waits for the target machine. Its daemon reconciles the intent on events and
authoritative rescans, removes the requested local revision only after no published config or
setup references it, then consumes the intent. This also covers a daemon that observes only
`custom → deleted` and never sees an intermediate non-custom config.

## Evidence

The [draft specification](../../../../specs/codex-custom-endpoint-authentication.md) owns the
behavior. Shared tests cover endpoint policy, reversible overlays, collision rejection, malformed
configuration, credential revisions, and setup-row rejection. CLI tests cover delayed setup
visibility, forced key rotation, concurrent old/new local revisions, replacement publication,
durable cleanup replay, and binding mismatch. Component tests cover the one-shot payload and the
actual setup/cleanup Flock writer boundaries. A controlled loopback relay run with bundled Codex
0.153.4 observed a streamed
`POST /v1/responses` request with the configured model and matching bearer credential; the relay
returned an intentional 401 after recording only the boolean credential match.
