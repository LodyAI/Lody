# Local Loro writer

One application provides `LocalLoroWriterLive` with `LocalLoroWriterTurn`. The service
owns a global FIFO pacer, one write/drain owner per physical connection, and ordered
workspace lanes within that writer. Each task or remaining chunk crosses a real host
turn; parked lanes retain their order across backpressure. Presence, machine-monitor,
doc and Flock tasks share the same admission path.

`offer` only admits an Effect and names its owner/coalescing key. It never exports or
writes inline. `closeOwner`, `disconnect` and `close` are native Effects. `revoke`
fences an owner synchronously; `dropRoom` discards obsolete room work. An owner can
have one running task plus one queued task for each coalescing key. Presence encodes
the latest local-origin snapshot when its task actually executes, including deletion.

`index.ts` is the native workflow; `sdk.ts` is the sole Flock SDK Promise boundary.
CRDT exports/frontiers and framing stay ordinary synchronous computation in the
consuming room engine. `../node/local-loro-writer.ts` supplies the real Node turn and
socket adapter. `legacy.ts` is the one deprecated execution facade; CLI document and
socket consumers and `LocalLoroDataPlaneServerLegacy` use it until application owners
provide the native service directly. Room resolve/join/leave/import and LoroRepo have
not migrated.

Close revokes queued work and joins actual running SDK settlement. Each observer wait
has its own five-second Clock bound, including inside a finalizer. Expiry retains the
owner and complete Cause in `LocalLoroWriterReleaseFailed.retry`; it does not prove that
raw work stopped. Concurrent close joins one receipt. Failed drain unsubscribe retains
the connection generation and blocks replacement until recovery succeeds.

Tests extend the existing shared server/framing/bulk suites and CLI socket boundary
suite. The AST guard is `pnpm check:local-loro-writer-boundary`. Decision, source
semantics, acceptance evidence and upper-layer limits:
[owning note](../../../../.agents/notes/implemented/architecture/2026-10-12-effect-local-presence-writer.md).
