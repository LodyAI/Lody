# List remote projects without a client daemon

Status: implemented
Translation: current

[中文](2026-09-10-daemon-free-remote-project-list.zh.md)

## Abstract

`lody project list` previously required the current machine's daemon even when a user only needed
the synchronized project catalog of another workspace machine. Explicit workspace or machine
selectors now use a one-shot cloud-backed read, while the selector-free command preserves the local
daemon behavior. The remote result is synchronized before use and filtered through the same
requester access checks as Session creation; the local platform rejects this path before cloud I/O.

## Decision

An explicit `--workspace` or `--machine` selects the remote catalog path. This includes naming the
machine associated with the current CLI login: selector intent, rather than machine-id equality,
determines the transport. With no selector, existing local IPC behavior remains unchanged.

The remote path resolves an accessible workspace, synchronizes its machine metadata, and filters
machines with the non-delegated `canRequestMachineForCliToken` capability used by CLI Session
creation. Machine selection accepts an exact id or a unique name among authorized machines. It then
awaits synchronization of the exact target Machine Flock document, merges its project rows over
legacy Machine metadata, and applies a project-scoped access check before returning any name or
path. A metadata, Flock, or authorization transport failure fails the command instead of presenting
a stale or unfiltered catalog.

Open-source local platform mode rejects remote selectors before authentication or workspace
transport setup. It continues to support the selector-free daemon-backed list.

## Scope and verification

This implements the project-catalog behavior requested by
[issue #582](https://github.com/LodyAI/Lody/issues/582). It does not change project registration,
deletion, Session creation, or remote project mutation.

Synthetic behavior coverage models a daemon-free client and a distinct target machine. It verifies
that synchronized Flock rows override legacy rows, denied project paths never enter the response,
explicit selectors choose the remote path, exact ids and unique names resolve deterministically,
and a rejected Flock sync fails before cached projects are read. The test uses injected transports;
it is not a live cloud or device test.
