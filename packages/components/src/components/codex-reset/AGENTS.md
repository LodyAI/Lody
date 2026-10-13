# Codex reset forecast

Parent `AGENTS.md` files also apply. `CLAUDE.md` is a symlink to this file; edit
`AGENTS.md` only. Surfaces: `components/codex-reset/` plus
`lib/codex-reset-forecast*.ts`, the settings provider row, and the session usage
popover.

- The data is a public unauthenticated GET to the third-party `codex-resets.com`.
  Never attach credentials.
- Cache it in ONE module-level store (`lib/codex-reset-forecast-store.ts`) that every
  surface shares. Never fetch per component: `SessionUsagePopover` is mounted per open
  tab AND side chat (hidden ones included) and `ProviderRow` per provider, so a
  mount-time fetch is a request storm.
- **Nothing loads on mount.** A request happens only when a user OPENS a surface that
  shows the forecast — the provider row's direct forecast button (the click that
  opens its dialog) and the composer's usage popover (its content mounts
  `CodexResetForecastUsageRow`, which loads from its own mount). `useCodexResetForecast`
  therefore has no load effect; call `revalidate()` from the interaction.
- Concurrent callers coalesce onto one in-flight request. Freshness is the served
  `Cache-Control: max-age` clamped to 1m–5m — the endpoint's CDN-shaped 4h is wrong for
  someone who just opened the panel — and a lapsed TTL revalidates with `If-None-Match`,
  so the usual outcome is a 304. `data` survives a revalidation, which is what gives
  stale-while-revalidate for free; never blank it on refresh.
- Gate every entry point on `canShowCodexResetForecast` (built-in Codex with no custom
  key/brand, matching `canShowSubscriptionRateLimits`); a disabled entry makes no
  request at all. Eligible provider rows always offer the direct forecast action,
  even without usage data or an active forecast. Its label carries no probability.
  Never put forecast probabilities beside remaining-quota percentages in the
  provider overview. The composer's usage-popover row appears
  while a watch is live or a scheduled reset awaits execution. There is deliberately NO always-visible composer band: it
  would have to load in the background to know whether to render.
- The composer's usage-popover entry must NOT own the dialog. Opening a forecast
  dialog dismisses its popover and unmounts content, so `SessionUsagePopover` hosts
  `CodexResetForecastDialogHost` as a sibling. Provider rows open that dialog
  directly, without a quota-details popover.
- The provider-row dialog is nested inside desktop settings. `@lody/ui` paints a
  nested modal's overlay itself — a lighter veil between the parent panel and the
  dialog — so no per-caller prop is needed. Mobile settings and the
  usage-popover host stay top-level and keep the default dialog overlay.
- `forecast_window` is FREE TEXT, not a timestamp ("the next 6 hours", "later today").
  Never show that untranslated phrase as the forecast time: render the absolute UTC
  `expires_at` instant semantically ("Today 2:00 PM", "明天 14:00") in the user's
  browser/OS time zone, and describe it as the time through which the forecast is valid
  rather than promising a reset.

- `scheduled_reset` is an announcement, separate from the probabilistic watch. Show it
  ahead of a watch without a probability; a null time means unspecified, and passing
  `scheduled_for` means awaiting execution confirmation, never completed or expired.
