# Reporting client diagnostics

Status: implemented
Translation: current

[中文](2026-10-17-client-report-diagnostics.zh.md)

## Abstract

Bug reports need to identify the reporting browser or native app separately from
the selected machine. The client now attaches an explicit environment snapshot and
a bounded tail of the existing durable renderer log, even without a machine or with
an older daemon. The existing logger remains the sole owner of error capture,
redaction and persistence; no second console interceptor or storage ring is added.
The new attachment requires a supporting hosted implementation and stays behind
existing cloud operation guards.

## Decision and responsibilities

`client-build-info.ts` owns build constants. `client-diagnostics.ts` adds an explicit
allowlist of OS, native version/manufacturer/model, desktop runtime, browser, locale
and display fields. It never traverses window/platform objects or includes install
IDs, hostnames or home paths. UA-derived versions remain separate from native OS
versions: browser hints may hide them and manufacturer names do not establish a
vendor ROM version.

The existing [client log](2026-10-16-client-bug-report-log.md) owns crashes, React
stacks, reload/recovery events, 48-hour/2-MiB retention and redaction. Host entries
install it early using its idempotent API. The separate attachment reads at most
24,000 characters from its tail and waits at most one second for log storage;
unavailable storage does not prevent sending the environment. Existing negotiated
machine `clientLog` upload is preserved. No arbitrary console history is collected.

The dialog creates the existing report, immediately shows its ID and allows
dismissal, then uploads the client snapshot using the app session. Attachment
progress and failure remain separate from report success. An explicit retry uses
the same report ID and snapshot without creating another report. Uploads have a
15-second deadline covering headers and response-body reads; cancellation also
settles adapters that ignore abort. Dismissal, account/workspace change and unmount
cancel and retire the attempt so late responses cannot replace a newer report.
Closing or reloading can leave an incomplete attachment. The hosted implementation must bind
the reporter/workspace, enforce bounds/deletion fences, seal once and clean up
losing uploads. This avoids changing strict older daemon RPC contracts.

## Evidence and limits

Tests exercise native field allowlisting, browser fallbacks, bounded durable-log
reuse, failed/hung storage and attachment-only retry. Real dialog/API tests cover
a created report remaining copyable and dismissible through Close, cross, Escape
and backdrop while the attachment hangs, plus cancellation, late responses,
account loss and unmount. Fake-clock API tests cover hung headers/body and deadline
cleanup. The dismissal regression fails against the previous PR head. Existing logger tests own
capture, persistence and redaction. Hosted validation belongs to the consuming
composition. Native packaging, real-device manufacturer/OS fields and production
uploads remain separate acceptance gates; local tests do not prove them.
