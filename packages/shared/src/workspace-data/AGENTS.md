# Workspace data

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

- Compose one `loro-repo/effect` Repo per workspace owner. Borrow native Doc,
  Flock and room leases in caller Scopes; never construct a parallel Promise Repo.
- Native modules do not import Legacy workflows or execute `Effect.run*`.
  `repo-legacy.ts` is the sole deprecated execution door for current CLI managers,
  renderer stores, shortcut grants and snapshot migration readers. Delete it as
  those consumers accept native Repo and caller Scopes directly.
- Legacy Doc/Flock handles borrow the cached replica. Store disposal releases its
  borrow; cache eviction persists before releasing the cached hold. A failed
  save leaves that replica borrowable, without reviving a retiring native lease.
- Open absence is distinct from explicit business identity creation. A peer
  baseline never proves server absence, upload ACK or local durability. Keep
  server, peer and local authority separate and require fresh confirmation.
- Legacy room status includes actual attachment/routing: an absent route is
  detached even if its native detail ref starts joining. First-sync waiters
  survive deliberate absence and settle only on a routed baseline or failure.
  A failed readiness wait stays failed; later reads wait on current native state,
  so recovery of the same binding never replays a cached rejection.
- Read inventory and transport snapshots from native leases. Keep local room
  records only for ownership release. On an online transport, retry only failed/
  offline rooms and SDK-proven failed initialization still projected as joining,
  through native sync/reconcile. Bindings expose that proof as `initializationFailed`;
  renderer trackers count it as needing reconnect, repaired with the loop's backoff
  ([note](../../../../.agents/notes/implemented/bug-fix/2026-10-19-renderer-streams-create-missing.md)).
  Pending/retrying baselines stay owned; a room failure never requests a shared
  server reset, including wake/auth/force triggers.
  Reset a server transport only when its own status is offline/closed/failed.
  Preserve forced peer reconnect for local v7 worker recovery. Do not rebuild
  the full Promise Repo subscription or query APIs.
- Pass the room borrow's signal to native waits at Promise boundaries; retiring
  one borrower must cancel its wait without retiring another borrower's replica.
- Legacy `waitUntilSynced` is a selected-route write barrier: require a captured
  server upload ACK or a peer protocol receipt, never readiness alone.
- Register the transport Scope owner before construction/connect can suspend.
  Removal cancels pending acquisition; late completion cannot publish or remove
  a successor. The next add retries a retained release failure for that id.
- Record newly authored Provider rows at the writer boundary. Only probes with
  a pending config write wait for the selected local peer; ordinary refreshes
  need no data-plane receipt. Clear only the write covered by that receipt.
  Saves stay local-first; peer handoff never proves server authority.
- Close borrower Scopes before Repo close. A failed finalizer retains its full
  Cause and native retry owner; closing an already closed Scope cannot retry it.
  Private SDK constructor/connect/join finalizers share that boundary: SDK
  `DurableReleaseFailure` retries its actual `retryRelease` receipt.
  The next acquire retries a failed owner. Independent workspace cleanup must
  continue after failure, then report errors; a failed dispose remains retryable
  without reopening admission. Do not dispose storage while accepted I/O is pending.
  Background stream diagnostics never veto close or retain unbounded Causes.
- Document cursor reuse is explicit and limited to the same persisted replica.
  Meta/Flock checkpoints remain replica-bound. Never share worker cursors with UI.
- Product code uses the native local v7 client; the previous client lives only
  in test-support as a host wire-compatibility fixture. The native client owns bounded protocol queues and workers in Scope; physical
  Electron callbacks only enqueue events. After overflow, reconnect drains the old
  worker and rebuilds its bounded queue before catching up from the retained
  replica. Recover rooms independently. Keep recovery and close serialized per
  room. Connection status dispatch never waits for recovery; a scoped task per
  room coalesces physical online edges while healthy rooms keep receiving status.
  Settle unconsumed sync waits too. Overflow must not permanently fence the
  room or retire its lease.
- Never log private Causes, grants, cursor URLs or request bodies. Project only
  upstream validated diagnostic scalars.

Decision and verification: [native ownership](../../../../.agents/notes/proposed/architecture/2026-10-16-native-workspace-repo.md).
