# Notification contracts

`CLAUDE.md` symlinks here. Edit `AGENTS.md` only.

- Import via `@lody/shared/notifications`. Keep ordinary pure functions/types;
  no SDKs, clocks, stores, lifecycle runtime, event bus or agent tools here.
- `turn.ts` projects trusted per-turn facts into an actionable `AttentionItem`
  or null. User/agent/unknown audience is independent of authenticated recipient;
  cancelled, delegated and unknown-provenance results stay silent. Session parent
  metadata never decides result audience. It does not infer provider success.
- Schedules use ordinary prepared user turns and this same policy. No notification
  modes, condition engine, digest, health episodes or model notification judgment.
- `index.ts` owns `TerminalOutcome` and the additive `terminalNotificationSchema`.
  CLI validates before writing the latest control projection; desktop validates on
  read. Keep stored/wire fields and optional-field compatibility during cleanup.
- `turnOutcomeKey` is the actual cloud provider logical tuple (`turn`, workspace,
  recipient, session, input turn). Preserve its bytes across copy/outcome changes;
  changing it changes provider deduplication. It is not an authorization grant.
- `presentation.ts` owns bounded display context, pure formatting and the shared
  en/zh catalog (registered with desktop i18next and used by native push).
  The title is always the conversation title (localized untitled fallback); body
  contains status, project, PR, distinct scheduled task name and an optional reply
  excerpt on a new line. `notificationReplyPreview` selects only the last nonempty
  top-level assistant text from the exact execution entry, bounded to 200 Unicode
  code points (400 UTF-16 units on the wire); never thoughts, tools or child output.
  Permission/question/attention copy ignores excerpts. Keep conversationTitle
  and scheduleName separate. Success omits status; absent body context gets an
  open-conversation hint so push content remains nonempty. Display never affects eligibility, destination or provider identity.
  Preserve associated PR numbers in copy: latest open/draft, otherwise latest
  closed/merged; canonical URL supplies the number, legacy number/reportedAt remain
  readable. PR context stays optional and uses existing metadata, never a fetch.
  Schedule names come from exact `scheduleRun.turnId`-bound input history, not
  Session schedule metadata or prompt text; copied inputs and mixed origins fall back
  to conversation copy. Only completed origins name a successful summary.
  Reply transport and privacy decision: [note](../../../../.agents/notes/implemented/feature/2026-10-23-notification-reply-preview.md).
- `AttentionItem` retains the future Inbox concept but has no separate store.
  Do not recreate unused revision reducers, generic intents/routes/delivery ports
  or speculative schedule source variants. Add contracts when real callers need them.
- Desktop and mobile are independent, best effort, no retry/replay/handoff. Runtime
  authentication/settings/source visibility and native target resolution stay in
  their existing host adapters. No notification activity heartbeat or OS arbitration.
- Behavioral coverage: `../../tests/notifications.test.ts`, CLI terminal/provenance
  and schedule preparation suites, desktop consumer and legacy observer suites.
- Broader design remains [proposed](../../../../.agents/notes/proposed/architecture/2026-10-13-agent-native-attention.md).
