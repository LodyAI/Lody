# Fix Windows scripted-agent command line quoting in e2e fixtures

Status: implemented
Translation: current

English | [中文](2026-09-18-windows-scripted-agent-command-quoting.zh.md)

## Abstract

The 2026-09-18 Daily was the first Windows leg to actually execute
scenarios after the tag-quoting fix in
[the cascade repair note](2026-09-17-daily-e2e-cascade-and-windows-tags.md),
and it failed 15/22: every agent-dependent journey hung 60s waiting for the
custom-command `Ready` probe. The fixture-emitted command line let Windows
paths pass unquoted (`\` was in the allowlist), but the settings dialog
tokenizes it with a POSIX-style parser where a bare `\` escapes the next
character — so `D:\a\Lody\script.mjs` became `D:aLodyscript.mjs` and the
spawned command resolved to a nonexistent executable. All 12 fixture copies
of `quoteCommandArgument` now share `fixtures/command-line.ts`, which forces
quoting for any token containing a backslash. Verified by `pnpm e2e:check`
and a new tokenizer round-trip test; the Windows leg itself can only be
proven by the next Daily run.

## Evidence

- Run 35317896229: 7 agent-free UI journeys pass; all 15 agent journeys
  fail identically on `getByText('/^(Ready|就绪)$/u')` with a 60s timeout.
- `scenarios/lody-agent-001/agent-provider-lifecycle-acp.ndjson` has **0
  lines** — the scripted agent never wrote a single event, so the process
  never started.
- `cli-backlog.json` shows a healthy daemon ("Local agent service is
  ready", mcp-http serving on `127.0.0.1:55438`) — the machine RPC path
  that PROJECT journeys exercise was alive, isolating the failure to the
  custom-command spawn.
- Reproduced locally: `parseCustomAcpCommandLine` on
  `C:\hostedtoolcache\...\node.exe D:\a\Lody\script.mjs` returns
  `{command: 'C:hostedtoolcachenode.exe', args: ['D:aLodyscript.mjs']}` —
  every `\x` eaten as a POSIX escape.

## Root cause

`quoteCommandArgument` was copied into 12 fixtures with an allowlist
`[A-Za-z0-9_./:\\-]` that kept `\` and `:` unquoted — readable intent, but
the consumer is `parseCustomAcpCommandLine`, where an unquoted backslash
escapes the next character. Latent since the fixtures were written; the
Windows leg simply never executed a scenario before #783 unblocked it.

## Fix

- New shared `e2e/src/support/fixtures/command-line.ts`; the allowlist is
  now `[A-Za-z0-9_./:@-]` (also folding in the lifecycle variant's `@`).
  Backslash forces quoting; inside double quotes the parser treats `\\` as
  a literal backslash, so the round-trip is exact on both platforms.
- Escape set narrowed to `["\\]` (was `["\\$\`]`): the parser only treats
  `\"` and `\\` as escapes inside quotes, so escaping `$`/backtick produced
  a spurious literal backslash in the parsed token.
- All 12 local copies replaced by the shared import, eliminating the drift
  that let the lifecycle fixture carry a divergent regex.
- `command-line.test.ts` pins the contract with a POSIX-tokenizer oracle
  (the shared parser is not importable from the e2e package): Windows paths
  emit quoted with doubled `\`, and a Windows argv round-trips exactly.

## Verification limits

`pnpm e2e:check` is green (suite contract 22 scenarios, dry-run, tsc, unit
tests). The Windows leg can only be proven by the next Daily — same caveat
as #783: macOS cannot exercise the Windows spawn path. If the leg still
fails, next suspects are the ACP stdio handshake or named-pipe env
propagation into spawned grandchildren; the empty agent event log proves
spawn failure was the first break, so those layers were never reached.
