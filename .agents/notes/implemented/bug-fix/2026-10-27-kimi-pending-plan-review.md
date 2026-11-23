# Show Kimi plans before approval

Status: implemented
Translation: current

[中文](2026-10-27-kimi-pending-plan-review.zh.md)

## Abstract

Kimi streams ExitPlanMode arguments before requesting approval, so the initial plan card can contain only `{}`. The approval request already carries the review document, but Lody preserved the earlier content and discarded that document. Unanswered switch-mode permission requests now replace the stored preview with supplied review content. Other tools and already answered requests retain their existing content; no adapter release is required for this consumer fix.

## Evidence and decision

At Kimi pin `6a72b37485e95cbda37a86bae6fe4a918686b46b`, the engine awaits its before-execute approval hook before dispatching tool start. The ACP adapter includes the plan in `buildPermissionToolCallUpdate`, while `session.ts` emits the separate Markdown plan from the later tool-start event. Thus the earlier [plan-card fix](2026-09-21-kimi-plan-cards.md) does not guarantee that separate plan arrives before the decision. Lody's `mergeToolCallWithPermission` previously preferred any stored content, including streamed arguments, over permission content.

The shared history merge now accepts sanitized review content for an unanswered `switch_mode` card. Missing or filtered-empty content preserves the current document. Repeated requests after an outcome cannot replace it. Generic tool content keeps its existing preservation policy; changing all permission merges would unnecessarily affect other tool histories. The UI already reads the first review text block and excludes the action summary. Unlike the [Claude rejection fix](2026-10-22-claude-rejected-plan-display.md), this defect occurs before the decision at permission ingestion. Existing stuck cards need a new permission event or a retried turn; this does not recover a document already discarded from history.

## Validation and limits

The existing Loro history-action suite now exercises review content before any response, generic-tool preservation, missing review content, and repeated requests after cancellation. It could not run because this nested checkout has no installed workspace dependencies (`vitest` unavailable). A dependency-free Node assertion executed the real merge and UI resolver: the previous precedence reproduced `{}`, and the fix exposed Markdown with no outcome, including JSON hydration and the preservation cases above. No live Kimi session or desktop UI was exercised; full workspace type/build checks remain unverified.
