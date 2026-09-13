# Session relations and operation targets

Status: draft
Translation: current

[中文](session-relations.zh.md)

A root Session may contain child Tabs and may also open independent Sessions. These
relationships carry different guarantees. For example:

```text
Session A
|- Tab T                 parentSessionId=A
|- Session B             openedBySessionId=A
`- T opens Session C     openedBySessionId=T, openedByRootSessionId=A
```

Tab T is part of A. Sessions B and C are first-class Sessions even though A or T
caused their creation. Archive includes the opened descendants so that closing a
conversation tree closes its work. Restore and deletion retain containment ownership.

## Relation contract

| Relation                | Meaning                                                                  | Operational consequence                                                                              |
| ----------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `parentSessionId`       | Direct containment. A child Tab shares the root Session workspace.       | Root archive, restore, and archived-root deletion include the direct child.                          |
| `openedBySessionId`     | The precise Session or Tab that created this Session.                    | Follow recursively for archive; preserve provenance without inferring restore or deletion ownership. |
| `openedByRootSessionId` | The root route for a precise opener that is a child Tab.                 | Use with the precise opener for navigation; never use it to select state-operation targets.          |
| Resource metadata       | The machine, project, branch, workspace, or worktree owned by a Session. | Clean up resources only when that Session is an operation target.                                    |

`openedByRootSessionId` complements rather than replaces `openedBySessionId`: one
identifies a routable root and the other preserves the exact causal source.

Only direct Tab containment is supported. Supported creation paths reject a child whose
parent already has `parentSessionId`. Opened Sessions can create further Sessions;
archive follows those descendants with cycle protection and deduplication. Containment
takes precedence when a Session carries both relationship fields. `openedByRootSessionId`
alone never selects an archive target.

## Operation contract

| Operation                           | Targets                                                                                         | Metadata readiness                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Archive a Session                   | The selected Session and recursive descendants through containment and precise opened-by links. | Reject before mutation while the client metadata cache is incomplete.          |
| Restore a Session                   | The selected Session and the same direct children.                                              | Target discovery must use complete metadata.                                   |
| Permanently delete an archived root | The selected Session and the same direct children.                                              | Reject before mutation unless the metadata set used for discovery is complete. |
| Delete exact Session ids            | Exactly the ids supplied by the caller.                                                         | Must not wait for global metadata hydration or discover additional Sessions.   |

Every side effect follows the same target set as the state or document operation.
Terminal closure, machine commands and queues, launch-config removal, and worktree
cleanup must not affect a Session excluded from the operation targets.

Exact deletion exists for compensation and explicit cleanup where the caller already
knows the complete set, including a partially created child, an empty child Tab, or a
side Session whose runtime was terminated. Requiring a complete metadata scan in
these paths would prevent cleanup during hydration and could leave partial state.

For the opening scenario, archive of A affects A, T, B and C, including further
opened descendants. Restore of A affects A and T only; B and C can be restored separately.
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
List filtering, pinning and collapse state do not change archive targets. Presentation
must not expand the target set of restore or deletion.

## Scope and implementation gap

This Spec does not define worker supervision, status or result aggregation, unread or
permission routing, worker panels, settle, or handoff behavior. Those product choices
remain separate in [#529](https://github.com/LodyAI/Lody/issues/529).

Archive requires a complete client metadata cache before any write. Repeating archive
on an already archived root still discovers and archives descendants. Writes are
idempotent but not transactional; a failed write surfaces an error and can be retried.
Each archived Session retains the existing runtime shutdown and worktree cleanup behavior.

Restore still discovers direct children from a client metadata cache that can be
incomplete while Session Detail is interactive. It can miss a child during hydration.
[#574](https://github.com/LodyAI/Lody/issues/574) tracks the required readiness or
complete-query fix.

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

The containment-only baseline was implemented by #569. The
[archive descendants decision](../.agents/notes/implemented/bug-fix/2026-09-13-session-archive-descendants.md)
supersedes its archive target rule. This revised contract remains a draft.
