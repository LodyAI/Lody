# Platform composition contracts

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

These rules also bind callers changing platform assembly, capability-gated settings,
telemetry, or managed-runtime downloads, as routed by the root instructions.

## Composition and capabilities

- Settings must represent real platform support: local hides cloud usage and
  PR-driven auto-archive, and omits machine selection when `remoteMachines` is
  absent. Gate entries and their background work through capabilities rather
  than build-kind or environment checks.
- Shared packages stay platform-neutral. The public Electron composition
  selects `local` explicitly; private Web/mobile entries and cloud composition
  roots may inject `cloud` without forking those shared packages.
- The OSS desktop entry is local-only and must not make authenticated product-cloud requests;
  public managed-runtime artifact downloads are the explicit exception.
- An absent platform selector resolves to `local`; public build scripts must
  not accept or discover staging/production deployment presets.
- Local CLI, renderer, and Electron-main telemetry is hard-disabled even when
  unrelated PostHog variables exist in the caller's shell.

## Managed runtime channel

- Managed runtime downloads default to the public R2-backed channel owned by
  `packages/platform/src/runtime-artifacts.ts`; local and cloud assembly must use that
  same constant. `LODY_RUNTIME_BASE_URL` is only an explicit mirror override.

## Host identity keys

- `./host-keys` is host-only and remains unconnected until the crypto and host
  adapters are reviewed. CLI assembly receives machine identity only; never grant
  it personal management operations. No generic private export or arbitrary signing.
- Failure, scope close, logout and ordinary cache cleanup must not delete identity
  keys. Preserve uncertain failure reasons and writes; no plaintext-file fallback.
- Native fixtures use random UUIDs and isolated test keychains only. Verify exact
  cleanup; never change user keychains or global settings. See [validation](README.md).
