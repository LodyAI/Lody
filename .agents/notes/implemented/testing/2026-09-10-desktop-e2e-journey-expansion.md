# Extend desktop E2E across local user workflows

Status: implemented
Translation: current

[中文](2026-09-10-desktop-e2e-journey-expansion.zh.md)

## Abstract

The desktop regression suite lacked durable coverage for message queues, MCP catalog editing,
repeated project selection, appearance preview cancellation, and Session read state. Five P1
journeys now exercise those workflows through the built Electron app, real IPC graph, and bundled
CLI. Existing Session, Review, MCP, Role, Work, and Fork journeys were also hardened so navigation,
project registration, Archive cleanup, and Session creation use visible controls instead of route
assignment or renderer-side state writes. The resulting 14-scenario suite passes end to end.

## Decision and scope

- Register `LODY-QUEUE-001`, `LODY-MCP-002`, `LODY-PROJECT-002`,
  `LODY-SETTINGS-001`, and `LODY-SESSION-003` as active P1 journeys. Each scenario owns a
  synthetic fixture, thin Gherkin steps, Page Object interaction policy, and observable cleanup.
- Keep three journeys on `runtime-none`: they use the real desktop process tree and durable local
  state without launching an ACP model. The queue journey uses a file-signaled ACP process so
  the current Turn completes only when the test releases it and the exact submitted prompt modes
  remain observable. Session read-state coverage creates both Sessions through the composer and a
  scripted ACP provider.
- Assert persisted outcomes instead of control calls: MCP fields survive settings reopen, project
  catalog identities survive a duplicate add, committed appearance survives preview cancellation,
  and opening an unread Session restores its history and clears its read marker.
- Require active registry rows to have a null `blockedReason`, quarantined rows to explain their
  state, and every non-null reason to contain useful text. This keeps selection state and human
  triage evidence from contradicting each other.
- Let nested sidebar controls own bubbled keyboard events. A disclosure activated with Enter must
  expand or collapse opened Sessions without first selecting and navigating its parent row.
- Do not register projects through IPC, seed Session documents through `window.repo`, or navigate by
  assigning a route hash. Users configure providers, send prompts, choose files, open sidebar rows,
  invoke menus, archive, and delete through visible controls. Renderer evaluation remains read-only.

This extends the [initial durable journey expansion](2026-09-08-desktop-e2e-user-journeys.md);
it does not change product intent or protocol guarantees, so no Spec revision is required.

## Evidence and limits

Correction: the original opened-Session scenario directly seeded two persisted documents and set
`openedBySessionId` through the renderer repository. Its focused pass did not prove a user journey.
The replacement `LODY-SESSION-003` covers read-state transitions with two Sessions created through
the composer and passes its focused run.

After the bypass removal, all 14 scenarios and 112 steps passed in 2m01.627s. The suite checker
matches 14 active scenarios to 14 unique registry IDs: three P0 and eleven P1. The components suite
passed 446 files and 3,350 tests, including the nested-keyboard regression coverage.
