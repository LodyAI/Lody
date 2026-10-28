# Retire the Claude quota-continue shortcut

Date: 2026-10-27
Status: implemented
Translation: current

[中文](2026-10-27-retire-quota-continue-shortcut.zh.md)

## Abstract

The composer shortcut from #1935 let a person reserve a literal `continue` at the
Claude five-hour quota reset. Session automation now has a `recoverCapacity` policy
that resumes the same Session after a structured quota failure. Both paths target
the same reset and can create two continuations. Remove the composer shortcut and
its scheduling helper; existing durable reservations stay ordinary scheduled
messages and remain viewable and cancellable. `recoverCapacity` is the only owner
of automatic quota continuation.

## Decision

- Remove `QuotaContinueAction` from the composer and delete its scheduling helper,
  its test and its Storybook stories.
- Keep the scheduled-message feature and every stored reservation. No schedule is
  deleted or migrated.
- `recoverCapacity` owns automatic quota continuation. It is per-Session, default
  off, and remains capability-gated by the Host.
- [The old Claude shortcut note](../../proposed/feature/2026-10-27-quota-continue.md)
  stays as history; this note supersedes its UI entry point. The backend policy
  remains owned by
  [the continuation coordinator note](../../proposed/architecture/2026-10-25-session-automation-coordinator.md).

## Evidence and limits

- The old mount was `session-chat-input-area.tsx`; the helper created a `continue`
  draft at reset + 1 second for an existing Session.
- The new policy reacts to `provider.quota.exhausted`, retains pending work and
  resumes the same Session. Claude and Codex subscription accounts are verified;
  other Providers remain capability-gated.
- The new UI is not wired to the renderer yet. Until it is, the composer offers no
  quota continuation. That is an intentional gap, not a silent fallback.
- Existing scheduled continuations still run under the scheduled-message owner;
  they are not converted into automations.
