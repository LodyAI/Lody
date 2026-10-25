# Adopt fresh-id retries of an in-flight MCP create

Status: implemented
Translation: current

[中文](2026-10-21-mcp-create-fresh-id-retry.zh.md)

## Abstract

Users saw `lody_session_create` produce two identical Sessions from one Agent
turn. Acceptance was already idempotent per `operationId`, but the call returns
only after the target Session is written, so a client tool timeout or a late
error can make the Agent retry the same work under a new id, and that retry was
accepted as new work. The local Operation store now treats an identical single
create from the same source Turn as that retry while the original Operation is
still active, and returns the original Operation instead of creating a Session.
The trade-off is that one turn cannot start two identical single creates
concurrently; the retry also never covers changed input or another turn.

## Findings

- `accept` and `findMatchingRetry` key Operations by `(requesterSessionId,
  operationId)`. A same-id retry, including a concurrent one, is already
  adopted atomically and the fixed target ids make replay reuse one Session.
- The single create stays synchronous until `createSessionResult` finishes,
  after workspace/catalog syncs, machine checks and attachment preparation.
  Lody configures no MCP tool timeout, so clients use their own defaults; a
  client that abandons the call does not cancel the daemon work.
- The reported transcript shows one successful and one failed
  `lody_session_create` call in a single turn before the Agent noticed two
  review Sessions. The machine-local transcript and daemon log were not
  available, so the exact failure (timeout or error) and the two ids are
  unconfirmed; any fresh-id retry of the same input fits the symptom.
- The legacy `wait=true` adapter takes no `operationId` and stays
  non-idempotent; it is temporary compatibility and is not changed here.
- After `createSessionResult` succeeds, `markItemInputDurable` is a write
  that can exhaust the store busy retries (`STORE_BUSY`). It used to escape as
  a tool error although the Session and input already existed, which is the
  same false failure that invites a retry. The Coordinator already recognizes
  an existing target input and marks it durable without writing again.
- The post-accept `createSessionResult` catch kept the Operation active for
  replay but discarded the error, leaving no diagnostic for a stuck create.

## Decision

Inside the `BEGIN IMMEDIATE` acceptance transaction, and in the pre-acceptance
retry lookup, a new `session_create` whose requester Session, requester user,
source Turn and canonical command fingerprint equal an **active** Operation
adopts that Operation: no row, claim or target is created. The MCP response
returns the original snapshot plus a `notice` naming its id and saying that
cancelling it is the way to start the same work again. The tool description
now tells Agents to retry timeouts and failures with the same `operationId`.

A failed durable mark after a successful create is logged and the call returns
the active snapshot; the Coordinator completes the mark from history evidence.
A post-accept create failure is logged with its original message before the
active snapshot is returned. Pre-acceptance errors and the target-id invariant
check still fail the call.

The single create still waits for materialization, so a client tool timeout
shorter than a degraded-sync create remains possible: the caller can see a
failure for a create that later succeeds. Identical retries no longer
duplicate it, and completion still reaches the caller. The
[sync confirmation floor](2026-10-21-sync-confirmation-timeout-floor.md)
lengthens those waits, so the client timeout for the Lody MCP server must be
raised above the server budget in a separate change.

Alternatives considered:

- Returning right after acceptance and leaving materialization to the
  Coordinator removes most of the timeout window, but changes when acceptance
  failures surface and does not cover a timeout that happens before acceptance.
- Matching finished Operations too would block deliberate repeats after a
  result or failure, so only active Operations match.
- Batch creates and chats are out of scope: identical batch items or repeated
  chat prompts can be intentional.

## Verification

- `operation-store.test.ts` covers adoption under a fresh id, independence of
  changed prompt, another turn and chat Operations, and a new create after the
  original finishes.
- `lody-mcp-server-chat-sync.test.ts` uses a real store to show that a busy
  durable mark returns the active Operation and a fresh-id retry creates no
  second Session; it fails without the fix. Coordinator recovery from an
  already written target is covered by `operation-coordinator.test.ts`.
- `tests/local-platform-zero-cloud.test.ts` drives the real daemon tool path
  and asserts that a fresh-id retry returns the original Operation and
  dispatches no second Session.
