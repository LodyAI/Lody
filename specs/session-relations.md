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

| Operation                           | Targets                                                                                         | Metadata readiness                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Archive a Session                   | The selected Session and recursive descendants through containment and precise opened-by links. | Read one ready Repo metadata snapshot, independent of the UI projection.     |
| Restore a Session                   | The selected Session and the same direct children.                                              | Read one ready Repo metadata snapshot, independent of the UI projection.     |
| Permanently delete an archived root | The selected Session and the same direct children.                                              | Read one ready Repo metadata snapshot, independent of the UI projection.     |
| Delete exact Session ids            | Exactly the ids supplied by the caller.                                                         | Must not wait for global metadata hydration or discover additional Sessions. |

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

## Readiness, lifetime, and failure

Root validation and target discovery use the same live Session metadata snapshot.
Document room ids define identity; deleted entries are excluded. Failed reads and
missing or deleted roots reject before writes or terminal closure, without a UI-cache
fallback. UI metadata readiness is a presentation concern, not a discovery boundary.

The runtime must have completed initial synchronization with its selected metadata
source. Desktop local operations use the local data plane and do not require cloud
connectivity. CLI archive, restore, and delete require successful synchronization
before discovery, including when initialization continued in degraded mode.

An action captures its runtime and checks it is still current before the first write.
Once writes begin, the action retains that runtime and target set. This guarantees
the observed Repo snapshot, not completeness across disconnected replicas or an
atomic barrier against later creation. Exact deletion and ordinary Tab closure do
not require this discovery boundary.

Archive writes are idempotent but not transactional. A failed write surfaces an error
and may leave earlier targets archived; retrying an already archived root rediscovers
descendants. Accepted archive writes retain runtime shutdown and worktree cleanup.
Terminal closure follows each accepted write and is best-effort; metadata rollback
cannot undo resource shutdown. Permanent deletion processes children before the root.

This Spec does not define worker supervision, status or result aggregation, unread or
permission routing, worker panels, settle, or handoff behavior. Those product choices
remain separate in [#529](https://github.com/LodyAI/Lody/issues/529).

## Evidence

The reported archive behavior and supported scenario are in
[#531](https://github.com/LodyAI/Lody/issues/531). Client target selection and exact
cleanup live in
[`use-session-actions.ts`](../packages/components/src/hooks/use-session-actions.ts),
and reverse-navigation resolution lives in
[`session-navigation.ts`](../packages/components/src/lib/session-navigation.ts).
The shared [snapshot reader](../packages/shared/src/session-operation-targets.ts)
owns target discovery for both clients. CLI synchronization and nested-child rejection are in
[`session.ts`](../apps/cli/src/commands/session.ts). Behavioral coverage is in
[`use-session-actions.test.ts`](../packages/components/tests/use-session-actions.test.ts)
and
[`session-navigation.test.ts`](../packages/components/tests/session-navigation.test.ts).

The containment-only baseline was implemented by #569. The
[archive descendants decision](../.agents/notes/implemented/bug-fix/2026-09-13-session-archive-descendants.md)
supersedes its archive target rule. This revised contract remains a draft.
The [Repo snapshot decision](../.agents/notes/implemented/architecture/2026-09-17-session-operation-metadata-snapshots.md)
addresses [#574](https://github.com/LodyAI/Lody/issues/574)'s discovery gap without
changing those relation rules.
