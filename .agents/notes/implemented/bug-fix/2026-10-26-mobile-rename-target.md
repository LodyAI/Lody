# Rename the selected conversation on mobile

Status: implemented
Translation: current

PR: [#1903](https://github.com/LodyAI/Lody/pull/1903)

English | [中文](2026-10-26-mobile-rename-target.zh.md)

## Abstract

The mobile Rename Chat action passed the root session to the dialog even when a
child conversation was selected (#1900). It now reuses the existing current-chat
handler, with one local eligibility value shared by the menu, desktop toolbar,
command and execution guard. Matching the resolved metadata ID to the selected
tab replaces separate draft and pending-child checks. Production action-slice
experiments support this reduction; they do not establish full-render or device
acceptance.

## Decision and evidence

At base `789b4e14`, `activeTabSession` falls back to the parent when a draft or
pending child is selected. The final condition is exactly:

```tsx
activeTabSession?.id === activeTabSessionId &&
  !activeTabSession.isArchived &&
  (!isMobile || !hasActiveViewerTab);
```

The optional ID comparison excludes missing metadata, drafts, empty selections
and pending-child fallbacks. Reuse the existing viewer predicate: mobile file
drawers do not replace the conversation; desktop side viewers leave it available.
The execution guard remains necessary even when presentation hides the action.
Keep the existing dialog target snapshot and `updateSessionTitle` write path.
No new selector module, hook, memo, effect or state is needed.

The deterministic experiment transpiles and executes actual production routing,
target resolution, menu construction, command/toolbar callbacks, dialog submit and
title-write code against synthetic metadata. Fourteen scenarios exercise three
entry paths each (42 checks), including write rejection and switching after the
dialog opens. Assertions inspect the dialog target and serialized metadata state.

| Variant                                                    | Passing checks |
| ---------------------------------------------------------- | -------------: |
| Original main                                              |          29/42 |
| Full condition, or delete either draft/pending check       |          42/42 |
| Delete both draft/pending checks, retaining exact ID match |          42/42 |
| Final condition without ID match (retaining null safety)   |          36/42 |
| Final condition without mobile viewer guard                |          39/42 |
| Final condition without archive guard                      |          37/42 |
| Final condition without execution guard                    |          36/42 |
| Final condition targeting the root again                   |          24/42 |

With both explicit draft/pending guards still present, removing the ID comparison
also passes this matrix. The final choice uses one ID comparison instead of those
two guards. These observations cover the tested state domain, not all possible
future session states.

## Ownership and verification limits

Current implementation: [session tab routing](../../../docs/sessions-tabs-routing.md).
This restores the selected-tab behavior reported in
[#1900](https://github.com/LodyAI/Lody/issues/1900); no new Spec is required.
The experiment executes isolated production slices, not a mounted SessionDetail,
React memo lifecycle, physical device, network sync or process restart. Metadata
serialization is an in-memory persistence check, not a disk durability claim.
Nine related component suites pass (173 tests). Component type checking passes
after rebuilding the checked-out DSH adapter declarations. Changed-file type-aware
lint reports zero errors (112 warnings); formatting, diff and documentation checks
pass (documentation has 73 warnings, unchanged from the base). These are separate
from the action-slice experiment. The available Node 24.19.0 is below the repository runtime
floor; installation used a temporary warning override, restored before delivery.
