# Desktop channel execution

Status: draft
Translation: current

[中文](desktop-channel-execution.zh.md)

## Scenario

A cloud desktop may offer separately installed Stable and Nightly applications.
Users switch by quitting one and opening the other. The public standalone desktop
remains local-only; channel identity must not enable cloud behavior in that build.

## Identity and ownership

- Separate channels MUST retain separate application identities, protocol handlers,
  desktop caches and credentials. Browser login returns to its initiating app under
  the [desktop login contract](desktop-browser-login.md).
- Supported cloud desktop versions MUST exclude one another in both launch orders,
  including control-only mode. The losing app explains how to quit the current app;
  it MUST NOT kill it, steal execution ownership, or load credential/business stores.
- All pre-ready Electron configuration and early launch-event subscriptions precede
  asynchronous ownership acquisition. Accepted early callbacks survive that gate.
- Per-app second-instance delivery remains distinct from cross-channel conflicts.
- The desktop lock and local CLI Host ownership serve different purposes. A desktop
  lock MUST remain held until owned execution confirms shutdown. Failed shutdown
  MUST block normal quit, report the failure, and allow a retry.
- A crashed desktop MUST NOT leave a persistent stale desktop lock.
- An external daemon MUST NOT silently replace a Nightly app's bundled execution
  runtime. Nightly acquires the shared execution Host before authentication or
  business initialization, even when its saved preference disables the local agent.
  An occupied Host produces an actionable startup refusal without killing it.
  Worker stop/restart MUST retain the desktop's reservation and supervisor identity;
  control-only mode stops Worker execution and probing, not Host ownership.
- Shared execution data MUST remain readable by supported Stable versions. Desktop
  cache isolation and process exclusion do not establish data-format compatibility.
- Supported older Stable versions MUST be explicit. A new lock protocol alone does
  not establish exclusion against versions which do not participate.

## Diagnostic provenance

Desktop and Web Settings → About MUST offer Download Nightly directly below Download
apps, opening the localized standalone `/download/nightly` page. The normal download
page MUST NOT embed Nightly downloads. The standalone page MUST distinguish Nightly
visually, explain shared live data and manual switching, and use immutable installer
links from a complete Nightly manifest. Missing or invalid metadata MUST NOT produce
Stable fallback links or guessed aliases. The manifest and download page MUST identify
the verified minimum Stable version; this floor requires packaged compatibility evidence,
not just a version comparison.

About, copied crash reports and submitted bug reports MUST identify the reporting
desktop's channel, version and both source revisions when injected by its distribution
composition. Build metadata MUST remain distinct from a remote machine's logs and
MUST NOT expand into ambient environment, account or filesystem collection.

## Evidence and limits

`desktop-bootstrap.ts`, `index.ts`, and `application.ts` separate pre-ready setup,
ownership gating, and application lifecycle. The startup bundle tests cover the
lazy import boundary and early callbacks; lease tests cover contention, crash
release and quit failure. These tests do not prove packaged OS dispatch or older
version compatibility. Host conflict and Supervisor stop/restart tests cover the
reservation; packaged launch validation,
supported version floor and shared-data compatibility remain rollout requirements.
