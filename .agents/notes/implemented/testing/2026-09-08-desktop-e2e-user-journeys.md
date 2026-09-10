# Expand desktop E2E around durable user journeys

Status: implemented
Translation: current

[中文](2026-09-08-desktop-e2e-user-journeys.zh.md)

## Abstract

The desktop regression suite covered bootstrap and three resource lifecycles but left
common catalog, metadata, and fork workflows at component or Node-test boundaries. Five
journeys were implemented and exercised against the real Electron renderer, IPC graph, and
bundled CLI. Agent Roles, workspace MCP selection, Session management, local-project removal,
and Session fork are active. The fork journey currently exposes a known product defect during
worktree commit and remains executable so the separate repair is regression-gated.

## Decision and scope

- Promote `LODY-MCP-001`, `LODY-ROLE-001`, and `LODY-SESSION-002` from the
  evidence-backed backlog, and register `LODY-PROJECT-001` as active P1 coverage.
- Activate `LODY-FORK-001` as P1 coverage. It reproduces the observed built-desktop failure:
  after the worktree and target ACP runtime are created, the second `forkOperation` LoroMap
  write fails with `Map value must be an object`. The product repair remains separate from
  this E2E change.
- Keep interaction policy in Page Objects and use observable durable state or process
  evidence for assertions. Gherkin remains a thin description of user outcomes.
- Seed the runtime-none Session journey through the renderer's real persisted workspace
  repo. This avoids starting an ACP provider while retaining the production data path.
- Reuse the reviewed synthetic Git fixture for the project journey.
- Add the MCP SDK only to the E2E development graph. The scripted ACP uses its stdio
  transport to start the configured synthetic MCP server and closes it with the Session,
  so process cleanup is measured rather than inferred from configuration forwarding.

## Evidence and limits

The suite checker confirms nine registry-matched active scenarios with unique stable IDs.
Three fresh focused built-desktop rounds each passed all four new active journeys and all 37
steps before the fork journey was activated. The corresponding full regression passed eight
scenarios and 62 steps. The active fork run reaches the asynchronous commit and retains a
trace, CLI backlog, screenshot, and process snapshot before teardown; it is expected to fail
until the separate product repair lands. Fixtures use explicit
file signals, process evidence, durable catalog reads, and Playwright polling, with no
wall-clock sleep or live external-provider dependency.
