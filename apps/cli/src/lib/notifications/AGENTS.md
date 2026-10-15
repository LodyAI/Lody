# Notification source integration

`CLAUDE.md` symlinks here. Edit `AGENTS.md` only.

- `turn-notification-audience.ts` interprets exact input provenance, not Session
  parent/opened-by metadata. Provenance is not authorization; requester identity
  stays frozen in the execution invocation. Missing RPC history is unknown.
- Execution emits a typed terminal fact through `onTurnOutcome`. Mark the attempt
  before calling the consumer: failure or uncertainty ends that notification.
  Never retry the callback during finalization or re-run Agent work to notify.
- MessageHandler consumes the actual AttentionItem (source, scope, outcome) and
  `notifyTurnOutcome` submits mobile through the legacy-named cloud adapter. It
  projects user terminal outcomes into a latest control-document
  notification and independently submits mobile via the optional cloud port.
  `SessionMeta.notificationId` is a 36-byte low-frequency activation index; the
  payload belongs in the control document, never metadata or history scans.
- `terminalNotifications: 1` selects the desktop terminal consumer. Older CLI
  peers retain the legacy idle observer; never run both for the same peer.
- Cloud capabilities are probed once per NotificationService lifetime. New servers
  receive generic outcome/versioned permission requests without private titles;
  old servers receive the old success/permission shape. Unsupported failure or
  unknown outcomes are skipped. Never fallback after an attempted action.
- Permission push and silent Live Activity sync are independent. Provider
  acceptance cannot suppress an ordinary permission alert.
- Best-effort delivery is intentional. No notification database, outbox, pending
  TTL, background retry, reconnect replay, lock-to-mobile handoff or exactly-once
  protocol. Existing execution/Operation persistence and recovery are unchanged.
- Never await notification work before the provider prompt. Outcomes belong at
  finalization; errors, cancellations and unknown results are not success/idle.
- Tests: `../../../tests/turn-notification-audience.test.ts` and the owning
  session-execution suite cover provenance, outcomes and failed one-shot submission.

- Scheduled prepared user turns use ordinary result policy; do not special-case
  `SessionMeta.scheduleId` or parse prompt text to choose whether to notify.
- Public `notifySessionCompleted` cloud/IPC names remain compatibility boundaries.
  Do not rename deployed methods or provider logical keys during internal cleanup.
