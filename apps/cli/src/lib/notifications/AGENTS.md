# Notification source integration

`CLAUDE.md` symlinks here. Edit `AGENTS.md` only.

- `turn-notification-audience.ts` interprets exact input provenance, not Session
  parent/opened-by metadata. Provenance is not authorization; requester identity
  stays frozen in the execution invocation. Missing RPC history is unknown.
- Execution freezes one terminal fact after resource/Inbox settlement and the final
  Stop check. Release the prompt slot before awaiting `onTurnOutcome`; the existing Host
  work drain owns delivery through shutdown, independently of Inbox launch. Never retry the callback
  or re-run Agent work to notify.
- MessageHandler consumes the actual AttentionItem (source, scope, outcome) and
  `notifyTurnOutcome` submits mobile through the legacy-named cloud adapter. It
  projects user terminal outcomes into a latest control-document
  notification and independently submits mobile via the optional cloud port.
  `SessionMeta.notificationId` is a 36-byte low-frequency activation index; the
  payload belongs in the control document, never metadata or history scans.
- `terminalNotifications: 1` selects the desktop terminal consumer. Older CLI
  peers retain the legacy idle observer; never run both for the same peer.
- New producers require the outcome/versioned-permission protocol and always send
  bounded display context. No capability probe, legacy fallback, or transport retry.
  Deploy the compatible backend first; old server actions remain for old clients.
- User result origins travel through the Host invocation and frozen Operation config.
  Execution inherits the full scoped Inbox membership, not the inline preview or
  synthetic author. Origin ids are not authorization and never leave local orchestration.
  Success waits for related active Operations/unconsumed results; failed/unknown
  work alerts immediately. Bind inherited origins to their recipient across steer.
  RPC/steer can precede history sync: resolve pending provenance from the exact
  input before accepting an Operation, or reject retryably without persisting it.
- Permission push and silent Live Activity sync are independent. Provider
  acceptance cannot suppress an ordinary permission alert.
- Best-effort delivery is intentional. No notification database, outbox, pending
  TTL, background retry, reconnect replay, lock-to-mobile handoff or exactly-once
  protocol. Existing execution/Operation persistence and recovery are unchanged.
- Never await notification work before the provider prompt. Outcomes belong at
  finalization; errors, cancellations and unknown results are not success/idle.
- Tests: `../../../tests/turn-notification-audience.test.ts` and the owning
  session-execution suite cover provenance, outcomes and failed one-shot submission.

- Presentation reads at most 32 exact originating inputs after execution release,
  under a document lease; larger/mixed batches use the conversation name. Resolve
  project display names locally, never GitHub or full filesystem paths. Mobile
  display names and optional reply excerpts cross the cloud/provider boundary.
  `TurnOutcomeFact.assistantTurnId` freezes the actual output entry before release;
  `MessageHandler.buildNotificationPresentation` reads that one entry for the excerpt,
  never the latest reply or the original delegated input. Missing/unreadable output
  preserves existing context. Raw tool inputs/errors are not separately attached.
- Scheduled prepared user turns use ordinary result policy; do not special-case
  `SessionMeta.scheduleId` or parse prompt text to choose whether to notify.
- Public `notifySessionCompleted` cloud/IPC names remain compatibility boundaries.
  Do not rename deployed methods or provider logical keys during internal cleanup.
