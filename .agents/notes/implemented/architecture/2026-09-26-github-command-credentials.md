# Per-command GitHub credentials

Status: implemented
Translation: current

[中文](2026-09-26-github-command-credentials.zh.md)

## Abstract

A session-wide token for the initial repository prevents later commands from using
other authorized repositories and overrides machine-local credentials. Selection
now uses a shared per-command policy with requester-bound broker context.
Machine-local credentials are eligible only for the machine owner, and explicit
personal identity takes precedence. Read-only preflight adds latency but avoids
replaying writes with a different identity; this is not OS-level isolation.

## Decision

Keep repo-scoped installation tokens. Do not broaden them to all authorized repos.
Use explicit personal/App candidates so checking preference does not mint an App
token or force managed identity before local auth. Git delegates only credential
reads to the native helper chain; forwarding store would leak managed tokens.
Recovery uses the workspace-specific broker file, never the last-writer global one.
Both standard HTTPS and SSH transports enter the selector: HTTP authorization
headers otherwise bypass credential helpers. Persistent native agent processes
discover rotated context from a per-session file instead of requiring a restart.

## Evidence and limits

See [the draft specification](../../../../specs/github-command-credentials.md).
Implementation is present, with deterministic policy, generated-command and native
Git advertisement tests. Adversarial review of supported standard URLs found no
remaining blocker after corrections. No live service
deployment or real-user credential mutation has been performed. The CLI bundle
also builds after preparing its ACP adapters and review assets.

PR: [#1034](https://github.com/LodyAI/Lody/pull/1034).
