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

| Operation                           | Targets                                                                         | Metadata readiness                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Archive a Session                   | The selected Session and direct children whose `parentSessionId` equals its id. | Target discovery reads the repository metadata snapshot observed by the action. |
| Restore a Session                   | The selected Session and the same direct children.                              | Target discovery must use complete metadata.                                    |
| Permanently delete an archived root | The selected Session and the same direct children.                              | Reject before mutation unless the metadata set used for discovery is complete.  |
| Delete exact Session ids            | Exactly the ids supplied by the caller.                                         | Must not wait for global metadata hydration or discover additional Sessions.    |

Every side effect follows the same target set as the state or document operation.
Terminal closure, machine commands and queues, launch-config removal, and worktree
cleanup must not affect a Session excluded from the operation targets.

### Archive and restore commit

One archive or restore operation freezes its selected Session and discovered direct
children before submission. The repository publishes that operation's effective
lifecycle changes as one revision. An observer may see the preceding revision or the
following revision, but never a subset caused by applying that operation incrementally.
Replicas may receive a revision at different times; this is not a promise of simultaneous
visibility across disconnected clients.

A failure before acceptance leaves no change from that operation. Once an operation
has been accepted, a persistence or acknowledgement failure must retain its identity
and distinguish an unconfirmed outcome from rejection. Neither case authorizes writing
old `isArchived` or execution `status` values back over current metadata. Success means
the operation is locally durable; remote synchronization and resource cleanup have
separate completion boundaries. Cross-restart recovery requires a persisted operation,
not an in-memory error or retry flag.

Recovery may deliver the same operation or revision more than once. Readers and resource
owners must handle this idempotently; replay neither creates a new logical operation nor
raises its precedence. Cross-crash notification delivery is not exactly once.

Concurrent root lifecycle operations with identical frozen target sets choose one
winner for that set. When sets differ, shared targets use the same operation ordering;
a target absent from the newer operation retains its last applicable result. A later
independent Tab operation may affect only that Tab, and a later root operation may
supersede that Tab operation when the Tab is included. Therefore
`root active / child archived` can be intentional; a failed root operation may not
produce that combination by changing only some of its targets. Lifecycle writes do not
own execution status: the runtime publishes its actual state, and restore never revives
a captured `running` or `requestPermission` value.

Terminal closure begins after the lifecycle commit. Cleanup observes current effective
state and coordinates with start/resume across asynchronous resource work; an old
archive task must not destroy a new runtime generation after restore. Cleanup failure is
reported and retried by its resource owner without reversing the lifecycle operation.
These resource effects may finish at different times; atomic lifecycle publication does
not promise atomic termination of multiple processes.

An operation remains bound to its captured workspace. A workspace switch before
submission aborts without mutation; after acceptance the originating runtime owns
confirmation and recovery. A rendered root is presentation evidence, not an authoritative
source for membership, prior state, or a lifecycle commit.

### Compatibility

Every participating writer and lifecycle reader must share the operation and projection
contract before the new representation is enabled. A Machine capability describes that
daemon; it cannot establish compatibility of other independently authoring renderers.
Legacy rows need an explicit migration baseline, and later legacy writes need a tested
admission or compatibility policy. This policy and the activation mechanism must be
proven before replacing the production path, not deferred until after its removal.
Best-effort dual writes to independent archive flags
do not establish this contract. Unsupported clients and retained offline writers remain
a rollout prerequisite, not evidence that the weaker invariant is acceptable.

### Exact deletion

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

Archive and restore now read one repository metadata snapshot before submission; a
query or workspace-ownership failure leaves no operation. In the coordinated local OSS
topology, both actions durably admit one immutable operation and project its complete
target set through the repository seam. Browser admission uses workspace-scoped
IndexedDB, CLI admission uses a dedicated workspace SQLite database, and both replay
unpublished records without changing their identity or order. Existing archived flags
become deterministic counter-zero baselines. Direct legacy archive writes are rejected
after activation, while initial active metadata remains valid for a newly created
Session.

The local implementation does not include children created after its discovery
snapshot, recursive containment, operation compaction, or atomic permanent deletion.
Cloud and dual product topologies retain the legacy independent-write path because the
public repository cannot fence independently deployed or offline renderers. They must
not enable the new representation until the mixed-client compatibility requirement
above has external evidence; a Machine capability is insufficient. Consequently this
Spec remains draft and #574 remains open for product topology. The
[decision record](../.agents/notes/proposed/architecture/2026-09-13-session-lifecycle-commit.md)
owns the storage layout, verification evidence, and remaining rollout gate.

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
The operation model and repository projection are covered by
[`session-lifecycle.test.ts`](../packages/shared/tests/session-lifecycle.test.ts) and
[`session-lifecycle-repository.test.ts`](../packages/shared/tests/session-lifecycle-repository.test.ts).
Browser and CLI durability are covered by their adjacent
[`session-lifecycle-persistence.spec.ts`](../packages/components/tests/e2e/session-lifecycle-persistence.spec.ts)
and
[`session-lifecycle-persistence.test.ts`](../apps/cli/src/lib/loro/session-lifecycle-persistence.test.ts)
suites.

The containment target rules were implemented by
[#569](https://github.com/LodyAI/Lody/pull/569). The archive acceptance criteria remain
tracked by [#574](https://github.com/LodyAI/Lody/issues/574); discovery alone does not
establish mixed-product-client compatibility. Human approval of this draft remains pending.
