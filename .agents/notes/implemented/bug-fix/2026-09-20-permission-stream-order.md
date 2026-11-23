# Permission history ordering

Status: implemented
Translation: current

[中文](2026-09-20-permission-stream-order.zh.md)

## Abstract

Permission requests could insert a tool row before previously received text had
left the ACP batch buffer, splitting one sentence into separate Markdown blocks.
The permission handler now waits for the turn history gate and drains buffered
and in-flight notifications before attaching the request. If the bounded drain
leaves pending writes, the request is cancelled through the existing unobservable
permission path. This fixes local persistence ordering, not genuinely interleaved
provider text/tool events.

## Decision and verification

Reuse the existing drain and retry ownership rather than adding a second writer
or joining all prose across tools. Message IDs identify messages, not necessarily
individual text blocks; blanket joining would erase valid tool/answer boundaries.
Real SessionDocument tests cover a buffered tool, a tool synthesized by permission,
preservation of the following answer, retry after failed persistence, and
cancellation when a different turn takes ownership during the drain.
The screenshot's exact production trigger remains unverified without its event trace.

The Lody integration updated the Claude adapter from ed9582c to 56b94c6;
both already used Claude Agent SDK 0.3.274. An SDK upgrade is not established as
the cause of that integration's reported regression.
