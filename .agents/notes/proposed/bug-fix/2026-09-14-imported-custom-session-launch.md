# Resolve imported custom sessions from machine-owned configuration

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/689

[中文](2026-09-14-imported-custom-session-launch.zh.md)

## Abstract

Imported custom ACP sessions retain their provider identity but not the agent configuration id that originally launched the provider. Session resume therefore cannot recover the custom command even when the same machine still has exactly one matching configuration. Resolve that unique match from the already-open target-machine Flock, while treating zero or multiple matches as unresolved so no arbitrary executable can be selected.

## Problem

External history import materializes a local session with `cliType`, `agentType`, and `externalHistory`, but no `agentConfigId`. Builtin and registry providers can reconstruct their executable from static provider metadata; a custom provider needs the machine-owned `customAcp`, environment, and runtime override fields. The launch resolver currently returns before consulting any agent configuration when the id is absent, so opening the imported session reaches resume without a custom command and fails with `session_restore_failed`.

History synchronization resolves its launch on the daemon under the target machine's authority. Session resume must preserve that boundary: imported metadata and control-plane callers must not supply an executable path.

## Decision

When an externally imported session has no `agentConfigId` and `cliType` is `custom`, scan the `agentConfig` family in the target machine's already-open Flock and match the session's `cliType` plus `agentType`:

- exactly one match supplies the current `customAcp`, environment, and runtime overrides;
- no match preserves the existing unresolved result;
- multiple matches are ambiguous and also remain unresolved;
- non-imported sessions, sessions with an explicit id, builtin and registry providers, and legacy per-session fields retain their existing resolution paths.

This intentionally follows current machine configuration, so updating the custom command updates later resumes without rewriting imported session metadata. It also avoids widening the session or control-plane schema with executable fields.

## Verification

The focused resolver suite covers a unique match, current-command updates, no match, ambiguity, non-imported legacy preservation, and the existing explicit-id behavior. A live third-party custom ACP process is not launched by this test.
