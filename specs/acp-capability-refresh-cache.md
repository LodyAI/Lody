# ACP capability refresh cache

Status: draft
Translation: current

[中文](acp-capability-refresh-cache.zh.md)

A `machine/acp-capabilities-refresh` request asks a machine what an agent advertises. The
machine used to answer it the only way it could: start the agent, take its `session/new`
response, stop it. On an idle machine that is the most expensive recurring thing Lody does,
and the answer almost never differs from the one already stored.

## What the machine promises

The machine answers from the capability entry it already persisted when, and only when, that
entry was produced by a real probe and its `capabilitySourceVersion` is exactly the version the
current launch inputs would produce. That version covers everything Lody controls: the ACP
adapter build, the managed runtime version actually installed, a runtime-override path, a custom
launch command, and the environment values that change an agent's identity. Changing any of them
is a miss, so a cached answer can never describe a different binary than the one Lody would run.

An entry the machine cannot key on is never reused. If the expected version depends on work the
machine refuses to do without being asked — a managed runtime that is not installed yet — the
machine probes instead of guessing the version it would install. Entries older than a bounded
lifetime are re-probed, because an agent's slash commands, sub-agents, and model entitlements can
change in the agent's own configuration where Lody cannot see them.

A cached answer is indistinguishable from a probed one to the caller: it carries the same modes,
models, config options, commands, and capability entry, so a client writes it into its Machine
Flock rows the same way.

## What must still start the agent

Caching is the default path, not the only one. A request may set `force` to require a real probe,
and these do:

- The Settings refresh a person pressed, which exists because they changed something Lody cannot
  see in the launch inputs.
- Capability verification after authentication succeeds, where the question is whether the new
  credentials actually work and what the account now entitles.
- Onboarding's provider test and provider setup's verification, which exist to prove the runtime
  Lody just installed really starts.

`force` is absent on the wire by default; a machine treats absence as "you may answer from the
cache". An older machine that does not understand the flag still probes, which is the safe
direction for every forced caller.

## Refreshing is not a schedule

Startup capability discovery is one pass per client, recorded per config rather than per pass, so
a pass interrupted and restarted — losing presence does exactly that — does not re-probe configs
that already answered. Failed configs stay retryable. A client must not turn reconnection into a
recurring probe cycle; nothing in this protocol offers a refresh interval.

## Evidence

`packages/shared/tests/ai-capability-cache.test.ts` (reuse, expiry, unresolved version,
provenance), `packages/shared/tests/local-session-control.test.ts` and
`packages/loro-streams-rpc/tests/machine-rpc-server.test.ts` (the `force` flag on both
transports), `apps/cli/tests/session-execution-service.test.ts` (cache hit starts no agent;
override change, expiry, and `force` all do), `apps/cli/tests/agent-setting.test.ts` (the expected
version equals what a launch stamps, and is unavailable while a managed runtime is missing),
`packages/components/tests/startup-acp-capabilities-refresh.test.ts` (an aborted pass does not
re-probe what already answered). Measured behavior before the change is recorded in
`.agents/notes/implemented/bug-fix/2026-09-16-acp-capability-refresh-cache.md`. Draft for human
review; tests do not grant approval.
