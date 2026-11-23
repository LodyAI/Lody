# Local Loro writer

`CLAUDE.md` symlinks here. Edit `AGENTS.md` only. Parent shared rules apply.

- One application owns `LocalLoroWriterLive`, its global FIFO pacer and one
  writer/drain subscription per physical connection across all workspace engines.
  Presence, machine-monitor, doc and Flock frames use that same writer.
- `index.ts` composes native Effects; never execute a runtime or import Legacy
  inside it. Admission callbacks only enqueue names/Effects. Pure CRDT/frontier
  and framing computation stays synchronous. Only `sdk.ts` adapts the real Flock
  SDK Promise; it retains actual settlement when cancellation cannot stop it.
- Every task/frame crosses the injected real host turn; `yieldNow`/`sleep(0)`
  alone do not establish host I/O fairness on Effect 4.0.2. Node implementation:
  `../node/local-loro-writer.ts`. `send(false)` pauses export and sending until drain.
- Close revokes queued work synchronously, joins actual running work and removes
  subscriptions. A bounded observer failure retains the owner and full Cause;
  concurrent close shares a receipt, and replacement waits for successful recovery.
- `legacy.ts` is the sole deprecated writer execution facade, used by the explicitly
  Legacy room engine and CLI doc/socket owners. Delete after those application
  owners provide the native service. Room resolution/join/leave/import and LoroRepo
  remain Legacy; a native writer does not certify their migration.
