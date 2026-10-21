# Route cross-session follow-ups through acknowledged Steer

Status: implemented
Translation: current

[中文](2026-10-21-mcp-chat-hidden-pending-input.zh.md)

## Abstract

Cross-session MCP chat appended ordinary history input even while the recipient
was working. The daemon could acknowledge it as seen while it still waited for
ordinary dispatch, making the conversation look as if the active Agent had
already received the new instruction. Chat now uses the existing acknowledged
Steer path when the target has an active assistant and confirmed support;
ordinary admission remains the fallback. This is a caller integration with the
existing lifecycle owner, retaining fixed identities and refusing replay after
uncertain submission. The reporter's installed runtime was not reproduced.

## Evidence and scope

The initial investigation used the working tree based on `4cc74cae8`. The current
MCP single, batch and legacy chat handlers call `sendSessionChatResult` with a
delegated requester. That function originally appended `pending` history and
published ordinary activation; the watcher serialized it behind the active turn.
Auto-read could advance it to `seen`, which the user row displays as Delivered.
The composer queue reads `mq` and therefore omitted that history backlog.

A temporary real Loro storage experiment reproduced two Agent-authored follow-ups
becoming seen/Delivered while `mq` stayed empty and the reducer refused execution
under active ownership. It was removed after the investigation. This does not
establish the exact request path or cause of the multi-hour activity label in the
attached screenshots. Waiting alone cannot establish whether a particular
installed runtime already submitted a steer; already submitted input must never
be sent again just because no visible action has occurred. No attached transcript
or embedded task instruction was executed or committed.

## Final behavior and ownership

```text
MCP chat + fixed input identity
  -> confirmed native Steer + active assistant: append inert pending_apply
     -> existing recipient Steer owner checks the exact frozen target
     -> applied / proven refusal recovery / uncertain without replay
  -> otherwise: existing ordinary history + dispatch
```

The route is limited to durable delegated chat, including batch materialization and
the existing Operation recovery caller. Legacy chat without an Operation retains
ordinary admission because it has no materialization recovery owner. Normal CLI
chat, Session creation, automatic Inbox result delivery and queue controls retain
their admission paths. A stale
assistant observation is not permission to steer a newer turn: the recipient
validates `expectedTurnId` and owns refusal/recovery. The normal input id,
requester, author, chain depth, target Role, execution configuration and attachment
references remain the accepted input's data.

`_lodySteerExpectedTurnId` is an optional declared history input-config field.
New writes and normalized reads preserve it. It freezes the recipient turn before
the first request; retries reuse the stored target and configuration even if the
latest assistant or capability cache changes. A guide is appended without
`latestUserMsgId` or an ordinary dispatch RPC. First submission and recovery use
the same function; no public MCP argument or additional manual action is added.
The current daemon host and the existing Machine RPC both enter the same
access-checked recipient Steer service.

Before provider submission, an unowned access/rewrite refusal leaves inert history for
the existing Operation materializer to retry. Once a request may have been sent,
transport failure cannot activate ordinary dispatch or remove the input. The
recipient retains the late application outcome. A submitted ledger record counts
as durable target input before its history projection catches up. Reconciliation
reports a projected `delivery_unknown` as target failure without resubmitting.
A late duplicate reaching an ended runtime cannot overwrite its submitted
applied/unknown ledger with a not-applied ordinary activation. The original
provider request can still record proven non-application and use its existing
recovery; a duplicate has no such proof.

Steer acceptance uses the existing visible-turn handoff: seal the previous
assistant, bind a new assistant to the incoming user-turn id, and transfer causal
identity before subsequent tools. Operation completion still reads that fixed
input's assistant output. The patch adds no provider implementation, queue
migration, synthesized delivery stages, new timer or cancellation owner.

## Alternatives and migration assessment

Changing receipt wording would clarify waiting without making instructions reach
the active Agent. Moving every chat into `mq` would additionally change mixed
source ordering, queue promotion and delegated provenance; it is unnecessary for
the chosen Steer behavior. Resending an existing input through a manual Steer
button risks duplicate work and is not this repair.

The Effect skill was applied in feature/fix mode. The PR was rebased onto
`a8cffe6f1`: reconciliation now lives in the existing native Effect workflow and
uses its typed history port for Steer ledger reads. Turn/Steer and document
lifecycle remain existing Promise owners; no new migration unit or completion
claim is introduced.

## Verification and limits

On the PR base, seven selected CLI suites passed 601 tests: command admission/MCP
single and batch, local zero-cloud routing, execution/Steer, dispatch watcher,
coordinator and the bounded model. Shared schema tests passed 56 tests. Regressions
cover inert admission, ordinary fallbacks, frozen target/config retry, uncertainty
without replay, late duplicates after runtime end, Operation result identity and
submitted-ledger adoption after restart. Existing execution tests cover Stop,
turn completion, refused steering and late outcomes.

Root formatting passed. Packaged desktop, real provider, remote-machine and
mixed-version/downgrade acceptance were not run. Transport failure without
recipient application evidence remains uncertain under the existing contract;
there is no guaranteed model consumption or maximum time to act.

Root workspace type checking and type-aware lint passed, as did public, platform
and process boundary guards and i18n checks.

Root `pnpm check` passed, including all repository test stages (CLI: 4471 passed, 4 skipped).

Documentation check retains six broken links in the subagent-events note pair,
all present before this change; it adds no errors or SHA-protected topics.

## Related contracts

- [MCP implementation](../../../../apps/cli/src/mcp/README.md#chat-configuration)
- [Draft orchestration intent](../../../../specs/session-orchestration.md#cross-session-follow-up-delivery)
- [Seen receipt race](2026-09-28-send-delivery-seen-race.md)
- [Steer stop/recovery ownership](2026-09-16-steer-stop-recovery-ownership.md)
- [Unsupported composer steering](2026-09-21-unsupported-steer-regular-queue.md)
- [Draft PR #1771](https://github.com/LodyAI/Lody/pull/1771)
