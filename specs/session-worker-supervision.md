# Supervised agent-opened Sessions

Status: draft
Translation: pending

When an Agent opens independent Sessions to perform delegated work, the human
usually remains in the Session that requested the work. Those opened Sessions
should therefore behave as supervised workers unless the Agent explicitly
creates a handoff for the human to own as a separate conversation.

```text
Human -> supervisor Session A -> worker B
                              `-> worker C
       -> explicit handoff Session D (independent peer)
```

The worker model changes presentation, attention, and acknowledgement. It does
not change execution isolation: B and C may keep separate Session documents,
directories, worktrees, Machines, and runtimes.

## User problems

The current presentation makes one delegation look like several unrelated
conversations:

- each independent opened Session occupies the ordinary Session list and owns
  its unread state, completion notification, and permission alert;
- the supervisor shows that a Session was created but not the short result
  already carried by the completed Operation;
- the human must open and clear every worker separately; and
- `openedBySessionId` visually suggests a relationship but does not say whether
  the Agent intended supervised work or a human-owned handoff.

The product must solve that attention and ownership problem without using
lifecycle cascade as a substitute. Independent workers may own worktrees and
continue running after the supervisor is archived, so they must not be deleted
or archived merely because their opener is.

## Terms and boundaries

| Term       | Product meaning                                                                                                                                | Not implied                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Supervisor | The precise Session or child Tab whose Agent requested the worker. Its root Session supplies the routable shell and sidebar attention surface. | Shared workspace, shared runtime, or lifecycle ownership. |
| Worker     | An independently executing Session presented under its supervisor for status, result, and attention.                                           | A `parentSessionId` child Tab or a disposable subprocess. |
| Handoff    | An explicit create-time choice that makes the new Session a human-owned peer.                                                                  | Removing its creation provenance.                         |
| Settle     | Acknowledgement that a terminal worker no longer belongs in the active worker roster.                                                          | Archive, delete, cancel, or handoff.                      |
| Drill-in   | Opening the worker's full Session surface from its roster or result.                                                                           | Ownership transfer or acknowledgement of other workers.   |

This contract applies to Agent-requested independent Session creation. Existing
child Tabs and side chats remain containment children, and sending work to an
already existing peer does not by itself convert that peer into a worker.

This Spec defines observable behavior, not a storage layout. An implementation
may add classification, acknowledgement, or routing state, but it must not make
`parentSessionId` mean supervision or make `openedBySessionId` mean lifecycle
ownership. The representation must survive reload and mixed-client operation
well enough to meet the accepted compatibility behavior below.

## Creation and roster

An Agent-created independent Session defaults to a worker. The create request
must offer an explicit handoff choice; workspace selection, worktree isolation,
Machine selection, and `useCurrentSessionAsParent` are not handoff signals.

The supervisor presents one roster entry per worker. A batch create presents
each accepted target separately, including partial failures. The active roster
shows aggregate total and attention-required counts plus at least:

- worker identity and title;
- current attention state, with permission or question ahead of running, and
  running ahead of ordinary unread completion;
- terminal outcome (`succeeded`, `failed`, or `cancelled`); and
- a short result or error when the Operation provides one, including a visible
  indication when the preview was truncated.

The terminal create result must not collapse to "Session created" when an
Operation output preview or error is available. The roster may use live Session
state after creation, but durable historical status must not be presented as
proof that a worker is currently running.

### Acceptance scenarios

1. Given A is the active root Session, when its Agent creates independent B and
   C without handoff, then A shows two workers and B/C do not appear as ordinary
   peer conversations in the active Session list.
2. Given A's active child Tab T creates B, then T is the precise supervisor and
   A is the routable root. The worker panel and navigation must return the human
   to A with T selected rather than rewriting the opener to A.
3. Given a batch accepts B but rejects C before C has a target, then the roster
   shows B and the rejected item independently; it must not invent a Session
   link for C.
4. Given B completes with a bounded output preview, then A shows that preview,
   its success state, and a drill-in action. Truncation remains visible.
5. Given B later waits for permission while C is running, then A's aggregate
   state reports attention required ahead of running and identifies B as the
   worker requiring action.

## Unread, completion, and permission attention

A supervised worker has one human attention route: its supervisor. Worker
output contributes unread attention to the supervisor route rather than
creating a second ordinary inbox item for the worker. A completion produces at
most one user notification, and activating it opens the supervisor with the
corresponding worker result in context.

Permission requests and Agent questions are never suppressed by supervision.
They roll up with higher priority than running or unread completion, name the
worker that is blocked, and provide a route to the exact request. Resolving the
request clears that worker's permission attention without clearing unrelated
worker results.

Reading is evidence-based. Merely mounting a hidden worker, opening the
supervisor shell, or receiving an Operation continuation must not mark a result
read. A surface clears only the worker results it actually exposes. Drilling
into B may acknowledge B's visible output, but must not acknowledge C.

Device attendance is a separate decision from supervision. A phone-only user
must still receive the routed supervisor alert; Machine liveness is not evidence
that the human is viewing the supervisor. Cross-device suppression while an
attended desktop is active belongs to
[#527](https://github.com/LodyAI/Lody/issues/527).

### Acceptance scenarios

1. Given A is off screen when B finishes, then A becomes unread and one
   completion alert routes to A/B context; B does not also create a peer unread
   row or duplicate completion alert.
2. Given A is visible but B's result is hidden in a collapsed worker surface,
   then mounting A alone does not acknowledge B.
3. Given B requests permission while the human is viewing another Session,
   then the alert opens A with B's exact request actionable.
4. Given B and C have unseen results and the human drills into B, then C remains
   unread after B is acknowledged.
5. Given the only active client is a phone, then a worker's permission and
   completion alerts still reach that phone through the supervisor route.

## Settle and drill-in

Settle removes a terminal worker from the active roster without changing its
Session, history, files, runtime records, archive state, or opened-by provenance.
A settled worker remains discoverable from the supervisor's worker history and
can still be drilled into. "Dismiss completed" applies the same acknowledgement
to every terminal worker in scope; it must not silently hide running or
permission-blocked workers.

[#529](https://github.com/LodyAI/Lody/issues/529) calls the bulk action
"dismiss all opened." The proposed contract narrows that action to terminal
workers; approving a different active-worker behavior is an explicit decision
below.

Drill-in exposes the worker's complete conversation and Session-owned artifacts.
It provides an unambiguous return route to the supervisor and preserves the
precise opener when that opener is a child Tab. Opening, reading, or editing the
worker does not itself hand the Session off.

### Acceptance scenarios

1. Given B succeeded, when the human settles B, then B leaves A's active roster,
   remains in worker history, and its Session and worktree are unchanged.
2. Given B succeeded while C is running, when the human dismisses completed
   workers, then B is settled and C remains active and visible.
3. Given the human drills into B and returns, then the route restores A and its
   precise supervising Tab; B remains a worker unless a separate handoff action
   was confirmed.

## Explicit handoff

Handoff is affirmative human-ownership intent. A create explicitly marked as a
handoff produces an ordinary peer Session with its own Session-list row, unread
state, and notification route. It does not appear in the supervisor's active
worker roster or contribute aggregate worker attention. The Session may retain
`openedBySessionId` and `openedByRootSessionId` so "Opened by" navigation and
historical provenance continue to work.

No implementation may infer handoff from a separate worktree, a different
Machine, the user opening the worker, or a worker surviving its supervisor.

### Acceptance scenarios

1. Given A's Agent uses the explicit handoff path to create D, then D appears as
   a peer conversation and its unread and notifications route directly to D.
2. Given D retains `openedBySessionId=A`, then deleting A may leave dangling
   provenance as defined by the Session relation contract; D remains a peer.
3. Given the human merely drills into worker B, then B does not become a handoff.

## Archive and delete

Supervision is not containment. Archiving, restoring, or permanently deleting a
supervisor affects only the targets defined by the
[Session relation contract](session-relations.md): the selected root and its
direct `parentSessionId` children. It never selects independent workers through
opened-by or supervision presentation.

Settling a worker likewise never archives or deletes it. Explicitly archiving or
deleting the worker acts on that worker under the ordinary Session lifecycle
contract and removes unavailable navigation instead of fabricating a result.
Deleting an opener preserves a surviving worker's existing `openedBy*`
provenance.

The product must not allow unresolved worker attention to disappear when a
supervisor is archived or deleted. The exact archive fallback and permanent
delete precondition require human approval below; implementation must not choose
one implicitly.

### Acceptance scenarios

1. Given B is running, when A is archived, then B is not archived, cancelled,
   deleted, or stripped of its worktree as a side effect.
2. Given A is permanently deleted after every surviving worker satisfies the
   approved deletion precondition, then B's Session remains unless B was an
   explicit delete target; its `openedBy*` values may remain as non-navigable
   provenance.
3. Given B itself is explicitly deleted, then A no longer offers a working
   drill-in route to B and does not claim that B's data is still available.

## Phone-created Sessions

A Session a human creates from a phone is an ordinary peer, not a worker. Client
type does not determine supervision: if an Agent running in a phone-created
Session later delegates independent work, that new Session follows the same
worker-default and handoff rules. Mobile must expose the roster, permission
attention, result, settle, drill-in, and handoff outcomes needed to preserve the
same ownership model; it need not use the desktop panel layout.

### Acceptance scenarios

1. Given a human creates P on a phone, then P remains a normal conversation with
   direct unread and notifications.
2. Given P's Agent creates worker B without handoff, then P supervises B across
   phone and desktop clients; B does not become a peer merely because P began on
   mobile.

## Compatibility with opened-by provenance

`openedBySessionId` and `openedByRootSessionId` continue to mean causal
provenance and navigation only. They must be preserved for both workers and
handoffs and must never independently select archive, restore, or delete targets.

Those existing fields cannot distinguish a legacy agent-opened peer from a new
worker or explicit handoff. A client must therefore fail visibly when it cannot
understand the supervision classification: it may show the Session as an
ordinary peer, but it must not hide the Session, suppress its attention, or
invent lifecycle ownership. Reclassifying all historical `openedBy*` Sessions
as workers requires a separately approved migration decision.

## Decisions requiring human approval

The guarantees above form a coherent proposed direction, but implementation is
blocked on these product choices. The draft intentionally does not encode them
as storage decisions.

| Decision                    | Recommended contract                                                                                                                                    | Material alternative or consequence                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Legacy `openedBy*` rows     | Treat metadata-only existing Sessions as peers until an explicit supervised classification exists.                                                      | Automatic backfill may hide old conversations and reroute attention without user intent.         |
| Settle scope and sync       | Keep settled history discoverable and synchronize acknowledgement for the workspace user across clients.                                                | Device-local settle makes the active roster and unread counts disagree across phone and desktop. |
| Read acknowledgement        | Track acknowledgement per worker and derive the supervisor aggregate; clear only results visible on the active surface.                                 | A single supervisor receipt is simpler but can clear unseen worker results.                      |
| Active dismiss              | Limit bulk dismiss to terminal workers; require cancel or handoff for active and permission-blocked workers.                                            | Hiding active workers can strand execution or permission requests.                               |
| Supervisor archive          | Keep workers independent and require an explicit choice for active/unread workers: retain an actionable archived supervisor route, hand off, or cancel. | Silent archive can strand attention; automatic handoff violates explicit ownership intent.       |
| Supervisor permanent delete | Block deletion while surviving supervised workers still require a supervisor, unless each is handed off, deleted, or otherwise explicitly resolved.     | Allowing deletion needs a separately defined fallback attention owner.                           |
| Post-create handoff         | Decide whether an existing worker can be promoted to a peer; if supported, make it explicit and retain provenance/result history.                       | Create-time-only handoff is simpler but gives no recovery from a mistaken classification.        |
| Later cross-Session work    | Decide whether later `session_chat` Operations inherit the original supervisor or route results to each requesting Session.                             | Routing by requester can split one worker's attention across several supervisors.                |

Approval must also confirm the exact user-facing terms ("worker", "settle", and
"handoff") and whether mobile exposes the same actions directly or through a
compact equivalent.

## Evidence and implementation gap

The problem and proposed direction come from
[#529](https://github.com/LodyAI/Lody/issues/529). The lifecycle boundary and
conflicting archive expectations were resolved by
[#531](https://github.com/LodyAI/Lody/issues/531) and
[#569](https://github.com/LodyAI/Lody/pull/569); the inverse cascade request in
[#528](https://github.com/LodyAI/Lody/issues/528) remains open.

Current `SessionMeta` declares opened-by provenance in
[`schema.ts`](../packages/shared/src/schema.ts), while independent creates write
it in [`session.ts`](../apps/cli/src/commands/session.ts). Operation results
already carry bounded output previews in
[`session-orchestration.ts`](../packages/shared/src/session-orchestration.ts),
but the create completion view currently renders Session cards without those
previews in
[`view.tsx`](../packages/components/src/components/ai-gui/view.tsx). Current
Session-list rollup covers `parentSessionId` children only in
[`session-list-rows.ts`](../packages/components/src/components/sessions/session-list-rows.ts),
and completion and permission notification inputs currently target the worker
Session in
[`message-handler.ts`](../apps/cli/src/lib/message-handler.ts).

No worker classification, settle state, or supervised attention route is
implemented by this documentation change. Human approval of the decisions above
is required before this Spec can become implementation-ready or approved.
