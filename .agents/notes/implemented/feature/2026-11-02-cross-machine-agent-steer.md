# Cross-machine Agent chat steering

Status: implemented
Translation: current
PR: [#2223](https://github.com/LodyAI/Lody/pull/2223)

[中文](2026-11-02-cross-machine-agent-steer.zh.md)

## Abstract

Agent chats previously queued whenever their target ran on another Machine.
The sender now reuses the UI's active-assistant history resolver and offers one bounded steer.
Applied input and execution-owned recovery stay with the target daemon.
Unconfirmed remote input still awaiting steer becomes an ordinary follow-up, accepting
possible duplication over permanent non-delivery; the target is never canceled.

## Decision and limits

The [orchestration contract](../../../../specs/session-orchestration.md) owns the behavior.
Local steering and encrypted member derivation rules stay intact. Setup has a separate
15-second budget for cold token/gateway lookup and client subscription. Entering the
connected-client callback clears that timer; the request then has its own five-second
response timeout, matching the UI. Sharing one deadline would shorten response time
and promote input while the remote provider could still accept it. Late setup cannot
submit a steer after fallback. No RPC retry is added.
`requeueUndeliveredSteer` documents that dispatch skips `pending_apply`: an RPC that
never arrives leaves an orphan with no execution owner. Unreachable setup, timeout,
transport failure and responses without recovery ownership therefore promote only
`pending_apply` and reuse durable dispatch, preserving started/settled input. Operation
recovery also queues an orphan left by sender interruption or a failed fallback write.
A lost reply can duplicate delivery across replicas; this deliberately differs from
UI uncertainty and local `STEER_DELIVERY_UNKNOWN` policies, which remain unchanged.
The owning command suite uses real Loro history and fake RPC for delivery, fallback,
recovery and late startup. It does not establish live Machine/provider acceptance.
