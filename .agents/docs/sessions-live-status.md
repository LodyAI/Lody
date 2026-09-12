# Live working/waiting status and dispatch state

Presence versus durable meta, the bounded pre-start window, and message submission routing.

Scope: `packages/components/src/components/sessions`. Binding rules and the
pointer to this page live in
[that directory's AGENTS.md](../../packages/components/src/components/sessions/AGENTS.md);
this page is the full text of the rules summarised there.

- `floating-permission-request.tsx`: floating permissions + ask-user-question;
  hidden-composer mobile keyboard lift/scroll lives there.
  `notification-permission-prompt.tsx` and the inner content of `session-pin.tsx`
  use the same `ConversationColumn` as the stream and composer; keep full-bleed
  bands outside that column, but never let their interactive content span the pane.
- Live working/waiting UI (spinners, permission badges, Stop visibility, tab/dock
  status) must use presence (`sessionLiveStatusAtomFamily` or an explicit
  `liveSessionStatuses` map), not `SessionMeta.status` / `lastRunningSeen`.
  Session meta status is durable/historical state and can be stale until a write
  lands; presence is the single source for "is working now". The meta dispatch
  pointers (`latestUserMsgId` / `lastHandledUserMsgId` / `processingUserMsgId`)
  are CLI dispatch mechanics and must not drive UI either — a stale meta plane
  once left finished conversations showing "Starting…" forever. The one
  frontend-derived activity state is the dispatched-but-not-started window,
  read from the trailing `pending`/`seen` user turn in session history via
  `lib/session-dispatch-state.ts`; history is the same doc the transcript
  renders from, so it cannot contradict the visible conversation. That pre-start
  window is TIME-BOUNDED: `resolveUnstartedTrailingDispatchAtMs` anchors on the
  turn's own durable `timestamp` and the UI stops showing "Starting…" once
  `UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS` (30s) elapses with no CLI presence.
  The bound exists because a crashed daemon / desynced dispatch pointer / stuck
  sync otherwise left "Starting…" showing forever (reading as a stuck-busy
  agent) — presence never arrived to clear it, and the machine could still look
  online. Anchor on the durable timestamp, NOT a component mount time: a stalled
  turn must report its full age immediately after a reload instead of restarting
  the 30s clock. The window only needs to cover send → the CLI's FIRST
  `initializing` presence (published the moment the turn owns the session); every
  later phase reports its own presence, so do not widen the timeout to cover a
  whole agent run. Durable resolution of a truly stalled turn still comes from
  CLI-side reconciliation on the next daemon start; the timeout only bounds the
  optimistic UI. Message SUBMISSION ROUTING has one deliberate conservative
  exception to presence-only display state: an unfinished assistant transcript is
  an ordering barrier when presence is momentarily absent. `session-message-submit-route.ts`
  must queue in that state (even when the preference is guide; steering requires
  positive live prompt activity), because queue promotion is safe for both a live
  turn and a stale transcript while direct dispatch can create a second accepted
  turn. This barrier affects routing only; it must not relight Working UI or enable
  Stop. That pre-start label is additionally suppressed whenever the
  status chip has an active connection/machine problem (`statusStripState !=
null`: browser offline, machine removed or offline) — the chip owns that story,
  and "Starting…" next to "machine offline" is a contradiction. `isSessionWorking`
  (Stop visibility, busy-send queue routing) shares the SAME time-bounded
  pre-start signal, so a stalled dispatch no longer holds the composer in a busy
  state either.
