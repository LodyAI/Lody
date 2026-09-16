# Devin runs the user's local CLI instead of a managed binary

Status: implemented
Translation: current

[中文](2026-09-16-devin-local-runtime.zh.md)

PR: https://github.com/LodyAI/Lody/pull/763

## Abstract

Devin previously shipped as a `binary`-distribution registry agent: Lody
downloaded a pinned Devin CLI archive into `acp-bin/` and launched that managed
copy. It now joins the curated local-agent list, so Lody spawns the user's own
`devin acp` from PATH (the ACP spawn env already prepends `~/.local/bin`, `~/bin`,
`~/.claude/local`). The trade-off is deliberate: sessions run the Devin version
the user installed and updated, but the zero-install path is gone — a machine
without `devin` on PATH fails at spawn rather than downloading a runtime.

## Decision and evidence

`scripts/generate-acp-registry.mjs` gains a `devin` entry in
`LOCAL_REGISTRY_AGENTS` (`command: 'devin'`, `args: ['acp']`,
`versionArgs: ['--version']`), and the regenerated
`packages/shared/src/acp/registry-generated.ts` drops the six per-platform
`static.devin.ai` archives for a `local` launcher. Because launch-kind priority
is `local > npx > uvx > binary`, no caller changes were needed: the sync launch
resolver now serves Devin directly, the `machine/acp-binary-*` status/install
round-trip reports `not-applicable` (mapped to installed), and the agent-config
dialog no longer shows the Download gate. Capability cache keys keep the
upstream registry version (`devin@<version>`).

The alternative — prefer local but fall back to the managed binary when `devin`
is missing — was considered and rejected in favor of matching the existing
cursor/goose/junie local-only semantics; a `local + binary` hybrid would need
new PATH-detection and fallback plumbing for one agent. Users without the CLI
can still point a Custom ACP provider at any `devin acp` command.

## Verification

The registry generator was re-run; the only content diff is the Devin
distribution swap plus the generated timestamp, and the icon bundle was
unchanged. `node --test scripts/generate-acp-registry.test.mjs` passes (3
tests). Full `pnpm check` could not run in this worktree (no installed
dependencies). Spawn behavior for a missing `devin` (ENOENT surfaced through the
ACP startup monitor) is inherited from the existing local-agent path and was not
re-tested end to end.
