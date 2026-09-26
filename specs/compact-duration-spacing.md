# Compact duration spacing

Status: draft
Translation: current

[中文](compact-duration-spacing.zh.md)

When a user reads a compact elapsed time in the interface, each number and its
unit, and each adjacent unit group, are separated according to the product
language. Chinese shows `7 分 25 秒`; English shows `7m 25s`. The surrounding
sentence owns its own spacing, so the Chinese live status reads
`工作中（工作了 7 分 25 秒）`.

The same duration format applies to live and finished turns, goal metrics,
CI run times, and subagent task durations. Countdown chips use their own
short-label format.

## Evidence

- Implementation: [duration formatter](../packages/components/src/lib/format-duration.ts)
  and [locales](../locales/zh_CN.json).
- Verification: [duration tests](../packages/components/tests/session-history-duration.test.ts).
- Decision: [spacing note](../.agents/notes/implemented/bug-fix/2026-09-26-compact-duration-spacing.md).
