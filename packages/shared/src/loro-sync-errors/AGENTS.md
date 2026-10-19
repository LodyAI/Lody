# Loro sync error diagnostics

Root and shared package rules apply. `CLAUDE.md` symlinks here; edit `AGENTS.md` only.

- Consume the published Repo transport's validated Streams fields. Log explicit
  scalar projections, never entire errors, messages, stacks, causes, bodies,
  headers, provider objects, tokens, or URL queries.
- Callers bind `createLoroSyncErrorTools` to their own Repo error constructors;
  different pnpm peer contexts can have different class identities. Do not replace
  this boundary with arbitrary-object or message-based error recognition.
- CLI Streams composition registers its bound formatter with the generic error
  utility. Keep Repo runtime imports out of that utility: standalone process
  workers consume it without a WASM loader.
- Keep report transport identities and explicit `retryable: false`. Unknown
  provenance remains unknown; fetch/errno evidence does not prove device offline
  state or backend downtime.
- Formatting and diagnostics must not mutate failures, influence retry behavior,
  add transports, or enable telemetry. Routine successful sync stays silent.
- Preserve non-Streams error formatting at callers. Technical details supplement
  existing localized action labels rather than introducing a separate UI flow.
