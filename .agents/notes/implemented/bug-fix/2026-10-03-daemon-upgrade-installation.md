# Bind daemon upgrade handoff to the verified installation

Status: implemented
Translation: current

[中文](2026-10-03-daemon-upgrade-installation.zh.md)

## Abstract

Remote upgrade installed Lody globally but spawned its replacement watchdog from
the old watchdog's argv. A daemon launched from an npx cache could repeatedly
install successfully while continuing to run the old version. The installer now
returns an explicit, executable-version-checked entry from the installing npm's
global root, and handoff requires matching-version readiness. External autostart
definitions still require a one-time correction; code downloaded by an old
watchdog cannot retroactively change that watchdog's handoff behavior.

## Decision and scope

Resolve `npm root -g` through the same npm environment used by the global install.
Read the installed package's declared bin instead of assuming its bundle layout,
check package identity and exact requested version (or the concrete installed
version for `latest`), constrain the resolved entry to the package, and execute
that entry's `--version` before releasing the old Host lease. A PATH lookup for
`lody` was rejected because inherited npx or alternate Node-installation paths
can still select the old package.

```text
npm install -g -> npm root -g -> package/bin and executable version verification
  -> release old Host -> spawn explicit installed entry -> matching-version ready
```

Ordinary launch behavior keeps its existing argv and legacy-ready compatibility.
Upgrade handoff carries the verified entry/version across the termination boundary.
Missing or incorrect readiness versions use the existing exact-child cleanup and
ownership-aware recovery, without logging upgrade success. An older target without
versioned readiness needs an explicit local restart. Recovery does not restore
package files overwritten by npm.

This complements the [Windows npm shim fix](2026-09-08-windows-daemon-upgrade.md),
which addressed command execution, not destination selection. The new
[draft contract](../../../../specs/daemon-upgrade-installation.md) and
[CLI recovery instructions](../../../../apps/cli/README.md#daemon-upgrades-and-autostart)
describe current behavior. User-owned startup scripts are not rewritten or scanned;
Windows and WSL installations must be repaired separately.

## Verification and limits

Synthetic npm shims and real Node child processes cover install success/failure,
global roots containing spaces, old npx argv, exact-version rejection, missing or
escaping bins, executable-version mismatch, failed root lookup, cancellation,
preserved arguments, and versioned readiness. Tests invoke no registry or real
global installer. Real npm replacement and Windows/WSL device acceptance remain
unverified; successful local tests do not establish those deployment guarantees.

The four targeted suites pass (36 tests). Repository typechecking, lint, formatting,
i18n/import/platform/public-boundary checks, and `pnpm run docs check` pass.
`pnpm check` stops at the unmodified `workspace-git-service.test.ts` GitHub-remote
backfill assertion (CLI: 3490 passed, one failed, four skipped); that failure also
reproduces when the suite runs alone. The remaining full-workspace tests are not
claimed as passed.
