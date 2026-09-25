# Independent desktop channel identity

Status: proposed
Translation: current

[中文](2026-09-23-desktop-channel-identity.zh.md)

## Abstract

Separately installed desktop channels must route browser callbacks and credential
storage to the initiating application. Desktop identity is now resolved separately
from the shared local execution installation profile, and an early bootstrap sets
the data directory before credential modules evaluate. Login attempts keep the existing authentication client and carry a validated
channel selector for the callback. Browser handoff and the pinned authentication
endpoint are covered by tests. An early OS lease now gates application loading;
packaged cross-channel launches and OS callback dispatch remain unverified.

## Decision and boundaries

The public main notification workflow carries only the accepted source SHA to a
configured distribution workflow. It performs no checkout or product build and
holds neither installer signing nor storage keys. The notification App is scoped
to a single destination repository with Actions write; this is broader than a
single-workflow permission and must be treated as trusted release automation.
Enabling the notification remains an operator step after destination readiness.

`desktop-channel.ts` overlays desktop identity without changing the CLI namespace,
data root or Host endpoint. `desktop-bootstrap.ts` is the first entry import because
auth and onboarding stores open during module evaluation. Stable retains its existing
default data path, protocol and Windows fallback IPC namespace. Nightly has separate
desktop storage, scheme and fallback IPC. A second application sharing the same
scheme would require forwarding and support from older installations; distinct
schemes avoid that dependency.

The [login coordinator decision](../../implemented/architecture/2026-09-17-desktop-login-coordinator.md)
continues to own PKCE and state. Channel identity only chooses the callback;
it must not weaken attempt validation. The public local-only build rejects cloud
channel injection. No deployment endpoints or credentials are introduced.

Better Auth 1.5.5 accepts a single Electron client per plugin. Both channels
therefore keep `client_id=electron`; the allowlisted `desktop_channel` query
survives browser callbacks and selects the fixed app scheme. No second plugin or
server token format is required. Hosted native-origin admission must include the
Nightly scheme before rollout. Tests explicitly enable origin/CSRF enforcement
because Better Auth skips origin checks by default under its test environment.

## Startup ownership

The entry now registers URL/secondary-instance listeners synchronously, takes the
normal per-app Electron lock, then acquires a common cloud-desktop loopback lease
before dynamically loading `application.ts`. Pre-ready configuration stays in
`desktop-bootstrap`; bounded launch buffering bridges the asynchronous gate.
The desktop lease is independent of CLI Host ownership and stays held in
control-only mode. Normal quit does not close it early; the OS reclaims it at
process exit. A failed CLI stop blocks quit and can be retried, instead of treating
a rejected shutdown barrier as a successful exit.

A standalone TCP lease avoids filesystem stale-lock recovery and adds no native
binding; its trade-off is reserving a machine-wide loopback port (17790), matching
the existing POSIX cloud Host's machine-wide exclusion. Another listener fails
closed with a useful conflict message. This is not retroactive compatibility:
older desktop builds do not acquire the lease. Their rollout/support floor remains a release gate. Unpackaged isolated E2E retains
its existing bypass; packaged builds cannot bypass with that environment flag.
Nightly also reserves the existing execution Host before application imports.
Inspect-then-start would leave a daemon race, so the actual Host lease is retained
for the app lifetime. A small borrowing adapter gives its Supervisor the same
instance ID and a no-op release; it cannot release the app's reservation during
Worker restart, auth restart, or control-only mode. Nightly's runtime policy is
always `reject`, including isolated E2E where early reservation is bypassed.
Existing daemon/foreground/desktop Hosts are refused without stopping them;
malformed Host metadata still fails closed through the kernel bind.
Stable/local retain their prior runtime attach policy. This deliberately prevents
starting an external daemon alongside a control-only Nightly window; it does not
start Worker probes while that setting is off.

The intended contract is [desktop channel execution](../../../../specs/desktop-channel-execution.md).

## Verification

Desktop and Web Settings → About expose Download Nightly below Download apps, linking
to the localized standalone `/download/nightly` page. The regular download page no longer
embeds Nightly. The new page reuses the download layout and the single marketing shader
host, recoloring only its atmosphere layer to muted slate-lavender; it preserves both light/dark
modes, the fallback gradient and shader sampling. The page explains live data, manual
switching and the verified minimum Stable version. The parser requires all six immutable
installers and constructs links inside the configured HTTPS root. Missing or invalid
metadata shows an unavailable state with retry. The application itself does not fetch
metadata, so its CSP and the download bucket's site-only CORS remain unchanged.
Actual published downloads and packaged compatibility remain release gates.

About accepts optional build-time desktop channel and source provenance. A
distribution composition injects the frozen candidate time and source revisions;
the UI shows both revisions when available, with full hashes in their tooltips.
Compositions without these optional constants retain the existing single-commit
display. About, crash reports and submitted bug descriptions share the same
build-constant collector. Bug descriptions append a labeled reporting-client
section, distinct from remote machine logs, without collecting ambient paths,
environment or account data. The form discloses the included build information.
Distribution builds may also inject a serialized immutable profile into the main
process startup log and the bundled CLI's file/hybrid logger initialization.
The CLI's protocol/package version stays separate; inherited runtime environment
cannot change this provenance. Distribution packaging must verify the staged CLI
manifest against the desktop candidate. A real bundle test executes the emitted
CLI provenance module and compares it with the generated manifest. Packaged log
inspection remains required.

Behavioral coverage is in `desktop-channel.test.mjs` and the existing
`auth-callback-transaction.test.mjs`. Type checks and real packaged login remain
required. `desktop-exclusion.test.mjs` covers competing owners, crash recovery,
startup buffering and failed-quit retry. `desktop-startup.test.mjs` builds the real
main bundle and verifies that conflict never loads business/credential modules,
while success replays the early callback. Real Host endpoints cover existing
owners, invalid records, and startup after the old owner stops. A real bundled
Supervisor verifies that stop/restart does not release the borrowed Host. It substitutes Electron UI and application
execution, so it does not prove packaged installation or OS callback routing.
Deployed backend origin admission also remains a release gate.

## Channel icon

Nightly uses a muted brass/copper jellyfish with a subdued crescent on a dark tile.
`apps/electron/resources/icon-nightly.png` is the 1024px transparent PNG master.
The distribution composition selects it for platform installers and aliases the
main-process window/tray and development Dock assets to the same master. Builder
converts it to native icon formats; Stable/local retain their existing assets.
The icon was edited using the built-in image generation tool, then resized with
`sips`. The color revision lowers saturation and brightness while preserving the
silhouette and layout. The padding revision brings the tile to approximately 10%
transparent inset per side and reduces the jellyfish to match the Stable macOS icon.
Native conversion does not establish installed-shell or
small-size tray legibility; those remain packaged visual acceptance checks.
