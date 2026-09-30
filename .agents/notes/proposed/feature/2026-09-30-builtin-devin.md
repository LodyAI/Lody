# Builtin Devin and registry deduplication

Status: proposed
Translation: current

[中文](2026-09-30-builtin-devin.zh.md)

## Abstract

Devin was discoverable only through the external ACP registry. This change adds a
pinned adapter submodule and a builtin that consumes a verified official runtime
through the managed channel. Discovery excludes duplicate Devin, Dimcode and Kimi
entries while existing configurations retain their launch contracts. Source and
protocol checks succeeded, but complete publication and validation remain pending.

## Decision and evidence

Unlike [Pi](../../implemented/feature/2026-09-17-builtin-pi.md), Devin is a bundled
proxy over a native official runtime, not an isolated Node dependency closure.
Its pinned runtime manifest publishes six exact-version source checksums. Unix
archives are transcoded; Windows ZIPs are reproducibly repacked without changing
runtime bytes. Production pins require complete upload and readback verification.

An empty-home initialization of Devin 3000.11.3 advertises the `devin-browser`
ACP authentication method. Route that through existing ACP authentication instead
of guessing a native login command or falling through to Claude. Do not convert
existing provider identities or session IDs as part of discovery cleanup.

The adapter declares a bin but no package-root import entry. Import its published
`dist/index.js`. Its filesystem-relative manifest read breaks after bundling, so
public and cloud Vite builds share `devinRuntimeContractPlugin`, inlining the
pinned source manifest while retaining validation. A changed loader fails the
build explicitly. The development build keeps the adapter external at its
original location.

## Verification limits

Registry generation/filtering and source-manifest rejection tests pass. Shared and
component typechecks, all 39 adapter tests, and both relocated-bundle tests pass.
An isolated checkout using locally generated candidate pins passed 121 CLI tests,
CLI typechecking, a 2 GB Vite build and the published-bundle checks. The draft PR includes these locally verified candidate pins so it can build.
Channel publication remains incomplete. All six canonical objects must pass
upload/readback verification before merging or releasing this change. With
preseeded pins, repeat the mirror run after upload to verify every remote object.
The [draft contract](../../../../specs/builtin-devin.md) does not claim release readiness.
