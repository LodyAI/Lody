# Machine identity and local recovery

How the CLI resolves, persists, backs up, and restores its local machine identity across
data-directory wipes, machine migrations, and offline recovery.
[`apps/cli/src/lib/AGENTS.md`](../../apps/cli/src/lib/AGENTS.md) requires this page to be
read before `machine-identity.ts`, `credentials-file.ts`, or `machine-identity-restore.ts`
is changed, because the invariants below bind those modules and their callers.

## Ownership and precedence

- `credentials-file.ts` is the sole owner of the V3 `credentials.json` schema and atomic
  read/write helpers (`MachineIdSchema`, `CredentialsV3Schema`, `readCredentialsFile`,
  `readCredentialsFileStrict`, `writeCredentialsFile`). Extra fields are preserved via
  `.passthrough()`.
- `machine-identity.ts` owns `machine-id` and the host-bound backup anchor
  (`$XDG_STATE_HOME/<namespace>/machine-identity.json` on POSIX, or
  `%LOCALAPPDATA%/<namespace>/machine-identity.json` on Windows).
- Resolution precedence is strictly ordered:
  1. Valid V3 `credentials.json` (`machine.machineId`)
  2. Persisted `machine-id` file (empty/whitespace files are treated as corrupt and repaired)
  3. Host-fingerprint-verified backup anchor
  4. Deterministic HMAC-SHA256 UUIDv5 (`namespace` + OS user + raw hardware ID)
  5. Random `crypto.randomUUID()` fallback

## Host anchor isolation and migration safety

- Host anchor reads/writes and hardware-backed deterministic derivation apply ONLY to the
  default installation data directory (`LODY_DATA_DIR` unset and resolved directory equals
  `getLodyDataDir()`). Custom `LODY_DATA_DIR` invocations never read or modify the user's
  host anchor.
- The anchor stores `sha256(platform + rawHardwareId)` as `hostFingerprintHash`, never the
  raw hardware ID. When an anchor's fingerprint does not match the current host (for example,
  a copied home directory or Migration Assistant restore), the anchor is rejected so cloned
  hosts never share a machine identity.
- Linux container environments (`/.dockerenv`, `/run/.containerenv`) skip `/etc/machine-id`
  to avoid ephemeral or shared container IDs.

## Failure containment and startup ordering

- Warm-path anchor sync skips OS hardware probes once `machine-id` exists and the anchor
  already records the same `machineId` (unless `forceRefreshAnchor` is explicitly requested).
- Hardware probe failures distinguish `unavailable` (permanent, safe to cache per process)
  from `transient_error` (timeout/I/O error, never cached so later calls can recover).
- Anchor I/O degrades silently and never blocks identity resolution or login.
- Telemetry (`instrument.ts`, `analytics/posthog.ts`) must call read-only
  `readExistingMachineId()`, never `getSystemMachineId()`, so process startup never creates
  `machine-id` or the anchor before `applyPendingMachineIdentityRestore` or
  `lody machine restore-id` runs.

## Auth and restore boundaries

- `auth.ts` (`saveAuthInfo`, `logout`, `clearRejectedToken`) persists `machine-id` before
  removing `credentials.json` so signing out preserves machine identity.
- Offline `restoreLocalMachineId` (`lody machine restore-id`) refuses while any local CLI
  host lease is active on the default data dir, refuses invalid or corrupt `credentials.json`
  without mutating disk, backs up prior files under `identity-restore-backups/manual-*`
  (`0700`/`0600`), updates `credentials.json` and `machine-id` atomically, and
  force-refreshes the host anchor.
- Online `applyPendingMachineIdentityRestore` commits only before daemon runtime startup and
  retains the pending intent and backup until both identity files and the anchor are published.
