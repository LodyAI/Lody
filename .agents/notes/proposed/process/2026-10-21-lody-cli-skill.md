# Lody CLI operating skill

Status: proposed
Translation: current

[中文](2026-10-21-lody-cli-skill.zh.md)

## Abstract

Agents running inside Lody sessions drive the `lody` CLI. Built-in help alone does not
tell them which runtime a command needs, how `LODY_SESSION_ID` is used as a fallback,
what a schedule draft looks like, or how to recover from sign-in and dispatch failures,
so they guess. The new `lody-cli` skill records these conventions in one place, maps
user intent to commands, explains sign-in and acceptance recovery, and flags commands
that need human confirmation. Sign-in guidance is agent-safe: a bare `lody login` blocks
for browser approval and can be silent when stdout is not a terminal, so the skill tells
agents to have the user run it or to use `--auth`.
Exact flags stay with `--help`. Verification covers the command tree and a focused
PTY/non-TTY login check; live agent dispatch remains untested.

## Decision

- Canonical copy at `.agents/skills/lody-cli/SKILL.md`, linked from
  `.claude/skills/lody-cli`, the same layout as the other repository skills.
- Audience is external: users who install `lody` globally or run `npx lody`, called by agents
  inside Lody sessions or by outside coding agents. The skill describes product behavior only
  and names no source paths, internal transports or build steps; maintainer evidence stays in
  this note.
- Scope is the signed-in cloud product only. The open-source local edition and the
  `migrate --from-oss` import are left out. The skill states this scope up front so
  agents do not apply cloud sign-in requirements to the local edition.
- Sign-in guidance is agent-safe: a bare `lody login` is not run from an agent; the
  user runs it in a terminal, or supplies a CLI API key through an approved secret
  channel for `--auth`. A read-only command is the auth probe, and the skill
  distinguishes invalid/expired Lody tokens from provider credentials.
- The hand-off flow names three work contexts (parent session, registered local
  project, GitHub repo) and records the defaults and conflicts of `--machine`,
  `--agent-config`, `--parent`, `--worktree` and `--branch`.
- The skill covers only what help does not: edition scope and runtime
  prerequisites, selector and pagination conventions, idempotency keys, the strict
  schedule draft from `packages/shared/src/schedule-control.ts`, and commands to
  confirm before running. The site-docs CLI page remains the user reference. Copying
  all of it would create a second, drifting reference.
- Recovery guidance distinguishes Lody credentials, browser authorization, network
  failures and provider authentication. It preserves credentials on connectivity
  failures and requires checking session acceptance before retrying create/chat.
  A finished turn still requires checking the reply against the requested outcome.
- Rejected alternative: generating the skill from the help output. That would add no
  information beyond `--help`.

## Evidence and limits

- Command tree and flags come from recursive `--help` of a cloud-composition
  `dist-dev` build on 2026-10-21. A script checked all 86 flags named in the skill
  against that dump, and a deliberately bogus flag was caught as a negative control.
  The published npm `0.107.2` help predates `--mcp-server-ids`; the skill describes
  that flag as version-dependent.
- Runtime claims were read from source. `project` uses local-project IPC.
  `refresh-capabilities` needs the daemon. `schedule` goes through daemon IPC on the
  local platform and writes the workspace replica directly in cloud builds.
  `operation list` reads this machine's SQLite store. `session create/chat/cancel`
  need the local runtime only when they target this machine; remote targets need the
  target online.
- Sign-in behavior was exercised in an isolated HOME with the published CLI: a bare
  `lody login` through a pipe produced no output for 15 seconds, while the same command
  under a PTY printed the device URL and polled. Recovery guidance was also checked against
  `commands/login.ts`, `lib/auth.ts`, `commands/daemon.ts` and the session dispatch/wait
  paths in `commands/session.ts` under `apps/cli/src`. This is a focused login check, not an
  end-to-end recovery test.
- Commands were not dispatched against a live workspace. The local-platform help tree was
  not dumped separately: `migrate` is known to be cloud-only from `apps/cli/src/index.ts`.
- When CLI flags change, the skill must be updated by hand; no automated check guards it.
