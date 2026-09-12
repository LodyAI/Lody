# Expand desktop E2E into five cross-feature matrices

Status: implemented
Translation: current

[中文](2026-09-12-desktop-e2e-user-journey-expansion.zh.md)

## Abstract

Five P1 journeys now exercise feature matrices rather than isolated happy paths. Each matrix moves
the same user-owned state through multiple product surfaces, renderer reload, negative states,
cross-Session isolation, and UI cleanup. The journeys use visible controls in the built Electron
app, real IPC, the bundled CLI, and deterministic ACP providers. The attachment matrix also guards
a local-only defect where a cloud token incorrectly blocked the Electron file handoff. The active
registry contains 21 scenarios, and a Cucumber dry-run rejects ambiguous or undefined steps before
Electron starts.

## Decision

| Journey               | Interacting dimensions                                                                             | Negative and isolation proof                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LODY-SEARCH-001`     | Three titles, partial/case queries, rename reindex, reload, Archive, delete                        | Empty results exclude every title; Archive/delete remove only the target while the similar result remains   |
| `LODY-ATTACHMENT-001` | Picker cancel, attachment plus prompt, plain follow-up, reload, Archive restore, two Sessions      | Cancel cannot submit; the next turn and second Session cannot inherit the attachment                        |
| `LODY-GOAL-001`       | Capability gating, two Sessions, Pause, update, Resume, reload, Clear, Archive restore             | Invalid controls disappear; the independent Session has no goal snapshot or goal wire events                |
| `LODY-AGENT-001`      | Invalid draft, create, edit cancel, saved rename, two Providers, reload, two dispatches, delete    | Invalid/cancelled state cannot enter the catalog; each Session has distinct command and prompt evidence     |
| `LODY-CONTEXT-001`    | User/assistant prefixes, rich Markdown, reload, streaming export, completion, cancel, two Sessions | Prefixes exclude later turns and native fork targets; cancelled Session export excludes all primary history |

- Keep scenario-specific state beside each step module instead of extending the shared Cucumber
  World. Each journey uses a module-local `WeakMap`; fixtures own only synthetic provider signals
  and identifiers.
- Treat renderer reload as a persistence reconstruction boundary. The current harness removes its
  isolated data directories when Electron exits, so these scenarios do not claim full process
  restart persistence.
- Use explicit protocol or filesystem events to release held provider turns. No matrix depends on
  sleeps, scheduler timing, live models, or network services.
- Treat local file handoff as independent of cloud authentication. A workspace is always required;
  an authentication token is required only after local transfer is unavailable or fails and the
  caller must use cloud upload.
- Run all feature bindings through Cucumber dry-run as part of `e2e:check`. This extends the suite
  contract beyond registry metadata and TypeScript so duplicated and missing phrases fail early.

This extends the [previous workflow expansion](2026-09-10-desktop-e2e-journey-expansion.md).
It restores existing local-only attachment intent and adds verification coverage, so no Spec
revision is required.

## Evidence and limits

The generated coverage and suite contract match 21 active scenarios to 21 unique IDs: four P0 and
17 P1. Static Cucumber resolution covers 223 steps. One combined real-Electron run passed all five
matrix journeys and their 94 steps in 58.764 seconds. The full serial regression passed all 21
scenarios and 223 steps in 197.656 seconds with no failures. Deterministic ACP providers prove local
product integration and protocol behavior without making external model or network availability a
merge condition.
