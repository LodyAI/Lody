# Roost browser receipt recovery

Status: proposed
Type: bug-fix
Translation: current
PR: [#1699](https://github.com/LodyAI/Lody/pull/1699)

[中文](2026-10-18-roost-remote-receipt-latency.zh.md)

## Abstract

A Roost input could wait through unrelated RPC timeouts before the browser
replaced a connected but unproductive response read. After an input append,
the client now renews a still-pending response read once at two seconds using
long polling, preserving the original request, offset and deadline. Regression
and renderer tests verify recovery of the actual encrypted receipt without
replaying input. This needs no remote CLI update and bounds the recovery trigger,
not owner processing or end-to-end delivery.

## Evidence and boundary

Investigation used locked streams-client 0.12.0 and local source at `17c76466b`;
the patch also applies to `fbc850c99`. Deployed client/daemon revisions were not
established. One authorized send in an existing remote session was captured with
DevTools Network and Performance already recording; earlier timing came from its
retained diagnostics. No captured content or identifiers are included here.

| Pre-fix observation | RPC duration | Request append |
| --- | ---: | ---: |
| Earlier first input | 27,739 ms | 939 ms |
| Recorded later input | 2,140 ms | 402 ms |

The earlier post-append wait was approximately 26.8 seconds. The client selected
long polling during that wait after response timeouts. This is a recovery
heuristic, not proof that the owner had already replied; neither timing measures
the fix. The later send already used long polling and incremental history watch.
Its CPU and network work overlapped, so the capture cannot split the original
wait into request delivery, owner processing and response delivery.

Both backends use the common RPC response stream. Loro can additionally expose
delivered history status through document synchronization. Roost's authoritative
history/status reads also use RPC; its control cursor is only an invalidation
hint. Neither that cursor nor source-written human provenance proves acceptance.
Loro human Inbox admission can itself await I/O; it is not universally memory-only.
Roost also waits for owner/backend metadata and native acceptance/activation.
A truthful client receipt cannot remove those waits. Local desktop-to-Docker
routing can still use Streams, so a successful local run does not rule them out.

## Recovery contract

Successful append of `accept_input` or `accept_input_and_dispatch` arms a timer
only for policy-enabled, unpinned clients. After two seconds without the reply,
the dispatcher renews its shared read from the saved offset: SSE falls back to
long polling and an existing long poll is renewed too. One renewal covers
currently appended overlapping inputs; each participates at most once. Unrelated
replies cannot postpone the timer; idle history watches do not arm it.

Pending request identities, encrypted validation and original deadlines remain.
There is no replay or inferred delivery. Receipt, timeout, cancellation and stop
remove timer eligibility. Intentional read aborts reconnect without the error
backoff; diagnostic failures cannot interrupt recovery. Explicit pins and clients
without a live-mode policy retain their behavior. The existing five-minute SSE
cooldown prevents immediately undoing recovery. A healthy but slow owner can also
trigger the extra GET/CORS work; two seconds is a latency heuristic.

The dispatcher owns the timer/read controller. Cancellation ends local waiting,
not accepted owner work; no new writer or subscription owner is created. Native
Effect migration was assessed and deferred: complete upper request/read/cancel
consumers remain Promise orchestration. No facade or runtime is added.

## Verification and rollout

Fake-clock regressions cover SSE/long-poll renewal, delayed append and owner,
overlapping inputs, unrelated/duplicate replies, abort/diagnostic failures,
healthy SSE, pins, cancellation, timeout and stop. Removing timer scheduling
makes the recovery regression fail. The renderer bridge uses the real pinned
SDK and encryption with synthetic HTTP/SSE; one write recovers a receipt from
offset 42 without history readback or control-document history writes.

A separate controlled before/after probe kept a genuine encrypted receipt ready
while withholding SSE. Baseline remained pending at two seconds and accepted
only when released at ten seconds; the fix renewed and accepted at two seconds.
Healthy SSE accepted at virtual time zero in both. These are fake-clock fault
controls, not network measurements or a claim baseline always takes ten seconds.
Temporary source/suite changes were restored exactly.

The RPC, renderer and sender suites pass; workspace verification is reported in
the PR. Documentation checking retains six baseline broken links to absent ACP
sources, with no protected-topic changes. Wire schemas/capabilities are unchanged.
The browser change can ship before a remote CLI update. It has not been deployed
or remeasured in the original remote session, so the 26.8-second wait remains
unattributed. Owner metadata, queueing, storage and request delivery remain outside
this recovery trigger's guarantee.
