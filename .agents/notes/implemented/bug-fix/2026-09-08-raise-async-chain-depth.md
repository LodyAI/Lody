# Raise the asynchronous delegation chain limit

Status: implemented
Translation: current

[中文](2026-09-08-raise-async-chain-depth.zh.md)

## Abstract

The MCP asynchronous delegation guard rejected a command once its causal chain
reached five hops, which stopped deeper delegated work before an Operation or
target Session could start. The shared limit is now 32, and the executable
Operation model and review automation explanation use the same value. The guard
remains fixed and non-retryable at the boundary, so the larger budget increases
available delegation depth without removing the recursion protection.

## Decision and scope

- Set `LODY_MAX_CHAIN_DEPTH` to 32 in the shared orchestration contract.
- Replace hard-coded model checks with that shared constant and update the cap
  regression assertions.
- Keep `parentSessionId` rules and machine-side Review Automation ownership
  unchanged; this change concerns causal async hops only.
- Record the new behavior in the draft session-orchestration Spec for human
  review.

## Evidence and limits

The source and model changes were inspected with `rg` and `git diff --check`.
Targeted Vitest execution was attempted but could not start because this
checkout has no installed `node_modules` and therefore no `vitest` binary.
Deployed-client and long-chain runtime acceptance remains open.
