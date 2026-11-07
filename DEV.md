# Development conventions

## Platform boundary

The OSS desktop composition is local by construction. Platform selection is
performed once at the process/app entry and is immutable for that lifetime.

- Shared UI calls optional online features through `PlatformProvider` and
  capability-owned operation descriptors.
- The CLI receives one `CloudPort`; local mode uses `createLocalCloudPort` and
  does not construct cloud clients or background services.
- An absent platform selector means `local`. Public commands do not load
  deployment-specific dotenv files, and hosted adapters must inject every
  gateway or artifact URL explicitly.
- Local mode never initializes telemetry, regardless of generic PostHog
  variables inherited from the developer shell.
- A missing capability is represented explicitly and an attempted call fails
  at the public boundary. Do not add silent fallbacks.
- `@lody/cloud-api` contains only public client protocol names and DTOs. Never
  import generated server declarations or implementation modules into it.

The public boundary is executable: `pnpm check:public-boundary` rejects private
workspace dependencies and internal-only repository paths. Platform adapters
must remain explicit at composition roots; shared packages consume only public
capabilities, ports, operation descriptors, and DTOs.

## State and side effects

Jotai atom read paths must remain synchronous and side-effect free. Network,
storage, subscriptions, timers, and runtime lifecycle belong in React effects
or an explicitly disposable runtime/provider.

Write-only atom naming communicates behavior:

- `cmdXxxAtom` may invoke an external side effect and may fail.
- `setXxxAtom` performs only synchronous in-memory state writes.
- ordinary `xxxAtom` values are state or pure derivations.

Long-lived resources such as Loro repositories, transports, room watches, and
control connections must have structured cleanup owned by their provider.

## Error handling

- Treat `null`, unavailable capabilities, and bootstrap states as first-class
  types; do not hide them with `@ts-ignore`.
- Fail early on corrupt local identity/catalog state. Only a genuinely missing
  first-run catalog may enter the creation/wait path.
- Do not replace protocol or configuration errors with guessed defaults.
- Missing managed-runtime or Streams endpoints are configuration errors and
  must fail before any network request.

## Quality

- Tests must be deterministic: no real sleeps, network access, or
  scheduler-dependent assertions.
- Never commit real user/agent transcripts as fixtures. Use synthetic data that
  contains no private paths, tokens, repository content, or personal data.
- Run `pnpm format` before committing. The normal full validation command is
  `pnpm check`; use narrower type/build/static checks while iterating.

## Documentation

Public contributor constraints belong in the nearest scoped `AGENTS.md` or a
self-contained source comment. Internal context, plans, specifications, task
records, and closed-service implementation details stay in the private
repository.
