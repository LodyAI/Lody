# Loro sync error diagnostics

Root and shared package rules apply. `CLAUDE.md` symlinks here; edit `AGENTS.md` only.

- Consume the published Repo transport's validated Streams fields. Log explicit
  scalar projections, never entire errors, messages, stacks, causes, bodies,
  headers, provider objects, tokens, or URL queries.
- Callers bind `createLoroSyncErrorTools` to their own Repo error constructors;
  different pnpm peer contexts can have different class identities. Do not replace
  this boundary with arbitrary-object or message-based error recognition.
- Native workspace formatters bind `workspaceSyncFailuresLegacy`; project only
  validated native Streams scalars, never its private full Cause.
- CLI/renderer snapshot observers use `getLoroSnapshotDiagnostic` at the SDK DTO
  boundary. Retain workflow/request ids, stages, byte lengths, monotonic elapsed
  time and abort/timeout/upload classifications. Never infer transmission progress
  for `total-only` uploads or substitute a timeout budget for elapsed time.
- Snapshot workflow records use debug and failures use warn; ordinary room sync
  stays silent. Preserve configured protected-content observers, including async
  rejection isolation, without allowing a log sink failure to affect upload.
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
