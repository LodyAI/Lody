# Continue after a Claude quota reset

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1973

[中文](2026-10-27-quota-continue.zh.md)

## Abstract

Claude session-limit failures can stop a conversation until the five-hour quota resets.
The terminal failure banner now carries a one-click row that reserves one literal
`continue` message for the first full minute after the provider reset. The action requires
a matching exhausted quota with a known future reset, leaves the composer draft untouched,
and never schedules on render. It replaces the previous composer-level shortcut so the
explanation and the recovery share one card.

## Decision

- Read only the hydrated tail through ConversationView. Match the latest terminal
  `chat_failed` provider notice after the latest user turn. A later assistant turn means the
  conversation recovered and suppresses the shortcut. Match Claude's session-limit prefix;
  a generic `acp_internal_error`, quoted user prose, or a weekly-limit message never
  authorizes it.
- Resolve the exact Agent config/model quota and require an exhausted 18,000-second window.
  Its absolute reset timestamp supplies the only time; reject expired or missing resets,
  failures older than that window, and another exhausted quota that remains blocked
  afterwards. Refresh through the existing provider quota owner while the banner is
  visible. Do not parse localized AM/PM text.
- The in-banner row states the exact scheduled instant and offers `Schedule`. One click
  reserves literal `continue` at the first full minute after reset (2:31 PM for a 2:30 PM
  reset), in the same conversation, with the failed user turn's model/mode/options, memory,
  MCP selection and Role provenance. It does not replay the original task, attachments or
  prompt prefix. The composer draft and selected run-config edits remain untouched. Nothing
  is scheduled on render.
- Derive reservation, activation and creation identities from workspace, conversation and
  reset instant and failed user turn. Repeated clicks and uncertain durable-write retries converge on the same
  reservation. A conflicting payload is rejected rather than overwriting an edited
  reservation. Existing reservations become the row's receipt and open the schedule detail,
  including sent/cancelled states; cancellation and offline catch-up follow the
  [scheduled-message contract](../../proposed/feature/2026-10-27-scheduled-messages.md).
- The automatic Session recovery setting suppresses a new manual shortcut while leaving existing reservations accessible. Unassociated legacy reservations follow the [discard decision](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.md).
- Protected workspaces do not run Automation; their authorized scheduled messages continue through the Schedule owner directly.
- Preserve ownership, complete-message protocol and protected-workspace gates. The
  quota/history subscription is a leaf inside the failure banner, not the composer or the
  conversation tree. The machine-owned scheduler remains the execution owner; no renderer
  timer sends messages. There is no second composer-level shortcut.

## Evidence and limits

Synthetic behavioral coverage verifies the banner mount (including a notice folded onto the preceding assistant row), one durable full-message
reservation, frozen configuration, repeated clicks, uncertain-save retry, unchanged source
history, missing/expired reset, weekly/foreign/stale quota, first-full-minute rounding,
recovered conversations, and ownership/capability gates. Storybook fixtures cover desktop,
390 px mobile, pending, scheduled, dark and Chinese states without page errors or horizontal
overflow. The user approved option D in the design review. No real user transcript is checked
in; packaged-client and real-provider execution remain unverified.
