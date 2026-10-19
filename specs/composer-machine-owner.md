# Composer execution-machine details

Status: draft
Translation: current

[中文](composer-machine-owner.zh.md)

A team member needs to recognize which machine will execute a message before
sending it. On desktop, keep a monitor icon and execution-machine name above the
composer; on mobile, keep a compact monitor button in the same single-row info bar.
Tap opens the full machine details; desktop also supports hover and keyboard
activation. Owner names and avatars do not occupy the resting composer row.
This revised proposal follows the withdrawal of the earlier persistent-owner
display; visual approval remains pending.

Resolve ownership from the selected machine's `ownerUserId`, never the Session
creator or transferable Session owner. The current user's machine reads “You”
in the card; unavailable ownership reads “Unknown owner”. Offline presence keeps
the machine control available and adds a warning tint. Unresolved presence is
neutral and reads “Status unavailable” in the card. Unloaded or removed machine
metadata must clear the control instead of retaining the previous machine.

The machine control stays outside the canonical cluster/stage cycle. Truncate
long machine names at narrow widths and show the full name in the card. A row
containing only the machine control uses a transparent background. Existing
repository/status controls and the machine entry in the Session menu remain
available. This is display-only: no machine switching, new backend or ownership
changes. Mobile controls stay in the 32px info bar without an extra identity row.
On narrow mobile bars, private-access status may use its lock icon while retaining
the full accessible description and the permitted sharing action.

Implementation and validation evidence are recorded in the
[proposal](../.agents/notes/proposed/feature/2026-10-11-composer-machine-info-card.md).
The [withdrawal](../.agents/notes/implemented/simplification/2026-10-11-revert-composer-machine-owner.md)
records the earlier decision. Live team-session verification remains pending.
