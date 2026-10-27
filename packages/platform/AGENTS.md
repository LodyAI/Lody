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

## Streams token capability

- Only official cloud composition constructs Streams token ports. Native
  `createTokenProvider` requires the consumer's Scope; dispose those providers
  before disposing the cloud port. Promise consumers retain visible
  `createTokenProviderLegacy` / `LoroStreamsTokenProviderLegacy` names and await
  close. A failed token release retains its owner/Cause and blocks handoff until
  explicit recovery. Contract: [token ownership](../shared/src/loro-streams-token/AGENTS.md).

## Managed runtime channel

- Managed runtime downloads default to the public R2-backed channel owned by
  `packages/platform/src/runtime-artifacts.ts`; local and cloud assembly must use that
  same constant. `LODY_RUNTIME_BASE_URL` is only an explicit mirror override.

## Host identity keys

- `./host-keys` is host-only and remains unconnected until the crypto and host
  adapters are reviewed. CLI assembly receives machine identity only; never grant
  it personal management operations. No generic private export or arbitrary signing.
- Failure, scope close, logout and ordinary cache cleanup must not delete identity
  keys. Preserve uncertain failure reasons and writes. Personal devices never use file protection; machine-only custody may select file protection at first creation under the owner-approved M1 policy, never on reopen.
- Native fixtures use random UUIDs and isolated test keychains only. Verify exact
  cleanup; never change user keychains or global settings. See [validation](README.md).

## E2EE workspace control

- `e2eeWorkspaces` is an optional cloud control port; `prepareCreation` exists only
  with persistent host custody. It is separate from the unconnected `./host-keys`
  experiment. The developer preference gates new creation, not existing reads.
- Keep request identity and original genesis across unknown results. Never expose
  private keys, silently replace interrupted preparation, or infer plaintext from
  missing mode fields. A retained encrypted identity rejects mode downgrade.
- E2EE stays invisible to ordinary users. A workspace without local encrypted
  evidence or an encrypted listing opens via the pre-E2EE path while `describe`
  runs in the background; an encrypted or contradicting answer retires that runtime
  and fails closed. Evidence, pins and encrypted listings still require admission
  before any data plane.
- Control-only encrypted workspaces must not acquire ordinary content/execution
  transports. Before changing creation, mode admission, cache cleanup or ledger UI,
  read the [bootstrap guide](../../.agents/docs/e2ee-workspace-bootstrap.md).

- Optional `memberProfiles` is a display directory scoped to the live account and
  workspace. Resolve its crypto user IDs through verified ledger members; it cannot
  grant permissions, pin keys, identify the creator, or block ledger availability.
