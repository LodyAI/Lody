# Execution freshness during a backend outage

Status: draft
Translation: pending

## Scenario

A person opens a file preview, or sends a message from their own phone to their
own machine, while the backend cannot be reached. The machine already holds a
verified ledger, and the ledger was current minutes ago. Today the machine's
15-minute grant expires, the refresh fails, and the request is refused. An outage
stops work that the verified ledger still permits.

## Decision

The owner approved relaxing the 15-minute refresh in this one case: the machine
tried to read the latest ledger and the read failed in transport. The machine then
keeps deciding from its local verified ledger for a longer window:

| Request | Window after the last successful latest read |
| --- | --- |
| Read (file preview, live status) by the machine's own member | 24 hours |
| Execution by the machine's own member | 1 to 4 hours |
| Any request from another member, including execution through machine sharing | 15 minutes, unchanged |

## Guarantees

- **A refusal is not an outage.** A server reply with an explicit permission refusal
  ends access at once, as it does today. A reply that fails verification or moves the
  ledger backwards is also not an outage.
- **Known revocation still wins.** Every request is checked against the local
  verified ledger. A revocation the machine has ingested stops the affected work
  immediately, whatever remains of the window.
- **A failed read renews nothing.** The window runs from the start of the last
  successful latest read. Only another successful read starts a new one.
- **The clock rules stay.** The monotonic and wall clock checks apply to the longer
  window. Rollback or uncertain suspend/resume ends it.
- **Restart still needs the network.** The window lives in memory, so a restarted
  machine revalidates online before new remote execution.
- **Machine sharing is unchanged.** Another member's execution keeps both the
  15-minute grant and the sharing policy's cache limit.

## Changed bound

During an outage, a revocation the machine has not received can take effect as late
as the end of the window. This replaces the 15-minute worst case for reads and
same-member execution only. The existing Specs already say this bound depends on
the server supplying current state; this decision does not change that dependency.

The window applies per member, not per device, so it also covers a revoked device of
the same member. If a partial outage stops the machine's ledger read while that
device can still reach the machine, the device keeps execution for up to the
same-member window (at most 4 hours) and reads for up to 24 hours.

## Open questions

- Same-member execution window: the approved range is 1 to 4 hours. The proposal
  uses 4 hours, so a typical outage does not stop a person's own work.
- Transport failure: the proposal decides by whether the reply carries an explicit
  refusal code, not by HTTP status.
  - No reply, a timeout, a 5xx, a 429 rate limit and a server error with no business
    error code count as transport failures.
  - Only an explicit permission refusal (removed, revoked, unauthorized) ends the
    window.
  - An expired sign-in is neither. It needs its own rule, which this draft does not
    set.
  - A reply the client cannot understand does not relax anything.
  - A failure partway through a paged read counts as a failed read.

## Existing Specs

This draft does not change them. If it is approved, the implementation updates
these approved passages in the same change, and they return to review:

- [Foundations](../e2ee-foundations.md) and its Chinese version:
  - the "strictly less than 15-minute memory cache" passage;
  - [permission freshness](../e2ee-foundations.md#permission-freshness-and-the-separate-durable-expiry-clock):
    the 15-minute cache and "failed reads cannot renew it".
- [Whitepaper](whitepaper.md) and its Chinese version:
  - "worst-case 15-minute revocation bound" and "failure to refresh by expiry blocks
    new execution";
  - "at most 15 minutes from before its own authenticated latest read".

[Machine sharing](machine-sharing.md) needs no change.

## Related limits

`FLEET_ENCRYPTED_AUTHORITY_LIMIT_MS` in `apps/cli/src/lib/lody-fleet.ts` keeps an
encrypted remote bridge attached for at most 15 minutes without a confirmed ledger
read. If this draft is approved, that limit must change with the windows above.
Otherwise execution would be allowed while the bridge it needs has already detached.

## Evidence

- Current behavior: `apps/cli/src/lib/e2ee/execution-authorization.ts`, where
  `refresh` maps every read failure to a denied `unavailable`.
- "Rollback or uncertain suspend/resume ends it" needs new detection, comparing the
  change in wall clock with the change in monotonic clock. Today a long suspend is
  caught because it always outlasts the 15-minute grant. A longer window removes that
  property.
- Executed validation: none. This is a proposal and nothing is implemented.
