# Retain failed Session materialization evidence

Status: implemented
Translation: current

[中文](2026-09-27-session-create-materialization-failure.zh.md)

## Abstract

An accepted cross-machine Session create can remain active while its target input is not durable. The initial MCP writer and the lease worker previously discarded materialization errors, so a later deadline reported only a generic timeout. The last failed phase and error message now survive in the machine-local Operation store and accompany the deadline result. This makes a failed create actionable, but does not establish which phase failed in the reported incident because its raw daemon logs are unavailable.

## Decision

Acceptance still freezes target identifiers before fallible remote work. A failed initial write or recovery attempt remains retryable: a transport error can be ambiguous, and a later attempt may find that the fixed turn already exists. Each claimant records a bounded diagnostic only while it owns the materialization claim. An old writer cannot overwrite the current claimant's evidence. Successful durable materialization removes the diagnostic. At the deadline, `TARGET_TIMEOUT` retains its existing code and adds the latest recorded phase and error message when present.

The alternative of immediately failing an accepted Operation on its first write error would discard valid recovery opportunities after a transient disconnect. Process-only logging was insufficient because the worker may restart before the deadline.

## Evidence and limits

The report in [Lody #956](https://github.com/LodyAI/Lody/issues/956) records four accepted cross-machine creates without a durable target Session, while a target-local create worked. Its logs are explicitly reconstructed rather than raw daemon output. Code inspection found error-discarding catches in the MCP create path and recovery coordinator. The store and coordinator regression suites cover claimant fencing, clearing after success, and the deadline result. A live cross-machine macOS run remains unverified.
