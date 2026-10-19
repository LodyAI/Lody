# Git transport exec-path probe must not fail session startup

Status: implemented
Translation: current

[中文](2026-10-14-git-transport-exec-path-probe.zh.md)

## Abstract

Starting a conversation on a managed GitHub session could fail before the
agent launched with `turn_pre_prompt_failed` and the raw message
`spawnSync /usr/bin/git EAGAIN`. `ensureGitHubGitTransport` ran a synchronous
`git --exec-path` probe on every session preparation, so one transient fork
failure killed the turn. The probe result is now recorded in a
`lody-git-transport.json` marker inside the shim directory: a matching marker
skips the probe entirely, a still-needed probe retries transient spawn errors
(`EAGAIN`/`EBUSY`/`ETXTBSY`/`ENOMEM`) with bounded backoff and a 10-second
timeout, and a probe that still fails falls back to any usable recorded
layout. Preparation throws only when no recorded layout exists and the probe
keeps failing — a machine that cannot fork there cannot spawn the agent either.

## Evidence

- `prepareGitHubRepoSessionConfig` → `ensureGhShimSessionEnv` →
  `ensureGhShimScript` → `ensureGitHubGitTransport` ran
  `execFileSync(realGit, ['--exec-path'])` synchronously inside session
  creation. The thrown `spawnSync <git> EAGAIN` reached
  `recordPrePromptFailure` as a non-ACP error and was recorded as
  `turn_pre_prompt_failed` before `promptStarted`.
- The probe's only outputs — `execPath` and `nativeGit` — are constants of the
  resolved Git installation. Re-deriving them every session added a
  synchronous fork (and its event-loop stall) to every conversation start.
- The generated adapters are deterministic content for a given
  `(realGit, statePath)`; `writeIfChanged` already re-materializes them on
  every call, so skipping only the probe cannot pin stale adapter code.

## Decision

The marker records `{version, realGit, statePath, execPath, nativeGit}` and is
written last, only after a complete materialization. It is usable when the
recorded `execPath` still exists and `nativeGit` is still executable; an exact
`realGit`+`statePath` match then skips the probe. The probe itself retries
transient spawn codes four times with 100 ms `Atomics.wait` backoff — the same
transient classification `code-collab-v2-service.ts` already uses — and is
bounded by a 10-second timeout so a wedged Git cannot stall the daemon event
loop, matching the `git config` timeout precedent in `git-identity.ts`. A
mismatched-but-usable marker remains an emergency layout source when the probe
fails: its recorded Git is still a working Git, and regenerating identical
adapters from it beats failing startup on a transient error.

## Alternatives

- **Retry only**: leaves startup exposed whenever the pressure outlives the
  backoff, and keeps a per-session synchronous fork the result never needed.
- **Process-lifetime cache only**: survives no daemon restart; the marker
  persists the layout across restarts, which is where repeat sessions live.
- **Degrade to native Git without the transport**: the generated adapters own
  credential-policy selection (managed vs. local fallback, read/write
  classification, advertisement verification). Starting a session without
  them silently weakens that policy, so the code keeps failing closed when no
  layout can be established at all.

## Verification and limits

- `github-git-transport.test.ts` gains six cases: marker contents, probe
  skipped on a matching marker, transient retry success, no retry on
  `ENOENT`, throw when nothing is recorded, and stale-marker reuse with a
  warning. All pass; `gh-shim-script.test.ts` and
  `worktree-manager-broker-auth.test.ts` remain green.
- The pre-existing `clones recursive native SSH submodules` case fails
  identically on the base commit in this environment (`context_unreadable`);
  it is unrelated to this change.
- The daemon still fails startup when the very first probe cannot run and no
  marker exists; in that state the ACP spawn would fail anyway, so the early
  throw keeps the honest error.
- `git-identity.ts`'s `readGitConfig` makes the same synchronous Git call but
  already swallows failures; no change needed there.
