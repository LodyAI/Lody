# Restore Devin's managed registry binary

Status: implemented
Translation: current

[中文](2026-09-18-devin-managed-binary-restoration.zh.md)

## Abstract

The registry Devin provider required a globally installed `devin` command, so a fresh Lody
installation could configure the provider but could not start it. Devin now retains the official
binary distribution supplied by the ACP registry and uses Lody's existing registry download,
cache, and setup-progress flow. This restores zero-install startup on the six supported platform
targets; using a user-managed Devin version remains available through Custom ACP.

## Decision

This decision partially replaces the launch choice in
[Devin runs the user's local CLI](../simplification/2026-09-16-devin-local-runtime.md). Removing
Devin from `LOCAL_REGISTRY_AGENTS` stops the generator from discarding its upstream distribution.
The generated catalog therefore classifies Devin as `binary`, which already has the required
behavior across the product:

1. Provider setup checks the selected machine and installs the archive before probing Devin.
2. Session startup resolves the cached executable asynchronously and downloads it on demand if
   setup did not already do so.
3. The binary manager deduplicates concurrent installs, publishes only completed extractions, and
   reports unsupported platforms explicitly.

A local-first fallback was not added. Resolving a GUI process's effective login-shell `PATH`
before choosing a distribution would add a second launch policy and make provider setup depend on
ambient machine state. Custom ACP already provides the explicit user-managed executable path.

## Evidence

- The ACP registry published Devin binaries for Darwin, Linux, and Windows on both supported CPU
  architectures when this change was made.
- The generated catalog contains those six binary targets and no local Devin launcher.
- `agent-setting.test.ts` asserts that synchronous local resolution rejects Devin and the binary
  targets remain present.

## Verification

- `agent-setting.test.ts` and `acp-binary-manager.test.ts`: 52 tests passed.
- Registry generator tests: 3 tests passed.
- Shared and CLI typechecks passed.
- Documentation checks and scoped formatting checks passed.
- HTTP HEAD requests returned 200 for all six pinned Devin archives.

No real Devin login or authenticated ACP session was run.
