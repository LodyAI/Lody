# Keep global Streams diagnostics process-scoped

Status: implemented
Translation: current
PR: [#1520](https://github.com/LodyAI/Lody/pull/1520)

[中文](2026-10-12-streams-diagnostic-log-scope.zh.md)

## Abstract

The CLI installed one process-wide console/fetch interceptor but replaced its
logger whenever another workspace attached Streams. Errors from an earlier
workspace were therefore attributed to the last workspace. The interceptor now
resolves the existing root logger when emitting each record, preserving the
configured sink without inventing workspace identity. This removes misleading
tags; it does not add missing document IDs or repair synchronization failures.

## Evidence and decision

[Issue #1469](https://github.com/LodyAI/Lody/issues/1469) reports this mismatch in
multi-workspace daemon logs. At `5f13f917`, the owning document-manager test creates
and attaches synthetic A/B managers through the production path, then calls the
real intercepted `console.error`. Before the fix, the same A stream URL reaches
A's logger before B attaches and B's logger afterwards. HTTP diagnostics also
reach B. The new assertion fails on that source and passes with the sink change.

Remove the mutable workspace sink and its installation argument. Call `getLogger()`
at emission time so later root reconfiguration retains its configured file/hybrid
transport. Do not construct a separate logger or cache an early console-only root.
The existing debug level, prefixes, URL sanitization, one-time wrapper guard,
unrelated console forwarding, and fetch results/errors remain unchanged.

Keeping the first workspace's logger would merely choose a different wrong owner.
Inferring identity from occasional URLs cannot identify SDK errors with no URL or
document ID. Complete structured attribution needs a separate SDK-aware change;
this patch only references the issue and leaves it open. Existing workspace-bound
transport diagnostic callbacks keep their genuine context.

The Effect feature/fix assessment stays bounded: this is synchronous log-sink
selection inside existing interceptors. It changes no lifetime, retry, ownership,
or transport protocol, so no native lifecycle migration belongs in this patch.

## Verification and limits

- The unmodified implementation fails the A/B regression with captured output
  showing `workspace-a` followed by `workspace-b` for the same A event.
- The document-manager, logger, log-format and log-sanitization suites pass 46 tests after the fix.
  Coverage includes root rebinding, duplicate installation, both console prefixes,
  URL credentials/query redaction, unchanged fetch response/body/error, and
  unrelated console output.
- Repositories, token responses, presence transport, and machine-monitor attachment
  are synthetic. The actual manager attachment and diagnostic wrappers execute;
  no live cloud account, production log, or desktop UI was used.
