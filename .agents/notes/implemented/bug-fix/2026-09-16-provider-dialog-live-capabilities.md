# Keep provider dialog capabilities live

Status: implemented
Translation: current

[中文](2026-09-16-provider-dialog-live-capabilities.zh.md)

## Abstract

Testing an ACP provider refreshed its stored capabilities but left the open settings
dialog reading the Machine snapshot captured when it opened. Title-generation options
only appeared after reopening, and an idle dialog incorrectly claimed to be probing.
Settings now retains the target machine ID and resolves its current visible row on
every render. The title section asks users to click Test while idle and shows probing
text only during an actual request.

## Decision and evidence

`refreshCapabilities` already resynchronizes Machine Flock rows; adding a second
capability cache inside the dialog would duplicate that authority. Instead,
`MachineAgentSettings` passes the live row for the machine that opened the dialog,
independent of the selected accordion row. If that machine is no longer visible,
the dialog cannot render or submit using its old snapshot. Dialog mode stays stable
across metadata updates, preserving the form draft.

This fixes UI consumption, without changing the
[cache compatibility contract](../../../../specs/acp-capability-cache-compatibility.md)
or [ACP title ownership](../architecture/2026-09-08-acp-owned-session-titles.md).
The existing dialog suite covers idle and pending text, failure recovery, and title
options arriving through a Machine prop update followed by saving without reopening.
These component checks do not exercise a real ACP process or desktop session.
