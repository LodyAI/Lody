# Keep agent `gh` on the Lody shim and the session's own broker

Status: implemented
Translation: current

[中文](2026-09-26-gh-shim-broker-and-path.zh.md)

## Abstract

Long-running agent sessions in GitHub repositories started failing every `gh` call
with HTTP 401 about an hour in, while `git push` kept working. Two defects stacked:
the agent PATH put the system `gh` ahead of Lody's `gh` shim, so `gh` read the
launch-time installation token until it expired; and even when called directly, the
shim could not find a restarted credential broker because it ignored the session's
per-workspace broker state file. The shim dir is now pinned first in every agent
PATH, and the shim resolves its broker exactly like the git credential helper and
names an unreachable broker on stderr. The session still injects `GH_TOKEN`, so a
`gh` that bypasses the shim can still go stale.

## Evidence

Observed in a Claude Code session on a Linux host:

- The agent's `GH_TOKEN` was a `ghs_` installation token whose SHA-256 matched
  `LODY_MANAGED_GH_TOKEN_SHA256`: the session-start copy. Installation tokens last
  about an hour; the per-turn refresh in `refreshGhTokenForSession` updates the
  Session's config env, which an already-running agent process never sees.
- `~/.lody/bin` was PATH entry 21, behind `/usr/bin` at 17. The session env prepends
  the shim, but `mergeLoginShellEnv` then puts the login-shell PATH first and
  `withDefaultAcpPathEntries` prepends `~/.local/bin` and friends.
- `BASH_ENV=~/.lody/bashenv` re-prepends the shim, but Claude Code's shell tool then
  sources its snapshot, whose `export PATH=…` replaces PATH wholesale. On the same
  host the snapshot PATH equalled the agent process PATH with one plugin dir
  appended, so the process PATH order is what agent shells get.
- Invoked directly, the shim still returned no token: the session's
  `LODY_GIT_CRED_BROKER_URL` refused connections after a broker restart, and the
  new address was only in the file named by `LODY_GIT_CRED_BROKER_STATE_FILE`.
  The git credential helper reads that file first (added in #8); the shim read only
  the shared `broker.json` paths. The shim then ran `gh` without a token and printed
  nothing, so `gh auth status` looked like a plain logout.

## Decision

- `pinGhShimBinDirFirst` in `agent/setting.ts` moves the shim dir to the front in
  both `mergeLoginShellEnv` and `withDefaultAcpPathEntries`. It only moves an entry
  already present, so envs that never had the shim are unchanged. It is enforced at
  the merge functions rather than at each spawn site because ACP spawn, ACP
  authentication, Session `buildShellEnv`, and the terminal PTY all compose them.
- The shim's `BROKER_STATE_PATHS` starts with `LODY_GIT_CRED_BROKER_STATE_FILE`, and
  a failed broker request writes one stderr line naming every URL tried and the
  error code, then continues without a managed token as before.

## Alternatives

- **Stop injecting `GH_TOKEN` and rely on the shim alone.** A `gh` that bypasses the
  shim would fail immediately instead of an hour later, which is easier to diagnose.
  Deferred: the injected token is also what non-shim consumers in the session read
  (scripts and SDKs using `GH_TOKEN`, Windows shells without `BASH_ENV`), the
  `ghTokenInjected` flag gates the per-turn refresh and user-token detection, and
  with the shim pinned first and the broker recoverable the remaining bypass is
  narrow. Revisit if a stale-token 401 recurs with the shim first in PATH.
- **Fix only `BASH_ENV`.** Rejected: agent shells may replace PATH after sourcing it,
  as Claude Code's snapshot does.

## Verification and limits

- `tests/agent-setting.test.ts` composes `withDefaultAcpPathEntries(mergeLoginShellEnv(…))`
  from a shim-prefixed session PATH and asserts the shim dir comes first.
- `tests/gh-shim-script.test.ts` runs the generated shim against a refused loopback
  port: with a state file it fetches from the restarted broker; without one it names
  the dead URL and `ECONNREFUSED` on stderr. Both fail without the fix.
- A login-shell rc file that prepends a directory containing its own `gh` inside
  Claude Code's snapshot could still shadow the shim; not observed.
- The shim integration tests load the generated script as CommonJS. A
  `package.json` with `"type": "module"` in an ancestor of the temp dir (seen as
  `/tmp/package.json` on one host) makes Node load it as ESM and all shim tests fail;
  run them with a clean `TMPDIR`.
