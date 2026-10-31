# E2EE M1: retained state and host runtimes

Status: implemented
Translation: current

[中文](2026-10-21-e2ee-m1-runtime-boundaries.zh.md)

## Abstract

Based on public `698df2f281a40f9d63b086a8e48f5404a885f5da`. M1 connects the desktop
ledger runtime. Content, pairing and ordinary-user entry points remain gated.
Ordinary workspaces neither open custody nor acquire a new network prerequisite.

## Implemented boundaries

- Core and Lab use the catalog Streams version. Validate standalone and embedded compositions.
- Shared WorkspaceStreamsContent is mandatory. Existing ordinary callers select plaintext;
  unsupported CLI/helper/prefetch/Shortcut/import paths reject before transport side effects.
  Workers carry only a cloneable mode marker; personal Shortcuts retain their own resource domain.
- A retained LedgerFeed origin includes the complete local v2 export and its offset.
  Verification provenance is preserved. VerifiedLedger alone advances pins; rebase pins first,
  then SQLite CAS-replaces the origin and deletes covered rows. A newer pin needs a proven suffix;
  a cache newer than its pin is rebuildable. Genuine conflicts never reset pins.
- Lazy desktop account owners reuse creation custody. Each workspace owns feed, pin and installed-key
  stores. recordCreated checks the original local creation and binds workspace to genesis immutably.
  Existing workspaces only openDevice. Epoch0 is inserted once and commitment-checked; originals stay.
- The ledger page displays local state first, then fetches a suffix for main-process verification.
  Web/mobile keep their existing reader. IPC admits product windows and explicit leased-workspace
  operations only; it returns public projections, never secrets or arbitrary signing.
- Core-authenticated originals enter history.sqlite before feed commit and pin advancement.
  Verification or storage failures close that owner; reopen reconciles originals. Cache recovery proves the pin and removes only the replaced disposable feed after successful rebuild. A crash between rebase and saving its envelope can also rebuild safely.
- Window leases keep other readers alive. Account handoff, logout and quit stop admission,
  await actual native operations, then release workspace stores and custody.
- Node custody preserves existing blob formats, AAD, original publication and rewrap semantics.
  Electron retains its backend qualification. CLI probes a real keyring write/read on first creation,
  automatically choosing file protection if unavailable, then never changes the selection.
  File protection admits machines only, with POSIX owner/0600/0700 and Windows DACL checks.
  Missing selectors or KEKs with existing originals refuse replacement identities/keys.

## Owner decision and limits

On 2026-10-21 the owner approved automatic first-creation file protection for machines.
Personal devices still require OS protection. Future pairing approval must disclose protection;
M1 does not connect pairing or touch keyrings during ordinary CLI startup. This explicit approval
supersedes the older D10 summary; the owner handles protocol wording in PR-06a.

Retained state is only the caller's own export. Originals plus an independent pin justify recovery;
conflicting evidence never triggers automatic resets. InstalledEpochKeys.check disposes temporary
key material inside core instead of handing it to a status reader. Synthetic tests do not prove
real OS keyrings, Windows ACLs or packaged Electron native ABI behavior.

First takeover also retains the renderer's previously verified checkpoint. Until original
history proves it, continuity remains pending and no key readiness or authority is exposed.
The restriction is pinned durably and survives restart.

The real-bundler startup tests locate the application by module ownership rather than a single facade shape. They still require dynamic-only import after startup ownership; shared dynamic entries may expose an application namespace. Production startup configuration is unchanged.

## Review corrections

Same-document navigation keeps its lease. Quit cleanup attempts E2EE and other independent resources together; sign-out proceeds after a failed E2EE close. A failed account Scope stays fenced even though subsequent Scope.close is idempotently successful; cancelled quit resumes admission only for healthy owners.

Terminal quit gives each renderer close and the parallel main-owned resource drain
fifteen seconds. A pending native call retains its Scope, custody and original
write receipts; a timeout never clears them or authorizes replacement. Once CLI
and shell execution owners confirm release, unconfirmed main work is logged and
main gives a presence-only warning marker at most one second to persist, then
terminates with exit code 1. No UI runs on this exit path, including updates and
OS shutdown/logout. Next launch attempts a nonmodal native notification; unavailable
or failed delivery retains the marker. Startup claims the marker by rename before
notification delivery, so delayed delivery cannot erase a subsequent quit's marker.
A parentless `showMessageBox` was rejected: Electron 44.9.3 on macOS runs that
branch through `NSAlert.runModal`, which blocks the JS deadline despite returning
a Promise. No modal API or human acknowledgement owns terminal reporting. Process
termination ends late native work; ordinary Electron quit is reserved for confirmed
drain. This avoids an endless wait without pretending cancellation released a writer.
The native custody test creates a link offer, stalls an actual unprotect, crosses
the quit barrier with a fake clock, then joins the retained close and verifies
identical committed ledger originals and keys after reopen. It proves neither the
historical E2E hang's exact resource nor a real OS keychain or packaged close.
Quit phase/resource diagnostics supply that missing distinction on a later run.
Fake-clock terminal tests also cover stalled/failed marker I/O, while real filesystem
tests cover notification failure and a new quit during delayed startup delivery.
Generic account/runtime failures retain one private main-only cause in the existing
diagnostic slot; public errors and logs still omit it.
The bounded terminal drain and its evidence are in [PR #2162](https://github.com/LodyAI/Lody/pull/2162).

Retained origins compact after 64 added records across reopen. Successful, verified rebuilding closes the replaced feed scope and removes only its SQLite file/sidecars; originals, pins and conflicting evidence are preserved. IPC publishes the full ledger at initial local display and at the final page or an upgrade stop, rather than each page.

Machine keyring operations run in a process-owned helper with a 10-second timeout and credentials on stdin. Timeout fallback requires confirmed process termination; mixed failure/release causes retain the recovery owner and prohibit fallback. Existing OS custody never downgrades. Windows validates the directory in one ACL process; initialization lock contention yields and retries for at most 60 seconds instead of blocking the JS owner.


Account IPC reads main-auth's already resolved identity synchronously, with an identity/generation
recheck after native open. No auth network holds the account lock. A cold start with no resolved
main identity does not trust renderer accountId: the ledger uses its existing read-only verifier.
Only unavailable custody/account, closed host, or missing binding permit this fallback, including
when supplementing a binding from a renderer pin. Genesis/observed checks remain mandatory;
conflicts, corrupt stores and verification failures still block. Diagnostics expose stable codes only.

Two readers may ingest identical or partially overlapping pages. Compare at most 64 original
records within the verified prefix, accept only the new suffix, and never rewind the offset/pin.
An old endpoint must match its locally verified head. Gaps/malformed caller input leave the shared
owner open; contradictory bytes and verification/storage failures close it and retain evidence.
Behavior tests cover fallback with and without pins, conflicting pins, offline cached identity,
account changes during open, definitive sign-out, duplicate/partial/empty old pages and gaps.
Real OS keychains, interrupted Windows ACL initialization and packaged Electron remain unverified;
CLI custody has no daemon consumer yet, and interrupted ACL initialization is a PR-10 prerequisite.
