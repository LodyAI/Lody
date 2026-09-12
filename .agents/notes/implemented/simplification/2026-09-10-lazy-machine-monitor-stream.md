# Join the machine-monitor stream only while it has observers

Status: implemented
Translation: pending

## Abstract

Each cloud workspace renderer previously joined the machine-monitor Ephemeral Stream at runtime startup, although no UI might be displaying a machine resource snapshot. The renderer now retains the authenticated connection inputs but joins only after the first machine-monitor subscriber appears, then closes the room after the final subscriber leaves. Presence remains a workspace-lifetime subscription because it supports independent online and session-viewing state. Rapid observer changes may briefly overlap teardown and a new join, but generation-gated transport cleanup prevents an old subscription from surviving.

## Decision and ownership

`WorkspaceMachineMonitorTransport` owns the observer-count lifecycle because it alone owns both the snapshot listeners and the Ephemeral Stream subscription. `createWorkspaceRuntime` continues to supply current connection inputs on cloud attach and to stop the transport on detach, token loss, and runtime disposal.

An observer immediately receives its local empty snapshot, then starts the remote room and publishes its observer lease. The last observer clears its lease and tears down the remote room. The CLI continues sampling only for active observer leases.

## Evidence and validation

- `packages/components/src/providers/workspace-machine-monitor-transport.ts`
- `packages/components/tests/workspace-machine-monitor-transport.test.ts`

The regression test proves that workspace attachment alone creates no machine-monitor transport, the first observer creates one, the final observer closes it, and a later observer creates a fresh transport.
