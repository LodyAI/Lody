# Cloud sync reconnect pacing

Status: draft
Translation: current

[中文](cloud-sync-reconnect.zh.md)

A machine loses its network, or the local proxy it reaches the cloud through
dies, and nobody notices for two hours. The cloud control-plane subscription —
organization, membership and access information, carried over one WebSocket —
cannot connect for that entire window. What the machine owes the user here is
modest: come back promptly once the network does, and stay quiet meanwhile. It
owes the cloud the same quiet, since every client behind a broken shared proxy
fails at the same moment.

Retry pacing is the whole of that promise. A client that keeps a fixed retry
interval during a long outage is indistinguishable from a client that is
hammering a service that is already down: the two-hour failure above produced
roughly 450 connection attempts, an attempt every 8-24 seconds from the first
minute to the last. Retries must therefore keep growing while failure persists,
up to a ceiling measured in minutes rather than seconds, and keep their random
jitter so that many machines recovering together do not synchronize.

Slower retries must not mean slower recovery. Backing off to minutes is only
acceptable because the ceiling is not the only way back: when something else on
the machine proves the network is usable again — today, the content-sync data
plane reaching health — the waiting connection starts immediately instead of
serving out its remaining delay. That signal is cheap and may flap while a
transport is unstable, so it forces at most one extra attempt per minute; the
first signal of an outage, the one that actually carries the recovery, is never
the one that gets dropped.

A recovery signal usually arrives when there is nothing to release yet: the
client may be asleep between its own retries, or an attempt may still be in
flight and about to fail. Such a signal is remembered rather than spent — the
next connection attempt starts without waiting out the delay that the failure
installs in the meantime — and only an attempt that actually ran answers it.
Otherwise a machine whose network returns at the wrong moment would keep waiting
for a second signal that a healthy transport never sends.

A connection that opens is not yet a recovery. One that opens and dies seconds
later is a failed attempt and keeps the backoff growing; only a connection that
holds resets it. The control plane and the content-sync plane back off
independently, and neither delays the other: the two connections fail for the
same reasons but recover on their own signals.

Unresolved: only the content-sync plane currently supplies the online signal, so
a machine whose content sync is not attached falls back to the ceiling alone.
Higher-level retries above this connection (PR polling's initial-sync wait, for
one) still keep their own fixed intervals and are not covered here.

Evidence: the outage above is machine-local CLI log data (`~/.lody/logs`,
2026-09-16 04:50-06:50 UTC), not reproducible from this repository.
Implementation: `apps/cli/src/lib/cloud-sync-reconnect.ts`, composed in
`apps/cli/src/lib/cloud-cli-port.ts` and signalled from
`apps/cli/src/commands/start.ts`; the backoff curve, the forced-reconnect floor
and the stability rule are validated under fake timers in
`apps/cli/src/lib/cloud-sync-reconnect.test.ts`. The upstream client's own
retry constants are inspected, not controlled, by this repository.
