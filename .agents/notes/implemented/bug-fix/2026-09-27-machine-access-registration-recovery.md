# Recover machine access registration after a backend failure

Status: implemented
Translation: current

[中文](2026-09-27-machine-access-registration-recovery.zh.md)

## Abstract

A failed hosted machine access registration left a running daemon without another registration attempt. Session creation and remote project listing could then report that its known machine was missing because they filtered denied machines before selecting the target. The daemon now retries registration with bounded exponential delays, and both commands report the actual access denial for a selected machine. This does not repair the hosted 5xx response itself or grant access when verification denies it.

## Problem and decision

`MessageHandler.activateRemoteServices` made one registration attempt and logged a rejection. A transient failure therefore persisted until restart or another unrelated registration path. Retry starts at one second, doubles to a five-minute cap, stops after success, and is cancelled during cleanup. The existing in-flight promise and successful-registration cache still prevent duplicate requests.

The create and project-list commands first selected from allowed machines. If the daemon's machine metadata existed but its registration was denied, the commands reported a missing machine or an empty authorized list. They now recognize a denied exact machine ID, then require its access verdict before reading projects or dispatching a Session. Unknown selectors report `Machine not found` with only authorized candidates when some exist, or `No authorized machines are available in this workspace` when none do. A known denied ID reports the denial reason and points to daemon logs only for `machine_not_registered`.

## Scope and verification

The issue reports repeated hosted 5xx responses across daemon starts. That service failure cannot be reproduced or fixed in this public CLI repository. The change addresses retry and local diagnostics while preserving fail-closed access checks. Focused tests cover registration failure followed by recovery, create target classification, and remote project-list denial; command checks are recorded in the PR or contribution handoff.
