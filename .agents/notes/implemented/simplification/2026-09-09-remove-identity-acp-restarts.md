# Preserve ACP processes across identity changes

Status: implemented
Translation: current

[中文](2026-09-09-remove-identity-acp-restarts.zh.md)

## Abstract

Identity changes previously killed the persistent ACP and its sandbox before restoring the
provider session, introducing startup latency and disrupting runtime state during requester
switches. This rollback removes that behavior for continued and adopted prepared sessions,
while preserving the owner/requester identity resolution policy. Host-side environment updates
remain; propagating them into an existing ACP without restart is an unresolved limitation.

## Decision

Partially supersedes the restart decision in
[machine owner identity](../feature/2026-09-08-machine-owner-git-identity.md), merged in
[PR #521](https://github.com/LodyAI/Lody/pull/521). Process continuity takes precedence over
forcing identity propagation through process replacement. Remove the launch snapshot,
restart-return contract, and unused internal termination APIs; retain ordinary termination.

An owner-started ACP may continue using its launch identity for adapter-owned Git commands
after another requester takes over. Host-side identity resolution still never falls back to
the machine configuration for a non-owner. A future live propagation solution must address
this gap without restarting the ACP or sandbox.

## Verification

Regression coverage checks that requester switches prompt the existing ACP and that a changed
identity preserves the adopted preparation. Neither path may create a replacement runtime.
