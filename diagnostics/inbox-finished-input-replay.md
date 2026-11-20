# Incident evidence: repeated dispatch of finished Inbox inputs

This is a redacted diagnostic excerpt, not a conversation transcript. Session IDs,
turn IDs, workspace names, private repository names, paths and endpoint URLs are
replaced with placeholders. Times are UTC on 2026-11-20. No raw database is included.

## Environment and sequence

- Lody CLI 0.106.0, Node 26.8.2, Linux ARM64 in an Ubuntu 24.04 container.
- The container had a 16 GiB cgroup memory limit. Docker recorded an `oom`
  event at 06:38:12. Logs do not identify which process was OOM-killed.
- Two active coding-agent turns were interrupted at 06:38:13–14. The Lody
  `start` service began again at 06:38:15.
- Repeated dispatch attempts for the same two user turn IDs started at 06:38:25
  and continued for more than three hours. A read-only count at 09:41 UTC
  found more than 370 failed `inbox-prepare-failed` attempts for each session.
- The daemon reported degraded / reconnecting and zero active sessions. Network
  transport failures existed before the OOM as well, so their causal role in
  the stale dispatch state is unproven.

## Sanitized diagnostic excerpts

The following are selected log messages with identifiers and nonessential fields
redacted; `S1` and `T1` are consistent aliases, not real IDs.

```text
06:38:01.735Z [streams-crdt] join first sync failed: fetch failed
06:38:04.916Z [start] Loro streams transport status: disconnected
06:38:12       [docker] container oom
06:38:13–14    [agent session] turn_aborted: interrupted
06:38:15.157Z  [start] Start action entered
06:38:15.202Z  [start] Starting agent service...
06:38:25.295Z  [dispatch] sessionId=S1 userTurnId=T1
06:38:25.296Z  [execution.prepared_session_turn] sessionId=S1 turnId=assistant:T1
06:38:25.298Z  [execution.visible_turn] outcome=inbox-prepare-failed
06:38:25.298Z  [execution.prepared_session_turn] status=error
  INBOX_EXECUTION_REJECTED: inspect blocked resources with lody session recover-inbox
```

A second session repeatedly shows the same pattern for its own unchanged input
ID. This is the observed sequence, not a deterministic reproduction recipe.

## Read-only local Inbox state

At inspection time both repeatedly rejected sessions had the same state:

```text
inbox_sessions:  blocked=0 paused=0 active_execution=NULL active_input=<turn>
inbox_inputs:    input_id=<same turn> finished=1 canceled=0
inbox_resources: execution_id=assistant:<same turn> state=released
inbox_releases:  execution_id=assistant:<same turn> outcome=failed
```

For the installed 0.106.0 bundle, `accept()` treats the existing non-canceled
input as a duplicate, and `begin()` returns false when that input is finished.
`makeExecutionOwner()` converts that false result to the generic
`INBOX_EXECUTION_REJECTED` error above. Rejection prevents duplicate execution;
the defect observed is that dispatch repeatedly selects the same ended input.

The reason the dispatch side continued to select this input, including whether
transport reconnection caused or merely exposed stale state, remains unproven.
Other sessions in the same store had genuinely blocked resources; they are not
evidence that either repeatedly rejected session was still blocked.

## Current-source caveat

The public main branch already has an `inputEnded()` check and logic that tries
to continue or retire interrupted inputs. We have not reproduced this incident
on that version and cannot say whether upgrading fixes this instance. It would
be useful to exercise the old persisted state against a newer build in a safe,
synthetic regression test.
