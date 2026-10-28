# Continue after a Claude quota reset

Status: proposed
Translation: current

[中文](2026-10-27-quota-continue.zh.md)

> Superseded: the composer shortcut was removed on 2026-10-27 because
> `recoverCapacity` now owns quota continuation. See the
> [retirement note](../../implemented/feature/2026-10-27-retire-quota-continue-shortcut.md).

## Abstract

Claude session-limit failures can stop a conversation until its five-hour quota resets.
Offer an explicit shortcut above the composer that reserves one literal `continue`
message just after the provider's reset instant. Reuse complete scheduled messages
and preserve the current draft. This requires a matching exhausted quota with a
known future reset; a natural-language clock alone is deliberately insufficient.

## Decision

- Read only the hydrated tail through ConversationView. Match the latest
  `chat_failed` provider notice after the latest user turn, with Claude's session-limit
  prefix. The JSON-RPC adapter does not retain a distinct rate-limit reason, so a
  generic `acp_internal_error` alone cannot authorize the shortcut.
- Resolve the exact Agent config/model's quota and require an exhausted 18,000-second
  window. Its absolute reset timestamp supplies the date and time. Reject expired or
  missing resets, failures older than that window, weekly-limit messages and another
  exhausted quota that remains blocked afterwards. Refresh through the existing
  provider quota owner while visible; do not parse localized AM/PM text.
- A click reserves `continue` at reset + one second, in the same conversation, with
  the failed user turn's model/mode/options, memory, MCP selection and Role provenance.
  It does not replay the original task, attachments or prompt prefix. The composer
  draft and selected run-config edits remain untouched. Nothing is scheduled on render.
- Derive reservation, activation and creation identities from workspace, conversation
  and reset instant. Repeated clicks and uncertain durable-write retries converge on
  the same reservation. A conflicting payload is rejected rather than overwriting a
  previously edited reservation. Existing reservations open their details, including
  sent/cancelled ones; cancellation and offline catch-up follow the
  [scheduled-message contract](2026-10-27-scheduled-messages.md).
- Preserve ownership, complete-message protocol and protected-workspace gates.
  Quota/history subscriptions live in a leaf above the composer. The machine-owned
  scheduler remains the execution owner; no renderer timer sends messages. The UI
  keeps only the action button; reset information already belongs to the provider
  message and is not repeated above the composer.

## Evidence and limits

Synthetic behavioral coverage verifies one durable full-message reservation, frozen
configuration, repeated clicks, uncertain-save retry, unchanged source history,
missing/expired reset, weekly/foreign/stale quota, and ownership/capability gates.
Storybook fixtures cover the shortcut beside an editable draft. No real user transcript
is checked in. Live workspace inspection was unavailable because the Lody sync
interface timed out; historical provider-format inspection and current adapter code
support the recognition rule, not a claim that the currently blocked conversation
was reproduced. Current Storybook screenshots cover desktop, narrow-screen and
button acceptance states with no page errors or horizontal overflow. Human visual
review remains pending; packaged-client/provider execution remains unverified.
