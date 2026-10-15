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
- `AttentionItem` retains the future Inbox concept but has no separate store.
  Do not recreate unused revision reducers, generic intents/routes/delivery ports
  or speculative schedule source variants. Add contracts when real callers need them.
- Desktop and mobile are independent, best effort, no retry/replay/handoff. Runtime
  authentication/settings/source visibility and native target resolution stay in
  their existing host adapters. No notification activity heartbeat or OS arbitration.
- Behavioral coverage: `../../tests/notifications.test.ts`, CLI terminal/provenance
  and schedule preparation suites, desktop consumer and legacy observer suites.
- Broader design remains [proposed](../../../../.agents/notes/proposed/architecture/2026-10-13-agent-native-attention.md).
