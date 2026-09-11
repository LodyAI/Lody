# Propose supervised attention for agent-opened Sessions

Status: proposed
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/623

Contract: [Supervised agent-opened Sessions](../../../../specs/session-worker-supervision.md)

## Abstract

Agent-opened independent Sessions currently fragment one delegated workflow into
separate rows, unread states, notifications, and permission routes. This note
proposes treating new Agent-created Sessions as supervised workers by default
while preserving their independent execution and lifecycle, with explicit
handoff as the path to a human-owned peer. Existing opened-by metadata cannot
safely classify historical Sessions, and supervisor deletion and cross-device
acknowledgement need human decisions before implementation.

## Problem and evidence

[#529](https://github.com/LodyAI/Lody/issues/529) describes an attention problem,
not a request to co-locate storage. `lody_session_create` may need a distinct
directory or worktree, so replacing independent creation with
`useCurrentSessionAsParent` would lose the isolation needed for concurrent work.
The useful product unit is instead one human-supervised workflow containing
several independently executing Sessions.

The current implementation exposes the missing pieces separately:

- independent creates retain the precise opener in `openedBySessionId` and, for
  child-Tab openers, a routable root in `openedByRootSessionId`;
- create Operations retain per-target progress and bounded terminal output;
- unread is currently computed from each Session's own activity/read receipt;
- completion and permission notifications currently receive the executing
  Session id; and
- opened Sessions remain ordinary sidebar rows, with indentation as
  presentation only.

The current-state explanation remains in
[the Session detail shell guide](../../../docs/sessions-side-panel.md). This
proposal does not rewrite that guide as though the feature already existed.

## Product boundary

The proposed contract separates three relationships that must not be collapsed:

| Relationship                    | Owns                                                                  | Does not own                                                 |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| Containment (`parentSessionId`) | Shared root workspace and root lifecycle target selection.            | Independent worker execution.                                |
| Provenance (`openedBy*`)        | Exact opener identity and reverse navigation.                         | Worker classification, attention, archive, or deletion.      |
| Supervision                     | Roster, result, unread, permission, and acknowledgement presentation. | Session document, worktree, runtime, or lifecycle ownership. |

[#569](https://github.com/LodyAI/Lody/pull/569) resolved the destructive side of
this boundary after the competing reports in
[#528](https://github.com/LodyAI/Lody/issues/528) and
[#531](https://github.com/LodyAI/Lody/issues/531). Archive, restore, and
archived-root deletion follow containment only. Worker supervision must compose
with that result rather than restore an opened-by cascade under another name.

## Proposed outcome

New Agent-created independent Sessions default to supervised workers. Their
supervisor owns the human attention route and presents a roster with live
attention, terminal result previews, settle, and drill-in. An explicit handoff
creates a peer conversation with direct unread and notifications while retaining
opened-by provenance.

Settle is intentionally an acknowledgement, not cleanup. It removes a terminal
worker from the active roster while retaining discoverable history and the
worker's Session-owned data. Bulk dismissal should affect terminal workers only;
active workers need an explicit cancel or handoff path so permission attention
cannot disappear.

Phone and desktop clients follow the same ownership classification. A
human-created phone Session remains a peer, while an Agent delegating from it
creates a worker unless handoff was explicit. Whether a phone push should be
suppressed while desktop is attended remains the separate concern of
[#527](https://github.com/LodyAI/Lody/issues/527).

## Alternatives considered

**Use child Tabs for all delegated work.** This already rolls activity into a
parent and avoids a peer sidebar row, but it shares the workspace directory and
cannot represent isolated concurrent work. It also turns presentation into
containment instead of preserving the distinction.

**Cascade opener lifecycle to every opened Session.** This makes the relation
look like ownership but can archive or permanently delete independent work and
its worktree. #569 deliberately rejected that behavior.

**Keep peer Sessions and route only notifications.** This addresses duplicate
pushes but leaves results, unread clearing, permission attention, and cleanup of
the active work list fragmented. It is a useful delivery slice, not the complete
product contract.

**Specify a schema field or worker table now.** The evidence establishes the
observable classification and routing requirements, not the correct persistence
shape. Choosing representation before the acknowledgement, legacy, and deletion
semantics are approved would turn a product question into accidental storage
policy.

## Human decisions and risks

The Spec records the complete decision table. The highest-risk choices are:

- historical rows with only `openedBy*` should remain visible peers unless a
  human approves migration semantics;
- per-worker versus supervisor-wide read receipts determine whether unseen
  results can be cleared accidentally;
- settle must be defined across devices or the phone and desktop rosters will
  disagree;
- supervisor archive/delete needs an explicit fallback or precondition so
  independent workers survive without losing their attention owner; and
- later work sent to an existing worker needs one result-routing rule when the
  requester is not the original supervisor.

These choices block implementation, but they do not make the proposal internally
contradictory: every option must preserve independent lifecycle, visible
permission attention, explicit handoff, and fail-visible mixed-client behavior.

## Verification and limits

This is a documentation-only product-contract phase. The repository sources and
current implementation docs were inspected to distinguish implemented behavior
from proposed intent; no runtime behavior or storage format changed. The draft
Spec remains unapproved and no translation was added. Validation is limited to
repository documentation checks and review of the linked public Issues, PR, and
source paths.
