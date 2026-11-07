# Execution freshness during a backend outage

Status: approved · [approval](../../.agents/notes/implemented/architecture/2026-10-28-e2ee-spec-approval.md#execution-freshness-during-a-backend-outage)
Translation: current

[中文](execution-freshness-outage.zh.md)

## Scenario

A person opens a file preview, or sends a message from their own phone to their
own machine, while the backend cannot be reached. The machine already holds a
verified ledger, and the ledger was current minutes ago. Today the machine's
15-minute grant expires, the refresh fails, and the request is refused. An outage
stops work that the verified ledger still permits.

## Decision

The 15-minute refresh is relaxed in this one case: the machine tried to read the
latest ledger and could not get an answer. The machine then keeps deciding from its
local verified ledger for a longer window:

| Request | Window after the last successful latest read |
| --- | --- |
| Read (file preview, live status) by the machine's own member | 24 hours |
| Execution by the machine's own member | 4 hours |
| Any request from another member, including execution through machine sharing | 15 minutes, unchanged |

## Guarantees

- **A refusal is not an outage.** A server reply with an explicit permission refusal
  ends the window at once, as it does today.
- **People can see it.** While a machine relies on a window, the user sees a notice
  that access could not be confirmed. An expired sign-in also asks them to sign in
  again.
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
device can still reach the machine, the device keeps execution for up to 4 hours and
reads for up to 24 hours.

## What counts as an outage

The rule is whether the reply carries an explicit refusal, not its HTTP status.

| Result of the latest read | Effect |
| --- | --- |
| No reply, timeout, 5xx, 429, a server error with no business error code | Outage: the window applies |
| Expired sign-in | Outage: the window applies, and the user is asked to sign in again |
| Failure partway through a paged read | Outage: the read failed |
| Explicit refusal: removed, revoked, unauthorized | The window ends at once |
| A reply the client cannot understand, a reply that fails verification or moves the ledger backwards | Treated as a refusal: nothing is relaxed |

## Existing Specs

These passages keep the 15-minute behavior for ordinary operation and link here:

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
encrypted remote bridge attached for at most 24 hours without a confirmed ledger read,
the longest window above. It changes with the windows: otherwise a request could be
allowed while the bridge it needs has already detached.

## Evidence

- Implementation: `apps/cli/src/lib/e2ee/execution-authorization.ts`, with the outage rule
  in `ledgerReadFailure` (`apps/cli/src/lib/cloud-e2ee-errors.ts`).
- "Rollback or uncertain suspend/resume ends it" compares the change in wall clock with
  the change in monotonic clock, because a long suspend no longer always outlasts the grant.
- An expired sign-in is recognized by `e2ee_sign_in_expired`. The service does not send that
  code yet: it reports an expired sign-in as unauthorized, which ends the window.
- The notice is a runtime issue shown by `lody daemon status`. Other client surfaces do not
  show it yet.
- Executed validation: `apps/cli/tests/e2ee-runtime.test.ts` ("backend outage windows")
  and `apps/cli/tests/lody-fleet-local-catalog.test.ts`, on synthetic ledgers with injected
  clocks. No real backend outage was run.
