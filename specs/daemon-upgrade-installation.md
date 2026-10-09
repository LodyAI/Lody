# Daemon upgrade installation and handoff

Status: draft
Translation: current

[中文](daemon-upgrade-installation.zh.md)

## Scenario and responsibility

A daemon started from an npx cache can install a newer global CLI while still
restarting from its old cache entry. Remote upgrade must move both the watchdog
and its Worker to the installation produced by that upgrade.

The lifecycle installer runs the existing global npm install, then resolves the
global package using the same npm environment. It validates the package identity,
declared entry within the package, installed version, and executable version.
An exact requested version must match; `latest` uses the installed package's
concrete version. Neither the old argv nor a PATH lookup for `lody` identifies
the upgrade destination.

After the old Worker stops and the Host lease is released, the watchdog hands off
to that explicit entry, preserving daemon arguments and the existing environment
scrubbing. Upgrade completion requires the replacement's Worker to reach ready
and the replacement watchdog to report the verified version. An absent or different
version is a failed handoff, and the exact spawned replacement is drained before
recovery. Ordinary non-upgrade launches continue accepting legacy ready reports.

Installation, verification, and readiness are separate outcomes. Failed verification
or handoff must not be logged as successful upgrade. Existing ownership and restart
recovery rules remain in force; recovery does not roll back package files changed
by npm. Lifecycle ACK delivery is governed by the [ACK contract](machine-lifecycle-ack.md).

## Existing deployments

User-owned autostart scripts and service definitions are outside the installer.
They must target a stable global launcher under the intended Node/npm installation,
not a cached or version-specific entry. Windows and WSL require separate correction.
An old watchdog already running the defective handoff code needs a one-time restart
from the corrected launcher. A target without versioned readiness cannot complete
the verified remote handoff; starting such an older release requires an explicit
local restart.

## Evidence and limits

- [Installer](../apps/cli/src/lib/machine-lifecycle.ts),
  [handoff](../apps/cli/src/commands/daemon-runner.ts), and
  [readiness boundary](../apps/cli/src/commands/daemon-shared.ts).
- [Synthetic install/handoff tests](../apps/cli/src/lib/machine-lifecycle-upgrade.test.ts).
- [Autostart recovery](../apps/cli/README.md#daemon-upgrades-and-autostart).
- Real registry installation and Windows/WSL device acceptance remain unverified.
