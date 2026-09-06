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
  shows the forecast — the settings provider row's chip (the click that opens the
  dialog) and the composer's usage popover (Radix mounts its content on open, so
  `CodexResetForecastUsageRow` loads from its own mount). `useCodexResetForecast`
  therefore has no load effect; call `revalidate()` from the interaction.
- Concurrent callers coalesce onto one in-flight request. Freshness is the served
  `Cache-Control: max-age` clamped to 1m–5m — the endpoint's CDN-shaped 4h is wrong for
  someone who just opened the panel — and a lapsed TTL revalidates with `If-None-Match`,
  so the usual outcome is a 304. `data` survives a revalidation, which is what gives
  stale-while-revalidate for free; never blank it on refresh.
- Gate every entry point on `canShowCodexResetForecast` (built-in Codex with no custom
  key/brand, matching `canShowSubscriptionRateLimits`); a disabled entry makes no
  request at all. The provider row always shows the entry; the usage-popover row appears
  only while a watch is live. There is deliberately NO always-visible composer band: it
  would have to load in the background to know whether to render.
- The usage-popover row must NOT own the dialog. Opening a Radix Dialog from inside a
  Popover dismisses the popover and unmounts a dialog rendered in its content, so
  `SessionUsagePopover` renders `CodexResetForecastDialogHost` as a sibling of the
  popover instead.
- The provider-row dialog is nested inside desktop settings: pass `nestedInDialog` there
  so its overlay uses `--z-dialog` plus `bg-black/20`. Mobile settings and the
  usage-popover host stay top-level and keep the default dialog overlay.
- `forecast_window` is FREE TEXT, not a timestamp ("the next 6 hours", "later today").
  Never show that untranslated phrase as the forecast time: render the absolute UTC
  `expires_at` instant semantically ("Today 2:00 PM", "明天 14:00") in the user's
  browser/OS time zone, and describe it as the time through which the forecast is valid
  rather than promising a reset.
