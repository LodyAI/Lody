# Automation continuation queue activation

Status: proposed
Translation: current

[中文](2026-11-02-automation-idle-queue.zh.md)

## Abstract

A matched Automation continuation could remain queued after its Session became idle: the host wrote the queue row without publishing the metadata signal used to activate an idle dispatch watcher. The Session action now publishes the queue document frontier and watermark after writing the row. Reconciliation republishes that signal for an existing row after an interrupted handoff, retaining the original input identity rather than enqueueing again. An observed user incident is consistent with this gap, but its specific queued receipt was not inspected.

## Ownership and recovery

The Session dispatch watcher releases subscriptions for idle Sessions and activates them from metadata; it cannot observe a queue-only write to an unsubscribed room. The Automation Session adapter owns submission and therefore publishes the same causal queue signal as the renderer. The frontier is captured after the row is written, so the watcher can retain the signal if metadata arrives before the control update. The [queue signal ordering decision](../../implemented/bug-fix/2026-10-27-queue-signal-before-content.md) retains its independent rationale.

The stable receipt and turn identities remain unchanged. If writing or flushing the signal fails after queue admission, the ledger's existing reconciliation finds that same queue row and signals it again. A repeated submission also checks for the existing operation before writing. A queued receipt may be re-signalled on later reconciliation; this adds metadata writes while the row remains pending but avoids depending on an unconfirmed earlier publication. Existing Session Stop, admission, permissions and cancellation owners continue to apply.

The adapter remains the registered Promise bridge to unfinished Repo and Session owners; migrating those owners is outside this fix. No new lifecycle, retry loop or cross-session scan is introduced.

## Verification and limits

Synthetic Session authority tests exercise matched input, idle activation, and recovery from failed signal persistence without duplicating the queued row. A real dispatch watcher test starts with an unwatched idle session, submits through the Automation adapter, and observes exactly one dispatch and an empty queue; authorization and admission are injected. These tests do not establish the exact cause of the original user's incident, whose receipt could not be inspected when workspace synchronization failed. The installed desktop has not been rebuilt or tested with this change.
