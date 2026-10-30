# Automation matches are final

Date: 2026-10-30
Status: implemented
Translation: current

[中文](2026-10-30-automation-match-is-final.zh.md)

## Abstract

An already matched automation could remain blocked forever when reevaluation no longer saw the event that produced its result. A match and its continuation are now final once committed; recovery delivers that original result after current authorization, Session admission and Host-captured source evidence checks. This does not guarantee that an event remains visible until the first check.

## Boundary

The workspace owner evaluates the program only while its Wait is checking. The ledger atomically commits the result, evidence and continuation identity; after restart the same receipt drives delivery without executing the program again. Cancellation still revokes the Wait and receipt, Stop blocks admission until restoration, and existing PR association, HEAD and workflow evidence checks can supersede or defer delivery. A newly desired condition needs a new Wait; no implicit continuous JavaScript guard is introduced.

The existing Session and Inbox owners retain acceptance, cancellation and reconciliation of uncertain submissions. The Effect runtime still owns evaluation and its cancellation; the Promise bridge owns and joins Session reads. No storage migration is needed because previously matched Waits already contain the durable result and receipt identity. This corrects the earlier predicate recheck described by the [Stop decision](2026-10-30-automation-pending-observations-and-stop.md).

The workspace regression matches a synthetic event, blocks on Stop, moves the event outside the 50-item read window, restarts the on-disk owner and verifies that the original result reaches the Session queue once after restoration. Existing tests cover cancellation and changed CI evidence. Live providers and delivery across devices were not tested.
