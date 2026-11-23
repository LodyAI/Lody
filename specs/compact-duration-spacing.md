# Compact duration spacing

Status: draft
Translation: current

[中文](compact-duration-spacing.zh.md)

Compact elapsed time follows the product language. Chinese joins numbers,
units, and adjacent unit groups without spaces (`7分25秒`); English keeps its
existing format (`7m 25s`). The Chinese surrounding label also joins directly
to the duration, so the live status reads `工作中（工作了7分25秒）`.

The same duration format applies to live and finished turns, goal metrics,
CI run times, and subagent task durations. Countdown chips use their own
short-label format.

## Evidence

- Implementation: [duration formatter](../packages/components/src/lib/format-duration.ts)
  and [locales](../locales/zh_CN.json).
- Verification: [duration tests](../packages/components/tests/session-history-duration.test.ts).
- Decision: [spacing note](../.agents/notes/implemented/bug-fix/2026-09-26-compact-duration-spacing.md).
