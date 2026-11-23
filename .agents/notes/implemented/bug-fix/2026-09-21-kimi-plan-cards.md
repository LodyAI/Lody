# Kimi plan submissions in the shared plan card

Status: implemented
Translation: current

[中文](2026-09-21-kimi-plan-cards.zh.md)

## Abstract

Kimi exposed plan review text only inside tool content, and classified its plan
tools as generic tools. Lody therefore could not reliably route submissions to
its dedicated plan surface. The adapter now publishes Markdown plan updates to
clients advertising ACP's experimental plan capability and classifies plan submission
as a mode switch. Existing approval content remains the fallback, and approving
or leaving Plan retains the submitted document in conversation history.

## Boundary and trade-offs

This is separate from the [missing-file fix](2026-09-20-kimi-plan-file-errors.md).
The boolean Plan setting and approval decisions are unchanged. `TodoList` still
uses the stable ACP checklist event; document submissions use experimental
`plan_update`, gated by `clientCapabilities.plan`. No private Lody notification
or provider-specific renderer is needed: Lody already advertises this capability,
stores Markdown as `proposed_plan`, and renders the shared plan panel without
duplicating the approval's copy.

Only `ExitPlanMode` uses `switch_mode`: Lody treats that kind as a plan decision
surface, so applying it to entering Plan would render entry output as a proposal.

The adapter projects the tool's resolved `plan_review` display at tool start,
covering manual and automatic approval. A turn/tool-call-scoped ID separates
submissions; fork metadata remains the user-visible fork position, not that ID.
Only submitted snapshots are projected, not every filesystem edit. Exiting Plan
does not mean deleting the conversation document. Native context-only ACP replay
does not reconstruct old review displays; this change does not promise otherwise.
Lody retains received cards in its own history.

## Verification and delivery

A real engine with a scripted model and an in-memory ACP connection verifies
Markdown, capability fallback, mode-switch classification, approval, revision,
rejection and automatic approval. The missing event regression failed before
the fix. Lody's history test verifies Markdown replacement and retention beside
the completed tool card. No UI screenshot or production runtime is validated by
these tests. Publishing the separately built checksummed Kimi runtime and updating
the managed-runtime manifest remain required before installed clients receive it.

Adapter PR: [Kimi #14](https://github.com/LodyAI/acp-extension-kimi/pull/14).
Consumer pin and regression: [Lody #870](https://github.com/LodyAI/Lody/pull/870).
Merge the adapter first; neither PR publishes a production runtime.
