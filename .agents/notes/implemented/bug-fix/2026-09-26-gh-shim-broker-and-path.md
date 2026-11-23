# Keep agent `gh` on the Lody shim

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1026

[中文](2026-09-26-gh-shim-broker-and-path.zh.md)

## Abstract

Long-running agent sessions in GitHub repositories failed every `gh` call with
HTTP 401 about an hour in, while `git push` kept working. The agent PATH put the
system `gh` ahead of Lody's `gh` shim, so agent shells never ran the shim; the
system `gh` read a launch-time installation token until it expired. The PATH merges
now pin the session's shim dir first. The shim's own broker lookup and the global
`GH_TOKEN` injection, also involved in the incident, were replaced on `main` by
[per-command GitHub credentials](../architecture/2026-09-26-github-command-credentials.md)
(#1034) before this landed, so this change keeps only the PATH fix.

## Evidence

Observed in a Claude Code session on a Linux host, before #1034:

- The agent's `GH_TOKEN` was the session-start `ghs_` installation token (its
  SHA-256 matched `LODY_MANAGED_GH_TOKEN_SHA256`); installation tokens last about an
  hour, and per-turn refreshes never reach an already-running agent process.
- The shim dir was PATH entry 21, behind `/usr/bin` at 17. The session env prepends
  the shim, but `mergeLoginShellEnv` then puts the login-shell PATH first and
  `withDefaultAcpPathEntries` prepends `~/.local/bin` and friends.
- `BASH_ENV` re-prepends the shim, but Claude Code's shell tool then sources its
  snapshot, whose `export PATH=…` replaces PATH wholesale. On the same host the
  snapshot PATH equalled the agent process PATH with one plugin dir appended, so the
  process PATH order is what agent shells get.
- Invoked directly, the shim still returned no token: after a broker restart the
  session's broker URL refused connections, and the shim ignored the per-workspace
  state file the git credential helper reads. It then ran `gh` silently without a
  token, so `gh auth status` looked like a plain logout.

## Decision

`mergeLoginShellEnv` and `withDefaultAcpPathEntries` in `agent/setting.ts` keep a
shim dir first when the base PATH leads with one (`getLeadingGhShimBinDir`).
`prependGhShimBinDirToPath` puts the session's own dir there. Since #1034, shim dirs
are per workspace broker (`gh-session-bin/<hash>`). A shim dir elsewhere in PATH may
belong to another workspace: a daemon started inside a Lody agent inherits that
agent's dir, and so does its login-shell PATH. An earlier revision promoted the first
`gh-session-bin` entry found. Review showed this routed the session's `gh`/`git`
through the other workspace's broker, so only a leading base entry now counts. The
rule lives in the merge functions because ACP spawn, ACP authentication, Session
`buildShellEnv`, and the terminal PTY all compose them. The shim dir also holds the generated `git` transport, which benefits equally.

The branch originally also made the shim read `LODY_GIT_CRED_BROKER_STATE_FILE`
first and print unreachable-broker errors. #1034 superseded both: the daemon bakes
the workspace broker's state path into each shim, child environment variables can
no longer select the broker, and a missing credential fails with an explicit error.
The merge keeps `main`'s shim unchanged. #1034 also stopped injecting a startup
`GH_TOKEN`, which resolves the option this branch had deferred.

## Verification and limits

- `tests/agent-setting.test.ts` composes `withDefaultAcpPathEntries(mergeLoginShellEnv(…))`
  from a session PATH carrying a workspace broker's shim dir and asserts it comes first,
  including when the login shell carries another workspace's shim dir, which stays in
  place when the base PATH does not lead with it.
- A login-shell rc file that prepends a directory containing its own `gh` inside
  Claude Code's snapshot could still shadow the shim; not observed.
- The shim integration tests load the generated script as CommonJS. A
  `package.json` with `"type": "module"` in an ancestor of the temp dir (seen as
  `/tmp/package.json` on one host) makes Node load it as ESM and the shim tests fail;
  run them with a clean `TMPDIR`.
