# Session relations and operation targets

Status: draft
Translation: pending

A root Session may contain child Tabs and may also open independent Sessions. These
relationships carry different guarantees. For example:

```text
Session A
|- Tab T                 parentSessionId=A
|- Session B             openedBySessionId=A
`- T opens Session C     openedBySessionId=T, openedByRootSessionId=A
```

Tab T is part of A. Sessions B and C are first-class Sessions even though A or T
caused their creation. State operations must choose targets from the relationship
that matches the operation; the fields do not form one lifecycle tree.

## Relation contract

| Relation                | Meaning                                                                  | Operational consequence                                                                                |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `parentSessionId`       | Direct containment. A child Tab shares the root Session workspace.       | Root archive, restore, and archived-root deletion include the direct child.                            |
| `openedBySessionId`     | The precise Session or Tab that created this Session.                    | Preserve for provenance and presentation; never infer archive, restore, or deletion ownership from it. |
| `openedByRootSessionId` | The root route for a precise opener that is a child Tab.                 | Use with the precise opener for navigation; never use it to select state-operation targets.            |
| Resource metadata       | The machine, project, branch, workspace, or worktree owned by a Session. | Clean up resources only when that Session is an operation target.                                      |

`openedByRootSessionId` complements rather than replaces `openedBySessionId`: one
identifies a routable root and the other preserves the exact causal source.

Only direct containment is supported. Supported creation paths reject a child whose
parent already has `parentSessionId`, and state operations must not recursively invent
behavior for malformed or legacy nested children.

## Operation contract

| Operation                           | Targets                                                                         | Metadata readiness                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Archive a Session                   | The selected Session and direct children whose `parentSessionId` equals its id. | Target discovery reads the repository metadata index directly.                 |
| Restore a Session                   | The selected Session and the same direct children.                              | Target discovery must use complete metadata.                                   |
| Permanently delete an archived root | The selected Session and the same direct children.                              | Reject before mutation unless the metadata set used for discovery is complete. |
| Delete exact Session ids            | Exactly the ids supplied by the caller.                                         | Must not wait for global metadata hydration or discover additional Sessions.   |

Every side effect follows the same target set as the state or document operation.
Terminal closure, machine commands and queues, launch-config removal, and worktree
cleanup must not affect a Session excluded from the operation targets.

Exact deletion exists for compensation and explicit cleanup where the caller already
knows the complete set, including a partially created child, an empty child Tab, or a
side Session whose runtime was terminated. Requiring a complete metadata scan in
these paths would prevent cleanup during hydration and could leave partial state.

For the opening scenario, archive or restore of A affects A and T but not B or C.
Archived-root deletion of A deletes A and T while B and C survive. Exact deletion of
T deletes only T.

## Provenance after deletion

Deleting an opener must not erase `openedBySessionId` or `openedByRootSessionId` from
a surviving Session. Those ids preserve a causal fact that cannot be reconstructed
afterward.

Provenance and navigation are separate. An id alone is not a navigable target. Once
metadata hydration is complete, reverse navigation is actionable only when both the
precise opener and its route root exist. If either is missing, clients may present the
relation as deleted history but must not route to the missing Session. No tombstone or
deleted title is required by this contract.

Archived and active lists may use opened-by provenance to group or indent Sessions.
Presentation must not expand the target set of archive, restore, or deletion.

## Scope and implementation gap

This Spec does not define worker supervision, status or result aggregation, unread or
permission routing, worker panels, settle, or handoff behavior. Those product choices
remain separate in [#529](https://github.com/LodyAI/Lody/issues/529).

Archive reads the repository metadata index for every action, so an interactive root
does not depend on the client projection having discovered its direct children. The
query must complete before the first archive write, and query failure aborts the action
without mutation. Restore still discovers direct children from the client metadata
cache and therefore retains the cold-start implementation gap.

## Evidence

The reported archive behavior and supported scenario are in
[#531](https://github.com/LodyAI/Lody/issues/531). Client target selection and exact
cleanup live in
[`use-session-actions.ts`](../packages/components/src/hooks/use-session-actions.ts),
and reverse-navigation resolution lives in
[`session-navigation.ts`](../packages/components/src/lib/session-navigation.ts).
CLI direct-child selection and the nested-child rejection are in
[`session.ts`](../apps/cli/src/commands/session.ts). Behavioral coverage is in
[`use-session-actions.test.ts`](../packages/components/tests/use-session-actions.test.ts)
and
[`session-navigation.test.ts`](../packages/components/tests/session-navigation.test.ts).

This draft records the relation and operation guarantees implemented by
[#569](https://github.com/LodyAI/Lody/pull/569). Human approval of the complete
contract remains pending.
