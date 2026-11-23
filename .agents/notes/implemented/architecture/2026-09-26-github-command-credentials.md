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

Startup correction: the earlier auth tests stopped at `ensureRepo`, missing the
second fetch inside `createWorktree`. That fetch lost requester context and blocked
new conversations. Creation now owns preparation under its lock and receives the
frozen auth through checkout/retries as well. Missing bare caches are cloned before
restore-branch validation; native broker-less execution no longer installs the
managed helper. Native Git fixtures now run the generated helper through clone,
fetch, speculative creation, cache-loss restore and credential-using smudge filters;
they also cover native auth, caller isolation and rejected context. Remote Git and
broker responses are synthetic, not a live GitHub or platform-keychain smoke test.
The HTTPS transport also stopped prefixing an empty `GIT_CONFIG_PARAMETERS` with
whitespace, which native Git rejects before contacting the remote. Native parser
tests cover absent, empty and inherited configuration with App/personal identities.
The generated Git wrapper classifies checkout as a remote read and preserves that
classification in credential subprocesses; nested pushes still require write access.
The smudge fixture runs this wrapper with a read-only personal token and no App fallback.

Review correction: `gh` originally skipped write-capability preflight. Known
commands now check push/admin before selection; comments/reviews and fork-head
updates must not inherit that requirement. Policy outages are distinguished from
invalid session context, without caching stale identity preferences. Unresolved
targets explain the managed-identity boundary instead of silently using local auth.

The PR-owning session ID now accompanies both PR panels and diff comments. One
identity hook gates reads and writes; comment writes also verify the numeric ID
against GitHub. Unresolved legacy identity has explicit error/retry UI and one
automatic safe repair attempt. A matching name alone never releases that gate.
Hook tests cover repair/retry, name reuse and blocked writes; the review notice has
dedicated Storybook states. Live deployment and platform smoke checks remain open.

See [the draft specification](../../../../specs/github-command-credentials.md).
Implementation is present, with deterministic policy, generated-command and native
Git advertisement tests. Adversarial review of supported standard URLs found no
remaining blocker after corrections. No live service
deployment or real-user credential mutation has been performed. The CLI bundle
also builds after preparing its ACP adapters and review assets.

CI exposed an outdated global-helper assertion; native Git credential-fill tests
now verify GitHub-only routing and preservation of other hosts' helper chains.
Desktop PR E2E checks out the merge ref, keeping local actions aligned with the
merged workflow instead of combining a new workflow with an older head tree.

PR: [#1034](https://github.com/LodyAI/Lody/pull/1034).
