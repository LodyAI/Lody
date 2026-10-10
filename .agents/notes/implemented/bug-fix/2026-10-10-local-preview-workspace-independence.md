# Local preview without a session workspace

Status: implemented
Translation: current

[中文](2026-10-10-local-preview-workspace-independence.zh.md)

## Abstract

Same-machine preview already had a local IPC channel and arbitrary-path permission,
but workspace resolution could reject an existing absolute file before path inspection.
Local resolution now checks durable session, machine, and child-owner identity
separately from workspace availability. Without a workspace it accepts absolute and
home-rooted paths as external readonly files, while relative paths still fail. This
addresses a reproducible failure mode; the screenshot's exact error is unconfirmed
without its technical details.

## Decision

The [cold-chat fix](2026-10-09-cold-chat-file-preview-workspace.md) reconstructs an
existing chat directory after runtime eviction. That preserves relative-path identity,
but still requires that directory for absolute local artifacts stored elsewhere.
The local resolver now represents an unavailable workspace explicitly instead of
substituting a chat directory, home directory, or process working directory.

`MessageHandler` validates undeleted, unarchived session and parent metadata on this
machine, rejects nested parents, and passes the owner identity to `FilePreviewService`.
The service checks the caller's asserted owner before inspecting the requested path.
Only a workspace-unavailable result permits path resolution without a root; other
resolution failures remain failures. The path policy accepts this state only with the
local arbitrary-path capability. No remote protocol or write capability is added.
Electron retains content IO, bounded reads, revision checking, and renderer-owned
opaque resources. Remote preview and Code Collab keep their existing workspace rules.

## Verification and limits

Regression tests use synthetic temporary artifacts with absent root/parent directories,
check local identity and readonly classification, reject relative-path substitution and
invalid ownership, and verify that remote reads still fail. Path-policy coverage also
checks home-rooted paths, missing files, and directories. All 57 owning tests pass;
the three new integration cases fail on the original implementation. CLI and full
repository typechecks, `pnpm format`, and `pnpm run docs check` pass. Documentation
retains existing warnings; no SHA-protected topic changed. Lint, i18n, and all four
repository boundary/import guards pass. Full `pnpm check` stops on failures in six
untouched CLI suites (3678 CLI tests passed). Rerunning those suites under an isolated
CommonJS temporary root and without the agent-session Git wrapper restores four;
Roost history and simulator capture lifecycle still fail (49 passed, three failed).
These unresolved checks prevent claiming full repository acceptance. No full Electron
UI reproduction or inspection of the user's specific file has been performed.
