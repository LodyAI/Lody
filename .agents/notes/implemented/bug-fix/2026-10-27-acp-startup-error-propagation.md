# Preserve diagnostics when ACP startup disconnects

Status: implemented
Translation: current

[中文](2026-10-27-acp-startup-error-propagation.zh.md)

## Abstract

A launcher can report a concrete error on stderr and close stdout before its exit error reaches the caller. The ACP connection failure then hides those diagnostics behind a generic disconnect notice. Startup now retains the observed process failure or attaches its buffered stderr to a plain transport-close error. Typed startup failures reach the existing start-step notice; protocol errors, cancellation, cleanup and retry policy remain unchanged.

## Decision

The startup monitor owns the existing bounded stderr tail and observed process failure. Both Session startup and the standalone runner resolve plain transport errors before disposing it. No extra wait or retry is added: stderr arriving after settlement remains unavailable. Typed startup failures bypass text-based disconnect classification, even if their diagnostics quote transport text. Structured ACP errors and cancellation retain identity.

This complements [start-step attribution](2026-10-16-session-start-failure-attribution.md). Callers still own process termination and cancellation. The fix stays within existing Promise orchestration; migrating the surrounding lifecycle would extend beyond this error-projection unit. Existing command/stderr failure messages are reused without changing wire formats.

## Verification and limits

Deterministic monitor tests exercise both race orders, npm diagnostics, original causes, cancellation/protocol identity and empty-stderr fallback. Classification tests keep typed startup errors out of generic disconnect handling. The owning execution suite adds a synthetic npm startup failure and checks the persisted notice. No captured conversation or machine data is used. Full workspace checks require its missing dependencies; no desktop/provider acceptance is claimed.
