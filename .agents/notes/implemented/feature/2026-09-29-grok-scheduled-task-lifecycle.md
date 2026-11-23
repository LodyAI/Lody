# Grok scheduled tasks through existing Core metadata

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1102
Adapter PR: https://github.com/LodyAI/acp-extension-grok/pull/24

[中文](2026-09-29-grok-scheduled-task-lifecycle.zh.md)

## Abstract

Grok's native scheduled-task notifications were passed through without Core
lifecycle metadata, so Lody could not consume them as neutral task facts. The
adapter now translates creation, firing and removal using the existing schema
and declares scheduled-task support. Native interval inputs remain unchanged;
the cron-based next-fire panel remains outside this change. Real authenticated
execution on the pinned runtime still needs verification.

## Decision and evidence

Core already defines scheduled capability, lifecycle metadata and canonical
scheduling tool names. Correcting the initial investigation: Core is sufficient
for lifecycle integration; additional timing fields are only needed for richer
schedule presentation. Reusing it avoids introducing a competing RPC surface.

Native source `xai-org/grok-build@f0e3be1` defines created/fired/deleted events,
canonical `x.ai/tool` metadata, and a shutdown removal reason that explicitly
preserves the task for restoration. The adapter scopes translation to owned or
restoring sessions, retains replay markers and stable namespaced IDs, and never
equates a fire with successful execution. Shutdown is consumed without a terminal
fact. Removal completes schedule ownership, while subagent output stays separate.

Unlike [machine-owned schedules](2026-09-24-machine-owned-scheduled-tasks.md),
this adapter does not schedule work or create workspace definitions. Interval
inputs cannot safely become cron expressions; canonical tool naming alone does
not make the history-derived countdown panel support them.

## Validation

Protocol tests exercise capabilities, repeated fires, updates, removal reasons,
shutdown, replay before restoration completes, failed restoration, malformed and
foreign events, canonical tool identity, preserved failures and unchanged interval
inputs. The full adapter suite and syntax checks are run for this change. Native
Grok 1.0.40 authenticated execution is not covered by these synthetic tests.

Intent: [draft Spec](../../../../specs/grok-scheduled-task-lifecycle.md).
